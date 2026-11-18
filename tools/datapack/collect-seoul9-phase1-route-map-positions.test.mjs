import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { decodeOfficialCsv } from "./collect-daegu-datapack-sources.mjs";
import {
  collectSeoul9Phase1RouteMapPositions,
  parseSeoul9Phase1RouteMapPositionsCsv,
  validateSeoul9Phase1RouteMapPositionsSnapshot,
} from "./collect-seoul9-phase1-route-map-positions.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const FIXTURE_PATH = path.join(
  root,
  "tools/datapack/fixtures/seoul9-phase1-route-map-positions-raw/data-go-15041335.csv",
);
const SCHEMATIC_PATH = path.join(
  root,
  "tools/datapack/fixtures/seoul9-phase1-route-map-positions-raw/owner-self-drawn-sma-schematic-canvas-20260725.json",
);
const TOPOLOGY_PATH = path.join(root, "tools/datapack/sources/capital-route-topology-20260724.json");
const SNAPSHOT_PATH = path.join(
  root,
  "tools/datapack/sources/kric-seoul-metro-line9-1-route-map-positions-20260725.json",
);
const METRO_MAP_PACK_DIR = path.join(root, "apps/mobile/assets/datapacks/metro_map_pack");
const CAPITAL_SQLITE_GZ = path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz");
const capturedAt = "2026-07-25T05:00:00.000Z";
const SCHEMATIC_X_MIN = 694;
const SCHEMATIC_X_MAX = 2219;
const SCHEMATIC_Y_MIN = 995;
const SCHEMATIC_Y_MAX = 1863;
const GEO_SCALE_FLOOR = 5000;
const EXPECTED_RAW_SHA256 = "94dc9303e292472e63b8630781a17cdd58423c04dfe4488214e0d84b6a935fe6";
const SOURCE_ID = "kric-seoul-metro-line9-1-route-map-positions";
const LINE_ID = "line-f0e747248a31";
const DOWNLOAD_URL =
  "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003521195&fileDetailSn=1&insertDataPrcus=N";

async function loadInputs() {
  const [csvBytes, topologySnapshot, schematicCanvas] = await Promise.all([
    readFile(FIXTURE_PATH),
    readFile(TOPOLOGY_PATH, "utf8").then(JSON.parse),
    readFile(SCHEMATIC_PATH, "utf8").then(JSON.parse),
  ]);
  return { csvBytes, topologySnapshot, schematicCanvas };
}

test("수도권 9호선 1단계 공식 FILE 위경도 + schematic canvas를 25역 snapshot으로 결속한다", async () => {
  const { csvBytes, topologySnapshot, schematicCanvas } = await loadInputs();
  const snapshot = collectSeoul9Phase1RouteMapPositions({
    csvBytes,
    topologySnapshot,
    schematicCanvas,
    now: new Date(capturedAt),
  });

  assert.equal(snapshot.artifactKind, "seoul9-phase1-route-map-positions-snapshot");
  assert.equal(snapshot.sourceId, SOURCE_ID);
  assert.equal(snapshot.datasetId, "15041335");
  assert.deepEqual(snapshot.datasetIds, ["15041335"]);
  assert.equal(snapshot.downloadUrl, DOWNLOAD_URL);
  assert.equal(snapshot.rawStationCount, 25);
  assert.equal(snapshot.stationCount, 25);
  assert.equal(snapshot.quarantinedCount, 0);
  assert.deepEqual(snapshot.lineStationCounts, { "9": 25 });
  assert.deepEqual(snapshot.lineIds, [LINE_ID]);
  assert.deepEqual(snapshot.quarantinedPositions, []);
  assert.equal(snapshot.credentialRequired, false);
  assert.equal(snapshot.credentialRedacted, true);
  assert.equal(snapshot.observedDataUpdatedAt, "2025-06-30");
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

  const gaehwa = snapshot.positions.find(({ stationCode }) => stationCode === "901");
  assert.equal(gaehwa.stationName, "개화");
  assert.equal(gaehwa.lineId, LINE_ID);
  assert.ok(Number.isFinite(gaehwa.latitude) && gaehwa.latitude > 37);
  assert.ok(Number.isFinite(gaehwa.longitude) && gaehwa.longitude > 126);
  assert.ok(Number.isInteger(gaehwa.x) && gaehwa.x >= SCHEMATIC_X_MIN && gaehwa.x <= SCHEMATIC_X_MAX);
  assert.ok(Number.isInteger(gaehwa.y) && gaehwa.y >= SCHEMATIC_Y_MIN && gaehwa.y <= SCHEMATIC_Y_MAX);
  assert.ok(gaehwa.x < GEO_SCALE_FLOOR && gaehwa.y < GEO_SCALE_FLOOR);
  assert.equal(gaehwa.labelPolygon.length, 4);

  const sinnonhyeon = snapshot.positions.find(({ stationCode }) => stationCode === "925");
  assert.equal(sinnonhyeon.stationName, "신논현");
  assert.ok(sinnonhyeon.x >= SCHEMATIC_X_MIN && sinnonhyeon.x <= SCHEMATIC_X_MAX);
  assert.ok(sinnonhyeon.y >= SCHEMATIC_Y_MIN && sinnonhyeon.y <= SCHEMATIC_Y_MAX);

  const dongjak = snapshot.positions.find(({ stationCode }) => stationCode === "920");
  assert.equal(dongjak.stationName, "동작");
  const heukseok = snapshot.positions.find(({ stationCode }) => stationCode === "919");
  assert.equal(heukseok.stationName, "흑석");

  for (const position of snapshot.positions) {
    assert.ok(position.x >= SCHEMATIC_X_MIN && position.x <= SCHEMATIC_X_MAX, position.stationName);
    assert.ok(position.y >= SCHEMATIC_Y_MIN && position.y <= SCHEMATIC_Y_MAX, position.stationName);
    assert.ok(position.x < GEO_SCALE_FLOOR && position.y < GEO_SCALE_FLOOR, position.stationName);
    assert.ok(Number.isFinite(position.latitude) && Number.isFinite(position.longitude), position.stationName);
  }

  assert.deepEqual(
    snapshot.positions.map(({ stationCode }) => stationCode),
    Array.from({ length: 25 }, (_, index) => String(901 + index)),
  );
  assert.equal(
    snapshot.positions.some(({ stationName }) => ["언주", "중앙보훈병원", "올림픽공원"].includes(stationName)),
    false,
  );
  assert.equal(validateSeoul9Phase1RouteMapPositionsSnapshot(snapshot), snapshot);
  assert.doesNotMatch(JSON.stringify(snapshot), /serviceKey/i);
});

