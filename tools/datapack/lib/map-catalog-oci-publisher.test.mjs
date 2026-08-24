import assert from "node:assert/strict";
import test from "node:test";

import { createMapCatalogOciPublisher, createMapCatalogOciS3CompatTransport, putCreateOnlyAndFullGet } from "./map-catalog-oci-publisher.mjs";

const target = { namespace: "example", bucket: "easysubway-map-catalog", region: "ap-seoul-1", compatEndpoint: "https://example.compat.objectstorage.ap-seoul-1.oraclecloud.com", objectPrefix: "map-catalog" };
const credentials = { accessKey: "access", secretKey: "secret" };

test("OCI compat transport는 conditional create-only PUT 뒤 exact full GET만 수행한다", async () => {
  const calls = []; const stored = new Map();
  const publisher = createMapCatalogOciPublisher({ target, credentials, transport: {
    async putObject(request) { calls.push(request); stored.set(request.key, Buffer.from(request.body)); return { statusCode: 201 }; },
    async getObject(request) { calls.push(request); return { statusCode: 200, body: stored.get(request.key) }; },
  } });
  const fullGet = await putCreateOnlyAndFullGet(publisher, { key: "map-catalog/v1/content-descriptors/a.json", bytes: Buffer.from("bytes") });
  assert.deepEqual(fullGet, { statusCode: 200, sizeBytes: 5, sha256: "277089d91c0bdf4f2e6862ba7e4a07605119431f5d13f726dd352b06f1b206a9" });
  assert.deepEqual(calls.map((call) => call.method), ["PUT", "GET"]);
  assert.equal(calls[0].headers["if-none-match"], "*");
  assert.equal(calls.every((call) => call.endpoint === target.compatEndpoint && call.credentials === credentials), true);
});

test("412 collision과 non-compat endpoint는 GET reuse 없이 fail closed한다", async () => {
  const calls = [];
  const publisher = createMapCatalogOciPublisher({ target, credentials, transport: {
    async putObject(request) { calls.push(request); return { statusCode: 412 }; },
    async getObject(request) { calls.push(request); return { statusCode: 200, body: Buffer.from("old") }; },
  } });
  await assert.rejects(putCreateOnlyAndFullGet(publisher, { key: "map-catalog/v1/content-descriptors/a.json", bytes: Buffer.from("new") }), /immutable collision/);
  assert.deepEqual(calls.map((call) => call.method), ["PUT"]);
  assert.throws(() => createMapCatalogOciPublisher({ target: { ...target, compatEndpoint: "https://s3.amazonaws.com" }, credentials, transport: {} }), /compat endpoint mismatch/);
});

test("full GET byte drift는 create-only PUT 이후에도 fail closed한다", async () => {
  const publisher = createMapCatalogOciPublisher({ target, credentials, transport: {
    async putObject() { return { statusCode: 201 }; },
    async getObject() { return { statusCode: 200, body: Buffer.from("different") }; },
  } });
  await assert.rejects(putCreateOnlyAndFullGet(publisher, { key: "map-catalog/v1/content-descriptors/a.json", bytes: Buffer.from("expected") }), /OCI full GET mismatch/);
});

test("OCI S3-compat signed transport는 exact target에 PUT/GET만 위임한다", async () => {
  const calls = [];
  const transport = createMapCatalogOciS3CompatTransport({
    target,
    credentials,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return { status: init.method === "PUT" ? 201 : 200, arrayBuffer: async () => Buffer.from("bytes") };
    },
  });
  const request = { endpoint: target.compatEndpoint, namespace: target.namespace, bucket: target.bucket, key: "map-catalog/v1/content-descriptors/a.json", body: Buffer.from("bytes") };
  assert.deepEqual(await transport.putObject(request), { statusCode: 201 });
  assert.deepEqual(await transport.getObject(request), { statusCode: 200, body: Buffer.from("bytes") });
  assert.deepEqual(calls.map(({ init }) => init.method), ["PUT", "GET"]);
  assert.equal(calls[0].url, "https://example.compat.objectstorage.ap-seoul-1.oraclecloud.com/easysubway-map-catalog/map-catalog/v1/content-descriptors/a.json");
  assert.equal(calls[0].init.headers["if-none-match"], "*");
  assert.equal(calls.every(({ init }) => init.redirect === "error"), true);
  await assert.rejects(transport.getObject({ ...request, endpoint: "https://s3.amazonaws.com" }), /OCI transport target mismatch/);
  assert.equal(calls.length, 2);
});
