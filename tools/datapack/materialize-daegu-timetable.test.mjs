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
  parseMolitDaeguStationMappings,
  parseMolitDaejeonStationMappings,
  parseMolitGwangjuStationMappings,
} from "./build-molit-nationwide-fixture.mjs";
import { DAEGU_LINES } from "./collect-daegu-datapack-sources.mjs";
import { materializeBusanRouteMapPositions } from "./materialize-busan-route-map-positions.mjs";
import { materializeBusanRouteTopology, parseCanonicalBusanStationMappings } from "./materialize-busan-route-topology.mjs";
import { materializeBusanTimetable } from "./materialize-busan-timetable.mjs";
import { materializeDaejeonTimetable } from "./materialize-daejeon-timetable.mjs";
import { materializeGwangjuTimetable } from "./materialize-gwangju-timetable.mjs";
import { materializeDaeguTimetable, runDaeguTimetableMaterializer } from "./materialize-daegu-timetable.mjs";

const root = path.resolve(import.meta.dirname, "../..");
process.env.EASYSUBWAY_DATAPACK_PRODUCTION_FIXTURE_VALIDATION_ONLY = "true";
const now = new Date("2026-07-20T16:00:00.000Z");
const execFileAsync = promisify(execFile);
const LINE_IDS = { 1: "line-5b8d9b05e7e6", 2: "line-e2938a4cc492", 3: "line-0ffaa95b1b5d" };

test("대구 1·2·3호선 공식 topology·시각표를 94역·182 edge·2540 trip·77970 stop_time으로 materialize한다", async () => {
  const values = await inputs();
  const pack = values.fixture.packs[0];
  const daeguLineIds = new Set(Object.values(LINE_IDS));
  const trips = pack.transitTrips.filter(({ id }) => id.startsWith("trip-daegu-"));
  const stopTimes = pack.transitStopTimes.filter(({ tripId }) => tripId.startsWith("trip-daegu-"));
  const edges = pack.networkEdges.filter(({ id }) => id.startsWith("edge-daegu-"));
  const stationLines = pack.stationLines.filter(({ lineId }) => daeguLineIds.has(lineId));
  const calendars = pack.serviceCalendars.filter(({ serviceId }) => serviceId.startsWith("daegu-"));

  assert.match(pack.id, /^nationwide-daegu-schedule-[a-f0-9]{64}$/);
  assert.deepEqual(values.fixture.manifest.activePack, { id: pack.id, version: "20260721" });
  assert.equal(pack.operators.filter(({ id }) => id === "daegu-transportation").length, 1);
  assert.equal(pack.lines.filter(({ id }) => daeguLineIds.has(id)).length, 3);
  assert.equal(stationLines.length, 94);
  assert.equal(edges.length, 182);
  assert.equal(calendars.length, 9);
  assert.equal(trips.length, 2_540);
  assert.equal(stopTimes.length, 77_970);
  assert.equal(stopTimes.every(({ derivationKind }) => derivationKind === "OFFICIAL"), true);
  assert.deepEqual({
    1: stationLines.filter(({ lineId }) => lineId === LINE_IDS[1]).length,
    2: stationLines.filter(({ lineId }) => lineId === LINE_IDS[2]).length,
    3: stationLines.filter(({ lineId }) => lineId === LINE_IDS[3]).length,
  }, { 1: 35, 2: 29, 3: 30 });
  assert.deepEqual(Object.fromEntries(calendars.map(({ serviceId }) => [serviceId,
    trips.filter((trip) => trip.serviceId === serviceId).length])), {
    "daegu-line1-weekday-2026": 296, "daegu-line1-saturday-2026": 280, "daegu-line1-holiday-2026": 248,
    "daegu-line2-weekday-2026": 296, "daegu-line2-saturday-2026": 282, "daegu-line2-holiday-2026": 250,
    "daegu-line3-weekday-2026": 312, "daegu-line3-saturday-2026": 296, "daegu-line3-holiday-2026": 280,
  });
  // 환승역(명덕·반월당·청라언덕) 3개는 stationId를 공유해 station row 91개·stationLine 94개가 된다.
  const daeguStations = pack.stations.filter(({ sourceId }) => sourceId.startsWith("molit-urban-rail-full-route-daegu-line"));
  assert.equal(daeguStations.length, 91);
  assert.equal(new Set(stationLines.map(({ stationId }) => stationId)).size, 91);

  // 자정 넘긴 막차는 24시 이후 service second로 rollover 된다.
  const maxArrival = Math.max(...stopTimes.map(({ arrivalSeconds }) => arrivalSeconds));
  assert.ok(maxArrival > 86_400, `expected a post-midnight trip, got max ${maxArrival}`);

  assert.ok(edges.every(({ sourceSnapshotId, evidenceHash }, index) => {
    const line = DAEGU_LINES.find((config) => edges[index].id.startsWith(`edge-daegu-${config.lineNumber}-`));
    const snapshot = values.topologySnapshots[line.lineNumber];
    return sourceSnapshotId === `${snapshot.sourceId}-20260721` && evidenceHash === snapshot.contentSha256;
  }));
  assert.ok(stationLines.every(({ fieldProvenance }) =>
    /^daegu-line[123]-route-topology$/.test(fieldProvenance.station_code.sourceId)
      && fieldProvenance.station_code.derivationKind === "OFFICIAL"));
});

