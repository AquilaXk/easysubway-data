import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LEDGER_WRITER_WAIT_LIMIT, branchCommitTimes, parseAutomationBranches, pendingLedgerWriters } from "./automation-pr-state.mjs";
import { main } from "./ledger-writers-idle.mjs";

// #974 리뷰 F2·#975 리뷰 F6: 원장을 쓰는 자동화는 한 번에 하나만 진행한다. 열린 PR만이 아니라 PR이 열리기 전의 claim 브랜치(OCI 게시 중)도 진행 중이다.
// 판정과 push 직전 재확인이 같은 규칙을 쓴다.
const REPOSITORY = "AquilaXk/easysubway-data";
const SHA = "d".repeat(40);
const pr = (number, branch, state = "OPEN", overrides = {}) => ({ number, state, isDraft: true, headRefName: branch, baseRefName: "main", isCrossRepository: false, headRepository: { nameWithOwner: REPOSITORY }, ...overrides });
const REGISTRATION = "automation/456-capital-topology-registration-111";
const SEOUL = "automation/639-seoul-accessibility-refresh-222";
const TOPOLOGY = "automation/636-current-topology-refresh-333";
const CANDIDATE = "automation/927-nationwide-candidate-refresh-444";

test("자동화 브랜치 목록은 automation/ 아래 ref만 받고 형식이 어긋나면 실패한다", () => {
  assert.deepEqual(parseAutomationBranches(""), []);
  assert.deepEqual(parseAutomationBranches(`${SHA}\trefs/heads/${REGISTRATION}\n${SHA}\trefs/heads/${CANDIDATE}\n`), [REGISTRATION, CANDIDATE]);
  for (const bad of [`${SHA}\trefs/heads/feat/x\n`, `${SHA}\trefs/tags/automation/x\n`, "garbage\n", `${SHA}\trefs/heads/${REGISTRATION}\n${SHA}\trefs/heads/${REGISTRATION}\n`]) {
    assert.throws(() => parseAutomationBranches(bad), /AUTOMATION_BRANCH_LIST_INVALID/u, JSON.stringify(bad));
  }
});

test("열린 PR과 PR이 없는 원장 쓰기 claim 브랜치가 진행 중이다. 병합된 PR의 브랜치와 후보·사람 브랜치는 아니다", () => {
  const idle = { pullRequests: [], automationBranches: [], repository: REPOSITORY, exceptWorkflow: null };
  assert.deepEqual(pendingLedgerWriters(idle), { pullRequests: [], branches: [] });
  // 열린 PR
  assert.deepEqual(pendingLedgerWriters({ ...idle, pullRequests: [pr(971, SEOUL)], automationBranches: [SEOUL] }), { pullRequests: [971], branches: [] });
  // PR 전의 claim 브랜치(등록 run이 OCI를 게시하는 동안)
  assert.deepEqual(pendingLedgerWriters({ ...idle, automationBranches: [REGISTRATION] }), { pullRequests: [], branches: [REGISTRATION] });
  // 닫힌 PR의 브랜치도 아직 정리되지 않은 진행 흔적이다. 병합된 PR의 브랜치는 끝난 일이다.
  assert.deepEqual(pendingLedgerWriters({ ...idle, pullRequests: [pr(5, REGISTRATION, "CLOSED")], automationBranches: [REGISTRATION] }).branches, [REGISTRATION]);
  assert.deepEqual(pendingLedgerWriters({ ...idle, pullRequests: [pr(5, REGISTRATION, "MERGED")], automationBranches: [REGISTRATION] }), { pullRequests: [], branches: [] });
  // 후보 갱신 브랜치·원장과 무관한 브랜치는 직렬화 대상이 아니다.
  assert.deepEqual(pendingLedgerWriters({ ...idle, pullRequests: [pr(6, CANDIDATE)], automationBranches: [CANDIDATE, "automation/other-1"] }), { pullRequests: [], branches: [] });
  // 다른 저장소·사람 PR
  assert.deepEqual(pendingLedgerWriters({ ...idle, pullRequests: [pr(7, SEOUL, "OPEN", { isCrossRepository: true }), pr(8, "feat/x")] }), { pullRequests: [], branches: [] });
});

test("자기 workflow는 제외하고 정렬된 목록을 돌려준다", () => {
  const input = { pullRequests: [pr(972, TOPOLOGY), pr(971, REGISTRATION)], automationBranches: [TOPOLOGY, REGISTRATION, SEOUL], repository: REPOSITORY };
  assert.deepEqual(pendingLedgerWriters({ ...input, exceptWorkflow: "current-capital-topology-registration.yml" }), { pullRequests: [972], branches: [SEOUL] });
  assert.deepEqual(pendingLedgerWriters({ ...input, exceptWorkflow: null }), { pullRequests: [971, 972], branches: [SEOUL] });
  assert.throws(() => pendingLedgerWriters({ ...input, exceptWorkflow: 5 }), /AUTOMATION_PR_STATE_INPUT_INVALID/u);
  assert.throws(() => pendingLedgerWriters({ ...input, pullRequests: null }), /AUTOMATION_PR_STATE_INPUT_INVALID/u);
});

