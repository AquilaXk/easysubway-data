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
 * Classifies due state against only same-repository PRs in the exact claim
 * namespace. CURRENT deliberately returns before any claim/PR interpretation.
 */
export function classifyRetainedGwangjuRefreshDelivery({ decision, repository, claims, pullRequests } = {}) {
  if (decision?.state === "CURRENT") return { state: "CURRENT" };
  if (decision?.state !== "DUE") throw new Error("retained Gwangju refresh due decision is invalid");
  if (typeof repository !== "string" || !/^[^/\s]+\/[^/\s]+$/u.test(repository)
    || !Array.isArray(claims) || !Array.isArray(pullRequests)) {
    throw new Error("retained Gwangju refresh delivery input is invalid");
  }
  const byBranch = new Map();
  for (const pullRequest of pullRequests) {
    if (!pullRequest || typeof pullRequest !== "object") throw new Error("retained Gwangju refresh PR is invalid");
    if (!BRANCH.test(pullRequest.headRefName) || pullRequest.baseRefName !== "main"
      || pullRequest.isCrossRepository !== false || pullRequest.headRepository?.nameWithOwner !== repository) continue;
    if (!['OPEN', 'CLOSED', 'MERGED'].includes(pullRequest.state) || typeof pullRequest.isDraft !== "boolean"
      || byBranch.has(pullRequest.headRefName)) throw new Error("retained Gwangju refresh PR is invalid");
    byBranch.set(pullRequest.headRefName, pullRequest);
  }
  const claimBranches = new Set();
  for (const claim of claims) {
    if (!claim || typeof claim.sha !== "string" || !/^[a-f0-9]{40}$/u.test(claim.sha)
      || !BRANCH.test(claim.branch) || claimBranches.has(claim.branch)) {
      throw new Error("retained Gwangju refresh claim is invalid");
    }
    claimBranches.add(claim.branch);
  }
  const live = claims.filter(({ branch }) => byBranch.get(branch)?.state !== "MERGED");
  if (live.length > 1) throw new Error("retained Gwangju refresh has multiple live claims");
  const open = [...byBranch.values()].filter(({ state }) => state === "OPEN");
  if (open.length > 1) throw new Error("retained Gwangju refresh has multiple open PRs");
  if (open.length === 1) {
    if (live.some(({ branch }) => branch !== open[0].headRefName)) {
      throw new Error("retained Gwangju refresh has multiple live claims");
    }
    return { state: "OPEN_PR", branch: open[0].headRefName };
  }
  if (live.length === 1) {
    const associated = byBranch.get(live[0].branch);
    if (associated?.state === "CLOSED") throw new Error("retained Gwangju refresh has a closed live claim");
    if (associated?.state === "OPEN") return { state: "OPEN_PR", branch: live[0].branch };
    return { state: "RECOVER_CLAIM", branch: live[0].branch };
  }
  return { state: "DUE" };
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
