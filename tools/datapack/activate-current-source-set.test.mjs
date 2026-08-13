import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { syncCanonicalFixture } from "./apply-accessibility-evidence-to-bundled-pack.mjs";
import { activateIncheonTopologyAdmission, activateStaticSourceRevalidations,
  buildCurrentSourcePrimaryOutputs, commitCurrentSourceActivation,
  parseCurrentSourceActivationArgs, requireCleanBuilder } from "./activate-current-source-set.mjs";
import { projectCapitalTopologyOwnership } from "./collect-capital-route-topology.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
async function readJson(relativePath) { return JSON.parse(await readFile(path.join(root, relativePath), "utf8")); }

function staticRoot(sourceId) {
  return {
    schemaVersion: 1,
    artifactKind: "official-source-snapshot",
    snapshotId: `${sourceId}-capital-admission-20260712`,
    sourceId,
    provider: sourceId.startsWith("molit-") ? "국토교통부" : "서울교통공사",
    retrievedAt: "2026-07-12T00:00:00.000Z",
    sourceUpdatedAt: "2026-06-22T00:00:00.000Z",
    rowCount: 5,
    coverageCount: 5,
    rawSha256: sha256(`raw:${sourceId}`),
    rawObjectUri: `s3://source/${sourceId}/20260712.json`,
    redactedRequestFingerprint: sha256(`request:${sourceId}`),
    schemaFingerprint: sha256(`schema:${sourceId}`),
    snapshotStatus: "LOCKED",
    schemaStatus: "PASS",
    licenseStatus: "PASS",
    fetchStatus: "SUCCESS",
    redistributionAllowed: true,
    credentialRedacted: true,
    previousSnapshotId: null,
    diffSummary: null,
    freshnessExpiresAt: "2026-08-11T00:00:00.000Z",
    rawRetentionExpiresAt: "2026-10-10T00:00:00.000Z",
    providerRecordHashes: Array.from({ length: 5 }, (_, index) => sha256(`${sourceId}:${index}`)),
  };
}

function staticRevalidation(previous, observedAt = "2026-08-13T10:30:00.000Z") {
  const observedMillis = Date.parse(observedAt);
  const date = observedAt.slice(0, 10).replaceAll("-", "");
  const evidencePayload = {
    schemaVersion: 1,
    artifactKind: "current-static-source-revalidation-evidence",
    contractVersion: "1.0.0",
    sourceId: previous.sourceId,
    previousSnapshotId: previous.snapshotId,
    observedAt,
    operation: previous.sourceId.startsWith("molit-")
      ? "molit-urban-rail-full-route-file-five-records"
      : "seoulmetro-line4-stations-one-to-five",
    rowCount: 5,
    canonicalRawSha256: previous.rawSha256,
    schemaFingerprint: previous.schemaFingerprint,
    providerRecordHashesSha256: sha256(JSON.stringify(previous.providerRecordHashes)),
    responseSha256: sha256(`response:${previous.sourceId}`),
    outcome: "NO_CHANGE_REVALIDATED",
    credentialRedacted: true,
  };
  const evidence = { ...evidencePayload, evidenceSha256: sha256(JSON.stringify(evidencePayload)) };
  const snapshot = {
    ...structuredClone(previous),
    snapshotId: `${previous.sourceId}-revalidated-${date}`,
    retrievedAt: observedAt,
    previousSnapshotId: previous.snapshotId,
    diffSummary: {
      status: "NO_CHANGE", rawHashChanged: false, schemaHashChanged: false,
      requestHashChanged: false, sourceUpdatedAtChanged: false, rowDelta: 0, coverageDelta: 0,
    },
    freshnessExpiresAt: new Date(observedMillis + 30 * 24 * 60 * 60 * 1000).toISOString(),
    rawRetentionExpiresAt: new Date(observedMillis + 90 * 24 * 60 * 60 * 1000).toISOString(),
    revalidationEvidenceSha256: evidence.evidenceSha256,
  };
  return { evidence, snapshot };
}

