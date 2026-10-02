import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  KRIC_SUBWAY_TIMETABLE_ENDPOINT,
  collectKricStationTimetables,
  formatCollectionError,
  responsesFromCollection,
  runKricStationTimetableCollection,
} from "./collect-kric-station-timetables.mjs";
import { buildApiStationTimetableTrips } from "./lib/kric-station-timetable-api-trips.mjs";

const KEY = "SECRET-KRIC-KEY-123";
const BINDING = Object.freeze({
  mreaWideCd: "01", lnCd: "T1", lineId: "line-api", routeIdPrefix: "route-kric-api-t1",
  stations: [["TT", "T01", "가역"], ["TT", "T02", "나역"]], stationAliases: {}, aliasEvidence: {},
});

function fakeFetch({ status = 200, code = (dayCd) => (dayCd === "7" ? "03" : "00"), body } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, init });
    const p = Object.fromEntries(parsed.searchParams);
    const rows = p.dayCd === "7" ? [] : [{ railOprIsttCd: p.railOprIsttCd, trnNo: `X${p.dayCd}`, dayCd: p.dayCd, dayNm: "평일",
      stinCd: p.stinCd, lnCd: p.lnCd, arvTm: p.stinCd === "T01" ? null : "060300", dptTm: p.stinCd === "T01" ? "060000" : null }];
    const resultCode = code(p.dayCd, p.stinCd);
    const text = body ? body(p) : JSON.stringify({ header: { resultCnt: rows.length, resultCode, resultMsg: "x" }, body: resultCode === "00" ? rows : [] });
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  };
  return { impl, calls };
}

const clock = () => {
  let tick = Date.parse("2026-10-03T03:00:00.000Z");
  return () => new Date(tick += 1000);
};

test("역 × 요일코드(7·8·9)마다 한 번씩 요청하고 키 없이 원본 응답과 해시를 보존한다", async () => {
  const { impl, calls } = fakeFetch();
  const artifact = await collectKricStationTimetables({ bindings: [BINDING], serviceKey: KEY, fetchImpl: impl, now: clock() });
  assert.equal(calls.length, 6);
  assert.deepEqual(calls.map(({ url }) => `${url.origin}${url.pathname}`), Array(6).fill(KRIC_SUBWAY_TIMETABLE_ENDPOINT));
  assert.deepEqual(calls.map(({ url }) => [url.searchParams.get("stinCd"), url.searchParams.get("dayCd")]),
    [["T01", "7"], ["T01", "8"], ["T01", "9"], ["T02", "7"], ["T02", "8"], ["T02", "9"]]);
  assert.ok(calls.every(({ url, init }) => url.searchParams.get("serviceKey") === KEY && url.searchParams.get("format") === "json" && init.redirect === "error"));
  const serialized = JSON.stringify(artifact);
  assert.equal(serialized.includes(KEY), false);
  assert.equal(artifact.artifactKind, "kric-station-timetable-collection");
  assert.equal(artifact.sourceId, "kric-subway-timetable");
  assert.equal(artifact.credentialRedacted, true);
  assert.equal(artifact.capturedAt, "2026-10-03T03:00:01.000Z");
  assert.equal(artifact.collectedAt, "2026-10-03T03:00:02.000Z");
  assert.deepEqual(artifact.responses[0].params, { railOprIsttCd: "TT", lnCd: "T1", stinCd: "T01", dayCd: "7", format: "json" });
  assert.equal(artifact.responses[1].resultCode, "00");
  assert.equal(artifact.responses[1].rowCount, 1);
  const decoded = responsesFromCollection(artifact, { bindings: [BINDING] });
  assert.equal(decoded.length, 6);
  assert.deepEqual(decoded[1], { railOprIsttCd: "TT", lnCd: "T1", stinCd: "T01", stinNm: "가역", dayCd: "8", resultCode: "00",
    rows: [{ railOprIsttCd: "TT", trnNo: "X8", dayCd: "8", dayNm: "평일", stinCd: "T01", lnCd: "T1", arvTm: null, dptTm: "060000" }] });
  const { trips } = buildApiStationTimetableTrips({ responses: decoded, bindings: [BINDING] });
  assert.deepEqual(trips.map(({ providerTripKey, serviceDayKind }) => [providerTripKey, serviceDayKind]),
    [["T1|X8|8|ASC", "WEEKDAY"], ["T1|X9|9|ASC", "SATURDAY_SUNDAY_HOLIDAY"]]);
});

test("HTTP 실패·거부 결과코드·JSON 아님은 재시도 없이 명시적으로 실패한다", async () => {
  await assert.rejects(collectKricStationTimetables({ bindings: [BINDING], serviceKey: KEY, fetchImpl: fakeFetch({ status: 500 }).impl, now: clock() }),
    /KRIC_HTTP_FAILED: T1 T01 dayCd=7 status=500/u);
  await assert.rejects(collectKricStationTimetables({ bindings: [BINDING], serviceKey: KEY, fetchImpl: fakeFetch({ code: () => "30" }).impl, now: clock() }),
    /KRIC_RESULT_REJECTED: T1 T01 dayCd=7 code=30/u);
  await assert.rejects(collectKricStationTimetables({ bindings: [BINDING], serviceKey: KEY, fetchImpl: fakeFetch({ body: () => "<html>" }).impl, now: clock() }),
    /KRIC_RESPONSE_NOT_JSON: T1 T01 dayCd=7/u);
  await assert.rejects(collectKricStationTimetables({ bindings: [BINDING], serviceKey: "", fetchImpl: fakeFetch().impl, now: clock() }),
    /KRIC_SERVICE_KEY_REQUIRED/u);
});

