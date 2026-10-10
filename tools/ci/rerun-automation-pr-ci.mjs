#!/usr/bin/env node
// 자동화 PR의 required CI가 일시 오류로 실패하면 실패한 job을 정확히 한 번 다시 실행한다(#1115, #870 전체 자동화, QA 결정 2026-10-09: 사람은 이상이 날 때만 개입).
//
// 실제 사례(2026-10-10): automation-pr-policy.test.mjs의 `Unable to deserialize cloned data`(test runner 일시 오류), Docker Hub 429(rhysd/actionlint 이미지 pull, exit 125).
// 사람이 `gh run rerun --failed`를 해야 풀렸다. 이 도구는 workflow_run(CI 완료)에서만 돌고 아래를 모두 만족할 때만 재실행한다.
//   1. 이 저장소의 automation/ 브랜치 pull_request CI run이 끝났고 결론이 failure이며 run_attempt가 1이다(두 번째 시도는 건드리지 않는다).
//   2. head sha에 연결된 열린 PR이 정확히 하나이고, 그 PR의 head가 run의 head와 같고(STALE 아님), 작성자가 App easysubway-release-chain[bot]
//      또는 github-actions[bot]이며(사람 PR 제외) 브랜치가 자동화 단계의 claim 브랜치다.
//   3. 같은 run에 대한 기록 코멘트가 github-actions[bot]에게 아직 없다(이벤트 재전달에도 한 번만).
//   4. 실패한 job이 하나 이상이다. 없으면 조용히 넘기지 않고 CI_RERUN_NO_FAILED_JOB으로 실패한다.
// 재실행은 `rerun-failed-jobs`(실패한 job과 그 의존 job만) 한 번이고, 그 뒤에 PR 코멘트로 첫 시도의 실패 job을 남긴다. 재실행 요청이 실패하면 코멘트를 남기지 않는다.
// 두 번째 시도도 실패하면 이 도구는 아무것도 하지 않는다: 자동 병합 라벨러가 지금처럼 AUTOMATION_PR_CI 위반으로 실패해 실패 이슈(#926)가 되고,
// 다음 정기 실행의 refresh-pr-required-ci가 AUTOMATION_PR_CI_FAILED로 드러낸다. 진짜(결정적) 실패는 이 도구 때문에 숨겨지지 않는다.
//
// 사용: node tools/ci/rerun-automation-pr-ci.mjs --repository <owner/repo> --run-id <CI run id>
import { pathToFileURL } from "node:url";

import {
  AUTOMATION_PR_ACTIONS_BOT,
  REPOSITORY_PATTERN,
  automationStageForBranch,
  readPages,
  trustedCommitIdentity,
} from "./automation-pr-policy.mjs";
import { defaultRunGh } from "./report-refresh-failure.mjs";

export const RERUN_COMMENT_JOB_LIMIT = 10;
const MAIN = "main";
const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
const JOB_NAME_MAX_CHARS = 120;
const COMMENT_PAGES = 5;
const GITHUB_JSON = "Accept: application/vnd.github+json";

function fail(code, detail = "") {
  throw new Error(detail ? `CI_RERUN_${code}: ${detail}` : `CI_RERUN_${code}`);
}

/** 기록 코멘트의 표식. 본문 맨 앞에 둔다. */
export const rerunMarker = (runId) => `<!-- Automation CI rerun: ${runId} -->`;

const isBotComment = (comment) => comment?.user?.login === AUTOMATION_PR_ACTIONS_BOT.login
  && comment.user.id === AUTOMATION_PR_ACTIONS_BOT.id && comment.user.type === AUTOMATION_PR_ACTIONS_BOT.type;

