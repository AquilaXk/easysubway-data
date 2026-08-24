#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { collectCurrentStaticNetworkSuccessors, projectMolit, projectPositions, SEOUL_POSITION_SCHEMA_FINGERPRINT } from "./collect-current-static-network-successors.mjs";
import { buildSeoulRouteMapPositions } from "./collect-seoul-route-map-positions.mjs";
import { publishStaticNetworkSourceRaw } from "./publish-static-network-source-raw.mjs";
import { readStaticNetworkRegularFile, registerCurrentStaticNetworkSuccessors, registerPublicStaticNetworkV2Successors } from "./register-current-static-network-successors.mjs";
import { buildSnapshotDiff } from "./source-snapshot-policy.mjs";
import { approvedLegacyGovernanceBinding } from "./legacy-source-governance.mjs";
import { assertCurrentTopologyAdmissionFreshness } from "./lib/route-map-admission-freshness.mjs";
import { buildPublicStaticNetworkV2Observations } from "./build-public-static-network-v2-observations.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TARGETS = Object.freeze(["seoul-metro-route-map-positions", "molit-urban-rail-full-route"]);
const SHA = /^[a-f0-9]{64}$/u;
const MOLIT_FIELDS = Object.freeze(["region_code", "region_name", "operator_name", "line_name", "station_sequence", "station_name"]);
const POSITION_FIELDS = Object.freeze(["serial", "line", "stationCode", "stationName", "latitude", "longitude", "basisDate"]);
const compareStrings = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const canonicalBytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const RECEIPT_TYPES = Object.freeze({
  "seoul-metro-route-map-positions": { extension: "json", contentType: "application/json", rawRelativePath: "positions.raw.json" },
  "molit-urban-rail-full-route": { extension: "csv", contentType: "text/csv; charset=euc-kr", rawRelativePath: "molit.raw.csv" },
});

