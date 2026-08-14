import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_CRITICAL_SECONDS,
  DEFAULT_WARN_SECONDS,
  classifySnapshotFreshness,
  computeItxAdmissionServiceDates,
  parseArgs,
  renderPrometheusMetrics,
  runCheckTimetableSnapshotFreshnessCli,
} from "./check-timetable-snapshot-freshness.mjs";
import {
  evaluateFreshnessExtension,
  freshnessPolicySha256,
} from "./freshness-policy.mjs";

const FRESH_UNTIL = "2026-07-27T00:00:00+09:00";
const root = path.resolve(import.meta.dirname, "../..");
const freshUntilMs = Date.parse(FRESH_UNTIL);
const at = (secondsBefore) => new Date(freshUntilMs - secondsBefore * 1000);
const SHA = Object.freeze({
  snapshot: "a".repeat(64),
  raw: "b".repeat(64),
  observation: "c".repeat(64),
});
const EXTENSION_POLICY = Object.freeze({
  schemaVersion: 2,
  clockSkewSeconds: 300,
  sourceClasses: [{
    id: "route_map_asset",
    sourceIds: ["route-map-source"],
    reverificationCadence: "P30D",
  }],
});

function extensionInput({
  evaluationAt = "2026-08-14T00:00:00.000Z",
  sourceIdentity = {},
  policyBinding = {},
  observation,
} = {}) {
  const identity = {
    sourceId: "route-map-source",
    snapshotId: "route-map-snapshot-1",
    snapshotSha256: SHA.snapshot,
    rawEvidenceSha256: SHA.raw,
    currentFreshUntil: "2026-08-15T00:00:00.000Z",
    ...sourceIdentity,
  };
  const positiveObservation = {
    schemaVersion: 1,
    artifactKind: "source-freshness-observation",
    outcome: "POSITIVE",
    sourceId: identity.sourceId,
    snapshotId: identity.snapshotId,
    snapshotSha256: identity.snapshotSha256,
    rawEvidenceSha256: identity.rawEvidenceSha256,
    observedAt: "2026-08-14T00:00:00.000Z",
    evidenceSha256: SHA.observation,
    providerValidUntil: "2026-09-20T00:00:00.000Z",
    sourceValidUntil: null,
    licenseValidUntil: "2026-08-30T00:00:00.000Z",
  };
  return {
    schemaVersion: 1,
    artifactKind: "source-freshness-extension-input",
    evaluationAt,
    sourceIdentity: identity,
    policyBinding: {
      sourceClassId: "route_map_asset",
      policySha256: freshnessPolicySha256(EXTENSION_POLICY),
      ...policyBinding,
    },
    observation: observation === undefined ? positiveObservation : observation,
  };
}

test("여유가 충분하면 OK, 경보 없음", () => {
  const result = classifySnapshotFreshness({ freshUntil: FRESH_UNTIL, now: at(10 * 86_400) });
  assert.equal(result.status, "OK");
  assert.equal(result.severity, "none");
  assert.equal(result.shouldRefresh, false);
  assert.equal(result.expired, false);
});

test("T-72h refresh lead 창에 들어오면 shouldRefresh=true", () => {
  const result = classifySnapshotFreshness({ freshUntil: FRESH_UNTIL, now: at(3 * 86_400 - 1) });
  assert.equal(result.shouldRefresh, true);
});

test("T-24h 이내이면 warning 경보가 발화한다", () => {
  const result = classifySnapshotFreshness({ freshUntil: FRESH_UNTIL, now: at(DEFAULT_WARN_SECONDS - 60) });
  assert.equal(result.status, "FIRING");
  assert.equal(result.severity, "warning");
  assert.equal(result.shouldRefresh, true);
});

test("T-6h 이내이면 critical 경보로 격상한다", () => {
  const result = classifySnapshotFreshness({ freshUntil: FRESH_UNTIL, now: at(DEFAULT_CRITICAL_SECONDS - 60) });
  assert.equal(result.severity, "critical");
});

test("만료 이후에는 expired=true, critical, remainingSeconds<=0", () => {
  const result = classifySnapshotFreshness({ freshUntil: FRESH_UNTIL, now: at(-3600) });
  assert.equal(result.expired, true);
  assert.equal(result.severity, "critical");
  assert.ok(result.remainingSeconds <= 0);
});

test("잘못된 freshUntil은 예외", () => {
  assert.throws(() => classifySnapshotFreshness({ freshUntil: "not-a-date", now: new Date() }));
});

test("warn-seconds가 critical-seconds보다 작으면 예외", () => {
  assert.throws(() =>
    classifySnapshotFreshness({ freshUntil: FRESH_UNTIL, now: new Date(), warnSeconds: 60, criticalSeconds: 3600 }),
  );
});