test("대구 시각표는 차량기지 5행을 topology에서 격리하고 하선 휴일 라벨 결함 55행을 방향으로 정규화한다", async () => {
  const values = await inputs({ materialize: false });
  const depotNames = DAEGU_LINES.flatMap((config) =>
    values.topologySnapshots[config.lineNumber].quarantinedDepots.map((depot) => depot.stationName));
  assert.deepEqual(depotNames.sort((left, right) => left.localeCompare(right, "en")),
    ["문양기지", "범물기지", "안심기지", "월배기지", "칠곡기지"].sort((left, right) => left.localeCompare(right, "en")));
  assert.equal(DAEGU_LINES.reduce((total, config) =>
    total + values.topologySnapshots[config.lineNumber].depotExcludedCount, 0), 5);
  // 2호선 하선 파일의 휴일(상) 오라벨 55행은 파일 방향(하)으로 정규화된다.
  assert.equal(values.timetableSnapshots[2].dayLabelNormalizedCount, 55);
  assert.equal(values.timetableSnapshots[1].dayLabelNormalizedCount, 0);
  assert.equal(values.timetableSnapshots[3].dayLabelNormalizedCount, 0);
});

test("대구 materializer는 snapshot·inventory·freshness 변조를 fail closed한다", async () => {
  const values = await inputs({ materialize: false });
  const badTopology = { ...values.topologySnapshots, 1: structuredClone(values.topologySnapshots[1]) };
  badTopology[1].edges[0].durationSeconds += 60;
  assert.throws(() => materializeDaeguTimetable({
    baseFixture: values.baseFixture, topologySnapshots: badTopology, timetableSnapshots: values.timetableSnapshots,
    inventory: values.inventory, canonicalStationMappings: values.mappings, now,
  }), /topology snapshot/);
  assert.throws(() => materializeDaeguTimetable({
    baseFixture: values.baseFixture, topologySnapshots: values.topologySnapshots, timetableSnapshots: values.timetableSnapshots,
    inventory: values.inventory, canonicalStationMappings: values.mappings, now: new Date("2026-07-21T16:00:00.000Z"),
  }), /stale/);
});

test("대구 시각표 snapshot의 trips 변조(tripsSha256 불일치)는 fail-closed된다", async () => {
  const values = await inputs({ materialize: false });
  const timetable = structuredClone(values.timetableSnapshots[1]);
  timetable.trips[0].stops[0].a += 1; // tripsSha256을 재계산하지 않고 trips 본문만 변조한다.
  assert.throws(() => materializeDaeguTimetable({
    baseFixture: values.baseFixture, topologySnapshots: values.topologySnapshots,
    timetableSnapshots: { ...values.timetableSnapshots, 1: timetable },
    inventory: values.inventory, canonicalStationMappings: values.mappings, now,
  }), /timetable snapshot/);
});

