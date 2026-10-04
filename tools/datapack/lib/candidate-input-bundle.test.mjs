import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CANDIDATE_INPUT_FETCH_POLICY,
  CANDIDATE_INPUT_MANIFEST_PATH,
  assertCandidateInputsCurrent,
  buildCandidateInputManifest,
  candidateInputFetchTimeoutMs,
  candidateInputObjectKey,
  createCandidateInputReader,
  createRecordingReader,
  parseCandidateInputManifest,
  publishCandidateInputObjects,
} from "./candidate-input-bundle.mjs";

// #942: 후보가 만들어질 때 읽은 입력 바이트를 경로·sha256 매니페스트로 고정하고, 바이트는 OCI 공개 읽기 경로에서 받는다.
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const BASE_URL = "https://objectstorage.example.test/n/ns/b/bucket/o";
// 디스크 캐시는 프로세스 사이에서 공유되므로, 받기 횟수를 세는 테스트는 매번 빈 캐시 디렉터리를 쓴다.
function freshCacheDirectory() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "candidate-input-cache-test-"));
  process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
const files = new Map([
  ["tools/datapack/source-inventory.json", Buffer.from("{\"inventory\":1}\n")],
  ["tools/datapack/release/source-snapshots.json", Buffer.from("[{\"row\":1}]\n")],
]);
const binding = Object.freeze({
  candidateId: "nationwide-candidate-20261004-seq127",
  candidateBuildSpecSha256: "a".repeat(64),
  preparationSha256: "b".repeat(64),
  fanInSha256: "c".repeat(64),
});

async function recordedManifest() {
  const recorder = createRecordingReader(async (relative) => files.get(relative));
  for (const relative of files.keys()) await recorder.read(relative);
  await recorder.read("tools/datapack/source-inventory.json");
  return buildCandidateInputManifest({ ...binding, entries: recorder.entries() });
}

test("매니페스트는 후보가 읽은 입력을 경로 순서로 한 번씩 sha256·크기와 함께 고정한다", async () => {
  const manifest = await recordedManifest();
  assert.equal(CANDIDATE_INPUT_MANIFEST_PATH, "tools/datapack/release/nationwide-candidate-input-manifest.json");
  assert.deepEqual(manifest, {
    schemaVersion: 1,
    artifactKind: "nationwide-candidate-input-manifest",
    ...binding,
    objectKeyPrefix: "candidate-inputs/sha256/",
    files: [...files.entries()]
      .map(([relative, bytes]) => ({ path: relative, sha256: sha256(bytes), byteSize: bytes.length }))
      .sort((left, right) => (left.path < right.path ? -1 : 1)),
  });
  assert.deepEqual(parseCandidateInputManifest(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)), manifest);
  assert.equal(candidateInputObjectKey("d".repeat(64)), `candidate-inputs/sha256/${"d".repeat(64)}`);
  assert.throws(() => candidateInputObjectKey("../x"), /CANDIDATE_INPUT_MANIFEST_INVALID/);
});

test("매니페스트 형식이 다르면 명시적으로 거부한다", async () => {
  const manifest = await recordedManifest();
  const variants = [
    { ...manifest, extra: true },
    { ...manifest, files: [...manifest.files].reverse() },
    { ...manifest, files: [manifest.files[0], manifest.files[0]] },
    { ...manifest, files: [{ ...manifest.files[0], sha256: "x" }] },
    { ...manifest, files: [{ ...manifest.files[0], path: "../escape.json" }] },
    { ...manifest, files: [{ ...manifest.files[0], path: "/abs.json" }] },
    { ...manifest, objectKeyPrefix: "other/" },
    { ...manifest, files: [] },
  ];
  for (const variant of variants) {
    assert.throws(() => parseCandidateInputManifest(Buffer.from(JSON.stringify(variant))), /CANDIDATE_INPUT_MANIFEST_INVALID/);
  }
});

test("작업 트리 바이트가 고정값과 같으면 네트워크 없이 그대로 읽는다", async () => {
  const manifest = await recordedManifest();
  let fetched = 0;
  const read = createCandidateInputReader({ cacheDirectory: freshCacheDirectory(),
    manifest,
    readLocal: async (relative) => files.get(relative),
    baseUrl: null,
    fetchImpl: async () => { fetched += 1; throw new Error("unexpected fetch"); },
  });
  assert.deepEqual(await read("tools/datapack/source-inventory.json"), files.get("tools/datapack/source-inventory.json"));
  assert.equal(fetched, 0);
});

