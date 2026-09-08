import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  buildCurrentFiveRegionSourceFanIn,
  canonicalCurrentFiveRegionSourceFanInJson,
} from "./build-current-five-region-source-fan-in.mjs";
import { buildNationwideRequirementOwnershipLedger, resolveNationwideRequirementOwner } from "./build-nationwide-requirement-ownership-ledger.mjs";

test("owner work selection preserves overrides without candidate or GO inputs", () => {
  const rules = [
    { issue: 454, sourceDomain: "schedule_timetable" },
    { issue: 504, regionId: "gwangju", sourceDomain: "schedule_timetable" },
    { issue: 455, sourceDomain: "station_line_membership" },
  ];
  assert.equal(resolveNationwideRequirementOwner(rules,
    { regionId: "gwangju", sourceDomain: "schedule_timetable" }).issue, 504);
  assert.equal(resolveNationwideRequirementOwner(rules,
    { regionId: "capital", sourceDomain: "schedule_timetable" }).issue, 454);
  assert.equal(resolveNationwideRequirementOwner(rules,
    { regionId: "gwangju", sourceDomain: "station_line_membership" }).issue, 455);
  assert.throws(() => resolveNationwideRequirementOwner(rules,
    { sourceDomain: "unknown" }), /unowned or ambiguous PK/);
  assert.throws(() => resolveNationwideRequirementOwner([...rules, rules[0]],
    { regionId: "capital", sourceDomain: "schedule_timetable" }), /unowned or ambiguous PK/);
});

test("#6 consumes an exact canonical five-region fan-in without a candidate build spec", () => {
  const input = fixtureLedgerInput(independentFiveRegionFixture());
  const ledger = buildNationwideRequirementOwnershipLedger(input);

  assert.equal(ledger.summary.nationwideEligibility, "NO_GO");
  assert.equal(ledger.rows.length, input.tally.launchRequired.requirements.length);
  assert.ok(ledger.rows.every((row) => row.lineage.runtimeLineage.state === "PENDING"));
  assert.equal(Object.hasOwn(ledger.provenance.inputs, "candidateBuildSpec"), false);
  assert.equal(ledger.provenance.inputs.fanIn.sha256, hash(input.inputBytes.fanIn));
});

test("#6 rejects missing, altered, drifted, and candidate fan-in inputs", () => {
  const missing = independentFiveRegionFixture();
  assert.throws(() => buildNationwideRequirementOwnershipLedger(missing), /fan-in input bytes/);

  const altered = fixtureLedgerInput(independentFiveRegionFixture());
  altered.fanIn = { ...altered.fanIn, evaluatedAt: "2040-01-02T00:00:01.000Z" };
  assert.throws(() => buildNationwideRequirementOwnershipLedger(altered), /self digest/);

  const drifted = fixtureLedgerInput(independentFiveRegionFixture());
  drifted.tally.launchRequired.requirements[0].status = "MISSING";
  drifted.tally.launchRequired.requirements[0].admittedSourceIds = [];
  assert.throws(() => buildNationwideRequirementOwnershipLedger(drifted), /tally input bytes mismatch/);

  const candidate = fixtureLedgerInput(independentFiveRegionFixture());
  candidate.candidateBuildSpec = {};
  assert.throws(() => buildNationwideRequirementOwnershipLedger(candidate), /candidate build spec input/);
});

test("#6 keeps nonterminal requirements honest and retains fail-closed source boundaries", () => {
  const missing = independentFiveRegionFixture();
  missing.tally.launchRequired.requirements[0].status = "MISSING";
  missing.tally.launchRequired.requirements[0].admittedSourceIds = [];
  const missingLedger = buildNationwideRequirementOwnershipLedger(fixtureLedgerInput(missing));
  assert.equal(missingLedger.summary.nationwideEligibility, "NO_GO");
  assert.equal(missingLedger.rows[0].disposition.status, "MISSING");

  const partial = independentFiveRegionFixture();
  partial.tally.launchRequired.requirements[0].status = "MISSING";
  assert.throws(() => fixtureLedgerInput(partial), /requirement disposition/);

  const unsafe = independentFiveRegionFixture();
  unsafe.inventory.sources[0].coverageScope.lineIds = [];
  assert.throws(() => buildNationwideRequirementOwnershipLedger(fixtureLedgerInput(unsafe)), /empty lineIds/);

  const unowned = independentFiveRegionFixture();
  unowned.ownership.ownerRules = [];
  assert.throws(() => buildNationwideRequirementOwnershipLedger(fixtureLedgerInput(unowned)), /owner rules/);

  const missingHead = independentFiveRegionFixture();
  missingHead.sourceSnapshots = [];
  assert.throws(() => fixtureLedgerInput(missingHead), /terminal snapshot head/);

  const stale = independentFiveRegionFixture();
  stale.sourceSnapshots[0].freshnessExpiresAt = stale.evaluatedAt;
  assert.throws(() => fixtureLedgerInput(stale), /snapshot freshness/);
});

