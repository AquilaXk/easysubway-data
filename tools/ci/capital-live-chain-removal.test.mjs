// #866 PR-C: 수도권 pilot live chain·우회 모드·EXIT 갱신 체인을 지운 뒤 다시 생기지 않게 막는다.
// PR-B의 import 경계 불변식(전국 발행 경로 → live chain 모듈 0)을 "tools/·.github/·contracts/·release/ 전체에서
// 삭제 대상 참조 0"으로 넓힌 정적 검사다. 삭제 대상 이름은 이 파일에만 남는다.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SELF = path.relative(root, fileURLToPath(import.meta.url));

// 삭제한 모듈(테스트 파일 포함)의 이름이다. import 경로·CLI·workflow 인라인 스크립트 모두 이 이름으로 잡힌다.
const DELETED_MODULES = [
  // live chain 본체
  "tools/datapack/run-current-capital-live-chain",
  "tools/datapack/validate-current-capital-live-chain-materialization",
  "tools/datapack/build-current-capital-live-chain-boundary",
  // 재결속·우회 모드(ITX delta proof, transfer-source-admission-baseline, nationwide-candidate-rebind-baseline,
  // 비선택 원천 append-only)를 담은 refresh
  "tools/datapack/refresh-current-capital-accessibility-full",
  // transition·handoff
  "tools/datapack/current-capital-accessibility-transition",
  "tools/datapack/current-capital-accessibility-source-handoff",
  "tools/datapack/current-capital-exit-provider-handoff",
  // rebind·recover
  "tools/datapack/rebind-current-live-chain-transfer-derived-identities",
  "tools/datapack/recover-current-live-chain-transfer-observation",
  "tools/datapack/rebind-current-active-facility-derived-identity",
  "tools/datapack/rebind-current-active-public-route-map-materialization",
  // 수도권 분모 필터와 수도권 route-edge 입력 생성기
  "tools/datapack/build-current-capital-station-line-input",
  "tools/datapack/build-current-capital-route-edge-input",
  // EXIT 갱신 체인
  "tools/datapack/build-current-exit-admission-oci-receipt",
  "tools/datapack/build-current-exit-path-source-admission",
  "tools/datapack/build-current-kric-exit-collection-receipt",
  "tools/datapack/build-current-kric-exit-provider-oci-plan",
  "tools/datapack/build-current-kric-exit-provider-oci-receipt",
  "tools/datapack/consume-current-kric-exit-collection-bundle",
  "tools/datapack/collect-current-kric-exit-path-provider-snapshot",
  "tools/datapack/diagnose-current-kric-exit-path-query",
  // CI 도구
  "tools/ci/decide-current-kric-exit-full-capital-refresh",
  "tools/ci/sync-kric-exit-diagnostic-secret",
  // live chain 전용 test fixture
  "tools/datapack/test-fixtures/current-full-capital-production-artifact",
  "tools/datapack/test-fixtures/current-live-chain-artifacts",
  "tools/datapack/test-fixtures/current-capital-station-line-input",
  "tools/datapack/test-fixtures/current-exit-v2-receipt",
];
const DELETED_TESTS = [
  "tools/datapack/refresh-current-capital-accessibility-full-nationwide-pack-recompute.test.mjs",
  "tools/datapack/refresh-current-capital-accessibility-full-nationwide-rebind.test.mjs",
  "tools/datapack/refresh-current-capital-accessibility-full-transfer-baseline.test.mjs",
  "tools/ci/kric-exit-full-capital-refresh-workflow.test.mjs",
];
// live chain·테스트만 소비하던 커밋 산출물이다.
const DELETED_ARTIFACTS = [
  "tools/datapack/release/current-capital-accessibility-full",
  "tools/datapack/release/current-capital-live-chain-fan-in.json",
  "tools/datapack/release/current-capital-facility-source-admission.json",
  "tools/datapack/release/current-exit-admission-v2",
  "tools/datapack/release/current-kric-exit-plan-inputs.json",
  "tools/datapack/release/current-capital-itx-topology-delta-proof.json",
];
const DELETED_WORKFLOWS = [".github/workflows/kric-exit-full-capital-refresh.yml"];

