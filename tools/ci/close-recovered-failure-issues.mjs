#!/usr/bin/env node
// 회복이 확인된 원천 자동 갱신 실패 이슈를 닫는다(#1287, #870 전체 자동화: 이상만 admin에 남기고 사람은 이상 때만 개입한다).
// - 닫는 근거는 "같은 workflow의 성공 run" 하나다. 그 run은 이슈에 기록된 마지막 실패 run보다 나중에 생겼고, 아래 RECOVERY_PROOF가
//   정한 대상 단계가 실제로 success여야 한다. 건너뛴 단계(대기, 할 일 없음)와 추정은 회복이 아니다.
// - 대상은 report-refresh-failure.mjs가 만든 봇 이슈뿐이다(마커·제목·작성자가 모두 맞아야 한다). 사람이 연 이슈는 건드리지 않는다.
// - 사람이 기대값을 고쳐야 풀리는 recipe 표지(reverification-blocked)가 남은 이슈는 닫지 않는다. 그 recipe는 이슈가 열려 있는 동안
//   다시 돌지 않으므로 성공할 수 없고, 사람이 기대값을 고친 뒤 이슈를 닫아야 재수집이 시작된다(#1122).
// - 닫기 호출이 실패하면 경고로 드러내고 종료 코드는 바꾸지 않는다. 조회 실패나 형식 오류는 추정하지 않고 job을 실패시킨다.
import { isMainModule } from "../lib/is-main-module.mjs";
import {
  REPORTABLE_WORKFLOW_FILES,
  REPOSITORY,
  blockedRecipeIdsOf,
  defaultRunGh,
  failureIssuesOf,
  listOpenIssues,
  recordedRunIdsOf,
} from "./report-refresh-failure.mjs";

/**
 * workflow마다 "실패한 일을 실제로 해냈다"는 증거 단계. 바깥 배열은 대안이고, 안쪽 배열은 한 job 안에서 모두 success여야 한다.
 * 정기 갱신은 상태 판정 step이 항상 돌지만 판정만으로는 수집·게시가 되살아났는지 알 수 없다. 그래서 PR까지 여는 전달 단계를 본다.
 * 열린 PR 대기(OPEN_PR)와 최신 상태(CURRENT)는 전달 단계를 건너뛰므로 증거가 아니다.
 * 점검 자체가 일인 workflow(감시, 재dispatch sweep)는 점검 단계가 success인 것이 증거다.
 */
export const RECOVERY_PROOF = Object.freeze({
  "automation-blocked-redispatch.yml": [["Collect the automation pull requests", "Redispatch the workflows that ended blocked"]],
  "automation-pr-behind-recreate.yml": [["Close behind automation pull requests and request a fresh run"]],
  "current-capital-topology-refresh.yml": [["Create draft pull request"], ["Recover a completed claimed refresh"]],
  "current-capital-topology-registration.yml": [["Commit exactly two registration outputs and open draft PR"]],
  "data-workflow-scheduler-watchdog.yml": [["Check external scheduler heartbeat"]],
  "datapack-release-cross-repo-chain.yml": [["Publish the data pack to production", "Deploy the release (PREVIEW then DEPLOY)", "Verify the public release"]],
  "itx-current-promotion.yml": [["Commit exactly the promotion and rebinding outputs and open draft PR"]],
  "kric-current-facility-refresh.yml": [
    ["KRIC current facility refresh / Create draft pull request"],
    ["KRIC current facility refresh / Recover claimed refresh"],
  ],
  "nationwide-candidate-refresh.yml": [["Create candidate refresh pull request"]],
  "retained-gwangju-timetable-refresh.yml": [["Create retained timetable draft pull request"], ["Recover completed retained timetable claim"]],
  "seoul-current-accessibility-refresh.yml": [["Create draft pull request"], ["Recover completed claimed refresh"]],
  "source-derivative-rebinding.yml": [["Create derivative rebinding pull request"]],
  "source-reverification.yml": [["Create source reverification pull request"]],
});

