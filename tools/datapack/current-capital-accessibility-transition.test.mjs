import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";
import {
  assertCurrentCapitalAccessibilityBuildAllowed,
  buildCurrentCapitalAccessibilityTransition,
  buildCurrentCapitalAccessibilityTransitionSuccessor,
  canonicalCurrentCapitalAccessibilityTransitionJson,
  canonicalCurrentCapitalAccessibilityTransitionSuccessorJson,
  main,
  readCurrentCapitalAccessibilityTransitionBoundary,
} from "./current-capital-accessibility-transition.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const BASE_SOURCE_IDS = Object.freeze([
  "seoul-metro-route-map-positions", "kric-subway-timetable", "seoul-metro-accessibility",
  "kric-station-convenience-standard", "molit-urban-rail-full-route", "seoulmetro-station-line-info",
  "incheon-transit-accessibility",
]);
const FACILITY_SOURCE_ID = "kric-station-convenience-standard";
const BASE_FACILITY_SNAPSHOT_ID = "kric-station-convenience-standard-20260816T015619375Z";
const TRANSFER_SOURCE_ID = "seoul-metro-transfer-distance-duration";
const INVENTORY_PATH = "tools/datapack/source-inventory.json";
const PROJECTION_KEYS = Object.freeze([
  "snapshotId", "sourceId", "rawObjectUri", "rawSha256", "redactedRequestFingerprint",
  "schemaFingerprint", "licenseStatus", "redistributionAllowed", "adminReviewRecordHash",
  "snapshotStatus", "credentialRedacted", "freshnessExpiresAt", "rawRetentionExpiresAt",
  "governancePolicyVersion", "governancePolicySha256",
]);

test("pending full fan-in marker를 exact current identities에 결속하고 route build를 막는다", async (t) => {
  const fixture = await createFixture(t);
  const transition = buildCurrentCapitalAccessibilityTransition(fixture.input);
  const bytes = canonicalCurrentCapitalAccessibilityTransitionJson(transition);
  assert.equal(transition.schemaVersion, 2);
  assert.equal(transition.state, "PENDING_FULL_FAN_IN");
  assert.equal(transition.previousProduction.candidateId, fixture.input.previous.candidate.candidateId);
  assert.notEqual(transition.nextCandidate.candidateId, transition.previousProduction.candidateId);
  assert.equal(transition.previousCandidate.canonicalCandidate.candidateId, transition.previousCandidate.candidateId);
  assert.equal(
    transition.previousCandidate.canonicalCandidate.sourceSnapshotSetHash,
    transition.previousCandidate.sourceSnapshotSetHash,
  );
  assert.equal(
    transition.previousCandidate.sha256,
    sha256(Buffer.from(canonicalJson(transition.previousCandidate.canonicalCandidate))),
  );
  assert.notEqual(transition.previousCandidate.candidateId, transition.nextCandidate.candidateId);
  assert.equal(transition.previousCandidate.sourceSnapshotSetHash, fixture.predecessorSourceSet);
  assert.equal(transition.previousProduction.sourceSnapshotSetHash, fixture.previousSourceSet);
  assert.equal(transition.nextCandidate.sourceSnapshotSetHash, fixture.baseSourceSet);
  assert.equal(transition.pendingPrerequisites.authorityEdgeCount, 456);

  await main([], { repositoryRoot: fixture.root, log: () => {} });
  await assert.rejects(
    () => assertCurrentCapitalAccessibilityBuildAllowed({ repositoryRoot: fixture.root }),
    /CURRENT_ACCESSIBILITY_TRANSITION_BLOCKED/,
  );
  const malformedPrevious = structuredClone(fixture.input.previous);
  malformedPrevious.candidate.unexpected = true;
  assert.throws(
    () => buildCurrentCapitalAccessibilityTransition({
      ...fixture.input,
      previous: malformedPrevious,
      previousBytes: Buffer.from(canonicalJson(malformedPrevious)),
    }),
    /full-capital station-line candidate keys mismatch/,
  );

  const legacy = JSON.parse(bytes);
  legacy.schemaVersion = 1;
  delete legacy.previousProduction.candidateId;
  delete legacy.transitionSha256;
  legacy.transitionSha256 = sha256(Buffer.from(canonicalJson(legacy)));
  assert.throws(
    () => canonicalCurrentCapitalAccessibilityTransitionJson(legacy),
    /current accessibility transition schema mismatch|transition previous production keys mismatch/,
  );

  const equalCandidateIds = JSON.parse(bytes);
  equalCandidateIds.previousProduction.candidateId = equalCandidateIds.nextCandidate.candidateId;
  delete equalCandidateIds.transitionSha256;
  equalCandidateIds.transitionSha256 = sha256(Buffer.from(canonicalJson(equalCandidateIds)));
  assert.throws(
    () => canonicalCurrentCapitalAccessibilityTransitionJson(equalCandidateIds),
    /candidate.*identity|candidateId/i,
  );

  const drifted = JSON.parse(bytes);
  drifted.nextCandidate.sourceSnapshotSetHash = "8".repeat(64);
  delete drifted.transitionSha256;
  drifted.transitionSha256 = sha256(Buffer.from(canonicalJson(drifted)));
  await writeFile(path.join(fixture.root, "tools/datapack/release/current-capital-accessibility-transition.json"), canonicalCurrentCapitalAccessibilityTransitionJson(drifted));
  await assert.rejects(
    () => assertCurrentCapitalAccessibilityBuildAllowed({ repositoryRoot: fixture.root }),
    /transition candidate binding mismatch/,
  );
});

