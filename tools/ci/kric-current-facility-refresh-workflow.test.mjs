import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { evaluateGithubExpression } from "./github-expression.mjs";
import { ifCondition, loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FILE = "kric-current-facility-refresh.yml";
const workflowPath = path.join(root, ".github/workflows", FILE);
const { yml, workflow, job, step } = loadWorkflow(root, FILE);

function kricStep(shortName) {
  return step(`KRIC current facility refresh / ${shortName}`);
}

function kricStepIndex(shortName) {
  return job.steps.findIndex(({ name }) => name === `KRIC current facility refresh / ${shortName}`);
}

function evaluateCollectCondition(condition, state) {
  return evaluateGithubExpression(condition, {
    steps: { decision: { outputs: { state, source_id: "kric-station-escalator-detailed" } } },
  });
}

test("KRIC refresh workflow has one scheduled, fail-closed, direct-to-main solo path", () => {
  assert.ok(existsSync(workflowPath));
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.on, {
    schedule: [{ cron: "17 */2 * * *" }],
    workflow_dispatch: {},
  });
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.deepEqual(job.permissions, {
    actions: "read",
    contents: "write",
  });
  assert.deepEqual(kricStep("Checkout repository").with, {
    "fetch-depth": "0",
    "persist-credentials": "false",
  });
  assert.deepEqual(kricStep("Set up Node.js").with, {
    "node-version": "24.19.0",
  });
  assert.equal(job.environment, "datapack-release-check");
  assert.equal(job.if, "${{ github.ref == 'refs/heads/main' }}");
  assert.match(yml, /decide-current-kric-facility-refresh\.mjs/);
  assert.match(yml, /steps\.decision\.outputs\.state == 'DUE'/);
  assert.match(yml, /steps\.decision\.outputs\.state == 'EXPIRED'/);
  assert.match(yml, /run-current-capital-facility-operation\.mjs --phase prepare --source-id "\$\{KRIC_REFRESH_SOURCE_ID\}" --operation-root "\$\{KRIC_REFRESH_OPERATION_ROOT\}" --expected-main-sha "\$\{KRIC_REFRESH_MAIN_SHA\}" --expected-facility-head-sha "\$\{KRIC_REFRESH_MAIN_SHA\}"/);
  assert.match(yml, /run-current-capital-facility-operation\.mjs --phase collect --operation-root "\$\{KRIC_REFRESH_OPERATION_ROOT\}"/);
  assert.match(yml, /run-current-capital-facility-operation\.mjs --phase finalize --operation-root "\$\{KRIC_REFRESH_OPERATION_ROOT\}"/);
  assert.equal([...yml.matchAll(/run-current-capital-facility-operation\.mjs --phase (?:prepare|collect|finalize)/gu)].length, 3);
  assert.match(yml, /KRIC_SERVICE_KEY.*nonempty single line/);
  assert.match(yml, /EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL.*nonempty single line/);
  assert.match(yml, /git diff --cached --name-only --diff-filter=D[\s\S]*KRIC refresh removed a tracked input/);
  assert.match(yml, /git commit -m "Refresh KRIC facility snapshot"[\s\S]*refresh-automation-pr\.mjs body --stage kric-facility-refresh[\s\S]*git push origin HEAD:main/);
  assert.doesNotMatch(yml, /aws|s3:|retry|automerge|pull-requests:\s*write|issues:\s*write|create-github-app-token|gh pr create|gh pr list|gh issue list|automation\/|gh workflow run|git add -A|git add \./i);
});

test("KRIC refresh workflow only uploads sanitized decision and operation evidence", () => {
  assert.match(yml, /decision\.json/);
  assert.match(yml, /journal\.json/);
  assert.match(yml, /raw-receipt\.json/);
  assert.doesNotMatch(yml, /provider-response|observation|sources\/kric-station-convenience-standard.*\.json/);
  assert.match(yml, /git diff --cached --name-only --diff-filter=ACMR/);
  assert.match(yml, /source-snapshots\.json/);
  assert.match(yml, /source-inventory\.json/);
});

