import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { assertFailureReportLast, assertNoExpressionInRunScripts, ifCondition, loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";

const FILE = "source-derivative-rebinding.yml";
const { yml, workflow, job, steps, step } = loadWorkflow(path.resolve(import.meta.dirname, "../.."), FILE);
const RUN = "${{ steps.decision.outputs.state == 'RUN' }}";
const CHANGED = "${{ steps.decision.outputs.state == 'RUN' && steps.rebind.outputs.changed == 'true' }}";

test("트리거: 원장·정본 팩 push, 정기 복구, 사람 dispatch", () => {
  assert.deepEqual(workflow.on, {
    push: {
      branches: ["main"],
      paths: [
        "tools/datapack/release/source-snapshots.json",
        "tools/datapack/release/capital-production-canonical-pack.json",
      ],
    },
    schedule: [{ cron: "41 */6 * * *" }],
    workflow_dispatch: {},
  });
});

test("권한은 job에만 최소로 주고 변수가 true일 때만 push·정기 실행이 돈다", () => {
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(Object.keys(workflow.jobs), ["rebind"]);
  assert.deepEqual(job.permissions, {
    actions: "read",
    contents: "write",
  });
  assert.doesNotMatch(yml, /pull-requests:\s*write|issues:\s*write|actions:\s*write|create-github-app-token|gh pr create|gh workflow run|repository_dispatch|automation\//u);
  assert.equal(
    job.if,
    "${{ github.ref == 'refs/heads/main' && ((github.event_name == 'workflow_dispatch' && github.event.sender.type == 'User') || vars.DATAPACK_SCHEDULED_SOURCE_REBINDING == 'true') }}",
  );
  assert.equal(job.environment, "datapack-release-check");
});

test("판정 step이 controller보다 먼저 돈다", () => {
  const all = steps();
  const decision = all.findIndex(({ name }) => name === "Decide whether derivative rebinding may run");
  const rebind = all.findIndex(({ name }) => name === "Rebind derivative artifacts from the current ledger heads");
  assert.ok(decision !== -1 && decision < rebind);
  const decisionStep = all[decision];
  assert.equal(decisionStep.id, "decision");
  assert.match(decisionStep.run, /node tools\/ci\/decide-derivative-rebinding\.mjs --repository "\$\{GITHUB_REPOSITORY\}"/u);
});

test("controller는 RUN일 때만 돌고 OCI 읽기 주소는 시크릿에서만 받으며, 바뀐 것이 없으면 이유를 notice로 남긴다", () => {
  const rebind = step("Rebind derivative artifacts from the current ledger heads");
  assert.equal(ifCondition(rebind), RUN);
  assert.equal(rebind.id, "rebind");
  assert.equal(rebind.env.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL, "${{ secrets.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL }}");
  assert.ok(rebind.run.includes('operation="${RUNNER_TEMP}/derivative-rebinding/${GITHUB_RUN_ID}"'));
  assert.ok(rebind.run.includes('node tools/datapack/run-derivative-rebinding.mjs --operation-root "${operation}/operation" > "${operation}/result.json"'));
  assert.ok(rebind.run.includes('git config user.name "github-actions[bot]"'));
  assert.ok(rebind.run.includes("changed="));
  const note = step("Note derivative bindings are already current");
  assert.equal(ifCondition(note), "${{ steps.decision.outputs.state == 'RUN' && steps.rebind.outputs.changed == 'false' }}");
});

test("push는 바뀐 것이 있을 때만 돌고 GITHUB_TOKEN으로 main에 직접 push하며 요약을 기록한다", () => {
  const push = step("Verify the rebinding is based on the current main and push to main");
  assert.equal(ifCondition(push), CHANGED);
  assert.equal(push.id, "push");
  assert.equal(push.env.GH_TOKEN, "${{ github.token }}");
  assert.ok(push.run.includes("node tools/ci/automation-pr-evidence.mjs derivative-rebinding-body --gate "));
  assert.ok(push.run.includes('cat "${summary}" >> "${GITHUB_STEP_SUMMARY}"'));
  assert.ok(push.run.includes('git push origin HEAD:main'));
  assert.ok(push.run.includes("main moved"));
  assert.doesNotMatch(push.run, /git add/u);
  assertFailureReportLast({ yml, job, steps, step, file: FILE, condition: "${{ failure() || cancelled() }}" });
});

test("run 스크립트에는 표현식을 직접 넣지 않고 env로만 받는다", () => {
  assertNoExpressionInRunScripts({ job, steps, file: FILE });
});

test("읽은 main이 움직였으면 아무것도 올리지 않고 notice로 끝낸다", () => {
  const push = step("Verify the rebinding is based on the current main and push to main");
  assert.equal(push.id, "push");
  assert.ok(push.run.includes("::notice title=Derivative rebinding::main moved"));
  assert.match(push.run, /echo "pushed=false" >> "\$\{GITHUB_OUTPUT\}"\n\s+exit 0/u);
  assert.ok(push.run.includes('echo "pushed=true" >> "${GITHUB_OUTPUT}"'));
  assert.doesNotMatch(yml, /BINDING_BASE_MOVED/u);
  const note = step("Note rebinding superseded by a newer main");
  assert.equal(ifCondition(note), "${{ steps.decision.outputs.state == 'RUN' && steps.rebind.outputs.changed == 'true' && steps.push.outputs.pushed == 'false' }}");
});

test("원장 변화 게이트와 요약 본문이 controller 커밋에 결속된다", () => {
  const rebind = step("Rebind derivative artifacts from the current ledger heads");
  assert.ok(rebind.run.includes('node tools/ci/source-ledger-gate.mjs --base-sha "${base_sha}" --output "${operation}/gate.json"'));
  assert.ok(rebind.run.indexOf("run-derivative-rebinding.mjs") < rebind.run.indexOf("source-ledger-gate.mjs"), "the gate runs on the controller's commits");
  assert.ok(rebind.run.includes('printf \'REBINDING_HEAD_SHA=%s\\n\' "$(git rev-parse HEAD)" >> "${GITHUB_ENV}"'));
  const push = step("Verify the rebinding is based on the current main and push to main");
  assert.ok(push.run.includes('node tools/ci/automation-pr-evidence.mjs derivative-rebinding-body --gate "${RUNNER_TEMP}/derivative-rebinding/${GITHUB_RUN_ID}/gate.json" --result "${REBINDING_RESULT}" --base-sha "${REBINDING_BASE_SHA}" --head-sha "${REBINDING_HEAD_SHA}"'));
});
