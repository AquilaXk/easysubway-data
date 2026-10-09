import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DAEGU_LINES } from "./collect-daegu-datapack-sources.mjs";
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
  // --download 수집기처럼 snapshot 여섯 개만 쓰고 원본은 rawSources(base64)에 두며 데이터셋마다 downloadProvenance를 싣는다. 원본 CSV 9개는 노선당 topology 1개·시간표 2개에 나뉜다(#1080).
  async "collect-daegu-datapack-sources.mjs"(args) {
    const directory = args[args.indexOf("--output-dir") + 1];
    const raw = (datasetId) => { const bytes = Buffer.from(`csv-${datasetId}`); return { datasetId, rawSha256: createHash("sha256").update(bytes).digest("hex"), bytesBase64: bytes.toString("base64") }; };
    const provenance = (rawSources) => rawSources.map(({ datasetId, rawSha256 }) => ({ datasetId, rawSha256 }));
    const write = (sourceId, rawSources) => writeFile(path.join(directory, `${sourceId}-fake.json`), `${JSON.stringify({
      sourceId, capturedAt: "2026-10-07T01:02:03.456Z", rawSources, downloadProvenance: provenance(rawSources), rawSha256: `raw-${sourceId}`, contentSha256: `content-${sourceId}`,
    })}\n`);
    for (const { lineNumber, intervalDatasetId, upDatasetId, downDatasetId } of DAEGU_LINES) {
      await write(`daegu-line${lineNumber}-route-topology`, [raw(intervalDatasetId)]);
      await write(`daegu-line${lineNumber}-train-timetable`, [raw(upDatasetId), raw(downDatasetId)]);
    }
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

// 대구 verify 단계가 읽는 "등록 출력"을 수집 snapshot에서 만든다: 원장 head 행과 그 snapshot 파일(등록기는 downloadProvenance 없이 같은 원천·시각·원본·내용으로 다시 만든다, 수집→등록 일치는 daegu-chain 테스트가 실제 등록기로 고정한다).
const LEDGER = "tools/datapack/release/source-snapshots.json";
function daeguRegistrationOverlay(operationDir, { mutate = (snapshot) => snapshot } = {}) {
  const read = async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"));
  const collected = async () => Promise.all((await readdir(path.join(operationDir, "collected"))).map(async (name) => JSON.parse(await readFile(path.join(operationDir, "collected", name), "utf8"))));
  return async (relative) => {
    if (relative === LEDGER) {
      const ledger = await read(relative);
      const rows = (await collected()).map(({ sourceId }) => ({ sourceId, snapshotId: `${sourceId}-registered`, previousSnapshotId: ledgerHeadId(ledger, sourceId) }));
      return [...ledger, ...rows];
    }
    const match = /^tools\/datapack\/sources\/(.+)-registered\.json$/u.exec(relative);
    if (match) {
      const { downloadProvenance, ...snapshot } = (await collected()).find(({ sourceId }) => sourceId === match[1]);
      return mutate(snapshot);
    }
    return read(relative);
  };
}
const ledgerHeadId = (ledger, sourceId) => {
  const rows = ledger.filter((row) => row.sourceId === sourceId);
  const referenced = new Set(rows.map((row) => row.previousSnapshotId));
  return rows.find((row) => !referenced.has(row.snapshotId)).snapshotId;
};

async function record(recipeId, { shared = new Map(), env = { DATA_GO_KR_SERVICE_KEY: "service-key-value" }, mutateRegistered } = {}) {
  const operationDir = path.join(temporary, `${recipeId}-${Math.random().toString(16).slice(2)}`);
  await mkdir(operationDir, { recursive: true });
  const calls = [];
  const ctx = {
    recipeId, repositoryRoot: root, operationDir, env, shared, lib: fakeLib, now: () => NOW,
    execute: async (script, args, { env: extra = {} } = {}) => { calls.push({ script, args, env: extra }); await FAKE_EFFECTS[script]?.(args); return { stdout: "" }; },
    head: async () => HEAD, originMain: async () => MAIN,
    readJson: recipeId === "daegu-sources"
      ? daeguRegistrationOverlay(operationDir, { mutate: mutateRegistered })
      : async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8")),
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
  assert.deepEqual(calls[1].args, ["publish-register", "--input-dir", file("raw"), "--captured-at", NOW.toISOString(), "--receipts", file("receipts.json"), "--expected-head", HEAD]);
  const receipts = JSON.parse(await readFile(file("receipts.json"), "utf8"));
  assert.deepEqual(Object.keys(receipts).sort(), [1, 2, 3].flatMap((line) => [`daegu-line${line}-route-topology`, `daegu-line${line}-train-timetable`]).sort());
  for (const [sourceId, receiptPath] of Object.entries(receipts)) assert.equal(receiptPath, file(`receipts/${sourceId}.json`));
  assert.deepEqual(await readdir(file("receipts")), []);
  // 등록기가 읽는 원본 CSV 9개가 snapshot에 보관된 바이트 그대로 --input-dir에 있다.
  const datasetIds = DAEGU_LINES.flatMap(({ intervalDatasetId, upDatasetId, downDatasetId }) => [intervalDatasetId, upDatasetId, downDatasetId]);
  assert.deepEqual((await readdir(file("raw"))).sort(), datasetIds.map((id) => `data-go-${id}.csv`).sort());
  for (const id of datasetIds) assert.equal(await readFile(file(`raw/data-go-${id}.csv`), "utf8"), `csv-${id}`);
});

// 보관된 원본이 어긋난 snapshot은 등록으로 넘기지 않는다(#1080). 수집기 산출물을 바꿔 raw 복원 단계가 거부하는지 본다.
async function daeguWithTamperedSnapshot(mutate) {
  const original = FAKE_EFFECTS["collect-daegu-datapack-sources.mjs"];
  FAKE_EFFECTS["collect-daegu-datapack-sources.mjs"] = async (args) => {
    await original(args);
    const directory = args[args.indexOf("--output-dir") + 1];
    const file = path.join(directory, "daegu-line1-train-timetable-fake.json");
    await writeFile(file, `${JSON.stringify(mutate(JSON.parse(await readFile(file, "utf8"))))}\n`);
  };
  try {
    return await record("daegu-sources");
  } finally {
    FAKE_EFFECTS["collect-daegu-datapack-sources.mjs"] = original;
  }
}

test("대구 snapshot의 보관 원본이 rawSha256과 다르면 등록하지 않고 실패한다", async () => {
  await assert.rejects(daeguWithTamperedSnapshot((snapshot) => { snapshot.rawSources[0].bytesBase64 = Buffer.from("tampered").toString("base64"); return snapshot; }), /do not match their rawSha256/u);
});

test("대구 snapshot의 downloadProvenance sha가 보관 원본과 다르면 등록하지 않고 실패한다", async () => {
  await assert.rejects(daeguWithTamperedSnapshot((snapshot) => {
    snapshot.downloadProvenance = snapshot.rawSources.map(({ datasetId }) => ({ datasetId, rawSha256: "0".repeat(64) }));
    return snapshot;
  }), /download provenance of dataset \d+ does not match/u);
});

// F1(#1081): --download 수집기는 항상 데이터셋마다 provenance를 쓴다. 없으면 다운로드 증거 없는 snapshot이라 비교를 건너뛰지 않고 실패한다.
test("대구 snapshot에서 downloadProvenance를 지우거나 비우거나 한 데이터셋만 빼면 등록하지 않고 실패한다", async () => {
  await assert.rejects(daeguWithTamperedSnapshot((snapshot) => { delete snapshot.downloadProvenance; return snapshot; }), /lacks the download provenance of dataset \d+/u);
  await assert.rejects(daeguWithTamperedSnapshot((snapshot) => { snapshot.downloadProvenance = []; return snapshot; }), /lacks the download provenance of dataset \d+/u);
  await assert.rejects(daeguWithTamperedSnapshot((snapshot) => { snapshot.downloadProvenance.pop(); return snapshot; }), /lacks the download provenance of dataset \d+/u);
  await assert.rejects(daeguWithTamperedSnapshot((snapshot) => { snapshot.downloadProvenance = "not-an-array"; return snapshot; }), /lacks the download provenance of dataset \d+/u);
});

// F4(#1081): 빈 rawSources 가드는 뒤의 누락 검사에 가려지지 않도록 고유 메시지를 단언한다.
test("대구 snapshot의 rawSources가 비었거나 배열이 아니면 고유 메시지로 실패한다", async () => {
  await assert.rejects(daeguWithTamperedSnapshot((snapshot) => { snapshot.rawSources = []; return snapshot; }), /retains no raw source: daegu-line1-train-timetable-fake\.json/u);
  await assert.rejects(daeguWithTamperedSnapshot((snapshot) => { snapshot.rawSources = null; return snapshot; }), /retains no raw source/u);
});

test("대구 snapshot이 아홉 데이터셋을 정확히 한 번씩 보관하지 않으면 등록하지 않고 실패한다", async () => {
  await assert.rejects(daeguWithTamperedSnapshot((snapshot) => { snapshot.rawSources.pop(); snapshot.downloadProvenance.pop(); return snapshot; }), /do not retain datasets/u);
  await assert.rejects(daeguWithTamperedSnapshot((snapshot) => { snapshot.rawSources.push(snapshot.rawSources[0]); return snapshot; }), /unexpected or repeated dataset/u);
});

// F2(#1081): 등록 출력(원장 head의 snapshot)이 수집 입력과 시각·원본·내용이 다르면 커밋 전에 멈춘다.
test("대구 등록 출력의 capturedAt·rawSha256·contentSha256이 수집 snapshot과 다르면 verify 단계가 실패한다", async () => {
  await record("daegu-sources"); // 일치하면 통과
  for (const key of ["capturedAt", "rawSha256", "contentSha256"]) {
    await assert.rejects(record("daegu-sources", { mutateRegistered: (snapshot) => ({ ...snapshot, [key]: "changed" }) }), new RegExp(`differs from the collected one in ${key}`, "u"));
  }
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
