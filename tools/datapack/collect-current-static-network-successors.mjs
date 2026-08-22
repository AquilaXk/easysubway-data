import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import { buildLegacySampleToFullConsumedFieldsMigration } from "./lib/seoulmetro-line-data-parser.mjs";

export const MOLIT_URL = "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003561913&fileDetailSn=1&insertDataPrcus=N";
export const SEOUL_ROOT_URL = "https://www.seoulmetro.co.kr/kr/cyberStation.do";
export const SEOUL_ASSET_URL = "https://www.seoulmetro.co.kr/kr/getLineData.do";
const CSV_HEADER = ["권역", "권역명", "철도운영기관명", "노선명", "순번", "역명"];
const MOLIT_FIELDS = ["region_code", "region_name", "operator_name", "line_name", "station_sequence", "station_name"];
const sha = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code) => { throw new Error(`STATIC_NETWORK_SUCCESSOR_${code}`); };

export async function collectCurrentStaticNetworkSuccessors({ fetchImpl = fetch, sourceSnapshots, baselineRouteMapBytes, baselineMolitBytes, observedAt }) {
  if (!Array.isArray(sourceSnapshots) || !Buffer.isBuffer(baselineRouteMapBytes) || !Buffer.isBuffer(baselineMolitBytes)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(observedAt ?? "")) fail("ARGUMENT");
  const [molit, root] = await Promise.all([
    fetchBytes(fetchImpl, MOLIT_URL, "MOLIT", /^(?:application\/octet-stream|text\/csv)(?:;|$)/iu),
    fetchBytes(fetchImpl, SEOUL_ROOT_URL, "SEOUL_ROOT", /^text\/html(?:;|$)/iu),
  ]);
  const assetReferences = [...root.toString("utf8").matchAll(/(?:src|href)\s*=\s*["']([^"']*\/kr\/getLineData\.do)["']/giu)]
    .map((match) => new URL(match[1], SEOUL_ROOT_URL).href);
  if (assetReferences.length !== 1 || assetReferences[0] !== SEOUL_ASSET_URL) fail("SEOUL_ASSET_REFERENCE");
  const seoul = await fetchBytes(fetchImpl, SEOUL_ASSET_URL, "SEOUL_ASSET", /^(?:application\/javascript|text\/javascript)(?:;|$)/iu);
  const molitHead = currentHead(sourceSnapshots, "molit-urban-rail-full-route");
  const routeMapHead = currentHead(sourceSnapshots, "seoulmetro-cyberstation-route-map");
  const molitRecords = projectMolit(molit);
  const baselineMolitProjection = projectMolit(baselineMolitBytes);
  if (JSON.stringify(molitRecords) !== JSON.stringify(baselineMolitProjection)) fail("MATERIAL_CHANGE");
  const migration = buildLegacySampleToFullConsumedFieldsMigration({
    legacyHead: routeMapHead, baselineRawBytes: baselineRouteMapBytes, freshRawBytes: seoul,
    snapshotId: `seoulmetro-cyberstation-route-map-current-${observedAt.replaceAll(/[-:.]/gu, "").replace("Z", "Z")}`,
  });
  return {
    observedAt,
    molit: { sourceId: molitHead.sourceId, rawBytes: molit, rawSha256: sha(molit), records: molitRecords, previous: molitHead,
      migration: buildMolitMigration({ legacyHead: molitHead, baselineRawBytes: baselineMolitBytes, projection: molitRecords, snapshotId: `molit-urban-rail-full-route-current-${observedAt.replaceAll(/[-:.]/gu, "").replace("Z", "Z")}` }) },
    routeMap: { sourceId: routeMapHead.sourceId, rawBytes: seoul, rawSha256: sha(seoul), migration, previous: routeMapHead },
  };
}

async function fetchBytes(fetchImpl, url, source, contentType) {
  let response;
  try { response = await fetchImpl(new URL(url), { method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000) }); }
  catch { fail(`${source}_TRANSPORT`); }
  if (!response?.ok || response.status !== 200) fail(`${source}_HTTP`);
  if (!contentType.test(response.headers?.get("content-type") ?? "")) fail(`${source}_CONTENT_TYPE`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 4 * 1024 * 1024) fail(`${source}_BODY`);
  return bytes;
}

function currentHead(snapshots, sourceId) {
  const candidates = snapshots.filter((snapshot) => snapshot?.sourceId === sourceId);
  const referenced = new Set(candidates.map(({ previousSnapshotId }) => previousSnapshotId).filter(Boolean));
  const heads = candidates.filter(({ snapshotId }) => !referenced.has(snapshotId));
  if (heads.length !== 1) fail("LINEAGE");
  return heads[0];
}

function projectMolit(bytes) {
  let text;
  try { text = new TextDecoder("euc-kr", { fatal: true }).decode(bytes); } catch { fail("MOLIT_ENCODING"); }
  const rows = parseCsv(text);
  if (rows.length < 2 || JSON.stringify(rows[0]) !== JSON.stringify(CSV_HEADER)
    || rows.slice(1).some((row) => row.length !== 6)) fail("MOLIT_SCHEMA");
  return rows.slice(1).map((cells) => {
    const values = cells.map((value) => value.trim());
    const sequence = Number(values[4]);
    if (values.some((value) => value === "") || !Number.isInteger(sequence) || sequence < 1) fail("MOLIT_SCHEMA");
    values[4] = sequence;
    return Object.fromEntries(MOLIT_FIELDS.map((field, index) => [field, values[index]]));
  });
}

function buildMolitMigration({ legacyHead, baselineRawBytes, projection, snapshotId }) {
  if (!legacyHead || legacyHead.sourceId !== "molit-urban-rail-full-route" || !Array.isArray(legacyHead.providerRecordHashes)
    || legacyHead.providerRecordHashes.length !== 5 || typeof legacyHead.snapshotId !== "string") fail("LINEAGE");
  const fullProjection = Buffer.from(`${JSON.stringify(projection)}\n`);
  return {
    schemaVersion: 1, artifactKind: "source-projection-migration-evidence", migrationKind: "LEGACY_SAMPLE_TO_FULL_CONSUMED_FIELDS",
    sourceId: legacyHead.sourceId, legacySnapshotId: legacyHead.snapshotId, legacyRawSha256: legacyHead.rawSha256,
    legacySchemaFingerprint: legacyHead.schemaFingerprint, legacyProviderRecordHashes: [...legacyHead.providerRecordHashes],
    retainedBaselineRawSha256: sha(baselineRawBytes), fullProjectionSha256: sha(fullProjection),
    fullProjectionSchemaFingerprint: sha(JSON.stringify(MOLIT_FIELDS)), fullProjectionRowCount: projection.length, newSnapshotId: snapshotId,
  };
}

function parseCsv(value) {
  if (value.replaceAll("\r\n", "").includes("\r")) fail("MOLIT_SCHEMA");
  return value.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line).filter((line) => line !== "").map((line) => line.split(","));
}
