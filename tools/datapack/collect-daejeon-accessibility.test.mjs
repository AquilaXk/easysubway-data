import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { parseMolitDaejeonStationMappings } from "./build-molit-nationwide-fixture.mjs";
import {
  collectDaejeonAccessibility,
  parseDaejeonAccessibilityCsv,
  runDaejeonAccessibilityCollector,
} from "./collect-daejeon-accessibility.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const ELEVATOR_CSV = path.join(root, "tools/datapack/fixtures/daejeon-accessibility-raw/data-go-15041384.csv");
const ESCALATOR_CSV = path.join(root, "tools/datapack/fixtures/daejeon-accessibility-raw/data-go-15041361.csv");
const LINE_ID = "line-7051a9c2525c";

async function loadInputs() {
  const [elevatorBytes, escalatorBytes, topologySnapshot, molitBytes] = await Promise.all([
    readFile(ELEVATOR_CSV),
    readFile(ESCALATOR_CSV),
    readFile(path.join(root, "tools/datapack/sources/daejeon-route-topology-20260720.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv")),
  ]);
  return {
    elevatorBytes,
    escalatorBytes,
    topologySnapshot,
    canonicalStationMappings: parseMolitDaejeonStationMappings(molitBytes),
  };
}

test("대전 accessibility collector는 엘리베이터·에스컬레이터 CSV 22역을 topology에 join한다", async () => {
  const inputs = await loadInputs();
  const snapshot = collectDaejeonAccessibility({
    ...inputs,
    now: new Date("2026-07-24T02:00:00.000Z"),
  });

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.artifactKind, "daejeon-accessibility-snapshot");
  assert.equal(snapshot.sourceId, "daejeon-transportation-accessibility");
  assert.deepEqual(snapshot.datasetIds, ["15041384", "15041361"]);
  assert.equal(snapshot.detailUrl, "https://www.data.go.kr/data/15041384/fileData.do");
  assert.equal(snapshot.detailUrls.escalator, "https://www.data.go.kr/data/15041361/fileData.do");
  assert.equal(snapshot.stationCount, 22);
  assert.equal(snapshot.rowCount, 22);
  assert.equal(snapshot.elevatorRowCount, 76);
  assert.equal(snapshot.escalatorRowCount, 168);
  assert.equal(snapshot.rows.length, 22);
  assert.deepEqual(snapshot.lineIds, [LINE_ID]);
  assert.equal(snapshot.official, true);
  assert.equal(snapshot.fixture, false);
  assert.equal(snapshot.credentialRequired, false);
  assert.equal(snapshot.credentialRedacted, true);
  assert.equal(snapshot.capturedAt, "2026-07-24T02:00:00.000Z");
  assert.equal(snapshot.freshUntil, "2026-07-25T02:00:00.000Z");
  assert.equal(
    snapshot.elevatorRawSha256,
    createHash("sha256").update(inputs.elevatorBytes).digest("hex"),
  );
  assert.equal(
    snapshot.escalatorRawSha256,
    createHash("sha256").update(inputs.escalatorBytes).digest("hex"),
  );
  assert.equal(snapshot.rowsSha256, createHash("sha256").update(JSON.stringify(snapshot.rows)).digest("hex"));
  assert.equal(snapshot.scopeSha256, createHash("sha256").update(JSON.stringify(snapshot.scope)).digest("hex"));
  assert.deepEqual(snapshot.fieldsProvided, [
    "elevator", "escalator", "wheelchair_lift", "status", "verified_at",
  ]);
  assert.equal(snapshot.topologyLineages.length, 1);
  assert.deepEqual(snapshot.topologyLineages[0], {
    sourceId: "daejeon-station-distance-fare",
    snapshotId: "daejeon-station-distance-fare-topology-20260720",
    contentSha256: inputs.topologySnapshot.contentSha256,
    lineId: LINE_ID,
  });
  assert.equal(snapshot.rows.every((row) => (
    row.lineId === LINE_ID
      && Number.isInteger(row.elevator) && row.elevator >= 1
      && Number.isInteger(row.escalator) && row.escalator >= 1
      && row.wheelchair_lift === 0
  )), true);
  assert.equal(snapshot.rows.reduce((sum, row) => sum + row.elevator, 0), 76);
  assert.equal(snapshot.rows.reduce((sum, row) => sum + row.escalator, 0), 168);
  assert.doesNotMatch(JSON.stringify(snapshot), /serviceKey/i);
});

test("대전 accessibility collector는 schema·join·count 변조를 fail closed한다", async () => {
  const inputs = await loadInputs();

  assert.throws(() => parseDaejeonAccessibilityCsv({
    ...inputs,
    elevatorBytes: new Uint8Array(),
  }), /elevator CSV bytes/);

  const badHeader = Buffer.from("철도운영기관명,선명,역명\n대전교통공사,1호선,판암(대전대)\n", "utf8");
  assert.throws(() => parseDaejeonAccessibilityCsv({
    ...inputs,
    elevatorBytes: badHeader,
  }), /missing column/);

  const badJoin = Buffer.from(
    "철도운영기관명,선명,역명,출입구번호,상세위치,정원_인원,정원_중량\n대전교통공사,1호선,존재하지않는역,1,위치,11,750\n",
    "utf8",
  );
  assert.throws(() => parseDaejeonAccessibilityCsv({
    ...inputs,
    elevatorBytes: badJoin,
  }), /join failed/);

  const truncated = Buffer.from(
    "철도운영기관명,선명,역명,출입구번호,상세위치,정원_인원,정원_중량\n대전교통공사,1호선,판암(대전대),1,위치,11,750\n",
    "utf8",
  );
  assert.throws(() => parseDaejeonAccessibilityCsv({
    ...inputs,
    elevatorBytes: truncated,
  }), /row count|station coverage|missing elevator/);

  const badTopology = {
    ...inputs.topologySnapshot,
    contentSha256: "0".repeat(64),
  };
  assert.throws(() => collectDaejeonAccessibility({
    ...inputs,
    topologySnapshot: badTopology,
    now: new Date("2026-07-24T02:00:00.000Z"),
  }), /topology snapshot/);
});

test("대전 accessibility collector CLI는 absolute output 경로를 강제한다", async () => {
  await assert.rejects(runDaejeonAccessibilityCollector([
    "--elevator-input", ELEVATOR_CSV,
    "--escalator-input", ESCALATOR_CSV,
    "--topology-snapshot", path.join(root, "tools/datapack/sources/daejeon-route-topology-20260720.json"),
    "--molit-csv", path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv"),
    "--output", "relative.json",
  ]), /usage: collect-daejeon-accessibility/);
});