test("Prometheus exposition 형식은 gauge 3종을 노출한다", () => {
  const metrics = renderPrometheusMetrics(classifySnapshotFreshness({ freshUntil: FRESH_UNTIL, now: at(86_400) }));
  assert.match(metrics, /# TYPE easysubway_timetable_snapshot_remaining_seconds gauge/);
  assert.match(metrics, /easysubway_timetable_snapshot_remaining_seconds 86400/);
  assert.match(metrics, /easysubway_timetable_snapshot_fresh_until_timestamp_seconds \d+/);
  assert.match(metrics, /easysubway_timetable_snapshot_expired 0/);
});

test("admission service dates는 창 안의 평일·토·일을 고른다", () => {
  // 2026-07-20은 월요일(KST). 창: 07-20(월)~07-26(일).
  const dates = computeItxAdmissionServiceDates(new Date("2026-07-20T00:00:00+09:00"));
  assert.equal(dates["8"], "20260720"); // 월요일(평일)
  assert.equal(dates["7"], "20260725"); // 토요일
  assert.equal(dates["9"], "20260726"); // 일요일
});

test("parseArgs는 --로 시작하지만 플래그 이름 형태가 아닌 값을 값으로 인식한다", () => {
  const result = parseArgs(["--evidence", "--not-a-flag.json", "--github-output", "output.txt"]);
  assert.equal(result.evidence, "--not-a-flag.json");
  assert.equal(result["github-output"], "output.txt");
});

test("parseArgs는 실제 플래그 이름 형태의 다음 토큰은 여전히 플래그 경계로 인식한다", () => {
  const result = parseArgs(["--warn-seconds", "--critical-seconds", "60"]);
  assert.equal(result["warn-seconds"], true);
  assert.equal(result["critical-seconds"], "60");
});

test("CLI는 critical snapshot을 무조건 fail-closed하고 evidence/metrics/github-output를 남긴다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "freshness-cli-"));
  const evidencePath = path.join(dir, "evidence.json");
  await writeFile(evidencePath, `${JSON.stringify({ freshUntil: FRESH_UNTIL })}\n`);
  const outputPath = path.join(dir, "out.json");
  const metricsPath = path.join(dir, "metrics.prom");
  const githubOutputPath = path.join(dir, "gh-output");
  await writeFile(githubOutputPath, "");

  const { result, exitCode } = await runCheckTimetableSnapshotFreshnessCli({
    argv: [
      "--evidence", evidencePath,
      "--output", outputPath,
      "--metrics-output", metricsPath,
      "--github-output", githubOutputPath,
    ],
    now: at(DEFAULT_CRITICAL_SECONDS - 60),
    cwd: dir,
  });

  assert.equal(result.severity, "critical");
  assert.equal(exitCode, 1);
  const evidenceOut = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(evidenceOut.artifactKind, "timetable-snapshot-freshness-alert");
  assert.equal(evidenceOut.serviceDates["8"].length, 8);
  assert.match(evidenceOut.serviceDates["8"], /^\d{8}$/);
  const ghOutput = await readFile(githubOutputPath, "utf8");
  assert.match(ghOutput, /severity=critical/);
  assert.match(ghOutput, /should_refresh=true/);
  assert.match(ghOutput, /day8_date=\d{8}/);
  assert.match(await readFile(metricsPath, "utf8"), /easysubway_timetable_snapshot_expired 0/);
});

test("freshness extension은 exact positive identity만 policy와 bounds 안에서 결정적으로 연장한다", async () => {
  const input = extensionInput();
  const first = evaluateFreshnessExtension({ input, policy: EXTENSION_POLICY });
  const second = evaluateFreshnessExtension({ input: structuredClone(input), policy: structuredClone(EXTENSION_POLICY) });

  assert.deepEqual(second, first);
  assert.equal(first.decision, "EXTENDED");
  assert.equal(first.reasonCode, "POSITIVE_OBSERVATION_EXTENDED");
  assert.equal(first.currentFreshUntil, "2026-08-15T00:00:00.000Z");
  assert.equal(first.extendedFreshUntil, "2026-08-30T00:00:00.000Z");
  assert.match(first.resultSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(first).toSorted(), [
    "artifactKind",
    "currentFreshUntil",
    "decision",
    "evaluatedAt",
    "extendedFreshUntil",
    "observationEvidenceSha256",
    "observedAt",
    "policySha256",
    "rawEvidenceSha256",
    "reasonCode",
    "resultSha256",
    "schemaVersion",
    "snapshotId",
    "snapshotSha256",
    "sourceClassId",
    "sourceId",
  ].toSorted());

  const inventorySchema = JSON.parse(await readFile(
    path.join(root, "contracts/datapack/source-inventory.schema.json"),
    "utf8",
  ));
  const storedReceipt = inventorySchema.properties.sources.items.properties
    .routeMapAdmissionEvidence.properties.freshnessExtension;
  assert.equal(storedReceipt.additionalProperties, false);
  assert.deepEqual(storedReceipt.required, [
    "schemaVersion",
    "artifactKind",
    "decision",
    "reasonCode",
    "sourceId",
    "snapshotId",
    "snapshotSha256",
    "rawEvidenceSha256",
    "sourceClassId",
    "policySha256",
    "observationEvidenceSha256",
    "currentFreshUntil",
    "extendedFreshUntil",
    "evaluatedAt",
    "observedAt",
    "resultSha256",
  ]);
  assert.equal(storedReceipt.properties.decision.const, "EXTENDED");
  assert.equal(storedReceipt.properties.reasonCode.const, "POSITIVE_OBSERVATION_EXTENDED");
});

