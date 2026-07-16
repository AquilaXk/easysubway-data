import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const yml = readFileSync(path.join(root, ".github/workflows/datapack-release.yml"), "utf8");

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

test("production-publish는 release request 조회 스텝과 !cancelled() 콜백 스텝을 가진다", () => {
  assert.match(yml, /release-requests\/\$\{?\{?.*releaseRequestId/); // 조회 GET
  assert.match(yml, /release-callbacks/); // 콜백 POST
  assert.match(yml, /build-release-callback\.mjs/);
  assert.match(yml, /!cancelled\(\)\s*&&/); // 콜백 조건에 !cancelled()
  assert.match(yml, /manifestSha256/);
  // 콜백 조건은 production-publish 스텝 출력 기준이어야 한다 — 비-production 모드에선 빈값
  assert.match(yml, /steps\.production-publish\.outputs\.manifestSha256/);
  // evidence-bundle 출력을 콜백 게이트로 사용하면 release-candidate에서도 발사 → 금지
  assert.doesNotMatch(yml, /steps\.evidence-bundle\.outputs\.manifestSha256/);
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
  const finalize = yml.indexOf("Data Pack Release / Finalize published decision");
  const publishBinding = yml.indexOf("Data Pack Release / Publish finalized release request binding");
  const callback = yml.indexOf("Data Pack Release / Send release callback");
  assert.ok(finalize >= 0 && publishBinding > finalize && callback > publishBinding);
  const bindingStep = yml.slice(publishBinding, callback);
  assert.match(bindingStep, /id:\s*release-request-binding/);
  assert.match(bindingStep, /--only release-request-binding/);
  assert.match(bindingStep, /--verify-only/);
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
  assert.match(binding, /steps\.release-decision\.outputs\.outcome == 'NO_CHANGE_VALID'/);
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
  assert.match(yml, /--release-scope apps\/mobile\/release\/production-datapack-scope\.json/);
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
  assert.match(yml, /--scope apps\/mobile\/release\/production-datapack-scope\.json/);
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
    assert.match(step, /--scope apps\/mobile\/release\/production-datapack-scope\.json/, `${label} scope binding`);
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
  assert.match(yml, /SCHEDULED_RELEASE_REQUEST_ID/);
  assert.match(yml, /SCHEDULED_ANDROID_EVIDENCE_PATH/);
  assert.match(yml, /SCHEDULED_STRICT_ROUTE_REGRESSION_PATH/);
  assert.match(yml, /scheduled production publish requires configured approval evidence/);
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
  assert.match(freshnessStep, /--policy apps\/mobile\/release\/datapack-freshness-sla\.json/);
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
  assert.match(inventoryStep, /--freshness-policy apps\/mobile\/release\/datapack-freshness-sla\.json/);
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
    /- name: Data Pack Release \/ Finalize published decision[\s\S]*?\n\s+- name:/,
  )?.[0];
  assert.ok(finalDecision, "최종 release decision 스텝을 찾지 못함");
  assert.match(finalDecision, /final_decision_args=\(/);
  assert.match(finalDecision, /steps\.remote-validation\.outcome == 'success'/);
  assert.match(finalDecision, /if \[\[ -f "\$\{EASYSUBWAY_DATAPACK_CURRENT_MANIFEST\}" \]\]; then/);
  assert.match(finalDecision, /final_decision_args\+=\(--current-manifest/);
  assert.match(yml, /GITHUB_STEP_SUMMARY/);
});

test("expiry alert는 publish 없이 같은 decision engine을 소비한다", () => {
  const expiryWorkflow = readFileSync(path.join(root, ".github/workflows/datapack-expiry-alert.yml"), "utf8");
  assert.match(expiryWorkflow, /decide-datapack-release\.mjs/);
  assert.match(expiryWorkflow, /--current-manifest/);
  assert.doesNotMatch(expiryWorkflow, /productionWriteAllowed == 'true'/);
});
