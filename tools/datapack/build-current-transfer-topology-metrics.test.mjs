import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertExactDerivedReciprocals, currentTransferLineIds, main } from "./build-current-transfer-topology-metrics.mjs";
import { buildApplicability } from "./build-current-capital-transfer-topology-applicability.mjs";

// #872 S2: 서울교통공사 1~8호선과 상대 노선 전체 매핑. 원천 행 → (역, 출발 노선, 도착 노선)은 정본 팩 식별자로만 정한다.
const LINE = {
  1: ["line-472a81add377", "수도권 1호선"], 2: ["seoul-2", "수도권 2호선"], 3: ["line-41a8c75ec9d8", "수도권 3호선"], 4: ["seoul-4", "수도권 4호선"],
  5: ["line-80fc4d5350d4", "수도권 5호선"], 6: ["line-3f41718e0833", "수도권 6호선"], 7: ["line-15b3b8a93259", "수도권 7호선"], 8: ["line-2b2d9eaa53d0", "수도권 8호선"],
  9: ["line-f0e747248a31", "수도권 9호선"], 공항: ["line-e9e9a5b520a4", "수도권 공항"], 경의중앙: ["line-6e39be0cb6e2", "수도권 경의중앙"], 경춘: ["line-54a7b980b7c3", "수도권 경춘"],
  수인분당: ["line-558d0bd8312d", "수도권 수인분당"], 신분당: ["shinbundang", "수도권 신분당"], 우이신설: ["line-30886152e4f8", "수도권 우이신설"],
  김포골드: ["line-5500c1600f71", "수도권 김포골드라인"], 서해: ["line-051552e50435", "수도권 서해선"], 신림: ["line-aefa08ccc0a9", "수도권 신림선"], GTXA: ["line-8604048b6430", "수도권 GTX-A"],
};
const id = (key) => LINE[key][0];

test("서울교통공사 1~8호선과 상대 노선 19개를 정본 팩 노선 id로 매핑한다", () => {
  assert.deepEqual(currentTransferLineIds(), Object.values(LINE).map(([lineId]) => lineId).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))));
});

