import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { evaluateLedgerChange, parseLedgerChangePolicy } from "./source-ledger-gate.mjs";

// #969(#975 리뷰 F5): 원천 원장의 변화는 등록·재확인·재결속 PR이 올라가기 전에 판정한다.
// 기본 정책의 근거: 원장 130행·측정 가능한 연속 86쌍에서 65쌍은 완전히 같았고 21쌍은 내용 sha만 바뀌었다(수집 시각 등).
// 행 수 변화는 첫 전체 등록(kric-station-convenience-standard 93→2019) 한 번뿐이었고 커버리지 감소는 없었다.
const POLICY = { schemaVersion: 1, issue: 969, allowContentChange: true, maxRowDeltaRatio: 0.05, allowCoverageDecrease: false, sourceOverrides: {} };
const row = (snapshotId, overrides = {}) => ({
  sourceId: "capital-route-topology", snapshotId, previousSnapshotId: null, rawSha256: "a".repeat(64), contentSha256: "b".repeat(64),
  rowCount: 100, coverageCount: 8, diffSummary: { status: "NO_CHANGE", rowDelta: 0, coverageDelta: 0 }, ...overrides,
});
const BASE = [row("s1")];
const next = (overrides = {}) => row("s2", { previousSnapshotId: "s1", ...overrides });
const evaluate = (headLedger, { policy = POLICY, baseLedger = BASE } = {}) => evaluateLedgerChange({ baseLedger, headLedger, policy });
const codes = (result) => result.violations.map(({ code }) => code);

test("새 행이 직전 head와 같은 내용이면 통과하고 원천별 증거를 남긴다", () => {
  const result = evaluate([...BASE, next({ rawSha256: "c".repeat(64) })]);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.sources, [{
    sourceId: "capital-route-topology", snapshotId: "s2", previousSnapshotId: "s1", rawSha256: "c".repeat(64), contentSha256: "b".repeat(64),
    rowDelta: 0, coverageDelta: 0, diffStatus: "NO_CHANGE",
  }]);
});

test("변경이 없으면 증거도 없고, 첫 등록은 이전 head 없이 FIRST로 남는다", () => {
  assert.deepEqual(evaluate(BASE), { sources: [], violations: [] });
  const first = evaluate([...BASE, row("t1", { sourceId: "other-source", diffSummary: undefined })]);
  assert.deepEqual(first.violations, []);
  assert.deepEqual(first.sources.map(({ previousSnapshotId, rowDelta, coverageDelta, diffStatus }) => [previousSnapshotId, rowDelta, coverageDelta, diffStatus]), [[null, 0, 0, "FIRST"]]);
});

test("내용 sha가 바뀌어도 기본 정책은 허용하되 행 수 변화가 ±5%를 넘으면 SOURCE_COUNT_DELTA다", () => {
  assert.deepEqual(evaluate([...BASE, next({ contentSha256: "d".repeat(64) })]).violations, []);
  // 경계: 5%는 통과, 6%는 위반(행 수 증가·감소 모두)
  assert.deepEqual(evaluate([...BASE, next({ rowCount: 105, diffSummary: { status: "CHANGED", rowDelta: 5, coverageDelta: 0 } })]).violations, []);
  assert.deepEqual(evaluate([...BASE, next({ rowCount: 95, diffSummary: { status: "CHANGED", rowDelta: -5, coverageDelta: 0 } })]).violations, []);
  const grown = evaluate([...BASE, next({ rowCount: 106, diffSummary: { status: "CHANGED", rowDelta: 6, coverageDelta: 0 } })]);
  assert.deepEqual(codes(grown), ["SOURCE_COUNT_DELTA"]);
  assert.match(grown.violations[0].detail, /rowDelta 6 \(6\.0%\) exceeds 5\.0%/u);
  assert.deepEqual(codes(evaluate([...BASE, next({ rowCount: 94, diffSummary: { status: "CHANGED", rowDelta: -6, coverageDelta: 0 } })])), ["SOURCE_COUNT_DELTA"]);
  // 증거에는 위반한 행도 남는다(이슈 본문에 무엇이 멈췄는지 보이게).
  assert.equal(grown.sources[0].rowDelta, 6);
});

