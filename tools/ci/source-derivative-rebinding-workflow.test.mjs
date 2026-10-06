import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

// #969 P4: 파생 재결속 workflow 계약. 원장·정본 팩이 main에서 바뀌면(또는 정기 복구로) controller가 파생 산출물을 다시 만들고,
// 바뀐 것이 있을 때만 App 토큰 PR 하나로 올린다. 변경이 없으면 PR도 만들지 않는다. 변수가 꺼져 있으면 push·정기 실행은 건너뛴다.
const root = path.resolve(import.meta.dirname, "../..");
const FILE = "source-derivative-rebinding.yml";
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
const RUN = "${{ steps.decision.outputs.state == 'RUN' }}";
const CHANGED = "${{ steps.decision.outputs.state == 'RUN' && steps.rebind.outputs.changed == 'true' }}";

test("트리거: 원장·정본 팩 push, 정기 복구, 사람 dispatch", () => {
  assert.match(yml, /^on:\n  push:\n    branches:\n      - main\n    paths:\n      - tools\/datapack\/release\/source-snapshots\.json\n      - tools\/datapack\/release\/capital-production-canonical-pack\.json\n  schedule:\n    - cron: "41 \*\/6 \* \* \*"\n  workflow_dispatch:\n/mu);
});

test("권한은 job에만 주고 변수가 true일 때만 push·정기 실행이 돈다", () => {
  assert.match(yml, /\npermissions: \{\}\n/u);
  assert.equal((yml.match(/\n    permissions:\n/gu) ?? []).length, 1);
  assert.match(yml, /\n    permissions:\n      contents: write\n      pull-requests: write\n      issues: write\n/u);
  assert.doesNotMatch(yml, /actions: write|gh workflow run|repository_dispatch/u);
  assert.match(yml, /\n    if: \$\{\{ github\.ref == 'refs\/heads\/main' && \(github\.event_name == 'workflow_dispatch' \|\| vars\.DATAPACK_SCHEDULED_SOURCE_REBINDING == 'true'\) \}\}\n/u);
  assert.match(yml, /\n    environment: datapack-release-check\n/u);
});

test("판정 step이 controller보다 먼저 돌고 열린 PR·브랜치만 읽는다", () => {
  const all = steps();
  const decision = all.findIndex(({ name }) => name === "Decide whether derivative rebinding may run");
  const rebind = all.findIndex(({ name }) => name === "Rebind derivative artifacts from the current ledger heads");
  assert.ok(decision !== -1 && decision < rebind);
  const { block } = all[decision];
  assert.match(block, /\n        id: decision\n/u);
  assert.match(block, /gh pr list --repo "\$\{GITHUB_REPOSITORY\}" --state all --limit 1000 --json number,state,isDraft,headRefName,baseRefName,headRepository,isCrossRepository > /u);
  assert.match(block, /git ls-remote --heads origin "refs\/heads\/automation\/969-derivative-rebinding-\*" > /u);
  assert.match(block, /node tools\/ci\/decide-derivative-rebinding\.mjs --repository "\$\{GITHUB_REPOSITORY\}" --prs "[^"]+" --branches "[^"]+" --github-output "\$\{GITHUB_OUTPUT\}"/u);
});

test("controller는 RUN일 때만 돌고 OCI 읽기 주소는 시크릿에서만 받으며, 바뀐 것이 없으면 이유를 notice로 남긴다", () => {
  const rebind = step("Rebind derivative artifacts from the current ledger heads");
  assert.equal(ifCondition(rebind.block), RUN);
  assert.match(rebind.block, /\n        id: rebind\n/u);
  assert.match(rebind.block, /EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: \$\{\{ secrets\.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL \}\}/u);
  assert.match(rebind.block, /node tools\/datapack\/run-derivative-rebinding\.mjs --operation-root "\$\{RUNNER_TEMP\}\/derivative-rebinding\/\$\{GITHUB_RUN_ID\}\/operation" > "\$\{RUNNER_TEMP\}\/derivative-rebinding\/\$\{GITHUB_RUN_ID\}\/result\.json"/u);
  assert.match(rebind.block, /git config user\.name "github-actions\[bot\]"/u);
  assert.match(rebind.block, /changed=/u);
  const note = step("Note derivative bindings are already current");
  assert.equal(ifCondition(note.block), "${{ steps.decision.outputs.state == 'RUN' && steps.rebind.outputs.changed == 'false' }}");
});

