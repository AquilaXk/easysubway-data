import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { assertFailureReportLast, assertNoExpressionInRunScripts, assertOpenPullRequestSteps, ifCondition, loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";

// #984(#969 남은 단계 1): P7D 원천 재확인 workflow 계약. 판정(DUE)이 고른 recipe를 claim → 수집·게시·등록 → 재확인 → push → App 토큰 PR 하나로 올린다.
// 변수 DATAPACK_SCHEDULED_SOURCE_REVERIFICATION이 true일 때만 정기 실행이 돈다(기본 꺼짐). 이상은 job을 실패시켜 #926 실패 이슈로 드러난다.
const FILE = "source-reverification.yml";
const { yml, steps, step } = loadWorkflow(path.resolve(import.meta.dirname, "../.."), FILE);
const RUN = "${{ steps.decision.outputs.state == 'RUN' }}";
const CLAIMED = "${{ steps.decision.outputs.state == 'RUN' && steps.claim.outputs.claimed == 'true' }}";
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
  assert.match(yml, /\n    if: \$\{\{ github\.ref == 'refs\/heads\/main' && \(github\.event_name == 'workflow_dispatch' \|\| vars\.DATAPACK_SCHEDULED_SOURCE_REVERIFICATION == 'true'\) \}\}\n/u);
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
  assert.match(block, /node tools\/ci\/decide-source-reverification\.mjs --inventory tools\/datapack\/source-inventory\.json --ledger tools\/datapack\/release\/source-snapshots\.json --policy release\/product-gates\/datapack-freshness-sla\.json --prs "[^"]+" --automation-branches "[^"]+" --runs "[^"]+" --repository "\$\{GITHUB_REPOSITORY\}" --pr-limit 1000 --run-limit 200 --github-output "\$\{GITHUB_OUTPUT\}"/u);
  before("Decide which P7D sources are due", "Claim exact main before provider access");
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

test("controller는 claim 뒤에만 돌고 비밀은 이 step의 env로만 받으며 recipe 목록은 env로 받는다", () => {
  const { block } = step("Reverify due P7D sources");
  assert.equal(ifCondition(block), CLAIMED);
  assert.match(block, /\n        id: reverify\n/u);
  assert.match(block, /\n          DATA_GO_KR_SERVICE_KEY: \$\{\{ secrets\.DATA_GO_KR_SERVICE_KEY \}\}\n/u);
  assert.match(block, /\n          EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: \$\{\{ secrets\.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL \}\}\n/u);
  assert.match(block, /\n          RECIPES: \$\{\{ steps\.decision\.outputs\.recipes \}\}\n/u);
  assert.match(block, /git config user\.name "github-actions\[bot\]"/u);
  assert.match(block, /\[\[ "\$\(git rev-parse origin\/main\)" == "\$\{REVERIFICATION_MAIN_SHA\}" \]\]/u);
  assert.match(block, /node tools\/datapack\/run-source-reverification\.mjs --operation-root "\$\{operation\}\/operation" --recipes "\$\{RECIPES\}" > "\$\{operation\}\/result\.json"/u);
  assert.equal((yml.match(/secrets\.DATA_GO_KR_SERVICE_KEY/gu) ?? []).length, 1, "the service key is only used by the controller step");
  assert.equal((yml.match(/secrets\.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL/gu) ?? []).length, 1, "the OCI base URL is only used by the controller step");
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
  assert.equal(ifCondition(recheck.block), CLAIMED);
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

test("실패 보고가 마지막 step이고 실패·취소 모두 보고한다", () => {
  assertFailureReportLast({ yml, step, file: FILE, condition: "${{ failure() || cancelled() }}" });
});

// #972·#974·#975 리뷰: step output·목록 값은 env로만 받아 셸 변수로 쓴다(표현식을 run 스크립트에 펼치지 않는다).
test("run 스크립트에는 표현식을 직접 넣지 않는다", () => {
  assertNoExpressionInRunScripts({ steps, file: FILE });
});

test("action은 SHA로 고정하고 광역 스테이징·강제 push를 쓰지 않는다", () => {
  for (const [, reference] of yml.matchAll(/\n\s+uses: ([^\s]+)/gu)) assert.match(reference, /@[0-9a-f]{40}$/u, reference);
  assert.doesNotMatch(yml, /git add -A|git add \.|--force|push -f/u);
});
