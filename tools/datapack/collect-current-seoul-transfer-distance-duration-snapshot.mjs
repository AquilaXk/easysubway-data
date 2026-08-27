#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { codepointCompare } from "../lib/codepoint-compare.mjs";
import { normalizeDataGoKrServiceKey } from "./lib/provider-call-integrity.mjs";
import { CANDIDATES_PATH, sanitizeErrorMessage } from "./lib/source-candidate-evidence-collector.mjs";
import { validateAuthenticatedTransferObservation } from "./build-current-transfer-topology-metrics.mjs";

const SOURCE_ID = "seoul-metro-transfer-distance-duration";
const EXPECTED_ROW_COUNT = 145;
const PER_PAGE = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const REQUIRED_FIELDS = Object.freeze(["연번", "호선", "환승역명", "환승노선", "환승거리", "환승소요시간"]);
const SNAPSHOT_FILES = Object.freeze(["manifest.json", "observation.json", "raw-snapshot.json"]);

export async function collectCurrentSeoulTransferDistanceDurationSnapshot({
  candidatesDocument,
  env = process.env,
  fetchImpl = fetch,
  now = new Date(),
  output,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  runnerTemp = env.RUNNER_TEMP,
  serviceKey = env.DATA_GO_KR_SERVICE_KEY,
} = {}) {
  const normalizedServiceKey = normalizeDataGoKrServiceKey(serviceKey);
  const outputDirectory = requiredAbsolutePath(output, "output");
  const tempDirectory = requiredAbsolutePath(runnerTemp, "RUNNER_TEMP");
  await assertTaskOwnedOutput(outputDirectory, tempDirectory);
  const document = candidatesDocument ?? JSON.parse(await readFile(CANDIDATES_PATH, "utf8"));
  const endpoint = resolveTrackedEndpoint(document);
  const capturedAt = requiredDate(now);
  let collection;
  try {
    collection = await collectAllPages({ endpoint, fetchImpl, rawServiceKey: serviceKey, requestTimeoutMs, serviceKey: normalizedServiceKey });
  } catch (error) {
    throw new Error(sanitize(error, serviceKey, normalizedServiceKey));
  }
  const { pages, rows } = collection;
  const rawSnapshot = { artifactKind: "seoul-transfer-distance-duration-raw-snapshot", sourceId: SOURCE_ID, pages };
  const rawBytes = canonicalBytes(rawSnapshot);
  const schema = { fields: REQUIRED_FIELDS };
  const manifest = {
    artifactKind: "seoul-transfer-distance-duration-snapshot-manifest",
    sourceId: SOURCE_ID,
    endpointSha256: sha256(endpoint),
    capturedAt,
    freshnessDate: "2025-12-31",
    rowCount: rows.length,
    rawSha256: sha256(rawBytes),
    contentSha256: sha256(canonicalBytes(rows)),
    schemaSha256: sha256(canonicalBytes(schema)),
    credentialRedacted: true,
  };
  const observation = {
    artifactKind: "seoul-transfer-distance-duration-observation",
    sourceId: SOURCE_ID,
    capturedAt,
    rowCount: rows.length,
    rawSha256: manifest.rawSha256,
    contentSha256: manifest.contentSha256,
    rows,
    credentialRedacted: true,
  };
  await publishAtomicDirectory(outputDirectory, tempDirectory, {
    "manifest.json": canonicalBytes(manifest),
    "observation.json": canonicalBytes(observation),
    "raw-snapshot.json": rawBytes,
  });
  return manifest;
}

