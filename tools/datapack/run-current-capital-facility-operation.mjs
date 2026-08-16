#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { buildCurrentCapitalFacilityCollectionPlan, canonicalCurrentCapitalFacilityCollectionPlanJson } from "./build-current-capital-facility-collection-plan.mjs";
import { collectKricStandardAccessibilityObservation, validateKricAccessibilityRawCollection, validateKricAccessibilitySnapshotIdentity, writeKricStandardAccessibilityObservation } from "./collect-kric-accessibility-snapshots.mjs";
import { publishKricAccessibilityRawArtifact } from "./publish-kric-accessibility-raw.mjs";
import { requireOciParBaseUrl } from "./lib/kric-raw-object-storage.mjs";
import { registerKricStandardAccessibilitySnapshot } from "./register-kric-standard-accessibility-snapshot.mjs";
import { rebindCandidateSourceSnapshots, rebindCurrentCandidateSourceSnapshots, readStableRegularFile } from "./rebind-current-candidate-source-snapshots.mjs";
import { buildCurrentCapitalFacilitySourceAdmission, canonicalCurrentCapitalFacilitySourceAdmissionJson } from "./build-current-capital-facility-source-admission.mjs";
import { validateLineage } from "./source-snapshot-policy.mjs";
import { deriveRawRetentionExpiresAt, validateSourceGovernancePolicy } from "./source-governance-policy.mjs";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";

const execFile = promisify(execFileCallback);
const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const INPUTS = Object.freeze({
  canonicalPackBytes: "tools/datapack/release/capital-production-canonical-pack.json",
  coverageTargetsBytes: "tools/datapack/nationwide-coverage-targets.json",
  providerCodeCatalogBytes: "tools/datapack/sources/kric-provider-code-catalog-20260228.json",
  routeRostersBytes: "tools/datapack/sources/kric-nationwide-route-rosters-20260730T203926676Z.json",
  sourceInventoryBytes: "tools/datapack/source-inventory.json",
});
const RELEASE_INPUTS = Object.freeze({
  candidate: "tools/datapack/release/candidate-build-spec.json",
  releaseRequest: "tools/datapack/release/release-request.json",
  inventory: "tools/datapack/source-inventory.json",
  snapshots: "tools/datapack/release/source-snapshots.json",
  governance: "tools/datapack/source-governance-policy.json",
  freshness: "release/product-gates/datapack-freshness-sla.json",
});
const ADMISSION = "tools/datapack/release/current-capital-facility-source-admission.json";
const JOURNAL = "journal.json";
const REGISTRAR_RESIDUES = Object.freeze(["tools/datapack/.kric-standard-registration-transaction.json", "tools/datapack/.kric-standard-registration.lock", "tools/datapack/.candidate-source-rebind.lock"]);
const CURRENT_SOURCE_IDS = Object.freeze(["seoulmetro-cyberstation-route-map", "kric-subway-timetable", "seoul-metro-accessibility", "kric-station-convenience-standard", "molit-urban-rail-full-route", "seoulmetro-station-line-info"]);
const JOURNAL_KEYS = new Set(["schemaVersion", "artifactKind", "operationId", "phase", "preparedAt", "expectedMainSha", "planSha256", "inputSha256", "completedStages", "collectionStartedAt", "snapshotId", "completedObservation", "collectionReconciledAt", "finalizeObservedAt", "reboundExpectedCandidateSha256", "finalizedAt"]);
const RAW_RECEIPT_KEYS = ["schemaVersion", "artifactKind", "sourceId", "snapshotId", "snapshotRawSha256", "capturedAt", "snapshotFileSha256", "rawObjectUri", "rawObjectSha256", "byteSize", "storedAt", "rawRetentionExpiresAt"];

