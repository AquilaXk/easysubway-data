import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import {
  assertFanInSourceFreshnessPolicy,
  buildCurrentFiveRegionSourceFanIn,
  canonicalCurrentFiveRegionSourceFanInJson,
  REPRODUCTION_GOVERNANCE,
  validateCurrentFiveRegionSourceFanIn,
} from "./build-current-five-region-source-fan-in.mjs";
import { carriedAdmissionLineage } from "./lib/carried-admission.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const EVALUATED_AT = "2026-09-03T00:00:00.000Z";
const REGIONS = ["busan", "capital", "daegu", "daejeon", "gwangju"];
const SHA = "a".repeat(64);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function bytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function fixture() {
  const activeLineScopes = REGIONS.map((regionId, index) => ({
    lineId: `line-${index + 1}`,
    operatorId: `operator-${index + 1}`,
    regionId,
  }));
  const targets = {
    schemaVersion: 2,
    artifactKind: "nationwide-datapack-coverage-targets",
    targetVersion: "2026-07-13",
    requiredSourceDomains: [{
      id: "schedule_timetable",
      releaseTier: "LAUNCH_REQUIRED",
      requiredFields: ["trip"],
    }],
    activeLineScopes,
  };
  const requirements = activeLineScopes.map((scope) => ({
    ...scope,
    sourceDomain: "schedule_timetable",
    releaseTier: "LAUNCH_REQUIRED",
    status: "INVENTORY_ADMITTED",
    admittedSourceIds: ["official-five-region-timetable"],
  }));
  const tally = {
    schemaVersion: 1,
    targetVersion: targets.targetVersion,
    launchRequired: { requirements },
    enhancement: { requirements: [] },
  };
  const ownership = {
    schemaVersion: 1,
    targetVersion: targets.targetVersion,
    ownerRules: [{ issue: 454, sourceDomain: "schedule_timetable" }],
  };
  const inventory = {
    sources: [{
      id: "official-five-region-timetable",
      provider: "Official Rail Provider",
      requiredForProductionPack: true,
      productionUseAllowed: true,
      license: {
        commercialUseAllowed: true,
        derivativeWorkAllowed: true,
        redistributionAllowed: true,
      },
      admissionEvidence: {
        decision: "APPROVED",
        sourceId: "official-five-region-timetable",
        snapshotId: "official-five-region-timetable-v1",
        rawSha256: SHA,
        capturedAt: "2026-09-02T00:00:00.000Z",
        freshUntil: "2026-09-04T00:00:00.000Z",
      },
    }],
  };
  const sourceSnapshots = [{
    schemaVersion: 1,
    artifactKind: "official-source-snapshot",
    snapshotId: "official-five-region-timetable-v1",
    sourceId: "official-five-region-timetable",
    provider: "Official Rail Provider",
    retrievedAt: "2026-09-02T00:00:00.000Z",
    rawSha256: SHA,
    rawObjectUri: `oci://namespace/bucket/source/${SHA}.json`,
    previousSnapshotId: null,
    freshnessExpiresAt: "2026-09-04T00:00:00.000Z",
    snapshotStatus: "LOCKED",
    schemaStatus: "PASS",
    licenseStatus: "PASS",
    fetchStatus: "SUCCESS",
    redistributionAllowed: true,
    credentialRedacted: true,
  }];
  const values = { targets, tally, ownership, inventory, sourceSnapshots };
  return {
    ...values,
    inputBytes: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, bytes(value)])),
    evaluatedAt: EVALUATED_AT,
  };
}

test("#687 builds a candidate-independent five-region OCI source fan-in", () => {
  const input = fixture();
  const fanIn = buildCurrentFiveRegionSourceFanIn(input);

  assert.equal(fanIn.schemaVersion, 2);
  assert.equal(fanIn.artifactKind, "current-five-region-source-fan-in");
  assert.equal(fanIn.evaluatedAt, EVALUATED_AT);
  assert.equal(Object.hasOwn(fanIn, "targetVersion"), false);
  assert.equal(Object.hasOwn(fanIn, "regionIds"), false);
  assert.deepEqual(fanIn.scope, {
    targetVersion: input.targets.targetVersion,
    regionIds: REGIONS,
    activeLineScopes: input.targets.activeLineScopes,
    requiredSourceDomains: input.targets.requiredSourceDomains,
  });
  assert.equal(fanIn.selectedSources.length, 1);
  assert.deepEqual(fanIn.selectedSources[0], {
    sourceId: "official-five-region-timetable",
    provider: "Official Rail Provider",
    snapshotId: "official-five-region-timetable-v1",
    rawSha256: SHA,
    rawObjectUri: `oci://namespace/bucket/source/${SHA}.json`,
    freshnessExpiresAt: "2026-09-04T00:00:00.000Z",
    inventoryRecordSha256: fanIn.selectedSources[0].inventoryRecordSha256,
    snapshotRecordSha256: fanIn.selectedSources[0].snapshotRecordSha256,
    licenseRecordSha256: fanIn.selectedSources[0].licenseRecordSha256,
    admissionRecordSha256s: fanIn.selectedSources[0].admissionRecordSha256s,
  });
  assert.match(fanIn.scopeSha256, /^[a-f0-9]{64}$/u);
  assert.match(fanIn.sourceSetSha256, /^[a-f0-9]{64}$/u);
  assert.equal(fanIn.regionalMatrixSha256, fanIn.inputs.tally.sha256);
  assert.match(fanIn.fanInSha256, /^[a-f0-9]{64}$/u);
  assert.equal(fanIn.inputs.targets.sha256, sha256(input.inputBytes.targets));
  assert.equal(fanIn.inputs.sourceSnapshots.sha256, sha256(input.inputBytes.sourceSnapshots));
  assert.equal(validateCurrentFiveRegionSourceFanIn(
    fanIn,
    Buffer.from(`${canonicalCurrentFiveRegionSourceFanInJson(fanIn)}\n`),
  ), fanIn);
  assert.throws(
    () => validateCurrentFiveRegionSourceFanIn({ ...fanIn, evaluatedAt: "2026-09-03T00:00:01.000Z" }),
    /self digest/,
  );
  assert.equal(canonicalCurrentFiveRegionSourceFanInJson(fanIn).includes("candidate"), false);
  assert.equal(canonicalCurrentFiveRegionSourceFanInJson(fanIn).includes("s3://"), false);
  assert.equal(fanIn.scopeSha256, sha256(Buffer.from(canonicalCurrentFiveRegionSourceFanInJson(fanIn.scope))));
  const snapshot = input.sourceSnapshots[0];
  snapshot.normalizedObservationSha256 = sha256("normalized membership");
  const coverage = {
    snapshotId: snapshot.snapshotId, rawSha256: snapshot.rawSha256,
    normalizedObservationSha256: snapshot.normalizedObservationSha256,
  };
  input.inventory.sources[0].membershipCoverageEvidence = coverage;
  input.inputBytes.sourceSnapshots = bytes(input.sourceSnapshots);
  input.inputBytes.inventory = bytes(input.inventory);
  assert.equal(buildCurrentFiveRegionSourceFanIn(input).selectedSources.length, 1);
  for (const key of Object.keys(coverage)) {
    const original = coverage[key];
    coverage[key] = key === "snapshotId" ? "foreign" : sha256(`foreign ${key}`);
    input.inputBytes.inventory = bytes(input.inventory);
    assert.throws(() => buildCurrentFiveRegionSourceFanIn(input), /membership coverage snapshot mismatch/);
    coverage[key] = original;
  }
});

