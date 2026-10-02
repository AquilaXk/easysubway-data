#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { codepointCompare } from "../lib/codepoint-compare.mjs";
import { loadStationElevatorPathInputs } from "./build-station-elevator-paths.mjs";

// #827 QA 결정(2026-09-30): 새 edge를 만들지 않는다. 무단차 요구는 기존 역 단위 ENTRY/EXIT edge에 붙이고,
// 행은 (transition_key, path_id, direction_next_station_id, group_kind, facility_id)이다.
// - group 안의 시설은 한 대 이상 가동이면 그 group이 통과한다.
// - 경로는 모든 group이 통과할 때 통과한다.
// - 전환은 요구 행이 있는 모든 방향(다음 역)에서 통과하는 경로가 하나 이상 있을 때만 무단차 통과다.
// 요구 행은 #834가 번들에 적재한 station_elevator_path_facility 구조 연결에서만 만든다(문구 추정 없음).
// 출입구 묶음과 승강장 방향 묶음이 모두 비어 있지 않은 경로(연결 완전)만 요구 행을 만든다.
export const TRANSITION_REQUIREMENT_GROUP_KINDS = Object.freeze({
  EXIT: "EXIT_ELEVATORS",
  DIRECTION: "PLATFORM_DIRECTION_ELEVATORS",
});
export const CURRENT_ROUTE_EDGE_INPUT_PATH = "tools/datapack/release/nationwide-route-edge-input.json";
const REQUIREMENT_GROUP_KINDS = new Set(Object.values(TRANSITION_REQUIREMENT_GROUP_KINDS));
const REQUIREMENT_FIELDS = ["transition_key", "path_id", "direction_next_station_id", "group_kind", "facility_id"];
const STATION_EDGE_TYPES = ["ENTRY", "EXIT"];

// 번들 accessibility component에 적재된 #834 테이블에서 요구 생성 입력을 읽는다. facilities가 없으면 undefined로 두어
// 생성·검증 단계가 실패로 드러내게 한다.
export function readBundledStepFreeInputs(database) {
  const hasFacilities = Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='facilities'").get());
  return {
    paths: database.prepare("SELECT path_id, station_id, line_id, next_station_id FROM station_elevator_path").all().map((row) => ({ ...row })),
    pathFacilities: database.prepare("SELECT path_id, group_kind, facility_id FROM station_elevator_path_facility").all().map((row) => ({ ...row })),
    facilityIds: hasFacilities ? database.prepare("SELECT id FROM facilities").all().map(({ id }) => id) : undefined,
  };
}

export function buildTransitionFacilityRequirements({ paths, pathFacilities, facilityIds, routeEdges } = {}) {
  const facilities = facilityIdSet(facilityIds);
  const pathsById = indexPaths(requireRows(paths, "station_elevator_path"));
  requireRows(pathFacilities, "station_elevator_path_facility");
  const stationEdges = indexStationEdges(routeEdges);
  const groupsByPath = new Map();
  for (const row of pathFacilities) {
    const groupKind = TRANSITION_REQUIREMENT_GROUP_KINDS[row.group_kind];
    if (!groupKind) throw new Error(`station_elevator_path_facility group_kind is invalid: ${row.group_kind}`);
    if (!pathsById.has(row.path_id)) throw new Error(`station_elevator_path_facility contains orphan path_id: ${row.path_id}`);
    if (!facilities.has(row.facility_id)) throw new Error(`station_elevator_path_facility contains orphan facility_id: ${row.facility_id}`);
    const groups = groupsByPath.get(row.path_id) ?? new Map(Object.values(TRANSITION_REQUIREMENT_GROUP_KINDS).map((kind) => [kind, []]));
    groups.get(groupKind).push(row.facility_id);
    groupsByPath.set(row.path_id, groups);
  }
  const requirements = [];
  for (const [pathId, groups] of groupsByPath) {
    if ([...groups.values()].some((facilityIdsInGroup) => facilityIdsInGroup.length === 0)) continue;
    const meta = pathsById.get(pathId);
    // 출입구↔승강장 이동경로는 들어갈 때(ENTRY)와 나갈 때(EXIT) 같은 엘리베이터를 쓰므로 두 edge에 같은 요구를 붙인다.
    for (const edgeType of STATION_EDGE_TYPES) {
      const transitionKey = requireStationEdge(stationEdges.byStationLine, edgeType, meta.stationId, meta.lineId);
      for (const [groupKind, facilityIdsInGroup] of groups) {
        for (const facilityId of facilityIdsInGroup) {
          requirements.push({
            transition_key: transitionKey,
            path_id: pathId,
            direction_next_station_id: meta.nextStationId,
            group_kind: groupKind,
            facility_id: facilityId,
          });
        }
      }
    }
  }
  return sortTransitionFacilityRequirements(requirements);
}

