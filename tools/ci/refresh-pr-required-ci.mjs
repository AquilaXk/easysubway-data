#!/usr/bin/env node
// #939·#947 리뷰 F2: 열린 갱신 PR(OPEN_PR)의 head에 required CI(pull_request 이벤트의 ci.yml)가 붙어 있게 한다.
// - GITHUB_TOKEN으로 연 예전 PR은 pull_request CI가 action_required로 멈춰 있다. workflow_dispatch CI는 PR required check로
//   인정되지 않는다(#948 실험). 그래서 CI가 없으면 그 PR만 App(easysubway-release-chain) 토큰으로 닫았다 다시 연다.
//   reopened 이벤트가 App 행위자로 발생해 pull_request CI가 다시 실행된다.
// - 이미 붙었거나(rollup에 Data contracts) 같은 head의 pull_request CI가 진행 중이면 아무것도 쓰지 않는다(멱등).
// - required CI(Data contracts 계열)가 실패·취소·시간초과면 닫았다 다시 열지 않고 AUTOMATION_PR_CI_FAILED로 job을 실패시킨다(#969).
//   열린 지 manualCheckCadence가 지나서야 드러나지 않게, 실패 이슈(report-refresh-failure)로 바로 드러낸다.
// - 읽기는 GITHUB_TOKEN, 닫기·다시 열기만 App 토큰으로 한다. 실패하면 job을 실패시킨다.
//
// 사용: node tools/ci/refresh-pr-required-ci.mjs --workflow <file> --repository <owner/repo> [--github-output <path>]
//   환경: GH_TOKEN(읽기), APP_PR_TOKEN(App 설치 토큰, pull_requests: write)
import { execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { REFRESH_CLAIM_PREFIXES } from "./refresh-open-pr-age.mjs";

const REQUIRED_CONTEXT = "Data contracts";
// #969: required CI는 집계 check(Data contracts)와 shard·mobile job(Data contracts (...))이다.
// 판정은 allow list다(리뷰 F1). 성공은 SUCCESS만, 진행 중은 아래 알려진 상태만 인정하고, 실패는 아래 목록이다.
// 그 밖의 값(STALE·ACTION_REQUIRED·SKIPPED·모르는 값)은 조용히 통과시키지 않고 UNKNOWN 이상으로 실패한다.
const FAILED_CONCLUSIONS = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "STARTUP_FAILURE", "ERROR"]);
const IN_FLIGHT_STATES = new Set(["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"]);
const ACTIVE_RUN_STATUSES = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);
const SHA = /^[0-9a-f]{40}$/u;
const REOPEN_COMMENT = "열린 갱신 PR head에 required CI(pull_request)가 없어 App으로 다시 열어 CI를 실행한다(#939).";

function fail(code, detail = "") {
  throw new Error(detail ? `REFRESH_PR_CI_${code}: ${detail}` : `REFRESH_PR_CI_${code}`);
}

function checkName(item) { return item?.name ?? item?.context; }
function isRequiredFamily(name) { return name === REQUIRED_CONTEXT || (typeof name === "string" && name.startsWith(`${REQUIRED_CONTEXT} (`)); }
// check run은 status가 COMPLETED일 때만 conclusion을 본다(진행 중 항목의 conclusion은 이전 시도의 값일 수 있어 무시한다, 리뷰 F2).
// status가 없는 항목은 status context이고 결과는 state에 있다.
function checkOutcome(item) {
  if (typeof item?.status === "string") {
    const status = item.status.toUpperCase();
    return status === "COMPLETED" ? String(item.conclusion ?? "").toUpperCase() : status;
  }
  return String(item?.state ?? "").toUpperCase();
}
function classify(item) {
  const outcome = checkOutcome(item);
  if (outcome === "SUCCESS") return "SUCCESS";
  if (FAILED_CONCLUSIONS.has(outcome)) return "FAILED";
  if (IN_FLIGHT_STATES.has(outcome)) return "PENDING";
  return "UNKNOWN";
}
// 같은 이름이 여러 개면(rerun) 시작 시각이 가장 늦은 항목만 본다. 시각이 없으면 목록에서 뒤에 있는 항목이 최신이다.
function latestPerName(rollupContexts) {
  const latest = new Map();
  rollupContexts.forEach((item, index) => {
    const name = checkName(item);
    if (!isRequiredFamily(name)) return;
    const startedAt = Date.parse(item?.startedAt ?? "");
    const rank = Number.isFinite(startedAt) ? startedAt : Number.NEGATIVE_INFINITY;
    const previous = latest.get(name);
    if (!previous || rank >= previous.rank) latest.set(name, { item, rank, index });
  });
  return [...latest.values()].map(({ item }) => item);
}
function requiredChecks(rollupContexts) {
  return latestPerName(rollupContexts).map((item) => ({ name: checkName(item), outcome: checkOutcome(item), kind: classify(item) }));
}
const describe = (checks) => checks.map(({ name, outcome }) => `${name}=${outcome === "" ? "(empty)" : outcome}`);