const PER_PR_REASON = "PR 하나마다 실행되는 판정이라 다른 PR의 성공 run이 실패한 PR의 회복을 증명하지 못한다. 해당 PR을 정리한 사람이 닫는다.";
/** 자동으로 닫지 않는 workflow와 그 사유. 보고 대상 workflow는 RECOVERY_PROOF나 여기 중 하나에 반드시 있어야 한다. */
export const MANUAL_CLOSE_WORKFLOWS = Object.freeze({
  "automation-pr-automerge.yml": PER_PR_REASON,
  "automation-pr-ci-rerun.yml": PER_PR_REASON,
});

export const RECOVERY_COMMENT_MARKER = "<!-- easysubway-refresh-failure-recovered -->";
// 마지막 실패 run 이후의 성공 run을 이 페이지 수까지 읽는다(한 페이지 100개). 2시간 주기 workflow로 약 41일치다. 넘으면 SCAN_TRUNCATED로 드러낸다.
export const MAX_RUN_PAGES = 5;
const RUNS_PER_PAGE = 100;
// 한 번 실행(sweep)이 쓸 수 있는 job 조회(actions/runs/{id}/jobs) 총량. GITHUB_TOKEN 한도(시간당 1000)는 레포의 다른 자동화와 나눠 쓰므로
// 부가 기능인 자동 종료가 핵심 자동화를 굶기지 않게 막는다. 다 쓰면 남은 판정을 멈추고 경고로 드러내며 다음 실행이 이어서 처리한다.
export const MAX_JOB_LOOKUPS_PER_SWEEP = 100;
const ANNOTATION_TITLE = "Recovered failure issue";

function fail(code, detail = "") {
  throw new Error(detail ? `CLOSE_RECOVERED_${code}: ${detail}` : `CLOSE_RECOVERED_${code}`);
}

async function apiGet(runGh, path, query = []) {
  try {
    return JSON.parse(await runGh(["api", "--method", "GET", path, ...query.flatMap((entry) => ["-f", entry])]));
  } catch (error) {
    if (error instanceof SyntaxError) fail("API_RESPONSE", path);
    throw error;
  }
}

/** 한 job 안에서 대안 하나의 모든 단계가 success이면 그 단계 목록, 아니면 null. */
function provenSteps(workflowFile, jobs) {
  const succeeded = jobs.map((job) => new Set((job.steps ?? []).filter(({ conclusion }) => conclusion === "success").map(({ name }) => name)));
  return RECOVERY_PROOF[workflowFile].find((steps) => succeeded.some((names) => steps.every((name) => names.has(name)))) ?? null;
}