export function resolveTrackedEndpoint(document) {
  const candidate = document?.candidates?.find((entry) => entry?.id === SOURCE_ID);
  const endpoint = candidate?.operation?.endpoint;
  if (candidate?.requestUrl !== endpoint || candidate?.evidence?.endpoint !== endpoint
    || candidate?.operation?.method !== "GET" || candidate?.operation?.auth?.env !== "DATA_GO_KR_SERVICE_KEY"
    || candidate?.operation?.auth?.parameter !== "serviceKey" || candidate?.operation?.auth?.placement !== "query"
    || candidate?.operation?.auth?.valueEncoding !== "url-search-params-once"
    || candidate?.operation?.auth?.loadPolicy !== "process-env-no-shell-parsing"
    || JSON.stringify(candidate?.operation?.requiredParameters) !== JSON.stringify(["serviceKey", "page", "perPage", "returnType"])
    || JSON.stringify(candidate?.evidence?.outputFields) !== JSON.stringify(REQUIRED_FIELDS)
    || !candidate?.evidence?.coverageLimitations?.includes("145개 환승역(2025-12-31 기준) 커버")) {
    throw new Error("tracked Seoul transfer endpoint contract mismatch");
  }
  let url;
  try { url = new URL(endpoint); } catch { throw new Error("tracked Seoul transfer endpoint contract mismatch"); }
  if (url.protocol !== "https:" || url.origin !== "https://api.odcloud.kr" || url.search || url.username || url.password || url.hash) {
    throw new Error("tracked Seoul transfer endpoint contract mismatch");
  }
  return url.href;
}

// Rebuild the private manifest and observation only from a previously locked
// canonical raw snapshot.  This intentionally has no provider, OCI, or output
// side effect: the caller supplies bytes obtained through its separately
// authorized immutable-object read and the receipt that already binds them.
export async function reconstructSeoulTransferObservationFromRawSnapshot({ rawBytes, receipt, candidatesDocument } = {}) {
  if (!Buffer.isBuffer(rawBytes)) throw new Error("transfer raw snapshot bytes are required");
  const document = candidatesDocument ?? JSON.parse(await readFile(CANDIDATES_PATH, "utf8"));
  const endpoint = resolveTrackedEndpoint(document);
  validateReconstructionReceipt(receipt, rawBytes);
  let rawSnapshot;
  try { rawSnapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBytes)); } catch { throw new Error("transfer raw snapshot must be strict UTF-8 JSON"); }
  if (!rawBytes.equals(canonicalBytes(rawSnapshot))) throw new Error("transfer raw snapshot must use canonical bytes");
  if (rawSnapshot?.artifactKind !== "seoul-transfer-distance-duration-raw-snapshot" || rawSnapshot.sourceId !== SOURCE_ID || !Array.isArray(rawSnapshot.pages) || rawSnapshot.pages.length !== 2) {
    throw new Error("transfer raw snapshot identity mismatch");
  }
  const rows = reconstructRows(rawSnapshot);
  const capturedAt = receipt.capturedAt;
  const manifest = {
    artifactKind: "seoul-transfer-distance-duration-snapshot-manifest",
    sourceId: SOURCE_ID,
    endpointSha256: sha256(endpoint),
    capturedAt,
    freshnessDate: "2025-12-31",
    rowCount: rows.length,
    rawSha256: sha256(rawBytes),
    contentSha256: sha256(canonicalBytes(rows)),
    schemaSha256: sha256(canonicalBytes({ fields: REQUIRED_FIELDS })),
    credentialRedacted: true,
  };
  const observation = {
    artifactKind: "seoul-transfer-distance-duration-observation",
    sourceId: SOURCE_ID,
    capturedAt,
    rowCount: rows.length,
    rawSha256: manifest.rawSha256,
    contentSha256: manifest.contentSha256,
    rows,
    credentialRedacted: true,
  };
  const manifestBytes = canonicalBytes(manifest);
  const observationBytes = canonicalBytes(observation);
  if (sha256(manifestBytes) !== receipt.manifestSha256 || sha256(observationBytes) !== receipt.observationSha256) {
    throw new Error("transfer reconstruction receipt identity mismatch");
  }
  validateSeoulTransferObservationFiles({ manifest, observation, rawSnapshot, manifestBytes, observationBytes, rawBytes });
  return { manifest, observation, rawSnapshot, manifestBytes, observationBytes, rawBytes };
}

