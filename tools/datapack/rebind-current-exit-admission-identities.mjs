import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, open, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { canonicalCurrentExitAdmissionOciReceiptJson } from "./build-current-exit-admission-oci-receipt.mjs";
import { canonicalExitPathAdmissionJson } from "./build-exit-path-admission.mjs";
import {
  canonicalCurrentCapitalAccessibilityTransitionJson,
  readCurrentCapitalAccessibilityTransitionBoundary,
} from "./current-capital-accessibility-transition.mjs";
import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";
import {
  atomicReplace,
  readStableRegularFile,
} from "./rebind-current-candidate-source-snapshots.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TRANSITION = "tools/datapack/release/current-capital-accessibility-transition.json";
const EXIT_DIRECTORY = "tools/datapack/release/current-exit-admission-v2";
const EXIT_NORMALIZED = `${EXIT_DIRECTORY}/exit-path-normalized-source-snapshot.json`;
const EXIT_ADMISSION = `${EXIT_DIRECTORY}/exit-path-source-admission.json`;
const EXIT_RECEIPT = `${EXIT_DIRECTORY}/exit-path-admission-oci-receipt.json`;
const BOUNDARY_INPUTS = Object.freeze({
  transition: TRANSITION,
  candidate: "tools/datapack/release/candidate-build-spec.json",
  previous: "tools/datapack/release/current-station-line-accessibility/station-line-input.json",
  facility: "tools/datapack/release/current-capital-facility-source-admission.json",
  ledger: "tools/datapack/release/source-snapshots.json",
  inventory: "tools/datapack/source-inventory.json",
});
const JOURNAL = `${EXIT_DIRECTORY}/.exit-admission-identity-rebind.journal.json`;
const LOCK = `${EXIT_DIRECTORY}/.exit-admission-identity-rebind.lock`;

