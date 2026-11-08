import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  RESULT_CODE_TABLE,
  RETRY_AFTER_EXCEEDS_CAP,
  SOURCE_COLLECTION_RETRY_POLICY,
  classifyDataGoResultCode,
  classifySeoulOpenDataResultCode,
  fetchBytesWithSourceRetry,
  isRetryAfterExceedsCap,
  isTransientDataGoKrResultCode,
  isTransientKricResultCode,
  seoulOpenDataResultCodeOf,
  transportFailureWithCode,
  withRequestInterval,
  withSourceCollectionRetry,
} from "./source-collection-retry.mjs";
import { assertErrorOmitsSecrets } from "./source-collection-retry-test-support.mjs";
import { defaultHttpGetBuffer } from "./source-candidate-evidence-collector.mjs";
import { createTransientRetryBudget } from "./transient-retry.mjs";
import { collectSeoulPlatformGap } from "../collect-seoul-metro-platform-gap.mjs";
import { collectSeoulMetroCongestion } from "../collect-seoul-metro-congestion.mjs";
import { collectSeoulStationContact } from "../collect-seoul-metro-station-contact.mjs";
import {
  DEFAULT_JOURNEY_GOLDEN_DIFF_DECLARATION_PATH,
  computeChangedQueriesSummarySha256,
  formatJourneyGoldenDiffEvidenceLine,
  runCandidateJourneyGoldenDiff,
  validateCandidateJourneyGoldenDiffReport,
} from "../run-candidate-journey-golden-diff.mjs";

// 원천 수집 표준 정책(data #1334): 최대 3회 시도, full jitter base 2s·cap 20s, Retry-After 우선(cap 초과는 fail-closed), 429는 힌트 없으면 1회만.
const timeoutError = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
const response = (status, headers = {}) => {
  const cancelled = { value: false };
  const received = new Response(null, { status, headers });
  Object.defineProperty(received, "body", { value: { cancel: async () => { cancelled.value = true; } } });
  return Object.assign(received, { cancelled });
};
const http = (status, headers) => () => ({ response: response(status, headers) });
const ok = () => ({ response: response(200) });
const failure = (error) => () => { throw error; };

async function run(script, options = {}) {
  const sleeps = [];
  const results = [];
  let calls = 0;
  const attempt = async () => {
    const step = script[calls];
    calls += 1;
    const result = step();
    results.push(result);
    return result;
  };
  let outcome;
  try {
    outcome = { result: await withSourceCollectionRetry(attempt, {
      random: () => 0.5, sleep: async (ms) => { sleeps.push(ms); }, budget: createTransientRetryBudget(), ...options,
    }) };
  } catch (error) {
    outcome = { error };
  }
  return { ...outcome, calls, sleeps, results };
}

test("정책 상수: 3회 시도, base 2초, cap 20초, 429·500·502·503·504만 일시 상태", () => {
  assert.deepEqual({ ...SOURCE_COLLECTION_RETRY_POLICY, transientStatuses: [...SOURCE_COLLECTION_RETRY_POLICY.transientStatuses] }, {
    maxAttempts: 3, baseDelayMs: 2_000, capDelayMs: 20_000, transientStatuses: [429, 500, 502, 503, 504], maxUnhintedRateLimitRetries: 1,
  });
});

