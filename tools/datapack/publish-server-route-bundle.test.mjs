import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalJson,
  sha256,
} from "./lib/manifest-validation.mjs";
import {
  buildServerRouteBundleFinal,
  canonicalServerRouteBundleFinalJson,
} from "./lib/server-route-bundle-final.mjs";
import {
  publishServerRouteBundle,
  validatePublicationReceipt,
} from "./publish-server-route-bundle.mjs";
import { signServerRouteBundle } from "./sign-server-route-bundle.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const SCRIPT = path.join(REPOSITORY_ROOT, "tools/datapack/publish-server-route-bundle.mjs");
const REPOSITORY_GIT_SHA = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: REPOSITORY_ROOT,
  encoding: "utf8",
}).trim();
const COMPONENTS = ["accessibility", "fare", "timetable", "topology"];
const SIGNED_PATHS = [
  "compatibility.json",
  "manifest.json",
  "manifest.signing-input.json",
  ...COMPONENTS.map((component) => `payload/${component}.sqlite.zst`),
  "provenance.json",
].sort(bytewise);
const PUBLIC_BASE_URL = "https://objectstorage.ap-seoul-1.oraclecloud.com/n/example/b/easysubway/o";
const PUBLICATION_NOW = Date.parse("2026-08-10T00:00:00.000Z");
const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keyPair.privateKey.export({ type: "pkcs8", format: "pem" });
const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" });

test("malformed publication CLI는 stack trace 없이 fail closed한다", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--artifact-root"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "publish-server-route-bundle: invalid argument near --artifact-root\n");
});

test("signed server-route-bundle은 OCI immutable tree 검증 뒤에만 closed receipt를 만든다", async (t) => {
  const fixture = await createFixture(t);
  const client = memoryObjectStorageClient();

  const receipt = await publishServerRouteBundle({
    repositoryRoot: REPOSITORY_ROOT,
    repositoryGitSha: REPOSITORY_GIT_SHA,
    artifactRoot: fixture.signedRoot,
    finalPath: fixture.finalPath,
    publicBaseUrl: PUBLIC_BASE_URL,
    receiptPath: fixture.receiptPath,
    client,
    publicRead: client.readPublicObject,
    now: PUBLICATION_NOW,
  });

  const manifestSha256 = sha256(await readFile(path.join(fixture.signedRoot, "manifest.json")));
  const prefix = `server-route-bundles/v1/${manifestSha256}/`;
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.artifactKind, "server-route-bundle-publication-receipt");
  assert.deepEqual(receipt.repository, {
    name: "AquilaXk/easysubway-data",
    gitSha: REPOSITORY_GIT_SHA,
  });
  assert.equal(receipt.candidate.bundleId, fixture.manifest.bundleId);
  assert.equal(receipt.candidate.prePublicationFinalSha256, fixture.final.finalSha256);
  assert.equal(receipt.candidate.signedManifestRawSha256, manifestSha256);
  assert.deepEqual(receipt.locator, { publicBaseUrl: PUBLIC_BASE_URL, objectPrefix: prefix });
  assert.deepEqual(receipt.objects.map((entry) => entry.path), SIGNED_PATHS);
  assert.deepEqual(receipt.objects.map((entry) => entry.objectKey), SIGNED_PATHS.map((entry) => `${prefix}${entry}`));
  assert.equal(receipt.receiptSha256, sha256(Buffer.from(canonicalJson(withoutReceiptSha256(receipt)))));
  assert.deepEqual(JSON.parse(await readFile(fixture.receiptPath, "utf8")), receipt);
  const schema = JSON.parse(await readFile(
    path.join(REPOSITORY_ROOT, "contracts/datapack/server-route-bundle-publication-receipt.schema.json"),
    "utf8",
  ));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(validateSchemaNode(schema, receipt, schema), true);
  const extra = { ...receipt, unexpected: true };
  assert.equal(validateSchemaNode(schema, extra, schema), false);
  for (const [label, mutate, pattern] of [
    ["manifest", (value) => { object(value, "manifest.json").sha256 = "f".repeat(64); }, /manifest digest identity mismatch/],
    ["signing-input", (value) => { object(value, "manifest.signing-input.json").sha256 = "f".repeat(64); }, /signing input digest identity mismatch/],
    ["payload", (value) => { object(value, "payload/topology.sqlite.zst").sha256 = "f".repeat(64); }, /topology digest identity mismatch/],
  ]) {
    const mutated = structuredClone(receipt);
    mutate(mutated);
    mutated.receiptSha256 = sha256(Buffer.from(canonicalJson(withoutReceiptSha256(mutated))));
    assert.throws(() => validatePublicationReceipt(mutated), pattern, label);
  }
  assert.deepEqual([...client.objects.keys()].sort(bytewise), receipt.objects.map((entry) => entry.objectKey));
  assert.deepEqual(client.puts, receipt.objects.map((entry) => entry.objectKey));
  assert.deepEqual(client.reads, receipt.objects.map((entry) => entry.objectKey));
  assert.deepEqual(client.publicReads, receipt.objects.map((entry) => `${PUBLIC_BASE_URL}/${entry.objectKey}`));

  const firstReceiptBytes = await readFile(fixture.receiptPath);
  const repeated = await publishServerRouteBundle({
    repositoryRoot: REPOSITORY_ROOT,
    repositoryGitSha: REPOSITORY_GIT_SHA,
    artifactRoot: fixture.signedRoot,
    finalPath: fixture.finalPath,
    publicBaseUrl: PUBLIC_BASE_URL,
    receiptPath: fixture.receiptPath,
    client,
    publicRead: client.readPublicObject,
    now: PUBLICATION_NOW,
  });
  assert.deepEqual(repeated, receipt);
  assert.deepEqual(await readFile(fixture.receiptPath), firstReceiptBytes);
});

