import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildSnapshotDiff, validateLineage } from "../source-snapshot-policy.mjs";
import { requireExactPublicStaticNetworkV2SnapshotBinding } from "../public-static-network-v2-admission.mjs";
import {
  activateSyntheticCurrentPublicRouteMapSuccessor,
  copySyntheticCurrentPublicRouteMapRepository,
  createStaticNetworkRegistrarPredecessorFixture,
  nextSyntheticCurrentStaticNetworkNow,
  rollCandidateToLedgerHeads,
} from "./current-public-route-map-successor.mjs";
import { candidateSelectedLedgerHeads } from "./selected-source-head-clock.mjs";
import { validateCandidateSourceSet } from "../validate-candidate-source-set.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const FIXTURE_INITIAL_CANDIDATE_SOURCE_IDS = [
  "seoul-metro-route-map-positions",
  "kric-subway-timetable",
  "seoul-metro-accessibility",
  "kric-station-convenience-standard",
  "molit-urban-rail-full-route",
  "seoulmetro-station-line-info",
  "incheon-transit-accessibility",
  "seoul-metro-transfer-distance-duration",
];
const FIXTURE_PACK_SOURCE_IDS = [
  "molit-urban-rail-full-route",
  "seoulmetro-station-line-info",
  "seoul-metro-route-map-positions",
  "kric-subway-timetable",
  "seoul-metro-accessibility",
  "kric-station-convenience-standard",
  "seoul-metro-official-od-fares",
  "seoul-metro-transfer-distance-duration",
  "incheon-transit-station-info",
  "incheon-transit-accessibility",
  "incheon-line1-train-timetable",
  "incheon-line2-train-timetable",
];
const FIXTURE_SOURCE_IDS = new Set([
  ...FIXTURE_INITIAL_CANDIDATE_SOURCE_IDS,
  ...FIXTURE_PACK_SOURCE_IDS,
]);

test("current public fixture copies evidence only for its declared source universe", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-public-route-map-registered-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copySyntheticCurrentPublicRouteMapRepository(repositoryRoot, root, {
    now: await nextSyntheticCurrentStaticNetworkNow(repositoryRoot),
    activatePublicRouteMap: false,
  });

  const [sourceInventory, fixtureInventory] = await Promise.all([
    readFile(path.join(repositoryRoot, "tools/datapack/source-inventory.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8").then(JSON.parse),
  ]);
  assert.deepEqual(
    fixtureInventory.sources.filter(({ requiredForProductionPack }) => requiredForProductionPack).map(({ id }) => id).sort(),
    [...FIXTURE_INITIAL_CANDIDATE_SOURCE_IDS].sort(),
  );
  const snapshotPaths = sourceInventory.sources.filter(({ id }) => FIXTURE_SOURCE_IDS.has(id)).flatMap((source) => [
    typeof source.registrationEvidence?.snapshotId === "string"
      ? `tools/datapack/sources/${source.registrationEvidence.snapshotId}.json`
      : null,
    source.topologyAdmissionEvidence?.snapshotPath,
  ]).filter((relative) => typeof relative === "string");
  assert.ok(snapshotPaths.length > 0);
  for (const relative of snapshotPaths) {
    assert.deepEqual(
      await readFile(path.join(root, relative)),
      await readFile(path.join(repositoryRoot, relative)),
    );
  }
});

