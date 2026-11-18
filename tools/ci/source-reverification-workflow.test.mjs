import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { evaluateGithubExpression, evaluateGithubTemplate } from "./github-expression.mjs";
import { assertFailureReportLast, assertNoExpressionInRunScripts, ifCondition, loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";
import { PROVIDER_BUDGET_BLOCK_STEP } from "./provider-call-budget.mjs";
import { SOURCE_REVERIFICATION_CALL_EVIDENCE } from "./provider-call-ledger.mjs";
import { SOURCE_REVERIFICATION_JOB, SOURCE_REVERIFICATION_REPLAY_SOURCE_STEPS, SOURCE_REVERIFICATION_WORKFLOW_PATH } from "./verify-source-reverification-replay-run.mjs";

// P7D 원천 재확인 workflow 계약(단독 운영). 판정(DUE)이 고른 recipe를 수집·게시·등록 → 원장 게이트 → main에 직접 push한다.
// 변수 DATAPACK_SCHEDULED_SOURCE_REVERIFICATION이 true일 때만 정기 실행이 돈다(기본 꺼짐). 이상은 Step Summary와 ::error 주석으로 드러난다.
const FILE = "source-reverification.yml";
const { yml, workflow, job, steps, step } = loadWorkflow(path.resolve(import.meta.dirname, "../.."), FILE);
const RUN = "${{ steps.decision.outputs.state == 'RUN' }}";
const REGISTERED = "${{ steps.decision.outputs.state == 'RUN' && steps.reverify.outputs.registered != '0' }}";
const REPLAYING = "${{ steps.decision.outputs.state == 'RUN' && steps.decision.outputs.replay_run_id != '' }}";
const names = () => steps().map(({ name }) => name);
const before = (earlier, later) => assert.ok(names().indexOf(earlier) !== -1 && names().indexOf(earlier) < names().indexOf(later), `${earlier} -> ${later}`);

function countMatches(text, regex) {
  return [...text.matchAll(regex)].length;
}

function replayOutputs(more) {
  return { decision: { outputs: { state: "RUN", replay_run_id: "39369279984" } }, ...more };
}

function collectOutputs(more) {
  return { decision: { outputs: { state: "RUN", replay_run_id: "" } }, ...more };
}

function pushedOutputs(bundle) {
  return {
    decision: { outputs: { state: "RUN" } },
    push: { outputs: { pushed: "true" } },
    reverify: { outputs: { registered: "2", replay_bundle: bundle } },
  };
}

test("트리거: 2시간마다 정기 실행과 사람 dispatch뿐이고 push·workflow_run 트리거는 없다", () => {
  assert.deepEqual(Object.keys(workflow.on), ["schedule", "workflow_dispatch"]);
  assert.deepEqual(workflow.on.schedule, [{ cron: "23 */2 * * *" }]);
});

test("권한은 job에만 주고(actions: read, contents: write), 변수가 true일 때만 정기 실행이 돌며, 시간 상한이 있다", () => {
  assert.deepEqual(workflow.permissions, {});
  assert.equal(Object.keys(workflow.jobs).length, 1);
  assert.deepEqual(job.permissions, {
    actions: "read",
    contents: "write",
  });
  assert.doesNotMatch(yml, /actions: write|gh workflow run|repository_dispatch|pull-requests:\s*write|issues:\s*write/u);
  assert.equal(
    job.if,
    "${{ github.ref == 'refs/heads/main' && ((github.event_name == 'workflow_dispatch' && github.event.sender.type == 'User') || vars.DATAPACK_SCHEDULED_SOURCE_REVERIFICATION == 'true') }}",
  );
  assert.equal(job.environment, "datapack-release-check");
  assert.equal(job.timeoutMinutes, 90);
  const concurrencyGroup = workflow.concurrency.group;
  assert.deepEqual(workflow.concurrency, {
    group: "source-reverification-${{ github.workflow }}-${{ github.ref }}-${{ inputs.replay_run_id && format('replay-{0}', inputs.replay_run_id) || 'schedule' }}",
    "cancel-in-progress": false,
  });
  const baseGithub = { workflow: "Source Reverification", ref: "refs/heads/main" };
  const cronGroup = evaluateGithubTemplate(concurrencyGroup, { github: baseGithub, inputs: {} });
  const manualCollectGroup = evaluateGithubTemplate(concurrencyGroup, { github: baseGithub, inputs: { replay_run_id: "" } });
  const replayGroupA = evaluateGithubTemplate(concurrencyGroup, { github: baseGithub, inputs: { replay_run_id: "39369279984" } });
  const replayGroupB = evaluateGithubTemplate(concurrencyGroup, { github: baseGithub, inputs: { replay_run_id: "39369279985" } });
  assert.equal(cronGroup, "source-reverification-Source Reverification-refs/heads/main-schedule");
  assert.equal(manualCollectGroup, cronGroup, "일반 수동 수집과 정기 실행은 같은 수집 슬롯을 공유한다");
  assert.equal(replayGroupA, "source-reverification-Source Reverification-refs/heads/main-replay-39369279984");
  assert.notEqual(replayGroupA, cronGroup, "대기 중인 replay dispatch가 뒤따르는 정기 cron에 의해 대기열에서 대체되지 않는다");
  assert.notEqual(replayGroupA, replayGroupB, "서로 다른 원본 run 재생은 서로의 대기 슬롯을 덮어쓰지 않는다");
  assert.equal(
    evaluateGithubTemplate(concurrencyGroup, { github: baseGithub, inputs: { replay_run_id: "39369279984" } }),
    replayGroupA,
    "같은 replay_run_id 중복 dispatch는 같은 그룹에서 직렬화된다",
  );
  assert.deepEqual(workflow.env, {}, "no workflow-level env");
});

test("판정 step이 수집보다 먼저 돌고 빈 PR·이슈·claim 입력으로 단독 운영 판정을 수행한다", () => {
  const decision = step("Decide which P7D sources are due");
  assert.equal(decision.id, "decision");
  assert.doesNotMatch(yml, /gh pr list|gh pr create|gh issue |create-github-app-token|automation\//u);
  assert.match(decision.run, /printf '\[\]\\n' > "\$\{decision_root\}\/prs\.json"/u);
  assert.match(decision.run, /printf '\[\]\\n' > "\$\{decision_root\}\/runs\.json"/u);
  assert.match(decision.run, /printf '\[\]\\n' > "\$\{decision_root\}\/issues\.json"/u);
  assert.match(decision.run, /: > "\$\{decision_root\}\/automation-branches\.txt"/u);
  assert.match(decision.run, /echo "REVERIFICATION_MAIN_SHA=\$\(git rev-parse HEAD\)" >> "\$\{GITHUB_ENV\}"/u);
  assert.match(decision.run, /node tools\/ci\/decide-source-reverification\.mjs --inventory tools\/datapack\/source-inventory\.json --ledger tools\/datapack\/release\/source-snapshots\.json --policy release\/product-gates\/datapack-freshness-sla\.json --prs "[^"]+" --automation-branches "[^"]+" --runs "[^"]+" --issues "[^"]+" --repository "\$\{GITHUB_REPOSITORY\}" --pr-limit 1000 --run-limit 200 --issue-limit 1000 --call-budget release\/product-gates\/provider-daily-call-budget\.json --provider-call-ledger "\$\{decision_root\}\/provider-call-ledger\.json" --replay-run-id "\$\{REPLAY_RUN_ID\}" --allow-same-day-budget-retry "\$\{ALLOW_SAME_DAY_BUDGET_RETRY\}" --github-output "\$\{GITHUB_OUTPUT\}"/u);
  assert.equal(decision.env.REPLAY_RUN_ID, "${{ inputs.replay_run_id }}");
  assert.equal(
    decision.env.ALLOW_SAME_DAY_BUDGET_RETRY,
    "${{ github.event_name == 'workflow_dispatch' && github.event.sender.type == 'User' && inputs.allow_same_day_budget_retry == true && 'true' || 'false' }}",
  );
  before("Decide which P7D sources are due", "Reverify due P7D sources");
});

test("할 일 없음은 이유를 notice로 남기고 아무것도 쓰지 않으며 실패 목록을 요약 step에 넘긴다", () => {
  const idle = step("Note no P7D source is due");
  assert.equal(ifCondition(idle), "${{ steps.decision.outputs.state == 'NOT_DUE' }}");
  assert.match(idle.run, /::notice title=Source reverification::/u);
  const report = step("Report refresh failure summary");
  assert.match(report.run, /--run-id "\$\{GITHUB_RUN_ID\}" --failures "\$\{RUNNER_TEMP\}\/source-reverification\/\$\{GITHUB_RUN_ID\}\/operation\/failures\.json"/u);
  const reverify = step("Reverify due P7D sources").run;
  assert.match(reverify, /operation="\$\{RUNNER_TEMP\}\/source-reverification\/\$\{GITHUB_RUN_ID\}"/u);
  assert.match(reverify, /--operation-root "\$\{operation\}\/operation"/u);
});

test("controller는 RUN 판정일 때만 돌고 비밀은 이 step의 env로만 받으며 재생 run에는 공급자 키를 넘기지 않는다", () => {
  const reverify = step("Reverify due P7D sources");
  assert.equal(ifCondition(reverify), RUN);
  assert.equal(reverify.id, "reverify");
  assert.deepEqual(reverify.env, {
    DATA_GO_KR_SERVICE_KEY: "${{ steps.decision.outputs.replay_run_id == '' && secrets.DATA_GO_KR_SERVICE_KEY || '' }}",
    EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "${{ secrets.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL }}",
    KRIC_SERVICE_KEY: "${{ steps.decision.outputs.replay_run_id == '' && secrets.KRIC_SERVICE_KEY || '' }}",
    SEOUL_OPENAPI_KEY: "${{ steps.decision.outputs.replay_run_id == '' && secrets.EASYSUBWAY_SEOUL_TOPIS_SERVICE_KEY || '' }}",
    RECIPES: "${{ steps.decision.outputs.recipes }}",
    REPLAY_RUN_ID: "${{ steps.decision.outputs.replay_run_id }}",
  });
  assert.match(reverify.run, /git config user\.name "github-actions\[bot\]"/u);
  assert.match(reverify.run, /\[\[ "\$\(git rev-parse origin\/main\)" == "\$\{REVERIFICATION_MAIN_SHA\}" \]\]/u);
  assert.match(reverify.run, /node tools\/datapack\/run-source-reverification\.mjs --operation-root "\$\{operation\}\/operation" --recipes "\$\{RECIPES\}" --replay-bundle "\$\{operation\}\/replay-bundle" > "\$\{operation\}\/result\.json"/u);
  assert.match(reverify.run, /node tools\/datapack\/run-source-reverification\.mjs --operation-root "\$\{operation\}\/operation" --replay-from "\$\{RUNNER_TEMP\}\/source-reverification-replay\/\$\{GITHUB_RUN_ID\}" --replay-bundle "\$\{operation\}\/replay-bundle" > "\$\{operation\}\/result\.json"/u);
  assert.match(reverify.run, /echo "registered=\$\(jq '\.steps \| length' "\$\{operation\}\/result\.json"\)" >> "\$\{GITHUB_OUTPUT\}"/u);
  assert.equal(countMatches(yml, /secrets\.DATA_GO_KR_SERVICE_KEY/gu), 1, "the service key is only used by the controller step");
  assert.equal(countMatches(yml, /secrets\.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL/gu), 1, "the OCI base URL is only used by the controller step");
  assert.equal(countMatches(yml, /secrets\.KRIC_SERVICE_KEY/gu), 1, "the KRIC service key is only used by the controller step");
  assert.equal(countMatches(yml, /secrets\.EASYSUBWAY_SEOUL_TOPIS_SERVICE_KEY/gu), 1, "the Seoul OpenAPI key is only used by the controller step");
});

test("원장 변화 게이트는 controller 뒤에 base(main) 기준으로 돌고 출력은 Step Summary 증거 본문의 입력이다", () => {
  const reverify = step("Reverify due P7D sources").run;
  assert.match(reverify, /node tools\/ci\/source-ledger-gate\.mjs --base-sha "\$\{REVERIFICATION_MAIN_SHA\}" --output "\$\{operation\}\/gate\.json"/u);
  assert.ok(reverify.indexOf("run-source-reverification.mjs") < reverify.indexOf("source-ledger-gate.mjs"), "the gate checks the controller's commits");
  assert.match(reverify, /printf 'REVERIFICATION_RESULT=%s\\nREVERIFICATION_GATE=%s\\nREVERIFICATION_HEAD_SHA=%s\\n' "\$\{operation\}\/result\.json" "\$\{operation\}\/gate\.json" "\$\(git rev-parse HEAD\)" >> "\$\{GITHUB_ENV\}"/u);
  const push = step("Verify the reverification is based on the current main and push to main").run;
  assert.match(push, /node tools\/ci\/automation-pr-evidence\.mjs source-reverification-body --gate "\$\{REVERIFICATION_GATE\}" --result "\$\{REVERIFICATION_RESULT\}" --base-sha "\$\{REVERIFICATION_MAIN_SHA\}" --head-sha "\$\{REVERIFICATION_HEAD_SHA\}" --run-url "\$\{GITHUB_SERVER_URL\}\/\$\{GITHUB_REPOSITORY\}\/actions\/runs\/\$\{GITHUB_RUN_ID\}" --output "[^"]+"/u);
  assert.match(push, /cat "\$\{body\}" >> "\$\{GITHUB_STEP_SUMMARY\}"/u);
});

test("push는 읽은 main 그대로일 때만 HEAD:main으로 하고, main이 움직였으면 이상이 아니라 notice로 끝낸다", () => {
  const push = step("Verify the reverification is based on the current main and push to main");
  assert.equal(ifCondition(push), REGISTERED);
  assert.equal(push.id, "push");
  assert.equal(push.env.GH_TOKEN, "${{ github.token }}");
  assert.match(push.run, /git fetch --no-tags origin main/u);
  assert.match(push.run, /::notice title=Source reverification::main moved/u);
  assert.match(push.run, /echo "pushed=false" >> "\$\{GITHUB_OUTPUT\}"\n\s*exit 0/u);
  assert.match(push.run, /git push origin HEAD:main/u);
  assert.match(push.run, /echo "pushed=true" >> "\$\{GITHUB_OUTPUT\}"/u);
  assert.doesNotMatch(push.run, /git add|--force|-f /u);
  assert.equal(ifCondition(step("Note reverification superseded by a newer main")), "${{ steps.decision.outputs.state == 'RUN' && steps.reverify.outputs.registered != '0' && steps.push.outputs.pushed == 'false' }}");
});

test("실패한 recipe는 main push 뒤에 보고하고(always) job을 실패시켜 드러낸다", () => {
  const report = step("Report recipes that failed");
  assert.equal(ifCondition(report), "${{ always() && steps.reverify.outcome == 'success' }}");
  assert.match(report.run, /^set -euo pipefail\n(?:#[^\n]*\n)*node tools\/ci\/source-reverification-failures\.mjs --result "\$\{REVERIFICATION_RESULT\}"$/u);
  assert.equal(report.continueOnError, null);
  assert.doesNotMatch(report.block, /GH_TOKEN|secrets\./u);
  before("Verify the reverification is based on the current main and push to main", report.name);
  before(report.name, "Report refresh failure summary");
  assert.match(step("Reverify due P7D sources").run, /REVERIFICATION_RESULT=%s/u);
});

test("계측 파일 경로는 수집 전에 정하고 요약 step은 always()·continue-on-error로 마지막 보고 step 앞에서 돈다", () => {
  const record = step("Record source fetch attempts for the job summary");
  assert.match(record.run, /SOURCE_FETCH_TELEMETRY_PATH=\$\{RUNNER_TEMP\}\/source-fetch-telemetry\.jsonl" >> "\$\{GITHUB_ENV\}"/u);
  before(record.name, "Decide which P7D sources are due");
  const summary = step("Summarize source fetch attempts");
  assert.equal(ifCondition(summary), "${{ always() }}");
  assert.equal(summary.continueOnError, true);
  assert.match(summary.run, /node tools\/ci\/summarize-source-fetch-telemetry\.mjs --input "\$\{SOURCE_FETCH_TELEMETRY_PATH:-\}" >> "\$\{GITHUB_STEP_SUMMARY\}"/u);
  assert.equal(steps().filter(({ continueOnError }) => continueOnError).length, 1, "요약 step만 continue-on-error다");
  before("Reverify due P7D sources", summary.name);
  before(summary.name, "Report refresh failure summary");
});

test("실패 보고가 마지막 step이고 실패·취소와 연체 recipe를 모두 보고한다", () => {
  const report = assertFailureReportLast({ yml, step, file: FILE, condition: "${{ failure() || cancelled() || steps.decision.outputs.overdue_recipes != '' }}" });
  assert.equal(report.env.OVERDUE_RECIPES, "${{ job.status == 'success' && steps.decision.outputs.overdue_recipes || '' }}");
  assert.match(report.run, /--failures "[^"]+" --overdue "\$\{OVERDUE_RECIPES\}"$/mu);
});

test("run 스크립트에는 표현식을 직접 넣지 않는다", () => {
  assertNoExpressionInRunScripts({ steps, file: FILE });
});

test("action은 SHA로 고정하고 광역 스테이징·강제 push를 쓰지 않는다", () => {
  for (const [, reference] of yml.matchAll(/\n\s+uses: ([^\s]+)/gu)) assert.match(reference, /@[0-9a-f]{40}$/u, reference);
  assert.doesNotMatch(yml, /git add -A|git add \.|--force|push -f/u);
});

test("dispatch는 재생할 원본 run id(replay_run_id)와 같은 날 수동 예산 재시도 해금(allow_same_day_budget_retry)을 선택 입력으로 받는다", () => {
  const { inputs } = workflow.on.workflow_dispatch;
  assert.deepEqual(Object.keys(inputs), ["replay_run_id", "allow_same_day_budget_retry"]);
  assert.equal(inputs.replay_run_id.required, false);
  assert.equal(inputs.replay_run_id.default, "");
  assert.equal(inputs.replay_run_id.type, "string");
  assert.equal(inputs.allow_same_day_budget_retry.required, false);
  assert.equal(inputs.allow_same_day_budget_retry.default, false);
  assert.equal(inputs.allow_same_day_budget_retry.type, "boolean");
});

test("재생은 판정 뒤에 원본 run이 main의 이 workflow인지 확인하고 그 run의 artifact를 받은 뒤에 controller를 돌린다", () => {
  const verify = step("Verify the replay source run");
  assert.equal(ifCondition(verify), REPLAYING);
  assert.equal(verify.env.GH_TOKEN, "${{ github.token }}");
  assert.equal(verify.env.REPLAY_RUN_ID, "${{ steps.decision.outputs.replay_run_id }}");
  assert.match(verify.run, /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/actions\/runs\/\$\{REPLAY_RUN_ID\}" > "\$\{source_root\}\/run\.json"/u);
  assert.match(verify.run, /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/actions\/runs\/\$\{REPLAY_RUN_ID\}\/jobs\?filter=all&per_page=100" > "\$\{source_root\}\/jobs\.json"/u);
  assert.match(verify.run, /node tools\/ci\/verify-source-reverification-replay-run\.mjs --source-run-id "\$\{REPLAY_RUN_ID\}" --repository "\$\{GITHUB_REPOSITORY\}" --run "\$\{source_root\}\/run\.json" --jobs "\$\{source_root\}\/jobs\.json"$/u);
  assert.doesNotMatch(verify.block, /secrets\./u);
  const download = step("Download the retained reverification collection");
  assert.equal(ifCondition(download), REPLAYING);
  assert.equal(download.uses, "actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333");
  assert.equal(download.with["run-id"], "${{ steps.decision.outputs.replay_run_id }}");
  assert.equal(download.with.name, "source-reverification-${{ steps.decision.outputs.replay_run_id }}");
  assert.equal(download.with.path, "${{ runner.temp }}/source-reverification-replay/${{ github.run_id }}");
  before("Decide which P7D sources are due", verify.name);
  before(verify.name, download.name);
  before(download.name, "Reverify due P7D sources");
});

test("재생 원본 확인 도구가 읽는 workflow 경로·job 이름·step 이름은 이 workflow의 실제 이름이다", () => {
  assert.equal(SOURCE_REVERIFICATION_WORKFLOW_PATH, `.github/workflows/${FILE}`);
  assert.equal(job.id, "reverify");
  assert.equal(job.name, SOURCE_REVERIFICATION_JOB);
  for (const name of SOURCE_REVERIFICATION_REPLAY_SOURCE_STEPS) assert.equal(names().filter((stepName) => stepName === name).length, 1, name);
});

test("재생이 남긴 등록이 없으면 push 없이 이유를 notice로 남긴다", () => {
  const note = step("Note the replay left nothing to register");
  assert.equal(ifCondition(note), "${{ steps.decision.outputs.state == 'RUN' && steps.reverify.outputs.registered == '0' }}");
  assert.match(note.run, /::notice title=Source reverification::/u);
  assert.match(step("Reverify due P7D sources").run, /jq -r '\.dropped\[\]\? \| /u);
  before("Reverify due P7D sources", note.name);
});

test("재생 run이 main 이동 때문에 push하지 못하면 대기로 끝내지 않고 REVERIFICATION_REPLAY_BLOCKED로 실패한다", () => {
  const fail = step("Fail a replay that could not push to main");
  const condition = ifCondition(fail);
  assert.equal(
    evaluateGithubExpression(condition, { steps: replayOutputs({ reverify: { outputs: { registered: "3" } }, push: { outputs: { pushed: "false" } } }) }),
    true,
    "push 전에 main이 움직였다",
  );
  assert.equal(
    evaluateGithubExpression(condition, { steps: replayOutputs({ reverify: { outputs: { registered: "3" } }, push: { outputs: { pushed: "true" } } }) }),
    false,
    "push됐다",
  );
  assert.equal(
    evaluateGithubExpression(condition, { steps: replayOutputs({ reverify: { outputs: { registered: "0" } } }) }),
    false,
    "main이 이미 최신이라 등록할 것이 없다",
  );
  assert.equal(
    evaluateGithubExpression(condition, { steps: collectOutputs({ reverify: { outputs: { registered: "3" } }, push: { outputs: { pushed: "false" } } }) }),
    false,
    "수집 run은 다음 실행에 맡긴다",
  );
  assert.equal(fail.env.REPLAY_RUN_ID, "${{ steps.decision.outputs.replay_run_id }}");
  assert.match(fail.run, /::error title=Source reverification::REVERIFICATION_REPLAY_BLOCKED: [^\n]*replay_run_id=\$\{REPLAY_RUN_ID\}/u);
  assert.match(fail.run, /\nexit 1$/u);
  before("Verify the reverification is based on the current main and push to main", fail.name);
  before(fail.name, "Report refresh failure summary");
});

test("재생 묶음은 이 run이 묶음을 썼을 때만 main push 뒤 run id 이름의 artifact로 올리고 1일 보관한다", () => {
  const upload = step("Upload the retained collection for a later replay");
  const condition = ifCondition(upload);
  assert.equal(
    condition,
    "${{ steps.decision.outputs.state == 'RUN' && steps.reverify.outputs.registered != '0' && steps.push.outputs.pushed == 'true' && steps.reverify.outputs.replay_bundle == 'true' }}",
  );
  assert.equal(evaluateGithubExpression(condition, { steps: pushedOutputs("true") }), true);
  assert.equal(evaluateGithubExpression(condition, { steps: pushedOutputs("false") }), false, "재생할 수 있는 묶음을 등록하지 않은 run은 올릴 것이 없다");
  assert.equal(
    evaluateGithubExpression(condition, { steps: { ...pushedOutputs("true"), push: { outputs: { pushed: "false" } } } }),
    false,
    "push하지 않은 run의 묶음은 재생 원본이 아니다",
  );
  assert.equal(upload.uses, "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9");
  assert.deepEqual(upload.with, {
    name: "source-reverification-${{ github.run_id }}",
    path: "${{ runner.temp }}/source-reverification/${{ github.run_id }}/replay-bundle",
    "if-no-files-found": "error",
    "retention-days": "1",
  });
  const reverify = step("Reverify due P7D sources").run;
  assert.match(reverify, /\[\[ -f "\$\{operation\}\/replay-bundle\/manifest\.json" \]\]/u);
  assert.match(reverify, /echo "replay_bundle=true" >> "\$\{GITHUB_OUTPUT\}"/u);
  assert.match(reverify, /echo "replay_bundle=false" >> "\$\{GITHUB_OUTPUT\}"/u);
  assert.match(reverify, /::notice title=Source reverification::no replayable dependency group was registered/u);
  before("Verify the reverification is based on the current main and push to main", upload.name);
});

test("판정 전에 같은 날 앞선 run의 공급자 호출 기록을 읽고 판정에 넘긴다", () => {
  const decision = step("Decide which P7D sources are due");
  assert.equal(decision.env.GITHUB_TOKEN, "${{ github.token }}");
  const ledger = decision.run.indexOf('node tools/ci/provider-call-ledger.mjs --ledger "${decision_root}/provider-call-ledger.json"');
  assert.ok(ledger !== -1 && ledger < decision.run.indexOf("node tools/ci/decide-source-reverification.mjs"), "the call ledger is read before the decision");
  before("Decide which P7D sources are due", "Reverify due P7D sources");
});

test("시도별 계측 파일은 판정 전에 빈 파일로 만들고, 모든 run이 실패·취소에도 그 파일을 run id 이름의 artifact로 2일 보관한다", () => {
  const record = step("Record source fetch attempts for the job summary");
  assert.match(record.run, /: > "\$\{RUNNER_TEMP\}\/source-fetch-telemetry\.jsonl"/u);
  const upload = step("Upload provider call evidence");
  assert.equal(ifCondition(upload), "${{ always() }}");
  assert.match(upload.uses, /^actions\/upload-artifact@[0-9a-f]{40}$/u);
  assert.deepEqual(upload.with, {
    name: `${SOURCE_REVERIFICATION_CALL_EVIDENCE.artifactPrefix}-\${{ github.run_id }}`,
    path: `\${{ runner.temp }}/${SOURCE_REVERIFICATION_CALL_EVIDENCE.file}`,
    "if-no-files-found": "error",
    "retention-days": "2",
  });
  before("Reverify due P7D sources", upload.name);
  before(upload.name, "Report refresh failure summary");
});

test("호출 기록이 읽는 job·step 이름은 이 workflow의 실제 이름이다", () => {
  assert.equal(SOURCE_REVERIFICATION_CALL_EVIDENCE.workflowFile, FILE);
  assert.equal(job.name, SOURCE_REVERIFICATION_JOB);
  assert.ok(names().includes(SOURCE_REVERIFICATION_CALL_EVIDENCE.collectorStepName));
  assert.deepEqual([...SOURCE_REVERIFICATION_CALL_EVIDENCE.events].sort(), ["schedule", "workflow_dispatch"]);
});

test("예산·시도 상한에 막힌 묶음은 main 반영 뒤 이름 있는 코드로 job을 실패시켜 드러난다", () => {
  const blocked = step(PROVIDER_BUDGET_BLOCK_STEP);
  assert.equal(ifCondition(blocked), "${{ always() && steps.decision.outputs.budget_blocked != '' }}");
  assert.equal(blocked.env.BUDGET_BLOCKED, "${{ steps.decision.outputs.budget_blocked }}");
  assert.equal(blocked.env.BUDGET_BLOCKED_REASON, "${{ steps.decision.outputs.budget_blocked_reason }}");
  assert.match(blocked.run, /echo "::error title=Source reverification::\$\{BUDGET_BLOCKED\} not collected today: \$\{BUDGET_BLOCKED_REASON\}"\n\s*exit 1/u);
  before("Verify the reverification is based on the current main and push to main", blocked.name);
  before(blocked.name, "Report refresh failure summary");
});
