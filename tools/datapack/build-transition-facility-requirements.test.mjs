import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFacilityId,
  buildTransitionFacilityRequirements,
  buildTransitionCoverageReport,
  validateRequirementsIntegrity,
} from "./build-transition-facility-requirements.mjs";

const elv = (stnCd, dtlPstn, oprtngSitu, stnNm = "역", lineNm = "2호선") => ({
  stnCd,
  stnNm,
  lineNm,
  dtlPstn,
  oprtngSitu,
});

const trn = (transitionKey, edgeType, stationCode, extra = {}) => ({
  transitionKey,
  edgeType,
  stationId: `station-${stationCode}`,
  stationCode,
  lineId: "seoul-2",
  ...extra,
});

const req = (transition_key, segment, facility_id) => ({
  transition_key,
  segment,
  facility_id,
});

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
    elv("0249", "출입구-대합실", "M", "신정네거리"),
    elv("0249", "출입구-대합실", "S", "신정네거리"),
    elv("0249", "대합실-승강장", "M", "신정네거리"),
    elv("0202", "대합실-승강장", "M", "을지로입구"),
    elv("0202", "삭제 승강기", "D", "을지로입구"),
    elv("0226", "2호선-4호선 환승통로", "M", "사당"),
  ];

  const transitions = [
    trn("edge-entry-sinjeong-seoul-2", "ENTRY", "0249"),
    trn("edge-exit-sinjeong-seoul-2", "EXIT", "0249"),
    trn("edge-entry-euljiro-seoul-2", "ENTRY", "0202"),
    trn("edge-entry-unsupported", "ENTRY", "9999"),
    trn("edge-transfer-sadang-2-4", "IN_STATION_TRANSFER", "0226", { fromLineId: "seoul-2", toLineId: "seoul-4" }),
  ];

  const result = buildTransitionFacilityRequirements({
    elevatorRecords,
    transitions,
  });

  const expected = [
    req("edge-entry-euljiro-seoul-2", "대합실-승강장", "seoul:0202:대합실-승강장:1"),
    req("edge-entry-sinjeong-seoul-2", "대합실-승강장", "seoul:0249:대합실-승강장:1"),
    req("edge-entry-sinjeong-seoul-2", "출입구-대합실", "seoul:0249:출입구-대합실:1"),
    req("edge-entry-sinjeong-seoul-2", "출입구-대합실", "seoul:0249:출입구-대합실:2"),
    req("edge-exit-sinjeong-seoul-2", "대합실-승강장", "seoul:0249:대합실-승강장:1"),
    req("edge-exit-sinjeong-seoul-2", "출입구-대합실", "seoul:0249:출입구-대합실:1"),
    req("edge-exit-sinjeong-seoul-2", "출입구-대합실", "seoul:0249:출입구-대합실:2"),
    req("edge-transfer-sadang-2-4", "환승통로", "seoul:0226:2호선-4호선 환승통로:1"),
  ];

  assert.deepEqual(result, expected);
});

test("oprtngSitu 가 D인 삭제 시설은 매핑에서 완전 제외된다", () => {
  const elevatorRecords = [
    elv("0202", "삭제 승강기 1", "D", "을지로입구"),
    elv("0202", "삭제 승강기 2", "D", "을지로입구"),
  ];
  const transitions = [trn("edge-entry-euljiro-seoul-2", "ENTRY", "0202")];

  const result = buildTransitionFacilityRequirements({
    elevatorRecords,
    transitions,
  });

  assert.equal(result.length, 0);
});

test("근거가 없는 전환에는 어떤 행도 생성하지 않는다 (추정 매핑 원천 금지)", () => {
  const elevatorRecords = [elv("0249", "출입구-대합실", "M", "신정네거리")];
  const transitions = [trn("edge-entry-other", "ENTRY", "0999")];

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
      req("edge-entry-1", "대합실-승강장", "seoul:0249:대합실-승강장:1"),
    ], { validTransitions, validFacilities });
  });

  // 고아 transition_key
  assert.throws(() => {
    validateRequirementsIntegrity([
      req("orphan-transition", "대합실-승강장", "seoul:0249:대합실-승강장:1"),
    ], { validTransitions, validFacilities });
  }, /orphan transition_key/);

  // 고아 facility_id
  assert.throws(() => {
    validateRequirementsIntegrity([
      req("edge-entry-1", "대합실-승강장", "orphan-facility"),
    ], { validTransitions, validFacilities });
  }, /orphan facility_id/);
});

test("buildTransitionCoverageReport는 전환 수 대비 매핑 전환 수 및 역·노선별 통계를 출력한다", () => {
  const requirements = [
    req("edge-entry-sinjeong-seoul-2", "대합실-승강장", "seoul:0249:대합실-승강장:1"),
    req("edge-entry-sinjeong-seoul-2", "출입구-대합실", "seoul:0249:출입구-대합실:1"),
    req("edge-exit-sinjeong-seoul-2", "대합실-승강장", "seoul:0249:대합실-승강장:1"),
  ];

  const transitions = [
    trn("edge-entry-sinjeong-seoul-2", "ENTRY", "0249", { stationName: "신정네거리", lineName: "2호선" }),
    trn("edge-exit-sinjeong-seoul-2", "EXIT", "0249", { stationName: "신정네거리", lineName: "2호선" }),
    trn("edge-entry-unmapped", "ENTRY", "0999", { stationName: "미매핑역", lineName: "2호선" }),
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
