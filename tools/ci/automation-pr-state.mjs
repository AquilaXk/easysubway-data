// 자동화 PR 상태 판정의 공통 부분(#969). 등록·재확인·파생 재결속 판정이 같은 규칙으로 열린 PR·남은 브랜치·원장 쓰기 PR을 본다.
import { LEDGER_WRITER_WORKFLOWS, REFRESH_CLAIM_PREFIXES } from "./refresh-open-pr-age.mjs";

const REPOSITORY = /^[^/\s]+\/[^/\s]+$/u;

export function validRepository(value) {
  return typeof value === "string" && REPOSITORY.test(value);
}

/** git ls-remote --heads 출력에서 접두어 브랜치만 읽는다. 다른 형식이 섞이거나 중복이면 invalid()를 부른다. */
export function parsePrefixedBranches(text, prefix, invalid) {
  if (typeof text !== "string") invalid("listing is not text");
  const pattern = new RegExp(`^[0-9a-f]{40}\\trefs/heads/(${prefix.replaceAll("/", "\\/")}[1-9][0-9]*)$`, "u");
  const branches = text.split("\n").filter(Boolean).map((line) => {
    const match = pattern.exec(line);
    if (!match) invalid(line);
    return match[1];
  });
  if (new Set(branches).size !== branches.length) invalid("duplicate refs");
  return branches;
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
