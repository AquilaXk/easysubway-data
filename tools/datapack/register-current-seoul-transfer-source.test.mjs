import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalJson } from "./lib/manifest-validation.mjs";

import { buildTransferRegistrationOutputs, commitTransferRegistrationOutputs } from "./register-current-seoul-transfer-source.mjs";
import { deriveReleaseProjection } from "./rebind-current-candidate-source-snapshots.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const bytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
function compositionFixture() {
  const capturedAt = "2026-07-12T15:00:00.000Z"; const rawBytes = Buffer.from("raw");
  const observation = { manifest: { sourceId: "seoul-metro-transfer-distance-duration", capturedAt, rawSha256: sha(rawBytes), contentSha256: sha("content"), schemaSha256: sha("schema"), endpointSha256: sha("endpoint"), rowCount: 145, freshnessDate: "2025-12-31", credentialRedacted: true }, manifestBytes: Buffer.from("manifest"), observationBytes: Buffer.from("observation"), rawBytes };
  const root = process.cwd();
  const load = (relative) => { const body = readFileSync(path.join(root, relative)); return { body, value: JSON.parse(body) }; };
  const inventory = load("tools/datapack/source-inventory.json"); const candidate = load("tools/datapack/release/candidate-build-spec.json"); const ledger = load("tools/datapack/release/source-snapshots.json"); const scope = load("release/product-gates/production-datapack-scope.json"); const governance = load("tools/datapack/source-governance-policy.json"); const freshness = load("release/product-gates/datapack-freshness-sla.json"); const pack = load("tools/datapack/release/capital-production-canonical-pack.json");
  const sourceId = observation.manifest.sourceId;
  const transferSource = inventory.value.sources.find(({ id }) => id === sourceId);
  transferSource.requiredForProductionPack = false;
  delete transferSource.capabilities.transfer;
  delete transferSource.transferAdmissionEvidence;
  ledger.value = ledger.value.filter(({ sourceId: ledgerSourceId }) => ledgerSourceId !== sourceId);
  candidate.value.sourceSnapshots = candidate.value.sourceSnapshots.filter(
    ({ sourceId: candidateSourceId }) => candidateSourceId !== sourceId,
  );
  candidate.value.sourceSnapshotIds = candidate.value.sourceSnapshots.map(({ snapshotId }) => snapshotId);
  scope.value.productionSourceSet.requiredSourceIds = scope.value.productionSourceSet.requiredSourceIds.filter(
    (requiredSourceId) => requiredSourceId !== sourceId,
  );
  scope.value.productionSourceSet.optionalAccessibilitySourceIds.push(sourceId);
  scope.value.productionSourceSet.excludedFromV1SupportClaims.push(sourceId);
  const metrics = load("tools/datapack/release/current-transfer-topology-metrics.json").value;
  metrics.sourceIdentity = { ...metrics.sourceIdentity, sourceId: observation.manifest.sourceId, endpointSha256: observation.manifest.endpointSha256, manifestSha256: sha(observation.manifestBytes), observationSha256: sha(observation.observationBytes), rawSnapshotSha256: sha(rawBytes), rawSha256: observation.manifest.rawSha256, contentSha256: observation.manifest.contentSha256, schemaSha256: observation.manifest.schemaSha256, rowCount: 145, capturedAt, freshnessDate: "2025-12-31" };
  metrics.artifactSha256 = sha(Buffer.from(canonicalJson(sort(metrics, "artifactSha256"))));
  const applicability = { artifactKind: "current-capital-transfer-topology-applicability-pre-candidate", productionUseAllowed: false, candidateBinding: null, canonicalIdentity: metrics.canonicalIdentity, sourceIdentity: metrics.sourceIdentity, transferTopologyMetricsIdentity: { artifactSha256: metrics.artifactSha256 }, stateSummary: { APPLICABLE_TRANSFER_ENDPOINT: 27, NOT_APPLICABLE_IN_CANONICAL_PAIR_SET: 186 } };
  const { artifactSha256: ignoredArtifact, ...applicabilityPayload } = applicability;
  applicability.artifactSha256 = sha(Buffer.from(`${canonicalJson(applicabilityPayload)}\n`));
  assert.equal(metrics.canonicalIdentity.canonicalPackSha256, sha(pack.body));
  assert.equal(metrics.artifactSha256, sha(Buffer.from(canonicalJson(sort(metrics, "artifactSha256")))));
  assert.equal(applicability.artifactSha256, sha(Buffer.from(`${canonicalJson(applicabilityPayload)}\n`)));
  assert.equal(applicability.productionUseAllowed, false); assert.equal(applicability.candidateBinding, null);
  assert.deepEqual(applicability.canonicalIdentity, metrics.canonicalIdentity); assert.deepEqual(applicability.sourceIdentity, metrics.sourceIdentity);
  assert.equal(applicability.stateSummary.APPLICABLE_TRANSFER_ENDPOINT, 27); assert.equal(applicability.stateSummary.NOT_APPLICABLE_IN_CANONICAL_PAIR_SET, 186);
  const selectedRows = candidate.value.sourceSnapshotIds.map((snapshotId) => {
    const matches = ledger.value.filter((row) => row.snapshotId === snapshotId);
    assert.equal(matches.length, 1, `selected source snapshot identity: ${snapshotId}`);
    return matches[0];
  });
  const basisAt = Math.max(...selectedRows.flatMap((entry) => [
    entry.retrievedAt, entry.sourceUpdatedAt, entry.capturedAt, entry.rawReceipt?.storedAt,
  ].filter(Boolean).map(Date.parse)));
  const freshUntil = Math.min(...selectedRows.map(({ freshnessExpiresAt }) => Date.parse(freshnessExpiresAt)));
  assert.ok(Number.isFinite(basisAt) && Number.isFinite(freshUntil) && basisAt + 1_000 < freshUntil);
  const approvedAt = new Date(basisAt + 1_000).toISOString();
  candidate.value.sourceSnapshots = candidate.value.sourceSnapshotIds.map((snapshotId) => deriveReleaseProjection({ snapshot: ledger.value.find((row) => row.snapshotId === snapshotId), sourceInventory: inventory.value, governancePolicy: governance.value, governancePolicyBytes: governance.body, freshnessPolicy: freshness.value, nowMillis: Date.parse(approvedAt) }));
  const selectedSnapshotIds = new Set(candidate.value.sourceSnapshotIds);
  candidate.value.sourceSnapshotSetHash = sha(Buffer.from(JSON.stringify(
    ledger.value.filter(({ snapshotId }) => selectedSnapshotIds.has(snapshotId)),
  )));
  const inventoryBytes = Buffer.from(`${JSON.stringify(inventory.value, null, 2)}\n`);
  candidate.value.sourceInventorySha256 = sha(Buffer.from(JSON.stringify(inventory.value)));
  candidate.value.networkEdgeEvidence.sourceInventory.sha256 = sha(inventoryBytes);
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate.value, null, 2)}\n`);
  const scopeBytes = Buffer.from(`${JSON.stringify(scope.value, null, 2)}\n`);
  const ledgerBytes = Buffer.from(`${JSON.stringify(ledger.value, null, 2)}\n`);
  const rawObjectSha256 = sha(rawBytes); const objectKey = `source-raw/seoul-metro-transfer-distance-duration/20260712/${rawObjectSha256}.json`;
  const receipt = { schemaVersion: 1, artifactKind: "seoul-transfer-raw-object-receipt", sourceId: observation.manifest.sourceId, snapshotId: "seoul-metro-transfer-distance-duration-20260712T150000000Z", snapshotRawSha256: observation.manifest.rawSha256, capturedAt, manifestSha256: sha(observation.manifestBytes), observationSha256: sha(observation.observationBytes), rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/${objectKey}`, rawObjectSha256, ociNamespace: "axvym6vk8g7i", bucket: "easysubway-datapacks", objectKey, capturedDate: "20260712", byteSize: rawBytes.length, storedAt: "2026-07-12T15:00:01.000Z", rawRetentionExpiresAt: "2026-10-10T15:00:00.000Z" };
  return { observation, receipt, metrics, metricsBytes: bytes(metrics), applicability, applicabilityBytes: bytes(applicability), inventory: inventory.value, inventoryBytes, scope: scope.value, scopeBytes, ledger: ledger.value, ledgerBytes, candidate: candidate.value, candidateBytes, governancePolicy: governance.value, governancePolicyBytes: governance.body, freshnessPolicy: freshness.value, freshnessPolicyBytes: freshness.body, canonicalPack: pack.value, canonicalPackBytes: pack.body, approvedAt };
}

