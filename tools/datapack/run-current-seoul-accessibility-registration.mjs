#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../lib/is-main-module.mjs";
import {
  collectSeoulAccessibilityObservation,
  seoulObservationOutputRoot,
  validateSeoulAccessibilitySnapshotIdentity,
  writeSeoulAccessibilityObservation,
} from "./collect-seoul-accessibility-evidence.mjs";
import { publishSeoulAccessibilityRawArtifact } from "./publish-seoul-accessibility-raw.mjs";
import { registerCurrentSeoulAccessibilitySnapshot } from "./register-current-seoul-accessibility-snapshot.mjs";
import { normalizeDataGoKrServiceKey } from "./lib/provider-call-integrity.mjs";
import { validateLineage } from "./source-snapshot-policy.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SOURCE_ID = "seoul-metro-accessibility";
const LEDGER = "tools/datapack/release/source-snapshots.json";
const OBSERVATION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const sha = (value) => createHash("sha256").update(value).digest("hex");

function within(root, target) { return target === root || target.startsWith(`${root}${path.sep}`); }
async function requiredExternalReceipt(repositoryRoot, receiptPath) {
  if (typeof receiptPath !== "string" || !path.isAbsolute(receiptPath)) throw new Error("Seoul OCI receipt path must be absolute and external");
  const resolved = path.resolve(receiptPath); const parent = path.dirname(resolved); let realRepository; let realParent;
  try {
    for (let current = path.parse(parent).root; current !== parent; current = path.join(current, path.relative(current, parent).split(path.sep)[0])) {
      const stat = await lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe");
    }
    const parentStat = await lstat(parent); if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("unsafe");
    [realRepository, realParent] = await Promise.all([realpath(repositoryRoot), realpath(parent)]);
    if (within(realRepository, realParent)) throw new Error("unsafe");
    const target = await lstat(resolved); if (!target.isFile() || target.isSymbolicLink() || within(realRepository, await realpath(resolved))) throw new Error("unsafe");
  } catch (error) {
    if (error?.code !== "ENOENT" || !realParent) {
      if (error?.code !== "ENOENT") throw new Error("Seoul OCI receipt path must be absolute and external", { cause: error });
    }
  }
  if (!realParent) {
    try { [realRepository, realParent] = await Promise.all([realpath(repositoryRoot), realpath(parent)]); } catch (error) { throw new Error("Seoul OCI receipt path must be absolute and external", { cause: error }); }
    if (within(realRepository, realParent)) throw new Error("Seoul OCI receipt path must be absolute and external");
  }
  return resolved;
}
function requiredObservationName(observationName) {
  if (typeof observationName !== "string" || !OBSERVATION_NAME.test(observationName)) throw new Error("Seoul observation directory name is invalid");
  return observationName;
}
function currentHeadSourcePath(repositoryRoot, head) {
  if (typeof head !== "string" || head.length === 0) throw new Error("current Seoul accessibility source head is missing");
  const sourceRoot = path.resolve(repositoryRoot, "tools/datapack/sources"); const target = path.resolve(sourceRoot, `${head}.json`);
  if (!within(sourceRoot, target)) throw new Error("current Seoul accessibility source head is invalid");
  return target;
}
function expectedOutputs(snapshotId) {
  return [
    `tools/datapack/sources/${snapshotId}.json`, "tools/datapack/source-inventory.json", "tools/datapack/release/source-snapshots.json",
    "tools/datapack/inputs/capital-pilot-production-source-input.json", "tools/datapack/release/candidate-build-spec.json",
    "tools/datapack/release/release-request.json", "tools/datapack/release/hash-evidence.json",
  ];
}

function registrationOperations(deps) {
  return {
    readFile,
    validateLineage,
    validateSnapshotIdentity: validateSeoulAccessibilitySnapshotIdentity,
    collect: collectSeoulAccessibilityObservation,
    observationRoot: seoulObservationOutputRoot,
    writeObservation: writeSeoulAccessibilityObservation,
    publish: publishSeoulAccessibilityRawArtifact,
    register: registerCurrentSeoulAccessibilitySnapshot,
    ...deps,
  };
}