function recoveryComment({ workflowFile, proof, successUrl, failureUrl }) {
  return [
    RECOVERY_COMMENT_MARKER,
    `\`${workflowFile}\`가 마지막으로 보고된 실패 run 이후 성공했다. 실패 원인이 해소된 것으로 확인되어 이 이슈를 자동으로 닫는다.`,
    "",
    `- 성공 run: ${successUrl}`,
    `- 확인한 단계(success): ${proof.map((name) => `\`${name}\``).join(", ")}`,
    `- 마지막으로 보고된 실패 run: ${failureUrl}`,
    "- 같은 실패가 다시 생기면 새 실패 이슈가 열린다.",
  ].join("\n");
}

// 마지막 실패 run 이후 생긴 main의 성공 run을 전부 읽는다(생성 시각 범위 + 페이징). 상한에 닿으면 truncated로 알린다.
async function listSuccessRunsSince({ repository, runGh, workflowFile, since }) {
  const runs = [];
  for (let page = 1; page <= MAX_RUN_PAGES; page += 1) {
    const { workflow_runs: pageRuns, total_count: total } = await apiGet(
      runGh, `repos/${repository}/actions/workflows/${workflowFile}/runs`,
      ["status=success", "branch=main", `created=>=${since}`, `per_page=${RUNS_PER_PAGE}`, `page=${page}`],
    );
    runs.push(...pageRuns);
    if (pageRuns.length < RUNS_PER_PAGE || runs.length >= total) return { runs, truncated: false };
  }
  return { runs, truncated: true };
}

/**
 * 마지막 실패 run 이후 성공 run 중 대상 단계가 증명된 run. 가장 이른 증명 run을 인용한다:
 * 회복이 실제로 일어난 시점이라 이후 run이 쌓여도 같은 run이 인용되고, 보통 실패 직후라 job 조회도 적다.
 */
async function findProof({ repository, runGh, workflowFile, lastFailureRunId, since, budget }) {
  const { runs, truncated } = await listSuccessRunsSince({ repository, runGh, workflowFile, since });
  const candidates = runs.filter(({ id, conclusion }) => conclusion === "success" && id > lastFailureRunId).sort((left, right) => left.id - right.id);
  for (const candidate of candidates) {
    if (budget.remaining === 0) return { found: null, truncated, exhausted: true };
    budget.remaining -= 1;
    const { jobs } = await apiGet(runGh, `repos/${repository}/actions/runs/${candidate.id}/jobs`, [`per_page=${RUNS_PER_PAGE}`]);
    const proof = provenSteps(workflowFile, jobs);
    if (proof) return { found: { proof, successUrl: candidate.html_url }, truncated, exhausted: false };
  }
  return { found: null, truncated, exhausted: false };
}

async function closeWithEvidence({ repository, runGh, issue, workflowFile, found, lastFailureRunId }) {
  const comment = recoveryComment({
    workflowFile, proof: found.proof, successUrl: found.successUrl, failureUrl: `https://github.com/${repository}/actions/runs/${lastFailureRunId}`,
  });
  const base = { issueNumber: issue.number, workflowFile, runUrl: found.successUrl };
  try {
    await runGh(["issue", "close", String(issue.number), "--repo", repository, "--reason", "completed", "--comment", comment]);
  } catch (error) {
    return { ...base, action: "close-failed", reason: "CLOSE_FAILED", error: error.message };
  }
  return { ...base, action: "closed", reason: "RECOVERED" };
}

// 실패 run의 생성 시각. 읽지 못하면 이슈만 이상으로 남기고 다른 이슈 처리는 계속한다.
async function failureRunCreatedAt({ repository, runGh, runId }) {
  const { created_at: createdAt } = await apiGet(runGh, `repos/${repository}/actions/runs/${runId}`);
  if (typeof createdAt !== "string") fail("API_RESPONSE", `run ${runId} has no created_at`);
  return createdAt;
}

async function settle({ repository, runGh, issue, workflowFile, budget }) {
  const kept = (reason, extra = {}) => ({ issueNumber: issue.number, workflowFile, action: "kept", reason, ...extra });
  if (Object.hasOwn(MANUAL_CLOSE_WORKFLOWS, workflowFile)) return kept("MANUAL_CLOSE");
  const recipes = blockedRecipeIdsOf(issue.body ?? "");
  if (recipes.length > 0) return kept("BLOCKED_RECIPE", { recipes });
  const failureRunIds = recordedRunIdsOf(issue);
  if (failureRunIds.length === 0) return kept("NO_RECORDED_FAILURE_RUN");
  if (budget.remaining === 0) return kept("JOB_LOOKUP_BUDGET_EXHAUSTED");
  const lastFailureRunId = Math.max(...failureRunIds);
  let since;
  try {
    since = await failureRunCreatedAt({ repository, runGh, runId: lastFailureRunId });
  } catch (error) {
    return kept("FAILURE_RUN_UNREADABLE", { error: error.message });
  }
  const { found, truncated, exhausted } = await findProof({ repository, runGh, workflowFile, lastFailureRunId, since, budget });
  if (found) return closeWithEvidence({ repository, runGh, issue, workflowFile, found, lastFailureRunId });
  if (exhausted) return kept("JOB_LOOKUP_BUDGET_EXHAUSTED");
  return kept(truncated ? "SCAN_TRUNCATED" : "NO_RECOVERY_PROOF");
}

