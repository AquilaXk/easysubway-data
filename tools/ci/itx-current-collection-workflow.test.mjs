import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(root, ".github/workflows/itx-current-collection.yml");
const ciPath = path.join(root, ".github/workflows/ci.yml");

function workflow() {
  assert.ok(existsSync(workflowPath), "ITX current collection workflow를 찾지 못함");
  return readFileSync(workflowPath, "utf8");
}

function step(source, name) {
  const match = source.match(new RegExp(`- name: ${name}[\\s\\S]*?(?=\\n\\s+- name:|\\n\\s*$)`));
  assert.ok(match, `${name} 스텝을 찾지 못함`);
  return match[0];
}

test("ITX current collection은 수동 전용 read-only workflow다", () => {
  const yml = workflow();
  assert.match(yml, /^on:\n\s+workflow_dispatch:\s*$/m);
  assert.doesNotMatch(yml, /^\s+(?:push|pull_request|schedule):/m);
  assert.match(yml, /^permissions:\n\s+contents: read\s*$/m);
  assert.match(yml, /timeout-minutes:\s*60/);
  assert.match(yml, /collect:\n\s+name: ITX current collection\n\s+runs-on: ubuntu-latest\n\s+environment: itx-current-collection/);
  assert.match(yml, /concurrency:[\s\S]*?cancel-in-progress:\s*false/);
  assert.match(yml, /persist-credentials:\s*false/);
  assert.match(yml, /node-version:\s*["']24\.19\.0["']/);
  assert.doesNotMatch(yml, /workflow_dispatch:[\s\S]*?inputs:/);
});

test("tracked catalog·single-clock wrapper가 temp에서 정확한 current 수집을 구성한다", () => {
  const yml = workflow();
  assert.doesNotMatch(yml, /Derive KST service dates|check-timetable-snapshot-freshness\.mjs|steps\.freshness\.outputs/);

  const catalog = step(yml, "ITX current collection / Emit station catalog pack");
  assert.match(catalog, /emit-station-catalog-pack\.mjs/);
  assert.match(catalog, /\$\{\{ runner\.temp \}\}/);
  assert.match(catalog, /--catalog-pack-id "itx-current-station-catalog-v1"/);
  assert.doesNotMatch(catalog, /catalog-pack-id[^\n]*\$\{\{\s*github\.run_id\s*\}\}/);

  const collect = step(yml, "ITX current collection / Collect ITX current timetable");
  assert.match(collect, /DATA_GO_KR_SERVICE_KEY:\s*\$\{\{ secrets\.DATA_GO_KR_SERVICE_KEY \}\}/);
  assert.match(collect, /must be a nonempty single line/);
  assert.equal((collect.match(/run-current-itx-collection\.mjs/g) ?? []).length, 1);
  for (const flag of ["--output", "--completeness-output", "--station-catalog-pack", "--freshness-output"]) {
    assert.match(collect, new RegExp(flag));
  }
  assert.match(collect, /candidate and completeness paths must be absent/);
  assert.doesNotMatch(collect, /(?:collect-korail-itx-cheongchun-timetable|day[789]-date|promote-candidate|previous-admitted|replay|canonical-pack)/);
});

test("실패에도 sanitized 증적만 보존하며 raw·secret·catalog·promotion 경로는 없다", () => {
  const yml = workflow();
  const upload = step(yml, "ITX current collection / Upload sanitized evidence");
  assert.match(upload, /if:\s*\$\{\{ always\(\) \}\}/);
  assert.match(upload, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/);
  assert.match(upload, /retention-days:\s*14/);
  assert.match(upload, /freshness\.json/);
  assert.match(upload, /itx-result\.json/);
  assert.doesNotMatch(upload, /station-catalog-pack|DATA_GO_KR_SERVICE_KEY|raw/i);
  assert.doesNotMatch(yml, /(?:git (?:add|commit|push)|gh |promotion|publish|upload-release|fallback|alternate provider)/i);
});

test("Data contracts가 ITX current workflow static contract를 실행한다", () => {
  const ci = readFileSync(ciPath, "utf8");
  assert.match(ci, /tools\/ci\/itx-current-collection-workflow\.test\.mjs/);
  assert.match(ci, /tools\/datapack\/run-current-itx-collection\.test\.mjs/);
});
