#!/usr/bin/env node
// 자동화 판정이 받을 PR 목록을 모은다(#993).
//
// 예전에는 판정 step마다 `gh pr list --state all --limit 1000`으로 PR 전체 이력을 받았다. 자동화가 매일 PR을 여니 이력은 계속 쌓이고,
// 1000건에 닿는 순간 판정이 영구 실패하거나(`*_LIST_TRUNCATED`) 오래된 병합 PR이 잘린 목록으로 조용히 판단했다.
// 판정이 실제로 쓰는 것은 둘뿐이다.
//   1. 열린 PR 전체: 직렬화(중복 열린 PR, 원장을 쓰는 다른 자동화 PR 대기, OPEN_PR).
//   2. claim 브랜치에 묶인 PR의 상태(전 상태): MERGED면 끝난 일, CLOSED면 이상, 없으면 복구·정리.
// 열린 PR은 적게 유지되므로 --limit을 두고, 상한과 같은 개수면 잘렸을 수 있으므로 실패한다(fail-closed). 대체하거나 일부만 보고 판단하지 않는다.
// claim 브랜치는 판정이 이미 `git ls-remote`로 아는 것이다. 이 도구는 그 출력의 브랜치마다 `--state all --head <branch>`로 그 브랜치의 PR만 받는다.
// 브랜치 수는 MAX_CLAIM_BRANCHES를 넘으면 AUTOMATION_CLAIM_BRANCH_LIMIT로 실패하고(정리 실패로 브랜치가 쌓이는 이상), 조회한 브랜치 수는 요약 로그(branch_lookups)에 남긴다.
//
// 사용: node tools/ci/collect-automation-prs.mjs --repository <owner/repo> --refs <git ls-remote --heads 출력> --pr-limit <열린 PR 목록 상한> --output <path>
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { validRepository } from "./automation-pr-state.mjs";

const execFileAsync = promisify(execFile);

export const PR_FIELDS = "number,state,isDraft,headRefName,baseRefName,headRepository,isCrossRepository";
// 한 브랜치에 묶인 PR은 보통 1건이다. 이 개수에 닿으면 이상이다.
export const BRANCH_PR_LIMIT = 100;
// claim 브랜치는 보통 한두 개다. 이 개수를 넘으면 정리 실패로 브랜치가 쌓이는 이상이다. 브랜치마다 gh를 한 번씩 부르므로 느려지기 전에 이름 있는 코드로 실패한다.
export const MAX_CLAIM_BRANCHES = 50;

const REF_LINE = /^[0-9a-f]{40}\trefs\/heads\/([A-Za-z0-9][A-Za-z0-9._/-]*)$/u;

function fail(code, detail = "") {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

/** git ls-remote --heads 출력에서 브랜치 이름을 읽는다. 다른 형식이 섞이거나 같은 브랜치가 두 번이면 실패한다. */
function parseBranches(text) {
  if (typeof text !== "string") fail("AUTOMATION_PR_REFS_INVALID", "listing is not text");
  const branches = text.split("\n").filter(Boolean).map((line) => {
    const match = REF_LINE.exec(line);
    if (!match) fail("AUTOMATION_PR_REFS_INVALID", line);
    return match[1];
  });
  if (new Set(branches).size !== branches.length) fail("AUTOMATION_PR_REFS_INVALID", "duplicate refs");
  return branches;
}

async function list(runGh, args, describe, limit) {
  let rows;
  try {
    rows = JSON.parse(await runGh(args));
  } catch (error) {
    if (error instanceof SyntaxError) fail("AUTOMATION_PR_LIST_INVALID", `${describe} is not JSON`);
    throw error;
  }
  if (!Array.isArray(rows)) fail("AUTOMATION_PR_LIST_INVALID", `${describe} is not a list`);
  // 상한과 같은 개수면 잘렸을 수 있으므로 일부만 보고 판단하지 않는다.
  if (rows.length >= limit) fail("AUTOMATION_PR_LIST_TRUNCATED", `${describe} reached its limit ${limit}`);
  return rows;
}

/**
 * 열린 PR 전체와 refs의 브랜치별 PR(전 상태)을 번호 기준으로 합쳐 돌려준다.
 * 같은 PR이 둘 다에 있으면 나중에 읽은 브랜치별 상태를 쓴다.
 */
export async function collectAutomationPullRequests({ repository, refsText, limit, runGh } = {}) {
  if (!validRepository(repository) || !Number.isSafeInteger(limit) || limit < 1 || typeof runGh !== "function") fail("AUTOMATION_PR_INPUT_INVALID");
  const branches = parseBranches(refsText);
  if (branches.length > MAX_CLAIM_BRANCHES) fail("AUTOMATION_CLAIM_BRANCH_LIMIT", `${branches.length} claim branches exceed the limit ${MAX_CLAIM_BRANCHES}`);
  const open = await list(runGh, ["pr", "list", "--repo", repository, "--state", "open", "--limit", String(limit), "--json", PR_FIELDS], "open pull request list", limit);
  const byNumber = new Map(open.map((item) => [item?.number, item]));
  for (const branch of branches) {
    const rows = await list(
      runGh,
      ["pr", "list", "--repo", repository, "--state", "all", "--head", branch, "--limit", String(BRANCH_PR_LIMIT), "--json", PR_FIELDS],
      `pull request list for refs/heads/${branch}`,
      BRANCH_PR_LIMIT,
    );
    for (const item of rows) byNumber.set(item?.number, item);
  }
  return { pullRequests: [...byNumber.values()], open: open.length, branchLookups: branches.length };
}

function parseArgs(argv) {
  const keys = new Map([["--repository", "repository"], ["--refs", "refs"], ["--pr-limit", "prLimit"], ["--output", "output"]]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = keys.get(argv[index]);
    if (!key || Object.hasOwn(values, key) || typeof argv[index + 1] !== "string") fail("AUTOMATION_PR_INPUT_INVALID", `argument ${String(argv[index])}`);
    values[key] = argv[index + 1];
  }
  for (const key of ["repository", "refs", "prLimit", "output"]) {
    if (!Object.hasOwn(values, key)) fail("AUTOMATION_PR_INPUT_INVALID", `missing --${key === "prLimit" ? "pr-limit" : key}`);
  }
  return values;
}

async function ghCli(args) {
  const { stdout } = await execFileAsync("gh", args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

export async function main(argv, { runGh = ghCli, log = console.log } = {}) {
  const values = parseArgs(argv);
  if (!/^[1-9]\d*$/u.test(values.prLimit)) fail("AUTOMATION_PR_INPUT_INVALID", "--pr-limit must be a positive integer");
  const { pullRequests, open, branchLookups } = await collectAutomationPullRequests({
    repository: values.repository, refsText: await readFile(values.refs, "utf8"), limit: Number(values.prLimit), runGh,
  });
  await writeFile(values.output, `${JSON.stringify(pullRequests)}\n`);
  log(`automation pull requests: open=${open} branch_lookups=${branchLookups} total=${pullRequests.length}`);
  return pullRequests;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
