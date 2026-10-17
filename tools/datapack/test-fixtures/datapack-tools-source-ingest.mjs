import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileAsync } from "./datapack-tools-support.mjs";
import { sha256 } from "../../lib/hash.mjs";

const root = path.resolve(import.meta.dirname, "../../..");

export const TEST_PRODUCTION_ACCESSIBILITY_SOURCE = "test-only-capital-accessibility-fixture";
export const TEST_ACCESSIBILITY_SNAPSHOT_ID = "test-only-capital-accessibility-fixture-20260809";
export const TEST_ACCESSIBILITY_RETRIEVED_AT = "2026-08-09T00:00:00.000Z";

export function sourceIngestInput() {
  return {
    schemaVersion: 1,
    region: "capital",
    pack: {
      id: "capital",
      version: "1",
      schemaVersion: "1",
      artifactKind: "fixture",
      url: "catalog/capital-v1.sqlite.gz",
    },
    manifest: {
      ttlSeconds: 3600,
      activePack: {
        id: "capital",
        version: "1",
      },
    },
    sourceIds: [
      "seoulmetro-station-line-info",
      "seoul-realtime-arrival-station-info",
    ],
    retiredStationIds: [
      {
        stationId: "station-retired-demo",
        reason: "closed",
        replacementStationId: "station-sadang",
      },
    ],
    operators: [
      {
        id: "seoul-metro",
        nameKo: "서울교통공사",
        nameEn: "Seoul Metro",
      },
    ],
    lines: [
      {
        id: "seoul-4",
        operatorId: "seoul-metro",
        nameKo: "수도권 4호선",
        nameEn: "Seoul Subway Line 4",
        color: "#00A5DE",
      },
    ],
    stationMappings: [
      {
        sourceId: "seoulmetro-station-line-info",
        sourceStationCode: "448",
        lineId: "seoul-4",
        stationId: "station-sangnoksu",
        stationLineId: "station-sangnoksu:seoul-4",
        mappingStatus: "active",
      },
      {
        sourceId: "seoul-realtime-arrival-station-info",
        sourceStationCode: "448",
        lineId: "seoul-4",
        stationId: "station-sangnoksu",
        stationLineId: "station-sangnoksu:seoul-4",
        mappingStatus: "active",
      },
      {
        sourceId: "seoulmetro-station-line-info",
        sourceStationCode: "433",
        lineId: "seoul-4",
        stationId: "station-sadang",
        stationLineId: "station-sadang:seoul-4",
        mappingStatus: "renamed",
        previousNames: ["총신대입구"],
      },
    ],
    stationLineRows: [
      {
        sourceId: "seoulmetro-station-line-info",
        sourceStationCode: "448",
        lineId: "seoul-4",
        stationNameKo: "상록수",
        stationNameEn: "Sangnoksu",
        normalizedName: "상록수",
        region: "수도권",
        latitude: 37.3028,
        longitude: 126.8666,
        stationCode: "448",
        lineSequence: 43,
        platformInfo: "당고개 방면 / 오이도 방면",
        lastVerifiedAt: "2026-06-21T00:00:00.000Z",
      },
      {
        sourceId: "seoul-realtime-arrival-station-info",
        sourceStationCode: "448",
        lineId: "seoul-4",
        stationNameKo: "상록수",
        stationNameEn: "Sangnoksu",
        normalizedName: "상록수",
        region: "수도권",
        latitude: 37.3028,
        longitude: 126.8666,
        stationCode: "448",
        lineSequence: 43,
        platformInfo: "당고개 방면 / 오이도 방면",
        lastVerifiedAt: "2026-06-21T00:00:00.000Z",
      },
      {
        sourceId: "seoulmetro-station-line-info",
        sourceStationCode: "433",
        lineId: "seoul-4",
        stationNameKo: "사당",
        stationNameEn: "Sadang",
        normalizedName: "사당",
        region: "수도권",
        latitude: 37.4766,
        longitude: 126.9816,
        stationCode: "433",
        lineSequence: 28,
        platformInfo: "당고개 방면 / 오이도 방면",
        lastVerifiedAt: "2026-06-21T00:00:00.000Z",
      },
    ],
    routeEdges: [
      {
        id: "edge-sangnoksu-sadang-seoul-4",
        sourceId: "seoulmetro-station-line-info",
        from: {
          sourceId: "seoulmetro-station-line-info",
          sourceStationCode: "448",
          lineId: "seoul-4",
        },
        to: {
          sourceId: "seoulmetro-station-line-info",
          sourceStationCode: "433",
          lineId: "seoul-4",
        },
        durationSeconds: 1860,
        distanceMeters: 18600,
        edgeType: "RIDE",
        servicePattern: "EXPRESS",
        includesStairs: false,
        stairAccessState: "STEP_FREE",
        accessibilityStatus: "AVAILABLE",
        reliabilityScore: 90,
        lastVerifiedAt: "2026-06-21T00:00:00.000Z",
      },
      {
        id: "edge-sadang-sangnoksu-seoul-4",
        sourceId: "seoulmetro-station-line-info",
        from: {
          sourceId: "seoulmetro-station-line-info",
          sourceStationCode: "433",
          lineId: "seoul-4",
        },
        to: {
          sourceId: "seoulmetro-station-line-info",
          sourceStationCode: "448",
          lineId: "seoul-4",
        },
        durationSeconds: 1860,
        distanceMeters: 18600,
        edgeType: "RIDE",
        servicePattern: "EXPRESS",
        includesStairs: false,
        stairAccessState: "STEP_FREE",
        accessibilityStatus: "AVAILABLE",
        reliabilityScore: 90,
        lastVerifiedAt: "2026-06-21T00:00:00.000Z",
      },
    ],
    facilityRows: [
      {
        id: "facility-sangnoksu-elevator-1",
        station: {
          sourceId: "seoulmetro-station-line-info",
          sourceStationCode: "448",
          lineId: "seoul-4",
        },
        type: "ELEVATOR",
        name: "상록수역 1번 승강기",
        status: "NORMAL",
        floorFrom: "B2",
        floorTo: "1F",
        description: "상록수역 승강장과 지상을 연결합니다.",
      },
    ],
    routeRegressionScope: {
      mode: "DIRECT_ONLY",
      excludedPatterns: ["TRANSFER", "MULTI_TRANSFER", "LOOP_BRANCH", "EXPRESS_LOCAL"],
      claim: "capital pilot Android v1 direct regression only; current summary RIDE edge is release-blocking and not ETA evidence until adjacent-station route graph evidence exists",
    },
    representativeRouteRegressions: [
      {
        id: "direct-local-capital",
        pattern: "DIRECT",
        fromNodeId: "station-sangnoksu:seoul-4",
        toNodeId: "station-sadang:seoul-4",
        requiredEdgeIds: ["edge-sangnoksu-sadang-seoul-4"],
      },
    ],
  };
}

