import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFacilityId,
  buildTransitionFacilityRequirements,
  buildTransitionCoverageReport,
  validateRequirementsIntegrity,
} from "./build-transition-facility-requirements.mjs";

test("buildFacilityId는 stnCd와 dtlPstn과 1-based 순번으로 결정론적 고유 식별자를 생성한다", () => {
  assert.equal(
    buildFacilityId({ stnCd: "0249", dtlPstn: "대합실-승강장", sequence: 1 }),
    "seoul:0249:대합실-승강장:1",
  );
  assert.equal(
    buildFacilityId({ stnCd: "0249", dtlPstn: "대합실-승강장", sequence: 2 }),
    "seoul:0249:대합실-승강장:2",
  );
  assert.equal(
    buildFacilityId({ stnCd: "0249", dtlPstn: "출입구-대합실", sequence: 1 }),
    "seoul:0249:출입구-대합실:1",
  );
  // 공백 정규화
  assert.equal(
    buildFacilityId({ stnCd: " 0249 ", dtlPstn: " 출입구-대합실 ", sequence: 1 }),
    "seoul:0249:출입구-대합실:1",
  );
});

test("buildTransitionFacilityRequirements는 고정 입력에 대해 하드코딩된 기대 행을 결정론적으로 생성한다", () => {
  const elevatorRecords = [
    { stnCd: "0249", stnNm: "신정네거리", lineNm: "2호선", dtlPstn: "출입구-대합실", oprtngSitu: "M" },
    { stnCd: "0249", stnNm: "신정네거리", lineNm: "2호선", dtlPstn: "출입구-대합실", oprtngSitu: "S" },
    { stnCd: "0249", stnNm: "신정네거리", lineNm: "2호선", dtlPstn: "대합실-승강장", oprtngSitu: "M" },
    { stnCd: "0202", stnNm: "을지로입구", lineNm: "2호선", dtlPstn: "대합실-승강장", oprtngSitu: "M" },
    { stnCd: "0202", stnNm: "을지로입구", lineNm: "2호선", dtlPstn: "삭제 승강기", oprtngSitu: "D" },
    { stnCd: "0226", stnNm: "사당", lineNm: "2호선", dtlPstn: "2호선-4호선 환승통로", oprtngSitu: "M" },
  ];

  const transitions = [
    {
      transitionKey: "edge-entry-sinjeong-seoul-2",
      edgeType: "ENTRY",
      stationId: "station-sinjeong",
      stationCode: "0249",
      lineId: "seoul-2",
    },
    {
      transitionKey: "edge-exit-sinjeong-seoul-2",
      edgeType: "EXIT",
      stationId: "station-sinjeong",
      stationCode: "0249",
      lineId: "seoul-2",
    },
    {
      transitionKey: "edge-entry-euljiro-seoul-2",
      edgeType: "ENTRY",
      stationId: "station-euljiro",
      stationCode: "0202",
      lineId: "seoul-2",
    },
    {
      transitionKey: "edge-entry-unsupported",
      edgeType: "ENTRY",
      stationId: "station-unsupported",
      stationCode: "9999",
      lineId: "seoul-2",
    },
    {
      transitionKey: "edge-transfer-sadang-2-4",
      edgeType: "IN_STATION_TRANSFER",
      stationId: "station-sadang",
      stationCode: "0226",
      fromLineId: "seoul-2",
      toLineId: "seoul-4",
    },
  ];

  const result = buildTransitionFacilityRequirements({
    elevatorRecords,
    transitions,
  });

  const expected = [
    {
      transition_key: "edge-entry-euljiro-seoul-2",
      segment: "대합실-승강장",
      facility_id: "seoul:0202:대합실-승강장:1",
    },
    {
      transition_key: "edge-entry-sinjeong-seoul-2",
      segment: "대합실-승강장",
      facility_id: "seoul:0249:대합실-승강장:1",
    },
    {
      transition_key: "edge-entry-sinjeong-seoul-2",
      segment: "출입구-대합실",
      facility_id: "seoul:0249:출입구-대합실:1",
    },
    {
      transition_key: "edge-entry-sinjeong-seoul-2",
      segment: "출입구-대합실",
      facility_id: "seoul:0249:출입구-대합실:2",
    },
    {
      transition_key: "edge-exit-sinjeong-seoul-2",
      segment: "대합실-승강장",
      facility_id: "seoul:0249:대합실-승강장:1",
    },
    {
      transition_key: "edge-exit-sinjeong-seoul-2",
      segment: "출입구-대합실",
      facility_id: "seoul:0249:출입구-대합실:1",
    },
    {
      transition_key: "edge-exit-sinjeong-seoul-2",
      segment: "출입구-대합실",
      facility_id: "seoul:0249:출입구-대합실:2",
    },
    {
      transition_key: "edge-transfer-sadang-2-4",
      segment: "환승통로",
      facility_id: "seoul:0226:2호선-4호선 환승통로:1",
    },
  ];

  assert.deepEqual(result, expected);
});

