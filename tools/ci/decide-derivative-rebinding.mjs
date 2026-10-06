#!/usr/bin/env node
// 파생 재결속 판정(#969 P4, #870 전체 자동화 1단계).
//
// 파생 재결속 도구는 모두 멱등이라, 실행해 보면 갱신이 필요한지(diff)를 안다. 이 판정은 실행해도 되는지만 가린다.
//   RUN                     열린 PR도 기다릴 PR도 없다. controller를 실행한다.
//   OPEN_PR                 이 workflow의 열린 PR이 있다. 새 일을 하지 않고 CI·방치 상한만 본다.
//   BLOCKED_BY_PENDING_PR   원장을 쓰는 다른 자동화 PR이 열려 있다. 곧 입력이 또 바뀌므로 기다린다(이상이 아니다).
// PR 없이 남았거나 닫힌 PR의 브랜치는 이상이 아니라 정리 대상이다(cleanupBranches). 판정 불가 상태(열린 PR 중복·브랜치 없음)는 DERIVATIVE_REBINDING_* 이상으로 실패한다.
//
// 사용: node tools/ci/decide-derivative-rebinding.mjs --repository <owner/repo> --prs <gh pr list JSON> --branches <git ls-remote 출력> [--github-output <path>]
import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { ownPullRequestsByBranch, parsePrefixedBranches, pendingLedgerWriterPullRequests, validRepository } from "./automation-pr-state.mjs";
import { REFRESH_CLAIM_PREFIXES } from "./refresh-open-pr-age.mjs";

export const DERIVATIVE_REBINDING_WORKFLOW = "source-derivative-rebinding.yml";
export const DERIVATIVE_REBINDING_CLAIM_PREFIX = REFRESH_CLAIM_PREFIXES[DERIVATIVE_REBINDING_WORKFLOW];

function fail(code, detail = "") {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

export function parseDerivativeRebindingBranches(text) {
  return parsePrefixedBranches(text, DERIVATIVE_REBINDING_CLAIM_PREFIX, (detail) => fail("DERIVATIVE_REBINDING_BRANCH_INVALID", detail));
}

export function decideDerivativeRebinding({ pullRequests, branches, repository } = {}) {
  if (!Array.isArray(pullRequests) || !Array.isArray(branches) || !validRepository(repository)) fail("DERIVATIVE_REBINDING_INPUT_INVALID");
  const own = ownPullRequestsByBranch(pullRequests, DERIVATIVE_REBINDING_CLAIM_PREFIX, repository, (branch) => fail("DERIVATIVE_REBINDING_PR_DUPLICATE", branch));
  const open = [...own.values()].filter(({ state }) => state === "OPEN");
  if (open.length > 1) fail("DERIVATIVE_REBINDING_PR_DUPLICATE", open.map(({ number }) => `#${number}`).join(", "));
  // 병합된 이전 PR의 브랜치는 남아 있어도 된다. PR이 없거나 닫힌 브랜치는 이전 실행이 남긴 흔적이다. 사람이 지울 일이 아니라
  // 정리 대상으로 알리고(cleanupBranches) 이번 실행이 지운다(이슈 #973). 열린 PR의 브랜치는 건드리지 않는다.
  const cleanupBranches = branches.filter((branch) => !["OPEN", "MERGED"].includes(own.get(branch)?.state));
  if (open.length === 1) {
    const [pullRequest] = open;
    if (!branches.includes(pullRequest.headRefName)) fail("DERIVATIVE_REBINDING_BRANCH_MISSING", `#${pullRequest.number} has no remote branch`);
    return { state: "OPEN_PR", branch: pullRequest.headRefName, cleanupBranches };
  }
  const blockedBy = pendingLedgerWriterPullRequests(pullRequests, repository, DERIVATIVE_REBINDING_WORKFLOW);
  return blockedBy.length > 0 ? { state: "BLOCKED_BY_PENDING_PR", blockedBy, cleanupBranches } : { state: "RUN", cleanupBranches };
}

function parseArgs(argv) {
  const keys = new Map([["--repository", "repository"], ["--prs", "prs"], ["--branches", "branches"], ["--github-output", "githubOutput"]]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = keys.get(argv[index]);
    if (!key || Object.hasOwn(values, key) || typeof argv[index + 1] !== "string") fail("DERIVATIVE_REBINDING_INPUT_INVALID", `argument ${String(argv[index])}`);
    values[key] = argv[index + 1];
  }
  for (const key of ["repository", "prs", "branches"]) if (!Object.hasOwn(values, key)) fail("DERIVATIVE_REBINDING_INPUT_INVALID", `missing --${key}`);
  return values;
}

export async function main(argv, { log = console.log } = {}) {
  const values = parseArgs(argv);
  const result = decideDerivativeRebinding({
    pullRequests: JSON.parse(await readFile(values.prs, "utf8")), branches: parseDerivativeRebindingBranches(await readFile(values.branches, "utf8")), repository: values.repository,
  });
  log(JSON.stringify(result));
  if (values.githubOutput) await appendFile(values.githubOutput, [`state=${result.state}`, `branch=${result.branch ?? ""}`, `cleanup_branches=${(result.cleanupBranches ?? []).join(",")}`, `blocked_by=${(result.blockedBy ?? []).join(",")}`, ""].join("\n"));
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
