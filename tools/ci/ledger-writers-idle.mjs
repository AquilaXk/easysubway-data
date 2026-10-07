#!/usr/bin/env node
// 원장을 쓰는 자동화가 진행 중인지 확인한다(#974 리뷰 F2, #975 리뷰 F6). 판정 이후 긴 작업을 하는 workflow가 push 직전에 다시 부른다.
// 열린 PR이나 PR 전의 claim 브랜치가 있으면 idle=false다. 이것은 이상이 아니라 대기다(결과를 올리지 않고 다음 실행에 맡긴다). 실패하지 않는다.
//
// #1032: --max-age <ISO 기간>을 주면 그보다 오래 열려 있는 대상(브랜치 마지막 커밋 기준)은 기다리지 않고 expired_blockers로 남긴다. 후보 갱신 workflow만 쓴다.
// 나이를 알 수 없는 대상은 기다린다. 쓰는 workflow가 없으면 지금까지처럼 모두 기다린다.
//
// 사용: node tools/ci/ledger-writers-idle.mjs --repository <owner/repo> --prs <gh pr list JSON> --automation-branches <git ls-remote 출력>
//   [--except-workflow <workflow 파일>] [--max-age <ISO 기간>] [--github-output <path>]
import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { branchCommitTimes, parseAutomationBranches, pendingLedgerWriterBranches, pendingLedgerWriters } from "./automation-pr-state.mjs";
import { isoDurationMs } from "./refresh-open-pr-age.mjs";

export async function main(argv, { log = console.log, runGit, now = () => new Date() } = {}) {
  const keys = new Map([["--repository", "repository"], ["--prs", "prs"], ["--automation-branches", "branches"], ["--except-workflow", "exceptWorkflow"], ["--max-age", "maxAge"], ["--github-output", "githubOutput"]]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = keys.get(argv[index]);
    if (!key || Object.hasOwn(values, key) || typeof argv[index + 1] !== "string") throw new Error("AUTOMATION_PR_STATE_INPUT_INVALID");
    values[key] = argv[index + 1];
  }
  if (["repository", "prs", "branches"].some((key) => !Object.hasOwn(values, key))) throw new Error("AUTOMATION_PR_STATE_INPUT_INVALID");
  const input = {
    pullRequests: JSON.parse(await readFile(values.prs, "utf8")), automationBranches: parseAutomationBranches(await readFile(values.branches, "utf8")),
    repository: values.repository, exceptWorkflow: values.exceptWorkflow ?? null,
  };
  let waitLimit = {};
  if (Object.hasOwn(values, "maxAge")) {
    const maxAgeMs = isoDurationMs(values.maxAge);
    waitLimit = { maxAgeMs, now: now(), branchTimes: await branchCommitTimes({ branches: pendingLedgerWriterBranches(input), ...(runGit ? { runGit } : {}) }) };
  }
  const pending = pendingLedgerWriters({ ...input, ...waitLimit });
  const blockedBy = [...pending.pullRequests.map(String), ...pending.branches];
  const idle = blockedBy.length === 0;
  const expiredBlockers = (pending.expired ?? []).map(({ blocker }) => String(blocker));
  log(JSON.stringify({ idle, blockedBy, ...(pending.expired ? { expiredBlockers } : {}) }));
  if (values.githubOutput) {
    await appendFile(values.githubOutput, `idle=${idle}\nblocked_by=${blockedBy.join(",")}\n${pending.expired ? `expired_blockers=${expiredBlockers.join(",")}\n` : ""}`);
  }
  return { idle, blockedBy, ...(pending.expired ? { expiredBlockers } : {}) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