test("CLI는 대기 중인 쓰기 자동화가 없으면 idle=true, 있으면 idle=false와 대기 목록을 남긴다(실패가 아니다)", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ledger-writers-idle-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = (name) => path.join(directory, name);
  const run = async (prs, branches, extra = []) => {
    await writeFile(file("prs.json"), JSON.stringify(prs)); await writeFile(file("branches.txt"), branches.map((branch) => `${SHA}\trefs/heads/${branch}\n`).join(""));
    await rm(file("out.txt"), { force: true });
    await main(["--repository", REPOSITORY, "--prs", file("prs.json"), "--automation-branches", file("branches.txt"), "--github-output", file("out.txt"), ...extra], { log: () => {} });
    return Object.fromEntries((await readFile(file("out.txt"), "utf8")).split("\n").filter(Boolean).map((line) => line.split(/=(.*)/su).slice(0, 2)));
  };
  assert.deepEqual(await run([], []), { idle: "true", blocked_by: "" });
  assert.deepEqual(await run([pr(971, SEOUL)], [SEOUL, REGISTRATION]), { idle: "false", blocked_by: `971,${REGISTRATION}` });
  assert.deepEqual(await run([pr(972, REGISTRATION)], [REGISTRATION], ["--except-workflow", "current-capital-topology-registration.yml"]), { idle: "true", blocked_by: "" });
  await assert.rejects(main(["--repository", REPOSITORY]), /AUTOMATION_PR_STATE_INPUT_INVALID/u);
});

// #1032: 원장 쓰기 자동화가 스스로 멈춰도(서울 claim의 사람 확인 대기, 3회 재생성 상한에 걸린 광주 PR) 후보 갱신이 영구히 기다리지 않는다.
// 대기에는 상한이 있다. 정상 갱신 PR은 약 20분 안에 병합되므로 상한을 넘긴 대상은 멈춘 것이고, 그 대상의 보고는 소유 workflow의 실패 보고(#926)가 맡는다.
const HOUR = 3_600_000;
const NOW = new Date("2026-10-07T23:00:00.000Z");
const ago = (milliseconds) => new Date(NOW.getTime() - milliseconds).toISOString();
const GWANGJU = "automation/504-retained-gwangju-timetable-refresh-555";
const waiting = (overrides = {}) => ({
  pullRequests: [pr(1019, GWANGJU)], automationBranches: [GWANGJU, SEOUL], repository: REPOSITORY, exceptWorkflow: null,
  maxAgeMs: 2 * HOUR, now: NOW, branchTimes: { [GWANGJU]: ago(3 * HOUR), [SEOUL]: ago(3.5 * HOUR) }, ...overrides,
});

test("대기 상한을 넘긴 열린 PR과 claim 브랜치는 기다리지 않고 expired로 알린다", () => {
  assert.equal(LEDGER_WRITER_WAIT_LIMIT, "PT2H");
  assert.deepEqual(pendingLedgerWriters(waiting()), {
    pullRequests: [], branches: [],
    expired: [{ blocker: 1019, branch: GWANGJU, ageMs: 3 * HOUR }, { blocker: SEOUL, branch: SEOUL, ageMs: 3.5 * HOUR }],
  });
  // 상한 안의 대상은 기다린다. 상한과 같은 나이는 아직 기다리고 1ms 넘으면 멈춘 것이다.
  assert.deepEqual(pendingLedgerWriters(waiting({ branchTimes: { [GWANGJU]: ago(20 * 60_000), [SEOUL]: ago(2 * HOUR) } })), { pullRequests: [1019], branches: [SEOUL], expired: [] });
  assert.deepEqual(pendingLedgerWriters(waiting({ branchTimes: { [GWANGJU]: ago(2 * HOUR + 1), [SEOUL]: ago(2 * HOUR) } })).expired.map(({ blocker }) => blocker), [1019]);
  // 일부만 멈췄으면 나머지는 계속 기다린다.
  assert.deepEqual(pendingLedgerWriters(waiting({ branchTimes: { [GWANGJU]: ago(10 * 60_000), [SEOUL]: ago(5 * HOUR) } })), {
    pullRequests: [1019], branches: [], expired: [{ blocker: SEOUL, branch: SEOUL, ageMs: 5 * HOUR }],
  });
});

