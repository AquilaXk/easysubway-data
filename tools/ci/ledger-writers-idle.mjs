#!/usr/bin/env node
// 원장을 쓰는 자동화가 진행 중인지 확인한다(#974 리뷰 F2, #975 리뷰 F6). 판정 이후 긴 작업을 하는 workflow가 push 직전에 다시 부른다.
// 열린 PR이나 PR 전의 claim 브랜치가 있으면 idle=false다. 이것은 이상이 아니라 대기다(결과를 올리지 않고 다음 실행에 맡긴다). 실패하지 않는다.
//
// 사용: node tools/ci/ledger-writers-idle.mjs --repository <owner/repo> --prs <gh pr list JSON> --automation-branches <git ls-remote 출력>
//   [--except-workflow <workflow 파일>] [--github-output <path>]
import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { parseAutomationBranches, pendingLedgerWriters } from "./automation-pr-state.mjs";

export async function main(argv, { log = console.log } = {}) {
  const keys = new Map([["--repository", "repository"], ["--prs", "prs"], ["--automation-branches", "branches"], ["--except-workflow", "exceptWorkflow"], ["--github-output", "githubOutput"]]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = keys.get(argv[index]);
    if (!key || Object.hasOwn(values, key) || typeof argv[index + 1] !== "string") throw new Error("AUTOMATION_PR_STATE_INPUT_INVALID");
    values[key] = argv[index + 1];
  }
  if (["repository", "prs", "branches"].some((key) => !Object.hasOwn(values, key))) throw new Error("AUTOMATION_PR_STATE_INPUT_INVALID");
  const pending = pendingLedgerWriters({
    pullRequests: JSON.parse(await readFile(values.prs, "utf8")), automationBranches: parseAutomationBranches(await readFile(values.branches, "utf8")),
    repository: values.repository, exceptWorkflow: values.exceptWorkflow ?? null,
  });
  const blockedBy = [...pending.pullRequests.map(String), ...pending.branches];
  const idle = blockedBy.length === 0;
  log(JSON.stringify({ idle, blockedBy }));
  if (values.githubOutput) await appendFile(values.githubOutput, `idle=${idle}\nblocked_by=${blockedBy.join(",")}\n`);
  return { idle, blockedBy };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
