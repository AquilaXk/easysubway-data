#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SOURCE_ID = "kric-station-movement-standard";
const BRANCH = /^automation\/6-kric-exit-full-capital-refresh-[0-9]+$/;
const CLAIM = /^([0-9a-f]{40})\trefs\/heads\/(automation\/6-kric-exit-full-capital-refresh-[0-9]+)$/;

function object(value, label) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`); return value; }
function json(bytes, label) { try { return JSON.parse(bytes); } catch { throw new Error(`${label} is invalid JSON`); } }
function instant(value, label) { if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`${label} is invalid`); return Date.parse(value); }
function duration(value) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value ?? "");
  if (!match || match.slice(1).every((part) => part === undefined)) throw new Error("freshness alert threshold is invalid");
  const milliseconds = (Number(match[1] ?? 0) * 3_600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)) * 1_000;
  if (milliseconds <= 0) throw new Error("freshness alert threshold is invalid");
  return milliseconds;
}
function prs(value, repository) {
  if (!Array.isArray(value) || typeof repository !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new Error("open pull requests are invalid");
  return value.filter((entry) => {
    object(entry, "open pull request");
    if (!BRANCH.test(entry.headRefName)) return false;
    if (entry.baseRefName !== "main" || entry.isCrossRepository !== false || entry.headRepository?.nameWithOwner !== repository) return false;
    if (!['OPEN', 'CLOSED', 'MERGED'].includes(entry.state) || typeof entry.isDraft !== "boolean") throw new Error("open pull request state is invalid");
    return true;
  });
}
function claims(bytes) {
  const result = bytes.toString("utf8").split("\n").filter(Boolean).map((line) => {
    const match = CLAIM.exec(line); if (!match) throw new Error("EXIT full-capital refresh claim is invalid"); return { sha: match[1], branch: match[2] };
  });
  if (new Set(result.map(({ branch }) => branch)).size !== result.length) throw new Error("duplicate EXIT full-capital refresh claims exist");
  return result;
}

export async function decideCurrentKricExitFullCapitalRefresh({ inventoryPath, policyPath, prsPath, claimsPath, repository, now = new Date() } = {}) {
  const [inventoryBytes, policyBytes, prsBytes, claimsBytes] = await Promise.all([readFile(path.resolve(inventoryPath)), readFile(path.resolve(policyPath)), readFile(path.resolve(prsPath)), readFile(path.resolve(claimsPath))]);
  const admission = object(json(inventoryBytes, "EXIT source admission"), "EXIT source admission");
  const policy = object(json(policyBytes, "freshness policy"), "freshness policy");
  if (admission.sourceIdentity?.sourceId !== SOURCE_ID) throw new Error("KRIC EXIT full-capital source identity is invalid");
  const freshUntil = instant(admission.sourceIdentity?.freshUntil, "KRIC EXIT full-capital freshUntil");
  const alertBeforePackExpiry = policy.monitoring?.alertBeforePackExpiry;
  const threshold = duration(alertBeforePackExpiry);
  const current = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(current)) throw new Error("decision time is invalid");
  const pullRequests = prs(json(prsBytes, "open pull requests"), repository);
  if (new Set(pullRequests.map(({ headRefName }) => headRefName)).size !== pullRequests.length) throw new Error("duplicate EXIT full-capital refresh pull requests exist");
  const open = pullRequests.filter(({ state }) => state === "OPEN");
  if (open.length > 1) throw new Error("duplicate EXIT full-capital refresh pull requests exist");
  if (open.length === 1) return { state: "OPEN_PR", alertBeforePackExpiry };
  const recoverable = claims(claimsBytes).filter(({ branch }) => {
    const associated = pullRequests.filter(({ headRefName }) => headRefName === branch);
    if (associated.length > 1) throw new Error("duplicate EXIT full-capital refresh pull requests exist");
    if (associated[0]?.state === "CLOSED") throw new Error("closed EXIT full-capital refresh claim requires manual resolution");
    return associated.length === 0;
  });
  if (recoverable.length > 1) throw new Error("duplicate EXIT full-capital refresh claims exist");
  if (recoverable.length === 1) return { state: "RECOVER_CLAIM", alertBeforePackExpiry, branch: recoverable[0].branch };
  if (current >= freshUntil) return { state: "EXPIRED", alertBeforePackExpiry };
  return { state: current >= freshUntil - threshold ? "DUE" : "NOT_DUE", alertBeforePackExpiry };
}

export async function runCurrentKricExitFullCapitalRefreshDecision({ inventoryPath, policyPath, prsPath, claimsPath, repository, outputPath, githubOutputPath, now } = {}) {
  const result = await decideCurrentKricExitFullCapitalRefresh({ inventoryPath, policyPath, prsPath, claimsPath, repository, now });
  await Promise.all([writeFile(path.resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" }), writeFile(path.resolve(githubOutputPath), `state=${result.state}\nbranch=${result.branch ?? ""}\n`, { flag: "a" })]);
  return result;
}

function args(argv) {
  const values = {}; const allowed = new Set(["inventory", "policy", "prs", "claims", "repository", "output", "github-output"]);
  if (!Array.isArray(argv) || argv.length !== allowed.size * 2) throw new Error("decision arguments are invalid");
  for (let index = 0; index < argv.length; index += 2) { const key = argv[index]?.slice(2); const value = argv[index + 1]; if (!allowed.has(key) || Object.hasOwn(values, key) || typeof value !== "string" || value === "") throw new Error("decision arguments are invalid"); values[key] = value; }
  return values;
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const options = args(process.argv.slice(2));
  runCurrentKricExitFullCapitalRefreshDecision({ inventoryPath: options.inventory, policyPath: options.policy, prsPath: options.prs, claimsPath: options.claims, repository: options.repository, outputPath: options.output, githubOutputPath: options["github-output"] }).catch((error) => { console.error(error instanceof Error ? error.message : "EXIT full-capital refresh decision failed"); process.exitCode = 1; });
}