test("current public fixture does not auto-enroll a new required production source", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "current-public-route-map-source-"));
  const baselineRoot = await mkdtemp(path.join(os.tmpdir(), "current-public-route-map-baseline-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "current-public-route-map-target-"));
  t.after(() => Promise.all([sourceRoot, baselineRoot, targetRoot].map((root) => rm(root, { recursive: true, force: true }))));
  const now = await nextSyntheticCurrentStaticNetworkNow(repositoryRoot);
  await Promise.all([
    copySyntheticCurrentPublicRouteMapRepository(repositoryRoot, sourceRoot, { now, activatePublicRouteMap: false }),
    copySyntheticCurrentPublicRouteMapRepository(repositoryRoot, baselineRoot, { now, activatePublicRouteMap: false }),
  ]);
  const inventoryPath = path.join(sourceRoot, "tools/datapack/source-inventory.json");
  const sourceInventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  sourceInventory.sources.push({
    ...structuredClone(sourceInventory.sources[0]),
    id: "fixture-unrelated-required-production-source",
    requiredForProductionPack: true,
  });
  await writeFile(inventoryPath, `${JSON.stringify(sourceInventory, null, 2)}\n`);
  await copySyntheticCurrentPublicRouteMapRepository(sourceRoot, targetRoot, { now, activatePublicRouteMap: false });

  const relativeInputs = [
    "tools/datapack/source-inventory.json",
    "tools/datapack/release/candidate-build-spec.json",
    "tools/datapack/release/capital-production-canonical-pack.json",
    "release/product-gates/production-datapack-scope.json",
  ];
  for (const relative of relativeInputs) {
    assert.deepEqual(
      await readFile(path.join(targetRoot, relative)),
      await readFile(path.join(baselineRoot, relative)),
      relative,
    );
  }
  const [candidate, pack, scope] = await Promise.all([
    readFile(path.join(targetRoot, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(targetRoot, "tools/datapack/release/capital-production-canonical-pack.json"), "utf8").then(JSON.parse),
    readFile(path.join(targetRoot, "release/product-gates/production-datapack-scope.json"), "utf8").then(JSON.parse),
  ]);
  assert.deepEqual(candidate.sourceSnapshots.map(({ sourceId }) => sourceId), FIXTURE_INITIAL_CANDIDATE_SOURCE_IDS);
  assert.deepEqual(scope.productionSourceSet.requiredSourceIds, FIXTURE_INITIAL_CANDIDATE_SOURCE_IDS);
  assert.deepEqual(pack.packs.find(({ id }) => id === "capital").sourceInventory.map(({ id }) => id), FIXTURE_PACK_SOURCE_IDS);
});

test("current public candidate slot derives a same-source public V2 successor on a topology-only refresh", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-public-route-map-predecessor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copySyntheticCurrentPublicRouteMapRepository(repositoryRoot, root, {
    now: await nextSyntheticCurrentStaticNetworkNow(repositoryRoot),
  });

  const [before, fixtureCanonical] = await Promise.all([
    readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/capital-production-canonical-pack.json"), "utf8").then(JSON.parse),
  ]);
  assert.deepEqual(
    fixtureCanonical.packs[0].sourceInventory.map(({ id }) => id),
    FIXTURE_PACK_SOURCE_IDS,
  );
  const beforePublicIndex = before.sourceSnapshots.findIndex(({ sourceId }) =>
    sourceId === "seoul-metro-route-map-positions");
  assert.notEqual(beforePublicIndex, -1);

  const result = await activateSyntheticCurrentPublicRouteMapSuccessor(root, {
    now: await nextSyntheticCurrentStaticNetworkNow(root),
  });
  assert.match(result.predecessorSnapshotId, /^seoul-metro-route-map-positions-current-/u);

  const candidateBytes = await readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"));
  const after = JSON.parse(candidateBytes);
  const request = JSON.parse(await readFile(path.join(root, "tools/datapack/release/release-request.json"), "utf8"));
  const hashes = JSON.parse(await readFile(path.join(root, "tools/datapack/release/hash-evidence.json"), "utf8"));
  const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const afterPublicIndex = after.sourceSnapshots.findIndex(({ sourceId }) =>
    sourceId === "seoul-metro-route-map-positions");
  assert.notEqual(afterPublicIndex, -1);
  assert.equal(after.sourceSnapshotIds[afterPublicIndex], result.snapshotId);
  assert.equal(request.candidateId, after.candidateId);
  assert.equal(request.buildSpecSha256, createHash("sha256").update(candidateBytes).digest("hex"));
  assert.equal(request.approvalId, `release-request-${after.candidateId}-${request.buildSpecSha256}`);
  assert.equal(hashes.identifiers.candidateId.value, after.candidateId);
  assert.equal(hashes.identifiers.approvalId.value, request.approvalId);
  assert.equal(hashes.ledgerHashes.approvedAliasLedgerHash.value, after.approvedAliasLedgerHash);
  assert.deepEqual(after.networkEdgeEvidence.capitalTopology, before.networkEdgeEvidence.capitalTopology);
  const admissions = inventory.sources
    .filter(({ routeMapAdmissionEvidence }) => routeMapAdmissionEvidence?.topologySourceId === "capital-route-topology")
    .map(({ routeMapAdmissionEvidence }) => routeMapAdmissionEvidence.currentTopologyAdmission);
  const candidate = after.networkEdgeEvidence.capitalTopologyCandidate;
  const topologyAdmission = after.networkEdgeEvidence.capitalTopologyAdmission;
  assert.ok(admissions.length > 0);
  assert.ok(Date.parse(after.publishedAt) >= Date.parse(topologyAdmission.reverifiedAt));
  assert.ok(Date.parse(after.publishedAt) < Date.parse(topologyAdmission.freshUntil));
  assert.ok(admissions.every((admission) => admission.topologySnapshotId === candidate.snapshotId
    && admission.topologyContentSha256 === topologyAdmission.contentSha256
    && admission.reviewedAt === topologyAdmission.reviewedAt
    && admission.freshUntil === topologyAdmission.freshUntil
    && admission.topologyLineages.every((lineage) => lineage.sourceId === "capital-route-topology"
      && lineage.snapshotId === candidate.snapshotId
      && lineage.contentSha256 === admission.topologyContentSha256)));
});

