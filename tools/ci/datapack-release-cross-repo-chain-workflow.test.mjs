import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const yml = readFileSync(new URL("../../.github/workflows/datapack-release-cross-repo-chain.yml", import.meta.url), "utf8");

// F3: 기본은 꺼짐이다. 메인 세션이 App 등록 뒤 QA 승인을 받아 저장소 변수를 'true'로 켤 때만 job이 실행된다.
const JOB_GUARD = "    if: ${{ "
  + "vars.DATAPACK_CROSS_REPO_CHAIN_ENABLED == 'true' && "
  + "github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'workflow_dispatch' "
  + "&& github.event.workflow_run.head_branch == 'main' && github.event.workflow_run.head_repository.full_name == github.repository "
  + "&& github.event.workflow_run.path == '.github/workflows/datapack-release.yml' }}";

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
  return body.slice(begin + marker.length).split("\n").map((line) => line.replace(/^ {10}/u, "")).join("\n");
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

test("the chain reacts only to a successful main workflow_dispatch Data Pack Release run of this repository (#932)", () => {
  assert.match(yml, /^on:\n  workflow_run:\n    workflows: \["Data Pack Release"\]\n    types: \[completed\]\n/mu);
  assert.doesNotMatch(yml, /\n  (schedule|push|pull_request|workflow_dispatch):/u);
  assert.match(yml, /\npermissions:\n  actions: read\n  contents: read\n/u);
  // App 토큰 경로 앞의 유일한 장벽이므로 guard 전체를 정확히 고정한다(&&를 ||로 바꾸는 변이가 잡혀야 한다).
  const guards = yml.split("\n").filter((line) => line.startsWith("    if: "));
  assert.deepEqual(guards, [JOB_GUARD]);
});

test("the app token is scoped to dispatching workflows in the hub repository only", () => {
  const token = stepBody("Create the hub dispatch token");
  assert.match(token, /uses: actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1/u);
  assert.match(token, /client-id: \$\{\{ secrets\.EASYSUBWAY_RELEASE_APP_CLIENT_ID \}\}/u);
  assert.match(token, /private-key: \$\{\{ secrets\.EASYSUBWAY_RELEASE_APP_PRIVATE_KEY \}\}/u);
  assert.match(token, /owner: AquilaXk\n/u);
  assert.match(token, /repositories: easysubway\n/u);
  assert.match(token, /permission-actions: write$/u);
  assert.doesNotMatch(token, /permission-contents: write|permission-pull-requests/u);
  const dispatch = stepBody("Dispatch hub data pack compatibility");
  assert.match(dispatch, /GH_TOKEN: \$\{\{ steps\.app-token\.outputs\.token \}\}/u);
  assert.match(dispatch, /gh workflow run release-artifacts\.yml --repo AquilaXk\/easysubway --ref main -f android_rc_signing_mode=ci-self-signed -f datapack_candidate_run_id="\$\{RUN_ID\}"/u);
  for (const name of ["Require cross-repository dispatch app credentials", "Create the hub dispatch token", "Dispatch hub data pack compatibility"]) {
    assert.match(stepBody(name), /if: \$\{\{ steps\.rc\.outputs\.rc == 'true' \}\}/u, name);
  }
  assert.ok(yml.indexOf("Require cross-repository dispatch app credentials") < yml.indexOf("Create the hub dispatch token"));
  // secret 값은 env나 with로만 들어가고 run 스크립트에 직접 쓰이지 않는다.
  for (const block of yml.split("\n      - name: ").slice(1)) {
    assert.doesNotMatch(block.split("\n        run: ")[1] ?? "", /\$\{\{\s*secrets\./u);
  }
  assert.doesNotMatch(yml, /production-publish|DEPLOY|datapack-promotion\.yml|continue-on-error/u);
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
  assert.match(exploratory.summary, /dispatch하지 않는다/u);
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
