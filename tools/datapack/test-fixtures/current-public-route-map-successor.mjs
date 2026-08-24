import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildSeoulRouteMapPositions } from "../collect-seoul-route-map-positions.mjs";
import {
  buildCapitalTopologyReverificationEvidence,
  projectCapitalTopologyOwnership,
} from "../collect-capital-route-topology.mjs";
import { currentIncheonStationCodeDerivations } from "../collect-incheon-station-info.mjs";
import { projectCapitalTopologyIntoCanonicalFixture } from "../build-datapack.mjs";
import { deriveFreshnessExpiresAt } from "../freshness-policy.mjs";
import {
  CURRENT_SEOUL_PUBLIC_ROUTE_MAP_COVERAGE,
  CURRENT_SEOUL_PUBLIC_ROUTE_MAP_OPERATOR_IDS,
  materializeSeoulRouteMapPositions,
  verifyCurrentCapitalPublicRouteMapDocument,
} from "../materialize-seoul-route-map-positions.mjs";
import { deriveReleaseProjection } from "../rebind-current-candidate-source-snapshots.mjs";
import { deriveRawRetentionExpiresAt } from "../source-governance-policy.mjs";

const PUBLIC_SOURCE_ID = "seoul-metro-route-map-positions";
const PREDECESSOR_SOURCE_ID = "seoulmetro-cyberstation-route-map";
const MOLIT_SOURCE_ID = "molit-urban-rail-full-route";
const SHA_KEYS = Object.freeze([
  "layoutAlgorithmVersion", "topologySnapshotId", "topologySnapshotSha256",
  "topologySnapshotIdentity", "lineOrderSha256", "aliasLedgerVersion", "aliasLedgerSha256",
  "rawPositionsSha256", "layoutPositionsSha256", "layoutTracksSha256", "semanticInputSha256",
  "semanticOutputSha256", "outputSchemaSha256", "layoutArtifactSha256",
]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

async function readJson(root, relative) {
  return JSON.parse(await readFile(path.join(root, relative), "utf8"));
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
  "tools/datapack/release/candidate-build-spec.json",
  "tools/datapack/release/release-request.json",
  "tools/datapack/release/hash-evidence.json",
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/release/capital-production-canonical-pack.json",
  "tools/datapack/source-inventory.json",
  "tools/datapack/source-governance-policy.json",
  "release/product-gates/datapack-freshness-sla.json",
  "tools/datapack/official-od-fare-admission.json",
  "tools/datapack/nationwide-coverage-targets.json",
  "tools/datapack/release/current-capital-accessibility-full/station-line-input.json",
  "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json",
  "tools/datapack/release/current-capital-facility-source-admission.json",
  "tools/datapack/release/current-exit-admission-v2/exit-path-normalized-source-snapshot.json",
  "tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json",
  "tools/datapack/release/current-exit-admission-v2/exit-path-admission-artifact-receipt.json",
  "tools/datapack/release/current-transfer-topology-metrics.json",
  "tools/datapack/release/current-capital-transfer-topology-applicability.json",
  "release/product-gates/route-edge-evaluation-policy.json",
  "tools/datapack/schema/catalog-schema.sql",
]);

