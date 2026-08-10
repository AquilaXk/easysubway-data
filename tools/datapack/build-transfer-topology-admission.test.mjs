import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildTransferTopologyAdmission,
  canonicalTransferTopologyAdmissionJson,
} from "./build-transfer-topology-admission.mjs";
import { materializeStationLineAccessibility } from "./materialize-station-line-accessibility.mjs";

const CAPTURED_AT = "2026-08-09T00:00:00.000Z";
const FRESH_UNTIL = "2026-08-11T00:00:00.000Z";
const OBSERVED_AT = "2026-08-10T00:00:00.000Z";
const TRUSTED_PROVIDER_CATALOG = JSON.parse(readFileSync(
  new URL("./sources/kric-provider-code-catalog-20260228.json", import.meta.url),
));

test("current non-production MOLIT topology는 joined를 BLOCKED_WITH_EVIDENCE로 분류하고 materializer에 넘기지 않는다", () => {
  const input = validInput();

  const result = buildTransferTopologyAdmission(input);

  assert.equal(result.decision, "NO_GO");
  assert.deepEqual(result.cells.map(({ stationLineId, state, applicabilityReason }) => ({
    stationLineId, state, applicabilityReason,
  })), [{
    stationLineId: "station-a:line-1",
    state: "BLOCKED_WITH_EVIDENCE",
    applicabilityReason: "SOURCE_NOT_PRODUCTION_ADMITTED",
  }, {
    stationLineId: "station-b:line-2",
    state: "MISSING",
    applicabilityReason: "OFFICIAL_TRANSFER_TOPOLOGY_MISSING",
  }]);
  assert.deepEqual(result.stateSummary, {
    ADMITTED_NOT_APPLICABLE: 0,
    ADMITTED_TRANSFER_TOPOLOGY: 0,
    BLOCKED_WITH_EVIDENCE: 1,
    MISSING: 1,
    STALE: 0,
    UNKNOWN: 0,
  });
  assert.deepEqual(result.materializerEvidenceRows, []);
  assert.equal(result.tuplePartition.summary.joinedTupleCount, 1);
  assert.equal(result.tuplePartition.summary.unmatchedTupleCount, 0);
  assert.equal(result.tuplePartition.summary.ambiguousTupleCount, 0);
  for (const cell of result.cells) {
    assert.deepEqual(Object.keys(cell).sort(), [
      "applicabilityReason", "candidateId", "capturedAt", "domain", "freshUntil", "licenseId",
      "lineId", "mappingContractVersion", "materializerVersion", "normalizedEvidenceSha256",
      "operatorId", "providerRecordHash", "provenanceId", "rawEvidenceSha256", "sourceId",
      "sourceSetSha256", "sourceSnapshotId", "state", "stationId", "stationLineId",
      "stationLineSetSha256", "stationSetSha256", "topologySourceIdentitySha256",
    ].sort());
    assert.match(cell.topologySourceIdentitySha256, /^[a-f0-9]{64}$/);
    assert.match(cell.normalizedEvidenceSha256, /^[a-f0-9]{64}$/);
  }
  assert.match(result.admissionDigest, /^[a-f0-9]{64}$/);
});

