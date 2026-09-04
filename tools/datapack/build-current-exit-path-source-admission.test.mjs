import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

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
import { canonicalCurrentExitReboundAdmissionOciReceiptJson } from "./build-current-exit-admission-oci-receipt.mjs";
import { buildCurrentCapitalFacilityCollectionPlan, canonicalCurrentCapitalFacilityCollectionPlanJson } from "./build-current-capital-facility-collection-plan.mjs";
import { buildCurrentCapitalFacilitySourceAdmission } from "./build-current-capital-facility-source-admission.mjs";
import { collectKricAccessibilitySnapshots } from "./collect-kric-accessibility-snapshots.mjs";
import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";
import { deriveReleaseProjection } from "./rebind-current-candidate-source-snapshots.mjs";
import { buildSnapshotDiff } from "./source-snapshot-policy.mjs";
import { deriveCurrentIncheonTopologyFixturePath } from "./test-fixtures/current-live-chain-artifacts.mjs";
import { copySyntheticCurrentPublicRouteMapRepository } from "./test-fixtures/current-public-route-map-successor.mjs";

const SOURCE_ROOT = import.meta.dirname;
const REPOSITORY_ROOT = path.resolve(SOURCE_ROOT, "../..");
const INITIAL_SOURCE_HEAD_AT = await selectedSourceHeadAt(SOURCE_ROOT);
const FIXTURE_REPOSITORY_ROOT = await mkdtemp(path.join(os.tmpdir(), "current-public-route-map-exit-"));
after(() => rm(FIXTURE_REPOSITORY_ROOT, { recursive: true, force: true }));
await copySyntheticCurrentPublicRouteMapRepository(REPOSITORY_ROOT, FIXTURE_REPOSITORY_ROOT, {
  now: new Date(INITIAL_SOURCE_HEAD_AT + 120_000),
});
const CURRENT_DATAPACK_ROOT = path.join(FIXTURE_REPOSITORY_ROOT, "tools/datapack");
const CURRENT_SOURCE_HEAD_AT = await selectedSourceHeadAt(CURRENT_DATAPACK_ROOT);
const CAPTURED_AT = new Date(CURRENT_SOURCE_HEAD_AT + 60_000).toISOString();
const OBSERVED_AT = new Date(CURRENT_SOURCE_HEAD_AT + 120_000).toISOString();
const FRESH_UNTIL = new Date(CURRENT_SOURCE_HEAD_AT + 60_000 + 24 * 60 * 60 * 1_000).toISOString();
const SOURCE_ID = "kric-station-movement-standard";

test("current provider snapshot을 current full-capital station-line EXIT admission으로 투영한다", async () => {
  const input = await fullCapitalInput();
  const result = buildCurrentExitPathSourceAdmission(input);

  assert.equal(result.normalizedSnapshot.schemaVersion, 4);
  assert.equal(result.admission.schemaVersion, 2);
  assert.deepEqual(
    result.normalizedSnapshot.queryPlan.map(({ queryId }) => queryId),
    input.collectionPlan.queryPlan.map(({ queryId }) => queryId),
  );
  assert.deepEqual(
    result.admission.cells.map(({ stationId, lineId }) => `${stationId}\0${lineId}`).sort(),
    input.facilityAdmission.cells.map(({ stationId, lineId }) => `${stationId}\0${lineId}`).sort(),
  );
  assert.equal(result.admission.decision, "GO");
  assert.deepEqual(
    result.admission.materializerEvidenceRows
      .map(({ stationId, lineId }) => `${stationId}\0${lineId}`).sort(),
    input.facilityAdmission.cells.map(({ stationId, lineId }) => `${stationId}\0${lineId}`).sort(),
  );
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
  const predecessorSnapshotIds = new Set(input.candidateBuildSpec.sourceSnapshotIds.slice(0, -1));
  const expectedExitSourceSetSha256 = sha256(JSON.stringify(
    input.sourceSnapshots.filter(({ snapshotId }) => predecessorSnapshotIds.has(snapshotId)),
  ));
  assert.equal(result.admission.candidate.candidateId, input.candidateBuildSpec.candidateId);
  assert.equal(result.admission.candidate.sourceSetSha256, expectedExitSourceSetSha256);
  assert.notEqual(result.admission.candidate.sourceSetSha256, input.candidateBuildSpec.sourceSnapshotSetHash);
});

