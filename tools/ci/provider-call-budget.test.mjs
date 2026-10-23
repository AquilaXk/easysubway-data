import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { KRIC_ACCESSIBILITY_OPERATIONS } from "../datapack/collect-kric-accessibility-snapshots.mjs";
import { REVERIFICATION_RECIPES } from "../datapack/source-reverification-recipes.mjs";
import {
  PROVIDER_BUDGET_REASON,
  evaluateProviderCallAllowance,
  parseProviderCallBudgetPolicy,
  parseProviderCallLedger,
} from "./provider-call-budget.mjs";

// 부산 원천(data.go.kr 개발계정)의 KST 하루 operation별 호출 예산(Refs AquilaXk/easysubway#3036, data #1435).
// 묶음(topology·접근성·시간표)을 시작하기 전에 같은 날 앞선 run이 쓴 요청 수와 이번 묶음이 쓸 요청 수를 더해 한도를 넘으면 시작하지 않는다.
const TOPOLOGY = "busan-transportation-route-topology";
const ACCESSIBILITY = "busan-transportation-accessibility";
const TIMETABLE = "busan-transportation-timetable";
const BUSAN_GROUP = [TOPOLOGY, ACCESSIBILITY, TIMETABLE];
const POLICY = parseProviderCallBudgetPolicy({
  schemaVersion: 1,
  artifactKind: "provider-daily-call-budget-policy",
  quotaWindow: "KST_DAY",
  maxCollectionsPerDay: 3,
  operations: BUSAN_GROUP.map((sourceId, index) => ({
    sourceId, datasetUrl: `https://www.data.go.kr/data/${index}/openapi.do`, dailyRequestLimit: 1000, expectedRequestsEvidence: "topologyAdmissionEvidence",
  })),
});
const EXPECTED = Object.freeze({ [TOPOLOGY]: 114, [ACCESSIBILITY]: 114, [TIMETABLE]: 342 });
const ledger = (entries) => parseProviderCallLedger({ schemaVersion: 1, quotaWindow: "2026-10-20", entries });
const entry = (runId, requestCounts) => ({ runId, outcome: "FAILED", requestCounts });
const allowance = (entries, sourceIds = BUSAN_GROUP) => evaluateProviderCallAllowance({ policy: POLICY, ledger: ledger(entries), sourceIds, expectedRequests: EXPECTED });

test("남은 예산이 묶음이 쓸 요청보다 적으면 PROVIDER_DAILY_BUDGET_INSUFFICIENT로 막는다", () => {
  const result = allowance([entry(1, { [TOPOLOGY]: 100 }), entry(2, { [TOPOLOGY]: 790 })]);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, PROVIDER_BUDGET_REASON.BUDGET_INSUFFICIENT);
  assert.match(result.detail, /busan-transportation-route-topology used 890 \+ expected 114 exceeds the daily limit 1000/u);
  assert.deepEqual(allowance([entry(1, { [TOPOLOGY]: 100 }), entry(2, { [TOPOLOGY]: 786 })]), { allowed: true, attempts: 2, used: { [TOPOLOGY]: 886, [ACCESSIBILITY]: 0, [TIMETABLE]: 0 } });
});

test("operation마다 따로 센다: 시간표 한도만 모자라도 묶음 전체를 시작하지 않는다", () => {
  const result = allowance([entry(1, { [TOPOLOGY]: 114, [ACCESSIBILITY]: 114, [TIMETABLE]: 700 })]);
  assert.equal(result.reason, PROVIDER_BUDGET_REASON.BUDGET_INSUFFICIENT);
  assert.match(result.detail, /busan-transportation-timetable used 700 \+ expected 342/u);
});

test("실패한 run이 쓴 요청도 예산에서 뺀다: 결과(성공·실패)와 무관하게 앞선 run의 요청 수를 모두 더한다", () => {
  const succeeded = { ...entry(1, { [TOPOLOGY]: 450 }), outcome: "SUCCEEDED" };
  assert.equal(allowance([succeeded, entry(2, { [TOPOLOGY]: 450 })]).reason, PROVIDER_BUDGET_REASON.BUDGET_INSUFFICIENT);
  assert.equal(allowance([succeeded]).allowed, true);
});

