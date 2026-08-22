import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildSnapshotDiff } from "./source-snapshot-policy.mjs";
import { rehomeSelectedReleaseSourceLineage, SELECTED_RELEASE_SOURCE_IDS } from "./rehome-selected-release-source-lineage.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const tracked = [
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/release/candidate-build-spec.json",
  "tools/datapack/release/release-request.json",
  "tools/datapack/release/hash-evidence.json",
];
const support = [
  "tools/datapack/source-inventory.json",
  "tools/datapack/release/capital-production-canonical-pack.json",
  "tools/datapack/source-governance-policy.json",
  "release/product-gates/datapack-freshness-sla.json",
  "tools/datapack/itx-cheongchun-topology-evidence-20260812165525800.json",
];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "source-lineage-rehome-"));
  const operationRoot = await mkdtemp(path.join(os.tmpdir(), "source-lineage-operation-"));
  for (const relative of [...tracked, ...support]) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(ROOT, relative), target);
  }
  const snapshotsPath = path.join(root, tracked[0]);
  const snapshots = JSON.parse(await readFile(snapshotsPath));
  const sources = [];
  for (const sourceId of SELECTED_RELEASE_SOURCE_IDS) {
    const chain = snapshots.filter((snapshot) => snapshot.sourceId === sourceId);
    const raw = Buffer.from(`immutable OCI raw bytes for ${sourceId}`);
    for (const snapshot of chain) { snapshot.rawSha256 = sha(raw); snapshot.coverageCount ??= 0; }
    for (const [index, snapshot] of chain.entries()) if (index > 0) snapshot.diffSummary = buildSnapshotDiff(chain[index - 1], snapshot);
    const previous = chain.at(-1);
    const rawSha256 = sha(raw);
    const successor = structuredClone(previous);
    successor.snapshotId = `${sourceId}-oci-rehome-20260822`;
    successor.previousSnapshotId = previous.snapshotId;
    successor.retrievedAt = new Date(Date.parse(previous.retrievedAt) + 1).toISOString();
    successor.freshnessExpiresAt = new Date(Date.parse(previous.freshnessExpiresAt) + 1).toISOString();
    successor.rawRetentionExpiresAt = new Date(Date.parse(previous.rawRetentionExpiresAt) + 1).toISOString();
    successor.coverageCount ??= 0;
    successor.rawSha256 = rawSha256;
    const retrievedDay = successor.retrievedAt.slice(0, 10).replaceAll("-", "");
    successor.rawObjectUri = `oci://easysubway-datapacks/source-raw/${sourceId}/${retrievedDay}/${rawSha256}.json`;
    successor.diffSummary = buildSnapshotDiff(previous, successor);
    const sourceRoot = path.join(operationRoot, sourceId);
    await mkdir(sourceRoot, { recursive: true });
    const rawPath = path.join(sourceRoot, "raw.json");
    const snapshotPath = path.join(sourceRoot, "snapshot.json");
    const receiptPath = path.join(sourceRoot, "receipt.json");
    await writeFile(rawPath, raw);
    await writeFile(snapshotPath, `${JSON.stringify(successor, null, 2)}\n`);
    sources.push({ sourceId, currentSnapshotId: previous.snapshotId, snapshotPath: path.relative(operationRoot, snapshotPath), receiptPath: path.relative(operationRoot, receiptPath), rawPath: path.relative(operationRoot, rawPath) });
  }
  await writeFile(snapshotsPath, `${JSON.stringify(snapshots, null, 2)}\n`);
  const manifestPath = path.join(operationRoot, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: 1, artifactKind: "selected-release-source-oci-rehome-manifest", sources }, null, 2)}\n`);
  return { root, operationRoot, manifestPath, sources };
}

const env = {
  EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/opaque/n/axvym6vk8g7i/b/easysubway-datapacks/o/",
};

async function trackedBytes(root) {
  return Promise.all(tracked.map((relative) => readFile(path.join(root, relative))));
}

async function readManifest(manifestPath) {
  return JSON.parse(await readFile(manifestPath));
}

async function writeManifest(manifestPath, manifest) {
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

test("exact three OCI successor receipts publish and then atomically rehome the four release identities", async (t) => {
  const { root, operationRoot, manifestPath } = await fixture();
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(operationRoot, { recursive: true, force: true })]));
  const before = await Promise.all(tracked.map((relative) => readFile(path.join(root, relative))));
  const calls = [];
  await rehomeSelectedReleaseSourceLineage({
    repositoryRoot: root,
    manifestPath,
    env,
    now: () => new Date("2026-08-22T07:00:00.000Z"),
    publishImmutableObjectPlanImpl: async ({ plan, root: planRoot }) => {
      calls.push({ plan, root: planRoot });
      assert.equal(plan.steps.length, 2);
      assert.equal(plan.steps[0].type, "put-immutable-bundle-object");
      assert.equal(plan.steps[1].type, "verify-immutable-bundle-object");
    },
  });
  assert.deepEqual(calls.map(({ plan }) => plan.steps[0].objectKey.split("/")[1]), SELECTED_RELEASE_SOURCE_IDS);
  assert.equal(calls.every(({ root: planRoot }) => planRoot === operationRoot), true);
  const snapshots = JSON.parse(await readFile(path.join(root, tracked[0])));
  const spec = JSON.parse(await readFile(path.join(root, tracked[1])));
  assert.equal(snapshots.filter((snapshot) => SELECTED_RELEASE_SOURCE_IDS.includes(snapshot.sourceId) && snapshot.rawObjectUri.startsWith("oci://")).length >= 3, true);
  assert.equal(spec.sourceSnapshots.filter((snapshot) => SELECTED_RELEASE_SOURCE_IDS.includes(snapshot.sourceId)).every((snapshot) => snapshot.rawObjectUri.startsWith("oci://")), true);
  assert.equal((await Promise.all(tracked.map((relative) => readFile(path.join(root, relative))))).some((bytes, index) => !bytes.equals(before[index])), true);
  const manifest = await readManifest(manifestPath);
  for (const source of manifest.sources) {
    const receipt = JSON.parse(await readFile(path.join(operationRoot, source.receiptPath)));
    assert.deepEqual(Object.keys(receipt), ["schemaVersion", "artifactKind", "sourceId", "snapshotId", "rawObjectUri", "rawObjectSha256", "byteSize", "storedAt"]);
    assert.equal(receipt.storedAt, "2026-08-22T07:00:00.000Z");
  }
});

test("a failed publication leaves all four tracked release files untouched", async (t) => {
  const { root, operationRoot, manifestPath } = await fixture();
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(operationRoot, { recursive: true, force: true })]));
  const before = await trackedBytes(root);
  await assert.rejects(rehomeSelectedReleaseSourceLineage({
    repositoryRoot: root, manifestPath, env,
    publishImmutableObjectPlanImpl: async () => { throw new Error("injected publication failure"); },
  }), /OCI source publication failed/);
  assert.deepEqual(await trackedBytes(root), before);
});

test("invalid raw bytes, receipt collision, absent PAR, and noncanonical OCI URI leave tracked outputs untouched", async (t) => {
  const { root, operationRoot, manifestPath } = await fixture();
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(operationRoot, { recursive: true, force: true })]));
  const before = await trackedBytes(root);
  const manifest = await readManifest(manifestPath);
  const first = manifest.sources[0];
  await writeFile(path.join(operationRoot, first.rawPath), "byte mismatch");
  await assert.rejects(rehomeSelectedReleaseSourceLineage({ repositoryRoot: root, manifestPath, env, publishImmutableObjectPlanImpl: async () => assert.fail("must not publish") }), /lineage or OCI bytes are invalid/);
  assert.deepEqual(await trackedBytes(root), before);

  await rm(operationRoot, { recursive: true, force: true });
  const reset = await fixture();
  t.after(() => Promise.all([rm(reset.root, { recursive: true, force: true }), rm(reset.operationRoot, { recursive: true, force: true })]));
  const resetBefore = await trackedBytes(reset.root);
  const resetManifest = await readManifest(reset.manifestPath);
  await writeFile(path.join(reset.operationRoot, resetManifest.sources[0].receiptPath), "caller receipt");
  await assert.rejects(rehomeSelectedReleaseSourceLineage({ repositoryRoot: reset.root, manifestPath: reset.manifestPath, env, publishImmutableObjectPlanImpl: async () => assert.fail("must not publish") }), /rehome receipt/);
  assert.deepEqual(await trackedBytes(reset.root), resetBefore);

  const invalidPar = await fixture();
  t.after(() => Promise.all([rm(invalidPar.root, { recursive: true, force: true }), rm(invalidPar.operationRoot, { recursive: true, force: true })]));
  const invalidParBefore = await trackedBytes(invalidPar.root);
  await assert.rejects(rehomeSelectedReleaseSourceLineage({ repositoryRoot: invalidPar.root, manifestPath: invalidPar.manifestPath, env: {}, publishImmutableObjectPlanImpl: async () => assert.fail("must not publish") }), /preauthenticated object URL/);
  assert.deepEqual(await trackedBytes(invalidPar.root), invalidParBefore);

  const evil = await fixture();
  t.after(() => Promise.all([rm(evil.root, { recursive: true, force: true }), rm(evil.operationRoot, { recursive: true, force: true })]));
  const evilBefore = await trackedBytes(evil.root);
  const evilManifest = await readManifest(evil.manifestPath);
  const successorPath = path.join(evil.operationRoot, evilManifest.sources[0].snapshotPath);
  const successor = JSON.parse(await readFile(successorPath));
  successor.rawObjectUri = `oci://other-bucket/anything/${successor.rawSha256}.json`;
  await writeFile(successorPath, `${JSON.stringify(successor, null, 2)}\n`);
  await assert.rejects(rehomeSelectedReleaseSourceLineage({ repositoryRoot: evil.root, manifestPath: evil.manifestPath, env, publishImmutableObjectPlanImpl: async () => assert.fail("must not publish") }), /lineage or OCI bytes are invalid/);
  assert.deepEqual(await trackedBytes(evil.root), evilBefore);
});

