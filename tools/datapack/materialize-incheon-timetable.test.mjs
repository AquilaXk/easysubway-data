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

import {
  parseMolitDaejeonStationMappings,
  parseMolitGwangjuStationMappings,
} from "./build-molit-nationwide-fixture.mjs";
import { materializeBusanRouteMapPositions } from "./materialize-busan-route-map-positions.mjs";
import {
  materializeBusanRouteTopology,
  parseCanonicalBusanStationMappings,
} from "./materialize-busan-route-topology.mjs";
import { materializeBusanTimetable } from "./materialize-busan-timetable.mjs";
import { materializeDaejeonTimetable } from "./materialize-daejeon-timetable.mjs";
import { materializeGwangjuAccessibility } from "./materialize-gwangju-accessibility.mjs";
import { materializeGwangjuTimetable } from "./materialize-gwangju-timetable.mjs";
import { materializeIncheonAccessibility } from "./materialize-incheon-accessibility.mjs";
import { materializeIncheonStationInfo } from "./materialize-incheon-station-info.mjs";
import {
  materializeIncheonTimetable,
  materializedIncheonTimetablePackContentHash,
} from "./materialize-incheon-timetable.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
process.env.EASYSUBWAY_DATAPACK_PRODUCTION_FIXTURE_VALIDATION_ONLY = "true";
const topologyNow = new Date("2026-07-19T18:14:03.004Z");
const timetableNow = new Date("2026-07-20T13:09:00.000Z");
const gwangjuAccessibilityNow = new Date("2026-07-24T03:00:00.000Z");
const OPERATOR_ID = "incheon-transit";
const LINE1 = "line-98718184f016";
const LINE2 = "line-42b5805f3b5a";
const LINE7 = "line-15b3b8a93259";
// accessibility 누적 fixture coverage baseline(실측): supportedCount=34 → timetable +2 = 36.
const ACCESSIBILITY_SUPPORTED_COUNT = 34;
const TIMETABLE_SUPPORTED_COUNT = ACCESSIBILITY_SUPPORTED_COUNT + 2;