test("fresh production-admitted joined topology만 exact Data #8 materializer evidence가 된다", () => {
  const input = validInput();
  input.stationLines = [input.stationLines[0]];
  refreshStationLineBindings(input);
  promoteSourceForTest(input);

  const result = buildTransferTopologyAdmission(input);

  assert.equal(result.decision, "GO");
  assert.equal(result.cells[0].state, "ADMITTED_TRANSFER_TOPOLOGY");
  assert.equal(result.cells[0].applicabilityReason, "OFFICIAL_TRANSFER_TOPOLOGY_PRESENT");
  assert.deepEqual(result.materializerEvidenceRows, [{
    candidateId: input.candidate.candidateId,
    stationSetSha256: input.candidate.stationSetSha256,
    sourceSetSha256: input.candidate.sourceSetSha256,
    stationId: "station-a",
    lineId: "line-1",
    operatorId: "operator-1",
    domain: "TRANSFER",
    state: "VERIFIED_PRESENT",
    sourceId: input.snapshot.sourceId,
    sourceSnapshotId: input.snapshot.snapshotId,
    evidenceRawSha256: input.snapshot.rawSha256,
    providerRecordHash: result.cells[0].providerRecordHash,
    capturedAt: CAPTURED_AT,
    freshUntil: FRESH_UNTIL,
    provenanceId: result.topologySourceIdentity.provenanceId,
    licenseId: result.topologySourceIdentity.licenseId,
    mappingContractVersion: input.candidate.mappingContractVersion,
    materializerVersion: input.candidate.materializerVersion,
    evidenceKind: "OBSERVED",
    evidenceReason: "OFFICIAL_TRANSFER_TOPOLOGY_PRESENT",
  }]);
  const materialized = materializeStationLineAccessibility({
    candidate: input.candidate,
    stationLines: input.stationLines.map(({ stationId, lineId, operatorId }) => ({ stationId, lineId, operatorId })),
    evidenceRows: result.materializerEvidenceRows,
    observedAt: input.observedAt,
  });
  assert.equal(materialized.rows.find(({ domain }) => domain === "TRANSFER").state, "VERIFIED_PRESENT");
});

test("expired source는 row omission과 joined 여부를 성공으로 바꾸지 않고 모든 cell을 STALE로 만든다", () => {
  const input = validInput();
  input.observedAt = FRESH_UNTIL;
  input.source.productionUseAllowed = true;

  const result = buildTransferTopologyAdmission(input);

  assert.deepEqual(result.cells.map(({ state }) => state), ["STALE", "STALE"]);
  assert.equal(result.stateSummary.STALE, 2);
  assert.equal(result.stateSummary.ADMITTED_NOT_APPLICABLE, 0);
  assert.equal(result.decision, "NO_GO");
  assert.deepEqual(result.materializerEvidenceRows, []);
});

test("unmatched와 ambiguous topology는 partition에 남고 NOT_APPLICABLE로 추정되지 않는다", () => {
  const input = validInput();
  input.stationLines = [{
    ...input.stationLines[0],
    stationId: "station-a2",
  }, input.stationLines[0]];
  refreshStationLineBindings(input);

  const result = buildTransferTopologyAdmission(input);

  assert.equal(result.tuplePartition.summary.ambiguousTupleCount, 1);
  assert.equal(result.tuplePartition.summary.joinedTupleCount, 0);
  assert.deepEqual(result.cells.map(({ state }) => state), ["MISSING", "MISSING"]);
  assert.equal(result.stateSummary.ADMITTED_NOT_APPLICABLE, 0);
  assert.equal(result.decision, "NO_GO");
});

test("서로 다른 provider tuple이 같은 canonical station-line에 결속되면 fail closed한다", () => {
  const input = validInput();
  input.stationLines = [input.stationLines[0]];
  refreshStationLineBindings(input);
  input.snapshot.rows.push({
    ...input.snapshot.rows[0],
    LN_NM: "수도권 4호선",
    CHTN_MV_TP_ORDR: "2",
  });
  refreshSyntheticSnapshotBindings(input);

  assert.throws(() => buildTransferTopologyAdmission(input), /duplicate transfer topology mapping/);
});

