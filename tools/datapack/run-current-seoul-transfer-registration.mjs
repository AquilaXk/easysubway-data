#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { validateAuthenticatedTransferObservation } from "./build-current-transfer-topology-metrics.mjs";
import { rebuildAuthenticatedTransferTopologyMetrics } from "./build-current-transfer-topology-metrics.mjs";
import { buildApplicability } from "./build-current-capital-transfer-topology-applicability.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { assertExactMainPreflight, publishSeoulTransferRawArtifact, validateSeoulTransferRawReceipt } from "./publish-seoul-transfer-raw.mjs";
import { registerCurrentSeoulTransferSource } from "./register-current-seoul-transfer-source.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SOURCE_ID = "seoul-metro-transfer-distance-duration";
const JOURNAL = "journal.json";
const RECEIPT = "receipt.json";
const SHA = /^[0-9a-f]{64}$/u;
const GIT_SHA = /^[0-9a-f]{40}$/u;
const STATES = new Set(["PREPARED", "PUBLISHING", "PUBLISHED", "REGISTERING", "FINALIZED", "PUBLISH_FAILED", "REGISTER_FAILED"]);
const FILES = ["manifest.json", "observation.json", "raw-snapshot.json"];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const execFile = promisify(execFileCallback);

function requireAbsolute(value, label) { if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${label} must be absolute`); return path.resolve(value); }
function privateMode(stat, label) { if ((stat.mode & 0o077) !== 0) throw new Error(`${label} must be private`); }
async function regularBytes(target, label, { privateFile = false } = {}) {
  let handle;
  try { handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { throw new Error(`${label} must be a regular non-symlink file`, { cause: error }); }
  try {
    const before = await handle.stat(); if (!before.isFile()) throw new Error(`${label} must be a regular non-symlink file`); if (privateFile) privateMode(before, label);
    const bytes = await handle.readFile(); const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) throw new Error(`${label} changed during read`);
    return bytes;
  } finally { await handle?.close(); }
}
async function assertOperationRoot(repositoryRoot, operationRoot, { create = false } = {}) {
  const root = requireAbsolute(repositoryRoot, "repositoryRoot"); const operation = requireAbsolute(operationRoot, "operationRoot"); const parent = path.dirname(operation);
  const parentStat = await lstat(parent); if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("operation root parent must be a regular directory");
  const [realRoot, realParent] = await Promise.all([realpath(root), realpath(parent)]);
  if (realParent === realRoot || realParent.startsWith(`${realRoot}${path.sep}`)) throw new Error("operation root must be external to repository");
  if (create) { await mkdir(operation, { mode: 0o700 }); }
  const stat = await lstat(operation); if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) throw new Error("operation root must be a private regular directory");
  const realOperation = await realpath(operation); if (realOperation === realRoot || realOperation.startsWith(`${realRoot}${path.sep}`)) throw new Error("operation root must be external to repository");
  return operation;
}
async function acquireOperationLock(operationRoot) {
  const lock = path.join(operationRoot, ".operation-lock"); const owner = randomUUID();
  try { await mkdir(lock, { mode: 0o700 }); } catch (error) { if (error?.code === "EEXIST") throw new Error("transfer registration operation is already in progress"); throw error; }
  try { await writeFile(path.join(lock, "owner"), owner, { flag: "wx", mode: 0o600 }); }
  catch (error) { await rmdir(lock).catch(() => {}); throw error; }
  return async () => {
    const ownerPath = path.join(lock, "owner"); const value = await readFile(ownerPath, "utf8");
    if (value !== owner) throw new Error("transfer registration lock ownership changed");
    await unlink(ownerPath); await rmdir(lock);
  };
}
async function writeJournal(operationRoot, journal) {
  const target = path.join(operationRoot, JOURNAL); const temporary = path.join(operationRoot, `.${JOURNAL}.${randomUUID()}.tmp`); const bytes = Buffer.from(`${JSON.stringify(journal, null, 2)}\n`);
  let written = false;
  try { const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } await rename(temporary, target); written = true; const directory = await open(operationRoot, constants.O_RDONLY | constants.O_DIRECTORY); try { await directory.sync(); } finally { await directory.close(); } }
  finally { if (!written) await unlink(temporary).catch(() => {}); }
}
function parseJournal(bytes) {
  let value; try { value = JSON.parse(bytes); } catch { throw new Error("operation journal is invalid"); }
  const base = ["schemaVersion", "phase", "repositoryRoot", "operationRoot", "expectedMainSha", "preparedAt", "observationDirectory", "observation", "metrics", "applicability"];
  const hasPublish = ["PUBLISHING", "PUBLISHED", "REGISTERING", "FINALIZED", "REGISTER_FAILED", "PUBLISH_FAILED"].includes(value?.phase); const hasApproval = ["REGISTERING", "FINALIZED", "REGISTER_FAILED"].includes(value?.phase);
  const keys = value?.phase === "FINALIZED" ? [...base, "publishAt", "approvedAt", "targets"] : value?.phase?.endsWith("_FAILED") ? [...base, ...(hasPublish ? ["publishAt"] : []), ...(hasApproval ? ["approvedAt"] : []), "errorCode"] : [...base, ...(hasPublish ? ["publishAt"] : []), ...(hasApproval ? ["approvedAt"] : [])];
  const instant = (entry) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(entry ?? "");
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort()) || value.schemaVersion !== 1 || !STATES.has(value.phase) || !GIT_SHA.test(value.expectedMainSha ?? "") || ![value.repositoryRoot, value.operationRoot, value.observationDirectory].every((entry) => typeof entry === "string" && path.isAbsolute(entry)) || !instant(value.preparedAt) || (hasPublish && !instant(value.publishAt)) || (hasApproval && !instant(value.approvedAt)) || !value.observation || value.observation.sourceId !== SOURCE_ID || value.observation.rowCount !== 145 || !/^\d{4}-\d{2}-\d{2}T/u.test(value.observation.capturedAt ?? "") || !Array.isArray(value.observation.files) || value.observation.files.length !== 3 || value.observation.files.some((file) => !file || typeof file.path !== "string" || !path.isAbsolute(file.path) || !Number.isSafeInteger(file.byteLength) || file.byteLength <= 0 || !SHA.test(file.sha256 ?? "")) || !value.metrics || !value.applicability || ![value.metrics, value.applicability].every((entry) => typeof entry.path === "string" && path.isAbsolute(entry.path) && Number.isSafeInteger(entry.byteLength) && entry.byteLength > 0 && SHA.test(entry.sha256 ?? "")) || (value.phase.endsWith("_FAILED") && value.errorCode !== value.phase) || (value.phase === "FINALIZED" && !validTargets(value.targets, value.observation.capturedAt))) throw new Error("operation journal is invalid");
  return value;
}
async function readJournal(operationRoot) { return parseJournal(await regularBytes(path.join(operationRoot, JOURNAL), "operation journal", { privateFile: true })); }
async function readObservationDirectory(directory, repositoryRoot) {
  const root = requireAbsolute(directory, "observationDirectory"); const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("transfer observation directory must be a regular non-symlink directory"); privateMode(stat, "transfer observation directory");
  const names = (await readdir(root)).sort(); if (JSON.stringify(names) !== JSON.stringify(FILES)) throw new Error("transfer observation inventory must contain exactly three files");
  const [manifestBytes, observationBytes, rawBytes, sourceCandidatesBytes] = await Promise.all([
    ...FILES.map((name) => regularBytes(path.join(root, name), `transfer observation ${name}`, { privateFile: true })),
    regularBytes(path.join(repositoryRoot, "tools/datapack/source-candidates.json"), "source candidate contract"),
  ]);
  let manifest; let observation; let rawSnapshot;
  try { manifest = JSON.parse(manifestBytes); observation = JSON.parse(observationBytes); rawSnapshot = JSON.parse(rawBytes); } catch { throw new Error("transfer observation must be JSON"); }
  if (!manifestBytes.equals(Buffer.from(`${canonicalJson(manifest)}\n`)) || !observationBytes.equals(Buffer.from(`${canonicalJson(observation)}\n`)) || !rawBytes.equals(Buffer.from(`${canonicalJson(rawSnapshot)}\n`))) throw new Error("transfer observation must be canonical");
  validateAuthenticatedTransferObservation({ observation: { manifest, observation, raw: rawSnapshot, bytes: { manifest: manifestBytes, observation: observationBytes, raw: rawBytes } }, sourceCandidatesBytes });
  if (manifest.sourceId !== SOURCE_ID || manifest.rowCount !== 145) throw new Error("transfer observation identity mismatch");
  return { directory: root, manifest, observation, rawSnapshot, manifestBytes, observationBytes, rawBytes };
}
async function readArtifacts(repositoryRoot, observation) {
  const paths = {
    metrics: path.join(repositoryRoot, "tools/datapack/release/current-transfer-topology-metrics.json"), applicability: path.join(repositoryRoot, "tools/datapack/release/current-capital-transfer-topology-applicability.json"),
    canonical: path.join(repositoryRoot, "tools/datapack/release/capital-production-canonical-pack.json"), candidates: path.join(repositoryRoot, "tools/datapack/source-candidates.json"), kric: path.join(repositoryRoot, "tools/datapack/sources/kric-provider-code-catalog-20260228.json"),
  };
  const [metricsBytes, applicabilityBytes, canonicalBytes, candidatesBytes, kricBytes] = await Promise.all([
    regularBytes(path.join(repositoryRoot, "tools/datapack/release/current-transfer-topology-metrics.json"), "transfer metrics"),
    regularBytes(path.join(repositoryRoot, "tools/datapack/release/current-capital-transfer-topology-applicability.json"), "transfer applicability"),
    regularBytes(paths.canonical, "canonical pack"), regularBytes(paths.candidates, "source candidate contract"), regularBytes(paths.kric, "KRIC catalog"),
  ]);
  let metrics; let applicability; let canonical;
  try { metrics = JSON.parse(metricsBytes); applicability = JSON.parse(applicabilityBytes); canonical = JSON.parse(canonicalBytes); } catch { throw new Error("transfer artifacts must be JSON"); }
  const rebuiltMetrics = rebuildAuthenticatedTransferTopologyMetrics({ canonicalPack: canonical, canonicalPackBytes: canonicalBytes, sourceCandidatesBytes: candidatesBytes, kricCatalogBytes: kricBytes, observation: { manifest: observation.manifest, observation: observation.observation, raw: observation.rawSnapshot, bytes: { manifest: observation.manifestBytes, observation: observation.observationBytes, raw: observation.rawBytes } } });
  if (!metricsBytes.equals(Buffer.from(`${canonicalJson(rebuiltMetrics)}\n`))) throw new Error("transfer metrics rebuild mismatch");
  const rebuiltApplicability = buildApplicability({ canonicalPack: canonical, canonicalPackBytes: canonicalBytes, transferTopologyMetrics: rebuiltMetrics, metricsBytes });
  if (!applicabilityBytes.equals(Buffer.from(`${canonicalJson(rebuiltApplicability)}\n`))) throw new Error("transfer applicability rebuild mismatch");
  return { metricsBytes, applicabilityBytes, metrics, applicability, canonicalBytes, canonical, paths };
}
function binding(observation, artifacts) { return { sourceId: observation.manifest.sourceId, capturedAt: observation.manifest.capturedAt, rowCount: observation.manifest.rowCount, files: [{ path: path.join(observation.directory, "manifest.json"), byteLength: observation.manifestBytes.length, sha256: hash(observation.manifestBytes) }, { path: path.join(observation.directory, "observation.json"), byteLength: observation.observationBytes.length, sha256: hash(observation.observationBytes) }, { path: path.join(observation.directory, "raw-snapshot.json"), byteLength: observation.rawBytes.length, sha256: hash(observation.rawBytes) }], metrics: { path: artifacts.paths?.metrics, byteLength: artifacts.metricsBytes.length, sha256: hash(artifacts.metricsBytes) }, applicability: { path: artifacts.paths?.applicability, byteLength: artifacts.applicabilityBytes.length, sha256: hash(artifacts.applicabilityBytes) } }; }
function assertBinding(journal, observation, artifacts) {
  const current = binding(observation, artifacts);
  const currentObservation = { sourceId: current.sourceId, capturedAt: current.capturedAt, rowCount: current.rowCount, files: current.files };
  if (canonicalJson(journal.observation) !== canonicalJson(currentObservation) || canonicalJson(journal.metrics) !== canonicalJson(current.metrics) || canonicalJson(journal.applicability) !== canonicalJson(current.applicability)) throw new Error("prepared registration binding mismatch");
}
function assertReceiptBinding(receipt, journal) {
  validateSeoulTransferRawReceipt(receipt); const binding = journal.observation;
  const files = new Map(binding.files.map((file) => [path.basename(file.path), file]));
  if (receipt.sourceId !== binding.sourceId || receipt.capturedAt !== binding.capturedAt || receipt.snapshotRawSha256 !== files.get("raw-snapshot.json").sha256 || receipt.manifestSha256 !== files.get("manifest.json").sha256 || receipt.observationSha256 !== files.get("observation.json").sha256 || receipt.rawObjectSha256 !== files.get("raw-snapshot.json").sha256 || receipt.byteSize !== files.get("raw-snapshot.json").byteLength) throw new Error("published receipt identity mismatch");
}
const FIXED_TARGETS = ["tools/datapack/source-inventory.json", "release/product-gates/production-datapack-scope.json", "tools/datapack/release/source-snapshots.json", "tools/datapack/release/candidate-build-spec.json"];
function validTargets(targets, capturedAt) {
  const token = capturedAt?.replaceAll(/[-:.]/gu, ""); const allowed = new Set([...FIXED_TARGETS, `tools/datapack/sources/${SOURCE_ID}-${token}.json`]);
  return Array.isArray(targets) && targets.length === 5 && new Set(targets.map(({ relativePath }) => relativePath)).size === 5 && targets.every((entry) => entry && allowed.has(entry.relativePath) && Number.isSafeInteger(entry.byteLength) && entry.byteLength > 0 && SHA.test(entry.sha256 ?? ""));
}
async function sealTargets(root, targets, capturedAt) {
  if (!Array.isArray(targets) || !validTargets(targets.map((relativePath) => ({ relativePath, byteLength: 1, sha256: "0".repeat(64) })), capturedAt)) throw new Error("registrar target allowlist mismatch");
  const sealed = await Promise.all(targets.map(async (relativePath) => { const bytes = await regularBytes(path.join(root, relativePath), "finalized transfer registration target"); return { relativePath, byteLength: bytes.length, sha256: hash(bytes) }; }));
  return sealed.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
async function assertFinalizedPostcondition(root, journal) {
  if (!validTargets(journal.targets, journal.observation.capturedAt)) throw new Error("finalized transfer registration postcondition mismatch");
  for (const target of journal.targets) { const bytes = await regularBytes(path.join(root, target.relativePath), "finalized transfer registration target"); if (bytes.length !== target.byteLength || hash(bytes) !== target.sha256) throw new Error("finalized transfer registration postcondition mismatch"); }
}
async function assertFinalStateMainDefault({ repositoryRoot, expectedMainSha, targets }) {
  const run = async (args) => (await execFile("git", args, { cwd: repositoryRoot, encoding: "utf8" })).stdout.trimEnd();
  const [head, originMain, status] = await Promise.all([run(["rev-parse", "HEAD"]), run(["rev-parse", "origin/main"]), run(["status", "--porcelain=v1", "--untracked-files=all"])]);
  if (head !== expectedMainSha || originMain !== expectedMainSha || !validateFinalStateStatus(status, targets)) throw new Error("finalized exact-main preflight failed");
}
export function validateFinalStateStatus(status, targets) {
  if (typeof status !== "string" || !Array.isArray(targets) || targets.length !== 5) return false;
  const source = targets.find(({ relativePath }) => relativePath.startsWith(`tools/datapack/sources/${SOURCE_ID}-`))?.relativePath;
  const fixed = new Set(FIXED_TARGETS); const lines = status.split("\n").filter(Boolean);
  return lines.length === 5 && new Set(lines).size === 5 && lines.filter((line) => line.startsWith(" M ") && fixed.has(line.slice(3))).length === 4 && lines.filter((line) => line.startsWith("?? ") && line.slice(3) === source).length === 1;
}

export function parseArgs(argv) {
  if (argv[0] === "finalize" && argv.length === 3 && argv[1] === "--operation-root") return { phase: "finalize", operationRoot: argv[2] };
  if (argv[0] === "prepare" && argv.length === 7 && argv[1] === "--operation-root" && argv[3] === "--observation-directory" && argv[5] === "--expected-main-sha") return { phase: "prepare", operationRoot: argv[2], observationDirectory: argv[4], expectedMainSha: argv[6] };
  throw new Error("transfer registration arguments are invalid");
}

export async function prepareCurrentSeoulTransferRegistration({ repositoryRoot = ROOT, operationRoot, observationDirectory, expectedMainSha, assertExactMain = assertExactMainPreflight, readObservation = readObservationDirectory, readArtifacts: artifactsReader = readArtifacts, now = new Date() } = {}) {
  const root = requireAbsolute(repositoryRoot, "repositoryRoot"); if (!GIT_SHA.test(expectedMainSha ?? "") || !(now instanceof Date) || Number.isNaN(now.valueOf())) throw new Error("transfer registration preparation arguments are invalid");
  await assertExactMain({ repositoryRoot: root, expectedMainSha }); const operation = await assertOperationRoot(root, operationRoot, { create: true }); const release = await acquireOperationLock(operation);
  try {
    const observation = { ...await readObservation(observationDirectory, root), directory: requireAbsolute(observationDirectory, "observationDirectory") }; const artifacts = await artifactsReader(root, observation); const sealed = binding(observation, artifacts);
    await writeJournal(operation, { schemaVersion: 1, phase: "PREPARED", repositoryRoot: root, operationRoot: operation, expectedMainSha, preparedAt: now.toISOString(), observationDirectory: observation.directory, observation: { sourceId: sealed.sourceId, capturedAt: sealed.capturedAt, rowCount: sealed.rowCount, files: sealed.files }, metrics: sealed.metrics, applicability: sealed.applicability });
  } catch (error) { await unlink(path.join(operation, JOURNAL)).catch(() => {}); throw error; } finally { await release(); }
}

export async function finalizeCurrentSeoulTransferRegistration({ repositoryRoot = ROOT, operationRoot, assertExactMain = assertExactMainPreflight, assertFinalStateMain = assertFinalStateMainDefault, readObservation = readObservationDirectory, readArtifacts: artifactsReader = readArtifacts, publish = publishSeoulTransferRawArtifact, register = registerCurrentSeoulTransferSource, now = new Date() } = {}) {
  const root = requireAbsolute(repositoryRoot, "repositoryRoot"); if (!(now instanceof Date) || Number.isNaN(now.valueOf())) throw new Error("transfer registration finalize arguments are invalid");
  const operation = await assertOperationRoot(root, operationRoot); const release = await acquireOperationLock(operation); let journal;
  try { journal = await readJournal(operation);
  if (journal.repositoryRoot !== root || journal.operationRoot !== operation) throw new Error("operation journal location mismatch");
  if (["PUBLISH_FAILED", "REGISTER_FAILED"].includes(journal.phase)) throw new Error("transfer registration is terminal");
  if (journal.phase === "REGISTERING") throw new Error("transfer registration requires manual recovery");
  if (journal.phase === "FINALIZED") { await assertFinalStateMain({ repositoryRoot: root, expectedMainSha: journal.expectedMainSha, targets: journal.targets }); const observation = { ...await readObservation(journal.observationDirectory, root), directory: journal.observationDirectory }; const artifacts = await artifactsReader(root, observation); assertBinding(journal, observation, artifacts); await assertFinalizedPostcondition(root, journal); return { phase: "FINALIZED" }; }
  if (!["PREPARED", "PUBLISHING", "PUBLISHED"].includes(journal.phase)) throw new Error("transfer registration is not resumable");
  await assertExactMain({ repositoryRoot: root, expectedMainSha: journal.expectedMainSha });
  const observation = { ...await readObservation(journal.observationDirectory, root), directory: journal.observationDirectory }; const artifacts = await artifactsReader(root, observation); assertBinding(journal, observation, artifacts);
  const receiptPath = path.join(operation, RECEIPT); let receipt;
  if (journal.phase !== "PUBLISHED") {
    try { receipt = validateSeoulTransferRawReceipt(JSON.parse(await regularBytes(receiptPath, "transfer OCI receipt", { privateFile: true }))); assertReceiptBinding(receipt, journal); }
    catch (error) {
      const absent = error?.cause?.code === "ENOENT" || error?.code === "ENOENT";
      if (!absent || journal.phase === "PUBLISHING") { journal = { ...journal, phase: "PUBLISH_FAILED", errorCode: "PUBLISH_FAILED" }; await writeJournal(operation, journal); throw new Error(absent ? "publication interrupted without receipt" : "published receipt identity mismatch"); }
      journal = { ...journal, phase: "PUBLISHING", publishAt: now.toISOString() }; await writeJournal(operation, journal);
      try { receipt = await publish({ repositoryRoot: root, observationDirectory: journal.observationDirectory, receiptPath, expectedMainSha: journal.expectedMainSha, now: new Date(journal.publishAt) }); assertReceiptBinding(receipt, journal); }
      catch (publishError) { journal = { ...journal, phase: "PUBLISH_FAILED", errorCode: "PUBLISH_FAILED" }; await writeJournal(operation, journal); throw publishError; }
    }
    if (journal.publishAt == null) journal = { ...journal, publishAt: receipt.storedAt };
    const receiptHandle = await open(receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW); try { await receiptHandle.sync(); } finally { await receiptHandle.close(); }
    const operationDirectory = await open(operation, constants.O_RDONLY | constants.O_DIRECTORY); try { await operationDirectory.sync(); } finally { await operationDirectory.close(); }
    journal = { ...journal, phase: "PUBLISHED" }; await writeJournal(operation, journal);
  } else { try { receipt = validateSeoulTransferRawReceipt(JSON.parse(await regularBytes(receiptPath, "transfer OCI receipt", { privateFile: true }))); assertReceiptBinding(receipt, journal); } catch (error) { journal = { ...journal, phase: "PUBLISH_FAILED", errorCode: "PUBLISH_FAILED" }; await writeJournal(operation, journal); throw new Error("published receipt identity mismatch"); } }
  journal = { ...journal, phase: "REGISTERING", approvedAt: now.toISOString() }; await writeJournal(operation, journal);
  let registration;
  try { registration = await register({ repositoryRoot: root, observationDirectory: journal.observationDirectory, receiptPath, approvedAt: journal.approvedAt, expectedMainSha: journal.expectedMainSha }); }
  catch (error) { journal = { ...journal, phase: "REGISTER_FAILED", errorCode: "REGISTER_FAILED" }; await writeJournal(operation, journal); throw error; }
  const targets = await sealTargets(root, registration?.targets, journal.observation.capturedAt); await assertFinalStateMain({ repositoryRoot: root, expectedMainSha: journal.expectedMainSha, targets });
  await writeJournal(operation, { ...journal, phase: "FINALIZED", targets }); return { phase: "FINALIZED" };
  } finally { await release(); }
}

export async function main(argv = process.argv.slice(2), options = {}) { const args = parseArgs(argv); return args.phase === "prepare" ? prepareCurrentSeoulTransferRegistration({ ...options, operationRoot: args.operationRoot, observationDirectory: args.observationDirectory, expectedMainSha: args.expectedMainSha }) : finalizeCurrentSeoulTransferRegistration({ ...options, operationRoot: args.operationRoot }); }

if (import.meta.url === new URL(process.argv[1], "file:").href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
