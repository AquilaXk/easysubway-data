import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(root, ".github/workflows/kric-exit-path-provider-snapshot.yml");
const ciPath = path.join(root, ".github/workflows/ci.yml");

function workflow() {
  assert.ok(existsSync(workflowPath), "hosted KRIC EXIT full snapshot workflow를 찾지 못함");
  return readFileSync(workflowPath, "utf8");
}

test("hosted full snapshot은 main 전용 no-input read-only single job이다", () => {
  const yml = workflow();
  assert.match(yml, /^on:\n\s+workflow_dispatch:\s*$/m);
  assert.doesNotMatch(yml, /workflow_dispatch:[\s\S]*?inputs:/);
  assert.doesNotMatch(yml, /^\s+(?:push|pull_request|schedule|repository_dispatch):/m);
  assert.match(yml, /^permissions:\n\s+actions: read\n\s+contents: read\s*$/m);
  assert.match(yml, /concurrency:[\s\S]*?cancel-in-progress:\s*false/);
  assert.match(yml, /jobs:\n\s+collect:\n\s+if:\s+\$\{\{ github\.ref == 'refs\/heads\/main' \}\}/);
  assert.match(yml, /runs-on:\s*ubuntu-latest/);
  assert.match(yml, /timeout-minutes:\s*60/);
  assert.match(yml, /persist-credentials:\s*false/);
  assert.match(yml, /node-version:\s*["']24\.19\.0["']/);
  assert.doesNotMatch(yml, /strategy:|matrix:|continue-on-error:/);
});

test("workflow는 current plan 뒤 collector와 immutable bundle builder를 exact once 실행한다", () => {
  const yml = workflow();
  assert.match(yml, /KRIC_SERVICE_KEY:\s*\$\{\{ secrets\.KRIC_SERVICE_KEY \}\}/);
  assert.equal((yml.match(/build-current-kric-exit-collection-plan\.mjs/g) ?? []).length, 1);
  assert.equal((yml.match(/collect-current-kric-exit-path-provider-snapshot\.mjs/g) ?? []).length, 1);
  assert.equal((yml.match(/build-current-kric-exit-collection-receipt\.mjs/g) ?? []).length, 1);
  for (const flag of [
    "--canonical-pack", "--coverage-targets", "--provider-code-catalog", "--route-rosters",
    "--source-inventory", "--incheon-topology", "--coverage-selector", "--output",
  ]) assert.match(yml, new RegExp(flag));
  assert.match(yml, /--coverage-selector capital-seoul-metro-production/);
  assert.match(yml, /--source-id kric-station-movement-standard/);
  assert.match(yml, /--request-timeout-ms 30000/);
  assert.match(yml, /--request-interval-ms 250/);
  assert.match(yml, /--output "\$\{RUNNER_TEMP\}\/current-kric-exit-snapshot\.json"/);
  for (const flag of ["--collection-plan", "--provider-snapshot", "--repository", "--repository-sha", "--workflow-run-id", "--output"]) assert.match(yml, new RegExp(flag));
  assert.match(yml, /--repository "\$\{GITHUB_REPOSITORY\}"/);
  assert.match(yml, /--repository-sha "\$\{GITHUB_SHA\}"/);
  assert.match(yml, /--workflow-run-id "\$\{GITHUB_RUN_ID\}"/);
  assert.match(yml, /--output "\$\{RUNNER_TEMP\}\/current-kric-exit-collection-bundle\.json"/);

  assert.equal((yml.match(/actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/g) ?? []).length, 1);
  assert.match(yml, /name:\s+kric-exit-path-provider-snapshot-\$\{\{ github\.run_id \}\}/);
  assert.match(yml, /path:\s+\$\{\{ runner\.temp \}\}\/current-kric-exit-collection-bundle\.json/);
  assert.match(yml, /if-no-files-found:\s*error/);
  assert.match(yml, /retention-days:\s*14/);
  assert.doesNotMatch(yml, /if:\s*\$\{\{ always\(\) \}\}/);
});

test("workflow와 Data CI는 retry·fallback·untracked network 경계를 추가하지 않는다", () => {
  const yml = workflow();
  assert.doesNotMatch(yml, /download-artifact|curl|wget|jq|source |set -a|retry|fallback|alternate|format xml|\bfind\b|\bwc\b|\bcp\b|\bmv\b|\btar\b/i);
  assert.doesNotMatch(yml, /git (?:add|commit|push)|gh |serviceKey=|echo .*KRIC|printf .*KRIC/i);
  assert.equal((yml.match(/\bnode tools\//g) ?? []).length, 3);

  const ci = readFileSync(ciPath, "utf8");
  assert.match(ci, /tools\/ci\/kric-exit-path-provider-snapshot-workflow\.test\.mjs/);
});
