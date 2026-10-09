#!/usr/bin/env node
// 소유 workflow의 판정이 정리 대상으로 알린 claim 브랜치를 보고(#926)한 뒤 지운다(#995).
//
// 고아 claim(PR이 없는 claim)을 조용히 지우지 않는다. 사람이 run 실패를 볼 수 있게 report-refresh-failure로 먼저 보고하고(이미 보고한 run이면 건너뛴다) 그 다음에 지운다.
// 보고가 실패하면 지우지 않는다. 지우기가 실패해도 다음 실행이 같은 보고를 건너뛰고 다시 지운다.
// 병합된 PR의 남은 claim은 끝난 일이라 보고 없이, 빈 claim 검사 없이 지운다.
//
// 이 도구는 판정이 정리 대상으로 알린 claim만 다루고 복구 가능 여부(게시 step까지 갔는지 등)는 다시 판정하지 않는다(그 의미는 workflow마다 다르다).
// 대신 판정 뒤에 상황이 바뀌었을 때를 막는다. 아래 중 하나라도 어긋나면 지우지 않고 실패한다.
//  - 브랜치가 판정 시점(--refs)의 sha에서 움직였다. 삭제 lease도 그 sha다(--force-with-lease).
//  - 같은 저장소 PR이 열려 있거나 닫혀 있다.
//  - 만든 run이 아직 끝나지 않았거나 다른 workflow의 run을 가리킨다.
//  - 브랜치가 빈 claim 하나(ahead_by 1, 제목 일치, 변경 파일 0)도, Abandon 커밋으로 닫은 claim(claim + Abandon 두 커밋, 변경 파일 0, abandonedSubject를 쓰는 workflow만)도 아니다. 보고 전과 push 직전에 두 번 확인한다.
//
// #1064: 실패한 run이 자기 claim을 같은 run에서 지운다(--self-run-id <GITHUB_RUN_ID>). 반복 실패하는 원장 writer가 다음 실행까지 claim을 남겨 후보 갱신을 막지 않게 한다.
// 호출하는 step은 `failure()`일 때만 부르므로 gh 기록상 아직 끝나지 않은 자기 run을 끝난(failure) run으로 본다. 이 예외는 claim을 만든 run이 자기 run일 때만,
// OCI에 게시하지 않는 workflow(publicationSteps null)에서만 쓴다. 빈 claim 하나(ahead 1, 제목 일치, 변경 파일 0, PR 없음)가 "게시도 출력도 없다"는 전체 증거라서다.
// 나머지 guard(보고 먼저, 보고 실패 시 삭제 안 함, lease, push 직전 재확인)는 그대로다.
//
// 사용: node tools/ci/remove-orphan-claims.mjs --workflow <file> --repository <owner/repo> --claims <claim 브랜치를 쉼표로 이은 목록> --refs <판정 시점의 git ls-remote 출력 파일> [--self-run-id <run id>]
// git push 인증은 호출하는 step이 먼저 `gh auth setup-git`으로 준비한다.
import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { ownPullRequestsByBranch } from "./automation-pr-state.mjs";
import { CLAIM_OWNERS, assertClaimRunOwner, claimRunId, classifyUnboundClaim, isClosedOutClaim, isEmptyClaim, lookupClaimCommits, lookupClaimRun } from "./claim-orphans.mjs";
import { BRANCH_PR_LIMIT, PR_FIELDS } from "./collect-automation-prs.mjs";
import { defaultRunGh, reportRefreshFailure } from "./report-refresh-failure.mjs";

const execFileAsync = promisify(execFile);
// PATH 검색 없이 고정 경로의 git을 쓴다(refresh-open-pr-age와 같은 기준).
const GIT_EXECUTABLE = "/usr/bin/git";

