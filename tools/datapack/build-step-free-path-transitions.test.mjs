import assert from "node:assert/strict";
import test from "node:test";

import {
  TRANSITION_REQUIREMENT_GROUP_KINDS,
  buildStepFreeTransitionCoverageReport,
  buildTransitionFacilityRequirements,
  evaluateStepFreeTransition,
  validateTransitionFacilityRequirements,
} from "./build-step-free-path-transitions.mjs";

// #827 QA 결정(2026-09-30): 요구는 기존 역 단위 ENTRY/EXIT edge에 붙이고, 행은
// (transition_key, path_id, direction_next_station_id, group_kind, facility_id)이다. 기대값은 손으로 쓴다.
const ENTRY_A = "edge-entry-station-a-line-4";
const EXIT_A = "edge-exit-station-a-line-4";
const ENTRY_B = "edge-entry-station-b-line-4";
const EXIT_B = "edge-exit-station-b-line-4";
const P_UP = "kric-mv:S1:4:448:447:1";
const P_DOWN = "kric-mv:S1:4:448:449:1";
const E1 = "smrt-elev:0448:4:1번 출입구";
const U1 = "smrt-elev:0448:4:상행역 방면1-1";
const W1 = "smrt-elev:0448:4:하행역 방면9-1";
const W2 = "smrt-elev:0448:4:하행역 방면10-4";

const ROUTE_EDGES = [
  { edgeId: ENTRY_A, edgeType: "ENTRY", fromNodeId: "station-a", toNodeId: "station-a:line-4" },
  { edgeId: EXIT_A, edgeType: "EXIT", fromNodeId: "station-a:line-4", toNodeId: "station-a" },
  { edgeId: ENTRY_B, edgeType: "ENTRY", fromNodeId: "station-b", toNodeId: "station-b:line-4" },
  { edgeId: EXIT_B, edgeType: "EXIT", fromNodeId: "station-b:line-4", toNodeId: "station-b" },
  { edgeId: "edge-ride-station-a-station-b-line-4", edgeType: "RIDE", fromNodeId: "station-a:line-4", toNodeId: "station-b:line-4" },
];

function pathRows(pathId, stationId, nextStationId, exitNo, platformDirection, steps = 2) {
  return Array.from({ length: steps }, (_, index) => ({
    path_id: pathId,
    station_id: stationId,
    line_id: "line-4",
    next_station_id: nextStationId,
    exit_no: exitNo,
    platform_direction: platformDirection,
    step: index + 1,
    detail: `${index + 1}) 이동`,
  }));
}

function twoDirectionInput() {
  return {
    paths: [
      ...pathRows(P_UP, "station-a", "station-up", "1", "상행역"),
      ...pathRows(P_DOWN, "station-a", "station-down", "1", "하행역", 3),
    ],
    pathFacilities: [
      { path_id: P_UP, group_kind: "EXIT", facility_id: E1 },
      { path_id: P_UP, group_kind: "DIRECTION", facility_id: U1 },
      { path_id: P_DOWN, group_kind: "EXIT", facility_id: E1 },
      { path_id: P_DOWN, group_kind: "DIRECTION", facility_id: W1 },
      { path_id: P_DOWN, group_kind: "DIRECTION", facility_id: W2 },
    ],
    facilityIds: [E1, U1, W1, W2, "facility-legacy-lift"],
    routeEdges: ROUTE_EDGES,
  };
}

const TWO_DIRECTION_ROWS_FOR = (transitionKey) => [
  { transition_key: transitionKey, path_id: P_UP, direction_next_station_id: "station-up", group_kind: "EXIT_ELEVATORS", facility_id: E1 },
  { transition_key: transitionKey, path_id: P_UP, direction_next_station_id: "station-up", group_kind: "PLATFORM_DIRECTION_ELEVATORS", facility_id: U1 },
  { transition_key: transitionKey, path_id: P_DOWN, direction_next_station_id: "station-down", group_kind: "EXIT_ELEVATORS", facility_id: E1 },
  { transition_key: transitionKey, path_id: P_DOWN, direction_next_station_id: "station-down", group_kind: "PLATFORM_DIRECTION_ELEVATORS", facility_id: W2 },
  { transition_key: transitionKey, path_id: P_DOWN, direction_next_station_id: "station-down", group_kind: "PLATFORM_DIRECTION_ELEVATORS", facility_id: W1 },
];

