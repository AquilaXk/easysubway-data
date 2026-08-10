import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  canonicalJson,
  sha256,
  validateArtifactComponentManifest,
  verifyRsaSha256Signature,
  withoutSignature,
} from "./lib/manifest-validation.mjs";

const SCRIPT = path.resolve("tools/datapack/sign-server-route-bundle.mjs");
const COMPONENTS = ["accessibility", "fare", "timetable", "topology"];
const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keyPair.privateKey.export({ type: "pkcs8", format: "pem" });
const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" });
const otherPublicKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey
  .export({ type: "spki", format: "pem" });

test("exact keyless bundle은 current key signed manifest와 byte-preserving tree를 결정적으로 생성한다", async (t) => {
  const fixture = await createFixture(t);
  const first = path.join(fixture.temp, "signed-one");
  const second = path.join(fixture.temp, "signed-two");

  for (const output of [first, second]) {
    const result = runSigner(fixture.input, output);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^SIGNED [a-f0-9]{64}\n$/);
  }

  const expectedFiles = [
    "compatibility.json",
    "manifest.json",
    "manifest.signing-input.json",
    ...COMPONENTS.map((component) => `payload/${component}.sqlite.zst`),
    "provenance.json",
  ].sort();
  assert.deepEqual(await files(first), expectedFiles);
  assert.deepEqual(await files(second), expectedFiles);
  for (const file of expectedFiles) {
    assert.deepEqual(await readFile(path.join(first, file)), await readFile(path.join(second, file)), file);
    if (file !== "manifest.json") {
      assert.deepEqual(await readFile(path.join(first, file)), await readFile(path.join(fixture.input, file)), file);
    }
  }

  const signingInputBytes = await readFile(path.join(first, "manifest.signing-input.json"));
  const manifestBytes = await readFile(path.join(first, "manifest.json"));
  const manifest = JSON.parse(manifestBytes);
  validateArtifactComponentManifest(manifest);
  assert.deepEqual(Buffer.from(canonicalJson(withoutSignature(manifest))), signingInputBytes);
  assert.equal(manifest.signature.algorithm, "rsa-sha256-server-route-bundle-v1");
  assert.equal(verifyRsaSha256Signature(publicKey, signingInputBytes, manifest.signature.value), true);
  assert.match(manifest.signature.value, /^[A-Za-z0-9_-]+$/);
});

test("malformed CLI arguments는 stack trace 없이 잠금된 진단으로 실패한다", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--input"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "sign-server-route-bundle: invalid argument near --input\n");
});

test("key·identity·artifact·output 경계 실패는 기존 bytes와 temp를 보존한다", async (t) => {
  await t.test("private key 누락", async (t) => {
    const fixture = await createFixture(t);
    const output = path.join(fixture.temp, "missing-key");
    const result = runSigner(fixture.input, output, { EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: "" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SIGNING_PRIVATE_KEY_PEM/);
    await assertMissing(output);
    assert.deepEqual(await taskTemps(fixture.temp), []);
  });

  await t.test("private/public key mismatch", async (t) => {
    const fixture = await createFixture(t);
    const output = path.join(fixture.temp, "mismatched-key");
    const result = runSigner(fixture.input, output, { EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM: otherPublicKey });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /generated signature verification failed/);
    await assertMissing(output);
    assert.deepEqual(await taskTemps(fixture.temp), []);
  });

  await t.test("unknown keyId", async (t) => {
    const fixture = await createFixture(t);
    const output = path.join(fixture.temp, "unknown-key-id");
    const result = runSigner(fixture.input, output, { EASYSUBWAY_DATAPACK_SIGNING_KEY_ID: "other-key" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /signing keyId mismatch/);
    await assertMissing(output);
  });

  await t.test("payload digest mismatch", async (t) => {
    const fixture = await createFixture(t);
    await writeFile(path.join(fixture.input, "payload/topology.sqlite.zst"), "mutated topology");
    const output = path.join(fixture.temp, "mutated-payload");
    const result = runSigner(fixture.input, output);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /topology payload digest mismatch/);
    await assertMissing(output);
  });

  await t.test("extra input", async (t) => {
    const fixture = await createFixture(t);
    await writeFile(path.join(fixture.input, "extra.json"), "{}");
    const output = path.join(fixture.temp, "extra-input");
    const result = runSigner(fixture.input, output);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /keyless artifact file set mismatch/);
    await assertMissing(output);
  });

  await t.test("missing input", async (t) => {
    const fixture = await createFixture(t);
    await rm(path.join(fixture.input, "provenance.json"));
    const output = path.join(fixture.temp, "missing-input");
    const result = runSigner(fixture.input, output);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /keyless artifact file set mismatch/);
    await assertMissing(output);
  });

  await t.test("noncanonical signing input", async (t) => {
    const fixture = await createFixture(t);
    const signingInput = JSON.parse(await readFile(path.join(fixture.input, "manifest.signing-input.json")));
    await writeFile(path.join(fixture.input, "manifest.signing-input.json"), `${JSON.stringify(signingInput, null, 2)}\n`);
    const output = path.join(fixture.temp, "noncanonical-input");
    const result = runSigner(fixture.input, output);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /manifest signing input must be canonical JSON/);
    await assertMissing(output);
  });

  await t.test("empty input", async (t) => {
    const fixture = await createFixture(t);
    await writeFile(path.join(fixture.input, "compatibility.json"), Buffer.alloc(0));
    const output = path.join(fixture.temp, "empty-input");
    const result = runSigner(fixture.input, output);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /compatibility must be non-empty/);
    await assertMissing(output);
  });

  await t.test("symlink input", async (t) => {
    const fixture = await createFixture(t);
    const target = path.join(fixture.temp, "payload-target");
    const payload = path.join(fixture.input, "payload/fare.sqlite.zst");
    await writeFile(target, "fare payload");
    await rm(payload);
    await symlink(target, payload);
    const output = path.join(fixture.temp, "symlink-input");
    const result = runSigner(fixture.input, output);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /fare payload must be a regular non-symlink/);
    await assertMissing(output);
  });

  await t.test("occupied output", async (t) => {
    const fixture = await createFixture(t);
    const output = path.join(fixture.temp, "occupied");
    await writeFile(output, "owner bytes");
    const result = runSigner(fixture.input, output);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /output must not already exist/);
    assert.equal(await readFile(output, "utf8"), "owner bytes");
    assert.deepEqual(await taskTemps(fixture.temp), []);
  });

  await t.test("symlink output", async (t) => {
    const fixture = await createFixture(t);
    const owner = path.join(fixture.temp, "owner-target");
    const output = path.join(fixture.temp, "occupied-symlink");
    await writeFile(owner, "owner symlink bytes");
    await symlink(owner, output);
    const result = runSigner(fixture.input, output);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /output must not already exist/);
    assert.equal(await readFile(owner, "utf8"), "owner symlink bytes");
    assert.deepEqual(await taskTemps(fixture.temp), []);
  });
});

