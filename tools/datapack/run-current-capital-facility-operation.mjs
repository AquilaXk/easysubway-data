#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, open, readFile, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { buildCurrentCapitalFacilityCollectionPlan, canonicalCurrentCapitalFacilityCollectionPlanJson } from "./build-current-capital-facility-collection-plan.mjs";
import { collectKricStandardAccessibilityObservation, validateKricAccessibilityRawCollection, validateKricAccessibilitySnapshotIdentity, writeKricStandardAccessibilityObservation } from "./collect-kric-accessibility-snapshots.mjs";
import { publishKricAccessibilityRawArtifact } from "./publish-kric-accessibility-raw.mjs";
import { registerKricStandardAccessibilitySnapshot } from "./register-kric-standard-accessibility-snapshot.mjs";
import { rebindCandidateSourceSnapshots, rebindCurrentCandidateSourceSnapshots, readStableRegularFile } from "./rebind-current-candidate-source-snapshots.mjs";
import { buildCurrentCapitalFacilitySourceAdmission, canonicalCurrentCapitalFacilitySourceAdmissionJson } from "./build-current-capital-facility-source-admission.mjs";
import { validateLineage } from "./source-snapshot-policy.mjs";
import { validateSourceGovernancePolicy } from "./source-governance-policy.mjs";
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

