import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DEFAULT_REQUEST_TIMEOUT_MS, MAX_REQUEST_ATTEMPTS, RETRY_CAP_DELAY_MS } from "../datapack/collect-seoul-accessibility-evidence.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."); const workflowPath = path.join(root, ".github/workflows/seoul-current-accessibility-refresh.yml");
test("Seoul refresh workflow is due-only, main-only, collector-retry, OCI registration pushing directly to main", () => {
  assert.ok(existsSync(workflowPath));
  const yml = readFileSync(workflowPath, "utf8");
  assert.match(yml, /cron: "31 \*\/2 \* \* \*"/);
  assert.match(yml, /github\.ref == 'refs\/heads\/main'/);
  assert.match(yml, /cancel-in-progress: false/);
  assert.match(yml, /mkdir -p "\$\{RUNNER_TEMP\}\/seoul-current-accessibility-refresh\/\$\{GITHUB_RUN_ID\}"/);
  assert.match(yml, /decide-current-seoul-accessibility-refresh\.mjs/);
  assert.match(yml, /run-current-seoul-accessibility-registration\.mjs[^\n]+--phase collect/);
  assert.match(yml, /Commit and push Seoul accessibility refresh[\s\S]*GH_TOKEN: \$\{\{ github\.token \}\}[\s\S]*git add -- "\$\{untracked\[0\]\}"[\s\S]*git diff --cached --name-only --diff-filter=ACMR[\s\S]*git push origin HEAD:main/);
  assert.match(yml, /Refresh Seoul accessibility snapshot/);
  assert.match(yml, /source-inventory\.json/);
  assert.match(yml, /source-snapshots\.json/);
  assert.match(yml, /capital-pilot-production-source-input\.json/);
  assert.doesNotMatch(yml, /aws|s3:|fallback|automerge|pull-requests:\s*write|issues:\s*write|create-github-app-token|gh pr create|automation\/|gh workflow run|git add -A|git add \./i);
});

