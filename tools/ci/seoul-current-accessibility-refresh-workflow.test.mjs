import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DEFAULT_REQUEST_TIMEOUT_MS, MAX_REQUEST_ATTEMPTS, RETRY_CAP_DELAY_MS } from "../datapack/collect-seoul-accessibility-evidence.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."); const workflowPath = path.join(root, ".github/workflows/seoul-current-accessibility-refresh.yml");
test("Seoul refresh workflow is due-only, main-only, collector-retry, OCI registration with one draft PR", () => { assert.ok(existsSync(workflowPath)); const yml = readFileSync(workflowPath, "utf8"); assert.match(yml, /cron: "31 \*\/2 \* \* \*"/); assert.match(yml, /github\.ref == 'refs\/heads\/main'/); assert.match(yml, /cancel-in-progress: false/); assert.match(yml, /mkdir -p "\$\{RUNNER_TEMP\}\/seoul-current-accessibility-refresh\/\$\{GITHUB_RUN_ID\}"/); assert.match(yml, /decide-current-seoul-accessibility-refresh\.mjs/); assert.match(yml, /RECOVER_CLAIM/); assert.match(yml, /automation\/639-seoul-accessibility-refresh-\$\{GITHUB_RUN_ID\}/); assert.match(yml, /run-current-seoul-accessibility-registration\.mjs[^\n]+--phase collect/); assert.match(yml, /git config user\.name "github-actions\[bot\]"[\s\S]*git config user\.email "41898282\+github-actions\[bot\]@users\.noreply\.github\.com"[\s\S]*git commit --allow-empty -m "Claim Seoul accessibility refresh"/); assert.match(yml, /Finalize claimed refresh branch[\s\S]*GH_TOKEN: \$\{\{ github\.token \}\}[\s\S]*git add -A[\s\S]*git diff --cached --name-only --diff-filter=ACMR[\s\S]*git push origin "\$\{SEOUL_REFRESH_BRANCH\}"/); assert.match(yml, /git rev-list --count HEAD\.\."origin\/\$\{branch\}"/); assert.match(yml, /--draft/); assert.match(yml, /Refresh Seoul accessibility snapshot/); assert.match(yml, /source-inventory\.json/); assert.match(yml, /source-snapshots\.json/); assert.match(yml, /capital-pilot-production-source-input\.json/); assert.doesNotMatch(yml, /aws|s3:|fallback|automerge|git push origin main|gh workflow run/i); });

test("pending full fan-in cannot reach a Seoul refresh side effect", () => {
  const yml = readFileSync(workflowPath, "utf8");
  for (const name of [
    "Recover completed claimed refresh",
    "Create durable claim",
    "Validate provider configuration",
    "Collect current snapshot",
    "Publish and register Seoul accessibility snapshot",
    "Finalize claimed refresh branch",
    "Create draft pull request",
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
  assert.equal((yml.match(/\[\[ "\$\(wc -l <<< "\$\{changed\}" \| tr -d ' '\)" == "4" \]\]/g) ?? []).length, 2);
});

// #995: PR 없는 claim(고아)은 DUE 여부와 무관하게 만든 run과 게시 증거로 판정한다. 빈 claim뿐이면 보고(#926)한 뒤 지운다.
test("orphan claims are classified from run and publication evidence and cleaned before any claim or recovery", () => {
  const yml = readFileSync(workflowPath, "utf8");
  assert.match(yml, /\n    permissions:\n      actions: read\n      contents: write\n      pull-requests: write\n      issues: write\n/);
  const step = (name) => {
    const start = yml.indexOf(`      - name: ${name}\n`);
    assert.notEqual(start, -1, `missing workflow step: ${name}`);
    const end = yml.indexOf("\n      - name: ", start + 1);
    return yml.slice(start, end === -1 ? yml.length : end);
  };
  const decision = step("Read due state");
  const collect = decision.indexOf("node tools/ci/collect-automation-prs.mjs");
  const evidence = decision.indexOf('node tools/ci/claim-orphans.mjs --workflow seoul-current-accessibility-refresh.yml --repository "${GITHUB_REPOSITORY}" --refs "${claims}" --prs "${prs}" --output "${claim_evidence}"');
  assert.ok(collect !== -1 && evidence > collect);
  assert.ok(decision.indexOf("decide-current-seoul-accessibility-refresh.mjs") > evidence);
  assert.match(decision, /--claims "\$\{claims\}" --claim-evidence "\$\{claim_evidence\}" --repository/);
  assert.doesNotMatch(decision, /gh run list/);
  const cleanup = step("Remove abandoned Seoul refresh claims named by the decision");
  assert.match(cleanup, /\n        if: \$\{\{ steps\.decision\.outputs\.cleanup_claims != '' \}\}\n/);
  assert.match(cleanup, /\n          CLEANUP_CLAIMS: \$\{\{ steps\.decision\.outputs\.cleanup_claims \}\}\n/);
  const script = cleanup.split("\n        run: ")[1];
  assert.doesNotMatch(script, /\$\{\{/);
  assert.match(script, /gh auth setup-git\n[\s\S]*node tools\/ci\/remove-orphan-claims\.mjs --workflow seoul-current-accessibility-refresh\.yml --repository "\$\{GITHUB_REPOSITORY\}" --claims "\$\{CLEANUP_CLAIMS\}" --refs "\$\{RUNNER_TEMP\}\/seoul-current-accessibility-refresh\/claims\.txt"/);
  assert.doesNotMatch(script, /git push origin --delete/);
  const running = step("Note Seoul refresh waiting on a running producer");
  assert.match(running, /\n        if: \$\{\{ steps\.decision\.outputs\.state == 'CLAIM_IN_PROGRESS' \}\}\n/);
  const order = (name) => yml.indexOf(`      - name: ${name}\n`);
  assert.ok(order("Read due state") < order("Remove abandoned Seoul refresh claims named by the decision"));
  assert.ok(order("Remove abandoned Seoul refresh claims named by the decision") < order("Recover completed claimed refresh"));
  assert.ok(order("Remove abandoned Seoul refresh claims named by the decision") < order("Create durable claim"));
});

// #995 F1: 수집과 게시·등록을 다른 step으로 나눠야 claim 정리가 "게시 step까지 갔는지"로 판정할 수 있다.
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
  const at = (name) => yml.indexOf(`      - name: ${name}\n`);
  assert.ok(at("Create durable claim") < at("Collect current snapshot") && at("Collect current snapshot") < at("Publish and register Seoul accessibility snapshot") && at("Publish and register Seoul accessibility snapshot") < at("Finalize claimed refresh branch"));
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
