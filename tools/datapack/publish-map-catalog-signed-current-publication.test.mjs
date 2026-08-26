import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";
import { buildMapCatalogSignedCurrentPublication } from "./build-map-catalog-signed-current-publication.mjs";
import { formatMapCatalogOciPublicationHandoff, publishMapCatalogSignedCurrentPublication, publishMapCatalogSignedCurrentPublicationCli } from "./publish-map-catalog-signed-current-publication.mjs";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" });
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
const NOW = Date.parse("2098-01-01T00:00:00.000Z");
process.env.EASYSUBWAY_DATAPACK_SIGNING_KEY_ID = "map-catalog-current-v1";

test("7 object→descriptor→separate receipt 순서로 conditional OCI publish하고 final receipt GET 뒤 성공한다", async (t) => {
  const fixture = await createFixture(t); const calls = []; const storage = new Map();
  const result = await publishMapCatalogSignedCurrentPublication({ ...fixture.input, transport: fakeTransport(storage, calls), now: NOW, clock: () => NOW });
  assert.equal(result.receipt.objects.length, 7);
  assert.equal(result.receiptObjectKey, `map-catalog/v1/content-descriptors/${result.receipt.contentDescriptor.descriptorSha256}/publication-receipts/${result.receipt.receiptSha256}.json`);
  assert.deepEqual(calls.map(({ method }) => method), [...new Array(9).fill(["PUT", "GET"]).flat()]);
  assert.match(calls[14].key, /content-descriptors\/[a-f0-9]{64}\.json$/u);
  assert.equal(calls[16].key, result.receiptObjectKey);
  assert.equal(calls.some(({ key }) => key === `map-catalog/v1/publication-receipts/${result.receipt.receiptSha256}.json`), false);
  assert.deepEqual(JSON.parse(await readFile(fixture.receiptOutput, "utf8")), result.receipt);
  assert.equal(storage.has(result.receiptObjectKey), true);
});

test("preflight local drift와 remote failure는 receipt output/success를 만들지 않는다", async (t) => {
  const drift = await createFixture(t); await unlink(path.join(drift.artifactRoot, "map-pack/payload/metropolitan.svg")); const calls = [];
  await assert.rejects(publishMapCatalogSignedCurrentPublication({ ...drift.input, transport: fakeTransport(new Map(), calls), now: NOW }));
  assert.deepEqual(calls, []); await assert.rejects(readFile(drift.receiptOutput), { code: "ENOENT" });
  const remote = await createFixture(t); const failedCalls = [];
  await assert.rejects(publishMapCatalogSignedCurrentPublication({ ...remote.input, transport: fakeTransport(new Map(), failedCalls, { failAtPut: 8 }), now: NOW }), /OCI conditional PUT failed/);
  assert.equal(failedCalls.some((call) => call.key.includes("publication-receipts")), false);
  await assert.rejects(readFile(remote.receiptOutput), { code: "ENOENT" });
  const receiptPutFailure = await createFixture(t); const receiptCalls = [];
  await assert.rejects(publishMapCatalogSignedCurrentPublication({ ...receiptPutFailure.input, transport: fakeTransport(new Map(), receiptCalls, { failAtPut: 9 }), now: NOW, clock: () => NOW }), /OCI conditional PUT failed/);
  assert.equal(receiptCalls.at(-1).key.includes("publication-receipts"), true);
  assert.deepEqual((await readdir(path.dirname(receiptPutFailure.receiptOutput))).filter((name) => name.startsWith(".map-catalog-publish-")), []);
  await assert.rejects(readFile(receiptPutFailure.receiptOutput), { code: "ENOENT" });
  const receiptGetFailure = await createFixture(t); const receiptGetCalls = [];
  await assert.rejects(publishMapCatalogSignedCurrentPublication({ ...receiptGetFailure.input, transport: fakeTransport(new Map(), receiptGetCalls, { failAtGet: 9 }), now: NOW, clock: () => NOW }), /OCI full GET failed/);
  assert.equal(receiptGetCalls.at(-1).key.includes("publication-receipts"), true);
  assert.deepEqual((await readdir(path.dirname(receiptGetFailure.receiptOutput))).filter((name) => name.startsWith(".map-catalog-publish-")), []);
  await assert.rejects(readFile(receiptGetFailure.receiptOutput), { code: "ENOENT" });
  const malformedOperation = await createFixture(t); const noCalls = [];
  await assert.rejects(publishMapCatalogSignedCurrentPublication({ ...malformedOperation.input, operation: { ...malformedOperation.input.operation, unexpected: true }, transport: fakeTransport(new Map(), noCalls), now: NOW }), /operation identity mismatch/);
  assert.deepEqual(noCalls, []);
});

