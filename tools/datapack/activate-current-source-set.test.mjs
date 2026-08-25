import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { syncCanonicalFixture } from "./apply-accessibility-evidence-to-bundled-pack.mjs";
import { projectCapitalTopologyIntoCanonicalFixture } from "./build-datapack.mjs";
import { currentIncheonStationCodeDerivations } from "./collect-incheon-station-info.mjs";
import { activateIncheonTopologyAdmission, activateStaticSourceRevalidations,
  buildCurrentCandidateSpec, buildCurrentSourcePrimaryOutputs,
  buildCurrentTopologyRefreshPrimaryOutputs, commitCurrentSourceActivation,
  collectPositionSnapshotBytes, parseCurrentSourceActivationArgs,
  parseCurrentTopologyRefreshArgs, requireCleanBuilder,
  CURRENT_PRODUCTION_SOURCE_IDS, CURRENT_SOURCE_INVENTORY_IDS,
  readBuilderBaselineBytes,
  stageValidationItxTopologyEvidence,
  validatePreparedCandidate, verifyCurrentStaticNetworkSuccessorHeads,
  verifyCurrentSeoulCanonicalMembership } from "./activate-current-source-set.mjs";
import {
  normalizeStationName,
  projectCapitalTopologyOwnership,
  requireCurrentSourceSeparatedCapitalTopology,
} from "./collect-capital-route-topology.mjs";
import { buildSnapshotDiff } from "./source-snapshot-policy.mjs";
import { currentTopologyAdmissionClock } from "./test-fixtures/current-topology-admission-clock.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const TEST_GOVERNANCE_POLICY_BINDING = Object.freeze({
  governancePolicyVersion: "2026-07-15",
  governancePolicySha256: "9".repeat(64),
});
const CURRENT_V2_TEST_NOW = new Date("2026-08-25T12:00:00.000Z");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

async function currentV2HeadsFixture() {
  const [ledger, inventory, positionFile, molitFile] = await Promise.all([
    readFile(path.join(root, "tools/datapack/release/source-snapshots.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/sources/seoul-metro-route-map-positions-current-20260824T114822985Z.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-current-20260824T114822985Z.json"), "utf8").then(JSON.parse),
  ]);
  const heads = (sourceId) => ledger.filter(({ sourceId: id }) => id === sourceId).find(({ snapshotId }) => !ledger.some(({ previousSnapshotId }) => previousSnapshotId === snapshotId));
  const make = (sourceId, file) => {
    const original = heads(sourceId);
    const capturedAt = new Date(Date.parse(original.retrievedAt) + 1).toISOString();
    const snapshotId = `${sourceId}-v2-current`; const receipt = { ...structuredClone(original.rawReceipt), snapshotId, capturedAt, storedAt: capturedAt };
    const observation = { schemaVersion: 2, artifactKind: "public-static-network-v2-observation", sourceId, snapshotId, capturedAt, rawSha256: original.rawSha256, contentSha256: original.contentSha256, schemaFingerprint: original.schemaFingerprint, rowCount: original.rowCount, providerRecordHashes: structuredClone(original.providerRecordHashes), normalizedProjection: structuredClone(file.normalizedProjection), ...(sourceId === "seoul-metro-route-map-positions" ? { routeMapLayoutEvidence: structuredClone(file.layoutEvidence), routeMapLayoutArtifact: structuredClone(file.routeMapLayoutArtifact) } : {}), rawReceipt: receipt };
    const snapshot = { ...structuredClone(original), snapshotId, retrievedAt: capturedAt, previousSnapshotId: null, diffSummary: null, rawReceipt: receipt, normalizedObservationSha256: sha256(Buffer.from(`${JSON.stringify(observation)}\n`)), publicStaticNetworkV2Observation: observation };
    delete snapshot.projectionMigration;
    delete snapshot.rootSupersession;
    if (sourceId === "seoul-metro-route-map-positions") { snapshot.routeMapLayoutEvidence = observation.routeMapLayoutEvidence; snapshot.routeMapLayoutArtifact = observation.routeMapLayoutArtifact; }
    return { snapshot, observation };
  };
  const positions = make("seoul-metro-route-map-positions", positionFile); const molit = make("molit-urban-rail-full-route", molitFile);
  const source = (id, snapshot) => { const value = structuredClone(inventory.sources.find((item) => item.id === id)); value.admissionEvidence = { ...value.admissionEvidence, snapshotId: snapshot.snapshotId, rawSha256: snapshot.rawSha256, schemaFingerprint: snapshot.schemaFingerprint }; value.requiredForProductionPack = true; value.productionUseAllowed = true; return value; };
  const positionSource = source(positions.snapshot.sourceId, positions.snapshot); const molitSource = source(molit.snapshot.sourceId, molit.snapshot);
  positionSource.routeMapAdmissionEvidence.currentLayoutAdmission = { schemaVersion: 2, artifactKind: "seoul-public-route-map-layout-admission", status: "ADMITTED", positionSnapshotId: positions.snapshot.snapshotId, snapshotPath: `tools/datapack/sources/${positions.snapshot.snapshotId}.json`, snapshotSha256: positions.snapshot.normalizedObservationSha256, rawSha256: positions.snapshot.rawSha256, contentSha256: positions.snapshot.contentSha256, ...positions.snapshot.routeMapLayoutEvidence };
  return { sourceSnapshots: [positions.snapshot, molit.snapshot], sourceInventory: { schemaVersion: 1, artifactKind: "production-source-inventory", sources: [positionSource, molitSource] } };
}
async function readJson(relativePath) { return JSON.parse(await readFile(path.join(root, relativePath), "utf8")); }

function currentSuccessorGateFixture() {
  const oldMolitHashes = Array.from({ length: 5 }, (_, index) => sha256(`old-molit:${index}`));
  const oldMolit = {
    snapshotId: "molit-urban-rail-full-route-capital-admission-20260712",
    sourceId: "molit-urban-rail-full-route",
    retrievedAt: "2026-07-12T00:00:00.000Z",
    sourceUpdatedAt: "2026-06-22T00:00:00.000Z",
    rowCount: 5,
    coverageCount: 5,
    rawSha256: sha256("old-molit-raw"),
    schemaFingerprint: sha256("old-molit-schema"),
    redactedRequestFingerprint: sha256("old-molit-request"),
    providerRecordHashes: oldMolitHashes,
    previousSnapshotId: null,
    diffSummary: null,
  };
  const molitRawSha256 = sha256("current-full-molit-raw");
  const molitHashes = Array.from({ length: 1103 }, (_, index) => sha256(`current-molit:${index}`));
  const molit = {
    ...oldMolit,
    snapshotId: "molit-urban-rail-full-route-current-20260822T000000000Z",
    retrievedAt: "2026-08-22T00:00:00.000Z",
    sourceUpdatedAt: "2025-12-11T00:00:00.000Z",
    rowCount: molitHashes.length,
    coverageCount: molitHashes.length,
    rawSha256: molitRawSha256,
    schemaFingerprint: sha256("current-full-molit-schema"),
    redactedRequestFingerprint: sha256("current-full-molit-request"),
    providerRecordHashes: molitHashes,
    contentSha256: sha256("current-full-molit-content"),
    previousSnapshotId: oldMolit.snapshotId,
    projectionMigration: {
      migrationKind: "LEGACY_SAMPLE_TO_FULL_CONSUMED_FIELDS",
      sourceId: "molit-urban-rail-full-route",
      legacySnapshotId: oldMolit.snapshotId,
      legacyRawSha256: oldMolit.rawSha256,
      legacySchemaFingerprint: oldMolit.schemaFingerprint,
      legacyProviderRecordHashes: oldMolit.providerRecordHashes,
      fullProjectionSha256: sha256("current-full-molit-content"),
      fullProjectionSchemaFingerprint: sha256("current-full-molit-schema"),
      fullProjectionRowCount: molitHashes.length,
      newSnapshotId: "molit-urban-rail-full-route-current-20260822T000000000Z",
    },
  };
  molit.diffSummary = buildSnapshotDiff(oldMolit, molit);
  const molitObjectKey = `source-raw/${molit.sourceId}/20260822/${molit.rawSha256}.csv`;
  molit.rawObjectUri = `oci://axvym6vk8g7i/easysubway-datapacks/${molitObjectKey}`;
  molit.rawReceipt = {
    schemaVersion: 1,
    artifactKind: "static-network-source-raw-object-receipt",
    sourceId: molit.sourceId,
    snapshotId: molit.snapshotId,
    capturedAt: molit.retrievedAt,
    rawObjectSha256: molit.rawSha256,
    rawObjectUri: molit.rawObjectUri,
    ociNamespace: "axvym6vk8g7i",
    bucket: "easysubway-datapacks",
    objectKey: molitObjectKey,
    contentType: "text/csv; charset=euc-kr",
    byteSize: 123,
  };

  const cyber = {
    snapshotId: "seoulmetro-cyberstation-route-map-capital-admission-20260712",
    sourceId: "seoulmetro-cyberstation-route-map",
    retrievedAt: "2026-07-12T00:00:00.000Z",
    sourceUpdatedAt: "2026-06-28T00:00:00.000Z",
    rowCount: 2,
    coverageCount: 2,
    rawSha256: sha256("historical-cyber-raw"),
    schemaFingerprint: sha256("historical-cyber-schema"),
    redactedRequestFingerprint: sha256("historical-cyber-request"),
    previousSnapshotId: null,
    diffSummary: null,
  };
  const positionRawSha256 = sha256("current-public-position-raw");
  const artifact = {
    rawSha256: positionRawSha256,
    layoutAlgorithmVersion: "seoul-public-latlon-line-order-layout-v2",
    topologySnapshotId: "capital-route-topology-20260814",
    topologySnapshotSha256: sha256("topology-snapshot"),
    topologySnapshotIdentity: "capital-route-topology-20260814:seoul-1-8",
    lineOrderSha256: sha256("line-order"),
    aliasLedgerVersion: "1",
    aliasLedgerSha256: sha256("alias-ledger"),
    rawPositionsSha256: sha256("raw-positions"),
    layoutPositionsSha256: sha256("layout-positions"),
    layoutTracksSha256: sha256("layout-tracks"),
    semanticInputSha256: sha256("semantic-input"),
    semanticOutputSha256: sha256("semantic-output"),
    outputSchemaSha256: sha256("output-schema"),
  };
  const layoutArtifactSha256 = sha256(Buffer.from(`${JSON.stringify(artifact)}\n`));
  const layout = { ...artifact, layoutArtifactSha256 };
  delete layout.rawSha256;
  const positions = {
    snapshotId: "seoul-metro-route-map-positions-current-20260822T000000000Z",
    sourceId: "seoul-metro-route-map-positions",
    retrievedAt: "2026-08-22T00:00:00.000Z",
    sourceUpdatedAt: "2025-08-14T00:00:00.000Z",
    rowCount: 276,
    coverageCount: 276,
    rawSha256: positionRawSha256,
    schemaFingerprint: sha256("current-public-position-schema"),
    redactedRequestFingerprint: sha256("current-public-position-request"),
    providerRecordHashes: Array.from({ length: 276 }, (_, index) => sha256(`position:${index}`)),
    contentSha256: sha256("current-public-position-content"),
    normalizedObservationSha256: sha256("normalized-position-observation"),
    previousSnapshotId: null,
    diffSummary: null,
    projectionMigration: {
      migrationKind: "CROSS_SOURCE_CANONICAL_REPLACEMENT",
      sourceId: "seoul-metro-route-map-positions",
      replacedSourceId: cyber.sourceId,
      replacedSnapshotId: cyber.snapshotId,
      replacedRawSha256: cyber.rawSha256,
      replacedSchemaFingerprint: cyber.schemaFingerprint,
      candidateSlotSourceId: cyber.sourceId,
    },
    routeMapLayoutArtifact: artifact,
    routeMapLayoutEvidence: layout,
  };
  const positionObjectKey = `source-raw/${positions.sourceId}/20260822/${positions.rawSha256}.json`;
  positions.rawObjectUri = `oci://axvym6vk8g7i/easysubway-datapacks/${positionObjectKey}`;
  positions.rawReceipt = {
    schemaVersion: 1,
    artifactKind: "static-network-source-raw-object-receipt",
    sourceId: positions.sourceId,
    snapshotId: positions.snapshotId,
    capturedAt: positions.retrievedAt,
    rawObjectSha256: positions.rawSha256,
    rawObjectUri: positions.rawObjectUri,
    ociNamespace: "axvym6vk8g7i",
    bucket: "easysubway-datapacks",
    objectKey: positionObjectKey,
    contentType: "application/json",
    byteSize: 456,
  };
  const currentLayoutAdmission = {
    schemaVersion: 2,
    artifactKind: "seoul-public-route-map-layout-admission",
    status: "ADMITTED",
    positionSnapshotId: positions.snapshotId,
    snapshotPath: `tools/datapack/sources/${positions.snapshotId}.json`,
    snapshotSha256: positions.normalizedObservationSha256,
    rawSha256: positions.rawSha256,
    contentSha256: positions.contentSha256,
    ...layout,
  };
  return {
    sourceSnapshots: [oldMolit, molit, cyber, positions],
    sourceInventory: {
      schemaVersion: 1,
      artifactKind: "production-source-inventory",
      sources: [
        {
          id: molit.sourceId,
          admissionEvidence: {
            snapshotId: molit.snapshotId,
            rawSha256: molit.rawSha256,
            schemaFingerprint: molit.schemaFingerprint,
          },
        },
        {
          id: positions.sourceId,
          admissionEvidence: {
            snapshotId: positions.snapshotId,
            rawSha256: positions.rawSha256,
            schemaFingerprint: positions.schemaFingerprint,
          },
          routeMapAdmissionEvidence: { currentLayoutAdmission },
          requiredForProductionPack: true,
          productionUseAllowed: true,
        },
        {
          id: cyber.sourceId,
          requiredForProductionPack: false,
          productionUseAllowed: false,
        },
      ],
    },
  };
}

