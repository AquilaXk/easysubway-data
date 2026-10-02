// 합성 전국 release-candidate 입력(#866 PR-B).
// 실제 커밋 데이터는 원천 갱신에 따라 authority 조건(환승 양끝 TRANSFER cell 닫힘)을 만족하지 못할 수 있다.
// 생산 게이트 회귀는 이 합성 fixture로 고정한다. live chain 모듈을 import하지 않는다.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonicalRideEdgeSetSha256, routeEdgeSha256 } from "../evaluate-route-accessibility-edges.mjs";

export const SYNTHETIC_NATIONWIDE_CAPTURED_AT = "2026-10-01T00:00:00.000Z";
const FRESH_UNTIL = "2026-10-08T00:00:00.000Z";
export const SYNTHETIC_NATIONWIDE_PATHS = Object.freeze({
  buildSpec: "tools/datapack/release/candidate-build-spec.json",
  fixture: "tools/datapack/release/nationwide-production-canonical-pack.json",
  preparation: "tools/datapack/release/nationwide-candidate-preparation.json",
  stationLineInput: "tools/datapack/release/nationwide-station-line-input.json",
  routeEdgeInput: "tools/datapack/release/nationwide-route-edge-input.json",
  transferMetrics: "tools/datapack/release/current-transfer-topology-metrics.json",
});

const CANDIDATE_ID = "nationwide-candidate-20261001-seq900";
const SCOPE_ID = "nationwide_routing_android_v1";
const SOURCE_SET = sha256("synthetic-nationwide-source-set");
const STATION_SET = sha256("synthetic-nationwide-station-set");
const LINES = [
  { id: "line-1", operatorId: "operator-x" },
  { id: "line-2", operatorId: "operator-y" },
  { id: "line-3", operatorId: "operator-z" },
];
// station-a: 역 안 환승(line-1↔line-2), station-b:line-1 ↔ station-c:line-3: 역 밖 환승, station-d: 환승 없음.
const STATION_LINES = [
  { stationId: "station-a", lineId: "line-1", lineSequence: 1 },
  { stationId: "station-a", lineId: "line-2", lineSequence: 1 },
  { stationId: "station-b", lineId: "line-1", lineSequence: 2 },
  { stationId: "station-c", lineId: "line-3", lineSequence: 1 },
  { stationId: "station-d", lineId: "line-2", lineSequence: 2 },
];
const TRANSFER_STATES = {
  "station-a:line-1": "VERIFIED_PRESENT",
  "station-a:line-2": "VERIFIED_PRESENT",
  "station-b:line-1": "VERIFIED_PRESENT",
  "station-c:line-3": "VERIFIED_PRESENT",
  "station-d:line-2": "NOT_APPLICABLE",
};
// 전국 실데이터와 같이 FACILITY 일부는 UNKNOWN(PROVIDER_NO_DATA)이다.
// #873: 경로는 승강장(역-노선)에서 시작해 승강장에서 끝난다. 전국 입력에는 EXIT 증거 행과 ENTRY/EXIT 간선이 없다.
const FACILITY_VERIFIED = new Set(["station-a:line-1", "station-a:line-2"]);

export function syntheticNationwideTransferEndpoints() {
  return Object.keys(TRANSFER_STATES).filter((key) => TRANSFER_STATES[key] !== "NOT_APPLICABLE");
}

