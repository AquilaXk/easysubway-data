#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SOURCE_ID = "kric-station-convenience-standard";
const AUTOMATION_BRANCH = /^automation\/629-kric-facility-refresh-[0-9]+$/;

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

function automationPullRequests(value) {
  if (!Array.isArray(value)) throw new Error("open pull requests are invalid");
  const matching = value.filter((pullRequest) => requireObject(pullRequest, "open pull request") && AUTOMATION_BRANCH.test(pullRequest.headRefName));
  if (matching.length > 1) throw new Error("duplicate KRIC refresh pull requests exist");
  return matching;
}

export async function decideCurrentKricFacilityRefresh({ inventoryPath, policyPath, prsPath, now = new Date() } = {}) {
  const [inventoryBytes, policyBytes, prsBytes] = await Promise.all([
    readFile(path.resolve(inventoryPath)), readFile(path.resolve(policyPath)), readFile(path.resolve(prsPath)),
  ]);
  const inventory = requireObject(parseJson(inventoryBytes, "source inventory"), "source inventory");
  const policy = requireObject(parseJson(policyBytes, "freshness policy"), "freshness policy");
  const source = inventory.sources?.find(({ id }) => id === SOURCE_ID);
  const freshUntil = requireInstant(source?.accessibilityAdmissionEvidence?.freshUntil, "KRIC facility freshUntil");
  const alertBeforePackExpiry = policy.monitoring?.alertBeforePackExpiry;
  const threshold = parseDuration(alertBeforePackExpiry);
  const currentTime = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(currentTime)) throw new Error("decision time is invalid");
  const pullRequests = automationPullRequests(parseJson(prsBytes, "open pull requests"));
  if (pullRequests.length === 1) return { state: "OPEN_PR", alertBeforePackExpiry };
  if (currentTime >= freshUntil) return { state: "EXPIRED", alertBeforePackExpiry };
  if (currentTime >= freshUntil - threshold) return { state: "DUE", alertBeforePackExpiry };
  return { state: "NOT_DUE", alertBeforePackExpiry };
}

export async function runCurrentKricFacilityRefreshDecision({ inventoryPath, policyPath, prsPath, outputPath, githubOutputPath, now } = {}) {
  const result = await decideCurrentKricFacilityRefresh({ inventoryPath, policyPath, prsPath, now });
  await Promise.all([
    writeFile(path.resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" }),
    writeFile(path.resolve(githubOutputPath), `state=${result.state}\n`, { flag: "a" }),
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
  if (Object.keys(options).some((name) => !["inventory", "policy", "prs", "output", "github-output"].includes(name)) || Object.values(options).some((value) => typeof value !== "string" || value === "")) throw new Error("decision arguments are invalid");
  return options;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const options = parseArgs(process.argv.slice(2));
  runCurrentKricFacilityRefreshDecision({ inventoryPath: options.inventory, policyPath: options.policy, prsPath: options.prs, outputPath: options.output, githubOutputPath: options["github-output"] }).catch((error) => {
    console.error(error instanceof Error ? error.message : "KRIC refresh decision failed");
    process.exitCode = 1;
  });
}
