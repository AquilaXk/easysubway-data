import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";

// hub easysubway#3036: 미국 호스티드 러너 도달성 측정 workflow는 읽기 전용이고 한시적이다.
// 서울 k3s와 같은 스크립트를 platform의 고정 커밋에서 받아 쓰고, 비밀·환경·쓰기 권한이 없다.
const { yml, steps, step } = loadWorkflow(path.resolve(import.meta.dirname, "../.."), "source-reachability-probe.yml");

test("정기(매시)와 사람 dispatch로만 시작하고 push·PR 트리거가 없다", () => {
  assert.match(yml, /^on:\n  schedule:\n    - cron: "7 \* \* \* \*"\n  workflow_dispatch:\n\npermissions: \{\}\n/mu);
  assert.doesNotMatch(yml, /\n  (push|pull_request|pull_request_target|workflow_run):/u);
  assert.match(yml, /\n    if: \$\{\{ github\.event_name == 'workflow_dispatch' \|\| vars\.SOURCE_REACHABILITY_PROBE == 'true' \}\}\n/u);
});

test("GitHub 호스티드 ubuntu-latest에서 서울 이미지와 같은 Node 24.19.0 빌드로 돈다", () => {
  assert.match(yml, /\n    runs-on: ubuntu-latest\n/u);
  assert.equal((yml.match(/runs-on:/gu) ?? []).length, 1);
  assert.doesNotMatch(yml, /self-hosted/u);
  // 서울 CronJob 이미지(platform deploy 도구의 node:24.19.0-alpine)와 같은 Node 빌드여야 TLS·DNS 스택이 같다.
  assert.match(yml, /\n          node-version: "24\.19\.0"\n/u);
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
  assert.match(checkout.block, /\n          path: platform-probe\n          sparse-checkout: tools\/ops\/source-reachability-probe\.mjs\n          sparse-checkout-cone-mode: false\n          persist-credentials: false$/u);
});

test("측정은 벽시계 10분 경계에 맞춘 6라운드이고 첫 경계 대기까지 포함해 timeout 안에 끝난다(호스트당 요청은 10분에 1회)", () => {
  const probe = step("Probe source reachability from this runner");
  const match = /--vantage gha-us-hosted --rounds (\d+) --interval-seconds (\d+) --align --output "\$\{RUNNER_TEMP\}\/gha-us-hosted-probe\.jsonl"/u.exec(probe.block);
  assert.ok(match, "--align으로 라운드를 실제 시계 경계에 맞춘다");
  const [rounds, intervalSeconds] = [Number(match[1]), Number(match[2])];
  assert.equal(intervalSeconds, 600);
  const timeoutMinutes = Number(/\n    timeout-minutes: (\d+)\n/u.exec(yml)?.[1]);
  // 최악: 첫 경계까지 한 간격을 기다린 뒤 (rounds-1)번 더 기다린다.
  assert.ok((rounds * intervalSeconds) / 60 <= timeoutMinutes, "첫 경계 대기와 마지막 라운드까지 timeout 안이다");
  assert.ok(timeoutMinutes <= 60, "다음 정기 실행과 겹치지 않는다");
  assert.match(yml, /\nconcurrency:\n  group: source-reachability-probe\n  cancel-in-progress: false\n/u, "늦은 실행은 직렬화하고 취소하지 않는다");
});

test("받은 스크립트의 SHA-256을 기대값과 대조하고 다르면 측정 전에 실패한다", () => {
  const names = steps().map(({ name }) => name);
  assert.ok(names.indexOf("Verify the shared probe script digest") > names.indexOf("Checkout the shared probe script"));
  assert.ok(names.indexOf("Verify the shared probe script digest") < names.indexOf("Probe source reachability from this runner"));
  const verify = step("Verify the shared probe script digest");
  assert.match(verify.block, /\n          EXPECTED_SHA256: [0-9a-f]{64}\n/u);
  assert.match(verify.block, /echo "\$\{EXPECTED_SHA256\}  platform-probe\/tools\/ops\/source-reachability-probe\.mjs" \| sha256sum --check --strict\n/u);
  assert.match(verify.block, /set -euo pipefail/u);
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
