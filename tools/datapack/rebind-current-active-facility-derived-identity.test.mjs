import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  activeFacilitySnapshotObservedAt,
  buildCurrentActiveFacilityDerivedIdentityOutput,
  buildCurrentActiveFacilityDerivedIdentitySuccessorTransaction,
  facilityDerivedIdentityRebindState,
  rebindCurrentActiveFacilityDerivedIdentity,
  validateFacilityDerivedIdentityRebind,
  validateFacilityProtectedSemanticIdentity,
  validateCurrentPublicRouteMapReplacementProof,
} from "./rebind-current-active-facility-derived-identity.mjs";
import { sha256 } from "./lib/manifest-validation.mjs";
const ROOT = path.resolve(import.meta.dirname, "../..");

test("current route-map proof는 two-hop same-source current head에서 유일한 replacement ancestor를 요구한다", async () => {
  const root = ROOT;
  const readJson = async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"));
  const [candidate, inventory, snapshots, pack] = await Promise.all([
    readJson("tools/datapack/release/candidate-build-spec.json"),
    readJson("tools/datapack/source-inventory.json"),
    readJson("tools/datapack/release/source-snapshots.json"),
    readJson("tools/datapack/release/capital-production-canonical-pack.json"),
  ]);
  const selected = candidate.sourceSnapshots.find(({ sourceId }) => sourceId === "seoul-metro-route-map-positions");
  const currentHead = snapshots.find(({ snapshotId }) => snapshotId === selected.snapshotId);
  const marker = snapshots.find(({ snapshotId }) => snapshotId === currentHead.previousSnapshotId);
  const twoHopHead = {
    ...structuredClone(currentHead),
    snapshotId: "seoul-metro-route-map-positions-current-20260826T035408252Z",
    previousSnapshotId: currentHead.snapshotId,
    retrievedAt: "2026-08-26T03:54:08.252Z",
  };
  snapshots.push(twoHopHead);
  selected.snapshotId = twoHopHead.snapshotId;
  candidate.sourceSnapshotIds = candidate.sourceSnapshotIds.map((snapshotId) =>
    snapshotId === currentHead.snapshotId ? twoHopHead.snapshotId : snapshotId,
  );
  const admission = inventory.sources.find(({ id }) => id === "seoul-metro-route-map-positions").routeMapAdmissionEvidence.currentLayoutAdmission;
  admission.positionSnapshotId = twoHopHead.snapshotId;
  admission.snapshotPath = `tools/datapack/sources/${twoHopHead.snapshotId}.json`;
  admission.rawSha256 = twoHopHead.rawSha256;
  admission.contentSha256 = twoHopHead.contentSha256;
  admission.layoutArtifactSha256 = twoHopHead.routeMapLayoutEvidence.layoutArtifactSha256;
  const routeMap = pack.packs.find(({ id }) => id === "capital");
  for (const row of routeMap.routeMapPositions.filter(({ sourceId }) => sourceId === "seoul-metro-route-map-positions")) {
    row.sourceSnapshotId = twoHopHead.snapshotId;
    row.evidenceHash = twoHopHead.routeMapLayoutEvidence.layoutArtifactSha256;
  }
  assert.doesNotThrow(() => validateCurrentPublicRouteMapReplacementProof(candidate, inventory, snapshots, pack));
  for (const mutate of [
    (value) => { value.candidate.sourceSnapshots.push({ ...selected }); },
    (value) => { delete value.marker.projectionMigration; },
    (value) => { value.currentHead.projectionMigration = structuredClone(value.marker.projectionMigration); },
    (value) => { value.marker.projectionMigration.replacedSourceId = "wrong-source"; },
    (value) => { value.inventory.sources.find(({ id }) => id === "seoul-metro-route-map-positions").routeMapAdmissionEvidence.currentLayoutAdmission.positionSnapshotId = "wrong-snapshot"; },
  ]) {
    const value = { candidate: structuredClone(candidate), inventory: structuredClone(inventory), snapshots: structuredClone(snapshots), pack: structuredClone(pack) };
    value.currentHead = value.snapshots.find(({ snapshotId }) => snapshotId === currentHead.snapshotId);
    value.marker = value.snapshots.find(({ snapshotId }) => snapshotId === marker.snapshotId);
    mutate(value);
    assert.throws(() => validateCurrentPublicRouteMapReplacementProof(value.candidate, value.inventory, value.snapshots, value.pack), /current public route-map|must be exactly one|SOURCE_LINEAGE_BROKEN/i);
  }
});

