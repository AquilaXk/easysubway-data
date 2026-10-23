import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { evaluateGithubExpression } from "./github-expression.mjs";
import { assertFailureReportLast, assertNoExpressionInRunScripts, assertOpenPullRequestSteps, ifCondition, loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";
import { SOURCE_REVERIFICATION_JOB, SOURCE_REVERIFICATION_REPLAY_SOURCE_STEPS, SOURCE_REVERIFICATION_WORKFLOW_PATH } from "./verify-source-reverification-replay-run.mjs";

// #984(#969 남은 단계 1): P7D 원천 재확인 workflow 계약. 판정(DUE)이 고른 recipe를 claim → 수집·게시·등록 → 재확인 → push → App 토큰 PR 하나로 올린다.
// 변수 DATAPACK_SCHEDULED_SOURCE_REVERIFICATION이 true일 때만 정기 실행이 돈다(기본 꺼짐). 이상은 job을 실패시켜 #926 실패 이슈로 드러난다.
const FILE = "source-reverification.yml";
const { yml, steps, step } = loadWorkflow(path.resolve(import.meta.dirname, "../.."), FILE);
const RUN = "${{ steps.decision.outputs.state == 'RUN' }}";
const CLAIMED = "${{ steps.decision.outputs.state == 'RUN' && steps.claim.outputs.claimed == 'true' }}";
const REGISTERED = "${{ steps.decision.outputs.state == 'RUN' && steps.claim.outputs.claimed == 'true' && steps.reverify.outputs.registered != '0' }}";
const REPLAYING = "${{ steps.decision.outputs.state == 'RUN' && steps.claim.outputs.claimed == 'true' && steps.decision.outputs.replay_run_id != '' }}";
const IDLE = "${{ steps.decision.outputs.state == 'RUN' && steps.claim.outputs.claimed == 'true' && steps.recheck.outputs.idle == 'true' }}";
const PUSHED = "${{ steps.decision.outputs.state == 'RUN' && steps.claim.outputs.claimed == 'true' && steps.recheck.outputs.idle == 'true' && steps.push.outputs.pushed == 'true' }}";
const names = () => steps().map(({ name }) => name);
const before = (earlier, later) => assert.ok(names().indexOf(earlier) !== -1 && names().indexOf(earlier) < names().indexOf(later), `${earlier} -> ${later}`);

test("트리거: 2시간마다 정기 실행과 사람 dispatch뿐이고 push·workflow_run 트리거는 없다", () => {
  assert.match(yml, /^on:\n  schedule:\n    - cron: "23 \*\/2 \* \* \*"\n  workflow_dispatch:\n/mu);
  assert.doesNotMatch(yml, /\n  push:|\n  workflow_run:|\n  pull_request/u);
});

test("권한은 job에만 주고, 변수가 true일 때만 정기 실행이 돌며(기본 꺼짐), 시간 상한이 있다", () => {
  assert.match(yml, /\npermissions: \{\}\n/u);
  assert.equal((yml.match(/\n    permissions:\n/gu) ?? []).length, 1);
  assert.match(yml, /\n    permissions:\n      actions: read\n      contents: write\n      pull-requests: write\n      issues: write\n/u);
  assert.doesNotMatch(yml, /actions: write|gh workflow run|repository_dispatch/u);
  assert.match(yml, /\n    if: \$\{\{ github\.ref == 'refs\/heads\/main' && \(\(github\.event_name == 'workflow_dispatch' && github\.triggering_actor != 'easysubway-release-chain\[bot\]' && !endsWith\(github\.triggering_actor, '\[bot\]'\)\) \|\| vars\.DATAPACK_SCHEDULED_SOURCE_REVERIFICATION == 'true'\) \}\}\n/u);
  assert.match(yml, /\n    environment: datapack-release-check\n/u);
  assert.match(yml, /\n    timeout-minutes: 90\n/u);
  assert.match(yml, /\nconcurrency:\n  group: source-reverification-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n  cancel-in-progress: false\n/u);
  assert.doesNotMatch(yml, /\n  [A-Z_]+: /u, "no workflow-level env");
});

test("판정 step이 claim·수집보다 먼저 돌고 PR·run·브랜치 목록을 상한 1000·200으로 읽는다", () => {
  const { block } = step("Decide which P7D sources are due");
  assert.match(block, /\n        id: decision\n/u);
  // #993: PR 이력 전체(--state all --limit 1000)를 받지 않는다. 열린 PR 전체와 claim 브랜치별 PR만 수집기로 받는다.
  assert.match(block, /node tools\/ci\/collect-automation-prs\.mjs --repository "\$\{GITHUB_REPOSITORY\}" --refs "[^"]+" --pr-limit 1000 --output "[^"]+"/u);
  assert.doesNotMatch(block, /gh pr list[^\n]*--state all --limit/u);
  // #987 리뷰 F1: 끝난 run 이력은 쌓이므로 아직 끝나지 않은 상태별로만 조회한다(completed는 조회하지 않는다).
  assert.match(block, /for status in in_progress queued waiting pending requested; do\n\s+gh run list --repo "\$\{GITHUB_REPOSITORY\}" --workflow source-reverification\.yml --status "\$\{status\}" --limit 200 --json databaseId,status,conclusion,workflowName,headBranch,headSha > "[^"]+"\n\s+done/u);
  assert.equal((block.match(/gh run list/gu) ?? []).length, 1, "every run listing is filtered by status");
  assert.doesNotMatch(block, /--status "?completed|--status completed/u);
  assert.match(block, /jq -s 'add \| unique_by\(\.databaseId\)' "\$\{decision_root\}"\/runs\/\*\.json > "\$\{decision_root\}\/runs\.json"/u);
  assert.match(block, /git ls-remote --heads origin "refs\/heads\/automation\/\*" > /u);
  assert.match(block, /node tools\/ci\/decide-source-reverification\.mjs --inventory tools\/datapack\/source-inventory\.json --ledger tools\/datapack\/release\/source-snapshots\.json --policy release\/product-gates\/datapack-freshness-sla\.json --prs "[^"]+" --automation-branches "[^"]+" --runs "[^"]+" --issues "[^"]+" --repository "\$\{GITHUB_REPOSITORY\}" --pr-limit 1000 --run-limit 200 --issue-limit 1000 --replay-run-id "\$\{REPLAY_RUN_ID\}" --github-output "\$\{GITHUB_OUTPUT\}"/u);
  assert.match(block, /\n          REPLAY_RUN_ID: \$\{\{ inputs\.replay_run_id \}\}\n/u);
  before("Decide which P7D sources are due", "Claim exact main before provider access");
});

// #1122: 공급처 기대 관측이 바뀐 recipe는 사람이 고칠 때까지 같은 실패를 되풀이한다. 판정이 열린 실패 이슈의 표지를 읽어 건너뛰고, 보고는 controller의 실패 목록으로 표지를 남긴다.
test("판정은 열린 이슈를 상한 1000으로 읽고, 건너뛴 recipe가 있으면 경고하며, 실패 보고는 controller의 실패 목록을 넘긴다 (#1122)", () => {
  const { block } = step("Decide which P7D sources are due");
  assert.match(block, /gh issue list --repo "\$\{GITHUB_REPOSITORY\}" --state open --limit 1000 --json number,title,body,author > "[^"]+"/u);
  assert.equal((block.match(/gh issue list/gu) ?? []).length, 1);
  const warn = step("Note recipes skipped because of an open expectation-change failure issue");
  assert.equal(ifCondition(warn.block), "${{ steps.decision.outputs.blocked_recipes != '' }}");
  assert.match(warn.block, /\n          BLOCKED_RECIPES: \$\{\{ steps\.decision\.outputs\.blocked_recipes \}\}\n/u);
  assert.doesNotMatch(warn.block, /secrets\./u);
  const report = step("Report refresh failure as an issue");
  assert.match(report.block, /--run-id "\$\{GITHUB_RUN_ID\}" --failures "\$\{RUNNER_TEMP\}\/source-reverification\/\$\{GITHUB_RUN_ID\}\/operation\/failures\.json"/u);
  // controller가 쓰는 위치와 같다: --operation-root "${operation}/operation", operation="${RUNNER_TEMP}/source-reverification/${GITHUB_RUN_ID}".
  const reverify = step("Reverify due P7D sources").block;
  assert.match(reverify, /operation="\$\{RUNNER_TEMP\}\/source-reverification\/\$\{GITHUB_RUN_ID\}"/u);
  assert.match(reverify, /--operation-root "\$\{operation\}\/operation"/u);
});

test("OPEN_PR이면 App 토큰 → required CI 보장 → 열린 PR 상한 검사 순서로 돈다", () => {
  assertOpenPullRequestSteps({ steps, file: FILE, decisionName: "Decide which P7D sources are due" });
});

test("대기·할 일 없음은 이유를 notice로 남기고 아무것도 쓰지 않는다", () => {
  const blocked = step("Note reverification waiting on a pending source pull request");
  assert.equal(ifCondition(blocked.block), "${{ steps.decision.outputs.state == 'BLOCKED_BY_PENDING_PR' }}");
  assert.match(blocked.block, /\n          BLOCKED_BY: \$\{\{ steps\.decision\.outputs\.blocked_by \}\}\n/u);
  assert.match(blocked.block, /::notice title=Source reverification::/u);
  const running = step("Note reverification waiting on a running producer");
  assert.equal(ifCondition(running.block), "${{ steps.decision.outputs.state == 'CLAIM_IN_PROGRESS' }}");
  assert.match(running.block, /\n          CLAIM_BRANCH: \$\{\{ steps\.decision\.outputs\.branch \}\}\n/u);
  const idle = step("Note no P7D source is due");
  assert.equal(ifCondition(idle.block), "${{ steps.decision.outputs.state == 'NOT_DUE' }}");
});

test("판정이 알린 남은 claim은 claim·수집 전에 지운다(열린 PR이 없을 때만)", () => {
  const cleanup = step("Remove stale reverification claims named by the decision");
  assert.equal(ifCondition(cleanup.block), "${{ steps.decision.outputs.cleanup_claims != '' }}");
  assert.match(cleanup.block, /\n          CLEANUP_CLAIMS: \$\{\{ steps\.decision\.outputs\.cleanup_claims \}\}\n/u);
  // #995: 조용히 지우지 않는다. 병합된 PR의 남은 claim은 보고 없이, 끝난 run의 PR 없는 claim은 #926 실패 보고를 먼저 하고 지운다.
  assert.match(cleanup.block, /gh auth setup-git\n[\s\S]*node tools\/ci\/remove-orphan-claims\.mjs --workflow source-reverification\.yml --repository "\$\{GITHUB_REPOSITORY\}" --claims "\$\{CLEANUP_CLAIMS\}" --refs "\$\{RUNNER_TEMP\}\/source-reverification-decision\/\$\{GITHUB_RUN_ID\}\/automation-branches\.txt"/u);
  assert.doesNotMatch(cleanup.block, /git push origin --delete/u);
  before("Decide which P7D sources are due", cleanup.name);
  before(cleanup.name, "Claim exact main before provider access");
});

// 공급자·OCI에 닿기 전에 claim 브랜치(빈 커밋)를 push한다. 다른 원장 쓰기 자동화가 이 claim을 보고 기다린다(직렬화).
test("claim은 읽은 main 그대로일 때만 만들고, 빈 커밋을 push한 뒤 그 브랜치 위에서 controller가 돈다", () => {
  const { block } = step("Claim exact main before provider access");
  assert.equal(ifCondition(block), RUN);
  assert.match(block, /\n        id: claim\n/u);
  assert.match(block, /\n          GH_TOKEN: \$\{\{ github\.token \}\}\n/u);
  assert.match(block, /main_sha="\$\(git rev-parse HEAD\)"/u);
  assert.match(block, /\[\[ "\$\(git ls-remote origin refs\/heads\/main \| cut -f1\)" != "\$\{main_sha\}" \]\]/u);
  assert.match(block, /echo "claimed=false" >> "\$\{GITHUB_OUTPUT\}"/u);
  assert.match(block, /branch="automation\/984-source-reverification-\$\{GITHUB_RUN_ID\}"/u);
  // 브랜치 이름은 push 전에 정리 대상으로 기록한다(push가 도중에 끊겨도 정리 step이 확인한다).
  assert.ok(block.indexOf("REVERIFICATION_BRANCH=") < block.indexOf('git push origin "${branch}"'));
  assert.match(block, /git switch -c "\$\{branch\}"/u);
  assert.match(block, /git commit --allow-empty -m "Claim source reverification"/u);
  assert.match(block, /echo "claimed=true" >> "\$\{GITHUB_OUTPUT\}"/u);
  assert.match(block, /printf 'REVERIFICATION_BRANCH=%s\\nREVERIFICATION_MAIN_SHA=%s\\n'/u);
  assert.doesNotMatch(block, /git add/u);
  before("Claim exact main before provider access", "Reverify due P7D sources");
});

test("controller는 claim 뒤에만 돌고 비밀은 이 step의 env로만 받으며 recipe 목록은 env로 받는다. 재생 run에는 공급자 키를 넘기지 않는다", () => {
  const { block } = step("Reverify due P7D sources");
  assert.equal(ifCondition(block), CLAIMED);
  assert.match(block, /\n        id: reverify\n/u);
  assert.match(block, /\n          DATA_GO_KR_SERVICE_KEY: \$\{\{ steps\.decision\.outputs\.replay_run_id == '' && secrets\.DATA_GO_KR_SERVICE_KEY \|\| '' \}\}\n/u);
  assert.match(block, /\n          EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: \$\{\{ secrets\.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL \}\}\n/u);
  assert.match(block, /\n          KRIC_SERVICE_KEY: \$\{\{ steps\.decision\.outputs\.replay_run_id == '' && secrets\.KRIC_SERVICE_KEY \|\| '' \}\}\n/u);
  assert.match(block, /\n          RECIPES: \$\{\{ steps\.decision\.outputs\.recipes \}\}\n/u);
  assert.match(block, /\n          REPLAY_RUN_ID: \$\{\{ steps\.decision\.outputs\.replay_run_id \}\}\n/u);
  assert.match(block, /git config user\.name "github-actions\[bot\]"/u);
  assert.match(block, /\[\[ "\$\(git rev-parse origin\/main\)" == "\$\{REVERIFICATION_MAIN_SHA\}" \]\]/u);
  assert.match(block, /node tools\/datapack\/run-source-reverification\.mjs --operation-root "\$\{operation\}\/operation" --recipes "\$\{RECIPES\}" --replay-bundle "\$\{operation\}\/replay-bundle" > "\$\{operation\}\/result\.json"/u);
  assert.match(block, /node tools\/datapack\/run-source-reverification\.mjs --operation-root "\$\{operation\}\/operation" --replay-from "\$\{RUNNER_TEMP\}\/source-reverification-replay\/\$\{GITHUB_RUN_ID\}" --replay-bundle "\$\{operation\}\/replay-bundle" > "\$\{operation\}\/result\.json"/u);
  assert.match(block, /echo "registered=\$\(jq '\.steps \| length' "\$\{operation\}\/result\.json"\)" >> "\$\{GITHUB_OUTPUT\}"/u);
  assert.equal((yml.match(/secrets\.DATA_GO_KR_SERVICE_KEY/gu) ?? []).length, 1, "the service key is only used by the controller step");
  assert.equal((yml.match(/secrets\.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL/gu) ?? []).length, 1, "the OCI base URL is only used by the controller step");
  assert.equal((yml.match(/secrets\.KRIC_SERVICE_KEY/gu) ?? []).length, 1, "the KRIC service key is only used by the controller step");
});

// #975 리뷰 F5: controller의 커밋 전체가 원장 변화 게이트를 통과해야 PR이 된다. 증거 본문은 base/head 커밋에 결속된다.
test("원장 변화 게이트는 controller 뒤에 base(main) 기준으로 한 번 더 돌고 출력은 PR 증거 본문의 입력이다", () => {
  const { block } = step("Reverify due P7D sources");
  assert.match(block, /node tools\/ci\/source-ledger-gate\.mjs --base-sha "\$\{REVERIFICATION_MAIN_SHA\}" --output "\$\{operation\}\/gate\.json"/u);
  assert.ok(block.indexOf("run-source-reverification.mjs") < block.indexOf("source-ledger-gate.mjs"), "the gate checks the controller's commits");
  assert.match(block, /printf 'REVERIFICATION_RESULT=%s\\nREVERIFICATION_GATE=%s\\nREVERIFICATION_HEAD_SHA=%s\\n' "\$\{operation\}\/result\.json" "\$\{operation\}\/gate\.json" "\$\(git rev-parse HEAD\)" >> "\$\{GITHUB_ENV\}"/u);
  const create = step("Create source reverification pull request").block;
  assert.match(create, /node tools\/ci\/automation-pr-evidence\.mjs source-reverification-body --gate "\$\{REVERIFICATION_GATE\}" --result "\$\{REVERIFICATION_RESULT\}" --base-sha "\$\{REVERIFICATION_MAIN_SHA\}" --head-sha "\$\{REVERIFICATION_HEAD_SHA\}" --run-url "\$\{GITHUB_SERVER_URL\}\/\$\{GITHUB_REPOSITORY\}\/actions\/runs\/\$\{GITHUB_RUN_ID\}" --output "[^"]+"/u);
});

test("push 직전 재확인은 판정과 같은 규칙으로 대기 목록을 읽고, 대기 중이면 올리지 않고 notice로 끝낸다", () => {
  const recheck = step("Recheck that no source-ledger automation is pending before pushing");
  assert.equal(ifCondition(recheck.block), REGISTERED);
  assert.match(recheck.block, /\n        id: recheck\n/u);
  // #993: PR 이력 전체(--state all --limit 1000)를 받지 않는다. 열린 PR 전체와 claim 브랜치별 PR만 수집기로 받는다.
  assert.match(recheck.block, /node tools\/ci\/collect-automation-prs\.mjs --repository "\$\{GITHUB_REPOSITORY\}" --refs "[^"]+" --pr-limit 1000 --output "[^"]+"/u);
  assert.doesNotMatch(recheck.block, /gh pr list[^\n]*--state all --limit/u);
  assert.match(recheck.block, /git ls-remote --heads origin "refs\/heads\/automation\/\*" > /u);
  assert.match(recheck.block, /node tools\/ci\/ledger-writers-idle\.mjs --repository "\$\{GITHUB_REPOSITORY\}" --prs "[^"]+" --automation-branches "[^"]+" --except-workflow source-reverification\.yml --github-output "\$\{GITHUB_OUTPUT\}"/u);
  before("Reverify due P7D sources", recheck.name);
  before(recheck.name, "Verify the reverification is based on the current main and push its branch");
  const note = step("Note reverification superseded by pending source automation");
  assert.equal(ifCondition(note.block), "${{ steps.decision.outputs.state == 'RUN' && steps.claim.outputs.claimed == 'true' && steps.recheck.outputs.idle == 'false' }}");
  assert.match(note.block, /\n          BLOCKED_BY: \$\{\{ steps\.recheck\.outputs\.blocked_by \}\}\n/u);
});

test("push는 읽은 main 그대로일 때만 GITHUB_TOKEN으로 하고, main이 움직였으면 이상이 아니라 notice로 끝낸다", () => {
  const push = step("Verify the reverification is based on the current main and push its branch");
  assert.equal(ifCondition(push.block), IDLE);
  assert.match(push.block, /\n        id: push\n/u);
  assert.match(push.block, /\n          GH_TOKEN: \$\{\{ github\.token \}\}\n/u);
  assert.match(push.block, /git fetch --no-tags origin main/u);
  assert.match(push.block, /::notice title=Source reverification::main moved/u);
  assert.match(push.block, /echo "pushed=false" >> "\$\{GITHUB_OUTPUT\}"\n\s+exit 0/u);
  assert.match(push.block, /git push origin "\$\{REVERIFICATION_BRANCH\}"/u);
  assert.match(push.block, /echo "pushed=true" >> "\$\{GITHUB_OUTPUT\}"/u);
  assert.doesNotMatch(push.block, /git add|--force|-f /u);
  assert.equal(ifCondition(step("Note reverification superseded by a newer main").block), "${{ steps.decision.outputs.state == 'RUN' && steps.claim.outputs.claimed == 'true' && steps.recheck.outputs.idle == 'true' && steps.push.outputs.pushed == 'false' }}");
});

test("App 토큰 발급과 PR 생성은 push한 뒤에만 돌고 PR 생성만 App 토큰을 쓴다", () => {
  for (const name of ["Mint App token for the reverification pull request", "Create source reverification pull request"]) assert.equal(ifCondition(step(name).block), PUSHED, name);
  const create = step("Create source reverification pull request");
  assert.match(create.block, /\n        id: create-pr\n/u);
  assert.match(create.block, /\n          APP_PR_TOKEN: \$\{\{ steps\.app-token-pr\.outputs\.token \}\}\n/u);
  assert.match(create.block, /GH_TOKEN="\$\{APP_PR_TOKEN\}" gh pr create --repo "\$\{GITHUB_REPOSITORY\}" --draft --base main --head "\$\{REVERIFICATION_BRANCH\}" --title "\[Data\] [^"]+" --body-file "[^"]+"/u);
  assert.equal((yml.match(/gh pr create/gu) ?? []).length, 1);
});

// #1102: recipe 하나가 실패해도 나머지 recipe의 등록은 PR로 올라간다. 실패한 recipe는 PR 뒤(또는 PR이 만들어지지 않았어도) 마지막에 job을 실패시켜 #926 실패 이슈로 드러낸다.
test("실패한 recipe는 PR 생성 뒤에 보고하고(always) 그 step이 실패해도 PR이 된 claim은 지우지 않는다", () => {
  const report = step("Report recipes that failed");
  assert.equal(ifCondition(report.block), "${{ always() && steps.reverify.outcome == 'success' }}");
  assert.match(report.block, /\n        run: \|\n          set -euo pipefail\n(?:          #[^\n]*\n)*          node tools\/ci\/source-reverification-failures\.mjs --result "\$\{REVERIFICATION_RESULT\}"$/u);
  assert.doesNotMatch(report.block, /continue-on-error|GH_TOKEN|secrets\./u);
  before("Create source reverification pull request", report.name);
  before(report.name, "Remove this run's claim unless it became a pull request");
  before(report.name, "Report refresh failure as an issue");
  // create-pr가 성공했으면 이 step이 실패해도 정리 step은 claim을 지우지 않는다(조건은 create-pr 결과만 본다).
  assert.match(step("Remove this run's claim unless it became a pull request").block, /steps\.create-pr\.outcome != 'success'/u);
  // 보고 대상은 controller가 쓴 result.json이다. PR 본문 입력과 같은 파일이다.
  assert.match(step("Reverify due P7D sources").block, /REVERIFICATION_RESULT=%s/u);
});

// 이 run이 만든 claim은 PR이 되지 않았으면 실패·취소·시간 초과·대기 어느 경우에도 남기지 않는다(always()).
test("이 run의 claim은 PR이 되지 않으면 always()로 정리하고 PR이 열렸으면 PR과 함께 닫는다", () => {
  const cleanup = step("Remove this run's claim unless it became a pull request");
  assert.equal(ifCondition(cleanup.block), "${{ always() && env.REVERIFICATION_BRANCH != '' && steps.create-pr.outcome != 'success' }}");
  assert.match(cleanup.block, /\n          GH_TOKEN: \$\{\{ github\.token \}\}\n/u);
  assert.match(cleanup.block, /branch="automation\/984-source-reverification-\$\{GITHUB_RUN_ID\}"/u);
  assert.match(cleanup.block, /\[\[ "\$\{REVERIFICATION_BRANCH\}" == "\$\{branch\}" \]\] \|\| exit 0/u);
  assert.match(cleanup.block, /git ls-remote --exit-code --heads origin "refs\/heads\/\$\{branch\}" > \/dev\/null \|\| exit 0/u);
  assert.match(cleanup.block, /gh pr close "\$\{branch\}" --repo "\$\{GITHUB_REPOSITORY\}" --delete-branch --comment /u);
  assert.match(cleanup.block, /git push origin --delete "\$\{branch\}"/u);
  before("Create source reverification pull request", cleanup.name);
});

// 시도별 계측(#3036): 수집 step들이 같은 파일에 기록하고, 요약 step은 always()로 돌되 자기 실패가 job 결과를 바꾸지 않는다(수집 실패는 앞 step들이 드러낸다).
test("계측 파일 경로는 수집 전에 정하고 요약 step은 always()·continue-on-error로 마지막 보고 step 앞에서 돈다", () => {
  const record = step("Record source fetch attempts for the job summary");
  assert.match(record.block, /SOURCE_FETCH_TELEMETRY_PATH=\$\{RUNNER_TEMP\}\/source-fetch-telemetry\.jsonl" >> "\$\{GITHUB_ENV\}"/u);
  before(record.name, "Decide which P7D sources are due");
  const summary = step("Summarize source fetch attempts");
  assert.equal(ifCondition(summary.block), "${{ always() }}");
  assert.match(summary.block, /\n        continue-on-error: true\n/u);
  assert.match(summary.block, /node tools\/ci\/summarize-source-fetch-telemetry\.mjs --input "\$\{SOURCE_FETCH_TELEMETRY_PATH:-\}" >> "\$\{GITHUB_STEP_SUMMARY\}"/u);
  assert.equal((yml.match(/continue-on-error/gu) ?? []).length, 1, "요약 step만 continue-on-error다");
  before("Reverify due P7D sources", summary.name);
  before(summary.name, "Report refresh failure as an issue");
});

// #3036 7-26: 대기 run은 성공으로 끝나므로, 판정이 연체 recipe를 알리면 실패하지 않은 run도 같은 보고 경로로 이슈에 기록한다.
test("실패 보고가 마지막 step이고 실패·취소와 연체 recipe를 모두 보고한다", () => {
  const report = assertFailureReportLast({ yml, step, file: FILE, condition: "${{ failure() || cancelled() || steps.decision.outputs.overdue_recipes != '' }}" });
  // 실패·취소 run은 지금처럼 실패로 적고, 연체 문구는 실패하지 않은 대기 run에만 넘긴다.
  assert.match(report.block, /\n          OVERDUE_RECIPES: \$\{\{ job\.status == 'success' && steps\.decision\.outputs\.overdue_recipes \|\| '' \}\}\n/u);
  assert.match(report.block, /--failures "[^"]+" --overdue "\$\{OVERDUE_RECIPES\}"$/mu);
});

// #972·#974·#975 리뷰: step output·목록 값은 env로만 받아 셸 변수로 쓴다(표현식을 run 스크립트에 펼치지 않는다).
test("run 스크립트에는 표현식을 직접 넣지 않는다", () => {
  assertNoExpressionInRunScripts({ steps, file: FILE });
});

test("action은 SHA로 고정하고 광역 스테이징·강제 push를 쓰지 않는다", () => {
  for (const [, reference] of yml.matchAll(/\n\s+uses: ([^\s]+)/gu)) assert.match(reference, /@[0-9a-f]{40}$/u, reference);
  assert.doesNotMatch(yml, /git add -A|git add \.|--force|push -f/u);
});

test("dispatch는 재생할 원본 run id(replay_run_id)를 선택 입력으로 받는다 (#3036)", () => {
  assert.match(yml, /\n  workflow_dispatch:\n    inputs:\n      replay_run_id:\n        description: [^\n]+\n        required: false\n        default: ""\n        type: string\n/u);
});

test("재생은 claim 뒤에 원본 run이 main의 이 workflow인지 확인하고 그 run의 artifact를 받은 뒤에 controller를 돌린다 (#3036)", () => {
  const verify = step("Verify the replay source run");
  assert.equal(ifCondition(verify.block), REPLAYING);
  assert.match(verify.block, /\n          GH_TOKEN: \$\{\{ github\.token \}\}\n/u);
  assert.match(verify.block, /\n          REPLAY_RUN_ID: \$\{\{ steps\.decision\.outputs\.replay_run_id \}\}\n/u);
  assert.match(verify.block, /\n          gh api "repos\/\$\{GITHUB_REPOSITORY\}\/actions\/runs\/\$\{REPLAY_RUN_ID\}" > "\$\{source_root\}\/run\.json"\n/u);
  assert.match(verify.block, /\n          gh api "repos\/\$\{GITHUB_REPOSITORY\}\/actions\/runs\/\$\{REPLAY_RUN_ID\}\/jobs\?filter=all&per_page=100" > "\$\{source_root\}\/jobs\.json"\n/u);
  assert.match(verify.block, /\n          node tools\/ci\/verify-source-reverification-replay-run\.mjs --source-run-id "\$\{REPLAY_RUN_ID\}" --repository "\$\{GITHUB_REPOSITORY\}" --run "\$\{source_root\}\/run\.json" --jobs "\$\{source_root\}\/jobs\.json"$/u);
  assert.doesNotMatch(verify.block, /secrets\./u);
  const download = step("Download the retained reverification collection");
  assert.equal(ifCondition(download.block), REPLAYING);
  assert.match(download.block, /\n        uses: actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c\n/u);
  assert.match(download.block, /\n          run-id: \$\{\{ steps\.decision\.outputs\.replay_run_id \}\}\n/u);
  assert.match(download.block, /\n          name: source-reverification-\$\{\{ steps\.decision\.outputs\.replay_run_id \}\}\n/u);
  assert.match(download.block, /\n          path: \$\{\{ runner\.temp \}\}\/source-reverification-replay\/\$\{\{ github\.run_id \}\}\n/u);
  before("Claim exact main before provider access", verify.name);
  before(verify.name, download.name);
  before(download.name, "Reverify due P7D sources");
});

test("재생 원본 확인 도구가 읽는 workflow 경로·job 이름·step 이름은 이 workflow의 실제 이름이다 (#3036)", () => {
  assert.equal(SOURCE_REVERIFICATION_WORKFLOW_PATH, `.github/workflows/${FILE}`);
  assert.match(yml, new RegExp(`\\n  reverify:\\n    name: ${SOURCE_REVERIFICATION_JOB}\\n`, "u"));
  for (const name of SOURCE_REVERIFICATION_REPLAY_SOURCE_STEPS) assert.equal(names().filter((stepName) => stepName === name).length, 1, name);
});

test("재생이 남긴 등록이 없으면 push·PR 없이 이유를 notice로 남기고 claim은 정리 step이 지운다 (#3036)", () => {
  const note = step("Note the replay left nothing to register");
  assert.equal(ifCondition(note.block), "${{ steps.decision.outputs.state == 'RUN' && steps.claim.outputs.claimed == 'true' && steps.reverify.outputs.registered == '0' }}");
  assert.match(note.block, /::notice title=Source reverification::/u);
  assert.match(step("Reverify due P7D sources").block, /jq -r '\.dropped\[\]\? \| /u);
  before("Reverify due P7D sources", note.name);
});

test("재생 run이 main 이동이나 다른 원장 쓰기 자동화 때문에 push하지 못하면 대기로 끝내지 않고 REVERIFICATION_REPLAY_BLOCKED로 실패한다 (#3036)", () => {
  const fail = step("Fail a replay that could not open its pull request");
  const runs = (outputs) => evaluateGithubExpression(ifCondition(fail.block), { steps: outputs });
  const replay = (more) => ({ decision: { outputs: { state: "RUN", replay_run_id: "39369279984" } }, ...more });
  const collect = (more) => ({ decision: { outputs: { state: "RUN", replay_run_id: "" } }, ...more });
  assert.equal(runs(replay({ claim: { outputs: { claimed: "false" } } })), true, "판정 뒤 main이 움직였다");
  assert.equal(runs(replay({ claim: { outputs: { claimed: "true" } }, reverify: { outputs: { registered: "3" } }, recheck: { outputs: { idle: "false" } } })), true, "다른 원장 쓰기가 시작됐다");
  assert.equal(runs(replay({ claim: { outputs: { claimed: "true" } }, recheck: { outputs: { idle: "true" } }, push: { outputs: { pushed: "false" } } })), true, "push 전에 main이 움직였다");
  assert.equal(runs(replay({ claim: { outputs: { claimed: "true" } }, recheck: { outputs: { idle: "true" } }, push: { outputs: { pushed: "true" } } })), false, "push됐다");
  assert.equal(runs(replay({ claim: { outputs: { claimed: "true" } }, reverify: { outputs: { registered: "0" } } })), false, "main이 이미 최신이라 등록할 것이 없다");
  for (const outputs of [{ claim: { outputs: { claimed: "false" } } }, { claim: { outputs: { claimed: "true" } }, recheck: { outputs: { idle: "false" } } }, { push: { outputs: { pushed: "false" } } }]) {
    assert.equal(runs(collect(outputs)), false, `수집 run은 지금처럼 다음 실행에 맡긴다 ${JSON.stringify(outputs)}`);
  }
  assert.match(fail.block, /\n          REPLAY_RUN_ID: \$\{\{ steps\.decision\.outputs\.replay_run_id \}\}\n/u);
  assert.match(fail.block, /::error title=Source reverification::REVERIFICATION_REPLAY_BLOCKED: [^\n]*replay_run_id=\$\{REPLAY_RUN_ID\}/u);
  assert.match(fail.block, /\n          exit 1\n/u);
  before("Verify the reverification is based on the current main and push its branch", fail.name);
  before(fail.name, "Report refresh failure as an issue");
});

test("재생 묶음은 이 run이 묶음을 썼을 때만 push 뒤·PR 생성 전에 run id 이름의 artifact로 올리고, 재생할 수 있는 증거 창(24시간)에 맞춰 1일 보관한다 (#3036)", () => {
  const upload = step("Upload the retained collection for a later replay");
  const runs = (outputs) => evaluateGithubExpression(ifCondition(upload.block), { steps: outputs });
  const pushed = (bundle) => ({ decision: { outputs: { state: "RUN" } }, claim: { outputs: { claimed: "true" } }, recheck: { outputs: { idle: "true" } }, push: { outputs: { pushed: "true" } }, reverify: { outputs: { replay_bundle: bundle } } });
  assert.equal(runs(pushed("true")), true);
  assert.equal(runs(pushed("false")), false, "재생할 수 있는 묶음을 등록하지 않은 run은 올릴 것이 없다");
  assert.equal(runs({ ...pushed("true"), push: { outputs: { pushed: "false" } } }), false, "push하지 않은 run의 묶음은 재생 원본이 아니다");
  assert.match(upload.block, /\n        uses: actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a\n/u);
  assert.match(upload.block, /\n          name: source-reverification-\$\{\{ github\.run_id \}\}\n/u);
  assert.match(upload.block, /\n          path: \$\{\{ runner\.temp \}\}\/source-reverification\/\$\{\{ github\.run_id \}\}\/replay-bundle\n/u);
  assert.match(upload.block, /\n          if-no-files-found: error\n/u, "묶음을 썼다고 했는데 파일이 없으면 실패한다");
  assert.match(upload.block, /\n          retention-days: 1$/u, "재생 등록기가 24시간 지난 증거를 거부하므로 그보다 오래 두면 실패할 재생을 고르게 된다");
  const reverify = step("Reverify due P7D sources").block;
  assert.match(reverify, /\[\[ -f "\$\{operation\}\/replay-bundle\/manifest\.json" \]\]/u);
  assert.match(reverify, /echo "replay_bundle=true" >> "\$\{GITHUB_OUTPUT\}"/u);
  assert.match(reverify, /echo "replay_bundle=false" >> "\$\{GITHUB_OUTPUT\}"/u);
  assert.match(reverify, /::notice title=Source reverification::no replayable dependency group was registered/u, "묶음을 남기지 않는 것도 로그로 드러낸다");
  before("Verify the reverification is based on the current main and push its branch", upload.name);
  before(upload.name, "Mint App token for the reverification pull request");
});
