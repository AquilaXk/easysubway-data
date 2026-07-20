import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import test from "node:test";

import {
  materializeDaejeonRouteTopology,
} from "./materialize-daejeon-route-topology.mjs";
import { parseMolitDaejeonStationMappings } from "./build-molit-nationwide-fixture.mjs";
import {
  materializeBusanRouteTopology,
  parseCanonicalBusanStationMappings,
} from "./materialize-busan-route-topology.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const evidenceNow = new Date("2026-07-20T04:00:00.000Z");

async function inputs() {
  const [baseFixture, snapshot, inventory, stationMapCsv] = await Promise.all([
    readJson("tools/datapack/release/capital-production-reviewed-pack.json"),
    readJson("tools/datapack/sources/daejeon-route-topology-20260720.json"),
    readJson("tools/datapack/source-inventory.json"),
    readFile(path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv")),
  ]);
  return [baseFixture, snapshot, inventory, parseMolitDaejeonStationMappings(stationMapCsv)];
}

test("대전 topology snapshot을 실제 production pack 입력으로 materialize한다", async () => {
  const [baseFixture, snapshot, inventory, canonicalStationMappings] = await inputs();
  const fixture = materializeDaejeonRouteTopology({
    baseFixture, snapshot, inventory, canonicalStationMappings, now: evidenceNow,
  });
  const pack = fixture.packs[0];
  const edges = pack.networkEdges.filter(({ sourceId }) => sourceId === snapshot.sourceId);
  const stationLines = pack.stationLines.filter(({ lineId }) => lineId === "line-7051a9c2525c");

  assert.deepEqual(fixture.manifest.activePack, { id: pack.id, version: pack.version });
  assert.equal(fixture.manifest.releaseSequence, baseFixture.manifest.releaseSequence);
  assert.equal(pack.artifactKind, "production");
  assert.equal(edges.length, 42);
  assert.equal(stationLines.length, 22);
  const membershipSource = pack.sourceInventory.find(({ id }) =>
    id === "molit-urban-rail-full-route-daejeon-membership");
  const stationCodeSource = pack.sourceInventory.find(({ id }) => id === snapshot.sourceId);
  assert.ok(stationLines.every(({ sourceId }) =>
    sourceId === "molit-urban-rail-full-route-daejeon-membership"));
  assert.ok(stationLines.every(({ fieldProvenance }) =>
    fieldProvenance?.station_code?.sourceId === snapshot.sourceId
    && fieldProvenance.station_code.sourceSnapshotId === "daejeon-station-distance-fare-topology-20260720"
    && fieldProvenance.station_code.evidenceHash === snapshot.contentSha256
    && fieldProvenance.station_code.derivationKind === "OFFICIAL"));
  assert.ok(membershipSource.coverageScope.lineIds.includes("line-7051a9c2525c"));
  assert.deepEqual(stationCodeSource.coverageScope.sourceDomains, [
    "route_graph_topology",
    "station_line_membership",
  ]);
  assert.ok(pack.stations
    .filter(({ id }) => stationLines.some(({ stationId }) => stationId === id))
    .every(({ sourceId, dataSourceType }) =>
      sourceId === "molit-urban-rail-full-route-daejeon-membership"
      && dataSourceType === "OFFICIAL_FILE"));
  assert.equal(edges.filter(({ fromNodeId, toNodeId }) => fromNodeId < toNodeId)
    .reduce((sum, edge) => sum + edge.durationSeconds, 0), 2_400);
  assert.equal(edges.filter(({ fromNodeId, toNodeId }) => fromNodeId < toNodeId)
    .reduce((sum, edge) => sum + edge.distanceMeters, 0), 20_500);
  assert.ok(edges.every(({ sourceSnapshotId }) => sourceSnapshotId === "daejeon-station-distance-fare-topology-20260720"));
  assert.ok(edges.every(({ derivationKind }) => derivationKind === "OFFICIAL"));
  assert.deepEqual(stationLines.map(({ stationId, stationCode, lineSequence }) => ({ stationId, stationCode, lineSequence })), [
    { stationId: "station-1a68b52a9b0d", stationCode: "101", lineSequence: 1 },
    { stationId: "station-8fa8dda24824", stationCode: "102", lineSequence: 2 },
    { stationId: "station-4a9886a49721", stationCode: "103", lineSequence: 3 },
    { stationId: "station-a8e6a45c3c35", stationCode: "104", lineSequence: 4 },
    { stationId: "station-102781067ad4", stationCode: "105", lineSequence: 5 },
    { stationId: "station-4f6b91cd4b74", stationCode: "106", lineSequence: 6 },
    { stationId: "station-ee3cc9d04ee7", stationCode: "107", lineSequence: 7 },
    { stationId: "station-49f924643e04", stationCode: "108", lineSequence: 8 },
    { stationId: "station-8c3f83ab1056", stationCode: "109", lineSequence: 9 },
    { stationId: "station-961042c194fb", stationCode: "110", lineSequence: 10 },
    { stationId: "station-0e902d05cec4", stationCode: "111", lineSequence: 11 },
    { stationId: "station-b35cc28f2c19", stationCode: "112", lineSequence: 12 },
    { stationId: "station-e0293fcce108", stationCode: "113", lineSequence: 13 },
    { stationId: "station-9affffdcaf16", stationCode: "114", lineSequence: 14 },
    { stationId: "station-18ba692610bf", stationCode: "115", lineSequence: 15 },
    { stationId: "station-6423e0901f89", stationCode: "116", lineSequence: 16 },
    { stationId: "station-11db8e56e157", stationCode: "117", lineSequence: 17 },
    { stationId: "station-5cfb7a665888", stationCode: "118", lineSequence: 18 },
    { stationId: "station-7ee5ea397b9d", stationCode: "119", lineSequence: 19 },
    { stationId: "station-70f297332b8c", stationCode: "120", lineSequence: 20 },
    { stationId: "station-f5572903bf54", stationCode: "121", lineSequence: 21 },
    { stationId: "station-c94180e4d057", stationCode: "122", lineSequence: 22 },
  ]);

  const mismatchedInventory = structuredClone(inventory);
  mismatchedInventory.sources.find(({ id }) => id === snapshot.sourceId)
    .topologyAdmissionEvidence.contentSha256 = "0".repeat(64);
  assert.throws(() => materializeDaejeonRouteTopology({
    baseFixture, snapshot, inventory: mismatchedInventory, canonicalStationMappings, now: evidenceNow,
  }), /inventory evidence/);
  assert.throws(() => materializeDaejeonRouteTopology({
    baseFixture, snapshot, inventory, canonicalStationMappings, now: new Date("2026-07-20T22:12:49.895Z"),
  }), /stale/);
  for (const malformedFreshUntil of [undefined, "not-a-date"]) {
    const malformedInventory = structuredClone(inventory);
    malformedInventory.sources.find(({ id }) => id === snapshot.sourceId)
      .topologyAdmissionEvidence.freshUntil = malformedFreshUntil;
    assert.throws(() => materializeDaejeonRouteTopology({
      baseFixture, snapshot, inventory: malformedInventory, canonicalStationMappings, now: evidenceNow,
    }), /freshUntil is invalid/);
  }
  assert.throws(() => materializeDaejeonRouteTopology({
    baseFixture, snapshot, inventory, canonicalStationMappings, now: new Date("not-a-date"),
  }), /materialization time is invalid/);
  assert.throws(() => materializeDaejeonRouteTopology({
    baseFixture, snapshot, inventory, canonicalStationMappings, now: new Date("2026-07-19T22:00:00.000Z"),
  }), /future/);
});

test("대전 topology admission은 snapshot schema와 endpoint identity 변조를 거부한다", async () => {
  const [baseFixture, snapshot, inventory, canonicalStationMappings] = await inputs();
  for (const mutation of [
    { schemaVersion: 999 },
    { endpoint: "https://example.invalid/wrong" },
  ]) {
    assert.throws(() => materializeDaejeonRouteTopology({
      baseFixture,
      snapshot: { ...snapshot, ...mutation },
      inventory,
      canonicalStationMappings,
      now: evidenceNow,
    }), /invalid Daejeon route topology snapshot/);
  }
});

test("대전 topology admission은 capturedAt에서 24시간을 넘겨 연장한 freshness를 거부한다", async () => {
  const [baseFixture, snapshot, inventory, canonicalStationMappings] = await inputs();
  const extendedInventory = structuredClone(inventory);
  extendedInventory.sources.find(({ id }) => id === snapshot.sourceId)
    .topologyAdmissionEvidence.freshUntil = "2030-01-01T00:00:00.000Z";

  assert.throws(() => materializeDaejeonRouteTopology({
    baseFixture,
    snapshot,
    inventory: extendedInventory,
    canonicalStationMappings,
    now: new Date("2027-01-01T00:00:00.000Z"),
  }), /freshness contract is invalid/);
});

test("대전 membership admission은 source scope와 두 공식 evidence의 결속 변조를 거부한다", async () => {
  const [baseFixture, snapshot, inventory, canonicalStationMappings] = await inputs();
  const mutations = [
    (sources) => { sources.membership.coverageScope.lineIds = []; },
    (sources) => { sources.membership.fieldsProvided = sources.membership.fieldsProvided.filter((field) => field !== "line"); },
    (sources) => { sources.stationCode.membershipAdmissionEvidence.mappingSha256 = "0".repeat(64); },
    (sources) => { sources.stationCode.membershipAdmissionEvidence.stationCodesSha256 = "0".repeat(64); },
    (sources) => { sources.stationCode.membershipAdmissionEvidence.stationCodeContentSha256 = "0".repeat(64); },
  ];
  for (const mutate of mutations) {
    const invalidInventory = structuredClone(inventory);
    mutate({
      membership: invalidInventory.sources.find(({ id }) =>
        id === "molit-urban-rail-full-route-daejeon-membership"),
      stationCode: invalidInventory.sources.find(({ id }) => id === snapshot.sourceId),
    });
    assert.throws(() => materializeDaejeonRouteTopology({
      baseFixture,
      snapshot,
      inventory: invalidInventory,
      canonicalStationMappings,
      now: evidenceNow,
    }), /Daejeon membership evidence is invalid/);
  }
  const stationMapCsv = await readFile(
    path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv"),
  );
  assert.throws(() => materializeDaejeonRouteTopology({
    baseFixture,
    snapshot,
    inventory,
    canonicalStationMappings: parseMolitDaejeonStationMappings(Buffer.concat([
      stationMapCsv,
      Buffer.from("\n"),
    ])),
    now: evidenceNow,
  }), /Daejeon membership evidence is invalid/);
  assert.throws(() => materializeDaejeonRouteTopology({
    baseFixture,
    snapshot,
    inventory,
    canonicalStationMappings,
    now: new Date("2026-07-20T03:29:59.999Z"),
  }), /membership evidence is future-dated/);
});

test("materialized production SQLite와 field provenance만 대전 1호선 membership·topology를 SUPPORTED로 만든다", async (context) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-daejeon-topology-pack-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  const fixturePath = path.join(outputDir, "fixture.json");
  const invalidFixturePath = path.join(outputDir, "invalid-fixture.json");
  const packOutput = path.join(outputDir, "pack");
  const reportPath = path.join(outputDir, "coverage.json");
  const [baseFixture, snapshot, inventory, canonicalStationMappings] = await inputs();
  const fixture = materializeDaejeonRouteTopology({
    baseFixture, snapshot, inventory, canonicalStationMappings, now: evidenceNow,
  });
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  await mkdir(packOutput, { recursive: true });

  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  for (const [sourceId, expectedError] of [
    ["", /fieldProvenance sourceId must be a non-empty string/],
    ["missing-membership-source", /fieldProvenance source is missing from sourceInventory/],
    ["molit-urban-rail-full-route-daejeon-membership", /fieldProvenance source does not provide station_code/],
  ]) {
    const invalidFixture = structuredClone(fixture);
    invalidFixture.packs[0].stationLines.find(({ lineId }) => lineId === "line-7051a9c2525c")
      .fieldProvenance.station_code.sourceId = sourceId;
    await writeFile(invalidFixturePath, `${JSON.stringify(invalidFixture, null, 2)}\n`);
    await assert.rejects(execFileAsync(process.execPath, [
      "tools/datapack/build-datapack.mjs", "--fixture", invalidFixturePath, "--output", packOutput,
    ], {
      cwd: root,
      env: { ...process.env, EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKey },
    }), expectedError);
  }

  for (const linkageField of ["sourceSnapshotId", "providerRecordHash", "evidenceHash", "verifiedAt"]) {
    const inheritedEvidenceFixture = structuredClone(fixture);
    delete inheritedEvidenceFixture.packs[0].stationLines
      .find(({ lineId }) => lineId === "line-7051a9c2525c")
      .fieldProvenance.station_code[linkageField];
    await writeFile(invalidFixturePath, `${JSON.stringify(inheritedEvidenceFixture, null, 2)}\n`);
    await assert.rejects(execFileAsync(process.execPath, [
      "tools/datapack/build-datapack.mjs", "--fixture", invalidFixturePath, "--output", packOutput,
    ], {
      cwd: root,
      env: { ...process.env, EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKey },
    }), new RegExp(`fieldProvenance source change requires explicit ${linkageField}`));
  }

  await execFileAsync(process.execPath, [
    "tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", packOutput,
  ], {
    cwd: root,
    env: { ...process.env, EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKey },
  });

  const manifestPath = path.join(packOutput, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await execFileAsync(process.execPath, [
    "tools/datapack/validate-datapack.mjs",
    "--manifest", manifestPath,
    "--root", packOutput,
    "--require-production",
  ], {
    cwd: root,
    env: { ...process.env, EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM: publicKey },
  });
  const sqlitePath = path.join(packOutput, new URL(manifest.packs[0].url).pathname.split("/").slice(-2).join("/")).replace(/\.gz$/, "");
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM network_edges WHERE source_id = ?")
    .get(snapshot.sourceId).count, 42);
  database.close();

  const provenance = JSON.parse(await readFile(path.join(packOutput, "current.provenance.json"), "utf8"));
  const membershipRecords = provenance.packs[0].records.filter(({ coverageScope }) =>
    coverageScope?.lineIds?.includes("line-7051a9c2525c")
    && coverageScope.sourceDomains?.includes("station_line_membership"));
  assert.deepEqual(
    [...new Set(membershipRecords.filter(({ field }) => field === "station_name").map(({ sourceId }) => sourceId))],
    ["molit-urban-rail-full-route-daejeon-membership"],
  );
  assert.deepEqual(
    [...new Set(membershipRecords.filter(({ field }) => field === "line").map(({ sourceId }) => sourceId))],
    ["molit-urban-rail-full-route-daejeon-membership"],
  );
  assert.deepEqual(
    [...new Set(membershipRecords.filter(({ field }) => field === "station_code").map(({ sourceId }) => sourceId))],
    [snapshot.sourceId],
  );

  await execFileAsync(process.execPath, [
    "tools/datapack/report-coverage-gaps.mjs",
    "--targets", "tools/datapack/nationwide-coverage-targets.json",
    "--inventory", "tools/datapack/source-inventory.json",
    "--manifest", manifestPath,
    "--provenance", path.join(packOutput, "current.provenance.json"),
    "--output", reportPath,
    "--allow-gaps",
  ], { cwd: root });

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const daejeon = report.requirements.filter(({ operatorId }) => operatorId === "daejeon-transportation");
  assert.deepEqual(
    daejeon.filter(({ status }) => status === "SUPPORTED").map(({ lineId, sourceDomain }) => ({ lineId, sourceDomain })),
    [
      { lineId: "line-7051a9c2525c", sourceDomain: "station_line_membership" },
      { lineId: "line-7051a9c2525c", sourceDomain: "route_graph_topology" },
    ],
  );
});

