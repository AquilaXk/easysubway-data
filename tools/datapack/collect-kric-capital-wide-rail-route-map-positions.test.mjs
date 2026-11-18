import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { decodeOfficialCsv } from "./collect-daegu-datapack-sources.mjs";
import {
  collectCapitalWideRailRouteMapPositions,
  listCapitalWideRailRouteMapPositionLines,
  normalizeOfficialLatLon,
  parseCapitalWideRailRouteMapPositionsCsv,
  validateCapitalWideRailRouteMapPositionsSnapshot,
} from "./collect-kric-capital-wide-rail-route-map-positions.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const FIXTURE_ROOT = path.join(
  root,
  "tools/datapack/fixtures/capital-wide-rail-route-map-positions-raw",
);
const OVERLAY_PATH = path.join(
  FIXTURE_ROOT,
  "shared/kric-1294-overlay-gyeongchun-gyeonggang.csv",
);
const TOPOLOGY_PATH = path.join(root, "tools/datapack/sources/capital-route-topology-20260724.json");
const capturedAt = "2026-07-25T06:00:00.000Z";
const GEO_SCALE_FLOOR = 5000;

const LINE_FIXTURES = Object.freeze([
  {
    key: "gyeongui-jungang",
    sourceId: "kric-gyeongui-jungang-route-map-positions",
    input: "data-go-15041487.csv",
    admit: 58,
    quarantine: 0,
    rawSha256: "da29b9f9a5a109e0b1c50a4a59dbf480f46f080268630db5171a17e91982eb08",
  },
  {
    key: "gyeongchun",
    sourceId: "kric-gyeongchun-route-map-positions",
    input: "data-go-15041483.csv",
    admit: 25,
    quarantine: 0,
    rawSha256: "b41d276479134953c888500d97394b75771d5e89e628d936e2f4070695f84b48",
    needsOverlay: true,
    overlayNames: ["광운대", "상봉", "망우"],
  },
  {
    key: "suin-bundang",
    sourceId: "kric-suin-bundang-route-map-positions",
    input: "data-go-15041333.csv",
    admit: 63,
    quarantine: 0,
    rawSha256: "715122eba0b24dc5a52e65e47c6832f0bff68572cd8adf7c34f0c03a398d05bc",
  },
  {
    key: "gyeonggang",
    sourceId: "kric-gyeonggang-route-map-positions",
    input: "data-go-15041486.csv",
    admit: 12,
    quarantine: 0,
    rawSha256: "4744c6dc298db3a5f34e7bc91a1ad182daba6676b314a07094ad8da0b1e5c7df",
    needsOverlay: true,
    overlayNames: ["성남"],
  },
  {
    key: "airport-railroad",
    sourceId: "kric-airport-railroad-route-map-positions",
    input: "data-go-15041331.csv",
    admit: 14,
    quarantine: 0,
    rawSha256: "ac220febb295b517a4a0f759283c97984894207e7a8b657463ab72c83a62f787",
  },
  {
    key: "uijeongbu",
    sourceId: "kric-uijeongbu-route-map-positions",
    input: "data-go-15041325.csv",
    admit: 15,
    quarantine: 0,
    rawSha256: "3899909d0729d62358d3248f909f4ae1c584283bf361821826cc510bfbb3419e",
  },
  {
    key: "seohae",
    sourceId: "kric-seohae-route-map-positions",
    input: "kric-seohae-filtered-stations.csv",
    admit: 21,
    quarantine: 0,
    rawSha256: "98b5c19fbc46b0d5c7b9873d9650333aad54231bc28e2014504811837486b194",
  },
  {
    key: "gtx-a",
    sourceId: "kric-gtx-a-route-map-positions",
    input: "kric-gtx-a-stations.csv",
    admit: 9,
    quarantine: 0,
    rawSha256: "ce9589f0f7c62cabc8f8249c3640b56a8ef817b776faaabc2c53d9624faa35ff",
    expectSwapped: 5,
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

test("수도권 광역·전철 8노선 공식 FILE 위경도 + schematic canvas snapshot을 quarantine 0으로 결속한다", async () => {
  assert.equal(listCapitalWideRailRouteMapPositionLines().length, 8);
  for (const line of LINE_FIXTURES) {
    const { csvBytes, topologySnapshot, schematicCanvas, overlayCsvBytes } = await loadLine(line);
    const snapshot = collectCapitalWideRailRouteMapPositions({
      lineKey: line.key,
      csvBytes,
      overlayCsvBytes,
      topologySnapshot,
      schematicCanvas,
      now: new Date(capturedAt),
    });
    assert.equal(snapshot.artifactKind, "capital-wide-rail-route-map-positions-snapshot");
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
    if (line.expectSwapped != null) {
      assert.equal(snapshot.swappedCoordinateCount, line.expectSwapped);
      assert.equal(
        snapshot.positions.filter(({ officialLatLonSwapped }) => officialLatLonSwapped === true).length,
        line.expectSwapped,
      );
    }
    assert.equal(validateCapitalWideRailRouteMapPositionsSnapshot(snapshot), snapshot);
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

test("GTX-A 공식 lat/lon 컬럼 스왑을 결정론 정규화한다", async () => {
  const swapped = normalizeOfficialLatLon("126.728133", "37.716044", { applySwap: true });
  assert.equal(swapped.swapped, true);
  assert.equal(swapped.latitude, 37.716044);
  assert.equal(swapped.longitude, 126.728133);
  const normal = normalizeOfficialLatLon("37.486944", "127.101944", { applySwap: true });
  assert.equal(normal.swapped, false);
  assert.equal(normal.latitude, 37.486944);
  assert.equal(normal.longitude, 127.101944);

  const line = LINE_FIXTURES.find(({ key }) => key === "gtx-a");
  const { csvBytes, topologySnapshot, schematicCanvas } = await loadLine(line);
  const { positions } = parseCapitalWideRailRouteMapPositionsCsv({
    lineKey: "gtx-a",
    csvBytes,
    topologySnapshot,
    schematicCanvas,
  });
  assert.equal(positions.length, 9);
  const unjeong = positions.find(({ stationName }) => stationName === "운정중앙");
  assert.ok(unjeong.officialLatLonSwapped);
  assert.ok(unjeong.latitude > 37 && unjeong.longitude > 126);
  const suseo = positions.find(({ stationName }) => stationName === "수서");
  assert.equal(suseo.officialLatLonSwapped, undefined);
});

test("경춘·경강 empty lat/lon은 KRIC 1294 overlay로 admit한다", async () => {
  for (const key of ["gyeongchun", "gyeonggang"]) {
    const line = LINE_FIXTURES.find((entry) => entry.key === key);
    const { csvBytes, topologySnapshot, schematicCanvas, overlayCsvBytes } = await loadLine(line);
    const snapshot = collectCapitalWideRailRouteMapPositions({
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
  const line = LINE_FIXTURES.find(({ key }) => key === "airport-railroad");
  const { csvBytes, topologySnapshot, schematicCanvas } = await loadLine(line);
  const brokenTopology = structuredClone(topologySnapshot);
  const topologyLine = brokenTopology.lines.find(({ lineId }) => lineId === "line-e9e9a5b520a4");
  const target = topologyLine.scope.find(({ stationName }) => stationName === "서울역");
  target.stationName = "가짜서울역";
  assert.throws(
    () => parseCapitalWideRailRouteMapPositionsCsv({
      lineKey: "airport-railroad",
      csvBytes,
      topologySnapshot: brokenTopology,
      schematicCanvas,
    }),
    /topology name missing|topology line contentSha256 mismatch|topology/,
  );

  const missingCanvas = structuredClone(schematicCanvas);
  missingCanvas.stations = missingCanvas.stations.filter(({ stationName }) => stationName !== "서울역");
  assert.throws(
    () => parseCapitalWideRailRouteMapPositionsCsv({
      lineKey: "airport-railroad",
      csvBytes,
      topologySnapshot,
      schematicCanvas: missingCanvas,
    }),
    /schematic canvas/,
  );
});

test("#2503 inventory·candidate는 snapshot byte identity와 자유 이용 근거를 고정한다", async () => {
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
    assert.equal(source.routeMapAdmissionEvidence.issue, 2503);
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
