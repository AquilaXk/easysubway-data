import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { normalizeDataGoKrServiceKey } from "./lib/provider-call-integrity.mjs";
import {
  assertCurrentMolitFullRouteCompleteness,
  normalizeCurrentSeoulPositionCompleteness,
} from "./lib/static-network-successor-completeness.mjs";

export const MOLIT_URL = "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003561913&fileDetailSn=1&insertDataPrcus=N";
export const SEOUL_POSITIONS_URL = "https://api.odcloud.kr/api/15099316/v1/uddi:bc51de47-d3ea-4aa1-8ac2-d70f2b5e701e";
const CSV_HEADER = ["권역", "권역명", "철도운영기관명", "노선명", "순번", "역명"];
const MOLIT_FIELDS = ["region_code", "region_name", "operator_name", "line_name", "station_sequence", "station_name"];
const POSITION_FIELDS = ["연번", "호선", "고유역번호(외부역코드)", "역명", "위도", "경도", "작성기준일"];
const MOLIT_REGIONS = Object.freeze({ "01": "수도권", "02": "부산", "03": "대구", "04": "광주", "05": "대전" });
const sha = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code) => { throw new Error(`STATIC_NETWORK_SUCCESSOR_${code}`); };

export async function collectCurrentStaticNetworkSuccessors({ fetchImpl = fetch, sourceSnapshots, observedAt, serviceKey = process.env.DATA_GO_KR_SERVICE_KEY } = {}) {
  if (!Array.isArray(sourceSnapshots) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(observedAt ?? "")) fail("ARGUMENT");
  let normalizedServiceKey; try { normalizedServiceKey = normalizeDataGoKrServiceKey(serviceKey); } catch { fail("ARGUMENT"); }
  const positionsUrl = new URL(SEOUL_POSITIONS_URL);
  positionsUrl.search = new URLSearchParams({ serviceKey: normalizedServiceKey, page: "1", perPage: "1000", returnType: "JSON" }).toString();
  const [positionsBytes, molitBytes] = await Promise.all([
    fetchBytes(fetchImpl, positionsUrl, "SEOUL_POSITIONS", /^application\/json(?:;|$)/iu),
    fetchBytes(fetchImpl, new URL(MOLIT_URL), "MOLIT", /^(?:application\/octet-stream|text\/csv)(?:;|$)/iu),
  ]);
  const positions = projectPositions(positionsBytes, observedAt);
  const molit = projectMolit(molitBytes);
  const replaced = currentHead(sourceSnapshots, "seoulmetro-cyberstation-route-map");
  const molitPrevious = currentHead(sourceSnapshots, "molit-urban-rail-full-route");
  return {
    observedAt,
    positions: { sourceId: "seoul-metro-route-map-positions", rawBytes: positionsBytes, rawSha256: sha(positionsBytes), records: positions, replaced,
      replacement: { schemaVersion: 1, artifactKind: "source-projection-migration-evidence", migrationKind: "CROSS_SOURCE_CANONICAL_REPLACEMENT", sourceId: "seoul-metro-route-map-positions", replacedSourceId: replaced.sourceId, replacedSnapshotId: replaced.snapshotId, replacedRawSha256: replaced.rawSha256, replacedSchemaFingerprint: replaced.schemaFingerprint, candidateSlotSourceId: replaced.sourceId } },
    molit: { sourceId: molitPrevious.sourceId, rawBytes: molitBytes, rawSha256: sha(molitBytes), records: molit, previous: molitPrevious, migration: buildMolitMigration({ legacyHead: molitPrevious, projection: molit, snapshotId: snapshotId("molit-urban-rail-full-route", observedAt) }) },
  };
}

