import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { buildSeoulRouteMapPositions } from "../collect-seoul-route-map-positions.mjs";
import {
  buildCapitalTopologyReverificationEvidence,
  projectCapitalTopologyOwnership,
} from "../collect-capital-route-topology.mjs";
import { currentIncheonStationCodeDerivations } from "../collect-incheon-station-info.mjs";
import {
  projectCapitalTopologyIntoCanonicalFixture,
  validateSourceSeparatedCurrentTopology,
} from "../build-datapack.mjs";
import { buildFixtureCurrentExitV2Receipt, canonicalFixtureCurrentExitV2ReceiptJson } from "./current-exit-v2-receipt.mjs";
import { deriveFreshnessExpiresAt } from "../freshness-policy.mjs";
import { canonicalJson } from "../lib/manifest-validation.mjs";
import {
  CURRENT_SEOUL_PUBLIC_ROUTE_MAP_COVERAGE,
  materializeSeoulRouteMapPositions,
  verifyCurrentCapitalPublicRouteMapDocument,
} from "../materialize-seoul-route-map-positions.mjs";
import {
  deriveReleaseProjection,
  requireCurrentCanonicalSourceRoster,
} from "../rebind-current-candidate-source-snapshots.mjs";
import { buildSnapshotDiff, validateLineage } from "../source-snapshot-policy.mjs";
import { deriveRawRetentionExpiresAt } from "../source-governance-policy.mjs";
import { buildCurrentCapitalRouteTopologyRegistrationOutputs } from "../register-current-capital-route-topology.mjs";
import { currentTopologyAdmissionClock } from "./current-topology-admission-clock.mjs";
import { createFixtureCapitalTopologyReceipt } from "./current-capital-topology-registration.mjs";

const PUBLIC_SOURCE_ID = "seoul-metro-route-map-positions";
const MOLIT_SOURCE_ID = "molit-urban-rail-full-route";
const CAPITAL_TOPOLOGY_SOURCE_ID = "capital-route-topology";
const TRANSFER_SOURCE_ID = "seoul-metro-transfer-distance-duration";
const SHA_KEYS = Object.freeze([
  "layoutAlgorithmVersion", "topologySnapshotId", "topologySnapshotSha256",
  "topologySnapshotIdentity", "lineOrderSha256", "aliasLedgerVersion", "aliasLedgerSha256",
  "rawPositionsSha256", "layoutPositionsSha256", "layoutTracksSha256", "semanticInputSha256",
  "semanticOutputSha256", "outputSchemaSha256", "layoutArtifactSha256",
]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function bindSyntheticReleaseArtifacts({
  candidate, candidateBytes, request, hashes, packBytes, selectedSnapshots, inventory,
}) {
  const buildSpecSha256 = sha256(candidateBytes);
  const approvalId = `release-request-${candidate.candidateId}-${buildSpecSha256}`;
  Object.assign(request, {
    candidateId: candidate.candidateId,
    buildSpecSha256,
    approvalId,
    sourceSnapshotSetHash: candidate.sourceSnapshotSetHash,
    approvedLedgerHash: candidate.approvedAliasLedgerHash,
  });
  hashes.identifiers.candidateId.value = candidate.candidateId;
  hashes.identifiers.approvalId.value = approvalId;
  hashes.ledgerHashes.approvedAliasLedgerHash.value = candidate.approvedAliasLedgerHash;
  hashes.sourceSnapshotSetHash.value = candidate.sourceSnapshotSetHash;
  hashes.sourceInventorySha256.value = candidate.sourceInventorySha256;
  hashes.fixturePath.sha256 = sha256(packBytes);
  hashes.sourceSnapshots.order = `release snapshot 순서: ${selectedSnapshots.map(({ sourceId }) => sourceId).join(" → ")}`;
  hashes.perSourceEvidence = selectedSnapshots.map((selectedSnapshot) => ({
    sourceId: selectedSnapshot.sourceId,
    snapshotId: selectedSnapshot.snapshotId,
    rawSha256: selectedSnapshot.rawSha256,
    adminReviewRecordHash: inventory.sources.find(({ id }) => id === selectedSnapshot.sourceId)
      .admissionEvidence.adminReviewRecordHash,
    perSourceSnapshotSetHash: sha256(JSON.stringify([selectedSnapshot])),
  }));
}

function outputBytes(outputs, relative) {
  const matches = outputs.filter((output) => output.relative === relative);
  if (matches.length !== 1 || !Buffer.isBuffer(matches[0].bytes)) {
    throw new Error("synthetic capital topology registration output is incomplete");
  }
  return matches[0].bytes;
}

function addFixtureTopologyScope(scope) {
  const requiredSourceIds = scope?.productionSourceSet?.requiredSourceIds;
  if (!Array.isArray(requiredSourceIds) || new Set(requiredSourceIds).size !== requiredSourceIds.length) {
    throw new Error("synthetic production source scope is invalid");
  }
  const withoutTopology = requiredSourceIds.filter((sourceId) => sourceId !== CAPITAL_TOPOLOGY_SOURCE_ID);
  const transferIndex = withoutTopology.indexOf(TRANSFER_SOURCE_ID);
  if (transferIndex < 0 || transferIndex !== withoutTopology.length - 1) {
    throw new Error("synthetic production source scope must keep TRANSFER terminal");
  }
  scope.productionSourceSet.requiredSourceIds = [
    ...withoutTopology.slice(0, -1), CAPITAL_TOPOLOGY_SOURCE_ID, TRANSFER_SOURCE_ID,
  ];
}

function addFixtureTopologySelection(candidate, snapshot) {
  const projectionIndex = candidate.sourceSnapshots.findIndex(({ sourceId }) => sourceId === CAPITAL_TOPOLOGY_SOURCE_ID);
  const transferIndex = candidate.sourceSnapshots.findIndex(({ sourceId }) => sourceId === TRANSFER_SOURCE_ID);
  if (transferIndex < 0 || transferIndex !== candidate.sourceSnapshots.length - 1
    || candidate.sourceSnapshotIds[transferIndex] == null) {
    throw new Error("synthetic candidate source selection must keep TRANSFER terminal");
  }
  if (projectionIndex >= 0) {
    candidate.sourceSnapshotIds[projectionIndex] = snapshot.snapshotId;
    candidate.sourceSnapshots[projectionIndex] = snapshot.projection;
    return;
  }
  candidate.sourceSnapshotIds.splice(transferIndex, 0, snapshot.snapshotId);
  candidate.sourceSnapshots.splice(transferIndex, 0, snapshot.projection);
}

async function registerFixtureCapitalTopology({ root, now, paths, inventory, snapshots, topologyPath, topologyBytes }) {
  const preRegistrationInventory = {
    ...inventory,
    sources: inventory.sources.filter(({ id }) => id !== CAPITAL_TOPOLOGY_SOURCE_ID),
  };
  const preRegistrationLedger = snapshots.filter(({ sourceId }) => sourceId !== CAPITAL_TOPOLOGY_SOURCE_ID);
  const receiptPath = path.join(root, "tools/datapack/release/fixture-capital-topology-raw-receipt.json");

  // 임시 fixture에서만 등록 전 입력을 만든다. 실제 저장소의 immutable 이력은 바꾸지 않는다.
  await Promise.all([
    writeFile(path.join(root, topologyPath), topologyBytes),
    writeFile(path.join(root, paths.inventory), jsonBytes(preRegistrationInventory)),
    writeFile(path.join(root, paths.snapshots), jsonBytes(preRegistrationLedger)),
  ]);
  await createFixtureCapitalTopologyReceipt({ repositoryRoot: root, now, receiptPath });
  const outputs = await buildCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, receiptPath, now });
  await Promise.all(outputs.map(({ relative, bytes }) => writeFile(path.join(root, relative), bytes)));

  const registeredInventoryBytes = outputBytes(outputs, paths.inventory);
  const registeredLedgerBytes = outputBytes(outputs, paths.snapshots);
  const registeredGovernanceBytes = outputBytes(outputs, paths.governance);
  const registeredFreshnessBytes = outputBytes(outputs, paths.freshness);
  const registeredInventory = JSON.parse(registeredInventoryBytes);
  const registeredLedger = JSON.parse(registeredLedgerBytes);
  const registeredGovernance = JSON.parse(registeredGovernanceBytes);
  const registeredFreshness = JSON.parse(registeredFreshnessBytes);
  const topologySource = registeredInventory.sources.find(({ id }) => id === CAPITAL_TOPOLOGY_SOURCE_ID);
  const topologySnapshot = registeredLedger.find(({ sourceId }) => sourceId === CAPITAL_TOPOLOGY_SOURCE_ID);
  const governanceRecord = registeredGovernance.sources.find(({ sourceId }) => sourceId === CAPITAL_TOPOLOGY_SOURCE_ID);
  if (!topologySource || !topologySnapshot || !governanceRecord
    || registeredLedger.filter(({ sourceId }) => sourceId === CAPITAL_TOPOLOGY_SOURCE_ID).length !== 1
    || topologySnapshot.snapshotId !== path.basename(topologyPath, ".json")) {
    throw new Error("synthetic capital topology registration is incomplete");
  }
  const topology = JSON.parse(topologyBytes);
  if (topology.credentialRequired !== false || topology.credentialRedacted !== true) {
    throw new Error("synthetic capital topology credential redaction is invalid");
  }
  const adminReviewRecord = {
    schemaVersion: 1,
    artifactKind: "fixture-capital-topology-admin-review-record",
    testOnly: true,
    sourceId: topologySnapshot.sourceId,
    snapshotId: topologySnapshot.snapshotId,
    rawSha256: topologySnapshot.rawSha256,
    contentSha256: topologySnapshot.contentSha256,
    schemaFingerprint: topologySnapshot.schemaFingerprint,
    licenseEvidenceHash: topologySource.admissionEvidence?.licenseEvidenceHash,
    governancePolicyVersion: registeredGovernance.policyVersion,
    governancePolicySha256: sha256(registeredGovernanceBytes),
    topologyBytesSha256: sha256(topologyBytes),
  };
  if (!/^[a-f0-9]{64}$/u.test(adminReviewRecord.licenseEvidenceHash ?? "")) {
    throw new Error("synthetic capital topology license review binding is invalid");
  }
  const adminReviewRecordBytes = Buffer.from(canonicalJson(adminReviewRecord));
  const adminReviewRecordHash = sha256(adminReviewRecordBytes);
  topologySource.admissionEvidence = {
    ...topologySource.admissionEvidence,
    adminReviewRecordHash,
  };
  Object.assign(topologySnapshot, {
    adminReviewRecordHash,
    credentialRedacted: true,
    governancePolicyVersion: registeredGovernance.policyVersion,
    governancePolicySha256: sha256(registeredGovernanceBytes),
  });
  const adminReviewPath = "tools/datapack/release/fixture-capital-topology-admin-review-record.json";
  await writeFile(path.join(root, adminReviewPath), Buffer.from(`${canonicalJson(adminReviewRecord)}\n`));

  const topologyProjection = deriveReleaseProjection({
    snapshot: topologySnapshot,
    sourceInventory: registeredInventory,
    governancePolicy: registeredGovernance,
    governancePolicyBytes: registeredGovernanceBytes,
    freshnessPolicy: registeredFreshness,
    nowMillis: now.getTime(),
  });
  return {
    inventory: registeredInventory,
    snapshots: registeredLedger,
    governanceBytes: registeredGovernanceBytes,
    governancePolicy: registeredGovernance,
    freshnessPolicy: registeredFreshness,
    topologySnapshot: { ...topologySnapshot, projection: topologyProjection },
  };
}