test("current activation does not mistake a legacy predecessor fixture for a V2 current head", () => {
  assert.throws(
    () => verifyCurrentStaticNetworkSuccessorHeads(currentSuccessorGateFixture()),
    /V2_MISSING/,
  );
});

test("current activation succeeds only for two embedded schema-2 v2 heads", async () => {
  const fixture = await currentV2HeadsFixture();
  const result = verifyCurrentStaticNetworkSuccessorHeads({ ...fixture, now: CURRENT_V2_TEST_NOW });
  assert.equal(result.positions.publicStaticNetworkV2Observation.schemaVersion, 2);
  assert.equal(result.molit.publicStaticNetworkV2Observation.schemaVersion, 2);
  const mixed = structuredClone(fixture);
  delete mixed.sourceSnapshots.find(({ sourceId, publicStaticNetworkV2Observation }) =>
    sourceId === "molit-urban-rail-full-route" && publicStaticNetworkV2Observation?.schemaVersion === 2,
  ).publicStaticNetworkV2Observation;
  assert.throws(() => verifyCurrentStaticNetworkSuccessorHeads({ ...mixed, now: CURRENT_V2_TEST_NOW }), /V2_MIXED/);
  for (const mutate of [
    (head) => { head.publicStaticNetworkV2Observation.artifactKind = "wrong"; },
    (head) => { head.publicStaticNetworkV2Observation.capturedAt = "2026-08-25T12:00:00.000Z"; },
  ]) {
    const invalid = await currentV2HeadsFixture();
    const molit = invalid.sourceSnapshots.find(({ sourceId, publicStaticNetworkV2Observation }) =>
      sourceId === "molit-urban-rail-full-route" && publicStaticNetworkV2Observation?.schemaVersion === 2,
    );
    mutate(molit);
    molit.normalizedObservationSha256 = sha256(Buffer.from(`${JSON.stringify(molit.publicStaticNetworkV2Observation)}\n`));
    assert.throws(() => verifyCurrentStaticNetworkSuccessorHeads({ ...invalid, now: CURRENT_V2_TEST_NOW }), /current v2 successor binding is invalid/);
  }
  for (const sourceId of ["seoul-metro-route-map-positions", "molit-urban-rail-full-route"]) {
    const invalid = await currentV2HeadsFixture();
    const source = invalid.sourceInventory.sources.find(({ id }) => id === sourceId);
    source.requiredForProductionPack = false;
    assert.throws(() => verifyCurrentStaticNetworkSuccessorHeads({ ...invalid, now: CURRENT_V2_TEST_NOW }), /current v2 production source is invalid/);
  }
  const reset = structuredClone(fixture);
  reset.sourceSnapshots.find(({ sourceId }) => sourceId === "seoul-metro-route-map-positions").rootSupersession = {
    schemaVersion: 1, artifactKind: "source-root-supersession", sourceId: "seoul-metro-route-map-positions",
  };
  assert.throws(() => verifyCurrentStaticNetworkSuccessorHeads({ ...reset, now: CURRENT_V2_TEST_NOW }), /(?:current v2 successor binding is invalid|SOURCE_LINEAGE_BROKEN)/);
  const cyberSnapshot = structuredClone(fixture);
  cyberSnapshot.sourceSnapshots.push({ snapshotId: "cyber", sourceId: "seoulmetro-cyberstation-route-map", previousSnapshotId: null });
  assert.throws(() => verifyCurrentStaticNetworkSuccessorHeads({ ...cyberSnapshot, now: CURRENT_V2_TEST_NOW }), /SOURCE_LINEAGE_BROKEN/);
  const cyberInventory = structuredClone(fixture);
  cyberInventory.sourceInventory.sources.find(({ id }) => id === "seoul-metro-route-map-positions").metadata = { diagnosticSource: "Cyberstation" };
  assert.throws(() => verifyCurrentStaticNetworkSuccessorHeads({ ...cyberInventory, now: CURRENT_V2_TEST_NOW }), /current v2 selected path is invalid/);
});

test("current activation accepts registrar-shaped same-source V2 lineage while rejecting non-V2 and cross-source predecessors", async () => {
  const fixture = await currentV2HeadsFixture();
  const append = (sourceId) => {
    const previous = fixture.sourceSnapshots.find((snapshot) => snapshot.sourceId === sourceId);
    const capturedAt = new Date(Date.parse(previous.retrievedAt) + 1).toISOString();
    const snapshotId = `${sourceId}-v2-successor`;
    const receipt = { ...structuredClone(previous.rawReceipt), snapshotId, capturedAt, storedAt: capturedAt };
    const observation = {
      ...structuredClone(previous.publicStaticNetworkV2Observation), snapshotId, capturedAt, rawReceipt: receipt,
    };
    const snapshot = {
      ...structuredClone(previous), snapshotId, retrievedAt: capturedAt, previousSnapshotId: previous.snapshotId,
      rawReceipt: receipt, publicStaticNetworkV2Observation: observation,
    };
    snapshot.normalizedObservationSha256 = sha256(Buffer.from(`${JSON.stringify(observation)}\n`));
    snapshot.diffSummary = buildSnapshotDiff(previous, snapshot);
    fixture.sourceSnapshots.push(snapshot);
    const source = fixture.sourceInventory.sources.find(({ id }) => id === sourceId);
    source.admissionEvidence = { ...source.admissionEvidence, snapshotId, rawSha256: snapshot.rawSha256, schemaFingerprint: snapshot.schemaFingerprint };
    if (sourceId === "seoul-metro-route-map-positions") {
      source.routeMapAdmissionEvidence.currentLayoutAdmission = {
        ...source.routeMapAdmissionEvidence.currentLayoutAdmission,
        positionSnapshotId: snapshotId,
        snapshotPath: `tools/datapack/sources/${snapshotId}.json`,
        snapshotSha256: snapshot.normalizedObservationSha256,
      };
    }
    return snapshot;
  };
  const positionHead = append("seoul-metro-route-map-positions");
  append("molit-urban-rail-full-route");
  assert.equal(verifyCurrentStaticNetworkSuccessorHeads({ ...fixture, now: CURRENT_V2_TEST_NOW }).positions.snapshotId, positionHead.snapshotId);

  const nonV2 = structuredClone(fixture);
  delete nonV2.sourceSnapshots.find(({ snapshotId }) => snapshotId === positionHead.previousSnapshotId).publicStaticNetworkV2Observation;
  assert.throws(() => verifyCurrentStaticNetworkSuccessorHeads({ ...nonV2, now: CURRENT_V2_TEST_NOW }), /current v2 successor binding is invalid/);

  const crossSource = structuredClone(fixture);
  const crossSourceHead = crossSource.sourceSnapshots.find(({ snapshotId }) => snapshotId === positionHead.snapshotId);
  crossSourceHead.previousSnapshotId = crossSource.sourceSnapshots.find(({ sourceId }) => sourceId === "molit-urban-rail-full-route").snapshotId;
  crossSourceHead.diffSummary = buildSnapshotDiff(
    crossSource.sourceSnapshots.find(({ snapshotId }) => snapshotId === crossSourceHead.previousSnapshotId),
    crossSourceHead,
  );
  assert.throws(() => verifyCurrentStaticNetworkSuccessorHeads({ ...crossSource, now: CURRENT_V2_TEST_NOW }), /(?:current v2 successor binding is invalid|SOURCE_LINEAGE_BROKEN)/);
});