/**
 * 열린 봇 실패 이슈마다 회복을 판정하고, 증거가 있으면 닫는다. 이슈별 결과를 돌려준다.
 * 열린 이슈나 Actions 조회가 실패하면 던진다(회복을 추정하지 않는다). 닫기 호출 실패만 결과에 close-failed로 남긴다.
 */
export async function closeRecoveredFailureIssues({ repository, runGh = defaultRunGh, jobLookupBudget = MAX_JOB_LOOKUPS_PER_SWEEP }) {
  const openIssues = await listOpenIssues(repository, runGh);
  const budget = { remaining: jobLookupBudget };
  const results = [];
  for (const workflowFile of REPORTABLE_WORKFLOW_FILES) {
    for (const issue of failureIssuesOf({ openIssues, workflowFile })) {
      results.push(await settle({ repository, runGh, issue, workflowFile, budget }));
    }
  }
  return results;
}

// workflow 명령은 한 줄이다. 줄바꿈과 `%`는 명령 이스케이프 규칙대로 바꾼다.
const annotation = (level, message) => `::${level} title=${ANNOTATION_TITLE}::${message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`;

// 닫지 못한 이유 중 사람이 봐야 하는 이상. 나머지(대기, 표지, 증거 없음)는 정상 상태라 로그로만 남긴다.
const ANOMALY_MESSAGES = Object.freeze({
  NO_RECORDED_FAILURE_RUN: "이슈에 기록된 실패 run이 없어 회복을 판정하지 못했다.",
  FAILURE_RUN_UNREADABLE: "기록된 마지막 실패 run을 읽지 못해 회복을 판정하지 못했다",
  JOB_LOOKUP_BUDGET_EXHAUSTED: `job 조회 예산(${MAX_JOB_LOOKUPS_PER_SWEEP}회)을 이번 실행에서 다 써 판정하지 못했다. 다음 실행이 이어서 처리한다.`,
  SCAN_TRUNCATED: `실패 이후 성공 run이 ${MAX_RUN_PAGES * RUNS_PER_PAGE}개를 넘어 일부만 확인했고 증거를 찾지 못했다. 회복을 판정하지 못했다.`,
});

function describe(result) {
  const subject = `#${result.issueNumber} (${result.workflowFile})`;
  if (result.action === "closed") return annotation("notice", `${subject}: 성공 run ${result.runUrl}으로 회복을 확인해 닫았다.`);
  if (result.action === "close-failed") return annotation("warning", `${subject}: 회복을 확인했지만 닫지 못했다(성공 run ${result.runUrl}): ${result.error}`);
  const anomaly = ANOMALY_MESSAGES[result.reason];
  if (anomaly) return annotation("warning", `${subject}: ${anomaly}${result.error ? `: ${result.error}` : ""} (${result.reason})`);
  return `${subject}: 닫지 않았다 (${result.reason})`;
}

/** 종료 코드를 돌려준다. 닫기 실패는 경고로만 드러내고 0이다. */
export async function main(argv, { runGh = defaultRunGh, log = console.log, jobLookupBudget } = {}) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--repository" || !REPOSITORY.test(argv[1])) fail("ARGUMENTS", "usage: close-recovered-failure-issues.mjs --repository <owner/name>");
  const results = await closeRecoveredFailureIssues({ repository: argv[1], runGh, jobLookupBudget });
  for (const result of results) log(describe(result));
  // 이슈가 0건이어도 실행 흔적을 남긴다. 진입점이 동작하지 않아도 로그가 비어 성공으로 보였던 결함(#1287)을 로그로 구분한다.
  log(`검사한 실패 이슈 ${results.length}건, 닫은 이슈 ${results.filter((result) => result.action === "closed").length}건 (${argv[1]})`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
