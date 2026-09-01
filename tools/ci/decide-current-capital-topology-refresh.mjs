#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { requiresCurrentCapitalTopologyAdmission } from "../datapack/rebind-capital-route-map-admissions.mjs";

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

export async function decideCurrentCapitalTopologyRefresh({ inventoryPath, candidatePath, policyPath, prsPath, claimsPath, repositoryRoot = process.cwd(), repository, currentMainSha, now = new Date() } = {}) {
  const [inventoryBytes, candidateBytes, policyBytes, prsBytes, claimsBytes] = await Promise.all([
    readFile(path.resolve(inventoryPath)), readFile(path.resolve(candidatePath)), readFile(path.resolve(policyPath)),
    readFile(path.resolve(prsPath)), readFile(path.resolve(claimsPath)),
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
  const open = openTopologyRefreshPrs(prs, claims);
  if (open.length === 1) return { state: "OPEN_PR", ...component };
  const available = availableTopologyRefreshClaims(prs, claims);
  if (available.length === 1) {
    return { state: available[0].commitCount === 1 ? "REUSE_CLAIM" : "RECOVER_CLAIM", ...component, branch: available[0].branch };
  }
  if (current >= freshUntil) return { state: "EXPIRED", ...component };
  return { state: current >= freshUntil - threshold ? "DUE" : "NOT_DUE", ...component };
}
export async function runCurrentCapitalTopologyRefreshDecision({ outputPath, githubOutputPath, ...input } = {}) { const result = await decideCurrentCapitalTopologyRefresh(input); await Promise.all([writeFile(path.resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" }), writeFile(path.resolve(githubOutputPath), `state=${result.state}\nbranch=${result.branch ?? ""}\nitx_fresh_until=${result.itxFreshUntil}\nitx_refresh_required=${result.itxRefreshRequired}\n`, { flag: "a" })]); return result; }
function args(argv) { const result = {}; for (let i = 0; i < argv.length; i += 2) { const key = argv[i]; if (!key?.startsWith("--") || result[key.slice(2)] !== undefined || !argv[i + 1]) throw new Error("decision arguments are invalid"); result[key.slice(2)] = argv[i + 1]; } if (Object.keys(result).some((key) => !["inventory", "candidate", "policy", "prs", "claims", "repository", "current-main-sha", "output", "github-output"].includes(key))) throw new Error("decision arguments are invalid"); return result; }
if (process.argv[1] === new URL(import.meta.url).pathname) { const value = args(process.argv.slice(2)); runCurrentCapitalTopologyRefreshDecision({ inventoryPath: value.inventory, candidatePath: value.candidate, policyPath: value.policy, prsPath: value.prs, claimsPath: value.claims, repository: value.repository, currentMainSha: value["current-main-sha"], outputPath: value.output, githubOutputPath: value["github-output"] }).catch((error) => { console.error(error.message); process.exitCode = 1; }); }
