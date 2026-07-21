#!/usr/bin/env node
// 대구교통공사 1·2·3호선 공식 파일데이터(역 구간정보·열차시각표)를 결정론적 snapshot으로 수집한다.
// 원문은 공공데이터포털 CSV(파일별 EUC-KR/UTF-8 BOM 혼재)이며, 차량기지·비영업 행은 exact tuple로 격리한다.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FRESHNESS_MILLIS = 24 * 60 * 60 * 1_000;
const DAY_PREFIX = Object.freeze({ "평일": "WEEK", "토요일": "SAT", "휴일": "HOLI" });
const DAY_ORDER = Object.freeze(["WEEK", "SAT", "HOLI"]);
const DIRECTIONS = Object.freeze(["up", "dn"]);
// 시각표 역명 축약형 → 역 구간정보 정본 역명 별칭(정규화 전 비교용)
const STATION_NAME_ALIASES = Object.freeze({ "성서산업단지": "성서산단" });

export const DAEGU_LINES = Object.freeze([
  {
    lineNumber: 1,
    lineId: "line-5b8d9b05e7e6",
    lineName: "1호선",
    intervalDatasetId: "15061836",
    upDatasetId: "15065526",
    downDatasetId: "15138731",
    stationCount: 35,
    edgeCount: 68,
    tripCount: 824,
    stopTimeCount: 27_514,
  },
  {
    lineNumber: 2,
    lineId: "line-e2938a4cc492",
    lineName: "2호선",
    intervalDatasetId: "15061835",
    upDatasetId: "3033376",
    downDatasetId: "15138732",
    stationCount: 29,
    edgeCount: 56,
    tripCount: 828,
    stopTimeCount: 23_816,
  },
  {
    lineNumber: 3,
    lineId: "line-0ffaa95b1b5d",
    lineName: "3호선",
    intervalDatasetId: "15061797",
    upDatasetId: "15065532",
    downDatasetId: "15138734",
    stationCount: 30,
    edgeCount: 58,
    tripCount: 888,
    stopTimeCount: 26_640,
  },
]);

const INTERVAL = Object.freeze({
  code: 0, type: 1, name: 2, upKm: 6, downKm: 7, dwell: 8, upTime: 9, downTime: 10, turnback: 11,
});

export function decodeOfficialCsv(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new Error("official CSV bytes are required");
  }
  const buffer = Buffer.from(bytes);
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString("utf8");
  }
  const utf8 = buffer.toString("utf8");
  return utf8.includes("�") ? new TextDecoder("euc-kr").decode(buffer) : utf8;
}

function parseCsv(text) {
  const rows = text.split(/\r?\n/).filter((line) => line.length > 0).map((line) => line.split(","));
  // quoted-field 정식 파서 교체 전까지의 최소 가드: 행별 열 수가 헤더와 다르면 원문 결함으로 보고 fail-closed한다.
  const [header, ...body] = rows;
  if (header) {
    for (const [index, row] of body.entries()) {
      if (row.length !== header.length) {
        throw new Error(`CSV column count mismatch at row ${index + 2}: expected ${header.length}, got ${row.length}`);
      }
    }
  }
  return rows;
}

export function normalizedStationName(name) {
  let value = String(name).normalize("NFKC").replace(/\([^)]*\)/gu, "").replace(/[\s/.·]/gu, "");
  value = STATION_NAME_ALIASES[value] ?? value;
  return value.replace(/[0-9]+$/u, "").replace(/역$/u, "");
}

function clockSeconds(text) {
  const match = /^(\d{2}):(\d{2}):(\d{2})$/u.exec(text);
  if (!match) throw new Error(`invalid clock time: ${text}`);
  return Number(match[1]) * 3_600 + Number(match[2]) * 60 + Number(match[3]);
}

function timeSeconds(text) {
  const match = /^(\d{1,2}):(\d{2}):(\d{2})$/u.exec(text);
  if (!match) throw new Error(`invalid duration: ${text}`);
  return Number(match[1]) * 3_600 + Number(match[2]) * 60 + Number(match[3]);
}

function kilometersToMeters(value) {
  const meters = Math.round(Number(value) * 1_000);
  if (!Number.isInteger(meters) || meters <= 0) throw new Error(`invalid distance km: ${value}`);
  return meters;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validDate(now) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) throw new Error("capturedAt must be a valid date");
  return date;
}

