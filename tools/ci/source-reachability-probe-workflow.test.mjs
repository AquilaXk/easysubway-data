import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";

// hub easysubway#3036: 미국 호스티드 러너 도달성 측정 workflow는 읽기 전용이고 한시적이다.
// 서울 k3s와 같은 스크립트를 platform의 고정 커밋에서 받아 쓰고, 비밀·환경·쓰기 권한이 없다.
const { yml, steps, step } = loadWorkflow(path.resolve(import.meta.dirname, "../.."), "source-reachability-probe.yml");

test("정기(매시)와 사람 dispatch로만 시작하고 push·PR 트리거가 없다", () => {
  assert.match(yml, /^on:\n  schedule:\n    - cron: "17 \* \* \* \*"\n  workflow_dispatch:\n\npermissions: \{\}\n/mu);
  assert.doesNotMatch(yml, /\n  (push|pull_request|pull_request_target|workflow_run):/u);
  assert.match(yml, /\n    if: \$\{\{ github\.event_name == 'workflow_dispatch' \|\| vars\.SOURCE_REACHABILITY_PROBE == 'true' \}\}\n/u);
});

test("권한은 job의 contents: read뿐이고 비밀·환경·쓰기 도구가 없다", () => {
  assert.match(yml, /\n    permissions:\n      contents: read\n/u);
  assert.equal((yml.match(/\n      [a-z-]+: write\n/gu) ?? []).length, 0);
  assert.doesNotMatch(yml, /secrets\.|environment:|GH_TOKEN|GITHUB_TOKEN|gh pr|gh issue|gh api|git push|git commit|persist-credentials: true/u);
  for (const [, reference] of yml.matchAll(/\n\s+uses: ([^\s]+)/gu)) assert.match(reference, /@[0-9a-f]{40}$/u, reference);
});

test("측정 스크립트는 platform의 고정 커밋에서 그 파일 하나만 받는다", () => {
  const checkout = step("Checkout the shared probe script");
  assert.match(checkout.block, /\n          repository: AquilaXk\/easysubway-platform\n/u);
  assert.match(checkout.block, /\n          ref: [0-9a-f]{40}\n/u);
  assert.match(checkout.block, /\n          path: platform-probe\n          sparse-checkout: tools\/ops\/source-reachability-probe\.mjs\n          sparse-checkout-cone-mode: false\n          persist-credentials: false\n/u);
});

test("측정은 10분 간격 6라운드로 한 시간 안에 끝나고 호스트당 요청은 10분에 1회다", () => {
  const probe = step("Probe source reachability from this runner");
  const match = /--vantage gha-us-hosted --rounds (\d+) --interval-seconds (\d+) --output "\$\{RUNNER_TEMP\}\/gha-us-hosted-probe\.jsonl"/u.exec(probe.block);
  assert.ok(match);
  const [rounds, intervalSeconds] = [Number(match[1]), Number(match[2])];
  assert.equal(intervalSeconds, 600);
  const timeoutMinutes = Number(/\n    timeout-minutes: (\d+)\n/u.exec(yml)?.[1]);
  assert.ok(((rounds - 1) * intervalSeconds) / 60 < timeoutMinutes, "마지막 라운드까지 timeout 안이다");
  assert.ok(timeoutMinutes <= 60, "다음 정기 실행과 겹치지 않는다");
});

test("run 스크립트에 표현식을 직접 넣지 않고 요약·artifact는 측정이 중간에 끝나도 남긴다", () => {
  for (const { name, block } of steps()) {
    assert.doesNotMatch(block.split("\n        run: ")[1] ?? "", /\$\{\{/u, name);
  }
  assert.match(step("Summarize the measurements").block, /\n        if: \$\{\{ always\(\) \}\}\n/u);
  const upload = step("Upload the measurements");
  assert.match(upload.block, /\n        if: \$\{\{ always\(\) \}\}\n/u);
  assert.match(upload.block, /\n          name: source-reachability-gha-us-hosted-\$\{\{ github\.run_id \}\}\n/u);
  assert.equal(yml.trimEnd().endsWith("retention-days: 30"), true);
});
