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
      adminReviewRecordHash: "d".repeat(64),
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
      ({ sourceId, snapshotId, rawSha256, freshnessExpiresAt,
        adminReviewRecordHash: input.inventory.sources.find(({ id }) => id === sourceId)
          ?.admissionEvidence?.adminReviewRecordHash })),
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

export function fiveRegionDemandReferenceFixture() {
  const evaluatedAt = "2040-01-02T00:00:00.000Z";
  const seoulMetroLineIds = [
    "line-15b3b8a93259",
    "line-2b2d9eaa53d0",
    "line-3f41718e0833",
    "line-41a8c75ec9d8",
    "line-472a81add377",
    "line-80fc4d5350d4",
    "seoul-2",
    "seoul-4",
  ];
  const capitalOtherScopes = Array.from({ length: 25 }, (_, index) => ({
    regionId: "capital",
    operatorId: index < 10 ? "korail" : index < 13 ? "incheon-transit" : `capital-operator-${index + 1}`,
    lineId: `capital-line-${String(index + 1).padStart(2, "0")}`,
  }));
  const busanScopes = Array.from({ length: 6 }, (_, index) => ({
    regionId: "busan",
    operatorId: index < 4 ? "busan-transportation" : index === 4 ? "korail" : "busan-gimhae-lrt",
    lineId: `busan-line-${index + 1}`,
  }));
  const daeguScopes = Array.from({ length: 4 }, (_, index) => ({
    regionId: "daegu",
    operatorId: index < 3 ? "daegu-transportation" : "korail",
    lineId: `daegu-line-${index + 1}`,
  }));
  const daejeonScopes = [{ regionId: "daejeon", operatorId: "daejeon-transportation", lineId: "daejeon-line-1" }];
  const gwangjuScopes = [{ regionId: "gwangju", operatorId: "gwangju-transportation", lineId: "gwangju-line-1" }];

  const activeLineScopes = [
    ...busanScopes,
    ...seoulMetroLineIds.map((lineId) => ({ regionId: "capital", operatorId: "seoul-metro", lineId })),
    ...capitalOtherScopes,
    ...daeguScopes,
    ...daejeonScopes,
    ...gwangjuScopes,
  ];

  const targets = {
    schemaVersion: 2,
    artifactKind: "nationwide-datapack-coverage-targets",
    targetVersion: "2026-07-13",
    activeLineScopes,
    requiredSourceDomains: [
      { id: "schedule_timetable", releaseTier: "LAUNCH_REQUIRED", requiredFields: ["trip"] },
      {
        id: "demand_reference",
        releaseTier: "ENHANCEMENT",
        requiredFields: ["hourly_boarding_count", "hourly_alighting_count"],
      },
    ],
  };

  const scheduleSourceId = "fixture-five-region-schedule";
  const demandSourceId = "seoul-subway-hourly-boarding";
  const tally = {
    schemaVersion: 1,
    targetVersion: targets.targetVersion,
    launchRequired: {
      requirements: activeLineScopes.map((scope) => ({
        ...scope,
        sourceDomain: "schedule_timetable",
        releaseTier: "LAUNCH_REQUIRED",
        status: "INVENTORY_ADMITTED",
        admittedSourceIds: [scheduleSourceId],
      })),
    },
    enhancement: {
      requirements: activeLineScopes.map((scope) => {
        const isSeoulMetroDemand = scope.regionId === "capital"
          && scope.operatorId === "seoul-metro"
          && seoulMetroLineIds.includes(scope.lineId);
        return {
          ...scope,
          sourceDomain: "demand_reference",
          releaseTier: "ENHANCEMENT",
          requiredFieldCount: 2,
          admittedFieldCount: isSeoulMetroDemand ? 2 : 0,
          status: isSeoulMetroDemand ? "INVENTORY_ADMITTED" : "MISSING",
          missingKind: isSeoulMetroDemand ? null : "NO_ADMITTED_SOURCE",
          resolutionReviewStatus: null,
          admittedSourceIds: isSeoulMetroDemand ? [demandSourceId] : [],
        };
      }),
    },
  };

  const ownership = {
    schemaVersion: 1,
    artifactKind: "nationwide-requirement-ownership-rules",
    targetVersion: targets.targetVersion,
    ownerRules: [
      { issue: 506, regionId: "busan", sourceDomain: "route_map_positions" },
      { issue: 506, regionId: "busan", operatorId: "korail", sourceDomain: "route_map_positions" },
      { issue: 504, regionId: "gwangju", sourceDomain: "schedule_timetable" },
      { issue: 453, operatorId: "seoul-metro", sourceDomain: "demand_reference" },
      { issue: 458, operatorId: "korail", sourceDomain: "route_map_positions" },
      { issue: 454, sourceDomain: "schedule_timetable" },
      { issue: 453, sourceDomain: "demand_reference" },
      { issue: 458, sourceDomain: "route_map_positions" },
    ],
  };

  const scheduleRawSha256 = "a".repeat(64);
  const demandRawSha256 = "b".repeat(64);
  const scheduleSource = {
    id: scheduleSourceId,
    provider: "Fixture Schedule Provider",
    datasetUrl: `https://fixture.example/${scheduleSourceId}`,
    sourceSystem: "fixture-schedule-system",
    requiredForProductionPack: true,
    productionUseAllowed: true,
    coverageScope: {
      regionIds: ["busan", "capital", "daegu", "daejeon", "gwangju"],
      operatorIds: [...new Set(activeLineScopes.map(({ operatorId }) => operatorId))],
      lineIds: [...new Set(activeLineScopes.map(({ lineId }) => lineId))],
      sourceDomains: ["schedule_timetable"],
    },
    fieldsProvided: ["trip"],
    license: { commercialUseAllowed: true, derivativeWorkAllowed: true, redistributionAllowed: true },
    admissionEvidence: {
      decision: "APPROVED",
      sourceId: scheduleSourceId,
      snapshotId: `${scheduleSourceId}-snapshot`,
      rawSha256: scheduleRawSha256,
      capturedAt: "2040-01-01T00:00:00.000Z",
      freshUntil: "2040-01-03T00:00:00.000Z",
      adminReviewRecordHash: "d".repeat(64),
    },
  };

  const demandSource = {
    id: demandSourceId,
    provider: "서울특별시",
    datasetUrl: "https://data.seoul.go.kr/dataList/OA-12252/S/1/datasetView.do",
    sourceSystem: "교통카드 정산시스템",
    requiredForProductionPack: false,
    productionUseAllowed: true,
    coverageScope: {
      regionIds: ["capital"],
      operatorIds: ["seoul-metro"],
      lineIds: [...seoulMetroLineIds],
      sourceDomains: ["demand_reference"],
    },
    fieldsProvided: [
      "line",
      "station_name",
      "hourly_boarding_count",
      "hourly_alighting_count",
    ],
    license: { commercialUseAllowed: true, derivativeWorkAllowed: true, redistributionAllowed: true },
    admissionEvidence: {
      decision: "APPROVED",
      sourceId: demandSourceId,
      snapshotId: `${demandSourceId}-snapshot`,
      rawSha256: demandRawSha256,
      capturedAt: "2040-01-01T00:00:00.000Z",
      freshUntil: "2040-01-03T00:00:00.000Z",
      adminReviewRecordHash: "e".repeat(64),
    },
  };

  const inventory = { sources: [scheduleSource, demandSource] };
  const sourceSnapshots = [
    {
      schemaVersion: 1,
      artifactKind: "official-source-snapshot",
      sourceId: scheduleSource.id,
      snapshotId: `${scheduleSource.id}-snapshot`,
      provider: scheduleSource.provider,
      retrievedAt: "2040-01-01T00:00:00.000Z",
      sourceUpdatedAt: null,
      rowCount: 45,
      coverageCount: 45,
      rawSha256: scheduleRawSha256,
      schemaFingerprint: "c".repeat(64),
      redactedRequestFingerprint: "f".repeat(64),
      rawObjectUri: `oci://fixture-namespace/fixture-bucket/${scheduleSource.id}.json`,
      previousSnapshotId: null,
      freshnessExpiresAt: "2040-01-03T00:00:00.000Z",
      snapshotStatus: "LOCKED",
      schemaStatus: "PASS",
      licenseStatus: "PASS",
      fetchStatus: "SUCCESS",
      redistributionAllowed: true,
      credentialRedacted: true,
    },
  ];

  const values = { targets, tally, ownership, inventory, sourceSnapshots };
  return fixtureLedgerInput({
    ...values,
    evaluatedAt,
    inputBytes: Object.fromEntries(Object.entries(values).map(([name, value]) => [name, fixtureBytes(value)])),
  });
}
