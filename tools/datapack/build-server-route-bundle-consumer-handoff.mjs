import { execFile } from "node:child_process";
import { promisify, TextDecoder } from "node:util";
import {
  link,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  sha256,
  validateArtifactComponentManifest,
  withoutSignature,
} from "./lib/manifest-validation.mjs";
import {
  buildServerRouteBundleFinal,
  validateServerRouteBundleFinal,
} from "./lib/server-route-bundle-final.mjs";
import { validatePublicationReceipt } from "./publish-server-route-bundle.mjs";
import { inspectSignedServerRouteBundle } from "./sign-server-route-bundle.mjs";

const execFileAsync = promisify(execFile);
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const COMPONENTS = ["accessibility", "fare", "timetable", "topology"];
const SIGNED_PATHS = [
  "compatibility.json",
  "manifest.json",
  "manifest.signing-input.json",
  ...COMPONENTS.map((component) => `payload/${component}.sqlite.zst`),
  "provenance.json",
].sort(bytewise);
const ROOT_ENTRIES = ["compatibility.json", "manifest.json", "manifest.signing-input.json", "payload", "provenance.json"];
const PAYLOAD_ENTRIES = COMPONENTS.map((component) => `${component}.sqlite.zst`);
const HANDOFF_KEYS = [
  "schemaVersion",
  "artifactKind",
  "manifest",
  "sourceSnapshotSetHash",
  "publicationReceipt",
  "release",
  "backendAdmission",
  "platformRelease",
  "handoffSha256",
];
const RELEASE_KEYS = [
  "result",
  "finalSha256",
  "finalRawSha256",
  "publicationReceiptSha256",
  "publicationReceiptRawSha256",
  "promotionEvidenceSha256",
];
const BACKEND_KEYS = [
  "manifestSha256",
  "finalEvidenceReference",
  "promotionEvidenceReference",
  "immutablePublicationReceiptIdentity",
];
const RECEIPT_CANDIDATE_KEYS = [
  "bundleId",
  "releaseSequence",
  "stationSetSha256",
  "sourceSnapshotSetHash",
  "signingInputSha256",
  "signedManifestRawSha256",
  "payloadRootSha256",
  "componentInventorySha256",
  "componentDigests",
  "activeFrom",
  "freshUntil",
  "keyId",
];