test("부산과 대전 topology를 하나의 nationwide production pack으로 합성한다", async (context) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-busan-daejeon-topology-pack-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  const [baseFixture, daejeonSnapshot, inventory, canonicalStationMappings] = await inputs();
  const [busanSnapshot, busanStationMapCsv] = await Promise.all([
    readJson("tools/datapack/sources/busan-transportation-route-topology-20260720.json"),
    readFile(path.join(root, "tools/datapack/sources/regional-official-svg-route-map-coordinates-20260624.csv"), "utf8"),
  ]);
  const busanFixture = materializeBusanRouteTopology({
    baseFixture,
    snapshot: busanSnapshot,
    inventory,
    canonicalStationMappings: parseCanonicalBusanStationMappings(busanStationMapCsv),
    now: new Date("2026-07-19T18:14:03.004Z"),
  });
  const capitalOnlyFixture = materializeDaejeonRouteTopology({
    baseFixture,
    snapshot: daejeonSnapshot,
    inventory,
    canonicalStationMappings,
    now: evidenceNow,
  });
  const fixture = materializeDaejeonRouteTopology({
    baseFixture: busanFixture,
    snapshot: daejeonSnapshot,
    inventory,
    canonicalStationMappings,
    now: evidenceNow,
  });
  assert.notEqual(fixture.packs[0].id, capitalOnlyFixture.packs[0].id);
  assert.notEqual(fixture.packs[0].url, capitalOnlyFixture.packs[0].url);
  assert.match(fixture.packs[0].id, /^nationwide-daejeon-topology-[a-f0-9]{64}$/);
  const fixturePath = path.join(outputDir, "fixture.json");
  const packOutput = path.join(outputDir, "pack");
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  await mkdir(packOutput, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await execFileAsync(process.execPath, [
    "tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", packOutput,
  ], {
    cwd: root,
    env: { ...process.env, EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKey },
  });
  await execFileAsync(process.execPath, [
    "tools/datapack/validate-datapack.mjs",
    "--manifest", path.join(packOutput, "current.json"),
    "--root", packOutput,
    "--require-production",
  ], {
    cwd: root,
    env: { ...process.env, EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM: publicKey },
  });
});

