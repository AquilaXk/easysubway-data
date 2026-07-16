import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { buildReleaseRequestBinding } from "./build-release-request-binding.mjs";
import { canonicalJson, verifyRsaSha256Signature, withoutSignature } from "./lib/manifest-validation.mjs";

const execFileAsync = promisify(execFile);

test("release request binding은 manifest identity를 변경하지 않고 요청을 서명해 결합한다", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const manifestBytes = Buffer.from(JSON.stringify({
    manifestVersion: 2,
    channel: "production",
    releaseSequence: 42,
    keyId: "production-v1",
    ttlSeconds: 3600,
    packs: [],
  }));

  const binding = buildReleaseRequestBinding(
    manifestBytes,
    "request-2057",
    privateKey.export({ type: "pkcs8", format: "pem" }),
    "production-v1",
  );

  assert.equal(binding.schemaVersion, 1);
  assert.equal(binding.artifactKind, "datapack-release-request-binding");
  assert.equal(binding.keyId, "production-v1");
  assert.equal(binding.releaseOutcome, "PUBLISHED_AND_VERIFIED");
  assert.equal(binding.signature.algorithm, "rsa-sha256-release-request-v1");
  assert.equal(binding.releaseRequestId, "request-2057");
  assert.equal(binding.releaseSequence, 42);
  assert.equal(binding.channel, "production");
  assert.equal(
    binding.manifestSha256,
    createHash("sha256").update(manifestBytes).digest("hex"),
  );
  assert.equal(
    verifyRsaSha256Signature(
      publicKey.export({ type: "spki", format: "pem" }),
      canonicalJson(withoutSignature(binding)),
      binding.signature.value,
    ),
    true,
  );
  assert.equal(JSON.parse(manifestBytes).releaseRequestId, undefined);
});

test("최종 검증 뒤 binding-only plan이 request identity를 immutable 게시한다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "datapack-request-binding-"));
  await mkdir(path.join(root, "catalog"), { recursive: true });
  const packBytes = Buffer.from("pack");
  const manifest = {
    manifestVersion: 2,
    channel: "production",
    releaseSequence: 42,
    keyId: "production-v1",
    ttlSeconds: 3600,
    packs: [{
      id: "capital",
      version: "1",
      url: "catalog/capital-v1.sqlite.gz",
      sha256: (await import("node:crypto")).createHash("sha256").update(packBytes).digest("hex"),
      sizeBytes: packBytes.length,
    }],
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const binding = buildReleaseRequestBinding(
    manifestBytes,
    "request-2057",
    privateKey.export({ type: "pkcs8", format: "pem" }),
    "production-v1",
  );
  const manifestPath = path.join(root, "catalog", "current.json");
  const bindingPath = path.join(root, "catalog", "release-request-binding.json");
  const planPath = path.join(root, "publish-plan.json");
  await writeFile(path.join(root, "catalog", "capital-v1.sqlite.gz"), packBytes);
  await writeFile(manifestPath, manifestBytes);
  await writeFile(bindingPath, `${JSON.stringify({
    ...binding,
    signature: {
      ...binding.signature,
      value: `${binding.signature.value[0] === "A" ? "B" : "A"}${binding.signature.value.slice(1)}`,
    },
  })}\n`);

  await assert.rejects(execFileAsync(process.execPath, [
    "tools/datapack/create-publish-plan.mjs",
    "--manifest", manifestPath,
    "--root", root,
    "--output", planPath,
    "--release-request-binding", bindingPath,
    "--only", "release-request-binding",
  ], {
    env: {
      ...process.env,
      EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM: publicKey.export({ type: "spki", format: "pem" }),
    },
  }), /signature/i);

  const wrongKeyIdBinding = buildReleaseRequestBinding(
    manifestBytes,
    "request-2057",
    privateKey.export({ type: "pkcs8", format: "pem" }),
    "rotated-v2",
  );
  await writeFile(bindingPath, `${JSON.stringify(wrongKeyIdBinding)}\n`);
  await assert.rejects(execFileAsync(process.execPath, [
    "tools/datapack/create-publish-plan.mjs",
    "--manifest", manifestPath,
    "--root", root,
    "--output", planPath,
    "--release-request-binding", bindingPath,
    "--only", "release-request-binding",
  ], {
    env: {
      ...process.env,
      EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM: publicKey.export({ type: "spki", format: "pem" }),
      EASYSUBWAY_DATAPACK_SIGNING_KEY_ID: "production-v1",
    },
  }), /keyId/i);

  await writeFile(bindingPath, `${JSON.stringify(binding)}\n`);

  await execFileAsync(process.execPath, [
    "tools/datapack/create-publish-plan.mjs",
    "--manifest", manifestPath,
    "--root", root,
    "--output", planPath,
    "--release-request-binding", bindingPath,
    "--only", "release-request-binding",
  ], {
    env: {
      ...process.env,
      EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM: publicKey.export({ type: "spki", format: "pem" }),
    },
  });
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  const bindingPut = plan.steps.findIndex((step) => step.type === "put-release-request-binding-object");
  assert.equal(plan.schemaVersion, 3);
  assert.equal(bindingPut, 0);
  assert.deepEqual(plan.steps.map((step) => step.type), [
    "put-release-request-binding-object",
    "verify-release-request-binding-object",
  ]);
  assert.match(plan.steps[bindingPut].objectKey, /^catalog\/release-requests\/[a-f0-9]{64}\.json$/);

  await execFileAsync(process.execPath, [
    "tools/datapack/publish-object-storage.mjs",
    "--plan", planPath,
    "--root", root,
    "--dry-run",
  ]);
});
