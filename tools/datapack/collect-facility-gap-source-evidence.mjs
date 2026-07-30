#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { validateKricAccessibilityProviderGapEvidence } from "./collect-kric-accessibility-snapshots.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";

const KRIC_ELEVATOR_COLUMNS = ["철도운영기관명", "선명", "역명", "출입구번호", "상세위치", "정원_인원", "정원_중량"];

const SOURCES = Object.freeze({
  "korail-station-facilities": {
    datasetId: "15090379",
    detailUrl: "https://www.data.go.kr/data/15090379/fileData.do",
    operatorCode: "KR",
    operatorNames: ["코레일", "한국철도공사"],
    operatorIdentityMode: "SOURCE_LEVEL",
    lineNames: {},
    columns: ["역명", "엘리베이터", "에스컬레이터", "휠체어리프트", "장애인경사로"],
    normalize(row) {
      return {
        stationName: required(row["역명"], "역명"),
        elevator: required(row["엘리베이터"], "엘리베이터"),
        escalator: required(row["에스컬레이터"], "에스컬레이터"),
        wheelchairLift: required(row["휠체어리프트"], "휠체어리프트"),
        accessibleRamp: required(row["장애인경사로"], "장애인경사로"),
      };
    },
  },
  "kric-capital-line8-elevators": {
    datasetId: "15041396",
    detailUrl: "https://www.data.go.kr/data/15041396/fileData.do",
    operatorCode: "GU",
    operatorNames: ["구리도시공사"],
    lineNames: { "8": "8호선" },
    columns: KRIC_ELEVATOR_COLUMNS,
    normalize: normalizeKricElevatorRow,
  },
  "kric-capital-line1-elevators": {
    datasetId: "15041389",
    detailUrl: "https://www.data.go.kr/data/15041389/fileData.do",
    operatorCode: "KR",
    operatorNames: ["코레일", "한국철도공사"],
    lineNames: { "1": "1호선" },
    columns: KRIC_ELEVATOR_COLUMNS,
    normalize: normalizeKricElevatorRow,
  },
});

export function resolveOfficialDownloadUrl(html) {
  const match = /"contentUrl"\s*:\s*"([^"]+)"/.exec(html);
  if (!match) throw new Error("official data.go.kr contentUrl is missing");
  const url = new URL(match[1].replaceAll(String.raw`\u0026`, "&"));
  if (url.origin !== "https://www.data.go.kr"
    || url.pathname !== "/cmm/cmm/fileDownload.do"
    || !/^FILE_[0-9A-Z]+$/.test(url.searchParams.get("atchFileId") ?? "")
    || url.searchParams.get("fileDetailSn") !== "1") {
    throw new Error("official data.go.kr download URL is invalid");
  }
  return url;
}

export function decodeCsv(bytes) {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("euc-kr", { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""), encoding: "euc-kr" };
  }
}

