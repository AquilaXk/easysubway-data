import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  collectIncheonStationInfo,
  decodeIncheonStationInfoCsv,
  normalizeIncheonStationName,
  parseIncheonStationInfoCsv,
  projectLatLon,
  runIncheonStationInfoCollector,
  stationIdFor,
} from "./collect-incheon-station-info.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const CSV_PATH = path.join(root, "tools/datapack/fixtures/incheon-station-info-raw/data-go-15083751.csv");
const LINE1 = "line-98718184f016";
const LINE2 = "line-42b5805f3b5a";
const LINE7 = "line-15b3b8a93259";

async function loadCsv() {
  return readFile(CSV_PATH);
}

test("인천 station-info collector는 1·2·7호선 71역 membership/positions와 1·2호선 116 edge를 정규화한다", async () => {
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
  assert.equal(snapshot.admittedRowCount, 71);
  assert.equal(snapshot.excludedLine7Count, 0);
  assert.equal(snapshot.admittedLine7Count, 11);
  assert.equal(snapshot.stationCount, 71);
  assert.equal(snapshot.uniqueStationCount, 69);
  assert.equal(snapshot.edgeCount, 116);
  assert.equal(snapshot.positionCount, 71);
  assert.deepEqual(snapshot.lineIds, [LINE2, LINE1, LINE7]);
  assert.deepEqual(snapshot.topologyLineIds, [LINE2, LINE1]);
  assert.deepEqual(snapshot.lineStationCounts, {
    [LINE1]: 33,
    [LINE2]: 27,
    [LINE7]: 11,
  });
  assert.equal(snapshot.official, true);
  assert.equal(snapshot.fixture, false);
  assert.equal(snapshot.credentialRequired, false);
  assert.equal(snapshot.credentialRedacted, true);
  assert.equal(snapshot.capturedAt, "2026-07-24T06:00:00.000Z");
  assert.equal(snapshot.freshUntil, "2026-07-25T06:00:00.000Z");
  assert.equal(snapshot.observedDataUpdatedAt, "2025-06-30");
  assert.equal(snapshot.rawSha256, createHash("sha256").update(csvBytes).digest("hex"));
  assert.equal(snapshot.scopeSha256, "b6c0040233f0d967b40edde161521c8e48d6767427246d94047b5b33536be154");
  assert.equal(snapshot.edgesSha256, "97cabc36da6171490b7d3b7b87848200aa0aca0cd70a598027d6f07c46929af5");
  assert.equal(snapshot.positionsSha256, "3d56d04c75db75e676516c8d3e819f67e94e8759309345505f8d451b526086bc");
  assert.equal(snapshot.contentSha256, "710878689282ba967697cd9411940b657a51eee5499106ed884d5bd9111501a8");
  const line1 = snapshot.scope.filter(({ lineId }) => lineId === LINE1);
  const line2 = snapshot.scope.filter(({ lineId }) => lineId === LINE2);
  const line7 = snapshot.scope.filter(({ lineId }) => lineId === LINE7);
  assert.equal(line1[0].stationName, "검단호수공원");
  assert.equal(line1[0].stationCode, "3107");
  assert.equal(line1.at(-1).stationName, "송도달빛축제공원");
  assert.equal(line1.at(-1).stationCode, "3139");
  assert.equal(line1.find(({ stationName }) => stationName === "국제업무지구").stationCode, "3138");
  assert.deepEqual(snapshot.stationCodeDerivations, [
    {
      lineId: LINE1,
      rawStationCode: "3138",
      stationName: "국제업무지구",
      internalStationCode: "3138",
      lineSequence: 32,
      basis: "OFFICIAL_FILE_LINE_SEQUENCE",
      datasetId: "15083751",
    },
    {
      lineId: LINE1,
      rawStationCode: "3138",
      stationName: "송도달빛축제공원",
      internalStationCode: "3139",
      lineSequence: 33,
      basis: "OFFICIAL_FILE_LINE_SEQUENCE",
      datasetId: "15083751",
    },
  ]);
  assert.equal(line2[0].stationCode, "3201");
  assert.equal(line2.at(-1).stationCode, "3227");
  assert.equal(stationIdFor("인천시청"), "station-423d71b94cdc");
  assert.equal(
    line1.find(({ stationName }) => stationName === "인천시청").stationId,
    line2.find(({ stationName }) => stationName === "인천시청").stationId,
  );

  assert.deepEqual(line7.map(({ stationCode, stationName, stationId }) => (
    `${stationCode}:${stationName}:${stationId}`
  )), [
    "3753:까치울:station-899129ade388",
    "3754:부천종합운동장:station-28be6a80c00e",
    "3755:춘의:station-2558772de4e6",
    "3756:신중동:station-23a4489159af",
    "3757:부천시청:station-a8457c7435d9",
    "3758:상동:station-751b29075be1",
    "3759:삼산체육관:station-c8bd2d4016aa",
    "3760:굴포천:station-141f478238c0",
    "3761:부평구청:station-662a880cfe7d",
    "3762:산곡:station-6ca3b5e00e68",
    "3763:석남(거북시장):station-57db2f1fb4f6",
  ]);
  assert.equal(normalizeIncheonStationName("석남(거북시장)"), "석남");
  assert.equal(stationIdFor("석남(거북시장)", LINE7), "station-57db2f1fb4f6");
  assert.equal(stationIdFor("석남(거북시장)", LINE2), "station-37866f28b417");
  assert.equal(
    line1.find(({ stationName }) => stationName === "부평구청").stationId,
    line7.find(({ stationName }) => stationName === "부평구청").stationId,
  );

  assert.equal(snapshot.edges.every((edge) => (
    edge.durationSeconds === 120 && edge.distanceMeters === 0 && edge.lineId !== LINE7
  )), true);
  assert.equal(snapshot.edges.filter(({ lineId }) => lineId === LINE1).length, 64);
  assert.equal(snapshot.edges.filter(({ lineId }) => lineId === LINE2).length, 52);
  assert.equal(snapshot.edges.filter(({ lineId }) => lineId === LINE7).length, 0);

  const songdo = snapshot.positions.find(({ stationName }) => stationName === "송도달빛축제공원");
  const projected = projectLatLon(songdo.latitude, songdo.longitude);
  assert.equal(songdo.x, projected.x);
  assert.equal(songdo.y, projected.y);
  assert.equal(songdo.labelPolygon.length, 4);
  assert.equal(snapshot.positions.filter(({ lineId }) => lineId === LINE7).length, 11);
  assert.doesNotMatch(JSON.stringify(snapshot), /serviceKey/i);
  assert.doesNotMatch(JSON.stringify(snapshot), /cyberstation|web/i);

  const officialRows = new TextDecoder().decode(csvBytes).split("\n");
  const firstLine1Index = officialRows.findIndex((row) => row.startsWith("3107,검단호수공원,"));
  const secondLine1Index = officialRows.findIndex((row) => row.startsWith("3108,신검단중앙,"));
  [officialRows[firstLine1Index], officialRows[secondLine1Index]] = [
    officialRows[secondLine1Index],
    officialRows[firstLine1Index],
  ];
  const reordered = collectIncheonStationInfo({
    csvBytes: Buffer.from(officialRows.join("\n"), "utf8"),
    now: new Date("2026-07-24T06:00:00.000Z"),
  });
  assert.deepEqual(reordered.scope, snapshot.scope);
  assert.deepEqual(reordered.edges, snapshot.edges);
  assert.deepEqual(reordered.positions, snapshot.positions);
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

  // 원본 3138 중복은 정해진 공식 line sequence에서만 내부 code로 분기한다.
  const withoutSongdoName = Buffer.from(
    text.replace("송도달빛축제공원", "가짜종점", 1),
    "utf8",
  );
  assert.throws(() => parseIncheonStationInfoCsv(withoutSongdoName), /official line identity drift/);

  const withUnexpectedDuplicate = Buffer.from(
    text.replace("3137,센트럴파크", "3138,센트럴파크", 1),
    "utf8",
  );
  assert.throws(() => parseIncheonStationInfoCsv(withUnexpectedDuplicate), /official line code sequence/);

  const withGap = Buffer.from(
    text.replace("3136,인천대입구", "3135,인천대입구", 1),
    "utf8",
  );
  assert.throws(() => parseIncheonStationInfoCsv(withGap), /official line code sequence/);
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
  assert.equal(written.stationCount, 71);
  assert.equal(written.admittedLine7Count, 11);
});

