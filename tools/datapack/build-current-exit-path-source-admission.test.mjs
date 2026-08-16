import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCurrentExitPathSourceAdmission,
  main,
} from "./build-current-exit-path-source-admission.mjs";
import { buildCurrentKricExitCollectionPlan } from "./build-current-kric-exit-collection-plan.mjs";
import {
  buildCurrentKricExitCollectionBundle,
  buildCurrentKricExitCollectionReceipt,
} from "./build-current-kric-exit-collection-receipt.mjs";
import { canonicalExitPathAdmissionJson } from "./build-exit-path-admission.mjs";
import { buildCurrentCapitalFacilityCollectionPlan, canonicalCurrentCapitalFacilityCollectionPlanJson } from "./build-current-capital-facility-collection-plan.mjs";
import { buildCurrentCapitalFacilitySourceAdmission } from "./build-current-capital-facility-source-admission.mjs";
import { collectKricAccessibilitySnapshots } from "./collect-kric-accessibility-snapshots.mjs";
import { deriveReleaseProjection } from "./rebind-current-candidate-source-snapshots.mjs";
import { buildSnapshotDiff } from "./source-snapshot-policy.mjs";

const CURRENT_SOURCE_HEAD_AT = await selectedSourceHeadAt();
const CAPTURED_AT = new Date(CURRENT_SOURCE_HEAD_AT + 60_000).toISOString();
const OBSERVED_AT = new Date(CURRENT_SOURCE_HEAD_AT + 120_000).toISOString();
const FRESH_UNTIL = new Date(CURRENT_SOURCE_HEAD_AT + 60_000 + 24 * 60 * 60 * 1_000).toISOString();
const SOURCE_ID = "kric-station-movement-standard";

test("current provider snapshot을 candidate station-line EXIT admission으로 투영한다", () => {
  const input = validInput();
  const result = buildCurrentExitPathSourceAdmission(input);

  assert.equal(result.normalizedSnapshot.schemaVersion, 3);
  assert.equal(result.normalizedSnapshot.queryPlan.length, 3);
  assert.deepEqual(result.normalizedSnapshot.results.map(({ state }) => state).sort(), [
    "OBSERVED_EXIT_PATH", "OBSERVED_EXIT_PATH", "PROVIDER_NO_DATA",
  ]);
  assert.equal(result.admission.decision, "GO");
  assert.equal(result.admission.stateSummary.ADMITTED_EXIT_PATH, 2);
  assert.equal(result.admission.stateSummary.UNKNOWN, 0);
  assert.equal(result.admission.materializerEvidenceRows.length, 2);
  assert.equal(
    result.admission.sourceIdentity.providerSnapshotDigest,
    JSON.parse(input.providerSnapshotBytes).snapshotDigest,
  );
  assert.equal(
    result.admission.sourceIdentity.providerSnapshotRawSha256,
    sha256(input.providerSnapshotBytes),
  );
  assert.equal(
    result.admission.sourceIdentity.facilityAdmissionDigest,
    input.facilityAdmission.admissionDigest,
  );
});

test("tracked current EXIT handoff는 exact immutable snapshot과 GO admission을 고정한다", async () => {
  const [normalizedBytes, admissionBytes] = await Promise.all([
    readFile(new URL("./release/current-exit-admission/exit-path-normalized-source-snapshot.json", import.meta.url)),
    readFile(new URL("./release/current-exit-admission/exit-path-source-admission.json", import.meta.url)),
  ]);
  assert.equal(sha256(normalizedBytes), "aff6a382042e8cd6d493f1c7a89d3496242f7c04b67dfaf81bc6d0eacd4c176f");
  assert.equal(sha256(admissionBytes), "965decb43a399958f41eaa6a0144da20d04f49c791a822eaf62b8e99c0386d4b");
  const normalized = JSON.parse(normalizedBytes);
  const admission = JSON.parse(admissionBytes);
  assert.equal(normalized.providerSnapshotIdentity.snapshotDigest,
    "68cdeac2b478a651eb3ea428dd6be5c0ea0a7462e5cba853d9308d6fa96bfb13");
  assert.equal(normalized.providerSnapshotIdentity.rawSha256,
    "6eeb132847590f702babffdc22c7ed8188efa560ad42b78623e258ca79420bbd");
  assert.equal(admission.admissionDigest,
    "d64f812b5e35680886e9377eda33e6fbabf1530c4da8b6f933b1204149a61f4c");
  assert.equal(admission.decision, "GO");
  assert.deepEqual(admission.stateSummary, {
    ADMITTED_EXIT_PATH: 2,
    ADMITTED_VERIFIED_ABSENCE: 0,
    BLOCKED_WITH_EVIDENCE: 0,
    MISSING: 0,
    STALE: 0,
    UNKNOWN: 0,
  });
  assert.equal(admission.sourceIdentity.rawSha256, sha256(normalizedBytes));
  assert.equal(canonicalExitPathAdmissionJson(admission), admissionBytes.toString("utf8"));
});

test("positive observation이 없는 provider no-data station-line은 UNKNOWN으로 유지한다", () => {
  const input = validInput();
  const snapshot = JSON.parse(input.providerSnapshotBytes);
  const stationBQueryId = input.collectionPlan.stationLineQueries
    .find(({ stationLineId }) => stationLineId === "station-b:seoul-4").queryIds[0];
  snapshot.results = snapshot.results.map((result) => result.queryId === stationBQueryId
    ? providerResult(result.queryId, "PROVIDER_NO_DATA")
    : result);
  input.providerSnapshotBytes = providerSnapshotBytes(snapshot);

  const result = buildCurrentExitPathSourceAdmission(input);
  assert.equal(result.admission.decision, "NO_GO");
  assert.equal(result.admission.stateSummary.ADMITTED_EXIT_PATH, 1);
  assert.equal(result.admission.stateSummary.UNKNOWN, 1);
  assert.equal(result.admission.cells.find(({ stationId }) => stationId === "station-b").admissionReason,
    "PROVIDER_NO_DATA_IS_NOT_ABSENCE");
});

