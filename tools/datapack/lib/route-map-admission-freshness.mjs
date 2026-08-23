import { addCadence } from "../freshness-policy.mjs";
import { requiredUtcInstant } from "./utc-instant.mjs";

export const ROUTE_MAP_REVERIFICATION_CADENCE = "P1Y";
export const SEOUL_PUBLIC_ROUTE_MAP_REVERIFICATION_CADENCE = "P90D";
const CURRENT_TOPOLOGY_FRESHNESS_MILLIS = 24 * 60 * 60 * 1_000;

export function routeMapReverificationCadence(sourceId) {
  return sourceId === "seoul-metro-route-map-positions"
    ? SEOUL_PUBLIC_ROUTE_MAP_REVERIFICATION_CADENCE
    : ROUTE_MAP_REVERIFICATION_CADENCE;
}

export function assertRouteMapAdmissionFreshness(evidence, now, sourceId) {
  const capturedAt = requiredUtcInstant(evidence?.capturedAt, `${sourceId} route-map capturedAt`);
  const freshUntil = requiredUtcInstant(evidence?.freshUntil, `${sourceId} route-map freshUntil`);
  if (freshUntil !== addCadence(capturedAt, routeMapReverificationCadence(sourceId))) {
    throw new Error(`${sourceId} route-map freshness contract is invalid`);
  }
  const observedNow = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(observedNow) || observedNow < capturedAt || observedNow >= freshUntil) {
    throw new Error(`${sourceId} route-map admission snapshot is stale or future-dated`);
  }
  return observedNow;
}

export function assertCurrentTopologyAdmissionFreshness(admission, snapshot, now) {
  const reviewedAt = requiredUtcInstant(admission?.reviewedAt, "topology admission reviewedAt");
  const admissionFreshUntil = requiredUtcInstant(admission?.freshUntil, "topology admission freshUntil");
  const capturedAt = requiredUtcInstant(snapshot?.capturedAt, "topology snapshot capturedAt");
  const snapshotFreshUntil = requiredUtcInstant(snapshot?.freshUntil, "topology snapshot freshUntil");
  if (reviewedAt !== capturedAt || admissionFreshUntil !== snapshotFreshUntil) {
    throw new Error("topology admission freshness identity is invalid");
  }
  if (snapshotFreshUntil - capturedAt !== CURRENT_TOPOLOGY_FRESHNESS_MILLIS) {
    throw new Error("topology admission freshness contract is invalid");
  }
  const observedNow = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(observedNow) || observedNow < capturedAt || observedNow >= snapshotFreshUntil) {
    throw new Error("topology admission snapshot is stale or future-dated");
  }
  return observedNow;
}
