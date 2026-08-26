import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";
import { rsaSha256Signature } from "./lib/manifest-signing.mjs";
import { buildMapCatalogSignedCurrentOciPublicationReceipt } from "./build-map-catalog-signed-current-oci-publication-receipt.mjs";
import { validateMapCatalogSignedCurrentOciPublicationReceipt } from "./validate-map-catalog-signed-current-oci-publication-receipt.mjs";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" });
const publicKey = pair.publicKey.export({ type: "spki", format: "pem" });
process.env.EASYSUBWAY_DATAPACK_SIGNING_KEY_ID = "map-catalog-current-v1";

test("receipt는 descriptor의 정확한 7개 inventory, closed OCI keys, full GET와 self hash·signature를 결속한다", async (t) => {
  const descriptor = signedDescriptor(privateKey);
  const parent = await mkdtemp(path.join(os.tmpdir(), "map-catalog-oci-validator-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const receipt = await buildMapCatalogSignedCurrentOciPublicationReceipt({ descriptor, output: path.join(parent, "receipt.json"), ...receiptInput(descriptor), privateKey, publicKey, now: Date.parse("2098-01-01T00:00:00.000Z") });
  assert.deepEqual(validateMapCatalogSignedCurrentOciPublicationReceipt(receipt, { descriptor, publicKey, now: Date.parse("2098-01-01T00:00:00.000Z") }), receipt);
  for (const mutate of [
    (value) => { value.contentDescriptor.objectKey = "map-catalog/v1/content-descriptors/other/descriptor.json"; },
    (value) => { value.contentDescriptor.objectKey = `map-catalog/v1/content-descriptors/${descriptor.descriptorSha256}/descriptor.json`; },
    (value) => { value.objects[5].pack = "map-pack"; },
    (value) => { value.objects[0].path = "payload/route.sqlite"; },
    (value) => { value.objects[0].fullGet.sizeBytes += 1; },
    (value) => { value.target.namespace = ["example"]; },
    (value) => { value.operation.headSha = "d".repeat(40); },
    (value) => { value.operation.completedAt = "2099-01-02T00:00:00.000Z"; },
    (value) => { value.signature.value = "invalid"; },
    (value) => { value.objectKey = "receipt.json"; },
  ]) { const changed = structuredClone(receipt); mutate(changed); assert.throws(() => validateMapCatalogSignedCurrentOciPublicationReceipt(changed, { descriptor, publicKey, now: Date.parse("2098-01-01T00:00:00.000Z") })); }
  const coercedTarget = structuredClone(receipt); coercedTarget.target.namespace = ["example"];
  assert.throws(() => validateMapCatalogSignedCurrentOciPublicationReceipt(coercedTarget, { descriptor, publicKey, now: Date.parse("2098-01-01T00:00:00.000Z") }), /target identity mismatch/);
  const futureCompletion = structuredClone(receipt); futureCompletion.operation.completedAt = "2099-01-02T00:00:00.000Z";
  assert.throws(() => validateMapCatalogSignedCurrentOciPublicationReceipt(futureCompletion, { descriptor, publicKey, now: Date.parse("2098-01-01T00:00:00.000Z") }), /operation identity mismatch/);
  const schema = JSON.parse(await readFile("contracts/datapack/map-catalog-signed-current-publication-receipt.schema.json", "utf8"));
  assert.deepEqual(schema.required, ["schemaVersion", "artifactKind", "producerGitSha", "releaseSequence", "signedFinalDescriptorSha256", "stationSetSha256", "freshUntil", "target", "contentDescriptor", "objects", "operation", "receiptSha256", "keyId", "signature"]);
  assert.deepEqual(schema.properties.objects, {
    type: "array",
    minItems: 7,
    maxItems: 7,
    prefixItems: [
      { $ref: "#/$defs/mapPublicationManifestObject" },
      { $ref: "#/$defs/mapPublicationInterchangeObject" },
      { $ref: "#/$defs/mapPublicationStylesObject" },
      { $ref: "#/$defs/mapPublicationSvgObject" },
      { $ref: "#/$defs/mapPublicationStationsObject" },
      { $ref: "#/$defs/catalogPublicationManifestObject" },
      { $ref: "#/$defs/catalogPublicationSqliteObject" },
    ],
    items: false,
  });
  for (const [definition, pack, objectPath] of [
    ["mapPublicationManifestObject", "map-pack", "manifest.json"],
    ["mapPublicationInterchangeObject", "map-pack", "payload/interchange-layout.json"],
    ["mapPublicationStylesObject", "map-pack", "payload/line-styles.json"],
    ["mapPublicationSvgObject", "map-pack", "payload/metropolitan.svg"],
    ["mapPublicationStationsObject", "map-pack", "payload/stations-layout.json"],
    ["catalogPublicationManifestObject", "station-catalog-pack", "manifest.json"],
    ["catalogPublicationSqliteObject", "station-catalog-pack", "payload/catalog.sqlite"],
  ]) {
    assert.deepEqual(schema.$defs[definition], {
      allOf: [
        { $ref: "#/$defs/object" },
        { properties: { pack: { const: pack }, path: { const: objectPath } } },
      ],
    });
  }
  assert.equal(Object.hasOwn(schema.properties, "mapPack"), false);
  assert.equal(Object.hasOwn(schema.properties, "stationCatalogPack"), false);
});

export function signedDescriptor(privatePem) {
  const stationSetSha256 = "c".repeat(64);
  const mapPack = pack("map-pack", stationSetSha256, ["manifest.json", "payload/interchange-layout.json", "payload/line-styles.json", "payload/metropolitan.svg", "payload/stations-layout.json"]);
  const stationCatalogPack = pack("station-catalog-pack", stationSetSha256, ["manifest.json", "payload/catalog.sqlite"]);
  return sign({ schemaVersion: 1, artifactKind: "map-catalog-signed-current-publication", producerGitSha: "a".repeat(40), releaseSequence: 7, signedFinalDescriptorSha256: "b".repeat(64), stationSetSha256, freshUntil: "2099-01-01T00:00:00.000Z", mapPack, stationCatalogPack }, "descriptorSha256", privatePem);
}

export function receiptInput(descriptor) {
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
