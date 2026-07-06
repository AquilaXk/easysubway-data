import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCollectionContext } from "./collect-kric-line4-timetables.mjs";
import { normalizeKricSubwayTimetable } from "./normalize-kric-timetable.mjs";
import { reconstructTransitTrips } from "./reconstruct-transit-trips.mjs";

const ROSTER = {
  lnCd: "4",
  stations: [
    { stinConsOrdr: 28, stinCd: "433", railOprIsttCd: "S1", stinNm: "사당" },
    { stinConsOrdr: 29, stinCd: "434", railOprIsttCd: "S1", stinNm: "남태령" },
    { stinConsOrdr: 43, stinCd: "448", railOprIsttCd: "KR", stinNm: "상록수" },
  ],
};

test("buildCollectionContext는 로스터로 재구성 코어 context를 만든다", () => {
  const ctx = buildCollectionContext(ROSTER, "seoul-4");
  assert.equal(ctx.stationIdByProviderStation["S1|4|433"], "station-seoul-4-433");
  assert.equal(ctx.stationIdByProviderStation["KR|4|448"], "station-seoul-4-448");
  assert.equal(ctx.lineIdByProviderLine["S1|4"], "seoul-4");
  assert.equal(ctx.lineIdByProviderLine["KR|4"], "seoul-4");
  assert.equal(ctx.lineSequenceByStationLine["station-seoul-4-433|seoul-4"], 28);
  assert.equal(ctx.routeIdByLineDirection["seoul-4|up"], "route-seoul-4-up");
  assert.equal(ctx.serviceIdByDayCd["8"], "weekday-kric");
});

test("KRIC 응답→context→normalizer→코어가 직결(같은 trnNo)을 온전한 trip으로 잇는다", () => {
  const ctx = buildCollectionContext(ROSTER, "seoul-4");
  // 같은 trnNo가 사당(S1 조회)·상록수(KR 조회) 응답에 각각 등장(직결)
  const sadangRows = [{ railOprIsttCd: "S1", trnNo: "4719", dayCd: "8", stinCd: "433", lnCd: "4", arvTm: "084830", dptTm: "084900" }];
  const sangnoksuRows = [{ railOprIsttCd: "KR", trnNo: "4719", dayCd: "8", stinCd: "448", lnCd: "4", arvTm: "092930", dptTm: "093000" }];
  const rows = [
    ...normalizeKricSubwayTimetable(sadangRows, ctx),
    ...normalizeKricSubwayTimetable(sangnoksuRows, ctx),
  ];
  const { transitTrips, transitStopTimes } = reconstructTransitTrips(rows, ctx);
  assert.equal(transitTrips.length, 1);
  assert.equal(transitStopTimes.length, 2); // 사당 + 상록수 한 trip으로 연결
  assert.equal(transitTrips[0].serviceId, "weekday-kric");
});