test("push·App 토큰·PR 생성·정리는 바뀐 것이 있을 때만 돌고 push는 GITHUB_TOKEN, PR 생성만 App 토큰이다", () => {
  for (const name of ["Verify the rebinding is based on the current main and push its branch", "Mint App token for the derivative rebinding pull request", "Create derivative rebinding pull request"]) {
    assert.equal(ifCondition(step(name).block), CHANGED, name);
  }
  const push = step("Verify the rebinding is based on the current main and push its branch");
  assert.match(push.block, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(push.block, /branch="automation\/969-derivative-rebinding-\$\{GITHUB_RUN_ID\}"/u);
  assert.match(push.block, /git push origin "\$\{branch\}"/u);
  assert.match(push.block, /main moved/u);
  assert.doesNotMatch(push.block, /git add/u);
  const pr = step("Create derivative rebinding pull request");
  assert.match(pr.block, /GH_TOKEN="\$\{APP_PR_TOKEN\}" gh pr create --repo "\$\{GITHUB_REPOSITORY\}" --draft --base main --head "\$\{REBINDING_BRANCH\}"/u);
  assert.match(pr.block, /node tools\/ci\/automation-pr-evidence\.mjs derivative-rebinding-body --result /u);
  assert.match(pr.block, /APP_PR_TOKEN: \$\{\{ steps\.app-token-pr\.outputs\.token \}\}/u);
  const cleanup = step("Remove the rebinding branch after a later failure");
  assert.equal(ifCondition(cleanup.block), "${{ failure() && env.REBINDING_BRANCH != '' }}");
});

test("OPEN_PR이면 App 토큰 → required CI 보장 → 열린 PR 상한 검사 순서로 돈다", () => {
  const all = steps();
  const index = (name) => all.findIndex((item) => item.name === name);
  const token = index("Mint App token for the open refresh pull request");
  const ensure = index("Ensure required CI on the open refresh pull request");
  const age = index("Enforce open refresh pull request age limit");
  assert.ok(index("Decide whether derivative rebinding may run") < token && token < ensure && ensure < age);
  for (const item of [token, ensure, age]) assert.equal(ifCondition(all[item].block), "${{ steps.decision.outputs.state == 'OPEN_PR' }}");
  assert.match(all[ensure].block, /node tools\/ci\/refresh-pr-required-ci\.mjs --workflow source-derivative-rebinding\.yml --repository "\$\{GITHUB_REPOSITORY\}" --github-output "\$\{GITHUB_OUTPUT\}"/u);
  assert.match(all[age].block, /node tools\/ci\/refresh-open-pr-age\.mjs --workflow source-derivative-rebinding\.yml --prs "\$\{open_prs\}" --policy release\/product-gates\/datapack-freshness-sla\.json --repository "\$\{GITHUB_REPOSITORY\}" --ci-state "\$\{\{ steps\.required-ci\.outputs\.state \}\}"/u);
});

test("원장 쓰기 PR 때문에 기다리는 실행은 이유를 notice로 남기고, 실패 보고가 마지막 step이다", () => {
  const wait = step("Note derivative rebinding waiting on a pending source pull request");
  assert.equal(ifCondition(wait.block), "${{ steps.decision.outputs.state == 'BLOCKED_BY_PENDING_PR' }}");
  assert.match(wait.block, /steps\.decision\.outputs\.blocked_by/u);
  const report = step("Report refresh failure as an issue");
  assert.equal(ifCondition(report.block), "${{ failure() }}");
  assert.ok(report.block.includes('node tools/ci/report-refresh-failure.mjs --workflow source-derivative-rebinding.yml --repository "${GITHUB_REPOSITORY}" --run-id "${GITHUB_RUN_ID}"'));
  assert.equal(yml.trimEnd().endsWith(report.block.trimEnd()), true);
});
