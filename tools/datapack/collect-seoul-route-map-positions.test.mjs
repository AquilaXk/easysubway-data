import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  buildSeoulRouteMapPositions,
  compareCodepoints,
  collectSeoulRouteMapPositions,
  parseSeoulRouteMapPositionsCsv,
  projectSeoulPublicLineOrder,
  validateSeoulRouteMapPositionsSnapshot,
} from "./collect-seoul-route-map-positions.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const FIXTURE_CSV = path.join(root, "tools/datapack/fixtures/seoul-route-map-positions-raw/data-go-15099316.csv");
const SNAPSHOT_PATH = path.join(root, "tools/datapack/sources/seoul-metro-route-map-positions-20260724.json");
const TOPOLOGY_PATH = path.join(root, "tools/datapack/sources/capital-route-topology-20260814.json");
const capturedAt = "2026-07-24T02:00:00.000Z";

async function loadTopology() {
  return JSON.parse(await readFile(TOPOLOGY_PATH, "utf8"));
}
async function loadTopologyBytes() { return readFile(TOPOLOGY_PATH); }

test("서울 공식 FILE CSV의 276 raw/layout을 primary로 보존하고 legacy 진단을 격리한다", async () => {
  const [csvBytes, topologySnapshot, topologySnapshotBytes] = await Promise.all([readFile(FIXTURE_CSV), loadTopology(), loadTopologyBytes()]);
  const snapshot = collectSeoulRouteMapPositions({
    csvBytes,
    topologySnapshot,
    topologySnapshotBytes,
    topologySnapshotId: "capital-route-topology-20260814",
    now: new Date(capturedAt),
  });

  assert.equal(snapshot.artifactKind, "seoul-metro-route-map-positions-snapshot");
  assert.equal(snapshot.sourceId, "seoul-metro-route-map-positions");
  assert.equal(snapshot.datasetId, "15099316");
  assert.equal(snapshot.rawStationCount, 276);
  assert.equal(snapshot.stationCount, 276);
  assert.equal(snapshot.layoutInput, "rawPositions");
  assert.equal(snapshot.rawPositions.length, 276);
  assert.equal(snapshot.rawPositions.filter(({ stationCode }) => stationCode === "2515" || stationCode === "2516").length, 2);
  assert.deepEqual(snapshot.lineStationCounts, {
    "1": 10, "2": 51, "3": 34, "4": 26, "5": 56, "6": 39, "7": 42, "8": 18,
  });
  assert.deepEqual(
    snapshot.legacyDiagnostic.quarantinedPositions.map(({ stationCode, stationName, reasonCode, latitude, longitude }) => ({
      stationCode, stationName, reasonCode, latitude, longitude,
    })),
    [
      { stationCode: "2515", stationName: "마곡", reasonCode: "OFFICIAL_DUPLICATE_LATLON", latitude: 37.562182, longitude: 126.82693 },
      { stationCode: "2516", stationName: "발산", reasonCode: "OFFICIAL_DUPLICATE_LATLON", latitude: 37.562182, longitude: 126.82693 },
    ],
  );
  assert.equal("positions" in snapshot, false);
  assert.equal("quarantinedPositions" in snapshot, false);
  assert.equal(snapshot.legacyDiagnostic.stationCount, 274);
  assert.equal(snapshot.legacyDiagnostic.quarantinedCount, 2);
  assert.deepEqual(snapshot.lineIds, [
    "line-472a81add377", "seoul-2", "line-41a8c75ec9d8", "seoul-4",
    "line-80fc4d5350d4", "line-3f41718e0833", "line-15b3b8a93259", "line-2b2d9eaa53d0",
  ]);
  assert.equal(snapshot.credentialRequired, false);
  assert.equal(snapshot.credentialRedacted, true);
  assert.equal(snapshot.rawSha256, createHash("sha256").update(csvBytes).digest("hex"));
  assert.equal(snapshot.legacyDiagnostic.positionsSha256, createHash("sha256").update(JSON.stringify(snapshot.legacyDiagnostic.positions)).digest("hex"));
  assert.match(snapshot.rawPositionsSha256, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.layoutAlgorithmVersion, "seoul-public-latlon-line-order-layout-v2");
  assert.equal(snapshot.topologySnapshotId, "capital-route-topology-20260814");
  assert.match(snapshot.lineOrderSha256, /^[a-f0-9]{64}$/);
  assert.match(snapshot.semanticInputSha256, /^[a-f0-9]{64}$/);
  assert.match(snapshot.semanticOutputSha256, /^[a-f0-9]{64}$/);
  const seoul = snapshot.layoutPositions.find(({ stationCode }) => stationCode === "150");
  assert.equal(seoul.stationName, "서울");
  assert.equal(seoul.lineId, "line-472a81add377");
  assert.ok(Number.isInteger(seoul.canvasX) && seoul.canvasX > 0);
  assert.ok(Number.isInteger(seoul.canvasY) && seoul.canvasY > 0);
  assert.equal(seoul.labelPolygon.length, 4);
  assert.deepEqual(Object.keys(snapshot.rawPositions[0]).sort(), ["basisDate", "latitude", "line", "lineId", "longitude", "stationCode", "stationName"]);
  assert.equal(snapshot.layoutPositions.length, 276);
  const magok = snapshot.layoutPositions.find(({ stationCode }) => stationCode === "2515");
  const balsan = snapshot.layoutPositions.find(({ stationCode }) => stationCode === "2516");
  assert.equal(magok.canvasOrigin, "DERIVED_SHARED_COORDINATE_SPREAD");
  assert.equal(balsan.canvasOrigin, "DERIVED_SHARED_COORDINATE_SPREAD");
  assert.notDeepEqual([magok.canvasX, magok.canvasY], [balsan.canvasX, balsan.canvasY]);
  const sadang = snapshot.legacyDiagnostic.positions.filter(({ stationName }) => stationName === "사당");
  assert.deepEqual(sadang.map(({ lineId, stationId }) => ({ lineId, stationId })), [
    { lineId: "seoul-2", stationId: "station-sadang" },
    { lineId: "seoul-4", stationId: "station-sadang" },
  ]);
  assert.equal(validateSeoulRouteMapPositionsSnapshot(snapshot, { topologySnapshotBytes }), snapshot);
  assert.throws(() => validateSeoulRouteMapPositionsSnapshot(snapshot), /invalid/);
  assert.throws(() => validateSeoulRouteMapPositionsSnapshot(snapshot, { topologySnapshotBytes: Buffer.concat([topologySnapshotBytes, Buffer.from(" ")]) }), /invalid/);
  const rawKeys = new Set(snapshot.rawPositions.map(({ lineId, stationCode }) => `${lineId}:${stationCode}`));
  assert.ok(snapshot.layoutTracks.every((track) => track.stationKeys.every((stationKey) => rawKeys.has(stationKey))));
  assert.doesNotMatch(JSON.stringify(snapshot), /serviceKey/i);
});