export function buildSyntheticNationwideReleaseCandidate() {
  const operatorByLine = new Map(LINES.map(({ id, operatorId }) => [id, operatorId]));
  const candidate = {
    candidateId: CANDIDATE_ID,
    mappingContractVersion: "station-line-v1",
    materializerVersion: "1",
    sourceSetSha256: SOURCE_SET,
    stationSetSha256: STATION_SET,
  };
  const stationLines = STATION_LINES.map(({ stationId, lineId }) => ({
    stationId, lineId, operatorId: operatorByLine.get(lineId),
  }));
  const evidenceRows = stationLines.flatMap((line) => [
    evidence(candidate, line, "FACILITY", FACILITY_VERIFIED.has(key(line)) ? "VERIFIED_PRESENT" : "UNKNOWN"),
    evidence(candidate, line, "TRANSFER", TRANSFER_STATES[key(line)]),
  ]);
  const stationLineInput = { candidate, stationLines, evidenceRows };

  const rides = [
    routeEdge("ride-a1-b1", "RIDE", "station-a:line-1", "station-b:line-1", 120, 1000),
    routeEdge("ride-b1-a1", "RIDE", "station-b:line-1", "station-a:line-1", 120, 1000),
    routeEdge("ride-a2-d2", "RIDE", "station-a:line-2", "station-d:line-2", 150, 1200),
    routeEdge("ride-d2-a2", "RIDE", "station-d:line-2", "station-a:line-2", 150, 1200),
  ];
  const transfers = [
    routeEdge("transfer-station-a-line-1-line-2", "IN_STATION_TRANSFER", "station-a:line-1", "station-a:line-2", 100, 120),
    routeEdge("transfer-station-a-line-2-line-1", "IN_STATION_TRANSFER", "station-a:line-2", "station-a:line-1", 100, 120),
    routeEdge("out-link-b1-c3", "OUT_OF_STATION_TRANSFER", "station-b:line-1", "station-c:line-3", 300, 260),
    routeEdge("out-link-b1-c3-reverse", "OUT_OF_STATION_TRANSFER", "station-c:line-3", "station-b:line-1", 300, 260),
  ];
  const routeStationLines = STATION_LINES.map(({ stationId, lineId, lineSequence }) => ({
    stationId, lineId, operatorId: operatorByLine.get(lineId), lineSequence,
  }));
  const route = {
    candidate: {
      candidateId: CANDIDATE_ID,
      evaluatorVersion: "1",
      policyVersion: "route-edge-evaluation-v2",
      sourceSetSha256: SOURCE_SET,
      stationSetSha256: STATION_SET,
      topologySha256: canonicalRideEdgeSetSha256(rides),
    },
    stationLines: routeStationLines,
    routeEdges: [...rides, ...transfers]
      .sort((left, right) => compareBytes(left.edgeId, right.edgeId)),
  };

  const projectedFixture = {
    manifest: {
      activePack: { id: "nationwide", version: "1" },
      channel: "production",
      keyId: "fixture",
      manifestVersion: 2,
      ttlSeconds: 3600,
    },
    packs: [{
      id: "nationwide",
      version: "1",
      lines: structuredClone(LINES),
      stationLines: structuredClone(STATION_LINES),
      networkEdges: rides.map(fixtureRide),
    }],
  };
  const buildSpec = {
    artifactKind: "datapack-candidate-build-spec",
    candidateId: CANDIDATE_ID,
    fixturePath: SYNTHETIC_NATIONWIDE_PATHS.fixture,
    productionScopeId: SCOPE_ID,
    publishedAt: "2026-10-01T01:00:00.000Z",
    releaseSequence: 900,
    schemaVersion: 1,
    sourceSnapshotSetHash: SOURCE_SET,
  };
  const transferMetrics = { artifactKind: "current-transfer-topology-metrics", synthetic: true };
  return rebindSyntheticNationwideReleaseCandidate({
    buildSpec,
    projectedFixture,
    route,
    sourceFixture: structuredClone(projectedFixture),
    stationLineInput,
    transferMetrics,
  });
}