test("커버리지가 줄면 SOURCE_COUNT_DELTA이고 늘어나는 것은 막지 않는다", () => {
  const down = evaluate([...BASE, next({ coverageCount: 7, diffSummary: { status: "CHANGED", rowDelta: 0, coverageDelta: -1 } })]);
  assert.deepEqual(codes(down), ["SOURCE_COUNT_DELTA"]);
  assert.match(down.violations[0].detail, /coverageDelta -1/u);
  assert.deepEqual(evaluate([...BASE, next({ coverageCount: 9, diffSummary: { status: "CHANGED", rowDelta: 0, coverageDelta: 1 } })]).violations, []);
  assert.deepEqual(evaluate([...BASE, next({ coverageCount: 7, diffSummary: { status: "CHANGED", rowDelta: 0, coverageDelta: -1 } })], { policy: { ...POLICY, allowCoverageDecrease: true } }).violations, []);
});

test("내용 변경을 막는 정책이면 내용 sha 변화가 SOURCE_SHA_DRIFT이고 원천별 예외가 우선한다", () => {
  const strict = { ...POLICY, allowContentChange: false };
  const changed = [...BASE, next({ contentSha256: "d".repeat(64) })];
  assert.deepEqual(codes(evaluate(changed, { policy: strict })), ["SOURCE_SHA_DRIFT"]);
  assert.deepEqual(evaluate(changed, { policy: { ...strict, sourceOverrides: { "capital-route-topology": { allowContentChange: true } } } }).violations, []);
  // 예외는 그 원천에만 적용된다.
  assert.deepEqual(codes(evaluate(changed, { policy: { ...strict, sourceOverrides: { "other-source": { allowContentChange: true } } } })), ["SOURCE_SHA_DRIFT"]);
  // 원천별 행 수 한도 예외
  const big = [...BASE, next({ rowCount: 130, diffSummary: { status: "CHANGED", rowDelta: 30, coverageDelta: 0 } })];
  assert.deepEqual(codes(evaluate(big)), ["SOURCE_COUNT_DELTA"]);
  assert.deepEqual(evaluate(big, { policy: { ...POLICY, sourceOverrides: { "capital-route-topology": { maxRowDeltaRatio: 0.5 } } } }).violations, []);
});

test("이미 있던 행의 원천 식별(sha·행 수·커버리지·직전 연결)이 바뀌거나 행이 사라지면 막는다", () => {
  for (const [field, value] of [["rawSha256", "e".repeat(64)], ["contentSha256", "e".repeat(64)], ["rowCount", 101], ["coverageCount", 9], ["previousSnapshotId", "s0"]]) {
    assert.deepEqual(codes(evaluate([row("s1", { [field]: value })])), ["SOURCE_SHA_DRIFT"], field);
  }
  // 재결속이 바꾸는 결속 필드(transferTopology 등)는 식별 필드가 아니다.
  assert.deepEqual(evaluate([row("s1", { transferTopology: { canonicalPackSha256: "f".repeat(64) } })]).violations, []);
  assert.deepEqual(codes(evaluate([])), ["BINDING_MISMATCH"]);
});

test("새 행의 필수 필드·직전 연결·diffSummary가 어긋나면 BINDING_MISMATCH다", () => {
  for (const [label, overrides] of [
    ["no contentSha256", { contentSha256: undefined }], ["short rawSha256", { rawSha256: "abc" }], ["no sourceId", { sourceId: undefined }], ["no rowCount", { rowCount: undefined }], ["negative coverage", { coverageCount: -1 }],
    ["fractional rows", { rowCount: 100.5 }],
    ["negative coverage with a matching diffSummary", { coverageCount: -1, diffSummary: { status: "CHANGED", rowDelta: 0, coverageDelta: -9 } }],
    ["negative rows with a matching diffSummary", { rowCount: -1, diffSummary: { status: "CHANGED", rowDelta: -101, coverageDelta: 0 } }], ["unknown previous", { previousSnapshotId: "ghost" }],
    ["diffSummary row delta mismatch", { rowCount: 101, diffSummary: { status: "CHANGED", rowDelta: 0, coverageDelta: 0 } }],
    ["diffSummary coverage delta mismatch", { diffSummary: { status: "NO_CHANGE", rowDelta: 0, coverageDelta: 2 } }],
  ]) assert.ok(codes(evaluate([...BASE, next(overrides)])).includes("BINDING_MISMATCH"), label);
  // 다른 원천의 행을 직전으로 가리키면 안 된다.
  assert.ok(codes(evaluate([...BASE, next({ sourceId: "other-source" })])).includes("BINDING_MISMATCH"));
});