test("native schedule admission binds a production materialization approval without invented approval fields", () => {
  const input = fixture();
  const source = input.inventory.sources[0];
  delete source.admissionEvidence;
  source.capabilities = { schedule: { productionUseAllowed: true } };
  source.scheduleAdmissionEvidence = {
    issue: 454,
    materializer: "tools/datapack/materialize-korail-timetable.mjs",
    verificationTest: "tools/datapack/materialize-korail-timetable.test.mjs",
    snapshotId: input.sourceSnapshots[0].snapshotId,
    snapshotPath: `tools/datapack/sources/${input.sourceSnapshots[0].snapshotId}.json`,
    capturedAt: "2026-09-02T00:00:00.000Z",
    freshUntil: "2026-09-04T00:00:00.000Z",
    rawSha256: SHA,
    rowsSha256: "b".repeat(64),
    topologySourceId: "korail-metropolitan-timetable-file",
    topologySnapshotId: "topology-1",
    topologyContentSha256: "d".repeat(64),
    rowCount: 2,
    departureCount: 2,
    tripCount: 1,
    stopTimeCount: 2,
  };
  input.inputBytes.inventory = bytes(input.inventory);
  assert.doesNotThrow(() => buildCurrentFiveRegionSourceFanIn(input));
  const copy = () => ({ ...structuredClone(input),
    inputBytes: Object.fromEntries(Object.entries(input.inputBytes).map(([key, value]) => [key, Buffer.from(value)])) });

  const missingCapability = copy();
  delete missingCapability.inventory.sources[0].capabilities;
  missingCapability.inputBytes.inventory = bytes(missingCapability.inventory);
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(missingCapability), /admission.*approval/);

  const incomplete = copy();
  delete incomplete.inventory.sources[0].scheduleAdmissionEvidence.rowsSha256;
  incomplete.inputBytes.inventory = bytes(incomplete.inventory);
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(incomplete), /admission.*approval/);

  const badDigest = copy();
  badDigest.inventory.sources[0].scheduleAdmissionEvidence.rawSha256 = "e".repeat(64);
  badDigest.inputBytes.inventory = bytes(badDigest.inventory);
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(badDigest), /admission.*digest/);

  // #929 D1: 등록 evidence freshUntil(수집 +1일)은 창을 줄이지 않는다. 창은 원장 정책 신선도에서 끝난다.
  const shortEvidenceWindow = copy();
  shortEvidenceWindow.inventory.sources[0].scheduleAdmissionEvidence.freshUntil = EVALUATED_AT;
  shortEvidenceWindow.inputBytes.inventory = bytes(shortEvidenceWindow.inventory);
  assert.doesNotThrow(() => buildCurrentFiveRegionSourceFanIn(shortEvidenceWindow));
  const stale = copy();
  stale.sourceSnapshots[0].freshnessExpiresAt = EVALUATED_AT;
  stale.inputBytes.sourceSnapshots = bytes(stale.sourceSnapshots);
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(stale), /snapshot freshness mismatch/);

  const byteDrift = copy();
  byteDrift.inventory.sources[0].scheduleAdmissionEvidence.tripCount = 2;
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(byteDrift), /inventory input bytes/);
});

test("native accessibility admission binds ledger content without generic approval fields", () => {
  const input = fixture();
  const source = input.inventory.sources[0];
  const snapshot = input.sourceSnapshots[0];
  delete source.admissionEvidence;
  source.capabilities = { facility: { productionUseAllowed: true } };
  Object.assign(snapshot, {
    capturedAt: "2026-09-02T00:00:00.000Z",
    contentSha256: "b".repeat(64),
    rowCount: 2,
    coverageCount: 2,
  });
  source.accessibilityAdmissionEvidence = {
    issue: 454,
    materializer: "tools/datapack/materialize-busan-accessibility.mjs",
    verificationTest: "tools/datapack/materialize-busan-accessibility.test.mjs",
    snapshotId: snapshot.snapshotId,
    snapshotPath: `tools/datapack/sources/${snapshot.snapshotId}.json`,
    capturedAt: snapshot.capturedAt,
    freshUntil: "2026-09-04T00:00:00.000Z",
    rawSha256: snapshot.rawSha256,
    rowsSha256: snapshot.contentSha256,
    rowCount: snapshot.rowCount,
    stationCount: snapshot.coverageCount,
    topologySourceId: "busan-route-topology",
    topologySnapshotId: "topology-1",
    topologyContentSha256: "d".repeat(64),
  };
  input.inputBytes.inventory = bytes(input.inventory);
  input.inputBytes.sourceSnapshots = bytes(input.sourceSnapshots);
  assert.doesNotThrow(() => buildCurrentFiveRegionSourceFanIn(input));
  const copy = () => ({ ...structuredClone(input),
    inputBytes: Object.fromEntries(Object.entries(input.inputBytes).map(([key, value]) => [key, Buffer.from(value)])) });

  const rawDrift = copy();
  rawDrift.inventory.sources[0].accessibilityAdmissionEvidence.rawSha256 = "e".repeat(64);
  rawDrift.inputBytes.inventory = bytes(rawDrift.inventory);
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(rawDrift), /admission.*approval/);

  const rowsDrift = copy();
  rowsDrift.inventory.sources[0].accessibilityAdmissionEvidence.rowsSha256 = "e".repeat(64);
  rowsDrift.inputBytes.inventory = bytes(rowsDrift.inventory);
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(rowsDrift), /admission.*approval/);

  const countDrift = copy();
  countDrift.inventory.sources[0].accessibilityAdmissionEvidence.rowCount = 3;
  countDrift.inputBytes.inventory = bytes(countDrift.inventory);
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(countDrift), /admission.*approval/);

  const missingCapability = copy();
  delete missingCapability.inventory.sources[0].capabilities;
  missingCapability.inputBytes.inventory = bytes(missingCapability.inventory);
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(missingCapability), /admission.*approval/);

  const mixedFlag = copy();
  mixedFlag.inventory.sources[0].accessibilityAdmissionEvidence.decision = "APPROVED";
  mixedFlag.inputBytes.inventory = bytes(mixedFlag.inventory);
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(mixedFlag), /admission.*approval/);
});

