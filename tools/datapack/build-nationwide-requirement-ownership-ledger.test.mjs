import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { buildNationwideRequirementOwnershipLedger } from "./build-nationwide-requirement-ownership-ledger.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const paths = {
  targets: "tools/datapack/nationwide-coverage-targets.json",
  tally: "tools/datapack/reports/nationwide-coverage-tally.json",
  inventory: "tools/datapack/source-inventory.json",
  ownership: "tools/datapack/release/nationwide-requirement-ownership.json",
  sourceSnapshots: "tools/datapack/release/source-snapshots.json",
  candidateBuildSpec: "tools/datapack/release/candidate-build-spec.json",
};

async function inputs() {
  const records = await Promise.all(Object.entries(paths).map(async ([name, relativePath]) => {
    const bytes = await readFile(path.join(root, relativePath), "utf8");
    return [name, JSON.parse(bytes), bytes];
  }));
  return {
    ...Object.fromEntries(records.map(([name, value]) => [name, value])),
    inputBytes: Object.fromEntries(records.map(([name, , bytes]) => [name, bytes])),
  };
}

test("#449 derives the exact current PK set with one owner and honest NO_GO", async () => {
  const input = await inputs();
  const ledger = buildNationwideRequirementOwnershipLedger(input);
  const tallyRows = [...input.tally.launchRequired.requirements, ...input.tally.enhancement.requirements];
  assert.equal(ledger.summary.launchRequired.totalCount, 270);
  assert.equal(ledger.summary.enhancement.totalCount, 45);
  assert.equal(ledger.rows.length, tallyRows.length);
  assert.equal(ledger.summary.nationwideEligibility, "NO_GO");
  assert.deepEqual(ledger.rows.map(({ pk }) => pk), [...ledger.rows].map(({ pk }) => pk).sort());
  assert.deepEqual(new Set(ledger.rows.map(({ pk }) => pk)).size, tallyRows.length);
  for (const row of ledger.rows) {
    assert.match(row.childOwner.issueUrl, /^https:\/\/github\.com\/AquilaXk\/easysubway-data\/issues\/\d+$/);
    for (const axis of Object.values(row.lineage)) {
      assert.ok(axis.state === "EVIDENCED" || (axis.state === "PENDING" && axis.reason && axis.owner));
    }
  }
  assert.equal(ledger.provenance.regeneration.command, "node tools/datapack/build-nationwide-requirement-ownership-ledger.mjs");
  assert.equal(ledger.provenance.inputs.inventory.path, paths.inventory);
  assert.match(ledger.provenance.inputs.inventory.sha256, /^[0-9a-f]{64}$/);

  const inventoryOnly = ledger.rows.find((row) => row.disposition.admittedSourceIds
    .includes("busan-transportation-accessibility"));
  assert.equal(inventoryOnly.officialSourceFamily.state, "EVIDENCED");
  assert.equal(inventoryOnly.lineage.licenseLineage.state, "EVIDENCED");
  assert.equal(inventoryOnly.lineage.freshnessLineage.state, "PENDING");
  assert.equal(inventoryOnly.lineage.admissionLineage.state, "PENDING");
  assert.equal(inventoryOnly.lineage.admissionLineage.reason, "PRODUCTION_ADMISSION_REQUIRED");
  assert.equal(inventoryOnly.lineage.runtimeLineage.state, "PENDING");

  const incheonAccessibility = ledger.rows.find(({ operatorId, sourceDomain }) =>
    operatorId === "incheon-transit" && sourceDomain === "accessibility_facilities");
  assert.equal(incheonAccessibility.childOwner.issue, 622);
  assert.equal(inventoryOnly.childOwner.issue, 478);
});

