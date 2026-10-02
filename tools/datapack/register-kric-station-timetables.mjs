#!/usr/bin/env node
// #903: kric-subway-timetable-station-lines 원장 등록기.
// 역별 수집기(collect-kric-station-timetables.mjs) 수집본, OCI 원본 게시 receipt, 명시적 검토 admission 파일을 받아
// 원장 행·inventory·정책 항목(governance·freshness)·파생 스냅샷을 한 트랜잭션으로 등록한다.
// 검토 admission과 governance 항목은 이 도구가 만들지 않는다(입력 파일로만 받는다).
// 같은 KRIC OpenAPI 데이터셋(id=162)·같은 이용약관임을 기존 kric-subway-timetable governance 항목과 비교해 고정한다.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";

import { responsesFromCollection } from "./collect-kric-station-timetables.mjs";
import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";
import { KRIC_API_EXPECTED_OBSERVATION, KRIC_API_STATION_TIMETABLE_BINDINGS, assertExpectedApiObservation, buildApiStationTimetableTrips } from "./lib/kric-station-timetable-api-trips.mjs";
import { HOLIDAY_INCLUDES_SATURDAY_POLICY } from "./lib/kric-station-row-timetable-trips.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { createSourceRegistrationTransaction, SOURCE_REGISTRATION_OUTPUTS } from "./lib/source-registration-transaction.mjs";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";
import { buildAppendOnlyGovernancePolicyRegistration, deriveRawRetentionExpiresAt, validateSourceGovernancePolicy } from "./source-governance-policy.mjs";
import { buildSnapshotDiff, validateLineage } from "./source-snapshot-policy.mjs";

export const STATION_LINES_SOURCE_ID = "kric-subway-timetable-station-lines";
const TERMS_SOURCE_ID = "kric-subway-timetable";
const CATALOG_PROVIDER_ID = "provider:kric-subway-timetable";
const FRESHNESS_CLASS_ID = "planned_timetable";
const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUTPUTS = SOURCE_REGISTRATION_OUTPUTS;
const OCI_NAMESPACE = "axvym6vk8g7i";
const OCI_BUCKET = "easysubway-datapacks";
const INPUT_KEYS = Object.freeze(["schemaVersion", "artifactKind", "collectionPath", "receiptPath", "reviewAdmissionPath", "governanceEntry"]);
const RECEIPT_KEYS = Object.freeze([
  "schemaVersion", "artifactKind", "sourceId", "snapshotId", "capturedAt", "collectedAt", "rawObjectUri",
  "rawObjectSha256", "ociNamespace", "bucket", "objectKey", "capturedDate", "byteSize", "storedAt", "rawRetentionExpiresAt",
]);
const REVIEW_KEYS = Object.freeze([
  "schemaVersion", "artifactKind", "sourceId", "snapshotId", "rawSha256", "byteSize", "decision", "approvedBy", "approvedAt",
]);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const fail = (code) => { throw new Error(`KRIC_STATION_REGISTRATION_${code}`); };
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const instant = (value) => { try { return requiredUtcInstant(value, "instant"); } catch { return Number.NaN; } };
const parse = (bytes, code) => { try { return JSON.parse(bytes.toString("utf8")); } catch { return fail(code); } };

