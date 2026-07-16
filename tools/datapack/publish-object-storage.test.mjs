import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// 메모리 객체 저장소 mock: PUT 저장, HEAD/GET 응답. Cache-Control·meta-sha256 기록.
// preauth(opc-meta-sha256)·signed(x-amz-meta-sha256) 양쪽 메타 헤더 모두 저장하고 응답에 포함.
function startMockStorage() {
  const objects = new Map(); // key -> { body, sha256, cacheControl }
  const conditionalPutAttempts = new Map();
  const server = createServer((req, res) => {
    const key = decodeURIComponent(req.url.replace(/^\//, ""));
    if (req.method === "PUT") {
      if (req.headers["if-none-match"] === "*") {
        conditionalPutAttempts.set(key, (conditionalPutAttempts.get(key) ?? 0) + 1);
        if (objects.has(key)) {
          res.statusCode = 412;
          res.end();
          return;
        }
      }
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        objects.set(key, {
          body,
          sha256: req.headers["opc-meta-sha256"] ?? req.headers["x-amz-meta-sha256"],
          cacheControl: req.headers["cache-control"],
        });
        res.statusCode = 200;
        res.end();
      });
      return;
    }
    const found = objects.get(key);
    if (!found) { res.statusCode = 404; res.end(); return; }
    if (found.cacheControl) res.setHeader("cache-control", found.cacheControl);
    res.setHeader("content-length", String(found.body.length));
    if (found.sha256) res.setHeader("x-amz-meta-sha256", found.sha256);
    res.statusCode = 200;
    res.end(req.method === "HEAD" ? undefined : found.body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      server, objects, conditionalPutAttempts, port: server.address().port,
    }));
  });
}

async function runPublish(planPath, root, baseUrl) {
  return execFileAsync("node", [
    path.join(REPO_ROOT, "tools/datapack/publish-object-storage.mjs"),
    "--plan", planPath, "--root", root,
  ], { env: { ...process.env, EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: baseUrl } });
}

async function runPublishSigned(planPath, root, port) {
  const env = { ...process.env };
  delete env.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL;
  env.EASYSUBWAY_OBJECT_STORAGE_ENDPOINT = `http://127.0.0.1:${port}`;
  env.EASYSUBWAY_DATAPACK_BUCKET = "testbucket";
  env.EASYSUBWAY_OBJECT_STORAGE_REGION = "us-east-1";
  env.EASYSUBWAY_OBJECT_STORAGE_ACCESS_KEY = "test";
  env.EASYSUBWAY_OBJECT_STORAGE_SECRET_KEY = "test";
  return execFileAsync("node", [
    path.join(REPO_ROOT, "tools/datapack/publish-object-storage.mjs"),
    "--plan", planPath, "--root", root,
  ], { env });
}

