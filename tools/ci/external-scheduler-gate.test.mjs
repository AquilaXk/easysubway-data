import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { evaluateGithubExpression } from "./github-expression.mjs";

// #1001, #1384: 변수 게이트(DATAPACK_SCHEDULED_*)가 있는 정기 workflow 5개의 job `if`를 sender.type·event·변수 조합으로 평가한다.
// 허용 조건은 "사람이 직접 dispatch(github.event.sender.type == 'User')"뿐이다(Sonar githubactions:S8232: actor·triggering_actor 이름은 모방될 수 있어 신뢰 근거로 쓰지 않는다).
// 그 밖(App·다른 봇 dispatch, 정기 실행, push 등)은 모두 변수 게이트를 따른다.
const root = path.resolve(import.meta.dirname, "../..");
const GATES = [
  ["source-reverification.yml", "DATAPACK_SCHEDULED_SOURCE_REVERIFICATION"],
  ["source-derivative-rebinding.yml", "DATAPACK_SCHEDULED_SOURCE_REBINDING"],
  ["current-capital-topology-registration.yml", "DATAPACK_SCHEDULED_SOURCE_REGISTRATION"],
  ["itx-current-promotion.yml", "DATAPACK_SCHEDULED_ITX_PROMOTION"],
  ["nationwide-candidate-refresh.yml", "DATAPACK_SCHEDULED_CANDIDATE_REFRESH"],
];
const jobCondition = (file) => {
  const matches = [...readFileSync(path.join(root, ".github/workflows", file), "utf8").matchAll(/\n    if: (\$\{\{[^\n]*\}\})\n/gu)];
  assert.equal(matches.length, 1, `${file} has exactly one job-level if`);
  return matches[0][1];
};
const allowed = (file, variable, { event, senderType, value, ref = "refs/heads/main" }) => evaluateGithubExpression(jobCondition(file), {
  github: { event_name: event, event: senderType === undefined ? {} : { sender: { type: senderType } }, ref },
  vars: value === undefined ? {} : { [variable]: value },
});

// [event, senderType, 변수 true일 때, 변수 false일 때, 변수 없음일 때]
const TABLE = [
  ["workflow_dispatch", "User", true, true, true],
  ["workflow_dispatch", "user", true, true, true],
  ["workflow_dispatch", "Bot", true, false, false],
  ["workflow_dispatch", "Organization", true, false, false],
  ["workflow_dispatch", undefined, true, false, false],
  ["schedule", "User", true, false, false],
  ["schedule", "Bot", true, false, false],
  ["schedule", undefined, true, false, false],
  ["push", "User", true, false, false],
];

for (const [file, variable] of GATES) {
  test(`${file}: sender.type·event·변수 조합 표대로 실행 여부가 갈린다`, () => {
    for (const [event, senderType, whenTrue, whenFalse, whenUnset] of TABLE) {
      assert.equal(allowed(file, variable, { event, senderType, value: "true" }), whenTrue, `${event} ${senderType} ${variable}=true`);
      assert.equal(allowed(file, variable, { event, senderType, value: "false" }), whenFalse, `${event} ${senderType} ${variable}=false`);
      assert.equal(allowed(file, variable, { event, senderType, value: undefined }), whenUnset, `${event} ${senderType} ${variable} unset`);
    }
  });

  test(`${file}: main이 아닌 ref에서는 사람 dispatch도 변수 true도 실행하지 않는다`, () => {
    assert.equal(allowed(file, variable, { event: "workflow_dispatch", senderType: "User", value: "true", ref: "refs/heads/feature" }), false);
    assert.equal(allowed(file, variable, { event: "schedule", senderType: undefined, value: "true", ref: "refs/heads/feature" }), false);
  });

  test(`${file}: 사람 판별은 sender.type으로만 하고 모방 가능한 이름 컨텍스트(actor·triggering_actor·sender.login)를 쓰지 않는다`, () => {
    const condition = jobCondition(file);
    assert.match(condition, /github\.event\.sender\.type == 'User'/u);
    assert.doesNotMatch(condition, /github\.(?:triggering_)?actor\b|sender\.login|endsWith/u);
  });
}