test("FACILITY rebind source clock는 active snapshot observedAt만 사용한다", () => {
  assert.equal(activeFacilitySnapshotObservedAt(Buffer.from(JSON.stringify({
    capturedAt: "2026-08-16T01:56:19.375Z",
    observedAt: "2026-08-16T01:56:19.375Z",
  }))), "2026-08-16T01:56:19.375Z");
  assert.throws(() => activeFacilitySnapshotObservedAt(Buffer.from(JSON.stringify({
    capturedAt: "2026-08-16T02:00:00.000Z",
    observedAt: "2026-08-16T01:56:19.375Z",
  }))), /snapshot time proof mismatch/);
});

test("exactly-current admission은 check·normal 모두 write 없이 no-op이고 transition만 rebind한다", () => {
  const current = { bytes: Buffer.from("exact"), prestate: Buffer.from("exact") };
  assert.equal(facilityDerivedIdentityRebindState(current), false);
  assert.equal(facilityDerivedIdentityRebindState(current, { check: true }), false);

  const transition = { bytes: Buffer.from("next"), prestate: Buffer.from("previous") };
  assert.equal(facilityDerivedIdentityRebindState(transition), true);
  assert.throws(() => facilityDerivedIdentityRebindState(transition, { check: true }), /derived identity drift/);
});

test("FACILITY derived identity는 candidate binding 또는 observedAt transition만 허용한다", () => {
  const previous = {
    observedAt: "2026-08-16T01:56:19.375Z",
    candidate: { candidateId: "previous", sourceSnapshotSetHash: "a".repeat(64) },
    admissionDigest: "b".repeat(64),
  };
  const sourceSetTransition = { ...previous, candidate: { candidateId: "previous", sourceSnapshotSetHash: "c".repeat(64) }, admissionDigest: "d".repeat(64) };
  const candidateTransition = { ...previous, candidate: { candidateId: "next", sourceSnapshotSetHash: "a".repeat(64) }, admissionDigest: "d".repeat(64) };
  const observedAtTransition = { ...previous, observedAt: "2026-08-16T01:56:20.375Z", admissionDigest: "d".repeat(64) };
  assert.doesNotThrow(() => validateFacilityDerivedIdentityRebind(previous, sourceSetTransition, Buffer.from("before"), Buffer.from("after")));
  assert.doesNotThrow(() => validateFacilityDerivedIdentityRebind(previous, candidateTransition, Buffer.from("before"), Buffer.from("after")));
  assert.doesNotThrow(() => validateFacilityDerivedIdentityRebind(previous, observedAtTransition, Buffer.from("before"), Buffer.from("after")));
  assert.doesNotThrow(() => validateFacilityDerivedIdentityRebind(previous, previous, Buffer.from("same"), Buffer.from("same")));
  assert.throws(() => validateFacilityDerivedIdentityRebind(previous, { ...previous, admissionDigest: "d".repeat(64) }, Buffer.from("before"), Buffer.from("after")), /same-state derived identity drift/);
  assert.throws(() => validateFacilityDerivedIdentityRebind(previous, { ...previous, candidate: { ...previous.candidate, sourceSnapshotSetHash: "c".repeat(64) } }, Buffer.from("before"), Buffer.from("after")), /derived identity rebind mismatch/);
  assert.throws(() => validateFacilityDerivedIdentityRebind(previous, previous, Buffer.from("before"), Buffer.from("after")), /same-state derived identity drift/);
});

