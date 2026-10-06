import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LEDGER_WRITER_WORKFLOWS,
  REFRESH_CLAIM_PREFIXES,
  claimReflectedInMain,
  evaluateOpenRefreshPullRequest,
  inspectClaimReflection,
  isoDurationMs,
  main,
  openRefreshPullRequestLimitMs,
  staleOpenRefreshPullRequestMessage,
} from "./refresh-open-pr-age.mjs";

// #939: 정기 원천 갱신 workflow는 열린 갱신 PR이 있으면 OPEN_PR로 판단하고 아무것도 하지 않은 채 성공한다.
// 그 PR이 오래 방치되면 원천 갱신이 신호 없이 멈춘다. 상한을 넘기면 job을 실패시켜 #926 실패 이슈 경로로 드러낸다.
const REPOSITORY = "AquilaXk/easysubway-data";
const POLICY = Object.freeze({ monitoring: { manualCheckCadence: "P1D", alertBeforePackExpiry: "PT6H" } });
const NOW = new Date("2026-10-05T12:00:00.000Z");

function pr(overrides = {}) {
  return {
    number: 936,
    url: "https://github.com/AquilaXk/easysubway-data/pull/936",
    createdAt: "2026-10-04T12:00:00.000Z",
    headRefName: "automation/636-current-topology-refresh-37209118635",
    baseRefName: "main",
    isCrossRepository: false,
    ...overrides,
  };
}

test("자동화 workflow의 claim 브랜치 접두어를 고정한다", () => {
  assert.deepEqual(REFRESH_CLAIM_PREFIXES, {
    "current-capital-topology-refresh.yml": "automation/636-current-topology-refresh-",
    "kric-current-facility-refresh.yml": "automation/629-kric-facility-refresh-",
    "retained-gwangju-timetable-refresh.yml": "automation/504-retained-gwangju-timetable-refresh-",
    "seoul-current-accessibility-refresh.yml": "automation/639-seoul-accessibility-refresh-",
    "current-capital-topology-registration.yml": "automation/456-capital-topology-registration-",
    "nationwide-candidate-refresh.yml": "automation/927-nationwide-candidate-refresh-",
    "source-derivative-rebinding.yml": "automation/969-derivative-rebinding-",
    "itx-current-promotion.yml": "automation/977-itx-promotion-",
  });
});

// #969: 원장을 쓰는 자동화 PR은 동시에 하나만 연다. 직렬화 대상은 접두어 목록의 부분집합이어야 하고 후보 갱신은 넣지 않는다.
test("원장을 쓰는 자동화 workflow 목록은 claim 접두어가 있는 workflow의 부분집합이다", () => {
  assert.deepEqual([...LEDGER_WRITER_WORKFLOWS].sort(), Object.keys(REFRESH_CLAIM_PREFIXES).filter((file) => file !== "nationwide-candidate-refresh.yml").sort());
  assert.ok(!LEDGER_WRITER_WORKFLOWS.includes("nationwide-candidate-refresh.yml"));
});

test("상한은 신선도 정책 monitoring.manualCheckCadence(사람이 확인하는 주기)에서 읽는다", () => {
  assert.equal(isoDurationMs("P1D"), 86_400_000);
  assert.equal(isoDurationMs("PT6H"), 21_600_000);
  assert.equal(isoDurationMs("P2DT30M"), 2 * 86_400_000 + 1_800_000);
  for (const invalid of ["", "1D", "P", "PT", "P1W", "P-1D", "P1.5D", null]) {
    assert.throws(() => isoDurationMs(invalid), /REFRESH_OPEN_PR_POLICY_INVALID/, String(invalid));
  }
  assert.equal(openRefreshPullRequestLimitMs(POLICY), 86_400_000);
  assert.throws(() => openRefreshPullRequestLimitMs({ monitoring: {} }), /REFRESH_OPEN_PR_POLICY_INVALID/);
  assert.throws(() => openRefreshPullRequestLimitMs({ monitoring: { manualCheckCadence: "PT0S" } }), /REFRESH_OPEN_PR_POLICY_INVALID/);
});

test("열린 갱신 PR이 상한 안이면 WITHIN_LIMIT, 상한 시각부터 STALE이다", () => {
  const prefix = REFRESH_CLAIM_PREFIXES["current-capital-topology-refresh.yml"];
  const within = evaluateOpenRefreshPullRequest({
    pullRequests: [pr({ createdAt: "2026-10-04T12:00:00.001Z" })], prefix, repository: REPOSITORY, policy: POLICY, now: NOW,
  });
  assert.equal(within.state, "WITHIN_LIMIT");
  assert.equal(within.deadline, "2026-10-05T12:00:00.001Z");
  const stale = evaluateOpenRefreshPullRequest({ pullRequests: [pr()], prefix, repository: REPOSITORY, policy: POLICY, now: NOW });
  assert.deepEqual(stale, {
    state: "STALE",
    number: 936,
    url: "https://github.com/AquilaXk/easysubway-data/pull/936",
    branch: "automation/636-current-topology-refresh-37209118635",
    openedAt: "2026-10-04T12:00:00.000Z",
    limit: "P1D",
    deadline: "2026-10-05T12:00:00.000Z",
  });
});

