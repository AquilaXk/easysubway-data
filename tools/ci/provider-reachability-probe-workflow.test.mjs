import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";

// #984: 도달성 측정 workflow는 읽기 전용이다. 사람이 dispatch로만 돌리고 비밀·환경·쓰기 권한이 없다.
const { yml, workflow, job, step } = loadWorkflow(path.resolve(import.meta.dirname, "../.."), "provider-reachability-probe.yml");

test("사람 dispatch로만 돌고 정기·push 트리거가 없다", () => {
  assert.deepEqual(workflow.on, {
    workflow_dispatch: {},
  });
});

test("권한은 job의 contents: read뿐이고 비밀·환경·쓰기 도구가 없다", () => {
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(job.permissions, {
    contents: "read",
  });
  assert.equal(job.environment, null);
  assert.doesNotMatch(yml, /secrets\.|environment:|GH_TOKEN|gh pr|gh issue|gh api|git push|git commit|persist-credentials: true/u);
  for (const item of job.steps.filter(({ uses }) => uses !== null)) {
    assert.match(item.uses, /@[0-9a-f]{40}$/u, item.uses);
  }
});

test("측정은 읽기 전용 도구 하나를 실행한다", () => {
  const probe = step("Probe provider reachability from this runner");
  assert.equal(probe.run, "node tools/ci/probe-provider-reachability.mjs");
  assert.doesNotMatch(probe.run, /\$\{\{/u);
});
