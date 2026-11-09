import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  buildNationwideRequirementOwnershipLedger,
  normalizeNationwideOwnershipRules,
  resolveNationwideRequirementOwner,
  SEOUL_METRO_DEMAND_REFERENCE_LINE_IDS,
  validateDemandReferenceOwnershipContract,
} from "./build-nationwide-requirement-ownership-ledger.mjs";
import { buildCurrentFiveRegionSourceFanIn, canonicalCurrentFiveRegionSourceFanInJson } from "./build-current-five-region-source-fan-in.mjs";
import {
  fiveRegionDemandReferenceFixture,
  fixtureBytes,
  fixtureLedgerInput,
  independentFiveRegionFixture,
} from "./test-fixtures/five-region-source-input.mjs";

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

test("#453 normalizes redundant same-issue ownership rules while preserving conflict-breaking overrides", () => {
  const rules = [
    { issue: 506, regionId: "busan", sourceDomain: "route_map_positions" },
    { issue: 506, regionId: "busan", operatorId: "korail", sourceDomain: "route_map_positions" },
    { issue: 453, operatorId: "seoul-metro", sourceDomain: "demand_reference" },
    { issue: 458, operatorId: "korail", sourceDomain: "route_map_positions" },
    { issue: 453, sourceDomain: "demand_reference" },
    { issue: 458, sourceDomain: "route_map_positions" },
  ];
  const normalized = normalizeNationwideOwnershipRules(rules);
  const demandRules = normalized.filter((rule) => rule.sourceDomain === "demand_reference");
  assert.deepEqual(demandRules, [{ issue: 453, sourceDomain: "demand_reference" }]);

  // busan+korail override must be preserved because issue 506 (regionId=busan) and issue 458 (operatorId=korail) conflict at specificity 2
  assert.equal(
    resolveNationwideRequirementOwner(normalized, {
      regionId: "busan",
      operatorId: "korail",
      lineId: "busan-line-5",
      sourceDomain: "route_map_positions",
    }).issue,
    506,
  );
  assert.equal(
    resolveNationwideRequirementOwner(normalized, {
      regionId: "capital",
      operatorId: "seoul-metro",
      lineId: "seoul-2",
      sourceDomain: "demand_reference",
    }).issue,
    453,
  );
});

test("#453 validates five-region 45-PK demand_reference ownership, seoul-metro 8-PK admission, and 37-PK contract gap", () => {
  const input = fiveRegionDemandReferenceFixture();
  const ledger = buildNationwideRequirementOwnershipLedger(input);
  const contract = validateDemandReferenceOwnershipContract({
    ledger,
    targets: input.targets,
    inventory: input.inventory,
    ownership: input.ownership,
  });

  assert.equal(contract.issue, 453);
  assert.equal(contract.sourceDomain, "demand_reference");
  assert.equal(contract.releaseTier, "ENHANCEMENT");
  assert.equal(contract.blocking, false);
  assert.equal(contract.totalPkCount, 45);
  assert.deepEqual(contract.regionCounts, {
    busan: 6,
    capital: 33,
    daegu: 4,
    daejeon: 1,
    gwangju: 1,
  });
  assert.equal(contract.admittedSourceId, "seoul-subway-hourly-boarding");
  assert.equal(contract.admittedPkCount, 8);
  assert.deepEqual(
    contract.admittedPks,
    SEOUL_METRO_DEMAND_REFERENCE_LINE_IDS.map((lineId) => `capital:seoul-metro:${lineId}:demand_reference`),
  );
  assert.equal(contract.missingContractGapCount, 37);
  assert.deepEqual(contract.canonicalRule, { issue: 453, sourceDomain: "demand_reference" });
});

test("#453 fails closed on demand_reference ownership, blocking flag, admitted PK, or contract gap drift", () => {
  const input = fiveRegionDemandReferenceFixture();
  const baseLedger = buildNationwideRequirementOwnershipLedger(input);

  const blockingDrifted = structuredClone(baseLedger);
  blockingDrifted.summary.enhancement.blocking = true;
  assert.throws(
    () => validateDemandReferenceOwnershipContract({ ledger: blockingDrifted, targets: input.targets, inventory: input.inventory, ownership: input.ownership }),
    /enhancement\.blocking must be false/,
  );

  const ownerDrifted = structuredClone(baseLedger);
  const firstDemandRow = ownerDrifted.rows.find((row) => row.sourceDomain === "demand_reference");
  firstDemandRow.childOwner = { issue: 999, issueUrl: "https://github.com/AquilaXk/easysubway-data/issues/999" };
  assert.throws(
    () => validateDemandReferenceOwnershipContract({ ledger: ownerDrifted, targets: input.targets, inventory: input.inventory, ownership: input.ownership }),
    /demand_reference owner drift/,
  );

  const seoulMetroDrifted = structuredClone(baseLedger);
  const seoul2Row = seoulMetroDrifted.rows.find((row) => row.pk === "capital:seoul-metro:seoul-2:demand_reference");
  seoul2Row.disposition.status = "MISSING";
  seoul2Row.disposition.admittedSourceIds = [];
  assert.throws(
    () => validateDemandReferenceOwnershipContract({ ledger: seoulMetroDrifted, targets: input.targets, inventory: input.inventory, ownership: input.ownership }),
    /expected INVENTORY_ADMITTED for capital:seoul-metro:seoul-2:demand_reference/,
  );

  const gapDrifted = structuredClone(baseLedger);
  const busanRow = gapDrifted.rows.find((row) => row.regionId === "busan" && row.sourceDomain === "demand_reference");
  busanRow.officialSourceFamily.reason = "CURRENT_SOURCE_SNAPSHOT_HEAD_REQUIRED";
  assert.throws(
    () => validateDemandReferenceOwnershipContract({ ledger: gapDrifted, targets: input.targets, inventory: input.inventory, ownership: input.ownership }),
    /expected CONTRACT_GAP for MISSING demand_reference PK/,
  );
});

