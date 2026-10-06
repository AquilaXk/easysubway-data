import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { RECIPE_STEPS } from "./run-source-reverification.mjs";
import { prepareKorailTimetableRegistration } from "./register-korail-timetable.mjs";
import { prepareKorailTopologyRegistration } from "./register-korail-route-topology.mjs";
import { publishAndRegisterGwangjuTopology } from "./register-gwangju-route-topology.mjs";

// #984: recipe 단계가 부르는 명령은 각 도구의 실제 계약으로 검증한다. 수집·OCI 게시는 실행하지 않는다.
// 1) 단계를 가짜 실행기로 돌려 명령(스크립트·인자·환경)을 기록하고 기대와 대조한다.
// 2) 기록한 명령 전부를 실제 도구에 네트워크를 막고(fetch 차단·환경 비움) 넘겨, 인자 오류(usage)로 거부되지 않는지 확인한다.
// 3) 입력 JSON(코레일·광주·대구)은 등록기의 실제 입력 검증을 통과해 파일 읽기에서야 멈추는지 확인한다.
const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const NOW = new Date("2026-10-07T01:02:03.456Z");
const HEAD = "a".repeat(40);
const MAIN = "b".repeat(40);
const PAR = "https://objectstorage.ap-chuncheon-1.oraclecloud.com/p/FAKE-TOKEN/n/axvym6vk8g7i/b/easysubway-datapacks/o/";
const NETWORK_BLOCK = "data:text/javascript,globalThis.fetch=async()=>{throw new Error('NETWORK_BLOCKED')}";
const USAGE_ERROR = /usage:|_CLI\b|_ARGUMENTS?\b|arguments mismatch/iu;
// 등록기의 입력 검증은 파일을 읽기 전에 끝난다. 이 코드들로 거부되면 입력 JSON이 계약을 어긴 것이다.
const INPUT_REJECTION = /_SOURCE_INPUT|_TOPOLOGY_INPUT|_LINE_COVERAGE|_PROVIDER_VALIDITY|_SUCCESSOR_STATE|_CANDIDATE\b|_ROOT\b/u;

let temporary;
test.before(async () => { temporary = await mkdtemp(path.join(os.tmpdir(), "reverification-steps-")); });
test.after(async () => { await rm(temporary, { recursive: true, force: true }); });

const FAKE_EFFECTS = {
  async "collect-daegu-datapack-sources.mjs"(args) {
    const directory = args[args.indexOf("--output-dir") + 1];
    for (const name of ["a", "b", "c", "d", "e", "f"]) await writeFile(path.join(directory, `${name}.json`), `${JSON.stringify({ capturedAt: "2026-10-07T01:02:03.456Z" })}\n`);
  },
};

const fakeLib = {
  collectKricCurrentStationLineFile: async ({ outputFile }) => {
    await writeFile(outputFile, "xlsx");
    return { schemaVersion: 1, artifactKind: "kric-current-station-line-file-receipt", sourceId: "kric-current-station-line-file", capturedAt: NOW.toISOString(), rawFile: path.basename(outputFile), byteLength: 4, sha256: "c".repeat(64), credentialRedacted: true };
  },
  buildKricCurrentStationLineObservation: async () => ({ artifactKind: "kric-current-station-line-observation" }),
  collectKasiHolidayCalendarWindowFiles: async ({ outputDirectory }) => { await mkdir(outputDirectory); },
};

async function record(recipeId, { shared = new Map(), env = { DATA_GO_KR_SERVICE_KEY: "service-key-value" } } = {}) {
  const operationDir = path.join(temporary, `${recipeId}-${Math.random().toString(16).slice(2)}`);
  await mkdir(operationDir, { recursive: true });
  const calls = [];
  const ctx = {
    recipeId, repositoryRoot: root, operationDir, env, shared, lib: fakeLib, now: () => NOW,
    execute: async (script, args, { env: extra = {} } = {}) => { calls.push({ script, args, env: extra }); await FAKE_EFFECTS[script]?.(args); return { stdout: "" }; },
    head: async () => HEAD, originMain: async () => MAIN,
    readJson: async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8")),
    file: (name) => path.join(operationDir, name),
  };
  for (const recipeStep of RECIPE_STEPS[recipeId]) await recipeStep.run(ctx);
  return { calls, ctx, operationDir };
}

