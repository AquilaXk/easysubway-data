import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  normalizeKorailTrainClockCells,
  parseKorailMetropolitanSheet,
  projectKorailPassengerTopology,
  bindKorailCanonicalStations,
  korailServiceDayLabel,
  buildKorailServiceCalendars,
  buildKorailTimetableTables,
  parseRetainedKorailWorkbook,
  buildRetainedKorailTopologyObservation,
} from "./parse-korail-metropolitan-timetable.mjs";

test("calendar rows use supplied validity and holiday exceptions without duplicate weekend service", () => {
  const input = { startDate: "20400101", endDate: "20400110",
    serviceIds: { "평일": "weekday", "휴일": "holiday" },
    publicHolidayDates: new Set(["20400108", "20400102", "20400120"]) };
  const rows = buildKorailServiceCalendars(input);
  assert.deepEqual(rows.serviceCalendars, [
    { serviceId: "weekday", monday: true, tuesday: true, wednesday: true, thursday: true,
      friday: true, saturday: false, sunday: false, startDate: input.startDate, endDate: input.endDate, timezone: "Asia/Seoul" },
    { serviceId: "holiday", monday: false, tuesday: false, wednesday: false, thursday: false,
      friday: false, saturday: true, sunday: true, startDate: input.startDate, endDate: input.endDate, timezone: "Asia/Seoul" },
  ]);
  assert.deepEqual(rows.serviceCalendarDates, [
    { serviceId: "weekday", date: "20400102", exceptionType: 2 },
    { serviceId: "holiday", date: "20400102", exceptionType: 1 },
  ]);
  assert.throws(() => buildKorailServiceCalendars({ ...input, startDate: "20400111" }));
  assert.throws(() => buildKorailServiceCalendars({ ...input, serviceIds: { "평일": "same", "휴일": "same" } }));
});

test("owner calendar policy selects weekends and supplied public holidays without a year list", () => {
  const publicHolidayDates = new Set(["20400102"]);
  assert.equal(korailServiceDayLabel({ serviceDate: "20400102", publicHolidayDates }), "휴일");
  assert.equal(korailServiceDayLabel({ serviceDate: "20400103", publicHolidayDates }), "평일");
  assert.equal(korailServiceDayLabel({ serviceDate: "20400107", publicHolidayDates }), "휴일");
  assert.equal(korailServiceDayLabel({ serviceDate: "20400108", publicHolidayDates }), "휴일");
  assert.throws(() => korailServiceDayLabel({ serviceDate: "20400230", publicHolidayDates }));
  assert.throws(() => korailServiceDayLabel({ serviceDate: "20400103" }));
});

test("canonical join preserves IDs and rejects ambiguous names and inconsistent order", () => {
  const stations = [{ id: "s-a", nameKo: "가역" }, { id: "s-b", nameKo: "나" }, { id: "s-c", nameKo: "다" }];
  const stationLines = stations.map(({ id }, index) => ({ stationId: id, lineId: "line", lineSequence: index + 1 }));
  const members = ["가", "나", "다"].map((stationName, index) => ({ stationName, stationNumber: `K${index}` }));
  const orders = [{ stations: members }, { stations: [...members].reverse() }];
  const bind = (overrides = {}) => bindKorailCanonicalStations({ stations, stationLines, lineId: "line", orders, ...overrides });
  assert.deepEqual(bind(), members.map((row, index) => ({ ...row, stationId: stations[index].id })));
  assert.throws(() => bind({ lineId: "other" }));
  assert.throws(() => bind({ stations: [...stations.slice(0, 2), { id: "s-c", nameKo: "가" }] }));
  assert.throws(() => bind({ orders: [{ stations: [members[0], members[2], members[1]] }] }));
  assert.throws(() => bind({ orders: [{ stations: members.slice(1) }] }));
});

