import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { REFRESH_CLAIM_PREFIXES } from "./refresh-open-pr-age.mjs";

// #939: 원천 갱신 workflow 4종의 PR 수명 계약.
// 1) GITHUB_TOKEN으로 만든 PR에는 pull_request CI가 붙지 않고 action_required로 멈춘다(#936·#937 실측).
//    그래서 PR을 만든 같은 step에서 그 브랜치로 ci.yml을 dispatch한다(workflow_dispatch는 GITHUB_TOKEN으로도 실행된다).
//    App 권한을 늘리지 않는다. job 권한 actions: write만 쓴다(nationwide-candidate-refresh와 같은 방식).
// 2) OPEN_PR 판단에는 상한 검사를 붙인다. 상한을 넘기면 실패하고, failure() 단계의 report-refresh-failure가 이슈로 드러낸다.
const root = path.resolve(import.meta.dirname, "../..");
const WORKFLOWS = Object.keys(REFRESH_CLAIM_PREFIXES);

function workflowText(file) {
  return readFileSync(path.join(root, ".github/workflows", file), "utf8");
}

function steps(yml) {
  return yml.split("\n      - name: ").slice(1).map((block) => ({ name: block.split("\n")[0], block }));
}

function ifCondition(block) {
  return /\n        if: (\$\{\{[^\n]*\}\})/u.exec(block)?.[1] ?? null;
}

test("갱신 workflow 4종은 job에 actions: write 권한을 둔다(ci.yml dispatch)", () => {
  for (const file of WORKFLOWS) {
    const yml = workflowText(file);
    assert.match(yml, /\n    permissions:\n(?:      [a-z-]+: (?:read|write)\n)*      actions: write\n/u, file);
    assert.doesNotMatch(yml, /actions: read/u, file);
    assert.doesNotMatch(yml, /create-github-app-token|EASYSUBWAY_RELEASE_APP_/u, file);
  }
});

test("갱신 PR을 만드는 step은 모두 같은 step에서 그 브랜치로 required CI(ci.yml)를 dispatch한다", () => {
  for (const file of WORKFLOWS) {
    const creators = steps(workflowText(file)).filter(({ block }) => block.includes("gh pr create"));
    assert.equal(creators.length, 2, `${file}: recover and final PR creation paths`);
    for (const { name, block } of creators) {
      const head = /gh pr create [^\n]*--head "(\$\{[A-Za-z_]+\})"/u.exec(block)?.[1];
      assert.ok(head, `${file} ${name}: PR head branch variable`);
      const createAt = block.indexOf("gh pr create");
      const dispatch = block.indexOf(`gh workflow run ci.yml --repo "\${GITHUB_REPOSITORY}" --ref "${head}"`);
      assert.ok(dispatch > createAt, `${file} ${name}: ci.yml dispatch after PR creation on ${head}`);
      assert.match(block, /GH_TOKEN: \$\{\{ github\.token \}\}/u, `${file} ${name}`);
    }
  }
});

test("OPEN_PR 판단 뒤 열린 갱신 PR 상한 검사를 실행하고, 실패 보고 단계가 그 뒤에 있다", () => {
  for (const file of WORKFLOWS) {
    const all = steps(workflowText(file));
    const index = all.findIndex(({ name }) => name.endsWith("Enforce open refresh pull request age limit"));
    assert.notEqual(index, -1, file);
    const { block } = all[index];
    assert.equal(ifCondition(block), "${{ steps.decision.outputs.state == 'OPEN_PR' }}", file);
    assert.match(block, /GH_TOKEN: \$\{\{ github\.token \}\}/u, file);
    assert.match(block, /gh pr list --repo "\$\{GITHUB_REPOSITORY\}" --state open --base main --limit 1000 --json number,url,createdAt,headRefName,baseRefName,isCrossRepository > "\$\{open_prs\}"/u, file);
    assert.match(block, new RegExp(`node tools/ci/refresh-open-pr-age\\.mjs --workflow ${file.replaceAll(".", "\\.")} --prs "\\$\\{open_prs\\}" --policy release/product-gates/datapack-freshness-sla\\.json --repository "\\$\\{GITHUB_REPOSITORY\\}"`, "u"), file);
    const decision = all.findIndex(({ block: text }) => /\n        id: decision\n/u.test(text));
    assert.ok(decision !== -1 && decision < index, `${file}: age check runs after the decision`);
    const report = all.findIndex(({ name }) => name.endsWith("Report refresh failure as an issue"));
    assert.ok(report > index, `${file}: failure report runs after the age check`);
    assert.equal(ifCondition(all[report].block), "${{ failure() }}", file);
  }
});

// #947 리뷰 F1: actions: write로는 어떤 workflow든 dispatch할 수 있다. 갱신 workflow 4종 모두에서
// dispatch는 갱신 PR 브랜치의 ci.yml뿐이고, 정해진 횟수만 있는지 고정한다.
export const EXPECTED_CI_DISPATCHES = 2;

test("갱신 workflow 4종의 workflow dispatch는 모두 ci.yml이고 정해진 횟수뿐이다", () => {
  for (const file of WORKFLOWS) {
    const yml = workflowText(file);
    const dispatches = [...yml.matchAll(/gh workflow run[^\n]*/gu)].map(([line]) => line);
    assert.equal(dispatches.length, EXPECTED_CI_DISPATCHES, `${file}: ${dispatches.join(" | ")}`);
    for (const line of dispatches) {
      assert.match(line, /^gh workflow run ci\.yml --repo "\$\{GITHUB_REPOSITORY\}" --ref "\$\{[A-Za-z_]+\}"$/u, `${file}: ${line}`);
    }
    assert.doesNotMatch(yml, /\/actions\/workflows\/[^\n]*\/dispatches|repository_dispatch|gh api[^\n]*dispatches/u, file);
  }
});