export async function collectFacilityGapSourceEvidence({
  sourceId,
  gapEvidence,
  routeRosters,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  const source = SOURCES[sourceId];
  if (!source) throw new Error(`facility gap source is not allowed: ${sourceId}`);
  validateKricAccessibilityProviderGapEvidence(gapEvidence);
  const gapStations = mapGapStations(gapEvidence.gaps, routeRosters, source.operatorCode);
  const evaluatedGaps = gapStations.filter((gap) => Object.hasOwn(source.lineNames, gap.lnCd));
  const outOfScopeGaps = gapStations.filter((gap) => !Object.hasOwn(source.lineNames, gap.lnCd));

  const detailResponse = await fetchOfficial(new URL(source.detailUrl), fetchImpl, "detail page");
  const detailHtml = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(await detailResponse.arrayBuffer()));
  if (!/이용허락범위[\s\S]{0,200}제한 없음/.test(detailHtml)) {
    throw new Error(`official source license is invalid: ${sourceId}`);
  }
  const downloadUrl = resolveOfficialDownloadUrl(detailHtml);
  const csvResponse = await fetchOfficial(downloadUrl, fetchImpl, "CSV");
  const rawBytes = new Uint8Array(await csvResponse.arrayBuffer());
  const { text, encoding } = decodeCsv(rawBytes);
  const { columns, records } = parseCsv(text);
  if (source.columns.some((column) => !columns.includes(column))) {
    throw new Error(`official source columns are invalid: ${sourceId}`);
  }
  const rows = records
    .filter((row) => source.include?.(row) ?? true)
    .map((row) => source.normalize(row))
    .sort((left, right) => compare(JSON.stringify(left), JSON.stringify(right)));
  if (rows.length === 0) throw new Error(`official source rows are empty: ${sourceId}`);

  const matchedGaps = [];
  const unmatchedGaps = [];
  for (const gap of evaluatedGaps) {
    const matches = rows.filter((row) => matchesGap(source, gap, row));
    if (matches.length === 0) {
      unmatchedGaps.push(gap);
      continue;
    }
    matchedGaps.push({
      ...gap,
      rowCount: matches.length,
      providerRecordHash: hash(matches),
      providerRecords: matches,
    });
  }
  const capturedAt = now.toISOString();
  return {
    schemaVersion: 1,
    artifactKind: "facility-gap-source-evidence",
    sourceId,
    datasetId: source.datasetId,
    detailUrl: source.detailUrl,
    downloadUrl: downloadUrl.href,
    capturedAt,
    official: true,
    credentialRequired: false,
    credentialRedacted: true,
    absenceEvidenceMode: "EXHAUSTIVE_LIST",
    responseEncoding: encoding,
    rawSha256: createHash("sha256").update(rawBytes).digest("hex"),
    contentSha256: hash(rows),
    schemaFingerprint: hash([...columns].sort(compare)),
    rowCount: rows.length,
    matchedGaps,
    unmatchedGaps,
    outOfScopeGaps,
    license: {
      type: "PUBLIC_DATA_FREE_USE",
      redistributionAllowed: true,
      evidenceUrl: source.detailUrl,
    },
  };
}

export function bindSeoulFacilityGapEvidence({ gapEvidence, routeRosters, sourceSnapshot } = {}) {
  validateKricAccessibilityProviderGapEvidence(gapEvidence);
  if (sourceSnapshot?.schemaVersion !== 1
    || sourceSnapshot?.artifactKind !== "seoul-facility-location-snapshot"
    || sourceSnapshot?.sourceId !== "seoul-metro-facility-location"
    || sourceSnapshot?.credentialRedacted !== true
    || sourceSnapshot?.absenceEvidenceMode !== "EXHAUSTIVE_LIST"
    || !Array.isArray(sourceSnapshot?.stations)
    || !Number.isSafeInteger(sourceSnapshot.rowCount) || sourceSnapshot.rowCount < 1
    || !Number.isSafeInteger(sourceSnapshot.normalizedRowCount) || sourceSnapshot.normalizedRowCount < 1
    || !/^[0-9a-f]{64}$/.test(sourceSnapshot.rawSha256 ?? "")
    || sourceSnapshot.contentSha256 !== hash(sourceSnapshot.stations)
    || !/^[0-9a-f]{64}$/.test(sourceSnapshot.schemaFingerprint ?? "")
    || !Number.isFinite(Date.parse(sourceSnapshot.capturedAt))) {
    throw new Error("Seoul facility-location source snapshot is invalid");
  }
  const gapStations = mapGapStations(gapEvidence.gaps, routeRosters, "S1");
  const evaluatedGaps = gapStations.filter(({ lnCd }) => lnCd === "2");
  const outOfScopeGaps = gapStations.filter(({ lnCd }) => lnCd !== "2");
  const matchedGaps = [];
  const unmatchedGaps = [];
  for (const gap of evaluatedGaps) {
    const matches = sourceSnapshot.stations.filter((station) => (
      station.providerStationCode === gap.stinCd
      && station.lineName === `${gap.lnCd}호선`
      && normalizeStationName(station.stationName) === normalizeStationName(gap.stationName)
    ));
    if (matches.length > 1) throw new Error(`Seoul facility-location canonical station identity is ambiguous: ${providerTuple(gap)}`);
    if (matches.length === 0) {
      unmatchedGaps.push(gap);
      continue;
    }
    const [providerRecord] = matches;
    if (!Array.isArray(providerRecord.facilities) || providerRecord.facilities.length === 0) {
      throw new Error(`Seoul facility-location facility rows are empty: ${providerTuple(gap)}`);
    }
    matchedGaps.push({ ...gap, rowCount: 1, providerRecordHash: hash(providerRecord), providerRecords: [providerRecord] });
  }
  return {
    schemaVersion: 1,
    artifactKind: "facility-gap-source-evidence",
    sourceId: sourceSnapshot.sourceId,
    sourceUrl: "https://apis.data.go.kr/B553766/facility/getFcElvtr",
    sourceSnapshotId: sourceSnapshot.snapshotId,
    capturedAt: sourceSnapshot.capturedAt,
    official: true,
    credentialRequired: true,
    credentialRedacted: true,
    absenceEvidenceMode: sourceSnapshot.absenceEvidenceMode,
    rowCount: sourceSnapshot.rowCount,
    normalizedRowCount: sourceSnapshot.normalizedRowCount,
    rawSha256: sourceSnapshot.rawSha256,
    contentSha256: sourceSnapshot.contentSha256,
    schemaFingerprint: sourceSnapshot.schemaFingerprint,
    matchedGaps,
    unmatchedGaps,
    outOfScopeGaps,
  };
}