test("다른 workflow·다른 base·fork PR은 세지 않고, 같은 접두어 PR이 둘 이상이거나 생성 시각이 없으면 실패한다", () => {
  const prefix = REFRESH_CLAIM_PREFIXES["retained-gwangju-timetable-refresh.yml"];
  const others = [
    pr(),
    pr({ number: 1, headRefName: `${prefix}1`, baseRefName: "release" }),
    pr({ number: 2, headRefName: `${prefix}2`, isCrossRepository: true }),
  ];
  assert.deepEqual(evaluateOpenRefreshPullRequest({ pullRequests: others, prefix, repository: REPOSITORY, policy: POLICY, now: NOW }),
    { state: "NONE" });
  assert.throws(() => evaluateOpenRefreshPullRequest({
    pullRequests: [pr({ number: 3, headRefName: `${prefix}3` }), pr({ number: 4, headRefName: `${prefix}4` })],
    prefix, repository: REPOSITORY, policy: POLICY, now: NOW,
  }), /REFRESH_OPEN_PR_DUPLICATE/);
  assert.throws(() => evaluateOpenRefreshPullRequest({
    pullRequests: [pr({ headRefName: `${prefix}5`, createdAt: "yesterday" })], prefix, repository: REPOSITORY, policy: POLICY, now: NOW,
  }), /REFRESH_OPEN_PR_LIST_INVALID/);
  assert.throws(() => evaluateOpenRefreshPullRequest({
    pullRequests: [pr()], prefix: "automation/unknown-", repository: REPOSITORY, policy: POLICY, now: NOW,
  }), /REFRESH_OPEN_PR_PREFIX_INVALID/);
});

// #947 리뷰 F3: snapshotId만 같다고 반영으로 보지 않는다. 원장 행의 원천 식별(rawSha256 등)과,
// claim이 추가·변경한 파일(원천 snapshot, inventory 등)이 main에 그대로 있거나 main이 그 snapshot을 가리키는지까지 본다.
const row = (snapshotId, rawSha256 = `${snapshotId}-raw`) => ({ snapshotId, sourceId: "s", rawSha256, contentSha256: `${snapshotId}-content` });
const bytes = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
const inventory = (...ids) => bytes({ sources: ids.map((snapshotId) => ({ topologyAdmissionEvidence: { snapshotId } })) });
const reflectedFiles = (mainInventory = inventory("b", "c")) => [
  { path: "tools/datapack/sources/b.json", status: "A", base: null, claim: bytes("b-file"), main: bytes("b-file") },
  { path: "tools/datapack/source-inventory.json", status: "M", base: inventory("a"), claim: inventory("b"), main: mainInventory },
];

test("claim이 추가한 원장 행·원천 파일·inventory 참조가 모두 main에 있으면 반영된 것으로 본다", () => {
  const base = [row("a")];
  const claim = [row("a"), row("b")];
  assert.deepEqual(claimReflectedInMain({ baseLedger: base, claimLedger: claim, mainLedger: [...claim, row("c")], files: reflectedFiles() }), {
    reflected: true, addedSnapshotIds: ["b"], missingSnapshotIds: [], mismatchedSnapshotIds: [], unreflectedPaths: [],
  });
});

test("snapshotId가 같아도 원장 행의 rawSha256이 다르면 반영되지 않은 것으로 본다", () => {
  const base = [row("a")];
  const claim = [row("a"), row("b")];
  assert.deepEqual(claimReflectedInMain({ baseLedger: base, claimLedger: claim, mainLedger: [row("a"), row("b", "other-raw")], files: reflectedFiles() }), {
    reflected: false, addedSnapshotIds: ["b"], missingSnapshotIds: [], mismatchedSnapshotIds: ["b"], unreflectedPaths: [],
  });
  assert.deepEqual(claimReflectedInMain({ baseLedger: base, claimLedger: claim, mainLedger: [row("a")], files: reflectedFiles() }).missingSnapshotIds, ["b"]);
});

