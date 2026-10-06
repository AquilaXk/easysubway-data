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
//
// DUE 기준(정책에서 읽는다, 코드에 기간을 두지 않는다):
//   dueAt = min(기준 시각 + scheduledPipeline.cadence, freshUntil - monitoring.alertBeforePackExpiry)
//   기준 시각 = 원천 등급(sourceClass)의 basisField. 원장 head 행에서, 원장 행이 없는 KRIC 시간표 projection은 inventory 증거에서 읽는다.
//   만료(freshUntil)는 연장하지 않는다. 만료 경보 창이 하루보다 먼저 오면 그 시각이 우선이다.
// 의존 recipe(접근성·계획 시각표)는 의존 대상이 돌 때 함께 돈다.
//
// 이 workflow는 OCI에 게시하기 전에 claim 브랜치를 push한다. PR 없는 claim은 producer run으로 처지를 가린다.
// 돌고 있으면 기다리고, 끝났거나 기록이 없으면 정리 대상이다(게시는 내용 주소 객체라 같은 원본으로 다시 시작해도 안전하다).
// 판정할 수 없는 상태(원장 head 없음·갈라짐·증거 누락·열린 PR 중복·다른 workflow의 run을 가리키는 claim 등)는 이상이다.
// 이상은 REVERIFICATION_* 코드로 실패해 실패 이슈로 드러난다. 이전·추정 값으로 대체하거나 성공으로 덮지 않는다.
//
// 사용: node tools/ci/decide-source-reverification.mjs --inventory <file> --ledger <file> --policy <file> --prs <gh pr list JSON>
//   --automation-branches <git ls-remote "automation/*" 출력> --runs <gh run list JSON> --repository <owner/repo>
//   --pr-limit <gh pr list --limit> --run-limit <gh run list --limit> [--github-output <path>]
import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { addCadence, deriveFreshnessExpiresAt } from "../datapack/freshness-policy.mjs";
import { requiredUtcInstant } from "../datapack/lib/utc-instant.mjs";
import { REVERIFICATION_RECIPES } from "../datapack/source-reverification-recipes.mjs";
import { ownPullRequestsByBranch, parseAutomationBranches, pendingLedgerWriters, validRepository } from "./automation-pr-state.mjs";
import { REFRESH_CLAIM_PREFIXES, isoDurationMs } from "./refresh-open-pr-age.mjs";

export const SOURCE_REVERIFICATION_WORKFLOW = "source-reverification.yml";
export const SOURCE_REVERIFICATION_CLAIM_PREFIX = REFRESH_CLAIM_PREFIXES[SOURCE_REVERIFICATION_WORKFLOW];
const WORKFLOW_NAME = "Source Reverification";
const CLAIM_PREFIX_PATTERN = SOURCE_REVERIFICATION_CLAIM_PREFIX.replaceAll("/", "\\/");
const CLAIM = new RegExp(`^${CLAIM_PREFIX_PATTERN}[1-9]\\d*$`, "u");

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

function dueEntry({ recipe, sourceId, basisAt, freshUntil, windows, nowMillis }) {
  const basisMillis = instant(basisAt, `${sourceId} basis`);
  const freshMillis = instant(freshUntil, `${sourceId} freshUntil`);
  const dueMillis = Math.min(addCadence(basisMillis, windows.cadence), freshMillis - windows.alertMillis);
  return {
    recipeId: recipe.id, sourceId, basisAt, freshUntil, dueAt: new Date(dueMillis).toISOString(), state: nowMillis >= dueMillis ? "DUE" : "CURRENT",
  };
}

