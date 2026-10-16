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
export const MAX_SCANNED_RUNS = 30;
const RUNS_PER_PAGE = 100;
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

function makeProofFinder({ repository, runGh }) {
  const successRunsByWorkflow = new Map();
  const successRuns = (workflowFile) => {
    if (!successRunsByWorkflow.has(workflowFile)) {
      successRunsByWorkflow.set(workflowFile, apiGet(runGh, `repos/${repository}/actions/workflows/${workflowFile}/runs`, ["status=success", "branch=main", `per_page=${RUNS_PER_PAGE}`]));
    }
    return successRunsByWorkflow.get(workflowFile);
  };
  /** 마지막 실패 run보다 나중의 성공 run 중 가장 최근의 증거. 최근 MAX_SCANNED_RUNS개만 본다. */
  return async function findProof(workflowFile, lastFailureRunId) {
    const { workflow_runs: runs } = await successRuns(workflowFile);
    const candidates = runs.filter(({ id, conclusion }) => conclusion === "success" && id > lastFailureRunId).sort((left, right) => right.id - left.id).slice(0, MAX_SCANNED_RUNS);
    for (const candidate of candidates) {
      const { jobs } = await apiGet(runGh, `repos/${repository}/actions/runs/${candidate.id}/jobs`, [`per_page=${RUNS_PER_PAGE}`]);
      const proof = provenSteps(workflowFile, jobs);
      if (proof) return { proof, successUrl: candidate.html_url };
    }
    return null;
  };
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

async function settle({ repository, runGh, findProof, issue, workflowFile }) {
  const kept = (reason, extra = {}) => ({ issueNumber: issue.number, workflowFile, action: "kept", reason, ...extra });
  if (Object.hasOwn(MANUAL_CLOSE_WORKFLOWS, workflowFile)) return kept("MANUAL_CLOSE");
  const recipes = blockedRecipeIdsOf(issue.body ?? "");
  if (recipes.length > 0) return kept("BLOCKED_RECIPE", { recipes });
  const failureRunIds = recordedRunIdsOf(issue);
  if (failureRunIds.length === 0) return kept("NO_RECORDED_FAILURE_RUN");
  const lastFailureRunId = Math.max(...failureRunIds);
  const found = await findProof(workflowFile, lastFailureRunId);
  if (!found) return kept("NO_RECOVERY_PROOF");
  return closeWithEvidence({ repository, runGh, issue, workflowFile, found, lastFailureRunId });
}

/**
 * 열린 봇 실패 이슈마다 회복을 판정하고, 증거가 있으면 닫는다. 이슈별 결과를 돌려준다.
 * 열린 이슈나 Actions 조회가 실패하면 던진다(회복을 추정하지 않는다). 닫기 호출 실패만 결과에 close-failed로 남긴다.
 */
export async function closeRecoveredFailureIssues({ repository, runGh = defaultRunGh }) {
  const openIssues = await listOpenIssues(repository, runGh);
  const findProof = makeProofFinder({ repository, runGh });
  const results = [];
  for (const workflowFile of REPORTABLE_WORKFLOW_FILES) {
    for (const issue of failureIssuesOf({ openIssues, workflowFile })) {
      results.push(await settle({ repository, runGh, findProof, issue, workflowFile }));
    }
  }
  return results;
}

// workflow 명령은 한 줄이다. 줄바꿈과 `%`는 명령 이스케이프 규칙대로 바꾼다.
const annotation = (level, message) => `::${level} title=${ANNOTATION_TITLE}::${message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`;

function describe(result) {
  const subject = `#${result.issueNumber} (${result.workflowFile})`;
  if (result.action === "closed") return annotation("notice", `${subject}: 성공 run ${result.runUrl}으로 회복을 확인해 닫았다.`);
  if (result.action === "close-failed") return annotation("warning", `${subject}: 회복을 확인했지만 닫지 못했다(성공 run ${result.runUrl}): ${result.error}`);
  if (result.reason === "NO_RECORDED_FAILURE_RUN") return annotation("warning", `${subject}: 이슈에 기록된 실패 run이 없어 회복을 판정하지 못했다.`);
  return `${subject}: 닫지 않았다 (${result.reason})`;
}

/** 종료 코드를 돌려준다. 닫기 실패는 경고로만 드러내고 0이다. */
export async function main(argv, { runGh = defaultRunGh, log = console.log } = {}) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--repository" || !REPOSITORY.test(argv[1])) fail("ARGUMENTS", "usage: close-recovered-failure-issues.mjs --repository <owner/name>");
  for (const result of await closeRecoveredFailureIssues({ repository: argv[1], runGh })) log(describe(result));
  return 0;
}

if (isMainModule()) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
