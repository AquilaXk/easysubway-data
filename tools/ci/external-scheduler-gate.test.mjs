import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { evaluateGithubExpression } from "./github-expression.mjs";

// #1001: 변수 게이트(DATAPACK_SCHEDULED_*)가 있는 정기 workflow 4개의 job `if`를 actor·event·변수 조합으로 평가한다.
// 허용 조건은 "사람이 직접 dispatch"뿐이다. 사람 = triggering_actor가 App이 아니고 `[bot]` 접미사(GitHub Bot 계정 형식)도 아니다.
// 그 밖(App dispatch, 다른 봇 dispatch, 정기 실행, 알 수 없는 event)은 모두 변수 게이트를 따른다.
const root = path.resolve(import.meta.dirname, "../..");
const APP = "easysubway-release-chain[bot]";
const GATES = [
  ["source-reverification.yml", "DATAPACK_SCHEDULED_SOURCE_REVERIFICATION"],
  ["source-derivative-rebinding.yml", "DATAPACK_SCHEDULED_SOURCE_REBINDING"],
  ["current-capital-topology-registration.yml", "DATAPACK_SCHEDULED_SOURCE_REGISTRATION"],
  ["itx-current-promotion.yml", "DATAPACK_SCHEDULED_ITX_PROMOTION"],
];
const jobCondition = (file) => {
  const matches = [...readFileSync(path.join(root, ".github/workflows", file), "utf8").matchAll(/\n    if: (\$\{\{[^\n]*\}\})\n/gu)];
  assert.equal(matches.length, 1, `${file} has exactly one job-level if`);
  return matches[0][1];
};
const allowed = (file, variable, { event, actor, value, ref = "refs/heads/main" }) => evaluateGithubExpression(jobCondition(file), {
  github: { event_name: event, triggering_actor: actor, actor, ref },
  vars: value === undefined ? {} : { [variable]: value },
});

// [event, actor, 변수 true일 때, 변수 false일 때, 변수 없음일 때]
const TABLE = [
  ["workflow_dispatch", "AquilaXk", true, true, true],
  ["workflow_dispatch", "some-human", true, true, true],
  ["workflow_dispatch", APP, true, false, false],
  ["workflow_dispatch", "EasySubway-Release-Chain[bot]", true, false, false],
  ["workflow_dispatch", "github-actions[bot]", true, false, false],
  ["workflow_dispatch", "dependabot[bot]", true, false, false],
  ["workflow_dispatch", "replacement-app[bot]", true, false, false],
  ["schedule", "AquilaXk", true, false, false],
  ["schedule", "github-actions[bot]", true, false, false],
  ["push", "AquilaXk", true, false, false],
];

for (const [file, variable] of GATES) {
  test(`${file}: actor·event·변수 조합 표대로 실행 여부가 갈린다`, () => {
    for (const [event, actor, whenTrue, whenFalse, whenUnset] of TABLE) {
      assert.equal(allowed(file, variable, { event, actor, value: "true" }), whenTrue, `${event} ${actor} ${variable}=true`);
      assert.equal(allowed(file, variable, { event, actor, value: "false" }), whenFalse, `${event} ${actor} ${variable}=false`);
      assert.equal(allowed(file, variable, { event, actor, value: undefined }), whenUnset, `${event} ${actor} ${variable} unset`);
    }
  });

  test(`${file}: main이 아닌 ref에서는 사람 dispatch도 변수 true도 실행하지 않는다`, () => {
    assert.equal(allowed(file, variable, { event: "workflow_dispatch", actor: "AquilaXk", value: "true", ref: "refs/heads/feature" }), false);
    assert.equal(allowed(file, variable, { event: "schedule", actor: "AquilaXk", value: "true", ref: "refs/heads/feature" }), false);
  });

  test(`${file}: 사람 판별은 triggering_actor로 하고 App 로그인과 [bot] 접미사를 모두 거른다`, () => {
    const condition = jobCondition(file);
    assert.match(condition, /github\.triggering_actor != 'easysubway-release-chain\[bot\]'/u);
    assert.match(condition, /!endsWith\(github\.triggering_actor, '\[bot\]'\)/u);
    assert.doesNotMatch(condition, /github\.actor\b/u);
  });
}
