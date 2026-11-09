import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalJson } from "./lib/manifest-validation.mjs";
import { sha256 } from "../lib/hash.mjs";
import { rsaSha256Signature } from "./lib/manifest-signing.mjs";
import { validateMapCatalogSignedCurrentPublication } from "./validate-map-catalog-signed-current-publication.mjs";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" });
const publicKey = pair.publicKey.export({ type: "spki", format: "pem" });
process.env.EASYSUBWAY_DATAPACK_SIGNING_KEY_ID = "map-catalog-current-v1";

test("content descriptor의 canonical self hash·signature·full producer/release/station-set binding을 검증한다", () => {
  const descriptor = signedDescriptor();
  assert.deepEqual(validateMapCatalogSignedCurrentPublication(descriptor, { publicKey }), descriptor);
  for (const mutate of [
    (value) => { value.producerGitSha = "d".repeat(40); },
    (value) => { value.releaseSequence = 8; },
    (value) => { value.stationCatalogPack.manifest.stationSetSha256 = "d".repeat(64); },
    (value) => { value.publicationReceipt = {}; },
    (value) => { value.signature.value = "invalid"; },
    (value) => { value.mapPack.objects.push(value.mapPack.objects[0]); },
    (value) => { value.mapPack.objects[1].path = "../payload/route.sqlite"; },
    (value) => { value.mapPack.objects[0].sha256 = "0".repeat(64); },
    (value) => { value.mapPack.objects[1] = structuredClone(value.mapPack.objects[0]); },
    (value) => { value.freshUntil = "2000-01-01T00:00:00.000Z"; },
  ]) { const changed = structuredClone(descriptor); mutate(changed); assert.throws(() => validateMapCatalogSignedCurrentPublication(changed, { publicKey })); }
  const resealed = resealManifestDrift(descriptor);
  assert.throws(() => validateMapCatalogSignedCurrentPublication(resealed, { publicKey }), /manifest object binding mismatch/);
  const arrayCoercion = structuredClone(descriptor); arrayCoercion.producerGitSha = ["a".repeat(40)];
  assert.throws(() => validateMapCatalogSignedCurrentPublication(arrayCoercion, { publicKey }), /identity mismatch/);
  const shaArray = structuredClone(descriptor); shaArray.signedFinalDescriptorSha256 = ["b".repeat(64)];
  assert.throws(() => validateMapCatalogSignedCurrentPublication(shaArray, { publicKey }), /identity mismatch/);
  const timezoneLess = structuredClone(descriptor); timezoneLess.freshUntil = "2099-01-01T00:00:00.000";
  assert.throws(() => validateMapCatalogSignedCurrentPublication(timezoneLess, { publicKey }), /identity mismatch/);
  const descriptorSchema = JSON.parse(readFileSync("contracts/datapack/map-catalog-signed-current-publication.schema.json", "utf8"));
  const receiptSchema = JSON.parse(readFileSync("contracts/datapack/map-catalog-signed-current-publication-receipt.schema.json", "utf8"));
  assert.equal(Object.hasOwn(descriptorSchema.properties, "publicationReceipt"), false);
  assert.equal(Object.hasOwn(descriptorSchema.properties, "publicationReceiptSha256"), false);
  assert.equal(descriptorSchema.properties.mapPack.$ref.endsWith("#/$defs/mapPack"), true);
  assert.deepEqual(receiptSchema.$defs.mapPack.properties.objects.prefixItems.map((item) => item.$ref), ["#/$defs/mapManifestObject", "#/$defs/mapInterchangeObject", "#/$defs/mapStylesObject", "#/$defs/mapSvgObject", "#/$defs/mapStationsObject"]);
});