test("retained XLSX parsing binds exact bytes and keeps native sparse row coordinates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "korail-workbook-test-"));
  try {
    await mkdir(path.join(root, "xl/_rels"), { recursive: true });
    await mkdir(path.join(root, "xl/worksheets"));
    await writeFile(path.join(root, "xl/workbook.xml"), '<workbook><sheets><sheet name="평일_상" r:id="rId1"/></sheets></workbook>');
    await writeFile(path.join(root, "xl/_rels/workbook.xml.rels"), '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
    const rows = [[10, "시발역", "가"], [12, "종착역", "나"], [14, "열차번호", "T"],
      [20, "가", ""], [21, "", "0.5"], [22, "나", "0.51"], [23, "", ""]];
    const xml = rows.map(([r, a, b]) => `<row r="${r}"><c r="A${r}" t="inlineStr"><is><t>${a}</t></is></c><c r="B${r}" t="inlineStr"><is><t>${b}</t></is></c></row>`).join("");
    await writeFile(path.join(root, "xl/worksheets/sheet1.xml"), `<worksheet><sheetData>${xml}</sheetData></worksheet>`);
    execFileSync("zip", ["-qr", "input.xlsx", "xl"], { cwd: root });
    const inputPath = path.join(root, "input.xlsx");
    const bytes = await readFile(inputPath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const result = await parseRetainedKorailWorkbook({ inputPath, sha256 });
    assert.equal(result.rawSha256, sha256);
    assert.equal(result.rawByteLength, bytes.length);
    assert.deepEqual(result.sheets[0].trains[0].stops[0].departure,
      { cellId: "B21", rawValue: "0.5", seconds: 43200 });
    const stationLineRecords = [
      stationLineRecord("KORAIL", "대구선", "001", "가"),
      stationLineRecord("KORAIL", "대구선", "002", "나"),
    ];
    const stationLineObservation = {
      schemaVersion: 1,
      artifactKind: "kric-current-station-line-observation",
      sourceId: "kric-current-station-line-file",
      observedAt: "2026-09-01T00:00:00.000Z",
      rawFile: "station-line.xlsx",
      rawByteLength: 12,
      rawSha256: "a".repeat(64),
      rowCount: stationLineRecords.length,
      records: stationLineRecords,
      recordsSha256: hash(Buffer.from(`${JSON.stringify(stationLineRecords)}\n`)),
    };
    const stationLineReceipt = {
      schemaVersion: 1,
      artifactKind: "kric-current-station-line-file-receipt",
      sourceId: stationLineObservation.sourceId,
      capturedAt: stationLineObservation.observedAt,
      rawFile: stationLineObservation.rawFile,
      byteLength: stationLineObservation.rawByteLength,
      sha256: stationLineObservation.rawSha256,
      credentialRedacted: true,
    };
    const canonicalCatalogPath = path.join(root, "catalog.json");
    const catalogBytes = JSON.stringify({ packs: [{
      stations: [{ id: "canonical-a", nameKo: "가역" }, { id: "canonical-b", nameKo: "나" }],
      stationLines: [{ stationId: "canonical-a", lineId: "L", lineSequence: 1 },
        { stationId: "canonical-b", lineId: "L", lineSequence: 2 }],
    }] });
    await writeFile(canonicalCatalogPath, catalogBytes);
    const input = {
      inputPath, sha256, stationLineObservation, stationLineReceipt, operatorName: "KORAIL", lineName: "대구선",
      canonicalCatalogPath, canonicalCatalogSha256: hash(catalogBytes), lineId: "L",
    };
    const observation = await buildRetainedKorailTopologyObservation(input);
    const holidayRaw = Buffer.from('<response><header><resultCode>00</resultCode></header><body><items><item><locdate>20400102</locdate><isHoliday>Y</isHoliday></item></items><totalCount>1</totalCount></body></response>');
    const tableInput = { observation,
      startDate: "20400101", endDate: "20400110",
      holidayMonths: [{ raw: holidayRaw, sha256: hash(holidayRaw), year: 2040, month: 1 }],
      serviceIds: { "평일": "weekday", "휴일": "holiday" }, routeIds: { up: "route-up", down: "route-down" },
    };
    const tables = buildKorailTimetableTables(tableInput);
    assert.equal(tables.holidayCalendarSources[0].rawSha256, hash(holidayRaw));
    assert.throws(() => buildKorailTimetableTables({ ...tableInput, endDate: "20400201" }), /month coverage/);
    assert.throws(() => buildKorailTimetableTables({ ...tableInput, holidayMonths: [] }), /month coverage/);
    assert.equal(tables.transitTrips[0].serviceId, "weekday");
    assert.deepEqual(tables.transitStopTimes.map(({ arrivalSeconds, departureSeconds, pickupType, dropOffType }) =>
      ({ arrivalSeconds, departureSeconds, pickupType, dropOffType })), [
      { arrivalSeconds: 43200, departureSeconds: 43200, pickupType: 0, dropOffType: 1 },
      { arrivalSeconds: 44064, departureSeconds: 44064, pickupType: 1, dropOffType: 0 },
    ]);
    assert.equal(observation.topology.passengerTrips[0].stops[0].arrival.seconds, null);
    assert.equal(observation.sources.catalog.rawSha256, hash(catalogBytes));
    assert.deepEqual(observation.topology.passengerTrips[0].stops.map(({ stationId }) => stationId),
      ["canonical-a", "canonical-b"]);
    await assert.rejects(buildRetainedKorailTopologyObservation({ ...input, canonicalCatalogSha256: "0".repeat(64) }), /catalog/);
    assert.deepEqual(observation.sources.timetable, {
      sourceId: "korail-metropolitan-timetable-file", rawSha256: sha256, rawByteLength: bytes.length,
    });
    assert.equal(observation.sources.membership.rawSha256, stationLineObservation.rawSha256);
    assert.deepEqual(observation.selection, { operatorName: "KORAIL", lineName: "대구선", lineId: "L" });
    assert.deepEqual(observation.topology.edges[0].observations[0].departure,
      { cellId: "B21", rawValue: "0.5", seconds: 43200 });
    assert.equal(observation.topology.edges[0].fromStationNumber, "001");
    assert.equal(observation.topology.edges[0].toStationNumber, "002");
    assert.deepEqual(await readFile(inputPath), bytes);
    await assert.rejects(parseRetainedKorailWorkbook({ inputPath, sha256: "0".repeat(64) }), /digest mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function stationLineRecord(operatorName, lineName, stationNumber, stationName) {
  const record = { operatorName, lineName, stationNumber, stationName };
  return { ...record, sourceRowSha256: hash(JSON.stringify(record)) };
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("passenger topology excludes passing locations and preserves observed segment cells", () => {
  const sheet = parseKorailMetropolitanSheet({ name: "평일_상", rows: [
    { rowNumber: 1, cells: ["시발역", "가"] },
    { rowNumber: 2, cells: ["종착역", "다"] },
    { rowNumber: 3, cells: ["열차번호", "T1"] },
    { rowNumber: 4, cells: ["가", ""] },
    { rowNumber: 5, cells: ["", "0.5"] },
    { rowNumber: 6, cells: ["통과", ""] },
    { rowNumber: 7, cells: ["", "0.51"] },
    { rowNumber: 8, cells: ["다", "0.52"] },
    { rowNumber: 9, cells: ["", ""] },
  ] });
  const membership = [
    { stationName: "다", stationNumber: "X1", sourceRowSha256: "a".repeat(64) },
    { stationName: "가", stationNumber: "X9", sourceRowSha256: "b".repeat(64) },
  ];
  const result = projectKorailPassengerTopology({ sheets: [sheet], membership });
  assert.deepEqual(result.orders[0].stations, [membership[1], membership[0]]);
  assert.equal(result.edges.length, 1);
  assert.deepEqual(result.passengerTrips, [{
    sheetName: sheet.sheetName, dayLabel: sheet.dayLabel, directionLabel: sheet.directionLabel,
    trainNo: "T1", originStationNumber: "X9", destinationStationNumber: "X1",
    stops: [
      { stationNumber: "X9", arrival: sheet.trains[0].stops[0].arrival, departure: sheet.trains[0].stops[0].departure },
      { stationNumber: "X1", arrival: sheet.trains[0].stops[2].arrival, departure: sheet.trains[0].stops[2].departure },
    ],
  }]);
  assert.deepEqual(result.edges[0], {
    fromStationNumber: "X9", toStationNumber: "X1",
    observations: [{ sheetName: "평일_상", trainNo: "T1", durationSeconds: 1728,
      departure: sheet.trains[0].stops[0].departure, arrival: sheet.trains[0].stops[2].arrival }],
  });
  assert.throws(() => projectKorailPassengerTopology({ sheets: [sheet], membership: [
    ...membership, { stationName: "없는역", stationNumber: "X2", sourceRowSha256: "c".repeat(64) },
  ] }));
  const missing = structuredClone(sheet);
  missing.trains[0].stops[0].departure.seconds = null;
  assert.throws(() => projectKorailPassengerTopology({ sheets: [missing], membership }));
});

test("passenger trips retain partial service endpoints without filling absent terminal times", () => {
  const makeStop = (stationName, arrival, departure) => ({ stationName,
    arrival: { cellId: "B1", rawValue: "", seconds: arrival },
    departure: { cellId: "B2", rawValue: "", seconds: departure } });
  const membership = ["가", "나", "다"].map((stationName, index) => ({
    stationName, stationNumber: String(index), sourceRowSha256: "a".repeat(64),
  }));
  const sheet = { sheetName: "휴일_하", dayLabel: "휴일", directionLabel: "하", trains: [
    { trainNo: "FULL", origin: "가", destination: "다",
      stops: [makeStop("가", null, 10), makeStop("나", 20, 25), makeStop("다", 40, null)] },
    { trainNo: "PART", origin: "나", destination: "다",
      stops: [makeStop("가", null, null), makeStop("나", null, 50), makeStop("다", 70, null)] },
  ] };
  const { passengerTrips } = projectKorailPassengerTopology({ sheets: [sheet], membership });
  assert.deepEqual(passengerTrips[1].stops.map(({ stationNumber }) => stationNumber), ["1", "2"]);
  assert.equal(passengerTrips[1].stops[0].arrival.seconds, null);
  assert.equal(passengerTrips[1].stops[1].departure.seconds, null);
  assert.equal(passengerTrips[1].dayLabel, "휴일");
});

test("native train clocks preserve blanks, zero and midnight cell provenance", () => {
  const cells = [
    { cellId: "C5", rawValue: "0.99930555555555556" },
    { cellId: "C6", rawValue: " " },
    { cellId: "C7", rawValue: "0" },
    { cellId: "C8", rawValue: "0.0055555555555558" },
  ];
  assert.deepEqual(normalizeKorailTrainClockCells(cells), cells.map((cell, index) => ({
    ...cell, seconds: [86340, null, 86400, 86880][index],
  })));
  assert.deepEqual(normalizeKorailTrainClockCells([{ cellId: "D5", rawValue: "0" }]),
    [{ cellId: "D5", rawValue: "0", seconds: 0 }]);
});

test("clock parsing rejects invalid evidence instead of rounding source precision", () => {
  for (const rawValue of ["not-a-time", "-0.1", "1", "Infinity", "0x10", String(0.5 / 86400)]) {
    assert.throws(() => normalizeKorailTrainClockCells([{ cellId: "C5", rawValue }]));
  }
  assert.throws(() => normalizeKorailTrainClockCells([
    { cellId: "C5", rawValue: "0" }, { cellId: "C5", rawValue: "0" },
  ]));
});

test("metropolitan sheet parser preserves shifted native row and cell provenance", () => {
  const parsed = parseKorailMetropolitanSheet({
    name: "평일_상",
    rows: [
      { rowNumber: 41, cells: ["시발역", "동대구"] },
      { rowNumber: 48, cells: ["종착역", "대구"] },
      { rowNumber: 56, cells: ["열차번호", "K123"] },
      { rowNumber: 61, cells: ["동대구", "0.5"] },
      { rowNumber: 62, cells: ["", "0.51"] },
      { rowNumber: 66, cells: ["대구", "0.6"] },
      { rowNumber: 67, cells: ["", "0.61"] },
      { rowNumber: 70, cells: ["", ""] },
    ],
  });

  assert.deepEqual(parsed, {
    sheetName: "평일_상",
    dayLabel: "평일",
    directionLabel: "상",
    trains: [{
      trainNo: "K123",
      origin: "동대구",
      destination: "대구",
      column: "B",
      stops: [
        { stationName: "동대구", arrival: { cellId: "B61", rawValue: "0.5", seconds: 43200 },
          departure: { cellId: "B62", rawValue: "0.51", seconds: 44064 } },
        { stationName: "대구", arrival: { cellId: "B66", rawValue: "0.6", seconds: 51840 },
          departure: { cellId: "B67", rawValue: "0.61", seconds: 52704 } },
      ],
    }],
  });
});

test("metropolitan sheet parser rejects malformed station pairs and endpoint mismatches", () => {
  const headers = [
    { rowNumber: 10, cells: ["시발역", "대구"] },
    { rowNumber: 12, cells: ["종착역", "영천"] },
    { rowNumber: 14, cells: ["열차번호", "K123"] },
  ];
  assert.throws(() => parseKorailMetropolitanSheet({
    name: "휴일_하",
    rows: [...headers, { rowNumber: 20, cells: ["동대구", "0.5"] }],
  }));
  assert.throws(() => parseKorailMetropolitanSheet({
    name: "휴일_하",
    rows: [...headers,
      { rowNumber: 20, cells: ["동대구", "0.5"] },
      { rowNumber: 21, cells: ["", "0.51"] },
      { rowNumber: 22, cells: ["대구", "0.6"] },
      { rowNumber: 23, cells: ["", "0.61"] },
    ],
  }));
});
