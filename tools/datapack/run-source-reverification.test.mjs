import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { classifyRecipeFailure, dependencyGroups, evaluateEvidenceChange, runSourceReverification } from "./run-source-reverification.mjs";
import { REVERIFICATION_RECIPES } from "./source-reverification-recipes.mjs";

// #984(#969 남은 단계 1): P7D 원천 재확인 controller. DUE로 판정된 recipe를 의존 순서로 실행하고 recipe마다 커밋한다.
// 수집 실패는 SOURCE_FETCH_FAILED, 등록 실패는 SOURCE_REGISTRATION_FAILED, 원장·증거 변화가 정책을 넘으면 SOURCE_SHA_DRIFT·SOURCE_COUNT_DELTA로 멈춘다.
// 이전·추정 값으로 대체하지 않는다.
// #1102: recipe 하나의 실패가 나머지 recipe의 등록까지 버리지 않는다. 의존 묶음(topology와 그에 결속되는 recipe)은 전부 등록되거나 전부 되돌려지고(부분 등록은
// 결속이 어긋난 상태를 남긴다), 독립 묶음은 서로 영향이 없다. 실패는 failures로 드러나고 workflow가 PR을 만든 뒤 마지막에 job을 실패시킨다.
const INVENTORY = "tools/datapack/source-inventory.json";
const LEDGER = "tools/datapack/release/source-snapshots.json";
const GOVERNANCE = "tools/datapack/source-governance-policy.json";
const FRESHNESS = "release/product-gates/datapack-freshness-sla.json";
const POLICY = { schemaVersion: 1, issue: 969, allowContentChange: true, maxRowDeltaRatio: 0.05, allowCoverageDecrease: false, sourceOverrides: {} };
const STRICT = { ...POLICY, allowContentChange: false };
const SHA = (char) => char.repeat(64);

function git(cwd, ...args) {
  const result = spawnSync("/usr/bin/git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const ledgerRow = (sourceId, snapshotId, overrides = {}) => ({
  sourceId, snapshotId, previousSnapshotId: null, rawSha256: SHA("a"), contentSha256: SHA("b"), rowCount: 100, coverageCount: 8, ...overrides,
});
const evidence = (overrides = {}) => ({
  snapshotId: "kric-capital-1", rawSha256: SHA("c"), recordsSha256: SHA("d"), recordCount: 1000, routes: Array.from({ length: 10 }, (_, index) => ({ routeNumber: `R${index}` })), ...overrides,
});
const inventoryWith = (capital, korail) => ({ sources: [{ id: "kric-nationwide-timetable-file", capitalScheduleAdmissionEvidence: capital, korailScheduleAdmissionEvidence: korail }] });

async function fixtureRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "source-reverification-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "test");
  git(root, "config", "user.email", "test@example.invalid");
  // 커밋이 백그라운드 gc를 띄우면 테스트 정리(rm)와 겹쳐 ENOTEMPTY가 난다.
  git(root, "config", "gc.auto", "0");
  git(root, "config", "maintenance.auto", "false");
  const files = {
    [INVENTORY]: `${JSON.stringify(inventoryWith(evidence(), evidence({ snapshotId: "kric-korail-1" })), null, 2)}\n`,
    [LEDGER]: `${JSON.stringify([ledgerRow("gwangju-transportation-route-topology", "gwangju-1")], null, 2)}\n`,
    [GOVERNANCE]: "{}\n",
    [FRESHNESS]: "{}\n",
    "tools/datapack/sources/existing.json": "{}\n",
  };
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
  git(root, "add", ...Object.keys(files));
  git(root, "commit", "-q", "-m", "base");
  return root;
}

const meta = (id, dependsOn = [], extra = {}) => ({ id, message: `[Data] ${id} 재확인`, sourceIds: [`${id}-source`], dependsOn, due: dependsOn.length === 0 ? { kind: "ledger-head", sourceIds: [`${id}-source`] } : null, ...extra });
const stepsOf = (kind, run) => [{ id: "only", kind, run }];
const rewriteLedger = (rows) => async ({ repositoryRoot }) => writeFile(path.join(repositoryRoot, LEDGER), `${JSON.stringify(rows, null, 2)}\n`);
const options = (root, overrides = {}) => ({ repositoryRoot: root, operationRoot: path.join(root, "..", `op-${path.basename(root)}`), env: {}, policy: POLICY, now: new Date("2026-10-07T00:00:00.000Z"), execute: async () => ({ stdout: "" }), ...overrides });
const resetWorktree = (root) => { git(root, "reset", "-q", "--hard", "HEAD"); git(root, "clean", "-fdq"); };
const commitSubjects = (root, count) => git(root, "log", "--format=%s", `-${count}`).split("\n");

