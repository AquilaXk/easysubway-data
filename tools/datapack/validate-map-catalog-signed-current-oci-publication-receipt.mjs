import { createHash } from "node:crypto";

import {
  canonicalJson,
  signingKeyId,
  signingPublicKey,
  verifyRsaSha256Signature,
  withoutSignature,
} from "./lib/manifest-validation.mjs";
import { validateMapCatalogSignedCurrentPublication } from "./validate-map-catalog-signed-current-publication.mjs";

const ALGORITHM = "rsa-sha256-map-catalog-signed-current-v1";
const SHA = /^[a-f0-9]{64}$/u;
const GIT_SHA = /^[a-f0-9]{40}$/u;
const MAP_PATHS = ["manifest.json", "payload/interchange-layout.json", "payload/line-styles.json", "payload/metropolitan.svg", "payload/stations-layout.json"];
const CATALOG_PATHS = ["manifest.json", "payload/catalog.sqlite"];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function canonicalMapCatalogSignedCurrentOciPublicationReceiptJson(value, options) {
  return canonicalJson(validateMapCatalogSignedCurrentOciPublicationReceipt(value, options));
}

export function validateMapCatalogSignedCurrentOciPublicationReceipt(value, { descriptor, publicKey = signingPublicKey(), now = Date.now() } = {}) {
  const content = validateMapCatalogSignedCurrentPublication(descriptor, { publicKey, now });
  exactKeys(value, ["schemaVersion", "artifactKind", "producerGitSha", "releaseSequence", "signedFinalDescriptorSha256", "stationSetSha256", "freshUntil", "target", "contentDescriptor", "objects", "operation", "receiptSha256", "keyId", "signature"], "receipt");
  if (value.schemaVersion !== 1 || value.artifactKind !== "map-catalog-signed-current-oci-publication-receipt") throw new Error("receipt identity mismatch");
  identity(value, content, now);
  target(value.target);
  contentDescriptor(value.contentDescriptor, content, value.target);
  objects(value.objects, content, value.target);
  operation(value.operation, content, now);
  selfDigest(value);
  signature(value, publicKey);
  return structuredClone(value);
}

function identity(receipt, descriptor, now) {
  for (const key of ["producerGitSha", "releaseSequence", "signedFinalDescriptorSha256", "stationSetSha256", "freshUntil"]) {
    if (receipt[key] !== descriptor[key]) throw new Error("receipt descriptor identity mismatch");
  }
  if (!validGitSha(receipt.producerGitSha) || !Number.isSafeInteger(receipt.releaseSequence) || receipt.releaseSequence < 1 || !validSha(receipt.signedFinalDescriptorSha256) || !validSha(receipt.stationSetSha256) || !Number.isFinite(now) || rfc3339(receipt.freshUntil) <= now || receipt.keyId !== signingKeyId()) throw new Error("receipt identity mismatch");
}

function target(value) {
  exactKeys(value, ["namespace", "bucket", "region", "compatEndpoint", "objectPrefix"], "target");
  if ([value.namespace, value.bucket, value.region, value.compatEndpoint, value.objectPrefix].some((item) => typeof item !== "string")) throw new Error("target identity mismatch");
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(value.namespace) || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(value.bucket) || !/^[a-z]+(?:-[a-z0-9]+)+-[0-9]+$/u.test(value.region) || !/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u.test(value.objectPrefix)) throw new Error("target identity mismatch");
  if (value.compatEndpoint !== `https://${value.namespace}.compat.objectstorage.${value.region}.oraclecloud.com`) throw new Error("target compat endpoint mismatch");
}

function contentDescriptor(value, descriptor, targetValue) {
  exactKeys(value, ["descriptorSha256", "objectKey", "sizeBytes", "rawSha256", "fullGet"], "content descriptor");
  const bytes = Buffer.from(canonicalJson(descriptor));
  if (value.descriptorSha256 !== descriptor.descriptorSha256 || value.objectKey !== contentKey(targetValue, descriptor.descriptorSha256) || value.sizeBytes !== bytes.length || value.rawSha256 !== sha256(bytes)) throw new Error("content descriptor binding mismatch");
  fullGet(value.fullGet, value.sizeBytes, value.rawSha256, "content descriptor");
}

