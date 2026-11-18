import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalJson } from "./lib/manifest-validation.mjs";

import { buildTransferRegistrationOutputs, commitTransferRegistrationOutputs } from "./register-current-seoul-transfer-source.mjs";
import { buildApplicability } from "./build-current-capital-transfer-topology-applicability.mjs";
import { deriveReleaseProjection } from "./rebind-current-candidate-source-snapshots.mjs";
import { copySyntheticCurrentPublicRouteMapRepository, nextSyntheticCurrentStaticNetworkNow } from "./test-fixtures/current-public-route-map-successor.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const bytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const transferSnapshotId = (capturedAt) => `seoul-metro-transfer-distance-duration-${capturedAt.replaceAll(/[-:.]/gu, "")}`;
// journal 테스트는 합성 출력만 쓰므로 epoch 시각에서 파생한 snapshot 이름을 한 곳에서 정한다(실제 수집 시각 리터럴 없음).
const journalTargets = () => [`tools/datapack/sources/${transferSnapshotId(new Date(0).toISOString())}.json`, "tools/datapack/source-inventory.json", "release/product-gates/production-datapack-scope.json", "tools/datapack/release/source-snapshots.json", "tools/datapack/release/candidate-build-spec.json"];
async function compositionFixture(t, { approvalDelayMs = 0, captureLeadMs = 60 * 60 * 1000 } = {}) {
  const sourceId = "seoul-metro-transfer-distance-duration"; const rawBytes = Buffer.from("raw");
  const root = process.cwd();
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "transfer-public-successor-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  await copySyntheticCurrentPublicRouteMapRepository(root, fixtureRoot, {
    now: await nextSyntheticCurrentStaticNetworkNow(root),
  });
  const load = (relative, base = fixtureRoot) => {
    const body = readFileSync(path.join(base, relative));
    return { body, value: JSON.parse(body) };
  };
  const inventory = load("tools/datapack/source-inventory.json"); const candidate = load("tools/datapack/release/candidate-build-spec.json"); const ledger = load("tools/datapack/release/source-snapshots.json"); const scope = load("release/product-gates/production-datapack-scope.json"); const governance = load("tools/datapack/source-governance-policy.json"); const freshness = load("release/product-gates/datapack-freshness-sla.json"); const pack = load("tools/datapack/release/capital-production-canonical-pack.json");
  const publicTopologySnapshotId = inventory.value.sources.find(({ id }) => id === "seoul-metro-route-map-positions")
    ?.routeMapAdmissionEvidence?.currentTopologyAdmission?.topologySnapshotId;
  const publicTopology = load(`tools/datapack/sources/${publicTopologySnapshotId}.json`).value;
  assert.equal(publicTopology.lines.length, 22);
  assert.equal(publicTopology.lines.reduce((count, line) => count + line.edgeCount, 0), 1_438);
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
  const selectedRows = candidate.value.sourceSnapshotIds.map((snapshotId) => {
    const matches = ledger.value.filter((row) => row.snapshotId === snapshotId);
    assert.equal(matches.length, 1, `selected source snapshot identity: ${snapshotId}`);
    return matches[0];
  });
  const basisAt = Math.max(...selectedRows.flatMap((entry) => [
    entry.retrievedAt, entry.sourceUpdatedAt, entry.capturedAt, entry.rawReceipt?.storedAt,
  ].filter(Boolean).map(Date.parse)));
  const freshUntil = Math.min(...selectedRows.map(({ freshnessExpiresAt }) => Date.parse(freshnessExpiresAt)));
  assert.ok(Number.isFinite(basisAt) && Number.isFinite(freshUntil) && basisAt + 1_000 + approvalDelayMs < freshUntil);
  const approvedAt = new Date(basisAt + 1_000 + approvalDelayMs).toISOString();
  // 수집·보관 시각은 고정 달력 리터럴이 아니라 데이터에서 파생된 승인 시각과 정책의 보관 일수에서 독립 계산한다.
  const approvedMillis = Date.parse(approvedAt);
  const capturedAt = new Date(approvedMillis - captureLeadMs).toISOString();
  const storedAt = new Date(approvedMillis - captureLeadMs + 1_000).toISOString();
  const retentionDays = governance.value.retentionClasses.find(({ id }) => id === "standard-90d").retentionDays;
  const rawRetentionExpiresAt = new Date(Date.parse(capturedAt) + retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const capturedStamp = capturedAt.replaceAll(/[-:.]/gu, "");
  const observation = { manifest: { sourceId, capturedAt, rawSha256: sha(rawBytes), contentSha256: sha("content"), schemaSha256: sha("schema"), endpointSha256: sha("endpoint"), rowCount: 145, freshnessDate: "2025-12-31", credentialRedacted: true }, manifestBytes: Buffer.from("manifest"), observationBytes: Buffer.from("observation"), rawBytes };
  const metrics = load("tools/datapack/release/current-transfer-topology-metrics.json", root).value;
  metrics.canonicalIdentity.canonicalPackSha256 = sha(pack.body);
  metrics.sourceIdentity = { ...metrics.sourceIdentity, sourceId: observation.manifest.sourceId, endpointSha256: observation.manifest.endpointSha256, manifestSha256: sha(observation.manifestBytes), observationSha256: sha(observation.observationBytes), rawSnapshotSha256: sha(rawBytes), rawSha256: observation.manifest.rawSha256, contentSha256: observation.manifest.contentSha256, schemaSha256: observation.manifest.schemaSha256, rowCount: 145, capturedAt, freshnessDate: "2025-12-31" };
  metrics.artifactSha256 = sha(Buffer.from(canonicalJson(sort(metrics, "artifactSha256"))));
  const applicability = buildApplicability({
    canonicalPack: pack.value, canonicalPackBytes: pack.body,
    transferTopologyMetrics: metrics, metricsBytes: Buffer.from(`${canonicalJson(metrics)}\n`),
  });
  const { artifactSha256: ignoredArtifact, ...applicabilityPayload } = applicability;
  assert.equal(metrics.canonicalIdentity.canonicalPackSha256, sha(pack.body));
  assert.equal(metrics.artifactSha256, sha(Buffer.from(canonicalJson(sort(metrics, "artifactSha256")))));
  assert.equal(applicability.artifactSha256, sha(Buffer.from(`${canonicalJson(applicabilityPayload)}\n`)));
  assert.equal(applicability.productionUseAllowed, false); assert.equal(applicability.candidateBinding, null);
  assert.deepEqual(applicability.canonicalIdentity, metrics.canonicalIdentity); assert.deepEqual(applicability.sourceIdentity, metrics.sourceIdentity);
  assert.equal(applicability.stateSummary.APPLICABLE_TRANSFER_ENDPOINT, 160); assert.equal(applicability.stateSummary.NOT_APPLICABLE_IN_CANONICAL_PAIR_SET, 538); // #872 S2
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
  const rawObjectSha256 = sha(rawBytes); const objectKey = `source-raw/seoul-metro-transfer-distance-duration/${capturedStamp.slice(0, 8)}/${rawObjectSha256}.json`;
  const receipt = { schemaVersion: 1, artifactKind: "seoul-transfer-raw-object-receipt", sourceId: observation.manifest.sourceId, snapshotId: transferSnapshotId(capturedAt), snapshotRawSha256: observation.manifest.rawSha256, capturedAt, manifestSha256: sha(observation.manifestBytes), observationSha256: sha(observation.observationBytes), rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/${objectKey}`, rawObjectSha256, ociNamespace: "axvym6vk8g7i", bucket: "easysubway-datapacks", objectKey, capturedDate: capturedStamp.slice(0, 8), byteSize: rawBytes.length, storedAt, rawRetentionExpiresAt };
  return { observation, receipt, metrics, metricsBytes: bytes(metrics), applicability, applicabilityBytes: bytes(applicability), inventory: inventory.value, inventoryBytes, scope: scope.value, scopeBytes, ledger: ledger.value, ledgerBytes, candidate: candidate.value, candidateBytes, governancePolicy: governance.value, governancePolicyBytes: governance.body, freshnessPolicy: freshness.value, freshnessPolicyBytes: freshness.body, canonicalPack: pack.value, canonicalPackBytes: pack.body, approvedAt };
}

function sort(value, omit) { if (Array.isArray(value)) return value.map((item) => sort(item, omit)); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).filter((key) => key !== omit).sort().map((key) => [key, sort(value[key], omit)])); return value; }

test("operation journal commits exactly five transfer-registration targets", async () => {
  await assert.rejects(commitTransferRegistrationOutputs({}), /repositoryRoot is required/);
});

test("journal commits all five targets and rolls PREPARED failures back", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "transfer-registration-")); t.after(() => rm(root, { recursive: true, force: true }));
  const relatives = journalTargets();
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
  const relatives = journalTargets();
  for (const relative of relatives) await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  for (const relative of relatives.slice(1)) await writeFile(path.join(root, relative), "before");
  const outputs = relatives.map((relative, index) => ({ relative, bytes: Buffer.from(`after-${index}`), prestateBytes: index === 0 ? null : Buffer.from("before") }));
  const target = path.join(root, relatives[1]);
  await assert.rejects(commitTransferRegistrationOutputs({ repositoryRoot: root, outputs, beforeWrite: async ({ index }) => { if (index === 1) await writeFile(target, "foreign"); } }), /preserves foreign replacement/);
  assert.equal(await readFile(target, "utf8"), "foreign");
});

test("forward CAS preserves an interleaved foreign replacement after temp fsync", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "transfer-registration-publish-cas-")); t.after(() => rm(root, { recursive: true, force: true }));
  const relatives = journalTargets();
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
    const relatives = journalTargets();
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

test("actual composition preserves scope-selected predecessors and appends terminal TRANSFER", async (t) => {
  const input = await compositionFixture(t);
  const outputs = buildTransferRegistrationOutputs(input);
  assert.equal(outputs.length, 5);
  const candidate = JSON.parse(outputs.find(({ relative }) => relative.endsWith("candidate-build-spec.json")).bytes);
  const predecessorSourceIds = input.scope.productionSourceSet.requiredSourceIds;
  assert.equal(candidate.sourceSnapshots.length, predecessorSourceIds.length + 1);
  assert.deepEqual(new Set(candidate.sourceSnapshots.slice(0, -1).map(({ sourceId }) => sourceId)), new Set(predecessorSourceIds));
  assert.deepEqual(candidate.sourceSnapshots.slice(0, -1), input.candidate.sourceSnapshots);
  const nextScope = JSON.parse(outputs.find(({ relative }) => relative.endsWith("production-datapack-scope.json")).bytes);
  assert.deepEqual(nextScope.productionSourceSet.requiredSourceIds, [
    ...predecessorSourceIds, "seoul-metro-transfer-distance-duration",
  ]);
  assert.equal(candidate.sourceSnapshots.at(-1).sourceId, "seoul-metro-transfer-distance-duration");
  const ledger = JSON.parse(outputs.find(({ relative }) => relative.endsWith("source-snapshots.json")).bytes);
  assert.equal(ledger.at(-1).observedAt, input.observation.manifest.capturedAt);
  const inventory = JSON.parse(outputs.find(({ relative }) => relative.endsWith("source-inventory.json")).bytes);
  assert.deepEqual(deriveReleaseProjection({ snapshot: ledger.at(-1), sourceInventory: inventory, governancePolicy: input.governancePolicy, governancePolicyBytes: input.governancePolicyBytes, freshnessPolicy: input.freshnessPolicy, nowMillis: Date.parse(input.approvedAt) }), candidate.sourceSnapshots.at(-1));
  const scope = JSON.parse(outputs.find(({ relative }) => relative.endsWith("production-datapack-scope.json")).bytes);
  assert.equal(scope.productionSourceSet.optionalAccessibilitySourceIds.includes("seoul-metro-transfer-distance-duration"), false);
  assert.equal(scope.productionSourceSet.excludedFromV1SupportClaims.includes("seoul-metro-transfer-distance-duration"), false);
});

test("승인 시각이 선택 원천 시계보다 하루 늦어도 등록이 성공하고 지연된 승인 시각이 산출물에 반영된다(고정 수집 시각 금지)", async (t) => {
  const delayMs = 24 * 60 * 60 * 1000;
  const input = await compositionFixture(t, { approvalDelayMs: delayMs });
  const undelayed = await compositionFixture(t);
  assert.equal(Date.parse(input.approvedAt) - Date.parse(undelayed.approvedAt), delayMs);
  const outputs = buildTransferRegistrationOutputs(input);
  assert.equal(outputs.length, 5);
  const ledger = JSON.parse(outputs.find(({ relative }) => relative.endsWith("source-snapshots.json")).bytes);
  const inventory = JSON.parse(outputs.find(({ relative }) => relative.endsWith("source-inventory.json")).bytes);
  const evidence = inventory.sources.find(({ id }) => id === "seoul-metro-transfer-distance-duration").transferAdmissionEvidence;
  assert.equal(evidence.approvedAt, input.approvedAt);
  assert.equal(ledger.at(-1).observedAt, input.observation.manifest.capturedAt);
  assert.equal(evidence.observedAt, input.observation.manifest.capturedAt);
  // 수집 시각은 지연된 승인 시각보다 이르고, 연간 신선 만료는 수집 시각 + 1년이다(입력에서 직접 계산).
  assert.ok(Date.parse(evidence.observedAt) < Date.parse(input.approvedAt));
  const expectedFreshUntil = new Date(Date.parse(evidence.observedAt)); expectedFreshUntil.setUTCFullYear(expectedFreshUntil.getUTCFullYear() + 1);
  assert.equal(evidence.freshUntil, expectedFreshUntil.toISOString());
});

// 보관 만료(standard-90d) 경계: 승인 시각 == 만료는 거부, 1ms 앞은 통과. 수집 시각을 승인 시각에서 retentionDays만큼 앞에 둔다.
test("승인 시각이 raw 보관 만료와 같으면 거부하고 1ms 앞이면 통과한다", async (t) => {
  const probe = await compositionFixture(t);
  const retentionDays = probe.governancePolicy.retentionClasses.find(({ id }) => id === "standard-90d").retentionDays;
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  const atExpiry = await compositionFixture(t, { captureLeadMs: retentionMs });
  assert.equal(Date.parse(atExpiry.receipt.rawRetentionExpiresAt), Date.parse(atExpiry.approvedAt));
  assert.throws(() => buildTransferRegistrationOutputs(atExpiry), /transfer retention derivation mismatch/);
  const beforeExpiry = await compositionFixture(t, { captureLeadMs: retentionMs - 1 });
  assert.equal(Date.parse(beforeExpiry.receipt.rawRetentionExpiresAt) - Date.parse(beforeExpiry.approvedAt), 1);
  assert.equal(buildTransferRegistrationOutputs(beforeExpiry).length, 5);
  const afterExpiry = await compositionFixture(t, { captureLeadMs: retentionMs + 1 });
  assert.throws(() => buildTransferRegistrationOutputs(afterExpiry), /transfer retention derivation mismatch/);
});

// 연간(P1Y) 신선 만료는 90일 보관 만료보다 늦어서, 신선 만료 이후 승인은 보관 만료 판정이 먼저 거부한다.
// 따라서 신선 절 단독 제거 변이는 관측 가능한 차이가 없다(동치). 이 선행 조건이 깨지면(정책이 바뀌어 신선 창이 보관보다 짧아지면) 이 테스트가 실패해 신선 경계 테스트를 요구한다.
test("신선 만료 이후 승인은 거부되고 신선 창은 보관 창보다 길다는 선행 조건을 확인한다", async (t) => {
  const probe = await compositionFixture(t);
  const retentionMs = probe.governancePolicy.retentionClasses.find(({ id }) => id === "standard-90d").retentionDays * 24 * 60 * 60 * 1000;
  const yearEnd = (capturedAt) => { const end = new Date(Date.parse(capturedAt)); end.setUTCFullYear(end.getUTCFullYear() + 1); return end.getTime(); };
  assert.equal(probe.freshnessPolicy.sourceClasses.find(({ id }) => id === "annual_official_file").reverificationCadence, "P1Y");
  const freshLeadMs = yearEnd(probe.observation.manifest.capturedAt) - Date.parse(probe.observation.manifest.capturedAt);
  assert.ok(freshLeadMs > retentionMs);
  const afterFreshUntil = await compositionFixture(t, { captureLeadMs: freshLeadMs + 24 * 60 * 60 * 1000 });
  assert.ok(Date.parse(afterFreshUntil.approvedAt) > yearEnd(afterFreshUntil.observation.manifest.capturedAt));
  assert.throws(() => buildTransferRegistrationOutputs(afterFreshUntil), /transfer retention derivation mismatch/);
});

test("transfer registration은 candidate의 public 노선도와 다른 canonical content를 거부한다", async (t) => {
  const input = await compositionFixture(t);
  const row = input.canonicalPack.packs[0].routeMapPositions.find(
    ({ sourceId }) => sourceId === "seoul-metro-route-map-positions",
  );
  row.x += 1;
  input.canonicalPackBytes = Buffer.from(`${JSON.stringify(input.canonicalPack, null, 2)}\n`);
  input.metrics.canonicalIdentity.canonicalPackSha256 = sha(input.canonicalPackBytes);
  input.metrics.artifactSha256 = sha(Buffer.from(canonicalJson(sort(input.metrics, "artifactSha256"))));
  input.metricsBytes = bytes(input.metrics);
  input.applicability.canonicalIdentity = structuredClone(input.metrics.canonicalIdentity);
  input.applicability.transferTopologyMetricsIdentity.artifactSha256 = input.metrics.artifactSha256;
  const { artifactSha256: _old, ...applicabilityPayload } = input.applicability;
  input.applicability.artifactSha256 = sha(Buffer.from(`${canonicalJson(applicabilityPayload)}\n`));
  input.applicabilityBytes = bytes(input.applicability);

  assert.throws(
    () => buildTransferRegistrationOutputs(input),
    /complete current public Seoul route map/,
  );
});

test("replacement head는 selected append-only ledger order hash를 사용한다", async (t) => {
  const input = await compositionFixture(t);
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

  const drift = await compositionFixture(t);
  drift.candidate.sourceSnapshotSetHash = sha(Buffer.from(JSON.stringify(selectedInCandidateOrder)));
  assert.throws(() => buildTransferRegistrationOutputs(drift), /transfer pre-candidate ledger or inventory binding mismatch/);
});

test("commit rejects drift from the authenticated composition prestate without mutation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "transfer-registration-authenticated-prestate-")); t.after(() => rm(root, { recursive: true, force: true }));
  const relatives = journalTargets();
  for (const relative of relatives) await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  for (const relative of relatives.slice(1)) await writeFile(path.join(root, relative), "before");
  const outputs = relatives.map((relative, index) => ({ relative, bytes: Buffer.from(`after-${index}`), prestateBytes: index === 0 ? null : Buffer.from("before") }));
  await writeFile(path.join(root, relatives[1]), "foreign");
  await assert.rejects(commitTransferRegistrationOutputs({ repositoryRoot: root, outputs }), /preserves foreign replacement/);
  await assert.rejects(readFile(path.join(root, relatives[0])), { code: "ENOENT" });
  assert.equal(await readFile(path.join(root, relatives[1]), "utf8"), "foreign");
  await assert.rejects(readFile(path.join(root, "tools/datapack/.seoul-transfer-registration-transaction.json")), { code: "ENOENT" });
});

test("cross-paired applicability identity fails before transaction outputs", async (t) => {
  const input = await compositionFixture(t);
  input.applicability.transferTopologyMetricsIdentity.artifactSha256 = sha("different-metrics");
  const { artifactSha256: _old, ...resealed } = input.applicability;
  input.applicability.artifactSha256 = sha(bytes(resealed));
  input.applicabilityBytes = bytes(input.applicability);
  assert.throws(() => buildTransferRegistrationOutputs(input), /transfer applicability identity mismatch/);
});

test("governance-derived current projection drift rejects registration before outputs", async (t) => {
  const input = await compositionFixture(t);
  input.candidate.sourceSnapshots[0].governancePolicyVersion = "2099-01-01";
  assert.throws(() => buildTransferRegistrationOutputs(input), /transfer pre-candidate projection mismatch/);
});

test("receipt storage after approval rejects registration before outputs", async (t) => {
  const input = await compositionFixture(t);
  input.receipt.storedAt = new Date(Date.parse(input.approvedAt) + 1).toISOString();
  assert.throws(() => buildTransferRegistrationOutputs(input), /transfer retention derivation mismatch/);
});