test("already-public-root fixture activation preserves one valid source lineage root", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-public-route-map-existing-root-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copySyntheticCurrentPublicRouteMapRepository(repositoryRoot, root, {
    now: await nextSyntheticCurrentStaticNetworkNow(repositoryRoot),
  });

  const result = await activateSyntheticCurrentPublicRouteMapSuccessor(root, {
    now: await nextSyntheticCurrentStaticNetworkNow(root),
  });
  const [candidate, snapshots] = await Promise.all([
    readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/source-snapshots.json"), "utf8").then(JSON.parse),
  ]);
  const publicSnapshots = snapshots.filter(({ sourceId }) => sourceId === "seoul-metro-route-map-positions");
  const publicIndex = candidate.sourceSnapshots.findIndex(({ sourceId }) =>
    sourceId === "seoul-metro-route-map-positions");

  assert.doesNotThrow(() => validateLineage(snapshots));
  assert.notEqual(publicIndex, -1);
  assert.equal(publicSnapshots.filter(({ previousSnapshotId }) => previousSnapshotId == null).length, 1);
  assert.equal(candidate.sourceSnapshotIds[publicIndex], result.snapshotId);
});

test("current public fixture rejects a fork outside the selected head before mutation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-public-route-map-forked-lineage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copySyntheticCurrentPublicRouteMapRepository(repositoryRoot, root, {
    now: await nextSyntheticCurrentStaticNetworkNow(repositoryRoot),
    activatePublicRouteMap: false,
  });
  const [candidate, snapshots] = await Promise.all([
    readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/source-snapshots.json"), "utf8").then(JSON.parse),
  ]);
  const selectedId = candidate.sourceSnapshotIds[candidate.sourceSnapshots.findIndex(({ sourceId }) =>
    sourceId === "seoul-metro-route-map-positions")];
  const selected = snapshots.find(({ snapshotId }) => snapshotId === selectedId);
  const parent = snapshots.find(({ snapshotId }) => snapshotId === selected.previousSnapshotId);
  assert.ok(selected);
  assert.ok(parent);
  const fork = structuredClone(selected);
  fork.snapshotId = `${selected.snapshotId}-fork`;
  fork.retrievedAt = new Date(Date.parse(selected.retrievedAt) + 1_000).toISOString();
  fork.diffSummary = buildSnapshotDiff(parent, fork);
  snapshots.push(fork);
  await writeFile(
    path.join(root, "tools/datapack/release/source-snapshots.json"),
    `${JSON.stringify(snapshots, null, 2)}\n`,
  );

  await assert.rejects(
    async () => activateSyntheticCurrentPublicRouteMapSuccessor(root, { now: await nextSyntheticCurrentStaticNetworkNow(root) }),
    /SOURCE_LINEAGE_BROKEN: snapshot fork/,
  );
});

