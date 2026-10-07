import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");

// #998: Z_RLE는 거리 1 반복만 찾아 SQLite 페이지·인덱스에서 LZ77 일치를 전혀 쓰지 못한다(실팩 39.0MB vs 6.4MB).
// 이 상한은 "비효율 전략 회귀 차단"용 효율 계약이다. level 6·Z_FILTERED처럼 level 9와 몇 퍼센트 안쪽인 설정은
// 통과하도록 의도했다. level 9·기본 전략·mtime 0·OS 255 자체는 아래 바이트 동일성 테스트가 따로 고정한다.
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

test("빌더 gzip 산출물은 기본 level 9 대비 1.05배 이내로 압축된다", async () => {
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

test("빌더 gzip 산출물은 기본 전략 level 9·mtime 0·OS 표지 255 gzip과 바이트가 같다", async () => {
  const { outputDir, compressed } = await buildFixturePack();
  try {
    const expected = gzipSync(gunzipSync(compressed), { level: 9, mtime: 0 });
    expected[9] = 255;
    assert.equal(sha256(compressed), sha256(expected));
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

// gz 바이트는 Node에 번들된 zlib에 의존하므로 빌더를 실행하는 workflow의 Node를 .nvmrc 고정과 같게 둔다.
test("build-datapack.mjs를 실행하는 workflow는 floating Node 버전을 쓰지 않는다", async () => {
  const pinned = (await readFile(path.join(root, ".nvmrc"), "utf8")).trim();
  const workflowDirectory = path.join(root, ".github/workflows");
  const offenders = [];
  let checkedWorkflows = 0;
  for (const name of (await readdir(workflowDirectory)).filter((file) => file.endsWith(".yml"))) {
    const text = await readFile(path.join(workflowDirectory, name), "utf8");
    if (!/tools\/datapack\/build-datapack\.mjs/.test(text)) continue;
    checkedWorkflows += 1;
    for (const match of text.matchAll(/^\s*node-version(-file)?:\s*["']?([^"'\s#]+)["']?/gm)) {
      const allowed = match[1] ? match[2] === ".nvmrc" : match[2] === pinned;
      if (!allowed) offenders.push(`${name}: ${match[0].trim()}`);
    }
  }
  assert.ok(checkedWorkflows > 0, "build-datapack.mjs를 실행하는 workflow를 찾지 못함");
  assert.deepEqual(offenders, []);
});
