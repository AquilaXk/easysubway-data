import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  collectGwangjuRouteMapPositions,
  parseGwangjuRouteMapPositionsCsv,
  validateGwangjuRouteMapPositionsSnapshot,
} from "./collect-gwangju-route-map-positions.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const FIXTURE_PATH = path.join(root, "tools/datapack/fixtures/gwangju-route-map-positions-raw/data-go-15109340.csv");
const SCHEMATIC_PATH = path.join(
  root,
  "tools/datapack/fixtures/gwangju-route-map-positions-raw/owner-self-drawn-sma-schematic-canvas-20260725.json",
);
const TOPOLOGY_PATH = path.join(root, "tools/datapack/sources/gwangju-transportation-route-topology-20260720.json");
const SNAPSHOT_PATH = path.join(root, "tools/datapack/sources/gwangju-transportation-route-map-positions-20260725.json");
const METRO_MAP_PACK_DIR = path.join(root, "apps/mobile/assets/datapacks/metro_map_pack");
const CAPITAL_SQLITE_GZ = path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz");
const capturedAt = "2026-07-25T02:00:00.000Z";
const SCHEMATIC_X_MIN = 272;
const SCHEMATIC_X_MAX = 1882;
const SCHEMATIC_Y_MIN = 284;
const SCHEMATIC_Y_MAX = 1667;
const GEO_SCALE_FLOOR = 5000;

async function loadInputs() {
  const [csvBytes, topologySnapshot, schematicCanvas] = await Promise.all([
    readFile(FIXTURE_PATH),
    readFile(TOPOLOGY_PATH, "utf8").then(JSON.parse),
    readFile(SCHEMATIC_PATH, "utf8").then(JSON.parse),
  ]);
  return { csvBytes, topologySnapshot, schematicCanvas };
}

test("광주 공식 FILE 위경도 + schematic canvas를 1호선 20역 snapshot으로 결속한다", async () => {
  const { csvBytes, topologySnapshot, schematicCanvas } = await loadInputs();
  const snapshot = collectGwangjuRouteMapPositions({
    csvBytes,
    topologySnapshot,
    schematicCanvas,
    now: new Date(capturedAt),
  });

  assert.equal(snapshot.artifactKind, "gwangju-route-map-positions-snapshot");
  assert.equal(snapshot.sourceId, "gwangju-transportation-route-map-positions");
  assert.equal(snapshot.datasetId, "15109340");
  assert.deepEqual(snapshot.datasetIds, ["15109340"]);
  assert.equal(snapshot.rawStationCount, 20);
  assert.equal(snapshot.stationCount, 20);
  assert.equal(snapshot.quarantinedCount, 0);
  assert.deepEqual(snapshot.lineStationCounts, { "1": 20 });
  assert.deepEqual(snapshot.lineIds, ["line-e57a361e8892"]);
  assert.deepEqual(snapshot.quarantinedPositions, []);
  assert.equal(snapshot.credentialRequired, false);
  assert.equal(snapshot.credentialRedacted, true);
  assert.equal(snapshot.observedDataUpdatedAt, "2022-12-02");
  assert.equal(snapshot.topologySourceId, "gwangju-transportation-route-topology");
  assert.equal(snapshot.topologySnapshotId, "gwangju-transportation-route-topology-20260720");
  assert.equal(snapshot.schematicCanvasSourceId, "owner-self-drawn-sma-schematic");
  assert.equal(snapshot.topologyContentSha256, topologySnapshot.contentSha256);
  assert.equal(
    snapshot.rawSha256,
    createHash("sha256").update(csvBytes).digest("hex"),
  );
  assert.equal(snapshot.positionsSha256, createHash("sha256").update(JSON.stringify(snapshot.positions)).digest("hex"));

  const munhwa = snapshot.positions.find(({ stationCode }) => stationCode === "104");
  assert.equal(munhwa.stationName, "문화전당");
  assert.equal(munhwa.lineId, "line-e57a361e8892");
  assert.ok(Number.isFinite(munhwa.latitude) && munhwa.latitude > 35);
  assert.ok(Number.isFinite(munhwa.longitude) && munhwa.longitude > 126);
  assert.ok(Number.isInteger(munhwa.x) && munhwa.x >= SCHEMATIC_X_MIN && munhwa.x <= SCHEMATIC_X_MAX);
  assert.ok(Number.isInteger(munhwa.y) && munhwa.y >= SCHEMATIC_Y_MIN && munhwa.y <= SCHEMATIC_Y_MAX);
  assert.ok(munhwa.x < GEO_SCALE_FLOOR && munhwa.y < GEO_SCALE_FLOOR);
  assert.equal(munhwa.labelPolygon.length, 4);

  const songjeong = snapshot.positions.find(({ stationCode }) => stationCode === "117");
  assert.equal(songjeong.stationName, "광주송정");
  assert.ok(songjeong.x >= SCHEMATIC_X_MIN && songjeong.x <= SCHEMATIC_X_MAX);
  assert.ok(songjeong.y >= SCHEMATIC_Y_MIN && songjeong.y <= SCHEMATIC_Y_MAX);

  for (const position of snapshot.positions) {
    assert.ok(position.x >= SCHEMATIC_X_MIN && position.x <= SCHEMATIC_X_MAX, position.stationName);
    assert.ok(position.y >= SCHEMATIC_Y_MIN && position.y <= SCHEMATIC_Y_MAX, position.stationName);
    assert.ok(position.x < GEO_SCALE_FLOOR && position.y < GEO_SCALE_FLOOR, position.stationName);
    assert.ok(Number.isFinite(position.latitude) && Number.isFinite(position.longitude), position.stationName);
  }

  assert.deepEqual(
    snapshot.positions.map(({ stationCode }) => stationCode),
    Array.from({ length: 20 }, (_, index) => String(100 + index)),
  );
  assert.equal(validateGwangjuRouteMapPositionsSnapshot(snapshot), snapshot);
  assert.doesNotMatch(JSON.stringify(snapshot), /serviceKey/i);
});