test("claim이 추가한 원천 파일이 main에 없거나 다르면, 또 main inventory가 claim이 넣은 snapshot을 가리키지 않으면 반영되지 않은 것으로 본다", () => {
  const base = [row("a")];
  const claim = [row("a"), row("b")];
  const ledger = { baseLedger: base, claimLedger: claim, mainLedger: claim };
  const [file, inv] = reflectedFiles();
  assert.deepEqual(claimReflectedInMain({ ...ledger, files: [{ ...file, main: null }, inv] }).unreflectedPaths, [file.path]);
  assert.deepEqual(claimReflectedInMain({ ...ledger, files: [{ ...file, main: bytes("changed") }, inv] }).unreflectedPaths, [file.path]);
  assert.deepEqual(claimReflectedInMain({ ...ledger, files: reflectedFiles(inventory("a")) }).unreflectedPaths, [inv.path]);
  const deleted = { path: "tools/datapack/sources/old.json", status: "D", base: bytes("old"), claim: null, main: bytes("old") };
  assert.deepEqual(claimReflectedInMain({ ...ledger, files: [...reflectedFiles(), deleted] }).unreflectedPaths, [deleted.path]);
  for (const result of [
    claimReflectedInMain({ ...ledger, files: [{ ...file, main: null }, inv] }),
    claimReflectedInMain({ ...ledger, files: reflectedFiles(inventory("a")) }),
  ]) assert.equal(result.reflected, false);
});

test("원장 행을 추가하지 않은 claim은 반영 여부를 판단할 수 없어 반영되지 않은 것으로 보고, 형식이 다르면 실패한다", () => {
  const base = [row("a")];
  assert.equal(claimReflectedInMain({ baseLedger: base, claimLedger: base, mainLedger: base, files: [] }).reflected, false);
  assert.throws(() => claimReflectedInMain({ baseLedger: base, claimLedger: {}, mainLedger: base, files: [] }), /REFRESH_OPEN_PR_LEDGER_INVALID/);
  assert.throws(() => claimReflectedInMain({ baseLedger: base, claimLedger: base, mainLedger: base, files: [{ path: "x", status: "R" }] }),
    /REFRESH_OPEN_PR_FILES_INVALID/);
});