test("KRIC refresh workflow ends at ledger registration and never commits candidate-side outputs (#862 결정 C)", () => {
  for (const candidateSide of [
    "candidate-build-spec.json",
    "release-request.json",
    "hash-evidence.json",
  ]) {
    assert.equal(yml.includes(candidateSide), false, `${candidateSide} belongs to the nationwide candidate refresh`);
  }
  assert.match(yml, /tools\/datapack\/\(release\/source-snapshots\\\.json\|source-inventory\\\.json\|sources\/\[\^\/\]\+\\\.json\)/u);
});

test("KRIC refresh workflow separates collect from publish-and-register with CAS main checks", () => {
  const collect = kricStep("Collect current snapshot");
  const publish = kricStep("Publish and register current snapshot");
  const commit = kricStep("Commit and push KRIC facility refresh");
  assert.ok(collect.run.includes("--phase prepare"));
  assert.ok(collect.run.includes("--phase collect"));
  assert.doesNotMatch(collect.run, /--phase finalize/);
  assert.ok(publish.run.includes('git ls-remote origin refs/heads/main'));
  assert.ok(publish.run.includes('--phase finalize --operation-root "${KRIC_REFRESH_OPERATION_ROOT}"'));
  assert.ok(publish.run.includes('cp "${KRIC_REFRESH_OPERATION_ROOT}/receipt.json" "${KRIC_REFRESH_OPERATION_ROOT}/raw-receipt.json"'));
  assert.equal(publish.env.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL, "${{ secrets.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL }}");
  assert.ok(commit.run.includes('git fetch --no-tags origin main'));
  assert.ok(commit.run.includes('git push origin HEAD:main'));
  assert.ok(
    kricStepIndex("Read due state") < kricStepIndex("Collect current snapshot") &&
      kricStepIndex("Collect current snapshot") < kricStepIndex("Publish and register current snapshot") &&
      kricStepIndex("Publish and register current snapshot") < kricStepIndex("Commit and push KRIC facility refresh"),
  );
  assert.equal(yml.includes("Collect and bind current snapshot"), false);
});

test("KRIC refresh workflow always uploads decision.json and journal.json (and raw-receipt.json when it exists)", () => {
  const upload = kricStep("Upload sanitized evidence");
  assert.equal(ifCondition(upload), "${{ always() }}");
  assert.ok(upload.with.path.includes("decision.json"));
  assert.ok(upload.with.path.includes("journal.json"));
  assert.ok(upload.with.path.includes("raw-receipt.json"));
  assert.equal(upload.with["if-no-files-found"], "ignore");
  assert.equal(yml.includes("Detect retained publication receipt"), false);
});

const PHASES = ["DUE", "EXPIRED", "NOT_DUE"];
test("#3036 KRIC refresh collect step runs only for DUE or EXPIRED and passes the decided source id through env", () => {
  const collect = kricStep("Collect current snapshot");
  assert.deepEqual(
    PHASES.map((state) => [state, Boolean(evaluateCollectCondition(ifCondition(collect), state))]),
    PHASES.map((state) => [state, state === "DUE" || state === "EXPIRED"]),
  );
  assert.equal(collect.env.KRIC_REFRESH_SOURCE_ID, "${{ steps.decision.outputs.source_id }}");
  assert.doesNotMatch(collect.run, /\$\{\{/u);
  assert.equal([...collect.run.matchAll(/--source-id "\$\{KRIC_REFRESH_SOURCE_ID\}"/gu)].length, 1);
  assert.ok(collect.run.indexOf("--source-id") < collect.run.indexOf("--phase collect"));
});

test("KRIC refresh failure summary runs last with decision source_id", () => {
  const report = kricStep("Report refresh failure summary");
  assert.equal(ifCondition(report), "${{ failure() }}");
  assert.equal(report.env.DECISION_SOURCE_ID, "${{ steps.decision.outputs.source_id }}");
  assert.doesNotMatch(report.run, /\$\{\{/u);
  assert.ok(report.run.includes('--workflow kric-current-facility-refresh.yml --repository "${GITHUB_REPOSITORY}" --run-id "${GITHUB_RUN_ID}" --source-id "${DECISION_SOURCE_ID:-}"'));
  assert.equal(job.steps.at(-1)?.name, report.name);
});
