import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(root, ".github/workflows/kric-exit-path-source-admission.yml");
const ciPath = path.join(root, ".github/workflows/ci.yml");

function workflow() {
  assert.ok(existsSync(workflowPath), "KRIC EXIT source admission workflow를 찾지 못함");
  return readFileSync(workflowPath, "utf8");
}

test("immutable EXIT admission은 exact provider workflow_run 또는 retained-run A-only dispatch만 소비한다", () => {
  const yml = workflow();
  assert.match(yml, /^on:\n\s+workflow_run:\n\s+workflows: \["KRIC EXIT Path Provider Snapshot"\]\n\s+types: \[completed\]\n\s+branches: \[main\]\n\s+workflow_dispatch:\n\s+inputs:\n\s+providerRunId:\n\s+description: .+\n\s+required: true\n\s+type: string\n\s+expectedProviderHeadSha:\n\s+description: .+\n\s+required: true\n\s+type: string$/m);
  assert.doesNotMatch(yml, /^\s+(?:push|pull_request|schedule|repository_dispatch):/m);
  assert.match(yml, /^permissions:\n\s+actions: read\n\s+contents: read\s*$/m);
  assert.match(yml, /if: \$\{\{ \(github\.event_name == 'workflow_run' && github\.event\.workflow_run\.event == 'workflow_dispatch' && github\.event\.workflow_run\.conclusion == 'success' && github\.event\.workflow_run\.head_branch == 'main' && github\.event\.workflow_run\.head_repository\.full_name == github\.repository\) \|\| \(github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'\) \}\}/);
  assert.match(yml, /ref: \$\{\{ github\.event_name == 'workflow_run' && github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}/);
  assert.match(yml, /persist-credentials:\s*false/);
  assert.match(yml, /timeout-minutes:\s*15/);
  assert.doesNotMatch(yml, /strategy:|matrix:|continue-on-error:/);
});

test("automatic과 A-only runner는 상호배타적이며 GO-guarded artifact identity를 공유한다", () => {
  const yml = workflow();
  assert.equal((yml.match(/run-current-kric-exit-path-source-admission\.mjs/g) ?? []).length, 2);
  assert.match(yml, /if: \$\{\{ github\.event_name == 'workflow_run' \}\}[\s\S]+--event-path "\$\{GITHUB_EVENT_PATH\}"/);
  assert.match(yml, /--event-path "\$\{GITHUB_EVENT_PATH\}"/);
  assert.match(yml, /if: \$\{\{ github\.event_name == 'workflow_dispatch' \}\}[\s\S]+PROVIDER_RUN_ID: \$\{\{ inputs\.providerRunId \}\}[\s\S]+EXPECTED_PROVIDER_HEAD_SHA: \$\{\{ inputs\.expectedProviderHeadSha \}\}[\s\S]+--provider-run-id "\$\{PROVIDER_RUN_ID\}"[\s\S]+--expected-provider-head-sha "\$\{EXPECTED_PROVIDER_HEAD_SHA\}"/);
  assert.match(yml, /PROVIDER_RUN_ID: \$\{\{ inputs\.providerRunId \}\}/);
  assert.match(yml, /EXPECTED_PROVIDER_HEAD_SHA: \$\{\{ inputs\.expectedProviderHeadSha \}\}/);
  assert.match(yml, /--provider-run-id "\$\{PROVIDER_RUN_ID\}"/);
  assert.match(yml, /--expected-provider-head-sha "\$\{EXPECTED_PROVIDER_HEAD_SHA\}"/);
  assert.doesNotMatch(yml, /--provider-run-id "\$\{\{ inputs\./);
  assert.doesNotMatch(yml, /--expected-provider-head-sha "\$\{\{ inputs\./);
  assert.equal((yml.match(/--output-directory "\$\{RUNNER_TEMP\}\/current-kric-exit-path-source-admission"/g) ?? []).length, 2);
  assert.equal((yml.match(/actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/g) ?? []).length, 1);
  assert.match(yml, /if: \$\{\{ success\(\) \}\}/);
  assert.match(yml, /name:\s+kric-exit-path-source-admission-\$\{\{ github\.event_name == 'workflow_run' && github\.event\.workflow_run\.id \|\| inputs\.providerRunId \}\}/);
  assert.match(yml, /path:\s+\$\{\{ runner\.temp \}\}\/current-kric-exit-path-source-admission/);
  assert.match(yml, /if-no-files-found:\s*error/);
  assert.match(yml, /retention-days:\s*14/);
});

test("workflow는 provider secret·retry·fallback·shell integrity authority를 추가하지 않는다", () => {
  const yml = workflow();
  assert.doesNotMatch(yml, /KRIC_SERVICE_KEY|secrets\.|\bcurl\b|\bwget\b|\bjq\b|\bunzip\b|\btar\b|\bfind\b|\bcp\b|\bmv\b|retry|fallback|previous/i);
  assert.equal((yml.match(/\bnode tools\//g) ?? []).length, 2);
  assert.match(readFileSync(ciPath, "utf8"), /tools\/ci\/kric-exit-path-source-admission-workflow\.test\.mjs/);
});
