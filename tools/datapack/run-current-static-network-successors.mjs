#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { collectCurrentStaticNetworkSuccessors } from "./collect-current-static-network-successors.mjs";
import { projectSeoulMetroConsumedFields } from "./lib/seoulmetro-line-data-parser.mjs";
import { publishStaticNetworkSourceRaw } from "./publish-static-network-source-raw.mjs";
import { registerCurrentStaticNetworkSuccessors } from "./register-current-static-network-successors.mjs";
import { buildSnapshotDiff } from "./source-snapshot-policy.mjs";
import { approvedLegacyGovernanceBinding } from "./legacy-source-governance.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TARGETS = Object.freeze(["seoulmetro-cyberstation-route-map", "molit-urban-rail-full-route"]);
const SHA = /^[a-f0-9]{64}$/u;
const MOLIT_FIELDS = Object.freeze(["region_code", "region_name", "operator_name", "line_name", "station_sequence", "station_name"]);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const canonicalBytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const RECEIPT_TYPES = Object.freeze({
  "seoulmetro-cyberstation-route-map": { extension: "js", contentType: "application/javascript" },
  "molit-urban-rail-full-route": { extension: "csv", contentType: "text/csv; charset=euc-kr" },
});

async function regularRoot(value, label) { const initial = await lstat(value); if (!initial.isDirectory() || initial.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink directory`); const resolved = await realpath(value); const stat = await lstat(resolved); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink directory`); return resolved; }
async function defaultExactMain(repositoryRoot) { const { execFile } = await import("node:child_process"); const { promisify } = await import("node:util"); const run = promisify(execFile); const [{ stdout: head }, { stdout: originMain }, { stdout: status }] = await Promise.all([run("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot }), run("git", ["rev-parse", "origin/main"], { cwd: repositoryRoot }), run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repositoryRoot })]); if (status !== "" || head.trim() !== originMain.trim()) throw new Error("static network repository must be exact clean main"); return head.trim(); }
function snapshotId(sourceId, capturedAt) { return `${sourceId}-current-${capturedAt.replaceAll(/[-:.]/gu, "").replace("Z", "Z")}`; }
function fingerprint(records) { return sha(JSON.stringify(Object.keys(records[0] ?? {}).sort())); }
function requireCapture(value) { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) throw new Error("static network observation timestamp is invalid"); return value; }
function requirePrevious(previous, sourceId) { if (!previous || previous.sourceId !== sourceId || !SHA.test(previous.rawSha256 ?? "") || !SHA.test(previous.schemaFingerprint ?? "") || !SHA.test(previous.redactedRequestFingerprint ?? "") || typeof previous.snapshotId !== "string") throw new Error("static network predecessor identity is invalid"); return previous; }
function governanceBinding(previous) { const binding = previous.governancePolicyVersion == null && previous.governancePolicySha256 == null ? approvedLegacyGovernanceBinding(previous) : { governancePolicyVersion: previous.governancePolicyVersion, governancePolicySha256: previous.governancePolicySha256 }; if (typeof binding?.governancePolicyVersion !== "string" || !SHA.test(binding.governancePolicySha256 ?? "")) throw new Error("static network predecessor governance binding is invalid"); return binding; }
function projectionRecordHashes(sourceId, projection) { return sourceId === TARGETS[0] ? projection.flatMap((line) => line.stations.map((station) => sha(JSON.stringify({ lineKey: line.lineKey, label: line.label, color: line.color, station })))) : projection.map((record) => sha(JSON.stringify(record))); }
function normalizedObservation({ sourceId, snapshotId: id, capturedAt, rawSha256, projection, schemaFingerprint = fingerprint(projection), migration = null }) { const value = { schemaVersion: 1, artifactKind: "static-network-successor-observation", sourceId, snapshotId: id, capturedAt, rawSha256, contentSha256: sha(canonicalBytes(projection)), schemaFingerprint, rowCount: sourceId === TARGETS[0] ? projection.reduce((count, line) => count + line.stations.length, 0) : projection.length, providerRecordHashes: projectionRecordHashes(sourceId, projection), normalizedProjection: projection, migration }; return { value, bytes: canonicalBytes(value) }; }
function buildDrafts(collection, baselineMolitBytes) {
  const capturedAt = requireCapture(collection?.observedAt);
  if (!collection?.routeMap || !collection?.molit || collection.routeMap.sourceId !== TARGETS[0] || collection.molit.sourceId !== TARGETS[1] || !Buffer.isBuffer(collection.routeMap.rawBytes) || !Buffer.isBuffer(collection.molit.rawBytes)) throw new Error("static network operation source set is invalid");
  const routePrevious = requirePrevious(collection.routeMap.previous, TARGETS[0]); const molitPrevious = requirePrevious(collection.molit.previous, TARGETS[1]);
  if (sha(collection.routeMap.rawBytes) !== collection.routeMap.rawSha256) throw new Error("static network route raw identity is invalid");
  const routeProjection = projectSeoulMetroConsumedFields(collection.routeMap.rawBytes.toString("utf8")); const routeBytes = canonicalBytes(routeProjection); const migration = collection.routeMap.migration;
  const routeId = snapshotId(TARGETS[0], capturedAt);
  if (!migration || migration.sourceId !== TARGETS[0] || migration.newSnapshotId !== routeId || migration.legacySnapshotId !== routePrevious.snapshotId || migration.legacyRawSha256 !== routePrevious.rawSha256 || migration.legacySchemaFingerprint !== routePrevious.schemaFingerprint || migration.fullProjectionSha256 !== sha(routeBytes) || migration.fullProjectionSchemaFingerprint !== sha(JSON.stringify(["lineKey", "label", "color", "stations", "index", "code", "name", "coordinates", "marker", "labelPosition", "direction", "moveTo"])) || migration.fullProjectionRowCount !== routeProjection.reduce((count, line) => count + line.stations.length, 0)) throw new Error("static network route projection migration mismatch");
  const molitProjection = collection.molit.records; const molitHashes = Array.isArray(molitProjection) ? projectionRecordHashes(TARGETS[1], molitProjection) : []; const molitMigration = collection.molit.migration;
  if (!Array.isArray(molitProjection) || sha(collection.molit.rawBytes) !== collection.molit.rawSha256
    || JSON.stringify(Object.keys(molitProjection[0] ?? {})) !== JSON.stringify(MOLIT_FIELDS)
    || !molitMigration || molitMigration.sourceId !== TARGETS[1] || molitMigration.migrationKind !== "LEGACY_SAMPLE_TO_FULL_CONSUMED_FIELDS"
    || molitMigration.legacySnapshotId !== molitPrevious.snapshotId || molitMigration.legacyRawSha256 !== molitPrevious.rawSha256
    || molitMigration.legacySchemaFingerprint !== molitPrevious.schemaFingerprint || JSON.stringify(molitMigration.legacyProviderRecordHashes) !== JSON.stringify(molitPrevious.providerRecordHashes)
    || molitMigration.retainedBaselineRawSha256 !== sha(baselineMolitBytes) || molitMigration.fullProjectionSha256 !== sha(canonicalBytes(molitProjection))
    || molitMigration.fullProjectionSchemaFingerprint !== sha(JSON.stringify(MOLIT_FIELDS)) || molitMigration.fullProjectionRowCount !== molitProjection.length
    || molitMigration.newSnapshotId !== snapshotId(TARGETS[1], capturedAt) || molitHashes.length !== molitProjection.length) throw new Error("static network MOLIT projection identity is invalid");
  const routeObservation = normalizedObservation({ sourceId: TARGETS[0], snapshotId: routeId, capturedAt, rawSha256: collection.routeMap.rawSha256, projection: routeProjection, schemaFingerprint: migration.fullProjectionSchemaFingerprint, migration });
  const molitObservation = normalizedObservation({ sourceId: TARGETS[1], snapshotId: snapshotId(TARGETS[1], capturedAt), capturedAt, rawSha256: collection.molit.rawSha256, projection: molitProjection, schemaFingerprint: molitMigration.fullProjectionSchemaFingerprint, migration: molitMigration });
  return [{ sourceId: TARGETS[0], rawBytes: collection.routeMap.rawBytes, extension: "js", previous: routePrevious, governanceBinding: governanceBinding(routePrevious), observation: routeObservation }, { sourceId: TARGETS[1], rawBytes: collection.molit.rawBytes, extension: "csv", previous: molitPrevious, governanceBinding: governanceBinding(molitPrevious), observation: molitObservation }];
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
  const evidence = draft.observation.value; const snapshot = { ...structuredClone(draft.previous), ...draft.governanceBinding, snapshotId: evidence.snapshotId, retrievedAt: evidence.capturedAt, sourceUpdatedAt: evidence.capturedAt, rowCount: evidence.rowCount, coverageCount: evidence.rowCount, rawSha256: evidence.rawSha256, rawObjectUri: receipt.rawObjectUri, contentSha256: evidence.contentSha256, schemaFingerprint: evidence.schemaFingerprint, providerRecordHashes: evidence.providerRecordHashes, normalizedObservationSha256: sha(draft.observation.bytes), projectionMigration: evidence.migration, rawRetentionExpiresAt: receipt.rawRetentionExpiresAt, previousSnapshotId: draft.previous.snapshotId, rawReceipt: receipt };
  snapshot.diffSummary = buildSnapshotDiff(draft.previous, snapshot); return snapshot;
}
async function createExclusive(file, bytes) { const parent = path.dirname(file); const stat = await lstat(parent); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("static network operation parent is unsafe"); const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await directory.sync(); } finally { await directory.close(); } }

export async function runCurrentStaticNetworkSuccessors({ repositoryRoot = ROOT, operationRoot, assertExactMain = defaultExactMain, collectImpl = collectCurrentStaticNetworkSuccessors, publishImpl = publishStaticNetworkSourceRaw, registerImpl = registerCurrentStaticNetworkSuccessors, now = new Date() } = {}) {
  const root = await regularRoot(repositoryRoot, "repository root"); const operation = await regularRoot(operationRoot, "operation root"); const expectedMainSha = await assertExactMain(root);
  if (operation === root || operation.startsWith(`${root}${path.sep}`)) throw new Error("static network operation root must be outside the repository");
  const [ledger, baseline, molitBaseline] = await Promise.all([readFile(path.join(root, "tools/datapack/release/source-snapshots.json"), "utf8").then(JSON.parse), readFile(path.join(root, "tools/datapack/sources/seoulmetro-cyberstation-line-data-20260623.js")), readFile(path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv"))]);
  const collection = await collectImpl({ sourceSnapshots: ledger, baselineRouteMapBytes: baseline, baselineMolitBytes: molitBaseline, observedAt: now.toISOString() });
  const drafts = buildDrafts(collection, molitBaseline);
  for (const draft of drafts) await createExclusive(path.join(operation, `raw.${draft.extension}`), draft.rawBytes);
  const receipts = []; for (const draft of drafts) receipts.push(await publishImpl({ repositoryRoot: root, expectedMainSha, operationRoot: operation, sourceId: draft.sourceId, snapshotId: draft.observation.value.snapshotId, capturedAt: draft.observation.value.capturedAt, rawRelativePath: `raw.${draft.extension}`, now }));
  const observations = drafts.map((draft, index) => ({ snapshot: snapshotFromDraft(draft, receipts[index]), receipt: receipts[index], bytes: draft.observation.bytes }));
  await createExclusive(path.join(operation, "static-network-successors-receipt.json"), canonicalBytes({ sourceIds: TARGETS, receipts, normalizedObservationSha256: observations.map(({ bytes }) => sha(bytes)) }));
  return registerImpl({ repositoryRoot: root, observations, now });
}

async function main(argv) { if (argv.length !== 1 || !path.isAbsolute(argv[0])) throw new Error("static network runner requires an absolute operation root"); const result = await runCurrentStaticNetworkSuccessors({ operationRoot: argv[0] }); process.stdout.write(`${JSON.stringify(result)}\n`); }
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