test("activation CLI는 Data-owned capital/Incheon snapshot paths만 수용한다", () => {
  assert.deepEqual(parseCurrentSourceActivationArgs([
    "--capital-topology", "tools/datapack/sources/capital-route-topology-20260811.json",
    "--incheon-topology", "tools/datapack/sources/incheon-transit-station-info-20260811.json",
    "--molit-revalidation-snapshot", "tools/datapack/sources/current-static-revalidation-20260811/molit-urban-rail-full-route-snapshot.json",
    "--molit-revalidation-evidence", "tools/datapack/sources/current-static-revalidation-20260811/molit-urban-rail-full-route-revalidation-evidence.json",
    "--seoul-revalidation-snapshot", "tools/datapack/sources/current-static-revalidation-20260811/seoulmetro-station-line-info-snapshot.json",
    "--seoul-revalidation-evidence", "tools/datapack/sources/current-static-revalidation-20260811/seoulmetro-station-line-info-revalidation-evidence.json",
    "--builder-git-sha", "a".repeat(40),
    "--build-now", "2026-08-11T00:00:00.000Z",
  ]), {
    check: false,
    capital_topology: "tools/datapack/sources/capital-route-topology-20260811.json",
    incheon_topology: "tools/datapack/sources/incheon-transit-station-info-20260811.json",
    molit_revalidation_snapshot: "tools/datapack/sources/current-static-revalidation-20260811/molit-urban-rail-full-route-snapshot.json",
    molit_revalidation_evidence: "tools/datapack/sources/current-static-revalidation-20260811/molit-urban-rail-full-route-revalidation-evidence.json",
    seoul_revalidation_snapshot: "tools/datapack/sources/current-static-revalidation-20260811/seoulmetro-station-line-info-snapshot.json",
    seoul_revalidation_evidence: "tools/datapack/sources/current-static-revalidation-20260811/seoulmetro-station-line-info-revalidation-evidence.json",
    builder_git_sha: "a".repeat(40),
    build_now: "2026-08-11T00:00:00.000Z",
  });
  assert.throws(() => parseCurrentSourceActivationArgs([
    "--hub-repository", "/tmp/hub",
    "--builder-git-sha", "a".repeat(40),
    "--build-now", "2026-08-11T00:00:00.000Z",
  ]), /unknown activation argument/);
});

test("current Incheon topology admission은 exact snapshot bytes와 fresh source identity에 결속된다", async () => {
  const snapshotPath = "tools/datapack/sources/incheon-transit-station-info-20260724.json";
  const [sourceInventory, snapshotBytes] = await Promise.all([
    readJson("tools/datapack/source-inventory.json"),
    readFile(path.join(root, snapshotPath)),
  ]);
  const snapshot = JSON.parse(snapshotBytes);
  const activated = activateIncheonTopologyAdmission({
    sourceInventory,
    snapshot,
    snapshotBytes,
    snapshotPath,
    now: new Date("2026-07-24T07:00:00.000Z"),
  });
  const source = activated.sources.find(({ id }) => id === "incheon-transit-station-info");

  assert.equal(source.requiredForProductionPack, false);
  assert.equal(source.productionUseAllowed, true);
  assert.equal(source.topologyAdmissionEvidence.snapshotId, "incheon-transit-station-info-20260724");
  assert.equal(source.topologyAdmissionEvidence.contentSha256, snapshot.contentSha256);
  assert.equal(source.membershipAdmissionEvidence.membershipSourceSnapshotSha256, snapshot.scopeSha256);
  assert.equal(source.routeMapAdmissionEvidence.snapshotSha256, sha256(snapshotBytes));
  assert.equal(source.routeMapAdmissionEvidence.positionsSha256, snapshot.positionsSha256);

  const changedEdges = structuredClone(snapshot);
  changedEdges.edges[0].toStationId = changedEdges.edges[2].toStationId;
  changedEdges.edgesSha256 = sha256(JSON.stringify(changedEdges.edges));
  changedEdges.contentSha256 = sha256(JSON.stringify({
    scope: changedEdges.scope,
    edges: changedEdges.edges,
    positions: changedEdges.positions,
  }));
  const changedEdgeBytes = Buffer.from(`${JSON.stringify(changedEdges)}\n`);
  assert.throws(() => activateIncheonTopologyAdmission({
    sourceInventory,
    snapshot: changedEdges,
    snapshotBytes: changedEdgeBytes,
    snapshotPath,
    now: new Date("2026-07-24T07:00:00.000Z"),
  }), /content changed; re-admission required/);

  assert.throws(() => activateIncheonTopologyAdmission({
    sourceInventory,
    snapshot,
    snapshotBytes: Buffer.concat([snapshotBytes, Buffer.from(" ")]),
    snapshotPath,
    now: new Date("2026-07-24T07:00:00.000Z"),
  }), /snapshot byte identity mismatch/);
  assert.throws(() => activateIncheonTopologyAdmission({
    sourceInventory,
    snapshot,
    snapshotBytes,
    snapshotPath,
    now: new Date("2026-07-25T06:00:00.000Z"),
  }), /snapshot is stale/);
});

