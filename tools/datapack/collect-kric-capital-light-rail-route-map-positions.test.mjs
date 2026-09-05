import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { decodeOfficialCsv } from "./collect-daegu-datapack-sources.mjs";
import {
  buildCapitalLightRailRouteMapSuccessor,
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
const OWNER_GEOMETRY_PATH = path.join(root, "tools/route-map/route-map-defs/easy-subway-sma-v4-geometry.json");
const STATION_IDENTITIES_PATH = path.join(root, "tools/route-map/route-map-defs/seoul-alignment-fixture.json");

const LINE_FIXTURES = Object.freeze([
  {
    key: "shinbundang",
    sourceId: "kric-shinbundang-route-map-positions",
    input: "data-go-15041337.csv",
    admit: 16,
    quarantine: 0,
    rawSha256: "3be638e4c7e6272263abdf2803cd16b9c351bd027356cb10f348574ce4d1dea6",
    needsOverlay: true,
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
  const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const source = inventory.sources.find(({ id }) => id === line.sourceId);
  const currentTopology = source?.routeMapAdmissionEvidence?.currentTopologyAdmission;
  const usesCurrentGeometry = ["everline", "ui"].includes(line.key);
  const topologySnapshotId = usesCurrentGeometry
    ? currentTopology?.topologySnapshotId
    : path.basename(TOPOLOGY_PATH, ".json");
  const topologyPath = path.join(root, "tools/datapack/sources", `${topologySnapshotId}.json`);
  const reads = [
    readFile(path.join(FIXTURE_ROOT, line.key, line.input)),
    readFile(topologyPath, "utf8").then(JSON.parse),
    usesCurrentGeometry
      ? readFile(OWNER_GEOMETRY_PATH, "utf8").then(JSON.parse)
      : readFile(
        path.join(FIXTURE_ROOT, line.key, "owner-self-drawn-sma-schematic-canvas-20260725.json"),
        "utf8",
      ).then(JSON.parse),
  ];
  if (usesCurrentGeometry) {
    reads.push(readFile(path.join(root, source.routeMapAdmissionEvidence.snapshotPath), "utf8").then(JSON.parse));
    reads.push(readFile(STATION_IDENTITIES_PATH, "utf8").then(JSON.parse));
  }
  if (line.needsOverlay) reads.push(readFile(OVERLAY_PATH));
  const values = await Promise.all(reads);
  const [csvBytes, topologySnapshot, schematicCanvas] = values;
  const offset = 3;
  const previousSnapshot = usesCurrentGeometry ? values[offset] : null;
  const canonicalStationIdentities = usesCurrentGeometry ? values[offset + 1] : null;
  const overlayCsvBytes = line.needsOverlay ? values[offset + (usesCurrentGeometry ? 2 : 0)] : null;
  return {
    csvBytes, topologySnapshot, topologySnapshotId, schematicCanvas, overlayCsvBytes,
    previousSnapshot, canonicalStationIdentities,
  };
}

function expectedOverlayNames(csvBytes) {
  // 공식 CSV의 좌표 결측 행에서 기대 역 집합을 구한다.
  const [header, ...rows] = decodeOfficialCsv(csvBytes).trim().split(/\r?\n/).map((row) => row.split(","));
  const stationColumn = header.indexOf("역명");
  const latitudeColumn = header.indexOf("위도");
  const longitudeColumn = header.indexOf("경도");
  assert.ok([stationColumn, latitudeColumn, longitudeColumn].every((index) => index >= 0));
  return rows.filter((row) =>
    row[latitudeColumn].trim() === "" || row[longitudeColumn].trim() === ""
  ).map((row) => row[stationColumn].trim());
}

test("수도권 경전철 5노선 공식 FILE 위경도 + schematic canvas snapshot을 quarantine 0으로 결속한다", async () => {
  assert.equal(listCapitalLightRailRouteMapPositionLines().length, 5);
  for (const line of LINE_FIXTURES) {
    const {
      csvBytes, topologySnapshot, topologySnapshotId, schematicCanvas, overlayCsvBytes,
      previousSnapshot, canonicalStationIdentities,
    } = await loadLine(line);
    const snapshot = collectCapitalLightRailRouteMapPositions({
      lineKey: line.key,
      csvBytes,
      overlayCsvBytes,
      topologySnapshot,
      topologySnapshotId,
      schematicCanvas,
      previousSnapshot,
      canonicalStationIdentities,
      now: new Date(capturedAt),
    });
    assert.equal(snapshot.artifactKind, "capital-light-rail-route-map-positions-snapshot");
    assert.equal(snapshot.sourceId, line.sourceId);
    assert.equal(snapshot.stationCount, snapshot.positions.length);
    assert.equal(snapshot.quarantinedCount, 0);
    assert.equal(snapshot.rawStationCount, snapshot.positions.length);
    assert.deepEqual(snapshot.quarantinedPositions, []);
    assert.equal(snapshot.credentialRequired, false);
    assert.equal(snapshot.schematicCanvasSourceId, "owner-self-drawn-sma-schematic");
    assert.equal(snapshot.topologySnapshotId, topologySnapshotId);
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
    if (line.needsOverlay) {
      assert.deepEqual(new Set(snapshot.overlayStationNames), new Set(expectedOverlayNames(csvBytes)));
      assert.equal(snapshot.overlayDatasetId, "1294");
      assert.match(snapshot.license.attribution, /1294/);
    }
    assert.equal(validateCapitalLightRailRouteMapPositionsSnapshot(snapshot, {
      schematicCanvas: snapshot.schematicGeometrySha256 ? schematicCanvas : null,
    }), snapshot);
    const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
    const admitted = inventory.sources.find(({ id }) => id === line.sourceId).routeMapAdmissionEvidence;
    const committed = JSON.parse(await readFile(path.join(root, admitted.snapshotPath), "utf8"));
    assert.equal(committed.positionsSha256, snapshot.positionsSha256);
    assert.equal(committed.rawSha256, snapshot.rawSha256);
    assert.equal(committed.quarantinedCount, 0);
    assert.doesNotMatch(JSON.stringify(snapshot), /serviceKey/i);
  }
});

test("에버라인 FILE 전역과 운동장·송담대 rename을 current topology에 결속한다", async () => {
  const line = LINE_FIXTURES.find(({ key }) => key === "everline");
  const catalogLine = listCapitalLightRailRouteMapPositionLines().find(({ key }) => key === line.key);
  const {
    csvBytes, topologySnapshot, schematicCanvas, previousSnapshot, canonicalStationIdentities,
  } = await loadLine(line);
  const { positions, quarantinedPositions } = parseCapitalLightRailRouteMapPositionsCsv({
    lineKey: "everline",
    csvBytes,
    topologySnapshot,
    schematicCanvas,
    previousSnapshot,
    canonicalStationIdentities,
  });
  assert.equal(
    positions.length,
    topologySnapshot.lines.find(({ lineId }) => lineId === catalogLine.lineId).stationCount,
  );
  assert.deepEqual(quarantinedPositions, []);
  assert.ok(positions.some(({ stationName }) => stationName === "용인중앙시장"));
  assert.ok(positions.some(({ stationName }) => stationName.includes("에버랜드")));
});

test("신분당 상현·우이신설 전역 empty lat/lon은 KRIC 1294 overlay로 admit한다", async () => {
  for (const key of ["shinbundang", "ui"]) {
    const line = LINE_FIXTURES.find((entry) => entry.key === key);
    const {
      csvBytes, topologySnapshot, topologySnapshotId, schematicCanvas, overlayCsvBytes,
      previousSnapshot, canonicalStationIdentities,
    } = await loadLine(line);
    const snapshot = collectCapitalLightRailRouteMapPositions({
      lineKey: key,
      csvBytes,
      overlayCsvBytes,
      topologySnapshot,
      topologySnapshotId,
      schematicCanvas,
      previousSnapshot,
      canonicalStationIdentities,
      now: new Date(capturedAt),
    });
    assert.equal(snapshot.quarantinedCount, 0);
    const overlayNames = expectedOverlayNames(csvBytes);
    assert.ok(overlayNames.length > 0);
    for (const name of overlayNames) {
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

test("persisted snapshot은 row scope와 canonical topology identity를 직접 검증한다", async () => {
  const line = LINE_FIXTURES.find(({ key }) => key === "gimpo");
  const { csvBytes, topologySnapshot, topologySnapshotId, schematicCanvas } = await loadLine(line);
  const snapshot = collectCapitalLightRailRouteMapPositions({
    lineKey: line.key,
    csvBytes,
    topologySnapshot,
    topologySnapshotId,
    schematicCanvas,
    now: new Date(capturedAt),
  });

  const emptyRows = structuredClone(snapshot);
  emptyRows.positions = [];
  emptyRows.stationCount = 0;
  emptyRows.rawStationCount = 0;
  emptyRows.lineStationCounts = { gimpo: 0 };
  emptyRows.positionsSha256 = createHash("sha256").update("[]").digest("hex");
  assert.throws(
    () => validateCapitalLightRailRouteMapPositionsSnapshot(emptyRows),
    /invalid kric-gimpo-goldline-route-map-positions route map positions snapshot/,
  );

  const arbitraryTopology = structuredClone(snapshot);
  arbitraryTopology.topologySnapshotId = "unbound-topology";
  arbitraryTopology.topologyLineages[0].snapshotId = "unbound-topology";
  assert.throws(
    () => validateCapitalLightRailRouteMapPositionsSnapshot(arbitraryTopology),
    /capital light-rail topology snapshotId is required/,
  );
});

test("#2505 inventory·candidate는 snapshot byte identity와 자유 이용 근거를 고정한다", async () => {
  const [inventory, candidates] = await Promise.all([
    readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/source-candidates.json"), "utf8").then(JSON.parse),
  ]);
  for (const line of LINE_FIXTURES) {
    const source = inventory.sources.find(({ id }) => id === line.sourceId);
    const snapshotBytes = await readFile(path.join(root, source.routeMapAdmissionEvidence.snapshotPath));
    const candidate = candidates.candidates.find(({ id }) => id === line.sourceId);
    assert.equal(source.productionUseAllowed, true);
    assert.equal(source.license.redistributionAllowed, true);
    assert.equal(source.routeMapAdmissionEvidence.admissionKind, "official-file-latlon");
    assert.equal(source.routeMapAdmissionEvidence.issue, 2505);
    assert.equal(source.routeMapAdmissionEvidence.quarantinedCount, 0);
    const snapshot = JSON.parse(snapshotBytes);
    assert.equal(source.routeMapAdmissionEvidence.stationCount, snapshot.stationCount);
    assert.equal(
      source.routeMapAdmissionEvidence.snapshotSha256,
      createHash("sha256").update(snapshotBytes).digest("hex"),
    );
    assert.equal(candidate.admissionStatus, "production_route_map_positions_materialized");
    assert.equal(candidate.apiCatalog, false);
    assert.equal(candidate.serviceKeyHandling, "not_required");
    assert.equal(candidate.evidence.coverageAssessment.state, "SUPPORTED");
    assert.equal(candidate.evidence.stationCount, snapshot.stationCount);
    assert.deepEqual(candidate.evidence.lineStationCounts, snapshot.lineStationCounts);
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

test("successor projection은 retained bytes와 current topology binding으로 결정론적으로 생성한다", async () => {
  const [inventory, candidates] = await Promise.all([
    readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/source-candidates.json"), "utf8").then(JSON.parse),
  ]);
  for (const key of ["everline", "ui"]) {
    const line = LINE_FIXTURES.find((entry) => entry.key === key);
    const source = inventory.sources.find(({ id }) => id === line.sourceId);
    const candidate = candidates.candidates.find(({ id }) => id === line.sourceId);
    const inputs = await loadLine(line);
    const previousSnapshotBytes = await readFile(path.join(root, source.routeMapAdmissionEvidence.snapshotPath));
    const originalSource = structuredClone(source);
    const originalCandidate = structuredClone(candidate);
    const collectorInputs = {
      previousSnapshotBytes,
      csvBytes: inputs.csvBytes,
      overlayCsvBytes: inputs.overlayCsvBytes,
      topologySnapshot: inputs.topologySnapshot,
      topologySnapshotId: inputs.topologySnapshotId,
      schematicCanvas: inputs.schematicCanvas,
      canonicalStationIdentities: inputs.canonicalStationIdentities,
    };
    const first = buildCapitalLightRailRouteMapSuccessor({ source, candidate, ...collectorInputs });
    const second = buildCapitalLightRailRouteMapSuccessor({ source, candidate, ...collectorInputs });
    assert.deepEqual(first, second);
    assert.deepEqual(source, originalSource);
    assert.deepEqual(candidate, originalCandidate);
    assert.equal(first.snapshotId, `${source.id}-${createHash("sha256").update(first.bytes).digest("hex")}`);
    assert.equal(path.basename(first.snapshotPath, ".json"), first.snapshotId);
    assert.equal(first.snapshot.capturedAt, inputs.previousSnapshot.capturedAt);
    assert.equal(first.snapshot.observedDataUpdatedAt, inputs.previousSnapshot.observedDataUpdatedAt);
    assert.deepEqual(first.snapshot.license, inputs.previousSnapshot.license);
    assert.equal(first.source.routeMapAdmissionEvidence.snapshotSha256, createHash("sha256").update(first.bytes).digest("hex"));
    assert.equal(first.source.routeMapAdmissionEvidence.currentTopologyAdmission.positionSnapshotSha256, first.source.routeMapAdmissionEvidence.snapshotSha256);
    assert.equal(first.source.routeMapAdmissionEvidence.currentTopologyAdmission.reviewedAt, source.routeMapAdmissionEvidence.currentTopologyAdmission.reviewedAt);
    assert.equal(first.source.routeMapAdmissionEvidence.currentTopologyAdmission.freshUntil, source.routeMapAdmissionEvidence.currentTopologyAdmission.freshUntil);
    assert.equal(first.source.coverage, "Official route-map position data joined to approved schematic geometry; geographic projection is not used.");
    assert.deepEqual(first.candidate.evidence.coverageLimitations, ["Official route-map position data is limited to the admitted line and approved schematic geometry."]);
    assert.equal(first.candidate.evidence.evidenceArtifact, first.snapshotPath);
  }
});

test("successor projection은 tampered predecessor와 current topology binding을 거부한다", async () => {
  const [inventory, candidates] = await Promise.all([
    readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/source-candidates.json"), "utf8").then(JSON.parse),
  ]);
  const line = LINE_FIXTURES.find(({ key }) => key === "everline");
  const source = inventory.sources.find(({ id }) => id === line.sourceId);
  const candidate = candidates.candidates.find(({ id }) => id === line.sourceId);
  const inputs = await loadLine(line);
  const previousSnapshotBytes = await readFile(path.join(root, source.routeMapAdmissionEvidence.snapshotPath));
  const collectorInputs = {
    csvBytes: inputs.csvBytes,
    topologySnapshot: inputs.topologySnapshot,
    topologySnapshotId: inputs.topologySnapshotId,
    schematicCanvas: inputs.schematicCanvas,
    canonicalStationIdentities: inputs.canonicalStationIdentities,
  };
  assert.throws(() => buildCapitalLightRailRouteMapSuccessor({
    source, candidate, ...collectorInputs, previousSnapshotBytes: Buffer.concat([previousSnapshotBytes, Buffer.from(" ")]),
  }), /byte identity mismatch/);
  const brokenSource = structuredClone(source);
  brokenSource.routeMapAdmissionEvidence.currentTopologyAdmission.topologyContentSha256 = "0".repeat(64);
  assert.throws(() => buildCapitalLightRailRouteMapSuccessor({
    source: brokenSource, candidate, ...collectorInputs, previousSnapshotBytes,
  }), /current topology admission binding mismatch/);
});

test("successor projection은 retained overlay bytes drift를 거부한다", async () => {
  const [inventory, candidates] = await Promise.all([
    readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/source-candidates.json"), "utf8").then(JSON.parse),
  ]);
  const line = LINE_FIXTURES.find(({ key }) => key === "ui");
  const source = inventory.sources.find(({ id }) => id === line.sourceId);
  const candidate = candidates.candidates.find(({ id }) => id === line.sourceId);
  const inputs = await loadLine(line);
  const previousSnapshotBytes = await readFile(path.join(root, source.routeMapAdmissionEvidence.snapshotPath));
  assert.throws(() => buildCapitalLightRailRouteMapSuccessor({
    source, candidate, previousSnapshotBytes, csvBytes: inputs.csvBytes,
    overlayCsvBytes: Buffer.concat([inputs.overlayCsvBytes, Buffer.from("\n")]),
    topologySnapshot: inputs.topologySnapshot, topologySnapshotId: inputs.topologySnapshotId,
    schematicCanvas: inputs.schematicCanvas, canonicalStationIdentities: inputs.canonicalStationIdentities,
  }), /overlayRawSha256 drift/);
});

test("owner geometry의 노선 외 역은 topology projection 전에 거부한다", async () => {
  const line = LINE_FIXTURES.find(({ key }) => key === "ui");
  const inputs = await loadLine(line);
  const geometry = structuredClone(inputs.schematicCanvas);
  geometry.stationNodes.push({
    dataLine: "ui-sinseol", transferLines: "", dataStation: "노선외역", x: 2000, y: 800,
  });
  assert.throws(() => parseCapitalLightRailRouteMapPositionsCsv({
    lineKey: line.key, csvBytes: inputs.csvBytes, overlayCsvBytes: inputs.overlayCsvBytes,
    topologySnapshot: inputs.topologySnapshot, schematicCanvas: geometry,
    previousSnapshot: inputs.previousSnapshot, canonicalStationIdentities: inputs.canonicalStationIdentities,
  }), /owner geometry station set differs/);
});
