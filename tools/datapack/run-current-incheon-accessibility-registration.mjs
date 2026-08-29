#!/usr/bin/env node
// Executes the approved #622 observation → OCI receipt → registrar sequence.
// A durable PUBLISHING record is deliberately a terminal publication attempt:
// without its exact receipt a later invocation cannot issue another PUT.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { execFile as nodeExecFile } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runIncheonAccessibilityCollector } from "./collect-incheon-accessibility.mjs";
import { publishIncheonAccessibilityRawArtifact } from "./publish-incheon-accessibility-raw.mjs";
import { requireOciParBaseUrl } from "./lib/kric-raw-object-storage.mjs";
import {
  buildReviewedIncheonAccessibilityRegistrationOutputs,
  commitReviewedIncheonAccessibilityRegistrationOutputs,
  recoverPendingReviewedIncheonAccessibilityRegistration,
} from "./register-reviewed-incheon-accessibility.mjs";

const execFile = promisify(nodeExecFile);
const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SOURCE = "incheon-transit-accessibility";
const JOURNAL = "incheon-accessibility-registration.json";
const RECEIPT = "oci-receipt.json";
const OBSERVATION = "observation";
const FIXED_OUTPUTS = ["tools/datapack/source-inventory.json", "tools/datapack/release/source-snapshots.json", "tools/datapack/release/candidate-build-spec.json", "tools/datapack/release/release-request.json", "tools/datapack/release/hash-evidence.json"];
const SHA = /^[a-f0-9]{64}$/u;
const GIT_SHA = /^[a-f0-9]{40}$/u;
const SNAPSHOT_ID = /^incheon-transit-accessibility-20\d{6}T\d{9}Z$/u;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const textCompare = (left, right) => String(left).localeCompare(String(right));

