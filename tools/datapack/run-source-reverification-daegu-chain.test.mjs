import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DAEGU_LINES, runDaeguSourceCollector } from "./collect-daegu-datapack-sources.mjs";
import { createDataGoPortalFetch } from "./lib/data-go-test-portal.mjs";
import { prepareDaeguSourceRegistration } from "./register-daegu-datapack-sources.mjs";
import { RECIPE_STEPS } from "./run-source-reverification.mjs";

// #1080: 대구 recipe의 수집 → 등록 명령 체인을 끝까지 잇는다.
// 단계 실행기가 가짜일 때는 수집기가 쓰는 파일과 등록기가 읽는 파일이 달라도 드러나지 않았다(run 37949676337: ENOENT data-go-15061836.csv).
// 여기서는 수집기를 실제 코드로(포털 응답만 고정 원본으로 재생) 돌리고, 등록기는 같은 명령이 넘기는 --input-dir·--captured-at로 실제 준비 단계를 돌린다.
// OCI 게시와 저장소 쓰기는 하지 않는다(prepareDaeguSourceRegistration은 읽기 전용이다).
const root = path.resolve(import.meta.dirname, "../..");
const NOW = new Date("2026-10-09T15:00:00.000Z");
const HEAD = "a".repeat(40);
const DATASET_IDS = DAEGU_LINES.flatMap(({ intervalDatasetId, upDatasetId, downDatasetId }) => [intervalDatasetId, upDatasetId, downDatasetId]);
const SEQ128_PREFIXES = [1, 2, 3].flatMap((line) => [`daegu-line${line}-route-topology-`, `daegu-line${line}-train-timetable-`]);

// 취득 시 고정한 원본 CSV 9개를 보관 snapshot의 rawSources에서 꺼낸다(collect-daegu-datapack-sources.test.mjs와 같은 방식).
async function retainedRawFiles() {
  const directory = path.join(root, "tools/datapack/sources");
  const names = await readdir(directory);
  const files = {};
  for (const prefix of SEQ128_PREFIXES) {
    const matches = names.filter((name) => name.startsWith(prefix) && name.endsWith(".json")).sort();
    const snapshot = JSON.parse(await readFile(path.join(directory, matches.at(-1)), "utf8"));
    for (const raw of snapshot.rawSources) files[raw.datasetId] = Buffer.from(raw.bytesBase64, "base64");
  }
  return files;
}

async function runChain(temporary) {
  const files = await retainedRawFiles();
  assert.deepEqual(Object.keys(files).sort(), [...DATASET_IDS].sort());
  const operationDir = path.join(temporary, "daegu-sources");
  await mkdir(operationDir, { recursive: true });
  const calls = [];
  const prepared = [];
  const ctx = {
    recipeId: "daegu-sources", repositoryRoot: root, operationDir, env: {}, shared: new Map(), lib: {}, now: () => NOW,
    head: async () => HEAD, originMain: async () => "b".repeat(40),
    readJson: async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8")),
    file: (name) => path.join(operationDir, name),
    execute: async (script, args) => {
      calls.push({ script, args });
      if (script === "collect-daegu-datapack-sources.mjs") {
        await runDaeguSourceCollector(args, { fetchImpl: createDataGoPortalFetch(files), now: () => NOW });
        return { stdout: "" };
      }
      assert.equal(script, "register-daegu-datapack-sources.mjs");
      // 등록기 CLI의 인자 형태: publish-register --input-dir <abs> --captured-at <iso> --receipts <abs> --expected-head <sha>
      assert.equal(args[0], "publish-register");
      const flag = (name) => args[args.indexOf(name) + 1];
      prepared.push(await prepareDaeguSourceRegistration({
        repositoryRoot: root, inputDirectory: flag("--input-dir"), capturedAt: flag("--captured-at"), now: NOW,
      }));
      return { stdout: "" };
    },
  };
  for (const recipeStep of RECIPE_STEPS["daegu-sources"]) await recipeStep.run(ctx);
  return { files, calls, prepared, operationDir };
}

test("대구 recipe: --download 수집 산출물이 등록기 입력(--input-dir의 원본 CSV 9개)을 만족해 6개 원천 등록 준비까지 통과한다", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "daegu-chain-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const { files, calls, prepared, operationDir } = await runChain(temporary);
  assert.deepEqual(calls.map(({ script }) => script), ["collect-daegu-datapack-sources.mjs", "register-daegu-datapack-sources.mjs"]);
  assert.equal(prepared.length, 1);
  const [{ snapshots, rawByDataset }] = prepared;
  assert.equal(snapshots.length, 6);
  // 등록기가 읽은 원본은 포털에서 받은 바이트와 정확히 같다.
  for (const datasetId of DATASET_IDS) assert.ok(Buffer.from(rawByDataset.get(datasetId)).equals(files[datasetId]), datasetId);
  // 등록기가 다시 만든 snapshot은 수집기가 쓴 snapshot과 같은 원천·시각·내용을 가리킨다.
  const collectedDir = path.join(operationDir, "collected");
  const collectedNames = (await readdir(collectedDir)).filter((name) => name.endsWith(".json"));
  assert.equal(collectedNames.length, 6);
  for (const snapshot of snapshots) {
    const name = collectedNames.find((candidate) => candidate.startsWith(`${snapshot.sourceId}-`));
    const collected = JSON.parse(await readFile(path.join(collectedDir, name), "utf8"));
    assert.equal(snapshot.capturedAt, collected.capturedAt, snapshot.sourceId);
    assert.equal(snapshot.contentSha256, collected.contentSha256, snapshot.sourceId);
    assert.equal(snapshot.rawSha256, collected.rawSha256, snapshot.sourceId);
  }
});