test("candidate station-line/source set과 locked source/snapshot identity mismatch는 fail closed한다", () => {
  const stationMismatch = validInput();
  stationMismatch.candidate.stationSetSha256 = "0".repeat(64);
  assert.throws(() => buildTransferTopologyAdmission(stationMismatch), /station set identity mismatch/);

  const lineOmission = validInput();
  lineOmission.stationLines = [{ ...lineOmission.stationLines[0] }, {
    ...lineOmission.stationLines[0],
    lineId: "line-1b",
    lineName: "5호선",
  }];
  refreshStationLineBindings(lineOmission);
  lineOmission.stationLines.pop();
  assert.throws(() => buildTransferTopologyAdmission(lineOmission), /station-line denominator identity mismatch/);

  const snapshotMismatch = validInput();
  snapshotMismatch.snapshot.rawSha256 = "0".repeat(64);
  assert.throws(() => buildTransferTopologyAdmission(snapshotMismatch), /snapshot metadata rawSha256 mismatch/);

  const sourceSetMismatch = validInput();
  sourceSetMismatch.candidate.sourceSetSha256 = "0".repeat(64);
  assert.throws(() => buildTransferTopologyAdmission(sourceSetMismatch), /source snapshot set identity mismatch/);

  const membershipMismatch = validInput();
  membershipMismatch.sourceSnapshots[0].snapshotId = "another-snapshot";
  membershipMismatch.candidate.sourceSetSha256 = sha256(JSON.stringify(membershipMismatch.sourceSnapshots));
  assert.throws(() => buildTransferTopologyAdmission(membershipMismatch), /source snapshot membership mismatch/);

  const admissionMismatch = validInput();
  promoteSourceForTest(admissionMismatch);
  admissionMismatch.source.admissionEvidence.sourceSnapshotSetHash = "0".repeat(64);
  assert.throws(() => buildTransferTopologyAdmission(admissionMismatch), /production admission evidence mismatch/);
});

test("canonical station-line mapping과 다른 역명은 candidate identity 아래 admission될 수 없다", () => {
  const input = validInput();
  input.stationLines[0].stationName = "변조된 사당";

  assert.throws(() => buildTransferTopologyAdmission(input), /station-line mapping identity mismatch/);
});

test("production source scope 밖의 joined station-line은 blocked이고 materializer evidence가 아니다", () => {
  const input = validInput();
  input.stationLines = [input.stationLines[0]];
  refreshStationLineBindings(input);
  promoteSourceForTest(input);
  input.source.coverageScope.regionIds = ["outside-capital"];

  const result = buildTransferTopologyAdmission(input);

  assert.equal(result.decision, "NO_GO");
  assert.equal(result.cells[0].state, "BLOCKED_WITH_EVIDENCE");
  assert.equal(result.cells[0].applicabilityReason, "SOURCE_COVERAGE_SCOPE_MISMATCH");
  assert.deepEqual(result.materializerEvidenceRows, []);
});

test("observedAt 이후 승인된 source는 production admission이 아니다", () => {
  const input = validInput();
  promoteSourceForTest(input);
  input.source.admissionEvidence.approvedAt = "2026-08-10T00:00:00.001Z";

  assert.throws(() => buildTransferTopologyAdmission(input), /production admission approval is future-dated/);
});

test("self-consistent hash여도 다른 snapshot metadata schema와 artifact kind는 거부한다", () => {
  const wrongVersion = validInput();
  wrongVersion.snapshot.metadata.schemaVersion = 2;
  wrongVersion.snapshot.metadataFileSha256 = metadataFileSha256(wrongVersion.snapshot.metadata);
  assert.throws(() => buildTransferTopologyAdmission(wrongVersion), /snapshot metadata schema mismatch/);

  const wrongKind = validInput();
  wrongKind.snapshot.metadata.artifactKind = "another-snapshot-metadata";
  wrongKind.snapshot.metadataFileSha256 = metadataFileSha256(wrongKind.snapshot.metadata);
  assert.throws(() => buildTransferTopologyAdmission(wrongKind), /snapshot metadata schema mismatch/);
});

test("같은 source와 snapshot identity의 상충 sourceSnapshots entry는 거부한다", () => {
  const input = validInput();
  input.sourceSnapshots.push({
    ...input.sourceSnapshots[0],
    rawSha256: "0".repeat(64),
  });
  input.candidate.sourceSetSha256 = sha256(JSON.stringify(input.sourceSnapshots));

  assert.throws(() => buildTransferTopologyAdmission(input), /duplicate source snapshot identity/);
});

