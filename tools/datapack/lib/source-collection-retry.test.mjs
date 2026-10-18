import assert from "node:assert/strict";
import test from "node:test";

import {
  RETRY_AFTER_EXCEEDS_CAP,
  SOURCE_COLLECTION_RETRY_POLICY,
  isRetryAfterExceedsCap,
  withSourceCollectionRetry,
} from "./source-collection-retry.mjs";
import { createTransientRetryBudget } from "./transient-retry.mjs";

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

test("정책 상수: 3회 시도, base 2초, cap 20초, 429·502·503·504만 일시 상태", () => {
  assert.deepEqual({ ...SOURCE_COLLECTION_RETRY_POLICY, transientStatuses: [...SOURCE_COLLECTION_RETRY_POLICY.transientStatuses] }, {
    maxAttempts: 3, baseDelayMs: 2_000, capDelayMs: 20_000, transientStatuses: [429, 502, 503, 504], maxUnhintedRateLimitRetries: 1,
  });
});

const CASES = [
  { name: "timeout 1회 뒤 성공: 대기는 full jitter(0.5 × 2초)", script: [failure(timeoutError()), ok], calls: 2, sleeps: [1_000], succeeds: true },
  { name: "timeout 두 번 뒤 성공: 두 번째 대기 상한은 4초", script: [failure(timeoutError()), failure(timeoutError()), ok], calls: 3, sleeps: [1_000, 2_000], succeeds: true },
  { name: "timeout이 3번 이어지면 마지막 오류로 실패(시도 3회)", script: [failure(timeoutError()), failure(timeoutError()), failure(timeoutError()), ok], calls: 3, sleeps: [1_000, 2_000], error: /aborted due to timeout/ },
  { name: "connection reset은 재시도", script: [failure(Object.assign(new Error("reset"), { code: "ECONNRESET" })), ok], calls: 2, sleeps: [1_000], succeeds: true },
  ...[502, 503, 504].map((status) => ({ name: `HTTP ${status} 1회 뒤 성공`, script: [http(status), ok], calls: 2, sleeps: [1_000], succeeds: true })),
  { name: "429 Retry-After 3초는 그 값을 따른다", script: [http(429, { "Retry-After": "3" }), ok], calls: 2, sleeps: [3_000], succeeds: true },
  { name: "429 Retry-After가 cap(20초) 이하면 재시도", script: [http(429, { "Retry-After": "20" }), ok], calls: 2, sleeps: [20_000], succeeds: true },
  { name: "429 Retry-After가 cap을 넘으면 기다리지 않고 fail-closed", script: [http(429, { "Retry-After": "21" }), ok], calls: 1, sleeps: [], error: new RegExp(RETRY_AFTER_EXCEEDS_CAP) },
  { name: "503 Retry-After가 cap을 넘어도 fail-closed", script: [http(503, { "Retry-After": "300" }), ok], calls: 1, sleeps: [], error: new RegExp(RETRY_AFTER_EXCEEDS_CAP) },
  { name: "429 힌트 없으면 1회만 재시도하고 두 번째 429는 그대로 돌려준다", script: [http(429), http(429), ok], calls: 2, sleeps: [1_000], status: 429 },
  { name: "429 힌트가 있으면 두 번 재시도할 수 있다", script: [http(429, { "Retry-After": "1" }), http(429, { "Retry-After": "1" }), ok], calls: 3, sleeps: [1_000, 1_000], succeeds: true },
  ...[400, 401, 403, 404, 408, 500, 501].map((status) => ({ name: `HTTP ${status}는 즉시 반환(재시도 없음)`, script: [http(status), ok], calls: 1, sleeps: [], status })),
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