test("좌표 누락·topology/schematic 미매칭은 fail closed 한다", async () => {
  const { csvBytes, topologySnapshot, schematicCanvas } = await loadInputs();
  const text = new TextDecoder().decode(csvBytes);
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  const broken = Buffer.from(lines.filter((_, index) => index !== 1).join("\n"), "utf8");
  assert.throws(
    () => parseGwangjuRouteMapPositionsCsv({ csvBytes: broken, topologySnapshot, schematicCanvas }),
    /station count mismatch|station code scope mismatch|join failed/,
  );
  const unknown = Buffer.from(
    `${lines[0]}\n999,가짜역,S2901,광주도시철도 1호선,Fake,일반역,35.15,126.85,주소,062-000-0000,2022-12-02\n${lines.slice(1).join("\n")}`,
    "utf8",
  );
  assert.throws(
    () => parseGwangjuRouteMapPositionsCsv({ csvBytes: unknown, topologySnapshot, schematicCanvas }),
    /station count mismatch|join failed|duplicate|scope mismatch/,
  );
  const missingCanvas = schematicCanvas.filter(({ stationName }) => stationName !== "문화전당");
  assert.throws(
    () => parseGwangjuRouteMapPositionsCsv({
      csvBytes,
      topologySnapshot,
      schematicCanvas: missingCanvas,
    }),
    /schematic canvas/,
  );
});

test("snapshot hash나 좌표가 바뀌면 admission을 거부한다", async () => {
  const { csvBytes, topologySnapshot, schematicCanvas } = await loadInputs();
  const snapshot = collectGwangjuRouteMapPositions({
    csvBytes,
    topologySnapshot,
    schematicCanvas,
    now: new Date(capturedAt),
  });
  const tampered = structuredClone(snapshot);
  tampered.positions[0].x += 1;
  assert.throws(() => validateGwangjuRouteMapPositionsSnapshot(tampered), /invalid Gwangju route map positions snapshot/);
});

test("#2494 inventory·candidate는 snapshot byte identity와 자유 이용 근거를 고정한다", async () => {
  const [snapshotBytes, inventory, candidates] = await Promise.all([
    readFile(SNAPSHOT_PATH),
    readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/source-candidates.json"), "utf8").then(JSON.parse),
  ]);
  const source = inventory.sources.find(({ id }) => id === "gwangju-transportation-route-map-positions");
  const candidate = candidates.candidates.find(({ id }) => id === source.id);
  assert.equal(source.productionUseAllowed, true);
  assert.equal(source.license.redistributionAllowed, true);
  assert.equal(source.license.derivativeWorkAllowed, true);
  assert.equal(source.license.evidenceUrl, "https://www.data.go.kr/data/15109340/fileData.do");
  assert.equal(source.routeMapAdmissionEvidence.admissionKind, "official-file-latlon");
  assert.equal(source.routeMapAdmissionEvidence.issue, 2494);
  assert.equal(
    source.routeMapAdmissionEvidence.snapshotSha256,
    createHash("sha256").update(snapshotBytes).digest("hex"),
  );
  assert.equal(candidate.admissionStatus, "production_route_map_positions_materialized");
  assert.equal(candidate.apiCatalog, false);
  assert.equal(candidate.evidence.coverageAssessment.requirementCount, 1);
  assert.equal(candidate.evidence.coverageAssessment.state, "SUPPORTED");
  assert.equal(JSON.parse(snapshotBytes).stationCount, 20);
  assert.equal(JSON.parse(snapshotBytes).rawStationCount, 20);
  assert.equal(JSON.parse(snapshotBytes).schematicCanvasSourceId, "owner-self-drawn-sma-schematic");
});

test("fixture CSV는 trailing whitespace와 EOF 빈 줄이 없다", async () => {
  const bytes = await readFile(FIXTURE_PATH);
  const text = bytes.toString("utf8");
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
  // 경로 존재만 확인하고 내용 변경은 git diff로 검증한다.
  assert.ok((await readFile(CAPITAL_SQLITE_GZ)).byteLength > 0);
  assert.ok((await readFile(path.join(METRO_MAP_PACK_DIR, "manifest.json"), "utf8")).length > 0);
});
