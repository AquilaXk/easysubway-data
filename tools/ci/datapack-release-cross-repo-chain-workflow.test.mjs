import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const yml = readFileSync(new URL("../../.github/workflows/datapack-release-cross-repo-chain.yml", import.meta.url), "utf8");

// F3: 기본은 꺼짐이다. 메인 세션이 설정 변경을 적용한 뒤 저장소 변수를 'true'로 켤 때만 job이 실행된다.
// 시작 경로는 둘이다(data#1158). (1) 사람이 띄운 RC의 workflow_run, (2) RC chain이 GITHUB_TOKEN으로 띄운 RC는 workflow_run을 만들지 않으므로
// RC chain이 RC 완료 뒤 이 workflow를 workflow_dispatch한다. (2)는 이 run을 시작한 행위자가 허용 목록일 때만 인정한다.
// 행위자 판정은 forgeable한 github 컨텍스트가 아니라 identify step이 API로 다시 읽은 값으로 한다(SonarCloud githubactions:S8232).
const RC_GUARD = "    if: ${{ "
  + "vars.DATAPACK_CROSS_REPO_CHAIN_ENABLED == 'true' && ("
  + "(github.event_name == 'workflow_run' && github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'workflow_dispatch' "
  + "&& github.event.workflow_run.head_branch == 'main' && github.event.workflow_run.head_repository.full_name == github.repository "
  + "&& github.event.workflow_run.path == '.github/workflows/datapack-release.yml' "
  + "&& github.event.workflow_run.display_title == 'Data Pack Release (release-candidate)') "
  + "|| (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main')) }}";
const FAILURE_GUARD = "    if: ${{ "
  + "vars.DATAPACK_CROSS_REPO_CHAIN_ENABLED == 'true' && "
  + "github.event.workflow_run.conclusion == 'failure' && github.event.workflow_run.event == 'workflow_dispatch' "
  + "&& github.event.workflow_run.head_branch == 'main' && github.event.workflow_run.head_repository.full_name == github.repository "
  + "&& github.event.workflow_run.path == '.github/workflows/datapack-release.yml' "
  + "&& (github.event.workflow_run.display_title == 'Data Pack Release (release-candidate)' || github.event.workflow_run.display_title == 'Data Pack Release (production-publish)') }}";
const CHAIN_GUARD = "    if: ${{ needs.identify.outputs.rc == 'true' }}";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

function stepBody(name) {
  const begin = yml.indexOf(`      - name: ${name}\n`);
  assert.notEqual(begin, -1, `missing workflow step: ${name}`);
  const end = yml.indexOf("\n      - name: ", begin + 1);
  return yml.slice(begin, end === -1 ? yml.length : end);
}

function stepScript(name) {
  const body = stepBody(name);
  const marker = "\n        run: |\n";
  const begin = body.indexOf(marker);
  assert.notEqual(begin, -1, `step has no run block: ${name}`);
  return runLines(body.slice(begin + marker.length)).map((line) => line.replace(/^ {10}/u, "")).join("\n");
}

// step 본문 뒤에 다른 job이 이어질 수 있으므로 run 블록(10칸 이상 들여쓰기·빈 줄)까지만 자른다.
function runLines(text) {
  const lines = text.split("\n");
  const end = lines.findIndex((line) => line !== "" && !/^ {10}/u.test(line));
  return end === -1 ? lines : lines.slice(0, end);
}

