import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { cloneArtifactOutput } from "./datapack-tools-production-build.mjs";

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
