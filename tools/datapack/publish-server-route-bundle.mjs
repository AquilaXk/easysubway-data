#!/usr/bin/env node
import { execFile } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  canonicalJson,
  sha256,
} from "./lib/manifest-validation.mjs";
import { validateServerRouteBundleFinal } from "./lib/server-route-bundle-final.mjs";
import {
  assertServerRouteOciClientIdentity,
  createServerRouteOciClient,
  serverRouteOciPublicBaseUrl,
} from "./publish-server-route-bundle-publication-descriptor.mjs";
import { inspectSignedServerRouteBundle } from "./sign-server-route-bundle.mjs";

const execFileAsync = promisify(execFile);
const COMPONENTS = ["accessibility", "fare", "timetable", "topology"];
const PUBLIC_BASE_URL_PATTERN = /^https:\/\/objectstorage\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.oraclecloud\.com\/n\/[A-Za-z0-9_~-](?:[A-Za-z0-9._~-]*[A-Za-z0-9_~-])?\/b\/[A-Za-z0-9_~-](?:[A-Za-z0-9._~-]*[A-Za-z0-9_~-])?\/o$/;
const PASS_GATES = [
  "sourceFreshness",
  "stationLineAccessibility",
  "routeEdgeEvaluation",
  "routeAccessibilityEligibility",
  "artifactInventory",
  "signature",
];
const UNAVAILABLE_GATES = ["publication", "rebuildParityPromotion"];
const RECEIPT_KEYS = [
  "schemaVersion",
  "artifactKind",
  "repository",
  "candidate",
  "locator",
  "objects",
  "receiptSha256",
];
const CANDIDATE_KEYS = [
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
  "prePublicationFinalSha256",
];

