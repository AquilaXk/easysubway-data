#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

import { requiredUtcInstant } from "./lib/utc-instant.mjs";
import { buildSnapshotDiff, validateLineage } from "./source-snapshot-policy.mjs";
import { codepointCompare } from "../lib/codepoint-compare.mjs";

const MOLIT_SOURCE_ID = "molit-urban-rail-full-route";
const SEOUL_SOURCE_ID = "seoulmetro-station-line-info";
const SOURCE_IDS = Object.freeze([MOLIT_SOURCE_ID, SEOUL_SOURCE_ID]);
const MOLIT_FIELDS = Object.freeze([
  "line_name", "operator_name", "region", "station_name", "station_sequence",
]);
const MOLIT_CSV_HEADER = Object.freeze([
  "권역", "권역명", "철도운영기관명", "노선명", "순번", "역명",
]);
const MOLIT_PUBLIC_CSV_URL =
  "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003561913&fileDetailSn=1&insertDataPrcus=N";
const SEOUL_PROVIDER_FIELDS = Object.freeze([
  "FR_CODE", "LINE_NUM", "STATION_CD", "STATION_NM", "STATION_NM_CHN",
  "STATION_NM_ENG", "STATION_NM_JPN",
]);
const SEOUL_FIELDS = Object.freeze(["line", "station_code", "station_name"]);
const SHA256 = /^[0-9a-f]{64}$/u;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(code) {
  throw new Error(`STATIC_SOURCE_REVALIDATION_${code}`);
}

function assertExactKeys(value, expected, code = "SCHEMA") {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort(codepointCompare);
  const sortedExpected = [...expected].sort(codepointCompare);
  if (actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])) fail(code);
}

function parseJson(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 1024 * 1024) fail("SCHEMA");
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("SCHEMA");
  }
}

function canonicalRecord(row, fields) {
  assertExactKeys(row, fields);
  return Object.fromEntries([...fields].sort(codepointCompare).map((field) => [field, row[field]]));
}

