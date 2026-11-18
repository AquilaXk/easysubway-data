import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 단독 운영 전환 뒤 외부 스케줄러 계약 정합성을 위해 남긴 읽기 전용 no-op stub 계약.
const yml = readFileSync(new URL("../../.github/workflows/recovered-failure-issues-close.yml", import.meta.url), "utf8");

test("정기 실행과 사람 dispatch에서만 돌고 main 문맥에서만 job이 실행된다", () => {
  assert.match(yml, /^on:\n  schedule:\n    - cron: "13 \* \* \* \*"\n  workflow_dispatch:\n\npermissions: \{\}\n/mu);
  assert.doesNotMatch(yml, /\n  (push|pull_request|pull_request_target|workflow_run):/u);
  assert.deepEqual(yml.split("\n").filter((line) => line.startsWith("    if: ")), ["    if: ${{ github.ref == 'refs/heads/main' }}"]);
  assert.match(yml, /\nconcurrency:\n  group: recovered-failure-issues-close\n  cancel-in-progress: false\n/u);
});

test("쓰기 권한, 이슈 닫기 스크립트, 비밀·환경이 전혀 없는 읽기 전용 stub이다", () => {
  assert.match(yml, /\n    permissions:\n      contents: read\n    steps:/u);
  assert.equal(yml.split("\n").filter((line) => /: write\b/u.test(line)).length, 0);
  assert.doesNotMatch(yml, /secrets\.|\n    environment:|continue-on-error|close-recovered-failure-issues\.mjs|\bissues:\s*write\b/u);
  assert.match(yml, /::notice title=Retired workflow::/u);
});
