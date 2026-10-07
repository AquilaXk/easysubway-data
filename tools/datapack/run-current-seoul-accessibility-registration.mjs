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
    "tools/datapack/inputs/capital-pilot-production-source-input.json",
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
    readObservationManifest: readCollectedObservationManifest,
    publish: publishSeoulAccessibilityRawArtifact,
    register: registerCurrentSeoulAccessibilitySnapshot,
    ...deps,
  };
}

// publish 단계가 collect 단계가 남긴 observation을 찾는다. manifest의 snapshotId와 파일 이름이 맞아야 한다.
async function readCollectedObservationManifest(outputRoot) {
  const manifest = JSON.parse(await readFile(path.join(outputRoot, "observation.json"), "utf8"));
  if (manifest?.artifactKind !== "seoul-accessibility-observation" || manifest.sourceId !== SOURCE_ID
    || typeof manifest.snapshotId !== "string" || manifest.snapshotFile !== `${manifest.snapshotId}.json`) throw new Error("current Seoul accessibility collected observation is invalid");
  return manifest;
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

// #995: 수집("collect")과 OCI 게시·등록("publish")을 workflow step으로 나눌 수 있게 두 단계로 실행한다. "all"은 한 번에 둘 다 한다.
// 게시 step이 시작됐는지가 PR 없는 claim 정리의 판정 근거라서(claim-orphans.mjs) 둘은 서로 다른 step이어야 한다.
const PHASES = Object.freeze(["all", "collect", "publish"]);

export async function runCurrentSeoulAccessibilityRegistration({
  observationName,
  receiptPath,
  requestAttempts = 2,
  repositoryRoot = ROOT,
  env = process.env,
  deps = {},
  phase = "all",
} = {}) {
  if (!PHASES.includes(phase)) throw new Error("current Seoul accessibility registration phase is invalid");
  const operations = registrationOperations(deps);
  const root = path.resolve(repositoryRoot); const name = requiredObservationName(observationName); const externalReceipt = await requiredExternalReceipt(root, receiptPath);
  const serviceKey = normalizeDataGoKrServiceKey(env?.DATA_GO_KR_SERVICE_KEY);
  let snapshotId; let outputRoot;
  if (phase === "publish") {
    outputRoot = await operations.observationRoot(name);
    snapshotId = (await operations.readObservationManifest(outputRoot)).snapshotId;
  } else {
    const previousSnapshot = await readCurrentSeoulSnapshot(operations, root);
    if (!Number.isSafeInteger(requestAttempts) || ![1, 2].includes(requestAttempts)) throw new Error("Seoul accessibility request attempts are invalid");
    const observation = await operations.collect({ serviceKey, previousSnapshot, requestAttempts });
    if (observation?.snapshot?.sourceId !== SOURCE_ID || typeof observation.snapshot.snapshotId !== "string") throw new Error("current Seoul accessibility observation is invalid");
    outputRoot = await operations.observationRoot(name);
    await operations.writeObservation({ outputRoot, observation });
    snapshotId = observation.snapshot.snapshotId;
    if (phase === "collect") return { status: "COLLECTED", snapshotId };
  }
  const snapshotPath = path.join(outputRoot, `${snapshotId}.json`);
  await operations.publish({ observationRoot: outputRoot, receiptPath: externalReceipt, repositoryRoot: root, env });
  const registration = await operations.register({ repositoryRoot: root, snapshotPath, receiptPath: externalReceipt });
  if (JSON.stringify(registration?.outputs) !== JSON.stringify(expectedOutputs(snapshotId))) throw new Error("current Seoul accessibility registration output allowlist mismatch");
  return { status: "PASS", snapshotId, outputs: registration.outputs };
}

async function main(argv) {
  const usage = "usage: --observation-name <safe> --receipt <absolute external path> [--request-attempts 1] [--phase collect|publish]";
  if (argv[0] !== "--observation-name" || argv[2] !== "--receipt") throw new Error(usage);
  const options = { observationName: argv[1], receiptPath: argv[3] };
  let rest = argv.slice(4);
  if (rest[0] === "--request-attempts" && rest[1] === "1") { options.requestAttempts = 1; rest = rest.slice(2); }
  if (rest[0] === "--phase" && ["collect", "publish"].includes(rest[1])) { options.phase = rest[1]; rest = rest.slice(2); }
  if (rest.length !== 0) throw new Error(usage);
  const result = await runCurrentSeoulAccessibilityRegistration(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (isMainModule(import.meta.url)) {
  try { await main(process.argv.slice(2)); } catch (error) { console.error(error instanceof Error ? error.message : "current Seoul accessibility registration failed"); process.exitCode = 1; }
}
