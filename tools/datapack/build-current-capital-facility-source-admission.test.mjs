import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { buildCurrentCapitalFacilitySourceAdmission, canonicalCurrentCapitalFacilitySourceAdmissionJson } from "./build-current-capital-facility-source-admission.mjs";
import { buildCurrentCapitalFacilityCollectionPlan, canonicalCurrentCapitalFacilityCollectionPlanJson } from "./build-current-capital-facility-collection-plan.mjs";
import { collectKricAccessibilitySnapshots } from "./collect-kric-accessibility-snapshots.mjs";
import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";
import { deriveReleaseProjection } from "./rebind-current-candidate-source-snapshots.mjs";
import { buildSnapshotDiff } from "./source-snapshot-policy.mjs";
import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";
import { deriveRawRetentionExpiresAt } from "./source-governance-policy.mjs";
import { copySyntheticCurrentPublicRouteMapRepository } from "./test-fixtures/current-public-route-map-successor.mjs";

const SOURCE_ROOT = import.meta.dirname;
const REPOSITORY_ROOT = path.resolve(SOURCE_ROOT, "../..");
const INITIAL_SOURCE_HEAD_AT = await selectedSourceHeadAt(SOURCE_ROOT);
const FIXTURE_REPOSITORY_ROOT = await mkdtemp(path.join(os.tmpdir(), "current-public-route-map-facility-"));
after(() => rm(FIXTURE_REPOSITORY_ROOT, { recursive: true, force: true }));
await copySyntheticCurrentPublicRouteMapRepository(REPOSITORY_ROOT, FIXTURE_REPOSITORY_ROOT, {
  now: new Date(INITIAL_SOURCE_HEAD_AT + 120_000),
});
const root = path.join(FIXTURE_REPOSITORY_ROOT, "tools/datapack");
const CURRENT_SOURCE_HEAD_AT = await selectedSourceHeadAt(root);
const STATIC_SOURCE_PATHS = new Set([
  "sources/kric-provider-code-catalog-20260228.json",
  "sources/kric-nationwide-route-rosters-20260730T203926676Z.json",
]);
test("producer-neutral FACILITY admission emits a mapping-derived closed matrix", async () => {
  const values = await fixture();
  const first = buildCurrentCapitalFacilitySourceAdmission(values);
  const second = buildCurrentCapitalFacilitySourceAdmission(values);
  const plan = JSON.parse(values.planBytes);
  assert.equal(first.cells.length, plan.stationLineProviderMappings.length);
  assert.equal(first.denominatorRows.length, first.cells.length * 3);
  assert.equal(first.materializerEvidenceRows.length, first.cells.length);
  assert.equal(new Set(first.cells.map(({ stationId }) => stationId)).size, plan.counts.stationCount);
  assert.equal(first.decision, "GO");
  assert.deepEqual(first.denominatorStateSummary, summarizeRows(first.denominatorRows, ["VERIFIED_PRESENT", "VERIFIED_ABSENT", "UNVERIFIED_EVIDENCE_BLOCKED"]));
  assert.deepEqual(first.cellStateSummary, summarizeRows(first.cells, ["ADMITTED_FACILITY_PRESENT", "ADMITTED_FACILITY_ABSENT", "ADMITTED_FACILITY_UNVERIFIED_BLOCKED"]));
  assert.deepEqual(first, second);
  assert.equal(canonicalCurrentCapitalFacilitySourceAdmissionJson(first), canonicalCurrentCapitalFacilitySourceAdmissionJson(second));
  const renderedDrift = structuredClone(first);
  renderedDrift.cells.reverse();
  renderedDrift.denominatorRows = renderedDrift.denominatorRows.reverse();
  renderedDrift.materializerEvidenceRows.reverse();
  rehash(renderedDrift);
  assert.throws(() => canonicalCurrentCapitalFacilitySourceAdmissionJson(renderedDrift));
  const nestedExtra = structuredClone(first);
  nestedExtra.cells[0].untrusted = true;
  rehash(nestedExtra);
  assert.throws(() => canonicalCurrentCapitalFacilitySourceAdmissionJson(nestedExtra));
  const summaryDrift = structuredClone(first);
  summaryDrift.cellStateSummary.ADMITTED_FACILITY_PRESENT += 1;
  rehash(summaryDrift);
  assert.throws(() => canonicalCurrentCapitalFacilitySourceAdmissionJson(summaryDrift));
  const materializerDrift = structuredClone(first);
  materializerDrift.materializerEvidenceRows[0].evidenceState = "VERIFIED_ABSENT";
  rehash(materializerDrift);
  assert.throws(() => canonicalCurrentCapitalFacilitySourceAdmissionJson(materializerDrift));
  const provenanceDrift = structuredClone(first);
  provenanceDrift.denominatorRows[0].snapshotId = "wrong";
  rehash(provenanceDrift);
  assert.throws(() => canonicalCurrentCapitalFacilitySourceAdmissionJson(provenanceDrift));
  const staleDrift = structuredClone(first);
  staleDrift.sourceIdentity.freshUntil = first.observedAt;
  rehash(staleDrift);
  assert.throws(() => canonicalCurrentCapitalFacilitySourceAdmissionJson(staleDrift));
  const pathDrift = structuredClone(first);
  pathDrift.sourceIdentity.snapshotPath = "tools/datapack/sources/wrong.json";
  rehash(pathDrift);
  assert.throws(() => canonicalCurrentCapitalFacilitySourceAdmissionJson(pathDrift));
});