test("서명 private/public capability와 atomic receipt persist 실패는 원격 호출·잔여 output 없이 닫힌다", async (t) => {
  const mismatch = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
  for (const privateValue of ["", "not-a-private-key", mismatch]) {
    const fixture = await createFixture(t); const calls = [];
    await assert.rejects(publishMapCatalogSignedCurrentPublication({ ...fixture.input, privateKey: privateValue, transport: fakeTransport(new Map(), calls), now: NOW }), /signing key capability mismatch/);
    assert.deepEqual(calls, []);
    await assert.rejects(readFile(fixture.receiptOutput), { code: "ENOENT" });
  }
  const persistFault = await createFixture(t); const calls = [];
  await assert.rejects(publishMapCatalogSignedCurrentPublication({ ...persistFault.input, transport: fakeTransport(new Map(), calls), now: NOW, clock: () => NOW, beforeReceiptPersist: async () => { throw new Error("injected persist fault"); } }), /injected persist fault/);
  await assert.rejects(readFile(persistFault.receiptOutput), { code: "ENOENT" });
  assert.deepEqual((await readdir(path.dirname(persistFault.receiptOutput))).filter((name) => name.startsWith(".map-catalog-publish-") || name.startsWith(".map-catalog-receipt-")), []);
});

test("CLI는 exact publisher credential·runtime identity가 없으면 transport 전에 거부한다", async () => {
  const args = ["--artifact-root", "/artifact", "--descriptor", "/descriptor.json", "--receipt-output", "/receipt.json"];
  await assert.rejects(
    publishMapCatalogSignedCurrentPublicationCli(args, {
      OCI_MAP_CATALOG_NAMESPACE: "example",
      OCI_MAP_CATALOG_BUCKET: "easysubway-map-catalog",
      OCI_MAP_CATALOG_REGION: "ap-seoul-1",
      OCI_MAP_CATALOG_COMPAT_ENDPOINT: "https://example.compat.objectstorage.ap-seoul-1.oraclecloud.com",
      OCI_MAP_CATALOG_OBJECT_PREFIX: "map-catalog",
      OCI_MAP_CATALOG_PUBLISHER_ACCESS_KEY: "access",
      GITHUB_REPOSITORY: "AquilaXk/easysubway-data",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
    }),
    /OCI_MAP_CATALOG_PUBLISHER_SECRET_KEY is required/,
  );
  await assert.rejects(publishMapCatalogSignedCurrentPublicationCli(["--descriptor", "/descriptor.json"]), /usage:/);
});

test("CLI handoff는 descriptor·receipt immutable locator만 출력하고 completion은 descriptor GET 뒤 receipt PUT 전이다", async (t) => {
  const fixture = await createFixture(t); const calls = []; const storage = new Map(); let ticks = 0;
  const result = await publishMapCatalogSignedCurrentPublicationCli(
    ["--artifact-root", fixture.artifactRoot, "--descriptor", fixture.input.descriptorPath, "--receipt-output", fixture.receiptOutput],
    {
      OCI_MAP_CATALOG_NAMESPACE: fixture.input.target.namespace,
      OCI_MAP_CATALOG_BUCKET: fixture.input.target.bucket,
      OCI_MAP_CATALOG_REGION: fixture.input.target.region,
      OCI_MAP_CATALOG_COMPAT_ENDPOINT: fixture.input.target.compatEndpoint,
      OCI_MAP_CATALOG_OBJECT_PREFIX: fixture.input.target.objectPrefix,
      OCI_MAP_CATALOG_PUBLISHER_ACCESS_KEY: fixture.input.credentials.accessKey,
      OCI_MAP_CATALOG_PUBLISHER_SECRET_KEY: fixture.input.credentials.secretKey,
      GITHUB_REPOSITORY: fixture.input.operation.repository,
      GITHUB_SHA: fixture.input.operation.headSha,
      GITHUB_RUN_ID: String(fixture.input.operation.workflowRunId),
      GITHUB_RUN_ATTEMPT: String(fixture.input.operation.runAttempt),
      EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKey,
      EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM: publicKey,
      EASYSUBWAY_DATAPACK_SIGNING_KEY_ID: "map-catalog-current-v1",
    },
    {
      clock: () => { ticks += 1; calls.push({ method: "CLOCK" }); return NOW + ticks * 1000; },
      transport: fakeTransport(storage, calls),
      privateKey,
      publicKey,
    },
  );
  assert.deepEqual(Object.keys(result).sort(), ["descriptorLocator", "descriptorSha256", "receiptLocator", "receiptSha256"]);
  assert.equal(result.descriptorLocator, `oci://example/easysubway-map-catalog/map-catalog/v1/content-descriptors/${result.descriptorSha256}.json`);
  assert.match(result.receiptLocator, new RegExp(`/content-descriptors/${result.descriptorSha256}/publication-receipts/${result.receiptSha256}\\.json$`, "u"));
  assert.equal(calls[16].method, "GET");
  assert.equal(calls[16].key.endsWith(`${result.descriptorSha256}.json`), true);
  assert.equal(calls[17].method, "CLOCK");
  assert.equal(calls[18].method, "PUT");
  assert.equal(calls[18].key.endsWith(`${result.receiptSha256}.json`), true);
  assert.equal(ticks, 2);
  assert.equal(
    formatMapCatalogOciPublicationHandoff(result),
    `DESCRIPTOR_SHA ${result.descriptorSha256}\nDESCRIPTOR_LOCATOR ${result.descriptorLocator}\nRECEIPT_SHA ${result.receiptSha256}\nRECEIPT_LOCATOR ${result.receiptLocator}\n`,
  );
  assert.doesNotMatch(formatMapCatalogOciPublicationHandoff(result), /secret|sqlite|<svg|provider/i);
});

