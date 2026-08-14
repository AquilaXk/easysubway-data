#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

import {
  buildMolitRailwayTransferMovementSnapshot,
  MOLIT_RAILWAY_TRANSFER_MOVEMENT_SOURCE_ID,
  MOLIT_RAILWAY_TRANSFER_MOVEMENT_SNAPSHOT_ID,
} from "./collect-molit-railway-transfer-movement.mjs";
import { normalizeDataGoKrServiceKey } from "./lib/provider-call-integrity.mjs";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";

const ENDPOINT = "https://api.odcloud.kr/api/15130556/v1/uddi:93021737-5337-442c-9006-b9748f87d0a4";
const SNAPSHOT_PATH = "tools/datapack/sources/molit-railway-transfer-movement-20250811.csv.gz";
const METADATA_PATH = `${SNAPSHOT_PATH}.json`;
const CANDIDATES_PATH = "tools/datapack/source-candidates.json";
const PER_PAGE = 1000;
const REQUEST_TIMEOUT_MILLIS = 15_000;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_OFFICIAL_FILE_BYTES = 4 * 1024 * 1024;
const TLS_AUTHORIZATION_ERROR_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERROR_IN_CERT_NOT_AFTER_FIELD",
  "ERROR_IN_CERT_NOT_BEFORE_FIELD",
  "ERROR_IN_CRL_LAST_UPDATE_FIELD",
  "ERROR_IN_CRL_NEXT_UPDATE_FIELD",
  "INVALID_CA",
  "INVALID_PURPOSE",
  "PATH_LENGTH_EXCEEDED",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_DECRYPT_CRL_SIGNATURE",
  "UNABLE_TO_GET_CRL",
  "UNABLE_TO_GET_CRL_ISSUER",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);
const PROVIDER_COLUMNS = Object.freeze([
  "철도운영기관코드", "선명", "역명", "환승이동순서", "이동내용상세", "환승이동내용",
]);
const COLUMN_PROJECTION = Object.freeze({
  철도운영기관코드: "RAIL_OPR_ISTT_CD",
  선명: "LN_NM",
  역명: "STIN_NM",
  환승이동순서: "CHTN_MV_TP_ORDR",
  이동내용상세: "MV_CONT_DTL",
  환승이동내용: "CHTN_MV_CONT",
});
const ENVELOPE_KEYS = Object.freeze([
  "currentCount", "data", "matchCount", "page", "perPage", "totalCount",
]);