test("current public fixture rejects a duplicate or out-of-scope candidate lineage before mutation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-public-route-map-invalid-lineage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copySyntheticCurrentPublicRouteMapRepository(repositoryRoot, root, {
    now: await nextSyntheticCurrentStaticNetworkNow(repositoryRoot),
    activatePublicRouteMap: false,
  });
  const inventoryPath = path.join(root, "tools/datapack/source-inventory.json");
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  const admission = inventory.sources.find(({ routeMapAdmissionEvidence }) =>
    routeMapAdmissionEvidence?.topologySourceId === "capital-route-topology")
    .routeMapAdmissionEvidence.currentTopologyAdmission;
  admission.topologyLineages.push({ ...admission.topologyLineages[0] });
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);

  await assert.rejects(
    activateSyntheticCurrentPublicRouteMapSuccessor(root, { now: await nextSyntheticCurrentStaticNetworkNow(root) }),
    /synthetic current topology admission bytes are invalid/,
  );
});

test("advancing a current public head derives records from its admitted current layout", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-public-route-map-current-layout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copySyntheticCurrentPublicRouteMapRepository(repositoryRoot, root, {
    now: await nextSyntheticCurrentStaticNetworkNow(repositoryRoot),
    activatePublicRouteMap: false,
  });

  const [candidate, beforeSnapshots] = await Promise.all([
    readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/source-snapshots.json"), "utf8").then(JSON.parse),
  ]);
  const publicIndex = candidate.sourceSnapshots.findIndex(({ sourceId }) =>
    sourceId === "seoul-metro-route-map-positions");
  const parent = beforeSnapshots.find(({ snapshotId }) => snapshotId === candidate.sourceSnapshotIds[publicIndex]);
  assert.notEqual(publicIndex, -1);
  assert.ok(parent);

  const result = await activateSyntheticCurrentPublicRouteMapSuccessor(root, {
    now: await nextSyntheticCurrentStaticNetworkNow(root),
    advanceCurrentPublicHead: true,
  });
  const afterSnapshots = JSON.parse(await readFile(
    path.join(root, "tools/datapack/release/source-snapshots.json"),
    "utf8",
  ));
  const child = afterSnapshots.find(({ snapshotId }) => snapshotId === result.snapshotId);

  assert.equal(result.predecessorSnapshotId, parent.snapshotId);
  assert.equal(child.previousSnapshotId, parent.snapshotId);
  assert.equal(child.rawSha256, parent.rawSha256);
  assert.equal(child.contentSha256, parent.contentSha256);
  assert.equal(child.schemaFingerprint, parent.schemaFingerprint);
  assert.equal(child.rowCount, parent.rowCount);
  assert.equal(child.coverageCount, parent.coverageCount);
  assert.equal(child.provider, parent.provider);
  assert.deepEqual(child.providerRecordHashes, parent.providerRecordHashes);
  assert.deepEqual(child.publicStaticNetworkV2Observation.normalizedProjection, parent.publicStaticNetworkV2Observation.normalizedProjection);
  const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const admission = inventory.sources.find(({ id }) => id === child.sourceId)
    .routeMapAdmissionEvidence.currentLayoutAdmission;
  const observationBytes = await readFile(path.join(root, admission.snapshotPath));
  assert.equal(createHash("sha256").update(observationBytes).digest("hex"), admission.snapshotSha256);
  assert.doesNotThrow(() => requireExactPublicStaticNetworkV2SnapshotBinding({
    snapshot: child,
    source: inventory.sources.find(({ id }) => id === child.sourceId),
  }));
  assert.deepEqual(child.diffSummary, buildSnapshotDiff(parent, child));
  assert.equal(child.diffSummary.status, "NO_CHANGE");
});

