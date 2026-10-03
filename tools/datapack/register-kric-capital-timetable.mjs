#!/usr/bin/env node
// #899: KRIC 전체_도시철도운행정보(파일 id 900) 수집본에서 수도권 정차 순서 명시 노선을 projection snapshot으로
// 커밋하고, inventory kric-nationwide-timetable-file.capitalScheduleAdmissionEvidence를 그 snapshot에 결속한다.
//
// 사용(원본 수집과 등록을 한 실행에서 한다, #911 F1):
//   node tools/datapack/register-kric-capital-timetable.mjs --operation-directory <absolute empty directory>
// 같은 원본(raw sha256)이면 기존 snapshot을 재사용하고 재확인 이력만 append한다(#870).
//
// 원천 행을 바꾸지 않는다. 노선 적재 검증(역 매칭·노선 trip·격리 상한)은 후보 생성(prepare)에서 다시 수행한다.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../lib/is-main-module.mjs";
import { codepointCompare } from "../lib/codepoint-compare.mjs";
import { buildKricNationwideTimetableObservation } from "./build-kric-nationwide-timetable-observation.mjs";
import { collectKricNationwideTimetableFile } from "./collect-kric-nationwide-timetable-file.mjs";
import {
  KRIC_CAPITAL_ROUTE_PROFILES,
  kricCapitalOfficialTimetable,
  projectKricCapitalTimetableSnapshot,
} from "./lib/kric-capital-timetable-records.mjs";
import { CAPITAL_TIMETABLE_EVIDENCE_KEY, CAPITAL_TIMETABLE_SOURCE_ID, validateReverificationHistory } from "./lib/capital-official-timetable.mjs";
import { RAW_PUBLICATION_MODE } from "./lib/same-raw-reverification.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const INVENTORY_PATH = "tools/datapack/source-inventory.json";
const TARGETS_PATH = "tools/datapack/nationwide-coverage-targets.json";
const jsonBytes = (value) => `${JSON.stringify(value, null, 2)}\n`;
const fail = (code) => { throw new Error(`KRIC_CAPITAL_TIMETABLE_REGISTRATION_${code}`); };
const MAX_OBSERVATION_AGE_MILLIS = 60 * 60 * 1_000;

/** 수집본 → snapshot·evidence 기본값(관측 시각·재확인 이력 제외). 파일을 쓰지 않는다. */
export async function buildKricCapitalTimetableRegistration({ workbookPath, receipt, inventory, targets, observe = buildKricNationwideTimetableObservation }) {
  const observation = await observe({ inputFile: workbookPath, receipt });
  const snapshot = projectKricCapitalTimetableSnapshot(observation);
  const { provider } = kricCapitalOfficialTimetable(snapshot, { observedAt: observation.observedAt });
  const lineIds = [...new Set(KRIC_CAPITAL_ROUTE_PROFILES.map(({ lineId }) => lineId))].sort(codepointCompare);
  const scopes = (targets.activeLineScopes ?? []).filter((scope) => scope.regionId === "capital" && lineIds.includes(scope.lineId));
  for (const lineId of lineIds) {
    if (!scopes.some((scope) => scope.lineId === lineId)) throw new Error(`capital timetable line is not an active capital line scope: ${lineId}`);
  }
  const sources = inventory.sources.filter(({ id }) => id === CAPITAL_TIMETABLE_SOURCE_ID);
  if (sources.length !== 1) throw new Error(`inventory source missing or ambiguous: ${CAPITAL_TIMETABLE_SOURCE_ID}`);
  const snapshotPath = `tools/datapack/sources/${snapshot.snapshotId}.json`;
  const evidenceTemplate = {
    issue: 899,
    materializer: "tools/datapack/lib/capital-official-timetable.mjs",
    verificationTest: "tools/datapack/capital-official-timetable.test.mjs",
    snapshotId: snapshot.snapshotId,
    snapshotPath,
    rawByteLength: snapshot.rawByteLength,
    rawSha256: snapshot.rawSha256,
    observationRecordsSha256: snapshot.observationRecordsSha256,
    recordsSha256: snapshot.recordsSha256,
    recordCount: snapshot.recordCount,
    routes: snapshot.routes,
    dataReferenceDateByLine: provider.dataReferenceDateByLine,
    coverageScope: {
      regionIds: ["capital"],
      operatorIds: [...new Set(scopes.map(({ operatorId }) => operatorId))].sort(codepointCompare),
      lineIds,
      sourceDomains: ["schedule_timetable"],
    },
  };
  return { snapshot, snapshotPath, evidenceTemplate, observedAt: observation.observedAt, previousEvidence: sources[0][CAPITAL_TIMETABLE_EVIDENCE_KEY] ?? null };
}

