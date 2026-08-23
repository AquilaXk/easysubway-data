import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { deriveFreshnessExpiresAt } from "../freshness-policy.mjs";
import { deriveReleaseProjection } from "../rebind-current-candidate-source-snapshots.mjs";
import { deriveRawRetentionExpiresAt } from "../source-governance-policy.mjs";

const PUBLIC_SOURCE_ID = "seoul-metro-route-map-positions";
const PREDECESSOR_SOURCE_ID = "seoulmetro-cyberstation-route-map";
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
]);

export async function copySyntheticCurrentPublicRouteMapRepository(sourceRoot, targetRoot, { now }) {
  const [candidate, inventory, itxContract] = await Promise.all([
    readJson(sourceRoot, "tools/datapack/release/candidate-build-spec.json"),
    readJson(sourceRoot, "tools/datapack/source-inventory.json"),
    readJson(sourceRoot, "tools/datapack/itx-cheongchun-coverage-contract.json"),
  ]);
  const dynamicPaths = [
    candidate.fixturePath,
    candidate.sourceSnapshotEvidencePath,
    candidate.itxTopologyEvidencePath,
    candidate.productionScopePolicy?.path,
    ...Object.values(candidate.networkEdgeEvidence ?? {}).map((evidence) => evidence?.path),
    ...inventory.sources.map((source) => source.routeMapAdmissionEvidence?.snapshotPath),
    ...referencedPaths(candidate),
    ...referencedPaths(itxContract),
  ];
  const relatives = [...new Set([...SUCCESSOR_FIXTURE_PATHS, ...dynamicPaths]
    .filter((relative) => typeof relative === "string"))];
  for (const relative of relatives) {
    if (path.isAbsolute(relative) || relative.split(path.sep).includes("..")) {
      throw new Error(`synthetic successor fixture path is unsafe: ${relative}`);
    }
    const destination = path.join(targetRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(sourceRoot, relative), destination);
  }
  return activateSyntheticCurrentPublicRouteMapSuccessor(targetRoot, { now });
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
  const rawSha256 = sha256(`public-route-map-raw:${stamp}`);
  const contentSha256 = sha256(`public-route-map-content:${stamp}`);
  const schemaFingerprint = sha256("public-route-map-schema-v2");
  const redactedRequestFingerprint = sha256("public-route-map-request");
  const snapshotId = `${PUBLIC_SOURCE_ID}-current-${stamp}`;
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
  const layout = Object.fromEntries(SHA_KEYS.map((key) => [key, key.endsWith("Sha256")
    ? sha256(`public-route-map-layout:${key}`)
    : `test-${key}`]));
  layout.topologySnapshotIdentity = `${layout.topologySnapshotId}:${layout.topologySnapshotSha256}`;
  const snapshot = {
    ...structuredClone(predecessor),
    snapshotId,
    sourceId: PUBLIC_SOURCE_ID,
    provider: publicSource.provider,
    retrievedAt: capturedAt,
    sourceUpdatedAt: capturedAt,
    rowCount: 274,
    coverageCount: 274,
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
      byteSize: 274,
      storedAt: capturedAt,
      rawRetentionExpiresAt,
    },
  };
  snapshots.push(snapshot);

  publicSource.requiredForProductionPack = true;
  publicSource.productionUseAllowed = true;
  publicSource.retrievedAt = capturedAt.slice(0, 10);
  publicSource.observedDataUpdatedAt = capturedAt.slice(0, 10);
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
    currentLayoutAdmission: {
      schemaVersion: 2,
      artifactKind: "seoul-public-route-map-layout-admission",
      status: "ADMITTED",
      positionSnapshotId: snapshotId,
      snapshotPath: `tools/datapack/sources/${snapshotId}.json`,
      snapshotSha256: sha256(`public-route-map-observation:${stamp}`),
      rawSha256,
      contentSha256,
      ...layout,
    },
  };
  predecessorSource.requiredForProductionPack = false;
  predecessorSource.productionUseAllowed = false;

  const capital = pack.packs[0];
  const canonicalIndex = capital.sourceInventory.findIndex(({ id }) => id === PREDECESSOR_SOURCE_ID);
  if (canonicalIndex < 0) throw new Error("synthetic public route-map canonical predecessor is absent");
  capital.sourceInventory[canonicalIndex] = {
    ...capital.sourceInventory[canonicalIndex],
    id: PUBLIC_SOURCE_ID,
    owner: publicSource.owner,
    url: publicSource.datasetUrl,
    coverageScope: structuredClone(publicSource.coverageScope),
  };

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
  Object.assign(request, {
    candidateId: candidate.candidateId,
    buildSpecSha256: sha256(candidateBytes),
    sourceSnapshotSetHash: candidate.sourceSnapshotSetHash,
    approvedLedgerHash: candidate.approvedAliasLedgerHash,
  });
  const selected = snapshots.filter(({ snapshotId: selectedId }) => selectedIds.has(selectedId));
  hashes.sourceSnapshotSetHash.value = candidate.sourceSnapshotSetHash;
  hashes.sourceInventorySha256.value = candidate.sourceInventorySha256;
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
    writeFile(path.join(root, paths.snapshots), jsonBytes(snapshots)),
    writeFile(path.join(root, paths.inventory), inventoryBytes),
    writeFile(path.join(root, paths.pack), jsonBytes(pack)),
    writeFile(path.join(root, paths.candidate), candidateBytes),
    writeFile(path.join(root, paths.request), jsonBytes(request)),
    writeFile(path.join(root, paths.hashes), jsonBytes(hashes)),
  ]);
  return { snapshotId, predecessorSnapshotId: predecessor.snapshotId };
}
