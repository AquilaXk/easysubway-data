#!/usr/bin/env node
// 외부 스케줄러 heartbeat 점검(#1001, #870).
//
// GitHub `schedule`은 실행이 늦거나 빠진다. 그래서 OCI k3s CronJob(platform 레포)이 App easysubway-release-chain[bot]으로
// data 정기 workflow를 workflow_dispatch로 깨운다. GitHub `schedule`은 백업 경로로 남는다.
// 스케줄러가 멈추면 백업 경로가 그대로 돌아 갱신은 계속되지만, 그 사실이 조용히 묻힌다. 이 점검이 그 침묵을 드러낸다.
//
// 정책(release/product-gates/external-scheduler-heartbeat.json)에 적힌 workflow마다 App이 main에 dispatch한 가장 최근 run이
// maxAge 안에 있어야 한다. 없거나(MISSING) 늦으면(STALE) 실패하고, workflow의 실패 보고 단계가 #926 실패 이슈로 알린다.
// run의 성공·실패는 보지 않는다(실패는 그 workflow가 자기 경로로 보고한다). 점검할 수 없으면(API 오류, 깨진 응답) 통과가 아니라 실패다.
//
// 사용: node tools/ci/check-scheduler-heartbeat.mjs --repository <owner/repo> --policy <policy json>
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { defaultRunGh } from "./report-refresh-failure.mjs";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const WORKFLOW_FILE = /^[a-z0-9][a-z0-9-]*\.yml$/u;
const POLICY_KEYS = ["schemaVersion", "artifactKind", "dispatcher", "workflows"];
const DISPATCHER = Object.freeze({ login: "easysubway-release-chain[bot]", type: "Bot" });
// GitHub와 runner 시계 차이를 받아주는 한도. 이보다 미래인 run 시각은 깨진 응답이다.
const CLOCK_SKEW_MS = 300_000;
// run의 display_title(run-name)과 정확히 비교하는 값. 한 줄 출력 가능 문자만 허용한다.
const RUN_NAME = /^[\x20-\x7e]{1,120}$/u;
const MAX_AGE = /^(?:PT([1-9]\d{0,3})([HM])|P([1-9]\d{0,2})D)$/u;

function fail(code, detail = "") {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

export function parseMaxAge(value) {
  const match = typeof value === "string" ? MAX_AGE.exec(value) : null;
  if (!match) fail("SCHEDULER_HEARTBEAT_POLICY", `maxAge ${JSON.stringify(value)}`);
  if (match[3]) return Number(match[3]) * 86_400_000;
  return Number(match[1]) * (match[2] === "H" ? 3_600_000 : 60_000);
}

export function validateHeartbeatPolicy(policy) {
  if (!exactKeys(policy, POLICY_KEYS) || policy.schemaVersion !== 1 || policy.artifactKind !== "external-scheduler-heartbeat-policy") fail("SCHEDULER_HEARTBEAT_POLICY", "shape");
  if (!exactKeys(policy.dispatcher, ["login", "type"]) || policy.dispatcher.login !== DISPATCHER.login || policy.dispatcher.type !== DISPATCHER.type) {
    fail("SCHEDULER_HEARTBEAT_POLICY", `dispatcher must be ${DISPATCHER.login}`);
  }
  if (!Array.isArray(policy.workflows) || policy.workflows.length === 0) fail("SCHEDULER_HEARTBEAT_POLICY", "workflows");
  const byWorkflow = new Map();
  for (const item of policy.workflows) {
    if (!isObject(item) || !Object.keys(item).every((key) => ["workflow", "maxAge", "runName"].includes(key)) || !Object.hasOwn(item, "workflow") || !Object.hasOwn(item, "maxAge")
      || typeof item.workflow !== "string" || !WORKFLOW_FILE.test(item.workflow)) {
      fail("SCHEDULER_HEARTBEAT_POLICY", `workflow ${JSON.stringify(item?.workflow)}`);
    }
    parseMaxAge(item.maxAge);
    if (Object.hasOwn(item, "runName") && (typeof item.runName !== "string" || !RUN_NAME.test(item.runName))) fail("SCHEDULER_HEARTBEAT_POLICY", `runName ${JSON.stringify(item.runName)}`);
    byWorkflow.set(item.workflow, [...(byWorkflow.get(item.workflow) ?? []), item.runName]);
  }
  // 한 workflow를 dispatch 종류별로 나눌 때는 모두 runName이 있고 서로 달라야 한다(없는 항목이 섞이면 종류를 가려낼 수 없다).
  for (const [workflow, names] of byWorkflow) {
    const keyed = names.filter((name) => name !== undefined);
    if (names.length > 1 && (keyed.length !== names.length || new Set(keyed).size !== keyed.length)) fail("SCHEDULER_HEARTBEAT_POLICY", `${workflow} entries must each have a distinct runName`);
  }
  return policy;
}

function runTime(run, now, workflow) {
  const millis = typeof run?.created_at === "string" ? Date.parse(run.created_at) : Number.NaN;
  if (!Number.isFinite(millis) || millis > now.getTime() + CLOCK_SKEW_MS) fail("SCHEDULER_HEARTBEAT_RUN_INVALID", `${workflow} run created_at ${JSON.stringify(run?.created_at)}`);
  return millis;
}

export function checkSchedulerHeartbeat({ policy, runsByWorkflow, now }) {
  validateHeartbeatPolicy(policy);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) fail("SCHEDULER_HEARTBEAT_ARGUMENTS", "clock");
  const violations = [];
  const results = [];
  for (const { workflow, maxAge, runName } of policy.workflows) {
    const label = runName === undefined ? workflow : `${workflow} (${runName})`;
    const runs = runsByWorkflow?.[workflow];
    if (!Array.isArray(runs)) fail("SCHEDULER_HEARTBEAT_RUN_INVALID", `${workflow} has no run list`);
    const dispatched = runs
      .filter((run) => run?.event === "workflow_dispatch" && run.head_branch === "main"
        && run.actor?.login === policy.dispatcher.login && run.actor?.type === policy.dispatcher.type
        && (runName === undefined || run.display_title === runName))
      .map((run) => runTime(run, now, workflow));
    if (dispatched.length === 0) {
      violations.push(`SCHEDULER_HEARTBEAT_MISSING: ${label} has no workflow_dispatch run by ${policy.dispatcher.login} on main`);
      continue;
    }
    const age = Math.max(0, now.getTime() - Math.max(...dispatched));
    results.push({ workflow: label, ageMinutes: Math.floor(age / 60_000) });
    if (age > parseMaxAge(maxAge)) {
      violations.push(`SCHEDULER_HEARTBEAT_STALE: ${label} last dispatch by ${policy.dispatcher.login} was ${Math.floor(age / 60_000)} minutes ago (limit ${maxAge})`);
    }
  }
  return { violations, results };
}

