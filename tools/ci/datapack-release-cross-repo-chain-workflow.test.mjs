import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const yml = readFileSync(new URL("../../.github/workflows/datapack-release-cross-repo-chain.yml", import.meta.url), "utf8");

// F3: 기본은 꺼짐이다. 메인 세션이 설정 변경을 적용한 뒤 저장소 변수를 'true'로 켤 때만 job이 실행된다.
const RC_GUARD = "    if: ${{ "
  + "vars.DATAPACK_CROSS_REPO_CHAIN_ENABLED == 'true' && "
  + "github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'workflow_dispatch' "
  + "&& github.event.workflow_run.head_branch == 'main' && github.event.workflow_run.head_repository.full_name == github.repository "
  + "&& github.event.workflow_run.path == '.github/workflows/datapack-release.yml' "
  + "&& github.event.workflow_run.display_title == 'Data Pack Release (release-candidate)' "
  + "&& (github.event.workflow_run.triggering_actor.login == 'github-actions[bot]' || github.event.workflow_run.triggering_actor.login == 'AquilaXk') }}";
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
  assert.match(yml, /^on:\n  workflow_run:\n    workflows: \["Data Pack Release"\]\n    types: \[completed\]\n/mu);
  assert.doesNotMatch(yml, /\n  (schedule|push|pull_request|workflow_dispatch):/u);
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
  const env = { GITHUB_REPOSITORY: "AquilaXk/easysubway-data", RUN_ID: String(runId), RUN_HEAD_SHA: headSha, GH_TOKEN: "test" };
  const artifact = (overrides = {}) => ({
    id: 11269456267, name: `easysubway-datapack-candidate-${runId}`, expired: false,
    workflow_run: { id: runId, head_sha: headSha }, ...overrides,
  });
  const gh = (payload) => `cat <<'JSON'\n${JSON.stringify(payload)}\nJSON`;
  const candidate = await runStep("Identify the release-candidate run", env, gh({ total_count: 1, artifacts: [artifact()] }));
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.equal(candidate.output, "rc=true\n");
  assert.match(candidate.summary, /37109648483/u);
  const exploratory = await runStep("Identify the release-candidate run", env, gh({ total_count: 0, artifacts: [] }));
  assert.equal(exploratory.status, 0, exploratory.stderr);
  assert.equal(exploratory.output, "rc=false\n");
  assert.match(exploratory.summary, /시작하지 않는다/u);
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
  const badSha = await runStep("Identify the release-candidate run", { ...env, RUN_HEAD_SHA: "abc" }, gh({ total_count: 0, artifacts: [] }));
  assert.notEqual(badSha.status, 0);
  assert.match(badSha.stderr, /workflow_run head_sha is invalid/u);
  const identify = stepBody("Identify the release-candidate run");
  assert.match(identify, /node tools\/ci\/require-workflow-artifact\.mjs "\$\{response\}" "\$\{name\}" "\$\{RUN_ID\}" "\$\{RUN_HEAD_SHA\}"/u);
  assert.match(yml, /RUN_HEAD_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/u);
  assert.match(yml, /- uses: actions\/checkout@[0-9a-f]{40}\n        with:\n          persist-credentials: false\n/u);
  assert.doesNotMatch(yml, /ref: \$\{\{ github\.event\.workflow_run/u);
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
