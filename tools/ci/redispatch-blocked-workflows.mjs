#!/usr/bin/env node
// 차단 PR 때문에 잃은 정기 슬롯을 차단이 풀린 뒤 다시 dispatch한다(#1097, #870 전체 자동화).
//
// 정기 workflow 넷(ITX 승격·등록·재확인·재결속)은 다른 원장 쓰기 자동화 PR이 열려 있으면 BLOCKED_BY_PENDING_PR로 끝난다. 이 종료는 실패가 아니라
// 대기이므로 run은 success이고, 다음 정기 주기까지 아무도 다시 깨우지 않는다(ITX는 24시간 뒤다). 공급자 호출이 KST 하루 한 번인 ITX에서는
// 이 한 번의 차단이 운영 데이터팩 만료 위기가 됐다(2026-10-09, 재결속 PR #1088).
//
// 이 도구는 대상 workflow마다 main의 가장 최근 정기·dispatch run을 보고 아래를 모두 만족할 때만 `github.token`으로 dispatch한다.
//   1. 그 run이 끝났고 success이며, job의 note step이 실행됐다(= 그 run이 쓰지 않고 끝났다): BLOCKED_BY_PENDING_PR의 "waiting" note,
//      그리고 재확인·재결속이 push 직전 재확인에서 새 원장 쓰기 자동화를 만나거나 main이 움직여 올리지 않고 끝난 "superseded" note(같은 슬롯 손실이다).
//   2. 지금 차단 대상이 없다. 판정 도구와 같은 함수(pendingLedgerWriters·pendingLedgerWriterPullRequests)로 다시 계산하므로
//      "차단 PR이 병합되거나 닫힘"은 "차단 대상이 비었음"과 같다. 또 막히면 재dispatch된 run이 다시 막힌 run이 되어 같은 절차를 탄다.
// 직렬화는 바꾸지 않는다: 재dispatch된 workflow는 자기 decision 단계에서 다시 판정한다.
//
// 한 번의 sweep은 쓰기 workflow를 최대 하나만 dispatch한다(우선순위는 REDISPATCH_TARGETS 순서). 병합 하나가 여러 대상을 한꺼번에 풀면
// 모두를 한 번에 깨우는 대신, 기존 cron 오프셋이 쓰기 workflow 사이에 두던 간격을 이 규칙이 대신한다: 대상 중 하나라도 진행 중인 run이 있으면
// 아무것도 dispatch하지 않고(DEFER), 다음 대상은 그 run이 끝난 뒤의 sweep(Automerge Queue 완료 또는 15분 schedule)이 처리한다.
// 먼저 dispatch된 run이 PR을 열면 나머지는 그 PR 때문에 다시 WAIT가 되어 PR이 병합될 때까지 기다린다.
//
// 상한: 진행 중인 run이 있으면 기다리고, 같은 workflow를 24시간 안에 REDISPATCH_DAILY_LIMIT번 "막힌 run 뒤에" github-actions[bot]이 dispatch했으면
// 더 깨우지 않고 나머지 대상을 마친 뒤 REDISPATCH_LIMIT로 실패한다(실패 이슈 #926 -> admin 자동화 상태의 failureIssues).
// 상한에는 막힌 run 바로 뒤에 시작된 github-actions[bot] dispatch만 센다: 막힘 -> 재dispatch -> 막힘 루프가 아닌 정상 dispatch
// (뒤처진 PR 재생성 경로의 dispatch나 일을 한 run)가 하루에 몰려도 거짓 경보를 내지 않는다. 구분 수단으로 dispatch 입력·run-name 표식을
// 쓰지 않은 이유: 대상 workflow 네 개와 platform 스케줄러 계약(입력 없음)을 바꾸지 않고도 같은 구분이 run 이력 자체에서 나온다.
// 후보 갱신(nationwide-candidate-refresh.yml)은 대상이 아니다: github.token dispatch는 정기 역할을 받지 못하고(scheduled-release-authority) 스케줄러가 2시간마다 깨운다.
//
// 사용: node tools/ci/redispatch-blocked-workflows.mjs --repository <owner/repo> --refs <git ls-remote --heads "refs/heads/automation/*" 출력> --prs <collect-automation-prs.mjs 출력>
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { parseAutomationBranches, pendingLedgerWriterPullRequests, pendingLedgerWriters, validRepository } from "./automation-pr-state.mjs";
import { defaultRunGh } from "./report-refresh-failure.mjs";

