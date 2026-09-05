import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import {
  buildCurrentFiveRegionSourceFanIn,
  canonicalCurrentFiveRegionSourceFanInJson,
  validateCurrentFiveRegionSourceFanIn,
} from "./build-current-five-region-source-fan-in.mjs";

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

  const staleAdmission = fixture();
  staleAdmission.inventory.sources[0].admissionEvidence.freshUntil = EVALUATED_AT;
  staleAdmission.inputBytes.inventory = bytes(staleAdmission.inventory);
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(staleAdmission), /admission.*freshness/);

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
  const args = [
    path.join(ROOT, "tools/datapack/build-current-five-region-source-fan-in.mjs"),
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
