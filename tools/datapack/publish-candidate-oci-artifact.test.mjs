import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCandidateOciClient, publishCandidateOciArtifact, sigV4ObjectPath } from "./publish-candidate-oci-artifact.mjs";
import { buildCandidateOciArtifactDescriptor } from "./build-candidate-oci-artifact-descriptor.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("payload 전량 conditional create·GET readback 뒤 descriptor, descriptor readback 뒤 publication receipt를 마지막으로 저장한다", async () => {
  const fixture = await createFixture(); const calls = []; const stored = new Map();
  const client = {
    identity: { namespace: "namespace", bucket: "candidate-private" },
    async putObjectIfAbsent(key, bytes) {
      calls.push(`put:${key}`);
      if (stored.has(key)) throw new Error("OCI conditional PUT collision 412");
      const etag = `etag-${hash(bytes)}`;
      const versionId = `vid-${calls.length}`;
      stored.set(key, { bytes: Buffer.from(bytes), etag, versionId });
      return { etag, versionId };
    },
    async readObject(key, versionId) {
      calls.push(`get:${key}`);
      if (!stored.has(key)) return { exists: false };
      const obj = stored.get(key);
      assert.equal(versionId, obj.versionId);
      return { exists: true, body: obj.bytes, etag: obj.etag, versionId: obj.versionId };
    },
  };
  try {
    const result = await publishCandidateOciArtifact({ root: fixture.root, descriptor: fixture.descriptorPath, client, now: () => Date.parse("2026-08-24T00:00:00.000Z") });
    assert.equal(result.artifactId, hash(await readFile(fixture.descriptorPath)));
    assert.ok(result.receiptLocator.endsWith("/receipts/candidate-publication-receipt.json"));
    assert.match(result.receiptSha256, /^[a-f0-9]{64}$/);
    assert.equal(calls.at(-2).endsWith("/receipts/candidate-publication-receipt.json"), true);
    assert.equal(calls.at(-1).endsWith("/receipts/candidate-publication-receipt.json"), true);
    // 6 payloads + 1 descriptor + 1 receipt = 8 stored objects
    assert.equal([...stored].length, 8);

    const receiptEntry = stored.get(calls.at(-1).slice(4));
    assert.ok(receiptEntry);
    const receipt = JSON.parse(receiptEntry.bytes.toString("utf8"));
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.artifactKind, "datapack-candidate-oci-publication-receipt");
    assert.equal(receipt.contractVersion, "datapack-candidate-publication-receipt-v1");
    assert.equal(receipt.descriptor.artifactId, result.artifactId);
    assert.equal(receipt.descriptor.put.versionId, "vid-13");
    assert.equal(receipt.descriptor.get.versionId, "vid-13");
    assert.equal(receipt.objects.length, 6);
    assert.equal(receipt.locator, result.receiptLocator);
  } finally { await fixture.cleanup(); }
});

test("payload readback failure는 descriptor write와 success를 만들지 않는다", async () => {
  const fixture = await createFixture(); const calls = [];
  const client = {
    identity: { namespace: "namespace", bucket: "candidate-private" },
    async putObjectIfAbsent(key) { calls.push(`put:${key}`); return { etag: "tag-1", versionId: "v-1" }; },
    async readObject(key) { calls.push(`get:${key}`); return { exists: true, body: Buffer.from("wrong"), etag: "tag-1", versionId: "v-1" }; },
  };
  try {
    await assert.rejects(publishCandidateOciArtifact({ root: fixture.root, descriptor: fixture.descriptorPath, client, now: () => Date.parse("2026-08-24T00:00:00.000Z") }));
    assert.equal(calls.filter((call) => call.startsWith("put:")).length, 1);
  } finally { await fixture.cleanup(); }
});

test("412 collision 또는 ETag/versionId 불일치는 typed failure로 거부한다", async () => {
  const cases = [
    async (client) => { client.putObjectIfAbsent = async () => { throw new Error("OCI conditional PUT collision 412"); }; },
    async (client) => { client.putObjectIfAbsent = async () => ({ etag: "", versionId: "v1" }); },
    async (client) => { client.readObject = async () => ({ exists: true, body: Buffer.alloc(0), etag: "mismatched", versionId: "v1" }); },
    async (client) => { client.readObject = async () => ({ exists: true, body: Buffer.alloc(0), etag: "etag-1", versionId: "mismatched" }); },
  ];
  for (const mutate of cases) {
    const fixture = await createFixture();
    const client = {
      identity: { namespace: "namespace", bucket: "candidate-private" },
      async putObjectIfAbsent() { return { etag: "etag-1", versionId: "v1" }; },
      async readObject() { return { exists: false }; },
    };
    try {
      await mutate(client);
      await assert.rejects(publishCandidateOciArtifact({ root: fixture.root, descriptor: fixture.descriptorPath, client, now: () => Date.parse("2026-08-24T00:00:00.000Z") }));
    } finally { await fixture.cleanup(); }
  }
});