test("group_kind는 #834 EXIT/DIRECTION 묶음을 EXIT_ELEVATORS/PLATFORM_DIRECTION_ELEVATORS로 옮긴다", () => {
  assert.deepEqual(TRANSITION_REQUIREMENT_GROUP_KINDS, {
    EXIT: "EXIT_ELEVATORS",
    DIRECTION: "PLATFORM_DIRECTION_ELEVATORS",
  });
});

test("(1) 두 방향 각각 경로 1개면 기존 역 ENTRY·EXIT edge에 같은 요구 행이 붙고, 한 방향 승강장 엘리베이터가 모두 불가면 전환이 막힌다", () => {
  const rows = buildTransitionFacilityRequirements(twoDirectionInput());
  assert.deepEqual(rows, [...TWO_DIRECTION_ROWS_FOR(ENTRY_A), ...TWO_DIRECTION_ROWS_FOR(EXIT_A)]);

  const entryRows = rows.filter(({ transition_key: key }) => key === ENTRY_A);
  const down = new Set([W1, W2]);
  assert.deepEqual(evaluateStepFreeTransition(entryRows, (id) => !down.has(id)), {
    passable: false,
    directions: [
      { nextStationId: "station-down", passable: false },
      { nextStationId: "station-up", passable: true },
    ],
  });
  // 묶음 안에서는 한 대 이상 가동이면 통과다.
  assert.deepEqual(evaluateStepFreeTransition(entryRows, (id) => id !== W1), {
    passable: true,
    directions: [
      { nextStationId: "station-down", passable: true },
      { nextStationId: "station-up", passable: true },
    ],
  });
  // 두 방향이 공유하는 출입구 엘리베이터가 불가면 두 방향 모두 막힌다.
  assert.deepEqual(evaluateStepFreeTransition(entryRows, (id) => id !== E1), {
    passable: false,
    directions: [
      { nextStationId: "station-down", passable: false },
      { nextStationId: "station-up", passable: false },
    ],
  });
  // 요구 행이 없는 전환은 무단차 요구가 없다(방향 0개).
  assert.deepEqual(evaluateStepFreeTransition([], () => false), { passable: true, directions: [] });
  assert.throws(() => evaluateStepFreeTransition(rows, () => true), /single transition_key/);
});

test("같은 방향에 공식 경로가 여러 개면 하나라도 통과하면 그 방향은 통과한다", () => {
  const P_UP_2 = "kric-mv:S1:4:448:447:2";
  const E2 = "smrt-elev:0448:4:2번 출입구";
  const input = twoDirectionInput();
  input.paths.push(...pathRows(P_UP_2, "station-a", "station-up", "2", "상행역"));
  input.pathFacilities.push(
    { path_id: P_UP_2, group_kind: "EXIT", facility_id: E2 },
    { path_id: P_UP_2, group_kind: "DIRECTION", facility_id: U1 },
  );
  input.facilityIds.push(E2);
  const entryRows = buildTransitionFacilityRequirements(input).filter(({ transition_key: key }) => key === ENTRY_A);
  assert.deepEqual(entryRows.filter(({ path_id: pathId }) => pathId === P_UP_2), [
    { transition_key: ENTRY_A, path_id: P_UP_2, direction_next_station_id: "station-up", group_kind: "EXIT_ELEVATORS", facility_id: E2 },
    { transition_key: ENTRY_A, path_id: P_UP_2, direction_next_station_id: "station-up", group_kind: "PLATFORM_DIRECTION_ELEVATORS", facility_id: U1 },
  ]);
  assert.deepEqual(evaluateStepFreeTransition(entryRows, (id) => id !== E1), {
    passable: false,
    directions: [
      { nextStationId: "station-down", passable: false },
      { nextStationId: "station-up", passable: true },
    ],
  });
});

