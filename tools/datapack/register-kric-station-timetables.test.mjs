import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import test from "node:test";

import { collectKricStationTimetables } from "./collect-kric-station-timetables.mjs";
import { KRIC_API_STATION_TIMETABLE_BINDINGS } from "./lib/kric-station-timetable-api-trips.mjs";
import { HOLIDAY_INCLUDES_SATURDAY_POLICY } from "./lib/kric-station-row-timetable-trips.mjs";
import { STATION_LINES_SOURCE_ID, registerKricStationTimetables } from "./register-kric-station-timetables.mjs";
import { syntheticExpectedObservation, syntheticKricStationFetch } from "./test-fixtures/kric-station-timetable-synthetic.mjs";
import { deriveRawRetentionExpiresAt } from "./source-governance-policy.mjs";
import { validateLineage } from "./source-snapshot-policy.mjs";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");
const PILOT_SOURCE_ID = "kric-subway-timetable";
const HEAD = "e".repeat(40);
const OUTPUTS = [
  "tools/datapack/source-inventory.json",
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/source-governance-policy.json",
  "release/product-gates/datapack-freshness-sla.json",
];
const INPUTS = [...OUTPUTS, "tools/datapack/source-candidates.json", "release/product-gates/production-datapack-scope.json"];
const COLLECTED_START = Date.parse("2026-10-03T03:00:00.000Z");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const gitRunner = async (args) => (args[0] === "rev-parse" ? `${HEAD}\n` : "");
const EXPECTED = syntheticExpectedObservation();

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "kric-station-register-repo-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of INPUTS) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await cp(path.join(REPOSITORY_ROOT, relative), path.join(root, relative));
  }
  return { root, ...(await inputSet(t, root, COLLECTED_START)) };
}

