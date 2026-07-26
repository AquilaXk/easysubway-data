// #2514 (#2510 B0) 전국 candidate pack 게이트 하네스 회귀. #2549 (#2510 B1) 대구 편입으로 확장.
//
// 검증 축:
//   1. tracked evidence가 현행 입력에서 바이트 단위로 재생성된다(오프라인·서명 키 없이).
//   2. 파일럿 scope가 line-scope 재기술 전 MISSING → 후 SUPPORTED로 전이한다.
//   3. 대구 9 requirement가 같은 실행에서 MISSING → SUPPORTED로 전이한다(B1).
//   4. spec의 line-scope 재기술과 tracked source-inventory가 어긋나면 하네스가 fail closed 한다.
//   5. 지역 데이터 편입은 allowlist materializer·tracked 입력·선언 행수·승계 행 불변에 묶인다(B1).
//   6. production 게시 트랙 fixture는 candidate 조립에 영향받지 않는다.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  EVIDENCE_PATH,
  assertInheritedRowsUnchanged,
  inheritedRowSnapshot,
  runNationwideCandidateCoverageGate,
} from "./run-nationwide-candidate-coverage-gate.mjs";

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
// #2549 B1 대상 9 requirement(대구 3노선 × membership/topology/timetable).
const DAEGU_LINE_IDS = ["line-5b8d9b05e7e6", "line-e2938a4cc492", "line-0ffaa95b1b5d"];
const DAEGU_DOMAINS = ["station_line_membership", "route_graph_topology", "schedule_timetable"];
const DAEGU_REQUIREMENT_KEYS = DAEGU_LINE_IDS
  .flatMap((lineId) => DAEGU_DOMAINS.map((domain) => `daegu:daegu-transportation:${lineId}:${domain}`));
const DAEGU_MATERIALIZER = "tools/datapack/materialize-daegu-timetable.mjs";

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
    assert.equal(evidence.issue, 2549);
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
    // 지역 편입 입력도 같은 축이다. 저장소에 편입 행을 복제하지 않으므로 이 해시가 candidate 구성의
    // 유일한 결속이며, snapshot 한 바이트가 바뀌면 evidence 재생성이 강제돼야 한다.
    const [daeguInclusion] = evidence.packDataInclusions.entries;
    assert.equal(daeguInclusion.regionId, "daegu");
    assert.equal(daeguInclusion.materializer, DAEGU_MATERIALIZER);
    assert.ok(daeguInclusion.inputs.length > 0);
    for (const input of daeguInclusion.inputs) {
      assert.equal(input.sha256, await sha256Of(input.path));
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
  const transitioningKeys = [PILOT_REQUIREMENT_KEY, ...DAEGU_REQUIREMENT_KEYS];
  const baselineKeys = evidence.variants.baseline.supportedRequirementKeys;
  for (const key of transitioningKeys) {
    assert.equal(baselineKeys.includes(key), false, `${key}는 재기술 전 SUPPORTED가 아니어야 한다`);
  }
  assert.deepEqual(
    evidence.variants.lineScoped.supportedRequirementKeys,
    [...new Set([...baselineKeys, ...transitioningKeys])].sort(),
  );
  assert.equal(
    evidence.variants.lineScoped.launchRequired.supportedCount,
    evidence.variants.baseline.launchRequired.supportedCount + transitioningKeys.length,
  );
  assert.equal(evidence.variants.lineScoped.launchRequired.totalCount, 270);

  // pilotRequirements는 codepoint 순이라 capital 파일럿이 항상 첫 항목이다.
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

  assert.deepEqual(evidence.transitions.find((entry) => entry.requirementKey === PILOT_REQUIREMENT_KEY), {
    requirementKey: PILOT_REQUIREMENT_KEY,
    before: "MISSING",
    after: "SUPPORTED",
    sourceIds: [PILOT_SOURCE_ID],
    coveredFields: 2,
    denominator: 2,
  });
  assert.deepEqual(
    evidence.transitions.map(({ requirementKey }) => requirementKey),
    [...transitioningKeys].sort(),
  );
});