const INVENTORY = "tools/datapack/source-inventory.json";
const abs = (relative) => path.join(root, relative);

test("KRIC 수도권·코레일 projection은 한 도구가 수집과 등록을 하고 빈 작업 디렉터리를 받는다", async () => {
  const { calls, operationDir } = await record("kric-capital-timetable");
  assert.deepEqual(calls, [{ script: "register-kric-capital-timetable.mjs", args: ["--operation-directory", path.join(operationDir, "operation")], env: {} }]);
  assert.deepEqual(await readdir(path.join(operationDir, "operation")), []);
});

test("광주 topology: 수집 → 등록 입력(JSON) → 게시·등록, 등록 입력은 이 실행의 HEAD에 결속된다", async () => {
  const { calls, operationDir } = await record("gwangju-topology");
  const file = (name) => path.join(operationDir, name);
  assert.deepEqual(calls, [
    { script: "collect-gwangju-route-topology.mjs", args: ["--inventory", INVENTORY, "--output", file("topology.json")], env: {} },
    { script: "register-gwangju-route-topology.mjs", args: ["publish-register", "--input", file("register-input.json")], env: {} },
  ]);
  assert.deepEqual(JSON.parse(await readFile(file("register-input.json"), "utf8")), { repositoryRoot: root, snapshotPath: file("topology.json"), receiptPath: file("raw-receipt.json"), expectedHeadSha: HEAD });
});

test("부산 topology는 원문 범위 HTML로 수집하고 역 지도 CSV로 등록한다", async () => {
  const { calls, operationDir } = await record("busan-topology");
  const file = (name) => path.join(operationDir, name);
  assert.deepEqual(calls, [
    { script: "collect-busan-route-topology.mjs", args: ["--output", file("topology.json"), "--scope-html", abs("tools/datapack/sources/humetro-cyberstation-map-20260623.html")], env: {} },
    { script: "register-busan-route-topology.mjs", args: ["publish-register", "--snapshot", file("topology.json"), "--station-map", abs("tools/datapack/sources/regional-official-svg-route-map-coordinates-20260624.csv"), "--receipt", file("raw-receipt.json"), "--expected-head", HEAD], env: {} },
  ]);
});

test("대전 topology는 출력 경로를 환경 변수로 받는 수집기를 쓴다", async () => {
  const { calls, operationDir } = await record("daejeon-topology");
  const file = (name) => path.join(operationDir, name);
  assert.deepEqual(calls, [
    { script: "collect-daejeon-route-topology.mjs", args: [], env: { DAEJEON_TOPOLOGY_OUTPUT: file("topology.json") } },
    { script: "register-daejeon-route-topology.mjs", args: ["publish-register", "--snapshot", file("topology.json"), "--receipt", file("raw-receipt.json"), "--expected-head", HEAD], env: {} },
  ]);
});

test("광주·대전 접근성은 data.go.kr --download 모드로 받고 새 topology head에 결속해 등록한다", async () => {
  const gwangju = await record("gwangju-accessibility");
  const g = (name) => path.join(gwangju.operationDir, name);
  assert.deepEqual(gwangju.calls, [
    { script: "collect-gwangju-accessibility.mjs", args: ["--download", "--inventory", abs(INVENTORY), "--output", g("accessibility.json")], env: {} },
    { script: "register-regional-accessibility.mjs", args: ["publish-register", "--snapshot", g("accessibility.json"), "--receipt", g("raw-receipt.json"), "--expected-head", HEAD], env: {} },
  ]);
  const daejeon = await record("daejeon-accessibility");
  const d = (name) => path.join(daejeon.operationDir, name);
  const topology = (await daejeon.ctx.readJson(INVENTORY)).sources.find(({ id }) => id === "daejeon-station-distance-fare").topologyAdmissionEvidence.snapshotPath;
  assert.deepEqual(daejeon.calls, [
    { script: "collect-daejeon-accessibility.mjs", args: ["--download", "--topology-snapshot", abs(topology), "--inventory", abs(INVENTORY), "--molit-csv", abs("tools/datapack/sources/molit-urban-rail-full-route-20251211.csv"), "--output", d("accessibility.json")], env: {} },
    { script: "register-regional-accessibility.mjs", args: ["publish-register", "--snapshot", d("accessibility.json"), "--receipt", d("raw-receipt.json"), "--expected-head", HEAD], env: {} },
  ]);
});