test("raw identity, candidate identity와 source license drift를 fail closed한다", () => {
  const cases = [
    ["raw digest", (input) => {
      const snapshot = JSON.parse(input.providerSnapshotBytes);
      snapshot.snapshotDigest = "0".repeat(64);
      input.providerSnapshotBytes = Buffer.from(canonicalJson(snapshot));
    }, /provider snapshot digest mismatch/],
    ["candidate", (input) => { input.candidateBuildSpec.candidateId = "other"; }, /candidate identity mismatch/],
    ["collection plan", (input) => {
      input.collectionPlan.collectionPlanDigest = "0".repeat(64);
    }, /collection plan digest mismatch|collection plan identity mismatch/],
    ["license", (input) => {
      input.sourceInventory.sources[0].license.redistributionAllowed = false;
    }, /source license mismatch/],
    ["source set", (input) => {
      input.candidateBuildSpec.sourceSnapshotSetHash = "f".repeat(64);
    }, /source snapshot set identity mismatch/],
  ];
  for (const [label, mutate, expected] of cases) {
    const input = validInput();
    mutate(input);
    assert.throws(() => buildCurrentExitPathSourceAdmission(input), expected, label);
  }
});

test("current capital FACILITY 형식은 legacy 2-station matrix로 downscope하지 않는다", () => {
  const input = validInput();
  const legacy = structuredClone(input.facilityAdmission);
  legacy.artifactKind = "current-capital-facility-source-admission";
  assert.throws(
    () => buildCurrentExitPathSourceAdmission({ ...input, facilityAdmission: legacy }),
    /capital FACILITY admission (?:output keys|matrix) mismatch/,
  );
});

test("#331 builder canonical 213/199 FACILITY는 420 EXIT query GO로 직접 결속된다", async () => {
  const {
    bundle, candidateBuildSpec, facilityAdmission, inventory, ledger, sourceSnapshots,
    successorObservedAt,
  } = await fullCapitalFixture();
  const result = buildCurrentExitPathSourceAdmission({ providerSnapshotBytes: bundle.snapshotBytes, collectionPlan: JSON.parse(bundle.planBytes), facilityAdmission, candidateBuildSpec, sourceInventory: inventory, sourceSnapshots, observedAt: successorObservedAt });
  assert.equal(facilityAdmission.cells.length, 213); assert.equal(new Set(facilityAdmission.cells.map(({ stationId }) => stationId)).size, 199);
  assert.equal(result.normalizedSnapshot.queryPlan.length, 420); assert.equal(result.admission.cells.length, 213); assert.equal(result.admission.decision, "GO");
  const snapshotRawDrift = structuredClone(facilityAdmission);
  snapshotRawDrift.sourceIdentity.rawSha256 = "f".repeat(64);
  const { admissionDigest: ignoredDigest, ...snapshotRawPayload } = snapshotRawDrift;
  snapshotRawDrift.admissionDigest = sha256(canonicalJson(snapshotRawPayload));
  assert.throws(() => buildCurrentExitPathSourceAdmission({ providerSnapshotBytes: bundle.snapshotBytes, collectionPlan: JSON.parse(bundle.planBytes), facilityAdmission: snapshotRawDrift, candidateBuildSpec, sourceInventory: inventory, sourceSnapshots: [ledger], observedAt: successorObservedAt }), /raw object provenance mismatch/);
});


test("station-line query와 source coverage를 provider mapping·inventory에 exact 결속한다", () => {
  const crossProvider = validInput();
  const stationA = crossProvider.collectionPlan.stationLineQueries
    .find(({ stationLineId }) => stationLineId === "station-a:seoul-4");
  const stationAQuery = crossProvider.collectionPlan.queryPlan
    .find(({ providerStationId }) => providerStationId === "101");
  const foreignQuery = crossProvider.collectionPlan.queryPlan
    .find(({ providerStationId }) => providerStationId === "103");
  for (const key of ["operatorName", "lineName", "stationName", "regionId"]) {
    foreignQuery[key] = stationAQuery[key];
  }
  stationA.queryIds = [foreignQuery.queryId];
  rebindCollectionPlan(crossProvider);
  const crossProviderSnapshot = JSON.parse(crossProvider.providerSnapshotBytes);
  crossProviderSnapshot.queryPlan = structuredClone(crossProvider.collectionPlan.queryPlan);
  crossProviderSnapshot.queryPlanSha256 = crossProvider.collectionPlan.queryPlanSha256;
  crossProviderSnapshot.collectionPlanDigest = crossProvider.collectionPlan.collectionPlanDigest;
  crossProviderSnapshot.results = crossProviderSnapshot.results.map((result) =>
    result.queryId === foreignQuery.queryId
      ? providerResult(result.queryId, "ROWS_OBSERVED")
      : result);
  crossProvider.providerSnapshotBytes = providerSnapshotBytes(crossProviderSnapshot);
  assert.throws(
    () => buildCurrentExitPathSourceAdmission(crossProvider),
    /current EXIT provider mapping mismatch/,
  );

  const outsideOperator = validInput();
  for (const cell of outsideOperator.facilityAdmission.cells) cell.operatorId = "outside-operator";
  rebindFacilityAdmission(outsideOperator);
  assert.throws(
    () => buildCurrentExitPathSourceAdmission(outsideOperator),
    /current EXIT source coverage mismatch/,
  );

  const outsideRegion = validInput();
  const selectedIds = new Set(outsideRegion.collectionPlan.stationLineQueries
    .filter(({ stationLineId }) => stationLineId !== "station-c:seoul-4")
    .flatMap(({ queryIds }) => queryIds));
  for (const query of outsideRegion.collectionPlan.queryPlan) {
    if (selectedIds.has(query.queryId)) query.regionId = "outside-region";
  }
  rebindCollectionPlan(outsideRegion);
  const outsideRegionSnapshot = JSON.parse(outsideRegion.providerSnapshotBytes);
  outsideRegionSnapshot.queryPlan = structuredClone(outsideRegion.collectionPlan.queryPlan);
  outsideRegionSnapshot.queryPlanSha256 = outsideRegion.collectionPlan.queryPlanSha256;
  outsideRegionSnapshot.collectionPlanDigest = outsideRegion.collectionPlan.collectionPlanDigest;
  outsideRegion.providerSnapshotBytes = providerSnapshotBytes(outsideRegionSnapshot);
  rebindFacilityAdmission(outsideRegion);
  assert.throws(
    () => buildCurrentExitPathSourceAdmission(outsideRegion),
    /current EXIT source coverage mismatch/,
  );
});