export async function buildServerRouteBundleConsumerHandoff(input) {
  if (input.beforeOutput !== undefined && typeof input.beforeOutput !== "function") {
    throw new Error("beforeOutput must be a function");
  }
  if (input.clock !== undefined && typeof input.clock !== "function") {
    throw new Error("clock must be a function");
  }
  const repositoryRoot = await realDirectory(input.repositoryRoot ?? process.cwd(), "repository root");
  const artifactRoot = await realDirectory(input.artifactRoot, "artifact root");
  const payloadRoot = await realDirectory(path.join(artifactRoot, "payload"), "artifact payload root");
  await assertDirectoryEntries(artifactRoot, ROOT_ENTRIES, "signed artifact root entries");
  await assertDirectoryEntries(payloadRoot, PAYLOAD_ENTRIES, "signed artifact payload entries");

  const output = path.resolve(requiredRaw(input.output, "output"));
  const outputParent = await realDirectory(path.dirname(output), "output parent");
  await requireNewOutput(output);
  if (isWithin(artifactRoot, output) || output === artifactRoot) {
    throw new Error("output must be outside the signed artifact root");
  }

  const evidencePaths = {
    final: path.resolve(requiredRaw(input.finalPath, "finalPath")),
    publicationReceipt: path.resolve(requiredRaw(input.publicationReceiptPath, "publicationReceiptPath")),
    promotionRequest: path.resolve(requiredRaw(input.promotionRequestPath, "promotionRequestPath")),
  };
  if (new Set([...Object.values(evidencePaths), output]).size !== 4) {
    throw new Error("handoff input and output paths must be distinct");
  }
  const repositoryGitSha = requiredGitSha(input.repositoryGitSha);
  await verifyRepositoryHead(repositoryRoot, repositoryGitSha);

  const snapshots = await Promise.all([
    ...SIGNED_PATHS.map(async (relative) => ({
      label: `signed artifact ${relative}`,
      path: path.join(artifactRoot, relative),
      relative,
      bytes: await readNonEmptyRegular(path.join(artifactRoot, relative), `signed artifact ${relative}`),
    })),
    ...Object.entries(evidencePaths).map(async ([label, target]) => ({
      label: label === "publicationReceipt" ? "publication receipt" : label === "promotionRequest" ? "promotion request" : "FINAL",
      path: target,
      bytes: await readNonEmptyRegular(
        target,
        label === "publicationReceipt" ? "publication receipt" : label === "promotionRequest" ? "promotion request" : "FINAL",
      ),
    })),
  ]);
  const artifactFiles = new Map(snapshots.filter((entry) => entry.relative).map((entry) => [entry.relative, entry]));
  const evidenceFiles = Object.fromEntries(snapshots.filter((entry) => !entry.relative).map((entry) => [entry.label, entry]));
  const receiptBytes = evidenceFiles["publication receipt"].bytes;
  const receipt = validatePublicationReceipt(parseCanonicalJson(receiptBytes, "publication receipt"));
  assertReceiptObjectBytes(receipt, artifactFiles);
  const inspectedArtifact = await inspectSignedServerRouteBundle(artifactRoot);
  assertInspectedArtifactMatchesSnapshot(inspectedArtifact, artifactFiles);
  const manifestBytes = inspectedArtifact.manifestBytes;
  const manifest = inspectedArtifact.manifest;
  const signingInputBytes = inspectedArtifact.signingInputBytes;
  const provenance = parseCanonicalJson(artifactFiles.get("provenance.json").bytes, "provenance");
  const finalBytes = evidenceFiles.FINAL.bytes;
  const final = validateServerRouteBundleFinal(parseCanonicalJson(finalBytes, "FINAL"));
  assertReleaseFinal(final, (input.clock ?? Date.now)());
  assertCandidateBindings({
    artifactFiles,
    final,
    manifest,
    manifestBytes,
    provenance,
    receipt,
    repositoryGitSha,
    signingInputBytes,
  });
  assertPrePublicationFinalIdentity(final, receipt);
  const receiptRawSha256 = sha256(receiptBytes);
  const promotionRequestBytes = evidenceFiles["promotion request"].bytes;
  const promotionEvidenceSha256 = sha256(promotionRequestBytes);
  if (final.gates.publication.evidenceSha256 !== receiptRawSha256) {
    throw new Error("publication receipt raw digest mismatch");
  }
  if (final.gates.rebuildParityPromotion.evidenceSha256 !== promotionEvidenceSha256) {
    throw new Error("promotion request raw digest mismatch");
  }

  const manifestSha256 = sha256(manifestBytes);
  const finalRawSha256 = sha256(finalBytes);
  const payload = canonicalObject({
    schemaVersion: 1,
    artifactKind: "server-route-bundle-consumer-handoff",
    manifest,
    sourceSnapshotSetHash: final.candidate.sourceSnapshotSetHash,
    publicationReceipt: receipt,
    release: {
      result: "GO",
      finalSha256: final.finalSha256,
      finalRawSha256,
      publicationReceiptSha256: receipt.receiptSha256,
      publicationReceiptRawSha256: receiptRawSha256,
      promotionEvidenceSha256,
    },
    backendAdmission: {
      manifestSha256,
      finalEvidenceReference: sha256Reference(finalRawSha256),
      promotionEvidenceReference: sha256Reference(promotionEvidenceSha256),
      immutablePublicationReceiptIdentity: sha256Reference(receiptRawSha256),
    },
    platformRelease: {
      serverRouteBundleDigest: sha256Reference(manifestSha256),
    },
  });
  const handoff = validateServerRouteBundleConsumerHandoff(canonicalObject({
    ...payload,
    handoffSha256: sha256(Buffer.from(canonicalJson(payload))),
  }));
  const handoffBytes = Buffer.from(canonicalJson(handoff));

  await input.beforeOutput?.();
  await assertInputsUnchanged(snapshots);
  await assertDirectoryEntries(artifactRoot, ROOT_ENTRIES, "signed artifact root entries");
  await assertDirectoryEntries(payloadRoot, PAYLOAD_ENTRIES, "signed artifact payload entries");
  await persistNewOutput(outputParent, output, handoffBytes);
  return handoff;
}

