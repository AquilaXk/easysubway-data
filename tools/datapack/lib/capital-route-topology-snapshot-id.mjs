// capital-route-topology 스냅샷 id 문법(#862).
// 날짜형 `capital-route-topology-YYYYMMDD`는 같은 날 재수집을 막았다. 새 수집은 FACILITY처럼 수집 시각(ms까지)을
// 넣은 `capital-route-topology-YYYYMMDDTHHMMSSmmmZ`를 쓴다. 기존 날짜형 원장 행·파일은 append-only로 남으므로
// 두 형식을 모두 읽되, 어느 형식이든 id는 스냅샷 capturedAt에 결속돼야 한다.

const PREFIX = "capital-route-topology-";
const VERSION = "[0-9]{8}(?:T[0-9]{9}Z)?";

export const CAPITAL_ROUTE_TOPOLOGY_SNAPSHOT_ID_PATTERN = new RegExp(`^${PREFIX}(${VERSION})$`, "u");
export const CAPITAL_ROUTE_TOPOLOGY_SNAPSHOT_PATH_PATTERN =
  new RegExp(`^tools/datapack/sources/(${PREFIX}(${VERSION}))\\.json$`, "u");
export const CAPITAL_TOPOLOGY_REVERIFICATION_PATH_PATTERN =
  new RegExp(`^tools/datapack/release/capital-topology-reverification-${VERSION}\\.json$`, "u");

export function isCapitalRouteTopologySnapshotId(value) {
  return typeof value === "string" && CAPITAL_ROUTE_TOPOLOGY_SNAPSHOT_ID_PATTERN.test(value);
}

// id에서 접두사를 뺀 버전 접미사(날짜형이면 YYYYMMDD, 시각형이면 YYYYMMDDTHHMMSSmmmZ).
export function capitalRouteTopologySnapshotVersion(snapshotId) {
  const match = typeof snapshotId === "string" ? CAPITAL_ROUTE_TOPOLOGY_SNAPSHOT_ID_PATTERN.exec(snapshotId) : null;
  if (match == null) throw new Error("capital topology snapshot id is invalid");
  return match[1];
}

export function capitalRouteTopologySnapshotIdForCapturedAt(capturedAt) {
  if (typeof capturedAt !== "string" || Number.isNaN(Date.parse(capturedAt))
    || new Date(capturedAt).toISOString() !== capturedAt) {
    throw new Error("capital topology capturedAt is invalid");
  }
  return PREFIX + capturedAt.replace(/[-:.]/gu, "");
}

// 날짜형 id는 capturedAt의 UTC 날짜와, 시각형 id는 capturedAt 전체와 정확히 일치해야 한다.
export function capitalRouteTopologySnapshotIdMatchesCapturedAt(snapshotId, capturedAt) {
  if (!isCapitalRouteTopologySnapshotId(snapshotId)) return false;
  let timed;
  try { timed = capitalRouteTopologySnapshotIdForCapturedAt(capturedAt); } catch { return false; }
  const version = capitalRouteTopologySnapshotVersion(snapshotId);
  return version.length === 8 ? version === timed.slice(PREFIX.length, PREFIX.length + 8) : snapshotId === timed;
}

export function capitalTopologyReverificationPathForSnapshotId(snapshotId) {
  return `tools/datapack/release/capital-topology-reverification-${capitalRouteTopologySnapshotVersion(snapshotId)}.json`;
}
