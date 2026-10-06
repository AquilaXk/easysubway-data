import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { assertFailureReportLast, assertNoExpressionInRunScripts, assertOpenPullRequestSteps, ifCondition, loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";

// #969 P3: 수도권 topology 등록 workflow 계약.
// 갱신 PR이 병합되면 사람이 dispatch하지 않아도 등록이 PR까지 이어진다. 정기·push 실행은 저장소 변수가 켜졌을 때만 돈다.
// 판정(REGISTER·RECOVER_CLAIM·OPEN_PR·BLOCKED_BY_PENDING_PR·REGISTERED)이 모든 쓰기 step을 가르고, 이상은 실패 이슈로 드러난다.
const FILE = "current-capital-topology-registration.yml";
const { yml, steps, step } = loadWorkflow(path.resolve(import.meta.dirname, "../.."), FILE);
const WRITES = "${{ steps.decision.outputs.state == 'REGISTER' || steps.decision.outputs.state == 'RECOVER_CLAIM' }}";

test("트리거: 수도권 topology 활성화 산출 경로 push, 정기 복구 실행, 사람 dispatch(복구 run 입력 유지)", () => {
  assert.match(yml, /^on:\n  push:\n    branches:\n      - main\n    paths:\n      - tools\/datapack\/sources\/capital-route-topology-\*\.json\n      - tools\/datapack\/release\/capital-topology-reverification-\*\.json\n  schedule:\n    - cron: "5 \*\/2 \* \* \*"\n  workflow_dispatch:\n    inputs:\n      recovery_run_id:\n/mu);
});

test("권한은 workflow 전체가 아니라 job에만 준다(issues 쓰기는 실패 보고용)", () => {
  assert.match(yml, /\npermissions: \{\}\n/u);
  assert.equal((yml.match(/\n    permissions:\n/gu) ?? []).length, 1);
  assert.match(yml, /\n    permissions:\n      actions: read\n      contents: write\n      pull-requests: write\n      issues: write\n/u);
});

test("push·정기 실행은 저장소 변수가 true일 때만 돌고 사람 dispatch는 항상 돈다", () => {
  assert.match(yml, /\n    if: \$\{\{ github\.ref == 'refs\/heads\/main' && \(github\.event_name == 'workflow_dispatch' \|\| vars\.DATAPACK_SCHEDULED_SOURCE_REGISTRATION == 'true'\) \}\}\n/u);
});

test("판정 step이 claim·게시·PR 생성보다 먼저 돌고 판정 입력을 저장소·GitHub 기록에서만 읽는다", () => {
  const all = steps();
  const decision = all.findIndex(({ name }) => name === "Decide whether capital topology registration is needed");
  const claim = all.findIndex(({ name }) => name === "Claim exact main before OCI publication");
  assert.ok(decision !== -1 && decision < claim);
  const { block } = all[decision];
  assert.match(block, /\n        id: decision\n/u);
  assert.match(block, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(block, /RECOVERY_RUN_ID: \$\{\{ inputs\.recovery_run_id \}\}/u);
  assert.match(block, /gh pr list --repo "\$\{GITHUB_REPOSITORY\}" --state all --limit 1000 --json number,state,isDraft,headRefName,baseRefName,headRepository,isCrossRepository > /u);
  assert.match(block, /git ls-remote --heads origin "refs\/heads\/automation\/456-capital-topology-registration-\*" > /u);
  // #987 리뷰 F1: 아직 끝나지 않은 run만 상태별로 조회하고, 복구에 필요한 claim의 producer run은 run id로 직접 가져온다(끝난 이력은 조회하지 않는다).
  assert.match(block, /for status in in_progress queued waiting pending requested; do\n\s+gh run list --repo "\$\{GITHUB_REPOSITORY\}" --workflow current-capital-topology-registration\.yml --status "\$\{status\}" --limit 200 --json databaseId,status,conclusion,workflowName,headBranch,headSha > "[^"]+"\n\s+done/u);
  assert.equal((block.match(/gh run list/gu) ?? []).length, 1, "every run listing is filtered by status");
  assert.match(block, /gh run view "\$\{claim_run\}" --repo "\$\{GITHUB_REPOSITORY\}" --json databaseId,status,conclusion,workflowName,headBranch,headSha/u);
  assert.match(block, /jq -s 'add \| unique_by\(\.databaseId\)' /u);
  assert.match(block, /node tools\/ci\/decide-capital-topology-registration\.mjs --inventory tools\/datapack\/source-inventory\.json --ledger tools\/datapack\/release\/source-snapshots\.json /u);
  assert.match(block, /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/actions\/runs\/\$\{claim_run\}\/artifacts" --jq '\[\.artifacts\[\]\.name\]'/u);
  assert.match(block, /--artifacts "\$\{decision_root\}\/artifacts\.json" --repository "\$\{GITHUB_REPOSITORY\}"/u);
  assert.match(block, /--current-main-sha "\$\{main_sha\}" --pr-limit 1000 --run-limit 200 --github-output "\$\{GITHUB_OUTPUT\}"/u);
  // 판정 시점의 checkout이 아직 main이어야 한다. 그 사이 main이 움직였으면 새 push가 자기 판정을 한다.
  assert.match(block, /git ls-remote origin refs\/heads\/main/u);
  assert.match(block, /state=SUPERSEDED/u);
});

test("claim·게시·복구·App 토큰·PR 생성은 REGISTER 또는 RECOVER_CLAIM일 때만 돌고, 게시와 복구는 서로 배타적이다", () => {
  for (const name of ["Claim exact main before OCI publication", "Mint App token for the registration pull request", "Commit exactly four registration outputs and open draft PR"]) {
    assert.equal(ifCondition(step(name).block), WRITES, name);
  }
  assert.equal(ifCondition(step("Publish and register once").block), "${{ steps.decision.outputs.state == 'REGISTER' }}");
  assert.equal(ifCondition(step("Recover published registration without OCI").block), "${{ steps.decision.outputs.state == 'RECOVER_CLAIM' }}");
  assert.doesNotMatch(yml, /inputs\.recovery_run_id == ''/u);
  assert.doesNotMatch(yml, /inputs\.recovery_run_id != ''/u);
});

test("복구 run id는 사람 입력 또는 판정 결과에서만 받고, producer run의 이벤트는 dispatch·push·schedule을 받는다", () => {
  const { block } = step("Claim exact main before OCI publication");
  assert.match(block, /RECOVERY_RUN_ID: \$\{\{ steps\.decision\.outputs\.recovery_run_id \}\}/u);
  assert.match(block, /\[\[ "\$\{run_event\}" == "workflow_dispatch" \|\| "\$\{run_event\}" == "push" \|\| "\$\{run_event\}" == "schedule" \]\]/u);
  assert.match(step("Recover published registration without OCI").block, /RECOVERY_RUN_ID: \$\{\{ steps\.decision\.outputs\.recovery_run_id \}\}/u);
});

test("OPEN_PR이면 App 토큰 → required CI 보장 → 열린 PR 상한 검사 순서로 돈다", () => {
  assertOpenPullRequestSteps({ steps, file: FILE, decisionName: "Decide whether capital topology registration is needed" });
});

test("다른 원장 쓰기 PR 때문에 기다리는 실행은 이유를 notice로 남기고 아무것도 쓰지 않는다", () => {
  const { block } = step("Note registration waiting on another pending automation pull request");
  assert.equal(ifCondition(block), "${{ steps.decision.outputs.state == 'BLOCKED_BY_PENDING_PR' }}");
  assert.match(block, /::notice title=Capital topology registration::/u);
  assert.match(block, /steps\.decision\.outputs\.blocked_by/u);
});

test("복구 증거 artifact는 게시를 시도한 실행에서만 올리고, 실패 보고가 마지막 step이다", () => {
  assertFailureReportLast({ yml, step, file: FILE, condition: "${{ failure() || cancelled() }}" });
});

test("이 workflow는 workflow dispatch를 호출하지 않고 push는 GITHUB_TOKEN, PR 생성만 App 토큰이다", () => {
  assert.doesNotMatch(yml, /gh workflow run|\/dispatches|repository_dispatch|actions: write/u);
  assert.match(step("Commit exactly four registration outputs and open draft PR").block, /\n          GH_TOKEN: \$\{\{ github\.token \}\}\n/u);
});

// #972 리뷰 F4: step output(required-ci 상태·blocked_by)을 run 스크립트에 표현식으로 펼치면 나중에 출력이 바뀔 때 셸 주입 지점이 된다.
test("run 스크립트에는 표현식을 직접 넣지 않고 env로만 받는다", () => {
  assertNoExpressionInRunScripts({ steps, file: FILE });
  assert.match(step("Note registration waiting on another pending automation pull request").block, /\n          BLOCKED_BY: \$\{\{ steps\.decision\.outputs\.blocked_by \}\}\n/u);
});

// #972 리뷰 F1·F2, 이슈 #973: 게시 증거 없이 남은 빈 claim과 병합된 PR의 남은 claim은 사람이 지울 일이 아니다.
test("이번 실행이 만든 claim은 실패·취소 때 게시 증거가 없으면 자동으로 지우고, 증거가 있고 비어 있으면 복구용으로 남긴다", () => {
  const cleanup = step("Remove this run's claim after a failed or cancelled run");
  assert.equal(ifCondition(cleanup.block), "${{ (failure() || cancelled()) && env.REGISTRATION_BRANCH != '' }}");
  assert.match(cleanup.block, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  // 복구 실행은 자기가 복구하는 claim을 지우지 않는다. 이 run의 id로 만든 claim만 지운다.
  assert.match(cleanup.block, /branch="automation\/456-capital-topology-registration-\$\{GITHUB_RUN_ID\}"/u);
  assert.match(cleanup.block, /\[\[ "\$\{REGISTRATION_BRANCH\}" == "\$\{branch\}" \]\] \|\| exit 0/u);
  // PR이 있으면 지우지 않는다.
  assert.match(cleanup.block, /gh pr list --repo "\$\{GITHUB_REPOSITORY\}" --state all --head "\$\{branch\}" --json number --jq 'length'/u);
  // receipt가 있고 claim이 빈 커밋 하나뿐이면 복구용으로 남긴다. 그 밖에는 지운다.
  assert.match(cleanup.block, /capital-route-topology\.raw-receipt\.json/u);
  assert.match(cleanup.block, /git rev-list --count "\$\{REGISTRATION_MAIN_SHA\}\.\.origin\/\$\{branch\}"/u);
  assert.match(cleanup.block, /git push origin --delete "\$\{branch\}"/u);
  const names = steps().map(({ name }) => name);
  assert.ok(names.indexOf("Retain sanitized publication recovery evidence") < names.indexOf(cleanup.name), "evidence is retained before the cleanup decides");
  assert.ok(names.indexOf(cleanup.name) < names.indexOf("Report refresh failure as an issue"));
});

test("판정이 알린 정리 대상(병합된 PR의 남은 claim·게시 증거 없는 이전 claim)은 claim step 전에 지운다", () => {
  const cleanup = step("Remove stale registration claims named by the decision");
  assert.equal(ifCondition(cleanup.block), WRITES);
  assert.match(cleanup.block, /CLEANUP_CLAIMS: \$\{\{ steps\.decision\.outputs\.cleanup_claims \}\}/u);
  assert.match(cleanup.block, /\^automation\/456-capital-topology-registration-\[1-9\]\[0-9\]\*\$/u);
  assert.match(cleanup.block, /git push origin --delete "\$\{claim_branch\}"/u);
  const names = steps().map(({ name }) => name);
  assert.ok(names.indexOf("Decide whether capital topology registration is needed") < names.indexOf(cleanup.name));
  assert.ok(names.indexOf(cleanup.name) < names.indexOf("Claim exact main before OCI publication"));
  // claim step의 경쟁 claim 검사는 정리 뒤 상태를 엄격히 본다(판정과 같은 기준으로 이미 정리했으므로 남은 claim이 없어야 한다).
  assert.match(step("Claim exact main before OCI publication").block, /\[\[ ! -s "\$\{claims\}" \]\] \|\| \{ echo "competing registration claim exists" >&2; exit 1; \}/u);
});

test("복구 증거 artifact는 게시 receipt가 있을 때만 올린다(판정이 artifact 유무로 복구 가능 여부를 본다)", () => {
  const detect = step("Detect retained publication receipt");
  assert.equal(ifCondition(detect.block), "${{ always() && (steps.decision.outputs.state == 'REGISTER' || steps.decision.outputs.state == 'RECOVER_CLAIM') }}");
  assert.match(detect.block, /\n        id: receipt\n/u);
  assert.match(detect.block, /has_receipt=true/u);
  assert.equal(ifCondition(step("Retain sanitized publication recovery evidence").block), "${{ always() && steps.receipt.outputs.has_receipt == 'true' }}");
});

test("producer가 실행 중인 claim은 이유를 notice로 남기고 아무것도 쓰지 않는다", () => {
  const { block } = step("Note registration waiting on a running producer");
  assert.equal(ifCondition(block), "${{ steps.decision.outputs.state == 'CLAIM_IN_PROGRESS' }}");
});

// #975 리뷰 F2·F5: 등록 PR도 원장 변화 게이트를 통과해야 하고, 본문에 base/head 커밋에 결속된 증거 블록을 낸다.
test("등록 PR은 push 전에 원장 변화 게이트를 통과하고 증거 블록이 든 본문 파일로 연다", () => {
  const { block } = step("Commit exactly four registration outputs and open draft PR");
  const gate = block.indexOf('node tools/ci/source-ledger-gate.mjs --base-sha "${REGISTRATION_MAIN_SHA}" --output "${evidence_root}/gate.json"');
  const push = block.indexOf('git push origin "${REGISTRATION_BRANCH}"');
  const body = block.indexOf('node tools/ci/automation-pr-evidence.mjs registration-body --gate "${evidence_root}/gate.json" --base-sha "${REGISTRATION_MAIN_SHA}" --head-sha "$(git rev-parse HEAD)"');
  const create = block.indexOf("gh pr create");
  assert.ok(gate !== -1 && gate < push, "the ledger gate runs before the push");
  assert.ok(push < body && body < create, "the body is built from the pushed head before the PR is created");
  assert.match(block, /--run-url "\$\{GITHUB_SERVER_URL\}\/\$\{GITHUB_REPOSITORY\}\/actions\/runs\/\$\{GITHUB_RUN_ID\}" --output "\$\{evidence_root\}\/body\.md"/u);
  assert.match(block, /--body-file "\$\{evidence_root\}\/body\.md"/u);
  assert.match(block, /evidence_root="\$\(mktemp -d "\$\{RUNNER_TEMP\}\/registration-evidence\.XXXXXX"\)"/u);
});
