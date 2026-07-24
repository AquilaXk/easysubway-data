import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  collectDaejeonRouteMapPositions,
  parseDaejeonRouteMapPositionsXlsx,
  validateDaejeonRouteMapPositionsSnapshot,
} from "./collect-daejeon-route-map-positions.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const FIXTURE_PATH = path.join(
  root,
  "tools/datapack/fixtures/daejeon-route-map-positions-raw/kric-metropolitan-rail-station-info-20260630.xlsx",
);
const SCHEMATIC_PATH = path.join(
  root,
  "tools/datapack/fixtures/daejeon-route-map-positions-raw/owner-self-drawn-sma-schematic-canvas-20260725.json",
);
const TOPOLOGY_PATH = path.join(root, "tools/datapack/sources/daejeon-route-topology-20260720.json");
const SNAPSHOT_PATH = path.join(root, "tools/datapack/sources/daejeon-transportation-route-map-positions-20260725.json");
const METRO_MAP_PACK_DIR = path.join(root, "apps/mobile/assets/datapacks/metro_map_pack");
const CAPITAL_SQLITE_GZ = path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz");
const capturedAt = "2026-07-25T03:00:00.000Z";
const SCHEMATIC_X_MIN = 540;
const SCHEMATIC_X_MAX = 1584;
const SCHEMATIC_Y_MIN = 240;
const SCHEMATIC_Y_MAX = 1560;
const GEO_SCALE_FLOOR = 5000;
const EXPECTED_RAW_SHA256 = "cdf1d84a7e5c898b2aacd622783ba8ba9af35c40bee0561dc97d55ce8e063f94";

async function loadInputs() {
  const [xlsxBytes, topologySnapshot, schematicCanvas] = await Promise.all([
    readFile(FIXTURE_PATH),
    readFile(TOPOLOGY_PATH, "utf8").then(JSON.parse),
    readFile(SCHEMATIC_PATH, "utf8").then(JSON.parse),
  ]);
  return { xlsxBytes, topologySnapshot, schematicCanvas };
}

test("대전 공식 KRIC FILE 위경도 + schematic canvas를 1호선 22역 snapshot으로 결속한다", async () => {
  const { xlsxBytes, topologySnapshot, schematicCanvas } = await loadInputs();
  const snapshot = collectDaejeonRouteMapPositions({
    xlsxBytes,
    topologySnapshot,
    schematicCanvas,
    now: new Date(capturedAt),
  });

  assert.equal(snapshot.artifactKind, "daejeon-route-map-positions-snapshot");
  assert.equal(snapshot.sourceId, "daejeon-transportation-route-map-positions");
  assert.equal(snapshot.datasetId, "32");
  assert.deepEqual(snapshot.datasetIds, ["32"]);
  assert.equal(
    snapshot.downloadUrl,
    "https://data.kric.go.kr/rips/dataset/download.file?type=filedata&id=32&operation=1",
  );
  assert.equal(snapshot.detailUrl, "https://data.kric.go.kr/rips/M_01_01/detail.do?id=32");
  assert.equal(snapshot.rawStationCount, 22);
  assert.equal(snapshot.stationCount, 22);
  assert.equal(snapshot.quarantinedCount, 0);
  assert.deepEqual(snapshot.lineStationCounts, { "1": 22 });
  assert.deepEqual(snapshot.lineIds, ["line-7051a9c2525c"]);
  assert.deepEqual(snapshot.quarantinedPositions, []);
  assert.equal(snapshot.credentialRequired, false);
  assert.equal(snapshot.credentialRedacted, true);
  assert.equal(snapshot.observedDataUpdatedAt, "2026-06-25");
  assert.equal(snapshot.topologySourceId, "daejeon-station-distance-fare");
  assert.equal(snapshot.topologySnapshotId, "daejeon-station-distance-fare-topology-20260720");
  assert.equal(snapshot.schematicCanvasSourceId, "owner-self-drawn-sma-schematic");
  assert.equal(snapshot.topologyContentSha256, topologySnapshot.contentSha256);
  assert.equal(snapshot.rawSha256, EXPECTED_RAW_SHA256);
  assert.equal(
    snapshot.rawSha256,
    createHash("sha256").update(xlsxBytes).digest("hex"),
  );
  assert.equal(snapshot.positionsSha256, createHash("sha256").update(JSON.stringify(snapshot.positions)).digest("hex"));

  const panam = snapshot.positions.find(({ stationCode }) => stationCode === "101");
  assert.equal(panam.stationName, "판암(대전대)");
  assert.equal(panam.lineId, "line-7051a9c2525c");
  assert.ok(Number.isFinite(panam.latitude) && panam.latitude > 36);
  assert.ok(Number.isFinite(panam.longitude) && panam.longitude > 127);
  assert.ok(Number.isInteger(panam.x) && panam.x >= SCHEMATIC_X_MIN && panam.x <= SCHEMATIC_X_MAX);
  assert.ok(Number.isInteger(panam.y) && panam.y >= SCHEMATIC_Y_MIN && panam.y <= SCHEMATIC_Y_MAX);
  assert.ok(panam.x < GEO_SCALE_FLOOR && panam.y < GEO_SCALE_FLOOR);
  assert.equal(panam.labelPolygon.length, 4);

  const yuseong = snapshot.positions.find(({ stationCode }) => stationCode === "116");
  assert.equal(yuseong.stationName, "유성온천(충남대.목원대)");
  assert.ok(yuseong.x >= SCHEMATIC_X_MIN && yuseong.x <= SCHEMATIC_X_MAX);
  assert.ok(yuseong.y >= SCHEMATIC_Y_MIN && yuseong.y <= SCHEMATIC_Y_MAX);

  for (const position of snapshot.positions) {
    assert.ok(position.x >= SCHEMATIC_X_MIN && position.x <= SCHEMATIC_X_MAX, position.stationName);
    assert.ok(position.y >= SCHEMATIC_Y_MIN && position.y <= SCHEMATIC_Y_MAX, position.stationName);
    assert.ok(position.x < GEO_SCALE_FLOOR && position.y < GEO_SCALE_FLOOR, position.stationName);
    assert.ok(Number.isFinite(position.latitude) && Number.isFinite(position.longitude), position.stationName);
  }

  assert.deepEqual(
    snapshot.positions.map(({ stationCode }) => stationCode),
    Array.from({ length: 22 }, (_, index) => String(101 + index)),
  );
  assert.equal(validateDaejeonRouteMapPositionsSnapshot(snapshot), snapshot);
  assert.doesNotMatch(JSON.stringify(snapshot), /serviceKey/i);
});

