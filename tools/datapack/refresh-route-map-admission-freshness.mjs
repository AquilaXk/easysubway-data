#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { addCadence } from "./freshness-policy.mjs";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";
import { ROUTE_MAP_REVERIFICATION_CADENCE } from "./lib/route-map-admission-freshness.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const inventoryPaths = [
  "tools/datapack/source-inventory.json",
  "apps/mobile/assets/datapacks/source-inventory.json",
];

export function withRouteMapAdmissionFreshness(inventory) {
  const next = structuredClone(inventory);
  for (const source of next.sources ?? []) {
    const evidence = source.routeMapAdmissionEvidence;
    if (!evidence) continue;
    const capturedAt = requiredUtcInstant(evidence.capturedAt, `${source.id} route-map capturedAt`);
    evidence.freshUntil = new Date(addCadence(capturedAt, ROUTE_MAP_REVERIFICATION_CADENCE)).toISOString();
  }
  return next;
}

export function assertInventoryMirrorByteParity(inventories) {
  if (inventories.some(({ bytes }) => !bytes.equals(inventories[0].bytes))) {
    throw new Error("source inventory mirrors must be byte-identical before refresh");
  }
}

export async function replaceFileAtomically(targetPath, bytes) {
  const replacement = await stageFileReplacement(targetPath, bytes);
  try {
    await replacement.commit();
  } finally {
    await replacement.cleanup();
  }
}

async function stageFileReplacement(targetPath, bytes) {
  const directory = path.dirname(targetPath);
  await mkdir(directory, { recursive: true });
  const mode = (await stat(targetPath)).mode & 0o777;
  const temporaryPath = path.join(directory, `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
  const temporaryFile = await open(temporaryPath, "wx", mode);
  try {
    await temporaryFile.writeFile(bytes);
    await temporaryFile.sync();
    await temporaryFile.close();
  } catch (error) {
    await temporaryFile.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return {
    targetPath,
    commit: () => rename(temporaryPath, targetPath),
    cleanup: () => rm(temporaryPath, { force: true }),
  };
}

export async function replaceInventoryMirrors(
  targets,
  bytes,
  { stageReplacement = stageFileReplacement, restore = replaceFileAtomically } = {},
) {
  const stageResults = await Promise.allSettled(
    targets.map(({ targetPath }) => stageReplacement(targetPath, bytes)),
  );
  const staged = stageResults.filter(({ status }) => status === "fulfilled").map(({ value }) => value);
  const stageFailure = stageResults.find(({ status }) => status === "rejected");
  if (stageFailure) {
    await Promise.allSettled(staged.map(({ cleanup }) => cleanup()));
    throw stageFailure.reason;
  }

  const committed = [];
  try {
    for (const replacement of staged) {
      await replacement.commit();
      committed.push(replacement.targetPath);
    }
  } catch (error) {
    const originals = new Map(targets.map(({ targetPath, originalBytes }) => [targetPath, originalBytes]));
    const rollbackResults = await Promise.allSettled(
      committed.reverse().map((targetPath) => restore(targetPath, originals.get(targetPath))),
    );
    const rollbackFailures = rollbackResults
      .filter(({ status }) => status === "rejected")
      .map(({ reason }) => reason);
    if (rollbackFailures.length > 0) {
      throw new AggregateError([error, ...rollbackFailures], "source inventory mirror rollback failed");
    }
    throw error;
  } finally {
    await Promise.allSettled(staged.map(({ cleanup }) => cleanup()));
  }
}

async function main() {
  const inventories = await Promise.all(inventoryPaths.map(async (relativePath) => ({
    relativePath,
    bytes: await readFile(path.join(root, relativePath)),
  })));
  assertInventoryMirrorByteParity(inventories);
  const canonical = withRouteMapAdmissionFreshness(JSON.parse(inventories[0].bytes.toString("utf8")));
  const bytes = `${JSON.stringify(canonical, null, 2)}\n`;
  await replaceInventoryMirrors(inventories.map(({ relativePath, bytes: originalBytes }) => ({
    targetPath: path.join(root, relativePath),
    originalBytes,
  })), bytes);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
