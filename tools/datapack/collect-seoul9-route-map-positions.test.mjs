import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { decodeOfficialCsv } from "./collect-daegu-datapack-sources.mjs";
import {
  collectSeoul9RouteMapPositions,
  parseSeoul9RouteMapPositionsCsv,
  validateSeoul9RouteMapPositionsSnapshot,
} from "./collect-seoul9-route-map-positions.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const FIXTURE_PATH = path.join(
  root,
  "tools/datapack/fixtures/seoul9-route-map-positions-raw/data-go-15099317.csv",
);
const SCHEMATIC_PATH = path.join(
  root,
  "tools/datapack/fixtures/seoul9-route-map-positions-raw/owner-self-drawn-sma-schematic-canvas-20260725.json",
);
const TOPOLOGY_PATH = path.join(root, "tools/datapack/sources/capital-route-topology-20260724.json");
const SNAPSHOT_PATH = path.join(
  root,
  "tools/datapack/sources/seoul-metro-line9-23-route-map-positions-20260725.json",
);
const METRO_MAP_PACK_DIR = path.join(root, "apps/mobile/assets/datapacks/metro_map_pack");
const CAPITAL_SQLITE_GZ = path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz");
const capturedAt = "2026-07-25T04:00:00.000Z";
const SCHEMATIC_X_MIN = 2284;
const SCHEMATIC_X_MAX = 3171;
const SCHEMATIC_Y_MIN = 1620;
const SCHEMATIC_Y_MAX = 1993;
const GEO_SCALE_FLOOR = 5000;
const EXPECTED_RAW_SHA256 = "6a8b48ff370e9a364986ec10670fa934033ec88d569b3dc2f7f2b7b1e5acd683";
const SOURCE_ID = "seoul-metro-line9-23-route-map-positions";
const LINE_ID = "line-f0e747248a31";
const DOWNLOAD_URL =
  "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003599702&fileDetailSn=1&insertDataPrcus=N";

async function loadInputs() {
  const [csvBytes, topologySnapshot, schematicCanvas] = await Promise.all([
    readFile(FIXTURE_PATH),
    readFile(TOPOLOGY_PATH, "utf8").then(JSON.parse),
    readFile(SCHEMATIC_PATH, "utf8").then(JSON.parse),
  ]);
  return { csvBytes, topologySnapshot, schematicCanvas };
}

test("서울 9호선 2·3단계 공식 FILE 위경도 + schematic canvas를 13역 snapshot으로 결속한다", async () => {
  const { csvBytes, topologySnapshot, schematicCanvas } = await loadInputs();
  const snapshot = collectSeoul9RouteMapPositions({
    csvBytes,
    topologySnapshot,
    schematicCanvas,
    now: new Date(capturedAt),
  });

  assert.equal(snapshot.artifactKind, "seoul9-route-map-positions-snapshot");
  assert.equal(snapshot.sourceId, SOURCE_ID);
  assert.equal(snapshot.datasetId, "15099317");
  assert.deepEqual(snapshot.datasetIds, ["15099317"]);
  assert.equal(snapshot.downloadUrl, DOWNLOAD_URL);
  assert.equal(snapshot.rawStationCount, 13);
  assert.equal(snapshot.stationCount, 13);
  assert.equal(snapshot.quarantinedCount, 0);
  assert.deepEqual(snapshot.lineStationCounts, { "9": 13 });
  assert.deepEqual(snapshot.lineIds, [LINE_ID]);
  assert.deepEqual(snapshot.quarantinedPositions, []);
  assert.equal(snapshot.credentialRequired, false);
  assert.equal(snapshot.credentialRedacted, true);
  assert.equal(snapshot.observedDataUpdatedAt, "2026-01-31");
  assert.equal(snapshot.topologySourceId, "capital-route-topology");
  assert.equal(snapshot.topologySnapshotId, "capital-route-topology-20260724");
  assert.equal(snapshot.schematicCanvasSourceId, "owner-self-drawn-sma-schematic");
  assert.equal(snapshot.topologyContentSha256, topologySnapshot.contentSha256);
  assert.equal(snapshot.rawSha256, EXPECTED_RAW_SHA256);
  assert.equal(
    snapshot.rawSha256,
    createHash("sha256").update(csvBytes).digest("hex"),
  );
  assert.equal(snapshot.positionsSha256, createHash("sha256").update(JSON.stringify(snapshot.positions)).digest("hex"));

  const eonju = snapshot.positions.find(({ stationCode }) => stationCode === "926");
  assert.equal(eonju.stationName, "언주");
  assert.equal(eonju.lineId, LINE_ID);
  assert.ok(Number.isFinite(eonju.latitude) && eonju.latitude > 37);
  assert.ok(Number.isFinite(eonju.longitude) && eonju.longitude > 127);
  assert.ok(Number.isInteger(eonju.x) && eonju.x >= SCHEMATIC_X_MIN && eonju.x <= SCHEMATIC_X_MAX);
  assert.ok(Number.isInteger(eonju.y) && eonju.y >= SCHEMATIC_Y_MIN && eonju.y <= SCHEMATIC_Y_MAX);
  assert.ok(eonju.x < GEO_SCALE_FLOOR && eonju.y < GEO_SCALE_FLOOR);
  assert.equal(eonju.labelPolygon.length, 4);

  const bohun = snapshot.positions.find(({ stationCode }) => stationCode === "938");
  assert.equal(bohun.stationName, "중앙보훈병원");
  assert.ok(bohun.x >= SCHEMATIC_X_MIN && bohun.x <= SCHEMATIC_X_MAX);
  assert.ok(bohun.y >= SCHEMATIC_Y_MIN && bohun.y <= SCHEMATIC_Y_MAX);
  assert.ok(bohun.x < GEO_SCALE_FLOOR && bohun.y < GEO_SCALE_FLOOR);

  for (const position of snapshot.positions) {
    assert.ok(position.x >= SCHEMATIC_X_MIN && position.x <= SCHEMATIC_X_MAX, position.stationName);
    assert.ok(position.y >= SCHEMATIC_Y_MIN && position.y <= SCHEMATIC_Y_MAX, position.stationName);
    assert.ok(position.x < GEO_SCALE_FLOOR && position.y < GEO_SCALE_FLOOR, position.stationName);
    assert.ok(Number.isFinite(position.latitude) && Number.isFinite(position.longitude), position.stationName);
  }

  assert.deepEqual(
    snapshot.positions.map(({ stationCode }) => stationCode),
    Array.from({ length: 13 }, (_, index) => String(926 + index)),
  );
  assert.equal(validateSeoul9RouteMapPositionsSnapshot(snapshot), snapshot);
  assert.doesNotMatch(JSON.stringify(snapshot), /serviceKey/i);
});

