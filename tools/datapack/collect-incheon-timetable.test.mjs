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
import { createDataGoPortalFetch } from "./lib/data-go-test-portal.mjs";
import { assertErrorOmitsSecrets, defineSourceCollectionRetryTests } from "./lib/source-collection-retry-test-support.mjs";

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
    assert.equal(Object.hasOwn(snapshot, "downloadProvenance"), false);
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
  const filesByDatasetId = Object.fromEntries(await Promise.all(
    datasetIds.map(async (datasetId) => [datasetId, await readFile(path.join(RAW_DIR, `data-go-${datasetId}.csv`))]),
  ));
  try {
    const outputs = await runIncheonTimetableCollector([
      "--download",
      "--topology-snapshot", topologyPath,
      "--output-dir", outputDirectory,
    ], {
      now: NOW,
      fetchImpl: createDataGoPortalFetch(filesByDatasetId, { calls }),
    });
    assert.equal(outputs.length, 2);
    assert.deepEqual(calls.filter(({ url }) => new URL(url).pathname.endsWith("/fileData.do"))
      .map(({ url }) => url), datasetIds.map((datasetId) => `https://www.data.go.kr/data/${datasetId}/fileData.do`));
    assert.equal(calls.length, datasetIds.length * 3);
    for (const { url, init } of calls) {
      assert.equal(init.headers["User-Agent"], "easysubway-datapack-collector/1.0");
      if (new URL(url).pathname === "/cmm/cmm/fileDownload.do") {
        const datasetId = datasetIds.find((candidate) => `FILE_${String(candidate).padStart(15, "0")}` === new URL(url).searchParams.get("atchFileId"));
        assert.equal(init.headers.Referer, `https://www.data.go.kr/data/${datasetId}/fileData.do`);
      }
    }
    const snapshots = await Promise.all(outputs.map(async (output) => JSON.parse(await readFile(output, "utf8"))));
    assert.deepEqual(snapshots.map(({ tripCount, stopTimeCount }) => ({ tripCount, stopTimeCount })), [
      { tripCount: 574, stopTimeCount: 18_392 },
      { tripCount: 840, stopTimeCount: 22_506 },
    ]);
    for (const [index, snapshot] of snapshots.entries()) {
      const config = INCHEON_TIMETABLE_LINES[index];
      const expectedProvenance = [];
      for (const dayCode of ["WEEK", "HOLI"]) {
        for (const direction of ["up", "dn"]) {
          const datasetId = config.datasets[dayCode][direction];
          const bytes = filesByDatasetId[datasetId];
          expectedProvenance.push({
            dayCode,
            direction,
            datasetId,
            detailUrl: `https://www.data.go.kr/data/${datasetId}/fileData.do`,
            downloadUrl: `https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_${String(datasetId).padStart(15, "0")}&fileDetailSn=1&insertDataPrcus=N`,
            rawSha256: createHash("sha256").update(bytes).digest("hex"),
          });
        }
      }
      assert.equal(snapshot.capturedAt, NOW.toISOString());
      assert.deepEqual(snapshot.downloadProvenance, expectedProvenance);
    }
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
  const calls = [];
  const filesByDatasetId = {};
  const downloadUrls = new Map();
  for (const dayCode of ["WEEK", "HOLI"]) {
    for (const direction of ["up", "dn"]) {
      const datasetId = config.datasets[dayCode][direction];
      filesByDatasetId[datasetId] = await readFile(path.join(RAW_DIR, `data-go-${datasetId}.csv`));
      downloadUrls.set(datasetId, `https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_${String(datasetId).padStart(15, "0")}&fileDetailSn=1&insertDataPrcus=N`);
    }
  }
  const fetchImpl = createDataGoPortalFetch(filesByDatasetId, { calls });
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
    assert.equal(calls.length, 12);
    for (const request of calls.filter(({ url }) => url.includes("fileDownload.do"))) {
      assert.equal(request.init.headers.Referer, `https://www.data.go.kr/data/${snapshot.downloadProvenance.find(({ downloadUrl }) => downloadUrl === request.url).datasetId}/fileData.do`);
      assert.equal(request.init.headers["User-Agent"], "easysubway-datapack-collector/1.0");
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
    }), /exactly one download action/i);
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

