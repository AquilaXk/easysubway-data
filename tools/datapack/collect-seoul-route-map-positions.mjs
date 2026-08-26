#!/usr/bin/env node
// Public coordinate facts are deliberately separate from this product-owned layout.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

const DATASET_ID = "15099316";
const DETAIL_URL = `https://www.data.go.kr/data/${DATASET_ID}/fileData.do`;
const SOURCE_ID = "seoul-metro-route-map-positions";
const ARTIFACT_KIND = "seoul-metro-route-map-positions-snapshot";
const TOPOLOGY_SOURCE_ID = "capital-route-topology";
const TOPOLOGY_ARTIFACT_KIND = "capital-route-topology-snapshot";
const LAYOUT_ALGORITHM_VERSION = "seoul-public-latlon-line-order-layout-v2";
const ALIAS_LEDGER_VERSION = "seoul-public-line-order-aliases-v1";
const CANVAS = Object.freeze({ minLat: 37_000_000, maxLat: 38_200_000, minLon: 126_500_000, maxLon: 127_500_000, width: 100_000, height: 120_000, margin: 2_000 });
const LINE_IDS_BY_NUMBER = Object.freeze({ "1": "line-472a81add377", "2": "seoul-2", "3": "line-41a8c75ec9d8", "4": "seoul-4", "5": "line-80fc4d5350d4", "6": "line-3f41718e0833", "7": "line-15b3b8a93259", "8": "line-2b2d9eaa53d0" });
const LINE_IDS = Object.freeze(Object.values(LINE_IDS_BY_NUMBER));
const KNOWN_STATION_IDS = Object.freeze({ 상록수: "station-sangnoksu", 사당: "station-sadang", 강남: "station-gangnam", 성수: "station-seongsu", 신설동: "station-sinseoldong" });
const ALIASES = Object.freeze({ "1:서울": "서울역", "4:당고개": "불암산(당고개)", "4:서울": "서울역", "5:하남검단산": "하남검단산역", "7:뚝섬유원지": "자양(뚝섬한강공원)" });
const PROVIDER_FIELDS = Object.freeze(["line", "lineId", "stationCode", "stationName", "latitude", "longitude", "basisDate"]);
const DERIVED_FIELDS = Object.freeze(["canvasX", "canvasY", "canvasOrigin", "sharedCoordinateAnchorStationKeys", "labelDx", "labelDy", "labelPolygon", "layoutTracks"]);

export function compareCodepoints(a, b) { a = String(a); b = String(b); return a < b ? -1 : a > b ? 1 : 0; }

export function parseSeoulRouteMapPositionsCsv(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new Error("Seoul route map positions CSV bytes are required");
  const rows = csv(decode(bytes)); if (rows.length < 2) throw new Error("Seoul route map positions CSV has no data rows");
  const header = rows[0]; const ix = { line: header.indexOf("호선"), stationCode: header.indexOf("고유역번호(외부역코드)"), stationName: header.indexOf("역명"), latitude: header.indexOf("위도"), longitude: header.indexOf("경도"), basisDate: header.indexOf("작성기준일") };
  for (const [key, value] of Object.entries(ix)) if (value < 0) throw new Error(`Seoul route map positions CSV missing column: ${key}`);
  return normalize(rows.slice(1).map((row, i) => { if (row.length !== header.length) throw new Error(`Seoul route map positions CSV column count mismatch at row ${i + 2}`); return Object.fromEntries(Object.entries(ix).map(([key, index]) => [key, row[index]])); }));
}

