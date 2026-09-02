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
      productionUseAllowed: true,
      license: { commercialUseAllowed: true },
      admissionEvidence: { decision: "APPROVED" },
    }],
  };
  const sourceSnapshots = [{
    schemaVersion: 1,
    artifactKind: "official-source-snapshot",
    snapshotId: "official-five-region-timetable-v1",
    sourceId: "official-five-region-timetable",
    provider: "Official Rail Provider",
    rawSha256: SHA,
    rawObjectUri: `oci://namespace/bucket/source/${SHA}.json`,
    previousSnapshotId: null,
    freshnessExpiresAt: "2026-09-04T00:00:00.000Z",
    snapshotStatus: "LOCKED",
    schemaStatus: "PASS",
    licenseStatus: "PASS",
    fetchStatus: "SUCCESS",
    redistributionAllowed: true,
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

  assert.equal(fanIn.schemaVersion, 1);
  assert.equal(fanIn.artifactKind, "current-five-region-source-fan-in");
  assert.equal(fanIn.targetVersion, input.targets.targetVersion);
  assert.equal(fanIn.evaluatedAt, EVALUATED_AT);
  assert.deepEqual(fanIn.regionIds, REGIONS);
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
  });
  assert.match(fanIn.scopeSha256, /^[a-f0-9]{64}$/u);
  assert.match(fanIn.sourceSetSha256, /^[a-f0-9]{64}$/u);
  assert.match(fanIn.fanInSha256, /^[a-f0-9]{64}$/u);
  assert.equal(fanIn.inputs.targets.sha256, sha256(input.inputBytes.targets));
  assert.equal(fanIn.inputs.sourceSnapshots.sha256, sha256(input.inputBytes.sourceSnapshots));
  assert.equal(canonicalCurrentFiveRegionSourceFanInJson(fanIn).includes("candidate"), false);
  assert.equal(canonicalCurrentFiveRegionSourceFanInJson(fanIn).includes("s3://"), false);
});

test("#687 fails closed on ambiguous, non-OCI, stale, or unbound source heads", () => {
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

  const stale = fixture();
  stale.sourceSnapshots[0].freshnessExpiresAt = EVALUATED_AT;
  stale.inputBytes.sourceSnapshots = bytes(stale.sourceSnapshots);
  assert.throws(() => buildCurrentFiveRegionSourceFanIn(stale), /freshness/);

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
