import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildMapCatalogSignedCurrentOciPublicationReceipt } from "./build-map-catalog-signed-current-oci-publication-receipt.mjs";
import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";
import { rsaSha256Signature } from "./lib/manifest-signing.mjs";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" });
const publicKey = pair.publicKey.export({ type: "spki", format: "pem" });
process.env.EASYSUBWAY_DATAPACK_SIGNING_KEY_ID = "map-catalog-current-v1";

test("서명 content descriptor의 정확한 7개 object GET 증거를 별도 OCI receipt로 생산한다", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "map-catalog-oci-receipt-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const descriptor = signedDescriptor(privateKey);
  const output = path.join(parent, "receipt.json");
  const receipt = await buildMapCatalogSignedCurrentOciPublicationReceipt({
    descriptor,
    output,
    ...receiptInput(descriptor),
    privateKey,
    publicKey,
    now: Date.parse("2098-01-01T00:00:00.000Z"),
  });
  assert.equal(receipt.artifactKind, "map-catalog-signed-current-oci-publication-receipt");
  assert.equal(receipt.contentDescriptor.descriptorSha256, descriptor.descriptorSha256);
  assert.equal(receipt.objects.length, 7);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), receipt);
  assert.equal(Object.hasOwn(receipt, "objectKey"), false);
  assert.equal(Object.hasOwn(receipt, "rawSha256"), false);
});

test("descriptor inventory 밖 object·wrong key·GET drift와 occupied output은 fail closed한다", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "map-catalog-oci-receipt-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const descriptor = signedDescriptor(privateKey);
  const build = (input) => buildMapCatalogSignedCurrentOciPublicationReceipt({ descriptor, output: path.join(parent, "receipt.json"), ...input, privateKey, publicKey, now: Date.parse("2098-01-01T00:00:00.000Z") });
  const extra = receiptInput(descriptor); extra.objects.push(structuredClone(extra.objects[0]));
  await assert.rejects(build(extra), /object inventory mismatch/);
  const wrongKey = receiptInput(descriptor); wrongKey.objects[0].objectKey = "map-catalog/v1/content-descriptors/x/route.sqlite";
  await assert.rejects(build(wrongKey), /objectKey mismatch/);
  const getDrift = receiptInput(descriptor); getDrift.objects[0].fullGet.sha256 = "f".repeat(64);
  await assert.rejects(build(getDrift), /full GET mismatch/);
  const obsoleteLayout = receiptInput(descriptor); const root = `${obsoleteLayout.target.objectPrefix}/v1/content-descriptors/${descriptor.descriptorSha256}`;
  obsoleteLayout.contentDescriptor.objectKey = `${root}/descriptor.json`;
  await assert.rejects(build(obsoleteLayout), /content descriptor binding mismatch/);
  const occupied = receiptInput(descriptor); await build(occupied);
  await assert.rejects(build(occupied), /output already exists/);
});

function signedDescriptor(privatePem) {
  const stationSetSha256 = "c".repeat(64);
  const mapPack = pack("map-pack", stationSetSha256, ["manifest.json", "payload/interchange-layout.json", "payload/line-styles.json", "payload/metropolitan.svg", "payload/stations-layout.json"]);
  const stationCatalogPack = pack("station-catalog-pack", stationSetSha256, ["manifest.json", "payload/catalog.sqlite"]);
  return sign({ schemaVersion: 1, artifactKind: "map-catalog-signed-current-publication", producerGitSha: "a".repeat(40), releaseSequence: 7, signedFinalDescriptorSha256: "b".repeat(64), stationSetSha256, freshUntil: "2099-01-01T00:00:00.000Z", mapPack, stationCatalogPack }, "descriptorSha256", privatePem);
}

function receiptInput(descriptor) {
  const target = { namespace: "example", bucket: "easysubway-map-catalog", region: "ap-seoul-1", compatEndpoint: "https://example.compat.objectstorage.ap-seoul-1.oraclecloud.com", objectPrefix: "map-catalog" };
  const root = `${target.objectPrefix}/v1/content-descriptors/${descriptor.descriptorSha256}`;
  const descriptorBytes = Buffer.from(canonicalJson(descriptor));
  const objects = [
    ...descriptor.mapPack.objects.map((object) => ({ pack: "map-pack", path: object.path, objectKey: `${root}/objects/map-pack/${object.path}`, sizeBytes: object.sizeBytes, sha256: object.sha256, fullGet: { statusCode: 200, sizeBytes: object.sizeBytes, sha256: object.sha256 } })),
    ...descriptor.stationCatalogPack.objects.map((object) => ({ pack: "station-catalog-pack", path: object.path, objectKey: `${root}/objects/station-catalog-pack/${object.path}`, sizeBytes: object.sizeBytes, sha256: object.sha256, fullGet: { statusCode: 200, sizeBytes: object.sizeBytes, sha256: object.sha256 } })),
  ];
  return { target, contentDescriptor: { objectKey: `${target.objectPrefix}/v1/content-descriptors/${descriptor.descriptorSha256}.json`, sizeBytes: descriptorBytes.length, rawSha256: sha256(descriptorBytes), fullGet: { statusCode: 200, sizeBytes: descriptorBytes.length, sha256: sha256(descriptorBytes) } }, objects, operation: { repository: "AquilaXk/easysubway-data", headSha: descriptor.producerGitSha, workflowRunId: 123, runAttempt: 1, completedAt: "2098-01-01T00:00:00.000Z" } };
}

function pack(kind, stationSetSha256, paths) { const payload = paths.filter((item) => item !== "manifest.json").map((item, index) => ({ path: item, sizeBytes: index + 1, sha256: `${index}`.repeat(64) })); const manifest = { manifestVersion: 1, artifactKind: kind, [kind === "map-pack" ? "mapPackId" : "catalogPackId"]: "current", stationSetSha256, payloadSha256: sha256(Buffer.from(canonicalJson(payload))) }; const bytes = Buffer.from(canonicalJson(manifest)); return { manifest, objects: [{ path: "manifest.json", sizeBytes: bytes.length, sha256: sha256(bytes) }, ...payload] }; }
function sign(value, digestField, privatePem) { const unsigned = { ...structuredClone(value), keyId: "map-catalog-current-v1" }; const bound = { ...unsigned, [digestField]: sha256(Buffer.from(canonicalJson(unsigned))) }; return { ...bound, signature: { algorithm: "rsa-sha256-map-catalog-signed-current-v1", value: rsaSha256Signature(privatePem, canonicalJson(bound)) } }; }