test("(2) 시설 연결이 불완전한 경로는 요구 행을 만들지 않는다", () => {
  const input = twoDirectionInput();
  const P_EXIT_ONLY = "kric-mv:S1:4:448:447:3";
  const P_DIRECTION_ONLY = "kric-mv:S1:4:448:449:4";
  const P_UNLINKED = "kric-mv:S1:4:448:449:5";
  input.paths.push(
    ...pathRows(P_EXIT_ONLY, "station-a", "station-up", "3", "상행역"),
    ...pathRows(P_DIRECTION_ONLY, "station-a", "station-down", "4", "하행역"),
    ...pathRows(P_UNLINKED, "station-a", "station-down", "5", "하행역"),
  );
  input.pathFacilities.push(
    { path_id: P_EXIT_ONLY, group_kind: "EXIT", facility_id: E1 },
    { path_id: P_DIRECTION_ONLY, group_kind: "DIRECTION", facility_id: W1 },
  );
  assert.deepEqual(buildTransitionFacilityRequirements(input), [...TWO_DIRECTION_ROWS_FOR(ENTRY_A), ...TWO_DIRECTION_ROWS_FOR(EXIT_A)]);

  // 완전한 경로가 하나도 없으면 요구 행도 없다.
  assert.deepEqual(buildTransitionFacilityRequirements({
    paths: pathRows(P_EXIT_ONLY, "station-a", "station-up", "3", "상행역"),
    pathFacilities: [{ path_id: P_EXIT_ONLY, group_kind: "EXIT", facility_id: E1 }],
    facilityIds: [E1],
    routeEdges: ROUTE_EDGES,
  }), []);
});

test("(4) 고아 facility_id·path_id·transition_key와 역 edge 누락은 실패한다", () => {
  const withGhostFacility = twoDirectionInput();
  withGhostFacility.pathFacilities.push({ path_id: P_UP, group_kind: "DIRECTION", facility_id: "smrt-elev:ghost" });
  assert.throws(() => buildTransitionFacilityRequirements(withGhostFacility), /orphan facility_id: smrt-elev:ghost/);

  const withGhostPath = twoDirectionInput();
  withGhostPath.pathFacilities.push({ path_id: "kric-mv:ghost", group_kind: "EXIT", facility_id: E1 });
  assert.throws(() => buildTransitionFacilityRequirements(withGhostPath), /orphan path_id: kric-mv:ghost/);

  const withBadGroup = twoDirectionInput();
  withBadGroup.pathFacilities.push({ path_id: P_UP, group_kind: "PLATFORM", facility_id: E1 });
  assert.throws(() => buildTransitionFacilityRequirements(withBadGroup), /group_kind is invalid: PLATFORM/);

  const withoutEntry = twoDirectionInput();
  withoutEntry.routeEdges = ROUTE_EDGES.filter(({ edgeId }) => edgeId !== ENTRY_A);
  assert.throws(() => buildTransitionFacilityRequirements(withoutEntry), /station ENTRY edge is missing: station-a\/line-4/);

  const withDuplicateExit = twoDirectionInput();
  withDuplicateExit.routeEdges = [...ROUTE_EDGES, { edgeId: "edge-exit-station-a-line-4-alt", edgeType: "EXIT", fromNodeId: "station-a:line-4", toNodeId: "station-a" }];
  assert.throws(() => buildTransitionFacilityRequirements(withDuplicateExit), /station EXIT edge is ambiguous: station-a\/line-4/);

  const withInconsistentPath = twoDirectionInput();
  withInconsistentPath.paths[1] = { ...withInconsistentPath.paths[1], next_station_id: "station-down" };
  assert.throws(() => buildTransitionFacilityRequirements(withInconsistentPath), /station_elevator_path is inconsistent: kric-mv:S1:4:448:447:1/);

  const input = twoDirectionInput();
  const requirements = buildTransitionFacilityRequirements(input);
  const validate = (mutated) => validateTransitionFacilityRequirements({ ...input, requirements: mutated });
  assert.doesNotThrow(() => validate(requirements));
  const first = requirements[0];
  assert.throws(() => validate([...requirements, { ...first, transition_key: "edge-entry-ghost" }]), /orphan transition_key: edge-entry-ghost/);
  // 다른 역의 실제 ENTRY edge나 RIDE edge도 그 경로의 역 전환이 아니므로 고아다.
  assert.throws(() => validate([...requirements, { ...first, transition_key: ENTRY_B }]), /orphan transition_key: edge-entry-station-b-line-4/);
  assert.throws(() => validate([...requirements, { ...first, transition_key: "edge-ride-station-a-station-b-line-4" }]), /orphan transition_key: edge-ride-station-a-station-b-line-4/);
  assert.throws(() => validate([...requirements, { ...first, facility_id: "smrt-elev:ghost" }]), /orphan facility_id: smrt-elev:ghost/);
  assert.throws(() => validate([...requirements, { ...first, path_id: "kric-mv:ghost" }]), /orphan path_id: kric-mv:ghost/);
  assert.throws(() => validate([...requirements.slice(1), { ...first, direction_next_station_id: "station-down" }]), /direction_next_station_id mismatch: kric-mv:S1:4:448:447:1/);
  assert.throws(() => validate([...requirements.slice(1), { ...first, group_kind: "EXIT" }]), /group_kind is invalid: EXIT/);
});