test("접근성 coverage는 같은 운영기관의 scope 밖 지역 station-line을 분모에서 제외한다", async (context) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-accessibility-region-scope-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  const [baseFixture, snapshot, inventory, canonicalStationMappings] = await inputs();
  const pack = baseFixture.packs[0];
  pack.lines.push({
    ...pack.lines[0],
    id: "busan-test-line",
    nameKo: "부산 범위 밖 테스트 노선",
  });
  pack.stations.push({
    ...pack.stations[0],
    id: "station-busan-out-of-scope",
    nameKo: "부산 범위 밖 테스트역",
    normalizedName: "부산 범위 밖 테스트역",
    region: "부산권",
  });
  pack.stationLines.push({
    ...pack.stationLines[0],
    stationId: "station-busan-out-of-scope",
    lineId: "busan-test-line",
    stationCode: "B001",
    lineSequence: 1,
  });
  pack.minimumTableRows.lines = pack.lines.length;
  pack.minimumTableRows.stations = pack.stations.length;
  pack.minimumTableRows.station_lines = pack.stationLines.length;
  const fixture = materializeDaejeonRouteTopology({
    baseFixture, snapshot, inventory, canonicalStationMappings, now: evidenceNow,
  });
  const fixturePath = path.join(outputDir, "fixture.json");
  const packOutput = path.join(outputDir, "pack");
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  await mkdir(packOutput, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await execFileAsync(process.execPath, [
    "tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", packOutput,
  ], {
    cwd: root,
    env: { ...process.env, EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKey },
  });
  await execFileAsync(process.execPath, [
    "tools/datapack/validate-datapack.mjs",
    "--manifest", path.join(packOutput, "current.json"),
    "--root", packOutput,
    "--require-production",
  ], {
    cwd: root,
    env: { ...process.env, EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM: publicKey },
  });
});

