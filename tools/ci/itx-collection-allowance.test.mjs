import assert from "node:assert/strict";
import test from "node:test";

import { TAGO_DAILY_REQUEST_LIMIT } from "../datapack/collect-tago-itx-cheongchun-od.mjs";
import { DEFAULT_CONTINUATION_MAX_LIVE_REQUESTS, DEFAULT_MAX_RECORDS } from "../datapack/provider-response-capture.mjs";
import {
  ITX_COLLECTION_OUTCOME,
  ITX_CONTINUATION_REQUEST_RESERVE,
  ITX_DAILY_REQUEST_BUDGET,
  ITX_MANUAL_CHECK_REQUEST_RESERVE,
  ITX_MAX_COLLECTIONS_PER_DAY,
  ITX_MIN_RETRY_GAP_MS,
  ITX_PROVIDER_DAILY_LIMIT,
  ITX_WORST_CASE_COLLECTION_REQUESTS,
  evaluateItxCollectionAllowance,
  isItxCollectionEntries,
} from "./itx-collection-allowance.mjs";

const HOUR_MS = 3_600_000;
const NOW = new Date("2026-10-16T22:30:00.000Z");
const failed = (runId, overrides = {}) => ({
  runId,
  workflowFile: "itx-current-promotion.yml",
  outcome: ITX_COLLECTION_OUTCOME.FAILED,
  endedAt: "2026-10-16T18:52:15.000Z",
  requestCount: 810,
  ...overrides,
});
const evaluate = (entries, overrides = {}) => evaluateItxCollectionAllowance({ entries, now: NOW, ...overrides });

test("상수는 한 출처에서 계산한다: 공급자 한도는 수집기, 최악 요청 수는 capture 기록 상한, 이어받기는 이어받기 상한", () => {
  assert.equal(ITX_PROVIDER_DAILY_LIMIT, TAGO_DAILY_REQUEST_LIMIT);
  assert.equal(ITX_WORST_CASE_COLLECTION_REQUESTS, DEFAULT_MAX_RECORDS);
  assert.equal(ITX_CONTINUATION_REQUEST_RESERVE, DEFAULT_CONTINUATION_MAX_LIVE_REQUESTS);
  // 일일 예산 + 이어받기 상한 + 사람 확인 예비분이 공급자 한도와 정확히 같다.
  assert.equal(ITX_DAILY_REQUEST_BUDGET + ITX_CONTINUATION_REQUEST_RESERVE + ITX_MANUAL_CHECK_REQUEST_RESERVE, ITX_PROVIDER_DAILY_LIMIT);
  assert.ok(ITX_DAILY_REQUEST_BUDGET < ITX_PROVIDER_DAILY_LIMIT);
  // 예산 안에서 최악 수집 하나는 항상 들어간다. 아니면 첫 시도조차 막힌다.
  assert.ok(ITX_WORST_CASE_COLLECTION_REQUESTS <= ITX_DAILY_REQUEST_BUDGET);
  assert.equal(ITX_MAX_COLLECTIONS_PER_DAY, 3);
  assert.equal(ITX_MIN_RETRY_GAP_MS, 2 * HOUR_MS);
});

test("그날 수집한 기록이 없으면 허용한다", () => {
  assert.deepEqual(evaluate([]), { allowed: true, attempts: 0, requestsUsed: 0 });
});

test("장애 재현: 같은 날 실패 1회(요청 810건, 18:52Z 종료)는 간격이 지난 뒤 재수집을 허용한다", () => {
  assert.deepEqual(evaluate([failed(38943966334)]), { allowed: true, attempts: 1, requestsUsed: 810 });
});

test("같은 날 성공했거나 진행 중인 수집이 있으면 대기한다 (ITX_COLLECTED_TODAY)", () => {
  for (const outcome of [ITX_COLLECTION_OUTCOME.SUCCEEDED, ITX_COLLECTION_OUTCOME.RUNNING]) {
    const success = { runId: 1, workflowFile: "itx-current-promotion.yml", outcome, endedAt: null, requestCount: null };
    for (const entries of [[success], [failed(2), success], [success, failed(2)]]) {
      assert.deepEqual(evaluate(entries), { allowed: false, kind: "WAIT", reason: "ITX_COLLECTED_TODAY" });
    }
  }
  // 성공이 있으면 실패 기록의 증거가 없어도 대기가 먼저다.
  const success = { runId: 1, workflowFile: "itx-current-promotion.yml", outcome: ITX_COLLECTION_OUTCOME.SUCCEEDED, endedAt: null, requestCount: null };
  assert.equal(evaluate([failed(2, { requestCount: null }), success]).reason, "ITX_COLLECTED_TODAY");
});

test("시도 횟수 상한: 상한 직전까지 허용하고 상한에 닿으면 ITX_DAILY_ATTEMPTS_EXHAUSTED로 실패한다", () => {
  const attempts = (count) => Array.from({ length: count }, (_, index) => failed(100 + index, { requestCount: 100 }));
  assert.equal(evaluate(attempts(ITX_MAX_COLLECTIONS_PER_DAY - 1)).allowed, true);
  const exhausted = evaluate(attempts(ITX_MAX_COLLECTIONS_PER_DAY));
  assert.deepEqual({ allowed: exhausted.allowed, kind: exhausted.kind, reason: exhausted.reason }, { allowed: false, kind: "FAIL", reason: "ITX_DAILY_ATTEMPTS_EXHAUSTED" });
  assert.match(exhausted.detail, /3/u);
});

