import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { assertFailureReportLast, assertNoExpressionInRunScripts, assertOpenPullRequestSteps, ifCondition, loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";

// #969 P4: 파생 재결속 workflow 계약. 원장·정본 팩이 main에서 바뀌면(또는 정기 복구로) controller가 파생 산출물을 다시 만들고,
// 바뀐 것이 있을 때만 App 토큰 PR 하나로 올린다. 변경이 없으면 PR도 만들지 않는다. 변수가 꺼져 있으면 push·정기 실행은 건너뛴다.
const FILE = "source-derivative-rebinding.yml";
const { yml, steps, step } = loadWorkflow(path.resolve(import.meta.dirname, "../.."), FILE);
const RUN = "${{ steps.decision.outputs.state == 'RUN' }}";
const CHANGED = "${{ steps.decision.outputs.state == 'RUN' && steps.rebind.outputs.changed == 'true' }}";
const IDLE = "${{ steps.decision.outputs.state == 'RUN' && steps.rebind.outputs.changed == 'true' && steps.recheck.outputs.idle == 'true' }}";
const PUSHED = "${{ steps.decision.outputs.state == 'RUN' && steps.rebind.outputs.changed == 'true' && steps.recheck.outputs.idle == 'true' && steps.push.outputs.pushed == 'true' }}";

test("트리거: 원장·정본 팩 push, 정기 복구, 사람 dispatch", () => {
  assert.match(yml, /^on:\n  push:\n    branches:\n      - main\n    paths:\n      - tools\/datapack\/release\/source-snapshots\.json\n      - tools\/datapack\/release\/capital-production-canonical-pack\.json\n  schedule:\n    - cron: "41 \*\/6 \* \* \*"\n  workflow_dispatch:\n/mu);
});

test("권한은 job에만 주고 변수가 true일 때만 push·정기 실행이 돈다", () => {
  assert.match(yml, /\npermissions: \{\}\n/u);
  assert.equal((yml.match(/\n    permissions:\n/gu) ?? []).length, 1);
  assert.match(yml, /\n    permissions:\n      contents: write\n      pull-requests: write\n      issues: write\n/u);
  assert.doesNotMatch(yml, /actions: write|gh workflow run|repository_dispatch/u);
  assert.match(yml, /\n    if: \$\{\{ github\.ref == 'refs\/heads\/main' && \(github\.event_name == 'workflow_dispatch' \|\| vars\.DATAPACK_SCHEDULED_SOURCE_REBINDING == 'true'\) \}\}\n/u);
  assert.match(yml, /\n    environment: datapack-release-check\n/u);
});

test("판정 step이 controller보다 먼저 돌고 열린 PR·브랜치만 읽는다", () => {
  const all = steps();
  const decision = all.findIndex(({ name }) => name === "Decide whether derivative rebinding may run");
  const rebind = all.findIndex(({ name }) => name === "Rebind derivative artifacts from the current ledger heads");
  assert.ok(decision !== -1 && decision < rebind);
  const { block } = all[decision];
  assert.match(block, /\n        id: decision\n/u);
  assert.match(block, /gh pr list --repo "\$\{GITHUB_REPOSITORY\}" --state all --limit 1000 --json number,state,isDraft,headRefName,baseRefName,headRepository,isCrossRepository > /u);
  assert.match(block, /git ls-remote --heads origin "refs\/heads\/automation\/969-derivative-rebinding-\*" > /u);
  assert.match(block, /git ls-remote --heads origin "refs\/heads\/automation\/\*" > /u);
  assert.match(block, /node tools\/ci\/decide-derivative-rebinding\.mjs --repository "\$\{GITHUB_REPOSITORY\}" --prs "[^"]+" --branches "[^"]+" --automation-branches "[^"]+" --github-output "\$\{GITHUB_OUTPUT\}"/u);
});

test("controller는 RUN일 때만 돌고 OCI 읽기 주소는 시크릿에서만 받으며, 바뀐 것이 없으면 이유를 notice로 남긴다", () => {
  const rebind = step("Rebind derivative artifacts from the current ledger heads");
  assert.equal(ifCondition(rebind.block), RUN);
  assert.match(rebind.block, /\n        id: rebind\n/u);
  assert.match(rebind.block, /EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: \$\{\{ secrets\.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL \}\}/u);
  assert.match(rebind.block, /operation="\$\{RUNNER_TEMP\}\/derivative-rebinding\/\$\{GITHUB_RUN_ID\}"/u);
  assert.match(rebind.block, /node tools\/datapack\/run-derivative-rebinding\.mjs --operation-root "\$\{operation\}\/operation" > "\$\{operation\}\/result\.json"/u);
  assert.match(rebind.block, /git config user\.name "github-actions\[bot\]"/u);
  assert.match(rebind.block, /changed=/u);
  const note = step("Note derivative bindings are already current");
  assert.equal(ifCondition(note.block), "${{ steps.decision.outputs.state == 'RUN' && steps.rebind.outputs.changed == 'false' }}");
});

test("push·App 토큰·PR 생성·정리는 바뀐 것이 있을 때만 돌고 push는 GITHUB_TOKEN, PR 생성만 App 토큰이다", () => {
  assert.equal(ifCondition(step("Verify the rebinding is based on the current main and push its branch").block), IDLE);
  for (const name of ["Mint App token for the derivative rebinding pull request", "Create derivative rebinding pull request"]) {
    assert.equal(ifCondition(step(name).block), PUSHED, name);
  }
  const push = step("Verify the rebinding is based on the current main and push its branch");
  assert.match(push.block, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(push.block, /branch="automation\/969-derivative-rebinding-\$\{GITHUB_RUN_ID\}"/u);
  assert.match(push.block, /git push origin "\$\{branch\}"/u);
  assert.match(push.block, /main moved/u);
  assert.doesNotMatch(push.block, /git add/u);
  const pr = step("Create derivative rebinding pull request");
  assert.match(pr.block, /GH_TOKEN="\$\{APP_PR_TOKEN\}" gh pr create --repo "\$\{GITHUB_REPOSITORY\}" --draft --base main --head "\$\{REBINDING_BRANCH\}"/u);
  assert.match(pr.block, /node tools\/ci\/automation-pr-evidence\.mjs derivative-rebinding-body --gate /u);
  assert.match(pr.block, /APP_PR_TOKEN: \$\{\{ steps\.app-token-pr\.outputs\.token \}\}/u);
  const cleanup = step("Remove the rebinding branch after a later failure");
  // #975 리뷰 F7: 취소·시간 초과에도 이 run이 push한 branch와 PR을 정리한다.
  assert.equal(ifCondition(cleanup.block), "${{ (failure() || cancelled()) && env.REBINDING_BRANCH != '' }}");
});

test("OPEN_PR이면 App 토큰 → required CI 보장 → 열린 PR 상한 검사 순서로 돈다", () => {
  assertOpenPullRequestSteps({ steps, file: FILE, decisionName: "Decide whether derivative rebinding may run" });
});

test("원장 쓰기 PR 때문에 기다리는 실행은 이유를 notice로 남기고, 실패 보고가 마지막 step이다", () => {
  const wait = step("Note derivative rebinding waiting on a pending source pull request");
  assert.equal(ifCondition(wait.block), "${{ steps.decision.outputs.state == 'BLOCKED_BY_PENDING_PR' }}");
  assert.match(wait.block, /steps\.decision\.outputs\.blocked_by/u);
  assertFailureReportLast({ yml, step, file: FILE, condition: "${{ failure() || cancelled() }}" });
});

// #975 리뷰 F7·이슈 #973: 이전 실행이 남긴 재결속 브랜치(PR 없음·닫힌 PR)는 판정이 알려 주고 이번 실행이 지운다.
test("판정이 알린 남은 재결속 브랜치는 controller 전에 지운다", () => {
  const cleanup = step("Remove stale rebinding branches named by the decision");
  assert.equal(ifCondition(cleanup.block), "${{ steps.decision.outputs.cleanup_branches != '' }}");
  assert.match(cleanup.block, /CLEANUP_BRANCHES: \$\{\{ steps\.decision\.outputs\.cleanup_branches \}\}/u);
  assert.match(cleanup.block, /\^automation\/969-derivative-rebinding-\[1-9\]\[0-9\]\*\$/u);
  assert.match(cleanup.block, /git push origin --delete "\$\{stale_branch\}"/u);
  const names = steps().map(({ name }) => name);
  assert.ok(names.indexOf("Decide whether derivative rebinding may run") < names.indexOf(cleanup.name));
  assert.ok(names.indexOf(cleanup.name) < names.indexOf("Rebind derivative artifacts from the current ledger heads"));
});

// #975 리뷰 F7·#972/#974 리뷰: step output은 env로만 받는다.
test("run 스크립트에는 표현식을 직접 넣지 않고 env로만 받는다", () => {
  assertNoExpressionInRunScripts({ steps, file: FILE });
  assert.match(step("Note derivative rebinding waiting on a pending source pull request").block, /\n          BLOCKED_BY: \$\{\{ steps\.decision\.outputs\.blocked_by \}\}\n/u);
});

// #975 리뷰 F4: push 뒤 병합이 연달아 일어나는 것은 이 체인의 정상 경로다. 읽은 main이 움직였으면 이상이 아니라 SUPERSEDED로 끝내고 새 실행에 맡긴다.
test("읽은 main이 움직였으면 아무것도 올리지 않고 notice로 끝낸다(이슈 아님)", () => {
  const push = step("Verify the rebinding is based on the current main and push its branch");
  assert.match(push.block, /\n        id: push\n/u);
  assert.match(push.block, /::notice title=Derivative rebinding::main moved/u);
  assert.match(push.block, /echo "pushed=false" >> "\$\{GITHUB_OUTPUT\}"\n\s+exit 0/u);
  assert.match(push.block, /echo "pushed=true" >> "\$\{GITHUB_OUTPUT\}"/u);
  assert.doesNotMatch(yml, /BINDING_BASE_MOVED/u);
  const note = step("Note rebinding superseded by a newer main");
  assert.equal(ifCondition(note.block), "${{ steps.decision.outputs.state == 'RUN' && steps.rebind.outputs.changed == 'true' && steps.recheck.outputs.idle == 'true' && steps.push.outputs.pushed == 'false' }}");
});

// #975 리뷰 F5·F6: controller가 만든 원장 변화는 gate를 통과해야 하고, push 직전에 원장 쓰기 자동화(등록 claim 포함)가 없는지 다시 확인한다. 본문은 base/head에 결속된다.
test("원장 변화 게이트와 push 직전 재확인과 증거 본문", () => {
  const rebind = step("Rebind derivative artifacts from the current ledger heads").block;
  assert.match(rebind, /node tools\/ci\/source-ledger-gate\.mjs --base-sha "\$\{base_sha\}" --output "\$\{operation\}\/gate\.json"/u);
  assert.ok(rebind.indexOf("run-derivative-rebinding.mjs") < rebind.indexOf("source-ledger-gate.mjs"), "the gate runs on the controller's commits");
  const recheck = step("Recheck that no source-ledger automation is pending before pushing");
  assert.match(recheck.block, /\n        id: recheck\n/u);
  assert.equal(ifCondition(recheck.block), CHANGED);
  assert.match(recheck.block, /node tools\/ci\/ledger-writers-idle\.mjs --repository "\$\{GITHUB_REPOSITORY\}" --prs "[^"]+" --automation-branches "[^"]+" --except-workflow source-derivative-rebinding\.yml --github-output "\$\{GITHUB_OUTPUT\}"/u);
  const names = steps().map(({ name }) => name);
  assert.ok(names.indexOf(recheck.name) < names.indexOf("Verify the rebinding is based on the current main and push its branch"));
  const note = step("Note rebinding superseded by pending source automation");
  assert.equal(ifCondition(note.block), "${{ steps.decision.outputs.state == 'RUN' && steps.rebind.outputs.changed == 'true' && steps.recheck.outputs.idle == 'false' }}");
  const create = step("Create derivative rebinding pull request").block;
  assert.match(create, /node tools\/ci\/automation-pr-evidence\.mjs derivative-rebinding-body --gate "\$\{RUNNER_TEMP\}\/derivative-rebinding\/\$\{GITHUB_RUN_ID\}\/gate\.json" --result "\$\{REBINDING_RESULT\}" --base-sha "\$\{REBINDING_BASE_SHA\}" --head-sha "\$\{REBINDING_HEAD_SHA\}"/u);
  assert.match(rebind, /printf 'REBINDING_HEAD_SHA=%s\\n' "\$\(git rev-parse HEAD\)" >> "\$\{GITHUB_ENV\}"/u);
});
