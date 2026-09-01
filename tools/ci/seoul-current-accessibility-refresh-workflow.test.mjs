import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."); const workflowPath = path.join(root, ".github/workflows/seoul-current-accessibility-refresh.yml");
test("Seoul refresh workflow is due-only, main-only, single-attempt, OCI registration with one draft PR", () => { assert.ok(existsSync(workflowPath)); const yml = readFileSync(workflowPath, "utf8"); assert.match(yml, /cron: "31 \*\/2 \* \* \*"/); assert.match(yml, /github\.ref == 'refs\/heads\/main'/); assert.match(yml, /cancel-in-progress: false/); assert.match(yml, /mkdir -p "\$\{RUNNER_TEMP\}\/seoul-current-accessibility-refresh\/\$\{GITHUB_RUN_ID\}"/); assert.match(yml, /decide-current-seoul-accessibility-refresh\.mjs/); assert.match(yml, /RECOVER_CLAIM/); assert.match(yml, /automation\/639-seoul-accessibility-refresh-\$\{GITHUB_RUN_ID\}/); assert.match(yml, /run-current-seoul-accessibility-registration\.mjs[^\n]+--request-attempts 1/); assert.match(yml, /git config user\.name "github-actions\[bot\]"[\s\S]*git config user\.email "41898282\+github-actions\[bot\]@users\.noreply\.github\.com"[\s\S]*git commit --allow-empty -m "Claim Seoul accessibility refresh"/); assert.match(yml, /Finalize claimed refresh branch[\s\S]*GH_TOKEN: \$\{\{ github\.token \}\}[\s\S]*git add -A[\s\S]*git diff --cached --name-only --diff-filter=ACMR[\s\S]*git push origin "\$\{SEOUL_REFRESH_BRANCH\}"/); assert.match(yml, /git rev-list --count HEAD\.\."origin\/\$\{branch\}"/); assert.match(yml, /--draft/); assert.match(yml, /Refresh Seoul accessibility snapshot/); assert.match(yml, /source-inventory\.json/); assert.match(yml, /source-snapshots\.json/); assert.match(yml, /capital-pilot-production-source-input\.json/); assert.match(yml, /candidate-build-spec\.json/); assert.match(yml, /release-request\.json/); assert.match(yml, /hash-evidence\.json/); assert.doesNotMatch(yml, /aws|s3:|fallback|retry|automerge|git push origin main|gh workflow run/i); });

test("pending full fan-in cannot reach a Seoul refresh side effect", () => {
  const yml = readFileSync(workflowPath, "utf8");
  for (const name of [
    "Recover completed claimed refresh",
    "Create durable claim",
    "Validate provider configuration",
    "Collect and bind current snapshot",
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