const CASES = [
  { name: "timeout 1회 뒤 성공: 대기는 full jitter(0.5 × 2초)", script: [failure(timeoutError()), ok], calls: 2, sleeps: [1_000], succeeds: true },
  { name: "timeout 두 번 뒤 성공: 두 번째 대기 상한은 4초", script: [failure(timeoutError()), failure(timeoutError()), ok], calls: 3, sleeps: [1_000, 2_000], succeeds: true },
  { name: "timeout이 3번 이어지면 마지막 오류로 실패(시도 3회)", script: [failure(timeoutError()), failure(timeoutError()), failure(timeoutError()), ok], calls: 3, sleeps: [1_000, 2_000], error: /aborted due to timeout/ },
  { name: "connection reset은 재시도", script: [failure(Object.assign(new Error("reset"), { code: "ECONNRESET" })), ok], calls: 2, sleeps: [1_000], succeeds: true },
  ...[500, 502, 503, 504].map((status) => ({ name: `HTTP ${status} 1회 뒤 성공`, script: [http(status), ok], calls: 2, sleeps: [1_000], succeeds: true })),
  { name: "429 Retry-After 3초는 그 값을 따른다", script: [http(429, { "Retry-After": "3" }), ok], calls: 2, sleeps: [3_000], succeeds: true },
  { name: "429 Retry-After가 cap(20초) 이하면 재시도", script: [http(429, { "Retry-After": "20" }), ok], calls: 2, sleeps: [20_000], succeeds: true },
  { name: "429 Retry-After가 cap을 넘으면 기다리지 않고 fail-closed", script: [http(429, { "Retry-After": "21" }), ok], calls: 1, sleeps: [], error: new RegExp(RETRY_AFTER_EXCEEDS_CAP) },
  { name: "503 Retry-After가 cap을 넘어도 fail-closed", script: [http(503, { "Retry-After": "300" }), ok], calls: 1, sleeps: [], error: new RegExp(RETRY_AFTER_EXCEEDS_CAP) },
  { name: "429 힌트 없으면 1회만 재시도하고 두 번째 429는 그대로 돌려준다", script: [http(429), http(429), ok], calls: 2, sleeps: [1_000], status: 429 },
  { name: "429 힌트가 있으면 두 번 재시도할 수 있다", script: [http(429, { "Retry-After": "1" }), http(429, { "Retry-After": "1" }), ok], calls: 3, sleeps: [1_000, 1_000], succeeds: true },
  ...[400, 401, 403, 404, 408, 501].map((status) => ({ name: `HTTP ${status}는 즉시 반환(재시도 없음)`, script: [http(status), ok], calls: 1, sleeps: [], status })),
  { name: "비일시 오류는 즉시 던진다", script: [failure(new Error("schema mismatch")), ok], calls: 1, sleeps: [], error: /schema mismatch/ },
  { name: "503이 3번 이어지면 마지막 응답을 돌려준다", script: [http(503), http(503), http(503), ok], calls: 3, sleeps: [1_000, 2_000], status: 503 },
];

for (const { name, script, calls, sleeps, succeeds, error, status } of CASES) {
  test(name, async () => {
    const outcome = await run(script);
    assert.equal(outcome.calls, calls);
    assert.deepEqual(outcome.sleeps, sleeps);
    if (error) {
      assert.match(outcome.error?.message ?? "", error);
    } else {
      assert.equal(outcome.error, undefined);
      assert.equal(outcome.result.response.status, succeeds ? 200 : status);
    }
  });
}

test("Retry-After cap 초과 오류는 코드로 식별되고 원천 이름·초 단위를 담는다", async () => {
  const outcome = await run([http(429, { "Retry-After": "300" })], { label: "Sample API" });
  assert.equal(isRetryAfterExceedsCap(outcome.error), true);
  assert.equal(outcome.error.message, "Sample API HTTP 429: RETRY_AFTER_EXCEEDS_CAP retryAfterSeconds=300 capSeconds=20");
  assert.equal(isRetryAfterExceedsCap(new Error("x")), false);
});

test("재시도하는 비-OK 응답의 본문은 취소하고, 마지막 응답과 성공 응답은 취소하지 않는다", async () => {
  const outcome = await run([http(503), http(503), http(503)]);
  assert.deepEqual(outcome.results.map(({ response: { cancelled } }) => cancelled.value), [true, true, false]);
  const success = await run([http(502), ok]);
  assert.deepEqual(success.results.map(({ response: { cancelled } }) => cancelled.value), [true, false]);
});

test("maxAttempts로 시도 수를 줄일 수 있다", async () => {
  const outcome = await run([failure(timeoutError()), ok], { maxAttempts: 1 });
  assert.equal(outcome.calls, 1);
  assert.match(outcome.error.message, /timeout/);
});

test("isTransientResult는 상태 코드 말고도 일시로 볼 결과를 더하고, 그 결과의 본문도 취소한다", async () => {
  const seen = [];
  const outcome = await run([ok, ok], { isTransientResult: (result) => { seen.push(result); return seen.length === 1; } });
  assert.equal(outcome.calls, 2);
  assert.deepEqual(outcome.results.map(({ response: { cancelled } }) => cancelled.value), [true, false]);
});

