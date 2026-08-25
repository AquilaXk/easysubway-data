import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { buildSeoulRouteMapPositions } from "../collect-seoul-route-map-positions.mjs";
import {
  buildCapitalTopologyReverificationEvidence,
} from "../collect-capital-route-topology.mjs";
import { currentIncheonStationCodeDerivations } from "../collect-incheon-station-info.mjs";
import {
  projectCapitalTopologyIntoCanonicalFixture,
  validateSourceSeparatedCurrentTopology,
} from "../build-datapack.mjs";
import {
  buildCurrentExitAdmissionOciReceipt,
  canonicalCurrentExitAdmissionOciReceiptJson,
} from "../build-current-exit-admission-oci-receipt.mjs";
import { deriveFreshnessExpiresAt } from "../freshness-policy.mjs";
import {
  CURRENT_SEOUL_PUBLIC_ROUTE_MAP_COVERAGE,
  CURRENT_SEOUL_PUBLIC_ROUTE_MAP_OPERATOR_IDS,
  materializeSeoulRouteMapPositions,
  verifyCurrentCapitalPublicRouteMapDocument,
} from "../materialize-seoul-route-map-positions.mjs";
import { deriveReleaseProjection } from "../rebind-current-candidate-source-snapshots.mjs";
import { buildSnapshotDiff } from "../source-snapshot-policy.mjs";
import { deriveRawRetentionExpiresAt } from "../source-governance-policy.mjs";
import { codepointCompare } from "../../lib/codepoint-compare.mjs";

const PUBLIC_SOURCE_ID = "seoul-metro-route-map-positions";
const MOLIT_SOURCE_ID = "molit-urban-rail-full-route";
const CURRENT_CAPITAL_SOURCE_IDS = Object.freeze([
  "molit-urban-rail-full-route", "seoulmetro-station-line-info", PUBLIC_SOURCE_ID,
  "kric-subway-timetable", "seoul-metro-accessibility", "kric-station-convenience-standard",
  "seoul-metro-official-od-fares", "seoul-metro-transfer-distance-duration",
]);
const SHA_KEYS = Object.freeze([
  "layoutAlgorithmVersion", "topologySnapshotId", "topologySnapshotSha256",
  "topologySnapshotIdentity", "lineOrderSha256", "aliasLedgerVersion", "aliasLedgerSha256",
  "rawPositionsSha256", "layoutPositionsSha256", "layoutTracksSha256", "semanticInputSha256",
  "semanticOutputSha256", "outputSchemaSha256", "layoutArtifactSha256",
]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const canonical = (value) => Array.isArray(value)
  ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object"
  ? "{" + Object.keys(value).sort(codepointCompare).map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}"
  : JSON.stringify(value);

function orderCurrentCapitalSources(document) {
  const capital = document?.packs?.find(({ id }) => id === "capital");
  const entries = capital?.sourceInventory;
  const byId = new Map(entries?.map((entry) => [entry.id, entry]));
  if (!Array.isArray(entries)
    || byId.size !== entries.length
    || byId.size !== CURRENT_CAPITAL_SOURCE_IDS.length
    || CURRENT_CAPITAL_SOURCE_IDS.some((sourceId) => !byId.has(sourceId))) {
    throw new Error("synthetic current capital source identity is incomplete");
  }
  capital.sourceInventory = CURRENT_CAPITAL_SOURCE_IDS.map((sourceId) => structuredClone(byId.get(sourceId)));
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
  "tools/datapack/fixtures/seoul-route-map-positions-raw/data-go-15099316.csv",
  "tools/datapack/release/candidate-build-spec.json",
  "tools/datapack/release/release-request.json",
  "tools/datapack/release/hash-evidence.json",
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/release/capital-production-canonical-pack.json",
  "tools/datapack/source-inventory.json",
  "tools/datapack/source-governance-policy.json",
  "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv",
  "release/product-gates/datapack-freshness-sla.json",
  "tools/datapack/official-od-fare-admission.json",
  "tools/datapack/nationwide-coverage-targets.json",
  "tools/datapack/release/current-capital-accessibility-full/station-line-input.json",
  "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json",
  "tools/datapack/release/current-capital-facility-source-admission.json",
  "tools/datapack/release/current-exit-admission-v2/exit-path-normalized-source-snapshot.json",
  "tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json",
  "tools/datapack/release/current-transfer-topology-metrics.json",
  "tools/datapack/release/current-capital-transfer-topology-applicability.json",
  "release/product-gates/route-edge-evaluation-policy.json",
  "tools/datapack/schema/catalog-schema.sql",
]);