test("#449 preserves partial admission without promoting missing requirements", async () => {
  const input = await inputs();
  const partial = input.tally.launchRequired.requirements.find((row) =>
    row.status === "MISSING" && row.admittedSourceIds.length > 0);
  assert.ok(partial);
  assert.ok(partial.admittedFieldCount > 0 && partial.admittedFieldCount < partial.requiredFieldCount);
  const ledger = buildNationwideRequirementOwnershipLedger(input);
  const row = ledger.rows.find(({ pk }) => pk ===
    [partial.regionId, partial.operatorId, partial.lineId, partial.sourceDomain].join(":"));
  assert.equal(row.disposition.status, "MISSING");
  assert.deepEqual(row.disposition.admittedSourceIds, [...partial.admittedSourceIds].sort());
  assert.equal(ledger.summary.nationwideEligibility, "NO_GO");
  const invalid = structuredClone(input);
  invalid.inventory.sources.find(({ id }) => id === partial.admittedSourceIds[0]).coverageScope.lineIds = [];
  assert.throws(() => buildNationwideRequirementOwnershipLedger(invalid), /empty lineIds/);
});

test("#449 rejects unsafe inventory scope, owner, and current-head drift", async () => {
  const input = await inputs();
  const admitted = input.tally.launchRequired.requirements.find(({ status }) => status === "INVENTORY_ADMITTED");
  const wildcard = structuredClone(input.inventory);
  wildcard.sources.find(({ id }) => id === admitted.admittedSourceIds[0]).coverageScope.lineIds = [];
  assert.throws(() => buildNationwideRequirementOwnershipLedger({ ...input, inventory: wildcard }), /empty lineIds/);

  const missingFields = structuredClone(input.inventory);
  missingFields.sources.find(({ id }) => id === admitted.admittedSourceIds[0]).fieldsProvided = [];
  assert.throws(() => buildNationwideRequirementOwnershipLedger({ ...input, inventory: missingFields }), /required fields/);

  const unowned = structuredClone(input.ownership);
  unowned.ownerRules = [];
  assert.throws(() => buildNationwideRequirementOwnershipLedger({ ...input, ownership: unowned }), /owner rules/);

  const badHead = structuredClone(input.candidateBuildSpec);
  badHead.sourceSnapshots.push({ ...badHead.sourceSnapshots[0] });
  assert.throws(() => buildNationwideRequirementOwnershipLedger({ ...input, candidateBuildSpec: badHead }), /current-head source identity mismatch/);
});

test("#449 candidate selection is artifact evidence, not completion of every lineage axis", async () => {
  const input = await inputs();
  const bound = structuredClone(input);
  const requirement = bound.tally.launchRequired.requirements.find(({ status }) => status === "INVENTORY_ADMITTED");
  const candidateHead = bound.candidateBuildSpec.sourceSnapshots[0];
  const source = structuredClone(bound.inventory.sources.find(({ id }) => id === requirement.admittedSourceIds[0]));
  source.id = candidateHead.sourceId;
  bound.inventory.sources = bound.inventory.sources.filter(({ id }) => id !== candidateHead.sourceId);
  bound.inventory.sources.push(source);
  requirement.admittedSourceIds = [candidateHead.sourceId];
  const ledger = buildNationwideRequirementOwnershipLedger(bound);
  const row = ledger.rows.find(({ pk }) => pk === [requirement.regionId, requirement.operatorId, requirement.lineId, requirement.sourceDomain].join(":"));
  assert.equal(row.lineage.artifactLineage.state, "EVIDENCED");
  assert.equal(row.lineage.runtimeLineage.state, "PENDING");
  assert.notEqual(Object.values(row.lineage).every(({ state }) => state === "EVIDENCED"), true);
});

test("#449 keeps expired and decision-less Busan accessibility lineage pending", async () => {
  const input = await inputs();
  const bound = structuredClone(input);
  const busan = bound.inventory.sources.find(({ id }) => id === "busan-transportation-accessibility");
  const templateHead = bound.candidateBuildSpec.sourceSnapshots[0];
  const templateSnapshot = bound.sourceSnapshots.find(({ snapshotId }) => snapshotId === templateHead.snapshotId);
  const snapshotId = "busan-transportation-accessibility-expired";
  const expiredHead = {
    ...templateHead,
    snapshotId,
    sourceId: busan.id,
    freshnessExpiresAt: bound.candidateBuildSpec.publishedAt,
  };
  bound.sourceSnapshots.push({ ...templateSnapshot, snapshotId, sourceId: busan.id });
  bound.candidateBuildSpec.sourceSnapshotIds.push(snapshotId);
  bound.candidateBuildSpec.sourceSnapshots.push(expiredHead);

  const ledger = buildNationwideRequirementOwnershipLedger(bound);
  const row = ledger.rows.find(({ disposition }) => disposition.admittedSourceIds.includes(busan.id));
  assert.equal(row.lineage.freshnessLineage.state, "PENDING");
  assert.equal(row.lineage.admissionLineage.state, "PENDING");
  assert.equal(row.lineage.admissionLineage.reason, "PRODUCTION_ADMISSION_REQUIRED");
});