/** 이 경로로 다시 깨운 run의 시작자. 스케줄러 App(heartbeat가 세는 dispatch)·사람과 구분된다. */
export const REDISPATCH_ACTOR = "github-actions[bot]";
export const REDISPATCH_DAILY_LIMIT = 3;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAIN = "main";
const RUN_LIST_LIMIT = 100;
const OBSERVE_POLLS = 5;
const OBSERVE_INTERVAL_MS = 3_000;
const SCHEDULED_EVENTS = new Set(["schedule", "workflow_dispatch"]);

/**
 * 재dispatch 대상. 순서가 우선순위다(만료 위험이 큰 순서):
 *   1. ITX 승격: 공급자 호출이 KST 하루 한 번이고 주기가 24시간이라 한 슬롯을 잃으면 다음 기회가 하루 뒤다. 운영 데이터팩 만료와 직결된다(2026-10-09).
 *   2. 원천 재확인: P7D 원천 만료를 막는 유일한 경로다. 주기는 2시간이지만 recipe 수집이 길다.
 *   3. 수도권 topology 등록: 2시간 주기. 등록이 끝나야 재결속·후보가 새 입력을 쓴다.
 *   4. 파생 재결속: 6시간 주기이지만 입력이 바뀌면 나머지 대상이 끝난 뒤에 다시 만들어도 늦지 않는 하류 단계다.
 * noteSteps는 각 workflow에서 "쓰지 않고 success로 끝난" 경우에만 도는 step 이름이다. waiting(BLOCKED_BY_PENDING_PR) 하나가 정본이고
 * 나머지는 push 직전 재확인에서 새 원장 쓰기 자동화를 만났거나 main이 움직여 올리지 않은 superseded note다. blockers는 decide 도구가 차단을 정하는 방식이다.
 * 계약 테스트가 표를 workflow 파일·decide 도구와 대조한다.
 */
export const REDISPATCH_TARGETS = Object.freeze([
  { workflow: "itx-current-promotion.yml", noteSteps: ["Note ITX promotion waiting on another pending automation pull request"], blockers: "pull-requests" },
  {
    workflow: "source-reverification.yml",
    noteSteps: [
      "Note reverification waiting on a pending source pull request",
      "Note reverification superseded by pending source automation",
      "Note reverification superseded by a newer main",
    ],
    blockers: "pull-requests-and-claims",
  },
  { workflow: "current-capital-topology-registration.yml", noteSteps: ["Note registration waiting on another pending automation pull request"], blockers: "pull-requests" },
  {
    workflow: "source-derivative-rebinding.yml",
    noteSteps: [
      "Note derivative rebinding waiting on a pending source pull request",
      "Note rebinding superseded by pending source automation",
      "Note rebinding superseded by a newer main",
    ],
    blockers: "pull-requests-and-claims",
  },
]);