export async function copySyntheticCurrentPublicRouteMapRepository(
  sourceRoot,
  targetRoot,
  { now, activateStaticNetwork = false },
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
  const dynamicPaths = [
    candidate.fixturePath,
    candidate.sourceSnapshotEvidencePath,
    candidate.itxTopologyEvidencePath,
    candidate.productionScopePolicy?.path,
    ...Object.values(candidate.networkEdgeEvidence ?? {}).map((evidence) => evidence?.path),
    ...inventory.sources.map((source) => source.routeMapAdmissionEvidence?.snapshotPath),
    ...inventory.sources.map((source) => {
      const snapshotId = source.routeMapAdmissionEvidence?.currentTopologyAdmission?.topologySnapshotId;
      return typeof snapshotId === "string" ? `tools/datapack/sources/${snapshotId}.json` : null;
    }),
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
  return activateStaticNetwork
    ? activateSyntheticCurrentStaticNetworkSuccessors(target, { now })
    : activateSyntheticCurrentPublicRouteMapSuccessor(target, { now });
}

export async function activateSyntheticCurrentPublicRouteMapSuccessor(root, { now }) {
  const paths = {
    candidate: "tools/datapack/release/candidate-build-spec.json",
    request: "tools/datapack/release/release-request.json",
    hashes: "tools/datapack/release/hash-evidence.json",
    snapshots: "tools/datapack/release/source-snapshots.json",
    pack: "tools/datapack/release/capital-production-canonical-pack.json",
    inventory: "tools/datapack/source-inventory.json",
    governance: "tools/datapack/source-governance-policy.json",
    freshness: "release/product-gates/datapack-freshness-sla.json",
  };
  const [candidate, request, hashes, snapshots, pack, inventory, governanceBytes, freshnessPolicy] = await Promise.all([
    readJson(root, paths.candidate), readJson(root, paths.request), readJson(root, paths.hashes), readJson(root, paths.snapshots),
    readJson(root, paths.pack), readJson(root, paths.inventory), readFile(path.join(root, paths.governance)),
    readJson(root, paths.freshness),
  ]);
  const governancePolicy = JSON.parse(governanceBytes);
  const predecessorIndex = candidate.sourceSnapshots.findIndex(({ sourceId }) => sourceId === PREDECESSOR_SOURCE_ID);
  const predecessor = snapshots.find(({ snapshotId }) => snapshotId === candidate.sourceSnapshotIds[predecessorIndex]);
  const publicSource = inventory.sources.find(({ id }) => id === PUBLIC_SOURCE_ID);
  const predecessorSource = inventory.sources.find(({ id }) => id === PREDECESSOR_SOURCE_ID);
  if (predecessorIndex < 0 || !predecessor || !publicSource || !predecessorSource) {
    throw new Error("synthetic public route-map predecessor fixture is incomplete");
  }

  const capturedAt = new Date(now.getTime() - 60_000).toISOString();
  const stamp = capturedAt.replaceAll(/[-:.]/gu, "");
  const redactedRequestFingerprint = sha256("public-route-map-request");
  const snapshotId = `${PUBLIC_SOURCE_ID}-current-${stamp}`;
  const sourceSnapshotPath = publicSource.routeMapAdmissionEvidence?.snapshotPath;
  const topologySnapshotId = publicSource.routeMapAdmissionEvidence?.currentTopologyAdmission?.topologySnapshotId;
  if (typeof sourceSnapshotPath !== "string" || typeof topologySnapshotId !== "string") {
    throw new Error("synthetic public route-map source evidence is incomplete");
  }
  const topologySnapshotPath = `tools/datapack/sources/${topologySnapshotId}.json`;
  const [sourceSnapshotBytes, topologySnapshotBytes] = await Promise.all([
    readFile(path.join(root, sourceSnapshotPath)),
    readFile(path.join(root, topologySnapshotPath)),
  ]);
  const sourceSnapshot = JSON.parse(sourceSnapshotBytes);
  const providerRecords = sourceSnapshot.positions.map((position) => ({
    line: position.line,
    lineId: position.lineId,
    stationCode: position.stationCode,
    stationName: position.stationName,
    latitude: position.latitude,
    longitude: position.longitude,
    basisDate: sourceSnapshot.observedDataUpdatedAt,
  }));
  const rawBytes = Buffer.from(`${JSON.stringify(providerRecords)}\n`);
  const rawSha256 = sha256(rawBytes);
  const routeMapLayoutArtifact = buildSeoulRouteMapPositions({
    records: providerRecords,
    topologySnapshotBytes,
    topologySnapshotId,
    now: new Date(capturedAt),
    rawSha256,
  });
  const routeMapLayoutArtifactBytes = jsonBytes(routeMapLayoutArtifact);
  const layoutArtifactSha256 = sha256(Buffer.from(`${JSON.stringify(routeMapLayoutArtifact)}\n`));
  const contentSha256 = sha256(Buffer.from(`${JSON.stringify(routeMapLayoutArtifact.rawPositions)}\n`));
  const schemaFingerprint = sha256(JSON.stringify(Object.keys(routeMapLayoutArtifact.rawPositions[0]).sort((left, right) => left.localeCompare(right, "en"))));
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
    ...structuredClone(predecessor),
    snapshotId,
    sourceId: PUBLIC_SOURCE_ID,
    provider: publicSource.provider,
    retrievedAt: capturedAt,
    sourceUpdatedAt: `${routeMapLayoutArtifact.observedDataUpdatedAt}T00:00:00.000Z`,
    rowCount: routeMapLayoutArtifact.rawPositions.length,
    coverageCount: routeMapLayoutArtifact.rawPositions.length,
    rawSha256,
    rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/${objectKey}`,
    redactedRequestFingerprint,
    schemaFingerprint,
    contentSha256,
    previousSnapshotId: null,
    diffSummary: null,
    freshnessExpiresAt,
    rawRetentionExpiresAt,
    governancePolicyVersion: governancePolicy.policyVersion,
    governancePolicySha256: sha256(governanceBytes),
    providerRecordHashes: routeMapLayoutArtifact.rawPositions.map((record) => sha256(JSON.stringify(record))),
    normalizedObservationSha256: sha256(routeMapLayoutArtifactBytes),
    routeMapLayoutEvidence: layout,
    routeMapLayoutArtifact,
    projectionMigration: {
      migrationKind: "CROSS_SOURCE_CANONICAL_REPLACEMENT",
      sourceId: PUBLIC_SOURCE_ID,
      replacedSourceId: PREDECESSOR_SOURCE_ID,
      replacedSnapshotId: predecessor.snapshotId,
      replacedRawSha256: predecessor.rawSha256,
      replacedSchemaFingerprint: predecessor.schemaFingerprint,
      candidateSlotSourceId: PREDECESSOR_SOURCE_ID,
    },
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
      byteSize: rawBytes.length,
      storedAt: capturedAt,
      rawRetentionExpiresAt,
    },
  };
  snapshots.push(snapshot);

  publicSource.requiredForProductionPack = true;
  publicSource.productionUseAllowed = true;
  publicSource.coverageScope = {
    ...publicSource.coverageScope,
    operatorIds: [...CURRENT_SEOUL_PUBLIC_ROUTE_MAP_OPERATOR_IDS],
  };
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
  predecessorSource.requiredForProductionPack = false;
  predecessorSource.productionUseAllowed = false;

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

  const currentTopologyAdmissions = inventory.sources
    .map((source) => ({ source, admission: source.routeMapAdmissionEvidence?.currentTopologyAdmission }))
    .filter(({ admission }) => admission?.topologySnapshotId != null);
  const currentTopologyAdmission = currentTopologyAdmissions[0]?.admission;
  const currentTopologySnapshotId = currentTopologyAdmission?.topologySnapshotId;
  if (typeof currentTopologySnapshotId !== "string"
    || currentTopologyAdmissions.length === 0
    || currentTopologyAdmissions.some(({ admission }) => admission.topologySnapshotId !== currentTopologySnapshotId)) {
    throw new Error("synthetic current topology admission fixture is incomplete");
  }
  const currentTopologyPath = `tools/datapack/sources/${currentTopologySnapshotId}.json`;
  const currentTopology = JSON.parse(topologySnapshotBytes);
  const topologyFreshnessMillis = Date.parse(currentTopology.freshUntil) - Date.parse(currentTopology.capturedAt);
  if (!Number.isFinite(topologyFreshnessMillis) || topologyFreshnessMillis <= 0) {
    throw new Error("synthetic current topology freshness is invalid");
  }
  const candidateTopologyCapturedAt = candidate.publishedAt;
  const candidateTopology = projectCapitalTopologyOwnership({
    ...currentTopology,
    capturedAt: candidateTopologyCapturedAt,
    freshUntil: new Date(Date.parse(candidateTopologyCapturedAt) + topologyFreshnessMillis).toISOString(),
    lines: currentTopology.lines.map((line) => ({ ...line, capturedAt: candidateTopologyCapturedAt })),
  });
  const candidateTopologyPath = `tools/datapack/sources/${currentTopologySnapshotId}-source-separated.json`;
  const candidateTopologyBytes = jsonBytes(candidateTopology);
  const topologyReverificationPath = `tools/datapack/release/${currentTopologySnapshotId}-reverification.json`;
  const topologyReverification = buildCapitalTopologyReverificationEvidence(
    projectCapitalTopologyOwnership(currentTopology),
    candidateTopology,
  );
  topologyReverification.baseline.snapshotId = currentTopologySnapshotId;
  const topologyReverificationBytes = jsonBytes(topologyReverification);
  const candidateTopologyAdmissions = new Map(candidateTopology.lines.map(({ lineId }) => [lineId, {
    verifiedAt: candidateTopology.capturedAt,
    freshUntil: candidateTopology.freshUntil,
  }]));
  projectCapitalTopologyIntoCanonicalFixture(
    pack,
    candidateTopology,
    currentTopologySnapshotId,
    candidateTopologyAdmissions,
  );
  for (const { source, admission } of currentTopologyAdmissions) {
    Object.assign(admission, {
      topologyContentSha256: candidateTopology.contentSha256,
      reviewedAt: candidateTopology.capturedAt,
      freshUntil: candidateTopology.freshUntil,
      ...(source.id === PUBLIC_SOURCE_ID ? { positionSnapshotSha256: sha256(routeMapLayoutArtifactBytes) } : {}),
      topologyLineages: admission.topologyLineages.map((lineage) => ({
        ...lineage,
        contentSha256: candidateTopology.contentSha256,
      })),
    });
  }
  Object.assign(candidate.networkEdgeEvidence.capitalTopology, {
    path: currentTopologyPath,
    sha256: sha256(topologySnapshotBytes),
    snapshotId: currentTopologySnapshotId,
  });
  Object.assign(candidate.networkEdgeEvidence.capitalTopologyCandidate, {
    path: candidateTopologyPath,
    sha256: sha256(candidateTopologyBytes),
    snapshotId: currentTopologySnapshotId,
  });
  Object.assign(candidate.networkEdgeEvidence.capitalTopologyReverification, {
    path: topologyReverificationPath,
    sha256: sha256(topologyReverificationBytes),
  });
  Object.assign(candidate.networkEdgeEvidence.capitalTopologyAdmission, {
    snapshotId: currentTopologySnapshotId,
    contentSha256: candidateTopology.contentSha256,
    reviewedAt: candidateTopology.capturedAt,
    reverifiedAt: candidateTopology.capturedAt,
    freshUntil: candidateTopology.freshUntil,
  });
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
  const inventoryBytes = jsonBytes(inventory);
  candidate.sourceSnapshotIds[predecessorIndex] = snapshotId;
  candidate.sourceSnapshots[predecessorIndex] = deriveReleaseProjection({
    snapshot,
    sourceInventory: inventory,
    governancePolicy,
    governancePolicyBytes: governanceBytes,
    freshnessPolicy,
    nowMillis: now.getTime(),
  });
  const selectedIds = new Set(candidate.sourceSnapshotIds);
  candidate.sourceSnapshotSetHash = sha256(JSON.stringify(
    snapshots.filter(({ snapshotId: selectedId }) => selectedIds.has(selectedId)),
  ));
  candidate.sourceInventorySha256 = sha256(JSON.stringify(inventory));
  candidate.networkEdgeEvidence.sourceInventory.sha256 = sha256(inventoryBytes);
  const candidateBytes = jsonBytes(candidate);
  const packBytes = jsonBytes(pack);
  Object.assign(request, {
    candidateId: candidate.candidateId,
    buildSpecSha256: sha256(candidateBytes),
    sourceSnapshotSetHash: candidate.sourceSnapshotSetHash,
    approvedLedgerHash: candidate.approvedAliasLedgerHash,
  });
  const selected = snapshots.filter(({ snapshotId: selectedId }) => selectedIds.has(selectedId));
  hashes.sourceSnapshotSetHash.value = candidate.sourceSnapshotSetHash;
  hashes.sourceInventorySha256.value = candidate.sourceInventorySha256;
  hashes.fixturePath.sha256 = sha256(packBytes);
  hashes.sourceSnapshots.order = `release snapshot 순서: ${selected.map(({ sourceId }) => sourceId).join(" → ")}`;
  hashes.perSourceEvidence = selected.map((selectedSnapshot) => ({
    sourceId: selectedSnapshot.sourceId,
    snapshotId: selectedSnapshot.snapshotId,
    rawSha256: selectedSnapshot.rawSha256,
    adminReviewRecordHash: inventory.sources.find(({ id }) => id === selectedSnapshot.sourceId)
      .admissionEvidence.adminReviewRecordHash,
    perSourceSnapshotSetHash: sha256(JSON.stringify([selectedSnapshot])),
  }));

  await Promise.all([
    writeFile(path.join(root, `tools/datapack/sources/${snapshotId}.json`), routeMapLayoutArtifactBytes),
    writeFile(path.join(root, candidateTopologyPath), candidateTopologyBytes),
    writeFile(path.join(root, topologyReverificationPath), topologyReverificationBytes),
    writeFile(path.join(root, incheonSnapshotPath), incheonSnapshotBytes),
    writeFile(path.join(root, paths.snapshots), jsonBytes(snapshots)),
    writeFile(path.join(root, paths.inventory), inventoryBytes),
    writeFile(path.join(root, paths.pack), packBytes),
    writeFile(path.join(root, paths.candidate), candidateBytes),
    writeFile(path.join(root, paths.request), jsonBytes(request)),
    writeFile(path.join(root, paths.hashes), jsonBytes(hashes)),
  ]);
  return { snapshotId, predecessorSnapshotId: predecessor.snapshotId };
}

export async function activateSyntheticCurrentStaticNetworkSuccessors(root, { now }) {
  const routeMap = await activateSyntheticCurrentPublicRouteMapSuccessor(root, { now });
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
  const snapshotId = `${MOLIT_SOURCE_ID}-current-${now.toISOString().replaceAll(/[-:.]/gu, "")}`;
  const successor = {
    ...structuredClone(predecessor),
    snapshotId,
    retrievedAt: now.toISOString(),
    previousSnapshotId: predecessor.snapshotId,
    diffSummary: { status: "NO_CHANGE", rawHashChanged: false, schemaHashChanged: false, requestHashChanged: false, sourceUpdatedAtChanged: false, rowDelta: 0, coverageDelta: 0 },
    rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/source-raw/${MOLIT_SOURCE_ID}/${now.toISOString().slice(0, 10).replaceAll("-", "")}/${predecessor.rawSha256}.csv`,
    projectionMigration: {
      schemaVersion: 1,
      artifactKind: "source-projection-migration-evidence",
      migrationKind: "LEGACY_SAMPLE_TO_FULL_CONSUMED_FIELDS",
      sourceId: MOLIT_SOURCE_ID,
      legacySnapshotId: predecessor.snapshotId,
      legacyRawSha256: predecessor.rawSha256,
      legacySchemaFingerprint: predecessor.schemaFingerprint,
      legacyProviderRecordHashes: predecessor.providerRecordHashes,
      fullProjectionSha256: predecessor.contentSha256 ?? sha256(JSON.stringify(predecessor.providerRecordHashes)),
      fullProjectionSchemaFingerprint: predecessor.schemaFingerprint,
      fullProjectionRowCount: predecessor.rowCount,
      newSnapshotId: snapshotId,
    },
  };
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