test("publisher는 builder 결과라도 현재 stage의 forbidden evidence·descriptor expiry drift를 PUT 전에 다시 거부한다", async () => {
  for (const mutate of [
    async (fixture) => writeFile(path.join(fixture.root, "release-decision.json"), "blocked\n"),
    async (fixture) => { const value = JSON.parse(await readFile(fixture.descriptorPath, "utf8")); value.createdAt = "2026-08-25T00:00:00.000Z"; await writeFile(fixture.descriptorPath, `${JSON.stringify(value)}\n`); },
  ]) {
    const fixture = await createFixture(); const calls = [];
    const client = { identity: { namespace: "namespace", bucket: "candidate-private" }, async putObjectIfAbsent() { calls.push("put"); return { etag: "tag", versionId: "v1" }; }, async readObject() { calls.push("get"); return { exists: false }; } };
    try {
      await mutate(fixture);
      await assert.rejects(publishCandidateOciArtifact({ root: fixture.root, descriptor: fixture.descriptorPath, client }));
      assert.deepEqual(calls, []);
    } finally { await fixture.cleanup(); }
  }
});

test("publisher는 reordered·whitespace descriptor raw bytes와 이미 만료된 canonical descriptor를 PUT 전에 거부한다", async () => {
  for (const mutate of [
    async (fixture) => { const value = JSON.parse(await readFile(fixture.descriptorPath, "utf8")); await writeFile(fixture.descriptorPath, `${JSON.stringify({ artifactKind: value.artifactKind, ...value }, null, 2)}\n`); },
    async (fixture) => { const value = JSON.parse(await readFile(fixture.descriptorPath, "utf8")); await writeFile(fixture.descriptorPath, JSON.stringify(value)); },
  ]) {
    const fixture = await createFixture(); const calls = [];
    const client = { identity: { namespace: "namespace", bucket: "candidate-private" }, async putObjectIfAbsent() { calls.push("put"); return { etag: "tag", versionId: "v1" }; }, async readObject() { return { exists: false }; } };
    try {
      await mutate(fixture);
      await assert.rejects(publishCandidateOciArtifact({ root: fixture.root, descriptor: fixture.descriptorPath, client, now: () => Date.parse("2026-08-24T00:00:00.000Z") }));
      assert.deepEqual(calls, []);
    } finally { await fixture.cleanup(); }
  }
  const fixture = await createFixture(); const calls = [];
  const client = { identity: { namespace: "namespace", bucket: "candidate-private" }, async putObjectIfAbsent() { calls.push("put"); return { etag: "tag", versionId: "v1" }; }, async readObject() { return { exists: false }; } };
  try {
    await assert.rejects(publishCandidateOciArtifact({ root: fixture.root, descriptor: fixture.descriptorPath, client, now: () => Date.parse("2026-08-25T00:00:00.000Z") }));
    assert.deepEqual(calls, []);
  } finally { await fixture.cleanup(); }
});

test("payload 중 만료되면 descriptor PUT 없이 partial payload에서 멈춘다", async () => {
  const fixture = await createFixture(); const calls = []; const stored = new Map(); let ticks = 0;
  const client = {
    identity: { namespace: "namespace", bucket: "candidate-private" },
    async putObjectIfAbsent(key, bytes) {
      calls.push(`put:${key}`);
      const etag = `etag-${hash(bytes)}`;
      const versionId = `vid-${calls.length}`;
      stored.set(key, { bytes: Buffer.from(bytes), etag, versionId });
      return { etag, versionId };
    },
    async readObject(key) {
      const obj = stored.get(key);
      return obj ? { exists: true, body: obj.bytes, etag: obj.etag, versionId: obj.versionId } : { exists: false };
    },
  };
  try {
    await assert.rejects(publishCandidateOciArtifact({
      root: fixture.root,
      descriptor: fixture.descriptorPath,
      client,
      now: () => (++ticks === 1 ? Date.parse("2026-08-24T00:00:00.000Z") : Date.parse("2026-08-25T00:00:00.000Z")),
    }));
    const objectCount = JSON.parse(await readFile(fixture.descriptorPath, "utf8")).objects.length;
    assert.equal(calls.length, objectCount);
    assert.ok(calls[0].includes("/objects/"));
  } finally { await fixture.cleanup(); }
});

