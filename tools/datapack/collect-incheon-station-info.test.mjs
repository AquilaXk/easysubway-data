import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  collectIncheonStationInfo,
  parseIncheonStationInfoCsv,
  projectLatLon,
  runIncheonStationInfoCollector,
  stationIdFor,
} from "./collect-incheon-station-info.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const CSV_PATH = path.join(root, "tools/datapack/fixtures/incheon-station-info-raw/data-go-15083751.csv");
const LINE1 = "line-98718184f016";
const LINE2 = "line-42b5805f3b5a";

async function loadCsv() {
  return readFile(CSV_PATH);
}

test("인천 station-info collector는 1·2호선 60역·116 edge·positions를 정규화한다", async () => {
  const csvBytes = await loadCsv();
  const snapshot = collectIncheonStationInfo({
    csvBytes,
    now: new Date("2026-07-24T06:00:00.000Z"),
  });

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.artifactKind, "incheon-station-info-snapshot");
  assert.equal(snapshot.sourceId, "incheon-transit-station-info");
  assert.equal(snapshot.datasetId, "15083751");
  assert.equal(snapshot.detailUrl, "https://www.data.go.kr/data/15083751/fileData.do");
  assert.equal(snapshot.rawRowCount, 71);
  assert.equal(snapshot.admittedRowCount, 60);
  assert.equal(snapshot.excludedLine7Count, 11);
  assert.equal(snapshot.stationCount, 60);
  assert.equal(snapshot.uniqueStationCount, 59);
  assert.equal(snapshot.edgeCount, 116);
  assert.equal(snapshot.positionCount, 60);
  assert.deepEqual(snapshot.lineIds, [LINE2, LINE1]);
  assert.deepEqual(snapshot.lineStationCounts, {
    [LINE1]: 33,
    [LINE2]: 27,
  });
  assert.equal(snapshot.official, true);
  assert.equal(snapshot.fixture, false);
  assert.equal(snapshot.credentialRequired, false);
  assert.equal(snapshot.credentialRedacted, true);
  assert.equal(snapshot.capturedAt, "2026-07-24T06:00:00.000Z");
  assert.equal(snapshot.freshUntil, "2026-07-25T06:00:00.000Z");
  assert.equal(snapshot.observedDataUpdatedAt, "2025-06-30");
  assert.equal(snapshot.rawSha256, createHash("sha256").update(csvBytes).digest("hex"));
  assert.equal(snapshot.scopeSha256, createHash("sha256").update(JSON.stringify(snapshot.scope)).digest("hex"));
  assert.equal(snapshot.edgesSha256, createHash("sha256").update(JSON.stringify(snapshot.edges)).digest("hex"));
  assert.equal(
    snapshot.positionsSha256,
    createHash("sha256").update(JSON.stringify(snapshot.positions)).digest("hex"),
  );
  assert.deepEqual(snapshot.stationCodeCorrections, [{
    lineName: "인천지하철 1호선",
    stationName: "송도달빛축제공원",
    rawStationCode: "3138",
    correctedStationCode: "3139",
    evidence: "seoulmetro-cyberstation-line-data station-cd=3139",
  }]);

  const line1 = snapshot.scope.filter(({ lineId }) => lineId === LINE1);
  const line2 = snapshot.scope.filter(({ lineId }) => lineId === LINE2);
  assert.equal(line1[0].stationName, "검단호수공원");
  assert.equal(line1[0].stationCode, "3107");
  assert.equal(line1.at(-1).stationName, "송도달빛축제공원");
  assert.equal(line1.at(-1).stationCode, "3139");
  assert.equal(line1.find(({ stationName }) => stationName === "국제업무지구").stationCode, "3138");
  assert.equal(line2[0].stationCode, "3201");
  assert.equal(line2.at(-1).stationCode, "3227");
  assert.equal(stationIdFor("인천시청"), "station-423d71b94cdc");
  assert.equal(
    line1.find(({ stationName }) => stationName === "인천시청").stationId,
    line2.find(({ stationName }) => stationName === "인천시청").stationId,
  );

  assert.equal(snapshot.edges.every((edge) => (
    edge.durationSeconds === 120 && edge.distanceMeters === 0
  )), true);
  assert.equal(snapshot.edges.filter(({ lineId }) => lineId === LINE1).length, 64);
  assert.equal(snapshot.edges.filter(({ lineId }) => lineId === LINE2).length, 52);

  const songdo = snapshot.positions.find(({ stationName }) => stationName === "송도달빛축제공원");
  const projected = projectLatLon(songdo.latitude, songdo.longitude);
  assert.equal(songdo.x, projected.x);
  assert.equal(songdo.y, projected.y);
  assert.equal(songdo.labelPolygon.length, 4);
  assert.doesNotMatch(JSON.stringify(snapshot), /serviceKey/i);
  assert.equal(JSON.stringify(snapshot).includes("7호선"), false);
});

test("인천 station-info collector는 schema·좌표·중복 분기를 fail closed한다", async () => {
  const csvBytes = await loadCsv();

  assert.throws(() => parseIncheonStationInfoCsv(new Uint8Array()), /CSV bytes/);

  const badHeader = Buffer.from("역번호,역사명\n3107,검단호수공원\n", "utf8");
  assert.throws(() => parseIncheonStationInfoCsv(badHeader), /missing column/);

  const text = new TextDecoder("utf-8").decode(csvBytes);
  const withUnknownLine = Buffer.from(
    text.replace("인천지하철 1호선", "존재하지않는선", 1),
    "utf8",
  );
  assert.throws(() => parseIncheonStationInfoCsv(withUnknownLine), /unknown line/);

  const withBadOperator = Buffer.from(text.replace("인천교통공사", "다른공사", 1), "utf8");
  assert.throws(() => parseIncheonStationInfoCsv(withBadOperator), /unexpected operator/);

  const withMissingLat = Buffer.from(
    text.replace("37.60256,126.688338", ",126.688338", 1),
    "utf8",
  );
  assert.throws(() => parseIncheonStationInfoCsv(withMissingLat), /invalid coordinates/);

  // 교정 없이 3138 중복이 서로 다른 역사명으로 남으면 fail-closed.
  const withoutSongdoName = Buffer.from(
    text.replace("송도달빛축제공원", "가짜종점", 1),
    "utf8",
  );
  assert.throws(() => parseIncheonStationInfoCsv(withoutSongdoName), /divergent duplicate|station id missing/);
});

test("인천 station-info collector CLI가 snapshot 파일을 기록한다", async (context) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-incheon-collect-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  const output = path.join(outputDir, "snapshot.json");
  const snapshot = await runIncheonStationInfoCollector([
    "--input", CSV_PATH,
    "--output", output,
    "--captured-at", "2026-07-24T06:00:00.000Z",
  ]);
  const written = JSON.parse(await readFile(output, "utf8"));
  assert.equal(written.contentSha256, snapshot.contentSha256);
  assert.equal(written.stationCount, 60);
});