test("isTransientError를 바꾸면 그 오류만 재시도한다", async () => {
  const custom = new Error("custom transient");
  const outcome = await run([failure(custom), ok], { isTransientError: (error) => error === custom });
  assert.equal(outcome.calls, 2);
});

test("대기 합계가 시간 예산을 넘으면 TRANSIENT_RETRY_BUDGET_EXHAUSTED로 멈춘다", async () => {
  const outcome = await run([failure(timeoutError()), ok], { budget: createTransientRetryBudget(500) });
  assert.equal(outcome.error.code, "TRANSIENT_RETRY_BUDGET_EXHAUSTED");
});

// 공공데이터포털 오류코드 표: https://www.data.go.kr/data/15029183/openapi.do
test("공공데이터포털 resultCode 분류: 일시(01·02·04·05·30·99)만 재시도하고 쿼터·권한·기한·요청 오류는 즉시 실패한다", () => {
  for (const code of ["01", "02", "04", "05", "30", "99"]) assert.equal(isTransientDataGoKrResultCode(code), true, code);
  for (const code of ["00", "03", "10", "11", "12", "20", "21", "22", "23", "31", "32", "33", "", null, undefined, 99]) assert.equal(isTransientDataGoKrResultCode(code), false, String(code));
});

test("minDelayMs는 재시도 대기의 하한이고, 백오프·Retry-After가 더 길면 그대로 따른다", async () => {
  assert.deepEqual((await run([http(503), http(503), ok], { minDelayMs: 5_000 })).sleeps, [5_000, 5_000]);
  assert.deepEqual((await run([http(503), http(503), ok], { minDelayMs: 1_500 })).sleeps, [1_500, 2_000]);
  assert.deepEqual((await run([http(503, { "retry-after": "3" }), ok], { minDelayMs: 1_000 })).sleeps, [3_000]);
  assert.deepEqual((await run([http(503, { "retry-after": "1" }), ok], { minDelayMs: 5_000 })).sleeps, [5_000]);
});

test("Retry-After가 cap을 넘으면 minDelayMs와 무관하게 기다리지 않고 실패한다", async () => {
  const outcome = await run([http(503, { "retry-after": "21" }), ok], { minDelayMs: 5_000 });
  assert.equal(outcome.error.code, RETRY_AFTER_EXCEEDS_CAP);
  assert.deepEqual(outcome.sleeps, []);
});

test("minDelayMs는 0 이상의 정수만 받는다", () => {
  for (const minDelayMs of [-1, 1.5, "5", Number.NaN]) {
    assert.throws(() => withSourceCollectionRetry(async () => ok(), { minDelayMs }), /SOURCE_COLLECTION_RETRY_ARGUMENTS/, String(minDelayMs));
  }
});

test("maxAttempts는 1부터 정책 상한(3)까지의 정수만 받는다", async () => {
  for (const maxAttempts of [0, 4, 1.5, "3", Number.NaN]) {
    assert.throws(() => withSourceCollectionRetry(async () => ok(), { maxAttempts }), /SOURCE_COLLECTION_RETRY_ARGUMENTS/, String(maxAttempts));
  }
  for (const maxAttempts of [1, 2, 3]) assert.equal((await run([ok], { maxAttempts })).calls, 1);
});

const bytesFetch = (...responses) => async () => responses.shift();
const failTransport = (failure) => new Error(`wrapped ${failure.message}`);

test("fetchBytesWithSourceRetry는 본문까지 한 시도로 묶고, 소진한 전송 오류를 호출자의 오류로 바꾼다", async () => {
  const fetchImpl = bytesFetch(
    { arrayBuffer: async () => { throw timeoutError(); } },
    new Response("payload"),
  );
  const { bytes } = await fetchBytesWithSourceRetry({
    url: "https://example.invalid/", fetchImpl, accept: "text/plain", label: "Sample", transportFailure: failTransport, sleep: async () => {}, random: () => 0,
  });
  assert.equal(bytes.toString(), "payload");
  await assert.rejects(fetchBytesWithSourceRetry({
    url: "https://example.invalid/", fetchImpl: async () => { throw new Error("reset"); }, accept: "text/plain", label: "Sample", transportFailure: failTransport,
    isTransientError: undefined, sleep: async () => {}, random: () => 0,
  }), /wrapped reset/);
});