test("원천이 실제로 덮는 쌍만 만든다: 정확한 방향은 OFFICIAL_SOURCE, 반대 방향은 DERIVED_RECIPROCAL", async () => {
  const fixture = await fixtureRoot();
  const output = path.join(fixture.root, "output.json");
  const result = await main(["--observation-directory", fixture.observationDirectory, "--output", output], { repositoryRoot: fixture.root, log: () => {} });
  const byKey = new Map(result.metrics.map((metric) => [`${metric.stationId}|${metric.fromLineId}|${metric.toLineId}`, metric]));
  // 양방향 원천 행(서울역 1↔4)은 둘 다 OFFICIAL_SOURCE이고 각 행 hash에 결속한다.
  assert.equal(byKey.get(`station-seoul|${id(1)}|${id(4)}`).metricProvenance, "OFFICIAL_SOURCE");
  assert.equal(byKey.get(`station-seoul|${id(4)}|${id(1)}`).metricProvenance, "OFFICIAL_SOURCE");
  assert.equal(byKey.get(`station-seoul|${id(1)}|${id(4)}`).sourceRecordSha256, rowHash(fixture.rows, 1, "서울역", "4호선"));
  assert.equal(byKey.get(`station-seoul|${id(4)}|${id(1)}`).sourceRecordSha256, rowHash(fixture.rows, 4, "서울역", "1호선"));
  // 한 방향만 있는 쌍(서울역 1→공항철도)은 원천 방향만 OFFICIAL_SOURCE, 반대는 DERIVED_RECIPROCAL(D4)이다.
  const official = byKey.get(`station-seoul|${id(1)}|${id("공항")}`);
  const derived = byKey.get(`station-seoul|${id("공항")}|${id(1)}`);
  assert.equal(official.metricProvenance, "OFFICIAL_SOURCE");
  assert.equal(official.distanceMeters, 309);
  assert.equal(official.officialDurationSecondsReference, 258);
  assert.equal(derived.metricProvenance, "DERIVED_RECIPROCAL");
  assert.deepEqual(derived.derivedFrom, { stationId: "station-seoul", fromLineId: id(1), toLineId: id("공항"), sourceRecordSha256: official.sourceRecordSha256 });
  assert.equal(derived.distanceMeters, official.distanceMeters);
  // 이수(7호선)는 정본 팩 역의 nameSub로 같은 역(총신대입구)에 매핑한다.
  assert.equal(byKey.get(`station-isu|${id(7)}|${id(4)}`).metricProvenance, "OFFICIAL_SOURCE");
  assert.equal(byKey.get(`station-isu|${id(4)}|${id(7)}`).metricProvenance, "OFFICIAL_SOURCE");
  // 원천 내부 불일치가 의심되는 79행(김포공항 5→공항철도)은 공식 값을 그대로 OFFICIAL_SOURCE로 쓴다.
  const gimpo = byKey.get(`station-gimpo|${id(5)}|${id("공항")}`);
  assert.deepEqual({ distanceMeters: gimpo.distanceMeters, officialDurationSecondsReference: gimpo.officialDurationSecondsReference, metricProvenance: gimpo.metricProvenance }, { distanceMeters: 122, officialDurationSecondsReference: 282, metricProvenance: "OFFICIAL_SOURCE" });
  assert.equal(byKey.get(`station-gimpo|${id("공항")}|${id(5)}`).metricProvenance, "DERIVED_RECIPROCAL");
  // 원천에 없는 쌍(금정 1·4, 서울역 4·경의중앙 등)은 만들지 않는다. 제외 행(지선·모호 노선명)도 쌍을 만들지 않는다.
  const pairKeys = new Set(result.physicalPairs.map(({ stationId, lineIds }) => `${stationId}|${lineIds.join("|")}`));
  assert.equal([...pairKeys].some((key) => key.startsWith("station-geumjeong|")), false);
  assert.equal([...pairKeys].some((key) => key.startsWith("station-seongsu|") || key.startsWith("station-gangdong|") || key.startsWith("station-suseo|") || key.startsWith("station-seokgye|")), false);
  assert.deepEqual([...pairKeys].filter((key) => key.startsWith("station-sindorim|")), [`station-sindorim|${[id(1), id(2)].sort().join("|")}`]);
  // 모든 OFFICIAL_SOURCE 방향은 정확히 하나의 원천 행에서 나오고, 모든 쌍은 OFFICIAL_SOURCE를 하나 이상 가진다.
  const officialMetrics = result.metrics.filter(({ metricProvenance }) => metricProvenance === "OFFICIAL_SOURCE");
  assert.equal(officialMetrics.length, fixture.mappedRowCount);
  assert.equal(new Set(officialMetrics.map(({ sourceRecordSha256 }) => sourceRecordSha256)).size, officialMetrics.length);
  for (const metric of officialMetrics) assert.ok(fixture.rows.some((row) => sha256(JSON.stringify(sortValue(row))) === metric.sourceRecordSha256));
  assert.equal(result.metrics.length, result.physicalPairs.length * 2);
  assert.equal(result.canonicalIdentity.physicalPairCount, result.physicalPairs.length);
  for (const pair of result.physicalPairs) {
    const directions = result.metrics.filter((metric) => metric.stationId === pair.stationId && pair.lineIds.includes(metric.fromLineId) && pair.lineIds.includes(metric.toLineId));
    assert.equal(directions.length, 2);
    assert.ok(directions.some(({ metricProvenance }) => metricProvenance === "OFFICIAL_SOURCE"));
  }
  assert.ok(result.metrics.every(({ durationRole }) => durationRole === "REFERENCE_ONLY"));
  const bytes = await readFile(output, "utf8");
  assert.equal(bytes, `${JSON.stringify(sortValue(result))}\n`);
  assert.equal(sha256(JSON.stringify(sortValue(without(result, "artifactSha256")))), result.artifactSha256);
  const repeated = path.join(fixture.root, "repeat.json");
  await main(["--observation-directory", fixture.observationDirectory, "--output", repeated], { repositoryRoot: fixture.root, log: () => {} });
  assert.equal(await readFile(repeated, "utf8"), bytes);
});

test("canonical identity와 applicability는 매핑 노선 전체 역-노선을 분모로 쓴다", async () => {
  const fixture = await fixtureRoot((value) => {
    const capital = value.canonical.packs[0];
    capital.stations.push({ id: "station-non-transfer", nameKo: "비환승역" });
    capital.stationLines.push({ stationId: "station-non-transfer", lineId: id(3) });
  });
  const output = path.join(fixture.root, "output.json");
  const metrics = await main(["--observation-directory", fixture.observationDirectory, "--output", output], { repositoryRoot: fixture.root, log: () => {} });
  const canonicalPackBytes = await readFile(path.join(fixture.root, "tools/datapack/release/capital-production-canonical-pack.json"));
  const applicability = buildApplicability({ canonicalPack: fixture.canonical, canonicalPackBytes, transferTopologyMetrics: metrics, metricsBytes: canonicalBytes(metrics) });
  const universe = new Set(currentTransferLineIds());
  const domain = fixture.canonical.packs[0].stationLines.filter(({ lineId }) => universe.has(lineId));
  assert.equal(metrics.canonicalIdentity.stationLineCount, domain.length);
  assert.equal(metrics.canonicalIdentity.stationCount, new Set(domain.map(({ stationId }) => stationId)).size);
  assert.equal(applicability.cells.length, domain.length);
  const endpoints = new Set(metrics.metrics.map(({ stationId, fromLineId }) => `${stationId}\0${fromLineId}`));
  assert.equal(applicability.stateSummary.APPLICABLE_TRANSFER_ENDPOINT, endpoints.size);
  assert.equal(applicability.stateSummary.NOT_APPLICABLE_IN_CANONICAL_PAIR_SET, domain.length - endpoints.size);
  assert.equal(applicability.cells.find(({ stationId }) => stationId === "station-geumjeong").state, "NOT_APPLICABLE_IN_CANONICAL_PAIR_SET");
  assert.equal(applicability.metricProvenanceSummary.DERIVED_RECIPROCAL, metrics.metrics.filter(({ metricProvenance }) => metricProvenance === "DERIVED_RECIPROCAL").length);
  // 쌍의 역방향 지표를 빼면 applicability가 거부한다.
  const narrowed = structuredClone(metrics);
  narrowed.metrics = narrowed.metrics.filter(({ stationId, fromLineId }) => !(stationId === "station-seoul" && fromLineId === id("공항")));
  narrowed.artifactSha256 = sha256(JSON.stringify(sortValue(without(narrowed, "artifactSha256"))));
  assert.throws(() => buildApplicability({ canonicalPack: fixture.canonical, canonicalPackBytes, transferTopologyMetrics: narrowed, metricsBytes: canonicalBytes(narrowed) }), /NO_GO/);
});

