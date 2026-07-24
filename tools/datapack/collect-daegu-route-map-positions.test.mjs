import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { DAEGU_LINES } from "./collect-daegu-datapack-sources.mjs";
import {
  collectDaeguRouteMapPositions,
  parseDaeguRouteMapPositionsCsvs,
  validateDaeguRouteMapPositionsSnapshot,
} from "./collect-daegu-route-map-positions.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const FIXTURE_DIR = path.join(root, "tools/datapack/fixtures/daegu-route-map-positions-raw");
const SNAPSHOT_PATH = path.join(root, "tools/datapack/sources/daegu-transportation-route-map-positions-20260724.json");
const capturedAt = "2026-07-24T03:00:00.000Z";
const DATASET_IDS = ["15133918", "15133920", "15133922"];

async function loadInputs() {
  const csvByDatasetId = {};
  const topologySnapshots = {};
  for (const datasetId of DATASET_IDS) {
    csvByDatasetId[datasetId] = await readFile(path.join(FIXTURE_DIR, `data-go-${datasetId}.csv`));
  }
  for (const line of DAEGU_LINES) {
    topologySnapshots[line.lineNumber] = JSON.parse(await readFile(
      path.join(root, `tools/datapack/sources/daegu-line${line.lineNumber}-route-topology-20260721.json`),
      "utf8",
    ));
  }
  return { csvByDatasetId, topologySnapshots };
}

test("대구 공식 출구 FILE CSV에서 1·2·3호선 대표 좌표 snapshot을 만든다(환승역 동일 stationId 유지)", async () => {
  const { csvByDatasetId, topologySnapshots } = await loadInputs();
  const snapshot = collectDaeguRouteMapPositions({
    csvByDatasetId,
    topologySnapshots,
    now: new Date(capturedAt),
  });

  assert.equal(snapshot.artifactKind, "daegu-route-map-positions-snapshot");
  assert.equal(snapshot.sourceId, "daegu-transportation-route-map-positions");
  assert.deepEqual(snapshot.datasetIds, DATASET_IDS);
  assert.equal(snapshot.exitRowCount, 429);
  assert.equal(snapshot.rawStationCount, 91);
  assert.equal(snapshot.stationCount, 91);
  assert.equal(snapshot.quarantinedCount, 0);
  assert.equal(snapshot.topologyGapCount, 3);
  assert.deepEqual(snapshot.lineStationCounts, { "1": 32, "2": 29, "3": 30 });
  assert.deepEqual(snapshot.quarantinedPositions, []);
  assert.equal(
    snapshot.positions.some(({ stationCode }) => ["129", "130", "229", "230", "329", "331"].includes(stationCode)),
    true,
  );
  assert.deepEqual(snapshot.lineIds, DAEGU_LINES.map(({ lineId }) => lineId));
  assert.equal(snapshot.credentialRequired, false);
  assert.equal(snapshot.credentialRedacted, true);
  assert.equal(
    snapshot.rawSha256,
    createHash("sha256").update(Buffer.concat(DATASET_IDS.map((id) => Buffer.from(csvByDatasetId[id])))).digest("hex"),
  );
  assert.equal(snapshot.positionsSha256, createHash("sha256").update(JSON.stringify(snapshot.positions)).digest("hex"));
  const seolhwa = snapshot.positions.find(({ stationCode }) => stationCode === "115");
  assert.equal(seolhwa.stationName, "설화명곡");
  assert.equal(seolhwa.lineId, "line-5b8d9b05e7e6");
  assert.ok(Number.isInteger(seolhwa.x) && seolhwa.x > 0);
  assert.ok(Number.isInteger(seolhwa.y) && seolhwa.y > 0);
  assert.equal(seolhwa.labelPolygon.length, 4);
  const renamed = snapshot.positions.find(({ stationCode }) => stationCode === "335");
  assert.equal(renamed.stationName, "수성구민운동장");
  assert.equal(validateDaeguRouteMapPositionsSnapshot(snapshot), snapshot);
  assert.doesNotMatch(JSON.stringify(snapshot), /serviceKey/i);
});