export function formatGapClassification(snapshot) {
  if (snapshot?.artifactKind !== "facility-gap-source-evidence"
    || !Array.isArray(snapshot?.matchedGaps) || !Array.isArray(snapshot?.unmatchedGaps)
    || !Array.isArray(snapshot?.outOfScopeGaps)) {
    throw new Error("facility gap source evidence report is invalid");
  }
  const format = (gap) => `${gap.railOprIsttCd}/${gap.lnCd}/${gap.stinCd}/${gap.stationName}`;
  return [
    `source=${snapshot.sourceId}`,
    `matched=${snapshot.matchedGaps.map(format).join(",") || "none"}`,
    `unmatched=${snapshot.unmatchedGaps.map(format).join(",") || "none"}`,
    `outOfScope=${snapshot.outOfScopeGaps.map(format).join(",") || "none"}`,
  ].join("\n");
}

async function fetchOfficial(url, fetchImpl, label) {
  let response;
  try {
    response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new Error(`official data.go.kr ${label} request failed`);
  }
  if (!response?.ok) throw new Error(`official data.go.kr ${label} HTTP status is invalid`);
  return response;
}

function mapGapStations(gaps, routeRosters, operatorCode) {
  if (!Array.isArray(routeRosters?.rosters)) throw new Error("KRIC route rosters are required");
  const stationNames = new Map();
  for (const roster of routeRosters.rosters) {
    for (const station of roster.stations ?? []) {
      const key = providerTuple(station);
      const names = stationNames.get(key) ?? new Set();
      names.add(required(station.stinNm, `KRIC route station ${key}`));
      stationNames.set(key, names);
    }
  }
  return gaps.filter(({ railOprIsttCd }) => railOprIsttCd === operatorCode).map((gap) => {
    const key = providerTuple(gap);
    const names = [...(stationNames.get(key) ?? [])];
    if (names.length !== 1) throw new Error(`KRIC gap route station identity is invalid: ${key}`);
    return { ...gap, stationName: names[0] };
  });
}

function parseCsv(text) {
  const table = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (quoted || field === "") {
        quoted = !quoted;
      } else {
        field += character;
      }
      continue;
    }
    if (quoted) {
      field += character;
      continue;
    }
    if (character === ",") {
      row.push(field.trim());
      field = "";
    } else if (character === "\n") {
      appendCsvRow(table, row, field);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }
  appendCsvRow(table, row, field);
  return csvTableToRecords(table, quoted);
}

