import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  decideScheduledRun,
  deriveFreshness,
  deriveFreshnessExpiresAt,
} from "./freshness-policy.mjs";
import {
  TOPOLOGY_FRESHNESS_CUTOVER_AT,
  TOPOLOGY_REVERIFICATION_CADENCE,
  topologySnapshotFreshUntil,
} from "./lib/topology-freshness-cutover.mjs";

const policy = {
  clockSkewSeconds: 300,
  sourceClasses: [
    {
      id: "static_accessibility_facility",
      basisField: "retrievedAt",
      reverificationCadence: "P90D",
    },
    {
      id: "planned_timetable",
      basisField: "serviceEffectiveAt",
      maximumReverificationCadence: "P30D",
      futureBasisAllowed: true,
    },
  ],
};

test("evaluationAt이 expiry와 같으면 source snapshot은 stale이다", () => {
  assert.deepEqual(deriveFreshness({
    policy,
    sourceClassId: "static_accessibility_facility",
    basisAt: "2026-07-01T00:00:00.000Z",
    storedExpiresAt: "2026-09-29T00:00:00.000Z",
    evaluationAt: "2026-09-29T00:00:00.000Z",
  }), {
    status: "STALE",
    freshnessExpiresAt: "2026-09-29T00:00:00.000Z",
    reasonCodes: ["SOURCE_SNAPSHOT_EXPIRED"],
  });
});

test("missing policy 또는 basis는 invalid evaluationAt보다 먼저 거부한다", () => {
  for (const [candidatePolicy, basisAt] of [[undefined, "2026-07-01T00:00:00.000Z"], [policy, undefined]]) {
    assert.throws(() => deriveFreshness({
      policy: candidatePolicy,
      sourceClassId: "static_accessibility_facility",
      basisAt,
      storedExpiresAt: "2026-09-29T00:00:00.000Z",
      evaluationAt: "invalid",
    }), /SOURCE_FRESHNESS_POLICY_MISSING/);
  }
});

test("provider validity end가 cadence보다 이르면 더 이른 expiry를 적용한다", () => {
  assert.deepEqual(deriveFreshness({
    policy,
    sourceClassId: "planned_timetable",
    basisAt: "2026-07-01T00:00:00.000Z",
    providerValidUntil: "2026-07-20T00:00:00.000Z",
    storedExpiresAt: "2026-07-20T00:00:00.000Z",
    evaluationAt: "2026-07-19T23:59:59.999Z",
  }), {
    status: "FRESH",
    freshnessExpiresAt: "2026-07-20T00:00:00.000Z",
    reasonCodes: [],
  });
});

test("policy 파생값과 저장값이 다르면 fail closed한다", () => {
  assert.throws(() => deriveFreshness({
    policy,
    sourceClassId: "static_accessibility_facility",
    basisAt: "2026-07-01T00:00:00.000Z",
    storedExpiresAt: "2099-01-01T00:00:00.000Z",
    evaluationAt: "2026-07-02T00:00:00.000Z",
  }), /SOURCE_FRESHNESS_DERIVATION_MISMATCH/);
});

test("future basis가 clock skew를 넘으면 fail closed한다", () => {
  assert.throws(() => deriveFreshness({
    policy,
    sourceClassId: "static_accessibility_facility",
    basisAt: "2026-07-01T00:05:00.001Z",
    storedExpiresAt: "2026-09-29T00:05:00.001Z",
    evaluationAt: "2026-07-01T00:00:00.000Z",
  }), /SOURCE_FRESHNESS_DERIVATION_MISMATCH/);
});

test("planned timetable은 미래 service effective basis를 허용한다", () => {
  assert.deepEqual(deriveFreshness({
    policy,
    sourceClassId: "planned_timetable",
    basisAt: "2026-07-10T00:00:00.000Z",
    storedExpiresAt: "2026-08-09T00:00:00.000Z",
    evaluationAt: "2026-07-01T00:00:00.000Z",
  }), {
    status: "FRESH",
    freshnessExpiresAt: "2026-08-09T00:00:00.000Z",
    reasonCodes: [],
  });
});

test("존재하지 않는 UTC 날짜는 fail closed한다", () => {
  assert.throws(() => deriveFreshness({
    policy,
    sourceClassId: "static_accessibility_facility",
    basisAt: "2026-02-31T00:00:00Z",
    storedExpiresAt: "2026-06-01T00:00:00Z",
    evaluationAt: "2026-03-01T00:00:00Z",
  }), /RFC 3339 UTC timestamp/);
});

