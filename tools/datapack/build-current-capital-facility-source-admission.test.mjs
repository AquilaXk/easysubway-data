import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { buildCurrentCapitalFacilitySourceAdmission, canonicalCurrentCapitalFacilitySourceAdmissionJson } from "./build-current-capital-facility-source-admission.mjs";
import { buildCurrentCapitalFacilityCollectionPlan, canonicalCurrentCapitalFacilityCollectionPlanJson } from "./build-current-capital-facility-collection-plan.mjs";
import { collectKricAccessibilitySnapshots } from "./collect-kric-accessibility-snapshots.mjs";
import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";
import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";
import { deriveRawRetentionExpiresAt } from "./source-governance-policy.mjs";
import { buildSnapshotDiff } from "./source-snapshot-policy.mjs";

const root = import.meta.dirname;
test("producer-neutral FACILITY admission emits the exact 213/199/639 closed matrix", async () => {
  const values = await fixture();
  const first = buildCurrentCapitalFacilitySourceAdmission(values);
  const second = buildCurrentCapitalFacilitySourceAdmission(values);
  assert.equal(first.denominatorRows.length, 639);
  assert.equal(first.cells.length, 213);
  assert.equal(first.materializerEvidenceRows.length, 213);
  assert.equal(new Set(first.cells.map(({ stationId }) => stationId)).size, 199);
  assert.equal(first.decision, "GO");
  assert.deepEqual(first.denominatorStateSummary, { VERIFIED_PRESENT: 213, VERIFIED_ABSENT: 426, UNVERIFIED_EVIDENCE_BLOCKED: 0 });
  assert.deepEqual(first.cellStateSummary, { ADMITTED_FACILITY_PRESENT: 211, ADMITTED_FACILITY_ABSENT: 2, ADMITTED_FACILITY_UNVERIFIED_BLOCKED: 0 });
  assert.deepEqual(first.denominatorRows.slice(0, 12).map(({ facilityType, state }) => ({ facilityType, state })), [
    { facilityType: "ELEVATOR", state: "VERIFIED_PRESENT" }, { facilityType: "ESCALATOR", state: "VERIFIED_ABSENT" }, { facilityType: "WHEELCHAIR_LIFT", state: "VERIFIED_ABSENT" },
    { facilityType: "ELEVATOR", state: "VERIFIED_ABSENT" }, { facilityType: "ESCALATOR", state: "VERIFIED_ABSENT" }, { facilityType: "WHEELCHAIR_LIFT", state: "VERIFIED_ABSENT" },
    { facilityType: "ELEVATOR", state: "VERIFIED_ABSENT" }, { facilityType: "ESCALATOR", state: "VERIFIED_ABSENT" }, { facilityType: "WHEELCHAIR_LIFT", state: "VERIFIED_ABSENT" },
    { facilityType: "ELEVATOR", state: "VERIFIED_PRESENT" }, { facilityType: "ESCALATOR", state: "VERIFIED_PRESENT" }, { facilityType: "WHEELCHAIR_LIFT", state: "VERIFIED_PRESENT" },
  ]);
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

test("exact terminal 03은 one blocked cell과 세 blocked denominator rows로 admission GO를 만든다", async () => {
  const values = await fixture({ mixed: true });
  const admission = buildCurrentCapitalFacilitySourceAdmission(values);
  assert.deepEqual(admission.denominatorStateSummary, {
    VERIFIED_PRESENT: 212,
    VERIFIED_ABSENT: 424,
    UNVERIFIED_EVIDENCE_BLOCKED: 3,
  });
  assert.deepEqual(admission.cellStateSummary, {
    ADMITTED_FACILITY_PRESENT: 210,
    ADMITTED_FACILITY_ABSENT: 2,
    ADMITTED_FACILITY_UNVERIFIED_BLOCKED: 1,
  });
  const blocked = admission.cells.find(({ stationId, lineId }) => stationId === "station-b35616704ce3" && lineId === "seoul-2");
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

  const wrongTuple = structuredClone(admission);
  setAbsent(wrongTuple, blockedIndex);
  const wrongIndex = blockedIndex === 0 ? 1 : 0;
  setBlocked(wrongTuple, wrongIndex);
  refreshSummaries(wrongTuple); rehash(wrongTuple);
  assert.throws(() => canonicalCurrentCapitalFacilitySourceAdmissionJson(wrongTuple), /blocked terminal matrix/u);

  const duplicate = structuredClone(admission);
  setBlocked(duplicate, blockedIndex === 0 ? 1 : 0);
  refreshSummaries(duplicate); rehash(duplicate);
  assert.throws(() => canonicalCurrentCapitalFacilitySourceAdmissionJson(duplicate), /blocked terminal matrix/u);
});

test("producer-neutral FACILITY admission rejects representative identity and query drift before output", async () => {
  const values = await fixture();
  const cases = [
    (value) => { const snapshot = JSON.parse(value.snapshotBytes); snapshot.queries.pop(); snapshot.queryCount = 212; value.snapshotBytes = Buffer.from(JSON.stringify(snapshot)); },
    (value) => { const snapshot = JSON.parse(value.snapshotBytes); snapshot.queries.push(structuredClone(snapshot.queries[0])); value.snapshotBytes = Buffer.from(JSON.stringify(snapshot)); },
    (value) => { const snapshot = JSON.parse(value.snapshotBytes); snapshot.queries[0].rows[0].gubun = "UNKNOWN"; value.snapshotBytes = Buffer.from(JSON.stringify(snapshot)); },
    (value) => { mutateInventory(value, (inventory) => { inventory.sources.find(({ id }) => id === "kric-station-convenience-standard").accessibilityAdmissionEvidence.snapshotId = "wrong"; }); },
    (value) => { value.sourceSnapshots.at(-1).rawReceipt.snapshotId = "wrong"; },
    (value) => { value.sourceSnapshots.at(-1).rawSha256 = "0".repeat(64); },
    (value) => { value.candidateBuildSpec.sourceSnapshotIds = []; },
    (value) => { value.candidateBuildSpec.sourceSnapshotSetHash = "0".repeat(64); },
    (value) => { value.candidateBuildSpec.sourceSnapshots[1].licenseStatus = "WRONG"; },
    (value) => { value.candidateBuildSpec.sourceSnapshots[3].untrusted = true; },
    (value) => { value.sourceSnapshots.at(-1).freshnessExpiresAt = "2026-08-03T00:00:00.000Z"; },
    (value) => { value.candidateBuildSpec.sourceSnapshots[3].rawRetentionExpiresAt = "2026-08-03T00:00:00.000Z"; },
    (value) => { value.sourceSnapshots.at(-1).rawReceipt.storedAt = "2026-08-03T00:02:00.000Z"; },
    (value) => { mutateInventory(value, (inventory) => { inventory.sources.find(({ id }) => id === "kric-station-convenience-standard").admissionEvidence.adminReviewRecordHash = "0".repeat(64); }); },
    (value) => { value.candidateBuildSpec.sourceSnapshots[3].governancePolicySha256 = "wrong"; },
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
  assert.throws(() => buildCurrentCapitalFacilitySourceAdmission(governanceRawDrift), /candidate source snapshot projection mismatch/);
});

async function fixture({ mixed = false } = {}) {
  const files = Object.fromEntries(await Promise.all(["release/capital-production-canonical-pack.json", "nationwide-coverage-targets.json", "sources/kric-provider-code-catalog-20260228.json", "sources/kric-nationwide-route-rosters-20260730T203926676Z.json", "source-inventory.json", "source-governance-policy.json", "../../release/product-gates/datapack-freshness-sla.json", "release/candidate-build-spec.json", "release/source-snapshots.json"].map(async (name) => [name, await readFile(path.join(root, name))])));
  const plan = buildCurrentCapitalFacilityCollectionPlan({ canonicalPackBytes: files["release/capital-production-canonical-pack.json"], coverageTargetsBytes: files["nationwide-coverage-targets.json"], providerCodeCatalogBytes: files["sources/kric-provider-code-catalog-20260228.json"], routeRostersBytes: files["sources/kric-nationwide-route-rosters-20260730T203926676Z.json"], sourceInventoryBytes: files["source-inventory.json"] });
  const planBytes = Buffer.from(canonicalCurrentCapitalFacilityCollectionPlanJson(plan));
  const roster = plan.stationLineProviderMappings.map((m) => ({ stationId: m.stationId, lineId: m.lineId, railOprIsttCd: m.providerOperatorId, lnCd: m.providerLineId, stinCd: m.providerStationId, canonicalMappings: [{ artifactId: "bundled-capital", stationId: m.stationId, lineId: m.lineId }] }));
  const specialCodes = new Map([
    [[roster[1].railOprIsttCd, roster[1].lnCd, roster[1].stinCd].join("\0"), []],
    [[roster[2].railOprIsttCd, roster[2].lnCd, roster[2].stinCd].join("\0"), ["ELEC"]],
    [[roster[3].railOprIsttCd, roster[3].lnCd, roster[3].stinCd].join("\0"), ["EV", "ES", "WCLF"]],
  ]);
  const [snapshot] = await collectKricAccessibilitySnapshots({ roster, operations: [{ sourceId: "kric-station-convenience-standard", endpoint: "https://openapi.kric.go.kr/openapi/handicapped/stationCnvFacl", responseFields: ["dtlLoc", "grndDvCd", "gubun", "imgPath", "mlFmlDvCd", "stinFlor", "trfcWeakDvCd"], tupleIdentityFields: [] }], serviceKey: "fixture-only-key", now: new Date("2026-08-14T00:00:00.000Z"), allowTerminalResult03: mixed, fetchImpl: async (url) => {
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
    rawObjectUri: "s3://fixture/raw.json",
    contentSha256: snapshot.contentSha256,
    schemaFingerprint: snapshot.schemaFingerprint,
    redactedRequestFingerprint: snapshot.redactedRequestFingerprint,
    retrievedAt: snapshot.capturedAt,
    sourceUpdatedAt: snapshot.observedAt,
    rowCount: snapshot.rowCount,
    coverageCount: 213,
    freshnessExpiresAt: "2026-08-15T12:00:00.000Z",
    rawRetentionExpiresAt: "2026-10-01T00:00:00.000Z",
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
      storedAt: "2026-08-14T00:00:40.000Z",
      byteSize: 1234,
    },
  };
  const productionSpec = JSON.parse(files["release/candidate-build-spec.json"]);
  const productionSnapshots = JSON.parse(files["release/source-snapshots.json"]);
  const previousKric = productionSnapshots.find((entry) => entry.sourceId === ledger.sourceId && entry.snapshotId === productionSpec.sourceSnapshotIds[3]);
  ledger.previousSnapshotId = previousKric.snapshotId;
  ledger.diffSummary = buildSnapshotDiff(previousKric, ledger);
  const sourceSnapshots = [...productionSnapshots, ledger];
  const governancePolicy = JSON.parse(files["source-governance-policy.json"]);
  const freshnessSla = JSON.parse(files["../../release/product-gates/datapack-freshness-sla.json"]);
  const sourceInventoryBytes = Buffer.from(JSON.stringify(sourceInventory));
  const candidateBuildSpec = {
    schemaVersion: 1,
    artifactKind: "datapack-candidate-build-spec",
    candidateId: "fixture",
    productionScopeId: "capital_pilot_android_v1",
    sourceSnapshotIds: productionSpec.sourceSnapshotIds.map((snapshotId) => snapshotId === previousKric.snapshotId ? ledger.snapshotId : snapshotId),
    sourceSnapshots: productionSpec.sourceSnapshotIds.map((snapshotId) => snapshotId === previousKric.snapshotId ? ledger : productionSnapshots.find((entry) => entry.snapshotId === snapshotId)).map((entry) => derivedProjection({ entry, sourceInventory, governancePolicy, governancePolicyBytes: files["source-governance-policy.json"], freshnessSla, observedAt: "2026-08-14T16:00:00.000Z" })),
    sourceSnapshotSetHash: sha256(JSON.stringify(productionSpec.sourceSnapshotIds.map((snapshotId) => snapshotId === previousKric.snapshotId ? ledger : productionSnapshots.find((entry) => entry.snapshotId === snapshotId)))),
    sourceInventorySha256: sha256(JSON.stringify(sourceInventory)),
    networkEdgeEvidence: { sourceInventory: { path: "tools/datapack/source-inventory.json", sha256: sha256(sourceInventoryBytes) } },
  };
  return { planBytes, canonicalPackBytes: files["release/capital-production-canonical-pack.json"], snapshotBytes, sourceInventoryBytes, sourceSnapshots, governancePolicy, governancePolicyBytes: files["source-governance-policy.json"], freshnessPolicy: freshnessSla, candidateBuildSpec, observedAt: "2026-08-14T16:00:00.000Z" };
}

function derivedProjection({ entry, sourceInventory, governancePolicy, governancePolicyBytes, freshnessSla, observedAt }) {
  const source = sourceInventory.sources.find(({ id }) => id === entry.sourceId);
  const policySource = governancePolicy.sources.find(({ sourceId }) => sourceId === entry.sourceId);
  const sourceClass = freshnessSla.sourceClasses.find(({ id }) => id === policySource.sourceClassId);
  return {
    snapshotId: entry.snapshotId, sourceId: entry.sourceId, rawObjectUri: entry.rawObjectUri,
    rawSha256: entry.rawSha256, redactedRequestFingerprint: entry.redactedRequestFingerprint,
    schemaFingerprint: entry.schemaFingerprint, licenseStatus: entry.licenseStatus,
    redistributionAllowed: entry.redistributionAllowed,
    adminReviewRecordHash: source.admissionEvidence.adminReviewRecordHash,
    snapshotStatus: entry.snapshotStatus, credentialRedacted: entry.credentialRedacted,
    freshnessExpiresAt: deriveFreshnessExpiresAt({ policy: freshnessSla, sourceClassId: sourceClass.id, basisAt: entry[sourceClass.basisField], providerValidUntil: sourceClass.providerValidityEndField ? entry[sourceClass.providerValidityEndField] : undefined, evaluationAt: observedAt }),
    rawRetentionExpiresAt: deriveRawRetentionExpiresAt({ policy: governancePolicy, sourceId: entry.sourceId, retrievedAt: entry.retrievedAt }),
    governancePolicyVersion: governancePolicy.policyVersion, governancePolicySha256: sha256(governancePolicyBytes),
  };
}

function mutateInventory(value, mutate) {
  const inventory = JSON.parse(Buffer.from(value.sourceInventoryBytes));
  mutate(inventory);
  value.sourceInventoryBytes = Buffer.from(JSON.stringify(inventory));
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
