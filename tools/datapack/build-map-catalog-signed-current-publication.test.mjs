import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";
import { buildMapCatalogSignedCurrentPublication } from "./build-map-catalog-signed-current-publication.mjs";
import { validateMapCatalogSignedCurrentPublication } from "./validate-map-catalog-signed-current-publication.mjs";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" });
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
process.env.EASYSUBWAY_DATAPACK_SIGNING_KEY_ID = "map-catalog-current-v1";

test("exact map root manifest+4 payload와 catalog manifest+sqlite를 하나의 signed-current receipt로 결속한다", async (t) => {
  const fixture = await createFixture(t);
  const descriptor = await build(fixture);
  assert.equal(descriptor.producerGitSha, "a".repeat(40));
  assert.equal(descriptor.releaseSequence, 7);
  assert.equal(descriptor.mapPack.objects.length, 5);
  assert.equal(descriptor.stationCatalogPack.objects.length, 2);
  assert.equal(descriptor.mapPack.manifest.stationSetSha256, descriptor.stationCatalogPack.manifest.stationSetSha256);
  assert.equal(descriptor.publicationReceiptSha256, descriptor.publicationReceipt.receiptSha256);
  assert.equal(descriptor.signature.algorithm, "rsa-sha256-map-catalog-signed-current-v1");
  assert.deepEqual(JSON.parse(await readFile(fixture.output, "utf8")), descriptor);
  assert.deepEqual(validateMapCatalogSignedCurrentPublication(descriptor, { publicKey }), descriptor);
});

test("fixed clock이 stale descriptor를 output 0으로 거부한다", async (t) => {
  const fixture = await createFixture(t);
  await assert.rejects(buildMapCatalogSignedCurrentPublication({ artifactRoot: fixture.root, output: fixture.output, producerGitSha: "a".repeat(40), releaseSequence: 7, signedFinalDescriptorSha256: "b".repeat(64), freshUntil: "2099-01-01T00:00:00.000Z", privateKey, publicKey, now: Date.parse("2100-01-01T00:00:00.000Z") }), /freshUntil is invalid/);
  await assert.rejects(readFile(fixture.output), { code: "ENOENT" });
});

test("missing·extra·route/timetable/accessibility·duplicate·traversal·symlink·noncanonical·stale mismatch와 preexisting output은 output 0이다", async (t) => {
  const cases = [
    ["missing", async ({ root }) => unlink(path.join(root, "map-pack/payload/metropolitan.svg"))],
    ["extra", async ({ root }) => writeFile(path.join(root, "map-pack/payload/rogue.json"), "x")],
    ["route", async ({ root }) => writeFile(path.join(root, "map-pack/payload/route.sqlite"), "x")],
    ["timetable", async ({ root }) => writeFile(path.join(root, "map-pack/payload/timetable.sqlite"), "x")],
    ["accessibility", async ({ root }) => writeFile(path.join(root, "map-pack/payload/accessibility.sqlite"), "x")],
    ["symlink", async ({ root }) => { await unlink(path.join(root, "station-catalog-pack/payload/catalog.sqlite")); await symlink("../../map-pack/manifest.json", path.join(root, "station-catalog-pack/payload/catalog.sqlite")); }],
    ["noncanonical", async ({ root }) => writeFile(path.join(root, "map-pack/manifest.json"), " { }\n")],
    ["preexisting", async ({ output }) => writeFile(output, "old")],
  ];
  for (const [name, mutate] of cases) {
    const fixture = await createFixture(t); await mutate(fixture);
    await assert.rejects(build(fixture), undefined, name);
    if (name === "preexisting") assert.equal(await readFile(fixture.output, "utf8"), "old");
    else await assert.rejects(readFile(fixture.output), { code: "ENOENT" }, name);
  }
  const traversal = await createFixture(t);
  await assert.rejects(build({ ...traversal, output: `${traversal.root}/../escape.json` }), /output path traversal/);
  const stale = await createFixture(t);
  await assert.rejects(buildMapCatalogSignedCurrentPublication({ artifactRoot: stale.root, output: stale.output, producerGitSha: "a".repeat(40), releaseSequence: 7, signedFinalDescriptorSha256: "b".repeat(64), freshUntil: "2000-01-01T00:00:00.000Z", privateKey, publicKey }), /freshUntil is invalid/);
  await assert.rejects(readFile(stale.output), { code: "ENOENT" });
});

async function build(fixture) { return buildMapCatalogSignedCurrentPublication({ artifactRoot: fixture.root, output: fixture.output, producerGitSha: "a".repeat(40), releaseSequence: 7, signedFinalDescriptorSha256: "b".repeat(64), freshUntil: "2099-01-01T00:00:00.000Z", privateKey, publicKey, now: Date.parse("2098-01-01T00:00:00.000Z") }); }
async function createFixture(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "map-catalog-current-")); const root = path.join(parent, "artifact"); const output = path.join(parent, "descriptor.json");
  t.after(() => rm(parent, { recursive: true, force: true }));
  const mapPayload = { "metropolitan.svg": "<svg/>", "stations-layout.json": "[]", "line-styles.json": "[]", "interchange-layout.json": "[]" };
  await mkdir(path.join(root, "map-pack/payload"), { recursive: true }); await mkdir(path.join(root, "station-catalog-pack/payload"), { recursive: true });
  for (const [name, bytes] of Object.entries(mapPayload)) await writeFile(path.join(root, "map-pack/payload", name), bytes);
  await writeFile(path.join(root, "station-catalog-pack/payload/catalog.sqlite"), "sqlite");
  const stationSetSha256 = "c".repeat(64);
  const payload = async (prefix, entries) => {
    const objects = await Promise.all(entries.map(async (relative) => {
      const bytes = await readFile(path.join(root, prefix, relative));
      return { path: relative, sizeBytes: bytes.length, sha256: sha256(bytes) };
    }));
    return sha256(Buffer.from(canonicalJson(objects)));
  };
  const mapManifest = { manifestVersion: 1, artifactKind: "map-pack", mapPackId: "capital", stationSetSha256, payloadSha256: await payload("map-pack", ["payload/interchange-layout.json", "payload/line-styles.json", "payload/metropolitan.svg", "payload/stations-layout.json"]) };
  const catalogManifest = { manifestVersion: 1, artifactKind: "station-catalog-pack", catalogPackId: "catalog", stationSetSha256, payloadSha256: await payload("station-catalog-pack", ["payload/catalog.sqlite"]) };
  await writeFile(path.join(root, "map-pack/manifest.json"), canonicalJson(mapManifest)); await writeFile(path.join(root, "station-catalog-pack/manifest.json"), canonicalJson(catalogManifest));
  return { root, output };
}
