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

test("인천 timetable collector는 supplied current topology identity에 lineage를 결속한다", async () => {
  const topologySnapshot = await loadTopology();
  Object.assign(topologySnapshot.scope.find(({ lineId, stationCode }) => (
    lineId === "line-42b5805f3b5a" && stationCode === "3210"
  )), { stationName: "서해구청", nameEn: "Seohae-gu Office" });
  topologySnapshot.positions.find(({ lineId, stationCode }) => (
    lineId === "line-42b5805f3b5a" && stationCode === "3210"
  )).stationName = "서해구청";
  Object.assign(topologySnapshot, {
    capturedAt: "2026-08-28T03:47:35.000Z",
    freshUntil: "2026-08-29T03:47:35.000Z",
    snapshotId: "incheon-transit-station-info-20260828",
    scopeSha256: createHash("sha256").update(JSON.stringify(topologySnapshot.scope)).digest("hex"),
    positionsSha256: createHash("sha256").update(JSON.stringify(topologySnapshot.positions)).digest("hex"),
    contentSha256: createHash("sha256").update(JSON.stringify({
      scope: topologySnapshot.scope,
      edges: topologySnapshot.edges,
      positions: topologySnapshot.positions,
    })).digest("hex"),
  });
  const config = INCHEON_TIMETABLE_LINES[1];
  const snapshot = collectIncheonTimetableLine({
    files: await loadFiles(config),
    topologySnapshot,
    lineNumber: config.lineNumber,
    now: new Date("2026-08-28T04:00:00.000Z"),
  });
  assert.equal(snapshot.topologySnapshotId, topologySnapshot.snapshotId);
  assert.equal(snapshot.topologyContentSha256, topologySnapshot.contentSha256);
  assert.deepEqual(snapshot.topologyLineages, [{
    sourceId: "incheon-transit-station-info",
    snapshotId: topologySnapshot.snapshotId,
    contentSha256: topologySnapshot.contentSha256,
    lineId: config.lineId,
  }]);
});