// #2549 B1: 대구 3노선 × membership/topology/timetable 9 requirement가 한 실행에서 함께 전이한다.
test("대구 9 requirement는 candidate 편입으로 MISSING에서 SUPPORTED로 전이한다", async () => {
  const evidence = await readJson(EVIDENCE_PATH);
  const byKey = new Map(evidence.variants.lineScoped.pilotRequirements.map((entry) => [entry.requirementKey, entry]));
  const baselineByKey = new Map(
    evidence.variants.baseline.pilotRequirements.map((entry) => [entry.requirementKey, entry]),
  );
  // 도메인별 필수 필드 3개가 전부 covered여야 SUPPORTED다 — 부분 충족이 통과하지 않는지 필드 단위로 본다.
  const expectedFields = {
    station_line_membership: ["line", "station_name", "station_code"],
    route_graph_topology: ["network_edges", "duration_seconds", "distance_meters"],
    schedule_timetable: ["service_calendar", "trip", "stop_time"],
  };

  assert.equal(DAEGU_REQUIREMENT_KEYS.length, 9);
  for (const requirementKey of DAEGU_REQUIREMENT_KEYS) {
    const [, , , sourceDomain] = requirementKey.split(":");
    const before = baselineByKey.get(requirementKey);
    const after = byKey.get(requirementKey);
    assert.equal(before.status, "MISSING", `${requirementKey} baseline`);
    assert.deepEqual(before.sourceIds, [], `${requirementKey} baseline sourceIds`);
    assert.deepEqual(before.missingFields, expectedFields[sourceDomain], `${requirementKey} baseline missingFields`);
    assert.equal(after.status, "SUPPORTED", `${requirementKey} lineScoped`);
    assert.equal(after.releaseTier, "LAUNCH_REQUIRED");
    assert.equal(after.denominator, 3);
    assert.equal(after.coveredFields, 3);
    assert.deepEqual(after.missingFields, []);
    assert.deepEqual(after.fieldCoverage.map(({ field }) => field), expectedFields[sourceDomain]);
    // 뒷받침 provenance 행이 0인데 covered로 잡히는 판정은 없어야 한다.
    assert.ok(
      Object.values(after.supportingRecordCountByField).every((count) => count > 0),
      `${requirementKey} supporting rows`,
    );
  }

  // membership은 molit 소속 소스와 topology 소스가 함께 뒷받침해야 필수 필드 3개가 채워진다.
  const membership = byKey.get(`daegu:daegu-transportation:${DAEGU_LINE_IDS[0]}:station_line_membership`);
  assert.deepEqual(membership.sourceIds, [
    "daegu-line1-route-topology",
    "molit-urban-rail-full-route-daegu-line1-membership",
  ]);
});

