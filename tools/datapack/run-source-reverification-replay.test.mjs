import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { RECIPE_STEPS, REPLAY_MANIFEST_FILE, dependencyGroups, replaySourceReverification, runSourceReverification } from "./run-source-reverification.mjs";
import { REVERIFICATION_RECIPES } from "./source-reverification-recipes.mjs";

const LEDGER = "tools/datapack/release/source-snapshots.json";
const INVENTORY = "tools/datapack/source-inventory.json";
const POLICY = { schemaVersion: 1, issue: 969, allowContentChange: true, maxRowDeltaRatio: 0.05, allowCoverageDecrease: false, sourceOverrides: {} };
const SHA = (char) => char.repeat(64);
const BUSAN = ["busan-topology", "busan-accessibility", "busan-timetable"];
const BUSAN_SOURCES = ["busan-transportation-route-topology", "busan-transportation-accessibility", "busan-transportation-timetable"];
const BASE_CAPTURED = "2026-10-06T00:00:00.000Z";
const COLLECTED = "2026-10-07T00:00:00.000Z";
const COLLECTOR_SOURCE = {
  "collect-busan-route-topology.mjs": "busan-transportation-route-topology",
  "collect-busan-accessibility.mjs": "busan-transportation-accessibility",
  "collect-busan-timetable.mjs": "busan-transportation-timetable",
};

function git(cwd, ...args) {
  const result = spawnSync("/usr/bin/git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const ledgerRow = (sourceId, snapshotId, capturedAt, previousSnapshotId = null) => ({
  sourceId, snapshotId, previousSnapshotId, capturedAt, rawSha256: SHA("a"), contentSha256: SHA("b"), rowCount: 100, coverageCount: 8,
});

async function fixtureRepository(t, { capturedAt = BASE_CAPTURED } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "reverification-replay-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "test");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "gc.auto", "0");
  git(root, "config", "maintenance.auto", "false");
  const sourceIds = [...BUSAN_SOURCES, "first-source", "second-source"];
  const files = {
    [INVENTORY]: `${JSON.stringify({ sources: [{ id: "busan-transportation-route-topology", topologyAdmissionEvidence: { snapshotPath: "tools/datapack/sources/busan-base.json" } }] }, null, 2)}\n`,
    [LEDGER]: `${JSON.stringify(sourceIds.map((sourceId) => ledgerRow(sourceId, `${sourceId}-base`, capturedAt)), null, 2)}\n`,
    "tools/datapack/source-governance-policy.json": "{}\n",
    "tools/datapack/sources/busan-base.json": "{}\n",
  };
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
  git(root, "add", ...Object.keys(files));
  git(root, "commit", "-q", "-m", "base");
  return root;
}

