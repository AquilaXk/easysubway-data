import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";

// #984: 도달성 측정 workflow는 읽기 전용이다. 사람이 dispatch로만 돌리고 비밀·환경·쓰기 권한이 없다.
const { yml, steps } = loadWorkflow(path.resolve(import.meta.dirname, "../.."), "provider-reachability-probe.yml");

test("사람 dispatch로만 돌고 정기·push 트리거가 없다", () => {
  assert.match(yml, /^on:\n  workflow_dispatch:\n/mu);
  assert.doesNotMatch(yml, /\n  (schedule|push|pull_request|workflow_run):/u);
});

test("권한은 job의 contents: read뿐이고 비밀·환경·쓰기 도구가 없다", () => {
  assert.match(yml, /\npermissions: \{\}\n/u);
  assert.match(yml, /\n    permissions:\n      contents: read\n/u);
  assert.equal((yml.match(/\n      [a-z-]+: write\n/gu) ?? []).length, 0);
  assert.doesNotMatch(yml, /secrets\.|environment:|GH_TOKEN|gh pr|gh issue|gh api|git push|git commit|persist-credentials: true/u);
  for (const [, reference] of yml.matchAll(/\n\s+uses: ([^\s]+)/gu)) assert.match(reference, /@[0-9a-f]{40}$/u, reference);
});

test("측정은 읽기 전용 도구 하나를 실행한다", () => {
  const probe = steps().find(({ name }) => name === "Probe provider reachability from this runner");
  assert.ok(probe);
  assert.match(probe.block, /\n        run: node tools\/ci\/probe-provider-reachability\.mjs\n/u);
  assert.doesNotMatch(probe.block, /\$\{\{/u);
});
