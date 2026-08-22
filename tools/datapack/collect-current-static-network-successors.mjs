import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import { buildLegacySampleToFullConsumedFieldsMigration } from "./lib/seoulmetro-line-data-parser.mjs";

export const MOLIT_URL = "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003561913&fileDetailSn=1&insertDataPrcus=N";
export const SEOUL_ROOT_URL = "https://www.seoulmetro.co.kr/kr/cyberStation.do";
export const SEOUL_ASSET_URL = "https://www.seoulmetro.co.kr/kr/getLineData.do";
const CSV_HEADER = ["권역", "권역명", "철도운영기관명", "노선명", "순번", "역명"];
const sha = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code) => { throw new Error(`STATIC_NETWORK_SUCCESSOR_${code}`); };

export async function collectCurrentStaticNetworkSuccessors({ fetchImpl = fetch, sourceSnapshots, baselineRouteMapBytes, observedAt }) {
  if (!Array.isArray(sourceSnapshots) || !Buffer.isBuffer(baselineRouteMapBytes)
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
  const molitRecords = projectMolit(molit, molitHead);
  const migration = buildLegacySampleToFullConsumedFieldsMigration({
    legacyHead: routeMapHead, baselineRawBytes: baselineRouteMapBytes, freshRawBytes: seoul,
    snapshotId: `seoulmetro-cyberstation-route-map-current-${observedAt.replaceAll(/[-:.]/gu, "").replace("Z", "Z")}`,
  });
  return {
    observedAt,
    molit: { sourceId: molitHead.sourceId, rawBytes: molit, rawSha256: sha(molit), records: molitRecords, previous: molitHead },
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

function projectMolit(bytes, previous) {
  let text;
  try { text = new TextDecoder("euc-kr", { fatal: true }).decode(bytes); } catch { fail("MOLIT_ENCODING"); }
  const rows = parseCsv(text);
  if (rows.length < 2 || JSON.stringify(rows[0]) !== JSON.stringify(CSV_HEADER)
    || rows.slice(1).some((row) => row.length !== 6)) fail("MOLIT_SCHEMA");
  const matches = new Map(previous.providerRecordHashes.map((hash) => [hash, []]));
  for (const cells of rows.slice(1)) {
    const values = cells.map((value) => value.trim());
    if (values.some((value) => value === "") || !/^[1-9][0-9]*$/u.test(values[4])) fail("MOLIT_SCHEMA");
    const record = { line_name: values[3], operator_name: values[2], region: values[1], station_name: values[5], station_sequence: values[4] };
    matches.get(sha(JSON.stringify(record)))?.push(record);
  }
  const selected = previous.providerRecordHashes.map((hash) => matches.get(hash));
  if (selected.some((entries) => entries?.length !== 1)) fail("MATERIAL_CHANGE");
  return selected.map(([record]) => record);
}

function parseCsv(value) {
  const rows = []; let row = []; let cell = ""; let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"') { if (quoted && value[index + 1] === '"') { cell += char; index += 1; } else quoted = !quoted; }
    else if (char === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) { if (char === "\r" && value[index + 1] === "\n") index += 1; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += char;
  }
  if (quoted) fail("MOLIT_SCHEMA");
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((row) => row.some((cell) => cell !== ""));
}
