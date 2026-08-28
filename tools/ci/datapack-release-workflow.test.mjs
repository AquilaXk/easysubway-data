import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const yml = readFileSync(path.join(root, ".github/workflows/datapack-release.yml"), "utf8");

test("release workflow는 owned deterministic-release subset만 실행한다", () => {
  const step = yml.match(
    /- name: Data Pack Release \/ Validate ITX-청춘 coverage contract[\s\S]*?\n\s+- name:/,
  )?.[0];
  assert.ok(step, "ITX coverage contract 검증 스텝을 찾지 못함");
  assert.match(
    step,
    /node tools\/ci\/data-test-discovery\.mjs run --class deterministic-release/,
  );
  assert.doesNotMatch(step, /node\s+--test|\.test\.mjs/);
});

test("observability metadata는 active pack만 식별하고 첫 pack으로 대체하지 않는다", () => {
  const metadata = yml.match(
    /- name: Data Pack Release \/ Write observability metadata[\s\S]*?\n\s+- name:/,
  )?.[0];
  assert.ok(metadata, "observability metadata 스텝을 찾지 못함");
  assert.match(metadata, /const activePack = manifest\.activePack;/);
  assert.match(metadata, /packVersion = "unselected";/);
  assert.match(metadata, /if \(activePack\?\.id && activePack\?\.version\) \{/);
  assert.doesNotMatch(metadata, /fallbackPack/);
  assert.doesNotMatch(metadata, /manifest\.packs\?\.\[0\]/);
});

test("candidate-create는 전용 OCI credential과 descriptor-last writer만 사용한다", () => {
  const credentials = yml.match(/- name: Data Pack Release \/ Restore candidate OCI credentials[\s\S]*?\n\s+- name:/)?.[0];
  const publish = yml.match(/- name: Data Pack Release \/ Publish OCI candidate descriptor[\s\S]*?\n\s+- name:/)?.[0];
  assert.ok(credentials); assert.ok(publish);
  assert.match(credentials, /mode == 'candidate-create'/);
  assert.match(credentials, /EASYSUBWAY_CANDIDATE_OCI_BUCKET/);
  assert.match(publish, /build-datapack-candidate-tuple\.mjs/);
  assert.match(publish, /--root "\$\{EASYSUBWAY_DATAPACK_STAGE\}" --repo-root "\$\{GITHUB_WORKSPACE\}" --build-spec "\$\{EASYSUBWAY_DATAPACK_BUILD_SPEC_PATH\}"/);
  assert.match(publish, /build-candidate-oci-artifact-descriptor\.mjs/);
  assert.match(publish, /publish-candidate-oci-artifact\.mjs/);
  assert.doesNotMatch(publish, /actions\/upload-artifact|publish-object-storage|catalog\/current\.json.*PUT/);
  assert.match(yml, /GITHUB_RUN_ATTEMPT.*!= "1"/);
  for (const matched of yml.matchAll(/- name:.*?[\s\S]*?uses: actions\/upload-artifact@[\s\S]*?(?=\n\s+- name:|$)/g)) {
    assert.match(matched[0], /if:.*mode != 'candidate-create'/, "candidate-create must not upload Actions artifacts");
  }
});

test("route-final candidate parity는 runtime receipts를 canonical stage 밖 companion artifact로 분리한다", () => {
  const step = (name) => yml.indexOf(`- name: ${name}`);
  const coverage = yml.slice(step("Data Pack Release / Validate accessibility source coverage"), step("Data Pack Release / Write coverage gap evidence"));
  assert.match(coverage, /buildSpec\.publishedAt/);
  assert.doesNotMatch(coverage, /date -u/);
  const override = yml.slice(step("Data Pack Release / Configure candidate execution evidence"), step("Data Pack Release / Write release evidence bundle"));
  assert.match(override, /mode == 'release-candidate'/);
  assert.match(override, /EASYSUBWAY_RELEASE_EVIDENCE_BUNDLE=\$\{EASYSUBWAY_DATAPACK_EXECUTION_EVIDENCE_DIR\}/);
  assert.match(override, /EASYSUBWAY_DATAPACK_RELEASE_DECISION=\$\{EASYSUBWAY_DATAPACK_EXECUTION_EVIDENCE_DIR\}/);
  assert.match(yml, /EASYSUBWAY_DATAPACK_EXECUTION_EVIDENCE_DIR=.*execution-evidence/);
  const metadata = step("Data Pack Release / Build candidate promotion metadata");
  const companion = step("Data Pack Release / Upload candidate execution evidence");
  const canonical = step("Data Pack Release / Upload candidate promotion artifact");
  assert.ok(metadata < canonical && metadata < companion);
  const companionText = yml.slice(companion, step("Data Pack Release / Publish staged data packs to object storage"));
  assert.match(companionText, /release-evidence-bundle\.json/);
  assert.match(companionText, /release-decision\.json/);
  assert.doesNotMatch(yml.slice(step("Data Pack Release / Configure temp directories"), step("Data Pack Release / Configure candidate execution evidence")), /execution-evidence\/release-evidence-bundle/);
  assert.ok(step("Data Pack Release / Stage current server route bundle candidate") < metadata);
  const productionMetadata = yml.slice(step("Data Pack Release / Validate production artifact metadata"), step("Data Pack Release / Download exact production artifacts"));
  assert.match(productionMetadata, /easysubway-datapack-candidate-execution-evidence-\$\{EASYSUBWAY_DATAPACK_CANDIDATE_RUN_ID\}/);
  assert.match(productionMetadata, /require-workflow-artifact\.mjs/);
  const download = yml.slice(step("Data Pack Release / Download exact candidate execution evidence"), step("Data Pack Release / Download exact promotion artifact"));
  assert.match(download, /name: easysubway-datapack-candidate-execution-evidence-\$\{\{ steps\.release-mode\.outputs\.candidate_run_id \}\}/);
  assert.match(download, /run-id: \$\{\{ steps\.release-mode\.outputs\.candidate_run_id \}\}/);
  assert.doesNotMatch(download, /EASYSUBWAY_DATAPACK_STAGE/);
  const verify = yml.slice(step("Data Pack Release / Verify attested promotion and candidate bytes"), step("Data Pack Release / Stage verified candidate artifact"));
  assert.match(verify, /execution_entries[\s\S]*== 2/);
  assert.match(verify, /release-evidence-bundle\.json release-decision\.json/);
  assert.match(verify, /execution_root="\$\{RUNNER_TEMP\}\/downloaded-candidate-execution-evidence"/);
  assert.match(verify, /EASYSUBWAY_RELEASE_EVIDENCE_BUNDLE=\$\{execution_root\}\/release-evidence-bundle\.json/);
  assert.doesNotMatch(verify, /EASYSUBWAY_DATAPACK_RELEASE_DECISION=/);
  const lateDecision = yml.slice(step("Data Pack Release / Upload release decision artifact"), step("Data Pack Release / Upload staged data packs"));
  assert.match(lateDecision, /always\(\) && steps\.release-mode\.outputs\.mode != 'release-candidate' && (?:steps\.release-mode\.outputs\.mode != 'candidate-create' && )?steps\.release-decision\.outputs\.outcome != ''/);
});

test("release-candidate parity는 runtime GO와 분리되고 production publish는 GO를 유지한다", () => {
  const validation = yml.match(
    /- name: Data Pack Release \/ Validate release evidence bundle[\s\S]*?\n\s+- name:/,
  )?.[0];
  assert.ok(validation, "release evidence validation 스텝을 찾지 못함");
  assert.match(
    validation,
    /if \[\[ "\$\{EASYSUBWAY_DATAPACK_RELEASE_MODE\}" == "production-publish" \]\]; then\s*\n\s*bundle_args\+=\(--require-pass\)/,
  );
  assert.doesNotMatch(validation, /\^\(release-candidate\|production-publish\)\$/);
  const publishValidation = yml.match(
    /- name: Data Pack Release \/ Publish staged data packs to object storage[\s\S]*?\n\s+- name:/,
  )?.[0];
  assert.ok(publishValidation, "production publish evidence validation 스텝을 찾지 못함");
  assert.match(publishValidation, /--require-pass/);
});

test("candidate-create는 생성 입력만 받고 release·provider credential 경로와 격리된다", () => {
  const step = (name) => {
    const start = yml.indexOf(`- name: ${name}`);
    assert.notEqual(start, -1, `${name} 스텝을 찾지 못함`);
    const next = yml.indexOf("\n      - name:", start + 1);
    return yml.slice(start, next === -1 ? undefined : next);
  };
  assert.match(yml, /options: \[exploratory, candidate-create, release-candidate, production-publish, rollback, rollout-update, map-catalog-publish\]/);
  const mode = step("Data Pack Release / Validate release mode inputs");
  assert.match(mode, /mode\}" == "candidate-create"/);
  assert.match(mode, /GITHUB_EVENT_NAME\}" != "workflow_dispatch"/);
  assert.match(mode, /target_channel\}" != "production"/);
  assert.match(mode, /allow_gaps\}" != "false"/);
  assert.match(mode, /repo-relative non-fixture build spec/);
  assert.match(mode, /assert_release_build_spec_content\(\) \{/);
  assert.match(mode, /buildSpec\.fixturePath/);
  assert.match(mode, /\(fixture\|debug\|demo\|sample\)\/i/);
  assert.match(mode, /fixtures/);
  const buildSpecContentGuards = mode.match(/assert_release_build_spec_content "\$\{build_spec\}"/g) ?? [];
  assert.equal(buildSpecContentGuards.length, 2, "candidate-create와 release mode는 같은 build spec content gate를 사용해야 한다");
  assert.ok(
    mode.indexOf('assert_release_build_spec_content "${build_spec}"') < yml.indexOf("Data Pack Release / Restore candidate OCI credentials"),
    "candidate-create build spec content gate는 OCI credential 복원 전에 있어야 한다",
  );
  assert.match(mode, /candidate-create forbids release and execution inputs/);
  assert.match(mode, /release_request_id="\$\{RELEASE_REQUEST_ID_INPUT:-\}"/);
  assert.match(mode, /mode\}" == "exploratory" && -z "\$\{release_request_id\}"/);
  assert.doesNotMatch(mode, /candidate-create.*release-candidate|release-candidate.*candidate-create/);

  const dotenv = step("Data Pack Release / Restore GitHub Actions dotenv secret");
  assert.match(dotenv, /mode != 'release-candidate' && steps\.release-mode\.outputs\.mode != 'candidate-create'/);
  const freshness = step("Data Pack Release / Validate source snapshot freshness");
  assert.match(freshness, /mode == 'release-candidate'/);
  assert.doesNotMatch(freshness, /candidate-create/);
  const signing = step("Data Pack Release / Restore candidate signing credentials");
  assert.match(signing, /mode == 'release-candidate'/);
  assert.doesNotMatch(signing, /candidate-create/);
  const fixture = step("Data Pack Release / Prepare release fixture");
  assert.match(fixture, /release-candidate" \|\| "\$\{EASYSUBWAY_DATAPACK_RELEASE_MODE\}" == "candidate-create"/);
  assert.doesNotMatch(fixture.match(/candidate-create[\s\S]*?(?:elif|else)/)?.[0] ?? "", /import-official-sources|apply-admin-review-overrides/);
  const build = step("Data Pack Release / Build data packs");
  assert.match(build, /\^\(release-candidate\|candidate-create\|production-publish\)\$/);
  assert.match(build, /--build-spec "\$\{EASYSUBWAY_DATAPACK_BUILD_SPEC_PATH\}"/);
  assert.doesNotMatch(build.match(/candidate-create[\s\S]*?(?:else|fi)/)?.[0] ?? "", /--fixture "\$\{EASYSUBWAY_DATAPACK_BUILD_FIXTURE\}"/);
  for (const name of [
    "Data Pack Release / Validate generated data packs",
    "Data Pack Release / Verify uploaded pack checksums before manifest publish",
    "Data Pack Release / Stage manifest",
  ]) {
    const validation = step(name);
    assert.match(validation, /release-candidate" \|\| "\$\{EASYSUBWAY_DATAPACK_RELEASE_MODE\}" == "candidate-create/);
    assert.match(validation, /--require-production/);
  }
  assert.match(step("Data Pack Release / Validate generated data packs"), /manifest channel must match targetChannel/);
  const coverage = step("Data Pack Release / Write coverage gap evidence");
  assert.match(coverage, /\^\(release-candidate\|candidate-create\|production-publish\)\$/);
  assert.match(coverage, /--manifest "\$\{EASYSUBWAY_DATAPACK_OUTPUT\}\/current\.json"/);
  assert.match(coverage, /--provenance "\$\{EASYSUBWAY_DATAPACK_OUTPUT\}\/current\.provenance\.json"/);
  assert.match(coverage, /--release-scope "\$\{EASYSUBWAY_DATAPACK_SCOPE_POLICY\}"/);
  for (const name of [
    "Data Pack Release / Validate remote object storage publish env",
    "Data Pack Release / Write release evidence bundle",
    "Data Pack Release / Validate release evidence bundle",
    "Data Pack Release / Create manifest-last publish preflight plan",
    "Data Pack Release / Validate object storage publish executor dry run",
    "Data Pack Release / Download current production manifest for change detection",
    "Data Pack Release / Decide conditional publish",
  ]) assert.match(step(name), /mode != 'candidate-create'/, `${name}는 candidate-create에서 실행되면 안 됨`);
  const webhook = yml.slice(yml.indexOf("  notify-slack-datapack-result:"));
  assert.match(webhook, /if: \$\{\{ always\(\) && github\.event\.inputs\.mode != 'candidate-create' && github\.event\.inputs\.mode != 'map-catalog-publish' \}\}/);
  assert.match(webhook, /SLACK_RELEASE_WEBHOOK_URL: \$\{\{ secrets\.SLACK_RELEASE_WEBHOOK_URL \}\}/);
});

function assertRouteCoveragePair(source) {
  assert.match(source, /--require-production/);
  assert.match(source, /--server-route-coverage-evidence "\$\{EASYSUBWAY_DATAPACK_ROUTE_COVERAGE_AUTHORITY\}"/);
  assert.match(source, /--server-route-coverage-provenance "\$\{EASYSUBWAY_DATAPACK_STAGE\}\/current\.provenance\.json"/);
}

test("route-final candidate는 authority·strict validation·signed route stage를 candidate 경계에서 순서대로 결속한다", () => {
  const step = (name) => yml.indexOf(`- name: ${name}`);
  const prepare = yml.slice(step("Data Pack Release / Prepare release fixture"), step("Data Pack Release / Audit route map coordinate coverage"));
  assert.match(prepare, /EASYSUBWAY_DATAPACK_ROUTE_COVERAGE_AUTHORITY/);
  assert.match(yml, /EASYSUBWAY_DATAPACK_CANDIDATE_FIXTURE=.*candidate-fixture\.json/);
  assert.match(prepare, /build-current-release-candidate-accessibility-input\.mjs/);
  assert.match(prepare, /--fixture "\$\{build_fixture\}"/);
  assert.match(prepare, /--station-line-output "\$\{EASYSUBWAY_DATAPACK_STATION_LINE_INPUT\}"/);
  assert.match(prepare, /--route-edge-output "\$\{EASYSUBWAY_DATAPACK_ROUTE_EDGE_INPUT\}"/);
  assert.doesNotMatch(prepare, /--station-line-input|--route-edge-input/);
  assert.match(prepare, /--fixture-output "\$\{EASYSUBWAY_DATAPACK_CANDIDATE_FIXTURE\}"/);
  assert.match(prepare, /--authority-output "\$\{EASYSUBWAY_DATAPACK_ROUTE_COVERAGE_AUTHORITY\}"/);
  assert.match(prepare, /build_fixture="\$\{EASYSUBWAY_DATAPACK_CANDIDATE_FIXTURE\}"/);
  assert.doesNotMatch(prepare.match(/release-candidate[\s\S]*?(?:elif|else)/)?.[0] ?? "", /import-official-sources|apply-admin-review-overrides/);
  const build = yml.slice(step("Data Pack Release / Build data packs"), step("Data Pack Release / Validate source inventory"));
  assert.match(build, /--build-spec "\$\{EASYSUBWAY_DATAPACK_BUILD_SPEC_PATH\}"/);
  assert.match(build, /--candidate-fixture-override "\$\{EASYSUBWAY_DATAPACK_CANDIDATE_FIXTURE\}"/);
  assert.match(build, /--server-route-coverage-authority "\$\{EASYSUBWAY_DATAPACK_ROUTE_COVERAGE_AUTHORITY\}"/);
  assert.match(build, /--current-capital-station-line-input "\$\{EASYSUBWAY_DATAPACK_STATION_LINE_INPUT\}"/);
  assert.match(build, /--current-capital-route-edge-input "\$\{EASYSUBWAY_DATAPACK_ROUTE_EDGE_INPUT\}"/);
  assert.doesNotMatch(prepare, /writeFile|cp .*candidate-build-spec|EASYSUBWAY_DATAPACK_EPHEMERAL_BUILD_SPEC/);
  const validate = yml.slice(step("Data Pack Release / Validate generated data packs"), step("Data Pack Release / Validate accessibility source coverage"));
  assertRouteCoveragePair(validate);
  const stager = step("Data Pack Release / Stage current server route bundle candidate");
  const metadata = step("Data Pack Release / Build candidate promotion metadata");
  assert.ok(stager > step("Data Pack Release / Validate generated data packs") && stager < metadata);
  const stagerText = yml.slice(stager, step("Data Pack Release / Validate accessibility source coverage"));
  assert.match(stagerText, /mode == 'release-candidate'/);
  assert.doesNotMatch(stagerText, /candidate-create/);
  assert.match(stagerText, /stage-current-server-route-bundle-candidate\.mjs/);
  assert.match(stagerText, /--station-line-input "\$\{EASYSUBWAY_DATAPACK_STATION_LINE_INPUT\}"/);
  assert.match(stagerText, /--route-edge-input "\$\{EASYSUBWAY_DATAPACK_ROUTE_EDGE_INPUT\}"/);
  assert.match(stagerText, /--output "\$\{EASYSUBWAY_DATAPACK_STAGE\}"/);
  assert.doesNotMatch(stagerText, /--output "\$\{EASYSUBWAY_DATAPACK_STAGE\}\/server-route-bundle"/);
  assert.ok(stager < step("Data Pack Release / Publish OCI candidate descriptor"));
  const evidenceBundle = yml.slice(step("Data Pack Release / Write release evidence bundle"), step("Data Pack Release / Validate release evidence bundle"));
  assert.match(evidenceBundle, /candidateServerRouteEvidence/);
  assert.match(evidenceBundle, /releaseMode,/);
  assert.match(evidenceBundle, /server-route-bundle-evidence\/route-accessibility-eligibility\.json/);
  assert.match(evidenceBundle, /server-route-bundle-evidence\/server-route-bundle-final\.json/);
  const evidenceValidation = yml.slice(step("Data Pack Release / Validate release evidence bundle"), step("Data Pack Release / Create manifest-last publish preflight plan"));
  assert.match(evidenceValidation, /--candidate-server-route-root "\$\{EASYSUBWAY_DATAPACK_STAGE\}"/);
  const metadataText = yml.slice(metadata, step("Data Pack Release / Upload candidate promotion artifact"));
  assert.match(metadataText, /--candidate-server-route-only/);
  assert.match(metadataText, /--candidate-artifact-inventory "\$\{EASYSUBWAY_DATAPACK_STAGE\}\/data-artifact-inventory\.json"/);
  assert.match(metadataText, /--candidate-component-manifest "\$\{EASYSUBWAY_DATAPACK_STAGE\}\/data-component-manifest\.json"/);
  const checksums = yml.slice(step("Data Pack Release / Verify uploaded pack checksums before manifest publish"), step("Data Pack Release / Stage manifest"));
  assertRouteCoveragePair(checksums);
  const stagedManifest = yml.slice(step("Data Pack Release / Stage manifest"), step("Data Pack Release / Write route graph topology evidence"));
  assertRouteCoveragePair(stagedManifest);
  const publish = yml.slice(step("Data Pack Release / Publish staged data packs to object storage"), step("Data Pack Release / Prepare no-change release identity"));
  assert.match(publish, /--candidate-server-route-root "\$\{EASYSUBWAY_DATAPACK_STAGE\}"/);
  assert.match(publish, /--server-route-coverage-evidence "\$\{EASYSUBWAY_DATAPACK_STAGE\}\/server-route-coverage-authority\.json"/);
  assert.match(publish, /--server-route-coverage-provenance "\$\{EASYSUBWAY_DATAPACK_STAGE\}\/current\.provenance\.json"/);
  const remote = yml.slice(step("Data Pack Release / Validate published remote artifact"), step("Data Pack Release / Upload remote validation artifact"));
  assert.match(remote, /--server-route-coverage-evidence "\$\{EASYSUBWAY_DATAPACK_STAGE\}\/server-route-coverage-authority\.json"/);
  assert.match(remote, /--server-route-coverage-provenance "\$\{EASYSUBWAY_DATAPACK_STAGE\}\/current\.provenance\.json"/);
  assert.match(prepare, /elif \[\[ "\$\{EASYSUBWAY_DATAPACK_RELEASE_MODE\}" == "release-candidate" \|\| "\$\{EASYSUBWAY_DATAPACK_RELEASE_MODE\}" == "candidate-create" \]\]; then/);
});

test("고정된 hub 계약은 mode 해석 뒤 pointer가 아닌 release에서만 stage한다", () => {
  assert.match(yml, /paths:[\s\S]*contracts\.lock\.json/);
  assert.doesNotMatch(yml, /paths:[\s\S]*release\/product-gates/);
  const stage = yml.match(/- name: Data Pack Release \/ Stage product contracts[\s\S]*?\n\s+- name:/)?.[0];
  assert.ok(stage, "product contract stage 스텝을 찾지 못함");
  assert.match(stage, /if:\s*\$\{\{ steps\.release-mode\.outputs\.is-pointer-only != 'true' \}\}/);
  assert.match(stage, /node tools\/datapack\/stage-contracts\.mjs/);
  assert.ok(
    yml.indexOf("Data Pack Release / Stage product contracts")
      > yml.indexOf("Data Pack Release / Validate release mode inputs"),
    "contract stage는 pointer-only 여부가 확정된 뒤여야 한다",
  );
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

test("map-catalog production publication은 current main·검증된 server-route descriptor만으로 OCI에 단발 게시한다", () => {
  const jobStart = yml.indexOf("  map-catalog-publication:");
  assert.notEqual(jobStart, -1, "map-catalog publication 전용 job을 찾지 못함");
  const jobEnd = yml.indexOf("\n  notify-slack-datapack-result:", jobStart);
  const job = yml.slice(jobStart, jobEnd === -1 ? undefined : jobEnd);
  const step = (name) => {
    const start = job.indexOf(`- name: ${name}`);
    assert.notEqual(start, -1, `${name} 스텝을 찾지 못함`);
    const next = job.indexOf("\n      - name:", start + 1);
    return { start, text: job.slice(start, next === -1 ? undefined : next) };
  };

  assert.match(yml, /options: \[exploratory, candidate-create, release-candidate, production-publish, rollback, rollout-update, map-catalog-publish\]/);
  assert.match(yml, /data-pack-release:[\s\S]*?if: \$\{\{ github\.event\.inputs\.mode != 'map-catalog-publish' \}\}/);
  assert.match(job, /if: \$\{\{ github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.mode == 'map-catalog-publish' \}\}/);
  assert.match(job, /environment:\s*\n\s+name: production-datapack/);
  assert.match(job, /contents: read/);
  assert.match(job, /TARGET_CHANNEL_INPUT.*github\.event\.inputs\.targetChannel/);
  assert.match(job, /GITHUB_RUN_ATTEMPT.*== "1"/);
  assert.match(job, /AquilaXk\/easysubway-data/);
  assert.match(job, /refs\/heads\/main/);
  assert.match(job, /fetch-depth: 0/);
  assert.match(job, /allowGaps/);
  assert.match(job, /buildSpecPath/);
  assert.match(job, /serverRouteDescriptorSha256/);
  assert.match(job, /tracked non-symlink regular file/);
  assert.match(job, /execFileSync\("git", \["ls-files", "--error-unmatch", "--", value\]/);
  assert.match(job, /execFileSync\("git", \["show", `\$\{process\.env\.GITHUB_SHA\}:\$\{value\}`\]\)/);
  assert.match(job, /bytes must equal GITHUB_SHA:path/);
  assert.match(job, /OCI_SERVER_ROUTE_PUBLIC_BASE_URL.*vars\.OCI_SERVER_ROUTE_PUBLIC_BASE_URL/);
  assert.match(job, /objectstorage\\\.\[a-z0-9\]/);
  assert.match(job, /server-route-bundle-publication-descriptors\/v2\/\$\{args\.serverRouteDescriptorSha256\}\.json/);
  assert.match(job, /readCredentialFreeObject/);
  assert.match(job, /await readCredentialFreeObject\(serverRouteDescriptorUrl, 1_048_576\)/);
  assert.match(job, /statusCode !== 200/);
  assert.match(job, /server route descriptor SHA mismatch/);
  assert.match(job, /unsafe for GITHUB_ENV/);
  assert.doesNotMatch(job, /for path in "\$\{MAP_CATALOG_BUILD_SPEC_PATH\}"/);
  assert.doesNotMatch(job, /serverRouteDescriptorPath/);
  assert.doesNotMatch(job, /AWS_|_READER|PAR_|dotenv|upload-artifact|download-artifact|retry|fallback/i);
  assert.match(job, /validateServerRouteBundlePublicationDescriptor/);
  assert.match(job, /descriptor\.release\.result !== "GO"/);
  assert.match(job, /descriptor\.producer\.repository !== process\.env\.GITHUB_REPOSITORY/);
  assert.doesNotMatch(job, /descriptor\.producer\.gitSha !== process\.env\.GITHUB_SHA/);
  assert.match(job, /descriptor\.producer\.gitSha === process\.env\.GITHUB_SHA/);
  assert.match(job, /execFileSync\("git", \["merge-base", "--is-ancestor", descriptor\.producer\.gitSha, process\.env\.GITHUB_SHA\]/);
  assert.match(job, /buildSpec\.releaseSequence !== descriptor\.manifest\.releaseSequence/);
  assert.match(job, /buildSpec\.sourceSnapshotSetHash !== descriptor\.sourceSnapshotSetHash/);
  assert.match(job, /descriptor\.manifest\.stationSetSha256/);
  assert.match(job, /descriptor\.manifest\.releaseSequence/);
  assert.match(job, /descriptor\.manifest\.activeFrom/);
  assert.match(job, /descriptor\.manifest\.freshUntil/);
  assert.match(job, /descriptor\.manifest\.bundleId/);
  assert.match(job, /descriptor\.manifest\.keyId/);
  assert.match(job, /capital-map-1/);
  assert.match(job, /capital-catalog-1/);
  assert.match(job, /build-datapack\.mjs/);
  assert.match(job, /gunzipSync/);
  assert.match(job, /emit-artifact-components\.mjs/);
  assert.match(job, /buildMapCatalogSignedCurrentPublication/);
  assert.match(job, /mapCatalog\.stationSetSha256 !== serverRoute\.stationSetSha256/);

  const preflight = step("Map catalog publication / Validate immutable inputs");
  const build = step("Map catalog publication / Build signed current publication");
  const currentMain = step("Map catalog publication / Recheck current main");
  const publish = step("Map catalog publication / Publish immutable OCI objects");
  const handoff = step("Map catalog publication / Write safe handoff");
  assert.ok(preflight.start < build.start && build.start < currentMain.start && currentMain.start < publish.start && publish.start < handoff.start);
  assert.ok(preflight.text.includes("const serverRoutePublicBasePattern = /^https:\\/\\/objectstorage\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.oraclecloud\\.com\\/n\\/[A-Za-z0-9_~-](?:[A-Za-z0-9._~-]*[A-Za-z0-9_~-])?\\/b\\/[A-Za-z0-9_~-](?:[A-Za-z0-9._~-]*[A-Za-z0-9_~-])?\\/o$/;"));
  assert.match(preflight.text, /!serverRoutePublicBasePattern\.test\(serverRoutePublicBaseUrl\) \|\| new URL\(serverRoutePublicBaseUrl\)\.toString\(\) !== serverRoutePublicBaseUrl/);
  assert.match(preflight.text, /descriptor\.descriptorSha256 !== args\.serverRouteDescriptorSha256/);
  assert.match(currentMain.text, /gh api repos\/AquilaXk\/easysubway-data\/git\/ref\/heads\/main/);
  assert.match(currentMain.text, /GITHUB_SHA/);
  assert.match(publish.text, /OCI_MAP_CATALOG_PUBLISHER_ACCESS_KEY/);
  assert.match(publish.text, /OCI_MAP_CATALOG_PUBLISHER_SECRET_KEY/);
  for (const name of ["OCI_MAP_CATALOG_NAMESPACE", "OCI_MAP_CATALOG_BUCKET", "OCI_MAP_CATALOG_REGION", "OCI_MAP_CATALOG_COMPAT_ENDPOINT", "OCI_MAP_CATALOG_OBJECT_PREFIX"]) assert.match(publish.text, new RegExp(name));
  assert.match(publish.text, /publish-map-catalog-signed-current-publication\.mjs/);
  assert.doesNotMatch(publish.text, /AWS_|READER|CANDIDATE|PAR|dotenv|upload-artifact|download-artifact|retry|fallback/i);
  assert.match(handoff.text, /DESCRIPTOR_SHA/);
  assert.match(handoff.text, /DESCRIPTOR_LOCATOR/);
  assert.match(handoff.text, /RECEIPT_SHA/);
  assert.match(handoff.text, /RECEIPT_LOCATOR/);
  assert.doesNotMatch(handoff.text, /upload-artifact|receipt\.json|descriptor\.json/i);
  const slack = yml.slice(yml.indexOf("  notify-slack-datapack-result:"));
  assert.match(slack, /mode != 'candidate-create' && github\.event\.inputs\.mode != 'map-catalog-publish'/);
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

test("production-publish injects dedicated callback secrets into the temporary dotenv before OCI publication", () => {
  const step = yml.match(
    /- name: Data Pack Release \/ Inject production callback secrets[\s\S]*?\n\s+- name:/,
  )?.[0];
  assert.ok(step, "production callback secret injection step was not found");
  assert.match(step, /if:\s*\$\{\{ steps\.release-mode\.outputs\.mode == 'production-publish' \}\}/);
  for (const key of ["EASYSUBWAY_DATAPACK_WORKFLOW_TOKEN", "EASYSUBWAY_DATAPACK_CALLBACK_HMAC_KEY"]) {
    assert.match(step, new RegExp(`${key}:\\s*\\$\\{\\{ secrets\\.${key} \\}\\}`));
  }
  assert.match(step, /node tools\/datapack\/inject-production-callback-secrets\.mjs/);
  assert.doesNotMatch(step, /EASYSUBWAY_ENV_SECRET|EASYSUBWAY_ENV_FILE|--env-file/);
  assert.ok(
    yml.indexOf("Data Pack Release / Restore GitHub Actions dotenv secret")
      < yml.indexOf("Data Pack Release / Inject production callback secrets"),
    "callback secrets must follow dotenv restoration",
  );
  assert.ok(
    yml.indexOf("Data Pack Release / Inject production callback secrets")
      < yml.indexOf("Data Pack Release / Publish staged data packs to object storage"),
    "callback secrets must be injected before OCI publication",
  );
  const tokenUses = yml.match(/EASYSUBWAY_DATAPACK_WORKFLOW_TOKEN/g) ?? [];
  assert.equal(tokenUses.length, 3, "token must be injected exactly once and remain available to rollback approval only");
});

test("production-publish는 current-head server route bundle을 OCI에 immutable publish한 뒤 GO FINAL descriptor를 마지막에 게시한다", () => {
  const step = (name) => {
    const value = yml.match(new RegExp(`- name: ${name}[\\s\\S]*?\\n\\s+- name:`))?.[0];
    assert.ok(value, `${name} 스텝을 찾지 못함`);
    return value;
  };
  const candidate = step("Data Pack Release / Validate production candidate and promotion runs");
  const publish = step("Data Pack Release / Publish current server route bundle and descriptor");
  const production = step("Data Pack Release / Publish staged data packs to object storage");
  const decision = step("Data Pack Release / Finalize production decision");
  assert.ok(yml.indexOf("Data Pack Release / Validate production candidate and promotion runs") < yml.indexOf("Data Pack Release / Publish staged data packs to object storage"));
  assert.match(candidate, /\[\[ "\$\{candidate_head_sha\}" == "\$\{GITHUB_SHA\}" \]\]/);
  assert.ok(yml.indexOf("Data Pack Release / Publish staged data packs to object storage") < yml.indexOf("Data Pack Release / Finalize production decision"));
  assert.ok(yml.indexOf("Data Pack Release / Finalize production decision") < yml.indexOf("Data Pack Release / Publish current server route bundle and descriptor"));
  assert.match(publish, /steps\.final-release-decision\.outputs\.outcome == 'PUBLISHED_AND_VERIFIED'/);
  assert.match(publish, /CANDIDATE_HEAD_SHA.*GITHUB_SHA/);
  assert.match(publish, /\[\[ "\$\{CANDIDATE_HEAD_SHA\}" == "\$\{GITHUB_SHA\}" \]\]/);
  assert.match(publish, /git checkout --detach "\$\{GITHUB_SHA\}"/);
  assert.ok(publish.indexOf('git checkout --detach "${GITHUB_SHA}"') < publish.indexOf("publish-server-route-bundle.mjs"));
  for (const name of ["EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM", "EASYSUBWAY_DATAPACK_SIGNING_KEY_ID"]) assert.match(publish, new RegExp(name));
  for (const name of ["OCI_SERVER_ROUTE_NAMESPACE", "OCI_SERVER_ROUTE_BUCKET", "OCI_SERVER_ROUTE_REGION", "OCI_SERVER_ROUTE_COMPAT_ENDPOINT", "OCI_SERVER_ROUTE_PUBLIC_BASE_URL", "OCI_SERVER_ROUTE_PUBLISHER_ACCESS_KEY", "OCI_SERVER_ROUTE_PUBLISHER_SECRET_KEY"]) assert.match(publish, new RegExp(name));
  assert.match(publish, /publish-server-route-bundle\.mjs/);
  assert.match(publish, /build-server-route-bundle-final\.mjs/);
  assert.match(publish, /--eligibility-report "\$\{route_evidence\}\/route-accessibility-eligibility\.json"/);
  assert.match(publish, /--candidate-execution-evidence-root "\$\{execution_root\}"/);
  assert.doesNotMatch(publish, /--rebuild-parity-evidence/);
  assert.doesNotMatch(publish, /--route-accessibility-eligibility/);
  assert.match(publish, /build-server-route-bundle-publication-descriptor\.mjs/);
  assert.match(publish, /publish-server-route-bundle-publication-descriptor\.mjs/);
  assert.ok(publish.indexOf("publish-server-route-bundle.mjs") < publish.indexOf("build-server-route-bundle-final.mjs"));
  assert.ok(publish.indexOf("build-server-route-bundle-final.mjs") < publish.indexOf("build-server-route-bundle-publication-descriptor.mjs"));
  assert.ok(publish.indexOf("build-server-route-bundle-publication-descriptor.mjs") < publish.indexOf("publish-server-route-bundle-publication-descriptor.mjs"));
  assert.match(publish, /staged_descriptor="\$\{EASYSUBWAY_DATAPACK_STAGE\}\/server-route-bundle-publication-descriptor\.json"/);
  assert.match(publish, /cp -- "\$\{descriptor\}" "\$\{staged_descriptor\}"/);
  assert.match(publish, /cmp -s -- "\$\{descriptor\}" "\$\{staged_descriptor\}"/);
  assert.match(publish, /mapfile -d '' -t staged_descriptors < <\(find "\$\{EASYSUBWAY_DATAPACK_STAGE\}" -type f -name 'server-route-bundle-publication-descriptor\.json' -print0\)/);
  assert.match(publish, /\[\[ "\$\{#staged_descriptors\[@\]\}" -eq 1 \]\]/);
  assert.match(publish, /\[\[ "\$\{staged_descriptors\[0\]\}" == "\$\{staged_descriptor\}" \]\]/);
  assert.ok(publish.indexOf("publish-server-route-bundle-publication-descriptor.mjs") < publish.indexOf('cp -- "${descriptor}" "${staged_descriptor}"'));
  assert.ok(yml.indexOf('cp -- "${descriptor}" "${staged_descriptor}"') < yml.indexOf("Data Pack Release / Upload staged data packs"));
  assert.doesNotMatch(publish, /AWS_|fallback|retry|upload-artifact|download-artifact/i);
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

  // Dedicated token은 production callback dotenv 주입과 rollback approval 조회에만 남는다.
  const tokenUses = yml.match(/EASYSUBWAY_DATAPACK_WORKFLOW_TOKEN/g) ?? [];
  assert.equal(tokenUses.length, 3, "workflow token은 production injection과 rollback approval에만 남아야 한다");
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
    /if:\s*\$\{\{ (?:steps\.release-mode\.outputs\.mode != 'candidate-create' && )?steps\.release-request-binding\.outcome == 'success' \}\}/);
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
  assert.match(yml, /--release-scope "\$\{EASYSUBWAY_DATAPACK_SCOPE_POLICY\}"/);
  // release 모드에서만 production manifest/provenance와 --release-scope를 붙인다.
  // exploratory fixture는 inventory 기준으로 전량 MISSING을 기록하며 --allow-gaps로 통과해야 한다.
  assert.match(
    yml,
    /EASYSUBWAY_DATAPACK_RELEASE_MODE\}" =~ \^\(release-candidate\|candidate-create\|production-publish\)\$ \]\]; then\s*\n\s*coverage_args\+=\(\s*--manifest "\$\{EASYSUBWAY_DATAPACK_OUTPUT\}\/current\.json"\s*--provenance "\$\{EASYSUBWAY_DATAPACK_OUTPUT\}\/current\.provenance\.json"\s*--release-scope/,
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
  assert.match(evidenceStep, /nationwideTargetsSha256:\s*hashFile\("tools\/datapack\/nationwide-coverage-targets\.json"\)/);
  assert.match(evidenceStep, /identityLinkageMatrixSha256:\s*launchReport\.identityLinkage\.matrixSha256/);
  assert.match(evidenceStep, /launchDenominatorDecision:\s*launchReport\.decision/);
  assert.match(evidenceStep, /launchDenominatorReportSha256:\s*hashBytes\(launchDenominatorReportRaw\)/);
  assert.match(evidenceStep, /releaseSequence:\s*manifest\.releaseSequence/);
  assert.doesNotMatch(evidenceStep, /scopeId:\s*"capital_pilot_android_v1"/);
  assert.match(yml, /--scope "\$\{EASYSUBWAY_DATAPACK_SCOPE_POLICY\}"/);
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
    assert.match(step, /--scope "\$\{EASYSUBWAY_DATAPACK_SCOPE_POLICY\}"/, `${label} scope binding`);
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
  assert.match(freshnessStep, /--policy "\$\{EASYSUBWAY_DATAPACK_FRESHNESS_POLICY\}"/);
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
  assert.match(inventoryStep, /--freshness-policy "\$\{EASYSUBWAY_DATAPACK_FRESHNESS_POLICY\}"/);
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
  assert.match(finalDecision, /--release-evidence-bundle "\$\{EASYSUBWAY_RELEASE_EVIDENCE_BUNDLE\}"/);
  assert.match(finalDecision, /--launch-denominator-report "\$\{EASYSUBWAY_LAUNCH_DENOMINATOR_REPORT\}"/);
  assert.match(finalDecision, /\[\[ "\$\{publish_attempted\}" == "true" \]\]/);
  assert.match(yml, /GITHUB_STEP_SUMMARY/);
});

test("expiry alert는 publish 없이 같은 decision engine을 소비한다", () => {
  const expiryWorkflow = readFileSync(path.join(root, ".github/workflows/datapack-expiry-alert.yml"), "utf8");
  assert.match(expiryWorkflow, /node tools\/datapack\/stage-contracts\.mjs/);
  assert.match(expiryWorkflow, /--policy "\$\{EASYSUBWAY_DATAPACK_FRESHNESS_POLICY\}"/);
  assert.match(expiryWorkflow, /decide-datapack-release\.mjs/);
  assert.match(expiryWorkflow, /--current-manifest/);
  assert.doesNotMatch(expiryWorkflow, /productionWriteAllowed == 'true'/);
});

test("candidate artifact는 data identity를 발행하고 promotion은 hub artifact만 소비한다", () => {
  assert.match(yml, /build-data-component-manifest\.mjs/);
  assert.match(yml, /--repository "\$\{GITHUB_REPOSITORY\}"/);
  assert.match(yml, /--issue-ref "AquilaXk\/easysubway#2705"/);
  assert.match(yml, /easysubway-datapack-candidate-\$\{\{ github\.run_id \}\}/);
  assert.match(yml, /current\.provenance\.json/);
  assert.match(yml, /--inventory-output "\$\{EASYSUBWAY_DATAPACK_STAGE\}\/data-artifact-inventory\.json"/);
  assert.match(yml, /--output "\$\{EASYSUBWAY_DATAPACK_STAGE\}\/data-component-manifest\.json"/);
  const candidateUpload = yml.match(
    /- name: Data Pack Release \/ Upload candidate promotion artifact[\s\S]*?\n\s+- name:/,
  )?.[0];
  assert.ok(candidateUpload, "candidate promotion artifact upload 스텝을 찾지 못함");
  assert.match(candidateUpload, /path:\s*\$\{\{ env\.EASYSUBWAY_DATAPACK_STAGE \}\}/);
  assert.doesNotMatch(candidateUpload, /candidate-component|candidate-inventory|data-component-manifest|data-artifact-inventory/);
});

test("production-publish는 attested candidate를 no-rebuild로 소비한다", () => {
  const step = (name) => {
    const value = yml.match(new RegExp(`- name: ${name}[\\s\\S]*?\\n\\s+- name:`))?.[0];
    assert.ok(value, `${name} 스텝을 찾지 못함`);
    return value;
  };
  assert.match(yml, /GH_TOKEN:\s*\$\{\{ github\.token \}\}/);

  const runs = step("Data Pack Release / Validate production candidate and promotion runs");
  assert.match(runs, /if:\s*\$\{\{ steps\.release-mode\.outputs\.mode == 'production-publish' \}\}/);
  assert.match(runs, /CANDIDATE_RUN_ID: \$\{\{ steps\.release-mode\.outputs\.candidate_run_id \}\}/);
  assert.match(runs, /PROMOTION_RUN_ID: \$\{\{ steps\.release-mode\.outputs\.promotion_run_id \}\}/);
  assert.match(runs, /EASYSUBWAY_HUB_ARTIFACT_READ_TOKEN: \$\{\{ secrets\.EASYSUBWAY_HUB_ARTIFACT_READ_TOKEN \}\}/);
  assert.doesNotMatch(runs, /GH_TOKEN: \$\{\{ secrets\.EASYSUBWAY_HUB_ARTIFACT_READ_TOKEN \}\}/);
  assert.match(runs, /GH_TOKEN="\$\{EASYSUBWAY_HUB_ARTIFACT_READ_TOKEN\}" gh api "repos\/\$\{EASYSUBWAY_HUB_REPOSITORY\}/);
  assert.match(runs, /\.github\/workflows\/datapack-release\.yml/);
  assert.match(runs, /\.github\/workflows\/datapack-promotion\.yml/);
  assert.match(runs, /promotion_ref\}" == "main"/);
  for (const predicate of [
    /candidate_id\}" == "\$\{CANDIDATE_RUN_ID\}/,
    /candidate_conclusion\}" == "success"/,
    /candidate_repository\}" == "\$\{GITHUB_REPOSITORY\}/,
    /candidate_head_repository\}" == "\$\{GITHUB_REPOSITORY\}/,
    /candidate_event\}" == "workflow_dispatch"/,
    /candidate_head_sha\}" =~ \^\[a-f0-9\]\{40\}\$/,
    /candidate_path\}" == "\.github\/workflows\/datapack-release\.yml"/,
    /promotion_id\}" == "\$\{PROMOTION_RUN_ID\}/,
    /promotion_conclusion\}" == "success"/,
    /promotion_repository\}" == "\$\{EASYSUBWAY_HUB_REPOSITORY\}/,
    /promotion_head_repository\}" == "\$\{EASYSUBWAY_HUB_REPOSITORY\}/,
    /promotion_event\}" == "workflow_dispatch"/,
    /promotion_ref\}" == "main"/,
    /promotion_head_sha\}" =~ \^\[a-f0-9\]\{40\}\$/,
    /promotion_path\}" == "\.github\/workflows\/datapack-promotion\.yml"/,
  ]) assert.match(runs, predicate);

  const metadata = step("Data Pack Release / Validate production artifact metadata");
  assert.match(metadata, /EASYSUBWAY_HUB_ARTIFACT_READ_TOKEN: \$\{\{ secrets\.EASYSUBWAY_HUB_ARTIFACT_READ_TOKEN \}\}/);
  assert.doesNotMatch(metadata, /GH_TOKEN: \$\{\{ secrets\.EASYSUBWAY_HUB_ARTIFACT_READ_TOKEN \}\}/);
  assert.match(metadata, /repos\/\$\{GITHUB_REPOSITORY\}\/actions\/runs/);
  assert.match(metadata, /repos\/\$\{EASYSUBWAY_HUB_REPOSITORY\}\/actions\/runs/);
  assert.match(metadata, /GH_TOKEN="\$\{EASYSUBWAY_HUB_ARTIFACT_READ_TOKEN\}" gh api "repos\/\$\{EASYSUBWAY_HUB_REPOSITORY\}/);
  assert.match(metadata, /easysubway-datapack-candidate-\$\{EASYSUBWAY_DATAPACK_CANDIDATE_RUN_ID\}/);
  assert.match(metadata, /easysubway-datapack-promotion-\$\{EASYSUBWAY_DATAPACK_PROMOTION_RUN_ID\}/);
  assert.match(metadata, /require-workflow-artifact\.mjs/);
  assert.match(metadata, /"\$\{CANDIDATE_HEAD_SHA\}"/);
  assert.match(metadata, /"\$\{PROMOTION_HEAD_SHA\}"/);
  const candidateDownload = step("Data Pack Release / Download exact production artifacts");
  assert.match(candidateDownload, /github-token: \$\{\{ github\.token \}\}/);
  const promotionDownload = step("Data Pack Release / Download exact promotion artifact");
  assert.match(promotionDownload, /repository: AquilaXk\/easysubway/);
  assert.match(promotionDownload, /github-token: \$\{\{ secrets\.EASYSUBWAY_HUB_ARTIFACT_READ_TOKEN \}\}/);

  const verify = step("Data Pack Release / Verify attested promotion and candidate bytes");
  assert.match(verify, /gh attestation verify[\s\S]*?--repo "\$\{EASYSUBWAY_HUB_REPOSITORY\}"[\s\S]*?--signer-workflow "AquilaXk\/easysubway\/\.github\/workflows\/datapack-promotion\.yml"[\s\S]*?--source-ref refs\/heads\/main[\s\S]*?--deny-self-hosted-runners/);
  assert.match(verify, /validate-promotion-request\.mjs/);
  assert.match(verify, /promotion_entries.*== 3/);
  assert.doesNotMatch(verify, /rebuild-parity-evidence/);
  assert.match(verify, /--workflow-run-id "\$\{EASYSUBWAY_DATAPACK_PROMOTION_RUN_ID\}"/);
  assert.match(verify, /build-data-component-manifest\.mjs/);
  assert.match(verify, /candidate_issue_ref=/);
  assert.match(verify, /--issue-ref "\$\{candidate_issue_ref\}"/);
  assert.match(verify, /cmp -s "\$\{component_manifest\}" "\$\{original_component_manifest\}"/);
  const stage = step("Data Pack Release / Stage verified candidate artifact");
  assert.match(stage, /cp -a "\$\{RUNNER_TEMP\}\/downloaded-candidate\/\." "\$\{EASYSUBWAY_DATAPACK_STAGE\}\//);

  const publishPlan = step("Data Pack Release / Create manifest-last publish preflight plan");
  assert.match(publishPlan, /EASYSUBWAY_DATAPACK_RELEASE_MODE\}" == "production-publish"/);
  assert.match(publishPlan, /\$\{RUNNER_TEMP\}\/attested-candidate-publish-plan\.json/);
  assert.match(publishPlan, /cmp -s "\$\{candidate_publish_plan\}" "\$\{EASYSUBWAY_DATAPACK_PUBLISH_PLAN\}"/);
  assert.match(publishPlan, /--output "\$\{candidate_publish_plan\}"/);

  const productionPublish = step("Data Pack Release / Publish staged data packs to object storage");
  assert.match(productionPublish, /EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM:\s*\$\{\{ secrets\.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM \}\}/);
  assert.doesNotMatch(productionPublish, /SIGNING_PRIVATE_KEY|SIGNING_KEY_ID/);

  const signing = step("Data Pack Release / Restore candidate signing credentials");
  assert.match(signing, /if:\s*\$\{\{ steps\.release-mode\.outputs\.mode == 'release-candidate' \}\}/);
  assert.doesNotMatch(signing, /candidate-create/);
  const signingSecrets = [...signing.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]).sort();
  assert.deepEqual(signingSecrets, [
    "EASYSUBWAY_DATAPACK_SIGNING_KEY_ID",
    "EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM",
    "EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM",
  ]);
  assert.doesNotMatch(signing, /EASYSUBWAY_ENV|OBJECT_STORAGE/);
  assert.match(signing, /::add-mask::/);
  assert.match(signing, /printf '%s<<%s/);

  const dotenv = step("Data Pack Release / Restore GitHub Actions dotenv secret");
  assert.match(dotenv, /mode != 'release-candidate'/);
  const remotePublish = step("Data Pack Release / Validate remote object storage publish env");
  assert.match(remotePublish, /mode != 'release-candidate'/);

  for (const name of [
    "Data Pack Release / Prepare release fixture",
    "Data Pack Release / Audit route map coordinate coverage",
    "Data Pack Release / Build data packs",
    "Data Pack Release / Validate source inventory",
    "Data Pack Release / Validate generated data packs",
    "Data Pack Release / Write coverage gap evidence",
    "Data Pack Release / Stage pack files",
    "Data Pack Release / Stage manifest",
    "Data Pack Release / Write route graph topology evidence",
    "Data Pack Release / Write headway evidence",
    "Data Pack Release / Write release evidence bundle",
  ]) {
    assert.match(step(name), /mode != 'production-publish'/, `${name}는 production-publish를 제외해야 함`);
  }

  const provenance = step("Data Pack Release / Stage candidate provenance");
  assert.match(provenance, /current\.provenance\.json/);
  assert.match(
    provenance,
    /if:\s*\$\{\{ steps\.release-mode\.outputs\.is-pointer-only != 'true' && steps\.release-mode\.outputs\.mode != 'production-publish' \}\}/,
  );
  assert.match(step("Data Pack Release / Validate source snapshot freshness"), /mode == 'release-candidate'/);
  const accessibility = step("Data Pack Release / Validate accessibility source coverage");
  assert.match(accessibility, /mode == 'release-candidate'/);
  assert.match(accessibility, /--manifest "\$\{EASYSUBWAY_DATAPACK_OUTPUT\}\/current\.json"/);
  assert.match(accessibility, /--manifest-root "\$\{EASYSUBWAY_DATAPACK_OUTPUT\}"/);
  assert.match(accessibility, /--bundled-index "\$\{EASYSUBWAY_DATAPACK_OUTPUT\}\/current\.json"/);
  assert.match(accessibility, /--bundled-root "\$\{EASYSUBWAY_DATAPACK_OUTPUT\}"/);
  assert.ok(yml.indexOf("Data Pack Release / Build data packs") < yml.indexOf("Data Pack Release / Stage candidate provenance"));
  assert.ok(yml.indexOf("Data Pack Release / Stage candidate provenance") < yml.indexOf("Data Pack Release / Validate release evidence bundle"));

  for (const name of [
    "Data Pack Release / Checkout pinned Mobile fixture",
    "Data Pack Release / Stage pinned Mobile fixture",
  ]) {
    assert.match(
      step(name),
      /if:\s*\$\{\{ steps\.release-mode\.outputs\.is-pointer-only != 'true' && steps\.release-mode\.outputs\.mode != 'production-publish' \}\}/,
      `${name}는 production-publish에서 실행되면 안 됨`,
    );
  }
});
