#!/usr/bin/env node
// 소유 workflow의 판정이 정리 대상으로 알린 claim 브랜치를 보고(#926)한 뒤 지운다(#995).
//
// 고아 claim(PR이 없는 claim)을 조용히 지우지 않는다. 사람이 run 실패를 볼 수 있게 report-refresh-failure로 먼저 보고하고(이미 보고한 run이면 건너뛴다) 그 다음에 지운다.
// 보고가 실패하면 지우지 않는다. 지우기가 실패해도 다음 실행이 같은 보고를 건너뛰고 다시 지운다.
// 병합된 PR의 남은 claim은 끝난 일이라 보고 없이 지운다.
//
// 이 도구는 판정이 정리 대상으로 알린 claim만 다루고 복구 가능 여부는 다시 판정하지 않는다(그 의미는 workflow마다 다르다).
// 대신 판정 뒤에 상황이 바뀌었을 때를 막는다: 같은 저장소 PR이 열려 있거나 닫혀 있으면, 만든 run이 아직 끝나지 않았으면,
// 다른 workflow의 run을 가리키면 지우지 않고 실패한다. 삭제는 지금 본 sha일 때만 한다(--force-with-lease).
//
// 사용: node tools/ci/remove-orphan-claims.mjs --workflow <file> --repository <owner/repo> --claims <claim 브랜치를 쉼표로 이은 목록>
// git push 인증은 호출하는 step이 먼저 `gh auth setup-git`으로 준비한다.
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { ownPullRequestsByBranch } from "./automation-pr-state.mjs";
import { CLAIM_OWNERS, assertClaimRunOwner, claimRunId, lookupClaimRun } from "./claim-orphans.mjs";
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

function defaultReport({ workflowFile, repository, runId }, runGh) {
  return reportRefreshFailure({ argv: ["--workflow", workflowFile, "--repository", repository, "--run-id", runId], runGh });
}

async function remoteSha(runGit, branch) {
  const line = (await runGit(["ls-remote", "origin", `refs/heads/${branch}`])).split("\n").find(Boolean);
  if (line === undefined) return null;
  const match = /^([0-9a-f]{40})\trefs\/heads\/(.+)$/u.exec(line);
  if (!match || match[2] !== branch) fail("CLAIM_ORPHAN_REMOVE_INVALID", `ls-remote ${line}`);
  return match[1];
}

async function claimPullRequest(runGh, { workflowFile, repository, branch }) {
  const rows = JSON.parse(await runGh(["pr", "list", "--repo", repository, "--state", "all", "--head", branch, "--limit", String(BRANCH_PR_LIMIT), "--json", PR_FIELDS]));
  if (!Array.isArray(rows) || rows.length >= BRANCH_PR_LIMIT) fail("CLAIM_ORPHAN_REMOVE_INVALID", `pull request list for ${branch}`);
  const own = ownPullRequestsByBranch(rows, CLAIM_OWNERS[workflowFile].prefix, repository, (name) => fail("CLAIM_ORPHAN_REMOVE_INVALID", `duplicate pull request for ${name}`));
  return own.get(branch) ?? null;
}

// 보고 대상 고아(PR이 없는 claim)를 지우기 전 확인: 만든 run이 끝났고 이 workflow의 main run이어야 한다. 그 뒤에 보고하고(실패하면 지우지 않는다) 결과를 돌려준다.
async function reportOrphan({ workflowFile, repository, branch, runId, runGh, report }) {
  const claimRun = await lookupClaimRun(runGh, repository, runId);
  assertClaimRunOwner(workflowFile, branch, claimRun);
  if (claimRun.found && claimRun.status !== "completed") fail("CLAIM_ORPHAN_REMOVE_REFUSED", `${branch} producer run ${runId} is still ${claimRun.status}`);
  return (await report({ workflowFile, repository, runId }))?.action ?? null;
}

async function removeOne({ workflowFile, repository, branch, runId, runGh, runGit, report }) {
  const sha = await remoteSha(runGit, branch);
  if (sha === null) return { branch, action: "absent", reported: null };
  const pullRequest = await claimPullRequest(runGh, { workflowFile, repository, branch });
  if (pullRequest?.state === "OPEN" || pullRequest?.state === "CLOSED") fail("CLAIM_ORPHAN_REMOVE_REFUSED", `${branch} has a ${pullRequest.state} pull request #${pullRequest.number}`);
  const merged = pullRequest?.state === "MERGED";
  // 보고가 먼저다. 병합된 PR의 남은 claim은 끝난 일이라 보고하지 않는다.
  const reported = merged ? null : await reportOrphan({ workflowFile, repository, branch, runId, runGh, report });
  await runGit(["push", `--force-with-lease=refs/heads/${branch}:${sha}`, "origin", `:refs/heads/${branch}`]);
  return { branch, action: merged ? "removed_merged" : "removed_orphan", reported };
}

/**
 * 판정이 정리 대상으로 알린 claim을 보고한 뒤 지운다. claim 하나가 실패하면 거기서 멈추고 실패한다.
 * @returns {{ branch: string, action: "removed_orphan"|"removed_merged"|"absent", reported: string|null }[]}
 */
export async function removeOrphanClaims({
  workflowFile, repository, claims, runGh = defaultRunGh, runGit = defaultRunGit, report = (input) => defaultReport(input, runGh), log = console.log,
} = {}) {
  if (!Object.hasOwn(CLAIM_OWNERS, workflowFile ?? "") || !Array.isArray(claims) || claims.length === 0 || new Set(claims).size !== claims.length) {
    fail("CLAIM_ORPHAN_INPUT_INVALID", "workflow or claim list");
  }
  const runIds = claims.map((branch) => claimRunId(workflowFile, branch));
  const results = [];
  for (const [index, branch] of claims.entries()) {
    const result = await removeOne({ workflowFile, repository, branch, runId: runIds[index], runGh, runGit, report });
    log(JSON.stringify(result));
    results.push(result);
  }
  return results;
}

function parseArgs(argv) {
  const keys = new Map([["--workflow", "workflowFile"], ["--repository", "repository"], ["--claims", "claims"]]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = keys.get(argv[index]);
    if (!key || Object.hasOwn(values, key) || typeof argv[index + 1] !== "string") fail("CLAIM_ORPHAN_INPUT_INVALID", `argument ${String(argv[index])}`);
    values[key] = argv[index + 1];
  }
  for (const key of keys.values()) if (!Object.hasOwn(values, key)) fail("CLAIM_ORPHAN_INPUT_INVALID", `missing ${key}`);
  return { workflowFile: values.workflowFile, repository: values.repository, claims: values.claims.split(",").filter(Boolean) };
}

export async function main(argv, dependencies = {}) {
  return removeOrphanClaims({ ...parseArgs(argv), ...dependencies });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