// job 이름은 PR head의 ci.yml이 정한다. 코멘트에 그대로 넣기 전에 제어·서식(양방향 제어 포함) 문자와 HTML 주석 표지를 지우고 길이를 제한한다.
function displayName(value) {
  const cleaned = String(value ?? "").replaceAll(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replaceAll(/<!--|-->/gu, " ").replaceAll(/\s+/gu, " ").trim();
  return [...cleaned].slice(0, JOB_NAME_MAX_CHARS).join("") || "(이름 없음)";
}

function commentBody({ runId, runUrl, failed }) {
  const shown = failed.slice(0, RERUN_COMMENT_JOB_LIMIT);
  return [
    rerunMarker(runId),
    `CI가 첫 시도에서 실패해 실패한 job만 한 번 다시 실행했습니다(시도 1 -> 2, [run ${runId}](${runUrl})).`,
    "",
    "첫 시도에서 실패한 job",
    ...shown.map((item) => `- [${displayName(item.name)}](${item.html_url})`),
    ...(failed.length > shown.length ? [`- 외 ${failed.length - shown.length}개`] : []),
    "",
    "일시 오류였다면 두 번째 시도가 성공하고 자동 병합 경로가 이어집니다. 두 번째 시도도 실패하면 다시 실행하지 않고 실패로 드러납니다(실패 이슈).",
  ].join("\n");
}

function validInput({ repository, runId, api, rerunFailedJobs, comment }) {
  if (typeof repository !== "string" || !REPOSITORY_PATTERN.test(repository)) fail("INPUT", "repository");
  if (!Number.isSafeInteger(runId) || runId < 1) fail("INPUT", "run id");
  if (typeof api !== "function" || typeof rerunFailedJobs !== "function" || typeof comment !== "function") fail("INPUT", "api, rerunFailedJobs and comment must be functions");
}

/**
 * 재실행 대상인지 판정하고 대상이면 한 번 재실행한 뒤 기록한다.
 * @returns {Promise<{ state: "RERUN", pullRequest: number, failedJobs: string[] } | { state: "SECOND_ATTEMPT" | "STALE" | "ALREADY_RECORDED" } | { state: "NOT_APPLICABLE", reason: string }>}
 */
export async function rerunAutomationPullRequestCi({ repository, runId, api, rerunFailedJobs, comment, log = console.log }) {
  validInput({ repository, runId, api, rerunFailedJobs, comment });
  const run = await api(`repos/${repository}/actions/runs/${runId}`);
  if (run?.id !== runId) fail("RUN_INVALID", `run ${runId}`);
  const targeted = run.event === "pull_request" && run.path === CI_WORKFLOW_PATH && run.head_repository?.full_name === repository
    && typeof run.head_branch === "string" && automationStageForBranch(run.head_branch) !== null;
  if (!targeted) return { state: "NOT_APPLICABLE", reason: "RUN_NOT_AUTOMATION_PULL_REQUEST_CI" };
  if (run.status !== "completed" || run.conclusion !== "failure") return { state: "NOT_APPLICABLE", reason: "RUN_NOT_FAILED" };
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) fail("RUN_INVALID", `run ${runId} run_attempt`);
  if (run.run_attempt > 1) {
    log(`run ${runId} is attempt ${run.run_attempt}; the failure is reported by the existing paths and is not rerun again`);
    return { state: "SECOND_ATTEMPT" };
  }
  const headSha = run.head_sha;
  if (typeof headSha !== "string" || !/^[0-9a-f]{40}$/u.test(headSha)) fail("RUN_INVALID", `run ${runId} head_sha`);

  const associated = await api(`repos/${repository}/commits/${headSha}/pulls`);
  if (!Array.isArray(associated)) fail("PULLS_INVALID", `head ${headSha.slice(0, 12)}`);
  const open = associated.filter((item) => item?.state === "open" && item.base?.ref === MAIN);
  if (open.length === 0) return { state: "NOT_APPLICABLE", reason: "NO_OPEN_PULL" };
  if (open.length > 1) fail("PULL_AMBIGUOUS", `head ${headSha.slice(0, 12)} has ${open.length} open pull requests`);
  const number = open[0].number;
  if (!Number.isSafeInteger(number) || number < 1) fail("PULLS_INVALID", "pull request number");
  const pull = await api(`repos/${repository}/pulls/${number}`);
  if (pull?.head?.sha !== headSha) return { state: "STALE" };
  const automation = pull.head.repo?.full_name === repository && trustedCommitIdentity(pull.user) && automationStageForBranch(pull.head.ref) !== null;
  if (!automation) return { state: "NOT_APPLICABLE", reason: "PULL_NOT_AUTOMATION" };

  const comments = await readPages(api, `repos/${repository}/issues/${number}/comments`, { limit: COMMENT_PAGES });
  if (comments.some((item) => isBotComment(item) && typeof item.body === "string" && item.body.startsWith(rerunMarker(runId)))) return { state: "ALREADY_RECORDED" };

  const jobs = await api(`repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100`);
  if (!Array.isArray(jobs?.jobs)) fail("JOBS_INVALID", `run ${runId}`);
  const failed = jobs.jobs.filter((item) => item?.conclusion === "failure");
  if (failed.length === 0) fail("NO_FAILED_JOB", `run ${runId} failed but no job concluded with failure`);

  await rerunFailedJobs(runId);
  log(`reran the failed jobs of run ${runId} once (pull request #${number}): ${failed.map((item) => item.name).join(", ")}`);
  await comment(number, commentBody({ runId, runUrl: run.html_url, failed }));
  return { state: "RERUN", pullRequest: number, failedJobs: failed.map((item) => String(item.name)) };
}

function parseArgs(argv) {
  const keys = new Map([["--repository", "repository"], ["--run-id", "runId"]]);
  const values = {};
  if (!Array.isArray(argv) || argv.length !== keys.size * 2) fail("ARGUMENTS", "usage: --repository <owner/repo> --run-id <id>");
  for (let index = 0; index < argv.length; index += 2) {
    const key = keys.get(argv[index]);
    if (!key || Object.hasOwn(values, key) || typeof argv[index + 1] !== "string") fail("ARGUMENTS", `argument ${String(argv[index])}`);
    values[key] = argv[index + 1];
  }
  const runId = /^[1-9]\d{0,17}$/u.test(values.runId) ? Number(values.runId) : Number.NaN;
  if (!REPOSITORY_PATTERN.test(values.repository) || !Number.isSafeInteger(runId)) fail("ARGUMENTS", "repository or run id");
  return { repository: values.repository, runId };
}

export async function main(argv, { runGh = defaultRunGh, log = console.log } = {}) {
  const { repository, runId } = parseArgs(argv);
  const result = await rerunAutomationPullRequestCi({
    repository,
    runId,
    api: async (endpoint) => JSON.parse(await runGh(["api", "-H", GITHUB_JSON, endpoint])),
    rerunFailedJobs: async (id) => { await runGh(["api", "--method", "POST", "-H", GITHUB_JSON, `repos/${repository}/actions/runs/${id}/rerun-failed-jobs`]); },
    comment: async (number, body) => {
      await runGh(["api", "--method", "POST", "-H", GITHUB_JSON, "--input", "-", `repos/${repository}/issues/${number}/comments`], JSON.stringify({ body }));
    },
    log,
  });
  log(`automation pull request CI rerun: ${result.state}${result.reason ? ` (${result.reason})` : ""}`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
