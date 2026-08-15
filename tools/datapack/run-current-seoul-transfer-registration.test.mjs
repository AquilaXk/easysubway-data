import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { finalizeCurrentSeoulTransferRegistration, parseArgs, prepareCurrentSeoulTransferRegistration, validateFinalStateStatus } from "./run-current-seoul-transfer-registration.mjs";

const SHA = "a".repeat(40);
const NOW = new Date("2026-08-15T12:01:00.000Z");
const observation = {
  manifest: { sourceId: "seoul-metro-transfer-distance-duration", capturedAt: "2026-08-15T12:00:00.000Z", rawSha256: hash(Buffer.from("raw")), rowCount: 145 },
  manifestBytes: Buffer.from("manifest"), observationBytes: Buffer.from("observation"), rawBytes: Buffer.from("raw"),
};
const artifacts = { metricsBytes: Buffer.from("metrics"), applicabilityBytes: Buffer.from("applicability") };
const exactMain = async () => ({ head: SHA, originMain: SHA });

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "transfer-runner-"));
  const repositoryRoot = path.join(base, "repository"); const operationRoot = path.join(base, "operation"); const observationDirectory = path.join(base, "observation");
  await mkdir(repositoryRoot, { mode: 0o700 });
  await mkdir(observationDirectory, { mode: 0o700 });
  t.after(() => rm(base, { recursive: true, force: true }));
  return { repositoryRoot, operationRoot, observationDirectory };
}

const dependencies = { assertExactMain: exactMain, assertFinalStateMain: exactMain, readObservation: async () => observation, readArtifacts: async (root) => ({ ...artifacts, paths: { metrics: path.join(root, "metrics.json"), applicability: path.join(root, "applicability.json") } }) };

test("strictly parses prepare/finalize command boundaries", () => {
  assert.deepEqual(parseArgs(["prepare", "--operation-root", "/private/op", "--observation-directory", "/private/observation", "--expected-main-sha", SHA]), { phase: "prepare", operationRoot: "/private/op", observationDirectory: "/private/observation", expectedMainSha: SHA });
  assert.deepEqual(parseArgs(["finalize", "--operation-root", "/private/op"]), { phase: "finalize", operationRoot: "/private/op" });
  assert.throws(() => parseArgs(["--phase", "finalize", "--operation-root", "/private/op"]), /arguments/);
});

test("prepare seals the exact observation/artifact binding in a private operation root", async (t) => {
  const value = await fixture(t);
  await prepareCurrentSeoulTransferRegistration({ ...value, expectedMainSha: SHA, ...dependencies, now: new Date("2026-08-16T00:00:00.000Z") });
  const journal = JSON.parse(await readFile(path.join(value.operationRoot, "journal.json"), "utf8"));
  assert.equal(journal.phase, "PREPARED"); assert.equal(journal.expectedMainSha, SHA); assert.equal(journal.preparedAt, "2026-08-16T00:00:00.000Z");
  assert.equal(journal.observation.files.length, 3); assert.equal(journal.metrics.sha256.length, 64);
  assert.equal((await (await import("node:fs/promises")).stat(value.operationRoot)).mode & 0o777, 0o700);
});

