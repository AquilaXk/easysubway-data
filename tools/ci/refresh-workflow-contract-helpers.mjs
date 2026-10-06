// 자동화 workflow 계약 테스트의 공통 도구(#969). 등록·후보·재결속 workflow 테스트가 같은 step 파서와
// OPEN_PR 처리·실패 보고 검증을 쓴다. 테스트 파일이 아니라 도구라서 *.test.mjs가 아니다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

export const ifCondition = (block) => /\n        if: (\$\{\{[^\n]*\}\})/u.exec(block)?.[1] ?? null;
export const OPEN_PR_CONDITION = "${{ steps.decision.outputs.state == 'OPEN_PR' }}";

export function loadWorkflow(root, file) {
  const yml = readFileSync(path.join(root, ".github/workflows", file), "utf8");
  const steps = () => yml.split("\n      - name: ").slice(1).map((block) => ({ name: block.split("\n")[0], block }));
  const step = (name) => {
    const found = steps().filter((item) => item.name === name);
    assert.equal(found.length, 1, `step ${name}`);
    return found[0];
  };
  return { yml, steps, step };
}

/** OPEN_PR이면 App 토큰 → required CI 보장 → 열린 PR 상한 검사 순서로 돌고 모두 OPEN_PR 조건이다. */
export function assertOpenPullRequestSteps({ steps, file, decisionName }) {
  const all = steps();
  const index = (name) => all.findIndex((item) => item.name === name);
  const token = index("Mint App token for the open refresh pull request");
  const ensure = index("Ensure required CI on the open refresh pull request");
  const age = index("Enforce open refresh pull request age limit");
  assert.ok(index(decisionName) !== -1 && index(decisionName) < token && token < ensure && ensure < age, `${file}: step order`);
  for (const item of [token, ensure, age]) assert.equal(ifCondition(all[item].block), OPEN_PR_CONDITION, `${file}: ${all[item].name}`);
  const escaped = file.replaceAll(".", String.raw`\.`);
  assert.match(all[ensure].block, new RegExp(String.raw`node tools/ci/refresh-pr-required-ci\.mjs --workflow ${escaped} --repository "\$\{GITHUB_REPOSITORY\}" --github-output "\$\{GITHUB_OUTPUT\}"`, "u"));
  assert.match(all[age].block, new RegExp(String.raw`node tools/ci/refresh-open-pr-age\.mjs --workflow ${escaped} --prs "\$\{open_prs\}" --policy release/product-gates/datapack-freshness-sla\.json --repository "\$\{GITHUB_REPOSITORY\}" --ci-state "\$\{\{ steps\.required-ci\.outputs\.state \}\}"`, "u"));
}

/** 실패 보고 step이 failure()일 때만 자기 workflow 이름으로 돌고 마지막 step이다. */
export function assertFailureReportLast({ yml, step, file }) {
  const report = step("Report refresh failure as an issue");
  assert.equal(ifCondition(report.block), "${{ failure() }}");
  assert.ok(report.block.includes(`node tools/ci/report-refresh-failure.mjs --workflow ${file} --repository "\${GITHUB_REPOSITORY}" --run-id "\${GITHUB_RUN_ID}"`));
  assert.equal(yml.trimEnd().endsWith(report.block.trimEnd()), true);
  return report;
}