test("매핑할 수 없거나 모호한 원천 행은 output 없이 NO_GO다(제외 목록 밖)", async () => {
  for (const [label, expected, mutate] of [
    ["목록 밖 미매핑 상대 노선명", /NO_GO unmapped official transfer row/u, (fixture) => { fixture.rows.find((row) => row["환승역명"] === "서울역" && row["환승노선"] === "공항철도" && row["호선"] === 1)["환승노선"] = "국철"; }],
    ["목록 밖 서울교통공사 호선", /NO_GO unmapped official transfer row/u, (fixture) => { fixture.rows.find((row) => row["환승역명"] === "서울역" && row["환승노선"] === "공항철도" && row["호선"] === 1)["호선"] = 9; }],
    ["정본 팩에 없는 역명", /NO_GO official transfer station mapping mismatch/u, (fixture) => { fixture.rows.find((row) => row["환승역명"] === "강남")["환승역명"] = "다른강남"; }],
    ["같은 이름·노선 역이 둘", /NO_GO official transfer station mapping mismatch/u, (fixture) => { const capital = fixture.canonical.packs[0]; capital.stations.push({ id: "station-seoul-duplicate", nameKo: "서울역" }); capital.stationLines.push({ stationId: "station-seoul-duplicate", lineId: id(1) }, { stationId: "station-seoul-duplicate", lineId: id(4) }); }],
    ["역에 도착 노선이 없음", /NO_GO official transfer station mapping mismatch/u, (fixture) => { const capital = fixture.canonical.packs[0]; capital.stationLines = capital.stationLines.filter(({ stationId, lineId }) => !(stationId === "station-gangnam" && lineId === id("신분당"))); }],
    ["제외 목록 행 내용 변경", /NO_GO excluded official transfer row drift/u, (fixture) => { fixture.rows.find((row) => row["연번"] === 59)["환승거리"] = 93; }],
    ["불일치 예외 행 내용 변경", /NO_GO official duration exception row drift/u, (fixture) => { fixture.rows.find((row) => row["연번"] === 79)["환승소요시간"] = "04:43"; }],
    ["목록 밖 시간·거리 불일치", /NO_GO official transfer reference duration mismatch/u, (fixture) => { fixture.rows.find((row) => row["환승역명"] === "강남")["환승거리"] = 215; }],
    ["역방향 공식 값 충돌", /NO_GO reciprocal official transfer metric conflict/u, (fixture) => { fixture.rows.find((row) => row["환승역명"] === "서울역" && row["호선"] === 4 && row["환승노선"] === "1호선")["환승거리"] = 160; fixture.rows.find((row) => row["환승역명"] === "서울역" && row["호선"] === 4 && row["환승노선"] === "1호선")["환승소요시간"] = "02:13"; }],
    ["노선 이름 불일치", /NO_GO canonical line identity mismatch/u, (fixture) => { fixture.canonical.packs[0].lines.find(({ id: lineId }) => lineId === id(7)).nameKo = "인천 7호선"; }],
    ["신분당 KRIC 별칭 불일치", /NO_GO Shinbundang alias identity mismatch/u, (fixture) => { fixture.kric.providerLines[0].operatorName = "다른 운영사"; }],
    ["freshness 날짜 변경", /NO_GO observation identity mismatch/u, (fixture) => { fixture.freshnessDate = "2026-12-31"; }],
    ["preview 채널", /NO_GO canonical pack identity mismatch/u, (fixture) => { fixture.canonical.manifest.channel = "preview"; }],
  ]) {
    const fixture = await fixtureRoot(mutate);
    const output = path.join(fixture.root, "output.json");
    await assert.rejects(main(["--observation-directory", fixture.observationDirectory, "--output", output], { repositoryRoot: fixture.root, log: () => {} }), expected, label);
    await assert.rejects(readFile(output), { code: "ENOENT" }, label);
  }
});