// Pure live-runner entrypoint: API records are normalized facts, topology is exact bytes.
export function buildSeoulRouteMapPositions({ records, topologySnapshotBytes, topologySnapshotId, now = new Date(), rawSha256 } = {}) {
  const capturedAt = date(now, "now"); const { rawPositions, observedDataUpdatedAt } = normalize(records);
  if (Date.parse(`${observedDataUpdatedAt}T00:00:00.000Z`) > capturedAt.getTime()) throw new Error(`Seoul route map positions future basisDate: ${observedDataUpdatedAt}`);
  const topology = parseTopology(topologySnapshotBytes, topologySnapshotId); const order = selectOrder(topology.value, topologySnapshotId).lineOrders; const aliases = aliasLedger(); const joinLedger = buildJoinLedger(rawPositions, order);
  const layoutPositions = layout(rawPositions, order, joinLedger); const layoutTracks = tracks(rawPositions, layoutPositions, order, joinLedger); const scope = rawPositions.map(scopeRow); const lineOrderSha256 = hash(json(order)); const aliasLedgerSha256 = hash(json(aliases)); const outputSchemaSha256 = hash(json(schema()));
  const snapshot = {
    schemaVersion: 3, artifactKind: ARTIFACT_KIND, sourceId: SOURCE_ID, detailUrl: DETAIL_URL, datasetId: DATASET_ID, datasetUrl: DETAIL_URL, endpoint: DETAIL_URL, capturedAt: capturedAt.toISOString(), observedDataUpdatedAt,
    official: true, fixture: false, credentialRequired: false, credentialRedacted: true, rawStationCount: rawPositions.length, stationCount: layoutPositions.length, lineIds: [...LINE_IDS], lineStationCounts: counts(rawPositions),
    fieldsProvided: [...PROVIDER_FIELDS], derivedFields: [...DERIVED_FIELDS], layoutAlgorithmVersion: LAYOUT_ALGORITHM_VERSION, topologySnapshotId, topologySnapshotSha256: topology.sha256, topologySnapshotIdentity: `${topologySnapshotId}:${topology.sha256}`, publicLineOrder: order, lineOrderSha256, aliasLedgerVersion: aliases.version, aliasLedgerSha256,
    license: { type: "PUBLIC_DATA_FREE_USE", attribution: "서울교통공사 · 공공데이터포털 이용허락범위 제한 없음", redistributionAllowed: true, evidenceUrl: DETAIL_URL }, scope, scopeSha256: hash(json(scope)), rawSha256: rawSha256 ?? hash(json(rawPositions.map(providerRow))), layoutInput: "rawPositions", rawPositions, rawPositionsSha256: hash(json(rawPositions)), layoutPositions, layoutPositionsSha256: hash(json(layoutPositions)), layoutTracks, layoutTracksSha256: hash(json(layoutTracks)), outputSchemaSha256,
  };
  snapshot.semanticInputSha256 = semanticInput(snapshot); snapshot.semanticOutputSha256 = semanticOutput(snapshot);
  return validateSeoulRouteMapPositionsSnapshot(snapshot, { topologySnapshotBytes });
}

export function collectSeoulRouteMapPositions({ csvBytes, topologySnapshotBytes, topologySnapshot, topologySnapshotId, now = new Date() } = {}) {
  const parsed = parseSeoulRouteMapPositionsCsv(csvBytes); const bytes = topologySnapshotBytes ?? (topologySnapshot ? Buffer.from(json(topologySnapshot)) : null);
  return buildSeoulRouteMapPositions({ records: parsed.rawPositions, topologySnapshotBytes: bytes, topologySnapshotId, now, rawSha256: hash(Buffer.from(csvBytes)) });
}

export function projectSeoulPublicLineOrder(topologySnapshot, topologySnapshotId) { return selectOrder(validateTopology(topologySnapshot), topologySnapshotId); }