function fail(code, detail = "") {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

async function defaultRunGit(args) {
  const { stdout } = await execFileAsync(GIT_EXECUTABLE, args, { maxBuffer: 1024 * 1024 });
  return stdout;
}

function defaultReport({ workflowFile, repository, runId, orphan }, runGh) {
  return reportRefreshFailure({ argv: ["--workflow", workflowFile, "--repository", repository, "--run-id", runId], runGh, orphan });
}

async function remoteSha(runGit, branch) {
  const line = (await runGit(["ls-remote", "origin", `refs/heads/${branch}`])).split("\n").find(Boolean);
  if (line === undefined) return null;
  const match = /^([0-9a-f]{40})\trefs\/heads\/(.+)$/u.exec(line);
  if (!match || match[2] !== branch) fail("CLAIM_ORPHAN_REMOVE_INVALID", `ls-remote ${line}`);
  return match[1];
}

// 판정 시점의 git ls-remote 출력(--refs)에서 branch -> sha를 읽는다. 삭제 lease가 이 sha다.
function classifiedShas(refsText) {
  if (typeof refsText !== "string") fail("CLAIM_ORPHAN_INPUT_INVALID", "classification refs");
  const shas = new Map();
  for (const line of refsText.split("\n").filter(Boolean)) {
    const match = /^([0-9a-f]{40})\trefs\/heads\/(.+)$/u.exec(line);
    if (!match || shas.has(match[2])) fail("CLAIM_ORPHAN_INPUT_INVALID", `classification refs ${line}`);
    shas.set(match[2], match[1]);
  }
  return shas;
}

async function claimPullRequest(runGh, { workflowFile, repository, branch }) {
  const rows = JSON.parse(await runGh(["pr", "list", "--repo", repository, "--state", "all", "--head", branch, "--limit", String(BRANCH_PR_LIMIT), "--json", PR_FIELDS]));
  if (!Array.isArray(rows) || rows.length >= BRANCH_PR_LIMIT) fail("CLAIM_ORPHAN_REMOVE_INVALID", `pull request list for ${branch}`);
  const own = ownPullRequestsByBranch(rows, CLAIM_OWNERS[workflowFile].prefix, repository, (name) => fail("CLAIM_ORPHAN_REMOVE_INVALID", `duplicate pull request for ${name}`));
  return own.get(branch) ?? null;
}

// 지우기 전 확인(보고 전·push 직전 두 번): 만든 run이 끝났고 이 workflow의 main run이어야 하고, 브랜치는 출력이 없는 빈 claim 하나여야 한다.
// 판정(소유 workflow)이 정리 대상으로 알린 뒤 상황이 바뀌었을 때를 막는다. 공유 판정을 쓰는 workflow는 같은 분류가 여전히 ABANDONED여야 한다
// (게시 step이 시작된 run의 claim은 소유 판정을 거쳤어도 지우지 않는다). 분류 근거(reason)를 돌려준다.
async function assertStillRemovable({ workflowFile, repository, branch, runId, runGh, selfRunId }) {
  let claimRun;
  if (selfRunId !== undefined && selfRunId === runId) {
    // 자기 run: 실패 step이 부르므로 끝난 failure run으로 본다. 게시하는 workflow는 빈 claim만으로 미게시를 증명할 수 없어 거부한다.
    const owner = CLAIM_OWNERS[workflowFile];
    if (owner.publicationSteps !== null) fail("CLAIM_ORPHAN_REMOVE_REFUSED", `${branch} belongs to a workflow that publishes, so its own run cannot vouch that nothing was published`);
    claimRun = { found: true, status: "completed", conclusion: "failure", workflowName: owner.workflowName, headBranch: "main", steps: [] };
  } else {
    claimRun = await lookupClaimRun(runGh, repository, runId);
  }
  assertClaimRunOwner(workflowFile, branch, claimRun);
  if (claimRun.found && claimRun.status !== "completed") fail("CLAIM_ORPHAN_REMOVE_REFUSED", `${branch} producer run ${runId} is still ${claimRun.status}`);
  const commits = await lookupClaimCommits(runGh, repository, branch);
  // 빈 claim이거나 소유 workflow가 Abandon 커밋으로 닫은 claim(claim + Abandon, 변경 없음)만 지운다.
  // 닫힌 claim은 같은 모양을 공유 판정이 CLAIM_CLOSED_OUT으로 분류하므로 아래 재판정이 그 reason을 돌려준다(테스트가 고정한다).
  if (!isClosedOutClaim(workflowFile, commits) && !isEmptyClaim(workflowFile, commits)) fail("CLAIM_ORPHAN_REMOVE_REFUSED", `${branch} is not an empty or closed-out claim (ahead ${commits.aheadBy}, files ${commits.changedFiles}); it is kept`);
  if (CLAIM_OWNERS[workflowFile].publicationSteps === undefined) return { reason: "OWNER_DECISION", conclusion: claimRun.conclusion };
  const classified = classifyUnboundClaim(workflowFile, { branch, runId, run: claimRun, commits, artifacts: [] });
  if (classified.kind !== "ABANDONED") fail("CLAIM_ORPHAN_REMOVE_REFUSED", `${branch} is ${classified.kind} (${classified.reason}), not abandoned; it is kept`);
  return { reason: classified.reason, conclusion: claimRun.conclusion };
}

// 삭제 사실은 보고가 건너뛰어져도 run 로그(notice)와 step 요약에 남긴다.
async function recordRemoval({ log, summaryFile, workflowFile, branch, runId, conclusion, reason, reported }) {
  const fields = `workflow=${workflowFile} branch=${branch} producer_run=${runId} conclusion=${conclusion ?? "none"} reason=${reason} report=${reported ?? "none"}`;
  log(`::notice title=Orphan claim removed::${fields}`);
  if (summaryFile) {
    await appendFile(summaryFile, `- 삭제한 claim \`${branch}\`: producer run ${runId}, conclusion \`${conclusion ?? "none"}\`, 분류 \`${reason}\`, 보고 \`${reported ?? "none"}\` (${workflowFile})\n`);
  }
}

async function removeOne({ workflowFile, repository, branch, runId, classifiedSha, runGh, runGit, report, log, summaryFile, selfRunId }) {
  const sha = await remoteSha(runGit, branch);
  if (sha === null) return { branch, action: "absent", reported: null };
  if (sha !== classifiedSha) fail("CLAIM_ORPHAN_REMOVE_REFUSED", `${branch} moved since classification (${classifiedSha} -> ${sha})`);
  const pullRequest = await claimPullRequest(runGh, { workflowFile, repository, branch });
  if (pullRequest?.state === "OPEN" || pullRequest?.state === "CLOSED") fail("CLAIM_ORPHAN_REMOVE_REFUSED", `${branch} has a ${pullRequest.state} pull request #${pullRequest.number}`);
  const merged = pullRequest?.state === "MERGED";
  let removal = { conclusion: null, reason: "MERGED_LEFTOVER" };
  let reported = null;
  if (!merged) {
    removal = await assertStillRemovable({ workflowFile, repository, branch, runId, runGh, selfRunId });
    // 보고가 먼저다. 보고가 실패하면 지우지 않는다. 병합된 PR의 남은 claim은 끝난 일이라 보고하지 않는다.
    // 자기 run(--self-run-id)은 삭제 사실을 따로 댓글로 남기지 않고 run 실패 보고(그 run을 기록)만 확인한다. 실패 주기마다 같은 이슈에 삭제 댓글이 쌓이지 않게 한다.
    // 삭제 사실은 notice와 step summary에 남는다.
    const ownRun = selfRunId !== undefined && selfRunId === runId;
    reported = (await report({ workflowFile, repository, runId, ...(ownRun ? {} : { orphan: { branch, conclusion: removal.conclusion ?? "unknown", reason: removal.reason } }) }))?.action ?? null;
    await assertStillRemovable({ workflowFile, repository, branch, runId, runGh, selfRunId });
  }
  await runGit(["push", `--force-with-lease=refs/heads/${branch}:${classifiedSha}`, "origin", `:refs/heads/${branch}`]);
  await recordRemoval({ log, summaryFile, workflowFile, branch, runId, conclusion: removal.conclusion, reason: removal.reason, reported });
  return { branch, action: merged ? "removed_merged" : "removed_orphan", reported };
}

/**
 * 판정이 정리 대상으로 알린 claim을 보고한 뒤 지운다. claim 하나가 실패하면 거기서 멈추고 실패한다.
 * refsText는 판정 시점의 git ls-remote 출력이다(삭제 lease의 sha).
 * @returns {{ branch: string, action: "removed_orphan"|"removed_merged"|"absent", reported: string|null }[]}
 */
export async function removeOrphanClaims({
  workflowFile, repository, claims, refsText, runGh = defaultRunGh, runGit = defaultRunGit, report = (input) => defaultReport(input, runGh), log = console.log,
  summaryFile = process.env.GITHUB_STEP_SUMMARY, selfRunId,
} = {}) {
  if (!Object.hasOwn(CLAIM_OWNERS, workflowFile ?? "") || !Array.isArray(claims) || claims.length === 0 || new Set(claims).size !== claims.length) {
    fail("CLAIM_ORPHAN_INPUT_INVALID", "workflow or claim list");
  }
  if (selfRunId !== undefined && !/^[1-9]\d*$/u.test(selfRunId)) fail("CLAIM_ORPHAN_INPUT_INVALID", "self run id");
  const runIds = claims.map((branch) => claimRunId(workflowFile, branch));
  const shas = classifiedShas(refsText);
  for (const branch of claims) if (!shas.has(branch)) fail("CLAIM_ORPHAN_INPUT_INVALID", `${branch} is not in the classification refs`);
  const results = [];
  for (const [index, branch] of claims.entries()) {
    // 삭제는 claim마다 순차로 하고 하나가 실패하면 거기서 멈춘다.
    const result = await removeOne({ workflowFile, repository, branch, runId: runIds[index], classifiedSha: shas.get(branch), runGh, runGit, report, log, summaryFile, selfRunId }); // NOSONAR
    log(JSON.stringify(result));
    results.push(result);
  }
  return results;
}

function parseArgs(argv) {
  const keys = new Map([["--workflow", "workflowFile"], ["--repository", "repository"], ["--claims", "claims"], ["--refs", "refs"], ["--self-run-id", "selfRunId"]]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = keys.get(argv[index]);
    if (!key || Object.hasOwn(values, key) || typeof argv[index + 1] !== "string") fail("CLAIM_ORPHAN_INPUT_INVALID", `argument ${String(argv[index])}`);
    values[key] = argv[index + 1];
  }
  for (const key of keys.values()) if (key !== "selfRunId" && !Object.hasOwn(values, key)) fail("CLAIM_ORPHAN_INPUT_INVALID", `missing ${key}`);
  return { workflowFile: values.workflowFile, repository: values.repository, claims: values.claims.split(",").filter(Boolean), refsFile: values.refs, ...(values.selfRunId === undefined ? {} : { selfRunId: values.selfRunId }) };
}

export async function main(argv, dependencies = {}) {
  const { refsFile, ...input } = parseArgs(argv);
  return removeOrphanClaims({ ...input, refsText: await readFile(refsFile, "utf8"), ...dependencies });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