test("#6 derives GO only when every launch lineage axis is evidenced", () => {
  const input = independentFiveRegionFixture();
  input.inventory.sources[0].runtimeLineageEvidence = { operationId: "fixture-runtime" };
  const ledger = buildNationwideRequirementOwnershipLedger(fixtureLedgerInput(input));
  assert.equal(ledger.summary.nationwideEligibility, "GO");
  assert.ok(ledger.rows.every((row) => Object.values(row.lineage).every(({ state }) => state === "EVIDENCED")));
});

function independentFiveRegionFixture() {
  const evaluatedAt = "2040-01-02T00:00:00.000Z";
  const regions = ["busan", "capital", "daegu", "daejeon", "gwangju"];
  const activeLineScopes = regions.map((regionId, index) => ({
    regionId,
    operatorId: `fixture-operator-${index + 1}`,
    lineId: `fixture-line-${index + 1}`,
  }));
  const targets = {
    schemaVersion: 2,
    artifactKind: "nationwide-datapack-coverage-targets",
    targetVersion: "fixture-v1",
    activeLineScopes,
    requiredSourceDomains: [{ id: "schedule_timetable", releaseTier: "LAUNCH_REQUIRED", requiredFields: ["trip"] }],
  };
  const tally = {
    schemaVersion: 1,
    targetVersion: targets.targetVersion,
    launchRequired: {
      requirements: activeLineScopes.map((scope) => ({
        ...scope,
        sourceDomain: "schedule_timetable",
        releaseTier: "LAUNCH_REQUIRED",
        status: "INVENTORY_ADMITTED",
        admittedSourceIds: ["fixture-five-region-schedule"],
      })),
    },
    enhancement: { requirements: [] },
  };
  const ownership = { schemaVersion: 1, targetVersion: targets.targetVersion,
    ownerRules: [{ issue: 9001, sourceDomain: "schedule_timetable" }] };
  const sourceId = "fixture-five-region-schedule";
  const rawSha256 = "a".repeat(64);
  const source = {
    id: sourceId,
    provider: "Fixture Provider",
    datasetUrl: `https://fixture.example/${sourceId}`,
    sourceSystem: "fixture-source-system",
    requiredForProductionPack: true,
    productionUseAllowed: true,
    coverageScope: {
      regionIds: activeLineScopes.map(({ regionId }) => regionId),
      operatorIds: activeLineScopes.map(({ operatorId }) => operatorId),
      lineIds: activeLineScopes.map(({ lineId }) => lineId),
      sourceDomains: ["schedule_timetable"],
    },
    fieldsProvided: ["trip"],
    license: { commercialUseAllowed: true, derivativeWorkAllowed: true, redistributionAllowed: true },
    admissionEvidence: { decision: "APPROVED", sourceId, snapshotId: `${sourceId}-snapshot`, rawSha256,
      capturedAt: "2040-01-01T00:00:00.000Z", freshUntil: "2040-01-03T00:00:00.000Z" },
  };
  const inventory = { sources: [source] };
  const sourceSnapshots = [{
    schemaVersion: 1,
    artifactKind: "official-source-snapshot",
    sourceId: source.id,
    snapshotId: `${source.id}-snapshot`,
    provider: source.provider,
    retrievedAt: "2040-01-01T00:00:00.000Z",
    rawSha256: source.admissionEvidence.rawSha256,
    rawObjectUri: `oci://fixture-namespace/fixture-bucket/${source.id}.json`,
    previousSnapshotId: null,
    freshnessExpiresAt: "2040-01-03T00:00:00.000Z",
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
    evaluatedAt,
    inputBytes: Object.fromEntries(Object.entries(values).map(([name, value]) => [name, fixtureBytes(value)])),
  };
}

function fixtureBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function fixtureLedgerInput(input) {
  const inputBytes = Object.fromEntries(["targets", "tally", "ownership", "inventory", "sourceSnapshots"]
    .map((name) => [name, fixtureBytes(input[name])]));
  const fanIn = buildCurrentFiveRegionSourceFanIn({ ...input, inputBytes });
  return {
    ...input,
    fanIn,
    inputBytes: { ...inputBytes, fanIn: Buffer.from(`${canonicalCurrentFiveRegionSourceFanInJson(fanIn)}\n`) },
  };
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