function sort(value, omit) { if (Array.isArray(value)) return value.map((item) => sort(item, omit)); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).filter((key) => key !== omit).sort().map((key) => [key, sort(value[key], omit)])); return value; }

test("operation journal commits exactly five transfer-registration targets", async () => {
  await assert.rejects(commitTransferRegistrationOutputs({}), /repositoryRoot is required/);
});

test("journal commits all five targets and rolls PREPARED failures back", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "transfer-registration-")); t.after(() => rm(root, { recursive: true, force: true }));
  const relatives = ["tools/datapack/sources/seoul-metro-transfer-distance-duration-20260712T150000000Z.json", "tools/datapack/source-inventory.json", "release/product-gates/production-datapack-scope.json", "tools/datapack/release/source-snapshots.json", "tools/datapack/release/candidate-build-spec.json"];
  for (const relative of relatives) await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  for (const relative of relatives.slice(1)) await writeFile(path.join(root, relative), "before");
  const outputs = relatives.map((relative, index) => ({ relative, bytes: Buffer.from(`after-${index}`), prestateBytes: index === 0 ? null : Buffer.from("before") }));
  await assert.rejects(commitTransferRegistrationOutputs({ repositoryRoot: root, outputs, failAfter: 2 }), /injected/);
  assert.equal(await readFile(path.join(root, relatives[1]), "utf8"), "before");
  await commitTransferRegistrationOutputs({ repositoryRoot: root, outputs });
  assert.equal(await readFile(path.join(root, relatives[0]), "utf8"), "after-0");
  assert.equal(await readFile(path.join(root, relatives[4]), "utf8"), "after-4");
});