function objects(value, descriptor, targetValue) {
  if (!Array.isArray(value) || value.length !== 7) throw new Error("object inventory mismatch");
  const expected = [
    ...descriptor.mapPack.objects.map((item) => ({ pack: "map-pack", ...item })),
    ...descriptor.stationCatalogPack.objects.map((item) => ({ pack: "station-catalog-pack", ...item })),
  ];
  for (let index = 0; index < expected.length; index += 1) {
    const actual = value[index]; const wanted = expected[index];
    exactKeys(actual, ["pack", "path", "objectKey", "sizeBytes", "sha256", "fullGet"], "object");
    if (actual.pack !== wanted.pack || actual.path !== wanted.path || actual.sizeBytes !== wanted.sizeBytes || actual.sha256 !== wanted.sha256) throw new Error("object inventory mismatch");
    if (actual.objectKey !== objectKey(targetValue, descriptor.descriptorSha256, wanted.pack, wanted.path)) throw new Error("objectKey mismatch");
    fullGet(actual.fullGet, wanted.sizeBytes, wanted.sha256, "object");
  }
}

function operation(value, descriptor, now) {
  exactKeys(value, ["repository", "headSha", "workflowRunId", "runAttempt", "completedAt"], "operation");
  const completedAt = rfc3339(value.completedAt);
  if (value.repository !== "AquilaXk/easysubway-data" || value.headSha !== descriptor.producerGitSha || !validGitSha(value.headSha) || !Number.isSafeInteger(value.workflowRunId) || value.workflowRunId < 1 || !Number.isSafeInteger(value.runAttempt) || value.runAttempt < 1 || !Number.isFinite(completedAt) || completedAt > now) throw new Error("operation identity mismatch");
}

function fullGet(value, sizeBytes, digest, label) {
  exactKeys(value, ["statusCode", "sizeBytes", "sha256"], `${label} full GET`);
  if (value.statusCode !== 200 || value.sizeBytes !== sizeBytes || value.sha256 !== digest || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || !validSha(value.sha256)) throw new Error(`${label} full GET mismatch`);
}

function selfDigest(value) {
  if (!validSha(value.receiptSha256)) throw new Error("receipt digest malformed");
  const payload = structuredClone(value); delete payload.receiptSha256; delete payload.signature;
  if (value.receiptSha256 !== sha256(Buffer.from(canonicalJson(payload)))) throw new Error("receipt digest mismatch");
}

function signature(value, publicKey) {
  exactKeys(value.signature, ["algorithm", "value"], "receipt signature");
  if (value.signature.algorithm !== ALGORITHM || typeof value.signature.value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value.signature.value) || !verifyRsaSha256Signature(publicKey, canonicalJson(withoutSignature(value)), value.signature.value)) throw new Error("receipt signature mismatch");
}

function contentKey(targetValue, descriptorSha256) { return `${targetValue.objectPrefix}/v1/content-descriptors/${descriptorSha256}.json`; }
function objectKey(targetValue, descriptorSha256, pack, relativePath) { return `${targetValue.objectPrefix}/v1/content-descriptors/${descriptorSha256}/objects/${pack}/${relativePath}`; }
function exactKeys(value, expected, label) { if (!plain(value) || Object.keys(value).length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) throw new Error(`${label} keys mismatch`); }
function plain(value) { return value != null && typeof value === "object" && !Array.isArray(value); }
function validSha(value) { return typeof value === "string" && SHA.test(value); }
function validGitSha(value) { return typeof value === "string" && GIT_SHA.test(value); }
function rfc3339(value) { const match = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/u.exec(value); if (!match) return NaN; const [, year, month, day, hour, minute, second, fraction = "", zone] = match; const [y, mo, d, h, mi, s] = [year, month, day, hour, minute, second].map(Number); const ms = Number(fraction.slice(0, 3).padEnd(3, "0")); const calendar = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms)); if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59 || calendar.getUTCFullYear() !== y || calendar.getUTCMonth() !== mo - 1 || calendar.getUTCDate() !== d || (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59))) return NaN; return Date.parse(value); }
