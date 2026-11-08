import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { REGISTRATION_ALLOWED_PATHS } from "./automation-pr-policy.mjs";

import { assertFailureReportLast, assertNoExpressionInRunScripts, assertOpenPullRequestSteps, ifCondition, loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";

// #969 P3: 수도권 topology 등록 workflow 계약.
// 갱신 PR이 병합되면 사람이 dispatch하지 않아도 등록이 PR까지 이어진다. 정기·push 실행은 저장소 변수가 켜졌을 때만 돈다.
// 판정(REGISTER·RECOVER_CLAIM·OPEN_PR·BLOCKED_BY_PENDING_PR·REGISTERED)이 모든 쓰기 step을 가르고, 이상은 실패 이슈로 드러난다.
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

test("권한은 workflow 전체가 아니라 job에만 준다(issues 쓰기는 실패 보고용)", () => {
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(Object.keys(workflow.jobs), ["register"]);
  assert.deepEqual(job.permissions, {
    actions: "read",
    contents: "write",
    "pull-requests": "write",
    issues: "write",
  });
});

test("push·정기 실행은 저장소 변수가 true일 때만 돌고 사람 dispatch는 항상 돈다", () => {
  assert.equal(
    job.if,
    "${{ github.ref == 'refs/heads/main' && ((github.event_name == 'workflow_dispatch' && github.event.sender.type == 'User') || vars.DATAPACK_SCHEDULED_SOURCE_REGISTRATION == 'true') }}",
  );
});

test("판정 step이 claim·게시·PR 생성보다 먼저 돌고 판정 입력을 저장소·GitHub 기록에서만 읽는다", () => {
  const all = steps();
  const decision = all.findIndex(({ name }) => name === "Decide whether capital topology registration is needed");
  const claim = all.findIndex(({ name }) => name === "Claim exact main before OCI publication");
  assert.ok(decision !== -1 && decision < claim);
  const decisionStep = all[decision];
  assert.equal(decisionStep.id, "decision");
  assert.equal(decisionStep.env.GH_TOKEN, "${{ github.token }}");
  assert.equal(decisionStep.env.RECOVERY_RUN_ID, "${{ inputs.recovery_run_id }}");
  // #993: PR 이력 전체(--state all --limit 1000)를 받지 않는다. 열린 PR 전체와 claim 브랜치별 PR만 수집기로 받는다.
  assert.match(decisionStep.run, /node tools\/ci\/collect-automation-prs\.mjs --repository "\$\{GITHUB_REPOSITORY\}" --refs "[^"]+" --pr-limit 1000 --output "[^"]+"/u);
  assert.doesNotMatch(decisionStep.run, /gh pr list[^\n]*--state all --limit/u);
  assert.ok(decisionStep.run.includes('git ls-remote --heads origin "refs/heads/automation/456-capital-topology-registration-*" > '));
  // #987 리뷰 F1: 아직 끝나지 않은 run만 상태별로 조회하고, 복구에 필요한 claim의 producer run은 run id로 직접 가져온다(끝난 이력은 조회하지 않는다).
  assert.match(decisionStep.run, /for status in in_progress queued waiting pending requested; do\n\s+gh run list --repo "\$\{GITHUB_REPOSITORY\}" --workflow current-capital-topology-registration\.yml --status "\$\{status\}" --limit 200 --json databaseId,status,conclusion,workflowName,headBranch,headSha > "[^"]+"\n\s*done/u);
  assert.equal([...decisionStep.run.matchAll(/gh run list/gu)].length, 1, "every run listing is filtered by status");
  assert.ok(decisionStep.run.includes('gh run view "${claim_run}" --repo "${GITHUB_REPOSITORY}" --json databaseId,status,conclusion,workflowName,headBranch,headSha'));
  assert.ok(decisionStep.run.includes("jq -s 'add | unique_by(.databaseId)' "));
  assert.ok(decisionStep.run.includes("node tools/ci/decide-capital-topology-registration.mjs --inventory tools/datapack/source-inventory.json --ledger tools/datapack/release/source-snapshots.json "));
  assert.ok(decisionStep.run.includes('gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${claim_run}/artifacts" --jq \'[.artifacts[].name]\''));
  assert.ok(decisionStep.run.includes('--artifacts "${decision_root}/artifacts.json" --repository "${GITHUB_REPOSITORY}"'));
  assert.ok(decisionStep.run.includes('--current-main-sha "${main_sha}" --pr-limit 1000 --run-limit 200 --github-output "${GITHUB_OUTPUT}"'));
  // 판정 시점의 checkout이 아직 main이어야 한다. 그 사이 main이 움직였으면 새 push가 자기 판정을 한다.
  assert.ok(decisionStep.run.includes("git ls-remote origin refs/heads/main"));
  assert.ok(decisionStep.run.includes("state=SUPERSEDED"));
});

test("claim·게시·복구·App 토큰·PR 생성은 REGISTER 또는 RECOVER_CLAIM일 때만 돌고, 게시와 복구는 서로 배타적이다", () => {
  for (const name of ["Claim exact main before OCI publication", "Mint App token for the registration pull request", "Commit exactly two registration outputs and open draft PR"]) {
    assert.equal(ifCondition(step(name)), WRITES, name);
  }
  assert.equal(ifCondition(step("Publish and register once")), "${{ steps.decision.outputs.state == 'REGISTER' }}");
  assert.equal(ifCondition(step("Recover published registration without OCI")), "${{ steps.decision.outputs.state == 'RECOVER_CLAIM' }}");
  assert.doesNotMatch(yml, /inputs\.recovery_run_id == ''/u);
  assert.doesNotMatch(yml, /inputs\.recovery_run_id != ''/u);
});

// #987 리뷰 F5: 재확인 workflow는 push 직전에 원장 쓰기 자동화를 다시 확인한다. 수도권 등록도 같아야 직렬화가 양방향이다.
// 이 workflow는 게시 증거(receipt artifact)를 남기고 실패하면 다음 실행이 그 증거로 PR만 다시 만든다(복구). 그래서 기다림은 성공이 아니라 복구 가능한 실패로 끝낸다.
test("push 직전에 원장을 쓰는 다른 자동화(열린 PR·claim 브랜치)가 없는지 다시 확인하고, 있으면 push하지 않고 복구 가능한 실패로 끝낸다", () => {
  const recheck = step("Recheck that no source-ledger automation is pending before pushing");
  assert.equal(ifCondition(recheck), WRITES);
  assert.equal(recheck.env.GH_TOKEN, "${{ github.token }}");
  // #993: PR 이력 전체(--state all --limit 1000)를 받지 않는다. 열린 PR 전체와 claim 브랜치별 PR만 수집기로 받는다.
  assert.match(recheck.run, /node tools\/ci\/collect-automation-prs\.mjs --repository "\$\{GITHUB_REPOSITORY\}" --refs "[^"]+" --pr-limit 1000 --output "[^"]+"/u);
  assert.doesNotMatch(recheck.run, /gh pr list[^\n]*--state all --limit/u);
  assert.ok(recheck.run.includes('git ls-remote --heads origin "refs/heads/automation/*" > '));
  assert.match(recheck.run, /node tools\/ci\/ledger-writers-idle\.mjs --repository "\$\{GITHUB_REPOSITORY\}" --prs "[^"]+" --automation-branches "[^"]+" --except-workflow current-capital-topology-registration\.yml --github-output "[^"]+"/u);
  assert.ok(recheck.run.includes("grep -qx 'idle=true' "));
  assert.ok(recheck.run.includes("REGISTRATION_LEDGER_WRITER_PENDING: "));
  const names = steps().map(({ name }) => name);
  assert.ok(names.indexOf("Publish and register once") < names.indexOf(recheck.name));
  assert.ok(names.indexOf("Recover published registration without OCI") < names.indexOf(recheck.name));
  assert.ok(names.indexOf(recheck.name) < names.indexOf("Mint App token for the registration pull request"));
  assert.ok(names.indexOf(recheck.name) < names.indexOf("Commit exactly two registration outputs and open draft PR"));
  assert.ok(names.indexOf("Mint App token for the registration pull request") !== -1);
});

test("복구 run id는 사람 입력 또는 판정 결과에서만 받고, producer run의 이벤트는 dispatch·push·schedule을 받는다", () => {
  const claim = step("Claim exact main before OCI publication");
  assert.equal(claim.env.RECOVERY_RUN_ID, "${{ steps.decision.outputs.recovery_run_id }}");
  assert.ok(claim.run.includes('[[ "${run_event}" == "workflow_dispatch" || "${run_event}" == "push" || "${run_event}" == "schedule" ]]'));
  assert.equal(step("Recover published registration without OCI").env.RECOVERY_RUN_ID, "${{ steps.decision.outputs.recovery_run_id }}");
});

test("OPEN_PR이면 App 토큰 → required CI 보장 → 열린 PR 상한 검사 순서로 돈다", () => {
  assertOpenPullRequestSteps({ steps, file: FILE, decisionName: "Decide whether capital topology registration is needed" });
});

test("다른 원장 쓰기 PR 때문에 기다리는 실행은 이유를 notice로 남기고 아무것도 쓰지 않는다", () => {
  const wait = step("Note registration waiting on another pending automation pull request");
  assert.equal(ifCondition(wait), "${{ steps.decision.outputs.state == 'BLOCKED_BY_PENDING_PR' }}");
  assert.ok(wait.run.includes("::notice title=Capital topology registration::"));
  assert.equal(wait.env.BLOCKED_BY, "${{ steps.decision.outputs.blocked_by }}");
});

test("복구 증거 artifact는 게시를 시도한 실행에서만 올리고, 실패 보고가 마지막 step이다", () => {
  assertFailureReportLast({ yml, job, steps, step, file: FILE, condition: "${{ failure() || cancelled() }}" });
});

test("이 workflow는 workflow dispatch를 호출하지 않고 push는 GITHUB_TOKEN, PR 생성만 App 토큰이다", () => {
  assert.doesNotMatch(yml, /gh workflow run|\/dispatches|repository_dispatch|actions: write/u);
  assert.equal(step("Commit exactly two registration outputs and open draft PR").env.GH_TOKEN, "${{ github.token }}");
});

// #972 리뷰 F4: step output(required-ci 상태·blocked_by)을 run 스크립트에 표현식으로 펼치면 나중에 출력이 바뀔 때 셸 주입 지점이 된다.
test("run 스크립트에는 표현식을 직접 넣지 않고 env로만 받는다", () => {
  assertNoExpressionInRunScripts({ job, steps, file: FILE });
  assert.equal(step("Note registration waiting on another pending automation pull request").env.BLOCKED_BY, "${{ steps.decision.outputs.blocked_by }}");
});

// #972 리뷰 F1·F2, 이슈 #973: 게시 증거 없이 남은 빈 claim과 병합된 PR의 남은 claim은 사람이 지울 일이 아니다.
test("이번 실행이 만든 claim은 실패·취소 때 게시 증거가 없으면 자동으로 지우고, 증거가 있고 비어 있으면 복구용으로 남긴다", () => {
  const cleanup = step("Remove this run's claim after a failed or cancelled run");
  assert.equal(ifCondition(cleanup), "${{ (failure() || cancelled()) && env.REGISTRATION_BRANCH != '' }}");
  assert.equal(cleanup.env.GH_TOKEN, "${{ github.token }}");
  // 복구 실행은 자기가 복구하는 claim을 지우지 않는다. 이 run의 id로 만든 claim만 지운다.
  assert.ok(cleanup.run.includes('branch="automation/456-capital-topology-registration-${GITHUB_RUN_ID}"'));
  assert.ok(cleanup.run.includes('[[ "${REGISTRATION_BRANCH}" == "${branch}" ]] || exit 0'));
  // PR이 있으면 지우지 않는다.
  assert.ok(cleanup.run.includes('gh pr list --repo "${GITHUB_REPOSITORY}" --state all --head "${branch}" --json number --jq \'length\''));
  // receipt가 있고 claim이 빈 커밋 하나뿐이면 복구용으로 남긴다. 그 밖에는 지운다.
  assert.ok(cleanup.run.includes("capital-route-topology.raw-receipt.json"));
  assert.ok(cleanup.run.includes('git rev-list --count "${REGISTRATION_MAIN_SHA}..origin/${branch}"'));
  assert.ok(cleanup.run.includes('git push origin --delete "${branch}"'));
  const names = steps().map(({ name }) => name);
  assert.ok(names.indexOf("Retain sanitized publication recovery evidence") < names.indexOf(cleanup.name), "evidence is retained before the cleanup decides");
  assert.ok(names.indexOf(cleanup.name) < names.indexOf("Report refresh failure as an issue"));
});

test("판정이 알린 정리 대상(병합된 PR의 남은 claim·게시 증거 없는 이전 claim)은 claim step 전에 지운다", () => {
  const cleanup = step("Remove stale registration claims named by the decision");
  assert.equal(ifCondition(cleanup), WRITES);
  assert.equal(cleanup.env.CLEANUP_CLAIMS, "${{ steps.decision.outputs.cleanup_claims }}");
  // #995: 조용히 지우지 않는다. 병합된 PR의 남은 claim은 보고 없이, 게시 증거 없이 버려진 claim은 #926 실패 보고를 먼저 하고 지운다.
  assert.match(cleanup.run, /gh auth setup-git\n[\s\S]*node tools\/ci\/remove-orphan-claims\.mjs --workflow current-capital-topology-registration\.yml --repository "\$\{GITHUB_REPOSITORY\}" --claims "\$\{CLEANUP_CLAIMS\}" --refs "\$\{RUNNER_TEMP\}\/capital-topology-registration-decision\/\$\{GITHUB_RUN_ID\}\/claims\.txt"/u);
  assert.doesNotMatch(cleanup.run, /git push origin --delete/u);
  const names = steps().map(({ name }) => name);
  assert.ok(names.indexOf("Decide whether capital topology registration is needed") < names.indexOf(cleanup.name));
  assert.ok(names.indexOf(cleanup.name) < names.indexOf("Claim exact main before OCI publication"));
  // claim step의 경쟁 claim 검사는 정리 뒤 상태를 엄격히 본다(판정과 같은 기준으로 이미 정리했으므로 남은 claim이 없어야 한다).
  assert.ok(step("Claim exact main before OCI publication").run.includes('[[ ! -s "${claims}" ]] || { echo "competing registration claim exists" >&2; exit 1; }'));
});

test("복구 증거 artifact는 게시 receipt가 있을 때만 올린다(판정이 artifact 유무로 복구 가능 여부를 본다)", () => {
  const detect = step("Detect retained publication receipt");
  assert.equal(ifCondition(detect), "${{ always() && (steps.decision.outputs.state == 'REGISTER' || steps.decision.outputs.state == 'RECOVER_CLAIM') }}");
  assert.equal(detect.id, "receipt");
  assert.ok(detect.run.includes("has_receipt=true"));
  assert.equal(ifCondition(step("Retain sanitized publication recovery evidence")), "${{ always() && steps.receipt.outputs.has_receipt == 'true' }}");
});

test("producer가 실행 중인 claim은 이유를 notice로 남기고 아무것도 쓰지 않는다", () => {
  const running = step("Note registration waiting on a running producer");
  assert.equal(ifCondition(running), "${{ steps.decision.outputs.state == 'CLAIM_IN_PROGRESS' }}");
});

// #975 리뷰 F2·F5: 등록 PR도 원장 변화 게이트를 통과해야 하고, 본문에 base/head 커밋에 결속된 증거 블록을 낸다.
test("등록 PR은 push 전에 원장 변화 게이트를 통과하고 증거 블록이 든 본문 파일로 연다", () => {
  const commitStep = step("Commit exactly two registration outputs and open draft PR");
  const gate = commitStep.run.indexOf('node tools/ci/source-ledger-gate.mjs --base-sha "${REGISTRATION_MAIN_SHA}" --output "${evidence_root}/gate.json"');
  const push = commitStep.run.indexOf('git push origin "${REGISTRATION_BRANCH}"');
  const body = commitStep.run.indexOf('node tools/ci/automation-pr-evidence.mjs registration-body --gate "${evidence_root}/gate.json" --base-sha "${REGISTRATION_MAIN_SHA}" --head-sha "$(git rev-parse HEAD)"');
  const create = commitStep.run.indexOf("gh pr create");
  assert.ok(gate !== -1 && gate < push, "the ledger gate runs before the push");
  assert.ok(push < body && body < create, "the body is built from the pushed head before the PR is created");
  assert.ok(commitStep.run.includes('--run-url "${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}" --output "${evidence_root}/body.md"'));
  assert.ok(commitStep.run.includes('--body-file "${evidence_root}/body.md"'));
  assert.ok(commitStep.run.includes('evidence_root="$(mktemp -d "${RUNNER_TEMP}/registration-evidence.XXXXXX")"'));
});

// #989: 재등록은 정책 파일(governance·신선도 SLA)을 바꾸지 않는다. 등록 PR은 정확히 원장·inventory 둘만 커밋하고(자동 병합 정책의 등록 allowlist와 같다),
// 정책 파일이 바뀌어 있으면 아무것도 push하지 않고 REGISTRATION_POLICY_CHANGED로 실패한다.
const GOVERNANCE = "tools/datapack/source-governance-policy.json";
const FRESHNESS = "release/product-gates/datapack-freshness-sla.json";

function commitStepPathChecks() {
  const { block } = step("Commit exactly two registration outputs and open draft PR");
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

test("등록 PR은 정확히 원장·inventory 둘만 커밋하고 그 경로는 자동 병합 정책의 등록 allowlist와 같다(#989)", () => {
  const { block, section } = commitStepPathChecks();
  const expected = /\n\s+expected=\(([^)]*)\)\n/u.exec(block)?.[1].trim().split(/\s+/u);
  assert.deepEqual([...(expected ?? [])].sort(), [...REGISTRATION_ALLOWED_PATHS].sort());
  assert.match(block, /git add "\$\{expected\[@\]\}"/u);
  assert.doesNotMatch(block, /git add [^\n]*(source-governance-policy|datapack-freshness-sla)/u);
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