// 적재된 요구 행의 참조 무결성: transition_key는 그 경로 역·노선의 ENTRY/EXIT edge, path_id·facility_id는 번들 행이어야 한다.
export function validateTransitionFacilityRequirements({ requirements, paths, facilityIds, routeEdges } = {}) {
  const facilities = facilityIdSet(facilityIds);
  const pathsById = indexPaths(requireRows(paths, "station_elevator_path"));
  const stationEdges = indexStationEdges(routeEdges);
  for (const row of requireRows(requirements, "transition_facility_requirement")) {
    if (!REQUIREMENT_GROUP_KINDS.has(row.group_kind)) throw new Error(`transition_facility_requirement group_kind is invalid: ${row.group_kind}`);
    const meta = pathsById.get(row.path_id);
    if (!meta) throw new Error(`transition_facility_requirement contains orphan path_id: ${row.path_id}`);
    const edge = stationEdges.byId.get(row.transition_key);
    if (!edge || edge.stationId !== meta.stationId || edge.lineId !== meta.lineId) {
      throw new Error(`transition_facility_requirement contains orphan transition_key: ${row.transition_key}`);
    }
    if (!facilities.has(row.facility_id)) throw new Error(`transition_facility_requirement contains orphan facility_id: ${row.facility_id}`);
    if (row.direction_next_station_id !== meta.nextStationId) {
      throw new Error(`transition_facility_requirement direction_next_station_id mismatch: ${row.path_id}`);
    }
  }
}

export function sortTransitionFacilityRequirements(rows) {
  return rows
    .map((row) => Object.fromEntries(REQUIREMENT_FIELDS.map((field) => [field, row[field]])))
    .sort((left, right) => {
      for (const field of REQUIREMENT_FIELDS) {
        const result = codepointCompare(left[field], right[field]);
        if (result) return result;
      }
      return 0;
    });
}

// 한 전환(transition_key)의 요구 행과 시설 가동 판정으로 통과 여부를 계산한다. 가동 판정은 호출자가 정한다
// (#403: 실시간 상태가 UNKNOWN이면 가동으로 본다). 요구 행이 없는 전환은 무단차 요구가 없다.
export function evaluateStepFreeTransition(rows, isOperating) {
  if (!Array.isArray(rows)) throw new Error("transition requirement rows are required");
  if (typeof isOperating !== "function") throw new Error("isOperating must be a function");
  if (new Set(rows.map(({ transition_key: key }) => key)).size > 1) {
    throw new Error("evaluateStepFreeTransition requires rows of a single transition_key");
  }
  const directions = new Map();
  for (const row of rows) {
    const pathsInDirection = directions.get(row.direction_next_station_id) ?? new Map();
    const groups = pathsInDirection.get(row.path_id) ?? new Map();
    groups.set(row.group_kind, [...(groups.get(row.group_kind) ?? []), row.facility_id]);
    pathsInDirection.set(row.path_id, groups);
    directions.set(row.direction_next_station_id, pathsInDirection);
  }
  const results = [...directions.keys()].sort(codepointCompare).map((nextStationId) => ({
    nextStationId,
    passable: [...directions.get(nextStationId).values()]
      .some((groups) => [...groups.values()].every((facilityIdsInGroup) => facilityIdsInGroup.some((id) => isOperating(id)))),
  }));
  return { passable: results.every(({ passable }) => passable), directions: results };
}

