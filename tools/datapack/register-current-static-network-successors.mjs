#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, link, open, rename, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { deriveReleaseProjection } from "./rebind-current-candidate-source-snapshots.mjs";
import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";
import { deriveRawRetentionExpiresAt } from "./source-governance-policy.mjs";
import { validateLineage } from "./source-snapshot-policy.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TARGETS = Object.freeze(["seoulmetro-cyberstation-route-map", "molit-urban-rail-full-route"]);
const CANDIDATE_SOURCE_IDS = Object.freeze(["seoulmetro-cyberstation-route-map", "kric-subway-timetable", "seoul-metro-accessibility", "kric-station-convenience-standard", "molit-urban-rail-full-route", "seoulmetro-station-line-info", "seoul-metro-transfer-distance-duration"]);
const FIXED = Object.freeze(["tools/datapack/source-inventory.json", "tools/datapack/release/source-snapshots.json", "tools/datapack/release/candidate-build-spec.json", "tools/datapack/release/release-request.json", "tools/datapack/release/hash-evidence.json"]);
const INPUTS = Object.freeze([...FIXED, "tools/datapack/source-governance-policy.json", "release/product-gates/datapack-freshness-sla.json", "tools/datapack/sources/seoulmetro-cyberstation-line-data-20260623.js", "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv"]);
const RECEIPT_TYPES = Object.freeze({
  "seoulmetro-cyberstation-route-map": { extension: "js", contentType: "application/javascript" },
  "molit-urban-rail-full-route": { extension: "csv", contentType: "text/csv; charset=euc-kr" },
});
const JOURNAL = "tools/datapack/.static-network-successors-transaction.json";
const LOCK = "tools/datapack/.static-network-successors.lock";
const SHA = /^[a-f0-9]{64}$/u;
const MOLIT_FIELDS = Object.freeze(["region_code", "region_name", "operator_name", "line_name", "station_sequence", "station_name"]);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function parse(bytes, label) { try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} is invalid JSON`); } }
function target(root, relative) {
  if (typeof relative !== "string" || path.isAbsolute(relative)) throw new Error("static network path is invalid");
  const value = path.resolve(root, relative);
  if (!value.startsWith(`${root}${path.sep}`)) throw new Error("static network path escapes repository");
  return value;
}
async function regularDirectory(directory, label) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular directory`);
}
async function bytes(file, label, { absent = false } = {}) {
  await regularDirectory(path.dirname(file), `${label} parent`);
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const before = await handle.stat(); if (!before.isFile()) throw new Error(`${label} must be a regular file`); const value = await handle.readFile(); const after = await handle.stat(); if (before.ino !== after.ino || before.size !== after.size || value.length !== after.size) throw new Error(`${label} changed during read`); return value; }
    finally { await handle.close(); }
  } catch (error) { if (absent && error?.code === "ENOENT") return null; throw error; }
}
async function syncParent(file) { const handle = await open(path.dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await handle.sync(); } finally { await handle.close(); } }
function outputAllowlist(outputs) {
  if (!Array.isArray(outputs) || outputs.length !== 7) throw new Error("static network registration must stage exactly seven outputs");
  const snapshots = outputs.slice(0, 2).map(({ relative }) => relative);
  const inputs = outputs[0]?.inputs;
  if (!snapshots.every((relative, index) => relative === `tools/datapack/sources/${TARGETS[index]}-current-${snapshotStamp(relative)}.json` && /^20\d{6}T\d{9}Z$/u.test(snapshotStamp(relative)))
    || JSON.stringify(outputs.slice(2).map(({ relative }) => relative)) !== JSON.stringify(FIXED)
    || outputs.slice(0, 2).some(({ prestateBytes }) => prestateBytes !== null)
    || outputs.slice(2).some(({ prestateBytes }) => !Buffer.isBuffer(prestateBytes))
    || outputs.some(({ bytes: value }) => !Buffer.isBuffer(value))
    || !Array.isArray(inputs) || JSON.stringify(inputs.map(({ relative }) => relative)) !== JSON.stringify(INPUTS)
    || inputs.some(({ bytes: value }) => !Buffer.isBuffer(value)) || outputs.some((output) => output.inputs !== inputs)) throw new Error("static network registration output allowlist mismatch");
}
function snapshotStamp(relative) { return relative.match(/-current-([0-9TZ]+)\.json$/u)?.[1] ?? ""; }
function validateJournal(journal) {
  if (!journal || typeof journal !== "object" || Array.isArray(journal)
    || JSON.stringify(Object.keys(journal).sort()) !== JSON.stringify(["records", "state"])
    || !["PREPARED", "COMMITTED"].includes(journal.state) || !Array.isArray(journal.records) || journal.records.length !== 7) throw new Error("static network recovery required");
  const names = journal.records.map(({ relative }) => relative);
  const first = names.slice(0, 2);
  if (new Set(names).size !== 7 || !first.every((relative, index) => new RegExp(`^tools/datapack/sources/${TARGETS[index]}-current-20\\d{6}T\\d{9}Z\\.json$`, "u").test(relative))
    || JSON.stringify(names.slice(2)) !== JSON.stringify(FIXED)) throw new Error("static network recovery required");
  for (const [index, record] of journal.records.entries()) {
    if (!record || typeof record !== "object" || Array.isArray(record)
      || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(["after", "afterSha256", "before", "beforeSha256", "relative"])
      || typeof record.after !== "string" || !SHA.test(record.afterSha256 ?? "")
      || (record.before == null) !== (record.beforeSha256 == null) || (record.beforeSha256 != null && !SHA.test(record.beforeSha256))) throw new Error("static network recovery required");
    const after = Buffer.from(record.after, "base64"); const before = record.before == null ? null : Buffer.from(record.before, "base64");
    if (after.toString("base64") !== record.after || sha(after) !== record.afterSha256 || (before != null && (before.toString("base64") !== record.before || sha(before) !== record.beforeSha256))
      || (index < 2 ? before !== null : before === null)) throw new Error("static network recovery required");
  }
}
function projectionRecordHashes(sourceId, projection) {
  return sourceId === TARGETS[0]
    ? projection.flatMap((line) => line.stations.map((station) => sha(JSON.stringify({ lineKey: line.lineKey, label: line.label, color: line.color, station }))))
    : projection.map((record) => sha(JSON.stringify(record)));
}
function assertTwoObservations(observations) {
  if (!Array.isArray(observations) || observations.length !== 2 || observations.some(({ snapshot }, index) => snapshot?.sourceId !== TARGETS[index])) throw new Error("static network observations must contain the exact two sources");
  for (const { snapshot, receipt, bytes: snapshotBytes } of observations) {
    const type = RECEIPT_TYPES[snapshot?.sourceId];
    const date = snapshot?.retrievedAt?.slice(0, 10).replaceAll("-", "");
    const objectKey = type && date ? `source-raw/${snapshot.sourceId}/${date}/${snapshot.rawSha256}.${type.extension}` : "";
    if (!Buffer.isBuffer(snapshotBytes) || !SHA.test(snapshot?.rawSha256 ?? "") || !SHA.test(receipt?.rawObjectSha256 ?? "")
      || snapshot.rawSha256 !== receipt.rawObjectSha256 || receipt.sourceId !== snapshot.sourceId || receipt.snapshotId !== snapshot.snapshotId
      || JSON.stringify(snapshot.rawReceipt) !== JSON.stringify(receipt) || snapshot.rawRetentionExpiresAt !== receipt.rawRetentionExpiresAt
      || receipt.schemaVersion !== 1 || receipt.artifactKind !== "static-network-source-raw-object-receipt"
      || receipt.capturedAt !== snapshot.retrievedAt || receipt.ociNamespace !== "axvym6vk8g7i" || receipt.bucket !== "easysubway-datapacks"
      || receipt.objectKey !== objectKey || receipt.contentType !== type?.contentType || !Number.isSafeInteger(receipt.byteSize) || receipt.byteSize < 1
      || receipt.rawObjectUri !== `oci://axvym6vk8g7i/easysubway-datapacks/${objectKey}` || receipt.rawObjectUri !== snapshot.rawObjectUri) {
      throw new Error("static network OCI receipt binding is invalid");
    }
    const observation = parse(snapshotBytes, "static network normalized observation");
    const projectionBytes = Buffer.from(`${JSON.stringify(observation?.normalizedProjection)}\n`);
    const providerRecordHashes = Array.isArray(observation?.normalizedProjection) ? projectionRecordHashes(snapshot.sourceId, observation.normalizedProjection) : [];
    const expectedSchema = snapshot.sourceId === TARGETS[0]
      ? sha(JSON.stringify(["lineKey", "label", "color", "stations", "index", "code", "name", "coordinates", "marker", "labelPosition", "direction", "moveTo"]))
      : sha(JSON.stringify(MOLIT_FIELDS));
    if (observation?.schemaVersion !== 1 || observation.artifactKind !== "static-network-successor-observation"
      || observation.sourceId !== snapshot.sourceId || observation.snapshotId !== snapshot.snapshotId
      || observation.capturedAt !== snapshot.retrievedAt || observation.rawSha256 !== snapshot.rawSha256
      || observation.contentSha256 !== snapshot.contentSha256 || observation.schemaFingerprint !== snapshot.schemaFingerprint
      || observation.rowCount !== snapshot.rowCount || !Array.isArray(observation.normalizedProjection)
      || observation.contentSha256 !== sha(projectionBytes) || observation.schemaFingerprint !== expectedSchema
      || JSON.stringify(observation.providerRecordHashes) !== JSON.stringify(providerRecordHashes)
      || JSON.stringify(snapshot.providerRecordHashes) !== JSON.stringify(providerRecordHashes) || providerRecordHashes.length !== snapshot.rowCount
      || snapshot.normalizedObservationSha256 !== sha(snapshotBytes)
      || snapshot.coverageCount !== snapshot.rowCount || snapshot.previousSnapshotId == null) {
      throw new Error("static network normalized observation binding is invalid");
    }
    if (!observation.migration || observation.migration.schemaVersion !== 1 || observation.migration.artifactKind !== "source-projection-migration-evidence" || observation.migration.migrationKind !== "LEGACY_SAMPLE_TO_FULL_CONSUMED_FIELDS" || observation.migration.sourceId !== snapshot.sourceId) throw new Error("static network migration contract is invalid");
    if (!isDeepStrictEqual(snapshot.projectionMigration, observation.migration)) throw new Error("static network snapshot migration binding is invalid");
    if (snapshot.sourceId === TARGETS[0] && (!observation.migration || observation.migration.fullProjectionSha256 !== snapshot.contentSha256 || observation.migration.fullProjectionSchemaFingerprint !== snapshot.schemaFingerprint || observation.migration.fullProjectionRowCount !== snapshot.rowCount || observation.migration.newSnapshotId !== snapshot.snapshotId)) throw new Error("static network route migration binding is invalid");
    if (snapshot.sourceId === TARGETS[1] && (!observation.migration || observation.migration.migrationKind !== "LEGACY_SAMPLE_TO_FULL_CONSUMED_FIELDS" || observation.migration.legacySnapshotId !== snapshot.previousSnapshotId || observation.migration.legacyRawSha256 == null || observation.migration.legacySchemaFingerprint == null || !Array.isArray(observation.migration.legacyProviderRecordHashes) || observation.migration.retainedBaselineRawSha256 == null || observation.migration.fullProjectionSha256 !== snapshot.contentSha256 || observation.migration.fullProjectionSchemaFingerprint !== snapshot.schemaFingerprint || observation.migration.fullProjectionRowCount !== snapshot.rowCount || observation.migration.newSnapshotId !== snapshot.snapshotId)) throw new Error("static network MOLIT migration binding is invalid");
  }
}
function selectedInLedgerOrder(ledger, ids) { if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.length !== CANDIDATE_SOURCE_IDS.length) throw new Error("static network selected snapshot set is invalid"); const selected = ledger.filter(({ snapshotId }) => ids.includes(snapshotId)); if (selected.length !== ids.length || ids.some((snapshotId) => ledger.filter((snapshot) => snapshot.snapshotId === snapshotId).length !== 1)) throw new Error("static network selected snapshot set is invalid"); return selected; }

