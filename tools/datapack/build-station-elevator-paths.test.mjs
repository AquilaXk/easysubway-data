import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSmrtElevatorFacilityId,
  buildStationElevatorPaths,
  canonicalMappingsFromConvenienceSnapshot,
  parseElevatorLocation,
  parseMovementDirection,
  parseMovementStartExit,
  validateStationElevatorPathsIntegrity,
} from "./build-station-elevator-paths.mjs";

// fixture는 원천 응답 형식(stationMovement 행, getFcElvtr snapshot, 편의시설 표준 canonicalMappings)을 손으로 옮긴 것이다.
const CANONICAL_MAPPINGS = [
  { stationId: "station-a", lineId: "seoul-2", railOprIsttCd: "S1", lnCd: "2", stinCd: "201" },
  { stationId: "station-b", lineId: "seoul-2", railOprIsttCd: "S1", lnCd: "2", stinCd: "202" },
  { stationId: "station-z", lineId: "seoul-2", railOprIsttCd: "S1", lnCd: "2", stinCd: "200" },
  { stationId: "station-a", lineId: "seoul-4", railOprIsttCd: "S1", lnCd: "4", stinCd: "201" },
  { stationId: "station-k", lineId: "seoul-4", railOprIsttCd: "KR", lnCd: "4", stinCd: "448" },
];

function facilityRow(pathDescription) {
  return { operational: true, situationCode: "M", situation: "사용가능", pathDescription };
}

function facilitySnapshot(stations) {
  return {
    sourceId: "seoul-metro-facility-location",
    snapshotId: "seoul-metro-facility-location-20260930T010203004Z",
    capturedAt: "2026-09-30T01:02:03.004Z",
    observedAt: "2026-09-30T01:02:03.004Z",
    stations,
  };
}

const FACILITY_STATIONS = [{
  stationName: "가역",
  lineName: "2호선",
  providerStationCode: "0201",
  facilities: [
    facilityRow("9번 출입구"),
    facilityRow("9,10번 출입구 사이"),
    facilityRow("나역 방면2-3"),
    facilityRow("나역 방면 5-1, 다역 방면2-2"),
    facilityRow("대합실"),
    facilityRow("환승통로(나역 방면2-3)"),
    facilityRow("3번 출입구"),
    facilityRow(" 3번  출입구"),
  ],
}, {
  stationName: "가역",
  lineName: "4호선",
  providerStationCode: "0201",
  facilities: [facilityRow("9번 출입구"), facilityRow("나역 방면1-1")],
}, {
  stationName: "칠호선역",
  lineName: "7호선",
  providerStationCode: "0701",
  facilities: [facilityRow("1번 출입구")],
}, {
  stationName: "공항역",
  lineName: "공항철도",
  providerStationCode: "4201",
  facilities: [facilityRow("1번 출입구")],
}];

function movementRow(mvPathMgNo, exitMvTpOrdr, stMovePath, edMovePath, mvContDtl = `${exitMvTpOrdr}) 이동`) {
  return { edMovePath, elvtSttCd: null, elvtTpCd: null, exitMvTpOrdr, imgPath: "", mvContDtl, mvPathMgNo, stMovePath };
}

function query(queryId, providerStationId, providerNextStationId) {
  return {
    queryId,
    routeEdgeId: `edge-${providerStationId}-${providerNextStationId}`,
    providerOperatorId: "S1",
    providerLineId: "2",
    providerStationId,
    providerNextStationId,
    operatorName: "서울교통공사",
    lineName: "수도권 2호선",
    stationName: "가역",
    regionId: "capital",
  };
}

