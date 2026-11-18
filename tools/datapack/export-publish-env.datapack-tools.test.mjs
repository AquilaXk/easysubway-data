import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileAsync } from "./test-fixtures/datapack-tools-support.mjs";

const root = path.resolve(import.meta.dirname, "../..");

const LOCAL_PLACEHOLDER_ENV_LINES = [
  "EASYSUBWAY_DATA_PACK_BASE_URL=http://localhost:9000/easysubway-datapacks",
  "EASYSUBWAY_OBJECT_STORAGE_ENDPOINT=http://localhost:9000",
  "EASYSUBWAY_OBJECT_STORAGE_ACCESS_KEY=access-key",
  "EASYSUBWAY_OBJECT_STORAGE_SECRET_KEY=secret-key",
  "EASYSUBWAY_OBJECT_STORAGE_REGION=ap-northeast-2",
  "EASYSUBWAY_DATAPACK_BUCKET=easysubway-datapacks",
];

async function withPublishEnvWorkspace(prefix, envLines, fn) {
  const dir = path.join(tmpdir(), `easysubway-datapack-${prefix}-${Date.now()}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const envFile = path.join(dir, "deploy.env");
  const githubEnvFile = path.join(dir, "github.env");
  const githubOutputFile = path.join(dir, "github-output.txt");
  await writeFile(envFile, [...envLines, ""].join("\n"));

  const runExporter = (extraArgs = []) =>
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/export-publish-env.mjs",
        "--env-file",
        envFile,
        "--github-env",
        githubEnvFile,
        "--github-output",
        githubOutputFile,
        ...extraArgs,
      ],
      { cwd: root },
    );

  try {
    await fn({ githubEnvFile, githubOutputFile, runExporter });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("데이터팩 remote publish env exporter는 object storage와 signing 값을 GitHub env로 내보낸다", async () => {
  await withPublishEnvWorkspace(
    "publish-env",
    [
      "EASYSUBWAY_DATA_PACK_BASE_URL=https://cdn.example.com/easysubway-datapacks",
      "EASYSUBWAY_DATAPACK_REMOTE_PUBLISH_ENABLED=true",
      "EASYSUBWAY_OBJECT_STORAGE_ENDPOINT=https://object-storage.example.com",
      "EASYSUBWAY_OBJECT_STORAGE_ACCESS_KEY=access-key",
      "EASYSUBWAY_OBJECT_STORAGE_SECRET_KEY=secret-key",
      "EASYSUBWAY_OBJECT_STORAGE_REGION=ap-northeast-2",
      "EASYSUBWAY_DATAPACK_BUCKET=easysubway-datapacks",
      "EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM=private-key\\nline",
      "EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM=public-key\\nline",
      "EASYSUBWAY_DATAPACK_SIGNING_KEY_ID=production-v1",
      "EASYSUBWAY_ADMIN_PASSWORD=admin-password-must-not-export",
    ],
    async ({ githubEnvFile, runExporter }) => {
      const { stdout } = await runExporter();
      const exported = await readFile(githubEnvFile, "utf8");
      assert.match(stdout, /^::add-mask::access-key$/m);
      assert.match(stdout, /^::add-mask::secret-key$/m);
      assert.match(stdout, /^::add-mask::private-key\\nline$/m);
      assert.match(stdout, /^::add-mask::private-key%0Aline$/m);
      assert.match(exported, /^EASYSUBWAY_DATAPACK_REMOTE_PUBLISH=enabled$/m);
      assert.match(exported, /^EASYSUBWAY_DATA_PACK_BASE_URL=https:\/\/cdn\.example\.com\/easysubway-datapacks$/m);
      assert.match(exported, /^EASYSUBWAY_OBJECT_STORAGE_ENDPOINT=https:\/\/object-storage\.example\.com$/m);
      assert.match(exported, /^EASYSUBWAY_OBJECT_STORAGE_ACCESS_KEY=access-key$/m);
      assert.match(exported, /^EASYSUBWAY_OBJECT_STORAGE_SECRET_KEY=secret-key$/m);
      assert.match(exported, /^EASYSUBWAY_OBJECT_STORAGE_REGION=ap-northeast-2$/m);
      assert.match(exported, /^EASYSUBWAY_DATAPACK_BUCKET=easysubway-datapacks$/m);
      assert.match(exported, /EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM<<EASYSUBWAY_EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM_EOF\nprivate-key\nline\nEASYSUBWAY_EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM_EOF/);
      assert.match(exported, /EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM<<EASYSUBWAY_EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM_EOF\npublic-key\nline\nEASYSUBWAY_EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM_EOF/);
      assert.match(exported, /^EASYSUBWAY_DATAPACK_SIGNING_KEY_ID=production-v1$/m);
      assert.doesNotMatch(exported, /ADMIN_PASSWORD/);
    },
  );
});

test("데이터팩 remote publish env exporter는 PAR URL을 secret publish target으로 내보낸다", async () => {
  await withPublishEnvWorkspace(
    "publish-par-env",
    [
      "EASYSUBWAY_DATA_PACK_BASE_URL=https://cdn.example.com/easysubway-datapacks",
      "EASYSUBWAY_DATAPACK_REMOTE_PUBLISH_ENABLED=true",
      "EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL=https://objectstorage.example.com/p/token/n/ns/b/bucket/o/",
      "EASYSUBWAY_OBJECT_STORAGE_ACCESS_KEY=access-key-must-not-export",
      "EASYSUBWAY_OBJECT_STORAGE_SECRET_KEY=secret-key-must-not-export",
      "EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM=private-key-pem",
      "EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM=public-key-pem",
      "EASYSUBWAY_DATAPACK_SIGNING_KEY_ID=production-v1",
    ],
    async ({ githubEnvFile, runExporter }) => {
      const { stdout } = await runExporter();
      const exported = await readFile(githubEnvFile, "utf8");
      assert.match(stdout, /^::add-mask::https:\/\/objectstorage\.example\.com\/p\/token\/n\/ns\/b\/bucket\/o\/$/m);
      assert.match(exported, /^EASYSUBWAY_DATAPACK_REMOTE_PUBLISH=enabled$/m);
      assert.match(exported, /^EASYSUBWAY_DATA_PACK_BASE_URL=https:\/\/cdn\.example\.com\/easysubway-datapacks$/m);
      assert.match(
        exported,
        /^EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL=https:\/\/objectstorage\.example\.com\/p\/token\/n\/ns\/b\/bucket\/o\/$/m,
      );
      assert.doesNotMatch(exported, /ACCESS_KEY/);
      assert.doesNotMatch(exported, /SECRET_KEY/);
      assert.match(exported, /^EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM=private-key-pem$/m);
      assert.match(exported, /^EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM=public-key-pem$/m);
      assert.match(exported, /^EASYSUBWAY_DATAPACK_SIGNING_KEY_ID=production-v1$/m);
    },
  );
});

test("데이터팩 remote publish env exporter는 opt-in이 없으면 원격 publish를 비활성화한다", async () => {
  await withPublishEnvWorkspace(
    "publish-env-disabled",
    LOCAL_PLACEHOLDER_ENV_LINES,
    async ({ githubEnvFile, githubOutputFile, runExporter }) => {
      await runExporter();
      assert.match(await readFile(githubEnvFile, "utf8"), /^EASYSUBWAY_DATAPACK_REMOTE_PUBLISH=disabled$/m);
      assert.match(await readFile(githubOutputFile, "utf8"), /^enabled=false$/m);
    },
  );
});

test("데이터팩 remote publish env exporter는 opt-in된 로컬 placeholder publish 대상을 거부한다", async () => {
  await withPublishEnvWorkspace(
    "publish-env-local",
    [...LOCAL_PLACEHOLDER_ENV_LINES, "EASYSUBWAY_DATAPACK_REMOTE_PUBLISH_ENABLED=true"],
    async ({ runExporter }) => {
      await assert.rejects(
        runExporter(),
        /EASYSUBWAY_DATA_PACK_BASE_URL must be an HTTPS public URL/,
      );
    },
  );
});

test("데이터팩 remote publish env exporter는 허용된 workflow에서 invalid publish env를 skip 처리한다", async () => {
  await withPublishEnvWorkspace(
    "publish-env-invalid-skip",
    [...LOCAL_PLACEHOLDER_ENV_LINES, "EASYSUBWAY_DATAPACK_REMOTE_PUBLISH_ENABLED=true"],
    async ({ githubEnvFile, githubOutputFile, runExporter }) => {
      const { stderr } = await runExporter(["--allow-invalid-disabled"]);
      assert.match(stderr, /remote publish disabled: EASYSUBWAY_DATA_PACK_BASE_URL must be an HTTPS public URL/);
      assert.match(await readFile(githubEnvFile, "utf8"), /^EASYSUBWAY_DATAPACK_REMOTE_PUBLISH=disabled$/m);
      assert.match(await readFile(githubOutputFile, "utf8"), /^enabled=false$/m);
      assert.match(await readFile(githubOutputFile, "utf8"), /^invalid=true$/m);
    },
  );
});