test("P1Y는 UTC calendar overflow로 윤일 다음 비윤년 3월 1일을 파생한다", () => {
  assert.equal(deriveFreshness({
    policy: {
      sourceClasses: [{
        id: "yearly",
        basisField: "retrievedAt",
        reverificationCadence: "P1Y",
      }],
    },
    sourceClassId: "yearly",
    basisAt: "2024-02-29T00:00:00.000Z",
    storedExpiresAt: "2025-03-01T00:00:00.000Z",
    evaluationAt: "2024-02-29T00:00:00.000Z",
  }).freshnessExpiresAt, "2025-03-01T00:00:00.000Z");
});

test("schedule decision은 publish write를 승인 evidence와 strict pass 뒤에만 허용한다", () => {
  assert.deepEqual(decideScheduledRun({
    materialChange: false,
    approvalValid: false,
    strictValidationPassed: true,
    publishRequired: false,
    publishAttempted: false,
    remoteValidationPassed: false,
  }), { outcome: "NO_CHANGE_VALID", productionWriteAllowed: false });

  assert.deepEqual(decideScheduledRun({
    materialChange: true,
    approvalValid: false,
    strictValidationPassed: true,
    publishRequired: true,
    publishAttempted: false,
    remoteValidationPassed: false,
  }), { outcome: "CHANGE_BLOCKED", productionWriteAllowed: false });

  assert.deepEqual(decideScheduledRun({
    materialChange: true,
    approvalValid: true,
    strictValidationPassed: true,
    publishRequired: true,
    publishAttempted: false,
    remoteValidationPassed: false,
  }), { outcome: "PUBLISH_REQUIRED", productionWriteAllowed: true });

  assert.deepEqual(decideScheduledRun({
    materialChange: false,
    approvalValid: false,
    strictValidationPassed: true,
    publishRequired: true,
    publishAttempted: false,
    remoteValidationPassed: false,
  }), { outcome: "PUBLISH_REQUIRED", productionWriteAllowed: false });

  assert.deepEqual(decideScheduledRun({
    materialChange: false,
    approvalValid: true,
    strictValidationPassed: true,
    publishRequired: true,
    publishAttempted: false,
    remoteValidationPassed: false,
  }), { outcome: "PUBLISH_REQUIRED", productionWriteAllowed: true });

  assert.deepEqual(decideScheduledRun({
    materialChange: true,
    approvalValid: true,
    strictValidationPassed: true,
    publishRequired: true,
    publishAttempted: true,
    remoteValidationPassed: true,
  }), { outcome: "PUBLISHED_AND_VERIFIED", productionWriteAllowed: true });

  assert.deepEqual(decideScheduledRun({
    materialChange: true,
    approvalValid: true,
    strictValidationPassed: true,
    publishRequired: true,
    publishAttempted: true,
    remoteValidationPassed: false,
  }), { outcome: "FAILED", productionWriteAllowed: false });
});

test("tracked freshness policy는 수동 decision 없이 파생 필드를 선언한다", async () => {
  const tracked = JSON.parse(await readFile(
    "release/product-gates/datapack-freshness-sla.json",
    "utf8",
  ));

  assert.equal(tracked.schemaVersion, 2);
  assert.equal(Object.hasOwn(tracked, "status"), false);
  assert.equal(Object.hasOwn(tracked, "currentDecision"), false);
  assert.equal(Number.isInteger(tracked.clockSkewSeconds), true);
  for (const sourceClass of tracked.sourceClasses) {
    assert.equal(typeof sourceClass.basisField, "string");
    assert.equal(sourceClass.basisField.length > 0, true);
    assert.equal(
      typeof (sourceClass.reverificationCadence ?? sourceClass.maximumReverificationCadence),
      "string",
    );
    const cadence = sourceClass.reverificationCadence ?? sourceClass.maximumReverificationCadence;
    // 컷오버 이후 basis에서는 모든 클래스가 정책 주기를 그대로 쓴다(컷오버 이전 topology는 아래 테스트가 고정).
    const basisAt = TOPOLOGY_FRESHNESS_CUTOVER_AT;
    const storedExpiresAt = expectedExpiry(basisAt, cadence);
    assert.equal(deriveFreshness({
      policy: tracked,
      sourceClassId: sourceClass.id,
      basisAt,
      storedExpiresAt,
      evaluationAt: basisAt,
    }).freshnessExpiresAt, storedExpiresAt);
  }
  assert.deepEqual(tracked.scheduledPipeline.requiredStages, [
    "source-snapshot",
    "change-detection",
    "build",
    "strict-validation",
    "conditional-publish",
    "conditional-post-publish-artifact-validation",
  ]);
});

