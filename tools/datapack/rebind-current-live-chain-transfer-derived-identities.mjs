#!/usr/bin/env node
// Produces the TRANSFER-derived portion of a current live-chain bundle.  The
// operation is deliberately limited to its eight declared outputs: it neither
// advances a source head nor consumes any station/transition predecessor.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildApplicability } from "./build-current-capital-transfer-topology-applicability.mjs";
import { deriveCurrentLiveChainTransferDescriptorIdentity } from "./build-current-capital-live-chain-boundary.mjs";
import { rebuildAuthenticatedTransferTopologyMetrics } from "./build-current-transfer-topology-metrics.mjs";
import { readSeoulTransferObservationDirectory } from "./collect-current-seoul-transfer-distance-duration-snapshot.mjs";
import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";
import { registerSeoulTransferSourceSnapshot } from "./register-seoul-transfer-source-snapshot.mjs";
import { validateSeoulTransferRawReceipt } from "./publish-seoul-transfer-raw.mjs";
import { approvedGovernanceBindingTransition, deriveRawRetentionExpiresAt } from "./source-governance-policy.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SOURCE = "seoul-metro-transfer-distance-duration";
export const CURRENT_LIVE_CHAIN_TRANSFER_FIXED_OUTPUTS = Object.freeze([
  "tools/datapack/release/current-transfer-topology-metrics.json",
  "tools/datapack/release/current-capital-transfer-topology-applicability.json",
  "tools/datapack/source-inventory.json",
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/release/candidate-build-spec.json",
  "tools/datapack/release/release-request.json",
  "tools/datapack/release/hash-evidence.json",
]);
export function currentLiveChainTransferOutputPaths(descriptorRelativePath) {
  if (typeof descriptorRelativePath !== "string" || !/^tools\/datapack\/sources\/seoul-metro-transfer-distance-duration-[0-9]{8}T[0-9]{9}Z\.json$/u.test(descriptorRelativePath)) {
    throw new Error("TRANSFER descriptor output path mismatch");
  }
  return Object.freeze([
    ...CURRENT_LIVE_CHAIN_TRANSFER_FIXED_OUTPUTS.slice(0, 2),
    descriptorRelativePath,
    ...CURRENT_LIVE_CHAIN_TRANSFER_FIXED_OUTPUTS.slice(2),
  ]);
}
const STAGE_INPUTS = Object.freeze([
  "tools/datapack/release/capital-production-canonical-pack.json",
  "tools/datapack/release/candidate-build-spec.json",
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/release/release-request.json",
  "tools/datapack/release/hash-evidence.json",
  "tools/datapack/source-inventory.json",
  "tools/datapack/source-governance-policy.json",
  "tools/datapack/source-candidates.json",
  "tools/datapack/sources/kric-provider-code-catalog-20260228.json",
  "tools/datapack/itx-cheongchun-topology-evidence.json",
  "release/product-gates/datapack-freshness-sla.json",
]);
const JOURNAL = "tools/datapack/.current-live-chain-transfer-derived-identities.json";
const LOCK = "tools/datapack/.current-live-chain-transfer-derived-identities.lock";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const CURRENT_SOURCE_IDS = Object.freeze([
  "seoul-metro-route-map-positions", "kric-subway-timetable", "seoul-metro-accessibility",
  "kric-station-convenience-standard", "molit-urban-rail-full-route", "seoulmetro-station-line-info", SOURCE,
]);

function repositoryRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("repository root must be absolute");
  return path.resolve(value);
}
function rooted(root, relative) {
  const result = path.resolve(root, relative);
  if (!result.startsWith(`${root}${path.sep}`)) throw new Error(`path escapes repository root: ${relative}`);
  return result;
}
function outputPath(root, relative, outputPaths) {
  if (!outputPaths.includes(relative)) throw new Error(`TRANSFER output is not allowlisted: ${relative}`);
  return rooted(root, relative);
}
async function stable(file, label) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(`${label} changed during read`);
    return bytes;
  } finally { await handle.close(); }
}
async function assertParent(file) {
  const entry = await lstat(path.dirname(file));
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("TRANSFER output parent is unsafe");
}
async function atomicCas(file, expected, next) {
  await assertParent(file);
  if (!(await stable(file, "TRANSFER output prestate")).equals(expected)) throw new Error("TRANSFER output drift before commit");
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(next); await handle.sync(); } finally { await handle.close(); }
    if (!(await stable(file, "TRANSFER output prestate")).equals(expected)) throw new Error("TRANSFER output drift before commit");
    await rename(temp, file);
  } finally { await unlink(temp).catch(() => {}); }
}
async function stage(root) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "current-live-chain-transfer-"));
  try {
    for (const relative of STAGE_INPUTS) {
      const destination = rooted(temporary, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, await stable(rooted(root, relative), relative), { flag: "wx" });
    }
    return temporary;
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}
function currentReleaseSnapshots(candidate, snapshots) {
  if (JSON.stringify(candidate.sourceSnapshots?.map(({ sourceId }) => sourceId)) !== JSON.stringify(CURRENT_SOURCE_IDS)
    || candidate.sourceSnapshotIds?.length !== CURRENT_SOURCE_IDS.length) throw new Error("current source sequence is not exact");
  return candidate.sourceSnapshotIds.map((snapshotId, index) => {
    const row = snapshots.find((snapshot) => snapshot.snapshotId === snapshotId);
    if (!row || row.sourceId !== CURRENT_SOURCE_IDS[index]) throw new Error("current source ledger binding is not exact");
    if (typeof row.governancePolicyVersion !== "string" || !/^[0-9a-f]{64}$/u.test(row.governancePolicySha256 ?? "")) {
      throw new Error("current source lacks sealed governance binding");
    }
    return row;
  });
}
export function deriveCurrentOnlyProjection({ snapshot, inventory, governance, governanceBytes, freshness }) {
  const source = inventory.sources?.find(({ id }) => id === snapshot.sourceId);
  const sourceClass = freshness.sourceClasses?.find(({ sourceIds }) => sourceIds?.includes(snapshot.sourceId));
  if (!source || !sourceClass || typeof source.admissionEvidence?.adminReviewRecordHash !== "string") throw new Error("current source projection input is incomplete");
  if (typeof snapshot.governancePolicyVersion !== "string" || !/^[0-9a-f]{64}$/u.test(snapshot.governancePolicySha256 ?? "")) {
    throw new Error("current source cannot use an unsealed governance binding");
  }
  const binding = approvedGovernanceBindingTransition({
    snapshot, currentPolicyVersion: governance.policyVersion, currentPolicySha256: sha256(governanceBytes),
  });
  if (binding.governancePolicyVersion !== snapshot.governancePolicyVersion || binding.governancePolicySha256 !== snapshot.governancePolicySha256) {
    throw new Error("current source governance binding changed during projection");
  }
  return {
    snapshotId: snapshot.snapshotId, sourceId: snapshot.sourceId, rawObjectUri: snapshot.rawObjectUri,
    rawSha256: snapshot.rawSha256, redactedRequestFingerprint: snapshot.redactedRequestFingerprint,
    schemaFingerprint: snapshot.schemaFingerprint, licenseStatus: snapshot.licenseStatus,
    redistributionAllowed: snapshot.redistributionAllowed, adminReviewRecordHash: source.admissionEvidence.adminReviewRecordHash,
    snapshotStatus: snapshot.snapshotStatus, credentialRedacted: snapshot.credentialRedacted,
    freshnessExpiresAt: deriveFreshnessExpiresAt({ policy: freshness, sourceClassId: sourceClass.id,
      basisAt: snapshot[sourceClass.basisField], providerValidUntil: sourceClass.providerValidityEndField ? snapshot[sourceClass.providerValidityEndField] : undefined,
      evaluationAt: snapshot.retrievedAt }),
    rawRetentionExpiresAt: deriveRawRetentionExpiresAt({ policy: governance, sourceId: snapshot.sourceId, retrievedAt: snapshot.retrievedAt }),
    ...binding,
  };
}
async function refreshCurrentOnlyReleaseEvidence(staging) {
  const [candidateBytes, snapshotsBytes, inventoryBytes, requestBytes, hashesBytes, canonicalBytes, governanceBytes, freshnessBytes] = await Promise.all([
    stable(rooted(staging, "tools/datapack/release/candidate-build-spec.json"), "staged candidate"),
    stable(rooted(staging, "tools/datapack/release/source-snapshots.json"), "staged snapshots"),
    stable(rooted(staging, "tools/datapack/source-inventory.json"), "staged inventory"),
    stable(rooted(staging, "tools/datapack/release/release-request.json"), "staged request"),
    stable(rooted(staging, "tools/datapack/release/hash-evidence.json"), "staged hashes"),
    stable(rooted(staging, "tools/datapack/release/capital-production-canonical-pack.json"), "staged canonical pack"),
    stable(rooted(staging, "tools/datapack/source-governance-policy.json"), "staged governance"),
    stable(rooted(staging, "release/product-gates/datapack-freshness-sla.json"), "staged freshness"),
  ]);
  const candidate = JSON.parse(candidateBytes); const snapshots = JSON.parse(snapshotsBytes); const inventory = JSON.parse(inventoryBytes);
  const request = JSON.parse(requestBytes); const hashes = JSON.parse(hashesBytes); const governance = JSON.parse(governanceBytes); const freshness = JSON.parse(freshnessBytes);
  const releaseSnapshots = currentReleaseSnapshots(candidate, snapshots);
  candidate.sourceSnapshots = releaseSnapshots.map((snapshot) => deriveCurrentOnlyProjection({ snapshot, inventory, governance, governanceBytes, freshness }));
  candidate.sourceSnapshotIds = releaseSnapshots.map(({ snapshotId }) => snapshotId);
  candidate.sourceSnapshotSetHash = sha256(JSON.stringify(releaseSnapshots));
  candidate.sourceInventorySha256 = sha256(JSON.stringify(inventory));
  candidate.itxTopologyEvidenceSha256 = sha256(await stable(rooted(staging, candidate.itxTopologyEvidencePath), "staged ITX topology evidence"));
  candidate.networkEdgeEvidence.sourceInventory.sha256 = sha256(inventoryBytes);
  const nextCandidateBytes = json(candidate);
  request.candidateId = candidate.candidateId;
  request.buildSpecSha256 = sha256(nextCandidateBytes);
  request.sourceSnapshotSetHash = candidate.sourceSnapshotSetHash;
  hashes.sourceSnapshotSetHash.value = candidate.sourceSnapshotSetHash;
  hashes.sourceInventorySha256.value = candidate.sourceInventorySha256;
  hashes.fixturePath.sha256 = sha256(canonicalBytes);
  hashes.perSourceEvidence = releaseSnapshots.map((snapshot) => ({
    sourceId: snapshot.sourceId, snapshotId: snapshot.snapshotId, rawSha256: snapshot.rawSha256,
    adminReviewRecordHash: inventory.sources.find(({ id }) => id === snapshot.sourceId).admissionEvidence.adminReviewRecordHash,
    perSourceSnapshotSetHash: sha256(JSON.stringify([snapshot])),
  }));
  await Promise.all([
    writeFile(rooted(staging, "tools/datapack/release/candidate-build-spec.json"), nextCandidateBytes),
    writeFile(rooted(staging, "tools/datapack/release/release-request.json"), json(request)),
    writeFile(rooted(staging, "tools/datapack/release/hash-evidence.json"), json(hashes)),
  ]);
}
export function assertCurrentLiveChainTransferIdentity(candidate, inventory, snapshots, descriptor, descriptorBytes, receipt) {
  const projection = candidate.sourceSnapshots?.find(({ sourceId }) => sourceId === SOURCE);
  const row = snapshots.find(({ snapshotId }) => snapshotId === projection?.snapshotId);
  const source = inventory.sources?.find(({ id }) => id === SOURCE);
  const admission = source?.transferAdmissionEvidence;
  if (!projection || !row || !source || candidate.sourceSnapshotIds.at(-1) !== row.snapshotId
    || row.sourceId !== SOURCE || source.requiredForProductionPack !== true || !admission
    || admission.snapshotId !== row.snapshotId || admission.snapshotPath !== `tools/datapack/sources/${row.snapshotId}.json`
    || admission.snapshotFileSha256 !== sha256(descriptorBytes)
    || projection.rawObjectUri !== row.rawObjectUri || projection.rawSha256 !== row.rawSha256
    || projection.schemaFingerprint !== row.schemaFingerprint
    || admission.rawSha256 !== row.rawSha256 || admission.contentSha256 !== row.contentSha256
    || admission.schemaFingerprint !== row.schemaFingerprint
    || descriptor?.snapshotId !== row.snapshotId || descriptor.sourceId !== SOURCE
    || descriptor.rawSha256 !== row.rawSha256 || descriptor.contentSha256 !== row.contentSha256
    || descriptor.schemaFingerprint !== row.schemaFingerprint
    || descriptor.observationIdentity?.rawSnapshotSha256 !== row.rawSha256
    || receipt?.snapshotId !== row.snapshotId || receipt.snapshotRawSha256 !== row.rawSha256
    || receipt.rawObjectSha256 !== row.rawSha256 || receipt.rawObjectUri !== row.rawObjectUri
    || row.rawReceipt?.snapshotId !== row.snapshotId || row.rawReceipt?.snapshotRawSha256 !== row.rawSha256
    || row.rawReceipt?.rawObjectSha256 !== row.rawSha256 || row.rawReceipt?.rawObjectUri !== row.rawObjectUri) {
    throw new Error("current TRANSFER source identity is not exact");
  }
  return { row, source, admission };
}