test("recipe를 의존 순서로 실행하고 recipe마다 바뀐 허용 경로를 한 커밋으로 쌓는다", async (t) => {
  const root = await fixtureRepository(); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const order = [];
  const recipes = [meta("first"), meta("second", ["first"]), meta("third")];
  const steps = {
    first: stepsOf("register", async (ctx) => { order.push(["first", ctx.operationDir]); await writeFile(path.join(ctx.repositoryRoot, "tools/datapack/sources/new-first.json"), "{}\n"); await rewriteLedger([ledgerRow("gwangju-transportation-route-topology", "gwangju-1")])(ctx); await writeFile(path.join(ctx.repositoryRoot, GOVERNANCE), "{\"v\":2}\n"); }),
    second: stepsOf("register", async (ctx) => { order.push(["second", ctx.operationDir]); await writeFile(path.join(ctx.repositoryRoot, "tools/datapack/sources/new-second.json"), "{}\n"); }),
    third: stepsOf("register", async (ctx) => { order.push(["third", ctx.operationDir]); await writeFile(path.join(ctx.repositoryRoot, INVENTORY), `${JSON.stringify(inventoryWith(evidence({ reverifiedAt: "x" }), evidence({ snapshotId: "kric-korail-1" })), null, 2)}\n`); }),
  };
  const operationRoot = path.join(root, "..", `op-order-${path.basename(root)}`);
  const result = await runSourceReverification(options(root, { recipes, steps, recipeIds: ["first", "second", "third"], operationRoot }));
  assert.deepEqual(order, [["first", path.join(operationRoot, "first")], ["second", path.join(operationRoot, "second")], ["third", path.join(operationRoot, "third")]]);
  assert.deepEqual(result.steps, [
    { id: "first", changed: true, paths: [GOVERNANCE, "tools/datapack/sources/new-first.json"] },
    { id: "second", changed: true, paths: ["tools/datapack/sources/new-second.json"] },
    { id: "third", changed: true, paths: [INVENTORY] },
  ]);
  assert.deepEqual(commitSubjects(root, 4), ["[Data] third 재확인", "[Data] second 재확인", "[Data] first 재확인", "base"]);
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.deepEqual(result.evidenceSources, []);
});

test("의존 recipe가 목록에 없거나 알 수 없는 recipe·중복이 있으면 아무것도 실행하지 않고 실패한다", async (t) => {
  const root = await fixtureRepository(); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  let ran = 0;
  const recipes = [meta("first"), meta("second", ["first"])];
  const steps = { first: stepsOf("register", async () => { ran += 1; }), second: stepsOf("register", async () => { ran += 1; }) };
  await assert.rejects(runSourceReverification(options(root, { recipes, steps, recipeIds: ["second"] })), /^Error: REVERIFICATION_RECIPE_DEPENDENCY: second needs first$/u);
  await assert.rejects(runSourceReverification(options(root, { recipes, steps, recipeIds: ["third"] })), /^Error: REVERIFICATION_RECIPE_UNKNOWN: third$/u);
  await assert.rejects(runSourceReverification(options(root, { recipes, steps, recipeIds: ["first", "first"] })), /^Error: REVERIFICATION_RECIPE_UNKNOWN: first is listed twice$/u);
  await assert.rejects(runSourceReverification(options(root, { recipes, steps, recipeIds: [] })), /^Error: REVERIFICATION_RECIPE_UNKNOWN: no recipe is due$/u);
  assert.equal(ran, 0);
});

test("실행 순서는 목록 순서가 아니라 recipe 표 순서(의존 순서)다", async (t) => {
  const root = await fixtureRepository(); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const order = [];
  const recipes = [meta("first"), meta("second", ["first"])];
  const run = (id) => stepsOf("register", async (ctx) => { order.push(id); await writeFile(path.join(ctx.repositoryRoot, `tools/datapack/sources/${id}.json`), "{}\n"); });
  await runSourceReverification(options(root, { recipes, steps: { first: run("first"), second: run("second") }, recipeIds: ["second", "first"] }));
  assert.deepEqual(order, ["first", "second"]);
});

