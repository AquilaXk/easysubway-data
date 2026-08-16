import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";
import { buildCurrentSourceRouteEdgeInput } from "./build-current-route-edge-input.mjs";
import {
  assertCurrentCapitalAccessibilityBuildAllowed,
  buildCurrentCapitalAccessibilityTransition,
  canonicalCurrentCapitalAccessibilityTransitionJson,
  main,
} from "./current-capital-accessibility-transition.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const NEXT = "7".repeat(64);

test("pending full fan-in marker를 exact current identities에 결속하고 route build를 막는다", async (t) => {
  const fixture = await createFixture(t);
  const transition = buildCurrentCapitalAccessibilityTransition(fixture.input);
  const bytes = canonicalCurrentCapitalAccessibilityTransitionJson(transition);
  assert.equal(transition.state, "PENDING_FULL_FAN_IN");
  assert.equal(transition.previousProduction.sourceSnapshotSetHash, fixture.previousSourceSet);
  assert.equal(transition.nextCandidate.sourceSnapshotSetHash, NEXT);
  assert.equal(transition.pendingPrerequisites.authorityEdgeCount, 456);

  await writeFile(path.join(fixture.root, "tools/datapack/release/current-capital-accessibility-transition.json"), bytes);
  await assert.rejects(
    () => assertCurrentCapitalAccessibilityBuildAllowed({ repositoryRoot: fixture.root }),
    /CURRENT_ACCESSIBILITY_TRANSITION_BLOCKED/,
  );
  await assert.rejects(
    () => buildCurrentSourceRouteEdgeInput({ repositoryRoot: fixture.root }),
    /CURRENT_ACCESSIBILITY_TRANSITION_BLOCKED/,
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

test("CLI는 marker를 create-once 0600으로 게시하고 marker 부재는 build를 허용한다", async (t) => {
  const fixture = await createFixture(t);
  await assert.doesNotReject(() => assertCurrentCapitalAccessibilityBuildAllowed({ repositoryRoot: fixture.root }));
  const result = await main([], { repositoryRoot: fixture.root, log: () => {} });
  const output = path.join(fixture.root, "tools/datapack/release/current-capital-accessibility-transition.json");
  assert.equal(await readFile(output, "utf8"), canonicalCurrentCapitalAccessibilityTransitionJson(result));
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  await assert.rejects(() => main([], { repositoryRoot: fixture.root, log: () => {} }), /output already exists/);
});

async function createFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "capital-transition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = path.join(root, "tools/datapack/release");
  await mkdir(release, { recursive: true });
  const previousBytes = await readFile(path.join(ROOT, "tools/datapack/release/current-station-line-accessibility/station-line-input.json"));
  const previous = JSON.parse(previousBytes);
  const previousSourceSet = previous.candidate.sourceSetSha256;
  const currentSpec = JSON.parse(await readFile(path.join(ROOT, "tools/datapack/release/candidate-build-spec.json"), "utf8"));
  const candidate = { ...currentSpec, sourceSnapshotSetHash: NEXT };
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const facilityAdmission = buildFacilityAdmission(candidate.candidateId, NEXT);
  const facilityBytes = Buffer.from(`${canonicalJson(facilityAdmission)}\n`);
  await mkdir(path.join(release, "current-station-line-accessibility"), { recursive: true });
  await writeFile(path.join(release, "candidate-build-spec.json"), candidateBytes);
  await writeFile(path.join(release, "current-station-line-accessibility/station-line-input.json"), previousBytes);
  await writeFile(path.join(release, "current-capital-facility-source-admission.json"), facilityBytes);
  return {
    root,
    previousSourceSet,
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