test("finalize publishes then registers exactly once and records terminal failures without retry", async (t) => {
  const value = await fixture(t); await prepareCurrentSeoulTransferRegistration({ ...value, expectedMainSha: SHA, ...dependencies, now: NOW });
  const calls = [];
  await finalizeCurrentSeoulTransferRegistration({ ...value, ...dependencies, now: new Date("2026-08-15T12:01:00.000Z"), publish: async () => { calls.push("publish"); await writeFile(path.join(value.operationRoot, "receipt.json"), `${JSON.stringify(receipt())}\n`, { mode: 0o600 }); return receipt(); }, register: async ({ approvedAt }) => { calls.push(`register:${approvedAt}`); return writeTargets(value.repositoryRoot); } });
  assert.deepEqual(calls, ["publish", "register:2026-08-15T12:01:00.000Z"]);
  assert.equal(JSON.parse(await readFile(path.join(value.operationRoot, "journal.json"), "utf8")).phase, "FINALIZED");
  await finalizeCurrentSeoulTransferRegistration({ ...value, ...dependencies, assertFinalStateMain: exactMain });
  await writeFile(path.join(value.repositoryRoot, "tools/datapack/source-inventory.json"), "drift");
  await assert.rejects(finalizeCurrentSeoulTransferRegistration({ ...value, ...dependencies, assertFinalStateMain: exactMain }), /postcondition mismatch/);
  const failed = await fixture(t); await prepareCurrentSeoulTransferRegistration({ ...failed, expectedMainSha: SHA, ...dependencies, now: NOW }); let publishCalls = 0;
  await assert.rejects(finalizeCurrentSeoulTransferRegistration({ ...failed, ...dependencies, publish: async () => { publishCalls += 1; throw new Error("OCI"); } }), /OCI/);
  assert.equal(JSON.parse(await readFile(path.join(failed.operationRoot, "journal.json"), "utf8")).phase, "PUBLISH_FAILED");
  await assert.rejects(finalizeCurrentSeoulTransferRegistration({ ...failed, ...dependencies, publish: async () => { publishCalls += 1; } }), /terminal/);
  assert.equal(publishCalls, 1);
});

test("an exact existing receipt skips publish, while REGISTERING residue never replays", async (t) => {
  const value = await fixture(t); await prepareCurrentSeoulTransferRegistration({ ...value, expectedMainSha: SHA, ...dependencies, now: NOW });
  await writeFile(path.join(value.operationRoot, "receipt.json"), `${JSON.stringify(receipt())}\n`, { mode: 0o600 });
  let publishCalls = 0; let registerCalls = 0;
  await finalizeCurrentSeoulTransferRegistration({ ...value, ...dependencies, publish: async () => { publishCalls += 1; }, register: async () => { registerCalls += 1; return writeTargets(value.repositoryRoot); } });
  assert.equal(publishCalls, 0); assert.equal(registerCalls, 1);
  const crash = await fixture(t); await prepareCurrentSeoulTransferRegistration({ ...crash, expectedMainSha: SHA, ...dependencies, now: NOW });
  await setPhase(crash.operationRoot, "REGISTERING");
  await assert.rejects(finalizeCurrentSeoulTransferRegistration({ ...crash, ...dependencies, register: async () => { throw new Error("must not replay"); } }), /manual recovery/);
});

test("resume and terminal states preserve one-shot publication and registration", async (t) => {
  const publishing = await fixture(t); await prepareCurrentSeoulTransferRegistration({ ...publishing, expectedMainSha: SHA, ...dependencies, now: NOW }); await writeFile(path.join(publishing.operationRoot, "receipt.json"), `${JSON.stringify(receipt())}\n`, { mode: 0o600 }); await setPhase(publishing.operationRoot, "PUBLISHING"); let publishCalls = 0; let registerCalls = 0;
  await finalizeCurrentSeoulTransferRegistration({ ...publishing, ...dependencies, publish: async () => { publishCalls += 1; }, register: async () => { registerCalls += 1; return writeTargets(publishing.repositoryRoot); } }); assert.deepEqual([publishCalls, registerCalls], [0, 1]);
  const interrupted = await fixture(t); await prepareCurrentSeoulTransferRegistration({ ...interrupted, expectedMainSha: SHA, ...dependencies, now: NOW }); await setPhase(interrupted.operationRoot, "PUBLISHING");
  await assert.rejects(finalizeCurrentSeoulTransferRegistration({ ...interrupted, ...dependencies, publish: async () => { publishCalls += 1; }, register: async () => { registerCalls += 1; } }), /interrupted/); assert.equal(JSON.parse(await readFile(path.join(interrupted.operationRoot, "journal.json"), "utf8")).phase, "PUBLISH_FAILED");
  const published = await fixture(t); await prepareCurrentSeoulTransferRegistration({ ...published, expectedMainSha: SHA, ...dependencies, now: NOW }); await writeFile(path.join(published.operationRoot, "receipt.json"), `${JSON.stringify(receipt())}\n`, { mode: 0o600 }); await setPhase(published.operationRoot, "PUBLISHED");
  await finalizeCurrentSeoulTransferRegistration({ ...published, ...dependencies, publish: async () => { publishCalls += 1; }, register: async () => { registerCalls += 1; return writeTargets(published.repositoryRoot); } }); assert.deepEqual([publishCalls, registerCalls], [0, 2]);
  const failure = await fixture(t); await prepareCurrentSeoulTransferRegistration({ ...failure, expectedMainSha: SHA, ...dependencies, now: NOW }); await writeFile(path.join(failure.operationRoot, "receipt.json"), `${JSON.stringify(receipt())}\n`, { mode: 0o600 }); let failures = 0;
  await assert.rejects(finalizeCurrentSeoulTransferRegistration({ ...failure, ...dependencies, register: async () => { failures += 1; throw new Error("register"); } }), /register/); await assert.rejects(finalizeCurrentSeoulTransferRegistration({ ...failure, ...dependencies, register: async () => { failures += 1; } }), /terminal/); assert.equal(failures, 1);
});