test("current seven-source candidate evaluates projections at its published clock, not the active FACILITY clock", async () => {
  const files = Object.fromEntries(await Promise.all([
    "tools/datapack/release/capital-production-canonical-pack.json",
    "tools/datapack/nationwide-coverage-targets.json",
    "tools/datapack/sources/kric-provider-code-catalog-20260228.json",
    "tools/datapack/sources/kric-nationwide-route-rosters-20260730T203926676Z.json",
    "tools/datapack/source-inventory.json",
    "tools/datapack/release/candidate-build-spec.json",
    "tools/datapack/release/source-snapshots.json",
    "tools/datapack/source-governance-policy.json",
    "release/product-gates/datapack-freshness-sla.json",
  ].map(async (relative) => [relative, await readFile(path.join(REPOSITORY_ROOT, relative))])));
  const candidateBuildSpec = JSON.parse(files["tools/datapack/release/candidate-build-spec.json"]);
  const sourceInventory = JSON.parse(files["tools/datapack/source-inventory.json"]);
  const active = sourceInventory.sources.find(({ id }) => id === "kric-station-convenience-standard").accessibilityAdmissionEvidence;
  const plan = buildCurrentCapitalFacilityCollectionPlan({
    canonicalPackBytes: files["tools/datapack/release/capital-production-canonical-pack.json"],
    coverageTargetsBytes: files["tools/datapack/nationwide-coverage-targets.json"],
    providerCodeCatalogBytes: files["tools/datapack/sources/kric-provider-code-catalog-20260228.json"],
    routeRostersBytes: files["tools/datapack/sources/kric-nationwide-route-rosters-20260730T203926676Z.json"],
    sourceInventoryBytes: files["tools/datapack/source-inventory.json"],
  });
  const values = {
    observedAt: active.observedAt,
    candidateEvaluationAt: candidateBuildSpec.publishedAt,
    planBytes: Buffer.from(canonicalCurrentCapitalFacilityCollectionPlanJson(plan)),
    canonicalPackBytes: files["tools/datapack/release/capital-production-canonical-pack.json"],
    snapshotBytes: await readFile(path.join(REPOSITORY_ROOT, active.snapshotPath)),
    candidateBuildSpec,
    sourceInventoryBytes: files["tools/datapack/source-inventory.json"],
    sourceSnapshots: JSON.parse(files["tools/datapack/release/source-snapshots.json"]),
    governancePolicy: JSON.parse(files["tools/datapack/source-governance-policy.json"]),
    governancePolicyBytes: files["tools/datapack/source-governance-policy.json"],
    freshnessPolicy: JSON.parse(files["release/product-gates/datapack-freshness-sla.json"]),
  };
  assert.equal(buildCurrentCapitalFacilitySourceAdmission(values).decision, "GO");
  const unapprovedGovernance = structuredClone(values);
  const selectedKricId = unapprovedGovernance.candidateBuildSpec.sourceSnapshotIds.find((snapshotId) => snapshotId.startsWith("kric-station-convenience-standard-"));
  unapprovedGovernance.sourceSnapshots.find(({ snapshotId }) => snapshotId === selectedKricId).governancePolicySha256 = "0".repeat(64);
  assert.throws(() => buildCurrentCapitalFacilitySourceAdmission(unapprovedGovernance), /governance policy binding/u);
  assert.throws(() => buildCurrentCapitalFacilitySourceAdmission({ ...values, candidateEvaluationAt: "2026-08-26T03:54:09.250Z" }), /candidate evaluation clock mismatch/u);
  const beforeBasis = structuredClone(values);
  const timetableIndex = beforeBasis.candidateBuildSpec.sourceSnapshots.findIndex(({ sourceId }) => sourceId === "kric-subway-timetable");
  const futureTimetable = beforeBasis.sourceSnapshots.find(({ snapshotId }) =>
    snapshotId === beforeBasis.candidateBuildSpec.sourceSnapshotIds[timetableIndex]);
  futureTimetable.serviceEffectiveAt = new Date(Date.parse(beforeBasis.candidateEvaluationAt) + 1).toISOString();
  beforeBasis.candidateBuildSpec.sourceSnapshotSetHash = selectedLedgerHash(
    beforeBasis.sourceSnapshots,
    beforeBasis.candidateBuildSpec.sourceSnapshotIds,
  );
  assert.throws(() => buildCurrentCapitalFacilitySourceAdmission(beforeBasis), /candidate evaluation precedes selected basis/u);
  const receiptAfterPublication = structuredClone(values);
  receiptAfterPublication.sourceSnapshots.find(({ snapshotId }) => snapshotId === selectedKricId).rawReceipt.storedAt = new Date(Date.parse(candidateBuildSpec.publishedAt) + 1).toISOString();
  receiptAfterPublication.candidateBuildSpec.sourceSnapshotSetHash = selectedLedgerHash(receiptAfterPublication.sourceSnapshots, receiptAfterPublication.candidateBuildSpec.sourceSnapshotIds);
  assert.throws(() => buildCurrentCapitalFacilitySourceAdmission(receiptAfterPublication), /KRIC source time or governance mismatch/u);
});

