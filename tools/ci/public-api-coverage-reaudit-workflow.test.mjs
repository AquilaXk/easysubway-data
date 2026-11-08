import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { evaluateGithubExpression } from "./github-expression.mjs";
import { assertNoExpressionInRunScripts, ifCondition, loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";
import { PUBLIC_API_COVERAGE_REAUDIT_CALL_EVIDENCE } from "./provider-call-ledger.mjs";

// #3036 7-47: 공식 미지원 근거(부산김해 1건·대구 3건 등) 정기/수동 부분 재감사 workflow 계약 및 일일 호출 예산 연동.
const FILE = "public-api-coverage-reaudit.yml";
const { yml, steps, step } = loadWorkflow(path.resolve(import.meta.dirname, "../.."), FILE);
const names = () => steps().map(({ name }) => name);
const before = (earlier, later) => assert.ok(names().indexOf(earlier) !== -1 && names().indexOf(earlier) < names().indexOf(later), `${earlier} -> ${later}`);

test("트리거: 주간 정기 schedule과 대상 노선(line_ids)·수동 재시도 해금 입력을 받는 workflow_dispatch만 허용한다 (#3036 7-47)", () => {
  assert.match(yml, /^on:\n  schedule:\n    - cron: "17 18 \* \* 0"\n  workflow_dispatch:\n/mu);
  assert.doesNotMatch(yml, /\n  push:|\n  workflow_run:|\n  pull_request/u);
  assert.match(yml, /\n      line_ids:\n        description: [^\n]+\n        required: false\n        default: "line-e4cce88f0d7f,line-0ffaa95b1b5d,line-5b8d9b05e7e6,line-e2938a4cc492"\n        type: string\n/u);
  assert.match(yml, /\n      allow_same_day_budget_retry:\n        description: [^\n]+\n        required: false\n        default: false\n        type: boolean\n/u);
});

test("최소 권한(permissions: {}, job에만 actions: read / contents: read)과 게이트 변수(PUBLIC_API_COVERAGE_REAUDIT_ENABLED == 'true')를 강제한다 (#3036 7-47)", () => {
  assert.match(yml, /\npermissions: \{\}\n/u);
  assert.equal((yml.match(/\n    permissions:\n/gu) ?? []).length, 1);
  assert.match(yml, /\n    permissions:\n      actions: read\n      contents: read\n/u);
  assert.doesNotMatch(yml, /contents: write|pull-requests: write|issues: write|actions: write/u);
  const jobIf = "github.ref == 'refs/heads/main' && ((github.event_name == 'workflow_dispatch' && github.event.sender.type == 'User') || vars.PUBLIC_API_COVERAGE_REAUDIT_ENABLED == 'true')";
  assert.match(yml, new RegExp(`\\n    if: \\$\\{\\{ ${jobIf.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")} \\}\\}\\n`, "u"));
  assert.equal(evaluateGithubExpression(jobIf, {
    github: { ref: "refs/heads/main", event_name: "schedule", event: { sender: { type: "Bot" } } },
    vars: { PUBLIC_API_COVERAGE_REAUDIT_ENABLED: "" },
  }), false, "게이트 변수가 꺼져 있으면 정기 실행은 발화하지 않는다");
  assert.equal(evaluateGithubExpression(jobIf, {
    github: { ref: "refs/heads/main", event_name: "schedule", event: { sender: { type: "Bot" } } },
    vars: { PUBLIC_API_COVERAGE_REAUDIT_ENABLED: "true" },
  }), true, "게이트 변수가 true일 때만 정기 실행이 돈다");
  assert.equal(evaluateGithubExpression(jobIf, {
    github: { ref: "refs/heads/main", event_name: "workflow_dispatch", event: { sender: { type: "User" } } },
    vars: { PUBLIC_API_COVERAGE_REAUDIT_ENABLED: "" },
  }), true, "사람 workflow_dispatch는 게이트 변수와 무관하게 돈다");
});

test("공급자 호출 전에 provider-call-ledger와 provider-daily-call-budget으로 당일 잔여 호출 예산을 먼저 확인해 부족하면 fail-closed로 중단한다 (#3036 7-47)", () => {
  const record = step("Record source fetch attempts for the job summary");
  assert.match(record.block, /: > "\$\{RUNNER_TEMP\}\/source-fetch-telemetry\.jsonl"/u);
  const budget = step("Check provider daily call budget before coverage reaudit");
  assert.match(budget.block, /\n          GITHUB_TOKEN: \$\{\{ github\.token \}\}\n/u);
  assert.match(budget.block, /\n          LINE_IDS: \$\{\{ inputs\.line_ids \}\}\n/u);
  assert.match(budget.block, /\n          ALLOW_SAME_DAY_BUDGET_RETRY: \$\{\{ github\.event_name == 'workflow_dispatch' && github\.event\.sender\.type == 'User' && inputs\.allow_same_day_budget_retry == true && 'true' \|\| 'false' \}\}\n/u);
  assert.doesNotMatch(budget.block, /secrets\./u, "예산 사전 점검 step에는 공급자 API 키를 주지 않는다");
  const ledgerIdx = budget.block.indexOf('node tools/ci/provider-call-ledger.mjs --ledger "${reaudit_root}/provider-call-ledger.json" --workflow public-api-coverage-reaudit.yml');
  const dryRunIdx = budget.block.indexOf("node tools/datapack/collect-nationwide-public-api-coverage.mjs");
  assert.ok(ledgerIdx !== -1 && ledgerIdx < dryRunIdx, "원장 조회 뒤 dry-run 예산 점검을 먼저 수행한다");
  assert.match(budget.block, /--scope PARTIAL --line-ids "\$\{LINE_IDS\}" --call-budget release\/product-gates\/provider-daily-call-budget\.json --provider-call-ledger "\$\{reaudit_root\}\/provider-call-ledger\.json" --allow-same-day-budget-retry "\$\{ALLOW_SAME_DAY_BUDGET_RETRY\}" --dry-run/u);

  const reaudit = step("Reaudit official unsupported public API coverage");
  assert.match(reaudit.block, /\n          DATA_GO_KR_SERVICE_KEY: \$\{\{ secrets\.DATA_GO_KR_SERVICE_KEY \}\}\n/u);
  assert.equal((yml.match(/secrets\.DATA_GO_KR_SERVICE_KEY/gu) ?? []).length, 1, "공급자 키는 실제 재감사 step에만 주입한다");
  before(record.name, budget.name);
  before(budget.name, reaudit.name);
});

test("시도별 계측 요약과 증거 artifact 업로드는 always()로 돌고 PUBLIC_API_COVERAGE_REAUDIT_CALL_EVIDENCE 계약과 일치한다 (#3036 7-47)", () => {
  assert.equal(PUBLIC_API_COVERAGE_REAUDIT_CALL_EVIDENCE.workflowFile, FILE);
  assert.match(yml, new RegExp(`\\n    name: ${PUBLIC_API_COVERAGE_REAUDIT_CALL_EVIDENCE.jobName}\\n`, "u"));
  assert.ok(names().includes(PUBLIC_API_COVERAGE_REAUDIT_CALL_EVIDENCE.collectorStepName));
  const upload = step("Upload provider call evidence");
  assert.equal(ifCondition(upload.block), "${{ always() }}");
  assert.match(upload.block, new RegExp(`\\n          name: ${PUBLIC_API_COVERAGE_REAUDIT_CALL_EVIDENCE.artifactPrefix}-\\$\\{\\{ github\\.run_id \\}\\}\\n`, "u"));
  assert.match(upload.block, new RegExp(`\\n          path: \\$\\{\\{ runner\\.temp \\}\\}/${PUBLIC_API_COVERAGE_REAUDIT_CALL_EVIDENCE.file.replaceAll(".", "\\.")}\\n`, "u"));
  assert.match(upload.block, /\n          if-no-files-found: error\n/u);
  assert.match(upload.block, /\n          retention-days: 2\n?$/u);
  before("Reaudit official unsupported public API coverage", upload.name);
});

test("모든 uses 액션은 40자 SHA로 고정하고 run 스크립트에 표현식을 직접 넣지 않는다 (#3036 7-47)", () => {
  assertNoExpressionInRunScripts({ steps, file: FILE });
  for (const [, reference] of yml.matchAll(/\n\s+uses: ([^\s]+)/gu)) {
    assert.match(reference, /@[0-9a-f]{40}$/u, reference);
  }
});
