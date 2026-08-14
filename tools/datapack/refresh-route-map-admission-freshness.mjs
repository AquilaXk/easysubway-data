#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { evaluateFreshnessExtension } from "./freshness-policy.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const policyPath = "release/product-gates/datapack-freshness-sla.json";
const inventoryPaths = [
  "tools/datapack/source-inventory.json",
  "apps/mobile/assets/datapacks/source-inventory.json",
];

export function applyRouteMapFreshnessExtension(inventory, { input, policy }) {
  const next = structuredClone(inventory);
  const result = evaluateFreshnessExtension({ input, policy });
  if (result.decision !== "EXTENDED") {
    return { inventory: next, result, changed: false };
  }

  const matchingSources = (next.sources ?? []).filter(({ id }) => id === result.sourceId);
  if (matchingSources.length !== 1) {
    throw new Error("freshness extension requires exactly one route-map source");
  }
  const evidence = matchingSources[0].routeMapAdmissionEvidence;
  if (!evidence
    || evidence.snapshotId !== input.sourceIdentity.snapshotId
    || evidence.snapshotSha256 !== input.sourceIdentity.snapshotSha256
    || evidence.rawSha256 !== input.sourceIdentity.rawEvidenceSha256
    || evidence.freshUntil !== input.sourceIdentity.currentFreshUntil) {
    throw new Error("route-map admission identity mismatch");
  }
  evidence.freshUntil = result.extendedFreshUntil;
  evidence.freshnessExtension = result;
  return { inventory: next, result, changed: true };
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
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--input" || args[1].length === 0) {
    throw new Error("usage: refresh-route-map-admission-freshness.mjs --input <extension-input.json>");
  }
  const inventories = await Promise.all(inventoryPaths.map(async (relativePath) => ({
    relativePath,
    bytes: await readFile(path.join(root, relativePath)),
  })));
  assertInventoryMirrorByteParity(inventories);
  const [input, policy] = await Promise.all([
    readFile(path.resolve(process.cwd(), args[1]), "utf8").then(JSON.parse),
    readFile(path.join(root, policyPath), "utf8").then(JSON.parse),
  ]);
  const update = applyRouteMapFreshnessExtension(
    JSON.parse(inventories[0].bytes.toString("utf8")),
    { input, policy },
  );
  if (!update.changed) {
    throw new Error(`freshness extension rejected: ${update.result.decision}/${update.result.reasonCode}`);
  }
  const bytes = `${JSON.stringify(update.inventory, null, 2)}\n`;
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
