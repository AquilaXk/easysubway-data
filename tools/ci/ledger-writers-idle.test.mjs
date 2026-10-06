import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseAutomationBranches, pendingLedgerWriters } from "./automation-pr-state.mjs";
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
