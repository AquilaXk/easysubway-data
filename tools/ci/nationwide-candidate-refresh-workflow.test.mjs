import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

// #969 P5: 전국 후보 갱신 workflow 계약. 정기 실행은 매일 무조건 후보를 올리지 않고, 입력이 바뀌었을 때(STALE)만 한 번 PR을 만든다.
// 사람 dispatch는 명시 요청이라 CURRENT여도 진행한다(FORCED). 열린 후보 PR이 있거나 원장 쓰기 PR이 열려 있으면 새로 만들지 않는다.
const root = path.resolve(import.meta.dirname, "../..");
const FILE = "nationwide-candidate-refresh.yml";
const yml = readFileSync(path.join(root, ".github/workflows", FILE), "utf8");

function steps() {
  return yml.split("\n      - name: ").slice(1).map((block) => ({ name: block.split("\n")[0], block }));
}
function step(name) {
  const found = steps().filter((item) => item.name === name);
  assert.equal(found.length, 1, `step ${name}`);
  return found[0];
}
const ifCondition = (block) => /\n        if: (\$\{\{[^\n]*\}\})/u.exec(block)?.[1] ?? null;
const PROCEED = "${{ steps.decision.outputs.state == 'STALE' || steps.decision.outputs.state == 'FORCED' }}";

test("트리거: 2시간마다 정기 폴링과 사람 dispatch(2인 역할 입력 유지), push 트리거는 없다", () => {
  assert.match(yml, /\non:\n  schedule:\n    - cron: "29 \*\/2 \* \* \*"\n  workflow_dispatch:\n    inputs:\n      releaseSequence:/u);
  assert.doesNotMatch(yml, /\n  push:|\n  workflow_run:/u);
  assert.match(yml, /\n      requestedBy:\n[\s\S]*\n      approvedBy:\n/u);
});

test("권한은 job에만 주고 issues 쓰기는 실패 보고용이다(workflow dispatch 권한은 없다)", () => {
  assert.match(yml, /\npermissions: \{\}\n/u);
  assert.equal((yml.match(/\n    permissions:\n/gu) ?? []).length, 1);
  assert.match(yml, /\n    permissions:\n      contents: write\n      pull-requests: write\n      issues: write\n/u);
  assert.doesNotMatch(yml, /actions: write/u);
});

test("정기 실행은 저장소 변수가 true일 때만 돈다(기존 게이트 유지)", () => {
  assert.match(yml, /\n    if: \$\{\{ github\.ref == 'refs\/heads\/main' && \(github\.event_name != 'schedule' \|\| vars\.DATAPACK_SCHEDULED_CANDIDATE_REFRESH == 'true'\) \}\}\n/u);
});

test("판정 step이 입력 검증·후보 생성보다 먼저 돌고 열린 PR·브랜치·매니페스트만 읽는다", () => {
  const all = steps();
  const decision = all.findIndex(({ name }) => name === "Decide whether the nationwide candidate must be refreshed");
  const plan = all.findIndex(({ name }) => name === "Validate candidate refresh inputs");
  assert.ok(decision !== -1 && decision < plan);
  const { block } = all[decision];
  assert.match(block, /\n        id: decision\n/u);
  assert.match(block, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(block, /EVENT_NAME: \$\{\{ github\.event_name \}\}/u);
  assert.match(block, /gh pr list --repo "\$\{GITHUB_REPOSITORY\}" --state all --limit 1000 --json number,state,isDraft,headRefName,baseRefName,headRepository,isCrossRepository > /u);
  assert.match(block, /git ls-remote --heads origin "refs\/heads\/automation\/927-nationwide-candidate-refresh-\*" > /u);
  assert.match(block, /node tools\/ci\/decide-nationwide-candidate-refresh\.mjs --event "\$\{EVENT_NAME\}" --repository "\$\{GITHUB_REPOSITORY\}" --prs "[^"]+" --branches "[^"]+" --github-output "\$\{GITHUB_OUTPUT\}"/u);
});

test("후보 생성·범위 검증·push·App 토큰·PR 생성은 STALE 또는 FORCED일 때만 돈다", () => {
  for (const name of [
    "Validate candidate refresh inputs", "Record the candidate gate run", "Refresh nationwide candidate", "Verify candidate refresh output scope",
    "Commit and push candidate refresh branch", "Mint App token for the candidate refresh pull request", "Create candidate refresh pull request",
  ]) assert.equal(ifCondition(step(name).block), PROCEED, name);
  assert.equal(ifCondition(step("Remove the candidate refresh branch after a later failure").block), "${{ failure() && env.CANDIDATE_BRANCH != '' }}");
});

test("OPEN_PR이면 App 토큰 → required CI 보장 → 열린 PR 상한 검사 순서로 돈다", () => {
  const all = steps();
  const index = (name) => all.findIndex((item) => item.name === name);
  const token = index("Mint App token for the open refresh pull request");
  const ensure = index("Ensure required CI on the open refresh pull request");
  const age = index("Enforce open refresh pull request age limit");
  const decision = index("Decide whether the nationwide candidate must be refreshed");
  assert.ok(decision < token && token < ensure && ensure < age);
  for (const item of [token, ensure, age]) assert.equal(ifCondition(all[item].block), "${{ steps.decision.outputs.state == 'OPEN_PR' }}");
  assert.match(all[ensure].block, /node tools\/ci\/refresh-pr-required-ci\.mjs --workflow nationwide-candidate-refresh\.yml --repository "\$\{GITHUB_REPOSITORY\}" --github-output "\$\{GITHUB_OUTPUT\}"/u);
  assert.match(all[age].block, /node tools\/ci\/refresh-open-pr-age\.mjs --workflow nationwide-candidate-refresh\.yml --prs "\$\{open_prs\}" --policy release\/product-gates\/datapack-freshness-sla\.json --repository "\$\{GITHUB_REPOSITORY\}" --ci-state "\$\{\{ steps\.required-ci\.outputs\.state \}\}"/u);
});

test("원장 쓰기 PR 때문에 기다리는 실행은 이유를 notice로 남기고 아무것도 쓰지 않는다", () => {
  const { block } = step("Note candidate refresh waiting on a pending source pull request");
  assert.equal(ifCondition(block), "${{ steps.decision.outputs.state == 'BLOCKED_BY_PENDING_PR' }}");
  assert.match(block, /::notice title=Nationwide candidate refresh::/u);
  assert.match(block, /steps\.decision\.outputs\.blocked_by/u);
});

test("후보 PR 본문은 정기 갱신이 입력 변경으로 시작됐음을 남기고, 실패 보고가 마지막 step이다", () => {
  assert.match(step("Create candidate refresh pull request").block, /steps\.decision\.outputs\.stale_paths/u);
  const report = step("Report refresh failure as an issue");
  assert.equal(ifCondition(report.block), "${{ failure() }}");
  assert.ok(report.block.includes('node tools/ci/report-refresh-failure.mjs --workflow nationwide-candidate-refresh.yml --repository "${GITHUB_REPOSITORY}" --run-id "${GITHUB_RUN_ID}"'));
  assert.equal(yml.trimEnd().endsWith(report.block.trimEnd()), true);
});