test("topology/schematic 미매칭은 fail closed 한다", async () => {
  const { csvBytes, topologySnapshot, schematicCanvas } = await loadInputs();
  const brokenTopology = structuredClone(topologySnapshot);
  const line = brokenTopology.lines.find(({ lineId }) => lineId === LINE_ID);
  const target = line.scope.find(({ stationName }) => stationName === "언주");
  target.stationName = "가짜언주";
  assert.throws(
    () => parseSeoul9RouteMapPositionsCsv({
      csvBytes,
      topologySnapshot: brokenTopology,
      schematicCanvas,
    }),
    /topology name missing|topology line contentSha256 mismatch|topology/,
  );

  const missingCanvas = structuredClone(schematicCanvas);
  missingCanvas.stations = missingCanvas.stations.filter(({ stationName }) => stationName !== "언주");
  assert.throws(
    () => parseSeoul9RouteMapPositionsCsv({
      csvBytes,
      topologySnapshot,
      schematicCanvas: missingCanvas,
    }),
    /schematic canvas/,
  );
});

test("snapshot hash나 좌표가 바뀌면 admission을 거부한다", async () => {
  const { csvBytes, topologySnapshot, schematicCanvas } = await loadInputs();
  const snapshot = collectSeoul9RouteMapPositions({
    csvBytes,
    topologySnapshot,
    schematicCanvas,
    now: new Date(capturedAt),
  });
  const tampered = structuredClone(snapshot);
  tampered.positions[0].x += 1;
  assert.throws(
    () => validateSeoul9RouteMapPositionsSnapshot(tampered),
    /invalid Seoul9 route map positions snapshot/,
  );
});

test("#2498 inventory·candidate는 snapshot byte identity와 자유 이용 근거를 고정한다", async () => {
  const [snapshotBytes, inventory, candidates] = await Promise.all([
    readFile(SNAPSHOT_PATH),
    readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/source-candidates.json"), "utf8").then(JSON.parse),
  ]);
  const source = inventory.sources.find(({ id }) => id === SOURCE_ID);
  const candidate = candidates.candidates.find(({ id }) => id === source.id);
  assert.equal(source.productionUseAllowed, true);
  assert.equal(source.license.redistributionAllowed, true);
  assert.equal(source.license.derivativeWorkAllowed, true);
  assert.equal(source.license.evidenceUrl, "https://www.data.go.kr/data/15099317/fileData.do");
  assert.equal(source.routeMapAdmissionEvidence.admissionKind, "official-file-latlon");
  assert.equal(source.routeMapAdmissionEvidence.issue, 2498);
  assert.equal(
    source.routeMapAdmissionEvidence.snapshotSha256,
    createHash("sha256").update(snapshotBytes).digest("hex"),
  );
  assert.equal(
    source.routeMapAdmissionEvidence.snapshotSha256,
    "2db140beb94048ca65df3ef455bf45bafa2939812776d4944fe0c73da3517d53",
  );
  assert.equal(candidate.admissionStatus, "production_route_map_positions_materialized");
  assert.equal(candidate.apiCatalog, false);
  assert.equal(candidate.evidence.coverageAssessment.requirementCount, 1);
  assert.equal(candidate.evidence.coverageAssessment.state, "SUPPORTED");
  assert.equal(JSON.parse(snapshotBytes).stationCount, 13);
  assert.equal(JSON.parse(snapshotBytes).rawStationCount, 13);
  assert.equal(JSON.parse(snapshotBytes).schematicCanvasSourceId, "owner-self-drawn-sma-schematic");
});

test("fixture CSV는 trailing whitespace와 EOF 빈 줄이 없다", async () => {
  const bytes = await readFile(FIXTURE_PATH);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), EXPECTED_RAW_SHA256);
  assert.equal(bytes.includes(0x0d), false, "CRLF must be LF-normalized for git diff --check");
  assert.equal(bytes[bytes.length - 1], 0x0a);
  assert.notEqual(bytes[bytes.length - 2], 0x0a);
  const text = decodeOfficialCsv(bytes);
  assert.equal(text.endsWith("\n"), true);
  assert.equal(text.endsWith("\n\n"), false);
  for (const line of text.split("\n").slice(0, -1)) {
    assert.equal(/[ \t]$/.test(line), false, `trailing whitespace: ${line}`);
  }
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
