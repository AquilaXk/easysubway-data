import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../lib/is-main-module.mjs";
import { buildKricCurrentStationLineObservation } from "./build-kric-current-station-line-observation.mjs";
import { buildKricNationwideTimetableObservation } from "./build-kric-nationwide-timetable-observation.mjs";
import { buildKricRetainedFilePendingHandoff } from "./build-kric-retained-file-pending-handoff.mjs";
import { createCandidateOciClient } from "./publish-candidate-oci-artifact.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const GIT_SHA = /^[a-f0-9]{40}$/u;
const MAXIMUM_WORKBOOK_BYTES = 128 * 1024 * 1024;
const MAXIMUM_RECEIPT_BYTES = 64 * 1024;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : !value || typeof value !== "object" ? value : Object.fromEntries(Object.keys(value).sort((left, right) => left.localeCompare(right)).map((key) => [key, canonical(value[key])]));
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(canonical(value))}\n`);
const fail = (code) => { throw new Error(`KRIC_RETAINED_FILE_OPERATION_${code}`); };

/**
 * Creates a deliberately non-releasable retained-file evidence bundle.  This
 * operation has no resume path: an operation directory is proof of a prior run.
 */
export async function runKricRetainedFileOperation({
  repositoryRoot = ROOT, operationRoot, timetableInputPath, timetableReceiptPath,
  stationLineInputPath, stationLineReceiptPath, expectedMainSha, operationId,
  assertExactMain = defaultExactMain, publisher, env = process.env,
} = {}) {
  const root = requiredAbsolute(repositoryRoot, "REPOSITORY");
  const operation = requiredAbsolute(operationRoot, "OPERATION_ROOT");
  const mainSha = requiredSha(expectedMainSha, "MAIN_SHA");
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(operationId ?? "")) fail("OPERATION_ID");

  await assertMain(assertExactMain, root, mainSha);
  await assertAbsent(operation);
  const physicalRoot = await physicalPath(root, "REPOSITORY");
  const physicalOperation = path.join(await physicalPath(path.dirname(operation), "OPERATION_ROOT"), path.basename(operation));
  if (inside(physicalRoot, physicalOperation) || physicalOperation === physicalRoot) fail("OPERATION_ROOT");
  const timetableFile = await readPrivateExternalFile(timetableInputPath, physicalRoot, "TIMETABLE_INPUT", MAXIMUM_WORKBOOK_BYTES);
  const stationLineFile = await readPrivateExternalFile(stationLineInputPath, physicalRoot, "STATION_LINE_INPUT", MAXIMUM_WORKBOOK_BYTES);
  const timetableReceipt = await readStrictReceipt(timetableReceiptPath, physicalRoot, "TIMETABLE_RECEIPT");
  const stationLineReceipt = await readStrictReceipt(stationLineReceiptPath, physicalRoot, "STATION_LINE_RECEIPT");

  const timetableObservation = await buildKricNationwideTimetableObservation({
    inputFile: timetableFile.path, workbookBytes: timetableFile.bytes, receipt: timetableReceipt,
  });
  const stationLineObservation = buildKricCurrentStationLineObservation({ workbookBytes: stationLineFile.bytes, receipt: stationLineReceipt });
  const handoff = buildKricRetainedFilePendingHandoff({ timetableObservation, timetableReceipt, stationLineObservation, stationLineReceipt });
  const sourceObjects = [
    sourceObjectPair(timetableObservation, timetableFile.bytes),
    sourceObjectPair(stationLineObservation, stationLineFile.bytes),
  ];
  const provenance = canonical({
    repository: "AquilaXk/easysubway-data", mainSha, operationId,
    sources: sourceObjects.map(({ sourceId, raw, observation }) => ({ sourceId, raw: objectIdentity(raw), observation: objectIdentity(observation) })),
  });
  const releaseTuple = canonical({
    artifactKind: "kric-retained-file-pending-release-tuple", status: "PENDING",
    decision: "CONTRACT_GAP", releaseEligible: false,
    provenanceSha256: sha256(jsonBytes(provenance)), handoffSha256: handoff.handoffSha256,
  });
  const bundle = canonical({
    schemaVersion: 1, artifactKind: "kric-retained-file-operation-bundle",
    status: "PENDING", decision: "CONTRACT_GAP", releaseEligible: false,
    receipts: { timetable: canonical(timetableReceipt), stationLine: canonical(stationLineReceipt) },
    handoff, provenance, releaseTuple,
  });
  const bundleBytes = jsonBytes(bundle);
  const bundleSha256 = sha256(bundleBytes);
  const objects = [
    sourceObjects[0].raw,
    sourceObjects[1].raw,
    sourceObjects[0].observation,
    sourceObjects[1].observation,
    { kind: "bundle", key: `kric-retained-file-operations/${bundleSha256}.json`, bytes: bundleBytes, sha256: sha256(bundleBytes) },
  ];
  if (!bundleBytes.equals(jsonBytes(bundle))) fail("BUNDLE");

  const storage = publisher ?? defaultPublisher(env);
  await mkdir(operation, { mode: 0o700 });
  const journalPath = path.join(operation, "journal.json");
  const receiptPath = path.join(operation, "publication-receipt.json");
  await writeAtomic(journalPath, { schemaVersion: 1, operationId, expectedMainSha: mainSha, phase: "PREPARED" });
  const created = [];
  const published = [];
  try {
    await writeAtomic(journalPath, { schemaVersion: 1, operationId, expectedMainSha: mainSha, phase: "PUBLISHING" });
    for (const object of objects) published.push(await putAndVerify(storage, object, (identity) => created.push(identity)));
    const finalJournal = { schemaVersion: 1, operationId, expectedMainSha: mainSha, phase: "TERMINAL_PENDING", objects: published };
    await writeAtomic(journalPath, finalJournal);
    const receipt = canonical({
      schemaVersion: 1, artifactKind: "kric-retained-file-publication-receipt",
      status: "PENDING", decision: "CONTRACT_GAP", releaseEligible: false, operationId,
      bundleSha256, handoffSha256: handoff.handoffSha256, provenanceSha256: releaseTuple.provenanceSha256,
      releaseTuple, objects: published,
    });
    await writeAtomic(receiptPath, receipt);
    return Object.freeze({ operationRoot: operation, bundle, receipt });
  } catch (error) {
    await rm(receiptPath, { force: true });
    await writeAtomic(journalPath, {
      schemaVersion: 1, operationId, expectedMainSha: mainSha, phase: "TERMINAL_FAILED",
      createdObjects: created, verifiedObjects: published,
    });
    throw error;
  }
}

function sourceObjectPair(observation, rawBytes) {
  const date = observation.observedAt.slice(0, 10).replaceAll("-", "");
  const observationBytes = Buffer.from(`${JSON.stringify(observation)}\n`);
  return {
    sourceId: observation.sourceId,
    raw: { kind: `${observation.sourceId}-raw`, key: `source-raw/${observation.sourceId}/${date}/${observation.rawSha256}.xlsx`, bytes: Buffer.from(rawBytes), sha256: observation.rawSha256 },
    observation: { kind: `${observation.sourceId}-observation`, key: `source-observation/${observation.sourceId}/${date}/${observation.recordsSha256}.json`, bytes: observationBytes, sha256: sha256(observationBytes) },
  };
}
function objectIdentity(object) { return canonical({ objectKey: object.key, sizeBytes: object.bytes.length, sha256: object.sha256 }); }
async function putAndVerify(publisher, object, onCreated) {
  if (!publisher || typeof publisher.putObjectIfAbsent !== "function" || typeof publisher.fullGet !== "function") fail("PUBLISHER");
  let created;
  try { created = await publisher.putObjectIfAbsent(object.key, object.bytes); } catch { fail("PUBLISH"); }
  if (created !== true) fail("COLLISION");
  onCreated(objectIdentity(object));
  let body;
  try { body = await publisher.fullGet(object.key); } catch { fail("FULL_GET"); }
  if (!(body instanceof Uint8Array) || body.byteLength !== object.bytes.byteLength || sha256(body) !== object.sha256) fail("FULL_GET");
  return canonical({ kind: object.kind, objectKey: object.key, sizeBytes: object.bytes.length, sha256: object.sha256, fullGet: { sizeBytes: body.byteLength, sha256: sha256(body) } });
}
async function readPrivateExternalFile(input, root, label, maximumBytes) {
  const value = requiredAbsolute(input, label); const physical = await physicalPath(value, label);
  if (inside(root, physical) || physical === root) fail(label);
  let stat; try { stat = await lstat(value); } catch { fail(label); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) fail(label);
  let handle;
  try {
    handle = await open(value, constants.O_RDONLY | constants.O_NOFOLLOW); const current = await handle.stat();
    if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino
      || (current.mode & 0o777) !== 0o600 || current.size < 1 || current.size > maximumBytes) fail(label);
    const bytes = Buffer.alloc(current.size); const read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== bytes.length) fail(label); return { path: value, bytes };
  } finally { await handle?.close(); }
}
async function readStrictReceipt(input, root, label) {
  const file = await readPrivateExternalFile(input, root, label, MAXIMUM_RECEIPT_BYTES); let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)); } catch { fail(label); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(label);
  return value;
}
async function assertAbsent(value) { try { await lstat(value); fail("OPERATION_EXISTS"); } catch (error) { if (error?.message?.startsWith("KRIC_RETAINED_FILE_OPERATION_")) throw error; if (error?.code !== "ENOENT") fail("OPERATION_ROOT"); } }
async function writeAtomic(target, value) { const temp = `${target}.tmp`; const bytes = jsonBytes(value); const handle = await open(temp, "wx", 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } await rename(temp, target); const directory = await open(path.dirname(target), "r"); try { await directory.sync(); } finally { await directory.close(); } }
async function physicalPath(value, label) { try { return await realpath(value); } catch { fail(label); } }
function requiredAbsolute(value, label) { if (typeof value !== "string" || !path.isAbsolute(value)) fail(label); return path.resolve(value); }
function requiredSha(value, label) { if (typeof value !== "string" || !GIT_SHA.test(value)) fail(label); return value; }
function inside(root, target) { return path.relative(root, target) !== "" && !path.relative(root, target).startsWith(`..${path.sep}`) && path.relative(root, target) !== ".."; }
async function assertMain(check, repositoryRoot, expectedMainSha) { const actual = await check({ repositoryRoot, expectedMainSha }); if (actual !== undefined && actual !== expectedMainSha) fail("MAIN_SHA"); }
async function defaultExactMain({ repositoryRoot, expectedMainSha }) { const { execFile } = await import("node:child_process"); const { promisify } = await import("node:util"); const run = promisify(execFile); const [{ stdout: head }, { stdout: upstream }, { stdout: status }] = await Promise.all([run("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot }), run("git", ["rev-parse", "origin/main"], { cwd: repositoryRoot }), run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repositoryRoot })]); if (status !== "" || head.trim() !== upstream.trim() || head.trim() !== expectedMainSha) fail("EXACT_MAIN"); return head.trim(); }
function defaultPublisher(env) { const required = ["EASYSUBWAY_CANDIDATE_OCI_NAMESPACE", "EASYSUBWAY_CANDIDATE_OCI_BUCKET", "EASYSUBWAY_CANDIDATE_OCI_REGION", "EASYSUBWAY_CANDIDATE_OCI_ACCESS_KEY", "EASYSUBWAY_CANDIDATE_OCI_SECRET_KEY"]; if (!env || required.some((key) => typeof env[key] !== "string" || env[key] === "")) fail("OCI_ENV"); const client = createCandidateOciClient(env); return { putObjectIfAbsent: (key, bytes) => client.putObjectIfAbsent(key, bytes), async fullGet(key) { const result = await client.readObject(key); if (!result.exists) throw new Error("OCI full GET failed"); return result.body; } }; }

export function parseKricRetainedFileOperationArgs(argv) {
  const names = ["operation-root", "timetable-input", "timetable-receipt", "station-line-input", "station-line-receipt", "expected-main-sha", "operation-id"];
  if (argv.length !== names.length * 2) fail("ARGUMENTS");
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    if (typeof option !== "string" || !option.startsWith("--")) fail("ARGUMENTS");
    const name = option.slice(2); const value = argv[index + 1];
    if (!names.includes(name) || name in args || typeof value !== "string" || value.startsWith("--")) fail("ARGUMENTS");
    args[name] = value;
  }
  if (names.some((name) => !(name in args))) fail("ARGUMENTS");
  return args;
}

async function main() {
  const args = parseKricRetainedFileOperationArgs(process.argv.slice(2));
  const result = await runKricRetainedFileOperation({
    operationRoot: args["operation-root"], timetableInputPath: args["timetable-input"],
    timetableReceiptPath: args["timetable-receipt"], stationLineInputPath: args["station-line-input"],
    stationLineReceiptPath: args["station-line-receipt"], expectedMainSha: args["expected-main-sha"],
    operationId: args["operation-id"],
  });
  process.stdout.write(`${JSON.stringify({ phase: "TERMINAL_PENDING", bundleSha256: result.receipt.bundleSha256, handoffSha256: result.receipt.handoffSha256 })}\n`);
}

export function sanitizedOperationError(error) {
  return typeof error?.message === "string" && error.message.startsWith("KRIC_RETAINED_FILE_OPERATION_")
    ? error.message
    : "KRIC_RETAINED_FILE_OPERATION_FAILED";
}

if (isMainModule(import.meta.url)) main().catch((error) => { console.error(sanitizedOperationError(error)); process.exitCode = 1; });
