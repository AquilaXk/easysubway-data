#!/usr/bin/env node
// 인천교통공사 1·2호선 공식 열차시각표 FILE CSV 8종을 결정론적 snapshot으로 수집한다.
// API key·포털 활용신청 없이 data.go.kr 파일데이터만 사용한다.
//
// Day model: 토요일 전용 FILE이 없어 WEEK(평일)·HOLI(휴일)만 admit한다.
// 토요일 시각을 발명하지 않으며, materializer calendar는 대전/광주와 같이
// HOLI service에 saturday=true를 매핑한다(토요일=휴일 시각표 재사용).
//
// 빈 시각 칸은 해당 열차가 정차하지 않음(단기·미정차)으로 해석하고 시간을 발명하지 않는다.
// 7호선 FILE/행은 범위 밖이다.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { decodeOfficialCsv } from "./collect-daegu-datapack-sources.mjs";
import { validateIncheonStationInfoSnapshot } from "./collect-incheon-station-info.mjs";

const TOPOLOGY_SOURCE_ID = "incheon-transit-station-info";
const TOPOLOGY_SNAPSHOT_ID = "incheon-transit-station-info-20260724";
const TOPOLOGY_CONTENT_SHA256 = "710878689282ba967697cd9411940b657a51eee5499106ed884d5bd9111501a8";
const ARTIFACT_KIND = "incheon-train-timetable-snapshot";
const FRESHNESS_MILLIS = 24 * 60 * 60 * 1_000;
const DAY_CODES = Object.freeze(["WEEK", "HOLI"]);
const DIRECTIONS = Object.freeze(["up", "dn"]);
const LINE1 = "line-98718184f016";
const LINE2 = "line-42b5805f3b5a";
const FIELDS_PROVIDED = Object.freeze(["service_calendar", "trip", "stop_time"]);

// 시각표 축약 역명 → topology 정본 역명(정규화 후 별칭).
const STATION_NAME_ALIASES = Object.freeze({
  문학: "문학경기장",
  주안국가: "주안국가산단",
  서부여성: "서부여성회관",
  석바위: "석바위시장",
  가정중앙: "가정중앙시장",
  아시아드: "아시아드경기장",
});

export const INCHEON_TIMETABLE_LINES = Object.freeze([
  {
    lineNumber: 1,
    lineId: LINE1,
    sourceId: "incheon-line1-train-timetable",
    stationCount: 33,
    tripCount: 574,
    stopTimeCount: 18_392,
    rolloverTripCount: 25,
    // 종착역 라벨만 한 역 앞서고 해당 역 시각이 비어 있는 FILE 결함(시간 발명 금지).
    destinationLabelNormalizedCount: 35,
    observedDataUpdatedAt: "2025-04-12",
    identityColumn: "열차번호",
    datasets: Object.freeze({
      WEEK: Object.freeze({ up: "15051203", dn: "15051204" }),
      HOLI: Object.freeze({ up: "15051205", dn: "15051206" }),
    }),
  },
  {
    lineNumber: 2,
    lineId: LINE2,
    sourceId: "incheon-line2-train-timetable",
    stationCount: 27,
    tripCount: 840,
    stopTimeCount: 22_506,
    rolloverTripCount: 23,
    destinationLabelNormalizedCount: 0,
    observedDataUpdatedAt: "2025-06-30",
    identityColumn: "순번",
    datasets: Object.freeze({
      WEEK: Object.freeze({ up: "15051210", dn: "15051208" }),
      HOLI: Object.freeze({ up: "15051209", dn: "15051207" }),
    }),
  },
]);

export function normalizedIncheonTimetableStationName(name) {
  let value = String(name).normalize("NFKC").trim();
  value = value.replace(/\s+/gu, "").replace(/\([^()]*\)/gu, "");
  if (value.endsWith("역")) value = value.slice(0, -1);
  return STATION_NAME_ALIASES[value] ?? value;
}