test("대구 시각표 snapshot의 contentSha256 변조(trips 자체는 정상)는 fail-closed된다", async () => {
  const values = await inputs({ materialize: false });
  const timetable = structuredClone(values.timetableSnapshots[1]);
  // trips·tripsSha256은 그대로 두고 contentSha256만 위조한다.
  timetable.contentSha256 = timetable.contentSha256.endsWith("0")
    ? `${timetable.contentSha256.slice(0, -1)}1`
    : `${timetable.contentSha256.slice(0, -1)}0`;
  assert.throws(() => materializeDaeguTimetable({
    baseFixture: values.baseFixture, topologySnapshots: values.topologySnapshots,
    timetableSnapshots: { ...values.timetableSnapshots, 1: timetable },
    inventory: values.inventory, canonicalStationMappings: values.mappings, now,
  }), /timetable snapshot/);
});

test("inventory에 기록된 topology admission evidence가 실제 snapshot과 불일치하면 fail-closed된다", async () => {
  const values = await inputs({ materialize: false });
  const inventory = structuredClone(values.inventory);
  const topologySource = inventory.sources.find(({ id }) => id === "daegu-line1-route-topology");
  topologySource.topologyAdmissionEvidence.contentSha256 = "0".repeat(64);
  assert.throws(() => materializeDaeguTimetable({
    baseFixture: values.baseFixture, topologySnapshots: values.topologySnapshots, timetableSnapshots: values.timetableSnapshots,
    inventory, canonicalStationMappings: values.mappings, now,
  }), /inventory evidence does not match snapshot/);
});

test("MOLIT membership mapping이 topology에 없는 역명으로 위조되면(mappingSha256까지 위조해도) fail-closed된다", async () => {
  const values = await inputs({ materialize: false });
  const sha256 = (value) => createHash("sha256").update(value).digest("hex");
  const mapping1 = values.mappings[1].map((mapping) => ({ ...mapping }));
  Object.defineProperty(mapping1, "sourceRawSha256", { value: values.mappings[1].sourceRawSha256, enumerable: true });
  mapping1[0] = { ...mapping1[0], stationName: "존재하지않는역이름" };

  const inventory = structuredClone(values.inventory);
  const membershipSource = inventory.sources.find(({ id }) => id === "molit-urban-rail-full-route-daegu-line1-membership");
  // membership evidence 해시 게이트까지 위조자가 통과시켰다고 가정해도(mappingSha256 재계산),
  // topology와의 역명 정합 자체가 깨져 있으므로 fail-closed되어야 한다.
  membershipSource.membershipAdmissionEvidence.mappingSha256 = sha256(JSON.stringify(mapping1));

  assert.throws(() => materializeDaeguTimetable({
    baseFixture: values.baseFixture, topologySnapshots: values.topologySnapshots, timetableSnapshots: values.timetableSnapshots,
    inventory, canonicalStationMappings: { ...values.mappings, 1: mapping1 }, now,
  }), /mismatch/);
});

test("membership↔topology index 정합 가드는 이름 집합은 그대로 두고 순서만 뒤바뀐 topology 위조를 fail-closed로 잡아낸다", async () => {
  const values = await inputs({ materialize: false });
  const sha256 = (value) => createHash("sha256").update(value).digest("hex");
  const topology = structuredClone(values.topologySnapshots[1]);
  // scope[1]과 scope[2]를 통째로 맞바꾼다. 역명 집합(Set)은 그대로라 이름 기반 결속(scopeByNorm)만으로는
  // 감지되지 않는다 — index-wise 순서 정합 단언(가드 1)만 이 재정렬 위조를 잡아낸다.
  [topology.scope[1], topology.scope[2]] = [topology.scope[2], topology.scope[1]];
  topology.scopeSha256 = sha256(JSON.stringify(topology.scope));
  topology.contentSha256 = sha256(JSON.stringify({ scope: topology.scope, edges: topology.edges }));

  const inventory = structuredClone(values.inventory);
  const topologySource = inventory.sources.find(({ id }) => id === "daegu-line1-route-topology");
  topologySource.topologyAdmissionEvidence.contentSha256 = topology.contentSha256;
  const membershipSource = inventory.sources.find(({ id }) => id === "molit-urban-rail-full-route-daegu-line1-membership");
  membershipSource.membershipAdmissionEvidence.stationCodeContentSha256 = topology.contentSha256;
  membershipSource.membershipAdmissionEvidence.stationCodesSha256 =
    sha256(JSON.stringify(topology.scope.map(({ stationCode }) => stationCode)));

  assert.throws(() => materializeDaeguTimetable({
    baseFixture: values.baseFixture, topologySnapshots: { ...values.topologySnapshots, 1: topology },
    timetableSnapshots: values.timetableSnapshots, inventory, canonicalStationMappings: values.mappings, now,
  }), /membership↔topology index mismatch/);
});

