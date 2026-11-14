import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { assertFailureReportLast, assertNoExpressionInRunScripts, ifCondition, loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";
import { REFRESH_WORKFLOWS } from "./report-refresh-failure.mjs";

// #1001: 외부 스케줄러(OCI k3s CronJob, platform 레포)의 dispatch가 끊기면 GitHub 정기 실행이 백업으로 돌아 갱신은 계속되지만 침묵한다.
// 이 workflow는 GitHub 정기 실행(백업 경로, 드롭돼도 몇 시간 안에 한 번은 돈다)으로 heartbeat 정책을 점검하고, 실패는 #926 실패 이슈로 알린다.
// 변수 DATAPACK_SCHEDULER_WATCHDOG이 true일 때만 정기 실행이 돈다(기본 꺼짐): 스케줄러를 배포하고 첫 dispatch를 확인한 뒤 QA가 켠다.
const FILE = "data-workflow-scheduler-watchdog.yml";
const { yml, workflow, job, steps, step } = loadWorkflow(path.resolve(import.meta.dirname, "../.."), FILE);

test("트리거: 3시간마다 정기 실행과 사람 dispatch뿐이다", () => {
  assert.deepEqual(workflow.on, {
    schedule: [{ cron: "53 */3 * * *" }],
    workflow_dispatch: {},
  });
});

test("권한은 job에만 주고 읽기뿐이며, 변수가 true일 때만 정기 실행이 돈다(기본 꺼짐)", () => {
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(Object.keys(workflow.jobs), ["watch"]);
  assert.deepEqual(job.permissions, {
    actions: "read",
    contents: "read",
  });
  assert.doesNotMatch(yml, /actions: write|gh workflow run|repository_dispatch|contents: write|pull-requests|issues: write/u);
  assert.equal(
    job.if,
    "${{ github.ref == 'refs/heads/main' && (github.event_name == 'workflow_dispatch' || vars.DATAPACK_SCHEDULER_WATCHDOG == 'true') }}",
  );
  assert.equal(job.runsOn, "ubuntu-latest");
  assert.equal(job.timeoutMinutes, 10);
  assert.deepEqual(workflow.concurrency, {
    group: "data-workflow-scheduler-watchdog-${{ github.ref }}",
    "cancel-in-progress": false,
  });
  assert.deepEqual(workflow.env, {});
});

test("heartbeat 점검은 정책 파일을 읽고 GITHUB_TOKEN으로 run 목록을 조회한다", () => {
  const check = step("Check external scheduler heartbeat");
  assert.deepEqual(check.env, { GH_TOKEN: "${{ github.token }}" });
  assert.equal(
    check.run,
    'node tools/ci/check-scheduler-heartbeat.mjs --repository "${GITHUB_REPOSITORY}" --policy release/product-gates/external-scheduler-heartbeat.json',
  );
  assert.equal(check.continueOnError, null);
  assert.deepEqual(steps().map(({ name }) => name), ["Checkout", "Set up Node.js", "Check external scheduler heartbeat", "Report refresh failure summary"]);
});

test("실패 보고가 마지막 step이고 요약 경로에 등록돼 있다", () => {
  assertFailureReportLast({ yml, job, steps, step, file: FILE });
  assert.ok(Object.hasOwn(REFRESH_WORKFLOWS, FILE));
  assert.equal(ifCondition(step("Check external scheduler heartbeat")), null);
});

test("run 스크립트에는 표현식을 직접 넣지 않고 action은 SHA로 고정한다", () => {
  assertNoExpressionInRunScripts({ job, steps, file: FILE });
  assert.equal(step("Checkout").uses, "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
  assert.deepEqual(step("Checkout").with, { "persist-credentials": "false" });
  assert.equal(step("Set up Node.js").uses, "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1");
  assert.deepEqual(step("Set up Node.js").with, { "node-version": "24" });
  for (const item of job.steps.filter(({ uses }) => uses !== null)) {
    assert.match(item.uses, /@[a-f0-9]{40}$/u);
  }
});