test("작업 트리가 고정값과 다르면 OCI 공개 읽기 경로에서 받아 sha256을 확인한 뒤 쓴다", async () => {
  const manifest = await recordedManifest();
  const pinned = files.get("tools/datapack/release/source-snapshots.json");
  const requested = [];
  const read = createCandidateInputReader({ cacheDirectory: freshCacheDirectory(),
    manifest,
    readLocal: async () => Buffer.from("[{\"row\":1},{\"row\":2}]\n"),
    baseUrl: BASE_URL,
    fetchImpl: async (url, options) => {
      requested.push({ url, hasSignal: options?.signal instanceof AbortSignal });
      return new Response(pinned, { status: 200 });
    },
  });
  assert.deepEqual(await read("tools/datapack/release/source-snapshots.json"), pinned);
  assert.deepEqual(requested, [{ url: `${BASE_URL}/candidate-inputs/sha256/${sha256(pinned)}`, hasSignal: true }]);
});

test("고정되지 않은 경로·공개 경로 미설정·받은 바이트 불일치·받기 실패는 건너뛰지 않고 실패한다", async () => {
  const manifest = await recordedManifest();
  const stale = async () => Buffer.from("changed\n");
  await assert.rejects(createCandidateInputReader({ cacheDirectory: freshCacheDirectory(), manifest, readLocal: stale, baseUrl: BASE_URL, fetchImpl: fetch })(
    "tools/datapack/unpinned.json"), /CANDIDATE_INPUT_NOT_PINNED: tools\/datapack\/unpinned.json/);
  await assert.rejects(createCandidateInputReader({ cacheDirectory: freshCacheDirectory(), manifest, readLocal: stale, baseUrl: "", fetchImpl: fetch })(
    "tools/datapack/source-inventory.json"), /CANDIDATE_INPUT_BASE_URL_REQUIRED/);
  await assert.rejects(createCandidateInputReader({ cacheDirectory: freshCacheDirectory(),
    manifest, readLocal: stale, baseUrl: BASE_URL, fetchImpl: async () => new Response("forged", { status: 200 }),
  })("tools/datapack/source-inventory.json"), /CANDIDATE_INPUT_SHA_MISMATCH: tools\/datapack\/source-inventory.json/);
  let attempts = 0;
  await assert.rejects(createCandidateInputReader({ cacheDirectory: freshCacheDirectory(),
    manifest, readLocal: stale, baseUrl: BASE_URL,
    fetchImpl: async () => { attempts += 1; return new Response("missing", { status: 404 }); },
    policy: { ...CANDIDATE_INPUT_FETCH_POLICY, backoffMs: 0 },
  })("tools/datapack/source-inventory.json"), /CANDIDATE_INPUT_FETCH_FAILED: tools\/datapack\/source-inventory.json/);
  assert.equal(attempts, CANDIDATE_INPUT_FETCH_POLICY.attempts);
});

test("받기 실패는 정책 횟수 안에서만 다시 시도하고, 시간 제한을 넘기면 중단한다", async () => {
  // #943 리뷰 F3: 시도마다 30초 + 최저 1MB/s로 받는 데 걸리는 시간. 34MB 입력은 64초다.
  assert.deepEqual(CANDIDATE_INPUT_FETCH_POLICY, { attempts: 3, baseTimeoutMs: 30_000, minBytesPerSecond: 1_000_000, backoffMs: 1_000 });
  assert.equal(candidateInputFetchTimeoutMs(0), 30_000);
  assert.equal(candidateInputFetchTimeoutMs(34_000_000), 64_000);
  const manifest = await recordedManifest();
  const pinned = files.get("tools/datapack/source-inventory.json");
  let attempts = 0;
  const read = createCandidateInputReader({ cacheDirectory: freshCacheDirectory(),
    manifest, readLocal: async () => Buffer.from("changed\n"), baseUrl: BASE_URL,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) throw new TypeError("network reset");
      return new Response(pinned, { status: 200 });
    },
    policy: { ...CANDIDATE_INPUT_FETCH_POLICY, backoffMs: 0 },
  });
  assert.deepEqual(await read("tools/datapack/source-inventory.json"), pinned);
  assert.equal(attempts, 3);
  const slow = createCandidateInputReader({ cacheDirectory: freshCacheDirectory(),
    manifest, readLocal: async () => Buffer.from("changed\n"), baseUrl: BASE_URL,
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason));
    }),
    policy: { attempts: 1, baseTimeoutMs: 10, minBytesPerSecond: 1_000_000_000, backoffMs: 0 },
  });
  await assert.rejects(slow("tools/datapack/source-inventory.json"), /CANDIDATE_INPUT_FETCH_FAILED/);
});

test("currency 검사는 고정한 입력이 작업 트리와 하나라도 다르면 그 경로를 모두 밝히며 실패한다", async () => {
  const manifest = await recordedManifest();
  await assertCandidateInputsCurrent({ manifest, readLocal: async (relative) => files.get(relative) });
  await assert.rejects(assertCandidateInputsCurrent({
    manifest,
    readLocal: async (relative) => (relative.endsWith("source-snapshots.json") ? Buffer.from("[]\n") : files.get(relative)),
  }), /CANDIDATE_INPUT_STALE: tools\/datapack\/release\/source-snapshots.json/);
});

