import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStepFreePathTransitions,
  validateTransitionRequirementsIntegrity,
  buildStepFreeTransitionCoverageReport,
} from "./build-step-free-path-transitions.mjs";

test("(1) 완전 경로 2개(다른 출입구)인 역에서 ENTRY 전환 2개와 각자의 요구 시설 행을 생성한다", () => {
  const facilities = [
    { id: "kric-elev:KR:4:448:1:1-2:0b219253cb54", stationId: "station-sangnoksu", lineId: "seoul-4" },
    { id: "kric-elev:KR:4:448:2:1-2:abcdef123456", stationId: "station-sangnoksu", lineId: "seoul-4" },
  ];

  const paths = [
    {
      path_id: "path-station-sangnoksu-seoul-4-1",
      station_id: "station-sangnoksu",
      line_id: "seoul-4",
      mvPathMgNo: 1,
      exit_no: "1",
      platform_direction: "ENTRY",
      path_kind: "출입구-승강장",
      isComplete: true,
      mvDst: 50,
      steps: [
        { step: 1, detail: "1번 출입구", facility_id: null },
        { step: 2, detail: "1번 출입구 엘리베이터", facility_id: "kric-elev:KR:4:448:1:1-2:0b219253cb54" },
      ],
    },
    {
      path_id: "path-station-sangnoksu-seoul-4-2",
      station_id: "station-sangnoksu",
      line_id: "seoul-4",
      mvPathMgNo: 2,
      exit_no: "2",
      platform_direction: "ENTRY",
      path_kind: "출입구-승강장",
      isComplete: true,
      mvDst: 75,
      steps: [
        { step: 1, detail: "2번 출입구", facility_id: null },
        { step: 2, detail: "2번 출입구 엘리베이터", facility_id: "kric-elev:KR:4:448:2:1-2:abcdef123456" },
      ],
    },
  ];

  const result = buildStepFreePathTransitions({ paths, facilities });

  assert.equal(result.transitions.length, 2);
  assert.equal(result.requirements.length, 2);

  const expectedTransitions = [
    {
      edgeId: "edge-entry-station-sangnoksu-seoul-4-path-1",
      edgeType: "ENTRY",
      fromNodeId: "station-sangnoksu",
      toNodeId: "station-sangnoksu:seoul-4",
      durationSeconds: 0,
      distanceMeters: 50,
      pathId: "path-station-sangnoksu-seoul-4-1",
      exitNo: "1",
      stationId: "station-sangnoksu",
      lineId: "seoul-4",
    },
    {
      edgeId: "edge-entry-station-sangnoksu-seoul-4-path-2",
      edgeType: "ENTRY",
      fromNodeId: "station-sangnoksu",
      toNodeId: "station-sangnoksu:seoul-4",
      durationSeconds: 0,
      distanceMeters: 75,
      pathId: "path-station-sangnoksu-seoul-4-2",
      exitNo: "2",
      stationId: "station-sangnoksu",
      lineId: "seoul-4",
    },
  ];

  assert.deepEqual(result.transitions, expectedTransitions);

  const expectedRequirements = [
    {
      transition_key: "edge-entry-station-sangnoksu-seoul-4-path-1",
      facility_id: "kric-elev:KR:4:448:1:1-2:0b219253cb54",
    },
    {
      transition_key: "edge-entry-station-sangnoksu-seoul-4-path-2",
      facility_id: "kric-elev:KR:4:448:2:1-2:abcdef123456",
    },
  ];

  assert.deepEqual(result.requirements, expectedRequirements);
});

test("(2) 시설 연결 불완전 경로는 전환을 생성하지 않는다", () => {
  const facilities = [
    { id: "kric-elev:KR:4:448:1:1-2:0b219253cb54", stationId: "station-sangnoksu", lineId: "seoul-4" },
  ];

  const paths = [
    {
      path_id: "path-station-sangnoksu-seoul-4-incomplete",
      station_id: "station-sangnoksu",
      line_id: "seoul-4",
      mvPathMgNo: 3,
      exit_no: "3",
      platform_direction: "ENTRY",
      path_kind: "출입구-승강장",
      isComplete: false, // 불완전 연결
      mvDst: 60,
      steps: [
        { step: 1, detail: "3번 출입구", facility_id: null },
        { step: 2, detail: "3번 출구 엘리베이터", facility_id: null },
      ],
    },
  ];

  const result = buildStepFreePathTransitions({ paths, facilities });

  assert.equal(result.transitions.length, 0);
  assert.equal(result.requirements.length, 0);
  assert.equal(result.excludedPaths.length, 1);
  assert.equal(result.excludedPaths[0].reason, "INCOMPLETE_FACILITY_CONNECTION");
});

