import { createHash } from "node:crypto";

import { codepointCompare } from "../lib/codepoint-compare.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";

// #834 QA 결정(2026-09-30): 이동경로는 KRIC stationMovement(표준), 엘리베이터 시설은 서울교통공사 getFcElvtr,
// 역·노선 매핑은 채택된 KRIC 편의시설 표준 snapshot의 canonicalMappings만 쓴다. 이름 조인·순번·텍스트 추정은 하지 않는다.
export const MOVEMENT_SOURCE_ID = "kric-station-movement-standard";
export const FACILITY_SOURCE_ID = "seoul-metro-facility-location";
export const MAPPING_SOURCE_ID = "kric-station-convenience-standard";
// getFcElvtr는 서울교통공사 원천이므로 KRIC 운영기관 코드 S1 매핑에만 붙인다.
const SEOUL_METRO_OPERATOR_CODE = "S1";
const SEOUL_METRO_LINE_NAME = /^([1-9])호선$/u;
const PROVIDER_STATION_CODE = /^\d{4}$/u;
const KRIC_NUMERIC_STATION_CODE = /^\d{1,4}$/u;
// 출입구형: "<N>번 출입구", "<N>,<M>[,...]번 출입구", 뒤에 " 사이"까지 허용한다.
const EXIT_LOCATION = /^(\d+(?:,\d+)*)번 출입구(?: 사이)?$/u;
// 방면형: "<X> 방면<N>-<M>" 항목을 쉼표로 나열한다. "방면" 앞뒤 공백은 한 칸까지 허용한다.
const DIRECTION_ITEM = /^(\S(?:.*\S)?) ?방면 ?(\d+-\d+)$/u;
const DIRECTION_ITEM_SEPARATOR = /\s*,\s*/u;
// stationMovement 출발 위치는 "<N>번 출입구"로 시작할 때만, 도착 방향은 "<X> 방면"일 때만 쓴다.
const MOVEMENT_START_EXIT = /^(\d+)번 출입구/u;
const MOVEMENT_DIRECTION = /^(\S(?:.*\S)?) ?방면$/u;

