import assert from "node:assert/strict";
import test from "node:test";

import { DERIVATIVE_REBINDING_CLAIM_PREFIX, decideDerivativeRebinding, parseDerivativeRebindingBranches } from "./decide-derivative-rebinding.mjs";

// #969 P4: 파생 재결속은 도구가 멱등이라 실행해 보면 갱신 필요 여부를 안다(diff). 판정은 실행해도 되는지만 가린다.
const REPOSITORY = "AquilaXk/easysubway-data";
const pr = (state, runId, overrides = {}) => ({
  number: 990, state, isDraft: true, headRefName: `${DERIVATIVE_REBINDING_CLAIM_PREFIX}${runId}`, baseRefName: "main",
  isCrossRepository: false, headRepository: { nameWithOwner: REPOSITORY }, ...overrides,
});
const writer = (number, prefix = "automation/639-seoul-accessibility-refresh-") => pr("OPEN", 9, { number, headRefName: `${prefix}9` });
const decide = (overrides = {}) => decideDerivativeRebinding({ pullRequests: [], branches: [], repository: REPOSITORY, ...overrides });

test("claim 접두어는 이 이슈 번호의 파생 재결속 브랜치다", () => {
  assert.equal(DERIVATIVE_REBINDING_CLAIM_PREFIX, "automation/969-derivative-rebinding-");
});

test("열린 PR도 기다릴 PR도 없으면 RUN이다", () => {
  assert.deepEqual(decide(), { state: "RUN", cleanupBranches: [] });
  assert.deepEqual(decide({ pullRequests: [pr("MERGED", 1)], branches: [`${DERIVATIVE_REBINDING_CLAIM_PREFIX}1`] }), { state: "RUN", cleanupBranches: [] });
});

test("이 workflow의 열린 PR이 있으면 OPEN_PR이다", () => {
  const branch = `${DERIVATIVE_REBINDING_CLAIM_PREFIX}1`;
  assert.deepEqual(decide({ pullRequests: [pr("OPEN", 1)], branches: [branch] }), { state: "OPEN_PR", branch, cleanupBranches: [] });
});

test("원장을 쓰는 다른 자동화 PR이 열려 있으면 BLOCKED_BY_PENDING_PR로 기다린다", () => {
  assert.deepEqual(decide({ pullRequests: [writer(971), writer(972, "automation/456-capital-topology-registration-")] }), { state: "BLOCKED_BY_PENDING_PR", blockedBy: [971, 972], cleanupBranches: [] });
  // 후보 PR·사람 PR·다른 저장소 PR·닫힌 PR은 기다릴 이유가 아니다.
  assert.equal(decide({ pullRequests: [writer(973, "automation/927-nationwide-candidate-refresh-"), writer(974, "feat/x"), { ...writer(975), isCrossRepository: true }, { ...writer(976), state: "CLOSED" }] }).state, "RUN");
});

// #975 리뷰 F7·이슈 #973: PR 없이 남았거나 닫힌 PR의 브랜치는 이상이 아니라 정리 대상이다.
test("PR 없이 남았거나 닫힌 PR의 브랜치는 정리 대상으로 알리고 판정은 계속한다", () => {
  const orphan = `${DERIVATIVE_REBINDING_CLAIM_PREFIX}7`;
  assert.deepEqual(decide({ branches: [orphan] }), { state: "RUN", cleanupBranches: [orphan] });
  assert.deepEqual(decide({ branches: [orphan], pullRequests: [pr("CLOSED", 7)] }), { state: "RUN", cleanupBranches: [orphan] });
  const open = `${DERIVATIVE_REBINDING_CLAIM_PREFIX}1`;
  assert.deepEqual(decide({ pullRequests: [pr("OPEN", 1)], branches: [open, orphan] }), { state: "OPEN_PR", branch: open, cleanupBranches: [orphan] });
});

test("열린 PR이 둘 이상이거나 열린 PR의 브랜치가 없거나 입력이 잘못되면 이상이다", () => {
  assert.throws(() => decide({ pullRequests: [pr("OPEN", 1), pr("OPEN", 2, { number: 991 })], branches: [`${DERIVATIVE_REBINDING_CLAIM_PREFIX}1`, `${DERIVATIVE_REBINDING_CLAIM_PREFIX}2`] }), /DERIVATIVE_REBINDING_PR_DUPLICATE/u);
  assert.throws(() => decide({ pullRequests: [pr("OPEN", 1)] }), /DERIVATIVE_REBINDING_BRANCH_MISSING/u);
  assert.throws(() => decide({ repository: "x" }), /DERIVATIVE_REBINDING_INPUT_INVALID/u);
  assert.throws(() => decide({ pullRequests: null }), /DERIVATIVE_REBINDING_INPUT_INVALID/u);
});

test("브랜치 목록은 파생 재결속 브랜치 ref만 받는다", () => {
  const sha = "d".repeat(40);
  assert.deepEqual(parseDerivativeRebindingBranches(`${sha}\trefs/heads/${DERIVATIVE_REBINDING_CLAIM_PREFIX}5\n`), [`${DERIVATIVE_REBINDING_CLAIM_PREFIX}5`]);
  assert.throws(() => parseDerivativeRebindingBranches(`${sha}\trefs/heads/automation/other-1\n`), /DERIVATIVE_REBINDING_BRANCH_INVALID/u);
});