test("current activation rejects legacy fields on selected snapshot, observation, and matched inventory source", async () => {
  const mutations = [
    (fixture) => { fixture.sourceSnapshots[0].historicalPredecessorAudit = { archive: "s3://legacy" }; },
    (fixture) => { fixture.sourceSnapshots[0].publicStaticNetworkV2Observation.audit = { nested: { migration: "Cyberstation" } }; },
    (fixture) => { fixture.sourceInventory.sources[0].metadata = { audit: { archivedUri: "s3://legacy" } }; },
  ];
  for (const mutate of mutations) {
    const fixture = await currentV2HeadsFixture();
    mutate(fixture);
    assert.throws(() => verifyCurrentStaticNetworkSuccessorHeads({ ...fixture, now: CURRENT_V2_TEST_NOW }), /current v2 selected path is invalid/);
  }
});

test("current activation exact-binds every embedded v2 observation to its outer snapshot", async () => {
  const mutations = [
    (head) => { head.publicStaticNetworkV2Observation.rawSha256 = "0".repeat(64); },
    (head) => { head.publicStaticNetworkV2Observation.contentSha256 = "0".repeat(64); },
    (head) => { head.publicStaticNetworkV2Observation.schemaFingerprint = "0".repeat(64); },
    (head) => { head.publicStaticNetworkV2Observation.rowCount -= 1; },
    (head) => { head.publicStaticNetworkV2Observation.providerRecordHashes[0] = "0".repeat(64); },
    (head) => { head.publicStaticNetworkV2Observation.rawReceipt.byteSize += 1; },
    (head) => { head.publicStaticNetworkV2Observation.normalizedProjection[0].stationName += "-drift"; },
    (head) => { head.snapshotStatus = "REJECTED"; },
    (head) => { head.freshnessExpiresAt = "2026-08-25T11:00:00.000Z"; },
    (head) => { head.rawRetentionExpiresAt = "2026-08-25T11:00:00.000Z"; head.rawReceipt.rawRetentionExpiresAt = head.rawRetentionExpiresAt; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const fixture = await currentV2HeadsFixture();
    const molit = fixture.sourceSnapshots.find(({ sourceId, publicStaticNetworkV2Observation }) =>
      sourceId === "molit-urban-rail-full-route" && publicStaticNetworkV2Observation?.schemaVersion === 2,
    );
    molit.publicStaticNetworkV2Observation.rawReceipt = structuredClone(molit.publicStaticNetworkV2Observation.rawReceipt);
    mutate(molit);
    molit.normalizedObservationSha256 = sha256(Buffer.from(`${JSON.stringify(molit.publicStaticNetworkV2Observation)}\n`));
    assert.throws(() => verifyCurrentStaticNetworkSuccessorHeads({ ...fixture, now: CURRENT_V2_TEST_NOW }), /current v2 successor (?:binding|canonical outer snapshot) is invalid/, `mutation ${index}`);
  }
});

test("activation은 current public route-map admission의 scoped 1–8 authority를 결속한다", async () => {
  const inventory = await readJson("tools/datapack/source-inventory.json");
  const sources = inventory.sources.filter(({ id }) => id === "seoul-metro-route-map-positions");
  assert.equal(sources.length, 1);
  const source = sources[0];
  const layout = source.routeMapAdmissionEvidence?.currentLayoutAdmission;
  const topology = source.routeMapAdmissionEvidence?.currentTopologyAdmission;
  assert.equal(source.coverageScope.operatorIds.length, 1);
  assert.equal(source.coverageScope.operatorIds[0], "seoul-metro");
  assert.equal(layout.status, "ADMITTED");
  assert.equal(topology.status, "ADMITTED");
  assert.notEqual(layout.topologySnapshotId, topology.topologySnapshotId);
  assert.equal(topology.positionSnapshotSha256, layout.snapshotSha256);
  const [positionSnapshotBytes, layoutTopologyBytes] = await Promise.all([
    readFile(path.join(root, layout.snapshotPath)),
    readFile(path.join(root, `tools/datapack/sources/${layout.topologySnapshotId}.json`)),
  ]);
  assert.equal(sha256(positionSnapshotBytes), layout.snapshotSha256);
  assert.equal(sha256(layoutTopologyBytes), layout.topologySnapshotSha256);
  const positionSnapshot = JSON.parse(positionSnapshotBytes);
  assert.equal(positionSnapshot.routeMapLayoutArtifact.topologySnapshotId, layout.topologySnapshotId);
  assert.equal(positionSnapshot.routeMapLayoutArtifact.topologySnapshotSha256, layout.topologySnapshotSha256);
  const admittedTopology = await readJson(`tools/datapack/sources/${topology.topologySnapshotId}.json`);
  assert.equal(admittedTopology.contentSha256, topology.topologyContentSha256);
  const admittedLineIds = new Set(admittedTopology.lines.map(({ lineId }) => lineId));
  const scopedLineIds = topology.topologyLineages.map(({ lineId }) => lineId);
  assert.deepEqual([...source.coverageScope.lineIds].sort(), [...scopedLineIds].sort());
  assert.ok(scopedLineIds.every((lineId) => admittedLineIds.has(lineId)));
});

test("prepared current candidate 검증은 build를 수행하고 final release eligibility를 선점하지 않는다", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "prepared-current-candidate-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const calls = [];
  await validatePreparedCandidate({
    temporaryRoot,
    buildNow: "2026-08-13T16:46:31Z",
    spec: {
      fixturePath: "tools/datapack/release/capital-production-canonical-pack.json",
      itxTopologyEvidencePath: "tools/datapack/itx-cheongchun-topology-evidence-20260812165525800.json",
      itxTopologyEvidenceSha256: "a".repeat(64),
      networkEdgeEvidence: {
        sourceInventory: { path: "tools/datapack/source-inventory.json" },
        capitalTopology: { path: "tools/datapack/sources/capital-route-topology-20260823.json" },
        capitalTopologyCandidate: { path: "tools/datapack/sources/capital-route-topology-20260823-source-separated.json" },
        capitalTopologyReverification: {
          path: "tools/datapack/release/capital-topology-reverification-20260813.json",
        },
        itxCoverageContract: { path: "tools/datapack/itx-cheongchun-coverage-contract.json" },
      },
    },
    async runNodeImpl(script, args, options) {
      calls.push({ script, args, options });
      const staged = JSON.parse(await readFile(args[1], "utf8"));
      assert.equal(
        staged.networkEdgeEvidence.capitalTopology.path,
        path.join(root, "tools/datapack/sources/capital-route-topology-20260823.json"),
      );
      assert.equal(
        staged.networkEdgeEvidence.capitalTopologyCandidate.path,
        path.join(
          temporaryRoot,
          "tools/datapack/sources/capital-route-topology-20260823-source-separated.json",
        ),
      );
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].script, "tools/datapack/build-datapack.mjs");
  assert.deepEqual(calls[0].args.slice(-2), ["--output", path.join(temporaryRoot, "validation/output")]);
  assert.equal(calls[0].options.env.EASYSUBWAY_DATAPACK_BUILD_NOW, "2026-08-13T16:46:31Z");
});

test("activation loader는 historical binding과 서울 공식 current topology position bytes를 함께 로드한다", async (t) => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "current-position-snapshots-"));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const historicalPath = "tools/datapack/sources/historical-position.json";
  const seoulPath = "tools/datapack/sources/seoul-position.json";
  const historicalBytes = Buffer.from("historical");
  const seoulBytes = Buffer.from("seoul-current");
  await mkdir(path.join(repositoryRoot, "tools/datapack/sources"), { recursive: true });
  await Promise.all([
    writeFile(path.join(repositoryRoot, historicalPath), historicalBytes),
    writeFile(path.join(repositoryRoot, seoulPath), seoulBytes),
  ]);
  const sourceInventory = {
    sources: [
      {
        id: "historical-position",
        routeMapAdmissionEvidence: {
          topologySourceId: "capital-route-topology",
          snapshotPath: historicalPath,
        },
      },
      {
        id: "seoul-metro-route-map-positions",
        productionUseAllowed: true,
        license: { redistributionAllowed: true },
        routeMapAdmissionEvidence: {
          issue: 2470,
          admissionKind: "official-file-latlon",
          materializer: "tools/datapack/materialize-seoul-route-map-positions.mjs",
          verificationTest: "tools/datapack/materialize-seoul-route-map-positions.test.mjs",
          snapshotPath: seoulPath,
        },
      },
    ],
  };

  const result = await collectPositionSnapshotBytes(sourceInventory, repositoryRoot);
  assert.deepEqual([...result.keys()], [historicalPath, seoulPath]);
  assert.deepEqual(result.get(historicalPath), historicalBytes);
  assert.deepEqual(result.get(seoulPath), seoulBytes);
});

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
    operation: "seoulmetro-line4-stations-one-to-five",
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