test("current EXIT admission rejects a selected TRANSFER that is not terminal", async () => {
  const input = await fullCapitalInput();
  const transferIndex = input.candidateBuildSpec.sourceSnapshots.findIndex(({ sourceId }) =>
    sourceId === "seoul-metro-transfer-distance-duration");
  assert.ok(transferIndex >= 0, "fixture includes selected TRANSFER");
  const [transferSnapshotId] = input.candidateBuildSpec.sourceSnapshotIds.splice(transferIndex, 1);
  const [transferProjection] = input.candidateBuildSpec.sourceSnapshots.splice(transferIndex, 1);
  input.candidateBuildSpec.sourceSnapshotIds.unshift(transferSnapshotId);
  input.candidateBuildSpec.sourceSnapshots.unshift(transferProjection);

  assert.throws(
    () => buildCurrentExitPathSourceAdmission(input),
    /terminal in the candidate/,
  );
});

test("tracked current EXIT handoff는 exact immutable snapshot과 GO admission을 고정한다", async () => {
  const [normalizedBytes, admissionBytes, receiptBytes] = await Promise.all([
    readFile(new URL("./release/current-exit-admission-v2/exit-path-normalized-source-snapshot.json", import.meta.url)),
    readFile(new URL("./release/current-exit-admission-v2/exit-path-source-admission.json", import.meta.url)),
    readFile(new URL("./release/current-exit-admission-v2/exit-path-admission-oci-receipt.json", import.meta.url)),
  ]);
  const normalized = JSON.parse(normalizedBytes);
  const admission = JSON.parse(admissionBytes);
  const receipt = JSON.parse(receiptBytes);
  assert.equal(normalized.schemaVersion, 4);
  assert.equal(admission.schemaVersion, 2);
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(admission.decision, "GO");
  const derivedStateSummary = Object.fromEntries(Object.keys(admission.stateSummary).map((state) => [
    state,
    admission.cells.filter((cell) => cell.state === state).length,
  ]));
  assert.deepEqual(admission.stateSummary, derivedStateSummary);
  assert.equal(admission.sourceIdentity.rawSha256, sha256(normalizedBytes));
  assert.equal(receipt.normalizedSnapshotSha256, sha256(normalizedBytes));
  assert.equal(receipt.admissionSha256, sha256(admissionBytes));
  assert.equal(receipt.admissionDigest, admission.admissionDigest);
  assert.equal(canonicalExitPathAdmissionJson(admission), admissionBytes.toString("utf8"));
  assert.equal(`${canonicalCurrentExitReboundAdmissionOciReceiptJson(receipt)}\n`, receiptBytes.toString("utf8"));
});

test("positive observation이 없는 provider no-data station-line은 terminal blocked로 닫는다", async () => {
  const input = await fullCapitalInput();
  const snapshot = JSON.parse(input.providerSnapshotBytes);
  const stationLine = input.collectionPlan.stationLineQueries[0];
  const stationLineQueryIds = new Set(stationLine.queryIds);
  snapshot.results = snapshot.results.map((result) => stationLineQueryIds.has(result.queryId)
    ? providerResult(result.queryId, "PROVIDER_NO_DATA")
    : result);
  input.providerSnapshotBytes = providerSnapshotBytes(snapshot);

  const result = buildCurrentExitPathSourceAdmission(input);
  assert.equal(result.admission.decision, "GO");
  assert.ok(snapshot.results
    .filter(({ queryId }) => stationLineQueryIds.has(queryId))
    .every(({ state }) => state === "PROVIDER_NO_DATA"));
  const [stationId, lineId] = stationLine.stationLineId.split(":");
  const blocked = result.admission.cells.find((cell) => cell.stationId === stationId && cell.lineId === lineId);
  assert.ok(blocked);
  assert.equal(blocked.admissionReason, "PROVIDER_NO_DATA_UNVERIFIED_BLOCKED");
  assert.match(blocked.providerResponseSha256, /^[a-f0-9]{64}$/);
  const evidence = result.admission.materializerEvidenceRows
    .find((row) => row.stationId === stationId && row.lineId === lineId);
  assert.ok(evidence);
  assert.equal(evidence.state, "UNVERIFIED_EVIDENCE_BLOCKED");
  assert.equal(evidence.evidenceKind, "UNVERIFIED_EVIDENCE_BLOCKED");
  assert.equal(evidence.providerResultCode, "03");
  assert.equal(evidence.providerRecordHash, null);
});

