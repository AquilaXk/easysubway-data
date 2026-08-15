import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { buildCurrentCapitalFacilityCollectionPlan, canonicalCurrentCapitalFacilityCollectionPlanJson } from "./build-current-capital-facility-collection-plan.mjs";
import { buildCurrentCapitalFacilitySourceAdmission, canonicalCurrentCapitalFacilitySourceAdmissionJson } from "./build-current-capital-facility-source-admission.mjs";
import { KRIC_ACCESSIBILITY_OPERATIONS, writeKricStandardAccessibilityObservation } from "./collect-kric-accessibility-snapshots.mjs";
import { rebindCurrentCandidateSourceSnapshots } from "./rebind-current-candidate-source-snapshots.mjs";
import { buildSnapshotDiff } from "./source-snapshot-policy.mjs";
import { collectCurrentCapitalFacilityOperation, main, parseArgs, prepareCurrentCapitalFacilityOperation, syncWrite } from "./run-current-capital-facility-operation.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const NOW = new Date("2026-08-15T12:00:00.000Z");
const EXACT_MAIN = "e8c391ffd051fa2ccd7a275a7865aa65b94f6523";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const jsonSha = (value) => sha(Buffer.from(JSON.stringify(value)));
const FIXTURE_INPUTS = [
  "tools/datapack/release/candidate-build-spec.json", "tools/datapack/release/release-request.json",
  "tools/datapack/release/source-snapshots.json", "tools/datapack/release/capital-production-canonical-pack.json",
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

function nextSnapshot(plan) {
  const operation = KRIC_ACCESSIBILITY_OPERATIONS.find(({ sourceId }) => sourceId === "kric-station-convenience-standard");
  const capturedAt = "2026-08-15T11:00:00.000Z";
  const queries = plan.stationLineProviderMappings.map((mapping) => ({
    stationId: mapping.stationId, lineId: mapping.lineId, railOprIsttCd: mapping.providerOperatorId,
    lnCd: mapping.providerLineId, stinCd: mapping.providerStationId, rows: [], rawResponseSha256: sha(Buffer.from(JSON.stringify({ header: { resultCode: "00" }, body: [] }))),
    providerRecordHash: jsonSha([]), status: "ABSENT_EXPLICIT_ZERO",
    canonicalMappings: [{ artifactId: "bundled-capital", stationId: mapping.stationId, lineId: mapping.lineId }],
  }));
  return {
    schemaVersion: 1, artifactKind: "kric-accessibility-snapshot", sourceId: operation.sourceId,
    snapshotId: "kric-station-convenience-standard-20260815T110000000Z", capturedAt, observedAt: capturedAt,
    freshUntil: "2026-08-16T11:00:00.000Z", providerResultCode: "00", schemaStatus: "PASS",
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

async function writeJson(target, value) { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, `${JSON.stringify(value, null, 2)}\n`); }

async function finalizeFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "facility-finalize-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const operationRoot = await mkdtemp(path.join(tmpdir(), "facility-finalize-operation-"));
  t.after(() => rm(operationRoot, { recursive: true, force: true }));
  for (const relative of FIXTURE_INPUTS) { const target = path.join(root, relative); await mkdir(path.dirname(target), { recursive: true }); await cp(path.join(REPOSITORY_ROOT, relative), target); }
  const load = (relative) => readFile(path.join(root, relative));
  const [canonicalPackBytes, coverageTargetsBytes, providerCodeCatalogBytes, routeRostersBytes, sourceInventoryBytes] = await Promise.all([
    load("tools/datapack/release/capital-production-canonical-pack.json"), load("tools/datapack/nationwide-coverage-targets.json"),
    load("tools/datapack/sources/kric-provider-code-catalog-20260228.json"), load("tools/datapack/sources/kric-nationwide-route-rosters-20260730T203926676Z.json"), load("tools/datapack/source-inventory.json"),
  ]);
  const plan = buildCurrentCapitalFacilityCollectionPlan({ canonicalPackBytes, coverageTargetsBytes, providerCodeCatalogBytes, routeRostersBytes, sourceInventoryBytes });
  const snapshot = nextSnapshot(plan); const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
  const snapshotsPath = path.join(root, "tools/datapack/release/source-snapshots.json"); const inventoryPath = path.join(root, "tools/datapack/source-inventory.json");
  const snapshots = JSON.parse(await readFile(snapshotsPath, "utf8")); const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  const previous = snapshots.find(({ snapshotId }) => snapshotId === "kric-station-convenience-standard-20260813T200604805Z"); assert.ok(previous);
  const next = { ...structuredClone(previous), snapshotId: snapshot.snapshotId, previousSnapshotId: previous.snapshotId, retrievedAt: snapshot.capturedAt, sourceUpdatedAt: snapshot.capturedAt, rowCount: 0, coverageCount: 213, rawSha256: "a".repeat(64), rawObjectUri: `s3://easysubway-datapack-sources/kric-station-convenience-standard/20260815/${"a".repeat(64)}.json`, redactedRequestFingerprint: snapshot.redactedRequestFingerprint, schemaFingerprint: snapshot.schemaFingerprint, contentSha256: snapshot.contentSha256, freshnessExpiresAt: "2026-11-13T11:00:00.000Z", rawRetentionExpiresAt: "2026-11-13T11:00:00.000Z" };
  next.rawReceipt = { ...next.rawReceipt, snapshotId: next.snapshotId, snapshotRawSha256: snapshot.rawSha256, rawObjectSha256: next.rawSha256, capturedAt: snapshot.capturedAt, storedAt: "2026-08-15T11:00:30.000Z", byteSize: 213, snapshotFileSha256: sha(snapshotBytes) };
  next.diffSummary = buildSnapshotDiff(previous, next); snapshots.push(next);
  const source = inventory.sources.find(({ id }) => id === next.sourceId); next.adminReviewRecordHash = source.admissionEvidence.adminReviewRecordHash; source.retrievedAt = "2026-08-15"; source.observedDataUpdatedAt = "2026-08-15";
  source.accessibilityAdmissionEvidence = { ...source.accessibilityAdmissionEvidence, snapshotId: next.snapshotId, capturedAt: snapshot.capturedAt, observedAt: snapshot.capturedAt, freshUntil: snapshot.freshUntil, rawSha256: snapshot.rawSha256, contentSha256: snapshot.contentSha256, schemaFingerprint: snapshot.schemaFingerprint, snapshotPath: `tools/datapack/sources/${next.snapshotId}.json`, snapshotFileSha256: sha(snapshotBytes), absenceEvidenceMode: "EXHAUSTIVE_LIST", licenseEvidenceHash: source.admissionEvidence.licenseEvidenceHash };
  await writeJson(snapshotsPath, snapshots); await writeJson(inventoryPath, inventory);
  const observationRoot = path.join(operationRoot, "observation");
  const planBytes = Buffer.from(canonicalCurrentCapitalFacilityCollectionPlanJson(plan));
  await mkdir(operationRoot, { recursive: true }); await writeFile(path.join(operationRoot, "plan.json"), planBytes);
  await writeKricStandardAccessibilityObservation({ outputRoot: observationRoot, observation: observationFor(snapshot) });
  const [manifestBytes, observedSnapshotBytes, rawBytes] = await Promise.all([readFile(path.join(observationRoot, "observation.json"), "utf8"), readFile(path.join(observationRoot, `${snapshot.snapshotId}.json`)), readFile(path.join(observationRoot, `${snapshot.snapshotId}.raw.json`))]);
  await writeJson(path.join(operationRoot, "journal.json"), { schemaVersion: 1, artifactKind: "current-capital-facility-operation-journal", phase: "FINALIZE_STARTED", expectedMainSha: EXACT_MAIN, expectedBucketOwner: "123456789012", planSha256: sha(planBytes), completedObservation: { snapshotId: snapshot.snapshotId, manifestSha256: sha(Buffer.from(manifestBytes)), snapshotSha256: sha(observedSnapshotBytes), rawSha256: sha(rawBytes) }, completedStages: {} });
  return { root, operationRoot, snapshot, snapshotBytes, plan, ledger: next };
}

function receipt(fixture) { return { ...fixture.ledger.rawReceipt, expectedBucketOwner: "123456789012" }; }

async function admissionFor({ root, operationRoot, snapshot }) {
  const read = (relative) => readFile(path.join(root, relative));
  const [planBytes, canonicalPackBytes, snapshotBytes, candidateBytes, inventoryBytes, snapshotsBytes, governanceBytes, freshnessBytes] = await Promise.all([
    read(path.relative(root, path.join(operationRoot, "plan.json"))), read("tools/datapack/release/capital-production-canonical-pack.json"), read(`tools/datapack/sources/${snapshot.snapshotId}.json`), read("tools/datapack/release/candidate-build-spec.json"), read("tools/datapack/source-inventory.json"), read("tools/datapack/release/source-snapshots.json"), read("tools/datapack/source-governance-policy.json"), read("release/product-gates/datapack-freshness-sla.json"),
  ]);
  return buildCurrentCapitalFacilitySourceAdmission({ observedAt: NOW.toISOString(), planBytes, canonicalPackBytes, snapshotBytes, candidateBuildSpec: JSON.parse(candidateBytes), sourceInventoryBytes: inventoryBytes, sourceSnapshots: JSON.parse(snapshotsBytes), governancePolicy: JSON.parse(governanceBytes), governancePolicyBytes: governanceBytes, freshnessPolicy: JSON.parse(freshnessBytes) });
}

test("collect records failure after COLLECTION_STARTED and never resumes a provider call", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "facility-operation-"));
  const root = path.join(temporaryRoot, "operation");
  const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const sha = EXACT_MAIN;
  await prepareCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot: root, expectedMainSha: sha, expectedBucketOwner: "123456789012", execFileImpl: exactMainExec });
  let calls = 0;
  await assert.rejects(collectCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot: root, serviceKey: "test", execFileImpl: async (file, args) => file === "git" ? exactMainExec(file, args) : ({ stdout: args[0] === "sts" ? "123456789012\n" : "" }), collectImpl: async () => { calls += 1; throw new Error("network"); } }), /network/);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(await readFile(path.join(root, "journal.json"), "utf8")).phase, "COLLECTION_FAILED");
  await assert.rejects(collectCurrentCapitalFacilityOperation({ operationRoot: root, serviceKey: "test", collectImpl: async () => { calls += 1; } }), /PREPARED/);
  assert.equal(calls, 1);
});

