import { mkdir, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256 } from "../lib/hash.mjs";
import { execFileAsync, objectStorageEnv, startObjectStorageServer } from "./test-fixtures/datapack-tools-support.mjs";

const root = path.resolve(import.meta.dirname, "../..");

const PACK_BYTES = Buffer.from("pack payload");
const MANIFEST_BYTES = Buffer.from('{"packs":[{"id":"capital","version":"1"}]}\n');

function putAndVerifyPackSteps(sourcePath, bytes, verifySha256 = sha256(bytes)) {
  return [
    {
      type: "put-pack-object",
      sourcePath,
      objectKey: sourcePath,
      sha256: sha256(bytes),
      sizeBytes: bytes.length,
    },
    {
      type: "verify-pack-object",
      objectKey: sourcePath,
      sha256: verifySha256,
      sizeBytes: bytes.length,
    },
  ];
}

function putManifestStep(sourcePath, bytes) {
  return {
    type: "put-manifest-object",
    sourcePath,
    objectKey: sourcePath,
    sha256: sha256(bytes),
    sizeBytes: bytes.length,
  };
}

async function withPublishStage({ prefix, subDir = "catalog", files, steps, serverOptions }, fn) {
  const stageDir = path.join(tmpdir(), `easysubway-datapack-${prefix}-${Date.now()}`);
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(path.join(stageDir, subDir), { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    await writeFile(path.join(stageDir, relativePath), content);
  }
  const planPath = path.join(stageDir, "publish-plan.json");
  await writeFile(planPath, `${JSON.stringify({ schemaVersion: 1, steps }, null, 2)}\n`);
  const server = await startObjectStorageServer(serverOptions);
  try {
    await fn({ stageDir, planPath, server });
  } finally {
    await server.close();
    await rm(stageDir, { recursive: true, force: true });
  }
}

function runPublishObjectStorage({ planPath, stageDir, env, extraArgs = [] }) {
  return execFileAsync(
    process.execPath,
    ["tools/datapack/publish-object-storage.mjs", "--plan", planPath, "--root", stageDir, ...extraArgs],
    { cwd: root, env },
  );
}

test("데이터팩 object storage publisher는 pack 검증 후 manifest를 마지막에 PUT한다", async () => {
  await withPublishStage(
    {
      prefix: "object-publish",
      files: {
        "catalog/capital-v1.sqlite.gz": PACK_BYTES,
        "catalog/current.json": MANIFEST_BYTES,
      },
      steps: [
        ...putAndVerifyPackSteps("catalog/capital-v1.sqlite.gz", PACK_BYTES),
        putManifestStep("catalog/current.json", MANIFEST_BYTES),
        {
          type: "verify-manifest-object",
          objectKey: "catalog/current.json",
          sha256: sha256(MANIFEST_BYTES),
          sizeBytes: MANIFEST_BYTES.length,
        },
      ],
    },
    async ({ stageDir, planPath, server }) => {
      const env = objectStorageEnv(server.origin);
      await runPublishObjectStorage({ planPath, stageDir, env });

      assert.deepEqual(
        server.requests.map((request) => `${request.method} ${request.path}`),
        [
          "PUT /easysubway-datapacks/catalog/capital-v1.sqlite.gz",
          "HEAD /easysubway-datapacks/catalog/capital-v1.sqlite.gz",
          "PUT /easysubway-datapacks/catalog/current.json",
          "HEAD /easysubway-datapacks/catalog/current.json",
        ],
      );
      assert.ok(
        server.requests.every((request) => request.authorization?.startsWith("AWS4-HMAC-SHA256 ")),
        "publisher must sign every object storage request",
      );
      assert.equal(server.objects.get("catalog/capital-v1.sqlite.gz").sha256, sha256(PACK_BYTES));
      assert.equal(server.objects.get("catalog/current.json").sha256, sha256(MANIFEST_BYTES));

      await runPublishObjectStorage({ planPath, stageDir, env, extraArgs: ["--verify-only"] });
      assert.deepEqual(
        server.requests.slice(-2).map((request) => `${request.method} ${request.path}`),
        [
          "HEAD /easysubway-datapacks/catalog/capital-v1.sqlite.gz",
          "HEAD /easysubway-datapacks/catalog/current.json",
        ],
      );
    },
  );
});

test("데이터팩 object storage publisher는 PDF와 SVG content type을 보존한다", async () => {
  const pdfBytes = Buffer.from("%PDF-1.6\n");
  const svgBytes = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\" />\n");

  await withPublishStage(
    {
      prefix: "map-asset-publish",
      subDir: "maps",
      files: {
        "maps/seoul.pdf": pdfBytes,
        "maps/gwangju.svg": svgBytes,
      },
      steps: [
        ...putAndVerifyPackSteps("maps/seoul.pdf", pdfBytes),
        ...putAndVerifyPackSteps("maps/gwangju.svg", svgBytes),
      ],
    },
    async ({ stageDir, planPath, server }) => {
      await runPublishObjectStorage({ planPath, stageDir, env: objectStorageEnv(server.origin) });

      assert.equal(server.objects.get("maps/seoul.pdf").contentType, "application/pdf");
      assert.equal(server.objects.get("maps/gwangju.svg").contentType, "image/svg+xml");
    },
  );
});

