// 자동화 PR 상태 판정의 공통 부분(#969). 등록·재확인·파생 재결속 판정이 같은 규칙으로 열린 PR·남은 브랜치·원장 쓰기 PR을 본다.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { LEDGER_WRITER_WORKFLOWS, REFRESH_CLAIM_PREFIXES } from "./refresh-open-pr-age.mjs";

const execFileAsync = promisify(execFile);
// PATH 검색 없이 고정 경로의 git을 쓴다(refresh-open-pr-age와 같은 기준).
const GIT_EXECUTABLE = "/usr/bin/git";

const REPOSITORY = /^[^/\s]+\/[^/\s]+$/u;

// #1032: 후보 갱신이 원장 쓰기 자동화를 기다리는 상한. 정상 갱신 PR은 만들어져 병합되기까지 약 20분이 걸리므로(2026-10-07 #1016 22분, #1021 21분)
// 5배 넘게 열려 있으면 멈춘 것이다. 멈춘 대상은 소유 workflow의 실패 보고(#926)가 사람에게 알리고, 후보 갱신은 그 대상 때문에 영구히 서 있지 않는다.
// 그 대상이 나중에 병합되어 입력이 또 바뀌면 후보 갱신 판정이 다시 STALE이 되어 후보를 새로 만든다.
export const LEDGER_WRITER_WAIT_LIMIT = "PT2H";

export function validRepository(value) {
  return typeof value === "string" && REPOSITORY.test(value);
}

/** git ls-remote --heads 출력에서 접두어 브랜치만 읽어 [{ sha, branch }]로 돌려준다. 다른 형식이 섞이거나 중복이면 invalid()를 부른다. */
export function parsePrefixedRefs(text, prefix, invalid) {
  if (typeof text !== "string") invalid("listing is not text");
  const pattern = new RegExp(String.raw`^([0-9a-f]{40})\trefs/heads/(${prefix.replaceAll("/", String.raw`\/`)}[1-9]\d*)$`, "u");
  const refs = text.split("\n").filter(Boolean).map((line) => {
    const match = pattern.exec(line);
    if (!match) invalid(line);
    return { sha: match[1], branch: match[2] };
  });
  if (new Set(refs.map(({ branch }) => branch)).size !== refs.length) invalid("duplicate refs");
  return refs;
}

export function parsePrefixedBranches(text, prefix, invalid) {
  return parsePrefixedRefs(text, prefix, invalid).map(({ branch }) => branch);
}

/** 이 workflow의 같은 저장소 PR을 브랜치별로 모은다. 상태가 잘못됐거나 브랜치가 겹치면 duplicate()를 부른다. */
export function ownPullRequestsByBranch(pullRequests, prefix, repository, duplicate) {
  const byBranch = new Map();
  for (const item of pullRequests) {
    if (typeof item?.headRefName !== "string" || !item.headRefName.startsWith(prefix)
      || item.baseRefName !== "main" || item.isCrossRepository !== false || item.headRepository?.nameWithOwner !== repository) continue;
    if (!["OPEN", "CLOSED", "MERGED"].includes(item.state) || !Number.isSafeInteger(item.number) || byBranch.has(item.headRefName)) duplicate(item.headRefName);
    byBranch.set(item.headRefName, item);
  }
  return byBranch;
}

/** 원장 파일을 쓰는 다른 자동화 workflow의 열린 PR 번호(오름차순). 후보 갱신·사람 PR·다른 저장소 PR은 보지 않는다. */
export function pendingLedgerWriterPullRequests(pullRequests, repository, exceptWorkflow = null) {
  const prefixes = LEDGER_WRITER_WORKFLOWS.filter((workflow) => workflow !== exceptWorkflow).map((workflow) => REFRESH_CLAIM_PREFIXES[workflow]);
  return pullRequests
    .filter((item) => item?.state === "OPEN" && item.baseRefName === "main" && item.isCrossRepository === false
      && item.headRepository?.nameWithOwner === repository && typeof item.headRefName === "string"
      && prefixes.some((prefix) => item.headRefName.startsWith(prefix)))
    .map(({ number }) => number).sort((left, right) => left - right);
}

const AUTOMATION_BRANCH_REF = /^[0-9a-f]{40}\trefs\/heads\/(automation\/[A-Za-z0-9._-]+)$/u;