test("wrong AWS owner stops before COLLECTION_STARTED and provider call 0", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "facility-operation-")); const root = path.join(temporaryRoot, "operation");
  const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../.."); const sha = EXACT_MAIN;
  await prepareCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot: root, expectedMainSha: sha, expectedBucketOwner: "123456789012", execFileImpl: exactMainExec });
  let calls = 0;
  await assert.rejects(collectCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot: root, serviceKey: "test", execFileImpl: async (file, args) => file === "git" ? exactMainExec(file, args) : ({ stdout: "999999999999\n" }), collectImpl: async () => { calls += 1; } }), /does not match/);
  assert.equal(calls, 0); assert.equal(JSON.parse(await readFile(path.join(root, "journal.json"), "utf8")).phase, "COLLECTION_FAILED");
});

test("stale prepared main stops before AWS or KRIC", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "facility-operation-")); const operationRoot = path.join(temporaryRoot, "operation");
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  await prepareCurrentCapitalFacilityOperation({ repositoryRoot: REPOSITORY_ROOT, operationRoot, expectedMainSha: EXACT_MAIN, expectedBucketOwner: "123456789012", execFileImpl: exactMainExec });
  const journalPath = path.join(operationRoot, "journal.json"); const journal = JSON.parse(await readFile(journalPath, "utf8")); journal.expectedMainSha = "0".repeat(40); await writeJson(journalPath, journal);
  let awsCalls = 0; let kricCalls = 0;
  await assert.rejects(collectCurrentCapitalFacilityOperation({ repositoryRoot: REPOSITORY_ROOT, operationRoot, serviceKey: "test", execFileImpl: async (file, args) => {
    if (file === "git") return exactMainExec(file, args); awsCalls += 1; return { stdout: "123456789012\n" };
  }, collectImpl: async () => { kricCalls += 1; } }), /exact clean main preflight/);
  journal.expectedMainSha = EXACT_MAIN; await writeJson(journalPath, journal); await writeFile(path.join(operationRoot, "plan.json"), "{}\n");
  await assert.rejects(collectCurrentCapitalFacilityOperation({ repositoryRoot: REPOSITORY_ROOT, operationRoot, serviceKey: "test", execFileImpl: async (file, args) => {
    if (file === "git") return exactMainExec(file, args); awsCalls += 1; return { stdout: "123456789012\n" };
  }, collectImpl: async () => { kricCalls += 1; } }), /operation plan identity mismatch/);
  assert.equal(awsCalls, 0); assert.equal(kricCalls, 0);
});