// 역 구간정보 CSV → 노선 topology snapshot(정방향·역방향 인접 edge, 차량기지 격리)
export function parseDaeguRouteTopology(intervalBytes, { lineNumber, capturedAt }) {
  const config = DAEGU_LINES.find((line) => line.lineNumber === lineNumber);
  if (!config) throw new Error(`unknown Daegu line: ${lineNumber}`);
  const captured = validDate(capturedAt);
  const rows = parseCsv(decodeOfficialCsv(intervalBytes)).slice(1);
  const depots = [];
  const revenue = [];
  for (const row of rows) {
    if (row[INTERVAL.type] === "차량기지") {
      depots.push({ stationCode: row[INTERVAL.code], stationName: row[INTERVAL.name], stationType: row[INTERVAL.type] });
    } else {
      revenue.push(row);
    }
  }
  const scope = revenue.map((row, index) => ({
    stationCode: row[INTERVAL.code],
    stationName: row[INTERVAL.name],
    sequence: index + 1,
  }));
  if (scope.length !== config.stationCount) {
    throw new Error(`Daegu line ${lineNumber} revenue station count mismatch: ${scope.length}`);
  }
  const normSet = new Set(scope.map((station) => normalizedStationName(station.stationName)));
  const codeSet = new Set(scope.map((station) => station.stationCode));
  if (normSet.size !== scope.length || codeSet.size !== scope.length) {
    throw new Error(`Daegu line ${lineNumber} has duplicate station identity`);
  }
  const edges = [];
  for (let index = 0; index < revenue.length - 1; index += 1) {
    const from = revenue[index];
    const to = revenue[index + 1];
    const downDistance = kilometersToMeters(from[INTERVAL.downKm]);
    const downDuration = timeSeconds(from[INTERVAL.downTime]);
    const upDistance = kilometersToMeters(to[INTERVAL.upKm]);
    const upDuration = timeSeconds(to[INTERVAL.upTime]);
    if (downDistance !== upDistance) {
      throw new Error(`Daegu line ${lineNumber} distance asymmetry: ${from[INTERVAL.name]}-${to[INTERVAL.name]}`);
    }
    edges.push({
      fromStationCode: from[INTERVAL.code], toStationCode: to[INTERVAL.code],
      fromStationName: from[INTERVAL.name], toStationName: to[INTERVAL.name],
      direction: "dn", distanceMeters: downDistance, durationSeconds: downDuration,
    });
    edges.push({
      fromStationCode: to[INTERVAL.code], toStationCode: from[INTERVAL.code],
      fromStationName: to[INTERVAL.name], toStationName: from[INTERVAL.name],
      direction: "up", distanceMeters: upDistance, durationSeconds: upDuration,
    });
  }
  if (edges.length !== config.edgeCount) {
    throw new Error(`Daegu line ${lineNumber} edge count mismatch: ${edges.length}`);
  }
  const scopeSha256 = sha256(JSON.stringify(scope));
  const edgesSha256 = sha256(JSON.stringify(edges));
  const rawSha256 = sha256(Buffer.from(intervalBytes));
  const snapshot = {
    schemaVersion: 1,
    artifactKind: "daegu-route-topology-snapshot",
    sourceId: `daegu-line${lineNumber}-route-topology`,
    official: true,
    fixture: false,
    endpoint: `https://www.data.go.kr/data/${config.intervalDatasetId}/fileData.do`,
    datasetId: config.intervalDatasetId,
    lineId: config.lineId,
    capturedAt: captured.toISOString(),
    freshUntil: new Date(captured.getTime() + FRESHNESS_MILLIS).toISOString(),
    credentialRequired: false,
    credentialRedacted: true,
    stationCount: scope.length,
    edgeCount: edges.length,
    depotExcludedCount: depots.length,
    scope,
    edges,
    quarantinedDepots: depots,
    scopeSha256,
    edgesSha256,
    rawSha256,
    contentSha256: sha256(JSON.stringify({ scope, edges })),
  };
  return snapshot;
}