test("a symlinked operation root is rejected before any repository mutation", async (t) => {
  const { root, operationRoot, manifestPath } = await fixture();
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(operationRoot, { recursive: true, force: true })]));
  const before = await trackedBytes(root);
  const linkedOperationRoot = `${operationRoot}-link`;
  await symlink(operationRoot, linkedOperationRoot);
  t.after(() => rm(linkedOperationRoot, { force: true }));
  await assert.rejects(rehomeSelectedReleaseSourceLineage({
    repositoryRoot: root,
    manifestPath: path.join(linkedOperationRoot, path.basename(manifestPath)),
    env,
    publishImmutableObjectPlanImpl: async () => assert.fail("must not publish"),
  }), /operation root must be a regular directory/);
  assert.deepEqual(await trackedBytes(root), before);
});

test("foreign replacement immediately before forward or recovery replacement is preserved", async (t) => {
  const forward = await fixture();
  t.after(() => Promise.all([rm(forward.root, { recursive: true, force: true }), rm(forward.operationRoot, { recursive: true, force: true })]));
  const foreignForward = Buffer.from("foreign forward replacement");
  await assert.rejects(rehomeSelectedReleaseSourceLineage({
    repositoryRoot: forward.root,
    manifestPath: forward.manifestPath,
    env,
    publishImmutableObjectPlanImpl: async () => {},
    transactionHooks: {
      beforeReplace: async ({ index, target }) => { if (index === 0) await writeFile(target, foreignForward); },
    },
  }), /selected source OCI rehome rollback failed/);
  assert.deepEqual(await readFile(path.join(forward.root, tracked[0])), foreignForward);

  const recovery = await fixture();
  t.after(() => Promise.all([rm(recovery.root, { recursive: true, force: true }), rm(recovery.operationRoot, { recursive: true, force: true })]));
  await assert.rejects(rehomeSelectedReleaseSourceLineage({
    repositoryRoot: recovery.root,
    manifestPath: recovery.manifestPath,
    env,
    publishImmutableObjectPlanImpl: async () => {},
    transactionHooks: { leavePreparedAfterReplace: 0 },
  }), /injected prepared residue/);
  const foreignRecovery = Buffer.from("foreign recovery replacement");
  await assert.rejects(rehomeSelectedReleaseSourceLineage({
    repositoryRoot: recovery.root,
    manifestPath: recovery.manifestPath,
    env,
    publishImmutableObjectPlanImpl: async ({ plan }) => {
      assert.deepEqual(plan.steps.map(({ type }) => type), ["verify-immutable-bundle-object"]);
    },
    transactionHooks: {
      beforeRecoveryReplace: async ({ target }) => { await writeFile(target, foreignRecovery); },
    },
  }), /preserves foreign replacement/);
  assert.deepEqual(await readFile(path.join(recovery.root, tracked[0])), foreignRecovery);
});

