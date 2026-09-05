import assert from "node:assert/strict";
import test from "node:test";

import { validateCapabilities, validateProductionTransferArtifacts, validateTransferAdmissionEvidence } from "./validate-source-inventory.mjs";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { canonicalJson } from "./lib/manifest-validation.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");

const SOURCE = {
  id: "seoul-metro-transfer-distance-duration",
  requiredForProductionPack: true,
  license: { commercialUseAllowed: true, redistributionAllowed: true },
};

const unsupported = (notes) => ({
  status: "UNSUPPORTED",
  productionUseAllowed: false,
  coverageStatus: "NOT_PROVIDED_BY_SOURCE",
  updateFrequency: "provider realtime; production cadence not admitted",
  unsupportedNotes: notes,
});

test("TRANSFER source alone closes the transfer capability contract", () => {
  assert.doesNotThrow(() => validateCapabilities({
    schedule: unsupported("schedule unavailable"),
    realtime: { ...unsupported("realtime unavailable"), liveEtaEligible: false, rateLimitStatus: "NOT_APPLICABLE" },
    facility: unsupported("facility unavailable"),
    transfer: {
      status: "SUPPORTED",
      productionUseAllowed: true,
      coverageStatus: "CAPITAL_SEOUL_METRO_15_PAIRS_30_DIRECTED_METRICS",
      updateFrequency: "annual file snapshot",
      unsupportedNotes: "공식 소요시간은 reference-only이며 runtime 환승시간은 거리와 선택한 보행속도로 계산한다",
    },
  }, SOURCE, SOURCE.id));
});

test("other sources cannot declare the closed TRANSFER capability", () => {
  assert.throws(() => validateCapabilities({
    schedule: unsupported("schedule unavailable"),
    realtime: { ...unsupported("realtime unavailable"), liveEtaEligible: false, rateLimitStatus: "NOT_APPLICABLE" },
    facility: unsupported("facility unavailable"),
    transfer: {
      status: "SUPPORTED", productionUseAllowed: true,
      coverageStatus: "CAPITAL_SEOUL_METRO_15_PAIRS_30_DIRECTED_METRICS",
      updateFrequency: "annual file snapshot",
      unsupportedNotes: "공식 소요시간은 reference-only이며 runtime 환승시간은 거리와 선택한 보행속도로 계산한다",
    },
  }, { ...SOURCE, id: "another-source" }, "another-source"));
});

test("unregistered transfer source retains the exact legacy three-capability state", () => {
  assert.doesNotThrow(() => validateCapabilities({
    schedule: unsupported("schedule unavailable"),
    realtime: { ...unsupported("realtime unavailable"), liveEtaEligible: false, rateLimitStatus: "NOT_APPLICABLE" },
    facility: unsupported("facility unavailable"),
  }, { ...SOURCE, requiredForProductionPack: false }, SOURCE.id));
});

const sha = (value) => createHash("sha256").update(value).digest("hex");
const admission = () => ({ artifactKind: "transfer-source-admission-evidence", approvalIssue: 350, decision: "APPROVED", approvedBy: "AquilaXk", approvedAt: "2026-08-15T12:00:00.000Z", productionUseAllowed: true, snapshotId: "seoul-metro-transfer-distance-duration-20260712T150000000Z", snapshotPath: "tools/datapack/sources/seoul-metro-transfer-distance-duration-20260712T150000000Z.json", snapshotFileSha256: "a".repeat(64), capturedAt: "2026-07-12T15:00:00.000Z", observedAt: "2026-07-12T15:00:00.000Z", freshUntil: "2027-07-12T15:00:00.000Z", sourceEffectiveDate: "2025-12-31", rawSha256: "b".repeat(64), contentSha256: "c".repeat(64), schemaFingerprint: "d".repeat(64), metricsPath: "tools/datapack/release/current-transfer-topology-metrics.json", metricsArtifactSha256: "e".repeat(64), applicabilityPath: "tools/datapack/release/current-capital-transfer-topology-applicability.json", applicabilityArtifactSha256: "f".repeat(64), rowCount: 145, physicalPairCount: 15, directedMetricCount: 30, officialMetricCount: 28, derivedReciprocalMetricCount: 2, stationLineCount: 213, applicableStationLineCount: 27, notApplicableStationLineCount: 186, durationRole: "REFERENCE_ONLY", licenseEvidenceHash: "0".repeat(64) });