async function createFixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "sign-route-bundle-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const input = path.join(temp, "keyless");
  await mkdir(path.join(input, "payload"), { recursive: true });
  const payloads = Object.fromEntries(COMPONENTS.map((component) => [
    component,
    Buffer.from(`${component} payload`),
  ]));
  for (const [component, bytes] of Object.entries(payloads)) {
    await writeFile(path.join(input, `payload/${component}.sqlite.zst`), bytes);
  }
  const provenanceBytes = Buffer.from(canonicalJson({ artifactKind: "server-route-bundle-provenance", schemaVersion: 1 }));
  const compatibilityBytes = Buffer.from(canonicalJson({ artifactKind: "server-route-bundle-compatibility", schemaVersion: 1 }));
  await writeFile(path.join(input, "provenance.json"), provenanceBytes);
  await writeFile(path.join(input, "compatibility.json"), compatibilityBytes);
  const inventory = Object.entries(payloads).map(([component, bytes]) => ({
    path: `payload/${component}.sqlite.zst`,
    sizeBytes: bytes.length,
    sha256: sha256(bytes),
  })).sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const manifest = {
    manifestVersion: 1,
    artifactKind: "server-route-bundle",
    bundleId: "bundle-current-1",
    releaseSequence: 1,
    stationSetSha256: "a".repeat(64),
    payloadSha256: sha256(Buffer.from(canonicalJson(inventory))),
    topologySha256: sha256(payloads.topology),
    timetableSha256: sha256(payloads.timetable),
    accessibilitySha256: sha256(payloads.accessibility),
    fareSha256: sha256(payloads.fare),
    provenanceSha256: sha256(provenanceBytes),
    compatibilitySha256: sha256(compatibilityBytes),
    serviceTimezone: "Asia/Seoul",
    activeFrom: "2026-08-10T09:00:00.000+09:00",
    freshUntil: "2026-08-11T09:00:00.000+09:00",
    schemaCompatibility: { backendMin: 3, backendMax: 3 },
    keyId: "production-v1",
  };
  validateArtifactComponentManifest({
    ...manifest,
    signature: { algorithm: "rsa-sha256-server-route-bundle-v1", value: "AA" },
  });
  await writeFile(path.join(input, "manifest.signing-input.json"), canonicalJson(manifest));
  return { temp, input };
}

function runSigner(input, output, overrides = {}) {
  return spawnSync(process.execPath, [SCRIPT, "--input", input, "--output", output], {
    encoding: "utf8",
    env: {
      ...process.env,
      EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKey,
      EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM: publicKey,
      EASYSUBWAY_DATAPACK_SIGNING_KEY_ID: "production-v1",
      ...overrides,
    },
  });
}

async function files(root, current = root, result = []) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) await files(root, target, result);
    else result.push(path.relative(root, target).split(path.sep).join("/"));
  }
  return result.sort();
}

async function assertMissing(target) {
  await assert.rejects(() => readFile(target), /ENOENT|EISDIR/);
}

async function taskTemps(root) {
  return (await readdir(root)).filter((entry) => entry.startsWith(".signed-route-bundle-")).sort();
}
