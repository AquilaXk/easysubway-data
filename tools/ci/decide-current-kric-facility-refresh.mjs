#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { parsePrefixedRefs } from "./automation-pr-state.mjs";
import { CLAIM_OWNERS, planUnboundClaims } from "./claim-orphans.mjs";

const WORKFLOW = "kric-current-facility-refresh.yml";
const SOURCE_ID = "kric-station-convenience-standard";
const AUTOMATION_BRANCH = /^automation\/629-kric-facility-refresh-[0-9]+$/;
const SOURCE_RUN_ID = /^[1-9][0-9]*$/;
const GITHUB_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
// 회수할 수 없는 claim을 닫았다는 기록이다. 복구 step이 이 subject의 빈 커밋을 남기고, 판정은 이 claim을 정리 대상(보고 뒤 삭제)으로 본다(#995).
// 이름의 정본은 claim 판정 모듈(claim-orphans)이다.
export const ABANDONED_CLAIM_SUBJECT = CLAIM_OWNERS[WORKFLOW].abandonedSubject;
// workflow의 evidence upload retention-days와 같아야 한다(workflow 계약 테스트가 확인한다).
export const KRIC_FACILITY_EVIDENCE_RETENTION_DAYS = 14;

function parseJson(bytes, label) {
  try { return JSON.parse(bytes); }
  catch { throw new Error(`${label} is invalid JSON`); }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requireInstant(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`${label} is invalid`);
  return Date.parse(value);
}

function parseDuration(value) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value ?? "");
  if (!match || match.slice(1).every((part) => part === undefined)) throw new Error("freshness alert threshold is invalid");
  const milliseconds = (Number(match[1] ?? 0) * 3_600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)) * 1_000;
  if (milliseconds <= 0) throw new Error("freshness alert threshold is invalid");
  return milliseconds;
}

function automationPullRequests(value, repository) {
  if (!Array.isArray(value)) throw new Error("open pull requests are invalid");
  if (typeof repository !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new Error("repository is invalid");
  return value.filter((pullRequest) => {
    requireObject(pullRequest, "open pull request");
    if (!AUTOMATION_BRANCH.test(pullRequest.headRefName)) return false;
    if (pullRequest.baseRefName !== "main") return false;
    if (pullRequest.isCrossRepository !== false
      || pullRequest.headRepository?.nameWithOwner !== repository) return false;
    if (!["OPEN", "CLOSED", "MERGED"].includes(pullRequest.state)
      || typeof pullRequest.isDraft !== "boolean") throw new Error("open pull request state is invalid");
    return true;
  });
}

function automationClaims(bytes) {
  const invalid = (detail) => {
    throw new Error(detail === "duplicate refs" ? "duplicate KRIC refresh claims exist" : "KRIC refresh claim is invalid");
  };
  return parsePrefixedRefs(bytes.toString("utf8"), CLAIM_OWNERS[WORKFLOW].prefix, invalid).map(({ branch }) => branch);
}

export async function decideCurrentKricFacilityRefresh({ inventoryPath, policyPath, prsPath, claimsPath, claimEvidencePath, repository, now = new Date() } = {}) {
  const [inventoryBytes, policyBytes, prsBytes, claimsBytes, evidenceBytes] = await Promise.all([
    readFile(path.resolve(inventoryPath)), readFile(path.resolve(policyPath)), readFile(path.resolve(prsPath)), readFile(path.resolve(claimsPath)),
    readFile(path.resolve(claimEvidencePath)),
  ]);
  const inventory = requireObject(parseJson(inventoryBytes, "source inventory"), "source inventory");
  const policy = requireObject(parseJson(policyBytes, "freshness policy"), "freshness policy");
  const source = inventory.sources?.find(({ id }) => id === SOURCE_ID);
  const freshUntil = requireInstant(source?.accessibilityAdmissionEvidence?.freshUntil, "KRIC facility freshUntil");
  const alertBeforePackExpiry = policy.monitoring?.alertBeforePackExpiry;
  const threshold = parseDuration(alertBeforePackExpiry);
  const currentTime = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(currentTime)) throw new Error("decision time is invalid");
  const pullRequests = automationPullRequests(parseJson(prsBytes, "open pull requests"), repository);
  const pullRequestBranches = pullRequests.map(({ headRefName }) => headRefName);
  if (new Set(pullRequestBranches).size !== pullRequestBranches.length) {
    throw new Error("duplicate KRIC refresh pull requests exist");
  }
  const openPullRequests = pullRequests.filter(({ state }) => state === "OPEN");
  if (openPullRequests.length > 1) throw new Error("duplicate KRIC refresh pull requests exist");
  const claims = automationClaims(claimsBytes);
  // #995: PR 없는 claim은 만든 run과 게시 증거(출력 커밋·receipt artifact)로 가른다. 증거 없는 빈 claim은 복구할 것이 없으므로 정리 대상(보고 뒤 삭제)이다.
  const plan = planUnboundClaims({
    workflowFile: WORKFLOW, repository, claimBranches: claims, pullRequests, evidence: parseJson(evidenceBytes, "claim evidence"),
  });
  const cleanupClaims = plan.abandoned;
  if (openPullRequests.length === 1) return { state: "OPEN_PR", alertBeforePackExpiry, cleanupClaims };
  const live = [...plan.active, ...plan.recoverable];
  const closed = claims.filter((branch) => pullRequests.some(({ headRefName, state }) => headRefName === branch && state === "CLOSED"));
  if (closed.length > 1 || (closed.length === 1 && live.length === 1)) {
    throw new Error("KRIC refresh claims are ambiguous");
  }
  if (closed.length === 1) {
    throw new Error("closed KRIC refresh claim requires manual resolution");
  }
  if (live.length > 1) throw new Error("duplicate KRIC refresh claims exist");
  if (plan.active.length === 1) return { state: "CLAIM_IN_PROGRESS", alertBeforePackExpiry, branch: plan.active[0], cleanupClaims };
  if (plan.recoverable.length === 1) return { state: "RECOVER_CLAIM", alertBeforePackExpiry, branch: plan.recoverable[0], cleanupClaims };
  if (currentTime >= freshUntil) return { state: "EXPIRED", alertBeforePackExpiry, cleanupClaims };
  if (currentTime >= freshUntil - threshold) return { state: "DUE", alertBeforePackExpiry, cleanupClaims };
  return { state: "NOT_DUE", alertBeforePackExpiry, cleanupClaims };
}

