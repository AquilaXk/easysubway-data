// #2514 (#2510 B0) 전국 candidate pack 게이트 하네스 회귀.
//
// 검증 축:
//   1. tracked evidence가 현행 입력에서 바이트 단위로 재생성된다(오프라인·서명 키 없이).
//   2. 파일럿 scope가 line-scope 재기술 전 MISSING → 후 SUPPORTED로 전이한다.
//   3. spec의 line-scope 재기술과 tracked source-inventory가 어긋나면 하네스가 fail closed 한다.
//   4. production 게시 트랙 fixture는 candidate 조립에 영향받지 않는다.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { EVIDENCE_PATH, runNationwideCandidateCoverageGate } from "./run-nationwide-candidate-coverage-gate.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const TOOL_PATH = "tools/datapack/run-nationwide-candidate-coverage-gate.mjs";
const SPEC_PATH = "tools/datapack/nationwide-candidate-pack-spec.json";
const TARGETS_PATH = "tools/datapack/nationwide-coverage-targets.json";
const INVENTORY_PATH = "tools/datapack/source-inventory.json";
const APP_INVENTORY_PATH = "apps/mobile/assets/datapacks/source-inventory.json";
const RESOLUTION_PLAN_PATH =
  "tools/datapack/release/nationwide-public-api-coverage-search-plan-20260725.json";
const RESOLUTIONS_PATH =
  "tools/datapack/release/nationwide-public-api-coverage-resolutions-20260725.json";
const REVIEWED_PACK_PATH = "tools/datapack/release/capital-production-reviewed-pack.json";
const PILOT_REQUIREMENT_KEY = "capital:seoul-metro:seoul-4:route_map_positions";
const PILOT_SOURCE_ID = "seoulmetro-cyberstation-route-map";

const INPUT_PATHS = {
  spec: SPEC_PATH,
  targets: TARGETS_PATH,
  inventory: INVENTORY_PATH,
  resolutionPlan: RESOLUTION_PLAN_PATH,
  resolutions: RESOLUTIONS_PATH,
  // 승계 원본도 해시 축이다. 경로만 기록하면 원본의 값 drift가 evidence를 바이트 동일하게 통과한다.
  inheritedPack: REVIEWED_PACK_PATH,
};
// 임시 RSA 키·런타임 SQLite에 좌우되는 축은 evidence 어느 노드에도 key로 존재하면 안 된다.
const FORBIDDEN_EVIDENCE_KEYS = ["manifestSha256", "sqliteSha256", "signature"];

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

async function sha256Of(relativePath) {
  return createHash("sha256").update(await readFile(path.join(root, relativePath))).digest("hex");
}

// 문자열 substring 탐침은 서술 문자열의 인접 문자에 좌우된다 — 전 노드를 순회해 금지 key 부재를 본다.
function forbiddenKeyPaths(node, nodePath = "$") {
  if (Array.isArray(node)) {
    return node.flatMap((entry, index) => forbiddenKeyPaths(entry, `${nodePath}[${index}]`));
  }
  if (!node || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([key, value]) => [
    ...(FORBIDDEN_EVIDENCE_KEYS.includes(key) ? [`${nodePath}.${key}`] : []),
    ...forbiddenKeyPaths(value, `${nodePath}.${key}`),
  ]);
}