export function productionSourceIngestInput() {
  const input = sourceIngestInput();
  input.pack.artifactKind = "production";
  input.pack.url = "https://datapack.example.com/easysubway/catalog/capital-v1.sqlite.gz";
  input.sourceIds = [
    "molit-urban-rail-full-route",
    "seoulmetro-station-line-info",
    TEST_PRODUCTION_ACCESSIBILITY_SOURCE,
  ];
  input.supportedV1Scope = {
    scopeId: "capital_pilot_android_v1",
    includedRegionIds: ["capital"],
    includedOperatorIds: ["seoul-metro"],
    includedLineIds: ["seoul-4"],
    includedStationIds: ["station-sangnoksu", "station-sadang"],
    facilityCoverageDenominator: {
      kind: "station_line_x_required_facility_type",
      expectedRows: 6,
    },
    requiredFacilityTypes: ["ELEVATOR", "ESCALATOR", "WHEELCHAIR_LIFT"],
  };
  input.stationMappings.unshift(
    {
      sourceId: "molit-urban-rail-full-route",
      sourceStationCode: "MOLIT-SEOUL-4-448",
      lineId: "seoul-4",
      stationId: "station-sangnoksu",
      stationLineId: "station-sangnoksu:seoul-4",
      mappingStatus: "active",
    },
    {
      sourceId: "molit-urban-rail-full-route",
      sourceStationCode: "MOLIT-SEOUL-4-433",
      lineId: "seoul-4",
      stationId: "station-sadang",
      stationLineId: "station-sadang:seoul-4",
      mappingStatus: "active",
    },
  );
  input.stationLineRows.unshift(
    {
      ...input.stationLineRows[0],
      sourceId: "molit-urban-rail-full-route",
      sourceStationCode: "MOLIT-SEOUL-4-448",
    },
    {
      ...input.stationLineRows[2],
      sourceId: "molit-urban-rail-full-route",
      sourceStationCode: "MOLIT-SEOUL-4-433",
    },
  );
  input.stationMappings = input.stationMappings.filter(
    (mapping) => mapping.sourceId !== "seoul-realtime-arrival-station-info",
  );
  input.stationLineRows = input.stationLineRows.filter(
    (row) => row.sourceId !== "seoul-realtime-arrival-station-info",
  );
  input.routeEdges = [];
  input.representativeRouteRegressions = [];
  delete input.routeRegressionScope;
  input.facilityRows = [
    [
      TEST_PRODUCTION_ACCESSIBILITY_SOURCE,
      "facility-sangnoksu-elevator-kric-1",
      "ELEVATOR",
      "상록수 엘리베이터 설치 정보",
      "MOLIT-SEOUL-4-448",
    ],
    [
      TEST_PRODUCTION_ACCESSIBILITY_SOURCE,
      "facility-sangnoksu-escalator-kric-1",
      "ESCALATOR",
      "상록수 에스컬레이터 설치 정보",
      "MOLIT-SEOUL-4-448",
    ],
    [
      TEST_PRODUCTION_ACCESSIBILITY_SOURCE,
      "facility-sangnoksu-wheelchair-lift-kric-1",
      "WHEELCHAIR_LIFT",
      "상록수 휠체어리프트 설치 정보",
      "MOLIT-SEOUL-4-448",
    ],
    [
      TEST_PRODUCTION_ACCESSIBILITY_SOURCE,
      "facility-sadang-elevator-kric-1",
      "ELEVATOR",
      "사당 엘리베이터 설치 정보",
      "MOLIT-SEOUL-4-433",
    ],
    [
      TEST_PRODUCTION_ACCESSIBILITY_SOURCE,
      "facility-sadang-escalator-kric-1",
      "ESCALATOR",
      "사당 에스컬레이터 설치 정보",
      "MOLIT-SEOUL-4-433",
    ],
    [
      TEST_PRODUCTION_ACCESSIBILITY_SOURCE,
      "facility-sadang-wheelchair-lift-kric-1",
      "WHEELCHAIR_LIFT",
      "사당 휠체어리프트 설치 정보",
      "MOLIT-SEOUL-4-433",
    ],
  ].map(([sourceId, id, type, name, sourceStationCode]) => testAccessibilitySourceRow({
    sourceId,
    id,
    station: {
      sourceId: "molit-urban-rail-full-route",
      sourceStationCode,
      lineId: "seoul-4",
    },
    type,
    name,
    status: "UNKNOWN",
    statusMeaning: "STATIC_LOCATION",
    operationalStatus: "UNKNOWN",
    installationStatus: "INSTALLED",
    providerFacilityRef: id,
    provenanceKind: "OFFICIAL_SOURCE",
    description: "test-only accessibility fixture facility evidence",
    verifiedAt: TEST_ACCESSIBILITY_RETRIEVED_AT,
    retrievedAt: TEST_ACCESSIBILITY_RETRIEVED_AT,
    sourceSnapshotId: TEST_ACCESSIBILITY_SNAPSHOT_ID,
    providerRecordHash: sha256(`provider:${id}:${sourceId}`),
    evidenceHash: sha256(`evidence:${id}:${sourceId}:2026-06-22T00:00:00.000Z`),
    confidence: 80,
  }, id));
  input.movementPathCandidates = [];
  input.minimumProductionCoverage = {
    stations: 2,
    stationLines: 2,
    routeEdges: 4,
    facilities: 6,
  };
  input.routeEdges.push(
    productionSourceAccessRouteEdge({
      id: "edge-entry-sangnoksu-seoul-4",
      sourceStationCode: "448",
      edgeType: "ENTRY",
      stationToLine: true,
    }),
    productionSourceAccessRouteEdge({
      id: "edge-exit-sangnoksu-seoul-4",
      sourceStationCode: "448",
      edgeType: "EXIT",
      stationToLine: false,
    }),
    productionSourceAccessRouteEdge({
      id: "edge-entry-sadang-seoul-4",
      sourceStationCode: "433",
      edgeType: "ENTRY",
      stationToLine: true,
    }),
    productionSourceAccessRouteEdge({
      id: "edge-exit-sadang-seoul-4",
      sourceStationCode: "433",
      edgeType: "EXIT",
      stationToLine: false,
    }),
  );
  input.coverageEvidence = [
    {
      regionId: "capital",
      operatorId: "seoul-metro",
      sourceDomain: "station_line_membership",
      sourceIds: ["molit-urban-rail-full-route", "seoulmetro-station-line-info"],
      evidence: "서울교통공사 노선별 지하철역 정보 source inventory coverageScope",
    },
    {
      regionId: "capital",
      operatorId: "seoul-metro",
      sourceDomain: "accessibility_facilities",
      sourceIds: [TEST_PRODUCTION_ACCESSIBILITY_SOURCE],
      evidence: "test-only accessibility fixture inventory coverageScope",
    },
  ];
  return input;
}

