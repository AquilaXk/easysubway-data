#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { validateKricAccessibilityProviderGapEvidence } from "./collect-kric-accessibility-snapshots.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";

const STATIONS = Object.freeze([
  { stinCd: "2805", stationName: "구리", key: "7231" },
  { stinCd: "2807", stationName: "동구릉", key: "7232" },
  { stinCd: "2808", stationName: "장자호수공원", key: "7196" },
]);
const URLS = new Set(STATIONS.map(({ key }) => `https://www.guri.go.kr/www/contents.do?key=${key}`));
const OPERATOR_NAME = "구리도시공사 교통사업부";

export function validateGuriStationUrl(url) {
  if (!(url instanceof URL) || !URLS.has(url.href) || url.username || url.password || url.hash) {
    throw new Error("official Guri station URL is invalid");
  }
}

export async function collectGuriStationFacilityEvidence({
  gapEvidence,
  routeRosters,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  validateKricAccessibilityProviderGapEvidence(gapEvidence);
  const gaps = new Map(gapEvidence.gaps
    .filter(({ railOprIsttCd }) => railOprIsttCd === "GU")
    .map((gap) => [providerTuple(gap), gap]));
  if (gaps.size !== STATIONS.length) throw new Error("official Guri gap set is invalid");
  const rosterStations = (routeRosters?.rosters ?? []).flatMap(({ stations = [] }) => stations);
  const capturedAt = now.toISOString();
  if (!Number.isFinite(Date.parse(capturedAt))) throw new Error("capture time is invalid");

  const records = [];
  for (const station of STATIONS) {
    const tuple = `GU/8/${station.stinCd}`;
    if (!gaps.has(tuple)) throw new Error(`official Guri gap is missing: ${tuple}`);
    const rosterMatches = rosterStations.filter((row) => providerTuple(row) === tuple && row.stinNm === station.stationName);
    if (rosterMatches.length !== 1) throw new Error(`official Guri KRIC station identity is invalid: ${tuple}`);

    const officialUrl = `https://www.guri.go.kr/www/contents.do?key=${station.key}`;
    const url = new URL(officialUrl);
    validateGuriStationUrl(url);
    let response;
    try {
      response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new Error(`official Guri station request failed: ${tuple}`);
    }
    if (!response?.ok) throw new Error(`official Guri station HTTP status is invalid: ${tuple}`);
    const rawBytes = new Uint8Array(await response.arrayBuffer());
    const html = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
    const { elevatorCount, escalatorCount } = parseStationPage(html, station.stationName);
    records.push({
      providerTuple: tuple,
      stationName: station.stationName,
      operatorName: OPERATOR_NAME,
      elevatorCount,
      escalatorCount,
      officialUrl,
      rawSha256: createHash("sha256").update(rawBytes).digest("hex"),
      providerRecordHash: hash(rosterMatches[0]),
    });
  }

  return {
    schemaVersion: 1,
    artifactKind: "guri-station-facility-evidence",
    sourceId: "guri-city-official-station-pages",
    capturedAt,
    official: true,
    credentialRequired: false,
    credentialRedacted: true,
    absenceEvidenceMode: "EXACT_STATION_PAGE",
    rowCount: records.length,
    contentSha256: hash(records),
    schemaFingerprint: hash([
      "providerTuple", "stationName", "operatorName", "elevatorCount", "escalatorCount",
      "officialUrl", "rawSha256", "providerRecordHash",
    ]),
    records,
  };
}

function parseStationPage(html, stationName) {
  const escapedName = stationName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`<h3[^>]*>\\s*${escapedName}역\\s*</h3>`).test(html)) {
    throw new Error(`official Guri station page is invalid: ${stationName}`);
  }
  const text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&nbsp;", " ")
    .replace(/\s+/g, " ");
  const facility = /승강기 안내\s*엘리베이터\s*(\d+)대,\s*에스컬레이터\s*(\d+)대/.exec(text);
  if (!facility || !/운영기관\s*구리도시공사 교통사업부/.test(text)) {
    throw new Error(`official Guri station page is invalid: ${stationName}`);
  }
  const elevatorCount = Number(facility[1]);
  const escalatorCount = Number(facility[2]);
  if (!Number.isSafeInteger(elevatorCount) || elevatorCount < 1
    || !Number.isSafeInteger(escalatorCount) || escalatorCount < 0) {
    throw new Error(`official Guri station facility count is invalid: ${stationName}`);
  }
  return { elevatorCount, escalatorCount };
}

function providerTuple(value) {
  return [value?.railOprIsttCd, value?.lnCd, value?.stinCd].join("/");
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseArgs(argv) {
  if (argv.length !== 6) {
    throw new Error("usage: collect-guri-station-facility-evidence.mjs --gaps <json> --route-rosters <json> --output <absolute.json>");
  }
  const args = Object.fromEntries(Array.from({ length: 3 }, (_, index) => [
    argv[index * 2]?.replace(/^--/, ""), argv[index * 2 + 1],
  ]));
  if (!args.gaps || !args["route-rosters"] || !path.isAbsolute(args.output ?? "")) {
    throw new Error("official Guri station arguments are invalid");
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  const [gapEvidence, routeRosters] = await Promise.all([
    readFile(args.gaps, "utf8").then(JSON.parse),
    readFile(args["route-rosters"], "utf8").then(JSON.parse),
  ]);
  const snapshot = await collectGuriStationFacilityEvidence({ gapEvidence, routeRosters });
  await writeFile(args.output, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o644 });
  process.stdout.write(`official Guri station evidence ready: rows=${snapshot.rowCount}\n`);
}

if (isMainModule(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "official Guri station collection failed"}\n`);
    process.exitCode = 1;
  }
}