test("커밋된 candidate 게이트 evidence는 현행 입력에서 바이트 단위로 재생성된다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "nationwide-candidate-gate-"));
  try {
    const output = path.join(workspace, "evidence.json");
    await execFileAsync(process.execPath, [
      path.join(root, TOOL_PATH),
      "--spec", SPEC_PATH,
      "--targets", TARGETS_PATH,
      "--inventory", INVENTORY_PATH,
      "--resolution-plan", RESOLUTION_PLAN_PATH,
      "--resolutions", RESOLUTIONS_PATH,
      "--output", output,
    ], { cwd: root });

    const regenerated = await readFile(output, "utf8");
    const tracked = await readFile(path.join(root, EVIDENCE_PATH), "utf8");
    assert.equal(regenerated, tracked, "evidence는 재생성 결과와 바이트 단위로 같아야 한다");

    const evidence = JSON.parse(tracked);
    assert.equal(evidence.artifactKind, "nationwide-candidate-coverage-gate-evidence");
    assert.equal(evidence.issue, 2514);
    assert.deepEqual(evidence.parentIssues, [2510, 2138]);
    assert.equal(evidence.regeneration.evidencePath, EVIDENCE_PATH);
    assert.equal(
      evidence.regeneration.command,
      `node ${TOOL_PATH} --spec ${SPEC_PATH} --targets ${TARGETS_PATH} --inventory ${INVENTORY_PATH}`
        + ` --resolution-plan ${RESOLUTION_PLAN_PATH} --resolutions ${RESOLUTIONS_PATH}`
        + ` --output ${EVIDENCE_PATH}`,
    );

    // 기록된 입력 해시는 tracked 입력 파일의 실제 해시여야 한다(입력 drift 감지축).
    for (const [name, relativePath] of Object.entries(INPUT_PATHS)) {
      assert.equal(evidence.inputs[name].path, relativePath);
      assert.equal(evidence.inputs[name].sha256, await sha256Of(relativePath));
    }

    // 임시 RSA 키·SQLite 바이트·wall-clock 의존 집계는 기록 축이 아니다(결정성 계약).
    assert.equal(evidence.harness.signing.mode, "EPHEMERAL_RSA_2048");
    assert.equal(evidence.determinism.packPayloadIdenticalAcrossVariants, true);
    assert.deepEqual(forbiddenKeyPaths(evidence), []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("파일럿 scope는 line-scope 재기술로 MISSING에서 SUPPORTED로 전이한다", async () => {
  const evidence = await readJson(EVIDENCE_PATH);

  // candidate는 root가 되는 단일 pack이어야 게이트가 단독 계약으로 판정한다.
  assert.equal(evidence.candidatePack.id, "nationwide-candidate");
  assert.equal(evidence.candidatePack.artifactKind, "production");
  assert.equal(evidence.candidatePack.inheritsFrom.path, REVIEWED_PACK_PATH);

  // 전이는 절대 수치가 아니라 상대 비교로 본다. 승계 팩의 다른 소스가 line-scope를 갖게 되면
  // 두 variant의 supported 총량이 함께 늘 수 있고, 그때도 아래 두 축은 그대로 성립해야 한다.
  const baselineKeys = evidence.variants.baseline.supportedRequirementKeys;
  assert.equal(baselineKeys.includes(PILOT_REQUIREMENT_KEY), false);
  assert.deepEqual(
    evidence.variants.lineScoped.supportedRequirementKeys,
    [...new Set([...baselineKeys, PILOT_REQUIREMENT_KEY])].sort(),
  );
  assert.equal(
    evidence.variants.lineScoped.launchRequired.supportedCount,
    evidence.variants.baseline.launchRequired.supportedCount + 1,
  );
  assert.equal(evidence.variants.lineScoped.launchRequired.totalCount, 270);

  const [before] = evidence.variants.baseline.pilotRequirements;
  const [after] = evidence.variants.lineScoped.pilotRequirements;
  assert.equal(before.requirementKey, PILOT_REQUIREMENT_KEY);
  assert.equal(before.status, "MISSING");
  assert.deepEqual(before.missingFields, ["route_map_position", "route_map_label_polygon"]);
  assert.equal(after.status, "SUPPORTED");
  assert.equal(after.releaseTier, "LAUNCH_REQUIRED");
  assert.equal(after.coveredFields, 2);
  assert.equal(after.denominator, 2);
  assert.deepEqual(after.sourceIds, [PILOT_SOURCE_ID]);
  assert.deepEqual(after.missingFields, []);
  // denominator 2는 필수 필드 2개를 뜻하고 데이터 행 2개가 아니다 — 뒷받침 행수를 따로 고정한다.
  assert.deepEqual(after.supportingRecordCountByField, {
    route_map_position: 2,
    route_map_label_polygon: 2,
  });
  assert.deepEqual(before.supportingRecordCountByField, {
    route_map_position: 0,
    route_map_label_polygon: 0,
  });
  assert.match(evidence.readingGuide.denominatorSemanticsKo, /데이터 행 수가 아니다/);

  assert.deepEqual(evidence.transitions, [{
    requirementKey: PILOT_REQUIREMENT_KEY,
    before: "MISSING",
    after: "SUPPORTED",
    sourceIds: [PILOT_SOURCE_ID],
    coveredFields: 2,
    denominator: 2,
  }]);
});

test("candidate spec의 line-scope 재기술은 tracked source inventory와 동기다", async (context) => {
  const spec = await readJson(SPEC_PATH);
  const inventory = await readJson(INVENTORY_PATH);
  const appInventory = await readJson(APP_INVENTORY_PATH);
  const [redescription] = spec.lineScopeRedescriptions;
  assert.equal(redescription.sourceId, PILOT_SOURCE_ID);
  assert.deepEqual(redescription.lineIds, ["seoul-4"]);
  assert.deepEqual(redescription.requirementKeys, [PILOT_REQUIREMENT_KEY]);

  const source = inventory.sources.find(({ id }) => id === PILOT_SOURCE_ID);
  assert.deepEqual(source.coverageScope.lineIds, redescription.lineIds);
  assert.ok(source.coverageScope.sourceDomains.includes(redescription.sourceDomain));
  assert.deepEqual(appInventory, inventory, "앱 번들 사본은 datapack 정본과 같아야 한다");

  await context.test("inventory lineIds가 spec과 어긋나면 하네스가 거부한다", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "nationwide-candidate-gate-drift-"));
    const drifted = structuredClone(inventory);
    delete drifted.sources.find(({ id }) => id === PILOT_SOURCE_ID).coverageScope.lineIds;
    try {
      await assert.rejects(
        runNationwideCandidateCoverageGate({
          spec,
          specInput: { path: SPEC_PATH, sha256: "a".repeat(64) },
          targetsInput: { path: TARGETS_PATH, sha256: "b".repeat(64) },
          inventory: drifted,
          inventoryInput: { path: INVENTORY_PATH, sha256: "c".repeat(64) },
          resolutionPlanInput: { path: RESOLUTION_PLAN_PATH, sha256: "d".repeat(64) },
          resolutionsInput: { path: RESOLUTIONS_PATH, sha256: "e".repeat(64) },
          workDir: workspace,
        }),
        /source inventory coverageScope\.lineIds must match the spec redescription/,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

// candidate 안전 경계를 산문이 아니라 코드가 강제하는지 본다. 이 도구는 artifactKind production으로 실제
// RSA 서명 manifest를 만들기 때문에, spec 편집만으로 production 채널·게시 가능 URL 서명본이 나오면 안 된다.
test("candidate 안전 경계는 spec 편집만으로 넓힐 수 없다", async (context) => {
  const spec = await readJson(SPEC_PATH);
  const inventory = await readJson(INVENTORY_PATH);

  async function rejectsWith(mutate, expected) {
    const workspace = await mkdtemp(path.join(tmpdir(), "nationwide-candidate-gate-guard-"));
    const mutated = structuredClone(spec);
    mutate(mutated);
    try {
      await assert.rejects(
        runNationwideCandidateCoverageGate({
          spec: mutated,
          specInput: { path: SPEC_PATH, sha256: "a".repeat(64) },
          targetsInput: { path: TARGETS_PATH, sha256: "b".repeat(64) },
          inventory,
          inventoryInput: { path: INVENTORY_PATH, sha256: "c".repeat(64) },
          resolutionPlanInput: { path: RESOLUTION_PLAN_PATH, sha256: "d".repeat(64) },
          resolutionsInput: { path: RESOLUTIONS_PATH, sha256: "e".repeat(64) },
          workDir: workspace,
        }),
        expected,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  await context.test("production 채널 manifest는 거부된다", async () => {
    await rejectsWith(
      (value) => { value.manifest.channel = "production"; },
      /manifest\.channel must be candidate/,
    );
  });

  await context.test("게시 가능한 pack url은 거부된다", async () => {
    await rejectsWith(
      (value) => { value.pack.url = "https://objectstorage.example.com/catalog/nationwide-candidate-v1.sqlite.gz"; },
      /pack\.url host must be the non-publishable host/,
    );
  });

  await context.test("파일럿 범위를 넘는 다중 lineIds는 거부된다", async () => {
    await rejectsWith(
      (value) => { value.lineScopeRedescriptions[0].lineIds = ["seoul-4", "seoul-2"]; },
      /lineIds must describe exactly one line/,
    );
  });
});

test("production 게시 트랙 fixture는 candidate 조립에 영향받지 않는다", async () => {
  const spec = await readJson(SPEC_PATH);
  const reviewed = await readJson(REVIEWED_PACK_PATH);
  const [pack] = reviewed.packs;

  assert.equal(reviewed.packs.length, 1);
  assert.equal(pack.id, "capital");
  assert.equal(pack.version, "1");
  assert.equal(pack.artifactKind, "production");
  assert.equal(reviewed.manifest.channel, "production");
  assert.deepEqual(reviewed.manifest.activePack, { id: "capital", version: "1" });
  assert.notEqual(spec.pack.id, pack.id);
  assert.notEqual(spec.pack.url, pack.url);
  // 게시 fixture의 coverageScope 기술 자체는 여기서 못박지 않는다. #2510 로드맵의 최종 목표가 게시 팩의
  // line-scope화이므로 operator-scope를 영구 계약으로 고정하면 정상 진행과 충돌한다. 게시 동작 불변은
  // candidate 조립이 게시 정체성(id·version·url·channel·activePack)을 건드리지 않는다는 위 행위 단언과
  // datapack/release 계약 테스트로 유지한다.
});
