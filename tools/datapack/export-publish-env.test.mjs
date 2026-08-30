import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "export-publish-env.mjs");
const required = {
  EASYSUBWAY_DATAPACK_REMOTE_PUBLISH_ENABLED: "true",
  EASYSUBWAY_DATA_PACK_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/n/examplenamespace/b/example-bucket/o",
  EASYSUBWAY_OBJECT_STORAGE_ENDPOINT: "https://examplenamespace.compat.objectstorage.ap-seoul-1.oraclecloud.com",
  EASYSUBWAY_OBJECT_STORAGE_ACCESS_KEY: "access-key",
  EASYSUBWAY_OBJECT_STORAGE_SECRET_KEY: "secret-key",
  EASYSUBWAY_OBJECT_STORAGE_REGION: "ap-seoul-1",
  EASYSUBWAY_DATAPACK_BUCKET: "example-bucket",
  EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: "private-key",
  EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM: "public-key",
  EASYSUBWAY_DATAPACK_SIGNING_KEY_ID: "key-id",
};

async function run(overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "export-publish-env-"));
  const envFile = path.join(directory, "publish.env");
  const githubEnv = path.join(directory, "github.env");
  const githubOutput = path.join(directory, "github.output");
  await writeFile(envFile, `${Object.entries({ ...required, ...overrides })
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")}\n`);
  const result = spawnSync(process.execPath, [
    script,
    "--env-file", envFile,
    "--github-env", githubEnv,
    "--github-output", githubOutput,
    "--require-oci-s3-compat",
  ], { encoding: "utf8" });
  const output = result.status === 0 ? {
    githubEnv: await readFile(githubEnv, "utf8"),
    githubOutput: await readFile(githubOutput, "utf8"),
  } : null;
  await rm(directory, { recursive: true, force: true });
  return { ...result, output };
}

test("strict OCI S3-compatible export binds canonical public and compatibility endpoints", async () => {
  const result = await run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.output.githubEnv, /EASYSUBWAY_DATA_PACK_BASE_URL=https:\/\/objectstorage\.ap-seoul-1\.oraclecloud\.com\/n\/examplenamespace\/b\/example-bucket\/o/);
  assert.match(result.output.githubEnv, /EASYSUBWAY_OBJECT_STORAGE_ENDPOINT=https:\/\/examplenamespace\.compat\.objectstorage\.ap-seoul-1\.oraclecloud\.com/);
  assert.match(result.output.githubOutput, /enabled=true/);
});

for (const [name, overrides] of Object.entries({
  "rejects a preauthenticated URL": {
    EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/token/n/examplenamespace/b/example-bucket/o",
  },
  "rejects a whitespace-only preauthenticated URL": {
    EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "   ",
  },
  "rejects a noncanonical public object URL": {
    EASYSUBWAY_DATA_PACK_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/n/examplenamespace/b/example-bucket/o/",
  },
  "rejects a compatibility endpoint that does not bind the public namespace": {
    EASYSUBWAY_OBJECT_STORAGE_ENDPOINT: "https://othernamespace.compat.objectstorage.ap-seoul-1.oraclecloud.com",
  },
  "rejects a bucket that does not bind the public object URL": {
    EASYSUBWAY_DATAPACK_BUCKET: "other-bucket",
  },
})) {
  test(`strict OCI S3-compatible export ${name}`, async () => {
    const result = await run(overrides);
    assert.notEqual(result.status, 0);
  });
}
