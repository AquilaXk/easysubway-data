import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseSeoulMetroTransferCsv } from "./collect-seoul-metro-transfer-car-door-duration.mjs";
import {
  PINNED_EXCLUDED_SOURCE_ROWS,
  SEOUL_MEASURED_TRANSFER_METRICS_PATH,
  buildSeoulMeasuredTransferMetrics,
  canonicalSeoulMeasuredTransferMetricsJson,
  readSeoulMeasuredTransferMetricsInputs,
  STATION_CODE_CATALOG_PATH,
  deriveSeoulMeasuredTransferMetrics,
  readStationCodeCatalogRows,
} from "./build-seoul-measured-transfer-metrics.mjs";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
// #876 표본: 15098252 원문 CP949 바이트에서 고른 13행(collect-seoul-metro-transfer-car-door-duration.test.mjs와 같은 표본).
const SAMPLE = Buffer.from("IrDtwK+5+MijIiwiyK+9wr3DwNu/qiIsIsivvcK9w8Dbv6ogxNq15SIsIsivvcK9w8DbIMijvLEiLCLHz8L3IL+twvcguea46SIsIsfPwvfAp8ShKMijwvcpIiwix8/C98CnxKEoua4pIiwiyK+9wsG+t+G/qiIsIsivvcIgv63C9yC55rjpIiwiyK+9wiC9wsL3wKfEoSjIo8L3KSIsIsivvcIgvcLC98CnxKEoua4pIiwivNK/5L3DsKMiDQoxLLytv++/qiwiMDE1MCIsIjEiLL3Dw7sguea46SwiMTAiLCI0IiwiMDQyNyIsvPe068DUsbgguea46SwiMSIsIjEiLCIwMzozNCINCjIsvK2/77+qLCIwMTUwIiwiMSIss7K/tSC55rjpLCIxIiwiMiIsIjA0MjUiLMi4x/Yguea46SwiMTAiLCI0IiwiMDM6NDAiDQozLLytv++/qiwiMDE1MCIsIjEiLLOyv7Uguea46SwiMSIsIjIiLCIwNDI3Iiy897TrwNSxuCC55rjpLCIxIiwiMSIsIjAzOjM0Ig0KNCy8rb/vv6osIjAxNTAiLCIxIiy9w8O7ILnmuOksIjEwIiwiNCIsIjA0MjUiLMi4x/Yguea46SwiMTAiLCI0IiwiMDM6NDAiDQo3Nyyx3cO1sbjDuywiMTcwMyIsIjEiLLyuvPYguea46SwiNyIsIjEiLCIxNzUwIiyxpLjtILnmuOksIjciLCIxIiwiMDA6MDAiDQoxNDQsvLq89iwiMDIxMSIsIjIiLLDHtOvA1LG4ILnmuOksIjEwIiwiNCIsIjAyNDQiLL/rtOQguea46SwiMSIsIjEiLCIwMzozMiINCjE0NSy8urz2LCIwMjExIiwiMiIsttK8tiC55rjpLEFsbCxBbGwsIjAyNDQiLL/rtOQguea46SxBbGwsQWxsLCIwMDowNSINCjU1NyzAzLz2LCIyNzM4IiwiNyIss7u55iC55rjpLCIyIiwiMiIsIjA0MzEiLLW/wNsguea46SwiMSIsIjEiLCIwNToxNyINCjcxMizB37b7LCIxMjAxIiyw5sDHvLEsyLix4iC55rjpLCI1IiwiMSIsIjEzMDkiLLvzusAguea46SwiMSIsIjIiLA0KNzEzLMHftvssIjEyMDEiLLDmwMe8sSy787rAILnmuOksIjgiLCIyIiwiMTMwOSIsu/O6wCC55rjpLCIzIiwiMyIsIjAxOjAwIg0KNzE0LMHftvssIjEyMDEiLLDmwMe8sSzIuLHiILnmuOksIjEiLCIyIiwiMTMwNyIsyLix4iC55rjpLCI1IiwiMiIsIjAwOjAwIg0KNzE2LMHftvssIjEyMDEiLLDmwMe8sSzIuLHiILnmuOksIjEiLCIyIiwiMTMwNyIsyLix4iC55rjpLCI0IiwiNCIsIjAwOjAwIg0KOTk5LLyus7IsIjMyMTMiLMDOw7UyLLChwaTB377TvcPA5SC55rjpLCIyIiwiMyIsIjM3NjIiLLvqsO4guea46SwiMSIsIjQiLCIwNTo0NSINCg==", "base64");
const SEOUL_STATION = "station-2af75c3d707b";
const LINE_1 = "line-472a81add377";
const LINE_4 = "seoul-4";
const JUNGNANG = "station-edf782c1647a";
const GYEONGUI = "line-6e39be0cb6e2";
const GYEONGCHUN = "line-54a7b980b7c3";
const CHONGSHIN = "station-2a2d0080fa4a";
const LINE_7 = "line-15b3b8a93259";

