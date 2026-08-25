import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCurrentKricExitCollectionPlan } from "./build-current-kric-exit-collection-plan.mjs";
import {
  buildCurrentKricExitCollectionBundle,
  buildCurrentKricExitCollectionReceipt,
} from "./build-current-kric-exit-collection-receipt.mjs";
import { consumeCurrentKricExitCollectionBundle } from "./consume-current-kric-exit-collection-bundle.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort((left, right) => left.localeCompare(right, "en"))
    .map((key) => [key, sort(value[key])]));
}

test("420 EXIT bundle을 lossless로 읽고 exact receipt 실행 identity에 결속한다", async () => {
  const fixture = await bundleFixture();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "exit-bundle-consumer-"));
  try {
    const bundlePath = path.join(temporary, "bundle.json");
    await writeFile(bundlePath, fixture.bytes, { mode: 0o600 });
    const consumed = await consumeCurrentKricExitCollectionBundle({
      collectionBundle: bundlePath, expectedBundleSha256: sha256(fixture.bytes), expectedRepositorySha: "a".repeat(40), expectedOperationId: "current-capital-560",
    });
    assert.deepEqual(consumed.collectionPlanBytes, fixture.planBytes);
    assert.deepEqual(consumed.providerSnapshotBytes, fixture.snapshotBytes);
    assert.equal(consumed.receipt.operationId, "current-capital-560");
    await assert.rejects(() => consumeCurrentKricExitCollectionBundle({
      collectionBundle: bundlePath, expectedRepositorySha: "a".repeat(40), expectedOperationId: "current-capital-560",
    }), /expected bundle SHA mismatch/);
    await assert.rejects(() => consumeCurrentKricExitCollectionBundle({
      collectionBundle: bundlePath, expectedBundleSha256: "b".repeat(64), expectedRepositorySha: "a".repeat(40), expectedOperationId: "current-capital-560",
    }), /expected digest mismatch/);
    await assert.rejects(() => consumeCurrentKricExitCollectionBundle({
      collectionBundle: bundlePath, expectedBundleSha256: sha256(fixture.bytes), expectedRepositorySha: "b".repeat(40), expectedOperationId: "current-capital-560",
    }), /expected identity mismatch/);
    await assert.rejects(() => consumeCurrentKricExitCollectionBundle({
      collectionBundle: bundlePath, expectedBundleSha256: sha256(fixture.bytes), expectedRepositorySha: "a".repeat(40), expectedOperationId: "current-capital-561",
    }), /expected identity mismatch/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("self-hash가 다시 계산된 embedded receipt substitution도 거부한다", async () => {
  const fixture = await bundleFixture();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "exit-bundle-substitution-"));
  try {
    const substituted = JSON.parse(fixture.bytes);
    const receipt = JSON.parse(substituted.collectionReceiptJson);
    receipt.operationId = "current-capital-561";
    const payload = { ...receipt }; delete payload.receiptSha256;
    receipt.receiptSha256 = sha256(canonical(payload));
    substituted.collectionReceiptJson = canonical(receipt);
    const bundlePayload = { ...substituted }; delete bundlePayload.bundleSha256;
    substituted.bundleSha256 = sha256(canonical(bundlePayload));
    const bundlePath = path.join(temporary, "bundle.json");
    await writeFile(bundlePath, canonical(substituted), { mode: 0o600 });
    await assert.rejects(() => consumeCurrentKricExitCollectionBundle({
      collectionBundle: bundlePath, expectedBundleSha256: sha256(fixture.bytes), expectedRepositorySha: "a".repeat(40), expectedOperationId: "current-capital-560",
    }), /expected digest mismatch/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("snapshot semantic drift를 receipt와 bundle까지 재해시해도 producer 재검증에서 거부한다", async () => {
  const fixture = await bundleFixture();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "exit-bundle-semantic-drift-"));
  try {
    const substituted = JSON.parse(fixture.bytes);
    const snapshot = JSON.parse(substituted.providerSnapshotJson);
    snapshot.freshUntil = "2026-08-16T16:00:00.000Z";
    const snapshotPayload = { ...snapshot }; delete snapshotPayload.snapshotDigest;
    snapshot.snapshotDigest = sha256(canonical(snapshotPayload));
    substituted.providerSnapshotJson = canonical(snapshot);
    const receipt = JSON.parse(substituted.collectionReceiptJson);
    receipt.providerSnapshotSha256 = sha256(Buffer.from(substituted.providerSnapshotJson));
    receipt.providerSnapshotDigest = snapshot.snapshotDigest;
    const receiptPayload = { ...receipt }; delete receiptPayload.receiptSha256;
    receipt.receiptSha256 = sha256(canonical(receiptPayload));
    substituted.collectionReceiptJson = canonical(receipt);
    const bundlePayload = { ...substituted }; delete bundlePayload.bundleSha256;
    substituted.bundleSha256 = sha256(canonical(bundlePayload));
    const bundlePath = path.join(temporary, "bundle.json");
    await writeFile(bundlePath, canonical(substituted), { mode: 0o600 });
    await assert.rejects(() => consumeCurrentKricExitCollectionBundle({
      collectionBundle: bundlePath, expectedBundleSha256: sha256(fixture.bytes), expectedRepositorySha: "a".repeat(40), expectedOperationId: "current-capital-560",
    }), /expected digest mismatch/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

async function bundleFixture() {
  const root = import.meta.dirname;
  const paths = {
    canonicalPackBytes: "release/capital-production-canonical-pack.json",
    coverageTargetsBytes: "nationwide-coverage-targets.json",
    providerCodeCatalogBytes: "sources/kric-provider-code-catalog-20260228.json",
    routeRostersBytes: "sources/kric-nationwide-route-rosters-20260730T203926676Z.json",
    sourceInventoryBytes: "source-inventory.json",
    incheonTopologyBytes: "sources/incheon-transit-station-info-20260814.json",
  };
  const input = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, file]) => [
    key, await readFile(path.join(root, file)),
  ])));
  const plan = buildCurrentKricExitCollectionPlan(input, {
    now: new Date("2026-08-14T16:00:00.000Z"), coverageSelector: "capital-seoul-metro-production",
  });
  const rows = [{ edMovePath: null, elvtSttCd: null, elvtTpCd: null, exitMvTpOrdr: "1", imgPath: null, mvContDtl: null, mvPathMgNo: "1", stMovePath: null }];
  const results = plan.queryPlan.map((query, index) => ({
    queryId: query.queryId, state: index === 0 ? "ROWS_OBSERVED" : "EXPLICIT_ZERO", providerResultCode: "00",
    rawResponseSha256: sha256(`raw-${index}`), rawResponseByteSize: 1,
    providerRecordHash: sha256(canonical(index === 0 ? rows : [])), rows: index === 0 ? rows : [],
  }));
  const snapshotPayload = {
    schemaVersion: 1, artifactKind: "kric-exit-path-provider-snapshot", sourceId: "kric-station-movement-standard",
    snapshotId: "kric-station-movement-standard-20260814T160000000Z", capturedAt: "2026-08-14T16:00:00.000Z",
    freshUntil: "2026-08-15T16:00:00.000Z", credentialRedacted: true,
    collectionPlanDigest: plan.collectionPlanDigest, queryPlanSha256: plan.queryPlanSha256,
    coverage: { requestPlanComplete: true, queryIds: plan.queryPlan.map(({ queryId }) => queryId) },
    queryPlan: plan.queryPlan, results,
  };
  const snapshot = sort({ ...snapshotPayload, snapshotDigest: sha256(canonical(snapshotPayload)) });
  const planBytes = Buffer.from(canonical(plan));
  const snapshotBytes = Buffer.from(canonical(snapshot));
  const receipt = buildCurrentKricExitCollectionReceipt({
    collectionPlanBytes: planBytes, providerSnapshotBytes: snapshotBytes,
    repository: "AquilaXk/easysubway-data", repositorySha: "a".repeat(40), operationId: "current-capital-560",
  });
  const bundle = buildCurrentKricExitCollectionBundle({ collectionPlanBytes: planBytes, providerSnapshotBytes: snapshotBytes, receipt });
  return { planBytes, snapshotBytes, bytes: Buffer.from(canonical(bundle)) };
}
