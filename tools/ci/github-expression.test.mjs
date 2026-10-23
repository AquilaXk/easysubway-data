import assert from "node:assert/strict";
import test from "node:test";

import { evaluateGithubExpression } from "./github-expression.mjs";

const context = { github: { actor: "Alice", ref: "refs/heads/main" }, vars: { FLAG: "true", EMPTY: "" }, inputs: {} };
const run = (expression) => evaluateGithubExpression(`\${{ ${expression} }}`, context);

test("비교는 대소문자를 구분하지 않고 빈 문자열은 거짓이다", () => {
  assert.equal(run("github.actor == 'alice'"), true);
  assert.equal(run("github.actor != 'alice'"), false);
  assert.equal(run("vars.EMPTY"), false);
  assert.equal(run("vars.MISSING == ''"), true);
  assert.equal(run("inputs.target == 'all'"), false);
});

test("논리 연산과 괄호·endsWith를 우선순위대로 계산한다", () => {
  assert.equal(run("true || false && false"), true);
  assert.equal(run("(true || false) && false"), false);
  assert.equal(run("!endsWith(github.actor, '[bot]')"), true);
  assert.equal(run("endsWith('x[bot]', '[BOT]')"), true);
  assert.equal(run("vars.FLAG == 'true' && github.ref == 'refs/heads/main'"), true);
});

test("앞 step의 출력(steps.<id>.outputs.<name>)을 읽고, 돌지 않은 step의 출력은 빈 문자열이다", () => {
  const steps = { claim: { outputs: { claimed: "false" } } };
  const evaluate = (expression) => evaluateGithubExpression(`\${{ ${expression} }}`, { ...context, steps });
  assert.equal(evaluate("steps.claim.outputs.claimed == 'false'"), true);
  assert.equal(evaluate("steps.push.outputs.pushed == 'false'"), false);
  assert.equal(evaluate("steps.push.outputs.pushed == ''"), true);
});

test("지원하지 않는 문법은 거절한다", () => {
  assert.throws(() => run("contains(github.actor, 'a')"), /GITHUB_EXPRESSION_UNSUPPORTED/u);
  assert.throws(() => run("github.actor =="), /GITHUB_EXPRESSION_SYNTAX/u);
  assert.throws(() => run("(true"), /GITHUB_EXPRESSION_SYNTAX/u);
  assert.throws(() => run("secrets.X"), /GITHUB_EXPRESSION_UNSUPPORTED/u);
});

test("steps는 steps.<id>.outputs.<name>만 읽는다. outcome·conclusion 같은 다른 형태는 빈 문자열로 덮지 않고 거절한다", () => {
  const steps = { claim: { outcome: "success", outputs: { claimed: "false" } } };
  const evaluate = (expression) => evaluateGithubExpression(`\${{ ${expression} }}`, { ...context, steps });
  for (const form of ["steps.claim.outcome == 'success'", "steps.claim.conclusion == 'success'", "steps.claim.outputs", "steps.claim", "steps.claim.outputs.claimed.extra", "steps"]) {
    assert.throws(() => evaluate(form), /GITHUB_EXPRESSION_UNSUPPORTED/u, form);
  }
  assert.equal(evaluate("steps.claim.outputs.claimed == 'false'"), true);
});