export function parseIncheonTrainTimetable(files, topologySnapshot, {
  lineNumber,
  capturedAt,
} = {}) {
  const config = INCHEON_TIMETABLE_LINES.find((line) => line.lineNumber === lineNumber);
  if (!config) throw new Error(`unknown Incheon timetable line: ${lineNumber}`);
  const captured = validDate(capturedAt);
  const scope = validateTopologyForLine(topologySnapshot, config);
  const seqByNorm = new Map(scope.map((station) => [
    normalizedIncheonTimetableStationName(station.stationName),
    station,
  ]));
  if (seqByNorm.size !== config.stationCount) {
    throw new Error(`Incheon line ${lineNumber} topology normalization collided`);
  }

  const trips = [];
  const rawHashes = {};
  let rowCount = 0;
  let rolloverTripCount = 0;
  let destinationLabelNormalizedCount = 0;
  for (const dayCode of DAY_CODES) {
    for (const direction of DIRECTIONS) {
      const datasetId = config.datasets[dayCode][direction];
      const bytes = files[`${dayCode}:${direction}`];
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
        throw new Error(`Incheon line ${lineNumber} ${dayCode} ${direction} CSV bytes are required`);
      }
      rawHashes[`${dayCode}:${direction}`] = sha256(Buffer.from(bytes));
      const parsed = parseTimetableFile(bytes, {
        config,
        dayCode,
        direction,
        datasetId,
        seqByNorm,
      });
      rowCount += parsed.rowCount;
      rolloverTripCount += parsed.rolloverTripCount;
      destinationLabelNormalizedCount += parsed.destinationLabelNormalizedCount;
      trips.push(...parsed.trips);
    }
  }

  trips.sort((left, right) => left.id.localeCompare(right.id, "en"));
  if (new Set(trips.map((trip) => trip.id)).size !== trips.length) {
    throw new Error(`Incheon line ${lineNumber} duplicate trip id`);
  }
  const stopTimeCount = trips.reduce((total, trip) => total + trip.stops.length, 0);
  if (trips.length !== config.tripCount || stopTimeCount !== config.stopTimeCount
    || rolloverTripCount !== config.rolloverTripCount
    || destinationLabelNormalizedCount !== config.destinationLabelNormalizedCount) {
    throw new Error(
      `Incheon line ${lineNumber} timetable counts mismatch: `
      + `trips=${trips.length} stopTimes=${stopTimeCount} rollover=${rolloverTripCount} `
      + `destinationLabelNormalized=${destinationLabelNormalizedCount}`,
    );
  }

  const tripsSha256 = sha256(JSON.stringify(trips));
  const rawParts = DAY_CODES.flatMap((dayCode) => DIRECTIONS.map((direction) => files[`${dayCode}:${direction}`]));
  const rawSha256 = sha256(Buffer.concat(rawParts.map((bytes) => Buffer.from(bytes))));
  const datasetIds = DAY_CODES.flatMap((dayCode) => DIRECTIONS.map((direction) => config.datasets[dayCode][direction]));
  return {
    schemaVersion: 1,
    artifactKind: ARTIFACT_KIND,
    sourceId: config.sourceId,
    official: true,
    fixture: false,
    credentialRequired: false,
    credentialRedacted: true,
    lineId: config.lineId,
    lineNumber: config.lineNumber,
    detailUrl: `https://www.data.go.kr/data/${config.datasets.WEEK.up}/fileData.do`,
    datasetIds,
    datasets: {
      WEEK: { ...config.datasets.WEEK },
      HOLI: { ...config.datasets.HOLI },
    },
    observedDataUpdatedAt: config.observedDataUpdatedAt,
    capturedAt: captured.toISOString(),
    freshUntil: new Date(captured.getTime() + FRESHNESS_MILLIS).toISOString(),
    stationCount: config.stationCount,
    tripCount: trips.length,
    stopTimeCount,
    rowCount,
    dayCodes: [...DAY_CODES],
    directions: [...DIRECTIONS],
    // 토요일 전용 FILE 없음 → WEEK/HOLI only. Saturday times are not invented.
    dayModel: "WEEK_HOLI_NO_SATURDAY_FILE",
    stationNameAliases: { ...STATION_NAME_ALIASES },
    rolloverTripCount,
    destinationLabelNormalizedCount,
    fieldsProvided: [...FIELDS_PROVIDED],
    license: {
      type: "PUBLIC_DATA_FREE_USE",
      attribution: "인천교통공사, 공공데이터포털 이용허락범위 제한 없음",
      redistributionAllowed: true,
      evidenceUrl: `https://www.data.go.kr/data/${config.datasets.WEEK.up}/fileData.do`,
    },
    topologySourceId: TOPOLOGY_SOURCE_ID,
    topologySnapshotId: TOPOLOGY_SNAPSHOT_ID,
    topologyContentSha256: TOPOLOGY_CONTENT_SHA256,
    topologyLineages: [{
      sourceId: TOPOLOGY_SOURCE_ID,
      snapshotId: TOPOLOGY_SNAPSHOT_ID,
      contentSha256: TOPOLOGY_CONTENT_SHA256,
      lineId: config.lineId,
    }],
    trips,
    tripsSha256,
    rowsSha256: tripsSha256,
    rawWeekdayUpSha256: rawHashes["WEEK:up"],
    rawWeekdayDownSha256: rawHashes["WEEK:dn"],
    rawHolidayUpSha256: rawHashes["HOLI:up"],
    rawHolidayDownSha256: rawHashes["HOLI:dn"],
    rawUpSha256: sha256(Buffer.concat([
      Buffer.from(files["WEEK:up"]), Buffer.from(files["HOLI:up"]),
    ])),
    rawDownSha256: sha256(Buffer.concat([
      Buffer.from(files["WEEK:dn"]), Buffer.from(files["HOLI:dn"]),
    ])),
    rawSha256,
    contentSha256: sha256(JSON.stringify({
      tripsSha256,
      stopTimeCount,
      stationCount: config.stationCount,
    })),
  };
}