let cached;
async function inputs() {
  if (!cached) {
    const [catalogBytes, packBytes] = await Promise.all([
      readFile(path.join(root, STATION_CODE_CATALOG_PATH)),
      readFile(path.join(root, "tools/datapack/release/capital-production-canonical-pack.json")),
    ]);
    cached = { catalogRows: readStationCodeCatalogRows(catalogBytes), pack: JSON.parse(packBytes).packs[0] };
  }
  return cached;
}
const sampleRows = () => parseSeoulMetroTransferCsv(SAMPLE);
const samplePins = () => new Map([...PINNED_EXCLUDED_SOURCE_ROWS].filter(([rowNumber]) => ["77", "144", "145", "999"].includes(rowNumber)));
async function derive(rows = sampleRows(), overrides = {}) {
  const { catalogRows, pack } = await inputs();
  return deriveSeoulMeasuredTransferMetrics({ rows, catalogRows, pack, pinnedExclusions: samplePins(), ...overrides });
}
const metricFor = (result, stationId, fromLineId, toLineId) => result.metrics.find((metric) => metric.stationId === stationId
  && metric.fromLineId === fromLineId && metric.toLineId === toLineId);

test("방향마다 칸·문 조합 중 가장 짧은 실측 시간을 쓰고, 그 조합을 빠른 환승 안내로 보존한다(동률은 모두)", async () => {
  const result = await derive();
  const metric = metricFor(result, SEOUL_STATION, LINE_1, LINE_4);
  assert.equal(metric.measuredDurationSeconds, 214);
  assert.equal(metric.distanceMeters, null);
  assert.equal(metric.metricProvenance, "OFFICIAL_SOURCE");
  assert.equal(metric.measurement, "MEASURED");
  assert.deepEqual(metric.sourceRowNumbers, ["1", "2", "3", "4"]);
  assert.deepEqual(metric.fastTransferHints, [
    { sourceRowNumber: "1", alightingDirection: "시청 방면", alightingCar: "10", alightingDoor: "4", boardingDirection: "숙대입구 방면", boardingCar: "1", boardingDoor: "1" },
    { sourceRowNumber: "3", alightingDirection: "남영 방면", alightingCar: "1", alightingDoor: "2", boardingDirection: "숙대입구 방면", boardingCar: "1", boardingDoor: "1" },
  ]);
  assert.match(metric.sourceRecordSha256, /^[a-f0-9]{64}$/u);
});

test("빈 소요시간 행은 사용 불가로 빼고 추정하지 않는다. 00:00은 실측 0초로 쓴다", async () => {
  const result = await derive();
  const metric = metricFor(result, JUNGNANG, GYEONGUI, GYEONGCHUN);
  assert.equal(metric.measuredDurationSeconds, 0);
  assert.deepEqual(metric.fastTransferHints.map(({ sourceRowNumber }) => sourceRowNumber), ["714", "716"]);
  assert.deepEqual(metric.sourceRowNumbers, ["712", "713", "714", "716"]);
  assert.deepEqual(result.unavailableSourceRows.map(({ sourceRowNumber, reason }) => [sourceRowNumber, reason]), [["712", "EMPTY_DURATION"]]);
});

