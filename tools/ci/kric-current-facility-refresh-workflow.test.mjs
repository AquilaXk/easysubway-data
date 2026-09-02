import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(root, ".github/workflows/kric-current-facility-refresh.yml");

test("KRIC refresh workflow has one scheduled, fail-closed, PR-only path", () => {
  assert.ok(existsSync(workflowPath));
  const yml = readFileSync(workflowPath, "utf8");
  assert.match(yml, /cron: "17 \*\/2 \* \* \*"/);
  assert.match(yml, /workflow_dispatch:/);
  assert.match(yml, /cancel-in-progress: false/);
  assert.match(yml, /contents: write/);
  assert.match(yml, /pull-requests: write/);
  assert.match(yml, /actions: read/);
  assert.match(yml, /persist-credentials: false/);
  assert.match(yml, /fetch-depth: 0/);
  assert.match(yml, /node-version: "24\.19\.0"/);
  assert.match(yml, /environment: datapack-release-check/);
  assert.match(yml, /github\.ref == 'refs\/heads\/main'/);
  assert.match(yml, /gh pr list --repo "\$\{GITHUB_REPOSITORY\}" --state all --limit 1000/);
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
  assert.match(yml, /run-current-capital-facility-operation\.mjs --phase prepare --operation-root "\$\{KRIC_REFRESH_OPERATION_ROOT\}" --expected-main-sha "\$\{KRIC_REFRESH_MAIN_SHA\}" --expected-facility-head-sha "\$\{KRIC_REFRESH_MAIN_SHA\}"/);
  assert.match(yml, /run-current-capital-facility-operation\.mjs --phase collect --operation-root "\$\{KRIC_REFRESH_OPERATION_ROOT\}"/);
  assert.match(yml, /run-current-capital-facility-operation\.mjs --phase finalize --operation-root "\$\{KRIC_REFRESH_OPERATION_ROOT\}"/);
  assert.equal((yml.match(/run-current-capital-facility-operation\.mjs --phase (?:prepare|collect|finalize)/g) ?? []).length, 3);
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
    (yml.match(/grep -Eq '\^tools\/datapack\/sources\/\[\^\/\]\+\\\.json\$'/g) ?? []).length,
    2,
  );
  assert.equal(
    (yml.match(/printf '%s\\n' "\$\{changed\}"/g) ?? []).length,
    2,
  );
  assert.equal(
    (yml.match(/printf 'KRIC_REFRESH_BRANCH=%s\\n'/g) ?? []).length,
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
  const yml = readFileSync(workflowPath, "utf8");
  assert.match(yml, /decision\.json/);
  assert.match(yml, /journal\.json/);
  assert.match(yml, /raw-receipt\.json/);
  assert.doesNotMatch(yml, /provider-response|observation|sources\/kric-station-convenience-standard.*\.json/);
  assert.match(yml, /git diff --cached --name-only --diff-filter=ACMR/);
  assert.match(yml, /candidate-build-spec\.json/);
  assert.match(yml, /current-capital-facility-source-admission\.json/);
  assert.match(yml, /source-snapshots\.json/);
  assert.match(yml, /source-inventory\.json/);
});

test("KRIC refresh workflow retains both canonical release identity outputs", () => {
  const yml = readFileSync(workflowPath, "utf8");
  assert.match(yml, /tools\/datapack\/release\/release-request\.json/);
  assert.match(yml, /tools\/datapack\/release\/hash-evidence\.json/);
  assert.match(yml, /gh run download "\$\{source_run_id\}"/);
  assert.match(yml, /--phase recover-published/);
  assert.match(yml, /--phase finalize/);
  assert.match(yml, /git switch --track -c "\$\{branch\}" "origin\/\$\{branch\}"[\s\S]*git merge --no-edit "\$\{main_sha\}"/);
  assert.match(yml, /git commit -m "Refresh KRIC facility snapshot"/);
  assert.match(yml, /git push origin "\$\{branch\}"/);
});
