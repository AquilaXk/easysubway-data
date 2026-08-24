import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";
import { rsaSha256Signature } from "./lib/manifest-signing.mjs";
import { validateMapCatalogSignedCurrentPublication } from "./validate-map-catalog-signed-current-publication.mjs";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" });
const publicKey = pair.publicKey.export({ type: "spki", format: "pem" });
process.env.EASYSUBWAY_DATAPACK_SIGNING_KEY_ID = "map-catalog-current-v1";

test("descriptor와 receipt의 canonical self hash·signature·full producer/release/station-set binding을 검증한다", () => {
  const descriptor = signedDescriptor();
  assert.deepEqual(validateMapCatalogSignedCurrentPublication(descriptor, { publicKey }), descriptor);
  for (const mutate of [
    (value) => { value.producerGitSha = "d".repeat(40); },
    (value) => { value.releaseSequence = 8; },
    (value) => { value.stationCatalogPack.manifest.stationSetSha256 = "d".repeat(64); },
    (value) => { value.publicationReceiptSha256 = "d".repeat(64); },
    (value) => { value.signature.value = "invalid"; },
    (value) => { value.mapPack.objects.push(value.mapPack.objects[0]); },
    (value) => { value.mapPack.objects[1].path = "../payload/route.sqlite"; },
    (value) => { value.mapPack.objects[0].sha256 = "0".repeat(64); },
    (value) => { value.mapPack.objects[1] = structuredClone(value.mapPack.objects[0]); },
    (value) => { value.freshUntil = "2000-01-01T00:00:00.000Z"; },
  ]) { const changed = structuredClone(descriptor); mutate(changed); assert.throws(() => validateMapCatalogSignedCurrentPublication(changed, { publicKey })); }
  const resealed = resealManifestDrift(descriptor);
  assert.throws(() => validateMapCatalogSignedCurrentPublication(resealed, { publicKey }), /manifest object binding mismatch/);
  const receiptSchema = JSON.parse(readFileSync("contracts/datapack/map-catalog-signed-current-publication-receipt.schema.json", "utf8"));
  const descriptorSchema = JSON.parse(readFileSync("contracts/datapack/map-catalog-signed-current-publication.schema.json", "utf8"));
  assert.equal(descriptorSchema.properties.mapPack.$ref.endsWith("#/$defs/mapPack"), true);
  assert.deepEqual(receiptSchema.$defs.mapPack.properties.objects.prefixItems.map((item) => item.$ref), ["#/$defs/mapManifestObject", "#/$defs/mapInterchangeObject", "#/$defs/mapStylesObject", "#/$defs/mapSvgObject", "#/$defs/mapStationsObject"]);
  assert.equal(receiptSchema.$defs.catalogPack.properties.objects.items, false);
});

function signedDescriptor() {
  const stationSetSha256 = "c".repeat(64); const mapPack = pack("map-pack", stationSetSha256, ["manifest.json", "payload/interchange-layout.json", "payload/line-styles.json", "payload/metropolitan.svg", "payload/stations-layout.json"]); const stationCatalogPack = pack("station-catalog-pack", stationSetSha256, ["manifest.json", "payload/catalog.sqlite"]); const identity = { producerGitSha: "a".repeat(40), releaseSequence: 7, signedFinalDescriptorSha256: "b".repeat(64), stationSetSha256, freshUntil: "2099-01-01T00:00:00.000Z" };
  const receipt = sign({ schemaVersion: 1, artifactKind: "map-catalog-signed-current-publication-receipt", ...identity, mapPack, stationCatalogPack }, "receiptSha256");
  return sign({ schemaVersion: 1, artifactKind: "map-catalog-signed-current-publication", ...identity, mapPack, stationCatalogPack, publicationReceipt: receipt, publicationReceiptSha256: receipt.receiptSha256 }, "descriptorSha256");
}
function pack(kind, stationSetSha256, paths) { const payload = paths.filter((path) => path !== "manifest.json").map((path, index) => ({ path, sizeBytes: index + 1, sha256: `${index}`.repeat(64) })); const manifest = { manifestVersion: 1, artifactKind: kind, [kind === "map-pack" ? "mapPackId" : "catalogPackId"]: "current", stationSetSha256, payloadSha256: sha256(Buffer.from(canonicalJson(payload))) }; const manifestBytes = Buffer.from(canonicalJson(manifest)); return { manifest, objects: [{ path: "manifest.json", sizeBytes: manifestBytes.length, sha256: sha256(manifestBytes) }, ...payload] }; }
function sign(value, digestField) { const unsigned = { ...structuredClone(value), keyId: "map-catalog-current-v1" }; const digest = sha256(Buffer.from(canonicalJson(unsigned))); const bound = { ...unsigned, [digestField]: digest }; return { ...bound, signature: { algorithm: "rsa-sha256-map-catalog-signed-current-v1", value: rsaSha256Signature(privateKey, canonicalJson(bound)) } }; }
function resealManifestDrift(descriptor) { const changed = structuredClone(descriptor); changed.mapPack.manifest.mapPackId = "rebound"; changed.publicationReceipt.mapPack.manifest.mapPackId = "rebound"; const receipt = changed.publicationReceipt; changed.publicationReceipt = sign({ schemaVersion: receipt.schemaVersion, artifactKind: receipt.artifactKind, producerGitSha: receipt.producerGitSha, releaseSequence: receipt.releaseSequence, signedFinalDescriptorSha256: receipt.signedFinalDescriptorSha256, stationSetSha256: receipt.stationSetSha256, freshUntil: receipt.freshUntil, mapPack: receipt.mapPack, stationCatalogPack: receipt.stationCatalogPack }, "receiptSha256"); changed.publicationReceiptSha256 = changed.publicationReceipt.receiptSha256; return sign({ schemaVersion: changed.schemaVersion, artifactKind: changed.artifactKind, producerGitSha: changed.producerGitSha, releaseSequence: changed.releaseSequence, signedFinalDescriptorSha256: changed.signedFinalDescriptorSha256, stationSetSha256: changed.stationSetSha256, freshUntil: changed.freshUntil, mapPack: changed.mapPack, stationCatalogPack: changed.stationCatalogPack, publicationReceipt: changed.publicationReceipt, publicationReceiptSha256: changed.publicationReceiptSha256 }, "descriptorSha256"); }