test("pending full fan-in cannot reach a Seoul refresh side effect", () => {
  const yml = readFileSync(workflowPath, "utf8");
  for (const name of [
    "Validate provider configuration",
    "Collect current snapshot",
    "Publish and register Seoul accessibility snapshot",
    "Commit and push Seoul accessibility refresh",
  ]) {
    const start = yml.indexOf(`      - name: ${name}\n`);
    assert.notEqual(start, -1, `missing workflow step: ${name}`);
    const end = yml.indexOf("\n      - name: ", start + 1);
    const body = yml.slice(start, end === -1 ? yml.length : end);
    assert.match(body, /\n\s+if: \$\{\{[^\n]+steps\.decision\.outputs\.state/);
    assert.doesNotMatch(body, /PENDING_FULL_FAN_IN|outputs\.state\s*!=/);
  }
});

test("Seoul refresh workflow ends at ledger registration and never commits candidate-side outputs (#862 결정 C)", () => {
  const yml = readFileSync(workflowPath, "utf8");
  for (const candidateSide of ["candidate-build-spec.json", "release-request.json", "hash-evidence.json"]) {
    assert.equal(yml.includes(candidateSide), false, `${candidateSide} belongs to the nationwide candidate refresh`);
  }
  assert.equal((yml.match(/\[\[ "\$\(wc -l <<< "\$\{changed\}" \| tr -d ' '\)" == "4" \]\]/g) ?? []).length, 1);
});

test("Seoul refresh uses solo permissions and runs failure summary last", () => {
  const yml = readFileSync(workflowPath, "utf8");
  assert.match(yml, /\n    permissions:\n      actions: read\n      contents: write\n/);
  const step = (name) => {
    const start = yml.indexOf(`      - name: ${name}\n`);
    assert.notEqual(start, -1, `missing workflow step: ${name}`);
    const end = yml.indexOf("\n      - name: ", start + 1);
    return yml.slice(start, end === -1 ? yml.length : end);
  };
  const decision = step("Read due state");
  assert.match(decision, /decide-current-seoul-accessibility-refresh\.mjs/);
  assert.doesNotMatch(decision, /gh run list|collect-automation-prs|claim-orphans/);
  const report = step("Report refresh failure summary");
  assert.match(report, /node tools\/ci\/report-refresh-failure\.mjs --workflow seoul-current-accessibility-refresh\.yml/);
  assert.equal(yml.lastIndexOf("      - name: "), yml.indexOf("      - name: Report refresh failure summary\n"));
});

// #995 F1: 수집과 게시·등록을 다른 step으로 나눠야 실패 시 OCI 게시 전후 경계를 분리할 수 있다.
test("Seoul collection and publication are separate steps that share the observation name", () => {
  const yml = readFileSync(workflowPath, "utf8");
  const stepOf = (name) => {
    const start = yml.indexOf(`      - name: ${name}\n`);
    assert.notEqual(start, -1, `missing workflow step: ${name}`);
    const end = yml.indexOf("\n      - name: ", start + 1);
    return yml.slice(start, end === -1 ? yml.length : end);
  };
  const collect = stepOf("Collect current snapshot");
  const publish = stepOf("Publish and register Seoul accessibility snapshot");
  assert.match(collect, /run-current-seoul-accessibility-registration\.mjs --observation-name "refresh-\$\{GITHUB_RUN_ID\}" --receipt "\$\{SEOUL_REFRESH_RECEIPT\}" --phase collect/);
  assert.match(publish, /run-current-seoul-accessibility-registration\.mjs --observation-name "refresh-\$\{GITHUB_RUN_ID\}" --receipt "\$\{SEOUL_REFRESH_RECEIPT\}" --phase publish/);
  for (const body of [collect, publish]) {
    assert.match(body, /DATA_GO_KR_SERVICE_KEY: \$\{\{ secrets\.DATA_GO_KR_SERVICE_KEY \}\}/);
    assert.match(body, /\[\[ "\$\(git rev-parse HEAD\)" == "\$\{SEOUL_REFRESH_MAIN_SHA\}" \]\]/);
    assert.match(body, /\n        if: \$\{\{ steps\.decision\.outputs\.state == 'DUE' \|\| steps\.decision\.outputs\.state == 'EXPIRED' \}\}\n/);
  }
  assert.match(publish, /git ls-remote origin refs\/heads\/main/);
  const at = (name) => yml.indexOf(`      - name: ${name}\n`);
  assert.ok(at("Prepare paths") < at("Collect current snapshot") && at("Collect current snapshot") < at("Publish and register Seoul accessibility snapshot") && at("Publish and register Seoul accessibility snapshot") < at("Commit and push Seoul accessibility refresh"));
  assert.equal(yml.includes("Collect and bind current snapshot"), false);
});

const WORST_CASE_PAGES = 10;

// #1326 (Refs #870): 일시 오류 재시도는 수집기 안에서만, 최대 3번 시도로 한정한다. workflow는 재시도를 늘리거나 감싸지 않는다.
test("Seoul refresh retries only inside the collector: attempt cap 3, no unbounded shell retry, worst case fits the job timeout", () => {
  const yml = readFileSync(workflowPath, "utf8");
  assert.equal(MAX_REQUEST_ATTEMPTS, 3);
  assert.doesNotMatch(yml, /--request-attempts/, "workflow must not override the collector attempt cap");
  assert.doesNotMatch(yml, /\bretry\b|--retries|\buntil\b|while true|for attempt|nick-fields\/retry/i, "no workflow-level retry or loop around the collector");
  // 요청 하나의 최악 시간 = 시도 수 × 요청 timeout + (시도 수 - 1) × Retry-After cap. page 10개(현재 행 865개의 10배 이상)까지 job timeout의 절반 안에 들어와야 한다.
  const worstCaseRequestMs = MAX_REQUEST_ATTEMPTS * DEFAULT_REQUEST_TIMEOUT_MS + (MAX_REQUEST_ATTEMPTS - 1) * RETRY_CAP_DELAY_MS;
  const timeoutMs = Number(/timeout-minutes: (\d+)/.exec(yml)[1]) * 60_000;
  assert.ok(WORST_CASE_PAGES * worstCaseRequestMs < timeoutMs / 2, `${WORST_CASE_PAGES * worstCaseRequestMs} ms must stay under half of the ${timeoutMs} ms job timeout`);
});
