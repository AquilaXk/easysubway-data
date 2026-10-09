import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const yml = readFileSync(new URL("../../.github/workflows/current-capital-topology-refresh.yml", import.meta.url), "utf8");
function stepBody(name) {
  const start = yml.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `missing workflow step: ${name}`);
  const end = yml.indexOf("\n      - name: ", start + 1);
  return yml.slice(start, end === -1 ? yml.length : end);
}
test("derived GitHub environment values use physical records", () => {
  for (const name of [
    "Derive immutable input identities from collector output",
    "Derive current ITX admission identity",
    "Derive current activation dependencies",
  ]) {
    const body = stepBody(name);
    assert.doesNotMatch(body, /process\.stdout\.write\([\s\S]*?\\\\n/);
    assert.match(body, /console\.log\(/);
  }
});
test("activation dependencies are validated after GitHub environment update", () => {
  const derive = stepBody("Derive current activation dependencies");
  const validate = stepBody("Validate current activation dependencies");
  assert.doesNotMatch(derive, /\$\{TOPOLOGY_INCHEON_ACCESSIBILITY_PATH\}/);
  assert.match(validate, /\[\[ -f "\$\{TOPOLOGY_INCHEON_ACCESSIBILITY_PATH\}" && ! -e "\$\{TOPOLOGY_REVERIFICATION_PATH\}" \]\]/);
  assert.ok(yml.indexOf("Derive current activation dependencies") < yml.indexOf("Validate current activation dependencies"));
  assert.ok(yml.indexOf("Validate current activation dependencies") < yml.indexOf("Activate current topology inputs exactly once"));
});
test("topology buildNow preserves its post-collection millisecond instant", () => {
  const derive = stepBody("Derive immutable input identities from collector output");
  assert.ok(yml.indexOf("Collect each official current topology input once") < yml.indexOf("Derive immutable input identities from collector output"));
  assert.match(derive, /console\.log\("TOPOLOGY_BUILD_NOW=" \+ new Date\(\)\.toISOString\(\)\);/);
  assert.doesNotMatch(derive, /new Date\(\)\.toISOString\(\)\.replace\(/);
});
test("an exact empty claim is reused without creating another claim", () => {
  const preflight = stepBody("Preflight immutable current topology identities");
  const create = stepBody("Create durable claim before provider access");
  const reuse = stepBody("Reuse an exact empty claim after provider failure");
  const collect = stepBody("Collect each official current topology input once");
  const commit = stepBody("Commit exactly four or five immutable current topology inputs");
  assert.match(preflight, /steps\.decision\.outputs\.state == 'REUSE_CLAIM'/);
  assert.doesNotMatch(create, /REUSE_CLAIM/);
  assert.match(reuse, /steps\.decision\.outputs\.state == 'REUSE_CLAIM'/);
  assert.match(reuse, /git rev-list --count HEAD\.\."origin\/\$\{branch\}"\)" == "1"/);
  assert.match(reuse, /git rev-parse "origin\/\$\{branch\}\^"\)" == "\$\(git rev-parse HEAD\)"/);
  assert.match(reuse, /Claim current topology refresh/);
  assert.match(reuse, /gh auth setup-git/);
  assert.match(reuse, /TOPOLOGY_BRANCH/);
  assert.match(reuse, /TOPOLOGY_MAIN_SHA/);
  assert.match(collect, /steps\.decision\.outputs\.state == 'REUSE_CLAIM'/);
  assert.match(commit, /git config user\.name "github-actions\[bot\]"[\s\S]*git config user\.email "41898282\+github-actions\[bot\]@users\.noreply\.github\.com"[\s\S]*git commit -m "Register current topology inputs"/);
});
test("pending full fan-in cannot reach a topology side effect", () => {
  const effectSteps = [
    "Recover a completed claimed refresh",
    "Create durable claim before provider access",
    "Reuse an exact empty claim after provider failure",
    "Collect each official current topology input once",
    "Prepare current ITX collection",
    "Collect current ITX timetable once",
    "Commit exactly four or five immutable current topology inputs",
    "Activate current topology inputs exactly once",
    "Create draft pull request",
  ];
  for (const name of effectSteps) {
    const body = stepBody(name);
    assert.match(body, /\n\s+if: \$\{\{[^\n]+steps\.decision\.outputs\.state/);
    assert.doesNotMatch(body, /PENDING_FULL_FAN_IN|outputs\.state\s*!=/);
  }
});
test("topology refresh workflow is a pinned, main-only, durable claim automation", () => {
  assert.match(yml, /cron: "47 \*\/2 \* \* \*"/); assert.match(yml, /github\.ref == 'refs\/heads\/main'/);
  assert.match(yml, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/); assert.match(yml, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/); assert.match(yml, /node-version: "24\.19\.0"/);
  assert.match(yml, /actions: read/); assert.match(yml, /contents: write/); assert.match(yml, /pull-requests: write/); assert.match(yml, /cancel-in-progress: false/); assert.match(yml, /persist-credentials: false/);
  assert.match(yml, /automation\/636-current-topology-refresh-\$\{GITHUB_RUN_ID\}/); assert.match(yml, /git config user\.name "github-actions\[bot\]"[\s\S]*git config user\.email "41898282\+github-actions\[bot\]@users\.noreply\.github\.com"[\s\S]*git commit --allow-empty -m "Claim current topology refresh"[\s\S]*git push origin "\$\{branch\}"[\s\S]*git switch --detach/);
  assert.match(yml, /git rev-list --count HEAD\.\."origin\/\$\{branch\}"\)" == "3"/); assert.match(yml, /Claim current topology refresh/); assert.match(yml, /Register current topology inputs/); assert.match(yml, /Activate current topology inputs/);
  assert.match(yml, /currentCapitalTopologyPreflight/); assert.match(yml, /git fetch --no-tags origin main[\s\S]*git rev-parse origin\/main/); assert.match(yml, /--candidate tools\/datapack\/release\/candidate-build-spec\.json/); assert.match(yml, /--current-main-sha/);
  assert.match(yml, /collect-capital-route-topology\.mjs --download/); assert.match(yml, /collect-incheon-station-info\.mjs --download/); assert.match(yml, /collect-incheon-timetable\.mjs --download[\s\S]*incheon-transit-station-info-\$\{station_stamp\}\.json/);
  const collectTopology = stepBody("Collect each official current topology input once");
  assert.match(collectTopology, /mkdir -p "\$\{TOPOLOGY_OPERATION_ROOT\}\/timetables"\n\s+node tools\/datapack\/collect-incheon-timetable\.mjs --download --topology-snapshot "\$\{TOPOLOGY_OPERATION_ROOT\}\/incheon-transit-station-info-\$\{station_stamp\}\.json" --output-dir "\$\{TOPOLOGY_OPERATION_ROOT\}\/timetables"/);
  assert.equal((collectTopology.match(/collect-incheon-timetable\.mjs --download/g) ?? []).length, 1);
  assert.match(yml, /environment: itx-current-collection/);
  assert.equal((yml.match(/run-current-itx-collection\.mjs/g) ?? []).length, 1);
  assert.match(yml, /guard-itx-current-collection-budget\.mjs/);
  const prepareItx = stepBody("Prepare current ITX collection");
  const collectItx = stepBody("Collect current ITX timetable once");
  assert.ok(yml.indexOf("Prepare current ITX collection") < yml.indexOf("Collect current ITX timetable once"));
  assert.match(prepareItx, /DATA_GO_KR_SERVICE_KEY must be a nonempty single line/);
  assert.match(prepareItx, /emit-station-catalog-pack\.mjs/);
  assert.match(prepareItx, /guard-itx-current-collection-budget\.mjs --output "\$\{TOPOLOGY_OPERATION_ROOT\}\/freshness\.json"/);
  assert.doesNotMatch(collectItx, /DATA_GO_KR_SERVICE_KEY must be a nonempty single line|emit-station-catalog-pack\.mjs|guard-itx-current-collection-budget\.mjs/);
  assert.match(prepareItx, /steps\.decision\.outputs\.itx_refresh_required == 'true'/);
  assert.match(collectItx, /steps\.decision\.outputs\.itx_refresh_required == 'true'[\s\S]*set \+e[\s\S]*collector_status=\$\?[\s\S]*\[\[ "\$\{collector_status\}" == "0" \|\| "\$\{collector_status\}" == "1" \]\][\s\S]*build-itx-current-topology-admission\.mjs/);
  assert.match(collectItx, /collection_input="\$\{TOPOLOGY_OPERATION_ROOT\}\/itx-completeness\.json"[\s\S]*if \[\[ "\$\{collector_status\}" == "1" \]\]; then collection_input="\$\{TOPOLOGY_OPERATION_ROOT\}\/itx-result\.json"; fi[\s\S]*--collection "\$\{collection_input\}"/);
  assert.match(collectItx, /run-current-itx-collection\.mjs[\s\S]*--freshness-output "\$\{TOPOLOGY_OPERATION_ROOT\}\/freshness\.json"/);
  assert.match(yml, /build-itx-current-topology-admission\.mjs[\s\S]*--collection[\s\S]*--coverage-contract tools\/datapack\/itx-cheongchun-coverage-contract\.json[\s\S]*--output/);
  assert.match(yml, /TOPOLOGY_BUILD_NOW/); assert.equal((yml.match(/activate-current-source-set\.mjs --topology-source-admission/g) ?? []).length, 2); assert.match(yml, /--check/);
  assert.doesNotMatch(yml, /--topology-only|--itx-current-admission|itx_args/);
  assert.match(yml, /registrationEvidence\.snapshotId/); assert.match(yml, /source_key="\$\{key\}_SOURCE"; source="\$\{!source_key\}"/); assert.match(yml, /itxRefreshRequired: process\.env\.ITX_REFRESH_REQUIRED === "true"/); assert.match(yml, /four-input topology claim has an ITX admission/); assert.match(yml, /five-input topology claim is missing its ITX admission/); assert.match(yml, /exactly four or five immutable current topology inputs/);
  const recovery = stepBody("Recover a completed claimed refresh");
  assert.match(recovery, /git diff --quiet HEAD "origin\/\$\{branch\}\^\^"/);
  assert.match(recovery, /git diff --name-only --diff-filter=ACMR "origin\/\$\{branch\}\^\^" "origin\/\$\{branch\}\^"/);
  assert.match(recovery, /git diff --name-only --diff-filter=ACMR "origin\/\$\{branch\}\^" "origin\/\$\{branch\}"/);
  assert.match(recovery, /topology input commit must change exactly four or five paths/);
  assert.match(recovery, /topology activation commit must change a nonempty subset of the four source admission paths/);
  assert.match(recovery, /capital-topology-reverification-\[0-9\]\{8\}/);
  assert.doesNotMatch(recovery, /exactly eleven or twelve paths/);
  const activate = stepBody("Activate current topology inputs exactly once");
  assert.match(activate, /topology activation must change a nonempty subset of the four source admission paths/);
  assert.match(activate, /grep -Fqx "\$\{TOPOLOGY_REVERIFICATION_PATH\}"/);
  assert.match(activate, /topology activation changed an unsupported path/);
  assert.ok(activate.indexOf('git commit -m "Activate current topology inputs"') < activate.indexOf("--topology-source-admission --check"));
  assert.ok(activate.indexOf("--topology-source-admission --check") < activate.indexOf('[[ -z "$(git diff --name-only)"'));
  assert.ok(activate.indexOf('[[ -z "$(git diff --name-only)"') < activate.indexOf('git push origin "${TOPOLOGY_BRANCH}"'));
  assert.doesNotMatch(activate, /exactly seven activation paths/);
  assert.doesNotMatch(yml, /- name: Verify current topology activation exactly once/);
  assert.match(stepBody("Activate current topology inputs exactly once"), /env:\n\s+GH_TOKEN: \$\{\{ github\.token \}\}/);
  const uploadItx = stepBody("Upload sanitized ITX review evidence");
  assert.match(uploadItx, /steps\.decision\.outputs\.itx_refresh_required == 'true'/);
  assert.match(uploadItx, /current-capital-topology-refresh-itx-review-\$\{\{ github\.run_id \}\}/);
  assert.match(uploadItx, /itx-result\.json[\s\S]*itx-completeness\.json[\s\S]*retention-days: 14/);
  assert.doesNotMatch(uploadItx, /provider-response|credential|secret|raw-response/i);
  assert.match(yml, /secrets\.DATA_GO_KR_SERVICE_KEY/);
  assert.match(yml, /Refs #636, #625/); assert.doesNotMatch(yml, /oci:|aws|retry|fallback|automerge|git push origin main/i);
});

// F4(#977): ITX 승격 workflow와 같은 KST 날 ITX 공급자 호출을 나눠 쓴다. 이미 수집됐으면 가드 실패(이슈)가 아니라 대기로 끝난다.
test("topology refresh는 판정 전에 같은 KST 날 ITX 수집 여부를 보고 이미 수집됐으면 대기한다", () => {
  const decision = stepBody("Decide whether current topology refresh is due");
  assert.match(decision, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  const probe = decision.indexOf('itx_collected="$(node tools/ci/guard-itx-current-collection-budget.mjs --probe)"');
  const decide = decision.indexOf("node tools/ci/decide-current-capital-topology-refresh.mjs");
  assert.ok(probe !== -1 && probe < decide, "the probe runs before the decision");
  assert.match(decision, /--itx-collected-today "\$\{itx_collected\}" --output "\$\{TOPOLOGY_DECISION\}"/);
  // WAIT_ITX_COLLECTED_TODAY는 어떤 쓰기·수집 step의 조건에도 들지 않으므로 아무것도 하지 않고 성공으로 끝난다.
  assert.equal(yml.includes("WAIT_ITX_COLLECTED_TODAY' &&"), false);
  assert.match(stepBody("Note current topology refresh waiting on today's ITX collection"), /steps\.decision\.outputs\.state == 'WAIT_ITX_COLLECTED_TODAY'/);
});

test("topology refresh ends at source admission and never commits candidate-side outputs (#862 결정 C)", () => {
  for (const candidateSide of ["release-request.json", "hash-evidence.json"]) {
    assert.equal(yml.includes(candidateSide), false, `${candidateSide} belongs to the nationwide candidate refresh`);
  }
  // 후보 spec은 due 판정 입력으로만 읽는다.
  assert.deepEqual(yml.match(/[^\n]*candidate-build-spec\.json[^\n]*/g)?.map((line) => line.trim().split(" ").slice(0, 3).join(" ")), [
    "node tools/ci/decide-current-capital-topology-refresh.mjs --inventory",
  ]);
  const activate = stepBody("Activate current topology inputs exactly once");
  assert.match(activate, /allowed_activation_paths=\(tools\/datapack\/source-inventory\.json tools\/datapack\/release\/capital-production-reviewed-pack\.json tools\/datapack\/release\/capital-production-canonical-pack\.json "\$\{TOPOLOGY_REVERIFICATION_PATH\}"\)/);
  const recovery = stepBody("Recover a completed claimed refresh");
  assert.match(recovery, /grep -Ev '\^\(tools\/datapack\/source-inventory\\\.json\|tools\/datapack\/release\/\(capital-production-reviewed-pack\\\.json\|capital-production-canonical-pack\\\.json\|capital-topology-reverification-\[0-9\]\{8\}\\\.json\)\)\$'/);
});

// #995: main이 움직여 current가 아니게 된 빈 claim은 어떤 판정도 보지 않아 다른 원장 쓰기 자동화를 영원히 막았다.
// 만든 run이 도는 claim은 기다리고, 빈 claim뿐인 고아는 보고(#926)한 뒤 지운다. 출력이 있는 claim은 지우지 않는다.
test("PR-less claims are classified from run and publication evidence before any reuse, recovery or new claim", () => {
  const decision = stepBody("Decide whether current topology refresh is due");
  const collect = decision.indexOf("node tools/ci/collect-automation-prs.mjs");
  const evidence = decision.indexOf('node tools/ci/claim-orphans.mjs --workflow current-capital-topology-refresh.yml --repository "${GITHUB_REPOSITORY}" --refs "${state_root}/claim-refs.txt" --prs "${state_root}/prs.json" --output "${state_root}/claim-evidence.json"');
  assert.ok(collect !== -1 && evidence > collect);
  assert.ok(decision.indexOf("decide-current-capital-topology-refresh.mjs") > evidence);
  assert.match(decision, /--claims "\$\{state_root\}\/claims\.json" --claim-evidence "\$\{state_root\}\/claim-evidence\.json" --repository/);
  assert.doesNotMatch(decision, /gh run list/);
  const cleanup = stepBody("Remove abandoned topology refresh claims named by the decision");
  assert.match(cleanup, /\n        if: \$\{\{ steps\.decision\.outputs\.cleanup_claims != '' \}\}\n/);
  assert.match(cleanup, /\n          CLEANUP_CLAIMS: \$\{\{ steps\.decision\.outputs\.cleanup_claims \}\}\n/);
  const script = cleanup.split("\n        run: |")[1];
  assert.doesNotMatch(script, /\$\{\{/);
  assert.match(script, /gh auth setup-git\n[\s\S]*node tools\/ci\/remove-orphan-claims\.mjs --workflow current-capital-topology-refresh\.yml --repository "\$\{GITHUB_REPOSITORY\}" --claims "\$\{CLEANUP_CLAIMS\}" --refs "\$\{RUNNER_TEMP\}\/current-capital-topology-refresh\/claim-refs\.txt"/);
  assert.doesNotMatch(script, /git push origin --delete/);
  const running = stepBody("Note current topology refresh waiting on a running producer");
  assert.match(running, /\n        if: \$\{\{ steps\.decision\.outputs\.state == 'CLAIM_IN_PROGRESS' \}\}\n/);
  const at = (name) => yml.indexOf(`      - name: ${name}\n`);
  assert.ok(at("Decide whether current topology refresh is due") < at("Remove abandoned topology refresh claims named by the decision"));
  assert.ok(at("Remove abandoned topology refresh claims named by the decision") < at("Recover a completed claimed refresh"));
  assert.ok(at("Remove abandoned topology refresh claims named by the decision") < at("Create durable claim before provider access"));
  assert.ok(at("Remove abandoned topology refresh claims named by the decision") < at("Preflight immutable current topology identities"));
});
// #1064: 실패한 run이 자기 빈 claim을 같은 run에서 지운다. 반복 실패하는 topology 갱신이 후보 갱신의 원장 writer 대기를 매 주기 새로 걸지 못하게 한다.
test("a failed run removes its own empty claim before the final failure report", () => {
  const release = stepBody("Remove this failed run's empty topology claim");
  assert.match(release, /if: \$\{\{ failure\(\) && env\.TOPOLOGY_BRANCH != '' \}\}/);
  assert.ok(yml.indexOf("Remove this failed run's empty topology claim") < yml.indexOf("Report refresh failure as an issue"), "정리 step의 실패도 마지막 실패 보고가 덮는다");
  assert.equal(yml.trimEnd().lastIndexOf("\n      - name: "), yml.lastIndexOf("\n      - name: Report refresh failure as an issue"), "실패 보고가 마지막 step이다");
  assert.match(release, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(release, /gh auth setup-git/);
  assert.match(release, /git ls-remote origin "refs\/heads\/\$\{TOPOLOGY_BRANCH\}"/);
  assert.match(release, /node tools\/ci\/remove-orphan-claims\.mjs --workflow current-capital-topology-refresh\.yml --repository "\$\{GITHUB_REPOSITORY\}" --claims "\$\{TOPOLOGY_BRANCH\}" --refs "\$\{claim_refs\}" --self-run-id "\$\{GITHUB_RUN_ID\}"/);
});
test("the self-run claim release leaves deletion rules to the tool", () => {
  const release = stepBody("Remove this failed run's empty topology claim");
  // 도구가 빈 claim 하나(출력·PR 없음)만 지운다. workflow는 claim 브랜치를 알 때만 부르고 직접 지우지 않는다.
  assert.doesNotMatch(release, /--force|git push|git branch -D|gh api -X DELETE/);
  assert.doesNotMatch(release, /continue-on-error/);
});
