import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildServerRouteBundlePublicationDescriptor } from "./build-server-route-bundle-publication-descriptor.mjs";
import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";
import { buildServerRouteBundleFinal } from "./lib/server-route-bundle-final.mjs";
import {
  assertServerRouteOciClientIdentity,
  createServerRouteOciClient,
  publishServerRouteBundlePublicationDescriptor,
  publicationDescriptorKey,
  serverRouteOciPublicBaseUrl,
} from "./publish-server-route-bundle-publication-descriptor.mjs";

const env = {
  OCI_SERVER_ROUTE_NAMESPACE: "example",
  OCI_SERVER_ROUTE_BUCKET: "easysubway-route",
  OCI_SERVER_ROUTE_REGION: "ap-seoul-1",
  OCI_SERVER_ROUTE_COMPAT_ENDPOINT: "https://example.compat.objectstorage.ap-seoul-1.oraclecloud.com",
  OCI_SERVER_ROUTE_PUBLISHER_ACCESS_KEY: "access",
  OCI_SERVER_ROUTE_PUBLISHER_SECRET_KEY: "secret",
};
const identity = {
  namespace: env.OCI_SERVER_ROUTE_NAMESPACE,
  bucket: env.OCI_SERVER_ROUTE_BUCKET,
  region: env.OCI_SERVER_ROUTE_REGION,
  endpoint: env.OCI_SERVER_ROUTE_COMPAT_ENDPOINT,
};

test("injected publisher client must exactly bind the OCI namespace, bucket, region, and compatibility endpoint", () => {
  const client = { identity, async putObjectIfAbsent() {}, async readObject() {} };
  assert.doesNotThrow(() => assertServerRouteOciClientIdentity(client, env));
  for (const field of Object.keys(identity)) {
    const changed = { ...identity, [field]: `wrong-${field}` };
    assert.throws(
      () => assertServerRouteOciClientIdentity({ ...client, identity: changed }, env),
      /exact OCI server-route identity/,
    );
  }
  assert.throws(
    () => assertServerRouteOciClientIdentity({ identity: { ...identity, extra: "no" }, async putObjectIfAbsent() {}, async readObject() {} }, env),
    /exact OCI server-route identity/,
  );
  assert.throws(() => assertServerRouteOciClientIdentity({ identity }, env), /exact OCI server-route identity/);
  assert.throws(
    () => assertServerRouteOciClientIdentity(client, { ...env, OCI_SERVER_ROUTE_COMPAT_ENDPOINT: "https://other.example" }),
    /exact OCI compatibility endpoint/,
  );
  assert.equal(
    serverRouteOciPublicBaseUrl(env),
    "https://objectstorage.ap-seoul-1.oraclecloud.com/n/example/b/easysubway-route/o",
  );
});

test("OCI compatibility client uses conditional create and an authenticated full GET without provider fallback", async () => {
  const calls = [];
  const bytes = Buffer.from("descriptor bytes");
  const client = createServerRouteOciClient(env, async (url, request) => {
    calls.push({ url: url.toString(), ...request });
    if (request.method === "PUT") return response(201);
    return response(200, bytes);
  });
  assert.deepEqual(client.identity, identity);
  assert.equal(await client.putObjectIfAbsent("server-route-bundle-publication-descriptors/v2/a.json", bytes), true);
  assert.deepEqual(await client.readObject("server-route-bundle-publication-descriptors/v2/a.json"), { exists: true, body: bytes });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://example.compat.objectstorage.ap-seoul-1.oraclecloud.com/easysubway-route/server-route-bundle-publication-descriptors/v2/a.json");
  assert.equal(calls[0].headers["if-none-match"], "*");
  assert.equal(calls[0].headers.authorization.startsWith("AWS4-HMAC-SHA256 Credential=access/"), true);
  assert.equal(calls[1].method, "GET");
  assert.equal(calls[1].body, undefined);
  const conflict = createServerRouteOciClient(env, async () => response(412));
  assert.equal(await conflict.putObjectIfAbsent("server-route-bundle-publication-descriptors/v2/a.json", bytes), false);
  assert.equal(publicationDescriptorKey("a".repeat(64)), "server-route-bundle-publication-descriptors/v2/" + "a".repeat(64) + ".json");
  assert.throws(() => publicationDescriptorKey("A".repeat(64)), /lowercase sha256/);
});