test("앞선 run의 요청 수를 읽지 못하면 추정하지 않고 PROVIDER_CALL_EVIDENCE_MISSING으로 막는다 (fail closed)", () => {
  const missing = allowance([entry(1, { [TOPOLOGY]: 10 }), { runId: 2, outcome: "RUNNING", requestCounts: null }]);
  assert.deepEqual(missing, { allowed: false, reason: PROVIDER_BUDGET_REASON.EVIDENCE_MISSING, detail: "no request counts for run 2" });
  const unreadable = evaluateProviderCallAllowance({
    policy: POLICY, ledger: parseProviderCallLedger({ schemaVersion: 1, quotaWindow: null, entries: null, unreadableReason: "GITHUB_API_STATUS" }), sourceIds: BUSAN_GROUP, expectedRequests: EXPECTED,
  });
  assert.deepEqual(unreadable, { allowed: false, reason: PROVIDER_BUDGET_REASON.EVIDENCE_MISSING, detail: "the call ledger could not be read: GITHUB_API_STATUS" });
});

test("예산 대상이 아닌 묶음은 기록을 읽지 못해도 막지 않는다", () => {
  const unreadable = parseProviderCallLedger({ schemaVersion: 1, quotaWindow: null, entries: null, unreadableReason: "ENV_INVALID" });
  assert.deepEqual(evaluateProviderCallAllowance({ policy: POLICY, ledger: unreadable, sourceIds: ["gwangju-transportation-route-topology"], expectedRequests: {} }), { allowed: true, attempts: 0, used: {} });
});

test("같은 KST 날 묶음을 공급자에게 보낸 run이 상한(3)에 닿으면 예산이 남아도 PROVIDER_DAILY_ATTEMPTS_EXHAUSTED로 막는다", () => {
  const cheap = (runId) => entry(runId, { [TOPOLOGY]: 4 });
  assert.equal(allowance([cheap(1), cheap(2)]).allowed, true);
  const result = allowance([cheap(1), cheap(2), cheap(3)]);
  assert.deepEqual(result, { allowed: false, reason: PROVIDER_BUDGET_REASON.ATTEMPTS_EXHAUSTED, detail: "3 run(s) already sent this group's requests today, the limit is 3" });
  // 묶음 operation을 부르지 않은 run(다른 원천만 수집)은 시도로 세지 않는다.
  assert.equal(allowance([cheap(1), cheap(2), entry(3, { "gwangju-route-topology": 40 })]).allowed, true);
});

test("이번 묶음의 예상 요청 수가 없거나 양의 정수가 아니면 판정하지 않고 실패한다", () => {
  for (const expectedRequests of [{}, { ...EXPECTED, [TIMETABLE]: 0 }, { ...EXPECTED, [TOPOLOGY]: 1.5 }]) {
    assert.throws(() => evaluateProviderCallAllowance({ policy: POLICY, ledger: ledger([]), sourceIds: BUSAN_GROUP, expectedRequests }), /^Error: PROVIDER_BUDGET_INPUT_INVALID: expected requests/u);
  }
});

test("기록 형식 검사: 음수·소수 요청 수, 안전하지 않은 원천 id, 중복 run, 알 수 없는 결과를 거부한다", () => {
  const bad = [
    [entry(1, { [TOPOLOGY]: -1 })],
    [entry(1, { [TOPOLOGY]: 1.5 })],
    [entry(1, { "../x": 1 })],
    [entry(1, {}), entry(1, {})],
    [{ ...entry(1, {}), outcome: "DONE" }],
    [{ runId: 0, outcome: "FAILED", requestCounts: {} }],
  ];
  for (const entries of bad) assert.throws(() => ledger(entries), /^Error: PROVIDER_BUDGET_INPUT_INVALID: call ledger/u);
  assert.throws(() => parseProviderCallLedger({ schemaVersion: 2, quotaWindow: "2026-10-20", entries: [] }), /PROVIDER_BUDGET_INPUT_INVALID/u);
  const withRuns = (count) => ({ schemaVersion: 1, quotaWindow: "2026-10-20", entries: Array.from({ length: count }, (_, index) => entry(index + 1, {})) });
  assert.equal(parseProviderCallLedger(withRuns(200)).entries.length, 200);
  assert.throws(() => parseProviderCallLedger(withRuns(201)), /PROVIDER_BUDGET_INPUT_INVALID: call ledger/u);
});