test("CLI는 normalized snapshot과 admission을 absent directory에 함께 쓴다", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-exit-admission-"));
  const input = validInput();
  const paths = {
    provider: path.join(root, "provider.json"),
    plan: path.join(root, "plan.json"),
    facility: path.join(root, "facility.json"),
    candidate: path.join(root, "candidate.json"),
    inventory: path.join(root, "inventory.json"),
    sourceSnapshots: path.join(root, "source-snapshots.json"),
    output: path.join(root, "output"),
  };
  await Promise.all([
    writeFile(paths.provider, input.providerSnapshotBytes),
    writeFile(paths.plan, canonicalJson(input.collectionPlan)),
    writeFile(paths.facility, `${JSON.stringify(input.facilityAdmission, null, 2)}\n`),
    writeFile(paths.candidate, `${JSON.stringify(input.candidateBuildSpec, null, 2)}\n`),
    writeFile(paths.inventory, `${JSON.stringify(input.sourceInventory, null, 2)}\n`),
    writeFile(paths.sourceSnapshots, `${JSON.stringify(input.sourceSnapshots, null, 2)}\n`),
  ]);

  await main([
    "--provider-snapshot", paths.provider,
    "--collection-plan", paths.plan,
    "--facility-admission", paths.facility,
    "--candidate-build-spec", paths.candidate,
    "--source-inventory", paths.inventory,
    "--source-snapshots", paths.sourceSnapshots,
    "--observed-at", OBSERVED_AT,
    "--output-directory", paths.output,
  ], { log: () => {} });

  const normalizedPath = path.join(paths.output, "exit-path-normalized-source-snapshot.json");
  const admissionPath = path.join(paths.output, "exit-path-source-admission.json");
  const [normalized, admission, normalizedStat, admissionStat] = await Promise.all([
    readFile(normalizedPath, "utf8"),
    readFile(admissionPath, "utf8"),
    stat(normalizedPath),
    stat(admissionPath),
  ]);
  assert.equal(JSON.parse(normalized).artifactKind, "exit-path-normalized-source-snapshot");
  assert.equal(JSON.parse(admission).decision, "GO");
  assert.equal(normalizedStat.mode & 0o777, 0o600);
  assert.equal(admissionStat.mode & 0o777, 0o600);
  await assert.rejects(() => main([
    "--provider-snapshot", paths.provider,
    "--collection-plan", paths.plan,
    "--facility-admission", paths.facility,
    "--candidate-build-spec", paths.candidate,
    "--source-inventory", paths.inventory,
    "--source-snapshots", paths.sourceSnapshots,
    "--observed-at", OBSERVED_AT,
    "--output-directory", paths.output,
  ], { log: () => {} }), /output directory must be absent/);
});

test("CLI는 explicit pair와 immutable collection bundle mode를 섞지 않는다", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-exit-args-"));
  const common = [
    "--facility-admission", path.join(root, "facility.json"),
    "--candidate-build-spec", path.join(root, "candidate.json"),
    "--source-inventory", path.join(root, "inventory.json"),
    "--source-snapshots", path.join(root, "snapshots.json"),
    "--observed-at", OBSERVED_AT,
    "--output-directory", path.join(root, "output"),
  ];
  await assert.rejects(() => main([
    "--provider-snapshot", path.join(root, "provider.json"),
    "--collection-plan", path.join(root, "plan.json"),
    "--collection-bundle", path.join(root, "bundle.json"),
    "--expected-bundle-sha256", "a".repeat(64),
    "--expected-repository-sha", "a".repeat(40),
    "--expected-workflow-run-id", "123",
    ...common,
  ], { log: () => {} }), /arguments mismatch/);
  await assert.rejects(() => main([
    "--collection-bundle", path.join(root, "bundle.json"),
    ...common,
  ], { log: () => {} }), /arguments mismatch/);
});