test("publisher entrypoint binds a detached clean producer and verifies immutable OCI bytes", async (t) => {
  const fixture = await publicationFixture(t);
  const calls = [];
  const client = exactClient(async (key, bytes) => { calls.push(["put", key, bytes]); return true; }, async (key) => {
    calls.push(["get", key]); return { exists: true, body: fixture.bytes };
  });
  const publicRead = async (url, size) => {
    calls.push(["public", url, size]);
    return { statusCode: 200, body: fixture.bytes };
  };
  const result = await publishServerRouteBundlePublicationDescriptor({
    descriptorPath: fixture.path, repositoryRoot: fixture.repo, repositoryGitSha: fixture.sha, client, env, publicRead,
  });
  assert.deepEqual(result, { descriptorSha256: fixture.descriptor.descriptorSha256, objectKey: publicationDescriptorKey(fixture.descriptor.descriptorSha256) });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(([kind]) => kind), ["put", "get", "public"]);
  assert.equal(calls[2][1], `https://objectstorage.ap-seoul-1.oraclecloud.com/n/example/b/easysubway-route/o/${result.objectKey}`);
  assert.equal(calls[2][2], fixture.bytes.length);

  for (const [label, clientFor] of [
    ["create conflict", exactClient(async () => false, async () => { throw new Error("must not GET"); })],
    ["missing GET", exactClient(async () => true, async () => ({ exists: false }))],
    ["mismatched GET", exactClient(async () => true, async () => ({ exists: true, body: Buffer.from("wrong") }))],
  ]) {
    let puts = 0;
    let publicReads = 0;
    const counted = { ...clientFor, putObjectIfAbsent: async (...args) => { puts += 1; return clientFor.putObjectIfAbsent(...args); } };
    await assert.rejects(
      () => publishServerRouteBundlePublicationDescriptor({ descriptorPath: fixture.path, repositoryRoot: fixture.repo, repositoryGitSha: fixture.sha, client: counted, env, publicRead: async () => { publicReads += 1; return { statusCode: 200, body: fixture.bytes }; } }),
      label === "create conflict" ? /immutable create conflict/ : /OCI full GET mismatch/,
    );
    assert.equal(puts, 1);
    assert.equal(publicReads, 0);
  }

  const publicMismatchCalls = [];
  await assert.rejects(
    () => publishServerRouteBundlePublicationDescriptor({
      descriptorPath: fixture.path,
      repositoryRoot: fixture.repo,
      repositoryGitSha: fixture.sha,
      client: exactClient(
        async (key) => { publicMismatchCalls.push(["put", key]); return true; },
        async (key) => { publicMismatchCalls.push(["get", key]); return { exists: true, body: fixture.bytes }; },
      ),
      env,
      publicRead: async (url) => { publicMismatchCalls.push(["public", url]); return { statusCode: 200, body: Buffer.from("wrong") }; },
    }),
    /descriptor public full GET mismatch/,
  );
  assert.deepEqual(publicMismatchCalls.map(([kind]) => kind), ["put", "get", "public"]);

  const drifted = path.join(fixture.root, "drifted.json");
  const value = structuredClone(fixture.descriptor);
  value.producer.gitSha = "a".repeat(40);
  delete value.descriptorSha256;
  value.descriptorSha256 = sha256(Buffer.from(canonicalJson(value)));
  await writeFile(drifted, canonicalJson(value));
  let puts = 0;
  await assert.rejects(
    () => publishServerRouteBundlePublicationDescriptor({ descriptorPath: drifted, repositoryRoot: fixture.repo, repositoryGitSha: fixture.sha, client: exactClient(async () => { puts += 1; return true; }, async () => ({ exists: true, body: fixture.bytes })), env }),
    /producer identity mismatch/,
  );
  assert.equal(puts, 0);

  execFileSync("git", ["checkout", "-q", "-B", "main"], { cwd: fixture.repo });
  await assertNoPut(fixture, /detached worktree/);
  execFileSync("git", ["checkout", "-q", "--detach", fixture.sha], { cwd: fixture.repo });
  await writeFile(path.join(fixture.repo, "dirty"), "x");
  await assertNoPut(fixture, /clean at the requested detached HEAD/);
});

