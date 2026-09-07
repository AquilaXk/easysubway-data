import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { unzipEntry, parseWorkbookSheetRefs, parseSharedStrings, parseWorksheetRows } from "./parse-kric-code-catalog.mjs";
import { selectRetainedKricStationLine } from "./build-kric-retained-file-pending-handoff.mjs";

/** 같은 노선의 기존 ID만 연결한다. 공식 번호와 카탈로그 순번을 같은 코드로 취급하지 않는다. */
export function bindKorailCanonicalStations({ stations, stationLines, lineId, orders }) {
  const fail = () => { throw new Error("canonical passenger station binding mismatch"); };
  const nameKey = (name) => typeof name === "string" ? name.normalize("NFKC").trim().replace(/역$/u, "") : "";
  if (!Array.isArray(stations) || !Array.isArray(stationLines) || !Array.isArray(orders)
    || orders.length === 0 || typeof lineId !== "string" || !lineId) fail();
  const members = stationLines.filter((row) => row.lineId === lineId).sort((a, b) => a.lineSequence - b.lineSequence);
  if (members.length < 2 || new Set(members.map((row) => row.stationId)).size !== members.length
    || new Set(members.map((row) => row.lineSequence)).size !== members.length) fail();
  const byName = new Map();
  for (const row of members) {
    if (!Number.isSafeInteger(row.lineSequence) || row.lineSequence < 1) fail();
    const matches = stations.filter(({ id }) => id === row.stationId);
    if (matches.length !== 1) fail();
    const key = nameKey(matches[0].nameKo);
    if (!key || byName.has(key)) fail();
    byName.set(key, row.stationId);
  }
  const expected = members.map(({ stationId }) => stationId);
  let binding;
  for (const order of orders) {
    if (!Array.isArray(order.stations) || order.stations.length !== members.length) fail();
    const mapped = order.stations.map((row) => ({ ...row, stationId: byName.get(nameKey(row.stationName)) }));
    const ids = mapped.map(({ stationId }) => stationId);
    if (ids.some((id) => !id) || new Set(ids).size !== members.length
      || mapped.some(({ stationNumber }) => typeof stationNumber !== "string" || !stationNumber)
      || new Set(mapped.map(({ stationNumber }) => stationNumber)).size !== members.length) fail();
    if (JSON.stringify(ids) !== JSON.stringify(expected)
      && JSON.stringify(ids) !== JSON.stringify([...expected].reverse())) fail();
    const ordered = expected.map((id) => mapped.find(({ stationId }) => stationId === id));
    if (binding && JSON.stringify(binding) !== JSON.stringify(ordered)) fail();
    binding = ordered;
  }
  return binding;
}

/**
 * 보관한 원시 시간표와 이미 검증된 membership을 결합한 pending 관측이다. admission이나 정규화 ID는 만들지 않는다.
 */
export async function buildRetainedKorailTopologyObservation({
  inputPath,
  sha256,
  stationLineObservation,
  stationLineReceipt,
  operatorName,
  lineName,
  canonicalCatalogPath,
  canonicalCatalogSha256,
  lineId,
}) {
  // 시간표를 열기 전에 membership의 receipt·행 결속과 선택 범위를 먼저 확정한다.
  const membership = selectRetainedKricStationLine({
    observation: stationLineObservation,
    receipt: stationLineReceipt,
    operatorName,
    lineName,
  });
  if (typeof canonicalCatalogPath !== "string" || !path.isAbsolute(canonicalCatalogPath)
    || !/^[a-f0-9]{64}$/.test(canonicalCatalogSha256 ?? "")) throw new Error("canonical catalog identity required");
  const catalogBytes = await readFile(canonicalCatalogPath);
  if (createHash("sha256").update(catalogBytes).digest("hex") !== canonicalCatalogSha256) {
    throw new Error("canonical catalog digest mismatch");
  }
  const catalog = JSON.parse(catalogBytes);
  const packs = catalog.packs?.filter((pack) => pack.stationLines?.some((row) => row.lineId === lineId));
  if (!packs || packs.length !== 1) throw new Error("canonical catalog line selection mismatch");
  const timetable = await parseRetainedKorailWorkbook({ inputPath, sha256 });
  const topology = projectKorailPassengerTopology({ sheets: timetable.sheets, membership: membership.records });
  const stationBindings = bindKorailCanonicalStations({
    stations: packs[0].stations, stationLines: packs[0].stationLines, lineId, orders: topology.orders,
  });
  const stationIds = new Map(stationBindings.map(({ stationNumber, stationId }) => [stationNumber, stationId]));
  for (const trip of topology.passengerTrips) {
    for (const stop of trip.stops) stop.stationId = stationIds.get(stop.stationNumber);
  }
  return {
    schemaVersion: 1,
    artifactKind: "korail-metropolitan-topology-observation",
    status: "PENDING",
    releaseEligible: false,
    sourceId: "korail-metropolitan-timetable-file",
    sources: {
      timetable: {
        sourceId: "korail-metropolitan-timetable-file",
        rawSha256: timetable.rawSha256,
        rawByteLength: timetable.rawByteLength,
      },
      membership: membership.summary,
      catalog: { rawSha256: canonicalCatalogSha256, rawByteLength: catalogBytes.length },
    },
    selection: { operatorName, lineName, lineId },
    stationBindings,
    topology,
  };
}

