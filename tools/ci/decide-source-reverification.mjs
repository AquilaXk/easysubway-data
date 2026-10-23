#!/usr/bin/env node
// P7D 원천 재확인 판정(#984, #969 남은 단계 1, #870 전체 자동화 1단계).
//
// P7D 원천은 만료되기 전에 사람 없이 다시 등록돼야 한다. 이 판정은 읽기만 하고 재확인 workflow가 할 일을 한 단어로 돌려준다.
//
//   NOT_DUE                 DUE인 원천이 없다. 할 일이 없다.
//   RUN                     DUE인 원천이 있고 막는 것이 없다. recipes는 실행할 recipe(의존 순서)다.
//   OPEN_PR                 이 workflow의 열린 PR이 있다. 새 일을 하지 않고 CI·방치 상한만 본다.
//   CLAIM_IN_PROGRESS       PR 전의 claim을 만든 run이 아직 돈다. 기다린다.
//   BLOCKED_BY_PENDING_PR   DUE인데 같은 원장 파일을 쓰는 다른 자동화 PR·claim이 있다. 이상이 아니라 대기다.
//   BUDGET_BLOCKED          DUE인 recipe가 모두 공급자 하루 호출 예산(provider-call-budget)에 막혀 실행할 것이 없다. workflow가 job을 실패시킨다.
//
// 재생 run(--replay-run-id, #3036)은 뒤처져 닫힌 재확인 PR의 수집분을 공급자 호출 없이 다시 등록하므로 DUE가 아니어도 RUN이다.
//   다른 원장 쓰기 PR·claim에 막히면 기다리지 않고 REVERIFICATION_REPLAY_BLOCKED로 실패한다(ITX_PROMOTION_REPLAY_BLOCKED와 같다).
//   재생 입력은 이 dispatch에만 있어, 대기로 끝나면 막힘 재dispatch가 입력 없이 다시 돌려 공급자에서 다시 수집한다. 같은 replay_run_id로 다시 dispatch하면 복구된다.
// DUE 기준(정책에서 읽는다, 코드에 기간을 두지 않는다):
//   dueAt = min(기준 시각 + scheduledPipeline.cadence, freshUntil - monitoring.alertBeforePackExpiry)
//   기준 시각 = 원천 등급(sourceClass)의 basisField. 원장 head 행에서, 원장 행이 없는 KRIC 시간표 projection은 inventory 증거에서 읽는다.
//   만료(freshUntil)는 연장하지 않는다. 만료 경보 창이 하루보다 먼저 오면 그 시각이 우선이다.
// 연체(OVERDUE) 기준(#3036): overdueAt = min(dueAt + scheduledPipeline.cadence, freshUntil - monitoring.alertBeforePackExpiry)
//   DUE가 된 뒤 정기 주기가 한 번 더 지나도록 원장 head가 그대로이거나 만료 경보 창 안이면 연체다. 판정이 어느 상태로 끝나든 연체 행(overdue)을 돌려준다.
//   대기(OPEN_PR·CLAIM_IN_PROGRESS·BLOCKED_BY_PENDING_PR)는 성공으로 끝나 실패 이슈 경로를 타지 않으므로, workflow는 연체 행이 있으면 성공 run도 실패 이슈에 기록한다.
// 의존 recipe(접근성·계획 시각표)는 의존 대상이 돌 때 함께 돈다.
//
// 공급자 하루 호출 예산(#3036): 실행할 결속 묶음마다 같은 KST 날 앞선 run의 operation별 요청 수(provider-call-ledger)와 이번 묶음의 예상 요청 수를 더해
//   정책(release/product-gates/provider-daily-call-budget.json)의 한도·시도 상한을 넘으면 그 묶음을 빼고 budgetBlocked로 이유를 돌려준다. 다른 묶음은 그대로 돈다.
//   부분 수집은 없다: 묶음 단위로 시작하거나 시작하지 않는다. 재생 run과 대기 판정은 공급자를 부르지 않으므로 예산을 보지 않는다.
//
// 공급처 기대 관측이 바뀌어 사람이 기대값을 고쳐야 하는 recipe(SOURCE_EXPECTATION_CHANGED)는 이 workflow의 실패 이슈가 열려 있는 동안 건너뛴다(#1122).
// 같은 원인의 재수집을 2시간마다 되풀이하지 않기 위해서다. 건너뛴 recipe는 blocked로 드러나고, 이슈를 닫으면 다음 실행이 다시 수집한다. 만료를 연장하지 않는다.
//
// 이 workflow는 OCI에 게시하기 전에 claim 브랜치를 push한다. PR 없는 claim은 producer run으로 처지를 가린다.
// 돌고 있으면 기다리고, 끝났거나 기록이 없으면 정리 대상이다(게시는 내용 주소 객체라 같은 원본으로 다시 시작해도 안전하다).
// 판정할 수 없는 상태(원장 head 없음·갈라짐·증거 누락·열린 PR 중복·다른 workflow의 run을 가리키는 claim 등)는 이상이다.
// 이상은 REVERIFICATION_* 코드로 실패해 실패 이슈로 드러난다. 이전·추정 값으로 대체하거나 성공으로 덮지 않는다.
//
// 사용: node tools/ci/decide-source-reverification.mjs --inventory <file> --ledger <file> --policy <file> --prs <collect-automation-prs.mjs 출력>
//   --automation-branches <git ls-remote "automation/*" 출력> --runs <gh run list JSON> --issues <gh issue list JSON(열린 이슈, number·title·body·author)> --repository <owner/repo>
//   --pr-limit <gh pr list --limit> --run-limit <gh run list --limit> --issue-limit <gh issue list --limit>
//   --call-budget <provider-daily-call-budget.json> --provider-call-ledger <provider-call-ledger.mjs --ledger 출력> [--replay-run-id <원본 run id>] [--github-output <path>]
import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { addCadence, deriveFreshnessExpiresAt } from "../datapack/freshness-policy.mjs";
import { requiredUtcInstant } from "../datapack/lib/utc-instant.mjs";
import { REVERIFICATION_RECIPES, dependencyGroups } from "../datapack/source-reverification-recipes.mjs";
import { isReplayRunId } from "./decide-itx-current-promotion.mjs";
import { activeRuns, ownPullRequestsByBranch, parseAutomationBranches, pendingLedgerWriters, validRepository } from "./automation-pr-state.mjs";
import { evaluateProviderCallAllowance, parseProviderCallBudgetPolicy, parseProviderCallLedger } from "./provider-call-budget.mjs";
import { REFRESH_CLAIM_PREFIXES, isoDurationMs } from "./refresh-open-pr-age.mjs";
import { blockedRecipeIdsOf, failureIssuesOf } from "./report-refresh-failure.mjs";

