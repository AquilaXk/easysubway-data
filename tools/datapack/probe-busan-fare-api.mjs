#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  REQUIRED_FARE_FIELDS,
  validateOfficialOdFareEvidence,
} from "./lib/official-od-fare-evidence.mjs";

const FARE_TABLE_URL = "https://www2.humetro.busan.kr/homepage/chs/page/subLocation.do?menu_no=1001010501";
const ROUTE_URL = "https://www2.humetro.busan.kr/homepage/cyberstation/map.do";
const MAX_ATTEMPTS = 2;
const TARGETS = Object.freeze([
  { stationId: "station-fcb7a21e5606", lineId: "line-ab1a041f6266", stationName: "하단", fareStationCode: "102" },
  { stationId: "station-dd45c69d3e40", lineId: "line-ab1a041f6266", stationName: "당리", fareStationCode: "103" },
  { stationId: "station-1fc7a7c971c8", lineId: "line-ab1a041f6266", stationName: "서면", fareStationCode: "119" },
  { stationId: "station-6b611916f76a", lineId: "line-eb7b47920390", stationName: "장산", fareStationCode: "201" },
]);
const DIRECTIONS = Object.freeze([
  [TARGETS[0], TARGETS[1]],
  [TARGETS[0], TARGETS[3]],
  [TARGETS[2], TARGETS[3]],
]);

function sleep(milliseconds) {
  return milliseconds > 0 ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve();
}

function shouldRetryResponse(status, attempt) {
  return attempt < MAX_ATTEMPTS && (status === 429 || status >= 500);
}

function shouldRetryError(error, attempt) {
  return attempt < MAX_ATTEMPTS && !/ HTTP \d+$/.test(error instanceof Error ? error.message : "");
}

async function fetchTextWithRetry({ fetchImpl, input, init, label, retryDelayMs, timeoutMs }) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        if (shouldRetryResponse(response.status, attempt)) {
          await sleep(retryDelayMs);
          continue;
        }
        throw new Error(`${label} HTTP ${response.status}`);
      }
      return { attempts: attempt, text: await response.text() };
    } catch (error) {
      if (shouldRetryError(error, attempt)) {
        await sleep(retryDelayMs);
        continue;
      }
      throw error;
    }
  }
  throw new Error(`${label} retry exhausted`);
}

function plainText(value) {
  return value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

function fareNumber(value, label) {
  const text = plainText(value);
  if (text === "무료") return 0;
  const digits = text.replace(/[^0-9]/g, "");
  if (!digits) throw new Error(`${label} is missing from official fare table`);
  return Number.parseInt(digits, 10);
}

export function parseOfficialBusanFareTable(html) {
  const sections = new Map();
  for (const section of [1, 2]) {
    const row = html.match(new RegExp(`<tr[^>]*>[\\s\\S]*?<th[^>]*>\\s*${section}구간\\s*</th>([\\s\\S]*?)</tr>`, "i"));
    if (!row) throw new Error(`official fare table ${section} section is missing`);
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => match[1]);
    if (cells.length < 7) throw new Error(`official fare table ${section} section is incomplete`);
    sections.set(section, {
      childCardFare: fareNumber(cells[2], "child card fare"),
      childCashFare: fareNumber(cells[6], "child cash fare"),
      gnrlCardFare: fareNumber(cells[0], "adult card fare"),
      gnrlCashFare: fareNumber(cells[4], "adult cash fare"),
      yungCardFare: fareNumber(cells[1], "youth card fare"),
      yungCashFare: fareNumber(cells[5], "youth cash fare"),
    });
  }
  return sections;
}

function routeAdultFares(html) {
  const start = html.search(/class=["']result-2["']/i);
  const end = html.search(/class=["']result-3["']/i);
  if (start < 0 || end <= start) throw new Error("official route main fare result is missing");
  const main = html.slice(start, end);
  const card = main.match(/class=["']discountCard["'][^>]*>([\s\S]*?)<\/span>/i);
  const cash = main.match(/class=["']discountMoney["'][^>]*>([\s\S]*?)<\/span>/i);
  if (!card || !cash) throw new Error("official route main fare fields are missing");
  return {
    card: fareNumber(card[1], "route adult card fare"),
    cash: fareNumber(cash[1], "route adult cash fare"),
  };
}

function matchedFareSection(sections, routeFare) {
  const matches = [...sections.values()].filter((fares) =>
    fares.gnrlCardFare === routeFare.card && fares.gnrlCashFare === routeFare.cash);
  if (matches.length !== 1) throw new Error("official route fare does not match official fare table");
  return matches[0];
}

export async function probeOfficialBusanOdFares({
  outputPath,
  fetchImpl = fetch,
  retryDelayMs = 250,
  timeoutMs = 30_000,
} = {}) {
  let temporaryOutputPath;
  try {
    if (typeof outputPath !== "string" || !path.isAbsolute(outputPath)) {
      throw new Error("BUSAN_FARE_API_PROBE_OUTPUT must be an absolute path");
    }
    await rm(outputPath, { force: true });
    const tableResult = await fetchTextWithRetry({
      fetchImpl,
      input: FARE_TABLE_URL,
      label: "Busan official fare table",
      retryDelayMs,
      timeoutMs,
    });
    const sections = parseOfficialBusanFareTable(tableResult.text);
    const quotes = [];
    const attemptCounts = { officialFareTable: tableResult.attempts };
    for (const [origin, destination] of DIRECTIONS) {
      const body = new URLSearchParams({
        mo_scode_s: origin.fareStationCode,
        mo_scode_e: destination.fareStationCode,
        cyber_kinds: "1",
      });
      const routeResult = await fetchTextWithRetry({
        fetchImpl,
        input: ROUTE_URL,
        init: { method: "POST", body },
        label: "Busan official route fare",
        retryDelayMs,
        timeoutMs,
      });
      const key = `${origin.stationId}→${destination.stationId}`;
      attemptCounts[key] = routeResult.attempts;
      quotes.push({
        originStationId: origin.stationId,
        destinationStationId: destination.stationId,
        fares: matchedFareSection(sections, routeAdultFares(routeResult.text)),
      });
    }
    const evidence = {
      schemaVersion: 1,
      artifactKind: "official-od-fare-probe-evidence",
      mappingAvailability: "AVAILABLE",
      mappingField: "mo_scode_s/mo_scode_e",
      providerId: "busan-transportation-cyberstation",
      equivalence: {
        routeForm: { cyberKinds: "1", destinationField: "mo_scode_e", originField: "mo_scode_s", verified: true },
      },
      providerMappings: TARGETS.map((target) => ({ ...target })),
      quotes,
      fieldNames: [...REQUIRED_FARE_FIELDS].sort((left, right) => left < right ? -1 : 1),
      attemptCounts,
    };
    validateOfficialOdFareEvidence(evidence);
    temporaryOutputPath = `${outputPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryOutputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await chmod(temporaryOutputPath, 0o600);
    await rename(temporaryOutputPath, outputPath);
    temporaryOutputPath = undefined;
    return evidence;
  } catch (error) {
    if (temporaryOutputPath) await rm(temporaryOutputPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function main() {
  const evidence = await probeOfficialBusanOdFares({ outputPath: process.env.BUSAN_FARE_API_PROBE_OUTPUT });
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Busan fare probe failed"}\n`);
    process.exitCode = 1;
  });
}