test("정책 형식 검사: 한도·상한은 양의 정수이고 원천은 한 번씩만 있다", () => {
  const base = { schemaVersion: 1, artifactKind: "provider-daily-call-budget-policy", quotaWindow: "KST_DAY", maxCollectionsPerDay: 3, operations: [{ sourceId: TOPOLOGY, datasetUrl: "https://www.data.go.kr/data/15001019/openapi.do", dailyRequestLimit: 1000, expectedRequestsEvidence: "topologyAdmissionEvidence" }] };
  assert.equal(parseProviderCallBudgetPolicy(base).operations.length, 1);
  const op = base.operations[0];
  for (const policy of [
    { ...base, schemaVersion: 2 },
    { ...base, quotaWindow: "UTC_DAY" },
    { ...base, maxCollectionsPerDay: 0 },
    { ...base, operations: [] },
    { ...base, operations: [op, op] },
    { ...base, operations: [{ ...op, dailyRequestLimit: 0 }] },
    { ...base, operations: [{ ...op, expectedRequestsEvidence: "" }] },
  ]) assert.throws(() => parseProviderCallBudgetPolicy(policy), /^Error: PROVIDER_BUDGET_POLICY_INVALID/u);
});

// 2026-10-20 장애 재현(data #1435): KST 10-20 하루 topology를 끝까지 받은 run 8개(912건)와 9번째 run이 resultCode 22를 받은 기록.
// run id와 생성 시각은 source-reverification run 기록이다. 접근성은 실패 run마다 연결이 끊긴 뒤 몇 건을 썼는지 기록이 없어 0으로 두고(하한),
// 유일하게 묶음이 끝까지 성공한 39369279984만 접근성 114건·시간표 342건을 썼다.
const OCTOBER_20_RUNS = Object.freeze([
  { runId: 39293457044, createdAt: "2026-10-19T17:21:48Z", requestCounts: { [TOPOLOGY]: 114 } },
  { runId: 39302026766, createdAt: "2026-10-19T18:23:01Z", requestCounts: { [TOPOLOGY]: 114 } },
  { runId: 39328925154, createdAt: "2026-10-19T21:37:19Z", requestCounts: { [TOPOLOGY]: 114 } },
  { runId: 39334542195, createdAt: "2026-10-19T22:23:01Z", requestCounts: { [TOPOLOGY]: 114 } },
  { runId: 39343830708, createdAt: "2026-10-19T23:48:30Z", requestCounts: { [TOPOLOGY]: 114 } },
  { runId: 39347305327, createdAt: "2026-10-20T00:23:01Z", requestCounts: { [TOPOLOGY]: 114 } },
  { runId: 39369279984, createdAt: "2026-10-20T04:23:02Z", requestCounts: { [TOPOLOGY]: 114, [ACCESSIBILITY]: 114, [TIMETABLE]: 342 } },
  { runId: 39371539115, createdAt: "2026-10-20T04:48:40Z", requestCounts: { [TOPOLOGY]: 114 } },
  { runId: 39372684432, createdAt: "2026-10-20T05:01:44Z", requestCounts: { [TOPOLOGY]: 114 } },
]);

// 각 run을 시작하기 전의 판정. 막힌 run은 공급자를 부르지 않으므로 기록에 더하지 않는다.
function replay(policy) {
  const history = [];
  return OCTOBER_20_RUNS.map(({ runId, requestCounts }) => {
    const result = evaluateProviderCallAllowance({ policy, ledger: ledger(history), sourceIds: BUSAN_GROUP, expectedRequests: EXPECTED });
    if (result.allowed) history.push(entry(runId, requestCounts));
    return { runId, allowed: result.allowed, reason: result.reason ?? null, topologyUsed: history.reduce((sum, { requestCounts: counts }) => sum + (counts[TOPOLOGY] ?? 0), 0) };
  });
}

