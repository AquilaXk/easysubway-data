#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE_ID = "gwangju-transportation-route-topology";
export const GWANGJU_ROUTE_TOPOLOGY_ENDPOINT =
  "https://www.grtc.co.kr/subway/openapi/json/stationTimeInfomation";
const FRESHNESS_MILLIS = 24 * 60 * 60 * 1_000;

export async function collectGwangjuRouteTopology({
  fetchImpl = fetch,
  sleepImpl = sleep,
  now = new Date(),
  stationScope,
  onRawResponse = undefined,
} = {}) {
  if (onRawResponse !== undefined && typeof onRawResponse !== "function") {
    throw new Error("Gwangju route topology raw response callback mismatch");
  }
  const capturedAt = validDate(now, "now");
  const scopeInput = validateStationScope(stationScope);
  const scopeById = new Map(scopeInput.map((row) => [row.providerStationId, row]));
  const responses = [];
  const rawResponses = [];
  const namesById = new Map();
  const odRows = [];
  for (const { providerStationId: stationId } of scopeInput) {
    const url = new URL(GWANGJU_ROUTE_TOPOLOGY_ENDPOINT);
    url.searchParams.set("station_id", String(stationId));
    const response = await fetchWithRetry(url, fetchImpl, sleepImpl);
    if (!response.ok) throw new Error(`Gwangju route topology HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    responses.push(sha256(bytes));
    // OCI 등록 시 재호출하지 않고 수집 당시 원문과 파생 topology를 함께 결속한다.
    const rawResponse = { providerStationId: stationId, bytesBase64: bytes.toString("base64") };
    rawResponses.push(rawResponse);
    if (onRawResponse) await onRawResponse(rawResponse);
    let rows;
    try {
      rows = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new Error("Gwangju route topology schema mismatch: response is not UTF-8 JSON");
    }
    if (!Array.isArray(rows) || rows.length !== scopeInput.length - 1) {
      throw new Error(`Gwangju route topology OD row count mismatch: station_id=${stationId}`);
    }
    const endIds = new Set();
    for (const [index, row] of rows.entries()) {
      const parsed = parseRow(row, stationId, index, scopeById);
      if (endIds.has(parsed.endProviderStationId)) {
        throw new Error(`Gwangju route topology duplicate OD row: ${stationId}:${parsed.endProviderStationId}`);
      }
      endIds.add(parsed.endProviderStationId);
      admitName(namesById, parsed.startProviderStationId, parsed.startStationName);
      admitName(namesById, parsed.endProviderStationId, parsed.endStationName);
      odRows.push({ ...parsed, responseSha256: responses.at(-1) });
    }
    if (endIds.size !== scopeInput.length - 1 || scopeInput.some(({ providerStationId }) => providerStationId !== stationId && !endIds.has(providerStationId))) {
      throw new Error(`Gwangju route topology OD scope mismatch: station_id=${stationId}`);
    }
  }
  if (odRows.length !== scopeInput.length * (scopeInput.length - 1) || namesById.size !== scopeInput.length) {
    throw new Error("Gwangju route topology OD scope is incomplete");
  }

  for (const seed of scopeInput) {
    if (!equivalentStationName(seed.stationName, namesById.get(seed.providerStationId))) throw new Error(`Gwangju route topology station name mismatch: ${seed.providerStationId}`);
  }
  const scope = scopeInput.map(({ providerStationId, stationCode }) => ({ providerStationId, stationCode, stationName: namesById.get(providerStationId) }));
  const position = new Map(scope.map(({ providerStationId }, index) => [providerStationId, index]));
  const edges = odRows.filter(({ startProviderStationId, endProviderStationId }) =>
    Math.abs(position.get(startProviderStationId) - position.get(endProviderStationId)) === 1)
    .map((row) => ({
      fromProviderStationId: row.startProviderStationId,
      toProviderStationId: row.endProviderStationId,
      fromStationCode: scopeById.get(row.startProviderStationId).stationCode,
      toStationCode: scopeById.get(row.endProviderStationId).stationCode,
      fromStationName: namesById.get(row.startProviderStationId),
      toStationName: namesById.get(row.endProviderStationId),
      distanceMeters: Math.round(row.distanceKilometers * 1_000),
      durationSeconds: Math.round(row.durationMinutes * 60),
      responseSha256: row.responseSha256,
    })).sort((left, right) => position.get(left.fromProviderStationId) - position.get(right.fromProviderStationId)
      || position.get(left.toProviderStationId) - position.get(right.toProviderStationId));
  if (edges.length !== 2 * (scope.length - 1) || edges.some((edge) =>
    edge.distanceMeters <= 0 || edge.durationSeconds <= 0
    || Math.abs(position.get(edge.fromProviderStationId) - position.get(edge.toProviderStationId)) !== 1)) {
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
    requestCount: scope.length,
    stationCount: scope.length,
    odRowCount: odRows.length,
    edgeCount: edges.length,
    scope,
    edges,
    scopeSha256: sha256(JSON.stringify(scope)),
    edgesSha256: sha256(JSON.stringify(edges)),
    rawSha256: sha256(JSON.stringify(responses)),
    rawResponses,
    contentSha256,
    credentialRedacted: true,
  };
}

function parseRow(row, requestedStationId, index, scopeById) {
  const startProviderStationId = requiredStationId(row?.start_station_id, scopeById);
  const endProviderStationId = requiredStationId(row?.end_station_id, scopeById);
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

function requiredStationId(value, scopeById) {
  const text = String(value ?? "");
  if (!scopeById.has(text)) {
    throw new Error("Gwangju route topology schema mismatch: station id");
  }
  return text;
}

function normalizedStationName(value) {
  // 동일 역 ID에서 공식 응답의 중복 접미사(역역)도 한 이름으로 정규화한다.
  const name = String(value ?? "").normalize("NFKC")
    .replace(/\([^)]*\)/g, "").replace(/[\s/.·]/g, "").replace(/역+$/u, "");
  if (!/^[가-힣A-Za-z0-9()]{1,40}$/.test(name)) {
    throw new Error("Gwangju route topology schema mismatch: station name");
  }
  return name;
}

function admitName(namesById, id, name) {
  const canonicalName = new Set(["학동증심사", "학동증심사입구"]).has(name) ? "학동증심사입구" : name;
  const existing = namesById.get(id);
  if (existing && existing !== canonicalName) {
    throw new Error(`Gwangju route topology station name mismatch: ${id}`);
  }
  namesById.set(id, canonicalName);
}

function equivalentStationName(left, right) {
  const normalize = (value) => new Set(["학동증심사", "학동증심사입구"]).has(value) ? "학동증심사입구" : value;
  return normalize(normalizedStationName(left)) === normalize(normalizedStationName(right));
}
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

export async function runGwangjuRouteTopologyCollector(args = process.argv.slice(2), {
  repositoryRoot = path.resolve(import.meta.dirname, "../.."), fetchImpl = fetch, sleepImpl = sleep, now = new Date(),
} = {}) {
  if (args.length !== 4 || args[0] !== "--inventory" || args[2] !== "--output" || !path.isAbsolute(args[3])) {
    throw new Error("usage: collect-gwangju-route-topology.mjs --inventory <repository-relative.json> --output <absolute.json>");
  }
  const failedOutputPath = `${args[3]}.failed.json`;
  await requireAbsentOutput(args[3], "topology output");
  await requireAbsentOutput(failedOutputPath, "topology failure output");
  const root = path.resolve(repositoryRoot);
  const inventoryPath = path.resolve(root, args[1]);
  if (!inventoryPath.startsWith(`${root}${path.sep}`)) throw new Error("Gwangju topology inventory path mismatch");
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  const source = inventory?.sources?.filter(({ id }) => id === SOURCE_ID);
  const evidence = source?.[0]?.topologyAdmissionEvidence;
  if (source?.length !== 1 || !/^[A-Za-z0-9._-]+$/u.test(evidence?.snapshotId ?? "")
    || evidence.snapshotPath !== `tools/datapack/sources/${evidence.snapshotId}.json`
    || !/^[a-f0-9]{64}$/u.test(evidence.contentSha256 ?? "")) throw new Error("Gwangju topology inventory selection mismatch");
  const snapshotPath = path.resolve(root, evidence.snapshotPath);
  if (!snapshotPath.startsWith(`${root}${path.sep}`)) throw new Error("Gwangju topology inventory snapshot mismatch");
  const seed = JSON.parse(await readFile(snapshotPath, "utf8"));
  if (seed.sourceId !== SOURCE_ID || seed.contentSha256 !== evidence.contentSha256
    || seed.contentSha256 !== sha256(JSON.stringify({ scope: seed.scope, edges: seed.edges }))) throw new Error("Gwangju topology inventory snapshot mismatch");
  const rawResponses = [];
  let snapshot;
  try {
    snapshot = await collectGwangjuRouteTopology({
      stationScope: seed.scope,
      fetchImpl,
      sleepImpl,
      now,
      onRawResponse: async (response) => { rawResponses.push(response); },
    });
  } catch (error) {
    if (rawResponses.length > 0) {
      const failed = {
        schemaVersion: 1,
        artifactKind: "gwangju-route-topology-failed-collection",
        status: "FAILED",
        sourceId: SOURCE_ID,
        capturedAt: validDate(now, "now").toISOString(),
        seedContentSha256: seed.contentSha256,
        scope: seed.scope,
        rawResponses,
      };
      await writeFile(failedOutputPath, `${JSON.stringify(failed)}\n`, { flag: "wx", mode: 0o600 });
    }
    throw error;
  }
  await writeFile(args[3], `${JSON.stringify(snapshot)}\n`, { flag: "wx", mode: 0o600 });
  console.log(`sanitized Gwangju route topology snapshot ready: edges=${snapshot.edgeCount}`);
  return snapshot;
}

async function requireAbsentOutput(file, label) {
  const existing = await lstat(file).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) throw Object.assign(new Error(`EEXIST: ${label} already exists`), { code: "EEXIST" });
}

async function main(args = process.argv.slice(2)) { return runGwangjuRouteTopologyCollector(args); }

function validateStationScope(value) {
  if (!Array.isArray(value) || value.length < 2) throw new Error("Gwangju route topology station scope mismatch");
  const ids = new Set(), codes = new Set();
  return value.map((row) => {
    const providerStationId = String(row?.providerStationId ?? "");
    const stationCode = String(row?.stationCode ?? "");
    const stationName = normalizedStationName(row?.stationName);
    if (providerStationId.trim() === "" || stationCode.trim() === "" || ids.has(providerStationId) || codes.has(stationCode)) {
      throw new Error("Gwangju route topology station scope mismatch");
    }
    ids.add(providerStationId); codes.add(stationCode);
    return { providerStationId, stationCode, stationName };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Gwangju route topology collection failed");
    process.exitCode = 1;
  }
}
