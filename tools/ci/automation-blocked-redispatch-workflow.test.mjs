import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { assertFailureReportLast, assertNoExpressionInRunScripts, ifCondition, loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";
import { REDISPATCH_TARGETS } from "./redispatch-blocked-workflows.mjs";
import { REFRESH_WORKFLOWS } from "./report-refresh-failure.mjs";
import { REFRESH_CLAIM_PREFIXES } from "./refresh-open-pr-age.mjs";

// #1097: 차단 PR 때문에 BLOCKED_BY_PENDING_PR로 끝난 정기 workflow를 차단이 풀린 뒤 다시 dispatch하는 workflow의 계약.
// 판정과 상한은 redispatch-blocked-workflows.test.mjs가, 이 파일은 workflow의 트리거·권한·게이트·step 구성을 고정한다.
const FILE = "automation-blocked-redispatch.yml";
const root = path.resolve(import.meta.dirname, "../..");
const { yml, steps, step } = loadWorkflow(root, FILE);
const code = yml.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");

test("트리거: 15분마다와 Automerge Queue 완료, 사람 dispatch뿐이다(PR·push 이벤트로 PR 코드를 실행하지 않는다)", () => {
  assert.match(yml, /\non:\n  schedule:\n    - cron: "11,26,41,56 \* \* \* \*"\n  workflow_run:\n    workflows: \["Automerge Queue"\]\n    types: \[completed\]\n  workflow_dispatch:\n\npermissions: \{\}\n/u);
  assert.doesNotMatch(code, /\n  (?:push|pull_request|pull_request_target|issue_comment|repository_dispatch):|inputs:/u);
});

test("변수 DATAPACK_AUTOMATION_REDISPATCH가 true일 때만 정기·workflow_run 실행이 돌고(기본 꺼짐) 사람 dispatch는 항상 돈다", () => {
  assert.match(yml, /\n    if: \$\{\{ github\.ref == 'refs\/heads\/main' && \(github\.event_name == 'workflow_dispatch' \|\| vars\.DATAPACK_AUTOMATION_REDISPATCH == 'true'\) \}\}\n/u);
  const header = yml.split("\n").filter((line) => line.startsWith("#")).join("\n");
  assert.match(header, /DATAPACK_AUTOMATION_REDISPATCH[^\n]*기본 꺼짐/u);
  assert.match(header, /QA 보고 뒤[^\n]*설정 변경/u);
  assert.doesNotMatch(code, /gh variable|actions\/variables/u);
});

test("권한은 job에만 있고 dispatch(actions: write)·읽기·실패 이슈뿐이다. 비밀과 App 토큰을 쓰지 않는다", () => {
  assert.match(yml, /\npermissions: \{\}\n/u);
  assert.equal((yml.match(/\n    permissions:\n/gu) ?? []).length, 1);
  assert.match(yml, /\n    permissions:\n      actions: write\n      contents: read\n      issues: write\n      pull-requests: read\n/u);
  assert.doesNotMatch(code, /secrets\.|create-github-app-token|contents: write|pull-requests: write|environment:/u);
  assert.match(yml, /\n    runs-on: ubuntu-latest\n/u);
  assert.match(yml, /\n    timeout-minutes: 10\n/u);
  assert.doesNotMatch(yml, /\n  [A-Z_]+: /u, "no workflow-level env");
});

test("한 번에 하나만 돈다(직렬): 진행 중 sweeper를 취소하지 않고 기다린다", () => {
  assert.match(yml, /\nconcurrency:\n  group: automation-blocked-redispatch\n  cancel-in-progress: false\n/u);
});

test("step 구성: 기본 브랜치 checkout, PR 수집, 재dispatch, 실패 보고 순서이고 PR 코드를 가져오지 않는다", () => {
  assert.deepEqual(steps().map(({ name }) => name), [
    "Checkout the default branch", "Set up Node.js", "Collect the automation pull requests", "Redispatch the workflows that ended blocked", "Report refresh failure as an issue",
  ]);
  assert.match(step("Checkout the default branch").block, /with:\n          persist-credentials: false/u);
  assert.doesNotMatch(code, /github\.event\.workflow_run\.head|pull_request\.head|ref: /u);
  const collect = step("Collect the automation pull requests").block;
  assert.match(collect, /git ls-remote --heads origin "refs\/heads\/automation\/\*"/u);
  assert.match(collect, /node tools\/ci\/collect-automation-prs\.mjs --repository "\$\{GITHUB_REPOSITORY\}" --refs "[^"]+" --pr-limit 1000 --output "[^"]+"/u);
  const redispatch = step("Redispatch the workflows that ended blocked").block;
  assert.match(redispatch, /\n          GH_TOKEN: \$\{\{ github\.token \}\}\n/u);
  assert.match(redispatch, /node tools\/ci\/redispatch-blocked-workflows\.mjs --repository "\$\{GITHUB_REPOSITORY\}" --refs "\$\{REDISPATCH_ROOT\}\/automation-branches\.txt" --prs "\$\{REDISPATCH_ROOT\}\/prs\.json"/u);
  assert.equal(ifCondition(redispatch), null);
  assert.doesNotMatch(code, /continue-on-error|gh workflow run/u, "dispatch는 도구 하나만 한다");
});

test("실패 보고가 마지막 step이고 기존 실패 이슈 경로(#926)에 등록돼 있다", () => {
  assertFailureReportLast({ yml, step, file: FILE });
  assert.ok(Object.hasOwn(REFRESH_WORKFLOWS, FILE));
});

test("run 스크립트에는 표현식을 직접 넣지 않고 action은 SHA로 고정한다", () => {
  assertNoExpressionInRunScripts({ steps, file: FILE });
  for (const [, ref] of yml.matchAll(/uses: [^@\s]+@(\S+)/gu)) assert.match(ref, /^[a-f0-9]{40}$/u);
});

test("대상 workflow는 모두 원장 쓰기 자동화(claim 접두사 보유)이고 후보 갱신은 빠져 있다", () => {
  for (const { workflow } of REDISPATCH_TARGETS) {
    assert.ok(Object.hasOwn(REFRESH_CLAIM_PREFIXES, workflow), workflow);
  }
  assert.equal(REDISPATCH_TARGETS.some(({ workflow }) => workflow === "nationwide-candidate-refresh.yml"), false);
  assert.match(yml, /후보 갱신은 대상이 아니다/u);
});