test("exact terminal 03은 one blocked cell과 세 blocked denominator rows로 admission GO를 만든다", async () => {
  const values = await fixture({ mixed: true });
  const admission = buildCurrentCapitalFacilitySourceAdmission(values);
  const blocked = admission.cells.find(({ state }) => state === "ADMITTED_FACILITY_UNVERIFIED_BLOCKED");
  assert.ok(blocked);
  assert.equal(blocked.state, "ADMITTED_FACILITY_UNVERIFIED_BLOCKED");
  assert.deepEqual(admission.denominatorRows.filter(({ stationId, lineId }) => stationId === blocked.stationId && lineId === blocked.lineId)
    .map(({ state }) => state), Array(3).fill("UNVERIFIED_EVIDENCE_BLOCKED"));
  assert.equal(admission.materializerEvidenceRows.find(({ stationId, lineId }) => stationId === blocked.stationId && lineId === blocked.lineId).evidenceState, "UNVERIFIED_EVIDENCE_BLOCKED");
  assert.equal(admission.decision, "GO");

  const blockedIndex = admission.cells.indexOf(blocked);
  const partial = structuredClone(admission);
  partial.denominatorRows[blockedIndex * 3 + 1].state = "VERIFIED_ABSENT";
  refreshSummaries(partial); rehash(partial);
  assert.throws(() => canonicalCurrentCapitalFacilitySourceAdmissionJson(partial), /blocked terminal matrix/u);

  const relocated = structuredClone(admission);
  setAbsent(relocated, blockedIndex);
  setBlocked(relocated, blockedIndex === 0 ? 1 : 0);
  refreshSummaries(relocated); rehash(relocated);
  assert.doesNotThrow(() => canonicalCurrentCapitalFacilitySourceAdmissionJson(relocated));

  const duplicate = structuredClone(admission);
  setBlocked(duplicate, blockedIndex === 0 ? 1 : 0);
  refreshSummaries(duplicate); rehash(duplicate);
  assert.throws(() => canonicalCurrentCapitalFacilitySourceAdmissionJson(duplicate), /blocked terminal matrix/u);
});

