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
const SEOUL_LINE_ID = "seoul-4";
const SEOUL_REDACTED_REQUEST = Object.freeze({
  method: "GET",
  operation: "SearchSTNBySubwayLineInfo",
  startIndex: 1,
  endIndex: 5,
  stationCode: " ",
  stationName: " ",
  lineNumber: "4호선",
});
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
  let quoteClosed = false;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (character === '"') {
      if (!quoted) {
        if (cell !== "" || quoteClosed) fail("SCHEMA");
        quoted = true;
      } else if (csv[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
        quoteClosed = true;
      }
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
      quoteClosed = false;
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && csv[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
      quoteClosed = false;
    } else {
      if (quoteClosed) fail("SCHEMA");
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
  const records = envelope.row.map((row) => {
    const provider = canonicalRecord(row, SEOUL_PROVIDER_FIELDS);
    if (provider.LINE_NUM !== "04호선") fail("PROVIDER");
    return canonicalRecord({
      line: provider.LINE_NUM,
      station_code: provider.STATION_CD,
      station_name: provider.STATION_NM,
    }, SEOUL_FIELDS);
  });
  const stationCodes = new Set();
  const stationNames = new Set();
  for (const record of records) {
    if (typeof record.station_code !== "string"
      || !/^[0-9]+$/u.test(record.station_code)
      || stationCodes.has(record.station_code)
      || typeof record.station_name !== "string"
      || record.station_name.trim() === ""
      || record.station_name !== record.station_name.trim()
      || /[\u0000-\u001f\u007f]/u.test(record.station_name)
      || stationNames.has(record.station_name)) fail("PROVIDER");
    stationCodes.add(record.station_code);
    stationNames.add(record.station_name);
  }
  return records;
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
    || !/^(?:s3|oci):\/\/[^/?#]+\/.+\.json$/u.test(previous.rawObjectUri)) fail("PREVIOUS_IDENTITY");
}

function evidencePayload({ sourceId, previous, observedAt, responseBytes, records }) {
  return {
    schemaVersion: 1,
    artifactKind: "current-static-source-revalidation-evidence",
    contractVersion: "1.0.0",
    sourceId,
    previousSnapshotId: previous.snapshotId,
    observedAt,
    operation: operationForSource(sourceId),
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

function operationForSource(sourceId) {
  return sourceId === MOLIT_SOURCE_ID
    ? "molit-urban-rail-full-route-file-five-records"
    : "seoulmetro-line4-stations-one-to-five";
}

function sourceDefinitions() {
  return [
    { sourceId: MOLIT_SOURCE_ID, key: "molit", fields: MOLIT_FIELDS, project: projectMolit },
    { sourceId: SEOUL_SOURCE_ID, key: "seoul", fields: SEOUL_FIELDS, project: projectSeoul },
  ];
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

function parseCanonicalPack(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 64 * 1024 * 1024) {
    fail("CANONICAL_PACK");
  }
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("CANONICAL_PACK");
  }
  const packs = document?.packs;
  const matches = Array.isArray(packs) ? packs.filter(({ id }) => id === "capital") : [];
  if (matches.length !== 1
    || !Array.isArray(matches[0].lines)
    || matches[0].lines.filter(({ id }) => id === SEOUL_LINE_ID).length !== 1
    || !Array.isArray(matches[0].stations)
    || !Array.isArray(matches[0].stationLines)) fail("CANONICAL_PACK");
  return matches[0];
}

function canonicalMembershipSha256(canonicalPackBytes, records) {
  const pack = parseCanonicalPack(canonicalPackBytes);
  const stations = new Map();
  for (const station of pack.stations) {
    if (typeof station?.id !== "string" || station.id === "" || stations.has(station.id)) {
      fail("CANONICAL_PACK");
    }
    stations.set(station.id, station);
  }
  const lineStationsByName = new Map();
  for (const membership of pack.stationLines.filter(({ lineId }) => lineId === SEOUL_LINE_ID)) {
    const station = stations.get(membership.stationId);
    if (!station || typeof station.nameKo !== "string" || station.nameKo.trim() === "") {
      fail("CANONICAL_PACK");
    }
    const matches = lineStationsByName.get(station.nameKo) ?? [];
    matches.push(station.id);
    lineStationsByName.set(station.nameKo, matches);
  }
  const memberships = records.map((record) => {
    const stationIds = lineStationsByName.get(record.station_name);
    if (stationIds?.length !== 1) fail("CANONICAL_MEMBERSHIP");
    return {
      stationCode: record.station_code,
      stationName: record.station_name,
      canonicalStationId: stationIds[0],
      canonicalLineId: SEOUL_LINE_ID,
    };
  });
  return sha256(JSON.stringify(memberships));
}

function buildSeoulChangeAdmission({
  previous,
  observedAt,
  observedMillis,
  responseBytes,
  records,
  canonicalPackBytes,
}) {
  requiredPrevious(previous, SEOUL_SOURCE_ID, SEOUL_FIELDS);
  const canonicalRaw = Buffer.from(`${JSON.stringify(records)}\n`);
  const rawSha256 = sha256(canonicalRaw);
  const providerRecordHashes = records.map((record) => sha256(JSON.stringify(record)));
  const redactedRequestFingerprint = sha256(JSON.stringify(SEOUL_REDACTED_REQUEST));
  const date = observedAt.slice(0, 10).replaceAll("-", "");
  const rawObjectUri =
    `oci://easysubway-datapacks/source-raw/${SEOUL_SOURCE_ID}/${date}/${rawSha256}.json`;
  const canonicalMembershipHash = canonicalMembershipSha256(canonicalPackBytes, records);
  const canonicalPackHash = sha256(canonicalPackBytes);
  const payload = {
    schemaVersion: 1,
    artifactKind: "current-static-source-change-admission-evidence",
    contractVersion: "1.0.0",
    sourceId: SEOUL_SOURCE_ID,
    previousSnapshotId: previous.snapshotId,
    observedAt,
    operation: operationForSource(SEOUL_SOURCE_ID),
    rowCount: records.length,
    canonicalRawSha256: rawSha256,
    schemaFingerprint: sha256(JSON.stringify([...SEOUL_FIELDS].sort(codepointCompare))),
    redactedRequestFingerprint,
    providerRecordHashesSha256: sha256(JSON.stringify(providerRecordHashes)),
    responseSha256: sha256(responseBytes),
    canonicalPackSha256: canonicalPackHash,
    canonicalMembershipSha256: canonicalMembershipHash,
    rawObjectUri,
    outcome: "CONTENT_CHANGE_ADMITTED",
    credentialRedacted: true,
  };
  if (payload.schemaFingerprint !== previous.schemaFingerprint
    || rawSha256 === previous.rawSha256
    || redactedRequestFingerprint === previous.redactedRequestFingerprint) fail("CHANGE_IDENTITY");
  const evidence = { ...payload, evidenceSha256: sha256(JSON.stringify(payload)) };
  const snapshot = {
    ...structuredClone(previous),
    snapshotId: `${SEOUL_SOURCE_ID}-change-admitted-${date}`,
    retrievedAt: observedAt,
    coverageCount: previous.coverageCount ?? previous.rowCount,
    rawSha256,
    rawObjectUri,
    redactedRequestFingerprint,
    providerRecordHashes,
    previousSnapshotId: previous.snapshotId,
    diffSummary: null,
    freshnessExpiresAt: plusDays(observedMillis, 30),
    rawRetentionExpiresAt: plusDays(observedMillis, 90),
    revalidationEvidenceSha256: evidence.evidenceSha256,
  };
  snapshot.diffSummary = buildSnapshotDiff(previous, snapshot);
  if (JSON.stringify(snapshot.diffSummary) !== JSON.stringify({
    status: "CHANGED",
    rawHashChanged: true,
    schemaHashChanged: false,
    requestHashChanged: true,
    sourceUpdatedAtChanged: false,
    rowDelta: 0,
    coverageDelta: 0,
  })) fail("CHANGE_IDENTITY");
  return { sourceId: SEOUL_SOURCE_ID, evidence, snapshot, canonicalRaw };
}

function sourceRawPublishPlan(snapshot, canonicalRaw) {
  const objectKey = new URL(snapshot.rawObjectUri).pathname.slice(1);
  const identity = {
    objectKey,
    sha256: snapshot.rawSha256,
    sizeBytes: canonicalRaw.length,
    immutable: true,
  };
  return {
    schemaVersion: 2,
    mode: "object-storage-preflight",
    steps: [
      {
        type: "put-source-raw-object",
        sourcePath: "seoulmetro-station-line-info-raw.json",
        ...identity,
      },
      { type: "verify-source-raw-object", ...identity },
    ],
  };
}

export function buildCurrentStaticSourceChangeAdmission({
  sourceSnapshots,
  capture,
  responseBytesBySource,
  canonicalPackBytes,
}) {
  if (!Array.isArray(sourceSnapshots) || !responseBytesBySource) fail("ARGUMENT");
  serializedChangeCapture(capture, responseBytesBySource);
  if (capture.sources[0].status !== "UNCHANGED"
    || capture.sources[1].status !== "CONTENT_CHANGED") fail("CAPTURE_STATUS");
  const observedMillis = requiredObservedAt(capture.observedAt);
  const molitPrevious = previousHead(sourceSnapshots, MOLIT_SOURCE_ID);
  const seoulPrevious = previousHead(sourceSnapshots, SEOUL_SOURCE_ID);
  const molit = buildOne({
    sourceId: MOLIT_SOURCE_ID,
    previous: molitPrevious,
    observedAt: capture.observedAt,
    observedMillis,
    responseBytes: responseBytesBySource.molit,
    records: projectMolit(responseBytesBySource.molit, molitPrevious),
    fields: MOLIT_FIELDS,
  });
  const seoul = buildSeoulChangeAdmission({
    previous: seoulPrevious,
    observedAt: capture.observedAt,
    observedMillis,
    responseBytes: responseBytesBySource.seoul,
    records: projectSeoul(responseBytesBySource.seoul),
    canonicalPackBytes,
  });
  const revalidations = [molit, { sourceId: seoul.sourceId, evidence: seoul.evidence, snapshot: seoul.snapshot }];
  validateLineage([...structuredClone(sourceSnapshots), ...revalidations.map(({ snapshot }) => snapshot)]);
  return {
    revalidations,
    seoulRawBytes: seoul.canonicalRaw,
    sourceRawPublishPlan: sourceRawPublishPlan(seoul.snapshot, seoul.canonicalRaw),
  };
}

export function buildCurrentStaticSourceRevalidation({
  sourceSnapshots,
  observedAt,
  responseBytesBySource,
}) {
  if (!Array.isArray(sourceSnapshots) || !responseBytesBySource) fail("ARGUMENT");
  const observedMillis = requiredObservedAt(observedAt);
  const result = sourceDefinitions().map(({ sourceId, key, fields, project }) => {
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

function buildCurrentStaticSourceChangeCapture({
  sourceSnapshots,
  observedAt,
  responseBytesBySource,
}) {
  if (!Array.isArray(sourceSnapshots) || !responseBytesBySource) fail("ARGUMENT");
  const observedMillis = requiredObservedAt(observedAt);
  const sources = sourceDefinitions().map(({ sourceId, key, fields, project }) => {
    const responseBytes = responseBytesBySource[key];
    const previous = previousHead(sourceSnapshots, sourceId);
    requiredPrevious(previous, sourceId, fields);
    let status = "UNCHANGED";
    try {
      buildOne({
        sourceId,
        previous,
        observedAt,
        observedMillis,
        responseBytes,
        records: project(responseBytes, previous),
        fields,
      });
    } catch (error) {
      if (error?.message !== "STATIC_SOURCE_REVALIDATION_CONTENT_CHANGED") throw error;
      status = "CONTENT_CHANGED";
    }
    return {
      sourceId,
      operation: operationForSource(sourceId),
      status,
      responseSha256: sha256(responseBytes),
      responseByteSize: responseBytes.length,
      rawFile: key === "molit" ? "molit-response.bin" : "seoul-response.json",
    };
  });
  if (!sources.some(({ status }) => status === "CONTENT_CHANGED")) fail("ARGUMENT");
  return {
    schemaVersion: 1,
    artifactKind: "current-static-source-change-capture",
    observedAt,
    outcome: "CHANGE_REVIEW_REQUIRED",
    sources,
    credentialRedacted: true,
  };
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
  if (!response.body || typeof response.body.getReader !== "function") fail(`${source}_BODY_SIZE`);
  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) fail(`${source}_BODY_SIZE`);
      byteLength += value.byteLength;
      if (byteLength > 1024 * 1024) {
        await reader.cancel().catch(() => {});
        fail(`${source}_BODY_SIZE`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  if (byteLength === 0) fail(`${source}_BODY_SIZE`);
  return Buffer.concat(chunks, byteLength);
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
    `http://openapi.seoul.go.kr:8088/${encodeURIComponent(seoulKey)}/json/SearchSTNBySubwayLineInfo/1/5/${encodeURIComponent(" ")}/${encodeURIComponent(" ")}/${encodeURIComponent("4호선")}`,
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

async function writeAbsentDirectory({ outputDirectory, entries }) {
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
    for (const [name, bytes] of entries) {
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

export async function writeCurrentStaticSourceRevalidation({ outputDirectory, result }) {
  return writeAbsentDirectory({ outputDirectory, entries: serializedOutputs(result) });
}

function serializedChangeCapture(capture, responseBytesBySource) {
  assertExactKeys(capture, [
    "schemaVersion", "artifactKind", "observedAt", "outcome", "sources", "credentialRedacted",
  ], "ARGUMENT");
  if (capture.schemaVersion !== 1
    || capture.artifactKind !== "current-static-source-change-capture"
    || capture.outcome !== "CHANGE_REVIEW_REQUIRED"
    || capture.credentialRedacted !== true
    || !Array.isArray(capture.sources) || capture.sources.length !== 2) fail("ARGUMENT");
  const responses = [responseBytesBySource.molit, responseBytesBySource.seoul];
  const entries = capture.sources.map((source, index) => {
    const expectedSourceId = SOURCE_IDS[index];
    const expectedFile = index === 0 ? "molit-response.bin" : "seoul-response.json";
    const bytes = responses[index];
    assertExactKeys(source, [
      "sourceId", "operation", "status", "responseSha256", "responseByteSize", "rawFile",
    ], "ARGUMENT");
    if (!Buffer.isBuffer(bytes)
      || source.sourceId !== expectedSourceId
      || source.operation !== operationForSource(expectedSourceId)
      || !new Set(["UNCHANGED", "CONTENT_CHANGED"]).has(source.status)
      || source.responseSha256 !== sha256(bytes)
      || source.responseByteSize !== bytes.length
      || source.rawFile !== expectedFile) fail("ARGUMENT");
    return [expectedFile, bytes];
  });
  entries.push(["change-evidence.json", Buffer.from(`${JSON.stringify(capture, null, 2)}\n`)]);
  return entries;
}

export async function writeCurrentStaticSourceChangeCapture({
  outputDirectory,
  capture,
  responseBytesBySource,
}) {
  return writeAbsentDirectory({
    outputDirectory,
    entries: serializedChangeCapture(capture, responseBytesBySource),
  });
}

function serializedChangeAdmission(admission) {
  assertExactKeys(admission, ["revalidations", "seoulRawBytes", "sourceRawPublishPlan"], "ARGUMENT");
  if (!Array.isArray(admission.revalidations) || admission.revalidations.length !== 2
    || admission.revalidations.some(({ sourceId }, index) => sourceId !== SOURCE_IDS[index])
    || admission.revalidations[0].evidence?.outcome !== "NO_CHANGE_REVALIDATED"
    || admission.revalidations[1].evidence?.outcome !== "CONTENT_CHANGE_ADMITTED"
    || !Buffer.isBuffer(admission.seoulRawBytes)
    || sha256(admission.seoulRawBytes) !== admission.revalidations[1].snapshot.rawSha256
    || JSON.stringify(admission.sourceRawPublishPlan)
      !== JSON.stringify(sourceRawPublishPlan(
        admission.revalidations[1].snapshot,
        admission.seoulRawBytes,
      ))) fail("ARGUMENT");
  const entries = admission.revalidations.flatMap(({ sourceId, evidence, snapshot }) => [
    [`${sourceId}-revalidation-evidence.json`, Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`)],
    [`${sourceId}-snapshot.json`, Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`)],
  ]);
  entries.push(
    ["seoulmetro-station-line-info-raw.json", admission.seoulRawBytes],
    [
      "seoulmetro-station-line-info-source-raw-publish-plan.json",
      Buffer.from(`${JSON.stringify(admission.sourceRawPublishPlan, null, 2)}\n`),
    ],
  );
  return entries;
}

export async function writeCurrentStaticSourceChangeAdmission({ outputDirectory, admission }) {
  return writeAbsentDirectory({ outputDirectory, entries: serializedChangeAdmission(admission) });
}

export async function runCurrentStaticSourceRevalidation({
  sourceSnapshots,
  observedAt,
  responseBytesBySource,
  outputDirectory,
  changeOutputDirectory,
}) {
  try {
    const result = buildCurrentStaticSourceRevalidation({
      sourceSnapshots,
      observedAt,
      responseBytesBySource,
    });
    const outputs = await writeCurrentStaticSourceRevalidation({ outputDirectory, result });
    return { outcome: "NO_CHANGE_REVALIDATED", sourceCount: 2, outputs };
  } catch (error) {
    if (error?.message === "STATIC_SOURCE_REVALIDATION_CONTENT_CHANGED"
      && changeOutputDirectory != null) {
      const capture = buildCurrentStaticSourceChangeCapture({
        sourceSnapshots,
        observedAt,
        responseBytesBySource,
      });
      await writeCurrentStaticSourceChangeCapture({
        outputDirectory: changeOutputDirectory,
        capture,
        responseBytesBySource,
      });
    }
    throw error;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!new Set([
      "--source-snapshots", "--observed-at", "--output-directory", "--change-output-directory",
      "--change-capture-directory", "--canonical-pack",
    ]).has(flag)) fail("ARGUMENT");
    const value = argv[index + 1];
    if (!value || value.startsWith("--") || args[flag]) fail("ARGUMENT");
    args[flag] = value;
  }
  const offline = args["--change-capture-directory"] != null;
  if (offline) {
    const required = [
      "--source-snapshots", "--change-capture-directory", "--canonical-pack", "--output-directory",
    ];
    if (Object.keys(args).length !== required.length
      || !required.every((flag) => args[flag] != null)) fail("ARGUMENT");
  } else {
    const required = ["--source-snapshots", "--observed-at", "--output-directory"];
    if (!required.every((flag) => args[flag] != null)
      || ![3, 4].includes(Object.keys(args).length)
      || Object.keys(args).length === 4 && args["--change-output-directory"] == null) {
      fail("ARGUMENT");
    }
  }
  if (args["--change-output-directory"] != null
    && !path.isAbsolute(args["--change-output-directory"])) fail("ARGUMENT");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceSnapshots = JSON.parse(await readFile(path.resolve(args["--source-snapshots"]), "utf8"));
  if (args["--change-capture-directory"] != null) {
    const captureDirectory = path.resolve(args["--change-capture-directory"]);
    const [capture, molit, seoul, canonicalPackBytes] = await Promise.all([
      readFile(path.join(captureDirectory, "change-evidence.json"), "utf8").then(JSON.parse),
      readFile(path.join(captureDirectory, "molit-response.bin")),
      readFile(path.join(captureDirectory, "seoul-response.json")),
      readFile(path.resolve(args["--canonical-pack"])),
    ]);
    const admission = buildCurrentStaticSourceChangeAdmission({
      sourceSnapshots,
      capture,
      responseBytesBySource: { molit, seoul },
      canonicalPackBytes,
    });
    await writeCurrentStaticSourceChangeAdmission({
      outputDirectory: path.resolve(args["--output-directory"]),
      admission,
    });
    process.stdout.write(`${JSON.stringify({
      outcome: "CONTENT_CHANGE_ADMITTED",
      sourceCount: admission.revalidations.length,
    })}\n`);
    return;
  }
  const responses = await fetchCurrentStaticSourceResponses({
    seoulOpenApiKey: process.env.SEOUL_OPENAPI_KEY,
  });
  const result = await runCurrentStaticSourceRevalidation({
    sourceSnapshots,
    observedAt: args["--observed-at"],
    responseBytesBySource: responses,
    outputDirectory: path.resolve(args["--output-directory"]),
    changeOutputDirectory: args["--change-output-directory"],
  });
  process.stdout.write(`${JSON.stringify({ outcome: result.outcome, sourceCount: result.sourceCount })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.message?.startsWith("STATIC_SOURCE_REVALIDATION_")
      ? error.message
      : "STATIC_SOURCE_REVALIDATION_FAILED"}\n`);
    process.exitCode = 1;
  });
}
