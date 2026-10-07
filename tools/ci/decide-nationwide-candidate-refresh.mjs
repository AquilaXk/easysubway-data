#!/usr/bin/env node
// 전국 후보 갱신 판정(#969 P5, #870 전체 자동화 1단계).
//
// 후보 갱신 workflow는 정기(schedule) 폴링과 스케줄러 App의 dispatch(#1032)로 돈다. 정기 역할(datapack-scheduled-refresh)은 schedule 이벤트와
// 그 App의 dispatch에서만 쓸 수 있어서 push·workflow_run으로 같은 역할의 후보를 만들 수 없다(#929 D3). 그래서 2시간마다 이 판정으로
// "지금 후보를 다시 만들어야 하는가"만 본다.
//
// 후보가 읽은 입력은 후보 입력 매니페스트(nationwide-candidate-input-manifest.json)에 sha256으로 고정돼 있다.
// 그 입력이 모두 지금 작업 트리와 같으면 후보는 최신이고(CURRENT), 하나라도 다르면 후보를 다시 만들어야 한다(STALE).
// RC의 후보 currency 검사도 같은 기준으로 후보를 거절하므로, 이 판정이 STALE이 아닌데 RC가 거절하는 일은 없다.
//
//   CURRENT                 입력이 모두 같다. 아무것도 하지 않는다. 사람 dispatch는 명시 요청이라 FORCED로 진행한다.
//                           스케줄러 App의 dispatch(#1032)는 정기 실행의 대체 경로이므로 schedule과 같이 CURRENT에서 아무것도 하지 않는다.
//   STALE                   입력이 바뀌었다. stalePaths가 어느 경로인지 남긴다.
//   OPEN_PR                 후보 갱신 PR이 이미 열려 있다. 새로 만들지 않고 CI·방치 상한만 본다.
//   BLOCKED_BY_PENDING_PR   STALE인데 원장을 쓰는 자동화 PR이 열려 있다. 곧 입력이 또 바뀌므로 기다린다(이상이 아니다).
//                           기다림에는 상한이 있다(LEDGER_WRITER_WAIT_LIMIT, #1032): 브랜치 마지막 커밋이 그보다 오래된 PR·claim은 멈춘 것이라
//                           기다리지 않고 후보를 만든다(STALE). 무시한 대상은 expiredBlockers로 남고 소유 workflow의 실패 보고(#926)가 사람에게 알린다.
//                           그 대상이 나중에 병합돼 입력이 또 바뀌면 다음 판정이 다시 STALE이다. 나이를 알 수 없는 대상은 기다린다.
//
// PR 없이 남았거나 닫힌 PR의 후보 브랜치는 이상이 아니라 정리 대상이다(cleanupBranches). 판정 불가 상태(중복 열린 PR, 브랜치 없는 열린 PR,
// 잘못된 매니페스트)는 CANDIDATE_REFRESH_* 이상으로 실패한다.
//
// 사용: node tools/ci/decide-nationwide-candidate-refresh.mjs --event <schedule|workflow_dispatch> [--actor <login>] --repository <owner/repo>
//   --prs <gh pr list JSON> --branches <git ls-remote 출력> --automation-branches <git ls-remote "automation/*" 출력> [--manifest <path>] [--github-output <path>]
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { CANDIDATE_INPUT_MANIFEST_PATH, assertCandidateInputsCurrent, parseCandidateInputManifest } from "../datapack/lib/candidate-input-bundle.mjs";
import { SCHEDULER_APP_LOGIN } from "../datapack/lib/scheduled-release-authority.mjs";
import {
  LEDGER_WRITER_WAIT_LIMIT, branchCommitTimes, ownPullRequestsByBranch, parseAutomationBranches, parsePrefixedBranches, pendingLedgerWriterBranches, pendingLedgerWriters, validRepository,
} from "./automation-pr-state.mjs";
import { REFRESH_CLAIM_PREFIXES, isoDurationMs } from "./refresh-open-pr-age.mjs";

export const CANDIDATE_REFRESH_WORKFLOW = "nationwide-candidate-refresh.yml";
export const CANDIDATE_REFRESH_CLAIM_PREFIX = REFRESH_CLAIM_PREFIXES[CANDIDATE_REFRESH_WORKFLOW];
const EVENTS = Object.freeze(["schedule", "workflow_dispatch"]);
const ROOT = path.resolve(import.meta.dirname, "../..");