async function runStep(name, env, ghScript = null) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cross-repo-chain-"));
  try {
    const output = path.join(directory, "github-output");
    const summary = path.join(directory, "step-summary");
    await writeFile(output, "");
    await writeFile(summary, "");
    let PATH = process.env.PATH;
    if (ghScript !== null) {
      await writeFile(path.join(directory, "gh"), `#!/bin/sh\n${ghScript}\n`);
      await chmod(path.join(directory, "gh"), 0o755);
      PATH = `${directory}:${PATH}`;
    }
    const result = spawnSync("/bin/bash", ["-e", "-c", stepScript(name)], {
      encoding: "utf8",
      cwd: ROOT,
      env: { PATH, HOME: process.env.HOME, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: directory, ...env },
    });
    return { ...result, output: await readFile(output, "utf8"), summary: await readFile(summary, "utf8") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function jobBlock(name) {
  const begin = yml.indexOf(`\n  ${name}:\n`);
  assert.notEqual(begin, -1, `missing job: ${name}`);
  const rest = yml.slice(begin + 1);
  const next = rest.slice(1).search(/\n  [a-z][a-z-]*:\n/u);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

test("the chain reacts only to a main workflow_dispatch Data Pack Release run of this repository, by its mode (#932, data#1084)", () => {
  assert.match(yml, /^on:\n  workflow_run:\n    workflows: \["Data Pack Release"\]\n    types: \[completed\]\n  workflow_dispatch:\n    inputs:\n      rc_run_id:\n        description: [^\n]+\n        required: true\n        type: string\n\n/mu);
  assert.doesNotMatch(yml, /\n  (schedule|push|pull_request|pull_request_target|repository_dispatch):/u);
  // 읽기 권한도 workflow 전체가 아니라 job마다 준다(SonarCloud githubactions:S8264).
  assert.match(yml, /\npermissions: \{\}\n/u);
  assert.match(jobBlock("identify"), /\n    permissions:\n      actions: read\n      contents: read\n/u);
  // App 토큰 경로 앞의 유일한 장벽이므로 guard 전체를 정확히 고정한다(&&를 ||로 바꾸는 변이가 잡혀야 한다).
  assert.deepEqual(yml.split("\n").filter((line) => line.startsWith("    if: ")), [RC_GUARD, CHAIN_GUARD, FAILURE_GUARD]);
  assert.match(jobBlock("identify"), new RegExp(`\\n${RC_GUARD.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\n`, "u"));
  assert.match(jobBlock("chain"), /\n    needs: identify\n/u);
  assert.match(jobBlock("chain"), new RegExp(`\\n${CHAIN_GUARD.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\n`, "u"));
  assert.doesNotMatch(yml, /ref: \$\{\{ github\.event\.workflow_run/u);
  assert.doesNotMatch(yml, /continue-on-error/u);
  // 행위자는 forgeable한 컨텍스트 값이 아니라 API로 다시 읽은 기록으로만 판정한다(SonarCloud githubactions:S8232).
  assert.doesNotMatch(yml, /\$\{\{[^}]*github\.(triggering_)?actor/u);
});

test("each app token is scoped to one repository with least privilege and never reaches a run script as an expression", () => {
  const tokens = [
    ["Create the hub token", "easysubway", ["permission-actions: write", "permission-contents: read"]],
    ["Create the platform token", "easysubway-platform", ["permission-actions: write"]],
    ["Create the backend read token", "easysubway-backend", ["permission-actions: read", "permission-contents: read"]],
    ["Create the platform token for the rollback", "easysubway-platform", ["permission-actions: write"]],
  ];
  for (const [name, repository, permissions] of tokens) {
    const token = stepBody(name);
    assert.match(token, /uses: actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1/u, name);
    assert.match(token, /client-id: \$\{\{ secrets\.EASYSUBWAY_RELEASE_APP_CLIENT_ID \}\}/u, name);
    assert.match(token, /private-key: \$\{\{ secrets\.EASYSUBWAY_RELEASE_APP_PRIVATE_KEY \}\}/u, name);
    assert.match(token, /owner: AquilaXk\n/u, name);
    assert.match(token, new RegExp(`repositories: ${repository}\\n`, "u"), name);
    const granted = token.split("\n").filter((line) => /^ {10}permission-/u.test(line)).map((line) => line.trim());
    assert.deepEqual(granted, permissions, name);
  }
  // 토큰은 필요한 단계의 env로만 들어가고, run 스크립트에는 expression이 직접 쓰이지 않는다.
  for (const block of yml.split("\n      - name: ").slice(1)) {
    const afterRun = block.split("\n        run: ")[1];
    if (afterRun === undefined) continue;
    const script = afterRun.startsWith("|\n") ? runLines(afterRun.slice(2)).join("\n") : afterRun.split("\n")[0];
    assert.doesNotMatch(script, /\$\{\{/u);
  }
  assert.match(stepBody("Run the hub compatibility and promotion gates"), /HUB_TOKEN: \$\{\{ steps\.hub-token\.outputs\.token \}\}/u);
  assert.match(stepBody("Select the deploy inputs"), /PLATFORM_TOKEN: \$\{\{ steps\.platform-token\.outputs\.token \}\}\n          BACKEND_TOKEN: \$\{\{ steps\.backend-token\.outputs\.token \}\}/u);
  assert.match(stepBody("Deploy the release (PREVIEW then DEPLOY)"), /PLATFORM_TOKEN: \$\{\{ steps\.platform-token\.outputs\.token \}\}/u);
  assert.match(stepBody("Roll back to the previous active release"), /PLATFORM_TOKEN: \$\{\{ steps\.platform-token-rollback\.outputs\.token \}\}/u);
  assert.ok(yml.indexOf("Require cross-repository dispatch app credentials") < yml.indexOf("Create the hub token"));
});

test("the chain job runs the stages in order, serializes itself and rolls back only after a successful deploy whose verification failed", () => {
  const chain = jobBlock("chain");
  const order = [
    "Require cross-repository dispatch app credentials", "Plan the chain from the release candidate commit", "Create the hub token",
    "Run the hub compatibility and promotion gates", "Publish the data pack to production", "Create the platform token",
    "Create the backend read token", "Select the deploy inputs", "Deploy the release (PREVIEW then DEPLOY)", "Verify the public release",
    "Create the platform token for the rollback", "Roll back to the previous active release", "Upload the chain state",
    "Report the chain failure as an issue",
  ].map((name) => chain.indexOf(`      - name: ${name}\n`));
  assert.ok(order.every((index) => index !== -1), "all stages exist");
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(chain, /\n    concurrency:\n      group: datapack-release-chain\n      cancel-in-progress: false\n/u);
  assert.match(chain, /\n    timeout-minutes: 55\n/u);
  assert.match(chain, /\n    permissions:\n      actions: write\n      contents: read\n      issues: write\n/u);
  for (const stage of ["plan", "hub-gates", "publish", "select-deploy", "deploy", "verify", "rollback"]) {
    assert.equal(chain.split(`node tools/ci/datapack-release-chain.mjs ${stage} --state "\${RUNNER_TEMP}/chain-state.json"`).length - 1, 1, stage);
  }
  const rollbackCondition = "if: ${{ failure() && steps.deploy.outcome == 'success' && steps.verify.outcome == 'failure' }}";
  assert.match(stepBody("Create the platform token for the rollback"), new RegExp(rollbackCondition.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(stepBody("Roll back to the previous active release"), new RegExp(rollbackCondition.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(stepBody("Deploy the release (PREVIEW then DEPLOY)"), /\n        id: deploy\n/u);
  assert.match(stepBody("Verify the public release"), /\n        id: verify\n/u);
  assert.match(stepBody("Upload the chain state"), /if: \$\{\{ always\(\) \}\}/u);
  // 실패 보고는 마지막 step이고 failure()에서만 돈다.
  const report = stepBody("Report the chain failure as an issue");
  assert.match(report, /if: \$\{\{ failure\(\) \}\}/u);
  assert.ok(report.includes('node tools/ci/report-refresh-failure.mjs --workflow datapack-release-cross-repo-chain.yml --repository "${GITHUB_REPOSITORY}" --run-id "${GITHUB_RUN_ID}"'));
  // 발행·배포 단계가 쓰는 공개 URL은 저장소 변수에서만 온다.
  assert.match(chain, /CHAIN_API_BASE_URL: \$\{\{ vars\.DEPLOY_PUBLIC_API_BASE_URL \}\}/u);
  assert.match(chain, /CHAIN_DATAPACK_BASE_URL: \$\{\{ vars\.OCI_SERVER_ROUTE_PUBLIC_BASE_URL \}\}/u);
});

test("a failed release-candidate or production-publish run is reported as the chain failure issue (data#1084)", () => {
  const job = jobBlock("report-release-failure");
  assert.match(job, /\n    permissions:\n      actions: read\n      contents: read\n      issues: write\n/u);
  assert.match(job, /FAILED_RUN_ID: \$\{\{ github\.event\.workflow_run\.id \}\}/u);
  assert.ok(job.includes('--workflow datapack-release-cross-repo-chain.yml --repository "${GITHUB_REPOSITORY}" --run-id "${FAILED_RUN_ID}"'));
});

test("only a run with exactly one unexpired RC candidate artifact of the same run and head commit is dispatched (F2)", async () => {
  const runId = 37109648483;
  const headSha = "a".repeat(40);
  // workflow_run 경로는 이벤트의 head_sha를 함께 주고, workflow_dispatch 경로는 비운다(둘 다 API로 다시 읽은 값으로 판정한다).
  // GITHUB_RUN_ID는 이 체인 run 자신이다(RC run과 다른 번호). workflow_dispatch 경로만 이 run의 시작 행위자를 API로 읽는다.
  const env = { GITHUB_REPOSITORY: "AquilaXk/easysubway-data", GITHUB_RUN_ID: "5555", EVENT_NAME: "workflow_run", RUN_ID: String(runId), EVENT_HEAD_SHA: headSha, GH_TOKEN: "test" };
  const dispatchEnv = { ...env, EVENT_NAME: "workflow_dispatch", EVENT_HEAD_SHA: "" };
  const artifact = (overrides = {}) => ({
    id: 11269456267, name: `easysubway-datapack-candidate-${runId}`, expired: false,
    workflow_run: { id: runId, head_sha: headSha }, ...overrides,
  });
  const runRecord = (actor, overrides = {}) => ({
    path: ".github/workflows/datapack-release.yml", event: "workflow_dispatch", head_branch: "main",
    head_repository: { full_name: "AquilaXk/easysubway-data" }, display_title: "Data Pack Release (release-candidate)",
    conclusion: "success", head_sha: headSha, created_at: "2026-10-11T04:30:00Z", triggering_actor: { login: actor }, ...overrides,
  });
  // 가짜 gh: artifact 조회는 payload를, 그 밖의 run 조회는 run 기록을 답한다. 판정은 이벤트 값이 아니라 이 API 응답이 근거다.
  // 같은 RC로 이미 시작된 체인 run(F3)은 목록 API(prior)와 그 run의 job 목록(jobs, run id별)으로 답한다.
  const ghWith = (record, payload, starter = "github-actions[bot]", prior = [], jobs = {}) => `case "$*" in
*"/artifacts"*) cat <<'JSON'
${JSON.stringify(payload)}
JSON
;;
*"datapack-release-cross-repo-chain.yml/runs"*) cat <<'JSON'
${JSON.stringify({ workflow_runs: prior })}
JSON
;;
${Object.entries(jobs).map(([id, list]) => `*"/runs/${id}/jobs"*) cat <<'JSON'\n${JSON.stringify({ jobs: list })}\nJSON\n;;`).join("\n")}
*"/runs/5555"*) echo '${starter}' ;;
*) cat <<'JSON'
${JSON.stringify(record)}
JSON
;;
esac`;
  const ghAs = (actor, payload) => ghWith(runRecord(actor), payload);
  const gh = (payload) => ghAs("github-actions[bot]", payload);
  const ok = { total_count: 1, artifacts: [artifact()] };
  const chainRun = (id, status, conclusion = null, title = `chain rc=${runId}`) => ({ id, status, conclusion, display_title: title });
  const withPrior = (prior, jobs = {}) => ghWith(runRecord("github-actions[bot]"), ok, "github-actions[bot]", prior, jobs);
  const started = `rc=true\nrun_id=${runId}\nhead_sha=${headSha}\n`;
  const candidate = await runStep("Identify the release-candidate run", env, gh(ok));
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.equal(candidate.output, started);
  assert.match(candidate.summary, /37109648483/u);
  // workflow_dispatch 경로: 이벤트 값 없이 입력 run id만으로 같은 판정을 한다. head_sha는 API 기록에서 온다.
  const handedOver = await runStep("Identify the release-candidate run", dispatchEnv, gh(ok));
  assert.equal(handedOver.status, 0, handedOver.stderr);
  assert.equal(handedOver.output, started);
  const handedOverByOwner = await runStep("Identify the release-candidate run", dispatchEnv, ghWith(runRecord("github-actions[bot]"), ok, "AquilaXk"));
  assert.equal(handedOverByOwner.output, started);
  // 체인 run을 시작한 행위자가 허용 목록 밖이면 RC가 완전해도 체인을 시작하지 않는다(job `if`가 아니라 API로 읽은 값으로 판정한다).
  for (const starter of ["write-collaborator", "AquilaXk-evil", "aquilaxk", "github-actions", "easysubway-release-chain[bot]", ""]) {
    const denied = await runStep("Identify the release-candidate run", dispatchEnv, ghWith(runRecord("github-actions[bot]"), ok, starter));
    assert.equal(denied.status, 0, `${starter}: ${denied.stderr}`);
    assert.equal(denied.output, "rc=false\n", starter);
    assert.match(denied.summary, /허용되지 않은 행위자가 dispatch/u, starter);
    // workflow_run 경로는 이 run의 시작 행위자를 보지 않는다(시스템이 띄운 run이다). RC run의 행위자만 판정한다.
    const viaEvent = await runStep("Identify the release-candidate run", env, ghWith(runRecord("github-actions[bot]"), ok, starter));
    assert.equal(viaEvent.output, started, starter);
  }
  const owner = await runStep("Identify the release-candidate run", env, ghAs("AquilaXk", ok));
  assert.equal(owner.output, started);
  // 허용 목록 밖 행위자(유사 이름·대소문자·빈 값 포함)가 dispatch한 RC는 후보 artifact가 완전해도 체인을 시작하지 않는다.
  for (const actor of ["write-collaborator", "AquilaXk-evil", "aquilaxk", "github-actions", "github-actions[bot]x", "easysubway-release-chain[bot]", ""]) {
    for (const eventHeadSha of [headSha, ""]) {
      const denied = await runStep("Identify the release-candidate run", { ...env, EVENT_HEAD_SHA: eventHeadSha }, ghAs(actor, ok));
      assert.equal(denied.status, 0, `${actor}: ${denied.stderr}`);
      assert.equal(denied.output, "rc=false\n", actor);
      assert.match(denied.summary, /허용되지 않은 행위자/u, actor);
    }
  }
  const exploratory = await runStep("Identify the release-candidate run", env, gh({ total_count: 0, artifacts: [] }));
  assert.equal(exploratory.status, 0, exploratory.stderr);
  assert.equal(exploratory.output, "rc=false\n");
  assert.match(exploratory.summary, /시작하지 않는다/u);
  // 입력으로 받은 run id가 성공한 main의 이 저장소 RC가 아니면 조용히 건너뛰지 않고 실패한다(잘못된 handover는 이상이다).
  for (const [label, overrides] of [
    ["other workflow", { path: ".github/workflows/ci.yml" }],
    ["not dispatched", { event: "push" }],
    ["other branch", { head_branch: "feature" }],
    ["other repository", { head_repository: { full_name: "someone/easysubway-data" } }],
    ["publish run", { display_title: "Data Pack Release (production-publish)" }],
    ["failed run", { conclusion: "failure" }],
    ["unfinished run", { conclusion: null }],
    ["no head sha", { head_sha: "abc" }],
  ]) {
    for (const eventHeadSha of [headSha, ""]) {
      const result = await runStep("Identify the release-candidate run", { ...env, EVENT_HEAD_SHA: eventHeadSha }, ghWith(runRecord("github-actions[bot]", overrides), ok));
      assert.notEqual(result.status, 0, label);
      assert.equal(result.output, "", label);
    }
  }
  // F3: 같은 RC로 이미 진행된(성공했거나 진행 중인) 체인 run이 있으면 시작하지 않고 실패로 드러낸다. 두 시작 경로 모두 같다.
  const releaseChainJob = (conclusion) => [{ name: "Identify the release-candidate run", conclusion: "success" }, { name: "Release chain", conclusion }];
  for (const [label, scenarioEnv] of [["workflow_run", env], ["workflow_dispatch", dispatchEnv]]) {
    for (const [name, prior, jobs] of [
      ["earlier run in progress", [chainRun(5000, "in_progress")], {}],
      ["earlier run queued", [chainRun(5001, "queued")], {}],
      ["earlier run waiting on the chain lock", [chainRun(5002, "pending")], {}],
      ["completed run whose chain succeeded", [chainRun(5003, "completed", "success")], { 5003: releaseChainJob("success") }],
    ]) {
      const duplicate = await runStep("Identify the release-candidate run", scenarioEnv, withPrior(prior, jobs));
      assert.notEqual(duplicate.status, 0, `${label}: ${name}`);
      assert.equal(duplicate.output, "", `${label}: ${name}`);
      assert.match(duplicate.stderr, /duplicate/u, `${label}: ${name}`);
    }
    for (const [name, prior, jobs] of [
      ["no earlier run", [], {}],
      ["a later run in progress loses the tie, this earlier run wins", [chainRun(6000, "in_progress")], {}],
      ["completed run whose chain job was skipped", [chainRun(5003, "completed", "success")], { 5003: releaseChainJob("skipped") }],
      ["completed run that failed", [chainRun(5004, "completed", "failure")], {}],
      ["completed run that was cancelled", [chainRun(5005, "completed", "cancelled")], {}],
      ["another release candidate's chain run", [chainRun(5006, "in_progress", null, "chain rc=1")], {}],
      ["a run without the chain title", [chainRun(5007, "in_progress", null, "Data Pack Release Cross-Repository Chain")], {}],
    ]) {
      const fresh = await runStep("Identify the release-candidate run", scenarioEnv, withPrior(prior, jobs));
      assert.equal(fresh.status, 0, `${label}: ${name}: ${fresh.stderr}`);
      assert.equal(fresh.output, started, `${label}: ${name}`);
    }
  }
  // 이전 chain run 조회는 RC가 시작된 시각 이후로 한정하고, 목록을 못 읽으면 중복이 없다고 가정하지 않고 실패한다.
  const lookupFails = await runStep("Identify the release-candidate run", env, `case "$*" in\n*"datapack-release-cross-repo-chain.yml/runs"*) echo boom >&2; exit 1 ;;\n*) ${ghWith(runRecord("github-actions[bot]"), ok)} ;;\nesac`);
  assert.notEqual(lookupFails.status, 0);
  assert.equal(lookupFails.output, "");
  assert.match(stepScript("Identify the release-candidate run"), /-f "created=>=\$\{rc_created\}"/u);
  const movedHead = await runStep("Identify the release-candidate run", { ...env, EVENT_HEAD_SHA: "b".repeat(40) }, gh(ok));
  assert.notEqual(movedHead.status, 0);
  assert.equal(movedHead.output, "");
  for (const [label, payload] of [
    ["expired", { total_count: 1, artifacts: [artifact({ expired: true })] }],
    ["other head", { total_count: 1, artifacts: [artifact({ workflow_run: { id: runId, head_sha: "b".repeat(40) } })] }],
    ["other run", { total_count: 1, artifacts: [artifact({ workflow_run: { id: 1, head_sha: headSha } })] }],
    ["two artifacts", { total_count: 2, artifacts: [artifact(), artifact({ id: 2 })] }],
    ["inconsistent", { total_count: "1", artifacts: [] }],
  ]) {
    const result = await runStep("Identify the release-candidate run", env, gh(payload));
    assert.notEqual(result.status, 0, label);
    assert.equal(result.output, "", label);
  }
  const apiFailure = await runStep("Identify the release-candidate run", env, "echo boom >&2; exit 1");
  assert.notEqual(apiFailure.status, 0);
  assert.equal(apiFailure.output, "");
  const badRunId = await runStep("Identify the release-candidate run", { ...env, RUN_ID: "1;rm" }, gh({ total_count: 0, artifacts: [] }));
  assert.notEqual(badRunId.status, 0);
  assert.match(badRunId.stderr, /workflow_run id is invalid/u);
  const badSha = await runStep("Identify the release-candidate run", { ...env, EVENT_HEAD_SHA: "abc" }, gh({ total_count: 0, artifacts: [] }));
  assert.notEqual(badSha.status, 0);
  assert.match(badSha.stderr, /workflow_run head_sha is invalid/u);
  const identify = stepBody("Identify the release-candidate run");
  assert.match(identify, /node tools\/ci\/require-workflow-artifact\.mjs "\$\{response\}" "\$\{name\}" "\$\{RUN_ID\}" "\$\{head_sha\}"/u);
  // run id는 두 경로에서 오고, 이벤트의 head_sha는 API 기록과 대조하는 값일 뿐이다. 둘 다 expression이 아니라 env로만 스크립트에 들어간다.
  assert.match(yml, /RUN_ID: \$\{\{ github\.event\.workflow_run\.id \|\| inputs\.rc_run_id \}\}/u);
  assert.match(yml, /EVENT_HEAD_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/u);
  assert.match(jobBlock("identify"), /\n    outputs:\n      rc: \$\{\{ steps\.rc\.outputs\.rc \}\}\n      run_id: \$\{\{ steps\.rc\.outputs\.run_id \}\}\n      head_sha: \$\{\{ steps\.rc\.outputs\.head_sha \}\}\n/u);
  assert.match(jobBlock("chain"), /\n      RC_RUN_ID: \$\{\{ needs\.identify\.outputs\.run_id \}\}\n      RC_RUN_SHA: \$\{\{ needs\.identify\.outputs\.head_sha \}\}\n/u);
  assert.match(yml, /- uses: actions\/checkout@[0-9a-f]{40}\n        with:\n          persist-credentials: false\n/u);
  assert.doesNotMatch(yml, /ref: \$\{\{ github\.event\.workflow_run/u);
});

test("every chain run is named by the release-candidate run it was started for, so a duplicate start is detectable (data#1158 F2/F3)", () => {
  assert.match(yml, /\nrun-name: \$\{\{ format\('chain rc=\{0\}', github\.event\.workflow_run\.id \|\| inputs\.rc_run_id\) \}\}\n/u);
  assert.ok(yml.indexOf("\nrun-name:") < yml.indexOf("\non:\n"));
});

test("missing app credentials fail before any token or dispatch step, naming the secrets", async () => {
  const none = await runStep("Require cross-repository dispatch app credentials", { APP_CLIENT_ID: "", APP_PRIVATE_KEY: "" });
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /EASYSUBWAY_RELEASE_APP_CLIENT_ID/u);
  assert.match(none.stderr, /EASYSUBWAY_RELEASE_APP_PRIVATE_KEY/u);
  const keyOnly = await runStep("Require cross-repository dispatch app credentials", { APP_CLIENT_ID: "", APP_PRIVATE_KEY: "key" });
  assert.notEqual(keyOnly.status, 0);
  assert.match(keyOnly.stderr, /EASYSUBWAY_RELEASE_APP_CLIENT_ID/u);
  assert.doesNotMatch(keyOnly.stderr, /EASYSUBWAY_RELEASE_APP_PRIVATE_KEY/u);
  const both = await runStep("Require cross-repository dispatch app credentials", { APP_CLIENT_ID: "Iv1.test", APP_PRIVATE_KEY: "key" });
  assert.equal(both.status, 0, both.stderr);
  assert.doesNotMatch(`${both.stdout}${both.stderr}`, /Iv1\.test|key/u);
});
