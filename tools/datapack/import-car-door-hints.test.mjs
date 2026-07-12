import assert from "node:assert/strict";
import test from "node:test";

import { buildCarDoorHints } from "./import-car-door-hints.mjs";

const roster = [
  { stationId: "sadang", lineId: "line-4", nameKo: "사당", normalizedName: "사당", lineNameKo: "4호선", aliases: [] },
  { stationId: "seoul-station", lineId: "line-1", nameKo: "서울역", normalizedName: "서울", lineNameKo: "1호선", aliases: [{ alias: "서울역(1)", normalizedAlias: "서울" }] },
];

function carDoorRow(overrides = {}) {
  return {
    crtrYmd: "20260101",
    lineNm: "4호선",
    stnCd: "0433",
    stnNm: "사당",
    stnNo: "433",
    qckgffVhclDoorNo: "3-2",
    upbdnbSe: "상행",
    plfmCmgFac: "계단",
    facPstnNm: "1번출구 계단",
    ...overrides,
  };
}

test("정상 파싱 → station_car_door_hint 적재 (시간 필드 없음)", () => {
  const result = buildCarDoorHints({ roster, rows: [carDoorRow()], sourceId: "src", verificationStatus: "OFFICIAL" });
  assert.equal(result.stationCarDoorHints.length, 1);
  const hint = result.stationCarDoorHints[0];
  assert.equal(hint.stationId, "sadang");
  assert.equal(hint.lineId, "line-4");
  assert.equal(hint.direction, "UP");
  assert.equal(hint.targetFacilityType, "STAIR");
  assert.equal(hint.carNumber, 3);
  assert.equal(hint.doorNumber, 2);
  assert.equal(hint.provenanceKind, "OFFICIAL");
  assert.equal(hint.sourceId, "src");
  assert.equal(result.quarantine.length, 0);
  // 시간 관련 필드가 절대 생성되지 않는지 확인.
  const timeKeys = Object.keys(hint).filter((k) => /second|duration|time|minute/i.test(k));
  assert.deepEqual(timeKeys, []);
});

test("병기역명 alias 매칭 성공", () => {
  const result = buildCarDoorHints({
    roster,
    rows: [carDoorRow({ stnNm: "서울역(1)", lineNm: "1호선" })],
  });
  assert.equal(result.stationCarDoorHints.length, 1);
  assert.equal(result.stationCarDoorHints[0].stationId, "seoul-station");
});

test("qckgffVhclDoorNo 형식 오류(구분자 없음) → quarantine", () => {
  const result = buildCarDoorHints({ roster, rows: [carDoorRow({ qckgffVhclDoorNo: "32" })] });
  assert.equal(result.stationCarDoorHints.length, 0);
  assert.equal(result.quarantine.length, 1);
  assert.match(result.quarantine[0].reason, /format invalid/);
});

test("qckgffVhclDoorNo 비숫자 → quarantine", () => {
  const result = buildCarDoorHints({ roster, rows: [carDoorRow({ qckgffVhclDoorNo: "3-a" })] });
  assert.equal(result.quarantine.length, 1);
  assert.match(result.quarantine[0].reason, /numeric/);
});

test("car 번호 범위밖(>10) → quarantine", () => {
  const result = buildCarDoorHints({ roster, rows: [carDoorRow({ qckgffVhclDoorNo: "11-2" })] });
  assert.equal(result.stationCarDoorHints.length, 0);
  assert.match(result.quarantine[0].reason, /car number out of range/);
});

test("door 번호 범위밖(>4) → quarantine", () => {
  const result = buildCarDoorHints({ roster, rows: [carDoorRow({ qckgffVhclDoorNo: "3-5" })] });
  assert.equal(result.stationCarDoorHints.length, 0);
  assert.match(result.quarantine[0].reason, /door number out of range/);
});

test("direction 매핑 성공: 하행 → DOWN", () => {
  const result = buildCarDoorHints({ roster, rows: [carDoorRow({ upbdnbSe: "하행" })] });
  assert.equal(result.stationCarDoorHints[0].direction, "DOWN");
});

test("direction 매핑 실패 → quarantine", () => {
  const result = buildCarDoorHints({ roster, rows: [carDoorRow({ upbdnbSe: "알수없음" })] });
  assert.equal(result.stationCarDoorHints.length, 0);
  assert.match(result.quarantine[0].reason, /direction mapping failed/);
});

test("facility 매핑 성공: 엘리베이터 → ELEVATOR", () => {
  const result = buildCarDoorHints({ roster, rows: [carDoorRow({ plfmCmgFac: "엘리베이터", facPstnNm: "" })] });
  assert.equal(result.stationCarDoorHints[0].targetFacilityType, "ELEVATOR");
});

test("facility 매핑 성공: 환승 → TRANSFER", () => {
  const result = buildCarDoorHints({ roster, rows: [carDoorRow({ plfmCmgFac: "환승통로", facPstnNm: "" })] });
  assert.equal(result.stationCarDoorHints[0].targetFacilityType, "TRANSFER");
});

test("facility 매핑 실패 → quarantine", () => {
  const result = buildCarDoorHints({ roster, rows: [carDoorRow({ plfmCmgFac: "미상시설", facPstnNm: "미상" })] });
  assert.equal(result.stationCarDoorHints.length, 0);
  assert.match(result.quarantine[0].reason, /facility type mapping failed/);
});

test("역명 매칭 실패 → quarantine", () => {
  const result = buildCarDoorHints({ roster, rows: [carDoorRow({ stnNm: "없는역" })] });
  assert.equal(result.stationCarDoorHints.length, 0);
  assert.match(result.quarantine[0].reason, /station roster match failed/);
});

test("같은 위치라도 provider 관리번호가 다르면 서로 다른 안정 ID를 만든다", () => {
  const rows = [
    carDoorRow({ qckgffMngNo: "quick-1", facNo: "facility-1" }),
    carDoorRow({ qckgffMngNo: "quick-2", facNo: "facility-2" }),
  ];
  const first = buildCarDoorHints({ roster, rows });
  const second = buildCarDoorHints({ roster, rows });
  assert.equal(first.stationCarDoorHints.length, 2);
  assert.notEqual(first.stationCarDoorHints[0].id, first.stationCarDoorHints[1].id);
  assert.deepEqual(
    first.stationCarDoorHints.map((hint) => hint.id),
    second.stationCarDoorHints.map((hint) => hint.id),
  );
});

test("provider 관리번호가 없는 동일 semantic row는 첫 행만 유지하고 중복을 보고한다", () => {
  const result = buildCarDoorHints({ roster, rows: [carDoorRow(), carDoorRow({ crtrYmd: "20260102" })] });
  assert.equal(result.stationCarDoorHints.length, 1);
  assert.equal(result.duplicateReport.length, 1);
  assert.equal(result.duplicateReport[0].id, result.stationCarDoorHints[0].id);
});
