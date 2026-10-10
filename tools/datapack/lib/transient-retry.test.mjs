import assert from "node:assert/strict";
import test from "node:test";

import {
  TRANSIENT_RETRY_BUDGET_EXHAUSTED,
  TRANSIENT_RETRY_LIMIT,
  TRANSIENT_RETRY_WAIT_BUDGET_MS,
  createTransientRetryBudget,
  isTransientStatus,
  isTransientTransportError,
  transientBackoffMs,
  unwrapTransientRetryFailure,
  withTransientRetry,
} from "./transient-retry.mjs";

// #1099: 공급자 일시 오류(HTTP 408·5xx, 전송 오류, 본문 수신 timeout)를 같은 요청의 지수 백오프 재시도로 흡수하는 공통 정책.
// TAGO ITX 수집기(#1090)와 같은 규칙이다: 요청당 최대 5번 재시도, 대기 1·2·4·8·16초, 수집기 실행 한 번당 대기 합계 5분.
const withCode = (code, name = "Error") => Object.assign(new Error(code), { code, name });
const wrapped = (code) => Object.assign(new TypeError("fetch failed"), { cause: withCode(code) });

test("정책 상수는 TAGO와 같다: 5번 재시도, 1·2·4·8·16초, 실행당 대기 5분", () => {
  assert.equal(TRANSIENT_RETRY_LIMIT, 5);
  assert.equal(TRANSIENT_RETRY_WAIT_BUDGET_MS, 300_000);
  assert.deepEqual([0, 1, 2, 3, 4].map(transientBackoffMs), [1_000, 2_000, 4_000, 8_000, 16_000]);
});

test("HTTP 408과 5xx만 일시 상태다. 429(쿼터)·401·403·404·3xx는 아니다", () => {
  for (const status of [408, 500, 502, 503, 504, 599]) assert.equal(isTransientStatus(status), true, String(status));
  for (const status of [200, 204, 301, 400, 401, 403, 404, 429, 600, undefined, "503", null]) assert.equal(isTransientStatus(status), false, String(status));
});

test("전송 오류는 cause 사슬까지 보고 일시 오류만 가려낸다", () => {
  for (const code of ["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "EHOSTDOWN", "ENETDOWN", "ENETRESET", "ECONNABORTED", "EAI_AGAIN", "ENOTFOUND", "ABORT_ERR", "ERR_STREAM_PREMATURE_CLOSE", "UND_ERR_RES_CONTENT_LENGTH_MISMATCH"]) {
    assert.equal(isTransientTransportError(wrapped(code)), true, code);
    assert.equal(isTransientTransportError(withCode(code)), true, `${code} (직접)`);
  }
  assert.equal(isTransientTransportError(Object.assign(new Error("signal timed out"), { name: "TimeoutError" })), true);
  assert.equal(isTransientTransportError(Object.assign(new Error("aborted"), { name: "AbortError" })), true);
  const deep = Object.assign(new Error("a"), { cause: Object.assign(new Error("b"), { cause: withCode("UND_ERR_SOCKET") }) });
  assert.equal(isTransientTransportError(deep), true);
});

test("인증서·URL·형식 오류와 알 수 없는 오류는 일시 오류가 아니다", () => {
  for (const code of ["ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_INVALID_URL", "ERR_INVALID_ARG_TYPE"]) {
    assert.equal(isTransientTransportError(wrapped(code)), false, code);
  }
  for (const value of [new Error("boom"), new TypeError("fetch failed"), null, undefined, "UND_ERR_SOCKET", { code: 1 }]) assert.equal(isTransientTransportError(value), false);
  const cycle = new Error("cycle");
  cycle.cause = cycle;
  assert.equal(isTransientTransportError(cycle), false);
  const tooDeep = [0, 1, 2, 3, 4, 5].reduce((cause) => Object.assign(new Error("x"), { cause }), withCode("UND_ERR_SOCKET"));
  assert.equal(isTransientTransportError(tooDeep), false, "cause 사슬은 4단계까지만 본다");
  const hostile = {};
  Object.defineProperty(hostile, "code", { get() { throw new Error("getter"); } });
  assert.equal(isTransientTransportError(hostile), false);
});

function harness(budget = createTransientRetryBudget()) {
  const waits = [];
  return { waits, budget, sleep: async (ms) => { waits.push(ms); } };
}

test("일시 오류 두 번 뒤 성공하면 그 결과를 돌려주고 1·2초 대기한다", async () => {
  const { waits, budget, sleep } = harness();
  const outcomes = [wrapped("UND_ERR_CONNECT_TIMEOUT"), wrapped("ECONNRESET"), "ok"];
  const attempts = [];
  const result = await withTransientRetry(async ({ attemptNumber }) => {
    attempts.push(attemptNumber);
    const next = outcomes.shift();
    if (next instanceof Error) throw next;
    return next;
  }, { budget, sleep });
  assert.equal(result, "ok");
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(waits, [1_000, 2_000]);
  assert.equal(budget.waitedMs, 3_000);
});

test("일시 오류가 끝까지 이어지면 첫 시도 + 재시도 5번 뒤 마지막 오류를 그대로 던진다", async () => {
  const { waits, budget, sleep } = harness();
  let calls = 0;
  const failure = wrapped("UND_ERR_SOCKET");
  await assert.rejects(withTransientRetry(async () => { calls += 1; throw failure; }, { budget, sleep }), (error) => error === failure);
  assert.equal(calls, 6);
  assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 16_000]);
});