test("게시 실행기는 동일 sha의 releases 객체 재게시를 멱등 skip하고 상이 sha는 거부한다", async () => {
  const mock = await startMockStorage();
  const workspace = await mkdtemp(path.join(tmpdir(), "publish-run-"));
  const baseUrl = `http://127.0.0.1:${mock.port}`;
  try {
    await mkdir(path.join(workspace, "catalog"), { recursive: true });
    const manifestBytes = Buffer.from(JSON.stringify({ ok: 1 }));
    const bindingBytes = Buffer.from(JSON.stringify({ request: "request-2057" }));
    await writeFile(path.join(workspace, "catalog", "current.json"), manifestBytes);
    await writeFile(path.join(workspace, "catalog", "release-request-binding.json"), bindingBytes);
    const plan = {
      schemaVersion: 2,
      mode: "object-storage-preflight",
      manifestObjectKey: "catalog/current.json",
      steps: [
        { type: "put-release-manifest-object", sourcePath: "catalog/current.json",
          objectKey: "catalog/releases/5.json", sha256: sha256(manifestBytes),
          sizeBytes: manifestBytes.length, packCount: 1, immutable: true },
        { type: "verify-release-manifest-object", objectKey: "catalog/releases/5.json",
          sha256: sha256(manifestBytes), sizeBytes: manifestBytes.length, packCount: 1, immutable: true },
        { type: "put-release-request-binding-object", sourcePath: "catalog/release-request-binding.json",
          objectKey: `catalog/release-requests/${"a".repeat(64)}.json`, sha256: sha256(bindingBytes),
          sizeBytes: bindingBytes.length, immutable: true },
        { type: "verify-release-request-binding-object",
          objectKey: `catalog/release-requests/${"a".repeat(64)}.json`, sha256: sha256(bindingBytes),
          sizeBytes: bindingBytes.length, immutable: true },
        { type: "put-manifest-object", sourcePath: "catalog/current.json",
          objectKey: "catalog/current.json", sha256: sha256(manifestBytes),
          sizeBytes: manifestBytes.length, packCount: 1 },
        { type: "verify-manifest-object", objectKey: "catalog/current.json",
          sha256: sha256(manifestBytes), sizeBytes: manifestBytes.length, packCount: 1 },
      ],
    };
    const planPath = path.join(workspace, "plan.json");
    await writeFile(planPath, JSON.stringify(plan));

    // 1회차: 정상 게시.
    await runPublish(planPath, workspace, baseUrl);
    assert.ok(mock.objects.has("catalog/releases/5.json"));
    assert.ok(mock.objects.has(`catalog/release-requests/${"a".repeat(64)}.json`));

    // 2회차: 동일 바이트 재게시 → 멱등 성공(에러 없음).
    await runPublish(planPath, workspace, baseUrl);
    assert.equal(
      mock.conditionalPutAttempts.get(`catalog/release-requests/${"a".repeat(64)}.json`),
      2,
      "immutable binding은 매번 atomic conditional create를 사용해야 한다",
    );

    // 상이 바이트를 같은 seq로: releases/5.json에 다른 sha를 심어두고 재실행 → 거부.
    mock.objects.set("catalog/releases/5.json", { body: Buffer.from("different"), sha256: sha256(Buffer.from("different")), cacheControl: "public, max-age=31536000, immutable" });
    await assert.rejects(runPublish(planPath, workspace, baseUrl), /immutable violation/);
  } finally {
    mock.server.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("signed 클라이언트는 releases 객체 불변 제약과 멱등 skip을 올바르게 수행한다", async () => {
  const mock = await startMockStorage();
  const workspace = await mkdtemp(path.join(tmpdir(), "publish-signed-"));
  // signed mode에서 objectUrl은 /<bucket>/<key> 경로를 구성하므로
  // mock은 "testbucket/catalog/releases/5.json" 키로 저장한다.
  const BUCKET_KEY = "testbucket/catalog/releases/5.json";
  const BINDING_KEY = `testbucket/catalog/release-requests/${"a".repeat(64)}.json`;
  try {
    await mkdir(path.join(workspace, "catalog"), { recursive: true });
    const manifestBytes = Buffer.from(JSON.stringify({ signed: true }));
    const bindingBytes = Buffer.from(JSON.stringify({ request: "request-2057" }));
    await writeFile(path.join(workspace, "catalog", "current.json"), manifestBytes);
    await writeFile(path.join(workspace, "catalog", "release-request-binding.json"), bindingBytes);
    const plan = {
      schemaVersion: 2,
      mode: "object-storage-preflight",
      manifestObjectKey: "catalog/current.json",
      steps: [
        { type: "put-release-manifest-object", sourcePath: "catalog/current.json",
          objectKey: "catalog/releases/5.json", sha256: sha256(manifestBytes),
          sizeBytes: manifestBytes.length, packCount: 1, immutable: true },
        { type: "verify-release-manifest-object", objectKey: "catalog/releases/5.json",
          sha256: sha256(manifestBytes), sizeBytes: manifestBytes.length, packCount: 1, immutable: true },
        { type: "put-release-request-binding-object", sourcePath: "catalog/release-request-binding.json",
          objectKey: `catalog/release-requests/${"a".repeat(64)}.json`, sha256: sha256(bindingBytes),
          sizeBytes: bindingBytes.length, immutable: true },
        { type: "verify-release-request-binding-object",
          objectKey: `catalog/release-requests/${"a".repeat(64)}.json`, sha256: sha256(bindingBytes),
          sizeBytes: bindingBytes.length, immutable: true },
        { type: "put-manifest-object", sourcePath: "catalog/current.json",
          objectKey: "catalog/current.json", sha256: sha256(manifestBytes),
          sizeBytes: manifestBytes.length, packCount: 1 },
        { type: "verify-manifest-object", objectKey: "catalog/current.json",
          sha256: sha256(manifestBytes), sizeBytes: manifestBytes.length, packCount: 1 },
      ],
    };
    const planPath = path.join(workspace, "plan.json");
    await writeFile(planPath, JSON.stringify(plan));

    // 1회차: 정상 게시 — mock에 bucket 포함 경로로 저장.
    await runPublishSigned(planPath, workspace, mock.port);
    assert.ok(mock.objects.has(BUCKET_KEY), `mock에 ${BUCKET_KEY} 저장 확인`);
    assert.ok(mock.objects.has(BINDING_KEY), `mock에 ${BINDING_KEY} 저장 확인`);
    assert.equal(mock.objects.get(BUCKET_KEY).sha256, sha256(manifestBytes));

    // 2회차: 동일 sha → 멱등 skip (에러 없음).
    await runPublishSigned(planPath, workspace, mock.port);
    assert.equal(mock.conditionalPutAttempts.get(BINDING_KEY), 2);

    // metadata가 원래 checksum을 주장해도 실제 immutable binding body가 바뀌면 거부한다.
    mock.objects.set(BINDING_KEY, {
      body: Buffer.from(JSON.stringify({ request: "request-9999" })),
      sha256: sha256(bindingBytes),
      cacheControl: "public, max-age=31536000, immutable",
    });
    await assert.rejects(runPublishSigned(planPath, workspace, mock.port), /immutable violation|checksum mismatch/);
    mock.objects.set(BINDING_KEY, {
      body: bindingBytes,
      sha256: sha256(bindingBytes),
      cacheControl: "public, max-age=31536000, immutable",
    });

    // 상이 바이트를 같은 seq로 심은 뒤 재실행 → immutable violation 거부.
    const differentBytes = Buffer.from("completely-different-content");
    mock.objects.set(BUCKET_KEY, {
      body: differentBytes,
      sha256: sha256(differentBytes),
      cacheControl: "public, max-age=31536000, immutable",
    });
    await assert.rejects(runPublishSigned(planPath, workspace, mock.port), /immutable violation/);
  } finally {
    mock.server.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("게시 실행기는 current=max-age=60, releases=immutable Cache-Control을 PUT에 부여한다", async () => {
  const mock = await startMockStorage();
  const workspace = await mkdtemp(path.join(tmpdir(), "publish-cc-"));
  const baseUrl = `http://127.0.0.1:${mock.port}`;
  try {
    await mkdir(path.join(workspace, "catalog"), { recursive: true });
    const manifestBytes = Buffer.from(JSON.stringify({ ok: 2 }));
    await writeFile(path.join(workspace, "catalog", "current.json"), manifestBytes);
    const step = (type, objectKey) => ({ type, sourcePath: "catalog/current.json", objectKey,
      sha256: sha256(manifestBytes), sizeBytes: manifestBytes.length, packCount: 1, immutable: type.includes("release") });
    const plan = { schemaVersion: 2, mode: "object-storage-preflight", manifestObjectKey: "catalog/current.json",
      steps: [
        step("put-release-manifest-object", "catalog/releases/9.json"),
        { type: "verify-release-manifest-object", objectKey: "catalog/releases/9.json", sha256: sha256(manifestBytes), sizeBytes: manifestBytes.length, packCount: 1, immutable: true },
        step("put-manifest-object", "catalog/current.json"),
        { type: "verify-manifest-object", objectKey: "catalog/current.json", sha256: sha256(manifestBytes), sizeBytes: manifestBytes.length, packCount: 1 },
      ] };
    const planPath = path.join(workspace, "plan.json");
    await writeFile(planPath, JSON.stringify(plan));

    await runPublish(planPath, workspace, baseUrl);

    assert.equal(mock.objects.get("catalog/current.json").cacheControl, "public, max-age=60");
    assert.equal(mock.objects.get("catalog/releases/9.json").cacheControl, "public, max-age=31536000, immutable");
  } finally {
    mock.server.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
