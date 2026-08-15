import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { deriveRawRetentionExpiresAt } from "../source-governance-policy.mjs";
import { publishImmutableObjectPlan } from "../publish-object-storage.mjs";

const SHA256 = /^[0-9a-f]{64}$/u;
const OCI_NAMESPACE = "axvym6vk8g7i";
const OCI_PAR_BASE_URL = new RegExp(`^https://objectstorage\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.oraclecloud\\.com/p/[^/?#]+/n/${OCI_NAMESPACE}/b/easysubway-datapacks/o/?$`, "u");

export function parseAccessibilityRawPublisherArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value == null || value.startsWith("--") || name.slice(2) in args) {
      throw new Error("invalid arguments");
    }
    args[name.slice(2)] = value;
  }
  return args;
}

export async function publishAccessibilityRawObservation({
  observationRoot,
  receiptPath,
  repositoryRoot,
  env = process.env,
  client = null,
  now = new Date(),
  sourceId,
  observationArtifactKind,
  rawArtifactKind,
  receiptArtifactKind,
  errorPrefix,
  validateSnapshotIdentity,
  validateRawCollection,
}) {
  const root = path.resolve(requiredAbsolutePath(observationRoot, "observationRoot"));
  const resolvedReceipt = path.resolve(requiredAbsolutePath(receiptPath, "receiptPath"));
  const manifest = JSON.parse(await readFile(path.join(root, "observation.json"), "utf8"));
  validateAccessibilityObservationManifest(manifest, { sourceId, observationArtifactKind });
  const snapshotPath = containedObservationFile(root, manifest.snapshotFile);
  const rawArtifactPath = containedObservationFile(root, manifest.rawArtifactFile);
  const [snapshotBytes, rawArtifactBytes] = await Promise.all([
    readFile(snapshotPath),
    readFile(rawArtifactPath),
  ]);
  const snapshot = validateSnapshotIdentity(JSON.parse(snapshotBytes));
  const rawArtifact = validateRawCollection(JSON.parse(rawArtifactBytes), snapshot);
  validateAccessibilityObservationIdentity({ manifest, snapshot, rawArtifact, snapshotBytes, rawArtifactBytes });

  const rawObjectSha256 = sha256(rawArtifactBytes);
  const dateToken = snapshot.capturedAt.slice(0, 10).replaceAll("-", "");
  const objectKey = `source-raw/${sourceId}/${dateToken}/${rawObjectSha256}.json`;
  const governancePolicy = JSON.parse(await readFile(
    path.join(path.resolve(repositoryRoot), "tools/datapack/source-governance-policy.json"),
    "utf8",
  ));
  const rawRetentionExpiresAt = deriveRawRetentionExpiresAt({
    policy: governancePolicy,
    sourceId,
    retrievedAt: snapshot.capturedAt,
  });
  const storedAt = canonicalUtcInstant(now, "raw object verification time");
  if (Date.parse(storedAt) < Date.parse(snapshot.capturedAt)) {
    throw new Error("raw object verification time precedes snapshot capture");
  }
  // The generic publisher otherwise selects a signed-storage client when this exact process env is absent.
  requireOciParBaseUrl(client == null ? process.env : env);
  try {
    await publishImmutableObjectPlan({
      root,
      client,
      plan: {
        steps: [
          { type: "put-immutable-bundle-object", objectKey, sourcePath: manifest.rawArtifactFile, sha256: rawObjectSha256, sizeBytes: rawArtifactBytes.length },
          { type: "verify-immutable-bundle-object", objectKey, sourcePath: manifest.rawArtifactFile, sha256: rawObjectSha256, sizeBytes: rawArtifactBytes.length },
        ],
      },
    });
  } catch (error) {
    throw sanitizedStorageError(error, errorPrefix);
  }
  const receipt = {
    schemaVersion: 1,
    artifactKind: receiptArtifactKind,
    sourceId,
    snapshotId: snapshot.snapshotId,
    snapshotRawSha256: snapshot.rawSha256,
    capturedAt: snapshot.capturedAt,
    snapshotFileSha256: manifest.snapshotFileSha256,
    rawObjectUri: `oci://${OCI_NAMESPACE}/easysubway-datapacks/${objectKey}`,
    rawObjectSha256,
    byteSize: rawArtifactBytes.length,
    storedAt,
    rawRetentionExpiresAt,
  };
  await writeKricRawReceipt(resolvedReceipt, receipt, { mode: 0o600 });
  return receipt;
}

