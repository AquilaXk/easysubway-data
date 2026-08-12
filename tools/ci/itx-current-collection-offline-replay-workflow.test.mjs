import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(root, ".github/workflows/itx-current-collection-offline-replay.yml");
const ciPath = path.join(root, ".github/workflows/ci.yml");

function workflow() {
  assert.ok(existsSync(workflowPath), "ITX offline replay workflow를 찾지 못함");
  return readFileSync(workflowPath, "utf8");
}

function step(source, name) {
  const match = source.match(new RegExp(`- name: ${name}[\\s\\S]*?(?=\\n\\s+- name:|\\n\\s*$)`));
  assert.ok(match, `${name} 스텝을 찾지 못함`);
  return match[0];
}

test("offline replay는 exact retained artifact를 쓰는 no-input no-secret workflow다", () => {
  const yml = workflow();
  assert.match(yml, /^on:\n\s+workflow_dispatch:\s*$/m);
  assert.doesNotMatch(yml, /^\s+(?:push|pull_request|schedule):/m);
  assert.doesNotMatch(yml, /workflow_dispatch:[\s\S]*?inputs:/);
  assert.match(yml, /^permissions:\n\s+actions: read\n\s+contents: read\s*$/m);
  assert.match(yml, /runs-on: macos-15/);
  assert.match(yml, /timeout-minutes:\s*60/);
  assert.match(yml, /cancel-in-progress:\s*false/);
  assert.match(yml, /persist-credentials:\s*false/);
  assert.match(yml, /node-version:\s*["']24\.19\.0["']/);
  assert.doesNotMatch(yml, /(?:environment:|secrets\.|DATA_GO_KR_SERVICE_KEY)/);

  const download = step(yml, "ITX offline replay / Download retained extended capture");
  assert.match(download, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/);
  assert.match(download, /repository:\s*AquilaXk\/easysubway-data/);
  assert.match(download, /run-id:\s*31620004435/);
  assert.match(download, /name:\s*itx-current-collection-continuation-31620004435/);
  assert.match(download, /github-token:\s*\$\{\{ github\.token \}\}/);
});

test("current-main station catalog과 extended capture로 replay CLI를 한 번만 실행한다", () => {
  const yml = workflow();
  const catalog = step(yml, "ITX offline replay / Emit station catalog pack");
  assert.match(catalog, /emit-station-catalog-pack\.mjs/);
  assert.match(catalog, /--catalog-pack-id "itx-current-station-catalog-v1"/);

  const run = step(yml, "ITX offline replay / Replay retained capture");
  assert.equal((run.match(/replay-current-itx-collection\.mjs/g) ?? []).length, 1);
  assert.match(run, /--capture "\$\{\{ runner\.temp \}\}\/itx-offline-replay-input\/provider-response-extended-capture\.json"/);
  assert.match(run, /--output "\$\{\{ runner\.temp \}\}\/itx-offline-replay-output\/itx-replay\.json"/);
  assert.match(run, /--station-catalog-pack "\$\{\{ runner\.temp \}\}\/itx-offline-replay-output\/station-catalog-pack"/);
  assert.doesNotMatch(run, /run-current-itx-collection|continue-current-itx-collection|provider-response-capture|promote-candidate|previous-admitted/);
});

test("sanitized replay output 하나만 14일 보존한다", () => {
  const yml = workflow();
  const upload = step(yml, "ITX offline replay / Upload sanitized replay evidence");
  assert.match(upload, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/);
  assert.match(upload, /path:\s*\$\{\{ runner\.temp \}\}\/itx-offline-replay-output\/itx-replay\.json/);
  assert.match(upload, /if-no-files-found:\s*error/);
  assert.match(upload, /retention-days:\s*14/);
  assert.doesNotMatch(upload, /provider-response|station-catalog-pack|itx-result|itx-completeness|freshness/);
  assert.doesNotMatch(yml, /(?:git (?:add|commit|push)|gh |promotion|publish|fallback|alternate provider)/i);
});

test("Data contracts가 offline replay workflow와 functional replay contract를 실행한다", () => {
  const ci = readFileSync(ciPath, "utf8");
  assert.match(ci, /tools\/ci\/itx-current-collection-offline-replay-workflow\.test\.mjs/);
  assert.match(ci, /tools\/datapack\/replay-current-itx-collection\.test\.mjs/);
});