test("CLI bundle mode는 explicit pair와 exact output을 만들고 collision을 보존한다", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-exit-bundle-mode-"));
  const fixture = await fullCapitalFixture();
  const input = {
    facilityAdmission: fixture.facilityAdmission,
    candidateBuildSpec: fixture.candidateBuildSpec,
    sourceInventory: fixture.inventory,
    sourceSnapshots: fixture.sourceSnapshots,
  };
  const paths = {
    provider: path.join(root, "provider.json"), plan: path.join(root, "plan.json"), bundle: path.join(root, "bundle.json"),
    facility: path.join(root, "facility.json"), candidate: path.join(root, "candidate.json"),
    inventory: path.join(root, "inventory.json"), snapshots: path.join(root, "snapshots.json"),
    explicitOutput: path.join(root, "explicit"), bundleOutput: path.join(root, "bundle"), collisionOutput: path.join(root, "collision"),
    missingDigestOutput: path.join(root, "missing-digest"), wrongDigestOutput: path.join(root, "wrong-digest"),
  };
  await Promise.all([
    writeFile(paths.provider, fixture.bundle.snapshotBytes), writeFile(paths.plan, fixture.bundle.planBytes), writeFile(paths.bundle, fixture.bundle.bundleBytes),
    writeFile(paths.facility, `${JSON.stringify(input.facilityAdmission, null, 2)}\n`),
    writeFile(paths.candidate, `${JSON.stringify(input.candidateBuildSpec, null, 2)}\n`),
    writeFile(paths.inventory, `${JSON.stringify(input.sourceInventory, null, 2)}\n`),
    writeFile(paths.snapshots, `${JSON.stringify(input.sourceSnapshots, null, 2)}\n`),
  ]);
  const common = [
    "--facility-admission", paths.facility, "--candidate-build-spec", paths.candidate,
    "--source-inventory", paths.inventory, "--source-snapshots", paths.snapshots,
    "--observed-at", OBSERVED_AT,
  ];
  await main([
    "--provider-snapshot", paths.provider, "--collection-plan", paths.plan,
    ...common, "--output-directory", paths.explicitOutput,
  ], { log: () => {} });
  await assert.rejects(() => main([
    "--collection-bundle", paths.bundle, "--expected-repository-sha", "a".repeat(40),
    "--expected-workflow-run-id", "123", ...common, "--output-directory", paths.missingDigestOutput,
  ], { log: () => {} }), /arguments mismatch/);
  await assert.rejects(() => stat(paths.missingDigestOutput), /ENOENT/);
  await assert.rejects(() => main([
    "--collection-bundle", paths.bundle, "--expected-bundle-sha256", "b".repeat(64),
    "--expected-repository-sha", "a".repeat(40), "--expected-workflow-run-id", "123",
    ...common, "--output-directory", paths.wrongDigestOutput,
  ], { log: () => {} }), /expected digest mismatch/);
  await assert.rejects(() => stat(paths.wrongDigestOutput), /ENOENT/);
  await main([
    "--collection-bundle", paths.bundle, "--expected-bundle-sha256", sha256(fixture.bundle.bundleBytes), "--expected-repository-sha", "a".repeat(40),
    "--expected-workflow-run-id", "123", ...common, "--output-directory", paths.bundleOutput,
  ], { log: () => {} });
  for (const file of ["exit-path-normalized-source-snapshot.json", "exit-path-source-admission.json"]) {
    const [explicit, bundled, explicitStat, bundleStat] = await Promise.all([
      readFile(path.join(paths.explicitOutput, file)), readFile(path.join(paths.bundleOutput, file)),
      stat(path.join(paths.explicitOutput, file)), stat(path.join(paths.bundleOutput, file)),
    ]);
    assert.deepEqual(bundled, explicit);
    assert.equal(explicitStat.mode & 0o777, 0o600);
    assert.equal(bundleStat.mode & 0o777, 0o600);
  }
  await writeFile(paths.collisionOutput, "preserve");
  await assert.rejects(() => main([
    "--collection-bundle", paths.bundle, "--expected-bundle-sha256", sha256(fixture.bundle.bundleBytes), "--expected-repository-sha", "a".repeat(40),
    "--expected-workflow-run-id", "123", ...common, "--output-directory", paths.collisionOutput,
  ], { log: () => {} }), /output directory must be absent/);
  assert.equal(await readFile(paths.collisionOutput, "utf8"), "preserve");
});