test("producer-neutral FACILITY admission rejects representative identity and query drift before output", async () => {
  const values = await fixture();
  const cases = [
    (value) => { const snapshot = JSON.parse(value.snapshotBytes); snapshot.queries.pop(); snapshot.queryCount = snapshot.queries.length; value.snapshotBytes = Buffer.from(JSON.stringify(snapshot)); },
    (value) => { const snapshot = JSON.parse(value.snapshotBytes); snapshot.queries.push(structuredClone(snapshot.queries[0])); snapshot.queryCount = snapshot.queries.length; value.snapshotBytes = Buffer.from(JSON.stringify(snapshot)); },
    (value) => { const snapshot = JSON.parse(value.snapshotBytes); snapshot.queries[0].rows[0].gubun = "UNKNOWN"; value.snapshotBytes = Buffer.from(JSON.stringify(snapshot)); },
    (value) => { mutateInventory(value, (inventory) => { inventory.sources.find(({ id }) => id === "kric-station-convenience-standard").accessibilityAdmissionEvidence.snapshotId = "wrong"; }); },
    (value) => { currentKricLedger(value).rawReceipt.snapshotId = "wrong"; },
    (value) => { currentKricLedger(value).rawSha256 = "0".repeat(64); },
    (value) => { value.candidateBuildSpec.sourceSnapshotIds = []; },
    (value) => { value.candidateBuildSpec.sourceSnapshotSetHash = "0".repeat(64); },
    (value) => { value.candidateBuildSpec.sourceSnapshots.find(({ sourceId }) => sourceId !== "kric-station-convenience-standard").licenseStatus = "WRONG"; },
    (value) => { currentKricProjection(value).untrusted = true; },
    (value) => { currentKricLedger(value).freshnessExpiresAt = "2026-08-03T00:00:00.000Z"; },
    (value) => { currentKricProjection(value).rawRetentionExpiresAt = "2026-08-03T00:00:00.000Z"; },
    (value) => { currentKricLedger(value).rawReceipt.storedAt = "2026-08-03T00:02:00.000Z"; },
    (value) => { mutateInventory(value, (inventory) => { inventory.sources.find(({ id }) => id === "kric-station-convenience-standard").admissionEvidence.adminReviewRecordHash = "0".repeat(64); }); },
    (value) => { currentKricProjection(value).governancePolicySha256 = "wrong"; },
    (value) => {
      const pack = JSON.parse(value.canonicalPackBytes);
      pack.packs[0].stationLines.push({ stationId: "station-extra", lineId: JSON.parse(value.planBytes).stationLineProviderMappings[0].lineId });
      value.canonicalPackBytes = Buffer.from(`${JSON.stringify(pack)}\n`);
      const plan = JSON.parse(value.planBytes);
      plan.sourceIdentity.canonicalPackSha256 = sha256(value.canonicalPackBytes);
      const { planSha256: _, ...payload } = plan;
      plan.planSha256 = sha256(canonicalJson(payload));
      value.planBytes = Buffer.from(canonicalCurrentCapitalFacilityCollectionPlanJson(plan));
    },
    (value) => {
      const pack = JSON.parse(value.canonicalPackBytes);
      const mapping = JSON.parse(value.planBytes).stationLineProviderMappings[0];
      pack.packs[0].stationLines.push(structuredClone(pack.packs[0].stationLines.find(({ stationId, lineId }) => stationId === mapping.stationId && lineId === mapping.lineId)));
      value.canonicalPackBytes = Buffer.from(`${JSON.stringify(pack)}\n`);
      const plan = JSON.parse(value.planBytes);
      plan.sourceIdentity.canonicalPackSha256 = sha256(value.canonicalPackBytes);
      const { planSha256: _, ...payload } = plan;
      plan.planSha256 = sha256(canonicalJson(payload));
      value.planBytes = Buffer.from(canonicalCurrentCapitalFacilityCollectionPlanJson(plan));
    },
  ];
  for (const mutate of cases) {
    const current = structuredClone(values); current.planBytes = Buffer.from(values.planBytes); current.canonicalPackBytes = Buffer.from(values.canonicalPackBytes); current.snapshotBytes = Buffer.from(values.snapshotBytes); mutate(current);
    assert.throws(() => buildCurrentCapitalFacilitySourceAdmission(current));
  }
});

test("producer-neutral FACILITY admission accepts the current six-source derived projection", async () => {
  const values = await productionShapedFixture();
  const admission = buildCurrentCapitalFacilitySourceAdmission(values);
  assert.equal(admission.decision, "GO");
  assert.equal(admission.candidate.sourceSnapshotSetHash, values.candidateBuildSpec.sourceSnapshotSetHash);
});

test("replacement head의 source set hash는 selected append-only ledger order를 사용한다", async () => {
  const values = await fixture();
  const selectedIds = new Set(values.candidateBuildSpec.sourceSnapshotIds);
  const selectedLedger = values.sourceSnapshots.filter(({ snapshotId }) => selectedIds.has(snapshotId));
  const candidateOrder = values.candidateBuildSpec.sourceSnapshotIds.map((snapshotId) => values.sourceSnapshots.find((entry) => entry.snapshotId === snapshotId));
  assert.notDeepEqual(selectedLedger.map(({ snapshotId }) => snapshotId), candidateOrder.map(({ snapshotId }) => snapshotId));
  values.candidateBuildSpec.sourceSnapshotSetHash = sha256(JSON.stringify(selectedLedger));
  assert.equal(buildCurrentCapitalFacilitySourceAdmission(values).decision, "GO");

  const drift = structuredClone(values);
  drift.candidateBuildSpec.sourceSnapshotSetHash = sha256(JSON.stringify(candidateOrder));
  assert.throws(() => buildCurrentCapitalFacilitySourceAdmission(drift), /candidate source snapshot set identity mismatch/u);
});

