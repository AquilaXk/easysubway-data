import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectIncheonTimetableLine,
  INCHEON_TIMETABLE_LINES,
  normalizedIncheonTimetableStationName,
  runIncheonTimetableCollector,
} from "./collect-incheon-timetable.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const RAW_DIR = path.join(root, "tools/datapack/fixtures/incheon-timetable-raw");
const NOW = new Date("2026-07-24T08:00:00.000Z");

async function loadTopology() {
  const snapshot = JSON.parse(await readFile(
    path.join(root, "tools/datapack/sources/incheon-transit-station-info-20260724.json"),
    "utf8",
  ));
  return { ...snapshot, snapshotId: "incheon-transit-station-info-20260724" };
}

async function loadFiles(config) {
  const files = {};
  for (const dayCode of ["WEEK", "HOLI"]) {
    for (const direction of ["up", "dn"]) {
      const datasetId = config.datasets[dayCode][direction];
      files[`${dayCode}:${direction}`] = await readFile(path.join(RAW_DIR, `data-go-${datasetId}.csv`));
    }
  }
  return files;
}

test("인천 timetable collector는 1·2호선 WEEK/HOLI 상·하선 FILE을 trip·stop_time으로 정규화한다", async () => {
  const topologySnapshot = await loadTopology();
  for (const config of INCHEON_TIMETABLE_LINES) {
    const files = await loadFiles(config);
    const snapshot = collectIncheonTimetableLine({
      files,
      topologySnapshot,
      lineNumber: config.lineNumber,
      now: NOW,
    });
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.artifactKind, "incheon-train-timetable-snapshot");
    assert.equal(snapshot.sourceId, config.sourceId);
    assert.equal(snapshot.lineId, config.lineId);
    assert.equal(snapshot.tripCount, config.tripCount);
    assert.equal(snapshot.stopTimeCount, config.stopTimeCount);
    assert.equal(snapshot.rolloverTripCount, config.rolloverTripCount);
    assert.equal(snapshot.destinationLabelNormalizedCount, config.destinationLabelNormalizedCount);
    assert.equal(snapshot.dayModel, "WEEK_HOLI_NO_SATURDAY_FILE");
    assert.deepEqual(snapshot.dayCodes, ["WEEK", "HOLI"]);
    assert.deepEqual(snapshot.directions, ["up", "dn"]);
    assert.equal(snapshot.official, true);
    assert.equal(snapshot.fixture, false);
    assert.equal(snapshot.credentialRequired, false);
    assert.equal(snapshot.credentialRedacted, true);
    assert.equal(snapshot.topologySnapshotId, "incheon-transit-station-info-20260724");
    assert.equal(snapshot.topologyContentSha256, topologySnapshot.contentSha256);
    assert.equal(snapshot.tripsSha256, createHash("sha256").update(JSON.stringify(snapshot.trips)).digest("hex"));
    assert.equal(snapshot.rowsSha256, snapshot.tripsSha256);
    assert.equal(
      snapshot.contentSha256,
      createHash("sha256").update(JSON.stringify({
        tripsSha256: snapshot.tripsSha256,
        stopTimeCount: snapshot.stopTimeCount,
        stationCount: config.stationCount,
      })).digest("hex"),
    );
    assert.ok(snapshot.trips.every((trip) => trip.stops.length >= 2));
    assert.ok(!JSON.stringify(snapshot).includes("line-15b3b8a93259"));
  }
});

test("인천 timetable 역명 정규화는 축약·괄호·역 접미를 topology 정본에 맞춘다", () => {
  assert.equal(normalizedIncheonTimetableStationName("문학"), "문학경기장");
  assert.equal(normalizedIncheonTimetableStationName("주안국가"), "주안국가산단");
  assert.equal(normalizedIncheonTimetableStationName("서부여성"), "서부여성회관");
  assert.equal(normalizedIncheonTimetableStationName("석바위"), "석바위시장");
  assert.equal(normalizedIncheonTimetableStationName("가정중앙"), "가정중앙시장");
  assert.equal(normalizedIncheonTimetableStationName("아시아드"), "아시아드경기장");
  assert.equal(normalizedIncheonTimetableStationName("가정(루원시티)"), "가정");
  assert.equal(normalizedIncheonTimetableStationName("계양역"), "계양");
});

test("인천 timetable collector는 topology snapshotId·contentSha256 변조를 fail-closed한다", async () => {
  const topologySnapshot = await loadTopology();
  const config = INCHEON_TIMETABLE_LINES[0];
  const files = await loadFiles(config);

  assert.throws(() => collectIncheonTimetableLine({
    files,
    topologySnapshot: { ...topologySnapshot, snapshotId: "incheon-transit-station-info-20990101" },
    lineNumber: 1,
    now: NOW,
  }), /invalid Incheon topology snapshot/);

  assert.throws(() => collectIncheonTimetableLine({
    files,
    topologySnapshot: { ...topologySnapshot, contentSha256: "0".repeat(64) },
    lineNumber: 1,
    now: NOW,
  }), /invalid Incheon (?:topology|station info) snapshot/);

  const badFiles = { ...files, "WEEK:up": Buffer.from("시발역,종착역,열차번호\n", "utf8") };
  assert.throws(() => collectIncheonTimetableLine({
    files: badFiles,
    topologySnapshot,
    lineNumber: 1,
    now: NOW,
  }), /CSV empty|header mismatch|station columns|column count/);
});

test("인천 timetable collector CLI는 topology basename pin과 absolute output을 강제한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-incheon-timetable-"));
  try {
    await assert.rejects(() => runIncheonTimetableCollector([
      "--input-dir", RAW_DIR,
      "--topology-snapshot", path.join(root, "tools/datapack/sources/incheon-transit-station-info-20260724.json"),
      "--output-dir", "relative-out",
      "--captured-at", "2026-07-24T08:00:00.000Z",
    ]), /absolute|usage/i);

    const wrongTopology = path.join(directory, "incheon-transit-station-info-20990101.json");
    await writeFile(wrongTopology, await readFile(
      path.join(root, "tools/datapack/sources/incheon-transit-station-info-20260724.json"),
    ));
    await assert.rejects(() => runIncheonTimetableCollector([
      "--input-dir", RAW_DIR,
      "--topology-snapshot", wrongTopology,
      "--output-dir", directory,
      "--captured-at", "2026-07-24T08:00:00.000Z",
    ]), /topology snapshot path must be/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