test("FACILITY protected semantics는 object key order를 무시하고 값과 행 순서는 고정한다", () => {
  const previous = {
    sourceIdentity: { sourceId: "kric", snapshotId: "snapshot" },
    stationLineProviderMappingSha256: "a".repeat(64),
    denominatorRows: [{ stationId: "a", lineId: "1" }, { stationId: "b", lineId: "2" }],
    denominatorStateSummary: { VERIFIED_PRESENT: 2, VERIFIED_ABSENT: 0 },
    cells: [{ stationId: "a", state: "PRESENT" }, { stationId: "b", state: "ABSENT" }],
    cellStateSummary: { ADMITTED_FACILITY_PRESENT: 1, ADMITTED_FACILITY_ABSENT: 1 },
    materializerEvidenceRows: [{ stationId: "a", evidenceState: "PRESENT" }],
    decision: "GO",
  };
  const reorderedObjectKeys = {
    ...structuredClone(previous),
    sourceIdentity: { snapshotId: "snapshot", sourceId: "kric" },
    denominatorStateSummary: { VERIFIED_ABSENT: 0, VERIFIED_PRESENT: 2 },
  };
  assert.doesNotThrow(() => validateFacilityProtectedSemanticIdentity(previous, reorderedObjectKeys));

  const valueMutation = structuredClone(reorderedObjectKeys);
  valueMutation.cells[0].state = "ABSENT";
  assert.throws(() => validateFacilityProtectedSemanticIdentity(previous, valueMutation), /semantic identity changed/);

  const rowOrderMutation = structuredClone(reorderedObjectKeys);
  rowOrderMutation.denominatorRows.reverse();
  assert.throws(() => validateFacilityProtectedSemanticIdentity(previous, rowOrderMutation), /semantic identity changed/);
});

test("tracked admission은 current candidate로 rebind되고 protected semantics를 보존한다", async () => {
  const output = await buildCurrentActiveFacilityDerivedIdentityOutput({ repositoryRoot: ROOT });
  const previous = JSON.parse(output.prestate.toString("utf8"));
  const next = JSON.parse(output.bytes.toString("utf8"));
  assert.doesNotThrow(() => validateFacilityProtectedSemanticIdentity(previous, next));
  assert.doesNotThrow(() => validateFacilityDerivedIdentityRebind(previous, next, output.prestate, output.bytes));

  const mutation = structuredClone(next);
  mutation.materializerEvidenceRows[0].evidenceState = "UNVERIFIED_EVIDENCE_BLOCKED";
  assert.throws(() => validateFacilityProtectedSemanticIdentity(previous, mutation), /semantic identity changed/);
});

test("FACILITY rebind는 immutable marker를 보존한 successor create-once transaction을 준비한다", async (t) => {
  const root = await temporaryRepository(t);
  await restorePredecessorFacilityState(root);
  await assert.rejects(
    buildCurrentActiveFacilityDerivedIdentitySuccessorTransaction({
      repositoryRoot: root,
      allowedPredecessorSourceIds: [
        "kric-station-convenience-standard",
        "seoul-metro-accessibility",
      ],
    }),
    /requires terminal successor replacement/,
  );
  const transaction = await buildCurrentActiveFacilityDerivedIdentitySuccessorTransaction({ repositoryRoot: root });
  assert.ok(transaction.base?.bytes.length > 0);
  assert.equal(transaction.facility.relative, "tools/datapack/release/current-capital-facility-source-admission.json");
  assert.equal(transaction.successor.relative, "tools/datapack/release/current-capital-accessibility-transition-successor.json");
  const successor = JSON.parse(transaction.successor.bytes);
  assert.equal(successor.supersededTransition.sha256, sha256(transaction.base.bytes));
  assert.equal(successor.previousFacilityAdmission.sha256, sha256(transaction.facility.prestate));
  assert.notDeepEqual(transaction.facility.bytes, transaction.facility.prestate);
});

test("existing successor 검증은 FACILITY prestate와 ledger lineage를 전달한다", () => {
  const source = buildCurrentActiveFacilityDerivedIdentitySuccessorTransaction.toString();
  const existingValidation = source.slice(
    source.indexOf("const expected = buildCurrentCapitalAccessibilityTransitionSuccessor"),
    source.indexOf("if (canonicalJson(existing)"),
  );
  assert.match(existingValidation, /currentFacilityBytes: facility\.prestate/u);
  assert.match(existingValidation, /currentLedger: ledger\.value/u);
});