export async function writeReconstructedSeoulTransferObservation({ output, runnerTemp, reconstruction } = {}) {
  const outputDirectory = requiredAbsolutePath(output, "output");
  const tempDirectory = requiredAbsolutePath(runnerTemp, "RUNNER_TEMP");
  if (!reconstruction || !Buffer.isBuffer(reconstruction.manifestBytes) || !Buffer.isBuffer(reconstruction.observationBytes) || !Buffer.isBuffer(reconstruction.rawBytes)) {
    throw new Error("transfer reconstruction bytes are required");
  }
  validateSeoulTransferObservationFiles(reconstruction);
  await assertTaskOwnedOutput(outputDirectory, tempDirectory);
  await publishAtomicDirectory(outputDirectory, tempDirectory, {
    "manifest.json": reconstruction.manifestBytes,
    "observation.json": reconstruction.observationBytes,
    "raw-snapshot.json": reconstruction.rawBytes,
  });
}

function validateReconstructionReceipt(receipt, rawBytes) {
  if (receipt?.sourceId !== SOURCE_ID || typeof receipt.snapshotId !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(receipt.capturedAt ?? "")
    || Number.isNaN(Date.parse(receipt.capturedAt)) || !Number.isSafeInteger(receipt.byteSize) || receipt.byteSize !== rawBytes.length
    || !/^[0-9a-f]{64}$/u.test(receipt.snapshotRawSha256 ?? "") || !/^[0-9a-f]{64}$/u.test(receipt.rawObjectSha256 ?? "")
    || !/^[0-9a-f]{64}$/u.test(receipt.manifestSha256 ?? "") || !/^[0-9a-f]{64}$/u.test(receipt.observationSha256 ?? "")
    || receipt.snapshotRawSha256 !== sha256(rawBytes) || receipt.rawObjectSha256 !== sha256(rawBytes)) {
    throw new Error("transfer reconstruction receipt mismatch");
  }
}

function reconstructRows(rawSnapshot) {
  const rows = [];
  for (const [index, page] of rawSnapshot.pages.entries()) {
    if (!Number.isInteger(page?.page) || page.page !== index + 1 || page.perPage !== PER_PAGE || typeof page.base64 !== "string"
      || Buffer.from(page.base64, "base64").toString("base64") !== page.base64 || page.sha256 !== sha256(Buffer.from(page.base64, "base64"))) {
      throw new Error("transfer raw page identity mismatch");
    }
    let envelope;
    try { envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(page.base64, "base64"))); } catch { throw new Error("transfer raw page encoding mismatch"); }
    validateEnvelope(envelope, { expectedCurrent: index === 0 ? PER_PAGE : EXPECTED_ROW_COUNT - PER_PAGE, page: index + 1, totalCount: EXPECTED_ROW_COUNT });
    rows.push(...envelope.data.map(normalizeRow));
  }
  const serials = new Set(rows.map((row) => row["연번"]));
  if (rows.length !== EXPECTED_ROW_COUNT || serials.size !== EXPECTED_ROW_COUNT || [...serials].some((serial) => serial < 1 || serial > EXPECTED_ROW_COUNT)
    || [...serials].sort((left, right) => left - right).some((serial, index) => serial !== index + 1)) {
    throw new Error("transfer raw snapshot rows mismatch");
  }
  return rows.sort((left, right) => codepointCompare(REQUIRED_FIELDS.map((field) => left[field]).join("\u0000"), REQUIRED_FIELDS.map((field) => right[field]).join("\u0000")));
}

