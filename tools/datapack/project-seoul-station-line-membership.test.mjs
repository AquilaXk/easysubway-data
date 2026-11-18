import assert from "node:assert/strict";
import test from "node:test";

import { bindSeoulStationLineMembership } from "./project-seoul-station-line-membership.mjs";

const provider = "서울교통공사";
const base = {
  molitProjection: [{
    region_code: "01", region_name: "수도권", operator_name: provider,
    line_name: "1호선", station_name: "한강역", station_sequence: 1,
  }],
  positionRows: [{ line: "1", stationCode: "150", stationName: "한강" }],
};

test("Seoul membership projector matches primary names and preserves leading-zero source codes", () => {
  const result = bindSeoulStationLineMembership({
    ...base,
    provider,
    rows: [{ STATION_CD: "00150", STATION_NM: "한강역", LINE_NUM: "01호선", FR_CODE: "0001" }],
  });
  assert.deepEqual(result.records.map(({ sourceStationCode, externalStationCode, canonicalStationName }) =>
    ({ sourceStationCode, externalStationCode, canonicalStationName })), [{
    sourceStationCode: "00150", externalStationCode: "0001", canonicalStationName: "한강역",
  }]);
});

test("Seoul membership projector requires explicit parenthetical alias plus position-code conjunction", () => {
  const input = {
    molitProjection: [{
      region_code: "01", region_name: "수도권", operator_name: provider,
      line_name: "1호선", station_name: "서울(한강)", station_sequence: 1,
    }],
    positionRows: [{ line: "01", stationCode: "0150", stationName: "서울" }],
    provider,
    rows: [{ STATION_CD: "150", STATION_NM: "한강", LINE_NUM: "1호선", FR_CODE: "0001" }],
  };
  const result = bindSeoulStationLineMembership(input);
  assert.equal(result.records[0].canonicalStationName, "서울(한강)");
  assert.throws(() => bindSeoulStationLineMembership({ ...input, positionRows: [] }), /unmatched roster station/);
});

test("Seoul membership projector rejects unrelated equal codes and ambiguous source matches", () => {
  assert.throws(() => bindSeoulStationLineMembership({
    ...base,
    provider,
    rows: [{ STATION_CD: "150", STATION_NM: "다른역", LINE_NUM: "1호선", FR_CODE: "0001" }],
  }), /unmatched roster station/);
  assert.throws(() => bindSeoulStationLineMembership({
    molitProjection: [{
      region_code: "01", region_name: "수도권", operator_name: provider,
      line_name: "1호선", station_name: "서울(서울역)", station_sequence: 1,
    }],
    positionRows: [{ line: "1", stationCode: "150", stationName: "서울" }],
    provider,
    rows: [
      { STATION_CD: "0150", STATION_NM: "서울역", LINE_NUM: "1호선", FR_CODE: "0001" },
      { STATION_CD: "150", STATION_NM: "서울역", LINE_NUM: "01호선", FR_CODE: "0002" },
    ],
  }), /ambiguous source matches/);
});