test("일시 오류가 아닌 오류는 재시도 없이 바로 던진다(쿼터·인증·형식)", async () => {
  const { waits, sleep } = harness();
  let calls = 0;
  const failure = new Error("KASI schema invalid");
  await assert.rejects(withTransientRetry(async () => { calls += 1; throw failure; }, { sleep }), (error) => error === failure);
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test("일시 상태 결과(5xx 응답)는 다시 요청하고, 한도를 다 쓰면 마지막 결과를 호출자에게 돌려준다", async () => {
  const { waits, budget, sleep } = harness();
  const statuses = [503, 502, 200];
  const ok = await withTransientRetry(async () => ({ status: statuses.shift() }), { budget, sleep, isTransientResult: ({ status }) => isTransientStatus(status) });
  assert.deepEqual(ok, { status: 200 });
  assert.deepEqual(waits, [1_000, 2_000]);

  const failing = harness();
  let calls = 0;
  const last = await withTransientRetry(async () => ({ status: 500, calls: (calls += 1) }), { budget: failing.budget, sleep: failing.sleep, isTransientResult: ({ status }) => isTransientStatus(status) });
  assert.deepEqual(last, { status: 500, calls: 6 });
  assert.deepEqual(failing.waits, [1_000, 2_000, 4_000, 8_000, 16_000]);

  const quota = harness();
  let quotaCalls = 0;
  const limited = await withTransientRetry(async () => ({ status: 429, calls: (quotaCalls += 1) }), { sleep: quota.sleep, isTransientResult: ({ status }) => isTransientStatus(status) });
  assert.deepEqual(limited, { status: 429, calls: 1 });
  assert.deepEqual(quota.waits, []);
});

test("대기 시간 예산은 같은 budget을 쓰는 요청들이 나눠 쓰고, 넘기는 대기는 하지 않고 TRANSIENT_RETRY_BUDGET_EXHAUSTED로 멈춘다", async () => {
  const budget = createTransientRetryBudget(40_000);
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  const failing = () => withTransientRetry(async () => { throw wrapped("ETIMEDOUT"); }, { budget, sleep });
  // 요청 1: 1+2+4+8+16 = 31초, 요청 2: 1+2+4 = 7초까지 가능하고 다음 8초는 예산(40초)을 넘는다.
  await assert.rejects(failing(), /ETIMEDOUT|fetch failed/u);
  assert.equal(budget.waitedMs, 31_000);
  await assert.rejects(failing(), (error) => error.code === TRANSIENT_RETRY_BUDGET_EXHAUSTED && /budget/u.test(error.message) && isTransientTransportError(error.cause));
  assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 16_000, 1_000, 2_000, 4_000]);
  assert.equal(budget.waitedMs, 38_000);
  assert.ok(budget.waitedMs <= 40_000);
});

