import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { assertFailureReportLast, assertNoExpressionInRunScripts, ifCondition, loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";
import { REFRESH_WORKFLOWS } from "./report-refresh-failure.mjs";

// #1001: 외부 스케줄러(OCI k3s CronJob, platform 레포)의 dispatch가 끊기면 GitHub 정기 실행이 백업으로 돌아 갱신은 계속되지만 침묵한다.
// 이 workflow는 GitHub 정기 실행(백업 경로, 드롭돼도 몇 시간 안에 한 번은 돈다)으로 heartbeat 정책을 점검하고, 실패는 #926 실패 이슈로 알린다.
// 변수 DATAPACK_SCHEDULER_WATCHDOG이 true일 때만 정기 실행이 돈다(기본 꺼짐): 스케줄러를 배포하고 첫 dispatch를 확인한 뒤 QA가 켠다.
const FILE = "data-workflow-scheduler-watchdog.yml";
const { yml, steps, step } = loadWorkflow(path.resolve(import.meta.dirname, "../.."), FILE);

test("트리거: 3시간마다 정기 실행과 사람 dispatch뿐이다", () => {
  assert.match(yml, /^on:\n  schedule:\n    - cron: "53 \*\/3 \* \* \*"\n  workflow_dispatch:\n/mu);
  assert.doesNotMatch(yml, /\n  push:|\n  workflow_run:|\n  pull_request|inputs:/u);
});

test("권한은 job에만 주고 읽기와 이슈 쓰기뿐이며, 변수가 true일 때만 정기 실행이 돈다(기본 꺼짐)", () => {
  assert.match(yml, /\npermissions: \{\}\n/u);
  assert.equal((yml.match(/\n    permissions:\n/gu) ?? []).length, 1);
  assert.match(yml, /\n    permissions:\n      actions: read\n      contents: read\n      issues: write\n/u);
  assert.doesNotMatch(yml, /actions: write|gh workflow run|repository_dispatch|contents: write|pull-requests/u);
  assert.match(yml, /\n    if: \$\{\{ github\.ref == 'refs\/heads\/main' && \(github\.event_name == 'workflow_dispatch' \|\| vars\.DATAPACK_SCHEDULER_WATCHDOG == 'true'\) \}\}\n/u);
  assert.match(yml, /\n    runs-on: ubuntu-latest\n/u);
  assert.match(yml, /\n    timeout-minutes: 10\n/u);
  assert.match(yml, /\nconcurrency:\n  group: data-workflow-scheduler-watchdog-\$\{\{ github\.ref \}\}\n  cancel-in-progress: false\n/u);
  assert.doesNotMatch(yml, /\n  [A-Z_]+: /u, "no workflow-level env");
});

test("heartbeat 점검은 정책 파일을 읽고 GITHUB_TOKEN으로 run 목록을 조회한다", () => {
  const check = step("Check external scheduler heartbeat");
  assert.match(check.block, /\n        env:\n          GH_TOKEN: \$\{\{ github\.token \}\}\n/u);
  assert.match(check.block, /\n        run: node tools\/ci\/check-scheduler-heartbeat\.mjs --repository "\$\{GITHUB_REPOSITORY\}" --policy release\/product-gates\/external-scheduler-heartbeat\.json$/u);
  assert.doesNotMatch(check.block, /continue-on-error/u);
  assert.deepEqual(steps().map(({ name }) => name), ["Checkout", "Set up Node.js", "Check external scheduler heartbeat", "Report refresh failure as an issue"]);
});

test("실패 보고가 마지막 step이고 기존 실패 이슈 경로(#926)에 등록돼 있다", () => {
  assertFailureReportLast({ yml, step, file: FILE });
  assert.ok(Object.hasOwn(REFRESH_WORKFLOWS, FILE));
  assert.equal(ifCondition(step("Check external scheduler heartbeat").block), null);
});

test("run 스크립트에는 표현식을 직접 넣지 않고 action은 SHA로 고정한다", () => {
  assertNoExpressionInRunScripts({ steps, file: FILE });
  assert.match(yml, /uses: actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          persist-credentials: false\n/u);
  assert.match(yml, /uses: actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020\n        with:\n          node-version: "24"\n/u);
  for (const [, ref] of yml.matchAll(/uses: [^@\s]+@(\S+)/gu)) assert.match(ref, /^[a-f0-9]{40}$/u);
});
