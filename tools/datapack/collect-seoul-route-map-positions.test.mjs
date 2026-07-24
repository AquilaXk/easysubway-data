import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  collectSeoulRouteMapPositions,
  parseSeoulRouteMapPositionsCsv,
  validateSeoulRouteMapPositionsSnapshot,
} from "./collect-seoul-route-map-positions.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const FIXTURE_CSV = path.join(root, "tools/datapack/fixtures/seoul-route-map-positions-raw/data-go-15099316.csv");
const SNAPSHOT_PATH = path.join(root, "tools/datapack/sources/seoul-metro-route-map-positions-20260724.json");
const capturedAt = "2026-07-24T02:00:00.000Z";

test("서울 공식 FILE CSV에서 1~8호선 274개 좌표 snapshot을 만든다(중복 위경도 quarantine)", async () => {
  const csvBytes = await readFile(FIXTURE_CSV);
  const snapshot = collectSeoulRouteMapPositions({
    csvBytes,
    now: new Date(capturedAt),
  });

  assert.equal(snapshot.artifactKind, "seoul-metro-route-map-positions-snapshot");
  assert.equal(snapshot.sourceId, "seoul-metro-route-map-positions");
  assert.equal(snapshot.datasetId, "15099316");
  assert.equal(snapshot.rawStationCount, 276);
  assert.equal(snapshot.stationCount, 274);
  assert.equal(snapshot.quarantinedCount, 2);
  assert.deepEqual(snapshot.lineStationCounts, {
    "1": 10, "2": 51, "3": 34, "4": 26, "5": 54, "6": 39, "7": 42, "8": 18,
  });
  assert.deepEqual(
    snapshot.quarantinedPositions.map(({ stationCode, stationName, reasonCode, latitude, longitude }) => ({
      stationCode, stationName, reasonCode, latitude, longitude,
    })),
    [
      { stationCode: "2515", stationName: "마곡", reasonCode: "OFFICIAL_DUPLICATE_LATLON", latitude: 37.562182, longitude: 126.82693 },
      { stationCode: "2516", stationName: "발산", reasonCode: "OFFICIAL_DUPLICATE_LATLON", latitude: 37.562182, longitude: 126.82693 },
    ],
  );
  assert.equal(snapshot.positions.some(({ stationCode }) => stationCode === "2515" || stationCode === "2516"), false);
  assert.deepEqual(snapshot.lineIds, [
    "line-472a81add377", "seoul-2", "line-41a8c75ec9d8", "seoul-4",
    "line-80fc4d5350d4", "line-3f41718e0833", "line-15b3b8a93259", "line-2b2d9eaa53d0",
  ]);
  assert.equal(snapshot.credentialRequired, false);
  assert.equal(snapshot.credentialRedacted, true);
  assert.equal(snapshot.rawSha256, createHash("sha256").update(csvBytes).digest("hex"));
  assert.equal(snapshot.positionsSha256, createHash("sha256").update(JSON.stringify(snapshot.positions)).digest("hex"));
  const seoul = snapshot.positions.find(({ stationCode }) => stationCode === "150");
  assert.equal(seoul.stationName, "서울");
  assert.equal(seoul.lineId, "line-472a81add377");
  assert.ok(Number.isInteger(seoul.x) && seoul.x > 0);
  assert.ok(Number.isInteger(seoul.y) && seoul.y > 0);
  assert.equal(seoul.labelPolygon.length, 4);
  const sadang = snapshot.positions.filter(({ stationName }) => stationName === "사당");
  assert.deepEqual(sadang.map(({ lineId, stationId }) => ({ lineId, stationId })), [
    { lineId: "seoul-2", stationId: "station-sadang" },
    { lineId: "seoul-4", stationId: "station-sadang" },
  ]);
  assert.equal(validateSeoulRouteMapPositionsSnapshot(snapshot), snapshot);
  assert.doesNotMatch(JSON.stringify(snapshot), /serviceKey/i);
});

test("좌표 누락·미지원 호선·작성기준일 불일치는 fail closed 한다", async () => {
  const csvBytes = await readFile(FIXTURE_CSV);
  const text = new TextDecoder("euc-kr").decode(csvBytes);
  const lines = text.split(/\r?\n/);
  assert.throws(
    () => parseSeoulRouteMapPositionsCsv(Buffer.from(lines.filter((_, index) => index !== 1).join("\n"), "utf8")),
    /station count mismatch|missing column|unknown/,
  );
  const withLine9 = `${lines[0]}\n999,9,9999,가짜,37.5,127.0,1974-01-01,2025-08-14\n`;
  assert.throws(
    () => parseSeoulRouteMapPositionsCsv(Buffer.from(withLine9, "utf8")),
    /unknown line/,
  );
  const stale = text.replaceAll("2025-08-14", "2024-01-01");
  assert.throws(
    () => parseSeoulRouteMapPositionsCsv(Buffer.from(stale, "utf8")),
    /작성기준일/,
  );
});

test("snapshot hash나 좌표가 바뀌면 admission을 거부한다", async () => {
  const csvBytes = await readFile(FIXTURE_CSV);
  const snapshot = collectSeoulRouteMapPositions({
    csvBytes,
    now: new Date(capturedAt),
  });
  const tampered = structuredClone(snapshot);
  tampered.positions[0].x += 1;
  assert.throws(() => validateSeoulRouteMapPositionsSnapshot(tampered), /invalid Seoul route map positions snapshot/);
});

test("#2470 inventory·candidate는 snapshot byte identity와 자유 이용 근거를 고정한다", async () => {
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
  assert.equal(candidate.evidence.coverageAssessment.requirementCount, 8);
  assert.equal(JSON.parse(snapshotBytes).stationCount, 274);
  assert.equal(JSON.parse(snapshotBytes).rawStationCount, 276);
});

test("서로 다른 역명이 동일 좌표를 쓰면 snapshot validation이 fail-closed 한다", async () => {
  const csvBytes = await readFile(FIXTURE_CSV);
  const snapshot = collectSeoulRouteMapPositions({
    csvBytes,
    now: new Date(capturedAt),
  });
  const tampered = structuredClone(snapshot);
  const donor = tampered.positions[0];
  const victim = tampered.positions.find((row) => row.stationName !== donor.stationName);
  victim.latitude = donor.latitude;
  victim.longitude = donor.longitude;
  victim.x = donor.x;
  victim.y = donor.y;
  tampered.positionsSha256 = createHash("sha256").update(JSON.stringify(tampered.positions)).digest("hex");
  assert.throws(() => validateSeoulRouteMapPositionsSnapshot(tampered), /invalid Seoul route map positions snapshot/);
});