async function fullBundleFixture() {
  const root = import.meta.dirname;
  const files = {
    canonicalPackBytes: "release/capital-production-canonical-pack.json", coverageTargetsBytes: "nationwide-coverage-targets.json",
    providerCodeCatalogBytes: "sources/kric-provider-code-catalog-20260228.json", routeRostersBytes: "sources/kric-nationwide-route-rosters-20260730T203926676Z.json",
    sourceInventoryBytes: "source-inventory.json", incheonTopologyBytes: "sources/incheon-transit-station-info-20260814.json",
  };
  const input = freshIncheonTopologyFixture(Object.fromEntries(
    await Promise.all(Object.entries(files).map(async ([key, file]) => [key, await readFile(path.join(root, file))])),
  ));
  const plan = buildCurrentKricExitCollectionPlan(input, { now: new Date(CAPTURED_AT), coverageSelector: "capital-seoul-metro-production" });
  const rows = [{ edMovePath: null, elvtSttCd: null, elvtTpCd: null, exitMvTpOrdr: "1", imgPath: null, mvContDtl: null, mvPathMgNo: "1", stMovePath: null }];
  const results = plan.queryPlan.map((query, index) => ({ queryId: query.queryId, state: index === 0 ? "ROWS_OBSERVED" : "EXPLICIT_ZERO", providerResultCode: "00", rawResponseSha256: sha256(`raw-${index}`), rawResponseByteSize: 1, providerRecordHash: sha256(canonicalJson(index === 0 ? rows : [])), rows: index === 0 ? rows : [] }));
  const snapshotPayload = { schemaVersion: 1, artifactKind: "kric-exit-path-provider-snapshot", sourceId: SOURCE_ID, snapshotId: `kric-station-movement-standard-${CAPTURED_AT.replaceAll(/[-:.]/gu, "")}`, capturedAt: CAPTURED_AT, freshUntil: FRESH_UNTIL, credentialRedacted: true, collectionPlanDigest: plan.collectionPlanDigest, queryPlanSha256: plan.queryPlanSha256, coverage: { requestPlanComplete: true, queryIds: plan.queryPlan.map(({ queryId }) => queryId) }, queryPlan: plan.queryPlan, results };
  const snapshot = { ...snapshotPayload, snapshotDigest: sha256(canonicalJson(snapshotPayload)) };
  const planBytes = Buffer.from(canonicalJson(plan)); const snapshotBytes = Buffer.from(canonicalJson(snapshot));
  const receipt = buildCurrentKricExitCollectionReceipt({ collectionPlanBytes: planBytes, providerSnapshotBytes: snapshotBytes, repository: "AquilaXk/easysubway-data", repositorySha: "a".repeat(40), workflowRunId: 123 });
  const bundle = buildCurrentKricExitCollectionBundle({ collectionPlanBytes: planBytes, providerSnapshotBytes: snapshotBytes, receipt });
  return { planBytes, snapshotBytes, bundleBytes: Buffer.from(canonicalJson(bundle)) };
}