// 커버리지는 #834 입력(연결 완전 여부·질의 결과·제외 사유)과 실제 요구 행으로 역·노선 단위로 센다.
// 과차단 노출: 시설 한 대 고장으로 전환 전체가 막히는데 다른 방향 경로는 여전히 통과하는 경우(반대 방향 이용자 과차단).
export function buildStepFreeTransitionCoverageReport({ stationElevatorPaths, routeEdges } = {}) {
  const input = stationElevatorPaths;
  if (!input || !Array.isArray(input.facilities) || !Array.isArray(input.pathSummaries)
    || !Array.isArray(input.queryOutcomes) || !Array.isArray(input.exclusions?.paths)) {
    throw new Error("station elevator path input is required");
  }
  const requirements = buildTransitionFacilityRequirements({
    paths: input.paths,
    pathFacilities: input.pathFacilities,
    facilityIds: input.facilities.map(({ id }) => id),
    routeEdges,
  });
  const byKey = new Map();
  const entry = (stationId, lineId) => {
    const key = stationLineKey(stationId, lineId);
    const value = byKey.get(key) ?? { stationId, lineId, directions: new Map(), unmappedDirectionQueryCount: 0 };
    byKey.set(key, value);
    return value;
  };
  const direction = (stationId, lineId, nextStationId) => {
    const { directions } = entry(stationId, lineId);
    const value = directions.get(nextStationId) ?? {
      nextStationId, completePathCount: 0, incompletePathCount: 0, excludedPathCount: 0, providerNoPathQueryCount: 0,
    };
    directions.set(nextStationId, value);
    return value;
  };
  for (const outcome of input.queryOutcomes) {
    const value = direction(outcome.stationId, outcome.lineId, outcome.nextStationId);
    if (outcome.state !== "ROWS_OBSERVED") value.providerNoPathQueryCount += 1;
  }
  for (const summary of input.pathSummaries) {
    const value = direction(summary.stationId, summary.lineId, summary.nextStationId);
    if (summary.linkageComplete) value.completePathCount += 1;
    else value.incompletePathCount += 1;
  }
  for (const exclusion of input.exclusions.paths) {
    if (!exclusion.stationId) continue;
    if (exclusion.nextStationId) direction(exclusion.stationId, exclusion.lineId, exclusion.nextStationId).excludedPathCount += 1;
    else entry(exclusion.stationId, exclusion.lineId).unmappedDirectionQueryCount += 1;
  }

  const rowsByStationLine = new Map();
  const pathStationLine = new Map(input.paths.map((row) => [row.path_id, stationLineKey(row.station_id, row.line_id)]));
  for (const row of requirements) {
    const key = pathStationLine.get(row.path_id);
    rowsByStationLine.set(key, [...(rowsByStationLine.get(key) ?? []), row]);
  }
  const byStationLine = [...byKey.keys()].sort(codepointCompare).map((key) => {
    const value = byKey.get(key);
    const rows = rowsByStationLine.get(key) ?? [];
    const transitionKeys = [...new Set(rows.map(({ transition_key: transitionKey }) => transitionKey))].sort(codepointCompare);
    const directions = [...value.directions.values()]
      .sort((left, right) => codepointCompare(left.nextStationId, right.nextStationId))
      .map((counts) => ({ nextStationId: counts.nextStationId, status: directionStatus(counts, key), ...withoutNextStation(counts) }));
    const requiredDirections = new Set(rows.map(({ direction_next_station_id: nextStationId }) => nextStationId));
    const reportedRequired = directions.filter(({ status }) => status === "REQUIRED").map(({ nextStationId }) => nextStationId);
    if (reportedRequired.length !== requiredDirections.size || reportedRequired.some((id) => !requiredDirections.has(id))) {
      throw new Error(`coverage linkage mismatch: ${value.stationId}/${value.lineId}`);
    }
    const facilityIds = [...new Set(rows.map(({ facility_id: facilityId }) => facilityId))].sort(codepointCompare);
    const transitionRows = rows.filter(({ transition_key: transitionKey }) => transitionKey === transitionKeys[0]);
    const singleOutageBlockingFacilityIds = [];
    const overBlockingFacilityIds = [];
    for (const facilityId of facilityIds) {
      const outcome = evaluateStepFreeTransition(transitionRows, (id) => id !== facilityId);
      if (outcome.passable) continue;
      singleOutageBlockingFacilityIds.push(facilityId);
      if (outcome.directions.some(({ passable }) => passable)) overBlockingFacilityIds.push(facilityId);
    }
    return {
      stationId: value.stationId,
      lineId: value.lineId,
      transitionKeys,
      requirementRowCount: rows.length,
      requiredFacilityCount: facilityIds.length,
      directions,
      unmappedDirectionQueryCount: value.unmappedDirectionQueryCount,
      singleOutageBlockingFacilityIds,
      overBlockingFacilityIds,
    };
  });

  const count = (predicate) => byStationLine.filter((stationLine) => predicate(stationLine)).length;
  const allDirections = byStationLine.flatMap(({ directions }) => directions);
  const directionsByStatus = {};
  for (const { status } of allDirections) directionsByStatus[status] = (directionsByStatus[status] ?? 0) + 1;
  const withRequirement = ({ transitionKeys }) => transitionKeys.length > 0;
  const requiredCount = ({ directions }) => directions.filter(({ status }) => status === "REQUIRED").length;
  return {
    movementSnapshotId: input.movementSnapshotId,
    facilitySnapshotId: input.facilitySnapshotId,
    summary: {
      stationLineCount: byStationLine.length,
      stationLinesWithRequirement: count(withRequirement),
      transitionCount: new Set(requirements.map(({ transition_key: transitionKey }) => transitionKey)).size,
      requirementRowCount: requirements.length,
      requiredFacilityCount: new Set(requirements.map(({ facility_id: facilityId }) => facilityId)).size,
      directionCount: allDirections.length,
      directionsByStatus,
      stationLinesAllDirectionsRequired: count((value) => withRequirement(value) && requiredCount(value) === value.directions.length),
      stationLinesPartialDirectionsRequired: count((value) => withRequirement(value) && requiredCount(value) < value.directions.length),
      stationLinesWithoutRequirement: count((value) => !withRequirement(value)),
      stationLinesWithUnmappedDirectionQuery: count(({ unmappedDirectionQueryCount }) => unmappedDirectionQueryCount > 0),
      stationLinesMultiDirectionRequired: count((value) => requiredCount(value) >= 2),
      stationLinesWithSingleOutageBlocking: count(({ singleOutageBlockingFacilityIds }) => singleOutageBlockingFacilityIds.length > 0),
      singleOutageBlockingFacilityCount: byStationLine.reduce((total, { singleOutageBlockingFacilityIds }) => total + singleOutageBlockingFacilityIds.length, 0),
      stationLinesWithOverBlockingOutage: count(({ overBlockingFacilityIds }) => overBlockingFacilityIds.length > 0),
      overBlockingFacilityCount: byStationLine.reduce((total, { overBlockingFacilityIds }) => total + overBlockingFacilityIds.length, 0),
    },
    byStationLine,
  };
}