test("행 수는 동적으로 반영하지만 malformed·미지원 호선·날짜 불일치는 fail closed 한다", async () => {
  const [csvBytes, topologySnapshot] = await Promise.all([readFile(FIXTURE_CSV), loadTopology()]);
  const text = new TextDecoder("euc-kr").decode(csvBytes);
  const lines = text.split(/\r?\n/);
  const reducedBytes = Buffer.from(lines.filter((line) => !line.includes(",마곡,")).join("\n"), "utf8");
  const reducedParsed = parseSeoulRouteMapPositionsCsv(reducedBytes);
  const completeParsed = parseSeoulRouteMapPositionsCsv(csvBytes);
  assert.equal(reducedParsed.rawPositions.length, 275);
  assert.notEqual(
    createHash("sha256").update(JSON.stringify(reducedParsed.rawPositions)).digest("hex"),
    createHash("sha256").update(JSON.stringify(completeParsed.rawPositions)).digest("hex"),
  );
  assert.throws(() => collectSeoulRouteMapPositions({
    csvBytes: reducedBytes, topologySnapshot, topologySnapshotId: "capital-route-topology-20260814", now: new Date(capturedAt),
  }), /missing required Seoul public line-order station/);
  const collisionChanged = collectSeoulRouteMapPositions({
    csvBytes: Buffer.from(text.replace("37.562182,126.82693", "37.562183,126.82693"), "utf8"),
    topologySnapshot, topologySnapshotId: "capital-route-topology-20260814", now: new Date(capturedAt),
  });
  assert.equal(collisionChanged.rawStationCount, 276);
  assert.equal(collisionChanged.stationCount, 276);
  assert.equal(collisionChanged.legacyDiagnostic.quarantinedCount, 0);
  const withLine9 = `${lines[0]}\n999,9,9999,가짜,37.5,127.0,1974-01-01,2025-08-14\n`;
  assert.throws(
    () => parseSeoulRouteMapPositionsCsv(Buffer.from(withLine9, "utf8")),
    /unknown line/,
  );
  const stale = text.replaceAll("2025-08-14", "2024-01-01");
  assert.equal(parseSeoulRouteMapPositionsCsv(Buffer.from(stale, "utf8")).observedDataUpdatedAt, "2024-01-01");
  const inconsistent = text.replace("2025-08-14", "2024-01-01");
  assert.throws(() => parseSeoulRouteMapPositionsCsv(Buffer.from(inconsistent, "utf8")), /inconsistent/);
  const future = text.replaceAll("2025-08-14", "2026-07-25");
  assert.throws(() => collectSeoulRouteMapPositions({
    csvBytes: Buffer.from(future, "utf8"), topologySnapshot, topologySnapshotId: "capital-route-topology-20260814", now: new Date(capturedAt),
  }), /future/);
  assert.throws(() => parseSeoulRouteMapPositionsCsv(Buffer.from(text.replaceAll("2025-08-14", "2025-02-30"), "utf8")), /invalid basisDate/);
});