test("oprtngSitu 가 D인 삭제 시설은 매핑에서 완전 제외된다", () => {
  const elevatorRecords = [
    { stnCd: "0202", stnNm: "을지로입구", lineNm: "2호선", dtlPstn: "삭제 승강기 1", oprtngSitu: "D" },
    { stnCd: "0202", stnNm: "을지로입구", lineNm: "2호선", dtlPstn: "삭제 승강기 2", oprtngSitu: "D" },
  ];
  const transitions = [
    {
      transitionKey: "edge-entry-euljiro-seoul-2",
      edgeType: "ENTRY",
      stationId: "station-euljiro",
      stationCode: "0202",
      lineId: "seoul-2",
    },
  ];

  const result = buildTransitionFacilityRequirements({
    elevatorRecords,
    transitions,
  });

  assert.equal(result.length, 0);
});

test("근거가 없는 전환에는 어떤 행도 생성하지 않는다 (추정 매핑 원천 금지)", () => {
  const elevatorRecords = [
    { stnCd: "0249", stnNm: "신정네거리", lineNm: "2호선", dtlPstn: "출입구-대합실", oprtngSitu: "M" },
  ];
  const transitions = [
    {
      transitionKey: "edge-entry-other",
      edgeType: "ENTRY",
      stationId: "station-other",
      stationCode: "0999",
      lineId: "seoul-2",
    },
  ];

  const result = buildTransitionFacilityRequirements({
    elevatorRecords,
    transitions,
  });

  assert.equal(result.length, 0);
});

test("validateRequirementsIntegrity는 고아 transition_key 또는 고아 facility_id 검출 시 실패한다", () => {
  const validTransitions = new Set(["edge-entry-1", "edge-exit-1"]);
  const validFacilities = new Set(["seoul:0249:대합실-승강장:1"]);

  // 정상 케이스 통과
  assert.doesNotThrow(() => {
    validateRequirementsIntegrity([
      { transition_key: "edge-entry-1", segment: "대합실-승강장", facility_id: "seoul:0249:대합실-승강장:1" },
    ], { validTransitions, validFacilities });
  });

  // 고아 transition_key
  assert.throws(() => {
    validateRequirementsIntegrity([
      { transition_key: "orphan-transition", segment: "대합실-승강장", facility_id: "seoul:0249:대합실-승강장:1" },
    ], { validTransitions, validFacilities });
  }, /orphan transition_key/);

  // 고아 facility_id
  assert.throws(() => {
    validateRequirementsIntegrity([
      { transition_key: "edge-entry-1", segment: "대합실-승강장", facility_id: "orphan-facility" },
    ], { validTransitions, validFacilities });
  }, /orphan facility_id/);
});

test("buildTransitionCoverageReport는 전환 수 대비 매핑 전환 수 및 역·노선별 통계를 출력한다", () => {
  const requirements = [
    { transition_key: "edge-entry-sinjeong-seoul-2", segment: "대합실-승강장", facility_id: "seoul:0249:대합실-승강장:1" },
    { transition_key: "edge-entry-sinjeong-seoul-2", segment: "출입구-대합실", facility_id: "seoul:0249:출입구-대합실:1" },
    { transition_key: "edge-exit-sinjeong-seoul-2", segment: "대합실-승강장", facility_id: "seoul:0249:대합실-승강장:1" },
  ];

  const transitions = [
    { transitionKey: "edge-entry-sinjeong-seoul-2", edgeType: "ENTRY", stationId: "station-sinjeong", stationName: "신정네거리", lineId: "seoul-2", lineName: "2호선" },
    { transitionKey: "edge-exit-sinjeong-seoul-2", edgeType: "EXIT", stationId: "station-sinjeong", stationName: "신정네거리", lineId: "seoul-2", lineName: "2호선" },
    { transitionKey: "edge-entry-unmapped", edgeType: "ENTRY", stationId: "station-unmapped", stationName: "미매핑역", lineId: "seoul-2", lineName: "2호선" },
  ];

  const report = buildTransitionCoverageReport({
    requirements,
    transitions,
  });

  assert.equal(report.totalTransitions, 3);
  assert.equal(report.mappedTransitions, 2);
  assert.equal(report.coverageRatio, "66.67%");
  assert.equal(report.byEdgeType.ENTRY.total, 2);
  assert.equal(report.byEdgeType.ENTRY.mapped, 1);
  assert.equal(report.byEdgeType.EXIT.total, 1);
  assert.equal(report.byEdgeType.EXIT.mapped, 1);
  assert.ok(typeof report.formattedText === "string");
  assert.ok(report.formattedText.includes("66.67%"));
});