function directionStatus(counts, key) {
  if (counts.completePathCount > 0) return "REQUIRED";
  if (counts.incompletePathCount > 0) return "LINKAGE_INCOMPLETE";
  if (counts.excludedPathCount > 0) return "PATHS_EXCLUDED";
  if (counts.providerNoPathQueryCount > 0) return "PROVIDER_NO_PATH";
  throw new Error(`coverage direction has no evidence outcome: ${key.replace("\0", "/")}/${counts.nextStationId}`);
}

function withoutNextStation({ nextStationId: _nextStationId, ...counts }) {
  return counts;
}

function facilityIdSet(facilityIds) {
  if (facilityIds === undefined || facilityIds === null) throw new Error("facilities table is missing");
  if (!Array.isArray(facilityIds)) throw new Error("facilities table is missing");
  if (facilityIds.length === 0) throw new Error("facilities table is empty");
  return new Set(facilityIds);
}

function requireRows(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} rows are required`);
  return value;
}

function indexPaths(paths) {
  const byId = new Map();
  for (const row of paths) {
    const meta = { stationId: row.station_id, lineId: row.line_id, nextStationId: row.next_station_id };
    const known = byId.get(row.path_id);
    if (known && (known.stationId !== meta.stationId || known.lineId !== meta.lineId || known.nextStationId !== meta.nextStationId)) {
      throw new Error(`station_elevator_path is inconsistent: ${row.path_id}`);
    }
    byId.set(row.path_id, meta);
  }
  return byId;
}

// 역 단위 ENTRY는 역 노드 → 역:노선 노드, EXIT는 역:노선 노드 → 역 노드다. id 문자열이 아니라 끝점 구조로 찾는다.
function indexStationEdges(routeEdges) {
  if (!Array.isArray(routeEdges)) throw new Error("route edges are required");
  const byId = new Map();
  const byStationLine = new Map();
  for (const edge of routeEdges) {
    if (!STATION_EDGE_TYPES.includes(edge.edgeType)) continue;
    const [stationNode, stationLineNode] = edge.edgeType === "ENTRY" ? [edge.fromNodeId, edge.toNodeId] : [edge.toNodeId, edge.fromNodeId];
    const parts = typeof stationLineNode === "string" ? stationLineNode.split(":") : [];
    if (parts.length !== 2 || parts[0] !== stationNode || !parts[1]) continue;
    const [stationId, lineId] = parts;
    byId.set(edge.edgeId, { edgeType: edge.edgeType, stationId, lineId });
    const key = `${edge.edgeType}\0${stationLineKey(stationId, lineId)}`;
    byStationLine.set(key, [...(byStationLine.get(key) ?? []), edge.edgeId]);
  }
  return { byId, byStationLine };
}

function requireStationEdge(byStationLine, edgeType, stationId, lineId) {
  const edgeIds = byStationLine.get(`${edgeType}\0${stationLineKey(stationId, lineId)}`) ?? [];
  if (edgeIds.length === 0) throw new Error(`station ${edgeType} edge is missing: ${stationId}/${lineId}`);
  if (edgeIds.length > 1) throw new Error(`station ${edgeType} edge is ambiguous: ${stationId}/${lineId}`);
  return edgeIds[0];
}

function stationLineKey(stationId, lineId) {
  return `${stationId}\0${lineId}`;
}

async function main(argv) {
  if (argv.length !== 2 || argv[0] !== "--repository-root") {
    throw new Error("usage: build-step-free-path-transitions.mjs --repository-root <path>");
  }
  const root = path.resolve(argv[1]);
  const stationElevatorPaths = await loadStationElevatorPathInputs({ repositoryRoot: root });
  const routeEdgeBytes = await readFile(path.join(root, CURRENT_ROUTE_EDGE_INPUT_PATH));
  const routeEdgeInput = JSON.parse(routeEdgeBytes.toString("utf8"));
  const report = buildStepFreeTransitionCoverageReport({ stationElevatorPaths, routeEdges: routeEdgeInput.routeEdges });
  process.stdout.write(`${JSON.stringify({
    routeEdgeInput: { path: CURRENT_ROUTE_EDGE_INPUT_PATH, sha256: createHash("sha256").update(routeEdgeBytes).digest("hex") },
    ...report,
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`build-step-free-path-transitions: ${error.message}\n`);
    process.exitCode = 1;
  });
}