// 값 객체를 바꾼 뒤 raw bytes와 preparation sha를 다시 맞춘다.
// keepPreparationSha: true면 preparation의 입력 sha를 그대로 둔다(sha 불일치 회귀용).
export function rebindSyntheticNationwideReleaseCandidate(value, { keepPreparationSha = false } = {}) {
  const buildSpecBytes = Buffer.from(canonicalJson(value.buildSpec));
  const routeBytes = Buffer.from(canonicalJson(value.route));
  const stationLineInputBytes = Buffer.from(canonicalJson(value.stationLineInput));
  const sourceFixtureBytes = Buffer.from(canonicalJson(value.sourceFixture));
  const transferMetricsBytes = Buffer.from(canonicalJson(value.transferMetrics));
  const preparation = structuredClone(value.preparation ?? {
    artifactKind: "nationwide-candidate-preparation",
    authority: {
      approvalId: `release-request-${value.buildSpec.candidateId}`,
      approvedBy: "data-release-authority",
      candidateId: value.buildSpec.candidateId,
      requestedBy: "data-operator-lead",
      scopeId: value.buildSpec.productionScopeId,
    },
    builderIdentity: { gitSha: "a".repeat(40), version: "build-datapack.mjs@26" },
    materialization: { fixturePath: value.buildSpec.fixturePath },
    releaseIdentity: {
      candidateId: value.buildSpec.candidateId,
      publishedAt: value.buildSpec.publishedAt,
      releaseSequence: value.buildSpec.releaseSequence,
    },
    routeEdgeInput: { path: SYNTHETIC_NATIONWIDE_PATHS.routeEdgeInput, sha256: null },
    schemaVersion: 1,
    scopeId: value.buildSpec.productionScopeId,
    stationLineInput: { path: SYNTHETIC_NATIONWIDE_PATHS.stationLineInput, sha256: null },
  });
  if (!keepPreparationSha) {
    preparation.routeEdgeInput.sha256 = sha256(routeBytes);
    preparation.stationLineInput.sha256 = sha256(stationLineInputBytes);
  }
  return {
    ...value,
    buildSpecBytes,
    preparation,
    preparationBytes: Buffer.from(`${JSON.stringify(preparation, null, 2)}\n`),
    routeBytes,
    sourceFixtureBytes,
    stationLineInputBytes,
    transferMetricsBytes,
  };
}

// buildCurrentReleaseCandidateAccessibilityAuthority 입력 형식으로 투영한다.
export function syntheticNationwideAuthorityInput(value) {
  return {
    buildSpec: value.buildSpec,
    buildSpecBytes: value.buildSpecBytes,
    projectedFixture: structuredClone(value.projectedFixture),
    route: value.route,
    routeBytes: value.routeBytes,
    sourceFixtureBytes: value.sourceFixtureBytes,
    stationLineInput: value.stationLineInput,
    stationLineInputBytes: value.stationLineInputBytes,
    transferMetrics: value.transferMetrics,
    transferMetricsBytes: value.transferMetricsBytes,
  };
}

export function setSyntheticNationwideEvidenceState(value, stationLineKey, domain, state) {
  const row = value.stationLineInput.evidenceRows
    .find((candidate) => key(candidate) === stationLineKey && candidate.domain === domain);
  if (!row) throw new Error(`synthetic evidence row not found: ${stationLineKey} ${domain}`);
  Object.assign(row, evidenceFields(state, domain));
  return rebindSyntheticNationwideReleaseCandidate(value);
}

export async function writeSyntheticNationwideRepository(repositoryRoot, value) {
  const files = [
    [SYNTHETIC_NATIONWIDE_PATHS.buildSpec, value.buildSpecBytes],
    [SYNTHETIC_NATIONWIDE_PATHS.fixture, value.sourceFixtureBytes],
    [SYNTHETIC_NATIONWIDE_PATHS.preparation, value.preparationBytes],
    [SYNTHETIC_NATIONWIDE_PATHS.stationLineInput, value.stationLineInputBytes],
    [SYNTHETIC_NATIONWIDE_PATHS.routeEdgeInput, value.routeBytes],
    [SYNTHETIC_NATIONWIDE_PATHS.transferMetrics, value.transferMetricsBytes],
  ];
  for (const [relative, bytes] of files) {
    await mkdir(path.dirname(path.join(repositoryRoot, relative)), { recursive: true });
    await writeFile(path.join(repositoryRoot, relative), bytes);
  }
}

