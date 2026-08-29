import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  overlayReviewedSourcesOnCanonicalRoster,
  syncCanonicalFixture,
} from "./apply-accessibility-evidence-to-bundled-pack.mjs";
import { admittedIncheonTopologyEvidence, projectCapitalTopologyIntoCanonicalFixture,
  projectIncheonNetworkEdges, validateProductionIncheonNetworkEdgeFixture } from "./build-datapack.mjs";
import {
  admittedIncheonAccessibilityEvidence,
  validateProductionIncheonAccessibilityFixture,
} from "./materialize-incheon-accessibility.mjs";
import { requireCurrentIncheonTopologyAdmission, activateStaticSourceRevalidations,
  buildCurrentCandidateSpec, buildCurrentSourcePrimaryOutputs,
  buildCurrentTopologyRefreshPrimaryOutputs, commitCurrentSourceActivation,
  collectLayoutTopologySnapshotBytes, collectPositionSnapshotBytes, parseCurrentSourceActivationArgs,
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
const CURRENT_V2_TEST_NOW = (await currentTopologyAdmissionClock(root)).inWindow;

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

async function currentV2HeadsFixture() {
  const [ledger, inventory] = await Promise.all([
    readFile(path.join(root, "tools/datapack/release/source-snapshots.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8").then(JSON.parse),
  ]);
  const heads = (sourceId) => ledger.filter(({ sourceId: id }) => id === sourceId).find(({ snapshotId }) => !ledger.some(({ previousSnapshotId }) => previousSnapshotId === snapshotId));
  const [positionFile, molitFile] = await Promise.all([
    readJson(`tools/datapack/sources/${heads("seoul-metro-route-map-positions").snapshotId}.json`),
    readJson(`tools/datapack/sources/${heads("molit-urban-rail-full-route").snapshotId}.json`),
  ]);
  const make = (sourceId, file) => {
    const original = heads(sourceId);
    const capturedAt = new Date(Date.parse(original.retrievedAt) + 1).toISOString();
    const snapshotId = `${sourceId}-v2-current`; const receipt = { ...structuredClone(original.rawReceipt), snapshotId, capturedAt, storedAt: capturedAt };
    const observation = { schemaVersion: 2, artifactKind: "public-static-network-v2-observation", sourceId, snapshotId, capturedAt, rawSha256: original.rawSha256, contentSha256: original.contentSha256, schemaFingerprint: original.schemaFingerprint, rowCount: original.rowCount, providerRecordHashes: structuredClone(original.providerRecordHashes), normalizedProjection: structuredClone(file.normalizedProjection), ...(sourceId === "seoul-metro-route-map-positions" ? { routeMapLayoutEvidence: structuredClone(file.routeMapLayoutEvidence), routeMapLayoutArtifact: structuredClone(file.routeMapLayoutArtifact) } : {}), rawReceipt: receipt };
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

function currentCapitalTopologyAdmission(sourceInventory) {
  const admissions = sourceInventory.sources
    .map(({ routeMapAdmissionEvidence }) => routeMapAdmissionEvidence?.currentTopologyAdmission)
    .filter(({ topologySnapshotId } = {}) => /^capital-route-topology-[0-9]{8}$/u.test(topologySnapshotId));
  const admission = admissions[0];
  assert.equal(admissions.length, 16);
  assert.ok(admission);
  assert.ok(admissions.every(({ topologySnapshotId, topologyContentSha256, reviewedAt, freshUntil }) =>
    topologySnapshotId === admission.topologySnapshotId
      && topologyContentSha256 === admission.topologyContentSha256
      && reviewedAt === admission.reviewedAt && freshUntil === admission.freshUntil));
  return admission;
}

async function currentCapitalTopology(sourceInventory) {
  const admission = currentCapitalTopologyAdmission(sourceInventory);
  const relativePath = `tools/datapack/sources/${admission.topologySnapshotId}.json`;
  const bytes = await readFile(path.join(root, relativePath));
  const topology = JSON.parse(bytes);
  assert.equal(topology.contentSha256, admission.topologyContentSha256);
  return { admission, relativePath, bytes, topology };
}

async function historicalCandidateCapitalTopology(baseSpec) {
  const evidence = baseSpec.networkEdgeEvidence?.capitalTopology;
  assert.match(evidence?.path ?? "", /^tools\/datapack\/sources\/capital-route-topology-[0-9]{8}\.json$/u);
  assert.match(evidence?.sha256 ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(evidence.snapshotId, path.basename(evidence.path, ".json"));
  const bytes = await readFile(path.join(root, evidence.path));
  assert.equal(sha256(bytes), evidence.sha256);
  return { bytes, topology: JSON.parse(bytes) };
}

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
  assert.equal(topology.positionSnapshotSha256, layout.snapshotSha256);
  const [positionSnapshotBytes, layoutTopologyBytes] = await Promise.all([
    readFile(path.join(root, layout.snapshotPath)),
    readFile(path.join(root, `tools/datapack/sources/${layout.topologySnapshotId}.json`)),
  ]);
  assert.equal(sha256(positionSnapshotBytes), layout.snapshotSha256);
  assert.equal(sha256(layoutTopologyBytes), layout.topologySnapshotSha256);
  const layoutTopology = JSON.parse(layoutTopologyBytes);
  const positionSnapshot = JSON.parse(positionSnapshotBytes);
  assert.equal(positionSnapshot.routeMapLayoutArtifact.topologySnapshotId, layout.topologySnapshotId);
  assert.equal(positionSnapshot.routeMapLayoutArtifact.topologySnapshotSha256, layout.topologySnapshotSha256);
  const admittedTopology = await readJson(`tools/datapack/sources/${topology.topologySnapshotId}.json`);
  assert.equal(layoutTopology.contentSha256, topology.topologyContentSha256);
  assert.equal(admittedTopology.contentSha256, topology.topologyContentSha256);
  const admittedLineIds = new Set(admittedTopology.lines.map(({ lineId }) => lineId));
  const scopedLineIds = topology.topologyLineages.map(({ lineId }) => lineId);
  assert.deepEqual([...source.coverageScope.lineIds].sort(), [...scopedLineIds].sort());
  assert.ok(scopedLineIds.every((lineId) => admittedLineIds.has(lineId)));
});

test("prepared current candidate 검증은 build를 수행하고 final release eligibility를 선점하지 않는다", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "prepared-current-candidate-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const [baseSpec, sourceInventory] = await Promise.all([
    readJson("tools/datapack/release/candidate-build-spec.json"),
    readJson("tools/datapack/source-inventory.json"),
  ]);
  const [{ relativePath: currentTopologyPath }, { path: baselineTopologyPath }] = await Promise.all([
    currentCapitalTopology(sourceInventory),
    Promise.resolve(baseSpec.networkEdgeEvidence.capitalTopology),
  ]);
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
        capitalTopology: { path: baselineTopologyPath },
        capitalTopologyCandidate: { path: currentTopologyPath },
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
        path.join(root, baselineTopologyPath),
      );
      assert.equal(
        staged.networkEdgeEvidence.capitalTopologyCandidate.path,
        path.join(root, currentTopologyPath),
      );
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].script, "tools/datapack/build-datapack.mjs");
  assert.deepEqual(calls[0].args.slice(-2), ["--output", path.join(temporaryRoot, "validation/output")]);
  assert.equal(calls[0].options.env.EASYSUBWAY_DATAPACK_BUILD_NOW, "2026-08-13T16:46:31Z");
  assert.equal(calls[0].options.env.EASYSUBWAY_DATAPACK_BUILD_SPEC_VALIDATION_ONLY, "true");
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
    "--incheon-accessibility", "tools/datapack/sources/incheon-transit-accessibility-20260811.json",
    "--seoul-revalidation-snapshot", "tools/datapack/sources/current-static-revalidation-20260811/seoulmetro-station-line-info-snapshot.json",
    "--seoul-revalidation-evidence", "tools/datapack/sources/current-static-revalidation-20260811/seoulmetro-station-line-info-revalidation-evidence.json",
    "--builder-git-sha", "a".repeat(40),
    "--build-now", "2026-08-11T00:00:00.000Z",
  ]), {
    check: false,
    capital_topology: "tools/datapack/sources/capital-route-topology-20260811.json",
    incheon_topology: "tools/datapack/sources/incheon-transit-station-info-20260811.json",
    incheon_accessibility: "tools/datapack/sources/incheon-transit-accessibility-20260811.json",
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
    "--incheon-accessibility", "tools/datapack/sources/incheon-transit-accessibility-20260814.json",
    "--incheon-line1-timetable", "tools/datapack/sources/incheon-line1-train-timetable-20260814.json",
    "--incheon-line2-timetable", "tools/datapack/sources/incheon-line2-train-timetable-20260814.json",
    "--itx-topology-evidence", "tools/datapack/itx-cheongchun-topology-evidence.json",
    "--builder-git-sha", "b".repeat(40),
    "--build-now", "2026-08-23T14:53:48.203Z",
    "--check",
  ]), {
    check: true,
    capital_topology: "tools/datapack/sources/capital-route-topology-20260814.json",
    incheon_topology: "tools/datapack/sources/incheon-transit-station-info-20260814.json",
    incheon_accessibility: "tools/datapack/sources/incheon-transit-accessibility-20260814.json",
    incheon_line1_timetable: "tools/datapack/sources/incheon-line1-train-timetable-20260814.json",
    incheon_line2_timetable: "tools/datapack/sources/incheon-line2-train-timetable-20260814.json",
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

test("current Incheon topology admission validates immutable receipt-bound accessibility", async () => {
  const [sourceInventory, snapshotPath, accessibilitySnapshotPath] = await Promise.all([
    readJson("tools/datapack/source-inventory.json"),
    readJson("tools/datapack/source-inventory.json").then((inventory) => inventory.sources
      .find(({ id }) => id === "incheon-transit-station-info").topologyAdmissionEvidence.snapshotPath),
    readJson("tools/datapack/source-inventory.json").then((inventory) => inventory.sources
      .find(({ id }) => id === "incheon-transit-accessibility").registrationEvidence.snapshotId)
      .then((snapshotId) => `tools/datapack/sources/${snapshotId}.json`),
  ]);
  const [historicalSnapshotBytes, accessibilitySnapshotBytes] = await Promise.all([
    readFile(path.join(root, snapshotPath)),
    readFile(path.join(root, accessibilitySnapshotPath)),
  ]);
  const historicalSnapshot = JSON.parse(historicalSnapshotBytes);
  const accessibilitySnapshot = JSON.parse(accessibilitySnapshotBytes);
  const admittedRouteMap = structuredClone(sourceInventory.sources
    .find(({ id }) => id === "incheon-transit-station-info").routeMapAdmissionEvidence);
  const snapshot = structuredClone(historicalSnapshot);
  const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot)}\n`);
  const validationNow = new Date(Math.max(
    Date.parse(snapshot.capturedAt),
    Date.parse(accessibilitySnapshot.capturedAt),
  ) + 1);
  const originalAccessibilitySource = structuredClone(sourceInventory.sources
    .find(({ id }) => id === "incheon-transit-accessibility"));
  const activated = requireCurrentIncheonTopologyAdmission({
    sourceInventory,
    snapshot,
    snapshotBytes,
    snapshotPath,
    accessibilitySnapshot,
    accessibilitySnapshotBytes,
    accessibilitySnapshotPath,
    now: validationNow,
  });
  const source = activated.sources.find(({ id }) => id === "incheon-transit-station-info");
  const accessibility = activated.sources.find(({ id }) => id === "incheon-transit-accessibility");
  const scheduleTopologySnapshotIds = [
    "incheon-line1-train-timetable", "incheon-line2-train-timetable",
  ].map((sourceId) => activated.sources.find(({ id }) => id === sourceId)
    .scheduleAdmissionEvidence.topologySnapshotId);

  assert.equal(source.requiredForProductionPack, false);
  assert.equal(source.productionUseAllowed, true);
  assert.equal(source.topologyAdmissionEvidence.snapshotId, path.basename(snapshotPath, ".json"));
  assert.equal(source.topologyAdmissionEvidence.freshUntil, snapshot.freshUntil);
  assert.equal(source.topologyAdmissionEvidence.contentSha256, snapshot.contentSha256);
  assert.equal(source.membershipAdmissionEvidence.membershipSourceSnapshotSha256, snapshot.scopeSha256);
  assert.equal(source.routeMapAdmissionEvidence.snapshotSha256, sha256(snapshotBytes));
  assert.equal(source.routeMapAdmissionEvidence.positionsSha256, snapshot.positionsSha256);
  assert.deepEqual(source.routeMapAdmissionEvidence, admittedRouteMap);
  assert.deepEqual(accessibility, originalAccessibilitySource);
  assert.equal(Object.hasOwn(accessibility, "accessibilityAdmissionEvidence"), false);
  assert.deepEqual(
    scheduleTopologySnapshotIds,
    Array(2).fill(path.basename(snapshotPath, ".json")),
  );

  const missingDerivations = structuredClone(snapshot);
  delete missingDerivations.stationCodeDerivations;
  assert.throws(() => requireCurrentIncheonTopologyAdmission({
    sourceInventory,
    snapshot: missingDerivations,
    snapshotBytes: Buffer.from(`${JSON.stringify(missingDerivations)}\n`),
    snapshotPath,
    accessibilitySnapshot,
    accessibilitySnapshotBytes,
    accessibilitySnapshotPath,
    now: validationNow,
  }), /invalid Incheon station code derivations|current Incheon station code derivations are required/);

  const legacyCorrection = structuredClone(snapshot);
  legacyCorrection.stationCodeCorrections = [];
  assert.throws(() => requireCurrentIncheonTopologyAdmission({
    sourceInventory,
    snapshot: legacyCorrection,
    snapshotBytes: Buffer.from(`${JSON.stringify(legacyCorrection)}\n`),
    snapshotPath,
    accessibilitySnapshot,
    accessibilitySnapshotBytes,
    accessibilitySnapshotPath,
    now: validationNow,
  }), /current Incheon legacy station code corrections are forbidden/);

  const oldDerivation = structuredClone(snapshot);
  oldDerivation.stationCodeDerivations[1].basis = "LEGACY_CORRECTION";
  assert.throws(() => requireCurrentIncheonTopologyAdmission({
    sourceInventory,
    snapshot: oldDerivation,
    snapshotBytes: Buffer.from(`${JSON.stringify(oldDerivation)}\n`),
    snapshotPath,
    accessibilitySnapshot,
    accessibilitySnapshotBytes,
    accessibilitySnapshotPath,
    now: validationNow,
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
  assert.throws(() => requireCurrentIncheonTopologyAdmission({
    sourceInventory,
    snapshot: changedEdges,
    snapshotBytes: changedEdgeBytes,
    snapshotPath,
    accessibilitySnapshot,
    accessibilitySnapshotBytes,
    accessibilitySnapshotPath,
    now: validationNow,
  }), /content changed; re-admission required/);

  assert.throws(() => requireCurrentIncheonTopologyAdmission({
    sourceInventory,
    snapshot,
    snapshotBytes: Buffer.concat([snapshotBytes, Buffer.from(" ")]),
    snapshotPath,
    accessibilitySnapshot,
    accessibilitySnapshotBytes,
    accessibilitySnapshotPath,
    now: validationNow,
  }), /snapshot byte identity mismatch/);
  assert.throws(() => requireCurrentIncheonTopologyAdmission({
    sourceInventory,
    snapshot,
    snapshotBytes,
    snapshotPath,
    accessibilitySnapshot,
    accessibilitySnapshotBytes,
    accessibilitySnapshotPath,
    now: new Date(snapshot.freshUntil),
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

test("current public route-map topology는 inventory admission bytes에서 22 lines와 1,438 edges를 도출한다", async () => {
  const inventory = await readJson("tools/datapack/source-inventory.json");
  const { topology } = await currentCapitalTopology(inventory);

  const lineCount = topology.lines.length;
  const edgeCount = topology.lines.reduce((count, line) => count + line.edgeCount, 0);
  assert.equal(topology.lineCount, lineCount);
  assert.equal(topology.totalEdgeCount, edgeCount);
  assert.equal(topology.lines.length, 22);
  assert.equal(topology.lines.reduce((count, line) => count + line.edgeCount, 0), 1_438);
  assert.equal(topology.lines.some(({ lineId }) => lineId === "line-42b5805f3b5a"), false);
  assert.equal(topology.lines.some(({ lineId }) => lineId === "line-98718184f016"), false);
});

test("generated current candidate spec은 expired ITX topology overlay를 재도입하지 않는다", async () => {
  const [storedBaseSpec, sourceInventory, productionScopePolicyBytes] = await Promise.all([
    readJson("tools/datapack/release/candidate-build-spec.json"),
    readJson("tools/datapack/source-inventory.json"),
    readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json")),
  ]);
  const baseSpec = structuredClone(storedBaseSpec);
  baseSpec.networkEdgeEvidence.itxCurrentTopologyAdmission = {
    snapshotId: "obsolete-itx-current-topology",
  };
  const { admission, relativePath: currentTopologyPath, bytes: currentTopologyBytes, topology: currentTopology } =
    await currentCapitalTopology(sourceInventory);
  const accessibilityRegistration = sourceInventory.sources.find(({ id }) =>
    id === "incheon-transit-accessibility").registrationEvidence;
  const accessibilityPath = `tools/datapack/sources/${accessibilityRegistration.snapshotId}.json`;
  const accessibilityBytes = await readFile(path.join(root, accessibilityPath));
  const timetableAdmissions = Object.fromEntries([1, 2].map((lineNumber) => [lineNumber,
    sourceInventory.sources.find(({ id }) => id === `incheon-line${lineNumber}-train-timetable`)
      .scheduleAdmissionEvidence]));
  const timetablePaths = Object.fromEntries([1, 2].map((lineNumber) => [lineNumber,
    timetableAdmissions[lineNumber].snapshotPath]));
  const timetableBytes = Object.fromEntries(await Promise.all([1, 2].map(async (lineNumber) => [lineNumber,
    await readFile(path.join(root, timetablePaths[lineNumber]))])));
  const timetableSnapshotIds = Object.fromEntries([1, 2].map((lineNumber) => [lineNumber,
    timetableAdmissions[lineNumber].snapshotId]));
  assert.equal(currentTopology.lines.length, 22);

  const next = buildCurrentCandidateSpec({
    baseSpec,
    builderGitSha: "a".repeat(40),
    sourceInventoryBytes: Buffer.from("{}"),
    fullTopology: currentTopology,
    fullTopologyBytes: currentTopologyBytes,
    fullTopologyPath: currentTopologyPath,
    candidateTopology: currentTopology,
    candidateTopologyBytes: currentTopologyBytes,
    candidateTopologyPath: currentTopologyPath,
    topologyReverificationBytes: Buffer.from("{}"),
    productionScopePolicyBytes,
    incheonAccessibilityPath: accessibilityPath,
    incheonAccessibilityBytes: accessibilityBytes,
    incheonAccessibilitySnapshotId: accessibilityRegistration.snapshotId,
    incheonTimetablePaths: timetablePaths,
    incheonTimetableBytes: timetableBytes,
    incheonTimetableSnapshotIds: timetableSnapshotIds,
  });

  assert.equal(Object.hasOwn(next.networkEdgeEvidence, "itxCurrentTopologyAdmission"), false);
  assert.equal(Object.hasOwn(next.networkEdgeEvidence, "incheonAccessibility"), false);
  assert.deepEqual(next.networkEdgeEvidence.incheonTimetables,
    Object.fromEntries([1, 2].map((lineNumber) => [`line${lineNumber}`, {
      path: timetablePaths[lineNumber],
      sha256: sha256(timetableBytes[lineNumber]),
      snapshotId: timetableSnapshotIds[lineNumber],
    }])));
  assert.deepEqual(next.networkEdgeEvidence.capitalTopology, baseSpec.networkEdgeEvidence.capitalTopology);
  assert.deepEqual(next.networkEdgeEvidence.capitalTopologyCandidate, {
    path: currentTopologyPath,
    sha256: sha256(currentTopologyBytes),
    snapshotId: admission.topologySnapshotId,
  });
  assert.equal(currentTopology.lines.some(({ lineId }) => lineId === "line-42b5805f3b5a"), false);
  assert.equal(currentTopology.lines.some(({ lineId }) => lineId === "line-98718184f016"), false);
});

test("current topology admission clock은 candidate-selected static ledger와 동일한 current admission을 소비한다", async () => {
  const [sourceInventory, candidate, sourceSnapshots] = await Promise.all([
    readJson("tools/datapack/source-inventory.json"),
    readJson("tools/datapack/release/candidate-build-spec.json"),
    readJson("tools/datapack/release/source-snapshots.json"),
  ]);
  const admission = currentCapitalTopologyAdmission(sourceInventory);
  const staticSources = sourceSnapshots.filter(({ snapshotId, sourceId }) =>
    candidate.sourceSnapshotIds.includes(snapshotId)
      && ["seoul-metro-route-map-positions", "molit-urban-rail-full-route"].includes(sourceId));
  assert.equal(staticSources.length, 2);
  const staticBasisAt = Math.max(...staticSources.flatMap(({ retrievedAt, sourceUpdatedAt }) =>
    [Date.parse(retrievedAt), Date.parse(sourceUpdatedAt)]));
  const incheonBasisAt = Date.parse(sourceInventory.sources
    .find(({ id }) => id === "incheon-transit-station-info")
    .topologyAdmissionEvidence.capturedAt);
  const { inWindow } = await currentTopologyAdmissionClock(root);
  assert.equal(inWindow.toISOString(), new Date(Math.max(
    Date.parse(admission.reviewedAt), incheonBasisAt, staticBasisAt,
  ) + 1_000).toISOString());
  await assert.doesNotReject(() => collectPositionSnapshotBytes(sourceInventory));
});

test("topology-only refresh projects fresh Incheon inputs without relabelling prior evidence", async () => {
  const [baseSpec, sourceInventory, canonical, productionInput, productionScopePolicyBytes] =
    await Promise.all([
    readJson("tools/datapack/release/candidate-build-spec.json"),
    readJson("tools/datapack/source-inventory.json"),
    readJson("tools/datapack/release/capital-production-canonical-pack.json"),
    readJson("tools/datapack/inputs/capital-pilot-production-source-input.json"),
    readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json")),
  ]);
  const { topology: baselineTopology, bytes: baselineTopologyBytes } = await historicalCandidateCapitalTopology(baseSpec);
  const currentTopologyPath = "tools/datapack/sources/capital-route-topology-20260828.json";
  const currentTopologyBytes = await readFile(path.join(root, currentTopologyPath));
  const currentTopology = JSON.parse(currentTopologyBytes);
  const topologySnapshotId = path.basename(currentTopologyPath, ".json");
  assert.equal(currentTopology.lines.length, 22);
  assert.equal(currentTopology.lines.reduce((count, line) => count + line.edgeCount, 0), 1_438);
  assert.equal(currentTopology.lines.some(({ lineId }) => lineId === "line-42b5805f3b5a"), false);
  assert.equal(currentTopology.lines.some(({ lineId }) => lineId === "line-98718184f016"), false);
  const currentIncheonTopologyPath = "tools/datapack/sources/incheon-transit-station-info-20260828.json";
  const currentIncheonAccessibilityPath = `tools/datapack/sources/${sourceInventory.sources
    .find(({ id }) => id === "incheon-transit-accessibility").registrationEvidence.snapshotId}.json`;
  const currentIncheonTimetablePaths = {
    1: "tools/datapack/sources/incheon-line1-train-timetable-20260828.json",
    2: "tools/datapack/sources/incheon-line2-train-timetable-20260828.json",
  };
  const [currentIncheonTopologyBytes, currentIncheonAccessibilityBytes,
    line1TimetableBytes, line2TimetableBytes] = await Promise.all([
    readFile(path.join(root, currentIncheonTopologyPath)),
    readFile(path.join(root, currentIncheonAccessibilityPath)),
    readFile(path.join(root, currentIncheonTimetablePaths[1])),
    readFile(path.join(root, currentIncheonTimetablePaths[2])),
  ]);
  const currentIncheonTopology = JSON.parse(currentIncheonTopologyBytes);
  const currentIncheonAccessibility = JSON.parse(currentIncheonAccessibilityBytes);
  const currentIncheonTimetables = { 1: JSON.parse(line1TimetableBytes), 2: JSON.parse(line2TimetableBytes) };
  const currentIncheonTimetableBytes = { 1: line1TimetableBytes, 2: line2TimetableBytes };
  assert.equal(currentIncheonTopology.topologyLineIds.length, 2);
  assert.equal(currentIncheonTopology.edgeCount, 116);
  const capitalSnapshotDate = currentTopology.capturedAt.slice(0, 10).replaceAll("-", "");
  const incheonSnapshotDate = currentIncheonTopology.capturedAt.slice(0, 10).replaceAll("-", "");
  assert.equal(topologySnapshotId.slice(-8), capitalSnapshotDate);
  assert.equal(path.basename(currentIncheonTopologyPath, ".json").slice(-8), incheonSnapshotDate);
  const currentItxTopologyEvidencePath = baseSpec.itxTopologyEvidencePath;
  const currentItxTopologyEvidenceBytes = await readFile(path.join(root, currentItxTopologyEvidencePath));
  const buildNow = new Date(Math.max(
    Date.parse(currentTopology.capturedAt),
    Date.parse(currentIncheonTopology.capturedAt),
    Date.parse(currentIncheonAccessibility.capturedAt),
    Date.parse(currentIncheonTimetables[1].capturedAt),
    Date.parse(currentIncheonTimetables[2].capturedAt),
  ) + 1).toISOString();
  const layoutTopologySnapshotBytesById = await collectLayoutTopologySnapshotBytes(sourceInventory);
  const snapshotBytesByPath = await collectPositionSnapshotBytes(sourceInventory);
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
    currentIncheonAccessibility,
    currentIncheonAccessibilityBytes,
    currentIncheonAccessibilityPath,
    currentIncheonTimetables,
    currentIncheonTimetableBytes,
    currentIncheonTimetablePaths,
    currentItxTopologyEvidencePath,
    currentItxTopologyEvidenceBytes,
    baselineTopology,
    baselineTopologyBytes,
    canonical,
    productionInput,
    productionScopePolicyBytes,
    buildNow,
    snapshotBytesByPath,
    layoutTopologySnapshotBytesById,
  });

  const admissions = result.sourceInventory.sources
    .map((source) => source.routeMapAdmissionEvidence?.currentTopologyAdmission)
    .filter(({ topologySnapshotId: admittedSnapshotId } = {}) => admittedSnapshotId === topologySnapshotId);
  assert.ok(admissions.length > 0);
  assert.ok(admissions.every((admission) => admission.topologySnapshotId === topologySnapshotId));
  assert.equal(result.spec.candidateId, `capital-pilot-candidate-${topologySnapshotId.slice(-8)}`);
  assert.equal(result.spec.publishedAt, buildNow);
  assert.equal(result.spec.networkEdgeEvidence.sourceInventory.sha256, sha256(result.sourceInventoryBytes));
  assert.deepEqual(result.spec.networkEdgeEvidence.capitalTopology,
    baseSpec.networkEdgeEvidence.capitalTopology);
  assert.equal(result.spec.networkEdgeEvidence.capitalTopologyCandidate.path, currentTopologyPath);
  assert.equal(result.spec.networkEdgeEvidence.capitalTopologyCandidate.sha256,
    sha256(currentTopologyBytes));
  const incheonAccessibilityAdmission = admittedIncheonAccessibilityEvidence({
    sourceInventory: result.sourceInventory,
    snapshot: currentIncheonAccessibility,
    snapshotBytes: currentIncheonAccessibilityBytes,
    topologySnapshot: currentIncheonTopology,
    topologyMode: "registered-topology-successor",
    now: new Date(buildNow),
  });
  assert.equal(Object.hasOwn(result.spec.networkEdgeEvidence, "incheonAccessibility"), false);
  assert.equal(
    result.spec.networkEdgeEvidence.capitalTopologyReverification.sha256,
    sha256(result.topologyReverificationBytes),
  );
  assert.equal(result.projectedEdgeCount, currentTopology.totalEdgeCount);
  assert.equal(result.spec.itxTopologyEvidencePath, currentItxTopologyEvidencePath);
  assert.equal(result.spec.itxTopologyEvidenceSha256, sha256(currentItxTopologyEvidenceBytes));
  assert.equal(Object.hasOwn(result.spec.networkEdgeEvidence, "itxCurrentTopologyAdmission"), false);
  const currentAccessibilitySnapshotBySource = new Map(result.sourceInventory.sources
    .filter(({ accessibilityAdmissionEvidence }) => accessibilityAdmissionEvidence != null)
    .map(({ id, accessibilityAdmissionEvidence }) => [id, accessibilityAdmissionEvidence.snapshotId]));
  currentAccessibilitySnapshotBySource.set("incheon-transit-accessibility", currentIncheonAccessibility.snapshotId);
  const capital = result.canonical.packs.find(({ id }) => id === "capital");
  const previousCapital = canonical.packs.find(({ id }) => id === "capital");
  const reviewedCapital = result.reviewedPack.packs.find(({ id }) => id === "capital");
  const incheonSuccessorIds = [
    "incheon-transit-station-info",
    "incheon-transit-accessibility",
    "incheon-line1-train-timetable",
    "incheon-line2-train-timetable",
  ];
  const admittedSnapshotId = (source) => source.id === "incheon-transit-station-info"
    ? source.topologyAdmissionEvidence.snapshotId
    : source.id === "incheon-transit-accessibility"
      ? currentIncheonAccessibility.snapshotId
      : source.scheduleAdmissionEvidence.snapshotId;
  const admittedSources = new Map(result.sourceInventory.sources
    .filter(({ id }) => incheonSuccessorIds.includes(id))
    .map((source) => [source.id, source]));
  assert.equal(admittedSources.size, incheonSuccessorIds.length);
  for (const sourceId of incheonSuccessorIds) {
    const source = admittedSources.get(sourceId);
    const promotedSource = capital.sourceInventory.find(({ id }) => id === sourceId);
    assert.ok(promotedSource);
    assert.equal(promotedSource.updatedAt, sourceId === "incheon-transit-station-info"
      ? currentIncheonTopology.capturedAt
      : sourceId === "incheon-transit-accessibility"
        ? currentIncheonAccessibility.capturedAt
        : currentIncheonTimetables[sourceId.includes("line1") ? 1 : 2].capturedAt);
    const rows = Object.values(capital).flatMap((value) => Array.isArray(value)
      ? value.filter((row) => row?.sourceId === sourceId)
      : []);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((row) => row.sourceSnapshotId === admittedSnapshotId(source)));
  }
  assert.deepEqual(
    capital.sourceInventory.filter(({ id }) => !incheonSuccessorIds.includes(id)),
    previousCapital.sourceInventory.filter(({ id }) => !incheonSuccessorIds.includes(id)),
  );
  const incheonFacilities = capital.facilities.filter(({ sourceId }) =>
    sourceId === "incheon-transit-accessibility");
  const incheonFacilityEvidence = capital.stationFacilityEvidence.filter(({ sourceId }) =>
    sourceId === "incheon-transit-accessibility");
  assert.equal(incheonFacilities.length, incheonAccessibilityAdmission.facilityCount);
  assert.equal(incheonFacilityEvidence.length, incheonAccessibilityAdmission.facilityCount);
  assert.equal(new Set(incheonFacilities.map(({ id }) => id)).size,
    incheonAccessibilityAdmission.facilityCount);
  assert.equal(new Set(incheonFacilityEvidence.map(({ stationId, lineId, facilityType }) =>
    `${stationId}:${lineId}:${facilityType}`)).size, incheonAccessibilityAdmission.facilityCount);
  assert.ok([...incheonFacilities, ...incheonFacilityEvidence].every((row) =>
    row.sourceSnapshotId === incheonAccessibilityAdmission.snapshotId
      && row.evidenceHash === incheonAccessibilityAdmission.evidenceHash));
  assert.doesNotThrow(() => validateProductionIncheonAccessibilityFixture([capital],
    admittedIncheonAccessibilityEvidence({
      sourceInventory: result.sourceInventory,
      snapshot: currentIncheonAccessibility,
      snapshotBytes: currentIncheonAccessibilityBytes,
      topologySnapshot: currentIncheonTopology,
      topologyMode: "registered-topology-successor",
      now: new Date(buildNow),
    })));
  assert.equal(reviewedCapital.networkEdges.length, 4);
  assert.ok(reviewedCapital.networkEdges.every(({ edgeType }) =>
    ["ENTRY", "EXIT"].includes(edgeType)));
  assert.equal(reviewedCapital.minimumTableRows.network_edges, 4);
  assert.ok(capital.networkEdges.every(({ edgeType }) => edgeType === "RIDE"));
  assert.equal(capital.networkEdges.filter(({ edgeType }) =>
    ["ENTRY", "EXIT"].includes(edgeType)).length, 0);
  const accessibilityRows = [
    ...capital.facilities,
    ...capital.stationFacilityEvidence,
    ...capital.networkEdges.filter(({ edgeType }) => ["ENTRY", "EXIT"].includes(edgeType)),
  ].filter(({ sourceId }) => currentAccessibilitySnapshotBySource.has(sourceId));
  assert.ok(accessibilityRows.length > 0);
  assert.ok(accessibilityRows.every(({ sourceId, sourceSnapshotId }) =>
    sourceSnapshotId === currentAccessibilitySnapshotBySource.get(sourceId)));
  assert.equal(result.sourceSeparatedTopologyPath, currentTopologyPath);
  assert.deepEqual(result.sourceSeparatedTopologyBytes, currentTopologyBytes);
  const incheon = result.sourceInventory.sources
    .find(({ id }) => id === "incheon-transit-station-info");
  assert.equal(
    incheon.topologyAdmissionEvidence.snapshotId,
    path.basename(currentIncheonTopologyPath, ".json"),
  );
  const expectedRouteMapTopologyLineages = currentIncheonTopology.topologyLineIds.map((lineId) => ({
    sourceId: currentIncheonTopology.sourceId,
    snapshotId: path.basename(currentIncheonTopologyPath, ".json"),
    contentSha256: currentIncheonTopology.contentSha256,
    lineId,
  }));
  assert.deepEqual(incheon.routeMapAdmissionEvidence.topologyLineages,
    expectedRouteMapTopologyLineages);
  assert.deepEqual(incheon.routeMapAdmissionEvidence.officialRenameEvidence, [{
    lineId: "line-42b5805f3b5a",
    stationCode: "3210",
    stationId: "station-b1a5f63faf69",
    previousNameKo: "서구청",
    currentNameKo: "서해구청",
    renamedAt: "2026-06-12",
    officialNoticeUrl: "https://www.incheon.go.kr/IC010307/view?curPage=14&gosigbn=N&sno=66730",
  }]);
  assert.doesNotThrow(() => requireCurrentIncheonTopologyAdmission({
    sourceInventory: result.sourceInventory,
    snapshot: currentIncheonTopology,
    snapshotBytes: currentIncheonTopologyBytes,
    snapshotPath: currentIncheonTopologyPath,
    accessibilitySnapshot: currentIncheonAccessibility,
    accessibilitySnapshotBytes: currentIncheonAccessibilityBytes,
    accessibilitySnapshotPath: currentIncheonAccessibilityPath,
    now: new Date(buildNow),
  }));
  const mismatchedInventory = structuredClone(result.sourceInventory);
  mismatchedInventory.sources.find(({ id }) => id === "incheon-transit-accessibility")
    .registrationEvidence.capturedTopology.snapshotId = "incheon-transit-station-info-20260827";
  assert.throws(() => requireCurrentIncheonTopologyAdmission({
    sourceInventory: mismatchedInventory,
    snapshot: currentIncheonTopology,
    snapshotBytes: currentIncheonTopologyBytes,
    snapshotPath: currentIncheonTopologyPath,
    accessibilitySnapshot: currentIncheonAccessibility,
    accessibilitySnapshotBytes: currentIncheonAccessibilityBytes,
    accessibilitySnapshotPath: currentIncheonAccessibilityPath,
    now: new Date(buildNow),
  }), /registered topology binding mismatch/);
  const mismatchedRouteMapLineage = structuredClone(result.sourceInventory);
  mismatchedRouteMapLineage.sources.find(({ id }) => id === "incheon-transit-station-info")
    .routeMapAdmissionEvidence.topologyLineages[0].lineId = "line-15b3b8a93259";
  assert.throws(() => requireCurrentIncheonTopologyAdmission({
    sourceInventory: mismatchedRouteMapLineage,
    snapshot: currentIncheonTopology,
    snapshotBytes: currentIncheonTopologyBytes,
    snapshotPath: currentIncheonTopologyPath,
    accessibilitySnapshot: currentIncheonAccessibility,
    accessibilitySnapshotBytes: currentIncheonAccessibilityBytes,
    accessibilitySnapshotPath: currentIncheonAccessibilityPath,
    now: new Date(buildNow),
  }), /current Incheon topology inventory admission is not exact/);
  const mismatchedOfficialRename = structuredClone(result.sourceInventory);
  mismatchedOfficialRename.sources.find(({ id }) => id === "incheon-transit-station-info")
    .routeMapAdmissionEvidence.officialRenameEvidence[0].officialNoticeUrl = "https://example.com/";
  assert.throws(() => requireCurrentIncheonTopologyAdmission({
    sourceInventory: mismatchedOfficialRename,
    snapshot: currentIncheonTopology,
    snapshotBytes: currentIncheonTopologyBytes,
    snapshotPath: currentIncheonTopologyPath,
    accessibilitySnapshot: currentIncheonAccessibility,
    accessibilitySnapshotBytes: currentIncheonAccessibilityBytes,
    accessibilitySnapshotPath: currentIncheonAccessibilityPath,
    now: new Date(buildNow),
  }), /current Incheon topology inventory admission is not exact/);
  assert.deepEqual(result.sourceInventory.sources.find(({ id }) => id === "incheon-transit-accessibility"),
    sourceInventory.sources.find(({ id }) => id === "incheon-transit-accessibility"));
  const currentIncheonSnapshotIds = new Map([
    ["incheon-transit-station-info", path.basename(currentIncheonTopologyPath, ".json")],
    ["incheon-transit-accessibility", path.basename(currentIncheonAccessibilityPath, ".json")],
    ["incheon-line1-train-timetable", path.basename(currentIncheonTimetablePaths[1], ".json")],
    ["incheon-line2-train-timetable", path.basename(currentIncheonTimetablePaths[2], ".json")],
  ]);
  const currentIncheonAdmissions = new Map(result.sourceInventory.sources
    .filter(({ id }) => currentIncheonSnapshotIds.has(id))
    .map((source) => [source.id, source.topologyAdmissionEvidence?.snapshotId
      ?? source.registrationEvidence?.snapshotId
      ?? source.scheduleAdmissionEvidence?.snapshotId]));
  assert.deepEqual(currentIncheonAdmissions, currentIncheonSnapshotIds);
  const currentIncheonRows = Object.values(capital)
    .flatMap((value) => Array.isArray(value) ? value : [])
    .filter(({ sourceId }) => currentIncheonSnapshotIds.has(sourceId));
  assert.ok(currentIncheonRows.length > 0);
  assert.ok(currentIncheonRows.every(({ sourceId, sourceSnapshotId }) =>
    sourceSnapshotId === currentIncheonSnapshotIds.get(sourceId)));
  const promotedSourceIds = new Set(currentIncheonRows.map(({ sourceId }) => sourceId));
  const projectedIncheonCapital = result.incheonProjection.packs.find(({ id }) =>
    /^nationwide-incheon-schedule-[a-f0-9]{64}$/u.test(id));
  assert.ok(projectedIncheonCapital);
  const projectedSourcesById = new Map(projectedIncheonCapital.sourceInventory.map((source) => [source.id, source]));
  const capitalSourcesById = new Map(capital.sourceInventory.map((source) => [source.id, source]));
  assert.ok([...promotedSourceIds].every((id) => capitalSourcesById.has(id)));
  assert.deepEqual(capital.sourceInventory.slice(0, previousCapital.sourceInventory.length),
    previousCapital.sourceInventory);
  const appendedSources = capital.sourceInventory.slice(previousCapital.sourceInventory.length);
  assert.deepEqual(appendedSources, []);
  for (const sourceId of promotedSourceIds) {
    assert.deepEqual(capitalSourcesById.get(sourceId), projectedSourcesById.get(sourceId));
  }
  assert.equal(new Set(capital.sourceInventory.map(({ id }) => id)).size, capital.sourceInventory.length);
  assert.equal(capital.stations.find(({ id }) => id === "station-b1a5f63faf69").nameKo, "서해구청");
  assert.equal(capital.lines.filter(({ id }) => id === "line-15b3b8a93259").length, 1);
  assert.equal(capital.transitTrips.filter(({ id }) => id.startsWith("trip-incheon-")).length, 1_414);
  assert.equal(reviewedCapital.stations.some(({ id }) => id === "station-b1a5f63faf69"), false);
  assert.deepEqual(
    { id: capital.id, version: capital.version, url: capital.url, manifest: capital.manifest },
    { id: previousCapital.id, version: previousCapital.version,
      url: previousCapital.url, manifest: previousCapital.manifest },
  );
  assert.equal(capital.stationAliases.filter(({ stationId, alias }) => (
    stationId === "station-b1a5f63faf69" && alias === "서구청"
  )).length, 1);
  assert.equal(
    result.sourceInventory.sources.find(({ id }) => id === "incheon-transit-accessibility")
      .observedDataUpdatedAt,
    sourceInventory.sources.find(({ id }) => id === "incheon-transit-accessibility")
      .observedDataUpdatedAt,
  );
  const stationLineKeys = capital.stationLines.map(({ stationId, lineId }) => `${stationId}:${lineId}`);
  assert.equal(new Set(stationLineKeys).size, stationLineKeys.length);
  const topologyOwnedLineIds = new Set(currentIncheonTopology.topologyLineIds);
  const currentIncheonRouteMapPositionKeys = currentIncheonTopology.positions
    .filter(({ lineId }) => topologyOwnedLineIds.has(lineId))
    .map(({ stationId, lineId }) => `${stationId}:${lineId}`)
    .sort();
  const materializedIncheonRouteMapPositionKeys = capital.routeMapPositions
    .filter(({ lineId }) => topologyOwnedLineIds.has(lineId))
    .map(({ stationId, lineId }) => `${stationId}:${lineId}`)
    .sort();
  assert.deepEqual(materializedIncheonRouteMapPositionKeys, currentIncheonRouteMapPositionKeys);
  assert.ok(capital.routeMapPositions.every(({ stationId, lineId }) =>
    stationLineKeys.includes(`${stationId}:${lineId}`)));
  const membershipRow = ({ stationId, lineId, stationCode, lineSequence, platformInfo }) => ({
    stationId, lineId, stationCode, lineSequence, platformInfo,
  });
  const sortMembershipRows = (rows) => rows.map(membershipRow).sort((left, right) => (
    `${left.lineId}:${left.stationId}`.localeCompare(`${right.lineId}:${right.stationId}`, "en")
  ));
  const admittedTopologyMemberships = currentIncheonTopology.scope
    .filter(({ lineId }) => topologyOwnedLineIds.has(lineId))
    .map((row) => ({ ...row, platformInfo: "" }));
  assert.deepEqual(
    sortMembershipRows(capital.stationLines.filter(({ lineId }) => topologyOwnedLineIds.has(lineId))),
    sortMembershipRows(admittedTopologyMemberships),
  );
  const capitalStationIds = new Set(capital.stations.map(({ id }) => id));
  assert.ok(capital.stationLines.every(({ stationId }) => capitalStationIds.has(stationId)));
  const seoknamRows = currentIncheonTopology.scope.filter(({ stationName }) =>
    stationName === "석남(거북시장)");
  assert.equal(seoknamRows.length, 2);
  assert.equal(new Set(seoknamRows.map(({ stationId }) => stationId)).size, seoknamRows.length);
  assert.equal(new Set(seoknamRows.map(({ lineId }) => lineId)).size, seoknamRows.length);
  for (const { stationId, lineId } of seoknamRows) {
    assert.ok(capitalStationIds.has(stationId));
    assert.ok(capital.stationLines.some((row) => row.stationId === stationId && row.lineId === lineId));
    assert.equal(capital.stationAliases.some((row) => (
      row.alias === stationId && row.stationId !== stationId
    )), false);
  }
  const supersededTopologyAliases = previousCapital.stationAliases.filter(({ stationId, alias }) => (
    stationId !== alias && currentIncheonTopology.scope.some((row) => row.stationId === alias)
  ));
  assert.equal(supersededTopologyAliases.length, 0,
    "current canonical fixture has no superseded Incheon topology aliases");
  const currentI210 = currentIncheonTopology.scope.find(({ stationId }) => stationId === "station-b1a5f63faf69");
  assert.ok(currentI210);
  assert.deepEqual(capital.stationLines.filter(({ stationId, lineId }) => (
    stationId === currentI210.stationId && lineId === currentI210.lineId
  )).map(({ stationCode }) => stationCode), [currentI210.stationCode]);
  const freshLine7StationIds = new Set(currentIncheonTopology.scope
    .filter(({ lineId }) => lineId === "line-15b3b8a93259")
    .map(({ stationId }) => stationId));
  const retainedSharedLine7 = (pack) => pack.stationLines.filter(({ stationId, lineId }) => (
    lineId === "line-15b3b8a93259" && !freshLine7StationIds.has(stationId)
  ));
  assert.deepEqual(retainedSharedLine7(capital), retainedSharedLine7(previousCapital));
  const incheonAdmission = admittedIncheonTopologyEvidence({
    sourceInventory: result.sourceInventory,
    snapshot: currentIncheonTopology,
    snapshotBytes: currentIncheonTopologyBytes,
    now: new Date(buildNow),
  });
  const expectedIncheonEdges = projectIncheonNetworkEdges(capital, currentIncheonTopology, incheonAdmission);
  const expectedIncheonEdgeIds = new Set(expectedIncheonEdges.map(({ id }) => id));
  assert.deepEqual(
    capital.networkEdges.filter(({ id }) => expectedIncheonEdgeIds.has(id)),
    expectedIncheonEdges,
  );
  assert.doesNotThrow(() => validateProductionIncheonNetworkEdgeFixture(capital, expectedIncheonEdges));
  assert.throws(() => validateProductionIncheonNetworkEdgeFixture({
    ...capital,
    networkEdges: capital.networkEdges.filter(({ id }) => id !== expectedIncheonEdges[0].id),
  }, expectedIncheonEdges), /does not match pinned admission/);
  const driftedIncheonEdge = { ...expectedIncheonEdges[0], evidenceHash: "0".repeat(64) };
  assert.throws(() => validateProductionIncheonNetworkEdgeFixture({
    ...capital,
    networkEdges: capital.networkEdges.map((edge) => edge.id === driftedIncheonEdge.id
      ? driftedIncheonEdge
      : edge),
  }, expectedIncheonEdges), /does not match pinned admission/);
  const wrongIdIncheonEdge = { ...expectedIncheonEdges[0], id: `${expectedIncheonEdges[0].id}-wrong` };
  assert.throws(() => validateProductionIncheonNetworkEdgeFixture({
    ...capital,
    networkEdges: capital.networkEdges.map((edge) => edge.id === expectedIncheonEdges[0].id
      ? wrongIdIncheonEdge
      : edge),
  }, expectedIncheonEdges), /does not match pinned admission/);
  const incheonTopologyLineIds = new Set(expectedIncheonEdges.map(({ fromNodeId }) =>
    fromNodeId.split(":").at(-1)));
  const isIncheonTopologyEdge = (edge) => {
    const fromLineId = String(edge.fromNodeId ?? "").split(":").at(-1);
    const toLineId = String(edge.toNodeId ?? "").split(":").at(-1);
    return edge.edgeType === "RIDE"
      && edge.servicePattern === "LOCAL"
      && (edge.serviceClass ?? "SUBWAY") === "SUBWAY"
      && fromLineId === toLineId
      && incheonTopologyLineIds.has(fromLineId);
  };
  assert.deepEqual(
    capital.networkEdges.filter((edge) => !isIncheonTopologyEdge(edge)),
    previousCapital.networkEdges.filter((edge) => !isIncheonTopologyEdge(edge)),
  );

  const boundaryAccessibility = currentIncheonAccessibility;
  const refreshWithBoundaryAccessibility = ({ inventory = sourceInventory, fixture = canonical } = {}) =>
    buildCurrentTopologyRefreshPrimaryOutputs({
    baseSpec, builderGitSha: "a".repeat(40), sourceInventory: inventory, currentTopology,
    currentTopologyBytes, currentTopologyPath, currentIncheonTopology, currentIncheonTopologyBytes,
    currentIncheonTopologyPath, currentIncheonAccessibility: boundaryAccessibility,
    currentIncheonAccessibilityBytes,
    currentIncheonAccessibilityPath,
    currentIncheonTimetables, currentIncheonTimetableBytes, currentIncheonTimetablePaths,
    currentItxTopologyEvidencePath, currentItxTopologyEvidenceBytes, baselineTopology,
    baselineTopologyBytes, canonical: fixture, productionInput, productionScopePolicyBytes,
    buildNow, snapshotBytesByPath, layoutTopologySnapshotBytesById,
  });
  const boundaryResult = refreshWithBoundaryAccessibility();
  const boundaryCapital = boundaryResult.canonical.packs.find(({ id }) => id === "capital");
  const boundarySourceIds = [
    "incheon-transit-station-info",
    "incheon-transit-accessibility",
    "incheon-line1-train-timetable",
    "incheon-line2-train-timetable",
  ];
  const boundaryAdmissionId = (source) => source.id === "incheon-transit-station-info"
    ? source.topologyAdmissionEvidence.snapshotId
    : source.id === "incheon-transit-accessibility"
      ? source.registrationEvidence.snapshotId
      : source.scheduleAdmissionEvidence.snapshotId;
  for (const sourceId of boundarySourceIds) {
    const source = boundaryResult.sourceInventory.sources.find(({ id }) => id === sourceId);
    assert.ok(source);
    assert.equal(boundaryCapital.sourceInventory.find(({ id }) => id === sourceId)?.updatedAt,
      sourceId === "incheon-transit-accessibility" ? boundaryAccessibility.capturedAt
        : sourceId === "incheon-transit-station-info" ? currentIncheonTopology.capturedAt
          : currentIncheonTimetables[sourceId.includes("line1") ? 1 : 2].capturedAt);
    const rows = Object.entries(boundaryCapital).flatMap(([property, value]) => Array.isArray(value)
      && !(sourceId === "incheon-transit-station-info" && property === "stations")
      ? value.filter((row) => row?.sourceId === sourceId)
      : []);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((row) => row.sourceSnapshotId === boundaryAdmissionId(source)));
  }
  assert.deepEqual(
    boundaryCapital.sourceInventory.filter(({ id }) => !boundarySourceIds.includes(id)),
    previousCapital.sourceInventory.filter(({ id }) => !boundarySourceIds.includes(id)),
  );
  assert.deepEqual(boundaryCapital.stations, previousCapital.stations);
  const immutableDriftInventory = structuredClone(sourceInventory);
  immutableDriftInventory.sources.find(({ id }) => id === "incheon-transit-accessibility").owner = "drift";
  assert.throws(() => refreshWithBoundaryAccessibility({ inventory: immutableDriftInventory }),
    /successor immutable metadata drifted: incheon-transit-accessibility/);
  const partialOldProvenance = structuredClone(canonical);
  partialOldProvenance.packs.find(({ id }) => id === "capital")
    .stationFacilityEvidence.find(({ sourceId }) => sourceId === "incheon-transit-accessibility")
    .sourceSnapshotId = "incheon-transit-accessibility-20260827";
  assert.throws(() => refreshWithBoundaryAccessibility({ fixture: partialOldProvenance }),
    /successor replay rows are invalid: incheon-transit-accessibility/);

  const refreshWithTopology = (topology, fixture = canonical) => buildCurrentTopologyRefreshPrimaryOutputs({
    baseSpec,
    builderGitSha: "a".repeat(40),
    sourceInventory,
    currentTopology: topology,
    currentTopologyBytes: Buffer.from(`${JSON.stringify(topology)}\n`),
    currentTopologyPath,
    currentIncheonTopology,
    currentIncheonTopologyBytes,
    currentIncheonTopologyPath,
    currentIncheonAccessibility,
    currentIncheonAccessibilityBytes,
    currentIncheonAccessibilityPath,
    currentIncheonTimetables,
    currentIncheonTimetableBytes,
    currentIncheonTimetablePaths,
    currentItxTopologyEvidencePath,
    currentItxTopologyEvidenceBytes,
    baselineTopology,
    baselineTopologyBytes,
    canonical: fixture,
    productionInput,
    productionScopePolicyBytes,
    buildNow,
    snapshotBytesByPath,
    layoutTopologySnapshotBytesById,
  });
  const registeredReplayCanonical = structuredClone(result.canonical);
  const registeredReplayCapital = registeredReplayCanonical.packs.find(({ id }) => id === "capital");
  for (const property of ["facilities", "stationFacilityEvidence"]) {
    for (const row of registeredReplayCapital[property]) {
      if (row.sourceId === "incheon-transit-accessibility") {
        row.sourceSnapshotId = "incheon-transit-accessibility-20260828";
      }
    }
  }
  const registeredReplay = refreshWithTopology(currentTopology, registeredReplayCanonical);
  const registeredReplayCapitalResult = registeredReplay.canonical.packs.find(({ id }) => id === "capital");
  const registeredSnapshotId = currentIncheonAccessibility.snapshotId;
  assert.ok(["facilities", "stationFacilityEvidence"].every((property) =>
    registeredReplayCapitalResult[property]
      .filter(({ sourceId }) => sourceId === "incheon-transit-accessibility")
      .every(({ sourceSnapshotId }) => sourceSnapshotId === registeredSnapshotId)));
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
      /current capital topology ownership failure|topology line ownership overlap/,
    );
  }
  const mismatchedTimetables = structuredClone(currentIncheonTimetables);
  mismatchedTimetables[1].topologyContentSha256 = "0".repeat(64);
  const mismatchedTimetableBytes = {
    ...currentIncheonTimetableBytes,
    1: Buffer.from(`${JSON.stringify(mismatchedTimetables[1])}\n`),
  };
  assert.throws(() => buildCurrentTopologyRefreshPrimaryOutputs({
    baseSpec, builderGitSha: "a".repeat(40), sourceInventory, currentTopology,
    currentTopologyBytes, currentTopologyPath, currentIncheonTopology, currentIncheonTopologyBytes,
    currentIncheonTopologyPath, currentIncheonAccessibility, currentIncheonAccessibilityBytes,
    currentIncheonAccessibilityPath, currentIncheonTimetables: mismatchedTimetables,
    currentIncheonTimetableBytes: mismatchedTimetableBytes, currentIncheonTimetablePaths, currentItxTopologyEvidencePath,
    currentItxTopologyEvidenceBytes, baselineTopology, baselineTopologyBytes, canonical,
    productionInput, productionScopePolicyBytes, buildNow,
    snapshotBytesByPath, layoutTopologySnapshotBytesById,
  }), /current Incheon dependent snapshot lineage mismatch/);
});

test("stale Incheon input은 current topology materialization 전에 fail-closed한다", async () => {
  const [baseSpec, sourceInventory] = await Promise.all([
    readJson("tools/datapack/release/candidate-build-spec.json"),
    readJson("tools/datapack/source-inventory.json"),
  ]);
  const [{ topology: baselineTopology, bytes: baselineTopologyBytes }, { relativePath: currentTopologyPath, bytes: currentTopologyBytes, topology: currentTopology },
    canonical, productionInput, productionScopePolicyBytes] = await Promise.all([
    historicalCandidateCapitalTopology(baseSpec),
    currentCapitalTopology(sourceInventory),
    readJson("tools/datapack/release/capital-production-canonical-pack.json"),
    readJson("tools/datapack/inputs/capital-pilot-production-source-input.json"),
    readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json")),
  ]);
  const incheonTopologyPath = "tools/datapack/sources/incheon-transit-station-info-20260828.json";
  const incheonAccessibilityPath = `tools/datapack/sources/${sourceInventory.sources
    .find(({ id }) => id === "incheon-transit-accessibility").registrationEvidence.snapshotId}.json`;
  const [incheonBytes, currentIncheonAccessibilityBytes, line1TimetableBytes, line2TimetableBytes] = await Promise.all([
    readFile(path.join(root, incheonTopologyPath)),
    readFile(path.join(root, incheonAccessibilityPath)),
    readFile(path.join(root, "tools/datapack/sources/incheon-line1-train-timetable-20260828.json")),
    readFile(path.join(root, "tools/datapack/sources/incheon-line2-train-timetable-20260828.json")),
  ]);
  const currentItxTopologyEvidencePath = baseSpec.itxTopologyEvidencePath;
  const currentItxTopologyEvidenceBytes = await readFile(path.join(root, currentItxTopologyEvidencePath));
  assert.equal(currentTopology.lines.some(({ lineId }) => lineId === "line-42b5805f3b5a"), false);
  assert.equal(currentTopology.lines.some(({ lineId }) => lineId === "line-98718184f016"), false);
  const staleIncheon = JSON.parse(incheonBytes);
  const buildNow = new Date(Date.parse(currentTopology.capturedAt) + 1_000).toISOString();
  assert.ok(Date.parse(buildNow) < Date.parse(currentTopology.freshUntil));
  staleIncheon.capturedAt = new Date(Date.parse(buildNow) - 24 * 60 * 60 * 1_000).toISOString();
  staleIncheon.freshUntil = buildNow;
  const staleIncheonTopologyPath = `tools/datapack/sources/incheon-transit-station-info-${staleIncheon.capturedAt.slice(0, 10).replaceAll("-", "")}.json`;
  const staleIncheonBytes = Buffer.from(`${JSON.stringify(staleIncheon)}\n`);
  const positionSnapshotBytes = await collectPositionSnapshotBytes(sourceInventory);
  const layoutTopologySnapshotBytesById = await collectLayoutTopologySnapshotBytes(sourceInventory);
  assert.throws(() => buildCurrentTopologyRefreshPrimaryOutputs({
    baseSpec,
    builderGitSha: "a".repeat(40),
    sourceInventory,
    currentTopology,
    currentTopologyBytes,
    currentTopologyPath,
    currentIncheonTopology: staleIncheon,
    currentIncheonTopologyBytes: staleIncheonBytes,
    currentIncheonTopologyPath: staleIncheonTopologyPath,
    currentIncheonAccessibility: JSON.parse(currentIncheonAccessibilityBytes),
    currentIncheonAccessibilityBytes,
    currentIncheonAccessibilityPath: incheonAccessibilityPath,
    currentIncheonTimetables: { 1: JSON.parse(line1TimetableBytes), 2: JSON.parse(line2TimetableBytes) },
    currentIncheonTimetableBytes: { 1: line1TimetableBytes, 2: line2TimetableBytes },
    currentIncheonTimetablePaths: {
      1: "tools/datapack/sources/incheon-line1-train-timetable-20260828.json",
      2: "tools/datapack/sources/incheon-line2-train-timetable-20260828.json",
    },
    currentItxTopologyEvidencePath,
    currentItxTopologyEvidenceBytes,
    baselineTopology,
    baselineTopologyBytes,
    canonical,
    productionInput,
    productionScopePolicyBytes,
    buildNow,
    snapshotBytesByPath: positionSnapshotBytes,
    layoutTopologySnapshotBytesById,
  }), /current Incheon topology snapshot is stale/);
});

test("current capital topology는 canonical fixture의 admitted capital directions만 교체한다", async () => {
  const [fixture, candidate] = await Promise.all([
    readJson("tools/datapack/release/capital-production-canonical-pack.json"),
    readJson("tools/datapack/release/candidate-build-spec.json"),
  ]);
  const topologyPath = candidate.networkEdgeEvidence.capitalTopologyCandidate.path;
  const topology = await readJson(topologyPath);
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
  const topologySnapshotId = candidate.networkEdgeEvidence.capitalTopologyCandidate.snapshotId;
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
  const retainedAfter = pack.networkEdges
    .filter((edge) => !isProjectedCapitalEdge(edge))
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  const retainedBeforeSorted = retainedBefore
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  assert.equal(retainedAfter.length, retainedBeforeSorted.length);
  assert.equal(
    sha256(Buffer.from(JSON.stringify(retainedAfter))),
    sha256(Buffer.from(JSON.stringify(retainedBeforeSorted))),
  );
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
  const [baseSpec, currentInventory] = await Promise.all([
    readJson("tools/datapack/release/candidate-build-spec.json"),
    readJson("tools/datapack/source-inventory.json"),
  ]);
  const previousSnapshot = {
    schemaVersion: 1, artifactKind: "official-source-snapshot",
    snapshotId: "kric-subway-timetable-line4-pilot-20260709", sourceId: "kric-subway-timetable",
    provider: "국가철도공단", retrievedAt: "2026-07-09T00:00:00Z",
    sourceUpdatedAt: "2026-07-09T00:00:00Z", serviceEffectiveAt: "2026-07-09T00:00:00Z",
    serviceEffectiveUntil: "2026-12-31T00:00:00Z", rowCount: 473,
    coverageCount: 1, rawSha256: "7c8badc40b31498d71d5326c50df0f87ee349103b18e416a32c133363e22e8cc",
    rawObjectUri: `oci://easysubway-datapacks/source-raw/kric-subway-timetable/20260709/${"7c8badc40b31498d71d5326c50df0f87ee349103b18e416a32c133363e22e8cc"}.json`, redactedRequestFingerprint: "4ab1e2d84e511733f7f2c95023d853089d6f31e9a39cfe617037edc58112b1aa",
    schemaFingerprint: "44585c58909db0d14ed103ecf357291e4f337fc432e9e8938043a39097d904ff", snapshotStatus: "LOCKED",
    schemaStatus: "PASS", licenseStatus: "PASS", fetchStatus: "SUCCESS",
    redistributionAllowed: true, credentialRedacted: true, previousSnapshotId: null,
    diffSummary: null, freshnessExpiresAt: "2026-08-08T00:00:00.000Z",
    rawRetentionExpiresAt: "2026-10-07T00:00:00.000Z",
  };
  const sourceIds = ["molit-urban-rail-full-route", "seoulmetro-station-line-info",
    "seoul-metro-route-map-positions", "kric-subway-timetable", "seoul-metro-accessibility",
    "kric-station-convenience-standard", "seoul-metro-official-od-fares"];
  const inventory = structuredClone(currentInventory);
  const previousTimetable = inventory.sources.find(({ id }) => id === "kric-subway-timetable");
  previousTimetable.observedDataUpdatedAt = "2026-07-09";
  previousTimetable.retrievedAt = "2026-07-09";
  previousTimetable.admissionEvidence = {
    ...previousTimetable.admissionEvidence,
    snapshotId: previousSnapshot.snapshotId,
    rawSha256: previousSnapshot.rawSha256,
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
  const [{ topology: baselineTopology, bytes: baselineTopologyBytes },
    { admission: currentCapitalAdmission, relativePath: currentTopologyPath, bytes: currentTopologyBytes, topology: currentTopology }] = await Promise.all([
    historicalCandidateCapitalTopology(baseSpec),
    currentCapitalTopology(currentInventory),
  ]);
  const currentIncheonSource = currentInventory.sources.find(({ id }) => id === "incheon-transit-station-info");
  assert.ok(currentIncheonSource?.topologyAdmissionEvidence?.snapshotPath);
  const currentIncheonTopologyPath = currentIncheonSource.topologyAdmissionEvidence.snapshotPath;
  const currentIncheonTopologyBytes = await readFile(path.join(root, currentIncheonTopologyPath));
  const currentIncheonTopology = JSON.parse(currentIncheonTopologyBytes);
  const currentIncheonAccessibilitySource = currentInventory.sources
    .find(({ id }) => id === "incheon-transit-accessibility");
  const currentIncheonAccessibilityPath = `tools/datapack/sources/${currentIncheonAccessibilitySource
    .registrationEvidence.snapshotId}.json`;
  const currentIncheonAccessibilityBytes = await readFile(path.join(root, currentIncheonAccessibilityPath));
  const currentIncheonAccessibility = JSON.parse(currentIncheonAccessibilityBytes);
  const capitalSnapshotDate = currentTopology.capturedAt.slice(0, 10).replaceAll("-", "");
  const incheonSnapshotDate = currentIncheonTopology.capturedAt.slice(0, 10).replaceAll("-", "");
  assert.equal(currentCapitalAdmission.topologySnapshotId.slice(-8), capitalSnapshotDate);
  assert.equal(path.basename(currentIncheonTopologyPath, ".json").slice(-8), incheonSnapshotDate);
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
  let omitCapitalAdmission = false;
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
    baseSpec,
    baselineTopology,
    baselineTopologyBytes,
    currentTopology,
    currentTopologyBytes,
    currentTopologyPath,
    currentIncheonTopology,
    currentIncheonTopologyBytes,
    currentIncheonTopologyPath,
    currentIncheonAccessibility,
    currentIncheonAccessibilityBytes,
    currentIncheonAccessibilityPath,
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
      assert.equal(topologySnapshotId, currentCapitalAdmission.topologySnapshotId);
      if (omitCapitalAdmission) {
        const sources = structuredClone(value.sources);
        const index = sources.findIndex((source) =>
          source.routeMapAdmissionEvidence?.currentTopologyAdmission != null);
        sources.splice(index, 1);
        return { ...value, sources, topologyAdmissionsRebound: true };
      }
      return { ...value, topologyAdmissionsRebound: true };
    },
    requireCurrentIncheonTopologyAdmissionImpl({
      sourceInventory: value, snapshotPath, accessibilitySnapshot,
      accessibilitySnapshotBytes, accessibilitySnapshotPath,
    }) {
      assert.equal(snapshotPath, currentIncheonTopologyPath);
      assert.strictEqual(accessibilitySnapshot, currentIncheonAccessibility);
      assert.strictEqual(accessibilitySnapshotBytes, currentIncheonAccessibilityBytes);
      assert.equal(accessibilitySnapshotPath, currentIncheonAccessibilityPath);
      return value;
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
  assert.equal(result.sourceInventory.incheonAdmissionsRebound, undefined);
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

  omitCapitalAdmission = true;
  assert.throws(() => build(result.sourceSnapshots), /current capital topology admissions are not exactly rebound/);
  omitCapitalAdmission = false;

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
  const currentAuthorityReviewedPack = overlayReviewedSourcesOnCanonicalRoster(canonical, reviewedPack);
  assert.deepEqual(
    currentAuthorityReviewedPack.sourceInventory.map(({ id }) => id),
    canonicalCapital.sourceInventory.map(({ id }) => id),
  );
  assert.deepEqual(
    currentAuthorityReviewedPack.sourceInventory.find(({ id }) => id === fareSourceId),
    reviewedPack.sourceInventory.find(({ id }) => id === fareSourceId),
  );
  assert.equal(
    currentAuthorityReviewedPack.sourceInventory.at(-1).id,
    canonicalCapital.sourceInventory.at(-1).id,
  );
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

test("topology refresh는 obsolete source-separated topology output을 원자 commit 대상으로 허용하지 않는다", async (context) => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "current-topology-output-"));
  context.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const obsoletePath = "tools/datapack/sources/capital-route-topology-20260823-source-separated.json";
  const rejectedPath = "tools/datapack/sources/unrelated-source-separated.json";
  await mkdir(path.dirname(path.join(repositoryRoot, obsoletePath)), { recursive: true });

  for (const relativePath of [obsoletePath, rejectedPath]) {
    await assert.rejects(commitCurrentSourceActivation({
      repositoryRoot,
      outputs: [{ relativePath, bytes: Buffer.from("rejected\n") }],
      validate: async () => {},
    }), /activation output is not allowed/);
  }
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
