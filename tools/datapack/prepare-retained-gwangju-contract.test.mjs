import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareRetainedGwangjuContract, runRetainedGwangjuContractPreparation } from "./prepare-retained-gwangju-contract.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const candidate = JSON.parse(await readFile("tools/datapack/source-candidates.json", "utf8"))
  .candidates.find(({ id }) => id === "kric-nationwide-timetable-file");
const cell = (value) => ({ value, cellType: "inlineStr", styleId: null });

test("retained contract CLI binds stored inputs and refuses overwrite", async context => {
  const directory = await mkdtemp(path.join(tmpdir(), "gwangju-contract-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const args = input();
  const json = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  await mkdir(path.join(directory, "tools/datapack/sources"), { recursive: true });
  const topologyId = "gwangju-transportation-route-topology-test";
  const snapshotPath = `tools/datapack/sources/${topologyId}.json`;
  await json(path.join(directory, snapshotPath), args.topologySnapshot);
  await json(path.join(directory, "tools/datapack/source-candidates.json"), { candidates: [candidate] });
  await json(path.join(directory, "tools/datapack/source-inventory.json"), { sources: [{
    id: "gwangju-transportation-route-topology", topologyAdmissionEvidence: { snapshotId: topologyId, snapshotPath },
  }] });
  const observationPath = path.join(directory, "observation.json"), receiptPath = path.join(directory, "receipt.json");
  const stationBindingsPath = path.join(directory, "bindings.json"), holidayDirectory = path.join(directory, "holidays");
  await writeFile(observationPath, args.observationBytes);
  await json(receiptPath, args.receipt);
  await json(stationBindingsPath, { stationBindings: args.stationBindings, excludedEndpointLabels: args.excludedEndpointLabels });
  await mkdir(holidayDirectory);
  const months = [];
  for (const { raw, ...month } of args.holidayCalendar.months) {
    const file = `${month.year}-${String(month.month).padStart(2, "0")}.xml`;
    await writeFile(path.join(holidayDirectory, file), raw);
    months.push({ ...month, file });
  }
  await json(path.join(holidayDirectory, "months.json"), { schemaVersion: 1, sourceId: "kasi-public-holiday-calendar", months });
  const inputPath = path.join(directory, "input.json"), outputPath = path.join(directory, "output.json");
  const specification = { observationPath, receiptPath, stationBindingsPath, holidayDirectory, routeNumber: args.routeNumber, providerValidUntil: null };
  await json(inputPath, specification);
  const invoke = () => runRetainedGwangjuContractPreparation(["--input", inputPath, "--output", outputPath], {
    repositoryRoot: directory, now: new Date(args.evaluationAt),
  });
  const result = await invoke();
  const bytes = await readFile(outputPath);
  assert.match(result.contractSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(JSON.parse(bytes).calendar.publicHolidayDates, ["20401231", "20410101"]);
  await assert.rejects(invoke, { code: "EEXIST" });
  assert.deepEqual(await readFile(outputPath), bytes);
  await json(inputPath, { ...specification, obsoleteDateOverride: "ignored" });
  await assert.rejects(invoke, /input is invalid/);
});
const monthXml = (date) => Buffer.from(`<?xml version="1.0"?><response><header><resultCode>00</resultCode></header><body><items><item><locdate>${date}</locdate><isHoliday>Y</isHoliday></item></items><totalCount>1</totalCount></body></response>`);

function input() {
  const observedAt = "2040-12-31T14:00:00.000Z";
  const records = [
    ["1", "A", "B", "A", "24:00:00"], ["1", "A", "B", "B", "24:02:00"],
    ["2", "B", "A", "B", "25:00:00"], ["2", "B", "A", "A", "25:02:00"],
  ].map(([trainNumber, originStationName, destinationStationName, stationName, arrivalTime], index) => {
    const row = { trainNumber, routeNumber: "S2901", routeName: "광주 1호선",
      originStationName, destinationStationName, serviceType: "일반", weekdayType: "평일", stationName,
      arrivalTime: cell(arrivalTime), departureTime: cell(arrivalTime), speed: cell(""), operatorPhone: cell(""),
      dataReferenceDate: cell("2040-12-31"), sourceRowNumber: index + 1 };
    return { ...row, sourceRowSha256: sha256(JSON.stringify(row)) };
  });
  const observation = { schemaVersion: 1, artifactKind: "kric-nationwide-timetable-observation",
    sourceId: candidate.id, observedAt, rawFile: "source.xlsx", rawByteLength: 12, rawSha256: "a".repeat(64),
    rowCount: records.length, groupCount: 2, records, recordsSha256: sha256(`${JSON.stringify(records)}\n`),
    gaps: { stopSequence: "ABSENT", timeGrammar: "UNADMITTED" } };
  const receipt = { schemaVersion: 1, artifactKind: "kric-nationwide-timetable-file-receipt", sourceId: candidate.id,
    capturedAt: observedAt, rawFile: observation.rawFile, byteLength: observation.rawByteLength,
    sha256: observation.rawSha256, credentialRedacted: true };
  const month = (year, number, date) => {
    const raw = monthXml(date);
    return { raw, sha256: sha256(raw), year, month: number, retrievedAt: observedAt };
  };
  return { candidate, observationBytes: Buffer.from(JSON.stringify(observation)), receipt, routeNumber: "S2901",
    stationBindings: [{ sourceLabel: "A", stationId: "station-a", stationCode: "1" },
      { sourceLabel: "B", stationId: "station-b", stationCode: "2" }], excludedEndpointLabels: [],
    topologySnapshot: { scope: [{ stationCode: "1" }, { stationCode: "2" }],
      edges: [{ fromStationCode: "1", toStationCode: "2" }, { fromStationCode: "2", toStationCode: "1" }] },
    holidayCalendar: { manifestSha256: "b".repeat(64), months: [month(2041, 1, "20410101"), month(2040, 12, "20401231")] },
    evaluationAt: observedAt };
}

test("prepares a deterministic cross-month retained contract with both directions", () => {
  const args = input();
  const first = prepareRetainedGwangjuContract(args);
  const second = prepareRetainedGwangjuContract({ ...args,
    holidayCalendar: { ...args.holidayCalendar, months: [...args.holidayCalendar.months].reverse() } });
  assert.equal(first.contract.calendar.startDate, "20401231");
  assert.equal(first.contract.calendar.endDate, "20410107");
  assert.deepEqual(first.contract.calendar.publicHolidayDates, ["20401231", "20410101"]);
  assert.deepEqual(first.contract.routeBindings.map(({ directionId, stationCodes }) => ({ directionId, stationCodes })), [
    { directionId: "forward", stationCodes: ["1", "2"] },
    { directionId: "reverse", stationCodes: ["2", "1"] },
  ]);
  assert.equal(first.contractSha256, second.contractSha256);
  assert.deepEqual(first.contract, second.contract);
});

test("rejects missing coverage and altered retained month bytes", () => {
  const args = input();
  assert.throws(() => prepareRetainedGwangjuContract({ ...args,
    holidayCalendar: { ...args.holidayCalendar, months: args.holidayCalendar.months.slice(1) } }), /missing official holiday month/);
  assert.throws(() => prepareRetainedGwangjuContract({ ...args,
    holidayCalendar: { ...args.holidayCalendar, months: [{ ...args.holidayCalendar.months[0], sha256: "0".repeat(64) }, args.holidayCalendar.months[1]] } }), /digest/);
});