export function validateServerRouteBundleConsumerHandoff(value) {
  assertKeys(value, HANDOFF_KEYS, "handoff keys");
  if (value.schemaVersion !== 1) throw new Error("handoff schemaVersion must be 1");
  if (value.artifactKind !== "server-route-bundle-consumer-handoff") {
    throw new Error("handoff artifactKind mismatch");
  }
  const manifest = canonicalObject(value.manifest);
  validateArtifactComponentManifest(manifest);
  if (manifest.artifactKind !== "server-route-bundle") throw new Error("handoff manifest artifactKind mismatch");
  const sourceSnapshotSetHash = sha(value.sourceSnapshotSetHash, "sourceSnapshotSetHash");
  const receipt = validatePublicationReceipt(value.publicationReceipt);
  const release = value.release;
  assertKeys(release, RELEASE_KEYS, "release keys");
  if (release.result !== "GO") throw new Error("release result must be GO");
  for (const key of RELEASE_KEYS.filter((key) => key !== "result")) sha(release[key], `release ${key}`);
  if (release.publicationReceiptSha256 !== receipt.receiptSha256) {
    throw new Error("release publication receipt identity mismatch");
  }
  if (release.publicationReceiptRawSha256 !== sha256(Buffer.from(canonicalJson(receipt)))) {
    throw new Error("release publication receipt raw digest mismatch");
  }
  if (sourceSnapshotSetHash !== receipt.candidate.sourceSnapshotSetHash) {
    throw new Error("source snapshot set identity mismatch");
  }

  const manifestSha256 = sha256(Buffer.from(canonicalJson(manifest)));
  assertReceiptManifestBindings(receipt, manifest, manifestSha256);
  const backendAdmission = value.backendAdmission;
  assertKeys(backendAdmission, BACKEND_KEYS, "backendAdmission keys");
  sha(backendAdmission.manifestSha256, "backendAdmission manifestSha256");
  sha256Reference(backendAdmission.finalEvidenceReference);
  sha256Reference(backendAdmission.promotionEvidenceReference);
  sha256Reference(backendAdmission.immutablePublicationReceiptIdentity);
  if (backendAdmission.manifestSha256 !== manifestSha256
    || backendAdmission.finalEvidenceReference !== sha256Reference(release.finalRawSha256)
    || backendAdmission.promotionEvidenceReference !== sha256Reference(release.promotionEvidenceSha256)
    || backendAdmission.immutablePublicationReceiptIdentity !== sha256Reference(release.publicationReceiptRawSha256)) {
    throw new Error("backendAdmission identity mismatch");
  }
  assertKeys(value.platformRelease, ["serverRouteBundleDigest"], "platformRelease keys");
  if (value.platformRelease.serverRouteBundleDigest !== sha256Reference(manifestSha256)) {
    throw new Error("platformRelease serverRouteBundleDigest mismatch");
  }
  sha(value.handoffSha256, "handoffSha256");
  const payload = structuredClone(value);
  delete payload.handoffSha256;
  if (value.handoffSha256 !== sha256(Buffer.from(canonicalJson(payload)))) {
    throw new Error("handoffSha256 mismatch");
  }
  return canonicalObject(value);
}

export function canonicalServerRouteBundleConsumerHandoffJson(value) {
  return canonicalJson(validateServerRouteBundleConsumerHandoff(value));
}

function assertReleaseFinal(final, now) {
  if (final.result !== "GO" || final.blockers.length !== 0
    || Object.values(final.gates).some((gate) => gate.state !== "PASS")) {
    throw new Error("FINAL must be GO with all gates PASS");
  }
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("clock result must be epoch milliseconds");
  if (Date.parse(final.candidate.freshUntil) <= now) {
    throw new Error("FINAL candidate freshUntil must be in the future");
  }
}

function assertPrePublicationFinalIdentity(final, receipt) {
  const prePublicationFinal = buildServerRouteBundleFinal({
    candidate: final.candidate,
    gates: {
      ...final.gates,
      publication: { state: "UNAVAILABLE", evidenceSha256: null },
      rebuildParityPromotion: { state: "UNAVAILABLE", evidenceSha256: null },
    },
  });
  if (receipt.candidate.prePublicationFinalSha256 !== prePublicationFinal.finalSha256) {
    throw new Error("publication receipt pre-publication FINAL identity mismatch");
  }
}