test("topology/schematic 미매칭은 fail closed 한다", async () => {
  const { csvBytes, topologySnapshot, schematicCanvas } = await loadInputs();
  const brokenTopology = structuredClone(topologySnapshot);
  const line = brokenTopology.lines.find(({ lineId }) => lineId === LINE_ID);
  const target = line.scope.find(({ stationName }) => stationName === "개화");
  target.stationName = "가짜개화";
  assert.throws(
    () => parseSeoul9Phase1RouteMapPositionsCsv({
      csvBytes,
      topologySnapshot: brokenTopology,
      schematicCanvas,
    }),
    /topology name missing|topology line contentSha256 mismatch|topology/,
  );

  const missingCanvas = structuredClone(schematicCanvas);
  missingCanvas.stations = missingCanvas.stations.filter(({ stationName }) => stationName !== "개화");
  assert.throws(
    () => parseSeoul9Phase1RouteMapPositionsCsv({
      csvBytes,
      topologySnapshot,
      schematicCanvas: missingCanvas,
    }),
    /schematic canvas/,
  );
});

test("snapshot hash나 좌표가 바뀌면 admission을 거부한다", async () => {
  const { csvBytes, topologySnapshot, schematicCanvas } = await loadInputs();
  const snapshot = collectSeoul9Phase1RouteMapPositions({
    csvBytes,
    topologySnapshot,
    schematicCanvas,
    now: new Date(capturedAt),
  });
  const tampered = structuredClone(snapshot);
  tampered.positions[0].x += 1;
  assert.throws(
    () => validateSeoul9Phase1RouteMapPositionsSnapshot(tampered),
    /invalid Seoul9 phase1 route map positions snapshot/,
  );
});

test("#2500 inventory·candidate는 snapshot byte identity와 자유 이용 근거를 고정한다", async () => {
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
  assert.equal(source.license.evidenceUrl, "https://www.data.go.kr/data/15041335/fileData.do");
  assert.deepEqual(source.coverageScope.operatorIds, ["operator-936e454d0bfb"]);
  assert.equal(source.coverageScope.operatorIds.includes("seoul-metro"), false);
  assert.equal(source.routeMapAdmissionEvidence.admissionKind, "official-file-latlon");
  assert.equal(source.routeMapAdmissionEvidence.issue, 2500);
  assert.equal(
    source.routeMapAdmissionEvidence.snapshotSha256,
    createHash("sha256").update(snapshotBytes).digest("hex"),
  );
  assert.equal(
    source.routeMapAdmissionEvidence.snapshotSha256,
    "c42e4430e3d25f0d821324e96080235713c70811230ccde8881ffac97f4c23ac",
  );
  assert.equal(candidate.admissionStatus, "production_route_map_positions_materialized");
  assert.equal(candidate.apiCatalog, false);
  assert.equal(candidate.evidence.coverageAssessment.requirementCount, 1);
  assert.equal(candidate.evidence.coverageAssessment.state, "SUPPORTED");
  assert.equal(JSON.parse(snapshotBytes).stationCount, 25);
  assert.equal(JSON.parse(snapshotBytes).rawStationCount, 25);
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