function fail(code) {
  throw new Error(`MOLIT_TRANSFER_REVALIDATION_${code}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactKeys(value, keys) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) fail("SCHEMA");
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("SCHEMA");
  }
}

function parseArgs(argv) {
  const allowed = new Set(["observed-at", "official-file", "output"]);
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    const key = option?.startsWith("--") ? option.slice(2) : "";
    if (!allowed.has(key) || typeof value !== "string" || value === "" || Object.hasOwn(args, key)) {
      fail("ARGUMENT");
    }
    args[key] = value;
  }
  const expectedArgumentCount = Object.hasOwn(args, "official-file") ? 3 : 2;
  if (Object.keys(args).length !== expectedArgumentCount
    || !path.isAbsolute(args.output)
    || (Object.hasOwn(args, "official-file") && !path.isAbsolute(args["official-file"]))) {
    fail("ARGUMENT");
  }
  const observedAtMillis = requiredUtcInstant(args["observed-at"], "observedAt");
  if (new Date(observedAtMillis).toISOString() !== args["observed-at"]) fail("ARGUMENT");
  return {
    observedAt: args["observed-at"],
    officialFile: args["official-file"] ? path.resolve(args["official-file"]) : null,
    output: path.resolve(args.output),
  };
}

async function assertAbsentOutput(output) {
  try {
    await lstat(output);
    fail("OUTPUT");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let parent;
  try {
    parent = await lstat(path.dirname(output));
  } catch {
    fail("OUTPUT");
  }
  if (!parent.isDirectory() || parent.isSymbolicLink()) fail("OUTPUT");
}

async function loadLockedSnapshot(repositoryRoot, readFileImpl) {
  try {
    const [metadataBytes, gzipBytes, candidatesBytes] = await Promise.all([
      readFileImpl(path.join(repositoryRoot, METADATA_PATH)),
      readFileImpl(path.join(repositoryRoot, SNAPSHOT_PATH)),
      readFileImpl(path.join(repositoryRoot, CANDIDATES_PATH)),
    ]);
    const metadata = JSON.parse(metadataBytes);
    const candidates = JSON.parse(candidatesBytes);
    const candidate = candidates.candidates?.filter(({ id }) => id === MOLIT_RAILWAY_TRANSFER_MOVEMENT_SOURCE_ID);
    if (candidate?.length !== 1) fail("SNAPSHOT");
    validateCandidate(candidate[0], metadata, metadataBytes, gzipBytes);
    const rebuilt = buildMolitRailwayTransferMovementSnapshot({
      bytes: gunzipSync(gzipBytes),
      capturedAt: metadata.capturedAt,
    });
    const {
      gzipBytes: ignoredGzipBytes,
      gzipSha256: ignoredRebuiltGzipSha256,
      rows,
      ...rebuiltMetadata
    } = rebuilt;
    const { gzipSha256: ignoredMetadataGzipSha256, ...logicalMetadata } = metadata;
    if (JSON.stringify({ ...rebuiltMetadata, gzipPath: path.basename(SNAPSHOT_PATH) })
      !== JSON.stringify(logicalMetadata)) fail("SNAPSHOT");
    return {
      metadata,
      metadataFileSha256: sha256(metadataBytes),
      rows,
    };
  } catch (error) {
    if (/^MOLIT_TRANSFER_REVALIDATION_/u.test(error?.message ?? "")) throw error;
    fail("SNAPSHOT");
  }
}

function validateCandidate(candidate, metadata, metadataBytes, gzipBytes) {
  const operation = candidate.operation;
  const admission = candidate.rawSnapshotAdmission;
  if (candidate.requestUrl !== ENDPOINT
    || operation?.method !== "GET"
    || operation.endpoint !== ENDPOINT
    || operation.auth?.env !== "DATA_GO_KR_SERVICE_KEY"
    || operation.auth?.placement !== "query"
    || operation.auth?.parameter !== "serviceKey"
    || JSON.stringify(operation.requiredParameters) !== JSON.stringify(["serviceKey", "page", "perPage", "returnType"])
    || admission?.snapshotId !== MOLIT_RAILWAY_TRANSFER_MOVEMENT_SNAPSHOT_ID
    || admission.metadataPath !== METADATA_PATH
    || admission.metadataFileSha256 !== sha256(metadataBytes)
    || admission.rawSha256 !== metadata.rawSha256
    || admission.gzipSha256 !== metadata.gzipSha256
    || admission.gzipSha256 !== sha256(gzipBytes)
    || admission.rowCount !== metadata.rowCount
    || admission.status !== "LOCKED") fail("SNAPSHOT");
}

function requestUrl(serviceKey, page) {
  const url = new URL(ENDPOINT);
  url.searchParams.set("serviceKey", serviceKey);
  url.searchParams.set("page", String(page));
  url.searchParams.set("perPage", String(PER_PAGE));
  url.searchParams.set("returnType", "JSON");
  return url;
}

async function fetchPage({ fetchImpl, serviceKey, page, expectedTotalCount }) {
  let response;
  try {
    response = await fetchImpl(requestUrl(serviceKey, page), {
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLIS),
    });
  } catch (error) {
    fail(classifyTransportFailure(error));
  }
  if (!response || !Number.isSafeInteger(response.status)) fail("PROVIDER_NETWORK");
  if (!response.ok) fail(classifyHttpFailure(response.status));
  if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")) {
    fail("PROVIDER_CONTENT_TYPE");
  }
  const bytes = await readBoundedResponseBody(response);
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("SCHEMA");
  }
  exactKeys(document, ENVELOPE_KEYS);
  if (!Number.isSafeInteger(document.currentCount)
    || !Number.isSafeInteger(document.matchCount)
    || !Number.isSafeInteger(document.page)
    || !Number.isSafeInteger(document.perPage)
    || !Number.isSafeInteger(document.totalCount)
    || !Array.isArray(document.data)
    || document.currentCount !== document.data.length
    || document.page !== page
    || document.perPage !== PER_PAGE
    || document.totalCount !== document.matchCount
    || document.totalCount !== expectedTotalCount
    || document.currentCount !== Math.min(PER_PAGE, expectedTotalCount - ((page - 1) * PER_PAGE))) {
    fail("PAGINATION");
  }
  return {
    rows: document.data.map(canonicalProviderRow),
    responseSha256: sha256(bytes),
  };
}

function classifyTransportFailure(error) {
  const code = error?.cause?.code ?? error?.code;
  if (new Set(["ENOTFOUND", "EAI_AGAIN"]).has(code)) return "PROVIDER_DNS";
  if (typeof code === "string" && (code.startsWith("ERR_TLS_")
    || code.startsWith("CERT_")
    || code.startsWith("CRL_")
    || TLS_AUTHORIZATION_ERROR_CODES.has(code))) {
    return "PROVIDER_TLS";
  }
  if (error?.name === "TimeoutError" || error?.name === "AbortError"
    || new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"])
      .has(code)) return "PROVIDER_TIMEOUT";
  return "PROVIDER_NETWORK";
}

function classifyHttpFailure(status) {
  if (status === 401 || status === 403) return "PROVIDER_HTTP_AUTHORIZATION";
  if (status === 429) return "PROVIDER_HTTP_RATE_LIMIT";
  if (status >= 500 && status <= 599) return "PROVIDER_HTTP_SERVER";
  return "PROVIDER_HTTP_OTHER";
}

async function readBoundedResponseBody(response) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength) || !Number.isSafeInteger(Number(contentLength))) {
      try { await response.body?.cancel(); } catch {}
      fail("PROVIDER_BODY");
    }
    if (Number(contentLength) > MAX_PAGE_BYTES) {
      try { await response.body?.cancel(); } catch {}
      fail("PROVIDER_BODY_TOO_LARGE");
    }
  }
  const reader = response.body?.getReader?.();
  if (!reader) fail("PROVIDER_BODY");
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) fail("PROVIDER_BODY");
      totalBytes += value.byteLength;
      if (totalBytes > MAX_PAGE_BYTES) {
        try { await reader.cancel(); } catch {}
        fail("PROVIDER_BODY_TOO_LARGE");
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } catch (error) {
    try { await reader.cancel(); } catch {}
    if (/^MOLIT_TRANSFER_REVALIDATION_/u.test(error?.message ?? "")) throw error;
    if (classifyTransportFailure(error) === "PROVIDER_TIMEOUT") fail("PROVIDER_TIMEOUT");
    fail("PROVIDER_BODY");
  }
  if (totalBytes === 0) fail("PROVIDER_BODY");
  return Buffer.concat(chunks, totalBytes);
}

function canonicalProviderRow(row) {
  exactKeys(row, PROVIDER_COLUMNS);
  const projected = {};
  for (const providerColumn of PROVIDER_COLUMNS) {
    const canonicalColumn = COLUMN_PROJECTION[providerColumn];
    const value = row[providerColumn];
    if (providerColumn === "환승이동순서") {
      if ((typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
        && (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value))) fail("SCHEMA");
      projected[canonicalColumn] = String(value);
    } else {
      if (typeof value !== "string" || /[\u0000-\u001f\u007f]/u.test(value)) fail("SCHEMA");
      projected[canonicalColumn] = value;
    }
  }
  if (["RAIL_OPR_ISTT_CD", "LN_NM", "STIN_NM"].some((key) => projected[key].trim() === "")) {
    fail("SCHEMA");
  }
  return projected;
}

async function collectProviderObservation({ fetchImpl, serviceKey, locked }) {
  const pageCount = Math.ceil(locked.metadata.rowCount / PER_PAGE);
  if (pageCount < 1 || pageCount > 100) fail("PAGINATION");
  const rows = [];
  const pageResponseSha256 = [];
  for (let page = 1; page <= pageCount; page += 1) {
    const result = await fetchPage({
      fetchImpl,
      serviceKey,
      page,
      expectedTotalCount: locked.metadata.rowCount,
    });
    rows.push(...result.rows);
    pageResponseSha256.push(result.responseSha256);
  }
  const sortedRows = [...rows].sort((left, right) => compareText(JSON.stringify(left), JSON.stringify(right)));
  const canonicalRowsSha256 = sha256(JSON.stringify(sortedRows));
  if (rows.length !== locked.metadata.rowCount
    || canonicalRowsSha256 !== locked.metadata.sortedContentSha256) fail("CONTENT");
  return { pageCount, pageResponseSha256, canonicalRowsSha256, totalCount: rows.length };
}

async function readOfficialFile(filePath, fixture) {
  let handle;
  try {
    handle = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAX_OFFICIAL_FILE_BYTES) {
      fail("OFFICIAL_FILE");
    }
    await fixture.afterStat?.();
    const readCapacity = Math.min(before.size + 1, MAX_OFFICIAL_FILE_BYTES + 1);
    fixture.onReadCapacity?.(readCapacity);
    const buffer = Buffer.allocUnsafe(readCapacity);
    let offset = 0;
    while (offset < readCapacity) {
      const { bytesRead } = await handle.read(buffer, offset, readCapacity - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const bytes = buffer.subarray(0, offset);
    const after = await handle.stat();
    if (!after.isFile()
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || bytes.length !== before.size) {
      fail("OFFICIAL_FILE");
    }
    return bytes;
  } catch (error) {
    if (/^MOLIT_TRANSFER_REVALIDATION_/u.test(error?.message ?? "")) throw error;
    fail("OFFICIAL_FILE");
  } finally {
    try { await handle?.close(); } catch {}
  }
}

async function collectOfficialFileObservation({ filePath, locked, fixture }) {
  const bytes = await readOfficialFile(filePath, fixture);
  let rebuilt;
  try {
    rebuilt = buildMolitRailwayTransferMovementSnapshot({
      bytes,
      capturedAt: locked.metadata.capturedAt,
    });
  } catch {
    fail("CONTENT");
  }
  if (rebuilt.rawSha256 !== locked.metadata.rawSha256
    || rebuilt.rowCount !== locked.metadata.rowCount
    || rebuilt.schemaFingerprint !== locked.metadata.schemaFingerprint
    || rebuilt.sortedContentSha256 !== locked.metadata.sortedContentSha256
    || rebuilt.rows.length !== locked.rows.length) {
    fail("CONTENT");
  }
  return {
    rawSha256: rebuilt.rawSha256,
    byteSize: bytes.length,
    canonicalRowsSha256: rebuilt.sortedContentSha256,
    totalCount: rebuilt.rowCount,
  };
}

function buildEvidence({ observedAt, locked, observation, operation }) {
  const payload = {
    schemaVersion: 1,
    artifactKind: "current-molit-transfer-source-revalidation-evidence",
    contractVersion: "1.0.0",
    sourceId: MOLIT_RAILWAY_TRANSFER_MOVEMENT_SOURCE_ID,
    snapshotId: MOLIT_RAILWAY_TRANSFER_MOVEMENT_SNAPSHOT_ID,
    observedAt,
    operation,
    lockedSnapshot: {
      metadataPath: METADATA_PATH,
      metadataFileSha256: locked.metadataFileSha256,
      rawSha256: locked.metadata.rawSha256,
      gzipSha256: locked.metadata.gzipSha256,
      sortedContentSha256: locked.metadata.sortedContentSha256,
      rowCount: locked.metadata.rowCount,
    },
    providerObservation: observation,
    outcome: "NO_CHANGE_REVALIDATED",
    credentialRedacted: true,
  };
  return { ...payload, evidenceHash: sha256(JSON.stringify(payload)) };
}

function sameOwnedFile(file, identity) {
  return file.isFile()
    && !file.isSymbolicLink()
    && file.dev === identity.dev
    && file.ino === identity.ino
    && file.size === identity.size;
}

function sameValidatedFile(file, identity) {
  return sameOwnedFile(file, identity) && (file.mode & 0o777) === 0o600;
}

async function removeOwnedFile(filePath, identity) {
  try {
    const current = await lstat(filePath);
    if (sameOwnedFile(current, identity)) await unlink(filePath);
  } catch {}
}

async function publishEvidence(output, evidence, fixture) {
  const temporary = `${output}.tmp-${randomUUID()}`;
  let handle;
  let opened;
  let completed;
  let linked = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    opened = await handle.stat();
    if (!opened.isFile()) fail("PUBLISH");
    const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
    completed = await handle.stat();
    if (!completed.isFile() || (completed.mode & 0o777) !== 0o600
      || completed.dev !== opened.dev || completed.ino !== opened.ino
      || completed.size !== bytes.length) fail("PUBLISH");
    await handle.close();
    handle = undefined;
    await link(temporary, output);
    linked = true;
    await fixture.afterLink?.({ output, temporary });
    const published = await lstat(output);
    if (!sameValidatedFile(published, completed)) fail("PUBLISH");
    await unlink(temporary);
  } catch (error) {
    try { await handle?.close(); } catch {}
    const identity = completed ?? opened;
    if (linked && identity) await removeOwnedFile(output, identity);
    if (identity) await removeOwnedFile(temporary, identity);
    if (/^MOLIT_TRANSFER_REVALIDATION_/u.test(error?.message ?? "")) throw error;
    fail("PUBLISH");
  }
}

export async function runCurrentMolitTransferSourceRevalidation({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = fetch,
  officialFileFixture = {},
  readFileImpl = readFile,
  publishFixture = {},
  repositoryRoot = path.resolve(import.meta.dirname, "../.."),
} = {}) {
  try {
    const args = parseArgs(argv);
    await assertAbsentOutput(args.output);
    const locked = await loadLockedSnapshot(path.resolve(repositoryRoot), readFileImpl);
    let observation;
    let operation;
    if (args.officialFile) {
      observation = await collectOfficialFileObservation({
        filePath: args.officialFile,
        locked,
        fixture: officialFileFixture,
      });
      operation = {
        method: "FILE_DOWNLOAD",
        operationId: "15130556-fileData-20250811",
        detailPageUrl: locked.metadata.detailUrl,
      };
    } else {
      let serviceKey;
      try {
        serviceKey = normalizeDataGoKrServiceKey(env.DATA_GO_KR_SERVICE_KEY);
      } catch {
        fail("CREDENTIAL");
      }
      observation = await collectProviderObservation({ fetchImpl, serviceKey, locked });
      operation = {
        method: "GET",
        operationId: "15130556-v1-uddi-93021737-5337-442c-9006-b9748f87d0a4",
        perPage: PER_PAGE,
        returnType: "JSON",
      };
    }
    const evidence = buildEvidence({
      observedAt: args.observedAt,
      locked,
      observation,
      operation,
    });
    await publishEvidence(args.output, evidence, publishFixture);
    return evidence;
  } catch (error) {
    if (/^MOLIT_TRANSFER_REVALIDATION_[A-Z_]+$/u.test(error?.message ?? "")) throw error;
    fail("INTERNAL");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCurrentMolitTransferSourceRevalidation().then((evidence) => {
    process.stdout.write(`${JSON.stringify({
      outcome: evidence.outcome,
      rowCount: evidence.providerObservation.totalCount,
      evidenceHash: evidence.evidenceHash,
    })}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