function freshIncheonTopologyFixture(input) {
  const capturedAt = new Date(Date.parse(CAPTURED_AT) - 1_000).toISOString();
  const freshUntil = new Date(Date.parse(capturedAt) + 24 * 60 * 60 * 1_000).toISOString();
  const snapshot = JSON.parse(input.incheonTopologyBytes);
  snapshot.capturedAt = capturedAt;
  snapshot.freshUntil = freshUntil;
  const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot)}\n`);

  const inventory = JSON.parse(input.sourceInventoryBytes);
  const source = inventory.sources.find(({ id }) => id === snapshot.sourceId);
  assert.ok(source, "Incheon topology fixture source");
  source.topologyAdmissionEvidence = {
    ...source.topologyAdmissionEvidence,
    capturedAt,
    freshUntil,
  };
  source.membershipAdmissionEvidence = {
    ...source.membershipAdmissionEvidence,
    verifiedAt: capturedAt,
  };
  source.routeMapAdmissionEvidence = {
    ...source.routeMapAdmissionEvidence,
    capturedAt,
    snapshotSha256: sha256(snapshotBytes),
  };
  return {
    ...input,
    incheonTopologyBytes: snapshotBytes,
    sourceInventoryBytes: Buffer.from(canonicalJson(inventory)),
  };
}

async function fullCapitalFixture() {
  const root = import.meta.dirname;
  const [canonicalPackBytes, coverageTargetsBytes, providerCodeCatalogBytes, routeRostersBytes, inventoryBytes, governancePolicyBytes, freshnessPolicyBytes, productionSnapshotsBytes, productionSpecBytes] = await Promise.all([
    "release/capital-production-canonical-pack.json", "nationwide-coverage-targets.json", "sources/kric-provider-code-catalog-20260228.json",
    "sources/kric-nationwide-route-rosters-20260730T203926676Z.json", "source-inventory.json", "source-governance-policy.json", "../../release/product-gates/datapack-freshness-sla.json", "release/source-snapshots.json", "release/candidate-build-spec.json",
  ].map((name) => readFile(path.join(root, name))));
  const facilityPlan = buildCurrentCapitalFacilityCollectionPlan({ canonicalPackBytes, coverageTargetsBytes, providerCodeCatalogBytes, routeRostersBytes, sourceInventoryBytes: inventoryBytes });
  const roster = facilityPlan.stationLineProviderMappings.map((entry) => ({ stationId: entry.stationId, lineId: entry.lineId, railOprIsttCd: entry.providerOperatorId, lnCd: entry.providerLineId, stinCd: entry.providerStationId, canonicalMappings: [{ artifactId: "fixture", stationId: entry.stationId, lineId: entry.lineId }] }));
  const successorAt = new Date(CURRENT_SOURCE_HEAD_AT + 60_000).toISOString();
  const successorObservedAt = new Date(CURRENT_SOURCE_HEAD_AT + 120_000).toISOString();
  const [snapshot] = await collectKricAccessibilitySnapshots({ roster, operations: [{ sourceId: "kric-station-convenience-standard", endpoint: "https://openapi.kric.go.kr/openapi/handicapped/stationCnvFacl", responseFields: ["dtlLoc", "grndDvCd", "gubun", "imgPath", "mlFmlDvCd", "stinFlor", "trfcWeakDvCd"], tupleIdentityFields: [] }], serviceKey: "fixture-only-key", now: new Date(successorAt), fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ header: { resultCode: "00" }, body: [{ dtlLoc: "fixture", grndDvCd: "1", gubun: "EV", imgPath: "", mlFmlDvCd: "", stinFlor: 1, trfcWeakDvCd: "01" }] }) }) });
  const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot)}\n`); const rawSha256 = "a".repeat(64); const inventory = JSON.parse(inventoryBytes);
  const source = inventory.sources.find(({ id }) => id === snapshot.sourceId); const admission = source.admissionEvidence;
  source.accessibilityAdmissionEvidence = { ...source.accessibilityAdmissionEvidence, decision: "APPROVED", productionUseAllowed: true, snapshotId: snapshot.snapshotId, snapshotPath: `tools/datapack/sources/${snapshot.snapshotId}.json`, rawSha256: snapshot.rawSha256, contentSha256: snapshot.contentSha256, schemaFingerprint: snapshot.schemaFingerprint, redactedRequestFingerprint: snapshot.redactedRequestFingerprint, snapshotFileSha256: sha256(snapshotBytes), capturedAt: snapshot.capturedAt, observedAt: snapshot.observedAt, freshUntil: snapshot.freshUntil, absenceEvidenceMode: "EXHAUSTIVE_LIST" };
  const productionSnapshots = JSON.parse(productionSnapshotsBytes); const productionSpec = JSON.parse(productionSpecBytes);
  const previousId = productionSpec.sourceSnapshots.find(({ sourceId }) => sourceId === snapshot.sourceId)?.snapshotId;
  const previous = productionSnapshots.find((entry) => entry.sourceId === snapshot.sourceId && entry.snapshotId === previousId);
  const ledger = { schemaVersion: 1, artifactKind: "official-source-snapshot", sourceId: snapshot.sourceId, snapshotId: snapshot.snapshotId, provider: source.provider, rawSha256, rawObjectUri: "s3://fixture/raw.json", rawReceipt: { sourceId: snapshot.sourceId, snapshotId: snapshot.snapshotId, snapshotRawSha256: snapshot.rawSha256, snapshotFileSha256: sha256(snapshotBytes), rawObjectSha256: rawSha256, capturedAt: snapshot.capturedAt, storedAt: snapshot.observedAt, byteSize: 1 }, contentSha256: snapshot.contentSha256, redactedRequestFingerprint: snapshot.redactedRequestFingerprint, schemaFingerprint: snapshot.schemaFingerprint, retrievedAt: snapshot.capturedAt, sourceUpdatedAt: snapshot.observedAt, rowCount: snapshot.rowCount, coverageCount: 213, freshnessExpiresAt: snapshot.freshUntil, rawRetentionExpiresAt: new Date(CURRENT_SOURCE_HEAD_AT + 90 * 24 * 60 * 60 * 1_000).toISOString(), governancePolicyVersion: "fixture", governancePolicySha256: "b".repeat(64), adminReviewRecordHash: admission.adminReviewRecordHash, previousSnapshotId: previous.snapshotId, diffSummary: {}, snapshotStatus: "LOCKED", fetchStatus: "SUCCESS", schemaStatus: "PASS", licenseStatus: "PASS", credentialRedacted: true, redistributionAllowed: true };
  ledger.diffSummary = buildSnapshotDiff(previous, ledger);
  const governancePolicy = JSON.parse(governancePolicyBytes); const freshnessPolicy = JSON.parse(freshnessPolicyBytes); const sourceSnapshots = [...productionSnapshots, ledger];
  ledger.governancePolicyVersion = governancePolicy.policyVersion; ledger.governancePolicySha256 = sha256(governancePolicyBytes);
  const selected = productionSpec.sourceSnapshotIds.map((id) => id === previous.snapshotId ? ledger : productionSnapshots.find((entry) => entry.snapshotId === id));
  const selectedIds = new Set(selected.map(({ snapshotId }) => snapshotId));
  const selectedInLedgerOrder = sourceSnapshots.filter(({ snapshotId }) => selectedIds.has(snapshotId));
  const projection = (entry) => deriveReleaseProjection({ snapshot: entry, sourceInventory: inventory, governancePolicy, governancePolicyBytes, freshnessPolicy, nowMillis: Date.parse(successorObservedAt) });
  const candidateBuildSpec = { ...productionSpec, candidateId: "fixture", sourceSnapshotIds: selected.map(({ snapshotId }) => snapshotId), sourceSnapshots: selected.map(projection), sourceSnapshotSetHash: sha256(JSON.stringify(selectedInLedgerOrder)), sourceInventorySha256: sha256(Buffer.from(JSON.stringify(inventory))), networkEdgeEvidence: { sourceInventory: { path: "tools/datapack/source-inventory.json", sha256: sha256(Buffer.from(JSON.stringify(inventory))) } } };
  const facilityAdmission = buildCurrentCapitalFacilitySourceAdmission({ planBytes: Buffer.from(canonicalCurrentCapitalFacilityCollectionPlanJson(facilityPlan)), canonicalPackBytes, snapshotBytes, candidateBuildSpec, sourceInventoryBytes: Buffer.from(JSON.stringify(inventory)), sourceSnapshots, governancePolicy, governancePolicyBytes, freshnessPolicy, observedAt: successorObservedAt });
  return { bundle: await fullBundleFixture(), candidateBuildSpec, facilityAdmission, inventory, ledger, sourceSnapshots, successorObservedAt };
}

