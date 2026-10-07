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

test("지원하지 않는 문법은 거절한다", () => {
  assert.throws(() => run("contains(github.actor, 'a')"), /GITHUB_EXPRESSION_UNSUPPORTED/u);
  assert.throws(() => run("github.actor =="), /GITHUB_EXPRESSION_SYNTAX/u);
  assert.throws(() => run("(true"), /GITHUB_EXPRESSION_SYNTAX/u);
  assert.throws(() => run("secrets.X"), /GITHUB_EXPRESSION_UNSUPPORTED/u);
});
