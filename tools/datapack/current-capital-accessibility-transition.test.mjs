import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";
import {
  assertCurrentCapitalAccessibilityBuildAllowed,
  buildCurrentCapitalAccessibilityTransition,
  canonicalCurrentCapitalAccessibilityTransitionJson,
  main,
  readCurrentCapitalAccessibilityTransitionBoundary,
} from "./current-capital-accessibility-transition.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const BASE_SOURCE_IDS = Object.freeze([
  "seoul-metro-route-map-positions", "kric-subway-timetable", "seoul-metro-accessibility",
  "kric-station-convenience-standard", "molit-urban-rail-full-route", "seoulmetro-station-line-info",
  "incheon-transit-accessibility",
]);
const TRANSFER_SOURCE_ID = "seoul-metro-transfer-distance-duration";
const INVENTORY_PATH = "tools/datapack/source-inventory.json";

test("pending full fan-in marker를 exact current identities에 결속하고 route build를 막는다", async (t) => {
  const fixture = await createFixture(t);
  const transition = buildCurrentCapitalAccessibilityTransition(fixture.input);
  const bytes = canonicalCurrentCapitalAccessibilityTransitionJson(transition);
  assert.equal(transition.schemaVersion, 2);
  assert.equal(transition.state, "PENDING_FULL_FAN_IN");
  assert.equal(transition.previousProduction.candidateId, fixture.input.previous.candidate.candidateId);
  assert.notEqual(transition.nextCandidate.candidateId, transition.previousProduction.candidateId);
  assert.equal(transition.previousProduction.sourceSnapshotSetHash, fixture.previousSourceSet);
  assert.equal(transition.nextCandidate.sourceSnapshotSetHash, fixture.baseSourceSet);
  assert.equal(transition.pendingPrerequisites.authorityEdgeCount, 456);

  await writeFile(path.join(fixture.root, "tools/datapack/release/current-capital-accessibility-transition.json"), bytes);
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

test("exact TRANSFER-last append는 seven-source marker를 인증한 뒤에도 build를 차단한다", async (t) => {
  const fixture = await createFixture(t);
  const transitionPath = path.join(fixture.root, "tools/datapack/release/current-capital-accessibility-transition.json");
  const candidatePath = path.join(fixture.root, "tools/datapack/release/candidate-build-spec.json");
  const ledgerPath = path.join(fixture.root, "tools/datapack/release/source-snapshots.json");
  const transition = buildCurrentCapitalAccessibilityTransition(fixture.input);
  await writeFile(transitionPath, canonicalCurrentCapitalAccessibilityTransitionJson(transition));

  const transfer = { sourceId: TRANSFER_SOURCE_ID, snapshotId: "snapshot-transfer" };
  const ledger = [...fixture.baseLedger, transfer];
  const sourceInventory = structuredClone(fixture.sourceInventory);
  const transferSource = sourceInventory.sources[0];
  transferSource.requiredForProductionPack = true;
  transferSource.capabilities.transfer = {
    status: "SUPPORTED",
    productionUseAllowed: true,
    coverageStatus: "CAPITAL_SEOUL_METRO_15_PAIRS_30_DIRECTED_METRICS",
  };
  transferSource.transferAdmissionEvidence = {
    decision: "APPROVED",
    productionUseAllowed: true,
    snapshotId: transfer.snapshotId,
  };
  const sourceInventoryBytes = Buffer.from(`${JSON.stringify(sourceInventory, null, 2)}\n`);
  const candidate = {
    ...fixture.input.candidate,
    sourceSnapshotIds: ledger.map(({ snapshotId }) => snapshotId),
    sourceSnapshots: ledger.map(({ sourceId, snapshotId }) => ({ sourceId, snapshotId })),
    sourceSnapshotSetHash: sha256(Buffer.from(JSON.stringify(ledger))),
    sourceInventorySha256: sha256(Buffer.from(JSON.stringify(sourceInventory))),
    networkEdgeEvidence: {
      sourceInventory: { path: INVENTORY_PATH, sha256: sha256(sourceInventoryBytes) },
    },
  };
  await writeFile(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  await writeFile(path.join(fixture.root, INVENTORY_PATH), sourceInventoryBytes);
  assert.deepEqual(
    await readCurrentCapitalAccessibilityTransitionBoundary({ repositoryRoot: fixture.root }),
    {
      currentCandidateBytesSha256: sha256(Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`)),
      currentCandidateSourceSetSha256: candidate.sourceSnapshotSetHash,
      evidenceSourceSetSha256: fixture.baseSourceSet,
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
  const baseLedger = BASE_SOURCE_IDS.map((sourceId, index) => ({
    sourceId,
    snapshotId: `snapshot-${index}`,
  }));
  const baseSourceSet = sha256(Buffer.from(JSON.stringify(baseLedger)));
  const sourceInventory = {
    schemaVersion: 1,
    sources: [{
      id: TRANSFER_SOURCE_ID,
      requiredForProductionPack: false,
      capabilities: { accessibility: { status: "SUPPORTED" } },
    }],
  };
  const sourceInventoryBytes = Buffer.from(`${JSON.stringify(sourceInventory, null, 2)}\n`);
  const candidate = {
    schemaVersion: 1,
    artifactKind: "datapack-candidate-build-spec",
    candidateId: "staged-next-candidate",
    networkEdgeEvidence: {
      sourceInventory: { path: INVENTORY_PATH, sha256: sha256(sourceInventoryBytes) },
    },
    sourceSnapshotIds: baseLedger.map(({ snapshotId }) => snapshotId),
    sourceSnapshots: baseLedger.map(({ sourceId, snapshotId }) => ({ sourceId, snapshotId })),
    sourceSnapshotSetHash: baseSourceSet,
    sourceInventorySha256: sha256(Buffer.from(JSON.stringify(sourceInventory))),
  };
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const facilityAdmission = buildFacilityAdmission(candidate.candidateId, baseSourceSet);
  const facilityBytes = Buffer.from(`${canonicalJson(facilityAdmission)}\n`);
  await mkdir(path.join(release, "current-station-line-accessibility"), { recursive: true });
  await writeFile(path.join(release, "candidate-build-spec.json"), candidateBytes);
  await writeFile(path.join(release, "source-snapshots.json"), `${JSON.stringify(baseLedger, null, 2)}\n`);
  await writeFile(path.join(root, INVENTORY_PATH), sourceInventoryBytes);
  await writeFile(path.join(release, "current-station-line-accessibility/station-line-input.json"), previousBytes);
  await writeFile(path.join(release, "current-capital-facility-source-admission.json"), facilityBytes);
  return {
    root,
    baseLedger,
    baseSourceSet,
    previousSourceSet,
    sourceInventory,
    input: { candidate, candidateBytes, previous, previousBytes, facilityAdmission, facilityBytes },
  };
}

function buildFacilityAdmission(candidateId, sourceSnapshotSetHash) {
  const snapshotId = "kric-station-convenience-standard-20260816T015619375Z";
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
      rawSha256: "1".repeat(64),
      redactedRequestFingerprint: "2".repeat(64),
      contentSha256: "3".repeat(64),
      schemaFingerprint: "4".repeat(64),
      snapshotFileSha256: "5".repeat(64),
      capturedAt: "2026-08-16T01:56:19.375Z",
      observedAt: "2026-08-16T01:56:19.375Z",
      freshUntil: "2026-08-17T01:56:19.375Z",
      rawObjectUri: "oci://trusted/object.json",
      rawObjectSha256: "6".repeat(64),
      credentialRedacted: true,
      licenseEvidenceHash: "7".repeat(64),
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