test("producer-neutral FACILITY admission preserves the approved prior governance binding for unchanged sources", async () => {
  const values = await fixture();
  const productionSpec = JSON.parse(await readFile(path.join(root, "release/candidate-build-spec.json")));
  const kricIndex = values.candidateBuildSpec.sourceSnapshots.findIndex(({ sourceId }) => sourceId === "kric-station-convenience-standard");
  assert.notEqual(kricIndex, -1);
  for (let index = 0; index < values.candidateBuildSpec.sourceSnapshots.length; index += 1) {
    if (index === kricIndex) continue;
    values.candidateBuildSpec.sourceSnapshots[index].governancePolicyVersion = productionSpec.sourceSnapshots[index].governancePolicyVersion;
    values.candidateBuildSpec.sourceSnapshots[index].governancePolicySha256 = productionSpec.sourceSnapshots[index].governancePolicySha256;
  }
  assert.equal(buildCurrentCapitalFacilitySourceAdmission(values).decision, "GO");

  const drift = structuredClone(values);
  drift.candidateBuildSpec.sourceSnapshots[0].governancePolicySha256 = "0".repeat(64);
  assert.throws(() => buildCurrentCapitalFacilitySourceAdmission(drift), /projection mismatch/u);

  const priorKric = structuredClone(values);
  const kricProjection = priorKric.candidateBuildSpec.sourceSnapshots[kricIndex];
  const kricLedger = priorKric.sourceSnapshots.find(({ snapshotId }) => snapshotId === kricProjection.snapshotId);
  assert.ok(kricLedger);
  const priorBinding = priorKric.sourceSnapshots.find(({ sourceId, governancePolicySha256 }) =>
    sourceId === "kric-station-convenience-standard"
    && governancePolicySha256 === "13f8a78c0ae0f7bfa6817005f44a92be3131e6f6708a69a4024747478203beaa");
  assert.ok(priorBinding);
  for (const target of [kricLedger, kricProjection]) {
    target.governancePolicyVersion = priorBinding.governancePolicyVersion;
    target.governancePolicySha256 = priorBinding.governancePolicySha256;
  }
  priorKric.candidateBuildSpec.sourceSnapshotSetHash = selectedLedgerHash(priorKric.sourceSnapshots, priorKric.candidateBuildSpec.sourceSnapshotIds);
  assert.throws(() => buildCurrentCapitalFacilitySourceAdmission(priorKric), /KRIC current governance binding mismatch/u);

  const legacyKric = structuredClone(values);
  const legacyProjection = legacyKric.candidateBuildSpec.sourceSnapshots[kricIndex];
  const legacyLedger = legacyKric.sourceSnapshots.find(({ snapshotId }) => snapshotId === legacyProjection.snapshotId);
  for (const target of [legacyLedger, legacyProjection]) {
    target.governancePolicyVersion = "2026-07-15";
    target.governancePolicySha256 = "96fb678f2ec5da7f555d81d9d2009ac838e6145cc48ed2ae4757bce42c90ef70";
  }
  legacyKric.candidateBuildSpec.sourceSnapshotSetHash = selectedLedgerHash(legacyKric.sourceSnapshots, legacyKric.candidateBuildSpec.sourceSnapshotIds);
  assert.throws(() => buildCurrentCapitalFacilitySourceAdmission(legacyKric), /KRIC current governance binding mismatch/u);
});

test("producer-neutral FACILITY admission normalizes byte inputs before binding checks", async () => {
  const values = await fixture();
  values.sourceInventoryBytes = new Uint8Array(values.sourceInventoryBytes);
  values.governancePolicyBytes = new Uint8Array(values.governancePolicyBytes);
  assert.equal(buildCurrentCapitalFacilitySourceAdmission(values).decision, "GO");

  const inventoryRawDrift = await fixture();
  inventoryRawDrift.sourceInventoryBytes = Buffer.concat([inventoryRawDrift.sourceInventoryBytes, Buffer.from("\n")]);
  assert.throws(() => buildCurrentCapitalFacilitySourceAdmission(inventoryRawDrift), /candidate source inventory binding mismatch/);

  const governanceRawDrift = await fixture();
  governanceRawDrift.governancePolicyBytes = Buffer.concat([governanceRawDrift.governancePolicyBytes, Buffer.from("\n")]);
  assert.throws(() => buildCurrentCapitalFacilitySourceAdmission(governanceRawDrift), /governance policy binding/);
});