test("OCI signer는 reserved five characters를 RFC3986 uppercase percent encoding하고 redirect를 fail closed한다", async () => {
  assert.equal(sigV4ObjectPath("candidate-private", "a!b'c(d)e*f/next"), "/candidate-private/a%21b%27c%28d%29e%2Af/next");
  const calls = [];
  const client = createCandidateOciClient(
    {
      EASYSUBWAY_CANDIDATE_OCI_NAMESPACE: "namespace",
      EASYSUBWAY_CANDIDATE_OCI_BUCKET: "candidate-private",
      EASYSUBWAY_CANDIDATE_OCI_REGION: "ap-chuncheon-1",
      EASYSUBWAY_CANDIDATE_OCI_ACCESS_KEY: "access",
      EASYSUBWAY_CANDIDATE_OCI_SECRET_KEY: "secret",
    },
    async (url, init) => {
      calls.push({ url, init });
      return new Response("redirect", { status: 302, headers: { location: "https://elsewhere.example" } });
    }
  );
  await assert.rejects(client.putObjectIfAbsent("a!b'c(d)e*f", Buffer.from("x")));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, "error");
  assert.match(calls[0].url.pathname, /a%21b%27c%28d%29e%2Af$/);
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "candidate-oci-publish-"));
  const catalog = path.join(root, "catalog"); await mkdir(catalog);
  const manifest = Buffer.from("{\"manifestVersion\":2}\n"), provenance = Buffer.from("{\"candidateBuild\":true}\n"), pack = Buffer.from("pack\n");
  await Promise.all([writeFile(path.join(catalog, "current.json"), manifest), writeFile(path.join(root, "current.provenance.json"), provenance), writeFile(path.join(catalog, "capital.sqlite.gz"), pack)]);
  const tuplePath = path.join(root, "datapack-candidate-tuple.json");
  const tuple = { candidateBinding: { candidateId: "candidate-1", buildSpecSha256: "b".repeat(64), manifestSha256: hash(manifest) }, freshnessExpiresAt: "2026-08-25T00:00:00.000Z" };
  await writeFile(tuplePath, `${JSON.stringify(tuple)}\n`);
  const inventoryPath = path.join(root, "data-artifact-inventory.json"), componentPath = path.join(root, "data-component-manifest.json");
  const listed = ["catalog/capital.sqlite.gz", "catalog/current.json", "current.provenance.json", "datapack-candidate-tuple.json"].map(async (item) => {
    const bytes = await readFile(path.join(root, item));
    return { path: item, sizeBytes: bytes.length, sha256: hash(bytes) };
  });
  const inventory = { schemaVersion: 1, artifactKind: "datapack-candidate-inventory", entries: (await Promise.all(listed)).sort((a, b) => a.path.localeCompare(b.path)) };
  const inventoryBytes = Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`);
  const component = {
    schemaVersion: 1,
    component: "data",
    repository: "AquilaXk/easysubway-data",
    gitSha: "a".repeat(40),
    workflowRunId: "42",
    dataVersion: "1",
    releaseSequence: 1,
    manifestSha256: hash(manifest),
    provenance: { sourceSnapshotSetHash: "c".repeat(64) },
    artifactInventorySha256: hash(inventoryBytes),
    contractVersion: "datapack-contract-v3",
    issueRef: "AquilaXk/easysubway-data#529",
  };
  await Promise.all([writeFile(inventoryPath, inventoryBytes), writeFile(componentPath, `${JSON.stringify(component)}\n`)]);
  const descriptorPath = `${root}.descriptor.json`;
  await buildCandidateOciArtifactDescriptor({
    root,
    tuple: tuplePath,
    inventory: inventoryPath,
    component: componentPath,
    repository: "AquilaXk/easysubway-data",
    workflowRunId: "42",
    headSha: "a".repeat(40),
    namespace: "namespace",
    bucket: "candidate-private",
    createdAt: "2026-08-24T00:00:00.000Z",
    output: descriptorPath,
  });
  return {
    root,
    descriptorPath,
    cleanup: async () => {
      await rm(descriptorPath, { force: true });
      await rm(root, { recursive: true, force: true });
    },
  };
}