test("snapshot hash나 좌표가 바뀌면 admission을 거부한다", async () => {
  const [csvBytes, topologySnapshot] = await Promise.all([readFile(FIXTURE_CSV), loadTopology()]);
  const snapshot = collectSeoulRouteMapPositions({
    csvBytes,
    topologySnapshot,
    topologySnapshotId: "capital-route-topology-20260814",
    now: new Date(capturedAt),
  });
  const tampered = structuredClone(snapshot);
  tampered.layoutPositions[0].canvasX += 1;
  assert.throws(() => validateSeoulRouteMapPositionsSnapshot(tampered, { topologySnapshotBytes: Buffer.from(JSON.stringify(topologySnapshot)) }), /invalid Seoul route map positions snapshot/);
});

test("v1 tracked snapshot의 inventory·candidate byte identity는 compatibility smoke로 유지한다", async () => {
  const [snapshotBytes, inventory, candidates] = await Promise.all([
    readFile(SNAPSHOT_PATH),
    readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/source-candidates.json"), "utf8").then(JSON.parse),
  ]);
  const source = inventory.sources.find(({ id }) => id === "seoul-metro-route-map-positions");
  const candidate = candidates.candidates.find(({ id }) => id === source.id);
  assert.equal(source.productionUseAllowed, true);
  assert.equal(source.license.redistributionAllowed, true);
  assert.equal(source.license.derivativeWorkAllowed, true);
  assert.equal(source.license.evidenceUrl, "https://www.data.go.kr/data/15099316/fileData.do");
  assert.equal(source.routeMapAdmissionEvidence.admissionKind, "official-file-latlon");
  assert.equal(
    source.routeMapAdmissionEvidence.snapshotSha256,
    createHash("sha256").update(snapshotBytes).digest("hex"),
  );
  assert.equal(candidate.admissionStatus, "production_route_map_positions_materialized");
  assert.equal(candidate.apiCatalog, false);
  assert.deepEqual(candidate.operation.responseFields, ["연번", "호선", "고유역번호(외부역코드)", "역명", "위도", "경도", "작성기준일", "작성일자"]);
  assert.deepEqual(candidate.evidence.outputFields, candidate.operation.responseFields);
  assert.equal(candidate.evidence.coverageAssessment.requirementCount, 8);
  assert.equal(JSON.parse(snapshotBytes).stationCount, 274);
  assert.equal(JSON.parse(snapshotBytes).rawStationCount, 276);
});

