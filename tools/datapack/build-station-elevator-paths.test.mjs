import assert from "node:assert/strict";
import test from "node:test";

import {
  buildElevatorFacilityId,
  buildStationElevatorPaths,
  buildStationElevatorCoverageReport,
  validateStationElevatorPathsIntegrity,
  KRIC_MOVEMENT_PATH_DIRECTION_CODES,
} from "./build-station-elevator-paths.mjs";

test("KRIC 이동경로 구분 코드표는 고정된 방향 매핑을 가진다", () => {
  assert.equal(KRIC_MOVEMENT_PATH_DIRECTION_CODES["1"], "ENTRY");
  assert.equal(KRIC_MOVEMENT_PATH_DIRECTION_CODES["2"], "EXIT");
  assert.equal(KRIC_MOVEMENT_PATH_DIRECTION_CODES["3"], "TRANSFER");
});

test("(1) 시설 행 id가 결정론적으로 생성되고, 입력 순서를 바꿔도 같다", () => {
  const rowA = {
    railOprIsttCd: "KR",
    lnCd: "4",
    stinCd: "448",
    exitNo: "2",
    runStinFlorFr: 1,
    runStinFlorTo: 2,
    dtlLoc: "(1층)표내는곳내반월방향계단옆",
  };
  const rowB = {
    railOprIsttCd: "KR",
    lnCd: "4",
    stinCd: "448",
    exitNo: "2",
    runStinFlorFr: 1,
    runStinFlorTo: 2,
    dtlLoc: " (1층)표내는곳내반월방향계단옆 ", // whitespace normalized
  };

  const idA = buildElevatorFacilityId(rowA);
  const idB = buildElevatorFacilityId(rowB);

  assert.equal(idA, "kric-elev:KR:4:448:2:1-2:0b219253cb54");
  assert.equal(idB, "kric-elev:KR:4:448:2:1-2:0b219253cb54");
  assert.match(idA, /^kric-elev:KR:4:448:2:1-2:[0-9a-f]{12}$/);

  // 입력 순서 무관성 검증
  const inputOrder1 = [
    { ...rowA, dtlLoc: "위치A" },
    { ...rowA, dtlLoc: "위치B", exitNo: "1" },
  ];
  const inputOrder2 = [
    { ...rowA, dtlLoc: "위치B", exitNo: "1" },
    { ...rowA, dtlLoc: "위치A" },
  ];

  const canonicalMappings = [
    { railOprIsttCd: "KR", lnCd: "4", stinCd: "448", stationId: "station-sangnoksu", lineId: "seoul-4" },
  ];

  const res1 = buildStationElevatorPaths({
    elevatorRows: inputOrder1,
    movementRows: [],
    canonicalMappings,
  });
  const res2 = buildStationElevatorPaths({
    elevatorRows: inputOrder2,
    movementRows: [],
    canonicalMappings,
  });

  const ids1 = res1.facilities.map((f) => f.id).sort();
  const ids2 = res2.facilities.map((f) => f.id).sort();
  const expectedSortedIds = [
    "kric-elev:KR:4:448:1:1-2:1b26d29c105d",
    "kric-elev:KR:4:448:2:1-2:e36473dd25d9",
  ];
  assert.deepEqual(ids1, expectedSortedIds);
  assert.deepEqual(ids2, expectedSortedIds);
});

