import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  for (const relative of [...tracked, ...support]) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(ROOT, relative), target);
  }
  const snapshotsPath = path.join(root, tracked[0]);
  const snapshots = JSON.parse(await readFile(snapshotsPath));
  const sources = [];
  for (const sourceId of SELECTED_RELEASE_SOURCE_IDS) {
    const previous = snapshots.filter((snapshot) => snapshot.sourceId === sourceId).at(-1);
    const raw = Buffer.from(`immutable OCI raw bytes for ${sourceId}`);
    const rawSha256 = sha(raw);
    const successor = structuredClone(previous);
    successor.snapshotId = `${sourceId}-oci-rehome-20260822`;
    successor.previousSnapshotId = previous.snapshotId;
    successor.retrievedAt = "2026-08-22T00:00:00.000Z";
    successor.coverageCount ??= 0;
    successor.rawSha256 = rawSha256;
    successor.rawObjectUri = `oci://easysubway-datapacks/source-raw/${sourceId}/20260822/${rawSha256}.json`;
    successor.diffSummary = buildSnapshotDiff(previous, successor);
    const sourceRoot = path.join(root, "operation", sourceId);
    await mkdir(sourceRoot, { recursive: true });
    const rawPath = path.join(sourceRoot, "raw.json");
    const snapshotPath = path.join(sourceRoot, "snapshot.json");
    const receiptPath = path.join(sourceRoot, "receipt.json");
    await writeFile(rawPath, raw);
    await writeFile(snapshotPath, `${JSON.stringify(successor, null, 2)}\n`);
    await writeFile(receiptPath, `${JSON.stringify({
      schemaVersion: 1, artifactKind: "selected-release-source-oci-raw-receipt", sourceId,
      snapshotId: successor.snapshotId, rawObjectUri: successor.rawObjectUri,
      rawObjectSha256: rawSha256, byteSize: raw.length,
    }, null, 2)}\n`);
    sources.push({ sourceId, currentSnapshotId: previous.snapshotId, snapshotPath: path.relative(root, snapshotPath), receiptPath: path.relative(root, receiptPath), rawPath: path.relative(root, rawPath) });
  }
  const manifestPath = path.join(root, "operation", "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: 1, artifactKind: "selected-release-source-oci-rehome-manifest", sources }, null, 2)}\n`);
  return { root, manifestPath };
}

test("exact three OCI successor receipts publish and then atomically rehome the four release identities", async (t) => {
  const { root, manifestPath } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = await Promise.all(tracked.map((relative) => readFile(path.join(root, relative))));
  const calls = [];
  await rehomeSelectedReleaseSourceLineage({
    repositoryRoot: root,
    manifestPath,
    publishImmutableObjectPlanImpl: async ({ plan, root: planRoot }) => {
      calls.push({ plan, root: planRoot });
      assert.equal(plan.steps.length, 2);
      assert.equal(plan.steps[0].type, "put-immutable-bundle-object");
      assert.equal(plan.steps[1].type, "verify-immutable-bundle-object");
    },
  });
  assert.deepEqual(calls.map(({ plan }) => plan.steps[0].objectKey.split("/")[1]), SELECTED_RELEASE_SOURCE_IDS);
  const snapshots = JSON.parse(await readFile(path.join(root, tracked[0])));
  const spec = JSON.parse(await readFile(path.join(root, tracked[1])));
  assert.equal(snapshots.filter((snapshot) => SELECTED_RELEASE_SOURCE_IDS.includes(snapshot.sourceId) && snapshot.rawObjectUri.startsWith("oci://")).length >= 3, true);
  assert.equal(spec.sourceSnapshots.filter((snapshot) => SELECTED_RELEASE_SOURCE_IDS.includes(snapshot.sourceId)).every((snapshot) => snapshot.rawObjectUri.startsWith("oci://")), true);
  assert.equal((await Promise.all(tracked.map((relative) => readFile(path.join(root, relative))))).some((bytes, index) => !bytes.equals(before[index])), true);
});

test("a failed publication leaves all four tracked release files untouched", async (t) => {
  const { root, manifestPath } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = await Promise.all(tracked.map((relative) => readFile(path.join(root, relative))));
  await assert.rejects(rehomeSelectedReleaseSourceLineage({
    repositoryRoot: root, manifestPath,
    publishImmutableObjectPlanImpl: async () => { throw new Error("injected publication failure"); },
  }), /injected publication failure/);
  assert.deepEqual(await Promise.all(tracked.map((relative) => readFile(path.join(root, relative)))), before);
});