function buildTimetableTrips(bytes, direction, lineNumber, seqByNorm) {
  const rows = parseCsv(decodeOfficialCsv(bytes));
  const header = rows[0];
  // 헤더 뒷부분의 padding 빈 열은 제외하고, 실제 열차번호가 있는 열만 원본 열 인덱스와 함께 취한다.
  const trainColumns = header.slice(3)
    .map((value, offset) => ({ label: value.trim(), column: offset + 3 }))
    .filter((entry) => entry.label.length > 0);
  if (new Set(trainColumns.map((entry) => entry.label)).size !== trainColumns.length) {
    throw new Error(`Daegu line ${lineNumber} ${direction} train column identity invalid`);
  }
  const body = rows.slice(1).filter((row) => row[0] && row[0].trim().length > 0);
  // 방향은 파일(up/dn)이 정본이다. 라벨 괄호가 파일 방향과 다르면 원문 결함으로 보고 파일 방향으로 정규화한다.
  let dayLabelNormalizedCount = 0;
  for (const row of body) {
    const parenthetical = /\((상|하)\)/u.exec(row[0])?.[1];
    if ((direction === "up" && parenthetical === "하") || (direction === "dn" && parenthetical === "상")) {
      dayLabelNormalizedCount += 1;
    }
  }
  const trips = [];
  let rolloverTripCount = 0;
  for (const day of DAY_ORDER) {
    const dayRows = body.filter((row) => DAY_PREFIX[row[0].replace(/\(.*\)/u, "").trim()] === day);
    for (const { label: trainNo, column } of trainColumns) {
      const timesByNorm = new Map();
      for (const row of dayRows) {
        const cell = (row[column] ?? "").trim();
        if (cell.length === 0) continue;
        const normName = normalizedStationName(row[1]);
        if (!seqByNorm.has(normName)) throw new Error(`Daegu line ${lineNumber} unknown station: ${row[1]}`);
        if (!timesByNorm.has(normName)) timesByNorm.set(normName, []);
        timesByNorm.get(normName).push(clockSeconds(cell));
      }
      if (timesByNorm.size === 0) continue;
      const stops = [...timesByNorm.entries()].map(([normName, values]) => ({
        norm: normName,
        seq: seqByNorm.get(normName).seq,
        stationCode: seqByNorm.get(normName).stationCode,
        arrival: Math.min(...values),
        departure: Math.max(...values),
      })).sort((left, right) => (direction === "up" ? right.seq - left.seq : left.seq - right.seq));
      for (let index = 1; index < stops.length; index += 1) {
        if (Math.abs(stops[index].seq - stops[index - 1].seq) !== 1) {
          throw new Error(`Daegu line ${lineNumber} ${direction} non-contiguous trip: ${trainNo}`);
        }
      }
      let previous = -1;
      let rolled = false;
      const stopTimes = [];
      for (const stop of stops) {
        let arrival = stop.arrival;
        while (arrival < previous) { arrival += 86_400; rolled = true; }
        previous = arrival;
        let departure = stop.departure;
        while (departure < previous) { departure += 86_400; rolled = true; }
        previous = departure;
        stopTimes.push({ c: stop.stationCode, a: arrival, d: departure });
      }
      if (rolled) rolloverTripCount += 1;
      trips.push({
        id: `trip-daegu-${lineNumber}-${direction}-${day.toLowerCase()}-${trainNo}`,
        dayCode: day,
        direction,
        trainNo,
        stops: stopTimes,
      });
    }
  }
  return { trips, dayLabelNormalizedCount, rolloverTripCount, bodyRowCount: body.length, rawSha256: sha256(Buffer.from(bytes)) };
}