function fail(code, detail = "") {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

const instant = (value, code) => {
  const millis = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(millis) ? millis : fail(code, `created_at ${JSON.stringify(value)}`);
};

function pendingFor({ workflow, blockers }, { pullRequests, automationBranches, repository }) {
  if (blockers === "pull-requests") return pendingLedgerWriterPullRequests(pullRequests, repository, workflow);
  const pending = pendingLedgerWriters({ pullRequests, automationBranches, repository, exceptWorkflow: workflow });
  return [...pending.pullRequests, ...pending.branches];
}

async function listRuns(api, repository, workflow) {
  const listing = await api(`repos/${repository}/actions/workflows/${workflow}/runs?branch=${MAIN}&per_page=${RUN_LIST_LIMIT}`);
  if (!Array.isArray(listing?.workflow_runs)) fail("REDISPATCH_RUNS_INVALID", workflow);
  return listing.workflow_runs
    .filter((item) => item?.head_branch === MAIN && SCHEDULED_EVENTS.has(item.event))
    .map((item) => {
      if (!Number.isSafeInteger(item.id) || typeof item.status !== "string") fail("REDISPATCH_RUNS_INVALID", `${workflow} run ${String(item.id)}`);
      return { id: item.id, event: item.event, status: item.status, conclusion: item.conclusion ?? null, actor: item.actor?.login ?? null, createdAt: instant(item.created_at, "REDISPATCH_RUNS_INVALID") };
    })
    .sort((left, right) => right.createdAt - left.createdAt || right.id - left.id);
}

/** run이 쓰지 않고 끝났는가(BLOCKED_BY_PENDING_PR 또는 superseded): 그 workflow의 note step이 실행(success)됐다. */
async function endedBlocked(api, repository, runId, noteSteps) {
  const listing = await api(`repos/${repository}/actions/runs/${runId}/jobs?per_page=100`);
  if (!Array.isArray(listing?.jobs)) fail("REDISPATCH_JOBS_INVALID", `run ${runId}`);
  return listing.jobs.some((job) => Array.isArray(job?.steps) && job.steps.some((step) => noteSteps.includes(step?.name) && step.conclusion === "success"));
}

async function dispatchAndObserve({ workflow, before, repository, api, dispatchWorkflow, sleep, log }) {
  await dispatchWorkflow(workflow);
  log(`redispatched ${workflow} from ${MAIN}`);
  const known = new Set(before.map(({ id }) => id));
  for (let poll = 0; poll < OBSERVE_POLLS; poll += 1) {
    if ((await listRuns(api, repository, workflow)).some(({ id }) => !known.has(id))) return;
    await sleep(OBSERVE_INTERVAL_MS); // NOSONAR -- 새 run이 목록에 나타나길 순서대로 기다린다
  }
  // dispatch 요청은 수락됐다. 목록 반영이 늦을 뿐이면 다음 점검이 진행 중인 run을 보고 기다린다. 요청 실패는 위에서 이미 던졌다.
  log(`::warning title=Blocked redispatch::${workflow} was dispatched but the new run is not visible in the run list yet.`);
}

/**
 * 대상마다 판정하고, 깨울 대상이 있으면 우선순위가 가장 높은 하나만 dispatch한다. 판정 결과를 대상 순서대로 돌려준다.
 * 상한에 닿은 대상이 있으면 나머지를 마친 뒤 REDISPATCH_LIMIT로 실패한다. API·dispatch 오류는 모른 채 덮지 않고 바로 실패한다.
 */
export async function runRedispatch({
  repository, pullRequests, automationBranches, api, dispatchWorkflow, now = new Date(), sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }), log = console.log,
} = {}) {
  if (!validRepository(repository) || !Array.isArray(pullRequests) || !Array.isArray(automationBranches) || typeof api !== "function"
    || typeof dispatchWorkflow !== "function" || !(now instanceof Date) || Number.isNaN(now.getTime())) fail("REDISPATCH_INPUT_INVALID");
  const blockedCache = new Map();
  const blockedRun = (target, runId) => {
    const key = `${target.workflow}:${runId}`;
    if (!blockedCache.has(key)) blockedCache.set(key, endedBlocked(api, repository, runId, target.noteSteps));
    return blockedCache.get(key);
  };
  const results = [];
  const limited = [];
  const candidates = [];
  let anyActive = null;
  for (const target of REDISPATCH_TARGETS) {
    const { workflow } = target;
    const runs = await listRuns(api, repository, workflow); // NOSONAR -- 대상은 순서대로 판정한다
    if (anyActive === null && runs.some(({ status }) => status !== "completed")) anyActive = workflow;
    const [latest] = runs;
    if (latest === undefined) {
      results.push({ workflow, action: "SKIP", reason: "NO_RUN" });
      continue;
    }
    if (latest.status !== "completed") {
      results.push({ workflow, action: "SKIP", reason: "RUN_IN_PROGRESS" });
      continue;
    }
    if (latest.conclusion !== "success" || !(await blockedRun(target, latest.id))) { // NOSONAR -- 위와 같다
      results.push({ workflow, action: "SKIP", reason: "LATEST_NOT_BLOCKED" });
      continue;
    }
    const blockedBy = pendingFor(target, { pullRequests, automationBranches, repository });
    if (blockedBy.length > 0) {
      log(`${workflow}: run ${latest.id} ended without writing and is still waiting for ${blockedBy.join(", ")}`);
      results.push({ workflow, action: "WAIT", blockedBy });
      continue;
    }
    // 상한: 막힌 run 바로 뒤에 github-actions[bot]이 dispatch한 run만 센다(막힘 -> 재dispatch -> 막힘 루프).
    let recent = 0;
    for (const [index, run] of runs.entries()) {
      if (run.event !== "workflow_dispatch" || run.actor !== REDISPATCH_ACTOR || now.getTime() - run.createdAt >= WINDOW_MS) continue;
      const before = runs[index + 1];
      if (before !== undefined && before.status === "completed" && before.conclusion === "success" && await blockedRun(target, before.id)) recent += 1; // NOSONAR -- 위와 같다
    }
    if (recent >= REDISPATCH_DAILY_LIMIT) {
      limited.push(`${workflow} was already redispatched ${recent} time(s) after a blocked run in the last 24h (limit ${REDISPATCH_DAILY_LIMIT}) and run ${latest.id} ended blocked again`);
      results.push({ workflow, action: "LIMIT", count: recent });
      continue;
    }
    results.push({ workflow, action: "DISPATCH", blockedRunId: latest.id, runs });
    candidates.push(workflow);
  }
  // 한 sweep에 쓰기 workflow는 최대 하나만 깨운다. 진행 중인 대상 run이 있으면 아무것도 깨우지 않는다.
  const [chosen] = anyActive === null ? candidates : [];
  for (const [index, result] of results.entries()) {
    if (result.action !== "DISPATCH") continue;
    const { runs, ...rest } = result;
    if (result.workflow === chosen) {
      await dispatchAndObserve({ workflow: chosen, before: runs, repository, api, dispatchWorkflow, sleep, log }); // NOSONAR -- 위와 같다
      results[index] = rest;
    } else {
      results[index] = anyActive === null
        ? { workflow: result.workflow, action: "DEFER", reason: "ANOTHER_DISPATCHED", by: chosen }
        : { workflow: result.workflow, action: "DEFER", reason: "RUN_ACTIVE", by: anyActive };
    }
  }
  if (limited.length > 0) fail("REDISPATCH_LIMIT", `${limited.join("; ")}. 차단이 반복되는 원인을 사람이 확인해야 한다.`);
  return results;
}