test("foreign replacement after publication and before transaction entry leaves every tracked transaction target untouched", async (t) => {
  const { root, operationRoot, manifestPath } = await fixture();
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(operationRoot, { recursive: true, force: true })]));
  const before = await trackedBytes(root);
  const foreign = Buffer.from("foreign post-publication replacement");
  await assert.rejects(rehomeSelectedReleaseSourceLineage({
    repositoryRoot: root,
    manifestPath,
    env,
    publishImmutableObjectPlanImpl: async () => {},
    transactionHooks: {
      beforeTransaction: async ({ root: transactionRoot }) => writeFile(path.join(transactionRoot, tracked[0]), foreign),
    },
  }), /preserves foreign replacement/);
  assert.deepEqual(await readFile(path.join(root, tracked[0])), foreign);
  assert.deepEqual(await Promise.all(tracked.slice(1).map((relative) => readFile(path.join(root, relative)))), before.slice(1));
  await assert.rejects(readFile(path.join(root, "tools/datapack/.selected-release-source-oci-rehome-transaction.json")), { code: "ENOENT" });
  assert.equal((await readdir(path.join(root, "tools/datapack"))).some((name) => /^\.selected-release-source-oci-rehome-[a-f0-9-]+$/u.test(name)), false);
});

test("PREPARED publication resumes with GET verification for an exact receipt residue", async (t) => {
  const { root, operationRoot, manifestPath } = await fixture();
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(operationRoot, { recursive: true, force: true })]));
  const firstAttempt = [];
  await assert.rejects(rehomeSelectedReleaseSourceLineage({
    repositoryRoot: root,
    manifestPath,
    env,
    publishImmutableObjectPlanImpl: async ({ sourceId, plan }) => {
      firstAttempt.push({ sourceId, types: plan.steps.map(({ type }) => type) });
      if (sourceId === SELECTED_RELEASE_SOURCE_IDS[1]) throw new Error("second publication failed");
    },
  }), /OCI source publication failed/);
  assert.deepEqual(firstAttempt, [
    { sourceId: SELECTED_RELEASE_SOURCE_IDS[0], types: ["put-immutable-bundle-object", "verify-immutable-bundle-object"] },
    { sourceId: SELECTED_RELEASE_SOURCE_IDS[1], types: ["put-immutable-bundle-object", "verify-immutable-bundle-object"] },
  ]);

  const resumed = [];
  await rehomeSelectedReleaseSourceLineage({
    repositoryRoot: root,
    manifestPath,
    env,
    publishImmutableObjectPlanImpl: async ({ sourceId, plan }) => resumed.push({ sourceId, types: plan.steps.map(({ type }) => type) }),
  });
  assert.deepEqual(resumed, [
    { sourceId: SELECTED_RELEASE_SOURCE_IDS[0], types: ["verify-immutable-bundle-object"] },
    { sourceId: SELECTED_RELEASE_SOURCE_IDS[1], types: ["put-immutable-bundle-object", "verify-immutable-bundle-object"] },
    { sourceId: SELECTED_RELEASE_SOURCE_IDS[2], types: ["put-immutable-bundle-object", "verify-immutable-bundle-object"] },
  ]);
});