/** git ls-remote --heads "refs/heads/automation/*" 출력에서 브랜치 이름을 읽는다. 형식이 어긋나거나 중복이면 실패한다. */
export function parseAutomationBranches(text) {
  const invalid = (detail) => { throw new Error(`AUTOMATION_BRANCH_LIST_INVALID: ${detail}`); };
  if (typeof text !== "string") invalid("listing is not text");
  const branches = text.split("\n").filter(Boolean).map((line) => {
    const match = AUTOMATION_BRANCH_REF.exec(line);
    if (!match) invalid(line);
    return match[1];
  });
  if (new Set(branches).size !== branches.length) invalid("duplicate refs");
  return branches;
}

const byText = (left, right) => (left < right ? -1 : Number(left > right));
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const inputInvalid = (detail = "") => { throw new Error(detail ? `AUTOMATION_PR_STATE_INPUT_INVALID: ${detail}` : "AUTOMATION_PR_STATE_INPUT_INVALID"); };

/**
 * 원장을 쓰는 다른 자동화 workflow의 진행 중인 일(#974 리뷰 F2, #975 리뷰 F6).
 * 열린 PR뿐 아니라 PR이 열리기 전의 claim 브랜치(OCI 게시 중)와 닫힌 PR에 남은 브랜치도 진행 흔적이다. 병합된 PR의 브랜치는 끝난 일이다.
 * PR 없는 claim이 만든 run이 실패해 고아가 된 경우에도 여기서는 진행 중으로 본다(기다린다). 그 claim은 소유 workflow가 만든 run과 게시 증거로
 * 판정해 복구하거나 보고(#926)한 뒤 지운다(claim-orphans.mjs, remove-orphan-claims.mjs, #995). 대기는 소유 workflow의 다음 정기 실행까지다.
 *
 * #1032: 소유 workflow가 스스로 풀 수 없는 상태(게시 뒤 실패해 사람 확인을 기다리는 claim, 재생성 상한에 걸린 PR)는 이 기다림을 영구히 만든다.
 * maxAgeMs를 주면 브랜치 마지막 커밋이 그보다 오래된 대상은 기다리지 않고 expired로 따로 알린다(상한과 같은 나이는 기다린다).
 * 나이를 알 수 없는 대상(branchTimes에 시각이 없다)과 미래 시각은 증거가 없으므로 기다린다. 잘못된 시각 문자열은 실패한다.
 * maxAgeMs를 주지 않으면 지금까지처럼 모두 기다리고 expired 항목 자체가 없다.
 * @param {object} [options.branchTimes] 브랜치 이름 -> 마지막 커밋 시각(ISO). maxAgeMs와 now가 있을 때만 쓴다.
 * @returns {{ pullRequests: number[], branches: string[], expired?: { blocker: number|string, branch: string, ageMs: number }[] }}
 *   열린 PR 번호(오름차순), 열린 PR이 없는 claim 브랜치 이름(오름차순), (상한을 준 경우) 기다리지 않은 대상(PR 번호 오름차순, 그 다음 브랜치 이름 오름차순)
 */