function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function parse(bytes, label) { try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} is invalid JSON`); } }
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
  const manifestBytes = await regularBytes(path.join(observationRoot, "observation.json"), "observation manifest"); const manifest = parse(manifestBytes, "observation manifest");
  const keys = ["schemaVersion", "artifactKind", "sourceId", "capturedAt", "snapshotId", "snapshotRawSha256", "snapshotFile", "snapshotFileSha256", "rawArtifactFile", "rawObjectSha256", "rawObjectChecksumSha256", "rawObjectByteSize", "credentialRedacted"];
  if (Object.keys(manifest).length !== keys.length || keys.some((key) => !(key in manifest)) || manifest.schemaVersion !== 1 || manifest.artifactKind !== "kric-standard-accessibility-observation" || manifest.credentialRedacted !== true) throw new Error("stored observation is incomplete");
  const snapshotBytes = await regularBytes(path.join(observationRoot, manifest.snapshotFile), "collected snapshot"); const rawBytes = await regularBytes(path.join(observationRoot, manifest.rawArtifactFile), "collected raw artifact");
  const snapshot = validateKricAccessibilitySnapshotIdentity(parse(snapshotBytes, "collected snapshot")); const rawArtifact = validateKricAccessibilityRawCollection(parse(rawBytes, "collected raw artifact"), snapshot);
  if (manifest.sourceId !== snapshot.sourceId || manifest.snapshotId !== snapshot.snapshotId || manifest.capturedAt !== snapshot.capturedAt || manifest.snapshotRawSha256 !== snapshot.rawSha256 || manifest.snapshotFileSha256 !== hash(snapshotBytes) || manifest.rawObjectSha256 !== hash(rawBytes) || manifest.rawObjectChecksumSha256 !== createHash("sha256").update(rawBytes).digest("base64") || manifest.rawObjectByteSize !== rawBytes.length || rawArtifact.snapshotId !== snapshot.snapshotId) throw new Error("stored observation identity mismatch");
  return { manifest, manifestBytes, snapshot, snapshotBytes, rawArtifact, rawBytes };
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
  if (!["prepare", "collect", "finalize"].includes(values.phase) || Object.keys(values).some((key) => !["phase", "operation-root", "expected-main-sha", "expected-bucket-owner"].includes(key))) throw new Error("operation arguments are invalid");
  requireText(values["operation-root"], "operation root");
  if (!path.isAbsolute(values["operation-root"])) throw new Error("operation root must be absolute");
  if (values.phase === "prepare") { requireText(values["expected-main-sha"], "expected main SHA"); requireText(values["expected-bucket-owner"], "expected bucket owner"); }
  return values;
}
export async function prepareCurrentCapitalFacilityOperation({ repositoryRoot = ROOT, operationRoot, expectedMainSha, expectedBucketOwner, execFileImpl = execFile, now = new Date() } = {}) {
  requireText(expectedMainSha, "expected main SHA");
  if (!/^\d{12}$/.test(requireText(expectedBucketOwner, "expected bucket owner"))) throw new Error("expected bucket owner is invalid");
  const root = path.resolve(repositoryRoot); const output = path.resolve(requireText(operationRoot, "operation root"));
  try { await lstat(output); throw new Error("operation root already exists"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  await assertExternalOperationRoot(root, output, { allowAbsent: true });
  await assertExactMain(root, expectedMainSha, execFileImpl); await assertNoRegistrarResidues(root);
  const snapshots = await inputSnapshots(root); const bytes = snapshotBytes(snapshots); const plan = buildCurrentCapitalFacilityCollectionPlan(bytes);
  if (plan.counts.stationLineCount !== 213 || plan.counts.stationCount !== 199 || plan.counts.providerTupleCount !== 213) throw new Error("capital FACILITY plan count mismatch");
  const reread = await inputSnapshots(root); if (Object.entries(snapshots).some(([key, value]) => hash(value.bytes) !== hash(reread[key].bytes) || JSON.stringify(value.identity) !== JSON.stringify(reread[key].identity))) throw new Error("prepared input changed during preflight");
  await mkdir(output, { mode: 0o700 });
  await writeFile(path.join(output, "plan.json"), canonicalCurrentCapitalFacilityCollectionPlanJson(plan), { flag: "wx", mode: 0o600 });
  const journal = { schemaVersion: 1, artifactKind: "current-capital-facility-operation-journal", operationId: randomUUID(), phase: "PREPARED", preparedAt: now.toISOString(), expectedMainSha, expectedBucketOwner, planSha256: hash(Buffer.from(canonicalCurrentCapitalFacilityCollectionPlanJson(plan))), inputSha256: Object.fromEntries(Object.entries(bytes).map(([key, value]) => [key, hash(value)])), completedStages: {} };
  await syncWrite(path.join(output, JOURNAL), journal); return { plan, journal };
}
export async function collectCurrentCapitalFacilityOperation({ repositoryRoot = ROOT, operationRoot, serviceKey, fetchImpl = fetch, delayImpl, now = new Date(), execFileImpl = execFile, journalWriteImpl = syncWrite, collectImpl = collectKricStandardAccessibilityObservation, writeObservationImpl = writeKricStandardAccessibilityObservation } = {}) {
  const repository = path.resolve(repositoryRoot); const root = path.resolve(requireText(operationRoot, "operation root")); let journal = parse(await regularBytes(path.join(root, JOURNAL), "operation journal"), "operation journal");
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
  const owner = requireText(journal.expectedBucketOwner, "prepared expected bucket owner");
  if (!/^\d{12}$/.test(owner)) throw new Error("prepared expected bucket owner is invalid");
  const releaseClaim = await acquireCollectionClaim(root);
  try {
    journal = parse(await regularBytes(path.join(root, JOURNAL), "operation journal"), "operation journal");
    if (journal.phase !== "PREPARED") throw new Error("collection may only start from PREPARED operation");
    await journalWriteImpl(path.join(root, JOURNAL), { ...journal, phase: "COLLECTION_STARTED", collectionStartedAt: now.toISOString() });
    const { stdout } = await execFileImpl("aws", ["sts", "get-caller-identity", "--query", "Account", "--output", "text", "--no-cli-pager"]);
    if (stdout.trim() !== owner) throw new Error("AWS caller account does not match expected bucket owner");
    await execFileImpl("aws", ["s3api", "head-bucket", "--bucket", "easysubway-datapack-sources", "--expected-bucket-owner", owner, "--no-cli-pager"]);
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
export async function finalizeCurrentCapitalFacilityOperation({ repositoryRoot = ROOT, operationRoot, expectedBucketOwner, now = new Date(), execFileImpl = execFile, publishImpl = publishKricAccessibilityRawArtifact, registerImpl = registerKricStandardAccessibilitySnapshot, rebindImpl = rebindCurrentCandidateSourceSnapshots, buildAdmissionImpl = buildCurrentCapitalFacilitySourceAdmission } = {}) {
  const root = path.resolve(repositoryRoot); const operation = path.resolve(requireText(operationRoot, "operation root")); const journal = parse(await regularBytes(path.join(operation, JOURNAL), "operation journal"), "operation journal");
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
  if (expectedBucketOwner != null && expectedBucketOwner !== journal.expectedBucketOwner) throw new Error("expected bucket owner differs from prepared operation");
  const observationRoot = path.join(operation, "observation"); const manifest = observationManifest;
  const finalizeObservedAt = reconciledJournal.finalizeObservedAt ?? now.toISOString();
  if (!Number.isFinite(Date.parse(finalizeObservedAt)) || new Date(finalizeObservedAt).toISOString() !== finalizeObservedAt) throw new Error("finalize observedAt is invalid");
  let nextJournal = { ...reconciledJournal, phase: "FINALIZE_STARTED", finalizeObservedAt, completedStages: reconciledJournal.completedStages ?? {} };
  await syncWrite(path.join(operation, JOURNAL), nextJournal);
  const receiptPath = path.join(operation, "receipt.json");
  const snapshotPath = path.join(observationRoot, manifest.snapshotFile); const snapshotBytes = await regularBytes(snapshotPath, "collected snapshot"); const snapshot = parse(snapshotBytes, "collected snapshot");
  const preparedOwner = requireText(journal.expectedBucketOwner, "prepared expected bucket owner");
  if (!nextJournal.completedStages.published) {
    let receiptBytes = await existingRegularBytes(receiptPath, "raw receipt");
    if (receiptBytes == null) {
      try {
        await publishImpl({ observationRoot, receiptPath, expectedBucketOwner: preparedOwner, repositoryRoot: root });
      } catch (error) {
        receiptBytes = await existingRegularBytes(receiptPath, "raw receipt"); if (receiptBytes == null) throw error;
      }
    }
    receiptBytes ??= await regularBytes(receiptPath, "raw receipt"); const publishedReceipt = parse(receiptBytes, "raw receipt");
    if (publishedReceipt.snapshotId !== snapshot.snapshotId || publishedReceipt.expectedBucketOwner !== preparedOwner) throw new Error("published receipt identity mismatch");
    nextJournal = { ...nextJournal, completedStages: { ...nextJournal.completedStages, published: { snapshotId: snapshot.snapshotId, receiptSha256: hash(receiptBytes) } } }; await syncWrite(path.join(operation, JOURNAL), nextJournal);
  }
  const receipt = parse(await regularBytes(receiptPath, "raw receipt"), "raw receipt");
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
export async function main(argv, dependencies = {}) { const args = parseArgs(argv); const common = { operationRoot: args["operation-root"], ...dependencies }; if (args.phase === "prepare") return prepareCurrentCapitalFacilityOperation({ ...common, expectedMainSha: args["expected-main-sha"], expectedBucketOwner: args["expected-bucket-owner"] }); if (args.phase === "collect") return collectCurrentCapitalFacilityOperation({ ...common, serviceKey: dependencies.env?.KRIC_SERVICE_KEY ?? process.env.KRIC_SERVICE_KEY }); return finalizeCurrentCapitalFacilityOperation({ ...common, expectedBucketOwner: args["expected-bucket-owner"] }); }
if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then((value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)).catch((error) => { console.error(error instanceof Error ? error.message : "FACILITY operation failed"); process.exitCode = 1; });