test("대구 여섯 원천은 --download로 한 번에 받고 snapshot의 capturedAt과 원천별 영수증 경로로 한 번에 등록한다", async () => {
  const { calls, operationDir } = await record("daegu-sources");
  const file = (name) => path.join(operationDir, name);
  assert.deepEqual(calls.map(({ script }) => script), ["collect-daegu-datapack-sources.mjs", "register-daegu-datapack-sources.mjs"]);
  assert.deepEqual(calls[0].args, ["--download", "--output-dir", file("collected")]);
  assert.deepEqual(calls[1].args, ["publish-register", "--input-dir", file("collected"), "--captured-at", NOW.toISOString(), "--receipts", file("receipts.json"), "--expected-head", HEAD]);
  const receipts = JSON.parse(await readFile(file("receipts.json"), "utf8"));
  assert.deepEqual(Object.keys(receipts).sort(), [1, 2, 3].flatMap((line) => [`daegu-line${line}-route-topology`, `daegu-line${line}-train-timetable`]).sort());
  for (const [sourceId, receiptPath] of Object.entries(receipts)) assert.equal(receiptPath, file(`receipts/${sourceId}.json`));
  assert.deepEqual(await readdir(file("receipts")), []);
});

test("대구 snapshot의 capturedAt이 서로 다르거나 정규형이 아니면 등록하지 않고 실패한다", async () => {
  const dir = await mkdtemp(path.join(temporary, "daegu-"));
  const original = FAKE_EFFECTS["collect-daegu-datapack-sources.mjs"];
  FAKE_EFFECTS["collect-daegu-datapack-sources.mjs"] = async (args) => {
    const directory = args[args.indexOf("--output-dir") + 1];
    await writeFile(path.join(directory, "a.json"), JSON.stringify({ capturedAt: "2026-10-07T01:02:03.456Z" }));
    await writeFile(path.join(directory, "b.json"), JSON.stringify({ capturedAt: "2026-10-07T01:02:04.000Z" }));
  };
  try {
    await assert.rejects(record("daegu-sources"), /do not share one canonical capturedAt/u);
  } finally {
    FAKE_EFFECTS["collect-daegu-datapack-sources.mjs"] = original;
    await rm(dir, { recursive: true, force: true });
  }
});

// 코레일: 이전 등록 증거(inventory·원장 head·snapshot)에서 수집 대상과 입력을 다시 만든다.
test("코레일 topology: 이전 증거의 URL·고정 sha로 수집하고 membership·catalog·거버넌스를 묶은 입력으로 게시·등록한다", async () => {
  const shared = new Map();
  const { calls, operationDir } = await record("korail-topology", { shared });
  const file = (name) => path.join(operationDir, name);
  const inventory = JSON.parse(await readFile(abs(INVENTORY), "utf8"));
  const evidence = inventory.sources.find(({ id }) => id === "korail-metropolitan-timetable-file").topologyAdmissionEvidence;
  assert.deepEqual(calls.map(({ script }) => script), ["collect-korail-metropolitan-timetable-file.mjs", "register-korail-route-topology.mjs"]);
  assert.deepEqual(calls[0].args.slice(0, 1).concat(calls[0].args.slice(2, 3), calls[0].args.slice(4, 5)), ["--url", "--sha256", "--output-directory"]);
  assert.match(calls[0].args[1], /^https:\/\/www\.korail\.com\/file\/cubedata\/COMMON\/jfile\/.+\.xlsx$/u);
  assert.equal(calls[0].args[3], evidence.rawSha256);
  assert.equal(calls[0].args[5], file("collection"));
  assert.deepEqual(calls[1].args, ["publish-register", "--source-input", file("source-input.json"), "--operation-directory", file("publication"), "--expected-main-sha", MAIN, "--expected-head-sha", HEAD]);
  const input = JSON.parse(await readFile(file("source-input.json"), "utf8"));
  assert.equal(input.artifactKind, "korail-topology-registration-input");
  assert.equal(input.collectionDirectory, file("collection"));
  assert.equal(input.stationLineObservationPath, file("membership-observation.json"));
  assert.equal(input.canonicalCatalogPath, abs("tools/datapack/release/capital-production-canonical-pack.json"));
  assert.match(input.canonicalCatalogSha256, /^[a-f0-9]{64}$/u);
  assert.equal(input.governanceEntry.sourceId, "korail-metropolitan-timetable-file");
  assert.equal(shared.get("korail").publicationDirectory, file("publication"));
  // 등록기의 실제 입력 검증을 통과해 첫 파일 읽기(수집 디렉터리 영수증, 이 테스트에는 없다)에서야 멈춘다.
  await assert.rejects(prepareKorailTopologyRegistration({ repositoryRoot: root, sourceInputPath: file("source-input.json"), now: NOW }), (error) => error.code === "ENOENT");
});