async function collectAllPages({ endpoint, fetchImpl, rawServiceKey, requestTimeoutMs, serviceKey }) {
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 0 || requestTimeoutMs > REQUEST_TIMEOUT_MS) {
    throw new Error("request timeout must be a bounded integer");
  }
  const rows = [];
  const pages = [];
  let totalCount;
  for (let page = 1; page <= Math.ceil(EXPECTED_ROW_COUNT / PER_PAGE); page += 1) {
    const request = new URL(endpoint);
    request.searchParams.set("serviceKey", serviceKey);
    request.searchParams.set("page", String(page));
    request.searchParams.set("perPage", String(PER_PAGE));
    request.searchParams.set("returnType", "JSON");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    let response;
    let bytes;
    try {
      response = await fetchImpl(request, { signal: controller.signal, redirect: "error" });
      if (!response?.ok) throw new Error("ODCloud HTTP response is not successful");
      bytes = Buffer.from(await response.arrayBuffer());
    }
    catch (error) { throw new Error(`request failed: ${error instanceof Error ? error.message : "unknown"}`); }
    finally { clearTimeout(timer); }
    let envelope;
    try {
      envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch { throw new Error("ODCloud response is not strict UTF-8 JSON"); }
    assertCredentialAbsent(bytes, serviceKey);
    assertDecodedCredentialAbsent(envelope, rawServiceKey, serviceKey);
    const expectedCurrent = page === 1 ? PER_PAGE : EXPECTED_ROW_COUNT - PER_PAGE;
    validateEnvelope(envelope, { expectedCurrent, page, totalCount });
    totalCount ??= envelope.totalCount;
    rows.push(...envelope.data.map(normalizeRow));
    pages.push({ page, perPage: PER_PAGE, sha256: sha256(bytes), base64: bytes.toString("base64") });
  }
  if (totalCount !== EXPECTED_ROW_COUNT || rows.length !== EXPECTED_ROW_COUNT) throw new Error("ODCloud total is incomplete");
  const serials = new Set(rows.map((row) => row["연번"]));
  if (serials.size !== rows.length || [...serials].some((serial) => serial < 1 || serial > EXPECTED_ROW_COUNT)
    || [...serials].sort((left, right) => left - right).some((serial, index) => serial !== index + 1)) {
    throw new Error("ODCloud serial set mismatch");
  }
  return { pages, rows: rows.sort((left, right) => codepointCompare(
    REQUIRED_FIELDS.map((field) => left[field]).join("\u0000"),
    REQUIRED_FIELDS.map((field) => right[field]).join("\u0000"),
  )) };
}

function validateEnvelope(value, { expectedCurrent, page, totalCount }) {
  if (value == null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort(codepointCompare).join(",") !== "currentCount,data,matchCount,page,perPage,totalCount"
    || !Array.isArray(value.data) || value.currentCount !== expectedCurrent || value.data.length !== expectedCurrent
    || value.page !== page || value.perPage !== PER_PAGE || value.totalCount !== EXPECTED_ROW_COUNT
    || value.matchCount !== EXPECTED_ROW_COUNT || (totalCount !== undefined && value.totalCount !== totalCount)) {
    throw new Error("ODCloud success envelope mismatch");
  }
}