test("(5) facilities 테이블이 없거나 비어 있으면 실패한다", () => {
  assert.throws(() => buildTransitionFacilityRequirements({ ...twoDirectionInput(), facilityIds: undefined }), /facilities table is missing/);
  assert.throws(() => buildTransitionFacilityRequirements({ ...twoDirectionInput(), facilityIds: [] }), /facilities table is empty/);
  const input = twoDirectionInput();
  const requirements = buildTransitionFacilityRequirements(input);
  assert.throws(() => validateTransitionFacilityRequirements({ ...input, requirements, facilityIds: undefined }), /facilities table is missing/);
  assert.throws(() => validateTransitionFacilityRequirements({ ...input, requirements, facilityIds: [] }), /facilities table is empty/);
  assert.throws(() => buildTransitionFacilityRequirements({ ...twoDirectionInput(), paths: undefined }), /station_elevator_path rows are required/);
  assert.throws(() => buildTransitionFacilityRequirements({ ...twoDirectionInput(), pathFacilities: undefined }), /station_elevator_path_facility rows are required/);
  assert.throws(() => buildTransitionFacilityRequirements({ ...twoDirectionInput(), routeEdges: undefined }), /route edges are required/);
});

test("(6) 입력 순서를 바꿔도 요구 행은 바이트 동일하다", () => {
  const input = twoDirectionInput();
  const expected = JSON.stringify([...TWO_DIRECTION_ROWS_FOR(ENTRY_A), ...TWO_DIRECTION_ROWS_FOR(EXIT_A)]);
  assert.equal(JSON.stringify(buildTransitionFacilityRequirements(input)), expected);
  const permuted = {
    paths: [...input.paths].reverse(),
    pathFacilities: [input.pathFacilities[3], input.pathFacilities[0], input.pathFacilities[4], input.pathFacilities[2], input.pathFacilities[1]],
    facilityIds: [...input.facilityIds].reverse(),
    routeEdges: [ROUTE_EDGES[4], ROUTE_EDGES[1], ROUTE_EDGES[3], ROUTE_EDGES[0], ROUTE_EDGES[2]],
  };
  assert.equal(JSON.stringify(buildTransitionFacilityRequirements(permuted)), expected);
});

