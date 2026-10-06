import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// #884: Data contracts job은 테스트가 끝난 뒤 작업 트리가 깨끗한지 확인한다. 이 step이 빠지면 테스트가
// 추적 파일을 덮어써도 CI가 알아채지 못한다.
const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const JOBS = ["contracts_mobile_v19", "contracts_shard_1", "contracts_shard_2", "contracts_shard_3", "contracts_shard_4"];

function jobBody(name) {
  const start = ci.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `${name} job`);
  const next = ci.slice(start + 1).search(/\n  [a-z_0-9]+:\n|\n  # #985/);
  return ci.slice(start, next === -1 ? undefined : start + 1 + next);
}

test("각 Data contracts job은 마지막 step에서 작업 트리가 깨끗한지 확인하고 변경이 있으면 실패한다", () => {
  for (const name of JOBS) {
    const body = jobBody(name);
    const steps = body.split("\n      - name: ");
    const last = steps[steps.length - 1];
    assert.match(last, /^Verify tests left the working tree clean/, `${name}: 마지막 step`);
    assert.match(last, /git status --porcelain --untracked-files=all -- \. ':\(exclude\)apps\/mobile'/, `${name}: 검사 명령`);
    assert.match(last, /\[\[ -n "\$\{changed\}" \]\]/, `${name}: 출력이 있으면 실패`);
    assert.match(last, /exit 1/, `${name}: 실패 종료`);
    assert.doesNotMatch(last, /continue-on-error|\|\| true/, `${name}: 경고만으로 통과시키지 않는다`);
  }
});