test("#449 keeps inventory-only artifact references pending without a current candidate head", async () => {
  const input = await inputs();
  const bound = structuredClone(input);
  const requirement = bound.tally.launchRequired.requirements.find(({ status }) => status === "INVENTORY_ADMITTED");
  const firstSource = bound.inventory.sources.find(({ id }) => id === requirement.admittedSourceIds[0]);
  const secondSource = structuredClone(firstSource);
  secondSource.id = `${firstSource.id}-second-admitted-source`;
  firstSource.admissionEvidence = {
    decision: "APPROVED", snapshotId: "first-artifact-a", snapshotPath: "oci://first/a", rawSha256: "a".repeat(64),
  };
  firstSource.reviewAdmissionEvidence = {
    decision: "APPROVED", snapshotId: "first-artifact-b", snapshotPath: "oci://first/b", rawSha256: "b".repeat(64),
  };
  secondSource.admissionEvidence = { decision: "APPROVED" };
  bound.inventory.sources.push(secondSource);
  requirement.admittedSourceIds = [firstSource.id, secondSource.id];

  const ledger = buildNationwideRequirementOwnershipLedger(bound);
  const row = ledger.rows.find(({ pk }) => pk === [requirement.regionId, requirement.operatorId, requirement.lineId, requirement.sourceDomain].join(":"));
  assert.equal(row.lineage.artifactLineage.state, "PENDING");
});

test("#449 derives GO only from terminal launch rows with complete admitted lineage", async () => {
  const input = await inputs();
  const bound = structuredClone(input);
  const admittedIds = [...new Set(bound.tally.launchRequired.requirements
    .filter(({ status }) => status === "INVENTORY_ADMITTED")
    .flatMap(({ admittedSourceIds }) => admittedSourceIds))];
  const snapshotTemplate = bound.sourceSnapshots[0];
  const headTemplate = bound.candidateBuildSpec.sourceSnapshots[0];
  bound.sourceSnapshots = [];
  bound.candidateBuildSpec.sourceSnapshots = [];
  bound.candidateBuildSpec.sourceSnapshotIds = [];
  for (const sourceId of admittedIds) {
    const source = bound.inventory.sources.find(({ id }) => id === sourceId);
    source.productionUseAllowed = true;
    source.admissionEvidence = {
      decision: "APPROVED", freshUntil: "2099-01-01T00:00:00.000Z",
      snapshotId: `synthetic-${sourceId}`, snapshotPath: `oci://synthetic/${sourceId}`, rawSha256: "c".repeat(64),
    };
    source.runtimeLineageEvidence = { operationId: `synthetic-${sourceId}` };
    const snapshotId = `synthetic-head-${sourceId}`;
    const rawSha256 = `${"d".repeat(63)}${admittedIds.indexOf(sourceId).toString(16)}`;
    const rawObjectUri = `oci://synthetic/head/${sourceId}`;
    bound.sourceSnapshots.push({ ...snapshotTemplate, snapshotId, sourceId, rawSha256, rawObjectUri });
    bound.candidateBuildSpec.sourceSnapshotIds.push(snapshotId);
    bound.candidateBuildSpec.sourceSnapshots.push({ ...headTemplate, snapshotId, sourceId, rawSha256, rawObjectUri, freshnessExpiresAt: "2099-01-01T00:00:00.000Z" });
  }
  for (const row of bound.tally.launchRequired.requirements) {
    if (row.status !== "INVENTORY_ADMITTED") {
      row.status = "EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE";
      row.admittedSourceIds = [];
    }
  }

  const ledger = buildNationwideRequirementOwnershipLedger(bound);
  assert.equal(ledger.summary.nationwideEligibility, "GO");
});