test("malformed MM/SS row는 resealed observation이어도 output 0으로 거부한다", async () => {
  const fixture = await fixtureRoot((value) => { value.rows.find((row) => row["환승역명"].startsWith("환승")) ["환승소요시간"] = "99:00"; });
  const output = path.join(fixture.root, "output.json");
  await assert.rejects(main(["--observation-directory", fixture.observationDirectory, "--output", output], { repositoryRoot: fixture.root, log: () => {} }), /official transfer row schema mismatch/);
  await assert.rejects(readFile(output), { code: "ENOENT" });
});

test("KRIC provider catalog raw hash는 artifact identity와 self hash에 결속한다", async () => {
  const first = await fixtureRoot();
  const second = await fixtureRoot((fixture) => { fixture.kric.providerLines.push({ railOprIsttCd: "ZZ", operatorName: "다른 운영사", lnCd: "Z1", lineName: "다른 노선" }); });
  const [left, right] = await Promise.all([
    main(["--observation-directory", first.observationDirectory, "--output", path.join(first.root, "output.json")], { repositoryRoot: first.root, log: () => {} }),
    main(["--observation-directory", second.observationDirectory, "--output", path.join(second.root, "output.json")], { repositoryRoot: second.root, log: () => {} }),
  ]);
  assert.notEqual(left.sourceIdentity.kricProviderCatalogSha256, right.sourceIdentity.kricProviderCatalogSha256);
  assert.notEqual(left.artifactSha256, right.artifactSha256);
});

