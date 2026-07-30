import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const yml = readFileSync(path.join(root, ".github/workflows/datapack-release.yml"), "utf8");

test("product datapack 정책 변경은 release workflow를 실행한다", () => {
  assert.match(yml, /paths:[\s\S]*release\/product-gates\/datapack-freshness-sla\.json/);
  assert.match(yml, /paths:[\s\S]*release\/product-gates\/production-datapack-scope\.json/);
});

// 외부 yaml 의존성 없이(리포는 node 내장 --test만 사용) workflow_dispatch 입력 이름을
// 들여쓰기로 추출한다: "    inputs:" 다음, 4칸 이하 들여쓰기로 블록이 끝나기 전까지의 6칸 키.
function workflowDispatchInputNames(source) {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => /^ {4}inputs:\s*$/.test(l));
  assert.notEqual(start, -1, "workflow_dispatch.inputs 블록을 찾지 못함");
  const names = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") continue;
    if (/^ {0,4}\S/.test(l)) break; // 들여쓰기 4칸 이하 = inputs 블록 종료
    const m = l.match(/^ {6}(\w+):/); // 6칸 들여쓰기 = 입력 이름
    if (m) names.push(m[1]);
  }
  return names;
}

test("workflow_dispatch 입력은 mode·targetChannel·modeArgs 3개로 통합돼 한도(10) 이하다", () => {
  const names = workflowDispatchInputNames(yml);
  assert.ok(names.length <= 10, `입력 ${names.length}개 — 한도 초과`);
  assert.deepEqual([...names].sort(), ["mode", "modeArgs", "targetChannel"]);
  // modeArgs는 required이고 description에 복붙용 예시(buildSpecPath 포함)를 담는다.
  assert.match(yml, /modeArgs:[\s\S]*?required:\s*true/);
  assert.match(yml, /modeArgs:[\s\S]*?buildSpecPath/);
});

test("modeArgs 파싱 스텝이 개별 인자를 output으로 펼친다", () => {
  const parseStep = yml.match(/- name: Data Pack Release \/ Parse modeArgs[\s\S]*?\n\s+- name:/)?.[0];
  assert.ok(parseStep, "Parse modeArgs 스텝을 찾지 못함");
  assert.match(parseStep, /id:\s*args/);
  assert.match(parseStep, /modeArgs/);
  assert.match(parseStep, /buildSpecPath/);
  assert.match(parseStep, /releaseRequestId/);
  assert.match(parseStep, /sourceGovernanceEvaluationAt/);
});

test("modeArgs 파싱 스텝은 비-JSON·개행 주입을 방어한다", () => {
  // JSON.parse 실패·비객체 입력 → 명확한 실패(try/catch + object 검증)
  assert.match(yml, /modeArgs must be a JSON object/);
  // GITHUB_OUTPUT 개행 주입 차단 — 값에 개행이 있으면 거부
  assert.match(yml, /must not contain newlines/);
});