/**
 * #870: 등록 계획. 같은 원본(raw sha256)이면 기존 snapshot을 재사용하고(파일을 쓰지 않음) 재확인 이력만 append한다.
 * 원본이 다르거나 첫 등록이면 새 snapshot 파일을 쓴다. 재확인 이력은 append-only다.
 * - 같은 원본인데 records sha가 다르거나 기존 snapshot 파일 바이트가 다르면 실패한다.
 * - 새 관측 시각은 직전 관측보다 뒤여야 한다.
 */
export function planKricCapitalTimetableRegistration({ previousEvidence, snapshot, snapshotBytes, existingSnapshotBytes, observation, evidenceTemplate, now }) {
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) fail("CLOCK");
  // 관측 시각은 등록 시계보다 미래일 수 없고, 같은 실행의 수집(다운로드·파싱, 수 분)보다 오래될 수 없다.
  // 허용 범위 1시간: 18MB 다운로드·관측 파싱 실측 수 분에 느린 망·시계 오차 여유를 둔 값이다.
  const observedMillis = Date.parse(observation?.observedAt);
  if (!Number.isFinite(observedMillis) || observedMillis > now.valueOf() || now.valueOf() - observedMillis > MAX_OBSERVATION_AGE_MILLIS) fail("OBSERVATION_CLOCK");
  const entry = { observedAt: observation?.observedAt, rawSha256: snapshot?.rawSha256, collectionReceiptSha256: observation?.collectionReceiptSha256 };
  const previousHistory = previousEvidence ? previousEvidence.reverifications : [];
  if (previousEvidence) {
    validateReverificationHistory(previousHistory);
    const last = previousHistory.at(-1);
    if (last.observedAt !== previousEvidence.observedAt || last.rawSha256 !== previousEvidence.rawSha256) fail("REVERIFICATIONS");
    if (!(Date.parse(entry.observedAt) > Date.parse(previousEvidence.observedAt))) fail("OBSERVATION_ORDER");
  }
  const reverifications = [...previousHistory, entry];
  validateReverificationHistory(reverifications);
  assertAppendOnlyReverifications(previousHistory, reverifications);
  const evidence = { ...evidenceTemplate, observedAt: entry.observedAt, reverifications };
  if (previousEvidence && previousEvidence.rawSha256 === snapshot.rawSha256) {
    if (previousEvidence.recordsSha256 !== snapshot.recordsSha256 || previousEvidence.snapshotId !== snapshot.snapshotId) fail("RECORDS_MISMATCH");
    if (!Buffer.isBuffer(existingSnapshotBytes) || !existingSnapshotBytes.equals(snapshotBytes)) fail("SNAPSHOT_MISMATCH");
    return { mode: RAW_PUBLICATION_MODE.REVERIFY_EXISTING, writeSnapshot: false, evidence };
  }
  // #911 F3: 원본이 이전 snapshot으로 돌아오면(A → B → A) 같은 id의 파일이 이미 있다. 바이트가 같을 때만 재사용한다.
  if (existingSnapshotBytes != null) {
    if (!Buffer.isBuffer(existingSnapshotBytes) || !existingSnapshotBytes.equals(snapshotBytes)) fail("SNAPSHOT_MISMATCH");
    return { mode: RAW_PUBLICATION_MODE.PUBLISH_NEW, writeSnapshot: false, evidence };
  }
  return { mode: RAW_PUBLICATION_MODE.PUBLISH_NEW, writeSnapshot: true, evidence };
}