export function failedRequiredChecks(rollupContexts) {
  return describe(requiredChecks(rollupContexts).filter(({ kind }) => kind === "FAILED"));
}
export function unknownRequiredChecks(rollupContexts) {
  return describe(requiredChecks(rollupContexts).filter(({ kind }) => kind === "UNKNOWN"));
}

export function requiredCiState({ headSha, rollupContexts, ciRuns }) {
  if (!SHA.test(headSha ?? "") || !Array.isArray(rollupContexts) || !Array.isArray(ciRuns)) fail("INPUT_INVALID");
  const checks = requiredChecks(rollupContexts);
  if (checks.some(({ kind }) => kind === "FAILED")) return "FAILED";
  if (checks.some(({ kind }) => kind === "UNKNOWN")) return "UNKNOWN";
  if (checks.some(({ kind }) => kind === "PENDING")) return "PENDING";
  if (checks.some(({ name }) => name === REQUIRED_CONTEXT)) return "ATTACHED";
  const pending = ciRuns.some((run) => run?.event === "pull_request" && run.headSha === headSha && ACTIVE_RUN_STATUSES.has(run.status));
  return pending ? "PENDING" : "MISSING";
}

const execFileAsync = promisify(execFile);
// PATH 검색 없이 GitHub Ubuntu runner의 고정 경로 gh를 쓴다. 이 CLI는 갱신 workflow에서만 실행한다.
const GH_EXECUTABLE = "/usr/bin/gh";
async function defaultGh(args, { token }) {
  const { stdout } = await execFileAsync(GH_EXECUTABLE, args, { env: { ...process.env, GH_TOKEN: token }, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

export async function ensureRefreshPullRequestRequiredCi({ workflow, repository, readToken, appToken, gh = defaultGh }) {
  const prefix = REFRESH_CLAIM_PREFIXES[workflow];
  if (!prefix) fail("WORKFLOW_INVALID", String(workflow));
  const read = async (args) => JSON.parse(await gh(args, { token: readToken }));
  const owned = (await read(["pr", "list", "--repo", repository, "--state", "open", "--base", "main", "--limit", "1000",
    "--json", "number,url,headRefName,headRefOid,baseRefName,isCrossRepository"]))
    .filter((item) => typeof item?.headRefName === "string" && item.headRefName.startsWith(prefix)
      && item.baseRefName === "main" && item.isCrossRepository === false);
  if (owned.length === 0) fail("PR_MISSING", `no open ${prefix}* pull request`);
  if (owned.length > 1) fail("PR_DUPLICATE", owned.map(({ number }) => `#${number}`).join(", "));
  const [pr] = owned;
  const { statusCheckRollup } = await read(["pr", "view", String(pr.number), "--repo", repository, "--json", "statusCheckRollup"]);
  const ciRuns = await read(["run", "list", "--repo", repository, "--workflow", "ci.yml", "--branch", pr.headRefName,
    "--event", "pull_request", "--limit", "100", "--json", "event,headSha,status,conclusion"]);
  const state = requiredCiState({ headSha: pr.headRefOid, rollupContexts: statusCheckRollup ?? [], ciRuns });
  // 이상: 실패한 required CI는 닫았다 다시 열어 덮지 않고 job을 실패시킨다(실패 이슈로 드러난다).
  if (state === "FAILED") throw new Error(`AUTOMATION_PR_CI_FAILED: #${pr.number} ${failedRequiredChecks(statusCheckRollup).join(", ")}`);
  // 알 수 없는 상태(STALE·ACTION_REQUIRED·모르는 값)도 이상이다. 다시 열기로 덮지 않는다.
  if (state === "UNKNOWN") throw new Error(`AUTOMATION_PR_CI_STATE_UNKNOWN: #${pr.number} ${unknownRequiredChecks(statusCheckRollup).join(", ")}`);
  if (state !== "MISSING") return { state, number: pr.number, headSha: pr.headRefOid };
  if (typeof appToken !== "string" || appToken.length === 0) fail("APP_TOKEN_REQUIRED");
  await gh(["pr", "close", String(pr.number), "--repo", repository, "--comment", REOPEN_COMMENT], { token: appToken });
  await gh(["pr", "reopen", String(pr.number), "--repo", repository], { token: appToken });
  return { state: "REOPENED", number: pr.number, headSha: pr.headRefOid };
}

function parseArgs(argv) {
  const keys = new Map([["--workflow", "workflow"], ["--repository", "repository"], ["--github-output", "githubOutput"]]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = keys.get(argv[index]);
    if (!key || Object.hasOwn(values, key) || typeof argv[index + 1] !== "string") fail("CLI");
    values[key] = argv[index + 1];
  }
  if (!values.workflow || !values.repository) fail("CLI");
  return values;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { workflow, repository, githubOutput } = parseArgs(process.argv.slice(2));
    const result = await ensureRefreshPullRequestRequiredCi({
      workflow, repository, readToken: process.env.GH_TOKEN, appToken: process.env.APP_PR_TOKEN,
    });
    console.log(`open refresh pull request #${result.number} required CI: ${result.state}`);
    if (githubOutput) await appendFile(githubOutput, `state=${result.state}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
