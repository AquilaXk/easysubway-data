import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { cloneArtifactOutput } from "./datapack-tools-production-build.mjs";

const execFileAsync = promisify(execFile);
const fixtureUrl = new URL("./datapack-tools-production-build.mjs", import.meta.url).href;

// #1278: validate-datapack 테스트는 변조하지 않은 production 팩 하나를 공유하고 테스트마다 복사본만 변조한다.
// 복사본 변조가 원본과 다른 복사본으로 새지 않아야 테스트 사이에 결합이 생기지 않는다.
const pristineFiles = {
  "current.json": '{"packs":[]}\n',
  "current.provenance.json": '{"packs":[]}\n',
  "catalog/nationwide-v1.sqlite": "sqlite-bytes",
  "catalog/nationwide-v1.sqlite.gz": "gzip-bytes",
};

async function createPristineArtifact(context) {
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-clone-isolation-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "pack");
  await mkdir(path.join(output, "catalog"), { recursive: true });
  for (const [name, content] of Object.entries(pristineFiles)) await writeFile(path.join(output, name), content);
  return { output, routeCoverageAuthority: path.join(directory, "authority.json") };
}

async function readTree(output) {
  return Object.fromEntries(await Promise.all(
    Object.keys(pristineFiles).map(async (name) => [name, await readFile(path.join(output, name), "utf8")]),
  ));
}

test("#1278 production 팩 복사본의 변조는 원본과 다른 복사본에 영향을 주지 않는다", async (context) => {
  const pristine = await createPristineArtifact(context);
  const first = await cloneArtifactOutput(context, pristine);
  const second = await cloneArtifactOutput(context, pristine);

  assert.notEqual(first.output, pristine.output);
  assert.notEqual(first.output, second.output);
  assert.equal(first.routeCoverageAuthority, pristine.routeCoverageAuthority);
  assert.deepEqual(await readTree(first.output), pristineFiles);

  // 테스트 헬퍼가 쓰는 방식 그대로 같은 경로에 덮어쓰고(제자리 쓰기), 파일 하나는 지운다.
  await writeFile(path.join(first.output, "catalog/nationwide-v1.sqlite"), "mutated-sqlite");
  await writeFile(path.join(first.output, "current.json"), '{"packs":["mutated"]}\n');
  await rm(path.join(first.output, "current.provenance.json"));

  assert.deepEqual(await readTree(pristine.output), pristineFiles);
  assert.deepEqual(await readTree(second.output), pristineFiles);
});

// 공유 산출물은 모듈이 root에 등록하는 after 훅이 지운다. 별도 test 파일 프로세스로 실행해 훅이 도는지 확인한다.
const fileScopedProbe = `
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import test from "node:test";
const { createFileScopedDirectory } = await import(process.env.FIXTURE_URL);
test("probe", async () => {
  const directory = await createFileScopedDirectory("easysubway-file-scoped-probe-");
  await writeFile(process.env.PROBE_RESULT, directory);
  assert.ok(existsSync(directory));
  assert.equal(process.env.PROBE_OUTCOME, "pass");
});
`;

for (const outcome of ["pass", "fail"]) {
  test(`#1278 파일 단위 공유 산출물은 test가 ${outcome === "pass" ? "통과" : "실패"}해도 파일 종료 때 지워진다`, async (context) => {
    const directory = await mkdtemp(path.join(tmpdir(), "easysubway-file-scoped-probe-run-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const probePath = path.join(directory, "probe.test.mjs");
    const resultPath = path.join(directory, "created-directory.txt");
    await writeFile(probePath, fileScopedProbe);
    const { NODE_TEST_CONTEXT: _parentRunner, ...env } = process.env;
    const run = execFileAsync(process.execPath, [probePath], {
      env: { ...env, FIXTURE_URL: fixtureUrl, PROBE_RESULT: resultPath, PROBE_OUTCOME: outcome === "pass" ? "pass" : "forced-failure" },
    });
    if (outcome === "pass") await run;
    else await assert.rejects(run);
    const created = await readFile(resultPath, "utf8");
    assert.match(path.basename(created), /^easysubway-file-scoped-probe-/);
    assert.equal(existsSync(created), false);
  });
}