test("정책은 알려진 키와 값만 받는다", () => {
  assert.deepEqual(parseLedgerChangePolicy(POLICY), POLICY);
  for (const bad of [
    null, { ...POLICY, extra: 1 }, { ...POLICY, schemaVersion: 2 }, { ...POLICY, issue: 1 }, { ...POLICY, allowContentChange: "yes" },
    { ...POLICY, maxRowDeltaRatio: -0.1 }, { ...POLICY, maxRowDeltaRatio: 1.5 }, { ...POLICY, maxRowDeltaRatio: "0.05" },
    { ...POLICY, allowCoverageDecrease: null }, { ...POLICY, sourceOverrides: [] }, { ...POLICY, sourceOverrides: { a: { unknown: true } } },
    { ...POLICY, sourceOverrides: { a: { maxRowDeltaRatio: 2 } } }, { ...POLICY, sourceOverrides: { a: null } },
  ]) assert.throws(() => parseLedgerChangePolicy(bad), /LEDGER_CHANGE_POLICY_INVALID/u, JSON.stringify(bad));
  assert.throws(() => evaluateLedgerChange({ baseLedger: [], headLedger: {}, policy: POLICY }), /LEDGER_CHANGE_INPUT_INVALID/u);
});

test("저장소의 기본 정책 파일이 위 기본값과 같다", async () => {
  const policy = JSON.parse(await readFile(path.join(import.meta.dirname, "source-ledger-change-policy.json"), "utf8"));
  assert.deepEqual(parseLedgerChangePolicy(policy), POLICY);
});

function git(cwd, ...args) {
  const result = spawnSync("/usr/bin/git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

test("CLI는 base 커밋의 원장과 작업 트리 원장을 비교해 증거를 쓰고 위반이면 코드와 함께 실패한다", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ledger-gate-")); t.after(() => rm(root, { recursive: true, force: true }));
  const ledgerPath = "tools/datapack/release/source-snapshots.json";
  await mkdir(path.join(root, path.dirname(ledgerPath)), { recursive: true });
  git(root, "init", "-q", "-b", "main"); git(root, "config", "user.name", "t"); git(root, "config", "user.email", "t@example.invalid");
  await writeFile(path.join(root, ledgerPath), `${JSON.stringify(BASE)}\n`);
  git(root, "add", ledgerPath); git(root, "commit", "-q", "-m", "base");
  const baseSha = git(root, "rev-parse", "HEAD");
  const policyFile = path.join(root, "policy.json"); await writeFile(policyFile, JSON.stringify(POLICY));
  const output = path.join(root, "evidence.json");
  const run = (extra = []) => spawnSync(process.execPath, [path.join(import.meta.dirname, "source-ledger-gate.mjs"), "--base-sha", baseSha, "--policy", policyFile, "--output", output, ...extra], { cwd: root, encoding: "utf8" });
  await writeFile(path.join(root, ledgerPath), `${JSON.stringify([...BASE, next()])}\n`);
  const ok = run();
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")).sources.map(({ snapshotId }) => snapshotId), ["s2"]);
  await rm(output);
  await writeFile(path.join(root, ledgerPath), `${JSON.stringify([...BASE, next({ rowCount: 130, diffSummary: { status: "CHANGED", rowDelta: 30, coverageDelta: 0 } })])}\n`);
  const bad = run();
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^SOURCE_COUNT_DELTA: capital-route-topology s2:/mu);
  await assert.rejects(readFile(output, "utf8"), /ENOENT/u);
});