// #350 reuses this #339 validator for post-collection private observation
// admission. It does not issue requests or write output.
export function validateSeoulTransferObservationFiles({ manifest, observation, rawSnapshot, manifestBytes, observationBytes, rawBytes }) {
  if (manifest?.artifactKind !== "seoul-transfer-distance-duration-snapshot-manifest" || manifest.sourceId !== SOURCE_ID
    || observation?.artifactKind !== "seoul-transfer-distance-duration-observation" || observation.sourceId !== SOURCE_ID
    || rawSnapshot?.artifactKind !== "seoul-transfer-distance-duration-raw-snapshot" || rawSnapshot.sourceId !== SOURCE_ID
    || !Buffer.isBuffer(manifestBytes) || !Buffer.isBuffer(observationBytes) || !Buffer.isBuffer(rawBytes)
    || Object.keys(manifest).sort(codepointCompare).join(",") !== "artifactKind,capturedAt,contentSha256,credentialRedacted,endpointSha256,freshnessDate,rawSha256,rowCount,schemaSha256,sourceId"
    || Object.keys(observation).sort(codepointCompare).join(",") !== "artifactKind,capturedAt,contentSha256,credentialRedacted,rawSha256,rowCount,rows,sourceId"
    || Object.keys(rawSnapshot).sort(codepointCompare).join(",") !== "artifactKind,pages,sourceId"
    || !manifestBytes.equals(canonicalBytes(manifest)) || !observationBytes.equals(canonicalBytes(observation)) || !rawBytes.equals(canonicalBytes(rawSnapshot))
    || manifest.capturedAt !== observation.capturedAt || manifest.rowCount !== EXPECTED_ROW_COUNT || observation.rowCount !== EXPECTED_ROW_COUNT
    || manifest.freshnessDate !== "2025-12-31" || manifest.credentialRedacted !== true || observation.credentialRedacted !== true
    || !/^[0-9a-f]{64}$/u.test(manifest.endpointSha256 ?? "") || manifest.schemaSha256 !== sha256(canonicalBytes({ fields: REQUIRED_FIELDS }))
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(manifest.capturedAt) || Number.isNaN(Date.parse(manifest.capturedAt))
    || manifest.rawSha256 !== sha256(rawBytes) || manifest.contentSha256 !== sha256(canonicalBytes(observation.rows))
    || observation.rawSha256 !== manifest.rawSha256 || observation.contentSha256 !== manifest.contentSha256 || !Array.isArray(rawSnapshot.pages) || rawSnapshot.pages.length !== 2) {
    throw new Error("transfer observation identity mismatch");
  }
  const rows = [];
  for (const [index, page] of rawSnapshot.pages.entries()) {
    if (!Number.isInteger(page?.page) || page.page !== index + 1 || page.perPage !== PER_PAGE || typeof page.base64 !== "string" || Buffer.from(page.base64, "base64").toString("base64") !== page.base64 || page.sha256 !== sha256(Buffer.from(page.base64, "base64"))) throw new Error("transfer raw page identity mismatch");
    let envelope; try { envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(page.base64, "base64"))); } catch { throw new Error("transfer raw page encoding mismatch"); }
    validateEnvelope(envelope, { expectedCurrent: index === 0 ? PER_PAGE : EXPECTED_ROW_COUNT - PER_PAGE, page: index + 1, totalCount: EXPECTED_ROW_COUNT });
    rows.push(...envelope.data.map(normalizeRow));
  }
  const serials = new Set(rows.map((row) => row["연번"]));
  if (rows.length !== EXPECTED_ROW_COUNT || serials.size !== EXPECTED_ROW_COUNT || [...serials].some((serial) => serial < 1 || serial > EXPECTED_ROW_COUNT) || JSON.stringify(rows.sort((left, right) => codepointCompare(REQUIRED_FIELDS.map((field) => left[field]).join("\0"), REQUIRED_FIELDS.map((field) => right[field]).join("\0")))) !== JSON.stringify(observation.rows)) throw new Error("transfer observation rows mismatch");
  return true;
}

// This is deliberately separate from collection: registration and publication
// consume the exact private three-file snapshot without changing collection IO.
export async function readSeoulTransferObservationDirectory(directory, { openImpl = open, readdirImpl = readdir, sourceCandidatesBytes } = {}) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) throw new Error("transfer observation directory must be absolute");
  const root = path.resolve(directory);
  const parent = await lstat(root);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("transfer observation directory must be a regular non-symlink directory");
  const names = (await readdirImpl(root)).sort(codepointCompare);
  if (JSON.stringify(names) !== JSON.stringify([...SNAPSHOT_FILES].sort(codepointCompare))) throw new Error("transfer observation inventory must contain exactly three files");
  const read = async (name) => {
    const target = path.join(root, name);
    let handle;
    try { handle = await openImpl(target, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { throw new Error(`transfer observation ${name} must be a regular non-symlink file`, { cause: error }); }
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new Error(`transfer observation ${name} must be a regular non-symlink file`);
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
        throw new Error(`transfer observation ${name} changed during read`);
      }
      return bytes;
    } finally { await handle.close(); }
  };
  const [manifestBytes, observationBytes, rawBytes] = await Promise.all(SNAPSHOT_FILES.map(read));
  let manifest; let observation; let rawSnapshot;
  try {
    manifest = JSON.parse(manifestBytes);
    observation = JSON.parse(observationBytes);
    rawSnapshot = JSON.parse(rawBytes);
  } catch { throw new Error("transfer observation must be JSON"); }
  validateSeoulTransferObservationFiles({ manifest, observation, rawSnapshot, manifestBytes, observationBytes, rawBytes });
  if (sourceCandidatesBytes !== undefined) {
    validateAuthenticatedTransferObservation({
      observation: { manifest, observation, raw: rawSnapshot, bytes: { manifest: manifestBytes, observation: observationBytes, raw: rawBytes } },
      sourceCandidatesBytes,
    });
  }
  return { directory: root, manifest, observation, rawSnapshot, manifestBytes, observationBytes, rawBytes };
}