function parseArgs(argv) {
  const keys = new Map([["--repository", "repository"], ["--refs", "refs"], ["--prs", "prs"]]);
  const values = {};
  if (!Array.isArray(argv) || argv.length !== keys.size * 2) fail("REDISPATCH_ARGUMENTS", "usage: --repository <owner/repo> --refs <file> --prs <file>");
  for (let index = 0; index < argv.length; index += 2) {
    const key = keys.get(argv[index]);
    if (!key || Object.hasOwn(values, key) || typeof argv[index + 1] !== "string") fail("REDISPATCH_ARGUMENTS", `argument ${String(argv[index])}`);
    values[key] = argv[index + 1];
  }
  if (!validRepository(values.repository)) fail("REDISPATCH_ARGUMENTS", "repository");
  return values;
}

export async function main(argv, { runGh = defaultRunGh, now = () => new Date(), log = console.log } = {}) {
  const { repository, refs, prs } = parseArgs(argv);
  const results = await runRedispatch({
    repository,
    pullRequests: JSON.parse(await readFile(prs, "utf8")),
    automationBranches: parseAutomationBranches(await readFile(refs, "utf8")),
    api: async (endpoint) => JSON.parse(await runGh(["api", "-H", "Accept: application/vnd.github+json", endpoint])),
    dispatchWorkflow: (workflow) => runGh(["workflow", "run", workflow, "--repo", repository, "--ref", MAIN]),
    now: now(),
    log,
  });
  for (const result of results) log(JSON.stringify(result));
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
