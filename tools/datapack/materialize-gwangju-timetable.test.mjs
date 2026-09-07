import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import {
  materializeRegionalProductionCandidate,
  projectHistoricalRegionalMaterializeInventory,
  projectRegionalMaterializeFixture,
} from "./materialize-test-fixture.mjs";
import { createRetainedGwangjuTestInput } from "./gwangju-retained-test-fixture.mjs";

import {
  parseMolitGwangjuStationMappings,
} from "./build-molit-nationwide-fixture.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import {
  buildRetainedGwangjuServiceCalendars,
  buildRetainedGwangjuTransitTables,
  materializeGwangjuTimetable,
  projectRetainedGwangjuTrips,
  projectRetainedGwangjuTimetable,
  runGwangjuTimetableMaterializer,
} from "./materialize-gwangju-timetable.mjs";

const retainedServices = { "평일": "weekday", "토요일": "saturday", "휴일": "holiday", "명절": "special" };

test("MOLIT Gwangju topology binding preserves canonical IDs with variable topology codes", async () => {
  const source = await readFile(path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv"));
  const lines = Buffer.from(source).toString("latin1").split("\n").map((line) => Buffer.from(`${line}\n`, "latin1"));
  const names = new Set(["녹동", "소태", "광주송정역"]);
  const csv = Buffer.concat([lines[0], ...lines.slice(1).filter((line) => names.has(new TextDecoder("euc-kr").decode(line).trim().split(",").at(-1)))]);
  const topologySnapshot = { scope: [
    { stationName: "광주송정", stationCode: "join-77" },
    { stationName: "소태", stationCode: "join-4" },
    { stationName: "녹동", stationCode: "join-901" },
  ] };
  const mappings = parseMolitGwangjuStationMappings(csv, topologySnapshot);
  assert.deepEqual(mappings.map(({ stationName, stationNumber }) => [stationName, stationNumber]), [
    ["녹동", "join-901"], ["소태", "join-4"], ["광주송정역", "join-77"],
  ]);
  // 기존 canonical 광주송정역 ID는 topology의 코드 변경과 무관하게 보존한다.
  assert.equal(mappings[2].stationId, "station-45d732c94df2");
  assert.throws(() => parseMolitGwangjuStationMappings(csv), /topology/i);
  assert.throws(() => parseMolitGwangjuStationMappings(csv, { scope: topologySnapshot.scope.slice(1) }), /mapping|topology/i);
  assert.throws(() => parseMolitGwangjuStationMappings(csv, { scope: [...topologySnapshot.scope, { stationName: "소태", stationCode: "other" }] }), /duplicate/i);
  assert.throws(() => parseMolitGwangjuStationMappings(csv, { scope: [{ stationName: "녹동", stationCode: "join-4" }, ...topologySnapshot.scope.slice(1)] }), /duplicate/i);
});

test("retained Gwangju calendars apply owner weekend selection without duplicate native services", () => {
  const result = buildRetainedGwangjuServiceCalendars({ startDate: "20400105", endDate: "20400110", serviceIds: retainedServices,
    publicHolidayDates: new Set(["20400104", "20400105", "20400108", "20400109", "20400111"]) });
  const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  // 합성 달력: 평일 공휴일, 보통 평일, 토/일요일, 대체공휴일 순으로 실제 활성 서비스를 평가한다.
  for (const [date, expected] of [["20400105", "special"], ["20400106", "weekday"],
    ["20400107", "special"], ["20400108", "special"], ["20400109", "special"], ["20400110", "weekday"]]) {
    const day = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00Z`).getUTCDay();
    const active = new Set(result.serviceCalendars.filter(row => row[weekdays[day]]).map(row => row.serviceId));
    for (const row of result.serviceCalendarDates.filter(row => row.date === date)) {
      if (row.exceptionType === 1) active.add(row.serviceId);
      else active.delete(row.serviceId);
    }
    assert.deepEqual([...active], [expected], date);
  }
  assert.deepEqual(result.serviceCalendars.map(row => row.serviceId), Object.values(retainedServices));
  assert.deepEqual(result.serviceCalendarDates, [
    { serviceId: "weekday", date: "20400105", exceptionType: 2 }, { serviceId: "special", date: "20400105", exceptionType: 1 },
    { serviceId: "weekday", date: "20400109", exceptionType: 2 }, { serviceId: "special", date: "20400109", exceptionType: 1 },
  ]);
});

test("retained Gwangju calendars reject missing sets, invalid dates, and duplicate service identities", () => {
  const valid = { startDate: "20400101", endDate: "20400102", serviceIds: retainedServices, publicHolidayDates: new Set() };
  for (const input of [{ ...valid, publicHolidayDates: [] }, { ...valid, publicHolidayDates: undefined },
    { ...valid, publicHolidayDates: new Set(["20400230"]) },
    { ...valid, serviceIds: { ...retainedServices, "명절": "holiday" } }]) {
    assert.throws(() => buildRetainedGwangjuServiceCalendars(input), /calendar input/);
  }
});

const root = path.resolve(import.meta.dirname, "../..");
process.env.EASYSUBWAY_DATAPACK_PRODUCTION_FIXTURE_VALIDATION_ONLY = "true";
const now = new Date("2026-07-20T13:09:00.000Z");
const execFileAsync = promisify(execFile);

function retainedNativeRecord(sourceRowNumber, stationName, overrides = {}) {
  const record = {
    trainNumber: "1001", routeNumber: "S2901", routeName: "광주 1호선",
    originStationName: "A", destinationStationName: "B", serviceType: "LOCAL", weekdayType: "WEEKDAY",
    stationName, arrivalTime: { value: "24:00:00" }, departureTime: { value: "24:00:30" },
    sourceRowNumber, sourceRowSha256: "a".repeat(64), nativeMarker: `native-${sourceRowNumber}`,
    ...overrides,
  };
  return record;
}

const retainedBindings = Object.freeze([
  { sourceLabel: "A", stationId: "station-a", stationCode: "A" },
  { sourceLabel: "B", stationId: "station-b", stationCode: "B" },
]);
const retainedEdges = Object.freeze([{ fromStationCode: "A", toStationCode: "B" }]);
const retainedProjection = (records, overrides = {}) => projectRetainedGwangjuTrips({
  records, stationBindings: retainedBindings, directedEdges: retainedEdges, excludedEndpointLabels: ["외부"], ...overrides,
});

test("receipt-bound Gwangju projection selects native rows without granting admission", () => {
  const input = retainedTimetableEvidence();
  const result = projectRetainedGwangjuTimetable(input);
  assert.equal(result.source.rawSha256, input.observation.rawSha256);
  assert.equal(result.source.recordsSha256, input.observation.recordsSha256);
  assert.equal(result.trips.length, 1);
  assert.deepEqual(result.trips[0].records.map(({ record }) => record), input.observation.records.slice(0, 2));
  assert.deepEqual(result.trips[0].stops.map((stop) => stop.stationId), ["station-a", "station-b"]);
  assert.equal(result.trips[0].stops[1].arrival.seconds, 90000);
  assert.equal(Object.hasOwn(result, "admissionDecision"), false);
});

test("receipt-bound Gwangju projection rejects unbound receipts, rows, and route selection", () => {
  const input = retainedTimetableEvidence();
  assert.throws(() => projectRetainedGwangjuTimetable({ ...input,
    receipt: { ...input.receipt, sha256: "b".repeat(64) } }), /TIMETABLE_RECEIPT/);
  const changed = structuredClone(input);
  changed.observation.records[0].stationName = "Changed";
  changed.observation.recordsSha256 = digest(`${JSON.stringify(changed.observation.records)}\n`);
  assert.throws(() => projectRetainedGwangjuTimetable(changed), /TIMETABLE_RECORD/);
  assert.throws(() => projectRetainedGwangjuTimetable({ ...input, routeNumber: "absent" }), /TIMETABLE_SELECTION/);
});

function digest(value) { return createHash("sha256").update(value).digest("hex"); }

function retainedTimetableEvidence() {
  const cell = (value) => ({ value, cellType: "inlineStr", styleId: null });
  const routeNumber = retainedNativeRecord(1, "A").routeNumber;
  const rows = [[routeNumber, "A", "24:00:00"], [routeNumber, "B", "25:00:00"],
    ["other-route", "Other", "08:00:00"]].map(([routeNumber, stationName, time], index) => {
    const row = { trainNumber: "one", routeNumber, routeName: "Test line", originStationName: "A",
      destinationStationName: "B", serviceType: "일반", weekdayType: "평일", stationName,
      arrivalTime: cell(time), departureTime: cell(time), speed: cell(""), operatorPhone: cell(""),
      dataReferenceDate: cell("2040-01-01"), sourceRowNumber: index + 1 };
    return { ...row, sourceRowSha256: digest(JSON.stringify(row)) };
  });
  const observation = { schemaVersion: 1, artifactKind: "kric-nationwide-timetable-observation",
    sourceId: "kric-nationwide-timetable-file", observedAt: "2040-01-02T00:00:00.000Z",
    rawFile: "kric-nationwide-timetable-file-test.xlsx", rawByteLength: 12, rawSha256: "a".repeat(64),
    rowCount: rows.length, groupCount: 2, records: rows, recordsSha256: digest(`${JSON.stringify(rows)}\n`),
    gaps: { stopSequence: "ABSENT", timeGrammar: "UNADMITTED" } };
  const receipt = { schemaVersion: 1, artifactKind: "kric-nationwide-timetable-file-receipt",
    sourceId: observation.sourceId, capturedAt: observation.observedAt, rawFile: observation.rawFile,
    byteLength: observation.rawByteLength, sha256: observation.rawSha256, credentialRedacted: true };
  return { observation, receipt, routeNumber, stationBindings: retainedBindings,
    directedEdges: retainedEdges, excludedEndpointLabels: [] };
}

async function retainedProductionInput() {
  const [topologySnapshot, stationMap, sourceInventory] = await Promise.all([
    readJson("tools/datapack/sources/gwangju-transportation-route-topology-20260720.json"),
    readFile(path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv")),
    readJson("tools/datapack/source-inventory.json"),
  ]);
  const mappings = parseMolitGwangjuStationMappings(stationMap, topologySnapshot);
  const arrays = ["sourceInventory", "operators", "lines", "stations", "stationLines", "networkEdges", "serviceCalendars", "serviceCalendarDates", "transitRoutes", "transitTrips", "transitStopTimes", "transitFeedInfo"];
  const pack = Object.fromEntries(arrays.map((key) => [key, []]));
  Object.assign(pack, { id: "base", version: "1", artifactKind: "production", url: "", minimumTableRows: {} });
  return createRetainedGwangjuTestInput({
    baseFixture: { manifest: { activePack: { id: "base", version: "1" } }, packs: [pack] },
    topologySnapshot,
    inventory: projectHistoricalRegionalMaterializeInventory(sourceInventory),
    canonicalStationMappings: mappings,
  });
}

test("retained production Gwangju emits receipt-bound native tables without cyber source", async () => {
  const input = await retainedProductionInput();
  const fixture = materializeGwangjuTimetable({ ...input, canonicalStationMappings: input.mappings, now });
  const pack = fixture.packs[0], [trip] = pack.transitTrips;
  assert.equal(trip.sourceId, "kric-nationwide-timetable-file");
  assert.equal(pack.transitStopTimes.length, 2);
  assert.deepEqual(pack.transitStopTimes.map(({ arrivalSeconds, departureSeconds }) => [arrivalSeconds, departureSeconds]), [[86400, 86430], [86460, 86490]]);
  assert.ok(pack.sourceInventory.some(({ id }) => id === "kric-nationwide-timetable-file"));
  assert.ok(pack.sourceInventory.every(({ id }) => id !== "gwangju-transportation-cyberstation-timetable"));
  assert.equal(pack.networkEdges.length, input.topologySnapshot.edges.length);
  assert.match(pack.id, /^nationwide-gwangju-schedule-[a-f0-9]{64}$/);
  assert.deepEqual(fixture.manifest.activePack, { id: pack.id, version: pack.version });
  assert.equal(pack.version, input.retainedTimetable.observation.observedAt.slice(0, 10).replaceAll("-", ""));
  const topologyEvidence = input.inventory.sources.find(({ id }) => id === "gwangju-transportation-route-topology")
    .topologyAdmissionEvidence;
  const topologyMembershipEvidence = input.inventory.sources.find(({ id }) =>
    id === "gwangju-transportation-route-topology").membershipAdmissionEvidence;
  const membershipEvidence = input.inventory.sources.find(({ id }) =>
    id === "molit-urban-rail-full-route-gwangju-membership").membershipAdmissionEvidence;
  const stationLines = pack.stationLines.filter(({ lineId }) => lineId === "line-e57a361e8892");
  assert.equal(stationLines.length, input.mappings.length);
  assert.ok(pack.networkEdges.every(({ sourceId, sourceSnapshotId, evidenceHash }) =>
    sourceId === "gwangju-transportation-route-topology"
      && sourceSnapshotId === topologyEvidence.snapshotId
      && evidenceHash === input.topologySnapshot.contentSha256));
  assert.ok(stationLines.every(({ fieldProvenance }) =>
    fieldProvenance.station_code.sourceId === "gwangju-transportation-route-topology"
      && fieldProvenance.station_code.sourceSnapshotId === topologyEvidence.snapshotId
      && fieldProvenance.station_code.evidenceHash === input.topologySnapshot.contentSha256));
  assert.deepEqual(topologyMembershipEvidence, membershipEvidence);
  assert.equal(trip.providerRecordHash, digest(JSON.stringify(input.retainedTimetable.observation.records.map(({ sourceRowSha256 }) => sourceRowSha256))));
});

test("retained production Gwangju rejects receipt, contract, and source-admission drift", async () => {
  const input = await retainedProductionInput();
  const invoke = (value) => materializeGwangjuTimetable({ ...value, canonicalStationMappings: value.mappings, now });
  const badReceipt = structuredClone(input); badReceipt.retainedTimetable.receipt.sha256 = "b".repeat(64);
  assert.throws(() => invoke(badReceipt), /TIMETABLE_RECEIPT/);
  const badContract = structuredClone(input); badContract.retainedTimetable.routeBindings[0].tripHeadsign = "changed";
  assert.throws(() => invoke(badContract), /inventory evidence/);
  const missingSource = structuredClone(input); missingSource.inventory.sources = missingSource.inventory.sources.filter(({ id }) => id !== "kric-nationwide-timetable-file");
  assert.throws(() => invoke(missingSource), /inventory evidence/);
  const dualEvidence = structuredClone(input); dualEvidence.inventory.sources.find(({ id }) => id === "kric-nationwide-timetable-file").scheduleAdmissionEvidence = {};
  assert.throws(() => invoke(dualEvidence), /inventory evidence/);
  const foreignBinding = structuredClone(input);
  foreignBinding.retainedTimetable.stationBindings[0].stationId = foreignBinding.mappings[2].stationId;
  const contract = { ...foreignBinding.retainedTimetable }; delete contract.observation; delete contract.receipt;
  foreignBinding.inventory.sources.find(({ id }) => id === "kric-nationwide-timetable-file")
    .retainedScheduleAdmissionEvidence.retainedContractSha256 = digest(canonicalJson(contract));
  assert.throws(() => invoke(foreignBinding), /canonical membership/);
});

test("retained production Gwangju preserves topology freshness and membership validation", async () => {
  const input = await retainedProductionInput();
  const invoke = (overrides) => materializeGwangjuTimetable({ ...input, canonicalStationMappings: input.mappings, now, ...overrides });
  const topologySnapshot = structuredClone(input.topologySnapshot);
  topologySnapshot.edges[0].durationSeconds += 1;
  assert.throws(() => invoke({ topologySnapshot }), /topology snapshot/);
  assert.throws(() => invoke({ now: new Date(input.topologySnapshot.freshUntil) }), /stale/);
  const inventory = structuredClone(input.inventory);
  const verifiedAt = new Date(now.getTime() + 1).toISOString();
  for (const id of ["molit-urban-rail-full-route-gwangju-membership", "gwangju-transportation-route-topology"]) {
    inventory.sources.find((source) => source.id === id).membershipAdmissionEvidence.verifiedAt = verifiedAt;
  }
  assert.doesNotThrow(() => invoke({ inventory }));
  for (const id of ["molit-urban-rail-full-route-gwangju-membership", "gwangju-transportation-route-topology"]) {
    inventory.sources.find((source) => source.id === id).membershipAdmissionEvidence.verifiedAt = "invalid";
  }
  assert.throws(() => invoke({ inventory }), /membership evidence is invalid/);
  assert.throws(() => invoke({ now: new Date(Date.parse(input.topologySnapshot.capturedAt) - 1) }), /future-dated/);
});

test("retained production Gwangju accepts a hash-bound three-station scope and rejects non-chain edges", async () => {
  const input = await retainedProductionInput();
  const rebind = (value) => {
    const topology = value.topologySnapshot;
    topology.scopeSha256 = digest(JSON.stringify(topology.scope));
    topology.edgesSha256 = digest(JSON.stringify(topology.edges));
    topology.contentSha256 = digest(JSON.stringify({ scope: topology.scope, edges: topology.edges }));
    const mappings = value.mappings.slice(0, 3);
    mappings.sourceRawSha256 = value.mappings.sourceRawSha256;
    value.mappings = mappings;
    const topologySource = value.inventory.sources.find(({ id }) => id === "gwangju-transportation-route-topology");
    const membershipSource = value.inventory.sources.find(({ id }) => id === "molit-urban-rail-full-route-gwangju-membership");
    const membership = membershipSource.membershipAdmissionEvidence;
    membership.stationCount = mappings.length;
    membership.mappingSha256 = digest(JSON.stringify(mappings));
    membership.stationCodesSha256 = digest(JSON.stringify(mappings.map(({ stationNumber }) => stationNumber)));
    membership.stationCodeContentSha256 = topology.contentSha256;
    topologySource.topologyAdmissionEvidence.stationCount = topology.stationCount;
    topologySource.topologyAdmissionEvidence.edgeCount = topology.edgeCount;
    topologySource.topologyAdmissionEvidence.contentSha256 = topology.contentSha256;
    topologySource.membershipAdmissionEvidence = structuredClone(membership);
    const schedule = value.inventory.sources.find(({ id }) => id === "kric-nationwide-timetable-file")
      .retainedScheduleAdmissionEvidence;
    schedule.topologyContentSha256 = topology.contentSha256;
  };
  const synthetic = structuredClone(input);
  synthetic.topologySnapshot.scope = synthetic.topologySnapshot.scope.slice(0, 3);
  const codes = new Set(synthetic.topologySnapshot.scope.map(({ stationCode }) => stationCode));
  synthetic.topologySnapshot.edges = synthetic.topologySnapshot.edges.filter(({ fromStationCode, toStationCode }) =>
    codes.has(fromStationCode) && codes.has(toStationCode));
  synthetic.topologySnapshot.requestCount = codes.size;
  synthetic.topologySnapshot.stationCount = codes.size;
  synthetic.topologySnapshot.odRowCount = codes.size * (codes.size - 1);
  synthetic.topologySnapshot.edgeCount = synthetic.topologySnapshot.edges.length;
  rebind(synthetic);
  assert.doesNotThrow(() => materializeGwangjuTimetable({
    ...synthetic, canonicalStationMappings: synthetic.mappings, now,
  }));
  for (const mutate of [
    (value) => { value.topologySnapshot.edges.pop(); value.topologySnapshot.edgeCount = value.topologySnapshot.edges.length; },
    (value) => { value.topologySnapshot.edges.push(structuredClone(value.topologySnapshot.edges[0])); value.topologySnapshot.edgeCount = value.topologySnapshot.edges.length; },
    (value) => { value.topologySnapshot.edges[0].toStationCode = value.topologySnapshot.scope.at(-1).stationCode; },
  ]) {
    const invalid = structuredClone(synthetic);
    mutate(invalid);
    rebind(invalid);
    assert.throws(() => materializeGwangjuTimetable({ ...invalid, canonicalStationMappings: invalid.mappings, now }),
      /invalid Gwangju topology edge|invalid Gwangju topology snapshot/);
  }
});

test("retained production Gwangju CLI serializes the native result and rejects the old input flag", async () => {
  const input = await retainedProductionInput();
  const directory = await mkdtemp(path.join(tmpdir(), "gwangju-retained-cli-"));
  try {
    const paths = Object.fromEntries(["base", "retained", "snapshots", "inventory", "invalid", "output"].map((name) => [name, path.join(directory, `${name}.json`)]));
    await writeFile(paths.base, JSON.stringify(input.baseFixture));
    const { observation, receipt, ...contract } = input.retainedTimetable;
    const observationBytes = Buffer.from(JSON.stringify(observation));
    await writeFile(paths.retained, observationBytes);
    const evidence = input.inventory.sources.find(({ id }) => id === "kric-nationwide-timetable-file").retainedScheduleAdmissionEvidence;
    await writeFile(paths.snapshots, JSON.stringify([{ sourceId: "kric-nationwide-timetable-file",
      snapshotId: evidence.snapshotId, contentSha256: evidence.observationIdentitySha256,
      rawObjectSha256: digest(observationBytes), retainedTimetableInputs: { contract, collectionReceipt: receipt } }]));
    await writeFile(paths.inventory, JSON.stringify(input.inventory));
    const argv = ["--base-fixture", paths.base, "--retained-observation", paths.retained, "--snapshots", paths.snapshots,
      "--inventory", paths.inventory, "--station-map", path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv"),
      "--output", paths.output];
    await runGwangjuTimetableMaterializer(argv, { now, repositoryRoot: root });
    const actual = JSON.parse(await readFile(paths.output, "utf8"));
    const expected = JSON.parse(JSON.stringify(materializeGwangjuTimetable({ ...input, canonicalStationMappings: input.mappings, now })));
    assert.deepEqual(actual, expected);
    const explicitTopology = [...argv.slice(0, 4), "--topology-snapshot",
      path.join(root, "tools/datapack/sources/gwangju-transportation-route-topology-20260720.json"), ...argv.slice(4)];
    await assert.rejects(() => runGwangjuTimetableMaterializer(explicitTopology, { now, repositoryRoot: root }), /usage:/);
    for (const snapshotPath of ["../gwangju-route-topology.json", "tools/datapack/sources/mismatched.json"]) {
      const inventory = structuredClone(input.inventory);
      inventory.sources.find(({ id }) => id === "gwangju-transportation-route-topology")
        .topologyAdmissionEvidence.snapshotPath = snapshotPath;
      await writeFile(paths.invalid, JSON.stringify(inventory));
      const invalidArgv = argv.map((value) => value === paths.inventory ? paths.invalid : value);
      await assert.rejects(() => runGwangjuTimetableMaterializer(invalidArgv, { now, repositoryRoot: root }), /topology snapshot path/);
    }
    assert.deepEqual(JSON.parse(await readFile(paths.output, "utf8")), expected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retained Gwangju transit tables preserve native identities, clocks, row order, and provenance", () => {
  const records = [
    retainedNativeRecord(1, "A", { arrivalTime: { value: "24:00:00" }, departureTime: { value: "24:00:30" } }),
    retainedNativeRecord(2, "B", { arrivalTime: { value: "24:00:30" }, departureTime: { value: "25:01:30" }, sourceRowSha256: "b".repeat(64) }),
    retainedNativeRecord(3, "A", { routeName: "other", arrivalTime: { value: "26:00:00" }, departureTime: { value: "26:00:00" } }),
    retainedNativeRecord(4, "B", { routeName: "other", arrivalTime: { value: "26:01:00" }, departureTime: { value: "26:01:10" } }),
  ];
  const projection = retainedProjection(records), before = structuredClone(projection);
  const tables = buildRetainedGwangjuTransitTables({ projection, lineId: "line-test",
    routeBindings: [{ originStationName: "A", destinationStationName: "B", routeId: "route-a", directionId: "up", tripHeadsign: "B", stationCodes: ["A", "B"] }],
    serviceIds: { WEEKDAY: "weekday" }, servicePatterns: { LOCAL: "LOCAL" }, serviceDayStartSeconds: 10,
    provenance: { sourceId: "source", sourceSnapshotId: "snapshot", evidenceHash: "e".repeat(64), updatedAt: "2040-01-01T00:00:00.000Z" } });
  assert.deepEqual(projection, before);
  assert.equal(tables.transitTrips.length, 2);
  assert.notEqual(tables.transitTrips[0].id, tables.transitTrips[1].id);
  assert.deepEqual(tables.transitStopTimes.map(({ stopSequence, arrivalSeconds, departureSeconds, pickupType, dropOffType }) =>
    ({ stopSequence, arrivalSeconds, departureSeconds, pickupType, dropOffType })), [
    { stopSequence: 1, arrivalSeconds: 86400, departureSeconds: 86430, pickupType: 0, dropOffType: 1 },
    { stopSequence: 2, arrivalSeconds: 86430, departureSeconds: 90090, pickupType: 1, dropOffType: 0 },
    { stopSequence: 1, arrivalSeconds: 93600, departureSeconds: 93600, pickupType: 0, dropOffType: 1 },
    { stopSequence: 2, arrivalSeconds: 93660, departureSeconds: 93670, pickupType: 1, dropOffType: 0 },
  ]);
  assert.equal(tables.transitStopTimes[0].providerRecordHash, records[0].sourceRowSha256);
  assert.equal(tables.transitStopTimes[1].providerRecordHash, records[1].sourceRowSha256);
  assert.equal(tables.transitTrips[0].providerRecordHash,
    createHash("sha256").update(JSON.stringify(records.slice(0, 2).map((row) => row.sourceRowSha256))).digest("hex"));
  assert.deepEqual(tables.transitStopTimes.slice(0, 2).map((row) => row.stationId), ["station-a", "station-b"]);
  assert.equal(tables.transitTrips[0].sourceSnapshotId, "snapshot");
});

test("retained Gwangju transit tables reject a missing route mapping", () => {
  const projection = retainedProjection([retainedNativeRecord(1, "A"), retainedNativeRecord(2, "B", {
    arrivalTime: { value: "24:01:00" }, departureTime: { value: "24:01:30" },
  })]);
  assert.throws(() => buildRetainedGwangjuTransitTables({ projection, lineId: "line", routeBindings: [],
    serviceIds: { WEEKDAY: "weekday" }, servicePatterns: { LOCAL: "LOCAL" }, serviceDayStartSeconds: 0,
    provenance: { sourceId: "source", sourceSnapshotId: "snapshot", evidenceHash: "e", updatedAt: "2040-01-01T00:00:00.000Z" } }), /mapping is missing/);
});

test("retained Gwangju transit tables bind identical endpoints by the directed native stop path", () => {
  const reverseEdges = [{ fromStationCode: "A", toStationCode: "B" }, { fromStationCode: "B", toStationCode: "A" }];
  const records = [
    retainedNativeRecord(1, "A"),
    retainedNativeRecord(2, "B", { arrivalTime: { value: "24:01:00" }, departureTime: { value: "24:01:00" } }),
    retainedNativeRecord(3, "B", { trainNumber: "1002", arrivalTime: { value: "25:00:00" }, departureTime: { value: "25:00:00" } }),
    retainedNativeRecord(4, "A", { trainNumber: "1002", arrivalTime: { value: "25:01:00" }, departureTime: { value: "25:01:00" } }),
  ];
  const projection = retainedProjection(records, { directedEdges: reverseEdges });
  const bindings = [
    { originStationName: "A", destinationStationName: "B", routeId: "route-forward", directionId: "forward", tripHeadsign: "B", stationCodes: ["A", "B"] },
    { originStationName: "A", destinationStationName: "B", routeId: "route-reverse", directionId: "reverse", tripHeadsign: "A", stationCodes: ["B", "A"] },
  ];
  const input = { projection, lineId: "line", routeBindings: bindings,
    serviceIds: { WEEKDAY: "weekday" }, servicePatterns: { LOCAL: "LOCAL" }, serviceDayStartSeconds: 0,
    provenance: { sourceId: "source", sourceSnapshotId: "snapshot", evidenceHash: "e", updatedAt: "2040-01-01T00:00:00.000Z" } };
  assert.deepEqual(buildRetainedGwangjuTransitTables(input).transitTrips.map(({ routeId, directionId }) =>
    ({ routeId, directionId })), [
    { routeId: "route-forward", directionId: "forward" },
    { routeId: "route-reverse", directionId: "reverse" },
  ]);
  assert.throws(() => buildRetainedGwangjuTransitTables({ ...input, routeBindings: [bindings[0]] }), /mapping is missing/);
  assert.throws(() => buildRetainedGwangjuTransitTables({ ...input, routeBindings: [...bindings,
    { ...bindings[0], routeId: "route-ambiguous" }] }), /route binding is ambiguous/);
  assert.throws(() => buildRetainedGwangjuTransitTables({ ...input, routeBindings: [{ ...bindings[0], stationCodes: ["A", "C"] }] }), /mapping is missing/);
});

test("retained native trip projection은 source 행 순서와 24시 이후 시각·원문 근거를 보존한다", () => {
  const first = [
    retainedNativeRecord(1, "외부", { arrivalTime: { value: "24:00:00" }, departureTime: { value: "24:00:00" } }),
    retainedNativeRecord(2, "A", { arrivalTime: { value: "24:01:00" }, departureTime: { value: "24:01:30" } }),
    retainedNativeRecord(3, "B", { arrivalTime: { value: "24:02:00" }, departureTime: { value: "24:02:00" } }),
  ];
  const second = [
    retainedNativeRecord(4, "A", {
      trainNumber: "1002", weekdayType: "SATURDAY", arrivalTime: { value: "25:00:00" }, departureTime: { value: "25:00:30" },
    }),
    retainedNativeRecord(5, "B", {
      trainNumber: "1002", weekdayType: "SATURDAY", arrivalTime: { value: "25:01:00" }, departureTime: { value: "25:01:00" },
    }),
  ];

  const projected = retainedProjection([second[1], first[2], second[0], first[0], first[1]]);

  assert.deepEqual(projected.trips.map(({ identity }) => [identity.trainNumber, identity.weekdayType]), [
    ["1001", "WEEKDAY"], ["1002", "SATURDAY"],
  ]);
  assert.deepEqual(projected.trips[0].stops.map(({ sourceRowNumber, stationCode, arrival, departure }) => ({
    sourceRowNumber, stationCode, arrival, departure,
  })), [
    { sourceRowNumber: 2, stationCode: "A", arrival: { value: "24:01:00", seconds: 86_460 }, departure: { value: "24:01:30", seconds: 86_490 } },
    { sourceRowNumber: 3, stationCode: "B", arrival: { value: "24:02:00", seconds: 86_520 }, departure: { value: "24:02:00", seconds: 86_520 } },
  ]);
  assert.equal(projected.trips[0].excludedEndpoints.length, 1);
  assert.equal(projected.trips[0].excludedEndpoints[0].record.stationName, "외부");
  assert.equal(projected.trips[0].stops.some(({ stationId }) => stationId === "station-외부"), false);
  assert.deepEqual(projected.trips[0].stops[0].record, first[1]);
  assert.equal(projected.nonRoutableGroups.length, 0);
  assert.equal(JSON.stringify(projected).includes("tripId"), false);
  assert.equal(JSON.stringify(projected).includes("freshUntil"), false);
});

test("retained native trip projection은 binding·edge·순서 계약 위반을 거부한다", () => {
  const records = [
    retainedNativeRecord(1, "A"),
    retainedNativeRecord(2, "B", { arrivalTime: { value: "24:01:00" }, departureTime: { value: "24:01:00" } }),
  ];
  const cases = [
    ["ambiguous exclusion", () => retainedProjection(records, { excludedEndpointLabels: ["A"] }), /classification is ambiguous/],
    ["unknown", () => retainedProjection([{ ...records[0], stationName: "UNKNOWN" }, records[1]]), /station binding is missing/],
    ["edge", () => retainedProjection(records, { directedEdges: [] }), /directed edge is missing/],
    ["interior exclusion", () => retainedProjection([
      records[0], retainedNativeRecord(2, "외부", { arrivalTime: { value: "24:00:40" }, departureTime: { value: "24:00:40" } }),
      { ...records[1], sourceRowNumber: 3 },
    ]), /endpoint exclusion is interior/],
    ["time", () => retainedProjection([
      { ...records[0], departureTime: { value: "25:00:00" } }, records[1],
    ]), /time order is invalid/],
    ["duplicate", () => retainedProjection([{ ...records[0] }, { ...records[1], stationName: "A" }]), /station repeats/],
    ["discontiguous", () => retainedProjection([
      records[0], retainedNativeRecord(2, "A", { trainNumber: "1002" }),
      { ...records[1], sourceRowNumber: 3 },
    ]), /group is discontiguous/],
    ["ambiguous bindings", () => retainedProjection(records, {
      stationBindings: [...retainedBindings, { sourceLabel: "A", stationId: "station-other", stationCode: "C" }],
    }), /station bindings are ambiguous/],
  ];
  for (const [name, invoke, pattern] of cases) assert.throws(invoke, pattern, name);
});

test("retained native trip projection은 한 승객 정류장 그룹을 비운행 근거로 보존한다", () => {
  const projected = retainedProjection([
    retainedNativeRecord(1, "외부"),
    retainedNativeRecord(2, "A", { arrivalTime: { value: "24:01:00" }, departureTime: { value: "24:01:00" } }),
  ]);

  assert.equal(projected.trips.length, 0);
  assert.equal(projected.nonRoutableGroups.length, 1);
  assert.equal(projected.nonRoutableGroups[0].reason, "PASSENGER_STOP_COUNT_LT_2");
  assert.deepEqual(projected.nonRoutableGroups[0].records.map(({ sourceRowNumber }) => sourceRowNumber), [1, 2]);
  assert.equal(projected.nonRoutableGroups[0].excludedEndpoints[0].record.stationName, "외부");
});

// 기존 경계 검증을 제거하기 전에 FILE 입력의 실제 직렬화·출처·coverage를 증명한다.
test("retained Gwangju SQLite preserves native stops, provenance, and coverage", async (context) => {
  const input = await retainedProductionInput();
  const baseFixture = projectRegionalMaterializeFixture(
    await readJson("tools/datapack/release/capital-production-reviewed-pack.json"));
  const fixture = materializeGwangjuTimetable({ ...input, baseFixture,
    canonicalStationMappings: input.mappings, now });
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-gwangju-retained-sqlite-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const fixturePath = path.join(directory, "fixture.json");
  const inventoryPath = path.join(directory, "inventory.json");
  const packOutput = path.join(directory, "pack");
  const reportPath = path.join(directory, "coverage.json");
  await writeFile(fixturePath, JSON.stringify(fixture));
  await writeFile(inventoryPath, JSON.stringify(input.inventory));
  await mkdir(packOutput);
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await execFileAsync(process.execPath, ["tools/datapack/build-datapack.mjs",
    "--fixture", fixturePath, "--output", packOutput],
  { cwd: root, env: { ...process.env, EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKey } });
  await materializeRegionalProductionCandidate({ outputDir: packOutput, privateKey });
  const manifestPath = path.join(packOutput, "current.json");
  const provenancePath = path.join(packOutput, "current.provenance.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const sqlitePath = path.join(packOutput,
    new URL(manifest.packs[0].url).pathname.split("/").slice(-2).join("/")).replace(/\.gz$/, "");
  const sourceId = input.retainedTimetable.observation.sourceId;
  const expectedTrips = fixture.packs[0].transitTrips.filter((trip) => trip.sourceId === sourceId);
  const tripIds = new Set(expectedTrips.map((trip) => trip.id));
  const expectedStops = fixture.packs[0].transitStopTimes.filter((stop) => tripIds.has(stop.tripId));
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM network_edges WHERE source_id = ?")
      .get("gwangju-transportation-route-topology").count, input.topologySnapshot.edges.length);
    const lineId = input.inventory.sources.find(({ id }) => id === sourceId).coverageScope.lineIds[0];
    const trips = database.prepare(`SELECT t.id FROM transit_trips t
      JOIN transit_routes r ON r.id = t.route_id WHERE r.line_id = ? ORDER BY t.id`).all(lineId);
    assert.deepEqual(trips.map(({ id }) => id), [...tripIds].sort());
    const stops = database.prepare(`SELECT st.trip_id, st.station_id, st.stop_sequence,
      st.arrival_seconds, st.departure_seconds FROM transit_stop_times st
      JOIN transit_trips t ON t.id = st.trip_id
      JOIN transit_routes r ON r.id = t.route_id WHERE r.line_id = ?
      ORDER BY st.trip_id, st.stop_sequence`).all(lineId);
    assert.deepEqual(stops.map((row) => ({ ...row })), expectedStops.map((stop) => ({
      trip_id: stop.tripId, station_id: stop.stationId, stop_sequence: stop.stopSequence,
      arrival_seconds: stop.arrivalSeconds, departure_seconds: stop.departureSeconds,
    })).sort((a, b) => a.trip_id.localeCompare(b.trip_id) || a.stop_sequence - b.stop_sequence));
  } finally {
    database.close();
  }
  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  const records = provenance.packs.flatMap(({ records }) => records);
  for (const field of ["trip", "stop_time", "service_calendar"]) {
    assert.ok(records.some((record) => record.sourceId === sourceId && record.field === field));
  }
  assert.ok(records.some((record) => record.sourceId === "gwangju-transportation-route-topology"
    && record.field === "network_edges"));
  await execFileAsync(process.execPath, ["tools/datapack/report-coverage-gaps.mjs",
    "--targets", "tools/datapack/nationwide-coverage-targets.json",
    "--inventory", inventoryPath, "--manifest", manifestPath, "--provenance", provenancePath,
    "--resolution-plan", "tools/datapack/release/nationwide-public-api-coverage-search-plan-20260725.json",
    "--resolutions", "tools/datapack/release/nationwide-public-api-coverage-resolutions-20260725.json",
    "--output", reportPath, "--allow-gaps"], { cwd: root });
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const requirements = report.requirements.filter(({ regionId, operatorId, lineId }) =>
    regionId === "gwangju" && operatorId === "gwangju-metropolitan-rapid-transit"
    && lineId === "line-e57a361e8892");
  assert.deepEqual(requirements.filter(({ status }) => status === "SUPPORTED")
    .map(({ sourceDomain }) => sourceDomain),
  ["station_line_membership", "route_graph_topology", "schedule_timetable"]);
  const membership = requirements.find(({ sourceDomain }) => sourceDomain === "station_line_membership");
  assert.deepEqual(Object.fromEntries(membership.fieldCoverage.map(({ field, sourceIds }) => [field, sourceIds])), {
    line: ["molit-urban-rail-full-route-gwangju-membership"],
    station_name: ["molit-urban-rail-full-route-gwangju-membership"],
    station_code: ["gwangju-transportation-route-topology"],
  });
  const schedule = requirements.find(({ sourceDomain }) => sourceDomain === "schedule_timetable");
  assert.ok(schedule.fieldCoverage.length > 0);
  for (const { sourceIds } of schedule.fieldCoverage) assert.deepEqual(sourceIds, [sourceId]);
});

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}
