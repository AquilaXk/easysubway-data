import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { normalizeDataGoKrServiceKey } from "./lib/provider-call-integrity.mjs";
import { canonicalSeoulRouteMapCoordinate } from "./collect-seoul-route-map-positions.mjs";
import {
  assertCurrentMolitFullRouteCompleteness,
  normalizeCurrentSeoulPositionCompleteness,
} from "./lib/static-network-successor-completeness.mjs";

export const MOLIT_URL = "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003561913&fileDetailSn=1&insertDataPrcus=N";
export const SEOUL_POSITIONS_URL = "https://api.odcloud.kr/api/15099316/v1/uddi:bc51de47-d3ea-4aa1-8ac2-d70f2b5e701e";
const CSV_HEADER = ["권역", "권역명", "철도운영기관명", "노선명", "순번", "역명"];
const MOLIT_FIELDS = ["region_code", "region_name", "operator_name", "line_name", "station_sequence", "station_name"];
const POSITION_FIELDS = ["연번", "호선", "고유역번호(외부역코드)", "역명", "위도", "경도", "작성기준일", "작성일자"];
const MOLIT_REGIONS = Object.freeze({ "01": "수도권", "02": "부산", "03": "대구", "04": "광주", "05": "대전" });
const sha = (value) => createHash("sha256").update(value).digest("hex");
const compareStrings = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
export const SEOUL_POSITION_SCHEMA_FINGERPRINT = sha(JSON.stringify([...POSITION_FIELDS].sort(compareStrings)));
const fail = (code) => { throw new Error(`STATIC_NETWORK_SUCCESSOR_${code}`); };

export function projectPositions(bytes, observedAt) {
  let envelope; try { envelope = JSON.parse(bytes.toString("utf8")); } catch { fail("SEOUL_POSITIONS_SCHEMA"); }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || !Array.isArray(envelope.data) || !Number.isSafeInteger(envelope.currentCount) || !Number.isSafeInteger(envelope.matchCount) || !Number.isSafeInteger(envelope.totalCount) || envelope.page !== 1 || envelope.perPage !== 1000 || envelope.currentCount !== envelope.data.length || envelope.matchCount !== envelope.data.length || envelope.totalCount !== envelope.data.length || envelope.data.length === 0) fail("SEOUL_POSITIONS_SCHEMA");
  const seen = new Set(); let basisDate = null;
  const records = envelope.data.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row) || JSON.stringify(Object.keys(row).sort()) !== JSON.stringify([...POSITION_FIELDS].sort())) fail("SEOUL_POSITIONS_SCHEMA");
    const [serial, line, stationCode, stationName, latText, lonText, rowBasisDate, rowCreatedDate] = POSITION_FIELDS.map((field) => String(row[field] ?? "").trim());
    const latitude = canonicalSeoulRouteMapCoordinate(latText, "latitude", `${line}:${stationCode}`); const longitude = canonicalSeoulRouteMapCoordinate(lonText, "longitude", `${line}:${stationCode}`); const key = `${line}:${stationCode}`;
    const basisMillis = Date.parse(`${rowBasisDate}T00:00:00.000Z`); const basisRoundTrip = Number.isFinite(basisMillis) && new Date(basisMillis).toISOString().slice(0, 10) === rowBasisDate;
    const createdMillis = Date.parse(`${rowCreatedDate}T00:00:00.000Z`); const createdRoundTrip = Number.isFinite(createdMillis) && new Date(createdMillis).toISOString().slice(0, 10) === rowCreatedDate;
    if (!/^\d+$/u.test(serial) || !/^[1-8]$/u.test(line) || !/^\d{3,4}$/u.test(stationCode) || stationName === "" || !Number.isFinite(latitude) || latitude < 37 || latitude > 38.2 || !Number.isFinite(longitude) || longitude < 126.5 || longitude > 127.5 || !/^\d{4}-\d{2}-\d{2}$/u.test(rowBasisDate) || !basisRoundTrip || !createdRoundTrip || (observedAt != null && (basisMillis > Date.parse(observedAt) || createdMillis > Date.parse(observedAt))) || seen.has(key)) fail("SEOUL_POSITIONS_SCHEMA");
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
function parseCsv(value) { if (value.replaceAll("\r\n", "").includes("\r")) fail("MOLIT_SCHEMA"); return value.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line).filter((line) => line !== "").map((line) => line.split(",")); }