test("fetchBytesWithSourceRetry는 Retry-After cap 초과로 버린 응답의 바이트 수와 해시를 오류에 남긴다", async () => {
  const fetchImpl = bytesFetch(new Response("busy", { status: 429, headers: { "retry-after": "300" } }));
  await assert.rejects(fetchBytesWithSourceRetry({
    url: "https://example.invalid/", fetchImpl, accept: "text/plain", label: "Sample", transportFailure: failTransport, sleep: async () => {},
  }), (error) => {
    assert.equal(isRetryAfterExceedsCap(error), true);
    assert.match(error.message, /^Sample HTTP 429: RETRY_AFTER_EXCEEDS_CAP retryAfterSeconds=300 capSeconds=20; rawBytes=4; rawSha256=[a-f0-9]{64}$/);
    return true;
  });
});

// KRIC OpenAPI resultCode 분류(Refs #870): 게이트웨이 표준 코드 중 같은 요청을 다시 보내면 풀릴 수 있는 오류만 일시로 본다.
// 30(미등록 서비스키·operation)과 12(없거나 폐기된 서비스)는 결정적이므로 data.go.kr 분류와 달리 즉시 실패한다.
const KRIC_RESULT_CODE_CASES = [
  ["01", true, "APPLICATION_ERROR"], ["02", true, "DB_ERROR"], ["04", true, "HTTP_ERROR"], ["05", true, "SERVICETIMEOUT_ERROR"], ["99", true, "UNKNOWN_ERROR"],
  ["00", false, "정상"], ["03", false, "데이터 없음"], ["10", false, "잘못된 요청 파라미터"], ["11", false, "필수 파라미터 없음"],
  ["12", false, "서비스 없음·폐기"], ["20", false, "접근 거부"], ["21", false, "사용할 수 없는 서비스키"], ["22", false, "요청 한도 초과"],
  ["30", false, "미등록"], ["31", false, "기한 만료"], ["32", false, "미등록 IP"], ["41", false, "승인 대기"], [undefined, false, "코드 없음"],
];
for (const [code, transient, meaning] of KRIC_RESULT_CODE_CASES) {
  test(`KRIC resultCode ${code} (${meaning})는 ${transient ? "일시 오류로 재시도한다" : "재시도하지 않는다"}`, () => {
    assert.equal(isTransientKricResultCode(code), transient);
  });
}

// 프리셋이 던지는 Retry-After 초과 오류는 버린 Response(URL에 serviceKey가 실릴 수 있음)를 들고 나가지 않고 안전한 필드만 남긴다.
test("Retry-After 초과 오류는 Response를 담지 않고 status·대기·원본 증거만 남긴다", async () => {
  const secretUrl = "https://example.test/api?serviceKey=SECRET-KEY-9";
  const withUrl = (status, headers) => Object.defineProperty(response(status, headers), "url", { value: secretUrl });
  const error = await withSourceCollectionRetry(
    () => ({ response: withUrl(429, { "Retry-After": "300" }), bytes: Buffer.from("body") }),
    { label: "Sample", sleep: async () => {}, budget: createTransientRetryBudget() },
  ).catch((caught) => caught);
  assert.equal(isRetryAfterExceedsCap(error), true);
  assert.equal(error.status, 429);
  assert.equal(error.retryAfterMilliseconds, 300_000);
  assert.deepEqual({ ...error.rawEvidence }, { byteLength: 4, sha256: error.rawEvidence.sha256 });
  assert.equal(error.result, undefined);
  assert.equal(inspect(error, { depth: 8, showHidden: true }).includes("SECRET-KEY-9"), false);
});

// 코드별 분류 행: 두 원천이 다르게 다루는 코드(30)를 명시한다.
test("resultCode 30은 data.go.kr에서는 일시, KRIC에서는 결정적이다", () => {
  assert.equal(isTransientDataGoKrResultCode("30"), true);
  assert.equal(isTransientKricResultCode("30"), false);
});