export function collectIncheonTimetableLine({
  files,
  topologySnapshot,
  lineNumber,
  now = new Date(),
}) {
  return parseIncheonTrainTimetable(files, topologySnapshot, {
    lineNumber,
    capturedAt: now,
  });
}

function parseTimetableFile(bytes, {
  config,
  dayCode,
  direction,
  datasetId,
  seqByNorm,
}) {
  const rows = parseCsv(decodeOfficialCsv(bytes));
  if (rows.length < 2) throw new Error(`Incheon ${datasetId} CSV empty`);
  const header = rows[0].map((cell) => String(cell ?? "").trim());
  if (header[0] !== "시발역" || header[1] !== "종착역" || header[2] !== config.identityColumn) {
    throw new Error(`Incheon ${datasetId} CSV header mismatch`);
  }
  const stationHeaders = header.slice(3);
  if (stationHeaders.length !== config.stationCount
    || stationHeaders.some((name) => name.length === 0)
    || new Set(stationHeaders.map(normalizedIncheonTimetableStationName)).size !== config.stationCount) {
    throw new Error(`Incheon ${datasetId} station columns invalid`);
  }
  const stations = stationHeaders.map((name) => {
    const station = seqByNorm.get(normalizedIncheonTimetableStationName(name));
    if (!station) throw new Error(`Incheon ${datasetId} unknown station: ${name}`);
    return station;
  });
  // 공식 FILE 열 순서가 해당 방향의 운행 순서다(up: 종점←시종점 방향, dn: 반대).
  const expectedSign = direction === "up" ? -1 : 1;
  const headerSign = Math.sign(
    stations.at(-1).lineSequence - stations[0].lineSequence,
  );
  if (headerSign !== expectedSign) {
    throw new Error(`Incheon ${datasetId} column order does not match ${direction}`);
  }

  const body = rows.slice(1).filter((row) => String(row[0] ?? "").trim().length > 0);
  const trips = [];
  let rolloverTripCount = 0;
  let destinationLabelNormalizedCount = 0;
  const trainNos = new Set();
  for (const [rowIndex, row] of body.entries()) {
    if (row.length !== header.length) {
      throw new Error(`Incheon ${datasetId} column count mismatch at row ${rowIndex + 2}`);
    }
    const trainNo = String(row[2] ?? "").trim();
    if (!trainNo || trainNos.has(trainNo)) {
      throw new Error(`Incheon ${datasetId} train identity invalid: ${trainNo || "(empty)"}`);
    }
    trainNos.add(trainNo);
    const originName = normalizedIncheonTimetableStationName(row[0]);
    const destinationLabel = normalizedIncheonTimetableStationName(row[1]);
    const labeledDestination = seqByNorm.get(destinationLabel);
    if (!labeledDestination) {
      throw new Error(`Incheon ${datasetId} unknown destination: ${row[1]}`);
    }
    const collected = [];
    for (let index = 0; index < stations.length; index += 1) {
      const cell = String(row[index + 3] ?? "").trim();
      if (cell.length === 0) continue; // 미정차·구간 외 — 시간 발명 금지
      collected.push({
        station: stations[index],
        seconds: clockSeconds(cell),
      });
    }
    if (collected.length < 2) {
      throw new Error(`Incheon ${datasetId} trip ${trainNo} has fewer than 2 stops`);
    }
    let previous = -1;
    let rolled = false;
    const stops = [];
    for (const entry of collected) {
      let arrival = entry.seconds;
      while (arrival < previous) {
        arrival += 86_400;
        rolled = true;
      }
      previous = arrival;
      stops.push({
        c: entry.station.stationCode,
        a: arrival,
        d: arrival,
      });
    }
    for (let index = 1; index < collected.length; index += 1) {
      if (Math.abs(collected[index].station.lineSequence - collected[index - 1].station.lineSequence) !== 1) {
        throw new Error(`Incheon ${datasetId} non-contiguous trip: ${trainNo}`);
      }
      if (Math.sign(
        collected[index].station.lineSequence - collected[index - 1].station.lineSequence,
      ) !== expectedSign) {
        throw new Error(`Incheon ${datasetId} direction mismatch in trip: ${trainNo}`);
      }
    }
    const firstNorm = normalizedIncheonTimetableStationName(collected[0].station.stationName);
    const lastStation = collected.at(-1).station;
    const lastNorm = normalizedIncheonTimetableStationName(lastStation.stationName);
    if (firstNorm !== originName) {
      throw new Error(
        `Incheon ${datasetId} origin mismatch for ${trainNo}: `
        + `${row[0]} vs ${collected[0].station.stationName}`,
      );
    }
    // 종착역 라벨이 마지막 시각 역의 다음 역을 가리키고 그 시각이 비어 있는 FILE 결함.
    // 빈 칸에 시각을 발명하지 않고 마지막 timed stop을 종점으로 쓴다.
    if (lastNorm !== destinationLabel) {
      const sequenceDelta = labeledDestination.lineSequence - lastStation.lineSequence;
      if (sequenceDelta !== expectedSign) {
        throw new Error(
          `Incheon ${datasetId} destination label not adjacent for ${trainNo}: `
          + `${row[1]} vs last timed ${lastStation.stationName}`,
        );
      }
      destinationLabelNormalizedCount += 1;
    }
    if (rolled) rolloverTripCount += 1;
    trips.push({
      id: `trip-incheon-${config.lineNumber}-${direction}-${dayCode.toLowerCase()}-${trainNo}`,
      dayCode,
      direction,
      trainNo,
      originStationCode: collected[0].station.stationCode,
      destinationStationCode: lastStation.stationCode,
      destinationName: lastStation.stationName,
      destinationLabel: labeledDestination.stationName,
      stops,
    });
  }
  return { trips, rowCount: body.length, rolloverTripCount, destinationLabelNormalizedCount };
}