function assertCandidateBindings({
  artifactFiles,
  final,
  manifest,
  manifestBytes,
  provenance,
  receipt,
  repositoryGitSha,
  signingInputBytes,
}) {
  if (final.candidate.repository !== receipt.repository.name
    || final.candidate.gitSha !== repositoryGitSha
    || receipt.repository.gitSha !== repositoryGitSha) {
    throw new Error("repository identity mismatch");
  }
  for (const key of RECEIPT_CANDIDATE_KEYS) {
    if (canonicalJson(final.candidate[key]) !== canonicalJson(receipt.candidate[key])) {
      throw new Error(`FINAL and receipt candidate ${key} mismatch`);
    }
  }
  const manifestBindings = {
    bundleId: manifest.bundleId,
    releaseSequence: manifest.releaseSequence,
    stationSetSha256: manifest.stationSetSha256,
    signingInputSha256: sha256(signingInputBytes),
    signedManifestRawSha256: sha256(manifestBytes),
    payloadRootSha256: manifest.payloadSha256,
    componentInventorySha256: manifest.payloadSha256,
    componentDigests: Object.fromEntries(COMPONENTS.map((component) => [component, manifest[`${component}Sha256`]])),
    activeFrom: manifest.activeFrom,
    freshUntil: manifest.freshUntil,
    keyId: manifest.keyId,
  };
  for (const [key, expected] of Object.entries(manifestBindings)) {
    if (canonicalJson(final.candidate[key]) !== canonicalJson(expected)) {
      throw new Error(`FINAL and manifest ${key} mismatch`);
    }
  }
  if (final.gates.signature.evidenceSha256 !== sha256(manifestBytes)) {
    throw new Error("FINAL signature evidence identity mismatch");
  }
  if (manifest.compatibilitySha256 !== sha256(artifactFiles.get("compatibility.json").bytes)
    || manifest.provenanceSha256 !== sha256(artifactFiles.get("provenance.json").bytes)) {
    throw new Error("manifest metadata digest identity mismatch");
  }
  if (final.candidate.sourceSnapshotSetHash
    !== sha(provenance?.sourceSnapshotSetHash, "provenance sourceSnapshotSetHash")) {
    throw new Error("provenance sourceSnapshotSetHash mismatch");
  }
  assertReceiptManifestBindings(receipt, manifest, sha256(manifestBytes));
}

function assertReceiptManifestBindings(receipt, manifest, manifestSha256) {
  if (receipt.candidate.bundleId !== manifest.bundleId
    || receipt.candidate.releaseSequence !== manifest.releaseSequence
    || receipt.candidate.stationSetSha256 !== manifest.stationSetSha256
    || receipt.candidate.signedManifestRawSha256 !== manifestSha256
    || receipt.candidate.payloadRootSha256 !== manifest.payloadSha256
    || receipt.candidate.componentInventorySha256 !== manifest.payloadSha256
    || receipt.candidate.activeFrom !== manifest.activeFrom
    || receipt.candidate.freshUntil !== manifest.freshUntil
    || receipt.candidate.keyId !== manifest.keyId) {
    throw new Error("publication receipt and manifest identity mismatch");
  }
  const signingInputSha256 = sha256(Buffer.from(canonicalJson(withoutSignature(manifest))));
  if (receipt.candidate.signingInputSha256 !== signingInputSha256) {
    throw new Error("publication receipt and manifest signing input identity mismatch");
  }
  for (const [relative, expected] of [
    ["compatibility.json", manifest.compatibilitySha256],
    ["provenance.json", manifest.provenanceSha256],
  ]) {
    if (receipt.objects.find((entry) => entry.path === relative)?.sha256 !== expected) {
      throw new Error(`publication receipt and manifest ${relative.slice(0, -".json".length)} identity mismatch`);
    }
  }
  for (const component of COMPONENTS) {
    if (receipt.candidate.componentDigests[component] !== manifest[`${component}Sha256`]) {
      throw new Error(`publication receipt ${component} identity mismatch`);
    }
  }
}

function assertReceiptObjectBytes(receipt, artifactFiles) {
  for (const entry of receipt.objects) {
    const actual = artifactFiles.get(entry.path);
    if (!actual || actual.bytes.length !== entry.sizeBytes || sha256(actual.bytes) !== entry.sha256) {
      throw new Error(`publication receipt object ${entry.path} mismatch`);
    }
  }
}

function assertInspectedArtifactMatchesSnapshot(inspectedArtifact, artifactFiles) {
  for (const [relative, bytes] of inspectedArtifact.files) {
    if (!artifactFiles.get(relative)?.bytes.equals(bytes)) {
      throw new Error(`signed artifact ${relative} changed during signature verification`);
    }
  }
}