test("fetchBytesWithSourceRetry는 accept 말고 호출자의 요청 헤더도 보낸다", async () => {
  let sent;
  await fetchBytesWithSourceRetry({
    url: "https://example.test/file", accept: "*/*", label: "Sample", headers: { Referer: "https://example.test/detail" },
    fetchImpl: async (_url, init) => { sent = init.headers; return new Response("ok"); },
    transportFailure: (failure) => failure,
  });
  assert.deepEqual(sent, { accept: "*/*", Referer: "https://example.test/detail" });
});

test("transportFailureWithCode는 안전한 형식의 오류 코드만 남기고 원본 오류(URL)는 싣지 않는다", () => {
  const toFailure = transportFailureWithCode("Sample");
  const leaky = Object.assign(new Error("connect failed https://example.test/api?serviceKey=SECRET-KEY-9"), { code: "ECONNRESET" });
  const error = toFailure(leaky);
  assert.equal(error.message, "Sample transport failure; code=ECONNRESET");
  assert.equal(error.cause, undefined);
  assert.equal(toFailure({ cause: { code: "UND_ERR_SOCKET" } }).message, "Sample transport failure; code=UND_ERR_SOCKET");
  assert.equal(toFailure({ code: "SOURCE_FETCH_TELEMETRY_WRITE_FAILED" }).message, "Sample transport failure; code=SOURCE_FETCH_TELEMETRY_WRITE_FAILED");
  assert.equal(toFailure({ code: "has space&key=SECRET" }).message, "Sample transport failure; code=UNKNOWN");
  assert.equal(toFailure(undefined).message, "Sample transport failure; code=UNKNOWN");
});

// 공용 비밀 노출 검사 헬퍼의 자기 검증: 비밀이 어디에 있든(메시지·cause·열거 속성) 잡고, 없으면 통과한다.
test("assertErrorOmitsSecrets는 비밀이 메시지·cause 체인·열거 속성에 있으면 실패하고 없으면 통과한다", () => {
  const secret = "SECRET-KEY-42";
  const leaks = [
    new Error(`failed ${secret}`),
    new Error("failed", { cause: new Error("inner", { cause: { url: `http://host/?serviceKey=${secret}` } }) }),
    Object.assign(new Error("failed"), { requestUrl: `http://host/?serviceKey=${secret}` }),
  ];
  for (const leak of leaks) assert.throws(() => assertErrorOmitsSecrets(leak, [secret]), assert.AssertionError);
  assert.doesNotThrow(() => assertErrorOmitsSecrets(new Error("failed", { cause: new Error("inner") }), [secret]));
});

test("withRequestInterval로 감싼 fetchImpl을 공유하는 동시 요청은 대기열을 빠져나온 뒤에야 AbortSignal.timeout을 시작한다", async () => {
  const observed = [];
  const fetchImpl = withRequestInterval(async (url, init) => {
    assert.equal(init.signal instanceof AbortSignal, true);
    init.signal.throwIfAborted();
    observed.push({ url, aborted: init.signal.aborted });
    return new Response(url);
  }, {
    intervalMs: 60,
    sleep: (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); }),
  });
  const call = (url) => fetchBytesWithSourceRetry({
    url,
    fetchImpl,
    accept: "text/plain",
    label: "Sample",
    timeoutMs: 20,
    transportFailure: (failure) => failure,
  });
  const [first, second] = await Promise.all([
    call("https://example.test/1"),
    call("https://example.test/2"),
  ]);
  assert.equal(first.bytes.toString(), "https://example.test/1");
  assert.equal(second.bytes.toString(), "https://example.test/2");
  assert.deepEqual(observed, [
    { url: "https://example.test/1", aborted: false },
    { url: "https://example.test/2", aborted: false },
  ]);
});

