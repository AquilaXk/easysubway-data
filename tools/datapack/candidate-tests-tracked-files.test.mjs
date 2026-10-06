import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// #884: 후보 준비·갱신 테스트는 실행해도 커밋된 release 산출물을 바꾸지 않아야 한다.
// 같은 shard에서 함께 도는 경우(동시 실행)까지 재현해 추적 파일 sha가 그대로인지 확인한다.
const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const GUARDED_TESTS = [
  "tools/datapack/prepare-nationwide-candidate-run.test.mjs",
  "tools/datapack/refresh-nationwide-candidate.test.mjs",
];

function trackedFileShas() {
  const files = execFileSync("git", ["ls-files", "-z", "--", "tools/datapack/release"], { cwd: root, encoding: "utf8" })
    .split("\0").filter(Boolean);
  return Object.fromEntries(files.map((file) => [file, createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex")]));
}

// 부모가 node --test 자식이면 NODE_TEST_CONTEXT가 상속돼 중첩 실행이 실제 테스트를 돌리지 않는다.
const { NODE_TEST_CONTEXT: _context, ...childEnv } = process.env;
const runTest = (file) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["--test", file], { cwd: root, env: childEnv, stdio: "ignore" });
  child.on("error", reject);
  child.on("close", (code) => resolve(code));
});

test("후보 준비·갱신 테스트를 같은 shard에서 동시에 실행해도 추적 파일이 바뀌지 않고 둘 다 통과한다", async () => {
  const before = trackedFileShas();
  const codes = await Promise.all(GUARDED_TESTS.map(runTest));
  const after = trackedFileShas();
  const changed = Object.keys(before).filter((file) => before[file] !== after[file]);
  assert.deepEqual(changed, [], `테스트가 추적 파일을 덮어썼다: ${changed.join(", ")}`);
  assert.deepEqual(codes, [0, 0]);
});