test("freshness extension은 missing/no-op/negative/unknown과 non-monotonic candidate를 연장하지 않는다", () => {
  assert.deepEqual(
    evaluateFreshnessExtension({ input: extensionInput({ observation: null }), policy: EXTENSION_POLICY }),
    expectExtensionDecision("NO_EXTENSION", "OBSERVATION_MISSING"),
  );

  for (const [outcome, reasonCode] of [
    ["NO_CHANGE", "OBSERVATION_NO_CHANGE"],
    ["NEGATIVE", "OBSERVATION_NEGATIVE"],
    ["UNKNOWN", "OBSERVATION_UNKNOWN"],
  ]) {
    const input = extensionInput();
    input.observation.outcome = outcome;
    assert.deepEqual(
      evaluateFreshnessExtension({ input, policy: EXTENSION_POLICY }),
      expectExtensionDecision("NO_EXTENSION", reasonCode, input),
    );
  }

  const nonMonotonic = extensionInput({
    sourceIdentity: { currentFreshUntil: "2026-09-30T00:00:00.000Z" },
  });
  assert.deepEqual(
    evaluateFreshnessExtension({ input: nonMonotonic, policy: EXTENSION_POLICY }),
    expectExtensionDecision("NO_EXTENSION", "EXTENSION_NOT_MONOTONIC", nonMonotonic),
  );
});

test("freshness extension은 malformed/stale/future 또는 policy/source identity mismatch를 INELIGIBLE로 닫는다", () => {
  const policyMismatch = extensionInput({ policyBinding: { policySha256: "d".repeat(64) } });
  assert.equal(
    evaluateFreshnessExtension({ input: policyMismatch, policy: EXTENSION_POLICY }).reasonCode,
    "POLICY_IDENTITY_MISMATCH",
  );

  const sourceClassMismatch = extensionInput({ policyBinding: { sourceClassId: "other-class" } });
  assert.equal(
    evaluateFreshnessExtension({ input: sourceClassMismatch, policy: EXTENSION_POLICY }).reasonCode,
    "SOURCE_CLASS_INELIGIBLE",
  );

  for (const [key, value] of [
    ["sourceId", "other-source"],
    ["snapshotId", "other-snapshot"],
    ["snapshotSha256", "d".repeat(64)],
    ["rawEvidenceSha256", "e".repeat(64)],
  ]) {
    const identityMismatch = extensionInput();
    identityMismatch.observation[key] = value;
    assert.equal(
      evaluateFreshnessExtension({ input: identityMismatch, policy: EXTENSION_POLICY }).reasonCode,
      "SOURCE_IDENTITY_MISMATCH",
    );
  }

  const stale = extensionInput();
  stale.observation.observedAt = "2026-07-01T00:00:00.000Z";
  assert.equal(
    evaluateFreshnessExtension({ input: stale, policy: EXTENSION_POLICY }).reasonCode,
    "OBSERVATION_STALE",
  );

  const future = extensionInput();
  future.observation.observedAt = "2026-08-14T00:05:00.001Z";
  assert.equal(
    evaluateFreshnessExtension({ input: future, policy: EXTENSION_POLICY }).reasonCode,
    "OBSERVATION_IN_FUTURE",
  );

  const invalidBound = extensionInput();
  invalidBound.observation.providerValidUntil = invalidBound.observation.observedAt;
  assert.equal(
    evaluateFreshnessExtension({ input: invalidBound, policy: EXTENSION_POLICY }).reasonCode,
    "OBSERVATION_BOUND_INVALID",
  );

  const malformed = extensionInput();
  malformed.unexpected = true;
  const malformedResult = evaluateFreshnessExtension({ input: malformed, policy: EXTENSION_POLICY });
  assert.equal(malformedResult.decision, "INELIGIBLE");
  assert.equal(malformedResult.reasonCode, "INPUT_SCHEMA_INVALID");
  assert.equal(evaluateFreshnessExtension().reasonCode, "INPUT_SCHEMA_INVALID");
  assert.equal(
    evaluateFreshnessExtension({ input: extensionInput(), policy: { sourceClasses: [null] } }).decision,
    "INELIGIBLE",
  );
});

function expectExtensionDecision(decision, reasonCode, input = extensionInput({ observation: null })) {
  const result = evaluateFreshnessExtension({ input, policy: EXTENSION_POLICY });
  return { ...result, decision, reasonCode, extendedFreshUntil: null };
}
