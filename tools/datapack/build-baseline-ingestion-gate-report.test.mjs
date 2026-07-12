import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildBaselineIngestionGateReport,
  buildGateTimeSourceDistinction,
  buildKricMovementContext,
  buildRosterFromPack,
} from "./build-baseline-ingestion-gate-report.mjs";

const pack = {
  stations: [
    { id: "station-sadang", nameKo: "사당", normalizedName: "사당" },
    { id: "station-gangnam", nameKo: "강남", normalizedName: "강남" },
    { id: "station-seongsu", nameKo: "성수", normalizedName: "성수" },
  ],
  stationAliases: [{ stationId: "station-sadang", alias: "사당역", normalizedAlias: "사당역" }],
  lines: [
    { id: "seoul-2", nameKo: "수도권 2호선" },
    { id: "seoul-4", nameKo: "수도권 4호선" },
    { id: "shinbundang", nameKo: "신분당선" },
    { id: "seoul-2-branch", nameKo: "수도권 2호선 지선" },
  ],
  stationLines: [
    { stationId: "station-sadang", lineId: "seoul-2" },
    { stationId: "station-sadang", lineId: "seoul-4" },
    { stationId: "station-gangnam", lineId: "seoul-2" },
    { stationId: "station-gangnam", lineId: "shinbundang" },
    { stationId: "station-seongsu", lineId: "seoul-2" },
    { stationId: "station-seongsu", lineId: "seoul-2-branch" },
  ],
  stationPathwayNodes: [
    { id: "n-sadang-2", stationId: "station-sadang", lineId: "seoul-2", nodeType: "PLATFORM" },
    { id: "n-sadang-4", stationId: "station-sadang", lineId: "seoul-4", nodeType: "PLATFORM" },
  ],
  stationPathwayEdges: [
    {
      id: "e-sadang",
      fromNodeId: "n-sadang-4",
      toNodeId: "n-sadang-2",
      bidirectional: true,
      durationSeconds: 62,
      sourceId: "seoul-metro-transfer-distance-duration",
      sourceSnapshotId: "seoul-metro-transfer-distance-duration-admission-20260713",
      provenanceKind: "OFFICIAL_SOURCE",
    },
  ],
  transferRules: [
    {
      id: "transfer-sadang",
      sourceId: "seoul-metro-transfer-distance-duration",
      pathwayEdgeId: "e-sadang",
      minTransferSeconds: 62,
    },
    { id: "transfer-gangnam", sourceId: "seoul-metro-transfer-distance-duration", pathwayEdgeId: null },
  ],
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function kricStep() {
  return {
    chtnMvTpOrdr: "1",
    edMovePath: "끝",
    elvtSttCd: null,
    elvtTpCd: null,
    imgPath: "",
    mvContDtl: "이동",
    mvPathMgNo: "1",
    stMovePath: "시작",
  };
}

function admittedKricContext(overrides = {}) {
  const liveSampleRowCount = overrides.liveSampleRowCount ?? 8;
  const rows = new Array(liveSampleRowCount).fill(null).map(() => kricStep());
  const providerRecordHashes = rows.map((row) => sha256(JSON.stringify(row)));
  const liveSampleRawSha256 = "a".repeat(64);
  const liveSampleSchemaFingerprint = "b".repeat(64);
  const evidence = {
    candidateId: "kric-transfer-movement-detailed",
    endpoint: "https://openapi.kric.go.kr/openapi/vulnerableUserInfo/transferMovement",
    format: "xml",
    fields: Object.keys(kricStep()),
    rowCount: liveSampleRowCount,
    rawSha256: liveSampleRawSha256,
    schemaFingerprint: liveSampleSchemaFingerprint,
    credentialRedacted: true,
    providerRecordHashes,
  };
  const liveSampleEvidenceHash = sha256(JSON.stringify(evidence));
  return {
    candidateId: "kric-transfer-movement-detailed",
    endpoint: "https://openapi.kric.go.kr/openapi/vulnerableUserInfo/transferMovement",
    sampleEndpoint: "https://openapi.kric.go.kr/openapi/vulnerableUserInfo/transferMovement",
    requestTuple: {
      railOprIsttCd: "S1",
      lnCd: "3",
      stinCd: "321",
      prevStinCd: "422",
      chthTgtLn: "4",
      chtnNextStinCd: "424",
    },
    liveSampleRowCount,
    liveSampleFormat: "xml",
    liveSampleFields: Object.keys(kricStep()),
    liveSampleRawSha256,
    liveSampleSchemaFingerprint,
    liveSampleEvidenceHash,
    admission: {
      candidateId: "kric-transfer-movement-detailed",
      sourceId: "kric-transfer-movement-detailed",
      snapshotId: "kric-transfer-movement-detailed-admission-20260713",
      decision: "APPROVED",
      rawSha256: liveSampleRawSha256,
      schemaFingerprint: liveSampleSchemaFingerprint,
      sampleEvidenceHash: liveSampleEvidenceHash,
    },
    ...overrides,
  };
}

test("buildRosterFromPack: 짧은 lineNameKo 도출('수도권 2호선'→'2호선')", () => {
  const roster = buildRosterFromPack(pack);
  assert.equal(roster.length, 6);
  const sadang2 = roster.find((r) => r.stationId === "station-sadang" && r.lineId === "seoul-2");
  assert.equal(sadang2.lineNameKo, "2호선");
  const branch = roster.find((r) => r.lineId === "seoul-2-branch");
  assert.equal(branch.lineNameKo, "2호선 지선");
  const shinbundang = roster.find((r) => r.lineId === "shinbundang");
  assert.equal(shinbundang.lineNameKo, "신분당선");
});

test("buildKricMovementContext: candidate sampleUrl 누락을 명확히 거부한다", () => {
  for (const sampleUrl of [undefined, " \t", null, 42]) {
    const evidence = sampleUrl === undefined ? {} : { sampleUrl };
    assert.throws(
      () =>
        buildKricMovementContext({
          sourceCandidates: { candidates: [{ id: "kric-transfer-movement-detailed", evidence }] },
          sourceInventory: { sources: [{ id: "kric-transfer-movement-detailed" }] },
        }),
      /kric-transfer-movement-detailed candidate evidence\.sampleUrl missing/,
    );
  }
});

test("게이트③: generated baseline edge도 matching rule과 duration을 대조한다", () => {
  const report = buildGateTimeSourceDistinction(
    {
      transferRules: [{ id: "generated-rule", pathwayEdgeId: "generated-edge", minTransferSeconds: 62 }],
      stationPathwayEdges: [
        {
          id: "generated-edge",
          durationSeconds: 63,
          sourceId: "seoul-metro-transfer-distance-duration",
          sourceSnapshotId: "seoul-metro-transfer-distance-duration-admission-20260713",
          provenanceKind: "OFFICIAL_SOURCE",
        },
      ],
    },
    [],
    [],
  );

  assert.equal(report.status, "FAIL");
  assert.equal(report.edgeChecks[0].ruleId, "generated-rule");
  assert.ok(report.edgeChecks[0].failures.includes("edge durationSeconds does not match rule minTransferSeconds"));
});

test("리포트: 수집 전량 기준 coverage + 게이트 + 스코프 metadata", () => {
  const roster = buildRosterFromPack(pack);
  const transferRows = [
    { 연번: 1, 호선: 2, 환승거리: 74, 환승노선: "4호선", 환승소요시간: "01:02", 환승역명: "사당" },
    { 연번: 2, 호선: 4, 환승거리: 74, 환승노선: "2호선", 환승소요시간: "01:02", 환승역명: "사당" },
    { 연번: 3, 호선: 2, 환승거리: 214, 환승노선: "신분당선", 환승소요시간: "02:58", 환승역명: "강남" },
    { 연번: 4, 호선: 2, 환승거리: 23, 환승노선: "2호선", 환승소요시간: "00:19", 환승역명: "성수" },
    { 연번: 5, 호선: 1, 환승거리: 159, 환승노선: "2호선", 환승소요시간: "02:13", 환승역명: "없는역" },
  ];
  const carDoorRows = [
    {
      stnNm: "사당",
      lineNm: "2호선",
      qckgffVhclDoorNo: "3-2",
      upbdnbSe: "상행",
      plfmCmgFac: "계단",
      qckgffMngNo: "1",
      facNo: "1",
    },
    { stnNm: "없는역", lineNm: "9호선", qckgffVhclDoorNo: "1-1", upbdnbSe: "상행", plfmCmgFac: "계단" },
  ];
  const kricMovement = { header: { resultCode: "00", resultCnt: 8 }, body: new Array(8).fill(kricStep()) };

  const report = buildBaselineIngestionGateReport({
    roster,
    transferRows,
    carDoorRows,
    kricMovement: {
      ...kricMovement,
    },
    kricMovementContext: admittedKricContext(),
    existingEdges: pack.stationPathwayEdges,
    existingNodes: pack.stationPathwayNodes,
    fixtureTransferRules: pack.transferRules,
    fixtureReflectedRuleCount: pack.transferRules.length,
  });

  // 스코프 metadata 명기.
  assert.equal(report.metadata.issue, "#1701");
  assert.match(report.metadata.scopeDecision, /비범위/);
  assert.match(report.metadata.scopeDecision, /#1702\/#1414/);
  assert.match(report.metadata.countingBasis, /수집 전량/);
  assert.match(report.metadata.countingBasis, /환승역거리 소요시간 5행.*빠른하차 2행/);
  assert.equal(
    report.metadata.reproducibility,
    "tracked snapshot; regenerated only from local-only raw inputs (.codex/evidence/1701/, gitignored)",
  );

  // coverage: 전량 5행 기준, 사당 양방향+강남 매칭(3), 성수 자기루프 제외, 없는역 quarantine.
  assert.equal(report.coverage.transfer.totalRows, 5);
  assert.equal(report.coverage.transfer.admittedRules, 3);
  assert.equal(report.coverage.transfer.fixtureReflectedRules.count, 2);
  assert.equal(report.coverage.transfer.selfLoopExcludedRules.length, 1);
  assert.equal(report.coverage.transfer.selfLoopExcludedRules[0].stationId, "station-seongsu");
  assert.equal(report.coverage.transfer.quarantinedRows, 3);
  assert.match(report.coverage.transfer.description, /서로 배타적이지 않다/);

  // 게이트①: 사당 방향쌍 일치(62초 양방향).
  const sadangPair = report.gateInternalConsistency.directionPairReport.find(
    (row) => row.stationId === "station-sadang",
  );
  assert.equal(sadangPair.forwardMinTransferSeconds, 62);
  assert.equal(sadangPair.hasReverse, true);
  assert.equal(sadangPair.secondsMismatch, false);
  assert.equal(
    report.gateInternalConsistency.directionPairReport.some(
      (row) => row.fromLineId === row.toLineId,
    ),
    false,
  );

  // 게이트②: KRIC detailed admitted + 구조 정합.
  assert.equal(report.gateKricStructuralAlignment.kricMovementDetailed.admitted, true);
  assert.equal(report.gateKricStructuralAlignment.kricMovementDetailed.stepCount, 8);
  assert.equal(report.gateKricStructuralAlignment.kricStandardResult.status, "SKIPPED");

  // 게이트③: OFFICIAL_SOURCE 구분 축.
  assert.equal(report.gateTimeSourceDistinction.provenanceKindAxis, "OFFICIAL_SOURCE");
  assert.equal(report.gateTimeSourceDistinction.status, "PASS");

  // pilot 편차 SKIPPED.
  assert.equal(report.pilotFieldDeviation.status, "SKIPPED");

  // car-door 전량 2행 중 1행 매칭, 1행 quarantine.
  assert.equal(report.coverage.carDoor.totalRows, 2);
  assert.equal(report.coverage.carDoor.admittedHints, 1);
  assert.equal(report.coverage.carDoor.quarantinedRows, 1);
});

test("게이트①: 양방향 환승 시간이 다르면 secondsMismatch를 기록한다", () => {
  const report = buildBaselineIngestionGateReport({
    roster: buildRosterFromPack(pack),
    transferRows: [
      { 연번: 1, 호선: 2, 환승거리: 74, 환승노선: "4호선", 환승소요시간: "01:02", 환승역명: "사당" },
      { 연번: 2, 호선: 4, 환승거리: 74, 환승노선: "2호선", 환승소요시간: "01:03", 환승역명: "사당" },
    ],
    carDoorRows: [],
    kricMovement: null,
  });
  const sadangPair = report.gateInternalConsistency.directionPairReport.find(
    (row) => row.stationId === "station-sadang",
  );

  assert.equal(sadangPair.hasReverse, true);
  assert.equal(sadangPair.secondsMismatch, true);
});

test("게이트①: 동일 역·노선 방향의 중복 행을 duplicateReport에 기록한다", () => {
  const report = buildBaselineIngestionGateReport({
    roster: buildRosterFromPack(pack),
    transferRows: [
      { 연번: 1, 호선: 2, 환승거리: 74, 환승노선: "4호선", 환승소요시간: "01:02", 환승역명: "사당" },
      { 연번: 2, 호선: 2, 환승거리: 74, 환승노선: "4호선", 환승소요시간: "01:03", 환승역명: "사당" },
    ],
    carDoorRows: [],
    kricMovement: null,
  });
  const duplicates = report.gateInternalConsistency.duplicateReport;
  assert.equal(duplicates.length, 1);
  const duplicate = duplicates[0];
  assert.equal(duplicate.stationId, "station-sadang");
  assert.equal(duplicate.fromLineId, "seoul-2");
  assert.equal(duplicate.toLineId, "seoul-4");
  assert.equal(duplicate.firstMinTransferSeconds, 62);
  assert.equal(duplicate.duplicateMinTransferSeconds, 63);
});

test("리포트: 객체가 아닌 transfer row를 malformed로 계측하고 중단하지 않는다", () => {
  const report = buildBaselineIngestionGateReport({
    roster: buildRosterFromPack(pack),
    transferRows: [null, "not-an-object"],
    carDoorRows: [],
    kricMovement: null,
    fixtureReflectedRuleCount: pack.transferRules.length,
  });

  assert.equal(report.coverage.transfer.totalRows, 2);
  assert.equal(report.coverage.transfer.uniqueStationNames, 0);
  assert.equal(report.coverage.transfer.malformedRows, 2);
  assert.equal(report.gateKricStructuralAlignment.structurallyAligned, false);
});

test("리포트: 빈 환승역명은 고유 역 수에서 제외한다", () => {
  const report = buildBaselineIngestionGateReport({
    roster: buildRosterFromPack(pack),
    transferRows: [
      { 연번: 1, 호선: 2, 환승거리: 10, 환승노선: "4호선", 환승소요시간: "00:10" },
      { 연번: 2, 호선: 2, 환승거리: 10, 환승노선: "4호선", 환승소요시간: "00:10", 환승역명: "  " },
    ],
    carDoorRows: [],
    kricMovement: null,
  });

  assert.equal(report.coverage.transfer.uniqueStationNames, 0);
  assert.equal(report.coverage.transfer.malformedRows, 0);
});

test("게이트②: 충무로 3↔4 baseline 행을 전량에서 추출한다", () => {
  const roster = buildRosterFromPack(pack);
  const transferRows = [
    { 연번: 52, 호선: 3, 환승거리: 17, 환승노선: "4호선", 환승소요시간: "00:14", 환승역명: "충무로" },
    { 연번: 71, 호선: 4, 환승거리: 17, 환승노선: "3호선", 환승소요시간: "00:14", 환승역명: "충무로" },
  ];
  const report = buildBaselineIngestionGateReport({
    roster,
    transferRows,
    carDoorRows: [],
    kricMovement: { header: { resultCode: "00" }, body: [kricStep()] },
    kricMovementContext: admittedKricContext({
      liveSampleRowCount: 1,
    }),
  });
  assert.equal(report.gateKricStructuralAlignment.transferBaselineChungmuro.length, 2);
  assert.equal(report.gateKricStructuralAlignment.structurallyAligned, true);
});

test("게이트②: 정확한 충무로 3↔4 양방향과 비어 있지 않은 detailed body를 모두 요구한다", () => {
  const roster = buildRosterFromPack(pack);
  const direction3To4 = {
    연번: 52,
    호선: 3,
    환승거리: 17,
    환승노선: "4호선",
    환승소요시간: "00:14",
    환승역명: "충무로",
  };
  const direction4To3 = { ...direction3To4, 연번: 71, 호선: 4, 환승노선: "3호선" };
  const build = (transferRows, body = [kricStep()]) =>
    buildBaselineIngestionGateReport({
      roster,
      transferRows,
      carDoorRows: [],
      kricMovement: { header: { resultCode: "00" }, body },
      kricMovementContext: admittedKricContext({
        liveSampleRowCount: body.length,
      }),
    }).gateKricStructuralAlignment;

  assert.equal(build([direction3To4]).structurallyAligned, false);
  assert.equal(
    build([{ ...direction3To4, 호선: 2, 환승노선: "4호선" }, direction4To3]).structurallyAligned,
    false,
  );
  assert.equal(
    build([{ ...direction3To4, 환승거리: 18 }, direction4To3]).structurallyAligned,
    false,
  );
  assert.equal(
    build([direction3To4, { ...direction4To3, 환승소요시간: "00:15" }]).structurallyAligned,
    false,
  );
  assert.equal(build([direction3To4, direction4To3], []).structurallyAligned, false);
});

test("게이트②: tracked endpoint·request tuple·admission hash가 다르면 detailed 응답을 admit하지 않는다", () => {
  const transferRows = [
    { 연번: 52, 호선: 3, 환승거리: 17, 환승노선: "4호선", 환승소요시간: "00:14", 환승역명: "충무로" },
    { 연번: 71, 호선: 4, 환승거리: 17, 환승노선: "3호선", 환승소요시간: "00:14", 환승역명: "충무로" },
  ];
  const build = (kricMovementContext) =>
    buildBaselineIngestionGateReport({
      roster: buildRosterFromPack(pack),
      transferRows,
      carDoorRows: [],
      kricMovement: { header: { resultCode: "00" }, body: [kricStep()] },
      kricMovementContext,
    }).gateKricStructuralAlignment;

  const assertRejected = (result, expectedFailure) => {
    assert.equal(result.structurallyAligned, false);
    assert.equal(result.kricMovementDetailed.admitted, false);
    assert.equal(result.kricMovementDetailed.evidenceValidation.status, "FAIL");
    assert.ok(result.kricMovementDetailed.evidenceValidation.failures.includes(expectedFailure));
  };

  assertRejected(
    build(admittedKricContext({ endpoint: "https://example.invalid/wrong", liveSampleRowCount: 1 })),
    "endpoint mismatch",
  );
  assertRejected(
    build(
      admittedKricContext({
        requestTuple: { ...admittedKricContext().requestTuple, stinCd: "999" },
        liveSampleRowCount: 1,
      }),
    ),
    "request tuple mismatch: stinCd",
  );
  const changedContent = { ...kricStep(), mvContDtl: "변조된 이동 경로" };
  assertRejected(
    buildBaselineIngestionGateReport({
      roster: buildRosterFromPack(pack),
      transferRows,
      carDoorRows: [],
      kricMovement: { header: { resultCode: "00" }, body: [changedContent] },
      kricMovementContext: admittedKricContext({ liveSampleRowCount: 1 }),
    }).gateKricStructuralAlignment,
    "response content evidenceHash mismatch",
  );
  assertRejected(
    build(
      admittedKricContext({
        admission: { ...admittedKricContext().admission, sampleEvidenceHash: "d".repeat(64) },
        liveSampleRowCount: 1,
      }),
    ),
    "sampleEvidenceHash admission mismatch",
  );
});

test("게이트②: standard 응답 artifact가 없으면 resultCode를 hardcode하지 않고 SKIPPED로 기록한다", () => {
  const report = buildBaselineIngestionGateReport({
    roster: buildRosterFromPack(pack),
    transferRows: [],
    carDoorRows: [],
    kricMovement: null,
    kricMovementContext: admittedKricContext(),
    kricStandardMovement: null,
  });

  assert.equal(report.gateKricStructuralAlignment.kricStandardResult.status, "SKIPPED");
  assert.equal(report.gateKricStructuralAlignment.kricStandardResult.resultCode, null);
});

test("게이트③: 공식 rule이 참조하는 기존 edge의 provenance 누락을 FAIL 처리한다", () => {
  const report = buildBaselineIngestionGateReport({
    roster: buildRosterFromPack(pack),
    transferRows: [],
    carDoorRows: [],
    kricMovement: null,
    existingEdges: [{ id: "e-sadang", provenanceKind: "UNKNOWN", sourceId: "fixture" }],
    fixtureTransferRules: pack.transferRules,
  });

  assert.equal(report.gateTimeSourceDistinction.status, "FAIL");
});

test("게이트③: pathwayEdgeId가 없는 공식 rule을 edgeMissing에 명시 기록하고 status는 PASS를 유지한다", () => {
  const report = buildBaselineIngestionGateReport({
    roster: buildRosterFromPack(pack),
    transferRows: [],
    carDoorRows: [],
    kricMovement: null,
    existingEdges: pack.stationPathwayEdges,
    fixtureTransferRules: pack.transferRules,
  });

  assert.equal(report.gateTimeSourceDistinction.status, "PASS");
  assert.equal(report.gateTimeSourceDistinction.edgeMissing.length, 1);
  assert.equal(report.gateTimeSourceDistinction.edgeMissing[0].ruleId, "transfer-gangnam");
  assert.match(report.gateTimeSourceDistinction.edgeMissing[0].reason, /플랫폼 노드/);
  // edgeMissing된 rule은 edgeChecks에는 나타나지 않는다(실검증 대상 아님).
  assert.equal(
    report.gateTimeSourceDistinction.edgeChecks.some((check) => check.ruleId === "transfer-gangnam"),
    false,
  );
});

test("게이트③: 공식 rule과 edge가 모두 없으면 SKIPPED를 기록한다", () => {
  const report = buildBaselineIngestionGateReport({
    roster: buildRosterFromPack(pack),
    transferRows: [],
    carDoorRows: [],
    kricMovement: null,
    existingEdges: [],
    fixtureTransferRules: [],
  });

  assert.equal(report.gateTimeSourceDistinction.status, "SKIPPED");
  assert.deepEqual(report.gateTimeSourceDistinction.edgeChecks, []);
  assert.deepEqual(report.gateTimeSourceDistinction.edgeMissing, []);
});

test("게이트③: 모든 공식 rule은 edgeChecks 또는 edgeMissing 중 하나에 반드시 나타난다(조용히 빠지지 않는다)", () => {
  const rogueRule = {
    id: "transfer-rogue",
    sourceId: "seoul-metro-transfer-distance-duration",
    pathwayEdgeId: "e-does-not-exist",
  };
  const report = buildBaselineIngestionGateReport({
    roster: buildRosterFromPack(pack),
    transferRows: [],
    carDoorRows: [],
    kricMovement: null,
    existingEdges: pack.stationPathwayEdges,
    fixtureTransferRules: [...pack.transferRules, rogueRule],
  });

  const officialRuleIds = [...pack.transferRules, rogueRule]
    .filter((rule) => rule.sourceId === "seoul-metro-transfer-distance-duration")
    .map((rule) => rule.id);
  const observedRuleIds = new Set([
    ...report.gateTimeSourceDistinction.edgeChecks.map((check) => check.ruleId),
    ...report.gateTimeSourceDistinction.edgeMissing.map((entry) => entry.ruleId),
  ]);
  for (const ruleId of officialRuleIds) {
    assert.ok(observedRuleIds.has(ruleId), `rule ${ruleId}이 edgeChecks/edgeMissing 어디에도 없다(조용히 빠짐)`);
  }
  // pathwayEdgeId는 있으나 참조 edge가 존재하지 않는 rogue rule은 edgeChecks에서 실패로 잡혀 FAIL이 되어야 한다.
  assert.equal(report.gateTimeSourceDistinction.status, "FAIL");
});

test("게이트③: non-empty여도 admitted transfer snapshot과 다르면 FAIL 처리한다", () => {
  const report = buildBaselineIngestionGateReport({
    roster: buildRosterFromPack(pack),
    transferRows: [],
    carDoorRows: [],
    kricMovement: null,
    existingEdges: [
      {
        id: "e-sadang",
        durationSeconds: 62,
        provenanceKind: "OFFICIAL_SOURCE",
        sourceId: "seoul-metro-transfer-distance-duration",
        sourceSnapshotId: "different-admission-snapshot",
      },
    ],
    fixtureTransferRules: pack.transferRules,
  });

  assert.equal(report.gateTimeSourceDistinction.status, "FAIL");
});