test("#687 keeps enhancement heads non-blocking until their tier is promoted", () => {
  const unknownTier = fixture();
  unknownTier.targets.requiredSourceDomains[0].releaseTier = "LUNCH_REQUIRED";
  for (const requirement of unknownTier.tally.launchRequired.requirements) {
    requirement.releaseTier = "LUNCH_REQUIRED";
  }
  unknownTier.inputBytes.targets = bytes(unknownTier.targets);
  unknownTier.inputBytes.tally = bytes(unknownTier.tally);
  assert.throws(
    () => buildCurrentFiveRegionSourceFanIn(unknownTier),
    /release tier/,
  );

  const input = fixture();
  input.targets.requiredSourceDomains.push({
    id: "demand_reference",
    releaseTier: "ENHANCEMENT",
    requiredFields: ["demand"],
  });
  input.tally.enhancement.requirements = input.targets.activeLineScopes.map((scope) => ({
    ...scope,
    sourceDomain: "demand_reference",
    releaseTier: "ENHANCEMENT",
    status: "INVENTORY_ADMITTED",
    admittedSourceIds: ["official-five-region-demand"],
  }));
  input.inventory.sources.push({
    id: "official-five-region-demand",
    provider: "Official Demand Provider",
    requiredForProductionPack: true,
    productionUseAllowed: true,
    license: {
      commercialUseAllowed: true,
      derivativeWorkAllowed: true,
      redistributionAllowed: true,
    },
  });
  input.inputBytes.targets = bytes(input.targets);
  input.inputBytes.tally = bytes(input.tally);
  input.inputBytes.inventory = bytes(input.inventory);

  const fanIn = buildCurrentFiveRegionSourceFanIn(input);
  assert.deepEqual(fanIn.selectedSources.map(({ sourceId }) => sourceId), [
    "official-five-region-timetable",
  ]);
  assert.equal(fanIn.regionalMatrixSha256, fanIn.inputs.tally.sha256);

  input.targets.requiredSourceDomains[1].releaseTier = "LAUNCH_REQUIRED";
  for (const requirement of input.tally.enhancement.requirements) {
    requirement.releaseTier = "LAUNCH_REQUIRED";
    input.tally.launchRequired.requirements.push(requirement);
  }
  input.tally.enhancement.requirements = [];
  input.inputBytes.targets = bytes(input.targets);
  input.inputBytes.tally = bytes(input.tally);

  assert.throws(
    () => buildCurrentFiveRegionSourceFanIn(input),
    /terminal snapshot head missing for official-five-region-demand/,
  );
});

test("#687 binds partial tally evidence without selecting an incomplete requirement's source", () => {
  const input = fixture();
  input.inventory.sources.push({ ...input.inventory.sources[0], id: "partial-source" });
  Object.assign(input.tally.launchRequired.requirements[0], {
    status: "MISSING", admittedSourceIds: ["partial-source"],
    admittedFieldCount: 1, requiredFieldCount: 2,
  });
  input.inputBytes.inventory = bytes(input.inventory);
  input.inputBytes.tally = bytes(input.tally);
  const fanIn = buildCurrentFiveRegionSourceFanIn(input);
  assert.deepEqual(fanIn.selectedSources.map(({ sourceId }) => sourceId), ["official-five-region-timetable"]);
  assert.equal(fanIn.regionalMatrixSha256, sha256(input.inputBytes.tally));
  assert.equal(input.tally.launchRequired.requirements[0].status, "MISSING");
});