test("candidate spec의 line-scope 재기술은 tracked source inventory와 동기다", async (context) => {
  const spec = await readJson(SPEC_PATH);
  const inventory = await readJson(INVENTORY_PATH);
  const appInventory = await readJson(APP_INVENTORY_PATH);
  const [redescription] = spec.lineScopeRedescriptions;
  assert.equal(redescription.sourceId, PILOT_SOURCE_ID);
  assert.deepEqual(redescription.lineIds, ["seoul-4"]);
  assert.deepEqual(redescription.requirementKeys, [PILOT_REQUIREMENT_KEY]);

  // 재기술 전건이 admission 정본과 동기여야 한다. #2549는 inventory를 바꾸지 않고 이미 line-scope로
  // 기술된 대구 소스를 그대로 승계하므로, 이 축이 깨지면 재기술이 정본을 앞질렀다는 뜻이다.
  assert.deepEqual(
    [...new Set(spec.lineScopeRedescriptions.flatMap(({ requirementKeys }) => requirementKeys))].sort(),
    [PILOT_REQUIREMENT_KEY, ...DAEGU_REQUIREMENT_KEYS].sort(),
  );
  for (const entry of spec.lineScopeRedescriptions) {
    const declared = inventory.sources.find(({ id }) => id === entry.sourceId);
    assert.deepEqual(declared.coverageScope.lineIds, entry.lineIds, entry.sourceId);
    assert.ok(declared.coverageScope.sourceDomains.includes(entry.sourceDomain), entry.sourceId);
    for (const requirementKey of entry.requirementKeys) {
      const [regionId, operatorId, lineId, sourceDomain] = requirementKey.split(":");
      assert.ok(declared.coverageScope.regionIds.includes(regionId), requirementKey);
      assert.ok(declared.coverageScope.operatorIds.includes(operatorId), requirementKey);
      assert.ok(entry.lineIds.includes(lineId), requirementKey);
      assert.equal(sourceDomain, entry.sourceDomain, requirementKey);
    }
  }
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

  // #2549 B1이 파일럿의 "lineIds 1개" 단언을 근거 결속으로 바꿨다. 개수 제한이 사라진 자리를 아래 축이
  // 대신 막는지 본다 — 선언 범위는 admission 정본(inventory)과 declare한 requirementKeys에 묶여 있다.
  await context.test("선언 lineIds가 admission 정본과 다르면 거부된다", async () => {
    await rejectsWith(
      (value) => {
        // requirementKeys까지 함께 넓혀 spec 내부 정합은 맞춘 채로 정본 결속만 어긋나게 한다.
        value.lineScopeRedescriptions[0].lineIds = ["seoul-4", "seoul-2"];
        value.lineScopeRedescriptions[0].requirementKeys = [
          PILOT_REQUIREMENT_KEY,
          "capital:seoul-metro:seoul-2:route_map_positions",
        ];
      },
      /source inventory coverageScope\.lineIds must match the spec redescription/,
    );
  });

  await context.test("requirementKeys가 덮지 않는 lineIds는 거부된다", async () => {
    await rejectsWith(
      (value) => {
        value.lineScopeRedescriptions[0].lineIds = ["seoul-4", "seoul-2"];
        value.lineScopeRedescriptions[0].requirementKeys = [PILOT_REQUIREMENT_KEY];
      },
      /requirementKeys must cover every redescribed line/,
    );
  });

  await context.test("재기술 도메인을 벗어난 requirementKey는 거부된다", async () => {
    await rejectsWith(
      (value) => {
        value.lineScopeRedescriptions[0].requirementKeys = ["capital:seoul-metro:seoul-4:route_graph_topology"];
      },
      /requirementKeys must stay in the redescribed source domain/,
    );
  });

  // 두 항목 각각은 내부 정합(도메인·lineIds·requirementKeys)이 맞아 도메인 가드에 걸리지 않는다 —
  // 오직 소스 간 lineIds 동일 강제 축만 이 mutation을 잡는다(정규식 alternation 없이 그 축을 고정한다).
  await context.test("같은 소스를 도메인별로 갈라 다른 lineIds를 선언할 수 없다", async () => {
    await rejectsWith(
      (value) => {
        const entry = value.lineScopeRedescriptions.find(
          ({ sourceId, sourceDomain }) =>
            sourceId === "daegu-line1-route-topology" && sourceDomain === "route_graph_topology",
        );
        entry.lineIds = [DAEGU_LINE_IDS[1]];
        entry.requirementKeys = [`daegu:daegu-transportation:${DAEGU_LINE_IDS[1]}:route_graph_topology`];
      },
      /must declare the same lineIds across domains/,
    );
  });

  await context.test("allowlist에 없는 materializer는 거부된다", async () => {
    await rejectsWith(
      (value) => { value.packDataInclusions[0].materializer = "tools/datapack/materialize-busan-timetable.mjs"; },
      /unknown pack data materializer/,
    );
  });

  await context.test("저장소 밖 편입 입력은 거부된다", async () => {
    await rejectsWith(
      (value) => { value.packDataInclusions[0].stationMapPath = "../molit-urban-rail-full-route-20251211.csv"; },
      /must be a repository-relative path inside the repo/,
    );
  });

  // 저장소 안 symlink가 밖을 가리키면 문자열 containment는 통과한다 — 실경로 재확인 축을 고정한다.
  await context.test("저장소 밖을 가리키는 symlink 입력은 거부된다", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "nationwide-candidate-gate-outside-"));
    const linkPath = path.join(root, "tools/datapack/sources", `escape-${process.pid}.csv`);
    await writeFile(path.join(outside, "escape.csv"), "");
    await symlink(path.join(outside, "escape.csv"), linkPath);
    try {
      await rejectsWith(
        (value) => {
          value.packDataInclusions[0].stationMapPath = path.relative(root, linkPath);
        },
        /must not resolve outside the repo/,
      );
    } finally {
      await rm(linkPath, { force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  await context.test("offset 없는 materializedAt은 거부된다", async () => {
    await rejectsWith(
      (value) => { value.packDataInclusions[0].materializedAt = "2026-07-20T16:00:00"; },
      /materializedAt must be a UTC ISO-8601 timestamp/,
    );
  });

  // 등재 소스를 빼면 그 소스는 baseline에서도 line-scope를 유지해 판정 자체는 그대로 나온다 —
  // 전이를 뒷받침한 소스와 등재 목록의 일치 축만 이 누락을 잡는다.
  await context.test("전이를 뒷받침한 소스가 등재 목록과 다르면 거부된다", async () => {
    await rejectsWith(
      (value) => {
        value.lineScopeRedescriptions = value.lineScopeRedescriptions.filter(
          ({ sourceId }) => sourceId !== "molit-urban-rail-full-route-daegu-line1-membership",
        );
      },
      /supporting sources must equal the spec redescriptions/,
    );
  });

  await context.test("선언과 다른 행수를 싣는 편입은 거부된다", async () => {
    await rejectsWith(
      (value) => { value.packDataInclusions[0].addedRows.transitStopTimes += 1; },
      /added rows do not match the spec declaration/,
    );
  });

  await context.test("snapshot 신선도 창 밖으로 기준 시각을 옮기면 거부된다", async () => {
    await rejectsWith(
      (value) => { value.packDataInclusions[0].materializedAt = "2026-07-25T00:00:00.000Z"; },
      /evidence is stale or future-dated/,
    );
  });
});

// 승계 행 불변 축은 행수가 그대로인 변조를 잡으므로 addedRows 대조가 대신 지켜 주지 못한다.
// 합성 pack으로 단언 자체를 직접 고정한다(append 정상 / 앞쪽 행 수정 / 승계 행 삭제).
test("승계 행 불변 단언은 append만 통과시키고 수정·삭제를 거부한다", () => {
  const inherited = {
    stations: [{ id: "a" }, { id: "b" }],
    networkEdges: [{ id: "e1" }],
    // 배열이 아닌 필드는 집계 축이 아니다.
    metadata: { activePack: "candidate" },
  };
  const snapshot = inheritedRowSnapshot(inherited);
  assert.deepEqual(Object.keys(snapshot.counts).sort(), ["networkEdges", "stations"]);
  assert.deepEqual(snapshot.counts, { stations: 2, networkEdges: 1 });

  assertInheritedRowsUnchanged("synthetic", snapshot, {
    ...inherited,
    stations: [...inherited.stations, { id: "appended" }],
    networkEdges: [...inherited.networkEdges, { id: "e2" }],
  });

  assert.throws(
    () => assertInheritedRowsUnchanged("synthetic", snapshot, {
      ...inherited,
      stations: [{ id: "a", nameKo: "변조" }, inherited.stations[1], { id: "appended" }],
    }),
    /synthetic pack data inclusion modified inherited rows: stations/,
  );

  assert.throws(
    () => assertInheritedRowsUnchanged("synthetic", snapshot, {
      ...inherited,
      stations: [inherited.stations[0]],
    }),
    /synthetic pack data inclusion dropped inherited rows: stations/,
  );
});

// 위 단위 축과 별개로, 조립 경로가 그 단언을 실제로 호출하는지를 고정한다(호출이 사라지면 이 회귀가 깨진다).
// PACK_DATA_MATERIALIZERS는 모듈 내부 상수라 spec 편집으로는 이 경로에 닿을 수 없어 in-process seam을 쓴다.
test("조립 경로는 승계 행을 변조하는 materializer를 거부한다", async () => {
  const spec = structuredClone(await readJson(SPEC_PATH));
  const inventory = await readJson(INVENTORY_PATH);
  const [inheritedPack] = (await readJson(REVIEWED_PACK_PATH)).packs;
  const materializerId = "test://mutates-inherited-rows";
  // 행을 더하지 않으므로 선언 행수는 전부 0이다 — addedRows 대조는 통과하고 승계 행 불변 축만 걸린다.
  spec.packDataInclusions = [{
    regionId: "synthetic",
    materializer: materializerId,
    materializedAt: "2026-07-20T16:00:00.000Z",
    stationMapPath: "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv",
    lines: [{
      lineNumber: 1,
      lineId: "line-5b8d9b05e7e6",
      topologySnapshotPath: "tools/datapack/sources/daegu-line1-route-topology-20260721.json",
      timetableSnapshotPath: "tools/datapack/sources/daegu-line1-train-timetable-20260721.json",
    }],
    addedRows: Object.fromEntries(
      Object.entries(inheritedPack).filter(([, value]) => Array.isArray(value)).map(([table]) => [table, 0]),
    ),
  }];
  const materializers = new Map([[materializerId, (fixture) => {
    const mutated = structuredClone(fixture);
    mutated.packs[0].stations[0].nameKo = "변조";
    return mutated;
  }]]);

  const workspace = await mkdtemp(path.join(tmpdir(), "nationwide-candidate-gate-inherited-"));
  try {
    await assert.rejects(
      runNationwideCandidateCoverageGate({
        spec,
        specInput: { path: SPEC_PATH, sha256: "a".repeat(64) },
        targetsInput: { path: TARGETS_PATH, sha256: "b".repeat(64) },
        inventory,
        inventoryInput: { path: INVENTORY_PATH, sha256: "c".repeat(64) },
        resolutionPlanInput: { path: RESOLUTION_PLAN_PATH, sha256: "d".repeat(64) },
        resolutionsInput: { path: RESOLUTIONS_PATH, sha256: "e".repeat(64) },
        workDir: workspace,
        materializers,
      }),
      /synthetic pack data inclusion modified inherited rows: stations/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
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