test("2026-10-20 재현: 시도 상한이 4번째 run 전에 막아 topology는 342건에서 멈추고 공급자 한도(1,000)에 닿지 않는다", () => {
  const decisions = replay(POLICY);
  assert.deepEqual(decisions.filter(({ allowed }) => allowed).map(({ runId }) => runId), [39293457044, 39302026766, 39328925154]);
  assert.deepEqual(decisions[3], { runId: 39334542195, allowed: false, reason: PROVIDER_BUDGET_REASON.ATTEMPTS_EXHAUSTED, topologyUsed: 342 });
  assert.ok(decisions.every(({ topologyUsed }) => topologyUsed <= 342));
});

test("2026-10-20 재현: 시도 상한이 없어도 예산 판정만으로 8번째 run 뒤(912건)에서 멈춰 resultCode 22를 받은 9번째 run을 시작하지 않는다", () => {
  const decisions = replay({ ...POLICY, maxCollectionsPerDay: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(decisions.slice(0, 8).map(({ allowed }) => allowed), new Array(8).fill(true));
  assert.deepEqual(decisions[8], { runId: 39372684432, allowed: false, reason: PROVIDER_BUDGET_REASON.BUDGET_INSUFFICIENT, topologyUsed: 912 });
});

const committedPolicy = JSON.parse(await readFile(path.resolve(import.meta.dirname, "../../release/product-gates/provider-daily-call-budget.json"), "utf8"));

test("저장소 정책: 부산 세 operation(15001019·15001020·15000522)이 하루 1,000건이고, 같은 재확인 묶음에 속하며 상한은 3이다", () => {
  const policy = parseProviderCallBudgetPolicy(committedPolicy);
  assert.equal(policy.maxCollectionsPerDay, 3);
  assert.deepEqual(policy.operations.map(({ sourceId, dailyRequestLimit }) => [sourceId, dailyRequestLimit]), BUSAN_GROUP.map((sourceId) => [sourceId, 1000]));
  assert.deepEqual(committedPolicy.operations.map(({ datasetUrl }) => datasetUrl.match(/\/data\/(\d+)\//u)[1]), ["15001019", "15001020", "15000522"]);
  const recipeSources = new Set(REVERIFICATION_RECIPES.filter(({ id }) => id.startsWith("busan-")).flatMap(({ sourceIds }) => sourceIds));
  for (const { sourceId } of policy.operations) assert.ok(recipeSources.has(sourceId), `${sourceId} belongs to a reverification recipe`);
  // 한도 근거는 확인한 것과 가정한 것을 나눠 적는다: 확인 항목은 모두 확인일이 있고 URL은 공공데이터포털이며, 가정은 비어 있지 않다.
  const { verified, assumed } = committedPolicy.dailyRequestLimitBasis;
  assert.ok(verified.length > 0);
  for (const { url, checkedAt, statement } of verified) {
    assert.ok(url === null || url.startsWith("https://www.data.go.kr/"), url);
    assert.match(checkedAt, /^\d{4}-\d{2}-\d{2}$/u);
    assert.notEqual(statement, "");
  }
  assert.match(assumed, /접근성.*시간표/u);
});

// #3036: KRIC 시설 operation은 문서화된 하루 한도가 없어 예산 판정 대상이 아니다. 확인한 것과 가정한 것을 나눠 남기고, 한도 숫자를 지어내지 않는다.
test("저장소 정책: KRIC 시설 operation은 예산 operation이 아니며 한도 근거를 확인·가정으로 나눠 적는다", () => {
  const [kric] = committedPolicy.unbudgetedOperations;
  assert.equal(committedPolicy.unbudgetedOperations.length, 1);
  assert.deepEqual(kric.sourceIds, KRIC_ACCESSIBILITY_OPERATIONS.map(({ sourceId }) => sourceId));
  assert.equal(committedPolicy.operations.some(({ sourceId }) => kric.sourceIds.includes(sourceId)), false);
  assert.equal("dailyRequestLimit" in kric, false, "한도를 확인하지 못한 operation에 숫자를 적지 않는다");
  assert.ok(Number.isSafeInteger(kric.requestsPerCollection) && kric.requestsPerCollection > 0);
  assert.ok(kric.verified.length > 0);
  for (const { url, checkedAt, statement } of kric.verified) {
    assert.ok(url === null || url.startsWith("https://www.data.go.kr/"), url);
    assert.match(checkedAt, /^\d{4}-\d{2}-\d{2}$/u);
    assert.notEqual(statement, "");
  }
  assert.match(kric.assumed, /stationEscalator/u);
});