export async function buildStaticNetworkSuccessorOutputs({ repositoryRoot = ROOT, observations, now = new Date() } = {}) {
  const root = path.resolve(repositoryRoot); await regularDirectory(root, "repository root"); assertTwoObservations(observations);
  const read = async (relative) => bytes(target(root, relative), relative);
  const [inventoryBytes, ledgerBytes, candidateBytes, requestBytes, hashBytes, governanceBytes, freshnessBytes, routeBaselineBytes, molitBaselineBytes] = await Promise.all([
    read(FIXED[0]), read(FIXED[1]), read(FIXED[2]), read(FIXED[3]), read(FIXED[4]),
    read("tools/datapack/source-governance-policy.json"), read("release/product-gates/datapack-freshness-sla.json"), read("tools/datapack/sources/seoulmetro-cyberstation-line-data-20260623.js"), read("tools/datapack/sources/molit-urban-rail-full-route-20251211.csv"),
  ]);
  const inputs = INPUTS.map((relative, index) => ({ relative, bytes: [inventoryBytes, ledgerBytes, candidateBytes, requestBytes, hashBytes, governanceBytes, freshnessBytes, routeBaselineBytes, molitBaselineBytes][index] }));
  const inventory = parse(inventoryBytes, "source inventory"); const ledger = parse(ledgerBytes, "source ledger");
  const candidate = parse(candidateBytes, "candidate build spec"); const request = parse(requestBytes, "release request"); const hashes = parse(hashBytes, "hash evidence");
  const governance = parse(governanceBytes, "source governance policy"); const freshness = parse(freshnessBytes, "freshness policy");
  if (JSON.stringify(candidate.sourceSnapshotIds?.length === 7 ? candidate.sourceSnapshots?.map(({ sourceId }) => sourceId) : []) !== JSON.stringify(CANDIDATE_SOURCE_IDS)
    || JSON.stringify(candidate.sourceSnapshotIds.map((snapshotId, index) => candidate.sourceSnapshots[index]?.snapshotId)) !== JSON.stringify(candidate.sourceSnapshotIds)) throw new Error("static network candidate must preserve exact ordered seven sources");
  const heads = validateLineage(ledger).headsBySource;
  const baselines = { [TARGETS[0]]: routeBaselineBytes, [TARGETS[1]]: molitBaselineBytes };
  const nextInventory = structuredClone(inventory); const nextLedger = [...ledger];
  for (const { snapshot } of observations) {
    if (snapshot.previousSnapshotId !== heads[snapshot.sourceId]) throw new Error("static network successor is not direct");
    const predecessors = ledger.filter(({ snapshotId }) => snapshotId === snapshot.previousSnapshotId); const migration = snapshot.projectionMigration;
    if (predecessors.length !== 1 || !migration || migration.legacySnapshotId !== predecessors[0].snapshotId || migration.legacyRawSha256 !== predecessors[0].rawSha256 || migration.legacySchemaFingerprint !== predecessors[0].schemaFingerprint || !isDeepStrictEqual(migration.legacyProviderRecordHashes, predecessors[0].providerRecordHashes) || migration.retainedBaselineRawSha256 !== sha(baselines[snapshot.sourceId])) throw new Error("static network migration predecessor binding is invalid");
    if (nextLedger.some(({ snapshotId }) => snapshotId === snapshot.snapshotId)) throw new Error("static network snapshot identity already exists");
    nextLedger.push(snapshot); const source = nextInventory.sources?.find(({ id }) => id === snapshot.sourceId);
    if (!source || source.admissionEvidence?.decision !== "APPROVED") throw new Error("static network source admission is invalid");
    const sourceClass = freshness.sourceClasses?.find(({ sourceIds }) => sourceIds?.includes(snapshot.sourceId));
    const retention = deriveRawRetentionExpiresAt({ policy: governance, sourceId: snapshot.sourceId, retrievedAt: snapshot.retrievedAt });
    if (!sourceClass || snapshot.rawReceipt?.rawRetentionExpiresAt !== retention || !Number.isFinite(Date.parse(snapshot.rawReceipt?.storedAt))
      || Date.parse(snapshot.rawReceipt.storedAt) > now.getTime() || Date.parse(retention) <= Date.parse(snapshot.rawReceipt.storedAt)) throw new Error("static network receipt retention binding is invalid");
    snapshot.freshnessExpiresAt = deriveFreshnessExpiresAt({ policy: freshness, sourceClassId: sourceClass.id, basisAt: snapshot[sourceClass.basisField], evaluationAt: now.toISOString() });
    snapshot.rawRetentionExpiresAt = retention;
    source.retrievedAt = snapshot.retrievedAt.slice(0, 10); source.observedDataUpdatedAt = snapshot.sourceUpdatedAt.slice(0, 10);
    source.admissionEvidence = { ...source.admissionEvidence, snapshotId: snapshot.snapshotId, rawSha256: snapshot.rawSha256, schemaFingerprint: snapshot.schemaFingerprint };
  }
  validateLineage(nextLedger);
  const nextCandidate = structuredClone(candidate); const nowMillis = now.getTime();
  for (const { snapshot } of observations) {
    const index = nextCandidate.sourceSnapshots.findIndex(({ sourceId }) => sourceId === snapshot.sourceId);
    if (index < 0 || nextCandidate.sourceSnapshotIds[index] !== snapshot.previousSnapshotId) throw new Error("static network candidate head drift");
    nextCandidate.sourceSnapshotIds[index] = snapshot.snapshotId;
    nextCandidate.sourceSnapshots[index] = deriveReleaseProjection({ snapshot, sourceInventory: nextInventory, governancePolicy: governance, governancePolicyBytes: governanceBytes, freshnessPolicy: freshness, nowMillis });
  }
  for (const projection of candidate.sourceSnapshots) {
    if (!TARGETS.includes(projection.sourceId) && JSON.stringify(nextCandidate.sourceSnapshots.find(({ sourceId }) => sourceId === projection.sourceId)) !== JSON.stringify(projection)) throw new Error("non-target candidate projection changed");
  }
  const selected = selectedInLedgerOrder(nextLedger, nextCandidate.sourceSnapshotIds); const setHash = sha(JSON.stringify(selected));
  const nextInventoryBytes = json(nextInventory); nextCandidate.sourceSnapshotSetHash = setHash; nextCandidate.sourceInventorySha256 = sha(JSON.stringify(nextInventory));
  nextCandidate.networkEdgeEvidence.sourceInventory.sha256 = sha(nextInventoryBytes);
  const nextCandidateBytes = json(nextCandidate); const nextRequest = { ...request, buildSpecSha256: sha(nextCandidateBytes), sourceSnapshotSetHash: setHash };
  const nextHashes = structuredClone(hashes); nextHashes.sourceSnapshotSetHash.value = setHash; nextHashes.sourceInventorySha256.value = nextCandidate.sourceInventorySha256;
  nextHashes.sourceSnapshots.order = `release snapshot 순서: ${selected.map(({ sourceId }) => sourceId).join(" → ")}`;
  nextHashes.perSourceEvidence = selected.map((snapshot) => ({ sourceId: snapshot.sourceId, snapshotId: snapshot.snapshotId, rawSha256: snapshot.rawSha256, adminReviewRecordHash: nextInventory.sources.find(({ id }) => id === snapshot.sourceId).admissionEvidence.adminReviewRecordHash, perSourceSnapshotSetHash: sha(JSON.stringify([snapshot])) }));
  const staged = await Promise.all(observations.map(async ({ snapshot, bytes: snapshotBytes }) => {
    const relative = `tools/datapack/sources/${snapshot.snapshotId}.json`; const previous = await bytes(target(root, relative), relative, { absent: true });
    if (previous != null) throw new Error("static network snapshot immutable collision"); return { relative, bytes: snapshotBytes, prestateBytes: null };
  }));
  return [...staged, { relative: FIXED[0], bytes: nextInventoryBytes, prestateBytes: inventoryBytes }, { relative: FIXED[1], bytes: json(nextLedger), prestateBytes: ledgerBytes }, { relative: FIXED[2], bytes: nextCandidateBytes, prestateBytes: candidateBytes }, { relative: FIXED[3], bytes: json(nextRequest), prestateBytes: requestBytes }, { relative: FIXED[4], bytes: json(nextHashes), prestateBytes: hashBytes }].map((output) => ({ ...output, inputs }));
}