function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function parse(bytes, label) { try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} is invalid JSON`); } }
function parseJournal(bytes) {
  const journal = parse(bytes, "operation journal");
  if (!journal || typeof journal !== "object" || Array.isArray(journal) || Object.keys(journal).some((key) => !JOURNAL_KEYS.has(key))) throw new Error("operation journal has unsupported keys");
  return journal;
}
function requireText(value, label) { if (typeof value !== "string" || value === "") throw new Error(`${label} is required`); return value; }
export async function syncWrite(target, value, { openImpl = open, renameImpl = rename, unlinkImpl = unlink } = {}) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const parent = path.dirname(target); const temporary = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`); let published = false;
  try {
    const handle = await openImpl(temporary, "wx", 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await renameImpl(temporary, target); published = true;
    const directory = await openImpl(parent, "r"); try { await directory.sync(); } finally { await directory.close(); }
  } finally { if (!published) await unlinkImpl(temporary).catch(() => {}); }
}
export async function durableCreateBytes(target, bytes, { openImpl = open, linkImpl = link, unlinkImpl = unlink } = {}) {
  const parent = path.dirname(target); const temporary = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`); let temporaryExists = true;
  try {
    const handle = await openImpl(temporary, "wx", 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await linkImpl(temporary, target); await unlinkImpl(temporary); temporaryExists = false;
    const directory = await openImpl(parent, "r"); try { await directory.sync(); } finally { await directory.close(); }
  } finally { if (temporaryExists) await unlinkImpl(temporary).catch(() => {}); }
}
async function regularBytes(target, label) {
  const stat = await lstat(target); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return readFile(target);
}
async function existingRegularBytes(target, label) {
  try { return await regularBytes(target, label); }
  catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
}
async function inputSnapshots(root) {
  return Object.fromEntries(await Promise.all(Object.entries(INPUTS).map(async ([key, relative]) => [key, await readStableRegularFile(path.join(root, relative), key)])));
}
function snapshotBytes(snapshots) { return Object.fromEntries(Object.entries(snapshots).map(([key, value]) => [key, value.bytes])); }
async function acquireCollectionClaim(operationRoot) {
  const lock = path.join(operationRoot, ".collection-claim");
  try { await mkdir(lock, { mode: 0o700 }); } catch (error) { if (error?.code === "EEXIST") throw new Error("collection is already in progress"); throw error; }
  return async () => { await rmdir(lock).catch(() => {}); };
}
async function assertPreparedInputs(root, journal) {
  const snapshots = await inputSnapshots(root); const expected = journal?.inputSha256;
  if (!expected || Object.keys(expected).length !== Object.keys(INPUTS).length || Object.entries(snapshots).some(([key, value]) => expected[key] !== hash(value.bytes))) throw new Error("prepared input identity mismatch");
  return snapshots;
}
async function assertNoRegistrarResidues(root) {
  await Promise.all(REGISTRAR_RESIDUES.map(async (relative) => {
    try { await lstat(path.join(root, relative)); throw new Error("registrar recovery residue exists"); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }));
}
async function assertExactMain(root, expectedMainSha, execFileImpl, allowedDirtyPaths) {
  const [{ stdout: head }, { stdout: originMain }, { stdout: status }] = await Promise.all([
    execFileImpl("git", ["rev-parse", "HEAD"], { cwd: root }), execFileImpl("git", ["rev-parse", "origin/main"], { cwd: root }), execFileImpl("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root }),
  ]);
  if (head.trim() !== expectedMainSha || originMain.trim() !== expectedMainSha) throw new Error("exact clean main preflight failed");
  if (status === "") return;
  if (!allowedDirtyPaths) throw new Error("exact clean main preflight failed");
  const paths = status.trimEnd().split("\n").map((line) => line.slice(3));
  if (paths.some((relative) => !allowedDirtyPaths.has(relative))) throw new Error("finalize worktree has unrelated changes");
}
async function assertExternalOperationRoot(repositoryRoot, operationRoot, { allowAbsent = false } = {}) {
  const root = path.resolve(repositoryRoot); const operation = path.resolve(operationRoot); const parent = path.dirname(operation);
  const directParent = await lstat(parent); if (!directParent.isDirectory() || directParent.isSymbolicLink()) throw new Error("operation root parent must be a regular directory");
  const [realRepository, realParent] = await Promise.all([realpath(root), realpath(parent)]);
  if (realParent === realRepository || realParent.startsWith(`${realRepository}${path.sep}`)) throw new Error("operation root must be external to repository");
  if (!allowAbsent) {
    const directOperation = await lstat(operation); if (!directOperation.isDirectory() || directOperation.isSymbolicLink()) throw new Error("operation root must be a regular directory");
    const realOperation = await realpath(operation); if (realOperation === realRepository || realOperation.startsWith(`${realRepository}${path.sep}`)) throw new Error("operation root must be external to repository");
  }
}
async function assertPlanBinding(operationRoot, journal) {
  if (!/^[0-9a-f]{64}$/.test(journal?.planSha256 ?? "")) throw new Error("operation plan hash is invalid");
  const bytes = await regularBytes(path.join(operationRoot, "plan.json"), "operation plan");
  if (hash(bytes) !== journal.planSha256) throw new Error("operation plan identity mismatch");
  return bytes;
}
async function validateReleasePreflight(root, planBytes, now) {
  const release = Object.fromEntries(await Promise.all(Object.entries(RELEASE_INPUTS).map(async ([key, relative]) => [key, await readStableRegularFile(path.join(root, relative), key)])));
  const candidate = parse(release.candidate.bytes, "candidate"); const request = parse(release.releaseRequest.bytes, "release request"); const inventory = parse(release.inventory.bytes, "source inventory"); const snapshots = parse(release.snapshots.bytes, "source snapshot ledger"); const governance = parse(release.governance.bytes, "source governance policy"); const freshness = parse(release.freshness.bytes, "freshness SLA");
  if (request?.buildSpecSha256 !== hash(release.candidate.bytes)) throw new Error("release request is not bound to candidate bytes");
  validateSourceGovernancePolicy({ policy: governance, inventory, freshnessPolicy: freshness });
  const heads = validateLineage(snapshots).headsBySource;
  if (!Array.isArray(candidate?.sourceSnapshotIds) || !Array.isArray(candidate?.sourceSnapshots) || candidate.sourceSnapshotIds.length !== candidate.sourceSnapshots.length || JSON.stringify(candidate.sourceSnapshots.map(({ sourceId }) => sourceId)) !== JSON.stringify(CURRENT_SOURCE_IDS)) throw new Error("candidate source ledger/freshness binding mismatch");
  for (const [index, snapshotId] of candidate.sourceSnapshotIds.entries()) {
    const ledger = snapshots.find((entry) => entry?.snapshotId === snapshotId); const projection = candidate.sourceSnapshots[index]; const source = inventory.sources?.find(({ id }) => id === ledger?.sourceId); const governanceSource = governance.sources?.find(({ sourceId }) => sourceId === ledger?.sourceId); const review = governanceSource?.licenseReview;
    let freshnessExpiresAt; let rawRetentionExpiresAt; let nextReviewAt;
    try { freshnessExpiresAt = requiredUtcInstant(ledger?.freshnessExpiresAt, "candidate freshnessExpiresAt"); rawRetentionExpiresAt = requiredUtcInstant(ledger?.rawRetentionExpiresAt, "candidate rawRetentionExpiresAt"); nextReviewAt = requiredUtcInstant(review?.nextReviewAt, "license nextReviewAt"); } catch { throw new Error("candidate source ledger/freshness binding mismatch"); }
    if (!ledger || projection?.sourceId !== ledger.sourceId || heads[ledger.sourceId] !== snapshotId || ledger.licenseStatus !== "PASS" || ledger.snapshotStatus !== "LOCKED" || ledger.credentialRedacted !== true || freshnessExpiresAt <= now.getTime() || rawRetentionExpiresAt <= now.getTime() || review?.status !== "APPROVED" || nextReviewAt <= now.getTime() || review.termsHash !== source?.admissionEvidence?.licenseEvidenceHash) throw new Error("candidate source ledger/freshness binding mismatch");
  }
  const source = inventory.sources?.find(({ id }) => id === "kric-station-convenience-standard"); const relativeSnapshot = source?.accessibilityAdmissionEvidence?.snapshotPath;
  if (typeof relativeSnapshot !== "string" || path.isAbsolute(relativeSnapshot) || path.resolve(root, relativeSnapshot) !== path.join(root, "tools/datapack/sources", `${source?.accessibilityAdmissionEvidence?.snapshotId}.json`)) throw new Error("KRIC release snapshot identity is invalid");
  const snapshot = await readStableRegularFile(path.join(root, relativeSnapshot), "KRIC release snapshot"); const snapshotValue = validateKricAccessibilitySnapshotIdentity(parse(snapshot.bytes, "KRIC release snapshot")); const ledger = snapshots.find((entry) => entry?.sourceId === snapshotValue.sourceId && entry.snapshotId === snapshotValue.snapshotId); const evidence = source.accessibilityAdmissionEvidence;
  if (!ledger || evidence.snapshotFileSha256 !== hash(snapshot.bytes) || evidence.rawSha256 !== snapshotValue.rawSha256 || evidence.contentSha256 !== snapshotValue.contentSha256 || evidence.schemaFingerprint !== snapshotValue.schemaFingerprint || ledger.rawReceipt?.snapshotId !== snapshotValue.snapshotId || ledger.rawReceipt?.snapshotRawSha256 !== snapshotValue.rawSha256 || ledger.contentSha256 !== snapshotValue.contentSha256 || ledger.schemaFingerprint !== snapshotValue.schemaFingerprint) throw new Error("KRIC source raw/ledger binding mismatch");
}
function summary(observation) { return { snapshotId: observation.snapshot.snapshotId, requestCount: observation.rawArtifact.requestCount, status: "COLLECTED" }; }
async function isRegisteredState({ root, snapshot, snapshotBytes, receipt, targetSnapshot }) {
  const targetBytes = await existingRegularBytes(targetSnapshot, "registered snapshot"); if (targetBytes == null || !targetBytes.equals(snapshotBytes)) return false;
  const [inventoryFile, snapshotsFile] = await Promise.all([readStableRegularFile(path.join(root, RELEASE_INPUTS.inventory), "source inventory"), readStableRegularFile(path.join(root, RELEASE_INPUTS.snapshots), "source snapshot ledger")]);
  const inventory = parse(inventoryFile.bytes, "source inventory"); const snapshots = parse(snapshotsFile.bytes, "source snapshot ledger"); const source = inventory.sources?.find(({ id }) => id === snapshot.sourceId); const evidence = source?.accessibilityAdmissionEvidence;
  const matches = snapshots.filter((entry) => entry?.snapshotId === snapshot.snapshotId && entry.sourceId === snapshot.sourceId); let heads;
  try { heads = validateLineage(snapshots).headsBySource; } catch { return false; }
  const ledger = matches[0]; const rawReceipt = ledger?.rawReceipt;
  const receiptKeys = ["sourceId", "snapshotId", "snapshotRawSha256", "snapshotFileSha256", "rawObjectSha256", "byteSize", "capturedAt", "storedAt"];
  return source?.requiredForProductionPack === true && source.productionUseAllowed === true && source.capabilities?.facility?.productionUseAllowed === true && source.license?.redistributionAllowed === true && source.admissionEvidence?.decision === "APPROVED" && evidence?.decision === "APPROVED" && evidence.productionUseAllowed === true && evidence.licenseEvidenceHash === source.admissionEvidence?.licenseEvidenceHash && evidence.snapshotId === snapshot.snapshotId && evidence.snapshotPath === `tools/datapack/sources/${snapshot.snapshotId}.json` && evidence.snapshotFileSha256 === hash(snapshotBytes) && evidence.rawSha256 === snapshot.rawSha256 && evidence.contentSha256 === snapshot.contentSha256 && evidence.schemaFingerprint === snapshot.schemaFingerprint && matches.length === 1 && heads[snapshot.sourceId] === snapshot.snapshotId && [ledger?.snapshotStatus, ledger?.fetchStatus, ledger?.schemaStatus, ledger?.licenseStatus].join("\0") === "LOCKED\0SUCCESS\0PASS\0PASS" && ledger.coverageCount === 213 && ledger.contentSha256 === snapshot.contentSha256 && ledger.schemaFingerprint === snapshot.schemaFingerprint && ledger.rawSha256 === rawReceipt?.rawObjectSha256 && receiptKeys.every((key) => receipt?.[key] === rawReceipt?.[key]) && rawReceipt?.sourceId === snapshot.sourceId && rawReceipt?.snapshotId === snapshot.snapshotId && rawReceipt?.snapshotRawSha256 === snapshot.rawSha256 && rawReceipt?.snapshotFileSha256 === hash(snapshotBytes) && rawReceipt?.capturedAt === snapshot.capturedAt;
}
async function readCompletedObservation(observationRoot) {
  const rootStat = await lstat(observationRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("stored observation root must be a regular directory");
  const manifestBytes = await regularBytes(path.join(observationRoot, "observation.json"), "observation manifest"); const manifest = parse(manifestBytes, "observation manifest");
  const keys = ["schemaVersion", "artifactKind", "sourceId", "capturedAt", "snapshotId", "snapshotRawSha256", "snapshotFile", "snapshotFileSha256", "rawArtifactFile", "rawObjectSha256", "rawObjectChecksumSha256", "rawObjectByteSize", "credentialRedacted"];
  if (Object.keys(manifest).length !== keys.length || keys.some((key) => !(key in manifest)) || manifest.schemaVersion !== 1 || manifest.artifactKind !== "kric-standard-accessibility-observation" || manifest.credentialRedacted !== true) throw new Error("stored observation is incomplete");
  const snapshotFile = `${manifest.snapshotId}.json`; const rawArtifactFile = `${manifest.snapshotId}.raw.json`;
  const expectedInventory = ["observation.json", rawArtifactFile, snapshotFile].sort();
  const actualInventory = (await readdir(observationRoot)).sort();
  if (typeof manifest.snapshotId !== "string" || manifest.snapshotId === "" || path.basename(manifest.snapshotId) !== manifest.snapshotId
    || manifest.snapshotFile !== snapshotFile || manifest.rawArtifactFile !== rawArtifactFile
    || JSON.stringify(actualInventory) !== JSON.stringify(expectedInventory)) throw new Error("stored observation inventory mismatch");
  const snapshotBytes = await regularBytes(path.join(observationRoot, manifest.snapshotFile), "collected snapshot"); const rawBytes = await regularBytes(path.join(observationRoot, manifest.rawArtifactFile), "collected raw artifact");
  const snapshot = validateKricAccessibilitySnapshotIdentity(parse(snapshotBytes, "collected snapshot")); const rawArtifact = validateKricAccessibilityRawCollection(parse(rawBytes, "collected raw artifact"), snapshot);
  if (manifest.sourceId !== snapshot.sourceId || manifest.snapshotId !== snapshot.snapshotId || manifest.capturedAt !== snapshot.capturedAt || manifest.snapshotRawSha256 !== snapshot.rawSha256 || manifest.snapshotFileSha256 !== hash(snapshotBytes) || manifest.rawObjectSha256 !== hash(rawBytes) || manifest.rawObjectChecksumSha256 !== createHash("sha256").update(rawBytes).digest("base64") || manifest.rawObjectByteSize !== rawBytes.length || rawArtifact.snapshotId !== snapshot.snapshotId) throw new Error("stored observation identity mismatch");
  return { manifest, manifestBytes, snapshot, snapshotBytes, rawArtifact, rawBytes };
}
async function assertClosedRawReceipt({ root, receipt, observation, now }) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
    || Object.keys(receipt).length !== RAW_RECEIPT_KEYS.length
    || RAW_RECEIPT_KEYS.some((key, index) => Object.keys(receipt)[index] !== key)) throw new Error("published receipt schema is invalid");
  const { snapshot, snapshotBytes, rawBytes } = observation;
  const objectKey = `source-raw/${snapshot.sourceId}/${snapshot.capturedAt.slice(0, 10).replaceAll("-", "")}/${hash(rawBytes)}.json`;
  const policy = parse((await readStableRegularFile(path.join(root, RELEASE_INPUTS.governance), "source governance policy")).bytes, "source governance policy");
  const expectedRetention = deriveRawRetentionExpiresAt({ policy, sourceId: snapshot.sourceId, retrievedAt: snapshot.capturedAt });
  let storedAt;
  try { storedAt = requiredUtcInstant(receipt.storedAt, "published receipt storedAt"); } catch { throw new Error("published receipt storedAt is invalid"); }
  if (receipt.schemaVersion !== 1 || receipt.artifactKind !== "kric-accessibility-raw-object-receipt"
    || receipt.sourceId !== snapshot.sourceId || receipt.snapshotId !== snapshot.snapshotId
    || receipt.snapshotRawSha256 !== snapshot.rawSha256 || receipt.capturedAt !== snapshot.capturedAt
    || receipt.snapshotFileSha256 !== hash(snapshotBytes) || receipt.rawObjectSha256 !== hash(rawBytes)
    || receipt.byteSize !== rawBytes.length || receipt.rawObjectUri !== `oci://axvym6vk8g7i/easysubway-datapacks/${objectKey}`
    || receipt.rawRetentionExpiresAt !== expectedRetention || storedAt < Date.parse(snapshot.capturedAt)
    || storedAt > now.getTime()) throw new Error("published receipt identity mismatch");
}
function observationBinding(observation) { return { snapshotId: observation.snapshot.snapshotId, manifestSha256: hash(observation.manifestBytes), snapshotSha256: hash(observation.snapshotBytes), rawSha256: hash(observation.rawBytes) }; }
function assertObservationBinding(journal, observation) {
  const binding = journal?.completedObservation;
  if (!binding || JSON.stringify(binding) !== JSON.stringify(observationBinding(observation))) throw new Error("completed observation identity mismatch");
}
function roster(plan) { return plan.stationLineProviderMappings.map((mapping) => ({
  stationId: mapping.stationId, lineId: mapping.lineId, railOprIsttCd: mapping.providerOperatorId,
  lnCd: mapping.providerLineId, stinCd: mapping.providerStationId,
  canonicalMappings: [{ artifactId: "bundled-capital", stationId: mapping.stationId, lineId: mapping.lineId }],
})); }
export function parseArgs(argv) {
  const values = {}; for (let index = 0; index < argv.length; index += 2) { const key = argv[index]; if (!key?.startsWith("--") || values[key.slice(2)] !== undefined) throw new Error("operation arguments are invalid"); values[key.slice(2)] = argv[index + 1]; }
  if (!["prepare", "collect", "recover-published", "finalize"].includes(values.phase) || Object.keys(values).some((key) => !["phase", "operation-root", "expected-main-sha", "source-operation-root"].includes(key))) throw new Error("operation arguments are invalid");
  requireText(values["operation-root"], "operation root");
  if (!path.isAbsolute(values["operation-root"])) throw new Error("operation root must be absolute");
  if (values.phase === "prepare") {
    requireText(values["expected-main-sha"], "expected main SHA");
    if (values["source-operation-root"] !== undefined) throw new Error("operation arguments are invalid");
  } else if (values.phase === "recover-published") {
    requireText(values["source-operation-root"], "source operation root");
    if (!path.isAbsolute(values["source-operation-root"]) || values["expected-main-sha"] !== undefined) throw new Error("operation arguments are invalid");
  } else if (values["expected-main-sha"] !== undefined || values["source-operation-root"] !== undefined) throw new Error("operation arguments are invalid");
  return values;
}
export async function prepareCurrentCapitalFacilityOperation({ repositoryRoot = ROOT, operationRoot, expectedMainSha, execFileImpl = execFile, now = new Date() } = {}) {
  requireText(expectedMainSha, "expected main SHA");
  const root = path.resolve(repositoryRoot); const output = path.resolve(requireText(operationRoot, "operation root"));
  try { await lstat(output); throw new Error("operation root already exists"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  await assertExternalOperationRoot(root, output, { allowAbsent: true });
  await assertExactMain(root, expectedMainSha, execFileImpl); await assertNoRegistrarResidues(root);
  const snapshots = await inputSnapshots(root); const bytes = snapshotBytes(snapshots); const plan = buildCurrentCapitalFacilityCollectionPlan(bytes);
  if (plan.counts.stationLineCount !== 213 || plan.counts.stationCount !== 199 || plan.counts.providerTupleCount !== 213) throw new Error("capital FACILITY plan count mismatch");
  const reread = await inputSnapshots(root); if (Object.entries(snapshots).some(([key, value]) => hash(value.bytes) !== hash(reread[key].bytes) || JSON.stringify(value.identity) !== JSON.stringify(reread[key].identity))) throw new Error("prepared input changed during preflight");
  await mkdir(output, { mode: 0o700 });
  await writeFile(path.join(output, "plan.json"), canonicalCurrentCapitalFacilityCollectionPlanJson(plan), { flag: "wx", mode: 0o600 });
  const journal = { schemaVersion: 1, artifactKind: "current-capital-facility-operation-journal", operationId: randomUUID(), phase: "PREPARED", preparedAt: now.toISOString(), expectedMainSha, planSha256: hash(Buffer.from(canonicalCurrentCapitalFacilityCollectionPlanJson(plan))), inputSha256: Object.fromEntries(Object.entries(bytes).map(([key, value]) => [key, hash(value)])), completedStages: {} };
  await syncWrite(path.join(output, JOURNAL), journal); return { plan, journal };
}
export async function collectCurrentCapitalFacilityOperation({ repositoryRoot = ROOT, operationRoot, serviceKey, fetchImpl = fetch, delayImpl, now = new Date(), env = process.env, execFileImpl = execFile, journalWriteImpl = syncWrite, collectImpl = collectKricStandardAccessibilityObservation, writeObservationImpl = writeKricStandardAccessibilityObservation } = {}) {
  const repository = path.resolve(repositoryRoot); const root = path.resolve(requireText(operationRoot, "operation root")); let journal = parseJournal(await regularBytes(path.join(root, JOURNAL), "operation journal"));
  await assertExternalOperationRoot(repository, root); const planBytes = await assertPlanBinding(root, journal);
  if (journal.phase === "COLLECTION_STARTED") {
    const observation = await readCompletedObservation(path.join(root, "observation"));
    const binding = observationBinding(observation); journal = { ...journal, phase: "COLLECTED", snapshotId: observation.snapshot.snapshotId, completedObservation: binding, collectionReconciledAt: now.toISOString() }; await journalWriteImpl(path.join(root, JOURNAL), journal); return summary(observation);
  }
  if (journal.phase !== "PREPARED") throw new Error("collection may only start from PREPARED operation");
  const key = requireText(serviceKey, "KRIC_SERVICE_KEY");
  await assertExactMain(repository, requireText(journal.expectedMainSha, "prepared expected main SHA"), execFileImpl); await assertNoRegistrarResidues(repository); await assertPreparedInputs(repository, journal); await validateReleasePreflight(repository, planBytes, now);
  const plan = parse(planBytes, "operation plan");
  if (canonicalCurrentCapitalFacilityCollectionPlanJson(plan) !== planBytes.toString("utf8") || plan.counts.providerTupleCount !== 213) throw new Error("operation plan is invalid");
  requireOciParBaseUrl(env);
  const releaseClaim = await acquireCollectionClaim(root);
  try {
    journal = parseJournal(await regularBytes(path.join(root, JOURNAL), "operation journal"));
    if (journal.phase !== "PREPARED") throw new Error("collection may only start from PREPARED operation");
    await journalWriteImpl(path.join(root, JOURNAL), { ...journal, phase: "COLLECTION_STARTED", collectionStartedAt: now.toISOString() });
    const observation = await collectImpl({ roster: roster(plan), serviceKey: key, fetchImpl, delayImpl, now, requestTimeoutMs: 30_000, requestIntervalMs: 250 });
    if (observation.rawArtifact.requestCount !== 213) throw new Error("KRIC collection must make exactly 213 requests");
    const observationRoot = path.join(root, "observation"); await writeObservationImpl({ outputRoot: observationRoot, observation });
    const completed = await readCompletedObservation(observationRoot); const binding = observationBinding(completed);
    await journalWriteImpl(path.join(root, JOURNAL), { ...journal, phase: "COLLECTED", collectionStartedAt: now.toISOString(), snapshotId: observation.snapshot.snapshotId, completedObservation: binding });
    return summary(observation);
  } catch (error) {
    let completed;
    try { completed = await readCompletedObservation(path.join(root, "observation")); } catch { /* incomplete observation follows normal failure path */ }
    if (completed) {
      const binding = observationBinding(completed);
      try { await journalWriteImpl(path.join(root, JOURNAL), { ...journal, phase: "COLLECTED", collectionStartedAt: journal.collectionStartedAt ?? now.toISOString(), snapshotId: completed.snapshot.snapshotId, completedObservation: binding, collectionReconciledAt: now.toISOString() }); return summary(completed); }
      catch { throw error; }
    }
    await journalWriteImpl(path.join(root, JOURNAL), { ...journal, phase: "COLLECTION_FAILED", collectionStartedAt: journal.collectionStartedAt ?? now.toISOString() });
    throw error;
  } finally { await releaseClaim(); }
}
export async function recoverPublishedCurrentCapitalFacilityOperation({ repositoryRoot = ROOT, operationRoot, sourceOperationRoot, now = new Date(), execFileImpl = execFile, durableCreateImpl = durableCreateBytes, journalWriteImpl = syncWrite } = {}) {
  const repository = path.resolve(repositoryRoot);
  const targetRoot = path.resolve(requireText(operationRoot, "operation root"));
  const sourceRoot = path.resolve(requireText(sourceOperationRoot, "source operation root"));
  if (targetRoot === sourceRoot) throw new Error("source and target operation roots must differ");
  await Promise.all([assertExternalOperationRoot(repository, targetRoot), assertExternalOperationRoot(repository, sourceRoot)]);
  const [realTarget, realSource] = await Promise.all([realpath(targetRoot), realpath(sourceRoot)]);
  if (realTarget === realSource) throw new Error("source and target operation roots must differ");

  const targetJournalPath = path.join(targetRoot, JOURNAL);
  const sourceJournalPath = path.join(sourceRoot, JOURNAL);
  const [targetJournal, sourceJournal] = await Promise.all([
    regularBytes(targetJournalPath, "target operation journal").then(parseJournal),
    regularBytes(sourceJournalPath, "source operation journal").then(parseJournal),
  ]);
  if (targetJournal.phase !== "PREPARED" || Object.keys(targetJournal.completedStages ?? {}).length !== 0) throw new Error("published recovery target must be PREPARED");
  if (sourceJournal.phase !== "FINALIZE_STARTED") throw new Error("published recovery source must be FINALIZE_STARTED");
  const sourcePublished = sourceJournal.completedStages?.published;
  if (!sourcePublished || Object.keys(sourcePublished).length !== 2 || !/^[0-9a-f]{64}$/.test(sourcePublished.receiptSha256 ?? "") || typeof sourcePublished.snapshotId !== "string") throw new Error("published recovery source stage is invalid");
  const sourceExpectedMainSha = requireText(sourceJournal.expectedMainSha, "source expected main SHA");
  const targetExpectedMainSha = requireText(targetJournal.expectedMainSha, "target expected main SHA");
  if (!/^[0-9a-f]{40}$/.test(sourceExpectedMainSha) || !/^[0-9a-f]{40}$/.test(targetExpectedMainSha)) throw new Error("published recovery main identity is invalid");
  await assertExactMain(repository, targetExpectedMainSha, execFileImpl);
  try { await execFileImpl("git", ["merge-base", "--is-ancestor", sourceExpectedMainSha, targetExpectedMainSha], { cwd: repository }); }
  catch { throw new Error("published recovery source main is not an ancestor"); }

  const [targetPlanBytes, sourcePlanBytes, preparedInputs] = await Promise.all([
    assertPlanBinding(targetRoot, targetJournal),
    assertPlanBinding(sourceRoot, sourceJournal),
    assertPreparedInputs(repository, targetJournal),
  ]);
  if (!targetPlanBytes.equals(sourcePlanBytes)) throw new Error("published recovery plan identity mismatch");
  const rebuiltPlan = buildCurrentCapitalFacilityCollectionPlan(snapshotBytes(preparedInputs));
  const rebuiltPlanBytes = Buffer.from(canonicalCurrentCapitalFacilityCollectionPlanJson(rebuiltPlan));
  if (!targetPlanBytes.equals(rebuiltPlanBytes) || rebuiltPlan.counts.stationLineCount !== 213 || rebuiltPlan.counts.stationCount !== 199 || rebuiltPlan.counts.providerTupleCount !== 213) throw new Error("published recovery canonical plan identity mismatch");
  const observation = await readCompletedObservation(path.join(sourceRoot, "observation"));
  assertObservationBinding(sourceJournal, observation);
  if (sourcePublished.snapshotId !== observation.snapshot.snapshotId) throw new Error("published recovery source stage is invalid");
  const receiptBytes = await regularBytes(path.join(sourceRoot, "receipt.json"), "source raw receipt");
  if (hash(receiptBytes) !== sourcePublished.receiptSha256) throw new Error("published recovery receipt identity mismatch");
  const receipt = parse(receiptBytes, "source raw receipt");
  await assertClosedRawReceipt({ root: repository, receipt, observation, now });
  const collectionStartedAt = new Date(requiredUtcInstant(sourceJournal.collectionStartedAt, "source collectionStartedAt")).toISOString();
  const finalizeObservedAt = new Date(requiredUtcInstant(sourceJournal.finalizeObservedAt, "source finalizeObservedAt")).toISOString();

  const targetObservationRoot = path.join(targetRoot, "observation");
  const targetReceiptPath = path.join(targetRoot, "receipt.json");
  const existingReceiptBytes = await existingRegularBytes(targetReceiptPath, "published recovery target receipt");
  if (existingReceiptBytes != null && !existingReceiptBytes.equals(receiptBytes)) throw new Error("published recovery target receipt mismatch");
  const observationFiles = [
    ["observation.json", observation.manifestBytes],
    [observation.manifest.snapshotFile, observation.snapshotBytes],
    [observation.manifest.rawArtifactFile, observation.rawBytes],
  ];
  let observationRootExists = false;
  try {
    const stat = await lstat(targetObservationRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("published recovery target observation root is invalid");
    observationRootExists = true;
    const allowed = new Set(observationFiles.map(([name]) => name));
    if ((await readdir(targetObservationRoot)).some((name) => !allowed.has(name))) throw new Error("published recovery target observation inventory mismatch");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const missingObservationFiles = [];
  for (const [name, bytes] of observationFiles) {
    const target = path.join(targetObservationRoot, name);
    const existing = observationRootExists ? await existingRegularBytes(target, `published recovery target ${name}`) : undefined;
    if (existing == null) missingObservationFiles.push([target, bytes]);
    else if (!existing.equals(bytes)) throw new Error("published recovery target observation mismatch");
  }
  if (!observationRootExists) {
    await mkdir(targetObservationRoot, { mode: 0o700 });
    const rootDirectory = await open(targetRoot, "r"); try { await rootDirectory.sync(); } finally { await rootDirectory.close(); }
  }
  for (const [target, bytes] of missingObservationFiles) await durableCreateImpl(target, bytes);
  if (existingReceiptBytes == null) await durableCreateImpl(targetReceiptPath, receiptBytes);
  const installedObservation = await readCompletedObservation(targetObservationRoot);
  if (!installedObservation.manifestBytes.equals(observation.manifestBytes)
    || !installedObservation.snapshotBytes.equals(observation.snapshotBytes)
    || !installedObservation.rawBytes.equals(observation.rawBytes)
    || !(await regularBytes(targetReceiptPath, "published recovery target receipt")).equals(receiptBytes)) throw new Error("published recovery target verification mismatch");
  const completedObservation = observationBinding(observation);
  await journalWriteImpl(targetJournalPath, {
    ...targetJournal,
    phase: "FINALIZE_STARTED",
    completedStages: { published: structuredClone(sourcePublished) },
    collectionStartedAt,
    snapshotId: observation.snapshot.snapshotId,
    completedObservation,
    finalizeObservedAt,
  });
  return { snapshotId: observation.snapshot.snapshotId, status: "RECOVERED_PUBLISHED" };
}
export async function finalizeCurrentCapitalFacilityOperation({ repositoryRoot = ROOT, operationRoot, now = new Date(), env = process.env, execFileImpl = execFile, publishImpl = publishKricAccessibilityRawArtifact, registerImpl = registerKricStandardAccessibilitySnapshot, rebindImpl = rebindCurrentCandidateSourceSnapshots, buildAdmissionImpl = buildCurrentCapitalFacilitySourceAdmission } = {}) {
  const root = path.resolve(repositoryRoot); const operation = path.resolve(requireText(operationRoot, "operation root")); const journal = parseJournal(await regularBytes(path.join(operation, JOURNAL), "operation journal"));
  await assertExternalOperationRoot(root, operation); const planBytes = await assertPlanBinding(operation, journal);
  let reconciledJournal = journal;
  if (journal.phase === "COLLECTION_STARTED") {
    const observation = await readCompletedObservation(path.join(operation, "observation"));
    reconciledJournal = { ...journal, phase: "COLLECTED", snapshotId: observation.snapshot.snapshotId, completedObservation: observationBinding(observation), collectionReconciledAt: now.toISOString() };
    await syncWrite(path.join(operation, JOURNAL), reconciledJournal);
  }
  if (!["COLLECTED", "FINALIZE_STARTED"].includes(reconciledJournal.phase)) throw new Error("finalize requires collected observation");
  const allowedResumePaths = new Set([
    "tools/datapack/source-inventory.json", "tools/datapack/release/source-snapshots.json", "tools/datapack/release/candidate-build-spec.json", ADMISSION,
    "tools/datapack/.kric-standard-registration-transaction.json", "tools/datapack/.kric-standard-registration.lock", "tools/datapack/.candidate-source-rebind.lock",
  ]);
  const completedObservation = await readCompletedObservation(path.join(operation, "observation")); assertObservationBinding(reconciledJournal, completedObservation);
  const observationManifest = completedObservation.manifest;
  allowedResumePaths.add(`tools/datapack/sources/${observationManifest.snapshotId}.json`);
  if (reconciledJournal.phase === "COLLECTED") { await assertExactMain(root, requireText(reconciledJournal.expectedMainSha, "prepared expected main SHA"), execFileImpl); await assertNoRegistrarResidues(root); await assertPreparedInputs(root, reconciledJournal); await validateReleasePreflight(root, planBytes, now); }
  else await assertExactMain(root, requireText(reconciledJournal.expectedMainSha, "prepared expected main SHA"), execFileImpl, allowedResumePaths);
  const observationRoot = path.join(operation, "observation"); const manifest = observationManifest;
  const finalizeObservedAt = reconciledJournal.finalizeObservedAt ?? now.toISOString();
  if (!Number.isFinite(Date.parse(finalizeObservedAt)) || new Date(finalizeObservedAt).toISOString() !== finalizeObservedAt) throw new Error("finalize observedAt is invalid");
  let nextJournal = { ...reconciledJournal, phase: "FINALIZE_STARTED", finalizeObservedAt, completedStages: reconciledJournal.completedStages ?? {} };
  await syncWrite(path.join(operation, JOURNAL), nextJournal);
  const receiptPath = path.join(operation, "receipt.json");
  const snapshotPath = path.join(observationRoot, manifest.snapshotFile); const snapshotBytes = await regularBytes(snapshotPath, "collected snapshot"); const snapshot = parse(snapshotBytes, "collected snapshot");
  if (!nextJournal.completedStages.published) {
    let receiptBytes = await existingRegularBytes(receiptPath, "raw receipt");
    if (receiptBytes != null) {
      await assertClosedRawReceipt({ root, receipt: parse(receiptBytes, "raw receipt"), observation: completedObservation, now });
    }
    if (receiptBytes == null) {
      requireOciParBaseUrl(env);
      try {
        await publishImpl({ observationRoot, receiptPath, repositoryRoot: root, env, now });
      } catch (error) {
        receiptBytes = await existingRegularBytes(receiptPath, "raw receipt"); if (receiptBytes == null) throw error;
      }
    }
    receiptBytes ??= await regularBytes(receiptPath, "raw receipt"); const publishedReceipt = parse(receiptBytes, "raw receipt");
    await assertClosedRawReceipt({ root, receipt: publishedReceipt, observation: completedObservation, now });
    nextJournal = { ...nextJournal, completedStages: { ...nextJournal.completedStages, published: { snapshotId: snapshot.snapshotId, receiptSha256: hash(receiptBytes) } } }; await syncWrite(path.join(operation, JOURNAL), nextJournal);
  }
  const receipt = parse(await regularBytes(receiptPath, "raw receipt"), "raw receipt");
  await assertClosedRawReceipt({ root, receipt, observation: completedObservation, now });
  const targetSnapshot = path.join(root, "tools/datapack/sources", `${snapshot.snapshotId}.json`);
  if (!nextJournal.completedStages.registered) {
    let registered = await isRegisteredState({ root, snapshot, snapshotBytes, receipt, targetSnapshot });
    if (!registered) {
      try {
        await registerImpl({ snapshotFilePath: snapshotPath, snapshotFileSha256: hash(snapshotBytes), snapshotTargetPath: targetSnapshot, rawReceipt: receipt, capitalFacilityPlanPath: path.join(operation, "plan.json"), capitalCanonicalPackPath: path.join(root, INPUTS.canonicalPackBytes), producerNeutralFullRegistration: true, repositoryRoot: root, now });
      } catch (error) {
        registered = await isRegisteredState({ root, snapshot, snapshotBytes, receipt, targetSnapshot }); if (!registered) throw error;
      }
    }
    if (!registered) registered = await isRegisteredState({ root, snapshot, snapshotBytes, receipt, targetSnapshot });
    if (!registered) throw new Error("registered snapshot verification failed");
    nextJournal = { ...nextJournal, completedStages: { ...nextJournal.completedStages, registered: { snapshotSha256: hash(snapshotBytes) } } }; await syncWrite(path.join(operation, JOURNAL), nextJournal);
  } else if (!Buffer.from(await regularBytes(targetSnapshot, "registered snapshot")).equals(snapshotBytes)) throw new Error("registered snapshot verification failed");
  const candidatePath = path.join(root, RELEASE_INPUTS.candidate);
  let candidateBytes = await regularBytes(candidatePath, "candidate");
  let expectedCandidateBytes;
  const reboundExpectedCandidateSha256 = nextJournal.reboundExpectedCandidateSha256;
  if (reboundExpectedCandidateSha256 != null && !/^[0-9a-f]{64}$/.test(reboundExpectedCandidateSha256)) throw new Error("rebound candidate journal hash is invalid");
  if (reboundExpectedCandidateSha256 != null && hash(candidateBytes) === reboundExpectedCandidateSha256) expectedCandidateBytes = candidateBytes;
  if (expectedCandidateBytes == null) {
    const release = Object.fromEntries(await Promise.all(Object.entries(RELEASE_INPUTS).map(async ([key, relative]) => [key, await readStableRegularFile(path.join(root, relative), key)])));
    const expectedCandidate = rebindCandidateSourceSnapshots({ candidateBuildSpec: parse(release.candidate.bytes, "candidate"), candidateBuildSpecBytes: release.candidate.bytes, releaseRequest: parse(release.releaseRequest.bytes, "release request"), sourceInventory: parse(release.inventory.bytes, "inventory"), sourceInventoryBytes: release.inventory.bytes, sourceSnapshots: parse(release.snapshots.bytes, "snapshots"), canonicalPack: parse(await regularBytes(path.join(root, INPUTS.canonicalPackBytes), "canonical pack"), "canonical pack"), governancePolicy: parse(release.governance.bytes, "governance"), governancePolicyBytes: release.governance.bytes, freshnessPolicy: parse(release.freshness.bytes, "freshness"), kricSnapshotBytes: snapshotBytes, now });
    expectedCandidateBytes = Buffer.from(`${JSON.stringify(expectedCandidate, null, 2)}\n`);
    if (reboundExpectedCandidateSha256 != null && hash(expectedCandidateBytes) !== reboundExpectedCandidateSha256) throw new Error("rebound candidate journal mismatch");
    if (reboundExpectedCandidateSha256 == null) {
      nextJournal = { ...nextJournal, reboundExpectedCandidateSha256: hash(expectedCandidateBytes) };
      await syncWrite(path.join(operation, JOURNAL), nextJournal);
    }
  }
  if (!nextJournal.completedStages.rebound) {
    if (!candidateBytes.equals(expectedCandidateBytes)) {
      try { await rebindImpl({ repositoryRoot: root, now }); } catch (error) {
        candidateBytes = await regularBytes(candidatePath, "candidate"); if (!candidateBytes.equals(expectedCandidateBytes)) throw error;
      }
    }
    candidateBytes = await regularBytes(candidatePath, "candidate");
    if (!candidateBytes.equals(expectedCandidateBytes)) throw new Error("candidate rebound verification failed");
    nextJournal = { ...nextJournal, completedStages: { ...nextJournal.completedStages, rebound: { candidateSha256: hash(expectedCandidateBytes) } } }; await syncWrite(path.join(operation, JOURNAL), nextJournal);
  } else if (!candidateBytes.equals(expectedCandidateBytes)) throw new Error("candidate rebound verification failed");
  const reboundRelease = Object.fromEntries(await Promise.all(Object.entries(RELEASE_INPUTS).map(async ([key, relative]) => [key, await readStableRegularFile(path.join(root, relative), key)])));
  const admission = buildAdmissionImpl({ observedAt: finalizeObservedAt, planBytes, canonicalPackBytes: await regularBytes(path.join(root, INPUTS.canonicalPackBytes), "canonical pack"), snapshotBytes: await regularBytes(path.join(root, "tools/datapack/sources", `${snapshot.snapshotId}.json`), "registered snapshot"), candidateBuildSpec: parse(reboundRelease.candidate.bytes, "candidate"), sourceInventoryBytes: reboundRelease.inventory.bytes, sourceSnapshots: parse(reboundRelease.snapshots.bytes, "snapshots"), governancePolicy: parse(reboundRelease.governance.bytes, "governance"), governancePolicyBytes: reboundRelease.governance.bytes, freshnessPolicy: parse(reboundRelease.freshness.bytes, "freshness") });
  const target = path.join(root, ADMISSION); const admissionBytes = Buffer.from(canonicalCurrentCapitalFacilitySourceAdmissionJson(admission));
  if (!nextJournal.completedStages.admitted) {
    let admittedBytes = await existingRegularBytes(target, "current capital facility admission");
    if (admittedBytes == null) {
      try { await writeFile(target, admissionBytes, { flag: "wx", mode: 0o600 }); } catch (error) {
        admittedBytes = await existingRegularBytes(target, "current capital facility admission"); if (admittedBytes == null || !Buffer.from(admittedBytes).equals(admissionBytes)) throw error;
      }
    }
    admittedBytes ??= await regularBytes(target, "current capital facility admission");
    if (!Buffer.from(admittedBytes).equals(admissionBytes)) throw new Error("current capital facility admission verification failed");
    nextJournal = { ...nextJournal, completedStages: { ...nextJournal.completedStages, admitted: { admissionSha256: hash(admissionBytes) } } }; await syncWrite(path.join(operation, JOURNAL), nextJournal);
  } else if (!Buffer.from(await regularBytes(target, "current capital facility admission")).equals(admissionBytes)) throw new Error("current capital facility admission verification failed");
  await syncWrite(path.join(operation, JOURNAL), { ...nextJournal, phase: "FINALIZED", snapshotId: snapshot.snapshotId, finalizedAt: now.toISOString() }); return admission;
}
export async function main(argv, dependencies = {}) { const args = parseArgs(argv); const common = { operationRoot: args["operation-root"], ...dependencies }; if (args.phase === "prepare") return prepareCurrentCapitalFacilityOperation({ ...common, expectedMainSha: args["expected-main-sha"] }); if (args.phase === "collect") return collectCurrentCapitalFacilityOperation({ ...common, serviceKey: dependencies.env?.KRIC_SERVICE_KEY ?? process.env.KRIC_SERVICE_KEY }); if (args.phase === "recover-published") return recoverPublishedCurrentCapitalFacilityOperation({ ...common, sourceOperationRoot: args["source-operation-root"] }); return finalizeCurrentCapitalFacilityOperation(common); }
if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then((value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)).catch((error) => { console.error(error instanceof Error ? error.message : "FACILITY operation failed"); process.exitCode = 1; });