function movementSnapshot() {
  return {
    sourceId: "kric-station-movement-standard",
    snapshotId: "kric-station-movement-standard-20260930T010000000Z",
    queryPlan: [
      query("q-a-b", "201", "202"),
      query("q-a-z", "201", "200"),
      query("q-a-x", "201", "299"),
      query("q-b-a", "202", "201"),
    ],
    results: [{
      queryId: "q-a-b",
      state: "ROWS_OBSERVED",
      rows: [
        movementRow(1, 1, "9번 출입구 옆 엘리베이터", "나역 방면", "1) 9번 출입구 옆 엘리베이터로 이동"),
        movementRow(1, 2, "9번 출입구 옆 엘리베이터", "나역 방면", "2) 12번 출입구 엘리베이터 지나 개집표기 통과"),
        movementRow(1, 3, "9번 출입구 옆 엘리베이터", "나역 방면", "3) 엘리베이터 이용 승강장"),
        movementRow(2, 1, "11번 출입구 엘리베이터", "나역 방면"),
        movementRow(2, 2, "11번 출입구 엘리베이터", "나역 방면"),
        movementRow(3, 1, "9번/10번 출입구 사이 엘리베이터", "나역 방면"),
        movementRow(4, 1, "9번 출입구 옆 엘리베이터", "나역 방면 승강장"),
        movementRow(5, 1, "9번 출입구 옆 엘리베이터", "나역 방면"),
        movementRow(5, 1, "9번 출입구 옆 엘리베이터", "나역 방면", "중복 순서"),
      ],
    }, {
      queryId: "q-a-z",
      state: "ROWS_OBSERVED",
      rows: [
        movementRow(1, 1, "3번 출입구 옆 엘리베이터", "자역 방면"),
        movementRow(1, 2, "3번 출입구 옆 엘리베이터", "자역 방면"),
      ],
    }, {
      queryId: "q-a-x",
      state: "ROWS_OBSERVED",
      rows: [movementRow(1, 1, "9번 출입구 옆 엘리베이터", "엑스 방면")],
    }, {
      queryId: "q-b-a",
      state: "PROVIDER_NO_DATA",
      rows: [],
    }],
  };
}

function build(overrides = {}) {
  return buildStationElevatorPaths({
    movementSnapshot: movementSnapshot(),
    facilitySnapshot: facilitySnapshot(FACILITY_STATIONS),
    canonicalMappings: CANONICAL_MAPPINGS,
    ...overrides,
  });
}

test("(1) smrt-elev 시설 id는 원천 속성의 결정론적 조합이고 입력 순서를 바꿔도 같다", () => {
  assert.equal(
    buildSmrtElevatorFacilityId({ providerStationCode: "0201", lineCode: "2", pathDescription: "  9번   출입구 " }),
    "smrt-elev:0201:2:9번 출입구",
  );
  const forward = build();
  const reversed = build({
    facilitySnapshot: facilitySnapshot([...FACILITY_STATIONS].reverse().map((station) => ({
      ...station,
      facilities: [...station.facilities].reverse(),
    }))),
  });
  assert.deepEqual(forward.facilities, reversed.facilities);
  assert.deepEqual(forward.facilities.map(({ id, stationId, lineId }) => ({ id, stationId, lineId })), [
    { id: "smrt-elev:0201:2:9,10번 출입구 사이", stationId: "station-a", lineId: "seoul-2" },
    { id: "smrt-elev:0201:2:9번 출입구", stationId: "station-a", lineId: "seoul-2" },
    { id: "smrt-elev:0201:2:나역 방면 5-1, 다역 방면2-2", stationId: "station-a", lineId: "seoul-2" },
    { id: "smrt-elev:0201:2:나역 방면2-3", stationId: "station-a", lineId: "seoul-2" },
    { id: "smrt-elev:0201:4:9번 출입구", stationId: "station-a", lineId: "seoul-4" },
    { id: "smrt-elev:0201:4:나역 방면1-1", stationId: "station-a", lineId: "seoul-4" },
  ]);
});

test("(2) 같은 id 중복·문법 밖 위치·매핑 없음·노선 형식 불일치는 사유별로 제외한다", () => {
  const { exclusions } = build();
  assert.deepEqual(exclusions.facilities.map(({ reason, facilityId, provider }) => ({
    reason, facilityId: facilityId ?? null, pathDescription: provider.pathDescription, lineName: provider.lineName,
  })).sort((left, right) => `${left.reason}${left.pathDescription}${left.lineName}`.localeCompare(`${right.reason}${right.pathDescription}${right.lineName}`)), [
    { reason: "LINE_OR_CODE_FORMAT_MISMATCH", facilityId: null, pathDescription: "1번 출입구", lineName: "공항철도" },
    { reason: "MAPPING_NOT_FOUND", facilityId: "smrt-elev:0701:7:1번 출입구", pathDescription: "1번 출입구", lineName: "7호선" },
    { reason: "UNIDENTIFIABLE_DUPLICATE", facilityId: "smrt-elev:0201:2:3번 출입구", pathDescription: " 3번  출입구", lineName: "2호선" },
    { reason: "UNIDENTIFIABLE_DUPLICATE", facilityId: "smrt-elev:0201:2:3번 출입구", pathDescription: "3번 출입구", lineName: "2호선" },
    { reason: "UNIDENTIFIABLE_FORMAT", facilityId: null, pathDescription: "대합실", lineName: "2호선" },
    { reason: "UNIDENTIFIABLE_FORMAT", facilityId: null, pathDescription: "환승통로(나역 방면2-3)", lineName: "2호선" },
  ]);
});

