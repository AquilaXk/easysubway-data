import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { registerKricSubwayTimetable } from "./register-kric-subway-timetable.mjs";
import { deriveRawRetentionExpiresAt } from "./source-governance-policy.mjs";
import { validateLineage } from "./source-snapshot-policy.mjs";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");
const SOURCE_ID = "kric-subway-timetable";
const HEAD = "e".repeat(40);
const INPUTS = [
  "tools/datapack/source-inventory.json",
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/source-governance-policy.json",
  "release/product-gates/datapack-freshness-sla.json",
];
// 원장 head보다 하루 뒤의 관측으로 고정한다(커밋된 head가 바뀌어도 테스트가 같은 조건을 만든다).
const LIVE_LEDGER = JSON.parse(await readFile(path.join(REPOSITORY_ROOT, "tools/datapack/release/source-snapshots.json"), "utf8"));
const LIVE_HEAD = LIVE_LEDGER.find(({ snapshotId }) => snapshotId === validateLineage(LIVE_LEDGER).headsBySource[SOURCE_ID]);
const COLLECTED_AT = new Date(Date.parse(LIVE_HEAD.retrievedAt) + 24 * 60 * 60 * 1_000).toISOString();
const COLLECTED_DATE = COLLECTED_AT.slice(0, 10);
const NOW = new Date(Date.parse(COLLECTED_AT) + 30 * 60 * 1_000);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const gitRunner = async (args) => (args[0] === "rev-parse" ? `${HEAD}\n` : "");