// RECOVER_CLAIM이 원래 run의 보존 증거(journal·raw receipt)를 받을 수 있는지 판정한다.
// AVAILABLE: 이름이 정확한 artifact가 만료되지 않았다.
// EXPIRED: GitHub가 만료로 표시했거나, 원래 run 종료 뒤 보존 기간이 지나 목록에서 사라졌다.
// 보존 기간 안에서 artifact가 없으면 만료 근거가 없으므로 실패로 남긴다(수동 처리).
export function classifyKricFacilityClaimEvidence({ sourceRunId, sourceRunUpdatedAt, artifacts, now = new Date() } = {}) {
  if (typeof sourceRunId !== "string" || !SOURCE_RUN_ID.test(sourceRunId)) {
    throw new Error("KRIC refresh claim source run identity is invalid");
  }
  if (typeof sourceRunUpdatedAt !== "string" || !GITHUB_INSTANT.test(sourceRunUpdatedAt)
    || !Number.isFinite(Date.parse(sourceRunUpdatedAt))) {
    throw new Error("KRIC refresh claim source run updatedAt is invalid");
  }
  const currentTime = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(currentTime)) throw new Error("decision time is invalid");
  requireObject(artifacts, "KRIC refresh claim artifact listing");
  if (!Number.isSafeInteger(artifacts.total_count) || !Array.isArray(artifacts.artifacts)
    || artifacts.artifacts.length !== artifacts.total_count
    || artifacts.artifacts.some((artifact) => !artifact || typeof artifact !== "object"
      || typeof artifact.name !== "string" || typeof artifact.expired !== "boolean")) {
    throw new Error("KRIC refresh claim artifact listing is invalid");
  }
  const named = artifacts.artifacts.filter(({ name }) => name === `kric-current-facility-refresh-${sourceRunId}`);
  if (named.length > 1) throw new Error("duplicate KRIC refresh claim evidence artifacts exist");
  if (named.length === 1 && named[0].expired === false) return "AVAILABLE";
  if (named.length === 1) return "EXPIRED";
  const retentionEndsAt = Date.parse(sourceRunUpdatedAt) + KRIC_FACILITY_EVIDENCE_RETENTION_DAYS * 86_400_000;
  if (currentTime >= retentionEndsAt) return "EXPIRED";
  throw new Error("KRIC refresh retained evidence is missing inside its retention window");
}

export async function runCurrentKricFacilityRefreshDecision({ inventoryPath, policyPath, prsPath, claimsPath, claimEvidencePath, repository, outputPath, githubOutputPath, now } = {}) {
  const result = await decideCurrentKricFacilityRefresh({ inventoryPath, policyPath, prsPath, claimsPath, claimEvidencePath, repository, now });
  await Promise.all([
    writeFile(path.resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" }),
    writeFile(path.resolve(githubOutputPath), `state=${result.state}\nbranch=${result.branch ?? ""}\ncleanup_claims=${result.cleanupClaims.join(",")}\n`, { flag: "a" }),
  ]);
  return result;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!name?.startsWith("--") || options[name.slice(2)] !== undefined) throw new Error("decision arguments are invalid");
    options[name.slice(2)] = argv[index + 1];
  }
  if (Object.keys(options).some((name) => !["inventory", "policy", "prs", "claims", "claim-evidence", "repository", "output", "github-output"].includes(name)) || Object.values(options).some((value) => typeof value !== "string" || value === "")) throw new Error("decision arguments are invalid");
  return options;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const options = parseArgs(process.argv.slice(2));
  runCurrentKricFacilityRefreshDecision({ inventoryPath: options.inventory, policyPath: options.policy, prsPath: options.prs, claimsPath: options.claims, claimEvidencePath: options["claim-evidence"], repository: options.repository, outputPath: options.output, githubOutputPath: options["github-output"] }).catch((error) => {
    console.error(error instanceof Error ? error.message : "KRIC refresh decision failed");
    process.exitCode = 1;
  });
}