test("advancing a current public head keeps retrieval time monotonic in a one-second window", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-public-route-map-monotonic-time-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copySyntheticCurrentPublicRouteMapRepository(repositoryRoot, root, {
    now: await nextSyntheticCurrentStaticNetworkNow(repositoryRoot),
    activatePublicRouteMap: false,
  });

  // Fixture는 수집 시각을 실행보다 1분 앞에 둔다. 유효한 parent를 먼저 만들고
  // 아래 검증에서는 그 parent로부터 정확히 1초만 전진한다.
  const seedNow = new Date((await nextSyntheticCurrentStaticNetworkNow(root)).getTime() + 60_000);
  await activateSyntheticCurrentPublicRouteMapSuccessor(root, {
    now: seedNow,
    advanceCurrentPublicHead: true,
  });

  const [candidate, beforeSnapshots] = await Promise.all([
    readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/source-snapshots.json"), "utf8").then(JSON.parse),
  ]);
  const publicIndex = candidate.sourceSnapshots.findIndex(({ sourceId }) =>
    sourceId === "seoul-metro-route-map-positions");
  const parent = beforeSnapshots.find(({ snapshotId }) => snapshotId === candidate.sourceSnapshotIds[publicIndex]);
  assert.notEqual(publicIndex, -1);
  assert.ok(parent);
  const now = new Date(Date.parse(parent.retrievedAt) + 1_000);

  const result = await activateSyntheticCurrentPublicRouteMapSuccessor(root, {
    now,
    advanceCurrentPublicHead: true,
  });
  const afterSnapshots = JSON.parse(await readFile(
    path.join(root, "tools/datapack/release/source-snapshots.json"),
    "utf8",
  ));
  const child = afterSnapshots.find(({ snapshotId }) => snapshotId === result.snapshotId);

  assert.equal(result.predecessorSnapshotId, parent.snapshotId);
  assert.ok(Date.parse(child.retrievedAt) > Date.parse(parent.retrievedAt));
  assert.ok(Date.parse(child.retrievedAt) <= now.getTime());
  assert.doesNotThrow(() => validateLineage(afterSnapshots));
});