/** 해시를 확인한 같은 바이트만 읽는다. 원본 경로의 변경과 파싱 사이의 경쟁을 차단한다. */
export async function parseRetainedKorailWorkbook({ inputPath, sha256 }) {
  if (!path.isAbsolute(inputPath) || !/^[a-f0-9]{64}$/.test(sha256 ?? "")) {
    throw new Error("retained workbook identity is required");
  }
  const bytes = await readFile(inputPath);
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("retained workbook digest mismatch");
  const root = await mkdtemp(path.join(tmpdir(), "korail-retained-"));
  try {
    const snapshot = path.join(root, "source.xlsx");
    await writeFile(snapshot, bytes, { flag: "wx", mode: 0o400 });
    const refs = parseWorkbookSheetRefs(await unzipEntry(snapshot, "xl/workbook.xml"),
      await unzipEntry(snapshot, "xl/_rels/workbook.xml.rels"));
    if (new Set(refs.map(({ name }) => name)).size !== refs.length) throw new Error("duplicate timetable sheet");
    const strings = parseSharedStrings(await unzipEntry(snapshot, "xl/sharedStrings.xml", true));
    const sheets = [];
    for (const { name, entry } of refs) {
      const xml = await unzipEntry(snapshot, entry);
      const cells = parseWorksheetRows(xml, strings);
      // 배열 위치가 아니라 원문 row r을 사용해야 빈 행이 생략되어도 셀 근거가 유지된다.
      const nativeRows = [...xml.matchAll(/<row\b([^>]*)>[\s\S]*?<\/row>/gi)];
      const rows = nativeRows.map((match, index) => ({
        rowNumber: Number(/\br\s*=\s*["']([1-9]\d*)["']/.exec(match[1])?.[1]),
        cells: cells[index],
      }));
      sheets.push(parseKorailMetropolitanSheet({ name, rows }));
    }
    return { rawSha256: sha256, rawByteLength: bytes.length, sheets };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const SECONDS_PER_DAY = 24 * 60 * 60;
const SERIAL_ROUNDING_TOLERANCE = Number.EPSILON * SECONDS_PER_DAY * 8;

/** 승객용 membership만 선택한다. 원문 시간 관측을 평균·최솟값으로 바꾸거나 admission하지 않는다. */
export function projectKorailPassengerTopology({ sheets, membership }) {
  if (!Array.isArray(sheets) || sheets.length === 0 || !Array.isArray(membership) || membership.length < 2) {
    throw new Error("parsed sheets and passenger membership are required");
  }
  const byName = new Map();
  const numbers = new Set();
  for (const row of membership) {
    if (typeof row.stationName !== "string" || !row.stationName.trim()
      || typeof row.stationNumber !== "string" || !row.stationNumber.trim()
      || !/^[a-f0-9]{64}$/.test(row.sourceRowSha256 ?? "")
      || byName.has(row.stationName) || numbers.has(row.stationNumber)) {
      throw new Error("passenger membership is ambiguous");
    }
    byName.set(row.stationName, row);
    numbers.add(row.stationNumber);
  }
  const orders = new Map();
  const edges = new Map();
  const passengerTrips = [];
  for (const sheet of sheets) {
    if (!Array.isArray(sheet.trains) || sheet.trains.length === 0) throw new Error("sheet trains are required");
    for (const train of sheet.trains) {
      const stops = train.stops.filter(({ stationName }) => byName.has(stationName));
      const names = stops.map(({ stationName }) => stationName);
      if (names.length !== byName.size || new Set(names).size !== byName.size) {
        throw new Error("timetable passenger membership is incomplete");
      }
      const stations = names.map((name) => byName.get(name));
      const previous = orders.get(sheet.directionLabel);
      if (previous && JSON.stringify(previous.stations) !== JSON.stringify(stations)) {
        throw new Error("same-direction passenger order is inconsistent");
      }
      orders.set(sheet.directionLabel, { directionLabel: sheet.directionLabel, stations });
      const originIndex = names.indexOf(train.origin);
      const destinationIndex = names.indexOf(train.destination);
      if (originIndex < 0 || destinationIndex <= originIndex) throw new Error("passenger train endpoints are invalid");
      // 일부 구간 운행은 실제 시발·종착 사이만 보존한다. 종점의 빈 시각을 합성하지 않는다.
      passengerTrips.push({
        sheetName: sheet.sheetName, dayLabel: sheet.dayLabel, directionLabel: sheet.directionLabel,
        trainNo: train.trainNo,
        originStationNumber: stations[originIndex].stationNumber,
        destinationStationNumber: stations[destinationIndex].stationNumber,
        stops: stops.slice(originIndex, destinationIndex + 1).map((stop, index) => ({
          stationNumber: stations[originIndex + index].stationNumber,
          arrival: { ...stop.arrival }, departure: { ...stop.departure },
        })),
      });
      for (let index = 0; index + 1 < stops.length; index += 1) {
        const fromStationNumber = stations[index].stationNumber;
        const toStationNumber = stations[index + 1].stationNumber;
        const key = JSON.stringify([fromStationNumber, toStationNumber]);
        if (!edges.has(key)) edges.set(key, { fromStationNumber, toStationNumber, observations: [] });
        if (index < originIndex || index >= destinationIndex) continue;
        const departure = stops[index].departure;
        const arrival = stops[index + 1].arrival;
        if (!Number.isSafeInteger(departure.seconds) || !Number.isSafeInteger(arrival.seconds)
          || arrival.seconds <= departure.seconds) throw new Error("passenger segment time is missing or invalid");
        edges.get(key).observations.push({
          sheetName: sheet.sheetName, trainNo: train.trainNo,
          durationSeconds: arrival.seconds - departure.seconds,
          departure: { ...departure }, arrival: { ...arrival },
        });
      }
    }
  }
  if ([...edges.values()].some(({ observations }) => observations.length === 0)) {
    throw new Error("passenger segment has no observed duration");
  }
  return { orders: [...orders.values()], edges: [...edges.values()], passengerTrips };
}

/** 공식 시각표의 한 열차 열을 원문 순서대로 해석하며 날짜·freshness는 생성하지 않는다. */
export function normalizeKorailTrainClockCells(cells) {
  if (!Array.isArray(cells) || cells.length === 0) throw new Error("train clock cells are required");
  const seen = new Set();
  let previous = 0;
  let dayOffset = 0;
  return cells.map(({ cellId, rawValue }) => {
    if (typeof cellId !== "string" || !/^[A-Z]+[1-9]\d*$/.test(cellId) || seen.has(cellId)
      || typeof rawValue !== "string") throw new Error("train clock cell evidence is invalid");
    seen.add(cellId);
    const text = rawValue.trim();
    if (text === "") return { cellId, rawValue, seconds: null };
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
      throw new Error(`invalid train clock at ${cellId}`);
    }
    const serial = Number(text);
    const scaled = serial * SECONDS_PER_DAY;
    const clockSeconds = Math.round(scaled);
    // Excel 소수의 이진 표현 오차만 허용한다. 실제 초 미만 시각을 반올림하지 않는다.
    if (!Number.isFinite(serial) || serial < 0 || serial >= 1
      || clockSeconds >= SECONDS_PER_DAY
      || Math.abs(scaled - clockSeconds) > SERIAL_ROUNDING_TOLERANCE) {
      throw new Error(`unsupported train clock precision at ${cellId}`);
    }
    if (clockSeconds + dayOffset < previous) dayOffset += SECONDS_PER_DAY;
    const seconds = clockSeconds + dayOffset;
    if (!Number.isSafeInteger(seconds)) throw new Error("train clock range is invalid");
    previous = seconds;
    return { cellId, rawValue, seconds };
  });
}

/**
 * 보존한 광역전철 시트의 원시 행만 해석한다. XLSX 입출력과 날짜 의미 부여는 호출자가 담당한다.
 */
export function parseKorailMetropolitanSheet({ name, rows }) {
  const sheet = parseSheetName(name);
  const nativeRows = requireNativeRows(rows);
  const headers = findHeaders(nativeRows);
  const trainRow = headers.get("열차번호");
  const trainColumns = trainColumnsFrom(trainRow);
  const stationPairs = stationPairsAfter(nativeRows, trainRow);

  const origins = headers.get("시발역");
  const destinations = headers.get("종착역");
  const trains = trainColumns.map(({ index, column, trainNo }) => {
    const origin = namedEndpoint(origins, index, "origin");
    const destination = namedEndpoint(destinations, index, "destination");
    const rawClockCells = stationPairs.flatMap(({ arrival, departure }) => [
      { cellId: `${column}${arrival.rowNumber}`, rawValue: cellAt(arrival, index) },
      { cellId: `${column}${departure.rowNumber}`, rawValue: cellAt(departure, index) },
    ]);
    const clocks = normalizeKorailTrainClockCells(rawClockCells);
    const stops = stationPairs.map(({ stationName }, stopIndex) => ({
      stationName,
      arrival: clocks[stopIndex * 2],
      departure: clocks[stopIndex * 2 + 1],
    }));
    const timedStops = stops.filter(({ arrival, departure }) => arrival.seconds !== null || departure.seconds !== null);
    if (timedStops.length === 0 || timedStops[0].stationName !== origin
      || timedStops.at(-1).stationName !== destination) {
      throw new Error(`train ${trainNo} endpoints do not match timed stops`);
    }
    return { trainNo, origin, destination, column, stops };
  });
  return { sheetName: name, ...sheet, trains };
}

function parseSheetName(name) {
  if (typeof name !== "string") throw new Error("sheet name is required");
  const match = /^(평일|휴일)_(상|하)$/.exec(name);
  if (!match) throw new Error("unsupported metropolitan sheet name");
  return { dayLabel: match[1], directionLabel: match[2] };
}

function requireNativeRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("sheet rows are required");
  let previousRowNumber = 0;
  return rows.map((row) => {
    if (row === null || typeof row !== "object" || !Number.isSafeInteger(row.rowNumber)
      || row.rowNumber < 1 || row.rowNumber <= previousRowNumber || !Array.isArray(row.cells)
      || row.cells.some((cell) => typeof cell !== "string")) {
      throw new Error("native sheet row evidence is invalid");
    }
    previousRowNumber = row.rowNumber;
    return row;
  });
}

function findHeaders(rows) {
  const headers = new Map();
  for (const row of rows) {
    const label = cellAt(row, 0).trim();
    if (!new Set(["시발역", "종착역", "열차번호"]).has(label)) continue;
    if (headers.has(label)) throw new Error(`duplicate ${label} header`);
    headers.set(label, row);
  }
  if (headers.size !== 3) throw new Error("metropolitan sheet headers are incomplete");
  return headers;
}

function trainColumnsFrom(trainRow) {
  let lastTrainColumn = 0;
  for (let index = 1; index < trainRow.cells.length; index += 1) {
    if (cellAt(trainRow, index).trim() !== "") lastTrainColumn = index;
  }
  if (lastTrainColumn === 0) throw new Error("train identifiers are required");
  const seen = new Set();
  return Array.from({ length: lastTrainColumn }, (_, offset) => {
    const index = offset + 1;
    const trainNo = cellAt(trainRow, index).trim();
    if (trainNo === "" || seen.has(trainNo)) throw new Error("train identifiers are invalid");
    seen.add(trainNo);
    return { index, column: columnName(index), trainNo };
  });
}

function stationPairsAfter(rows, trainRow) {
  const trainIndex = rows.indexOf(trainRow);
  const dataRows = rows.slice(trainIndex + 1);
  const pairs = [];
  for (let index = 0; index < dataRows.length;) {
    const arrival = dataRows[index];
    if (isBlankRow(arrival)) {
      if (dataRows.slice(index).some((row) => !isBlankRow(row))) {
        throw new Error("blank rows may only trail station pairs");
      }
      break;
    }
    const stationName = cellAt(arrival, 0).trim();
    const departure = dataRows[index + 1];
    if (stationName === "" || departure === undefined || departure.rowNumber !== arrival.rowNumber + 1
      || cellAt(departure, 0).trim() !== "") {
      throw new Error("station arrival and departure rows must be consecutive native pairs");
    }
    pairs.push({ stationName, arrival, departure });
    index += 2;
  }
  if (pairs.length === 0) throw new Error("station pairs are required");
  return pairs;
}

function namedEndpoint(row, index, label) {
  const endpoint = cellAt(row, index).trim();
  if (endpoint === "") throw new Error(`train ${label} is required`);
  return endpoint;
}

function cellAt(row, index) {
  return row.cells[index] ?? "";
}

function isBlankRow(row) {
  return row.cells.every((cell) => cell.trim() === "");
}

function columnName(index) {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    name = String.fromCharCode(65 + (value - 1) % 26) + name;
  }
  return name;
}