test("응답 본문에 키가 섞여 오면 산출물을 만들지 않는다", async () => {
  const echo = fakeFetch({ body: () => JSON.stringify({ header: { resultCode: "03", note: KEY }, body: [] }) });
  await assert.rejects(collectKricStationTimetables({ bindings: [BINDING], serviceKey: KEY, fetchImpl: echo.impl, now: clock() }), /CREDENTIAL_LEAK/u);
});

test("보관본 재해석은 본문 해시·요청 식별이 맞지 않으면 실패한다", async () => {
  const artifact = await collectKricStationTimetables({ bindings: [BINDING], serviceKey: KEY, fetchImpl: fakeFetch().impl, now: clock() });
  const tampered = structuredClone(artifact);
  tampered.responses[1].bodyBase64 = Buffer.from(JSON.stringify({ header: { resultCode: "00" }, body: [] })).toString("base64");
  assert.throws(() => responsesFromCollection(tampered, { bindings: [BINDING] }), /RESPONSE_BODY_DIGEST_MISMATCH: T1 T01 dayCd=8/u);
  const unknown = structuredClone(artifact);
  unknown.responses[0].params.stinCd = "T99";
  assert.throws(() => responsesFromCollection(unknown, { bindings: [BINDING] }), /RESPONSE_STATION_UNBOUND: T1 T99/u);
  assert.throws(() => responsesFromCollection({ ...artifact, credentialRedacted: false }, { bindings: [BINDING] }), /COLLECTION_ENVELOPE_INVALID/u);
});

test("CLI 실행은 환경 변수 키만 쓰고 새 파일로만 기록한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kric-station-collect-"));
  try {
    const output = path.join(directory, "collection.json");
    const expected = { totalTrips: 2, lines: { "line-api": { lnCd: "T1", weekdayTrips: 1, holidayTrips: 1, quarantined: 0, weekdayEqualsHoliday: false } } };
    const changed = { totalTrips: 3, lines: { "line-api": { ...expected.lines["line-api"], holidayTrips: 2 } } };
    await assert.rejects(runKricStationTimetableCollection(["--output", output],
      { env: { KRIC_SERVICE_KEY: KEY }, bindings: [BINDING], fetchImpl: fakeFetch().impl, now: clock(), expected: changed }), /EXPECTED_OBSERVATION_CHANGED: line-api holidayTrips 1/u);
    await assert.rejects(readFile(output), /ENOENT/u);
    const summary = await runKricStationTimetableCollection(["--output", output],
      { env: { KRIC_SERVICE_KEY: KEY }, bindings: [BINDING], fetchImpl: fakeFetch().impl, now: clock(), expected });
    assert.deepEqual(summary, { output, responses: 6, trips: { "line-api": { lnCd: "T1", trips: 2, quarantined: 0 } } });
    const written = await readFile(output, "utf8");
    assert.equal(written.includes(KEY), false);
    await assert.rejects(runKricStationTimetableCollection(["--output", output],
      { env: { KRIC_SERVICE_KEY: KEY }, bindings: [BINDING], fetchImpl: fakeFetch().impl, now: clock(), expected }), /EEXIST/u);
    await assert.rejects(runKricStationTimetableCollection(["--output", "relative.json"], { env: { KRIC_SERVICE_KEY: KEY }, bindings: [BINDING] }), /--output <absolute new file>/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("키는 percent·form 인코딩 형태로 응답에 섞여도 막고, fetch 오류·CLI 출력에는 URL과 키를 남기지 않는다", async () => {
  const special = "ab+cd/ef== z";
  const encodedForms = [encodeURIComponent(special), new URLSearchParams({ k: special }).toString().slice(2)];
  for (const echoed of encodedForms) {
    const echo = fakeFetch({ body: () => JSON.stringify({ header: { resultCode: "03", echo: `serviceKey=${echoed}` }, body: [] }) });
    await assert.rejects(collectKricStationTimetables({ bindings: [BINDING], serviceKey: special, fetchImpl: echo.impl, now: clock() }), /CREDENTIAL_LEAK/u);
  }
  const throwing = async (url) => { throw new Error(`connect ECONNRESET ${url}`); };
  const error = await collectKricStationTimetables({ bindings: [BINDING], serviceKey: special, fetchImpl: throwing, now: clock() }).catch((caught) => caught);
  assert.match(error.message, /^KRIC_FETCH_FAILED: T1 T01 dayCd=7$/u);
  for (const form of [special, ...encodedForms]) assert.equal(error.message.includes(form), false);
  const printed = formatCollectionError(new Error(`boom ${special} ${encodedForms[0]} ${encodedForms[1]}`), { KRIC_SERVICE_KEY: special });
  assert.equal(printed, "boom [REDACTED] [REDACTED] [REDACTED]");
});
