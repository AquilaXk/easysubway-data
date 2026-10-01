import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BUSAN_TRANSFER_METRICS_PATH,
  buildBusanTransferMetrics,
  canonicalBusanTransferMetricsJson,
  deriveBusanTransferMetrics,
  readBusanTransferMetricsInputs,
} from "./build-busan-transfer-metrics.mjs";
import { extractBusanTransferRows } from "./collect-busan-route-topology.mjs";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// #872 S3(QA 결정 2026-10-02): 부산교통공사 원천(busan-transportation-route-topology)의 exchange=Y 환승 행을
// 공식 환승 거리·시간으로 쓴다. 매핑은 역 코드로만 하고, 1~4호선 내부 환승만 대상이다.
// 값은 원천 그대로다: 거리 = dist × 100m, 시간 = time 초(보행속도로 다시 계산하지 않는다).
const EXPECTED_OFFICIAL = [
  // [stationId, 역(참고), fromCode, toCode, fromLineId, toLineId, distanceMeters, seconds]
  ["station-1fc7a7c971c8", "서면", "119", "219", "line-ab1a041f6266", "line-eb7b47920390", 100, 120],
  ["station-1fc7a7c971c8", "서면", "219", "119", "line-eb7b47920390", "line-ab1a041f6266", 100, 120],
  ["station-3b042820c466", "미남", "309", "401", "line-d74614a04530", "line-d812a5bc1e5f", 200, 240],
  ["station-3b042820c466", "미남", "401", "309", "line-d812a5bc1e5f", "line-d74614a04530", 200, 240],
  ["station-803200d76012", "연산", "123", "305", "line-ab1a041f6266", "line-d74614a04530", 100, 180],
  ["station-803200d76012", "연산", "305", "123", "line-d74614a04530", "line-ab1a041f6266", 100, 180],
  ["station-85f3b04485c3", "덕천", "313", "233", "line-d74614a04530", "line-eb7b47920390", 100, 180],
  ["station-85f3b04485c3", "덕천", "233", "313", "line-eb7b47920390", "line-d74614a04530", 100, 180],
  ["station-902ff39b9a39", "수영", "301", "208", "line-d74614a04530", "line-eb7b47920390", 100, 180],
  ["station-902ff39b9a39", "수영", "208", "301", "line-eb7b47920390", "line-d74614a04530", 100, 180],
  ["station-dbfe9e072d98", "동래", "125", "402", "line-ab1a041f6266", "line-d812a5bc1e5f", 300, 360],
  ["station-dbfe9e072d98", "동래", "402", "125", "line-d812a5bc1e5f", "line-ab1a041f6266", 300, 360],
];
// 상대 역 코드가 부산교통공사 1~4호선 114역 범위 밖(8xx·9xx)이라 역 코드로 정본 역을 정할 수 없는 행이다.
const EXPECTED_EXCLUDED = [
  ["120", "801", "5", "480"], ["124", "804", "3", "240"], ["205", "810", "4", "360"],
  ["227", "901", "0", "300"], ["306", "803", "3", "300"], ["317", "907", "0", "240"],
];

async function committedInputs() {
  return readBusanTransferMetricsInputs({ repositoryRoot: root });
}

function contextFor(inputs) {
  const built = buildBusanTransferMetrics(inputs);
  return { built, rows: extractBusanTransferRows(JSON.parse(inputs.snapshotBytes)) };
}

test("#872 S3 부산 환승 지표는 1~4호선 내부 환승 6역 12방향을 원천 값 그대로 OFFICIAL_SOURCE로 만든다", async () => {
  const { built } = contextFor(await committedInputs());
  const actual = built.metrics.map((metric) => [
    metric.stationId, metric.fromStationCode, metric.toStationCode, metric.fromLineId, metric.toLineId,
    metric.distanceMeters, metric.officialDurationSeconds, metric.metricProvenance,
  ]);
  assert.deepEqual(actual, EXPECTED_OFFICIAL.map(([stationId, , from, to, fromLine, toLine, meters, seconds]) => [
    stationId, from, to, fromLine, toLine, meters, seconds, "OFFICIAL_SOURCE",
  ]));
  for (const metric of built.metrics) {
    assert.match(metric.sourceRecordSha256, /^[a-f0-9]{64}$/);
    assert.equal(Object.hasOwn(metric, "derivedFrom"), false);
  }
  assert.equal(new Set(built.metrics.map(({ sourceRecordSha256 }) => sourceRecordSha256)).size, 12);
});