test("pre-publication gate·identity·remote collision 실패는 request 전 또는 receipt 없이 fail closed한다", async (t) => {
  await t.test("unresolved FINAL gate", async (t) => {
    const fixture = await createFixture(t, { sourceFreshness: "STALE" });
    const client = memoryObjectStorageClient();
    await assert.rejects(() => publishFixture(fixture, client), /sourceFreshness must be PASS/);
    assert.equal(client.requests, 0);
    await assertMissing(fixture.receiptPath);
  });

  await t.test("candidate identity mismatch", async (t) => {
    const fixture = await createFixture(t, { bundleId: "other-bundle" });
    const client = memoryObjectStorageClient();
    await assert.rejects(() => publishFixture(fixture, client), /bundleId identity mismatch/);
    assert.equal(client.requests, 0);
    await assertMissing(fixture.receiptPath);
  });

  await t.test("replayed stale FINAL", async (t) => {
    const fixture = await createFixture(t);
    const client = memoryObjectStorageClient();
    await assert.rejects(
      () => publishFixture(fixture, client, { now: Date.parse("2026-08-12T00:00:00.000Z") }),
      /freshUntil must be in the future/,
    );
    assert.equal(client.requests, 0);
    await assertMissing(fixture.receiptPath);
  });

  await t.test("remote collision", async (t) => {
    const fixture = await createFixture(t);
    const client = memoryObjectStorageClient();
    const manifestSha256 = sha256(await readFile(path.join(fixture.signedRoot, "manifest.json")));
    client.objects.set(
      `server-route-bundles/v1/${manifestSha256}/compatibility.json`,
      Buffer.from("different remote bytes"),
    );
    await assert.rejects(() => publishFixture(fixture, client), /immutable violation/);
    await assertMissing(fixture.receiptPath);
  });

  await t.test("partial remote failure", async (t) => {
    const fixture = await createFixture(t);
    const client = memoryObjectStorageClient({ failAfterRequest: 5 });
    await assert.rejects(() => publishFixture(fixture, client), /injected remote failure/);
    assert.ok(client.objects.size > 0);
    await assertMissing(fixture.receiptPath);
  });

  await t.test("public locator mismatch", async (t) => {
    const fixture = await createFixture(t);
    const client = memoryObjectStorageClient({ publicBodyOverride: Buffer.from("wrong public bytes") });
    await assert.rejects(() => publishFixture(fixture, client), /public locator checksum mismatch/);
    assert.equal(client.publicReads.length, 1);
    await assertMissing(fixture.receiptPath);
  });

  await t.test("source identity drift", async (t) => {
    const fixture = await createFixture(t);
    const client = memoryObjectStorageClient({
      onFirstPut: async () => writeFile(path.join(fixture.signedRoot, "compatibility.json"), "drift"),
    });
    await assert.rejects(() => publishFixture(fixture, client), /signed artifact changed during publication/);
    await assertMissing(fixture.receiptPath);
  });

  await t.test("occupied mismatched receipt", async (t) => {
    const fixture = await createFixture(t);
    await writeFile(fixture.receiptPath, "owner bytes");
    await assert.rejects(() => publishFixture(fixture, memoryObjectStorageClient()), /receipt already exists with different bytes/);
    assert.equal(await readFile(fixture.receiptPath, "utf8"), "owner bytes");
  });

  await t.test("symlink receipt", async (t) => {
    const fixture = await createFixture(t);
    const owner = path.join(fixture.temp, "owner-receipt");
    await writeFile(owner, "owner bytes");
    await symlink(owner, fixture.receiptPath);
    await assert.rejects(() => publishFixture(fixture, memoryObjectStorageClient()), /receipt must be a regular non-symlink/);
    assert.equal(await readFile(owner, "utf8"), "owner bytes");
  });
});

