import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// #1287: 회복된 실패 이슈 자동 종료 workflow의 구조 계약. 이슈 쓰기 권한만 갖고, 비밀이 없고, run 스크립트에 expression이 없다.
const yml = readFileSync(new URL("../../.github/workflows/recovered-failure-issues-close.yml", import.meta.url), "utf8");

test("정기 실행과 사람 dispatch에서만 돌고 main 문맥에서만 job이 실행된다", () => {
  assert.match(yml, /^on:\n  schedule:\n    - cron: "13 \* \* \* \*"\n  workflow_dispatch:\n\npermissions: \{\}\n/mu);
  assert.doesNotMatch(yml, /\n  (push|pull_request|pull_request_target|workflow_run):/u);
  assert.deepEqual(yml.split("\n").filter((line) => line.startsWith("    if: ")), ["    if: ${{ github.ref == 'refs/heads/main' }}"]);
  assert.match(yml, /\nconcurrency:\n  group: recovered-failure-issues-close\n  cancel-in-progress: false\n/u);
});

test("권한은 run 조회(actions read)와 이슈 닫기(issues write)뿐이고 비밀·환경·continue-on-error가 없다", () => {
  assert.match(yml, /\n    permissions:\n      actions: read\n      contents: read\n      issues: write\n    steps:/u);
  assert.deepEqual(yml.split("\n").filter((line) => /: write\b/u.test(line)), ["      issues: write"]);
  assert.doesNotMatch(yml, /secrets\.|\n    environment:|continue-on-error/u);
});

test("마지막 step이 도구를 부르고 run 스크립트에는 expression이 없다", () => {
  const stepStart = yml.indexOf("      - name: Close the recovered failure issues\n");
  assert.notEqual(stepStart, -1);
  const step = yml.slice(stepStart);
  assert.match(step, /\n          GH_TOKEN: \$\{\{ github\.token \}\}\n/u);
  assert.equal(step.split("\n        run: ")[1].trim(), 'node tools/ci/close-recovered-failure-issues.mjs --repository "${GITHUB_REPOSITORY}"');
  assert.ok(yml.trimEnd().endsWith(step.trimEnd()), "closing is the last step");
});
