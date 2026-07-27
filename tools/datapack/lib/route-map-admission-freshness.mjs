import { addCadence } from "../freshness-policy.mjs";
import { requiredUtcInstant } from "./utc-instant.mjs";

export const ROUTE_MAP_REVERIFICATION_CADENCE = "P1Y";

export function assertRouteMapAdmissionFreshness(evidence, now, sourceId) {
  const capturedAt = requiredUtcInstant(evidence?.capturedAt, `${sourceId} route-map capturedAt`);
  const freshUntil = requiredUtcInstant(evidence?.freshUntil, `${sourceId} route-map freshUntil`);
  if (freshUntil !== addCadence(capturedAt, ROUTE_MAP_REVERIFICATION_CADENCE)) {
    throw new Error(`${sourceId} route-map freshness contract is invalid`);
  }
  const observedNow = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(observedNow) || observedNow < capturedAt || observedNow >= freshUntil) {
    throw new Error(`${sourceId} route-map admission snapshot is stale or future-dated`);
  }
  return observedNow;
}