test("transfer admission rejects null, offset, reverse and non-canonical timestamps", () => {
  for (const mutate of [
    (value) => { value.snapshotId = " "; },
    (value) => { value.capturedAt = null; },
    (value) => { value.approvedAt = "2026-08-15T21:00:00.000+09:00"; },
    (value) => { value.freshUntil = "2026-08-15T12:00:00.000Z"; },
  ]) {
    const value = admission(); mutate(value);
    assert.throws(() => validateTransferAdmissionEvidence({ ...SOURCE, transferAdmissionEvidence: value, admissionEvidence: { licenseEvidenceHash: "0".repeat(64) } }));
  }
});

test("production transfer artifact validation rejects missing and tampered authenticated artifacts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "transfer-artifact-validation-")); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = admission(); const source = { ...SOURCE, transferAdmissionEvidence: evidence };
  await assert.rejects(validateProductionTransferArtifacts({ sources: [source] }, { repositoryRoot: root }), /regular non-symlink/);
  const snapshot = { snapshotId: evidence.snapshotId, sourceId: source.id, rawSha256: evidence.rawSha256, contentSha256: evidence.contentSha256, schemaFingerprint: evidence.schemaFingerprint };
  snapshot.snapshotSha256 = sha(Buffer.from(`${canonicalJson(snapshot)}\n`));
  const snapshotBytes = Buffer.from(JSON.stringify(snapshot)); evidence.snapshotFileSha256 = sha(snapshotBytes);
  const identity = { sourceId: source.id, rawSha256: evidence.rawSha256, contentSha256: evidence.contentSha256, schemaSha256: evidence.schemaFingerprint };
  const metrics = { artifactKind: "current-transfer-topology-metrics", canonicalIdentity: { value: 1 }, sourceIdentity: identity }; metrics.artifactSha256 = sha(Buffer.from(canonicalJson(metrics)));
  evidence.metricsArtifactSha256 = metrics.artifactSha256;
  const applicability = { artifactKind: "current-capital-transfer-topology-applicability-pre-candidate", canonicalIdentity: metrics.canonicalIdentity, sourceIdentity: identity, transferTopologyMetricsIdentity: { artifactSha256: metrics.artifactSha256 } }; applicability.artifactSha256 = sha(Buffer.from(`${canonicalJson(applicability)}\n`)); evidence.applicabilityArtifactSha256 = applicability.artifactSha256;
  for (const [relative, value] of [[evidence.snapshotPath, snapshotBytes], [evidence.metricsPath, Buffer.from(`${canonicalJson(metrics)}\n`)], [evidence.applicabilityPath, Buffer.from(`${canonicalJson(applicability)}\n`)]]) { await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await writeFile(path.join(root, relative), value); }
  await assert.doesNotReject(validateProductionTransferArtifacts({ sources: [source] }, { repositoryRoot: root }));
  await writeFile(path.join(root, evidence.snapshotPath), "tampered");
  await assert.rejects(validateProductionTransferArtifacts({ sources: [source] }, { repositoryRoot: root }), /snapshot artifact/);
  await writeFile(path.join(root, evidence.snapshotPath), snapshotBytes);
  snapshot.snapshotSha256 = "f".repeat(64); const resealedSnapshotBytes = Buffer.from(JSON.stringify(snapshot)); evidence.snapshotFileSha256 = sha(resealedSnapshotBytes);
  await writeFile(path.join(root, evidence.snapshotPath), resealedSnapshotBytes);
  await assert.rejects(validateProductionTransferArtifacts({ sources: [source] }, { repositoryRoot: root }), /snapshot artifact/);
  snapshot.snapshotSha256 = sha(Buffer.from(canonicalJson(Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== "snapshotSha256"))))); const newlineFreeSnapshotBytes = Buffer.from(JSON.stringify(snapshot)); evidence.snapshotFileSha256 = sha(newlineFreeSnapshotBytes);
  await writeFile(path.join(root, evidence.snapshotPath), newlineFreeSnapshotBytes);
  await assert.rejects(validateProductionTransferArtifacts({ sources: [source] }, { repositoryRoot: root }), /snapshot artifact/);
  snapshot.snapshotSha256 = sha(Buffer.from(`${canonicalJson(Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== "snapshotSha256")))}\n`)); const restoredSnapshotBytes = Buffer.from(JSON.stringify(snapshot)); evidence.snapshotFileSha256 = sha(restoredSnapshotBytes);
  await writeFile(path.join(root, evidence.snapshotPath), restoredSnapshotBytes);
  await writeFile(path.join(root, evidence.metricsPath), JSON.stringify(metrics));
  await assert.rejects(validateProductionTransferArtifacts({ sources: [source] }, { repositoryRoot: root }), /metrics artifact/);
});