test("#687 fails closed on ambiguous, non-OCI, stale, or unbound source heads", () => {
  const reduced = fixture();
  reduced.targets.activeLineScopes = reduced.targets.activeLineScopes
    .filter(({ regionId }) => regionId !== "gwangju");
  reduced.tally.launchRequired.requirements = reduced.tally.launchRequired.requirements
    .filter(({ regionId }) => regionId !== "gwangju");
  reduced.inputBytes.targets = bytes(reduced.targets);
  reduced.inputBytes.tally = bytes(reduced.tally);
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(reduced), /five-region scope/);

  const missingStatus = fixture();
  delete missingStatus.tally.launchRequired.requirements[0].status;
  delete missingStatus.tally.launchRequired.requirements[0].admittedSourceIds;
  missingStatus.inputBytes.tally = bytes(missingStatus.tally);
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(missingStatus), /requirement disposition/);

  const ambiguous = fixture();
  ambiguous.sourceSnapshots.push({
    ...ambiguous.sourceSnapshots[0],
    snapshotId: "official-five-region-timetable-branch",
    rawSha256: "b".repeat(64),
  });
  ambiguous.inputBytes.sourceSnapshots = bytes(ambiguous.sourceSnapshots);
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(ambiguous), /terminal snapshot head/);

  const nonOci = fixture();
  nonOci.sourceSnapshots[0].rawObjectUri = "s3://historical/not-current.json";
  nonOci.inputBytes.sourceSnapshots = bytes(nonOci.sourceSnapshots);
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(nonOci), /immutable OCI/);

  const incompleteOci = fixture();
  incompleteOci.sourceSnapshots[0].rawObjectUri = "oci://namespace/bucket";
  incompleteOci.inputBytes.sourceSnapshots = bytes(incompleteOci.sourceSnapshots);
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(incompleteOci), /immutable OCI/);

  const stale = fixture();
  stale.sourceSnapshots[0].freshnessExpiresAt = EVALUATED_AT;
  stale.inputBytes.sourceSnapshots = bytes(stale.sourceSnapshots);
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(stale), /freshness/);

  const future = fixture();
  future.sourceSnapshots[0].retrievedAt = "2026-09-03T00:00:00.001Z";
  future.inputBytes.sourceSnapshots = bytes(future.sourceSnapshots);
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(future), /future/);

  const unboundAdmission = fixture();
  unboundAdmission.inventory.sources[0].admissionEvidence.snapshotId = "another-snapshot";
  unboundAdmission.inputBytes.inventory = bytes(unboundAdmission.inventory);
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(unboundAdmission), /admission.*snapshot/);

  const unboundDigest = fixture();
  unboundDigest.inventory.sources[0].admissionEvidence.rawSha256 = "b".repeat(64);
  unboundDigest.inputBytes.inventory = bytes(unboundDigest.inventory);
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(unboundDigest), /admission.*digest/);

  const noAffirmativeAdmission = fixture();
  delete noAffirmativeAdmission.inventory.sources[0].admissionEvidence.decision;
  noAffirmativeAdmission.inputBytes.inventory = bytes(noAffirmativeAdmission.inventory);
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(noAffirmativeAdmission), /admission.*approval/);

  // #929 D1: 등록 evidence freshUntil이 지나도 원장 정책 신선도 안이면 통과하고, 원장 신선도가 지나면 실패한다.
  const shortEvidenceWindow = fixture();
  shortEvidenceWindow.inventory.sources[0].admissionEvidence.freshUntil = EVALUATED_AT;
  shortEvidenceWindow.inputBytes.inventory = bytes(shortEvidenceWindow.inventory);
  assert.doesNotThrow(() => buildCurrentFiveRegionSourceFanIn(shortEvidenceWindow));
  const staleAdmission = fixture();
  staleAdmission.sourceSnapshots[0].freshnessExpiresAt = EVALUATED_AT;
  staleAdmission.inputBytes.sourceSnapshots = bytes(staleAdmission.sourceSnapshots);
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(staleAdmission), /snapshot freshness mismatch/);

  const futureAdmission = fixture();
  futureAdmission.inventory.sources[0].admissionEvidence.capturedAt = "2026-09-03T00:00:00.001Z";
  futureAdmission.inputBytes.inventory = bytes(futureAdmission.inventory);
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(futureAdmission), /admission.*future/);

  const notRequired = fixture();
  notRequired.inventory.sources[0].requiredForProductionPack = false;
  notRequired.inputBytes.inventory = bytes(notRequired.inventory);
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(notRequired), /production source/);

  const exposedCredential = fixture();
  exposedCredential.sourceSnapshots[0].credentialRedacted = false;
  exposedCredential.inputBytes.sourceSnapshots = bytes(exposedCredential.sourceSnapshots);
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(exposedCredential), /immutable OCI/);

  const unbound = fixture();
  unbound.inventory.sources = [];
  unbound.inputBytes.inventory = bytes(unbound.inventory);
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(unbound), /inventory source/);
});

test("#687 CLI creates one canonical output and never overwrites it", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "five-region-source-fan-in-"));
  const input = fixture();
  const paths = {};
  for (const [name, value] of Object.entries(input.inputBytes)) {
    const inputPath = path.join(temporary, `${name}.json`);
    await writeFile(inputPath, value);
    paths[name] = inputPath;
  }
  const output = path.join(temporary, "fan-in.json");
  const policyPath = path.join(temporary, "freshness-policy.json");
  await writeFile(policyPath, bytes(policyFor(buildCurrentFiveRegionSourceFanIn(input))));
  const governancePath = path.join(temporary, "governance-policy.json");
  await writeFile(governancePath, bytes({ sources: [] }));
  const args = [
    path.join(ROOT, "tools/datapack/build-current-five-region-source-fan-in.mjs"),
    "--freshness-policy", policyPath,
    "--governance-policy", governancePath,
    "--targets", paths.targets,
    "--tally", paths.tally,
    "--ownership", paths.ownership,
    "--inventory", paths.inventory,
    "--source-snapshots", paths.sourceSnapshots,
    "--evaluated-at", EVALUATED_AT,
    "--output", output,
  ];
  const first = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  const expected = buildCurrentFiveRegionSourceFanIn(input);
  assert.deepEqual(await readFile(output), Buffer.from(`${canonicalCurrentFiveRegionSourceFanInJson(expected)}\n`));
  assert.equal((await stat(output)).mode & 0o777, 0o600);

  const second = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.notEqual(second.status, 0);
  assert.deepEqual(await readFile(output), Buffer.from(`${canonicalCurrentFiveRegionSourceFanInJson(expected)}\n`));
});

function registeredHeadFixture(sourceId, { evaluatedAt, freshnessExpiresAt, serviceEffectiveUntil, admissionFreshUntil }) {
  const input = fixture();
  const previous = input.sourceSnapshots[0];
  const previousId = `${sourceId}-v1`;
  const headId = `${sourceId}-v2`;
  const headSha = "b".repeat(64);
  for (const row of input.tally.launchRequired.requirements) row.admittedSourceIds = [sourceId];
  input.inventory.sources[0].id = sourceId;
  input.inventory.sources[0].admissionEvidence = {
    decision: "APPROVED",
    sourceId,
    snapshotId: headId,
    rawSha256: headSha,
    capturedAt: "2026-09-30T00:00:00.000Z",
    ...(admissionFreshUntil === undefined ? {} : { freshUntil: admissionFreshUntil }),
  };
  input.sourceSnapshots = [
    { ...previous, sourceId, snapshotId: previousId },
    {
      ...previous,
      sourceId,
      snapshotId: headId,
      previousSnapshotId: previousId,
      retrievedAt: "2026-09-30T00:00:00.000Z",
      rawSha256: headSha,
      rawObjectUri: `oci://namespace/bucket/source/${headSha}.json`,
      freshnessExpiresAt,
      ...(serviceEffectiveUntil === undefined ? {} : { serviceEffectiveUntil }),
    },
  ];
  input.evaluatedAt = evaluatedAt;
  for (const key of ["tally", "inventory", "sourceSnapshots"]) input.inputBytes[key] = bytes(input[key]);
  return input;
}