test("모든 행의 소요시간이 빈 방향은 지표를 만들지 않고 사용 불가 방향으로 남긴다", async () => {
  const onlyEmpty = sampleRows().filter(({ sourceRowNumber }) => !["713", "714", "716"].includes(sourceRowNumber));
  const result = await derive(onlyEmpty);
  assert.equal(metricFor(result, JUNGNANG, GYEONGUI, GYEONGCHUN), undefined);
  assert.deepEqual(result.unavailableDirections, [{ stationId: JUNGNANG, fromLineId: GYEONGUI, toLineId: GYEONGCHUN, sourceRowNumbers: ["712"] }]);
});

test("역은 정본 nameKo·nameSub 정확 일치와 출발 노선 보유로만 정한다(이수 → 총신대입구 nameSub)", async () => {
  const result = await derive();
  const metric = metricFor(result, CHONGSHIN, LINE_7, LINE_4);
  assert.equal(metric.measuredDurationSeconds, 317);
  const { pack } = await inputs();
  const withoutSub = { ...pack, stations: pack.stations.map((station) => station.id === CHONGSHIN ? { ...station, nameSub: "" } : station) };
  await assert.rejects(derive(sampleRows(), { pack: withoutSub }), /NO_GO unpinned Seoul measured transfer row: 557/u);
});

test("고정 제외 행(지선·정본 역 부재)은 사유와 값으로 남기고, 값이 바뀌거나 매핑되면 NO_GO다", async () => {
  const result = await derive();
  assert.deepEqual(result.excludedSourceRows.map(({ sourceRowNumber, reason }) => [sourceRowNumber, reason]), [
    ["77", "SAME_LINE_BRANCH_TRANSFER"], ["144", "SAME_LINE_BRANCH_TRANSFER"], ["145", "SAME_LINE_BRANCH_TRANSFER"],
    ["999", "STATION_NOT_IN_CANONICAL_PACK"],
  ]);
  const drift = sampleRows().map((row) => row.sourceRowNumber === "77" ? { ...row, duration: "00:01" } : row);
  await assert.rejects(derive(drift), /NO_GO pinned Seoul measured transfer exclusion drift: 77/u);
  await assert.rejects(derive(sampleRows().filter(({ sourceRowNumber }) => sourceRowNumber !== "144")), /NO_GO pinned Seoul measured transfer exclusion is absent: 144/u);
  const { pack } = await inputs();
  const seoknam = {
    ...pack,
    stations: pack.stations.map((station) => station.id === "station-37866f28b417" ? { ...station, nameKo: "석남" } : station),
    stationLines: [...pack.stationLines, { stationId: "station-37866f28b417", lineId: LINE_7, stationCode: "x", lineSequence: 0 }],
  };
  await assert.rejects(derive(sampleRows(), { pack: seoknam }), /NO_GO pinned Seoul measured transfer exclusion now maps: 999/u);
});

test("고정 밖 행이 매핑되지 않거나 정본 역이 둘 이상이면 추정 없이 NO_GO다", async () => {
  const { pack } = await inputs();
  const noSeoul = { ...pack, stationLines: pack.stationLines.filter(({ stationId, lineId }) => !(stationId === SEOUL_STATION && lineId === LINE_1)) };
  await assert.rejects(derive(sampleRows(), { pack: noSeoul }), /NO_GO unpinned Seoul measured transfer row: 1/u);
  const twin = { ...pack, stations: [...pack.stations, { ...pack.stations.find(({ id }) => id === SEOUL_STATION), id: "station-twin" }],
    stationLines: [...pack.stationLines, { stationId: "station-twin", lineId: LINE_1, stationCode: "x", lineSequence: 0 }] };
  await assert.rejects(derive(sampleRows(), { pack: twin }), /NO_GO ambiguous Seoul measured transfer station: 1/u);
});

