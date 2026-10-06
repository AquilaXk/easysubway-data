// 자동화 PR 상태 판정의 공통 부분(#969). 등록·재확인·파생 재결속 판정이 같은 규칙으로 열린 PR·남은 브랜치·원장 쓰기 PR을 본다.
import { LEDGER_WRITER_WORKFLOWS, REFRESH_CLAIM_PREFIXES } from "./refresh-open-pr-age.mjs";

const REPOSITORY = /^[^/\s]+\/[^/\s]+$/u;

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

/**
 * 원장을 쓰는 다른 자동화 workflow의 진행 중인 일(#974 리뷰 F2, #975 리뷰 F6).
 * 열린 PR뿐 아니라 PR이 열리기 전의 claim 브랜치(OCI 게시 중)와 닫힌 PR에 남은 브랜치도 진행 흔적이다. 병합된 PR의 브랜치는 끝난 일이다.
 * @returns {{ pullRequests: number[], branches: string[] }} 열린 PR 번호(오름차순)와 열린 PR이 없는 claim 브랜치 이름(오름차순)
 */
export function pendingLedgerWriters({ pullRequests, automationBranches, repository, exceptWorkflow = null } = {}) {
  if (!Array.isArray(pullRequests) || !Array.isArray(automationBranches) || !validRepository(repository)
    || !(exceptWorkflow === null || Object.hasOwn(REFRESH_CLAIM_PREFIXES, exceptWorkflow))) throw new Error("AUTOMATION_PR_STATE_INPUT_INVALID");
  const prefixes = LEDGER_WRITER_WORKFLOWS.filter((workflow) => workflow !== exceptWorkflow).map((workflow) => REFRESH_CLAIM_PREFIXES[workflow]);
  const ownedBy = (item) => item?.baseRefName === "main" && item.isCrossRepository === false && item.headRepository?.nameWithOwner === repository
    && typeof item.headRefName === "string" && prefixes.some((prefix) => item.headRefName.startsWith(prefix));
  const owned = pullRequests.filter(ownedBy);
  const open = owned.filter(({ state }) => state === "OPEN");
  const openBranches = new Set(open.map(({ headRefName }) => headRefName));
  const merged = new Set(owned.filter(({ state }) => state === "MERGED").map(({ headRefName }) => headRefName));
  const branches = automationBranches.filter((branch) => prefixes.some((prefix) => branch.startsWith(prefix)) && !openBranches.has(branch) && !merged.has(branch));
  return { pullRequests: open.map(({ number }) => number).sort((left, right) => left - right), branches: [...branches].sort() };
}