test("completion clock rollback은 descriptor GET 뒤 receipt publish/output 없이 닫힌다", async (t) => {
  const fixture = await createFixture(t); const calls = []; const storage = new Map();
  await assert.rejects(
    publishMapCatalogSignedCurrentPublication({ ...fixture.input, transport: fakeTransport(storage, calls), now: NOW, clock: () => NOW - 1 }),
    /publication completion instant rolled back/,
  );
  assert.equal(calls.length, 16);
  assert.equal(calls.at(-1).method, "GET");
  assert.match(calls.at(-1).key, /content-descriptors\/[a-f0-9]{64}\.json$/u);
  assert.equal(calls.some((call) => call.key.includes("publication-receipts")), false);
  assert.equal([...storage].some(([key]) => key.includes("publication-receipts")), false);
  await assert.rejects(readFile(fixture.receiptOutput), { code: "ENOENT" });
});

function fakeTransport(storage, calls, { failAtPut = null, failAtGet = null } = {}) { let puts = 0; let gets = 0; return { async putObject(request) { calls.push({ method: "PUT", key: request.key, headers: request.headers }); puts += 1; if (puts === failAtPut) return { statusCode: 500 }; storage.set(request.key, Buffer.from(request.body)); return { statusCode: 201 }; }, async getObject(request) { calls.push({ method: "GET", key: request.key }); gets += 1; if (gets === failAtGet) return { statusCode: 500 }; return { statusCode: 200, body: storage.get(request.key) }; } }; }
async function createFixture(t) { const parent = await mkdtemp(path.join(os.tmpdir(), "map-catalog-publish-")); t.after(() => rm(parent, { recursive: true, force: true })); const artifactRoot = path.join(parent, "artifact"); const descriptorPath = path.join(parent, "descriptor.json"); const receiptOutput = path.join(parent, "receipt.json"); await mkdir(path.join(artifactRoot, "map-pack/payload"), { recursive: true }); await mkdir(path.join(artifactRoot, "station-catalog-pack/payload"), { recursive: true }); const mapPayload = { "interchange-layout.json": "[]", "line-styles.json": "[]", "metropolitan.svg": "<svg/>", "stations-layout.json": "[]" }; for (const [name, value] of Object.entries(mapPayload)) await writeFile(path.join(artifactRoot, "map-pack/payload", name), value); await writeFile(path.join(artifactRoot, "station-catalog-pack/payload/catalog.sqlite"), "sqlite"); const stationSetSha256 = "c".repeat(64); const manifest = async (pack, kind, id, paths) => { const objects = await Promise.all(paths.map(async (item) => { const bytes = await readFile(path.join(artifactRoot, pack, item)); return { path: item, sizeBytes: bytes.length, sha256: sha256(bytes) }; })); return { manifestVersion: 1, artifactKind: kind, [id]: "current", stationSetSha256, payloadSha256: sha256(Buffer.from(canonicalJson(objects))) }; }; await writeFile(path.join(artifactRoot, "map-pack/manifest.json"), canonicalJson(await manifest("map-pack", "map-pack", "mapPackId", ["payload/interchange-layout.json", "payload/line-styles.json", "payload/metropolitan.svg", "payload/stations-layout.json"]))); await writeFile(path.join(artifactRoot, "station-catalog-pack/manifest.json"), canonicalJson(await manifest("station-catalog-pack", "station-catalog-pack", "catalogPackId", ["payload/catalog.sqlite"]))); await buildMapCatalogSignedCurrentPublication({ artifactRoot, output: descriptorPath, producerGitSha: "a".repeat(40), releaseSequence: 7, signedFinalDescriptorSha256: "b".repeat(64), freshUntil: "2099-01-01T00:00:00.000Z", privateKey, publicKey, now: NOW }); const target = { namespace: "example", bucket: "easysubway-map-catalog", region: "ap-seoul-1", compatEndpoint: "https://example.compat.objectstorage.ap-seoul-1.oraclecloud.com", objectPrefix: "map-catalog" }; return { artifactRoot, receiptOutput, input: { artifactRoot, descriptorPath, receiptOutput, target, credentials: { accessKey: "access", secretKey: "secret" }, operation: { repository: "AquilaXk/easysubway-data", headSha: "a".repeat(40), workflowRunId: 123, runAttempt: 1 }, privateKey, publicKey } }; }