export function normalizeElevatorLocation(value) {
  if (typeof value !== "string") throw new TypeError("elevator location must be a string");
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

// 위치 표현을 출입구 번호 집합 또는 (방면, 칸 위치) 목록으로 파싱한다. 문법 밖이면 null(식별 불가)이다.
export function parseElevatorLocation(value) {
  const normalized = normalizeElevatorLocation(value);
  const exit = EXIT_LOCATION.exec(normalized);
  if (exit) {
    return { kind: "EXIT", exitNumbers: [...new Set(exit[1].split(","))].sort(compareNumericStrings) };
  }
  const directions = [];
  for (const item of normalized.split(DIRECTION_ITEM_SEPARATOR)) {
    const match = DIRECTION_ITEM.exec(item);
    if (!match) return null;
    directions.push({ label: match[1], carPosition: match[2] });
  }
  return directions.length > 0 ? { kind: "DIRECTION", directions } : null;
}

export function buildSmrtElevatorFacilityId({ providerStationCode, lineCode, pathDescription }) {
  if (!PROVIDER_STATION_CODE.test(providerStationCode ?? "") || !/^[1-9]$/u.test(lineCode ?? "")) {
    throw new Error("smrt-elev identity fields are invalid");
  }
  return `smrt-elev:${providerStationCode}:${lineCode}:${normalizeElevatorLocation(pathDescription)}`;
}

export function parseMovementStartExit(stMovePath) {
  if (typeof stMovePath !== "string") return null;
  return MOVEMENT_START_EXIT.exec(normalizeElevatorLocation(stMovePath))?.[1] ?? null;
}

export function parseMovementDirection(edMovePath) {
  if (typeof edMovePath !== "string") return null;
  return MOVEMENT_DIRECTION.exec(normalizeElevatorLocation(edMovePath))?.[1] ?? null;
}

export function canonicalMappingsFromConvenienceSnapshot(snapshot) {
  if (snapshot?.sourceId !== MAPPING_SOURCE_ID || snapshot?.artifactKind !== "kric-accessibility-snapshot"
    || !Array.isArray(snapshot.queries) || snapshot.queries.length === 0) {
    throw new Error("canonical mapping snapshot identity mismatch");
  }
  const fields = ["stationId", "lineId", "railOprIsttCd", "lnCd", "stinCd"];
  const providerKeys = new Set();
  const stationLineKeys = new Set();
  return snapshot.queries.map((query) => {
    const bundled = (query?.canonicalMappings ?? []).filter(({ artifactId }) => artifactId === "bundled-capital");
    if (bundled.length !== 1 || bundled[0].stationId !== query.stationId || bundled[0].lineId !== query.lineId
      || fields.some((field) => typeof query[field] !== "string" || query[field] === "")) {
      throw new Error(`canonical mapping is invalid: ${query?.stationId ?? "<unknown>"}`);
    }
    const providerKey = providerTupleKey(query.railOprIsttCd, query.lnCd, query.stinCd);
    const stationLineKey = stationLine(query.stationId, query.lineId);
    if (providerKeys.has(providerKey) || stationLineKeys.has(stationLineKey)) {
      throw new Error(`canonical mapping is ambiguous: ${providerKey}`);
    }
    providerKeys.add(providerKey);
    stationLineKeys.add(stationLineKey);
    return Object.fromEntries(fields.map((field) => [field, query[field]]));
  });
}

export function buildStationElevatorPaths({ movementSnapshot, facilitySnapshot, canonicalMappings } = {}) {
  if (movementSnapshot?.sourceId !== MOVEMENT_SOURCE_ID || !Array.isArray(movementSnapshot.queryPlan)
    || !Array.isArray(movementSnapshot.results)) {
    throw new Error("movement snapshot identity mismatch");
  }
  if (facilitySnapshot?.sourceId !== FACILITY_SOURCE_ID || !Array.isArray(facilitySnapshot.stations)) {
    throw new Error("facility location snapshot identity mismatch");
  }
  if (!Array.isArray(canonicalMappings) || canonicalMappings.length === 0) {
    throw new Error("canonical mappings are required");
  }
  const mappingByProvider = new Map(canonicalMappings.map((mapping) => [
    providerTupleKey(mapping.railOprIsttCd, mapping.lnCd, mapping.stinCd), mapping,
  ]));
  const seoulMappingByCode = new Map(canonicalMappings
    .filter(({ railOprIsttCd, stinCd }) => railOprIsttCd === SEOUL_METRO_OPERATOR_CODE && KRIC_NUMERIC_STATION_CODE.test(stinCd))
    .map((mapping) => [`${mapping.lnCd}\0${mapping.stinCd.padStart(4, "0")}`, mapping]));

  const { facilities, facilityExclusions } = buildFacilities(facilitySnapshot, seoulMappingByCode);
  const facilitiesByStationLine = new Map();
  for (const facility of facilities) {
    const key = stationLine(facility.stationId, facility.lineId);
    facilitiesByStationLine.set(key, [...(facilitiesByStationLine.get(key) ?? []), facility]);
  }

  const queryById = new Map(movementSnapshot.queryPlan.map((query) => [query.queryId, query]));
  const paths = [];
  const pathFacilities = [];
  const pathSummaries = [];
  const pathExclusions = [];
  const queryOutcomes = [];
  for (const result of movementSnapshot.results) {
    const query = queryById.get(result.queryId);
    if (!query) throw new Error(`movement result query missing: ${result.queryId}`);
    const provider = {
      railOprIsttCd: query.providerOperatorId,
      lnCd: query.providerLineId,
      stinCd: query.providerStationId,
      nextStinCd: query.providerNextStationId,
    };
    // 방향은 요청한 nextStinCd를 같은 매핑으로 canonical 역에 붙인 값이다. 매핑이 없으면 추정하지 않고 제외한다.
    const from = mappingByProvider.get(providerTupleKey(provider.railOprIsttCd, provider.lnCd, provider.stinCd));
    const next = mappingByProvider.get(providerTupleKey(provider.railOprIsttCd, provider.lnCd, provider.nextStinCd));
    if (!from || !next || from.lineId !== next.lineId) {
      pathExclusions.push({ reason: "MAPPING_NOT_FOUND", provider, queryId: result.queryId });
      continue;
    }
    queryOutcomes.push({ stationId: from.stationId, lineId: from.lineId, nextStationId: next.stationId, state: result.state });
    if (result.state !== "ROWS_OBSERVED") continue;
    const rowsByPath = new Map();
    for (const row of result.rows) {
      const key = String(row.mvPathMgNo);
      rowsByPath.set(key, [...(rowsByPath.get(key) ?? []), row]);
    }
    for (const mvPathMgNo of [...rowsByPath.keys()].sort(compareNumericStrings)) {
      // 경로 단위는 (역, 노선, 다음 역, mvPathMgNo)이고 path_id는 원천 코드를 그대로 보존한다.
      const pathId = `kric-mv:${provider.railOprIsttCd}:${provider.lnCd}:${provider.stinCd}:${provider.nextStinCd}:${mvPathMgNo}`;
      const context = { pathId, stationId: from.stationId, lineId: from.lineId, nextStationId: next.stationId, mvPathMgNo };
      const built = buildPath(rowsByPath.get(mvPathMgNo), context);
      if (built.reason) {
        pathExclusions.push({ reason: built.reason, provider, ...context });
        continue;
      }
      // 경로 요구: 같은 역·노선의 출입구 N 엘리베이터 묶음과 방면 X 엘리베이터 묶음. 원천 필드 정확 일치로만 묶는다.
      const candidates = facilitiesByStationLine.get(stationLine(from.stationId, from.lineId)) ?? [];
      const exitGroup = candidates
        .filter(({ location }) => location.kind === "EXIT" && location.exitNumbers.includes(built.exitNo))
        .map(({ id }) => id).sort(codepointCompare);
      const directionGroup = candidates
        .filter(({ location }) => location.kind === "DIRECTION"
          && location.directions.some(({ label }) => label === built.platformDirection))
        .map(({ id }) => id).sort(codepointCompare);
      paths.push(...built.rows);
      for (const facilityId of exitGroup) pathFacilities.push({ path_id: pathId, group_kind: "EXIT", facility_id: facilityId });
      for (const facilityId of directionGroup) pathFacilities.push({ path_id: pathId, group_kind: "DIRECTION", facility_id: facilityId });
      pathSummaries.push({
        ...context,
        exitNo: built.exitNo,
        platformDirection: built.platformDirection,
        stepCount: built.rows.length,
        exitFacilityCount: exitGroup.length,
        directionFacilityCount: directionGroup.length,
        linkageComplete: exitGroup.length > 0 && directionGroup.length > 0,
      });
    }
  }
  const output = {
    movementSnapshotId: movementSnapshot.snapshotId,
    facilitySnapshotId: facilitySnapshot.snapshotId,
    facilities,
    paths,
    pathFacilities,
    pathSummaries,
    queryOutcomes,
    exclusions: { facilities: facilityExclusions, paths: pathExclusions },
    canonicalStationLines: canonicalMappings.map(({ stationId, lineId }) => ({ stationId, lineId })),
  };
  validateStationElevatorPathsIntegrity(output);
  return output;
}

function buildFacilities(facilitySnapshot, seoulMappingByCode) {
  const facilityExclusions = [];
  const parsed = [];
  for (const station of facilitySnapshot.stations) {
    for (const facility of station.facilities ?? []) {
      const provider = {
        providerStationCode: station.providerStationCode,
        lineName: station.lineName,
        stationName: station.stationName,
        pathDescription: facility.pathDescription,
      };
      const lineCode = SEOUL_METRO_LINE_NAME.exec(station.lineName ?? "")?.[1];
      if (!lineCode || !PROVIDER_STATION_CODE.test(station.providerStationCode ?? "")) {
        facilityExclusions.push({ reason: "LINE_OR_CODE_FORMAT_MISMATCH", provider });
        continue;
      }
      // 역코드 결속: getFcElvtr stnCd == S1 stinCd 4자리 0 채움, lineNm "N호선" == lnCd N. 이름은 쓰지 않는다.
      const mapping = seoulMappingByCode.get(`${lineCode}\0${station.providerStationCode}`) ?? null;
      const location = parseElevatorLocation(facility.pathDescription);
      if (!location) {
        facilityExclusions.push({ reason: "UNIDENTIFIABLE_FORMAT", provider, ...mappedStationLine(mapping) });
        continue;
      }
      parsed.push({
        id: buildSmrtElevatorFacilityId({ providerStationCode: station.providerStationCode, lineCode, pathDescription: facility.pathDescription }),
        lineCode,
        location,
        mapping,
        provider,
      });
    }
  }
  const counts = new Map();
  for (const { id } of parsed) counts.set(id, (counts.get(id) ?? 0) + 1);
  const facilities = [];
  for (const entry of parsed.sort((left, right) => codepointCompare(left.id, right.id))) {
    // 같은 id가 2개 이상이면 순번으로 구분하지 않고 전부 식별 불가로 뺀다.
    if (counts.get(entry.id) > 1) {
      facilityExclusions.push({ reason: "UNIDENTIFIABLE_DUPLICATE", facilityId: entry.id, provider: entry.provider, ...mappedStationLine(entry.mapping) });
      continue;
    }
    if (!entry.mapping) {
      facilityExclusions.push({ reason: "MAPPING_NOT_FOUND", facilityId: entry.id, provider: entry.provider });
      continue;
    }
    facilities.push({
      id: entry.id,
      stationId: entry.mapping.stationId,
      lineId: entry.mapping.lineId,
      providerStationCode: entry.provider.providerStationCode,
      lineCode: entry.lineCode,
      stationName: entry.provider.stationName,
      pathDescription: entry.provider.pathDescription,
      location: entry.location,
      sourceSnapshotId: facilitySnapshot.snapshotId,
      capturedAt: facilitySnapshot.capturedAt,
      observedAt: facilitySnapshot.observedAt,
      providerRecordHash: sha256(canonicalJson(entry.provider)),
    });
  }
  return { facilities, facilityExclusions };
}

function buildPath(rows, context) {
  const steps = rows.map((row) => ({ row, step: stepNumber(row.exitMvTpOrdr) }));
  if (steps.some(({ step }) => step === null) || new Set(steps.map(({ step }) => step)).size !== steps.length) {
    return { reason: "STEP_ORDER_INVALID" };
  }
  if (new Set(rows.map(({ stMovePath }) => stMovePath)).size !== 1
    || new Set(rows.map(({ edMovePath }) => edMovePath)).size !== 1) {
    return { reason: "PATH_FIELDS_INCONSISTENT" };
  }
  const exitNo = parseMovementStartExit(rows[0].stMovePath);
  if (exitNo === null) return { reason: "START_FORMAT_MISMATCH" };
  const platformDirection = parseMovementDirection(rows[0].edMovePath);
  if (platformDirection === null) return { reason: "DIRECTION_FORMAT_MISMATCH" };
  if (rows.some(({ mvContDtl }) => typeof mvContDtl !== "string" || mvContDtl.trim() === "")) {
    return { reason: "DETAIL_MISSING" };
  }
  return {
    exitNo,
    platformDirection,
    rows: steps.sort((left, right) => left.step - right.step).map(({ row, step }) => ({
      path_id: context.pathId,
      station_id: context.stationId,
      line_id: context.lineId,
      next_station_id: context.nextStationId,
      exit_no: exitNo,
      platform_direction: platformDirection,
      step,
      detail: row.mvContDtl,
    })),
  };
}

export function validateStationElevatorPathsIntegrity({ facilities, paths, pathFacilities }) {
  const facilityIds = new Set(facilities.map(({ id }) => id));
  if (facilityIds.size !== facilities.length) throw new Error("station elevator facility id is not unique");
  const stepKeys = new Set(paths.map(({ path_id: pathId, step }) => `${pathId}\0${step}`));
  if (stepKeys.size !== paths.length) throw new Error("station_elevator_path (path_id, step) is not unique");
  const pathIds = new Set(paths.map(({ path_id: pathId }) => pathId));
  const orphanFacilities = [...new Set(pathFacilities
    .filter(({ facility_id: facilityId }) => !facilityIds.has(facilityId))
    .map(({ facility_id: facilityId }) => facilityId))];
  if (orphanFacilities.length > 0) {
    throw new Error(`station_elevator_path_facility contains orphan facility_id: ${orphanFacilities.join(", ")}`);
  }
  const orphanPaths = [...new Set(pathFacilities
    .filter(({ path_id: pathId }) => !pathIds.has(pathId))
    .map(({ path_id: pathId }) => pathId))];
  if (orphanPaths.length > 0) {
    throw new Error(`station_elevator_path_facility contains orphan path_id: ${orphanPaths.join(", ")}`);
  }
}

function stepNumber(value) {
  const text = String(value ?? "");
  if (!/^[1-9]\d*$/u.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : null;
}

function mappedStationLine(mapping) {
  return mapping ? { stationId: mapping.stationId, lineId: mapping.lineId } : {};
}

function providerTupleKey(railOprIsttCd, lnCd, stinCd) {
  return `${railOprIsttCd}:${lnCd}:${stinCd}`;
}

function stationLine(stationId, lineId) {
  return `${stationId}\0${lineId}`;
}

function compareNumericStrings(left, right) {
  const leftNumber = /^\d+$/u.test(left) ? Number(left) : Number.NaN;
  const rightNumber = /^\d+$/u.test(right) ? Number(right) : Number.NaN;
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  return codepointCompare(left, right);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