function parseCsv(csv) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (character === '"') {
      if (quoted && csv[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && csv[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (quoted) fail("SCHEMA");
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function projectMolit(bytes, previous) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 1024 * 1024) fail("SCHEMA");
  let csv;
  try {
    csv = new TextDecoder("euc-kr", { fatal: true }).decode(bytes);
  } catch {
    fail("SCHEMA");
  }
  const rows = parseCsv(csv);
  if (rows.length < 6
    || rows[0].length !== MOLIT_CSV_HEADER.length
    || rows[0].some((value, index) => value !== MOLIT_CSV_HEADER[index])) fail("SCHEMA");
  const records = rows.slice(1).map((row) => {
    if (row.length !== MOLIT_CSV_HEADER.length) fail("SCHEMA");
    const values = row.map((value) => value.trim());
    if (values.some((value) => value === "")
      || !/^[1-9][0-9]*$/u.test(values[4])
      || !Number.isSafeInteger(Number(values[4]))) fail("SCHEMA");
    return canonicalRecord({
      line_name: values[3],
      operator_name: values[2],
      region: values[1],
      station_name: values[5],
      station_sequence: values[4],
    }, MOLIT_FIELDS);
  });
  const recordsByHash = new Map(previous.providerRecordHashes.map((hash) => [hash, []]));
  for (const record of records) {
    const recordHash = sha256(JSON.stringify(record));
    recordsByHash.get(recordHash)?.push(record);
  }
  const selected = previous.providerRecordHashes.map((hash) => recordsByHash.get(hash));
  if (selected.some((matches) => matches?.length !== 1)) fail("CONTENT_CHANGED");
  return selected.map(([record]) => record);
}

function projectSeoul(bytes) {
  const document = parseJson(bytes);
  assertExactKeys(document, ["SearchSTNBySubwayLineInfo"]);
  const envelope = document.SearchSTNBySubwayLineInfo;
  assertExactKeys(envelope, ["list_total_count", "RESULT", "row"]);
  assertExactKeys(envelope.RESULT, ["CODE", "MESSAGE"]);
  if (envelope.RESULT.CODE !== "INFO-000"
    || !Number.isSafeInteger(envelope.list_total_count) || envelope.list_total_count < 5
    || !Array.isArray(envelope.row) || envelope.row.length !== 5) fail("PROVIDER");
  return envelope.row.map((row) => {
    const provider = canonicalRecord(row, SEOUL_PROVIDER_FIELDS);
    return canonicalRecord({
      line: provider.LINE_NUM,
      station_code: provider.STATION_CD,
      station_name: provider.STATION_NM,
    }, SEOUL_FIELDS);
  });
}

function requiredObservedAt(value) {
  const millis = requiredUtcInstant(value, "observedAt");
  if (new Date(millis).toISOString() !== value) fail("OBSERVED_AT");
  return millis;
}

function plusDays(millis, days) {
  return new Date(millis + days * 24 * 60 * 60 * 1000).toISOString();
}

function previousHead(sourceSnapshots, sourceId) {
  let heads;
  try {
    heads = validateLineage(sourceSnapshots).headsBySource;
  } catch {
    fail("LINEAGE");
  }
  const headId = heads[sourceId];
  const matches = sourceSnapshots.filter(({ snapshotId }) => snapshotId === headId);
  if (matches.length !== 1) fail("LINEAGE");
  return matches[0];
}

function requiredPrevious(previous, sourceId, fields) {
  if (previous.sourceId !== sourceId
    || previous.rowCount !== 5
    || !SHA256.test(previous.rawSha256 ?? "")
    || !SHA256.test(previous.schemaFingerprint ?? "")
    || !SHA256.test(previous.redactedRequestFingerprint ?? "")
    || previous.schemaFingerprint !== sha256(JSON.stringify([...fields].sort(codepointCompare)))
    || !Array.isArray(previous.providerRecordHashes)
    || previous.providerRecordHashes.length !== 5
    || previous.providerRecordHashes.some((value) => !SHA256.test(value ?? ""))
    || typeof previous.rawObjectUri !== "string"
    || !/^s3:\/\/[^/?#]+\/.+\.json$/u.test(previous.rawObjectUri)) fail("PREVIOUS_IDENTITY");
}

function evidencePayload({ sourceId, previous, observedAt, responseBytes, records }) {
  return {
    schemaVersion: 1,
    artifactKind: "current-static-source-revalidation-evidence",
    contractVersion: "1.0.0",
    sourceId,
    previousSnapshotId: previous.snapshotId,
    observedAt,
    operation: sourceId === MOLIT_SOURCE_ID
      ? "molit-urban-rail-full-route-file-five-records"
      : "seoulmetro-line4-stations-one-to-five",
    rowCount: records.length,
    canonicalRawSha256: sha256(Buffer.from(`${JSON.stringify(records)}\n`)),
    schemaFingerprint: sha256(JSON.stringify(Object.keys(records[0]).sort(codepointCompare))),
    providerRecordHashesSha256: sha256(JSON.stringify(
      records.map((record) => sha256(JSON.stringify(record))),
    )),
    responseSha256: sha256(responseBytes),
    outcome: "NO_CHANGE_REVALIDATED",
    credentialRedacted: true,
  };
}

function buildOne({ sourceId, previous, observedAt, observedMillis, responseBytes, records, fields }) {
  requiredPrevious(previous, sourceId, fields);
  const canonicalRawSha256 = sha256(Buffer.from(`${JSON.stringify(records)}\n`));
  const providerRecordHashes = records.map((record) => sha256(JSON.stringify(record)));
  if (canonicalRawSha256 !== previous.rawSha256
    || providerRecordHashes.some((value, index) => value !== previous.providerRecordHashes[index])) {
    fail("CONTENT_CHANGED");
  }
  const payload = evidencePayload({ sourceId, previous, observedAt, responseBytes, records });
  if (payload.canonicalRawSha256 !== previous.rawSha256
    || payload.schemaFingerprint !== previous.schemaFingerprint) fail("CONTENT_CHANGED");
  const evidence = { ...payload, evidenceSha256: sha256(JSON.stringify(payload)) };
  const date = observedAt.slice(0, 10).replaceAll("-", "");
  const snapshot = {
    ...structuredClone(previous),
    snapshotId: `${sourceId}-revalidated-${date}`,
    retrievedAt: observedAt,
    coverageCount: previous.coverageCount ?? previous.rowCount,
    previousSnapshotId: previous.snapshotId,
    diffSummary: null,
    freshnessExpiresAt: plusDays(observedMillis, 30),
    rawRetentionExpiresAt: plusDays(observedMillis, 90),
    revalidationEvidenceSha256: evidence.evidenceSha256,
  };
  snapshot.diffSummary = buildSnapshotDiff(previous, snapshot);
  if (snapshot.diffSummary.status !== "NO_CHANGE") fail("CONTENT_CHANGED");
  return { sourceId, evidence, snapshot };
}

export function buildCurrentStaticSourceRevalidation({
  sourceSnapshots,
  observedAt,
  responseBytesBySource,
}) {
  if (!Array.isArray(sourceSnapshots) || !responseBytesBySource) fail("ARGUMENT");
  const observedMillis = requiredObservedAt(observedAt);
  const definitions = [
    { sourceId: MOLIT_SOURCE_ID, key: "molit", fields: MOLIT_FIELDS, project: projectMolit },
    { sourceId: SEOUL_SOURCE_ID, key: "seoul", fields: SEOUL_FIELDS, project: projectSeoul },
  ];
  const result = definitions.map(({ sourceId, key, fields, project }) => {
    const responseBytes = responseBytesBySource[key];
    const previous = previousHead(sourceSnapshots, sourceId);
    requiredPrevious(previous, sourceId, fields);
    return buildOne({
      sourceId,
      previous,
      observedAt,
      observedMillis,
      responseBytes,
      records: project(responseBytes, previous),
      fields,
    });
  });
  validateLineage([...structuredClone(sourceSnapshots), ...result.map(({ snapshot }) => snapshot)]);
  return result;
}

function requiredSingleLine(value, label) {
  if (typeof value !== "string" || value.trim() === "" || /[\r\n\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} is required`);
  }
  return value;
}

async function responseBytes(response, source, expectedContentType) {
  if (!response || response.status !== 200 || !response.ok) {
    const status = Number.isSafeInteger(response?.status) ? response.status : "INVALID";
    fail(`${source}_HTTP_${status}`);
  }
  if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
    !== expectedContentType) fail(`${source}_CONTENT_TYPE`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 1024 * 1024) fail(`${source}_BODY_SIZE`);
  return bytes;
}

async function fetchSourceResponse({ source, url, init, fetchImpl, expectedContentType }) {
  try {
    return await responseBytes(await fetchImpl(url, init), source, expectedContentType);
  } catch (error) {
    if (error?.message?.startsWith("STATIC_SOURCE_REVALIDATION_")) throw error;
    fail(`${source}_TRANSPORT`);
  }
}

export async function fetchCurrentStaticSourceResponses({
  seoulOpenApiKey,
  fetchImpl = fetch,
}) {
  const seoulKey = requiredSingleLine(seoulOpenApiKey, "SEOUL_OPENAPI_KEY");
  const molitUrl = new URL(MOLIT_PUBLIC_CSV_URL);
  const seoulUrl = new URL(
    `http://openapi.seoul.go.kr:8088/${encodeURIComponent(seoulKey)}/json/SearchSTNBySubwayLineInfo/1/5///${encodeURIComponent("4호선")}`,
  );
  const molit = await fetchSourceResponse({
    source: "MOLIT",
    url: molitUrl,
    fetchImpl,
    init: {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { accept: "application/octet-stream" },
    },
    expectedContentType: "application/octet-stream",
  });
  const seoul = await fetchSourceResponse({
    source: "SEOUL",
    url: seoulUrl,
    fetchImpl,
    init: {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { accept: "application/json" },
    },
    expectedContentType: "application/json",
  });
  return { molit, seoul };
}

function serializedOutputs(result) {
  if (!Array.isArray(result) || result.length !== 2
    || result.some(({ sourceId }, index) => sourceId !== SOURCE_IDS[index])) fail("ARGUMENT");
  return result.flatMap(({ sourceId, evidence, snapshot }) => [
    [`${sourceId}-revalidation-evidence.json`, Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`)],
    [`${sourceId}-snapshot.json`, Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`)],
  ]);
}

export async function writeCurrentStaticSourceRevalidation({ outputDirectory, result }) {
  if (!path.isAbsolute(outputDirectory ?? "")) fail("OUTPUT");
  const parent = path.dirname(outputDirectory);
  const temporary = path.join(parent, `.${path.basename(outputDirectory)}.tmp-${randomUUID()}`);
  const requireAbsentOutput = async () => {
    try {
      await lstat(outputDirectory);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    throw new Error("output directory must be absent");
  };
  try {
    await requireAbsentOutput();
    await mkdir(temporary, { mode: 0o700 });
    const names = [];
    for (const [name, bytes] of serializedOutputs(result)) {
      await writeFile(path.join(temporary, name), bytes, { flag: "wx", mode: 0o600 });
      names.push(name);
    }
    try {
      await requireAbsentOutput();
      await rename(temporary, outputDirectory);
    } catch (error) {
      if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY") {
        throw new Error("output directory must be absent");
      }
      throw error;
    }
    return names.map((name) => path.join(outputDirectory, name));
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!new Set(["--source-snapshots", "--observed-at", "--output-directory"]).has(flag)) fail("ARGUMENT");
    const value = argv[index + 1];
    if (!value || value.startsWith("--") || args[flag]) fail("ARGUMENT");
    args[flag] = value;
  }
  if (Object.keys(args).length !== 3) fail("ARGUMENT");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceSnapshots = JSON.parse(await readFile(path.resolve(args["--source-snapshots"]), "utf8"));
  const responses = await fetchCurrentStaticSourceResponses({
    seoulOpenApiKey: process.env.SEOUL_OPENAPI_KEY,
  });
  const result = buildCurrentStaticSourceRevalidation({
    sourceSnapshots,
    observedAt: args["--observed-at"],
    responseBytesBySource: responses,
  });
  await writeCurrentStaticSourceRevalidation({
    outputDirectory: path.resolve(args["--output-directory"]),
    result,
  });
  process.stdout.write(`${JSON.stringify({ outcome: "NO_CHANGE_REVALIDATED", sourceCount: 2 })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.message?.startsWith("STATIC_SOURCE_REVALIDATION_")
      ? error.message
      : "STATIC_SOURCE_REVALIDATION_FAILED"}\n`);
    process.exitCode = 1;
  });
}
