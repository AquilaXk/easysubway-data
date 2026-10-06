import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { assertFailureReportLast, assertNoExpressionInRunScripts, assertOpenPullRequestSteps, ifCondition, loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";

// #977: ITX-청춘 원천 시간표 자동 승격 workflow 계약(#870 전체 자동화 3단계).
// 매일 정기 실행하지만 공급자 호출 전에 판정이 수집 여부를 정한다. 수집분은 이상 판정 게이트를 통과해야만 승격 PR이 된다.
// 정기 실행은 저장소 변수 DATAPACK_SCHEDULED_ITX_PROMOTION이 true일 때만 돈다. 사람 dispatch는 항상 돈다.
const FILE = "itx-current-promotion.yml";
const { yml, steps, step } = loadWorkflow(path.resolve(import.meta.dirname, "../.."), FILE);
// 주석은 설명이다. 동작을 보는 단언은 주석을 뺀 본문에만 건다.
const code = yml.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
const COLLECT = "${{ steps.decision.outputs.state == 'COLLECT' }}";
const DECISION = "Decide whether ITX promotion is due";

// F5 → #979 → #980 F1: 원장 대조·첫 dispatch 확인은 #981로 분리했고 변수 켜기의 선행 조건이 아니다. 변수는 코드가 켜지 않고 QA 보고 뒤 별도 설정 변경으로 켠다.
test("정기 실행 변수는 코드가 켜지 않고 QA 보고 뒤 별도 설정 변경으로만 켠다고 workflow가 스스로 밝힌다", () => {
  const header = yml.split("\n").filter((line) => line.startsWith("#")).join("\n");
  assert.match(header, /#981/u);
  assert.match(header, /DATAPACK_SCHEDULED_ITX_PROMOTION[^\n]*QA 보고 뒤[^\n]*설정 변경/u);
  assert.doesNotMatch(header, /#979 본문 참조/u);
  // 코드는 변수를 스스로 켜지 않고, 정기 실행은 변수가 true일 때만 돈다.
  assert.doesNotMatch(code, /DATAPACK_SCHEDULED_ITX_PROMOTION[^\n]*(?:=|:)\s*['"]?true['"]?\s*$/mu);
});

test("트리거: 매일 03:00 KST 정기 실행과 사람 dispatch(force 입력). push 트리거는 없다", () => {
  assert.match(yml, /^on:\n  schedule:\n    - cron: "0 18 \* \* \*"\n  workflow_dispatch:\n    inputs:\n      force_collect:\n        description: [^\n]+\n        required: false\n        default: false\n        type: boolean\n/mu);
  assert.doesNotMatch(code, /\n  push:|\n  pull_request:|\n  pull_request_target:|\n  workflow_run:/u);
});

test("권한은 workflow 전체가 아니라 job에만 준다(issues 쓰기는 실패 보고용)", () => {
  assert.match(yml, /\npermissions: \{\}\n/u);
  assert.equal((yml.match(/\n    permissions:\n/gu) ?? []).length, 1);
  assert.match(yml, /\n    permissions:\n      actions: read\n      contents: write\n      pull-requests: write\n      issues: write\n/u);
});

test("정기 실행은 저장소 변수가 true일 때만 돌고 사람 dispatch는 항상 돈다. 변수 기본값은 꺼짐이다", () => {
  assert.match(yml, /\n    if: \$\{\{ github\.ref == 'refs\/heads\/main' && \(github\.event_name == 'workflow_dispatch' \|\| vars\.DATAPACK_SCHEDULED_ITX_PROMOTION == 'true'\) \}\}\n/u);
  // 이 workflow가 변수를 스스로 켜는 일은 없다.
  assert.doesNotMatch(yml, /gh variable|gh api[^\n]*variables/u);
});

test("job은 공급자 secret이 있는 itx-current-collection 환경에서 돌고 이름이 예산 가드의 등록과 같다", () => {
  assert.match(yml, /\n    name: ITX current promotion\n/u);
  assert.match(yml, /\n    environment: itx-current-collection\n/u);
  assert.match(yml, /\nconcurrency:\n  group: itx-current-promotion-main\n  cancel-in-progress: false\n/u);
});

test("판정 step이 공급자 접근·쓰기보다 먼저 돌고 PR·브랜치 기록만 읽는다", () => {
  const all = steps();
  const decision = all.findIndex(({ name }) => name === DECISION);
  const guard = all.findIndex(({ name }) => name === "Guard KST quota window");
  const collect = all.findIndex(({ name }) => name === "Collect current ITX timetable");
  assert.ok(decision !== -1 && decision < guard && guard < collect);
  const { block } = all[decision];
  assert.match(block, /\n        id: decision\n/u);
  assert.match(block, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(block, /FORCE_COLLECT: \$\{\{ inputs\.force_collect \}\}/u);
  assert.match(block, /gh pr list --repo "\$\{GITHUB_REPOSITORY\}" --state all --limit 1000 --json number,state,isDraft,headRefName,baseRefName,headRepository,isCrossRepository > /u);
  assert.match(block, /git ls-remote --heads origin "refs\/heads\/automation\/977-itx-promotion-\*" > /u);
  assert.match(block, /node tools\/ci\/decide-itx-current-promotion\.mjs --contract tools\/datapack\/itx-cheongchun-coverage-contract\.json /u);
  assert.match(block, /--repository "\$\{GITHUB_REPOSITORY\}" --pr-limit 1000 --force "\$\{force\}" --itx-collected-today "\$\{itx_collected\}" --github-output "\$\{GITHUB_OUTPUT\}"/u);
  // F4: 같은 KST 날 다른 workflow가 이미 ITX를 수집했는지 공급자 호출 전에 본다. 수집했다면 WAIT로 정상 종료한다.
  assert.match(block, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(block, /itx_collected="\$\(node tools\/ci\/guard-itx-current-collection-budget\.mjs --probe\)"/u);
  assert.doesNotMatch(block, /DATA_GO_KR_SERVICE_KEY/u);
});

test("수집·게이트·승격·브랜치·PR 생성은 모두 COLLECT일 때만 돈다", () => {
  for (const name of [
    "Prepare current ITX promotion",
    "Guard KST quota window",
    "Collect current ITX timetable",
    "Replay retained capture offline",
    "Evaluate promotion gate",
    "Promote the gated candidate",
    "Checkout pinned Mobile input fixture",
    "Stage pinned Mobile input fixture",
    "Rebind derived ITX bindings",
    "Mint App token for the promotion pull request",
    "Commit exactly the promotion and rebinding outputs and open draft PR",
  ]) {
    assert.equal(ifCondition(step(name).block), COLLECT, name);
  }
});

test("순서: 준비 -> 예산 가드 -> 수집 -> 오프라인 replay -> 게이트 -> 승격 -> fixture -> 재결속 -> App 토큰 -> 커밋·PR", () => {
  const names = steps().map(({ name }) => name);
  const order = [
    DECISION, "Prepare current ITX promotion", "Guard KST quota window", "Collect current ITX timetable", "Replay retained capture offline",
    "Evaluate promotion gate", "Promote the gated candidate", "Checkout pinned Mobile input fixture", "Stage pinned Mobile input fixture",
    "Rebind derived ITX bindings", "Mint App token for the promotion pull request",
    "Commit exactly the promotion and rebinding outputs and open draft PR",
  ];
  const indexes = order.map((name) => names.indexOf(name));
  assert.ok(indexes.every((index) => index !== -1), indexes.join(","));
  assert.deepEqual([...indexes].sort((left, right) => left - right), indexes);
});

test("공급자 키는 수집 step에서만 받고 형식을 먼저 검사한다. 키를 출력하지 않는다", () => {
  const withKey = steps().filter(({ block }) => block.includes("secrets.DATA_GO_KR_SERVICE_KEY"));
  assert.deepEqual(withKey.map(({ name }) => name).sort(), ["Collect current ITX timetable", "Prepare current ITX promotion"]);
  const prepare = step("Prepare current ITX promotion").block;
  assert.match(prepare, /nonempty single line/u);
  assert.match(prepare, /node tools\/datapack\/emit-station-catalog-pack\.mjs --output "\$\{ITX_OPERATION_ROOT\}\/station-catalog-pack" --catalog-pack-id "itx-current-station-catalog-v1"/u);
  assert.doesNotMatch(code, /(echo|printf|cat)[^\n]*\$\{?DATA_GO_KR_SERVICE_KEY/u);
  assert.doesNotMatch(yml, /::add-mask::/u);
});

test("예산 가드는 같은 KST 날의 다른 수집을 막고 collector step 이름이 가드의 등록과 같다", () => {
  const guard = step("Guard KST quota window").block;
  assert.match(guard, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(guard, /node tools\/ci\/guard-itx-current-collection-budget\.mjs --output "\$\{ITX_OPERATION_ROOT\}\/freshness\.json"/u);
});

test("수집은 collector를 한 번만 부르고 게이트는 수집 결과·capture·replay·정책으로 판정한다", () => {
  const collect = step("Collect current ITX timetable").block;
  assert.equal((collect.match(/run-current-itx-collection\.mjs/gu) ?? []).length, 1);
  assert.match(collect, /--output "\$\{ITX_OPERATION_ROOT\}\/itx-result\.json" --completeness-output "\$\{ITX_OPERATION_ROOT\}\/itx-completeness\.json" --station-catalog-pack "\$\{ITX_OPERATION_ROOT\}\/station-catalog-pack" --freshness-output "\$\{ITX_OPERATION_ROOT\}\/freshness\.json"/u);
  assert.doesNotMatch(collect, /retry|for attempt|until /u);
  const replay = step("Replay retained capture offline").block;
  assert.match(replay, /node tools\/datapack\/replay-current-itx-collection\.mjs --capture "\$\{ITX_OPERATION_ROOT\}\/provider-response-capture\.json" --output "\$\{ITX_OPERATION_ROOT\}\/itx-replay\.json" --station-catalog-pack "\$\{ITX_OPERATION_ROOT\}\/station-catalog-pack"/u);
  assert.doesNotMatch(replay, /DATA_GO_KR_SERVICE_KEY/u);
  const gate = step("Evaluate promotion gate").block;
  assert.match(gate, /node tools\/datapack\/itx-promotion-gate\.mjs --candidate "\$\{ITX_OPERATION_ROOT\}\/itx-result\.json" --completeness "\$\{ITX_OPERATION_ROOT\}\/itx-completeness\.json" --capture "\$\{ITX_OPERATION_ROOT\}\/provider-response-capture\.json" --replay "\$\{ITX_OPERATION_ROOT\}\/itx-replay\.json" --coverage-contract "\$\{GITHUB_WORKSPACE\}\/tools\/datapack\/itx-cheongchun-coverage-contract\.json" --policy "\$\{GITHUB_WORKSPACE\}\/tools\/datapack\/itx-promotion-gate-policy\.json" --output "\$\{ITX_OPERATION_ROOT\}\/itx-promotion-gate\.json"/u);
  assert.doesNotMatch(gate, /\|\| true|continue-on-error/u);
});

test("승격은 승인 코멘트 없이 게이트 경로로만 돌고, 수동 승인 경로를 쓰는 인자가 없다", () => {
  const promote = step("Promote the gated candidate").block;
  assert.match(promote, /node tools\/datapack\/collect-korail-itx-cheongchun-timetable\.mjs --promote-candidate "\$\{ITX_OPERATION_ROOT\}\/itx-result\.json" --completeness-evidence "\$\{ITX_OPERATION_ROOT\}\/itx-completeness\.json"/u);
  assert.match(promote, /--auto-gate --provider-capture "\$\{ITX_OPERATION_ROOT\}\/provider-response-capture\.json" --replay-evidence "\$\{ITX_OPERATION_ROOT\}\/itx-replay\.json"/u);
  assert.doesNotMatch(code, /--approval-url|--approved-sha256|approve-itx-current/u);
});

test("App 토큰은 PR 생성 바로 앞 step에서 같은 조건으로 받고 push만 GITHUB_TOKEN이다", () => {
  const all = steps();
  const create = all.findIndex(({ name }) => name === "Commit exactly the promotion and rebinding outputs and open draft PR");
  const token = all[create - 1];
  assert.equal(token.name, "Mint App token for the promotion pull request");
  assert.match(token.block, /\n        id: app-token-pr\n/u);
  assert.match(token.block, /uses: actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1/u);
  assert.match(token.block, /\n          owner: AquilaXk\n          repositories: easysubway-data\n          permission-pull-requests: write(?:\n|$)/u);
  const { block } = all[create];
  assert.match(block, /\n          APP_PR_TOKEN: \$\{\{ steps\.app-token-pr\.outputs\.token \}\}\n/u);
  assert.match(block, /\n          GH_TOKEN: \$\{\{ github\.token \}\}\n/u);
  assert.match(block, /GH_TOKEN="\$\{APP_PR_TOKEN\}" gh pr create --repo "\$\{GITHUB_REPOSITORY\}" --draft --base main --head "\$\{branch\}"/u);
});

test("커밋은 증거 단계 코드가 정한 허용 경로만 명시적으로 스테이징하고 push·본문 생성·PR 생성 순서다", () => {
  const { block } = step("Commit exactly the promotion and rebinding outputs and open draft PR");
  assert.doesNotMatch(block, /git add (-A|--all|\.)(\s|$)/u);
  // 허용 경로의 정본은 automation-pr-evidence의 itxPromotionAllowedPaths 한 곳이고, 바뀐 경로 집합이 정확히 그것이어야 한다.
  assert.match(block, /itxPromotionAllowedPaths\(process\.argv\[1\]\)/u);
  assert.match(block, /\[\[ "\$\{#changed\[@\]\}" == "\$\{#paths\[@\]\}" \]\]/u);
  assert.match(block, /tools\/datapack\/itx-cheongchun-coverage-contract\.json/u);
  const add = block.indexOf('git add "${paths[@]}"');
  const commit = block.indexOf("git commit");
  const push = block.indexOf('git push origin "${branch}"');
  const body = block.indexOf('node tools/ci/automation-pr-evidence.mjs itx-promotion-body --receipt');
  const create = block.indexOf("gh pr create");
  assert.ok(add !== -1 && add < commit && commit < push && push < body && body < create, [add, commit, push, body, create].join(","));
  // F6: 정리 step이 이 브랜치를 알 수 있도록 push보다 먼저 이름을 기록한다(취소가 둘 사이에 와도 원격 브랜치가 남지 않는다).
  const record = block.indexOf("PROMOTION_BRANCH=%s");
  assert.ok(record !== -1 && record < push, `PROMOTION_BRANCH is recorded at ${record}, push at ${push}`);
  assert.match(block, /--base-sha "\$\{base_sha\}" --head-sha "\$\(git rev-parse HEAD\)" --run-url "\$\{GITHUB_SERVER_URL\}\/\$\{GITHUB_REPOSITORY\}\/actions\/runs\/\$\{GITHUB_RUN_ID\}" --output "\$\{evidence_root\}\/body\.md"/u);
  assert.match(block, /--body-file "\$\{evidence_root\}\/body\.md"/u);
  assert.match(block, /branch="automation\/977-itx-promotion-\$\{GITHUB_RUN_ID\}"/u);
  // 승격 결과 파일이 허용 경로 밖을 바꾸면 PR을 만들지 않고 실패한다.
  assert.match(block, /promotion changed an unsupported path/u);
});

test("OPEN_PR이면 App 토큰 → required CI 보장 → 열린 PR 상한 검사 순서로 돈다", () => {
  assertOpenPullRequestSteps({ steps, file: FILE, decisionName: DECISION });
});

test("수집할 때가 아니거나 다른 자동화 PR 때문에 기다리는 실행은 이유를 notice로 남기고 아무것도 쓰지 않는다", () => {
  const wait = step("Note ITX promotion is not due");
  assert.equal(ifCondition(wait.block), "${{ steps.decision.outputs.state == 'WAIT' }}");
  assert.match(wait.block, /DAYS_UNTIL_EXPIRY: \$\{\{ steps\.decision\.outputs\.days_until_expiry \}\}/u);
  assert.match(wait.block, /::notice title=ITX promotion::/u);
  const blocked = step("Note ITX promotion waiting on another pending automation pull request");
  assert.equal(ifCondition(blocked.block), "${{ steps.decision.outputs.state == 'BLOCKED_BY_PENDING_PR' }}");
  assert.match(blocked.block, /BLOCKED_BY: \$\{\{ steps\.decision\.outputs\.blocked_by \}\}/u);
});

test("공급자 호출 전 판정이 WAIT·OPEN_PR·BLOCKED인 실행은 collector step이 skipped라 예산을 쓰지 않는다", () => {
  // 가드는 collector step이 skipped인 앞선 실행을 소비로 세지 않는다. 그 skipped는 COLLECT 조건에서 나온다.
  assert.equal(ifCondition(step("Collect current ITX timetable").block), COLLECT);
});

test("증거 artifact는 수집을 시도한 실행에서 항상 올리고 비밀·키를 담지 않는다", () => {
  const upload = step("Upload sanitized promotion evidence");
  assert.equal(ifCondition(upload.block), "${{ always() && steps.decision.outputs.state == 'COLLECT' }}");
  assert.match(upload.block, /uses: actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/u);
  assert.match(upload.block, /name: itx-current-promotion-\$\{\{ github\.run_id \}\}/u);
  for (const file of ["freshness.json", "itx-result.json", "itx-completeness.json", "provider-response-capture.json", "itx-replay.json", "itx-promotion-gate.json"]) {
    assert.ok(upload.block.includes(`itx-current-promotion/\${{ github.run_id }}/${file}`) || upload.block.includes(`/${file}`), file);
  }
  assert.doesNotMatch(upload.block, /station-catalog-pack/u);
  assert.match(upload.block, /retention-days: 14/u);
});

test("신선도가 이미 끊긴 뒤의 복구 수집은 PR을 연 뒤 실패로 끝내 이상을 드러낸다", () => {
  const lapsed = step("Surface a lapsed freshness");
  assert.equal(ifCondition(lapsed.block), "${{ steps.decision.outputs.state == 'COLLECT' && steps.decision.outputs.lapsed == 'true' }}");
  const names = steps().map(({ name }) => name);
  assert.ok(names.indexOf("Commit exactly the promotion and rebinding outputs and open draft PR") < names.indexOf(lapsed.name));
  assert.match(lapsed.block, /exit 1/u);
});

test("push한 브랜치에 PR이 만들어지지 않은 채 끝난 실행은 그 브랜치를 지운다(PR이 있으면 지우지 않는다)", () => {
  const cleanup = step("Remove this run's branch when no pull request was opened");
  assert.equal(ifCondition(cleanup.block), "${{ (failure() || cancelled()) && env.PROMOTION_BRANCH != '' }}");
  assert.match(cleanup.block, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(cleanup.block, /branch="automation\/977-itx-promotion-\$\{GITHUB_RUN_ID\}"/u);
  assert.match(cleanup.block, /\[\[ "\$\{PROMOTION_BRANCH\}" == "\$\{branch\}" \]\] \|\| exit 0/u);
  assert.match(cleanup.block, /gh pr list --repo "\$\{GITHUB_REPOSITORY\}" --state all --head "\$\{branch\}" --json number --jq 'length'/u);
  assert.match(cleanup.block, /git push origin --delete "\$\{branch\}"/u);
  const names = steps().map(({ name }) => name);
  assert.ok(names.indexOf(cleanup.name) < names.indexOf("Report refresh failure as an issue"));
});

test("게이트 차단·수집 실패·CI 실패·방치는 job을 실패시키고 실패 이슈(#926 경로)가 마지막 step이다", () => {
  assertFailureReportLast({ yml, step, file: FILE, condition: "${{ failure() || cancelled() }}" });
});

test("이 workflow는 workflow dispatch를 호출하지 않고 run 스크립트에 표현식을 직접 넣지 않는다", () => {
  assert.doesNotMatch(yml, /gh workflow run|\/dispatches|repository_dispatch|actions: write/u);
  assertNoExpressionInRunScripts({ steps, file: FILE });
});

// #979: 승격 뒤 파생 재결속. fixture는 CI와 같은 고정 입력이어야 하고, 재결속은 승격 직후·PR 생성 전에 돈다.
test("재결속은 CI와 같은 고정 mobile 입력 fixture에서 돌고 증거·fixture를 PR에 포함한다", () => {
  const ci = readFileSync(path.resolve(import.meta.dirname, "../../.github/workflows/ci.yml"), "utf8");
  const pin = (text, key) => new RegExp(`${key}="?([0-9a-f]{40,64})"?`, "u").exec(text)?.[1];
  const stage = step("Stage pinned Mobile input fixture").block;
  const ciStage = /- name: Stage pinned Mobile fixture[\s\S]*?\n      - name:/u.exec(ci)[0];
  assert.equal(pin(stage, "expected_revision"), pin(ciStage, "expected_revision"));
  assert.equal(pin(stage, "expected_sha256"), pin(ciStage, "expected_sha256"));
  assert.match(step("Checkout pinned Mobile input fixture").block, new RegExp(`ref: ${pin(ciStage, "expected_revision")}\n`, "u"));
  assert.match(step("Checkout pinned Mobile input fixture").block, /persist-credentials: false/u);
  for (const name of ["Checkout pinned Mobile input fixture", "Stage pinned Mobile input fixture", "Rebind derived ITX bindings"]) {
    assert.equal(ifCondition(step(name).block), COLLECT, name);
  }
  const rebind = step("Rebind derived ITX bindings").block;
  assert.match(rebind, /node tools\/datapack\/rebind-itx-promotion\.mjs --repository-root "\$\{GITHUB_WORKSPACE\}" --build-now "\$\(date -u \+%Y-%m-%dT%H:%M:%S\.000Z\)"/u);
  assert.doesNotMatch(rebind, /continue-on-error|\|\| true|DATA_GO_KR_SERVICE_KEY/u);
});