test("raw identity, candidate identity와 source license drift를 fail closed한다", async () => {
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
      input.sourceInventory.sources.find(({ id }) => id === SOURCE_ID).license.redistributionAllowed = false;
    }, /source license mismatch/],
    ["source set", (input) => {
      input.candidateBuildSpec.sourceSnapshotSetHash = "f".repeat(64);
    }, /current capital FACILITY candidate identity mismatch/],
  ];
  for (const [label, mutate, expected] of cases) {
    const input = await fullCapitalInput();
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

test("canonical FACILITY set은 plan-derived EXIT query GO로 직접 결속된다", async () => {
  const {
    bundle, candidateBuildSpec, facilityAdmission, inventory, ledger, sourceSnapshots,
    successorObservedAt,
  } = await fullCapitalFixture();
  const result = buildCurrentExitPathSourceAdmission({ providerSnapshotBytes: bundle.snapshotBytes, collectionPlan: JSON.parse(bundle.planBytes), facilityAdmission, candidateBuildSpec, sourceInventory: inventory, sourceSnapshots, observedAt: successorObservedAt });
  assert.deepEqual(
    result.admission.cells.map(({ stationId, lineId }) => `${stationId}\0${lineId}`).sort(),
    facilityAdmission.cells.map(({ stationId, lineId }) => `${stationId}\0${lineId}`).sort(),
  );
  assert.deepEqual(
    result.normalizedSnapshot.queryPlan.map(({ queryId }) => queryId),
    JSON.parse(bundle.planBytes).queryPlan.map(({ queryId }) => queryId),
  );
  assert.equal(result.admission.decision, "GO");
  const snapshotRawDrift = structuredClone(facilityAdmission);
  snapshotRawDrift.sourceIdentity.rawSha256 = "f".repeat(64);
  const { admissionDigest: ignoredDigest, ...snapshotRawPayload } = snapshotRawDrift;
  snapshotRawDrift.admissionDigest = sha256(canonicalJson(snapshotRawPayload));
  assert.throws(() => buildCurrentExitPathSourceAdmission({ providerSnapshotBytes: bundle.snapshotBytes, collectionPlan: JSON.parse(bundle.planBytes), facilityAdmission: snapshotRawDrift, candidateBuildSpec, sourceInventory: inventory, sourceSnapshots: [ledger], observedAt: successorObservedAt }), /raw object provenance mismatch/);
});


test("station-line query와 source coverage를 provider mapping·inventory에 exact 결속한다", async () => {
  const crossProvider = await fullCapitalInput();
  const stationA = crossProvider.collectionPlan.stationLineQueries
    .at(0);
  const stationAQuery = crossProvider.collectionPlan.queryPlan
    .find(({ queryId }) => stationA.queryIds.includes(queryId));
  const foreignQuery = crossProvider.collectionPlan.queryPlan
    .find(({ queryId }) => !stationA.queryIds.includes(queryId));
  const foreignStationLine = crossProvider.collectionPlan.stationLineQueries
    .find(({ queryIds }) => queryIds.includes(foreignQuery.queryId));
  stationA.queryIds[stationA.queryIds.indexOf(stationAQuery.queryId)] = foreignQuery.queryId;
  foreignStationLine.queryIds[foreignStationLine.queryIds.indexOf(foreignQuery.queryId)] = stationAQuery.queryId;
  rebindCollectionPlan(crossProvider);
  const crossProviderSnapshot = JSON.parse(crossProvider.providerSnapshotBytes);
  crossProviderSnapshot.collectionPlanDigest = crossProvider.collectionPlan.collectionPlanDigest;
  crossProvider.providerSnapshotBytes = providerSnapshotBytes(crossProviderSnapshot);
  assert.throws(
    () => buildCurrentExitPathSourceAdmission(crossProvider),
    /current EXIT provider mapping mismatch/,
  );

  const outsideOperator = await fullCapitalInput();
  outsideOperator.sourceInventory.sources
    .find(({ id }) => id === SOURCE_ID).coverageScope.operatorIds = ["outside-operator"];
  assert.throws(
    () => buildCurrentExitPathSourceAdmission(outsideOperator),
    /current EXIT source coverage mismatch/,
  );

  const outsideRegion = await fullCapitalInput();
  const outsideRegionQueryIds = new Set(outsideRegion.collectionPlan.stationLineQueries[0].queryIds);
  for (const query of outsideRegion.collectionPlan.queryPlan) {
    if (outsideRegionQueryIds.has(query.queryId)) query.regionId = "outside-region";
  }
  rebindCollectionPlan(outsideRegion);
  const outsideRegionSnapshot = JSON.parse(outsideRegion.providerSnapshotBytes);
  outsideRegionSnapshot.queryPlan = structuredClone(outsideRegion.collectionPlan.queryPlan);
  outsideRegionSnapshot.queryPlanSha256 = outsideRegion.collectionPlan.queryPlanSha256;
  outsideRegionSnapshot.collectionPlanDigest = outsideRegion.collectionPlan.collectionPlanDigest;
  outsideRegion.providerSnapshotBytes = providerSnapshotBytes(outsideRegionSnapshot);
  assert.throws(
    () => buildCurrentExitPathSourceAdmission(outsideRegion),
    /current EXIT source coverage mismatch/,
  );
});

test("CLI는 normalized snapshot과 admission을 absent directory에 함께 쓴다", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-exit-admission-"));
  const input = await fullCapitalInput();
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
    "--observed-at", input.observedAt,
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
    "--observed-at", input.observedAt,
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
    "--expected-operation-id", "current-capital-560",
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
    "--expected-operation-id", "current-capital-560", ...common, "--output-directory", paths.missingDigestOutput,
  ], { log: () => {} }), /arguments mismatch/);
  await assert.rejects(() => stat(paths.missingDigestOutput), /ENOENT/);
  await assert.rejects(() => main([
    "--collection-bundle", paths.bundle, "--expected-bundle-sha256", "b".repeat(64),
    "--expected-repository-sha", "a".repeat(40), "--expected-operation-id", "current-capital-560",
    ...common, "--output-directory", paths.wrongDigestOutput,
  ], { log: () => {} }), /expected digest mismatch/);
  await assert.rejects(() => stat(paths.wrongDigestOutput), /ENOENT/);
  await main([
    "--collection-bundle", paths.bundle, "--expected-bundle-sha256", sha256(fixture.bundle.bundleBytes), "--expected-repository-sha", "a".repeat(40),
    "--expected-operation-id", "current-capital-560", ...common, "--output-directory", paths.bundleOutput,
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
    "--expected-operation-id", "current-capital-560", ...common, "--output-directory", paths.collisionOutput,
  ], { log: () => {} }), /output directory must be absent/);
  assert.equal(await readFile(paths.collisionOutput, "utf8"), "preserve");
});