test("static revalidation은 exact two NO_CHANGE child heads와 inventory evidence를 함께 활성화한다", () => {
  const previous = [
    staticRoot("molit-urban-rail-full-route"),
    staticRoot("seoulmetro-station-line-info"),
  ];
  const revalidations = previous.map((snapshot) => staticRevalidation(snapshot));
  const sourceInventory = {
    schemaVersion: 1,
    artifactKind: "production-source-inventory",
    sources: previous.map(({ sourceId, snapshotId }) => ({
      id: sourceId,
      retrievedAt: "2026-07-12",
      observedDataUpdatedAt: "2026-06-22",
      admissionEvidence: { snapshotId, rawSha256: sha256(`response:${sourceId}`) },
    })),
  };

  const activated = activateStaticSourceRevalidations({
    sourceSnapshots: previous,
    sourceInventory,
    revalidations,
    buildNow: "2026-08-13T10:30:01.000Z",
    observationDate: "20260813",
  });
  assert.equal(activated.sourceSnapshots.length, 4);
  for (const { snapshot, evidence } of revalidations) {
    const source = activated.sourceInventory.sources.find(({ id }) => id === snapshot.sourceId);
    assert.equal(source.admissionEvidence.snapshotId, snapshot.snapshotId);
    assert.equal(source.admissionEvidence.revalidationEvidenceSha256, evidence.evidenceSha256);
    assert.equal(source.admissionEvidence.revalidationResponseSha256, evidence.responseSha256);
    assert.equal(source.retrievedAt, "2026-08-13");
  }

  const tampered = structuredClone(revalidations);
  tampered[0].evidence.responseSha256 = "f".repeat(64);
  assert.throws(() => activateStaticSourceRevalidations({
    sourceSnapshots: previous,
    sourceInventory,
    revalidations: tampered,
    buildNow: "2026-08-13T10:30:01.000Z",
    observationDate: "20260813",
  }), /static revalidation evidence identity mismatch/);

  assert.throws(() => activateStaticSourceRevalidations({
    sourceSnapshots: previous,
    sourceInventory,
    revalidations: previous.map((snapshot) => staticRevalidation(snapshot, "2026-08-14T10:30:00.000Z")),
    buildNow: "2026-08-13T10:30:00.000Z",
    observationDate: "20260814",
  }), /static revalidation is outside build time/);
  assert.throws(() => activateStaticSourceRevalidations({
    sourceSnapshots: previous,
    sourceInventory,
    revalidations,
    buildNow: "2026-09-12T10:30:00.000Z",
    observationDate: "20260813",
  }), /static revalidation is outside build time/);
  assert.throws(() => activateStaticSourceRevalidations({
    sourceSnapshots: previous,
    sourceInventory,
    revalidations,
    buildNow: "2026-08-13T10:30:01.000Z",
    observationDate: "20260812",
  }), /static revalidation observation date mismatch/);
});