export async function publishServerRouteBundle(input) {
  const env = input.env ?? process.env;
  const storage = input.client ?? createServerRouteOciClient(env);
  assertServerRouteOciClientIdentity(storage, env);
  const repositoryRoot = await realDirectory(input.repositoryRoot ?? process.cwd(), "repository root");
  const repositoryGitSha = requiredGitSha(input.repositoryGitSha);
  await verifyRepositoryHead(repositoryRoot, repositoryGitSha);
  const artifactRoot = path.resolve(requiredRaw(input.artifactRoot, "artifactRoot"));
  const artifact = await inspectSignedServerRouteBundle(artifactRoot);
  const finalPath = path.resolve(requiredRaw(input.finalPath, "finalPath"));
  const finalBytes = await readNonEmptyRegular(finalPath, "pre-publication FINAL");
  const final = validateServerRouteBundleFinal(parseCanonicalJson(finalBytes, "pre-publication FINAL"));
  const publicBaseUrl = validatePublicBaseUrl(input.publicBaseUrl);
  if (publicBaseUrl !== serverRouteOciPublicBaseUrl(env)) {
    throw new Error("public base URL must equal the exact OCI server-route identity");
  }
  const receiptPath = path.resolve(requiredRaw(input.receiptPath, "receiptPath"));
  const receiptParent = await realDirectory(path.dirname(receiptPath), "receipt parent");
  const clock = input.clock ?? Date.now;
  if (typeof clock !== "function") throw new Error("clock must be a function");
  const publicationNow = input.now === undefined ? readEpochMilliseconds(clock, "clock") : input.now;
  assertEpochMilliseconds(publicationNow, "now");
  const beforeReceiptCreate = input.beforeReceiptCreate ?? null;
  if (beforeReceiptCreate !== null && typeof beforeReceiptCreate !== "function") {
    throw new Error("beforeReceiptCreate must be a function");
  }
  if (isWithin(artifact.root, receiptPath) || receiptPath === finalPath) {
    throw new Error("receiptPath must be outside signed artifact and FINAL inputs");
  }

  const snapshot = signedSnapshot(artifact);
  validatePrePublicationFinal({ final, artifact, snapshot, repositoryGitSha, publicationNow });
  const receipt = buildPublicationReceipt({
    final,
    repositoryGitSha,
    publicBaseUrl,
    snapshot,
  });
  await assertCompatibleReceipt(receiptPath, Buffer.from(canonicalJson(receipt)));
  const publicRead = input.publicRead ?? readCredentialFreeObject;
  if (typeof publicRead !== "function") throw new Error("publicRead must be a function");

  const stage = await mkdtemp(path.join(receiptParent, ".server-route-publication-"));
  try {
    await writeSnapshot(stage, snapshot);
    await publishStrictImmutableObjectPlan({
      plan: publicationPlan(receipt),
      root: stage,
      client: storage,
    });
    await verifyPublicLocator(receipt, publicRead);
    await assertInputsUnchanged({ artifactRoot, snapshot, finalPath, finalBytes });
    await verifyRepositoryHead(repositoryRoot, repositoryGitSha);
    assertCandidateFresh(final.candidate.freshUntil, readEpochMilliseconds(clock, "clock"));
    await persistReceipt(receiptPath, Buffer.from(canonicalJson(receipt)), beforeReceiptCreate);
    return receipt;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function verifyPublicLocator(receipt, publicRead) {
  for (const entry of receipt.objects) {
    const url = publicObjectUrl(receipt.locator.publicBaseUrl, entry.objectKey);
    const response = await publicRead(url, entry.sizeBytes);
    if (!response || response.statusCode !== 200 || !Buffer.isBuffer(response.body)) {
      throw new Error(`${entry.objectKey} public locator GET failed`);
    }
    if (response.body.length !== entry.sizeBytes || sha256(response.body) !== entry.sha256) {
      throw new Error(`${entry.objectKey} public locator checksum mismatch`);
    }
  }
}

export function readCredentialFreeObject(url, maxBytes, get = https.get) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("public locator expected size must be a positive safe integer");
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request = get(url, { headers: { accept: "application/octet-stream" } }, (response) => {
      const chunks = [];
      let length = 0;
      const abortResponse = (error) => {
        if (settled) return;
        rejectOnce(error);
        response.destroy();
        request?.destroy();
      };
      response.on("data", (chunk) => {
        if (settled) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > maxBytes) {
          abortResponse(new Error("public locator response exceeds expected size"));
          return;
        }
        chunks.push(bytes);
      });
      response.once("aborted", () => abortResponse(new Error("public locator GET aborted")));
      response.once("error", (error) => abortResponse(error));
      response.once("close", () => {
        if (!response.complete) abortResponse(new Error("public locator GET closed prematurely"));
      });
      response.once("end", () => {
        if (settled) return;
        settled = true;
        resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks, length) });
      });
    });
    request.setTimeout(30_000, () => {
      rejectOnce(new Error("public locator GET timed out"));
      request.destroy();
    });
    request.on("error", rejectOnce);
  });
}

function publicObjectUrl(base, objectKey) {
  const encoded = objectKey.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return `${base}/${encoded}`;
}

function signedSnapshot(artifact) {
  const files = artifact.files.map(([relative, bytes]) => ({
    path: safeRelativePath(relative, "signed artifact path"),
    bytes: Buffer.from(bytes),
    sizeBytes: bytes.length,
    sha256: sha256(bytes),
  })).sort((left, right) => bytewise(left.path, right.path));
  const expected = [
    "compatibility.json",
    "manifest.json",
    "manifest.signing-input.json",
    ...COMPONENTS.map((component) => `payload/${component}.sqlite.zst`),
    "provenance.json",
  ].sort(bytewise);
  if (canonicalJson(files.map((entry) => entry.path)) !== canonicalJson(expected)) {
    throw new Error("signed artifact file set mismatch");
  }
  return { artifact, files };
}