test("#872 S3 범위 밖 역 코드(8xx·9xx) 환승 행은 매핑하지 않고 사유와 원천 값으로 고정해 남긴다", async () => {
  const { built } = contextFor(await committedInputs());
  assert.deepEqual(built.excludedSourceRows.map(({ fromStationCode, toStationCode, dist, time, reason }) => [fromStationCode, toStationCode, dist, time, reason]),
    EXPECTED_EXCLUDED.map((row) => [...row, "STATION_CODE_OUTSIDE_ADMITTED_SCOPE"]));
});

test("#872 S3 부산 환승 지표는 100m·분 단위 반올림 운영 기준값이라는 정밀도와 원천 결속을 기록한다", async () => {
  const inputs = await committedInputs();
  const { built } = contextFor(inputs);
  assert.deepEqual(built.valuePrecision, {
    basis: "PROVIDER_ROUNDED_OPERATING_REFERENCE",
    distanceMeters: 100,
    durationSeconds: 60,
    noteKo: "부산교통공사 원천 값이다. 환승 거리는 100m 단위, 환승 시간은 분 단위로 반올림된 운영 기준값이며 실측 보행 거리·시간이 아니다.",
  });
  const inventory = JSON.parse(inputs.sourceInventoryBytes).sources.find(({ id }) => id === "busan-transportation-route-topology");
  const snapshot = JSON.parse(inputs.snapshotBytes);
  assert.deepEqual(built.sourceIdentity, {
    sourceId: "busan-transportation-route-topology",
    snapshotId: inventory.topologyAdmissionEvidence.snapshotId,
    snapshotFileSha256: sha256(inputs.snapshotBytes),
    capturedAt: snapshot.capturedAt,
    rawSha256: snapshot.rawSha256,
    contentSha256: snapshot.contentSha256,
    stationCodeMappingSha256: inventory.membershipAdmissionEvidence.mappingSha256,
    stationMapSha256: sha256(inputs.stationMapBytes),
    canonicalPackSha256: sha256(inputs.canonicalPackBytes),
  });
  assert.equal(built.sourceIdentity.snapshotId, `busan-transportation-route-topology-${sha256(inputs.snapshotBytes)}`);
});

test("#872 S3 커밋된 부산 환승 지표 산출물은 커밋된 입력으로 다시 만든 결과와 바이트가 같다", async () => {
  const inputs = await committedInputs();
  const committed = await readFile(path.join(root, BUSAN_TRANSFER_METRICS_PATH));
  const rebuilt = Buffer.from(canonicalBusanTransferMetricsJson(buildBusanTransferMetrics(inputs)));
  assert.equal(rebuilt.equals(committed), true);
  const parsed = JSON.parse(committed);
  const { artifactSha256, ...payload } = parsed;
  assert.equal(artifactSha256, sha256(JSON.stringify(payload)));
});

test("#872 S3 inventory 결속(snapshot id·raw·매핑 hash)이 어긋나면 NO_GO다", async () => {
  const inputs = await committedInputs();
  const mutateInventory = (mutate) => {
    const inventory = JSON.parse(inputs.sourceInventoryBytes);
    mutate(inventory.sources.find(({ id }) => id === "busan-transportation-route-topology"));
    return { ...inputs, sourceInventoryBytes: Buffer.from(JSON.stringify(inventory)) };
  };
  assert.throws(() => buildBusanTransferMetrics(mutateInventory((source) => { source.membershipAdmissionEvidence.mappingSha256 = "0".repeat(64); })), /NO_GO Busan station code mapping/);
  assert.throws(() => buildBusanTransferMetrics(mutateInventory((source) => { source.topologyAdmissionEvidence.rawSha256 = "0".repeat(64); })), /NO_GO Busan transfer snapshot binding/);
  assert.throws(() => buildBusanTransferMetrics(mutateInventory((source) => { source.membershipAdmissionEvidence.snapshotId = "other"; })), /NO_GO Busan station code mapping/);
  assert.throws(() => buildBusanTransferMetrics({ ...inputs, snapshotBytes: Buffer.concat([inputs.snapshotBytes, Buffer.from(" ")]) }), /NO_GO Busan transfer snapshot binding/);
});