function signedDescriptor() {
  const stationSetSha256 = "c".repeat(64); const mapPack = pack("map-pack", stationSetSha256, ["manifest.json", "payload/interchange-layout.json", "payload/line-styles.json", "payload/metropolitan.svg", "payload/stations-layout.json"]); const stationCatalogPack = pack("station-catalog-pack", stationSetSha256, ["manifest.json", "payload/catalog.sqlite"]); const identity = { producerGitSha: "a".repeat(40), releaseSequence: 7, signedFinalDescriptorSha256: "b".repeat(64), stationSetSha256, freshUntil: "2099-01-01T00:00:00.000Z" };
  return sign({ schemaVersion: 1, artifactKind: "map-catalog-signed-current-publication", ...identity, mapPack, stationCatalogPack }, "descriptorSha256");
}
function pack(kind, stationSetSha256, paths) { const payload = paths.filter((path) => path !== "manifest.json").map((path, index) => ({ path, sizeBytes: index + 1, sha256: `${index}`.repeat(64) })); const manifest = { manifestVersion: 1, artifactKind: kind, [kind === "map-pack" ? "mapPackId" : "catalogPackId"]: "current", stationSetSha256, payloadSha256: sha256(Buffer.from(canonicalJson(payload))) }; const manifestBytes = Buffer.from(canonicalJson(manifest)); return { manifest, objects: [{ path: "manifest.json", sizeBytes: manifestBytes.length, sha256: sha256(manifestBytes) }, ...payload] }; }
function sign(value, digestField, customKeyId = "map-catalog-current-v1", customPrivateKey = privateKey) { const unsigned = { ...structuredClone(value), keyId: customKeyId }; const digest = sha256(Buffer.from(canonicalJson(unsigned))); const bound = { ...unsigned, [digestField]: digest }; return { ...bound, signature: { algorithm: "rsa-sha256-map-catalog-signed-current-v1", value: rsaSha256Signature(customPrivateKey, canonicalJson(bound)) } }; }
function resealManifestDrift(descriptor) { const changed = structuredClone(descriptor); changed.mapPack.manifest.mapPackId = "rebound"; return sign({ schemaVersion: changed.schemaVersion, artifactKind: changed.artifactKind, producerGitSha: changed.producerGitSha, releaseSequence: changed.releaseSequence, signedFinalDescriptorSha256: changed.signedFinalDescriptorSha256, stationSetSha256: changed.stationSetSha256, freshUntil: changed.freshUntil, mapPack: changed.mapPack, stationCatalogPack: changed.stationCatalogPack }, "descriptorSha256"); }

test("validateMapCatalogSignedCurrentPublication은 next 서명 공개키 설정 시 회전된 keyId를 수용하고 교차 키·미등록 keyId를 거부한다", () => {
  const nextPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const nextPrivateKey = nextPair.privateKey.export({ type: "pkcs8", format: "pem" });
  const nextPublicKey = nextPair.publicKey.export({ type: "spki", format: "pem" });
  const stationSetSha256 = "c".repeat(64);
  const mapPack = pack("map-pack", stationSetSha256, ["manifest.json", "payload/interchange-layout.json", "payload/line-styles.json", "payload/metropolitan.svg", "payload/stations-layout.json"]);
  const stationCatalogPack = pack("station-catalog-pack", stationSetSha256, ["manifest.json", "payload/catalog.sqlite"]);
  const base = { schemaVersion: 1, artifactKind: "map-catalog-signed-current-publication", producerGitSha: "a".repeat(40), releaseSequence: 7, signedFinalDescriptorSha256: "b".repeat(64), stationSetSha256, freshUntil: "2099-01-01T00:00:00.000Z", mapPack, stationCatalogPack };

  const prevPrimaryPem = process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM;
  const prevNextKeyId = process.env.EASYSUBWAY_DATAPACK_NEXT_SIGNING_KEY_ID;
  const prevNextPem = process.env.EASYSUBWAY_DATAPACK_NEXT_SIGNING_PUBLIC_KEY_PEM;
  process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM = publicKey;
  process.env.EASYSUBWAY_DATAPACK_NEXT_SIGNING_KEY_ID = "map-catalog-current-v2";
  process.env.EASYSUBWAY_DATAPACK_NEXT_SIGNING_PUBLIC_KEY_PEM = nextPublicKey;
  try {
    const rotatedDescriptor = sign(base, "descriptorSha256", "map-catalog-current-v2", nextPrivateKey);
    assert.deepEqual(validateMapCatalogSignedCurrentPublication(rotatedDescriptor), rotatedDescriptor);

    const crossSignedDescriptor = sign(base, "descriptorSha256", "map-catalog-current-v2", privateKey);
    assert.throws(() => validateMapCatalogSignedCurrentPublication(crossSignedDescriptor), /descriptor signature mismatch/);

    const unknownKeyDescriptor = sign(base, "descriptorSha256", "map-catalog-unknown-v9", nextPrivateKey);
    assert.throws(() => validateMapCatalogSignedCurrentPublication(unknownKeyDescriptor), /descriptor identity mismatch/);
  } finally {
    if (prevPrimaryPem === undefined) delete process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM;
    else process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM = prevPrimaryPem;
    if (prevNextKeyId === undefined) delete process.env.EASYSUBWAY_DATAPACK_NEXT_SIGNING_KEY_ID;
    else process.env.EASYSUBWAY_DATAPACK_NEXT_SIGNING_KEY_ID = prevNextKeyId;
    if (prevNextPem === undefined) delete process.env.EASYSUBWAY_DATAPACK_NEXT_SIGNING_PUBLIC_KEY_PEM;
    else process.env.EASYSUBWAY_DATAPACK_NEXT_SIGNING_PUBLIC_KEY_PEM = prevNextPem;
  }
});