function validateTopologyForLine(topologySnapshot, config) {
  validateIncheonStationInfoSnapshot(topologySnapshot);
  if (topologySnapshot.sourceId !== TOPOLOGY_SOURCE_ID
    || topologySnapshot.snapshotId !== TOPOLOGY_SNAPSHOT_ID
    || topologySnapshot.contentSha256 !== TOPOLOGY_CONTENT_SHA256) {
    throw new Error("invalid Incheon topology snapshot");
  }
  const scope = topologySnapshot.scope.filter((station) => station.lineId === config.lineId)
    .sort((left, right) => left.lineSequence - right.lineSequence);
  if (scope.length !== config.stationCount) {
    throw new Error(`Incheon line ${config.lineNumber} topology station count mismatch`);
  }
  return scope;
}

function parseCsv(text) {
  const rows = text.split(/\r?\n/).filter((line) => line.length > 0).map((line) => line.split(","));
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

function clockSeconds(text) {
  const match = /^(\d{1,2}):(\d{2}):(\d{2})$/u.exec(text);
  if (!match) throw new Error(`invalid clock time: ${text}`);
  return Number(match[1]) * 3_600 + Number(match[2]) * 60 + Number(match[3]);
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!(date instanceof Date) || Number.isNaN(date.getTime()) || date.toISOString() !== new Date(date).toISOString()) {
    throw new Error("capturedAt must be a valid Date/ISO timestamp");
  }
  return date;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--")) {
      throw new Error(
        "usage: collect-incheon-timetable.mjs --input-dir <dir> --topology-snapshot <json> "
        + "--output-dir <abs-dir> --captured-at <iso> [--date-stamp YYYYMMDD] [--line 1|2]",
      );
    }
    args[argv[index].slice(2)] = argv[index + 1];
  }
  if (!args["input-dir"] || !args["topology-snapshot"] || !args["output-dir"] || !args["captured-at"]
    || !path.isAbsolute(args["output-dir"])) {
    throw new Error(
      "usage: collect-incheon-timetable.mjs --input-dir <dir> --topology-snapshot <json> "
      + "--output-dir <abs-dir> --captured-at <iso> [--date-stamp YYYYMMDD] [--line 1|2]",
    );
  }
  return args;
}