function orderCurrentCapitalSources(document) {
  const capital = document?.packs?.find(({ id }) => id === "capital");
  const entries = capital?.sourceInventory;
  const sourceIds = requireCurrentCanonicalSourceRoster(capital);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  capital.sourceInventory = sourceIds.map((sourceId) => structuredClone(byId.get(sourceId)));
}

async function readJson(root, relative) {
  return JSON.parse(await readFile(path.join(root, relative), "utf8"));
}

function currentPublicRouteMapPredecessor(candidate, snapshots) {
  const publicIndices = candidate?.sourceSnapshots?.map(({ sourceId }, index) => sourceId === PUBLIC_SOURCE_ID ? index : -1).filter((index) => index >= 0) ?? [];
  if (!Array.isArray(candidate?.sourceSnapshotIds) || candidate.sourceSnapshotIds.length !== candidate.sourceSnapshots.length
    || publicIndices.length !== 1) {
    throw new Error("synthetic public route-map predecessor fixture is incomplete");
  }
  const candidateIndex = publicIndices[0];
  const selectedSnapshotId = candidate.sourceSnapshotIds[candidateIndex];
  const selected = snapshots.filter(({ snapshotId }) => snapshotId === selectedSnapshotId);
  if (selected.length !== 1 || selected[0].sourceId !== candidate.sourceSnapshots[candidateIndex].sourceId) {
    throw new Error("synthetic public route-map predecessor fixture is incomplete");
  }
  return { candidateIndex, predecessor: selected[0], selected: selected[0] };
}

function currentOnlySnapshot(snapshot) {
  return Object.fromEntries(Object.entries(structuredClone(snapshot)).filter(([key]) =>
    !/(?:migration|historical|supersession)/iu.test(key)));
}

function currentPublicRouteMapProviderRecords(sourceSnapshot) {
  const artifact = sourceSnapshot?.routeMapLayoutArtifact ?? sourceSnapshot;
  const positions = artifact?.rawPositions ?? sourceSnapshot?.positions;
  const basisDate = sourceSnapshot?.observedDataUpdatedAt ?? artifact?.observedDataUpdatedAt;
  if (!Array.isArray(positions) || typeof basisDate !== "string") {
    throw new Error("synthetic public route-map source evidence is incomplete");
  }
  return positions.map((position) => ({
    line: position.line,
    lineId: position.lineId,
    stationCode: position.stationCode,
    stationName: position.stationName,
    latitude: position.latitude,
    longitude: position.longitude,
    basisDate,
  }));
}

function referencedPaths(value, paths = []) {
  if (Array.isArray(value)) {
    for (const item of value) referencedPaths(item, paths);
    return paths;
  }
  if (value == null || typeof value !== "object") return paths;
  for (const [key, item] of Object.entries(value)) {
    if (/path$/iu.test(key) && typeof item === "string") paths.push(item);
    else referencedPaths(item, paths);
  }
  return paths;
}

function safeSegments(relative) {
  if (path.isAbsolute(relative)) throw new Error(`synthetic successor fixture path is unsafe: ${relative}`);
  const segments = relative.split("/");
  if (segments.length === 0 || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`synthetic successor fixture path is unsafe: ${relative}`);
  }
  return segments;
}

