#!/usr/bin/env node
// #1701 Phase 2: 빠른하차 공식 데이터 → station_car_door_hints 정규화 도구.
//
// 입력 raw row(14종): crtrYmd, drtnInfo, elvtrNo, facNo, facPstnNm, fwkPstnNm, lineNm,
// plfmCmgFac, qckgffMngNo, qckgffVhclDoorNo("칸-문" 예 "3-2"), stnCd, stnNm, stnNo, upbdnbSe.
//
// canonical roster를 경유해 stnNm → stationId, lineNm → lineId를 확정한다.
// qckgffVhclDoorNo를 "칸-문"으로 분해하고, upbdnbSe → direction, plfmCmgFac/facPstnNm →
// target_facility_type을 명시적 매핑 테이블로 변환한다. 매칭/파싱/매핑 실패는 quarantine에
// 기록하고 적재하지 않는다(throw 금지).
//
// 이 데이터는 시간 데이터가 아니다 — 시간 관련 값을 절대 생성/추정하지 않는다.
//
// 사용: node tools/datapack/import-car-door-hints.mjs \
//   --roster <roster.json> --rows <rows.json> \
//   [--source-id <id>] [--snapshot-id <id>] [--verification-status <status>] \
//   --output <out.json>
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { parseArgs, readJsonFile, requireArg, requiredArray, sortJson } from "./lib/ledger-admission-cli.mjs";
import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";
import { buildRosterIndex } from "./lib/station-roster.mjs";

// upbdnbSe(상하행구분) → 표준 direction. 매핑 불가 값은 quarantine.
const DIRECTION_MAP = new Map([
  ["상행", "UP"],
  ["하행", "DOWN"],
  ["내선", "INNER"],
  ["외선", "OUTER"],
]);

// plfmCmgFac/facPstnNm 텍스트 → target_facility_type(스키마 CHECK 허용값).
// 키는 정규화(공백 제거) 후 부분 문자열로 매칭한다.
const FACILITY_KEYWORDS = [
  { keyword: "계단", type: "STAIR" },
  { keyword: "엘리베이터", type: "ELEVATOR" },
  { keyword: "승강기", type: "ELEVATOR" },
  { keyword: "에스컬레이터", type: "ESCALATOR" },
  { keyword: "환승", type: "TRANSFER" },
];