test("public locator와 signed tree는 closed URL·file-set 계약을 강제한다", async (t) => {
  for (const invalid of [
    "http://objects.example.test/public",
    "https://user@objects.example.test/public",
    "https://objects.example.test/public?token=secret",
    "https://objects.example.test/public#fragment",
    "https://localhost/public",
    "https://127.0.0.1/public",
    "https://objects.example.test/public/",
  ]) {
    await t.test(invalid, async (t) => {
      const fixture = await createFixture(t);
      const client = memoryObjectStorageClient();
      await assert.rejects(
        () => publishFixture(fixture, client, { publicBaseUrl: invalid }),
        /public base URL/,
      );
      assert.equal(client.requests, 0);
      await assertMissing(fixture.receiptPath);
    });
  }

  await t.test("extra signed file", async (t) => {
    const fixture = await createFixture(t);
    await writeFile(path.join(fixture.signedRoot, "extra.json"), "{}");
    const client = memoryObjectStorageClient();
    await assert.rejects(() => publishFixture(fixture, client), /signed artifact file set mismatch/);
    assert.equal(client.requests, 0);
    await assertMissing(fixture.receiptPath);
  });

  await t.test("empty signed payload", async (t) => {
    const fixture = await createFixture(t);
    await writeFile(path.join(fixture.signedRoot, "payload/fare.sqlite.zst"), Buffer.alloc(0));
    const client = memoryObjectStorageClient();
    await assert.rejects(() => publishFixture(fixture, client), /fare payload must be non-empty/);
    assert.equal(client.requests, 0);
    await assertMissing(fixture.receiptPath);
  });
});

