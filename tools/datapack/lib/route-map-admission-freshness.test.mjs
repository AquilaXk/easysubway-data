import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  assertCurrentTopologyAdmissionFreshness,
  assertRouteMapAdmissionFreshness,
  ROUTE_MAP_REVERIFICATION_CADENCE,
  SEOUL_PUBLIC_ROUTE_MAP_REVERIFICATION_CADENCE,
} from "./route-map-admission-freshness.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const sourceId = "route-map-source";
const evidence = {
  capturedAt: "2024-02-29T12:00:00.000Z",
  freshUntil: "2025-03-01T12:00:00.000Z",
};

test("route-map admission은 SLA의 P1Y UTC calendar-year 반개구간만 허용한다", async () => {
  const policy = JSON.parse(await readFile(
    path.join(root, "release/product-gates/datapack-freshness-sla.json"),
    "utf8",
  ));
  assert.equal(
    policy.sourceClasses.find(({ id }) => id === "route_map_asset_historical")?.reverificationCadence,
    ROUTE_MAP_REVERIFICATION_CADENCE,
  );
  assert.doesNotThrow(() => assertRouteMapAdmissionFreshness(
    evidence, new Date(evidence.capturedAt), sourceId,
  ));
  for (const invalidEvidence of [
    { ...evidence, freshUntil: "2025-02-28T12:00:00.000Z" },
    { ...evidence, freshUntil: "invalid" },
    { capturedAt: evidence.capturedAt },
  ]) {
    assert.throws(() => assertRouteMapAdmissionFreshness(
      invalidEvidence, new Date(evidence.capturedAt), sourceId,
    ));
  }
  assert.throws(() => assertRouteMapAdmissionFreshness(
    evidence, new Date("2024-02-29T11:59:59.999Z"), sourceId,
  ));
  assert.throws(() => assertRouteMapAdmissionFreshness(
    evidence, new Date(evidence.freshUntil), sourceId,
  ));
});

test("서울 공공 route-map admission은 source SLA의 P90D 반개구간만 허용한다", async () => {
  const policy = JSON.parse(await readFile(
    path.join(root, "release/product-gates/datapack-freshness-sla.json"),
    "utf8",
  ));
  const publicSourceId = "seoul-metro-route-map-positions";
  assert.equal(
    policy.sourceClasses.find(({ sourceIds }) => sourceIds.includes(publicSourceId))
      ?.reverificationCadence,
    SEOUL_PUBLIC_ROUTE_MAP_REVERIFICATION_CADENCE,
  );
  const publicEvidence = {
    capturedAt: "2026-07-24T02:00:00.000Z",
    freshUntil: "2026-10-22T02:00:00.000Z",
  };
  assert.doesNotThrow(() => assertRouteMapAdmissionFreshness(
    publicEvidence, new Date(publicEvidence.capturedAt), publicSourceId,
  ));
  assert.throws(() => assertRouteMapAdmissionFreshness(
    { ...publicEvidence, freshUntil: "2027-07-24T02:00:00.000Z" },
    new Date(publicEvidence.capturedAt),
    publicSourceId,
  ));
});

test("현재 topology admission과 snapshot은 동일한 검토 시각·만료 시각의 반개구간만 허용한다", () => {
  const admission = {
    reviewedAt: "2026-08-14T15:34:07.000Z",
    freshUntil: "2026-08-15T15:34:07.000Z",
  };
  const snapshot = {
    capturedAt: admission.reviewedAt,
    freshUntil: admission.freshUntil,
  };
  assert.doesNotThrow(() => assertCurrentTopologyAdmissionFreshness(
    admission, snapshot, new Date(admission.reviewedAt),
  ));
  assert.throws(() => assertCurrentTopologyAdmissionFreshness(
    admission, snapshot, new Date(admission.freshUntil),
  ), /topology admission snapshot is stale or future-dated/);
  assert.throws(() => assertCurrentTopologyAdmissionFreshness(
    { ...admission, freshUntil: "2026-08-16T15:34:07.000Z" }, snapshot, new Date(admission.reviewedAt),
  ), /topology admission freshness identity is invalid/);
  assert.throws(() => assertCurrentTopologyAdmissionFreshness(
    { ...admission, reviewedAt: "2026-08-14T15:34:08.000Z" }, snapshot, new Date(admission.reviewedAt),
  ), /topology admission freshness identity is invalid/);
  const extendedFreshUntil = "2026-08-15T15:34:07.001Z";
  assert.throws(() => assertCurrentTopologyAdmissionFreshness(
    { ...admission, freshUntil: extendedFreshUntil },
    { ...snapshot, freshUntil: extendedFreshUntil },
    new Date(admission.reviewedAt),
  ), /topology admission freshness contract is invalid/);
});