async function scratch(t, label) {
  const directory = await mkdtemp(path.join(os.tmpdir(), `reverification-${label}-`));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const readLedger = async (root) => JSON.parse(await readFile(path.join(root, LEDGER), "utf8"));
const headOf = (ledger, sourceId) => {
  const rows = ledger.filter((row) => row.sourceId === sourceId);
  const referenced = new Set(rows.map((row) => row.previousSnapshotId));
  return rows.find((row) => !referenced.has(row.snapshotId));
};
const argAfter = (args, flag) => args[args.indexOf(flag) + 1];

async function fakeRegister(root, args, { snapshotSuffix = "" } = {}) {
  const snapshot = JSON.parse(await readFile(argAfter(args, "--snapshot"), "utf8"));
  if (args[0] === "publish-register") await writeFile(argAfter(args, "--receipt"), `${JSON.stringify({ snapshotId: snapshot.snapshotId })}\n`, { flag: "wx" });
  else assert.deepEqual(JSON.parse(await readFile(argAfter(args, "--receipt"), "utf8")), { snapshotId: snapshot.snapshotId }, "재생은 원래 게시 영수증을 그대로 읽는다");
  const ledger = await readLedger(root);
  const snapshotId = `${snapshot.snapshotId}${snapshotSuffix}`;
  ledger.push(ledgerRow(snapshot.sourceId, snapshotId, snapshot.capturedAt, headOf(ledger, snapshot.sourceId).snapshotId));
  await writeFile(path.join(root, LEDGER), `${JSON.stringify(ledger, null, 2)}\n`);
  await writeFile(path.join(root, `tools/datapack/sources/${snapshotId}.json`), `${JSON.stringify(snapshot)}\n`);
}

function recordingExecute(root, options = {}) {
  const calls = [];
  const execute = async (script, args) => {
    calls.push({ script, args });
    if (COLLECTOR_SOURCE[script]) {
      const sourceId = COLLECTOR_SOURCE[script];
      await writeFile(argAfter(args, "--output"), `${JSON.stringify({ sourceId, snapshotId: `${sourceId}-collected`, capturedAt: COLLECTED })}\n`, { flag: "wx" });
    } else if (script.startsWith("register-")) {
      await fakeRegister(root, args, options);
    } else {
      throw new Error(`unexpected script ${script}`);
    }
    return { stdout: "" };
  };
  return { calls, execute };
}

const common = (root, operationRoot, execute) => ({ repositoryRoot: root, operationRoot, env: {}, policy: POLICY, now: new Date("2026-10-07T01:00:00.000Z"), execute });

async function collectBusanBundle(t) {
  const original = await fixtureRepository(t);
  const work = await scratch(t, "original");
  const { calls, execute } = recordingExecute(original);
  const bundle = path.join(work, "bundle");
  const result = await runSourceReverification({ ...common(original, path.join(work, "operation"), execute), recipeIds: BUSAN, replayBundle: bundle });
  return { original, bundle, result, calls };
}

test("정상 run은 재생 가능한 묶음의 수집 출력과 게시 영수증만 재생 묶음에 담고, 등록된 원장 head(수집 시각)를 manifest에 적는다", async (t) => {
  const { bundle, result } = await collectBusanBundle(t);
  assert.deepEqual(result.steps.map(({ id }) => id), BUSAN);
  const manifest = JSON.parse(await readFile(path.join(bundle, REPLAY_MANIFEST_FILE), "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.artifactKind, "source-reverification-replay-bundle");
  assert.deepEqual(manifest.recipes.map(({ recipeId, sources }) => ({ recipeId, sources })), BUSAN.map((recipeId, index) => ({
    recipeId, sources: [{ sourceId: BUSAN_SOURCES[index], snapshotId: `${BUSAN_SOURCES[index]}-collected`, capturedAt: COLLECTED }],
  })));
  const expectedFiles = { "busan-topology": ["topology.json", "raw-receipt.json"], "busan-accessibility": ["accessibility.json", "raw-receipt.json"], "busan-timetable": ["timetable.json", "raw-receipt.json"] };
  for (const { recipeId, files } of manifest.recipes) {
    assert.deepEqual(files.map(({ name }) => name), expectedFiles[recipeId], recipeId);
    assert.deepEqual((await readdir(path.join(bundle, recipeId))).sort(), [...expectedFiles[recipeId]].sort(), `${recipeId}: 재생에 필요한 파일만 담는다`);
    for (const { name, sha256 } of files) assert.equal(createHash("sha256").update(await readFile(path.join(bundle, recipeId, name))).digest("hex"), sha256);
  }
});

test("재생은 수집기를 부르지 않고 등록기를 게시 없이(register 모드) 불러, 최신 main 위에 원래 수집 시각의 같은 snapshot을 등록한다", async (t) => {
  const { bundle } = await collectBusanBundle(t);
  const main = await fixtureRepository(t);
  const work = await scratch(t, "replay");
  const { calls, execute } = recordingExecute(main);
  const nextBundle = path.join(work, "bundle");
  const result = await replaySourceReverification({ ...common(main, path.join(work, "operation"), execute), replayFrom: bundle, replayBundle: nextBundle });
  assert.deepEqual(result.steps.map(({ id }) => id), BUSAN);
  assert.deepEqual(result.dropped, []);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(calls.map(({ script }) => script), ["register-busan-route-topology.mjs", "register-regional-accessibility.mjs", "register-busan-timetable.mjs"], "수집기는 한 번도 불리지 않는다");
  for (const { args } of calls) {
    assert.equal(args[0], "register");
    assert.ok(!args.includes("--expected-head"), "게시가 없으니 게시 시점 HEAD 결속도 없다");
  }
  const ledger = await readLedger(main);
  for (const sourceId of BUSAN_SOURCES) {
    const head = headOf(ledger, sourceId);
    assert.deepEqual({ snapshotId: head.snapshotId, capturedAt: head.capturedAt, previousSnapshotId: head.previousSnapshotId }, {
      snapshotId: `${sourceId}-collected`, capturedAt: COLLECTED, previousSnapshotId: `${sourceId}-base`,
    }, `${sourceId}: 재생 시각이 아니라 원래 수집 시각이다`);
  }
  assert.equal(git(main, "log", "--format=%s", "-4").split("\n").at(-1), "base");
  assert.equal(git(main, "status", "--porcelain"), "");
  assert.deepEqual(JSON.parse(await readFile(path.join(nextBundle, REPLAY_MANIFEST_FILE), "utf8")).recipes.map(({ sources }) => sources), JSON.parse(await readFile(path.join(bundle, REPLAY_MANIFEST_FILE), "utf8")).recipes.map(({ sources }) => sources));
});

test("main이 이미 같거나 더 새 snapshot을 가진 원천이 하나라도 있으면 그 의존 묶음을 통째로 빼고, 남는 것이 없으면 아무것도 등록하지 않는다", async (t) => {
  const { bundle } = await collectBusanBundle(t);
  for (const [label, capturedAt] of [["같은 시각", COLLECTED], ["더 새 시각", "2026-10-07T03:00:00.000Z"]]) {
    const main = await fixtureRepository(t, { capturedAt });
    const work = await scratch(t, "drop");
    const { calls, execute } = recordingExecute(main);
    const before = git(main, "rev-parse", "HEAD");
    const result = await replaySourceReverification({ ...common(main, path.join(work, "operation"), execute), replayFrom: bundle, replayBundle: path.join(work, "bundle") });
    assert.deepEqual(result.steps, [], label);
    assert.deepEqual(result.dropped, [{ recipeIds: BUSAN, reason: "UP_TO_DATE_ON_MAIN", sourceIds: BUSAN_SOURCES }], label);
    assert.deepEqual(calls, [], `${label}: 등록기도 부르지 않는다`);
    assert.equal(git(main, "rev-parse", "HEAD"), before, label);
    await assert.rejects(readdir(path.join(work, "bundle")), { code: "ENOENT" }, `${label}: 재생할 것이 없으면 묶음을 남기지 않는다`);
  }
});

test("묶음의 원천 하나만 main에 같거나 더 새 snapshot이 있어도 부산 묶음 전체를 빼고 그 원천만 sourceIds에 적는다", async (t) => {
  const { bundle } = await collectBusanBundle(t);
  const main = await fixtureRepository(t);
  const ledger = await readLedger(main);
  ledger.push(ledgerRow("busan-transportation-accessibility", "busan-accessibility-newer", "2026-10-07T03:00:00.000Z", "busan-transportation-accessibility-base"));
  await writeFile(path.join(main, LEDGER), `${JSON.stringify(ledger, null, 2)}\n`);
  git(main, "commit", "-qam", "newer accessibility only");
  const before = git(main, "rev-parse", "HEAD");
  const work = await scratch(t, "partial");
  const { calls, execute } = recordingExecute(main);
  const result = await replaySourceReverification({ ...common(main, path.join(work, "operation"), execute), replayFrom: bundle });
  assert.deepEqual(result.steps, []);
  assert.deepEqual(result.dropped, [{ recipeIds: BUSAN, reason: "UP_TO_DATE_ON_MAIN", sourceIds: ["busan-transportation-accessibility"] }]);
  assert.deepEqual(calls, [], "topology·시간표도 등록하지 않는다");
  assert.equal(git(main, "rev-parse", "HEAD"), before);
  assert.equal(headOf(await readLedger(main), "busan-transportation-route-topology").snapshotId, "busan-transportation-route-topology-base");
});

const fakeMeta = (id, dependsOn = []) => ({ id, message: `[Data] ${id} 재확인`, sourceIds: [`${id}-source`], dependsOn, due: null });
const replayable = (id) => [
  { id: "collect", kind: "collect", run: async (ctx) => { await writeFile(ctx.file("out.json"), `${JSON.stringify({ sourceId: `${id}-source`, snapshotId: `${id}-collected`, capturedAt: COLLECTED })}\n`); }, retains: ["out.json"] },
  { id: "register", kind: "register", run: async (ctx) => {
    if (!ctx.replay) await writeFile(ctx.file("raw-receipt.json"), `${JSON.stringify({ snapshotId: `${id}-collected` })}\n`);
    await fakeRegister(ctx.repositoryRoot, ["register", "--snapshot", ctx.file("out.json"), "--receipt", ctx.file("raw-receipt.json")]);
  }, retains: ["raw-receipt.json"] },
];

test("독립 묶음은 따로 판정한다: main에 더 새 행이 있는 묶음만 빼고 나머지는 재생한다", async (t) => {
  const original = await fixtureRepository(t);
  const work = await scratch(t, "groups");
  const recipes = [fakeMeta("first"), fakeMeta("second")];
  const steps = { first: replayable("first"), second: replayable("second") };
  await runSourceReverification({ ...common(original, path.join(work, "operation"), null), recipes, steps, recipeIds: ["first", "second"], replayBundle: path.join(work, "bundle") });
  const main = await fixtureRepository(t);
  const ledger = await readLedger(main);
  ledger.push(ledgerRow("first-source", "first-newer", "2026-10-08T00:00:00.000Z", "first-source-base"));
  await writeFile(path.join(main, LEDGER), `${JSON.stringify(ledger, null, 2)}\n`);
  git(main, "commit", "-qam", "newer first");
  const result = await replaySourceReverification({ ...common(main, path.join(work, "replay"), null), recipes, steps, replayFrom: path.join(work, "bundle") });
  assert.deepEqual(result.steps.map(({ id }) => id), ["second"]);
  assert.deepEqual(result.dropped, [{ recipeIds: ["first"], reason: "UP_TO_DATE_ON_MAIN", sourceIds: ["first-source"] }]);
});

test("재생 등록이 묶음의 snapshot과 다른 행을 만들면 REVERIFICATION_REPLAY_MISMATCH로 묶음을 되돌리고 실패한다", async (t) => {
  const { bundle } = await collectBusanBundle(t);
  const main = await fixtureRepository(t);
  const work = await scratch(t, "mismatch");
  const before = git(main, "rev-parse", "HEAD");
  const { execute } = recordingExecute(main, { snapshotSuffix: "-different" });
  await assert.rejects(
    replaySourceReverification({ ...common(main, path.join(work, "operation"), execute), replayFrom: bundle }),
    /^Error: REVERIFICATION_REPLAY_MISMATCH: busan-topology: busan-transportation-route-topology /u,
  );
  assert.equal(git(main, "rev-parse", "HEAD"), before);
  assert.equal(git(main, "status", "--porcelain"), "");
  assert.deepEqual(JSON.parse(await readFile(path.join(work, "operation", "failures.json"), "utf8")).map(({ code }) => code), [
    "REVERIFICATION_REPLAY_MISMATCH", "REVERIFICATION_DEPENDENCY_FAILED", "REVERIFICATION_DEPENDENCY_FAILED",
  ]);
});

test("묶음 파일이 manifest의 sha256과 다르거나 재생할 수 없는 recipe를 담으면 아무것도 등록하지 않고 REVERIFICATION_REPLAY_INVALID로 실패한다", async (t) => {
  const { bundle } = await collectBusanBundle(t);
  const main = await fixtureRepository(t);
  const run = async (label) => {
    const work = await scratch(t, label);
    const { calls, execute } = recordingExecute(main);
    await assert.rejects(replaySourceReverification({ ...common(main, path.join(work, "operation"), execute), replayFrom: bundle }), /^Error: REVERIFICATION_REPLAY_INVALID: /u, label);
    assert.deepEqual(calls, [], label);
  };
  const manifestPath = path.join(bundle, REPLAY_MANIFEST_FILE);
  const manifest = await readFile(manifestPath, "utf8");
  await writeFile(manifestPath, manifest.replace(/"recipeId": "busan-timetable"/u, '"recipeId": "korail-topology"'));
  await run("not-replayable");
  await writeFile(manifestPath, manifest);
  await writeFile(path.join(bundle, "busan-timetable", "timetable.json"), "{\"tampered\":true}\n");
  await run("tampered");
  assert.equal(git(main, "log", "--format=%s"), "base");
});

const ESCAPING_NAME = "../../escape.json";
const entryOf = (manifest, recipeId) => manifest.recipes.find((entry) => entry.recipeId === recipeId);
const MANIFEST_TAMPERING = [
  ["recipe 표에 없는 recipeId", (manifest) => { entryOf(manifest, "busan-timetable").recipeId = "no-such-recipe"; }],
  ["객체가 아닌 recipe 항목", (manifest) => { manifest.recipes.push(null); }],
  ["모르는 schemaVersion", (manifest) => { manifest.schemaVersion = 2; }],
  ["모르는 artifactKind", (manifest) => { manifest.artifactKind = "source-reverification-bundle"; }],
  ["빈 recipe 목록", (manifest) => { manifest.recipes = []; }],
  ["배열이 아닌 recipe 목록", (manifest) => { manifest.recipes = { ...manifest.recipes }; }],
  ["../로 묶음 밖을 가리키는 보관 파일", (manifest, escapeSha) => { entryOf(manifest, "busan-timetable").files[0] = { name: ESCAPING_NAME, sha256: escapeSha }; }],
  ["하위 경로를 담은 보관 파일", (manifest) => { entryOf(manifest, "busan-timetable").files[0].name = "nested/timetable.json"; }],
  ["소문자 16진수가 아닌 sha256", (manifest) => { entryOf(manifest, "busan-timetable").files[0].sha256 = "A".repeat(64); }],
  ["recipe와 다른 원천", (manifest) => { entryOf(manifest, "busan-topology").sources[0].sourceId = "first-source"; }],
  ["시각이 아닌 capturedAt", (manifest) => { entryOf(manifest, "busan-topology").sources[0].capturedAt = "2026-10-07"; }],
  ["빈 snapshotId", (manifest) => { entryOf(manifest, "busan-topology").sources[0].snapshotId = ""; }],
];

test("manifest의 모양·보관 파일 이름·sha256 형식·원천 중 하나라도 recipe와 다르면 main 상태와 관계없이 아무것도 쓰거나 등록하지 않고 REVERIFICATION_REPLAY_INVALID로 실패한다", async (t) => {
  const { bundle } = await collectBusanBundle(t);
  const manifestPath = path.join(bundle, REPLAY_MANIFEST_FILE);
  const original = await readFile(manifestPath, "utf8");
  const escapeBytes = Buffer.from("{\"outside\":true}\n");
  await writeFile(path.join(path.dirname(bundle), "escape.json"), escapeBytes);
  const escapeSha = createHash("sha256").update(escapeBytes).digest("hex");
  const mains = [["재생할 main", await fixtureRepository(t)], ["이미 최신인 main", await fixtureRepository(t, { capturedAt: COLLECTED })]];
  for (const [label, tamper] of MANIFEST_TAMPERING) {
    const manifest = JSON.parse(original);
    tamper(manifest, escapeSha);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    for (const [state, main] of mains) {
      const work = await scratch(t, "tampered");
      const { calls, execute } = recordingExecute(main);
      const before = git(main, "rev-parse", "HEAD");
      await assert.rejects(
        replaySourceReverification({ ...common(main, path.join(work, "operation"), execute), replayFrom: bundle }),
        /^Error: REVERIFICATION_REPLAY_INVALID: /u, `${label} (${state})`,
      );
      assert.deepEqual(calls, [], `${label} (${state}): 등록기를 부르지 않는다`);
      assert.equal(git(main, "rev-parse", "HEAD"), before, `${label} (${state})`);
      assert.equal(git(main, "status", "--porcelain"), "", `${label} (${state})`);
      await assert.rejects(readdir(path.join(work, "operation")), { code: "ENOENT" }, `${label} (${state}): 작업 위치에 아무것도 쓰지 않는다`);
      await assert.rejects(readFile(path.join(work, "escape.json")), { code: "ENOENT" }, `${label} (${state}): 묶음 밖 경로로 쓰지 않는다`);
    }
  }
});

test("실제 recipe 표에서 재생되는 의존 묶음은 부산·대전 둘뿐이다. 광주·대구 접근성은 재생할 수 없는 recipe와 한 묶음이라 담기지 않는다", () => {
  const replayableGroups = dependencyGroups(REVERIFICATION_RECIPES)
    .filter((group) => group.every(({ id }) => RECIPE_STEPS[id].every(({ retains }) => Array.isArray(retains))))
    .map((group) => group.map(({ id }) => id));
  assert.deepEqual(replayableGroups, [BUSAN, ["daejeon-topology", "daejeon-accessibility", "daejeon-timetable"]]);
  const groupOf = (id) => dependencyGroups(REVERIFICATION_RECIPES).find((group) => group.some((recipe) => recipe.id === id)).map((recipe) => recipe.id);
  assert.deepEqual(groupOf("gwangju-accessibility"), ["gwangju-topology", "gwangju-accessibility"]);
  assert.deepEqual(groupOf("daegu-accessibility"), ["daegu-sources", "daegu-accessibility"]);
});

const NETWORK_BLOCK = "data:text/javascript,globalThis.fetch=async()=>{throw new Error('NETWORK_BLOCKED')}";
const USAGE_ERROR = /usage:|_CLI\b|_ARGUMENTS?\b|arguments mismatch/iu;
const repositoryRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

test("재생이 부르는 register 모드 명령은 실제 등록기의 인자 파서가 받아들인다 (대전 포함)", async (t) => {
  const work = await scratch(t, "parsers");
  const calls = [];
  const ctx = (recipeId) => ({
    recipeId, repositoryRoot, operationDir: path.join(work, recipeId), env: {}, replay: true, shared: new Map(), lib: {}, now: () => new Date(),
    execute: async (script, args) => { calls.push({ script, args }); return { stdout: "" }; },
    head: async () => { throw new Error("replay must not bind the publication HEAD"); },
    readJson: async (relative) => JSON.parse(await readFile(path.join(repositoryRoot, relative), "utf8")),
    file: (name) => path.join(work, recipeId, name),
  });
  for (const recipeId of [...BUSAN, "daejeon-topology", "daejeon-accessibility", "daejeon-timetable"]) {
    await mkdir(path.join(work, recipeId));
    for (const recipeStep of RECIPE_STEPS[recipeId].filter(({ kind }) => kind !== "collect")) await recipeStep.run(ctx(recipeId));
  }
  assert.equal(calls.length, 6);
  for (const { script, args } of calls) {
    const result = spawnSync(process.execPath, ["--import", NETWORK_BLOCK, path.join(repositoryRoot, "tools/datapack", script), ...args], {
      cwd: repositoryRoot, env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 60_000,
    });
    assert.notEqual(result.status, null, `${script}: timed out`);
    assert.notEqual(result.status, 0, `${script}: 가짜 입력은 등록되지 않는다`);
    assert.doesNotMatch(`${result.stderr}${result.stdout}`, USAGE_ERROR, `${script} ${args.join(" ")}: ${result.stderr.slice(0, 300)}`);
  }
  assert.equal(git(repositoryRoot, "status", "--porcelain", "--", "tools/datapack/release", "tools/datapack/source-inventory.json"), "", "실제 원장은 바뀌지 않는다");
});