function fail(code, detail = "") {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

/** git ls-remote --heads 출력에서 후보 갱신 브랜치만 읽는다. 다른 형식이 섞이면 실패한다. */
export function parseCandidateRefreshBranches(text) {
  return parsePrefixedBranches(text, CANDIDATE_REFRESH_CLAIM_PREFIX, (detail) => fail("CANDIDATE_REFRESH_BRANCH_INVALID", detail));
}

export async function decideNationwideCandidateRefresh({ manifest, readLocal, pullRequests, branches, automationBranches, repository, event, actor, ledgerWriterWait } = {}) {
  if (!Array.isArray(pullRequests) || !Array.isArray(branches) || !Array.isArray(automationBranches) || typeof readLocal !== "function"
    || !validRepository(repository) || !EVENTS.includes(event)) fail("CANDIDATE_REFRESH_INPUT_INVALID");

  const own = ownPullRequestsByBranch(pullRequests, CANDIDATE_REFRESH_CLAIM_PREFIX, repository, (branch) => fail("CANDIDATE_REFRESH_PR_DUPLICATE", branch));
  const open = [...own.values()].filter(({ state }) => state === "OPEN");
  if (open.length > 1) fail("CANDIDATE_REFRESH_PR_DUPLICATE", open.map(({ number }) => `#${number}`).join(", "));
  // 병합된 이전 후보 PR의 브랜치는 남아 있어도 된다. PR이 없거나 닫힌 브랜치는 이전 실행이 남긴 흔적이다. 사람이 지울 일이 아니라
  // 정리 대상으로 알리고(cleanupBranches) 이번 실행이 지운다(이슈 #973). 열린 PR의 브랜치는 건드리지 않는다.
  const cleanupBranches = branches.filter((branch) => !["OPEN", "MERGED"].includes(own.get(branch)?.state));
  if (open.length === 1) {
    const [pullRequest] = open;
    if (!branches.includes(pullRequest.headRefName)) fail("CANDIDATE_REFRESH_BRANCH_MISSING", `#${pullRequest.number} has no remote branch`);
    return { state: "OPEN_PR", branch: pullRequest.headRefName, cleanupBranches };
  }

  let stalePaths = [];
  try {
    await assertCandidateInputsCurrent({ manifest, readLocal });
  } catch (error) {
    const stale = /^CANDIDATE_INPUT_STALE: (.+)$/u.exec(error?.message ?? "");
    if (!stale) fail("CANDIDATE_REFRESH_MANIFEST_INVALID", String(error?.message ?? error));
    stalePaths = stale[1].split(", ");
  }
  // 사람 dispatch만 명시 요청이다. 스케줄러 App의 dispatch는 2시간마다 깨우는 정기 실행이라 입력이 같으면 후보를 만들지 않는다.
  const explicitRequest = event === "workflow_dispatch" && actor !== SCHEDULER_APP_LOGIN;
  if (stalePaths.length === 0) return explicitRequest ? { state: "FORCED", cleanupBranches } : { state: "CURRENT", cleanupBranches };
  // 열린 PR뿐 아니라 PR 전의 claim 브랜치도 원장을 쓰는 중이다(#974 리뷰 F2).
  const pending = pendingLedgerWriters({ pullRequests, automationBranches, repository, ...(ledgerWriterWait ?? {}) });
  const blockedBy = [...pending.pullRequests, ...pending.branches];
  const decision = blockedBy.length > 0 ? { state: "BLOCKED_BY_PENDING_PR", stalePaths, blockedBy, cleanupBranches } : { state: "STALE", stalePaths, cleanupBranches };
  return pending.expired?.length > 0 ? { ...decision, expiredBlockers: pending.expired } : decision;
}

function parseArgs(argv) {
  const keys = new Map([["--event", "event"], ["--actor", "actor"], ["--repository", "repository"], ["--prs", "prs"], ["--branches", "branches"], ["--automation-branches", "automationBranches"], ["--manifest", "manifest"], ["--github-output", "githubOutput"]]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = keys.get(argv[index]);
    if (!key || Object.hasOwn(values, key) || typeof argv[index + 1] !== "string") fail("CANDIDATE_REFRESH_INPUT_INVALID", `argument ${String(argv[index])}`);
    values[key] = argv[index + 1];
  }
  for (const key of ["event", "repository", "prs", "branches", "automationBranches"]) if (!Object.hasOwn(values, key)) fail("CANDIDATE_REFRESH_INPUT_INVALID", `missing --${key}`);
  return values;
}

export async function main(argv, { repositoryRoot = ROOT, log = console.log, runGit, now = () => new Date() } = {}) {
  const values = parseArgs(argv);
  let manifest;
  try {
    manifest = parseCandidateInputManifest(await readFile(path.resolve(repositoryRoot, values.manifest ?? CANDIDATE_INPUT_MANIFEST_PATH)));
  } catch (error) {
    fail("CANDIDATE_REFRESH_MANIFEST_INVALID", String(error?.message ?? error));
  }
  const pullRequests = JSON.parse(await readFile(values.prs, "utf8"));
  const automationBranches = parseAutomationBranches(await readFile(values.automationBranches, "utf8"));
  // 멈춘 원장 쓰기 자동화를 기다리지 않도록 기다릴 후보의 마지막 커밋 시각을 로컬 checkout에서 읽는다(#1032).
  const ledgerWriterWait = {
    maxAgeMs: isoDurationMs(LEDGER_WRITER_WAIT_LIMIT), now: now(),
    branchTimes: await branchCommitTimes({ branches: pendingLedgerWriterBranches({ pullRequests, automationBranches, repository: values.repository }), ...(runGit ? { runGit } : {}) }),
  };
  const result = await decideNationwideCandidateRefresh({
    manifest, readLocal: (relative) => readFile(path.resolve(repositoryRoot, relative)),
    pullRequests, branches: parseCandidateRefreshBranches(await readFile(values.branches, "utf8")), automationBranches,
    repository: values.repository, event: values.event, actor: values.actor, ledgerWriterWait,
  });
  log(JSON.stringify(result));
  if (values.githubOutput) {
    await appendFile(values.githubOutput, [
      `state=${result.state}`, `branch=${result.branch ?? ""}`, `stale_paths=${(result.stalePaths ?? []).join(",")}`, `cleanup_branches=${(result.cleanupBranches ?? []).join(",")}`, `blocked_by=${(result.blockedBy ?? []).join(",")}`,
      `expired_blockers=${(result.expiredBlockers ?? []).map(({ blocker }) => blocker).join(",")}`, "",
    ].join("\n"));
  }
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