export const SOURCE_REVERIFICATION_WORKFLOW = "source-reverification.yml";
export const SOURCE_REVERIFICATION_CLAIM_PREFIX = REFRESH_CLAIM_PREFIXES[SOURCE_REVERIFICATION_WORKFLOW];
const WORKFLOW_NAME = "Source Reverification";
const CLAIM_PREFIX_PATTERN = SOURCE_REVERIFICATION_CLAIM_PREFIX.replaceAll("/", String.raw`\/`);
const CLAIM_SUFFIX_PATTERN = String.raw`[1-9]\d*$`;
const CLAIM = new RegExp(`^${CLAIM_PREFIX_PATTERN}${CLAIM_SUFFIX_PATTERN}`, "u");

function fail(code, detail = "") {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

const instant = (value, label, code = "REVERIFICATION_LEDGER_BROKEN") => {
  try { return requiredUtcInstant(value, label); } catch (error) { return fail(code, `${label}: ${error.message}`); }
};

/** git ls-remote --heads 출력(automation/*)에서 브랜치 이름을 읽는다. */
export function parseSourceReverificationClaims(text) {
  const invalid = (detail) => fail("REVERIFICATION_CLAIM_INVALID", detail);
  if (typeof text !== "string") invalid("listing is not text");
  const claims = text.split("\n").filter(Boolean).map((line) => {
    const match = /^[0-9a-f]{40}\trefs\/heads\/(.+)$/u.exec(line);
    if (!match || !CLAIM.test(match[1])) invalid(line);
    return match[1];
  });
  if (new Set(claims).size !== claims.length) invalid("duplicate refs");
  return claims;
}

function policyWindows(policy) {
  try {
    const cadence = policy?.scheduledPipeline?.cadence;
    addCadence(0, cadence);
    const alertMillis = isoDurationMs(policy?.monitoring?.alertBeforePackExpiry);
    if (alertMillis <= 0) throw new Error("alertBeforePackExpiry must be positive");
    return { cadence, alertMillis };
  } catch (error) {
    return fail("REVERIFICATION_POLICY_INVALID", String(error.message));
  }
}

function classOf(policy, sourceId) {
  const found = (policy?.sourceClasses ?? []).filter((entry) => Array.isArray(entry?.sourceIds) && entry.sourceIds.includes(sourceId));
  if (found.length !== 1) fail("REVERIFICATION_POLICY_INVALID", `${sourceId} is not in exactly one source class`);
  return found[0];
}

// 가장 최근 행 = 같은 원천의 어떤 행도 previousSnapshotId로 가리키지 않는 행. 하나여야 한다.
export function ledgerHead(ledger, sourceId) {
  const rows = ledger.filter((row) => row?.sourceId === sourceId);
  if (rows.length === 0) fail("REVERIFICATION_SOURCE_UNREGISTERED", sourceId);
  const referenced = new Set(rows.map((row) => row.previousSnapshotId).filter((id) => typeof id === "string"));
  const heads = rows.filter((row) => !referenced.has(row.snapshotId));
  if (heads.length !== 1) fail("REVERIFICATION_LEDGER_BROKEN", `${sourceId}: ${heads.length} ledger heads`);
  return heads[0];
}

function dueState(nowMillis, dueMillis, overdueMillis) {
  if (nowMillis >= overdueMillis) return "OVERDUE";
  return nowMillis >= dueMillis ? "DUE" : "CURRENT";
}

function dueEntry({ recipe, sourceId, basisAt, freshUntil, windows, nowMillis }) {
  const basisMillis = instant(basisAt, `${sourceId} basis`);
  const alertMillis = instant(freshUntil, `${sourceId} freshUntil`) - windows.alertMillis;
  const dueMillis = Math.min(addCadence(basisMillis, windows.cadence), alertMillis);
  const overdueMillis = Math.min(addCadence(dueMillis, windows.cadence), alertMillis);
  return {
    recipeId: recipe.id, sourceId, basisAt, freshUntil, dueAt: new Date(dueMillis).toISOString(), overdueAt: new Date(overdueMillis).toISOString(),
    state: dueState(nowMillis, dueMillis, overdueMillis),
  };
}

function ledgerDueEntries({ recipe, ledger, policy, windows, nowMillis }) {
  return recipe.due.sourceIds.map((sourceId) => {
    const head = ledgerHead(ledger, sourceId);
    // 만료는 모든 원장 행이 싣는 정책 파생 값(freshnessExpiresAt)이다. freshUntil은 일부 행에만 있다(KRIC 역별 시간표 행에는 없다, #1122).
    return dueEntry({ recipe, sourceId, basisAt: head[classOf(policy, sourceId).basisField], freshUntil: head.freshnessExpiresAt, windows, nowMillis });
  });
}

// 원장 행이 없는 증거(KRIC 시간표 projection): inventory 증거의 관측 시각이 기준이다.
// 같은 원천의 projection 증거가 여럿이면 가장 이른 관측이 기준이다(가장 먼저 만료되는 쪽이 다시 확인을 이끈다).
function evidenceDueEntries({ recipe, inventory, policy, now, windows, nowMillis }) {
  const { due } = recipe;
  const sources = inventory.sources.filter((entry) => entry?.id === due.sourceId);
  if (sources.length !== 1) fail("REVERIFICATION_EVIDENCE_MISSING", due.sourceId);
  const observed = due.evidenceKeys.map((key) => {
    const value = sources[0][key]?.[due.basisField];
    if (typeof value !== "string") fail("REVERIFICATION_EVIDENCE_MISSING", `${due.sourceId}: ${key}.${due.basisField}`);
    return { value, millis: instant(value, `${due.sourceId} ${due.basisField}`, "REVERIFICATION_EVIDENCE_MISSING") };
  });
  const basisAt = observed.reduce((earliest, entry) => (entry.millis < earliest.millis ? entry : earliest)).value;
  let freshUntil;
  try {
    freshUntil = deriveFreshnessExpiresAt({ policy: { clockSkewSeconds: policy.clockSkewSeconds, sourceClasses: [classOf(policy, due.sourceId)] }, sourceClassId: due.classId, basisAt, providerValidUntil: null, evaluationAt: now.toISOString() });
  } catch (error) {
    fail("REVERIFICATION_EVIDENCE_MISSING", `${due.sourceId}: ${error.message}`);
  }
  return [dueEntry({ recipe, sourceId: due.sourceId, basisAt, freshUntil, windows, nowMillis })];
}

/**
 * recipe가 자기 만료 기준을 가진 원천마다 기준 시각·만료·dueAt·overdueAt·상태를 계산한다(읽기 전용). 의존 recipe는 행이 없다.
 * @returns {{ recipeId: string, sourceId: string, basisAt: string, freshUntil: string, dueAt: string, overdueAt: string, state: "CURRENT"|"DUE"|"OVERDUE" }[]}
 */
export function sourceReverificationDue({ inventory, ledger, policy, now, recipes = REVERIFICATION_RECIPES } = {}) {
  if (!Array.isArray(inventory?.sources) || !Array.isArray(ledger) || !(now instanceof Date) || Number.isNaN(now.getTime())) fail("REVERIFICATION_INPUT_INVALID");
  const windows = policyWindows(policy);
  const nowMillis = now.getTime();
  const entries = { "ledger-head": ledgerDueEntries, "inventory-evidence": evidenceDueEntries };
  return recipes.filter(({ due }) => due).flatMap((recipe) => entries[recipe.due.kind]({ recipe, ledger, inventory, policy, now, windows, nowMillis }));
}

const isDue = ({ state }) => state !== "CURRENT";

// 주어진 recipe와 그에 의존하는 recipe를 recipe 표 순서(= 의존 순서)로 돌려준다.
function withDependents(recipeIds, recipes) {
  const selected = new Set(recipeIds);
  for (const recipe of recipes) if (recipe.dependsOn.some((dependency) => selected.has(dependency))) selected.add(recipe.id);
  return recipes.filter(({ id }) => selected.has(id)).map(({ id }) => id);
}

// 실패 이슈 표지로 막힌 recipe와 그에 의존하는 recipe.
function blockedRecipeIds({ openIssues, recipes }) {
  return new Set(withDependents(failureIssuesOf({ openIssues, workflowFile: SOURCE_REVERIFICATION_WORKFLOW }).flatMap(({ body }) => blockedRecipeIdsOf(body ?? "")), recipes));
}

const overdueRowsOf = (dueRows) => dueRows.filter(({ state }) => state === "OVERDUE").map(({ recipeId, sourceId, dueAt, overdueAt }) => ({ recipeId, sourceId, dueAt, overdueAt }));

// 연체 recipe의 정의는 한 곳이다: 연체 행이 있는 recipe와 그에 의존하는 recipe. 의존 recipe는 의존 대상이 돌 때만 다시 등록되므로 함께 연체다.
const overdueRecipeIdsOf = (overdueRows, recipes) => withDependents(overdueRows.map(({ recipeId }) => recipeId), recipes);

/** DUE이거나 연체인 recipe와 그에 의존하는 recipe(recipe 표 순서). 실패 이슈 표지로 막힌 recipe도 포함한다. */
export function dueReverificationRecipes({ inventory, ledger, policy, now, recipes = REVERIFICATION_RECIPES } = {}) {
  return withDependents(sourceReverificationDue({ inventory, ledger, policy, now, recipes }).filter(isDue).map(({ recipeId }) => recipeId), recipes);
}

/** 재확인 기한을 넘긴 recipe와 그에 의존하는 recipe(recipe 표 순서). */
export function overdueReverificationRecipes({ inventory, ledger, policy, now, recipes = REVERIFICATION_RECIPES } = {}) {
  return overdueRecipeIdsOf(overdueRowsOf(sourceReverificationDue({ inventory, ledger, policy, now, recipes })), recipes);
}

// PR 없는 claim의 처지를 producer run(claim 브랜치 이름의 run id)으로 가린다. 복구는 하지 않는다(정리하고 다시 시작한다).
function classifyUnboundClaim(branch, runs) {
  const runId = branch.slice(SOURCE_REVERIFICATION_CLAIM_PREFIX.length);
  // 끝난 run은 목록에 없는 run과 같다(둘 다 정리 대상). 끝나지 않은 run만 본다.
  const found = activeRuns(runs).find((item) => String(item?.databaseId) === runId);
  if (!found) return "ABANDONED";
  if (found.workflowName !== WORKFLOW_NAME || found.headBranch !== "main") fail("REVERIFICATION_CLAIM_RUN_INVALID", `${branch}: producer run ${runId} is not a ${WORKFLOW_NAME} run on main`);
  return found.status === "completed" ? "ABANDONED" : "RUNNING";
}

const isProviderBudget = (budget) => Array.isArray(budget?.policy?.operations) && Object.hasOwn(budget, "ledger")
  && budget.expectedRequests !== null && typeof budget.expectedRequests === "object";

function assertDecisionInput({ inventory, ledger, pullRequests, automationBranches, runs, openIssues, repository, now, limits, replayRunId, providerBudget }) {
  if ((replayRunId !== undefined && !isReplayRunId(replayRunId)) || !isProviderBudget(providerBudget) || !Array.isArray(pullRequests) || !Array.isArray(openIssues) || !Array.isArray(automationBranches) || !Array.isArray(runs) || !validRepository(repository)
    || !(now instanceof Date) || Number.isNaN(now.getTime()) || !Array.isArray(ledger) || !Array.isArray(inventory?.sources)
    || !Number.isSafeInteger(limits?.pullRequests) || limits.pullRequests < 1 || !Number.isSafeInteger(limits?.runs) || limits.runs < 1 || !Number.isSafeInteger(limits?.issues) || limits.issues < 1) fail("REVERIFICATION_INPUT_INVALID");
  // 목록 조회에는 개수 상한이 있다. 상한과 같은 개수면 잘렸을 수 있으므로 일부만 보고 판정하지 않는다(#972 리뷰 F3).
  // 상한은 열린 PR에만 적용한다. 목록은 열린 PR 전체와 automation/* 브랜치별 PR(전 상태)이고(collect-automation-prs.mjs), 닫힘·병합 이력은 쌓여도 판정에 영향이 없다(#993).
  if (pullRequests.filter(({ state }) => state === "OPEN").length >= limits.pullRequests) fail("REVERIFICATION_LIST_TRUNCATED", `pull request list reached its limit ${limits.pullRequests}`);
  if (activeRuns(runs).length >= limits.runs) fail("REVERIFICATION_LIST_TRUNCATED", `run list reached its limit ${limits.runs}`);
  if (openIssues.length >= limits.issues) fail("REVERIFICATION_LIST_TRUNCATED", `issue list reached its limit ${limits.issues}`);
}

// 이 workflow의 열린 PR과 claim 브랜치의 처지. 정할 수 있으면 state를, 아니면 state 없이 정리 대상 claim만 돌려준다.
function classifyClaims({ pullRequests, automationBranches, runs, repository }) {
  const own = ownPullRequestsByBranch(pullRequests, SOURCE_REVERIFICATION_CLAIM_PREFIX, repository, (branch) => fail("REVERIFICATION_PR_DUPLICATE", branch));
  const open = [...own.values()].filter(({ state }) => state === "OPEN");
  if (open.length > 1) fail("REVERIFICATION_PR_DUPLICATE", open.map(({ number }) => `#${number}`).join(", "));
  const claims = automationBranches.filter((branch) => CLAIM.test(branch));
  const live = claims.filter((branch) => own.get(branch)?.state !== "MERGED");
  // 병합된 PR의 claim 브랜치는 살아 있는 claim이 아니다. 정리 대상으로 알린다.
  const cleanupClaims = claims.filter((branch) => own.get(branch)?.state === "MERGED");
  if (live.length > 1) fail("REVERIFICATION_CLAIM_DUPLICATE", live.join(", "));
  if (open.length === 1) {
    const [pullRequest] = open;
    if (!live.includes(pullRequest.headRefName)) fail("REVERIFICATION_CLAIM_MISSING", `#${pullRequest.number} has no claim branch`);
    return { state: "OPEN_PR", branch: pullRequest.headRefName, cleanupClaims };
  }
  if (live.length === 1) {
    const [branch] = live;
    if (own.get(branch)?.state === "CLOSED") fail("REVERIFICATION_CLAIM_CLOSED", `${branch} is bound to a closed pull request`);
    if (classifyUnboundClaim(branch, runs) === "RUNNING") return { state: "CLAIM_IN_PROGRESS", branch, cleanupClaims };
    cleanupClaims.push(branch);
  }
  return { state: null, cleanupClaims };
}

// 실행할 결속 묶음 중 공급자 하루 호출 예산이 허락하지 않는 묶음과 그 이유(#3036).
function budgetBlockedGroups({ recipeIds, recipes, providerBudget }) {
  return dependencyGroups(recipes.filter(({ id }) => recipeIds.includes(id))).flatMap((group) => {
    const allowance = evaluateProviderCallAllowance({ ...providerBudget, sourceIds: group.flatMap(({ sourceIds }) => sourceIds) });
    return allowance.allowed ? [] : [{ recipeIds: group.map(({ id }) => id), reason: allowance.reason, detail: allowance.detail }];
  });
}

// 실행할 recipe에서 예산에 막힌 묶음을 뺀다. 남은 것이 없으면 BUDGET_BLOCKED다.
function runWithinBudget({ due, recipeIds, blocked, recipes, providerBudget }) {
  const budgetBlocked = budgetBlockedGroups({ recipeIds, recipes, providerBudget });
  const refused = new Set(budgetBlocked.flatMap((group) => group.recipeIds));
  const runnable = recipeIds.filter((id) => !refused.has(id));
  return { state: runnable.length === 0 ? "BUDGET_BLOCKED" : "RUN", due: due.filter(({ recipeId }) => !refused.has(recipeId)), recipes: runnable, blocked, budgetBlocked };
}

export function decideSourceReverification({ inventory, ledger, policy, pullRequests, automationBranches, runs, openIssues, repository, now, limits, replayRunId, providerBudget, recipes = REVERIFICATION_RECIPES } = {}) {
  assertDecisionInput({ inventory, ledger, pullRequests, automationBranches, runs, openIssues, repository, now, limits, replayRunId, providerBudget });
  const dueRows = sourceReverificationDue({ inventory, ledger, policy, now, recipes });
  const blockedIds = blockedRecipeIds({ openIssues, recipes });
  const selected = withDependents(dueRows.filter(isDue).map(({ recipeId }) => recipeId), recipes);
  const recipeIds = selected.filter((id) => !blockedIds.has(id));
  const blocked = selected.filter((id) => blockedIds.has(id));
  const due = dueRows.filter((row) => isDue(row) && !blockedIds.has(row.recipeId)).map(({ recipeId, sourceId, dueAt }) => ({ recipeId, sourceId, dueAt }));
  const overdue = overdueRowsOf(dueRows);
  const { state, branch, cleanupClaims } = classifyClaims({ pullRequests, automationBranches, runs, repository });
  const replay = replayRunId === undefined ? {} : { replayRunId };
  if (state) return { state, branch, due: [], recipes: [], cleanupClaims, overdue, ...replay };
  const work = replayRunId === undefined ? { due, recipes: recipeIds, blocked, budgetBlocked: [] } : { due: [], recipes: [], blocked: [], budgetBlocked: [] };
  if (replayRunId === undefined && recipeIds.length === 0) return { state: "NOT_DUE", due: [], recipes: [], blocked, budgetBlocked: [], cleanupClaims, overdue };
  const pending = pendingLedgerWriters({ pullRequests, automationBranches, repository, exceptWorkflow: SOURCE_REVERIFICATION_WORKFLOW });
  const blockedBy = [...pending.pullRequests, ...pending.branches];
  if (blockedBy.length > 0 && replayRunId !== undefined) {
    const blockers = blockedBy.map((blocker) => (typeof blocker === "number" ? `#${blocker}` : blocker)).join(", ");
    fail("REVERIFICATION_REPLAY_BLOCKED", `replay of run ${replayRunId} is blocked by ${blockers}; dispatch ${SOURCE_REVERIFICATION_WORKFLOW} again with replay_run_id=${replayRunId} once they are merged or closed`);
  }
  if (blockedBy.length > 0) return { state: "BLOCKED_BY_PENDING_PR", blockedBy, ...work, cleanupClaims, overdue, ...replay };
  if (replayRunId !== undefined) return { state: "RUN", ...work, cleanupClaims, overdue, ...replay };
  return { ...runWithinBudget({ due, recipeIds, blocked, recipes, providerBudget }), cleanupClaims, overdue };
}

function parseArgs(argv) {
  const keys = new Map([
    ["--inventory", "inventory"], ["--ledger", "ledger"], ["--policy", "policy"], ["--prs", "prs"], ["--automation-branches", "automationBranches"], ["--runs", "runs"], ["--issues", "issues"],
    ["--repository", "repository"], ["--pr-limit", "prLimit"], ["--run-limit", "runLimit"], ["--issue-limit", "issueLimit"], ["--replay-run-id", "replayRunId"], ["--github-output", "githubOutput"],
    ["--call-budget", "callBudget"], ["--provider-call-ledger", "providerCallLedger"],
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = keys.get(argv[index]);
    if (!key || Object.hasOwn(values, key) || typeof argv[index + 1] !== "string") fail("REVERIFICATION_INPUT_INVALID", `argument ${String(argv[index])}`);
    values[key] = argv[index + 1];
  }
  for (const key of ["inventory", "ledger", "policy", "prs", "automationBranches", "runs", "issues", "repository", "prLimit", "runLimit", "issueLimit", "callBudget", "providerCallLedger"]) {
    if (!Object.hasOwn(values, key)) fail("REVERIFICATION_INPUT_INVALID", `missing --${key}`);
  }
  return values;
}

const SNAPSHOT_PATH = /^tools\/datapack\/sources\/[^/]+\.json$/u;
// 이번 묶음이 operation마다 보낼 요청 수: inventory 증거(policy의 expectedRequestsEvidence)가 가리키는 마지막 성공 수집 snapshot의 requestCount.
async function expectedRequestsOf({ budgetPolicy, inventory, readJson }) {
  return Object.fromEntries(await Promise.all(budgetPolicy.operations.map(async ({ sourceId, expectedRequestsEvidence }) => {
    const sources = inventory.sources.filter(({ id }) => id === sourceId);
    const snapshotPath = sources.length === 1 ? sources[0][expectedRequestsEvidence]?.snapshotPath : undefined;
    if (typeof snapshotPath !== "string" || !SNAPSHOT_PATH.test(snapshotPath)) fail("REVERIFICATION_INPUT_INVALID", `${sourceId} has no ${expectedRequestsEvidence}.snapshotPath`);
    const { requestCount } = await readJson(snapshotPath);
    if (!Number.isSafeInteger(requestCount) || requestCount < 1) fail("REVERIFICATION_INPUT_INVALID", `${sourceId} snapshot requestCount must be a positive integer`);
    return [sourceId, requestCount];
  })));
}

const budgetBlockReason = ({ reason, detail }) => `${reason}: ${detail}`;

export async function main(argv, {
  now = new Date(), log = console.log, readText = (file) => readFile(file, "utf8"), appendText = (file, text) => appendFile(file, text),
} = {}) {
  const values = parseArgs(argv);
  const readJson = async (file) => JSON.parse(await readText(file));
  const inventory = await readJson(values.inventory);
  const budgetPolicy = parseProviderCallBudgetPolicy(await readJson(values.callBudget));
  const providerBudget = {
    policy: budgetPolicy, ledger: parseProviderCallLedger(await readJson(values.providerCallLedger)), expectedRequests: await expectedRequestsOf({ budgetPolicy, inventory, readJson }),
  };
  const result = decideSourceReverification({
    inventory, ledger: await readJson(values.ledger), policy: await readJson(values.policy), providerBudget,
    pullRequests: await readJson(values.prs), automationBranches: parseAutomationBranches(await readText(values.automationBranches)), runs: await readJson(values.runs),
    openIssues: await readJson(values.issues), repository: values.repository, now, limits: { pullRequests: Number(values.prLimit), runs: Number(values.runLimit), issues: Number(values.issueLimit) },
    replayRunId: values.replayRunId === "" ? undefined : values.replayRunId,
  });
  log(JSON.stringify(result));
  if (values.githubOutput) {
    await appendText(values.githubOutput, [
      `state=${result.state}`, `branch=${result.branch ?? ""}`, `recipes=${result.recipes.join(",")}`,
      `cleanup_claims=${result.cleanupClaims.join(",")}`, `blocked_by=${(result.blockedBy ?? []).join(",")}`, `blocked_recipes=${(result.blocked ?? []).join(",")}`,
      `overdue_recipes=${overdueRecipeIdsOf(result.overdue, REVERIFICATION_RECIPES).join(",")}`, `replay_run_id=${result.replayRunId ?? ""}`,
      `budget_blocked=${(result.budgetBlocked ?? []).flatMap(({ recipeIds }) => recipeIds).join(",")}`,
      `budget_blocked_reason=${(result.budgetBlocked ?? []).map(budgetBlockReason).join(" | ")}`, "",
    ].join("\n"));
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