async function fixture({ mixed = false } = {}) {
  const files = Object.fromEntries(await Promise.all(["release/capital-production-canonical-pack.json", "nationwide-coverage-targets.json", "sources/kric-provider-code-catalog-20260228.json", "sources/kric-nationwide-route-rosters-20260730T203926676Z.json", "source-inventory.json", "source-governance-policy.json", "../../release/product-gates/datapack-freshness-sla.json", "release/candidate-build-spec.json", "release/source-snapshots.json"].map(async (name) => [
    name,
    await readFile(path.join(STATIC_SOURCE_PATHS.has(name) ? SOURCE_ROOT : root, name)),
  ])));
  const plan = buildCurrentCapitalFacilityCollectionPlan({ canonicalPackBytes: files["release/capital-production-canonical-pack.json"], coverageTargetsBytes: files["nationwide-coverage-targets.json"], providerCodeCatalogBytes: files["sources/kric-provider-code-catalog-20260228.json"], routeRostersBytes: files["sources/kric-nationwide-route-rosters-20260730T203926676Z.json"], sourceInventoryBytes: files["source-inventory.json"] });
  const planBytes = Buffer.from(canonicalCurrentCapitalFacilityCollectionPlanJson(plan));
  const roster = plan.stationLineProviderMappings.map((m) => ({ stationId: m.stationId, lineId: m.lineId, railOprIsttCd: m.providerOperatorId, lnCd: m.providerLineId, stinCd: m.providerStationId, canonicalMappings: [{ artifactId: "bundled-capital", stationId: m.stationId, lineId: m.lineId }] }));
  const specialCodes = new Map([
    [[roster[1].railOprIsttCd, roster[1].lnCd, roster[1].stinCd].join("\0"), []],
    [[roster[2].railOprIsttCd, roster[2].lnCd, roster[2].stinCd].join("\0"), ["ELEC"]],
    [[roster[3].railOprIsttCd, roster[3].lnCd, roster[3].stinCd].join("\0"), ["EV", "ES", "WCLF"]],
  ]);
  const capturedAt = new Date(CURRENT_SOURCE_HEAD_AT + 60_000).toISOString();
  const observedAt = new Date(CURRENT_SOURCE_HEAD_AT + 120_000).toISOString();
  const [snapshot] = await collectKricAccessibilitySnapshots({ roster, operations: [{ sourceId: "kric-station-convenience-standard", endpoint: "https://openapi.kric.go.kr/openapi/handicapped/stationCnvFacl", responseFields: ["dtlLoc", "grndDvCd", "gubun", "imgPath", "mlFmlDvCd", "stinFlor", "trfcWeakDvCd"], tupleIdentityFields: [] }], serviceKey: "fixture-only-key", now: new Date(capturedAt), allowTerminalResult03: mixed, fetchImpl: async (url) => {
    if (mixed && url.searchParams.get("railOprIsttCd") === "S1" && url.searchParams.get("lnCd") === "2" && url.searchParams.get("stinCd") === "234-4") {
      return { ok: true, status: 200, json: async () => ({ header: { resultCode: "03" }, body: [] }) };
    }
    const codes = specialCodes.get([url.searchParams.get("railOprIsttCd"), url.searchParams.get("lnCd"), url.searchParams.get("stinCd")].join("\0")) ?? ["EV"];
    return { ok: true, status: 200, json: async () => ({ header: { resultCode: "00" }, body: codes.map((gubun) => ({ dtlLoc: "fixture", grndDvCd: "1", gubun, imgPath: "", mlFmlDvCd: "", stinFlor: 1, trfcWeakDvCd: "01" })) }) };
  } });
  const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot)}\n`); const fileSha = sha256(snapshotBytes); const rawObjectSha256 = "a".repeat(64);
  const sourceInventory = JSON.parse(files["source-inventory.json"]);
  const source = sourceInventory.sources.find(({ id }) => id === snapshot.sourceId);
  source.accessibilityAdmissionEvidence = {
    ...source.accessibilityAdmissionEvidence,
    decision: "APPROVED",
    productionUseAllowed: true,
    snapshotId: snapshot.snapshotId,
    snapshotPath: `tools/datapack/sources/${snapshot.snapshotId}.json`,
    rawSha256: snapshot.rawSha256,
    contentSha256: snapshot.contentSha256,
    schemaFingerprint: snapshot.schemaFingerprint,
    redactedRequestFingerprint: snapshot.redactedRequestFingerprint,
    snapshotFileSha256: fileSha,
    capturedAt: snapshot.capturedAt,
    observedAt: snapshot.observedAt,
    freshUntil: snapshot.freshUntil,
    absenceEvidenceMode: snapshot.absenceEvidenceMode,
  };
  const ledger = {
    schemaVersion: 1,
    artifactKind: "official-source-snapshot",
    sourceId: snapshot.sourceId,
    snapshotId: snapshot.snapshotId,
    provider: source.provider,
    rawSha256: rawObjectSha256,
    rawObjectUri: "oci://fixture/kric-station-convenience-standard/raw.json",
    contentSha256: snapshot.contentSha256,
    schemaFingerprint: snapshot.schemaFingerprint,
    redactedRequestFingerprint: snapshot.redactedRequestFingerprint,
    retrievedAt: snapshot.capturedAt,
    sourceUpdatedAt: snapshot.observedAt,
    rowCount: snapshot.rowCount,
    coverageCount: plan.stationLineProviderMappings.length,
    freshnessExpiresAt: snapshot.freshUntil,
    rawRetentionExpiresAt: snapshot.freshUntil,
    governancePolicyVersion: "fixture-v1",
    governancePolicySha256: "b".repeat(64),
    adminReviewRecordHash: source.admissionEvidence.adminReviewRecordHash,
    previousSnapshotId: "",
    diffSummary: { added: 1 },
    snapshotStatus: "LOCKED",
    fetchStatus: "SUCCESS",
    schemaStatus: "PASS",
    licenseStatus: "PASS",
    credentialRedacted: true,
    redistributionAllowed: true,
    rawReceipt: {
      sourceId: snapshot.sourceId,
      snapshotId: snapshot.snapshotId,
      snapshotFileSha256: fileSha,
      snapshotRawSha256: snapshot.rawSha256,
      rawObjectSha256,
      capturedAt: snapshot.capturedAt,
      storedAt: observedAt,
      byteSize: 1234,
    },
  };
  const productionSpec = JSON.parse(files["release/candidate-build-spec.json"]);
  const productionSnapshots = JSON.parse(files["release/source-snapshots.json"]);
  const previousKricProjection = productionSpec.sourceSnapshots.find(({ sourceId }) => sourceId === ledger.sourceId);
  const previousKric = productionSnapshots.find((entry) => entry.sourceId === ledger.sourceId && entry.snapshotId === previousKricProjection.snapshotId);
  ledger.previousSnapshotId = previousKric.snapshotId;
  ledger.diffSummary = buildSnapshotDiff(previousKric, ledger);
  const sourceSnapshots = [...productionSnapshots, ledger];
  const governancePolicy = JSON.parse(files["source-governance-policy.json"]);
  const freshnessSla = JSON.parse(files["../../release/product-gates/datapack-freshness-sla.json"]);
  ledger.freshnessExpiresAt = deriveFreshnessExpiresAt({ policy: freshnessSla, sourceClassId: "static_accessibility_facility", basisAt: snapshot.capturedAt, evaluationAt: observedAt });
  ledger.rawRetentionExpiresAt = deriveRawRetentionExpiresAt({ policy: governancePolicy, sourceId: ledger.sourceId, retrievedAt: snapshot.capturedAt });
  ledger.governancePolicyVersion = governancePolicy.policyVersion;
  ledger.governancePolicySha256 = sha256(files["source-governance-policy.json"]);
  const sourceInventoryBytes = Buffer.from(JSON.stringify(sourceInventory));
  const candidateBuildSpec = {
    schemaVersion: 1,
    artifactKind: "datapack-candidate-build-spec",
    candidateId: "fixture",
    productionScopeId: "capital_pilot_android_v1",
    publishedAt: observedAt,
    sourceSnapshotIds: productionSpec.sourceSnapshotIds.map((snapshotId) => snapshotId === previousKric.snapshotId ? ledger.snapshotId : snapshotId),
    sourceSnapshots: productionSpec.sourceSnapshotIds.map((snapshotId) => snapshotId === previousKric.snapshotId ? ledger : productionSnapshots.find((entry) => entry.snapshotId === snapshotId)).map((entry) => deriveReleaseProjection({ snapshot: entry, sourceInventory, governancePolicy, governancePolicyBytes: files["source-governance-policy.json"], freshnessPolicy: freshnessSla, nowMillis: Date.parse(observedAt) })),
    sourceSnapshotSetHash: selectedLedgerHash(sourceSnapshots, productionSpec.sourceSnapshotIds.map((snapshotId) => snapshotId === previousKric.snapshotId ? ledger.snapshotId : snapshotId)),
    sourceInventorySha256: sha256(JSON.stringify(sourceInventory)),
    networkEdgeEvidence: { sourceInventory: { path: "tools/datapack/source-inventory.json", sha256: sha256(sourceInventoryBytes) } },
  };
  return { planBytes, canonicalPackBytes: files["release/capital-production-canonical-pack.json"], snapshotBytes, sourceInventoryBytes, sourceSnapshots, governancePolicy, governancePolicyBytes: files["source-governance-policy.json"], freshnessPolicy: freshnessSla, candidateBuildSpec, observedAt, candidateEvaluationAt: observedAt };
}

async function selectedSourceHeadAt(datapackRoot) {
  const [buildSpec, sourceSnapshots] = await Promise.all([
    readFile(path.join(datapackRoot, "release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(datapackRoot, "release/source-snapshots.json"), "utf8").then(JSON.parse),
  ]);
  const selected = buildSpec.sourceSnapshotIds.map((snapshotId) => {
    const matches = sourceSnapshots.filter((entry) => entry.snapshotId === snapshotId);
    assert.equal(matches.length, 1, `selected source snapshot identity: ${snapshotId}`);
    return matches[0];
  });
  const basisAt = Math.max(...selected.flatMap((entry) => [
    entry.retrievedAt, entry.sourceUpdatedAt, entry.capturedAt, entry.rawReceipt?.storedAt,
  ].filter(Boolean).map(Date.parse)));
  const freshUntil = Math.min(...selected.map(({ freshnessExpiresAt }) => Date.parse(freshnessExpiresAt)));
  assert.ok(Number.isFinite(basisAt) && Number.isFinite(freshUntil) && basisAt + 120_000 < freshUntil);
  return basisAt;
}

function mutateInventory(value, mutate) {
  const inventory = JSON.parse(Buffer.from(value.sourceInventoryBytes));
  mutate(inventory);
  value.sourceInventoryBytes = Buffer.from(JSON.stringify(inventory));
}

function selectedLedgerHash(sourceSnapshots, sourceSnapshotIds) {
  const selectedIds = new Set(sourceSnapshotIds);
  return sha256(JSON.stringify(sourceSnapshots.filter(({ snapshotId }) => selectedIds.has(snapshotId))));
}

async function productionShapedFixture() {
  return fixture();
}

function rehash(value) {
  delete value.admissionDigest;
  value.admissionDigest = sha256(canonicalJson(value));
}

function setBlocked(value, index) {
  value.cells[index].state = "ADMITTED_FACILITY_UNVERIFIED_BLOCKED";
  value.materializerEvidenceRows[index].state = "ADMITTED_FACILITY_UNVERIFIED_BLOCKED";
  value.materializerEvidenceRows[index].evidenceState = "UNVERIFIED_EVIDENCE_BLOCKED";
  for (const row of value.denominatorRows.slice(index * 3, index * 3 + 3)) row.state = "UNVERIFIED_EVIDENCE_BLOCKED";
}

function setAbsent(value, index) {
  value.cells[index].state = "ADMITTED_FACILITY_ABSENT";
  value.materializerEvidenceRows[index].state = "ADMITTED_FACILITY_ABSENT";
  value.materializerEvidenceRows[index].evidenceState = "VERIFIED_ABSENT";
  for (const row of value.denominatorRows.slice(index * 3, index * 3 + 3)) row.state = "VERIFIED_ABSENT";
}

function refreshSummaries(value) {
  value.denominatorStateSummary = Object.fromEntries(["VERIFIED_PRESENT", "VERIFIED_ABSENT", "UNVERIFIED_EVIDENCE_BLOCKED"]
    .map((state) => [state, value.denominatorRows.filter((row) => row.state === state).length]));
  value.cellStateSummary = Object.fromEntries(["ADMITTED_FACILITY_PRESENT", "ADMITTED_FACILITY_ABSENT", "ADMITTED_FACILITY_UNVERIFIED_BLOCKED"]
    .map((state) => [state, value.cells.filter((cell) => cell.state === state).length]));
}

function summarizeRows(rows, states) {
  return Object.fromEntries(states.map((state) => [state, rows.filter((row) => row.state === state).length]));
}

function currentKricProjection(value) {
  return value.candidateBuildSpec.sourceSnapshots.find(({ sourceId }) => sourceId === "kric-station-convenience-standard");
}

function currentKricLedger(value) {
  const projection = currentKricProjection(value);
  return value.sourceSnapshots.find(({ snapshotId }) => snapshotId === projection.snapshotId);
}