function validateAccessibilityObservationManifest(value, { sourceId, observationArtifactKind }) {
  const keys = [
    "schemaVersion", "artifactKind", "sourceId", "capturedAt", "snapshotId", "snapshotRawSha256",
    "snapshotFile", "snapshotFileSha256", "rawArtifactFile", "rawObjectSha256",
    "rawObjectChecksumSha256", "rawObjectByteSize", "credentialRedacted",
  ];
  if (!exactKeys(value, keys)
    || value.schemaVersion !== 1
    || value.artifactKind !== observationArtifactKind
    || value.sourceId !== sourceId
    || !Number.isFinite(Date.parse(value.capturedAt))
    || typeof value.snapshotId !== "string"
    || !SHA256.test(value.snapshotRawSha256 ?? "")
    || !SHA256.test(value.snapshotFileSha256 ?? "")
    || !SHA256.test(value.rawObjectSha256 ?? "")
    || typeof value.rawObjectChecksumSha256 !== "string" || value.rawObjectChecksumSha256 === ""
    || !Number.isSafeInteger(value.rawObjectByteSize) || value.rawObjectByteSize < 1
    || value.credentialRedacted !== true
    || value.snapshotFile !== `${value.snapshotId}.json`
    || value.rawArtifactFile !== `${value.snapshotId}.raw.json`) {
    throw new Error(`${sourceId} accessibility observation manifest is invalid`);
  }
}

function validateAccessibilityObservationIdentity({ manifest, snapshot, rawArtifact, snapshotBytes, rawArtifactBytes }) {
  if (manifest.sourceId !== snapshot.sourceId
    || manifest.capturedAt !== snapshot.capturedAt
    || manifest.snapshotId !== snapshot.snapshotId
    || manifest.snapshotRawSha256 !== snapshot.rawSha256
    || rawArtifact.snapshotId !== snapshot.snapshotId
    || sha256(snapshotBytes) !== manifest.snapshotFileSha256
    || sha256(rawArtifactBytes) !== manifest.rawObjectSha256
    || createHash("sha256").update(rawArtifactBytes).digest("base64") !== manifest.rawObjectChecksumSha256
    || rawArtifactBytes.length !== manifest.rawObjectByteSize) {
    throw new Error(`${manifest.sourceId} accessibility observation identity mismatch`);
  }
}

function containedObservationFile(root, filename) {
  if (typeof filename !== "string" || filename === "" || path.basename(filename) !== filename) {
    throw new Error("accessibility observation path is invalid");
  }
  const resolved = path.resolve(root, filename);
  if (path.dirname(resolved) !== root) throw new Error("accessibility observation path is invalid");
  return resolved;
}

function exactKeys(value, expected) {
  return value != null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === expected.length
    && expected.every((key, index) => Object.keys(value)[index] === key);
}

function requiredAbsolutePath(value, label) {
  const text = requiredText(value, label);
  if (!path.isAbsolute(text)) throw new Error(`${label} must be absolute`);
  return text;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function writeKricRawReceipt(receiptPath, receipt, { mode } = {}) {
  await mkdir(path.dirname(receiptPath), { recursive: true });
  const body = `${JSON.stringify(receipt, null, 2)}\n`;
  const options = mode == null ? { flag: "wx" } : { flag: "wx", mode };
  try {
    await writeFile(receiptPath, body, options);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (await readFile(receiptPath, "utf8") !== body) {
      throw new Error("raw receipt already exists with different bytes");
    }
  }
}

export function requiredText(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value.trim();
}

export function requireOciParBaseUrl(env = process.env) {
  const value = env?.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL;
  if (typeof value !== "string" || !OCI_PAR_BASE_URL.test(value.trim())) {
    throw new Error("EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL must be an OCI HTTPS preauthenticated object URL");
  }
}

function canonicalUtcInstant(value, label) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${label} must be a valid Date`);
  }
  return value.toISOString();
}

function sanitizedStorageError(error, errorPrefix) {
  const status = /\bHTTP\s+([1-5]\d\d)\b/u.exec(String(error?.message ?? ""))?.[1];
  return new Error(`${errorPrefix} storage publication failed${status == null ? "" : `: HTTP ${status}`}`);
}
