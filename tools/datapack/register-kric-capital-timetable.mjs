#!/usr/bin/env node
// #899: KRIC 전체_도시철도운행정보(파일 id 900) 수집본에서 수도권 정차 순서 명시 노선을 projection snapshot으로
// 커밋하고, inventory kric-nationwide-timetable-file.capitalScheduleAdmissionEvidence를 그 snapshot에 결속한다.
//
// 사용(수집은 기존 collect-kric-nationwide-timetable-file.mjs):
//   node tools/datapack/collect-kric-nationwide-timetable-file.mjs --output-file <abs>/kric-nationwide-timetable-file-<tag>.xlsx > <abs>/receipt.json
//   node tools/datapack/register-kric-capital-timetable.mjs --workbook <abs xlsx> --receipt <abs receipt.json>
//
// 원천 행을 바꾸지 않는다. 노선 적재 검증(역 매칭·노선 trip·격리 상한)은 후보 생성(prepare)에서 다시 수행한다.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../lib/is-main-module.mjs";
import { codepointCompare } from "../lib/codepoint-compare.mjs";
import { buildKricNationwideTimetableObservation } from "./build-kric-nationwide-timetable-observation.mjs";
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

/** 수집본 → snapshot·evidence 기본값(관측 시각·재확인 이력 제외). 파일을 쓰지 않는다. */
export async function buildKricCapitalTimetableRegistration({ workbookPath, receipt, inventory, targets }) {
  const observation = await buildKricNationwideTimetableObservation({ inputFile: workbookPath, receipt });
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
export function planKricCapitalTimetableRegistration({ previousEvidence, snapshot, snapshotBytes, existingSnapshotBytes, observation, evidenceTemplate }) {
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
  return { mode: RAW_PUBLICATION_MODE.PUBLISH_NEW, writeSnapshot: true, evidence };
}

/** 재확인 이력은 append-only다: 기존 항목을 그대로 두고 뒤에 항목을 하나 이상 붙여야 한다. */
export function assertAppendOnlyReverifications(previous, next) {
  if (!Array.isArray(previous) || !Array.isArray(next) || next.length <= previous.length
    || previous.some((entry, index) => JSON.stringify(entry) !== JSON.stringify(next[index]))) fail("REVERIFICATIONS_APPEND_ONLY");
}

export async function registerKricCapitalTimetable({ repositoryRoot = ROOT, workbookPath, receiptPath }) {
  const receiptBytes = await readFile(receiptPath);
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  const inventory = JSON.parse(await readFile(path.join(repositoryRoot, INVENTORY_PATH), "utf8"));
  const targets = JSON.parse(await readFile(path.join(repositoryRoot, TARGETS_PATH), "utf8"));
  const { snapshot, snapshotPath, evidenceTemplate, observedAt, previousEvidence } = await buildKricCapitalTimetableRegistration({ workbookPath, receipt, inventory, targets });
  const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot)}\n`);
  const existingSnapshotBytes = await readFile(path.join(repositoryRoot, snapshotPath)).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  const plan = planKricCapitalTimetableRegistration({
    previousEvidence, snapshot, snapshotBytes, existingSnapshotBytes,
    observation: { observedAt, collectionReceiptSha256: createHash("sha256").update(receiptBytes).digest("hex") },
    evidenceTemplate,
  });
  if (plan.writeSnapshot) await writeFile(path.join(repositoryRoot, snapshotPath), snapshotBytes, { flag: "wx" });
  const source = inventory.sources.find(({ id }) => id === CAPITAL_TIMETABLE_SOURCE_ID);
  source[CAPITAL_TIMETABLE_EVIDENCE_KEY] = plan.evidence;
  await writeFile(path.join(repositoryRoot, INVENTORY_PATH), jsonBytes(inventory));
  return { snapshotPath, mode: plan.mode, evidence: plan.evidence };
}

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--workbook" || argv[2] !== "--receipt"
    || !path.isAbsolute(argv[1]) || !path.isAbsolute(argv[3])) {
    throw new Error("usage: register-kric-capital-timetable.mjs --workbook <absolute.xlsx> --receipt <absolute.json>");
  }
  return { workbookPath: argv[1], receiptPath: argv[3] };
}

if (isMainModule(import.meta.url)) {
  try {
    const { snapshotPath, mode, evidence } = await registerKricCapitalTimetable(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ snapshotPath, mode, snapshotId: evidence.snapshotId, recordCount: evidence.recordCount, observedAt: evidence.observedAt, reverificationCount: evidence.reverifications.length })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
