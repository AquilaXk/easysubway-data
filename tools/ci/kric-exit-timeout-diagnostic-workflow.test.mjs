import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(root, ".github/workflows/kric-exit-timeout-diagnostic.yml");
const ciPath = path.join(root, ".github/workflows/ci.yml");
const ownershipPath = path.join(root, "tools/ci/data-test-ownership.json");
const queryId = "dd25f07bd2351a43024b0aae0cd6a8f6075c565b43606fb84771e0f3ca20868c";

function workflow() {
  assert.ok(existsSync(workflowPath), "KRIC EXIT timeout diagnostic workflow를 찾지 못함");
  return readFileSync(workflowPath, "utf8");
}

test("hosted diagnostic은 no-input manual read-only single job이다", () => {
  const yml = workflow();
  assert.match(yml, /^on:\n\s+workflow_dispatch:\s*$/m);
  assert.doesNotMatch(yml, /workflow_dispatch:[\s\S]*?inputs:/);
  assert.doesNotMatch(yml, /^\s+(?:push|pull_request|schedule|repository_dispatch):/m);
  assert.match(yml, /^permissions:\n\s+contents: read\s*$/m);
  assert.match(yml, /concurrency:[\s\S]*?cancel-in-progress:\s*false/);
  assert.match(yml, /runs-on:\s*ubuntu-latest/);
  assert.match(yml, /timeout-minutes:\s*5/);
  assert.match(yml, /persist-credentials:\s*false/);
  assert.match(yml, /node-version:\s*["']24\.19\.0["']/);
  assert.doesNotMatch(yml, /strategy:|matrix:/);
});

test("workflow는 tracked plan과 fixed correlated diagnostic만 secret env로 실행한다", () => {
  const yml = workflow();
  assert.match(yml, /KRIC_SERVICE_KEY:\s*\$\{\{ secrets\.KRIC_SERVICE_KEY \}\}/);
  assert.equal((yml.match(/build-current-kric-exit-collection-plan\.mjs/g) ?? []).length, 1);
  assert.equal((yml.match(/diagnose-current-kric-exit-path-query\.mjs/g) ?? []).length, 1);
  for (const flag of [
    "--canonical-pack", "--coverage-targets", "--provider-code-catalog", "--route-rosters",
    "--source-inventory", "--incheon-topology", "--output",
  ]) assert.match(yml, new RegExp(flag));
  assert.match(yml, new RegExp(`--query-id ${queryId}`));
  assert.match(yml, /--source-id kric-station-movement-standard/);
  assert.match(yml, /--request-timeout-ms 30000/);
  assert.doesNotMatch(yml, /collect-current-kric-exit-path-provider-snapshot|request-interval|retry|continue-on-error/i);
});

test("workflow는 raw/artifact/fallback과 untracked network tooling을 사용하지 않는다", () => {
  const yml = workflow();
  assert.doesNotMatch(yml, /upload-artifact|download-artifact|artifact|curl|wget|jq|source |set -a|fallback|alternate|format xml/i);
  assert.doesNotMatch(yml, /git (?:add|commit|push)|gh |serviceKey=|echo .*KRIC|printf .*KRIC/i);
  assert.equal((yml.match(/\bnode tools\//g) ?? []).length, 2);
});

test("Data CI는 hosted diagnostic workflow contract를 owned required runner에서 실행한다", () => {
  const ci = readFileSync(ciPath, "utf8");
  const ownership = JSON.parse(readFileSync(ownershipPath, "utf8"));
  const entries = ownership.tests.filter(
    ({ path: testPath }) => testPath === "tools/ci/kric-exit-timeout-diagnostic-workflow.test.mjs",
  );
  assert.match(ci, /node tools\/ci\/data-test-discovery\.mjs run --class required-pr/);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].semanticOwner, "data26");
  assert.ok(entries[0].classes.includes("required-pr"));
});