export function validateSeoulRouteMapPositionsSnapshot(snapshot, { topologySnapshotBytes } = {}) {
  try {
    rejectLegacyDiagnostic(snapshot);
    const topology = parseTopology(topologySnapshotBytes, snapshot?.topologySnapshotId);
    if (!snapshot || snapshot.schemaVersion !== 3 || snapshot.artifactKind !== ARTIFACT_KIND || snapshot.sourceId !== SOURCE_ID || snapshot.official !== true || snapshot.fixture !== false || snapshot.credentialRequired !== false || snapshot.credentialRedacted !== true || snapshot.datasetId !== DATASET_ID || snapshot.detailUrl !== DETAIL_URL || snapshot.datasetUrl !== DETAIL_URL || snapshot.endpoint !== DETAIL_URL || !instant(snapshot.capturedAt) || !dateOnly(snapshot.observedDataUpdatedAt) || Date.parse(`${snapshot.observedDataUpdatedAt}T00:00:00.000Z`) > Date.parse(snapshot.capturedAt) || !Array.isArray(snapshot.rawPositions) || snapshot.rawPositions.length === 0 || !same(snapshot.lineIds, LINE_IDS) || !same(snapshot.fieldsProvided, PROVIDER_FIELDS) || !same(snapshot.derivedFields, DERIVED_FIELDS) || snapshot.layoutAlgorithmVersion !== LAYOUT_ALGORITHM_VERSION || snapshot.layoutInput !== "rawPositions" || snapshot.rawStationCount !== snapshot.rawPositions.length || snapshot.rawPositionsSha256 !== hash(json(snapshot.rawPositions)) || snapshot.aliasLedgerVersion !== ALIAS_LEDGER_VERSION || snapshot.aliasLedgerSha256 !== hash(json(aliasLedger())) || !isHash(snapshot.topologySnapshotSha256) || snapshot.topologySnapshotIdentity !== `${snapshot.topologySnapshotId}:${snapshot.topologySnapshotSha256}` || topology.sha256 !== snapshot.topologySnapshotSha256) throw Error("shape");
    const normalized = normalize(snapshot.rawPositions); if (!same(normalized.rawPositions, snapshot.rawPositions) || normalized.observedDataUpdatedAt !== snapshot.observedDataUpdatedAt) throw Error("raw");
    const order = selectOrder(topology.value, snapshot.topologySnapshotId).lineOrders;
    if (snapshot.lineOrderSha256 !== hash(json(order))) throw Error("order");
    const joinLedger = buildJoinLedger(snapshot.rawPositions, order); const layoutPositions = layout(snapshot.rawPositions, order, joinLedger); const layoutTracks = tracks(snapshot.rawPositions, layoutPositions, order, joinLedger); const scope = snapshot.rawPositions.map(scopeRow);
    if (!same(snapshot.layoutPositions, layoutPositions) || !same(snapshot.layoutTracks, layoutTracks) || snapshot.layoutPositionsSha256 !== hash(json(layoutPositions)) || snapshot.layoutTracksSha256 !== hash(json(layoutTracks)) || snapshot.outputSchemaSha256 !== hash(json(schema())) || snapshot.semanticInputSha256 !== semanticInput(snapshot) || snapshot.semanticOutputSha256 !== semanticOutput(snapshot) || snapshot.stationCount !== layoutPositions.length || !same(snapshot.lineStationCounts, counts(snapshot.rawPositions)) || !same(snapshot.scope, scope) || snapshot.scopeSha256 !== hash(json(scope))) throw Error("derived");
  } catch { throw new Error("invalid Seoul route map positions snapshot"); }
  return snapshot;
}

function normalize(records) {
  if (!Array.isArray(records) || records.length === 0) throw new Error("Seoul route map positions records are required");
  const seen = new Set(); let observedDataUpdatedAt;
  const rawPositions = records.map((r, i) => {
    const line = String(r?.line ?? "").trim(); const lineId = String(r?.lineId ?? LINE_IDS_BY_NUMBER[line] ?? ""); const stationCode = String(r?.stationCode ?? "").trim(); const stationName = String(r?.stationName ?? "").trim(); const key = `${lineId}:${stationCode}`;
    if (LINE_IDS_BY_NUMBER[line] !== lineId) throw new Error(`Seoul route map positions unknown line at record ${i + 1}`); if (!/^\d{3,4}$/.test(stationCode)) throw new Error(`Seoul route map positions invalid station code at record ${i + 1}`); if (!stationName || stationName.length > 40) throw new Error(`Seoul route map positions invalid station name at record ${i + 1}`); if (seen.has(key)) throw new Error(`Seoul route map positions duplicate station: ${key}`); seen.add(key);
    const latitude = canonicalSeoulRouteMapCoordinate(r?.latitude, "latitude", key); const longitude = canonicalSeoulRouteMapCoordinate(r?.longitude, "longitude", key); const lat = Math.round(latitude * 1_000_000); const lon = Math.round(longitude * 1_000_000); if (lat < CANVAS.minLat || lat > CANVAS.maxLat || lon < CANVAS.minLon || lon > CANVAS.maxLon) throw new Error(`Seoul route map positions invalid coordinates: ${key}`);
    const basisDate = parseDate(String(r?.basisDate ?? "").trim(), "basisDate"); if (observedDataUpdatedAt && observedDataUpdatedAt !== basisDate) throw new Error(`Seoul route map positions inconsistent basisDate: ${basisDate}`); observedDataUpdatedAt = basisDate;
    return { line, lineId, stationCode, stationName, latitude, longitude, basisDate };
  }).sort(comparePosition);
  return { rawPositions, observedDataUpdatedAt };
}

