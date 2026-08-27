import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  activeFacilitySnapshotObservedAt,
  facilityDerivedIdentityRebindState,
  validateFacilityDerivedIdentityRebind,
  validateCurrentPublicRouteMapReplacementProof,
} from "./rebind-current-active-facility-derived-identity.mjs";
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

test("FACILITY derived identity는 동일 candidate의 source set·admission digest가 함께 바뀐 rebind만 허용한다", () => {
  const previous = { candidate: { candidateId: "previous", sourceSnapshotSetHash: "a".repeat(64) }, admissionDigest: "b".repeat(64) };
  const next = { candidate: { candidateId: "previous", sourceSnapshotSetHash: "c".repeat(64) }, admissionDigest: "d".repeat(64) };
  assert.doesNotThrow(() => validateFacilityDerivedIdentityRebind(previous, next, Buffer.from("before"), Buffer.from("after")));
  assert.doesNotThrow(() => validateFacilityDerivedIdentityRebind(previous, previous, Buffer.from("same"), Buffer.from("same")));
  assert.throws(() => validateFacilityDerivedIdentityRebind(previous, { ...next, candidate: { ...next.candidate, candidateId: "next" } }, Buffer.from("before"), Buffer.from("after")), /derived identity rebind mismatch/);
  assert.throws(() => validateFacilityDerivedIdentityRebind(previous, { ...previous, admissionDigest: "d".repeat(64) }, Buffer.from("before"), Buffer.from("after")), /derived identity rebind mismatch/);
  assert.throws(() => validateFacilityDerivedIdentityRebind(previous, { ...previous, candidate: { ...previous.candidate, sourceSnapshotSetHash: "c".repeat(64) } }, Buffer.from("before"), Buffer.from("after")), /derived identity rebind mismatch/);
  assert.throws(() => validateFacilityDerivedIdentityRebind(previous, previous, Buffer.from("before"), Buffer.from("after")), /same-state derived identity drift/);
});
