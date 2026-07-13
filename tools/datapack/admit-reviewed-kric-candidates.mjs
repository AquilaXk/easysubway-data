#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { sortJson } from "./lib/ledger-admission-cli.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const APPROVED_AT = "2026-07-13T22:30:00+09:00";

const REVIEWED_KRIC_CANDIDATE_IDS = Object.freeze([
  "kric-subway-route-info",
  "kric-station-info",
  "kric-train-operation-organ",
  "kric-station-transfer-info",
  "kric-station-platform",
  "kric-station-movement-standard",
  "kric-station-movement-detailed",
  "kric-station-convenience-standard",
]);

const COVERAGE_BY_DOMAIN = Object.freeze({
  station_line_membership: "도시철도 운영기관·노선·역 구성과 기본 역사정보",
  transfer_structure: "역사별 환승 노선과 환승 구조 정보",
  accessibility_platform: "승강장 유형·방향과 교통약자 이동 보조 정보",
  indoor_movement_paths: "역사 출입구·승강장 이동경로 단계와 승강기 정보",
  accessibility_facilities: "역사·차량 편의시설과 교통약자 편의정보",
});

const INVENTORY_DOMAIN_BY_CANDIDATE_DOMAIN = Object.freeze({
  accessibility_platform: "accessibility_facilities",
  transfer_structure: "route_graph_topology",
});

const VERIFIED_SAMPLE_SCOPE_BY_CANDIDATE_ID = Object.freeze({
  "kric-subway-route-info": {
    regionIds: ["capital"],
    operatorIds: ["airport-railroad"],
    query: { mreaWideCd: "01", lnCd: "A1" },
  },
  "kric-station-info": {
    regionIds: ["capital"],
    operatorIds: ["korail"],
    query: { railOprIsttCd: "KR", stinNm: "용산" },
  },
  "kric-train-operation-organ": {
    regionIds: ["daejeon"],
    operatorIds: ["daejeon-transportation"],
    query: { railOprIsttCd: "DJ" },
  },
  "kric-station-transfer-info": {
    regionIds: ["capital"],
    operatorIds: ["seoul-metro"],
    query: { railOprIsttCd: "S1" },
  },
  "kric-station-platform": {
    regionIds: ["capital"],
    operatorIds: ["seoul-metro"],
    query: { railOprIsttCd: "S1" },
  },
  "kric-station-movement-standard": {
    regionIds: ["capital"],
    operatorIds: ["seoul-metro"],
    query: { railOprIsttCd: "S1" },
  },
  "kric-station-movement-detailed": {
    regionIds: ["capital"],
    operatorIds: ["seoul-metro"],
    query: { railOprIsttCd: "S1" },
  },
  "kric-station-convenience-standard": {
    regionIds: ["capital"],
    operatorIds: ["seoul-metro"],
    query: { railOprIsttCd: "S1" },
  },
});

function buildReviewedKricAdmission({ candidates, inventory }) {
  const nextCandidates = structuredClone(candidates);
  const nextInventory = structuredClone(inventory);
  const ledgerEvidence = requireLedgerEvidence(nextInventory);

  for (const candidateId of REVIEWED_KRIC_CANDIDATE_IDS) {
    const candidate = requireCandidate(nextCandidates, candidateId);
    assertValidatedLiveSample(candidate);
    const source = buildInventorySource({ candidate, ledgerEvidence });
    nextInventory.sources = nextInventory.sources.filter(({ id }) => id !== candidateId);
    nextInventory.sources.push(source);
    applyApprovedReview(candidate, source);
  }
  const sourceInventorySha256 = canonicalBatchInventoryHash(nextInventory);
  for (const candidateId of REVIEWED_KRIC_CANDIDATE_IDS) {
    const source = nextInventory.sources.find(({ id }) => id === candidateId);
    source.admissionEvidence.sourceInventorySha256 = sourceInventorySha256;
  }

  const standard = requireCandidate(nextCandidates, "kric-transfer-movement-standard");
  standard.evidence.adminReview = {
    artifactKind: "source-admission-admin-review-summary",
    decision: "REJECTED_NO_DATA",
    approvedBy: "AquilaXk",
    approvedAt: APPROVED_AT,
    scope: "PRODUCTION_INVENTORY_ADMISSION",
    productionUseAllowed: false,
    reasonKo: "승인된 handicapped/transferMovement key 경로에서 공식 요청변수 표 tuple(run 29251592781)과 공식 sample URL tuple(run 29252661883)을 각각 Node process.env 경로로 호출했으나 모두 HTTP 200, XML, resultCode=03, itemCount=0을 반환했다. row-bearing evidence가 없어 production inventory admission을 거부한다.",
  };
  standard.nextAction = "admin review에서 no-data로 production inventory admission을 거부했다. KRIC가 row-bearing 공식 tuple 또는 데이터 정정을 제공할 때만 새 evidence로 재심사하며, 그 전에는 automaticRouteGraphEdgeAllowed=false를 유지한다";

  return { candidates: nextCandidates, inventory: nextInventory };
}

