import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { createsPullRequest } from "./pull-request-creation-scan.mjs";
import { REFRESH_CLAIM_PREFIXES } from "./refresh-open-pr-age.mjs";

// #939: 자동 갱신 PR의 수명 계약.
// 1) GITHUB_TOKEN으로 만든 PR의 pull_request CI는 action_required로 멈춘다(#936·#937).
//    workflow_dispatch로 돌린 CI는 head 커밋에 check run이 붙어도 PR required check로 인정되지 않는다(#948 실험: BLOCKED).
//    그래서 갱신 PR은 App(easysubway-release-chain) 설치 토큰으로 연다. App이 연 PR의 pull_request CI가 required check가 된다.
//    브랜치 push는 지금처럼 GITHUB_TOKEN으로 한다. App 토큰은 easysubway-data·pull_requests: write로만 받는다.
// 2) OPEN_PR이면 head에 pull_request CI가 없을 때 App으로 그 PR만 닫았다 다시 열고(F2), 열린 PR 상한을 검사한다.
const root = path.resolve(import.meta.dirname, "../..");
const REFRESH_WORKFLOWS = Object.keys(REFRESH_CLAIM_PREFIXES);
const CANDIDATE_WORKFLOW = "nationwide-candidate-refresh.yml";
// #967: 등록 workflow도 같은 계약을 따른다. PR 생성 지점이 하나인 workflow는 후보 갱신과 등록 둘이다.
const REGISTRATION_WORKFLOW = "current-capital-topology-registration.yml";
const SINGLE_PR_PATH_WORKFLOWS = [CANDIDATE_WORKFLOW, REGISTRATION_WORKFLOW];
const PR_WORKFLOWS = [...REFRESH_WORKFLOWS, CANDIDATE_WORKFLOW, REGISTRATION_WORKFLOW];
const APP_TOKEN_ACTION = "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1";

function workflowText(file) {
  return readFileSync(path.join(root, ".github/workflows", file), "utf8");
}

function steps(yml) {
  return yml.split("\n      - name: ").slice(1).map((block) => ({ name: block.split("\n")[0], block }));
}

function ifCondition(block) {
  return /\n        if: (\$\{\{[^\n]*\}\})/u.exec(block)?.[1] ?? null;
}

function stepId(block) {
  return /\n        id: ([a-z0-9-]+)\n/u.exec(block)?.[1] ?? null;
}

function assertAppTokenStep(file, block) {
  assert.ok(block.includes(`uses: ${APP_TOKEN_ACTION}`), `${file}: pinned create-github-app-token`);
  assert.match(block, /\n          client-id: \$\{\{ secrets\.EASYSUBWAY_RELEASE_APP_CLIENT_ID \}\}\n/u, file);
  assert.match(block, /\n          private-key: \$\{\{ secrets\.EASYSUBWAY_RELEASE_APP_PRIVATE_KEY \}\}\n/u, file);
  assert.match(block, /\n          owner: AquilaXk\n          repositories: easysubway-data\n          permission-pull-requests: write(?:\n|$)/u, file);
  assert.doesNotMatch(block, /permission-(contents|actions|workflows|issues)/u, file);
}

test("PR을 만드는 workflow 전부는 workflow dispatch를 쓰지 않는다", () => {
  for (const file of PR_WORKFLOWS) {
    const yml = workflowText(file);
    assert.doesNotMatch(yml, /gh workflow run|\/dispatches|repository_dispatch/u, file);
    assert.doesNotMatch(yml, /actions: write/u, file);
  }
});

