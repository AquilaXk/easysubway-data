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

test("#834 원천 교체: stationMovement 표준·getFcElvtr만 운영 사용 승격 기록을 가진다", async () => {
  const { readFile } = await import("node:fs/promises");
  const document = JSON.parse(await readFile(new URL("./source-candidates.json", import.meta.url), "utf8"));
  const byId = new Map(document.candidates.map((candidate) => [candidate.id, candidate]));
  const expectedFacility = {
    status: "SUPPORTED",
    productionUseAllowed: true,
    coverageStatus: "SERVER_ROUTE_BUNDLE_STATION_ELEVATOR_PATH",
    updateFrequency: "번들 입력 스냅샷 수집 시 1회",
    unsupportedNotes: "production use is limited to the server route bundle station elevator path tables built from committed raw-archived snapshots",
  };
  for (const [id, usePermissionRange] of [
    ["kric-station-movement-standard", "저작권표시"],
    ["seoul-metro-facility-location", "이용허락범위 제한 없음"],
  ]) {
    const candidate = byId.get(id);
    assert.deepEqual(candidate.capabilities.facility, expectedFacility, id);
    const admission = candidate.evidence.productionUseAdmission;
    assert.deepEqual({
      issue: admission.issue,
      decision: admission.decision,
      approvedBy: admission.approvedBy,
      approvedAt: admission.approvedAt,
      scope: admission.scope,
      productionUseAllowed: admission.productionUseAllowed,
      usePermissionRange: admission.license.usePermissionRange,
      selfImposedCallLimit: admission.quota.selfImposedCallLimit,
    }, {
      issue: 834,
      decision: "APPROVED",
      approvedBy: "AquilaXk",
      approvedAt: "2026-09-30",
      scope: "SERVER_ROUTE_BUNDLE_STATION_ELEVATOR_PATH",
      productionUseAllowed: true,
      usePermissionRange,
      selfImposedCallLimit: "NONE",
    }, id);
    assert.equal(typeof admission.rationale, "string", id);
    assert.equal(typeof admission.license.attributionLocation, "string", id);
    assert.equal(typeof admission.relationToExistingSources, "string", id);
    assert.ok(Object.keys(admission.fieldMapping).length > 0, id);
  }
  for (const id of ["kric-station-elevator", "kric-station-elevator-movement", "kric-station-movement-detailed"]) {
    assert.equal(byId.get(id).capabilities.facility.productionUseAllowed, false, id);
    assert.equal(byId.get(id).evidence.productionUseAdmission, undefined, id);
  }
});

test("#834 커밋된 stationMovement·getFcElvtr snapshot은 수집기 raw 보관본·manifest로 재검증된다", async () => {
  const { readFile, access } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const { validateKricExitPathObservation } = await import("./collect-kric-exit-path-provider-snapshot.mjs");
  const { validateSeoulAccessibilityObservation } = await import("./collect-seoul-accessibility-evidence.mjs");
  const repository = new URL("../../", import.meta.url);
  const read = (relative) => readFile(new URL(relative, repository));
  const manifest = JSON.parse(await read("tools/datapack/release/station-elevator-path-inputs.json"));
  const pinned = async (relative, sha256) => {
    const bytes = await read(relative);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256, relative);
    return bytes;
  };
  const load = async (entry) => ({
    observation: JSON.parse(await pinned(entry.observationPath, entry.observationSha256)),
    snapshotBytes: await pinned(entry.snapshotPath, entry.snapshotSha256),
    rawBytes: await pinned(entry.rawCollectionPath, entry.rawCollectionSha256),
  });

  const movement = await load(manifest.movement);
  const movementSnapshot = validateKricExitPathObservation({
    observation: movement.observation,
    snapshotBytes: movement.snapshotBytes,
    rawCollectionBytes: movement.rawBytes,
  });
  assert.deepEqual({
    sourceId: movementSnapshot.sourceId,
    capturedAt: movement.observation.capturedAt,
    queryCount: movement.observation.queryCount,
    rowCount: movement.observation.rowCount,
    resultStateCounts: movement.observation.resultStateCounts,
  }, {
    sourceId: "kric-station-movement-standard",
    capturedAt: "2026-09-30T01:43:34.118Z",
    queryCount: 420,
    rowCount: 3785,
    resultStateCounts: { EXPLICIT_ZERO: 0, PROVIDER_NO_DATA: 40, PROVIDER_RESULT_UNVERIFIED: 0, ROWS_OBSERVED: 380 },
  });

  const facility = await load(manifest.facilityLocation);
  const facilitySnapshot = validateSeoulAccessibilityObservation({
    observation: facility.observation,
    snapshotBytes: facility.snapshotBytes,
    rawArtifactBytes: facility.rawBytes,
    source: "facility-location",
  });
  assert.deepEqual({
    sourceId: facilitySnapshot.sourceId,
    capturedAt: facilitySnapshot.capturedAt,
    rowCount: facilitySnapshot.rowCount,
    previousSnapshotId: facilitySnapshot.previousSnapshotId,
  }, {
    sourceId: "seoul-metro-facility-location",
    capturedAt: "2026-09-30T01:43:41.846Z",
    rowCount: 865,
    previousSnapshotId: "seoul-metro-facility-location-20260730T214010816Z",
  });
  await pinned(manifest.canonicalMapping.snapshotPath, manifest.canonicalMapping.snapshotSha256);

  for (const retired of [
    "tools/datapack/sources/kric-station-elevator-20260930T000000000Z.json",
    "tools/datapack/sources/kric-station-elevator-movement-20260930T000000000Z.json",
  ]) {
    await assert.rejects(access(new URL(retired, repository)), { code: "ENOENT" }, retired);
  }
});