function evidence(candidate, line, domain, state) {
  return {
    candidateId: candidate.candidateId,
    capturedAt: SYNTHETIC_NATIONWIDE_CAPTURED_AT,
    domain,
    evidenceRawSha256: sha256(`raw:${key(line)}:${domain}`),
    freshUntil: FRESH_UNTIL,
    licenseId: "synthetic-license",
    lineId: line.lineId,
    mappingContractVersion: candidate.mappingContractVersion,
    materializerVersion: candidate.materializerVersion,
    operatorId: line.operatorId,
    provenanceId: `synthetic-provenance-${domain.toLowerCase()}`,
    providerRecordHash: sha256(`record:${key(line)}:${domain}`),
    sourceId: `synthetic-${domain.toLowerCase()}-source`,
    sourceSetSha256: candidate.sourceSetSha256,
    sourceSnapshotId: `synthetic-${domain.toLowerCase()}-snapshot`,
    stationId: line.stationId,
    stationSetSha256: candidate.stationSetSha256,
    ...evidenceFields(state, domain),
  };
}

function evidenceFields(state, domain) {
  if (state === "VERIFIED_PRESENT") {
    return { state, evidenceKind: "OBSERVED", evidenceReason: `OFFICIAL_${domain}_PRESENT` };
  }
  if (state === "NOT_APPLICABLE") {
    return { state, evidenceKind: "CURRENT_APPLICABILITY_RULE", evidenceReason: "canonical transfer applicability" };
  }
  if (state === "UNKNOWN") {
    return { state, evidenceKind: "PROVIDER_NO_DATA", evidenceReason: `${domain}_DATA_NOT_PROVIDED` };
  }
  throw new Error(`unsupported synthetic evidence state: ${state}`);
}

// #873 거부 회귀용: 예전 생성기가 만들던 역 단위 ENTRY/EXIT 간선(0s/0m)을 route 입력에 다시 넣는다.
export function addSyntheticLegacyAccessEdges(value, edgeTypes = ["ENTRY", "EXIT"]) {
  const added = value.route.stationLines.flatMap((line) => edgeTypes.map((edgeType) => (edgeType === "ENTRY"
    ? routeEdge(`entry-${line.stationId}-${line.lineId}`, "ENTRY", line.stationId, key(line), 0, 0)
    : routeEdge(`exit-${line.stationId}-${line.lineId}`, "EXIT", key(line), line.stationId, 0, 0))));
  value.route.routeEdges = [...value.route.routeEdges, ...added]
    .sort((left, right) => compareBytes(left.edgeId, right.edgeId));
  return rebindSyntheticNationwideReleaseCandidate(value);
}

function routeEdge(edgeId, edgeType, fromNodeId, toNodeId, durationSeconds, distanceMeters) {
  const payload = {
    edgeId, edgeType, fromNodeId, toNodeId, durationSeconds, distanceMeters,
    servicePattern: "", serviceClass: "SUBWAY",
  };
  return { ...payload, edgeSha256: routeEdgeSha256(payload) };
}

function fixtureRide(edge) {
  return {
    accessibilityStatus: "UNKNOWN",
    distanceMeters: edge.distanceMeters,
    durationSeconds: edge.durationSeconds,
    edgeType: edge.edgeType,
    facilityId: null,
    fromNodeId: edge.fromNodeId,
    id: edge.edgeId,
    includesStairs: false,
    reliabilityScore: 100,
    serviceClass: edge.serviceClass,
    servicePattern: edge.servicePattern,
    stairAccessState: "UNKNOWN",
    toNodeId: edge.toNodeId,
  };
}

function key(value) {
  return `${value.stationId}:${value.lineId}`;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalObject(value));
}

function canonicalObject(value) {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort(compareBytes).map((name) => [name, canonicalObject(value[name])]));
}

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