test("(2) 같은 조합 중복이 '식별 불가'로 빠진다", () => {
  const duplicateRows = [
    {
      railOprIsttCd: "KR",
      lnCd: "4",
      stinCd: "448",
      exitNo: "2",
      runStinFlorFr: 1,
      runStinFlorTo: 2,
      dtlLoc: "동일위치엘리베이터",
    },
    {
      railOprIsttCd: "KR",
      lnCd: "4",
      stinCd: "448",
      exitNo: "2",
      runStinFlorFr: 1,
      runStinFlorTo: 2,
      dtlLoc: "동일위치엘리베이터",
    },
    {
      railOprIsttCd: "KR",
      lnCd: "4",
      stinCd: "448",
      exitNo: "1",
      runStinFlorFr: 1,
      runStinFlorTo: 2,
      dtlLoc: "정상엘리베이터",
    },
  ];

  const canonicalMappings = [
    { railOprIsttCd: "KR", lnCd: "4", stinCd: "448", stationId: "station-sangnoksu", lineId: "seoul-4" },
  ];

  const result = buildStationElevatorPaths({
    elevatorRows: duplicateRows,
    movementRows: [],
    canonicalMappings,
  });

  // 중복 조합 2개 행 모두 식별 불가로 제외
  assert.equal(result.facilities.length, 1);
  assert.equal(result.facilities[0].exitNo, "1");
  assert.equal(result.unidentifiableFacilities.length, 2);
  assert.equal(result.unidentifiableFacilities[0].reason, "DUPLICATE_COMBINATION");
});

test("(3) 경로 단계와 시설이 정확 일치로만 연결된다", () => {
  const elevatorRows = [
    {
      railOprIsttCd: "KR",
      lnCd: "4",
      stinCd: "448",
      exitNo: "2",
      grndDvNmFr: "지상",
      runStinFlorFr: 1,
      grndDvNmTo: "지상",
      runStinFlorTo: 2,
      dtlLoc: "(1층)표내는곳내반월방향계단옆",
    },
  ];

  const movementRows = [
    // 완전 일치 경로: 2번 출입구 및 1층-2층 엘리베이터
    {
      railOprIsttCd: "KR",
      lnCd: "4",
      stinCd: "448",
      mvPathMgNo: 1,
      mvPathDvCd: "1",
      mvPathDvNm: "출입구-승강장",
      mvTpOrdr: 1,
      mvDst: null,
      mvContDtl: "1) 2번 출입구",
    },
    {
      railOprIsttCd: "KR",
      lnCd: "4",
      stinCd: "448",
      mvPathMgNo: 1,
      mvPathDvCd: "1",
      mvPathDvNm: "출입구-승강장",
      mvTpOrdr: 2,
      mvDst: null,
      mvContDtl: "2) 반월방면 지상1층 엘리베이터 탑승 후 지상2층 하차",
    },
    // 불완전 연결 경로: 3번 출입구 (매칭되는 3번 출입구 엘리베이터 없음)
    {
      railOprIsttCd: "KR",
      lnCd: "4",
      stinCd: "448",
      mvPathMgNo: 2,
      mvPathDvCd: "1",
      mvPathDvNm: "출입구-승강장",
      mvTpOrdr: 1,
      mvDst: null,
      mvContDtl: "1) 3번 출입구",
    },
    {
      railOprIsttCd: "KR",
      lnCd: "4",
      stinCd: "448",
      mvPathMgNo: 2,
      mvPathDvCd: "1",
      mvPathDvNm: "출입구-승강장",
      mvTpOrdr: 2,
      mvDst: null,
      mvContDtl: "2) 3번 엘리베이터 탑승",
    },
  ];

  const canonicalMappings = [
    { railOprIsttCd: "KR", lnCd: "4", stinCd: "448", stationId: "station-sangnoksu", lineId: "seoul-4" },
  ];

  const result = buildStationElevatorPaths({
    elevatorRows,
    movementRows,
    canonicalMappings,
  });

  // 경로 1 단계 2는 elevatorRows[0]과 정확 매칭되어 facilityId 연결
  const path1Steps = result.paths.filter((p) => p.path_id === "path-station-sangnoksu-seoul-4-1");
  const goldenFacilityId = "kric-elev:KR:4:448:2:1-2:0b219253cb54";
  assert.equal(result.facilities[0].id, goldenFacilityId);
  assert.equal(path1Steps[0].facility_id, null); // 출입구 단계
  assert.equal(path1Steps[1].facility_id, goldenFacilityId); // 엘리베이터 단계 매칭 성공

  // 경로 2 단계 2는 일치하는 엘리베이터가 없으므로 facilityId = null
  const path2Steps = result.paths.filter((p) => p.path_id === "path-station-sangnoksu-seoul-4-2");
  assert.equal(path2Steps[1].facility_id, null);

  // 경로 완성도 상태 검증
  const path1Info = result.pathSummaries.find((s) => s.pathId === "path-station-sangnoksu-seoul-4-1");
  const path2Info = result.pathSummaries.find((s) => s.pathId === "path-station-sangnoksu-seoul-4-2");
  assert.equal(path1Info.isComplete, true);
  assert.equal(path2Info.isComplete, false);
});