test("#862 a newly registered head is judged by its ledger freshness, not a per-source constant", () => {
  for (const sourceId of ["capital-route-topology", "korail-metropolitan-timetable-file"]) {
    const fresh = registeredHeadFixture(sourceId, {
      evaluatedAt: "2026-10-01T00:00:00.000Z",
      freshnessExpiresAt: "2026-10-01T00:00:00.001Z",
      admissionFreshUntil: "2026-10-01T00:00:00.001Z",
    });
    const fanIn = buildCurrentFiveRegionSourceFanIn(fresh);
    assert.equal(fanIn.selectedSources[0].snapshotId, `${sourceId}-v2`);
    assert.equal(fanIn.selectedSources[0].freshnessExpiresAt, "2026-10-01T00:00:00.001Z");

    const expired = registeredHeadFixture(sourceId, {
      evaluatedAt: "2026-09-10T00:00:00.000Z",
      freshnessExpiresAt: "2026-09-10T00:00:00.000Z",
      admissionFreshUntil: "2026-09-12T00:00:00.000Z",
    });
    expired.sourceSnapshots[1].retrievedAt = "2026-09-09T00:00:00.000Z";
    expired.inventory.sources[0].admissionEvidence.capturedAt = "2026-09-09T00:00:00.000Z";
    for (const key of ["inventory", "sourceSnapshots"]) expired.inputBytes[key] = bytes(expired[key]);
    assert.throws(() => buildCurrentFiveRegionSourceFanIn(expired), new RegExp(`snapshot freshness mismatch for ${sourceId}`));
  }
});

test("#862 provider validity cannot extend a head beyond its ledger freshness", () => {
  const input = registeredHeadFixture("kric-subway-timetable", {
    evaluatedAt: "2026-10-01T00:00:00.000Z",
    freshnessExpiresAt: "2026-09-30T12:00:00.000Z",
    serviceEffectiveUntil: "2026-12-31T00:00:00.000Z",
  });
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(input), /snapshot freshness mismatch for kric-subway-timetable/);
});

// #929 D1(QA 결정 2026-10-04): 등록 확인 창의 끝은 원천별 정책 신선도(원장 head freshnessExpiresAt)다.
// 이 테스트는 #862에서 "등록 evidence freshUntil(수집 +1일)이 지나면 실패"를 고정했다. 그 P1D 창이 접근성(P90D)·
// 지역 시간표(P30D) 원천까지 하루마다 후보를 막아 QA가 정책 기간으로 바꿨으므로, 같은 입력이 이제 통과해야 한다.
test("#929 D1 an expired registration +1 day window no longer blocks a head inside its policy freshness", () => {
  for (const sourceId of [
    "capital-route-topology", "korail-metropolitan-timetable-file",
    "kric-station-convenience-standard", "seoul-metro-accessibility",
  ]) {
    const input = registeredHeadFixture(sourceId, {
      evaluatedAt: "2026-10-01T00:00:00.000Z",
      freshnessExpiresAt: "2026-12-01T00:00:00.000Z",
      admissionFreshUntil: "2026-10-01T00:00:00.000Z",
    });
    const fanIn = buildCurrentFiveRegionSourceFanIn(input);
    assert.equal(fanIn.selectedSources[0].sourceId, sourceId);
    assert.equal(fanIn.selectedSources[0].freshnessExpiresAt, "2026-12-01T00:00:00.000Z");
  }
});

test("#929 D1 the admission window still ends exactly at the policy freshness", () => {
  const atExpiry = registeredHeadFixture("seoul-metro-accessibility", {
    evaluatedAt: "2026-12-01T00:00:00.000Z",
    freshnessExpiresAt: "2026-12-01T00:00:00.000Z",
    admissionFreshUntil: "2027-01-01T00:00:00.000Z",
  });
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(atExpiry), /freshness mismatch for seoul-metro-accessibility/);
  const futureObservation = registeredHeadFixture("seoul-metro-accessibility", {
    evaluatedAt: "2026-09-29T00:00:00.000Z",
    freshnessExpiresAt: "2026-12-01T00:00:00.000Z",
  });
  futureObservation.sourceSnapshots[1].retrievedAt = "2026-09-28T00:00:00.000Z";
  futureObservation.inputBytes.sourceSnapshots = bytes(futureObservation.sourceSnapshots);
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(futureObservation), /admission future observation mismatch for seoul-metro-accessibility/);
});

function policyFor(fanIn, extraClasses = []) {
  return {
    sourceClasses: [
      // fixture 원장 head는 retrievedAt 2026-09-02 + P2D = 2026-09-04가 정책 상한이다.
      { id: "fixture_class", sourceIds: fanIn.selectedSources.map(({ sourceId }) => sourceId), basisField: "retrievedAt", reverificationCadence: "P2D" },
      ...extraClasses,
    ],
  };
}

test("#929 D1 every selected source must have exactly one freshness policy class", () => {
  const input = fixture();
  const fanIn = buildCurrentFiveRegionSourceFanIn(input);
  const sourceId = fanIn.selectedSources[0].sourceId;
  const { sourceSnapshots } = input;
  assert.doesNotThrow(() => assertFanInSourceFreshnessPolicy({ fanIn, freshnessPolicy: policyFor(fanIn), sourceSnapshots }));
  assert.throws(() => assertFanInSourceFreshnessPolicy({ fanIn, freshnessPolicy: { sourceClasses: [] }, sourceSnapshots }),
    new RegExp(`fan-in freshness policy missing for ${sourceId}`));
  assert.throws(() => assertFanInSourceFreshnessPolicy({
    fanIn, freshnessPolicy: policyFor(fanIn, [{ id: "other", sourceIds: [sourceId] }]), sourceSnapshots,
  }), new RegExp(`fan-in freshness policy ambiguous for ${sourceId}`));
  assert.throws(() => assertFanInSourceFreshnessPolicy({ fanIn, freshnessPolicy: {}, sourceSnapshots }), /fan-in freshness policy shape mismatch/);
});

// #930 리뷰 F1: 창의 끝으로 쓰는 원장 freshnessExpiresAt이 "등록 기준 시각 + 정책 기간"을 넘으면 창이 부풀려진 것이다.
test("#930 F1 a ledger freshness beyond the policy-derived ceiling fails the fan-in policy check", () => {
  const input = fixture();
  input.sourceSnapshots[0].freshnessExpiresAt = "2026-09-04T00:00:00.001Z";
  input.inputBytes.sourceSnapshots = bytes(input.sourceSnapshots);
  const fanIn = buildCurrentFiveRegionSourceFanIn(input);
  const sourceId = fanIn.selectedSources[0].sourceId;
  assert.throws(() => assertFanInSourceFreshnessPolicy({ fanIn, freshnessPolicy: policyFor(fanIn), sourceSnapshots: input.sourceSnapshots }),
    new RegExp(`fan-in freshness exceeds policy for ${sourceId}: 2026-09-04T00:00:00\\.001Z > 2026-09-04T00:00:00\\.000Z`));
  const exact = fixture();
  const exactFanIn = buildCurrentFiveRegionSourceFanIn(exact);
  assert.doesNotThrow(() => assertFanInSourceFreshnessPolicy({ fanIn: exactFanIn, freshnessPolicy: policyFor(exactFanIn), sourceSnapshots: exact.sourceSnapshots }));
  assert.throws(() => assertFanInSourceFreshnessPolicy({ fanIn: exactFanIn, freshnessPolicy: policyFor(exactFanIn) }),
    /fan-in freshness policy needs the source snapshot ledger/);
});

