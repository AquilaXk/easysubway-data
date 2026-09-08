import { createHash } from "node:crypto";

import {
  buildCurrentFiveRegionSourceFanIn,
  canonicalCurrentFiveRegionSourceFanInJson,
} from "../build-current-five-region-source-fan-in.mjs";
import { buildNationwideRequirementOwnershipLedger } from "../build-nationwide-requirement-ownership-ledger.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function fixtureBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

export function independentFiveRegionFixture({ runtimeEvidence = false } = {}) {
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
  const ownership = {
    schemaVersion: 1,
    targetVersion: targets.targetVersion,
    ownerRules: [{ issue: 9001, sourceDomain: "schedule_timetable" }],
  };
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
    admissionEvidence: {
      decision: "APPROVED", sourceId, snapshotId: `${sourceId}-snapshot`, rawSha256,
      capturedAt: "2040-01-01T00:00:00.000Z", freshUntil: "2040-01-03T00:00:00.000Z",
    },
    ...(runtimeEvidence ? { runtimeLineageEvidence: { operationId: "fixture-runtime" } } : {}),
  };
  const inventory = { sources: [source] };
  const sourceSnapshots = [{
    schemaVersion: 1,
    artifactKind: "official-source-snapshot",
    sourceId: source.id,
    snapshotId: `${source.id}-snapshot`,
    provider: source.provider,
    retrievedAt: "2040-01-01T00:00:00.000Z",
    sourceUpdatedAt: null,
    rowCount: 1,
    coverageCount: 1,
    rawSha256: source.admissionEvidence.rawSha256,
    schemaFingerprint: "b".repeat(64),
    redactedRequestFingerprint: "c".repeat(64),
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

export function fixtureLedgerInput(input) {
  const inputBytes = Object.fromEntries(["targets", "tally", "ownership", "inventory", "sourceSnapshots"]
    .map((name) => [name, fixtureBytes(input[name])]));
  const fanIn = buildCurrentFiveRegionSourceFanIn({ ...input, inputBytes });
  return {
    ...input,
    fanIn,
    inputBytes: { ...inputBytes, fanIn: Buffer.from(`${canonicalCurrentFiveRegionSourceFanInJson(fanIn)}\n`) },
  };
}

export function fiveRegionCandidateSourceSetInput({ runtimeEvidence = true } = {}) {
  const input = fixtureLedgerInput(independentFiveRegionFixture({ runtimeEvidence }));
  const regions = input.fanIn.scope.regionIds;
  const productionScope = {
    productionSourceSet: {
      sourceInventory: "tools/datapack/source-inventory.json",
      requiredSourceIds: input.fanIn.selectedSources.map(({ sourceId }) => sourceId),
    },
    verifiedAccessibilityScope: { id: "five-region-routing-v1", regionIds: regions },
    supportScope: { id: "five-region-routing-v1", regionIds: regions },
    routingLaunchScope: { id: "five-region-routing-v1", regionIds: regions },
    nationwideRoadmapScope: { blocksRoutingLaunch: true, launchRequiredCount: input.tally.launchRequired.requirements.length },
  };
  const productionScopeBytes = fixtureBytes(productionScope);
  const selectedIds = new Set(input.fanIn.selectedSources.map(({ snapshotId }) => snapshotId));
  const selected = input.sourceSnapshots.filter(({ snapshotId }) => selectedIds.has(snapshotId));
  const candidate = {
    sourceSnapshotIds: selected.map(({ snapshotId }) => snapshotId),
    sourceSnapshots: selected.map(({ sourceId, snapshotId, rawSha256, freshnessExpiresAt }) =>
      ({ sourceId, snapshotId, rawSha256, freshnessExpiresAt })),
    sourceSnapshotSetHash: hash(Buffer.from(JSON.stringify(selected))),
    sourceInventorySha256: hash(Buffer.from(JSON.stringify(input.inventory))),
    networkEdgeEvidence: {
      sourceInventory: { path: "tools/datapack/source-inventory.json", sha256: hash(input.inputBytes.inventory) },
    },
    publishedAt: input.evaluatedAt,
    productionScope: { path: "release/product-gates/production-datapack-scope.json", sha256: hash(productionScopeBytes) },
    productionScopePolicy: { path: "tools/datapack/nationwide-coverage-targets.json", sha256: hash(input.inputBytes.targets) },
    productionScopeId: productionScope.routingLaunchScope.id,
  };
  const ownershipLedger = buildNationwideRequirementOwnershipLedger(input);
  return {
    ...input,
    candidate,
    productionScope,
    ownershipLedger,
    inputBytes: {
      ...input.inputBytes,
      ownershipLedger: fixtureBytes(ownershipLedger),
      productionScope: productionScopeBytes,
    },
  };
}