function ledgerDueEntries({ recipe, ledger, policy, windows, nowMillis }) {
  return recipe.due.sourceIds.map((sourceId) => {
    const head = ledgerHead(ledger, sourceId);
    return dueEntry({ recipe, sourceId, basisAt: head[classOf(policy, sourceId).basisField], freshUntil: head.freshUntil, windows, nowMillis });
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
 * recipe가 자기 만료 기준을 가진 원천마다 기준 시각·만료·dueAt·상태를 계산한다(읽기 전용). 의존 recipe는 행이 없다.
 * @returns {{ recipeId: string, sourceId: string, basisAt: string, freshUntil: string, dueAt: string, state: "DUE"|"CURRENT" }[]}
 */
export function sourceReverificationDue({ inventory, ledger, policy, now, recipes = REVERIFICATION_RECIPES } = {}) {
  if (!Array.isArray(inventory?.sources) || !Array.isArray(ledger) || !(now instanceof Date) || Number.isNaN(now.getTime())) fail("REVERIFICATION_INPUT_INVALID");
  const windows = policyWindows(policy);
  const nowMillis = now.getTime();
  const entries = { "ledger-head": ledgerDueEntries, "inventory-evidence": evidenceDueEntries };
  return recipes.filter(({ due }) => due).flatMap((recipe) => entries[recipe.due.kind]({ recipe, ledger, inventory, policy, now, windows, nowMillis }));
}

// DUE인 recipe와 그에 의존하는 recipe를 recipe 표 순서(= 의존 순서)로 돌려준다.
function selectRecipes(dueRows, recipes) {
  const selected = new Set(dueRows.filter(({ state }) => state === "DUE").map(({ recipeId }) => recipeId));
  for (const recipe of recipes) if (recipe.dependsOn.some((dependency) => selected.has(dependency))) selected.add(recipe.id);
  return recipes.filter(({ id }) => selected.has(id)).map(({ id }) => id);
}

// PR 없는 claim의 처지를 producer run(claim 브랜치 이름의 run id)으로 가린다. 복구는 하지 않는다(정리하고 다시 시작한다).
function classifyUnboundClaim(branch, runs) {
  const runId = branch.slice(SOURCE_REVERIFICATION_CLAIM_PREFIX.length);
  const found = runs.find((item) => String(item?.databaseId) === runId);
  if (!found) return "ABANDONED";
  if (found.workflowName !== WORKFLOW_NAME || found.headBranch !== "main") fail("REVERIFICATION_CLAIM_RUN_INVALID", `${branch}: producer run ${runId} is not a ${WORKFLOW_NAME} run on main`);
  return found.status === "completed" ? "ABANDONED" : "RUNNING";
}

function assertDecisionInput({ inventory, ledger, pullRequests, automationBranches, runs, repository, now, limits }) {
  if (!Array.isArray(pullRequests) || !Array.isArray(automationBranches) || !Array.isArray(runs) || !validRepository(repository)
    || !(now instanceof Date) || Number.isNaN(now.getTime()) || !Array.isArray(ledger) || !Array.isArray(inventory?.sources)
    || !Number.isSafeInteger(limits?.pullRequests) || limits.pullRequests < 1 || !Number.isSafeInteger(limits?.runs) || limits.runs < 1) fail("REVERIFICATION_INPUT_INVALID");
  // 목록 조회에는 개수 상한이 있다. 상한과 같은 개수면 잘렸을 수 있으므로 일부만 보고 판정하지 않는다(#972 리뷰 F3).
  if (pullRequests.length >= limits.pullRequests) fail("REVERIFICATION_LIST_TRUNCATED", `pull request list reached its limit ${limits.pullRequests}`);
  if (runs.length >= limits.runs) fail("REVERIFICATION_LIST_TRUNCATED", `run list reached its limit ${limits.runs}`);
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

export function decideSourceReverification({ inventory, ledger, policy, pullRequests, automationBranches, runs, repository, now, limits, recipes = REVERIFICATION_RECIPES } = {}) {
  assertDecisionInput({ inventory, ledger, pullRequests, automationBranches, runs, repository, now, limits });
  const dueRows = sourceReverificationDue({ inventory, ledger, policy, now, recipes });
  const recipeIds = selectRecipes(dueRows, recipes);
  const due = dueRows.filter(({ state }) => state === "DUE").map(({ recipeId, sourceId, dueAt }) => ({ recipeId, sourceId, dueAt }));
  const { state, branch, cleanupClaims } = classifyClaims({ pullRequests, automationBranches, runs, repository });
  if (state) return { state, branch, due: [], recipes: [], cleanupClaims };
  if (recipeIds.length === 0) return { state: "NOT_DUE", due: [], recipes: [], cleanupClaims };
  const pending = pendingLedgerWriters({ pullRequests, automationBranches, repository, exceptWorkflow: SOURCE_REVERIFICATION_WORKFLOW });
  const blockedBy = [...pending.pullRequests, ...pending.branches];
  return blockedBy.length > 0
    ? { state: "BLOCKED_BY_PENDING_PR", blockedBy, due, recipes: recipeIds, cleanupClaims }
    : { state: "RUN", due, recipes: recipeIds, cleanupClaims };
}

function parseArgs(argv) {
  const keys = new Map([
    ["--inventory", "inventory"], ["--ledger", "ledger"], ["--policy", "policy"], ["--prs", "prs"], ["--automation-branches", "automationBranches"], ["--runs", "runs"],
    ["--repository", "repository"], ["--pr-limit", "prLimit"], ["--run-limit", "runLimit"], ["--github-output", "githubOutput"],
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = keys.get(argv[index]);
    if (!key || Object.hasOwn(values, key) || typeof argv[index + 1] !== "string") fail("REVERIFICATION_INPUT_INVALID", `argument ${String(argv[index])}`);
    values[key] = argv[index + 1];
  }
  for (const key of ["inventory", "ledger", "policy", "prs", "automationBranches", "runs", "repository", "prLimit", "runLimit"]) {
    if (!Object.hasOwn(values, key)) fail("REVERIFICATION_INPUT_INVALID", `missing --${key}`);
  }
  return values;
}

export async function main(argv, {
  now = new Date(), log = console.log, readText = (file) => readFile(file, "utf8"), appendText = (file, text) => appendFile(file, text),
} = {}) {
  const values = parseArgs(argv);
  const readJson = async (file) => JSON.parse(await readText(file));
  const result = decideSourceReverification({
    inventory: await readJson(values.inventory), ledger: await readJson(values.ledger), policy: await readJson(values.policy),
    pullRequests: await readJson(values.prs), automationBranches: parseAutomationBranches(await readText(values.automationBranches)), runs: await readJson(values.runs),
    repository: values.repository, now, limits: { pullRequests: Number(values.prLimit), runs: Number(values.runLimit) },
  });
  log(JSON.stringify(result));
  if (values.githubOutput) {
    await appendText(values.githubOutput, [
      `state=${result.state}`, `branch=${result.branch ?? ""}`, `recipes=${result.recipes.join(",")}`,
      `cleanup_claims=${result.cleanupClaims.join(",")}`, `blocked_by=${(result.blockedBy ?? []).join(",")}`, "",
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