async function fullBundleFixture() {
  const root = import.meta.dirname;
  const files = {
    canonicalPackBytes: "release/capital-production-canonical-pack.json", coverageTargetsBytes: "nationwide-coverage-targets.json",
    providerCodeCatalogBytes: "sources/kric-provider-code-catalog-20260228.json", routeRostersBytes: "sources/kric-nationwide-route-rosters-20260730T203926676Z.json",
    sourceInventoryBytes: "source-inventory.json",
  };
  const input = Object.fromEntries(
    await Promise.all(Object.entries(files).map(async ([key, file]) => [key, await readFile(path.join(root, file))])),
  );
  input.incheonTopologyBytes = await readFile(path.join(
    root,
    deriveCurrentIncheonTopologyFixturePath(JSON.parse(input.sourceInventoryBytes)),
  ));
  const capturedAt = Date.parse(CAPTURED_AT);
  const incheonCapturedAt = Date.parse(JSON.parse(input.incheonTopologyBytes).capturedAt);
  assert.ok(Number.isFinite(capturedAt), "fixture operation timestamp");
  assert.ok(Number.isFinite(incheonCapturedAt), "Incheon topology capturedAt");
  const plan = buildCurrentKricExitCollectionPlan(input, { now: new Date(Math.max(capturedAt, incheonCapturedAt)), coverageSelector: "capital-seoul-metro-production" });
  const rows = [{ edMovePath: null, elvtSttCd: null, elvtTpCd: null, exitMvTpOrdr: "1", imgPath: null, mvContDtl: null, mvPathMgNo: "1", stMovePath: null }];
  const results = plan.queryPlan.map((query, index) => ({ queryId: query.queryId, state: index === 0 ? "ROWS_OBSERVED" : "EXPLICIT_ZERO", providerResultCode: "00", rawResponseSha256: sha256(`raw-${index}`), rawResponseByteSize: 1, providerRecordHash: sha256(canonicalJson(index === 0 ? rows : [])), rows: index === 0 ? rows : [] }));
  const snapshotPayload = { schemaVersion: 1, artifactKind: "kric-exit-path-provider-snapshot", sourceId: SOURCE_ID, snapshotId: `kric-station-movement-standard-${CAPTURED_AT.replaceAll(/[-:.]/gu, "")}`, capturedAt: CAPTURED_AT, freshUntil: FRESH_UNTIL, credentialRedacted: true, collectionPlanDigest: plan.collectionPlanDigest, queryPlanSha256: plan.queryPlanSha256, coverage: { requestPlanComplete: true, queryIds: plan.queryPlan.map(({ queryId }) => queryId) }, queryPlan: plan.queryPlan, results };
  const snapshot = { ...snapshotPayload, snapshotDigest: sha256(canonicalJson(snapshotPayload)) };
  const planBytes = Buffer.from(canonicalJson(plan)); const snapshotBytes = Buffer.from(canonicalJson(snapshot));
  const receipt = buildCurrentKricExitCollectionReceipt({ collectionPlanBytes: planBytes, providerSnapshotBytes: snapshotBytes, repository: "AquilaXk/easysubway-data", repositorySha: "a".repeat(40), operationId: "current-capital-560" });
  const bundle = buildCurrentKricExitCollectionBundle({ collectionPlanBytes: planBytes, providerSnapshotBytes: snapshotBytes, receipt });
  return { planBytes, snapshotBytes, bundleBytes: Buffer.from(canonicalJson(bundle)) };
}