const retryFilesByDatasetId = {};
const retryDownloadUrls = new Map();
for (const dayCode of ["WEEK", "HOLI"]) {
  for (const direction of ["up", "dn"]) {
    const datasetId = INCHEON_TIMETABLE_LINES[0].datasets[dayCode][direction];
    retryFilesByDatasetId[datasetId] = await readFile(path.join(RAW_DIR, `data-go-${datasetId}.csv`));
    retryDownloadUrls.set(datasetId, `https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_${String(datasetId).padStart(15, "0")}&fileDetailSn=1&insertDataPrcus=N`);
  }
}
const incheonTimetablePortalFetch = createDataGoPortalFetch(retryFilesByDatasetId);

async function collectIncheonTimetableVia(fetchImpl, sleepImpl = async () => {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-incheon-timetable-retry-"));
  try {
    const outputs = await runIncheonTimetableCollector([
      "--download",
      "--topology-snapshot", path.join(root, "tools/datapack/sources/incheon-transit-station-info-20260724.json"),
      "--output-dir", directory,
      "--line", "1",
    ], { fetchImpl, sleepImpl, randomImpl: () => 0, now: () => NOW });
    return await Promise.all(outputs.map((output) => readFile(output, "utf8")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

defineSourceCollectionRetryTests({
  name: "인천 timetable collector",
  httpError: /data\.go\.kr \d+ detail HTTP 403/,
  delegate: incheonTimetablePortalFetch,
  headers: { "content-type": "text/html" },
  run: ({ fetchImpl, sleepImpl }) => collectIncheonTimetableVia(fetchImpl, sleepImpl),
});

test("인천 timetable collector는 FILE 요청이 HTTP 503을 만나면 같은 요청을 다시 보내고, 소진하면 기존 HTTP 오류로 끝난다", async () => {
  const [firstFileUrl] = retryDownloadUrls.values();
  let recoveredCalls = 0;
  await collectIncheonTimetableVia(async (url, init) => {
    if (String(url) !== firstFileUrl) return incheonTimetablePortalFetch(url, init);
    recoveredCalls += 1;
    return recoveredCalls === 1 ? new Response("busy", { status: 503 }) : incheonTimetablePortalFetch(url, init);
  });
  assert.equal(recoveredCalls, 2);

  let exhaustedCalls = 0;
  await assert.rejects(collectIncheonTimetableVia(async (url, init) => {
    if (String(url) !== firstFileUrl) return incheonTimetablePortalFetch(url, init);
    exhaustedCalls += 1;
    return new Response("busy", { status: 503 });
  }), /data\.go\.kr \d+ file HTTP 503/);
  assert.equal(exhaustedCalls, 3);
});

test("인천 timetable collector는 HTTP 429를 Retry-After 유무로 가르고, 소진된 전송 오류에 URL을 싣지 않는다", async () => {
  let unhinted = 0;
  await assert.rejects(collectIncheonTimetableVia(async () => { unhinted += 1; return new Response("slow", { status: 429 }); }), /detail HTTP 429/);
  assert.equal(unhinted, 2);

  let hinted = 0;
  await assert.rejects(collectIncheonTimetableVia(async () => { hinted += 1; return new Response("slow", { status: 429, headers: { "retry-after": "21" } }); }), /RETRY_AFTER_EXCEEDS_CAP/);
  assert.equal(hinted, 1);

  const leaky = async () => { throw Object.assign(new Error("connect failed"), { code: "ECONNRESET" }); };
  const failure = await collectIncheonTimetableVia(leaky).catch((error) => error);
  assert.equal(failure.code, "ECONNRESET");
  assertErrorOmitsSecrets(failure, ["www.data.go.kr", "fileData.do"]);
});