function staticChangeAdmission(previous, canonicalPackBytes,
  observedAt = "2026-08-13T10:30:00.000Z") {
  const observedMillis = Date.parse(observedAt);
  const date = observedAt.slice(0, 10).replaceAll("-", "");
  const providerRecordHashes = Array.from(
    { length: 5 }, (_, index) => sha256(`changed:${previous.sourceId}:${index}`),
  );
  const rawSha256 = sha256(`changed-raw:${previous.sourceId}`);
  const rawObjectUri =
    `oci://easysubway-datapacks/source-raw/${previous.sourceId}/${date}/${rawSha256}.json`;
  const redactedRequestFingerprint = sha256("current Seoul request contract");
  const evidencePayload = {
    schemaVersion: 1,
    artifactKind: "current-static-source-change-admission-evidence",
    contractVersion: "1.0.0",
    sourceId: previous.sourceId,
    previousSnapshotId: previous.snapshotId,
    observedAt,
    operation: "seoulmetro-line4-stations-one-to-five",
    rowCount: 5,
    canonicalRawSha256: rawSha256,
    schemaFingerprint: previous.schemaFingerprint,
    redactedRequestFingerprint,
    providerRecordHashesSha256: sha256(JSON.stringify(providerRecordHashes)),
    responseSha256: sha256("current Seoul response"),
    canonicalPackSha256: sha256(canonicalPackBytes),
    canonicalMembershipSha256: sha256("current canonical memberships"),
    rawObjectUri,
    outcome: "CONTENT_CHANGE_ADMITTED",
    credentialRedacted: true,
  };
  const evidence = { ...evidencePayload, evidenceSha256: sha256(JSON.stringify(evidencePayload)) };
  const snapshot = {
    ...structuredClone(previous),
    snapshotId: `${previous.sourceId}-change-admitted-${date}`,
    retrievedAt: observedAt,
    rawSha256,
    rawObjectUri,
    redactedRequestFingerprint,
    providerRecordHashes,
    previousSnapshotId: previous.snapshotId,
    diffSummary: {
      status: "CHANGED", rawHashChanged: true, schemaHashChanged: false,
      requestHashChanged: true, sourceUpdatedAtChanged: false, rowDelta: 0, coverageDelta: 0,
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
    "--seoul-revalidation-snapshot", "tools/datapack/sources/current-static-revalidation-20260811/seoulmetro-station-line-info-snapshot.json",
    "--seoul-revalidation-evidence", "tools/datapack/sources/current-static-revalidation-20260811/seoulmetro-station-line-info-revalidation-evidence.json",
    "--builder-git-sha", "a".repeat(40),
    "--build-now", "2026-08-11T00:00:00.000Z",
  ]), {
    check: false,
    capital_topology: "tools/datapack/sources/capital-route-topology-20260811.json",
    incheon_topology: "tools/datapack/sources/incheon-transit-station-info-20260811.json",
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
  assert.deepEqual(parseCurrentTopologyRefreshArgs([
    "--capital-topology", "tools/datapack/sources/capital-route-topology-20260814.json",
    "--incheon-topology", "tools/datapack/sources/incheon-transit-station-info-20260814.json",
    "--itx-topology-evidence", "tools/datapack/itx-cheongchun-topology-evidence.json",
    "--builder-git-sha", "b".repeat(40),
    "--build-now", "2026-08-23T14:53:48.203Z",
    "--check",
  ]), {
    check: true,
    capital_topology: "tools/datapack/sources/capital-route-topology-20260814.json",
    incheon_topology: "tools/datapack/sources/incheon-transit-station-info-20260814.json",
    itx_topology_evidence: "tools/datapack/itx-cheongchun-topology-evidence.json",
    builder_git_sha: "b".repeat(40),
    build_now: "2026-08-23T14:53:48.203Z",
  });
  assert.throws(() => parseCurrentTopologyRefreshArgs([
    "--itx-current-admission", "tools/datapack/itx-current-network-edge-admission-20260823.json",
  ]), /unknown topology refresh argument/);
});

test("prepared candidate validation은 spec-selected current ITX evidence bytes만 stage한다", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "current-itx-validation-evidence-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const repositoryRoot = path.join(workspace, "repository");
  const temporaryRoot = path.join(workspace, "validation");
  const evidencePath =
    "tools/datapack/itx-cheongchun-topology-evidence-20260812165525800.json";
  const evidenceBytes = Buffer.from('{"artifactKind":"itx-cheongchun-mobile-topology-evidence"}\n');
  await mkdir(path.dirname(path.join(repositoryRoot, evidencePath)), { recursive: true });
  await mkdir(temporaryRoot, { recursive: true });
  await writeFile(path.join(repositoryRoot, evidencePath), evidenceBytes);
  const spec = {
    itxTopologyEvidencePath: evidencePath,
    itxTopologyEvidenceSha256: sha256(evidenceBytes),
  };

  assert.equal(await stageValidationItxTopologyEvidence({
    spec, repositoryRoot, temporaryRoot,
  }), evidencePath);
  assert.deepEqual(await readFile(path.join(temporaryRoot, evidencePath)), evidenceBytes);
  await assert.rejects(
    readFile(path.join(temporaryRoot, "tools/datapack/itx-cheongchun-topology-evidence.json")),
    /ENOENT/,
  );

  await assert.rejects(stageValidationItxTopologyEvidence({
    spec: { ...spec, itxTopologyEvidenceSha256: "f".repeat(64) },
    repositoryRoot,
    temporaryRoot: path.join(workspace, "wrong-sha"),
  }), /ITX topology evidence identity mismatch/);
  await assert.rejects(stageValidationItxTopologyEvidence({
    spec: { ...spec, itxTopologyEvidencePath: "../outside.json" },
    repositoryRoot,
    temporaryRoot: path.join(workspace, "unsafe"),
  }), /ITX topology evidence path is invalid/);
});