async function fullCapitalFixture() {
  const [canonicalPackBytes, coverageTargetsBytes, providerCodeCatalogBytes, routeRostersBytes, inventoryBytes, governancePolicyBytes, freshnessPolicyBytes, productionSnapshotsBytes, productionSpecBytes] = await Promise.all([
    "release/capital-production-canonical-pack.json", "nationwide-coverage-targets.json", "sources/kric-provider-code-catalog-20260228.json",
    "sources/kric-nationwide-route-rosters-20260730T203926676Z.json", "source-inventory.json", "source-governance-policy.json", "../../release/product-gates/datapack-freshness-sla.json", "release/source-snapshots.json", "release/candidate-build-spec.json",
  ].map((name) => readFile(path.join(name.startsWith("sources/kric-") ? SOURCE_ROOT : CURRENT_DATAPACK_ROOT, name))));
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
  const ledger = { schemaVersion: 1, artifactKind: "official-source-snapshot", sourceId: snapshot.sourceId, snapshotId: snapshot.snapshotId, provider: source.provider, rawSha256, rawObjectUri: "oci://fixture/easysubway-datapacks/raw.json", rawReceipt: { sourceId: snapshot.sourceId, snapshotId: snapshot.snapshotId, snapshotRawSha256: snapshot.rawSha256, snapshotFileSha256: sha256(snapshotBytes), rawObjectSha256: rawSha256, capturedAt: snapshot.capturedAt, storedAt: snapshot.observedAt, byteSize: 1 }, contentSha256: snapshot.contentSha256, redactedRequestFingerprint: snapshot.redactedRequestFingerprint, schemaFingerprint: snapshot.schemaFingerprint, retrievedAt: snapshot.capturedAt, sourceUpdatedAt: snapshot.observedAt, rowCount: snapshot.rowCount, coverageCount: facilityPlan.stationLineProviderMappings.length, freshnessExpiresAt: snapshot.freshUntil, rawRetentionExpiresAt: new Date(CURRENT_SOURCE_HEAD_AT + 90 * 24 * 60 * 60 * 1_000).toISOString(), governancePolicyVersion: "fixture", governancePolicySha256: "b".repeat(64), adminReviewRecordHash: admission.adminReviewRecordHash, previousSnapshotId: previous.snapshotId, diffSummary: {}, snapshotStatus: "LOCKED", fetchStatus: "SUCCESS", schemaStatus: "PASS", licenseStatus: "PASS", credentialRedacted: true, redistributionAllowed: true };
  ledger.diffSummary = buildSnapshotDiff(previous, ledger);
  const governancePolicy = JSON.parse(governancePolicyBytes); const freshnessPolicy = JSON.parse(freshnessPolicyBytes);
  ledger.governancePolicyVersion = governancePolicy.policyVersion; ledger.governancePolicySha256 = sha256(governancePolicyBytes);
  const resealCurrentSnapshot = (entry) => {
    const sourceClass = freshnessPolicy.sourceClasses.find(({ sourceIds }) => sourceIds.includes(entry.sourceId));
    if (!sourceClass) throw new Error(`fixture freshness class missing: ${entry.sourceId}`);
    return {
      ...entry,
      freshnessExpiresAt: deriveFreshnessExpiresAt({
        policy: freshnessPolicy,
        sourceClassId: sourceClass.id,
        basisAt: entry[sourceClass.basisField],
        providerValidUntil: sourceClass.providerValidityEndField ? entry[sourceClass.providerValidityEndField] : undefined,
        evaluationAt: successorObservedAt,
      }),
      governancePolicyVersion: governancePolicy.policyVersion,
      governancePolicySha256: sha256(governancePolicyBytes),
    };
  };
  const selected = productionSpec.sourceSnapshotIds.map((id) => id === previous.snapshotId
    ? ledger
    : resealCurrentSnapshot(productionSnapshots.find((entry) => entry.snapshotId === id)));
  const selectedIds = new Set(selected.map(({ snapshotId }) => snapshotId));
  const sourceSnapshots = [...productionSnapshots.filter(({ snapshotId }) => !selectedIds.has(snapshotId)), ...selected];
  const selectedInLedgerOrder = sourceSnapshots.filter(({ snapshotId }) => selectedIds.has(snapshotId));
  const projection = (entry) => deriveReleaseProjection({ snapshot: entry, sourceInventory: inventory, governancePolicy, governancePolicyBytes, freshnessPolicy, nowMillis: Date.parse(successorObservedAt) });
  const candidateBuildSpec = { ...productionSpec, candidateId: "fixture", sourceSnapshotIds: selected.map(({ snapshotId }) => snapshotId), sourceSnapshots: selected.map(projection), sourceSnapshotSetHash: sha256(JSON.stringify(selectedInLedgerOrder)), sourceInventorySha256: sha256(Buffer.from(JSON.stringify(inventory))), networkEdgeEvidence: { sourceInventory: { path: "tools/datapack/source-inventory.json", sha256: sha256(Buffer.from(JSON.stringify(inventory))) } } };
  const facilityAdmission = buildCurrentCapitalFacilitySourceAdmission({ planBytes: Buffer.from(canonicalCurrentCapitalFacilityCollectionPlanJson(facilityPlan)), canonicalPackBytes, snapshotBytes, candidateBuildSpec, candidateEvaluationAt: candidateBuildSpec.publishedAt, sourceInventoryBytes: Buffer.from(JSON.stringify(inventory)), sourceSnapshots, governancePolicy, governancePolicyBytes, freshnessPolicy, observedAt: successorObservedAt });
  return { bundle: await fullBundleFixture(), candidateBuildSpec, facilityAdmission, inventory, ledger, sourceSnapshots, successorObservedAt };
}

async function fullCapitalInput() {
  const fixture = await fullCapitalFixture();
  return {
    providerSnapshotBytes: fixture.bundle.snapshotBytes,
    collectionPlan: JSON.parse(fixture.bundle.planBytes),
    facilityAdmission: fixture.facilityAdmission,
    candidateBuildSpec: fixture.candidateBuildSpec,
    sourceInventory: fixture.inventory,
    sourceSnapshots: fixture.sourceSnapshots,
    observedAt: fixture.successorObservedAt,
  };
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
    rawObjectUri: "oci://fixture/easysubway-datapacks/base.json",
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

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