function validatePrePublicationFinal({ final, artifact, snapshot, repositoryGitSha, publicationNow }) {
  if (final.result !== "NO_GO") throw new Error("pre-publication FINAL must be NO_GO");
  for (const gate of PASS_GATES) {
    if (final.gates[gate].state !== "PASS") throw new Error(`${gate} must be PASS before publication`);
  }
  for (const gate of UNAVAILABLE_GATES) {
    if (final.gates[gate].state !== "UNAVAILABLE" || final.gates[gate].evidenceSha256 !== null) {
      throw new Error(`${gate} must be UNAVAILABLE before publication`);
    }
  }
  if (canonicalJson(final.blockers) !== canonicalJson([
    "publication:UNAVAILABLE",
    "rebuildParityPromotion:UNAVAILABLE",
  ])) {
    throw new Error("pre-publication FINAL blockers mismatch");
  }
  assertCandidateFresh(final.candidate.freshUntil, publicationNow);

  const manifest = artifact.manifest;
  const candidate = final.candidate;
  const provenanceEntry = snapshot.files.find((entry) => entry.path === "provenance.json");
  const provenance = parseCanonicalJson(provenanceEntry.bytes, "provenance");
  const manifestSha256 = sha256(artifact.manifestBytes);
  const checks = [
    [candidate.gitSha, repositoryGitSha, "gitSha"],
    [candidate.bundleId, manifest.bundleId, "bundleId"],
    [candidate.releaseSequence, manifest.releaseSequence, "releaseSequence"],
    [candidate.stationSetSha256, manifest.stationSetSha256, "stationSetSha256"],
    [candidate.sourceSnapshotSetHash, provenance.sourceSnapshotSetHash, "sourceSnapshotSetHash"],
    [candidate.signingInputSha256, sha256(artifact.signingInputBytes), "signingInputSha256"],
    [candidate.signedManifestRawSha256, manifestSha256, "signedManifestRawSha256"],
    [candidate.payloadRootSha256, manifest.payloadSha256, "payloadRootSha256"],
    [candidate.componentInventorySha256, manifest.payloadSha256, "componentInventorySha256"],
    [candidate.activeFrom, manifest.activeFrom, "activeFrom"],
    [candidate.freshUntil, manifest.freshUntil, "freshUntil"],
    [candidate.keyId, manifest.keyId, "keyId"],
    [final.gates.signature.evidenceSha256, manifestSha256, "signature evidence"],
  ];
  for (const [actual, expected, label] of checks) {
    if (actual !== expected) throw new Error(`${label} identity mismatch`);
  }
  for (const component of COMPONENTS) {
    if (candidate.componentDigests[component] !== manifest[`${component}Sha256`]) {
      throw new Error(`${component} component digest identity mismatch`);
    }
  }
}

function buildPublicationReceipt({ final, repositoryGitSha, publicBaseUrl, snapshot }) {
  const manifestSha256 = final.candidate.signedManifestRawSha256;
  const objectPrefix = `server-route-bundles/v1/${manifestSha256}/`;
  const payload = canonicalObject({
    schemaVersion: 1,
    artifactKind: "server-route-bundle-publication-receipt",
    repository: {
      name: "AquilaXk/easysubway-data",
      gitSha: repositoryGitSha,
    },
    candidate: {
      bundleId: final.candidate.bundleId,
      releaseSequence: final.candidate.releaseSequence,
      stationSetSha256: final.candidate.stationSetSha256,
      sourceSnapshotSetHash: final.candidate.sourceSnapshotSetHash,
      signingInputSha256: final.candidate.signingInputSha256,
      signedManifestRawSha256: manifestSha256,
      payloadRootSha256: final.candidate.payloadRootSha256,
      componentInventorySha256: final.candidate.componentInventorySha256,
      componentDigests: final.candidate.componentDigests,
      activeFrom: final.candidate.activeFrom,
      freshUntil: final.candidate.freshUntil,
      keyId: final.candidate.keyId,
      prePublicationFinalSha256: final.finalSha256,
    },
    locator: { publicBaseUrl, objectPrefix },
    objects: snapshot.files.map((entry) => ({
      path: entry.path,
      objectKey: `${objectPrefix}${entry.path}`,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
    })),
  });
  return validatePublicationReceipt(canonicalObject({
    ...payload,
    receiptSha256: sha256(Buffer.from(canonicalJson(payload))),
  }));
}

export function validatePublicationReceipt(receipt) {
  assertKeys(receipt, RECEIPT_KEYS, "receipt keys");
  if (receipt.schemaVersion !== 1) throw new Error("receipt schemaVersion must be 1");
  if (receipt.artifactKind !== "server-route-bundle-publication-receipt") {
    throw new Error("receipt artifactKind mismatch");
  }
  assertKeys(receipt.repository, ["name", "gitSha"], "repository keys");
  if (receipt.repository.name !== "AquilaXk/easysubway-data") throw new Error("receipt repository mismatch");
  requiredGitSha(receipt.repository.gitSha);
  validateReceiptCandidate(receipt.candidate);
  const expectedPrefix = validateReceiptLocator(receipt.locator, receipt.candidate.signedManifestRawSha256);
  validateReceiptObjects(receipt.objects, receipt.candidate, expectedPrefix);
  validateReceiptSelfDigest(receipt);
  return canonicalObject(receipt);
}

