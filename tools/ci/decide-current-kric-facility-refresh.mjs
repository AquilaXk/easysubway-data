#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SOURCE_ID = "kric-station-convenience-standard";
const AUTOMATION_BRANCH = /^automation\/629-kric-facility-refresh-[0-9]+$/;
const CLAIM_REF = /^([0-9a-f]{40})\trefs\/heads\/(automation\/629-kric-facility-refresh-[0-9]+)$/;

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
  const lines = bytes.toString("utf8").split("\n").filter(Boolean);
  const claims = lines.map((line) => {
    const match = CLAIM_REF.exec(line);
    if (!match) throw new Error("KRIC refresh claim is invalid");
    return { sha: match[1], branch: match[2] };
  });
  if (new Set(claims.map(({ branch }) => branch)).size !== claims.length) {
    throw new Error("duplicate KRIC refresh claims exist");
  }
  return claims;
}

export async function decideCurrentKricFacilityRefresh({ inventoryPath, policyPath, prsPath, claimsPath, repository, now = new Date() } = {}) {
  const [inventoryBytes, policyBytes, prsBytes, claimsBytes] = await Promise.all([
    readFile(path.resolve(inventoryPath)), readFile(path.resolve(policyPath)), readFile(path.resolve(prsPath)), readFile(path.resolve(claimsPath)),
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
  if (openPullRequests.length === 1) return { state: "OPEN_PR", alertBeforePackExpiry };
  const analyzedClaims = claims.map((claim) => {
    const { branch } = claim;
    const associated = pullRequests.filter(({ headRefName }) => headRefName === branch);
    if (associated.length > 1) throw new Error("duplicate KRIC refresh pull requests exist");
    return {
      ...claim,
      pullRequestNumber: associated[0]?.number ?? null,
      pullRequestState: associated[0]?.state ?? null,
    };
  });
  const recoverable = analyzedClaims.filter(({ pullRequestState }) => pullRequestState === null);
  const closed = analyzedClaims.filter(({ pullRequestState }) => pullRequestState === "CLOSED");
  if (recoverable.length > 1) throw new Error("duplicate KRIC refresh claims exist");
  if (closed.length > 1 || (closed.length === 1 && recoverable.length === 1)) {
    throw new Error("KRIC refresh claims are ambiguous");
  }
  if (closed.length === 1) {
    throw new Error("closed KRIC refresh claim requires manual resolution");
  }
  if (recoverable.length === 1) return { state: "RECOVER_CLAIM", alertBeforePackExpiry, branch: recoverable[0].branch };
  if (currentTime >= freshUntil) return { state: "EXPIRED", alertBeforePackExpiry };
  if (currentTime >= freshUntil - threshold) return { state: "DUE", alertBeforePackExpiry };
  return { state: "NOT_DUE", alertBeforePackExpiry };
}

export async function runCurrentKricFacilityRefreshDecision({ inventoryPath, policyPath, prsPath, claimsPath, repository, outputPath, githubOutputPath, now } = {}) {
  const result = await decideCurrentKricFacilityRefresh({ inventoryPath, policyPath, prsPath, claimsPath, repository, now });
  await Promise.all([
    writeFile(path.resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" }),
    writeFile(path.resolve(githubOutputPath), `state=${result.state}\nbranch=${result.branch ?? ""}\n`, { flag: "a" }),
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
  if (Object.keys(options).some((name) => !["inventory", "policy", "prs", "claims", "repository", "output", "github-output"].includes(name)) || Object.values(options).some((value) => typeof value !== "string" || value === "")) throw new Error("decision arguments are invalid");
  return options;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const options = parseArgs(process.argv.slice(2));
  runCurrentKricFacilityRefreshDecision({ inventoryPath: options.inventory, policyPath: options.policy, prsPath: options.prs, claimsPath: options.claims, repository: options.repository, outputPath: options.output, githubOutputPath: options["github-output"] }).catch((error) => {
    console.error(error instanceof Error ? error.message : "KRIC refresh decision failed");
    process.exitCode = 1;
  });
}