test("current Incheon topology admission은 exact snapshot bytes와 fresh source identity에 결속된다", async () => {
  const snapshotPath = "tools/datapack/sources/incheon-transit-station-info-20260813.json";
  const [sourceInventory, historicalSnapshotBytes] = await Promise.all([
    readJson("tools/datapack/source-inventory.json"),
    readFile(path.join(root, snapshotPath)),
  ]);
  const historicalSnapshot = JSON.parse(historicalSnapshotBytes);
  const snapshot = structuredClone(historicalSnapshot);
  delete snapshot.stationCodeCorrections;
  snapshot.stationCodeDerivations = currentIncheonStationCodeDerivations();
  const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot)}\n`);
  const activated = activateIncheonTopologyAdmission({
    sourceInventory,
    snapshot,
    snapshotBytes,
    snapshotPath,
    now: new Date("2026-08-14T00:00:00.000Z"),
  });
  const source = activated.sources.find(({ id }) => id === "incheon-transit-station-info");
  const accessibility = activated.sources.find(({ id }) => id === "incheon-transit-accessibility")
    .accessibilityAdmissionEvidence;
  const scheduleTopologySnapshotIds = [
    "incheon-line1-train-timetable", "incheon-line2-train-timetable",
  ].map((sourceId) => activated.sources.find(({ id }) => id === sourceId)
    .scheduleAdmissionEvidence.topologySnapshotId);

  assert.equal(source.requiredForProductionPack, false);
  assert.equal(source.productionUseAllowed, true);
  assert.equal(source.topologyAdmissionEvidence.snapshotId, "incheon-transit-station-info-20260813");
  assert.equal(source.topologyAdmissionEvidence.freshUntil, "2026-08-14T15:06:46.000Z");
  assert.equal(source.topologyAdmissionEvidence.contentSha256, snapshot.contentSha256);
  assert.equal(source.membershipAdmissionEvidence.membershipSourceSnapshotSha256, snapshot.scopeSha256);
  assert.equal(source.routeMapAdmissionEvidence.snapshotSha256, sha256(snapshotBytes));
  assert.equal(source.routeMapAdmissionEvidence.positionsSha256, snapshot.positionsSha256);
  assert.equal(source.routeMapAdmissionEvidence.freshUntil, "2027-08-13T15:06:46.000Z");
  assert.equal(accessibility.topologySnapshotId, "incheon-transit-station-info-20260813");
  assert.deepEqual(
    [...accessibility.topologyLineages, ...accessibility.membershipLineages]
      .map(({ snapshotId }) => snapshotId),
    Array(3).fill("incheon-transit-station-info-20260813"),
  );
  assert.deepEqual(
    scheduleTopologySnapshotIds,
    Array(2).fill("incheon-transit-station-info-20260813"),
  );

  assert.throws(() => activateIncheonTopologyAdmission({
    sourceInventory,
    snapshot: historicalSnapshot,
    snapshotBytes: historicalSnapshotBytes,
    snapshotPath,
    now: new Date("2026-08-14T00:00:00.000Z"),
  }), /invalid Incheon station code derivations|current Incheon station code derivations are required/);

  const legacyCorrection = structuredClone(snapshot);
  legacyCorrection.stationCodeCorrections = structuredClone(historicalSnapshot.stationCodeCorrections);
  assert.throws(() => activateIncheonTopologyAdmission({
    sourceInventory,
    snapshot: legacyCorrection,
    snapshotBytes: Buffer.from(`${JSON.stringify(legacyCorrection)}\n`),
    snapshotPath,
    now: new Date("2026-08-14T00:00:00.000Z"),
  }), /current Incheon legacy station code corrections are forbidden/);

  const oldDerivation = structuredClone(snapshot);
  oldDerivation.stationCodeDerivations[1].basis = "LEGACY_CORRECTION";
  assert.throws(() => activateIncheonTopologyAdmission({
    sourceInventory,
    snapshot: oldDerivation,
    snapshotBytes: Buffer.from(`${JSON.stringify(oldDerivation)}\n`),
    snapshotPath,
    now: new Date("2026-08-14T00:00:00.000Z"),
  }), /invalid Incheon station code derivations|current Incheon station code derivations are required/);

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
    now: new Date("2026-08-14T00:00:00.000Z"),
  }), /content changed; re-admission required/);

  assert.throws(() => activateIncheonTopologyAdmission({
    sourceInventory,
    snapshot,
    snapshotBytes: Buffer.concat([snapshotBytes, Buffer.from(" ")]),
    snapshotPath,
    now: new Date("2026-08-14T00:00:00.000Z"),
  }), /snapshot byte identity mismatch/);
  assert.throws(() => activateIncheonTopologyAdmission({
    sourceInventory,
    snapshot,
    snapshotBytes,
    snapshotPath,
    now: new Date("2026-08-14T15:06:46.000Z"),
  }), /snapshot is stale/);
});

test("static revalidation은 exact Seoul NO_CHANGE child head와 inventory evidence를 함께 활성화한다", () => {
  const previous = [staticRoot("seoulmetro-station-line-info")];
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
    governancePolicyBinding: TEST_GOVERNANCE_POLICY_BINDING,
    buildNow: "2026-08-13T10:30:01.000Z",
    observationDate: "20260813",
  });
  assert.equal(activated.sourceSnapshots.length, 2);
  for (const { snapshot, evidence } of revalidations) {
    const source = activated.sourceInventory.sources.find(({ id }) => id === snapshot.sourceId);
    assert.equal(source.admissionEvidence.snapshotId, snapshot.snapshotId);
    assert.equal(source.admissionEvidence.revalidationEvidenceSha256, evidence.evidenceSha256);
    assert.equal(source.admissionEvidence.revalidationResponseSha256, evidence.responseSha256);
    assert.equal(source.retrievedAt, "2026-08-13");
    const child = activated.sourceSnapshots.find(({ snapshotId }) => snapshotId === snapshot.snapshotId);
    assert.equal(child.governancePolicyVersion,
      TEST_GOVERNANCE_POLICY_BINDING.governancePolicyVersion);
    assert.equal(child.governancePolicySha256,
      TEST_GOVERNANCE_POLICY_BINDING.governancePolicySha256);
  }

  const tampered = structuredClone(revalidations);
  tampered[0].evidence.responseSha256 = "f".repeat(64);
  assert.throws(() => activateStaticSourceRevalidations({
    sourceSnapshots: previous,
    sourceInventory,
    revalidations: tampered,
    governancePolicyBinding: TEST_GOVERNANCE_POLICY_BINDING,
    buildNow: "2026-08-13T10:30:01.000Z",
    observationDate: "20260813",
  }), /static revalidation evidence identity mismatch/);

  assert.throws(() => activateStaticSourceRevalidations({
    sourceSnapshots: previous,
    sourceInventory,
    revalidations: previous.map((snapshot) => staticRevalidation(snapshot, "2026-08-14T10:30:00.000Z")),
    governancePolicyBinding: TEST_GOVERNANCE_POLICY_BINDING,
    buildNow: "2026-08-13T10:30:00.000Z",
    observationDate: "20260814",
  }), /static revalidation is outside build time/);
  assert.throws(() => activateStaticSourceRevalidations({
    sourceSnapshots: previous,
    sourceInventory,
    revalidations,
    governancePolicyBinding: TEST_GOVERNANCE_POLICY_BINDING,
    buildNow: "2026-09-12T10:30:00.000Z",
    observationDate: "20260813",
  }), /static revalidation is outside build time/);
  assert.throws(() => activateStaticSourceRevalidations({
    sourceSnapshots: previous,
    sourceInventory,
    revalidations,
    governancePolicyBinding: TEST_GOVERNANCE_POLICY_BINDING,
    buildNow: "2026-08-13T10:30:01.000Z",
    observationDate: "20260812",
  }), /static revalidation observation date mismatch/);
});

test("static revalidation current head reuse는 append 없이 exact stored identity만 수용한다", () => {
  const previous = [staticRoot("seoulmetro-station-line-info")];
  const revalidations = previous.map((snapshot) => staticRevalidation(snapshot, "2026-08-14T10:30:00.000Z"));
  const sourceInventory = {
    schemaVersion: 1, artifactKind: "production-source-inventory",
    sources: previous.map(({ sourceId, snapshotId }) => ({ id: sourceId, retrievedAt: "2026-07-12", admissionEvidence: { snapshotId } })),
  };
  const args = {
    revalidations, governancePolicyBinding: TEST_GOVERNANCE_POLICY_BINDING,
    buildNow: "2026-08-14T10:30:01.000Z", observationDate: "20260814",
  };
  const activated = activateStaticSourceRevalidations({ sourceSnapshots: previous, sourceInventory, ...args });
  const reused = activateStaticSourceRevalidations({
    sourceSnapshots: activated.sourceSnapshots, sourceInventory: activated.sourceInventory, ...args,
  });
  assert.deepEqual(reused, activated);

  const drifted = structuredClone(activated.sourceSnapshots);
  drifted.at(-1).retrievedAt = "2026-08-14T10:30:01.000Z";
  assert.throws(() => activateStaticSourceRevalidations({ sourceSnapshots: drifted, sourceInventory: activated.sourceInventory, ...args }), /current head reuse identity mismatch/);
});

test("activation은 Seoul changed-source admission의 exact singleton만 수용한다", () => {
  const canonicalPackBytes = Buffer.from('{"packs":[{"id":"capital"}]}');
  const previous = [staticRoot("seoulmetro-station-line-info")];
  const revalidations = [staticChangeAdmission(previous[0], canonicalPackBytes)];
  const sourceInventory = {
    schemaVersion: 1,
    artifactKind: "production-source-inventory",
    sources: previous.map(({ sourceId, snapshotId }) => ({
      id: sourceId,
      retrievedAt: "2026-07-12",
      observedDataUpdatedAt: "2026-06-22",
      admissionEvidence: {
        snapshotId,
        rawSha256: sha256(`old-inventory:${sourceId}`),
        schemaFingerprint: sha256(`old-schema:${sourceId}`),
      },
    })),
  };

  const activated = activateStaticSourceRevalidations({
    sourceSnapshots: previous,
    sourceInventory,
    revalidations,
    governancePolicyBinding: TEST_GOVERNANCE_POLICY_BINDING,
    canonicalPackSha256: sha256("current pack with unrelated ITX topology change"),
    canonicalMembershipSha256: revalidations[0].evidence.canonicalMembershipSha256,
    buildNow: "2026-08-13T10:30:01.000Z",
    observationDate: "20260813",
  });
  const seoul = activated.sourceInventory.sources.find(
    ({ id }) => id === "seoulmetro-station-line-info",
  );
  assert.equal(seoul.admissionEvidence.snapshotId, revalidations[0].snapshot.snapshotId);
  assert.equal(seoul.admissionEvidence.rawSha256, revalidations[0].snapshot.rawSha256);
  assert.equal(seoul.admissionEvidence.schemaFingerprint,
    revalidations[0].snapshot.schemaFingerprint);
  assert.equal(seoul.admissionEvidence.rawObjectUri, revalidations[0].snapshot.rawObjectUri);
  assert.equal(seoul.admissionEvidence.revalidationEvidenceSha256,
    revalidations[0].evidence.evidenceSha256);
  assert.equal(seoul.observedDataUpdatedAt, "2026-06-22");

  const mutations = [
    (value) => { value[0].evidence.canonicalPackSha256 = "f".repeat(64); },
    (value) => { value[0].evidence.rawObjectUri = value[0].evidence.rawObjectUri.replace("oci:", "s3:"); },
    (value) => { value[0].snapshot.providerRecordHashes.reverse(); },
    (value) => { value[0].snapshot.diffSummary.requestHashChanged = false; },
    (value) => { value[0].evidence.outcome = "NO_CHANGE_REVALIDATED"; },
  ];
  for (const mutate of mutations) {
    const tampered = structuredClone(revalidations);
    mutate(tampered);
    assert.throws(() => activateStaticSourceRevalidations({
      sourceSnapshots: previous,
      sourceInventory,
      revalidations: tampered,
      governancePolicyBinding: TEST_GOVERNANCE_POLICY_BINDING,
      canonicalPackSha256: sha256("current pack with unrelated ITX topology change"),
      canonicalMembershipSha256: revalidations[0].evidence.canonicalMembershipSha256,
      buildNow: "2026-08-13T10:30:01.000Z",
      observationDate: "20260813",
    }), /static revalidation evidence identity mismatch/);
  }

  const unbound = structuredClone(revalidations);
  unbound[0].evidence.canonicalPackSha256 = null;
  const { evidenceSha256: _staleEvidenceSha256, ...unboundPayload } = unbound[0].evidence;
  unbound[0].evidence.evidenceSha256 = sha256(JSON.stringify(unboundPayload));
  unbound[0].snapshot.revalidationEvidenceSha256 = unbound[0].evidence.evidenceSha256;
  assert.throws(() => activateStaticSourceRevalidations({
    sourceSnapshots: previous,
    sourceInventory,
    revalidations: unbound,
    governancePolicyBinding: TEST_GOVERNANCE_POLICY_BINDING,
    canonicalMembershipSha256: revalidations[0].evidence.canonicalMembershipSha256,
    buildNow: "2026-08-13T10:30:01.000Z",
    observationDate: "20260813",
  }), /static revalidation evidence identity mismatch/);

  assert.throws(() => activateStaticSourceRevalidations({
    sourceSnapshots: previous,
    sourceInventory,
    revalidations,
    governancePolicyBinding: TEST_GOVERNANCE_POLICY_BINDING,
    canonicalPackSha256: sha256("current pack with unrelated ITX topology change"),
    canonicalMembershipSha256: "f".repeat(64),
    buildNow: "2026-08-13T10:30:01.000Z",
    observationDate: "20260813",
  }), /static revalidation evidence identity mismatch/);
});

test("current canonical pack은 admitted Seoul five-record membership을 그대로 보존한다", async () => {
  const [canonicalPackBytes, snapshot, evidence] = await Promise.all([
    readFile(path.join(root, "tools/datapack/release/capital-production-canonical-pack.json")),
    readJson("tools/datapack/sources/current-static-revalidation-20260813/seoulmetro-station-line-info-snapshot.json"),
    readJson("tools/datapack/sources/current-static-revalidation-20260813/seoulmetro-station-line-info-revalidation-evidence.json"),
  ]);

  assert.equal(
    verifyCurrentSeoulCanonicalMembership(canonicalPackBytes, snapshot),
    evidence.canonicalMembershipSha256,
  );

  const duplicatedHash = structuredClone(snapshot);
  duplicatedHash.providerRecordHashes[1] = duplicatedHash.providerRecordHashes[0];
  assert.throws(
    () => verifyCurrentSeoulCanonicalMembership(canonicalPackBytes, duplicatedHash),
    /current Seoul canonical membership mismatch/,
  );

  const wrongRawIdentity = structuredClone(snapshot);
  wrongRawIdentity.rawSha256 = "f".repeat(64);
  assert.throws(
    () => verifyCurrentSeoulCanonicalMembership(canonicalPackBytes, wrongRawIdentity),
    /current Seoul canonical membership mismatch/,
  );

  const missingPreimagePack = JSON.parse(canonicalPackBytes.toString("utf8"));
  const sadang = missingPreimagePack.packs[0].stations.find(({ id }) => id === "station-sadang");
  assert.ok(sadang);
  sadang.nameKo = "변조된 사당";
  assert.throws(
    () => verifyCurrentSeoulCanonicalMembership(
      Buffer.from(JSON.stringify(missingPreimagePack)),
      snapshot,
    ),
    /current Seoul canonical membership mismatch/,
  );
});

test("current public route-map topology는 inventory admission bytes의 line·edge identity를 도출한다", async () => {
  const inventory = await readJson("tools/datapack/source-inventory.json");
  const publicSource = inventory.sources.find(({ id }) => id === "seoul-metro-route-map-positions");
  const topologySnapshotId = publicSource?.routeMapAdmissionEvidence?.currentTopologyAdmission?.topologySnapshotId;
  assert.equal(typeof topologySnapshotId, "string");
  const topology = await readJson(`tools/datapack/sources/${topologySnapshotId}.json`);

  const lineCount = topology.lines.length;
  const edgeCount = topology.lines.reduce((count, line) => count + line.edgeCount, 0);
  assert.equal(topology.lineCount, lineCount);
  assert.equal(topology.totalEdgeCount, edgeCount);
});

test("generated current candidate spec은 expired ITX topology overlay를 재도입하지 않는다", async () => {
  const [baseSpec, sourceInventory, productionScopePolicyBytes] = await Promise.all([
    readJson("tools/datapack/release/candidate-build-spec.json"),
    readJson("tools/datapack/source-inventory.json"),
    readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json")),
  ]);
  const topologyAdmissions = sourceInventory.sources
    .map(({ routeMapAdmissionEvidence }) => routeMapAdmissionEvidence?.currentTopologyAdmission)
    .filter(({ topologySnapshotId } = {}) => /^capital-route-topology-[0-9]{8}$/u.test(topologySnapshotId));
  assert.ok(topologyAdmissions.length > 0);
  const topologySnapshotId = topologyAdmissions[0].topologySnapshotId;
  assert.ok(topologyAdmissions.every(({ topologySnapshotId: admittedSnapshotId }) =>
    admittedSnapshotId === topologySnapshotId));
  const currentTopologyPath = `tools/datapack/sources/${topologySnapshotId}.json`;
  const currentTopologyBytes = await readFile(path.join(root, currentTopologyPath));
  const currentTopology = JSON.parse(currentTopologyBytes.toString("utf8"));
  assert.equal(currentTopology.lineCount, currentTopology.lines.length);
  assert.equal(
    currentTopology.totalEdgeCount,
    currentTopology.lines.reduce((count, line) => count + line.edgeCount, 0),
  );
  const candidateTopology = requireCurrentSourceSeparatedCapitalTopology(currentTopology);
  const candidateTopologyBytes = Buffer.from(`${JSON.stringify(candidateTopology, null, 2)}\n`);

  const next = buildCurrentCandidateSpec({
    baseSpec,
    builderGitSha: "a".repeat(40),
    sourceInventoryBytes: Buffer.from("{}"),
    fullTopology: currentTopology,
    fullTopologyBytes: currentTopologyBytes,
    fullTopologyPath: currentTopologyPath,
    candidateTopology,
    candidateTopologyBytes,
    candidateTopologyPath: currentTopologyPath.replace(/\.json$/u, "-source-separated.json"),
    topologyReverificationBytes: Buffer.from("{}"),
    productionScopePolicyBytes,
  });

  assert.equal(Object.hasOwn(next.networkEdgeEvidence, "itxCurrentTopologyAdmission"), false);
  assert.equal(currentTopology.lines.some(({ lineId }) => lineId === "line-42b5805f3b5a"), false);
  assert.equal(currentTopology.lines.some(({ lineId }) => lineId === "line-98718184f016"), false);
});

test("current topology admission clock은 candidate-selected static ledger와 동일한 current admission을 소비한다", async () => {
  const [sourceInventory, candidate, sourceSnapshots] = await Promise.all([
    readJson("tools/datapack/source-inventory.json"),
    readJson("tools/datapack/release/candidate-build-spec.json"),
    readJson("tools/datapack/release/source-snapshots.json"),
  ]);
  const admissions = sourceInventory.sources
    .map(({ routeMapAdmissionEvidence }) => routeMapAdmissionEvidence?.currentTopologyAdmission)
    .filter(({ topologySnapshotId } = {}) => /^capital-route-topology-[0-9]{8}$/u.test(topologySnapshotId));
  const admission = admissions[0];
  assert.ok(admission);
  assert.ok(admissions.every(({ topologySnapshotId, reviewedAt, freshUntil }) =>
    topologySnapshotId === admission.topologySnapshotId
      && reviewedAt === admission.reviewedAt
      && freshUntil === admission.freshUntil));
  const staticSources = sourceSnapshots.filter(({ snapshotId, sourceId }) =>
    candidate.sourceSnapshotIds.includes(snapshotId)
      && ["seoul-metro-route-map-positions", "molit-urban-rail-full-route"].includes(sourceId));
  assert.equal(staticSources.length, 2);
  const staticBasisAt = Math.max(...staticSources.flatMap(({ retrievedAt, sourceUpdatedAt }) =>
    [Date.parse(retrievedAt), Date.parse(sourceUpdatedAt)]));
  const { inWindow } = await currentTopologyAdmissionClock(root);
  assert.equal(inWindow.toISOString(), new Date(Math.max(Date.parse(admission.reviewedAt), staticBasisAt) + 1_000).toISOString());
  await assert.doesNotReject(() => collectPositionSnapshotBytes(sourceInventory));
});

test("topology-only refresh는 source-separated capital/Incheon identity를 함께 재생성한다", async () => {
  const currentIncheonTopologyPath =
    "tools/datapack/sources/incheon-transit-station-info-20260825.json";
  const currentItxTopologyEvidencePath =
    "tools/datapack/itx-cheongchun-topology-evidence.json";
  const [baseSpec, sourceInventory, baselineTopology, canonical,
    productionInput, productionScopePolicyBytes, currentIncheonTopologyBytes,
    currentItxTopologyEvidenceBytes] =
    await Promise.all([
    readJson("tools/datapack/release/candidate-build-spec.json"),
    readJson("tools/datapack/source-inventory.json"),
    readJson("tools/datapack/sources/capital-route-topology-20260724.json"),
    readJson("tools/datapack/release/capital-production-canonical-pack.json"),
    readJson("tools/datapack/inputs/capital-pilot-production-source-input.json"),
    readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json")),
    readFile(path.join(root, currentIncheonTopologyPath)),
    readFile(path.join(root, currentItxTopologyEvidencePath)),
  ]);
  const currentTopologyPath =
    "tools/datapack/sources/capital-route-topology-20260825.json";
  const topologySnapshotId = path.basename(currentTopologyPath, ".json");
  const currentTopologyBytes = await readFile(path.join(root, currentTopologyPath));
  const currentTopology = JSON.parse(currentTopologyBytes);
  const currentIncheonTopology = JSON.parse(currentIncheonTopologyBytes);
  const buildNow = new Date(Math.max(
    Date.parse(currentTopology.capturedAt),
    Date.parse(currentIncheonTopology.capturedAt),
  ) + 1).toISOString();
  const result = buildCurrentTopologyRefreshPrimaryOutputs({
    baseSpec,
    builderGitSha: "a".repeat(40),
    sourceInventory,
    currentTopology,
    currentTopologyBytes,
    currentTopologyPath,
    currentIncheonTopology,
    currentIncheonTopologyBytes,
    currentIncheonTopologyPath,
    currentItxTopologyEvidencePath,
    currentItxTopologyEvidenceBytes,
    baselineTopology,
    canonical,
    productionInput,
    productionScopePolicyBytes,
    buildNow,
    snapshotBytesByPath: await collectPositionSnapshotBytes(sourceInventory),
  });

  const admissions = result.sourceInventory.sources
    .map((source) => source.routeMapAdmissionEvidence?.currentTopologyAdmission)
    .filter(({ topologySnapshotId: admittedSnapshotId } = {}) => admittedSnapshotId === topologySnapshotId);
  assert.ok(admissions.length > 0);
  assert.ok(admissions.every((admission) => admission.topologySnapshotId === topologySnapshotId));
  assert.equal(result.spec.candidateId, `capital-pilot-candidate-${topologySnapshotId.slice(-8)}`);
  assert.equal(result.spec.publishedAt, buildNow);
  assert.equal(result.spec.networkEdgeEvidence.sourceInventory.sha256, sha256(result.sourceInventoryBytes));
  assert.equal(result.spec.networkEdgeEvidence.capitalTopology.path, currentTopologyPath);
  assert.equal(result.spec.networkEdgeEvidence.capitalTopology.sha256, sha256(currentTopologyBytes));
  assert.equal(result.spec.networkEdgeEvidence.capitalTopologyCandidate.path,
    currentTopologyPath.replace(/\.json$/u, "-source-separated.json"));
  assert.equal(result.spec.networkEdgeEvidence.capitalTopologyCandidate.sha256,
    sha256(result.sourceSeparatedTopologyBytes));
  assert.equal(
    result.spec.networkEdgeEvidence.capitalTopologyReverification.sha256,
    sha256(result.topologyReverificationBytes),
  );
  assert.equal(result.projectedEdgeCount, currentTopology.totalEdgeCount);
  assert.equal(result.spec.itxTopologyEvidencePath, currentItxTopologyEvidencePath);
  assert.equal(result.spec.itxTopologyEvidenceSha256, sha256(currentItxTopologyEvidenceBytes));
  assert.equal(Object.hasOwn(result.spec.networkEdgeEvidence, "itxCurrentTopologyAdmission"), false);
  const currentAccessibilitySnapshotBySource = new Map(
    result.sourceInventory.sources
      .filter(({ accessibilityAdmissionEvidence }) => accessibilityAdmissionEvidence != null)
      .map(({ id, accessibilityAdmissionEvidence }) => [id, accessibilityAdmissionEvidence.snapshotId]),
  );
  const capital = result.canonical.packs.find(({ id }) => id === "capital");
  const accessibilityRows = [
    ...capital.facilities,
    ...capital.stationFacilityEvidence,
    ...capital.networkEdges.filter(({ edgeType }) => ["ENTRY", "EXIT"].includes(edgeType)),
  ].filter(({ sourceId }) => currentAccessibilitySnapshotBySource.has(sourceId));
  assert.ok(accessibilityRows.length > 0);
  assert.ok(accessibilityRows.every(({ sourceId, sourceSnapshotId }) =>
    sourceSnapshotId === currentAccessibilitySnapshotBySource.get(sourceId)));
  const incheon = result.sourceInventory.sources
    .find(({ id }) => id === "incheon-transit-station-info");
  assert.equal(
    incheon.topologyAdmissionEvidence.snapshotId,
    path.basename(currentIncheonTopologyPath, ".json"),
  );

  const refreshWithTopology = (topology) => buildCurrentTopologyRefreshPrimaryOutputs({
    baseSpec,
    builderGitSha: "a".repeat(40),
    sourceInventory,
    currentTopology: topology,
    currentTopologyBytes: Buffer.from(`${JSON.stringify(topology)}\n`),
    currentTopologyPath,
    currentIncheonTopology,
    currentIncheonTopologyBytes,
    currentIncheonTopologyPath,
    currentItxTopologyEvidencePath,
    currentItxTopologyEvidenceBytes,
    baselineTopology,
    canonical,
    productionInput,
    productionScopePolicyBytes,
    buildNow,
    snapshotBytesByPath: new Map(),
  });
  const withLines = (lines) => {
    const topology = structuredClone(currentTopology);
    topology.lines = lines;
    topology.contentSha256 = sha256(JSON.stringify({
      lines: topology.lines.map(({
        lineId, edgeCount, stationCount, contentSha256, rawSha256, datasetId,
      }) => ({ lineId, edgeCount, stationCount, contentSha256, rawSha256, datasetId })),
      topologyGaps: topology.topologyGaps ?? [],
    }));
    return topology;
  };
  const duplicateLines = structuredClone(currentTopology.lines);
  duplicateLines.at(-1).lineId = duplicateLines[0].lineId;
  const excludedLines = structuredClone(currentTopology.lines);
  excludedLines.push({ ...structuredClone(currentTopology.lines[0]), lineId: "line-42b5805f3b5a" });
  for (const invalidTopology of [
    withLines(structuredClone(currentTopology.lines).slice(1)),
    withLines(duplicateLines),
    withLines(excludedLines),
  ]) {
    assert.throws(
      () => refreshWithTopology(invalidTopology),
      /capital topology ownership is invalid|topology line ownership overlap/,
    );
  }
});

test("stale Incheon input은 source-separated topology materialization 전에 fail-closed한다", async (context) => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "stale-incheon-topology-"));
  context.after(() => rm(outputRoot, { recursive: true, force: true }));
  const sourceInventory = await readJson("tools/datapack/source-inventory.json");
  const publicSource = sourceInventory.sources.filter(({ id }) => id === "seoul-metro-route-map-positions");
  const incheonSource = sourceInventory.sources.filter(({ id }) => id === "incheon-transit-station-info");
  assert.equal(publicSource.length, 1);
  assert.equal(incheonSource.length, 1);
  const currentTopologySnapshotId = publicSource[0].routeMapAdmissionEvidence.currentTopologyAdmission.topologySnapshotId;
  assert.equal(typeof currentTopologySnapshotId, "string");
  const currentTopologyPath = `tools/datapack/sources/${currentTopologySnapshotId}.json`;
  const incheonTopologyPath = incheonSource[0].topologyAdmissionEvidence.snapshotPath;
  const outputPath = path.join(outputRoot, "source-separated-topology.json");
  const [baseSpec, currentTopologyBytes, baselineTopology, canonical,
    productionInput, productionScopePolicyBytes, incheonBytes,
    currentItxTopologyEvidenceBytes] = await Promise.all([
    readJson("tools/datapack/release/candidate-build-spec.json"),
    readFile(path.join(root, currentTopologyPath)),
    readJson("tools/datapack/sources/capital-route-topology-20260724.json"),
    readJson("tools/datapack/release/capital-production-canonical-pack.json"),
    readJson("tools/datapack/inputs/capital-pilot-production-source-input.json"),
    readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json")),
    readFile(path.join(root, incheonTopologyPath)),
    readFile(path.join(root, "tools/datapack/itx-cheongchun-topology-evidence.json")),
  ]);
  const staleIncheon = JSON.parse(incheonBytes);
  delete staleIncheon.stationCodeCorrections;
  staleIncheon.stationCodeDerivations = currentIncheonStationCodeDerivations();
  const staleIncheonBytes = Buffer.from(`${JSON.stringify(staleIncheon)}\n`);
  const positionSnapshotBytes = await collectPositionSnapshotBytes(sourceInventory);
  await assert.rejects(readFile(outputPath), { code: "ENOENT" });
  assert.throws(() => buildCurrentTopologyRefreshPrimaryOutputs({
    baseSpec,
    builderGitSha: "a".repeat(40),
    sourceInventory,
    currentTopology: JSON.parse(currentTopologyBytes),
    currentTopologyBytes,
    currentTopologyPath,
    currentIncheonTopology: staleIncheon,
    currentIncheonTopologyBytes: staleIncheonBytes,
    currentIncheonTopologyPath: incheonTopologyPath,
    currentItxTopologyEvidencePath: "tools/datapack/itx-cheongchun-topology-evidence.json",
    currentItxTopologyEvidenceBytes,
    baselineTopology,
    canonical,
    productionInput,
    productionScopePolicyBytes,
    buildNow: "2026-08-26T15:23:30.000Z",
    snapshotBytesByPath: positionSnapshotBytes,
  }), /current Incheon topology snapshot is stale/);
  await assert.rejects(readFile(outputPath), { code: "ENOENT" });
});

test("current capital topology는 canonical fixture에 repaired 8 directions만 추가한다", async () => {
  const [fixture, topology] = await Promise.all([
    readJson("tools/datapack/release/capital-production-canonical-pack.json"),
    readJson("tools/datapack/sources/capital-route-topology-20260813.json"),
  ]);
  const unprojectedFixture = structuredClone(fixture);
  const pack = fixture.packs.find(({ id }) => id === "capital");
  const topologyLineIds = new Set(topology.lines.map(({ lineId }) => lineId));
  const isProjectedCapitalEdge = (edge) => edge.edgeType === "RIDE"
    && edge.servicePattern === "LOCAL"
    && (edge.serviceClass ?? "SUBWAY") === "SUBWAY"
    && [edge.fromNodeId, edge.toNodeId]
      .some((nodeId) => topologyLineIds.has(String(nodeId).split(":").at(-1)));
  const retainedBefore = structuredClone(pack.networkEdges.filter((edge) => !isProjectedCapitalEdge(edge)));
  const beforeItx = structuredClone(pack.networkEdges
    .filter(({ serviceClass }) => serviceClass === "ITX_CHEONGCHUN")
    .sort((left, right) => left.id.localeCompare(right.id, "en")));
  const canonicalName = (value) => ({
    능길: "신길온천",
    김포공항역: "김포공항",
    부천종합운동장역: "부천종합운동장",
  })[normalizeStationName(value)] ?? normalizeStationName(value);
  const stations = new Map(pack.stations.map((station) => [station.id, station]));
  const stationIdsByLineName = new Map();
  for (const membership of pack.stationLines) {
    const stationName = canonicalName(stations.get(membership.stationId)?.nameKo);
    const key = `${membership.lineId}\0${stationName}`;
    const ids = stationIdsByLineName.get(key) ?? [];
    ids.push(membership.stationId);
    stationIdsByLineName.set(key, ids);
  }
  const stationId = (lineId, nameKo) => {
    const ids = stationIdsByLineName.get(`${lineId}\0${canonicalName(nameKo)}`) ?? [];
    assert.equal(ids.length, 1, `${lineId}:${nameKo}`);
    return ids[0];
  };
  const topologySnapshotId = "capital-route-topology-20260813";
  const admissions = new Map(topology.lines.map(({ lineId }) => [lineId, {
    verifiedAt: topology.capturedAt,
    freshUntil: topology.freshUntil,
  }]));
  const projected = projectCapitalTopologyIntoCanonicalFixture(
    fixture,
    topology,
    topologySnapshotId,
    admissions,
  );

  assert.equal(projected.edgeCount, 1_438);
  assert.equal(pack.networkEdges.filter(isProjectedCapitalEdge).length, 1_438);
  assert.deepEqual(pack.networkEdges.filter((edge) => !isProjectedCapitalEdge(edge)), retainedBefore);
  assert.deepEqual(
    pack.networkEdges.filter(({ serviceClass }) => serviceClass === "ITX_CHEONGCHUN")
      .sort((left, right) => left.id.localeCompare(right.id, "en")),
    beforeItx,
  );
  const gusan = stationId("line-3f41718e0833", "구산");
  const eungam = stationId("line-3f41718e0833", "응암");
  const branchEdgeId = `edge-line-3f41718e0833-${gusan}-${eungam}`;
  const branchEdge = pack.networkEdges.find(({ id }) => id === branchEdgeId);
  assert.equal(branchEdge?.sourceId, undefined);
  assert.equal(branchEdge?.sourceSnapshotId, undefined);
  assert.equal(branchEdge?.providerRecordHash, undefined);
  assert.equal(branchEdge?.evidenceHash, undefined);
  assert.equal(branchEdge?.fieldProvenance, undefined);
  assert.equal(branchEdge?.provenanceKind, undefined);
  assert.equal(branchEdge?.verificationStatus, undefined);
  const unboundAdmissions = new Map(admissions);
  unboundAdmissions.delete("line-3f41718e0833");
  assert.throws(
    () => projectCapitalTopologyIntoCanonicalFixture(
      structuredClone(unprojectedFixture),
      topology,
      topologySnapshotId,
      unboundAdmissions,
    ),
    /capital topology line admission mismatch/,
  );
  for (const [lineId, leftName, rightName] of [
    ["line-30886152e4f8", "보문", "신설동"],
    ["line-558d0bd8312d", "왕십리", "청량리"],
    ["line-828f04afc588", "둔전", "전대.에버랜드"],
    ["seoul-4", "오이도", "정왕"],
  ]) {
    const left = stationId(lineId, leftName);
    const right = stationId(lineId, rightName);
    for (const [from, to] of [[left, right], [right, left]]) {
      const edge = pack.networkEdges.find(({ id }) => id === `edge-${lineId}-${from}-${to}`);
      assert.equal(edge?.distanceMeters, 0);
      assert.equal(edge?.serviceClass, "SUBWAY");
    }
  }
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
    "seoul-metro-route-map-positions", "kric-subway-timetable", "seoul-metro-accessibility",
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
  const currentInventory = await readJson("tools/datapack/source-inventory.json");
  const currentPublicSource = currentInventory.sources.filter(({ id }) => id === "seoul-metro-route-map-positions");
  const currentIncheonSource = currentInventory.sources.filter(({ id }) => id === "incheon-transit-station-info");
  assert.equal(currentPublicSource.length, 1);
  assert.equal(currentIncheonSource.length, 1);
  const currentTopologySnapshotId = currentPublicSource[0].routeMapAdmissionEvidence.currentTopologyAdmission.topologySnapshotId;
  assert.equal(typeof currentTopologySnapshotId, "string");
  const currentTopologyPath = `tools/datapack/sources/${currentTopologySnapshotId}.json`;
  const currentIncheonTopologyPath = currentIncheonSource[0].topologyAdmissionEvidence.snapshotPath;
  const [baselineTopology, currentTopologyBytes, currentIncheonTopologyBytes] = await Promise.all([
    readJson("tools/datapack/sources/capital-route-topology-20260724.json"),
    readFile(path.join(root, currentTopologyPath)),
    readFile(path.join(root, currentIncheonTopologyPath)),
  ]);
  const currentTopology = JSON.parse(currentTopologyBytes);
  const currentIncheonTopology = JSON.parse(currentIncheonTopologyBytes);
  const activationMillis = Math.max(
    Date.parse(currentTopology.capturedAt),
    Date.parse(currentIncheonTopology.capturedAt),
  ) + 1_000;
  const activationFreshUntil = Math.min(
    Date.parse(currentTopology.freshUntil),
    Date.parse(currentIncheonTopology.freshUntil),
  );
  assert.ok(activationMillis < activationFreshUntil);
  const buildNow = new Date(activationMillis).toISOString();
  const publicRouteMapSuccessor = {
    sourceId: "seoul-metro-route-map-positions",
    snapshotId: "seoul-metro-route-map-positions-current-20260810",
    rawSha256: sha256("current-public-route-map-raw"),
    normalizedObservationSha256: sha256("current-public-route-map-observation"),
    routeMapLayoutEvidence: { layoutArtifactSha256: sha256("current-public-route-map-layout") },
    routeMapLayoutArtifact: {
      capturedAt: "2026-08-10T20:21:15.000Z",
      datasetUrl: "https://www.data.go.kr/data/15099316/fileData.do",
      rawPositions: [
        { lineId: "seoul-4", stationCode: "433", stationName: "사당" },
        { lineId: "seoul-4", stationCode: "448", stationName: "상록수" },
      ],
      layoutPositions: [
        { lineId: "seoul-4", stationCode: "433", canvasX: 10, canvasY: 20, labelDx: 0, labelDy: 0, labelPolygon: [] },
        { lineId: "seoul-4", stationCode: "448", canvasX: 30, canvasY: 40, labelDx: 0, labelDy: 0, labelPolygon: [] },
      ],
    },
  };
  const build = (sourceSnapshots) => buildCurrentSourcePrimaryOutputs({
    handoff,
    rawArtifact: { collectedAt: handoff.collectedAt },
    rawArtifactBytes,
    sourceSnapshots,
    sourceInventory: inventory,
    productionInput: {
      sourceIds: sourceIds.slice(0, 6),
      stationMappings: [
        { sourceId: "seoulmetro-station-line-info", sourceStationCode: "433", lineId: "seoul-4", stationId: "station-sadang", stationLineId: "station-sadang:seoul-4" },
        { sourceId: "seoulmetro-station-line-info", sourceStationCode: "448", lineId: "seoul-4", stationId: "station-sangnoksu", stationLineId: "station-sangnoksu:seoul-4" },
      ],
      routeMapPositions: [{ sourceId: "seoulmetro-cyberstation-route-map" }],
    },
    officialOdFareQuotes,
    baselineTopology,
    currentTopology,
    currentTopologyBytes,
    currentTopologyPath,
    currentIncheonTopology,
    currentIncheonTopologyBytes,
    currentIncheonTopologyPath,
    buildNow,
    snapshotBytesByPath: new Map(),
    verifySuccessorHeadsImpl() { return { positions: publicRouteMapSuccessor }; },
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
      assert.equal(topologySnapshotId, currentTopologySnapshotId);
      return { ...value, topologyAdmissionsRebound: true };
    },
    activateIncheonTopologyAdmissionImpl({ sourceInventory: value, snapshotPath }) {
      assert.equal(snapshotPath, currentIncheonTopologyPath);
      return { ...value, incheonAdmissionsRebound: true };
    },
    buildTopologyReverificationImpl(baseline, current) {
      assert.equal(baseline.lines.some(({ lineId }) => lineId === "line-98718184f016"), false);
      assert.equal(current.lines.some(({ lineId }) => lineId === "line-98718184f016"), false);
      return { artifactKind: "capital-topology-reverification-evidence" };
    },
  });
  const result = build([previousSnapshot]);

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
  assert.equal(CURRENT_SOURCE_INVENTORY_IDS.includes("seoul-metro-route-map-positions"), true);
  assert.equal(CURRENT_PRODUCTION_SOURCE_IDS.includes("seoul-metro-route-map-positions"), false);
  assert.deepEqual(result.productionInput.sourceIds, [...CURRENT_PRODUCTION_SOURCE_IDS]);
  assert.deepEqual(result.productionInput.routeMapPositions, []);
  assert.equal(
    result.productionInput.coverageEvidence.some(({ sourceIds: ids }) =>
      ids.includes("seoulmetro-cyberstation-route-map")),
    false,
  );
  assert.equal(result.productionInput.coverageEvidence.some(({ sourceDomain }) =>
    sourceDomain === "route_map_positions"), false);
  assert.deepEqual(result.productionInput.officialOdFareQuotes, officialOdFareQuotes);
  assert.deepEqual(result.productionInput.routeServiceArtifactEvidence, []);
  assert.deepEqual(result.productionInput.movementPathCandidates, []);
  assert.equal(result.productionInput.scheduleProvenance.sourceSnapshotId, handoff.snapshotId);
  assert.equal(result.topologyReverification.artifactKind, "capital-topology-reverification-evidence");

  const repeated = build(result.sourceSnapshots);
  assert.deepEqual(repeated.sourceSnapshots, result.sourceSnapshots);

  const drifted = structuredClone(result.sourceSnapshots);
  drifted.at(-1).rawSha256 = "f".repeat(64);
  assert.throws(() => build(drifted), /current KRIC source snapshot identity mismatch/);
});

test("pre-materialization current input은 route-map partial claim 없이 exact OD fare 2건만 importer에 전달한다", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "current-source-import-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));

  const [inventory, input, quoteBundle, canonical] = await Promise.all([
    readJson("tools/datapack/source-inventory.json"),
    readJson("tools/datapack/inputs/capital-pilot-production-source-input.json"),
    readJson("tools/datapack/official-od-fare-quotes.json"),
    readJson("tools/datapack/release/capital-production-canonical-pack.json"),
  ]);
  const convenienceSource = inventory.sources.find(({ id }) => id === "kric-station-convenience-standard");
  assert.ok(convenienceSource);
  convenienceSource.productionUseAllowed = true;

  const fareSourceId = "seoul-metro-official-od-fares";
  input.sourceIds = [...CURRENT_PRODUCTION_SOURCE_IDS];
  assert.equal(input.sourceIds.includes("seoul-metro-route-map-positions"), false);
  input.coverageEvidence = [
    ...input.coverageEvidence.filter(({ sourceDomain }) =>
      !["official_od_fares", "route_map_positions"].includes(sourceDomain)),
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
  input.routeMapPositions = [];

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
  assert.equal(reviewedPack.sourceInventory.some(({ id }) => id === "seoulmetro-cyberstation-route-map"), false);
  assert.deepEqual(reviewedPack.routeMapPositions, []);
  assert.deepEqual(reviewedPack.officialOdFareQuotes, input.officialOdFareQuotes);
  assert.deepEqual(reviewedPack.routeServiceArtifactEvidence, []);
  assert.deepEqual(reviewedPack.movementPathCandidates, []);
  assert.throws(
    () => syncCanonicalFixture(structuredClone(canonical), reviewedPack),
    /reviewed source inventory cannot replace current canonical source authority/,
  );
  const canonicalCapital = canonical.packs.find(({ id }) => id === "capital");
  assert.ok(canonicalCapital);
  const currentAuthorityReviewedPack = {
    ...reviewedPack,
    sourceInventory: structuredClone(canonicalCapital.sourceInventory),
  };
  const syncedCanonical = syncCanonicalFixture(canonical, currentAuthorityReviewedPack);
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

test("topology refresh는 date-bound source-separated output만 원자 commit 대상으로 허용한다", async (context) => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "current-topology-output-"));
  context.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const allowedPath = "tools/datapack/sources/capital-route-topology-20260823-source-separated.json";
  const rejectedPath = "tools/datapack/sources/unrelated-source-separated.json";
  await mkdir(path.dirname(path.join(repositoryRoot, allowedPath)), { recursive: true });

  await commitCurrentSourceActivation({
    repositoryRoot,
    outputs: [{ relativePath: allowedPath, bytes: Buffer.from("separated\n") }],
    validate: async () => {},
  });
  assert.deepEqual(await readFile(path.join(repositoryRoot, allowedPath)), Buffer.from("separated\n"));

  await assert.rejects(
    commitCurrentSourceActivation({
      repositoryRoot,
      outputs: [{ relativePath: rejectedPath, bytes: Buffer.from("rejected\n") }],
      validate: async () => {},
    }),
    /activation output is not allowed/,
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
  await writeFile(path.join(repositoryRoot, "baseline.json"), "{\"version\":0}\n");
  await runGit("add", "generator.mjs", "baseline.json");
  await runGit("-c", "commit.gpgsign=false", "commit", "-qm", "builder");
  const { stdout: builderShaOutput } = await runGit("rev-parse", "HEAD");
  const builderSha = builderShaOutput.trim();
  await writeFile(path.join(repositoryRoot, "generated.json"), "{\"version\":1}\n");
  await writeFile(path.join(repositoryRoot, "baseline.json"), "{\"version\":1}\n");
  await runGit("add", "generated.json", "baseline.json");
  await runGit("-c", "commit.gpgsign=false", "commit", "-qm", "generated output");

  await requireCleanBuilder(builderSha, {
    check: true,
    repositoryRoot,
    allowedDescendantPaths: ["generated.json", "baseline.json"],
  });
  assert.deepEqual(
    await readBuilderBaselineBytes(builderSha, "baseline.json", repositoryRoot),
    Buffer.from('{"version":0}\n'),
  );

  await writeFile(path.join(repositoryRoot, "generator.mjs"), "export const version = 2;\n");
  await runGit("add", "generator.mjs");
  await runGit("-c", "commit.gpgsign=false", "commit", "-qm", "changed builder");
  await assert.rejects(
    requireCleanBuilder(builderSha, {
      check: true,
      repositoryRoot,
      allowedDescendantPaths: ["generated.json", "baseline.json"],
    }),
    /builder source|builder identity/,
  );
});