test("좌표 누락·topology 미매칭은 fail closed 한다", async () => {
  const { csvByDatasetId, topologySnapshots } = await loadInputs();
  const text = new TextDecoder().decode(csvByDatasetId["15133918"]);
  const lines = text.split(/\r?\n/);
  const broken = structuredClone(csvByDatasetId);
  broken["15133918"] = Buffer.from(lines.filter((_, index) => index !== 1).join("\n"), "utf8");
  assert.throws(
    () => parseDaeguRouteMapPositionsCsvs({ csvByDatasetId: broken, topologySnapshots }),
    /exit row count mismatch|station count mismatch|join failed/,
  );
  const unknown = structuredClone(csvByDatasetId);
  unknown["15133918"] = Buffer.from(`${lines[0]}\n1,가짜역,1,35.8,128.5\n${lines.slice(1).join("\n")}`, "utf8");
  assert.throws(
    () => parseDaeguRouteMapPositionsCsvs({ csvByDatasetId: unknown, topologySnapshots }),
    /exit row count mismatch|join failed|aggregated station count/,
  );
});

test("snapshot hash나 좌표가 바뀌면 admission을 거부한다", async () => {
  const { csvByDatasetId, topologySnapshots } = await loadInputs();
  const snapshot = collectDaeguRouteMapPositions({
    csvByDatasetId,
    topologySnapshots,
    now: new Date(capturedAt),
  });
  const tampered = structuredClone(snapshot);
  tampered.positions[0].x += 1;
  assert.throws(() => validateDaeguRouteMapPositionsSnapshot(tampered), /invalid Daegu route map positions snapshot/);
});

test("동일 stationId 환승 행의 좌표가 갈라지면 admission을 거부한다", async () => {
  const { csvByDatasetId, topologySnapshots } = await loadInputs();
  const snapshot = collectDaeguRouteMapPositions({
    csvByDatasetId,
    topologySnapshots,
    now: new Date(capturedAt),
  });
  const byStationId = Map.groupBy(snapshot.positions, ({ stationId }) => stationId);
  const transferId = [...byStationId.entries()].find(([, rows]) => rows.length > 1)?.[0];
  assert.ok(transferId, "환승 공유 stationId가 있어야 한다");
  const tampered = structuredClone(snapshot);
  const divergent = tampered.positions.find(({ stationId }) => stationId === transferId);
  divergent.latitude += 0.0001;
  divergent.y += 1;
  tampered.positionsSha256 = createHash("sha256").update(JSON.stringify(tampered.positions)).digest("hex");
  assert.throws(() => validateDaeguRouteMapPositionsSnapshot(tampered), /invalid Daegu route map positions snapshot/);
});

test("#2473 inventory·candidate는 snapshot byte identity와 자유 이용 근거를 고정한다", async () => {
  const [snapshotBytes, inventory, candidates] = await Promise.all([
    readFile(SNAPSHOT_PATH),
    readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/source-candidates.json"), "utf8").then(JSON.parse),
  ]);
  const source = inventory.sources.find(({ id }) => id === "daegu-transportation-route-map-positions");
  const candidate = candidates.candidates.find(({ id }) => id === source.id);
  assert.equal(source.productionUseAllowed, true);
  assert.equal(source.license.redistributionAllowed, true);
  assert.equal(source.license.derivativeWorkAllowed, true);
  assert.equal(source.license.evidenceUrl, "https://www.data.go.kr/data/15133918/fileData.do");
  assert.equal(source.routeMapAdmissionEvidence.admissionKind, "official-file-latlon");
  assert.equal(
    source.routeMapAdmissionEvidence.snapshotSha256,
    createHash("sha256").update(snapshotBytes).digest("hex"),
  );
  assert.equal(candidate.admissionStatus, "production_route_map_positions_materialized");
  assert.equal(candidate.apiCatalog, false);
  assert.equal(candidate.evidence.coverageAssessment.requirementCount, 3);
  assert.equal(JSON.parse(snapshotBytes).stationCount, 91);
  assert.equal(JSON.parse(snapshotBytes).rawStationCount, 91);
});

test("fixture CSV는 trailing whitespace와 EOF 빈 줄이 없다", async () => {
  for (const datasetId of DATASET_IDS) {
    const bytes = await readFile(path.join(FIXTURE_DIR, `data-go-${datasetId}.csv`));
    const text = bytes.toString("utf8");
    assert.equal(text.endsWith("\n"), true);
    assert.equal(text.endsWith("\n\n"), false);
    for (const line of text.split("\n").slice(0, -1)) {
      assert.equal(/[ \t]$/.test(line), false, `trailing whitespace in ${datasetId}: ${line}`);
    }
  }
});
