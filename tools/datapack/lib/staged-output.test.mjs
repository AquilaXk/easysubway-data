import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { writeFileReplacing, writeFilesCreateOnly } from "./staged-output.mjs";

async function withDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "staged-output-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("create-only 쓰기는 모든 파일을 한 번에 드러내고 staging 흔적을 남기지 않는다", async () => {
  await withDir(async (dir) => {
    await writeFilesCreateOnly([
      { path: path.join(dir, "a.json"), bytes: Buffer.from("A") },
      { path: path.join(dir, "b.json"), bytes: Buffer.from("B") },
    ], { mode: 0o600 });
    assert.deepEqual((await readdir(dir)).sort(), ["a.json", "b.json"]);
    assert.equal(await readFile(path.join(dir, "b.json"), "utf8"), "B");
    assert.equal((await lstat(path.join(dir, "a.json"))).mode & 0o777, 0o600);
  });
});

test("create-only 쓰기는 하나라도 이미 있으면 EEXIST로 실패하고 아무것도 새로 남기지 않는다", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "c.json"), "old");
    await assert.rejects(writeFilesCreateOnly([
      { path: path.join(dir, "a.json"), bytes: Buffer.from("A") },
      { path: path.join(dir, "b.json"), bytes: Buffer.from("B") },
      { path: path.join(dir, "c.json"), bytes: Buffer.from("C") },
    ]), { code: "EEXIST" });
    assert.deepEqual(await readdir(dir), ["c.json"]);
    assert.equal(await readFile(path.join(dir, "c.json"), "utf8"), "old");
  });
});

test("create-only 쓰기는 출력 디렉터리가 없으면 실패하고 빈 목록과 중복 경로를 거부한다", async () => {
  await withDir(async (dir) => {
    await assert.rejects(writeFilesCreateOnly([{ path: path.join(dir, "missing", "a.json"), bytes: Buffer.from("A") }]), { code: "ENOENT" });
    await assert.rejects(writeFilesCreateOnly([]), /at least one file/);
    await assert.rejects(writeFilesCreateOnly([
      { path: path.join(dir, "a.json"), bytes: Buffer.from("A") },
      { path: path.join(dir, "a.json"), bytes: Buffer.from("B") },
    ]), /duplicate output path/);
    assert.deepEqual(await readdir(dir), []);
  });
});

test("교체 쓰기는 같은 디렉터리의 임시 파일을 rename하고 심볼릭 링크를 따라 쓰지 않는다", async () => {
  await withDir(async (dir) => {
    const target = path.join(dir, "target.json");
    const output = path.join(dir, "out.json");
    await writeFile(target, "keep");
    await symlink(target, output);
    await writeFileReplacing(output, Buffer.from("new"));
    assert.equal(await readFile(target, "utf8"), "keep");
    assert.equal((await lstat(output)).isSymbolicLink(), false);
    assert.equal(await readFile(output, "utf8"), "new");
    await writeFileReplacing(output, Buffer.from("newer"));
    assert.equal(await readFile(output, "utf8"), "newer");
    assert.deepEqual((await readdir(dir)).sort(), ["out.json", "target.json"]);
  });
});

test("교체 쓰기가 실패하면 기존 출력과 디렉터리를 그대로 두고 임시 파일을 지운다", async () => {
  await withDir(async (dir) => {
    const output = path.join(dir, "out");
    await mkdir(output);
    await writeFile(path.join(output, "inner"), "x");
    await assert.rejects(writeFileReplacing(output, Buffer.from("new")));
    assert.deepEqual((await readdir(dir)).sort(), ["out"]);
    await assert.rejects(writeFileReplacing(path.join(dir, "missing", "o.json"), Buffer.from("n")), { code: "ENOENT" });
  });
});
