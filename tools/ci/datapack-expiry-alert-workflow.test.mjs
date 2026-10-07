import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

// #1001: 외부 스케줄러(OCI k3s CronJob)가 workflow_dispatch로 이 workflow를 깨운다. dispatch 한 번에 두 job이 모두 돌면
// 4시간 점검마다 provider 승인 만료 Slack 알림이 같이 나가므로 dispatch 입력 target으로 job을 고른다. 기본값 all은 지금 dispatch 동작과 같다.
const yml = readFileSync(path.resolve(import.meta.dirname, "../../.github/workflows/datapack-expiry-alert.yml"), "utf8");

test("트리거: 정기 실행 둘과 dispatch, dispatch는 target 입력으로 job을 고르고 기본값은 all이다", () => {
  assert.match(yml, /^on:\n  schedule:\n    - cron: "23 \*\/4 \* \* \*"\n    - cron: "41 0 \* \* \*"\n  workflow_dispatch:\n    inputs:\n      target:\n/mu);
  const inputs = /\n      target:\n((?:        .*\n)+)/u.exec(yml)?.[1] ?? "";
  assert.match(inputs, /\n?        type: choice\n/u);
  assert.match(inputs, /\n        default: all\n/u);
  assert.match(inputs, /\n        required: false\n/u);
  assert.match(inputs, /\n        options:\n          - all\n          - datapack-expiry\n          - provider-approval\n/u);
});

test("provider 승인 만료 job은 dispatch target이 all·provider-approval이거나 하루 한 번 정기 실행일 때만 돈다", () => {
  assert.match(yml, /\n  provider-approval-expiry:\n    if: \$\{\{ \(github\.event_name == 'workflow_dispatch' && \(inputs\.target == 'all' \|\| inputs\.target == 'provider-approval'\)\) \|\| github\.event\.schedule == '41 0 \* \* \*' \}\}\n/u);
});

test("데이터팩 만료 점검 job은 dispatch target이 all·datapack-expiry이거나 4시간 정기 실행일 때만 돈다", () => {
  assert.match(yml, /\n  datapack-expiry-alert:\n    if: \$\{\{ \(github\.event_name == 'workflow_dispatch' && \(inputs\.target == 'all' \|\| inputs\.target == 'datapack-expiry'\)\) \|\| github\.event\.schedule == '23 \*\/4 \* \* \*' \}\}\n/u);
});

test("같은 시각에 target이 다른 dispatch 둘이 서로를 취소하지 않도록 concurrency 그룹에 target을 넣는다", () => {
  assert.match(yml, /\nconcurrency:\n  group: datapack-expiry-alert-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}-\$\{\{ github\.event\.schedule \|\| inputs\.target \|\| github\.event_name \}\}\n  cancel-in-progress: true\n/u);
});

test("dispatch 입력은 job if 조건에서만 쓰고 셸 스크립트에 펼치지 않는다", () => {
  const lines = yml.split("\n").filter((line) => line.includes("inputs.target"));
  const jobConditions = lines.filter((line) => line.startsWith("    if: "));
  assert.equal(jobConditions.length, 2);
  assert.equal(lines.length, 3, "두 job if와 concurrency 그룹 말고는 쓰지 않는다");
});