test("registrar fixture derives a selected same-source public root", async (t) => {
  const source = await mkdtemp(path.join(os.tmpdir(), "current-public-route-map-registrar-source-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "current-public-route-map-registrar-predecessor-"));
  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copySyntheticCurrentPublicRouteMapRepository(repositoryRoot, source, {
    now: await nextSyntheticCurrentStaticNetworkNow(repositoryRoot),
  });

  const result = await createStaticNetworkRegistrarPredecessorFixture(source, root, {
    now: await nextSyntheticCurrentStaticNetworkNow(source),
  });
  const [candidate, snapshots] = await Promise.all([
    readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/source-snapshots.json"), "utf8").then(JSON.parse),
  ]);
  const publicIndex = candidate.sourceSnapshots.findIndex(({ sourceId }) =>
    sourceId === "seoul-metro-route-map-positions");
  assert.notEqual(publicIndex, -1);
  const selected = snapshots.find(({ snapshotId }) => candidate.sourceSnapshotIds[publicIndex] === snapshotId);

  assert.equal(selected.snapshotId, result.currentSnapshotId);
  assert.equal(selected.previousSnapshotId, result.predecessorSnapshotId);
  assert.doesNotThrow(() => validateLineage(snapshots));
});

// #1007: 정기 갱신(KRIC 시설·서울 접근성)은 원장에 새 head를 덧붙이고 후보 pin은 그대로 둔다. 후보 갱신이 pin을 옮기기 전의 상태다.
async function refreshedLedgerUniverse(sourceId) {
  const [candidate, snapshots, inventory, governanceBytes, freshnessPolicy] = await Promise.all([
    readFile(path.join(repositoryRoot, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(repositoryRoot, "tools/datapack/release/source-snapshots.json"), "utf8").then(JSON.parse),
    readFile(path.join(repositoryRoot, "tools/datapack/source-inventory.json"), "utf8").then(JSON.parse),
    readFile(path.join(repositoryRoot, "tools/datapack/source-governance-policy.json")),
    readFile(path.join(repositoryRoot, "release/product-gates/datapack-freshness-sla.json"), "utf8").then(JSON.parse),
  ]);
  // 후속은 후보 pin이 아니라 원장 head 위에 쌓는다(이미 정기 갱신이 head를 앞으로 옮긴 저장소에서도 같은 테스트가 돈다).
  const pinned = snapshots.find(({ snapshotId }) => snapshotId === validateLineage(snapshots).headsBySource[sourceId]);
  const successor = {
    ...structuredClone(pinned),
    snapshotId: `${sourceId}-20991231T000000000Z`,
    previousSnapshotId: pinned.snapshotId,
    retrievedAt: "2099-12-31T00:00:00.000Z",
    capturedAt: "2099-12-31T00:00:00.000Z",
  };
  successor.diffSummary = buildSnapshotDiff(pinned, successor);
  return {
    candidate, inventory, pinned, successor, governanceBytes, freshnessPolicy,
    snapshots: [...snapshots, successor],
    governancePolicy: JSON.parse(governanceBytes),
    now: new Date("2099-12-31T00:01:00.000Z"),
  };
}

test("정기 갱신으로 원장 head가 후보 pin보다 앞서면 fixture 후보와 시각 기준은 head를 고른다(#1007)", async () => {
  const universe = await refreshedLedgerUniverse("seoul-metro-accessibility");
  const { headsBySource } = validateLineage(universe.snapshots);
  assert.equal(headsBySource["seoul-metro-accessibility"], universe.successor.snapshotId);
  const original = structuredClone(universe.candidate);
  const clockHeads = candidateSelectedLedgerHeads(original, universe.snapshots);
  assert.deepEqual(clockHeads.map(({ snapshotId }) => snapshotId), original.sourceSnapshots.map(({ sourceId }) => headsBySource[sourceId]));
  assert.equal(clockHeads.find(({ sourceId }) => sourceId === "seoul-metro-accessibility").snapshotId, universe.successor.snapshotId);

  rollCandidateToLedgerHeads(universe);
  assert.deepEqual(universe.candidate.sourceSnapshots.map(({ sourceId, snapshotId }) => [sourceId, snapshotId]),
    original.sourceSnapshots.map(({ sourceId }) => [sourceId, headsBySource[sourceId]]));
  assert.deepEqual(universe.candidate.sourceSnapshotIds, universe.candidate.sourceSnapshots.map(({ snapshotId }) => snapshotId));
  // 이미 head인 pin의 투영은 건드리지 않는다.
  for (const projection of universe.candidate.sourceSnapshots) {
    const before = original.sourceSnapshots.find(({ sourceId }) => sourceId === projection.sourceId);
    if (before.snapshotId === projection.snapshotId) assert.deepEqual(projection, before);
  }
});

test("원장에 없는 후보 pin은 시각 기준 계산이 거부하고 fixture는 pin을 옮기지 않는다(#1007 반례)", async () => {
  const universe = await refreshedLedgerUniverse("kric-station-convenience-standard");
  const unknown = `kric-station-convenience-standard-${"0".repeat(8)}`;
  universe.candidate.sourceSnapshots = universe.candidate.sourceSnapshots.map((entry) =>
    entry.sourceId === "kric-station-convenience-standard" ? { ...entry, snapshotId: unknown } : entry);
  assert.throws(() => candidateSelectedLedgerHeads(universe.candidate, universe.snapshots), /selected source snapshot identity/u);
  // 다른 원천의 실재 snapshot id를 pin으로 두어도 거부한다.
  const otherSource = universe.snapshots.find(({ sourceId }) => sourceId === "seoul-metro-accessibility").snapshotId;
  assert.throws(() => candidateSelectedLedgerHeads({ sourceSnapshots: [{ sourceId: "kric-station-convenience-standard", snapshotId: otherSource }] }, universe.snapshots), /selected source snapshot identity/u);
  rollCandidateToLedgerHeads(universe);
  assert.equal(universe.candidate.sourceSnapshots.find(({ sourceId }) => sourceId === "kric-station-convenience-standard").snapshotId, unknown);
});

test("원장 계보 밖의 실재 행·중복 id는 head 선택과 fixture 후보 이동이 모두 거부한다(#1007 반례)", async () => {
  const universe = await refreshedLedgerUniverse("seoul-metro-accessibility");
  // 같은 원천의 실재 행이 head 사슬 밖에 있다(같은 선행에서 갈라진 fork).
  const orphan = { ...structuredClone(universe.successor), snapshotId: "seoul-metro-accessibility-orphan" };
  const forked = { ...universe, snapshots: [...universe.snapshots, orphan] };
  assert.throws(() => candidateSelectedLedgerHeads(universe.candidate, forked.snapshots), /SOURCE_LINEAGE_BROKEN/u);
  assert.throws(() => rollCandidateToLedgerHeads(forked), /SOURCE_LINEAGE_BROKEN/u);
  // 같은 snapshotId의 행이 둘이다.
  const duplicated = [...universe.snapshots, structuredClone(universe.successor)];
  assert.throws(() => candidateSelectedLedgerHeads(universe.candidate, duplicated), /SOURCE_LINEAGE_BROKEN: duplicate snapshot ID/u);
});

test("fixture 시계가 원장 head보다 앞서면(시각 역전) 후보를 head로 옮기지 않고 거부한다(#1007 반례)", async () => {
  const universe = await refreshedLedgerUniverse("seoul-metro-accessibility");
  assert.throws(() => rollCandidateToLedgerHeads({ ...universe, now: new Date("2099-12-30T00:00:00.000Z") }), /basisAt exceeds clock skew/u);
});

test("release 게이트 validateCandidateSourceSet은 후보 pin이 원장 head가 아니면 내용이 같아도 거부한다(validate-candidate-source-set.mjs 114행, #1007)", async () => {
  const [productionScopeBytes, sourceInventoryBytes] = await Promise.all([
    readFile(path.join(repositoryRoot, "release/product-gates/production-datapack-scope.json")),
    readFile(path.join(repositoryRoot, "tools/datapack/source-inventory.json")),
  ]);
  const universe = await refreshedLedgerUniverse("kric-station-convenience-standard");
  const baseLedger = universe.snapshots.filter(({ snapshotId }) => snapshotId !== universe.successor.snapshotId);
  // 지금 원장·inventory에 맞게 결속한 후보(pin이 head)를 만든다. 커밋된 후보가 정기 갱신 직후 이전 pin을 가리켜도 이 테스트는 같다.
  const sha = (value) => createHash("sha256").update(value).digest("hex");
  const rolled = structuredClone(universe.candidate);
  rollCandidateToLedgerHeads({ ...universe, candidate: rolled, snapshots: baseLedger, now: new Date("2099-12-31T00:01:00.000Z"), inventory: universe.inventory });
  const selectedIds = new Set(rolled.sourceSnapshotIds);
  const bind = (candidate, ledger) => {
    const bound = structuredClone(candidate);
    bound.sourceSnapshotSetHash = sha(JSON.stringify(ledger.filter(({ snapshotId }) => selectedIds.has(snapshotId))));
    bound.sourceInventorySha256 = sha(JSON.stringify(universe.inventory));
    bound.networkEdgeEvidence = { ...bound.networkEdgeEvidence, sourceInventory: { path: "tools/datapack/source-inventory.json", sha256: sha(sourceInventoryBytes) } };
    return bound;
  };
  const candidate = bind(rolled, baseLedger);
  const gate = (ledger, value = candidate) => validateCandidateSourceSet({ productionScopeBytes, sourceInventoryBytes, candidate: value, ledger });
  // 결속된 후보는 통과한다(pin이 head다).
  assert.equal(gate(baseLedger).headsBySource["kric-station-convenience-standard"], universe.pinned.snapshotId);
  // 정기 갱신이 원장에 head를 덧붙이면, 후속의 내용(원본·정규화 내용 sha)이 같아도 달라도 게이트는 후보를 거부한다.
  assert.throws(() => gate([...baseLedger, universe.successor]), /candidate source is not the active ledger head/u);
  const changed = { ...universe.successor, rawSha256: "9".repeat(64), contentSha256: "8".repeat(64) };
  changed.diffSummary = buildSnapshotDiff(universe.pinned, changed);
  assert.throws(() => gate([...baseLedger, changed]), /candidate source is not the active ledger head/u);
  // 후보 pin이 원장에 없거나 선택 집합 해시가 다르면 거부한다.
  const unknownPin = structuredClone(candidate);
  unknownPin.sourceSnapshotIds[0] = `${unknownPin.sourceSnapshots[0].sourceId}-${"0".repeat(8)}`;
  unknownPin.sourceSnapshots[0] = { ...unknownPin.sourceSnapshots[0], snapshotId: unknownPin.sourceSnapshotIds[0] };
  assert.throws(() => gate(baseLedger, unknownPin), /candidate ledger selection mismatch/u);
  assert.throws(() => gate(baseLedger, { ...structuredClone(candidate), sourceSnapshotSetHash: "7".repeat(64) }), /candidate source snapshot set hash mismatch/u);
});
