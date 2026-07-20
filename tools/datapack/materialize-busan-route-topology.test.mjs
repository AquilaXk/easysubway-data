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
  materializedBusanPackContentHash,
  materializeBusanRouteTopology,
  parseCanonicalBusanStationMappings,
} from "./materialize-busan-route-topology.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const evidenceNow = new Date("2026-07-19T18:14:03.004Z");

async function inputs() {
  const [baseFixture, snapshot, inventory, stationMapCsv] = await Promise.all([
    readJson("tools/datapack/release/capital-production-reviewed-pack.json"),
    readJson("tools/datapack/sources/busan-transportation-route-topology-20260720.json"),
    readJson("tools/datapack/source-inventory.json"),
    readFile(path.join(root, "tools/datapack/sources/regional-official-svg-route-map-coordinates-20260624.csv"), "utf8"),
  ]);
  return [baseFixture, snapshot, inventory, parseCanonicalBusanStationMappings(stationMapCsv)];
}

test("부산 topology snapshot을 실제 production pack 입력으로 materialize한다", async () => {
  const [baseFixture, snapshot, inventory, canonicalStationMappings] = await inputs();
  const fixture = materializeBusanRouteTopology({
    baseFixture, snapshot, inventory, canonicalStationMappings, now: evidenceNow,
  });
  const pack = fixture.packs[0];
  const source = pack.sourceInventory.find(({ id }) => id === snapshot.sourceId);
  const busanEdges = pack.networkEdges.filter(({ sourceId }) => sourceId === snapshot.sourceId);
  const busanStationLines = pack.stationLines.filter(({ sourceId }) => sourceId === snapshot.sourceId);

  assert.deepEqual(fixture.manifest.activePack, { id: pack.id, version: pack.version });
  assert.match(pack.id, /^nationwide-busan-topology-[a-f0-9]{64}$/);
  assert.match(pack.url, new RegExp(`/catalog/${pack.id}-v${pack.version}\\.sqlite\\.gz$`));
  assert.equal(pack.id, `nationwide-busan-topology-${materializedBusanPackContentHash(pack, pack.version)}`);
  assert.equal(fixture.manifest.releaseSequence, baseFixture.manifest.releaseSequence);
  assert.equal(fixture.manifest.publishedAt, baseFixture.manifest.publishedAt);
  assert.equal(fixture.manifest.expiresAt, baseFixture.manifest.expiresAt);
  assert.equal(pack.artifactKind, "production");
  assert.equal(busanEdges.length, 220);
  assert.equal(busanStationLines.length, 114);
  assert.deepEqual(source.coverageScope.lineIds, snapshot.lineIds);
  assert.deepEqual(source.fields, snapshot.fieldsProvided);
  assert.ok(busanEdges.every(({ derivationKind }) => derivationKind === "OFFICIAL"));
  assert.ok(busanEdges.every(
    ({ sourceSnapshotId }) => sourceSnapshotId === "busan-transportation-route-topology-20260720",
  ));
  assert.equal(busanEdges[0].distanceMeters, snapshot.edges[0].distanceMeters);
  assert.equal(
    busanEdges[0].durationSeconds,
    snapshot.edges[0].durationSeconds + snapshot.edges[0].stoppingSeconds,
  );
  const line1ForwardIds = new Set(snapshot.edges
    .filter(({ lineId, fromStationCode, toStationCode }) =>
      lineId === "line-ab1a041f6266" && Number(toStationCode) > Number(fromStationCode))
    .map(({ edgeId }) => `edge-${edgeId.replaceAll(":", "-")}`));
  assert.equal(
    busanEdges.filter(({ id }) => line1ForwardIds.has(id)).reduce((sum, edge) => sum + edge.durationSeconds, 0),
    4_745,
  );
  assert.deepEqual(
    busanStationLines
      .filter(({ stationCode }) => new Set(["102", "103", "119", "201"]).has(stationCode))
      .map(({ stationId, stationCode }) => ({ stationId, stationCode })),
    [
      { stationId: "station-fcb7a21e5606", stationCode: "102" },
      { stationId: "station-dd45c69d3e40", stationCode: "103" },
      { stationId: "station-1fc7a7c971c8", stationCode: "119" },
      { stationId: "station-6b611916f76a", stationCode: "201" },
    ],
  );

  assert.throws(
    () => materializeBusanRouteTopology({
      baseFixture,
      snapshot,
      inventory,
      canonicalStationMappings,
      now: new Date(snapshot.freshUntil),
    }),
    /stale/,
  );
  const mismatchedInventory = structuredClone(inventory);
  mismatchedInventory.sources.find(({ id }) => id === snapshot.sourceId)
    .topologyAdmissionEvidence.excludedTransferCount += 1;
  assert.throws(
    () => materializeBusanRouteTopology({
      baseFixture,
      snapshot,
      inventory: mismatchedInventory,
      canonicalStationMappings,
      now: evidenceNow,
    }),
    /inventory evidence/,
  );
  const membershipMutations = [
    ["issue", (evidence) => { evidence.issue += 1; }],
    ["materializer", (evidence) => { evidence.materializer += ".tampered"; }],
    ["verificationTest", (evidence) => { evidence.verificationTest += ".tampered"; }],
    ["snapshotId", (evidence) => { evidence.snapshotId += "-tampered"; }],
    ["lineIds", (evidence) => { evidence.lineIds = [...evidence.lineIds].reverse(); }],
    ["verifiedAt", (evidence) => { evidence.verifiedAt = "2026-07-19T18:13:30.841Z"; }],
    ["stationCount", (evidence) => { evidence.stationCount -= 1; }],
    ["membershipSourceId", (evidence) => { evidence.membershipSourceId += "-tampered"; }],
    ["membershipSourceRawSha256", (evidence) => { evidence.membershipSourceRawSha256 = "0".repeat(64); }],
    ["membershipSourceSnapshotSha256", (evidence) => { evidence.membershipSourceSnapshotSha256 = "0".repeat(64); }],
    ["mappingSha256", (evidence) => { evidence.mappingSha256 = "0".repeat(64); }],
    ["stationCodesSha256", (evidence) => { evidence.stationCodesSha256 = "0".repeat(64); }],
    ["stationCodeSourceId", (evidence) => { evidence.stationCodeSourceId += "-tampered"; }],
    ["stationCodeSnapshotId", (evidence) => { evidence.stationCodeSnapshotId += "-tampered"; }],
    ["stationCodeContentSha256", (evidence) => { evidence.stationCodeContentSha256 = "0".repeat(64); }],
  ];
  for (const [field, mutate] of membershipMutations) {
    const mismatchedMembership = structuredClone(inventory);
    const membershipEvidence = mismatchedMembership.sources.find(({ id }) => id === snapshot.sourceId)
      .membershipAdmissionEvidence;
    mutate(membershipEvidence);
    assert.throws(
      () => materializeBusanRouteTopology({
        baseFixture,
        snapshot,
        inventory: mismatchedMembership,
        canonicalStationMappings,
        now: evidenceNow,
      }),
      /membership evidence/,
      field,
    );
  }
  const tamperedMappings = new Map(canonicalStationMappings);
  tamperedMappings.set("line-ab1a041f6266:하단", "station-deadbeefdead");
  assert.throws(
    () => materializeBusanRouteTopology({
      baseFixture,
      snapshot,
      inventory,
      canonicalStationMappings: tamperedMappings,
      now: evidenceNow,
    }),
    /membership evidence/,
  );
  const incompleteMappings = new Map(canonicalStationMappings);
  incompleteMappings.delete("line-ab1a041f6266:하단");
  assert.throws(
    () => materializeBusanRouteTopology({
      baseFixture,
      snapshot,
      inventory,
      canonicalStationMappings: incompleteMappings,
      now: evidenceNow,
    }),
    /canonical station mapping missing/,
  );
  const sourceMetadataMutations = [
    ["regionIds", (source) => { source.coverageScope.regionIds = []; }],
    ["operatorIds", (source) => { source.coverageScope.operatorIds = []; }],
    ["lineIds", (source) => { source.coverageScope.lineIds = source.coverageScope.lineIds.slice(1); }],
    ["sourceDomains", (source) => { source.coverageScope.sourceDomains = ["route_graph_topology"]; }],
    ["line", (source) => { source.fieldsProvided = source.fieldsProvided.filter((field) => field !== "line"); }],
    ["station_name", (source) => { source.fieldsProvided = source.fieldsProvided.filter((field) => field !== "station_name"); }],
    ["station_code", (source) => { source.fieldsProvided = source.fieldsProvided.filter((field) => field !== "station_code"); }],
  ];
  for (const [field, mutate] of sourceMetadataMutations) {
    const mismatchedMetadata = structuredClone(inventory);
    mutate(mismatchedMetadata.sources.find(({ id }) => id === snapshot.sourceId));
    assert.throws(
      () => materializeBusanRouteTopology({
        baseFixture,
        snapshot,
        inventory: mismatchedMetadata,
        canonicalStationMappings,
        now: evidenceNow,
      }),
      /membership source metadata/,
      field,
    );
  }
  const changedSourceMetadata = structuredClone(inventory);
  changedSourceMetadata.sources.find(({ id }) => id === snapshot.sourceId).updateFrequency = "daily";
  const changedFixture = materializeBusanRouteTopology({
    baseFixture,
    snapshot,
    inventory: changedSourceMetadata,
    canonicalStationMappings,
    now: evidenceNow,
  });
  assert.notEqual(changedFixture.packs[0].id, pack.id);
  const changedMaterializedContent = structuredClone(pack);
  changedMaterializedContent.stations.find(({ sourceId }) => sourceId === snapshot.sourceId).nameEn = "Changed";
  assert.notEqual(
    materializedBusanPackContentHash(changedMaterializedContent, pack.version),
    materializedBusanPackContentHash(pack, pack.version),
  );
});