function response(status, body = Buffer.alloc(0)) {
  return { status, async arrayBuffer() { return body; } };
}

function exactClient(putObjectIfAbsent, readObject) {
  return { identity: { ...identity }, putObjectIfAbsent, readObject };
}

async function assertNoPut(fixture, pattern) {
  let puts = 0;
  await assert.rejects(
    () => publishServerRouteBundlePublicationDescriptor({
      descriptorPath: fixture.path, repositoryRoot: fixture.repo, repositoryGitSha: fixture.sha,
      client: exactClient(async () => { puts += 1; return true; }, async () => ({ exists: true, body: fixture.bytes })), env,
    }),
    pattern,
  );
  assert.equal(puts, 0);
}

async function publicationFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "route-publication-descriptor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await mkdir(repo);
  for (const args of [["init", "-q"], ["config", "user.email", "test@example.invalid"], ["config", "user.name", "Test"], ["add", "."], ["commit", "-qm", "fixture"]]) {
    if (args[0] === "add") await writeFile(path.join(repo, "tracked"), "fixture");
    execFileSync("git", args, { cwd: repo });
  }
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  execFileSync("git", ["checkout", "-q", "--detach", sha], { cwd: repo });
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const oldPublic = process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM;
  const oldKeyId = process.env.EASYSUBWAY_DATAPACK_SIGNING_KEY_ID;
  process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  process.env.EASYSUBWAY_DATAPACK_SIGNING_KEY_ID = "production-v1";
  t.after(() => { if (oldPublic === undefined) delete process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM; else process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM = oldPublic; if (oldKeyId === undefined) delete process.env.EASYSUBWAY_DATAPACK_SIGNING_KEY_ID; else process.env.EASYSUBWAY_DATAPACK_SIGNING_KEY_ID = oldKeyId; });
  const artifact = path.join(root, "artifact");
  await mkdir(path.join(artifact, "payload"), { recursive: true });
  const components = ["accessibility", "fare", "timetable", "topology"];
  const files = new Map();
  for (const name of components) { const relative = `payload/${name}.sqlite.zst`; files.set(relative, Buffer.from(relative)); }
  const compatibility = Buffer.from(canonicalJson({ schemaCompatibility: { backendMin: 3, backendMax: 3 } }));
  const sourceSetSha256 = "2".repeat(64);
  const provenance = Buffer.from(canonicalJson({ sourceSnapshotSetHash: sourceSetSha256 }));
  files.set("compatibility.json", compatibility); files.set("provenance.json", provenance);
  const payload = [...files].filter(([name]) => name.startsWith("payload/")).map(([name, bytes]) => ({ path: name, sizeBytes: bytes.length, sha256: sha256(bytes) })).sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const manifestInput = { manifestVersion: 1, artifactKind: "server-route-bundle", bundleId: "fixture-bundle", releaseSequence: 1, stationSetSha256: "1".repeat(64), payloadSha256: sha256(Buffer.from(canonicalJson(payload))), topologySha256: payload.find((x) => x.path.includes("topology")).sha256, timetableSha256: payload.find((x) => x.path.includes("timetable")).sha256, accessibilitySha256: payload.find((x) => x.path.includes("accessibility")).sha256, fareSha256: payload.find((x) => x.path.includes("fare")).sha256, provenanceSha256: sha256(provenance), compatibilitySha256: sha256(compatibility), serviceTimezone: "Asia/Seoul", activeFrom: "2099-01-01T00:00:00.000+09:00", freshUntil: "2099-02-01T00:00:00.000+09:00", schemaCompatibility: { backendMin: 3, backendMax: 3 }, keyId: "production-v1" };
  const signingBytes = Buffer.from(canonicalJson(manifestInput));
  const manifest = { ...manifestInput, signature: { algorithm: "rsa-sha256-server-route-bundle-v1", value: createSign("RSA-SHA256").update(signingBytes).sign(pair.privateKey).toString("base64url") } };
  const manifestBytes = Buffer.from(canonicalJson(manifest));
  files.set("manifest.signing-input.json", signingBytes); files.set("manifest.json", manifestBytes);
  for (const [relative, bytes] of files) { await mkdir(path.dirname(path.join(artifact, relative)), { recursive: true }); await writeFile(path.join(artifact, relative), bytes); }
  const candidate = { repository: "AquilaXk/easysubway-data", gitSha: sha, bundleId: manifest.bundleId, releaseSequence: manifest.releaseSequence, stationSetSha256: manifest.stationSetSha256, sourceSnapshotSetHash: sourceSetSha256, signingInputSha256: sha256(signingBytes), signedManifestRawSha256: sha256(manifestBytes), payloadRootSha256: manifest.payloadSha256, componentInventorySha256: manifest.payloadSha256, componentDigests: Object.fromEntries(components.map((name) => [name, manifest[`${name}Sha256`]])), activeFrom: manifest.activeFrom, freshUntil: manifest.freshUntil, keyId: manifest.keyId };
  const pass = (evidenceSha256) => ({ state: "PASS", evidenceSha256 });
  const pre = buildServerRouteBundleFinal({ candidate, gates: { sourceFreshness: pass("3".repeat(64)), stationLineAccessibility: pass("4".repeat(64)), routeEdgeEvaluation: pass("5".repeat(64)), routeAccessibilityEligibility: pass("6".repeat(64)), artifactInventory: pass("7".repeat(64)), signature: pass(sha256(manifestBytes)), publication: { state: "UNAVAILABLE", evidenceSha256: null }, rebuildParityPromotion: { state: "UNAVAILABLE", evidenceSha256: null } } });
  const objectPrefix = `server-route-bundles/v1/${sha256(manifestBytes)}/`;
  const { repository, gitSha, ...receiptCandidate } = candidate;
  const receiptPayload = { schemaVersion: 1, artifactKind: "server-route-bundle-publication-receipt", repository: { name: "AquilaXk/easysubway-data", gitSha: sha }, candidate: { ...receiptCandidate, prePublicationFinalSha256: pre.finalSha256 }, locator: { publicBaseUrl: "https://objectstorage.ap-seoul-1.oraclecloud.com/n/example/b/easysubway/o", objectPrefix }, objects: [...files].map(([name, bytes]) => ({ path: name, objectKey: `${objectPrefix}${name}`, sizeBytes: bytes.length, sha256: sha256(bytes) })).sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))) };
  const receipt = { ...receiptPayload, receiptSha256: sha256(Buffer.from(canonicalJson(receiptPayload))) };
  const receiptBytes = Buffer.from(canonicalJson(receipt));
  const promotionBytes = Buffer.from(canonicalJson({ artifactKind: "promotion-request", candidateId: candidate.bundleId }));
  const final = buildServerRouteBundleFinal({ candidate, gates: { sourceFreshness: pass("3".repeat(64)), stationLineAccessibility: pass("4".repeat(64)), routeEdgeEvaluation: pass("5".repeat(64)), routeAccessibilityEligibility: pass("6".repeat(64)), artifactInventory: pass("7".repeat(64)), signature: pass(sha256(manifestBytes)), publication: pass(sha256(receiptBytes)), rebuildParityPromotion: pass(sha256(promotionBytes)) } });
  const finalPath = path.join(root, "final.json"), receiptPath = path.join(root, "receipt.json"), promotionPath = path.join(root, "promotion.json"), descriptorPath = path.join(root, "descriptor.json");
  await Promise.all([writeFile(finalPath, canonicalJson(final)), writeFile(receiptPath, receiptBytes), writeFile(promotionPath, promotionBytes)]);
  const descriptor = await buildServerRouteBundlePublicationDescriptor({ repositoryRoot: repo, repositoryGitSha: sha, artifactRoot: artifact, finalPath, publicationReceiptPath: receiptPath, promotionRequestPath: promotionPath, output: descriptorPath, clock: () => Date.parse("2099-01-02T00:00:00.000+09:00") });
  return { root, repo, sha, descriptor, path: descriptorPath, bytes: Buffer.from(canonicalJson(descriptor)) };
}
