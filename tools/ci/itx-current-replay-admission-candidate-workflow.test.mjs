import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(root, ".github/workflows/itx-current-replay-admission-candidate.yml");
const ciPath = path.join(root, ".github/workflows/ci.yml");
const ownershipPath = path.join(root, "tools/ci/data-test-ownership.json");

function workflow() {
  assert.ok(existsSync(workflowPath), "ITX replay admission candidate workflow를 찾지 못함");
  return readFileSync(workflowPath, "utf8");
}

function step(source, name) {
  const match = source.match(new RegExp(`- name: ${name}[\\s\\S]*?(?=\\n\\s+- name:|\\n\\s*$)`));
  assert.ok(match, `${name} 스텝을 찾지 못함`);
  return match[0];
}

test("candidate workflow는 continuation_run_id와 replay_run_id 입력을 검증하고 해당 capture/replay artifact를 다운로드한다", () => {
  const yml = workflow();
  assert.match(yml, /^on:\n\s+workflow_dispatch:\n\s+inputs:\n\s+continuation_run_id:\n\s+description:[^\n]+\n\s+required:\s*true\n\s+type:\s*string\n\s+replay_run_id:\n\s+description:[^\n]+\n\s+required:\s*true\n\s+type:\s*string/m);
  assert.doesNotMatch(yml, /^\s+(?:push|pull_request|schedule):/m);
  assert.match(yml, /^permissions:\n\s+actions: read\n\s+contents: read\s*$/m);
  assert.match(yml, /candidate:\n\s+if: \$\{\{ github\.ref == 'refs\/heads\/main' \}\}/);
  assert.match(yml, /runs-on: macos-15/);
  assert.match(yml, /node-version:\s*["']24\.19\.0["']/);
  assert.match(yml, /persist-credentials:\s*false/);
  assert.doesNotMatch(yml, /(?:^\s*env:|environment:|secrets\.|DATA_GO_KR_SERVICE_KEY)/m);

  const actionRefs = [...yml.matchAll(/^\s+uses:\s*([^\s]+)\s*$/gm)].map((match) => match[1]);
  assert.ok(actionRefs.length > 0);
  for (const actionRef of actionRefs) assert.match(actionRef, /@[0-9a-f]{40}$/);

  const validate = step(yml, "ITX replay admission / Validate inputs");
  assert.match(validate, /inputs\.continuation_run_id/);
  assert.match(validate, /inputs\.replay_run_id/);
  assert.match(validate, /\^\[1-9\]\[0-9\]\*\$/);

  const capture = step(yml, "ITX replay admission / Download retained extended capture");
  assert.match(capture, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/);
  assert.match(capture, /repository:\s*AquilaXk\/easysubway-data/);
  assert.match(capture, /run-id:\s*\$\{\{\s*inputs\.continuation_run_id\s*\}\}/);
  assert.match(capture, /name:\s*itx-current-collection-continuation-\$\{\{\s*inputs\.continuation_run_id\s*\}\}/);
  assert.match(capture, /github-token:\s*\$\{\{ github\.token \}\}/);
  assert.doesNotMatch(capture, /31620004435/);

  const replay = step(yml, "ITX replay admission / Download successful replay evidence");
  assert.match(replay, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/);
  assert.match(replay, /repository:\s*AquilaXk\/easysubway-data/);
  assert.match(replay, /run-id:\s*\$\{\{\s*inputs\.replay_run_id\s*\}\}/);
  assert.match(replay, /name:\s*itx-current-collection-offline-replay-\$\{\{\s*inputs\.replay_run_id\s*\}\}/);
  assert.match(replay, /github-token:\s*\$\{\{ github\.token \}\}/);
  assert.doesNotMatch(replay, /31679427374/);
});

test("candidate CLI는 exact input과 two-output만 사용하고 provider/promotion을 호출하지 않는다", () => {
  const yml = workflow();
  const run = step(yml, "ITX replay admission / Materialize admission candidate");
  assert.equal((run.match(/materialize-replayed-itx-admission-candidate\.mjs/g) ?? []).length, 1);
  assert.match(run, /--capture .*provider-response-extended-capture\.json/);
  assert.match(run, /--replay-evidence .*itx-replay\.json/);
  assert.match(run, /--candidate-output .*candidate\.json/);
  assert.match(run, /--completeness-output .*completeness\.json/);
  assert.match(run, /--station-catalog-pack .*station-catalog-pack/);
  assert.doesNotMatch(yml, /DATA_GO_KR_SERVICE_KEY|continue-current|run-current|promote-candidate|approval-url|publish/);

  const upload = step(yml, "ITX replay admission / Upload candidate evidence");
  assert.match(upload, /candidate\.json/);
  assert.match(upload, /completeness\.json/);
  assert.match(upload, /if-no-files-found:\s*error/);
  assert.match(upload, /retention-days:\s*14/);
  assert.doesNotMatch(upload, /provider-response|station-catalog-pack|itx-replay\.json/);
});

test("Data contracts가 candidate functional/static contract만 정확히 등록한다", () => {
  const ci = readFileSync(ciPath, "utf8");
  assert.match(ci, /node tools\/ci\/data-test-discovery\.mjs run --class required-pr/);
  const ownership = JSON.parse(readFileSync(ownershipPath, "utf8"));
  for (const ownedPath of [
    "tools/ci/itx-current-replay-admission-candidate-workflow.test.mjs",
    "tools/datapack/materialize-replayed-itx-admission-candidate.test.mjs",
  ]) {
    const entries = ownership.tests.filter(({ path: testPath }) => testPath === ownedPath);
    assert.equal(entries.length, 1, `${ownedPath} ownership entry는 정확히 하나여야 함`);
    assert.equal(entries[0].semanticOwner, "data96");
    assert.ok(entries[0].classes.includes("required-pr"));
  }
});
