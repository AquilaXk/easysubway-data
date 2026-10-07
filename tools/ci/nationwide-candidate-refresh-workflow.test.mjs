import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { LEDGER_WRITER_WAIT_LIMIT } from "./automation-pr-state.mjs";
import { assertFailureReportLast, assertNoExpressionInRunScripts, assertOpenPullRequestSteps, ifCondition, loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";
import { evaluateGithubExpression } from "./github-expression.mjs";

// #969 P5: 전국 후보 갱신 workflow 계약. 정기 실행은 매일 무조건 후보를 올리지 않고, 입력이 바뀌었을 때(STALE)만 한 번 PR을 만든다.
// 사람 dispatch는 명시 요청이라 CURRENT여도 진행한다(FORCED). 열린 후보 PR이 있거나 원장 쓰기 PR이 열려 있으면 새로 만들지 않는다.
const FILE = "nationwide-candidate-refresh.yml";
const { yml, steps, step } = loadWorkflow(path.resolve(import.meta.dirname, "../.."), FILE);
const PROCEED = "${{ steps.decision.outputs.state == 'STALE' || steps.decision.outputs.state == 'FORCED' }}";
const WRITE = "${{ (steps.decision.outputs.state == 'STALE' || steps.decision.outputs.state == 'FORCED') && steps.recheck.outputs.idle == 'true' }}";

test("트리거: 2시간마다 정기 폴링과 사람 dispatch(2인 역할 입력 유지), push 트리거는 없다", () => {
  assert.match(yml, /\non:\n  schedule:\n    - cron: "29 \*\/2 \* \* \*"\n  workflow_dispatch:\n    inputs:\n      releaseSequence:/u);
  assert.doesNotMatch(yml, /\n  push:|\n  workflow_run:/u);
  assert.match(yml, /\n      requestedBy:\n[\s\S]*\n      approvedBy:\n/u);
});

test("권한은 job에만 주고 issues 쓰기는 실패 보고용이다(workflow dispatch 권한은 없다)", () => {
  assert.match(yml, /\npermissions: \{\}\n/u);
  assert.equal((yml.match(/\n    permissions:\n/gu) ?? []).length, 1);
  assert.match(yml, /\n    permissions:\n      contents: write\n      pull-requests: write\n      issues: write\n/u);
  assert.doesNotMatch(yml, /actions: write/u);
});

test("정기 실행과 스케줄러 App의 dispatch는 저장소 변수가 true일 때만 돌고, 사람 dispatch는 항상 돈다(#1032)", () => {
  const condition = "${{ github.ref == 'refs/heads/main' && ((github.event_name == 'workflow_dispatch' && github.triggering_actor != 'easysubway-release-chain[bot]') || vars.DATAPACK_SCHEDULED_CANDIDATE_REFRESH == 'true') }}";
  assert.equal(yml.match(/\n    if: ([^\n]+)\n/u)?.[1], condition);
  const runs = (context) => evaluateGithubExpression(condition, context);
  const APP = "easysubway-release-chain[bot]";
  const main = { ref: "refs/heads/main" };
  for (const vars of [{}, { DATAPACK_SCHEDULED_CANDIDATE_REFRESH: "false" }, { DATAPACK_SCHEDULED_CANDIDATE_REFRESH: "true" }]) {
    assert.equal(runs({ github: { ...main, event_name: "workflow_dispatch", triggering_actor: "AquilaXk" }, vars }), true, `사람 dispatch ${JSON.stringify(vars)}`);
  }
  for (const event_name of ["schedule", "workflow_dispatch"]) {
    const github = { ...main, event_name, triggering_actor: event_name === "schedule" ? "AquilaXk" : APP };
    assert.equal(runs({ github, vars: {} }), false, `${event_name} 변수 없음`);
    assert.equal(runs({ github, vars: { DATAPACK_SCHEDULED_CANDIDATE_REFRESH: "false" } }), false, `${event_name} 변수 false`);
    assert.equal(runs({ github, vars: { DATAPACK_SCHEDULED_CANDIDATE_REFRESH: "true" } }), true, `${event_name} 변수 true`);
  }
  assert.equal(runs({ github: { ref: "refs/heads/feature", event_name: "workflow_dispatch", triggering_actor: "AquilaXk" }, vars: {} }), false, "main이 아닌 ref");
});

test("dispatch 입력은 선택이다: 스케줄러 App은 입력 없이 깨우고 사람 입력 검증은 plan 단계가 한다(#1032)", () => {
  for (const input of ["releaseSequence", "requestedBy", "approvedBy"]) {
    assert.match(yml, new RegExp(`\\n      ${input}:\\n(?:        [^\\n]+\\n)*?        required: false\\n`, "u"), input);
    assert.doesNotMatch(yml, new RegExp(`\\n      ${input}:\\n(?:        [^\\n]+\\n)*?        required: true\\n`, "u"), input);
  }
  const { block } = step("Validate candidate refresh inputs");
  assert.match(block, /\n          ACTOR: \$\{\{ github\.triggering_actor \}\}\n/u);
  assert.match(block, /--event "\$\{EVENT_NAME\}" --actor "\$\{ACTOR\}" --github-output/u);
});

test("판정 step이 입력 검증·후보 생성보다 먼저 돌고 열린 PR·브랜치·매니페스트만 읽는다", () => {
  const all = steps();
  const decision = all.findIndex(({ name }) => name === "Decide whether the nationwide candidate must be refreshed");
  const plan = all.findIndex(({ name }) => name === "Validate candidate refresh inputs");
  assert.ok(decision !== -1 && decision < plan);
  const { block } = all[decision];
  assert.match(block, /\n        id: decision\n/u);
  assert.match(block, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(block, /EVENT_NAME: \$\{\{ github\.event_name \}\}/u);
  // #993: PR 이력 전체(--state all --limit 1000)를 받지 않는다. 열린 PR 전체와 claim 브랜치별 PR만 수집기로 받는다.
  assert.match(block, /node tools\/ci\/collect-automation-prs\.mjs --repository "\$\{GITHUB_REPOSITORY\}" --refs "[^"]+" --pr-limit 1000 --output "[^"]+"/u);
  assert.doesNotMatch(block, /gh pr list[^\n]*--state all --limit/u);
  assert.match(block, /git ls-remote --heads origin "refs\/heads\/automation\/927-nationwide-candidate-refresh-\*" > /u);
  assert.match(block, /git ls-remote --heads origin "refs\/heads\/automation\/\*" > /u);
  assert.match(block, /ACTOR: \$\{\{ github\.triggering_actor \}\}/u);
  assert.match(block, /node tools\/ci\/decide-nationwide-candidate-refresh\.mjs --event "\$\{EVENT_NAME\}" --actor "\$\{ACTOR\}" --repository "\$\{GITHUB_REPOSITORY\}" --prs "[^"]+" --branches "[^"]+" --automation-branches "[^"]+" --github-output "\$\{GITHUB_OUTPUT\}"/u);
});

test("후보 생성·범위 검증·push·App 토큰·PR 생성은 STALE 또는 FORCED일 때만 돈다", () => {
  for (const name of ["Validate candidate refresh inputs", "Record the candidate gate run", "Refresh nationwide candidate", "Verify candidate refresh output scope", "Recheck that no source-ledger automation is pending before pushing"]) {
    assert.equal(ifCondition(step(name).block), PROCEED, name);
  }
  // #974 리뷰 F2: 후보 생성은 길다. push 직전에 원장 쓰기 자동화(열린 PR·claim 브랜치)가 생기지 않았는지 다시 확인하고, 있으면 아무것도 올리지 않는다.
  for (const name of ["Commit and push candidate refresh branch", "Mint App token for the candidate refresh pull request", "Create candidate refresh pull request"]) {
    assert.equal(ifCondition(step(name).block), WRITE, name);
  }
  // #974 리뷰 F3: 취소·시간 초과에도 이 run이 push한 branch와 PR을 정리한다.
  assert.equal(ifCondition(step("Remove the candidate refresh branch after a later failure").block), "${{ (failure() || cancelled()) && env.CANDIDATE_BRANCH != '' }}");
});

test("OPEN_PR이면 App 토큰 → required CI 보장 → 열린 PR 상한 검사 순서로 돈다", () => {
  assertOpenPullRequestSteps({ steps, file: FILE, decisionName: "Decide whether the nationwide candidate must be refreshed" });
});

test("원장 쓰기 PR 때문에 기다리는 실행은 이유를 notice로 남기고 아무것도 쓰지 않는다", () => {
  const { block } = step("Note candidate refresh waiting on a pending source pull request");
  assert.equal(ifCondition(block), "${{ steps.decision.outputs.state == 'BLOCKED_BY_PENDING_PR' }}");
  assert.match(block, /::notice title=Nationwide candidate refresh::/u);
  assert.match(block, /steps\.decision\.outputs\.blocked_by/u);
});

test("후보 PR 본문은 정기 갱신이 입력 변경으로 시작됐음을 남기고, 실패 보고가 마지막 step이다", () => {
  assert.match(step("Create candidate refresh pull request").block, /steps\.decision\.outputs\.stale_paths/u);
  assertFailureReportLast({ yml, step, file: FILE, condition: "${{ failure() || cancelled() }}" });
});

// #974 리뷰 F1: 기준 경로 목록은 매니페스트의 값이다. 경로에 따옴표·백틱·$가 있어도 셸이 실행하지 않도록 env로만 받는다.
test("run 스크립트에는 표현식을 직접 넣지 않고 env로만 받는다", () => {
  assertNoExpressionInRunScripts({ steps, file: FILE });
  const { block } = step("Note candidate refresh waiting on a pending source pull request");
  assert.match(block, /\n          STALE_PATHS: \$\{\{ steps\.decision\.outputs\.stale_paths \}\}\n/u);
  assert.match(block, /\n          BLOCKED_BY: \$\{\{ steps\.decision\.outputs\.blocked_by \}\}\n/u);
});

// 이슈 #973: 이전 실행이 남긴 후보 브랜치(PR 없음·닫힌 PR)는 판정이 알려 주고 이번 실행이 지운다.
test("판정이 알린 남은 후보 브랜치는 입력 검증 전에 지운다", () => {
  const cleanup = step("Remove stale candidate refresh branches named by the decision");
  assert.equal(ifCondition(cleanup.block), "${{ steps.decision.outputs.cleanup_branches != '' }}");
  assert.match(cleanup.block, /CLEANUP_BRANCHES: \$\{\{ steps\.decision\.outputs\.cleanup_branches \}\}/u);
  assert.match(cleanup.block, /\^automation\/927-nationwide-candidate-refresh-\[1-9\]\[0-9\]\*\$/u);
  assert.match(cleanup.block, /git push origin --delete "\$\{stale_branch\}"/u);
  const names = steps().map(({ name }) => name);
  assert.ok(names.indexOf("Decide whether the nationwide candidate must be refreshed") < names.indexOf(cleanup.name));
  assert.ok(names.indexOf(cleanup.name) < names.indexOf("Validate candidate refresh inputs"));
});

test("push 직전 재확인의 대기 상한은 판정이 쓰는 상수와 같다(#1032)", () => {
  assert.equal(LEDGER_WRITER_WAIT_LIMIT, "PT2H");
});

test("push 직전 재확인은 판정과 같은 규칙으로 대기 목록을 읽고, 대기 중이면 이유를 notice로 남긴다", () => {
  const recheck = step("Recheck that no source-ledger automation is pending before pushing");
  assert.match(recheck.block, /\n        id: recheck\n/u);
  // #993: PR 이력 전체(--state all --limit 1000)를 받지 않는다. 열린 PR 전체와 claim 브랜치별 PR만 수집기로 받는다.
  assert.match(recheck.block, /node tools\/ci\/collect-automation-prs\.mjs --repository "\$\{GITHUB_REPOSITORY\}" --refs "[^"]+" --pr-limit 1000 --output "[^"]+"/u);
  assert.doesNotMatch(recheck.block, /gh pr list[^\n]*--state all --limit/u);
  assert.match(recheck.block, /git ls-remote --heads origin "refs\/heads\/automation\/\*" > /u);
  assert.match(recheck.block, /node tools\/ci\/ledger-writers-idle\.mjs --repository "\$\{GITHUB_REPOSITORY\}" --prs "[^"]+" --automation-branches "[^"]+" --max-age "PT2H" --github-output "\$\{GITHUB_OUTPUT\}"/u);
  const names = steps().map(({ name }) => name);
  assert.ok(names.indexOf("Verify candidate refresh output scope") < names.indexOf(recheck.name) && names.indexOf(recheck.name) < names.indexOf("Commit and push candidate refresh branch"));
  const note = step("Note candidate refresh superseded by pending source automation");
  assert.equal(ifCondition(note.block), "${{ (steps.decision.outputs.state == 'STALE' || steps.decision.outputs.state == 'FORCED') && steps.recheck.outputs.idle == 'false' }}");
});

// #975 리뷰 F2: 후보 PR도 base/head 커밋에 결속된 증거 블록을 낸다(2단계 입력 계약).
test("후보 PR 본문에는 push한 head와 base(main) 커밋에 결속된 증거 블록이 든다", () => {
  const commit = step("Commit and push candidate refresh branch").block;
  assert.match(commit, /printf 'CANDIDATE_BASE_SHA=%s\\n' "\$\(git rev-parse HEAD\)" >> "\$\{GITHUB_ENV\}"/u);
  assert.ok(commit.indexOf("CANDIDATE_BASE_SHA") < commit.indexOf("git commit -m"), "the base is recorded before the candidate commit");
  assert.match(commit, /printf 'CANDIDATE_HEAD_SHA=%s\\n' "\$\(git rev-parse HEAD\)" >> "\$\{GITHUB_ENV\}"/u);
  assert.ok(commit.indexOf("git commit -m") < commit.indexOf("CANDIDATE_HEAD_SHA"), "the head is recorded after the candidate commit");
  const { block } = step("Create candidate refresh pull request");
  assert.match(block, /node tools\/ci\/automation-pr-evidence\.mjs candidate-refresh-block --build-spec tools\/datapack\/release\/candidate-build-spec\.json --changed-paths "\$\{changed_paths\}" --base-sha "\$\{CANDIDATE_BASE_SHA\}" --head-sha "\$\{CANDIDATE_HEAD_SHA\}" --run-url "\$\{GITHUB_SERVER_URL\}\/\$\{GITHUB_REPOSITORY\}\/actions\/runs\/\$\{GITHUB_RUN_ID\}"/u);
  assert.match(block, /\$\{evidence_block\}/u);
  // #986 F4: 후보 PR이 바꾼 경로 전체를 증거 블록에 싣는다. 정책이 API diff와 정확히 대조한다.
  assert.match(block, /changed_paths="\$\{RUNNER_TEMP\}\/candidate-changed-paths\.txt"\n\s+git diff --name-only "\$\{CANDIDATE_BASE_SHA\}" "\$\{CANDIDATE_HEAD_SHA\}" > "\$\{changed_paths\}"/u);
  assert.ok(block.indexOf("git diff --name-only") < block.indexOf("candidate-refresh-block"));
});

// #1032: 원장 쓰기 자동화가 멈춰도(사람 확인 대기 claim, 재생성 상한에 걸린 PR) 후보 갱신은 상한 시간까지만 기다린다. 무시한 대상은 경고로 남긴다.
test("상한을 넘겨 기다리지 않은 원장 쓰기 대상은 경고로 남기고 후보 생성은 계속한다", () => {
  const { block } = step("Note candidate refresh proceeding past stuck source automation");
  assert.equal(ifCondition(block), "${{ steps.decision.outputs.expired_blockers != '' }}");
  assert.match(block, /::warning title=Nationwide candidate refresh::/u);
  assert.match(block, /\n          EXPIRED_BLOCKERS: \$\{\{ steps\.decision\.outputs\.expired_blockers \}\}\n/u);
  assert.doesNotMatch(block, /exit 1/u);
  const names = steps().map(({ name }) => name);
  assert.ok(names.indexOf("Decide whether the nationwide candidate must be refreshed") < names.indexOf("Note candidate refresh proceeding past stuck source automation"));
  assert.ok(names.indexOf("Note candidate refresh proceeding past stuck source automation") < names.indexOf("Validate candidate refresh inputs"));
});