test("RESULT_CODE_TABLE.seoulOpenData는 불변으로 동결되고 서울 열린데이터광장 INFO/ERROR 코드를 정확히 분류한다", () => {
  assert.equal(Object.isFrozen(RESULT_CODE_TABLE), true);
  assert.equal(Object.isFrozen(RESULT_CODE_TABLE.seoulOpenData), true);
  assert.equal(Object.isFrozen(RESULT_CODE_TABLE.seoulOpenData.success), true);
  assert.equal(Object.isFrozen(RESULT_CODE_TABLE.seoulOpenData.empty), true);
  assert.equal(Object.isFrozen(RESULT_CODE_TABLE.seoulOpenData.transient), true);
  assert.equal(Object.isFrozen(RESULT_CODE_TABLE.seoulOpenData.terminal), true);
  assert.deepEqual(RESULT_CODE_TABLE.seoulOpenData, {
    success: ["INFO-000"],
    empty: ["INFO-200"],
    transient: ["ERROR-500", "ERROR-600"],
    terminal: [
      "INFO-100",
      "ERROR-300",
      "ERROR-301",
      "ERROR-310",
      "ERROR-331",
      "ERROR-332",
      "ERROR-333",
      "ERROR-334",
      "ERROR-335",
      "ERROR-336",
      "ERROR-337",
      "ERROR-601",
    ],
  });

  assert.equal(classifySeoulOpenDataResultCode("INFO-000"), "success");
  assert.equal(classifySeoulOpenDataResultCode(" INFO-200 "), "empty");
  for (const code of ["ERROR-500", "ERROR-600"]) {
    assert.equal(classifySeoulOpenDataResultCode(code), "transient", code);
  }
  for (const code of RESULT_CODE_TABLE.seoulOpenData.terminal) {
    assert.equal(classifySeoulOpenDataResultCode(code), "terminal", code);
  }
  assert.equal(classifySeoulOpenDataResultCode("UNKNOWN-999"), "unknown");
  assert.equal(classifySeoulOpenDataResultCode(null), "unknown");

  assert.equal(seoulOpenDataResultCodeOf({ RESULT: { CODE: " ERROR-500 " } }), "ERROR-500");
  assert.equal(
    seoulOpenDataResultCodeOf({ getStnbySftfclt: { RESULT: { CODE: "INFO-000" } } }),
    "INFO-000",
  );
  assert.equal(seoulOpenDataResultCodeOf({ getStnbySftfclt: { RESULT: { CODE: "   " } } }), null);
  assert.equal(seoulOpenDataResultCodeOf(null), null);

  assert.equal(classifyDataGoResultCode("00"), "success");
  assert.equal(classifyDataGoResultCode("03"), "empty");
  assert.equal(classifyDataGoResultCode("05"), "transient");
  assert.equal(classifyDataGoResultCode("20"), "terminal");
  assert.equal(classifyDataGoResultCode("999"), "unknown");
});

