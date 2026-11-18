import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { assertFailureReportLast, assertNoExpressionInRunScripts, ifCondition, loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";
import { evaluateGithubExpression } from "./github-expression.mjs";

// 전국 후보 갱신 workflow 계약(단독 운영). 입력이 바뀌었을 때(STALE) 또는 사람 명시 요청(FORCED)일 때만 후보를 갱신해 main에 직접 push하고 RC 체인을 dispatch한다.
const FILE = "nationwide-candidate-refresh.yml";
const { yml, workflow, job, steps, step } = loadWorkflow(path.resolve(import.meta.dirname, "../.."), FILE);
const PROCEED = "${{ steps.decision.outputs.state == 'STALE' || steps.decision.outputs.state == 'FORCED' }}";
const DISPATCH = "${{ (steps.decision.outputs.state == 'STALE' || steps.decision.outputs.state == 'FORCED') && steps.push.outputs.pushed == 'true' }}";

function extractStepSecrets(block) {
  const names = new Set();
  for (const match of block.matchAll(/(?<![\w.-])secrets\.([A-Za-z_][A-Za-z0-9_]*)/gu)) {
    names.add(match[1]);
  }
  return [...names].sort();
}

function collectReferencedSecrets(stepList) {
  const entries = [];
  for (const item of stepList) {
    const names = extractStepSecrets(item.block);
    if (names.length > 0) entries.push([item.name, names]);
  }
  return Object.fromEntries(entries);
}

test("트리거: 2시간마다 정기 폴링과 사람 dispatch(2인 역할 입력 유지), push 트리거는 없다", () => {
  assert.deepEqual(Object.keys(workflow.on), ["schedule", "workflow_dispatch"]);
  assert.deepEqual(workflow.on.schedule, [{ cron: "29 */2 * * *" }]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ["releaseSequence", "requestedBy", "approvedBy"]);
});

test("권한은 job에만 주고(actions: write, contents: write), PR·이슈 쓰기 권한은 없다", () => {
  assert.deepEqual(workflow.permissions, {});
  assert.equal(Object.keys(workflow.jobs).length, 1);
  assert.deepEqual(job.permissions, {
    actions: "write",
    contents: "write",
  });
  assert.doesNotMatch(yml, /pull-requests:\s*write|issues:\s*write|gh pr create|create-github-app-token|automation\//u);
});

test("정기 실행과 스케줄러 dispatch는 저장소 변수가 true일 때만 돌고, 사람 dispatch는 항상 돈다", () => {
  const condition = "${{ github.ref == 'refs/heads/main' && ((github.event_name == 'workflow_dispatch' && github.event.sender.type == 'User') || vars.DATAPACK_SCHEDULED_CANDIDATE_REFRESH == 'true') }}";
  assert.equal(job.if, condition);
  const main = { ref: "refs/heads/main" };
  for (const vars of [{}, { DATAPACK_SCHEDULED_CANDIDATE_REFRESH: "false" }, { DATAPACK_SCHEDULED_CANDIDATE_REFRESH: "true" }]) {
    assert.equal(
      evaluateGithubExpression(condition, { github: { ...main, event_name: "workflow_dispatch", event: { sender: { type: "User" } } }, vars }),
      true,
      `사람 dispatch ${JSON.stringify(vars)}`,
    );
  }
  for (const [event_name, senderType] of [["schedule", undefined], ["workflow_dispatch", "Bot"]]) {
    const github = { ...main, event_name, event: senderType === undefined ? {} : { sender: { type: senderType } } };
    assert.equal(evaluateGithubExpression(condition, { github, vars: {} }), false, `${event_name} 변수 없음`);
    assert.equal(evaluateGithubExpression(condition, { github, vars: { DATAPACK_SCHEDULED_CANDIDATE_REFRESH: "false" } }), false, `${event_name} 변수 false`);
    assert.equal(evaluateGithubExpression(condition, { github, vars: { DATAPACK_SCHEDULED_CANDIDATE_REFRESH: "true" } }), true, `${event_name} 변수 true`);
  }
  assert.equal(
    evaluateGithubExpression(condition, { github: { ref: "refs/heads/feature", event_name: "workflow_dispatch", event: { sender: { type: "User" } } }, vars: {} }),
    false,
    "main이 아닌 ref",
  );
});

test("dispatch 입력은 선택이다: 스케줄러는 입력 없이 깨우고 사람 입력 검증은 plan 단계가 한다", () => {
  for (const input of ["releaseSequence", "requestedBy", "approvedBy"]) {
    assert.equal(workflow.on.workflow_dispatch.inputs[input].required, false, input);
  }
  const validate = step("Validate candidate refresh inputs");
  assert.equal(validate.env.ACTOR, "${{ github.actor }}");
  assert.equal(validate.env.TRIGGERING_ACTOR, "${{ github.triggering_actor }}");
  assert.match(validate.run, /--event "\$\{EVENT_NAME\}" --actor "\$\{ACTOR\}" --triggering-actor "\$\{TRIGGERING_ACTOR\}" --github-output/u);
});

test("판정 step이 입력 검증·후보 생성보다 먼저 돌고 빈 PR·브랜치 입력으로 단독 판정을 수행한다", () => {
  const all = steps();
  const decisionIndex = all.findIndex(({ name }) => name === "Decide whether the nationwide candidate must be refreshed");
  const planIndex = all.findIndex(({ name }) => name === "Validate candidate refresh inputs");
  assert.ok(decisionIndex !== -1 && decisionIndex < planIndex);
  const decision = all[decisionIndex];
  assert.equal(decision.id, "decision");
  assert.equal(decision.env.GH_TOKEN, "${{ github.token }}");
  assert.equal(decision.env.EVENT_NAME, "${{ github.event_name }}");
  assert.equal(decision.env.ACTOR, "${{ github.actor }}");
  assert.equal(decision.env.TRIGGERING_ACTOR, "${{ github.triggering_actor }}");
  assert.match(decision.run, /: > "\$\{decision_root\}\/branches\.txt"/u);
  assert.match(decision.run, /: > "\$\{decision_root\}\/automation-branches\.txt"/u);
  assert.match(decision.run, /printf '\[\]\\n' > "\$\{decision_root\}\/prs\.json"/u);
  assert.match(decision.run, /printf 'CANDIDATE_BASE_SHA=%s\\n' "\$\(git rev-parse HEAD\)" >> "\$\{GITHUB_ENV\}"/u);
  assert.match(decision.run, /node tools\/ci\/decide-nationwide-candidate-refresh\.mjs --event "\$\{EVENT_NAME\}" --actor "\$\{ACTOR\}" --triggering-actor "\$\{TRIGGERING_ACTOR\}" --repository "\$\{GITHUB_REPOSITORY\}" --prs "[^"]+" --branches "[^"]+" --automation-branches "[^"]+" --github-output "\$\{GITHUB_OUTPUT\}"/u);
});

test("후보 생성·범위 검증·main 직접 push는 STALE 또는 FORCED일 때만, RC 체인 dispatch는 push 성공 뒤에만 돈다", () => {
  for (const name of [
    "Validate candidate refresh inputs",
    "Record the candidate gate run",
    "Refresh nationwide candidate",
    "Verify candidate refresh output scope",
    "Commit and push nationwide candidate directly to main",
  ]) {
    assert.equal(ifCondition(step(name)), PROCEED, name);
  }
  assert.equal(ifCondition(step("Dispatch release candidate chain for pushed candidate")), DISPATCH);
});

test("job은 datapack-release-check environment에 묶이고 후보 갱신 step만 OCI secret을 읽는다", () => {
  assert.equal(job.environment, "datapack-release-check");
  assert.equal(step("Refresh nationwide candidate").env.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL, "${{ secrets.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL }}");
  const referenced = collectReferencedSecrets(steps());
  assert.deepEqual(referenced, {
    "Refresh nationwide candidate": ["EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL"],
  });
  assert.equal(/secrets\./u.test(yml.slice(0, yml.indexOf("\njobs:"))), false);
});

test("push 요약은 STALE 사유를 남기고 실패 요약 보고가 마지막 step이다", () => {
  assert.equal(step("Commit and push nationwide candidate directly to main").env.STALE_PATHS, "${{ steps.decision.outputs.stale_paths }}");
  assertFailureReportLast({ yml, step, file: FILE, condition: "${{ failure() || cancelled() }}" });
});

test("run 스크립트에는 표현식을 직접 넣지 않는다", () => {
  assertNoExpressionInRunScripts({ steps, file: FILE });
});

test("main push step은 CAS 검사 후 HEAD:main으로 push하고 head/base에 결속된 증거 블록을 Step Summary에 남긴다", () => {
  const pushStep = step("Commit and push nationwide candidate directly to main");
  assert.equal(pushStep.id, "push");
  const run = pushStep.run;
  assert.match(run, /git fetch --no-tags origin main/u);
  assert.match(run, /\[\[ "\$\(git rev-parse origin\/main\)" != "\$\{CANDIDATE_BASE_SHA\}" \]\]/u);
  assert.match(run, /echo "pushed=false" >> "\$\{GITHUB_OUTPUT\}"\n\s*exit 0/u);
  assert.match(run, /git commit -m/u);
  assert.match(run, /git push origin HEAD:main/u);
  assert.match(run, /git diff --name-only "\$\{CANDIDATE_BASE_SHA\}" "\$\{CANDIDATE_HEAD_SHA\}" > "\$\{changed_paths\}"/u);
  assert.match(run, /node tools\/ci\/automation-pr-evidence\.mjs candidate-refresh-block --build-spec tools\/datapack\/release\/candidate-build-spec\.json --changed-paths "\$\{changed_paths\}" --base-sha "\$\{CANDIDATE_BASE_SHA\}" --head-sha "\$\{CANDIDATE_HEAD_SHA\}" --run-url "\$\{GITHUB_SERVER_URL\}\/\$\{GITHUB_REPOSITORY\}\/actions\/runs\/\$\{GITHUB_RUN_ID\}"/u);
  assert.match(run, />> "\$\{GITHUB_STEP_SUMMARY\}"/u);
  assert.match(run, /echo "pushed=true" >> "\$\{GITHUB_OUTPUT\}"/u);
  const dispatch = step("Dispatch release candidate chain for pushed candidate");
  assert.match(dispatch.run, /gh workflow run datapack-release-candidate-chain\.yml --repo "\$\{GITHUB_REPOSITORY\}" --ref main/u);
  const allNames = steps().map(({ name }) => name);
  assert.ok(allNames.indexOf(pushStep.name) < allNames.indexOf(dispatch.name));
});

test("등록 대기로 후보를 만들지 않는 실행은 이유를 notice로 남기고 아무것도 쓰지 않는다", () => {
  const waitingReg = step("Note candidate refresh waiting on capital topology registration");
  assert.equal(ifCondition(waitingReg), "${{ steps.decision.outputs.state == 'BLOCKED_BY_PENDING_REGISTRATION' }}");
  assert.match(waitingReg.run, /::notice title=Nationwide candidate refresh::/u);
  assert.equal(waitingReg.env.REGISTRATION_SNAPSHOT, "${{ steps.decision.outputs.registration_snapshot }}");
  assert.doesNotMatch(waitingReg.run, /exit 1/u);
  assert.notEqual(ifCondition(step("Validate candidate refresh inputs")).includes("BLOCKED_BY_PENDING_REGISTRATION"), true);
});