test("alias, catalog 변조, unbound row content는 admission evidence가 아니다", () => {
  for (const providerStationName of ["이수", "사당역"]) {
    const nonExactName = validInput();
    nonExactName.stationLines[0].stationAliases = ["이수"];
    refreshStationLineBindings(nonExactName);
    nonExactName.snapshot.rows[0].STIN_NM = providerStationName;
    refreshSyntheticSnapshotBindings(nonExactName);
    const nonExactResult = buildTransferTopologyAdmission(nonExactName);
    assert.equal(nonExactResult.tuplePartition.summary.joinedTupleCount, 0);
    assert.equal(nonExactResult.tuplePartition.summary.unmatchedTupleCount, 1);
    assert.equal(nonExactResult.cells[0].state, "MISSING");
  }

  const catalogTamper = validInput();
  catalogTamper.providerCodeCatalog.providerLines[0].lineName = "변조";
  assert.throws(() => buildTransferTopologyAdmission(catalogTamper), /catalog canonical content hash/);

  const contentTamper = validInput();
  contentTamper.snapshot.rows[0].MV_CONT_DTL = "변조된 환승통로";
  assert.throws(() => buildTransferTopologyAdmission(contentTamper), /snapshot sorted content hash mismatch/);
});

test("rawSnapshotAdmission source는 production 상태를 변조해도 blocked다", () => {
  const input = validInput();
  input.stationLines = [input.stationLines[0]];
  refreshStationLineBindings(input);
  input.source.productionUseAllowed = true;
  input.source.capabilities.facility.status = "SUPPORTED";
  input.source.capabilities.facility.productionUseAllowed = true;
  input.source.capabilities.facility.coverageStatus = "SOURCE_INVENTORY_COVERED";

  const result = buildTransferTopologyAdmission(input);

  assert.equal(result.cells[0].state, "BLOCKED_WITH_EVIDENCE");
  assert.equal(result.decision, "NO_GO");
  assert.deepEqual(result.materializerEvidenceRows, []);
});

test("canonical output과 admission digest는 station-line/source-row 입력 순서에 무관하다", () => {
  const firstInput = validInput();
  const secondInput = validInput();
  secondInput.stationLines.reverse();
  secondInput.snapshot.rows.reverse();

  const first = buildTransferTopologyAdmission(firstInput);
  const second = buildTransferTopologyAdmission(secondInput);

  assert.equal(canonicalTransferTopologyAdmissionJson(first), canonicalTransferTopologyAdmissionJson(second));
  assert.equal(first.admissionDigest, second.admissionDigest);
});

