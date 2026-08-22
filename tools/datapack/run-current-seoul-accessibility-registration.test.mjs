import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCurrentSeoulAccessibilityRegistration } from "./run-current-seoul-accessibility-registration.mjs";

const SOURCE_ID = "seoul-metro-accessibility";
const HEAD = "seoul-metro-accessibility-20260813T213842955Z";
const SNAPSHOT_ID = "seoul-metro-accessibility-20260822T000000000Z";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const outputsFor = (snapshotId = SNAPSHOT_ID) => [
  `tools/datapack/sources/${snapshotId}.json`,
  "tools/datapack/source-inventory.json",
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/inputs/capital-pilot-production-source-input.json",
  "tools/datapack/release/candidate-build-spec.json",
  "tools/datapack/release/release-request.json",
  "tools/datapack/release/hash-evidence.json",
];

async function fixture(t, { receiptSha = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "seoul-accessibility-operation-"));
  const externalRoot = await mkdtemp(path.join(os.tmpdir(), "seoul-accessibility-receipt-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(externalRoot, { recursive: true, force: true })]));
  const sourceRoot = path.join(root, "tools/datapack/sources"); const previous = { snapshotId: HEAD, sourceId: SOURCE_ID }; const previousBytes = Buffer.from(JSON.stringify(previous));
  await mkdir(sourceRoot, { recursive: true }); await mkdir(path.join(root, "tools/datapack/release"), { recursive: true });
  await writeFile(path.join(root, "tools/datapack/release/source-snapshots.json"), JSON.stringify([{ snapshotId: HEAD, sourceId: SOURCE_ID, rawReceipt: { snapshotFileSha256: receiptSha ?? sha(previousBytes) } }]));
  await writeFile(path.join(sourceRoot, `${HEAD}.json`), previousBytes);
  return { root, receiptPath: path.join(await realpath(externalRoot), "receipt.json") };
}

function dependencies(events, { collectError = null, publishError = null, registrationOutputs = outputsFor() } = {}) {
  return {
    validateLineage(snapshots) { events.push(["validate-lineage", snapshots]); return { headsBySource: { [SOURCE_ID]: HEAD } }; },
    validateSnapshotIdentity(snapshot) { events.push(["validate-snapshot", snapshot]); return snapshot; },
    async collect({ serviceKey, previousSnapshot }) {
      events.push(["collect", serviceKey, previousSnapshot]); if (collectError) throw collectError;
      return { snapshot: { snapshotId: SNAPSHOT_ID, sourceId: SOURCE_ID }, rawArtifact: {} };
    },
    async observationRoot(name) { events.push(["root", name]); return "/private/tmp/easysubway-seoul-accessibility-operation"; },
    async writeObservation(value) { events.push(["write", value]); },
    async publish(value) { events.push(["publish", value]); if (publishError) throw publishError; return { artifactKind: "receipt" }; },
    async register(value) { events.push(["register", value]); return { outputs: registrationOutputs }; },
  };
}

function options(values, deps) {
  return { observationName: "operation-20260822", receiptPath: values.receiptPath, repositoryRoot: values.root, env: { DATA_GO_KR_SERVICE_KEY: "test-key", EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://object.example" }, deps };
}

test("runner validates the current head bytes and orders collector, publisher, and registrar", async (t) => {
  const values = await fixture(t); const events = []; const result = await runCurrentSeoulAccessibilityRegistration(options(values, dependencies(events)));
  assert.deepEqual(events.map(([name]) => name), ["validate-lineage", "validate-snapshot", "collect", "root", "write", "publish", "register"]);
  assert.deepEqual(events[2][2], { snapshotId: HEAD, sourceId: SOURCE_ID });
  assert.equal(events[5][1].receiptPath, values.receiptPath);
  assert.equal(events[6][1].snapshotPath, `/private/tmp/easysubway-seoul-accessibility-operation/${SNAPSHOT_ID}.json`);
  assert.deepEqual(result, { status: "PASS", snapshotId: SNAPSHOT_ID, outputs: outputsFor() });
});

test("malformed DATA_GO_KR_SERVICE_KEY stops every delegate before the current head read", async (t) => {
  const values = await fixture(t); let calls = 0;
  const deps = dependencies([], {});
  for (const key of ["validateLineage", "validateSnapshotIdentity", "collect", "observationRoot", "writeObservation", "publish", "register"]) {
    const original = deps[key];
    deps[key] = (...args) => { calls += 1; return original(...args); };
  }
  await assert.rejects(runCurrentSeoulAccessibilityRegistration({ ...options(values, deps), env: { DATA_GO_KR_SERVICE_KEY: "invalid%ZZ" } }), /DATA_GO_KR_SERVICE_KEY is invalid/);
  assert.equal(calls, 0);
});

test("invalid current snapshot identity or receipt hash stops collector, publisher, and registrar", async (t) => {
  const identity = await fixture(t); const identityEvents = []; const invalid = dependencies(identityEvents); invalid.validateSnapshotIdentity = () => { throw new Error("identity invalid"); };
  await assert.rejects(runCurrentSeoulAccessibilityRegistration(options(identity, invalid)), /identity invalid/);
  assert.equal(identityEvents.some(([name]) => ["collect", "publish", "register"].includes(name)), false);
  const mismatch = await fixture(t, { receiptSha: "0".repeat(64) }); const mismatchEvents = [];
  await assert.rejects(runCurrentSeoulAccessibilityRegistration(options(mismatch, dependencies(mismatchEvents))), /snapshot bytes mismatch/);
  assert.equal(mismatchEvents.some(([name]) => ["collect", "publish", "register"].includes(name)), false);
});

test("symlinked external receipt parent or target stops publisher and registrar", async (t) => {
  const parent = await fixture(t); const parentEvents = []; const alias = `${path.dirname(parent.receiptPath)}-alias`; await symlink(path.dirname(parent.receiptPath), alias); t.after(() => rm(alias, { force: true }));
  await assert.rejects(runCurrentSeoulAccessibilityRegistration({ ...options(parent, dependencies(parentEvents)), receiptPath: path.join(alias, "receipt.json") }), /receipt path/);
  assert.equal(parentEvents.some(([name]) => ["publish", "register"].includes(name)), false);
  const target = await fixture(t); const targetEvents = []; await symlink("/dev/null", target.receiptPath);
  await assert.rejects(runCurrentSeoulAccessibilityRegistration(options(target, dependencies(targetEvents))), /receipt path/);
  assert.equal(targetEvents.some(([name]) => ["publish", "register"].includes(name)), false);
});

test("collector and publisher failures stop later operations", async (t) => {
  const collector = await fixture(t); const collectorEvents = []; const collectorFailure = new Error("collector failed");
  await assert.rejects(runCurrentSeoulAccessibilityRegistration(options(collector, dependencies(collectorEvents, { collectError: collectorFailure }))), collectorFailure);
  assert.equal(collectorEvents.some(([name]) => ["publish", "register"].includes(name)), false);
  const publisher = await fixture(t); const publisherEvents = []; const publisherFailure = new Error("publisher failed");
  await assert.rejects(runCurrentSeoulAccessibilityRegistration(options(publisher, dependencies(publisherEvents, { publishError: publisherFailure }))), publisherFailure);
  assert.equal(publisherEvents.some(([name]) => name === "register"), false);
});

test("partial, foreign, or reordered registration outputs cannot return PASS", async (t) => {
  const cases = [outputsFor().slice(0, -1), [...outputsFor().slice(0, 6), "tools/datapack/release/foreign.json"], [...outputsFor().slice(1), outputsFor()[0]]];
  for (const registrationOutputs of cases) {
    const values = await fixture(t); const events = [];
    await assert.rejects(runCurrentSeoulAccessibilityRegistration(options(values, dependencies(events, { registrationOutputs }))), /output allowlist/);
    assert.equal(events.at(-1)[0], "register");
  }
});
