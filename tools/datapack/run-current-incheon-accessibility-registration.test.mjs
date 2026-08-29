import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  finalizeCurrentIncheonAccessibilityRegistration,
  prepareCurrentIncheonAccessibilityRegistration,
} from "./run-current-incheon-accessibility-registration.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SHA = "a".repeat(40);
const OCI_ENV = { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/approved/n/axvym6vk8g7i/b/easysubway-datapacks/o/" };
const fixturePaths = [
  "tools/datapack/source-inventory.json",
  "tools/datapack/sources/incheon-transit-station-info-20260828.json",
  "tools/datapack/fixtures/incheon-accessibility-raw/data-go-15083478.csv",
  "tools/datapack/fixtures/incheon-accessibility-raw/data-go-15010199.csv",
  "tools/datapack/fixtures/incheon-accessibility-raw/data-go-15146049.csv",
];

async function fixture(t) {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "incheon-runner-repository-")); const operationRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "incheon-runner-operation-parent-")), "operation");
  t.after(() => Promise.all([rm(repositoryRoot, { recursive: true, force: true }), rm(path.dirname(operationRoot), { recursive: true, force: true })]));
  for (const relative of fixturePaths) { await mkdir(path.dirname(path.join(repositoryRoot, relative)), { recursive: true }); await cp(path.join(ROOT, relative), path.join(repositoryRoot, relative)); }
  const exactMain = async () => {}; const lease = async () => async () => {}; const prepared = await prepareCurrentIncheonAccessibilityRegistration({ repositoryRoot, operationRoot, expectedMainSha: SHA, assertExactMain: exactMain, acquireLease: lease, now: new Date("2026-08-28T04:34:00.000Z") });
  const fixed = [
    `tools/datapack/sources/${prepared.snapshotId}.json`,
    "tools/datapack/source-inventory.json",
    "tools/datapack/release/source-snapshots.json",
    "tools/datapack/release/candidate-build-spec.json",
    "tools/datapack/release/release-request.json",
    "tools/datapack/release/hash-evidence.json",
  ];
  const buildOutputs = async ({ now }) => Promise.all(fixed.map(async (relative, index) => {
    const file = path.join(repositoryRoot, relative); let before = null;
    try { before = await readFile(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
    return { relative, bytes: Buffer.from(`registered-${index}-${now.toISOString()}\n`), prestateBytes: before };
  }));
  const commitOutputs = async ({ outputs }) => { for (const output of outputs) { const file = path.join(repositoryRoot, output.relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, output.bytes); } };
  return { repositoryRoot, operationRoot, prepared, exactMain, lease, buildOutputs, commitOutputs };
}
async function receiptPublisher({ receiptPath }) { await writeFile(receiptPath, "receipt\n"); }
function finalize(values, extra = {}) { return finalizeCurrentIncheonAccessibilityRegistration({ repositoryRoot: values.repositoryRoot, operationRoot: values.operationRoot, assertExactMain: values.exactMain, assertPinnedMain: values.exactMain, assertRecoveryState: values.exactMain, acquireLease: values.lease, buildOutputs: values.buildOutputs, commitOutputs: values.commitOutputs, recoverRegistrar: async () => {}, env: OCI_ENV, now: new Date("2026-08-28T04:40:00.000Z"), ...extra }); }

test("prepare seals an observation without publishing, then finalize publishes and registers once", async (t) => {
  const values = await fixture(t); let published = 0; let registered = 0;
  await assert.doesNotReject(Promise.resolve(values.prepared)); assert.equal(published, 0);
  await finalize(values, { publisher: async (args) => { published += 1; await receiptPublisher(args); }, commitOutputs: async (args) => { registered += 1; await values.commitOutputs(args); } });
  assert.equal(published, 1); assert.equal(registered, 1);
});

test("PUBLISHING resumes from an exact receipt without another publisher call", async (t) => {
  const values = await fixture(t); let first = 0; await assert.rejects(finalize(values, { publisher: async (args) => { first += 1; await receiptPublisher(args); throw new Error("crash after receipt"); } }), /crash/);
  let resumed = 0; await finalize(values, { publisher: async () => { resumed += 1; } }); assert.equal(first, 1); assert.equal(resumed, 0);
});

test("PUBLISHING without a receipt fails closed without retrying OCI publication", async (t) => {
  const values = await fixture(t); await assert.rejects(finalize(values, { publisher: async () => { throw new Error("connection dropped"); } }), /connection/);
  let calls = 0; await assert.rejects(finalize(values, { publisher: async () => { calls += 1; } }), /publication outcome is unresolved/); assert.equal(calls, 0);
});

test("REGISTERING recovery reaches FINALIZED without publishing", async (t) => {
  const values = await fixture(t); let publishes = 0; await assert.rejects(finalize(values, { publisher: async (args) => { publishes += 1; await receiptPublisher(args); }, commitOutputs: async () => { throw new Error("registrar interrupted"); } }), /interrupted/);
  let resumed = 0; await finalize(values, { publisher: async () => { resumed += 1; }, now: new Date("2026-08-28T04:50:00.000Z") }); assert.equal(publishes, 1); assert.equal(resumed, 0);
});

test("input drift fails before publisher invocation", async (t) => {
  const values = await fixture(t); const input = path.join(values.repositoryRoot, fixturePaths[2]); await writeFile(input, `${await readFile(input, "utf8")}drift\n`); let calls = 0;
  await assert.rejects(finalize(values, { publisher: async () => { calls += 1; } }), /inputs drifted/); assert.equal(calls, 0);
});

test("invalid OCI configuration leaves the prepared operation publishable", async (t) => {
  const values = await fixture(t); let calls = 0;
  await assert.rejects(finalize(values, { env: {}, publisher: async () => { calls += 1; } }), /EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL/);
  assert.equal(calls, 0); assert.equal(JSON.parse(await readFile(path.join(values.operationRoot, "incheon-accessibility-registration.json"), "utf8")).phase, "PREPARED");
});

test("FINALIZED re-entry rejects a changed OCI receipt", async (t) => {
  const values = await fixture(t); await finalize(values, { publisher: receiptPublisher });
  await writeFile(path.join(values.operationRoot, "oci-receipt.json"), "different receipt\n");
  await assert.rejects(finalize(values, { publisher: async () => { throw new Error("must not publish"); } }), /OCI receipt drifted/);
});