function buildInventorySource({ candidate, ledgerEvidence }) {
  const license = {
    type: "KOGL-1",
    name: "공공누리 1유형",
    attribution: "공공누리 제1유형: 출처표시",
    commercialUseAllowed: true,
    derivativeWorkAllowed: true,
    redistributionAllowed: true,
    evidenceUrl: candidate.detailUrl,
  };
  const retrievedAt = candidate.evidence.liveSampleRetrievedAt.slice(0, 10);
  const baseSource = {
    id: candidate.id,
    displayName: candidate.displayName,
    owner: "국가철도공단",
    provider: "국가철도공단",
    providerDepartment: "철도산업정보센터",
    sourceSystem: "KRIC OpenAPI",
    datasetUrl: candidate.detailUrl,
    datasetKind: "open-api",
    coverage: COVERAGE_BY_DOMAIN[candidate.domain] ?? `${candidate.displayName} 공식 OpenAPI`,
    coverageScope: verifiedSampleCoverageScope(candidate),
    requiredForProductionPack: false,
    productionUseAllowed: false,
    updateFrequency: "provider documented; production cadence not admitted",
    observedDataUpdatedAt: retrievedAt,
    retrievedAt,
    license,
    fieldsProvided: [...candidate.evidence.liveSampleFields],
    capabilities: buildCapabilities(candidate),
  };
  const snapshotBasis = {
    candidateId: candidate.id,
    retrievedAt: candidate.evidence.liveSampleRetrievedAt,
    rowCount: candidate.evidence.liveSampleRowCount,
    rawSha256: candidate.evidence.liveSampleRawSha256,
    schemaFingerprint: candidate.evidence.liveSampleSchemaFingerprint,
    fields: candidate.evidence.liveSampleFields,
  };
  const reviewBasis = {
    candidateId: candidate.id,
    decision: "APPROVED",
    approvedBy: "AquilaXk",
    approvedAt: APPROVED_AT,
    scope: "INVENTORY_PROVENANCE_ONLY",
    productionUseAllowed: false,
    sampleEvidenceHash: candidate.evidence.liveSampleEvidenceHash,
    licenseEvidenceHash: sha256(JSON.stringify(sortJson(license))),
  };
  return {
    ...baseSource,
    admissionEvidence: {
      artifactKind: "source-admission-pipeline-evidence-summary",
      issue: 1397,
      candidateId: candidate.id,
      sourceId: candidate.id,
      snapshotId: `${candidate.id}-admin-review-20260713`,
      decision: "APPROVED",
      approvedBy: "AquilaXk",
      approvedAt: APPROVED_AT,
      sampleEvidenceHash: candidate.evidence.liveSampleEvidenceHash,
      rawSha256: candidate.evidence.liveSampleRawSha256,
      schemaFingerprint: candidate.evidence.liveSampleSchemaFingerprint,
      sourceSnapshotSetHash: sha256(JSON.stringify(sortJson(snapshotBasis))),
      adminReviewRecordHash: sha256(JSON.stringify(sortJson(reviewBasis))),
      licenseEvidenceHash: reviewBasis.licenseEvidenceHash,
      aliasLedgerHash: ledgerEvidence.aliasLedgerHash,
      operatorMappingLedgerHash: ledgerEvidence.operatorMappingLedgerHash,
      facilityEvidenceLedgerHash: ledgerEvidence.facilityEvidenceLedgerHash,
      routeEvidenceLedgerHash: ledgerEvidence.routeEvidenceLedgerHash,
      overrideHash: ledgerEvidence.overrideHash,
      admissionDurationSeconds: 0,
      quotaEvidence: {
        defaultDailyLimit: "unlimited",
        portal: "KRIC 레일포털",
        productionUseAllowed: false,
        unlockStatus: "not_required",
      },
      productionUseNoteKo: "오너 admin review(2026-07-13)로 inventory provenance에만 승격했다. consumer별 coverage·약관·품질 evidence가 확인되기 전에는 production pack과 runtime 호출에 사용하지 않는다.",
    },
  };
}

function verifiedSampleCoverageScope(candidate) {
  const scope = VERIFIED_SAMPLE_SCOPE_BY_CANDIDATE_ID[candidate.id];
  if (!scope) throw new Error(`${candidate.id} verified sample coverage scope is missing`);
  const sampleUrl = new URL(candidate.evidence.sampleUrl);
  for (const [name, expected] of Object.entries(scope.query)) {
    if (sampleUrl.searchParams.get(name) !== expected) {
      throw new Error(`${candidate.id}.evidence.sampleUrl ${name} must be ${expected}`);
    }
  }
  return {
    regionIds: [...scope.regionIds],
    operatorIds: [...scope.operatorIds],
    sourceDomains: [INVENTORY_DOMAIN_BY_CANDIDATE_DOMAIN[candidate.domain] ?? candidate.domain],
  };
}

