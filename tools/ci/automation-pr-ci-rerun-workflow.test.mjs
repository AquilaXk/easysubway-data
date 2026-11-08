import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { assertFailureReportLast, assertNoExpressionInRunScripts, ifCondition, loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";
import { REFRESH_WORKFLOWS } from "./report-refresh-failure.mjs";

// #1115: 자동화 PR의 CI 첫 시도 실패를 한 번 다시 실행하는 workflow의 계약.
// 판정과 재실행 규칙은 rerun-automation-pr-ci.test.mjs가, 이 파일은 트리거·권한·게이트·step 구성과 자동 병합 라벨러와의 짝을 고정한다.
const FILE = "automation-pr-ci-rerun.yml";
const root = path.resolve(import.meta.dirname, "../..");
const { yml, workflow, job, steps, step } = loadWorkflow(root, FILE);
const code = yml.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
const automerge = loadWorkflow(root, "automation-pr-automerge.yml");

test("트리거는 CI 완료(workflow_run) 하나다. PR·push·schedule·dispatch로 PR 코드를 실행하지 않는다", () => {
  assert.deepEqual(workflow.on, {
    workflow_run: {
      workflows: ["CI"],
      types: ["completed"],
    },
  });
  assert.deepEqual(workflow.permissions, {});
  assert.doesNotMatch(code, /inputs:/u);
});

test("변수 DATAPACK_AUTOMATION_CI_RERUN이 true일 때만 돌고(기본 꺼짐) 코드가 변수를 켜지 않는다", () => {
  const header = yml.split("\n").filter((line) => line.startsWith("#")).join("\n");
  assert.match(header, /DATAPACK_AUTOMATION_CI_RERUN[^\n]*기본 꺼짐/u);
  assert.match(header, /QA 보고 뒤[^\n]*설정 변경/u);
  assert.doesNotMatch(code, /gh variable|actions\/variables/u);
});

test("job은 같은 저장소의 automation/ 브랜치 pull_request CI가 첫 시도에서 failure일 때만 돈다", () => {
  assert.equal(
    job.if,
    "${{ vars.DATAPACK_AUTOMATION_CI_RERUN == 'true' && github.event.workflow_run.event == 'pull_request' && github.event.workflow_run.conclusion == 'failure' && github.event.workflow_run.run_attempt == 1 && startsWith(github.event.workflow_run.head_branch, 'automation/') && github.event.workflow_run.head_repository.full_name == github.repository }}",
  );
  assert.equal(job.name, "Rerun the failed CI jobs once");
});

test("권한은 job에만 있고 재실행(actions: write)·PR 코멘트(pull-requests: write)·실패 이슈(issues: write)·읽기뿐이다. 비밀과 App 토큰을 쓰지 않는다", () => {
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(Object.keys(workflow.jobs), ["rerun"]);
  assert.deepEqual(job.permissions, {
    actions: "write",
    contents: "read",
    issues: "write",
    "pull-requests": "write",
  });
  assert.equal(job.environment, null);
  assert.doesNotMatch(code, /secrets\.|create-github-app-token|contents: write|environment:/u);
  assert.equal(job.runsOn, "ubuntu-latest");
  assert.equal(job.timeoutMinutes, 10);
  assert.deepEqual(workflow.env, {});
});

test("같은 브랜치의 실행은 직렬이다: 진행 중인 재실행을 취소하지 않는다", () => {
  assert.deepEqual(workflow.concurrency, {
    group: "automation-pr-ci-rerun-${{ github.event.workflow_run.head_branch }}",
    "cancel-in-progress": false,
  });
});

test("PR 코드를 가져오거나 실행하지 않는다. checkout은 기본 브랜치뿐이고 실행하는 도구는 둘뿐이다", () => {
  assert.deepEqual(steps().map(({ name }) => name), [
    "Checkout the default branch", "Set up Node.js", "Rerun the failed jobs once and record it on the pull request", "Report refresh failure as an issue",
  ]);
  const checkouts = job.steps.filter(({ uses }) => Boolean(uses?.startsWith("actions/checkout@")));
  assert.equal(checkouts.length, 1);
  assert.equal(checkouts[0].uses, "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
  assert.deepEqual(checkouts[0].with, { "persist-credentials": "false" });
  for (const forbidden of [/head_sha[^\n]*checkout/u, /refs\/pull/u, /pull_request\.head/u, /head\.ref/u, /\n\s+ref: /u, /actions\/download-artifact/u, /npm (?:ci|install)/u, /continue-on-error/u, /gh run rerun|gh workflow run/u]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
  const nodes = [...code.matchAll(/node (\S+)/gu)].map((match) => match[1]);
  assert.deepEqual([...new Set(nodes)], ["tools/ci/rerun-automation-pr-ci.mjs", "tools/ci/report-refresh-failure.mjs"]);
});

test("재실행 step은 github.token과 run id만 env로 받고 도구 하나만 부른다", () => {
  const rerun = step("Rerun the failed jobs once and record it on the pull request");
  assert.deepEqual(rerun.env, {
    GH_TOKEN: "${{ github.token }}",
    RUN_ID: "${{ github.event.workflow_run.id }}",
  });
  assert.ok(rerun.run.includes('node tools/ci/rerun-automation-pr-ci.mjs --repository "${GITHUB_REPOSITORY}" --run-id "${RUN_ID}"'));
  assert.equal(ifCondition(rerun), null);
});

test("실패 보고가 마지막 step이고 기존 실패 이슈 경로(#926)에 등록돼 있다", () => {
  assertFailureReportLast({ yml, job, steps, step, file: FILE });
  assert.ok(Object.hasOwn(REFRESH_WORKFLOWS, FILE));
});

test("run 스크립트에는 표현식을 직접 넣지 않고 action은 SHA로 고정한다", () => {
  assertNoExpressionInRunScripts({ job, steps, file: FILE });
  for (const item of job.steps.filter(({ uses }) => uses !== null)) {
    assert.match(item.uses, /@[a-f0-9]{40}$/u);
  }
});

test("자동 병합 라벨러는 같은 변수가 켜졌을 때만 첫 시도 실패를 건너뛴다(재실행될 일시 오류가 실패 이슈를 남기지 않게). 두 번째 시도 실패는 건너뛰지 않는다", () => {
  assert.equal(
    automerge.job.if,
    "${{ vars.DATAPACK_AUTOMATION_AUTOMERGE == 'true' && github.event.workflow_run.event == 'pull_request' && startsWith(github.event.workflow_run.head_branch, 'automation/') && github.event.workflow_run.head_repository.full_name == github.repository && !(vars.DATAPACK_AUTOMATION_CI_RERUN == 'true' && github.event.workflow_run.conclusion == 'failure' && github.event.workflow_run.run_attempt == 1) }}",
  );
  // 건너뛰는 조건이 재실행 workflow의 대상 조건(결론 failure, 첫 시도, 같은 변수)과 같은 세 항목이다.
  const skipped = /!\((vars\.DATAPACK_AUTOMATION_CI_RERUN == 'true' && github\.event\.workflow_run\.conclusion == 'failure' && github\.event\.workflow_run\.run_attempt == 1)\)/u.exec(automerge.job.if)?.[1];
  assert.ok(skipped, "automerge skip condition");
  for (const part of skipped.split(" && ")) assert.ok(job.if.includes(part), `rerun workflow condition contains: ${part}`);
});