test("나이를 알 수 없거나 미래인 대상은 증거가 없으므로 기다리고, 잘못된 입력은 실패한다", () => {
  // 시각이 없는 대상(방금 만들어져 아직 받지 못한 브랜치)은 무시하지 않는다.
  assert.deepEqual(pendingLedgerWriters(waiting({ branchTimes: {} })), { pullRequests: [1019], branches: [SEOUL], expired: [] });
  assert.deepEqual(pendingLedgerWriters(waiting({ branchTimes: { [GWANGJU]: null, [SEOUL]: ago(-HOUR) } })), { pullRequests: [1019], branches: [SEOUL], expired: [] });
  for (const bad of [{ maxAgeMs: 0 }, { maxAgeMs: -1 }, { maxAgeMs: "PT2H" }, { now: "2026-10-07" }, { now: undefined }, { branchTimes: undefined }, { branchTimes: { [GWANGJU]: "not a time", [SEOUL]: ago(HOUR) } }]) {
    assert.throws(() => pendingLedgerWriters(waiting(bad)), /AUTOMATION_PR_STATE_INPUT_INVALID/u, JSON.stringify(bad));
  }
  // 상한을 주지 않으면 지금처럼 모두 기다리고 expired 항목 자체가 없다.
  const { maxAgeMs: _limit, now: _now, branchTimes: _times, ...strict } = waiting();
  assert.deepEqual(pendingLedgerWriters(strict), { pullRequests: [1019], branches: [SEOUL] });
});

test("브랜치 커밋 시각은 로컬 origin ref의 committer date를 UTC로 바꿔 읽고 없는 ref는 모른다고 답한다", async () => {
  const calls = [];
  const runGit = async (args) => {
    calls.push(args);
    return { [`refs/remotes/origin/${SEOUL}`]: "2026-10-08T04:19:20+09:00\n", [`refs/remotes/origin/${GWANGJU}`]: "" }[args.at(-1)] ?? "";
  };
  assert.deepEqual(await branchCommitTimes({ branches: [SEOUL, GWANGJU], runGit }), { [SEOUL]: "2026-10-07T19:19:20.000Z" });
  assert.deepEqual(calls[0], ["for-each-ref", "--format=%(committerdate:iso-strict)", `refs/remotes/origin/${SEOUL}`]);
  assert.deepEqual(await branchCommitTimes({ branches: [], runGit }), {});
  await assert.rejects(branchCommitTimes({ branches: ["automation/x;rm -rf"], runGit }), /AUTOMATION_PR_STATE_INPUT_INVALID/u);
  await assert.rejects(branchCommitTimes({ branches: [SEOUL], runGit: async () => "garbage\n" }), /AUTOMATION_PR_STATE_INPUT_INVALID/u);
  // git 오류는 모른다고 덮지 않고 그대로 실패한다.
  await assert.rejects(branchCommitTimes({ branches: [SEOUL], runGit: async () => { throw new Error("git failed"); } }), /git failed/u);
});

test("CLI는 --max-age를 주면 상한을 넘긴 대상을 기다리지 않고 expired_blockers로 남긴다", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ledger-writers-idle-age-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = (name) => path.join(directory, name);
  const times = { [SEOUL]: "2026-10-07T19:19:20+00:00", [GWANGJU]: "2026-10-07T22:50:00+00:00" };
  const runGit = async (args) => (times[args.at(-1).replace("refs/remotes/origin/", "")] ?? "");
  const run = async (extra) => {
    await writeFile(file("prs.json"), JSON.stringify([pr(1019, GWANGJU)])); await writeFile(file("branches.txt"), [GWANGJU, SEOUL].map((branch) => `${SHA}\trefs/heads/${branch}\n`).join(""));
    await rm(file("out.txt"), { force: true });
    await main(["--repository", REPOSITORY, "--prs", file("prs.json"), "--automation-branches", file("branches.txt"), "--github-output", file("out.txt"), ...extra], { log: () => {}, runGit, now: () => NOW });
    return Object.fromEntries((await readFile(file("out.txt"), "utf8")).split("\n").filter(Boolean).map((line) => line.split(/=(.*)/su).slice(0, 2)));
  };
  // 서울 claim은 3시간 40분, 광주 PR은 10분 됐다: 광주가 있으니 아직 idle이 아니지만 서울은 기다리지 않는다.
  assert.deepEqual(await run(["--max-age", "PT2H"]), { idle: "false", blocked_by: "1019", expired_blockers: SEOUL });
  assert.deepEqual(await run([]), { idle: "false", blocked_by: `1019,${SEOUL}` });
  times[GWANGJU] = "2026-10-07T20:00:00+00:00";
  assert.deepEqual(await run(["--max-age", "PT2H"]), { idle: "true", blocked_by: "", expired_blockers: `1019,${SEOUL}` });
  await assert.rejects(run(["--max-age", "2h"]), /REFRESH_OPEN_PR_POLICY_INVALID/u);
});