test("서로 다른 역명이 동일 좌표를 쓰면 snapshot validation이 fail-closed 한다", async () => {
  const [csvBytes, topologySnapshot] = await Promise.all([readFile(FIXTURE_CSV), loadTopology()]);
  const snapshot = collectSeoulRouteMapPositions({
    csvBytes,
    topologySnapshot,
    topologySnapshotId: "capital-route-topology-20260814",
    now: new Date(capturedAt),
  });
  const tampered = structuredClone(snapshot);
  const donor = tampered.rawPositions[0];
  const victim = tampered.rawPositions.find((row) => row.stationName !== donor.stationName);
  victim.latitude = donor.latitude;
  victim.longitude = donor.longitude;
  assert.throws(() => validateSeoulRouteMapPositionsSnapshot(tampered, { topologySnapshotBytes: Buffer.from(JSON.stringify(topologySnapshot)) }), /invalid Seoul route map positions snapshot/);
});

test("capture time은 semantic identity를 바꾸지 않고 branch projection 변경은 layout identity를 바꾼다", async () => {
  const [csvBytes, topologySnapshot] = await Promise.all([readFile(FIXTURE_CSV), loadTopology()]);
  const first = collectSeoulRouteMapPositions({
    csvBytes, topologySnapshot, topologySnapshotId: "capital-route-topology-20260814", now: new Date(capturedAt),
  });
  const recaptured = collectSeoulRouteMapPositions({
    csvBytes, topologySnapshot, topologySnapshotId: "capital-route-topology-20260814", now: new Date("2026-07-25T02:00:00.000Z"),
  });
  assert.notEqual(first.capturedAt, recaptured.capturedAt);
  assert.equal(first.semanticInputSha256, recaptured.semanticInputSha256);
  assert.equal(first.semanticOutputSha256, recaptured.semanticOutputSha256);
  const changedTopology = structuredClone(topologySnapshot);
  const line2 = changedTopology.lines.find(({ lineId }) => lineId === "seoul-2");
  line2.branchSequences[0].stationNames = [...line2.branchSequences[0].stationNames].reverse();
  const changed = collectSeoulRouteMapPositions({
    csvBytes, topologySnapshot: changedTopology, topologySnapshotId: "capital-route-topology-20260814", now: new Date(capturedAt),
  });
  assert.notEqual(first.lineOrderSha256, changed.lineOrderSha256);
  assert.notEqual(first.semanticInputSha256, changed.semanticInputSha256);
});

test("normalized topology join ambiguity는 fail closed 한다", async () => {
  const [csvBytes, topologySnapshotBytes] = await Promise.all([readFile(FIXTURE_CSV), loadTopologyBytes()]);
  const parsed = parseSeoulRouteMapPositionsCsv(csvBytes);
  const first = parsed.rawPositions[0];
  assert.throws(() => buildSeoulRouteMapPositions({
    records: [...parsed.rawPositions, { ...first, stationCode: "9999" }], topologySnapshotBytes, topologySnapshotId: "capital-route-topology-20260814", now: new Date(capturedAt),
  }), /ambiguous Seoul public line-order join/);
  assert.equal(compareCodepoints("가", "나"), -1);
});
