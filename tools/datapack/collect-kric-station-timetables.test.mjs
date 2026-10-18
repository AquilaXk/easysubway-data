import assert from "node:assert/strict";
import { inspect } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  BODY_TIMEOUT_MS,
  HEADER_TIMEOUT_MS,
  KRIC_SUBWAY_TIMETABLE_ENDPOINT,
  MIN_BODY_THROUGHPUT_BYTES_PER_SECOND,
  OBSERVED_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS,
  collectKricStationTimetables,
  credentialForms,
  formatCollectionError,
  responsesFromCollection,
  runKricStationTimetableCollection,
} from "./collect-kric-station-timetables.mjs";
import { buildApiStationTimetableTrips } from "./lib/kric-station-timetable-api-trips.mjs";
import { defineKricResultCodeRetryTests, defineSourceCollectionRetryTests } from "./lib/source-collection-retry-test-support.mjs";
import { createTransientRetryBudget } from "./lib/transient-retry.mjs";

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

test("#997 헤더 timeout과 본문 수신 한도를 분리하고 시간 초과 시 시크릿 노출 없이 KRIC_TIMEOUT으로 실패한다", { timeout: 5_000 }, async () => {
  assert.equal(HEADER_TIMEOUT_MS, 30_000);
  assert.equal(REQUEST_TIMEOUT_MS, HEADER_TIMEOUT_MS);
  assert.equal(OBSERVED_RESPONSE_BYTES, 90_000);
  assert.equal(MIN_BODY_THROUGHPUT_BYTES_PER_SECOND, 1_500);
  assert.equal(BODY_TIMEOUT_MS, 60_000);

  // (1) 헤더 응답 뒤 본문이 headerTimeoutMs보다 느려도 bodyTimeoutMs 안에 오면 성공한다.
  const baseFetch = fakeFetch().impl;
  const slowArtifact = await collectKricStationTimetables({
    bindings: [BINDING], serviceKey: KEY, now: clock(), headerTimeoutMs: 30, bodyTimeoutMs: 2_000,
    fetchImpl: async (url, init) => {
      const res = await baseFetch(url, init);
      const bytes = Buffer.from(await res.arrayBuffer());
      const body = new ReadableStream({
        async start(controller) {
          await new Promise((resolve) => setTimeout(resolve, 60));
          init.signal?.throwIfAborted();
          controller.enqueue(bytes);
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(slowArtifact.responses.length, 6);

  // (2) 헤더 timeout은 일시 오류라 3회 시도(재시도 2회)를 소진한 뒤 KRIC_TIMEOUT으로 실패하고 키를 노출하지 않는다.
  let headerCalls = 0;
  const headerErr = await collectKricStationTimetables({
    bindings: [BINDING], serviceKey: KEY, now: clock(), headerTimeoutMs: 25, bodyTimeoutMs: 1_000, ...retryOptions(),
    fetchImpl: (url, init) => new Promise((_, reject) => {
      headerCalls += 1;
      init.signal.addEventListener("abort", () => reject(new Error(`timeout ${url}`)));
    }),
  }).catch((caught) => caught);
  assert.match(headerErr.message, /^KRIC_TIMEOUT: T1 T01 dayCd=7$/u);
  assert.equal(headerErr.message.includes(KEY), false);
  assert.equal(headerCalls, 3);

  // (3) 본문 수신 데드라인 초과(처리량 하한)는 재시도하지 않는다. reader를 취소하고 KRIC_TIMEOUT으로 실패한다.
  let cancelled = false;
  let bodyCalls = 0;
  const bodyErr = await collectKricStationTimetables({
    bindings: [BINDING], serviceKey: KEY, now: clock(), headerTimeoutMs: 500, bodyTimeoutMs: 35,
    fetchImpl: async () => {
      bodyCalls += 1;
      return new Response(new ReadableStream({
        pull() { return new Promise(() => {}); },
        cancel() { cancelled = true; },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  }).catch((caught) => caught);
  assert.match(bodyErr.message, /^KRIC_TIMEOUT: T1 T01 dayCd=7$/u);
  assert.equal(bodyErr.message.includes(KEY), false);
  assert.equal(cancelled, true);
  assert.equal(bodyCalls, 1);

  // (4) 잘못된 timeout 인자는 거부한다.
  for (const bad of [0, -1, 1.5, "30"]) {
    await assert.rejects(collectKricStationTimetables({ bindings: [BINDING], serviceKey: KEY, headerTimeoutMs: bad, fetchImpl: baseFetch, now: clock() }), /KRIC_TIMEOUT_INVALID/u);
    await assert.rejects(collectKricStationTimetables({ bindings: [BINDING], serviceKey: KEY, bodyTimeoutMs: bad, fetchImpl: baseFetch, now: clock() }), /KRIC_TIMEOUT_INVALID/u);
  }
});

// 원천 수집 표준 재시도(Refs #870, 계기: source-reverification run 39123145848의 KRIC_FETCH_FAILED: B1 0121 dayCd=7).
const retryOptions = (sleepImpl = async () => {}) => ({
  retrySleepImpl: sleepImpl, retryBudget: createTransientRetryBudget(), retryRandomImpl: () => 0,
});
const collectWithRetry = (fetchImpl, sleepImpl) => collectKricStationTimetables({
  bindings: [BINDING], serviceKey: KEY, fetchImpl, now: clock(), ...retryOptions(sleepImpl),
});

defineSourceCollectionRetryTests({
  name: "KRIC 역별 시간표 수집기",
  httpError: /KRIC_HTTP_FAILED: T1 T01 dayCd=7 status=403/u,
  delegate: fakeFetch().impl,
  run: ({ fetchImpl, sleepImpl }) => collectWithRetry(fetchImpl, sleepImpl),
});

const connectionReset = () => Object.assign(new TypeError(`fetch failed ${KEY}`), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });

test("계기: 첫 요청이 연결 끊김(timeout 아님)으로 실패해도 같은 요청을 다시 보내 정상 수집하고, 소진하면 키 없이 KRIC_FETCH_FAILED로 실패한다", async () => {
  const { impl } = fakeFetch();
  const expected = await collectWithRetry(impl);
  let calls = 0;
  const flaky = async (...args) => { calls += 1; if (calls === 1) throw connectionReset(); return impl(...args); };
  assert.deepEqual(await collectWithRetry(flaky), expected);
  assert.equal(calls, 1 + 6);

  let exhausted = 0;
  const error = await collectWithRetry(async () => { exhausted += 1; throw connectionReset(); }).catch((caught) => caught);
  assert.equal(exhausted, 3);
  assert.equal(error.message, "KRIC_FETCH_FAILED: T1 T01 dayCd=7");
});

test("일시가 아닌 전송 오류는 재시도 없이 KRIC_FETCH_FAILED로 즉시 실패한다", async () => {
  let calls = 0;
  await assert.rejects(collectWithRetry(async () => { calls += 1; throw new Error(`boom ${KEY}`); }), /^Error: KRIC_FETCH_FAILED: T1 T01 dayCd=7$/u);
  assert.equal(calls, 1);
});

test("HTTP 503은 재시도해 성공하고 소진하면 KRIC_HTTP_FAILED로 실패한다", async () => {
  const { impl } = fakeFetch();
  let calls = 0;
  const once503 = async (...args) => (++calls === 1 ? new Response("x", { status: 503 }) : impl(...args));
  assert.equal((await collectWithRetry(once503)).responses.length, 6);
  await assert.rejects(collectWithRetry(async () => new Response("x", { status: 503 })), /KRIC_HTTP_FAILED: T1 T01 dayCd=7 status=503/u);
});

defineKricResultCodeRetryTests({
  name: "KRIC 역별 시간표 수집기",
  rejectedResponse: (resultCode) => new Response(JSON.stringify({ header: { resultCode, resultMsg: "x" }, body: [] }), { status: 200 }),
  delegate: fakeFetch().impl,
  run: ({ fetchImpl }) => collectWithRetry(fetchImpl),
  assertRecovered: (artifact) => assert.equal(artifact.responses.length, 6),
  assertFinal: (outcome, resultCode) => assert.rejects(outcome, new RegExp(`KRIC_RESULT_REJECTED: T1 T01 dayCd=7 code=${resultCode}`, "u")),
});

test("재시도 시간 예산이 소진되면 다음 요청은 재시도 없이 원래 오류로 실패한다", async () => {
  const { impl } = fakeFetch();
  let calls = 0;
  // random 0.5 → 첫 재시도 대기 1,000ms, 두 번째 2,000ms. 예산 1,500ms는 첫 재시도만 허용한다.
  const failOnCalls = new Set([1, 3]);
  const fetchImpl = async (...args) => { calls += 1; if (failOnCalls.has(calls)) throw connectionReset(); return impl(...args); };
  const error = await collectKricStationTimetables({
    bindings: [BINDING], serviceKey: KEY, fetchImpl, now: clock(),
    retrySleepImpl: async () => {}, retryBudget: createTransientRetryBudget(1_500), retryRandomImpl: () => 0.5,
  }).catch((caught) => caught);
  assert.equal(error.message, "KRIC_FETCH_FAILED: T1 T01 dayCd=8");
  assert.equal(calls, 3, "T01 dayCd=7은 1회 재시도로 성공, 다음 요청은 예산이 없어 재시도하지 않는다");
});

test("Retry-After가 cap(20초)을 넘으면 기다리지 않고 실패하고, 던진 오류는 키가 든 Response를 들고 나가지 않는다", async () => {
  let calls = 0;
  const sleeps = [];
  const fetchImpl = async (url) => {
    calls += 1;
    return Object.defineProperty(new Response("busy", { status: 429, headers: { "retry-after": "300" } }), "url", { value: String(url) });
  };
  const error = await collectKricStationTimetables({
    bindings: [BINDING], serviceKey: KEY, fetchImpl, now: clock(),
    retrySleepImpl: async (ms) => { sleeps.push(ms); }, retryBudget: createTransientRetryBudget(), retryRandomImpl: () => 0,
  }).catch((caught) => caught);
  assert.equal(error.code, "RETRY_AFTER_EXCEEDS_CAP");
  assert.match(error.message, /^KRIC subwayTimetable T1 T01 dayCd=7 HTTP 429: RETRY_AFTER_EXCEEDS_CAP retryAfterSeconds=300 capSeconds=20/u);
  assert.deepEqual([calls, sleeps], [1, []]);
  for (const form of credentialForms(KEY)) assert.equal(inspect(error, { depth: 8, showHidden: true }).includes(form), false);
});