test("기본 예산은 실행(프로세스) 단위 5분이다. 직접 만든 예산은 서로 독립이다", async () => {
  const first = createTransientRetryBudget();
  const second = createTransientRetryBudget();
  assert.equal(first.waitBudgetMs, 300_000);
  await withTransientRetry(async ({ attemptNumber }) => { if (attemptNumber === 1) throw wrapped("ETIMEDOUT"); }, { budget: first, sleep: async () => {} });
  assert.equal(first.waitedMs, 1_000);
  assert.equal(second.waitedMs, 0);
  // 예산을 주지 않으면 실행 전체가 하나를 공유한다.
  const shared = [];
  await withTransientRetry(async ({ attemptNumber }) => { if (attemptNumber === 1) throw wrapped("ETIMEDOUT"); }, { sleep: async (ms) => { shared.push(ms); } });
  assert.deepEqual(shared, [1_000]);
});

test("onRetry는 재시도마다 순번·대기·원인을 알려준다", async () => {
  const seen = [];
  const cause = wrapped("UND_ERR_BODY_TIMEOUT");
  await withTransientRetry(async ({ attemptNumber }) => { if (attemptNumber < 3) throw cause; }, {
    budget: createTransientRetryBudget(), sleep: async () => {}, onRetry: (event) => seen.push(event),
  });
  assert.deepEqual(seen, [{ retryIndex: 0, delayMs: 1_000, error: cause }, { retryIndex: 1, delayMs: 2_000, error: cause }]);
});

test("잘못된 인자는 거부한다", async () => {
  await assert.rejects(withTransientRetry("not a function"), /TRANSIENT_RETRY_ARGUMENTS/u);
  await assert.rejects(withTransientRetry(async () => {}, { budget: { waitBudgetMs: -1, waitedMs: 0 } }), /TRANSIENT_RETRY_ARGUMENTS/u);
  assert.throws(() => createTransientRetryBudget(0), /TRANSIENT_RETRY_ARGUMENTS/u);
  assert.throws(() => createTransientRetryBudget(1.5), /TRANSIENT_RETRY_ARGUMENTS/u);
});

test("unwrapTransientRetryFailure는 예산 소진 오류만 마지막 시도의 원래 오류로 되돌린다", async () => {
  const cause = wrapped("ETIMEDOUT");
  const exhausted = await withTransientRetry(async () => { throw cause; }, { budget: createTransientRetryBudget(1_000), sleep: async () => {}, isTransientError: () => true })
    .then(() => null, (error) => error);
  assert.equal(exhausted.code, TRANSIENT_RETRY_BUDGET_EXHAUSTED);
  assert.equal(unwrapTransientRetryFailure(exhausted), cause);
  const plain = new Error("plain");
  assert.equal(unwrapTransientRetryFailure(plain), plain);
  assert.equal(unwrapTransientRetryFailure(undefined), undefined);
  // 결과(오류 없음)로 예산이 소진되면 되돌릴 원인이 없으므로 그대로 둔다.
  const byResult = await withTransientRetry(async () => ({ status: 503 }), { budget: createTransientRetryBudget(1_000), sleep: async () => {}, isTransientResult: () => true })
    .then(() => null, (error) => error);
  assert.equal(byResult.code, TRANSIENT_RETRY_BUDGET_EXHAUSTED);
  assert.equal(unwrapTransientRetryFailure(byResult), byResult);
});