export async function runIncheonTimetableCollector(argv) {
  const args = parseArgs(argv);
  const stamp = args["date-stamp"] ?? "20260724";
  const topologyPath = args["topology-snapshot"];
  const topologySnapshotId = path.basename(topologyPath, ".json");
  if (topologySnapshotId !== TOPOLOGY_SNAPSHOT_ID) {
    throw new Error(`Incheon topology snapshot path must be ${TOPOLOGY_SNAPSHOT_ID}.json`);
  }
  const topologySnapshot = {
    ...JSON.parse(await readFile(topologyPath, "utf8")),
    snapshotId: topologySnapshotId,
  };
  const lines = args.line
    ? INCHEON_TIMETABLE_LINES.filter((line) => String(line.lineNumber) === String(args.line))
    : INCHEON_TIMETABLE_LINES;
  if (lines.length === 0) throw new Error(`unknown --line ${args.line}`);

  const outputs = [];
  for (const config of lines) {
    const files = {};
    for (const dayCode of DAY_CODES) {
      for (const direction of DIRECTIONS) {
        const datasetId = config.datasets[dayCode][direction];
        files[`${dayCode}:${direction}`] = await readFile(
          path.join(args["input-dir"], `data-go-${datasetId}.csv`),
        );
      }
    }
    const snapshot = collectIncheonTimetableLine({
      files,
      topologySnapshot,
      lineNumber: config.lineNumber,
      now: new Date(args["captured-at"]),
    });
    const outputPath = path.join(args["output-dir"], `${config.sourceId}-${stamp}.json`);
    await writeFile(outputPath, `${JSON.stringify(snapshot)}\n`);
    outputs.push(outputPath);
    console.log(
      `Incheon line ${config.lineNumber}: ${snapshot.tripCount} trips, `
      + `${snapshot.stopTimeCount} stop times, rollover=${snapshot.rolloverTripCount}`,
    );
  }
  return outputs;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runIncheonTimetableCollector(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Incheon timetable collection failed");
    process.exitCode = 1;
  }
}