const CAR_MIN = 1;
const CAR_MAX = 10;
const DOOR_MIN = 1;
const DOOR_MAX = 4;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const roster = requiredArray(await readJsonFile(requireArg(args, "roster")), "roster");
  const rows = requiredArray(await readJsonFile(requireArg(args, "rows")), "rows");
  const outputPath = requireArg(args, "output");

  const fixture = buildCarDoorHints({
    roster,
    rows,
    sourceId: args["source-id"] ?? "",
    snapshotId: args["snapshot-id"] ?? "",
    verificationStatus: args["verification-status"] ?? "OFFICIAL",
  });

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(sortJson(fixture), null, 2)}\n`);
}

/**
 * 순수 함수: 빠른하차 raw rows + roster → 정규화 산출.
 * 반환: { stationCarDoorHints, quarantine, duplicateReport }.
 */
export function buildCarDoorHints({ roster, rows, sourceId = "", snapshotId = "", verificationStatus = "OFFICIAL" }) {
  const index = buildRosterIndex(roster);
  const stationCarDoorHints = [];
  const quarantine = [];
  const duplicateReport = [];
  const seenIds = new Set();

  for (const raw of rows) {
    const result = normalizeCarDoorHint(index, raw, { sourceId, snapshotId, verificationStatus });
    if (result.error) quarantine.push({ reason: result.error, row: raw });
    else if (seenIds.has(result.hint.id)) duplicateReport.push({ id: result.hint.id, row: raw });
    else {
      seenIds.add(result.hint.id);
      stationCarDoorHints.push(result.hint);
    }
  }

  return { stationCarDoorHints, quarantine, duplicateReport };
}

function normalizeCarDoorHint(index, raw, provenance) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "car door row must be an object" };
  }
  if (typeof raw.stnNm !== "string" || raw.stnNm.trim() === "") {
    return { error: "stnNm must be a non-empty string" };
  }
  if (typeof raw.lineNm !== "string" || raw.lineNm.trim() === "") {
    return { error: "lineNm must be a non-empty string" };
  }

  const stationMatch = index.matchStation(raw.stnNm);
  if (stationMatch.error) return stationMatch;
  const lineMatch = index.matchLineForStation(stationMatch.stationId, raw.lineNm);
  if (lineMatch.error) return lineMatch;
  const carDoor = parseCarDoor(raw.qckgffVhclDoorNo);
  if (carDoor.error) return carDoor;
  const direction = mapDirection(raw.upbdnbSe);
  if (direction.error) return direction;
  const facility = mapFacilityType(raw.plfmCmgFac, raw.facPstnNm);
  if (facility.error) return facility;
  const providerIdentity = [raw.qckgffMngNo, raw.facNo]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  const providerIdentitySuffix = providerIdentity.length > 0 ? `-${sha256(canonicalJson(providerIdentity))}` : "";

  return {
    hint: {
      id: `cardoor-${stationMatch.stationId}-${lineMatch.lineId}-${direction.direction}-${facility.type}-${carDoor.carNumber}-${carDoor.doorNumber}${providerIdentitySuffix}`,
      stationId: stationMatch.stationId,
      lineId: lineMatch.lineId,
      direction: direction.direction,
      targetFacilityType: facility.type,
      carNumber: carDoor.carNumber,
      doorNumber: carDoor.doorNumber,
      sourceId: provenance.sourceId,
      sourceSnapshotId: provenance.snapshotId,
      providerRecordHash: sha256(canonicalJson(raw)),
      provenanceKind: "OFFICIAL",
      verificationStatus: provenance.verificationStatus,
    },
  };
}

// "칸-문" 형식을 carNumber/doorNumber 정수로 분해. 구분자 없음·비숫자·범위밖은 error.
function parseCarDoor(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return { error: "qckgffVhclDoorNo must be a non-empty string" };
  }
  const parts = value.trim().split("-");
  if (parts.length !== 2) {
    return { error: `qckgffVhclDoorNo format invalid (expected car-door): ${value}` };
  }
  if (!/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) {
    return { error: `qckgffVhclDoorNo must be numeric car-door: ${value}` };
  }
  const carNumber = Number.parseInt(parts[0], 10);
  const doorNumber = Number.parseInt(parts[1], 10);
  if (carNumber < CAR_MIN || carNumber > CAR_MAX) {
    return { error: `car number out of range (${CAR_MIN}-${CAR_MAX}): ${value}` };
  }
  if (doorNumber < DOOR_MIN || doorNumber > DOOR_MAX) {
    return { error: `door number out of range (${DOOR_MIN}-${DOOR_MAX}): ${value}` };
  }
  return { carNumber, doorNumber };
}

// upbdnbSe → 표준 direction. 원문 보존은 quarantine.row에 남고, 매핑 불가 시 error.
function mapDirection(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return { error: "upbdnbSe must be a non-empty string" };
  }
  const direction = DIRECTION_MAP.get(value.trim());
  if (!direction) {
    return { error: `upbdnbSe direction mapping failed: ${value}` };
  }
  return { direction };
}

// plfmCmgFac(우선)·facPstnNm 텍스트 → STAIR|ELEVATOR|ESCALATOR|TRANSFER. 매핑 불가는 error.
function mapFacilityType(plfmCmgFac, facPstnNm) {
  for (const source of [plfmCmgFac, facPstnNm]) {
    if (typeof source !== "string" || source.trim() === "") continue;
    const normalized = source.replace(/\s+/g, "");
    for (const { keyword, type } of FACILITY_KEYWORDS) {
      if (normalized.includes(keyword)) {
        return { type };
      }
    }
  }
  return {
    error: `target facility type mapping failed: plfmCmgFac=${String(plfmCmgFac ?? "")} facPstnNm=${String(facPstnNm ?? "")}`,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