export async function buildCurrentLiveChainTransferDerivedIdentityOutputs({ repositoryRoot: inputRoot = ROOT, observationDirectory, receiptPath } = {}) {
  const root = repositoryRoot(inputRoot);
  const [candidateBytes, inventoryBytes, snapshotsBytes, packBytes, sourceCandidatesBytes, kricBytes, receiptBytes] = await Promise.all([
    stable(rooted(root, "tools/datapack/release/candidate-build-spec.json"), "candidate"),
    stable(rooted(root, "tools/datapack/source-inventory.json"), "source inventory"),
    stable(rooted(root, "tools/datapack/release/source-snapshots.json"), "source snapshots"),
    stable(rooted(root, "tools/datapack/release/capital-production-canonical-pack.json"), "canonical pack"),
    stable(rooted(root, "tools/datapack/source-candidates.json"), "source candidates"),
    stable(rooted(root, "tools/datapack/sources/kric-provider-code-catalog-20260228.json"), "KRIC catalog"),
    stable(receiptPath, "authenticated OCI receipt"),
  ]);
  const candidate = JSON.parse(candidateBytes); const inventory = JSON.parse(inventoryBytes); const snapshots = JSON.parse(snapshotsBytes);
  const descriptorIdentity = deriveCurrentLiveChainTransferDescriptorIdentity({ candidate, sourceInventory: inventory, sourceSnapshotLedger: snapshots });
  const outputPaths = currentLiveChainTransferOutputPaths(descriptorIdentity.relativePath);
  const descriptorBytes = await stable(rooted(root, descriptorIdentity.relativePath), "TRANSFER descriptor");
  const receipt = validateSeoulTransferRawReceipt(JSON.parse(receiptBytes));
  const active = assertCurrentLiveChainTransferIdentity(candidate, inventory, snapshots, JSON.parse(descriptorBytes), descriptorBytes, receipt);
  const observation = await readSeoulTransferObservationDirectory(observationDirectory, { sourceCandidatesBytes });
  const metrics = rebuildAuthenticatedTransferTopologyMetrics({ canonicalPack: JSON.parse(packBytes), canonicalPackBytes: packBytes, observation: {
    manifest: observation.manifest, observation: observation.observation, raw: observation.rawSnapshot,
    bytes: { manifest: observation.manifestBytes, observation: observation.observationBytes, raw: observation.rawBytes },
  }, sourceCandidatesBytes, kricCatalogBytes: kricBytes });
  const metricsBytes = Buffer.from(`${JSON.stringify(metrics)}\n`);
  const applicability = buildApplicability({ canonicalPack: JSON.parse(packBytes), canonicalPackBytes: packBytes, transferTopologyMetrics: metrics, metricsBytes });
  const applicabilityBytes = Buffer.from(`${JSON.stringify(applicability)}\n`);
  const descriptor = registerSeoulTransferSourceSnapshot({ observation: {
    manifest: observation.manifest, observationBytes: observation.observationBytes, manifestBytes: observation.manifestBytes, rawBytes: observation.rawBytes,
  }, receipt, metrics, metricsBytes, applicability, applicabilityBytes, now: new Date(receipt.storedAt) });
  if (descriptor.snapshotId !== active.row.snapshotId) throw new Error("TRANSFER derivation changed source identity");
  const descriptorPath = `tools/datapack/sources/${descriptor.snapshotId}.json`;
  if (descriptorPath !== descriptorIdentity.relativePath) throw new Error("TRANSFER descriptor output path mismatch");
  const nextInventory = structuredClone(inventory);
  Object.assign(nextInventory.sources.find(({ id }) => id === SOURCE).transferAdmissionEvidence, {
    metricsArtifactSha256: descriptor.transferTopology.metricsArtifactSha256,
    applicabilityArtifactSha256: descriptor.transferTopology.applicabilityArtifactSha256,
  });
  const nextSnapshots = structuredClone(snapshots);
  const nextSnapshot = nextSnapshots.find(({ snapshotId }) => snapshotId === active.row.snapshotId);
  nextSnapshot.transferTopology = descriptor.transferTopology;
  nextSnapshot.rawReceipt = receipt;
  const staging = await stage(root);
  try {
    await Promise.all([
      writeFile(rooted(staging, "tools/datapack/release/current-transfer-topology-metrics.json"), metricsBytes),
      writeFile(rooted(staging, "tools/datapack/release/current-capital-transfer-topology-applicability.json"), applicabilityBytes),
      writeFile(rooted(staging, descriptorPath), json(descriptor)),
      writeFile(rooted(staging, "tools/datapack/source-inventory.json"), json(nextInventory)),
      writeFile(rooted(staging, "tools/datapack/release/source-snapshots.json"), json(nextSnapshots)),
    ]);
    await refreshCurrentOnlyReleaseEvidence(staging);
    const outputs = await Promise.all(outputPaths.map(async (relative) => ({
      relative, bytes: await stable(outputPath(staging, relative, outputPaths), `staged ${relative}`), prestate: await stable(outputPath(root, relative, outputPaths), `current ${relative}`),
    })));
    const rebuilt = JSON.parse(outputs.find(({ relative }) => relative.endsWith("candidate-build-spec.json")).bytes);
    if (rebuilt.candidateId !== candidate.candidateId || rebuilt.sourceSnapshotSetHash !== candidate.sourceSnapshotSetHash
      || JSON.stringify(rebuilt.sourceSnapshotIds) !== JSON.stringify(candidate.sourceSnapshotIds)) throw new Error("TRANSFER derivation changed candidate identity");
    return outputs;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

async function acquire(root) { const lock = rooted(root, LOCK); await assertParent(lock); await mkdir(lock, { mode: 0o700 }); return () => rmdir(lock); }
export async function commitCurrentLiveChainTransferDerivedIdentityOutputs({ repositoryRoot: inputRoot = ROOT, outputs, failAfter = null, failRollbackAt = null } = {}) {
  const root = repositoryRoot(inputRoot);
  if (!Array.isArray(outputs)) throw new Error("TRANSFER commit requires exact eight outputs");
  const descriptorOutputs = outputs.filter(({ relative }) => !CURRENT_LIVE_CHAIN_TRANSFER_FIXED_OUTPUTS.includes(relative));
  if (descriptorOutputs.length !== 1) throw new Error("TRANSFER commit requires exact eight outputs");
  const outputPaths = currentLiveChainTransferOutputPaths(descriptorOutputs[0].relative);
  if (JSON.stringify(outputs.map(({ relative }) => relative)) !== JSON.stringify(outputPaths)) throw new Error("TRANSFER commit requires exact eight outputs");
  const release = await acquire(root); const journal = rooted(root, JOURNAL);
  try {
    const records = outputs.map(({ relative, bytes, prestate }) => {
      if (!Buffer.isBuffer(bytes) || !Buffer.isBuffer(prestate)) throw new Error("TRANSFER output bytes are invalid");
      return { relative, before: prestate.toString("base64"), after: bytes.toString("base64") };
    });
    await writeFile(journal, JSON.stringify({ schemaVersion: 1, records }), { flag: "wx", mode: 0o600 });
    let index = -1;
    try {
      for (const record of records) { index += 1; await atomicCas(outputPath(root, record.relative, outputPaths), Buffer.from(record.before, "base64"), Buffer.from(record.after, "base64")); if (failAfter === index) throw new Error("injected TRANSFER commit failure"); }
    } catch (error) {
      let rollbackComplete = false;
      for (let rollback = index; rollback >= 0; rollback -= 1) {
        const record = records[rollback]; const file = outputPath(root, record.relative, outputPaths); const after = Buffer.from(record.after, "base64");
        if (!(await stable(file, "TRANSFER rollback")).equals(after)) throw error;
        if (failRollbackAt === rollback) throw new Error("injected TRANSFER rollback failure");
        await atomicCas(file, after, Buffer.from(record.before, "base64"));
      }
      rollbackComplete = true;
      if (rollbackComplete) { await unlink(journal); await release(); }
      throw error;
    }
    await unlink(journal); await release();
    return { targets: outputPaths, outputSha256: sha256(Buffer.concat(outputs.map(({ bytes }) => bytes))) };
  } catch (error) {
    // A journal and lock are recovery evidence when rollback ownership cannot
    // be proven.  They are intentionally retained for an explicit recovery.
    throw error;
  }
}
export async function rebindCurrentLiveChainTransferDerivedIdentities(options = {}) {
  const outputs = await buildCurrentLiveChainTransferDerivedIdentityOutputs(options);
  const outputPaths = outputs.map(({ relative }) => relative);
  if (options.check) {
    const stale = outputs.filter(({ bytes, prestate }) => !bytes.equals(prestate)).map(({ relative }) => relative);
    if (stale.length) throw new Error(`current live-chain TRANSFER output drift: ${stale.join(", ")}`);
    return { targets: outputPaths, changed: false };
  }
  return commitCurrentLiveChainTransferDerivedIdentityOutputs({ repositoryRoot: options.repositoryRoot, outputs, failAfter: options.failAfter });
}
function args(argv) { const value = (name) => argv[argv.indexOf(name) + 1]; if (!argv.includes("--repository-root") || !argv.includes("--observation-directory") || !argv.includes("--receipt")) throw new Error("arguments require --repository-root, --observation-directory, and --receipt"); return { repositoryRoot: value("--repository-root"), observationDirectory: value("--observation-directory"), receiptPath: value("--receipt"), check: argv.includes("--check") }; }
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) rebindCurrentLiveChainTransferDerivedIdentities(args(process.argv.slice(2))).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