async function assertInputsUnchanged(snapshots) {
  for (const snapshot of snapshots) {
    const current = await readNonEmptyRegular(snapshot.path, snapshot.label);
    if (!current.equals(snapshot.bytes)) throw new Error(`${snapshot.label} changed during handoff build`);
  }
}

async function persistNewOutput(parent, output, bytes) {
  const stage = await mkdtemp(path.join(parent, ".server-route-handoff-"));
  const staged = path.join(stage, "handoff.json");
  try {
    await writeFile(staged, bytes, { flag: "wx" });
    try {
      await link(staged, output);
    } catch (error) {
      if (error.code === "EEXIST") throw new Error("output must not already exist");
      throw error;
    }
    if (!(await readFile(output)).equals(bytes)) throw new Error("output bytes mismatch after create");
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function verifyRepositoryHead(repositoryRoot, expected) {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot });
  if (stdout.trim() !== expected) throw new Error("repositoryGitSha does not match repository HEAD");
}

async function readNonEmptyRegular(target, label) {
  await inspectRequiredEntry(target, label, "file");
  return readFile(target);
}

async function realDirectory(target, label) {
  const resolved = path.resolve(requiredRaw(target, label));
  await inspectRequiredEntry(resolved, label, "directory");
  return resolved;
}

async function inspectRequiredEntry(target, label, kind) {
  const stat = await lstat(target).catch((error) => {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing`);
    throw error;
  });
  const realEntry = !stat.isSymbolicLink()
    && (kind === "file" ? stat.isFile() : stat.isDirectory());
  if (!realEntry) {
    throw new Error(kind === "file"
      ? `${label} must be a regular non-symlink`
      : `${label} must be a real directory`);
  }
  if (kind === "file" && stat.size === 0) throw new Error(`${label} must be non-empty`);
}

async function assertDirectoryEntries(root, expected, label) {
  const actual = (await readdir(root)).sort(bytewise);
  if (canonicalJson(actual) !== canonicalJson([...expected].sort(bytewise))) throw new Error(`${label} mismatch`);
}

async function requireNewOutput(output) {
  try {
    await lstat(output);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("output must not already exist");
}

function parseCanonicalJson(bytes, label) {
  let text;
  let value;
  try {
    text = strictUtf8.decode(Buffer.from(bytes));
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} must be JSON`);
  }
  if (text !== canonicalJson(value)) throw new Error(`${label} must be canonical JSON`);
  return value;
}

function assertKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value);
  const wanted = new Set(expected);
  if (actual.length !== wanted.size || actual.some((key) => !wanted.has(key))) throw new Error(`${label} mismatch`);
}

function canonicalObject(value) {
  return JSON.parse(canonicalJson(value));
}

function requiredRaw(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty exact string`);
  }
  return value;
}

function requiredGitSha(value) {
  const gitSha = requiredRaw(value, "repositoryGitSha");
  if (!/^[a-f0-9]{40}$/.test(gitSha)) throw new Error("repositoryGitSha must be a full lowercase Git SHA");
  return gitSha;
}

function sha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be sha256`);
  return value;
}

function sha256Reference(value) {
  if (typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value)) return value;
  return `sha256:${sha(value, "sha256 reference")}`;
}

function isWithin(parent, target) {
  const relative = path.relative(parent, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function bytewise(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function parseArgs(argv) {
  const result = {};
  const allowed = new Set([
    "artifact-root",
    "final",
    "output",
    "promotion-request",
    "publication-receipt",
    "repository-git-sha",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`invalid argument near ${key ?? "end"}`);
    }
    const name = key.slice(2);
    if (!allowed.delete(name)) throw new Error(`unknown or duplicate argument --${name}`);
    result[name] = value;
  }
  return result;
}

function requiredArg(args, name) {
  return requiredRaw(args[name], `--${name}`);
}

async function main(argv) {
  const args = parseArgs(argv);
  const handoff = await buildServerRouteBundleConsumerHandoff({
    repositoryRoot: process.cwd(),
    repositoryGitSha: requiredArg(args, "repository-git-sha"),
    artifactRoot: requiredArg(args, "artifact-root"),
    finalPath: requiredArg(args, "final"),
    publicationReceiptPath: requiredArg(args, "publication-receipt"),
    promotionRequestPath: requiredArg(args, "promotion-request"),
    output: requiredArg(args, "output"),
  });
  process.stdout.write(`HANDOFF ${handoff.handoffSha256}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`build-server-route-bundle-consumer-handoff: ${error.message}\n`);
    process.exitCode = 1;
  });
}