function validInput() {
  const stationLines = [{
    stationId: "station-a",
    stationName: "사당",
    stationAliases: [],
    regionId: "capital",
    lineId: "line-1",
    lineName: "4호선",
    operatorId: "operator-1",
    operatorName: "서울교통공사",
  }, {
    stationId: "station-b",
    stationName: "종점",
    stationAliases: [],
    regionId: "capital",
    lineId: "line-2",
    lineName: "5호선",
    operatorId: "operator-1",
    operatorName: "서울교통공사",
  }];
  const snapshot = {
    sourceId: "molit-railway-transfer-movement",
    snapshotId: "molit-railway-transfer-movement-20250811",
    rawSha256: sha256("raw"),
    gzipSha256: sha256("gzip"),
    metadataFileSha256: "",
    sourceInventoryFileSha256: sha256("inventory-file"),
    sourceInventorySha256: sha256("inventory-canonical"),
    candidateBuildSpecSourceInventorySha256: sha256("inventory-canonical"),
    capturedAt: CAPTURED_AT,
    freshUntil: FRESH_UNTIL,
    rowCount: 1,
    rows: [{
      RAIL_OPR_ISTT_CD: "S1(서울교통공사)",
      LN_NM: "4호선",
      STIN_NM: "사당",
      CHTN_MV_TP_ORDR: "1",
      MV_CONT_DTL: "환승통로",
      CHTN_MV_CONT: "승강장 이동",
    }],
  };
  snapshot.metadata = {
    schemaVersion: 1,
    artifactKind: "molit-railway-transfer-movement-snapshot-metadata",
    sourceId: snapshot.sourceId,
    snapshotId: snapshot.snapshotId,
    capturedAt: snapshot.capturedAt,
    freshUntil: snapshot.freshUntil,
    rawSha256: snapshot.rawSha256,
    gzipSha256: snapshot.gzipSha256,
    sortedContentSha256: sortedContentSha256(snapshot.rows),
    rowCount: snapshot.rowCount,
  };
  snapshot.metadataFileSha256 = metadataFileSha256(snapshot.metadata);
  const sourceSnapshots = [{
    sourceId: snapshot.sourceId,
    snapshotId: snapshot.snapshotId,
    rawSha256: snapshot.rawSha256,
  }];
  return {
    candidate: {
      candidateId: "candidate-capital",
      stationSetSha256: stationSetSha256(stationLines),
      sourceSetSha256: sha256(JSON.stringify(sourceSnapshots)),
      mappingContractVersion: "transfer-topology-v1",
      materializerVersion: "1",
    },
    stationLineMappingSha256: stationLineMappingSha256(stationLines),
    stationLineSetSha256: stationLineSetSha256(stationLines),
    sourceSnapshots,
    stationLines,
    source: {
      id: snapshot.sourceId,
      displayName: "국토교통부 철도역 환승 이동경로 정보",
      owner: "국토교통부",
      provider: "국토교통부",
      providerDepartment: "철도정책과",
      sourceSystem: "공공데이터포털",
      datasetUrl: "https://www.data.go.kr/data/15130556/fileData.do",
      datasetKind: "file-data",
      coverage: "전국 철도역 환승 이동경로",
      coverageScope: {
        mappingStatus: "UNMAPPED_RAW_SNAPSHOT",
        regionIds: [],
        operatorIds: [],
        sourceDomains: ["indoor_movement_paths"],
      },
      requiredForProductionPack: false,
      productionUseAllowed: false,
      updateFrequency: "annual snapshot",
      observedDataUpdatedAt: "2025-08-11",
      retrievedAt: "2026-07-29",
      fieldsProvided: [
        "RAIL_OPR_ISTT_CD", "LN_NM", "STIN_NM", "CHTN_MV_TP_ORDR", "MV_CONT_DTL", "CHTN_MV_CONT",
      ],
      capabilities: {
        schedule: { status: "UNSUPPORTED", productionUseAllowed: false },
        realtime: { status: "UNSUPPORTED", productionUseAllowed: false },
        facility: {
          status: "CANDIDATE",
          productionUseAllowed: false,
          coverageStatus: "RAW_SNAPSHOT_ADMITTED",
        },
      },
      license: {
        type: "PUBLIC_DATA_FREE_USE",
        name: "이용허락범위 제한 없음",
        attribution: "국토교통부 철도역 환승 이동경로 정보",
        commercialUseAllowed: true,
        derivativeWorkAllowed: true,
        redistributionAllowed: true,
        evidenceUrl: "https://www.data.go.kr/data/15130556/fileData.do",
      },
      rawSnapshotAdmission: {
        snapshotId: snapshot.snapshotId,
        metadataPath: "tools/datapack/sources/molit-railway-transfer-movement-20250811.csv.gz.json",
        metadataFileSha256: snapshot.metadataFileSha256,
        rawSha256: snapshot.rawSha256,
        gzipSha256: snapshot.gzipSha256,
        rowCount: snapshot.rowCount,
        status: "LOCKED",
      },
    },
    snapshot,
    providerCodeCatalog: structuredClone(TRUSTED_PROVIDER_CATALOG),
    observedAt: OBSERVED_AT,
  };
}

function stationSetSha256(stationLines) {
  return sha256(JSON.stringify([...new Set(stationLines.map(({ stationId }) => stationId))].sort(compareBytes)));
}

function stationLineSetSha256(stationLines) {
  return sha256(JSON.stringify(stationLines.map(({ stationId, lineId, operatorId }) => ({
    lineId, operatorId, stationId,
  })).sort((left, right) => compareBytes(
    `${left.stationId}\0${left.lineId}\0${left.operatorId}`,
    `${right.stationId}\0${right.lineId}\0${right.operatorId}`,
  ))));
}

function stationLineMappingSha256(stationLines) {
  const mapping = stationLines.map(({
    lineId, lineName, operatorId, operatorName, regionId, stationAliases, stationId, stationName,
  }) => ({
    lineId,
    lineName,
    operatorId,
    operatorName,
    regionId,
    stationAliases: [...new Set(stationAliases)].sort(compareBytes),
    stationId,
    stationName,
  })).sort((left, right) => compareBytes(
    `${left.stationId}\0${left.lineId}\0${left.operatorId}`,
    `${right.stationId}\0${right.lineId}\0${right.operatorId}`,
  ));
  return sha256(JSON.stringify(mapping));
}