test("공공 노선도 위치 freshness는 90일이며 historical web asset을 current source와 분리한다", async () => {
  const tracked = JSON.parse(await readFile(
    "release/product-gates/datapack-freshness-sla.json",
    "utf8",
  ));
  const positions = tracked.sourceClasses.find(({ id }) => id === "route_map_positions");
  const historical = tracked.sourceClasses.find(({ id }) => id === "route_map_asset_historical");
  assert.deepEqual(positions.sourceIds, ["seoul-metro-route-map-positions"]);
  assert.equal(positions.reverificationCadence, "P90D");
  assert.equal(historical.offlinePackEligible, false);
  assert.deepEqual(historical.sourceIds, ["seoulmetro-cyberstation-route-map"]);
});

test("노선 topology 신선도는 컷오버 전 수집분은 P1D, 컷오버 이후 수집분은 정책 P7D로 정확히 유도한다", async () => {
  const tracked = JSON.parse(await readFile(
    "release/product-gates/datapack-freshness-sla.json",
    "utf8",
  ));
  const topology = tracked.sourceClasses.find(({ id }) => id === "route_graph_topology");
  // QA 승인(2026-10-02): topology는 이벤트 기반 갱신 + P7D 만료 안전망. lib 상수와 정책이 어긋나면 수집기·등록기가 갈라진다.
  assert.equal(topology.reverificationCadence, "P7D");
  assert.equal(TOPOLOGY_REVERIFICATION_CADENCE, topology.reverificationCadence);
  assert.equal(TOPOLOGY_FRESHNESS_CUTOVER_AT, "2026-10-03T00:00:00.000Z");

  const cutover = Date.parse(TOPOLOGY_FRESHNESS_CUTOVER_AT);
  const beforeCutover = new Date(cutover - 1).toISOString();
  const derive = (sourceClassId, basisAt) => deriveFreshnessExpiresAt({
    policy: tracked, sourceClassId, basisAt, evaluationAt: basisAt,
  });
  assert.equal(derive("route_graph_topology", beforeCutover), new Date(cutover - 1 + 86_400_000).toISOString());
  assert.equal(derive("route_graph_topology", TOPOLOGY_FRESHNESS_CUTOVER_AT), new Date(cutover + 7 * 86_400_000).toISOString());
  // 다른 클래스는 컷오버와 무관하게 자기 정책 주기를 쓴다.
  assert.equal(derive("static_accessibility_facility", beforeCutover), new Date(cutover - 1 + 90 * 86_400_000).toISOString());
  assert.equal(derive("official_static_timetable_confirmation", beforeCutover), new Date(cutover - 1 + 7 * 86_400_000).toISOString());

  assert.equal(topologySnapshotFreshUntil(beforeCutover), derive("route_graph_topology", beforeCutover));
  assert.equal(topologySnapshotFreshUntil(TOPOLOGY_FRESHNESS_CUTOVER_AT), derive("route_graph_topology", TOPOLOGY_FRESHNESS_CUTOVER_AT));
  assert.equal(topologySnapshotFreshUntil(new Date(cutover)), new Date(cutover + 7 * 86_400_000).toISOString());
  for (const invalid of [undefined, null, "", "not-a-date", Number.NaN]) {
    assert.throws(() => topologySnapshotFreshUntil(invalid), /topology capturedAt/);
  }
});

function expectedExpiry(basisAt, cadence) {
  const basis = new Date(basisAt);
  const days = /^P([1-9][0-9]*)D$/.exec(cadence);
  if (days) return new Date(basis.getTime() + Number(days[1]) * 86_400_000).toISOString();
  const years = /^P([1-9][0-9]*)Y$/.exec(cadence);
  if (years) {
    basis.setUTCFullYear(basis.getUTCFullYear() + Number(years[1]));
    return basis.toISOString();
  }
  const seconds = /^PT([1-9][0-9]*)S$/.exec(cadence);
  if (seconds) return new Date(basis.getTime() + Number(seconds[1]) * 1_000).toISOString();
  throw new Error(`unsupported test cadence ${cadence}`);
}