test("current Incheon public attachment는 bounded download와 strict EUC-KR decode로 create-new snapshot을 만든다", async (context) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-incheon-current-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  const output = path.join(outputDir, "snapshot.json");
  const csvBytes = await loadCsv();
  const requests = [];
  const detailUrl = "https://www.data.go.kr/data/15083751/fileData.do";
  const downloadUrl = "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003700002&fileDetailSn=1&insertDataPrcus=N";
  const fetchImpl = async (url) => {
    requests.push(String(url));
    if (String(url) === detailUrl) {
      return new Response(`<a href="${downloadUrl}">download</a>`, { status: 200 });
    }
    if (String(url) === downloadUrl) return new Response(csvBytes, { status: 200 });
    return new Response("not found", { status: 404 });
  };

  const snapshot = await runIncheonStationInfoCollector([
    "--download",
    "--output", output,
    "--captured-at", "2026-08-11T01:02:03.000Z",
  ], { fetchImpl });
  assert.deepEqual(requests, [detailUrl, downloadUrl]);
  assert.equal(snapshot.capturedAt, "2026-08-11T01:02:03.000Z");
  assert.equal(snapshot.freshUntil, "2026-08-12T01:02:03.000Z");
  assert.equal(decodeIncheonStationInfoCsv(Buffer.from([0xb0, 0xa1])), "가");

  const original = await readFile(output);
  await assert.rejects(
    () => runIncheonStationInfoCollector([
      "--download",
      "--output", output,
      "--captured-at", "2026-08-11T01:02:03.000Z",
    ], { fetchImpl }),
    /output.*exists|EEXIST/,
  );
  assert.deepEqual(await readFile(output), original);
});