test("materialized production SQLite와 provenance만 부산 4개 topology·membership requirement를 SUPPORTED로 만든다", async (context) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-busan-topology-pack-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  const fixturePath = path.join(outputDir, "fixture.json");
  const packOutput = path.join(outputDir, "pack");
  const reportPath = path.join(outputDir, "coverage.json");
  const [baseFixture, snapshot, inventory, canonicalStationMappings] = await inputs();
  const fixture = materializeBusanRouteTopology({
    baseFixture, snapshot, inventory, canonicalStationMappings, now: evidenceNow,
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
  ], {
    cwd: root,
    env: { ...process.env, EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKey },
  });

  const manifestPath = path.join(packOutput, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const sqlitePath = path.join(packOutput, new URL(manifest.packs[0].url).pathname.split("/").slice(-2).join("/")).replace(/\.gz$/, "");
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM network_edges WHERE source_id = ?",
  ).get(snapshot.sourceId).count, 220);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM station_lines WHERE line_id IN (?, ?, ?, ?)",
  ).get(...snapshot.lineIds).count, 114);
  database.close();

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
  const busan = report.requirements.filter(({ operatorId }) => operatorId === "busan-transportation");
  assert.deepEqual(
    busan.filter(({ status }) => status === "SUPPORTED").map(({ lineId, sourceDomain }) => ({ lineId, sourceDomain })),
    snapshot.lineIds.flatMap((lineId) => [
      { lineId, sourceDomain: "station_line_membership" },
      { lineId, sourceDomain: "route_graph_topology" },
    ]),
  );
});

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}