test("FACILITY와 successor는 한 transaction에서 성공하거나 함께 원복된다", async (t) => {
  const root = await temporaryRepository(t);
  await restorePredecessorFacilityState(root);
  const basePath = path.join(root, "tools/datapack/release/current-capital-accessibility-transition.json");
  const facilityPath = path.join(root, "tools/datapack/release/current-capital-facility-source-admission.json");
  const successorPath = path.join(root, "tools/datapack/release/current-capital-accessibility-transition-successor.json");
  const [baseBefore, facilityBefore] = await Promise.all([readFile(basePath), readFile(facilityPath)]);

  await assert.rejects(
    rebindCurrentActiveFacilityDerivedIdentity({
      repositoryRoot: root,
      failAfter: async ({ stage }) => {
        if (stage === "successor") throw new Error("injected successor transaction failure");
      },
    }),
    /injected successor transaction failure/,
  );
  assert.deepEqual(await readFile(basePath), baseBefore);
  assert.deepEqual(await readFile(facilityPath), facilityBefore);
  await assert.rejects(readFile(successorPath), { code: "ENOENT" });

  const result = await rebindCurrentActiveFacilityDerivedIdentity({ repositoryRoot: root });
  assert.equal(result.changed, true);
  assert.deepEqual(await readFile(basePath), baseBefore);
  assert.notDeepEqual(await readFile(facilityPath), facilityBefore);
  assert.equal(sha256(await readFile(successorPath)), result.successorSha256);
});

test("terminal staging은 검증된 기존 successor를 exact-prestate로 교체하고 함께 원복한다", async (t) => {
  const root = await temporaryRepository(t);
  const successorPath = path.join(root, "tools/datapack/release/current-capital-accessibility-transition-successor.json");
  const existingSuccessor = await readFile(successorPath);
  await restorePredecessorFacilityState(root);
  await writeFile(successorPath, existingSuccessor, { flag: "wx" });
  const facilityPath = path.join(root, "tools/datapack/release/current-capital-facility-source-admission.json");
  const facilityBefore = await readFile(facilityPath);

  await assert.rejects(
    rebindCurrentActiveFacilityDerivedIdentity({ repositoryRoot: root }),
    /successor already exists/,
  );
  await assert.rejects(
    rebindCurrentActiveFacilityDerivedIdentity({
      repositoryRoot: root,
      replaceExistingSuccessor: true,
      failAfter: async ({ stage }) => {
        if (stage === "successor") throw new Error("injected terminal successor failure");
      },
    }),
    /injected terminal successor failure/,
  );
  assert.deepEqual(await readFile(facilityPath), facilityBefore);
  assert.deepEqual(await readFile(successorPath), existingSuccessor);

  const result = await rebindCurrentActiveFacilityDerivedIdentity({
    repositoryRoot: root,
    replaceExistingSuccessor: true,
  });
  assert.equal(result.changed, true);
  assert.notDeepEqual(await readFile(facilityPath), facilityBefore);
  assert.equal(sha256(await readFile(successorPath)), result.successorSha256);
});

async function temporaryRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-facility-successor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of ["tools/datapack/release", "tools/datapack/sources"]) {
    await cp(path.join(ROOT, relative), path.join(root, relative), { recursive: true });
  }
  for (const relative of [
    "tools/datapack/nationwide-coverage-targets.json",
    "tools/datapack/source-inventory.json",
    "tools/datapack/source-governance-policy.json",
    "release/product-gates/datapack-freshness-sla.json",
  ]) {
    const destination = path.join(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(ROOT, relative), destination);
  }
  return root;
}

async function restorePredecessorFacilityState(root) {
  const successorPath = path.join(root, "tools/datapack/release/current-capital-accessibility-transition-successor.json");
  const successor = JSON.parse(await readFile(successorPath, "utf8"));
  const previousFacilityBytes = Buffer.from(successor.previousFacilityAdmissionBase64, "base64");
  assert.equal(sha256(previousFacilityBytes), successor.previousFacilityAdmission.sha256);
  await writeFile(
    path.join(root, "tools/datapack/release/current-capital-facility-source-admission.json"),
    previousFacilityBytes,
  );
  await unlink(successorPath);
}