export async function importOfficialSourceInput(outputDir, input, inventoryPath = "tools/datapack/source-inventory.json", resetOutput = true) {
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  if (resetOutput) await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/import-official-sources.mjs",
      "--inventory",
      inventoryPath,
      "--input",
      inputPath,
      "--output",
      outputPath,
    ],
    { cwd: root },
  );
  return JSON.parse(await readFile(outputPath, "utf8"));
}

export async function importTestOnlyAccessibilityFixture(outputDir, input) {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  return importOfficialSourceInput(outputDir, input, await testOnlyInventoryPath(outputDir), false);
}

export async function testOnlyInventoryPath(outputDir) {
  const inventory = structuredClone(JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8")));
  if (inventory.sources.some(({ id }) => id === TEST_PRODUCTION_ACCESSIBILITY_SOURCE)) {
    throw new Error(`duplicate test-only accessibility source: ${TEST_PRODUCTION_ACCESSIBILITY_SOURCE}`);
  }
  const baseline = inventory.sources.find(({ id }) => id === "seoul-metro-accessibility");
  assert.ok(baseline, "test-only accessibility fixture requires inventory schema baseline");
  inventory.sources.push({
    ...baseline,
    id: TEST_PRODUCTION_ACCESSIBILITY_SOURCE,
    displayName: "Test-only capital accessibility fixture",
    userDisplayName: "테스트 전용 수도권 접근성 자료",
    owner: "EasySubway deterministic test",
    provider: "EasySubway deterministic test",
    providerDepartment: "test only",
    sourceSystem: "test fixture",
    datasetUrl: "https://test-only-capital-accessibility-fixture.invalid/source",
    datasetKind: "test-fixture",
    coverage: "test-only capital accessibility fixture",
    coverageScope: { regionIds: ["capital"], operatorIds: ["seoul-metro"], sourceDomains: ["accessibility_facilities"] },
    requiredForProductionPack: false,
    productionUseAllowed: true,
    updateFrequency: "test-only",
    observedDataUpdatedAt: "2026-08-09",
    retrievedAt: "2026-08-09",
    license: { type: "TEST_ONLY", name: "Test-only fixture", attribution: "EasySubway deterministic test", commercialUseAllowed: true, derivativeWorkAllowed: true, redistributionAllowed: true, evidenceUrl: "https://test-only-capital-accessibility-fixture.invalid/license" },
    fieldsProvided: ["test_only_accessibility_fixture"],
    capabilities: {
      schedule: { status: "UNSUPPORTED", productionUseAllowed: false, coverageStatus: "NOT_PROVIDED_BY_SOURCE", updateFrequency: "test-only", unsupportedNotes: "test-only fixture" },
      realtime: { status: "UNSUPPORTED", productionUseAllowed: false, liveEtaEligible: false, rateLimitStatus: "NOT_APPLICABLE", coverageStatus: "NOT_PROVIDED_BY_SOURCE", updateFrequency: "test-only", unsupportedNotes: "test-only fixture" },
      facility: { status: "SUPPORTED", productionUseAllowed: true, coverageStatus: "SOURCE_INVENTORY_COVERED", updateFrequency: "test-only", unsupportedNotes: "test-only fixture" },
    },
    admissionEvidence: { artifactKind: "test-only-admission", issue: 0, candidateId: TEST_PRODUCTION_ACCESSIBILITY_SOURCE, sourceId: TEST_PRODUCTION_ACCESSIBILITY_SOURCE, snapshotId: TEST_ACCESSIBILITY_SNAPSHOT_ID, decision: "APPROVED", approvedBy: "test-only", approvedAt: TEST_ACCESSIBILITY_RETRIEVED_AT, sampleEvidenceHash: sha256("test-source-sample"), rawSha256: sha256("test-source-raw"), schemaFingerprint: sha256("test-source-schema"), sourceSnapshotSetHash: sha256("test-source-set"), sourceInventorySha256: sha256("test-source-inventory"), adminReviewRecordHash: sha256("test-source-review"), licenseEvidenceHash: sha256("test-source-license"), aliasLedgerHash: sha256("test-source-alias"), operatorMappingLedgerHash: sha256("test-source-operator"), facilityEvidenceLedgerHash: sha256("test-source-facility"), routeEvidenceLedgerHash: sha256("test-source-route"), overrideHash: sha256("test-source-override"), admissionDurationSeconds: 0, quotaEvidence: { portal: "test-only", defaultDailyLimit: "unlimited", unlockStatus: "approved", productionUseAllowed: true }, productionUseNoteKo: "test-only fixture" },
    accessibilityAdmissionEvidence: { issue: 0, decision: "APPROVED", productionUseAllowed: true, licenseEvidenceHash: sha256("test-accessibility-license"), snapshotId: TEST_ACCESSIBILITY_SNAPSHOT_ID, snapshotPath: "test-only-capital-accessibility-fixture.invalid/snapshot", capturedAt: TEST_ACCESSIBILITY_RETRIEVED_AT, observedAt: TEST_ACCESSIBILITY_RETRIEVED_AT, freshUntil: "2026-08-10T00:00:00.000Z", rawSha256: sha256("test-accessibility-raw"), contentSha256: sha256("test-accessibility-content"), schemaFingerprint: sha256("test-accessibility-schema"), snapshotFileSha256: sha256("test-accessibility-file"), absenceEvidenceMode: "EXHAUSTIVE_LIST" },
  });
  const testInventoryPath = path.join(outputDir, "test-only-source-inventory.json");
  await writeFile(testInventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  return testInventoryPath;
}

function testAccessibilitySourceRow(row, label) {
  return {
    ...row,
    sourceId: TEST_PRODUCTION_ACCESSIBILITY_SOURCE,
    sourceSnapshotId: TEST_ACCESSIBILITY_SNAPSHOT_ID,
    providerFacilityRef: `test-only:${label}`,
    providerRecordHash: sha256(`test-only:${label}:provider`),
    evidenceHash: sha256(`test-only:${label}:evidence`),
    verifiedAt: TEST_ACCESSIBILITY_RETRIEVED_AT,
    retrievedAt: TEST_ACCESSIBILITY_RETRIEVED_AT,
    description: `test-only accessibility fixture: ${label}`,
    note: `test-only accessibility fixture: ${label}`,
  };
}

export async function capitalPilotProductionSourceInput() {
  const input = JSON.parse(
    await readFile(path.join(root, "tools/datapack/inputs/capital-pilot-production-source-input.json"), "utf8"),
  );
  return withTestProductionAccessibility(input);
}

export function withTestProductionAccessibility(input) {
  const fixture = structuredClone(input);
  const replaceSource = (value) => (
    value === "kric-station-convenience-standard"
      ? TEST_PRODUCTION_ACCESSIBILITY_SOURCE
      : value
  );
  fixture.sourceIds = fixture.sourceIds.map(replaceSource);
  fixture.facilityRows.forEach((row) => {
    if (row.sourceId === "kric-station-convenience-standard") Object.assign(row, testAccessibilitySourceRow(row, row.id));
  });
  fixture.coverageEvidence.forEach((evidence) => {
    if (evidence.sourceDomain === "accessibility_facilities") {
      evidence.sourceIds = evidence.sourceIds.map(replaceSource);
    }
  });
  fixture.accessibilityStatusEvidence?.forEach((evidence) => {
    if (evidence.sourceId === "kric-station-convenience-standard") {
      Object.assign(evidence, testAccessibilitySourceRow(evidence, `${evidence.stationId}:${evidence.lineId}:${evidence.facilityType}`));
    }
  });
  return fixture;
}

function productionSourceAccessRouteEdge({ id, sourceStationCode, edgeType, stationToLine }) {
  const stationEndpoint = {
    sourceId: "seoulmetro-station-line-info",
    sourceStationCode,
    lineId: "seoul-4",
    nodeKind: "STATION",
  };
  const stationLineEndpoint = {
    sourceId: "seoulmetro-station-line-info",
    sourceStationCode,
    lineId: "seoul-4",
  };
  return {
    id,
    sourceId: "seoulmetro-station-line-info",
    from: stationToLine ? stationEndpoint : stationLineEndpoint,
    to: stationToLine ? stationLineEndpoint : stationEndpoint,
    durationSeconds: stationToLine ? 90 : 60,
    distanceMeters: 0,
    edgeType,
    servicePattern: "",
    includesStairs: false,
    stairAccessState: "STEP_FREE",
    accessibilityStatus: "UNKNOWN",
    reliabilityScore: 90,
    provenanceKind: "OFFICIAL_SOURCE",
    verificationStatus: "VERIFIED",
    lastVerifiedAt: "2026-06-21T00:00:00.000Z",
    sourceSnapshotId: "seoulmetro-station-line-info-snapshot-20260621",
    providerRecordHash: sha256(`provider:${id}:seoulmetro-station-line-info`),
    evidenceHash: sha256(`evidence:${id}:seoulmetro-station-line-info:2026-06-21T00:00:00.000Z`),
  };
}
