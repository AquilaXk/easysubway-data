import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { evaluateGithubExpression } from "./github-expression.mjs";
import { ifCondition, loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FILE = "kric-current-facility-refresh.yml";
const workflowPath = path.join(root, ".github/workflows", FILE);
const { yml, workflow, job, steps, step } = loadWorkflow(root, FILE);

function kricStep(shortName) {
  return step(`KRIC current facility refresh / ${shortName}`);
}

function kricStepIndex(shortName) {
  return steps().findIndex(({ name }) => name === `KRIC current facility refresh / ${shortName}`);
}

function evaluateCollectCondition(condition, state) {
  return evaluateGithubExpression(condition, {
    steps: { decision: { outputs: { state, source_id: "kric-station-escalator-detailed" } } },
  });
}

function runRecoveredSourceScript(script, journalPath) {
  return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    env: { ...process.env, SOURCE_JOURNAL: journalPath },
    encoding: "utf8",
  });
}

test("KRIC refresh workflow has one scheduled, fail-closed, PR-only path", () => {
  assert.ok(existsSync(workflowPath));
  assert.deepEqual(workflow.on, {
    schedule: [{ cron: "17 */2 * * *" }],
    workflow_dispatch: {},
  });
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.deepEqual(job.permissions, {
    actions: "read",
    contents: "write",
    "pull-requests": "write",
    issues: "write",
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
  // #993: PR 이력 전체(--state all --limit 1000)를 받지 않는다. 열린 PR 전체와 claim 브랜치별 PR만 수집기로 받는다.
  assert.match(yml, /node tools\/ci\/collect-automation-prs\.mjs --repository "\$\{GITHUB_REPOSITORY\}" --refs "[^"]+" --pr-limit 1000 --output "[^"]+"/u);
  assert.doesNotMatch(yml, /gh pr list[^\n]*--state all --limit/u);
  assert.match(yml, /headRefName,baseRefName,headRepository,isCrossRepository/);
  assert.match(yml, /git ls-remote --heads origin/);
  assert.match(yml, /decide-current-kric-facility-refresh\.mjs/);
  assert.match(yml, /--claims "\$\{claims\}"/);
  assert.match(yml, /--repository "\$\{GITHUB_REPOSITORY\}"/);
  assert.match(yml, /RECOVER_CLAIM/);
  assert.doesNotMatch(yml, /RETIRE_CLOSED_CLAIM|claim_sha|Retire closed durable claim/);
  assert.doesNotMatch(yml, /automation\/629-kric-facility-refresh-33374059575/);
  assert.doesNotMatch(yml, /4a75f913e06c7eded7112ef06017f95689626dff/);
  assert.doesNotMatch(yml, /git push origin --delete/);
  assert.match(yml, /steps\.decision\.outputs\.state == 'DUE'/);
  assert.match(yml, /steps\.decision\.outputs\.state == 'EXPIRED'/);
  assert.match(yml, /run-current-capital-facility-operation\.mjs --phase prepare --source-id "\$\{KRIC_REFRESH_SOURCE_ID\}" --operation-root "\$\{KRIC_REFRESH_OPERATION_ROOT\}" --expected-main-sha "\$\{KRIC_REFRESH_MAIN_SHA\}" --expected-facility-head-sha "\$\{KRIC_REFRESH_MAIN_SHA\}"/);
  assert.match(yml, /run-current-capital-facility-operation\.mjs --phase collect --operation-root "\$\{KRIC_REFRESH_OPERATION_ROOT\}"/);
  assert.match(yml, /run-current-capital-facility-operation\.mjs --phase finalize --operation-root "\$\{KRIC_REFRESH_OPERATION_ROOT\}"/);
  assert.equal([...yml.matchAll(/run-current-capital-facility-operation\.mjs --phase (?:prepare|collect|finalize)/gu)].length, 3);
  assert.match(yml, /KRIC_SERVICE_KEY.*nonempty single line/);
  assert.match(yml, /EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL.*nonempty single line/);
  assert.match(yml, /automation\/629-kric-facility-refresh-\$\{GITHUB_RUN_ID\}/);
  assert.match(
    yml,
    /main_sha="\$\(git rev-parse HEAD\)"[\s\S]*git config user\.name "github-actions\[bot\]"[\s\S]*git config user\.email "41898282\+github-actions\[bot\]@users\.noreply\.github\.com"[\s\S]*git commit --allow-empty -m "Claim KRIC facility refresh"[\s\S]*git push origin "\$\{branch\}"[\s\S]*git switch --detach "\$\{main_sha\}"[\s\S]*KRIC_REFRESH_MAIN_SHA/,
  );
  assert.match(yml, /\[\[ "\$\(git rev-parse HEAD\)" == "\$\{KRIC_REFRESH_MAIN_SHA\}" \]\][\s\S]*run-current-capital-facility-operation\.mjs --phase prepare/);
  assert.match(yml, /git switch "\$\{KRIC_REFRESH_BRANCH\}"[\s\S]*\[\[ "\$\(git rev-parse HEAD\^\)" == "\$\{KRIC_REFRESH_MAIN_SHA\}" \]\][\s\S]*git add -A[\s\S]*deleted="\$\(git diff --cached --name-only --diff-filter=D\)"[\s\S]*changed="\$\(git diff --cached --name-only --diff-filter=ACMR\)"/);
  assert.match(yml, /subject="\$\(git log -1 --format=%s "origin\/\$\{branch\}"\)"/);
  assert.match(yml, /validate_terminal_claim_topology/);
  assert.match(yml, /git rev-list --parents -n 1 "\$\{output_parent\}"/);
  assert.match(yml, /git rev-parse "\$\{output_parent\}\^1"/);
  assert.match(yml, /git rev-parse "\$\{output_parent\}\^2"/);
  assert.match(yml, /git merge-base --is-ancestor "\$\{merged_main_sha\}" HEAD/);
  assert.match(yml, /Claim KRIC facility refresh/);
  assert.match(yml, /changed_outputs/);
  assert.match(yml, /git ls-files --others --exclude-standard/);
  assert.match(yml, /git diff --name-only --diff-filter=ACMR "origin\/\$\{branch\}\^" "origin\/\$\{branch\}"/);
  assert.equal(
    [...yml.matchAll(/grep -Eq '\^tools\/datapack\/sources\/\[\^\/\]\+\\\.json\$'/gu)].length,
    2,
  );
  assert.equal(
    [...yml.matchAll(/printf '%s\\n' "\$\{changed\}"/gu)].length,
    2,
  );
  assert.equal(
    [...yml.matchAll(/printf 'KRIC_REFRESH_BRANCH=%s\\n'/gu)].length,
    1,
  );
  assert.doesNotMatch(yml, /\\\\\.json|%s\\\\n/);
  assert.match(yml, /git diff --cached --name-only --diff-filter=D[\s\S]*KRIC refresh removed a tracked input/);
  assert.match(yml, /gh pr list --repo "\$\{GITHUB_REPOSITORY\}" --state all --base main --head "\$\{branch\}"/);
  assert.match(yml, /--draft/);
  assert.match(yml, /git commit -m "Refresh KRIC facility snapshot"[\s\S]*git push origin "\$\{KRIC_REFRESH_BRANCH\}"[\s\S]*gh pr create/);
  assert.match(yml, /Refs #629, #39, #29/);
  assert.doesNotMatch(yml, /aws|s3:|retry|automerge|git push origin main|gh workflow run/i);
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
  assert.equal(
    [...yml.matchAll(/'tools\/datapack\/\(release\/source-snapshots\\\.json\|source-inventory\\\.json\|sources\/\[\^\/\]\+\\\.json\)'/gu)].length,
    2,
  );
});

test("KRIC refresh workflow recovers a published claim through the same registration-only output set", () => {
  assert.match(yml, /gh run download "\$\{source_run_id\}"/);
  assert.match(yml, /--phase recover-published/);
  assert.match(yml, /--phase finalize/);
  assert.match(yml, /git switch --track -c "\$\{branch\}" "origin\/\$\{branch\}"[\s\S]*git merge --no-edit "\$\{main_sha\}"/);
  assert.match(yml, /git commit -m "Refresh KRIC facility snapshot"/);
  assert.match(yml, /git push origin "\$\{branch\}"/);
});

// #995: claim head subject를 git으로 읽어 넘기던 방식은 claim 판정 증거(claim 뒤 커밋 제목)가 대신한다.
test("KRIC refresh workflow classifies PR-less claims from run and publication evidence before any recovery or claim", () => {
  const decision = kricStep("Read due state");
  assert.doesNotMatch(decision.run, /git fetch|git log -1|claim_subject|while IFS=/);
  const collect = decision.run.indexOf("node tools/ci/collect-automation-prs.mjs");
  const evidence = decision.run.indexOf('node tools/ci/claim-orphans.mjs --workflow kric-current-facility-refresh.yml --repository "${GITHUB_REPOSITORY}" --refs "${claims}" --prs "${prs}" --output "${claim_evidence}"');
  assert.ok(collect !== -1 && evidence > collect);
  assert.ok(decision.run.indexOf("decide-current-kric-facility-refresh.mjs") > evidence);
  assert.match(decision.run, /--claims "\$\{claims\}" \\\n\s+--claim-evidence "\$\{claim_evidence\}"/);
  assert.doesNotMatch(decision.run, /gh run list/);
  assert.equal(job.permissions.actions, "read");
  const cleanup = kricStep("Remove abandoned claims named by the decision");
  assert.equal(ifCondition(cleanup), "${{ steps.decision.outputs.cleanup_claims != '' }}");
  assert.equal(cleanup.env.CLEANUP_CLAIMS, "${{ steps.decision.outputs.cleanup_claims }}");
  assert.doesNotMatch(cleanup.run, /\$\{\{/);
  assert.match(cleanup.run, /gh auth setup-git\n[\s\S]*node tools\/ci\/remove-orphan-claims\.mjs --workflow kric-current-facility-refresh\.yml --repository "\$\{GITHUB_REPOSITORY\}" --claims "\$\{CLEANUP_CLAIMS\}" --refs "\$\{RUNNER_TEMP\}\/kric-current-facility-refresh\/claims\.txt"/);
  const running = kricStep("Note refresh waiting on a running producer");
  assert.equal(ifCondition(running), "${{ steps.decision.outputs.state == 'CLAIM_IN_PROGRESS' }}");
  assert.ok(kricStepIndex("Read due state") < kricStepIndex("Remove abandoned claims named by the decision"));
  assert.ok(kricStepIndex("Remove abandoned claims named by the decision") < kricStepIndex("Recover claimed refresh"));
  assert.ok(kricStepIndex("Remove abandoned claims named by the decision") < kricStepIndex("Create durable claim"));
});

// #995 F1: finalize phase가 raw object를 OCI에 게시하고 등록한다. 그 phase를 별도 step으로 둬야 claim 정리가 "게시 step까지 갔는지"로 판정할 수 있다.
test("KRIC refresh workflow runs prepare and collect before a separate publish-and-register step", () => {
  const collect = kricStep("Collect current snapshot");
  const publish = kricStep("Publish and register current snapshot");
  assert.ok(collect.run.includes("--phase prepare"));
  assert.ok(collect.run.includes("--phase collect"));
  assert.doesNotMatch(collect.run, /--phase finalize/);
  assert.ok(publish.run.includes('--phase finalize --operation-root "${KRIC_REFRESH_OPERATION_ROOT}"'));
  assert.ok(publish.run.includes('cp "${KRIC_REFRESH_OPERATION_ROOT}/receipt.json" "${KRIC_REFRESH_OPERATION_ROOT}/raw-receipt.json"'));
  assert.equal(publish.env.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL, "${{ secrets.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL }}");
  assert.ok(
    kricStepIndex("Create durable claim") < kricStepIndex("Collect current snapshot") &&
      kricStepIndex("Collect current snapshot") < kricStepIndex("Publish and register current snapshot") &&
      kricStepIndex("Publish and register current snapshot") < kricStepIndex("Finalize claimed refresh branch"),
  );
  assert.equal(yml.includes("Collect and bind current snapshot"), false);
});

// 게시된 뒤 등록 전에 실패한 run을 사람이 설명하려면 journal(단계 기록)과 decision이 항상 남아 있어야 한다.
test("KRIC refresh workflow always uploads decision.json and journal.json (and raw-receipt.json when it exists)", () => {
  const upload = kricStep("Upload sanitized evidence");
  assert.equal(ifCondition(upload), "${{ always() }}");
  assert.ok(upload.with.path.includes("decision.json"));
  assert.ok(upload.with.path.includes("journal.json"));
  assert.ok(upload.with.path.includes("raw-receipt.json"));
  assert.equal(upload.with["if-no-files-found"], "ignore");
  assert.equal(yml.includes("Detect retained publication receipt"), false);
});

// #995 F4: 판정이 보존 artifact가 없거나 만료된 claim을 복구 대상에서 빼므로, recover step의 Abandon 경로는 경합 구간에서만 닿는다.
test("KRIC recover step documents when the Abandon path can still run", () => {
  const recover = kricStep("Recover claimed refresh");
  assert.match(recover.run, /# #995: 이 Abandon 경로는 판정이 보존 artifact를 AVAILABLE로 본 뒤 이 step까지 사이에 artifact가 만료·삭제된 경우에만 닿는다/);
  assert.match(recover.run, /Abandon 커밋이 남은 claim은 다음 판정이 정리 대상으로 보고하고 지운다/);
});

// #3036: run 하나는 판정이 고른 원천 하나를 갱신한다. 수집 step은 판정의 source_id를 env로 받아 prepare에 넘기고, 복구 step은 보존한 journal의 원천을 넘긴다.
const PHASES = ["DUE", "EXPIRED", "NOT_DUE", "OPEN_PR", "RECOVER_CLAIM", "CLAIM_IN_PROGRESS"];
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

test("#3036 KRIC refresh recovery prepares the target for the source recorded in the retained journal", () => {
  const recover = kricStep("Recover claimed refresh");
  const read = /source_id="\$\(SOURCE_JOURNAL="\$\{source_root\}\/journal\.json" node --input-type=module -e '\n([\s\S]*?)\n\s*'\)"/u.exec(recover.run);
  assert.ok(read, "the recovery step reads the source id from the retained journal");
  assert.ok(recover.run.indexOf(read[0]) < recover.run.indexOf('--phase prepare --source-id "${source_id}" --operation-root "${target_root}"'));
  const directory = mkdtempSync(path.join(tmpdir(), "kric-recover-source-"));
  try {
    const journal = path.join(directory, "journal.json");
    writeFileSync(journal, JSON.stringify({ phase: "FINALIZE_STARTED", sourceId: "kric-station-escalator-detailed" }));
    assert.equal(runRecoveredSourceScript(read[1], journal), "kric-station-escalator-detailed");
    writeFileSync(journal, JSON.stringify({ phase: "FINALIZE_STARTED" }));
    assert.equal(runRecoveredSourceScript(read[1], journal), "kric-station-convenience-standard", "a journal from before #3036 has no source id and could only be the standard source");
    for (const sourceId of ["kric-station-escalator", "", null]) {
      writeFileSync(journal, JSON.stringify({ phase: "FINALIZE_STARTED", sourceId }));
      assert.equal(runRecoveredSourceScript(read[1], journal), sourceId ?? "null", `a present source id is passed on as written for prepare to judge: ${JSON.stringify(sourceId)}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// #3036 선택 원천의 재시도 쿨다운: 판정은 열린 실패 이슈의 원천 실패 시각 표지를 읽는다(source-reverification의 표지 판정과 같은 경로).
test("#3036 KRIC refresh decision reads the open failure issues the way source reverification does", () => {
  const decision = kricStep("Read due state");
  assert.ok(decision.run.includes('issues="${RUNNER_TEMP}/kric-current-facility-refresh/open-issues.json"'));
  assert.ok(decision.run.includes('gh issue list --repo "${GITHUB_REPOSITORY}" --state open --limit 1000 --json number,title,body,author > "${issues}"'));
  assert.match(decision.run, /--claim-evidence "\$\{claim_evidence\}" \\\n\s+--issues "\$\{issues\}" \\\n/u);
  assert.ok(decision.run.indexOf("gh issue list") < decision.run.indexOf("decide-current-kric-facility-refresh.mjs"));
});

test("#3036 KRIC refresh failure report names the failed source from the decision or the recovered journal", () => {
  const report = kricStep("Report refresh failure as an issue");
  assert.equal(report.env.DECISION_SOURCE_ID, "${{ steps.decision.outputs.source_id }}");
  assert.doesNotMatch(report.run, /\$\{\{/u);
  assert.ok(report.run.includes('failed_source_id="${DECISION_SOURCE_ID:-${KRIC_REFRESH_RECOVERED_SOURCE_ID:-}}"'));
  assert.ok(report.run.includes('--run-id "${GITHUB_RUN_ID}" --source-id "${failed_source_id}"'));
  const recover = kricStep("Recover claimed refresh");
  assert.ok(recover.run.includes('printf \'KRIC_REFRESH_RECOVERED_SOURCE_ID=%s\\n\' "${source_id}" >> "${GITHUB_ENV}"'));
});