test("인천 timetable collector download mode는 official detail에서 정확히 8개 CSV를 받아 current parser에 전달한다", async () => {
  const topologyPath = path.join(root, "tools/datapack/sources/incheon-transit-station-info-20260724.json");
  const outputDirectory = await mkdtemp(path.join(tmpdir(), "easysubway-incheon-timetable-download-"));
  const calls = [];
  const datasetIds = INCHEON_TIMETABLE_LINES.flatMap(({ datasets }) => [
    datasets.WEEK.up,
    datasets.WEEK.dn,
    datasets.HOLI.up,
    datasets.HOLI.dn,
  ]);
  try {
    const outputs = await runIncheonTimetableCollector([
      "--download",
      "--topology-snapshot", topologyPath,
      "--output-dir", outputDirectory,
      "--captured-at", "2026-07-24T08:00:00.000Z",
    ], {
      fetchImpl: async (input, init) => {
        const url = new URL(input);
        calls.push({ url: url.toString(), headers: init?.headers });
        const datasetId = /^\/data\/(\d+)\/fileData\.do$/u.exec(url.pathname)?.[1];
        if (datasetId) {
          return new Response(
            `<a href="/cmm/cmm/fileDownload.do?atchFileId=FILE_${datasetId}&amp;fileDetailSn=1">CSV</a>`,
          );
        }
        const fileId = /^FILE_(\d+)$/u.exec(url.searchParams.get("atchFileId") ?? "")?.[1];
        if (url.origin === "https://www.data.go.kr"
          && url.pathname === "/cmm/cmm/fileDownload.do"
          && fileId
          && url.searchParams.get("fileDetailSn") === "1") {
          return new Response(await readFile(path.join(RAW_DIR, `data-go-${fileId}.csv`)));
        }
        assert.fail(`unexpected request: ${url}`);
      },
    });
    assert.equal(outputs.length, 2);
    assert.deepEqual(calls.filter(({ url }) => new URL(url).pathname.endsWith("/fileData.do"))
      .map(({ url }) => url), datasetIds.map((datasetId) => `https://www.data.go.kr/data/${datasetId}/fileData.do`));
    assert.equal(calls.length, datasetIds.length * 2);
    for (const { url, headers } of calls) {
      assert.equal(headers["User-Agent"], "easysubway-datapack-collector/1.0");
      if (new URL(url).pathname === "/cmm/cmm/fileDownload.do") {
        const datasetId = /^FILE_(\d+)$/u.exec(new URL(url).searchParams.get("atchFileId"))?.[1];
        assert.equal(headers.Referer, `https://www.data.go.kr/data/${datasetId}/fileData.do`);
      }
    }
    const snapshots = await Promise.all(outputs.map(async (output) => JSON.parse(await readFile(output, "utf8"))));
    assert.deepEqual(snapshots.map(({ tripCount, stopTimeCount }) => ({ tripCount, stopTimeCount })), [
      { tripCount: 574, stopTimeCount: 18_392 },
      { tripCount: 840, stopTimeCount: 22_506 },
    ]);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
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
    ]), /invalid Incheon topology snapshot/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("인천 timetable download mode는 canonical FILE 요청·raw provenance·actual capture time을 묶는다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-incheon-timetable-download-"));
  const topologyPath = path.join(root, "tools/datapack/sources/incheon-transit-station-info-20260724.json");
  const config = INCHEON_TIMETABLE_LINES[0];
  const requests = [];
  const downloadUrls = new Map();
  for (const dayCode of ["WEEK", "HOLI"]) {
    for (const direction of ["up", "dn"]) {
      const datasetId = config.datasets[dayCode][direction];
      downloadUrls.set(datasetId, `https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_0000000037${datasetId}&fileDetailSn=1&insertDataPrcus=N`);
    }
  }
  const fetchImpl = async (url, options = {}) => {
    const value = String(url);
    requests.push({ url: value, headers: options.headers });
    const detail = /^https:\/\/www\.data\.go\.kr\/data\/(\d+)\/fileData\.do$/u.exec(value);
    if (detail) return new Response(`<a href="${downloadUrls.get(detail[1])}">download</a>`, { status: 200 });
    const datasetId = [...downloadUrls.entries()].find(([, downloadUrl]) => downloadUrl === value)?.[0];
    if (datasetId) return new Response(await readFile(path.join(RAW_DIR, `data-go-${datasetId}.csv`)), { status: 200 });
    throw new Error(`unexpected request: ${value}`);
  };
  try {
    const outputs = await runIncheonTimetableCollector([
      "--download",
      "--topology-snapshot", topologyPath,
      "--output-dir", directory,
      "--line", "1",
    ], { fetchImpl, now: () => NOW });
    assert.equal(outputs.length, 1);
    const snapshot = JSON.parse(await readFile(outputs[0], "utf8"));
    assert.equal(snapshot.capturedAt, NOW.toISOString());
    assert.equal(snapshot.downloadProvenance.length, 4);
    assert.deepEqual(snapshot.downloadProvenance.map(({ datasetId }) => datasetId), ["15051203", "15051204", "15051205", "15051206"]);
    for (const entry of snapshot.downloadProvenance) {
      assert.equal(entry.rawSha256, createHash("sha256").update(await readFile(path.join(RAW_DIR, `data-go-${entry.datasetId}.csv`))).digest("hex"));
      assert.equal(entry.downloadUrl, downloadUrls.get(entry.datasetId));
    }
    assert.equal(requests.length, 8);
    for (const request of requests.filter(({ url }) => url.includes("fileDownload.do"))) {
      assert.equal(request.headers.Referer, `https://www.data.go.kr/data/${snapshot.downloadProvenance.find(({ downloadUrl }) => downloadUrl === request.url).datasetId}/fileData.do`);
      assert.equal(request.headers["User-Agent"], "easysubway-datapack-collector/1.0");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("인천 timetable download mode는 malformed FILE link·restamp·stale topology 전에 fail-closed한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-incheon-timetable-deny-"));
  const topologyPath = path.join(root, "tools/datapack/sources/incheon-transit-station-info-20260724.json");
  try {
    await assert.rejects(() => runIncheonTimetableCollector([
      "--download", "--topology-snapshot", topologyPath, "--output-dir", directory,
      "--captured-at", NOW.toISOString(),
    ]), /usage/i);
    await assert.rejects(() => runIncheonTimetableCollector([
      "--download", "--topology-snapshot", topologyPath, "--output-dir", "relative-out",
    ]), /usage/i);
    await assert.rejects(() => runIncheonTimetableCollector([
      "--download", "--topology-snapshot", topologyPath, "--output-dir", directory, "--line", "1",
    ], {
      now: () => NOW,
      fetchImpl: async () => new Response('<a href="https://invalid.example/file">bad</a>', { status: 200 }),
    }), /canonical FILE download URL/i);
    assert.deepEqual(await (async () => {
      const { readdir } = await import("node:fs/promises");
      return readdir(directory);
    })(), []);

    const staleTopology = path.join(directory, "incheon-transit-station-info-20260724.json");
    const stale = JSON.parse(await readFile(topologyPath, "utf8"));
    await writeFile(staleTopology, JSON.stringify(stale));
    await assert.rejects(() => runIncheonTimetableCollector([
      "--input-dir", RAW_DIR, "--topology-snapshot", staleTopology, "--output-dir", directory,
      "--captured-at", "2026-07-25T06:00:00.000Z", "--line", "1",
    ]), /stale at capture time/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