test("(4) 매핑 없는 역이 제외 목록에 오른다", () => {
  const elevatorRows = [
    {
      railOprIsttCd: "KR",
      lnCd: "4",
      stinCd: "999", // 없는 역
      exitNo: "1",
      runStinFlorFr: 1,
      runStinFlorTo: 2,
      dtlLoc: "알수없는역",
    },
  ];

  const canonicalMappings = [
    { railOprIsttCd: "KR", lnCd: "4", stinCd: "448", stationId: "station-sangnoksu", lineId: "seoul-4" },
  ];

  const result = buildStationElevatorPaths({
    elevatorRows,
    movementRows: [],
    canonicalMappings,
  });

  assert.equal(result.facilities.length, 0);
  assert.equal(result.excludedStations.length, 1);
  assert.equal(result.excludedStations[0].tuple, "KR/4/999");
  assert.equal(result.excludedStations[0].reason, "MAPPING_NOT_FOUND");
});

test("(5) 고아 facilityId에서 빌드가 실패한다", () => {
  const facilities = [
    { id: "kric-elev:KR:4:448:1:1-2:abcdef123456" },
  ];
  const pathsWithOrphan = [
    {
      path_id: "path-1",
      step: 1,
      facility_id: "kric-elev:KR:4:448:999:orphan-id",
    },
  ];

  assert.throws(
    () => validateStationElevatorPathsIntegrity({ facilities, paths: pathsWithOrphan }),
    /station_elevator_path contains orphan facility_id: kric-elev:KR:4:448:999:orphan-id/,
  );

  const pathsWithoutOrphan = [
    {
      path_id: "path-1",
      step: 1,
      facility_id: "kric-elev:KR:4:448:1:1-2:abcdef123456",
    },
    {
      path_id: "path-1",
      step: 2,
      facility_id: null,
    },
  ];

  assert.doesNotThrow(
    () => validateStationElevatorPathsIntegrity({ facilities, paths: pathsWithoutOrphan }),
  );
});

test("커버리지 리포트가 역별 및 전체 합계를 정확히 집계한다", () => {
  const report = buildStationElevatorCoverageReport({
    facilities: [
      { stationId: "station-a", lineId: "seoul-4", id: "fac-1" },
      { stationId: "station-a", lineId: "seoul-4", id: "fac-2" },
      { stationId: "station-b", lineId: "seoul-2", id: "fac-3" },
    ],
    pathSummaries: [
      { stationId: "station-a", lineId: "seoul-4", pathId: "p-1", isComplete: true },
      { stationId: "station-a", lineId: "seoul-4", pathId: "p-2", isComplete: false },
      { stationId: "station-b", lineId: "seoul-2", pathId: "p-3", isComplete: true },
    ],
    excludedStations: [
      { tuple: "KR/4/999", reason: "MAPPING_NOT_FOUND" },
    ],
    unidentifiableFacilities: [
      { tuple: "S1/2/201", reason: "DUPLICATE_COMBINATION" },
    ],
  });

  assert.equal(report.summary.totalFacilities, 3);
  assert.equal(report.summary.totalPaths, 3);
  assert.equal(report.summary.totalCompletePaths, 2);
  assert.equal(report.summary.totalExcludedStations, 1);
  assert.equal(report.summary.totalUnidentifiableFacilities, 1);
  assert.equal(report.byStationLine.length, 2);
});
