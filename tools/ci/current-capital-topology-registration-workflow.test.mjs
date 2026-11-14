import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { REGISTRATION_ALLOWED_PATHS } from "./automation-pr-policy.mjs";

import { assertFailureReportLast, assertNoExpressionInRunScripts, ifCondition, loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";

const FILE = "current-capital-topology-registration.yml";
const { yml, workflow, job, steps, step } = loadWorkflow(path.resolve(import.meta.dirname, "../.."), FILE);
const WRITES = "${{ steps.decision.outputs.state == 'REGISTER' || steps.decision.outputs.state == 'RECOVER_CLAIM' }}";

test("트리거: 수도권 topology 활성화 산출 경로 push, 정기 복구 실행, 사람 dispatch(복구 run 입력 유지)", () => {
  assert.deepEqual(workflow.on.push, {
    branches: ["main"],
    paths: [
      "tools/datapack/sources/capital-route-topology-*.json",
      "tools/datapack/release/capital-topology-reverification-*.json",
    ],
  });
  assert.deepEqual(workflow.on.schedule, [{ cron: "5 */2 * * *" }]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ["recovery_run_id"]);
});

test("권한은 workflow 전체가 아니라 job에만 최소 권한(actions: read, contents: write)을 준다", () => {
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(Object.keys(workflow.jobs), ["register"]);
  assert.deepEqual(job.permissions, {
    actions: "read",
    contents: "write",
  });
  assert.doesNotMatch(yml, /pull-requests:\s*write|issues:\s*write|create-github-app-token|gh pr create|automation\//u);
});

test("push·정기 실행은 저장소 변수가 true일 때만 돌고 사람 dispatch는 항상 돈다", () => {
  assert.equal(
    job.if,
    "${{ github.ref == 'refs/heads/main' && ((github.event_name == 'workflow_dispatch' && github.event.sender.type == 'User') || vars.DATAPACK_SCHEDULED_SOURCE_REGISTRATION == 'true') }}",
  );
});

test("판정 step이 게시·복구·push보다 먼저 돌고 SUPERSEDED 및 복구 run id 입력을 처리한다", () => {
  const all = steps();
  const decision = all.findIndex(({ name }) => name === "Decide whether capital topology registration is needed");
  const publish = all.findIndex(({ name }) => name === "Publish and register once");
  assert.ok(decision !== -1 && decision < publish);
  const decisionStep = all[decision];
  assert.equal(decisionStep.id, "decision");
  assert.equal(decisionStep.env.GH_TOKEN, "${{ github.token }}");
  assert.equal(decisionStep.env.RECOVERY_RUN_ID, "${{ inputs.recovery_run_id }}");
  assert.ok(decisionStep.run.includes("node tools/ci/decide-capital-topology-registration.mjs --inventory tools/datapack/source-inventory.json --ledger tools/datapack/release/source-snapshots.json "));
  assert.ok(decisionStep.run.includes('--current-main-sha "${main_sha}" --pr-limit 1000 --run-limit 200 --github-output "${GITHUB_OUTPUT}"'));
  assert.ok(decisionStep.run.includes("git ls-remote origin refs/heads/main"));
  assert.ok(decisionStep.run.includes("state=SUPERSEDED"));
});

test("게시·복구·직접 push는 REGISTER 또는 RECOVER_CLAIM일 때만 돌고 게시와 복구는 배타적이다", () => {
  assert.equal(ifCondition(step("Prepare retained publication recovery evidence")), "${{ steps.decision.outputs.state == 'RECOVER_CLAIM' }}");
  assert.equal(ifCondition(step("Publish and register once")), "${{ steps.decision.outputs.state == 'REGISTER' }}");
  assert.equal(ifCondition(step("Recover published registration without OCI")), "${{ steps.decision.outputs.state == 'RECOVER_CLAIM' }}");
  assert.equal(ifCondition(step("Commit and push registration outputs directly to main")), WRITES);
  assert.doesNotMatch(yml, /inputs\.recovery_run_id == ''/u);
  assert.doesNotMatch(yml, /inputs\.recovery_run_id != ''/u);
});

test("복구 run id는 판정 결과에서만 받고, producer run의 이벤트는 dispatch·push·schedule을 받는다", () => {
  const prep = step("Prepare retained publication recovery evidence");
  assert.equal(prep.env.RECOVERY_RUN_ID, "${{ steps.decision.outputs.recovery_run_id }}");
  assert.ok(prep.run.includes('[[ "${run_event}" == "workflow_dispatch" || "${run_event}" == "push" || "${run_event}" == "schedule" ]]'));
  assert.equal(step("Recover published registration without OCI").env.RECOVERY_RUN_ID, "${{ steps.decision.outputs.recovery_run_id }}");
});

test("복구 증거 artifact는 게시를 시도한 실행에서만 올리고, 실패 요약이 마지막 step이다", () => {
  assertFailureReportLast({ yml, job, steps, step, file: FILE, condition: "${{ failure() || cancelled() }}" });
});

test("이 workflow는 workflow dispatch를 호출하지 않고 GITHUB_TOKEN으로 main에 직접 push한다", () => {
  assert.doesNotMatch(yml, /gh workflow run|\/dispatches|repository_dispatch|actions: write/u);
  const pushStep = step("Commit and push registration outputs directly to main");
  assert.equal(pushStep.env.GH_TOKEN, "${{ github.token }}");
  assert.ok(pushStep.run.includes("git push origin HEAD:main"));
});

test("run 스크립트에는 표현식을 직접 넣지 않고 env로만 받는다", () => {
  assertNoExpressionInRunScripts({ job, steps, file: FILE });
});

test("복구 증거 artifact는 게시 receipt가 있을 때만 올린다", () => {
  const detect = step("Detect retained publication receipt");
  assert.equal(ifCondition(detect), "${{ always() && (steps.decision.outputs.state == 'REGISTER' || steps.decision.outputs.state == 'RECOVER_CLAIM') }}");
  assert.equal(detect.id, "receipt");
  assert.ok(detect.run.includes("has_receipt=true"));
  assert.equal(ifCondition(step("Retain sanitized publication recovery evidence")), "${{ always() && steps.receipt.outputs.has_receipt == 'true' }}");
});

test("등록 커밋은 push 전에 원장 변화 게이트를 통과하고 요약 증거와 origin/main CAS 검사를 수행한다", () => {
  const commitStep = step("Commit and push registration outputs directly to main");
  const gate = commitStep.run.indexOf('node tools/ci/source-ledger-gate.mjs --base-sha "${REGISTRATION_MAIN_SHA}" --output "${evidence_root}/gate.json"');
  const body = commitStep.run.indexOf('node tools/ci/automation-pr-evidence.mjs registration-body --gate "${evidence_root}/gate.json" --base-sha "${REGISTRATION_MAIN_SHA}" --head-sha "$(git rev-parse HEAD)"');
  const push = commitStep.run.indexOf("git push origin HEAD:main");
  assert.ok(gate !== -1 && gate < push, "the ledger gate runs before the push");
  assert.ok(body !== -1 && body < push, "the evidence summary is written before the push");
  assert.ok(commitStep.run.includes('cat "${evidence_root}/body.md" >> "${GITHUB_STEP_SUMMARY}"'));
  assert.ok(commitStep.run.includes('if [[ "$(git rev-parse origin/main)" != "${REGISTRATION_MAIN_SHA}" ]]'));
  assert.ok(commitStep.run.includes('evidence_root="$(mktemp -d "${RUNNER_TEMP}/registration-evidence.XXXXXX")"'));
});

const GOVERNANCE = "tools/datapack/source-governance-policy.json";
const FRESHNESS = "release/product-gates/datapack-freshness-sla.json";

function commitStepPathChecks() {
  const { block } = step("Commit and push registration outputs directly to main");
  const start = block.indexOf("          expected=(");
  const end = block.indexOf("          # #975 리뷰 F5");
  assert.ok(start !== -1 && end > start, "the path check section is delimited");
  return { block, section: block.slice(start, end) };
}

function runGitInDir(dir, ...args) {
  return execFileSync("git", args, { cwd: dir, stdio: "pipe" });
}

function runPathChecks(changedFiles) {
  const { section } = commitStepPathChecks();
  const dir = mkdtempSync(path.join(os.tmpdir(), "registration-paths-"));
  try {
    runGitInDir(dir, "init", "-q");
    runGitInDir(dir, "config", "user.email", "test@example.test");
    runGitInDir(dir, "config", "user.name", "test");
    for (const file of [...REGISTRATION_ALLOWED_PATHS, GOVERNANCE, FRESHNESS]) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), "{}\n");
    }
    runGitInDir(dir, "add", ".");
    runGitInDir(dir, "commit", "-q", "-m", "base");
    for (const file of changedFiles) writeFileSync(path.join(dir, file), '{"changed":true}\n');
    try {
      execFileSync("bash", ["-c", `set -euo pipefail\n${section}`], { cwd: dir, stdio: "pipe", encoding: "utf8" });
      return { ok: true, stderr: "" };
    } catch (error) {
      return { ok: false, stderr: String(error.stderr) };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("등록 커밋은 정확히 원장·inventory 둘만 스테이징하고 allowlist와 일치한다(#989)", () => {
  const { block, section } = commitStepPathChecks();
  const expected = /\n\s+expected=\(([^)]*)\)\n/u.exec(block)?.[1].trim().split(/\s+/u);
  assert.deepEqual([...(expected ?? [])].sort(), [...REGISTRATION_ALLOWED_PATHS].sort());
  assert.match(block, /git add -- "\$\{expected\[@\]\}"/u);
  assert.doesNotMatch(block, /git add [^\n]*(source-governance-policy|datapack-freshness-sla|-A|\.)/u);
  assert.match(section, /REGISTRATION_POLICY_CHANGED/u);
});

test("두 경로만 바뀌면 경로 검사를 통과한다(재등록의 실제 모양)", () => {
  assert.deepEqual(runPathChecks([...REGISTRATION_ALLOWED_PATHS]), { ok: true, stderr: "" });
});

test("governance 또는 신선도 SLA가 바뀌어 있으면 REGISTRATION_POLICY_CHANGED로 실패한다", () => {
  for (const policy of [GOVERNANCE, FRESHNESS]) {
    const result = runPathChecks([...REGISTRATION_ALLOWED_PATHS, policy]);
    assert.equal(result.ok, false, policy);
    assert.match(result.stderr, /REGISTRATION_POLICY_CHANGED/u, policy);
    assert.ok(result.stderr.includes(policy), policy);
  }
  assert.match(runPathChecks([GOVERNANCE, FRESHNESS, ...REGISTRATION_ALLOWED_PATHS]).stderr, /REGISTRATION_POLICY_CHANGED/u);
});

test("원장·inventory 중 하나라도 빠졌거나 아무것도 안 바뀌었으면 실패한다", () => {
  for (const changed of [[REGISTRATION_ALLOWED_PATHS[0]], [REGISTRATION_ALLOWED_PATHS[1]], []]) {
    const result = runPathChecks(changed);
    assert.equal(result.ok, false, JSON.stringify(changed));
    assert.doesNotMatch(result.stderr, /REGISTRATION_POLICY_CHANGED/u);
  }
});