test("operation lock excludes side effects and final porcelain has an exact partition", async (t) => {
  const value = await fixture(t); await prepareCurrentSeoulTransferRegistration({ ...value, expectedMainSha: SHA, ...dependencies, now: NOW }); await mkdir(path.join(value.operationRoot, ".operation-lock")); let calls = 0;
  await assert.rejects(finalizeCurrentSeoulTransferRegistration({ ...value, ...dependencies, publish: async () => { calls += 1; } }), /already in progress/); assert.equal(calls, 0);
  const targets = (await writeTargets(value.repositoryRoot)).targets.map((relativePath) => ({ relativePath, byteLength: 1, sha256: "a".repeat(64) }));
  assert.equal(validateFinalStateStatus(` M tools/datapack/source-inventory.json\n M release/product-gates/production-datapack-scope.json\n M tools/datapack/release/source-snapshots.json\n M tools/datapack/release/candidate-build-spec.json\n?? tools/datapack/sources/seoul-metro-transfer-distance-duration-20260815T120000000Z.json\n`, targets), true);
  assert.equal(validateFinalStateStatus(` M tools/datapack/source-inventory.json\n`, targets), false);
});

function receipt() { return { schemaVersion: 1, artifactKind: "seoul-transfer-raw-object-receipt", sourceId: observation.manifest.sourceId, snapshotId: "seoul-metro-transfer-distance-duration-20260815T120000000Z", snapshotRawSha256: observation.manifest.rawSha256, capturedAt: observation.manifest.capturedAt, manifestSha256: hash(observation.manifestBytes), observationSha256: hash(observation.observationBytes), rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/source-raw/seoul-metro-transfer-distance-duration/20260815/${hash(observation.rawBytes)}.json`, rawObjectSha256: hash(observation.rawBytes), ociNamespace: "axvym6vk8g7i", bucket: "easysubway-datapacks", objectKey: `source-raw/seoul-metro-transfer-distance-duration/20260815/${hash(observation.rawBytes)}.json`, capturedDate: "20260815", byteSize: observation.rawBytes.length, storedAt: "2026-08-15T12:01:00.000Z", rawRetentionExpiresAt: "2026-11-13T12:00:00.000Z" }; }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }

async function writeTargets(root) {
  const targets = ["tools/datapack/source-inventory.json", "release/product-gates/production-datapack-scope.json", "tools/datapack/release/source-snapshots.json", "tools/datapack/release/candidate-build-spec.json", "tools/datapack/sources/seoul-metro-transfer-distance-duration-20260815T120000000Z.json"];
  await Promise.all(targets.map(async (relative) => { const target = path.join(root, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, relative); }));
  return { targets };
}
async function setPhase(operationRoot, phase) { const journalPath = path.join(operationRoot, "journal.json"); const journal = JSON.parse(await readFile(journalPath, "utf8")); journal.phase = phase; if (["PUBLISHING", "PUBLISHED", "REGISTERING"].includes(phase)) journal.publishAt = NOW.toISOString(); if (phase === "REGISTERING") journal.approvedAt = NOW.toISOString(); await writeFile(journalPath, `${JSON.stringify(journal)}\n`); }
