#!/usr/bin/env node
// #1701 baseline 적재 검증 게이트 리포트 생성기(tracked 산출물).
//
// 공공기관 환승역거리 소요시간·빠른하차·KRIC 동선 baseline을 capital 참조 팩(catalog-fixture.json)에
// 적재하면서, 수집 전량(환승 145행/빠른하차 2358행) 기준으로 coverage와 desk 게이트 ①②③를 산출한다.
//
// 스코프 결정(리포트 최상단 metadata에 명기):
//   - 팩 적재 대상은 capital 참조 팩(catalog-fixture.json)뿐이다.
//   - 프로덕션 pilot 팩·release gate 확장은 이 PR의 비범위이며 #1702/#1414 트랙 후속이다.
//   - coverage/desk 게이트 수치는 수집 전량 기준으로 계산하고, capital 6역 스코프라는 한정 사유를 명기한다.
//
// 이 스크립트는 원본 importer(buildTransferBaseline/buildCarDoorHints)와 normalizer를 재사용해
// 적재 결과·quarantine를 그대로 반영한다. importer/normalizer/build-datapack은 수정하지 않는다.
//
// 사용: node tools/datapack/build-baseline-ingestion-gate-report.mjs \
//   --fixture tools/datapack/fixtures/catalog-fixture.json \
//   --transfer-rows <transfer.merged-rows.json> \
//   --car-door-rows <fast-exit.merged-rows.json> \
//   --kric-movement <kric-transfer-movement-detailed.raw.json> \
//   --source-candidates tools/datapack/source-candidates.json \
//   --source-inventory tools/datapack/source-inventory.json \
//   [--kric-standard-movement <kric-transfer-movement-standard.raw.json>] \
//   --output <report.json>
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseArgs, readJsonFile, requireArg, sortJson } from "./lib/ledger-admission-cli.mjs";
import { buildTransferBaseline } from "./import-transfer-baseline.mjs";
import { buildCarDoorHints } from "./import-car-door-hints.mjs";
import { normalizeTransferDistanceDurationRows } from "./normalize-transfer-distance-duration-rows.mjs";

const TRANSFER_SOURCE_ID = "seoul-metro-transfer-distance-duration";
const CAR_DOOR_SOURCE_ID = "seoul-metro-fast-exit-car-door";
const KRIC_MOVEMENT_SOURCE_ID = "kric-transfer-movement-detailed";
const KRIC_STANDARD_SOURCE_ID = "kric-transfer-movement-standard";
const TRANSFER_SNAPSHOT_ID = "seoul-metro-transfer-distance-duration-admission-20260713";
const CAR_DOOR_SNAPSHOT_ID = "seoul-metro-fast-exit-car-door-admission-20260713";
const KRIC_DETAILED_ENDPOINT = "https://openapi.kric.go.kr/openapi/vulnerableUserInfo/transferMovement";
const KRIC_CHUNGMURO_REQUEST_TUPLE = Object.freeze({
  railOprIsttCd: "S1",
  lnCd: "3",
  stinCd: "321",
  prevStinCd: "422",
  chthTgtLn: "4",
  chtnNextStinCd: "424",
});