function normalizeRow(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort(codepointCompare).join(",") !== [...REQUIRED_FIELDS].sort(codepointCompare).join(",")) throw new Error("ODCloud row schema mismatch");
  if (!Number.isInteger(value["연번"]) || value["연번"] < 1
    || !(Number.isInteger(value["호선"]) && value["호선"] > 0)
      && !(typeof value["호선"] === "string" && /^[1-9]\d*호선$/u.test(value["호선"]))
    || typeof value["환승역명"] !== "string" || value["환승역명"].trim() === ""
    || typeof value["환승노선"] !== "string" || value["환승노선"].trim() === ""
    || !Number.isInteger(value["환승거리"]) || value["환승거리"] < 0
    || !validDuration(value["환승소요시간"])) {
    throw new Error("ODCloud required field type mismatch");
  }
  return Object.fromEntries(REQUIRED_FIELDS.map((field) => [field, value[field]]));
}

function assertCredentialAbsent(bytes, serviceKey) {
  if (bytes.includes(Buffer.from(serviceKey, "utf8"))
    || bytes.includes(Buffer.from(encodeURIComponent(serviceKey), "utf8"))
    || bytes.includes(Buffer.from(new URLSearchParams([["serviceKey", serviceKey]]).toString().slice("serviceKey=".length), "utf8"))) {
    throw new Error("ODCloud response contains credential reflection");
  }
}

function assertDecodedCredentialAbsent(value, rawServiceKey, normalizedServiceKey) {
  if (typeof value === "string") {
    if (value.includes(rawServiceKey) || value.includes(normalizedServiceKey)) {
      throw new Error("ODCloud response contains credential reflection");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertDecodedCredentialAbsent(entry, rawServiceKey, normalizedServiceKey);
    return;
  }
  if (value != null && typeof value === "object") {
    for (const entry of Object.values(value)) assertDecodedCredentialAbsent(entry, rawServiceKey, normalizedServiceKey);
  }
}

function validDuration(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{2}):(\d{2})$/u.exec(value.trim());
  return match != null && Number(match[1]) <= 59 && Number(match[2]) <= 59;
}

async function assertTaskOwnedOutput(output, runnerTemp) {
  const temp = await lstat(runnerTemp);
  if (!temp.isDirectory() || temp.isSymbolicLink() || path.dirname(output) !== runnerTemp) throw new Error("output must be a direct RUNNER_TEMP child");
  try { await lstat(output); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
  throw new Error("output directory must be absent");
}

async function publishAtomicDirectory(output, runnerTemp, entries) {
  const stage = await mkdtemp(path.join(runnerTemp, ".seoul-transfer-snapshot-"));
  try {
    for (const [name, bytes] of Object.entries(entries)) await writeFile(path.join(stage, name), bytes, { flag: "wx", mode: 0o600 });
    const inventory = (await readdir(stage)).sort(codepointCompare);
    if (JSON.stringify(inventory) !== JSON.stringify(SNAPSHOT_FILES)) throw new Error("snapshot output inventory mismatch");
    await assertTaskOwnedOutput(output, runnerTemp);
    await rename(stage, output);
  } catch (error) { await rm(stage, { force: true, recursive: true }); throw error; }
}

function canonicalBytes(value) { return Buffer.from(`${JSON.stringify(value)}\n`, "utf8"); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function requiredAbsolutePath(value, label) { if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`); return path.resolve(value); }
function requiredDate(value) { if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new Error("now must be a valid date"); return value.toISOString(); }
function sanitize(error, raw, normalized) { const first = sanitizeErrorMessage(error, raw); return normalized === raw ? first : sanitizeErrorMessage(new Error(first), normalized); }

function parseCli(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--output-dir") throw new Error("arguments must be --output-dir <absolute path>");
  return argv[1];
}
async function main(argv = process.argv.slice(2)) {
  const manifest = await collectCurrentSeoulTransferDistanceDurationSnapshot({ output: parseCli(argv) });
  console.log(JSON.stringify({ result: "PASS", sourceId: manifest.sourceId, rowCount: manifest.rowCount, credentialRedacted: true }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
    .catch((error) => { console.error(sanitize(error, process.env.DATA_GO_KR_SERVICE_KEY ?? "", "")); process.exitCode = 1; });
}