function canonicalBatchInventoryHash(inventory) {
  const basis = structuredClone(inventory);
  for (const source of basis.sources) {
    if (REVIEWED_KRIC_CANDIDATE_IDS.includes(source.id)) {
      delete source.admissionEvidence.sourceInventorySha256;
    }
  }
  return sha256(JSON.stringify(sortJson(basis)));
}

function buildCapabilities(candidate) {
  const facilityCandidate = new Set([
    "transfer_structure",
    "accessibility_platform",
    "indoor_movement_paths",
    "accessibility_facilities",
  ]).has(candidate.domain);
  return {
    schedule: {
      status: "UNSUPPORTED",
      productionUseAllowed: false,
      coverageStatus: "NOT_PROVIDED_BY_SOURCE",
      updateFrequency: "provider documented; production cadence not admitted",
      unsupportedNotes: "source is not admitted as production scheduled timetable data",
    },
    realtime: {
      status: "UNSUPPORTED",
      productionUseAllowed: false,
      liveEtaEligible: false,
      rateLimitStatus: "NOT_APPLICABLE",
      coverageStatus: "NOT_PROVIDED_BY_SOURCE",
      updateFrequency: "provider documented; production cadence not admitted",
      unsupportedNotes: "source is not admitted as production realtime arrival data",
    },
    facility: {
      status: facilityCandidate ? "CANDIDATE" : "UNSUPPORTED",
      productionUseAllowed: false,
      coverageStatus: facilityCandidate ? "CONSUMER_EVIDENCE_REQUIRED" : "NOT_PROVIDED_BY_SOURCE",
      updateFrequency: "provider documented; production cadence not admitted",
      unsupportedNotes: "inventory provenance admission only; consumer-specific coverage and quality evidence is still required before production use",
    },
  };
}

function applyApprovedReview(candidate, source) {
  candidate.admissionStatus = "admitted_to_production_inventory";
  candidate.productionInventoryReferenceId = candidate.id;
  candidate.productionInventoryRelationship = "inventory_provenance_only_admin_reviewed_for_1397";
  candidate.evidence.adminReview = {
    artifactKind: "source-admission-admin-review-summary",
    decision: "APPROVED",
    approvedBy: "AquilaXk",
    approvedAt: APPROVED_AT,
    scope: "INVENTORY_PROVENANCE_ONLY",
    productionUseAllowed: false,
    sampleEvidenceHash: candidate.evidence.liveSampleEvidenceHash,
    adminReviewRecordHash: source.admissionEvidence.adminReviewRecordHash,
  };
  candidate.evidence.missingEvidence = (candidate.evidence.missingEvidence ?? []).filter(
    (item) => item !== "adminAdmissionEvidence",
  );
  candidate.nextAction = `source admin review와 inventory provenance 승격 완료(오너 승인 2026-07-13). ${consumerIssue(candidate.domain)}에서 coverage·품질·provider operation 승인 근거를 확인하기 전에는 productionUseAllowed=false를 유지한다`;
}

function consumerIssue(domain) {
  if (domain === "station_line_membership") return "#1400";
  return "#1701";
}

function requireLedgerEvidence(inventory) {
  const source = inventory.sources.find(({ id }) => id === "kric-transfer-movement-detailed");
  const evidence = source?.admissionEvidence;
  if (!evidence) throw new Error("reviewed KRIC ledger evidence source is missing");
  return evidence;
}

function requireCandidate(candidates, candidateId) {
  const candidate = candidates.candidates.find(({ id }) => id === candidateId);
  if (!candidate) throw new Error(`candidate not found: ${candidateId}`);
  return candidate;
}

function assertValidatedLiveSample(candidate) {
  if (candidate.sampleEvidenceStatus !== "validated_live_sample") {
    throw new Error(`${candidate.id} must have validated_live_sample`);
  }
  for (const field of ["liveSampleEvidenceHash", "liveSampleRawSha256", "liveSampleSchemaFingerprint"] ) {
    if (!/^[0-9a-f]{64}$/.test(candidate.evidence[field] ?? "")) {
      throw new Error(`${candidate.id}.evidence.${field} must be sha256`);
    }
  }
  if (!Array.isArray(candidate.evidence.liveSampleFields) || candidate.evidence.liveSampleFields.length === 0) {
    throw new Error(`${candidate.id}.evidence.liveSampleFields is required`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function main() {
  const candidatesPath = path.join(root, "tools/datapack/source-candidates.json");
  const inventoryPath = path.join(root, "tools/datapack/source-inventory.json");
  const mobileInventoryPath = path.join(root, "apps/mobile/assets/datapacks/source-inventory.json");
  const [candidates, inventory] = await Promise.all(
    [candidatesPath, inventoryPath].map(async (filePath) => JSON.parse(await readFile(filePath, "utf8"))),
  );
  const result = buildReviewedKricAdmission({ candidates, inventory });

  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
  await Promise.all([
    writeFile(candidatesPath, json(result.candidates)),
    writeFile(inventoryPath, json(result.inventory)),
    writeFile(mobileInventoryPath, json(result.inventory)),
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

export { buildReviewedKricAdmission, REVIEWED_KRIC_CANDIDATE_IDS };
