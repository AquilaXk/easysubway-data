import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  collectIncheonAccessibility,
  normalizedIncheonStationName,
  parseIncheonAccessibilityCsv,
  runIncheonAccessibilityCollector,
} from "./collect-incheon-accessibility.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const ELEVATOR_CSV = path.join(root, "tools/datapack/fixtures/incheon-accessibility-raw/data-go-15083478.csv");
const ESCALATOR_CSV = path.join(root, "tools/datapack/fixtures/incheon-accessibility-raw/data-go-15010199.csv");
const WHEELCHAIR_CSV = path.join(root, "tools/datapack/fixtures/incheon-accessibility-raw/data-go-15146049.csv");
const LINE1 = "line-98718184f016";
const LINE2 = "line-42b5805f3b5a";

async function loadInputs() {
  const [elevatorBytes, escalatorBytes, wheelchairBytes, topologySnapshot] = await Promise.all([
    readFile(ELEVATOR_CSV),
    readFile(ESCALATOR_CSV),
    readFile(WHEELCHAIR_CSV),
    readFile(path.join(root, "tools/datapack/sources/incheon-transit-station-info-20260724.json"), "utf8")
      .then(JSON.parse)
      .then((snapshot) => ({
        ...snapshot,
        snapshotId: snapshot.snapshotId ?? "incheon-transit-station-info-20260724",
      })),
  ]);
  return { elevatorBytes, escalatorBytes, wheelchairBytes, topologySnapshot };
}

test("인천 accessibility collector는 엘리베이터·에스컬레이터·휠체어리프트 CSV를 topology 60 membership에 join한다", async () => {
  const inputs = await loadInputs();
  const snapshot = collectIncheonAccessibility({
    ...inputs,
    now: new Date("2026-07-24T07:00:00.000Z"),
  });

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.artifactKind, "incheon-accessibility-snapshot");
  assert.equal(snapshot.sourceId, "incheon-transit-accessibility");
  assert.deepEqual(snapshot.datasetIds, ["15083478", "15010199", "15146049"]);
  assert.equal(snapshot.detailUrl, "https://www.data.go.kr/data/15083478/fileData.do");
  assert.equal(snapshot.detailUrls.escalator, "https://www.data.go.kr/data/15010199/fileData.do");
  assert.equal(snapshot.detailUrls.wheelchair_lift, "https://www.data.go.kr/data/15146049/fileData.do");
  assert.equal(snapshot.stationCount, 60);
  assert.equal(snapshot.rowCount, 60);
  assert.equal(snapshot.elevatorRowCount, 213);
  assert.equal(snapshot.escalatorRowCount, 490);
  assert.equal(snapshot.wheelchairRowCount, 3);
  assert.equal(snapshot.elevatorCsvRowCount, 269);
  assert.equal(snapshot.escalatorCsvRowCount, 653);
  assert.equal(snapshot.wheelchairCsvRowCount, 3);
  assert.deepEqual(snapshot.skippedNonStationFacilityRows, [
    "9번환기구(1072)",
    "6번환기구(1082)",
    "대피3",
    "대피4",
  ]);
  assert.deepEqual(snapshot.skippedLine7RowCounts, {
    elevator: 52,
    escalator: 163,
    wheelchair_lift: 0,
  });
  assert.equal(snapshot.rows.length, 60);
  assert.deepEqual(snapshot.lineIds, [LINE2, LINE1]);
  assert.equal(snapshot.official, true);
  assert.equal(snapshot.fixture, false);
  assert.equal(snapshot.credentialRequired, false);
  assert.equal(snapshot.credentialRedacted, true);
  assert.equal(snapshot.capturedAt, "2026-07-24T07:00:00.000Z");
  assert.equal(snapshot.freshUntil, "2026-07-25T07:00:00.000Z");
  assert.equal(
    snapshot.elevatorRawSha256,
    createHash("sha256").update(inputs.elevatorBytes).digest("hex"),
  );
  assert.equal(
    snapshot.escalatorRawSha256,
    createHash("sha256").update(inputs.escalatorBytes).digest("hex"),
  );
  assert.equal(
    snapshot.wheelchairRawSha256,
    createHash("sha256").update(inputs.wheelchairBytes).digest("hex"),
  );
  assert.equal(snapshot.rowsSha256, createHash("sha256").update(JSON.stringify(snapshot.rows)).digest("hex"));
  assert.equal(snapshot.scopeSha256, createHash("sha256").update(JSON.stringify(snapshot.scope)).digest("hex"));
  assert.deepEqual(snapshot.fieldsProvided, [
    "elevator", "escalator", "wheelchair_lift", "status", "verified_at",
  ]);
  assert.equal(snapshot.topologyLineages.length, 2);
  assert.deepEqual(snapshot.topologyLineages, [
    {
      sourceId: "incheon-transit-station-info",
      snapshotId: "incheon-transit-station-info-20260724",
      contentSha256: inputs.topologySnapshot.contentSha256,
      lineId: LINE2,
    },
    {
      sourceId: "incheon-transit-station-info",
      snapshotId: "incheon-transit-station-info-20260724",
      contentSha256: inputs.topologySnapshot.contentSha256,
      lineId: LINE1,
    },
  ]);
  assert.equal(snapshot.rows.every((row) => (
    [LINE1, LINE2].includes(row.lineId)
      && Number.isInteger(row.elevator) && row.elevator >= 0
      && Number.isInteger(row.escalator) && row.escalator >= 0
      && Number.isInteger(row.wheelchair_lift) && row.wheelchair_lift >= 0
  )), true);
  assert.equal(snapshot.rows.reduce((sum, row) => sum + row.elevator, 0), 213);
  assert.equal(snapshot.rows.reduce((sum, row) => sum + row.escalator, 0), 490);
  assert.equal(snapshot.rows.reduce((sum, row) => sum + row.wheelchair_lift, 0), 3);
  assert.equal(snapshot.rows.filter((row) => row.lineId === LINE1).length, 33);
  assert.equal(snapshot.rows.filter((row) => row.lineId === LINE2).length, 27);
  assert.equal(
    snapshot.rows.filter((row) => row.lineId === LINE1).reduce((sum, row) => sum + row.elevator, 0),
    99,
  );
  assert.equal(
    snapshot.rows.filter((row) => row.lineId === LINE2).reduce((sum, row) => sum + row.elevator, 0),
    114,
  );
  assert.equal(
    snapshot.rows.filter((row) => row.lineId === LINE1).reduce((sum, row) => sum + row.escalator, 0),
    283,
  );
  assert.equal(
    snapshot.rows.filter((row) => row.lineId === LINE2).reduce((sum, row) => sum + row.escalator, 0),
    207,
  );
  const byCode = Object.fromEntries(snapshot.rows.map((row) => [row.stationCode, row]));
  assert.equal(byCode["3127"].stationName, "문학경기장");
  assert.ok(byCode["3127"].elevator >= 1);
  assert.ok(byCode["3127"].escalator >= 1);
  assert.equal(byCode["3107"].stationName, "검단호수공원");
  assert.ok(byCode["3107"].elevator >= 1);
  assert.equal(byCode["3111"].stationName, "귤현");
  assert.ok(byCode["3111"].elevator >= 1);
  assert.equal(byCode["3111"].escalator, 0);
  assert.equal(byCode["3132"].stationName, "동막");
  assert.ok(byCode["3132"].elevator >= 1);
  assert.equal(byCode["3132"].escalator, 0);
  assert.equal(byCode["3132"].wheelchair_lift, 1);
  assert.equal(byCode["3120"].stationName, "부평");
  assert.equal(byCode["3120"].wheelchair_lift, 2);
  assert.equal(snapshot.rows.filter((row) => row.wheelchair_lift > 0).length, 2);
  assert.equal(normalizedIncheonStationName("문학역"), "문학경기장");
  assert.equal(normalizedIncheonStationName("가정(루원시티)"), "가정");
  assert.doesNotMatch(JSON.stringify(snapshot), /serviceKey/i);
});