test("(3) 비용이 없는 경로는 전환을 생성하지 않는다", () => {
  const facilities = [
    { id: "kric-elev:KR:4:448:1:1-2:0b219253cb54", stationId: "station-sangnoksu", lineId: "seoul-4" },
  ];

  const paths = [
    {
      path_id: "path-station-sangnoksu-seoul-4-no-cost",
      station_id: "station-sangnoksu",
      line_id: "seoul-4",
      mvPathMgNo: 4,
      exit_no: "1",
      platform_direction: "ENTRY",
      path_kind: "출입구-승강장",
      isComplete: true,
      mvDst: null, // 비용 없음
      steps: [
        { step: 1, detail: "1번 출입구", facility_id: null },
        { step: 2, detail: "1번 출입구 엘리베이터", facility_id: "kric-elev:KR:4:448:1:1-2:0b219253cb54" },
      ],
    },
  ];

  const result = buildStepFreePathTransitions({ paths, facilities });

  assert.equal(result.transitions.length, 0);
  assert.equal(result.requirements.length, 0);
  assert.equal(result.excludedPaths.length, 1);
  assert.equal(result.excludedPaths[0].reason, "MISSING_COST");
});

test("(4) 고아 facility_id 또는 transition_key 에서 빌드 실패한다", () => {
  const validTransitions = new Set([
    "edge-entry-station-sangnoksu-seoul-4-path-1",
  ]);
  const validFacilities = new Set([
    "kric-elev:KR:4:448:1:1-2:0b219253cb54",
  ]);

  // 정상 케이스 통과
  assert.doesNotThrow(() => {
    validateTransitionRequirementsIntegrity(
      [
        {
          transition_key: "edge-entry-station-sangnoksu-seoul-4-path-1",
          facility_id: "kric-elev:KR:4:448:1:1-2:0b219253cb54",
        },
      ],
      { validTransitions, validFacilities },
    );
  });

  // 고아 transition_key
  assert.throws(() => {
    validateTransitionRequirementsIntegrity(
      [
        {
          transition_key: "edge-entry-orphan-path",
          facility_id: "kric-elev:KR:4:448:1:1-2:0b219253cb54",
        },
      ],
      { validTransitions, validFacilities },
    );
  }, /transition_facility_requirement contains orphan transition_key: edge-entry-orphan-path/);

  // 고아 facility_id
  assert.throws(() => {
    validateTransitionRequirementsIntegrity(
      [
        {
          transition_key: "edge-entry-station-sangnoksu-seoul-4-path-1",
          facility_id: "kric-elev:KR:4:448:999:orphan",
        },
      ],
      { validTransitions, validFacilities },
    );
  }, /transition_facility_requirement contains orphan facility_id: kric-elev:KR:4:448:999:orphan/);
});

test("(5) facilities 부재 시 빌드 실패한다", () => {
  const validTransitions = new Set([
    "edge-entry-station-sangnoksu-seoul-4-path-1",
  ]);

  assert.throws(() => {
    validateTransitionRequirementsIntegrity(
      [
        {
          transition_key: "edge-entry-station-sangnoksu-seoul-4-path-1",
          facility_id: "kric-elev:KR:4:448:1:1-2:0b219253cb54",
        },
      ],
      { validTransitions, validFacilities: new Set() },
    );
  }, /facilities table is missing or empty/);

  assert.throws(() => {
    validateTransitionRequirementsIntegrity(
      [
        {
          transition_key: "edge-entry-station-sangnoksu-seoul-4-path-1",
          facility_id: "kric-elev:KR:4:448:1:1-2:0b219253cb54",
        },
      ],
      { validTransitions, validFacilities: null },
    );
  }, /facilities table is missing or empty/);
});

