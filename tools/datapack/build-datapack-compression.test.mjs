import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");

// #998: Z_RLE는 거리 1 반복만 찾아 SQLite 페이지·인덱스에서 LZ77 일치를 전혀 쓰지 못한다(실팩 39.0MB vs 6.4MB).
// 기본 전략 level 9 대비 허용 오차를 둬 압축 효율 회귀를 계약으로 고정한다.
const MAX_RATIO_VS_DEFAULT_LEVEL_9 = 1.05;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function buildFixturePack() {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-datapack-compression-"));
  await execFileAsync(
    process.execPath,
    ["tools/datapack/build-datapack.mjs", "--fixture", "tools/datapack/fixtures/catalog-fixture.json", "--output", outputDir],
    { cwd: root, env: process.env },
  );
  const manifest = JSON.parse(await readFile(path.join(outputDir, "current.json"), "utf8"));
  const pack = manifest.packs[0];
  const compressed = await readFile(path.join(outputDir, pack.url));
  return { outputDir, pack, compressed };
}

test("빌더 gzip 산출물은 기본 deflate level 9 수준으로 압축된다", async () => {
  const { outputDir, compressed } = await buildFixturePack();
  try {
    const sqlite = gunzipSync(compressed);
    const baseline = gzipSync(sqlite, { level: 9, mtime: 0 });
    assert.ok(
      compressed.length <= baseline.length * MAX_RATIO_VS_DEFAULT_LEVEL_9,
      `compressed ${compressed.length} B exceeds ${MAX_RATIO_VS_DEFAULT_LEVEL_9}x of default level 9 ${baseline.length} B`,
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("빌더 gzip 산출물은 해시·크기·헤더 결정성 규약을 유지한다", async () => {
  const first = await buildFixturePack();
  const second = await buildFixturePack();
  try {
    const sqlite = gunzipSync(first.compressed);
    assert.equal(sha256(sqlite), first.pack.sqliteSha256);
    assert.equal(sha256(first.compressed), first.pack.sha256);
    assert.equal(first.compressed.length, first.pack.sizeBytes);
    // mtime 0(4~7번째 바이트)과 플랫폼 OS 표지 255(9번째 바이트)로 실행 환경과 무관한 바이트를 보장한다.
    assert.deepEqual([...first.compressed.subarray(0, 4)], [0x1f, 0x8b, 0x08, 0x00]);
    assert.deepEqual([...first.compressed.subarray(4, 8)], [0, 0, 0, 0]);
    assert.equal(first.compressed[9], 255);
    // 같은 입력 두 번 빌드 → 같은 gz 바이트.
    assert.equal(sha256(first.compressed), sha256(second.compressed));
  } finally {
    await rm(first.outputDir, { recursive: true, force: true });
    await rm(second.outputDir, { recursive: true, force: true });
  }
});
