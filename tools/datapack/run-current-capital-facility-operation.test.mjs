import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { buildCurrentCapitalFacilityCollectionPlan, canonicalCurrentCapitalFacilityCollectionPlanJson } from "./build-current-capital-facility-collection-plan.mjs";
import { buildCurrentCapitalFacilitySourceAdmission, canonicalCurrentCapitalFacilitySourceAdmissionJson } from "./build-current-capital-facility-source-admission.mjs";
import { KRIC_ACCESSIBILITY_OPERATIONS, writeKricStandardAccessibilityObservation } from "./collect-kric-accessibility-snapshots.mjs";
import { rebindCurrentCandidateSourceSnapshots } from "./rebind-current-candidate-source-snapshots.mjs";
import { buildSnapshotDiff } from "./source-snapshot-policy.mjs";
import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";
import { deriveRawRetentionExpiresAt } from "./source-governance-policy.mjs";
import { copySyntheticCurrentPublicRouteMapRepository } from "./test-fixtures/current-public-route-map-successor.mjs";
import { collectCurrentCapitalFacilityOperation, durableCreateBytes, main, parseArgs, prepareCurrentCapitalFacilityOperation, recoverPublishedCurrentCapitalFacilityOperation, syncWrite } from "./run-current-capital-facility-operation.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const CURRENT_SOURCE_HEAD_AT = await selectedSourceHeadAt();
const NOW = new Date(CURRENT_SOURCE_HEAD_AT + 120_000);
const OCI_ENV = Object.freeze({ EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/redacted/n/axvym6vk8g7i/b/easysubway-datapacks/o" });
process.env.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL = OCI_ENV.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL;
const EXACT_MAIN = "e8c391ffd051fa2ccd7a275a7865aa65b94f6523";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const jsonSha = (value) => sha(Buffer.from(JSON.stringify(value)));
const FIXTURE_INPUTS = [
  "tools/datapack/release/candidate-build-spec.json", "tools/datapack/release/release-request.json",
  "tools/datapack/release/hash-evidence.json",
  "tools/datapack/release/source-snapshots.json", "tools/datapack/release/capital-production-canonical-pack.json",
  "tools/datapack/release/current-capital-facility-source-admission.json",
  "tools/datapack/source-inventory.json", "tools/datapack/source-governance-policy.json",
  "release/product-gates/datapack-freshness-sla.json", "tools/datapack/nationwide-coverage-targets.json",
  "tools/datapack/sources/kric-provider-code-catalog-20260228.json",
  "tools/datapack/sources/kric-nationwide-route-rosters-20260730T203926676Z.json",
];
function exactMainExec(file, args) {
  if (file !== "git") throw new Error(`unexpected command: ${file}`);
  if (args[0] === "status") return { stdout: "" };
  return { stdout: `${EXACT_MAIN}\n` };
}

async function selectedSourceHeadAt() {
  const [buildSpec, sourceSnapshots] = await Promise.all([
    readFile(path.join(REPOSITORY_ROOT, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(REPOSITORY_ROOT, "tools/datapack/release/source-snapshots.json"), "utf8").then(JSON.parse),
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

function nextSnapshot(plan) {
  const operation = KRIC_ACCESSIBILITY_OPERATIONS.find(({ sourceId }) => sourceId === "kric-station-convenience-standard");
  const capturedAt = new Date(CURRENT_SOURCE_HEAD_AT + 60_000).toISOString();
  const queries = plan.stationLineProviderMappings.map((mapping) => ({
    stationId: mapping.stationId, lineId: mapping.lineId, railOprIsttCd: mapping.providerOperatorId,
    lnCd: mapping.providerLineId, stinCd: mapping.providerStationId, rows: [], rawResponseSha256: sha(Buffer.from(JSON.stringify({ header: { resultCode: "00" }, body: [] }))),
    providerRecordHash: jsonSha([]), status: "ABSENT_EXPLICIT_ZERO",
    canonicalMappings: [{ artifactId: "bundled-capital", stationId: mapping.stationId, lineId: mapping.lineId }],
  }));
  return {
    schemaVersion: 1, artifactKind: "kric-accessibility-snapshot", sourceId: operation.sourceId,
    snapshotId: `kric-station-convenience-standard-${capturedAt.replaceAll(/[-:.]/g, "")}`, capturedAt, observedAt: capturedAt,
    freshUntil: new Date(Date.parse(capturedAt) + 24 * 60 * 60 * 1_000).toISOString(), providerResultCode: "00", schemaStatus: "PASS",
    absenceEvidenceMode: "EXHAUSTIVE_LIST", credentialRedacted: true, queries, queryCount: queries.length, rowCount: 0,
    contentSha256: jsonSha(queries.map(({ rawResponseSha256: _ignored, ...query }) => query)),
    rawSha256: jsonSha(queries.map(({ stationId, lineId, railOprIsttCd, lnCd, stinCd, rawResponseSha256 }) => ({ stationId, lineId, railOprIsttCd, lnCd, stinCd, rawResponseSha256 }))),
    schemaFingerprint: jsonSha([...operation.responseFields].sort()),
    redactedRequestFingerprint: jsonSha({ endpoint: operation.endpoint, tuples: queries.map(({ railOprIsttCd, lnCd, stinCd }) => ({ railOprIsttCd, lnCd, stinCd })) }),
  };
}

function observationFor(snapshot) {
  const responses = snapshot.queries.map(({ railOprIsttCd, lnCd, stinCd, rawResponseSha256 }) => {
    const bytes = Buffer.from(JSON.stringify({ header: { resultCode: "00" }, body: [] }));
    return { railOprIsttCd, lnCd, stinCd, providerResultCode: "00", rawResponseSha256, byteSize: bytes.length, bodyBase64: bytes.toString("base64") };
  });
  return { snapshot, rawArtifact: { schemaVersion: 1, artifactKind: "kric-accessibility-raw-collection", sourceId: snapshot.sourceId, snapshotId: snapshot.snapshotId, capturedAt: snapshot.capturedAt, snapshotRawSha256: snapshot.rawSha256, credentialRedacted: true, requestCount: responses.length, inventorySha256: jsonSha(responses.map(({ bodyBase64: _ignored, ...response }) => response)), responses } };
}

function terminalObservationFor(plan) {
  const snapshot = nextSnapshot(plan);
  const query = snapshot.queries.find(({ stationId, lineId, railOprIsttCd, lnCd, stinCd }) => (
    stationId === "station-b35616704ce3" && lineId === "seoul-2" && railOprIsttCd === "S1" && lnCd === "2" && stinCd === "234-4"
  ));
  assert.ok(query);
  for (const normal of snapshot.queries) {
    normal.providerResultCode = "00";
    normal.terminalPolicy = null;
  }
  const bytes = Buffer.from(JSON.stringify({ header: { resultCode: "03" }, body: [] }));
  Object.assign(query, { providerResultCode: "03", status: "UNVERIFIED_EVIDENCE_BLOCKED", terminalPolicy: "EXACT_TUPLE_PROVIDER_RESULT_03", providerRecordHash: null, rawResponseSha256: sha(bytes) });
  snapshot.providerResultCode = "MIXED";
  snapshot.absenceEvidenceMode = "EXHAUSTIVE_LIST_WITH_UNVERIFIED_EVIDENCE_BLOCKED";
  snapshot.contentSha256 = jsonSha(snapshot.queries.map(({ rawResponseSha256: _ignored, ...value }) => value));
  snapshot.rawSha256 = jsonSha(snapshot.queries.map(({
    stationId, lineId, railOprIsttCd, lnCd, stinCd, rawResponseSha256,
    providerResultCode, terminalPolicy, providerRecordHash,
  }) => ({
    stationId, lineId, railOprIsttCd, lnCd, stinCd, rawResponseSha256,
    providerResultCode, terminalPolicy, providerRecordHash,
  })));
  const observation = observationFor(snapshot);
  const response = observation.rawArtifact.responses.find(({ stinCd }) => stinCd === "234-4");
  Object.assign(response, { providerResultCode: "03", rawResponseSha256: sha(bytes), byteSize: bytes.length, bodyBase64: bytes.toString("base64") });
  observation.rawArtifact.snapshotRawSha256 = snapshot.rawSha256;
  observation.rawArtifact.inventorySha256 = jsonSha(observation.rawArtifact.responses.map(({ bodyBase64: _ignored, ...value }) => value));
  return observation;
}

async function writeJson(target, value) { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, `${JSON.stringify(value, null, 2)}\n`); }

async function bindReleaseRequestToCandidate(root) {
  const candidatePath = path.join(root, "tools/datapack/release/candidate-build-spec.json");
  const requestPath = path.join(root, "tools/datapack/release/release-request.json");
  const candidate = JSON.parse(await readFile(candidatePath, "utf8"));
  const selectedSnapshotIds = new Set(candidate.sourceSnapshotIds);
  const snapshots = JSON.parse(await readFile(path.join(root, "tools/datapack/release/source-snapshots.json"), "utf8"));
  candidate.sourceSnapshotSetHash = sha(JSON.stringify(
    snapshots.filter(({ snapshotId }) => selectedSnapshotIds.has(snapshotId)),
  ));
  await writeJson(candidatePath, candidate);
  const candidateBytes = await readFile(candidatePath);
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  await writeJson(requestPath, {
    ...request,
    candidateId: candidate.candidateId,
    buildSpecSha256: sha(candidateBytes),
    sourceSnapshotSetHash: candidate.sourceSnapshotSetHash,
    approvedLedgerHash: candidate.approvedAliasLedgerHash,
  });
}

async function currentReleaseFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "facility-current-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of FIXTURE_INPUTS) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(REPOSITORY_ROOT, relative), target);
  }
  await copySyntheticCurrentPublicRouteMapRepository(REPOSITORY_ROOT, root, { now: NOW });
  const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const snapshotPath = inventory.sources.find(
    ({ id }) => id === "kric-station-convenience-standard",
  ).accessibilityAdmissionEvidence.snapshotPath;
  await mkdir(path.dirname(path.join(root, snapshotPath)), { recursive: true });
  await cp(path.join(REPOSITORY_ROOT, snapshotPath), path.join(root, snapshotPath));
  await bindReleaseRequestToCandidate(root);
  return root;
}

async function finalizeFixture(t, { prepared = false } = {}) {
  const root = await currentReleaseFixture(t);
  const operationRoot = await mkdtemp(path.join(tmpdir(), "facility-finalize-operation-"));
  t.after(() => rm(operationRoot, { recursive: true, force: true }));
  const load = (relative) => readFile(path.join(root, relative));
  const [canonicalPackBytes, coverageTargetsBytes, providerCodeCatalogBytes, routeRostersBytes, sourceInventoryBytes] = await Promise.all([
    load("tools/datapack/release/capital-production-canonical-pack.json"), load("tools/datapack/nationwide-coverage-targets.json"),
    load("tools/datapack/sources/kric-provider-code-catalog-20260228.json"), load("tools/datapack/sources/kric-nationwide-route-rosters-20260730T203926676Z.json"), load("tools/datapack/source-inventory.json"),
  ]);
  const plan = buildCurrentCapitalFacilityCollectionPlan({ canonicalPackBytes, coverageTargetsBytes, providerCodeCatalogBytes, routeRostersBytes, sourceInventoryBytes });
  const snapshot = nextSnapshot(plan); const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
  const snapshotsPath = path.join(root, "tools/datapack/release/source-snapshots.json"); const inventoryPath = path.join(root, "tools/datapack/source-inventory.json");
  const snapshots = JSON.parse(await readFile(snapshotsPath, "utf8")); const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  const candidate = JSON.parse(await readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8"));
  const previousId = candidate.sourceSnapshots.find(({ sourceId }) => sourceId === snapshot.sourceId)?.snapshotId;
  const previous = snapshots.find(({ snapshotId }) => snapshotId === previousId); assert.ok(previous);
  const dateToken = snapshot.capturedAt.slice(0, 10).replaceAll("-", "");
  const next = { ...structuredClone(previous), snapshotId: snapshot.snapshotId, previousSnapshotId: previous.snapshotId, retrievedAt: snapshot.capturedAt, sourceUpdatedAt: snapshot.capturedAt, rowCount: 0, coverageCount: 213, rawSha256: "a".repeat(64), rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/source-raw/kric-station-convenience-standard/${dateToken}/${"a".repeat(64)}.json`, redactedRequestFingerprint: snapshot.redactedRequestFingerprint, schemaFingerprint: snapshot.schemaFingerprint, contentSha256: snapshot.contentSha256, freshnessExpiresAt: snapshot.freshUntil, rawRetentionExpiresAt: snapshot.freshUntil };
  const governanceBytes = await load("tools/datapack/source-governance-policy.json"); const governance = JSON.parse(governanceBytes);
  const freshnessPolicy = JSON.parse(await load("release/product-gates/datapack-freshness-sla.json"));
  next.freshnessExpiresAt = deriveFreshnessExpiresAt({ policy: freshnessPolicy, sourceClassId: "static_accessibility_facility", basisAt: snapshot.capturedAt, evaluationAt: NOW.toISOString() });
  next.rawRetentionExpiresAt = deriveRawRetentionExpiresAt({ policy: governance, sourceId: next.sourceId, retrievedAt: snapshot.capturedAt });
  next.governancePolicyVersion = governance.policyVersion; next.governancePolicySha256 = sha(governanceBytes);
  next.rawReceipt = { ...next.rawReceipt, snapshotId: next.snapshotId, snapshotRawSha256: snapshot.rawSha256, rawObjectSha256: next.rawSha256, capturedAt: snapshot.capturedAt, storedAt: new Date(CURRENT_SOURCE_HEAD_AT + 90_000).toISOString(), byteSize: 213, snapshotFileSha256: sha(snapshotBytes) };
  next.diffSummary = buildSnapshotDiff(previous, next); snapshots.push(next);
  const source = inventory.sources.find(({ id }) => id === next.sourceId); next.adminReviewRecordHash = source.admissionEvidence.adminReviewRecordHash; source.retrievedAt = snapshot.capturedAt.slice(0, 10); source.observedDataUpdatedAt = snapshot.capturedAt.slice(0, 10);
  source.accessibilityAdmissionEvidence = { ...source.accessibilityAdmissionEvidence, snapshotId: next.snapshotId, capturedAt: snapshot.capturedAt, observedAt: snapshot.capturedAt, freshUntil: snapshot.freshUntil, rawSha256: snapshot.rawSha256, contentSha256: snapshot.contentSha256, schemaFingerprint: snapshot.schemaFingerprint, snapshotPath: `tools/datapack/sources/${next.snapshotId}.json`, snapshotFileSha256: sha(snapshotBytes), absenceEvidenceMode: "EXHAUSTIVE_LIST", licenseEvidenceHash: source.admissionEvidence.licenseEvidenceHash };
  await writeJson(snapshotsPath, snapshots); await writeJson(inventoryPath, inventory);
  const observationRoot = path.join(operationRoot, "observation");
  const planBytes = Buffer.from(canonicalCurrentCapitalFacilityCollectionPlanJson(plan));
  await writeKricStandardAccessibilityObservation({ outputRoot: observationRoot, observation: observationFor(snapshot) });
  const [manifestBytes, observedSnapshotBytes, rawBytes] = await Promise.all([readFile(path.join(observationRoot, "observation.json"), "utf8"), readFile(path.join(observationRoot, `${snapshot.snapshotId}.json`)), readFile(path.join(observationRoot, `${snapshot.snapshotId}.raw.json`))]);
  next.rawSha256 = sha(rawBytes); next.rawObjectUri = `oci://axvym6vk8g7i/easysubway-datapacks/source-raw/${next.sourceId}/${dateToken}/${next.rawSha256}.json`;
  next.rawReceipt = { ...next.rawReceipt, rawObjectSha256: next.rawSha256, byteSize: rawBytes.length, snapshotFileSha256: sha(snapshotBytes) };
  next.diffSummary = buildSnapshotDiff(previous, next); await writeJson(snapshotsPath, snapshots);
  if (prepared) {
    const preparedRoot = path.join(operationRoot, "prepared");
    await prepareCurrentCapitalFacilityOperation({ repositoryRoot: root, operationRoot: preparedRoot, expectedMainSha: EXACT_MAIN, execFileImpl: exactMainExec, now: NOW });
    const preparedJournal = JSON.parse(await readFile(path.join(preparedRoot, "journal.json"), "utf8"));
    await rm(preparedRoot, { recursive: true, force: true });
    await writeFile(path.join(operationRoot, "plan.json"), planBytes);
    await writeJson(path.join(operationRoot, "journal.json"), { ...preparedJournal, phase: "FINALIZE_STARTED", planSha256: sha(planBytes), completedObservation: { snapshotId: snapshot.snapshotId, manifestSha256: sha(Buffer.from(manifestBytes)), snapshotSha256: sha(observedSnapshotBytes), rawSha256: sha(rawBytes) }, completedStages: {} });
  } else {
    await writeFile(path.join(operationRoot, "plan.json"), planBytes);
    await writeJson(path.join(operationRoot, "journal.json"), { schemaVersion: 1, artifactKind: "current-capital-facility-operation-journal", phase: "FINALIZE_STARTED", expectedMainSha: EXACT_MAIN, planSha256: sha(planBytes), priorAdmissionSha256: sha(await readFile(path.join(root, "tools/datapack/release/current-capital-facility-source-admission.json"))), completedObservation: { snapshotId: snapshot.snapshotId, manifestSha256: sha(Buffer.from(manifestBytes)), snapshotSha256: sha(observedSnapshotBytes), rawSha256: sha(rawBytes) }, completedStages: {} });
  }
  return { root, operationRoot, snapshot, snapshotBytes, rawBytes, plan, ledger: next };
}

function receipt(fixture) {
  const rawObjectSha256 = sha(fixture.rawBytes);
  return {
    schemaVersion: 1,
    artifactKind: "kric-accessibility-raw-object-receipt",
    sourceId: fixture.snapshot.sourceId,
    snapshotId: fixture.snapshot.snapshotId,
    snapshotRawSha256: fixture.snapshot.rawSha256,
    capturedAt: fixture.snapshot.capturedAt,
    snapshotFileSha256: sha(fixture.snapshotBytes),
    rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/source-raw/${fixture.snapshot.sourceId}/${fixture.snapshot.capturedAt.slice(0, 10).replaceAll("-", "")}/${rawObjectSha256}.json`,
    rawObjectSha256,
    byteSize: fixture.rawBytes.length,
    storedAt: new Date(CURRENT_SOURCE_HEAD_AT + 90_000).toISOString(),
    rawRetentionExpiresAt: fixture.ledger.rawRetentionExpiresAt,
  };
}

async function publishedRecoveryFixture(t) {
  const source = await finalizeFixture(t);
  const sourceReceipt = receipt(source);
  const receiptBytes = Buffer.from(`${JSON.stringify(sourceReceipt, null, 2)}\n`);
  await writeFile(path.join(source.operationRoot, "receipt.json"), receiptBytes);
  const journalPath = path.join(source.operationRoot, "journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.collectionStartedAt = source.snapshot.capturedAt;
  journal.finalizeObservedAt = NOW.toISOString();
  journal.completedStages = { published: { snapshotId: source.snapshot.snapshotId, receiptSha256: sha(receiptBytes) }, registered: { ignored: true }, rebound: { ignored: true } };
  await writeJson(journalPath, journal);
  return { source, sourceReceipt, receiptBytes, journal, journalPath };
}

async function admissionFor({ root, operationRoot, snapshot }) {
  const read = (relative) => readFile(path.join(root, relative));
  const [planBytes, canonicalPackBytes, snapshotBytes, candidateBytes, inventoryBytes, snapshotsBytes, governanceBytes, freshnessBytes] = await Promise.all([
    read(path.relative(root, path.join(operationRoot, "plan.json"))), read("tools/datapack/release/capital-production-canonical-pack.json"), read(`tools/datapack/sources/${snapshot.snapshotId}.json`), read("tools/datapack/release/candidate-build-spec.json"), read("tools/datapack/source-inventory.json"), read("tools/datapack/release/source-snapshots.json"), read("tools/datapack/source-governance-policy.json"), read("release/product-gates/datapack-freshness-sla.json"),
  ]);
  const candidateBuildSpec = JSON.parse(candidateBytes);
  return buildCurrentCapitalFacilitySourceAdmission({ observedAt: NOW.toISOString(), candidateEvaluationAt: candidateBuildSpec.publishedAt, planBytes, canonicalPackBytes, snapshotBytes, candidateBuildSpec, sourceInventoryBytes: inventoryBytes, sourceSnapshots: JSON.parse(snapshotsBytes), governancePolicy: JSON.parse(governanceBytes), governancePolicyBytes: governanceBytes, freshnessPolicy: JSON.parse(freshnessBytes) });
}

test("collect records failure after COLLECTION_STARTED and never resumes a provider call", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "facility-operation-"));
  const root = path.join(temporaryRoot, "operation");
  const repositoryRoot = await currentReleaseFixture(t);
  const sha = EXACT_MAIN;
  await prepareCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot: root, expectedMainSha: sha, execFileImpl: exactMainExec });
  let calls = 0;
  await assert.rejects(collectCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot: root, serviceKey: "test", execFileImpl: async (file, args) => file === "git" ? exactMainExec(file, args) : ({ stdout: args[0] === "sts" ? "123456789012\n" : "" }), collectImpl: async () => { calls += 1; throw new Error("network"); } }), /network/);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(await readFile(path.join(root, "journal.json"), "utf8")).phase, "COLLECTION_FAILED");
  await assert.rejects(collectCurrentCapitalFacilityOperation({ operationRoot: root, serviceKey: "test", collectImpl: async () => { calls += 1; } }), /PREPARED/);
  assert.equal(calls, 1);
});

test("collect journals a complete exact terminal observation as COLLECTED without replay", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "facility-operation-"));
  const operationRoot = path.join(temporaryRoot, "operation");
  const repositoryRoot = await currentReleaseFixture(t);
  await prepareCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot, expectedMainSha: EXACT_MAIN, execFileImpl: exactMainExec });
  const plan = JSON.parse(await readFile(path.join(operationRoot, "plan.json"), "utf8"));
  const result = await collectCurrentCapitalFacilityOperation({
    repositoryRoot, operationRoot, serviceKey: "test", env: OCI_ENV, execFileImpl: async (file, args) => file === "git" ? exactMainExec(file, args) : ({ stdout: args[0] === "sts" ? "123456789012\n" : "" }),
    collectImpl: async () => terminalObservationFor(plan),
  });
  assert.deepEqual(result, { snapshotId: nextSnapshot(plan).snapshotId, requestCount: 213, status: "COLLECTED" });
  assert.equal(JSON.parse(await readFile(path.join(operationRoot, "journal.json"), "utf8")).phase, "COLLECTED");
});

test("missing OCI PAR preflight stops before COLLECTION_STARTED and provider call 0", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "facility-operation-")); const root = path.join(temporaryRoot, "operation");
  const repositoryRoot = await currentReleaseFixture(t); const sha = EXACT_MAIN;
  await prepareCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot: root, expectedMainSha: sha, execFileImpl: exactMainExec });
  let calls = 0;
  await assert.rejects(collectCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot: root, serviceKey: "test", env: {}, execFileImpl: exactMainExec, collectImpl: async () => { calls += 1; } }), /EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL/);
  assert.equal(calls, 0); assert.equal(JSON.parse(await readFile(path.join(root, "journal.json"), "utf8")).phase, "PREPARED");
});

test("missing target admission binding stops collection before the provider call", async (t) => {
  const operationRoot = path.join(await mkdtemp(path.join(tmpdir(), "facility-operation-")), "operation");
  const repositoryRoot = await currentReleaseFixture(t);
  await prepareCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot, expectedMainSha: EXACT_MAIN, execFileImpl: exactMainExec });
  const journalPath = path.join(operationRoot, "journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  delete journal.priorAdmissionSha256;
  await writeJson(journalPath, journal);
  let calls = 0;
  await assert.rejects(collectCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot, serviceKey: "test", execFileImpl: exactMainExec, collectImpl: async () => { calls += 1; } }), /prepared prior admission SHA/);
  assert.equal(calls, 0);
});

test("stale prepared main stops before provider call", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "facility-operation-")); const operationRoot = path.join(temporaryRoot, "operation");
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const repositoryRoot = await currentReleaseFixture(t);
  await prepareCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot, expectedMainSha: EXACT_MAIN, execFileImpl: exactMainExec });
  const journalPath = path.join(operationRoot, "journal.json"); const journal = JSON.parse(await readFile(journalPath, "utf8")); journal.expectedMainSha = "0".repeat(40); await writeJson(journalPath, journal);
  let unexpectedCalls = 0; let kricCalls = 0;
  await assert.rejects(collectCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot, serviceKey: "test", execFileImpl: async (file, args) => {
    if (file === "git") return exactMainExec(file, args); unexpectedCalls += 1; return { stdout: "" };
  }, collectImpl: async () => { kricCalls += 1; } }), /exact clean main preflight/);
  journal.expectedMainSha = EXACT_MAIN; await writeJson(journalPath, journal); await writeFile(path.join(operationRoot, "plan.json"), "{}\n");
  await assert.rejects(collectCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot, serviceKey: "test", execFileImpl: async (file, args) => {
    if (file === "git") return exactMainExec(file, args); unexpectedCalls += 1; return { stdout: "" };
  }, collectImpl: async () => { kricCalls += 1; } }), /operation plan identity mismatch/);
  assert.equal(unexpectedCalls, 0); assert.equal(kricCalls, 0);
});

test("missing KRIC_SERVICE_KEY leaves PREPARED before any claim", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "facility-operation-")); const operationRoot = path.join(temporaryRoot, "operation"); t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const repositoryRoot = await currentReleaseFixture(t);
  await prepareCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot, expectedMainSha: EXACT_MAIN, execFileImpl: exactMainExec });
  await assert.rejects(collectCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot, execFileImpl: exactMainExec }), /KRIC_SERVICE_KEY/);
  assert.equal(JSON.parse(await readFile(path.join(operationRoot, "journal.json"), "utf8")).phase, "PREPARED");
});

test("expired or license-drift governance stops before provider call", async (t) => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "facility-preflight-repository-")); const operationRoot = await mkdtemp(path.join(tmpdir(), "facility-preflight-operation-"));
  t.after(() => Promise.all([rm(repositoryRoot, { recursive: true, force: true }), rm(operationRoot, { recursive: true, force: true })]));
  await rm(operationRoot, { recursive: true, force: true });
  for (const relative of FIXTURE_INPUTS) { const target = path.join(repositoryRoot, relative); await mkdir(path.dirname(target), { recursive: true }); await cp(path.join(REPOSITORY_ROOT, relative), target); }
  await bindReleaseRequestToCandidate(repositoryRoot);
  const inventory = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/source-inventory.json"), "utf8")); const snapshotRelative = inventory.sources.find(({ id }) => id === "kric-station-convenience-standard").accessibilityAdmissionEvidence.snapshotPath;
  await mkdir(path.dirname(path.join(repositoryRoot, snapshotRelative)), { recursive: true }); await cp(path.join(REPOSITORY_ROOT, snapshotRelative), path.join(repositoryRoot, snapshotRelative));
  await prepareCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot, expectedMainSha: EXACT_MAIN, execFileImpl: exactMainExec });
  const governancePath = path.join(repositoryRoot, "tools/datapack/source-governance-policy.json"); const governance = JSON.parse(await readFile(governancePath, "utf8")); const review = governance.sources.find(({ sourceId }) => sourceId === "kric-station-convenience-standard").licenseReview; review.nextReviewAt = "invalid"; review.termsHash = "0".repeat(64); await writeJson(governancePath, governance);
  let unexpectedCalls = 0; let kricCalls = 0;
  await assert.rejects(collectCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot, serviceKey: "test", now: NOW, execFileImpl: async (file, args) => file === "git" ? exactMainExec(file, args) : (unexpectedCalls += 1, { stdout: "" }), collectImpl: async () => { kricCalls += 1; } }), /nextReviewAt/);
  assert.equal(unexpectedCalls, 0); assert.equal(kricCalls, 0);
});

test("CLI parser keeps collect and finalize one-shot boundaries explicit", () => {
  assert.deepEqual(parseArgs(["--phase", "collect", "--operation-root", "/private/op"]), { phase: "collect", "operation-root": "/private/op" });
  assert.throws(() => parseArgs(["--phase", "prepare", "--operation-root", "/private/op"]), /expected main SHA/);
  assert.deepEqual(parseArgs(["--phase", "prepare", "--operation-root", "/private/op", "--expected-main-sha", "a"]), { phase: "prepare", "operation-root": "/private/op", "expected-main-sha": "a" });
  assert.deepEqual(parseArgs(["--phase", "recover-published", "--operation-root", "/private/target", "--source-operation-root", "/private/source"]), { phase: "recover-published", "operation-root": "/private/target", "source-operation-root": "/private/source" });
  assert.throws(() => parseArgs(["--phase", "prepare", "--operation-root", "/private/op", "--expected-main-sha", "a", "--expected-bucket-owner", "123456789012"]), /operation arguments/);
});

test("published observation recovery adopts exact bytes into a clean prepared root without replay", async (t) => {
  const { source, sourceReceipt, receiptBytes: sourceReceiptBytes, journal: sourceJournal, journalPath: sourceJournalPath } = await publishedRecoveryFixture(t);
  const repositoryRoot = await currentReleaseFixture(t);
  const sourcePlanPath = path.join(source.operationRoot, "plan.json");
  const sourcePlanBytes = await readFile(sourcePlanPath);
  const sourceSnapshotPath = path.join(source.operationRoot, "observation", `${source.snapshot.snapshotId}.json`);
  const sourceSnapshotBytes = await readFile(sourceSnapshotPath);

  const targetParent = await mkdtemp(path.join(tmpdir(), "facility-recovery-target-"));
  t.after(() => rm(targetParent, { recursive: true, force: true }));
  const targetRoot = path.join(targetParent, "operation");
  await prepareCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot: targetRoot, expectedMainSha: EXACT_MAIN, execFileImpl: exactMainExec, now: NOW });
  const result = await recoverPublishedCurrentCapitalFacilityOperation({
    repositoryRoot,
    operationRoot: targetRoot,
    sourceOperationRoot: source.operationRoot,
    execFileImpl: exactMainExec,
    now: NOW,
  });
  assert.deepEqual(result, { snapshotId: source.snapshot.snapshotId, status: "RECOVERED_PUBLISHED" });
  const targetJournal = JSON.parse(await readFile(path.join(targetRoot, "journal.json"), "utf8"));
  assert.equal(targetJournal.phase, "FINALIZE_STARTED");
  assert.deepEqual(targetJournal.completedStages, { published: sourceJournal.completedStages.published });
  assert.equal(targetJournal.collectionStartedAt, source.snapshot.capturedAt);
  assert.equal(targetJournal.finalizeObservedAt, NOW.toISOString());
  assert.deepEqual(await readFile(path.join(targetRoot, "receipt.json")), sourceReceiptBytes);
  for (const file of ["observation.json", `${source.snapshot.snapshotId}.json`, `${source.snapshot.snapshotId}.raw.json`]) {
    assert.deepEqual(await readFile(path.join(targetRoot, "observation", file)), await readFile(path.join(source.operationRoot, "observation", file)));
  }

  const unboundTarget = path.join(targetParent, "unbound-target");
  await prepareCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot: unboundTarget, expectedMainSha: EXACT_MAIN, execFileImpl: exactMainExec, now: NOW });
  const unboundJournalPath = path.join(unboundTarget, "journal.json");
  const unboundJournal = JSON.parse(await readFile(unboundJournalPath, "utf8"));
  delete unboundJournal.priorAdmissionSha256;
  await writeJson(unboundJournalPath, unboundJournal);
  let durableCopies = 0;
  await assert.rejects(recoverPublishedCurrentCapitalFacilityOperation({
    repositoryRoot, operationRoot: unboundTarget, sourceOperationRoot: source.operationRoot, execFileImpl: exactMainExec, now: NOW,
    durableCreateImpl: async () => { durableCopies += 1; },
  }), /prepared prior admission SHA/);
  assert.equal(durableCopies, 0);

  async function preparedRoot(name) {
    const root = path.join(targetParent, name);
    await prepareCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot: root, expectedMainSha: EXACT_MAIN, execFileImpl: exactMainExec, now: NOW });
    return root;
  }
  async function assertPreparedWithoutRecovery(root) {
    const journal = JSON.parse(await readFile(path.join(root, "journal.json"), "utf8"));
    assert.equal(journal.phase, "PREPARED");
    assert.deepEqual(journal.completedStages, {});
    await assert.rejects(readFile(path.join(root, "receipt.json")), /ENOENT/u);
    await assert.rejects(readFile(path.join(root, "observation", "observation.json")), /ENOENT/u);
  }

  const rejectedRoot = await preparedRoot("rejected-receipt");
  await writeJson(path.join(source.operationRoot, "receipt.json"), { ...sourceReceipt, snapshotId: "wrong" });
  await assert.rejects(recoverPublishedCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot: rejectedRoot, sourceOperationRoot: source.operationRoot, execFileImpl: exactMainExec, now: NOW }), /published recovery receipt identity mismatch/u);
  await assertPreparedWithoutRecovery(rejectedRoot);
  await writeFile(path.join(source.operationRoot, "receipt.json"), sourceReceiptBytes);

  const wrongPhaseRoot = await preparedRoot("rejected-phase");
  await writeJson(sourceJournalPath, { ...sourceJournal, phase: "FINALIZED" });
  await assert.rejects(recoverPublishedCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot: wrongPhaseRoot, sourceOperationRoot: source.operationRoot, execFileImpl: exactMainExec, now: NOW }), /source must be FINALIZE_STARTED/u);
  await assertPreparedWithoutRecovery(wrongPhaseRoot);
  await writeJson(sourceJournalPath, sourceJournal);

  const planDriftRoot = await preparedRoot("rejected-plan");
  await writeFile(sourcePlanPath, Buffer.concat([sourcePlanBytes, Buffer.from("\n")]));
  await assert.rejects(recoverPublishedCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot: planDriftRoot, sourceOperationRoot: source.operationRoot, execFileImpl: exactMainExec, now: NOW }), /operation plan identity mismatch/u);
  await assertPreparedWithoutRecovery(planDriftRoot);
  await writeFile(sourcePlanPath, sourcePlanBytes);

  const observationDriftRoot = await preparedRoot("rejected-observation");
  await writeFile(sourceSnapshotPath, Buffer.concat([sourceSnapshotBytes, Buffer.from("\n")]));
  await assert.rejects(recoverPublishedCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot: observationDriftRoot, sourceOperationRoot: source.operationRoot, execFileImpl: exactMainExec, now: NOW }), /stored observation identity mismatch/u);
  await assertPreparedWithoutRecovery(observationDriftRoot);
  await writeFile(sourceSnapshotPath, sourceSnapshotBytes);

  const nonAncestorRoot = await preparedRoot("rejected-ancestor");
  const nonAncestorExec = (file, args) => {
    if (file === "git" && args[0] === "merge-base") throw new Error("not an ancestor");
    return exactMainExec(file, args);
  };
  await assert.rejects(recoverPublishedCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot: nonAncestorRoot, sourceOperationRoot: source.operationRoot, execFileImpl: nonAncestorExec, now: NOW }), /source main is not an ancestor/u);
  await assertPreparedWithoutRecovery(nonAncestorRoot);

  await assert.rejects(recoverPublishedCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot: targetRoot, sourceOperationRoot: source.operationRoot, execFileImpl: exactMainExec, now: NOW }), /target must be PREPARED/u);
  await assert.rejects(recoverPublishedCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot: source.operationRoot, sourceOperationRoot: source.operationRoot, execFileImpl: exactMainExec, now: NOW }), /roots must differ/u);
});

test("published recovery runs current release preflight and rejects an expired observation before target mutation", async (t) => {
  const { source } = await publishedRecoveryFixture(t);
  const repositoryRoot = await currentReleaseFixture(t);
  const targetParent = await mkdtemp(path.join(tmpdir(), "facility-recovery-preflight-"));
  t.after(() => rm(targetParent, { recursive: true, force: true }));
  const prepareTarget = async (name) => {
    const target = path.join(targetParent, name);
    await prepareCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot: target, expectedMainSha: EXACT_MAIN, execFileImpl: exactMainExec, now: NOW });
    return target;
  };
  const assertUnchanged = async (target) => {
    assert.equal(JSON.parse(await readFile(path.join(target, "journal.json"), "utf8")).phase, "PREPARED");
    await assert.rejects(readFile(path.join(target, "receipt.json")), /ENOENT/u);
    await assert.rejects(readFile(path.join(target, "observation", "observation.json")), /ENOENT/u);
  };

  const invalidRelease = await prepareTarget("invalid-release");
  const invalidReleaseCalls = { preflight: 0, copy: 0, journal: 0 };
  await assert.rejects(recoverPublishedCurrentCapitalFacilityOperation({
    repositoryRoot,
    operationRoot: invalidRelease,
    sourceOperationRoot: source.operationRoot,
    execFileImpl: exactMainExec,
    now: NOW,
    releasePreflightImpl: async () => { invalidReleaseCalls.preflight += 1; throw new Error("candidate source ledger/freshness binding mismatch"); },
    durableCreateImpl: async () => { invalidReleaseCalls.copy += 1; },
    journalWriteImpl: async () => { invalidReleaseCalls.journal += 1; },
  }), /candidate source ledger\/freshness binding mismatch/u);
  assert.deepEqual(invalidReleaseCalls, { preflight: 1, copy: 0, journal: 0 });
  await assertUnchanged(invalidRelease);

  const expiredObservation = await prepareTarget("expired-observation");
  await assert.rejects(recoverPublishedCurrentCapitalFacilityOperation({
    repositoryRoot,
    operationRoot: expiredObservation,
    sourceOperationRoot: source.operationRoot,
    execFileImpl: exactMainExec,
    now: new Date(source.snapshot.freshUntil),
  }), /published recovery observation is stale/u);
  await assertUnchanged(expiredObservation);
});

test("published recovery serializes collection and resumes its own staged durable create", async (t) => {
  const { source } = await publishedRecoveryFixture(t);
  const repositoryRoot = await currentReleaseFixture(t);
  const targetParent = await mkdtemp(path.join(tmpdir(), "facility-recovery-claim-"));
  t.after(() => rm(targetParent, { recursive: true, force: true }));

  const claimedTarget = path.join(targetParent, "claimed");
  await prepareCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot: claimedTarget, expectedMainSha: EXACT_MAIN, execFileImpl: exactMainExec, now: NOW });
  await mkdir(path.join(claimedTarget, ".collection-claim"), { mode: 0o700 });
  const blockedCalls = { copy: 0, journal: 0 };
  await assert.rejects(recoverPublishedCurrentCapitalFacilityOperation({
    repositoryRoot,
    operationRoot: claimedTarget,
    sourceOperationRoot: source.operationRoot,
    execFileImpl: exactMainExec,
    now: NOW,
    durableCreateImpl: async () => { blockedCalls.copy += 1; },
    journalWriteImpl: async () => { blockedCalls.journal += 1; },
  }), /collection is already in progress/u);
  assert.deepEqual(blockedCalls, { copy: 0, journal: 0 });
  assert.equal(JSON.parse(await readFile(path.join(claimedTarget, "journal.json"), "utf8")).phase, "PREPARED");
  await assert.rejects(readFile(path.join(claimedTarget, "receipt.json")), /ENOENT/u);

  const resumedTarget = path.join(targetParent, "staged-resume");
  await prepareCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot: resumedTarget, expectedMainSha: EXACT_MAIN, execFileImpl: exactMainExec, now: NOW });
  const stagingRoot = path.join(resumedTarget, ".published-recovery-create");
  let interrupted = false;
  await assert.rejects(recoverPublishedCurrentCapitalFacilityOperation({
    repositoryRoot,
    operationRoot: resumedTarget,
    sourceOperationRoot: source.operationRoot,
    execFileImpl: exactMainExec,
    now: NOW,
    durableCreateImpl: async (target, bytes, options) => {
      assert.equal(options?.stagingRoot, stagingRoot);
      await durableCreateBytes(target, bytes, {
        ...options,
        unlinkImpl: async (candidate) => {
          if (!interrupted && path.dirname(candidate) === stagingRoot) {
            interrupted = true;
            throw new Error("injected staged unlink interruption");
          }
          await unlink(candidate);
        },
      });
    },
  }), /injected staged unlink interruption/u);
  assert.equal(JSON.parse(await readFile(path.join(resumedTarget, "journal.json"), "utf8")).phase, "PREPARED");
  assert.equal((await readdir(stagingRoot)).length, 1);
  assert.equal((await recoverPublishedCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot: resumedTarget, sourceOperationRoot: source.operationRoot, execFileImpl: exactMainExec, now: NOW })).status, "RECOVERED_PUBLISHED");
  await assert.rejects(readdir(stagingRoot), /ENOENT/u);
});

test("published recovery rejects escaped observation inventory and a resealed noncanonical plan before target mutation", async (t) => {
  const escaped = await publishedRecoveryFixture(t);
  const escapedRepositoryRoot = await currentReleaseFixture(t);
  const escapedParent = await mkdtemp(path.join(tmpdir(), "facility-recovery-escaped-"));
  t.after(() => rm(escapedParent, { recursive: true, force: true }));
  const escapedTarget = path.join(escapedParent, "operation");
  await prepareCurrentCapitalFacilityOperation({ repositoryRoot: escapedRepositoryRoot, operationRoot: escapedTarget, expectedMainSha: EXACT_MAIN, execFileImpl: exactMainExec, now: NOW });
  const manifestPath = path.join(escaped.source.operationRoot, "observation", "observation.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const escapedFile = `../${escaped.source.snapshot.snapshotId}.json`;
  manifest.snapshotFile = escapedFile;
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(escaped.source.operationRoot, `${escaped.source.snapshot.snapshotId}.json`), escaped.source.snapshotBytes);
  await writeFile(manifestPath, manifestBytes);
  escaped.journal.completedObservation.manifestSha256 = sha(manifestBytes);
  await writeJson(escaped.journalPath, escaped.journal);
  await assert.rejects(recoverPublishedCurrentCapitalFacilityOperation({ repositoryRoot: escapedRepositoryRoot, operationRoot: escapedTarget, sourceOperationRoot: escaped.source.operationRoot, execFileImpl: exactMainExec, now: NOW }), /observation inventory/u);
  assert.equal(JSON.parse(await readFile(path.join(escapedTarget, "journal.json"), "utf8")).phase, "PREPARED");
  await assert.rejects(readFile(path.join(escapedTarget, escaped.source.snapshot.snapshotId)), /ENOENT/u);

  const resealed = await publishedRecoveryFixture(t);
  const resealedRepositoryRoot = await currentReleaseFixture(t);
  const resealedTarget = path.join(escapedParent, "resealed");
  await prepareCurrentCapitalFacilityOperation({ repositoryRoot: resealedRepositoryRoot, operationRoot: resealedTarget, expectedMainSha: EXACT_MAIN, execFileImpl: exactMainExec, now: NOW });
  const driftBytes = Buffer.from("{}\n");
  for (const [root, journalPath] of [[resealed.source.operationRoot, resealed.journalPath], [resealedTarget, path.join(resealedTarget, "journal.json")]]) {
    await writeFile(path.join(root, "plan.json"), driftBytes);
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    journal.planSha256 = sha(driftBytes);
    await writeJson(journalPath, journal);
  }
  await assert.rejects(recoverPublishedCurrentCapitalFacilityOperation({ repositoryRoot: resealedRepositoryRoot, operationRoot: resealedTarget, sourceOperationRoot: resealed.source.operationRoot, execFileImpl: exactMainExec, now: NOW }), /canonical plan identity mismatch/u);
  assert.equal(JSON.parse(await readFile(path.join(resealedTarget, "journal.json"), "utf8")).phase, "PREPARED");
  await assert.rejects(readFile(path.join(resealedTarget, "receipt.json")), /ENOENT/u);
});

test("published recovery reconciles every exact partial copy and a failed journal transition without replay", async (t) => {
  const { source } = await publishedRecoveryFixture(t);
  const repositoryRoot = await currentReleaseFixture(t);
  const targetParent = await mkdtemp(path.join(tmpdir(), "facility-recovery-resume-"));
  t.after(() => rm(targetParent, { recursive: true, force: true }));
  for (let failAt = 1; failAt <= 4; failAt += 1) {
    const target = path.join(targetParent, `copy-${failAt}`);
    await prepareCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot: target, expectedMainSha: EXACT_MAIN, execFileImpl: exactMainExec, now: NOW });
    let calls = 0;
    await assert.rejects(recoverPublishedCurrentCapitalFacilityOperation({
      repositoryRoot, operationRoot: target, sourceOperationRoot: source.operationRoot, execFileImpl: exactMainExec, now: NOW,
      durableCreateImpl: async (target, bytes, options) => { calls += 1; if (calls === failAt) throw new Error("injected recovery copy failure"); await durableCreateBytes(target, bytes, options); },
    }), /injected recovery copy failure/u);
    assert.equal(JSON.parse(await readFile(path.join(target, "journal.json"), "utf8")).phase, "PREPARED");
    assert.equal((await recoverPublishedCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot: target, sourceOperationRoot: source.operationRoot, execFileImpl: exactMainExec, now: NOW })).status, "RECOVERED_PUBLISHED");
  }

  const journalTarget = path.join(targetParent, "journal");
  await prepareCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot: journalTarget, expectedMainSha: EXACT_MAIN, execFileImpl: exactMainExec, now: NOW });
  await assert.rejects(recoverPublishedCurrentCapitalFacilityOperation({
    repositoryRoot, operationRoot: journalTarget, sourceOperationRoot: source.operationRoot, execFileImpl: exactMainExec, now: NOW,
    journalWriteImpl: async () => { throw new Error("injected recovery journal failure"); },
  }), /injected recovery journal failure/u);
  assert.equal(JSON.parse(await readFile(path.join(journalTarget, "journal.json"), "utf8")).phase, "PREPARED");
  assert.equal((await recoverPublishedCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot: journalTarget, sourceOperationRoot: source.operationRoot, execFileImpl: exactMainExec, now: NOW })).status, "RECOVERED_PUBLISHED");
});

test("journal replace failure preserves the prior durable journal", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "facility-journal-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const journalPath = path.join(directory, "journal.json"); await writeFile(journalPath, '{"phase":"PREPARED"}\n');
  await assert.rejects(syncWrite(journalPath, { phase: "COLLECTION_STARTED" }, { renameImpl: async () => { throw new Error("rename failed"); } }), /rename failed/);
  assert.equal(await readFile(journalPath, "utf8"), '{"phase":"PREPARED"}\n');
});

test("finalize crash-resume reconciles exact effects without replay and admits the rebound candidate", async (t) => {
  const cases = [
    { stage: "published", expected: { register: 1, rebind: 1 } },
    { stage: "partial", expected: { register: 1, rebind: 1 } },
    { stage: "registered", expected: { register: 0, rebind: 1 } },
    { stage: "rebound", expected: { register: 0, rebind: 0 } },
    { stage: "admitted", expected: { register: 0, rebind: 0 } },
  ];
  for (const { stage, expected } of cases) {
    const fixture = await finalizeFixture(t); const receiptPath = path.join(fixture.operationRoot, "receipt.json");
    const targetSnapshot = path.join(fixture.root, "tools/datapack/sources", `${fixture.snapshot.snapshotId}.json`);
    await writeJson(receiptPath, receipt(fixture));
    if (stage !== "published") { await mkdir(path.dirname(targetSnapshot), { recursive: true }); await writeFile(targetSnapshot, stage === "partial" ? "partial" : fixture.snapshotBytes); }
    if (["rebound", "admitted"].includes(stage)) {
      await rebindCurrentCandidateSourceSnapshots({ repositoryRoot: fixture.root, now: NOW });
      const journalPath = path.join(fixture.operationRoot, "journal.json"); const journal = JSON.parse(await readFile(journalPath, "utf8"));
      journal.reboundExpectedCandidateSha256 = sha(await readFile(path.join(fixture.root, "tools/datapack/release/candidate-build-spec.json")));
      await writeJson(journalPath, journal);
    }
    if (stage === "admitted") {
      const admission = await admissionFor(fixture); await writeFile(path.join(fixture.root, "tools/datapack/release/current-capital-facility-source-admission.json"), canonicalCurrentCapitalFacilitySourceAdmissionJson(admission));
      const journalPath = path.join(fixture.operationRoot, "journal.json"); const journal = JSON.parse(await readFile(journalPath, "utf8")); journal.finalizeObservedAt = NOW.toISOString(); await writeJson(journalPath, journal);
    }
    const calls = { publish: 0, register: 0, rebind: 0 };
    const admissionInputs = [];
    await main(["--phase", "finalize", "--operation-root", fixture.operationRoot], {
      repositoryRoot: fixture.root, now: NOW, env: {}, execFileImpl: exactMainExec,
      publishImpl: async () => { calls.publish += 1; throw new Error("published receipt must reconcile before replay"); },
      registerImpl: async ({ snapshotTargetPath }) => { calls.register += 1; await mkdir(path.dirname(snapshotTargetPath), { recursive: true }); await writeFile(snapshotTargetPath, fixture.snapshotBytes); },
      rebindImpl: async ({ repositoryRoot, now }) => { calls.rebind += 1; return rebindCurrentCandidateSourceSnapshots({ repositoryRoot, now }); },
      buildAdmissionImpl: (input) => { admissionInputs.push(input); return buildCurrentCapitalFacilitySourceAdmission(input); },
    });
    assert.deepEqual(calls, { publish: 0, ...expected });
    const admission = JSON.parse(await readFile(path.join(fixture.root, "tools/datapack/release/current-capital-facility-source-admission.json"), "utf8"));
    assert.equal(admission.sourceIdentity.snapshotId, fixture.snapshot.snapshotId, stage);
    assert.equal(admission.candidate.sourceSnapshotSetHash, JSON.parse(await readFile(path.join(fixture.root, "tools/datapack/release/candidate-build-spec.json"), "utf8")).sourceSnapshotSetHash, stage);
    assert.equal(admissionInputs.length, 1, stage);
    assert.equal(admissionInputs[0].candidateEvaluationAt, admissionInputs[0].candidateBuildSpec.publishedAt, stage);
    assert.equal(JSON.parse(await readFile(path.join(fixture.operationRoot, "journal.json"), "utf8")).phase, "FINALIZED", stage);
  }
});

test("finalize atomically replaces the prepared stale admission without provider replay", async (t) => {
  const fixture = await finalizeFixture(t, { prepared: true });
  const target = path.join(fixture.root, "tools/datapack/release/current-capital-facility-source-admission.json");
  const staleAdmissionBytes = await readFile(target);
  const journalPath = path.join(fixture.operationRoot, "journal.json");
  const preparedJournal = JSON.parse(await readFile(journalPath, "utf8"));
  assert.equal(preparedJournal.priorAdmissionSha256, sha(staleAdmissionBytes));

  await writeJson(path.join(fixture.operationRoot, "receipt.json"), receipt(fixture));
  const targetSnapshot = path.join(fixture.root, "tools/datapack/sources", `${fixture.snapshot.snapshotId}.json`);
  await mkdir(path.dirname(targetSnapshot), { recursive: true });
  await writeFile(targetSnapshot, fixture.snapshotBytes);
  await rebindCurrentCandidateSourceSnapshots({ repositoryRoot: fixture.root, now: NOW });
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.reboundExpectedCandidateSha256 = sha(await readFile(path.join(fixture.root, "tools/datapack/release/candidate-build-spec.json")));
  await writeJson(journalPath, journal);

  const calls = { publish: 0, register: 0, rebind: 0 };
  const dependencies = {
    repositoryRoot: fixture.root, now: NOW, env: {}, execFileImpl: exactMainExec,
    publishImpl: async () => { calls.publish += 1; },
    registerImpl: async () => { calls.register += 1; },
    rebindImpl: async () => { calls.rebind += 1; },
  };
  delete journal.priorAdmissionSha256;
  await writeJson(journalPath, journal);
  await assert.rejects(main(["--phase", "finalize", "--operation-root", fixture.operationRoot], dependencies), /prepared prior admission SHA/);
  assert.deepEqual(calls, { publish: 0, register: 0, rebind: 0 });
  journal.priorAdmissionSha256 = sha(staleAdmissionBytes);
  await writeJson(journalPath, journal);

  const sharedLock = path.join(fixture.root, "tools/datapack/.active-facility-derived-identity-rebind.lock");
  await mkdir(sharedLock, { mode: 0o700 });
  await assert.rejects(main(["--phase", "finalize", "--operation-root", fixture.operationRoot], dependencies), /admission replacement is already in progress/);
  assert.deepEqual(await readFile(target), staleAdmissionBytes);
  await rm(sharedLock, { recursive: true, force: true });

  await writeFile(target, "{}\n");
  await assert.rejects(
    main(["--phase", "finalize", "--operation-root", fixture.operationRoot], dependencies),
    /current capital facility admission replacement verification failed/,
  );
  assert.equal(await readFile(target, "utf8"), "{}\n");
  assert.deepEqual(calls, { publish: 0, register: 0, rebind: 0 });

  await writeFile(target, staleAdmissionBytes);
  await main(["--phase", "finalize", "--operation-root", fixture.operationRoot], dependencies);
  assert.deepEqual(calls, { publish: 0, register: 0, rebind: 0 });
  assert.notEqual(await readFile(target, "utf8"), staleAdmissionBytes.toString("utf8"));
});

test("finalize fails closed for an existing partial receipt before publishing again", async (t) => {
  const fixture = await finalizeFixture(t); let published = 0;
  await writeJson(path.join(fixture.operationRoot, "receipt.json"), { ...receipt(fixture), snapshotId: "wrong-snapshot" });
  await assert.rejects(main(["--phase", "finalize", "--operation-root", fixture.operationRoot], {
    repositoryRoot: fixture.root, now: NOW, execFileImpl: exactMainExec, publishImpl: async () => { published += 1; },
  }), /published receipt identity mismatch/);
  assert.equal(published, 0);
});

test("finalize rejects a legacy journal before recovery effects", async (t) => {
  const fixture = await finalizeFixture(t); const journalPath = path.join(fixture.operationRoot, "journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")); journal.expectedBucketOwner = "123456789012"; await writeJson(journalPath, journal);
  let published = 0;
  await assert.rejects(main(["--phase", "finalize", "--operation-root", fixture.operationRoot], {
    repositoryRoot: fixture.root, now: NOW, execFileImpl: exactMainExec, publishImpl: async () => { published += 1; },
  }), /operation journal has unsupported keys/);
  assert.equal(published, 0);
});

test("finalize rejects a legacy receipt URI before recovery effects", async (t) => {
  const fixture = await finalizeFixture(t); await writeJson(path.join(fixture.operationRoot, "receipt.json"), {
    ...receipt(fixture), rawObjectUri: `s3://easysubway-datapacks/source-raw/${fixture.snapshot.sourceId}/20260817/${sha(fixture.rawBytes)}.json`,
  });
  let published = 0;
  await assert.rejects(main(["--phase", "finalize", "--operation-root", fixture.operationRoot], {
    repositoryRoot: fixture.root, now: NOW, execFileImpl: exactMainExec, publishImpl: async () => { published += 1; },
  }), /published receipt identity mismatch/);
  assert.equal(published, 0);
});

test("finalize rejects a replaced completed observation before publication", async (t) => {
  const fixture = await finalizeFixture(t); const observed = path.join(fixture.operationRoot, "observation", `${fixture.snapshot.snapshotId}.json`);
  await writeFile(observed, `${await readFile(observed, "utf8")}\n`); let published = 0;
  await assert.rejects(main(["--phase", "finalize", "--operation-root", fixture.operationRoot], { repositoryRoot: fixture.root, now: NOW, execFileImpl: exactMainExec, publishImpl: async () => { published += 1; } }), /stored observation identity mismatch/);
  assert.equal(published, 0);
});

test("inconsistent external receipt fails before registration reconciliation", async (t) => {
  const fixture = await finalizeFixture(t); const target = path.join(fixture.root, "tools/datapack/sources", `${fixture.snapshot.snapshotId}.json`);
  await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, fixture.snapshotBytes); await writeJson(path.join(fixture.operationRoot, "receipt.json"), { ...receipt(fixture), rawObjectSha256: "0".repeat(64) });
  let registrations = 0;
  await assert.rejects(main(["--phase", "finalize", "--operation-root", fixture.operationRoot], { repositoryRoot: fixture.root, now: NOW, execFileImpl: exactMainExec, registerImpl: async () => { registrations += 1; } }), /published receipt identity mismatch/);
  assert.equal(registrations, 0);
});

test("stored complete observation reconciles COLLECTION_STARTED without KRIC replay", async (t) => {
  const fixture = await finalizeFixture(t); const observationRoot = path.join(fixture.operationRoot, "observation");
  await rm(observationRoot, { recursive: true, force: true }); await writeKricStandardAccessibilityObservation({ outputRoot: observationRoot, observation: observationFor(fixture.snapshot) });
  const journalPath = path.join(fixture.operationRoot, "journal.json"); const journal = JSON.parse(await readFile(journalPath, "utf8")); journal.phase = "COLLECTION_STARTED"; await writeJson(journalPath, journal);
  let kricCalls = 0;
  const observation = await collectCurrentCapitalFacilityOperation({ repositoryRoot: fixture.root, operationRoot: fixture.operationRoot, collectImpl: async () => { kricCalls += 1; }, execFileImpl: exactMainExec, now: NOW });
  assert.equal(kricCalls, 0); assert.deepEqual(observation, { snapshotId: fixture.snapshot.snapshotId, requestCount: 213, status: "COLLECTED" });
  assert.equal(JSON.parse(await readFile(journalPath, "utf8")).phase, "COLLECTED");
});

test("finalize COLLECTION_STARTED reconciliation persists completed observation binding", async (t) => {
  const fixture = await finalizeFixture(t); const journalPath = path.join(fixture.operationRoot, "journal.json"); const journal = JSON.parse(await readFile(journalPath, "utf8")); delete journal.completedObservation; journal.phase = "COLLECTION_STARTED"; await writeJson(journalPath, journal);
  await assert.rejects(main(["--phase", "finalize", "--operation-root", fixture.operationRoot], { repositoryRoot: fixture.root, now: NOW, execFileImpl: exactMainExec }), /prepared input identity mismatch/);
  const reconciled = JSON.parse(await readFile(journalPath, "utf8")); assert.equal(reconciled.phase, "COLLECTED"); assert.equal(reconciled.completedObservation.snapshotId, fixture.snapshot.snapshotId);
});

test("complete observation survives COLLECTED journal write failure as recoverable COLLECTION_STARTED", async (t) => {
  const fixture = await finalizeFixture(t); const journalPath = path.join(fixture.operationRoot, "journal.json"); const journal = JSON.parse(await readFile(journalPath, "utf8")); journal.phase = "COLLECTION_STARTED"; await writeJson(journalPath, journal);
  await assert.rejects(collectCurrentCapitalFacilityOperation({ repositoryRoot: fixture.root, operationRoot: fixture.operationRoot, now: NOW, execFileImpl: exactMainExec, journalWriteImpl: async () => { throw new Error("journal write failed"); } }), /journal write failed/);
  assert.equal(JSON.parse(await readFile(journalPath, "utf8")).phase, "COLLECTION_STARTED");
});
