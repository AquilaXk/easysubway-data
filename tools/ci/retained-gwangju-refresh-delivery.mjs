import { planUnboundClaims } from "./claim-orphans.mjs";

const WORKFLOW = "retained-gwangju-timetable-refresh.yml";
const BRANCH = /^automation\/504-retained-gwangju-timetable-refresh-\d+$/u;
const REF = /^[a-f0-9]{40}\trefs\/heads\/(automation\/504-retained-gwangju-timetable-refresh-\d+)$/u;
const OUTPUTS = Object.freeze([
  "tools/datapack/source-inventory.json",
  "tools/datapack/release/source-snapshots.json",
]);

/** Parses only the retained-Gwangju automation namespace from ls-remote output. */
export function parseRetainedGwangjuRefreshClaims(text) {
  if (typeof text !== "string") throw new Error("retained Gwangju refresh claims are invalid");
  const claims = text.split("\n").filter(Boolean).map((line) => {
    const match = REF.exec(line);
    if (!match) throw new Error("retained Gwangju refresh claim is invalid");
    return { sha: line.slice(0, 40), branch: match[1] };
  });
  if (new Set(claims.map(({ branch }) => branch)).size !== claims.length) {
    throw new Error("retained Gwangju refresh has duplicate claim refs");
  }
  return claims;
}

/**
 * Classifies the delivery state against only same-repository PRs in the exact claim namespace.
 * Claims are interpreted whether the source is DUE or CURRENT (#995): a CURRENT source used to return before any claim
 * was read, so an orphan claim from a failed run stayed forever and blocked every other ledger writer.
 * A claim without any PR is classified by its producer run and publication evidence (claim-orphans.mjs):
 * a running producer waits, a claim that carries output is recovered, and an empty claim of a finished run is handed to
 * cleanup (reported, then removed) while the normal due state continues.
 * @returns {{ state: "CURRENT"|"DUE"|"OPEN_PR"|"RECOVER_CLAIM"|"CLAIM_IN_PROGRESS", branch?: string, cleanupClaims: string[] }}
 */
export function classifyRetainedGwangjuRefreshDelivery({ decision, repository, claims, pullRequests, claimEvidence } = {}) {
  if (decision?.state !== "CURRENT" && decision?.state !== "DUE") throw new Error("retained Gwangju refresh due decision is invalid");
  if (typeof repository !== "string" || !/^[^/\s]+\/[^/\s]+$/u.test(repository)
    || !Array.isArray(claims) || !Array.isArray(pullRequests) || !Array.isArray(claimEvidence)) {
    throw new Error("retained Gwangju refresh delivery input is invalid");
  }
  const byBranch = indexRefreshPullRequests(pullRequests, repository);
  validateRefreshClaims(claims);
  const plan = planUnboundClaims({
    workflowFile: WORKFLOW, repository, claimBranches: claims.map(({ branch }) => branch), pullRequests, evidence: claimEvidence,
  });
  const cleanupClaims = plan.abandoned;
  const live = claims.filter(({ branch }) => byBranch.get(branch)?.state !== "MERGED" && !cleanupClaims.includes(branch));
  if (live.length > 1) throw new Error("retained Gwangju refresh has multiple live claims");
  const open = [...byBranch.values()].filter(({ state }) => state === "OPEN");
  if (open.length > 1) throw new Error("retained Gwangju refresh has multiple open PRs");
  if (open.length === 1) {
    if (live.some(({ branch }) => branch !== open[0].headRefName)) {
      throw new Error("retained Gwangju refresh has multiple live claims");
    }
    return { state: "OPEN_PR", branch: open[0].headRefName, cleanupClaims };
  }
  if (live.length === 1) {
    const [{ branch }] = live;
    if (byBranch.get(branch)?.state === "CLOSED") throw new Error("retained Gwangju refresh has a closed live claim");
    return { state: plan.active.includes(branch) ? "CLAIM_IN_PROGRESS" : "RECOVER_CLAIM", branch, cleanupClaims };
  }
  return { state: decision.state, cleanupClaims };
}

/** Recovery may create a PR only when the exact claim has no same-repository PR. */
export function assertRetainedGwangjuRecoveryPullRequestAbsent({ repository, branch, pullRequests } = {}) {
  if (typeof repository !== "string" || !/^[^/\s]+\/[^/\s]+$/u.test(repository)
    || !BRANCH.test(branch) || !Array.isArray(pullRequests)) {
    throw new Error("retained Gwangju refresh recovery PR input is invalid");
  }
  if (indexRefreshPullRequests(pullRequests, repository).has(branch)) {
    throw new Error("retained timetable claim already has a pull request");
  }
}

// 같은 저장소의 갱신 PR만 연결하고, 판단 전에 중복·형식을 검증한다.
function indexRefreshPullRequests(pullRequests, repository) {
  const byBranch = new Map();
  for (const pullRequest of pullRequests) {
    if (!pullRequest || typeof pullRequest !== "object") throw new Error("retained Gwangju refresh PR is invalid");
    if (!BRANCH.test(pullRequest.headRefName) || pullRequest.baseRefName !== "main"
      || pullRequest.isCrossRepository !== false || pullRequest.headRepository?.nameWithOwner !== repository) continue;
    if (!['OPEN', 'CLOSED', 'MERGED'].includes(pullRequest.state) || typeof pullRequest.isDraft !== "boolean"
      || byBranch.has(pullRequest.headRefName)) throw new Error("retained Gwangju refresh PR is invalid");
    byBranch.set(pullRequest.headRefName, pullRequest);
  }
  return byBranch;
}

function validateRefreshClaims(claims) {
  const claimBranches = new Set();
  for (const claim of claims) {
    if (!claim || typeof claim.sha !== "string" || !/^[a-f0-9]{40}$/u.test(claim.sha)
      || !BRANCH.test(claim.branch) || claimBranches.has(claim.branch)) {
      throw new Error("retained Gwangju refresh claim is invalid");
    }
    claimBranches.add(claim.branch);
  }
}

/** Verifies the only tracked files a successful retained registration may change. */
export function validateRetainedGwangjuRefreshOutputPaths({ changedPaths, deletedPaths } = {}) {
  if (!Array.isArray(changedPaths) || !Array.isArray(deletedPaths)) {
    throw new Error("retained Gwangju refresh output paths are invalid");
  }
  if (deletedPaths.length !== 0) throw new Error("retained Gwangju refresh output contains a deletion");
  if (changedPaths.length !== OUTPUTS.length) throw new Error("retained Gwangju refresh output must change exactly two paths");
  const changed = new Set(changedPaths);
  if (changed.size !== changedPaths.length || OUTPUTS.some((entry) => !changed.has(entry))) {
    throw new Error("retained Gwangju refresh output changed an unsupported path");
  }
  return [...OUTPUTS];
}