async function regularRoot(root, { create = false } = {}) {
  if (create) await mkdir(root, { recursive: true });
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("synthetic successor fixture root is unsafe");
  }
  return realpath(root);
}

async function regularSourceFile(root, relative) {
  let current = root;
  const segments = safeSegments(relative);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const metadata = await lstat(current);
    const last = index === segments.length - 1;
    if (metadata.isSymbolicLink() || last && !metadata.isFile() || !last && !metadata.isDirectory()) {
      throw new Error(`synthetic successor fixture source is unsafe: ${relative}`);
    }
  }
  const resolved = await realpath(current);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`synthetic successor fixture source escapes root: ${relative}`);
  }
  return resolved;
}

async function regularDestination(root, relative) {
  const segments = safeSegments(relative);
  const parentSegments = segments.slice(0, -1);
  await mkdir(path.join(root, ...parentSegments), { recursive: true });
  let current = root;
  for (const segment of parentSegments) {
    current = path.join(current, segment);
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`synthetic successor fixture destination is unsafe: ${relative}`);
    }
  }
  const resolvedParent = await realpath(current);
  if (resolvedParent !== root && !resolvedParent.startsWith(`${root}${path.sep}`)) {
    throw new Error(`synthetic successor fixture destination escapes root: ${relative}`);
  }
  const destination = path.join(resolvedParent, segments.at(-1));
  try {
    const metadata = await lstat(destination);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`synthetic successor fixture destination is unsafe: ${relative}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return destination;
}

const SUCCESSOR_FIXTURE_PATHS = Object.freeze([
  "tools/datapack/source-candidates.json",
  "tools/datapack/fixtures/seoul-route-map-positions-raw/data-go-15099316.csv",
  "tools/datapack/release/candidate-build-spec.json",
  "tools/datapack/release/release-request.json",
  "tools/datapack/release/hash-evidence.json",
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/release/capital-production-canonical-pack.json",
  "tools/datapack/source-inventory.json",
  "tools/datapack/source-governance-policy.json",
  "tools/datapack/inputs/capital-pilot-production-source-input.json",
  "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv",
  "release/product-gates/datapack-freshness-sla.json",
  "release/product-gates/production-datapack-scope.json",
  "tools/datapack/official-od-fare-admission.json",
  "tools/datapack/nationwide-coverage-targets.json",
  "tools/datapack/release/current-capital-accessibility-full/station-line-input.json",
  "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json",
  "tools/datapack/release/current-capital-accessibility-full/route-edge-evaluation.json",
  "tools/datapack/release/current-station-line-accessibility/station-line-input.json",
  "tools/datapack/release/current-capital-live-chain-fan-in.json",
  "tools/datapack/release/current-kric-exit-plan-inputs.json",
  "tools/datapack/release/current-capital-facility-source-admission.json",
  "tools/datapack/release/current-exit-admission-v2/exit-path-normalized-source-snapshot.json",
  "tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json",
  "tools/datapack/release/current-exit-admission-v2/exit-path-admission-oci-receipt.json",
  "tools/datapack/release/current-transfer-topology-metrics.json",
  "tools/datapack/release/current-capital-transfer-topology-applicability.json",
  "release/product-gates/route-edge-evaluation-policy.json",
  "tools/datapack/schema/catalog-schema.sql",
  "tools/datapack/sources/kric-provider-code-catalog-20260228.json",
  "tools/datapack/sources/kric-nationwide-route-rosters-20260730T203926676Z.json",
]);

export async function copySyntheticCurrentPublicRouteMapRepository(
  sourceRoot,
  targetRoot,
  { now, activatePublicRouteMap = true },
) {
  const [source, target] = await Promise.all([
    regularRoot(sourceRoot),
    regularRoot(targetRoot, { create: true }),
  ]);
  const [candidate, inventory, itxContract, facilityAdmission] = await Promise.all([
    readJson(source, "tools/datapack/release/candidate-build-spec.json"),
    readJson(source, "tools/datapack/source-inventory.json"),
    readJson(source, "tools/datapack/itx-cheongchun-coverage-contract.json"),
    readJson(source, "tools/datapack/release/current-capital-facility-source-admission.json"),
  ]);
  const historicalTopologyEvidence = candidate.networkEdgeEvidence?.capitalTopology;
  if (!historicalTopologyEvidence
    || !/^tools\/datapack\/sources\/capital-route-topology-[0-9]{8}\.json$/u.test(historicalTopologyEvidence.path ?? "")
    || !/^[a-f0-9]{64}$/u.test(historicalTopologyEvidence.sha256 ?? "")
    || historicalTopologyEvidence.snapshotId !== path.basename(historicalTopologyEvidence.path, ".json")) {
    throw new Error("synthetic historical capital topology evidence is incomplete");
  }
  const dynamicPaths = [
    historicalTopologyEvidence.path,
    candidate.fixturePath,
    candidate.sourceSnapshotEvidencePath,
    candidate.itxTopologyEvidencePath,
    candidate.productionScopePolicy?.path,
    ...Object.values(candidate.networkEdgeEvidence ?? {})
      .map((evidence) => evidence?.path)
      .filter((relative) => relative !== historicalTopologyEvidence.path),
    ...inventory.sources.map((source) => source.routeMapAdmissionEvidence?.snapshotPath),
    ...inventory.sources.map((source) => source.routeMapAdmissionEvidence?.currentLayoutAdmission?.snapshotPath),
    ...inventory.sources.map((source) => {
      const snapshotId = source.routeMapAdmissionEvidence?.currentLayoutAdmission?.topologySnapshotId;
      return typeof snapshotId === "string" ? `tools/datapack/sources/${snapshotId}.json` : null;
    }),
    ...inventory.sources.map((source) => source.accessibilityAdmissionEvidence?.snapshotPath),
    ...inventory.sources.map((source) => source.transferAdmissionEvidence?.snapshotPath),
    ...inventory.sources.map((source) => source.topologyAdmissionEvidence?.snapshotPath),
    ...inventory.sources.map((source) => {
      const snapshotId = source.registrationEvidence?.snapshotId;
      return typeof snapshotId === "string" ? `tools/datapack/sources/${snapshotId}.json` : null;
    }),
    ...inventory.sources.map((source) => {
      const snapshotId = source.routeMapAdmissionEvidence?.currentTopologyAdmission?.topologySnapshotId;
      return typeof snapshotId === "string" ? `tools/datapack/sources/${snapshotId}.json` : null;
    }),
    ...candidate.sourceSnapshots
      .filter(({ sourceId }) => sourceId === MOLIT_SOURCE_ID)
      .map(({ snapshotId }) => `tools/datapack/sources/${snapshotId}.json`),
    ...referencedPaths(candidate),
    ...referencedPaths(itxContract),
    facilityAdmission.sourceIdentity?.snapshotPath,
  ];
  const relatives = [...new Set([...SUCCESSOR_FIXTURE_PATHS, ...dynamicPaths]
    .filter((relative) => typeof relative === "string"))];
  for (const relative of relatives) {
    const [sourceFile, destination] = await Promise.all([
      regularSourceFile(source, relative),
      regularDestination(target, relative),
    ]);
    await cp(sourceFile, destination, { force: true });
  }
  await writeSyntheticCurrentExitOciReceipt(target);
  if (!activatePublicRouteMap) return null;
  return activateSyntheticCurrentPublicRouteMapSuccessor(target, { now });
}

async function writeSyntheticCurrentExitOciReceipt(root) {
  const normalizedPath = "tools/datapack/release/current-exit-admission-v2/exit-path-normalized-source-snapshot.json";
  const admissionPath = "tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json";
  const receiptPath = "tools/datapack/release/current-exit-admission-v2/exit-path-admission-oci-receipt.json";
  const [normalizedBytes, admissionBytes] = await Promise.all([
    readFile(path.join(root, normalizedPath)),
    readFile(path.join(root, admissionPath)),
  ]);
  const admission = JSON.parse(admissionBytes);
  const providerCapturedAt = admission.sourceIdentity?.capturedAt;
  if (typeof providerCapturedAt !== "string" || !Number.isFinite(Date.parse(providerCapturedAt))) {
    throw new Error("synthetic current EXIT admission capture time is invalid");
  }
  const providerCollectionBundleBytes = Buffer.from(canonicalJson({ normalized: sha256(normalizedBytes), admission: sha256(admissionBytes) }));
  const receipt = buildFixtureCurrentExitV2Receipt({
    providerCollectionBundleBytes, providerCapturedAt, normalizedBytes, admissionBytes,
    candidateBytes: Buffer.from(canonicalJson(admission.candidate)),
  });
  const target = path.join(root, receiptPath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, Buffer.from(`${canonicalFixtureCurrentExitV2ReceiptJson(receipt)}\n`));
}

export async function nextSyntheticCurrentStaticNetworkNow(root) {
  const [candidate, snapshots, topologyClock] = await Promise.all([
    readJson(root, "tools/datapack/release/candidate-build-spec.json"),
    readJson(root, "tools/datapack/release/source-snapshots.json"),
    currentTopologyAdmissionClock(root),
  ]);
  const selected = candidate.sourceSnapshotIds.map((snapshotId) =>
    snapshots.find((snapshot) => snapshot.snapshotId === snapshotId));
  if (selected.some((snapshot) => snapshot == null)) {
    throw new Error("synthetic current static-network clock fixture is incomplete");
  }
  const basisAt = Math.max(...selected.flatMap((snapshot) => [
    snapshot.retrievedAt,
    snapshot.sourceUpdatedAt,
    snapshot.rawReceipt?.storedAt,
  ].filter(Boolean).map(Date.parse)));
  const freshUntil = Math.min(
    ...selected.map(({ freshnessExpiresAt }) => Date.parse(freshnessExpiresAt)),
    topologyClock.expiredAt.getTime(),
  );
  const candidatePublishedAt = Date.parse(candidate.publishedAt);
  const nowMillis = Math.max(
    Math.max(basisAt, candidatePublishedAt) + 60_000,
    topologyClock.inWindow.getTime(),
  );
  if (!Number.isFinite(basisAt) || !Number.isFinite(candidatePublishedAt)
    || !Number.isFinite(freshUntil) || nowMillis >= freshUntil) {
    throw new Error("synthetic current static-network clock fixture has no valid freshness window");
  }
  return new Date(nowMillis);
}

export async function createStaticNetworkRegistrarPredecessorFixture(sourceRoot, targetRoot, { now }) {
  await copySyntheticCurrentPublicRouteMapRepository(sourceRoot, targetRoot, { now, activatePublicRouteMap: false });
  const current = await activateSyntheticCurrentPublicRouteMapSuccessor(targetRoot, { now, advanceCurrentPublicHead: true });
  return {
    predecessorSnapshotId: current.predecessorSnapshotId,
    currentSnapshotId: current.snapshotId,
  };
}

export async function activateSyntheticCurrentPublicRouteMapSuccessor(root, { now, advanceCurrentPublicHead = false }) {
  const paths = {
    candidate: "tools/datapack/release/candidate-build-spec.json",
    request: "tools/datapack/release/release-request.json",
    hashes: "tools/datapack/release/hash-evidence.json",
    snapshots: "tools/datapack/release/source-snapshots.json",
    pack: "tools/datapack/release/capital-production-canonical-pack.json",
    inventory: "tools/datapack/source-inventory.json",
    governance: "tools/datapack/source-governance-policy.json",
    freshness: "release/product-gates/datapack-freshness-sla.json",
    scope: "release/product-gates/production-datapack-scope.json",
  };
  let [candidate, request, hashes, snapshots, pack, inventory, governanceBytes, freshnessPolicy, scope] = await Promise.all([
    readJson(root, paths.candidate), readJson(root, paths.request), readJson(root, paths.hashes), readJson(root, paths.snapshots),
    readJson(root, paths.pack), readJson(root, paths.inventory), readFile(path.join(root, paths.governance)),
    readJson(root, paths.freshness), readJson(root, paths.scope),
  ]);
  let governancePolicy = JSON.parse(governanceBytes);
  const historicalTopologyEvidence = structuredClone(candidate.networkEdgeEvidence?.capitalTopology);
  if (!historicalTopologyEvidence
    || !/^tools\/datapack\/sources\/capital-route-topology-[0-9]{8}\.json$/u.test(historicalTopologyEvidence.path ?? "")
    || !/^[a-f0-9]{64}$/u.test(historicalTopologyEvidence.sha256 ?? "")
    || historicalTopologyEvidence.snapshotId !== path.basename(historicalTopologyEvidence.path, ".json")) {
    throw new Error("synthetic historical capital topology evidence is incomplete");
  }
  const fixtureRoot = await regularRoot(root);
  const historicalTopologyBytes = await readFile(await regularSourceFile(fixtureRoot, historicalTopologyEvidence.path));
  if (sha256(historicalTopologyBytes) !== historicalTopologyEvidence.sha256) {
    throw new Error("synthetic historical capital topology byte identity is invalid");
  }
  const historicalOwnershipBaseline = projectCapitalTopologyOwnership(JSON.parse(historicalTopologyBytes));
  const predecessorBinding = currentPublicRouteMapPredecessor(candidate, snapshots);
  const { candidateIndex: predecessorIndex, predecessor, selected } = predecessorBinding;
  const successorPredecessor = selected;
  const advancesCurrentPublicHead = advanceCurrentPublicHead
    || Date.parse(successorPredecessor.retrievedAt) < now.getTime();
  const selectedPublicSnapshotId = candidate.sourceSnapshots[predecessorIndex].sourceId === PUBLIC_SOURCE_ID
    ? candidate.sourceSnapshotIds[predecessorIndex]
    : null;
  const selectedPublicSnapshotIndex = selectedPublicSnapshotId == null ? -1
    : snapshots.findIndex(({ snapshotId }) => snapshotId === selectedPublicSnapshotId);
  const publicSnapshots = snapshots.filter(({ sourceId }) => sourceId === PUBLIC_SOURCE_ID);
  const publicSnapshotsById = new Map(publicSnapshots.map((snapshot) => [snapshot.snapshotId, snapshot]));
  let headsBySource;
  try {
    ({ headsBySource } = validateLineage(snapshots));
  } catch (error) {
    throw new Error(`synthetic public route-map successor fixture has invalid public source lineage: ${error.message}`);
  }
  const selectedPublicSnapshot = snapshots[selectedPublicSnapshotIndex];
  if (selectedPublicSnapshotId != null && (publicSnapshotsById.size !== publicSnapshots.length
    || selectedPublicSnapshotIndex < 0
    || selectedPublicSnapshot?.sourceId !== PUBLIC_SOURCE_ID
    || headsBySource[PUBLIC_SOURCE_ID] !== selectedPublicSnapshotId)) {
    throw new Error("synthetic public route-map successor fixture has invalid public source lineage");
  }
  const publicSources = inventory.sources.filter(({ id }) => id === PUBLIC_SOURCE_ID);
  const publicSource = publicSources[0];
  if (!predecessor || publicSources.length !== 1) {
    throw new Error("synthetic public route-map predecessor fixture is incomplete");
  }

  const nowMillis = now.getTime();
  const requestedCapturedAtMillis = nowMillis - 60_000;
  const predecessorRetrievedAtMillis = advancesCurrentPublicHead
    ? Date.parse(successorPredecessor.retrievedAt)
    : null;
  const capturedAtMillis = advancesCurrentPublicHead
    ? Math.max(requestedCapturedAtMillis, predecessorRetrievedAtMillis + 1)
    : requestedCapturedAtMillis;
  if (!Number.isFinite(nowMillis)
    || advancesCurrentPublicHead && (!Number.isFinite(predecessorRetrievedAtMillis) || capturedAtMillis > nowMillis)) {
    throw new Error("synthetic public route-map successor fixture has invalid capture time");
  }
  const capturedAt = new Date(capturedAtMillis).toISOString();
  const stamp = capturedAt.replaceAll(/[-:.]/gu, "");
  const redactedRequestFingerprint = advancesCurrentPublicHead
    ? successorPredecessor.redactedRequestFingerprint
    : sha256("public-route-map-request");
  const snapshotId = `${PUBLIC_SOURCE_ID}-current-${stamp}`;
  const currentLayoutAdmission = publicSource.routeMapAdmissionEvidence?.currentLayoutAdmission;
  const sourceSnapshotPath = advancesCurrentPublicHead
    ? currentLayoutAdmission?.snapshotPath
    : publicSource.routeMapAdmissionEvidence?.snapshotPath;
  const topologySnapshotId = publicSource.routeMapAdmissionEvidence?.currentTopologyAdmission?.topologySnapshotId;
  if (typeof sourceSnapshotPath !== "string" || typeof topologySnapshotId !== "string"
    || advancesCurrentPublicHead && currentLayoutAdmission?.positionSnapshotId !== successorPredecessor.snapshotId) {
    throw new Error("synthetic public route-map source evidence is incomplete");
  }
  const topologySnapshotPath = `tools/datapack/sources/${topologySnapshotId}.json`;
  const [sourceSnapshotBytes, topologySnapshotBytes] = await Promise.all([
    readFile(path.join(root, sourceSnapshotPath)),
    readFile(path.join(root, topologySnapshotPath)),
  ]);
  const sourceSnapshot = JSON.parse(sourceSnapshotBytes);
  const providerRecords = currentPublicRouteMapProviderRecords(sourceSnapshot);
  const rawBytes = Buffer.from(`${JSON.stringify(providerRecords)}\n`);
  const rawSha256 = advancesCurrentPublicHead ? sourceSnapshot.rawSha256 : sha256(rawBytes);
  const rawByteSize = advancesCurrentPublicHead ? successorPredecessor.rawReceipt?.byteSize : rawBytes.length;
  if (advancesCurrentPublicHead && (!/^[a-f0-9]{64}$/u.test(rawSha256 ?? "")
    || rawSha256 !== currentLayoutAdmission.rawSha256
    || rawSha256 !== successorPredecessor.rawSha256
    || !Number.isInteger(rawByteSize) || rawByteSize <= 0)) {
    throw new Error("synthetic public route-map current raw evidence is incomplete");
  }
  const routeMapLayoutArtifact = buildSeoulRouteMapPositions({
    records: providerRecords,
    topologySnapshotBytes,
    topologySnapshotId,
    now: new Date(capturedAt),
    rawSha256,
  });
  const routeMapLayoutArtifactBytes = jsonBytes(routeMapLayoutArtifact);
  const layoutArtifactSha256 = sha256(Buffer.from(`${JSON.stringify(routeMapLayoutArtifact)}\n`));
  const priorProviderProjection = successorPredecessor.publicStaticNetworkV2Observation?.normalizedProjection;
  const contentSha256 = advancesCurrentPublicHead
    ? sourceSnapshot.contentSha256
    : sha256(Buffer.from(`${JSON.stringify(routeMapLayoutArtifact.rawPositions)}\n`));
  const schemaFingerprint = advancesCurrentPublicHead
    ? sourceSnapshot.schemaFingerprint
    : sha256(JSON.stringify(Object.keys(routeMapLayoutArtifact.rawPositions[0]).sort((left, right) => left.localeCompare(right, "en"))));
  const providerRecordHashes = advancesCurrentPublicHead
    ? sourceSnapshot.providerRecordHashes
    : routeMapLayoutArtifact.rawPositions.map((record) => sha256(JSON.stringify(record)));
  if (advancesCurrentPublicHead && (!Array.isArray(priorProviderProjection)
    || !Array.isArray(providerRecordHashes)
    || providerRecordHashes.length !== priorProviderProjection.length)) {
    throw new Error("synthetic public route-map current observation identity is incomplete");
  }
  const layout = Object.fromEntries(SHA_KEYS.map((key) => [key, key === "layoutArtifactSha256"
    ? layoutArtifactSha256
    : routeMapLayoutArtifact[key]]));
  const sourceClass = freshnessPolicy.sourceClasses.find(({ sourceIds }) => sourceIds.includes(PUBLIC_SOURCE_ID));
  const freshnessExpiresAt = deriveFreshnessExpiresAt({
    policy: freshnessPolicy,
    sourceClassId: sourceClass.id,
    basisAt: capturedAt,
    evaluationAt: now.toISOString(),
  });
  const rawRetentionExpiresAt = deriveRawRetentionExpiresAt({
    policy: governancePolicy,
    sourceId: PUBLIC_SOURCE_ID,
    retrievedAt: capturedAt,
  });
  const objectKey = `source-raw/${PUBLIC_SOURCE_ID}/${capturedAt.slice(0, 10).replaceAll("-", "")}/${rawSha256}.json`;
  const snapshot = {
    ...currentOnlySnapshot(successorPredecessor),
    snapshotId,
    sourceId: PUBLIC_SOURCE_ID,
    // The catalog owner is not necessarily the canonical snapshot provider.
    // Preserve the authenticated selected head's provider identity instead of
    // copying the inventory display metadata into a V2 successor.
    provider: successorPredecessor.provider,
    retrievedAt: capturedAt,
    sourceUpdatedAt: `${routeMapLayoutArtifact.observedDataUpdatedAt}T00:00:00.000Z`,
    rowCount: routeMapLayoutArtifact.rawPositions.length,
    coverageCount: routeMapLayoutArtifact.rawPositions.length,
    rawSha256,
    rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/${objectKey}`,
    redactedRequestFingerprint,
    schemaFingerprint,
    contentSha256,
    previousSnapshotId: advancesCurrentPublicHead ? successorPredecessor.snapshotId : null,
    diffSummary: null,
    freshnessExpiresAt,
    rawRetentionExpiresAt,
    governancePolicyVersion: governancePolicy.policyVersion,
    governancePolicySha256: sha256(governanceBytes),
    providerRecordHashes: [...providerRecordHashes],
    normalizedObservationSha256: sha256(routeMapLayoutArtifactBytes),
    routeMapLayoutEvidence: layout,
    routeMapLayoutArtifact,
    rawReceipt: {
      schemaVersion: 1,
      artifactKind: "static-network-source-raw-object-receipt",
      sourceId: PUBLIC_SOURCE_ID,
      snapshotId,
      capturedAt,
      rawObjectSha256: rawSha256,
      rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/${objectKey}`,
      ociNamespace: "axvym6vk8g7i",
      bucket: "easysubway-datapacks",
      objectKey,
      contentType: "application/json",
      byteSize: rawByteSize,
      storedAt: capturedAt,
      rawRetentionExpiresAt,
    },
  };
  const observation = {
    schemaVersion: 2,
    artifactKind: "public-static-network-v2-observation",
    sourceId: PUBLIC_SOURCE_ID,
    snapshotId,
    capturedAt,
    rawSha256,
    contentSha256,
    schemaFingerprint,
    rowCount: snapshot.rowCount,
    providerRecordHashes: [...providerRecordHashes],
    normalizedProjection: structuredClone(advancesCurrentPublicHead
      ? priorProviderProjection
      : routeMapLayoutArtifact.rawPositions),
    routeMapLayoutEvidence: layout,
    routeMapLayoutArtifact,
    rawReceipt: structuredClone(snapshot.rawReceipt),
  };
  snapshot.publicStaticNetworkV2Observation = observation;
  snapshot.normalizedObservationSha256 = sha256(Buffer.from(`${JSON.stringify(observation)}\n`));
  if (advancesCurrentPublicHead) snapshot.diffSummary = buildSnapshotDiff(successorPredecessor, snapshot);
  if (!advancesCurrentPublicHead) {
    const firstPublicSnapshotIndex = snapshots.findIndex(({ sourceId }) => sourceId === PUBLIC_SOURCE_ID);
    for (let index = snapshots.length - 1; index >= 0; index -= 1) {
      if (snapshots[index].sourceId === PUBLIC_SOURCE_ID) snapshots.splice(index, 1);
    }
    snapshots.splice(firstPublicSnapshotIndex, 0, snapshot);
  } else snapshots.push(snapshot);

  publicSource.requiredForProductionPack = true;
  publicSource.productionUseAllowed = true;
  publicSource.retrievedAt = capturedAt.slice(0, 10);
  publicSource.observedDataUpdatedAt = routeMapLayoutArtifact.observedDataUpdatedAt;
  publicSource.admissionEvidence = {
    ...publicSource.admissionEvidence,
    snapshotId,
    rawSha256,
    schemaFingerprint,
  };
  publicSource.routeMapAdmissionEvidence = {
    ...publicSource.routeMapAdmissionEvidence,
    capturedAt,
    freshUntil: freshnessExpiresAt,
    snapshotPath: `tools/datapack/sources/${snapshotId}.json`,
    snapshotSha256: sha256(routeMapLayoutArtifactBytes),
    currentLayoutAdmission: {
      schemaVersion: 2,
      artifactKind: "seoul-public-route-map-layout-admission",
      status: "ADMITTED",
      positionSnapshotId: snapshotId,
      snapshotPath: `tools/datapack/sources/${snapshotId}.json`,
      snapshotSha256: sha256(routeMapLayoutArtifactBytes),
      rawSha256,
      contentSha256,
      ...layout,
    },
  };
  pack.packs[0].routeMapPositions = [];
  if (pack.packs[0].networkEdges.some(
    ({ edgeType }) => !["RIDE", "ENTRY", "EXIT"].includes(edgeType),
  )) {
    throw new Error("synthetic current pre-authority edge contract is invalid");
  }
  pack.packs[0].networkEdges = pack.packs[0].networkEdges.filter(
    ({ edgeType }) => edgeType === "RIDE",
  );

  const materializedPack = materializeSeoulRouteMapPositions({
    baseFixture: pack,
    snapshot: routeMapLayoutArtifact,
    snapshotSha256: sha256(routeMapLayoutArtifactBytes),
    topologySnapshotBytes,
    inventory,
    now,
    rewritePackIdentity: false,
    successorProviderRecordHashes: snapshot.providerRecordHashes,
    requireSuccessorProviderRecordHashes: true,
  });
  publicSource.routeMapAdmissionEvidence.snapshotSha256 = snapshot.normalizedObservationSha256;
  publicSource.routeMapAdmissionEvidence.currentLayoutAdmission.snapshotSha256 = snapshot.normalizedObservationSha256;
  const capital = materializedPack.packs[0];
  let coverageEvidence;
  try {
    coverageEvidence = JSON.parse(capital.metadata.productionCoverageEvidence);
  } catch {
    throw new Error("synthetic public route-map coverage evidence is invalid");
  }
  capital.metadata.productionCoverageEvidence = JSON.stringify([
    ...coverageEvidence.filter(({ sourceDomain }) => sourceDomain !== "route_map_positions"),
    CURRENT_SEOUL_PUBLIC_ROUTE_MAP_COVERAGE,
  ]);
  Object.assign(pack, materializedPack);
  orderCurrentCapitalSources(pack);

  const publicTopologyAdmission = publicSource.routeMapAdmissionEvidence?.currentTopologyAdmission;
  const currentTopologySnapshotId = publicTopologyAdmission?.topologySnapshotId;
  if (typeof currentTopologySnapshotId !== "string") {
    throw new Error("synthetic current topology admission fixture is incomplete");
  }
  candidate.candidateId = `capital-pilot-candidate-${currentTopologySnapshotId.slice(-8)}`;
  candidate.publishedAt = now.toISOString();
  const currentTopologyPath = `tools/datapack/sources/${currentTopologySnapshotId}.json`;
  const currentTopology = JSON.parse(topologySnapshotBytes);
  const currentIncheonSource = inventory.sources.find(({ id }) => id === "incheon-transit-station-info");
  const currentIncheonTopologyPath = currentIncheonSource?.topologyAdmissionEvidence?.snapshotPath;
  if (typeof currentIncheonTopologyPath !== "string") {
    throw new Error("synthetic current Incheon topology fixture is missing");
  }
  const currentIncheonTopology = JSON.parse(await readFile(path.join(root, currentIncheonTopologyPath)));
  validateSourceSeparatedCurrentTopology({
    capitalTopology: currentTopology,
    incheonSnapshot: currentIncheonTopology,
  });
  const candidateLineIds = new Set(currentTopology.lines.map(({ lineId }) => lineId));
  const currentTopologyAdmissions = inventory.sources
    .map((source) => ({ source, evidence: source.routeMapAdmissionEvidence,
      admission: source.routeMapAdmissionEvidence?.currentTopologyAdmission }))
    .filter(({ evidence }) => evidence?.topologySourceId === currentTopology.sourceId);
  if (currentTopologyAdmissions.length === 0
    || currentTopologyAdmissions.some(({ evidence, admission }) => !Array.isArray(evidence?.lineIds)
      || evidence.lineIds.length === 0
      || new Set(evidence.lineIds).size !== evidence.lineIds.length
      || evidence.lineIds.some((lineId) => !candidateLineIds.has(lineId))
      || !Array.isArray(admission?.topologyLineages)
      || admission.topologyLineages.length !== evidence.lineIds.length
      || new Set(admission.topologyLineages.map(({ lineId }) => lineId)).size !== evidence.lineIds.length
      || admission.topologyLineages.some(({ lineId }) => !evidence.lineIds.includes(lineId)
        || !candidateLineIds.has(lineId)))
    || currentTopology.contentSha256 !== publicTopologyAdmission.topologyContentSha256
    || currentTopology.capturedAt !== publicTopologyAdmission.reviewedAt
    || currentTopology.freshUntil !== publicTopologyAdmission.freshUntil) {
    throw new Error("synthetic current topology admission bytes are invalid");
  }
  const topologyReverificationPath = `tools/datapack/release/${currentTopologySnapshotId}-reverification.json`;
  const topologyReverification = buildCapitalTopologyReverificationEvidence(
    historicalOwnershipBaseline,
    currentTopology,
  );
  topologyReverification.baseline.snapshotId = historicalTopologyEvidence.snapshotId;
  const topologyReverificationBytes = jsonBytes(topologyReverification);
  const candidateTopologyAdmissions = new Map(currentTopology.lines.map(({ lineId }) => [lineId, {
    verifiedAt: currentTopology.capturedAt,
    freshUntil: currentTopology.freshUntil,
  }]));
  projectCapitalTopologyIntoCanonicalFixture(
    pack,
    currentTopology,
    currentTopologySnapshotId,
    candidateTopologyAdmissions,
  );
  for (const { source, admission } of currentTopologyAdmissions) {
    Object.assign(admission, {
      topologySnapshotId: currentTopologySnapshotId,
      topologyContentSha256: currentTopology.contentSha256,
      reviewedAt: currentTopology.capturedAt,
      freshUntil: currentTopology.freshUntil,
      ...(source.id === PUBLIC_SOURCE_ID ? { positionSnapshotSha256: snapshot.normalizedObservationSha256 } : {}),
      topologyLineages: admission.topologyLineages.map((lineage) => ({
        ...lineage,
        sourceId: currentTopology.sourceId,
        snapshotId: currentTopologySnapshotId,
        contentSha256: currentTopology.contentSha256,
      })),
    });
  }
  Object.assign(candidate.networkEdgeEvidence.capitalTopologyCandidate, {
    path: currentTopologyPath,
    sha256: sha256(topologySnapshotBytes),
    snapshotId: currentTopologySnapshotId,
  });
  Object.assign(candidate.networkEdgeEvidence.capitalTopologyReverification, {
    path: topologyReverificationPath,
    sha256: sha256(topologyReverificationBytes),
  });
  Object.assign(candidate.networkEdgeEvidence.capitalTopologyAdmission, {
    snapshotId: currentTopologySnapshotId,
    contentSha256: currentTopology.contentSha256,
    reviewedAt: currentTopology.capturedAt,
    reverifiedAt: currentTopology.capturedAt,
    freshUntil: currentTopology.freshUntil,
  });
  const candidatePublishedAt = Math.max(now.getTime(), Date.parse(currentTopology.capturedAt));
  if (!Number.isFinite(candidatePublishedAt) || candidatePublishedAt >= Date.parse(currentTopology.freshUntil)) {
    throw new Error("synthetic candidate release clock is outside current topology admission");
  }
  candidate.publishedAt = new Date(candidatePublishedAt).toISOString();
  verifyCurrentCapitalPublicRouteMapDocument(pack, snapshot, "synthetic successor fixture");

  const incheonSource = inventory.sources.find(({ id }) => id === "incheon-transit-station-info");
  const incheonSnapshotPath = incheonSource?.routeMapAdmissionEvidence?.snapshotPath;
  if (typeof incheonSnapshotPath !== "string") {
    throw new Error("synthetic Incheon topology source evidence is incomplete");
  }
  const incheonSnapshot = await readJson(root, incheonSnapshotPath);
  delete incheonSnapshot.stationCodeCorrections;
  incheonSnapshot.stationCodeDerivations = currentIncheonStationCodeDerivations();
  const incheonSnapshotBytes = Buffer.from(`${JSON.stringify(incheonSnapshot)}\n`);
  incheonSource.routeMapAdmissionEvidence.snapshotSha256 = sha256(incheonSnapshotBytes);
  candidate.sourceSnapshotIds[predecessorIndex] = snapshotId;
  candidate.sourceSnapshots[predecessorIndex] = deriveReleaseProjection({
    snapshot,
    sourceInventory: inventory,
    governancePolicy,
    governancePolicyBytes: governanceBytes,
    freshnessPolicy,
    nowMillis: now.getTime(),
  });
  const topologyRegistration = await registerFixtureCapitalTopology({
    root,
    now,
    paths,
    inventory,
    snapshots,
    topologyPath: currentTopologyPath,
    topologyBytes: topologySnapshotBytes,
  });
  inventory = topologyRegistration.inventory;
  snapshots = topologyRegistration.snapshots;
  governanceBytes = topologyRegistration.governanceBytes;
  governancePolicy = topologyRegistration.governancePolicy;
  freshnessPolicy = topologyRegistration.freshnessPolicy;
  addFixtureTopologySelection(candidate, topologyRegistration.topologySnapshot);
  addFixtureTopologyScope(scope);
  const inventoryBytes = jsonBytes(inventory);
  const scopeBytes = jsonBytes(scope);
  const selectedIds = new Set(candidate.sourceSnapshotIds);
  candidate.sourceSnapshotSetHash = sha256(JSON.stringify(
    snapshots.filter(({ snapshotId: selectedId }) => selectedIds.has(selectedId)),
  ));
  candidate.sourceInventorySha256 = sha256(JSON.stringify(inventory));
  candidate.networkEdgeEvidence.sourceInventory.sha256 = sha256(inventoryBytes);
  const candidateBytes = jsonBytes(candidate);
  const packBytes = Buffer.from(`${JSON.stringify(pack)}\n`);
  const selectedSnapshots = snapshots.filter(({ snapshotId: selectedId }) => selectedIds.has(selectedId));
  bindSyntheticReleaseArtifacts({
    candidate, candidateBytes, request, hashes, packBytes, selectedSnapshots, inventory,
  });

  await Promise.all([
    writeFile(path.join(root, `tools/datapack/sources/${snapshotId}.json`), Buffer.from(`${JSON.stringify(observation)}\n`)),
    writeFile(path.join(root, topologyReverificationPath), topologyReverificationBytes),
    writeFile(path.join(root, incheonSnapshotPath), incheonSnapshotBytes),
    writeFile(path.join(root, paths.snapshots), jsonBytes(snapshots)),
    writeFile(path.join(root, paths.inventory), inventoryBytes),
    writeFile(path.join(root, paths.scope), scopeBytes),
    writeFile(path.join(root, paths.pack), packBytes),
    writeFile(path.join(root, paths.candidate), candidateBytes),
    writeFile(path.join(root, paths.request), jsonBytes(request)),
    writeFile(path.join(root, paths.hashes), jsonBytes(hashes)),
  ]);
  return { snapshotId, predecessorSnapshotId: successorPredecessor.snapshotId };
}

export async function activateSyntheticCurrentStaticNetworkSuccessors(root, { now }) {
  const routeMap = await activateSyntheticCurrentPublicRouteMapSuccessor(root, { now, advanceCurrentPublicHead: true });
  const paths = {
    candidate: "tools/datapack/release/candidate-build-spec.json",
    request: "tools/datapack/release/release-request.json",
    hashes: "tools/datapack/release/hash-evidence.json",
    snapshots: "tools/datapack/release/source-snapshots.json",
    inventory: "tools/datapack/source-inventory.json",
    governance: "tools/datapack/source-governance-policy.json",
    freshness: "release/product-gates/datapack-freshness-sla.json",
  };
  const [candidate, request, hashes, snapshots, inventory, governanceBytes, freshnessPolicy] = await Promise.all([
    readJson(root, paths.candidate), readJson(root, paths.request), readJson(root, paths.hashes),
    readJson(root, paths.snapshots), readJson(root, paths.inventory), readFile(path.join(root, paths.governance)),
    readJson(root, paths.freshness),
  ]);
  const governancePolicy = JSON.parse(governanceBytes);
  const molitIndex = candidate.sourceSnapshots.findIndex(({ sourceId }) => sourceId === MOLIT_SOURCE_ID);
  const predecessor = snapshots.find(({ snapshotId }) => snapshotId === candidate.sourceSnapshotIds[molitIndex]);
  const source = inventory.sources.find(({ id }) => id === MOLIT_SOURCE_ID);
  if (molitIndex < 0 || !predecessor || !source) throw new Error("synthetic MOLIT successor predecessor fixture is incomplete");
  const [molitProjection, sourceClass] = await Promise.all([
    readJson(root, `tools/datapack/sources/${predecessor.snapshotId}.json`),
    freshnessPolicy.sourceClasses.find(({ sourceIds }) => sourceIds.includes(MOLIT_SOURCE_ID)),
  ]);
  if (!sourceClass
    || molitProjection?.sourceId !== MOLIT_SOURCE_ID
    || molitProjection.snapshotId !== predecessor.snapshotId
    || !Array.isArray(molitProjection.normalizedProjection)
    || !Array.isArray(molitProjection.providerRecordHashes)
    || molitProjection.normalizedProjection.length !== predecessor.rowCount
    || !isDeepStrictEqual(molitProjection.providerRecordHashes, predecessor.providerRecordHashes)) {
    throw new Error("synthetic MOLIT successor projection fixture is incomplete");
  }
  const capturedAt = now.toISOString();
  const contentSha256 = sha256(Buffer.from(`${JSON.stringify(molitProjection.normalizedProjection)}\n`));
  const snapshotId = `${MOLIT_SOURCE_ID}-current-${capturedAt.replaceAll(/[-:.]/gu, "")}`;
  const freshnessExpiresAt = deriveFreshnessExpiresAt({
    policy: freshnessPolicy,
    sourceClassId: sourceClass.id,
    basisAt: capturedAt,
    evaluationAt: capturedAt,
  });
  const rawRetentionExpiresAt = deriveRawRetentionExpiresAt({
    policy: governancePolicy,
    sourceId: MOLIT_SOURCE_ID,
    retrievedAt: capturedAt,
  });
  const objectKey = `source-raw/${MOLIT_SOURCE_ID}/${capturedAt.slice(0, 10).replaceAll("-", "")}/${predecessor.rawSha256}.csv`;
  const successor = {
    ...currentOnlySnapshot(predecessor),
    snapshotId,
    retrievedAt: capturedAt,
    sourceUpdatedAt: capturedAt,
    previousSnapshotId: predecessor.snapshotId,
    rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/${objectKey}`,
    contentSha256,
    schemaFingerprint: molitProjection.schemaFingerprint,
    rowCount: molitProjection.normalizedProjection.length,
    coverageCount: molitProjection.normalizedProjection.length,
    providerRecordHashes: [...molitProjection.providerRecordHashes],
    freshnessExpiresAt,
    rawRetentionExpiresAt,
    governancePolicyVersion: governancePolicy.policyVersion,
    governancePolicySha256: sha256(governanceBytes),
    rawReceipt: {
      schemaVersion: 1,
      artifactKind: "static-network-source-raw-object-receipt",
      sourceId: MOLIT_SOURCE_ID,
      snapshotId,
      capturedAt,
      rawObjectSha256: predecessor.rawSha256,
      rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/${objectKey}`,
      ociNamespace: "axvym6vk8g7i",
      bucket: "easysubway-datapacks",
      objectKey,
      contentType: "text/csv; charset=euc-kr",
      byteSize: predecessor.rawReceipt?.byteSize,
      storedAt: capturedAt,
      rawRetentionExpiresAt,
    },
  };
  successor.diffSummary = buildSnapshotDiff(predecessor, successor);
  const observation = {
    schemaVersion: 2,
    artifactKind: "public-static-network-v2-observation",
    sourceId: MOLIT_SOURCE_ID,
    snapshotId,
    capturedAt,
    rawSha256: successor.rawSha256,
    contentSha256: successor.contentSha256,
    schemaFingerprint: successor.schemaFingerprint,
    rowCount: successor.rowCount,
    providerRecordHashes: [...successor.providerRecordHashes],
    normalizedProjection: structuredClone(molitProjection.normalizedProjection),
    rawReceipt: structuredClone(successor.rawReceipt),
  };
  successor.publicStaticNetworkV2Observation = observation;
  successor.normalizedObservationSha256 = sha256(Buffer.from(`${JSON.stringify(observation)}\n`));
  snapshots.push(successor);
  source.retrievedAt = now.toISOString().slice(0, 10);
  source.admissionEvidence = {
    ...source.admissionEvidence,
    snapshotId,
    rawSha256: successor.rawSha256,
    schemaFingerprint: successor.schemaFingerprint,
  };
  const inventoryBytes = jsonBytes(inventory);
  candidate.sourceSnapshotIds[molitIndex] = snapshotId;
  candidate.sourceSnapshots[molitIndex] = deriveReleaseProjection({
    snapshot: successor,
    sourceInventory: inventory,
    governancePolicy,
    governancePolicyBytes: governanceBytes,
    freshnessPolicy,
    nowMillis: now.getTime(),
  });
  const selectedIds = new Set(candidate.sourceSnapshotIds);
  const selected = snapshots.filter(({ snapshotId: selectedId }) => selectedIds.has(selectedId));
  candidate.sourceSnapshotSetHash = sha256(JSON.stringify(selected));
  candidate.sourceInventorySha256 = sha256(JSON.stringify(inventory));
  candidate.networkEdgeEvidence.sourceInventory.sha256 = sha256(inventoryBytes);
  const candidateBytes = jsonBytes(candidate);
  Object.assign(request, {
    buildSpecSha256: sha256(candidateBytes),
    sourceSnapshotSetHash: candidate.sourceSnapshotSetHash,
  });
  hashes.sourceSnapshotSetHash.value = candidate.sourceSnapshotSetHash;
  hashes.sourceInventorySha256.value = candidate.sourceInventorySha256;
  hashes.sourceSnapshots.order = `release snapshot 순서: ${selected.map(({ sourceId }) => sourceId).join(" → ")}`;
  hashes.perSourceEvidence = selected.map((selectedSnapshot) => ({
    sourceId: selectedSnapshot.sourceId,
    snapshotId: selectedSnapshot.snapshotId,
    rawSha256: selectedSnapshot.rawSha256,
    adminReviewRecordHash: inventory.sources.find(({ id }) => id === selectedSnapshot.sourceId).admissionEvidence.adminReviewRecordHash,
    perSourceSnapshotSetHash: sha256(JSON.stringify([selectedSnapshot])),
  }));
  await Promise.all([
    writeFile(path.join(root, paths.snapshots), jsonBytes(snapshots)),
    writeFile(path.join(root, paths.inventory), inventoryBytes),
    writeFile(path.join(root, paths.candidate), candidateBytes),
    writeFile(path.join(root, paths.request), jsonBytes(request)),
    writeFile(path.join(root, paths.hashes), jsonBytes(hashes)),
  ]);
  return { routeMap, molit: { snapshotId, predecessorSnapshotId: predecessor.snapshotId } };
}
