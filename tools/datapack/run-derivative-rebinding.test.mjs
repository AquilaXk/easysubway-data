import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DERIVATIVE_STEPS, restoreRetainedGwangjuObservation, runDerivativeRebinding } from "./run-derivative-rebinding.mjs";

// #969 P4: 원천 등록·재확인 뒤 입력 결속이 바뀐 파생 산출물을 다시 만드는 controller.
// 도구는 모두 멱등이라 "다시 실행해 diff가 있으면 갱신 필요"가 판정이다. 단계마다 허용 경로만 바뀌고 단계별 커밋으로 쌓인다.
// 실패(결속 불일치·원천 읽기 실패)는 이후 단계를 막고 그대로 드러난다. 이전 값으로 대체하지 않는다.
const repositoryRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sha = (value) => createHash("sha256").update(value).digest("hex");

function git(cwd, ...args) {
  const result = spawnSync("/usr/bin/git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

async function fixtureRepository(files = { "a.json": "A\n", "b.json": "B\n", "c.json": "C\n" }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "derivative-rebinding-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "test");
  git(root, "config", "user.email", "test@example.invalid");
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(root, name), content);
  git(root, "add", ...Object.keys(files));
  git(root, "commit", "-q", "-m", "base");
  return root;
}

const step = (id, allowed, run) => ({ id, message: `[Data] ${id}`, isAllowedPath: (relative) => allowed.includes(relative), run });
const write = (name, content) => async ({ repositoryRoot: root }) => writeFile(path.join(root, name), content);
const options = (root, steps, extra = {}) => ({ repositoryRoot: root, operationRoot: path.join(root, "..", `op-${path.basename(root)}`), steps, ledgerPath: null, ...extra });

test("단계를 정해진 순서로 실행하고 바뀐 단계만 허용 경로를 그 단계 커밋으로 쌓는다", async (t) => {
  const root = await fixtureRepository(); t.after(() => rm(root, { recursive: true, force: true }));
  const order = [];
  const steps = [
    step("first", ["a.json"], async (context) => { order.push("first"); await write("a.json", "A2\n")(context); }),
    step("second", ["b.json"], async () => { order.push("second"); }),
    step("third", ["b.json", "c.json"], async (context) => { order.push("third"); await write("c.json", "C2\n")(context); }),
  ];
  const result = await runDerivativeRebinding(options(root, steps));
  assert.deepEqual(order, ["first", "second", "third"]);
  assert.deepEqual(result.steps.map(({ id, changed }) => [id, changed]), [["first", true], ["second", false], ["third", true]]);
  assert.deepEqual(git(root, "log", "--format=%s", "-3").split("\n"), ["[Data] third", "[Data] first", "base"]);
  assert.equal(git(root, "show", "--name-only", "--format=", "HEAD~1"), "a.json");
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("아무것도 바뀌지 않으면 커밋 없이 모든 단계가 unchanged다", async (t) => {
  const root = await fixtureRepository(); t.after(() => rm(root, { recursive: true, force: true }));
  const before = git(root, "rev-parse", "HEAD");
  const result = await runDerivativeRebinding(options(root, [step("first", ["a.json"], async () => {}), step("second", ["b.json"], async () => {})]));
  assert.deepEqual(result.steps.map(({ changed }) => changed), [false, false]);
  assert.equal(git(root, "rev-parse", "HEAD"), before);
});

test("단계가 실패하면 BINDING_MISMATCH로 멈추고 이후 단계는 실행하지 않는다", async (t) => {
  const root = await fixtureRepository(); t.after(() => rm(root, { recursive: true, force: true }));
  const ran = [];
  const steps = [
    step("first", ["a.json"], async (context) => { ran.push("first"); await write("a.json", "A2\n")(context); }),
    step("second", ["b.json"], async () => { ran.push("second"); throw new Error("TRANSFER metrics values changed"); }),
    step("third", ["c.json"], async () => { ran.push("third"); }),
  ];
  await assert.rejects(runDerivativeRebinding(options(root, steps)), /^Error: BINDING_MISMATCH: second: TRANSFER metrics values changed$/u);
  assert.deepEqual(ran, ["first", "second"]);
  // 앞 단계의 커밋은 남지만 PR은 만들어지지 않는다(workflow가 controller 실패로 멈춘다).
  assert.equal(git(root, "log", "--format=%s", "-1"), "[Data] first");
});

test("단계가 이미 이름 붙은 이상 코드로 실패하면 그 코드를 그대로 드러낸다", async (t) => {
  const root = await fixtureRepository(); t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(runDerivativeRebinding(options(root, [step("first", ["a.json"], async () => { throw new Error("SOURCE_FETCH_FAILED: object is missing"); })])),
    /^Error: SOURCE_FETCH_FAILED: first: object is missing$/u);
});

test("허용 경로 밖을 바꾸면 커밋하지 않고 DERIVATIVE_OUTPUT_SCOPE로 실패한다", async (t) => {
  const root = await fixtureRepository(); t.after(() => rm(root, { recursive: true, force: true }));
  const before = git(root, "rev-parse", "HEAD");
  await assert.rejects(runDerivativeRebinding(options(root, [step("first", ["a.json"], async (context) => {
    await write("a.json", "A2\n")(context); await write("b.json", "B2\n")(context); await writeFile(path.join(context.repositoryRoot, "new.json"), "x");
  })])), /^Error: DERIVATIVE_OUTPUT_SCOPE: first: b\.json, new\.json$/u);
  assert.equal(git(root, "rev-parse", "HEAD"), before);
});

test("시작할 때 작업 트리가 깨끗하지 않으면 실패한다", async (t) => {
  const root = await fixtureRepository(); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "a.json"), "dirty\n");
  await assert.rejects(runDerivativeRebinding(options(root, [step("first", ["a.json"], async () => {})])), /DERIVATIVE_WORKTREE_DIRTY/u);
});

test("단계 목록은 의존 순서(광주 보관 projection → 부산 지표 → 서울 실측 지표 → 서울 환승 재결속)로 고정이다", () => {
  assert.deepEqual(DERIVATIVE_STEPS.map(({ id }) => id), ["retained-gwangju-projection", "busan-transfer-metrics", "seoul-measured-transfer-metrics", "seoul-transfer-source-admission"]);
  for (const { id, message, isAllowedPath, run } of DERIVATIVE_STEPS) {
    assert.match(message, /^\[Data\] /u, id);
    assert.equal(typeof isAllowedPath, "function", id);
    assert.equal(typeof run, "function", id);
  }
  const allowed = (id, relative) => DERIVATIVE_STEPS.find((item) => item.id === id).isAllowedPath(relative);
  assert.equal(allowed("busan-transfer-metrics", "tools/datapack/release/current-busan-transfer-metrics.json"), true);
  assert.equal(allowed("busan-transfer-metrics", "tools/datapack/source-inventory.json"), false);
  assert.equal(allowed("seoul-measured-transfer-metrics", "tools/datapack/release/current-seoul-measured-transfer-metrics.json"), true);
  assert.equal(allowed("retained-gwangju-projection", "tools/datapack/source-inventory.json"), true);
  assert.equal(allowed("retained-gwangju-projection", `tools/datapack/sources/kric-nationwide-timetable-file-gwangju-${"a".repeat(64)}.json`), true);
  assert.equal(allowed("retained-gwangju-projection", "tools/datapack/release/source-snapshots.json"), false);
  for (const relative of ["tools/datapack/release/current-transfer-topology-metrics.json", "tools/datapack/release/current-capital-transfer-topology-applicability.json",
    "tools/datapack/source-inventory.json", "tools/datapack/release/source-snapshots.json", "tools/datapack/sources/seoul-metro-transfer-distance-duration-20260815T094038817Z.json"]) {
    assert.equal(allowed("seoul-transfer-source-admission", relative), true, relative);
  }
  assert.equal(allowed("seoul-transfer-source-admission", "tools/datapack/release/candidate-build-spec.json"), false);
});

test("실제 단계가 호출하는 도구는 모두 저장소에 있고 후보·hash 산출물은 어느 단계도 쓸 수 없다", () => {
  for (const script of ["project-retained-gwangju-timetable.mjs", "build-busan-transfer-metrics.mjs", "build-seoul-measured-transfer-metrics.mjs", "rebind-current-seoul-transfer-source-admission.mjs"]) {
    assert.ok(existsSync(path.join(repositoryRoot, "tools/datapack", script)), script);
  }
  for (const { id, isAllowedPath } of DERIVATIVE_STEPS) {
    for (const relative of ["tools/datapack/release/candidate-build-spec.json", "tools/datapack/release/release-request.json", "tools/datapack/release/hash-evidence.json",
      "tools/datapack/release/current-five-region-source-fan-in.json", "tools/datapack/source-governance-policy.json"]) assert.equal(isAllowedPath(relative), false, `${id} ${relative}`);
  }
});

function ociFixture({ key = "sources/kric-nationwide-timetable-file/abc/observation.json", bytes = Buffer.from("observation-bytes") } = {}) {
  const row = { rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/${key}`, rawObjectSha256: sha(bytes), byteSize: bytes.length };
  return { key, bytes, row };
}

test("광주 보관 관측은 원장 head의 OCI 객체를 GET만으로 받아 sha256과 크기를 확인한 뒤 쓴다", async (t) => {
  const operationRoot = await mkdtemp(path.join(os.tmpdir(), "derivative-observation-")); t.after(() => rm(operationRoot, { recursive: true, force: true }));
  const { key, bytes, row } = ociFixture();
  const calls = [];
  const client = { readObject: async (...args) => { calls.push(args); return { exists: true, body: bytes }; } };
  const file = await restoreRetainedGwangjuObservation({ row, client, operationRoot });
  assert.deepEqual(calls, [[key, { maxResponseBytes: bytes.length }]]);
  assert.equal(path.dirname(file), operationRoot);
  assert.deepEqual(await readFile(file), bytes);
});

test("관측을 받지 못하거나 바이트가 원장과 다르면 SOURCE_FETCH_FAILED로 멈춘다", async (t) => {
  const operationRoot = await mkdtemp(path.join(os.tmpdir(), "derivative-observation-")); t.after(() => rm(operationRoot, { recursive: true, force: true }));
  const { bytes, row } = ociFixture();
  const restore = (client, overrides = {}) => restoreRetainedGwangjuObservation({ row: { ...row, ...overrides }, client, operationRoot });
  await assert.rejects(restore({ readObject: async () => { throw new Error("HTTP 503"); } }), /^Error: SOURCE_FETCH_FAILED: .*HTTP 503/u);
  await assert.rejects(restore({ readObject: async () => ({ exists: false }) }), /^Error: SOURCE_FETCH_FAILED: .*missing/u);
  await assert.rejects(restore({ readObject: async () => ({ exists: true, body: Buffer.concat([bytes, Buffer.from("x")]) }) }), /^Error: SOURCE_FETCH_FAILED: .*sha256/u);
  await assert.rejects(restore({ readObject: async () => ({ exists: true, body: bytes }) }, { rawObjectUri: "https://example.invalid/x" }), /^Error: SOURCE_FETCH_FAILED: .*object URI/u);
  await mkdir(path.join(operationRoot, "unused"), { recursive: true });
});

// #975 리뷰 F5: 경로 allowlist만으로는 원장 변화의 크기를 모른다. 단계가 원장을 바꾸면 원장 변화 게이트(SOURCE_SHA_DRIFT·SOURCE_COUNT_DELTA)를 통과해야 커밋된다.
const LEDGER = "tools/datapack/release/source-snapshots.json";
const POLICY = { schemaVersion: 1, issue: 969, allowContentChange: true, maxRowDeltaRatio: 0.05, allowCoverageDecrease: false, sourceOverrides: {} };
const ledgerRow = (snapshotId, overrides = {}) => ({ sourceId: "seoul-metro-transfer-distance-duration", snapshotId, previousSnapshotId: null, rawSha256: "a".repeat(64), contentSha256: "b".repeat(64), rowCount: 100, coverageCount: 8, transferTopology: { canonicalPackSha256: "1".repeat(64) }, ...overrides });
async function ledgerRepository() {
  const root = await fixtureRepository({ "a.json": "A\n" });
  await mkdir(path.join(root, "tools/datapack/release"), { recursive: true });
  await writeFile(path.join(root, LEDGER), `${JSON.stringify([ledgerRow("s1")])}\n`);
  git(root, "add", LEDGER); git(root, "commit", "-q", "-m", "ledger");
  return root;
}
const rewriteLedger = (rows) => async ({ repositoryRoot: root }) => writeFile(path.join(root, LEDGER), `${JSON.stringify(rows)}\n`);
const ledgerStep = (run) => step("ledger-step", [LEDGER], run);

test("원장을 바꾸는 단계가 결속 필드만 바꾸면 통과하고 커밋된다", async (t) => {
  const root = await ledgerRepository(); t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runDerivativeRebinding(options(root, [ledgerStep(rewriteLedger([ledgerRow("s1", { transferTopology: { canonicalPackSha256: "2".repeat(64) } })]))], { ledgerPath: LEDGER, policy: POLICY }));
  assert.deepEqual(result.steps.map(({ changed }) => changed), [true]);
});

test("원장의 기존 행 원천 식별을 바꾸면 SOURCE_SHA_DRIFT로 멈추고 커밋하지 않는다", async (t) => {
  const root = await ledgerRepository(); t.after(() => rm(root, { recursive: true, force: true }));
  const before = git(root, "rev-parse", "HEAD");
  await assert.rejects(runDerivativeRebinding(options(root, [ledgerStep(rewriteLedger([ledgerRow("s1", { contentSha256: "c".repeat(64) })]))], { ledgerPath: LEDGER, policy: POLICY })),
    /^Error: SOURCE_SHA_DRIFT: ledger-step: seoul-metro-transfer-distance-duration s1: an existing row changed its source identity \(contentSha256\)$/u);
  assert.equal(git(root, "rev-parse", "HEAD"), before);
});

test("새 원장 행의 행 수 변화가 한도를 넘으면 SOURCE_COUNT_DELTA로 멈추고, 한도 안이면 통과한다", async (t) => {
  const root = await ledgerRepository(); t.after(() => rm(root, { recursive: true, force: true }));
  const next = (rowCount) => ledgerRow("s2", { previousSnapshotId: "s1", rowCount, diffSummary: { status: "CHANGED", rowDelta: rowCount - 100, coverageDelta: 0 } });
  await assert.rejects(runDerivativeRebinding(options(root, [ledgerStep(rewriteLedger([ledgerRow("s1"), next(130)]))], { ledgerPath: LEDGER, policy: POLICY })), /^Error: SOURCE_COUNT_DELTA: ledger-step: seoul-metro-transfer-distance-duration s2: rowDelta 30 \(30\.0%\) exceeds 5\.0%$/u);
  const fresh = await ledgerRepository(); t.after(() => rm(fresh, { recursive: true, force: true }));
  const ok = await runDerivativeRebinding(options(fresh, [ledgerStep(rewriteLedger([ledgerRow("s1"), next(103)]))], { ledgerPath: LEDGER, policy: POLICY }));
  assert.equal(ok.steps[0].changed, true);
});

test("원장 게이트 기본 정책은 저장소의 정책 파일이고, 원장을 바꾸지 않는 단계에는 게이트가 끼지 않는다", async (t) => {
  const root = await ledgerRepository(); t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runDerivativeRebinding(options(root, [step("plain", ["a.json"], write("a.json", "A2\n"))], { ledgerPath: LEDGER }));
  assert.equal(result.steps[0].changed, true);
  await assert.rejects(runDerivativeRebinding(options(root, [ledgerStep(rewriteLedger([ledgerRow("s1", { rowCount: 101 })]))], { ledgerPath: LEDGER })), /^Error: SOURCE_SHA_DRIFT: ledger-step: /u);
});