// 상선·하선 열차시각표 CSV → 노선 시각표 snapshot(열차별 trip·stop time)
export function parseDaeguTrainTimetable(upBytes, downBytes, topologySnapshot, { lineNumber, capturedAt }) {
  const config = DAEGU_LINES.find((line) => line.lineNumber === lineNumber);
  if (!config) throw new Error(`unknown Daegu line: ${lineNumber}`);
  const captured = validDate(capturedAt);
  const seqByNorm = new Map(topologySnapshot.scope.map((station) => [
    normalizedStationName(station.stationName),
    { seq: station.sequence, stationCode: station.stationCode },
  ]));
  const up = buildTimetableTrips(upBytes, "up", lineNumber, seqByNorm);
  const down = buildTimetableTrips(downBytes, "dn", lineNumber, seqByNorm);
  const trips = [...up.trips, ...down.trips].sort((left, right) => left.id.localeCompare(right.id, "en"));
  if (new Set(trips.map((trip) => trip.id)).size !== trips.length) {
    throw new Error(`Daegu line ${lineNumber} duplicate trip id`);
  }
  const stopTimeCount = trips.reduce((total, trip) => total + trip.stops.length, 0);
  if (trips.length !== config.tripCount || stopTimeCount !== config.stopTimeCount) {
    throw new Error(`Daegu line ${lineNumber} timetable counts mismatch: trips=${trips.length} stopTimes=${stopTimeCount}`);
  }
  const tripsSha256 = sha256(JSON.stringify(trips));
  const snapshot = {
    schemaVersion: 1,
    artifactKind: "daegu-train-timetable-snapshot",
    sourceId: `daegu-line${lineNumber}-train-timetable`,
    official: true,
    fixture: false,
    endpointUp: `https://www.data.go.kr/data/${config.upDatasetId}/fileData.do`,
    endpointDown: `https://www.data.go.kr/data/${config.downDatasetId}/fileData.do`,
    upDatasetId: config.upDatasetId,
    downDatasetId: config.downDatasetId,
    lineId: config.lineId,
    capturedAt: captured.toISOString(),
    freshUntil: new Date(captured.getTime() + FRESHNESS_MILLIS).toISOString(),
    credentialRequired: false,
    credentialRedacted: true,
    stationCount: config.stationCount,
    tripCount: trips.length,
    stopTimeCount,
    rowCount: up.bodyRowCount + down.bodyRowCount,
    dayCodes: DAY_ORDER,
    directions: DIRECTIONS,
    stationNameAliases: STATION_NAME_ALIASES,
    dayLabelNormalizedCount: up.dayLabelNormalizedCount + down.dayLabelNormalizedCount,
    rolloverTripCount: up.rolloverTripCount + down.rolloverTripCount,
    trips,
    tripsSha256,
    rawUpSha256: up.rawSha256,
    rawDownSha256: down.rawSha256,
    rawSha256: sha256(Buffer.concat([Buffer.from(upBytes), Buffer.from(downBytes)])),
    contentSha256: sha256(JSON.stringify({ tripsSha256, stopTimeCount, stationCount: config.stationCount })),
  };
  return snapshot;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--")) throw new Error("usage: collect-daegu-datapack-sources.mjs --input-dir <dir> --output-dir <dir> --captured-at <iso>");
    args[argv[index].slice(2)] = argv[index + 1];
  }
  if (!args["input-dir"] || !args["output-dir"] || !args["captured-at"] || !path.isAbsolute(args["output-dir"])) {
    throw new Error("usage: collect-daegu-datapack-sources.mjs --input-dir <dir> --output-dir <dir> --captured-at <iso>");
  }
  return args;
}

export async function runDaeguSourceCollector(argv) {
  const args = parseArgs(argv);
  const stamp = args["date-stamp"] ?? "20260721";
  const outputs = [];
  for (const config of DAEGU_LINES) {
    const [intervalBytes, upBytes, downBytes] = await Promise.all([
      readFile(path.join(args["input-dir"], `data-go-${config.intervalDatasetId}.csv`)),
      readFile(path.join(args["input-dir"], `data-go-${config.upDatasetId}.csv`)),
      readFile(path.join(args["input-dir"], `data-go-${config.downDatasetId}.csv`)),
    ]);
    const topology = parseDaeguRouteTopology(intervalBytes, { lineNumber: config.lineNumber, capturedAt: args["captured-at"] });
    const timetable = parseDaeguTrainTimetable(upBytes, downBytes, topology, { lineNumber: config.lineNumber, capturedAt: args["captured-at"] });
    const topologyPath = path.join(args["output-dir"], `daegu-line${config.lineNumber}-route-topology-${stamp}.json`);
    const timetablePath = path.join(args["output-dir"], `daegu-line${config.lineNumber}-train-timetable-${stamp}.json`);
    await writeFile(topologyPath, `${JSON.stringify(topology)}\n`);
    await writeFile(timetablePath, `${JSON.stringify(timetable)}\n`);
    outputs.push(topologyPath, timetablePath);
    console.log(`Daegu line ${config.lineNumber}: ${topology.stationCount} stations, ${topology.edgeCount} edges, ${timetable.tripCount} trips, ${timetable.stopTimeCount} stop times`);
  }
  return outputs;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runDaeguSourceCollector(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Daegu source collection failed");
    process.exitCode = 1;
  }
}