test("#929 D1 the fan-in CLI refuses to write without a policy class for every selected source", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "five-region-source-fan-in-policy-"));
  const input = fixture();
  const paths = {};
  for (const [name, value] of Object.entries(input.inputBytes)) {
    paths[name] = path.join(temporary, `${name}.json`);
    await writeFile(paths[name], value);
  }
  const policyPath = path.join(temporary, "freshness-policy.json");
  await writeFile(policyPath, bytes({ sourceClasses: [] }));
  const governancePath = path.join(temporary, "governance-policy.json");
  await writeFile(governancePath, bytes({ sources: [] }));
  const output = path.join(temporary, "fan-in.json");
  const base = [
    path.join(ROOT, "tools/datapack/build-current-five-region-source-fan-in.mjs"),
    "--governance-policy", governancePath,
    "--targets", paths.targets, "--tally", paths.tally, "--ownership", paths.ownership,
    "--inventory", paths.inventory, "--source-snapshots", paths.sourceSnapshots,
    "--evaluated-at", EVALUATED_AT, "--output", output,
  ];
  const withoutPolicy = spawnSync(process.execPath, base, { encoding: "utf8" });
  assert.notEqual(withoutPolicy.status, 0);
  const missingClass = spawnSync(process.execPath, [...base, "--freshness-policy", policyPath], { encoding: "utf8" });
  assert.notEqual(missingClass.status, 0);
  assert.match(missingClass.stderr, /fan-in freshness policy missing for/);
  await assert.rejects(stat(output), { code: "ENOENT" });
});

// #1289: #1276의 무인 갱신은 새 snapshot에 사람 승인(admissionEvidence)을 이월한다. 승인은 옛 snapshot을 가리키고,
// 새 head에는 native 형식이 아닌 scheduleAdmissionEvidence만 묶인다. 실제 main의 KRIC 역별 시간표 상태를 그대로 옮긴 fixture다.
const CARRY_SOURCE_ID = "kric-subway-timetable-station-lines";
const CARRY_APPROVED_ID = `${CARRY_SOURCE_ID}-20261003`;
const CARRY_HEAD_ID = `${CARRY_SOURCE_ID}-20261016`;
const CARRY_APPROVED_RAW = "c".repeat(64);
const CARRY_HEAD_RAW = "b".repeat(64);
const CARRY_SCHEMA = "e".repeat(64);
const CARRY_TERMS = "f".repeat(64);

function carriedForwardFixture({ intermediateSnapshots = 0 } = {}) {
  const input = fixture();
  const [template] = input.sourceSnapshots;
  for (const row of input.tally.launchRequired.requirements) row.admittedSourceIds = [CARRY_SOURCE_ID];
  const ledgerRow = (snapshotId, previousSnapshotId, rawSha256) => ({
    ...template, sourceId: CARRY_SOURCE_ID, snapshotId, previousSnapshotId, rawSha256,
    rawObjectUri: `oci://namespace/bucket/source/${rawSha256}.json`, schemaFingerprint: CARRY_SCHEMA,
  });
  const middleIds = Array.from({ length: intermediateSnapshots }, (_, index) => `${CARRY_SOURCE_ID}-middle-${index}`);
  const rows = [CARRY_APPROVED_ID, ...middleIds, CARRY_HEAD_ID];
  input.sourceSnapshots = rows.map((snapshotId, index) => ledgerRow(
    snapshotId, index === 0 ? null : rows[index - 1],
    snapshotId === CARRY_APPROVED_ID ? CARRY_APPROVED_RAW : snapshotId === CARRY_HEAD_ID ? CARRY_HEAD_RAW : sha256(snapshotId)));
  const source = input.inventory.sources[0];
  source.id = CARRY_SOURCE_ID;
  source.capabilities = { schedule: { productionUseAllowed: true } };
  source.admissionEvidence = {
    candidateId: CARRY_SOURCE_ID, sourceId: CARRY_SOURCE_ID, catalogProviderId: "provider:kric-subway-timetable",
    snapshotId: CARRY_APPROVED_ID, decision: "APPROVED", approvedBy: "data-release-authority",
    approvedAt: "2026-08-20T00:00:00.000Z", rawSha256: CARRY_APPROVED_RAW, schemaFingerprint: CARRY_SCHEMA,
    adminReviewRecordHash: "d".repeat(64), licenseEvidenceHash: CARRY_TERMS,
  };
  source.scheduleAdmissionEvidence = {
    issue: 903, materializer: "tools/datapack/lib/kric-station-timetable-api-trips.mjs",
    verificationTest: "tools/datapack/register-kric-station-timetables.test.mjs", snapshotId: CARRY_HEAD_ID,
    snapshotPath: `tools/datapack/sources/${CARRY_HEAD_ID}.json`, capturedAt: "2026-09-02T00:00:00.000Z",
    freshUntil: "2026-10-02T00:00:00.000Z", lineIds: ["line-1"], tripCount: 2, stopTimeCount: 4,
    rawSha256: CARRY_HEAD_RAW, tripsSha256: "1".repeat(64), contentSha256: "2".repeat(64),
  };
  input.governancePolicy = carriedGovernance();
  return reserialized(input);
}

function reserialized(input) {
  for (const key of ["tally", "inventory", "sourceSnapshots"]) input.inputBytes[key] = bytes(input[key]);
  return input;
}

function carriedMutation(mutate, options) {
  const input = carriedForwardFixture(options);
  mutate(input);
  return reserialized(input);
}

const carriedGovernance = (overrides = {}) => ({
  sources: [{ sourceId: CARRY_SOURCE_ID, licenseReview: { status: "APPROVED", termsHash: CARRY_TERMS, nextReviewAt: "2027-07-09T00:00:00Z", ...overrides } }],
});