function csvTableToRecords(table, quoted) {
  if (quoted || table.length < 2) throw new Error("official source CSV is invalid");
  const [columns, ...data] = table;
  if (new Set(columns).size !== columns.length) throw new Error("official source CSV columns are duplicated");
  return {
    columns,
    records: data.map((values) => {
      if (values.length !== columns.length) throw new Error("official source CSV row width is invalid");
      return Object.fromEntries(columns.map((column, index) => [column, values[index]]));
    }),
  };
}

function appendCsvRow(table, row, field) {
  row.push(field.trim());
  if (row.some((value) => value !== "")) table.push(row);
}

function normalizeStationName(value) {
  return String(value).normalize("NFKC").trim().toLocaleLowerCase("ko-KR");
}

function matchesGap(source, gap, row) {
  const operatorMatches = source.operatorIdentityMode === "SOURCE_LEVEL"
    || source.operatorNames.includes(row.operatorName);
  return operatorMatches
    && source.lineNames[gap.lnCd] === row.lineName
    && normalizeStationName(gap.stationName) === normalizeStationName(row.stationName);
}

function providerTuple(value) {
  return [value.railOprIsttCd, value.lnCd, value.stinCd].map((field) => required(field, "provider tuple")).join("/");
}

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value.trim();
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function compare(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function parseArgs(argv) {
  if (argv.length === 2 && argv[0] === "--report" && path.isAbsolute(argv[1])) {
    return { report: argv[1] };
  }
  if (argv.length !== 8) throw new Error("usage: collect-facility-gap-source-evidence.mjs (--source <id>|--seoul-snapshot <json>) --gaps <json> --route-rosters <json> --output <absolute.json>");
  const args = Object.fromEntries(Array.from({ length: 4 }, (_, index) => [argv[index * 2]?.replace(/^--/, ""), argv[index * 2 + 1]]));
  if ((!args.source && !args["seoul-snapshot"]) || (args.source && args["seoul-snapshot"])
    || !args.gaps || !args["route-rosters"] || !path.isAbsolute(args.output ?? "")) {
    throw new Error("facility gap source arguments are invalid");
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.report) {
    process.stdout.write(`${formatGapClassification(JSON.parse(await readFile(args.report, "utf8")))}\n`);
    return;
  }
  const [gapEvidenceJson, routeRostersJson, seoulSnapshotJson] = await Promise.all([
    readFile(args.gaps, "utf8"),
    readFile(args["route-rosters"], "utf8"),
    args["seoul-snapshot"] ? readFile(args["seoul-snapshot"], "utf8") : null,
  ]);
  const gapEvidence = JSON.parse(gapEvidenceJson);
  const routeRosters = JSON.parse(routeRostersJson);
  const snapshot = seoulSnapshotJson
    ? bindSeoulFacilityGapEvidence({ gapEvidence, routeRosters, sourceSnapshot: JSON.parse(seoulSnapshotJson) })
    : await collectFacilityGapSourceEvidence({ sourceId: args.source, gapEvidence, routeRosters });
  await writeFile(args.output, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o644 });
  process.stdout.write(`official facility gap source evidence ready: source=${snapshot.sourceId} rows=${snapshot.rowCount} matched=${snapshot.matchedGaps.length} unmatched=${snapshot.unmatchedGaps.length}\n`);
}

if (isMainModule(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "facility gap source collection failed"}\n`);
    process.exitCode = 1;
  }
}

function normalizeKricElevatorRow(row) {
  return {
    operatorName: row["철도운영기관명"],
    lineName: row["선명"],
    stationName: required(row["역명"], "역명"),
    exitNumber: row["출입구번호"],
    detailLocation: required(row["상세위치"], "상세위치"),
    capacityPeople: row["정원_인원"],
    capacityWeight: row["정원_중량"],
  };
}