test("명시된 접근성 coverage scope의 station-line evidence 누락을 거부한다", async (context) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-accessibility-scope-gap-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  const [baseFixture, snapshot, inventory, canonicalStationMappings] = await inputs();
  const pack = baseFixture.packs[0];
  pack.stationFacilityEvidence = pack.stationFacilityEvidence
    .filter(({ stationId }) => stationId !== "station-sangnoksu");
  pack.networkEdges = pack.networkEdges.filter(({ fromNodeId, toNodeId }) =>
    !fromNodeId.startsWith("station-sangnoksu") && !toNodeId.startsWith("station-sangnoksu"));
  pack.minimumTableRows.station_facility_evidence = pack.stationFacilityEvidence.length;
  pack.minimumTableRows.network_edges = pack.networkEdges.length;
  const fixture = materializeDaejeonRouteTopology({
    baseFixture, snapshot, inventory, canonicalStationMappings, now: evidenceNow,
  });
  const fixturePath = path.join(outputDir, "fixture.json");
  const packOutput = path.join(outputDir, "pack");
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  await mkdir(packOutput, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await execFileAsync(process.execPath, [
    "tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", packOutput,
  ], {
    cwd: root,
    env: { ...process.env, EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKey },
  });
  await assert.rejects(execFileAsync(process.execPath, [
    "tools/datapack/validate-datapack.mjs",
    "--manifest", path.join(packOutput, "current.json"),
    "--root", packOutput,
    "--require-production",
  ], {
    cwd: root,
    env: { ...process.env, EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM: publicKey },
  }), /verified ENTRY coverage gap/);
});