test("MOLIT 대구 station mapping과 materializer CLI를 고정한다", async () => {
  const values = await inputs({ materialize: false });
  assert.equal(values.mappings[1].length, 35);
  assert.equal(values.mappings[2].length, 29);
  assert.equal(values.mappings[3].length, 30);
  assert.deepEqual(values.mappings[1].slice(0, 2).map(({ stationName, sequence }) => ({ stationName, sequence })), [
    { stationName: "설화명곡", sequence: 1 },
    { stationName: "화원", sequence: 2 },
  ]);
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-daegu-pack-"));
  try {
    const baseFixturePath = path.join(directory, "base.json");
    const inventoryPath = path.join(directory, "inventory.json");
    const outputPath = path.join(directory, "output.json");
    await Promise.all([
      writeFile(baseFixturePath, JSON.stringify(values.baseFixture)),
      writeFile(inventoryPath, JSON.stringify(values.inventory)),
    ]);
    await runDaeguTimetableMaterializer([
      "--base-fixture", baseFixturePath,
      "--sources-dir", path.join(root, "tools/datapack/sources"),
      "--inventory", inventoryPath,
      "--station-map", path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv"),
      "--output", outputPath,
    ], { now });
    const fixture = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(fixture.packs[0].transitTrips.filter(({ id }) => id.startsWith("trip-daegu-")).length, 2_540);
    await assert.rejects(execFileAsync(process.execPath, [
      path.join(root, "tools/datapack/materialize-daegu-timetable.mjs"),
    ]), (error) => {
      assert.match(error.stderr, /usage: materialize-daegu-timetable/);
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("materialized SQLite·provenance가 대구 membership·topology·schedule 9건을 SUPPORTED로 만든다", async (context) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-daegu-runtime-pack-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  const fixturePath = path.join(outputDir, "fixture.json");
  const packOutput = path.join(outputDir, "pack");
  const reportPath = path.join(outputDir, "coverage.json");
  const { fixture } = await inputs();
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
  const manifestPath = path.join(packOutput, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const sqlitePath = path.join(packOutput,
    new URL(manifest.packs[0].url).pathname.split("/").slice(-2).join("/")).replace(/\.gz$/, "");
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM network_edges WHERE id LIKE 'edge-daegu-%'")
    .get().count, 182);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM transit_trips WHERE id LIKE 'trip-daegu-%'")
    .get().count, 2_540);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM transit_stop_times st
    JOIN transit_trips t ON t.id = st.trip_id WHERE t.id LIKE 'trip-daegu-%'
  `).get().count, 77_970);
  database.close();

  const provenance = JSON.parse(await readFile(path.join(packOutput, "current.provenance.json"), "utf8"));
  const records = provenance.packs.flatMap(({ records: rows }) => rows);
  for (const line of [1, 2, 3]) {
    assert.ok(records.some(({ sourceId, field }) =>
      sourceId === `daegu-line${line}-route-topology` && field === "network_edges"));
    assert.ok(records.some(({ sourceId, field }) =>
      sourceId === `daegu-line${line}-train-timetable` && field === "trip"));
    assert.ok(records.some(({ sourceId, field }) =>
      sourceId === `daegu-line${line}-train-timetable` && field === "stop_time"));
  }

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
  for (const line of [1, 2, 3]) {
    const requirements = report.requirements.filter(({ regionId, operatorId, lineId }) =>
      regionId === "daegu" && operatorId === "daegu-transportation" && lineId === LINE_IDS[line]);
    assert.deepEqual(requirements.filter(({ status }) => status === "SUPPORTED")
      .map(({ sourceDomain }) => sourceDomain).sort((a, b) => a.localeCompare(b, "en")), [
      "route_graph_topology", "schedule_timetable", "station_line_membership",
    ], JSON.stringify(requirements, null, 2));
  }
  assert.deepEqual(report.summary.launchRequired, {
    totalCount: 270,
    supportedCount: 31,
    explicitlyUnsupportedCount: 4,
    missingCount: 235,
    supportedRatio: 0.1148,
    terminalResolutionRatio: 0.1296,
    completionReady: false,
  });
});

async function inputs({ materialize = true } = {}) {
  const [base, busanTopology, busanTimetable, busanRouteMapBytes, daejeonTopology, daejeonTimetable,
    gwangjuTopology, gwangjuTimetable, inventory, regionalMap, molitMap] = await Promise.all([
    readJson("tools/datapack/release/capital-production-reviewed-pack.json"),
    readJson("tools/datapack/sources/busan-transportation-route-topology-20260720.json"),
    readJson("tools/datapack/sources/busan-transportation-timetable-20260720.json"),
    readFile(path.join(root, "tools/datapack/sources/busan-transportation-route-map-positions-20260720.json")),
    readJson("tools/datapack/sources/daejeon-route-topology-20260720.json"),
    readJson("tools/datapack/sources/daejeon-train-timetable-20260720.json"),
    readJson("tools/datapack/sources/gwangju-transportation-route-topology-20260720.json"),
    readJson("tools/datapack/sources/gwangju-transportation-cyberstation-timetable-20260720.json"),
    readJson("tools/datapack/source-inventory.json"),
    readFile(path.join(root, "tools/datapack/sources/regional-official-svg-route-map-coordinates-20260624.csv"), "utf8"),
    readFile(path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv")),
  ]);
  const busanTopologyFixture = materializeBusanRouteTopology({
    baseFixture: base, snapshot: busanTopology, inventory,
    canonicalStationMappings: parseCanonicalBusanStationMappings(regionalMap),
    now: new Date("2026-07-19T18:14:03.004Z"),
  });
  const daejeonFixture = materializeDaejeonTimetable({
    baseFixture: busanTopologyFixture, timetableSnapshot: daejeonTimetable,
    topologySnapshot: daejeonTopology, inventory,
    canonicalStationMappings: parseMolitDaejeonStationMappings(molitMap), now,
  });
  const busanTimetableFixture = materializeBusanTimetable({
    baseFixture: daejeonFixture, timetableSnapshot: busanTimetable,
    topologySnapshot: busanTopology, inventory, now,
  });
  const busanPositionsFixture = materializeBusanRouteMapPositions({
    baseFixture: busanTimetableFixture, snapshot: JSON.parse(busanRouteMapBytes),
    snapshotSha256: createHash("sha256").update(busanRouteMapBytes).digest("hex"),
    topologySnapshot: busanTopology, inventory, now,
  });
  const baseFixture = materializeGwangjuTimetable({
    baseFixture: busanPositionsFixture, timetableSnapshot: gwangjuTimetable, topologySnapshot: gwangjuTopology,
    inventory, canonicalStationMappings: parseMolitGwangjuStationMappings(molitMap), now,
  });
  const topologySnapshots = {};
  const timetableSnapshots = {};
  const mappings = {};
  for (const config of DAEGU_LINES) {
    topologySnapshots[config.lineNumber] = await readJson(`tools/datapack/sources/daegu-line${config.lineNumber}-route-topology-20260721.json`);
    timetableSnapshots[config.lineNumber] = await readJson(`tools/datapack/sources/daegu-line${config.lineNumber}-train-timetable-20260721.json`);
    mappings[config.lineNumber] = parseMolitDaeguStationMappings(molitMap, config.lineName);
  }
  const fixture = materialize ? materializeDaeguTimetable({
    baseFixture, topologySnapshots, timetableSnapshots, inventory, canonicalStationMappings: mappings, now,
  }) : undefined;
  return { baseFixture, fixture, topologySnapshots, timetableSnapshots, mappings, inventory };
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}
