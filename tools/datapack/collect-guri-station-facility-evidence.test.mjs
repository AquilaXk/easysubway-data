import assert from "node:assert/strict";
import test from "node:test";

import {
  collectGuriStationFacilityEvidence,
  validateGuriStationUrl,
} from "./collect-guri-station-facility-evidence.mjs";

const gaps = {
  schemaVersion: 1,
  artifactKind: "kric-accessibility-provider-gap-evidence",
  sourceId: "kric-station-convenience-standard",
  observedAt: "2026-07-29T20:16:45.595Z",
  workflowRunUrl: "https://github.com/AquilaXk/easysubway/actions/runs/30487251281",
  resultCodeInterpretation: "UNDEFINED_NOT_ABSENCE",
  gaps: [
    { railOprIsttCd: "GU", lnCd: "8", stinCd: "2805", resultCode: "03" },
    { railOprIsttCd: "GU", lnCd: "8", stinCd: "2807", resultCode: "03" },
    { railOprIsttCd: "GU", lnCd: "8", stinCd: "2808", resultCode: "03" },
  ],
};

const routeRosters = {
  schemaVersion: 1,
  artifactKind: "kric-nationwide-route-roster-snapshot",
  sourceId: "kric-subway-route-info",
  capturedAt: "2026-07-30T20:39:26.676Z",
  rosters: [{ stations: [
    { railOprIsttCd: "GU", lnCd: "8", stinCd: "2805", stinNm: "구리" },
    { railOprIsttCd: "GU", lnCd: "8", stinCd: "2807", stinNm: "동구릉" },
    { railOprIsttCd: "GU", lnCd: "8", stinCd: "2808", stinNm: "장자호수공원" },
  ] }],
};

const page = (stationName, elevatorCount, escalatorCount) => `
  <html><body>
    <h3>${stationName}역</h3>
    <table><tr><th>승강기 안내</th><td>엘리베이터 ${elevatorCount}대, 에스컬레이터 ${escalatorCount}대</td></tr>
    <tr><th>운영기관</th><td>구리도시공사 교통사업부</td></tr></table>
  </body></html>`;

test("구리시청 세 station page를 exact GU tuple evidence로 고정한다", async () => {
  const pages = new Map([
    ["7196", page("장자호수공원", 4, 20)],
    ["7231", page("구리", 6, 11)],
    ["7232", page("동구릉", 4, 18)],
  ]);
  const evidence = await collectGuriStationFacilityEvidence({
    gapEvidence: gaps,
    routeRosters,
    now: new Date("2026-07-31T00:00:00.000Z"),
    fetchImpl: async (url) => new Response(pages.get(url.searchParams.get("key"))),
  });

  assert.equal(evidence.capturedAt, "2026-07-31T00:00:00.000Z");
  assert.equal(evidence.rowCount, 3);
  assert.deepEqual(evidence.records.map(({ providerTuple, stationName, elevatorCount }) => (
    { providerTuple, stationName, elevatorCount }
  )), [
    { providerTuple: "GU/8/2805", stationName: "구리", elevatorCount: 6 },
    { providerTuple: "GU/8/2807", stationName: "동구릉", elevatorCount: 4 },
    { providerTuple: "GU/8/2808", stationName: "장자호수공원", elevatorCount: 4 },
  ]);
  assert.ok(evidence.records.every(({ operatorName, rawSha256, providerRecordHash }) => (
    operatorName === "구리도시공사 교통사업부"
      && /^[0-9a-f]{64}$/.test(rawSha256)
      && /^[0-9a-f]{64}$/.test(providerRecordHash)
  )));
  assert.match(evidence.contentSha256, /^[0-9a-f]{64}$/);
  assert.match(evidence.schemaFingerprint, /^[0-9a-f]{64}$/);
});

test("URL·title·operator drift를 snapshot 전에 거부한다", async () => {
  assert.throws(
    () => validateGuriStationUrl(new URL("https://example.com/www/contents.do?key=7196")),
    /official Guri station URL is invalid/,
  );
  await assert.rejects(() => collectGuriStationFacilityEvidence({
    gapEvidence: gaps,
    routeRosters,
    fetchImpl: async () => new Response(page("다른역", 1, 1)),
  }), /official Guri station page is invalid/);
  await assert.rejects(() => collectGuriStationFacilityEvidence({
    gapEvidence: {
      ...gaps,
      gaps: [...gaps.gaps, { railOprIsttCd: "GU", lnCd: "8", stinCd: "2810", resultCode: "03" }],
    },
    routeRosters,
    fetchImpl: async () => assert.fail("unexpected request"),
  }), /official Guri gap set is invalid/);
  await assert.rejects(() => collectGuriStationFacilityEvidence({
    gapEvidence: {
      ...gaps,
      gaps: [...gaps.gaps, { railOprIsttCd: "GU", lnCd: "9", stinCd: "9001", resultCode: "03" }],
    },
    routeRosters,
    fetchImpl: async () => assert.fail("unexpected request"),
  }), /official Guri gap set is invalid/);
});