/** 재확인 이력은 append-only다: 기존 항목을 그대로 두고 뒤에 항목을 하나 이상 붙여야 한다. */
export function assertAppendOnlyReverifications(previous, next) {
  if (!Array.isArray(previous) || !Array.isArray(next) || next.length <= previous.length
    || previous.some((entry, index) => JSON.stringify(entry) !== JSON.stringify(next[index]))) fail("REVERIFICATIONS_APPEND_ONLY");
}

/**
 * #911 F1: 등록기가 원본을 직접 수집한다(실제 GET·sha 계산). 영수증은 같은 실행에서 수집기가 만든 것만 쓰고,
 * 외부 영수증 파일은 받지 않는다. 관측 시각은 수집 실행 시계이며, 등록 시계 기준 허용 범위를 다시 확인한다.
 * 외부 영수증에 시계 검사만 더하는 방식보다, 손으로 고친 capturedAt이 끼어들 경로 자체가 없다.
 */
export async function registerKricCapitalTimetable({
  repositoryRoot = ROOT, operationDirectory, fetchImpl = fetch, clock = () => new Date(),
  observe = buildKricNationwideTimetableObservation,
} = {}) {
  if (typeof operationDirectory !== "string" || !path.isAbsolute(operationDirectory)) fail("OPERATION_DIRECTORY");
  const collectedAt = clock();
  const outputFile = path.join(operationDirectory, `kric-nationwide-timetable-file-${collectedAt.toISOString().replaceAll(/[-:.]/gu, "")}.xlsx`);
  const receipt = await collectKricNationwideTimetableFile({ outputFile, fetchImpl, now: collectedAt });
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
  await writeFile(path.join(operationDirectory, "receipt.json"), receiptBytes, { flag: "wx" });
  const inventory = JSON.parse(await readFile(path.join(repositoryRoot, INVENTORY_PATH), "utf8"));
  const targets = JSON.parse(await readFile(path.join(repositoryRoot, TARGETS_PATH), "utf8"));
  const { snapshot, snapshotPath, evidenceTemplate, observedAt, previousEvidence } = await buildKricCapitalTimetableRegistration({
    workbookPath: outputFile, receipt, inventory, targets, observe,
  });
  if (observedAt !== receipt.capturedAt) fail("OBSERVATION");
  const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot)}\n`);
  const existingSnapshotBytes = await readFile(path.join(repositoryRoot, snapshotPath)).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  const plan = planKricCapitalTimetableRegistration({
    previousEvidence, snapshot, snapshotBytes, existingSnapshotBytes,
    observation: { observedAt, collectionReceiptSha256: createHash("sha256").update(receiptBytes).digest("hex") },
    evidenceTemplate, now: clock(),
  });
  if (plan.writeSnapshot) await writeFile(path.join(repositoryRoot, snapshotPath), snapshotBytes, { flag: "wx" });
  const source = inventory.sources.find(({ id }) => id === CAPITAL_TIMETABLE_SOURCE_ID);
  source[CAPITAL_TIMETABLE_EVIDENCE_KEY] = plan.evidence;
  await writeFile(path.join(repositoryRoot, INVENTORY_PATH), jsonBytes(inventory));
  return { snapshotPath, mode: plan.mode, evidence: plan.evidence };
}

export function parseRegisterKricCapitalTimetableArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--operation-directory" || !path.isAbsolute(argv[1])) {
    throw new Error("usage: register-kric-capital-timetable.mjs --operation-directory <absolute empty directory>");
  }
  return { operationDirectory: argv[1] };
}

if (isMainModule(import.meta.url)) {
  try {
    const { snapshotPath, mode, evidence } = await registerKricCapitalTimetable(parseRegisterKricCapitalTimetableArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ snapshotPath, mode, snapshotId: evidence.snapshotId, recordCount: evidence.recordCount, observedAt: evidence.observedAt, reverificationCount: evidence.reverifications.length })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
