import { createHash } from "node:crypto";

import {
  canonicalJson,
  signingKeyId,
  signingPublicKey,
  verifyRsaSha256Signature,
  withoutSignature,
} from "./lib/manifest-validation.mjs";

const ALGORITHM = "rsa-sha256-map-catalog-signed-current-v1";
const MAP_PATHS = ["manifest.json", "payload/interchange-layout.json", "payload/line-styles.json", "payload/metropolitan.svg", "payload/stations-layout.json"];
const CATALOG_PATHS = ["manifest.json", "payload/catalog.sqlite"];
const SHA = /^[a-f0-9]{64}$/u;
const GIT_SHA = /^[a-f0-9]{40}$/u;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const ordered = (values) => [...values].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));

export function canonicalMapCatalogSignedCurrentPublicationJson(value) {
  return canonicalJson(validateMapCatalogSignedCurrentPublication(value));
}

export function validateMapCatalogSignedCurrentPublication(value, { publicKey = signingPublicKey(), now = Date.now() } = {}) {
  exactKeys(value, ["schemaVersion", "artifactKind", "producerGitSha", "releaseSequence", "signedFinalDescriptorSha256", "stationSetSha256", "freshUntil", "mapPack", "stationCatalogPack", "publicationReceipt", "publicationReceiptSha256", "descriptorSha256", "keyId", "signature"], "descriptor");
  if (value.schemaVersion !== 1 || value.artifactKind !== "map-catalog-signed-current-publication") throw new Error("descriptor identity mismatch");
  validateIdentity(value, "descriptor", now);
  validatePack(value.mapPack, "map-pack", MAP_PATHS, value.stationSetSha256);
  validatePack(value.stationCatalogPack, "station-catalog-pack", CATALOG_PATHS, value.stationSetSha256);
  const receipt = validateMapCatalogSignedCurrentPublicationReceipt(value.publicationReceipt, { publicKey, now });
  if (value.publicationReceiptSha256 !== receipt.receiptSha256 || value.producerGitSha !== receipt.producerGitSha || value.releaseSequence !== receipt.releaseSequence || value.signedFinalDescriptorSha256 !== receipt.signedFinalDescriptorSha256 || value.stationSetSha256 !== receipt.stationSetSha256 || value.freshUntil !== receipt.freshUntil || canonicalJson(value.mapPack) !== canonicalJson(receipt.mapPack) || canonicalJson(value.stationCatalogPack) !== canonicalJson(receipt.stationCatalogPack)) throw new Error("descriptor receipt binding mismatch");
  selfDigest(value, "descriptorSha256", "descriptor");
  signature(value, publicKey, "descriptor");
  return structuredClone(value);
}

export function validateMapCatalogSignedCurrentPublicationReceipt(value, { publicKey = signingPublicKey(), now = Date.now() } = {}) {
  exactKeys(value, ["schemaVersion", "artifactKind", "producerGitSha", "releaseSequence", "signedFinalDescriptorSha256", "stationSetSha256", "freshUntil", "mapPack", "stationCatalogPack", "receiptSha256", "keyId", "signature"], "receipt");
  if (value.schemaVersion !== 1 || value.artifactKind !== "map-catalog-signed-current-publication-receipt") throw new Error("receipt identity mismatch");
  validateIdentity(value, "receipt", now);
  validatePack(value.mapPack, "map-pack", MAP_PATHS, value.stationSetSha256);
  validatePack(value.stationCatalogPack, "station-catalog-pack", CATALOG_PATHS, value.stationSetSha256);
  selfDigest(value, "receiptSha256", "receipt");
  signature(value, publicKey, "receipt");
  return structuredClone(value);
}

function validateIdentity(value, label, now) {
  const freshUntil = rfc3339(value.freshUntil);
  if (!validGitSha(value.producerGitSha) || !Number.isSafeInteger(value.releaseSequence) || value.releaseSequence < 1 || !validSha(value.signedFinalDescriptorSha256) || !validSha(value.stationSetSha256) || !Number.isFinite(now) || !Number.isFinite(freshUntil) || freshUntil <= now || value.keyId !== signingKeyId()) throw new Error(`${label} identity mismatch`);
}