// 같은 저장소에 대해 collectedStart 시각의 수집본·receipt·admission·입력 파일 한 벌을 만든다.
async function inputSet(t, root, collectedStart) {
  const operation = await mkdtemp(path.join(os.tmpdir(), "kric-station-register-op-"));
  t.after(() => rm(operation, { recursive: true, force: true }));
  let tick = collectedStart;
  const artifact = await collectKricStationTimetables({ serviceKey: "test-key", fetchImpl: syntheticKricStationFetch(), now: () => new Date(tick += 1000) });
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  const rawSha256 = sha(bytes);
  const date = artifact.capturedAt.slice(0, 10).replaceAll("-", "");
  const governance = JSON.parse(await readFile(path.join(root, OUTPUTS[2]), "utf8"));
  const pilotEntry = governance.sources.find(({ sourceId }) => sourceId === PILOT_SOURCE_ID);
  const governanceEntry = { ...structuredClone(pilotEntry), sourceId: STATION_LINES_SOURCE_ID };
  const registered = governance.sources.some(({ sourceId }) => sourceId === STATION_LINES_SOURCE_ID);
  const projected = registered ? governance : { ...governance, sources: [...governance.sources, governanceEntry] };
  const objectKey = `source-raw/${STATION_LINES_SOURCE_ID}/${date}/${rawSha256}.json`;
  const receipt = {
    schemaVersion: 1, artifactKind: "kric-timetable-raw-object-receipt", sourceId: STATION_LINES_SOURCE_ID,
    snapshotId: `${STATION_LINES_SOURCE_ID}-${date}`, capturedAt: artifact.capturedAt, collectedAt: artifact.collectedAt,
    rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/${objectKey}`, rawObjectSha256: rawSha256,
    ociNamespace: "axvym6vk8g7i", bucket: "easysubway-datapacks", objectKey, capturedDate: date, byteSize: bytes.length,
    storedAt: new Date(Date.parse(artifact.collectedAt) + 60_000).toISOString(),
    rawRetentionExpiresAt: deriveRawRetentionExpiresAt({ policy: projected, sourceId: STATION_LINES_SOURCE_ID, retrievedAt: artifact.collectedAt }),
  };
  const review = {
    schemaVersion: 1, artifactKind: "kric-subway-timetable-review-admission", sourceId: STATION_LINES_SOURCE_ID,
    snapshotId: receipt.snapshotId, rawSha256, byteSize: bytes.length, decision: "APPROVED", approvedBy: "data-release-authority",
    approvedAt: new Date(Date.parse(artifact.collectedAt) + 120_000).toISOString(),
  };
  const files = {
    collectionPath: path.join(operation, "collection.json"), receiptPath: path.join(operation, "receipt.json"),
    reviewAdmissionPath: path.join(operation, "review-admission.json"), sourceInputPath: path.join(operation, "input.json"),
  };
  await writeFile(files.collectionPath, bytes);
  await writeFile(files.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  await writeFile(files.reviewAdmissionPath, `${JSON.stringify(review, null, 2)}\n`);
  const input = { schemaVersion: 1, artifactKind: "kric-station-timetable-registration-input",
    collectionPath: files.collectionPath, receiptPath: files.receiptPath, reviewAdmissionPath: files.reviewAdmissionPath, governanceEntry };
  await writeFile(files.sourceInputPath, `${JSON.stringify(input, null, 2)}\n`);
  const now = new Date(Date.parse(artifact.collectedAt) + 10 * 60_000);
  return { files, input, receipt, review, rawSha256, artifact, governanceEntry, now };
}

const snapshotOf = async (root) => Object.fromEntries(await Promise.all(INPUTS.map(async (relative) => [relative, await readFile(path.join(root, relative))])));

test("첫 등록은 새 sourceId 원장 행·inventory·정책 항목·파생 스냅샷을 만들고 4호선 pilot 행은 그대로 둔다", async (t) => {
  const { root, files, receipt, review, rawSha256, governanceEntry, now } = await fixture(t);
  const before = await snapshotOf(root);
  await registerKricStationTimetables({ repositoryRoot: root, sourceInputPath: files.sourceInputPath, expectedHeadSha: HEAD, gitRunner, now, expected: EXPECTED });

  const ledger = JSON.parse(await readFile(path.join(root, OUTPUTS[1]), "utf8"));
  const previousLedger = JSON.parse(before[OUTPUTS[1]]);
  assert.equal(ledger.length, previousLedger.length + 1);
  assert.deepEqual(ledger.slice(0, -1), previousLedger);
  const heads = validateLineage(ledger).headsBySource;
  assert.equal(heads[STATION_LINES_SOURCE_ID], receipt.snapshotId);
  const row = ledger.at(-1);
  assert.equal(row.sourceId, STATION_LINES_SOURCE_ID);
  assert.equal(row.previousSnapshotId, null);
  assert.equal(row.rawSha256, rawSha256);
  assert.equal(row.rawObjectUri, receipt.rawObjectUri);
  assert.equal(row.coverageCount, 12);
  assert.equal(row.rowCount, 70 * 2);
  assert.equal(row.freshnessExpiresAt, new Date(Date.parse(receipt.collectedAt) + 30 * 24 * 60 * 60 * 1_000).toISOString());
  assert.equal(row.rawRetentionExpiresAt, receipt.rawRetentionExpiresAt);

  const governance = JSON.parse(await readFile(path.join(root, OUTPUTS[2]), "utf8"));
  assert.deepEqual(governance.sources.filter(({ sourceId }) => sourceId === STATION_LINES_SOURCE_ID), [governanceEntry]);
  const freshness = JSON.parse(await readFile(path.join(root, OUTPUTS[3]), "utf8"));
  const planned = freshness.sourceClasses.find(({ id }) => id === "planned_timetable");
  assert.ok(planned.sourceIds.includes(STATION_LINES_SOURCE_ID) && planned.sourceIds.includes(PILOT_SOURCE_ID));

  const inventory = JSON.parse(await readFile(path.join(root, OUTPUTS[0]), "utf8"));
  const source = inventory.sources.find(({ id }) => id === STATION_LINES_SOURCE_ID);
  const pilot = inventory.sources.find(({ id }) => id === PILOT_SOURCE_ID);
  assert.deepEqual(pilot, JSON.parse(before[OUTPUTS[0]]).sources.find(({ id }) => id === PILOT_SOURCE_ID));
  assert.deepEqual(source.license, pilot.license);
  assert.deepEqual(source.coverageScope.lineIds, KRIC_API_STATION_TIMETABLE_BINDINGS.map(({ lineId }) => lineId));
  assert.equal(source.admissionEvidence.snapshotId, receipt.snapshotId);
  assert.equal(source.admissionEvidence.approvedBy, review.approvedBy);
  assert.equal(source.admissionEvidence.licenseEvidenceHash, governanceEntry.licenseReview.termsHash);
  assert.equal(source.admissionEvidence.adminReviewRecordHash, sha(await readFile(files.reviewAdmissionPath)));
  assert.equal(source.admissionEvidence.catalogProviderId, "provider:kric-subway-timetable");
  const evidence = source.scheduleAdmissionEvidence;
  assert.equal(evidence.tripCount, 12);
  const snapshot = JSON.parse(await readFile(path.join(root, evidence.snapshotPath), "utf8"));
  assert.equal(snapshot.snapshotId, receipt.snapshotId);
  assert.equal(sha(JSON.stringify(snapshot.trips)), evidence.tripsSha256);
  assert.equal(snapshot.serviceDayPolicy, HOLIDAY_INCLUDES_SATURDAY_POLICY);
  assert.deepEqual(snapshot.lines.map(({ lnCd, lineId, stationCodes, rowCountByDayCd, tripCount }) => [lnCd, lineId, stationCodes, rowCountByDayCd, tripCount]),
    KRIC_API_STATION_TIMETABLE_BINDINGS.map(({ lnCd, lineId, stations, segments }) => [lnCd, lineId, stations.map(([, stinCd]) => stinCd), { 7: 0, 8: stations.length, 9: stations.length }, segments.length * 2]));
  // 역 코드는 개수가 아니라 값으로 고정한다(GTX-A roster 순서).
  assert.deepEqual(snapshot.lines[0].stationCodes, ["X108", "X109", "X110", "X111", "X106", "X105", "X103", "X102", "X101"]);
});

test("다른 약관(termsHash·데이터셋)·미승인 검토·receipt 불일치·수집 결손·HEAD 불일치는 쓰기 전에 거부한다", async (t) => {
  const { root, files, input, review, receipt, artifact, now } = await fixture(t);
  const before = await snapshotOf(root);
  const register = () => registerKricStationTimetables({ repositoryRoot: root, sourceInputPath: files.sourceInputPath, expectedHeadSha: HEAD, gitRunner, now, expected: EXPECTED });
  const writeInput = (value) => writeFile(files.sourceInputPath, `${JSON.stringify(value, null, 2)}\n`);

  await assert.rejects(registerKricStationTimetables({ repositoryRoot: root, sourceInputPath: files.sourceInputPath, expectedHeadSha: "f".repeat(40), gitRunner, now, expected: EXPECTED }), /HEAD_MISMATCH/u);
  for (const licenseChange of [{ termsHash: "0".repeat(64) }, { reviewedDatasetUrl: "https://data.kric.go.kr/rips/M_01_02/detail.do?id=999" }]) {
    await writeInput({ ...input, governanceEntry: { ...input.governanceEntry, licenseReview: { ...input.governanceEntry.licenseReview, ...licenseChange } } });
    await assert.rejects(register(), /GOVERNANCE_TERMS_MISMATCH/u);
  }
  await writeInput(input);
  for (const change of [{ decision: "PENDING" }, { approvedBy: "" }, { rawSha256: "0".repeat(64) }]) {
    await writeFile(files.reviewAdmissionPath, `${JSON.stringify({ ...review, ...change }, null, 2)}\n`);
    await assert.rejects(register(), /REVIEW_ADMISSION/u);
  }
  await writeFile(files.reviewAdmissionPath, `${JSON.stringify(review, null, 2)}\n`);
  await writeFile(files.receiptPath, `${JSON.stringify({ ...receipt, rawObjectSha256: "0".repeat(64) }, null, 2)}\n`);
  await assert.rejects(register(), /RAW_RECEIPT/u);
  const partial = { ...artifact, responses: artifact.responses.slice(1) };
  await writeFile(files.collectionPath, `${JSON.stringify(partial, null, 2)}\n`);
  await assert.rejects(register(), /STATION_RESPONSE_MISSING/u);
  assert.deepEqual(await snapshotOf(root), before);
});

test("등록 결과는 scope 필수 원천에 새 id를 함께 올릴 때 inventory·정책·admission 검증기를 통과하고, 빠뜨리면 실패한다", async (t) => {
  const { root, files, now } = await fixture(t);
  await registerKricStationTimetables({ repositoryRoot: root, sourceInputPath: files.sourceInputPath, expectedHeadSha: HEAD, gitRunner, now, expected: EXPECTED });
  const scopePath = path.join(root, "release/product-gates/production-datapack-scope.json");
  const validate = () => promisify(execFile)(process.execPath, [path.join(REPOSITORY_ROOT, "tools/datapack/validate-source-inventory.mjs"),
    "--inventory", path.join(root, OUTPUTS[0]), "--candidates", path.join(root, "tools/datapack/source-candidates.json"), "--scope", scopePath,
    "--governance-policy", path.join(root, OUTPUTS[2]), "--freshness-policy", path.join(root, OUTPUTS[3])], { cwd: REPOSITORY_ROOT });
  await assert.rejects(validate(), /kric-subway-timetable-station-lines\.requiredForProductionPack must match productionSourceSet\.requiredSourceIds/u);
  const scope = JSON.parse(await readFile(scopePath, "utf8"));
  scope.productionSourceSet.requiredSourceIds = [...scope.productionSourceSet.requiredSourceIds, STATION_LINES_SOURCE_ID];
  await writeFile(scopePath, `${JSON.stringify(scope, null, 2)}\n`);
  await validate();
});

test("수집본의 노선 목록·역 집합이 고정 바인딩과 다르면 COLLECTION_LINES로 거부한다", async (t) => {
  const { root, files, artifact, now } = await fixture(t);
  const before = await snapshotOf(root);
  const register = () => registerKricStationTimetables({ repositoryRoot: root, sourceInputPath: files.sourceInputPath, expectedHeadSha: HEAD, gitRunner, now, expected: EXPECTED });
  for (const mutate of [
    (value) => { value.lines[0].stations[0].stinNm = "다른역"; },
    (value) => { value.lines[1].stations.pop(); },
    (value) => { value.lines[2].lineId = "line-other"; },
    (value) => { value.lines.pop(); },
  ]) {
    const changed = structuredClone(artifact);
    mutate(changed);
    await writeFile(files.collectionPath, `${JSON.stringify(changed, null, 2)}\n`);
    await assert.rejects(register(), /KRIC_STATION_REGISTRATION_COLLECTION_LINES/u);
  }
  assert.deepEqual(await snapshotOf(root), before);
});

test("후속 등록은 원장에 한 행만 덧붙여 이전 head를 잇고, 정책 항목은 그대로 두며 inventory 항목을 제자리에서 바꾼다", async (t) => {
  const { root, files, receipt, now } = await fixture(t);
  await registerKricStationTimetables({ repositoryRoot: root, sourceInputPath: files.sourceInputPath, expectedHeadSha: HEAD, gitRunner, now, expected: EXPECTED });
  const afterFirst = await snapshotOf(root);
  const next = await inputSet(t, root, COLLECTED_START + 24 * 60 * 60 * 1000);
  await registerKricStationTimetables({ repositoryRoot: root, sourceInputPath: next.files.sourceInputPath, expectedHeadSha: HEAD, gitRunner, now: next.now, expected: EXPECTED });
  const ledger = JSON.parse(await readFile(path.join(root, OUTPUTS[1]), "utf8"));
  const firstLedger = JSON.parse(afterFirst[OUTPUTS[1]]);
  assert.deepEqual(ledger.slice(0, -1), firstLedger);
  const row = ledger.at(-1);
  assert.equal(row.snapshotId, next.receipt.snapshotId);
  assert.equal(row.previousSnapshotId, receipt.snapshotId);
  assert.ok(row.diffSummary && typeof row.diffSummary === "object");
  assert.deepEqual(await readFile(path.join(root, OUTPUTS[2])), afterFirst[OUTPUTS[2]]);
  assert.deepEqual(await readFile(path.join(root, OUTPUTS[3])), afterFirst[OUTPUTS[3]]);
  const sources = JSON.parse(await readFile(path.join(root, OUTPUTS[0]), "utf8")).sources.filter(({ id }) => id === STATION_LINES_SOURCE_ID);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].admissionEvidence.snapshotId, next.receipt.snapshotId);
});

test("같은 스냅샷 재등록은 SNAPSHOT_COLLISION, 원장·inventory·정책 상태가 어긋나면 SUCCESSOR_STATE로 쓰기 전에 거부한다", async (t) => {
  const { root, files, now } = await fixture(t);
  const register = (input = files.sourceInputPath) => registerKricStationTimetables({ repositoryRoot: root, sourceInputPath: input, expectedHeadSha: HEAD, gitRunner, now, expected: EXPECTED });
  await register();
  const registered = await snapshotOf(root);
  await assert.rejects(register(), /KRIC_STATION_REGISTRATION_SNAPSHOT_COLLISION/u);
  const next = await inputSet(t, root, COLLECTED_START + 24 * 60 * 60 * 1000);
  const registerNext = () => registerKricStationTimetables({ repositoryRoot: root, sourceInputPath: next.files.sourceInputPath, expectedHeadSha: HEAD, gitRunner, now: next.now, expected: EXPECTED });
  const rewrite = async (relative, change) => {
    const value = JSON.parse(registered[relative]);
    change(value);
    await writeFile(path.join(root, relative), `${JSON.stringify(value, null, 2)}\n`);
  };
  const restore = async () => { for (const relative of OUTPUTS) await writeFile(path.join(root, relative), registered[relative]); };
  // 원장 head는 있는데 inventory 항목이 없다.
  await rewrite(OUTPUTS[0], (value) => { value.sources = value.sources.filter(({ id }) => id !== STATION_LINES_SOURCE_ID); });
  await assert.rejects(registerNext(), /KRIC_STATION_REGISTRATION_SUCCESSOR_STATE/u);
  await restore();
  // 원장 head는 있는데 governance 항목이 없다.
  await rewrite(OUTPUTS[2], (value) => { value.sources = value.sources.filter(({ sourceId }) => sourceId !== STATION_LINES_SOURCE_ID); });
  await assert.rejects(registerNext(), /KRIC_STATION_REGISTRATION_SUCCESSOR_STATE/u);
  await restore();
  // governance 항목이 두 개다.
  await rewrite(OUTPUTS[2], (value) => { value.sources.push(structuredClone(value.sources.find(({ sourceId }) => sourceId === STATION_LINES_SOURCE_ID))); });
  await assert.rejects(registerNext(), /KRIC_STATION_REGISTRATION_SUCCESSOR_STATE/u);
  await restore();
  // 원장 head가 없는데 inventory 항목만 있다(원장에서 새 원천 행 제거).
  await rewrite(OUTPUTS[1], (value) => { value.splice(value.findIndex(({ sourceId }) => sourceId === STATION_LINES_SOURCE_ID), 1); });
  await assert.rejects(registerNext(), /KRIC_STATION_REGISTRATION_SUCCESSOR_STATE/u);
  await restore();
  assert.deepEqual(await snapshotOf(root), registered);
});

test("candidate의 노선 목록·카탈로그 provider가 고정 바인딩과 다르면 CANDIDATE로 거부한다", async (t) => {
  const { root, files, now } = await fixture(t);
  const candidatesPath = path.join(root, "tools/datapack/source-candidates.json");
  const original = await readFile(candidatesPath);
  const before = await snapshotOf(root);
  const register = () => registerKricStationTimetables({ repositoryRoot: root, sourceInputPath: files.sourceInputPath, expectedHeadSha: HEAD, gitRunner, now, expected: EXPECTED });
  for (const change of [
    (candidate) => { candidate.coverageScope.lineIds = candidate.coverageScope.lineIds.slice(1); },
    (candidate) => { candidate.coverageScope.lineIds = [...candidate.coverageScope.lineIds].reverse(); },
    (candidate) => { candidate.coverageScope.lineIds = [...candidate.coverageScope.lineIds, "line-other"]; },
    (candidate) => { candidate.catalogProviderId = "provider:kric-station-timetable"; },
  ]) {
    const document = JSON.parse(original);
    change(document.candidates.find(({ id }) => id === STATION_LINES_SOURCE_ID));
    await writeFile(candidatesPath, `${JSON.stringify(document, null, 2)}\n`);
    await assert.rejects(register(), /KRIC_STATION_REGISTRATION_CANDIDATE/u);
  }
  await writeFile(candidatesPath, original);
  assert.deepEqual(await snapshotOf(root), before);
});
