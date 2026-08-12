import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(root, ".github/workflows/itx-current-collection-continuation.yml");
const ciPath = path.join(root, ".github/workflows/ci.yml");

function workflow() {
  assert.ok(existsSync(workflowPath), "ITX continuation workflow를 찾지 못함");
  return readFileSync(workflowPath, "utf8");
}

function step(source, name) {
  const match = source.match(new RegExp(`- name: ${name}[\\s\\S]*?(?=\\n\\s+- name:|\\n\\s*$)`));
  assert.ok(match, `${name} 스텝을 찾지 못함`);
  return match[0];
}

test("continuation은 exact retained artifact를 쓰는 no-input protected workflow다", () => {
  const yml = workflow();
  assert.match(yml, /^on:\n\s+workflow_dispatch:\s*$/m);
  assert.doesNotMatch(yml, /^\s+(?:push|pull_request|schedule):/m);
  assert.doesNotMatch(yml, /workflow_dispatch:[\s\S]*?inputs:/);
  assert.match(yml, /^permissions:\n\s+actions: read\n\s+contents: read\s*$/m);
  assert.match(yml, /runs-on: macos-15\n\s+environment: itx-current-collection/);
  assert.match(yml, /timeout-minutes:\s*60/);
  assert.match(yml, /cancel-in-progress:\s*false/);
  assert.match(yml, /persist-credentials:\s*false/);
  assert.match(yml, /node-version:\s*["']24\.19\.0["']/);

  const download = step(yml, "ITX continuation / Download retained provider capture");
  assert.match(download, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/);
  assert.match(download, /repository:\s*AquilaXk\/easysubway-data/);
  assert.match(download, /run-id:\s*31609927895/);
  assert.match(download, /name:\s*itx-current-collection-31609927895/);
  assert.match(download, /github-token:\s*\$\{\{ github\.token \}\}/);
});

test("tracked station catalog과 exact base SHA로 continuation CLI를 한 번만 실행한다", () => {
  const yml = workflow();
  const catalog = step(yml, "ITX continuation / Emit station catalog pack");
  assert.match(catalog, /emit-station-catalog-pack\.mjs/);
  assert.match(catalog, /--catalog-pack-id "itx-current-station-catalog-v1"/);

  const run = step(yml, "ITX continuation / Continue current collection");
  assert.match(run, /DATA_GO_KR_SERVICE_KEY:\s*\$\{\{ secrets\.DATA_GO_KR_SERVICE_KEY \}\}/);
  assert.match(run, /must be a nonempty single line/);
  assert.equal((run.match(/continue-current-itx-collection\.mjs/g) ?? []).length, 1);
  assert.match(run, /--capture "\$\{\{ runner\.temp \}\}\/itx-continuation-base\/provider-response-capture\.json"/);
  assert.match(run, /--expected-capture-content-sha256 "9fc8c38fc0f73f56c82359d86d1700b049032de8610b671120266db72390b4e4"/);
  for (const flag of [
    "--station-catalog-pack", "--output", "--completeness-output",
    "--suffix-capture-output", "--continuation-receipt-output",
  ]) assert.match(run, new RegExp(flag));
  assert.doesNotMatch(run, /run-current-itx-collection|replay-current-itx-collection|promote-candidate|previous-admitted/);
});

test("결과·completeness·suffix·receipt만 14일 보존하고 base/raw/secret은 업로드하지 않는다", () => {
  const yml = workflow();
  const upload = step(yml, "ITX continuation / Upload sanitized continuation evidence");
  assert.match(upload, /if:\s*\$\{\{ always\(\) \}\}/);
  assert.match(upload, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/);
  assert.match(upload, /retention-days:\s*14/);
  for (const name of [
    "itx-result.json", "itx-completeness.json",
    "provider-response-suffix-capture.json", "continuation-receipt.json",
  ]) assert.match(upload, new RegExp(name.replaceAll(".", "\\.")));
  assert.doesNotMatch(upload, /itx-continuation-base|station-catalog-pack|DATA_GO_KR_SERVICE_KEY|provider-response-capture\.json/);
  assert.doesNotMatch(yml, /(?:git (?:add|commit|push)|gh |promotion|publish|fallback|alternate provider)/i);
});

test("Data contracts가 continuation workflow contract를 실행한다", () => {
  const ci = readFileSync(ciPath, "utf8");
  assert.match(ci, /tools\/ci\/itx-current-collection-continuation-workflow\.test\.mjs/);
  assert.match(ci, /tools\/datapack\/provider-response-capture\.test\.mjs/);
  assert.match(ci, /tools\/datapack\/continue-current-itx-collection\.test\.mjs/);
});