function refreshStationLineBindings(input) {
  input.candidate.stationSetSha256 = stationSetSha256(input.stationLines);
  input.stationLineSetSha256 = stationLineSetSha256(input.stationLines);
  input.stationLineMappingSha256 = stationLineMappingSha256(input.stationLines);
}

function refreshSyntheticSnapshotBindings(input) {
  const rowsJson = JSON.stringify(input.snapshot.rows);
  input.snapshot.rawSha256 = sha256(rowsJson);
  input.snapshot.gzipSha256 = sha256(`gzip:${rowsJson}`);
  input.snapshot.rowCount = input.snapshot.rows.length;
  Object.assign(input.snapshot.metadata, {
    rawSha256: input.snapshot.rawSha256,
    gzipSha256: input.snapshot.gzipSha256,
    sortedContentSha256: sortedContentSha256(input.snapshot.rows),
    rowCount: input.snapshot.rowCount,
  });
  input.snapshot.metadataFileSha256 = metadataFileSha256(input.snapshot.metadata);
  Object.assign(input.source.rawSnapshotAdmission, {
    metadataFileSha256: input.snapshot.metadataFileSha256,
    rawSha256: input.snapshot.rawSha256,
    gzipSha256: input.snapshot.gzipSha256,
    rowCount: input.snapshot.rowCount,
  });
  input.sourceSnapshots = [{
    sourceId: input.snapshot.sourceId,
    snapshotId: input.snapshot.snapshotId,
    rawSha256: input.snapshot.rawSha256,
  }];
  input.candidate.sourceSetSha256 = sha256(JSON.stringify(input.sourceSnapshots));
}

function promoteSourceForTest(input) {
  delete input.source.rawSnapshotAdmission;
  input.source.coverageScope = {
    regionIds: ["capital"],
    operatorIds: ["operator-1"],
    sourceDomains: ["indoor_movement_paths"],
  };
  input.source.productionUseAllowed = true;
  input.source.capabilities.facility.status = "SUPPORTED";
  input.source.capabilities.facility.productionUseAllowed = true;
  input.source.capabilities.facility.coverageStatus = "SOURCE_INVENTORY_COVERED";
  input.source.admissionEvidence = {
    artifactKind: "source-admission-pipeline-evidence-summary",
    issue: 27,
    candidateId: input.candidate.candidateId,
    sourceId: input.snapshot.sourceId,
    snapshotId: input.snapshot.snapshotId,
    decision: "APPROVED",
    approvedBy: "test-owner",
    approvedAt: OBSERVED_AT,
    sampleEvidenceHash: sha256("sample"),
    rawSha256: input.snapshot.rawSha256,
    schemaFingerprint: sha256("schema"),
    sourceSnapshotSetHash: input.candidate.sourceSetSha256,
    sourceInventorySha256: input.snapshot.sourceInventorySha256,
    adminReviewRecordHash: sha256("review"),
    licenseEvidenceHash: sha256("license"),
    aliasLedgerHash: sha256("alias"),
    operatorMappingLedgerHash: sha256("operator"),
    facilityEvidenceLedgerHash: sha256("facility"),
    routeEvidenceLedgerHash: sha256("route"),
    overrideHash: sha256("override"),
    admissionDurationSeconds: 0,
    quotaEvidence: {
      portal: "test",
      defaultDailyLimit: "unlimited",
      unlockStatus: "approved",
      productionUseAllowed: true,
    },
    productionUseNoteKo: "test-only admitted topology",
  };
}

function sortedContentSha256(rows) {
  return sha256(JSON.stringify([...rows].sort((left, right) => compareBytes(
    JSON.stringify(left), JSON.stringify(right),
  ))));
}

function metadataFileSha256(metadata) {
  return sha256(`${JSON.stringify(metadata, null, 2)}\n`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
