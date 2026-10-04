import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
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

test("갱신 workflow 4종의 claim 브랜치 접두어를 고정한다", () => {
  assert.deepEqual(REFRESH_CLAIM_PREFIXES, {
    "current-capital-topology-refresh.yml": "automation/636-current-topology-refresh-",
    "kric-current-facility-refresh.yml": "automation/629-kric-facility-refresh-",
    "retained-gwangju-timetable-refresh.yml": "automation/504-retained-gwangju-timetable-refresh-",
    "seoul-current-accessibility-refresh.yml": "automation/639-seoul-accessibility-refresh-",
  });
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

test("claim 브랜치가 추가한 원장 행이 모두 main 원장에 있으면 main에 반영된 것으로 본다", () => {
  const base = [{ snapshotId: "a" }];
  const claim = [{ snapshotId: "a" }, { snapshotId: "b" }, { snapshotId: "c" }];
  assert.deepEqual(claimReflectedInMain({ baseLedger: base, claimLedger: claim, mainLedger: [...claim, { snapshotId: "d" }] }),
    { reflected: true, addedSnapshotIds: ["b", "c"], missingSnapshotIds: [] });
  assert.deepEqual(claimReflectedInMain({ baseLedger: base, claimLedger: claim, mainLedger: [{ snapshotId: "a" }, { snapshotId: "b" }] }),
    { reflected: false, addedSnapshotIds: ["b", "c"], missingSnapshotIds: ["c"] });
  // 원장 행을 추가하지 않은 claim(빈 claim 등)은 반영 여부를 판단할 수 없으므로 반영되지 않은 것으로 본다.
  assert.deepEqual(claimReflectedInMain({ baseLedger: base, claimLedger: base, mainLedger: claim }),
    { reflected: false, addedSnapshotIds: [], missingSnapshotIds: [] });
  assert.throws(() => claimReflectedInMain({ baseLedger: base, claimLedger: {}, mainLedger: claim }), /REFRESH_OPEN_PR_LEDGER_INVALID/);
});

test("상한 초과 메시지는 PR·기한을 밝히고, main에 반영된 claim이면 정리 명령을, 아니면 처리 안내를 넣는다", () => {
  const stale = evaluateOpenRefreshPullRequest({
    pullRequests: [pr()], prefix: REFRESH_CLAIM_PREFIXES["current-capital-topology-refresh.yml"], repository: REPOSITORY, policy: POLICY, now: NOW,
  });
  const reflected = staleOpenRefreshPullRequestMessage({
    stale, repository: REPOSITORY, reflection: { reflected: true, addedSnapshotIds: ["b"], missingSnapshotIds: [] },
  });
  assert.match(reflected, /REFRESH_OPEN_PR_STALE: #936 .*2026-10-04T12:00:00.000Z.*P1D.*2026-10-05T12:00:00.000Z/s);
  assert.match(reflected, /gh pr close 936 --repo AquilaXk\/easysubway-data --delete-branch --comment /);
  assert.match(reflected, /git ls-remote --heads https:\/\/github.com\/AquilaXk\/easysubway-data 'refs\/heads\/automation\/636-current-topology-refresh-\*'/);
  const pending = staleOpenRefreshPullRequestMessage({
    stale, repository: REPOSITORY, reflection: { reflected: false, addedSnapshotIds: ["b"], missingSnapshotIds: ["b"] },
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
    inspect: (branch) => { inspected.push(branch); return { reflected: true, addedSnapshotIds: ["b"], missingSnapshotIds: [] }; },
  }), /REFRESH_OPEN_PR_STALE: #936[\s\S]*gh pr close 936/);
  assert.deepEqual(inspected, ["automation/636-current-topology-refresh-37209118635"]);
  await assert.rejects(main(["--workflow", "other.yml", "--prs", policyPath, "--policy", policyPath, "--repository", REPOSITORY]),
    /REFRESH_OPEN_PR_WORKFLOW_INVALID/);
});

test("main 반영 판정은 origin의 main·claim 브랜치를 받아 merge-base와 두 원장을 비교한다", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "refresh-open-pr-git-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const origin = path.join(directory, "origin");
  const clone = path.join(directory, "clone");
  const git = (cwd, ...args) => execFileSync("/usr/bin/git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { cwd, encoding: "utf8" });
  const ledger = (cwd, ids) => {
    mkdirSync(path.join(cwd, "tools/datapack/release"), { recursive: true });
    writeFileSync(path.join(cwd, "tools/datapack/release/source-snapshots.json"), JSON.stringify(ids.map((snapshotId) => ({ snapshotId }))));
    git(cwd, "add", "tools/datapack/release/source-snapshots.json");
    git(cwd, "commit", "-q", "-m", ids.join(","));
  };
  mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  ledger(origin, ["a"]);
  const branch = "automation/636-current-topology-refresh-1";
  git(origin, "switch", "-q", "-c", branch);
  ledger(origin, ["a", "b"]);
  git(origin, "switch", "-q", "main");
  // 통합 PR이 squash로 main에 반영한 상황: claim 커밋은 main 조상이 아니지만 원장에는 b가 있다.
  ledger(origin, ["a", "b", "c"]);
  git(directory, "clone", "-q", origin, clone);
  assert.deepEqual(inspectClaimReflection(branch, { cwd: clone }), { reflected: true, addedSnapshotIds: ["b"], missingSnapshotIds: [] });
  git(origin, "switch", "-q", branch);
  ledger(origin, ["a", "b", "d"]);
  assert.deepEqual(inspectClaimReflection(branch, { cwd: clone }), { reflected: false, addedSnapshotIds: ["b", "d"], missingSnapshotIds: ["d"] });
});

// #947 리뷰 F5: createdAt은 달력에 있는 UTC 시각이어야 한다. 엔진이 넘겨 계산하는 날짜를 받지 않는다.
test("열린 PR 생성 시각은 존재하지 않는 날짜·시각을 거부한다", () => {
  const prefix = REFRESH_CLAIM_PREFIXES["current-capital-topology-refresh.yml"];
  for (const createdAt of ["2026-02-30T00:00:00Z", "2026-02-29T00:00:00Z", "2026-13-01T00:00:00Z", "2026-10-04T24:00:00Z", "2026-10-04T12:60:00Z"]) {
    assert.throws(() => evaluateOpenRefreshPullRequest({
      pullRequests: [pr({ createdAt })], prefix, repository: REPOSITORY, policy: POLICY, now: NOW,
    }), /REFRESH_OPEN_PR_LIST_INVALID: createdAt/, createdAt);
  }
  assert.equal(evaluateOpenRefreshPullRequest({
    pullRequests: [pr({ createdAt: "2028-02-29T00:00:00Z" })], prefix, repository: REPOSITORY, policy: POLICY, now: new Date("2028-02-29T01:00:00Z"),
  }).state, "WITHIN_LIMIT");
});