test("successor는 immutable base marker와 pre-rebind FACILITY bytes를 함께 결속한다", async (t) => {
  const fixture = await createFixture(t);
  const base = buildCurrentCapitalAccessibilityTransition(fixture.input);
  const baseBytes = Buffer.from(canonicalCurrentCapitalAccessibilityTransitionJson(base));
  const current = structuredClone(base);
  current.nextCandidate = { ...current.nextCandidate, sourceSnapshotSetHash: "e".repeat(64) };
  const { transitionSha256: _ignored, ...currentPayload } = current;
  current.transitionSha256 = sha256(Buffer.from(canonicalJson(currentPayload)));
  const successor = buildCurrentCapitalAccessibilityTransitionSuccessor({
    baseTransitionBytes: baseBytes,
    previousFacilityBytes: fixture.input.facilityBytes,
    currentFacilityBytes: fixture.input.facilityBytes,
    currentLedger: fixture.baseLedger,
    currentTransition: current,
  });
  const bytes = canonicalCurrentCapitalAccessibilityTransitionSuccessorJson(successor);
  const parsed = JSON.parse(bytes);
  assert.equal(parsed.artifactKind, "current-capital-accessibility-transition-successor");
  assert.equal(parsed.supersededTransition.sha256, sha256(baseBytes));
  assert.equal(parsed.previousFacilityAdmission.sha256, sha256(fixture.input.facilityBytes));
  assert.equal(Buffer.from(parsed.previousFacilityAdmissionBase64, "base64").toString("utf8"), fixture.input.facilityBytes.toString("utf8"));
  assert.equal(parsed.successorSha256, sha256(Buffer.from(canonicalJson(Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== "successorSha256"))))));

  parsed.previousFacilityAdmissionBase64 = Buffer.from("{}").toString("base64");
  assert.throws(
    () => canonicalCurrentCapitalAccessibilityTransitionSuccessorJson(parsed),
    /capital FACILITY admission output keys mismatch/,
  );
});