test("(6) 입력 순서를 바꿔도 결과가 바이트 동일하다", () => {
  const facilities = [
    { id: "kric-elev:KR:4:448:1:1-2:0b219253cb54", stationId: "station-sangnoksu", lineId: "seoul-4" },
    { id: "kric-elev:KR:4:448:2:1-2:abcdef123456", stationId: "station-sangnoksu", lineId: "seoul-4" },
  ];

  const pathA = {
    path_id: "path-station-sangnoksu-seoul-4-1",
    station_id: "station-sangnoksu",
    line_id: "seoul-4",
    mvPathMgNo: 1,
    exit_no: "1",
    platform_direction: "ENTRY",
    path_kind: "출입구-승강장",
    isComplete: true,
    mvDst: 50,
    steps: [
      { step: 1, detail: "1번 출입구", facility_id: null },
      { step: 2, detail: "1번 출입구 엘리베이터", facility_id: "kric-elev:KR:4:448:1:1-2:0b219253cb54" },
    ],
  };

  const pathB = {
    path_id: "path-station-sangnoksu-seoul-4-2",
    station_id: "station-sangnoksu",
    line_id: "seoul-4",
    mvPathMgNo: 2,
    exit_no: "2",
    platform_direction: "ENTRY",
    path_kind: "출입구-승강장",
    isComplete: true,
    mvDst: 75,
    steps: [
      { step: 1, detail: "2번 출입구", facility_id: null },
      { step: 2, detail: "2번 출입구 엘리베이터", facility_id: "kric-elev:KR:4:448:2:1-2:abcdef123456" },
    ],
  };

  const res1 = buildStepFreePathTransitions({ paths: [pathA, pathB], facilities });
  const res2 = buildStepFreePathTransitions({ paths: [pathB, pathA], facilities });

  const goldenTransitionsJson = JSON.stringify([
    {
      edgeId: "edge-entry-station-sangnoksu-seoul-4-path-1",
      edgeType: "ENTRY",
      fromNodeId: "station-sangnoksu",
      toNodeId: "station-sangnoksu:seoul-4",
      durationSeconds: 0,
      distanceMeters: 50,
      pathId: "path-station-sangnoksu-seoul-4-1",
      exitNo: "1",
      stationId: "station-sangnoksu",
      lineId: "seoul-4",
    },
    {
      edgeId: "edge-entry-station-sangnoksu-seoul-4-path-2",
      edgeType: "ENTRY",
      fromNodeId: "station-sangnoksu",
      toNodeId: "station-sangnoksu:seoul-4",
      durationSeconds: 0,
      distanceMeters: 75,
      pathId: "path-station-sangnoksu-seoul-4-2",
      exitNo: "2",
      stationId: "station-sangnoksu",
      lineId: "seoul-4",
    },
  ]);

  const goldenRequirementsJson = JSON.stringify([
    {
      transition_key: "edge-entry-station-sangnoksu-seoul-4-path-1",
      facility_id: "kric-elev:KR:4:448:1:1-2:0b219253cb54",
    },
    {
      transition_key: "edge-entry-station-sangnoksu-seoul-4-path-2",
      facility_id: "kric-elev:KR:4:448:2:1-2:abcdef123456",
    },
  ]);

  assert.equal(JSON.stringify(res1.transitions), goldenTransitionsJson);
  assert.equal(JSON.stringify(res2.transitions), goldenTransitionsJson);
  assert.equal(JSON.stringify(res1.requirements), goldenRequirementsJson);
  assert.equal(JSON.stringify(res2.requirements), goldenRequirementsJson);
});

test("커버리지 리포트가 전환 수, 요구 시설 수, 제외 경로 수와 사유를 정확히 집계한다", () => {
  const transitions = [
    { edgeId: "edge-entry-1", stationId: "station-a", lineId: "seoul-4" },
    { edgeId: "edge-entry-2", stationId: "station-a", lineId: "seoul-4" },
    { edgeId: "edge-exit-1", stationId: "station-b", lineId: "seoul-2" },
  ];

  const requirements = [
    { transition_key: "edge-entry-1", facility_id: "fac-1" },
    { transition_key: "edge-entry-2", facility_id: "fac-2" },
    { transition_key: "edge-exit-1", facility_id: "fac-3" },
  ];

  const excludedPaths = [
    { pathId: "path-x", stationId: "station-a", lineId: "seoul-4", reason: "INCOMPLETE_FACILITY_CONNECTION" },
    { pathId: "path-y", stationId: "station-c", lineId: "seoul-1", reason: "MISSING_COST" },
  ];

  const report = buildStepFreeTransitionCoverageReport({
    transitions,
    requirements,
    excludedPaths,
  });

  assert.equal(report.summary.totalTransitions, 3);
  assert.equal(report.summary.totalRequirements, 3);
  assert.equal(report.summary.totalExcludedPaths, 2);
  assert.equal(report.summary.excludedByReason.INCOMPLETE_FACILITY_CONNECTION, 1);
  assert.equal(report.summary.excludedByReason.MISSING_COST, 1);
  assert.equal(report.byStationLine.length, 3);
});