async function createFixture(t, options = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "publish-route-bundle-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const keylessRoot = path.join(temp, "keyless");
  const signedRoot = path.join(temp, "signed");
  const finalPath = path.join(temp, "server-route-bundle-final.json");
  const receiptPath = path.join(temp, "publication-receipt.json");
  await mkdir(path.join(keylessRoot, "payload"), { recursive: true });
  const payloads = Object.fromEntries(COMPONENTS.map((component) => [component, Buffer.from(`${component} payload`)]));
  for (const [component, bytes] of Object.entries(payloads)) {
    await writeFile(path.join(keylessRoot, `payload/${component}.sqlite.zst`), bytes);
  }
  const provenanceBytes = Buffer.from(canonicalJson({
    artifactKind: "server-route-bundle-provenance",
    schemaVersion: 1,
    sourceSnapshotSetHash: "b".repeat(64),
  }));
  const compatibilityBytes = Buffer.from(canonicalJson({
    artifactKind: "server-route-bundle-compatibility",
    schemaVersion: 1,
  }));
  await writeFile(path.join(keylessRoot, "provenance.json"), provenanceBytes);
  await writeFile(path.join(keylessRoot, "compatibility.json"), compatibilityBytes);
  const payloadInventory = Object.entries(payloads).map(([component, bytes]) => ({
    path: `payload/${component}.sqlite.zst`,
    sizeBytes: bytes.length,
    sha256: sha256(bytes),
  })).sort((left, right) => bytewise(left.path, right.path));
  const manifest = {
    manifestVersion: 1,
    artifactKind: "server-route-bundle",
    bundleId: "capital-server-route-bundle-1",
    releaseSequence: 1,
    stationSetSha256: "a".repeat(64),
    payloadSha256: sha256(Buffer.from(canonicalJson(payloadInventory))),
    topologySha256: sha256(payloads.topology),
    timetableSha256: sha256(payloads.timetable),
    accessibilitySha256: sha256(payloads.accessibility),
    fareSha256: sha256(payloads.fare),
    provenanceSha256: sha256(provenanceBytes),
    compatibilitySha256: sha256(compatibilityBytes),
    serviceTimezone: "Asia/Seoul",
    activeFrom: "2026-08-10T18:00:00.000+09:00",
    freshUntil: "2026-08-11T18:00:00.000+09:00",
    schemaCompatibility: { backendMin: 3, backendMax: 3 },
    keyId: "production-v1",
  };
  const signingInputBytes = Buffer.from(canonicalJson(manifest));
  await writeFile(path.join(keylessRoot, "manifest.signing-input.json"), signingInputBytes);
  installSigningEnvironment(t);
  await signServerRouteBundle({ input: keylessRoot, output: signedRoot });
  const manifestBytes = await readFile(path.join(signedRoot, "manifest.json"));
  const signedManifestRawSha256 = sha256(manifestBytes);
  const final = buildServerRouteBundleFinal({
    candidate: {
      repository: "AquilaXk/easysubway-data",
      gitSha: REPOSITORY_GIT_SHA,
      bundleId: options.bundleId ?? manifest.bundleId,
      releaseSequence: manifest.releaseSequence,
      stationSetSha256: manifest.stationSetSha256,
      sourceSnapshotSetHash: "b".repeat(64),
      signingInputSha256: sha256(signingInputBytes),
      signedManifestRawSha256,
      payloadRootSha256: manifest.payloadSha256,
      componentInventorySha256: manifest.payloadSha256,
      componentDigests: Object.fromEntries(COMPONENTS.map((component) => [
        component,
        manifest[`${component}Sha256`],
      ])),
      activeFrom: manifest.activeFrom,
      freshUntil: manifest.freshUntil,
      keyId: manifest.keyId,
    },
    gates: {
      sourceFreshness: gate(options.sourceFreshness ?? "PASS", "1"),
      stationLineAccessibility: gate("PASS", "2"),
      routeEdgeEvaluation: gate("PASS", "3"),
      artifactInventory: gate("PASS", "4"),
      signature: { state: "PASS", evidenceSha256: signedManifestRawSha256 },
      publication: { state: "UNAVAILABLE", evidenceSha256: null },
      rebuildParityPromotion: { state: "UNAVAILABLE", evidenceSha256: null },
    },
  });
  await writeFile(finalPath, canonicalServerRouteBundleFinalJson(final));
  return { temp, signedRoot, finalPath, receiptPath, manifest, final };
}

function installSigningEnvironment(t) {
  const before = {
    privateKey: process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM,
    publicKey: process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM,
    keyId: process.env.EASYSUBWAY_DATAPACK_SIGNING_KEY_ID,
  };
  process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM = privateKey;
  process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM = publicKey;
  process.env.EASYSUBWAY_DATAPACK_SIGNING_KEY_ID = "production-v1";
  t.after(() => restoreEnv("EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM", before.privateKey));
  t.after(() => restoreEnv("EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM", before.publicKey));
  t.after(() => restoreEnv("EASYSUBWAY_DATAPACK_SIGNING_KEY_ID", before.keyId));
}

function gate(state, digit) {
  return { state, evidenceSha256: state === "UNAVAILABLE" ? null : digit.repeat(64) };
}