test("갱신 PR은 바로 앞 step에서 같은 조건으로 받은 App 토큰으로만 연다", () => {
  for (const file of PR_WORKFLOWS) {
    const all = steps(workflowText(file));
    const creators = all.map((item, index) => ({ ...item, index })).filter(({ block }) => createsPullRequest(block));
    assert.equal(creators.length, SINGLE_PR_PATH_WORKFLOWS.includes(file) ? 1 : 2, `${file}: PR creation paths`);
    for (const { name, block, index } of creators) {
      const commands = [...block.matchAll(/^\s*(.*gh pr create.*)$/gmu)].map(([, line]) => line.trim());
      assert.ok(commands.length === 1, `${file} ${name}`);
      assert.match(commands[0], /^(pr_url="\$\()?GH_TOKEN="\$\{APP_PR_TOKEN\}" gh pr create /u, `${file} ${name}`);
      const tokenStep = all[index - 1];
      const id = stepId(tokenStep.block);
      assert.ok(id, `${file} ${name}: App token step id`);
      assertAppTokenStep(file, tokenStep.block);
      assert.equal(ifCondition(tokenStep.block), ifCondition(block), `${file} ${name}: same condition`);
      assert.match(block, new RegExp(`\\n          APP_PR_TOKEN: \\$\\{\\{ steps\\.${id}\\.outputs\\.token \\}\\}\\n`, "u"), `${file} ${name}`);
    }
  }
});

// #967: 새 workflow가 GITHUB_TOKEN으로 PR을 열면 pull_request CI가 action_required로 멈춘다. 목록 밖 workflow의 gh pr create는 여기서 막는다.
test(".github/workflows에서 gh pr create를 쓰는 파일은 이 계약이 검사하는 목록과 정확히 같다", () => {
  const directory = path.join(root, ".github/workflows");
  const creators = readdirSync(directory).filter((file) => /\.ya?ml$/u.test(file)
    && createsPullRequest(readFileSync(path.join(directory, file), "utf8"))).sort();
  assert.deepEqual(creators, [...PR_WORKFLOWS].sort());
});

// #968 리뷰 F1: 탐지는 철자가 아니라 동작을 본다. 공백·탭·줄 이음(\)으로 갈라 쓴 gh pr create와 gh api로 pulls를 만드는 호출도 PR 생성이다.
test("PR 생성 탐지는 공백·줄 이음·gh api POST 우회를 잡고 읽기 호출은 잡지 않는다", () => {
  const creates = [
    "gh pr create --draft",
    "gh  pr create --draft",
    "gh\tpr\tcreate",
    "gh pr \\\n  create --draft",
    "gh \\\n  pr \\\n  create",
    'GH_TOKEN="${T}" gh pr create --repo x',
    'gh api repos/x/y/pulls -X POST -f title=t',
    'gh api --method POST repos/x/y/pulls',
    'gh api -X=POST "repos/${GITHUB_REPOSITORY}/pulls"',
    'gh api repos/x/y/pulls -f title=t -f head=h -f base=main',
    'gh api repos/x/y/pulls \\\n  --method POST \\\n  --input body.json',
    'gh api "repos/$REPO/pulls" --field title=t',
  ];
  for (const text of creates) assert.equal(createsPullRequest(text), true, JSON.stringify(text));
  const reads = [
    "gh pr view 12 --json state",
    "gh pr list --state open",
    "gh pr close 12 --comment x",
    'gh api "repos/AquilaXk/easysubway-backend/pulls/${BACKEND_PR}"',
    "gh api repos/x/y/pulls --method GET -f state=open",
    "gh api repos/x/y/pulls?state=open",
    "gh api repos/x/y/pulls/12/comments",
    "echo gh pr",
    "",
  ];
  for (const text of reads) assert.equal(createsPullRequest(text), false, JSON.stringify(text));
});

test("OPEN_PR이면 App 토큰 발급 → required CI 보장(close→reopen) → 열린 PR 상한 검사 순서로 돌고, 실패 보고가 뒤에 있다", () => {
  for (const file of REFRESH_WORKFLOWS) {
    const all = steps(workflowText(file));
    const find = (suffix) => all.findIndex(({ name }) => name.endsWith(suffix));
    const token = find("Mint App token for the open refresh pull request");
    const ensure = find("Ensure required CI on the open refresh pull request");
    const age = find("Enforce open refresh pull request age limit");
    const decision = all.findIndex(({ block }) => stepId(block) === "decision");
    assert.ok(decision !== -1 && decision < token && token < ensure && ensure < age, `${file}: ${decision} ${token} ${ensure} ${age}`);
    const open = "${{ steps.decision.outputs.state == 'OPEN_PR' }}";
    for (const index of [token, ensure, age]) assert.equal(ifCondition(all[index].block), open, `${file}: ${all[index].name}`);
    assertAppTokenStep(file, all[token].block);
    const tokenId = stepId(all[token].block);
    const ensureBlock = all[ensure].block;
    assert.equal(stepId(ensureBlock), "required-ci", file);
    assert.match(ensureBlock, /\n          GH_TOKEN: \$\{\{ github\.token \}\}\n/u, file);
    assert.match(ensureBlock, new RegExp(`\\n          APP_PR_TOKEN: \\$\\{\\{ steps\\.${tokenId}\\.outputs\\.token \\}\\}\\n`, "u"), file);
    assert.match(ensureBlock, new RegExp(`node tools/ci/refresh-pr-required-ci\\.mjs --workflow ${file.replaceAll(".", "\\.")} --repository "\\$\\{GITHUB_REPOSITORY\\}" --github-output "\\$\\{GITHUB_OUTPUT\\}"`, "u"), file);
    const ageBlock = all[age].block;
    assert.match(ageBlock, /GH_TOKEN: \$\{\{ github\.token \}\}/u, file);
    assert.match(ageBlock, /gh pr list --repo "\$\{GITHUB_REPOSITORY\}" --state open --base main --limit 1000 --json number,url,createdAt,headRefName,baseRefName,isCrossRepository > "\$\{open_prs\}"/u, file);
    assert.match(ageBlock, new RegExp(`node tools/ci/refresh-open-pr-age\\.mjs --workflow ${file.replaceAll(".", "\\.")} --prs "\\$\\{open_prs\\}" --policy release/product-gates/datapack-freshness-sla\\.json --repository "\\$\\{GITHUB_REPOSITORY\\}" --ci-state "\\$\\{\\{ steps\\.required-ci\\.outputs\\.state \\}\\}"`, "u"), file);
    const report = find("Report refresh failure as an issue");
    assert.ok(report > age, file);
    assert.equal(ifCondition(all[report].block), "${{ failure() }}", file);
  }
});