function snapshotId(sourceId, observedAt) { return `${sourceId}-current-${observedAt.replaceAll(/[-:.]/gu, "")}`; }
async function fetchBytes(fetchImpl, url, source, contentType) {
  let response;
  try { response = await fetchImpl(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000) }); } catch { fail(`${source}_TRANSPORT`); }
  if (!response?.ok || response.status !== 200) {
    const status = response?.status;
    const suffix = Number.isSafeInteger(status) && status >= 100 && status <= 599 && status !== 200 ? `_${status}` : "";
    fail(`${source}_HTTP${suffix}`);
  }
  if (!contentType.test(response.headers?.get("content-type") ?? "")) fail(`${source}_CONTENT_TYPE`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 16 * 1024 * 1024) fail(`${source}_BODY`);
  return bytes;
}
function currentHead(snapshots, sourceId) {
  const candidates = snapshots.filter((snapshot) => snapshot?.sourceId === sourceId);
  const referenced = new Set(candidates.map(({ previousSnapshotId }) => previousSnapshotId).filter(Boolean));
  const heads = candidates.filter(({ snapshotId }) => !referenced.has(snapshotId));
  if (heads.length !== 1 || typeof heads[0].snapshotId !== "string" || !/^[a-f0-9]{64}$/u.test(heads[0].rawSha256 ?? "") || !/^[a-f0-9]{64}$/u.test(heads[0].schemaFingerprint ?? "")) fail("LINEAGE");
  return heads[0];
}
export function projectPositions(bytes, observedAt) {
  let envelope; try { envelope = JSON.parse(bytes.toString("utf8")); } catch { fail("SEOUL_POSITIONS_SCHEMA"); }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || !Array.isArray(envelope.data) || !Number.isSafeInteger(envelope.currentCount) || !Number.isSafeInteger(envelope.matchCount) || !Number.isSafeInteger(envelope.totalCount) || envelope.page !== 1 || envelope.perPage !== 1000 || envelope.currentCount !== envelope.data.length || envelope.matchCount !== envelope.data.length || envelope.totalCount !== envelope.data.length || envelope.data.length === 0) fail("SEOUL_POSITIONS_SCHEMA");
  const seen = new Set(); let basisDate = null;
  const records = envelope.data.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row) || JSON.stringify(Object.keys(row).sort()) !== JSON.stringify([...POSITION_FIELDS].sort())) fail("SEOUL_POSITIONS_SCHEMA");
    const [serial, line, stationCode, stationName, latText, lonText, rowBasisDate] = POSITION_FIELDS.map((field) => String(row[field] ?? "").trim());
    const latitude = Number(latText); const longitude = Number(lonText); const key = `${line}:${stationCode}`;
    const basisMillis = Date.parse(`${rowBasisDate}T00:00:00.000Z`); const basisRoundTrip = Number.isFinite(basisMillis) && new Date(basisMillis).toISOString().slice(0, 10) === rowBasisDate;
    if (!/^\d+$/u.test(serial) || !/^[1-8]$/u.test(line) || !/^\d{3,4}$/u.test(stationCode) || stationName === "" || !Number.isFinite(latitude) || latitude < 37 || latitude > 38.2 || !Number.isFinite(longitude) || longitude < 126.5 || longitude > 127.5 || !/^\d{4}-\d{2}-\d{2}$/u.test(rowBasisDate) || !basisRoundTrip || (observedAt != null && basisMillis > Date.parse(observedAt)) || seen.has(key)) fail("SEOUL_POSITIONS_SCHEMA");
    seen.add(key); if (basisDate !== null && basisDate !== rowBasisDate) fail("SEOUL_POSITIONS_SCHEMA"); basisDate = rowBasisDate;
    return { serial: Number(serial), line, stationCode, stationName, latitude, longitude, basisDate: rowBasisDate };
  });
  return normalizeCurrentSeoulPositionCompleteness(records)
    .sort((left, right) => Number(left.line) - Number(right.line) || (left.stationCode < right.stationCode ? -1 : left.stationCode > right.stationCode ? 1 : 0));
}
export function projectMolit(bytes) {
  let text; try { text = new TextDecoder("euc-kr", { fatal: true }).decode(bytes); } catch { fail("MOLIT_ENCODING"); }
  const rows = parseCsv(text); if (rows.length < 2 || JSON.stringify(rows[0]) !== JSON.stringify(CSV_HEADER) || rows.slice(1).some((row) => row.length !== 6)) fail("MOLIT_SCHEMA");
  const records = rows.slice(1).map((cells) => { const values = cells.map((value) => value.trim()); const sequence = Number(values[4]); if (values.some((value) => value === "") || !Number.isInteger(sequence) || sequence < 1 || MOLIT_REGIONS[values[0]] !== values[1]) fail("MOLIT_SCHEMA"); values[4] = sequence; return Object.fromEntries(MOLIT_FIELDS.map((field, index) => [field, values[index]])); });
  return assertCurrentMolitFullRouteCompleteness(records);
}
function buildMolitMigration({ legacyHead, projection, snapshotId: id }) {
  if (!legacyHead || legacyHead.sourceId !== "molit-urban-rail-full-route" || !Array.isArray(legacyHead.providerRecordHashes) || typeof legacyHead.snapshotId !== "string") fail("LINEAGE");
  return { schemaVersion: 1, artifactKind: "source-projection-migration-evidence", migrationKind: "LEGACY_SAMPLE_TO_FULL_CONSUMED_FIELDS", sourceId: legacyHead.sourceId, legacySnapshotId: legacyHead.snapshotId, legacyRawSha256: legacyHead.rawSha256, legacySchemaFingerprint: legacyHead.schemaFingerprint, legacyProviderRecordHashes: [...legacyHead.providerRecordHashes], fullProjectionSha256: sha(Buffer.from(`${JSON.stringify(projection)}\n`)), fullProjectionSchemaFingerprint: sha(JSON.stringify(MOLIT_FIELDS)), fullProjectionRowCount: projection.length, newSnapshotId: id };
}
function parseCsv(value) { if (value.replaceAll("\r\n", "").includes("\r")) fail("MOLIT_SCHEMA"); return value.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line).filter((line) => line !== "").map((line) => line.split(",")); }
