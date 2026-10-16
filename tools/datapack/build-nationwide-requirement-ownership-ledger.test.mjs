import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { buildNationwideRequirementOwnershipLedger, resolveNationwideRequirementOwner } from "./build-nationwide-requirement-ownership-ledger.mjs";
import { buildCurrentFiveRegionSourceFanIn, canonicalCurrentFiveRegionSourceFanInJson } from "./build-current-five-region-source-fan-in.mjs";
import { fixtureBytes, fixtureLedgerInput, independentFiveRegionFixture } from "./test-fixtures/five-region-source-input.mjs";

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
  assert.throws(() => buildNationwideRequirementOwnershipLedger(fixtureLedgerInput(partial)),
    /unexpected admitted source/);

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
  const ledger = buildNationwideRequirementOwnershipLedger(
    fixtureLedgerInput(independentFiveRegionFixture({ runtimeEvidence: true })),
  );
  assert.equal(ledger.summary.nationwideEligibility, "GO");
  assert.ok(ledger.rows.every((row) => Object.values(row.lineage).every(({ state }) => state === "EVIDENCED")));
});

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// #1289: 소유권 원장은 CLI가 거버넌스 정책을 확인해 만든 fan-in 바이트(이월 근거 포함)를 정책 입력 없이 다시 만들어 대조한다.
test("#1289 reconstructs a fan-in that carries a forward admission without a governance policy input", () => {
  const input = independentFiveRegionFixture();
  const sourceId = "kric-subway-timetable-station-lines";
  const [source] = input.inventory.sources;
  const [base] = input.sourceSnapshots;
  const schemaFingerprint = "b".repeat(64);
  const approvedRow = { ...base, sourceId, snapshotId: `${sourceId}-20261003`, schemaFingerprint };
  const headRow = { ...approvedRow, snapshotId: `${sourceId}-20261016`, previousSnapshotId: approvedRow.snapshotId,
    rawSha256: "e".repeat(64), rawObjectUri: `oci://fixture-namespace/fixture-bucket/${sourceId}-head.json` };
  input.sourceSnapshots = [approvedRow, headRow];
  for (const row of input.tally.launchRequired.requirements) row.admittedSourceIds = [sourceId];
  source.id = sourceId;
  source.capabilities = { schedule: { productionUseAllowed: true } };
  source.admissionEvidence = { ...source.admissionEvidence, sourceId, snapshotId: approvedRow.snapshotId, schemaFingerprint, licenseEvidenceHash: "f".repeat(64) };
  source.scheduleAdmissionEvidence = { issue: 903, materializer: "fixture-materializer", verificationTest: "fixture-test", snapshotId: headRow.snapshotId,
    snapshotPath: `tools/datapack/sources/${headRow.snapshotId}.json`, capturedAt: "2040-01-01T00:00:00.000Z", rawSha256: headRow.rawSha256 };
  const inputBytes = Object.fromEntries(["targets", "tally", "ownership", "inventory", "sourceSnapshots"].map((name) => [name, fixtureBytes(input[name])]));
  const governancePolicy = { sources: [{ sourceId, licenseReview: { termsHash: "f".repeat(64), nextReviewAt: "2041-01-01T00:00:00Z" } }] };
  const fanIn = buildCurrentFiveRegionSourceFanIn({ ...input, inputBytes, governancePolicy });
  assert.equal(fanIn.selectedSources[0].carriedAdmission.chainLength, 2);
  const ledger = buildNationwideRequirementOwnershipLedger({
    ...input, fanIn, inputBytes: { ...inputBytes, fanIn: Buffer.from(`${canonicalCurrentFiveRegionSourceFanInJson(fanIn)}\n`) },
  });
  assert.equal(ledger.provenance.inputs.fanIn.fanInSha256, fanIn.fanInSha256);
});