function validateReceiptCandidate(candidate) {
  assertKeys(candidate, CANDIDATE_KEYS, "candidate keys");
  raw(candidate.bundleId, "candidate bundleId");
  if (!Number.isSafeInteger(candidate.releaseSequence) || candidate.releaseSequence < 1) {
    throw new Error("candidate releaseSequence must be a safe positive integer");
  }
  for (const field of [
    "stationSetSha256",
    "sourceSnapshotSetHash",
    "signingInputSha256",
    "signedManifestRawSha256",
    "payloadRootSha256",
    "componentInventorySha256",
    "prePublicationFinalSha256",
  ]) sha(candidate[field], `candidate ${field}`);
  assertKeys(candidate.componentDigests, COMPONENTS, "componentDigests keys");
  for (const component of COMPONENTS) sha(candidate.componentDigests[component], `${component} digest`);
  const activeFrom = kst(candidate.activeFrom, "candidate activeFrom");
  const freshUntil = kst(candidate.freshUntil, "candidate freshUntil");
  if (activeFrom >= freshUntil) throw new Error("candidate activeFrom must be before freshUntil");
  raw(candidate.keyId, "candidate keyId");
}

function validateReceiptLocator(locator, signedManifestRawSha256) {
  assertKeys(locator, ["publicBaseUrl", "objectPrefix"], "locator keys");
  validatePublicBaseUrl(locator.publicBaseUrl);
  const expectedPrefix = `server-route-bundles/v1/${signedManifestRawSha256}/`;
  if (locator.objectPrefix !== expectedPrefix) throw new Error("locator objectPrefix mismatch");
  return expectedPrefix;
}

function validateReceiptObjects(objects, candidate, expectedPrefix) {
  if (!Array.isArray(objects) || objects.length !== 8) {
    throw new Error("receipt objects must contain exact eight entries");
  }
  const paths = [];
  for (const entry of objects) {
    assertKeys(entry, ["path", "objectKey", "sizeBytes", "sha256"], "object inventory keys");
    const relative = safeRelativePath(entry.path, "object path");
    if (entry.objectKey !== `${expectedPrefix}${relative}`) throw new Error("objectKey mismatch");
    if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 1) throw new Error("object sizeBytes is invalid");
    sha(entry.sha256, "object sha256");
    paths.push(relative);
  }
  const sorted = [...paths].sort(bytewise);
  if (canonicalJson(paths) !== canonicalJson(sorted) || new Set(paths).size !== paths.length) {
    throw new Error("receipt objects must be unique and bytewise sorted");
  }
  const expectedPaths = [
    "compatibility.json",
    "manifest.json",
    "manifest.signing-input.json",
    ...COMPONENTS.map((component) => `payload/${component}.sqlite.zst`),
    "provenance.json",
  ].sort(bytewise);
  if (canonicalJson(paths) !== canonicalJson(expectedPaths)) throw new Error("receipt object path set mismatch");
  const byPath = new Map(objects.map((entry) => [entry.path, entry]));
  if (byPath.get("manifest.json").sha256 !== candidate.signedManifestRawSha256) {
    throw new Error("receipt manifest digest identity mismatch");
  }
  if (byPath.get("manifest.signing-input.json").sha256 !== candidate.signingInputSha256) {
    throw new Error("receipt signing input digest identity mismatch");
  }
  for (const component of COMPONENTS) {
    if (byPath.get(`payload/${component}.sqlite.zst`).sha256 !== candidate.componentDigests[component]) {
      throw new Error(`receipt ${component} digest identity mismatch`);
    }
  }
  const payloadInventory = COMPONENTS.map((component) => {
    const entry = byPath.get(`payload/${component}.sqlite.zst`);
    return { path: entry.path, sizeBytes: entry.sizeBytes, sha256: entry.sha256 };
  }).sort((left, right) => bytewise(left.path, right.path));
  const payloadInventorySha256 = sha256(Buffer.from(canonicalJson(payloadInventory)));
  if (payloadInventorySha256 !== candidate.payloadRootSha256
    || payloadInventorySha256 !== candidate.componentInventorySha256) {
    throw new Error("receipt payload inventory digest identity mismatch");
  }
}