async function selectedSourceHeadAt() {
  const root = import.meta.dirname;
  const [buildSpec, sourceSnapshots] = await Promise.all([
    readFile(path.join(root, "release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "release/source-snapshots.json"), "utf8").then(JSON.parse),
  ]);
  const selected = buildSpec.sourceSnapshotIds.map((snapshotId) => {
    const matches = sourceSnapshots.filter((entry) => entry.snapshotId === snapshotId);
    assert.equal(matches.length, 1, `selected source snapshot identity: ${snapshotId}`);
    return matches[0];
  });
  const latest = Math.max(...selected.flatMap((entry) => [entry.retrievedAt, entry.sourceUpdatedAt, entry.rawReceipt?.storedAt]
    .filter(Boolean).map(Date.parse)));
  assert.ok(Number.isFinite(latest));
  return latest;
}

function validInput() {
  const sourceSnapshots = [{
    sourceId: "base-source",
    snapshotId: "base-snapshot",
    rawSha256: "1".repeat(64),
    rawObjectUri: "s3://example/base.json",
    schemaFingerprint: "2".repeat(64),
    licenseStatus: "PASS",
    redistributionAllowed: true,
    snapshotStatus: "LOCKED",
    credentialRedacted: true,
  }];
  const candidate = {
    candidateId: "capital-pilot-candidate-20260813",
    stationSetSha256: "",
    sourceSetSha256: sha256(JSON.stringify(sourceSnapshots)),
    mappingContractVersion: "station-line-v1",
    materializerVersion: "1",
  };
  const stationLines = [stationLine("station-a", "가역", "101"), stationLine("station-b", "나역", "102")];
  candidate.stationSetSha256 = sha256(canonicalJson(stationLines.map(({ stationId }) => stationId)));
  const queryA1 = query(stationLines[0], "101", "102", "edge-a-b");
  const queryA2 = query(stationLines[0], "101", "103", "edge-a-c");
  const queryB = query(stationLines[1], "102", "101", "edge-b-a");
  const outside = query(stationLine("station-c", "다역", "103"), "103", "101", "edge-c-a");
  const queryPlan = [queryA1, queryA2, queryB, outside].sort(compareQueries);
  const providerMappings = stationLines.concat([stationLine("station-c", "다역")]).map((line) => ({
    stationId: line.stationId,
    lineId: line.lineId,
    providerOperatorId: "S1",
    providerLineId: "4",
    providerStationId: line.stationId === "station-a" ? "101" : line.stationId === "station-b" ? "102" : "103",
  }));
  const stationLineQueries = [
    { stationLineId: "station-a:seoul-4", queryIds: [queryA1.queryId, queryA2.queryId] },
    { stationLineId: "station-b:seoul-4", queryIds: [queryB.queryId] },
    { stationLineId: "station-c:seoul-4", queryIds: [outside.queryId] },
  ];
  const collectionPlanPayload = {
    schemaVersion: 1,
    artifactKind: "kric-exit-path-collection-plan",
    candidate: {
      candidateId: `current-production-exit-${"a".repeat(64)}`,
      stationSetSha256: sha256(canonicalJson(["station-a", "station-b", "station-c"])),
      stationLineSetSha256: sha256("full-station-line-set"),
      stationLineMappingSha256: sha256("full-station-line-mapping"),
      providerMappingSha256: sha256(canonicalJson(providerMappings)),
      topologySha256: sha256("topology"),
    },
    providerMappings,
    routeEdges: [],
    queryPlan,
    stationLineQueries,
    queryPlanSha256: sha256(canonicalJson(queryPlan)),
  };
  const collectionPlan = {
    ...collectionPlanPayload,
    collectionPlanDigest: sha256(canonicalJson(collectionPlanPayload)),
  };
  const snapshot = {
    schemaVersion: 1,
    artifactKind: "kric-exit-path-provider-snapshot",
    sourceId: SOURCE_ID,
    snapshotId: "kric-station-movement-standard-20260814T071751158Z",
    capturedAt: CAPTURED_AT,
    freshUntil: FRESH_UNTIL,
    credentialRedacted: true,
    collectionPlanDigest: collectionPlan.collectionPlanDigest,
    queryPlanSha256: sha256(canonicalJson(queryPlan)),
    coverage: { requestPlanComplete: true, queryIds: queryPlan.map(({ queryId }) => queryId) },
    queryPlan,
    results: queryPlan.map(({ queryId }) => {
      if (queryId === queryA2.queryId || queryId === outside.queryId) {
        return providerResult(queryId, "PROVIDER_NO_DATA");
      }
      return providerResult(queryId, "ROWS_OBSERVED");
    }),
  };
  const facilityPayload = {
    schemaVersion: 1,
    artifactKind: "facility-source-admission-matrix",
    observedAt: "2026-08-13T23:18:58.000Z",
    candidate,
    sourceIdentity: {},
    stationLineSetSha256: sha256(canonicalJson(stationLines.map(({ stationId, lineId, operatorId }) => ({
      stationId, lineId, operatorId,
    })))),
    stationLineMappingSha256: sha256(canonicalJson(stationLines)),
    sourceInputIdentitySha256: "3".repeat(64),
    queryPartition: {
      joined: stationLines.map((line) => ({
        stationId: line.stationId,
        lineId: line.lineId,
        providerOperatorId: "S1",
        providerLineId: "4",
        providerStationId: line.stationId === "station-a" ? "101" : "102",
      })),
      unmatched: [],
      ambiguous: [],
      summary: {},
    },
    inputEvidencePartition: {},
    denominatorRows: [],
    denominatorStateSummary: {},
    cells: stationLines.map((line) => ({
      candidateId: candidate.candidateId,
      stationSetSha256: candidate.stationSetSha256,
      sourceSetSha256: candidate.sourceSetSha256,
      stationId: line.stationId,
      lineId: line.lineId,
      operatorId: line.operatorId,
      state: "ADMITTED_FACILITY_PRESENT",
    })),
    cellStateSummary: {},
    materializerEvidenceRows: [],
    decision: "GO",
  };
  const facilityAdmission = {
    ...facilityPayload,
    admissionDigest: sha256(canonicalJson(facilityPayload)),
  };
  return {
    providerSnapshotBytes: providerSnapshotBytes(snapshot),
    collectionPlan,
    facilityAdmission,
    candidateBuildSpec: {
      schemaVersion: 1,
      artifactKind: "datapack-candidate-build-spec",
      candidateId: candidate.candidateId,
      sourceSnapshotIds: sourceSnapshots.map(({ snapshotId }) => snapshotId),
      sourceSnapshots: sourceSnapshots.map((entry) => ({ ...entry })),
      sourceSnapshotSetHash: candidate.sourceSetSha256,
    },
    sourceSnapshots,
    sourceInventory: {
      sources: [{
        id: SOURCE_ID,
        owner: "국가철도공단",
        provider: "국가철도공단",
        providerDepartment: "철도산업정보센터",
        sourceSystem: "KRIC OpenAPI",
        datasetUrl: "https://data.kric.go.kr/example",
        datasetKind: "open-api",
        coverageScope: { regionIds: ["capital"], operatorIds: ["seoul-metro"], sourceDomains: ["indoor_movement_paths"] },
        license: {
          type: "KOGL-1",
          name: "공공누리 1유형",
          attribution: "출처표시",
          commercialUseAllowed: true,
          derivativeWorkAllowed: true,
          redistributionAllowed: true,
          evidenceUrl: "https://data.kric.go.kr/example",
        },
        admissionEvidence: {
          decision: "APPROVED",
          licenseEvidenceHash: "4".repeat(64),
        },
      }],
    },
    observedAt: OBSERVED_AT,
  };
}

function stationLine(stationId, stationName) {
  return {
    stationId,
    stationName,
    stationAliases: [],
    regionId: "capital",
    lineId: "seoul-4",
    lineName: "4호선",
    operatorId: "seoul-metro",
    operatorName: "서울교통공사",
  };
}

function query(line, providerStationId, providerNextStationId, routeEdgeId) {
  const identity = {
    providerLineId: "4",
    providerNextStationId,
    providerOperatorId: "S1",
    providerStationId,
    routeEdgeId,
  };
  return {
    queryId: sha256(canonicalJson(identity)),
    routeEdgeId,
    providerOperatorId: "S1",
    providerLineId: "4",
    providerStationId,
    providerNextStationId,
    operatorName: line.operatorName,
    lineName: line.lineName,
    stationName: line.stationName,
    regionId: line.regionId,
  };
}

function providerResult(queryId, state) {
  const rows = state === "ROWS_OBSERVED" ? [{
    edMovePath: "출입구",
    elvtSttCd: "1",
    elvtTpCd: "EV",
    exitMvTpOrdr: "1",
    imgPath: null,
    mvContDtl: "이동",
    mvPathMgNo: queryId.slice(0, 12),
    stMovePath: "승강장",
  }] : [];
  return {
    queryId,
    state,
    providerResultCode: state === "PROVIDER_NO_DATA" ? "03" : "00",
    rawResponseSha256: sha256(`raw:${queryId}:${state}`),
    rawResponseByteSize: 64,
    providerRecordHash: sha256(canonicalJson(rows)),
    rows,
  };
}

function providerSnapshotBytes(snapshot) {
  const { snapshotDigest: ignored, ...payload } = snapshot;
  return Buffer.from(canonicalJson({ ...payload, snapshotDigest: sha256(canonicalJson(payload)) }));
}

function rebindCollectionPlan(input) {
  input.collectionPlan.queryPlanSha256 = sha256(canonicalJson(input.collectionPlan.queryPlan));
  const { collectionPlanDigest: ignored, ...payload } = input.collectionPlan;
  input.collectionPlan.collectionPlanDigest = sha256(canonicalJson(payload));
}

function rebindFacilityAdmission(input) {
  const projected = input.facilityAdmission.cells.map((cell) => {
    const queryIds = input.collectionPlan.stationLineQueries
      .find(({ stationLineId }) => stationLineId === `${cell.stationId}:${cell.lineId}`).queryIds;
    const query = input.collectionPlan.queryPlan.find(({ queryId }) => queryIds.includes(queryId));
    return {
      stationId: cell.stationId,
      stationName: query.stationName,
      stationAliases: [],
      regionId: query.regionId,
      lineId: cell.lineId,
      lineName: query.lineName,
      operatorId: cell.operatorId,
      operatorName: query.operatorName,
    };
  }).sort(compareStationLines);
  input.facilityAdmission.stationLineSetSha256 = sha256(canonicalJson(projected.map(({
    stationId, lineId, operatorId,
  }) => ({ stationId, lineId, operatorId }))));
  input.facilityAdmission.stationLineMappingSha256 = sha256(canonicalJson(projected));
  const { admissionDigest: ignored, ...payload } = input.facilityAdmission;
  input.facilityAdmission.admissionDigest = sha256(canonicalJson(payload));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalObject(value));
}

function canonicalObject(value) {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort(compareBytes).map((key) => [key, canonicalObject(value[key])]));
}

function compareQueries(left, right) {
  return compareBytes(left.providerStationId, right.providerStationId)
    || compareBytes(left.providerNextStationId, right.providerNextStationId)
    || compareBytes(left.routeEdgeId, right.routeEdgeId)
    || compareBytes(left.queryId, right.queryId);
}

function compareStationLines(left, right) {
  return compareBytes(left.stationId, right.stationId)
    || compareBytes(left.lineId, right.lineId)
    || compareBytes(left.operatorId, right.operatorId);
}

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