test("역 코드 카탈로그와 원천 이름·방면·노선 표기가 어긋나면 NO_GO다(종료역 코드는 환승 열차 방면의 다음 역)", async () => {
  const mutate = (patch) => sampleRows().map((row) => row.sourceRowNumber === "1" ? { ...row, ...patch } : row);
  await assert.rejects(derive(mutate({ startStationName: "시청" })), /NO_GO Seoul measured transfer start code catalog mismatch: 1/u);
  await assert.rejects(derive(mutate({ startLine: "2" })), /NO_GO Seoul measured transfer start code catalog mismatch: 1/u);
  await assert.rejects(derive(mutate({ startLine: "1호선" })), /NO_GO unknown Seoul measured transfer line label: 1호선/u);
  await assert.rejects(derive(mutate({ boardingDirection: "회현 방면" })), /NO_GO Seoul measured transfer end code catalog mismatch: 1/u);
  await assert.rejects(derive(mutate({ endStationCode: "ZZZZ" })), /NO_GO Seoul measured transfer station code is absent from catalog: ZZZZ/u);
  const { pack } = await inputs();
  const renamed = { ...pack, lines: pack.lines.map((line) => line.id === LINE_4 ? { ...line, nameKo: "수도권 4호선(진접)" } : line) };
  await assert.rejects(derive(sampleRows(), { pack: renamed }), /NO_GO Seoul measured transfer line identity mismatch: 04호선/u);
});

test("한 방향이 두 번 결정되거나 행 번호가 중복되면 NO_GO다", async () => {
  const rows = sampleRows();
  await assert.rejects(derive([...rows, rows[0]]), /NO_GO duplicate Seoul measured transfer source row: 1/u);
});

test("커밋된 실측 환승 지표는 inventory admission snapshot으로 다시 만든 결과와 바이트가 같다", async () => {
  const inputsFromRepo = await readSeoulMeasuredTransferMetricsInputs({ repositoryRoot: root });
  const committed = await readFile(path.join(root, SEOUL_MEASURED_TRANSFER_METRICS_PATH));
  assert.equal(Buffer.from(canonicalSeoulMeasuredTransferMetricsJson(buildSeoulMeasuredTransferMetrics(inputsFromRepo))).equals(committed), true);
  const artifact = JSON.parse(committed);
  // 2026-09-02 원천(1,024행): 매핑 1,017행 → 263방향·105역, 고정 제외 7행, 빈 시간 4행(모두 다른 행이 있는 방향), 사용 불가 방향 0.
  assert.equal(artifact.sourceIdentity.rowCount, 1024);
  assert.equal(artifact.metrics.length, 263);
  assert.equal(new Set(artifact.metrics.map(({ stationId }) => stationId)).size, 105);
  assert.equal(artifact.unavailableDirections.length, 0);
  assert.deepEqual(artifact.excludedSourceRows.map(({ sourceRowNumber }) => sourceRowNumber), [...PINNED_EXCLUDED_SOURCE_ROWS.keys()]);
  assert.deepEqual(artifact.unavailableSourceRows.map(({ sourceRowNumber }) => sourceRowNumber), ["712", "715", "769", "771"]);
  assert.ok(artifact.metrics.every(({ distanceMeters, measurement, metricProvenance, fastTransferHints }) => distanceMeters === null
    && measurement === "MEASURED" && metricProvenance === "OFFICIAL_SOURCE" && fastTransferHints.length > 0));
  // 0초 실측 방향은 중랑 경의중앙→경춘 하나다(행 714·716, 같은 승강장 환승). 빈 값(712·715)과 구분된다.
  assert.deepEqual(artifact.metrics.filter(({ measuredDurationSeconds }) => measuredDurationSeconds === 0)
    .map(({ stationId, fromLineId, toLineId, fastTransferHints }) => [stationId, fromLineId, toLineId, fastTransferHints.map(({ sourceRowNumber }) => sourceRowNumber)]),
  [[JUNGNANG, GYEONGUI, GYEONGCHUN, ["714", "716"]]]);
  // 서울역 1호선→공항철도: 서울교통공사 거리÷1.2 원천과 달리 실측 15:56(행 5·6)이다.
  assert.equal(metricFor(artifact, SEOUL_STATION, LINE_1, "line-e9e9a5b520a4").measuredDurationSeconds, 956);
});