async function externalFile(file, code, root) {
  if (!path.isAbsolute(file ?? "")) fail(`${code}_PATH`);
  const resolved = path.resolve(file);
  if (resolved.startsWith(`${root}${path.sep}`)) fail(`${code}_INSIDE_REPOSITORY`);
  const stat = await lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${code}_PATH`);
  return { absolute: resolved, bytes: await readFile(resolved) };
}

export async function buildKricStationTimetableRegistrationOutputs({ repositoryRoot = ROOT, sourceInputPath, now = new Date(), expected = KRIC_API_EXPECTED_OBSERVATION } = {}) {
  const root = path.resolve(repositoryRoot);
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) fail("TIME");
  const currentBytes = await Promise.all(OUTPUTS.map((relative) => readFile(path.join(root, relative))));
  const [inventory, ledger, governance, freshnessBase] = currentBytes.map((bytes, index) => parse(bytes, `OUTPUT_${index}`));
  const candidates = parse(await readFile(path.join(root, "tools/datapack/source-candidates.json")), "CANDIDATES");
  const inputFile = await externalFile(sourceInputPath, "SOURCE_INPUT", root);
  const input = parse(inputFile.bytes, "SOURCE_INPUT");
  if (!exactKeys(input, INPUT_KEYS) || input.schemaVersion !== 1 || input.artifactKind !== "kric-station-timetable-registration-input") fail("SOURCE_INPUT");
  const collectionFile = await externalFile(input.collectionPath, "COLLECTION", root);
  const receiptFile = await externalFile(input.receiptPath, "RAW_RECEIPT", root);
  const reviewFile = await externalFile(input.reviewAdmissionPath, "REVIEW_ADMISSION", root);

  // 1. 수집본 재구성: 고정 바인딩의 노선·역 집합 전부와 요일코드별 응답이 있어야 한다(실패는 lib 오류 그대로).
  const artifact = parse(collectionFile.bytes, "COLLECTION");
  const responses = responsesFromCollection(artifact);
  const reconstruction = buildApiStationTimetableTrips({ responses });
  // 수집기와 같은 고정 기대값을 다시 확인한다(제공처 변경은 기대값 갱신 PR 없이 등록되지 않는다).
  assertExpectedApiObservation(reconstruction, { expected });
  if (!isDeepStrictEqual(artifact.lines, KRIC_API_STATION_TIMETABLE_BINDINGS.map(({ mreaWideCd, lnCd, lineId, stations }) => ({ mreaWideCd, lnCd, lineId,
    stations: stations.map(([railOprIsttCd, stinCd, stinNm]) => ({ railOprIsttCd, stinCd, stinNm })) })))) fail("COLLECTION_LINES");
  const rawSha256 = sha(collectionFile.bytes);
  const capturedDate = artifact.capturedAt.slice(0, 10).replaceAll("-", "");
  const snapshotId = `${STATION_LINES_SOURCE_ID}-${capturedDate}`;

  // 2. 같은 약관 결속: 기존 kric-subway-timetable governance 항목과 sourceId 외 전부 같아야 한다.
  const termsEntry = governance.sources?.find(({ sourceId }) => sourceId === TERMS_SOURCE_ID);
  const governanceEntry = input.governanceEntry;
  if (!termsEntry || governanceEntry?.sourceId !== STATION_LINES_SOURCE_ID
    || canonicalJson({ ...governanceEntry, sourceId: TERMS_SOURCE_ID }) !== canonicalJson(termsEntry)) fail("GOVERNANCE_TERMS_MISMATCH");
  if (!(Date.parse(governanceEntry.licenseReview?.nextReviewAt ?? "") > now.valueOf())) fail("GOVERNANCE_REVIEW_EXPIRED");

  const previousSource = inventory.sources.find(({ id }) => id === STATION_LINES_SOURCE_ID) ?? null;
  const heads = validateLineage(ledger).headsBySource;
  const previousHead = heads[STATION_LINES_SOURCE_ID] ? ledger.find(({ snapshotId: id }) => id === heads[STATION_LINES_SOURCE_ID]) : null;
  const existingEntries = governance.sources.filter(({ sourceId }) => sourceId === STATION_LINES_SOURCE_ID);
  if ((previousSource === null) !== (previousHead === null) || existingEntries.length !== (previousHead ? 1 : 0)
    || (existingEntries.length === 1 && canonicalJson(existingEntries[0]) !== canonicalJson(governanceEntry))) fail("SUCCESSOR_STATE");
  if (ledger.some(({ snapshotId: id }) => id === snapshotId)) fail("SNAPSHOT_COLLISION");
  const registration = previousHead
    ? { policy: governance }
    : buildAppendOnlyGovernancePolicyRegistration({ predecessorPolicyBytes: currentBytes[2], addedSources: [structuredClone(governanceEntry)] });
  const freshness = structuredClone(freshnessBase);
  const freshnessClass = freshness.sourceClasses.filter(({ id }) => id === FRESHNESS_CLASS_ID);
  if (freshnessClass.length !== 1 || !freshnessClass[0].sourceIds.includes(TERMS_SOURCE_ID)
    || freshnessClass[0].sourceIds.includes(STATION_LINES_SOURCE_ID) !== (previousHead !== null)
    || governanceEntry.sourceClassId !== FRESHNESS_CLASS_ID || freshnessClass[0].basisField !== "serviceEffectiveAt") fail("FRESHNESS_CLASS");
  if (!previousHead) freshnessClass[0].sourceIds = [...freshnessClass[0].sourceIds, STATION_LINES_SOURCE_ID].sort();

  // 3. 원본 게시 receipt와 검토 admission(명시 입력).
  const receipt = parse(receiptFile.bytes, "RAW_RECEIPT");
  const objectKey = `source-raw/${STATION_LINES_SOURCE_ID}/${capturedDate}/${rawSha256}.json`;
  const rawRetentionExpiresAt = deriveRawRetentionExpiresAt({ policy: registration.policy, sourceId: STATION_LINES_SOURCE_ID, retrievedAt: artifact.collectedAt });
  const storedAt = instant(receipt?.storedAt);
  if (!exactKeys(receipt, RECEIPT_KEYS) || receipt.schemaVersion !== 1 || receipt.artifactKind !== "kric-timetable-raw-object-receipt"
    || receipt.sourceId !== STATION_LINES_SOURCE_ID || receipt.snapshotId !== snapshotId
    || receipt.capturedAt !== artifact.capturedAt || receipt.collectedAt !== artifact.collectedAt
    || receipt.rawObjectSha256 !== rawSha256 || receipt.byteSize !== collectionFile.bytes.length
    || receipt.ociNamespace !== OCI_NAMESPACE || receipt.bucket !== OCI_BUCKET || receipt.objectKey !== objectKey
    || receipt.capturedDate !== capturedDate || receipt.rawObjectUri !== `oci://${OCI_NAMESPACE}/${OCI_BUCKET}/${objectKey}`
    || !(storedAt >= instant(artifact.collectedAt)) || !(storedAt <= now.valueOf())
    || receipt.rawRetentionExpiresAt !== rawRetentionExpiresAt || !(instant(rawRetentionExpiresAt) > now.valueOf())) fail("RAW_RECEIPT");
  const review = parse(reviewFile.bytes, "REVIEW_ADMISSION");
  const approvedAt = instant(review?.approvedAt);
  if (!exactKeys(review, REVIEW_KEYS) || review.schemaVersion !== 1 || review.artifactKind !== "kric-subway-timetable-review-admission"
    || review.sourceId !== STATION_LINES_SOURCE_ID || review.snapshotId !== snapshotId || review.rawSha256 !== rawSha256
    || review.byteSize !== collectionFile.bytes.length || review.decision !== "APPROVED"
    || typeof review.approvedBy !== "string" || review.approvedBy.trim() === ""
    || !(approvedAt >= instant(artifact.collectedAt)) || !(approvedAt <= now.valueOf())) fail("REVIEW_ADMISSION");

  // 4. 파생 스냅샷: 노선 목록·역 집합·요일코드별 행 수를 결속한다.
  const lines = KRIC_API_STATION_TIMETABLE_BINDINGS.map(({ lnCd, lineId, stations }) => {
    const lineResponses = responses.filter((response) => response.lnCd === lnCd);
    const rowCountByDayCd = Object.fromEntries(["7", "8", "9"].map((dayCd) => [dayCd,
      lineResponses.filter((response) => response.dayCd === dayCd).reduce((sum, { rows }) => sum + rows.length, 0)]));
    return { lnCd, lineId, stationCodes: stations.map(([, stinCd]) => stinCd), rowCountByDayCd,
      tripCount: reconstruction.summary[lineId].trips, quarantinedCount: reconstruction.summary[lineId].quarantined };
  });
  const content = { schemaVersion: 1, artifactKind: "kric-station-timetable-snapshot", sourceId: STATION_LINES_SOURCE_ID,
    catalogProviderId: CATALOG_PROVIDER_ID, capturedAt: artifact.capturedAt, collectedAt: artifact.collectedAt,
    raw: { rawSha256, byteSize: collectionFile.bytes.length, rawObjectUri: receipt.rawObjectUri, publicationReceiptSha256: sha(receiptFile.bytes) },
    serviceDayPolicy: HOLIDAY_INCLUDES_SATURDAY_POLICY, lines, trips: reconstruction.trips, quarantine: reconstruction.quarantine };
  const contentSha256 = sha(canonicalJson(content));
  const snapshot = { ...content, snapshotId, contentSha256 };
  const snapshotRelative = `tools/datapack/sources/${snapshotId}.json`;
  const tripsSha256 = sha(JSON.stringify(reconstruction.trips));
  const stopTimeCount = reconstruction.trips.reduce((sum, { stops }) => sum + stops.length, 0);

  const freshnessExpiresAt = deriveFreshnessExpiresAt({ policy: freshness, sourceClassId: FRESHNESS_CLASS_ID,
    basisAt: artifact.collectedAt, evaluationAt: now.toISOString() });
  if (!(instant(freshnessExpiresAt) > now.valueOf())) fail("FRESHNESS_EXPIRED");
  const schemaFingerprint = sha(JSON.stringify([...new Set(responses.flatMap(({ rows }) => rows.flatMap((row) => Object.keys(row))))].sort()));
  const row = {
    schemaVersion: 1, artifactKind: "official-source-snapshot", snapshotId, sourceId: STATION_LINES_SOURCE_ID, provider: "국가철도공단",
    retrievedAt: artifact.collectedAt, sourceUpdatedAt: artifact.collectedAt, serviceEffectiveAt: artifact.collectedAt,
    rowCount: stopTimeCount, coverageCount: reconstruction.trips.length, rawSha256, contentSha256,
    rawObjectUri: receipt.rawObjectUri, rawObjectSha256: rawSha256, rawReceiptSha256: sha(receiptFile.bytes), byteSize: collectionFile.bytes.length,
    redactedRequestFingerprint: sha(JSON.stringify(artifact.responses.map(({ requestKey, bodySha256 }) => [requestKey, bodySha256]))),
    schemaFingerprint, snapshotStatus: "LOCKED", schemaStatus: "PASS", licenseStatus: "PASS", fetchStatus: "SUCCESS",
    redistributionAllowed: true, credentialRedacted: true, previousSnapshotId: previousHead?.snapshotId ?? null,
    freshnessExpiresAt, rawRetentionExpiresAt, rawReceipt: receipt,
    governancePolicyVersion: registration.policy.policyVersion, governancePolicySha256: sha(json(registration.policy)),
  };
  if (previousHead) row.diffSummary = buildSnapshotDiff(previousHead, row);
  const nextLedger = [...ledger, row];
  validateLineage(nextLedger);

  const candidate = candidates.candidates?.filter(({ id }) => id === STATION_LINES_SOURCE_ID) ?? [];
  const termsSource = inventory.sources.find(({ id }) => id === TERMS_SOURCE_ID);
  if (candidate.length !== 1 || candidate[0].catalogProviderId !== CATALOG_PROVIDER_ID
    || !isDeepStrictEqual(candidate[0].coverageScope?.lineIds, KRIC_API_STATION_TIMETABLE_BINDINGS.map(({ lineId }) => lineId))
    || !termsSource) fail("CANDIDATE");
  const source = {
    id: STATION_LINES_SOURCE_ID, displayName: candidate[0].displayName, owner: termsSource.owner, provider: termsSource.provider,
    providerDepartment: termsSource.providerDepartment, sourceSystem: termsSource.sourceSystem, datasetUrl: termsSource.datasetUrl,
    datasetKind: "open-api", coverage: candidate[0].evidence.coverage,
    coverageScope: { ...structuredClone(candidate[0].coverageScope), sourceDomains: ["schedule_timetable"] },
    requiredForProductionPack: true, productionUseAllowed: true, updateFrequency: termsSource.updateFrequency,
    observedDataUpdatedAt: artifact.collectedAt.slice(0, 10), retrievedAt: artifact.collectedAt.slice(0, 10),
    license: structuredClone(termsSource.license), fieldsProvided: ["service_calendar", "trip", "stop_time"],
    capabilities: { schedule: { status: "SUPPORTED", productionUseAllowed: true, coverageStatus: "KRIC_STATION_TIMETABLE_LINES",
      updateFrequency: termsSource.updateFrequency, unsupportedNotes: "Admission is limited to the lines bound in kric-station-timetable-api-trips." },
    realtime: structuredClone(termsSource.capabilities.realtime), facility: structuredClone(termsSource.capabilities.facility) },
    scheduleAdmissionEvidence: { issue: 903, materializer: "tools/datapack/lib/kric-station-timetable-api-trips.mjs",
      verificationTest: "tools/datapack/register-kric-station-timetables.test.mjs", snapshotId, snapshotPath: snapshotRelative,
      capturedAt: artifact.capturedAt, freshUntil: freshnessExpiresAt, lineIds: lines.map(({ lineId }) => lineId),
      tripCount: reconstruction.trips.length, stopTimeCount, rawSha256, tripsSha256, contentSha256 },
    admissionEvidence: { candidateId: STATION_LINES_SOURCE_ID, sourceId: STATION_LINES_SOURCE_ID, catalogProviderId: CATALOG_PROVIDER_ID,
      snapshotId, decision: review.decision, approvedBy: review.approvedBy, approvedAt: review.approvedAt, rawSha256, schemaFingerprint,
      adminReviewRecordHash: sha(reviewFile.bytes), licenseEvidenceHash: governanceEntry.licenseReview.termsHash },
  };
  const nextInventory = { ...inventory, sources: previousSource
    ? inventory.sources.map((entry) => (entry.id === STATION_LINES_SOURCE_ID ? source : entry))
    : [...inventory.sources, source] };
  validateSourceGovernancePolicy({ policy: registration.policy, inventory: nextInventory, freshnessPolicy: freshness });
  const snapshotBytes = json(snapshot);
  const inputs = [inputFile, collectionFile, receiptFile, reviewFile];
  const values = [json(nextInventory), json(nextLedger), json(registration.policy), json(freshness)];
  return { snapshot: { relative: snapshotRelative, bytes: snapshotBytes },
    outputs: OUTPUTS.map((relative, index) => ({ relative, bytes: values[index], prestateBytes: currentBytes[index], inputs })) };
}