test("VERIFIED and COMMITTED residues fail closed for missing receipt or object verification failure", async (t) => {
  const missingReceipt = await fixture();
  t.after(() => Promise.all([rm(missingReceipt.root, { recursive: true, force: true }), rm(missingReceipt.operationRoot, { recursive: true, force: true })]));
  await rehomeSelectedReleaseSourceLineage({ repositoryRoot: missingReceipt.root, manifestPath: missingReceipt.manifestPath, env, publishImmutableObjectPlanImpl: async () => {} });
  const manifest = await readManifest(missingReceipt.manifestPath);
  await rm(path.join(missingReceipt.operationRoot, manifest.sources[0].receiptPath));
  await assert.rejects(rehomeSelectedReleaseSourceLineage({
    repositoryRoot: missingReceipt.root,
    manifestPath: missingReceipt.manifestPath,
    env,
    publishImmutableObjectPlanImpl: async () => assert.fail("missing receipt must not publish"),
  }), /receipt is missing/);

  const verifyFailure = await fixture();
  t.after(() => Promise.all([rm(verifyFailure.root, { recursive: true, force: true }), rm(verifyFailure.operationRoot, { recursive: true, force: true })]));
  await rehomeSelectedReleaseSourceLineage({ repositoryRoot: verifyFailure.root, manifestPath: verifyFailure.manifestPath, env, publishImmutableObjectPlanImpl: async () => {} });
  await assert.rejects(rehomeSelectedReleaseSourceLineage({
    repositoryRoot: verifyFailure.root,
    manifestPath: verifyFailure.manifestPath,
    env,
    publishImmutableObjectPlanImpl: async () => { throw new Error("GET mismatch"); },
  }), /OCI source publication failed/);
});