test("커버리지 리포트는 역·노선별 방향 근거, 근거 없는 방향, 단일 고장 차단과 과차단 노출을 센다", () => {
  const P_B = "kric-mv:S1:4:449:448:1";
  const P_C_INCOMPLETE = "kric-mv:S1:4:450:451:1";
  const E3 = "smrt-elev:0449:4:3번 출입구";
  const X1 = "smrt-elev:0449:4:가역 방면5-1";
  const base = twoDirectionInput();
  const routeEdges = [
    ...ROUTE_EDGES,
    { edgeId: "edge-entry-station-c-line-4", edgeType: "ENTRY", fromNodeId: "station-c", toNodeId: "station-c:line-4" },
    { edgeId: "edge-exit-station-c-line-4", edgeType: "EXIT", fromNodeId: "station-c:line-4", toNodeId: "station-c" },
  ];
  const stationElevatorPaths = {
    facilities: [...base.facilityIds, E3, X1].map((id) => ({ id })),
    paths: [
      ...base.paths,
      ...pathRows(P_B, "station-b", "station-a", "3", "가역"),
      ...pathRows(P_C_INCOMPLETE, "station-c", "station-d", "1", "라역"),
    ],
    pathFacilities: [
      ...base.pathFacilities,
      { path_id: P_B, group_kind: "EXIT", facility_id: E3 },
      { path_id: P_B, group_kind: "DIRECTION", facility_id: X1 },
      { path_id: P_C_INCOMPLETE, group_kind: "EXIT", facility_id: E3 },
    ],
    pathSummaries: [
      { pathId: P_UP, stationId: "station-a", lineId: "line-4", nextStationId: "station-up", linkageComplete: true },
      { pathId: P_DOWN, stationId: "station-a", lineId: "line-4", nextStationId: "station-down", linkageComplete: true },
      { pathId: P_B, stationId: "station-b", lineId: "line-4", nextStationId: "station-a", linkageComplete: true },
      { pathId: P_C_INCOMPLETE, stationId: "station-c", lineId: "line-4", nextStationId: "station-d", linkageComplete: false },
    ],
    queryOutcomes: [
      { stationId: "station-a", lineId: "line-4", nextStationId: "station-up", state: "ROWS_OBSERVED" },
      { stationId: "station-a", lineId: "line-4", nextStationId: "station-down", state: "ROWS_OBSERVED" },
      { stationId: "station-b", lineId: "line-4", nextStationId: "station-a", state: "ROWS_OBSERVED" },
      { stationId: "station-b", lineId: "line-4", nextStationId: "station-c", state: "PROVIDER_NO_DATA" },
      { stationId: "station-c", lineId: "line-4", nextStationId: "station-d", state: "ROWS_OBSERVED" },
      { stationId: "station-c", lineId: "line-4", nextStationId: "station-b", state: "ROWS_OBSERVED" },
    ],
    exclusions: {
      facilities: [],
      paths: [
        { reason: "START_FORMAT_MISMATCH", stationId: "station-c", lineId: "line-4", nextStationId: "station-b", pathId: "kric-mv:S1:4:450:449:1" },
        { reason: "NEXT_STATION_MAPPING_NOT_FOUND", stationId: "station-a", lineId: "line-4", provider: {} },
        { reason: "MAPPING_NOT_FOUND", provider: {} },
      ],
    },
  };
  const report = buildStepFreeTransitionCoverageReport({ stationElevatorPaths, routeEdges });
  assert.deepEqual(report.byStationLine, [
    {
      stationId: "station-a",
      lineId: "line-4",
      transitionKeys: [ENTRY_A, EXIT_A],
      requirementRowCount: 10,
      requiredFacilityCount: 4,
      directions: [
        { nextStationId: "station-down", status: "REQUIRED", completePathCount: 1, incompletePathCount: 0, excludedPathCount: 0, providerNoPathQueryCount: 0 },
        { nextStationId: "station-up", status: "REQUIRED", completePathCount: 1, incompletePathCount: 0, excludedPathCount: 0, providerNoPathQueryCount: 0 },
      ],
      unmappedDirectionQueryCount: 1,
      singleOutageBlockingFacilityIds: [E1, U1],
      overBlockingFacilityIds: [U1],
    },
    {
      stationId: "station-b",
      lineId: "line-4",
      transitionKeys: [ENTRY_B, EXIT_B],
      requirementRowCount: 4,
      requiredFacilityCount: 2,
      directions: [
        { nextStationId: "station-a", status: "REQUIRED", completePathCount: 1, incompletePathCount: 0, excludedPathCount: 0, providerNoPathQueryCount: 0 },
        { nextStationId: "station-c", status: "PROVIDER_NO_PATH", completePathCount: 0, incompletePathCount: 0, excludedPathCount: 0, providerNoPathQueryCount: 1 },
      ],
      unmappedDirectionQueryCount: 0,
      singleOutageBlockingFacilityIds: [E3, X1],
      overBlockingFacilityIds: [],
    },
    {
      stationId: "station-c",
      lineId: "line-4",
      transitionKeys: [],
      requirementRowCount: 0,
      requiredFacilityCount: 0,
      directions: [
        { nextStationId: "station-b", status: "PATHS_EXCLUDED", completePathCount: 0, incompletePathCount: 0, excludedPathCount: 1, providerNoPathQueryCount: 0 },
        { nextStationId: "station-d", status: "LINKAGE_INCOMPLETE", completePathCount: 0, incompletePathCount: 1, excludedPathCount: 0, providerNoPathQueryCount: 0 },
      ],
      unmappedDirectionQueryCount: 0,
      singleOutageBlockingFacilityIds: [],
      overBlockingFacilityIds: [],
    },
  ]);
  assert.deepEqual(report.summary, {
    stationLineCount: 3,
    stationLinesWithRequirement: 2,
    transitionCount: 4,
    requirementRowCount: 14,
    requiredFacilityCount: 6,
    directionCount: 6,
    directionsByStatus: { LINKAGE_INCOMPLETE: 1, PATHS_EXCLUDED: 1, PROVIDER_NO_PATH: 1, REQUIRED: 3 },
    stationLinesAllDirectionsRequired: 1,
    stationLinesPartialDirectionsRequired: 1,
    stationLinesWithoutRequirement: 1,
    stationLinesWithUnmappedDirectionQuery: 1,
    stationLinesMultiDirectionRequired: 1,
    stationLinesWithSingleOutageBlocking: 2,
    singleOutageBlockingFacilityCount: 4,
    stationLinesWithOverBlockingOutage: 1,
    overBlockingFacilityCount: 1,
  });
});