const transaction = createSourceRegistrationTransaction({
  label: STATION_LINES_SOURCE_ID,
  validateOutputs(outputs) {
    const inputs = outputs?.[0]?.inputs;
    if (!Array.isArray(outputs) || !isDeepStrictEqual(outputs.map(({ relative }) => relative), [...OUTPUTS])
      || !Array.isArray(inputs) || inputs.length !== 4
      || outputs.some((output) => !Buffer.isBuffer(output.bytes) || !Buffer.isBuffer(output.prestateBytes) || output.inputs !== inputs)) fail("OUTPUTS");
  },
});

async function writeDerivedSnapshot(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  try { await writeFile(file, bytes, { flag: "wx" }); } catch (error) {
    if (error?.code !== "EEXIST" || !(await readFile(file)).equals(bytes)) fail("SNAPSHOT_WRITE");
  }
}

export async function registerKricStationTimetables({
  repositoryRoot = ROOT, sourceInputPath, expectedHeadSha, now = new Date(), expected = KRIC_API_EXPECTED_OBSERVATION,
  gitRunner = async (args, settings) => (await promisify(execFile)("git", args, settings)).stdout,
} = {}) {
  const root = path.resolve(repositoryRoot);
  if (!/^[a-f0-9]{40}$/u.test(expectedHeadSha ?? "") || String(await gitRunner(["rev-parse", "HEAD"], { cwd: root })).trim() !== expectedHeadSha) fail("HEAD_MISMATCH");
  await transaction.recover({ repositoryRoot: root });
  const { snapshot, outputs } = await buildKricStationTimetableRegistrationOutputs({ repositoryRoot: root, sourceInputPath, now, expected });
  await writeDerivedSnapshot(path.join(root, snapshot.relative), snapshot.bytes);
  return transaction.commit({ repositoryRoot: root, outputs });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const args = Object.fromEntries(Array.from({ length: argv.length / 2 }, (_, index) => [argv[index * 2], argv[index * 2 + 1]]));
  if (argv.length !== 4 || !args["--source-input"] || !args["--expected-head-sha"]) {
    console.error("usage: register-kric-station-timetables.mjs --source-input <absolute> --expected-head-sha <sha>");
    process.exitCode = 1;
  } else {
    registerKricStationTimetables({ sourceInputPath: args["--source-input"], expectedHeadSha: args["--expected-head-sha"] })
      .then(() => process.stdout.write(`${JSON.stringify({ sourceId: STATION_LINES_SOURCE_ID, status: "REGISTERED" })}\n`))
      .catch((error) => { console.error(error.message); process.exitCode = 1; });
  }
}
