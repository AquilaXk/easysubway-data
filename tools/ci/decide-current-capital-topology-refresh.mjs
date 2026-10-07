#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { requiresCurrentCapitalTopologyAdmission } from "../datapack/rebind-capital-route-map-admissions.mjs";
import { planUnboundClaims } from "./claim-orphans.mjs";

const WORKFLOW = "current-capital-topology-refresh.yml";

const BRANCH = /^automation\/636-current-topology-refresh-[0-9]+$/u;
const SHA = /^[0-9a-f]{40}$/u;
const SUBJECTS = ["Claim current topology refresh", "Register current topology inputs", "Activate current topology inputs"];
const INCHEON = new Map([["incheon-transit-station-info", "topologyAdmissionEvidence"], ["incheon-line1-train-timetable", "scheduleAdmissionEvidence"], ["incheon-line2-train-timetable", "scheduleAdmissionEvidence"]]);

function object(value, label) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`); return value; }
function json(bytes, label) { try { return JSON.parse(bytes); } catch { throw new Error(`${label} is invalid JSON`); } }
function instant(value, label) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?(Z|[+-]\d{2}:\d{2})$/u.exec(value ?? "");
  const parts = match?.slice(1, 8).map((part) => Number(part ?? 0));
  const offset = match?.[8];
  const offsetParts = offset && offset !== "Z" ? offset.slice(1).split(":").map(Number) : [0, 0];
  const parsed = Date.parse(value);
  const local = parts ? new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5], parts[6])) : null;
  if (!match || !Number.isFinite(parsed) || offsetParts[0] > 23 || offsetParts[1] > 59
    || local.getUTCFullYear() !== parts[0] || local.getUTCMonth() + 1 !== parts[1]
    || local.getUTCDate() !== parts[2] || local.getUTCHours() !== parts[3]
    || local.getUTCMinutes() !== parts[4] || local.getUTCSeconds() !== parts[5]) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}
function duration(value) { const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/u.exec(value ?? ""); if (!match || match.slice(1).every((item) => item === undefined)) throw new Error("freshness alert threshold is invalid"); const milliseconds = (Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)) * 1000; if (milliseconds < 1) throw new Error("freshness alert threshold is invalid"); return milliseconds; }
function currentExpiry(inventory, itxExpiry) { const sources = object(inventory, "source inventory").sources; if (!Array.isArray(sources)) throw new Error("source inventory is invalid"); const capital = sources.filter((source) => requiresCurrentCapitalTopologyAdmission(object(source, "source inventory source"))); if (capital.length !== 16 || new Set(capital.map(({ id }) => id)).size !== 16) throw new Error("capital current topology admissions must contain exactly sixteen unique sources"); const expiry = capital.map((source) => instant(source.routeMapAdmissionEvidence?.currentTopologyAdmission?.freshUntil, `${source.id} current topology freshUntil`)); for (const [id, evidence] of INCHEON) { const matches = sources.filter((source) => source.id === id); if (matches.length !== 1) throw new Error(`${id} source identity is invalid`); expiry.push(instant(matches[0][evidence]?.freshUntil, `${id} freshUntil`)); } expiry.push(itxExpiry); return Math.min(...expiry); }

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function repositoryFile(repositoryRoot, relative, label) { if (typeof relative !== "string" || path.posix.isAbsolute(relative) || relative.includes("\\") || relative.split("/").some((part) => part === "" || part === "." || part === "..")) throw new Error(`${label} path is invalid`); const root = path.resolve(repositoryRoot); const resolved = path.resolve(root, relative); if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error(`${label} path is invalid`); return resolved; }
async function currentItxFreshness(candidate, repositoryRoot) {
  object(candidate, "candidate build spec");
  if (!/^tools\/datapack\/itx-cheongchun-topology-evidence(?:-[0-9]{17})?\.json$/u
    .test(candidate.itxTopologyEvidencePath ?? "")) {
    throw new Error("candidate ITX topology evidence path is invalid");
  }
  if (!/^[a-f0-9]{64}$/u.test(candidate.itxTopologyEvidenceSha256 ?? "")) {
    throw new Error("candidate ITX topology evidence binding is invalid");
  }
  const evidenceBytes = await readFile(repositoryFile(
    repositoryRoot,
    candidate.itxTopologyEvidencePath,
    "candidate ITX topology evidence",
  ));
  if (sha256(evidenceBytes) !== candidate.itxTopologyEvidenceSha256) {
    throw new Error("candidate ITX topology evidence bytes mismatch");
  }
  const evidence = object(
    json(evidenceBytes, "candidate ITX topology evidence"),
    "candidate ITX topology evidence",
  );
  if (evidence.artifactKind !== "itx-cheongchun-mobile-topology-evidence") {
    throw new Error("candidate ITX topology evidence identity is invalid");
  }
  const freshUntil = evidence.sourceArtifact?.freshUntil;
  const reusableExpiry = instant(freshUntil, "candidate ITX topology evidence freshUntil");
  const binding = candidate.networkEdgeEvidence?.itxCurrentTopologyAdmission;
  if (binding == null) return { freshUntil, reusableExpiry, selectedExpiry: reusableExpiry };
  object(binding, "ITX current topology admission binding");
  if (!/^tools\/datapack\/itx-current-network-edge-admission-[0-9]{8}\.json$/u
    .test(binding.path ?? "") || !/^[a-f0-9]{64}$/u.test(binding.sha256 ?? "")) {
    throw new Error("ITX current topology admission binding is invalid");
  }
  const admissionBytes = await readFile(repositoryFile(
    repositoryRoot,
    binding.path,
    "ITX current topology admission",
  ));
  if (sha256(admissionBytes) !== binding.sha256) {
    throw new Error("ITX current topology admission bytes mismatch");
  }
  const admission = object(
    json(admissionBytes, "ITX current topology admission"),
    "ITX current topology admission",
  );
  if (admission.artifactKind !== "itx-current-network-edge-admission"
    || admission.status !== "ADMITTED"
    || binding.path !== `tools/datapack/${admission.artifactId}.json`) {
    throw new Error("ITX current topology admission identity is invalid");
  }
  return {
    freshUntil,
    reusableExpiry,
    selectedExpiry: instant(admission.freshUntil, "ITX current topology admission freshUntil"),
  };
}
function ownedPrs(value, repository) { if (!Array.isArray(value) || !/^[^/\s]+\/[^/\s]+$/u.test(repository ?? "")) throw new Error("pull requests are invalid"); return value.filter((pr) => { object(pr, "pull request"); if (!BRANCH.test(pr.headRefName ?? "")) return false; if (pr.baseRefName !== "main" || pr.isCrossRepository !== false || pr.headRepository?.nameWithOwner !== repository || !["OPEN", "CLOSED", "MERGED"].includes(pr.state) || typeof pr.isDraft !== "boolean") throw new Error("current topology refresh pull request is invalid"); return true; }); }
function claimEvidence(value, currentMainSha) { if (!Array.isArray(value) || !SHA.test(currentMainSha ?? "")) throw new Error("current topology refresh claim evidence is invalid"); const claims = value.map((claim) => { object(claim, "current topology refresh claim"); const { ref, headSha, mergeBaseSha, commitCount, subjects } = claim; if (typeof ref !== "string" || !ref.startsWith("refs/heads/") || !BRANCH.test(ref.slice("refs/heads/".length)) || !SHA.test(headSha ?? "") || !SHA.test(mergeBaseSha ?? "") || !Number.isInteger(commitCount) || commitCount < 0 || !Array.isArray(subjects) || subjects.some((subject) => typeof subject !== "string")) throw new Error("current topology refresh claim is invalid"); return { branch: ref.slice("refs/heads/".length), ref, headSha, mergeBaseSha, commitCount, subjects }; }); if (new Set(claims.map(({ ref }) => ref)).size !== claims.length) throw new Error("duplicate current topology refresh claims exist"); return claims.map((claim) => ({ ...claim, current: claim.mergeBaseSha === currentMainSha })); }
function expectedClaimSubjects(claim) {
  if (!claim.current) return null;
  if (claim.commitCount === 1) return SUBJECTS.slice(0, 1);
  if (claim.commitCount === 3) return SUBJECTS;
  throw new Error("current-main topology refresh claim is incomplete");
}
function validateClaimOwner(claim, prs) {
  const associated = prs.filter(({ headRefName }) => headRefName === claim.branch);
  if (associated.length > 1) throw new Error("duplicate current topology refresh owners exist");
  if (associated[0]?.state === "CLOSED") throw new Error("closed current topology refresh claim requires manual resolution");
  const expected = expectedClaimSubjects(claim);
  if (expected && (claim.subjects.length !== expected.length
    || claim.subjects.some((subject, index) => subject !== expected[index]))) {
    throw new Error("current-main topology refresh claim is incomplete");
  }
}
function openTopologyRefreshPrs(prs, claims) {
  if (new Set(prs.map(({ headRefName }) => headRefName)).size !== prs.length) throw new Error("duplicate current topology refresh owners exist");
  const open = prs.filter(({ state }) => state === "OPEN");
  if (open.length > 1) throw new Error("duplicate current topology refresh owners exist");
  for (const claim of claims) validateClaimOwner(claim, prs);
  return open;
}
function availableTopologyRefreshClaims(prs, claims) {
  const available = claims.filter((claim) => claim.current
    && !prs.some(({ headRefName }) => headRefName === claim.branch));
  if (available.length > 1) throw new Error("duplicate current topology refresh claims exist");
  return available;
}

export function currentCapitalTopologyPreflight({ now = new Date(), jobWindowMinutes = 45, existingPaths = [], itxRefreshRequired = true } = {}) { const start = now instanceof Date ? now.getTime() : NaN; if (!Number.isFinite(start) || !Number.isInteger(jobWindowMinutes) || jobWindowMinutes < 1 || !Array.isArray(existingPaths) || existingPaths.some((item) => typeof item !== "string") || typeof itxRefreshRequired !== "boolean") throw new Error("current topology preflight is invalid"); const dates = new Set(); for (let point = start; point <= start + jobWindowMinutes * 60_000; point += 60_000) { const date = new Date(point); dates.add(date.toISOString().slice(0, 10).replaceAll("-", "")); dates.add(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date).filter(({ type }) => type !== "literal").map(({ value }) => value).join("")); } const candidates = [...dates].flatMap((stamp) => [`tools/datapack/sources/capital-route-topology-${stamp}.json`, `tools/datapack/sources/incheon-transit-station-info-${stamp}.json`, `tools/datapack/sources/incheon-line1-train-timetable-${stamp}.json`, `tools/datapack/sources/incheon-line2-train-timetable-${stamp}.json`, ...(itxRefreshRequired ? [`tools/datapack/itx-current-network-edge-admission-${stamp}.json`] : []), `tools/datapack/release/capital-topology-reverification-${stamp}.json`]); const conflicts = candidates.filter((candidate) => existingPaths.includes(candidate)); return { state: conflicts.length ? "WAIT_IMMUTABLE_IDENTITY" : "CLEAR", conflicts }; }

function dueStateOf(current, freshUntil, threshold) {
  if (current >= freshUntil) return "EXPIRED";
  return current >= freshUntil - threshold ? "DUE" : "NOT_DUE";
}
const byText = (left, right) => (left < right ? -1 : Number(left > right));
// #995: 도는 run의 claim은 판정 밖에서 기다린다. 나머지 claim 중 PR 없는 stale claim은 빈 claim이면 정리 대상이고 출력이 있으면 이상이다.
function settleTopologyClaims({ claims, prs, plan }) {
  const settled = claims.filter(({ branch }) => !plan.active.includes(branch));
  const open = openTopologyRefreshPrs(prs, settled);
  const stale = settled.filter((claim) => !claim.current && !prs.some(({ headRefName }) => headRefName === claim.branch));
  const carrying = stale.filter(({ branch }) => plan.recoverable.includes(branch));
  if (carrying.length > 0) throw new Error(`stale current topology refresh claim carries output: ${carrying.map(({ branch }) => branch).join(", ")}`);
  const available = availableTopologyRefreshClaims(prs, settled);
  if (plan.active.length + available.length > 1) throw new Error("duplicate current topology refresh claims exist");
  return { open, available, cleanupClaims: stale.map(({ branch }) => branch).sort(byText) };
}

export async function decideCurrentCapitalTopologyRefresh({ inventoryPath, candidatePath, policyPath, prsPath, claimsPath, claimEvidencePath, repositoryRoot = process.cwd(), repository, currentMainSha, now = new Date(), itxCollectedToday = false } = {}) {
  if (typeof itxCollectedToday !== "boolean") throw new Error("decision input is invalid");
  const [inventoryBytes, candidateBytes, policyBytes, prsBytes, claimsBytes, evidenceBytes] = await Promise.all([
    readFile(path.resolve(inventoryPath)), readFile(path.resolve(candidatePath)), readFile(path.resolve(policyPath)),
    readFile(path.resolve(prsPath)), readFile(path.resolve(claimsPath)), readFile(path.resolve(claimEvidencePath)),
  ]);
  const policy = object(json(policyBytes, "freshness policy"), "freshness policy");
  const alertBeforePackExpiry = policy.monitoring?.alertBeforePackExpiry;
  const threshold = duration(alertBeforePackExpiry);
  const itx = await currentItxFreshness(json(candidateBytes, "candidate build spec"), repositoryRoot);
  const freshUntil = currentExpiry(json(inventoryBytes, "source inventory"), itx.selectedExpiry);
  const current = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(current)) throw new Error("decision time is invalid");
  const component = { alertBeforePackExpiry, itxFreshUntil: itx.freshUntil, itxRefreshRequired: current >= itx.reusableExpiry - threshold };
  const prs = ownedPrs(json(prsBytes, "pull requests"), repository);
  const claims = claimEvidence(json(claimsBytes, "current topology refresh claims"), currentMainSha);
  // #995: PR 없는 claim은 만든 run과 게시 증거로 가른다. 도는 run의 claim은 기다리고(재사용·복구하지 않는다), main이 움직여 current가 아닌 claim은
  // 예전에는 어떤 판정도 보지 않아 다른 자동화를 영원히 막았다. 빈 claim뿐이면 정리 대상(보고 뒤 삭제)이고, 출력이 있으면 지우지 않고 이상으로 드러낸다.
  const plan = planUnboundClaims({
    workflowFile: WORKFLOW, repository, claimBranches: claims.map(({ branch }) => branch), pullRequests: prs, evidence: json(evidenceBytes, "claim evidence"),
  });
  const { open, available, cleanupClaims } = settleTopologyClaims({ claims, prs, plan });
  if (open.length === 1) return { state: "OPEN_PR", ...component, cleanupClaims };
  if (plan.active.length === 1) return { state: "CLAIM_IN_PROGRESS", ...component, branch: plan.active[0], cleanupClaims };
  if (available.length === 1) {
    const reuse = available[0].commitCount === 1;
    // REUSE_CLAIM은 ITX 공급자를 다시 부르는 경로다. 같은 KST 날 이미 수집했다면 대기한다(#977). RECOVER_CLAIM은 공급자를 부르지 않는다.
    if (reuse && itxCollectedToday && component.itxRefreshRequired) return { state: "WAIT_ITX_COLLECTED_TODAY", ...component, branch: available[0].branch, cleanupClaims };
    return { state: reuse ? "REUSE_CLAIM" : "RECOVER_CLAIM", ...component, branch: available[0].branch, cleanupClaims };
  }
  const state = dueStateOf(current, freshUntil, threshold);
  // 같은 KST 날 다른 workflow(ITX 승격·수동 수집)가 이미 ITX 공급자를 불렀고 이번 갱신도 ITX 수집을 요구하면, 오늘은 수집할 수 없다. 이상이 아니라 대기다(#977).
  if (itxCollectedToday && component.itxRefreshRequired && state !== "NOT_DUE") return { state: "WAIT_ITX_COLLECTED_TODAY", ...component, cleanupClaims };
  return { state, ...component, cleanupClaims };
}
export async function runCurrentCapitalTopologyRefreshDecision({ outputPath, githubOutputPath, ...input } = {}) { const result = await decideCurrentCapitalTopologyRefresh(input); await Promise.all([writeFile(path.resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" }), writeFile(path.resolve(githubOutputPath), `state=${result.state}\nbranch=${result.branch ?? ""}\ncleanup_claims=${result.cleanupClaims.join(",")}\nitx_fresh_until=${result.itxFreshUntil ?? ""}\nitx_refresh_required=${result.itxRefreshRequired ?? ""}\n`, { flag: "a" })]); return result; }
const ARGUMENT_NAMES = new Set(["inventory", "candidate", "policy", "prs", "claims", "claim-evidence", "repository", "current-main-sha", "output", "github-output", "itx-collected-today"]);
function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--") || result[key.slice(2)] !== undefined || !argv[i + 1]) throw new Error("decision arguments are invalid");
    result[key.slice(2)] = argv[i + 1];
  }
  if (Object.keys(result).some((key) => !ARGUMENT_NAMES.has(key))) throw new Error("decision arguments are invalid");
  return result;
}
// 생략하면 false, "true"·"false"만 받는다. 그 밖의 값은 undefined라 판정 입력 검증에서 실패한다.
const BOOLEAN_ARGUMENTS = new Map([["true", true], ["false", false]]);
const itxCollectedTodayArgument = (value) => (value === undefined ? false : BOOLEAN_ARGUMENTS.get(value));
if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    const value = args(process.argv.slice(2));
    await runCurrentCapitalTopologyRefreshDecision({
      inventoryPath: value.inventory, candidatePath: value.candidate, policyPath: value.policy, prsPath: value.prs, claimsPath: value.claims,
      claimEvidencePath: value["claim-evidence"], repository: value.repository, currentMainSha: value["current-main-sha"],
      outputPath: value.output, githubOutputPath: value["github-output"], itxCollectedToday: itxCollectedTodayArgument(value["itx-collected-today"]),
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