test("primary source set은 current KRIC·7-source·two-topology identity를 한 번에 활성화한다", async () => {
  const rawArtifactBytes = Buffer.from('{"artifact":"current"}\n');
  const previousSnapshot = {
    schemaVersion: 1, artifactKind: "official-source-snapshot",
    snapshotId: "kric-subway-timetable-line4-pilot-20260709", sourceId: "kric-subway-timetable",
    provider: "국가철도공단", retrievedAt: "2026-07-09T00:00:00Z",
    sourceUpdatedAt: "2026-07-09T00:00:00Z", serviceEffectiveAt: "2026-07-09T00:00:00Z",
    serviceEffectiveUntil: "2026-12-31T00:00:00Z", rowCount: 473,
    coverageCount: 1, rawSha256: "7c8badc40b31498d71d5326c50df0f87ee349103b18e416a32c133363e22e8cc",
    rawObjectUri: "s3://legacy/20260709.json", redactedRequestFingerprint: "4ab1e2d84e511733f7f2c95023d853089d6f31e9a39cfe617037edc58112b1aa",
    schemaFingerprint: "44585c58909db0d14ed103ecf357291e4f337fc432e9e8938043a39097d904ff", snapshotStatus: "LOCKED",
    schemaStatus: "PASS", licenseStatus: "PASS", fetchStatus: "SUCCESS",
    redistributionAllowed: true, credentialRedacted: true, previousSnapshotId: null,
    diffSummary: null, freshnessExpiresAt: "2026-08-08T00:00:00.000Z",
    rawRetentionExpiresAt: "2026-10-07T00:00:00.000Z",
  };
  const sourceIds = ["molit-urban-rail-full-route", "seoulmetro-station-line-info",
    "seoulmetro-cyberstation-route-map", "kric-subway-timetable", "seoul-metro-accessibility",
    "kric-station-convenience-standard", "seoul-metro-official-od-fares"];
  const inventory = {
    schemaVersion: 1,
    artifactKind: "production-source-inventory",
    sources: sourceIds.map((id) => ({
      id,
      ...(id === "kric-subway-timetable" ? {
        observedDataUpdatedAt: "2026-07-09",
        retrievedAt: "2026-07-09",
        admissionEvidence: {
          snapshotId: previousSnapshot.snapshotId,
          rawSha256: previousSnapshot.rawSha256,
        },
      } : {}),
      ...(id === "kric-station-convenience-standard" ? {
        requiredForProductionPack: false,
        productionUseAllowed: false,
        admissionEvidence: { productionUseNoteKo: "provenance only" },
      } : {}),
    })),
  };
  const officialOdFareQuotes = [{ sourceId: "seoul-metro-official-od-fares", direction: "UP" },
    { sourceId: "seoul-metro-official-od-fares", direction: "DOWN" }];
  const handoff = {
    hubCommit: "9251acdcc563975e8757d61f03e398d10c935d8b", rawSizeBytes: rawArtifactBytes.length,
    rawSha256: sha256(rawArtifactBytes), rawObjectUri: `oci://easysubway-datapacks/source-raw/kric-subway-timetable/20260809/${sha256(rawArtifactBytes)}.json`,
    snapshotId: "kric-subway-timetable-line4-pilot-20260809", previousSnapshotId: previousSnapshot.snapshotId,
    collectedAt: "2026-08-09T12:04:20.479Z", serviceEffectiveUntil: "2026-12-31T00:00:00Z",
    rowCount: 466, coverageCount: 1, freshnessExpiresAt: "2026-09-08T12:04:20.479Z",
    rawRetentionExpiresAt: "2026-11-07T12:04:20.479Z", redactedRequestFingerprint: "bb6302775c0afecf0b5e6d3c7e4bf89cdec4a2cfef01fbb80d2ea5ace234f0f7",
    schemaFingerprint: "44585c58909db0d14ed103ecf357291e4f337fc432e9e8938043a39097d904ff", governancePolicyVersion: "2026-07-15",
    governancePolicySha256: "96fb678f2ec5da7f555d81d9d2009ac838e6145cc48ed2ae4757bce42c90ef70",
  };
  const [baselineTopology, fullCapitalTopology, incheonTopologyInput] = await Promise.all([
    readJson("tools/datapack/sources/capital-route-topology-20260724.json"),
    readJson("tools/datapack/sources/capital-route-topology-20260804.json"),
    readJson("tools/datapack/sources/incheon-transit-station-info-20260724.json"),
  ]);
  const currentTopology = {
    ...projectCapitalTopologyOwnership(fullCapitalTopology),
    capturedAt: "2026-08-10T20:21:15.000Z",
    freshUntil: "2026-08-11T20:21:15.000Z",
  };
  const currentTopologyBytes = Buffer.from(`${JSON.stringify(currentTopology)}\n`);
  const currentIncheonTopology = {
    ...incheonTopologyInput,
    capturedAt: "2026-08-10T20:21:15.000Z",
    freshUntil: "2026-08-11T20:21:15.000Z",
  };
  const currentIncheonTopologyBytes = Buffer.from(`${JSON.stringify(currentIncheonTopology)}\n`);
  const result = buildCurrentSourcePrimaryOutputs({
    handoff,
    rawArtifact: { collectedAt: handoff.collectedAt },
    rawArtifactBytes,
    sourceSnapshots: [previousSnapshot],
    sourceInventory: inventory,
    productionInput: { sourceIds: sourceIds.slice(0, 6) },
    officialOdFareQuotes,
    baselineTopology,
    currentTopology,
    currentTopologyBytes,
    currentTopologyPath: "tools/datapack/sources/capital-route-topology-20260810.json",
    currentIncheonTopology,
    currentIncheonTopologyBytes,
    currentIncheonTopologyPath: "tools/datapack/sources/incheon-transit-station-info-20260810.json",
    buildNow: "2026-08-10T21:00:00.000Z",
    snapshotBytesByPath: new Map(),
    applyScheduleImpl(input) {
      return {
        ...input,
        scheduleProvenance: {
          sourceId: "kric-subway-timetable",
          sourceSnapshotId: handoff.snapshotId,
          providerRecordHash: handoff.rawSha256,
          evidenceHash: "e".repeat(64),
          retrievedAt: handoff.collectedAt,
        },
        transitRoutes: [{}],
        transitTrips: [{}],
        transitStopTimes: [{}],
      };
    },
    rebindTopologyAdmissionsImpl({ inventory: value, topologySnapshotId }) {
      assert.equal(topologySnapshotId, "capital-route-topology-20260810");
      return { ...value, topologyAdmissionsRebound: true };
    },
    activateIncheonTopologyAdmissionImpl({ sourceInventory: value, snapshotPath }) {
      assert.equal(snapshotPath, "tools/datapack/sources/incheon-transit-station-info-20260810.json");
      return { ...value, incheonAdmissionsRebound: true };
    },
    buildTopologyReverificationImpl(baseline, current) {
      assert.equal(baseline.lines.some(({ lineId }) => lineId === "line-98718184f016"), false);
      assert.equal(current.lines.some(({ lineId }) => lineId === "line-98718184f016"), false);
      return { artifactKind: "capital-topology-reverification-evidence" };
    },
  });

  assert.equal(result.sourceSnapshots.at(-1).snapshotId, handoff.snapshotId);
  assert.deepEqual(result.sourceSnapshots.at(-1).diffSummary, {
    status: "CHANGED",
    rawHashChanged: true,
    schemaHashChanged: false,
    requestHashChanged: true,
    sourceUpdatedAtChanged: true,
    rowDelta: -7,
    coverageDelta: 0,
  });
  const currentTimetable = result.sourceInventory.sources.find(({ id }) => id === "kric-subway-timetable");
  assert.equal(currentTimetable.admissionEvidence.snapshotId, handoff.snapshotId);
  assert.equal(currentTimetable.admissionEvidence.rawSha256, handoff.rawSha256);
  const convenience = result.sourceInventory.sources.find(({ id }) => id === "kric-station-convenience-standard");
  assert.equal(convenience.requiredForProductionPack, true);
  assert.equal(convenience.productionUseAllowed, true);
  assert.equal(result.sourceInventory.topologyAdmissionsRebound, true);
  assert.equal(result.sourceInventory.incheonAdmissionsRebound, true);
  assert.deepEqual(result.productionInput.sourceIds, sourceIds);
  assert.deepEqual(result.productionInput.officialOdFareQuotes, officialOdFareQuotes);
  assert.deepEqual(result.productionInput.routeServiceArtifactEvidence, []);
  assert.deepEqual(result.productionInput.movementPathCandidates, []);
  assert.equal(result.productionInput.scheduleProvenance.sourceSnapshotId, handoff.snapshotId);
  assert.equal(result.topologyReverification.artifactKind, "capital-topology-reverification-evidence");
});