export function buildReboundCurrentExitAdmissionIdentities({ transitionBytes, normalizedBytes, admissionBytes, receiptBytes } = {}) {
  const transition = parseCanonical(transitionBytes, canonicalCurrentCapitalAccessibilityTransitionJson, "current accessibility transition");
  const normalized = parse(normalizedBytes, "starting EXIT normalized snapshot");
  if (canonicalJson(normalized) !== text(normalizedBytes, "starting EXIT normalized snapshot")) {
    throw new Error("starting EXIT normalized snapshot is not canonical");
  }
  const admission = parseCanonical(admissionBytes, canonicalExitPathAdmissionJson, "starting EXIT admission");
  const receipt = parseCanonical(receiptBytes, canonicalCurrentExitAdmissionOciReceiptJson, "starting EXIT OCI receipt", { newline: true });
  if (receipt.normalizedSnapshotSha256 !== sha256(normalizedBytes)
    || receipt.admissionSha256 !== sha256(admissionBytes)
    || receipt.admissionDigest !== admission.admissionDigest) {
    throw new Error("starting EXIT OCI receipt binding mismatch");
  }
  const candidateId = requiredString(transition.nextCandidate?.candidateId, "transition next candidateId");
  const sourceSetSha256 = requiredSha(transition.previousCandidate?.sourceSnapshotSetHash, "transition previous candidate source set");
  const rebound = structuredClone(admission);
  rebindCandidate(rebound.candidate, candidateId, sourceSetSha256, "EXIT admission candidate");
  for (const [label, rows] of [["EXIT admission cells", rebound.cells], ["EXIT materializer evidence", rebound.materializerEvidenceRows]]) {
    if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${label} are required`);
    for (const row of rows) rebindCandidate(row, candidateId, sourceSetSha256, label);
  }
  const beforeComparable = comparableAdmission(admission);
  const { admissionDigest: _ignoredDigest, ...unsignedAdmission } = rebound;
  rebound.admissionDigest = sha256(Buffer.from(canonicalJson(unsignedAdmission)));
  if (canonicalJson(beforeComparable) !== canonicalJson(comparableAdmission(rebound))) {
    throw new Error("EXIT identity rebind changed non-identity admission fields");
  }
  const reboundAdmissionBytes = Buffer.from(canonicalExitPathAdmissionJson(rebound));
  const reboundReceipt = {
    ...receipt,
    admissionSha256: sha256(reboundAdmissionBytes),
    admissionDigest: rebound.admissionDigest,
  };
  const { receiptSha256: _ignoredReceipt, ...unsignedReceipt } = reboundReceipt;
  reboundReceipt.receiptSha256 = sha256(Buffer.from(canonicalJson(unsignedReceipt)));
  if (canonicalJson(comparableReceipt(receipt)) !== canonicalJson(comparableReceipt(reboundReceipt))) {
    throw new Error("EXIT identity rebind changed provider or OCI receipt fields");
  }
  const reboundReceiptBytes = Buffer.from(`${canonicalCurrentExitAdmissionOciReceiptJson(reboundReceipt)}\n`);
  return { admissionBytes: reboundAdmissionBytes, receiptBytes: reboundReceiptBytes };
}

export async function buildReboundCurrentExitAdmissionIdentitiesFromRepository({ repositoryRoot = ROOT } = {}) {
  const root = path.resolve(repositoryRoot);
  const boundaryInput = await captureValidatedBoundary(root);
  const [normalizedBytes, admissionBytes, receiptBytes] = await Promise.all([
    readStableRegularFile(path.join(root, EXIT_NORMALIZED), "EXIT normalized snapshot"),
    readStableRegularFile(path.join(root, EXIT_ADMISSION), "EXIT admission"),
    readStableRegularFile(path.join(root, EXIT_RECEIPT), "EXIT OCI receipt"),
  ]);
  return buildReboundCurrentExitAdmissionIdentities({
    transitionBytes: boundaryInput.transition.bytes,
    normalizedBytes: normalizedBytes.bytes,
    admissionBytes: admissionBytes.bytes,
    receiptBytes: receiptBytes.bytes,
  });
}

export async function applyReboundCurrentExitAdmissionIdentities({
  repositoryRoot = ROOT,
  atomicReplaceImpl = atomicReplace,
  beforeCommit = async () => {},
  failAfter = async () => {},
  crashAfter = async () => false,
} = {}) {
  const root = path.resolve(repositoryRoot);
  const releaseLock = await acquireLock(root);
  try {
    await recoverJournal({ root, atomicReplaceImpl });
    return await apply();
  } finally {
    await releaseLock();
  }

  async function apply() {
  const targets = {
    normalized: [path.join(root, EXIT_NORMALIZED), "EXIT normalized snapshot"],
    admission: [path.join(root, EXIT_ADMISSION), "EXIT admission"],
    receipt: [path.join(root, EXIT_RECEIPT), "EXIT OCI receipt"],
  };
  const boundaryInput = await captureValidatedBoundary(root);
  const entries = await Promise.all(Object.entries(targets).map(async ([key, [target, label]]) =>
    [key, await readStableRegularFile(target, label)]));
  const input = Object.fromEntries(entries);
  const result = buildReboundCurrentExitAdmissionIdentities({
    transitionBytes: boundaryInput.transition.bytes,
    normalizedBytes: input.normalized.bytes,
    admissionBytes: input.admission.bytes,
    receiptBytes: input.receipt.bytes,
  });
  await beforeCommit({ root, input, result });
  await Promise.all(Object.values(boundaryInput).map(assertUnchanged));
  await Promise.all(Object.values(input).map(assertUnchanged));
  const journal = makeJournal(input, result);
  await writeJournal(root, journal);
  try {
    await replace("admission", result.admissionBytes);
    await failAfter({ stage: "admission" });
    if (await crashAfter({ stage: "admission" })) throw new CrashResidueError();
    await replace("receipt", result.receiptBytes);
    await failAfter({ stage: "receipt" });
    if (await crashAfter({ stage: "receipt" })) throw new CrashResidueError();
  } catch (error) {
    if (error instanceof CrashResidueError) {
      throw new Error("EXIT identity rebind interrupted with recovery journal", { cause: error });
    }
    try { await recoverJournal({ root, atomicReplaceImpl }); }
    catch (recoveryError) { throw new AggregateError([error, recoveryError], "EXIT identity rebind rollback failed"); }
    throw error;
  }

  await verifyJournalOutputs(root, journal, "after");
  const journalSnapshot = await readStableRegularFile(path.join(root, JOURNAL), "EXIT identity rebind journal");
  await atomicReplace(path.join(root, JOURNAL), Buffer.from(JSON.stringify({ ...journal, state: "COMMITTED" })), {
    original: journalSnapshot,
  });
  const committed = { ...journal, state: "COMMITTED" };
  await verifyJournalOutputs(root, committed, "after");
  await removeJournal(root);
  const [finalAdmission, finalReceipt] = await Promise.all([
    readStableRegularFile(input.admission.target, "EXIT admission"),
    readStableRegularFile(input.receipt.target, "EXIT OCI receipt"),
  ]);
  return { admission: finalAdmission, receipt: finalReceipt, result };

  async function replace(key, bytes) {
    const original = input[key];
    await atomicReplaceImpl(original.target, bytes, { original });
    const replacement = await readStableRegularFile(original.target, original.label);
    if (!sameBytes(replacement.bytes, bytes)) {
      throw new Error(`${original.label} replacement verification failed`);
    }
  }
  }
}

function parseCanonical(bytes, canonicalizer, label, { newline = false } = {}) {
  const value = parse(bytes, label);
  const expected = `${canonicalizer(value)}${newline ? "\n" : ""}`;
  if (text(bytes, label) !== expected) throw new Error(`${label} is not canonical`);
  return value;
}
function parse(bytes, label) {
  const source = text(bytes, label);
  try { return JSON.parse(source); } catch { throw new Error(`${label} is invalid JSON`); }
}
function text(bytes, label) {
  if (!Buffer.isBuffer(bytes)) throw new Error(`${label} bytes are required`);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error(`${label} must be UTF-8`); }
}
function requiredString(value, label) {
  if (typeof value !== "string" || value === "") throw new Error(`${label} is required`);
  return value;
}
function requiredSha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} mismatch`);
  return value;
}
function rebindCandidate(value, candidateId, sourceSetSha256, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.candidateId !== "string" || !Object.hasOwn(value, "sourceSetSha256")) {
    throw new Error(`${label} candidate identity mismatch`);
  }
  value.candidateId = candidateId;
  value.sourceSetSha256 = sourceSetSha256;
}
function comparableAdmission(value) {
  const copy = structuredClone(value);
  delete copy.admissionDigest;
  eraseCandidate(copy.candidate);
  for (const rows of [copy.cells, copy.materializerEvidenceRows]) for (const row of rows) eraseCandidate(row);
  return copy;
}
function eraseCandidate(value) {
  value.candidateId = "";
  value.sourceSetSha256 = "";
}
function comparableReceipt(value) {
  const copy = structuredClone(value);
  delete copy.admissionSha256;
  delete copy.admissionDigest;
  delete copy.receiptSha256;
  return copy;
}
function sameBytes(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.equals(right);
}
function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.mode === right.mode;
}
async function assertUnchanged(snapshot) {
  const reread = await readStableRegularFile(snapshot.target, snapshot.label);
  if (!sameIdentity(snapshot.identity, reread.identity) || !sameBytes(snapshot.bytes, reread.bytes)) {
    throw new Error(`${snapshot.label} changed during EXIT identity rebind`);
  }
}
async function captureValidatedBoundary(root) {
  const input = Object.fromEntries(await Promise.all(Object.entries(BOUNDARY_INPUTS).map(async ([key, relative]) =>
    [key, await readStableRegularFile(path.join(root, relative), `transition ${key}`)])));
  await readCurrentCapitalAccessibilityTransitionBoundary({ repositoryRoot: root });
  await Promise.all(Object.values(input).map(assertUnchanged));
  return input;
}

