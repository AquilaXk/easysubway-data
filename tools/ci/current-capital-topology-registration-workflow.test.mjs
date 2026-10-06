import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { assertFailureReportLast, assertOpenPullRequestSteps, ifCondition, loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";

// #969 P3: 수도권 topology 등록 workflow 계약.
// 갱신 PR이 병합되면 사람이 dispatch하지 않아도 등록이 PR까지 이어진다. 정기·push 실행은 저장소 변수가 켜졌을 때만 돈다.
// 판정(REGISTER·RECOVER_CLAIM·OPEN_PR·BLOCKED_BY_PENDING_PR·REGISTERED)이 모든 쓰기 step을 가르고, 이상은 실패 이슈로 드러난다.
const FILE = "current-capital-topology-registration.yml";
const { yml, steps, step } = loadWorkflow(path.resolve(import.meta.dirname, "../.."), FILE);
const WRITES = "${{ steps.decision.outputs.state == 'REGISTER' || steps.decision.outputs.state == 'RECOVER_CLAIM' }}";

test("트리거: 수도권 topology 활성화 산출 경로 push, 정기 복구 실행, 사람 dispatch(복구 run 입력 유지)", () => {
  assert.match(yml, /^on:\n  push:\n    branches:\n      - main\n    paths:\n      - tools\/datapack\/sources\/capital-route-topology-\*\.json\n      - tools\/datapack\/release\/capital-topology-reverification-\*\.json\n  schedule:\n    - cron: "5 \*\/2 \* \* \*"\n  workflow_dispatch:\n    inputs:\n      recovery_run_id:\n/mu);
});

test("권한은 workflow 전체가 아니라 job에만 준다(issues 쓰기는 실패 보고용)", () => {
  assert.match(yml, /\npermissions: \{\}\n/u);
  assert.equal((yml.match(/\n    permissions:\n/gu) ?? []).length, 1);
  assert.match(yml, /\n    permissions:\n      actions: read\n      contents: write\n      pull-requests: write\n      issues: write\n/u);
});

test("push·정기 실행은 저장소 변수가 true일 때만 돌고 사람 dispatch는 항상 돈다", () => {
  assert.match(yml, /\n    if: \$\{\{ github\.ref == 'refs\/heads\/main' && \(github\.event_name == 'workflow_dispatch' \|\| vars\.DATAPACK_SCHEDULED_SOURCE_REGISTRATION == 'true'\) \}\}\n/u);
});

test("판정 step이 claim·게시·PR 생성보다 먼저 돌고 판정 입력을 저장소·GitHub 기록에서만 읽는다", () => {
  const all = steps();
  const decision = all.findIndex(({ name }) => name === "Decide whether capital topology registration is needed");
  const claim = all.findIndex(({ name }) => name === "Claim exact main before OCI publication");
  assert.ok(decision !== -1 && decision < claim);
  const { block } = all[decision];
  assert.match(block, /\n        id: decision\n/u);
  assert.match(block, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(block, /RECOVERY_RUN_ID: \$\{\{ inputs\.recovery_run_id \}\}/u);
  assert.match(block, /gh pr list --repo "\$\{GITHUB_REPOSITORY\}" --state all --limit 1000 --json number,state,isDraft,headRefName,baseRefName,headRepository,isCrossRepository > /u);
  assert.match(block, /git ls-remote --heads origin "refs\/heads\/automation\/456-capital-topology-registration-\*" > /u);
  assert.match(block, /gh run list --repo "\$\{GITHUB_REPOSITORY\}" --workflow current-capital-topology-registration\.yml --limit 200 --json databaseId,status,conclusion,workflowName,headBranch,headSha > /u);
  assert.match(block, /node tools\/ci\/decide-capital-topology-registration\.mjs --inventory tools\/datapack\/source-inventory\.json --ledger tools\/datapack\/release\/source-snapshots\.json /u);
  assert.match(block, /--current-main-sha "\$\{main_sha\}" --github-output "\$\{GITHUB_OUTPUT\}"/u);
  // 판정 시점의 checkout이 아직 main이어야 한다. 그 사이 main이 움직였으면 새 push가 자기 판정을 한다.
  assert.match(block, /git ls-remote origin refs\/heads\/main/u);
  assert.match(block, /state=SUPERSEDED/u);
});

test("claim·게시·복구·App 토큰·PR 생성은 REGISTER 또는 RECOVER_CLAIM일 때만 돌고, 게시와 복구는 서로 배타적이다", () => {
  for (const name of ["Claim exact main before OCI publication", "Mint App token for the registration pull request", "Commit exactly four registration outputs and open draft PR"]) {
    assert.equal(ifCondition(step(name).block), WRITES, name);
  }
  assert.equal(ifCondition(step("Publish and register once").block), "${{ steps.decision.outputs.state == 'REGISTER' }}");
  assert.equal(ifCondition(step("Recover published registration without OCI").block), "${{ steps.decision.outputs.state == 'RECOVER_CLAIM' }}");
  assert.doesNotMatch(yml, /inputs\.recovery_run_id == ''/u);
  assert.doesNotMatch(yml, /inputs\.recovery_run_id != ''/u);
});

test("복구 run id는 사람 입력 또는 판정 결과에서만 받고, producer run의 이벤트는 dispatch·push·schedule을 받는다", () => {
  const { block } = step("Claim exact main before OCI publication");
  assert.match(block, /RECOVERY_RUN_ID: \$\{\{ steps\.decision\.outputs\.recovery_run_id \}\}/u);
  assert.match(block, /\[\[ "\$\{run_event\}" == "workflow_dispatch" \|\| "\$\{run_event\}" == "push" \|\| "\$\{run_event\}" == "schedule" \]\]/u);
  assert.match(step("Recover published registration without OCI").block, /RECOVERY_RUN_ID: \$\{\{ steps\.decision\.outputs\.recovery_run_id \}\}/u);
});

test("OPEN_PR이면 App 토큰 → required CI 보장 → 열린 PR 상한 검사 순서로 돈다", () => {
  assertOpenPullRequestSteps({ steps, file: FILE, decisionName: "Decide whether capital topology registration is needed" });
});

test("다른 원장 쓰기 PR 때문에 기다리는 실행은 이유를 notice로 남기고 아무것도 쓰지 않는다", () => {
  const { block } = step("Note registration waiting on another pending automation pull request");
  assert.equal(ifCondition(block), "${{ steps.decision.outputs.state == 'BLOCKED_BY_PENDING_PR' }}");
  assert.match(block, /::notice title=Capital topology registration::/u);
  assert.match(block, /steps\.decision\.outputs\.blocked_by/u);
});

test("복구 증거 artifact는 게시를 시도한 실행에서만 올리고, 실패 보고가 마지막 step이다", () => {
  assert.equal(ifCondition(step("Retain sanitized publication recovery evidence").block), "${{ always() && (steps.decision.outputs.state == 'REGISTER' || steps.decision.outputs.state == 'RECOVER_CLAIM') }}");
  assertFailureReportLast({ yml, step, file: FILE });
});

test("이 workflow는 workflow dispatch를 호출하지 않고 push는 GITHUB_TOKEN, PR 생성만 App 토큰이다", () => {
  assert.doesNotMatch(yml, /gh workflow run|\/dispatches|repository_dispatch|actions: write/u);
  assert.match(step("Commit exactly four registration outputs and open draft PR").block, /\n          GH_TOKEN: \$\{\{ github\.token \}\}\n/u);
});