test("terminal successor는 direct KRIC FACILITY lineage만 exact-seven predecessor advance로 허용한다", async (t) => {
  const fixture = await createFixture(t);
  const base = buildCurrentCapitalAccessibilityTransition(fixture.input);
  const baseBytes = Buffer.from(canonicalCurrentCapitalAccessibilityTransitionJson(base));
  const currentLedger = structuredClone(fixture.baseLedger);
  const ledgerIndex = currentLedger.findIndex(({ sourceId }) => sourceId === FACILITY_SOURCE_ID);
  const currentSnapshotId = "kric-station-convenience-standard-20260901T081638049Z";
  currentLedger[ledgerIndex] = {
    ...currentLedger[ledgerIndex],
    snapshotId: currentSnapshotId,
    previousSnapshotId: BASE_FACILITY_SNAPSHOT_ID,
    rawObjectUri: "oci://trusted/kric-station-convenience-standard/current.json",
    rawSha256: "9".repeat(64),
    freshnessExpiresAt: "2026-09-02T00:00:00.000Z",
    rawRetentionExpiresAt: "2026-12-01T00:00:00.000Z",
  };
  const candidate = structuredClone(fixture.input.candidate);
  candidate.sourceSnapshotIds = candidate.sourceSnapshotIds.map((snapshotId) =>
    snapshotId === BASE_FACILITY_SNAPSHOT_ID ? currentSnapshotId : snapshotId);
  candidate.sourceSnapshots = candidate.sourceSnapshots.map((projection) => projection.sourceId === FACILITY_SOURCE_ID
    ? Object.fromEntries(PROJECTION_KEYS.map((key) => [
      key,
      key === "adminReviewRecordHash"
        ? projection.adminReviewRecordHash
        : currentLedger[ledgerIndex][key],
    ]))
    : projection);
  candidate.sourceSnapshotSetHash = sha256(Buffer.from(JSON.stringify(currentLedger)));
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const currentFacility = buildFacilityAdmission(candidate.candidateId, candidate.sourceSnapshotSetHash, {
    snapshotId: currentSnapshotId,
    previous: fixture.input.facilityAdmission,
  });
  const currentFacilityBytes = Buffer.from(`${canonicalJson(currentFacility)}\n`);
  const currentTransition = buildCurrentCapitalAccessibilityTransition({
    ...fixture.input,
    candidate,
    candidateBytes,
    facilityAdmission: currentFacility,
    facilityBytes: currentFacilityBytes,
    ledger: currentLedger,
    ledgerBytes: Buffer.from(`${JSON.stringify(currentLedger, null, 2)}\n`),
  });

  assert.doesNotThrow(() => buildCurrentCapitalAccessibilityTransitionSuccessor({
    baseTransitionBytes: baseBytes,
    previousFacilityBytes: fixture.input.facilityBytes,
    currentFacilityBytes,
    currentLedger,
    currentTransition,
  }));

  const brokenLineage = structuredClone(currentLedger);
  brokenLineage[ledgerIndex].previousSnapshotId = "unrelated-snapshot";
  assert.throws(() => buildCurrentCapitalAccessibilityTransitionSuccessor({
    baseTransitionBytes: baseBytes,
    previousFacilityBytes: fixture.input.facilityBytes,
    currentFacilityBytes,
    currentLedger: brokenLineage,
    currentTransition,
  }), /FACILITY predecessor lineage mismatch/);

  const contentDrift = structuredClone(currentLedger);
  contentDrift[ledgerIndex].contentSha256 = "8".repeat(64);
  assert.throws(() => buildCurrentCapitalAccessibilityTransitionSuccessor({
    baseTransitionBytes: baseBytes,
    previousFacilityBytes: fixture.input.facilityBytes,
    currentFacilityBytes,
    currentLedger: contentDrift,
    currentTransition,
  }), /FACILITY predecessor lineage mismatch/);

  const otherSourceDrift = structuredClone(currentTransition);
  otherSourceDrift.previousCandidate.canonicalCandidate.sourceSnapshots[0].rawSha256 = "7".repeat(64);
  otherSourceDrift.previousCandidate.sha256 = sha256(Buffer.from(canonicalJson(otherSourceDrift.previousCandidate.canonicalCandidate)));
  rehashTransition(otherSourceDrift);
  assert.throws(() => buildCurrentCapitalAccessibilityTransitionSuccessor({
    baseTransitionBytes: baseBytes,
    previousFacilityBytes: fixture.input.facilityBytes,
    currentFacilityBytes,
    currentLedger,
    currentTransition: otherSourceDrift,
  }), /non-FACILITY predecessor changed/);

  const semanticDrift = structuredClone(currentFacility);
  semanticDrift.stationLineProviderMappingSha256 = "0".repeat(64);
  delete semanticDrift.admissionDigest;
  semanticDrift.admissionDigest = sha256(Buffer.from(canonicalJson(semanticDrift)));
  const semanticDriftBytes = Buffer.from(`${canonicalJson(semanticDrift)}\n`);
  const semanticTransition = structuredClone(currentTransition);
  semanticTransition.facilityAdmission = {
    ...semanticTransition.facilityAdmission,
    sha256: sha256(semanticDriftBytes),
    admissionDigest: semanticDrift.admissionDigest,
  };
  rehashTransition(semanticTransition);
  assert.throws(() => buildCurrentCapitalAccessibilityTransitionSuccessor({
    baseTransitionBytes: baseBytes,
    previousFacilityBytes: fixture.input.facilityBytes,
    currentFacilityBytes: semanticDriftBytes,
    currentLedger,
    currentTransition: semanticTransition,
  }), /FACILITY protected semantics mismatch/);
});