test("missing KRIC_SERVICE_KEY leaves PREPARED before any claim", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "facility-operation-")); const operationRoot = path.join(temporaryRoot, "operation"); t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  await prepareCurrentCapitalFacilityOperation({ repositoryRoot: REPOSITORY_ROOT, operationRoot, expectedMainSha: EXACT_MAIN, expectedBucketOwner: "123456789012", execFileImpl: exactMainExec });
  await assert.rejects(collectCurrentCapitalFacilityOperation({ repositoryRoot: REPOSITORY_ROOT, operationRoot, execFileImpl: exactMainExec }), /KRIC_SERVICE_KEY/);
  assert.equal(JSON.parse(await readFile(path.join(operationRoot, "journal.json"), "utf8")).phase, "PREPARED");
});

test("expired or license-drift governance stops before AWS or KRIC", async (t) => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "facility-preflight-repository-")); const operationRoot = await mkdtemp(path.join(tmpdir(), "facility-preflight-operation-"));
  t.after(() => Promise.all([rm(repositoryRoot, { recursive: true, force: true }), rm(operationRoot, { recursive: true, force: true })]));
  await rm(operationRoot, { recursive: true, force: true });
  for (const relative of FIXTURE_INPUTS) { const target = path.join(repositoryRoot, relative); await mkdir(path.dirname(target), { recursive: true }); await cp(path.join(REPOSITORY_ROOT, relative), target); }
  const inventory = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/source-inventory.json"), "utf8")); const snapshotRelative = inventory.sources.find(({ id }) => id === "kric-station-convenience-standard").accessibilityAdmissionEvidence.snapshotPath;
  await mkdir(path.dirname(path.join(repositoryRoot, snapshotRelative)), { recursive: true }); await cp(path.join(REPOSITORY_ROOT, snapshotRelative), path.join(repositoryRoot, snapshotRelative));
  await prepareCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot, expectedMainSha: EXACT_MAIN, expectedBucketOwner: "123456789012", execFileImpl: exactMainExec });
  const governancePath = path.join(repositoryRoot, "tools/datapack/source-governance-policy.json"); const governance = JSON.parse(await readFile(governancePath, "utf8")); const review = governance.sources.find(({ sourceId }) => sourceId === "kric-station-convenience-standard").licenseReview; review.nextReviewAt = "invalid"; review.termsHash = "0".repeat(64); await writeJson(governancePath, governance);
  let awsCalls = 0; let kricCalls = 0;
  await assert.rejects(collectCurrentCapitalFacilityOperation({ repositoryRoot, operationRoot, serviceKey: "test", now: NOW, execFileImpl: async (file, args) => file === "git" ? exactMainExec(file, args) : (awsCalls += 1, { stdout: "123456789012\n" }), collectImpl: async () => { kricCalls += 1; } }), /nextReviewAt/);
  assert.equal(awsCalls, 0); assert.equal(kricCalls, 0);
});

