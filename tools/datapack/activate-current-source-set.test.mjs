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
import { activateIncheonTopologyAdmission, activateStaticSourceRevalidations,
  buildCurrentCandidateSpec, buildCurrentSourcePrimaryOutputs, commitCurrentSourceActivation,
  collectPositionSnapshotBytes, parseCurrentSourceActivationArgs, requireCleanBuilder,
  readBuilderBaselineBytes,
  stageValidationItxTopologyEvidence,
  validatePreparedCandidate,
  verifyCurrentSeoulCanonicalMembership } from "./activate-current-source-set.mjs";
import { normalizeStationName, projectCapitalTopologyOwnership } from "./collect-capital-route-topology.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const TEST_GOVERNANCE_POLICY_BINDING = Object.freeze({
  governancePolicyVersion: "2026-07-15",
  governancePolicySha256: "9".repeat(64),
});

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
async function readJson(relativePath) { return JSON.parse(await readFile(path.join(root, relativePath), "utf8")); }

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
        capitalTopology: { path: "tools/datapack/sources/capital-route-topology-20260724.json" },
        capitalTopologyCandidate: { path: "tools/datapack/sources/capital-route-topology-20260813.json" },
        capitalTopologyReverification: {
          path: "tools/datapack/release/capital-topology-reverification-20260813.json",
        },
        itxCoverageContract: { path: "tools/datapack/itx-cheongchun-coverage-contract.json" },
      },
    },
    async runNodeImpl(script, args, options) {
      calls.push({ script, args, options });
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
    now: new Date("2026-08-14T00:00:00.000Z"),
  });
  const source = activated.sources.find(({ id }) => id === "incheon-transit-station-info");
  const accessibility = activated.sources.find(({ id }) => id === "incheon-transit-accessibility")
    .accessibilityAdmissionEvidence;

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
    governancePolicyBinding: TEST_GOVERNANCE_POLICY_BINDING,
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

test("activation은 MOLIT no-change와 Seoul changed-source admission의 exact mixed pair만 수용한다", () => {
  const canonicalPackBytes = Buffer.from('{"packs":[{"id":"capital"}]}');
  const previous = [
    staticRoot("molit-urban-rail-full-route"),
    staticRoot("seoulmetro-station-line-info"),
  ];
  const revalidations = [
    staticRevalidation(previous[0]),
    staticChangeAdmission(previous[1], canonicalPackBytes),
  ];
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
    canonicalMembershipSha256: revalidations[1].evidence.canonicalMembershipSha256,
    buildNow: "2026-08-13T10:30:01.000Z",
    observationDate: "20260813",
  });
  const seoul = activated.sourceInventory.sources.find(
    ({ id }) => id === "seoulmetro-station-line-info",
  );
  assert.equal(seoul.admissionEvidence.snapshotId, revalidations[1].snapshot.snapshotId);
  assert.equal(seoul.admissionEvidence.rawSha256, revalidations[1].snapshot.rawSha256);
  assert.equal(seoul.admissionEvidence.schemaFingerprint,
    revalidations[1].snapshot.schemaFingerprint);
  assert.equal(seoul.admissionEvidence.rawObjectUri, revalidations[1].snapshot.rawObjectUri);
  assert.equal(seoul.admissionEvidence.revalidationEvidenceSha256,
    revalidations[1].evidence.evidenceSha256);
  assert.equal(seoul.observedDataUpdatedAt, "2026-06-22");

  const mutations = [
    (value) => { value[1].evidence.canonicalPackSha256 = "f".repeat(64); },
    (value) => { value[1].evidence.rawObjectUri = value[1].evidence.rawObjectUri.replace("oci:", "s3:"); },
    (value) => { value[1].snapshot.providerRecordHashes.reverse(); },
    (value) => { value[1].snapshot.diffSummary.requestHashChanged = false; },
    (value) => { value[1].evidence.outcome = "NO_CHANGE_REVALIDATED"; },
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
      canonicalMembershipSha256: revalidations[1].evidence.canonicalMembershipSha256,
      buildNow: "2026-08-13T10:30:01.000Z",
      observationDate: "20260813",
    }), /static revalidation evidence identity mismatch/);
  }

  const unbound = structuredClone(revalidations);
  unbound[1].evidence.canonicalPackSha256 = null;
  const { evidenceSha256: _staleEvidenceSha256, ...unboundPayload } = unbound[1].evidence;
  unbound[1].evidence.evidenceSha256 = sha256(JSON.stringify(unboundPayload));
  unbound[1].snapshot.revalidationEvidenceSha256 = unbound[1].evidence.evidenceSha256;
  assert.throws(() => activateStaticSourceRevalidations({
    sourceSnapshots: previous,
    sourceInventory,
    revalidations: unbound,
    governancePolicyBinding: TEST_GOVERNANCE_POLICY_BINDING,
    canonicalMembershipSha256: revalidations[1].evidence.canonicalMembershipSha256,
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

test("generated current candidate spec은 expired ITX topology overlay를 재도입하지 않는다", async () => {
  const currentTopologyPath = "tools/datapack/sources/capital-route-topology-20260813.json";
  const [baseSpec, currentTopologyBytes] = await Promise.all([
    readJson("tools/datapack/release/candidate-build-spec.json"),
    readFile(path.join(root, currentTopologyPath)),
  ]);
  const currentTopology = JSON.parse(currentTopologyBytes.toString("utf8"));

  const next = buildCurrentCandidateSpec({
    baseSpec,
    builderGitSha: "a".repeat(40),
    sourceInventoryBytes: Buffer.from("{}"),
    currentTopology,
    currentTopologyBytes,
    currentTopologyPath,
    topologyReverificationBytes: Buffer.from("{}"),
  });

  assert.equal(Object.hasOwn(next.networkEdgeEvidence, "itxCurrentTopologyAdmission"), false);
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
  input.sourceIds = [...new Set([...input.sourceIds, fareSourceId])];
  input.coverageEvidence = [
    ...input.coverageEvidence.filter(({ sourceDomain }) => sourceDomain !== "official_od_fares"),
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