test("#1289 a verified carried-forward approval admits the new head and records its lineage", () => {
  const input = carriedForwardFixture();
  const [head] = buildCurrentFiveRegionSourceFanIn(input).selectedSources;
  assert.equal(head.snapshotId, CARRY_HEAD_ID);
  assert.deepEqual(head.carriedAdmission, {
    approvedSnapshotId: CARRY_APPROVED_ID, approvedRawSha256: CARRY_APPROVED_RAW, schemaFingerprint: CARRY_SCHEMA,
    licenseEvidenceHash: CARRY_TERMS, chainLength: 2,
  });
  assert.deepEqual(head.admissionRecordSha256s, [{
    kind: "admissionEvidence",
    sha256: sha256(Buffer.from(canonicalCurrentFiveRegionSourceFanInJson(input.inventory.sources[0].admissionEvidence))),
  }]);
  // 이월은 여러 번 이어진다: 승인 snapshot이 head에서 여러 단계 떨어져도 길이만 남는다(계보 전체는 원장이 가진다).
  const multi = buildCurrentFiveRegionSourceFanIn(carriedForwardFixture({ intermediateSnapshots: 3 })).selectedSources[0];
  assert.equal(multi.carriedAdmission.chainLength, 5);
  // 현재 snapshot을 직접 승인한 원천에는 이월 근거를 붙이지 않는다.
  assert.equal(Object.hasOwn(buildCurrentFiveRegionSourceFanIn(fixture()).selectedSources[0], "carriedAdmission"), false);
});

// 무인 갱신은 원장 head + P1D에 매일 새 snapshot을 등록한다. 이월의 시간 한도는 약관 nextReviewAt 하나이고 체인 깊이는 한도가 아니다.
const DAILY_REGISTRATIONS_PER_YEAR = 365;

test("#1289 a year of daily registrations stays carried forward until the governance review deadline", () => {
  const daily = carriedForwardFixture({ intermediateSnapshots: DAILY_REGISTRATIONS_PER_YEAR });
  const [head] = buildCurrentFiveRegionSourceFanIn(daily).selectedSources;
  assert.equal(head.carriedAdmission.chainLength, DAILY_REGISTRATIONS_PER_YEAR + 2);
  // 커밋 산출물의 근거는 매일 쌓이는 snapshot 수와 무관한 상수 크기(배열 없음)다.
  assert.deepEqual(Object.keys(head.carriedAdmission).sort(),
    ["approvedRawSha256", "approvedSnapshotId", "chainLength", "licenseEvidenceHash", "schemaFingerprint"]);
  assert.equal(Object.values(head.carriedAdmission).some((value) => typeof value === "object"), false);
  daily.governancePolicy = carriedGovernance({ nextReviewAt: EVALUATED_AT });
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(daily),
    /admission carry-forward mismatch for kric-subway-timetable-station-lines: REVIEW_EXPIRED/);
});

test("#1289 a cyclic snapshot lineage is rejected instead of walked forever", () => {
  const { sourceSnapshots } = carriedForwardFixture({ intermediateSnapshots: 2 });
  const [approvedRow, , lastMiddle, head] = sourceSnapshots;
  // 첫 행이 마지막 중간 행을 가리키는 순환 계보에서, 승인 snapshot에 닿기 전에 같은 행을 다시 만난다.
  const cyclic = [{ ...approvedRow, previousSnapshotId: lastMiddle.snapshotId }, ...sourceSnapshots.slice(1)];
  const lineage = carriedAdmissionLineage({
    sourceId: CARRY_SOURCE_ID, approved: { decision: "APPROVED", sourceId: CARRY_SOURCE_ID, snapshotId: "not-in-lineage",
      schemaFingerprint: CARRY_SCHEMA, licenseEvidenceHash: CARRY_TERMS, rawSha256: CARRY_APPROVED_RAW },
    ledger: cyclic, head: { ...head }, schemaFingerprint: CARRY_SCHEMA,
  });
  assert.deepEqual(lineage, { violation: "LINEAGE_CYCLE" });
});

test("#1289 the lineage walk only follows rows of the carried source", () => {
  const { sourceSnapshots, inventory } = carriedForwardFixture();
  const approved = inventory.sources[0].admissionEvidence;
  const walk = (ledger, head = ledger.at(-1)) => carriedAdmissionLineage({
    sourceId: CARRY_SOURCE_ID, approved, ledger, head, schemaFingerprint: CARRY_SCHEMA,
  });
  assert.deepEqual(walk(sourceSnapshots), { chainLength: 2 });
  // 다른 원천의 행이 같은 snapshotId를 가져도 따라가지 않는다: 승인 행이 다른 원천의 것이면 조상이 아니다.
  const foreignApproved = sourceSnapshots.map((row) => (row.snapshotId === CARRY_APPROVED_ID ? { ...row, sourceId: "other-source" } : row));
  assert.deepEqual(walk(foreignApproved, sourceSnapshots.at(-1)), { violation: "NOT_ANCESTOR" });
  // 같은 snapshotId의 다른 원천 행이 원장 뒤쪽에 있어도 대상 원천의 행을 가리지 못한다.
  const shadowed = [...sourceSnapshots, { ...sourceSnapshots[0], sourceId: "other-source", rawSha256: "0".repeat(64) }];
  assert.deepEqual(walk(shadowed, sourceSnapshots.at(-1)), { chainLength: 2 });
  // head 자체가 다른 원천의 행이면 거부한다.
  assert.deepEqual(walk(sourceSnapshots, { ...sourceSnapshots.at(-1), sourceId: "other-source" }), { violation: "LINEAGE_SOURCE_MISMATCH" });
});

