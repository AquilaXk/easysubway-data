#!/usr/bin/env node
// 정기 갱신 4종 workflow가 PR을 열기 전에 증거 블록이 든 PR 본문을 만든다(#1012, #870 전체 자동화).
//
// workflow는 갱신 결과를 커밋한 직후(push 전) 또는 복구 경로의 PR 생성 직전에 이 도구를 부른다. 도구는 base·head 두 커밋의 git 객체만 읽는다.
//   1. 두 커밋의 변경 파일(경로·종류)을 단계 규칙과 대조한다(refreshFileViolation). 어긋나면 본문을 만들지 않고 실패한다.
//   2. 원장 게이트·inventory 범위·증거 결속을 다시 계산한다(evaluateRefreshStage). CI의 Automation PR gates가 PR head에서 같은 함수를 다시 부른다.
//   3. 위반이 없을 때만 증거 블록과 PR 본문을 쓴다. 위반은 코드와 함께 실패하고 workflow의 실패 보고(#926) 경로로 드러난다.
// 이 도구는 병합 판단을 하지 않는다. 판단은 자동 병합 정책(automation-pr-policy)이 API 데이터와 재계산으로 한다.
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { parseAutomationPrEvidence, refreshPullRequestBody } from "./automation-pr-evidence.mjs";
import { evaluateRefreshStage, isRefreshStage, refreshFileViolation } from "./refresh-stage-contracts.mjs";
import { parseLedgerChangePolicy } from "./source-ledger-gate.mjs";

const execFileAsync = promisify(execFile);
const GIT = "/usr/bin/git";
const POLICY_PATH = "tools/ci/source-ledger-change-policy.json";
const COMMIT = /^[0-9a-f]{40}$/u;
const STATUS = Object.freeze({ A: "added", M: "modified", D: "removed", T: "changed" });
const OPTIONS = Object.freeze(["stage", "repository-root", "base-sha", "head-sha", "run-url", "summary", "refs", "output"]);

const message = (error) => (error instanceof Error ? error.message : String(error));
const inputError = (detail) => new Error(`REFRESH_PR_INPUT: ${detail}`);

async function git(root, args) {
  return (await execFileAsync(GIT, args, { cwd: root, maxBuffer: 512 * 1024 * 1024 })).stdout;
}

/** base..head의 변경 파일. 이름 변경 탐지를 끄므로 이름 변경은 삭제와 추가로 보여 규칙을 통과하지 못한다. */
async function changedFiles(root, baseSha, headSha) {
  const output = await git(root, ["diff", "--name-status", "--no-renames", "-z", baseSha, headSha]);
  const parts = output.split("\0");
  if (parts.at(-1) === "") parts.pop();
  const files = [];
  for (let index = 0; index < parts.length; index += 2) {
    const status = STATUS[parts[index]] ?? parts[index];
    const filename = parts[index + 1];
    if (typeof filename !== "string" || filename === "") throw inputError("git diff 출력 형식이 다르다");
    files.push({ filename, status });
  }
  return files;
}

/**
 * 갱신 PR의 증거와 본문을 만든다. 위반이 있으면 예외로 끝난다(본문을 만들지 않는다).
 * @returns {Promise<{ body: string, evidence: object }>}
 */
export async function buildRefreshPullRequest({ stage, repositoryRoot, baseSha, headSha, runUrl, summary, refs }) {
  if (!isRefreshStage(stage)) throw new Error(`REFRESH_STAGE_UNKNOWN: ${String(stage)}`);
  if (typeof repositoryRoot !== "string" || repositoryRoot === "") throw inputError("repository root");
  if (typeof baseSha !== "string" || !COMMIT.test(baseSha)) throw inputError("base sha");
  if (typeof headSha !== "string" || !COMMIT.test(headSha)) throw inputError("head sha");
  const root = path.resolve(repositoryRoot);

  const files = await changedFiles(root, baseSha, headSha);
  const fileReason = refreshFileViolation(stage, files);
  if (fileReason !== null) throw new Error(`AUTOMATION_PR_PATHS: ${fileReason}`);
  const paths = files.map(({ filename }) => filename).sort((left, right) => (left < right ? -1 : Number(left > right)));

  const policy = parseLedgerChangePolicy(JSON.parse(await git(root, ["show", `${headSha}:${POLICY_PATH}`])));
  const { rows, violations } = await evaluateRefreshStage({
    stage, paths, baseSha, policy,
    files: {
      readTree: (relative) => git(root, ["show", `${headSha}:${relative}`]),
      readBase: (sha, relative) => git(root, ["show", `${sha}:${relative}`]),
    },
  });
  if (violations.length > 0) throw new Error(violations.map(({ code, detail }) => `AUTOMATION_PR_${code}: ${detail}`).join("\n"));

  const body = refreshPullRequestBody({ stage, runUrl, baseSha, headSha, policy, sources: rows, paths, summary, refs });
  return { body, evidence: parseAutomationPrEvidence(body, { headSha }) };
}

function parseOptions(rest) {
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    if (!key?.startsWith("--") || !OPTIONS.includes(key.slice(2)) || Object.hasOwn(values, key.slice(2)) || typeof rest[index + 1] !== "string") throw inputError(`argument ${String(key)}`);
    values[key.slice(2)] = rest[index + 1];
  }
  for (const key of OPTIONS) {
    if (key !== "repository-root" && !Object.hasOwn(values, key)) throw inputError(`--${key} is required`);
  }
  return values;
}

export async function main(argv, { log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const [command, ...rest] = argv;
  if (command !== "body") throw inputError(`unknown command ${String(command)}`);
  const values = parseOptions(rest);
  const { body } = await buildRefreshPullRequest({
    stage: values.stage, repositoryRoot: values["repository-root"] ?? ".", baseSha: values["base-sha"], headSha: values["head-sha"],
    runUrl: values["run-url"], summary: values.summary, refs: values.refs,
  });
  await writeFile(values.output, body, { flag: "wx" });
  log(`갱신 PR 증거 블록을 만들었다: ${values.stage}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${message(error)}\n`);
    process.exitCode = 1;
  }
}
