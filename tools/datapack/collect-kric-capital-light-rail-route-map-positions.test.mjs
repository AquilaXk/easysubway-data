import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { decodeOfficialCsv } from "./collect-daegu-datapack-sources.mjs";
import {
  collectCapitalLightRailRouteMapPositions,
  listCapitalLightRailRouteMapPositionLines,
  parseCapitalLightRailRouteMapPositionsCsv,
  validateCapitalLightRailRouteMapPositionsSnapshot,
} from "./collect-kric-capital-light-rail-route-map-positions.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const FIXTURE_ROOT = path.join(
  root,
  "tools/datapack/fixtures/capital-light-rail-route-map-positions-raw",
);
const OVERLAY_PATH = path.join(
  FIXTURE_ROOT,
  "shared/kric-1294-overlay-shinbundang-ui.csv",
);
const TOPOLOGY_PATH = path.join(root, "tools/datapack/sources/capital-route-topology-20260724.json");
const capturedAt = "2026-07-25T06:00:00.000Z";
const GEO_SCALE_FLOOR = 5000;

const LINE_FIXTURES = Object.freeze([
  {
    key: "shinbundang",
    sourceId: "kric-shinbundang-route-map-positions",
    input: "data-go-15041337.csv",
    admit: 16,
    quarantine: 0,
    rawSha256: "3be638e4c7e6272263abdf2803cd16b9c351bd027356cb10f348574ce4d1dea6",
    needsOverlay: true,
    overlayNames: ["상현"],
  },
  {
    key: "everline",
    sourceId: "kric-everline-route-map-positions",
    input: "data-go-15041326.csv",
    admit: 14,
    quarantine: 0,
    rawSha256: "2160020177352775418c863ebd9846ab5cc0df08c1da0f4b435dbf599b214187",
  },
  {
    key: "ui",
    sourceId: "kric-ui-sinseol-route-map-positions",
    input: "data-go-15041324-stations.csv",
    admit: 12,
    quarantine: 0,
    rawSha256: "fe2d8d0b24d16561c8fbbafe1b2b8bf1bb67bb24ca0c200bae222f502fefe055",
    needsOverlay: true,
    overlayNames: [
      "4.19민주묘지", "가오리", "보문", "북한산보국문", "북한산우이",
      "삼양", "삼양사거리", "성신여대입구", "솔밭공원", "솔샘", "정릉", "화계",
    ],
  },
  {
    key: "sillim",
    sourceId: "kric-sillim-route-map-positions",
    input: "kric-sillim-filtered-stations.csv",
    admit: 11,
    quarantine: 0,
    rawSha256: "cea37a7e668eca50d6fbeda97b8c7e0d9bcf6b763046b005238e5143a02cac77",
  },
  {
    key: "gimpo",
    sourceId: "kric-gimpo-goldline-route-map-positions",
    input: "kric-gimpo-goldline-filtered-stations.csv",
    admit: 10,
    quarantine: 0,
    rawSha256: "4008595334630331f68e0fe4aebe3ed5ed8d1cd102ad9b14ea6e0c604fab578d",
  },
]);

async function loadLine(line) {
  const reads = [
    readFile(path.join(FIXTURE_ROOT, line.key, line.input)),
    readFile(TOPOLOGY_PATH, "utf8").then(JSON.parse),
    readFile(
      path.join(FIXTURE_ROOT, line.key, "owner-self-drawn-sma-schematic-canvas-20260725.json"),
      "utf8",
    ).then(JSON.parse),
  ];
  if (line.needsOverlay) reads.push(readFile(OVERLAY_PATH));
  const [csvBytes, topologySnapshot, schematicCanvas, overlayCsvBytes = null] = await Promise.all(reads);
  return { csvBytes, topologySnapshot, schematicCanvas, overlayCsvBytes };
}