test("exact TRANSFER-last append는 seven-source marker를 인증한 뒤에도 build를 차단한다", async (t) => {
  const fixture = await createFixture(t);
  const transitionPath = path.join(fixture.root, "tools/datapack/release/current-capital-accessibility-transition.json");
  const candidatePath = path.join(fixture.root, "tools/datapack/release/candidate-build-spec.json");
  const ledgerPath = path.join(fixture.root, "tools/datapack/release/source-snapshots.json");
  await main([], { repositoryRoot: fixture.root, log: () => {} });
  const candidate = fixture.input.candidate;
  const ledger = fixture.baseLedger;
  assert.deepEqual(
    await readCurrentCapitalAccessibilityTransitionBoundary({ repositoryRoot: fixture.root }),
    {
      currentCandidateBytesSha256: sha256(Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`)),
      currentCandidateSourceSetSha256: candidate.sourceSnapshotSetHash,
      evidenceSourceSetSha256: fixture.predecessorSourceSet,
      facilityAdmissionBytesSha256: sha256(fixture.input.facilityBytes),
    },
  );
  await assert.rejects(
    () => assertCurrentCapitalAccessibilityBuildAllowed({ repositoryRoot: fixture.root }),
    /CURRENT_ACCESSIBILITY_TRANSITION_BLOCKED/,
  );

  await writeFile(candidatePath, `${JSON.stringify({ ...candidate, candidateId: "drifted-candidate" }, null, 2)}\n`);
  await assert.rejects(
    () => assertCurrentCapitalAccessibilityBuildAllowed({ repositoryRoot: fixture.root }),
    /transition candidate binding mismatch/,
  );

  const projectionDrift = structuredClone(candidate);
  projectionDrift.sourceSnapshots[0].governancePolicySha256 = "f".repeat(64);
  await writeFile(candidatePath, `${JSON.stringify(projectionDrift, null, 2)}\n`);
  await assert.rejects(
    () => assertCurrentCapitalAccessibilityBuildAllowed({ repositoryRoot: fixture.root }),
    /transition candidate binding mismatch/,
  );

  const appendedProjectionDrift = structuredClone(candidate);
  appendedProjectionDrift.sourceSnapshots.at(-1).governancePolicySha256 = "f".repeat(64);
  await writeFile(candidatePath, `${JSON.stringify(appendedProjectionDrift, null, 2)}\n`);
  await assert.rejects(
    () => assertCurrentCapitalAccessibilityBuildAllowed({ repositoryRoot: fixture.root }),
    /transition candidate binding mismatch/,
  );

  const otherLedger = [...fixture.baseLedger, { sourceId: "other-source", snapshotId: "snapshot-other" }];
  const other = {
    ...candidate,
    sourceSnapshotIds: otherLedger.map(({ snapshotId }) => snapshotId),
    sourceSnapshots: otherLedger.map(({ sourceId, snapshotId }) => ({ sourceId, snapshotId })),
    sourceSnapshotSetHash: sha256(Buffer.from(JSON.stringify(otherLedger))),
  };
  await writeFile(candidatePath, `${JSON.stringify(other, null, 2)}\n`);
  await writeFile(ledgerPath, `${JSON.stringify(otherLedger, null, 2)}\n`);
  await assert.rejects(
    () => assertCurrentCapitalAccessibilityBuildAllowed({ repositoryRoot: fixture.root }),
    /transition candidate binding mismatch/,
  );

  const prefixDriftLedger = structuredClone(ledger);
  prefixDriftLedger[0].snapshotId = "snapshot-prefix-drift";
  const prefixDrift = {
    ...candidate,
    sourceSnapshotIds: prefixDriftLedger.map(({ snapshotId }) => snapshotId),
    sourceSnapshots: prefixDriftLedger.map(({ sourceId, snapshotId }) => ({ sourceId, snapshotId })),
    sourceSnapshotSetHash: sha256(Buffer.from(JSON.stringify(prefixDriftLedger))),
  };
  await writeFile(candidatePath, `${JSON.stringify(prefixDrift, null, 2)}\n`);
  await writeFile(ledgerPath, `${JSON.stringify(prefixDriftLedger, null, 2)}\n`);
  await assert.rejects(
    () => assertCurrentCapitalAccessibilityBuildAllowed({ repositoryRoot: fixture.root }),
    /transition candidate binding mismatch/,
  );

  await writeFile(candidatePath, `${JSON.stringify({ ...candidate, sourceSnapshotSetHash: "0".repeat(64) }, null, 2)}\n`);
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  await assert.rejects(
    () => assertCurrentCapitalAccessibilityBuildAllowed({ repositoryRoot: fixture.root }),
    /transition candidate binding mismatch/,
  );
});

test("CLI는 marker를 create-once 0600으로 게시하고 marker 부재는 build를 허용한다", async (t) => {
  const fixture = await createFixture(t);
  await assert.doesNotReject(() => assertCurrentCapitalAccessibilityBuildAllowed({ repositoryRoot: fixture.root }));
  const result = await main([], { repositoryRoot: fixture.root, log: () => {} });
  const output = path.join(fixture.root, "tools/datapack/release/current-capital-accessibility-transition.json");
  assert.equal(await readFile(output, "utf8"), canonicalCurrentCapitalAccessibilityTransitionJson(result));
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  await assert.rejects(() => main([], { repositoryRoot: fixture.root, log: () => {} }), /output already exists/);
});

test("CLI는 marker 게시 직전 결속 입력이 교체되면 output 0으로 실패한다", async (t) => {
  const fixture = await createFixture(t);
  const candidatePath = path.join(fixture.root, "tools/datapack/release/candidate-build-spec.json");
  const output = path.join(fixture.root, "tools/datapack/release/current-capital-accessibility-transition.json");
  await assert.rejects(
    () => main([], {
      repositoryRoot: fixture.root,
      log: () => {},
      beforePublish: async () => {
        const current = await readFile(candidatePath);
        await writeFile(candidatePath, Buffer.concat([current, Buffer.from(" ")]));
      },
    }),
    /transition bound input changed/,
  );
  await assert.rejects(() => readFile(output), { code: "ENOENT" });
});

async function createFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "capital-transition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = path.join(root, "tools/datapack/release");
  await mkdir(release, { recursive: true });
  const previousBytes = await readFile(path.join(ROOT, "tools/datapack/release/current-station-line-accessibility/station-line-input.json"));
  const previous = JSON.parse(previousBytes);
  const previousSourceSet = previous.candidate.sourceSetSha256;
  const ledgerRow = (sourceId, snapshotId, index) => ({
    sourceId,
    snapshotId,
    previousSnapshotId: null,
    contentSha256: "3".repeat(64),
    rawObjectUri: `oci://trusted/${sourceId}.json`,
    rawSha256: String(index + 1).repeat(64).slice(0, 64),
    redactedRequestFingerprint: "a".repeat(64),
    schemaFingerprint: "b".repeat(64),
    licenseStatus: "PASS",
    redistributionAllowed: true,
    snapshotStatus: "LOCKED",
    credentialRedacted: true,
    freshnessExpiresAt: "2026-09-01T00:00:00.000Z",
    rawRetentionExpiresAt: "2026-11-01T00:00:00.000Z",
    governancePolicyVersion: "fixture-v1",
    governancePolicySha256: "c".repeat(64),
  });
  const predecessorLedger = BASE_SOURCE_IDS.map((sourceId, index) => ledgerRow(
    sourceId,
    sourceId === FACILITY_SOURCE_ID ? BASE_FACILITY_SNAPSHOT_ID : `snapshot-${index}`,
    index,
  ));
  const transfer = ledgerRow(TRANSFER_SOURCE_ID, "snapshot-transfer", 8);
  const baseLedger = [predecessorLedger[0], predecessorLedger[1], transfer, ...predecessorLedger.slice(2)];
  const baseSourceSet = sha256(Buffer.from(JSON.stringify(baseLedger)));
  const predecessorInLedgerOrder = baseLedger.filter(({ sourceId }) => sourceId !== TRANSFER_SOURCE_ID);
  const predecessorSourceSet = sha256(Buffer.from(JSON.stringify(predecessorInLedgerOrder)));
  const sources = [...BASE_SOURCE_IDS, TRANSFER_SOURCE_ID].map((id, index) => ({
    id,
    requiredForProductionPack: id === TRANSFER_SOURCE_ID,
    capabilities: id === TRANSFER_SOURCE_ID
      ? {
        accessibility: { status: "SUPPORTED" },
        transfer: { status: "SUPPORTED", productionUseAllowed: true, coverageStatus: "CAPITAL_SEOUL_METRO_15_PAIRS_30_DIRECTED_METRICS" },
      }
      : { accessibility: { status: "SUPPORTED" } },
    admissionEvidence: { adminReviewRecordHash: String.fromCharCode(100 + index).repeat(64) },
    ...(id === TRANSFER_SOURCE_ID
      ? { transferAdmissionEvidence: { decision: "APPROVED", productionUseAllowed: true, snapshotId: transfer.snapshotId } }
      : {}),
  }));
  const sourceInventory = {
    schemaVersion: 1,
    sources,
  };
  const sourceInventoryBytes = Buffer.from(`${JSON.stringify(sourceInventory, null, 2)}\n`);
  const candidate = {
    schemaVersion: 1,
    artifactKind: "datapack-candidate-build-spec",
    candidateId: "staged-next-candidate",
    networkEdgeEvidence: {
      sourceInventory: { path: INVENTORY_PATH, sha256: sha256(sourceInventoryBytes) },
    },
    sourceSnapshotIds: [...predecessorLedger, transfer].map(({ snapshotId }) => snapshotId),
    sourceSnapshots: [...predecessorLedger, transfer].map((row) => Object.fromEntries(PROJECTION_KEYS.map((key) => [
      key,
      key === "adminReviewRecordHash"
        ? sources.find(({ id }) => id === row.sourceId).admissionEvidence.adminReviewRecordHash
        : row[key],
    ]))),
    sourceSnapshotSetHash: baseSourceSet,
    sourceInventorySha256: sha256(Buffer.from(JSON.stringify(sourceInventory))),
  };
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const ledgerBytes = Buffer.from(`${JSON.stringify(baseLedger, null, 2)}\n`);
  const facilityAdmission = buildFacilityAdmission(candidate.candidateId, baseSourceSet);
  const facilityBytes = Buffer.from(`${canonicalJson(facilityAdmission)}\n`);
  await mkdir(path.join(release, "current-station-line-accessibility"), { recursive: true });
  await writeFile(path.join(release, "candidate-build-spec.json"), candidateBytes);
  await writeFile(path.join(release, "source-snapshots.json"), ledgerBytes);
  await writeFile(path.join(root, INVENTORY_PATH), sourceInventoryBytes);
  await writeFile(path.join(release, "current-station-line-accessibility/station-line-input.json"), previousBytes);
  await writeFile(path.join(release, "current-capital-facility-source-admission.json"), facilityBytes);
  return {
    root,
    baseLedger,
    baseSourceSet,
    previousSourceSet,
    predecessorSourceSet,
    sourceInventory,
    input: { candidate, candidateBytes, previous, previousBytes, facilityAdmission, facilityBytes, ledger: baseLedger, ledgerBytes, inventory: sourceInventory, inventoryBytes: sourceInventoryBytes },
  };
}

function buildFacilityAdmission(candidateId, sourceSnapshotSetHash, { snapshotId = BASE_FACILITY_SNAPSHOT_ID, previous = null } = {}) {
  const cells = Array.from({ length: 213 }, (_, index) => {
    if (index === 0) return { stationId: "station-b35616704ce3", lineId: "seoul-2", state: "ADMITTED_FACILITY_UNVERIFIED_BLOCKED", sourceId: "kric-station-convenience-standard", snapshotId };
    const stationIndex = Math.min(index, 198);
    return { stationId: `station-${String(stationIndex).padStart(3, "0")}`, lineId: `line-${String(index).padStart(3, "0")}`, state: "ADMITTED_FACILITY_PRESENT", sourceId: "kric-station-convenience-standard", snapshotId };
  }).sort((left, right) => left.stationId.localeCompare(right.stationId) || left.lineId.localeCompare(right.lineId));
  const denominatorRows = cells.flatMap((cell) => ["ELEVATOR", "ESCALATOR", "WHEELCHAIR_LIFT"].map((facilityType) => ({
    stationId: cell.stationId,
    lineId: cell.lineId,
    facilityType,
    state: cell.state === "ADMITTED_FACILITY_UNVERIFIED_BLOCKED" ? "UNVERIFIED_EVIDENCE_BLOCKED" : "VERIFIED_PRESENT",
    sourceId: cell.sourceId,
    snapshotId,
  })));
  const materializerEvidenceRows = cells.map((cell) => ({ ...cell, evidenceState: cell.state === "ADMITTED_FACILITY_UNVERIFIED_BLOCKED" ? "UNVERIFIED_EVIDENCE_BLOCKED" : "VERIFIED_PRESENT" }));
  const payload = {
    schemaVersion: 1,
    artifactKind: "current-capital-facility-source-admission",
    observedAt: "2026-08-16T02:00:00.000Z",
    candidate: { candidateId, sourceSnapshotSetHash },
    sourceIdentity: {
      sourceId: "kric-station-convenience-standard",
      snapshotId,
      snapshotPath: `tools/datapack/sources/${snapshotId}.json`,
      rawSha256: previous?.sourceIdentity?.rawSha256 ?? "1".repeat(64),
      redactedRequestFingerprint: "2".repeat(64),
      contentSha256: previous?.sourceIdentity?.contentSha256 ?? "3".repeat(64),
      schemaFingerprint: previous?.sourceIdentity?.schemaFingerprint ?? "b".repeat(64),
      snapshotFileSha256: "5".repeat(64),
      capturedAt: "2026-08-16T01:56:19.375Z",
      observedAt: "2026-08-16T01:56:19.375Z",
      freshUntil: "2026-08-17T01:56:19.375Z",
      rawObjectUri: "oci://trusted/object.json",
      rawObjectSha256: "6".repeat(64),
      credentialRedacted: true,
      licenseEvidenceHash: previous?.sourceIdentity?.licenseEvidenceHash ?? "7".repeat(64),
    },
    stationLineProviderMappingSha256: "8".repeat(64),
    denominatorRows,
    denominatorStateSummary: { VERIFIED_PRESENT: 636, VERIFIED_ABSENT: 0, UNVERIFIED_EVIDENCE_BLOCKED: 3 },
    cells,
    cellStateSummary: { ADMITTED_FACILITY_PRESENT: 212, ADMITTED_FACILITY_ABSENT: 0, ADMITTED_FACILITY_UNVERIFIED_BLOCKED: 1 },
    materializerEvidenceRows,
    decision: "GO",
  };
  return { ...payload, admissionDigest: sha256(Buffer.from(canonicalJson(payload))) };
}

function rehashTransition(transition) {
  delete transition.transitionSha256;
  transition.transitionSha256 = sha256(Buffer.from(canonicalJson(transition)));
  return transition;
}