function validateReceiptSelfDigest(receipt) {
  sha(receipt.receiptSha256, "receiptSha256");
  const payload = structuredClone(receipt);
  delete payload.receiptSha256;
  if (receipt.receiptSha256 !== sha256(Buffer.from(canonicalJson(payload)))) {
    throw new Error("receiptSha256 mismatch");
  }
}

function publicationPlan(receipt) {
  return {
    schemaVersion: 1,
    mode: "server-route-bundle-immutable-publication",
    steps: receipt.objects.flatMap((entry) => [
      {
        type: "put-immutable-bundle-object",
        sourcePath: entry.path,
        objectKey: entry.objectKey,
        sizeBytes: entry.sizeBytes,
        sha256: entry.sha256,
      },
      {
        type: "verify-immutable-bundle-object",
        sourcePath: entry.path,
        objectKey: entry.objectKey,
        sizeBytes: entry.sizeBytes,
        sha256: entry.sha256,
      },
    ]),
  };
}

async function publishStrictImmutableObjectPlan({ plan, root, client }) {
  const storage = client;
  for (const step of plan.steps) {
    if (step.type === "put-immutable-bundle-object") {
      const bytes = await readFile(path.join(root, step.sourcePath));
      if (bytes.length !== step.sizeBytes || sha256(bytes) !== step.sha256) {
        throw new Error(`${step.objectKey} source checksum mismatch`);
      }
      if (!(await storage.putObjectIfAbsent(step.objectKey, bytes, step))) {
        throw new Error(`${step.objectKey} conditional create conflict: immutable violation`);
      }
      continue;
    }
    const stored = await storage.readObject(step.objectKey);
    if (!stored.exists || stored.body.length !== step.sizeBytes || sha256(stored.body) !== step.sha256) {
      throw new Error(`${step.objectKey} uploaded checksum mismatch`);
    }
  }
}

async function writeSnapshot(root, snapshot) {
  await mkdir(path.join(root, "payload"));
  for (const entry of snapshot.files) {
    await writeFile(path.join(root, entry.path), entry.bytes, { flag: "wx" });
  }
}

async function assertInputsUnchanged({ artifactRoot, snapshot, finalPath, finalBytes }) {
  let current;
  try {
    current = signedSnapshot(await inspectSignedServerRouteBundle(artifactRoot));
  } catch {
    throw new Error("signed artifact changed during publication");
  }
  for (let index = 0; index < snapshot.files.length; index += 1) {
    const before = snapshot.files[index];
    const after = current.files[index];
    if (before.path !== after.path || !before.bytes.equals(after.bytes)) {
      throw new Error("signed artifact changed during publication");
    }
  }
  const currentFinal = await readNonEmptyRegular(finalPath, "pre-publication FINAL");
  if (!currentFinal.equals(finalBytes)) throw new Error("pre-publication FINAL changed during publication");
}