export function pendingLedgerWriters({ pullRequests, automationBranches, repository, exceptWorkflow = null, maxAgeMs, now, branchTimes } = {}) {
  if (!Array.isArray(pullRequests) || !Array.isArray(automationBranches) || !validRepository(repository)
    || !(exceptWorkflow === null || Object.hasOwn(REFRESH_CLAIM_PREFIXES, exceptWorkflow))) inputInvalid();
  const limited = maxAgeMs !== undefined || now !== undefined || branchTimes !== undefined;
  if (limited && (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0 || !(now instanceof Date) || Number.isNaN(now.getTime()) || !isObject(branchTimes))) inputInvalid("wait limit");
  const prefixes = LEDGER_WRITER_WORKFLOWS.filter((workflow) => workflow !== exceptWorkflow).map((workflow) => REFRESH_CLAIM_PREFIXES[workflow]);
  const ownedBy = (item) => item?.baseRefName === "main" && item.isCrossRepository === false && item.headRepository?.nameWithOwner === repository
    && typeof item.headRefName === "string" && prefixes.some((prefix) => item.headRefName.startsWith(prefix));
  const owned = pullRequests.filter(ownedBy);
  const open = owned.filter(({ state }) => state === "OPEN");
  const openBranches = new Set(open.map(({ headRefName }) => headRefName));
  const merged = new Set(owned.filter(({ state }) => state === "MERGED").map(({ headRefName }) => headRefName));
  const branches = automationBranches.filter((branch) => prefixes.some((prefix) => branch.startsWith(prefix)) && !openBranches.has(branch) && !merged.has(branch));
  const pending = [
    ...open.map(({ number, headRefName }) => ({ blocker: number, branch: headRefName })).sort((left, right) => left.blocker - right.blocker),
    ...[...branches].sort(byText).map((branch) => ({ blocker: branch, branch })),
  ];
  if (!limited) {
    return { pullRequests: pending.filter(({ blocker }) => typeof blocker === "number").map(({ blocker }) => blocker), branches: pending.filter(({ blocker }) => typeof blocker === "string").map(({ blocker }) => blocker) };
  }
  const live = [];
  const expired = [];
  for (const entry of pending) {
    const recorded = branchTimes[entry.branch];
    const committedAt = recorded === undefined || recorded === null ? null : Date.parse(recorded);
    if (committedAt !== null && (typeof recorded !== "string" || !Number.isFinite(committedAt))) inputInvalid(`branch time of ${entry.branch}`);
    const ageMs = committedAt === null ? null : now.getTime() - committedAt;
    if (ageMs !== null && ageMs > maxAgeMs) expired.push({ ...entry, ageMs });
    else live.push(entry);
  }
  return {
    pullRequests: live.filter(({ blocker }) => typeof blocker === "number").map(({ blocker }) => blocker),
    branches: live.filter(({ blocker }) => typeof blocker === "string").map(({ blocker }) => blocker),
    expired,
  };
}

const AUTOMATION_BRANCH_NAME = /^automation\/[A-Za-z0-9._-]+$/u;

async function defaultRunGit(args) {
  const { stdout } = await execFileAsync(GIT_EXECUTABLE, args, { maxBuffer: 1024 * 1024 });
  return stdout;
}

/**
 * 자동화 브랜치의 마지막 커밋 시각을 로컬 checkout의 origin ref에서 읽는다(대기 상한 판정의 근거). 브랜치 이름 -> UTC ISO.
 * 로컬에 없는 ref(checkout 뒤에 새로 만들어진 브랜치)는 결과에 넣지 않는다: 나이를 모르는 대상은 기다린다. git 오류는 모른다고 덮지 않고 그대로 던진다.
 */
export async function branchCommitTimes({ branches, runGit = defaultRunGit } = {}) {
  if (!Array.isArray(branches) || branches.some((branch) => typeof branch !== "string" || !AUTOMATION_BRANCH_NAME.test(branch))) inputInvalid("branch names");
  const lines = await Promise.all(branches.map(async (branch) => (await runGit(["for-each-ref", "--format=%(committerdate:iso-strict)", `refs/remotes/origin/${branch}`])).trim()));
  const times = {};
  branches.forEach((branch, index) => {
    if (lines[index] === "") return;
    const committedAt = Date.parse(lines[index]);
    if (!Number.isFinite(committedAt)) inputInvalid(`commit time of ${branch}`);
    times[branch] = new Date(committedAt).toISOString();
  });
  return times;
}

/**
 * 대기 상한을 적용하기 전에 기다릴 후보인 브랜치 이름(열린 PR의 head, PR 없는 claim)을 정렬 없이 모은다. 이 브랜치들의 커밋 시각만 읽으면 된다.
 */
export function pendingLedgerWriterBranches({ pullRequests, automationBranches, repository, exceptWorkflow = null } = {}) {
  const strict = pendingLedgerWriters({ pullRequests, automationBranches, repository, exceptWorkflow });
  const numbers = new Set(strict.pullRequests);
  const heads = pullRequests.filter((item) => item?.state === "OPEN" && numbers.has(item.number) && typeof item.headRefName === "string").map(({ headRefName }) => headRefName);
  return [...new Set([...heads, ...strict.branches])];
}

/**
 * gh run list 결과에서 아직 끝나지 않은 run만 고른다(#987 리뷰 F1). 정기 workflow의 run 이력은 계속 쌓이므로(하루 12번)
 * 목록 상한은 끝나지 않은 run에만 적용한다. 끝난 run은 판정에 필요 없거나(없는 run과 같은 처리) run id로 직접 조회한다.
 */
export function activeRuns(runs) {
  return runs.filter((item) => item?.status !== "completed");
}