async function inputs({ materializeIncheon = true } = {}) {
  const currentInventory = await readJson("tools/datapack/source-inventory.json");
  const matches = currentInventory.sources.filter(({ id }) => id === "incheon-transit-station-info");
  if (matches.length !== 1) throw new Error("current Incheon source identity is invalid");
  const admission = matches[0].topologyAdmissionEvidence;
  if (admission?.snapshotPath !== `tools/datapack/sources/${admission?.snapshotId}.json`
    || !Number.isFinite(Date.parse(admission?.capturedAt))) throw new Error("current Incheon topology admission is invalid");
  const accessibilityMatches = currentInventory.sources.filter(({ id }) => id === "incheon-transit-accessibility");
  if (accessibilityMatches.length !== 1) throw new Error("current Incheon accessibility source identity is invalid");
  const accessibilityAdmission = accessibilityMatches[0].accessibilityAdmissionEvidence;
  if (accessibilityAdmission?.snapshotPath
      !== `tools/datapack/sources/${accessibilityAdmission?.snapshotId}.json`
    || !Number.isFinite(Date.parse(accessibilityAdmission?.capturedAt))) {
    throw new Error("current Incheon accessibility admission is invalid");
  }
  const timetableAdmissions = [1, 2].map((lineNumber) => {
    const sourceId = `incheon-line${lineNumber}-train-timetable`;
    const sourceMatches = currentInventory.sources.filter(({ id }) => id === sourceId);
    if (sourceMatches.length !== 1) {
      throw new Error(`current Incheon line ${lineNumber} timetable source identity is invalid`);
    }
    const evidence = sourceMatches[0].scheduleAdmissionEvidence;
    if (evidence?.snapshotPath !== `tools/datapack/sources/${evidence?.snapshotId}.json`
      || !Number.isFinite(Date.parse(evidence?.capturedAt))) {
      throw new Error(`current Incheon line ${lineNumber} timetable admission is invalid`);
    }
    return evidence;
  });
  const timetableVersion = timetableAdmissions[0].snapshotId.slice(-8);
  if (timetableAdmissions.some(({ snapshotId }) => !snapshotId.endsWith(timetableVersion))) {
    throw new Error("current Incheon timetable versions do not match");
  }
  const [
    baseFixture,
    busanTopology,
    busanTimetable,
    busanRouteMapBytes,
    daejeonTopology,
    daejeonTimetable,
    gwangjuTopology,
    gwangjuTimetable,
    gwangjuAccessibilitySnapshot,
    incheonBytes,
    accessibilitySnapshot,
    line1Timetable,
    line2Timetable,
    inventory,
    stationMapCsv,
    molitStationMapCsv,
  ] = await Promise.all([
    readJson("tools/datapack/release/capital-production-reviewed-pack.json").then(projectRegionalMaterializeFixture),
    readJson("tools/datapack/sources/busan-transportation-route-topology-20260720.json"),
    readJson("tools/datapack/sources/busan-transportation-timetable-20260720.json"),
    readFile(path.join(root, "tools/datapack/sources/busan-transportation-route-map-positions-20260720.json")),
    readJson("tools/datapack/sources/daejeon-route-topology-20260720.json"),
    readJson("tools/datapack/sources/daejeon-train-timetable-20260720.json"),
    readJson("tools/datapack/sources/gwangju-transportation-route-topology-20260720.json"),
    readJson("tools/datapack/sources/gwangju-transportation-cyberstation-timetable-20260720.json"),
    readJson("tools/datapack/sources/gwangju-transportation-accessibility-20260724.json"),
    readFile(path.join(root, admission.snapshotPath)),
    readJson(accessibilityAdmission.snapshotPath),
    readJson(timetableAdmissions[0].snapshotPath),
    readJson(timetableAdmissions[1].snapshotPath),
    Promise.resolve(projectHistoricalRegionalMaterializeInventory(currentInventory)),
    readFile(path.join(root, "tools/datapack/sources/regional-official-svg-route-map-coordinates-20260624.csv"), "utf8"),
    readFile(path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv")),
  ]);
  const busanTopologyFixture = materializeBusanRouteTopology({
    baseFixture,
    snapshot: busanTopology,
    inventory,
    canonicalStationMappings: parseCanonicalBusanStationMappings(stationMapCsv),
    now: topologyNow,
  });
  const daejeonFixture = materializeDaejeonTimetable({
    baseFixture: busanTopologyFixture,
    timetableSnapshot: daejeonTimetable,
    topologySnapshot: daejeonTopology,
    inventory,
    canonicalStationMappings: parseMolitDaejeonStationMappings(molitStationMapCsv),
    now: timetableNow,
  });
  const busanTimetableFixture = materializeBusanTimetable({
    baseFixture: daejeonFixture,
    timetableSnapshot: busanTimetable,
    topologySnapshot: busanTopology,
    inventory,
    now: timetableNow,
  });
  const routeMapFixture = materializeBusanRouteMapPositions({
    baseFixture: busanTimetableFixture,
    snapshot: JSON.parse(busanRouteMapBytes),
    snapshotSha256: createHash("sha256").update(busanRouteMapBytes).digest("hex"),
    topologySnapshot: busanTopology,
    inventory,
    now: timetableNow,
  });
  const gwangjuFixture = materializeGwangjuTimetable({
    baseFixture: routeMapFixture,
    timetableSnapshot: gwangjuTimetable,
    topologySnapshot: gwangjuTopology,
    inventory,
    canonicalStationMappings: parseMolitGwangjuStationMappings(molitStationMapCsv),
    now: timetableNow,
  });
  const gwangjuAccessibilityFixture = materializeGwangjuAccessibility({
    baseFixture: gwangjuFixture,
    accessibilitySnapshot: gwangjuAccessibilitySnapshot,
    topologySnapshot: gwangjuTopology,
    inventory,
    now: gwangjuAccessibilityNow,
  });
  const incheonSnapshot = JSON.parse(incheonBytes.toString("utf8"));
  const incheonFixture = materializeIncheon
    ? materializeIncheonStationInfo({
      baseFixture: gwangjuAccessibilityFixture,
      snapshot: incheonSnapshot,
      snapshotSha256: createHash("sha256").update(incheonBytes).digest("hex"),
      inventory,
      now: new Date(incheonSnapshot.capturedAt),
    })
    : null;
  const accessibilityFixture = materializeIncheon
    ? materializeIncheonAccessibility({
      baseFixture: incheonFixture,
      accessibilitySnapshot,
      topologySnapshot: { ...incheonSnapshot, snapshotId: admission.snapshotId },
      inventory,
      now: new Date(accessibilitySnapshot.capturedAt),
    })
    : null;
  return {
    regionalFixture: gwangjuAccessibilityFixture,
    accessibilityFixture,
    accessibilitySnapshot,
    topologySnapshot: { ...incheonSnapshot, snapshotId: admission.snapshotId },
    timetableSnapshots: { 1: line1Timetable, 2: line2Timetable },
    timetableNow: new Date(Math.max(...timetableAdmissions.map(({ capturedAt }) => Date.parse(capturedAt)))),
    timetableVersion,
    inventory,
  };
}

function suppliedCurrentTopology(values) {
  const snapshot = structuredClone(values.topologySnapshot);
  snapshot.capturedAt = "2026-08-28T03:47:35.000Z";
  snapshot.freshUntil = "2026-08-29T03:47:35.000Z";
  snapshot.snapshotId = "incheon-transit-station-info-20260828";
  for (const entry of [...snapshot.scope, ...snapshot.positions]) {
    if (entry.lineId === LINE2 && entry.stationCode === "3210") entry.stationName = "서해구청";
  }
  snapshot.scope.find(({ lineId, stationCode }) => lineId === LINE2 && stationCode === "3210").nameEn = "Seohae-gu Office";
  snapshot.scopeSha256 = createHash("sha256").update(JSON.stringify(snapshot.scope)).digest("hex");
  snapshot.positionsSha256 = createHash("sha256").update(JSON.stringify(snapshot.positions)).digest("hex");
  snapshot.contentSha256 = createHash("sha256").update(JSON.stringify({
    scope: snapshot.scope, edges: snapshot.edges, positions: snapshot.positions,
  })).digest("hex");
  return snapshot;
}

function rebindSuppliedTopologyInventory(inventory, snapshot) {
  const next = structuredClone(inventory);
  const stationInfo = next.sources.find(({ id }) => id === "incheon-transit-station-info");
  const topology = stationInfo.topologyAdmissionEvidence;
  const membership = stationInfo.membershipAdmissionEvidence;
  const routeMap = stationInfo.routeMapAdmissionEvidence;
  const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot)}\n`);
  Object.assign(topology, {
    snapshotId: snapshot.snapshotId,
    snapshotPath: `tools/datapack/sources/${snapshot.snapshotId}.json`,
    capturedAt: snapshot.capturedAt,
    freshUntil: snapshot.freshUntil,
    contentSha256: snapshot.contentSha256,
  });
  Object.assign(membership, {
    snapshotId: snapshot.snapshotId,
    verifiedAt: snapshot.capturedAt,
    membershipSourceSnapshotSha256: snapshot.scopeSha256,
    mappingSha256: createHash("sha256").update(JSON.stringify(snapshot.scope.map((station) => ({
      stationId: station.stationId, lineId: station.lineId, stationCode: station.stationCode,
      stationName: station.stationName,
    })))).digest("hex"),
    stationCodeContentSha256: snapshot.contentSha256,
    stationCodeSnapshotId: snapshot.snapshotId,
  });
  Object.assign(routeMap, {
    snapshotId: snapshot.snapshotId,
    snapshotPath: topology.snapshotPath,
    snapshotSha256: createHash("sha256").update(snapshotBytes).digest("hex"),
    capturedAt: snapshot.capturedAt,
    freshUntil: "2027-08-28T03:47:35.000Z",
    positionsSha256: snapshot.positionsSha256,
    topologySnapshotId: snapshot.snapshotId,
    topologyContentSha256: snapshot.contentSha256,
  });
  for (const sourceId of ["incheon-transit-accessibility", "incheon-line1-train-timetable", "incheon-line2-train-timetable"]) {
    const evidence = next.sources.find(({ id }) => id === sourceId)[sourceId === "incheon-transit-accessibility"
      ? "accessibilityAdmissionEvidence" : "scheduleAdmissionEvidence"];
    evidence.topologySnapshotId = snapshot.snapshotId;
    evidence.topologyContentSha256 = snapshot.contentSha256;
    if (evidence.topologyLineages) evidence.topologyLineages = evidence.topologyLineages.map((lineage) => ({
      ...lineage, snapshotId: snapshot.snapshotId, contentSha256: snapshot.contentSha256,
    }));
    if (evidence.membershipLineages) evidence.membershipLineages = evidence.membershipLineages.map((lineage) => ({
      ...lineage, snapshotId: snapshot.snapshotId, contentSha256: snapshot.contentSha256,
    }));
  }
  return next;
}

test("인천 1·2호선 공식 timetable을 1414 trip·40898 stop_time·WEEK/HOLI calendar로 materialize한다", async () => {
  const values = await inputs();
  const fixture = materializeIncheonTimetable({
    baseFixture: values.accessibilityFixture,
    topologySnapshot: values.topologySnapshot,
    timetableSnapshots: values.timetableSnapshots,
    inventory: values.inventory,
    now: values.timetableNow,
  });
  const pack = fixture.packs[0];
  const trips = pack.transitTrips.filter(({ id }) => id.startsWith("trip-incheon-"));
  const stopTimes = pack.transitStopTimes.filter(({ tripId }) => tripId.startsWith("trip-incheon-"));
  const calendars = pack.serviceCalendars.filter(({ serviceId }) => serviceId.startsWith("incheon-line"));
  const routes = pack.transitRoutes.filter(({ id }) => id.startsWith("route-incheon-"));

  assert.match(pack.id, /^nationwide-incheon-schedule-[a-f0-9]{64}$/);
  assert.equal(pack.version, values.timetableVersion);
  assert.deepEqual(fixture.manifest.activePack, { id: pack.id, version: values.timetableVersion });
  assert.equal(trips.length, 1_414);
  assert.equal(stopTimes.length, 40_898);
  assert.equal(calendars.length, 4);
  assert.equal(routes.length, 4);
  assert.equal(stopTimes.every(({ derivationKind }) => derivationKind === "OFFICIAL"), true);
  assert.deepEqual(Object.fromEntries(calendars.map(({ serviceId }) => [
    serviceId,
    trips.filter((trip) => trip.serviceId === serviceId).length,
  ])), {
    "incheon-line1-weekday-2026": 312,
    "incheon-line1-holiday-2026": 262,
    "incheon-line2-weekday-2026": 468,
    "incheon-line2-holiday-2026": 372,
  });
  // HOLI calendar는 토요일에 휴일 시각표를 재사용한다(토요일 FILE 없음 → 발명 금지).
  assert.ok(calendars.every((calendar) => (
    calendar.serviceId.endsWith("-weekday-2026")
      ? calendar.saturday === false && calendar.sunday === false
      : calendar.saturday === true && calendar.sunday === true
  )));
  assert.ok(!pack.sourceInventory.some(({ id }) => id.includes("line7") || id.includes("line7-train")));
  assert.ok(!trips.some(({ id }) => id.includes("line7")));
  // line-15 membership/positions는 station-info(#2490)가 소유. timetable은 1·2호선만.
  assert.ok(pack.lines.some(({ id }) => id === LINE7));
  assert.ok(!pack.sourceInventory.some(({ id }) => id.includes("line7-train-timetable")));
  assert.match(materializedIncheonTimetablePackContentHash(pack, pack.version), /^[a-f0-9]{64}$/);

  const maxArrival = Math.max(...stopTimes.map(({ arrivalSeconds }) => arrivalSeconds));
  assert.ok(maxArrival > 86_400, `expected a post-midnight trip, got max ${maxArrival}`);
});

test("인천 timetable materializer는 snapshot·inventory·freshness·topology lineage 변조를 fail-closed한다", async () => {
  const values = await inputs();

  assert.throws(() => materializeIncheonTimetable({
    baseFixture: values.accessibilityFixture,
    topologySnapshot: values.topologySnapshot,
    timetableSnapshots: values.timetableSnapshots,
    inventory: values.inventory,
    now: new Date(Date.parse(values.timetableSnapshots[1].freshUntil) + 1),
  }), /freshness/);

  const badHash = structuredClone(values.timetableSnapshots);
  badHash[1] = { ...badHash[1], contentSha256: "0".repeat(64) };
  assert.throws(() => materializeIncheonTimetable({
    baseFixture: values.accessibilityFixture,
    topologySnapshot: values.topologySnapshot,
    timetableSnapshots: badHash,
    inventory: values.inventory,
    now: values.timetableNow,
  }), /timetable snapshot/);

  const mismatchedInventory = structuredClone(values.inventory);
  mismatchedInventory.sources.find(({ id }) => id === "incheon-line1-train-timetable")
    .scheduleAdmissionEvidence.tripsSha256 = "0".repeat(64);
  assert.throws(() => materializeIncheonTimetable({
    baseFixture: values.accessibilityFixture,
    topologySnapshot: values.topologySnapshot,
    timetableSnapshots: values.timetableSnapshots,
    inventory: mismatchedInventory,
    now: values.timetableNow,
  }), /inventory evidence/);

  const badLineage = structuredClone(values.inventory);
  badLineage.sources.find(({ id }) => id === "incheon-line1-train-timetable")
    .scheduleAdmissionEvidence.topologyContentSha256 = "0".repeat(64);
  assert.throws(() => materializeIncheonTimetable({
    baseFixture: values.accessibilityFixture,
    topologySnapshot: values.topologySnapshot,
    timetableSnapshots: values.timetableSnapshots,
    inventory: badLineage,
    now: values.timetableNow,
  }), /inventory evidence|topology lineage/);

  const badActiveTopology = {
    ...values.topologySnapshot,
    snapshotId: "incheon-transit-station-info-20260724",
  };
  assert.throws(() => materializeIncheonTimetable({
    baseFixture: values.accessibilityFixture,
    topologySnapshot: badActiveTopology,
    timetableSnapshots: values.timetableSnapshots,
    inventory: values.inventory,
    now: values.timetableNow,
  }), /active topology identity/);

  const admitted = materializeIncheonTimetable({
    baseFixture: values.accessibilityFixture,
    topologySnapshot: values.topologySnapshot,
    timetableSnapshots: values.timetableSnapshots,
    inventory: values.inventory,
    now: values.timetableNow,
  });
  assert.throws(() => materializeIncheonTimetable({
    baseFixture: admitted,
    topologySnapshot: values.topologySnapshot,
    timetableSnapshots: values.timetableSnapshots,
    inventory: values.inventory,
    now: values.timetableNow,
  }), /already exists/);
});

test("인천 timetable materializer는 supplied current topology rename lineage만 admit한다", async () => {
  const values = await inputs({ materializeIncheon: false });
  const topologySnapshot = suppliedCurrentTopology(values);
  const inventory = rebindSuppliedTopologyInventory(values.inventory, topologySnapshot);
  const topologyBytes = Buffer.from(`${JSON.stringify(topologySnapshot)}\n`);
  const incheonFixture = materializeIncheonStationInfo({
    baseFixture: values.regionalFixture,
    snapshot: topologySnapshot,
    snapshotSha256: createHash("sha256").update(topologyBytes).digest("hex"),
    inventory,
    now: new Date("2026-08-28T04:00:00.000Z"),
  });
  const accessibilitySnapshot = structuredClone(values.accessibilitySnapshot);
  for (const lineage of [...accessibilitySnapshot.topologyLineages, ...accessibilitySnapshot.membershipLineages]) {
    lineage.snapshotId = topologySnapshot.snapshotId;
    lineage.contentSha256 = topologySnapshot.contentSha256;
  }
  const accessibilityFixture = materializeIncheonAccessibility({
    baseFixture: incheonFixture,
    accessibilitySnapshot,
    topologySnapshot,
    inventory,
    now: new Date(accessibilitySnapshot.capturedAt),
  });
  const timetableSnapshots = structuredClone(values.timetableSnapshots);
  for (const snapshot of Object.values(timetableSnapshots)) {
    snapshot.topologySnapshotId = topologySnapshot.snapshotId;
    snapshot.topologyContentSha256 = topologySnapshot.contentSha256;
    snapshot.topologyLineages[0].snapshotId = topologySnapshot.snapshotId;
    snapshot.topologyLineages[0].contentSha256 = topologySnapshot.contentSha256;
  }
  const admitted = materializeIncheonTimetable({
    baseFixture: accessibilityFixture,
    topologySnapshot,
    timetableSnapshots,
    inventory,
    now: values.timetableNow,
  });
  assert.equal(admitted.packs[0].transitTrips.filter(({ id }) => id.startsWith("trip-incheon-")).length, 1_414);

  const predecessor = structuredClone(timetableSnapshots);
  predecessor[2].topologyLineages[0].snapshotId = topologySnapshot.snapshotId.replace(
    /\d$/u,
    (digit) => digit === "0" ? "1" : "0",
  );
  assert.throws(() => materializeIncheonTimetable({
    baseFixture: accessibilityFixture,
    topologySnapshot,
    timetableSnapshots: predecessor,
    inventory,
    now: values.timetableNow,
  }), /invalid Incheon line 2 timetable snapshot/);
});

test("materialized SQLite와 provenance가 인천 schedule_timetable 2건을 SUPPORTED로 만든다", async (context) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-incheon-timetable-pack-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  const fixturePath = path.join(outputDir, "fixture.json");
  const packOutput = path.join(outputDir, "pack");
  const reportPath = path.join(outputDir, "coverage.json");
  const values = await inputs();
  const fixture = materializeIncheonTimetable({
    baseFixture: values.accessibilityFixture,
    topologySnapshot: values.topologySnapshot,
    timetableSnapshots: values.timetableSnapshots,
    inventory: values.inventory,
    now: values.timetableNow,
  });
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  await mkdir(packOutput, { recursive: true });

  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await execFileAsync(process.execPath, [
    "tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", packOutput,
  ], { cwd: root, env: { ...process.env, EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKey } });
  await materializeRegionalProductionCandidate({ outputDir: packOutput, privateKey });

  const manifestPath = path.join(packOutput, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const sqlitePath = path.join(
    packOutput,
    new URL(manifest.packs[0].url).pathname.split("/").slice(-2).join("/"),
  ).replace(/\.gz$/, "");
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM transit_trips WHERE id LIKE 'trip-incheon-%'
  `).get().count, 1_414);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM transit_stop_times WHERE trip_id LIKE 'trip-incheon-%'
  `).get().count, 40_898);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM service_calendars WHERE service_id LIKE 'incheon-line%'
  `).get().count, 4);
  const byLineDay = database.prepare(`
    SELECT service_id AS serviceId, COUNT(*) AS count
    FROM transit_trips
    WHERE id LIKE 'trip-incheon-%'
    GROUP BY service_id
    ORDER BY service_id
  `).all();
  assert.deepEqual(Object.fromEntries(byLineDay.map(({ serviceId, count }) => [serviceId, count])), {
    "incheon-line1-holiday-2026": 262,
    "incheon-line1-weekday-2026": 312,
    "incheon-line2-holiday-2026": 372,
    "incheon-line2-weekday-2026": 468,
  });
  database.close();

  await execFileAsync(process.execPath, [
    "tools/datapack/report-coverage-gaps.mjs",
    "--targets", "tools/datapack/nationwide-coverage-targets.json",
    "--inventory", "tools/datapack/source-inventory.json",
    "--manifest", manifestPath,
    "--provenance", path.join(packOutput, "current.provenance.json"),
    "--resolution-plan", "tools/datapack/release/nationwide-public-api-coverage-search-plan-20260725.json",
    "--resolutions", "tools/datapack/release/nationwide-public-api-coverage-resolutions-20260725.json",
    "--output", reportPath,
    "--allow-gaps",
  ], { cwd: root });
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const scheduleRequirements = report.requirements.filter(
    ({ operatorId, sourceDomain, lineId }) => operatorId === OPERATOR_ID
      && sourceDomain === "schedule_timetable"
      && [LINE1, LINE2].includes(lineId),
  );
  assert.equal(scheduleRequirements.length, 2);
  assert.ok(scheduleRequirements.every(({ status }) => status === "SUPPORTED"));
  assert.deepEqual(
    scheduleRequirements.map(({ lineId }) => lineId).sort(),
    [LINE2, LINE1].sort(),
  );
  const line7 = report.requirements.find(
    ({ operatorId, sourceDomain, lineId }) => operatorId === OPERATOR_ID
      && sourceDomain === "schedule_timetable"
      && lineId === LINE7,
  );
  assert.ok(line7);
  assert.notEqual(line7.status, "SUPPORTED");
  assert.deepEqual(report.summary.launchRequired, {
    totalCount: 270,
    supportedCount: TIMETABLE_SUPPORTED_COUNT,
    explicitlyUnsupportedCount: 4,
    missingCount: 270 - TIMETABLE_SUPPORTED_COUNT - 4,
    supportedRatio: Number((TIMETABLE_SUPPORTED_COUNT / 270).toFixed(4)),
    terminalResolutionRatio: Number(((TIMETABLE_SUPPORTED_COUNT + 4) / 270).toFixed(4)),
    completionReady: false,
  });
});

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}