test("코레일 계획 시각표는 topology recipe가 남긴 산출물과 오늘부터 30일 달력 창으로 입력을 만든다", async () => {
  const shared = new Map();
  const topology = await record("korail-topology", { shared });
  const planned = await record("korail-planned-timetable", { shared });
  const file = (name) => path.join(planned.operationDir, name);
  assert.deepEqual(planned.calls, [{ script: "register-korail-timetable.mjs", args: ["--repository-root", root, "--source-input", file("source-input.json"), "--expected-main-sha", MAIN, "--expected-head-sha", HEAD], env: {} }]);
  const input = JSON.parse(await readFile(file("source-input.json"), "utf8"));
  assert.equal(input.artifactKind, "korail-timetable-registration-input");
  assert.deepEqual(input.calendarWindow, { startDate: "20261007", endDate: "20261106" });
  assert.equal(input.calendarDirectory, file("calendar"));
  assert.equal(input.retainedWorkbookPath, path.join(topology.operationDir, "collection", "timetable.xlsx"));
  assert.equal(input.publicationReceiptPath, path.join(topology.operationDir, "publication", "receipt.json"));
  assert.equal(input.governanceEntry.sourceId, "korail-metropolitan-planned-timetable");
  await assert.rejects(prepareKorailTimetableRegistration({ repositoryRoot: root, sourceInputPath: file("source-input.json"), now: NOW }), (error) => !INPUT_REJECTION.test(String(error.message)));
});

test("코레일 계획 시각표는 topology recipe 없이 단독으로 돌 수 없다", async () => {
  await assert.rejects(record("korail-planned-timetable"), /did not leave its registration outputs/u);
});

// 인자 계약: 기록한 모든 명령을 실제 도구에 넘긴다. 네트워크는 막고(fetch 차단) 환경은 비운다. 인자 오류로 거부되면 실패다.
test("recipe가 만든 모든 명령은 실제 도구의 인자 파서가 받아들인다(수집·게시는 실행하지 않는다)", async () => {
  const shared = new Map();
  const recipes = ["kric-capital-timetable", "korail-topology", "korail-planned-timetable", "gwangju-topology", "gwangju-accessibility", "busan-topology", "daejeon-topology", "daejeon-accessibility", "daegu-sources"];
  const all = [];
  for (const recipeId of recipes) all.push(...(await record(recipeId, { shared })).calls.map((call) => ({ recipeId, ...call })));
  assert.equal(all.length, 16);
  for (const { recipeId, script, args, env } of all) {
    const result = spawnSync(process.execPath, ["--import", NETWORK_BLOCK, path.join(root, "tools/datapack", script), ...args], {
      cwd: root, env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 60_000,
    });
    assert.notEqual(result.status, null, `${recipeId} ${script}: timed out`);
    assert.doesNotMatch(`${result.stderr}${result.stdout}`, USAGE_ERROR, `${recipeId} ${script} ${args[0]}: rejected by its argument parser: ${result.stderr.slice(0, 300)}`);
  }
});

test("광주 등록 입력 JSON은 등록기의 실제 옵션 검증을 통과해 snapshot 읽기에서야 멈춘다", async () => {
  const { operationDir } = await record("gwangju-topology");
  const input = JSON.parse(await readFile(path.join(operationDir, "register-input.json"), "utf8"));
  const { repositoryRoot, ...rest } = input;
  await assert.rejects(publishAndRegisterGwangjuTopology({
    ...rest, repositoryRoot, expectedHeadSha: HEAD, gitRunner: async () => `${HEAD}\n`, env: { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: PAR },
  }), (error) => error.code === "ENOENT");
});