test("수집 단계 실패는 SOURCE_FETCH_FAILED, 등록·입력 조립 실패는 SOURCE_REGISTRATION_FAILED로 드러나고 모든 recipe가 실패하면 첫 실패로 멈춘다", async (t) => {
  const root = await fixtureRepository(); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const before = git(root, "rev-parse", "HEAD");
  const run = (kind, message) => runSourceReverification(options(root, { recipes: [meta("second")], steps: { second: stepsOf(kind, async () => { throw new Error(message); }) }, recipeIds: ["second"] }));
  await assert.rejects(run("collect", "Gwangju route topology HTTP 503"), /^Error: SOURCE_FETCH_FAILED: second\/only: Gwangju route topology HTTP 503$/u);
  await assert.rejects(run("register", "Gwangju topology OCI publication failed"), /^Error: SOURCE_REGISTRATION_FAILED: second\/only: Gwangju topology OCI publication failed$/u);
  await assert.rejects(run("glue", "previous snapshot is missing"), /^Error: SOURCE_REGISTRATION_FAILED: second\/only: previous snapshot is missing$/u);
  // 이미 이름 붙은 이상 코드는 그대로 드러낸다.
  await assert.rejects(run("collect", "SOURCE_FETCH_FAILED: object is missing"), /^Error: SOURCE_FETCH_FAILED: second\/only: object is missing$/u);
  assert.equal(git(root, "rev-parse", "HEAD"), before);
});

const writeSnapshot = (name) => async (ctx) => writeFile(path.join(ctx.repositoryRoot, `tools/datapack/sources/${name}.json`), "{}\n");
const failing = (kind, message) => stepsOf(kind, async () => { throw new Error(message); });

// #1102: 독립 recipe 하나의 실패가 나머지의 등록을 버리지 않는다. 실패한 recipe는 failures로 드러나고 그 recipe의 부분 출력은 남지 않는다.
test("독립 recipe 하나가 실패해도 나머지 recipe는 등록하고 실패는 failures로 드러난다", async (t) => {
  const root = await fixtureRepository(); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const ran = [];
  const recipes = [meta("first"), meta("second"), meta("third")];
  const steps = {
    first: stepsOf("register", async (ctx) => { ran.push("first"); await writeSnapshot("first")(ctx); }),
    second: stepsOf("collect", async (ctx) => {
      ran.push("second");
      // 실패 전에 남긴 부분 출력(새 snapshot 파일과 수정한 정책·원장)은 되돌려져야 한다.
      await writeSnapshot("second-partial")(ctx);
      await writeFile(path.join(ctx.repositoryRoot, GOVERNANCE), "{\"v\":2}\n");
      throw new Error("KASI public holiday request failed: NETWORK_CONNECT_TIMEOUT");
    }),
    third: stepsOf("register", async (ctx) => { ran.push("third"); await writeSnapshot("third")(ctx); }),
  };
  const result = await runSourceReverification(options(root, { recipes, steps, recipeIds: ["first", "second", "third"] }));
  assert.deepEqual(ran, ["first", "second", "third"]);
  assert.deepEqual(result.steps.map(({ id }) => id), ["first", "third"]);
  assert.deepEqual(result.failures, [{ recipeId: "second", code: "SOURCE_FETCH_FAILED", detail: "second/only: KASI public holiday request failed: NETWORK_CONNECT_TIMEOUT" }]);
  assert.deepEqual(commitSubjects(root, 3), ["[Data] third 재확인", "[Data] first 재확인", "base"]);
  assert.equal(git(root, "status", "--porcelain"), "", "실패한 recipe의 부분 출력은 남지 않는다");
  assert.equal(await readFile(path.join(root, GOVERNANCE), "utf8"), "{}\n");
  assert.deepEqual(git(root, "ls-files", "tools/datapack/sources").split("\n").sort(), ["tools/datapack/sources/existing.json", "tools/datapack/sources/first.json", "tools/datapack/sources/third.json"]);
});

// 의존 묶음은 전부 아니면 전무다: 의존 대상(topology)만 등록되고 그에 결속되는 recipe가 실패하면 결속이 어긋난 상태가 남고, 그 recipe는 의존 대상 없이는 DUE가 되지 않는다.
test("의존 묶음의 뒤쪽 recipe가 실패하면 앞쪽 등록도 되돌려 묶음 전체를 실패로 드러낸다", async (t) => {
  const root = await fixtureRepository(); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const recipes = [meta("topology"), meta("accessibility", ["topology"]), meta("other")];
  const steps = {
    topology: stepsOf("register", writeSnapshot("topology")),
    accessibility: failing("register", "Gwangju accessibility registration failed"),
    other: stepsOf("register", writeSnapshot("other")),
  };
  const result = await runSourceReverification(options(root, { recipes, steps, recipeIds: ["topology", "accessibility", "other"] }));
  assert.deepEqual(result.steps.map(({ id }) => id), ["other"]);
  assert.deepEqual(result.failures, [
    { recipeId: "topology", code: "REVERIFICATION_GROUP_ROLLED_BACK", detail: "topology was registered but its dependent accessibility failed, so the whole group was rolled back" },
    { recipeId: "accessibility", code: "SOURCE_REGISTRATION_FAILED", detail: "accessibility/only: Gwangju accessibility registration failed" },
  ]);
  assert.deepEqual(commitSubjects(root, 2), ["[Data] other 재확인", "base"]);
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.equal(git(root, "ls-files", "tools/datapack/sources").includes("topology.json"), false);
});