test("#872 S3 고정 밖 행·값 드리프트·끝점 불일치·노선 미보유·정밀도 위반·중복은 추정 없이 NO_GO다", async () => {
  const inputs = await committedInputs();
  const { rows } = contextFor(inputs);
  const snapshot = JSON.parse(inputs.snapshotBytes);
  const pack = JSON.parse(inputs.canonicalPackBytes).packs[0];
  const base = { scope: snapshot.scope, stationMapCsv: inputs.stationMapBytes.toString("utf8"), stationLines: pack.stationLines };
  const derive = (transferRows, overrides = {}) => deriveBusanTransferMetrics({ ...base, transferRows, ...overrides });
  const replace = (from, to, patch) => rows.map((row) => (row.fromStationCode === from && row.toStationCode === to ? { ...row, ...patch } : row));

  assert.doesNotThrow(() => derive(rows));
  assert.throws(() => derive(replace("120", "801", { time: "540" })), /NO_GO pinned Busan transfer exclusion drift/);
  assert.throws(() => derive([...rows, { ...rows[0], fromStationCode: "119", toStationCode: "999" }]), /NO_GO unpinned Busan transfer row/);
  assert.throws(() => derive(rows.filter(({ fromStationCode }) => fromStationCode !== "317")), /NO_GO pinned Busan transfer exclusion is absent/);
  assert.throws(() => derive(replace("119", "219", { toStationCode: "220" })), /NO_GO Busan transfer endpoints map to different stations/);
  assert.throws(() => derive(rows, { stationLines: pack.stationLines.filter(({ stationId, lineId }) => !(stationId === "station-1fc7a7c971c8" && lineId === "line-eb7b47920390")) }), /NO_GO Busan transfer station-line is absent/);
  assert.throws(() => derive(replace("119", "219", { time: "125" })), /NO_GO Busan transfer value precision/);
  assert.throws(() => derive(replace("119", "219", { dist: "0" })), /NO_GO Busan transfer value precision/);
  assert.throws(() => derive(replace("119", "219", { dist: "" })), /NO_GO Busan transfer value precision/);
  assert.throws(() => derive(replace("119", "219", { stoppingTime: "30" })), /NO_GO Busan transfer row schema/);
  assert.throws(() => derive([...rows, rows.find(({ fromStationCode }) => fromStationCode === "119")]), /NO_GO duplicate Busan transfer direction/);
});

test("#872 S3 원천이 한 방향만 주면 그 방향만 OFFICIAL_SOURCE이고, 반대 방향은 D4대로 DERIVED_RECIPROCAL로만 표기한다", async () => {
  const inputs = await committedInputs();
  const { rows } = contextFor(inputs);
  const snapshot = JSON.parse(inputs.snapshotBytes);
  const pack = JSON.parse(inputs.canonicalPackBytes).packs[0];
  const oneWay = rows.filter(({ fromStationCode, toStationCode }) => !(fromStationCode === "219" && toStationCode === "119"));
  const { metrics } = deriveBusanTransferMetrics({
    transferRows: oneWay, scope: snapshot.scope, stationMapCsv: inputs.stationMapBytes.toString("utf8"), stationLines: pack.stationLines,
  });
  const forward = metrics.find(({ fromStationCode, toStationCode }) => fromStationCode === "119" && toStationCode === "219");
  const reverse = metrics.find(({ stationId, fromLineId, toLineId }) => stationId === "station-1fc7a7c971c8"
    && fromLineId === "line-eb7b47920390" && toLineId === "line-ab1a041f6266");
  assert.equal(forward.metricProvenance, "OFFICIAL_SOURCE");
  assert.equal(reverse.metricProvenance, "DERIVED_RECIPROCAL");
  assert.equal(reverse.distanceMeters, forward.distanceMeters);
  assert.equal(reverse.officialDurationSeconds, forward.officialDurationSeconds);
  assert.equal(reverse.sourceRecordSha256, forward.sourceRecordSha256);
  assert.deepEqual(reverse.derivedFrom, {
    stationId: "station-1fc7a7c971c8", fromLineId: "line-ab1a041f6266", toLineId: "line-eb7b47920390",
    sourceRecordSha256: forward.sourceRecordSha256,
  });
  assert.equal(Object.hasOwn(reverse, "fromStationCode"), false, "역방향 행은 원천 행이 아니므로 원천 역 코드를 주장하지 않는다");
  assert.equal(metrics.length, 12);
});