test("발행은 없는 객체만 올리고, 이미 있는 객체는 바이트가 같은지 읽어 확인한다", async () => {
  const manifest = await recordedManifest();
  const stored = new Map([[candidateInputObjectKey(manifest.files[0].sha256), files.get(manifest.files[0].path)]]);
  const puts = [];
  const client = {
    putObjectIfAbsent: async (key, bytes) => {
      if (stored.has(key)) return false;
      puts.push(key);
      stored.set(key, Buffer.from(bytes));
      return true;
    },
    readObject: async (key) => (stored.has(key) ? { exists: true, body: stored.get(key) } : { exists: false }),
  };
  const result = await publishCandidateInputObjects({ manifest, readLocal: async (relative) => files.get(relative), client });
  assert.deepEqual(puts, [candidateInputObjectKey(manifest.files[1].sha256)]);
  assert.deepEqual(result, { uploaded: 1, verifiedExisting: 1 });
  stored.set(candidateInputObjectKey(manifest.files[0].sha256), Buffer.from("tampered"));
  await assert.rejects(publishCandidateInputObjects({ manifest, readLocal: async (relative) => files.get(relative), client }),
    /CANDIDATE_INPUT_OBJECT_MISMATCH/);
  await assert.rejects(publishCandidateInputObjects({ manifest, readLocal: async () => Buffer.from("changed"), client }),
    /CANDIDATE_INPUT_STALE/);
});

test("받은 바이트는 매니페스트 byteSize를 넘으면 읽기를 멈추고 실패한다", async () => {
  const manifest = await recordedManifest();
  const entry = manifest.files.find((file) => file.path === "tools/datapack/source-inventory.json");
  const oversized = Buffer.concat([files.get(entry.path), Buffer.from("x".repeat(64))]);
  let pulled = 0;
  const streamingOversize = () => new Response(new ReadableStream({
    pull(controller) {
      pulled += 1;
      if (pulled > 100) { controller.close(); return; }
      controller.enqueue(oversized);
    },
  }), { status: 200 });
  const policy = { ...CANDIDATE_INPUT_FETCH_POLICY, attempts: 1, backoffMs: 0 };
  await assert.rejects(createCandidateInputReader({
    cacheDirectory: freshCacheDirectory(), manifest, readLocal: async () => Buffer.from("changed\n"), baseUrl: BASE_URL, policy,
    fetchImpl: async () => new Response(oversized, { status: 200, headers: { "content-length": String(oversized.length) } }),
  })(entry.path), /CANDIDATE_INPUT_SIZE_MISMATCH: tools\/datapack\/source-inventory.json/);
  await assert.rejects(createCandidateInputReader({
    cacheDirectory: freshCacheDirectory(), manifest, readLocal: async () => Buffer.from("changed\n"), baseUrl: BASE_URL, policy,
    fetchImpl: async () => streamingOversize(),
  })(entry.path), /CANDIDATE_INPUT_SIZE_MISMATCH: tools\/datapack\/source-inventory.json/);
  assert.ok(pulled < 100, `stream was not cut off early (${pulled} chunks)`);
});

test("받은 고정 바이트는 sha256 이름의 디스크 캐시에 두고, 다른 프로세스도 sha256을 다시 확인한 뒤에만 쓴다", async () => {
  const manifest = await recordedManifest();
  const entry = manifest.files.find((file) => file.path === "tools/datapack/source-inventory.json");
  const pinned = files.get(entry.path);
  const cacheDirectory = freshCacheDirectory();
  let fetched = 0;
  const options = {
    cacheDirectory, manifest, readLocal: async () => Buffer.from("changed\n"), baseUrl: BASE_URL,
    policy: { ...CANDIDATE_INPUT_FETCH_POLICY, backoffMs: 0 },
    fetchImpl: async () => { fetched += 1; return new Response(pinned, { status: 200 }); },
  };
  assert.deepEqual(await createCandidateInputReader(options)(entry.path), pinned);
  assert.equal(fetched, 1);
  assert.deepEqual(await readdir(cacheDirectory), [entry.sha256]);
  // 새 reader(다른 테스트 프로세스와 같다)는 캐시를 확인해 받지 않는다.
  assert.deepEqual(await createCandidateInputReader(options)(entry.path), pinned);
  assert.equal(fetched, 1);
  // 캐시 파일이 바뀌어 있으면 쓰지 않고 다시 받아 덮어쓴다.
  await writeFile(path.join(cacheDirectory, entry.sha256), Buffer.from("tampered"));
  assert.deepEqual(await createCandidateInputReader(options)(entry.path), pinned);
  assert.equal(fetched, 2);
  assert.deepEqual(await readFile(path.join(cacheDirectory, entry.sha256)), pinned);
});