test("위치 문법은 출입구 번호 집합과 방면·칸 위치만 받아들인다", () => {
  assert.deepEqual(parseElevatorLocation("9번 출입구"), { kind: "EXIT", exitNumbers: ["9"] });
  assert.deepEqual(parseElevatorLocation("10,9번 출입구 사이"), { kind: "EXIT", exitNumbers: ["9", "10"] });
  assert.deepEqual(parseElevatorLocation("나역 방면 5-1, 다역 방면2-2"), {
    kind: "DIRECTION",
    directions: [{ label: "나역", carPosition: "5-1" }, { label: "다역", carPosition: "2-2" }],
  });
  assert.deepEqual(parseElevatorLocation("동대문(1) 방면2-3"), {
    kind: "DIRECTION", directions: [{ label: "동대문(1)", carPosition: "2-3" }],
  });
  for (const value of ["대합실", "9번 출입구(대합실 내)", "신내, 봉화산 방면4-1", "명일 방면1-1, 2-2 사이", "환승통로(나역 방면2-3)", "9-1번 출입구"]) {
    assert.equal(parseElevatorLocation(value), null, value);
  }
});

test("F2: 경로 단위는 (역, 노선, 다음 역, mvPathMgNo)라 같은 관리번호도 방향별로 충돌하지 않는다", () => {
  const { paths, pathSummaries } = build();
  const stepKeys = paths.map(({ path_id: pathId, step }) => `${pathId}#${step}`);
  assert.equal(new Set(stepKeys).size, stepKeys.length);
  assert.deepEqual(pathSummaries.map(({ pathId, stationId, nextStationId, stepCount }) => ({ pathId, stationId, nextStationId, stepCount })), [
    { pathId: "kric-mv:S1:2:201:202:1", stationId: "station-a", nextStationId: "station-b", stepCount: 3 },
    { pathId: "kric-mv:S1:2:201:202:2", stationId: "station-a", nextStationId: "station-b", stepCount: 2 },
    { pathId: "kric-mv:S1:2:201:200:1", stationId: "station-a", nextStationId: "station-z", stepCount: 2 },
  ]);
  assert.deepEqual(paths.filter(({ path_id: pathId }) => pathId === "kric-mv:S1:2:201:202:1").map(({ step, detail }) => ({ step, detail })), [
    { step: 1, detail: "1) 9번 출입구 옆 엘리베이터로 이동" },
    { step: 2, detail: "2) 12번 출입구 엘리베이터 지나 개집표기 통과" },
    { step: 3, detail: "3) 엘리베이터 이용 승강장" },
  ]);
});

test("F3: 방향은 요청한 nextStinCd와 edMovePath에서만 오고 형식이 다르면 제외한다", () => {
  assert.equal(parseMovementDirection("을지로입구 방면"), "을지로입구");
  assert.equal(parseMovementDirection(" 을지로입구방면"), "을지로입구");
  assert.equal(parseMovementDirection("을지로입구 방면 승강장"), null);
  assert.equal(parseMovementDirection("1번 출입구"), null);
  assert.equal(parseMovementStartExit("9번 출입구 옆 엘리베이터"), "9");
  assert.equal(parseMovementStartExit(" 9번 출입구 근처 엘리베이터 "), "9");
  for (const value of ["9번/10번 출입구 사이 엘리베이터", "9-1번 출입구 옆 엘리베이터", "9번출입구 옆 엘리베이터", "지상1층 엘리베이터"]) {
    assert.equal(parseMovementStartExit(value), null, value);
  }
  const { paths, exclusions } = build();
  assert.deepEqual([...new Set(paths.map(({ path_id: pathId, next_station_id: next, exit_no: exitNo, platform_direction: direction }) => `${pathId}|${next}|${exitNo}|${direction}`))], [
    "kric-mv:S1:2:201:202:1|station-b|9|나역",
    "kric-mv:S1:2:201:202:2|station-b|11|나역",
    "kric-mv:S1:2:201:200:1|station-z|3|자역",
  ]);
  assert.deepEqual(exclusions.paths.map(({ reason, pathId, queryId }) => ({ reason, id: pathId ?? queryId })), [
    { reason: "START_FORMAT_MISMATCH", id: "kric-mv:S1:2:201:202:3" },
    { reason: "DIRECTION_FORMAT_MISMATCH", id: "kric-mv:S1:2:201:202:4" },
    { reason: "STEP_ORDER_INVALID", id: "kric-mv:S1:2:201:202:5" },
    { reason: "MAPPING_NOT_FOUND", id: "q-a-x" },
  ]);
});