test("forward CAS preserves a foreign replacement before the first target write", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "transfer-registration-cas-")); t.after(() => rm(root, { recursive: true, force: true }));
  const relatives = ["tools/datapack/sources/seoul-metro-transfer-distance-duration-20260712T150000000Z.json", "tools/datapack/source-inventory.json", "release/product-gates/production-datapack-scope.json", "tools/datapack/release/source-snapshots.json", "tools/datapack/release/candidate-build-spec.json"];
  for (const relative of relatives) await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  for (const relative of relatives.slice(1)) await writeFile(path.join(root, relative), "before");
  const outputs = relatives.map((relative, index) => ({ relative, bytes: Buffer.from(`after-${index}`), prestateBytes: index === 0 ? null : Buffer.from("before") }));
  const target = path.join(root, relatives[1]);
  await assert.rejects(commitTransferRegistrationOutputs({ repositoryRoot: root, outputs, beforeWrite: async ({ index }) => { if (index === 1) await writeFile(target, "foreign"); } }), /preserves foreign replacement/);
  assert.equal(await readFile(target, "utf8"), "foreign");
});

test("forward CAS preserves an interleaved foreign replacement after temp fsync", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "transfer-registration-publish-cas-")); t.after(() => rm(root, { recursive: true, force: true }));
  const relatives = ["tools/datapack/sources/seoul-metro-transfer-distance-duration-20260712T150000000Z.json", "tools/datapack/source-inventory.json", "release/product-gates/production-datapack-scope.json", "tools/datapack/release/source-snapshots.json", "tools/datapack/release/candidate-build-spec.json"];
  for (const relative of relatives) await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  for (const relative of relatives.slice(1)) await writeFile(path.join(root, relative), "before");
  const outputs = relatives.map((relative, index) => ({ relative, bytes: Buffer.from(`after-${index}`), prestateBytes: index === 0 ? null : Buffer.from("before") })); const target = path.join(root, relatives[1]);
  await assert.rejects(commitTransferRegistrationOutputs({ repositoryRoot: root, outputs, beforePublish: async ({ index }) => { if (index === 1) await writeFile(target, "foreign-after-fsync"); } }), /preserves foreign replacement/);
  assert.equal(await readFile(target, "utf8"), "foreign-after-fsync");
  assert.ok(await readFile(path.join(root, "tools/datapack/.seoul-transfer-registration-transaction.json")));
});