test("topology/schematic 미매칭은 fail closed 한다", async () => {
  const { xlsxBytes, topologySnapshot, schematicCanvas } = await loadInputs();
  const brokenTopology = structuredClone(topologySnapshot);
  brokenTopology.stationNumbers = brokenTopology.stationNumbers.filter((code) => code !== "101");
  assert.throws(
    () => parseDaejeonRouteMapPositionsXlsx({
      xlsxBytes,
      topologySnapshot: brokenTopology,
      schematicCanvas,
    }),
    /topology snapshot is invalid|station count mismatch|scope mismatch/,
  );
  const missingCanvas = schematicCanvas.filter(({ stationName }) => stationName !== "판암");
  assert.throws(
    () => parseDaejeonRouteMapPositionsXlsx({
      xlsxBytes,
      topologySnapshot,
      schematicCanvas: missingCanvas,
    }),
    /schematic canvas/,
  );
});

test("snapshot hash나 좌표가 바뀌면 admission을 거부한다", async () => {
  const { xlsxBytes, topologySnapshot, schematicCanvas } = await loadInputs();
  const snapshot = collectDaejeonRouteMapPositions({
    xlsxBytes,
    topologySnapshot,
    schematicCanvas,
    now: new Date(capturedAt),
  });
  const tampered = structuredClone(snapshot);
  tampered.positions[0].x += 1;
  assert.throws(() => validateDaejeonRouteMapPositionsSnapshot(tampered), /invalid Daejeon route map positions snapshot/);
});

test("#2496 inventory·candidate는 snapshot byte identity와 자유 이용 근거를 고정한다", async () => {
  const [snapshotBytes, inventory, candidates] = await Promise.all([
    readFile(SNAPSHOT_PATH),
    readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/source-candidates.json"), "utf8").then(JSON.parse),
  ]);
  const source = inventory.sources.find(({ id }) => id === "daejeon-transportation-route-map-positions");
  const candidate = candidates.candidates.find(({ id }) => id === source.id);
  assert.equal(source.productionUseAllowed, true);
  assert.equal(source.license.redistributionAllowed, true);
  assert.equal(source.license.derivativeWorkAllowed, true);
  assert.equal(source.license.evidenceUrl, "https://data.kric.go.kr/rips/M_01_01/detail.do?id=32");
  assert.equal(source.routeMapAdmissionEvidence.admissionKind, "official-file-latlon");
  assert.equal(source.routeMapAdmissionEvidence.issue, 2496);
  assert.equal(
    source.routeMapAdmissionEvidence.snapshotSha256,
    createHash("sha256").update(snapshotBytes).digest("hex"),
  );
  assert.equal(candidate.admissionStatus, "production_route_map_positions_materialized");
  assert.equal(candidate.apiCatalog, false);
  assert.equal(candidate.evidence.coverageAssessment.requirementCount, 1);
  assert.equal(candidate.evidence.coverageAssessment.state, "SUPPORTED");
  assert.equal(JSON.parse(snapshotBytes).stationCount, 22);
  assert.equal(JSON.parse(snapshotBytes).rawStationCount, 22);
  assert.equal(JSON.parse(snapshotBytes).schematicCanvasSourceId, "owner-self-drawn-sma-schematic");
  assert.match(
    await readFile(path.join(root, "tools/datapack/collect-daejeon-route-map-positions.mjs"), "utf8"),
    /rips\/dataset\/download\.file\?type=filedata&id=32&operation=1/,
  );
  assert.match(
    await readFile(path.join(root, "tools/datapack/collect-daejeon-route-map-positions.mjs"), "utf8"),
    /Wrong URL.*rips\/download\.file/,
  );
});

test("fixture XLSX rawSha256은 공식 바이트를 고정한다", async () => {
  const bytes = await readFile(FIXTURE_PATH);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), EXPECTED_RAW_SHA256);
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);
});

test("이번 변경은 metro_map_pack·capital.sqlite.gz·basemap asset을 수정하지 않는다", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync("git", [
    "diff",
    "--name-only",
    "HEAD",
    "--",
    "apps/mobile/assets/datapacks/metro_map_pack",
    "apps/mobile/assets/datapacks/capital.sqlite.gz",
    "apps/mobile/assets/basemap",
    "apps/mobile/assets/maps",
  ], { cwd: root });
  assert.equal(stdout.trim(), "");
  assert.ok((await readFile(CAPITAL_SQLITE_GZ)).byteLength > 0);
  assert.ok((await readFile(path.join(METRO_MAP_PACK_DIR, "manifest.json"), "utf8")).length > 0);
});
