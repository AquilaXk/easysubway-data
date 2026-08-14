#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, open, readFile, rm, stat, unlink } from "node:fs/promises";
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
  const allowed = new Set(["observed-at", "output"]);
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
  if (Object.keys(args).length !== 2 || !path.isAbsolute(args.output)) fail("ARGUMENT");
  const observedAtMillis = requiredUtcInstant(args["observed-at"], "observedAt");
  if (new Date(observedAtMillis).toISOString() !== args["observed-at"]) fail("ARGUMENT");
  return { observedAt: args["observed-at"], output: path.resolve(args.output) };
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

async function loadLockedSnapshot(repositoryRoot) {
  try {
    const [metadataBytes, gzipBytes, candidatesBytes] = await Promise.all([
      readFile(path.join(repositoryRoot, METADATA_PATH)),
      readFile(path.join(repositoryRoot, SNAPSHOT_PATH)),
      readFile(path.join(repositoryRoot, CANDIDATES_PATH)),
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
  } catch {
    fail("PROVIDER");
  }
  if (!response?.ok || !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")) {
    fail("PROVIDER");
  }
  let bytes;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch {
    fail("PROVIDER");
  }
  if (bytes.length === 0 || bytes.length > MAX_PAGE_BYTES) fail("PROVIDER");
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

function buildEvidence({ observedAt, locked, observation }) {
  const payload = {
    schemaVersion: 1,
    artifactKind: "current-molit-transfer-source-revalidation-evidence",
    contractVersion: "1.0.0",
    sourceId: MOLIT_RAILWAY_TRANSFER_MOVEMENT_SOURCE_ID,
    snapshotId: MOLIT_RAILWAY_TRANSFER_MOVEMENT_SNAPSHOT_ID,
    observedAt,
    operation: {
      method: "GET",
      operationId: "15130556-v1-uddi-93021737-5337-442c-9006-b9748f87d0a4",
      perPage: PER_PAGE,
      returnType: "JSON",
    },
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

async function publishEvidence(output, evidence) {
  const temporary = `${output}.tmp-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(evidence, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, output);
    const published = await stat(output);
    if (!published.isFile() || (published.mode & 0o777) !== 0o600) fail("PUBLISH");
    await unlink(temporary);
  } catch (error) {
    try { await handle?.close(); } catch {}
    await rm(temporary, { force: true });
    if (/^MOLIT_TRANSFER_REVALIDATION_/u.test(error?.message ?? "")) throw error;
    fail("PUBLISH");
  }
}

export async function runCurrentMolitTransferSourceRevalidation({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = fetch,
  repositoryRoot = path.resolve(import.meta.dirname, "../.."),
} = {}) {
  try {
    const args = parseArgs(argv);
    await assertAbsentOutput(args.output);
    let serviceKey;
    try {
      serviceKey = normalizeDataGoKrServiceKey(env.DATA_GO_KR_SERVICE_KEY);
    } catch {
      fail("CREDENTIAL");
    }
    const locked = await loadLockedSnapshot(path.resolve(repositoryRoot));
    const observation = await collectProviderObservation({ fetchImpl, serviceKey, locked });
    const evidence = buildEvidence({ observedAt: args.observedAt, locked, observation });
    await publishEvidence(args.output, evidence);
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