export async function copySyntheticCurrentPublicRouteMapRepository(
  sourceRoot,
  targetRoot,
  { now, activateStaticNetwork = false, activatePublicRouteMap = true },
) {
  if (activateStaticNetwork) {
    await copySyntheticCurrentPublicRouteMapRepository(sourceRoot, targetRoot, {
      now,
      activatePublicRouteMap: false,
    });
    await bindSyntheticActivatedOutputsToCurrentCandidate(targetRoot);
    const result = await activateSyntheticCurrentStaticNetworkSuccessors(targetRoot, { now });
    await bindSyntheticDependentAdmissionsToCurrentTransition(targetRoot);
    return result;
  }
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
    ...inventory.sources.map((source) => source.routeMapAdmissionEvidence?.currentLayoutAdmission?.snapshotPath),
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

async function bindSyntheticActivatedOutputsToCurrentCandidate(root) {
  const candidate = await readJson(root, "tools/datapack/release/candidate-build-spec.json");
  const outputPaths = [
    "tools/datapack/release/current-capital-accessibility-full/station-line-input.json",
    "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json",
  ];
  const [station, route] = await Promise.all(outputPaths.map((relative) => readJson(root, relative)));
  station.candidate.candidateId = candidate.candidateId;
  station.candidate.sourceSetSha256 = candidate.sourceSnapshotSetHash;
  for (const row of station.evidenceRows) row.candidateId = candidate.candidateId;
  route.candidate.candidateId = candidate.candidateId;
  route.candidate.sourceSetSha256 = candidate.sourceSnapshotSetHash;
  await Promise.all(outputPaths.map((relative, index) =>
    writeFile(path.join(root, relative), jsonBytes(index === 0 ? station : route))));
}

async function bindSyntheticDependentAdmissionsToCurrentTransition(root) {
  const paths = {
    candidate: "tools/datapack/release/candidate-build-spec.json",
    snapshots: "tools/datapack/release/source-snapshots.json",
    facility: "tools/datapack/release/current-capital-facility-source-admission.json",
    exit: "tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json",
    exitReceipt: "tools/datapack/release/current-exit-admission-v2/exit-path-admission-oci-receipt.json",
  };
  const [candidate, snapshots, facility, exit, receipt] = await Promise.all([
    readJson(root, paths.candidate), readJson(root, paths.snapshots), readJson(root, paths.facility),
    readJson(root, paths.exit), readJson(root, paths.exitReceipt),
  ]);
  const selected = candidate.sourceSnapshotIds.map((snapshotId) =>
    snapshots.find((snapshot) => snapshot.snapshotId === snapshotId));
  const bySource = (sourceId) => selected.find((snapshot) => snapshot?.sourceId === sourceId);
  const positions = bySource(PUBLIC_SOURCE_ID);
  const molit = bySource(MOLIT_SOURCE_ID);
  const seoul = bySource("seoul-metro-accessibility");
  if (selected.some((snapshot) => snapshot == null)
    || [positions, molit, seoul].some((snapshot) => typeof snapshot?.previousSnapshotId !== "string")) {
    throw new Error("synthetic dependent admission transition fixture is incomplete");
  }
  const evidenceIds = new Set(candidate.sourceSnapshotIds.flatMap((snapshotId, index) => {
    const sourceId = candidate.sourceSnapshots[index].sourceId;
    if (sourceId === "seoul-metro-transfer-distance-duration") return [];
    if (sourceId === PUBLIC_SOURCE_ID) return [positions.previousSnapshotId];
    if (sourceId === MOLIT_SOURCE_ID) return [molit.previousSnapshotId];
    if (sourceId === "seoul-metro-accessibility") return [seoul.previousSnapshotId];
    return [snapshotId];
  }));
  const evidence = snapshots.filter(({ snapshotId }) => evidenceIds.has(snapshotId));
  if (evidenceIds.size !== 6 || evidence.length !== 6) {
    throw new Error("synthetic dependent admission evidence fixture is incomplete");
  }
  const sourceSetSha256 = sha256(JSON.stringify(evidence));
  facility.candidate.candidateId = candidate.candidateId;
  facility.candidate.sourceSnapshotSetHash = sourceSetSha256;
  const facilityPayload = { ...facility };
  delete facilityPayload.admissionDigest;
  facility.admissionDigest = sha256(canonical(facilityPayload));
  exit.candidate.candidateId = candidate.candidateId;
  exit.candidate.sourceSetSha256 = sourceSetSha256;
  for (const row of exit.materializerEvidenceRows) {
    row.candidateId = candidate.candidateId;
    row.sourceSetSha256 = sourceSetSha256;
  }
  const exitPayload = { ...exit };
  delete exitPayload.admissionDigest;
  exit.admissionDigest = sha256(canonical(exitPayload));
  const exitBytes = Buffer.from(canonical(exit));
  receipt.admissionDigest = exit.admissionDigest;
  receipt.admissionSha256 = sha256(exitBytes);
  const receiptPayload = { ...receipt };
  delete receiptPayload.receiptSha256;
  receipt.receiptSha256 = sha256(canonical(receiptPayload));
  await Promise.all([
    writeFile(path.join(root, paths.facility), Buffer.from(`${canonical(facility)}\n`)),
    writeFile(path.join(root, paths.exit), exitBytes),
    writeFile(path.join(root, paths.exitReceipt), Buffer.from(canonical(receipt))),
  ]);
}

async function writeSyntheticCurrentExitOciReceipt(root) {
  const normalizedPath = "tools/datapack/release/current-exit-admission-v2/exit-path-normalized-source-snapshot.json";
  const admissionPath = "tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json";
  const receiptPath = "tools/datapack/release/current-exit-admission-v2/exit-path-admission-oci-receipt.json";
  const [normalizedBytes, admissionBytes] = await Promise.all([
    readFile(path.join(root, normalizedPath)),
    readFile(path.join(root, admissionPath)),
  ]);
  const providerCollectionBundleBytes = Buffer.from("synthetic-current-exit-provider");
  const providerObjectSha256 = sha256(providerCollectionBundleBytes);
  const receipt = buildCurrentExitAdmissionOciReceipt({
    repository: "AquilaXk/easysubway-data",
    mainSha: "a".repeat(40),
    operationId: "synthetic-current-public-route-map",
    providerCapturedAt: "2026-08-01T00:00:00.000Z",
    providerCollectionBundleBytes,
    providerObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/operations/current-capital-live-chain/v1/heads/${"a".repeat(40)}/operations/synthetic-current-public-route-map/provider-collections/20260801-${providerObjectSha256}.json`,
    providerObjectSha256,
    providerObjectByteSize: providerCollectionBundleBytes.length,
    normalizedBytes,
    admissionBytes,
  });
  const target = path.join(root, receiptPath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, Buffer.from(canonicalCurrentExitAdmissionOciReceiptJson(receipt)));
}

export async function nextSyntheticCurrentStaticNetworkNow(root) {
  const [candidate, snapshots, inventory] = await Promise.all([
    readJson(root, "tools/datapack/release/candidate-build-spec.json"),
    readJson(root, "tools/datapack/release/source-snapshots.json"),
    readJson(root, "tools/datapack/source-inventory.json"),
  ]);
  const selected = candidate.sourceSnapshotIds.map((snapshotId) =>
    snapshots.find((snapshot) => snapshot.snapshotId === snapshotId));
  if (selected.some((snapshot) => snapshot == null)) {
    throw new Error("synthetic current static-network clock fixture is incomplete");
  }
  const capitalTopologyPath = candidate.networkEdgeEvidence?.capitalTopology?.path;
  const incheonTopologyPath = inventory.sources
    .find(({ id }) => id === "incheon-transit-station-info")
    ?.routeMapAdmissionEvidence?.snapshotPath;
  if (typeof capitalTopologyPath !== "string" || typeof incheonTopologyPath !== "string") {
    throw new Error("synthetic current topology clock fixture is incomplete");
  }
  const [capitalTopology, incheonTopology] = await Promise.all([
    readJson(root, capitalTopologyPath),
    readJson(root, incheonTopologyPath),
  ]);
  const basisAt = Math.max(...selected.flatMap((snapshot) => [
    snapshot.retrievedAt,
    snapshot.sourceUpdatedAt,
    snapshot.rawReceipt?.storedAt,
  ].filter(Boolean).map(Date.parse)), Date.parse(capitalTopology.capturedAt), Date.parse(incheonTopology.capturedAt));
  const freshUntil = Math.min(
    ...selected.map(({ freshnessExpiresAt }) => Date.parse(freshnessExpiresAt)),
    Date.parse(capitalTopology.freshUntil),
    Date.parse(incheonTopology.freshUntil),
  );
  const nowMillis = basisAt + 60_000;
  if (!Number.isFinite(basisAt) || !Number.isFinite(freshUntil) || nowMillis >= freshUntil) {
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
  };
  const [candidate, request, hashes, snapshots, pack, inventory, governanceBytes, freshnessPolicy] = await Promise.all([
    readJson(root, paths.candidate), readJson(root, paths.request), readJson(root, paths.hashes), readJson(root, paths.snapshots),
    readJson(root, paths.pack), readJson(root, paths.inventory), readFile(path.join(root, paths.governance)),
    readJson(root, paths.freshness),
  ]);
  const governancePolicy = JSON.parse(governanceBytes);
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
  const selectedPublicSnapshot = snapshots[selectedPublicSnapshotIndex];
  if (selectedPublicSnapshotId != null && ((advancesCurrentPublicHead
    ? publicSnapshots.filter(({ previousSnapshotId }) => previousSnapshotId == null).length !== 1
    : publicSnapshots.length !== 1)
    || selectedPublicSnapshotIndex < 0
    || selectedPublicSnapshot?.sourceId !== PUBLIC_SOURCE_ID
    || (!advancesCurrentPublicHead && selectedPublicSnapshot.previousSnapshotId != null))) {
    throw new Error("synthetic public route-map successor fixture has invalid public source lineage");
  }
  const publicSource = inventory.sources.find(({ id }) => id === PUBLIC_SOURCE_ID);
  if (!predecessor || !publicSource) {
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
  const contentSha256 = advancesCurrentPublicHead
    ? sourceSnapshot.contentSha256
    : sha256(Buffer.from(`${JSON.stringify(routeMapLayoutArtifact.rawPositions)}\n`));
  const schemaFingerprint = advancesCurrentPublicHead
    ? sourceSnapshot.schemaFingerprint
    : sha256(JSON.stringify(Object.keys(routeMapLayoutArtifact.rawPositions[0]).sort((left, right) => left.localeCompare(right, "en"))));
  const providerRecordHashes = advancesCurrentPublicHead
    ? sourceSnapshot.providerRecordHashes
    : routeMapLayoutArtifact.rawPositions.map((record) => sha256(JSON.stringify(record)));
  if (advancesCurrentPublicHead && (sourceSnapshot.snapshotId !== successorPredecessor.snapshotId
    || contentSha256 !== currentLayoutAdmission.contentSha256
    || contentSha256 !== successorPredecessor.contentSha256
    || schemaFingerprint !== successorPredecessor.schemaFingerprint
    || sourceSnapshot.rowCount !== routeMapLayoutArtifact.rawPositions.length
    || !Array.isArray(providerRecordHashes)
    || providerRecordHashes.length !== routeMapLayoutArtifact.rawPositions.length
    || !isDeepStrictEqual(providerRecordHashes, successorPredecessor.providerRecordHashes))) {
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
    normalizedProjection: structuredClone(routeMapLayoutArtifact.rawPositions),
    routeMapLayoutEvidence: layout,
    routeMapLayoutArtifact,
    rawReceipt: structuredClone(snapshot.rawReceipt),
  };
  snapshot.publicStaticNetworkV2Observation = observation;
  snapshot.normalizedObservationSha256 = sha256(Buffer.from(`${JSON.stringify(observation)}\n`));
  if (advancesCurrentPublicHead) snapshot.diffSummary = buildSnapshotDiff(successorPredecessor, snapshot);
  if (selectedPublicSnapshotIndex >= 0 && !advancesCurrentPublicHead) snapshots.splice(selectedPublicSnapshotIndex, 1, snapshot);
  else snapshots.push(snapshot);

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
  const currentSourceIds = new Set(CURRENT_CAPITAL_SOURCE_IDS);
  pack.packs[0].sourceInventory = pack.packs[0].sourceInventory.filter(({ id }) => currentSourceIds.has(id));
  pack.packs[0].routeMapPositions = [];

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
  candidate.candidateId = `capital-pilot-candidate-${currentTopologySnapshotId.slice(-8)}`;
  candidate.publishedAt = now.toISOString();
  const currentTopologyPath = `tools/datapack/sources/${currentTopologySnapshotId}.json`;
  const currentTopology = JSON.parse(topologySnapshotBytes);
  const currentIncheonSource = inventory.sources.find(({ id }) => id === "incheon-transit-station-info");
  const currentIncheonTopologyPath = currentIncheonSource?.routeMapAdmissionEvidence?.snapshotPath;
  if (typeof currentIncheonTopologyPath !== "string") {
    throw new Error("synthetic current Incheon topology fixture is missing");
  }
  validateSourceSeparatedCurrentTopology({
    capitalTopology: currentTopology,
    incheonSnapshot: JSON.parse(await readFile(path.join(root, currentIncheonTopologyPath))),
  });
  const topologyFreshnessMillis = Date.parse(currentTopology.freshUntil) - Date.parse(currentTopology.capturedAt);
  if (!Number.isFinite(topologyFreshnessMillis) || topologyFreshnessMillis <= 0) {
    throw new Error("synthetic current topology freshness is invalid");
  }
  const candidateTopologyCapturedAt = candidate.publishedAt;
  const candidateTopology = {
    ...currentTopology,
    capturedAt: candidateTopologyCapturedAt,
    freshUntil: new Date(Date.parse(candidateTopologyCapturedAt) + topologyFreshnessMillis).toISOString(),
    lines: currentTopology.lines.map((line) => ({ ...line, capturedAt: candidateTopologyCapturedAt })),
  };
  const candidateTopologyPath = `tools/datapack/sources/${currentTopologySnapshotId}-source-separated.json`;
  const candidateTopologyBytes = jsonBytes(candidateTopology);
  const topologyReverificationPath = `tools/datapack/release/${currentTopologySnapshotId}-reverification.json`;
  const topologyReverification = buildCapitalTopologyReverificationEvidence(
    currentTopology,
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
      ...(source.id === PUBLIC_SOURCE_ID ? { positionSnapshotSha256: snapshot.normalizedObservationSha256 } : {}),
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
  const selectedSnapshots = snapshots.filter(({ snapshotId: selectedId }) => selectedIds.has(selectedId));
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

  await Promise.all([
    writeFile(path.join(root, `tools/datapack/sources/${snapshotId}.json`), jsonBytes(observation)),
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
