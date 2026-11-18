import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { evaluateGithubTemplate } from "./github-expression.mjs";
import { assertFailureReportLast, assertNoExpressionInRunScripts, ifCondition, loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";

// ITX-청춘 원천 시간표 자동 승격 workflow 계약(단독 운영).
// 정기 실행은 저장소 변수 DATAPACK_SCHEDULED_ITX_PROMOTION이 true일 때만 돈다. 게이트 통과분은 main에 직접 push한다.
const FILE = "itx-current-promotion.yml";
const { yml, workflow, job, steps, step } = loadWorkflow(path.resolve(import.meta.dirname, "../.."), FILE);
// 주석은 설명이다. 동작을 보는 단언은 주석을 뺀 본문에만 건다.
const code = yml.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
const COLLECT = "${{ steps.decision.outputs.state == 'COLLECT' }}";
// 공급자를 부르는 step은 재생 요청이 없을 때만, 보관 capture를 되살리는 step은 재생 요청이 있을 때만 돈다.
const COLLECT_LIVE = "${{ steps.decision.outputs.state == 'COLLECT' && steps.decision.outputs.replay_run_id == '' }}";
const COLLECT_REPLAY = "${{ steps.decision.outputs.state == 'COLLECT' && steps.decision.outputs.replay_run_id != '' }}";
const RESTORE_STEPS = ["Download retained ITX collection evidence", "Restore retained ITX collection evidence"];
const DECISION = "Decide whether ITX promotion is due";

function extractPinValue(text, key) {
  return new RegExp(`${key}="?([0-9a-f]{40,64})"?`, "u").exec(text)?.[1];
}

test("정기 실행 변수는 코드가 켜지 않고 QA 보고 뒤 별도 설정 변경으로만 켠다고 workflow가 스스로 밝힌다", () => {
  const header = yml.split("\n").filter((line) => line.startsWith("#")).join("\n");
  assert.match(header, /#981/u);
  assert.match(header, /DATAPACK_SCHEDULED_ITX_PROMOTION[^\n]*QA 보고 뒤[^\n]*설정 변경/u);
  assert.doesNotMatch(header, /#979 본문 참조/u);
  assert.doesNotMatch(code, /DATAPACK_SCHEDULED_ITX_PROMOTION[^\n]*(?:=|:)\s*['"]?true['"]?\s*$/mu);
});

test("트리거: 3시간마다 정기 실행과 사람 dispatch(force_collect·replay_run_id). push 트리거는 없다", () => {
  assert.deepEqual(Object.keys(workflow.on), ["schedule", "workflow_dispatch"]);
  assert.deepEqual(workflow.on.schedule, [{ cron: "0 */3 * * *" }]);
  const { inputs } = workflow.on.workflow_dispatch;
  assert.deepEqual(Object.keys(inputs), ["force_collect", "replay_run_id"]);
  assert.equal(inputs.force_collect.required, false);
  assert.equal(inputs.force_collect.default, false);
  assert.equal(inputs.force_collect.type, "boolean");
  assert.equal(inputs.replay_run_id.required, false);
  assert.equal(inputs.replay_run_id.default, "");
  assert.equal(inputs.replay_run_id.type, "string");
});

test("권한은 workflow 전체가 아니라 job에만 준다(actions: read, contents: write)", () => {
  assert.deepEqual(workflow.permissions, {});
  assert.equal(Object.keys(workflow.jobs).length, 1);
  assert.deepEqual(job.permissions, {
    actions: "read",
    contents: "write",
  });
  assert.doesNotMatch(yml, /pull-requests:\s*write|issues:\s*write|gh pr create|create-github-app-token|automation\//u);
});

test("정기 실행은 저장소 변수가 true일 때만 돌고 사람 dispatch는 항상 돈다. 변수 기본값은 꺼짐이다", () => {
  assert.equal(
    job.if,
    "${{ github.ref == 'refs/heads/main' && ((github.event_name == 'workflow_dispatch' && github.event.sender.type == 'User') || vars.DATAPACK_SCHEDULED_ITX_PROMOTION == 'true') }}",
  );
  assert.doesNotMatch(yml, /gh variable|gh api[^\n]*variables/u);
});

test("job은 공급자·OCI secret이 있는 datapack-release-check 환경에서 돌고 이름이 예산 가드의 등록과 같다", () => {
  assert.equal(job.name, "ITX current promotion");
  assert.equal(job.environment, "datapack-release-check");
  const concurrencyGroup = workflow.concurrency.group;
  assert.deepEqual(workflow.concurrency, {
    group: "itx-current-promotion-main-${{ inputs.replay_run_id && format('replay-{0}', inputs.replay_run_id) || 'schedule' }}",
    "cancel-in-progress": false,
  });
  const cronGroup = evaluateGithubTemplate(concurrencyGroup, { inputs: {} });
  const forceCollectGroup = evaluateGithubTemplate(concurrencyGroup, { inputs: { force_collect: true, replay_run_id: "" } });
  const replayGroupA = evaluateGithubTemplate(concurrencyGroup, { inputs: { replay_run_id: "24090001001" } });
  const replayGroupB = evaluateGithubTemplate(concurrencyGroup, { inputs: { replay_run_id: "24090001002" } });
  assert.equal(cronGroup, "itx-current-promotion-main-schedule");
  assert.equal(forceCollectGroup, cronGroup, "일반·강제 수집 dispatch와 정기 실행은 같은 수집 슬롯을 공유한다");
  assert.equal(replayGroupA, "itx-current-promotion-main-replay-24090001001");
  assert.notEqual(replayGroupA, cronGroup, "대기 중인 replay dispatch가 뒤따르는 정기 cron에 의해 대기열에서 대체되지 않는다");
  assert.notEqual(replayGroupA, replayGroupB, "서로 다른 원본 run 재생은 서로의 대기 슬롯을 덮어쓰지 않는다");
  assert.equal(
    evaluateGithubTemplate(concurrencyGroup, { inputs: { replay_run_id: "24090001001" } }),
    replayGroupA,
    "같은 replay_run_id 중복 dispatch는 같은 그룹에서 직렬화된다",
  );
});

test("판정 step이 공급자 접근·쓰기보다 먼저 돌고 빈 PR·브랜치 입력으로 단독 판정을 수행한다", () => {
  const all = steps();
  const decisionIndex = all.findIndex(({ name }) => name === DECISION);
  const guardIndex = all.findIndex(({ name }) => name === "Guard KST quota window");
  const collectIndex = all.findIndex(({ name }) => name === "Collect current ITX timetable");
  assert.ok(decisionIndex !== -1 && decisionIndex < guardIndex && guardIndex < collectIndex);
  const decision = all[decisionIndex];
  assert.equal(decision.id, "decision");
  assert.equal(decision.env.GH_TOKEN, "${{ github.token }}");
  assert.equal(decision.env.GITHUB_TOKEN, "${{ github.token }}");
  assert.equal(decision.env.FORCE_COLLECT, "${{ inputs.force_collect }}");
  assert.equal(decision.env.REPLAY_RUN_ID, "${{ inputs.replay_run_id }}");
  assert.match(decision.run, /: > "\$\{decision_root\}\/branches\.txt"/u);
  assert.match(decision.run, /printf '\[\]\\n' > "\$\{decision_root\}\/prs\.json"/u);
  assert.match(decision.run, /printf 'ITX_BASE_SHA=%s\\n' "\$\(git rev-parse HEAD\)" >> "\$\{GITHUB_ENV\}"/u);
  assert.match(decision.run, /node tools\/ci\/decide-itx-current-promotion\.mjs --contract tools\/datapack\/itx-cheongchun-coverage-contract\.json /u);
  assert.match(decision.run, /--repository "\$\{GITHUB_REPOSITORY\}" --pr-limit 1000 --force "\$\{force\}" --itx-collection-ledger "\$\{decision_root\}\/itx-collection-ledger\.json" --replay-run-id "\$\{REPLAY_RUN_ID\}" --github-output "\$\{GITHUB_OUTPUT\}"/u);
  assert.match(decision.run, /node tools\/ci\/guard-itx-current-collection-budget\.mjs --ledger "\$\{decision_root\}\/itx-collection-ledger\.json"\n/u);
  assert.doesNotMatch(decision.run, /--probe|--itx-collected-today/u);
  assert.ok(decision.run.indexOf("guard-itx-current-collection-budget.mjs --ledger") < decision.run.indexOf("decide-itx-current-promotion.mjs"));
  assert.doesNotMatch(decision.block, /DATA_GO_KR_SERVICE_KEY/u);
});

test("수집·게이트·승격·main 직접 push는 모두 COLLECT일 때만 돈다", () => {
  for (const name of [
    "Prepare current ITX promotion",
    "Replay retained capture offline",
    "Evaluate promotion gate",
    "Verify pinned Mobile fixture ref exists",
    "Checkout pinned Mobile input fixture",
    "Stage pinned Mobile input fixture",
    "Promote the gated candidate",
    "Commit and push ITX promotion and rebinding outputs",
  ]) {
    assert.equal(ifCondition(step(name)), COLLECT, name);
  }
});

test("공급자를 부르는 step(예산 가드·수집)은 재생 요청이 없을 때만, 증거를 되살리는 step은 재생 요청이 있을 때만 돈다", () => {
  for (const name of ["Guard KST quota window", "Collect current ITX timetable"]) assert.equal(ifCondition(step(name)), COLLECT_LIVE, name);
  for (const name of RESTORE_STEPS) assert.equal(ifCondition(step(name)), COLLECT_REPLAY, name);
  assert.ok(!RESTORE_STEPS.includes("Collect current ITX timetable"));
});

test("재생 요청은 원본 run의 artifact를 같은 저장소·run id·이름으로만 받고 공급자 키를 쓰지 않는다", () => {
  const download = step("Download retained ITX collection evidence");
  assert.equal(download.uses, "actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333");
  assert.equal(download.with.repository, "${{ github.repository }}");
  assert.equal(download.with["run-id"], "${{ steps.decision.outputs.replay_run_id }}");
  assert.equal(download.with.name, "itx-current-promotion-${{ steps.decision.outputs.replay_run_id }}");
  assert.equal(download.with["github-token"], "${{ github.token }}");
  const restore = step("Restore retained ITX collection evidence");
  assert.equal(restore.env.REPLAY_RUN_ID, "${{ steps.decision.outputs.replay_run_id }}");
  assert.doesNotMatch(restore.block, /inputs\.replay_run_id/u);
  assert.match(restore.run, /node tools\/ci\/restore-itx-replay-evidence\.mjs --source-run-id "\$\{REPLAY_RUN_ID\}" --repository "\$\{GITHUB_REPOSITORY\}" --run "[^"]+" --jobs "[^"]+" --artifact-dir "[^"]+" --contract tools\/datapack\/itx-cheongchun-coverage-contract\.json --output-root "\$\{ITX_OPERATION_ROOT\}"/u);
  assert.doesNotMatch(restore.block, /DATA_GO_KR_SERVICE_KEY|run-current-itx-collection|continue-on-error|\|\| true/u);
  const names = steps().map(({ name }) => name);
  assert.ok(names.indexOf("Collect current ITX timetable") < names.indexOf(RESTORE_STEPS[0]));
  assert.ok(names.indexOf(RESTORE_STEPS[0]) < names.indexOf(RESTORE_STEPS[1]));
  assert.ok(names.indexOf(RESTORE_STEPS[1]) < names.indexOf("Replay retained capture offline"));
});

test("재생 요청은 공급자 키 형식 검사를 건너뛰고 평소 수집은 그대로 검사한다", () => {
  const prepare = step("Prepare current ITX promotion");
  assert.equal(prepare.env.REPLAY_RUN_ID, "${{ steps.decision.outputs.replay_run_id }}");
  assert.match(prepare.run, /if \[\[ -z "\$\{REPLAY_RUN_ID\}" && \( -z "\$\{DATA_GO_KR_SERVICE_KEY:-\}"/u);
  assert.match(prepare.run, /nonempty single line/u);
});

test("순서: 준비 -> 예산 가드 -> 수집 -> 오프라인 replay -> 게이트 -> fixture 확인·checkout·stage -> 승격(--rebind) -> 커밋·main push", () => {
  const names = steps().map(({ name }) => name);
  const order = [
    DECISION, "Prepare current ITX promotion", "Guard KST quota window", "Collect current ITX timetable", ...RESTORE_STEPS, "Replay retained capture offline",
    "Evaluate promotion gate", "Verify pinned Mobile fixture ref exists", "Checkout pinned Mobile input fixture", "Stage pinned Mobile input fixture",
    "Promote the gated candidate", "Commit and push ITX promotion and rebinding outputs",
  ];
  const indexes = order.map((name) => names.indexOf(name));
  assert.ok(indexes.every((index) => index !== -1), indexes.join(","));
  assert.deepEqual([...indexes].sort((left, right) => left - right), indexes);
});

test("공급자 키는 수집 step에서만 받고 형식을 먼저 검사한다. 키를 출력하지 않는다", () => {
  const withKey = steps().filter(({ block }) => block.includes("secrets.DATA_GO_KR_SERVICE_KEY"));
  assert.deepEqual(withKey.map(({ name }) => name).sort(), ["Collect current ITX timetable", "Prepare current ITX promotion"]);
  const prepare = step("Prepare current ITX promotion").run;
  assert.match(prepare, /nonempty single line/u);
  assert.match(prepare, /node tools\/datapack\/emit-station-catalog-pack\.mjs --output "\$\{ITX_OPERATION_ROOT\}\/station-catalog-pack" --catalog-pack-id "itx-current-station-catalog-v1"/u);
  assert.doesNotMatch(code, /(echo|printf|cat)[^\n]*\$\{?DATA_GO_KR_SERVICE_KEY/u);
  assert.doesNotMatch(yml, /::add-mask::/u);
});

test("예산 가드는 같은 KST 날의 성공·진행 중 수집을 막고 실패한 수집만 예산 안에서 다시 허용하며 collector step 이름이 가드의 등록과 같다", () => {
  const guard = step("Guard KST quota window");
  assert.equal(guard.env.GITHUB_TOKEN, "${{ github.token }}");
  assert.match(guard.run, /node tools\/ci\/guard-itx-current-collection-budget\.mjs --output "\$\{ITX_OPERATION_ROOT\}\/freshness\.json" --allow-after-failure/u);
});

test("수집은 collector를 한 번만 부르고 게이트는 수집 결과·capture·replay·정책으로 판정한다", () => {
  const collect = step("Collect current ITX timetable").run;
  assert.equal([...collect.matchAll(/run-current-itx-collection\.mjs/gu)].length, 1);
  assert.match(collect, /--output "\$\{ITX_OPERATION_ROOT\}\/itx-result\.json" --completeness-output "\$\{ITX_OPERATION_ROOT\}\/itx-completeness\.json" --station-catalog-pack "\$\{ITX_OPERATION_ROOT\}\/station-catalog-pack" --freshness-output "\$\{ITX_OPERATION_ROOT\}\/freshness\.json"/u);
  assert.doesNotMatch(collect, /retry|for attempt|until /u);
  const replay = step("Replay retained capture offline").run;
  assert.match(replay, /node tools\/datapack\/replay-current-itx-collection\.mjs --capture "\$\{ITX_OPERATION_ROOT\}\/provider-response-capture\.json" --output "\$\{ITX_OPERATION_ROOT\}\/itx-replay\.json" --station-catalog-pack "\$\{ITX_OPERATION_ROOT\}\/station-catalog-pack"/u);
  assert.doesNotMatch(replay, /DATA_GO_KR_SERVICE_KEY/u);
  const gate = step("Evaluate promotion gate");
  assert.match(gate.run, /node tools\/datapack\/itx-promotion-gate\.mjs --candidate "\$\{ITX_OPERATION_ROOT\}\/itx-result\.json" --completeness "\$\{ITX_OPERATION_ROOT\}\/itx-completeness\.json" --capture "\$\{ITX_OPERATION_ROOT\}\/provider-response-capture\.json" --replay "\$\{ITX_OPERATION_ROOT\}\/itx-replay\.json" --coverage-contract "\$\{GITHUB_WORKSPACE\}\/tools\/datapack\/itx-cheongchun-coverage-contract\.json" --policy "\$\{GITHUB_WORKSPACE\}\/tools\/datapack\/itx-promotion-gate-policy\.json" --output "\$\{ITX_OPERATION_ROOT\}\/itx-promotion-gate\.json"/u);
  assert.equal(gate.continueOnError, null);
  assert.doesNotMatch(gate.run, /\|\| true/u);
});

test("승격은 승인 코멘트 없이 게이트 경로로만 돌고, 수동 승인 경로를 쓰는 인자가 없으며, raw capture OCI 발행을 위해 preauth URL을 받는다", () => {
  const promoteStep = step("Promote the gated candidate");
  const promote = promoteStep.run;
  assert.equal(promoteStep.env.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL, "${{ secrets.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL }}");
  assert.match(promote, /node tools\/datapack\/collect-korail-itx-cheongchun-timetable\.mjs --promote-candidate "\$\{ITX_OPERATION_ROOT\}\/itx-result\.json" --completeness-evidence "\$\{ITX_OPERATION_ROOT\}\/itx-completeness\.json"/u);
  assert.match(promote, /--auto-gate --provider-capture "\$\{ITX_OPERATION_ROOT\}\/provider-response-capture\.json" --replay-evidence "\$\{ITX_OPERATION_ROOT\}\/itx-replay\.json"/u);
  assert.doesNotMatch(code, /--approval-url|--approved-sha256|approve-itx-current/u);
});

test("커밋은 허용 경로만 명시적으로 스테이징하고 main CAS 검사 후 HEAD:main push 및 Step Summary 기록 순서다", () => {
  const pushStep = step("Commit and push ITX promotion and rebinding outputs");
  assert.equal(pushStep.id, "push");
  assert.equal(pushStep.env.GH_TOKEN, "${{ github.token }}");
  const run = pushStep.run;
  assert.doesNotMatch(run, /git add (-A|--all|\.)(\s|$)/u);
  assert.match(run, /itxPromotionAllowedPaths\(process\.argv\[1\]\)/u);
  assert.match(run, /\[\[ "\$\{#changed\[@\]\}" == "\$\{#paths\[@\]\}" \]\]/u);
  assert.match(run, /tools\/datapack\/itx-cheongchun-coverage-contract\.json/u);
  const fetchMain = run.indexOf("git fetch --no-tags origin main");
  const add = run.indexOf('git add -- "${paths[@]}"');
  const commit = run.indexOf("git commit");
  const body = run.indexOf('node tools/ci/automation-pr-evidence.mjs itx-promotion-body --receipt');
  const push = run.indexOf("git push origin HEAD:main");
  const summary = run.indexOf('cat "${evidence_root}/body.md" >> "${GITHUB_STEP_SUMMARY}"');
  assert.ok(fetchMain !== -1 && fetchMain < add && add < commit && commit < body && body < push && push < summary, [fetchMain, add, commit, body, push, summary].join(","));
  assert.match(run, /::notice title=ITX promotion::main moved/u);
  assert.match(run, /echo "pushed=false" >> "\$\{GITHUB_OUTPUT\}"\n\s*exit 0/u);
  assert.match(run, /echo "pushed=true" >> "\$\{GITHUB_OUTPUT\}"/u);
  assert.match(run, /--base-sha "\$\{base_sha\}" --head-sha "\$\(git rev-parse HEAD\)" --run-url "\$\{GITHUB_SERVER_URL\}\/\$\{GITHUB_REPOSITORY\}\/actions\/runs\/\$\{GITHUB_RUN_ID\}" --output "\$\{evidence_root\}\/body\.md"/u);
  assert.match(run, /promotion changed an unsupported path/u);
});

test("수집할 때가 아닌 실행은 이유를 notice로 남기고 아무것도 쓰지 않는다", () => {
  const wait = step("Note ITX promotion is not due");
  assert.equal(ifCondition(wait), "${{ steps.decision.outputs.state == 'WAIT' }}");
  assert.equal(wait.env.DAYS_UNTIL_EXPIRY, "${{ steps.decision.outputs.days_until_expiry }}");
  assert.match(wait.run, /::notice title=ITX promotion::/u);
});

test("공급자 호출 전 판정이 WAIT인 실행은 collector step이 skipped라 예산을 쓰지 않는다", () => {
  assert.equal(ifCondition(step("Collect current ITX timetable")), COLLECT_LIVE);
});

test("증거 artifact는 수집을 시도한 실행에서 항상 올리고 비밀·키를 담지 않는다", () => {
  const upload = step("Upload sanitized promotion evidence");
  assert.equal(ifCondition(upload), "${{ always() && steps.decision.outputs.state == 'COLLECT' }}");
  assert.equal(upload.uses, "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9");
  assert.equal(upload.with.name, "itx-current-promotion-${{ github.run_id }}");
  for (const file of ["freshness.json", "itx-result.json", "itx-completeness.json", "provider-response-capture.json", "itx-replay.json", "itx-promotion-gate.json"]) {
    assert.ok(upload.with.path.includes(`itx-current-promotion/\${{ github.run_id }}/${file}`) || upload.with.path.includes(`/${file}`), file);
  }
  assert.doesNotMatch(upload.with.path, /station-catalog-pack/u);
  assert.equal(upload.with["retention-days"], "14");
});

test("신선도가 이미 끊긴 뒤의 복구 수집은 main push 뒤 실패로 끝내 이상을 드러낸다", () => {
  const lapsed = step("Surface a lapsed freshness");
  assert.equal(ifCondition(lapsed), "${{ steps.decision.outputs.state == 'COLLECT' && steps.decision.outputs.lapsed == 'true' }}");
  const names = steps().map(({ name }) => name);
  assert.ok(names.indexOf("Commit and push ITX promotion and rebinding outputs") < names.indexOf(lapsed.name));
  assert.match(lapsed.run, /exit 1/u);
});

test("게이트 차단·수집 실패·취소는 job을 실패시키고 실패 요약 보고가 마지막 step이다", () => {
  assertFailureReportLast({ yml, step, file: FILE, condition: "${{ failure() || cancelled() }}" });
});

test("이 workflow는 workflow dispatch를 호출하지 않고 run 스크립트에 표현식을 직접 넣지 않는다", () => {
  assert.doesNotMatch(yml, /gh workflow run|\/dispatches|repository_dispatch|actions: write/u);
  assertNoExpressionInRunScripts({ steps, file: FILE });
});

test("재결속은 CI와 같은 고정 mobile 입력 fixture에서 돌고 증거·fixture를 함께 커밋한다", () => {
  const ci = readFileSync(path.resolve(import.meta.dirname, "../../.github/workflows/ci.yml"), "utf8");
  const stage = step("Stage pinned Mobile input fixture").run;
  const ciStage = /- name: Stage pinned Mobile fixture[\s\S]*?\n      - name:/u.exec(ci)[0];
  assert.equal(extractPinValue(stage, "expected_revision"), extractPinValue(ciStage, "expected_revision"));
  assert.equal(extractPinValue(stage, "expected_sha256"), extractPinValue(ciStage, "expected_sha256"));
  const checkoutFixture = step("Checkout pinned Mobile input fixture");
  assert.equal(checkoutFixture.with.ref, "data-fixture/basemap-textnomerge-1495");
  assert.equal(checkoutFixture.with["persist-credentials"], "false");
  for (const name of ["Verify pinned Mobile fixture ref exists", "Checkout pinned Mobile input fixture", "Stage pinned Mobile input fixture"]) {
    assert.equal(ifCondition(step(name)), COLLECT, name);
  }
  assert.equal(steps().some(({ name }) => name === "Rebind derived ITX bindings"), false);
  const promote = step("Promote the gated candidate").run;
  assert.match(promote, /--auto-gate --provider-capture "\$\{ITX_OPERATION_ROOT\}\/provider-response-capture\.json" --replay-evidence "\$\{ITX_OPERATION_ROOT\}\/itx-replay\.json" --rebind(?:\s|$)/u);
  assert.doesNotMatch(promote, /continue-on-error|\|\| true|DATA_GO_KR_SERVICE_KEY/u);
});