function parseArgs(argv) {
  const names = new Map([["--repository", "repository"], ["--policy", "policy"]]);
  const values = {};
  if (!Array.isArray(argv) || argv.length !== names.size * 2) fail("SCHEDULER_HEARTBEAT_ARGUMENTS");
  for (let index = 0; index < argv.length; index += 2) {
    const key = names.get(argv[index]);
    if (!key || Object.hasOwn(values, key) || typeof argv[index + 1] !== "string") fail("SCHEDULER_HEARTBEAT_ARGUMENTS");
    values[key] = argv[index + 1];
  }
  if (!REPOSITORY.test(values.repository)) fail("SCHEDULER_HEARTBEAT_ARGUMENTS", "repository");
  return values;
}

export async function main(argv = process.argv.slice(2), { runGh = defaultRunGh, now = () => new Date(), readPolicy = (file) => readFile(file, "utf8"), log = console.log } = {}) {
  const { repository, policy: policyPath } = parseArgs(argv);
  let policy;
  try {
    policy = JSON.parse(await readPolicy(policyPath));
  } catch (error) {
    if (error instanceof SyntaxError) fail("SCHEDULER_HEARTBEAT_POLICY", "policy is not valid JSON");
    throw error;
  }
  validateHeartbeatPolicy(policy);
  const runsByWorkflow = {};
  for (const workflow of new Set(policy.workflows.map((item) => item.workflow))) {
    let listing;
    try {
      listing = JSON.parse(await runGh(["api", `repos/${repository}/actions/workflows/${workflow}/runs?event=workflow_dispatch&branch=main&per_page=100`]));
    } catch (error) {
      if (error instanceof SyntaxError) fail("SCHEDULER_HEARTBEAT_API", `${workflow} run list is not JSON`);
      throw error;
    }
    if (!isObject(listing) || !Array.isArray(listing.workflow_runs)) fail("SCHEDULER_HEARTBEAT_API", `${workflow} run list has no workflow_runs`);
    runsByWorkflow[workflow] = listing.workflow_runs;
  }
  const { violations, results } = checkSchedulerHeartbeat({ policy, runsByWorkflow, now: now() });
  for (const { workflow, ageMinutes } of results) log(`OK ${workflow} last dispatch ${ageMinutes} minutes ago`);
  if (violations.length > 0) fail(violations[0].split(":")[0], violations.join("\n"));
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
