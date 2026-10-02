import { routeEdgeSha256 } from "./evaluate-route-accessibility-edges.mjs";

const compareBytes = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));
const CANDIDATE_KEYS = [
  "candidateId", "mappingContractVersion", "materializerVersion", "sourceSetSha256", "stationSetSha256",
];

export function canonicalCurrentCapitalStationLineInputJson(value) {
  assertKeys(
    value,
    ["candidate", "stationLines", "evidenceRows"],
    "full-capital station-line output",
  );
  assertKeys(value.candidate, CANDIDATE_KEYS, "full-capital station-line candidate");
  if (!Array.isArray(value.stationLines) || !Array.isArray(value.evidenceRows)) {
    throw new Error("full-capital station-line arrays are required");
  }
  return canonicalJson(value);
}

export function deriveCurrentReleaseCandidateObservedAt(evidenceRows) {
  const captured = evidenceRows.map(({ capturedAt, freshUntil }) => {
    const capturedMillis = Date.parse(capturedAt);
    const freshMillis = Date.parse(freshUntil);
    if (!Number.isFinite(capturedMillis) || !Number.isFinite(freshMillis)
      || freshMillis <= capturedMillis) {
      throw new Error("evidence freshness mismatch");
    }
    return { capturedMillis, freshMillis };
  });
  const observedMillis = Math.max(...captured.map(({ capturedMillis }) => capturedMillis));
  if (!Number.isFinite(observedMillis)
    || captured.some(({ freshMillis }) => freshMillis <= observedMillis)) {
    throw new Error("evidence is stale at full-capital observation time");
  }
  return new Date(observedMillis).toISOString();
}

function assertKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort(compareBytes))
      !== canonicalJson([...keys].sort(compareBytes))) {
    throw new Error(`${label} keys mismatch`);
  }
}

function canonicalJson(value) {
  return JSON.stringify(canonicalObject(value));
}

function canonicalObject(value) {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort(compareBytes)
    .map((key) => [key, canonicalObject(value[key])]));
}

// #872 S2(#866에서 전국 경로로 대체 후 삭제): 환승 지표는 서울교통공사 1~8호선과 상대 노선 전체로 넓어졌다.
// 수도권 live-chain(route-edge input·release-candidate transfer 대조)은 수도권 station-line 분모 안에 두 끝점이 모두 있는
// 쌍만 쓴다. 전국 경로는 prepare-nationwide-candidate-run이 지표 전체를 쓴다.
export function currentCapitalTransferEdgesFromMetrics(metrics, stationLines) {
  if (!Array.isArray(metrics) || metrics.length === 0) {
    throw new Error("full-capital TRANSFER metrics are required");
  }
  if (!Array.isArray(stationLines) || stationLines.length === 0) throw new Error("full-capital TRANSFER station-line domain is required");
  const domain = new Set(stationLines.map(({ stationId, lineId }) => `${stationId}\0${lineId}`));
  const domainMetrics = metrics.filter(({ stationId, fromLineId, toLineId }) => domain.has(`${stationId}\0${fromLineId}`) && domain.has(`${stationId}\0${toLineId}`));
  if (domainMetrics.length === 0) throw new Error("full-capital TRANSFER metrics are required");
  return domainMetrics.map((metric) => routeEdge({
    edgeId: `edge-transfer-${metric.stationId}-${metric.fromLineId}-${metric.toLineId}`,
    edgeType: "IN_STATION_TRANSFER",
    fromNodeId: `${metric.stationId}:${metric.fromLineId}`,
    toNodeId: `${metric.stationId}:${metric.toLineId}`,
    durationSeconds: 0,
    distanceMeters: metric.distanceMeters,
  }));
}

export function canonicalCurrentCapitalRouteEdgeInputJson(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || canonicalJson(Object.keys(value).sort(compareBytes)) !== canonicalJson(["candidate", "routeEdges", "stationLines"])) throw new Error("full-capital route output keys mismatch");
  if (!Array.isArray(value.stationLines) || !Array.isArray(value.routeEdges)) throw new Error("full-capital route arrays are required");
  return canonicalJson(value);
}

function routeEdge(value) {
  const normalized = {
    edgeId: value.edgeId,
    edgeType: value.edgeType,
    fromNodeId: value.fromNodeId,
    toNodeId: value.toNodeId,
    durationSeconds: value.durationSeconds,
    distanceMeters: value.distanceMeters,
    servicePattern: value.servicePattern ?? "",
    serviceClass: value.serviceClass ?? "SUBWAY",
  };
  return { ...normalized, edgeSha256: routeEdgeSha256(normalized) };
}
