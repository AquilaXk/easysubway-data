#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SOURCE_ID = "seoul-metro-accessibility";
const AUTOMATION_BRANCH = /^automation\/639-seoul-accessibility-refresh-\d+$/;
const CLAIM_REF = /^[\da-f]{40}\trefs\/heads\/(automation\/639-seoul-accessibility-refresh-\d+)$/;
const ALERT_THRESHOLD = /^PT(?:(?<hours>\d+)H)?(?:(?<minutes>\d+)M)?(?:(?<seconds>\d+)S)?$/;

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes);
  } catch {
    throw new Error(`${label} is invalid JSON`);
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireInstant(value, label) {
  if (typeof value !== "string"
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new Error(`${label} is invalid`);
  }
  return Date.parse(value);
}

function parseAlertThreshold(value) {
  const parts = ALERT_THRESHOLD.exec(value ?? "")?.groups;
  if (parts == null || Object.values(parts).every((part) => part === undefined)) {
    throw new Error("freshness alert threshold is invalid");
  }
  const milliseconds = (
    Number(parts.hours ?? 0) * 3_600
    + Number(parts.minutes ?? 0) * 60
    + Number(parts.seconds ?? 0)
  ) * 1_000;
  if (milliseconds <= 0) {
    throw new Error("freshness alert threshold is invalid");
  }
  return milliseconds;
}

function seoulAutomationPullRequests(value, repository) {
  if (!Array.isArray(value)) {
    throw new Error("open pull requests are invalid");
  }
  if (typeof repository !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error("repository is invalid");
  }
  return value.filter((pullRequest) => {
    requireObject(pullRequest, "open pull request");
    const belongsToSeoulRefresh = AUTOMATION_BRANCH.test(pullRequest.headRefName)
      && pullRequest.baseRefName === "main"
      && pullRequest.isCrossRepository === false
      && pullRequest.headRepository?.nameWithOwner === repository;
    if (!belongsToSeoulRefresh) return false;
    if (!["OPEN", "CLOSED", "MERGED"].includes(pullRequest.state)
      || typeof pullRequest.isDraft !== "boolean") {
      throw new Error("open pull request state is invalid");
    }
    return true;
  });
}

function automationClaims(bytes) {
  const claims = bytes.toString("utf8").split("\n").filter(Boolean).map((line) => {
    const match = CLAIM_REF.exec(line);
    if (!match) throw new Error("Seoul refresh claim is invalid");
    return { sha: line.slice(0, 40), branch: match[1] };
  });
  if (new Set(claims.map(({ branch }) => branch)).size !== claims.length) {
    throw new Error("duplicate Seoul refresh claims exist");
  }
  return claims;
}

export async function decideCurrentSeoulAccessibilityRefresh({ inventoryPath, policyPath, prsPath, claimsPath, repository, now = new Date() } = {}) {
  const [inventoryBytes, policyBytes, prsBytes, claimsBytes] = await Promise.all([
    readFile(path.resolve(inventoryPath)),
    readFile(path.resolve(policyPath)),
    readFile(path.resolve(prsPath)),
    readFile(path.resolve(claimsPath)),
  ]);
  const inventory = requireObject(parseJson(inventoryBytes, "source inventory"), "source inventory");
  const source = inventory.sources?.find(({ id }) => id === SOURCE_ID);
  const freshUntil = requireInstant(
    source?.accessibilityAdmissionEvidence?.freshUntil,
    "Seoul accessibility freshUntil",
  );
  const policy = requireObject(parseJson(policyBytes, "freshness policy"), "freshness policy");
  const alertBeforePackExpiry = policy.monitoring?.alertBeforePackExpiry;
  const threshold = parseAlertThreshold(alertBeforePackExpiry);
  const currentTime = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(currentTime)) throw new Error("decision time is invalid");
  const pullRequests = seoulAutomationPullRequests(
    parseJson(prsBytes, "open pull requests"),
    repository,
  );
  const pullRequestBranches = pullRequests.map(({ headRefName }) => headRefName);
  if (new Set(pullRequestBranches).size !== pullRequestBranches.length) {
    throw new Error("duplicate Seoul refresh pull requests exist");
  }
  const openPullRequests = pullRequests.filter(({ state }) => state === "OPEN");
  if (openPullRequests.length > 1) throw new Error("duplicate Seoul refresh pull requests exist");
  if (openPullRequests.length === 1) return { state: "OPEN_PR", alertBeforePackExpiry };
  const recoverable = automationClaims(claimsBytes).filter(({ branch }) => {
    const associated = pullRequests.filter(({ headRefName }) => headRefName === branch);
    if (associated.length > 1) throw new Error("duplicate Seoul refresh pull requests exist");
    if (associated[0]?.state === "CLOSED") {
      throw new Error("closed Seoul refresh claim requires manual resolution");
    }
    return associated.length === 0;
  });
  if (recoverable.length > 1) throw new Error("duplicate Seoul refresh claims exist");
  if (recoverable.length === 1) {
    return { state: "RECOVER_CLAIM", alertBeforePackExpiry, branch: recoverable[0].branch };
  }
  if (currentTime >= freshUntil) return { state: "EXPIRED", alertBeforePackExpiry };
  if (currentTime >= freshUntil - threshold) return { state: "DUE", alertBeforePackExpiry };
  return { state: "NOT_DUE", alertBeforePackExpiry };
}

export async function runCurrentSeoulAccessibilityRefreshDecision({ inventoryPath, policyPath, prsPath, claimsPath, repository, outputPath, githubOutputPath, now } = {}) {
  const result = await decideCurrentSeoulAccessibilityRefresh({
    inventoryPath,
    policyPath,
    prsPath,
    claimsPath,
    repository,
    now,
  });
  await Promise.all([
    writeFile(path.resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" }),
    writeFile(
      path.resolve(githubOutputPath),
      `state=${result.state}\nbranch=${result.branch ?? ""}\n`,
      { flag: "a" },
    ),
  ]);
  return result;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!name?.startsWith("--") || options[name.slice(2)] !== undefined) {
      throw new Error("decision arguments are invalid");
    }
    options[name.slice(2)] = argv[index + 1];
  }
  const allowed = new Set([
    "inventory", "policy", "prs", "claims", "repository", "output", "github-output",
  ]);
  if (Object.keys(options).some((name) => !allowed.has(name))
    || Object.values(options).some((value) => typeof value !== "string" || value === "")) {
    throw new Error("decision arguments are invalid");
  }
  return options;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    const options = parseArgs(process.argv.slice(2));
    await runCurrentSeoulAccessibilityRefreshDecision({
      inventoryPath: options.inventory,
      policyPath: options.policy,
      prsPath: options.prs,
      claimsPath: options.claims,
      repository: options.repository,
      outputPath: options.output,
      githubOutputPath: options["github-output"],
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Seoul refresh decision failed");
    process.exitCode = 1;
  }
}