test("의존 대상이 실패하면 그에 결속되는 recipe는 실행하지 않고 건너뛴 것으로 드러낸다", async (t) => {
  const root = await fixtureRepository(); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const ran = [];
  const recipes = [meta("topology"), meta("accessibility", ["topology"]), meta("other")];
  const steps = {
    topology: stepsOf("collect", async () => { ran.push("topology"); throw new Error("Gwangju route topology HTTP 503"); }),
    accessibility: stepsOf("register", async () => { ran.push("accessibility"); }),
    other: stepsOf("register", async (ctx) => { ran.push("other"); await writeSnapshot("other")(ctx); }),
  };
  const result = await runSourceReverification(options(root, { recipes, steps, recipeIds: ["topology", "accessibility", "other"] }));
  assert.deepEqual(ran, ["topology", "other"]);
  assert.deepEqual(result.steps.map(({ id }) => id), ["other"]);
  assert.deepEqual(result.failures, [
    { recipeId: "topology", code: "SOURCE_FETCH_FAILED", detail: "topology/only: Gwangju route topology HTTP 503" },
    { recipeId: "accessibility", code: "REVERIFICATION_DEPENDENCY_FAILED", detail: "accessibility was not run because its dependency topology failed" },
  ]);
});

test("원장·증거 게이트와 출력 범위 위반도 그 recipe만 되돌리고 나머지는 등록한다", async (t) => {
  const root = await fixtureRepository(); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const recipes = [meta("scoped"), meta("drifted"), meta("fine")];
  const steps = {
    scoped: stepsOf("register", async (ctx) => { await writeSnapshot("scoped")(ctx); await writeFile(path.join(ctx.repositoryRoot, "tools/datapack/release/candidate-build-spec.json"), "{}\n"); }),
    drifted: stepsOf("register", rewriteLedger([gwangju("gwangju-1", { rawSha256: SHA("e") })])),
    fine: stepsOf("register", writeSnapshot("fine")),
  };
  const result = await runSourceReverification(options(root, { recipes, steps, policy: STRICT, recipeIds: ["scoped", "drifted", "fine"] }));
  assert.deepEqual(result.steps.map(({ id }) => id), ["fine"]);
  assert.deepEqual(result.failures.map(({ recipeId, code }) => [recipeId, code]), [["scoped", "REVERIFICATION_OUTPUT_SCOPE"], ["drifted", "SOURCE_SHA_DRIFT"]]);
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.deepEqual(commitSubjects(root, 2), ["[Data] fine 재확인", "base"]);
});

test("의존 묶음은 recipe 표의 dependsOn으로 정해진다(실제 표: topology와 그에 결속되는 recipe 셋, 나머지는 독립)", () => {
  assert.deepEqual(dependencyGroups(REVERIFICATION_RECIPES).map((group) => group.map(({ id }) => id)), [
    ["kric-capital-timetable"],
    ["korail-topology", "korail-planned-timetable"],
    ["gwangju-topology", "gwangju-accessibility"],
    ["busan-topology"],
    ["daejeon-topology", "daejeon-accessibility"],
    ["daegu-sources"],
  ]);
  // 여러 의존 대상을 가진 recipe는 그 대상들의 묶음을 하나로 합친다.
  const merged = dependencyGroups([meta("a"), meta("b"), meta("c", ["a", "b"]), meta("d")]);
  assert.deepEqual(merged.map((group) => group.map(({ id }) => id)), [["a", "b", "c"], ["d"]]);
});