test("인천 accessibility collector는 schema·join·count 변조를 fail closed한다", async () => {
  const inputs = await loadInputs();

  assert.throws(() => parseIncheonAccessibilityCsv({
    ...inputs,
    elevatorBytes: new Uint8Array(),
  }), /elevator CSV bytes/);

  const badHeader = Buffer.from("호선,역명\n1,계양역\n", "utf8");
  assert.throws(() => parseIncheonAccessibilityCsv({
    ...inputs,
    elevatorBytes: badHeader,
  }), /missing column/);

  const badJoin = Buffer.from(
    "호선,역명,장비종류,호기,승강기번호,운행구간,설치위치\n1,존재하지않는역,EL,1,1,구간,위치\n",
    "utf8",
  );
  assert.throws(() => parseIncheonAccessibilityCsv({
    ...inputs,
    elevatorBytes: badJoin,
  }), /join failed|row count|aggregated facility|CSV row count/);

  const truncated = Buffer.from(
    "호선,역명,장비종류,호기,승강기번호,운행구간,설치위치\n1,계양역,EL,1,1,구간,위치\n",
    "utf8",
  );
  assert.throws(() => parseIncheonAccessibilityCsv({
    ...inputs,
    elevatorBytes: truncated,
  }), /row count|aggregated facility|joined row count/);

  const badTopology = {
    ...inputs.topologySnapshot,
    contentSha256: "0".repeat(64),
  };
  assert.throws(() => collectIncheonAccessibility({
    ...inputs,
    topologySnapshot: badTopology,
    now: new Date("2026-07-24T07:00:00.000Z"),
  }), /topology snapshot|station info snapshot/);

  const wrongSnapshotId = {
    ...inputs.topologySnapshot,
    snapshotId: "incheon-transit-station-info-20990101",
  };
  assert.throws(() => collectIncheonAccessibility({
    ...inputs,
    topologySnapshot: wrongSnapshotId,
    now: new Date("2026-07-24T07:00:00.000Z"),
  }), /invalid Incheon topology snapshot/);
});

test("인천 accessibility collector CLI는 absolute output 경로를 강제한다", async () => {
  await assert.rejects(runIncheonAccessibilityCollector([
    "--elevator-input", ELEVATOR_CSV,
    "--escalator-input", ESCALATOR_CSV,
    "--wheelchair-input", WHEELCHAIR_CSV,
    "--topology-snapshot", path.join(root, "tools/datapack/sources/incheon-transit-station-info-20260724.json"),
    "--output", "relative.json",
  ]), /usage: collect-incheon-accessibility/);
});