async function readCurrentSeoulSnapshot(operations, root) {
  const ledger = JSON.parse(await operations.readFile(path.join(root, LEDGER), "utf8"));
  const head = operations.validateLineage(ledger).headsBySource?.[SOURCE_ID];
  const selected = ledger.filter((snapshot) => snapshot?.sourceId === SOURCE_ID && snapshot.snapshotId === head);
  if (selected.length !== 1 || !/^[a-f0-9]{64}$/u.test(selected[0].rawReceipt?.snapshotFileSha256 ?? "")) throw new Error("current Seoul accessibility source head is invalid");
  const previousBytes = await operations.readFile(currentHeadSourcePath(root, head));
  const previousSnapshot = operations.validateSnapshotIdentity(JSON.parse(previousBytes));
  if (previousSnapshot?.snapshotId !== head || previousSnapshot.sourceId !== SOURCE_ID) throw new Error("current Seoul accessibility source head is invalid");
  if (selected[0].rawReceipt.snapshotFileSha256 !== sha(previousBytes)) throw new Error("current Seoul accessibility snapshot bytes mismatch");
  return previousSnapshot;
}

export async function runCurrentSeoulAccessibilityRegistration({
  observationName,
  receiptPath,
  requestAttempts = 2,
  repositoryRoot = ROOT,
  env = process.env,
  deps = {},
} = {}) {
  const operations = registrationOperations(deps);
  const root = path.resolve(repositoryRoot); const name = requiredObservationName(observationName); const externalReceipt = await requiredExternalReceipt(root, receiptPath);
  const serviceKey = normalizeDataGoKrServiceKey(env?.DATA_GO_KR_SERVICE_KEY);
  const previousSnapshot = await readCurrentSeoulSnapshot(operations, root);
  if (!Number.isSafeInteger(requestAttempts) || ![1, 2].includes(requestAttempts)) throw new Error("Seoul accessibility request attempts are invalid");
  const observation = await operations.collect({ serviceKey, previousSnapshot, requestAttempts });
  if (observation?.snapshot?.sourceId !== SOURCE_ID || typeof observation.snapshot.snapshotId !== "string") throw new Error("current Seoul accessibility observation is invalid");
  const outputRoot = await operations.observationRoot(name);
  await operations.writeObservation({ outputRoot, observation });
  const snapshotPath = path.join(outputRoot, `${observation.snapshot.snapshotId}.json`);
  await operations.publish({ observationRoot: outputRoot, receiptPath: externalReceipt, repositoryRoot: root, env });
  const registration = await operations.register({ repositoryRoot: root, snapshotPath, receiptPath: externalReceipt });
  if (JSON.stringify(registration?.outputs) !== JSON.stringify(expectedOutputs(observation.snapshot.snapshotId))) throw new Error("current Seoul accessibility registration output allowlist mismatch");
  return { status: "PASS", snapshotId: observation.snapshot.snapshotId, outputs: registration.outputs };
}

async function main(argv) {
  const scheduled = argv.length === 6 && argv[4] === "--request-attempts" && argv[5] === "1";
  if ((!scheduled && (argv.length !== 4 || argv[0] !== "--observation-name" || argv[2] !== "--receipt"))
    || (scheduled && (argv[0] !== "--observation-name" || argv[2] !== "--receipt"))) {
    throw new Error("usage: --observation-name <safe> --receipt <absolute external path> [--request-attempts 1]");
  }
  const result = await runCurrentSeoulAccessibilityRegistration({ observationName: argv[1], receiptPath: argv[3], ...(scheduled ? { requestAttempts: 1 } : {}) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (isMainModule(import.meta.url)) {
  try { await main(process.argv.slice(2)); } catch (error) { console.error(error instanceof Error ? error.message : "current Seoul accessibility registration failed"); process.exitCode = 1; }
}