test("수도권 경전철 5노선 공식 FILE 위경도 + schematic canvas snapshot을 quarantine 0으로 결속한다", async () => {
  assert.equal(listCapitalLightRailRouteMapPositionLines().length, 5);
  for (const line of LINE_FIXTURES) {
    const { csvBytes, topologySnapshot, schematicCanvas, overlayCsvBytes } = await loadLine(line);
    const snapshot = collectCapitalLightRailRouteMapPositions({
      lineKey: line.key,
      csvBytes,
      overlayCsvBytes,
      topologySnapshot,
      schematicCanvas,
      now: new Date(capturedAt),
    });
    assert.equal(snapshot.artifactKind, "capital-light-rail-route-map-positions-snapshot");
    assert.equal(snapshot.sourceId, line.sourceId);
    assert.equal(snapshot.stationCount, line.admit);
    assert.equal(snapshot.quarantinedCount, 0);
    assert.equal(snapshot.rawStationCount, line.admit);
    assert.deepEqual(snapshot.quarantinedPositions, []);
    assert.equal(snapshot.credentialRequired, false);
    assert.equal(snapshot.schematicCanvasSourceId, "owner-self-drawn-sma-schematic");
    assert.equal(snapshot.topologySnapshotId, "capital-route-topology-20260724");
    assert.equal(snapshot.rawSha256, line.rawSha256);
    assert.equal(snapshot.rawSha256, createHash("sha256").update(csvBytes).digest("hex"));
    assert.equal(
      snapshot.positionsSha256,
      createHash("sha256").update(JSON.stringify(snapshot.positions)).digest("hex"),
    );
    for (const position of snapshot.positions) {
      assert.ok(Number.isInteger(position.x) && Number.isInteger(position.y), position.stationName);
      assert.ok(position.x < GEO_SCALE_FLOOR && position.y < GEO_SCALE_FLOOR, position.stationName);
      assert.ok(Number.isFinite(position.latitude) && Number.isFinite(position.longitude));
      assert.equal(position.labelPolygon.length, 4);
    }
    if (line.overlayNames) {
      assert.deepEqual(new Set(snapshot.overlayStationNames), new Set(line.overlayNames));
      assert.equal(snapshot.overlayDatasetId, "1294");
      assert.match(snapshot.license.attribution, /1294/);
    }
    assert.equal(validateCapitalLightRailRouteMapPositionsSnapshot(snapshot), snapshot);
    const committed = JSON.parse(await readFile(
      path.join(root, "tools/datapack/sources", `${line.sourceId}-20260725.json`),
      "utf8",
    ));
    assert.equal(committed.positionsSha256, snapshot.positionsSha256);
    assert.equal(committed.rawSha256, snapshot.rawSha256);
    assert.equal(committed.quarantinedCount, 0);
    assert.doesNotMatch(JSON.stringify(snapshot), /serviceKey/i);
  }
});

test("에버라인 FILE 잉여(전대·에버랜드)는 무시하고 운동장·송담대 rename join한다", async () => {
  const line = LINE_FIXTURES.find(({ key }) => key === "everline");
  const { csvBytes, topologySnapshot, schematicCanvas } = await loadLine(line);
  const { positions, quarantinedPositions } = parseCapitalLightRailRouteMapPositionsCsv({
    lineKey: "everline",
    csvBytes,
    topologySnapshot,
    schematicCanvas,
  });
  assert.equal(positions.length, 14);
  assert.deepEqual(quarantinedPositions, []);
  assert.ok(positions.some(({ stationName }) => stationName === "용인중앙시장"));
  assert.equal(positions.some(({ stationName }) => stationName.includes("에버랜드")), false);
});

test("신분당 상현·우이신설 전역 empty lat/lon은 KRIC 1294 overlay로 admit한다", async () => {
  for (const key of ["shinbundang", "ui"]) {
    const line = LINE_FIXTURES.find((entry) => entry.key === key);
    const { csvBytes, topologySnapshot, schematicCanvas, overlayCsvBytes } = await loadLine(line);
    const snapshot = collectCapitalLightRailRouteMapPositions({
      lineKey: key,
      csvBytes,
      overlayCsvBytes,
      topologySnapshot,
      schematicCanvas,
      now: new Date(capturedAt),
    });
    assert.equal(snapshot.quarantinedCount, 0);
    for (const name of line.overlayNames) {
      const position = snapshot.positions.find(({ stationName }) => stationName === name);
      assert.ok(position, name);
      assert.equal(position.coordinateSourceDatasetId, "1294");
      assert.ok(Number.isFinite(position.latitude) && Number.isFinite(position.longitude));
    }
  }
});