// 공식 수집기 산출물과 같은 형태·고정 건수(2026-10-01 승인 관측)를 가진 합성 수집 산출물.
function collection() {
  const responses = Array.from({ length: 153 }, (_, index) => {
    const bytes = Buffer.from(JSON.stringify({ header: { resultCode: "00" }, body: [{
      railOprIsttCd: "S1", trnNo: `K${index}`, dayCd: "8", dayNm: "평일", stinCd: "433", lnCd: "4", arvTm: null, dptTm: "050000", exptCd: null,
    }] }));
    return { requestKey: `subwayTimetableExp|S1|${index}|8`, rawSha256: sha(bytes), byteSize: bytes.length, bodyBase64: bytes.toString("base64") };
  });
  return {
    artifactKind: "kric-line4-timetable-collection", sourceId: "kric-subway-route-info", lineId: "seoul-4",
    operation: "subwayTimetableExp", collectedAt: COLLECTED_AT, capturedAt: COLLECTED_DATE,
    requestCount: 153, failedRequestCount: 0, expectedNoDataRequestCount: 51,
    intermediateRowCount: 32677, excludedOutsidePilotGroupCount: 415, excludedNonStopRowCount: 42,
    reconstructionRowCount: 21645, transitTripCount: 458, transitStopTimeCount: 21645,
    rawResponseInventory: { responseCount: 153, inventorySha256: sha(JSON.stringify(responses)), responses },
    excludedOutsidePilotGroups: Array.from({ length: 415 }, () => ({})),
    excludedNonStopRows: Array.from({ length: 42 }, () => ({ reason: "NO_ARRIVAL_DEPARTURE_ONLY" })),
    transitTrips: Array.from({ length: 458 }, () => ({})),
    transitStopTimes: Array.from({ length: 21645 }, () => ({})),
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "kric-line4-register-repo-"));
  const operation = await mkdtemp(path.join(os.tmpdir(), "kric-line4-register-op-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(operation, { recursive: true, force: true })]));
  for (const relative of INPUTS) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await cp(path.join(REPOSITORY_ROOT, relative), path.join(root, relative));
  }
  const governance = JSON.parse(await readFile(path.join(root, INPUTS[2]), "utf8"));
  const bytes = Buffer.from(`${JSON.stringify(collection(), null, 2)}\n`);
  const rawSha256 = sha(bytes);
  const objectKey = `source-raw/${SOURCE_ID}/${COLLECTED_DATE.replaceAll("-", "")}/${rawSha256}.json`;
  const receipt = {
    schemaVersion: 1, artifactKind: "kric-timetable-raw-object-receipt", sourceId: SOURCE_ID,
    snapshotId: `${SOURCE_ID}-line4-pilot-${COLLECTED_DATE.replaceAll("-", "")}`, capturedAt: COLLECTED_DATE, collectedAt: COLLECTED_AT,
    rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/${objectKey}`, rawObjectSha256: rawSha256,
    ociNamespace: "axvym6vk8g7i", bucket: "easysubway-datapacks", objectKey, capturedDate: COLLECTED_DATE.replaceAll("-", ""),
    byteSize: bytes.length, storedAt: new Date(Date.parse(COLLECTED_AT) + 60_000).toISOString(),
    rawRetentionExpiresAt: deriveRawRetentionExpiresAt({ policy: governance, sourceId: SOURCE_ID, retrievedAt: COLLECTED_AT }),
  };
  const review = {
    schemaVersion: 1, artifactKind: "kric-subway-timetable-review-admission", sourceId: SOURCE_ID,
    snapshotId: receipt.snapshotId, rawSha256, byteSize: bytes.length,
    decision: "APPROVED", approvedBy: "qa-reviewer", approvedAt: new Date(Date.parse(COLLECTED_AT) + 10 * 60_000).toISOString(),
  };
  const paths = {
    collectionPath: path.join(operation, "collection.json"),
    receiptPath: path.join(operation, "receipt.json"),
    reviewAdmissionPath: path.join(operation, "review-admission.json"),
  };
  await writeFile(paths.collectionPath, bytes);
  await writeFile(paths.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  await writeFile(paths.reviewAdmissionPath, `${JSON.stringify(review, null, 2)}\n`);
  return { root, paths, receipt, review, rawSha256 };
}

test("4호선 등록기는 승인 검토와 원본 receipt에 묶인 원장 행 하나를 정책 신선도로 등록한다(#862 3b)", async (t) => {
  const { root, paths, receipt, review, rawSha256 } = await fixture(t);
  const before = Object.fromEntries(await Promise.all(INPUTS.map(async (relative) => [relative, await readFile(path.join(root, relative))])));
  const previousLedger = JSON.parse(before[INPUTS[1]]);
  const previousHead = validateLineage(previousLedger).headsBySource[SOURCE_ID];

  await registerKricSubwayTimetable({ repositoryRoot: root, ...paths, expectedHeadSha: HEAD, gitRunner, now: NOW });

  const ledger = JSON.parse(await readFile(path.join(root, INPUTS[1]), "utf8"));
  assert.equal(ledger.length, previousLedger.length + 1);
  const row = ledger.at(-1);
  assert.equal(validateLineage(ledger).headsBySource[SOURCE_ID], receipt.snapshotId);
  assert.equal(row.snapshotId, receipt.snapshotId);
  assert.equal(row.previousSnapshotId, previousHead);
  assert.equal(row.rawSha256, rawSha256);
  assert.equal(row.rawObjectUri, receipt.rawObjectUri);
  assert.equal(row.retrievedAt, COLLECTED_AT);
  assert.equal(row.serviceEffectiveAt, COLLECTED_AT);
  assert.equal(row.serviceEffectiveUntil, undefined);
  assert.equal(row.rowCount, 458);
  assert.equal(row.credentialRedacted, true);
  assert.equal(row.licenseStatus, "PASS");
  assert.equal(row.freshnessExpiresAt, new Date(Date.parse(COLLECTED_AT) + 30 * 24 * 60 * 60 * 1_000).toISOString());
  assert.equal(row.rawRetentionExpiresAt, receipt.rawRetentionExpiresAt);
  assert.equal(row.governancePolicySha256, sha(before[INPUTS[2]]));
  const evidence = JSON.parse(await readFile(path.join(root, INPUTS[0]), "utf8")).sources.find(({ id }) => id === SOURCE_ID).admissionEvidence;
  assert.equal(evidence.snapshotId, receipt.snapshotId);
  assert.equal(evidence.rawSha256, rawSha256);
  assert.equal(evidence.approvedBy, review.approvedBy);
  assert.equal(evidence.approvedAt, review.approvedAt);
  assert.equal(evidence.adminReviewRecordHash, sha(await readFile(paths.reviewAdmissionPath)));
  assert.deepEqual(await readFile(path.join(root, INPUTS[2])), before[INPUTS[2]]);
  assert.deepEqual(await readFile(path.join(root, INPUTS[3])), before[INPUTS[3]]);
});

test("4호선 등록기는 승인 없음·다른 원본·receipt 불일치·HEAD 불일치를 쓰기 전에 거부한다(#862 3b)", async (t) => {
  const { root, paths, review, receipt } = await fixture(t);
  const ledgerBytes = await readFile(path.join(root, INPUTS[1]));
  const register = (overrides = {}) => registerKricSubwayTimetable({ repositoryRoot: root, ...paths, expectedHeadSha: HEAD, gitRunner, now: NOW, ...overrides });

  await assert.rejects(register({ expectedHeadSha: "f".repeat(40) }), /execution HEAD mismatch/);
  for (const change of [{ decision: "PENDING" }, { approvedBy: "" }, { rawSha256: "0".repeat(64) }, { approvedAt: new Date(Date.parse(COLLECTED_AT) - 60_000).toISOString() }]) {
    await writeFile(paths.reviewAdmissionPath, `${JSON.stringify({ ...review, ...change }, null, 2)}\n`);
    await assert.rejects(register(), /review admission is invalid/);
  }
  await writeFile(paths.reviewAdmissionPath, `${JSON.stringify(review, null, 2)}\n`);
  await writeFile(paths.receiptPath, `${JSON.stringify({ ...receipt, rawObjectSha256: "0".repeat(64) }, null, 2)}\n`);
  await assert.rejects(register(), /raw receipt is invalid/);
  assert.deepEqual(await readFile(path.join(root, INPUTS[1])), ledgerBytes);
});