test("a mid-replace failure rolls back, and PREPARED or COMMITTED residue recovers without another publication", async (t) => {
  const { root, operationRoot, manifestPath } = await fixture();
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(operationRoot, { recursive: true, force: true })]));
  const before = await trackedBytes(root);
  const calls = [];
  await assert.rejects(rehomeSelectedReleaseSourceLineage({
    repositoryRoot: root, manifestPath, env,
    publishImmutableObjectPlanImpl: async () => { calls.push("publish"); },
    transactionHooks: { failAfterReplace: 1 },
  }), /injected transaction failure/);
  assert.deepEqual(await trackedBytes(root), before);
  await rehomeSelectedReleaseSourceLineage({
    repositoryRoot: root,
    manifestPath,
    env,
    publishImmutableObjectPlanImpl: async ({ plan }) => assert.deepEqual(plan.steps.map(({ type }) => type), ["verify-immutable-bundle-object"]),
  });
  assert.notDeepEqual(await trackedBytes(root), before);

  const prepared = await fixture();
  t.after(() => Promise.all([rm(prepared.root, { recursive: true, force: true }), rm(prepared.operationRoot, { recursive: true, force: true })]));
  await assert.rejects(rehomeSelectedReleaseSourceLineage({
    repositoryRoot: prepared.root, manifestPath: prepared.manifestPath, env,
    publishImmutableObjectPlanImpl: async () => {}, transactionHooks: { leavePreparedAfterReplace: 0 },
  }), /injected prepared residue/);
  const preparedBeforeRetry = await trackedBytes(prepared.root);
  await rehomeSelectedReleaseSourceLineage({
    repositoryRoot: prepared.root,
    manifestPath: prepared.manifestPath,
    env,
    publishImmutableObjectPlanImpl: async ({ plan }) => assert.deepEqual(plan.steps.map(({ type }) => type), ["verify-immutable-bundle-object"]),
  });
  assert.notDeepEqual(await trackedBytes(prepared.root), preparedBeforeRetry);

  const committedForward = await fixture();
  t.after(() => Promise.all([rm(committedForward.root, { recursive: true, force: true }), rm(committedForward.operationRoot, { recursive: true, force: true })]));
  await assert.rejects(rehomeSelectedReleaseSourceLineage({
    repositoryRoot: committedForward.root, manifestPath: committedForward.manifestPath, env,
    publishImmutableObjectPlanImpl: async () => {}, transactionHooks: { leaveCommittedResidue: true },
  }), /injected committed residue/);
  const forward = await rehomeSelectedReleaseSourceLineage({
    repositoryRoot: committedForward.root,
    manifestPath: committedForward.manifestPath,
    env,
    publishImmutableObjectPlanImpl: async ({ plan }) => assert.deepEqual(plan.steps.map(({ type }) => type), ["verify-immutable-bundle-object"]),
  });
  assert.equal(forward.recovered, true);

  const committed = await fixture();
  t.after(() => Promise.all([rm(committed.root, { recursive: true, force: true }), rm(committed.operationRoot, { recursive: true, force: true })]));
  await assert.rejects(rehomeSelectedReleaseSourceLineage({
    repositoryRoot: committed.root, manifestPath: committed.manifestPath, env,
    publishImmutableObjectPlanImpl: async () => {}, transactionHooks: { leaveCommittedResidue: true },
  }), /injected committed residue/);
  await writeFile(path.join(committed.root, tracked[0]), "corrupt after-hash state");
  await assert.rejects(rehomeSelectedReleaseSourceLineage({
    repositoryRoot: committed.root,
    manifestPath: committed.manifestPath,
    env,
    publishImmutableObjectPlanImpl: async ({ plan }) => assert.deepEqual(plan.steps.map(({ type }) => type), ["verify-immutable-bundle-object"]),
  }), /committed output drift/);
});