test("CLI parser keeps collect and finalize one-shot boundaries explicit", () => {
  assert.deepEqual(parseArgs(["--phase", "collect", "--operation-root", "/private/op"]), { phase: "collect", "operation-root": "/private/op" });
  assert.throws(() => parseArgs(["--phase", "prepare", "--operation-root", "/private/op"]), /expected main SHA/);
  assert.throws(() => parseArgs(["--phase", "prepare", "--operation-root", "/private/op", "--expected-main-sha", "a"]), /expected bucket owner/);
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
    await main(["--phase", "finalize", "--operation-root", fixture.operationRoot], {
      repositoryRoot: fixture.root, now: stage === "admitted" ? new Date("2026-08-15T13:00:00.000Z") : NOW, execFileImpl: exactMainExec,
      publishImpl: async () => { calls.publish += 1; throw new Error("published receipt must reconcile before replay"); },
      registerImpl: async ({ snapshotTargetPath }) => { calls.register += 1; await mkdir(path.dirname(snapshotTargetPath), { recursive: true }); await writeFile(snapshotTargetPath, fixture.snapshotBytes); },
      rebindImpl: async ({ repositoryRoot, now }) => { calls.rebind += 1; return rebindCurrentCandidateSourceSnapshots({ repositoryRoot, now }); },
    });
    assert.deepEqual(calls, { publish: 0, ...expected });
    const admission = JSON.parse(await readFile(path.join(fixture.root, "tools/datapack/release/current-capital-facility-source-admission.json"), "utf8"));
    assert.equal(admission.sourceIdentity.snapshotId, fixture.snapshot.snapshotId, stage);
    assert.equal(admission.candidate.sourceSnapshotSetHash, JSON.parse(await readFile(path.join(fixture.root, "tools/datapack/release/candidate-build-spec.json"), "utf8")).sourceSnapshotSetHash, stage);
    assert.equal(JSON.parse(await readFile(path.join(fixture.operationRoot, "journal.json"), "utf8")).phase, "FINALIZED", stage);
  }
});

test("finalize fails closed for an existing partial receipt before publishing again", async (t) => {
  const fixture = await finalizeFixture(t); let published = 0;
  await writeJson(path.join(fixture.operationRoot, "receipt.json"), { ...receipt(fixture), snapshotId: "wrong-snapshot" });
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

test("inconsistent external receipt cannot skip full registration reconciliation", async (t) => {
  const fixture = await finalizeFixture(t); const target = path.join(fixture.root, "tools/datapack/sources", `${fixture.snapshot.snapshotId}.json`);
  await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, fixture.snapshotBytes); await writeJson(path.join(fixture.operationRoot, "receipt.json"), { ...receipt(fixture), rawObjectSha256: "0".repeat(64) });
  let registrations = 0;
  await assert.rejects(main(["--phase", "finalize", "--operation-root", fixture.operationRoot], { repositoryRoot: fixture.root, now: NOW, execFileImpl: exactMainExec, registerImpl: async () => { registrations += 1; } }), /registered snapshot verification failed/);
  assert.equal(registrations, 1);
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