test("F4: 경로 요구 묶음은 같은 역·노선 시설의 출입구·방면 원천 값 정확 일치로만 잇는다", () => {
  const { pathFacilities, pathSummaries } = build();
  assert.deepEqual(pathFacilities, [
    { path_id: "kric-mv:S1:2:201:202:1", group_kind: "EXIT", facility_id: "smrt-elev:0201:2:9,10번 출입구 사이" },
    { path_id: "kric-mv:S1:2:201:202:1", group_kind: "EXIT", facility_id: "smrt-elev:0201:2:9번 출입구" },
    { path_id: "kric-mv:S1:2:201:202:1", group_kind: "DIRECTION", facility_id: "smrt-elev:0201:2:나역 방면 5-1, 다역 방면2-2" },
    { path_id: "kric-mv:S1:2:201:202:1", group_kind: "DIRECTION", facility_id: "smrt-elev:0201:2:나역 방면2-3" },
    { path_id: "kric-mv:S1:2:201:202:2", group_kind: "DIRECTION", facility_id: "smrt-elev:0201:2:나역 방면 5-1, 다역 방면2-2" },
    { path_id: "kric-mv:S1:2:201:202:2", group_kind: "DIRECTION", facility_id: "smrt-elev:0201:2:나역 방면2-3" },
  ]);
  assert.deepEqual(pathSummaries.map(({ pathId, linkageComplete }) => ({ pathId, linkageComplete })), [
    { pathId: "kric-mv:S1:2:201:202:1", linkageComplete: true },
    { pathId: "kric-mv:S1:2:201:202:2", linkageComplete: false },
    { pathId: "kric-mv:S1:2:201:200:1", linkageComplete: false },
  ]);
});

test("(5) 고아 facility_id·path_id는 무결성 검사에서 실패한다", () => {
  const facilities = [{ id: "smrt-elev:0201:2:9번 출입구" }];
  const paths = [{ path_id: "kric-mv:S1:2:201:202:1", step: 1 }];
  assert.throws(() => validateStationElevatorPathsIntegrity({
    facilities, paths, pathFacilities: [{ path_id: "kric-mv:S1:2:201:202:1", group_kind: "EXIT", facility_id: "smrt-elev:0201:2:8번 출입구" }],
  }), /orphan facility_id: smrt-elev:0201:2:8번 출입구/);
  assert.throws(() => validateStationElevatorPathsIntegrity({
    facilities, paths, pathFacilities: [{ path_id: "kric-mv:S1:2:201:202:9", group_kind: "EXIT", facility_id: "smrt-elev:0201:2:9번 출입구" }],
  }), /orphan path_id: kric-mv:S1:2:201:202:9/);
});

test("(4) 역 매핑은 편의시설 표준 canonicalMappings만 쓰고 모호하면 거부한다", () => {
  const snapshot = {
    sourceId: "kric-station-convenience-standard",
    artifactKind: "kric-accessibility-snapshot",
    queries: [{
      stationId: "station-a", lineId: "seoul-2", railOprIsttCd: "S1", lnCd: "2", stinCd: "201",
      canonicalMappings: [{ artifactId: "bundled-capital", stationId: "station-a", lineId: "seoul-2" }],
      rows: [],
    }],
  };
  assert.deepEqual(canonicalMappingsFromConvenienceSnapshot(snapshot), [
    { stationId: "station-a", lineId: "seoul-2", railOprIsttCd: "S1", lnCd: "2", stinCd: "201" },
  ]);
  const ambiguous = structuredClone(snapshot);
  ambiguous.queries.push({ ...structuredClone(snapshot.queries[0]), stationId: "station-b",
    canonicalMappings: [{ artifactId: "bundled-capital", stationId: "station-b", lineId: "seoul-2" }] });
  assert.throws(() => canonicalMappingsFromConvenienceSnapshot(ambiguous), /canonical mapping is ambiguous/);
  const mismatched = structuredClone(snapshot);
  mismatched.queries[0].canonicalMappings[0].stationId = "station-z";
  assert.throws(() => canonicalMappingsFromConvenienceSnapshot(mismatched), /canonical mapping is invalid/);
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
