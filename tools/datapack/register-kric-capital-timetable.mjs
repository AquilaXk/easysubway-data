#!/usr/bin/env node
// #899: KRIC 전체_도시철도운행정보(파일 id 900) 수집본에서 수도권 정차 순서 명시 노선을 projection snapshot으로
// 커밋하고, inventory kric-nationwide-timetable-file.capitalScheduleAdmissionEvidence를 그 snapshot에 결속한다.
//
// 사용(수집은 기존 collect-kric-nationwide-timetable-file.mjs):
//   node tools/datapack/collect-kric-nationwide-timetable-file.mjs --output-file <abs>/kric-nationwide-timetable-file-<tag>.xlsx > <abs>/receipt.json
//   node tools/datapack/register-kric-capital-timetable.mjs --workbook <abs xlsx> --receipt <abs receipt.json>
//
// 원천 행을 바꾸지 않는다. 노선 적재 검증(역 매칭·노선 trip·격리 상한)은 후보 생성(prepare)에서 다시 수행한다.
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
import { CAPITAL_TIMETABLE_EVIDENCE_KEY, CAPITAL_TIMETABLE_SOURCE_ID } from "./lib/capital-official-timetable.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const INVENTORY_PATH = "tools/datapack/source-inventory.json";
const TARGETS_PATH = "tools/datapack/nationwide-coverage-targets.json";
const jsonBytes = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** 수집본 → snapshot·inventory 증거. 파일을 쓰지 않는다. */
export async function buildKricCapitalTimetableRegistration({ workbookPath, receipt, inventory, targets }) {
  const observation = await buildKricNationwideTimetableObservation({ inputFile: workbookPath, receipt });
  const snapshot = projectKricCapitalTimetableSnapshot(observation);
  const { provider } = kricCapitalOfficialTimetable(snapshot);
  const lineIds = [...new Set(KRIC_CAPITAL_ROUTE_PROFILES.map(({ lineId }) => lineId))].sort(codepointCompare);
  const scopes = (targets.activeLineScopes ?? []).filter((scope) => scope.regionId === "capital" && lineIds.includes(scope.lineId));
  for (const lineId of lineIds) {
    if (!scopes.some((scope) => scope.lineId === lineId)) throw new Error(`capital timetable line is not an active capital line scope: ${lineId}`);
  }
  const sources = inventory.sources.filter(({ id }) => id === CAPITAL_TIMETABLE_SOURCE_ID);
  if (sources.length !== 1) throw new Error(`inventory source missing or ambiguous: ${CAPITAL_TIMETABLE_SOURCE_ID}`);
  const snapshotPath = `tools/datapack/sources/${snapshot.snapshotId}.json`;
  const evidence = {
    issue: 899,
    materializer: "tools/datapack/lib/capital-official-timetable.mjs",
    verificationTest: "tools/datapack/capital-official-timetable.test.mjs",
    snapshotId: snapshot.snapshotId,
    snapshotPath,
    observedAt: snapshot.observedAt,
    rawFile: snapshot.rawFile,
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
  return { snapshot, snapshotPath, evidence };
}

export async function registerKricCapitalTimetable({ repositoryRoot = ROOT, workbookPath, receiptPath }) {
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  const inventory = JSON.parse(await readFile(path.join(repositoryRoot, INVENTORY_PATH), "utf8"));
  const targets = JSON.parse(await readFile(path.join(repositoryRoot, TARGETS_PATH), "utf8"));
  const { snapshot, snapshotPath, evidence } = await buildKricCapitalTimetableRegistration({ workbookPath, receipt, inventory, targets });
  await writeFile(path.join(repositoryRoot, snapshotPath), `${JSON.stringify(snapshot)}\n`, { flag: "wx" });
  const source = inventory.sources.find(({ id }) => id === CAPITAL_TIMETABLE_SOURCE_ID);
  source[CAPITAL_TIMETABLE_EVIDENCE_KEY] = evidence;
  await writeFile(path.join(repositoryRoot, INVENTORY_PATH), jsonBytes(inventory));
  return { snapshotPath, evidence };
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
    const { snapshotPath, evidence } = await registerKricCapitalTimetable(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ snapshotPath, snapshotId: evidence.snapshotId, recordCount: evidence.recordCount, observedAt: evidence.observedAt })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