test("PREPARED rollback and COMMITTED forward recovery preserve foreign replacements and journals", async (t) => {
  const setup = async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "transfer-registration-recovery-"));
    const relatives = ["tools/datapack/sources/seoul-metro-transfer-distance-duration-20260712T150000000Z.json", "tools/datapack/source-inventory.json", "release/product-gates/production-datapack-scope.json", "tools/datapack/release/source-snapshots.json", "tools/datapack/release/candidate-build-spec.json"];
    for (const relative of relatives) await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    for (const relative of relatives.slice(1)) await writeFile(path.join(root, relative), "before");
    return { root, relatives, outputs: relatives.map((relative, index) => ({ relative, bytes: Buffer.from(`after-${index}`), prestateBytes: index === 0 ? null : Buffer.from("before") })) };
  };
  const prepared = await setup(); t.after(() => rm(prepared.root, { recursive: true, force: true }));
  const preparedTarget = path.join(prepared.root, prepared.relatives[0]);
  await assert.rejects(commitTransferRegistrationOutputs({ repositoryRoot: prepared.root, outputs: prepared.outputs, failAfter: 0, beforeRecoveryMutation: async ({ state, file, phase }) => { if (state === "PREPARED" && phase === "before-remove" && file === preparedTarget) await writeFile(file, "foreign-prepared"); } }), /preserves foreign replacement/);
  assert.equal(await readFile(preparedTarget, "utf8"), "foreign-prepared");
  assert.ok(await readFile(path.join(prepared.root, "tools/datapack/.seoul-transfer-registration-transaction.json")));

  const committed = await setup(); t.after(() => rm(committed.root, { recursive: true, force: true }));
  const committedTarget = path.join(committed.root, committed.relatives[1]);
  await assert.rejects(commitTransferRegistrationOutputs({ repositoryRoot: committed.root, outputs: committed.outputs, beforeCommittedRecovery: async () => writeFile(committedTarget, "foreign-committed") }), /preserves foreign replacement/);
  assert.equal(await readFile(committedTarget, "utf8"), "foreign-committed");
  assert.ok(await readFile(path.join(committed.root, "tools/datapack/.seoul-transfer-registration-transaction.json")));
});

test("actual composition emits only the five targets and appends TRANSFER seventh", async () => {
  const input = compositionFixture();
  const outputs = buildTransferRegistrationOutputs(input);
  assert.equal(outputs.length, 5);
  const candidate = JSON.parse(outputs.find(({ relative }) => relative.endsWith("candidate-build-spec.json")).bytes);
  assert.equal(candidate.sourceSnapshots.at(-1).sourceId, "seoul-metro-transfer-distance-duration");
  const ledger = JSON.parse(outputs.find(({ relative }) => relative.endsWith("source-snapshots.json")).bytes);
  assert.equal(ledger.at(-1).observedAt, "2026-07-12T15:00:00.000Z");
  const inventory = JSON.parse(outputs.find(({ relative }) => relative.endsWith("source-inventory.json")).bytes);
  assert.deepEqual(deriveReleaseProjection({ snapshot: ledger.at(-1), sourceInventory: inventory, governancePolicy: input.governancePolicy, governancePolicyBytes: input.governancePolicyBytes, freshnessPolicy: input.freshnessPolicy, nowMillis: Date.parse(input.approvedAt) }), candidate.sourceSnapshots.at(-1));
  const scope = JSON.parse(outputs.find(({ relative }) => relative.endsWith("production-datapack-scope.json")).bytes);
  assert.equal(scope.productionSourceSet.optionalAccessibilitySourceIds.includes("seoul-metro-transfer-distance-duration"), false);
  assert.equal(scope.productionSourceSet.excludedFromV1SupportClaims.includes("seoul-metro-transfer-distance-duration"), false);
});