test("수동 CLI 수집기(collectSeoulPlatformGap·collectSeoulStationContact·collectSeoulMetroCongestion·defaultHttpGetBuffer)는 일시 오류만 재시도하고 영구 오류는 즉시 실패한다", async () => {
  const gapRow = {
    LINE: "1호선",
    STTN: "서울역",
    OPR_SEC: "상행",
    C1: "5(고무발판)",
  };
  let gapCalls = 0;
  const gapResult = await collectSeoulPlatformGap({
    serviceKey: "test-seoul-key",
    sleepImpl: async () => {},
    fetchImpl: async () => {
      gapCalls += 1;
      if (gapCalls === 1) {
        return new Response(JSON.stringify({ RESULT: { CODE: "ERROR-500", MESSAGE: "서버 오류" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (gapCalls === 2) {
        return new Response("", { status: 503 });
      }
      return new Response(
        JSON.stringify({
          TbSubwayLineInfo: {
            list_total_count: 1,
            RESULT: { CODE: "INFO-000", MESSAGE: "정상" },
            row: [gapRow],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  assert.equal(gapCalls, 3);
  assert.equal(gapResult.snapshot.rows.length, 1);

  for (const terminalCode of ["INFO-100", "ERROR-300"]) {
    let terminalCalls = 0;
    await assert.rejects(
      collectSeoulPlatformGap({
        serviceKey: "test-seoul-key",
        sleepImpl: async () => {},
        fetchImpl: async () => {
          terminalCalls += 1;
          return new Response(JSON.stringify({ RESULT: { CODE: terminalCode, MESSAGE: "오류" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      }),
      new RegExp(terminalCode),
    );
    assert.equal(terminalCalls, 1);
  }

  let contactCalls = 0;
  await assert.rejects(
    collectSeoulStationContact({
      sleepImpl: async () => {},
      fetchImpl: async () => {
        contactCalls += 1;
        return new Response("unavailable", { status: 503 });
      },
    }),
    /HTTP 503/,
  );
  assert.equal(contactCalls, 3);

  let contactTerminalCalls = 0;
  await assert.rejects(
    collectSeoulStationContact({
      sleepImpl: async () => {},
      fetchImpl: async () => {
        contactTerminalCalls += 1;
        return new Response("forbidden", { status: 403 });
      },
    }),
    /HTTP 403/,
  );
  assert.equal(contactTerminalCalls, 1);

  let congestionCalls = 0;
  await assert.rejects(
    collectSeoulMetroCongestion({
      serviceKey: "test-datago-key",
      sleepImpl: async () => {},
      fetchImpl: async () => {
        congestionCalls += 1;
        return new Response("gateway timeout", { status: 504 });
      },
    }),
    /HTTP 504/,
  );
  assert.equal(congestionCalls, 3);

  let bufferCalls = 0;
  const bufferResult = await defaultHttpGetBuffer("https://apis.data.go.kr/B553766/sample", {
    sleepImpl: async () => {},
    fetchImpl: async () => {
      bufferCalls += 1;
      if (bufferCalls === 1) {
        return new Response("temporary error", { status: 502, headers: { "content-type": "text/plain" } });
      }
      return new Response("ok-body", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(bufferCalls, 2);
  assert.equal(bufferResult.ok, true);
  assert.equal(bufferResult.status, 200);
  assert.equal(bufferResult.body.toString("utf8"), "ok-body");
});

test("validateCandidateJourneyGoldenDiffReport와 runCandidateJourneyGoldenDiff는 ZERO_DIFF·DECLARED_DIFF·불일치 fail-closed를 검증한다", async () => {
  const defaultDeclaration = JSON.parse(await readFile(DEFAULT_JOURNEY_GOLDEN_DIFF_DECLARATION_PATH, "utf8"));
  const zeroSha = computeChangedQueriesSummarySha256([]);
  const zeroReport = {
    schemaVersion: 1,
    baselineBundleDir: "/baseline/bundle",
    candidateBundleDir: "/candidate/bundle",
    queryCount: 24,
    unchangedCount: 24,
    changedCount: 0,
    changedQueries: [],
    diffSummarySha256: zeroSha,
  };

  const zeroValidation = validateCandidateJourneyGoldenDiffReport(zeroReport, defaultDeclaration);
  assert.deepEqual(zeroValidation, {
    status: "GO",
    mode: "ZERO_DIFF",
    queryCount: 24,
    unchangedCount: 24,
    changedCount: 0,
    changedQueryIds: [],
    diffSummarySha256: zeroSha,
    reason: null,
  });
  assert.match(
    formatJourneyGoldenDiffEvidenceLine(zeroValidation),
    /^- Journey golden diff: status=GO mode=ZERO_DIFF queryCount=24 unchangedCount=24 changedCount=0 diffSummarySha256=[0-9a-f]{64}$/,
  );

  // Stale declaration when changedCount === 0 but allowChangedQueries === true
  assert.throws(
    () => validateCandidateJourneyGoldenDiffReport(zeroReport, {
      schemaVersion: 1,
      allowChangedQueries: true,
      declaredChangedQueryIds: ["seoul-01"],
      declaredDiffSha256: "a".repeat(64),
      reason: "stale declaration",
    }),
    /JOURNEY_GOLDEN_DIFF_STALE_DECLARATION/,
  );

  const changedEntries = [
    { id: "busan-02", baselineMinutes: 28, candidateMinutes: 26 },
    { id: "seoul-01", baselineMinutes: 42, candidateMinutes: 40 },
  ];
  const changedSha = computeChangedQueriesSummarySha256(changedEntries);
  const changedReport = {
    schemaVersion: 1,
    baselineBundleDir: "/baseline/bundle",
    candidateBundleDir: "/candidate/bundle",
    queryCount: 24,
    unchangedCount: 22,
    changedCount: 2,
    changedQueries: changedEntries,
    diffSummarySha256: changedSha,
  };

  // Undeclared changes must fail closed
  assert.throws(
    () => validateCandidateJourneyGoldenDiffReport(changedReport, defaultDeclaration),
    /JOURNEY_GOLDEN_DIFF_UNDECLARED_CHANGES/,
  );

  // Declared changes with matching reason, ids, and sha256 pass
  const declaredValidation = validateCandidateJourneyGoldenDiffReport(changedReport, {
    schemaVersion: 1,
    allowChangedQueries: true,
    declaredChangedQueryIds: ["busan-02", "seoul-01"],
    declaredDiffSha256: changedSha,
    reason: "시간표 갱신에 따른 배차 간격 반영",
  });
  assert.equal(declaredValidation.status, "GO");
  assert.equal(declaredValidation.mode, "DECLARED_DIFF");
  assert.deepEqual(declaredValidation.changedQueryIds, ["busan-02", "seoul-01"]);

  // Mismatched query IDs or SHA256 or missing reason must fail closed
  assert.throws(
    () => validateCandidateJourneyGoldenDiffReport(changedReport, {
      schemaVersion: 1,
      allowChangedQueries: true,
      declaredChangedQueryIds: ["seoul-01"],
      declaredDiffSha256: changedSha,
      reason: "일부 누락",
    }),
    /JOURNEY_GOLDEN_DIFF_QUERY_IDS_MISMATCH/,
  );
  assert.throws(
    () => validateCandidateJourneyGoldenDiffReport(changedReport, {
      schemaVersion: 1,
      allowChangedQueries: true,
      declaredChangedQueryIds: ["busan-02", "seoul-01"],
      declaredDiffSha256: "0".repeat(64),
      reason: "해시 불일치",
    }),
    /JOURNEY_GOLDEN_DIFF_SHA256_MISMATCH/,
  );
  assert.throws(
    () => validateCandidateJourneyGoldenDiffReport(changedReport, {
      schemaVersion: 1,
      allowChangedQueries: true,
      declaredChangedQueryIds: ["busan-02", "seoul-01"],
      declaredDiffSha256: changedSha,
      reason: "   ",
    }),
    /JOURNEY_GOLDEN_DIFF_REASON_REQUIRED/,
  );

  // End-to-end runner with --golden-diff-input and --report-out
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "golden-diff-runner-test-"));
  try {
    const inputPath = path.join(tempDir, "raw-report.json");
    const outPath = path.join(tempDir, "validated-report.json");
    await writeFile(inputPath, JSON.stringify({
      schemaVersion: 1,
      queryCount: 24,
      unchangedCount: 24,
      changedCount: 0,
      changedQueries: [],
    }));
    const { report, validation } = await runCandidateJourneyGoldenDiff({
      baselineBundleDir: "/baseline/bundle",
      candidateBundleDir: "/candidate/bundle",
      goldenDiffInputPath: inputPath,
      reportOutPath: outPath,
    });
    assert.equal(validation.mode, "ZERO_DIFF");
    assert.equal(report.diffSummarySha256, zeroSha);
    const written = JSON.parse(await readFile(outPath, "utf8"));
    assert.equal(written.validation.status, "GO");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("withSourceCollectionRetry와 fetchBytesWithSourceRetry는 recordTelemetry=false일 때 계측 파일에 시도 줄을 기록하지 않는다 (#1699)", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "retry-no-telemetry-"));
  const telemetryPath = path.join(tempDir, "telemetry.jsonl");
  const prevTelemetry = process.env.SOURCE_FETCH_TELEMETRY_PATH;
  t.after(async () => {
    if (prevTelemetry === undefined) delete process.env.SOURCE_FETCH_TELEMETRY_PATH;
    else process.env.SOURCE_FETCH_TELEMETRY_PATH = prevTelemetry;
    await rm(tempDir, { recursive: true, force: true });
  });
  await writeFile(telemetryPath, "");
  process.env.SOURCE_FETCH_TELEMETRY_PATH = telemetryPath;

  const { bytes } = await fetchBytesWithSourceRetry({
    url: "https://example.test/replay",
    fetchImpl: async () => new Response("replayed", { status: 200 }),
    accept: "application/xml",
    label: "Retained replay",
    sourceId: "retained-replay-test",
    recordTelemetry: false,
    transportFailure: (err) => err,
  });
  assert.equal(bytes.toString("utf8"), "replayed");
  assert.equal(await readFile(telemetryPath, "utf8"), "");
});