test("데이터팩 object storage publisher는 PAR URL로 pack 검증 후 manifest를 마지막에 PUT한다", async () => {
  await withPublishStage(
    {
      prefix: "par-publish",
      files: {
        "catalog/capital-v1.sqlite.gz": PACK_BYTES,
        "catalog/current.json": MANIFEST_BYTES,
      },
      steps: [
        ...putAndVerifyPackSteps("catalog/capital-v1.sqlite.gz", PACK_BYTES),
        putManifestStep("catalog/current.json", MANIFEST_BYTES),
      ],
      serverOptions: { requireAuthorization: false, basePath: "/p/par-token/n/ns/b/bucket/o" },
    },
    async ({ stageDir, planPath, server }) => {
      await runPublishObjectStorage({
        planPath,
        stageDir,
        env: {
          ...process.env,
          EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: `${server.origin}/p/par-token/n/ns/b/bucket/o/`,
        },
      });

      assert.deepEqual(
        server.requests.map((request) => `${request.method} ${request.path}`),
        [
          "PUT /p/par-token/n/ns/b/bucket/o/catalog/capital-v1.sqlite.gz",
          "GET /p/par-token/n/ns/b/bucket/o/catalog/capital-v1.sqlite.gz",
          "PUT /p/par-token/n/ns/b/bucket/o/catalog/current.json",
        ],
      );
      assert.ok(
        server.requests.every((request) => request.authorization === undefined),
        "PAR publisher must not send S3 authorization headers",
      );
      assert.equal(server.objects.get("catalog/capital-v1.sqlite.gz").sha256, sha256(PACK_BYTES));
      assert.equal(server.objects.get("catalog/current.json").sha256, sha256(MANIFEST_BYTES));
    },
  );
});

test("데이터팩 object storage publisher는 pack 검증 실패 시 manifest를 게시하지 않는다", async () => {
  await withPublishStage(
    {
      prefix: "object-publish-fail",
      files: {
        "catalog/capital-v1.sqlite.gz": PACK_BYTES,
        "catalog/current.json": MANIFEST_BYTES,
      },
      steps: [
        ...putAndVerifyPackSteps("catalog/capital-v1.sqlite.gz", PACK_BYTES, "0".repeat(64)),
        putManifestStep("catalog/current.json", MANIFEST_BYTES),
      ],
    },
    async ({ stageDir, planPath, server }) => {
      await assert.rejects(
        runPublishObjectStorage({ planPath, stageDir, env: objectStorageEnv(server.origin) }),
        /catalog\/capital-v1\.sqlite\.gz uploaded checksum mismatch/,
      );

      assert.deepEqual(
        server.requests.map((request) => `${request.method} ${request.path}`),
        [
          "PUT /easysubway-datapacks/catalog/capital-v1.sqlite.gz",
          "HEAD /easysubway-datapacks/catalog/capital-v1.sqlite.gz",
        ],
      );
      assert.equal(server.objects.has("catalog/current.json"), false);
    },
  );
});
