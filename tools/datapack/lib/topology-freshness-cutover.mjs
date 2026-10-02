// QA 승인(2026-10-02): 노선 topology(route_graph_topology)는 이벤트 기반 갱신 + P7D 만료 안전망이다.
// 컷오버 이전에 수집한 topology 스냅샷·원장 행은 당시 규칙(P1D)으로 만들어졌으므로 그 창을 그대로 유지하고,
// 컷오버 이후 수집분만 P7D 창을 쓴다. 두 규칙 모두 정확값으로만 검사한다(연장·관대 허용 없음).
export const ROUTE_GRAPH_TOPOLOGY_CLASS_ID = "route_graph_topology";
export const TOPOLOGY_FRESHNESS_CUTOVER_AT = "2026-10-03T00:00:00.000Z";
export const LEGACY_TOPOLOGY_REVERIFICATION_CADENCE = "P1D";
export const TOPOLOGY_REVERIFICATION_CADENCE = "P7D";

const DAY_MS = 24 * 60 * 60 * 1_000;
const CUTOVER_MILLIS = Date.parse(TOPOLOGY_FRESHNESS_CUTOVER_AT);

function capturedMillis(capturedAt) {
  const millis = capturedAt instanceof Date
    ? capturedAt.getTime()
    : typeof capturedAt === "number" || (typeof capturedAt === "string" && capturedAt.length > 0)
      ? new Date(capturedAt).getTime()
      : Number.NaN;
  if (!Number.isFinite(millis)) throw new Error("topology capturedAt is invalid");
  return millis;
}

export function isLegacyTopologyBasis(basisMillis) {
  return basisMillis < CUTOVER_MILLIS;
}

export function topologySnapshotFreshnessMillis(capturedAt) {
  return isLegacyTopologyBasis(capturedMillis(capturedAt)) ? DAY_MS : 7 * DAY_MS;
}

export function topologySnapshotFreshUntil(capturedAt) {
  const millis = capturedMillis(capturedAt);
  return new Date(millis + topologySnapshotFreshnessMillis(millis)).toISOString();
}