function parseTopology(bytes, id) { if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || typeof id !== "string" || !id) throw new Error("Seoul public topology snapshot bytes and snapshot id are required"); let value; try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error("Seoul public topology input must be JSON"); } return { value: validateTopology(value), sha256: hash(Buffer.from(bytes)) }; }
function validateTopology(value) { if (!value || typeof value !== "object" || value.sourceId !== TOPOLOGY_SOURCE_ID || value.artifactKind !== TOPOLOGY_ARTIFACT_KIND || value.official !== true || !Array.isArray(value.lines)) throw new Error("invalid Seoul public topology snapshot"); return value; }
function selectOrder(topology, topologySnapshotId) {
  const found = new Map(); for (const line of topology.lines) { if (!LINE_IDS.includes(line?.lineId)) continue; if (found.has(line.lineId)) throw new Error(`duplicate required Seoul public topology line: ${line.lineId}`); found.set(line.lineId, line); }
  return { topologySnapshotId, lineOrders: Object.entries(LINE_IDS_BY_NUMBER).map(([line, lineId]) => { const source = found.get(lineId); if (!source || !Array.isArray(source.branchSequences)) throw new Error(`Seoul public topology missing line: ${line}`); const branchSequences = source.branchSequences.map((branch, index) => { const branchName = String(branch?.branchName ?? "").trim(); const stationNames = branch?.stationNames; if (!branchName || !Array.isArray(stationNames) || stationNames.some((x) => !String(x ?? "").trim() || String(x).trim().length > 40)) throw new Error(`invalid Seoul public topology branch: ${line}:${index + 1}`); return { branchName, stationNames: stationNames.map((x) => String(x).trim()) }; }).sort((a, b) => compareCodepoints(json(a), json(b))); if (!branchSequences.length) throw new Error(`Seoul public topology has no branch: ${line}`); return { line, lineId, branchSequences }; }) };
}
function canonicalOrder(order) { return selectOrder({ sourceId: TOPOLOGY_SOURCE_ID, artifactKind: TOPOLOGY_ARTIFACT_KIND, official: true, lines: order.map(({ lineId, branchSequences }) => ({ lineId, branchSequences })) }, "stored").lineOrders; }
function buildJoinLedger(rawPositions, order) {
  const occurrences = new Set(); const rawByName = new Map();
  for (const line of order) for (const branch of line.branchSequences) for (const stationName of branch.stationNames) occurrences.add(`${line.line}:${norm(stationName)}`);
  for (const raw of rawPositions) {
    const joinKey = `${raw.line}:${norm(orderName(raw))}`;
    if (!occurrences.has(joinKey)) throw new Error(`Seoul public line-order missing station: ${raw.line}:${raw.stationName}`);
    const prior = rawByName.get(joinKey);
    if (prior && (prior.stationCode !== raw.stationCode || prior.stationName !== raw.stationName)) throw new Error(`ambiguous Seoul public line-order join: ${joinKey}`);
    rawByName.set(joinKey, raw);
  }
  // A topology-only station outside the observed public-coordinate scope may
  // split a track. A missing station bracketed by two observed stations is a
  // required join and must not silently turn into a shortcut edge.
  for (const line of order) for (const branch of line.branchSequences) {
    for (let index = 1; index < branch.stationNames.length - 1; index += 1) {
      const previous = `${line.line}:${norm(branch.stationNames[index - 1])}`;
      const current = `${line.line}:${norm(branch.stationNames[index])}`;
      const next = `${line.line}:${norm(branch.stationNames[index + 1])}`;
      if (rawByName.has(previous) && rawByName.has(next) && !rawByName.has(current)) throw new Error(`missing required Seoul public line-order station: ${current}`);
    }
  }
  return rawByName;
}
function layout(rawPositions, order, joinLedger) {
  const output = new Map(rawPositions.map((raw) => [key(raw), { raw, ...projectLatLon(raw.latitude, raw.longitude), canvasOrigin: "PROJECTED_OFFICIAL_LATLON", sharedCoordinateAnchorStationKeys: [] }])); const groups = new Map();
  for (const raw of rawPositions) { const k = `${raw.latitude},${raw.longitude}`; const g = groups.get(k) ?? []; g.push(raw); groups.set(k, g); }
  for (const group of groups.values()) if (new Set(group.map((x) => x.stationName)).size > 1) { const spread = findSpread(group, order, joinLedger); for (const [i, raw] of spread.group.entries()) { const point = output.get(key(raw)); point.canvasX = interpolate(spread.before.canvasX, spread.after.canvasX, i + 1, spread.group.length + 1); point.canvasY = interpolate(spread.before.canvasY, spread.after.canvasY, i + 1, spread.group.length + 1); point.canvasOrigin = "DERIVED_SHARED_COORDINATE_SPREAD"; point.sharedCoordinateAnchorStationKeys = [key(spread.before.raw), key(spread.after.raw)]; } }
  return rawPositions.map((raw) => { const point = output.get(key(raw)); return { lineId: raw.lineId, stationCode: raw.stationCode, stationName: raw.stationName, stationId: stationId(raw.stationName), canvasX: point.canvasX, canvasY: point.canvasY, canvasOrigin: point.canvasOrigin, sharedCoordinateAnchorStationKeys: point.sharedCoordinateAnchorStationKeys, ...label(raw.stationName, point.canvasX, point.canvasY) }; });
}
function findSpread(group, order, joinLedger) {
  const groupKeys = new Set(group.map(key)); const byName = joinLedger; const candidates = [];
  for (const line of order) for (const branch of line.branchSequences) { const rows = branch.stationNames.map((name) => byName.get(`${line.line}:${norm(name)}`) ?? null); for (let start = 0; start < rows.length; start += 1) { const run = rows.slice(start, start + group.length); const before = rows[start - 1]; const after = rows[start + group.length]; if (run.length !== group.length || run.some((x) => !x) || !run.every((x) => groupKeys.has(key(x))) || !before || !after || groupKeys.has(key(before)) || groupKeys.has(key(after)) || `${before.latitude},${before.longitude}` === `${group[0].latitude},${group[0].longitude}` || `${after.latitude},${after.longitude}` === `${group[0].latitude},${group[0].longitude}`) continue; candidates.push({ group: run, before: { raw: before, ...projectLatLon(before.latitude, before.longitude) }, after: { raw: after, ...projectLatLon(after.latitude, after.longitude) }, sortKey: `${line.lineId}\u0000${branch.branchName}\u0000${start}` }); } }
  candidates.sort((a, b) => compareCodepoints(a.sortKey, b.sortKey)); if (!candidates.length) throw new Error(`Seoul route map shared coordinates cannot be deterministically spread: ${group.map(key).join(",")}`); return candidates[0];
}
function tracks(rawPositions, layoutPositions, order, joinLedger) {
  const byName = joinLedger; const byKey = new Map(layoutPositions.map((p) => [`${p.lineId}:${p.stationCode}`, p])); const output = [];
  for (const line of order) for (const [branchIndex, branch] of line.branchSequences.entries()) { let run = []; const push = () => { if (run.length >= 2) output.push({ lineId: line.lineId, branchName: branch.branchName, branchIndex, stationKeys: run.map(key), points: run.map((raw) => { const p = byKey.get(key(raw)); return { x: p.canvasX, y: p.canvasY }; }) }); run = []; }; for (const name of branch.stationNames) { const raw = byName.get(`${line.line}:${norm(name)}`); if (raw) run.push(raw); else push(); } push(); }
  return output.sort((a, b) => compareCodepoints(json(a), json(b)));
}
export function projectLatLon(latitude, longitude) { const lat = micro(latitude, "latitude", "projection"); const lon = micro(longitude, "longitude", "projection"); if (lat < CANVAS.minLat || lat > CANVAS.maxLat || lon < CANVAS.minLon || lon > CANVAS.maxLon) throw new Error(`Seoul route map projection out of bounds: ${latitude},${longitude}`); return { canvasX: CANVAS.margin + Math.round((lon - CANVAS.minLon) * (CANVAS.width - 2 * CANVAS.margin) / (CANVAS.maxLon - CANVAS.minLon)), canvasY: CANVAS.margin + Math.round((CANVAS.maxLat - lat) * (CANVAS.height - 2 * CANVAS.margin) / (CANVAS.maxLat - CANVAS.minLat)) }; }
export function canonicalSeoulRouteMapCoordinate(value, field = "coordinate", record = "projection") { return micro(value, field, record) / 1_000_000; }
function rejectLegacyDiagnostic(snapshot) { if (snapshot && Object.hasOwn(snapshot, "legacyDiagnostic")) throw new Error("legacy route map diagnostic is not a current V2 surface"); }
function semanticInput(s) { return hash(json({ observedDataUpdatedAt: s.observedDataUpdatedAt, rawPositions: s.rawPositions, topologySnapshotId: s.topologySnapshotId, topologySnapshotSha256: s.topologySnapshotSha256, lineOrderSha256: s.lineOrderSha256, aliasLedgerVersion: s.aliasLedgerVersion, aliasLedgerSha256: s.aliasLedgerSha256, layoutAlgorithmVersion: s.layoutAlgorithmVersion })); }
function semanticOutput(s) { return hash(json({ rawPositions: s.rawPositions, layoutPositions: s.layoutPositions, layoutTracks: s.layoutTracks, outputSchemaSha256: s.outputSchemaSha256, layoutAlgorithmVersion: s.layoutAlgorithmVersion })); }
function schema() { return { rawPositions: PROVIDER_FIELDS, layoutPositions: ["lineId", "stationCode", "stationName", "stationId", "canvasX", "canvasY", "canvasOrigin", "sharedCoordinateAnchorStationKeys", "labelDx", "labelDy", "labelPolygon"], layoutTracks: ["lineId", "branchName", "branchIndex", "stationKeys", "points"] }; }
function aliasLedger() { return { version: ALIAS_LEDGER_VERSION, entries: Object.fromEntries(Object.entries(ALIASES).sort(([a], [b]) => compareCodepoints(a, b))) }; }
function providerRow(raw) { return Object.fromEntries(PROVIDER_FIELDS.map((field) => [field, raw[field]])); }
function scopeRow(raw) { return { lineId: raw.lineId, stationCode: raw.stationCode, stationName: raw.stationName, stationId: stationId(raw.stationName) }; }
export function canonicalSeoulRouteMapStationName(line, stationName) {
  return ALIASES[`${line}:${stationName}`] ?? stationName;
}
function orderName(raw) { return canonicalSeoulRouteMapStationName(raw.line, raw.stationName); }
function label(name, x, y) { const width = Math.max(28, [...norm(name)].length * 14), height = 22, left = Math.max(0, x - Math.floor(width / 2)), top = Math.max(0, y - 34); return { labelDx: Math.round(left + width / 2 - x), labelDy: Math.round(top + height / 2 - y), labelPolygon: [{ x: left, y: top }, { x: left + width, y: top }, { x: left + width, y: top + height }, { x: left, y: top + height }] }; }
function counts(rows) { return Object.fromEntries(Object.keys(LINE_IDS_BY_NUMBER).map((line) => [line, rows.filter((row) => row.line === line).length])); }
function key(raw) { return `${raw.lineId}:${raw.stationCode}`; }
function comparePosition(a, b) { return Number(a.line) - Number(b.line) || compareCodepoints(a.stationCode, b.stationCode); }
function norm(value) { return String(value).normalize("NFKC").replace(/\s+/g, "").replace(/\([^()]*\)$/, ""); }
function stationId(name) { const n = norm(name); return KNOWN_STATION_IDS[n] ?? `station-${sha1(`수도권:${n}`).slice(0, 12)}`; }
function micro(value, field, record) { const text = String(value ?? "").trim(); if (!/^-?\d+(?:\.\d{1,12})?$/.test(text)) throw new Error(`Seoul route map positions invalid ${field}: ${record}`); const negative = text.startsWith("-"); const [whole, fraction = ""] = (negative ? text.slice(1) : text).split("."); let result = Number(whole) * 1_000_000 + Number((fraction + "000000").slice(0, 6)); if ((fraction[6] ?? "0") >= "5") result += 1; return negative ? -result : result; }
function interpolate(a, b, n, d) { return Math.round((a * (d - n) + b * n) / d); }
function decode(bytes) { try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return new TextDecoder("euc-kr", { fatal: true }).decode(bytes); } }
function csv(text) { return text.split(/\r?\n/).filter(Boolean).map((line) => line.split(",")); }
function parseDate(value, field) { if (!dateOnly(value)) throw new Error(`Seoul route map positions invalid ${field}: ${value || "missing"}`); return value; }
function dateOnly(value) { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const date = new Date(`${value}T00:00:00.000Z`); return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value; }
function instant(value) { return typeof value === "string" && !Number.isNaN(Date.parse(value)); }
function date(value, label) { const result = value instanceof Date ? value : new Date(value); if (Number.isNaN(result.getTime())) throw new Error(`${label} is invalid`); return result; }
function same(a, b) { return json(a) === json(b); }
function isHash(value) { return /^[a-f0-9]{64}$/.test(value ?? ""); }
function json(value) { if (Array.isArray(value)) return `[${value.map(json).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort(compareCodepoints).map((key) => `${JSON.stringify(key)}:${json(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function sha1(value) { return createHash("sha1").update(value).digest("hex"); } // NOSONAR -- persisted non-security station identity compatibility
function parseArgs(argv) { const args = {}; for (let i = 0; i < argv.length; i += 2) { if (!argv[i]?.startsWith("--")) throw new Error("usage: collect-seoul-route-map-positions.mjs --input <csv> --topology-input <json> --topology-snapshot-id <id> --output <absolute.json> [--captured-at <iso>]"); args[argv[i].slice(2)] = argv[i + 1]; } if (!args.input || !args["topology-input"] || !args["topology-snapshot-id"] || !args.output || !path.isAbsolute(args.output)) throw new Error("usage: collect-seoul-route-map-positions.mjs --input <csv> --topology-input <json> --topology-snapshot-id <id> --output <absolute.json> [--captured-at <iso>]"); return args; }
export async function runSeoulRouteMapPositionsCollector(argv) { const args = parseArgs(argv); const [csvBytes, topologySnapshotBytes] = await Promise.all([readFile(args.input), readFile(args["topology-input"])]); const snapshot = collectSeoulRouteMapPositions({ csvBytes, topologySnapshotBytes, topologySnapshotId: args["topology-snapshot-id"], now: args["captured-at"] ? new Date(args["captured-at"]) : new Date() }); await writeFile(args.output, `${JSON.stringify(snapshot)}\n`); console.log(`Seoul route map positions snapshot ready: stations=${snapshot.rawStationCount}`); return snapshot; }
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) { try { await runSeoulRouteMapPositionsCollector(process.argv.slice(2)); } catch (error) { console.error(error instanceof Error ? error.message : "Seoul route map position collection failed"); process.exitCode = 1; } }