async function main(argv) {
  const args = parseArgs(argv);
  const fixture = await readJsonFile(requireArg(args, "fixture"));
  const transferRows = await readJsonFile(requireArg(args, "transfer-rows"));
  const carDoorRows = await readJsonFile(requireArg(args, "car-door-rows"));
  const kricMovement = await readJsonFile(requireArg(args, "kric-movement"));
  const sourceCandidates = await readJsonFile(requireArg(args, "source-candidates"));
  const sourceInventory = await readJsonFile(requireArg(args, "source-inventory"));
  const kricStandardMovement = args["kric-standard-movement"]
    ? await readJsonFile(args["kric-standard-movement"])
    : null;
  const outputPath = requireArg(args, "output");

  const pack = fixture.packs[0];
  const report = buildBaselineIngestionGateReport({
    roster: buildRosterFromPack(pack),
    transferRows,
    carDoorRows,
    kricMovement,
    kricMovementContext: buildKricMovementContext({ sourceCandidates, sourceInventory }),
    kricStandardMovement,
    existingEdges: pack.stationPathwayEdges ?? [],
    existingNodes: pack.stationPathwayNodes ?? [],
    fixtureTransferRules: pack.transferRules ?? [],
    fixtureReflectedRuleCount: (pack.transferRules ?? []).length,
  });

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(sortJson(report), null, 2)}\n`);
}

/**
 * tracked candidate의 exact request context와 admitted inventory evidence를 결합한다.
 * KRIC response body에는 station/line identifier가 없으므로 serviceKey를 제외한 이 context가
 * detailed response의 endpoint·tuple identity를 제공한다.
 */
export function buildKricMovementContext({ sourceCandidates, sourceInventory }) {
  const candidate = (sourceCandidates?.candidates ?? []).find((entry) => entry.id === KRIC_MOVEMENT_SOURCE_ID);
  const inventorySource = (sourceInventory?.sources ?? []).find((entry) => entry.id === KRIC_MOVEMENT_SOURCE_ID);
  if (!candidate) throw new Error(`${KRIC_MOVEMENT_SOURCE_ID} source candidate missing`);
  if (!inventorySource) throw new Error(`${KRIC_MOVEMENT_SOURCE_ID} source inventory entry missing`);

  const sampleUrlRaw = candidate.evidence?.sampleUrl;
  if (typeof sampleUrlRaw !== "string" || sampleUrlRaw.trim() === "") {
    throw new Error(`${KRIC_MOVEMENT_SOURCE_ID} candidate evidence.sampleUrl missing`);
  }
  const sampleUrl = new URL(sampleUrlRaw.trim());
  const requestTuple = Object.fromEntries(
    Object.keys(KRIC_CHUNGMURO_REQUEST_TUPLE).map((key) => [key, sampleUrl.searchParams.get(key)]),
  );
  return {
    candidateId: candidate.id,
    endpoint: candidate.evidence?.endpoint ?? null,
    sampleEndpoint: `${sampleUrl.origin}${sampleUrl.pathname}`,
    requestTuple,
    liveSampleRowCount: candidate.evidence?.liveSampleRowCount ?? null,
    liveSampleFormat: candidate.evidence?.liveSampleFormat ?? null,
    liveSampleFields: candidate.evidence?.liveSampleFields ?? [],
    liveSampleRawSha256: candidate.evidence?.liveSampleRawSha256 ?? null,
    liveSampleSchemaFingerprint: candidate.evidence?.liveSampleSchemaFingerprint ?? null,
    liveSampleEvidenceHash: candidate.evidence?.liveSampleEvidenceHash ?? null,
    admission: inventorySource.admissionEvidence ?? null,
  };
}

/**
 * catalog-fixture pack의 stations/stationAliases/stationLines/lines에서 roster를 빌드한다.
 * stationLine 하나당 엔트리 하나. lineNameKo는 line.nameKo에서 "수도권 " prefix를 제거한 짧은형으로
 * 지정해야 데이터의 짧은형("2호선" 등)과 matchLineForStation이 매칭된다.
 */
export function buildRosterFromPack(pack) {
  const stationsById = new Map((pack.stations ?? []).map((station) => [station.id, station]));
  const linesById = new Map((pack.lines ?? []).map((line) => [line.id, line]));
  const aliasesByStation = new Map();
  for (const alias of pack.stationAliases ?? []) {
    if (!aliasesByStation.has(alias.stationId)) aliasesByStation.set(alias.stationId, []);
    aliasesByStation.get(alias.stationId).push({ alias: alias.alias, normalizedAlias: alias.normalizedAlias });
  }
  return (pack.stationLines ?? []).map((stationLine) => {
    const station = stationsById.get(stationLine.stationId);
    const line = linesById.get(stationLine.lineId);
    return {
      stationId: stationLine.stationId,
      lineId: stationLine.lineId,
      nameKo: station?.nameKo ?? "",
      normalizedName: station?.normalizedName ?? "",
      lineNameKo: shortLineName(line?.nameKo ?? ""),
      lineName: line?.nameKo ?? "",
      aliases: aliasesByStation.get(stationLine.stationId) ?? [],
    };
  });
}

// line.nameKo("수도권 2호선")에서 수도권 prefix를 제거한 짧은형("2호선")을 도출한다. prefix 없으면 원형.
function shortLineName(nameKo) {
  return String(nameKo ?? "").replace(/^수도권\s+/, "");
}

/**
 * 순수 함수: 수집 전량 + roster → 검증 게이트 리포트.
 */
export function buildBaselineIngestionGateReport({
  roster,
  transferRows,
  carDoorRows,
  kricMovement,
  kricMovementContext = null,
  kricStandardMovement = null,
  existingEdges = [],
  existingNodes = [],
  fixtureTransferRules = [],
  fixtureReflectedRuleCount = 0,
}) {
  const transferRowList = Array.isArray(transferRows) ? transferRows : [];
  const carDoorRowList = Array.isArray(carDoorRows) ? carDoorRows : [];
  const validTransferRows = transferRowList.filter(
    (row) => row != null && typeof row === "object" && !Array.isArray(row),
  );
  const { normalizedRows, malformed } = normalizeTransferDistanceDurationRows(transferRowList);

  const transfer = buildTransferBaseline({
    roster,
    rows: normalizedRows,
    existingEdges,
    existingNodes,
    sourceId: TRANSFER_SOURCE_ID,
    snapshotId: TRANSFER_SNAPSHOT_ID,
    verificationStatus: "VERIFIED",
  });
  const carDoor = buildCarDoorHints({
    roster,
    rows: carDoorRowList,
    sourceId: CAR_DOOR_SOURCE_ID,
    snapshotId: CAR_DOOR_SNAPSHOT_ID,
    verificationStatus: "OFFICIAL",
  });

  // from==to 자기루프 transferRule은 무의미하므로 적재 대상에서 제외한다(성수 2호선→2호선).
  const admittedTransferRules = transfer.transferRules.filter((rule) => rule.fromLineId !== rule.toLineId);
  const selfLoopTransferRules = transfer.transferRules.filter((rule) => rule.fromLineId === rule.toLineId);

  const uniqueTransferStations = new Set(
    validTransferRows
      .map((row) => row["환승역명"])
      .filter((stationName) => typeof stationName === "string" && stationName.trim() !== "")
      .map((stationName) => stationName.trim()),
  ).size;
  const matchedTransferStations = new Set(admittedTransferRules.map((rule) => rule.fromStationId));

  return {
    schemaVersion: 1,
    artifactKind: "baseline-ingestion-gate-report",
    metadata: {
      issue: "#1701",
      scopeDecision:
        "프로덕션 pilot 팩 적재는 이 PR의 비범위이며 #1702/#1414 트랙 후속이다. 이 리포트의 팩 적재 대상은 " +
        "capital 참조 팩(tools/datapack/fixtures/catalog-fixture.json)뿐이며, tools/datapack/release/의 " +
        "프로덕션 pilot 팩·tools/datapack/inputs/*·release gate는 건드리지 않았다.",
      countingBasis:
        `coverage와 desk 게이트 수치는 수집 전량(환승역거리 소요시간 ${transferRowList.length}행, ` +
        `빠른하차 ${carDoorRowList.length}행) 기준으로 계산한다. ` +
        "팩 적재 매칭은 capital 6역(상록수·사당·강남·정자·성수·신설동) roster 스코프로 한정되어 대부분의 전량 행은 " +
        "roster 밖이라 quarantine된다 — 이 한정 사유를 정직하게 계측한다.",
      officialSources: {
        transfer: TRANSFER_SOURCE_ID,
        carDoor: CAR_DOOR_SOURCE_ID,
        kricMovement: KRIC_MOVEMENT_SOURCE_ID,
      },
      reproducibility:
        "tracked snapshot; regenerated only from local-only raw inputs (.codex/evidence/1701/, gitignored)",
    },
    coverage: buildCoverage({
      transfer,
      admittedTransferRules,
      selfLoopTransferRules,
      malformed,
      uniqueTransferStations,
      matchedTransferStations,
      transferRowTotal: transferRowList.length,
      carDoor,
      carDoorRowTotal: carDoorRowList.length,
      fixtureReflectedRuleCount,
    }),
    gateInternalConsistency: buildGateInternalConsistency(transfer, admittedTransferRules, selfLoopTransferRules),
    gateKricStructuralAlignment: buildGateKricStructuralAlignment(
      normalizedRows,
      kricMovement,
      kricMovementContext,
      kricStandardMovement,
    ),
    gateTimeSourceDistinction: buildGateTimeSourceDistinction(transfer, fixtureTransferRules, existingEdges),
    pilotFieldDeviation: {
      status: "SKIPPED",
      reason:
        "상록수·사당 pilot 실측 편차 검증은 2026-07-06 field-work 트랙으로 이관됐다(#1394 실측이 field-work 트랙 " +
        "이관 결정). 이 PR에서는 SKIPPED로 정직 기록한다.",
    },
  };
}

function buildCoverage({
  transfer,
  admittedTransferRules,
  selfLoopTransferRules,
  malformed,
  uniqueTransferStations,
  matchedTransferStations,
  transferRowTotal,
  carDoor,
  carDoorRowTotal,
  fixtureReflectedRuleCount,
}) {
  return {
    transfer: {
      description:
        "admittedRules는 station·line 매칭으로 rule을 생성한 행 수이고, quarantinedRows에는 이후 pathway edge 생성 " +
        "실패도 포함하므로 두 집계는 서로 배타적이지 않다. 따라서 각 분류의 합계가 totalRows를 초과할 수 있다.",
      totalRows: transferRowTotal,
      uniqueStationNames: uniqueTransferStations,
      malformedRows: malformed.length,
      admittedRules: admittedTransferRules.length,
      fixtureReflectedRules: {
        count: fixtureReflectedRuleCount,
        note:
          "importer는 사당 양방향(2→4/4→2)을 각각 rule로 산출하지만(admittedRules에 2건 포함), 팩에는 사당 방향쌍을 " +
          "기존 수기 정본 rule(transfer-sadang-seoul-4-to-seoul-2, 공식 62초로 갱신) 1건으로 유지한다. 따라서 " +
          "catalog-fixture.transferRules는 사당 1건 + 강남 1건 = 2건이다.",
      },
      admittedStations: [...matchedTransferStations].sort(compareText),
      selfLoopExcludedRules: selfLoopTransferRules.map((rule) => ({
        stationId: rule.fromStationId,
        fromLineId: rule.fromLineId,
        toLineId: rule.toLineId,
        reason: "from_line_id == to_line_id (무의미한 자기루프 — 적재 제외)",
      })),
      quarantinedRows: transfer.quarantine.length,
      quarantineReasonCounts: reasonCounts(transfer.quarantine),
    },
    carDoor: {
      totalRows: carDoorRowTotal,
      admittedHints: carDoor.stationCarDoorHints.length,
      admittedByStation: countBy(carDoor.stationCarDoorHints, (hint) => hint.stationId),
      duplicateRows: carDoor.duplicateReport.length,
      quarantinedRows: carDoor.quarantine.length,
      quarantineReasonCounts: reasonCounts(carDoor.quarantine),
    },
  };
}

// desk 게이트 ①: 적재 대상(매칭 성공)의 방향쌍 존재/불일치·중복 내부 정합.
function buildGateInternalConsistency(transfer, admittedTransferRules, selfLoopTransferRules) {
  return {
    description:
      "적재 대상(capital roster 매칭 성공분)의 방향쌍 존재/소요시간 불일치·중복을 리포트한다. capital 6역 스코프 " +
      "한정이라 전량 내부 정합은 roster 확장이 필요하며(비범위), 매칭 실패 전량 행은 coverage.quarantine으로 집계된다.",
    directionPairReport: transfer.directionPairReport.filter((row) => row.fromLineId !== row.toLineId),
    duplicateReport: transfer.duplicateReport,
    selfLoopExcluded: selfLoopTransferRules.map((rule) => ({
      stationId: rule.fromStationId,
      fromLineId: rule.fromLineId,
      toLineId: rule.toLineId,
    })),
    admittedRuleCount: admittedTransferRules.length,
  };
}

// desk 게이트 ②: KRIC 동선 존재 ↔ 환승소요시간 baseline 존재의 구조 정합(충무로 3↔4).
function buildGateKricStructuralAlignment(transferRows, kricMovement, kricMovementContext, kricStandardMovement) {
  const chungmuroBaseline = (transferRows ?? []).filter((row) => {
    if (row["환승역명"]?.trim() !== "충무로") return false;
    const direction = `${row["호선"]}->${row["환승노선"]}`;
    return direction === "3호선->4호선" || direction === "4호선->3호선";
  });
  const directionKeys = new Set(chungmuroBaseline.map((row) => `${row["호선"]}->${row["환승노선"]}`));
  const hasDirectionPair = directionKeys.has("3호선->4호선") && directionKeys.has("4호선->3호선");
  const hasExpectedBaselineValues =
    chungmuroBaseline.length === 2 &&
    chungmuroBaseline.every((row) => row["환승거리"] === 17 && row["환승소요시간"] === 14);
  const resultCode = kricMovement?.header?.resultCode ?? null;
  const steps = Array.isArray(kricMovement?.body) ? kricMovement.body.length : 0;
  const evidenceFailures = validateKricMovementEvidence(kricMovement, kricMovementContext);
  const admitted = resultCode === "00" && steps > 0 && evidenceFailures.length === 0;
  const standardResultCode = kricStandardMovement?.header?.resultCode ?? null;
  const standardSteps = Array.isArray(kricStandardMovement?.body) ? kricStandardMovement.body.length : 0;
  return {
    description:
      "충무로역 KRIC 동선(3호선↔4호선 detailed tuple) 존재와 환승소요시간 baseline 충무로(3↔4, 17m/00:14) 존재의 " +
      "구조 정합을 명시 기록한다.",
    kricStandardResult: {
      sourceId: KRIC_STANDARD_SOURCE_ID,
      status: kricStandardMovement ? "OBSERVED" : "SKIPPED",
      resultCode: standardResultCode,
      stepCount: standardSteps,
      reason: kricStandardMovement
        ? "입력된 standard response의 실제 resultCode와 body 행 수를 해석 없이 기록한다."
        : "row-bearing standard response artifact가 제공되지 않아 resultCode를 추정하지 않고 SKIPPED 처리한다.",
    },
    kricMovementDetailed: {
      sourceId: KRIC_MOVEMENT_SOURCE_ID,
      resultCode,
      admitted,
      stepCount: steps,
      station: "충무로(3호선↔4호선)",
      requestContext: {
        endpoint: kricMovementContext?.endpoint ?? null,
        tuple: kricMovementContext?.requestTuple ?? null,
        admissionSnapshotId: kricMovementContext?.admission?.snapshotId ?? null,
      },
      evidenceValidation: {
        status: evidenceFailures.length === 0 ? "PASS" : "FAIL",
        failures: evidenceFailures,
        rawSha256: kricMovementContext?.liveSampleRawSha256 ?? null,
        evidenceHash: kricMovementContext?.liveSampleEvidenceHash ?? null,
      },
    },
    transferBaselineChungmuro: chungmuroBaseline.map((row) => ({
      호선: row["호선"],
      환승노선: row["환승노선"],
      환승거리: row["환승거리"],
      환승소요시간: row["환승소요시간"],
    })),
    structurallyAligned: admitted && hasDirectionPair && hasExpectedBaselineValues,
    note:
      "충무로 baseline은 capital 6역에 없으므로 팩에는 적재되지 않는다 — 전량 기준 교차검증 근거로만 리포트에 남긴다.",
  };
}

function validateKricMovementEvidence(kricMovement, context) {
  const failures = [];
  if (!context) return ["tracked detailed request context missing"];
  if (context.candidateId !== KRIC_MOVEMENT_SOURCE_ID) failures.push("candidateId mismatch");
  if (context.endpoint !== KRIC_DETAILED_ENDPOINT) failures.push("endpoint mismatch");
  if (context.sampleEndpoint !== KRIC_DETAILED_ENDPOINT) failures.push("sample URL endpoint mismatch");
  for (const [key, expected] of Object.entries(KRIC_CHUNGMURO_REQUEST_TUPLE)) {
    if (context.requestTuple?.[key] !== expected) failures.push(`request tuple mismatch: ${key}`);
  }

  const admission = context.admission;
  if (admission?.candidateId !== KRIC_MOVEMENT_SOURCE_ID) failures.push("admission candidateId mismatch");
  if (admission?.sourceId !== KRIC_MOVEMENT_SOURCE_ID) failures.push("admission sourceId mismatch");
  if (admission?.decision !== "APPROVED") failures.push("admission decision is not APPROVED");
  if (context.liveSampleRawSha256 !== admission?.rawSha256) failures.push("rawSha256 admission mismatch");
  if (context.liveSampleSchemaFingerprint !== admission?.schemaFingerprint) {
    failures.push("schemaFingerprint admission mismatch");
  }
  if (context.liveSampleEvidenceHash !== admission?.sampleEvidenceHash) {
    failures.push("sampleEvidenceHash admission mismatch");
  }

  const rows = Array.isArray(kricMovement?.body) ? kricMovement.body : [];
  if (rows.length !== context.liveSampleRowCount) failures.push("response row count mismatch");
  const expectedFields = [...(context.liveSampleFields ?? [])].sort(compareText);
  if (
    expectedFields.length === 0 ||
    rows.some(
      (row) =>
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        JSON.stringify(Object.keys(row).sort(compareText)) !== JSON.stringify(expectedFields),
    )
  ) {
    failures.push("response field schema mismatch");
  }
  if (context.liveSampleFormat !== "xml") failures.push("live sample format is not xml");
  const providerRecordHashes = rows.map((row) => sha256(JSON.stringify(normalizeKricXmlRow(row))));
  const sampleEvidence = {
    candidateId: context.candidateId,
    endpoint: context.endpoint,
    format: context.liveSampleFormat,
    fields: context.liveSampleFields,
    rowCount: rows.length,
    rawSha256: context.liveSampleRawSha256,
    schemaFingerprint: context.liveSampleSchemaFingerprint,
    credentialRedacted: true,
    providerRecordHashes,
  };
  if (sha256(JSON.stringify(sampleEvidence)) !== context.liveSampleEvidenceHash) {
    failures.push("response content evidenceHash mismatch");
  }
  return failures;
}

function normalizeKricXmlRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return {};
  return Object.fromEntries(
    Object.entries(row)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, value]) => [key, value == null ? null : String(value)]),
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// desk 게이트 ③: timeSource 구분. baseline edge의 provenance_kind는 OFFICIAL_SOURCE로 고정된다.
export function buildGateTimeSourceDistinction(transfer, fixtureTransferRules, existingEdges) {
  const existingEdgesById = new Map(existingEdges.map((edge) => [edge.id, edge]));
  const officialRules = fixtureTransferRules.filter((rule) => rule.sourceId === TRANSFER_SOURCE_ID);
  const referencedExistingEdges = officialRules
    .filter((rule) => rule.pathwayEdgeId)
    .map((rule) => ({ rule, edge: existingEdgesById.get(rule.pathwayEdgeId) ?? null }));
  // pathwayEdgeId가 없는 공식 rule(예: 강남)은 플랫폼 노드 부재로 pathway edge가 애초에 생성되지 않는
  // 기지의 한계다 — 검증 대상에서 조용히 빼지 않고 edgeMissing으로 명시 기록한다.
  const edgeMissing = officialRules
    .filter((rule) => !rule.pathwayEdgeId)
    .map((rule) => ({
      ruleId: rule.id,
      reason:
        "이 rule이 연결하는 역에 플랫폼 노드가 없어 pathway edge가 생성되지 않는 기지의 한계다 — " +
        "edge 실검증 대상에서 제외하고 이 사실만 명시 기록한다(조용히 빼지 않는다).",
    }));
  const rulesByEdgeId = new Map(
    transfer.transferRules.filter((rule) => rule.pathwayEdgeId).map((rule) => [rule.pathwayEdgeId, rule]),
  );
  const generatedEdges = transfer.stationPathwayEdges.map((edge) => ({
    rule: rulesByEdgeId.get(edge.id) ?? null,
    edge,
  }));
  const edgeChecks = [...generatedEdges, ...referencedExistingEdges].map(({ rule, edge }) => {
    const failures = [];
    if (!edge) {
      failures.push("referenced pathway edge missing");
    } else {
      if (edge.provenanceKind !== "OFFICIAL_SOURCE") failures.push("provenanceKind is not OFFICIAL_SOURCE");
      if (edge.sourceId !== TRANSFER_SOURCE_ID) failures.push("sourceId does not match official transfer source");
      if (edge.sourceSnapshotId !== TRANSFER_SNAPSHOT_ID) {
        failures.push("sourceSnapshotId does not match admitted transfer snapshot");
      }
      if (
        rule &&
        Number.isInteger(rule.minTransferSeconds) &&
        edge.durationSeconds !== rule.minTransferSeconds
      ) {
        failures.push("edge durationSeconds does not match rule minTransferSeconds");
      }
    }
    return {
      edgeId: edge?.id ?? rule?.pathwayEdgeId ?? null,
      ruleId: rule?.id ?? null,
      provenanceKind: edge?.provenanceKind ?? null,
      failures,
    };
  });
  const failedEdges = edgeChecks.filter((check) => check.failures.length > 0);
  const status =
    edgeChecks.length === 0 && edgeMissing.length === 0
      ? "SKIPPED"
      : failedEdges.length === 0
        ? "PASS"
        : "FAIL";
  const provenanceKinds = [...new Set(edgeChecks.map((check) => check.provenanceKind).filter(Boolean))].sort(compareText);
  return {
    description:
      "station_pathway_edges 스키마의 provenance_kind가 OFFICIAL_SOURCE(공식 baseline)와 거리기반 추정류를 구분하는 " +
      "축이다. importer가 baseline edge에 provenanceKind:OFFICIAL_SOURCE를 고정하는 것을 node --test로 고정했다 " +
      "(import-transfer-baseline.test.mjs).",
    provenanceKindAxis: "OFFICIAL_SOURCE",
    status,
    baselineEdgeCount: edgeChecks.length,
    baselineEdgeProvenanceKinds: provenanceKinds,
    edgeChecks,
    edgeMissing,
    note:
      "신규 생성 edge와 공식 baseline rule이 참조하는 기존 pathway edge를 함께 검사한다. pathwayEdgeId가 없는 공식 " +
      "rule은 edgeMissing에 명시 기록하고 edge 실검증에서는 제외한다(조용히 빼지 않는다). 연결 edge와 " +
      "edgeMissing이 모두 없으면 SKIPPED, 모든 연결 edge의 source·snapshot·OFFICIAL_SOURCE provenance가 유효하고 " +
      "edgeMissing으로 명시된 rule 외에 빠진 rule이 없으면 PASS, 연결 edge 중 하나라도 검증에 실패하면 FAIL이다.",
  };
}

function reasonCounts(quarantine) {
  return countBy(quarantine, (entry) => String(entry.reason).replace(/:.*$/, "").trim());
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function compareText(left, right) {
  return String(left).localeCompare(String(right));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
