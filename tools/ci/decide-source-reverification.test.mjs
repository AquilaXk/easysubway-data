import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { planRefreshFailureReport } from "./report-refresh-failure.mjs";
import {
  SOURCE_REVERIFICATION_CLAIM_PREFIX,
  decideSourceReverification,
  main,
  parseSourceReverificationClaims,
  sourceReverificationDue,
} from "./decide-source-reverification.mjs";

// #984(#969 남은 단계 1): P7D 원천 재확인 판정. 정책(scheduledPipeline.cadence P1D, monitoring.alertBeforePackExpiry)과 원장 head의
// freshUntil로 만료 전에 DUE가 되는 원천만 골라 recipe 목록을 돌려준다. 만료를 연장하지 않고, 판정할 수 없으면 이상으로 실패한다.
const REPOSITORY = "AquilaXk/easysubway-data";
const NOW = new Date("2026-10-07T01:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (millis) => new Date(millis).toISOString();

const STATION_LINES_SOURCE_ID = "kric-subway-timetable-station-lines";
const POLICY = Object.freeze({
  monitoring: { alertBeforePackExpiry: "PT6H" },
  scheduledPipeline: { cadence: "P1D" },
  sourceClasses: [
    { id: "route_graph_topology", basisField: "retrievedAt", reverificationCadence: "P7D", futureBasisAllowed: false, sourceIds: [
      "korail-metropolitan-timetable-file", "gwangju-transportation-route-topology", "busan-transportation-route-topology", "daejeon-station-distance-fare",
      "daegu-line1-route-topology", "daegu-line2-route-topology", "daegu-line3-route-topology"] },
    { id: "official_static_timetable_confirmation", basisField: "observedAt", reverificationCadence: "P7D", futureBasisAllowed: false, providerValidityEndField: "serviceEffectiveUntil", sourceIds: ["kric-nationwide-timetable-file"] },
    { id: "planned_timetable", basisField: "serviceEffectiveAt", maximumReverificationCadence: "P30D", futureBasisAllowed: true, sourceIds: [STATION_LINES_SOURCE_ID] },
  ],
});
const TOPOLOGY_SOURCES = POLICY.sourceClasses[0].sourceIds;

// head를 basisMillis에 수집한 원장 행. freshUntil은 정책대로 P7D 뒤다.
const row = (sourceId, basisMillis, overrides = {}) => ({
  sourceId, snapshotId: `${sourceId}-1`, previousSnapshotId: null, retrievedAt: iso(basisMillis), capturedAt: iso(basisMillis),
  freshUntil: iso(basisMillis + 7 * DAY), freshnessExpiresAt: iso(basisMillis + 7 * DAY), ...overrides,
});
// KRIC 역별 시간표의 실제 원장 행 형상: 기준은 serviceEffectiveAt이고 만료는 freshnessExpiresAt(정책 P30D)뿐이다. freshUntil 필드는 없다.
const stationLinesRow = (basisMillis) => ({
  sourceId: STATION_LINES_SOURCE_ID, snapshotId: `${STATION_LINES_SOURCE_ID}-1`, previousSnapshotId: null,
  retrievedAt: iso(basisMillis), serviceEffectiveAt: iso(basisMillis), freshnessExpiresAt: iso(basisMillis + 30 * DAY),
});
const ledgerAt = (basisMillis, extra = []) => [...TOPOLOGY_SOURCES.map((sourceId) => row(sourceId, basisMillis)), stationLinesRow(basisMillis), ...extra];
const inventoryAt = (observedMillis) => ({ sources: [{
  id: "kric-nationwide-timetable-file",
  capitalScheduleAdmissionEvidence: { observedAt: iso(observedMillis) },
  korailScheduleAdmissionEvidence: { observedAt: iso(observedMillis) },
}] });
const FRESH = NOW.getTime() - 2 * HOUR;
const input = (overrides = {}) => ({
  inventory: inventoryAt(FRESH), ledger: ledgerAt(FRESH), policy: POLICY, pullRequests: [], automationBranches: [], runs: [], openIssues: [], repository: REPOSITORY,
  now: NOW, limits: { pullRequests: 1000, runs: 200, issues: 1000 }, ...overrides,
});
const pr = (state, runId, overrides = {}) => ({
  number: 990, state, isDraft: true, headRefName: `${SOURCE_REVERIFICATION_CLAIM_PREFIX}${runId}`, baseRefName: "main",
  isCrossRepository: false, headRepository: { nameWithOwner: REPOSITORY }, ...overrides,
});
const writer = (number, prefix = "automation/639-seoul-accessibility-refresh-") => pr("OPEN", 9, { number, headRefName: `${prefix}9` });
const run = (id, status, conclusion = null, overrides = {}) => ({ databaseId: id, status, conclusion, workflowName: "Source Reverification", headBranch: "main", ...overrides });
const dueAgo = (millis) => NOW.getTime() - millis;

test("claim 접두어는 이 이슈 번호의 재확인 브랜치다", () => {
  assert.equal(SOURCE_REVERIFICATION_CLAIM_PREFIX, "automation/984-source-reverification-");
});

test("기준 시각이 최근이면 아무것도 DUE가 아니다(NOT_DUE)", () => {
  assert.deepEqual(decideSourceReverification(input()), { state: "NOT_DUE", due: [], recipes: [], blocked: [], cleanupClaims: [] });
});

test("기준 시각 + scheduledPipeline.cadence(P1D)가 지난 원천이 DUE다. 만료는 연장하지 않는다", () => {
  const result = decideSourceReverification(input({ ledger: ledgerAt(FRESH).map((entry) => (entry.sourceId === "busan-transportation-route-topology" ? row(entry.sourceId, dueAgo(DAY + HOUR)) : entry)) }));
  assert.equal(result.state, "RUN");
  assert.deepEqual(result.recipes, ["busan-topology", "busan-accessibility", "busan-timetable"]);
  assert.deepEqual(result.due.map(({ recipeId, sourceId }) => [recipeId, sourceId]), [["busan-topology", "busan-transportation-route-topology"]]);
  assert.equal(result.due[0].dueAt, iso(dueAgo(DAY + HOUR) + DAY));
});

test("만료 경보 창(alertBeforePackExpiry)이 P1D보다 이르면 그 시각이 우선이다", () => {
  // 수집 12시간 전 기준이 아니라 만료가 임박한 행: freshUntil이 6시간 안이면 아직 하루가 안 됐어도 DUE다.
  const soon = row("gwangju-transportation-route-topology", dueAgo(2 * HOUR), { freshUntil: iso(NOW.getTime() + 5 * HOUR), freshnessExpiresAt: iso(NOW.getTime() + 5 * HOUR) });
  const result = decideSourceReverification(input({ ledger: ledgerAt(FRESH).map((entry) => (entry.sourceId === soon.sourceId ? soon : entry)) }));
  assert.deepEqual(result.recipes, ["gwangju-topology", "gwangju-accessibility"]);
  assert.equal(result.due[0].dueAt, iso(NOW.getTime() - HOUR));
  // 경보 창 밖(만료 6시간 초과)이고 하루가 안 됐으면 DUE가 아니다.
  const later = row("gwangju-transportation-route-topology", dueAgo(2 * HOUR), { freshUntil: iso(NOW.getTime() + 7 * HOUR), freshnessExpiresAt: iso(NOW.getTime() + 7 * HOUR) });
  assert.equal(decideSourceReverification(input({ ledger: ledgerAt(FRESH).map((entry) => (entry.sourceId === later.sourceId ? later : entry)) })).state, "NOT_DUE");
});

// #1122: 원장 행의 만료는 모든 행이 싣는 freshnessExpiresAt이다. freshUntil은 일부 행에만 있어 그 필드에 기대면 KRIC 역별 시간표 head를 판정하지 못한다.
test("freshnessExpiresAt만 싣는 head(KRIC 역별 시간표)도 기준 + P1D가 지나면 DUE이고 독립 recipe 하나만 돈다", () => {
  const stale = ledgerAt(FRESH).map((entry) => (entry.sourceId === STATION_LINES_SOURCE_ID ? stationLinesRow(dueAgo(DAY + HOUR)) : entry));
  const result = decideSourceReverification(input({ ledger: stale }));
  assert.equal(result.state, "RUN");
  assert.deepEqual(result.recipes, ["kric-station-timetable"]);
  assert.deepEqual(result.due, [{ recipeId: "kric-station-timetable", sourceId: STATION_LINES_SOURCE_ID, dueAt: iso(dueAgo(DAY + HOUR) + DAY) }]);
});

test("KRIC 역별 시간표는 만료가 6시간 안이면 기준 + P1D보다 먼저 DUE가 되고 만료를 연장하지 않는다", () => {
  const expiring = ledgerAt(FRESH).map((entry) => (entry.sourceId === STATION_LINES_SOURCE_ID
    ? { ...stationLinesRow(dueAgo(2 * HOUR)), freshnessExpiresAt: iso(NOW.getTime() + 5 * HOUR) } : entry));
  const [entry] = sourceReverificationDue({ inventory: inventoryAt(FRESH), ledger: expiring, policy: POLICY, now: NOW }).filter(({ sourceId }) => sourceId === STATION_LINES_SOURCE_ID);
  assert.equal(entry.state, "DUE");
  assert.equal(entry.dueAt, iso(NOW.getTime() - HOUR));
  assert.equal(entry.freshUntil, iso(NOW.getTime() + 5 * HOUR));
});

// #1122: 공급처 기대 관측이 바뀌어 사람이 기대값을 고쳐야 하는 recipe는 실패 이슈가 열려 있는 동안 다시 돌지 않는다(같은 원인의 재수집을 2시간마다 되풀이하지 않는다).
const REVERIFICATION_WORKFLOW_FILE = "source-reverification.yml";
function failureIssue(failures, overrides = {}) {
  const plan = planRefreshFailureReport({ repository: REPOSITORY, workflowFile: REVERIFICATION_WORKFLOW_FILE, runId: "5", openIssues: [], now: NOW, failures });
  return { number: 77, title: plan.title, body: plan.body, author: { login: "app/github-actions" }, createdAt: NOW.toISOString(), comments: [], ...overrides };
}
const stationLinesDue = () => ledgerAt(FRESH).map((entry) => (entry.sourceId === STATION_LINES_SOURCE_ID ? stationLinesRow(dueAgo(DAY + HOUR)) : entry));
const expectationChanged = { recipeId: "kric-station-timetable", code: "SOURCE_EXPECTATION_CHANGED" };

test("기대 관측 변경으로 막힌 recipe는 DUE여도 건너뛰고 blocked로 드러낸다", () => {
  const open = decideSourceReverification(input({ ledger: stationLinesDue() }));
  assert.deepEqual(open.recipes, ["kric-station-timetable"]);
  const skipped = decideSourceReverification(input({ ledger: stationLinesDue(), openIssues: [failureIssue([expectationChanged])] }));
  assert.deepEqual({ state: skipped.state, recipes: skipped.recipes, blocked: skipped.blocked, due: skipped.due }, {
    state: "NOT_DUE", recipes: [], blocked: ["kric-station-timetable"], due: [],
  });
});

test("막힘은 다른 DUE recipe의 재확인을 막지 않는다", () => {
  const ledger = stationLinesDue().map((entry) => (entry.sourceId === "busan-transportation-route-topology" ? row(entry.sourceId, dueAgo(DAY + HOUR)) : entry));
  const result = decideSourceReverification(input({ ledger, openIssues: [failureIssue([expectationChanged])] }));
  assert.equal(result.state, "RUN");
  assert.deepEqual(result.recipes, ["busan-topology", "busan-accessibility", "busan-timetable"]);
  assert.deepEqual(result.blocked, ["kric-station-timetable"]);
  assert.deepEqual(result.due.map(({ recipeId }) => recipeId), ["busan-topology"]);
});

test("막힌 recipe에 의존하는 recipe도 함께 건너뛴다", () => {
  const recipes = [
    { id: "a", message: "a", sourceIds: ["a-source"], dependsOn: [], inventoryChanges: {}, due: { kind: "ledger-head", sourceIds: [STATION_LINES_SOURCE_ID] } },
    { id: "b", message: "b", sourceIds: ["b-source"], dependsOn: ["a"], inventoryChanges: {}, due: null },
  ];
  const result = decideSourceReverification(input({ recipes, ledger: stationLinesDue(), openIssues: [failureIssue([{ recipeId: "a", code: "SOURCE_EXPECTATION_CHANGED" }])] }));
  assert.deepEqual({ state: result.state, recipes: result.recipes, blocked: result.blocked }, { state: "NOT_DUE", recipes: [], blocked: ["a", "b"] });
});

test("표지가 같은 workflow의 봇 실패 이슈에 없거나 막는 코드가 아니면 건너뛰지 않는다(이슈가 닫히면 다음 실행이 다시 수집한다)", () => {
  const ledger = stationLinesDue();
  const issue = failureIssue([expectationChanged]);
  for (const openIssues of [
    [], [failureIssue([])], [failureIssue([{ recipeId: "kric-station-timetable", code: "SOURCE_FETCH_FAILED" }])],
    [{ ...issue, author: { login: "someone" } }], [{ ...issue, body: issue.body.replace("<!-- easysubway-refresh-failure:source-reverification.yml -->", "") }],
    [{ ...issue, body: `${issue.body}\n`.replace(/<!-- reverification-blocked:/u, "reverification-blocked:") }],
  ]) {
    assert.deepEqual(decideSourceReverification(input({ ledger, openIssues })).recipes, ["kric-station-timetable"]);
  }
});

test("의존 recipe는 자기 만료 기준 없이 의존 대상이 DUE일 때 함께 돌고, 실행 순서는 의존 순서다", () => {
  const staleLedger = ledgerAt(FRESH).map((entry) => (["korail-metropolitan-timetable-file", "daejeon-station-distance-fare"].includes(entry.sourceId) ? row(entry.sourceId, dueAgo(2 * DAY)) : entry));
  const result = decideSourceReverification(input({ ledger: staleLedger }));
  assert.deepEqual(result.recipes, ["korail-topology", "korail-planned-timetable", "daejeon-topology", "daejeon-accessibility", "daejeon-timetable"]);
  assert.deepEqual(result.due.map(({ recipeId }) => recipeId), ["korail-topology", "daejeon-topology"]);
});

test("대구는 세 노선 topology 중 하나만 DUE여도 여섯 원천을 함께 등록하는 recipe가 돈다", () => {
  const result = decideSourceReverification(input({ ledger: ledgerAt(FRESH).map((entry) => (entry.sourceId === "daegu-line2-route-topology" ? row(entry.sourceId, dueAgo(2 * DAY)) : entry)) }));
  assert.deepEqual(result.recipes, ["daegu-sources", "daegu-accessibility"]);
  assert.equal(result.due[0].sourceId, "daegu-line2-route-topology");
});

test("KRIC 시간표 projection은 inventory 증거의 observedAt을 기준으로 DUE를 가린다(원장 행이 없는 증거)", () => {
  const result = decideSourceReverification(input({ inventory: inventoryAt(dueAgo(DAY + HOUR)) }));
  assert.deepEqual(result.recipes, ["kric-capital-timetable"]);
  assert.equal(result.due[0].sourceId, "kric-nationwide-timetable-file");
  // 수도권·코레일 projection 증거가 서로 다른 시각이면 더 이른 쪽이 기준이다.
  const mixed = { sources: [{ id: "kric-nationwide-timetable-file", capitalScheduleAdmissionEvidence: { observedAt: iso(FRESH) }, korailScheduleAdmissionEvidence: { observedAt: iso(dueAgo(2 * DAY)) } }] };
  assert.deepEqual(decideSourceReverification(input({ inventory: mixed })).recipes, ["kric-capital-timetable"]);
});

test("판정 표는 recipe별 원천의 기준 시각·만료·dueAt을 그대로 돌려준다", () => {
  const table = sourceReverificationDue({ inventory: inventoryAt(FRESH), ledger: ledgerAt(FRESH), policy: POLICY, now: NOW });
  assert.equal(table.length, 9);
  const gwangju = table.find(({ sourceId }) => sourceId === "gwangju-transportation-route-topology");
  assert.deepEqual(gwangju, { recipeId: "gwangju-topology", sourceId: "gwangju-transportation-route-topology", basisAt: iso(FRESH), freshUntil: iso(FRESH + 7 * DAY), dueAt: iso(FRESH + DAY), state: "CURRENT" });
});

test("원장 head가 없거나 갈라졌거나 만료 시각이 없으면 판정하지 않고 이상으로 실패한다", () => {
  assert.throws(() => decideSourceReverification(input({ ledger: ledgerAt(FRESH).filter(({ sourceId }) => sourceId !== "busan-transportation-route-topology") })), /^Error: REVERIFICATION_SOURCE_UNREGISTERED: busan-transportation-route-topology/u);
  const forked = [...ledgerAt(FRESH), row("busan-transportation-route-topology", FRESH, { snapshotId: "busan-transportation-route-topology-2" })];
  assert.throws(() => decideSourceReverification(input({ ledger: forked })), /^Error: REVERIFICATION_LEDGER_BROKEN: busan-transportation-route-topology/u);
  assert.throws(() => decideSourceReverification(input({ ledger: ledgerAt(FRESH).map((entry) => (entry.sourceId === "busan-transportation-route-topology" ? { ...entry, freshnessExpiresAt: "내일" } : entry)) })), /^Error: REVERIFICATION_LEDGER_BROKEN: busan-transportation-route-topology/u);
  // 만료 필드가 없는 head는 연장하거나 건너뛰지 않고 이상으로 실패한다(KRIC 역별 시간표 행).
  const { freshnessExpiresAt: omitted, ...withoutExpiry } = stationLinesRow(FRESH);
  assert.throws(() => decideSourceReverification(input({ ledger: ledgerAt(FRESH).map((entry) => (entry.sourceId === STATION_LINES_SOURCE_ID ? withoutExpiry : entry)) })), /^Error: REVERIFICATION_LEDGER_BROKEN: kric-subway-timetable-station-lines/u);
  assert.throws(() => decideSourceReverification(input({ inventory: { sources: [] } })), /^Error: REVERIFICATION_EVIDENCE_MISSING: kric-nationwide-timetable-file/u);
  assert.throws(() => decideSourceReverification(input({ inventory: { sources: [{ id: "kric-nationwide-timetable-file", capitalScheduleAdmissionEvidence: { observedAt: iso(FRESH) } }] } })), /^Error: REVERIFICATION_EVIDENCE_MISSING: kric-nationwide-timetable-file/u);
  assert.throws(() => decideSourceReverification(input({ policy: { ...POLICY, scheduledPipeline: { cadence: "weekly" } } })), /REVERIFICATION_POLICY_INVALID/u);
  assert.throws(() => decideSourceReverification(input({ policy: { ...POLICY, monitoring: {} } })), /REVERIFICATION_POLICY_INVALID/u);
});

test("이 workflow의 열린 PR이 있으면 DUE 여부와 상관없이 OPEN_PR이다", () => {
  const branch = `${SOURCE_REVERIFICATION_CLAIM_PREFIX}1`;
  assert.deepEqual(decideSourceReverification(input({ pullRequests: [pr("OPEN", 1)], automationBranches: [branch] })), { state: "OPEN_PR", branch, due: [], recipes: [], cleanupClaims: [] });
});

test("열린 PR이 둘 이상이거나 claim 브랜치가 없거나 claim이 둘 이상이거나 닫힌 PR에 묶였으면 이상이다", () => {
  const a = `${SOURCE_REVERIFICATION_CLAIM_PREFIX}1`;
  const b = `${SOURCE_REVERIFICATION_CLAIM_PREFIX}2`;
  assert.throws(() => decideSourceReverification(input({ pullRequests: [pr("OPEN", 1), pr("OPEN", 2, { number: 991 })], automationBranches: [a, b] })), /REVERIFICATION_PR_DUPLICATE/u);
  assert.throws(() => decideSourceReverification(input({ pullRequests: [pr("OPEN", 1)] })), /REVERIFICATION_CLAIM_MISSING/u);
  assert.throws(() => decideSourceReverification(input({ automationBranches: [a, b] })), /REVERIFICATION_CLAIM_DUPLICATE/u);
  assert.throws(() => decideSourceReverification(input({ pullRequests: [pr("CLOSED", 1)], automationBranches: [a] })), /REVERIFICATION_CLAIM_CLOSED/u);
});

// 이 workflow는 OCI에 게시하기 전에 claim 브랜치를 push한다. PR 없는 claim은 producer run으로 처지를 가린다(복구 없이 정리한다: OCI 객체는 내용 주소라 다시 시작해도 안전).
test("PR 없는 claim은 producer run이 돌고 있으면 CLAIM_IN_PROGRESS로 기다린다", () => {
  const claim = `${SOURCE_REVERIFICATION_CLAIM_PREFIX}77`;
  assert.deepEqual(decideSourceReverification(input({ automationBranches: [claim], runs: [run(77, "in_progress")] })), { state: "CLAIM_IN_PROGRESS", branch: claim, due: [], recipes: [], cleanupClaims: [] });
});

test("끝난 run·기록 없는 run의 claim은 정리 대상으로 알리고 판정은 계속한다", () => {
  const claim = `${SOURCE_REVERIFICATION_CLAIM_PREFIX}77`;
  for (const runs of [[run(77, "completed", "failure")], [run(77, "completed", "cancelled")], [run(77, "completed", "success")], []]) {
    assert.deepEqual(decideSourceReverification(input({ automationBranches: [claim], runs })), { state: "NOT_DUE", due: [], recipes: [], blocked: [], cleanupClaims: [claim] });
  }
  const restarted = decideSourceReverification(input({ automationBranches: [claim], runs: [run(77, "completed", "failure")], ledger: ledgerAt(dueAgo(2 * DAY)) }));
  assert.equal(restarted.state, "RUN");
  assert.deepEqual(restarted.cleanupClaims, [claim]);
});

test("병합된 PR의 남은 claim도 정리 대상이고, 다른 workflow의 run을 가리키는 claim은 이상이다", () => {
  const claim = `${SOURCE_REVERIFICATION_CLAIM_PREFIX}5`;
  assert.deepEqual(decideSourceReverification(input({ pullRequests: [pr("MERGED", 5)], automationBranches: [claim] })).cleanupClaims, [claim]);
  assert.throws(() => decideSourceReverification(input({ automationBranches: [claim], runs: [run(5, "in_progress", null, { workflowName: "Source Derivative Rebinding" })] })), /REVERIFICATION_CLAIM_RUN_INVALID/u);
  assert.throws(() => decideSourceReverification(input({ automationBranches: [claim], runs: [run(5, "in_progress", null, { headBranch: "feature" })] })), /REVERIFICATION_CLAIM_RUN_INVALID/u);
});

test("DUE인데 원장을 쓰는 다른 자동화 PR·claim 브랜치가 있으면 BLOCKED_BY_PENDING_PR로 기다리고, DUE가 아니면 기다릴 이유도 없다", () => {
  const stale = ledgerAt(dueAgo(2 * DAY));
  const claim = "automation/456-capital-topology-registration-111";
  const waiting = decideSourceReverification(input({ ledger: stale, pullRequests: [writer(971)], automationBranches: [claim] }));
  assert.equal(waiting.state, "BLOCKED_BY_PENDING_PR");
  assert.deepEqual(waiting.blockedBy, [971, claim]);
  assert.ok(waiting.recipes.length > 0);
  assert.equal(decideSourceReverification(input({ pullRequests: [writer(971)] })).state, "NOT_DUE");
  // 후보 PR·사람 PR·병합된 PR의 claim은 기다릴 이유가 아니다.
  assert.equal(decideSourceReverification(input({ ledger: stale, pullRequests: [writer(973, "automation/927-nationwide-candidate-refresh-"), writer(974, "feat/x")] })).state, "RUN");
});

// #972 리뷰 F3: 목록 조회에는 개수 상한이 있다. 상한과 같은 개수면 잘렸을 수 있으므로 일부만 보고 판정하지 않는다.
test("PR 목록이나 아직 끝나지 않은 run 목록이 조회 상한에 닿으면 잘렸을 수 있으므로 판정하지 않고 실패한다", () => {
  const many = (count, factory) => Array.from({ length: count }, (_, index) => factory(index));
  assert.throws(() => decideSourceReverification(input({ pullRequests: many(1000, (index) => pr("OPEN", index + 1, { number: index + 1, headRefName: `feat/x-${index}` })) })), /REVERIFICATION_LIST_TRUNCATED: pull request list reached its limit 1000/u);
  assert.throws(() => decideSourceReverification(input({ runs: many(200, (index) => run(index + 1, "in_progress")) })), /REVERIFICATION_LIST_TRUNCATED: run list reached its limit 200/u);
  // 열린 이슈 목록이 잘렸으면 막힌 recipe 표지를 놓칠 수 있다. 일부만 보고 판정하지 않는다.
  assert.throws(() => decideSourceReverification(input({ openIssues: many(1000, (index) => ({ number: index + 1, title: "x", body: "", author: { login: "someone" } })) })), /REVERIFICATION_LIST_TRUNCATED: issue list reached its limit 1000/u);
  assert.equal(decideSourceReverification(input({ pullRequests: many(999, (index) => pr("OPEN", index + 1, { number: index + 1, headRefName: `feat/x-${index}` })) })).state, "NOT_DUE");
});

// #993: 상한은 열린 PR 목록에만 건다. 닫힘·병합 PR 이력은 자동화가 매일 PR을 열어 계속 쌓인다.
test("닫힘·병합 PR 이력이 상한을 훨씬 넘게 있어도 판정은 실패하지 않는다", () => {
  const history = (count, state) => Array.from({ length: count }, (_, index) => pr(state, index + 1, { number: 4000 + index, headRefName: `feat/old-${state}-${index}` }));
  const pullRequests = [...history(2500, "MERGED"), ...history(2500, "CLOSED")];
  assert.deepEqual(decideSourceReverification(input({ pullRequests })), { state: "NOT_DUE", due: [], recipes: [], blocked: [], cleanupClaims: [] });
  const claim = `${SOURCE_REVERIFICATION_CLAIM_PREFIX}77`;
  const merged = pr("MERGED", 77, { number: 4999 });
  assert.deepEqual(decideSourceReverification(input({ pullRequests: [...pullRequests, merged], automationBranches: [claim] })).cleanupClaims, [claim]);
});

// #987 리뷰 F1: 정기 실행이 하루 12번이라 끝난 run은 17일이면 200개를 넘는다. 끝난 run은 판정에 필요 없으므로(없는 run도 같은 ABANDONED) 상한에 세지 않는다.
test("끝난 run이 상한을 넘게 쌓여도 판정은 실패하지 않는다", () => {
  const history = Array.from({ length: 500 }, (_, index) => run(1000 + index, "completed", index % 2 === 0 ? "success" : "failure"));
  assert.deepEqual(decideSourceReverification(input({ runs: history })), { state: "NOT_DUE", due: [], recipes: [], blocked: [], cleanupClaims: [] });
  const claim = `${SOURCE_REVERIFICATION_CLAIM_PREFIX}1000`;
  assert.deepEqual(decideSourceReverification(input({ automationBranches: [claim], runs: history })).cleanupClaims, [claim]);
  assert.equal(decideSourceReverification(input({ automationBranches: [`${SOURCE_REVERIFICATION_CLAIM_PREFIX}77`], runs: [...history, run(77, "in_progress")] })).state, "CLAIM_IN_PROGRESS");
});

test("입력이 잘못되면 판정하지 않고 실패한다", () => {
  for (const overrides of [{ repository: "x" }, { pullRequests: null }, { automationBranches: null }, { runs: null }, { now: "지금" }, { ledger: null }, { inventory: null }, { limits: { pullRequests: 0, runs: 1, issues: 1 } }, { limits: { pullRequests: 1, runs: 1 } }, { openIssues: null }, { limits: undefined }]) {
    assert.throws(() => decideSourceReverification(input(overrides)), /REVERIFICATION_INPUT_INVALID/u, JSON.stringify(Object.keys(overrides)));
  }
});

test("claim 목록은 재확인 claim ref만 받는다", () => {
  const sha = "d".repeat(40);
  assert.deepEqual(parseSourceReverificationClaims(`${sha}\trefs/heads/${SOURCE_REVERIFICATION_CLAIM_PREFIX}5\n`), [`${SOURCE_REVERIFICATION_CLAIM_PREFIX}5`]);
  assert.deepEqual(parseSourceReverificationClaims(""), []);
  assert.throws(() => parseSourceReverificationClaims(`${sha}\trefs/heads/automation/other-1\n`), /REVERIFICATION_CLAIM_INVALID/u);
  assert.throws(() => parseSourceReverificationClaims(`${sha}\trefs/heads/${SOURCE_REVERIFICATION_CLAIM_PREFIX}5\n${sha}\trefs/heads/${SOURCE_REVERIFICATION_CLAIM_PREFIX}5\n`), /REVERIFICATION_CLAIM_INVALID/u);
});

// 커밋된 저장소 상태는 어떤 시각에도 판정 가능해야 한다(리터럴로 head를 고정하지 않는다, #942).
test("저장소의 실제 원장·inventory·정책은 이상 없이 판정된다", async () => {
  const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const readJson = async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"));
  const [inventory, ledger, policy] = await Promise.all([readJson("tools/datapack/source-inventory.json"), readJson("tools/datapack/release/source-snapshots.json"), readJson("release/product-gates/datapack-freshness-sla.json")]);
  const table = sourceReverificationDue({ inventory, ledger, policy, now: new Date() });
  assert.deepEqual(table.map(({ recipeId }) => recipeId).sort(), [
    "busan-topology", "daegu-sources", "daegu-sources", "daegu-sources", "daejeon-topology", "gwangju-topology", "korail-topology", "kric-capital-timetable", "kric-station-timetable",
  ]);
  const result = decideSourceReverification({ inventory, ledger, policy, pullRequests: [], automationBranches: [], runs: [], openIssues: [], repository: REPOSITORY, now: new Date("2099-01-01T00:00:00.000Z"), limits: { pullRequests: 1000, runs: 200, issues: 1000 } });
  assert.equal(result.state, "RUN");
  assert.deepEqual(result.recipes, [
    "kric-capital-timetable", "kric-station-timetable", "korail-topology", "korail-planned-timetable", "gwangju-topology", "gwangju-accessibility", "busan-topology", "busan-accessibility", "busan-timetable",
    "daejeon-topology", "daejeon-accessibility", "daejeon-timetable", "daegu-sources", "daegu-accessibility",
  ]);
});

test("CLI는 판정을 GITHUB_OUTPUT 값으로 남긴다", async () => {
  const written = [];
  const logs = [];
  const files = { "inv.json": inventoryAt(FRESH), "led.json": ledgerAt(dueAgo(2 * DAY)), "pol.json": POLICY, "prs.json": [], "runs.json": [], "issues.json": [] };
  const texts = { "branches.txt": `${"a".repeat(40)}\trefs/heads/automation/456-capital-topology-registration-1\n`, "claims.txt": "" };
  const result = await main([
    "--inventory", "inv.json", "--ledger", "led.json", "--policy", "pol.json", "--prs", "prs.json", "--automation-branches", "branches.txt",
    "--runs", "runs.json", "--issues", "issues.json", "--repository", REPOSITORY, "--pr-limit", "1000", "--run-limit", "200", "--issue-limit", "1000", "--github-output", "out.txt",
  ], { now: NOW, log: (line) => logs.push(line), readText: async (file) => (file in texts ? texts[file] : JSON.stringify(files[file])), appendText: async (file, text) => written.push([file, text]) });
  assert.equal(result.state, "BLOCKED_BY_PENDING_PR");
  assert.equal(written.length, 1);
  assert.equal(written[0][0], "out.txt");
  assert.match(written[0][1], /^state=BLOCKED_BY_PENDING_PR\nbranch=\nrecipes=kric-station-timetable,korail-topology,korail-planned-timetable,gwangju-topology,/u);
  assert.match(written[0][1], /\ncleanup_claims=\nblocked_by=automation\/456-capital-topology-registration-1\nblocked_recipes=\n$/u);
  assert.equal(JSON.parse(logs[0]).state, "BLOCKED_BY_PENDING_PR");
  await assert.rejects(main(["--inventory", "inv.json"], { now: NOW, log() {}, readText: async () => "{}" }), /REVERIFICATION_INPUT_INVALID/u);
});