test("transfer production schema requires evidence and types every patterned admission value", () => {
  const schema = JSON.parse(readFileSync("contracts/datapack/source-inventory.schema.json", "utf8"));
  const item = schema.properties.sources.items;
  const evidence = item.properties.transferAdmissionEvidence.properties;
  for (const [name, rule] of Object.entries(evidence)) {
    if (rule.pattern) assert.equal(rule.type, "string", name);
  }
  assert.deepEqual(item.allOf.find((rule) => rule.if?.properties?.id?.const === SOURCE.id)?.then.required, ["transferAdmissionEvidence"]);
});

test("production scope CLI rejects missing required sources and accepts an exact source set", async (t) => {
  const inventory = JSON.parse(readFileSync(path.join(repositoryRoot, "tools/datapack/source-inventory.json"), "utf8"));
  const trackedScopePath = path.join(repositoryRoot, "release/product-gates/production-datapack-scope.json");
  const scope = JSON.parse(readFileSync(trackedScopePath, "utf8"));
  const requiredIds = inventory.sources.filter((source) => source.requiredForProductionPack === true)
    .map((source) => source.id);
  const run = (scopePath) => execFileAsync(process.execPath,
    ["tools/datapack/validate-source-inventory.mjs", "--scope", scopePath],
    { cwd: repositoryRoot });
  const rejectsMissing = (scopePath, sourceId) => assert.rejects(run(scopePath), (error) => {
    assert.equal(error.code, 1);
    assert.ok(error.stderr.includes(`${sourceId}.requiredForProductionPack must match productionSourceSet.requiredSourceIds`));
    return true;
  });
  const missingId = requiredIds.find((id) => !scope.productionSourceSet.requiredSourceIds.includes(id));
  if (missingId) await rejectsMissing(trackedScopePath, missingId);
  else await assert.doesNotReject(run(trackedScopePath));

  // 등록과 출시 scope 발행은 별도 단계다. 실제 scope는 수정하지 않는다.
  const root = await mkdtemp(path.join(os.tmpdir(), "production-source-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixturePath = path.join(root, "scope.json");
  scope.productionSourceSet.requiredSourceIds = requiredIds;
  for (const key of ["optionalAccessibilitySourceIds", "excludedFromV1SupportClaims"]) {
    scope.productionSourceSet[key] = scope.productionSourceSet[key].filter((id) => !requiredIds.includes(id));
  }
  await writeFile(fixturePath, JSON.stringify(scope));
  await assert.doesNotReject(run(fixturePath));
  assert.ok(requiredIds.length > 0);
  const omittedId = requiredIds[0];
  scope.productionSourceSet.requiredSourceIds = requiredIds.slice(1);
  await writeFile(fixturePath, JSON.stringify(scope));
  await rejectsMissing(fixturePath, omittedId);
});