async function regularRoot(value, label) { const initial = await lstat(value); if (!initial.isDirectory() || initial.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink directory`); const resolved = await realpath(value); const stat = await lstat(resolved); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink directory`); return resolved; }
async function defaultExactMain(repositoryRoot) { const { execFile } = await import("node:child_process"); const { promisify } = await import("node:util"); const run = promisify(execFile); const [{ stdout: head }, { stdout: originMain }, { stdout: status }] = await Promise.all([run("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot }), run("git", ["rev-parse", "origin/main"], { cwd: repositoryRoot }), run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repositoryRoot })]); if (status !== "" || head.trim() !== originMain.trim()) throw new Error("static network repository must be exact clean main"); return head.trim(); }
function snapshotId(sourceId, capturedAt) { return `${sourceId}-current-${capturedAt.replaceAll(/[-:.]/gu, "").replace("Z", "Z")}`; }
function fingerprint(records) { return sha(JSON.stringify(Object.keys(records[0] ?? {}).sort(compareStrings))); }
function requireCapture(value) { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) throw new Error("static network observation timestamp is invalid"); return value; }
function requirePrevious(previous, sourceId) { if (!previous || previous.sourceId !== sourceId || !SHA.test(previous.rawSha256 ?? "") || !SHA.test(previous.schemaFingerprint ?? "") || !SHA.test(previous.redactedRequestFingerprint ?? "") || typeof previous.snapshotId !== "string") throw new Error("static network predecessor identity is invalid"); return previous; }
function governanceBinding(previous) { const binding = previous.governancePolicyVersion == null && previous.governancePolicySha256 == null ? approvedLegacyGovernanceBinding(previous) : { governancePolicyVersion: previous.governancePolicyVersion, governancePolicySha256: previous.governancePolicySha256 }; if (typeof binding?.governancePolicyVersion !== "string" || !SHA.test(binding.governancePolicySha256 ?? "")) throw new Error("static network predecessor governance binding is invalid"); return binding; }
function projectionRecordHashes(sourceId, projection) { return projection.map((record) => sha(JSON.stringify(record))); }
function routeMapProviderRows(rows) { return rows.map(({ line, stationCode, stationName, latitude, longitude, basisDate }) => ({ line, stationCode, stationName, latitude, longitude, basisDate })); }
function normalizedObservation({ sourceId, snapshotId: id, capturedAt, rawSha256, projection, schemaFingerprint = fingerprint(projection), migration = null, layoutEvidence = null, routeMapLayoutArtifact = null }) { const value = { schemaVersion: 1, artifactKind: "static-network-successor-observation", sourceId, snapshotId: id, capturedAt, rawSha256, contentSha256: sha(canonicalBytes(projection)), schemaFingerprint, rowCount: projection.length, providerRecordHashes: projectionRecordHashes(sourceId, projection), normalizedProjection: projection, migration, ...(layoutEvidence == null ? {} : { layoutEvidence }), ...(routeMapLayoutArtifact == null ? {} : { routeMapLayoutArtifact }) }; return { value, bytes: canonicalBytes(value) }; }
function buildDrafts(collection, layoutSnapshot) {
  const capturedAt = requireCapture(collection?.observedAt);
  if (!collection?.positions || !collection?.molit || collection.positions.sourceId !== TARGETS[0] || collection.molit.sourceId !== TARGETS[1] || !Buffer.isBuffer(collection.positions.rawBytes) || !Buffer.isBuffer(collection.molit.rawBytes)) throw new Error("static network operation source set is invalid");
  const molitPrevious = requirePrevious(collection.molit.previous, TARGETS[1]);
  const positionsProjection = collection.positions.records; const replacement = collection.positions.replacement; const replaced = requirePrevious(collection.positions.replaced, "seoulmetro-cyberstation-route-map"); const positionsId = snapshotId(TARGETS[0], capturedAt);
  if (!Array.isArray(positionsProjection) || sha(collection.positions.rawBytes) !== collection.positions.rawSha256 || collection.positions.providerSchemaFingerprint !== SEOUL_POSITION_SCHEMA_FINGERPRINT || JSON.stringify(Object.keys(positionsProjection[0] ?? {})) !== JSON.stringify(POSITION_FIELDS) || !replacement || replacement.migrationKind !== "CROSS_SOURCE_CANONICAL_REPLACEMENT" || replacement.sourceId !== TARGETS[0] || replacement.replacedSourceId !== replaced.sourceId || replacement.replacedSnapshotId !== replaced.snapshotId || replacement.replacedRawSha256 !== replaced.rawSha256 || replacement.replacedSchemaFingerprint !== replaced.schemaFingerprint || replacement.candidateSlotSourceId !== replaced.sourceId) throw new Error("static network public replacement identity is invalid");
  const molitProjection = collection.molit.records; const molitHashes = Array.isArray(molitProjection) ? projectionRecordHashes(TARGETS[1], molitProjection) : []; const molitMigration = collection.molit.migration;
  if (!Array.isArray(molitProjection) || sha(collection.molit.rawBytes) !== collection.molit.rawSha256
    || JSON.stringify(Object.keys(molitProjection[0] ?? {})) !== JSON.stringify(MOLIT_FIELDS)
    || !molitMigration || molitMigration.sourceId !== TARGETS[1] || molitMigration.migrationKind !== "LEGACY_SAMPLE_TO_FULL_CONSUMED_FIELDS"
    || molitMigration.legacySnapshotId !== molitPrevious.snapshotId || molitMigration.legacyRawSha256 !== molitPrevious.rawSha256
    || molitMigration.legacySchemaFingerprint !== molitPrevious.schemaFingerprint || JSON.stringify(molitMigration.legacyProviderRecordHashes) !== JSON.stringify(molitPrevious.providerRecordHashes)
    || molitMigration.fullProjectionSha256 !== sha(canonicalBytes(molitProjection))
    || molitMigration.fullProjectionSchemaFingerprint !== sha(JSON.stringify(MOLIT_FIELDS)) || molitMigration.fullProjectionRowCount !== molitProjection.length
    || molitMigration.newSnapshotId !== snapshotId(TARGETS[1], capturedAt) || molitHashes.length !== molitProjection.length) throw new Error("static network MOLIT projection identity is invalid");
  const basisDate = positionsProjection[0]?.basisDate;
  if (typeof basisDate !== "string" || positionsProjection.some((record) => record.basisDate !== basisDate)) throw new Error("static network public basis date is invalid");
  if (!layoutSnapshot || layoutSnapshot.rawSha256 !== collection.positions.rawSha256 || !Array.isArray(layoutSnapshot.rawPositions) || layoutSnapshot.rawPositions.length !== positionsProjection.length) throw new Error("static network layout revalidation failed");
  if (!isDeepStrictEqual(routeMapProviderRows(positionsProjection), routeMapProviderRows(layoutSnapshot.rawPositions))) throw new Error("static network normalized layout projection mismatch");
  const layoutEvidence = { layoutAlgorithmVersion: layoutSnapshot.layoutAlgorithmVersion, topologySnapshotId: layoutSnapshot.topologySnapshotId, topologySnapshotSha256: layoutSnapshot.topologySnapshotSha256, topologySnapshotIdentity: layoutSnapshot.topologySnapshotIdentity, lineOrderSha256: layoutSnapshot.lineOrderSha256, aliasLedgerVersion: layoutSnapshot.aliasLedgerVersion, aliasLedgerSha256: layoutSnapshot.aliasLedgerSha256, rawPositionsSha256: layoutSnapshot.rawPositionsSha256, layoutPositionsSha256: layoutSnapshot.layoutPositionsSha256, layoutTracksSha256: layoutSnapshot.layoutTracksSha256, semanticInputSha256: layoutSnapshot.semanticInputSha256, semanticOutputSha256: layoutSnapshot.semanticOutputSha256, outputSchemaSha256: layoutSnapshot.outputSchemaSha256, layoutArtifactSha256: sha(canonicalBytes(layoutSnapshot)) };
  const routeObservation = normalizedObservation({ sourceId: TARGETS[0], snapshotId: positionsId, capturedAt, rawSha256: collection.positions.rawSha256, projection: positionsProjection, schemaFingerprint: collection.positions.providerSchemaFingerprint, migration: replacement, layoutEvidence, routeMapLayoutArtifact: layoutSnapshot });
  const molitObservation = normalizedObservation({ sourceId: TARGETS[1], snapshotId: snapshotId(TARGETS[1], capturedAt), capturedAt, rawSha256: collection.molit.rawSha256, projection: molitProjection, schemaFingerprint: molitMigration.fullProjectionSchemaFingerprint, migration: molitMigration });
  return [{ sourceId: TARGETS[0], rawBytes: collection.positions.rawBytes, extension: "json", replaced, replacement, sourceUpdatedAt: `${basisDate}T00:00:00.000Z`, layoutEvidence, observation: routeObservation }, { sourceId: TARGETS[1], rawBytes: collection.molit.rawBytes, extension: "csv", previous: molitPrevious, governanceBinding: governanceBinding(molitPrevious), observation: molitObservation }];
}
function snapshotFromDraft(draft, receipt) {
  const type = RECEIPT_TYPES[draft.sourceId]; const date = draft.observation.value.capturedAt.slice(0, 10).replaceAll("-", "");
  const objectKey = `source-raw/${draft.sourceId}/${date}/${draft.observation.value.rawSha256}.${type.extension}`;
  if (!receipt || receipt.schemaVersion !== 1 || receipt.artifactKind !== "static-network-source-raw-object-receipt"
    || receipt.sourceId !== draft.sourceId || receipt.snapshotId !== draft.observation.value.snapshotId || receipt.capturedAt !== draft.observation.value.capturedAt
    || receipt.rawObjectSha256 !== draft.observation.value.rawSha256 || receipt.rawObjectUri !== `oci://axvym6vk8g7i/easysubway-datapacks/${objectKey}`
    || receipt.ociNamespace !== "axvym6vk8g7i" || receipt.bucket !== "easysubway-datapacks" || receipt.objectKey !== objectKey
    || receipt.contentType !== type.contentType || receipt.byteSize !== draft.rawBytes.length || !Number.isFinite(Date.parse(receipt.storedAt))
    || !Number.isFinite(Date.parse(receipt.rawRetentionExpiresAt)) || Date.parse(receipt.rawRetentionExpiresAt) <= Date.parse(receipt.storedAt)) throw new Error("static network OCI receipt binding is invalid");
  const evidence = draft.observation.value;
  if (draft.sourceId === TARGETS[0]) {
    const snapshot = { schemaVersion: 1, artifactKind: "official-source-snapshot", snapshotId: evidence.snapshotId, sourceId: draft.sourceId, provider: "공공데이터포털", retrievedAt: evidence.capturedAt, sourceUpdatedAt: draft.sourceUpdatedAt, rowCount: evidence.rowCount, coverageCount: evidence.rowCount, rawSha256: evidence.rawSha256, rawObjectUri: receipt.rawObjectUri, contentSha256: evidence.contentSha256, redactedRequestFingerprint: sha(JSON.stringify({ method: "GET", url: "https://api.odcloud.kr/api/15099316/v1/uddi:bc51de47-d3ea-4aa1-8ac2-d70f2b5e701e", page: 1, perPage: 1000, returnType: "JSON" })), schemaFingerprint: evidence.schemaFingerprint, snapshotStatus: "LOCKED", schemaStatus: "PASS", licenseStatus: "PASS", fetchStatus: "SUCCESS", redistributionAllowed: true, credentialRedacted: true, previousSnapshotId: null, diffSummary: null, providerRecordHashes: evidence.providerRecordHashes, normalizedObservationSha256: sha(draft.observation.bytes), projectionMigration: evidence.migration, routeMapLayoutEvidence: draft.layoutEvidence, routeMapLayoutArtifact: draft.observation.value.routeMapLayoutArtifact, rawRetentionExpiresAt: receipt.rawRetentionExpiresAt, rawReceipt: receipt };
    return snapshot;
  }
  const snapshot = { ...structuredClone(draft.previous), ...draft.governanceBinding, snapshotId: evidence.snapshotId, retrievedAt: evidence.capturedAt, sourceUpdatedAt: evidence.capturedAt, rowCount: evidence.rowCount, coverageCount: evidence.rowCount, rawSha256: evidence.rawSha256, rawObjectUri: receipt.rawObjectUri, contentSha256: evidence.contentSha256, schemaFingerprint: evidence.schemaFingerprint, providerRecordHashes: evidence.providerRecordHashes, normalizedObservationSha256: sha(draft.observation.bytes), projectionMigration: evidence.migration, rawRetentionExpiresAt: receipt.rawRetentionExpiresAt, previousSnapshotId: draft.previous.snapshotId, rawReceipt: receipt };
  snapshot.diffSummary = buildSnapshotDiff(draft.previous, snapshot); return snapshot;
}
async function createExclusive(file, bytes) { const parent = path.dirname(file); const stat = await lstat(parent); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("static network operation parent is unsafe"); const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await directory.sync(); } finally { await directory.close(); } }
async function admittedTopology(root, inventoryBytes, now) {
  let inventory; try { inventory = JSON.parse(inventoryBytes); } catch { throw new Error("static network source inventory is invalid"); }
  const admission = inventory?.sources?.find(({ id }) => id === TARGETS[0])?.routeMapAdmissionEvidence?.currentTopologyAdmission;
  if (!admission || admission.status !== "ADMITTED" || admission.artifactKind !== "capital-route-map-current-topology-admission" || typeof admission.topologySnapshotId !== "string" || !SHA.test(admission.topologyContentSha256 ?? "")) throw new Error("static network topology admission is invalid");
  const relative = `tools/datapack/sources/${admission.topologySnapshotId}.json`; const bytes = await readStaticNetworkRegularFile(root, relative, "static network topology"); let snapshot; try { snapshot = JSON.parse(bytes); } catch { throw new Error("static network topology artifact is invalid"); }
  if (snapshot?.artifactKind !== "capital-route-topology-snapshot" || snapshot.sourceId !== "capital-route-topology" || snapshot.official !== true || snapshot.fixture !== false || snapshot.contentSha256 !== admission.topologyContentSha256) throw new Error("static network topology identity is invalid");
  assertCurrentTopologyAdmissionFreshness(admission, snapshot, now);
  return { bytes, snapshotId: admission.topologySnapshotId };
}

export async function runCurrentStaticNetworkSuccessors({ repositoryRoot = ROOT, operationRoot, assertExactMain = defaultExactMain, collectImpl = collectCurrentStaticNetworkSuccessors, publishImpl = publishStaticNetworkSourceRaw, registerImpl = registerCurrentStaticNetworkSuccessors, now = new Date() } = {}) {
  const root = await regularRoot(repositoryRoot, "repository root"); const operation = await regularRoot(operationRoot, "operation root"); const expectedMainSha = await assertExactMain(root);
  if (operation === root || operation.startsWith(`${root}${path.sep}`)) throw new Error("static network operation root must be outside the repository");
  const [ledger, inventoryBytes] = await Promise.all([readFile(path.join(root, "tools/datapack/release/source-snapshots.json"), "utf8").then(JSON.parse), readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8")]);
  const collection = await collectImpl({ sourceSnapshots: ledger, observedAt: now.toISOString() });
  const positions = projectPositions(collection?.positions?.rawBytes, collection?.observedAt);
  const molit = projectMolit(collection?.molit?.rawBytes);
  if (!isDeepStrictEqual(positions, collection?.positions?.records) || !isDeepStrictEqual(molit, collection?.molit?.records)) throw new Error("static network raw projection revalidation failed");
  const topology = await admittedTopology(root, inventoryBytes, now);
  const layoutSnapshot = buildSeoulRouteMapPositions({ records: positions, topologySnapshotBytes: topology.bytes, topologySnapshotId: topology.snapshotId, rawSha256: collection.positions.rawSha256, now });
  const drafts = buildDrafts(collection, layoutSnapshot);
  for (const draft of drafts) await createExclusive(path.join(operation, RECEIPT_TYPES[draft.sourceId].rawRelativePath), draft.rawBytes);
  const receipts = []; for (const draft of drafts) receipts.push(await publishImpl({ repositoryRoot: root, expectedMainSha, operationRoot: operation, sourceId: draft.sourceId, snapshotId: draft.observation.value.snapshotId, capturedAt: draft.observation.value.capturedAt, rawRelativePath: RECEIPT_TYPES[draft.sourceId].rawRelativePath, now }));
  const observations = drafts.map((draft, index) => ({ snapshot: snapshotFromDraft(draft, receipts[index]), receipt: receipts[index], bytes: draft.observation.bytes, rawBytes: draft.rawBytes }));
  await createExclusive(path.join(operation, "static-network-successors-receipt.json"), canonicalBytes({ sourceIds: TARGETS, receipts, normalizedObservationSha256: observations.map(({ bytes }) => sha(bytes)) }));
  if (await assertExactMain(root) !== expectedMainSha) throw new Error("static network repository changed before registration");
  return registerImpl({ repositoryRoot: root, observations, now });
}

// Input-only successor path. Collection and OCI publication are deliberately
// outside this transition so a supplied receipt cannot be substituted.
export async function runPublicStaticNetworkV2Transition({ repositoryRoot = ROOT, positionRawBytes, molitRawBytes, positionReceipt, molitReceipt, capturedAt, assertExactMain = defaultExactMain, produceImpl = buildPublicStaticNetworkV2Observations, registerImpl = registerPublicStaticNetworkV2Successors } = {}) {
  const root = await regularRoot(repositoryRoot, "repository root");
  const expectedMainSha = await assertExactMain(root);
  const inventoryBytes = await readFile(path.join(root, "tools/datapack/source-inventory.json"));
  let sourceInventory; try { sourceInventory = JSON.parse(inventoryBytes); } catch { throw new Error("public v2 source inventory is invalid"); }
  const topologyId = sourceInventory?.sources?.find(({ id }) => id === TARGETS[0])?.routeMapAdmissionEvidence?.currentTopologyAdmission?.topologySnapshotId;
  if (typeof topologyId !== "string" || topologyId === "") throw new Error("public v2 topology admission is invalid");
  const admittedTopologyBytes = await readStaticNetworkRegularFile(root, `tools/datapack/sources/${topologyId}.json`, "public v2 topology");
  const producerOutput = produceImpl({ positionRawBytes, molitRawBytes, positionReceipt, molitReceipt, capturedAt, sourceInventory, admittedTopologyBytes, admittedTopologyId: topologyId });
  if (await assertExactMain(root) !== expectedMainSha) throw new Error("public v2 repository changed before registration");
  return registerImpl({ repositoryRoot: root, producerOutput, rawBytesBySource: { [TARGETS[0]]: Buffer.from(positionRawBytes), [TARGETS[1]]: Buffer.from(molitRawBytes) }, now: new Date(capturedAt) });
}

export async function runRetiredCurrentStaticNetworkSuccessorsCli() {
  throw new Error("STATIC_NETWORK_SUCCESSORS_HISTORICAL_ONLY_RETIRED: use run-public-static-network-v2-operation.mjs");
}
async function main() { await runRetiredCurrentStaticNetworkSuccessorsCli(); }
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
