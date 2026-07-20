#!/usr/bin/env node
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE_ID = "gwangju-transportation-route-topology";
export const GWANGJU_ROUTE_TOPOLOGY_ENDPOINT =
  "https://www.grtc.co.kr/subway/openapi/json/stationTimeInfomation";
const STATION_IDS = Object.freeze(Array.from({ length: 20 }, (_, index) => index + 1));
const FRESHNESS_MILLIS = 24 * 60 * 60 * 1_000;

export async function collectGwangjuRouteTopology({
  fetchImpl = fetch,
  sleepImpl = sleep,
  now = new Date(),
} = {}) {
  const capturedAt = validDate(now, "now");
  const responses = [];
  const namesById = new Map();
  const odRows = [];
  for (const stationId of STATION_IDS) {
    const url = new URL(GWANGJU_ROUTE_TOPOLOGY_ENDPOINT);
    url.searchParams.set("station_id", String(stationId));
    const response = await fetchWithRetry(url, fetchImpl, sleepImpl);
    if (!response.ok) throw new Error(`Gwangju route topology HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    responses.push(sha256(bytes));
    let rows;
    try {
      rows = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new Error("Gwangju route topology schema mismatch: response is not UTF-8 JSON");
    }
    if (!Array.isArray(rows) || rows.length !== 19) {
      throw new Error(`Gwangju route topology OD row count mismatch: station_id=${stationId}`);
    }
    const endIds = new Set();
    for (const [index, row] of rows.entries()) {
      const parsed = parseRow(row, stationId, index);
      if (endIds.has(parsed.endProviderStationId)) {
        throw new Error(`Gwangju route topology duplicate OD row: ${stationId}:${parsed.endProviderStationId}`);
      }
      endIds.add(parsed.endProviderStationId);
      admitName(namesById, parsed.startProviderStationId, parsed.startStationName);
      admitName(namesById, parsed.endProviderStationId, parsed.endStationName);
      odRows.push({ ...parsed, responseSha256: responses.at(-1) });
    }
    if (endIds.size !== 19 || STATION_IDS.some((id) => id !== stationId && !endIds.has(String(id)))) {
      throw new Error(`Gwangju route topology OD scope mismatch: station_id=${stationId}`);
    }
  }
  if (odRows.length !== 380 || namesById.size !== 20) {
    throw new Error("Gwangju route topology OD scope is incomplete");
  }

  const scope = STATION_IDS.map((providerStationId) => ({
    providerStationId: String(providerStationId),
    stationCode: stationCode(providerStationId),
    stationName: namesById.get(String(providerStationId)),
  })).sort(compareStationCode);
  const edges = odRows.filter(({ startProviderStationId, endProviderStationId }) =>
    Math.abs(Number(startProviderStationId) - Number(endProviderStationId)) === 1)
    .map((row) => ({
      fromProviderStationId: row.startProviderStationId,
      toProviderStationId: row.endProviderStationId,
      fromStationCode: stationCode(row.startProviderStationId),
      toStationCode: stationCode(row.endProviderStationId),
      fromStationName: namesById.get(row.startProviderStationId),
      toStationName: namesById.get(row.endProviderStationId),
      distanceMeters: Math.round(row.distanceKilometers * 1_000),
      durationSeconds: Math.round(row.durationMinutes * 60),
      responseSha256: row.responseSha256,
    })).sort((left, right) => compareStationCode(left, right)
      || Number(left.toStationCode) - Number(right.toStationCode));
  if (edges.length !== 38 || edges.some((edge) =>
    edge.distanceMeters <= 0 || edge.durationSeconds <= 0
    || Math.abs(Number(edge.fromStationCode) - Number(edge.toStationCode)) !== 1)) {
    throw new Error("Gwangju route topology adjacent edge scope mismatch");
  }
  const contentSha256 = sha256(JSON.stringify({ scope, edges }));
  return {
    schemaVersion: 1,
    artifactKind: "gwangju-route-topology-snapshot",
    sourceId: SOURCE_ID,
    official: true,
    fixture: false,
    endpoint: GWANGJU_ROUTE_TOPOLOGY_ENDPOINT,
    documentationUrl: "https://www.grtc.co.kr/subway/contents/apiRunInfo",
    capturedAt: capturedAt.toISOString(),
    freshUntil: new Date(capturedAt.getTime() + FRESHNESS_MILLIS).toISOString(),
    credentialRequired: false,
    requestCount: 20,
    stationCount: scope.length,
    odRowCount: odRows.length,
    edgeCount: edges.length,
    scope,
    edges,
    scopeSha256: sha256(JSON.stringify(scope)),
    edgesSha256: sha256(JSON.stringify(edges)),
    rawSha256: sha256(JSON.stringify(responses)),
    contentSha256,
    credentialRedacted: true,
  };
}

function parseRow(row, requestedStationId, index) {
  const startProviderStationId = requiredStationId(row?.start_station_id);
  const endProviderStationId = requiredStationId(row?.end_station_id);
  const distanceKilometers = Number(row?.station_distance);
  const durationMinutes = Number(row?.station_time);
  if (startProviderStationId !== String(requestedStationId)
    || endProviderStationId === startProviderStationId
    || !Number.isFinite(distanceKilometers) || distanceKilometers <= 0
    || !Number.isFinite(durationMinutes) || durationMinutes <= 0
    || !Number.isInteger(Math.round(distanceKilometers * 1_000))
    || !Number.isInteger(Math.round(durationMinutes * 60))) {
    throw new Error(`Gwangju route topology schema mismatch: station_id=${requestedStationId} row=${index}`);
  }
  return {
    startProviderStationId,
    endProviderStationId,
    startStationName: normalizedStationName(row.start_station_name),
    endStationName: normalizedStationName(row.end_station_name),
    distanceKilometers,
    durationMinutes,
  };
}

function requiredStationId(value) {
  const text = String(value ?? "");
  const number = Number(text);
  if (!Number.isInteger(number) || number < 1 || number > 20) {
    throw new Error("Gwangju route topology schema mismatch: station id");
  }
  return text;
}

function normalizedStationName(value) {
  const name = String(value ?? "").normalize("NFKC")
    .replace(/\([^)]*\)/g, "").replace(/[\s/.·]/g, "").replace(/역$/u, "");
  if (!/^[가-힣A-Za-z0-9()]{1,40}$/.test(name)) {
    throw new Error("Gwangju route topology schema mismatch: station name");
  }
  return name;
}

function admitName(namesById, id, name) {
  const canonicalName = id === "18" && new Set(["학동증심사", "학동증심사입구"]).has(name)
    ? "학동증심사입구" : name;
  const existing = namesById.get(id);
  if (existing && existing !== canonicalName) {
    throw new Error(`Gwangju route topology station name mismatch: ${id}`);
  }
  namesById.set(id, canonicalName);
}

function stationCode(providerStationId) { return String(120 - Number(providerStationId)); }
function compareStationCode(left, right) { return Number(left.stationCode ?? left.fromStationCode) - Number(right.stationCode ?? right.fromStationCode); }
function validDate(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} is invalid`);
  return date;
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function fetchWithRetry(url, fetchImpl, sleepImpl) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { accept: "application/json" },
      });
      if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
        await sleepImpl(250);
        continue;
      }
      return response;
    } catch (error) {
      if (attempt === 1) {
        const code = error?.code ?? error?.cause?.code ?? "UNKNOWN";
        throw new Error(`Gwangju route topology transport failure; code=${safeToken(String(code))}`);
      }
    }
  }
  throw new Error("Gwangju route topology transport failure");
}

function safeToken(value) { return /^[A-Za-z0-9._-]{1,32}$/.test(value) ? value : "UNKNOWN"; }

async function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== "--output" || !path.isAbsolute(args[1])) {
    throw new Error("usage: collect-gwangju-route-topology.mjs --output <absolute.json>");
  }
  const snapshot = await collectGwangjuRouteTopology();
  await writeFile(args[1], `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  console.log(`sanitized Gwangju route topology snapshot ready: edges=${snapshot.edgeCount}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Gwangju route topology collection failed");
    process.exitCode = 1;
  }
}