test("상한 초과 메시지는 PR·기한을 밝히고, main에 반영된 claim이면 정리 명령을, 아니면 처리 안내를 넣는다", () => {
  const stale = evaluateOpenRefreshPullRequest({
    pullRequests: [pr()], prefix: REFRESH_CLAIM_PREFIXES["current-capital-topology-refresh.yml"], repository: REPOSITORY, policy: POLICY, now: NOW,
  });
  const reflected = staleOpenRefreshPullRequestMessage({
    stale, repository: REPOSITORY, reflection: { reflected: true, addedSnapshotIds: ["b"], missingSnapshotIds: [], mismatchedSnapshotIds: [], unreflectedPaths: [] },
  });
  assert.match(reflected, /REFRESH_OPEN_PR_STALE: #936 .*2026-10-04T12:00:00.000Z.*P1D.*2026-10-05T12:00:00.000Z/s);
  assert.match(reflected, /gh pr close 936 --repo AquilaXk\/easysubway-data --delete-branch --comment /);
  assert.match(reflected, /git ls-remote --heads https:\/\/github.com\/AquilaXk\/easysubway-data 'refs\/heads\/automation\/636-current-topology-refresh-\*'/);
  const pending = staleOpenRefreshPullRequestMessage({
    stale, repository: REPOSITORY, reflection: { reflected: false, addedSnapshotIds: ["b"], missingSnapshotIds: ["b"], mismatchedSnapshotIds: [], unreflectedPaths: ["tools/datapack/source-inventory.json"] },
  });
  assert.match(pending, /REFRESH_OPEN_PR_STALE: #936/);
  assert.doesNotMatch(pending, /gh pr close/);
  assert.match(pending, /https:\/\/github.com\/AquilaXk\/easysubway-data\/pull\/936/);
});

test("CLI는 OPEN_PR인데 PR이 없으면 실패하고, 상한 안이면 통과하며, 상한을 넘기면 main 반영 판정을 넣어 실패한다", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "refresh-open-pr-age-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const policyPath = path.join(directory, "policy.json");
  writeFileSync(policyPath, JSON.stringify(POLICY));
  const run = (pullRequests, options) => {
    const prsPath = path.join(directory, `prs-${Math.random()}.json`);
    writeFileSync(prsPath, JSON.stringify(pullRequests));
    return main(["--workflow", "current-capital-topology-refresh.yml", "--prs", prsPath, "--policy", policyPath, "--repository", REPOSITORY],
      { now: NOW, ...options });
  };
  // gh pr list의 createdAt은 밀리초 없는 UTC 시각이다.
  await assert.rejects(run([]), /REFRESH_OPEN_PR_MISSING/);
  const logs = [];
  const within = await run([pr({ createdAt: "2026-10-05T00:00:00Z" })], { log: (line) => logs.push(line), inspect: () => assert.fail("no inspect") });
  assert.equal(within.state, "WITHIN_LIMIT");
  assert.match(logs[0], /#936 is within its limit until 2026-10-06T00:00:00.000Z/);
  const inspected = [];
  await assert.rejects(run([pr({ createdAt: "2026-10-04T12:00:00Z" })], {
    inspect: (branch) => { inspected.push(branch); return { reflected: true, addedSnapshotIds: ["b"], missingSnapshotIds: [], mismatchedSnapshotIds: [], unreflectedPaths: [] }; },
  }), /REFRESH_OPEN_PR_STALE: #936[\s\S]*gh pr close 936/);
  assert.deepEqual(inspected, ["automation/636-current-topology-refresh-37209118635"]);
  await assert.rejects(main(["--workflow", "other.yml", "--prs", policyPath, "--policy", policyPath, "--repository", REPOSITORY]),
    /REFRESH_OPEN_PR_WORKFLOW_INVALID/);
});

test("main 반영 판정은 origin의 main·claim 브랜치를 받아 merge-base와 원장·추가 파일·변경 파일을 비교한다", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "refresh-open-pr-git-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const origin = path.join(directory, "origin");
  const clone = path.join(directory, "clone");
  const git = (cwd, ...args) => execFileSync("/usr/bin/git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { cwd, encoding: "utf8" });
  const write = (cwd, relative, value) => {
    mkdirSync(path.dirname(path.join(cwd, relative)), { recursive: true });
    writeFileSync(path.join(cwd, relative), typeof value === "string" ? value : JSON.stringify(value));
    git(cwd, "add", relative);
  };
  const state = (cwd, ids, message) => {
    write(cwd, "tools/datapack/release/source-snapshots.json", ids.map((id) => row(id)));
    write(cwd, "tools/datapack/source-inventory.json", JSON.parse(inventory(...ids).toString()));
    for (const id of ids) write(cwd, `tools/datapack/sources/${id}.json`, `${id}-file`);
    git(cwd, "commit", "-q", "-m", message);
  };
  mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  state(origin, ["a"], "base");
  const branch = "automation/636-current-topology-refresh-1";
  git(origin, "switch", "-q", "-c", branch);
  state(origin, ["a", "b"], "claim");
  git(origin, "switch", "-q", "main");
  // 통합 PR이 squash로 main에 반영한 상황: claim 커밋은 main 조상이 아니지만 원장·파일·inventory에 b가 있다.
  state(origin, ["a", "b", "c"], "integrated");
  git(directory, "clone", "-q", origin, clone);
  assert.deepEqual(inspectClaimReflection(branch, { cwd: clone }), {
    reflected: true, addedSnapshotIds: ["b"], missingSnapshotIds: [], mismatchedSnapshotIds: [], unreflectedPaths: [],
  });
  // main의 원천 파일이 claim과 다르면 반영되지 않은 것으로 본다.
  write(origin, "tools/datapack/sources/b.json", "different");
  git(origin, "commit", "-q", "-m", "diverge");
  const diverged = inspectClaimReflection(branch, { cwd: clone });
  assert.equal(diverged.reflected, false);
  assert.deepEqual(diverged.unreflectedPaths, ["tools/datapack/sources/b.json"]);
});

// #947 리뷰 F2: 상한 초과 메시지에 열린 PR의 required CI 상태도 밝힌다.
test("CLI는 --ci-state를 받아 상한 초과 메시지에 required CI 상태를 넣고, 모르는 상태는 거부한다", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "refresh-open-pr-age-ci-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const policyPath = path.join(directory, "policy.json");
  const prsPath = path.join(directory, "prs.json");
  writeFileSync(policyPath, JSON.stringify(POLICY));
  writeFileSync(prsPath, JSON.stringify([pr()]));
  const args = (state) => ["--workflow", "current-capital-topology-refresh.yml", "--prs", prsPath, "--policy", policyPath, "--repository", REPOSITORY, "--ci-state", state];
  const inspect = () => ({ reflected: false, addedSnapshotIds: ["b"], missingSnapshotIds: ["b"], mismatchedSnapshotIds: [], unreflectedPaths: [] });
  await assert.rejects(main(args("REOPENED"), { now: NOW, inspect }), /Required CI \(pull_request\) on the head: REOPENED/);
  await assert.rejects(main(args("ATTACHED"), { now: NOW, inspect }), /Required CI \(pull_request\) on the head: ATTACHED/);
  await assert.rejects(main(args("UNKNOWN"), { now: NOW, inspect }), /REFRESH_OPEN_PR_CLI/);
});
