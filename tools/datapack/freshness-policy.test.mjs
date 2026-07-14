import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  decideScheduledRun,
  deriveFreshness,
} from "./freshness-policy.mjs";

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
    "apps/mobile/release/datapack-freshness-sla.json",
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
    const basisAt = "2026-07-01T00:00:00.000Z";
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