async function assertCompatibleReceipt(receiptPath, expectedBytes) {
  let stat;
  try {
    stat = await lstat(receiptPath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("receipt must be a regular non-symlink");
  if (!(await readFile(receiptPath)).equals(expectedBytes)) {
    throw new Error("receipt already exists with different bytes");
  }
}

async function persistReceipt(receiptPath, bytes, beforeCreate) {
  await assertCompatibleReceipt(receiptPath, bytes);
  await beforeCreate?.();
  const parent = path.dirname(receiptPath);
  const stage = await mkdtemp(path.join(parent, ".server-route-receipt-"));
  const staged = path.join(stage, "receipt.json");
  try {
    const handle = await open(staged, "wx", 0o644);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(staged, receiptPath);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await assertCompatibleReceipt(receiptPath, bytes);
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

function validatePublicBaseUrl(value) {
  const rawValue = requiredRaw(value, "public base URL");
  let canonical;
  try {
    canonical = new URL(rawValue).toString();
  } catch {
    throw new Error("public base URL must be an exact HTTPS URL");
  }
  if (!PUBLIC_BASE_URL_PATTERN.test(rawValue) || canonical !== rawValue) {
    throw new Error("public base URL must be an exact credential-free OCI public bucket endpoint");
  }
  return rawValue;
}

function readEpochMilliseconds(clock, label) {
  const value = clock();
  assertEpochMilliseconds(value, `${label} result`);
  return value;
}

function assertEpochMilliseconds(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be epoch milliseconds`);
}

function assertCandidateFresh(freshUntil, now) {
  if (Date.parse(freshUntil) <= now) throw new Error("candidate freshUntil must be in the future at publication");
}

async function verifyRepositoryHead(repositoryRoot, expected) {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot });
  if (stdout.trim() !== expected) throw new Error("repositoryGitSha does not match repository HEAD");
}

async function readNonEmptyRegular(target, label) {
  let stat;
  try {
    stat = await lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${label} is missing`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink`);
  if (stat.size === 0) throw new Error(`${label} must be non-empty`);
  return readFile(target);
}

async function realDirectory(target, label) {
  const resolved = path.resolve(requiredRaw(target, label));
  let stat;
  try {
    stat = await lstat(resolved);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${label} is missing`);
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  return resolved;
}

function parseCanonicalJson(bytes, label) {
  let value;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error(`${label} must be JSON`);
  }
  if (!Buffer.from(bytes).equals(Buffer.from(canonicalJson(value)))) {
    throw new Error(`${label} must be canonical JSON`);
  }
  return value;
}

function assertKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort(bytewise);
  const wanted = [...expected].sort(bytewise);
  if (canonicalJson(actual) !== canonicalJson(wanted)) throw new Error(`${label} mismatch`);
}

function canonicalObject(value) {
  return JSON.parse(canonicalJson(value));
}

function requiredGitSha(value) {
  const shaValue = requiredRaw(value, "repositoryGitSha");
  if (!/^[a-f0-9]{40}$/.test(shaValue)) throw new Error("repositoryGitSha must be a full lowercase Git SHA");
  return shaValue;
}

function sha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be sha256`);
  return value;
}

function raw(value, label) {
  return requiredRaw(value, label);
}

function kst(value, label) {
  const instant = requiredRaw(value, label);
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}\+09:00$/.test(instant)) {
    throw new Error(`${label} must be an exact KST millisecond instant`);
  }
  const milliseconds = Date.parse(instant);
  if (Number.isNaN(milliseconds)
    || new Date(milliseconds + (9 * 60 * 60 * 1000)).toISOString().replace("Z", "+09:00") !== instant) {
    throw new Error(`${label} must be a valid KST millisecond instant`);
  }
  return milliseconds;
}

function requiredRaw(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty exact string`);
  }
  return value;
}

function safeRelativePath(value, label) {
  const rawValue = requiredRaw(value, label);
  if (rawValue.startsWith("/") || rawValue.includes("\\") || rawValue.split("/").includes("..")) {
    throw new Error(`${label} must be a safe relative path`);
  }
  const normalized = path.posix.normalize(rawValue);
  if (normalized !== rawValue || normalized === ".") throw new Error(`${label} must be a safe relative path`);
  return rawValue;
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
    "public-base-url",
    "receipt",
    "repository-git-sha",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`invalid argument near ${key ?? "<end>"}`);
    }
    const name = key.slice(2);
    if (!allowed.has(name) || Object.hasOwn(result, name)) throw new Error(`unsupported or duplicate argument: ${key}`);
    result[name] = value;
  }
  if (Object.keys(result).length !== allowed.size) throw new Error("exact publication arguments are required");
  return result;
}

async function main(argv) {
  const args = parseArgs(argv);
  const receipt = await publishServerRouteBundle({
    repositoryRoot: process.cwd(),
    repositoryGitSha: args["repository-git-sha"],
    artifactRoot: args["artifact-root"],
    finalPath: args.final,
    publicBaseUrl: args["public-base-url"],
    receiptPath: args.receipt,
  });
  process.stdout.write(`PUBLISHED ${receipt.receiptSha256}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`publish-server-route-bundle: ${error.message}\n`);
    process.exitCode = 1;
  });
}