test("접근성 source가 있는 production pack은 접근성 coverage metadata 삭제를 거부한다", async (context) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-accessibility-metadata-gap-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  const [baseFixture, snapshot, inventory, canonicalStationMappings] = await inputs();
  const pack = baseFixture.packs[0];
  pack.metadata.productionCoverageEvidence = JSON.stringify(
    JSON.parse(pack.metadata.productionCoverageEvidence)
      .filter(({ sourceDomain }) => sourceDomain !== "accessibility_facilities"),
  );
  pack.networkEdges = pack.networkEdges.filter(({ id }) => id !== "edge-entry-sangnoksu-seoul-4");
  pack.minimumTableRows.network_edges = pack.networkEdges.length;
  const fixture = materializeDaejeonRouteTopology({
    baseFixture, snapshot, inventory, canonicalStationMappings, now: evidenceNow,
  });
  const fixturePath = path.join(outputDir, "fixture.json");
  const packOutput = path.join(outputDir, "pack");
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  await mkdir(packOutput, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await execFileAsync(process.execPath, [
    "tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", packOutput,
  ], {
    cwd: root,
    env: { ...process.env, EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKey },
  });
  await assert.rejects(execFileAsync(process.execPath, [
    "tools/datapack/validate-datapack.mjs",
    "--manifest", path.join(packOutput, "current.json"),
    "--root", packOutput,
    "--require-production",
  ], {
    cwd: root,
    env: { ...process.env, EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM: publicKey },
  }), /productionCoverageEvidence accessibility scope is missing/);
});

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}