// #872 S2: 커밋된 지표는 전국 정본 팩의 역·노선 식별자로만 이루어지고, 원천이 덮는 쌍 전체(102)를 쓴다.
test("커밋된 환승 지표는 전국 정본 팩 역-노선 식별자와 일치하고 원천이 덮는 쌍 전체를 쓴다", async () => {
  const [metrics, nationwide] = await Promise.all([
    readFile(new URL("./release/current-transfer-topology-metrics.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("./release/nationwide-production-canonical-pack.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  const pack = nationwide.packs.find(({ id }) => id === nationwide.manifest.activePack.id);
  const stationLines = new Set(pack.stationLines.map(({ stationId, lineId }) => `${stationId}\0${lineId}`));
  const lineNames = new Map(pack.lines.map(({ id: lineId, nameKo }) => [lineId, nameKo]));
  for (const [lineId, nameKo] of Object.values(LINE)) assert.equal(lineNames.get(lineId), nameKo, lineId);
  for (const { stationId, fromLineId, toLineId } of metrics.metrics) {
    assert.ok(stationLines.has(`${stationId}\0${fromLineId}`) && stationLines.has(`${stationId}\0${toLineId}`), `${stationId} ${fromLineId}->${toLineId}`);
  }
  const provenance = Object.groupBy(metrics.metrics, ({ metricProvenance }) => metricProvenance);
  assert.deepEqual({ pairs: metrics.physicalPairs.length, official: provenance.OFFICIAL_SOURCE.length, derived: provenance.DERIVED_RECIPROCAL.length }, { pairs: 102, official: 140, derived: 64 });
  assert.equal(new Set(provenance.OFFICIAL_SOURCE.map(({ sourceRecordSha256 }) => sourceRecordSha256)).size, 140);
  const byKey = new Map(metrics.metrics.map((metric) => [`${metric.stationId}|${metric.fromLineId}|${metric.toLineId}`, metric]));
  // #350 승인 역방향 2쌍은 값과 표기가 그대로다.
  assert.deepEqual(pick(byKey.get("station-b35616704ce3|seoul-2|line-80fc4d5350d4")), { distanceMeters: 17, officialDurationSecondsReference: 14, metricProvenance: "DERIVED_RECIPROCAL" });
  assert.deepEqual(pick(byKey.get("station-gangnam|shinbundang|seoul-2")), { distanceMeters: 214, officialDurationSecondsReference: 178, metricProvenance: "DERIVED_RECIPROCAL" });
  // 79행(김포공항 5→공항철도)은 공식 값 그대로다(원천 내부 불일치 의심).
  assert.deepEqual(pick(byKey.get(`station-1f38f0831cb1|${id(5)}|${id("공항")}`)), { distanceMeters: 122, officialDurationSecondsReference: 282, metricProvenance: "OFFICIAL_SOURCE" });
  // 이수(7→4)는 총신대입구 역의 공식 방향이다.
  assert.equal(byKey.get(`station-2a2d0080fa4a|${id(7)}|${id(4)}`).metricProvenance, "OFFICIAL_SOURCE");
});
// #872 S2: 실제 발행 경로(전국 route-edge input·정본 팩)는 수도권 live-chain 필터와 무관하게 204방향 전체를 쓴다.
// #876(메인 결정 B): 실측 환승시간(15098252)과 겹치는 방향은 시간 = 실측, 거리 = 서울교통공사 공식 거리이고, 경로 행의 원천은
// 시간 원천(실측)이며 레코드 hash는 두 원천 레코드 hash의 결속이다. 겹치지 않는 방향은 서울교통공사 값 그대로다.
test("전국 발행 경로는 환승 지표 204방향 전체를 route edge로, OFFICIAL_SOURCE 140방향을 경로 행으로 쓴다", async () => {
  const read = (relative) => readFile(new URL(relative, import.meta.url), "utf8").then(JSON.parse);
  const [metrics, route, nationwide, busan, measured] = await Promise.all([read("./release/current-transfer-topology-metrics.json"), read("./release/nationwide-route-edge-input.json"), read("./release/nationwide-production-canonical-pack.json"), read("./release/current-busan-transfer-metrics.json"), read("./release/current-seoul-measured-transfer-metrics.json")]);
  const pack = nationwide.packs.find(({ id: packId }) => packId === nationwide.manifest.activePack.id);
  const transfers = new Map(route.routeEdges.filter(({ edgeType }) => edgeType === "IN_STATION_TRANSFER").map((edge) => [edge.edgeId, edge]));
  const measuredByKey = new Map(measured.metrics.map((metric) => [`${metric.stationId}-${metric.fromLineId}-${metric.toLineId}`, metric]));
  // #872 S3: 전국 route edge에는 서울교통공사 지표 204방향과 부산교통공사 공식 환승 12방향(별도 원천)이 함께 있다.
  // #878(QA 결정 2026-10-02): 실측 원천만 있는 방향은 거리 = round(실측초 × 1.2)로 유도한 route edge·경로 행이 된다.
  // 실측 0초 방향(중랑 경의중앙→경춘)은 거리·시간이 모두 0이라 서버 근거 판별을 통과하지 못하므로 route edge가 아니다.
  const seoulKeys = new Set(metrics.metrics.map((metric) => `${metric.stationId}-${metric.fromLineId}-${metric.toLineId}`));
  const timeOnly = measured.metrics.filter((metric) => !seoulKeys.has(`${metric.stationId}-${metric.fromLineId}-${metric.toLineId}`));
  const derived = timeOnly.filter(({ measuredDurationSeconds }) => measuredDurationSeconds > 0);
  assert.deepEqual([timeOnly.length, derived.length], [94, 93]);
  assert.equal(metrics.metrics.length, 204);
  assert.equal(busan.metrics.length, 12);
  assert.equal(transfers.size, metrics.metrics.length + busan.metrics.length + derived.length);
  const derivedBinding = (measuredHash) => sha256(JSON.stringify({ derivationPaceMetersPerSecond: 1.2, distanceDerivation: "STANDARD_PACE_FROM_MEASURED_TIME", durationSourceRecordSha256: measuredHash }));
  const pathwayById = new Map(pack.stationPathwayEdges.map((edge) => [edge.id, edge]));
  for (const timed of timeOnly) {
    const key = `${timed.stationId}-${timed.fromLineId}-${timed.toLineId}`;
    if (timed.measuredDurationSeconds === 0) {
      assert.equal(transfers.has(`transfer-${key}`), false, key);
      assert.equal(pathwayById.has(`pathway-edge-${key}-walk`), false, key);
      continue;
    }
    const meters = Math.round(timed.measuredDurationSeconds * 1.2);
    assert.deepEqual([transfers.get(`transfer-${key}`)?.durationSeconds, transfers.get(`transfer-${key}`)?.distanceMeters], [timed.measuredDurationSeconds, meters], key);
    const edge = pathwayById.get(`pathway-edge-${key}-walk`);
    assert.deepEqual([edge?.durationSeconds, edge?.distanceMeters, edge?.sourceId, edge?.providerRecordHash, edge?.evidenceHash],
      [timed.measuredDurationSeconds, meters, "seoul-metro-transfer-car-door-duration", derivedBinding(timed.sourceRecordSha256), derivedBinding(timed.sourceRecordSha256)], key);
  }
  const composite = (seoulHash, measuredHash) => sha256(JSON.stringify({ distanceSourceRecordSha256: seoulHash, durationSourceRecordSha256: measuredHash }));
  let overlapping = 0;
  for (const metric of metrics.metrics) {
    const key = `${metric.stationId}-${metric.fromLineId}-${metric.toLineId}`;
    const edge = transfers.get(`transfer-${key}`);
    assert.ok(edge, `${metric.stationId} ${metric.fromLineId}->${metric.toLineId}`);
    const timed = measuredByKey.get(key);
    if (timed) overlapping += 1;
    assert.deepEqual([edge.durationSeconds, edge.distanceMeters], [timed ? timed.measuredDurationSeconds : metric.officialDurationSecondsReference, metric.distanceMeters]);
  }
  assert.equal(overlapping, 169);
  const official = metrics.metrics.filter(({ metricProvenance }) => metricProvenance === "OFFICIAL_SOURCE");
  const seoulOnly = official.filter((metric) => !measuredByKey.has(`${metric.stationId}-${metric.fromLineId}-${metric.toLineId}`));
  const seoulPathwayEdges = pack.stationPathwayEdges.filter(({ sourceId }) => sourceId === "seoul-metro-transfer-distance-duration");
  const measuredPathwayEdges = pack.stationPathwayEdges.filter(({ sourceId }) => sourceId === "seoul-metro-transfer-car-door-duration");
  assert.equal(seoulPathwayEdges.length, seoulOnly.length);
  assert.equal(measuredPathwayEdges.length, official.length - seoulOnly.length + derived.length);
  assert.equal(pack.stationPathwayEdges.length, official.length + busan.metrics.filter(({ metricProvenance }) => metricProvenance === "OFFICIAL_SOURCE").length + derived.length);
  const pathwayHashes = new Set(pack.stationPathwayEdges.map(({ providerRecordHash }) => providerRecordHash));
  for (const metric of official) {
    const timed = measuredByKey.get(`${metric.stationId}-${metric.fromLineId}-${metric.toLineId}`);
    const expected = timed ? composite(metric.sourceRecordSha256, timed.sourceRecordSha256) : metric.sourceRecordSha256;
    assert.ok(pathwayHashes.has(expected), expected);
  }
  assert.ok(pack.stationPathwayEdges.every(({ provenanceKind, verificationStatus }) => provenanceKind === "OFFICIAL_SOURCE" && verificationStatus === "VERIFIED"));
});
function pick({ distanceMeters, officialDurationSecondsReference, metricProvenance }) { return { distanceMeters, officialDurationSecondsReference, metricProvenance }; }

async function fixtureRoot(mutate = () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "transfer-topology-metrics-"));
  const observationDirectory = path.join(root, "observation");
  const canonical = canonicalPack();
  const sourceCandidates = { candidates: [{ id: "seoul-metro-transfer-distance-duration", requestUrl: "https://api.odcloud.kr/api/15044419/v1/uddi:7008c675-928f-41d6-9a01-b3541f78466b", operation: { method: "GET", endpoint: "https://api.odcloud.kr/api/15044419/v1/uddi:7008c675-928f-41d6-9a01-b3541f78466b" }, evidence: { outputFields: ["연번", "호선", "환승역명", "환승노선", "환승거리", "환승소요시간"] } }] };
  const kric = { providerLines: [{ railOprIsttCd: "DX", operatorName: "네오트랜스주식회사", lnCd: "D1", lineName: "신분당" }] };
  const providerRows = observationRows();
  const fixture = { canonical, kric, manifest: {}, rows: providerRows, sourceCandidates, freshnessDate: "2025-12-31", mappedRowCount: 140 };
  mutate(fixture);
  const rows = sortRows(fixture.rows);
  const raw = rawSnapshot(fixture.rows);
  fixture.manifest = {
    artifactKind: "seoul-transfer-distance-duration-snapshot-manifest", sourceId: "seoul-metro-transfer-distance-duration",
    endpointSha256: sha256(sourceCandidates.candidates[0].requestUrl), capturedAt: "2026-08-15T00:00:00.000Z", freshnessDate: fixture.freshnessDate,
    rowCount: rows.length, rawSha256: sha256(snapshotBytes(raw)), contentSha256: sha256(snapshotBytes(rows)),
    schemaSha256: sha256(snapshotBytes({ fields: ["연번", "호선", "환승역명", "환승노선", "환승거리", "환승소요시간"] })), credentialRedacted: true,
  };
  const observation = { artifactKind: "seoul-transfer-distance-duration-observation", sourceId: "seoul-metro-transfer-distance-duration", capturedAt: fixture.manifest.capturedAt, rowCount: rows.length, rawSha256: fixture.manifest.rawSha256, contentSha256: fixture.manifest.contentSha256, rows, credentialRedacted: true };
  await mkdir(path.join(root, "tools/datapack/release"), { recursive: true });
  await mkdir(path.join(root, "tools/datapack/sources"), { recursive: true });
  await writeFile(path.join(root, "tools/datapack/release/capital-production-canonical-pack.json"), `${JSON.stringify(canonical)}\n`);
  await writeFile(path.join(root, "tools/datapack/source-candidates.json"), `${JSON.stringify(sourceCandidates)}\n`);
  await writeFile(path.join(root, "tools/datapack/sources/kric-provider-code-catalog-20260228.json"), `${JSON.stringify(kric)}\n`);
  await mkdir(observationDirectory);
  await writeFile(path.join(observationDirectory, "manifest.json"), `${JSON.stringify(fixture.manifest)}\n`);
  await writeFile(path.join(observationDirectory, "observation.json"), `${JSON.stringify(observation)}\n`);
  await writeFile(path.join(observationDirectory, "raw-snapshot.json"), snapshotBytes(raw));
  return { ...fixture, rows, root, observationDirectory };
}

// #875 F1: 파생(DERIVED_RECIPROCAL) 방향의 derivedFrom 결속은 절 하나만 깨져도 거부한다(절별 단독 위반).
function reciprocalMetrics(patch = {}) {
  const official = { stationId: "s", fromLineId: "A", toLineId: "B", distanceMeters: 100, officialDurationSecondsReference: 90, sourceRecordSha256: "h", metricProvenance: "OFFICIAL_SOURCE" };
  const derived = { stationId: "s", fromLineId: "B", toLineId: "A", distanceMeters: 100, officialDurationSecondsReference: 90, sourceRecordSha256: "h", metricProvenance: "DERIVED_RECIPROCAL", derivedFrom: { stationId: "s", fromLineId: "A", toLineId: "B", sourceRecordSha256: "h" } };
  const extra = patch.extra ?? [];
  return [{ ...official, ...patch.official }, { ...derived, ...patch.derived, derivedFrom: { ...derived.derivedFrom, ...patch.derivedFrom } }, ...extra];
}

test("정상 파생 쌍은 통과하고 derivedFrom 결속이 한 절만 깨져도 NO_GO다", () => {
  assert.doesNotThrow(() => assertExactDerivedReciprocals(reciprocalMetrics()));
  const official = (overrides) => ({ stationId: "s", fromLineId: "A", toLineId: "B", distanceMeters: 100, officialDurationSecondsReference: 90, sourceRecordSha256: "h", metricProvenance: "OFFICIAL_SOURCE", ...overrides });
  for (const [label, metrics] of [
    ["derivedFrom 역 불일치", reciprocalMetrics({ derivedFrom: { stationId: "s2" }, extra: [official({ stationId: "s2" })] })],
    ["derivedFrom 출발 노선 불일치", reciprocalMetrics({ derivedFrom: { fromLineId: "C" }, extra: [official({ fromLineId: "C" })] })],
    ["derivedFrom 도착 노선 불일치", reciprocalMetrics({ derivedFrom: { toLineId: "C" }, extra: [official({ toLineId: "C" })] })],
    ["공식 원천 방향 없음", reciprocalMetrics().slice(1)],
    ["원천 방향이 OFFICIAL_SOURCE가 아님", reciprocalMetrics({ official: { metricProvenance: "DERIVED_RECIPROCAL", derivedFrom: { stationId: "s", fromLineId: "B", toLineId: "A", sourceRecordSha256: "h" } } })],
    ["원천 방향 hash 불일치", reciprocalMetrics({ official: { sourceRecordSha256: "h2" } })],
    ["derivedFrom hash 불일치", reciprocalMetrics({ derivedFrom: { sourceRecordSha256: "h2" } })],
    ["원천 방향 거리 불일치", reciprocalMetrics({ official: { distanceMeters: 101 } })],
    ["원천 방향 시간 불일치", reciprocalMetrics({ official: { officialDurationSecondsReference: 91 } })],
  ]) assert.throws(() => assertExactDerivedReciprocals(metrics), /NO_GO derived reciprocal set mismatch/u, label);
});

const FILLER_STATION_COUNT = 65;
function canonicalPack() {
  const stationLines = [];
  const stations = [];
  const station = (stationId, nameKo, lineKeys, extra = {}) => { stations.push({ id: stationId, nameKo, ...extra }); stationLines.push(...lineKeys.map((key) => ({ stationId, lineId: id(key) }))); };
  station("station-b35616704ce3", "까치산", [2, 5]);
  station("station-gangnam", "강남", [2, "신분당"]);
  station("station-seoul", "서울역", [1, 4, "공항", "경의중앙"]);
  station("station-isu", "총신대입구", [4, 7], { nameSub: "이수" });
  station("station-sindorim", "신도림", [1, 2]);
  station("station-seongsu", "성수", [2]);
  station("station-gangdong", "강동", [5]);
  station("station-suseo", "수서", [3, "수인분당"]);
  station("station-seokgye", "석계", [6, 1]);
  station("station-gimpo", "김포공항", [5, "공항"]);
  station("station-geumjeong", "금정", [1, 4]);
  for (let index = 0; index < FILLER_STATION_COUNT; index += 1) station(`station-filler-${String(index).padStart(2, "0")}`, `환승${String(index).padStart(2, "0")}`, [7, 8]);
  for (const key of [9, "경춘", "우이신설", "김포골드", "서해", "신림", "GTXA"]) station(`station-only-${LINE[key][0]}`, `단일역${LINE[key][0]}`, [key]);
  stations.push({ id: "station-busan", nameKo: "부산역" });
  stationLines.push({ stationId: "station-busan", lineId: "line-ab1a041f6266" });
  const lines = [...Object.values(LINE).map(([lineId, nameKo]) => ({ id: lineId, nameKo, operatorId: "operator-fixture" })), { id: "line-ab1a041f6266", nameKo: "부산 1호선", operatorId: "busan-transportation" }];
  return { manifest: { manifestVersion: 2, channel: "production", keyId: "test", ttlSeconds: 1, activePack: { id: "capital", version: "1" } }, migrationSourceArtifact: { gzipSha256: "a".repeat(64), sqliteSha256: "b".repeat(64) }, packs: [{ id: "capital", version: "1", artifactKind: "production", schemaVersion: "1", metadata: { productionCoverageEvidence: JSON.stringify([{ regionId: "capital", operatorId: "seoul-metro", sourceDomain: "station_line_membership" }]) }, stations, lines, stationLines, networkEdges: [{ id: "edge", edgeType: "RIDE" }], operators: [{ id: "seoul-metro", nameKo: "서울교통공사" }] }] };
}

// 제외·예외 행은 실제 원천 행(연번·값)과 같다. 나머지는 매핑 가능한 합성 행이다.
function observationRows() {
  const pinned = new Map([
    [24, row(2, "성수", "2호선", 23, "00:19")], [35, row(2, "신도림", "2호선", 81, "01:08")], [59, row(3, "수서", "국철", 92, "01:17")],
    [79, row(5, "김포공항", "공항철도", 122, "04:42")], [102, row(5, "강동", "5호선", 19, "00:16")], [107, row(6, "석계", "경원선", 125, "01:44")],
  ]);
  const free = [
    row(5, "까치산", "2호선", 17), row(2, "강남", "신분당선", 214), row(1, "서울역", "4호선", 159), row(4, "서울역", "1호선", 159),
    row(1, "서울역", "공항철도", 309), row(4, "서울역", "공항철도", 224), row(4, "총신대입구", "7호선", 171), row(7, "이수", "4호선", 171),
    row(2, "신도림", "1호선", 81),
    ...Array.from({ length: FILLER_STATION_COUNT }, (_, index) => [row(7, `환승${String(index).padStart(2, "0")}`, "8호선", 100 + index), row(8, `환승${String(index).padStart(2, "0")}`, "7호선", 100 + index)]).flat(),
  ];
  const rows = [];
  let next = 0;
  for (let serial = 1; serial <= 145; serial += 1) rows.push({ ...(pinned.get(serial) ?? free[next++]), "연번": serial });
  assert.equal(next, free.length);
  return rows;
}
function row(line, station, to, distance, time = duration(distance)) { return { "호선": line, "환승역명": station, "환승노선": to, "환승거리": distance, "환승소요시간": time }; }
function rowHash(rows, line, station, to) { const matches = rows.filter((value) => value["호선"] === line && value["환승역명"] === station && value["환승노선"] === to); assert.equal(matches.length, 1); return sha256(JSON.stringify(sortValue(matches[0]))); }
function rawSnapshot(rows) { const page = (number, data) => { const envelope = { currentCount: data.length, data, matchCount: 145, page: number, perPage: 100, totalCount: 145 }; const bytes = Buffer.from(JSON.stringify(envelope)); return { page: number, perPage: 100, sha256: sha256(bytes), base64: bytes.toString("base64") }; }; return { artifactKind: "seoul-transfer-distance-duration-raw-snapshot", sourceId: "seoul-metro-transfer-distance-duration", pages: [page(1, rows.slice(0, 100)), page(2, rows.slice(100))] }; }
function duration(distance) { const seconds = Math.round(distance / 1.2); return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; }
function without(value, key) { const { [key]: _ignored, ...rest } = value; return rest; }
function sortValue(value) { if (Array.isArray(value)) return value.map(sortValue); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])])); return value; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function canonicalBytes(value) { return Buffer.from(`${JSON.stringify(sortValue(value))}\n`); }
function snapshotBytes(value) { return Buffer.from(`${JSON.stringify(value)}\n`); }
function sortRows(rows) { return [...rows].sort((left, right) => Buffer.compare(Buffer.from(["연번", "호선", "환승역명", "환승노선", "환승거리", "환승소요시간"].map((field) => left[field]).join("\0")), Buffer.from(["연번", "호선", "환승역명", "환승노선", "환승거리", "환승소요시간"].map((field) => right[field]).join("\0")))); }
