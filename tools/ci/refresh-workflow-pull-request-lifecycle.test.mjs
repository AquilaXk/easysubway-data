import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createsPullRequest, scanPullRequestCreators } from "./pull-request-creation-scan.mjs";
import { REFRESH_CLAIM_PREFIXES } from "./refresh-open-pr-age.mjs";

// 단독 운영 수명 계약: 자동 갱신·등록·승격·재결속·후보 workflow는 PR·App 토큰·이슈 없이 main에 직접 push한다.
const root = path.resolve(import.meta.dirname, "../..");
const REFRESH_WORKFLOWS = Object.keys(REFRESH_CLAIM_PREFIXES);
const CANDIDATE_WORKFLOW = "nationwide-candidate-refresh.yml";
const REPORT_FAILURE_SUFFIX = "Report refresh failure summary";

function workflowText(file) {
  return readFileSync(path.join(root, ".github/workflows", file), "utf8");
}

function steps(yml) {
  return yml.split("\n      - name: ").slice(1).map((block) => ({ name: block.split("\n")[0], block }));
}

function ifCondition(block) {
  return /\n        if: (\$\{\{[^\n]*\}\})/u.exec(block)?.[1] ?? null;
}

test("단독 운영 갱신 workflow들은 PR 생성·App 토큰·이슈 쓰기 권한을 갖지 않는다", () => {
  for (const file of REFRESH_WORKFLOWS) {
    const yml = workflowText(file);
    assert.doesNotMatch(yml, /pull-requests:\s*write|issues:\s*write/u, file);
    assert.doesNotMatch(yml, /create-github-app-token|EASYSUBWAY_RELEASE_APP_/u, file);
    assert.doesNotMatch(yml, /gh pr create|gh issue (create|comment|close)/u, file);
    if (file !== CANDIDATE_WORKFLOW) {
      assert.doesNotMatch(yml, /gh workflow run|\/dispatches|repository_dispatch/u, file);
      assert.doesNotMatch(yml, /actions: write/u, file);
    } else {
      assert.match(yml, /actions: write/u, file);
      assert.match(yml, /gh workflow run datapack-release-candidate-chain\.yml/u, file);
    }
  }
});

test("PR을 만드는 파일은 .github/workflows와 .github/actions 전체에 존재하지 않는다", () => {
  assert.deepEqual(scanPullRequestCreators(root), []);
});

test("composite action과 그 스크립트의 PR 생성도 목록 밖이면 잡는다", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "pr-creation-scan-"));
  try {
    const write = (relative, text) => { const file = path.join(fixture, relative); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
    write(".github/workflows/ok.yml", "run: gh pr create\n");
    write(".github/workflows/quiet.yml", "run: gh pr view 1\n");
    write(".github/actions/zz/action.yml", "runs:\n  using: composite\n  steps:\n    - run: gh  pr create\n      shell: bash\n");
    write(".github/actions/zz/open.sh", "gh api repos/x/y/pulls -X POST -f title=t\n");
    write(".github/actions/zz/note.md", "gh pr view 1\n");
    write(".github/workflows/nested/deep.yml", "run: gh pr create\n");
    assert.deepEqual(scanPullRequestCreators(fixture), [
      ".github/actions/zz/action.yml", ".github/actions/zz/open.sh", ".github/workflows/nested/deep.yml", ".github/workflows/ok.yml",
    ]);
    assert.deepEqual(scanPullRequestCreators(path.join(fixture, "missing")), []);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

// 탐지는 철자가 아니라 동작을 본다. 공백·탭·줄 이음(\)으로 갈라 쓴 gh pr create와 gh api로 pulls를 만드는 호출도 PR 생성이다.
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

test("모든 갱신 workflow의 마지막 step은 Report refresh failure summary다", () => {
  for (const file of REFRESH_WORKFLOWS) {
    const all = steps(workflowText(file));
    const report = all.findIndex(({ name }) => name.endsWith(REPORT_FAILURE_SUFFIX));
    assert.equal(report, all.length - 1, `${file}: failure summary must be last`);
    const singleFailedOrCancelled = ["current-capital-topology-registration.yml", "source-derivative-rebinding.yml", "itx-current-promotion.yml", "nationwide-candidate-refresh.yml"];
    const failedOrCancelled = singleFailedOrCancelled.includes(file) ? "${{ failure() || cancelled() }}" : "${{ failure() }}";
    const reportCondition = { "source-reverification.yml": "${{ failure() || cancelled() || steps.decision.outputs.overdue_recipes != '' }}" }[file] ?? failedOrCancelled;
    assert.equal(ifCondition(all[report].block), reportCondition, file);
  }
});