test("replacement head는 selected append-only ledger order hash를 사용한다", () => {
  const input = compositionFixture();
  const selectedIds = new Set(input.candidate.sourceSnapshotIds);
  const selectedInLedgerOrder = input.ledger.filter(({ snapshotId }) => selectedIds.has(snapshotId));
  const selectedInCandidateOrder = input.candidate.sourceSnapshotIds.map((snapshotId) => input.ledger.find((row) => row.snapshotId === snapshotId));
  assert.notDeepEqual(selectedInLedgerOrder.map(({ snapshotId }) => snapshotId), selectedInCandidateOrder.map(({ snapshotId }) => snapshotId));
  input.candidate.sourceSnapshotSetHash = sha(Buffer.from(JSON.stringify(selectedInLedgerOrder)));
  const outputs = buildTransferRegistrationOutputs(input);
  assert.equal(outputs.length, 5);
  const outputLedger = JSON.parse(outputs.find(({ relative }) => relative.endsWith("source-snapshots.json")).bytes);
  const outputCandidate = JSON.parse(outputs.find(({ relative }) => relative.endsWith("candidate-build-spec.json")).bytes);
  const outputSelectedIds = new Set(outputCandidate.sourceSnapshotIds);
  const outputInLedgerOrder = outputLedger.filter(({ snapshotId }) => outputSelectedIds.has(snapshotId));
  const outputInCandidateOrder = outputCandidate.sourceSnapshotIds.map((snapshotId) => outputLedger.find((row) => row.snapshotId === snapshotId));
  assert.notDeepEqual(outputInLedgerOrder.map(({ snapshotId }) => snapshotId), outputInCandidateOrder.map(({ snapshotId }) => snapshotId));
  assert.equal(outputCandidate.sourceSnapshotSetHash, sha(Buffer.from(JSON.stringify(outputInLedgerOrder))));
  assert.notEqual(outputCandidate.sourceSnapshotSetHash, sha(Buffer.from(JSON.stringify(outputInCandidateOrder))));

  const drift = compositionFixture();
  drift.candidate.sourceSnapshotSetHash = sha(Buffer.from(JSON.stringify(selectedInCandidateOrder)));
  assert.throws(() => buildTransferRegistrationOutputs(drift), /transfer pre-candidate ledger or inventory binding mismatch/);
});

test("commit rejects drift from the authenticated composition prestate without mutation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "transfer-registration-authenticated-prestate-")); t.after(() => rm(root, { recursive: true, force: true }));
  const relatives = ["tools/datapack/sources/seoul-metro-transfer-distance-duration-20260712T150000000Z.json", "tools/datapack/source-inventory.json", "release/product-gates/production-datapack-scope.json", "tools/datapack/release/source-snapshots.json", "tools/datapack/release/candidate-build-spec.json"];
  for (const relative of relatives) await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  for (const relative of relatives.slice(1)) await writeFile(path.join(root, relative), "before");
  const outputs = relatives.map((relative, index) => ({ relative, bytes: Buffer.from(`after-${index}`), prestateBytes: index === 0 ? null : Buffer.from("before") }));
  await writeFile(path.join(root, relatives[1]), "foreign");
  await assert.rejects(commitTransferRegistrationOutputs({ repositoryRoot: root, outputs }), /preserves foreign replacement/);
  await assert.rejects(readFile(path.join(root, relatives[0])), { code: "ENOENT" });
  assert.equal(await readFile(path.join(root, relatives[1]), "utf8"), "foreign");
  await assert.rejects(readFile(path.join(root, "tools/datapack/.seoul-transfer-registration-transaction.json")), { code: "ENOENT" });
});

test("cross-paired applicability identity fails before transaction outputs", () => {
  const input = compositionFixture();
  input.applicability.transferTopologyMetricsIdentity.artifactSha256 = sha("different-metrics");
  const { artifactSha256: _old, ...resealed } = input.applicability;
  input.applicability.artifactSha256 = sha(bytes(resealed));
  input.applicabilityBytes = bytes(input.applicability);
  assert.throws(() => buildTransferRegistrationOutputs(input), /transfer applicability identity mismatch/);
});

test("governance-derived current projection drift rejects registration before outputs", () => {
  const input = compositionFixture();
  input.candidate.sourceSnapshots[0].governancePolicyVersion = "2099-01-01";
  assert.throws(() => buildTransferRegistrationOutputs(input), /transfer pre-candidate projection mismatch/);
});

test("receipt storage after approval rejects registration before outputs", () => {
  const input = compositionFixture();
  input.receipt.storedAt = "2026-08-16T03:00:00.000Z";
  assert.throws(() => buildTransferRegistrationOutputs(input), /transfer retention derivation mismatch/);
});