test("production-publish는 파일 전용 release request 입력과 !cancelled() 콜백 스텝을 가진다", () => {
  // release request의 단일 원본은 리포 파일이다(오너 결정 2026-07-26, #2565) — backend 조회 GET은 없어야 한다.
  assert.doesNotMatch(yml, /release-requests\/\$\{?\{?.*releaseRequestId/);
  assert.match(yml, /release-callbacks/); // 콜백 POST
  assert.match(yml, /build-release-callback\.mjs/);
  assert.match(yml, /!cancelled\(\)\s*&&/); // 콜백 조건에 !cancelled()
  assert.match(yml, /manifestSha256/);
  // 콜백 조건은 production-publish 스텝 출력 기준이어야 한다 — 비-production 모드에선 빈값
  assert.match(yml, /steps\.production-publish\.outputs\.manifestSha256/);
  // evidence-bundle 출력을 콜백 게이트로 사용하면 release-candidate에서도 발사 → 금지
  assert.doesNotMatch(yml, /steps\.evidence-bundle\.outputs\.manifestSha256/);
});

test("production-publish는 pack 빌드 전에 release request ↔ build spec 결속을 확인한다", () => {
  const verifyStep = yml.match(
    /- name: Data Pack Release \/ Verify release request binding[\s\S]*?\n\s+- name:/,
  )?.[0];
  assert.ok(verifyStep, "release request binding 검증 스텝을 찾지 못함");
  assert.match(verifyStep, /if:\s*\$\{\{ steps\.release-mode\.outputs\.mode == 'production-publish' \}\}/);
  assert.match(verifyStep, /verify-release-request-binding\.mjs/);
  assert.match(verifyStep, /--build-spec "\$\{EASYSUBWAY_DATAPACK_BUILD_SPEC_PATH\}"/);
  assert.match(verifyStep, /--release-request/);
  // release request 경로는 리포 파일 하나로만 해석한다(#2565) — API 조회 경로 fallback은 없어야 한다.
  assert.match(verifyStep, /release_request_path="\$\{EASYSUBWAY_DATAPACK_RELEASE_REQUEST_PATH:-\}"/);
  assert.doesNotMatch(verifyStep, /RELEASE_REQUEST_PATH:-\$\{EASYSUBWAY_DATAPACK_RELEASE_REQUEST_PATH:-\}/);
  // approvalId ↔ 요청 ID 대조는 인라인 검사가 파일 입력 경로에만 걸어 두었던 항목이다.
  assert.match(verifyStep, /--expected-approval-id "\$\{EASYSUBWAY_DATAPACK_RELEASE_REQUEST_ID\}"/);
  // 사전 조건 실패는 exit code만 남기지 말고 원인을 로그에 남겨야 한다.
  assert.match(verifyStep, /production-publish requires a release request file path[^\n]*>&2/);
  assert.match(verifyStep, /release request not found: \$\{release_request_path\}"? >&2/);
  // release request 경로가 확정된 뒤, 그러나 pack을 빌드하고 판정하기 전에 놓여야 앞당긴 fail-closed가 된다.
  const stepAt = (name) => yml.indexOf(`- name: ${name}`);
  const resolveRequest = stepAt("Data Pack Release / Validate release mode inputs");
  const verify = stepAt("Data Pack Release / Verify release request binding");
  const buildPacks = stepAt("Data Pack Release / Build data packs");
  const decide = stepAt("Data Pack Release / Decide conditional publish");
  assert.ok(resolveRequest >= 0, "release mode 해석 스텝을 찾지 못함");
  assert.ok(verify > resolveRequest, "결속 검증은 release request 경로 확정 뒤여야 한다");
  assert.ok(buildPacks > verify, "결속 검증은 pack 빌드 전이어야 한다");
  assert.ok(decide > buildPacks, "판정은 pack 빌드 뒤여야 한다");
  // 삭제된 `Fetch release request`를 앵커로 쓸 수 없게 되면서 위 `verify > resolveRequest`는
  // 느슨해졌다(release-mode는 job 앞쪽 스텝). 인접성 대신 "결속 검증이 release request 경로의
  // 첫 소비자"라는 성질로 원래 계약 강도를 되살린다 — 이게 앞당긴 fail-closed의 실제 내용이다.
  const consumers = [...yml.matchAll(/release_request_path="\$\{EASYSUBWAY_DATAPACK_RELEASE_REQUEST_PATH:-\}"/g)]
    .map((m) => m.index);
  assert.equal(consumers.length, 3, "release request 경로 소비 지점은 결속 검증·판정·최종 판정 3곳이다");
  assert.ok(
    consumers[0] > verify && consumers[0] < buildPacks,
    "release request 경로의 첫 소비자는 결속 검증 스텝이어야 한다",
  );
  assert.ok(consumers[1] > buildPacks, "나머지 소비 지점은 pack 빌드 뒤에 있어야 한다");
});

test("production-publish의 release request 입력은 리포 파일 전용이고 API 조회 경로가 없다", () => {
  // #2565: backend 레코드는 승인 권위가 아니다(오너 결정 2026-07-26). git 파일과 갈라진 레코드가
  // release 입력이 될 수 없도록 조회 스텝·ID-only 분기를 workflow에서 제거했다.
  assert.doesNotMatch(yml, /- name: Data Pack Release \/ Fetch release request/);
  assert.doesNotMatch(yml, /admin\/api\/datapack\/release-requests/);
  assert.doesNotMatch(yml, /ID만 있으면 release request는 API에서 조회한다/);
  // 조회 스텝이 GITHUB_ENV에 심던 RELEASE_REQUEST_PATH fallback도 모든 소비 지점에서 사라져야 한다.
  assert.doesNotMatch(yml, /\$\{RELEASE_REQUEST_PATH:-/);

  const releaseModeStep = yml.match(
    /- name: Data Pack Release \/ Validate release mode inputs[\s\S]*?\n\s+- name:/,
  )?.[0];
  assert.ok(releaseModeStep, "release mode 해석 스텝을 찾지 못함");
  // 경로 부재는 exit code만 남기지 말고 원인을 지목하며 fail-closed여야 한다.
  assert.match(
    releaseModeStep,
    /production-publish requires a release request file path \(modeArgs\.releaseRequestPath\)[^\n]*>&2/,
  );
  assert.match(releaseModeStep, /if \[\[ -z "\$\{release_request_path\}" \]\]; then[\s\S]*?exit 1/);
  // 경로는 있고 파일이 없는 경우도 침묵으로 죽지 않는다(스케줄 분기·결속 검증 스텝과 대칭).
  // `scheduled release request not found:`의 부분 일치로 공허해지지 않도록 echo까지 묶어 대조한다.
  assert.match(releaseModeStep, /echo "release request not found: \$\{release_request_path\}" >&2/);
  assert.doesNotMatch(releaseModeStep, /^\s*test -f "\$\{release_request_path\}"\s*$/m);

  // build spec과 대칭인 release request 경로 가드: 리포 상대 경로 강제 + fixture 마커 금지.
  // 스케줄 변수 경로(파일을 읽기 전)와 dispatch 입력 양쪽에 걸려야 한다.
  assert.match(releaseModeStep, /assert_release_request_path\(\) \{/);
  assert.match(releaseModeStep, /release request path must be a repo-relative path: \$1"? >&2/);
  assert.match(releaseModeStep, /\$1" == \/\* \|\| "\$1" == \*\.\.\*/);
  assert.match(releaseModeStep, /"\$1" =~ \(fixture\|debug\|demo\|sample\) \|\| "\$1" == tools\/datapack\/fixtures\/\*/);
  const guardCalls = releaseModeStep.match(/assert_release_request_path "\$\{release_request_path\}"/g) ?? [];
  assert.equal(guardCalls.length, 2, "경로 가드는 스케줄 분기와 release 모드 양쪽에서 호출돼야 한다");
  // 스케줄 분기는 파일을 읽기(-f·JSON 파싱) 전에 경로를 먼저 거절해야 한다.
  const scheduledGuard = releaseModeStep.indexOf('assert_release_request_path "${release_request_path}"');
  const scheduledExists = releaseModeStep.indexOf('scheduled release request not found');
  assert.ok(
    scheduledGuard >= 0 && scheduledExists > scheduledGuard,
    "스케줄 분기의 경로 가드는 파일 존재 확인보다 앞서야 한다",
  );

  // EASYSUBWAY_DATAPACK_WORKFLOW_TOKEN은 rollback approval 조회 하나에만 남는다(별도 아티팩트).
  const tokenUses = yml.match(/EASYSUBWAY_DATAPACK_WORKFLOW_TOKEN/g) ?? [];
  assert.equal(tokenUses.length, 1, "workflow token은 rollback approval 조회에만 남아야 한다");
  const rollbackApprovalStep = yml.match(
    /- name: Data Pack Release \/ Fetch rollback approval[\s\S]*?\n\s+- name:/,
  )?.[0];
  assert.ok(rollbackApprovalStep, "rollback approval 조회 스텝을 찾지 못함");
  assert.match(rollbackApprovalStep, /EASYSUBWAY_DATAPACK_WORKFLOW_TOKEN/);

  // 판정·최종 판정 스텝도 같은 단일 env만 해석한다.
  for (const stepName of [
    "Data Pack Release / Decide conditional publish",
    "Data Pack Release / Finalize production decision",
  ]) {
    const step = yml.match(
      new RegExp(`- name: ${stepName.replace(/\//g, "\\/")}[\\s\\S]*?\\n\\s+- name:`),
    )?.[0];
    assert.ok(step, `${stepName} 스텝을 찾지 못함`);
    assert.match(
      step,
      /release_request_path="\$\{EASYSUBWAY_DATAPACK_RELEASE_REQUEST_PATH:-\}"/,
      `${stepName}는 파일 경로 env만 해석해야 한다`,
    );
  }
});

test("production callback은 bounded sender 증적을 항상 보존하고 실패를 fail-closed한다", () => {
  const productionPublishStep = yml.match(
    /- name: Data Pack Release \/ Publish staged data packs to object storage[\s\S]*?\n\s+- name:/,
  )?.[0];
  assert.ok(productionPublishStep, "production publish 스텝을 찾지 못함");
  assert.match(productionPublishStep, /validatorStatus=\$\{bundle\.validatorStatus\}/);
  assert.match(productionPublishStep, /routeRegressionStatus=\$\{bundle\.strictRouteRegressionStatus\}/);

  const callbackStep = yml.match(
    /- name: Data Pack Release \/ Send release callback[\s\S]*?\n\s+- name:/,
  )?.[0];
  assert.ok(callbackStep, "release callback 스텝을 찾지 못함");
  assert.match(callbackStep, /id:\s*callback-delivery/);
  assert.match(callbackStep, /continue-on-error:\s*true/);
  assert.match(callbackStep, /send-release-callback\.mjs/);
  assert.doesNotMatch(callbackStep, /--(?:payload|output|github-output)/);
  assert.doesNotMatch(
    callbackStep,
    /curl|Authorization|Bearer|set\s+-x|(?:echo|printf|printenv)[^\n]*(?:HMAC|TOKEN|PRIVATE_KEY)/i,
  );

  const uploadStep = yml.match(
    /- name: Data Pack Release \/ Upload callback delivery evidence[\s\S]*?\n\s+- name:/,
  )?.[0];
  assert.ok(uploadStep, "callback delivery 증적 업로드 스텝을 찾지 못함");
  assert.match(uploadStep, /always\(\)/);
  assert.match(uploadStep, /EASYSUBWAY_DATAPACK_CALLBACK_DELIVERY/);

  const gateStep = yml.match(
    /- name: Data Pack Release \/ Require confirmed callback delivery[\s\S]*?\n\s+- name:/,
  )?.[0];
  assert.ok(gateStep, "callback delivery 확인 gate를 찾지 못함");
  assert.match(gateStep, /steps\.callback-delivery\.outputs\.state/);
  assert.match(gateStep, /CALLBACK_RECONCILIATION_REQUIRED/);
  assert.match(gateStep, /exit\s+1/);
});

test("게시 workflow의 동시 실행은 기존 publish run을 취소하지 않는다", () => {
  assert.match(yml, /concurrency:\s*[\s\S]*?cancel-in-progress:\s*false/);
});

test("production request identity는 manifest 밖의 서명된 immutable binding으로 게시한다", () => {
  assert.match(yml, /build-release-request-binding\.mjs/);
  assert.match(yml, /--release-request-binding/);
  assert.match(yml, /EASYSUBWAY_DATAPACK_RELEASE_REQUEST_BINDING/);
  const buildStep = yml.match(
    /- name: Data Pack Release \/ Build data packs[\s\S]*?\n\s+- name:/,
  )?.[0];
  assert.ok(buildStep, "data pack build 스텝을 찾지 못함");
  assert.doesNotMatch(buildStep, /--release-request-id/);
  const finalize = yml.indexOf("Data Pack Release / Finalize production decision");
  const publishBinding = yml.indexOf("Data Pack Release / Publish finalized release request binding");
  const callback = yml.indexOf("Data Pack Release / Send release callback");
  assert.ok(finalize >= 0 && publishBinding > finalize && callback > publishBinding);
  const bindingStep = yml.slice(publishBinding, callback);
  assert.match(bindingStep, /id:\s*release-request-binding/);
  assert.match(bindingStep, /--only release-request-binding/);
  assert.match(bindingStep, /--verify-only/);
  const verifiedBindingArtifact = yml.slice(publishBinding,
    yml.indexOf("Data Pack Release / Send release callback"));
  assert.match(verifiedBindingArtifact,
    /Data Pack Release \/ Upload verified release request binding/);
  assert.match(verifiedBindingArtifact,
    /if:\s*\$\{\{ steps\.release-request-binding\.outcome == 'success' \}\}/);
  assert.match(verifiedBindingArtifact,
    /name:\s*easysubway-published-release-request-binding-\$\{\{ github\.sha \}\}/);
  assert.match(verifiedBindingArtifact, /path:\s*\$\{\{ runner\.temp \}\}\/easysubway-datapack-stage\/catalog\/release-request-binding\.json/);
  const callbackStep = yml.slice(callback, yml.indexOf("Data Pack Release / Upload callback delivery evidence"));
  assert.match(callbackStep, /steps\.release-request-binding\.outcome == 'success'/);
  assert.match(callbackStep, /'BLOCKED_EXTERNAL'/);
  assert.match(callbackStep, /steps\.final-release-decision\.outputs\.outcome != 'PUBLISHED_AND_VERIFIED' && 'FAIL'/);
});

test("NO_CHANGE_VALID 재실행은 current manifest binding과 callback을 복구한다", () => {
  const noChangeIdentity = yml.match(
    /- name: Data Pack Release \/ Prepare no-change release identity[\s\S]*?\n\s+- name:/,
  )?.[0];
  assert.ok(noChangeIdentity, "no-change release identity 스텝을 찾지 못함");
  assert.match(noChangeIdentity, /steps\.release-decision\.outputs\.outcome == 'NO_CHANGE_VALID'/);
  assert.match(noChangeIdentity, /EASYSUBWAY_DATAPACK_CURRENT_MANIFEST/);
  assert.match(noChangeIdentity, /manifestSha256/);
  assert.match(noChangeIdentity, /releaseSequence/);

  const remoteValidation = yml.match(
    /- name: Data Pack Release \/ Validate published remote artifact[\s\S]*?\n\s+- name:/,
  )?.[0];
  assert.ok(remoteValidation, "remote validation 스텝을 찾지 못함");
  assert.match(remoteValidation, /steps\.no-change-release\.outputs\.manifestSha256/);

  const binding = yml.match(
    /- name: Data Pack Release \/ Publish finalized release request binding[\s\S]*?\n\s+- name:/,
  )?.[0];
  assert.ok(binding, "release request binding 스텝을 찾지 못함");
  assert.match(binding, /steps\.final-release-decision\.outcome == 'success'/);
  assert.match(binding, /steps\.final-release-decision\.outputs\.outcome == 'NO_CHANGE_VALID'/);
  assert.match(binding, /FINAL_RELEASE_OUTCOME: \$\{\{ steps\.final-release-decision\.outputs\.outcome \}\}/);
  assert.match(binding, /if \[\[ "\$\{FINAL_RELEASE_OUTCOME\}" == "NO_CHANGE_VALID" \]\]/);
  assert.match(binding, /release_outcome="\$\{FINAL_RELEASE_OUTCOME\}"/);
  assert.doesNotMatch(binding.match(/run: \|[\s\S]*/)?.[0] ?? "", /\$\{\{ steps\.final-release-decision/);
  assert.match(binding, /EASYSUBWAY_DATAPACK_CURRENT_MANIFEST/);
  assert.match(binding, /--release-outcome/);
  assert.match(binding, /NO_CHANGE_VALID/);

  const callback = yml.match(
    /- name: Data Pack Release \/ Send release callback[\s\S]*?\n\s+- name:/,
  )?.[0];
  assert.ok(callback, "release callback 스텝을 찾지 못함");
  assert.match(callback, /steps\.no-change-release\.outputs\.releaseSequence/);
  assert.match(callback, /steps\.no-change-release\.outputs\.manifestSha256/);

  const noChangeValidationGate = yml.match(
    /- name: Data Pack Release \/ Require successful no-change remote validation[\s\S]*?\n\s+- name:/,
  )?.[0];
  assert.ok(noChangeValidationGate, "no-change remote validation gate를 찾지 못함");
  assert.match(noChangeValidationGate, /steps\.remote-validation\.outcome != 'success'/);
  assert.match(noChangeValidationGate, /exit 1/);
});

test("coverage gap 스텝은 release 모드에서만 production provenance와 release-scope를 배선한다", () => {
  // release-scope 게이트는 게시 범위(pilot region/operator × capitalPilotTargets domains) 내 gap만 차단한다(#1999).
  assert.match(yml, /--release-scope release\/product-gates\/production-datapack-scope\.json/);
  // release 모드에서만 production manifest/provenance와 --release-scope를 붙인다.
  // exploratory fixture는 inventory 기준으로 전량 MISSING을 기록하며 --allow-gaps로 통과해야 한다.
  assert.match(
    yml,
    /EASYSUBWAY_DATAPACK_RELEASE_MODE\}" =~ \^\(release-candidate\|production-publish\)\$ \]\]; then\s*\n\s*coverage_args\+=\(\s*--manifest "\$\{EASYSUBWAY_DATAPACK_OUTPUT\}\/current\.json"\s*--provenance "\$\{EASYSUBWAY_DATAPACK_OUTPUT\}\/current\.provenance\.json"\s*--release-scope/,
  );
  // 전국 gap 산출은 유지 — nationwide-coverage-targets.json을 계속 targets로 쓴다.
  assert.match(yml, /--targets tools\/datapack\/nationwide-coverage-targets\.json/);
  const coverageStep = yml.match(/- name: Data Pack Release \/ Write coverage gap evidence[\s\S]*?\n\s+- name:/)?.[0];
  assert.ok(coverageStep, "coverage gap evidence 스텝을 찾지 못함");
  const baseArgs = coverageStep.match(/coverage_args=\([\s\S]*?\n\s*\)/)?.[0];
  assert.ok(baseArgs, "coverage_args 기본 배열을 찾지 못함");
  assert.doesNotMatch(baseArgs, /--manifest|--provenance|--release-scope/);
  // release 모드 --allow-gaps 금지 로직은 불변이어야 한다.
  assert.match(yml, /release mode cannot use --allow-gaps/);
});

test("release evidence는 canonical launch denominator report identity와 decision을 소비한다", () => {
  const evidenceStep = yml.match(
    /- name: Data Pack Release \/ Write release evidence bundle[\s\S]*?\n\s+- name:/,
  )?.[0];
  assert.ok(evidenceStep, "release evidence bundle 스텝을 찾지 못함");
  assert.match(evidenceStep, /EASYSUBWAY_LAUNCH_DENOMINATOR_REPORT/);
  assert.match(evidenceStep, /buildLaunchCandidateBinding/);
  assert.match(evidenceStep, /buildLaunchDenominatorReport/);
  assert.match(evidenceStep, /launchDenominatorReportRaw/);
  assert.match(evidenceStep, /verifiedAccessibilityScopeSha256:\s*launchReport\.scopes\.verifiedAccessibilityScope\.sha256/);
  assert.match(evidenceStep, /launchScopeSha256:\s*launchReport\.scopes\.routingLaunchScope\.sha256/);
  assert.match(evidenceStep, /nationwideRoadmapScopeSha256:\s*launchReport\.scopes\.nationwideRoadmapScope\.sha256/);
  assert.match(evidenceStep, /identityLinkageMatrixSha256:\s*launchReport\.identityLinkage\.matrixSha256/);
  assert.match(evidenceStep, /launchDenominatorDecision:\s*launchReport\.decision/);
  assert.match(evidenceStep, /launchDenominatorReportSha256:\s*hashBytes\(launchDenominatorReportRaw\)/);
  assert.doesNotMatch(evidenceStep, /scopeId:\s*"capital_pilot_android_v1"/);
  assert.match(yml, /--scope release\/product-gates\/production-datapack-scope\.json/);
  const normalValidationStep = yml.match(
    /- name: Data Pack Release \/ Validate release evidence bundle[\s\S]*?\n\s+- name:/,
  )?.[0];
  assert.ok(normalValidationStep, "normal release evidence validation 스텝을 찾지 못함");
  const publishValidationStep = yml.match(
    /- name: Data Pack Release \/ Publish staged data packs to object storage[\s\S]*?\n\s+- name:/,
  )?.[0];
  assert.ok(publishValidationStep, "production publish validation 스텝을 찾지 못함");
  for (const [label, step] of [
    ["normal", normalValidationStep],
    ["publish", publishValidationStep],
  ]) {
    assert.match(step, /--scope release\/product-gates\/production-datapack-scope\.json/, `${label} scope binding`);
    assert.match(step, /--launch-report "?\$\{EASYSUBWAY_LAUNCH_DENOMINATOR_REPORT\}"?/, `${label} report binding`);
    assert.match(step, /--build-spec/, `${label} build spec binding`);
    assert.match(step, /--manifest/, `${label} manifest binding`);
    assert.match(step, /--source-evidence/, `${label} source evidence binding`);
  }
});

test("워크플로는 rollout-update 모드·publish-rollout 스텝을 가지고 빌드 스텝을 pointer-only로 게이트한다", () => {
  assert.match(yml, /rollout-update/);
  assert.match(yml, /publish-rollout\.mjs/);
  assert.match(yml, /rolloutPercentage/);
  assert.match(yml, /rolloutTargetSequence/);
  assert.match(yml, /is-pointer-only/);            // 빌드 스텝 게이팅 output
  assert.doesNotMatch(yml, /mode != 'rollback'/);  // 구 게이트가 pointer-only로 통합됨
  const rolloutStep = yml.match(
    /- name: Data Pack Release \/ Rollout update pointer swap[\s\S]*?\n\s+- name:/,
  )?.[0];
  assert.ok(rolloutStep, "rollout update 스텝을 찾지 못함");
  assert.match(rolloutStep, /CALLBACK_RECONCILIATION_REQUIRED/);
  assert.match(rolloutStep, /!\s*\[\[.*ROLLOUT_PERCENTAGE.*\^\[0-9\]\+\$/);
  assert.match(rolloutStep, /ROLLOUT_PERCENTAGE\s*>\s*10\b/);
});

test("rollback 모드는 trusted approval·원격 catalog inventory와 sanitized report를 강제한다", () => {
  const parseStep = yml.match(/- name: Data Pack Release \/ Parse modeArgs[\s\S]*?\n\s+- name:/)?.[0];
  assert.ok(parseStep, "Parse modeArgs 스텝을 찾지 못함");
  for (const field of [
    "rollbackFailedSequence",
    "rollbackPublishedAt",
    "rollbackExpiresAt",
  ]) {
    assert.match(parseStep, new RegExp(field));
  }
  for (const untrustedField of ["rollbackCatalogSequences", "rollbackApprovedByRole", "rollbackApprovedAt", "rollbackReasonCode"]) {
    assert.doesNotMatch(parseStep, new RegExp(untrustedField));
  }
  const approvalStep = yml.match(/- name: Data Pack Release \/ Fetch rollback approval[\s\S]*?\n\s+- name:/)?.[0];
  assert.ok(approvalStep, "trusted rollback approval 조회 스텝을 찾지 못함");
  assert.match(approvalStep, /rollback-approvals/);
  assert.match(approvalStep, /Authorization: Bearer/);
  const rollbackStep = yml.match(/- name: Data Pack Release \/ Publish monotonic rescue release[\s\S]*?\n\s+- name:/)?.[0];
  assert.ok(rollbackStep, "monotonic rescue publish 스텝을 찾지 못함");
  assert.match(rollbackStep, /--failed-sequence/);
  assert.match(rollbackStep, /--approval/);
  assert.match(rollbackStep, /--published-at/);
  assert.match(rollbackStep, /--expires-at/);
  assert.match(rollbackStep, /--manifest-output/);
  assert.match(rollbackStep, /--evidence-output/);
  assert.doesNotMatch(rollbackStep, /--reason|--idempotency-key/);
  assert.doesNotMatch(rollbackStep, /--catalog-sequences/);
  assert.ok(yml.indexOf("Fetch rollback approval") < yml.indexOf("Publish monotonic rescue release"));
  assert.match(yml, /Data Pack Release \/ Upload rollback rescue evidence/);
  assert.match(yml, /easysubway-datapack-rollback-rescue-/);
  assert.match(yml, /EASYSUBWAY_DATAPACK_ROLLBACK_MANIFEST/);
});

test("production publish는 canonical decision의 write 허용 뒤에만 실행된다", () => {
  assert.match(yml, /id:\s*release-decision/);
  assert.match(yml, /node tools\/datapack\/decide-datapack-release\.mjs/);
  const publishStep = yml.match(/- name: Data Pack Release \/ Publish staged data packs to object storage[\s\S]*?\n\s+- name:/)?.[0];
  assert.ok(publishStep, "production publish 스텝을 찾지 못함");
  assert.match(publishStep, /steps\.release-decision\.outputs\.productionWriteAllowed == 'true'/);
  assert.match(yml, /production decision did not authorize executable run/);
  assert.match(yml, /decision\.outcome === "NO_CHANGE_VALID"/);
  assert.match(yml, /decision\.outcome === "PUBLISH_REQUIRED" && decision\.productionWriteAllowed === true/);
});

test("scheduled publish는 명시적 opt-in과 승인된 입력 경로 없이는 exploratory로 남는다", () => {
  assert.match(yml, /DATAPACK_SCHEDULED_PUBLISH_ENABLED/);
  assert.match(yml, /github\.event_name == 'schedule' && vars\.DATAPACK_SCHEDULED_PUBLISH_ENABLED == 'true'/);
  assert.doesNotMatch(yml, /vars\.EASYSUBWAY_DATAPACK_SCHEDULED_/);
  assert.match(yml, /SCHEDULED_BUILD_SPEC_PATH/);
  // #2565: 스케줄 publish도 리포 파일을 읽는다 — API 조회를 전제한 ID 변수는 더 이상 참조하지 않는다.
  assert.match(yml, /SCHEDULED_RELEASE_REQUEST_PATH: \$\{\{ vars\.DATAPACK_SCHEDULED_RELEASE_REQUEST_PATH \}\}/);
  assert.doesNotMatch(yml, /DATAPACK_SCHEDULED_RELEASE_REQUEST_ID/);
  assert.match(yml, /release_request_path="\$\{SCHEDULED_RELEASE_REQUEST_PATH:-\}"/);
  // 승인 식별자는 그 파일의 approvalId에서 파생한다(별도 ID 입력 없음).
  assert.match(yml, /scheduled release request not found: \$\{release_request_path\}"? >&2/);
  assert.match(yml, /release_request_id="\$\(RELEASE_REQUEST_FILE="\$\{release_request_path\}" node -e/);
  assert.match(yml, /scheduled release request approvalId is required/);
  // 파생값은 GITHUB_ENV·GITHUB_OUTPUT으로 흘러가므로 개행 주입을 막는 단일 토큰 형식 검사가 필수다.
  // (같은 파일 "Parse modeArgs"의 `must not contain newlines` 가드와 같은 수준)
  assert.match(yml, /!\/\^\[A-Za-z0-9\._-\]\+\\?\$\/\.test\(request\.approvalId\)/);
  assert.match(yml, /scheduled release request approvalId must be a single \[A-Za-z0-9\._-\] token/);
  // 비-JSON 파일은 raw SyntaxError 스택·파일 내용 대신 한 줄 진단으로 종료한다.
  assert.match(yml, /scheduled release request is not valid JSON: ' \+ file/);
  assert.match(yml, /try \{\s*\n\s*request = JSON\.parse\(fs\.readFileSync\(file, 'utf8'\)\);\s*\n\s*\} catch \{/);
  assert.match(yml, /SCHEDULED_ANDROID_EVIDENCE_PATH/);
  assert.match(yml, /SCHEDULED_STRICT_ROUTE_REGRESSION_PATH/);
  // 변수군이 없으면 기존과 동일하게 fail-closed로 남는다(활성화는 별도 오너 결정).
  assert.match(yml, /-z "\$\{release_request_path\}"[\s\S]*?scheduled production publish requires configured approval evidence/);
  assert.doesNotMatch(yml, /SCHEDULED_SOURCE_GOVERNANCE_EVALUATION_AT/);
  assert.match(yml, /scheduled production publish requires a fresh protection evidence pipeline/);
  assert.match(yml, /steps\.release-mode\.outputs\.release_request_id/);
});

test("release build는 source snapshot freshness를 build 전에 fail closed로 검증한다", () => {
  const freshnessStep = yml.match(
    /- name: Data Pack Release \/ Validate source snapshot freshness[\s\S]*?\n\s+- name:/,
  )?.[0];
  assert.ok(freshnessStep, "source snapshot freshness 검증 스텝을 찾지 못함");
  assert.match(freshnessStep, /validate-source-snapshot-freshness\.mjs/);
  assert.match(freshnessStep, /--build-spec/);
  assert.doesNotMatch(freshnessStep, /--snapshots/);
  assert.match(freshnessStep, /--policy release\/product-gates\/datapack-freshness-sla\.json/);
  assert.match(freshnessStep, /--governance-policy tools\/datapack\/source-governance-policy\.json/);
  assert.match(freshnessStep, /--inventory tools\/datapack\/source-inventory\.json/);
  assert.match(
    freshnessStep,
    /EASYSUBWAY_SOURCE_RAW_PURGE_ATTESTATION_PUBLIC_KEY_SHA256: \$\{\{ secrets\.EASYSUBWAY_SOURCE_RAW_PURGE_ATTESTATION_PUBLIC_KEY_SHA256 \}\}/,
  );
  assert.match(freshnessStep, /--purge-evaluation-at "\$\{EASYSUBWAY_SOURCE_GOVERNANCE_EVALUATION_AT\}"/);
  assert.doesNotMatch(freshnessStep, /--evaluation-at/);
  assert.match(yml, /sourceGovernanceEvaluationAt is required with sourceRawPurgeReportPath/);
  assert.match(yml, /sourceRawPurgeAttestationPublicKey/);
  assert.match(yml, /sourceRawPurgeJournal/);
  assert.match(yml, /sourceRawPurgeLedger/);
  const inventoryStep = yml.match(
    /- name: Data Pack Release \/ Validate source inventory[\s\S]*?\n\s+- name:/,
  )?.[0];
  assert.ok(inventoryStep, "source inventory 검증 스텝을 찾지 못함");
  assert.match(inventoryStep, /--governance-policy tools\/datapack\/source-governance-policy\.json/);
  assert.match(inventoryStep, /--freshness-policy release\/product-gates\/datapack-freshness-sla\.json/);
  assert.ok(
    yml.indexOf("Validate source snapshot freshness") < yml.indexOf("Build data packs"),
    "source snapshot freshness는 build 전에 검증해야 함",
  );
});

test("current manifest 조회는 404만 initial release로 허용한다", () => {
  const downloadStep = yml.match(/- name: Data Pack Release \/ Download current production manifest[\s\S]*?\n\s+- name:/)?.[0];
  assert.ok(downloadStep, "current production manifest 다운로드 스텝을 찾지 못함");
  assert.match(downloadStep, /http_status/);
  assert.match(downloadStep, /404/);
  assert.match(downloadStep, /rm -f "\$\{EASYSUBWAY_DATAPACK_CURRENT_MANIFEST\}"/);
  assert.match(downloadStep, /exit 1/);
});

test("publish run은 remote artifact validation 뒤 최종 decision과 callback을 만든다", () => {
  assert.match(yml, /validate-remote-datapack-artifact\.mjs/);
  assert.match(yml, /id:\s*final-release-decision/);
  assert.match(yml, /PUBLISHED_AND_VERIFIED/);
  assert.match(yml, /Upload release decision artifact/);
  const remoteValidationArtifact = yml.match(
    /- name: Data Pack Release \/ Upload remote validation artifact[\s\S]*?\n\s+- name:/,
  )?.[0];
  assert.ok(remoteValidationArtifact, "remote validation artifact 업로드 스텝을 찾지 못함");
  assert.match(remoteValidationArtifact, /always\(\)/);
  assert.match(remoteValidationArtifact, /EASYSUBWAY_DATAPACK_REMOTE_VALIDATION/);
  assert.match(remoteValidationArtifact, /if-no-files-found:\s*ignore/);
  const remoteValidation = yml.match(
    /- name: Data Pack Release \/ Validate published remote artifact[\s\S]*?\n\s+- name:/,
  )?.[0];
  assert.ok(remoteValidation, "remote validation 스텝을 찾지 못함");
  assert.match(remoteValidation, /EXPECTED_MANIFEST_SHA256/);
  assert.match(remoteValidation, /for attempt in 1 2 3 4/);
  assert.match(remoteValidation, /sleep 20/);
  assert.match(remoteValidation, /remote validation manifestSha256 mismatch/);
  assert.match(yml, /steps\.production-publish\.outputs\.manifestSha256/);
  assert.match(yml, /remote validation manifestSha256 mismatch/);
  const finalDecision = yml.match(
    /- name: Data Pack Release \/ Finalize production decision[\s\S]*?\n\s+- name:/,
  )?.[0];
  assert.ok(finalDecision, "최종 release decision 스텝을 찾지 못함");
  assert.match(finalDecision, /final_decision_args=\(/);
  assert.match(finalDecision, /REMOTE_VALIDATION_OUTCOME/);
  assert.match(finalDecision, /if \[\[ -f "\$\{EASYSUBWAY_DATAPACK_CURRENT_MANIFEST\}" \]\]; then/);
  assert.match(finalDecision, /final_decision_args\+=\(--current-manifest/);
  assert.match(yml, /GITHUB_STEP_SUMMARY/);
});

test("RC producer는 현재 remote production manifest를 다시 검증한다", () => {
  const releaseWorkflow = readFileSync(path.join(root, ".github/workflows/release-artifacts.yml"), "utf8");
  assert.match(releaseWorkflow, /validate-remote-datapack-artifact\.mjs/);
  assert.match(releaseWorkflow, /--expected-manifest release-artifacts\/downloaded\/datapack-selected\/current\.json/);
});

test("Android production RC는 build와 upload 전에 bundled artifact identity를 검증한다", () => {
  const releaseWorkflow = readFileSync(path.join(root, ".github/workflows/release-artifacts.yml"), "utf8");
  const job = releaseWorkflow.slice(
    releaseWorkflow.indexOf("  android-production-rc-release:"),
    releaseWorkflow.indexOf("  play-internal-upload:"),
  );
  const audit = job.indexOf("Android Production RC Artifact / Audit bundled datapacks");
  const build = job.indexOf("Android Production RC Artifact / Build production signed app bundle");
  const upload = job.indexOf("Android Production RC Artifact / Upload app bundle");

  assert.match(job, /node tools\/datapack\/verify-production-pack-artifact-identity\.mjs/);
  assert.ok(audit < build && build < upload);
});

test("expiry alert는 publish 없이 같은 decision engine을 소비한다", () => {
  const expiryWorkflow = readFileSync(path.join(root, ".github/workflows/datapack-expiry-alert.yml"), "utf8");
  assert.match(expiryWorkflow, /decide-datapack-release\.mjs/);
  assert.match(expiryWorkflow, /--current-manifest/);
  assert.doesNotMatch(expiryWorkflow, /productionWriteAllowed == 'true'/);
});