test("current 7-source input은 exact OD fare 2건과 빈 legacy route evidence를 reviewed pack에 보존한다", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "current-source-import-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));

  const inventory = await readJson("tools/datapack/source-inventory.json");
  const input = await readJson("tools/datapack/inputs/capital-pilot-production-source-input.json");
  const quoteBundle = await readJson("tools/datapack/official-od-fare-quotes.json");
  const convenienceSource = inventory.sources.find(({ id }) => id === "kric-station-convenience-standard");
  assert.ok(convenienceSource);
  convenienceSource.productionUseAllowed = true;

  const fareSourceId = "seoul-metro-official-od-fares";
  input.sourceIds = [...input.sourceIds, fareSourceId];
  input.coverageEvidence = [
    ...input.coverageEvidence,
    {
      regionId: "capital",
      operatorId: "seoul-metro",
      sourceDomain: "official_od_fares",
      sourceIds: [fareSourceId],
      evidence: "승인된 서울교통공사 양방향 OD fare snapshot",
    },
  ];
  input.officialOdFareQuotes = quoteBundle.quotes.filter(({ sourceId }) => sourceId === fareSourceId);
  input.routeServiceArtifactEvidence = [];
  input.movementPathCandidates = [];

  const inventoryPath = path.join(workspace, "source-inventory.json");
  const inputPath = path.join(workspace, "production-input.json");
  const outputPath = path.join(workspace, "reviewed-pack.json");
  await writeFile(inventoryPath, `${JSON.stringify(inventory)}\n`);
  await writeFile(inputPath, `${JSON.stringify(input)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/import-official-sources.mjs",
      "--inventory", inventoryPath,
      "--input", inputPath,
      "--output", outputPath,
    ],
    { cwd: root },
  );

  const reviewedPack = JSON.parse(await readFile(outputPath, "utf8")).packs[0];
  assert.equal(reviewedPack.sourceInventory.some(({ id }) => id === fareSourceId), true);
  assert.deepEqual(reviewedPack.officialOdFareQuotes, input.officialOdFareQuotes);
  assert.deepEqual(reviewedPack.routeServiceArtifactEvidence, []);
  assert.deepEqual(reviewedPack.movementPathCandidates, []);
  const syncedCanonical = syncCanonicalFixture(
    await readJson("tools/datapack/release/capital-production-canonical-pack.json"), reviewedPack);
  const syncedCapital = syncedCanonical.packs.find(({ id }) => id === "capital");
  assert.equal(syncedCapital.sourceInventory.some(({ id }) => id === fareSourceId), true);
  assert.deepEqual(syncedCapital.officialOdFareQuotes, input.officialOdFareQuotes);
  assert.deepEqual(syncedCapital.internalRouteEdges, []);
});

test("canonical sync는 current source와 Seoul OD만 교체하고 legacy route evidence를 제거한다", () => {
  const canonical = { packs: [{
        id: "capital",
        facilities: [],
        dataQualityRecords: [],
        stationFacilityEvidence: [],
        networkEdges: [],
        internalRouteEdges: [],
        stationExits: [],
        sourceInventory: [
          { id: "kric-subway-timetable", updatedAt: "old" },
          { id: "kric-station-elevator-movement", updatedAt: "retired" },
          { id: "regional-unrelated-source", updatedAt: "preserved" },
        ],
        officialOdFareQuotes: [
          { sourceId: "seoul-metro-official-od-fares", snapshotId: "old-seoul" },
          { sourceId: "seoul-metro-official-od-fare-canary", snapshotId: "canary" },
          { sourceId: "busan-transportation-official-od-fares", snapshotId: "busan" },
        ],
        routeServiceArtifactEvidence: [{ sourceId: "legacy-route-service" }],
        movementPathCandidates: [{ sourceId: "kric-station-elevator-movement" }],
        requiredTables: ["catalog_metadata"],
        minimumTableRows: { facilities: 0, station_facility_evidence: 0 },
        metadata: { productionCoverageEvidence: "[]" },
      }] };
  const reviewedPack = {
    facilities: [],
    stationFacilityEvidence: [],
    networkEdges: [],
    sourceInventory: [
      { id: "kric-subway-timetable", updatedAt: "current" },
      { id: "seoul-metro-official-od-fares", updatedAt: "current" },
    ],
    officialOdFareQuotes: [
      { sourceId: "seoul-metro-official-od-fares", snapshotId: "current-seoul-up" },
      { sourceId: "seoul-metro-official-od-fares", snapshotId: "current-seoul-down" },
    ],
    routeServiceArtifactEvidence: [],
    movementPathCandidates: [],
    requiredTables: ["catalog_metadata"],
    metadata: {
      productionCoverageEvidence: "[]",
    },
  };

  const pack = syncCanonicalFixture(structuredClone(canonical), reviewedPack).packs[0];
  assert.deepEqual(pack.sourceInventory, [
    { id: "regional-unrelated-source", updatedAt: "preserved" },
    { id: "kric-subway-timetable", updatedAt: "current" },
    { id: "seoul-metro-official-od-fares", updatedAt: "current" },
  ]);
  assert.deepEqual(pack.officialOdFareQuotes, [
    { sourceId: "seoul-metro-official-od-fares", snapshotId: "current-seoul-up" },
    { sourceId: "seoul-metro-official-od-fares", snapshotId: "current-seoul-down" },
  ]);
  assert.deepEqual(pack.routeServiceArtifactEvidence, []);
  assert.deepEqual(pack.movementPathCandidates, []);
  assert.ok(pack.requiredTables.includes("official_od_fare_quotes"));
  assert.equal(pack.minimumTableRows.official_od_fare_quotes, 2);
});

test("activation transaction은 검증 실패에서 모든 기존 bytes를 복구하고 residue를 남기지 않는다", async (context) => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "current-source-transaction-"));
  context.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const snapshotPath = "tools/datapack/release/source-snapshots.json";
  const inventoryPath = "tools/datapack/source-inventory.json";
  const originalSnapshotBytes = Buffer.from("old snapshots\n");
  const originalInventoryBytes = Buffer.from("old inventory\n");
  for (const relativePath of [snapshotPath, inventoryPath]) {
    await mkdir(path.dirname(path.join(repositoryRoot, relativePath)), { recursive: true });
  }
  await writeFile(path.join(repositoryRoot, snapshotPath), originalSnapshotBytes);
  await writeFile(path.join(repositoryRoot, inventoryPath), originalInventoryBytes);

  await assert.rejects(
    commitCurrentSourceActivation({
      repositoryRoot,
      outputs: [
        { relativePath: snapshotPath, bytes: Buffer.from("new snapshots\n") },
        { relativePath: inventoryPath, bytes: Buffer.from("new inventory\n") },
      ],
      validate: async () => {
        throw new Error("injected candidate validation failure");
      },
    }),
    /injected candidate validation failure/,
  );

  assert.deepEqual(await readFile(path.join(repositoryRoot, snapshotPath)), originalSnapshotBytes);
  assert.deepEqual(await readFile(path.join(repositoryRoot, inventoryPath)), originalInventoryBytes);
  assert.deepEqual(
    (await readdir(path.join(repositoryRoot, "tools/datapack")))
      .filter((name) => name.startsWith(".current-source-activation")),
    [],
  );
});

test("check mode는 builder code가 같은 output-only descendant만 수용한다", async (context) => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "current-source-builder-"));
  context.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const runGit = async (...args) => await execFileAsync("git", ["-C", repositoryRoot, ...args]);
  await runGit("init", "-q");
  await runGit("config", "user.name", "EasySubway Test");
  await runGit("config", "user.email", "test@example.invalid");
  await writeFile(path.join(repositoryRoot, "generator.mjs"), "export const version = 1;\n");
  await runGit("add", "generator.mjs");
  await runGit("-c", "commit.gpgsign=false", "commit", "-qm", "builder");
  const { stdout: builderShaOutput } = await runGit("rev-parse", "HEAD");
  const builderSha = builderShaOutput.trim();
  await writeFile(path.join(repositoryRoot, "generated.json"), "{\"version\":1}\n");
  await runGit("add", "generated.json");
  await runGit("-c", "commit.gpgsign=false", "commit", "-qm", "generated output");

  await requireCleanBuilder(builderSha, {
    check: true,
    repositoryRoot,
    allowedDescendantPaths: ["generated.json"],
  });

  await writeFile(path.join(repositoryRoot, "generator.mjs"), "export const version = 2;\n");
  await runGit("add", "generator.mjs");
  await runGit("-c", "commit.gpgsign=false", "commit", "-qm", "changed builder");
  await assert.rejects(
    requireCleanBuilder(builderSha, {
      check: true,
      repositoryRoot,
      allowedDescendantPaths: ["generated.json"],
    }),
    /builder source|builder identity/,
  );
});
