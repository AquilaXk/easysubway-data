#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const EXIT_BRANCH = /^automation\/6-kric-exit-full-capital-refresh-[0-9]+$/u;
const FACILITY_BRANCH = /^automation\/629-kric-facility-refresh-[0-9]+$/u;
const CLAIM = /^([0-9a-f]{40})\trefs\/heads\/(automation\/6-kric-exit-full-capital-refresh-[0-9]+)$/u;
const CLAIM_SHA = /^[0-9a-f]{40}$/u;
const PRODUCER_RUN_ID = /^[1-9][0-9]*$/u;
const CLAIM_SUBJECT = "Claim KRIC EXIT full-capital refresh";
const FACILITY_PATHS = new Set([
  "tools/datapack/release/candidate-build-spec.json",
  "tools/datapack/release/current-capital-facility-source-admission.json",
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/source-inventory.json",
  "tools/datapack/release/release-request.json",
  "tools/datapack/release/hash-evidence.json",
]);
const FACILITY_SOURCE_PATH = /^tools\/datapack\/sources\/[^/]+\.json$/u;

function object(value, label) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`); return value; }
function json(bytes, label) { try { return JSON.parse(bytes); } catch { throw new Error(`${label} is invalid JSON`); } }
function instant(value, label) { if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`${label} is invalid`); return Date.parse(value); }
function duration(value) { const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/u.exec(value ?? ""); if (!match || match.slice(1).every((part) => part === undefined)) throw new Error("freshness alert threshold is invalid"); const milliseconds = (Number(match[1] ?? 0) * 3_600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)) * 1_000; if (milliseconds <= 0) throw new Error("freshness alert threshold is invalid"); return milliseconds; }
function readClaims(bytes) { const rows = bytes.toString("utf8").split("\n").filter(Boolean).map((line) => { const match = CLAIM.exec(line); if (!match) throw new Error("EXIT full-capital refresh claim is invalid"); return { sha: match[1], branch: match[2] }; }); if (new Set(rows.map(({ branch }) => branch)).size !== rows.length) throw new Error("duplicate EXIT full-capital refresh claims exist"); return rows; }
function producerRunId(branch, label = "EXIT full-capital refresh claim") {
  const value = branch?.slice("automation/6-kric-exit-full-capital-refresh-".length);
  if (!PRODUCER_RUN_ID.test(value ?? "")) throw new Error(`${label} run identity is invalid`);
  return value;
}
function readClaimEvidence(bytes, claims, currentMainSha) {
  if (!CLAIM_SHA.test(currentMainSha ?? "")) throw new Error("current main SHA is invalid");
  const entries = json(bytes, "EXIT full-capital refresh claim evidence");
  if (!Array.isArray(entries)) throw new Error("EXIT full-capital refresh claim evidence is invalid");
  const evidence = entries.map((entry) => {
    object(entry, "EXIT full-capital refresh claim evidence");
    if (!CLAIM_SHA.test(entry.sha ?? "") || !EXIT_BRANCH.test(entry.branch ?? "")
      || !CLAIM_SHA.test(entry.parentSha ?? "") || entry.commitCount !== 1
      || entry.subject !== CLAIM_SUBJECT) throw new Error("EXIT full-capital refresh claim evidence is invalid");
    return { sha: entry.sha, branch: entry.branch, parentSha: entry.parentSha, producerRunId: producerRunId(entry.branch) };
  });
  if (new Set(evidence.map(({ branch }) => branch)).size !== evidence.length
    || new Set(evidence.map(({ sha }) => sha)).size !== evidence.length) throw new Error("duplicate current-main EXIT full-capital refresh claims exist");
  const raw = new Map(claims.map(({ branch, sha }) => [branch, sha]));
  if (raw.size !== evidence.length || evidence.some(({ branch, sha }) => raw.get(branch) !== sha)) throw new Error("EXIT full-capital refresh claim evidence is invalid");
  return evidence;
}
function exactFacility(entry, repository) {
  object(entry, "FACILITY pull request");
  if (entry.state !== "OPEN" || entry.isDraft !== true || entry.baseRefName !== "main" || entry.isCrossRepository !== false
    || entry.headRepository?.nameWithOwner !== repository || !FACILITY_BRANCH.test(entry.headRefName)
    || !/^[a-f0-9]{40}$/u.test(entry.headRefOid ?? "") || !Array.isArray(entry.files)) return false;
  const files = entry.files.map((file) => file?.path);
  const sourcePaths = files.filter((file) => FACILITY_SOURCE_PATH.test(file));
  return new Set(files).size === files.length
    && FACILITY_PATHS.isSubsetOf(new Set(files))
    && sourcePaths.length === 1
    && files.every((file) => FACILITY_PATHS.has(file) || FACILITY_SOURCE_PATH.test(file));
}
function exitPrs(value, repository) {
  if (!Array.isArray(value)) throw new Error("pull requests are invalid");
  return value.filter((entry) => { object(entry, "pull request"); if (!EXIT_BRANCH.test(entry.headRefName)) return false; if (entry.baseRefName !== "main" || entry.isCrossRepository !== false || entry.headRepository?.nameWithOwner !== repository || !["OPEN", "CLOSED", "MERGED"].includes(entry.state) || typeof entry.isDraft !== "boolean") throw new Error("EXIT pull request identity is invalid"); return true; });
}
export async function decideCurrentKricExitFullCapitalRefresh({ inventoryPath, policyPath, prsPath, claimsPath, claimEvidencePath, currentMainSha, facilityPrsPath, repository, recoveryProducerRunId = undefined, now = new Date() } = {}) {
  const [inventoryBytes, policyBytes, prsBytes, claimsBytes, claimEvidenceBytes, facilityBytes] = await Promise.all([readFile(path.resolve(inventoryPath)), readFile(path.resolve(policyPath)), readFile(path.resolve(prsPath)), readFile(path.resolve(claimsPath)), readFile(path.resolve(claimEvidencePath)), readFile(path.resolve(facilityPrsPath))]);
  const admission = object(json(inventoryBytes, "EXIT source admission"), "EXIT source admission"); const policy = object(json(policyBytes, "freshness policy"), "freshness policy");
  if (admission.sourceIdentity?.sourceId !== "kric-station-movement-standard") throw new Error("KRIC EXIT full-capital source identity is invalid");
  const freshUntil = instant(admission.sourceIdentity?.freshUntil, "KRIC EXIT full-capital freshUntil"); const alertBeforePackExpiry = policy.monitoring?.alertBeforePackExpiry; const threshold = duration(alertBeforePackExpiry);
  const exit = exitPrs(json(prsBytes, "EXIT pull requests"), repository); if (new Set(exit.map(({ headRefName }) => headRefName)).size !== exit.length) throw new Error("duplicate EXIT full-capital refresh pull requests exist");
  const open = exit.filter(({ state }) => state === "OPEN"); if (open.length > 1) throw new Error("duplicate EXIT full-capital refresh pull requests exist"); if (open.length === 1) return { state: "OPEN_PR", alertBeforePackExpiry };
  if (recoveryProducerRunId !== undefined && !PRODUCER_RUN_ID.test(recoveryProducerRunId)) throw new Error("selected producer run identity is invalid");
  const evidence = readClaimEvidence(claimEvidenceBytes, readClaims(claimsBytes), currentMainSha);
  const recoverable = evidence.filter(({ parentSha, branch }) => parentSha === currentMainSha && !exit.some(({ headRefName }) => headRefName === branch));
  if (recoverable.length > 1) throw new Error("duplicate current-main EXIT full-capital refresh claims exist");
  const selected = recoveryProducerRunId === undefined ? [] : evidence.filter(({ producerRunId, branch }) => producerRunId === recoveryProducerRunId && !exit.some(({ headRefName }) => headRefName === branch));
  if (recoveryProducerRunId !== undefined && selected.length !== 1) throw new Error("selected EXIT full-capital refresh claim is not available");
  const current = now instanceof Date ? now.getTime() : NaN; if (!Number.isFinite(current)) throw new Error("decision time is invalid");
  if (recoveryProducerRunId === undefined && recoverable.length === 0 && current < freshUntil - threshold) return { state: "NOT_DUE", alertBeforePackExpiry };
  const facility = json(facilityBytes, "FACILITY pull requests").filter((entry) => exactFacility(entry, repository)); if (facility.length !== 1) throw new Error("exactly one validated same-repository FACILITY pull request is required");
  const prerequisite = { facilityBranch: facility[0].headRefName, facilityHeadSha: facility[0].headRefOid };
  if (recoveryProducerRunId !== undefined) return { state: "INSPECT_SELECTED_CLAIM", alertBeforePackExpiry, branch: selected[0].branch, producerRunId: selected[0].producerRunId, ...prerequisite };
  if (recoverable.length === 1) return { state: "RECOVER_CLAIM", alertBeforePackExpiry, branch: recoverable[0].branch, producerRunId: recoverable[0].producerRunId, ...prerequisite };
  return { state: current >= freshUntil ? "EXPIRED" : "DUE", alertBeforePackExpiry, ...prerequisite };
}
export async function runCurrentKricExitFullCapitalRefreshDecision(options = {}) { const result = await decideCurrentKricExitFullCapitalRefresh(options); await Promise.all([writeFile(path.resolve(options.outputPath), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" }), writeFile(path.resolve(options.githubOutputPath), `state=${result.state}\nbranch=${result.branch ?? ""}\nproducer_run_id=${result.producerRunId ?? ""}\nfacility_branch=${result.facilityBranch ?? ""}\nfacility_head_sha=${result.facilityHeadSha ?? ""}\n`, { flag: "a" })]); return result; }
function args(argv) { const values = {}; const required = new Set(["inventory", "policy", "prs", "claims", "claim-evidence", "current-main-sha", "facility-prs", "repository", "output", "github-output"]); const allowed = new Set([...required, "recovery-producer-run-id"]); if (!Array.isArray(argv) || (argv.length !== required.size * 2 && argv.length !== allowed.size * 2)) throw new Error("decision arguments are invalid"); for (let index = 0; index < argv.length; index += 2) { const key = argv[index]?.slice(2); const value = argv[index + 1]; if (!allowed.has(key) || Object.hasOwn(values, key) || typeof value !== "string" || value === "") throw new Error("decision arguments are invalid"); values[key] = value; } if (![...required].every((key) => Object.hasOwn(values, key))) throw new Error("decision arguments are invalid"); return values; }
if (process.argv[1] === new URL(import.meta.url).pathname) { const value = args(process.argv.slice(2)); runCurrentKricExitFullCapitalRefreshDecision({ inventoryPath: value.inventory, policyPath: value.policy, prsPath: value.prs, claimsPath: value.claims, claimEvidencePath: value["claim-evidence"], currentMainSha: value["current-main-sha"], facilityPrsPath: value["facility-prs"], repository: value.repository, recoveryProducerRunId: value["recovery-producer-run-id"], outputPath: value.output, githubOutputPath: value["github-output"] }).catch((error) => { console.error(error instanceof Error ? error.message : "EXIT full-capital refresh decision failed"); process.exitCode = 1; }); }