test("모든 recipe가 실패하면 등록할 것이 없으므로 첫 실패 오류로 멈추고 나머지 실패를 덧붙인다", async (t) => {
  const root = await fixtureRepository(); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const before = git(root, "rev-parse", "HEAD");
  const recipes = [meta("first"), meta("second")];
  await assert.rejects(
    runSourceReverification(options(root, { recipes, steps: { first: failing("collect", "KASI public holiday request failed: NETWORK_CONNECT_TIMEOUT"), second: failing("register", "OCI publication failed") }, recipeIds: ["first", "second"] })),
    /^Error: SOURCE_FETCH_FAILED: first\/only: KASI public holiday request failed: NETWORK_CONNECT_TIMEOUT \| also failed: second \(SOURCE_REGISTRATION_FAILED\)$/u,
  );
  assert.equal(git(root, "rev-parse", "HEAD"), before);
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("작업 디렉터리가 저장소 안이면 실패한 recipe를 되돌릴 때 지워질 수 있으므로 시작하지 않는다", async (t) => {
  const root = await fixtureRepository(); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  let ran = 0;
  await assert.rejects(runSourceReverification(options(root, { operationRoot: path.join(root, "operation"), recipes: [meta("first")], steps: { first: stepsOf("register", async () => { ran += 1; }) }, recipeIds: ["first"] })),
    /^Error: REVERIFICATION_ARGUMENTS: the operation root must be outside the repository$/u);
  // "..cache"처럼 점 두 개로 시작하는 이름의 저장소 안 디렉터리도 저장소 안이다(부모 세그먼트 ..와 다르다).
  for (const inside of [path.join(root, "..cache", "op"), path.join(root, "..", path.basename(root), "op"), root]) {
    await assert.rejects(runSourceReverification(options(root, { operationRoot: inside, recipes: [meta("first")], steps: { first: stepsOf("register", async () => { ran += 1; }) }, recipeIds: ["first"] })),
      /^Error: REVERIFICATION_ARGUMENTS: the operation root must be outside the repository$/u, inside);
  }
  // 저장소 밖(형제 디렉터리, 부모 아래)은 시작한다.
  await runSourceReverification(options(root, { operationRoot: path.join(root, "..", `op-outside-${path.basename(root)}`), recipes: [meta("first")], steps: { first: stepsOf("register", writeSnapshot("outside")) }, recipeIds: ["first"] }));
  assert.equal(ran, 0);
});

test("수집·등록을 한 번에 하는 단계는 수집기 오류 코드로 실패 종류를 가른다", () => {
  const step = { id: "register", kind: "collect-register", fetchErrorPattern: /^KRIC_TIMETABLE_FILE_/u };
  assert.equal(classifyRecipeFailure(step, "KRIC_TIMETABLE_FILE_HTTP"), "SOURCE_FETCH_FAILED");
  assert.equal(classifyRecipeFailure(step, "KRIC_CAPITAL_TIMETABLE_REGISTRATION_OBSERVATION_CLOCK"), "SOURCE_REGISTRATION_FAILED");
  assert.equal(classifyRecipeFailure({ id: "x", kind: "collect" }, "boom"), "SOURCE_FETCH_FAILED");
  assert.equal(classifyRecipeFailure({ id: "x", kind: "register" }, "boom"), "SOURCE_REGISTRATION_FAILED");
  assert.equal(classifyRecipeFailure({ id: "x", kind: "glue" }, "boom"), "SOURCE_REGISTRATION_FAILED");
  // 코레일 수집기는 원본 sha를 고정해서 받는다. 이 sha가 다르면 원본이 바뀐 것이지 수집이 실패한 것이 아니다.
  assert.equal(classifyRecipeFailure({ id: "collect-timetable", kind: "collect" }, "KORAIL_METROPOLITAN_TIMETABLE_FILE_SHA256"), "SOURCE_SHA_DRIFT");
  assert.equal(classifyRecipeFailure({ id: "collect-timetable", kind: "collect" }, "KORAIL_METROPOLITAN_TIMETABLE_FILE_HTTP"), "SOURCE_FETCH_FAILED");
});

test("원본 sha가 고정과 다르면 SOURCE_SHA_DRIFT로 멈춘다", async (t) => {
  const root = await fixtureRepository(); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await assert.rejects(runSourceReverification(options(root, { recipes: [meta("korail")], steps: { korail: stepsOf("collect", async () => { throw new Error("KORAIL_METROPOLITAN_TIMETABLE_FILE_SHA256"); }) }, recipeIds: ["korail"] })),
    /^Error: SOURCE_SHA_DRIFT: korail\/only: KORAIL_METROPOLITAN_TIMETABLE_FILE_SHA256$/u);
});

test("recipe가 아무 등록 결과도 만들지 않으면 조용히 성공하지 않고 SOURCE_REGISTRATION_FAILED로 멈춘다", async (t) => {
  const root = await fixtureRepository(); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const before = git(root, "rev-parse", "HEAD");
  await assert.rejects(runSourceReverification(options(root, { recipes: [meta("first")], steps: { first: stepsOf("register", async () => {}) }, recipeIds: ["first"] })),
    /^Error: SOURCE_REGISTRATION_FAILED: first: the recipe produced no registration output$/u);
  assert.equal(git(root, "rev-parse", "HEAD"), before);
});

test("허용 경로 밖을 바꾸거나 기존 snapshot 파일을 고치면 커밋하지 않고 REVERIFICATION_OUTPUT_SCOPE로 실패한다", async (t) => {
  const root = await fixtureRepository(); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const before = git(root, "rev-parse", "HEAD");
  const run = (write) => runSourceReverification(options(root, { recipes: [meta("first")], steps: { first: stepsOf("register", write) }, recipeIds: ["first"] }));
  await assert.rejects(run(async ({ repositoryRoot }) => {
    await writeFile(path.join(repositoryRoot, GOVERNANCE), "{\"v\":2}\n");
    await writeFile(path.join(repositoryRoot, "tools/datapack/release/candidate-build-spec.json"), "{}\n");
  }), /^Error: REVERIFICATION_OUTPUT_SCOPE: first: tools\/datapack\/release\/candidate-build-spec\.json$/u);
  assert.equal(git(root, "rev-parse", "HEAD"), before);
  git(root, "checkout", "-q", "--", "."); git(root, "clean", "-fdq");
  await assert.rejects(run(async ({ repositoryRoot }) => { await writeFile(path.join(repositoryRoot, "tools/datapack/sources/existing.json"), "{\"changed\":true}\n"); }),
    /^Error: REVERIFICATION_OUTPUT_SCOPE: first: tools\/datapack\/sources\/existing\.json \(existing snapshot files are immutable\)$/u);
  git(root, "checkout", "-q", "--", ".");
  await assert.rejects(run(async ({ repositoryRoot }) => { await writeFile(path.join(repositoryRoot, "tools/datapack/.capital-route-topology-registration.lock"), "x"); }),
    /^Error: REVERIFICATION_OUTPUT_SCOPE: first: tools\/datapack\/\.capital-route-topology-registration\.lock$/u);
});

// #987 리뷰 F4: 신선도 정책은 dueAt·주기·허용 오차를 정한다. 등록 도구는 읽기만 해야 하고 바뀌면 같은 신뢰 경로의 조용한 정책 변경이다.
test("신선도 정책 파일이 바뀌면 커밋하지 않고 REVERIFICATION_OUTPUT_SCOPE로 실패한다", async (t) => {
  const root = await fixtureRepository(); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const before = git(root, "rev-parse", "HEAD");
  await assert.rejects(runSourceReverification(options(root, { recipes: [meta("first")], steps: { first: stepsOf("register", async ({ repositoryRoot }) => {
    await writeFile(path.join(repositoryRoot, GOVERNANCE), "{\"v\":2}\n");
    await writeFile(path.join(repositoryRoot, FRESHNESS), "{\"cadence\":\"P30D\"}\n");
  }) }, recipeIds: ["first"] })), /^Error: REVERIFICATION_OUTPUT_SCOPE: first: release\/product-gates\/datapack-freshness-sla\.json$/u);
  assert.equal(git(root, "rev-parse", "HEAD"), before);
});

test("시작할 때 작업 트리가 깨끗하지 않거나 경로가 절대 경로가 아니면 실패한다", async (t) => {
  const root = await fixtureRepository(); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await writeFile(path.join(root, GOVERNANCE), "dirty\n");
  await assert.rejects(runSourceReverification(options(root, { recipes: [meta("first")], steps: { first: stepsOf("register", async () => {}) }, recipeIds: ["first"] })), /REVERIFICATION_WORKTREE_DIRTY/u);
  await assert.rejects(runSourceReverification(options(root, { repositoryRoot: "relative", recipes: [meta("first")], steps: { first: stepsOf("register", async () => {}) }, recipeIds: ["first"] })), /REVERIFICATION_ARGUMENTS/u);
  await assert.rejects(runSourceReverification(options(root, { operationRoot: "relative", recipes: [meta("first")], steps: { first: stepsOf("register", async () => {}) }, recipeIds: ["first"] })), /REVERIFICATION_ARGUMENTS/u);
});

// 원장 변화 게이트(source-ledger-gate): 정책은 tools/ci/source-ledger-change-policy.json이고 코드에 한도 숫자를 두지 않는다.
const gwangju = (snapshotId, overrides = {}) => ledgerRow("gwangju-transportation-route-topology", snapshotId, overrides);
const ledgerRecipe = (rows) => ({ recipes: [meta("first")], steps: { first: stepsOf("register", rewriteLedger(rows)) }, recipeIds: ["first"] });

test("원장에 새 행을 덧붙이고 변화가 정책 안이면 통과하고 커밋된다", async (t) => {
  const root = await fixtureRepository(); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const next = gwangju("gwangju-2", { previousSnapshotId: "gwangju-1", rowCount: 103, diffSummary: { status: "CHANGED", rowDelta: 3, coverageDelta: 0 } });
  const result = await runSourceReverification(options(root, ledgerRecipe([gwangju("gwangju-1"), next])));
  assert.deepEqual(result.steps, [{ id: "first", changed: true, paths: [LEDGER] }]);
});

test("원장의 기존 행 원천 식별이 바뀌면 SOURCE_SHA_DRIFT로 멈추고 커밋하지 않는다", async (t) => {
  const root = await fixtureRepository(); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const before = git(root, "rev-parse", "HEAD");
  await assert.rejects(runSourceReverification(options(root, ledgerRecipe([gwangju("gwangju-1", { rawSha256: SHA("e") })]))),
    /^Error: SOURCE_SHA_DRIFT: first: gwangju-transportation-route-topology gwangju-1: an existing row changed its source identity \(rawSha256\)$/u);
  assert.equal(git(root, "rev-parse", "HEAD"), before);
});

test("정책이 내용 변경을 막으면 새 행의 contentSha256이 직전 head와 달라도 SOURCE_SHA_DRIFT다", async (t) => {
  const root = await fixtureRepository(); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const next = gwangju("gwangju-2", { previousSnapshotId: "gwangju-1", contentSha256: SHA("f"), diffSummary: { status: "CHANGED", rowDelta: 0, coverageDelta: 0 } });
  await assert.rejects(runSourceReverification(options(root, { ...ledgerRecipe([gwangju("gwangju-1"), next]), policy: STRICT })), /^Error: SOURCE_SHA_DRIFT: first: gwangju-transportation-route-topology gwangju-2: contentSha256 changed from /u);
});

test("새 행의 행 수 변화가 정책 한도를 넘거나 커버리지가 줄면 SOURCE_COUNT_DELTA로 멈춘다", async (t) => {
  const root = await fixtureRepository(); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const grown = gwangju("gwangju-2", { previousSnapshotId: "gwangju-1", rowCount: 130, diffSummary: { status: "CHANGED", rowDelta: 30, coverageDelta: 0 } });
  await assert.rejects(runSourceReverification(options(root, ledgerRecipe([gwangju("gwangju-1"), grown]))), /^Error: SOURCE_COUNT_DELTA: first: gwangju-transportation-route-topology gwangju-2: rowDelta 30 \(30\.0%\) exceeds 5\.0%$/u);
  resetWorktree(root);
  const shrunk = gwangju("gwangju-2", { previousSnapshotId: "gwangju-1", coverageCount: 7, diffSummary: { status: "CHANGED", rowDelta: 0, coverageDelta: -1 } });
  await assert.rejects(runSourceReverification(options(root, ledgerRecipe([gwangju("gwangju-1"), shrunk]))), /^Error: SOURCE_COUNT_DELTA: first: .*coverageDelta -1 decreases coverage$/u);
});

test("한도는 정책 파일에서 읽는다(기본 정책 = 저장소의 source-ledger-change-policy.json)", async (t) => {
  const root = await fixtureRepository(); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const grown = gwangju("gwangju-2", { previousSnapshotId: "gwangju-1", rowCount: 130, diffSummary: { status: "CHANGED", rowDelta: 30, coverageDelta: 0 } });
  const loose = { ...POLICY, maxRowDeltaRatio: 0.5 };
  assert.deepEqual((await runSourceReverification(options(root, { ...ledgerRecipe([gwangju("gwangju-1"), grown]), policy: loose }))).steps.map(({ id }) => id), ["first"]);
  const second = await fixtureRepository(); t.after(() => rm(second, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await assert.rejects(runSourceReverification(options(second, { ...ledgerRecipe([gwangju("gwangju-1"), grown]), policy: undefined })), /^Error: SOURCE_COUNT_DELTA: first: /u);
});

// 원장 행이 없는 증거(KRIC 시간표 projection)는 inventory 증거의 직전·이후를 같은 정책으로 비교한다.
const kricRecipe = (write) => ({
  recipes: [meta("kric", [], { sourceIds: ["kric-nationwide-timetable-file"], due: { kind: "inventory-evidence", sourceId: "kric-nationwide-timetable-file", classId: "official_static_timetable_confirmation", evidenceKeys: ["capitalScheduleAdmissionEvidence", "korailScheduleAdmissionEvidence"], basisField: "observedAt" } })],
  steps: { kric: stepsOf("collect-register", async (ctx) => { await write(ctx); }) },
  recipeIds: ["kric"],
});
const rewriteInventory = (capital, korail) => async ({ repositoryRoot }) => writeFile(path.join(repositoryRoot, INVENTORY), `${JSON.stringify(inventoryWith(capital, korail), null, 2)}\n`);

test("증거만 바꾸는 recipe는 증거 행(원본 sha·내용 sha·수 변화)을 남기고 같은 원본의 재확인은 NO_CHANGE다", async (t) => {
  const root = await fixtureRepository(); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const result = await runSourceReverification(options(root, kricRecipe(rewriteInventory(
    evidence({ reverifiedAt: "2026-10-07T00:00:00.000Z" }), evidence({ snapshotId: "kric-korail-2", rawSha256: SHA("1"), recordsSha256: SHA("2"), recordCount: 1020 }),
  ))));
  assert.deepEqual(result.evidenceSources, [
    { sourceId: "kric-nationwide-timetable-file", snapshotId: "kric-capital-1", previousSnapshotId: "kric-capital-1", rawSha256: SHA("c"), contentSha256: SHA("d"), rowDelta: 0, coverageDelta: 0, diffStatus: "NO_CHANGE" },
    { sourceId: "kric-nationwide-timetable-file", snapshotId: "kric-korail-2", previousSnapshotId: "kric-korail-1", rawSha256: SHA("1"), contentSha256: SHA("2"), rowDelta: 20, coverageDelta: 0, diffStatus: "CHANGED" },
  ]);
  assert.deepEqual(result.steps, [{ id: "kric", changed: true, paths: [INVENTORY] }]);
});

test("증거의 원본·내용 sha가 바뀌면 정책이 막을 때 SOURCE_SHA_DRIFT, 수 변화가 한도를 넘거나 노선이 줄면 SOURCE_COUNT_DELTA다", async (t) => {
  const root = await fixtureRepository(); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const korail = evidence({ snapshotId: "kric-korail-1" });
  const changedRaw = evidence({ snapshotId: "kric-capital-2", rawSha256: SHA("9"), recordsSha256: SHA("8") });
  await assert.rejects(runSourceReverification(options(root, { ...kricRecipe(rewriteInventory(changedRaw, korail)), policy: STRICT })), /^Error: SOURCE_SHA_DRIFT: kric: kric-nationwide-timetable-file kric-capital-2: /u);
  resetWorktree(root);
  const grown = evidence({ snapshotId: "kric-capital-2", rawSha256: SHA("9"), recordsSha256: SHA("8"), recordCount: 1300 });
  await assert.rejects(runSourceReverification(options(root, kricRecipe(rewriteInventory(grown, korail)))), /^Error: SOURCE_COUNT_DELTA: kric: kric-nationwide-timetable-file kric-capital-2: rowDelta 300 \(30\.0%\) exceeds 5\.0%$/u);
  resetWorktree(root);
  const fewer = evidence({ snapshotId: "kric-capital-2", rawSha256: SHA("9"), recordsSha256: SHA("8"), routes: [{ routeNumber: "R0" }] });
  await assert.rejects(runSourceReverification(options(root, kricRecipe(rewriteInventory(fewer, korail)))), /^Error: SOURCE_COUNT_DELTA: kric: .*coverageDelta -9 decreases coverage$/u);
});

test("증거 비교는 직전 증거가 없으면 FIRST, 증거를 지우면 BINDING_MISMATCH다", () => {
  assert.deepEqual(evaluateEvidenceChange({ sourceId: "s", before: null, after: evidence(), policy: POLICY }), {
    row: { sourceId: "s", snapshotId: "kric-capital-1", previousSnapshotId: null, rawSha256: SHA("c"), contentSha256: SHA("d"), rowDelta: 0, coverageDelta: 0, diffStatus: "FIRST" }, violations: [],
  });
  assert.equal(evaluateEvidenceChange({ sourceId: "s", before: evidence(), after: null, policy: POLICY }).violations[0].code, "BINDING_MISMATCH");
  assert.equal(evaluateEvidenceChange({ sourceId: "s", before: evidence(), after: evidence({ rawSha256: "xyz" }), policy: POLICY }).violations[0].code, "BINDING_MISMATCH");
  // 정책의 sourceOverrides가 원천별 한도를 바꾼다.
  const override = { ...STRICT, sourceOverrides: { s: { allowContentChange: true } } };
  assert.equal(evaluateEvidenceChange({ sourceId: "s", before: evidence(), after: evidence({ rawSha256: SHA("9"), recordsSha256: SHA("8") }), policy: override }).violations.length, 0);
});

test("실행 기록은 recipe 결과를 그대로 증거 단계로 돌려준다(단계 id = recipe id)", async (t) => {
  const root = await fixtureRepository(); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const result = await runSourceReverification(options(root, { recipes: [meta("first")], steps: { first: stepsOf("register", async ({ repositoryRoot }) => writeFile(path.join(repositoryRoot, "tools/datapack/sources/a.json"), "{}\n")) }, recipeIds: ["first"] }));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { steps: [{ id: "first", changed: true, paths: ["tools/datapack/sources/a.json"] }], evidenceSources: [], failures: [] });
  const text = await readFile(path.join(root, "tools/datapack/sources/a.json"), "utf8");
  assert.equal(text, "{}\n");
});