test("topology/schematic 미매칭은 fail closed 한다", async () => {
  const line = LINE_FIXTURES.find(({ key }) => key === "gimpo");
  const { csvBytes, topologySnapshot, schematicCanvas } = await loadLine(line);
  const brokenTopology = structuredClone(topologySnapshot);
  const topologyLine = brokenTopology.lines.find(({ lineId }) => lineId === "line-5500c1600f71");
  const target = topologyLine.scope.find(({ stationName }) => stationName === "양촌");
  target.stationName = "가짜양촌";
  assert.throws(
    () => parseCapitalLightRailRouteMapPositionsCsv({
      lineKey: "gimpo",
      csvBytes,
      topologySnapshot: brokenTopology,
      schematicCanvas,
    }),
    /topology name missing|topology line contentSha256 mismatch|topology/,
  );

  const missingCanvas = structuredClone(schematicCanvas);
  missingCanvas.stations = missingCanvas.stations.filter(({ stationName }) => stationName !== "양촌");
  assert.throws(
    () => parseCapitalLightRailRouteMapPositionsCsv({
      lineKey: "gimpo",
      csvBytes,
      topologySnapshot,
      schematicCanvas: missingCanvas,
    }),
    /schematic canvas/,
  );
});

test("#2505 inventory·candidate는 snapshot byte identity와 자유 이용 근거를 고정한다", async () => {
  const [inventory, candidates] = await Promise.all([
    readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/source-candidates.json"), "utf8").then(JSON.parse),
  ]);
  for (const line of LINE_FIXTURES) {
    const snapshotBytes = await readFile(
      path.join(root, "tools/datapack/sources", `${line.sourceId}-20260725.json`),
    );
    const source = inventory.sources.find(({ id }) => id === line.sourceId);
    const candidate = candidates.candidates.find(({ id }) => id === line.sourceId);
    assert.equal(source.productionUseAllowed, true);
    assert.equal(source.license.redistributionAllowed, true);
    assert.equal(source.routeMapAdmissionEvidence.admissionKind, "official-file-latlon");
    assert.equal(source.routeMapAdmissionEvidence.issue, 2505);
    assert.equal(source.routeMapAdmissionEvidence.quarantinedCount, 0);
    assert.equal(source.routeMapAdmissionEvidence.stationCount, line.admit);
    assert.equal(
      source.routeMapAdmissionEvidence.snapshotSha256,
      createHash("sha256").update(snapshotBytes).digest("hex"),
    );
    assert.equal(candidate.admissionStatus, "production_route_map_positions_materialized");
    assert.equal(candidate.apiCatalog, false);
    assert.equal(candidate.serviceKeyHandling, "not_required");
    assert.equal(candidate.evidence.coverageAssessment.state, "SUPPORTED");
  }
});

test("fixture CSV는 trailing whitespace와 EOF 빈 줄이 없다", async () => {
  for (const line of LINE_FIXTURES) {
    const bytes = await readFile(path.join(FIXTURE_ROOT, line.key, line.input));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), line.rawSha256);
    assert.equal(bytes.includes(0x0d), false, `${line.key} CRLF must be LF-normalized`);
    assert.equal(bytes[bytes.length - 1], 0x0a);
    assert.notEqual(bytes[bytes.length - 2], 0x0a);
    const text = decodeOfficialCsv(bytes);
    assert.equal(text.endsWith("\n"), true);
    assert.equal(text.endsWith("\n\n"), false);
    for (const row of text.split("\n").slice(0, -1)) {
      assert.equal(/[ \t]$/.test(row), false, `trailing whitespace: ${row}`);
    }
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
});