function parse(bytes, label) { try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} is invalid JSON`); } }
function instant(value, label) { if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) || new Date(value).toISOString() !== value) throw new Error(`${label} is invalid`); return value; }
function absolute(value, label) { if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${label} must be absolute`); return path.resolve(value); }
function relative(value) { return typeof value === "string" && !path.isAbsolute(value) && value !== "" && !value.includes("\\") && path.posix.normalize(value) === value && !value.startsWith("../") && value !== ".."; }
async function regularDirectory(directory, label) { const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink directory`); }
async function regularBytes(file, label) { await regularDirectory(path.dirname(file), `${label} parent`); const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); try { const stat = await handle.stat(); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`); const bytes = await handle.readFile(); if (bytes.length !== stat.size) throw new Error(`${label} changed during read`); return bytes; } finally { await handle.close(); } }
async function existingBytes(file, label) { try { return await regularBytes(file, label); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }
async function syncDirectory(directory) { const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await handle.sync(); } finally { await handle.close(); } }
async function atomicReplace(file, next, expected = null) {
  const current = await existingBytes(file, "operation journal");
  if ((current == null) !== (expected == null) || current != null && !current.equals(expected)) throw new Error("operation journal changed concurrently");
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.incheon-accessibility.write.tmp`);
  if (await existingBytes(temporary, "operation journal temporary")) throw new Error("operation journal recovery is required");
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(next); await handle.sync(); } finally { await handle.close(); }
  try { const again = await existingBytes(file, "operation journal"); if ((again == null) !== (expected == null) || again != null && !again.equals(expected)) throw new Error("operation journal changed concurrently"); await rename(temporary, file); await syncDirectory(path.dirname(file)); } finally { await unlink(temporary).catch(() => {}); }
}
async function acquireOperationLease(root) {
  const lock = operationPath(root, ".incheon-accessibility-registration.lock"); let server = createServer();
  const listen = (port = 0) => new Promise((resolve, reject) => { const ok = () => { server.off("error", fail); resolve(); }; const fail = (error) => { server.off("listening", ok); reject(error); }; server.once("listening", ok); server.once("error", fail); server.listen({ host: "127.0.0.1", port, exclusive: true }); });
  const close = async () => { if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); };
  await listen(); const address = server.address(); const mine = jsonBytes({ schemaVersion: 1, host: "127.0.0.1", port: address.port, token: randomUUID() });
  const create = async (value) => { const handle = await open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); } await syncDirectory(root); };
  try { await create(mine); } catch (error) {
    await close(); const stale = await existingBytes(lock, "operation lease"); let parsed;
    try { parsed = parse(stale, "operation lease"); } catch { throw new Error("operation lease residue exists"); }
    if (parsed?.schemaVersion !== 1 || parsed.host !== "127.0.0.1" || !Number.isInteger(parsed.port) || parsed.port < 1 || !/^[a-f0-9-]{36}$/u.test(parsed.token ?? "")) throw new Error("operation lease residue exists");
    server = createServer(); try { await listen(parsed.port); } catch { throw new Error("operation is already running"); }
    await unlink(lock); await syncDirectory(root); const replacement = jsonBytes({ schemaVersion: 1, host: "127.0.0.1", port: parsed.port, token: randomUUID() }); try { await create(replacement); } catch (cause) { await close(); throw new Error("operation is already running", { cause }); } return async () => { try { const current = await existingBytes(lock, "operation lease"); if (!current?.equals(replacement)) throw new Error("operation lease changed concurrently"); await unlink(lock); await syncDirectory(root); } finally { await close(); } };
  }
  return async () => { try { const current = await existingBytes(lock, "operation lease"); if (!current?.equals(mine)) throw new Error("operation lease changed concurrently"); await unlink(lock); await syncDirectory(root); } finally { await close(); } };
}
function operationPath(root, name) { const file = path.resolve(root, name); if (!file.startsWith(`${root}${path.sep}`)) throw new Error("operation path escapes root"); return file; }
async function assertOperationRoot(repositoryRoot, operationRoot, { create = false } = {}) {
  const requested = absolute(operationRoot, "operation root"); const repository = await realpath(absolute(repositoryRoot, "repository root")); const parent = await realpath(path.dirname(requested)); const root = path.join(parent, path.basename(requested));
  if (root === repository || root.startsWith(`${repository}${path.sep}`)) throw new Error("operation root must be external to the repository");
  if (create) { await regularDirectory(parent, "operation root parent"); await mkdir(root, { mode: 0o700 }); await syncDirectory(parent); }
  await regularDirectory(root, "operation root"); return root;
}
async function assertOperationInventory(root, journal) {
  const names = (await readdir(root)).sort(textCompare); const bare = [JOURNAL, OBSERVATION]; const bases = [bare, [...bare, ".incheon-accessibility-registration.lock"]];
  const expected = bases.flatMap((base) => journal.phase === "PREPARED" ? [base.sort(textCompare)] : journal.phase === "PUBLISHING" ? [base, [...base, RECEIPT]].map((value) => value.sort(textCompare)) : [[...base, RECEIPT].sort(textCompare)]);
  if (!expected.some((value) => JSON.stringify(value) === JSON.stringify(names))) throw new Error("operation inventory is invalid");
}
function sourceInputs(repositoryRoot, inventory) {
  const source = inventory?.sources?.filter(({ id }) => id === SOURCE);
  if (source?.length !== 1 || source[0].requiredForProductionPack !== false || source[0].productionUseAllowed !== true) throw new Error("approved Incheon admission is not receipt-pending");
  const admission = source[0].admissionEvidence; const topology = source[0].accessibilityAdmissionEvidence;
  if (!admission || admission.issue !== 622 || admission.decision !== "APPROVED" || typeof admission.snapshotId !== "string" || !SHA.test(admission.rawSha256 ?? "") || !topology || topology.topologySourceId !== "incheon-transit-station-info" || typeof topology.topologySnapshotId !== "string" || !SHA.test(topology.topologyContentSha256 ?? "")) throw new Error("approved Incheon admission identity is invalid");
  const token = admission.snapshotId.match(/(\d{8}T\d{9}Z)$/u)?.[1]; if (!token) throw new Error("approved Incheon snapshot identity is invalid");
  const capturedAt = token.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)(\d{3})Z$/u, "$1-$2-$3T$4:$5:$6.$7Z");
  return { source, admission, topology, capturedAt, topologyPath: `tools/datapack/sources/${topology.topologySnapshotId}.json` };
}
async function sealPrepareInputs(repositoryRoot) {
  const inventoryPath = path.join(repositoryRoot, "tools/datapack/source-inventory.json"); const inventoryBytes = await regularBytes(inventoryPath, "source inventory"); const values = sourceInputs(repositoryRoot, parse(inventoryBytes, "source inventory"));
  const files = [
    ["tools/datapack/source-inventory.json", inventoryBytes],
    [values.topologyPath, await regularBytes(path.join(repositoryRoot, values.topologyPath), "admitted topology")],
    ["tools/datapack/fixtures/incheon-accessibility-raw/data-go-15083478.csv", await regularBytes(path.join(repositoryRoot, "tools/datapack/fixtures/incheon-accessibility-raw/data-go-15083478.csv"), "elevator fixture")],
    ["tools/datapack/fixtures/incheon-accessibility-raw/data-go-15010199.csv", await regularBytes(path.join(repositoryRoot, "tools/datapack/fixtures/incheon-accessibility-raw/data-go-15010199.csv"), "escalator fixture")],
    ["tools/datapack/fixtures/incheon-accessibility-raw/data-go-15146049.csv", await regularBytes(path.join(repositoryRoot, "tools/datapack/fixtures/incheon-accessibility-raw/data-go-15146049.csv"), "wheelchair fixture")],
  ];
  return { values, inputs: files.map(([relativePath, bytes]) => ({ relativePath, sha256: hash(bytes), byteLength: bytes.length })) };
}
async function assertPreparedInputs(repositoryRoot, journal) {
  const sealed = await sealPrepareInputs(repositoryRoot); const expected = JSON.stringify(journal.inputs); const actual = JSON.stringify(sealed.inputs);
  if (expected !== actual || journal.snapshotId !== sealed.values.admission.snapshotId || journal.capturedAt !== sealed.values.capturedAt) throw new Error("prepared Incheon inputs drifted");
  return sealed.values;
}
async function defaultAssertExactMain({ repositoryRoot, expectedMainSha }) {
  const run = async (args) => (await execFile("git", args, { cwd: repositoryRoot, encoding: "utf8" })).stdout.trim();
  const [head, remote, status] = await Promise.all([run(["rev-parse", "HEAD"]), run(["rev-parse", "origin/main"]), run(["status", "--porcelain=v1", "--untracked-files=all"])]);
  if (head !== expectedMainSha || remote !== expectedMainSha || status !== "") throw new Error("exact clean origin/main preflight failed");
}
async function defaultAssertPinnedMain({ repositoryRoot, expectedMainSha }) {
  const run = async (args) => (await execFile("git", args, { cwd: repositoryRoot, encoding: "utf8" })).stdout.trim();
  const [head, remote] = await Promise.all([run(["rev-parse", "HEAD"]), run(["rev-parse", "origin/main"])]);
  if (head !== expectedMainSha || remote !== expectedMainSha) throw new Error("exact origin/main preflight failed");
}
async function defaultAssertRecoveryState({ repositoryRoot, expectedMainSha, bindings }) {
  await defaultAssertPinnedMain({ repositoryRoot, expectedMainSha });
  const status = (await execFile("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repositoryRoot, encoding: "utf8" })).stdout.trimEnd();
  const targets = new Set(bindings.map(({ relativePath }) => relativePath));
  const residue = new Set(["tools/datapack/.incheon-accessibility-registration-transaction.json", "tools/datapack/.incheon-accessibility-registration.lock"]);
  for (const line of status.split("\n").filter(Boolean)) {
    const relativePath = line.slice(3); const ordinaryTarget = targets.has(relativePath) && [" M ", "?? "].includes(line.slice(0, 3)); const registrarResidue = residue.has(relativePath) && line.startsWith("?? ");
    if (!ordinaryTarget && !registrarResidue) throw new Error("registration recovery working tree drifted");
  }
}
function validBindings(entries, snapshotId) { return Array.isArray(entries) && entries.length === 6 && JSON.stringify(entries.map(({ relativePath }) => relativePath)) === JSON.stringify([`tools/datapack/sources/${snapshotId}.json`, ...FIXED_OUTPUTS]) && entries.every(({ relativePath, sha256, byteLength, beforeSha256 }) => relative(relativePath) && SHA.test(sha256 ?? "") && Number.isSafeInteger(byteLength) && byteLength > 0 && (beforeSha256 == null || SHA.test(beforeSha256))); }
function parseJournal(bytes) {
  const value = parse(bytes, "operation journal"); const allowed = ["FINALIZED", "PUBLISHED", "PUBLISHING", "PREPARED", "REGISTERING"];
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1 || !allowed.includes(value.phase) || !GIT_SHA.test(value.expectedMainSha ?? "") || ![value.repositoryRoot, value.operationRoot].every((entry) => typeof entry === "string" && path.isAbsolute(entry)) || !instant(value.preparedAt, "preparedAt") || !instant(value.capturedAt, "capturedAt") || !SNAPSHOT_ID.test(value.snapshotId ?? "") || !SHA.test(value.admissionRawSha256 ?? "") || !Array.isArray(value.inputs) || value.inputs.length !== 5 || value.inputs.some(({ relativePath, sha256, byteLength }) => !relative(relativePath) || !SHA.test(sha256 ?? "") || !Number.isSafeInteger(byteLength) || byteLength <= 0) || !Array.isArray(value.observation) || value.observation.length !== 3 || value.observation.some(({ relativePath, sha256, byteLength }) => !relative(relativePath) || !SHA.test(sha256 ?? "") || !Number.isSafeInteger(byteLength) || byteLength <= 0) || (value.bindings != null && !validBindings(value.bindings, value.snapshotId)) || (value.receiptSha256 != null && !SHA.test(value.receiptSha256))) throw new Error("operation journal is invalid");
  if (["PUBLISHED", "REGISTERING", "FINALIZED"].includes(value.phase) && (!SHA.test(value.receiptSha256 ?? "") || !instant(value.registrationAt, "registrationAt"))) throw new Error("operation journal lacks a verified OCI receipt");
  if (["REGISTERING", "FINALIZED"].includes(value.phase) && !validBindings(value.bindings, value.snapshotId)) throw new Error("operation journal lacks registration bindings");
  return value;
}
async function readJournal(root) { return parseJournal(await regularBytes(operationPath(root, JOURNAL), "operation journal")); }
async function recoverOperationJournalTemporary(root, journal) {
  const temporary = operationPath(root, `.${JOURNAL}.incheon-accessibility.write.tmp`); const bytes = await existingBytes(temporary, "operation journal temporary"); if (bytes == null) return;
  const next = parseJournal(bytes); const immediate = { PREPARED: "PUBLISHING", PUBLISHING: "PUBLISHED", PUBLISHED: "REGISTERING", REGISTERING: "FINALIZED" };
  if (next.phase !== immediate[journal.phase] || ["repositoryRoot", "operationRoot", "expectedMainSha", "snapshotId", "admissionRawSha256", "capturedAt"].some((key) => next[key] !== journal[key]) || JSON.stringify(next.inputs) !== JSON.stringify(journal.inputs) || JSON.stringify(next.observation) !== JSON.stringify(journal.observation)) throw new Error("operation journal temporary is foreign");
  await unlink(temporary); await syncDirectory(root);
}
async function writeJournal(root, current, next) { const bytes = jsonBytes(next); await atomicReplace(operationPath(root, JOURNAL), bytes, current == null ? null : jsonBytes(current)); return next; }
async function validateObservation(root, journal) {
  const directory = operationPath(root, OBSERVATION); await regularDirectory(directory, "operation observation"); const names = (await readdir(directory)).sort(textCompare); const manifestBytes = await regularBytes(path.join(directory, "observation.json"), "observation manifest"); const manifest = parse(manifestBytes, "observation manifest");
  if (manifest?.sourceId !== SOURCE || manifest.snapshotId !== journal.snapshotId || manifest.snapshotRawSha256 !== journal.admissionRawSha256 || manifest.capturedAt !== journal.capturedAt || !Array.isArray(names) || JSON.stringify(names) !== JSON.stringify(["observation.json", manifest.snapshotFile, manifest.rawArtifactFile].sort(textCompare))) throw new Error("prepared Incheon observation drifted");
  const current = await Promise.all(names.map(async (name) => { const bytes = await regularBytes(path.join(directory, name), "operation observation"); return { relativePath: name, sha256: hash(bytes), byteLength: bytes.length }; }));
  if (JSON.stringify(current) !== JSON.stringify(journal.observation)) throw new Error("prepared Incheon observation bytes drifted");
  return directory;
}
function outputBindings(outputs) { return outputs.map(({ relative, bytes, prestateBytes }) => ({ relativePath: relative, sha256: hash(bytes), byteLength: bytes.length, beforeSha256: prestateBytes == null ? null : hash(prestateBytes) })); }
function matchBindings(outputs, bindings) { return JSON.stringify(outputBindings(outputs)) === JSON.stringify(bindings); }
async function verifyBindings(repositoryRoot, bindings, snapshotId) { if (!validBindings(bindings, snapshotId)) throw new Error("registration bindings are invalid"); for (const entry of bindings) { const bytes = await regularBytes(path.join(repositoryRoot, entry.relativePath), "finalized registration output"); if (bytes.length !== entry.byteLength || hash(bytes) !== entry.sha256) throw new Error("finalized registration outputs drifted"); } }
async function verifyReceipt(root, journal) { const receipt = await regularBytes(operationPath(root, RECEIPT), "OCI receipt"); if (hash(receipt) !== journal.receiptSha256) throw new Error("OCI receipt drifted after publication"); return receipt; }

export async function prepareCurrentIncheonAccessibilityRegistration({ repositoryRoot = ROOT, operationRoot, expectedMainSha, assertExactMain = defaultAssertExactMain, acquireLease = acquireOperationLease, collector = runIncheonAccessibilityCollector, now = new Date() } = {}) {
  const repository = absolute(repositoryRoot, "repository root"); if (!GIT_SHA.test(expectedMainSha ?? "") || !(now instanceof Date) || Number.isNaN(now.valueOf())) throw new Error("Incheon preparation arguments are invalid");
  await assertExactMain({ repositoryRoot: repository, expectedMainSha }); const operation = await assertOperationRoot(repository, operationRoot, { create: true }); const release = await acquireLease(operation);
  try {
    const { values, inputs } = await sealPrepareInputs(repository); const observation = operationPath(operation, OBSERVATION);
    await collector(["--elevator-input", path.join(repository, inputs[2].relativePath), "--escalator-input", path.join(repository, inputs[3].relativePath), "--wheelchair-input", path.join(repository, inputs[4].relativePath), "--topology-snapshot", path.join(repository, values.topologyPath), "--observation-output", observation, "--captured-at", values.capturedAt]);
    const names = (await readdir(observation)).sort(textCompare); const observationBindings = await Promise.all(names.map(async (name) => { const bytes = await regularBytes(path.join(observation, name), "operation observation"); return { relativePath: name, sha256: hash(bytes), byteLength: bytes.length }; }));
    const journal = { schemaVersion: 1, phase: "PREPARED", repositoryRoot: repository, operationRoot: operation, expectedMainSha, preparedAt: now.toISOString(), snapshotId: values.admission.snapshotId, admissionRawSha256: values.admission.rawSha256, capturedAt: values.capturedAt, inputs, observation: observationBindings };
    await writeJournal(operation, null, journal); await assertOperationInventory(operation, journal); return journal;
  } catch (error) { await unlink(operationPath(operation, JOURNAL)).catch(() => {}); throw error; } finally { await release(); }
}

export async function finalizeCurrentIncheonAccessibilityRegistration({ repositoryRoot = ROOT, operationRoot, assertExactMain = defaultAssertExactMain, assertPinnedMain = defaultAssertPinnedMain, assertRecoveryState = defaultAssertRecoveryState, acquireLease = acquireOperationLease, publisher = publishIncheonAccessibilityRawArtifact, buildOutputs = buildReviewedIncheonAccessibilityRegistrationOutputs, commitOutputs = commitReviewedIncheonAccessibilityRegistrationOutputs, recoverRegistrar = recoverPendingReviewedIncheonAccessibilityRegistration, env = process.env, now = new Date() } = {}) {
  const repository = absolute(repositoryRoot, "repository root"); const operation = await assertOperationRoot(repository, operationRoot); const release = await acquireLease(operation);
  try { let journal = await readJournal(operation);
  if (journal.repositoryRoot !== repository || journal.operationRoot !== operation) throw new Error("operation journal location mismatch");
  await recoverOperationJournalTemporary(operation, journal);
  await assertOperationInventory(operation, journal);
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) throw new Error("Incheon finalization arguments are invalid");
  if (journal.phase === "FINALIZED") { await verifyReceipt(operation, journal); await verifyBindings(repository, journal.bindings, journal.snapshotId); return { status: "FINALIZED", targets: journal.bindings }; }
  if (["PREPARED", "PUBLISHING", "PUBLISHED"].includes(journal.phase)) { await assertExactMain({ repositoryRoot: repository, expectedMainSha: journal.expectedMainSha }); await assertPreparedInputs(repository, journal); }
  const observationRoot = await validateObservation(operation, journal); const receiptPath = operationPath(operation, RECEIPT);
  if (journal.phase === "PREPARED") {
    requireOciParBaseUrl(env);
    journal = await writeJournal(operation, journal, { ...journal, phase: "PUBLISHING" });
    await publisher({ observationRoot, receiptPath, repositoryRoot: repository, env, now });
    const receipt = await regularBytes(receiptPath, "OCI receipt"); await buildOutputs({ repositoryRoot: repository, observationRoot, receiptPath, now });
    journal = await writeJournal(operation, journal, { ...journal, phase: "PUBLISHED", receiptSha256: hash(receipt), registrationAt: now.toISOString() });
  } else if (journal.phase === "PUBLISHING") {
    const receipt = await existingBytes(receiptPath, "OCI receipt"); if (receipt == null) throw new Error("publication outcome is unresolved; refusing a second OCI PUT");
    await buildOutputs({ repositoryRoot: repository, observationRoot, receiptPath, now });
    journal = await writeJournal(operation, journal, { ...journal, phase: "PUBLISHED", receiptSha256: hash(receipt), registrationAt: now.toISOString() });
  }
  if (journal.phase === "PUBLISHED") {
    await verifyReceipt(operation, journal);
    const outputs = await buildOutputs({ repositoryRoot: repository, observationRoot, receiptPath, now: new Date(journal.registrationAt) }); const bindings = outputBindings(outputs);
    journal = await writeJournal(operation, journal, { ...journal, phase: "REGISTERING", bindings });
    await commitOutputs({ repositoryRoot: repository, outputs });
    await verifyBindings(repository, bindings, journal.snapshotId); journal = await writeJournal(operation, journal, { ...journal, phase: "FINALIZED" }); return { status: "FINALIZED", targets: bindings };
  }
  if (journal.phase === "REGISTERING") {
    await verifyReceipt(operation, journal);
    await recoverRegistrar({ repositoryRoot: repository });
    await assertRecoveryState({ repositoryRoot: repository, expectedMainSha: journal.expectedMainSha, bindings: journal.bindings });
    try { await verifyBindings(repository, journal.bindings, journal.snapshotId); } catch {
      await verifyReceipt(operation, journal);
      const outputs = await buildOutputs({ repositoryRoot: repository, observationRoot, receiptPath, now: new Date(journal.registrationAt) });
      if (!matchBindings(outputs, journal.bindings)) throw new Error("registration recovery bindings do not match the sealed plan");
      await commitOutputs({ repositoryRoot: repository, outputs }); await verifyBindings(repository, journal.bindings, journal.snapshotId);
    }
    journal = await writeJournal(operation, journal, { ...journal, phase: "FINALIZED" }); return { status: "FINALIZED", targets: journal.bindings };
  }
  throw new Error("operation phase is invalid");
  } finally { await release(); }
}

export function parseArgs(argv) {
  if (argv.length === 5 && argv[0] === "prepare" && argv[1] === "--operation-root" && argv[3] === "--expected-main-sha") return { phase: "prepare", operationRoot: argv[2], expectedMainSha: argv[4] };
  if (argv.length === 3 && argv[0] === "finalize" && argv[1] === "--operation-root") return { phase: "finalize", operationRoot: argv[2] };
  throw new Error("usage: prepare --operation-root <absolute-directory> --expected-main-sha <40-hex> | finalize --operation-root <absolute-directory>");
}
async function main(argv) { const args = parseArgs(argv); const result = args.phase === "prepare" ? await prepareCurrentIncheonAccessibilityRegistration(args) : await finalizeCurrentIncheonAccessibilityRegistration(args); process.stdout.write(`${JSON.stringify(result)}\n`); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