test("#1289 an approval that cannot be carried forward keeps failing explicitly", () => {
  const cases = [
    ["승인 snapshot이 원장에 없다", (input) => { input.inventory.sources[0].admissionEvidence.snapshotId = `${CARRY_SOURCE_ID}-19990101`; }, "NOT_ANCESTOR"],
    ["승인 snapshot이 다른 원천의 행이라 head의 조상이 아니다", (input) => {
      input.sourceSnapshots.push({ ...input.sourceSnapshots[0], sourceId: "other-source", snapshotId: "other-source-1" });
      input.inventory.sources[0].admissionEvidence.snapshotId = "other-source-1";
    }, "NOT_ANCESTOR"],
    ["승인 당시 rawSha256이 원장 행과 다르다", (input) => { input.inventory.sources[0].admissionEvidence.rawSha256 = "0".repeat(64); }, "APPROVED_RAW_MISMATCH"],
    ["스키마가 승인 시점과 다르다", (input) => { input.sourceSnapshots[1].schemaFingerprint = "0".repeat(64); }, "SCHEMA_CHANGED"],
    ["승인 증거와 원장 head 모두 스키마 해시가 없다", (input) => {
      delete input.inventory.sources[0].admissionEvidence.schemaFingerprint;
      for (const row of input.sourceSnapshots) delete row.schemaFingerprint;
    }, "SCHEMA_CHANGED"],
    ["승인 증거에 약관 해시가 없다", (input) => { delete input.inventory.sources[0].admissionEvidence.licenseEvidenceHash; }, "LICENSE_EVIDENCE_MISSING"],
    ["승인 증거가 다른 원천의 것이다", (input) => { input.inventory.sources[0].admissionEvidence.sourceId = "other-source"; }, "NOT_APPROVED"],
    ["현재 head에 묶인 scheduleAdmissionEvidence가 없다", (input) => { input.inventory.sources[0].scheduleAdmissionEvidence.rawSha256 = "0".repeat(64); }, "HEAD_EVIDENCE_UNBOUND"],
  ];
  for (const [name, mutate, violation] of cases) {
    assert.throws(() => buildCurrentFiveRegionSourceFanIn(carriedMutation(mutate)),
      new RegExp(`admission carry-forward mismatch for ${CARRY_SOURCE_ID}: ${violation}`), name);
  }
  const notApproved = carriedMutation((input) => { input.inventory.sources[0].admissionEvidence.decision = "PENDING"; });
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(notApproved), /admission approval mismatch/);
  // 이월은 등록기가 무인 갱신하는 원천에만 허용한다.
  const notEligible = carriedMutation((input) => {
    input.inventory.sources[0].id = "other-source";
    input.inventory.sources[0].admissionEvidence.sourceId = "other-source";
    for (const row of input.sourceSnapshots) row.sourceId = "other-source";
    for (const row of input.tally.launchRequired.requirements) row.admittedSourceIds = ["other-source"];
  });
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(notEligible), /admission carry-forward mismatch for other-source: SOURCE_NOT_ELIGIBLE/);
});

test("#1289 a carried-forward approval is bound to the license terms and review deadline of the governance policy", () => {
  const withPolicy = (governancePolicy) => ({ ...carriedForwardFixture(), governancePolicy });
  assert.doesNotThrow(() => buildCurrentFiveRegionSourceFanIn(withPolicy(carriedGovernance())));
  const violation = (governancePolicy, expected) => assert.throws(() => buildCurrentFiveRegionSourceFanIn(withPolicy(governancePolicy)), expected);
  violation(carriedGovernance({ termsHash: "0".repeat(64) }), /admission carry-forward mismatch for kric-subway-timetable-station-lines: LICENSE_CHANGED/);
  violation(carriedGovernance({ nextReviewAt: EVALUATED_AT }), /admission carry-forward mismatch for kric-subway-timetable-station-lines: REVIEW_EXPIRED/);
  violation(carriedGovernance({ nextReviewAt: undefined }), /REVIEW_EXPIRED/);
  violation({ sources: [] }, /carried admission governance entry mismatch for kric-subway-timetable-station-lines/);
  violation({ sources: [...carriedGovernance().sources, ...carriedGovernance().sources] }, /carried admission governance entry mismatch/);
  violation({}, /carried admission governance policy shape mismatch/);
  // 이월이 없는 fan-in은 거버넌스 입력을 요구하지 않는다.
  assert.doesNotThrow(() => buildCurrentFiveRegionSourceFanIn(fixture()));
});

test("#1289 the pure builder fails closed on a carried-forward approval without an explicit governance input", () => {
  const { governancePolicy, ...withoutGovernance } = carriedForwardFixture();
  assert.doesNotThrow(() => buildCurrentFiveRegionSourceFanIn({ ...withoutGovernance, governancePolicy }));
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(withoutGovernance),
    /admission carry-forward mismatch for kric-subway-timetable-station-lines: GOVERNANCE_INPUT_REQUIRED/);
  // 재현 모드는 이름을 붙여 명시해야 하고, 정책과 함께 줄 수 없다.
  const reproduced = buildCurrentFiveRegionSourceFanIn({ ...withoutGovernance, governance: REPRODUCTION_GOVERNANCE });
  assert.deepEqual(reproduced.selectedSources[0].carriedAdmission, {
    approvedSnapshotId: CARRY_APPROVED_ID, approvedRawSha256: CARRY_APPROVED_RAW, schemaFingerprint: CARRY_SCHEMA,
    licenseEvidenceHash: CARRY_TERMS, chainLength: 2,
  });
  assert.throws(() => buildCurrentFiveRegionSourceFanIn({ ...withoutGovernance, governance: {} }), /governance mode mismatch/);
  assert.throws(() => buildCurrentFiveRegionSourceFanIn({ ...withoutGovernance, governance: REPRODUCTION_GOVERNANCE, governancePolicy }),
    /governance input is ambiguous/);
});

test("#1289 the fan-in CLI records a carried-forward approval and refuses to write when the governance check fails", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "five-region-source-fan-in-carry-"));
  const input = carriedForwardFixture();
  const paths = {};
  for (const [name, value] of Object.entries(input.inputBytes)) {
    paths[name] = path.join(temporary, `${name}.json`);
    await writeFile(paths[name], value);
  }
  const policyPath = path.join(temporary, "freshness-policy.json");
  await writeFile(policyPath, bytes(policyFor(buildCurrentFiveRegionSourceFanIn(input))));
  const run = async (name, governancePolicy) => {
    const governancePath = path.join(temporary, `${name}-governance.json`);
    await writeFile(governancePath, bytes(governancePolicy));
    const output = path.join(temporary, `${name}-fan-in.json`);
    const result = spawnSync(process.execPath, [
      path.join(ROOT, "tools/datapack/build-current-five-region-source-fan-in.mjs"),
      "--targets", paths.targets, "--tally", paths.tally, "--ownership", paths.ownership,
      "--inventory", paths.inventory, "--source-snapshots", paths.sourceSnapshots,
      "--freshness-policy", policyPath, "--governance-policy", governancePath,
      "--evaluated-at", EVALUATED_AT, "--output", output,
    ], { encoding: "utf8" });
    return { result, output };
  };
  const accepted = await run("accepted", carriedGovernance());
  assert.equal(accepted.result.status, 0, accepted.result.stderr);
  assert.deepEqual(JSON.parse(await readFile(accepted.output, "utf8")).selectedSources[0].carriedAdmission.chainLength, 2);
  const changed = await run("changed", carriedGovernance({ termsHash: "0".repeat(64) }));
  assert.notEqual(changed.result.status, 0);
  assert.match(changed.result.stderr, /LICENSE_CHANGED/);
  await assert.rejects(stat(changed.output), { code: "ENOENT" });
});
