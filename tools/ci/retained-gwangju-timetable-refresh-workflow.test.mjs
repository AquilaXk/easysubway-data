import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { ifCondition, loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";

// #995: 광주 보관 시간표 갱신 workflow가 PR 없는 claim(고아)을 DUE·CURRENT와 무관하게 판정하고, 정리 대상은 보고한 뒤 지운다.
// 504 사례(run 37399282636): 수집 step이 실패해 빈 claim이 남았고, CURRENT 판정이 claim을 보지 않아 다른 원장 쓰기 자동화가 계속 대기했다.
const FILE = "retained-gwangju-timetable-refresh.yml";
const { yml, steps, step } = loadWorkflow(path.resolve(import.meta.dirname, "../.."), FILE);
const names = () => steps().map(({ name }) => name);
const before = (earlier, later) => assert.ok(names().indexOf(earlier) !== -1 && names().indexOf(earlier) < names().indexOf(later), `${earlier} -> ${later}`);
const scriptOf = (block) => block.split("\n        run: ")[1] ?? "";

test("run 조회에 actions 읽기 권한이 필요하다. 쓰기 권한은 늘리지 않는다", () => {
  assert.match(yml, /\npermissions: \{\}\n/u);
  assert.match(yml, /\n    permissions:\n      actions: read\n      contents: write\n      pull-requests: write\n      issues: write\n/u);
  assert.doesNotMatch(yml, /actions: write|gh workflow run|repository_dispatch/u);
});

test("판정 step이 claim 증거(run 상태·claim 뒤 커밋)를 모아 판정에 넘기고 정리 대상을 출력한다", () => {
  const { block } = step("Read retained timetable due state");
  const collect = block.indexOf("node tools/ci/collect-automation-prs.mjs");
  const evidence = block.indexOf('node tools/ci/claim-orphans.mjs --workflow retained-gwangju-timetable-refresh.yml --repository "${GITHUB_REPOSITORY}" --refs "${state_root}/claims.txt" --prs "${state_root}/prs.json" --output "${state_root}/claim-evidence.json"');
  assert.ok(collect !== -1 && evidence > collect, "증거는 PR 목록을 받은 뒤에 모은다");
  assert.ok(block.indexOf("classifyRetainedGwangjuRefreshDelivery") > evidence);
  assert.match(block, /claimEvidence: JSON\.parse\(await readFile\(root \+ "\/claim-evidence\.json", "utf8"\)\)/u);
  assert.match(block, /\\ncleanup_claims=" \+ result\.cleanupClaims\.join\(","\) \+ "\\n"/u);
  // 끝난 run 이력은 쌓이므로 목록으로 받지 않는다(#987 리뷰 F1·#994). claim마다 gh run view 한 번은 claim-orphans가 한다.
  assert.doesNotMatch(block, /gh run list/u);
  assert.match(block, /\n        env:\n          GH_TOKEN: \$\{\{ github\.token \}\}\n/u);
});

test("정리 대상 claim은 보고한 뒤 지우고, 그 일은 복구·새 claim보다 먼저다", () => {
  const cleanup = step("Remove abandoned retained timetable claims named by the decision");
  assert.equal(ifCondition(cleanup.block), "${{ steps.decision.outputs.cleanup_claims != '' }}");
  assert.match(cleanup.block, /\n          GH_TOKEN: \$\{\{ github\.token \}\}\n/u);
  assert.match(cleanup.block, /\n          CLEANUP_CLAIMS: \$\{\{ steps\.decision\.outputs\.cleanup_claims \}\}\n/u);
  const script = scriptOf(cleanup.block);
  assert.doesNotMatch(script, /\$\{\{/u, "표현식은 env로 받는다");
  assert.match(script, /gh auth setup-git\n/u);
  assert.match(script, /node tools\/ci\/remove-orphan-claims\.mjs --workflow retained-gwangju-timetable-refresh\.yml --repository "\$\{GITHUB_REPOSITORY\}" --claims "\$\{CLEANUP_CLAIMS\}" --refs "\$\{RETAINED_GWANGJU_STATE_ROOT\}\/claims\.txt"/u);
  assert.doesNotMatch(script, /git push origin --delete/u, "삭제는 보고 뒤에 도구가 한다. 셸이 직접 지우지 않는다");
  before("Read retained timetable due state", cleanup.name);
  before(cleanup.name, "Recover completed retained timetable claim");
  before(cleanup.name, "Create retained timetable claim before provider access");
});

test("만든 run이 아직 도는 claim은 notice로 기다린다", () => {
  const running = step("Note retained timetable refresh waiting on a running producer");
  assert.equal(ifCondition(running.block), "${{ steps.decision.outputs.state == 'CLAIM_IN_PROGRESS' }}");
  assert.match(running.block, /\n          CLAIM_BRANCH: \$\{\{ steps\.decision\.outputs\.branch \}\}\n/u);
  assert.doesNotMatch(scriptOf(running.block), /\$\{\{/u);
  assert.match(scriptOf(running.block), /::notice title=Retained Gwangju timetable refresh::the run that created \$\{CLAIM_BRANCH\} is still running; waiting for it to finish\./u);
});

test("복구·claim·수집·PR step은 판정 state로만 열린다. CURRENT에서는 아무 쓰기도 하지 않는다", () => {
  const states = new Map([
    ["Recover completed retained timetable claim", "RECOVER_CLAIM"],
    ["Create retained timetable claim before provider access", "DUE"],
    ["Collect due retained Gwangju timetable", "DUE"],
    ["Publish and register retained Gwangju timetable", "DUE"],
    ["Finalize retained timetable claim", "DUE"],
    ["Create retained timetable draft pull request", "DUE"],
  ]);
  for (const [name, state] of states) assert.equal(ifCondition(step(name).block), `\${{ steps.decision.outputs.state == '${state}' }}`, name);
});

test("실패 보고는 마지막 step이고 이 workflow 이름으로 돈다", () => {
  const report = step("Report refresh failure as an issue");
  assert.equal(ifCondition(report.block), "${{ failure() }}");
  assert.ok(report.block.includes('node tools/ci/report-refresh-failure.mjs --workflow retained-gwangju-timetable-refresh.yml --repository "${GITHUB_REPOSITORY}" --run-id "${GITHUB_RUN_ID}"'));
  assert.equal(yml.trimEnd().endsWith(report.block.trimEnd()), true);
});

// #995 F1: claim 정리는 만든 run이 게시 step까지 갔는지로 판정한다. 수집과 게시가 한 step이면 수집 실패도 게시 가능성으로 보이므로 step을 나눈다.
test("수집과 게시·등록은 서로 다른 step이고 게시 step은 수집 step 뒤에서 같은 operation root를 쓴다", () => {
  const collect = step("Collect due retained Gwangju timetable");
  const publish = step("Publish and register retained Gwangju timetable");
  const operation = '--operation-root "${RUNNER_TEMP}/retained-gwangju-timetable-refresh/${GITHUB_RUN_ID}/operation"';
  assert.match(scriptOf(collect.block), new RegExp(`run-retained-gwangju-timetable-refresh\\.mjs ${operation.replaceAll("$", "\\$").replaceAll("{", "\\{").replaceAll("}", "\\}")} --phase collect`, "u"));
  assert.match(scriptOf(publish.block), new RegExp(`run-retained-gwangju-timetable-refresh\\.mjs ${operation.replaceAll("$", "\\$").replaceAll("{", "\\{").replaceAll("}", "\\}")} --phase publish`, "u"));
  for (const item of [collect, publish]) {
    assert.match(item.block, /DATA_GO_KR_SERVICE_KEY: \$\{\{ secrets\.DATA_GO_KR_SERVICE_KEY \}\}/u);
    assert.match(item.block, /EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: \$\{\{ secrets\.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL \}\}/u);
    assert.match(scriptOf(item.block), /\[\[ "\$\(git rev-parse HEAD\)" == "\$\{RETAINED_GWANGJU_MAIN_SHA\}" \]\]/u);
  }
  before("Create retained timetable claim before provider access", collect.name);
  before(collect.name, publish.name);
  before(publish.name, "Finalize retained timetable claim");
  assert.equal(names().includes("Refresh due retained Gwangju timetable"), false);
});