// 참조 검사 토큰: 모듈 basename, 산출물 경로 꼬리, workflow 이름, CI job id, live chain 우회 모드 플래그.
// validate-datapack의 legacy fixture 플래그는 대전 지역 팩 테스트가 의존하므로 PR-D(#866)에서 정리한다(메인 결정).
const TOKENS = [...new Set([
  ...DELETED_MODULES.map((module) => (module.includes("/test-fixtures/")
    ? `test-fixtures/${path.basename(module)}`
    : path.basename(module))),
  ...DELETED_TESTS.map((file) => path.basename(file, ".test.mjs")),
  ...DELETED_ARTIFACTS.map((artifact) => path.basename(artifact)),
  "kric-exit-full-capital-refresh",
  "contracts_live_chain",
  "capital live-chain OCI",
  "nationwide-candidate-rebind-baseline",
  "transfer-source-admission-baseline",
])];
const SCAN_ROOTS = [".github", "contracts", "release", "tools", "package.json"];

function scanFiles(relative, files = []) {
  const absolute = path.join(root, relative);
  if (!existsSync(absolute)) return files;
  if (statSync(absolute).isFile()) {
    files.push(relative);
    return files;
  }
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    scanFiles(path.join(relative, entry.name), files);
  }
  return files;
}

test("#866 PR-C 삭제 대상 모듈·테스트·산출물·workflow는 저장소에 없다", () => {
  const present = [
    ...DELETED_MODULES.flatMap((module) => [`${module}.mjs`, `${module}.test.mjs`]),
    ...DELETED_TESTS,
    ...DELETED_ARTIFACTS,
    ...DELETED_WORKFLOWS,
  ].filter((relative) => existsSync(path.join(root, relative)));
  assert.deepEqual(present, []);
});

test("#866 PR-C tools/·.github/·contracts/·release/ 어디에도 삭제 대상 참조가 남지 않는다", () => {
  const pattern = new RegExp(TOKENS.map((token) => token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|"), "u");
  const offenders = [];
  for (const relative of SCAN_ROOTS.flatMap((scanRoot) => scanFiles(scanRoot))) {
    if (relative === SELF) continue;
    const text = readFileSync(path.join(root, relative), "utf8");
    if (!pattern.test(text)) continue;
    const hits = TOKENS.filter((token) => text.includes(token));
    offenders.push(`${relative}: ${hits.join(", ")}`);
  }
  assert.deepEqual(offenders, []);
});

test("#866 PR-C 검사기는 삭제 대상 참조를 실제로 잡는다", () => {
  // 토큰 목록이 비거나 정규식이 깨져 검사가 항상 통과하는 일을 막는다.
  assert.ok(TOKENS.length >= DELETED_MODULES.length);
  const pattern = new RegExp(TOKENS.map((token) => token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|"), "u");
  for (const sample of [
    'import { x } from "./run-current-capital-live-chain.mjs";',
    "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json",
    "uses: ./.github/workflows/kric-exit-full-capital-refresh.yml",
    "needs: [contracts_mobile_v19, contracts_live_chain]",
    'import { y } from "./test-fixtures/current-full-capital-production-artifact.mjs";',
  ]) {
    assert.match(sample, pattern, sample);
  }
  // 유지하는 이름은 잡지 않는다(CLI 인자, 정본 팩, 계약 모듈, FACILITY 등록기).
  for (const kept of [
    "--current-capital-station-line-input",
    "--current-capital-route-edge-input",
    "tools/datapack/release/capital-production-canonical-pack.json",
    "tools/datapack/current-capital-station-line-contract.mjs",
    "tools/datapack/build-current-capital-facility-source-admission.mjs",
    "tools/datapack/collect-kric-exit-path-provider-snapshot.mjs",
    "tools/datapack/plan-kric-exit-path-collection.mjs",
    // 전국 경로의 서울 환승 증거 재결속 명령(#866). live chain 재결속을 대체하며 삭제 대상이 아니다.
    "tools/datapack/rebind-current-seoul-transfer-source-admission.mjs",
  ]) {
    assert.doesNotMatch(kept, pattern, kept);
  }
});