async function expected(file, value) { const current = await bytes(file, "static network target", { absent: true }); if ((current == null) !== (value == null) || current?.equals(value) === false) throw new Error("static network registration preserves foreign replacement"); }
function displacedPath(file) { return path.join(path.dirname(file), `.${path.basename(file)}.static-network-successors.before`); }
function retiredPath(file) { return path.join(path.dirname(file), `.${path.basename(file)}.static-network-successors.retired`); }
async function restoreMovedFile(moved, file) {
  try { await link(moved, file); } catch (error) { if (error?.code === "EEXIST") return false; throw error; }
  await unlink(moved); await syncParent(file); return true;
}
async function removeExpected(file, value) {
  await expected(file, value); const moved = retiredPath(file);
  if (await bytes(moved, "static network retired target", { absent: true })) throw new Error("static network recovery required");
  await rename(file, moved);
  try {
    const displaced = await bytes(moved, "static network displaced target");
    if (!displaced.equals(value)) throw new Error("static network registration preserves foreign replacement");
    await unlink(moved); await syncParent(file);
  } catch (error) {
    await restoreMovedFile(moved, file).catch(() => {});
    throw error;
  }
}
async function discardExpected(file, value) { await expected(file, value); await unlink(file); await syncParent(file); }
async function write(file, value, before, { beforeExistingPublish = async () => {}, afterExistingPublish = async () => {} } = {}) {
  await regularDirectory(path.dirname(file), "static network target parent"); await expected(file, before); const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
    await expected(file, before);
    if (before === null) await link(temporary, file);
    else {
      const displaced = displacedPath(file);
      let keepDisplaced = true;
      if (await bytes(displaced, "static network displaced target", { absent: true })) throw new Error("static network recovery required");
      await rename(file, displaced);
      try {
        const current = await bytes(displaced, "static network displaced target");
        if (!current.equals(before)) throw new Error("static network registration preserves foreign replacement");
        await beforeExistingPublish({ file, before, value });
        await link(temporary, file);
        await syncParent(file); await expected(file, value);
        await afterExistingPublish({ file, before, value });
        await unlink(displaced); await syncParent(file); keepDisplaced = false;
      } catch (error) {
        if (keepDisplaced) await restoreMovedFile(displaced, file).catch(() => {});
        throw error;
      }
    }
    await syncParent(file); await expected(file, value);
  } finally { await unlink(temporary).catch(() => {}); }
}
async function lease(port = 0) {
  const server = createServer();
  await new Promise((resolve, reject) => { const fail = (error) => { server.off("listening", ready); reject(error); }; const ready = () => { server.off("error", fail); resolve(); }; server.once("error", fail); server.once("listening", ready); server.listen({ host: "127.0.0.1", port, exclusive: true }); });
  return server;
}
async function closeLease(server) { if (server?.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
function lockValue(server) { const address = server.address(); if (!address || typeof address === "string" || address.address !== "127.0.0.1" || !Number.isInteger(address.port) || address.port < 1) throw new Error("static network lock residue exists"); return json({ schemaVersion: 1, host: "127.0.0.1", port: address.port, pid: process.pid, token: randomUUID() }); }
function parseLock(value) { const lock = parse(value, "static network lock"); if (JSON.stringify(Object.keys(lock)) !== JSON.stringify(["schemaVersion", "host", "port", "pid", "token"]) || lock.schemaVersion !== 1 || lock.host !== "127.0.0.1" || !Number.isInteger(lock.port) || lock.port < 1 || lock.port > 65535 || !Number.isInteger(lock.pid) || lock.pid < 1 || !/^[a-f0-9-]{36}$/u.test(lock.token ?? "")) throw new Error("static network lock residue exists"); return lock; }
async function acquire(root, { afterStaleLockRead = async () => {} } = {}) {
  const file = target(root, LOCK);
  if (await bytes(displacedPath(file), "static network displaced lock", { absent: true }) || await bytes(retiredPath(file), "static network retired lock", { absent: true })) throw new Error("static network lock residue exists");
  let server = await lease(); let mine = lockValue(server);
  try { await write(file, mine, null); }
  catch (error) {
    await closeLease(server); server = null;
    if (!/preserves foreign replacement/u.test(error?.message ?? "")) throw error;
    const staleBytes = await bytes(file, "static network lock"); const stale = parseLock(staleBytes); await afterStaleLockRead();
    try { server = await lease(stale.port); } catch (leaseError) { throw new Error("static network lock residue exists", { cause: leaseError }); }
    mine = lockValue(server);
    try { await write(file, mine, staleBytes); } catch (reclaimError) { await closeLease(server); throw new Error("static network lock residue exists", { cause: reclaimError }); }
  }
  return async () => { try { await removeExpected(file, mine); } finally { await closeLease(server); } };
}
function journalOutputs(outputs) { return outputs.map(({ relative, bytes: after, prestateBytes: before }) => ({ relative, before: before?.toString("base64") ?? null, after: after.toString("base64"), beforeSha256: before == null ? null : sha(before), afterSha256: sha(after) })); }
function parsedJournal(value) { try { const journal = parse(value, "static network journal"); validateJournal(journal); return journal; } catch { throw new Error("static network recovery required"); } }
function sameJournalRecords(left, right) { return JSON.stringify(left.records) === JSON.stringify(right.records); }
async function recover(root, journal, journalBytes, journalFile = target(root, JOURNAL)) {
  validateJournal(journal);
  for (const record of journal.records) {
    const file = target(root, record.relative); const before = record.before == null ? null : Buffer.from(record.before, "base64"); const after = Buffer.from(record.after, "base64");
    if (sha(after) !== record.afterSha256 || (before != null && sha(before) !== record.beforeSha256)) throw new Error("static network recovery required");
    let current = await bytes(file, "static network recovery target", { absent: true }); const displaced = before == null ? null : displacedPath(file); const displacedBytes = displaced == null ? null : await bytes(displaced, "static network displaced target", { absent: true }); const retired = await bytes(retiredPath(file), "static network retired target", { absent: true });
    if (displacedBytes != null && !displacedBytes.equals(before)) {
      if (current == null) await restoreMovedFile(displaced, file).catch(() => {});
      throw new Error("static network registration preserves foreign replacement");
    }
    if (journal.state === "PREPARED") {
      if (retired != null) {
        if (!retired.equals(after) || current != null) throw new Error("static network registration preserves foreign replacement");
        if (before == null) { await discardExpected(retiredPath(file), after); continue; }
        if (displacedBytes?.equals(before)) { await restoreMovedFile(displaced, file); await discardExpected(retiredPath(file), after); continue; }
        throw new Error("static network recovery required");
      }
      if (current == null && displacedBytes?.equals(before)) { await restoreMovedFile(displaced, file); continue; }
      if (current?.equals(after) && displacedBytes?.equals(before)) { await removeExpected(file, after); await restoreMovedFile(displaced, file); continue; }
      if ((before == null && current == null) || (before != null && current?.equals(before))) {
        if (displacedBytes != null) await unlink(displaced);
        continue;
      }
      if (!current?.equals(after)) throw new Error("static network registration preserves foreign replacement");
      if (before == null) await removeExpected(file, after); else await write(file, before, after);
      continue;
    }
    if (current?.equals(after)) { if (displacedBytes != null) { await unlink(displaced); await syncParent(displaced); } continue; }
    if (current == null && displacedBytes?.equals(before)) { await restoreMovedFile(displaced, file); current = before; }
    if (!current?.equals(before)) throw new Error("static network registration preserves foreign replacement");
    await write(file, after, before);
  }
  const canonicalJournalFile = target(root, JOURNAL); const finalJournal = journalBytes ?? await bytes(journalFile, "static network journal");
  if (journalFile === canonicalJournalFile) await removeExpected(journalFile, finalJournal); else await discardExpected(journalFile, finalJournal);
}
async function recoverPending(root) {
  const journalFile = target(root, JOURNAL); const displaced = displacedPath(journalFile); const retired = retiredPath(journalFile); const cleanupResidue = retiredPath(displaced);
  const [canonicalBytes, displacedBytes, retiredBytes, residueBytes] = await Promise.all([
    bytes(journalFile, "static network journal", { absent: true }), bytes(displaced, "static network displaced journal", { absent: true }),
    bytes(retired, "static network retired journal", { absent: true }), bytes(cleanupResidue, "static network journal cleanup residue", { absent: true }),
  ]);
  if (canonicalBytes != null) {
    const canonical = parsedJournal(canonicalBytes);
    if (retiredBytes != null) throw new Error("static network recovery required");
    if (displacedBytes != null && residueBytes != null) throw new Error("static network recovery required");
    const predecessorBytes = displacedBytes ?? residueBytes;
    if (predecessorBytes == null) { await recover(root, canonical, canonicalBytes, journalFile); return; }
    const previous = parsedJournal(predecessorBytes);
    if (canonical.state !== "COMMITTED" || previous.state !== "PREPARED" || !sameJournalRecords(canonical, previous)) throw new Error("static network recovery required");
    // A PREPARED predecessor must disappear before COMMITTED recovery can remove
    // the canonical record: a crash between those steps must never resurrect rollback.
    if (displacedBytes != null) await removeExpected(displaced, displacedBytes); else await discardExpected(cleanupResidue, residueBytes);
    await recover(root, canonical, canonicalBytes, journalFile);
    return;
  }
  if (residueBytes != null || (displacedBytes != null && retiredBytes != null)) throw new Error("static network recovery required");
  if (displacedBytes != null) { await recover(root, parsedJournal(displacedBytes), displacedBytes, displaced); return; }
  if (retiredBytes != null) await recover(root, parsedJournal(retiredBytes), retiredBytes, retired);
}
async function commitUnlocked({ root, outputs, failAfter = null, beforeExistingPublish = async () => {}, afterExistingPublish = async () => {} }) {
  outputAllowlist(outputs); let journal; let journalBytes;
  try { for (const input of outputs[0].inputs) await expected(target(root, input.relative), input.bytes); for (const output of outputs) await expected(target(root, output.relative), output.prestateBytes); journal = { state: "PREPARED", records: journalOutputs(outputs) }; const journalFile = target(root, JOURNAL); journalBytes = json(journal); await write(journalFile, journalBytes, null, { beforeExistingPublish, afterExistingPublish }); for (const [index, output] of outputs.entries()) { await write(target(root, output.relative), output.bytes, output.prestateBytes, { beforeExistingPublish, afterExistingPublish }); if (index === failAfter) throw new Error("injected transaction failure"); } journal = { ...journal, state: "COMMITTED" }; journalBytes = json(journal); await write(journalFile, journalBytes, json({ state: "PREPARED", records: journal.records }), { beforeExistingPublish, afterExistingPublish }); await recover(root, journal, journalBytes); }
  catch (error) { if (journal) await recoverPending(root); throw error; }
}
export async function commitStaticNetworkSuccessorOutputs({ repositoryRoot = ROOT, outputs, failAfter = null, beforeExistingPublish = async () => {}, afterExistingPublish = async () => {}, afterStaleLockRead = async () => {} } = {}) {
  const root = path.resolve(repositoryRoot); await regularDirectory(root, "repository root"); const release = await acquire(root, { afterStaleLockRead });
  try { await recoverPending(root); await commitUnlocked({ root, outputs, failAfter, beforeExistingPublish, afterExistingPublish }); } finally { await release(); }
}
export async function registerCurrentStaticNetworkSuccessors(options = {}) {
  const root = path.resolve(options.repositoryRoot ?? ROOT); await regularDirectory(root, "repository root"); const release = await acquire(root, options);
  try { await recoverPending(root); const outputs = await buildStaticNetworkSuccessorOutputs({ ...options, repositoryRoot: root }); await commitUnlocked({ root, outputs }); return { outputs: outputs.map(({ relative }) => relative) }; } finally { await release(); }
}