test("허용된 수집은 최악이어도 이어받기·사람 확인 예비분을 포함해 공급자 한도를 넘지 못한다 (모든 사용량에서 확인)", () => {
  for (let used = 0; used <= ITX_PROVIDER_DAILY_LIMIT; used += 1) {
    if (evaluate([failed(1, { requestCount: used })]).allowed) {
      assert.ok(used + ITX_WORST_CASE_COLLECTION_REQUESTS + ITX_CONTINUATION_REQUEST_RESERVE + ITX_MANUAL_CHECK_REQUEST_RESERVE <= ITX_PROVIDER_DAILY_LIMIT, String(used));
    }
  }
});

test("요청 예산: 사용량 + 최악 수집 요청 수가 예산을 넘는 순간 ITX_DAILY_REQUEST_BUDGET_EXHAUSTED로 실패한다 (경계 포함)", () => {
  const edge = ITX_DAILY_REQUEST_BUDGET - ITX_WORST_CASE_COLLECTION_REQUESTS;
  assert.equal(evaluate([failed(1, { requestCount: edge })]).allowed, true);
  const over = evaluate([failed(1, { requestCount: edge + 1 })]);
  assert.deepEqual({ allowed: over.allowed, kind: over.kind, reason: over.reason }, { allowed: false, kind: "FAIL", reason: "ITX_DAILY_REQUEST_BUDGET_EXHAUSTED" });
  assert.match(over.detail, new RegExp(String(edge + 1), "u"));
  // 시도 두 번의 합으로도 넘는다.
  assert.equal(evaluate([failed(1, { requestCount: edge / 2 }), failed(2, { requestCount: edge / 2 + 1 })]).reason, "ITX_DAILY_REQUEST_BUDGET_EXHAUSTED");
});

test("최소 간격: 마지막 시도가 끝난 지 간격이 지나기 전에는 ITX_RETRY_TOO_SOON으로 대기한다 (경계 포함)", () => {
  const endedAt = (ageMs) => new Date(NOW.getTime() - ageMs).toISOString();
  assert.equal(evaluate([failed(1, { endedAt: endedAt(ITX_MIN_RETRY_GAP_MS) })]).allowed, true);
  const soon = evaluate([failed(1, { endedAt: endedAt(ITX_MIN_RETRY_GAP_MS - 1) })]);
  assert.deepEqual({ allowed: soon.allowed, kind: soon.kind, reason: soon.reason }, { allowed: false, kind: "WAIT", reason: "ITX_RETRY_TOO_SOON" });
  // 마지막은 가장 늦게 끝난 시도다. 목록 순서에 의존하지 않는다.
  const entries = [failed(1, { endedAt: endedAt(ITX_MIN_RETRY_GAP_MS - 1) }), failed(2, { endedAt: endedAt(5 * HOUR_MS) })];
  assert.equal(evaluate(entries).reason, "ITX_RETRY_TOO_SOON");
  assert.equal(evaluate([...entries].reverse()).reason, "ITX_RETRY_TOO_SOON");
  // 시계가 어긋나 종료 시각이 미래여도 허용하지 않고 대기한다.
  assert.equal(evaluate([failed(1, { endedAt: endedAt(-HOUR_MS) })]).reason, "ITX_RETRY_TOO_SOON");
});

test("사람 force(skipRetryGap)는 최소 간격만 건너뛴다. 상한·예산·증거 규칙은 그대로다", () => {
  const recent = failed(1, { endedAt: new Date(NOW.getTime() - 60_000).toISOString() });
  assert.equal(evaluate([recent], { skipRetryGap: true }).allowed, true);
  assert.equal(evaluate([failed(1, { requestCount: ITX_DAILY_REQUEST_BUDGET - ITX_WORST_CASE_COLLECTION_REQUESTS + 1 })], { skipRetryGap: true }).reason, "ITX_DAILY_REQUEST_BUDGET_EXHAUSTED");
  const attempts = Array.from({ length: ITX_MAX_COLLECTIONS_PER_DAY }, (_, index) => failed(index + 1, { requestCount: 1 }));
  assert.equal(evaluate(attempts, { skipRetryGap: true }).reason, "ITX_DAILY_ATTEMPTS_EXHAUSTED");
  assert.equal(evaluate([failed(1, { requestCount: null })], { skipRetryGap: true }).reason, "ITX_COLLECTION_EVIDENCE_MISSING");
});

test("실패한 시도의 요청 수나 종료 시각 증거가 없으면 추정하지 않고 ITX_COLLECTION_EVIDENCE_MISSING으로 실패한다 (fail-closed)", () => {
  for (const overrides of [{ requestCount: null }, { endedAt: null }]) {
    const result = evaluate([failed(1), failed(2, overrides)]);
    assert.deepEqual({ allowed: result.allowed, kind: result.kind, reason: result.reason }, { allowed: false, kind: "FAIL", reason: "ITX_COLLECTION_EVIDENCE_MISSING" });
    assert.match(result.detail, /2/u);
  }
});

test("기록 형식 검사: 알 수 없는 결과·음수·정수가 아닌 요청 수·배열이 아닌 입력을 거부한다", () => {
  assert.equal(isItxCollectionEntries([]), true);
  assert.equal(isItxCollectionEntries([failed(1), failed(2, { requestCount: null, endedAt: null })]), true);
  for (const bad of [
    null, {}, [null], [failed(1, { outcome: "OK" })], [failed(1, { requestCount: -1 })], [failed(1, { requestCount: 1.5 })], [failed(1, { requestCount: "810" })],
    [failed(1, { endedAt: "yesterday" })], [failed(0)], [failed("1")], [failed(1, { workflowFile: "" })],
  ]) {
    assert.equal(isItxCollectionEntries(bad), false, JSON.stringify(bad));
  }
  assert.throws(() => evaluate("none"), /ITX_COLLECTION_ENTRIES_INVALID/u);
});