function publishFixture(fixture, client, overrides = {}) {
  return publishServerRouteBundle({
    repositoryRoot: REPOSITORY_ROOT,
    repositoryGitSha: REPOSITORY_GIT_SHA,
    artifactRoot: fixture.signedRoot,
    finalPath: fixture.finalPath,
    publicBaseUrl: PUBLIC_BASE_URL,
    receiptPath: fixture.receiptPath,
    client,
    publicRead: client.readPublicObject,
    now: PUBLICATION_NOW,
    ...overrides,
  });
}

function memoryObjectStorageClient(options = {}) {
  const objects = new Map();
  const puts = [];
  const reads = [];
  const publicReads = [];
  let requests = 0;
  let firstPut = true;
  function beforeRequest() {
    requests += 1;
    if (options.failAfterRequest === requests) throw new Error("injected remote failure");
  }
  return {
    objects,
    puts,
    reads,
    publicReads,
    get requests() { return requests; },
    async putObjectIfAbsent(key, bytes) {
      beforeRequest();
      puts.push(key);
      if (firstPut) {
        firstPut = false;
        await options.onFirstPut?.();
      }
      if (objects.has(key)) return false;
      objects.set(key, Buffer.from(bytes));
      return true;
    },
    async readObject(key) {
      beforeRequest();
      reads.push(key);
      return objects.has(key)
        ? { exists: true, body: Buffer.from(objects.get(key)) }
        : { exists: false };
    },
    async readPublicObject(url) {
      publicReads.push(url);
      const prefix = `${PUBLIC_BASE_URL}/`;
      if (!url.startsWith(prefix)) return { statusCode: 404, body: Buffer.alloc(0) };
      const key = url.slice(prefix.length);
      if (!objects.has(key)) return { statusCode: 404, body: Buffer.alloc(0) };
      return {
        statusCode: 200,
        body: options.publicBodyOverride ?? Buffer.from(objects.get(key)),
      };
    },
  };
}

function withoutReceiptSha256(receipt) {
  const copy = structuredClone(receipt);
  delete copy.receiptSha256;
  return copy;
}

function object(receipt, relative) {
  return receipt.objects.find((entry) => entry.path === relative);
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function assertMissing(target) {
  await assert.rejects(() => readFile(target), /ENOENT/);
}

function bytewise(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function validateSchemaNode(rule, value, root) {
  if (rule.$ref) {
    const target = rule.$ref.slice(2).split("/").reduce((current, part) => current[part], root);
    return validateSchemaNode(target, value, root);
  }
  if (Object.hasOwn(rule, "const") && !Object.is(value, rule.const)) return false;
  if (rule.enum && !rule.enum.some((entry) => Object.is(entry, value))) return false;
  if (rule.type && !matchesSchemaType(rule.type, value)) return false;
  if (typeof value === "string" && rule.pattern && !new RegExp(rule.pattern).test(value)) return false;
  if (typeof value === "number" && rule.minimum !== undefined && value < rule.minimum) return false;
  if (typeof value === "number" && rule.maximum !== undefined && value > rule.maximum) return false;
  if (Array.isArray(value)) {
    if (rule.minItems !== undefined && value.length < rule.minItems) return false;
    if (rule.maxItems !== undefined && value.length > rule.maxItems) return false;
    if (rule.uniqueItems && new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length) return false;
    if (rule.items && !value.every((entry) => validateSchemaNode(rule.items, entry, root))) return false;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if ((rule.required ?? []).some((field) => !Object.hasOwn(value, field))) return false;
    if (rule.additionalProperties === false
      && Object.keys(value).some((field) => !Object.hasOwn(rule.properties ?? {}, field))) return false;
    if (!Object.entries(rule.properties ?? {}).every(([field, child]) => (
      !Object.hasOwn(value, field) || validateSchemaNode(child, value[field], root)
    ))) return false;
  }
  return true;
}

function matchesSchemaType(type, value) {
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  if (type === "string") return typeof value === "string";
  if (type === "integer") return Number.isInteger(value);
  return false;
}