class CrashResidueError extends Error {}

function journalPath(root) { return path.join(root, JOURNAL); }
function lockPath(root) { return path.join(root, LOCK); }
function ownerPath(root) { return path.join(lockPath(root), "owner.json"); }
function outputRecords(input, result) {
  return [
    outputRecord(EXIT_ADMISSION, input.admission.bytes, result.admissionBytes),
    outputRecord(EXIT_RECEIPT, input.receipt.bytes, result.receiptBytes),
  ];
}
function outputRecord(relative, before, after) {
  return {
    relative, before: before.toString("base64"), beforeSha256: sha256(before),
    after: after.toString("base64"), afterSha256: sha256(after),
  };
}
function makeJournal(input, result) {
  return { schemaVersion: 1, state: "PREPARED", outputs: outputRecords(input, result) };
}
function validateJournal(journal) {
  if (journal?.schemaVersion !== 1 || !["PREPARED", "COMMITTED"].includes(journal.state)
    || !Array.isArray(journal.outputs) || journal.outputs.length !== 2
    || journal.outputs.some(({ relative }, index) => relative !== [EXIT_ADMISSION, EXIT_RECEIPT][index])) {
    throw new Error("EXIT identity rebind journal is invalid");
  }
  for (const output of journal.outputs) {
    const before = Buffer.from(output.before ?? "", "base64");
    const after = Buffer.from(output.after ?? "", "base64");
    if (typeof output.before !== "string" || typeof output.after !== "string"
      || !before.length || !after.length || output.beforeSha256 !== sha256(before)
      || output.afterSha256 !== sha256(after)) {
      throw new Error("EXIT identity rebind journal bytes are invalid");
    }
  }
  return journal;
}
async function acquireLock(root) {
  const token = randomUUID();
  try {
    await mkdir(lockPath(root), { mode: 0o700 });
    await syncDirectory(path.dirname(lockPath(root)));
    await writeOwner(root, { token, pid: process.pid });
  }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    await reclaimDeadLock(root);
    await mkdir(lockPath(root), { mode: 0o700 });
    await syncDirectory(path.dirname(lockPath(root)));
    await writeOwner(root, { token, pid: process.pid });
  }
  return async () => {
    const owner = await readOwner(root);
    if (owner.token !== token) throw new Error("EXIT identity rebind lock ownership changed");
    await unlink(ownerPath(root));
    await syncDirectory(lockPath(root));
    await rmdir(lockPath(root));
    await syncDirectory(path.dirname(lockPath(root)));
  }
}
function validateOwner(owner) {
  if (!owner || typeof owner.token !== "string" || !/^[0-9a-f-]{36}$/u.test(owner.token)
    || !Number.isInteger(owner.pid) || owner.pid <= 0) {
    throw new Error("EXIT identity rebind lock owner is invalid");
  }
  return owner;
}
async function writeOwner(root, owner) {
  const target = ownerPath(root);
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(Buffer.from(JSON.stringify(owner))); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(lockPath(root));
}
async function readOwnerSnapshot(root) {
  const snapshot = await readStableRegularFile(ownerPath(root), "EXIT identity rebind lock owner");
  return { snapshot, owner: validateOwner(JSON.parse(snapshot.bytes.toString("utf8"))) };
}
async function readOwner(root) { return (await readOwnerSnapshot(root)).owner; }
function ownerIsLive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}
async function reclaimDeadLock(root) {
  const first = await readOwnerSnapshot(root);
  if (ownerIsLive(first.owner.pid)) throw new Error("EXIT identity rebind lock owner is live");
  const second = await readOwnerSnapshot(root);
  if (!sameIdentity(first.snapshot.identity, second.snapshot.identity)
    || !sameBytes(first.snapshot.bytes, second.snapshot.bytes) || ownerIsLive(second.owner.pid)) {
    throw new Error("EXIT identity rebind lock owner changed during reclaim");
  }
  await unlink(ownerPath(root));
  await syncDirectory(lockPath(root));
  await rmdir(lockPath(root));
  await syncDirectory(path.dirname(lockPath(root)));
}
async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function writeJournal(root, journal) {
  const target = journalPath(root);
  const parent = path.dirname(target);
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(Buffer.from(JSON.stringify(journal))); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(parent);
}
async function removeJournal(root) {
  await unlink(journalPath(root));
  await syncDirectory(path.dirname(journalPath(root)));
}
async function readJournal(root) {
  try {
    const snapshot = await readStableRegularFile(journalPath(root), "EXIT identity rebind journal");
    return validateJournal(JSON.parse(snapshot.bytes.toString("utf8")));
  } catch (error) {
    if (error?.cause?.code === "ENOENT" || error?.code === "ENOENT") return null;
    throw error;
  }
}
async function verifyJournalOutputs(root, journal, field) {
  await Promise.all(journal.outputs.map(async (output) => {
    const current = await readStableRegularFile(path.join(root, output.relative), `EXIT journal ${output.relative}`);
    if (!sameBytes(current.bytes, Buffer.from(output[field], "base64"))) {
      throw new Error(`EXIT identity rebind ${field} verification failed: ${output.relative}`);
    }
  }));
}
async function recoverJournal({ root, atomicReplaceImpl }) {
  const journal = await readJournal(root);
  if (!journal) return;
  const current = await Promise.all(journal.outputs.map(async (output) => ({
    output,
    snapshot: await readStableRegularFile(path.join(root, output.relative), `EXIT journal ${output.relative}`),
  })));
  const state = current.map(({ output, snapshot }) => {
    if (sameBytes(snapshot.bytes, Buffer.from(output.before, "base64"))) return "before";
    if (sameBytes(snapshot.bytes, Buffer.from(output.after, "base64"))) return "after";
    return "unknown";
  });
  if (state.includes("unknown")) {
    throw new Error("EXIT identity rebind journal contains foreign output bytes; recovery refused");
  }
  const desired = journal.state === "PREPARED" ? "before" : "after";
  for (const [index, entry] of current.entries()) {
    if (state[index] === desired) continue;
    await atomicReplaceImpl(entry.snapshot.target, Buffer.from(entry.output[desired], "base64"), {
      original: entry.snapshot,
    });
  }
  await verifyJournalOutputs(root, journal, desired);
  await removeJournal(root);
}

function parseArgs(argv) {
  if (argv.length !== 0) throw new Error("EXIT identity rebind takes no arguments");
}
async function main(argv) {
  parseArgs(argv);
  const applied = await applyReboundCurrentExitAdmissionIdentities();
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    admissionSha256: sha256(applied.admission.bytes),
    receiptSha256: sha256(applied.receipt.bytes),
  })}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