function validatePack(pack, artifactKind, expectedPaths, stationSetSha256) {
  exactKeys(pack, ["manifest", "objects"], `${artifactKind} pack`);
  const manifest = pack.manifest;
  if (!plain(manifest) || manifest.manifestVersion !== 1 || manifest.artifactKind !== artifactKind || manifest.stationSetSha256 !== stationSetSha256 || !validSha(manifest.payloadSha256)) throw new Error(`${artifactKind} manifest binding mismatch`);
  const expectedIdentity = artifactKind === "map-pack" ? "mapPackId" : "catalogPackId";
  exactKeys(manifest, ["manifestVersion", "artifactKind", expectedIdentity, "stationSetSha256", "payloadSha256"], `${artifactKind} manifest`);
  if (typeof manifest[expectedIdentity] !== "string" || manifest[expectedIdentity].trim() === "") throw new Error(`${artifactKind} manifest identity mismatch`);
  if (canonicalJson(manifest) !== canonicalJson(JSON.parse(canonicalJson(manifest)))) throw new Error(`${artifactKind} manifest is noncanonical`);
  if (!Array.isArray(pack.objects) || pack.objects.length !== expectedPaths.length) throw new Error(`${artifactKind} object inventory mismatch`);
  const paths = pack.objects.map((entry) => entry?.path);
  if (canonicalJson(paths) !== canonicalJson(expectedPaths) || new Set(paths).size !== paths.length) throw new Error(`${artifactKind} object path inventory mismatch`);
  for (const entry of pack.objects) {
    exactKeys(entry, ["path", "sizeBytes", "sha256"], `${artifactKind} object`);
    if (!expectedPaths.includes(entry.path) || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 1 || !validSha(entry.sha256)) throw new Error(`${artifactKind} object binding mismatch`);
  }
  const manifestObject = pack.objects[0]; const manifestBytes = Buffer.from(canonicalJson(manifest));
  if (manifestObject.path !== "manifest.json" || manifestObject.sizeBytes !== manifestBytes.length || manifestObject.sha256 !== sha256(manifestBytes)) throw new Error(`${artifactKind} manifest object binding mismatch`);
  const payload = pack.objects.filter(({ path }) => path !== "manifest.json").map(({ path, sizeBytes, sha256 }) => ({ path, sizeBytes, sha256 }));
  if (manifest.payloadSha256 !== sha256(Buffer.from(canonicalJson(payload)))) throw new Error(`${artifactKind} payload binding mismatch`);
}

function selfDigest(value, field, label) {
  if (!validSha(value[field])) throw new Error(`${label} digest malformed`);
  const payload = structuredClone(value); delete payload[field]; delete payload.signature;
  if (value[field] !== sha256(Buffer.from(canonicalJson(payload)))) throw new Error(`${label} digest mismatch`);
}

function signature(value, publicKey, label) {
  exactKeys(value.signature, ["algorithm", "value"], `${label} signature`);
  if (value.signature.algorithm !== ALGORITHM || typeof value.signature.value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value.signature.value) || !verifyRsaSha256Signature(publicKey, canonicalJson(withoutSignature(value)), value.signature.value)) throw new Error(`${label} signature mismatch`);
}

function exactKeys(value, expected, label) { if (!plain(value) || canonicalJson(ordered(Object.keys(value))) !== canonicalJson(ordered(expected))) throw new Error(`${label} keys mismatch`); }
function plain(value) { return value != null && typeof value === "object" && !Array.isArray(value); }
function validSha(value) { return typeof value === "string" && SHA.test(value); }
function validGitSha(value) { return typeof value === "string" && GIT_SHA.test(value); }
function rfc3339(value) { const match = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/u.exec(value); if (!match) return NaN; const [, year, month, day, hour, minute, second, fraction = "", zone] = match; const [y, mo, d, h, mi, s] = [year, month, day, hour, minute, second].map(Number); const ms = Number(fraction.slice(0, 3).padEnd(3, "0")); const calendar = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms)); if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59 || calendar.getUTCFullYear() !== y || calendar.getUTCMonth() !== mo - 1 || calendar.getUTCDate() !== d || (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59))) return NaN; return Date.parse(value); }
