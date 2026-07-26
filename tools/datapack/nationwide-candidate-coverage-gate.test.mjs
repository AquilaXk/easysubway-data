// #2514 (#2510 B0) 전국 candidate pack 게이트 하네스 회귀. #2549 (#2510 B1) 대구 편입,
// #2580 (#2510 B2-a) 다도메인 편입 체인, #2587 (#2510 B2-b) 부산 편입으로 확장.
//
// 검증 축:
//   1. tracked evidence가 현행 입력에서 바이트 단위로 재생성된다(오프라인·서명 키 없이).
//   2. 파일럿 scope가 line-scope 재기술 전 MISSING → 후 SUPPORTED로 전이한다.
//   3. 대구 9 requirement가 같은 실행에서 MISSING → SUPPORTED로 전이한다(B1).
//   4. spec의 line-scope 재기술과 tracked source-inventory가 어긋나면 하네스가 fail closed 한다.
//   5. 지역 데이터 편입은 allowlist materializer·tracked 입력·선언 행수·승계 행 불변에 묶인다(B1).
//   6. production 게시 트랙 fixture는 candidate 조립에 영향받지 않는다.
//   7. 대구 route_map_positions·accessibility_facilities 6 requirement가 B1 편입 뒤 체인으로 전이하고,
//      스키마 일반화가 안전 경계를 넓히지 않는다(B2-a).
//   8. 부산 4노선 5도메인 20 requirement가 같은 실행에서 전이하고, 지역 자체가 없는 승계 원본에
//      topology → 나머지 도메인 순으로 체인되는 선행 조건이 조립에서 강제된다(B2-b).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
// #2549 B1 대상 9 requirement(대구 3노선 × membership/topology/timetable)와
// #2580 B2-a 대상 6 requirement(대구 3노선 × route_map_positions/accessibility_facilities).
const DAEGU_LINE_IDS = ["line-5b8d9b05e7e6", "line-e2938a4cc492", "line-0ffaa95b1b5d"];
const daeguRequirementKeys = (domains) => DAEGU_LINE_IDS
  .flatMap((lineId) => domains.map((domain) => `daegu:daegu-transportation:${lineId}:${domain}`));
const DAEGU_B1_DOMAINS = ["station_line_membership", "route_graph_topology", "schedule_timetable"];
const DAEGU_B1_REQUIREMENT_KEYS = daeguRequirementKeys(DAEGU_B1_DOMAINS);
const DAEGU_B2A_REQUIREMENT_KEYS = daeguRequirementKeys(["route_map_positions", "accessibility_facilities"]);
const DAEGU_REQUIREMENT_KEYS = [...DAEGU_B1_REQUIREMENT_KEYS, ...DAEGU_B2A_REQUIREMENT_KEYS];
// #2587 B2-b 대상 20 requirement(부산 4노선 × 5도메인).
const BUSAN_LINE_IDS = ["line-ab1a041f6266", "line-d74614a04530", "line-d812a5bc1e5f", "line-eb7b47920390"];
const BUSAN_DOMAINS = [
  "station_line_membership",
  "route_graph_topology",
  "schedule_timetable",
  "route_map_positions",
  "accessibility_facilities",
];
const BUSAN_REQUIREMENT_KEYS = BUSAN_LINE_IDS
  .flatMap((lineId) => BUSAN_DOMAINS.map((domain) => `busan:busan-transportation:${lineId}:${domain}`));
// 편입 체인 순서. route_map·accessibility materializer는 pack.sourceInventory에 대구 시각표 소스가
// 이미 있을 것을 선행 조건으로 검사하므로 시각표 편입이 먼저여야 한다. 부산은 승계 원본에 지역 자체가
// 없어 topology 편입이 운영기관·노선·역을 먼저 싣고 나머지 세 도메인이 그 계보를 선행 조건으로 검사한다.
const DAEGU_MATERIALIZERS = [
  "tools/datapack/materialize-daegu-timetable.mjs",
  "tools/datapack/materialize-daegu-route-map-positions.mjs",
  "tools/datapack/materialize-daegu-accessibility.mjs",
];
const BUSAN_MATERIALIZERS = [
  "tools/datapack/materialize-busan-route-topology.mjs",
  "tools/datapack/materialize-busan-timetable.mjs",
  "tools/datapack/materialize-busan-route-map-positions.mjs",
  "tools/datapack/materialize-busan-accessibility.mjs",
];
const INCLUSION_CHAIN = [
  ...DAEGU_MATERIALIZERS.map((materializer) => ({ regionId: "daegu", materializer })),
  ...BUSAN_MATERIALIZERS.map((materializer) => ({ regionId: "busan", materializer })),
];
// 부산 편입 인덱스(대구 3건 뒤에 이어 붙는다).
const BUSAN_TOPOLOGY_INDEX = DAEGU_MATERIALIZERS.length;
// 부산 편입 4종의 결속 지점·신선도 창 축. 결속 회귀를 편입 하나로만 두면 나머지 편입의 가드가 풀려도
// 회귀가 침묵하므로(네 편입 모두 실측상 fail closed다) 이 표로 편입별로 돌린다. 경로·창 값은 admission
// 정본(source-inventory)에서 끌어오고, 창 밖 진단은 판정 지점이 materializer마다 달라 문구가 갈리므로
// 편입별 패턴으로 고정한다.
const BUSAN_INCLUSION_BINDINGS = [
  {
    labelKo: "topology",
    slug: "route-topology",
    offset: 0,
    sourceId: "busan-transportation-route-topology",
    evidenceKey: "topologyAdmissionEvidence",
    stalePinPattern: /Busan route topology admission stale snapshot is rejected/,
  },
  {
    labelKo: "시각표",
    slug: "timetable",
    offset: 1,
    sourceId: "busan-transportation-timetable",
    evidenceKey: "scheduleAdmissionEvidence",
    stalePinPattern: /busan-transportation-timetable evidence freshness is invalid/,
  },
  {
    labelKo: "노선도",
    slug: "route-map-positions",
    offset: 2,
    sourceId: "busan-transportation-route-map-positions",
    evidenceKey: "routeMapAdmissionEvidence",
    // 이 문구만 신선도 전용이 아니다 — 노선도 정본에는 freshUntil이 없어 materializer에 신선도 블록이
    // 따로 없고, 하한(capturedAt 이후) 검사가 admission 정본 대조(positionsSha256·topologyContentSha256
    // 등)와 한 조건에 묶여 같은 문구를 낸다. 문구를 가르는 것은 materializer 쪽 판단이라 이 하네스가
    // 동작으로 바꾸지 않고, 대신 아래 대조 회귀가 그 문구의 원인을 하한 교차로 좁힌다.
    stalePinPattern: /busan-transportation-route-map-positions inventory evidence does not match snapshot/,
  },
  {
    labelKo: "편의시설",
    slug: "accessibility",
    offset: 3,
    sourceId: "busan-transportation-accessibility",
    evidenceKey: "accessibilityAdmissionEvidence",
    stalePinPattern: /busan-transportation-accessibility evidence freshness is invalid/,
  },
];
const [
  BUSAN_TOPOLOGY_BINDING,
  BUSAN_TIMETABLE_BINDING,
  BUSAN_ROUTE_MAP_BINDING,
  BUSAN_ACCESSIBILITY_BINDING,
] = BUSAN_INCLUSION_BINDINGS;
const admissionEvidenceOf = (inventory, sourceId, evidenceKey) =>
  inventory.sources.find(({ id }) => id === sourceId)[evidenceKey];

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
    assert.equal(evidence.issue, 2587);
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
    // 체인 순서도 기록 축이다. 다만 조립이 강제하는 순서는 선행 조건이 있는 쌍뿐이고
    // route_map↔accessibility 교환은 조립을 그대로 통과한다(실측) — 기록된 전체 순서를 고정하는 축은
    // 조립 fail closed가 아니라 이 evidence 대조다.
    assert.deepEqual(
      evidence.packDataInclusions.entries.map(({ regionId, materializer }) => ({ regionId, materializer })),
      INCLUSION_CHAIN,
    );
    for (const inclusion of evidence.packDataInclusions.entries) {
      assert.ok(inclusion.inputs.length > 0);
      for (const input of inclusion.inputs) {
        assert.equal(input.sha256, await sha256Of(input.path));
      }
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
  const transitioningKeys = [PILOT_REQUIREMENT_KEY, ...DAEGU_REQUIREMENT_KEYS, ...BUSAN_REQUIREMENT_KEYS];
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

  // pilotRequirements는 codepoint 순이므로 첫 항목이 어느 지역인지는 등재 범위가 늘 때마다 바뀐다 —
  // 위치가 아니라 키로 찾는다(#2587에서 busan 키가 capital 앞에 오면서 위치 가정이 깨졌다).
  const requirementNamed = (variant, key) =>
    evidence.variants[variant].pilotRequirements.find((entry) => entry.requirementKey === key);
  const before = requirementNamed("baseline", PILOT_REQUIREMENT_KEY);
  const after = requirementNamed("lineScoped", PILOT_REQUIREMENT_KEY);
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

  assert.equal(DAEGU_B1_REQUIREMENT_KEYS.length, 9);
  for (const requirementKey of DAEGU_B1_REQUIREMENT_KEYS) {
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

// #2580 B2-a: 같은 지역의 route_map_positions·accessibility_facilities 6 requirement가 B1 편입 뒤에
// 체인으로 실린 행으로 전이한다. 두 도메인의 필수 필드 수가 다르므로 분모도 도메인별로 못박는다.
test("대구 route_map/accessibility 6 requirement는 체인 편입으로 MISSING에서 SUPPORTED로 전이한다", async () => {
  const evidence = await readJson(EVIDENCE_PATH);
  const byKey = new Map(evidence.variants.lineScoped.pilotRequirements.map((entry) => [entry.requirementKey, entry]));
  const baselineByKey = new Map(
    evidence.variants.baseline.pilotRequirements.map((entry) => [entry.requirementKey, entry]),
  );
  const expected = {
    route_map_positions: {
      fields: ["route_map_position", "route_map_label_polygon"],
      sourceIds: ["daegu-transportation-route-map-positions"],
    },
    accessibility_facilities: {
      fields: ["elevator", "escalator", "wheelchair_lift", "status", "verified_at"],
      sourceIds: ["daegu-transportation-accessibility"],
    },
  };

  assert.equal(DAEGU_B2A_REQUIREMENT_KEYS.length, 6);
  for (const requirementKey of DAEGU_B2A_REQUIREMENT_KEYS) {
    const [, , , sourceDomain] = requirementKey.split(":");
    const { fields, sourceIds } = expected[sourceDomain];
    const before = baselineByKey.get(requirementKey);
    const after = byKey.get(requirementKey);
    assert.equal(before.status, "MISSING", `${requirementKey} baseline`);
    assert.deepEqual(before.sourceIds, [], `${requirementKey} baseline sourceIds`);
    assert.deepEqual(before.missingFields, fields, `${requirementKey} baseline missingFields`);
    assert.equal(after.status, "SUPPORTED", `${requirementKey} lineScoped`);
    assert.equal(after.releaseTier, "LAUNCH_REQUIRED");
    assert.equal(after.denominator, fields.length);
    assert.equal(after.coveredFields, fields.length);
    assert.deepEqual(after.missingFields, []);
    assert.deepEqual(after.fieldCoverage.map(({ field }) => field), fields);
    assert.deepEqual(after.sourceIds, sourceIds, `${requirementKey} sourceIds`);
    assert.ok(
      Object.values(after.supportingRecordCountByField).every((count) => count > 0),
      `${requirementKey} supporting rows`,
    );
  }

  // 체인 편입이 실제로 실은 행수. 두 표 모두 축이 역이 아니라 역·노선 쌍인데 쌍의 수도 표마다 갈리므로
  // 표별로 못박는다 — 노선도 좌표는 91 역·노선 쌍(고유 역 88: 명덕·반월당·청라언덕 환승 3역이 2쌍씩),
  // 편의시설은 94 역·노선 쌍(고유 역 91) × 3종 = 282행이다. 노선도가 3쌍 적은 것은 대구한의대병원·부호·
  // 하양이 노선도 정본에 좌표가 없기 때문이다(snapshot topologyGaps 3건). 각 편입은 소스 등재 1건씩만
  // 더한다(승계 행과 앞선 편입 행은 그대로여야 한다).
  const [, routeMap, accessibility] = evidence.packDataInclusions.entries;
  assert.equal(routeMap.addedRows.routeMapPositions, 91);
  assert.equal(routeMap.addedRows.sourceInventory, 1);
  assert.equal(routeMap.addedRows.transitStopTimes, 0);
  assert.equal(accessibility.addedRows.facilities, 282);
  assert.equal(accessibility.addedRows.stationFacilityEvidence, 282);
  assert.equal(accessibility.addedRows.sourceInventory, 1);
  assert.equal(accessibility.addedRows.routeMapPositions, 0);
  // pin 상호 상이성은 불변식이 아니다 — 노선도 창과 편의시설 창은 겹쳐서 두 편입이 같은 pin을 써도
  // 조립은 통과한다(실측). 대신 각 pin이 그 소스의 admission 창 안인지를 직접 본다. 창의 모양은
  // 소스마다 다르다.
  const inventory = await readJson(INVENTORY_PATH);
  const admissionEvidence = (sourceId, evidenceKey) => admissionEvidenceOf(inventory, sourceId, evidenceKey);
  const pins = new Map(evidence.packDataInclusions.entries.map(
    ({ materializer, materializedAt }) => [materializer, Date.parse(materializedAt)],
  ));

  // 시각표 편입: 3노선의 topology·시각표 admission 창 [capturedAt, freshUntil)을 모두 만족해야 한다.
  for (const lineNumber of [1, 2, 3]) {
    for (const [sourceId, evidenceKey] of [
      [`daegu-line${lineNumber}-route-topology`, "topologyAdmissionEvidence"],
      [`daegu-line${lineNumber}-train-timetable`, "scheduleAdmissionEvidence"],
    ]) {
      const { capturedAt, freshUntil } = admissionEvidence(sourceId, evidenceKey);
      const pin = pins.get(DAEGU_MATERIALIZERS[0]);
      assert.ok(pin >= Date.parse(capturedAt) && pin < Date.parse(freshUntil), `${sourceId} 창`);
    }
  }
  // 노선도 편입: 신선도 보장이 다른 두 편입과 비대칭이다 — admission 정본에 freshUntil이 없고
  // materializer도 하한(capturedAt 이후)만 검사해 상한이 없다(먼 미래 pin도 통과함이 실측된다).
  // 상한 도입 여부는 materializer 쪽 판단이라 이 하네스의 축이 아니며, 여기서는 그 비대칭을 기록한다.
  const routeMapEvidence = admissionEvidence(
    "daegu-transportation-route-map-positions",
    "routeMapAdmissionEvidence",
  );
  assert.equal(routeMapEvidence.freshUntil, undefined, "노선도 admission 정본에는 상한이 없다");
  assert.ok(pins.get(DAEGU_MATERIALIZERS[1]) >= Date.parse(routeMapEvidence.capturedAt), "노선도 창 하한");
  // 편의시설 편입: [capturedAt, freshUntil) 양끝을 검사한다.
  const accessibilityEvidence = admissionEvidence(
    "daegu-transportation-accessibility",
    "accessibilityAdmissionEvidence",
  );
  const accessibilityPin = pins.get(DAEGU_MATERIALIZERS[2]);
  assert.ok(
    accessibilityPin >= Date.parse(accessibilityEvidence.capturedAt)
      && accessibilityPin < Date.parse(accessibilityEvidence.freshUntil),
    "편의시설 창",
  );
});

// #2587 B2-b: 부산 4노선 × 5도메인 20 requirement가 같은 실행에서 전이한다. 대구와 달리 승계 원본에
// 지역 자체가 없어 topology 편입이 운영기관·노선·역까지 함께 싣는다.
test("부산 20 requirement는 체인 편입으로 MISSING에서 SUPPORTED로 전이한다", async () => {
  const evidence = await readJson(EVIDENCE_PATH);
  const byKey = new Map(evidence.variants.lineScoped.pilotRequirements.map((entry) => [entry.requirementKey, entry]));
  const baselineByKey = new Map(
    evidence.variants.baseline.pilotRequirements.map((entry) => [entry.requirementKey, entry]),
  );
  // membership은 대구와 달리 소스 하나가 필수 필드 3개를 전부 댄다(대구는 molit 소속 소스와 topology
  // 소스의 합산이었다) — 재기술도 소스 하나로 등재되고 뒷받침 소스 목록도 하나여야 한다.
  const expected = {
    station_line_membership: {
      fields: ["line", "station_name", "station_code"],
      sourceIds: ["busan-transportation-route-topology"],
    },
    route_graph_topology: {
      fields: ["network_edges", "duration_seconds", "distance_meters"],
      sourceIds: ["busan-transportation-route-topology"],
    },
    schedule_timetable: {
      fields: ["service_calendar", "trip", "stop_time"],
      sourceIds: ["busan-transportation-timetable"],
    },
    route_map_positions: {
      fields: ["route_map_position", "route_map_label_polygon"],
      sourceIds: ["busan-transportation-route-map-positions"],
    },
    accessibility_facilities: {
      fields: ["elevator", "escalator", "wheelchair_lift", "status", "verified_at"],
      sourceIds: ["busan-transportation-accessibility"],
    },
  };

  assert.equal(BUSAN_REQUIREMENT_KEYS.length, 20);
  for (const requirementKey of BUSAN_REQUIREMENT_KEYS) {
    const [, , , sourceDomain] = requirementKey.split(":");
    const { fields, sourceIds } = expected[sourceDomain];
    const before = baselineByKey.get(requirementKey);
    const after = byKey.get(requirementKey);
    assert.equal(before.status, "MISSING", `${requirementKey} baseline`);
    assert.deepEqual(before.sourceIds, [], `${requirementKey} baseline sourceIds`);
    assert.deepEqual(before.missingFields, fields, `${requirementKey} baseline missingFields`);
    assert.equal(after.status, "SUPPORTED", `${requirementKey} lineScoped`);
    assert.equal(after.releaseTier, "LAUNCH_REQUIRED");
    assert.equal(after.denominator, fields.length);
    assert.equal(after.coveredFields, fields.length);
    assert.deepEqual(after.missingFields, []);
    assert.deepEqual(after.fieldCoverage.map(({ field }) => field), fields);
    assert.deepEqual(after.sourceIds, sourceIds, `${requirementKey} sourceIds`);
    assert.ok(
      Object.values(after.supportingRecordCountByField).every((count) => count > 0),
      `${requirementKey} supporting rows`,
    );
  }

  // 체인 편입이 실제로 실은 행수. topology는 지역 자체를 세우므로 운영기관 1·노선 4·역 108(정본 station
  // id 기준 고유 역 수라 station_lines 114와 다르다)·구간 220을 함께 싣는다.
  const [topology, timetable, routeMap, accessibility] = evidence.packDataInclusions.entries
    .slice(BUSAN_TOPOLOGY_INDEX);
  assert.equal(topology.addedRows.operators, 1);
  assert.equal(topology.addedRows.lines, 4);
  assert.equal(topology.addedRows.stations, 108);
  assert.equal(topology.addedRows.stationLines, 114);
  assert.equal(topology.addedRows.networkEdges, 220);
  assert.equal(topology.addedRows.sourceInventory, 1);
  assert.equal(topology.addedRows.transitStopTimes, 0);
  assert.equal(timetable.addedRows.serviceCalendars, 3);
  assert.equal(timetable.addedRows.transitRoutes, 8);
  assert.equal(timetable.addedRows.transitTrips, 3_833);
  assert.equal(timetable.addedRows.transitStopTimes, 109_140);
  assert.equal(timetable.addedRows.operators, 0);
  assert.equal(routeMap.addedRows.routeMapPositions, 114);
  // 이 편입은 승계 원본에 없던 표를 새로 만든다 — 집계 목록을 pack 자신에서 끌어오므로 새 표도 선언
  // 대상이며, 뒤 편입은 그 표를 0으로 선언해야 대조를 통과한다.
  assert.equal(routeMap.addedRows.routeMapLineTracks, 4);
  assert.equal(accessibility.addedRows.routeMapLineTracks, 0);
  // 114 역·노선 쌍 × 3종(엘리베이터·에스컬레이터·휠체어리프트). 축은 역이 아니라 역·노선 쌍이라 고유 역
  // 108과 갈린다 — 두 노선에 걸친 환승역 6곳은 6행씩 낸다. 미설치도 NOT_EXISTS 근거로 함께 실린다.
  assert.equal(accessibility.addedRows.facilities, 342);
  assert.equal(accessibility.addedRows.stationFacilityEvidence, 342);
  assert.equal(accessibility.addedRows.routeMapPositions, 0);

  // pin은 편입마다 따로 두고 각각 그 소스의 admission 창 안이어야 한다. 부산 4소스의 창은 모양이 갈린다 —
  // topology·시각표·편의시설은 [capturedAt, freshUntil) 양끝을 검사하고 노선도는 상한이 없다.
  // 소스 id·evidence 키는 BUSAN_INCLUSION_BINDINGS가 정본이다 — 여기서 다시 인라인으로 쓰면 정본이
  // 갱신돼도 이 블록만 낡은 짝을 보게 된다.
  const inventory = await readJson(INVENTORY_PATH);
  const bindingEvidence = ({ sourceId, evidenceKey }) => admissionEvidenceOf(inventory, sourceId, evidenceKey);
  const boundedWindows = [
    [topology, BUSAN_TOPOLOGY_BINDING],
    [timetable, BUSAN_TIMETABLE_BINDING],
    [accessibility, BUSAN_ACCESSIBILITY_BINDING],
  ];
  for (const [inclusion, binding] of boundedWindows) {
    const { capturedAt, freshUntil } = bindingEvidence(binding);
    const pin = Date.parse(inclusion.materializedAt);
    assert.ok(pin >= Date.parse(capturedAt) && pin < Date.parse(freshUntil), `${binding.sourceId} 창`);
  }
  const routeMapEvidence = bindingEvidence(BUSAN_ROUTE_MAP_BINDING);
  assert.equal(routeMapEvidence.freshUntil, undefined, "부산 노선도 admission 정본에도 상한이 없다");
  assert.ok(Date.parse(routeMap.materializedAt) >= Date.parse(routeMapEvidence.capturedAt), "노선도 창 하한");
  // 편의시설 창은 상한이 있는 두 창(topology·시각표)과 서로소다 — 그 셋은 pin 하나로 묶는 것이 애초에
  // 불가능하다. 다만 "부산 네 창이 전부 서로소"는 아니다: 노선도 창은 상한이 없어 [capturedAt, ∞)이고
  // 편의시설 창을 통째로 품는다(실측: 노선도 pin을 편의시설 capturedAt으로 옮기면 조립이 통과하고
  // 시각표 capturedAt으로 옮기면 거부된다). 그 포함 관계까지 함께 고정한다.
  const accessibilityWindow = bindingEvidence(BUSAN_ACCESSIBILITY_BINDING);
  for (const binding of [BUSAN_TOPOLOGY_BINDING, BUSAN_TIMETABLE_BINDING]) {
    assert.ok(
      Date.parse(bindingEvidence(binding).freshUntil) <= Date.parse(accessibilityWindow.capturedAt),
      `${binding.sourceId} 창은 편의시설 창보다 앞에서 닫혀 겹치지 않는다`,
    );
  }
  assert.ok(
    Date.parse(routeMapEvidence.capturedAt) <= Date.parse(accessibilityWindow.capturedAt),
    "상한 없는 노선도 창은 편의시설 창을 통째로 품는다",
  );
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
    [PILOT_REQUIREMENT_KEY, ...DAEGU_REQUIREMENT_KEYS, ...BUSAN_REQUIREMENT_KEYS].sort(),
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

  // 저장소에 실재하는 materializer라도 allowlist에 없으면 spec이 가리킬 수 없다(#2587에서 부산 4종이
  // 등재되면서 탐침을 미등재 모듈로 옮겼다 — 등재 확대가 이 축을 지우지 않는지 본다).
  await context.test("allowlist에 없는 materializer는 거부된다", async () => {
    await rejectsWith(
      (value) => { value.packDataInclusions[0].materializer = "tools/datapack/materialize-daejeon-timetable.mjs"; },
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
  // 링크는 저장소 안에 있어야 이 축에 닿지만 tracked 디렉터리에 두면 강제 종료 시 잔재가 남는다
  // (#2580 재검증 지적) — snapshot 사본 회귀와 같이 gitignore된 tmp/ 아래에 만든다.
  await context.test("저장소 밖을 가리키는 symlink 입력은 거부된다", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "nationwide-candidate-gate-outside-"));
    const linkDir = path.join(root, "tmp", `nationwide-candidate-gate-link-${process.pid}-${Date.now()}`);
    await mkdir(linkDir, { recursive: true });
    const linkPath = path.join(linkDir, "escape.csv");
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
      await rm(linkDir, { recursive: true, force: true });
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

  // #2580 B2-a가 편입 스키마를 다도메인으로 넓혔다. 아래 축들이 그 완화가 안전 경계를 넓히지
  // 않았음을 고정한다 — 중복 금지는 (regionId, materializer)로 좁혀졌을 뿐 사라지지 않았고,
  // 형상 분기는 materializer가 실제로 읽는 경로 키를 여전히 필수로 요구하며, 그 경로는 모두
  // 저장소 안 실경로 강제와 입력 해시 결속을 그대로 받는다.
  await context.test("같은 지역·materializer 편입을 두 번 선언하면 거부된다", async () => {
    await rejectsWith(
      (value) => { value.packDataInclusions.push(structuredClone(value.packDataInclusions[1])); },
      /duplicate pack data inclusion: daegu:tools\/datapack\/materialize-daegu-route-map-positions\.mjs/,
    );
  });

  await context.test("materializer가 요구하는 입력 경로 키가 빠지면 거부된다", async () => {
    await rejectsWith(
      (value) => { delete value.packDataInclusions[1].snapshotPath; },
      /materialize-daegu-route-map-positions\.mjs\.snapshotPath is required/,
    );
  });

  // 형상 분기가 넓힌 자리의 반대 방향 축: 등재 형상에 없는 키는 어댑터가 읽지 않으므로 그대로 두면
  // spec이 선언한 입력이 읽히지도 해시되지도 않은 채 통과한다(실측: 무시됐다) — 좁혀서 거부한다.
  await context.test("materializer 형상에 없는 편입 키는 거부된다", async () => {
    await rejectsWith(
      (value) => {
        value.packDataInclusions[1].timetableSnapshotPath =
          "tools/datapack/sources/daegu-line1-train-timetable-20260721.json";
      },
      /materialize-daegu-route-map-positions\.mjs has unknown keys: timetableSnapshotPath/,
    );
  });

  // 서술 키를 "*Ko 접미사면 통과"로 열어 두면 snapshotPathKo 같은 죽은 선언이 그대로 통과한다(실측).
  // 명시 allowlist(reasonKo·materializedAtReasonKo·addedRowsKo)로 좁혔으므로 그 밖의 서술 키는 거부된다.
  await context.test("등재되지 않은 서술 키는 거부된다", async () => {
    await rejectsWith(
      (value) => {
        value.packDataInclusions[1].snapshotPathKo = "tools/datapack/sources/does-not-exist.json";
      },
      /materialize-daegu-route-map-positions\.mjs has unknown keys: snapshotPathKo/,
    );
  });

  await context.test("materializer 형상에 없는 lines 키는 거부된다", async () => {
    await rejectsWith(
      (value) => {
        value.packDataInclusions[1].lines[0].timetableSnapshotPath =
          "tools/datapack/sources/daegu-line1-train-timetable-20260721.json";
      },
      /materialize-daegu-route-map-positions\.mjs\.lines\[\] has unknown keys: timetableSnapshotPath/,
    );
  });

  // spec 단계 중복 금지 단위는 (regionId, materializer)라 같은 materializer를 다른 regionId로 두 번
  // 실으면 그 축에 걸리지 않는다 — materializer의 소스 재등재 거부가 그 자리를 실제로 막는지 본다.
  await context.test("같은 materializer를 다른 regionId로 두 번 실으면 거부된다", async () => {
    await rejectsWith(
      (value) => {
        const duplicated = structuredClone(value.packDataInclusions[1]);
        duplicated.regionId = "daegu-mirror";
        value.packDataInclusions.push(duplicated);
      },
      /daegu-transportation-route-map-positions already exists/,
    );
  });

  // 두 편입 모두 admission 정본의 snapshotPath에 결속돼 있다. 결속이 없으면 아래 사본들이 그대로 조립을
  // 통과한다(실측) — 편의시설 정본에는 바이트 축이 아예 없어 재직렬화 사본도 rawSha256·rowsSha256이 같고,
  // 노선도 정본에는 바이트 축(snapshotSha256)이 있지만 바이트 동일 사본은 그 축을 그대로 지난다.
  // 사본은 하네스가 읽을 수 있게 저장소 안에 두되 gitignore된 tmp/ 아래에 둔다(강제 종료 시 tracked
  // 디렉터리에 잔재가 남지 않게).
  async function rejectsSnapshotCopy({ index, key = "snapshotPath", sourcePath, copyName, serialize, expected }) {
    const copyDir = path.join(root, "tmp", `nationwide-candidate-gate-copy-${process.pid}-${Date.now()}`);
    await mkdir(copyDir, { recursive: true });
    const copyPath = path.relative(root, path.join(copyDir, copyName));
    await writeFile(path.join(root, copyPath), serialize(await readFile(path.join(root, sourcePath))));
    try {
      await rejectsWith((value) => { value.packDataInclusions[index][key] = copyPath; }, expected);
    } finally {
      await rm(copyDir, { recursive: true, force: true });
    }
  }

  await context.test("노선도 편입이 admission 정본 밖 바이트 동일 사본을 가리키면 거부된다", async () => {
    await rejectsSnapshotCopy({
      index: 1,
      sourcePath: "tools/datapack/sources/daegu-transportation-route-map-positions-20260724.json",
      copyName: "route-map-copy.json",
      // 바이트를 그대로 옮긴다 — materializer의 snapshotSha256 대조만으로는 이 사본이 통과한다(실측).
      serialize: (bytes) => bytes,
      expected:
        /snapshotPath must match the daegu-transportation-route-map-positions admission evidence snapshotPath/,
    });
  });

  await context.test("편의시설 편입이 admission 정본 밖 snapshot 사본을 가리키면 거부된다", async () => {
    await rejectsSnapshotCopy({
      index: 2,
      sourcePath: "tools/datapack/sources/daegu-transportation-accessibility-20260724.json",
      copyName: "accessibility-copy.json",
      serialize: (bytes) => JSON.stringify(JSON.parse(bytes.toString("utf8"))),
      expected: /snapshotPath must match the daegu-transportation-accessibility admission evidence snapshotPath/,
    });
  });

  // 노선도 편입의 snapshotPath는 admission 정본 경로에 결속돼 이 축에 닿기 전에 걸린다 — 결속이 없는
  // 경로 키(lines[].topologySnapshotPath)로 일반화된 형상의 저장소 밖 입력 거부를 고정한다.
  await context.test("일반화된 형상의 편입 입력도 저장소 밖을 가리키면 거부된다", async () => {
    await rejectsWith(
      (value) => {
        value.packDataInclusions[1].lines[0].topologySnapshotPath =
          "../daegu-line1-route-topology-20260721.json";
      },
      /must be a repository-relative path inside the repo/,
    );
  });

  // 체인 순서는 임의 배열이 아니다 — route_map·accessibility materializer는 대구 운영기관과 시각표
  // 소스가 pack에 이미 있을 것을 선행 조건으로 검사하므로, 시각표 편입을 뒤로 미루면 조립이 멈춘다.
  await context.test("편입 체인 순서를 뒤집으면 선행 조건이 깨져 거부된다", async () => {
    await rejectsWith(
      (value) => {
        value.packDataInclusions = [
          value.packDataInclusions[1],
          value.packDataInclusions[0],
          ...value.packDataInclusions.slice(2),
        ];
      },
      /Daegu route map positions require daegu-transportation operator pack/,
    );
  });

  await context.test("체인 뒤 편입의 선언 행수가 다르면 거부된다", async () => {
    await rejectsWith(
      (value) => { value.packDataInclusions[2].addedRows.facilities += 1; },
      /materialize-daegu-accessibility\.mjs pack data inclusion added rows do not match the spec declaration/,
    );
  });

  // 편입마다 신선도 창이 다르므로 기준 시각 pin도 편입 단위다. 다만 노선도 편입의 창은 하한뿐이라
  // 다른 두 편입(시각표·편의시설의 [capturedAt, freshUntil))과 신선도 보장이 비대칭이다 — 포착 이전
  // pin만 fail closed 되고 먼 미래 pin은 통과한다. 상한 도입은 materializer 쪽 판단이라 여기서
  // 동작으로 고정하지 않고 비대칭을 기록만 한다.
  await context.test("노선도 편입 기준 시각을 snapshot 포착 이전으로 옮기면 거부된다(하한만 검사·상한 없음)", async () => {
    await rejectsWith(
      (value) => { value.packDataInclusions[1].materializedAt = "2026-07-20T16:00:00.000Z"; },
      /daegu-transportation-route-map-positions inventory evidence does not match snapshot/,
    );
  });

  await context.test("편의시설 편입 기준 시각을 신선도 창 밖으로 옮기면 거부된다", async () => {
    await rejectsWith(
      (value) => { value.packDataInclusions[2].materializedAt = "2026-07-25T01:00:00.000Z"; },
      /daegu-transportation-accessibility evidence freshness is invalid/,
    );
  });

  // #2587 B2-b. 부산 구간이 강제하는 순서는 "topology가 먼저"다 — 승계 원본에 부산 운영기관·노선·역이
  // 아예 없어 뒤 세 편입이 전부 topology 편입 결과를 선행 조건으로 검사한다.
  await context.test("부산 topology 편입을 뒤로 미루면 선행 조건이 깨져 거부된다", async () => {
    await rejectsWith(
      (value) => {
        const busan = value.packDataInclusions.slice(BUSAN_TOPOLOGY_INDEX);
        value.packDataInclusions = [
          ...value.packDataInclusions.slice(0, BUSAN_TOPOLOGY_INDEX),
          busan[1],
          busan[0],
          ...busan.slice(2),
        ];
      },
      // topology 편입이 앞서지 않으면 pack에 부산 station_lines가 하나도 없어 시각표 정본 대조가
      // 역 범위 단계에서 멈춘다(계보 대조까지 가지도 못한다).
      /Busan timetable canonical station count mismatch: 0/,
    );
  });

  // 선행 조건이 없는 두 편입(시각표↔노선도)의 교환은 대구에서는 조립을 그대로 통과했다. 부산은 노선도
  // 편입이 승계 원본에 없던 표를 새로 만들어 그 표를 0으로 선언해야 하는 편입이 순서에 따라 갈리므로,
  // 선행 조건이 아니라 선언 행수 대조가 교환을 막는다 — evidence chainKo가 기록한 그 축을 고정한다.
  await context.test("부산 시각표·노선도 편입을 교환하면 선언 행수 대조에서 거부된다", async () => {
    await rejectsWith(
      (value) => {
        const busan = value.packDataInclusions.slice(BUSAN_TOPOLOGY_INDEX);
        value.packDataInclusions = [
          ...value.packDataInclusions.slice(0, BUSAN_TOPOLOGY_INDEX),
          busan[0],
          busan[2],
          busan[1],
          busan[3],
        ];
      },
      /materialize-busan-timetable\.mjs pack data inclusion added rows do not match the spec declaration/,
    );
  });

  // 부산 편입은 대구와 달리 편입 층 경로 키만 쓴다(topology snapshot이 4노선 한 파일). 편입 4종의
  // snapshotPath와, topology 계보를 읽는 뒤 세 편입의 topologySnapshotPath가 admission 정본 경로에
  // 결속돼 있다 — 결속 지점을 하나만 덮으면 나머지가 풀려도 회귀가 침묵하므로 편입별로 돈다.
  //
  // 다만 "부산 편입의 경로 키가 전부 정본 경로에 결속"은 아니다: topology 편입의 stationMapPath에는
  // 경로 결속이 없고 admission 정본의 membership.mappingSha256(파싱 결과에서 파생된 내용 해시)만
  // 판정에 쓴다. 부산권 행만 남긴 축약 CSV(158줄, tracked 원본 302줄)를 gitignore된 tmp/ 아래에 두고
  // 가리켜도 조립이 그대로 통과한다(실측) — 이 키의 결속 축은 경로가 아니라 내용 해시다.
  for (const { labelKo, slug, offset, sourceId, evidenceKey } of BUSAN_INCLUSION_BINDINGS) {
    await context.test(`부산 ${labelKo} 편입 snapshotPath가 정본 밖 바이트 동일 사본이면 거부된다`, async () => {
      await rejectsSnapshotCopy({
        index: BUSAN_TOPOLOGY_INDEX + offset,
        sourcePath: admissionEvidenceOf(inventory, sourceId, evidenceKey).snapshotPath,
        copyName: `busan-${slug}-copy.json`,
        // 바이트를 그대로 옮긴다 — materializer의 바이트·내용 대조만으로는 사본이 통과한다(실측).
        serialize: (bytes) => bytes,
        expected: new RegExp(`snapshotPath must match the ${sourceId} admission evidence snapshotPath`),
      });
    });
  }

  for (const { labelKo, slug, offset } of BUSAN_INCLUSION_BINDINGS.slice(1)) {
    await context.test(`부산 ${labelKo} 편입 topologySnapshotPath가 정본 밖 사본이면 거부된다`, async () => {
      await rejectsSnapshotCopy({
        index: BUSAN_TOPOLOGY_INDEX + offset,
        key: "topologySnapshotPath",
        sourcePath: admissionEvidenceOf(
          inventory,
          BUSAN_TOPOLOGY_BINDING.sourceId,
          BUSAN_TOPOLOGY_BINDING.evidenceKey,
        ).snapshotPath,
        copyName: `busan-${slug}-topology-copy.json`,
        // 재직렬화 사본도 contentSha256(내용 파생)은 그대로라 materializer의 계보 대조만으로는 통과한다.
        serialize: (bytes) => JSON.stringify(JSON.parse(bytes.toString("utf8"))),
        expected: new RegExp(
          `snapshotPath must match the ${BUSAN_TOPOLOGY_BINDING.sourceId} admission evidence snapshotPath`,
        ),
      });
    });
  }

  // 부산 lines 선언은 장식이 아니다 — 저장소 정본(BUSAN_LINES)과 대조하지 않으면 틀린 노선 구성이
  // 그대로 통과해 evidence의 선언과 실제 조립이 갈린다.
  await context.test("부산 편입의 노선 선언이 정본과 다르면 거부된다", async () => {
    await rejectsWith(
      (value) => { value.packDataInclusions[BUSAN_TOPOLOGY_INDEX].lines[1].lineNumber = 5; },
      /must declare every tracked Busan line/,
    );
  });

  // 새로 생기는 표(routeMapLineTracks)도 대조 축이다 — 선언에서 빼면 실제 산출 map과 전키 비교가 어긋난다.
  await context.test("부산 노선도 편입이 새 표를 선언하지 않으면 거부된다", async () => {
    await rejectsWith(
      (value) => { delete value.packDataInclusions[BUSAN_TOPOLOGY_INDEX + 2].addedRows.routeMapLineTracks; },
      /materialize-busan-route-map-positions\.mjs pack data inclusion added rows do not match the spec declaration/,
    );
  });

  // pin 창 회귀도 편입 단위다. 편입 하나의 창만 덮으면 나머지 세 창이 풀려도 침묵하는데, 창 모양이
  // 편입마다 갈리므로(양끝 검사 3편입 / 하한만 1편입) 한 편입의 통과가 다른 편입의 근거가 되지도
  // 않는다. 창 값은 admission 정본에서 끌어와 하한 직전(capturedAt - 1ms)과 상한 정각(freshUntil,
  // 반개구간이라 이미 창 밖)을 각각 때린다.
  for (const { labelKo, offset, sourceId, evidenceKey, stalePinPattern } of BUSAN_INCLUSION_BINDINGS) {
    const { capturedAt, freshUntil } = admissionEvidenceOf(inventory, sourceId, evidenceKey);
    await context.test(`부산 ${labelKo} 편입 기준 시각을 창 하한 미만으로 옮기면 거부된다`, async () => {
      await rejectsWith(
        (value) => {
          value.packDataInclusions[BUSAN_TOPOLOGY_INDEX + offset].materializedAt =
            new Date(Date.parse(capturedAt) - 1).toISOString();
        },
        stalePinPattern,
      );
    });
    // 노선도 편입의 창에는 상한이 없다 — 그 비대칭은 아래 별도 축이 "먼 미래 pin도 통과한다"로 고정한다.
    if (freshUntil === undefined) continue;
    await context.test(`부산 ${labelKo} 편입 기준 시각을 창 상한 이상으로 옮기면 거부된다`, async () => {
      await rejectsWith(
        (value) => {
          value.packDataInclusions[BUSAN_TOPOLOGY_INDEX + offset].materializedAt = freshUntil;
        },
        stalePinPattern,
      );
    });
  }

  // B2-a 재기술도 B0 파일럿과 같은 축에 묶여 있다: spec만 고쳐서 전환 범위를 넓힐 수 없다.
  // snapshot 근거가 없는 노선을 spec 내부 정합을 맞춰 끼워 넣어도 admission 정본 결속이 막는다.
  await context.test("snapshot 근거가 없는 노선을 재기술에 끼워 넣으면 거부된다", async () => {
    await rejectsWith(
      (value) => {
        const entry = value.lineScopeRedescriptions.find(
          ({ sourceId }) => sourceId === "daegu-transportation-route-map-positions",
        );
        entry.lineIds = [...entry.lineIds, "line-8f7ed01f290a"];
        entry.requirementKeys = [
          ...entry.requirementKeys,
          "daegu:korail:line-8f7ed01f290a:route_map_positions",
        ];
      },
      /source inventory coverageScope\.lineIds must match the spec redescription/,
    );
  });
});

// 부산 편입 넷 중 노선도만 신선도 창에 상한이 없다 — admission 정본에 freshUntil이 없고 materializer도
// 하한(capturedAt 이후)만 검사한다. 하한 미만은 위 회귀가 fail closed로 고정하지만 상한 쪽에는 가드가
// 아예 없어 100년 뒤 pin도 조립을 완주하고 판정까지 그대로 낸다. 상한 도입은 materializer 쪽 판단이라
// 이 하네스가 동작으로 바꾸지 않고, 그 비대칭이 의도된 기록이라는 것을 성질 자체로 고정한다 — 나중에
// 상한이 생기면 이 단언이 깨져 spec·evidence 서술까지 함께 고치도록 강제한다.
test("부산 노선도 편입은 상한이 없어 먼 미래 기준 시각도 조립을 통과한다", async () => {
  const spec = await readJson(SPEC_PATH);
  const inventory = await readJson(INVENTORY_PATH);
  const { capturedAt, freshUntil } = admissionEvidenceOf(
    inventory,
    BUSAN_ROUTE_MAP_BINDING.sourceId,
    BUSAN_ROUTE_MAP_BINDING.evidenceKey,
  );
  assert.equal(freshUntil, undefined, "이 축은 노선도 정본에 상한이 없다는 전제 위에 있다");
  const farFuture = capturedAt.replace(/^\d{4}/, (year) => String(Number(year) + 100));
  const index = BUSAN_TOPOLOGY_INDEX + BUSAN_ROUTE_MAP_BINDING.offset;
  spec.packDataInclusions[index].materializedAt = farFuture;

  const workspace = await mkdtemp(path.join(tmpdir(), "nationwide-candidate-gate-unbounded-"));
  try {
    const evidence = await runNationwideCandidateCoverageGate({
      spec,
      specInput: { path: SPEC_PATH, sha256: "a".repeat(64) },
      targetsInput: { path: TARGETS_PATH, sha256: "b".repeat(64) },
      inventory,
      inventoryInput: { path: INVENTORY_PATH, sha256: "c".repeat(64) },
      resolutionPlanInput: { path: RESOLUTION_PLAN_PATH, sha256: "d".repeat(64) },
      resolutionsInput: { path: RESOLUTIONS_PATH, sha256: "e".repeat(64) },
      workDir: workspace,
    });
    assert.equal(evidence.packDataInclusions.entries[index].materializedAt, farFuture);
    // 조립만 통과하는 것이 아니라 전이 판정도 그대로다 — 상한 부재가 판정에 남기는 흔적이 없다.
    assert.deepEqual(
      evidence.transitions.map(({ requirementKey }) => requirementKey),
      [PILOT_REQUIREMENT_KEY, ...DAEGU_REQUIREMENT_KEYS, ...BUSAN_REQUIREMENT_KEYS].sort(),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// 노선도 편입의 하한 회귀는 나머지 셋과 진단 특정성이 비대칭이다: 시각표·편의시설은 신선도 전용 문구
// (`evidence freshness is invalid`), topology는 stale snapshot 전용 문구를 내지만 노선도는 admission 정본
// 대조 축과 한 조건을 공유하는 문구를 낸다(BUSAN_INCLUSION_BINDINGS 주석 참조). 그래서 "거부됐다"만으로는
// 하한 위반이 원인인지 다른 축이 낸 문구인지 갈리지 않는다 — pin 1ms 차이의 대조로 원인을 좁힌다.
// tracked pin은 하한 정각이라 조립을 완주하고, 거기서 1ms만 내리면 같은 입력이 그 문구로 거부된다.
test("부산 노선도 편입의 창 하한 진단은 pin 1ms 대조로 원인이 특정된다", async () => {
  const spec = await readJson(SPEC_PATH);
  const inventory = await readJson(INVENTORY_PATH);
  const { capturedAt } = admissionEvidenceOf(
    inventory,
    BUSAN_ROUTE_MAP_BINDING.sourceId,
    BUSAN_ROUTE_MAP_BINDING.evidenceKey,
  );
  const index = BUSAN_TOPOLOGY_INDEX + BUSAN_ROUTE_MAP_BINDING.offset;
  // tracked pin이 하한 정각이라는 것부터 축이다 — 여기가 어긋나면 아래 1ms 대조가 하한을 때리지 않는다.
  assert.equal(spec.packDataInclusions[index].materializedAt, capturedAt, "tracked pin은 창 하한 정각이다");

  const runWithPin = async (materializedAt) => {
    const mutated = structuredClone(spec);
    mutated.packDataInclusions[index].materializedAt = materializedAt;
    const workspace = await mkdtemp(path.join(tmpdir(), "nationwide-candidate-gate-lower-bound-"));
    try {
      return await runNationwideCandidateCoverageGate({
        spec: mutated,
        specInput: { path: SPEC_PATH, sha256: "a".repeat(64) },
        targetsInput: { path: TARGETS_PATH, sha256: "b".repeat(64) },
        inventory,
        inventoryInput: { path: INVENTORY_PATH, sha256: "c".repeat(64) },
        resolutionPlanInput: { path: RESOLUTION_PLAN_PATH, sha256: "d".repeat(64) },
        resolutionsInput: { path: RESOLUTIONS_PATH, sha256: "e".repeat(64) },
        workDir: workspace,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  };

  // 하한 정각은 반개구간의 안쪽이다 — 이 실행이 통과해야 아래 거부가 "하한을 넘어서" 났다고 말할 수 있다.
  const evidence = await runWithPin(capturedAt);
  assert.equal(evidence.packDataInclusions.entries[index].materializedAt, capturedAt);
  await assert.rejects(
    runWithPin(new Date(Date.parse(capturedAt) - 1).toISOString()),
    BUSAN_ROUTE_MAP_BINDING.stalePinPattern,
  );
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

// 승계 pack의 배열 표 전체를 0으로 선언한 addedRows. 합성 편입은 행을 더하지 않으므로 addedRows 대조는
// 통과하고 회귀가 겨냥한 축만 걸린다.
async function zeroAddedRows() {
  const [inheritedPack] = (await readJson(REVIEWED_PACK_PATH)).packs;
  return Object.fromEntries(
    Object.entries(inheritedPack).filter(([, value]) => Array.isArray(value)).map(([table]) => [table, 0]),
  );
}

// 위 단위 축과 별개로, 조립 경로가 그 단언을 실제로 호출하는지를 고정한다(호출이 사라지면 이 회귀가 깨진다).
// PACK_DATA_MATERIALIZERS는 모듈 내부 상수라 spec 편집으로는 이 경로에 닿을 수 없어 in-process seam을 쓴다.
test("조립 경로는 승계 행을 변조하는 materializer를 거부한다", async () => {
  const spec = structuredClone(await readJson(SPEC_PATH));
  const inventory = await readJson(INVENTORY_PATH);
  const materializerId = "test://mutates-inherited-rows";
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
    addedRows: await zeroAddedRows(),
  }];
  const materializers = new Map([[materializerId, {
    materialize: (fixture) => {
      const mutated = structuredClone(fixture);
      mutated.packs[0].stations[0].nameKo = "변조";
      return mutated;
    },
    inputs: { paths: ["stationMapPath"], linePaths: ["topologySnapshotPath", "timetableSnapshotPath"] },
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
      // 편입 정체성 라벨은 (regionId, materializer)다 — 같은 지역을 여러 도메인으로 체인하면
      // regionId만으로는 어느 편입이 걸렸는지 알 수 없다.
      /synthetic:test:\/\/mutates-inherited-rows pack data inclusion modified inherited rows: stations/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// 아래 두 회귀도 in-process seam으로 항목을 넘긴다(allowlist는 모듈 내부 상수라 spec 편집으로 닿을 수 없다).
// 공통 실행부와 합성 편입 레코드만 묶고, 항목 형상·materializer 동작은 회귀마다 다르게 준다.
const SEAM_INPUTS = { paths: ["stationMapPath"], linePaths: ["topologySnapshotPath"] };

async function runWithMaterializers(spec, inventory, materializers) {
  const workspace = await mkdtemp(path.join(tmpdir(), "nationwide-candidate-gate-seam-"));
  try {
    return await runNationwideCandidateCoverageGate({
      spec,
      specInput: { path: SPEC_PATH, sha256: "a".repeat(64) },
      targetsInput: { path: TARGETS_PATH, sha256: "b".repeat(64) },
      inventory,
      inventoryInput: { path: INVENTORY_PATH, sha256: "c".repeat(64) },
      resolutionPlanInput: { path: RESOLUTION_PLAN_PATH, sha256: "d".repeat(64) },
      resolutionsInput: { path: RESOLUTIONS_PATH, sha256: "e".repeat(64) },
      workDir: workspace,
      materializers,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function seamInclusion(materializer, addedRows) {
  return {
    regionId: "synthetic",
    materializer,
    materializedAt: "2026-07-20T16:00:00.000Z",
    stationMapPath: "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv",
    lines: [{
      lineNumber: 1,
      lineId: "line-5b8d9b05e7e6",
      topologySnapshotPath: "tools/datapack/sources/daegu-line1-route-topology-20260721.json",
    }],
    addedRows,
  };
}

// 단일 편입 회귀는 승계 원본(capital pack) 행만 태운다. 체인에서는 앞 편입이 실은 행도 뒤 편입의 불변
// 대상이므로, 1번째가 append한 행을 2번째가 in-place로 변조하는 2단 케이스를 따로 고정한다
// (행수는 그대로라 addedRows 대조는 통과하고 승계 행 불변 축만 걸린다).
test("조립 경로는 앞 편입이 실은 행을 뒤 편입이 변조하면 거부한다", async () => {
  const spec = structuredClone(await readJson(SPEC_PATH));
  const inventory = await readJson(INVENTORY_PATH);
  const zeroRows = await zeroAddedRows();
  const appendId = "test://appends-station-row";
  const mutateId = "test://mutates-chained-row";
  spec.packDataInclusions = [
    seamInclusion(appendId, { ...zeroRows, stations: 1 }),
    seamInclusion(mutateId, zeroRows),
  ];
  const materializers = new Map([
    [appendId, {
      materialize: (fixture) => {
        const mutated = structuredClone(fixture);
        mutated.packs[0].stations.push({
          ...mutated.packs[0].stations[0],
          id: "station-synthetic-chained",
        });
        return mutated;
      },
      inputs: SEAM_INPUTS,
    }],
    [mutateId, {
      materialize: (fixture) => {
        const mutated = structuredClone(fixture);
        // 승계 원본 행이 아니라 직전 편입이 append한 마지막 행을 건드린다.
        mutated.packs[0].stations.at(-1).nameKo = "변조";
        return mutated;
      },
      inputs: SEAM_INPUTS,
    }],
  ]);

  await assert.rejects(
    runWithMaterializers(spec, inventory, materializers),
    /synthetic:test:\/\/mutates-chained-row pack data inclusion modified inherited rows: stations/,
  );
});

// 등재 항목의 형상 자체가 깨지면(inputs 결측·형 오류) 무검사 구조분해는 TypeError로 터져 진단이
// "무엇이 잘못됐나" 대신 스택으로 붕괴한다 — 형상 검사가 그 자리를 대신 잡는지 본다.
test("allowlist 항목의 inputs 형상이 깨지면 진단 가능한 오류로 거부된다", async () => {
  const spec = structuredClone(await readJson(SPEC_PATH));
  const inventory = await readJson(INVENTORY_PATH);
  const zeroRows = await zeroAddedRows();
  const keep = (fixture) => fixture;

  spec.packDataInclusions = [seamInclusion("test://missing-inputs", zeroRows)];
  await assert.rejects(
    runWithMaterializers(spec, inventory, new Map([["test://missing-inputs", { materialize: keep }]])),
    /pack data materializer inputs shape is invalid: test:\/\/missing-inputs/,
  );

  spec.packDataInclusions = [seamInclusion("test://broken-inputs", zeroRows)];
  await assert.rejects(
    runWithMaterializers(spec, inventory, new Map([["test://broken-inputs", {
      materialize: keep,
      inputs: { paths: "stationMapPath", linePaths: ["topologySnapshotPath"] },
    }]])),
    /pack data materializer inputs shape is invalid: test:\/\/broken-inputs/,
  );
});

// 형상 검사가 잡는 것은 형상 자체가 깨진 경우뿐이다. 형상이 성립하면서 어댑터가 실제로 읽는 키보다 좁으면
// spec 검사가 그 키를 요구하지 않아 결측 값이 readTracked까지 들어온다 — fail closed는 유지되지만 진단이
// path.resolve TypeError로 붕괴했다(실측). 결측을 spec 검사와 같은 형식으로 되돌리는지 본다.
test("등재 형상이 어댑터 read보다 좁으면 결측 입력을 진단 가능한 오류로 거부한다", async () => {
  const spec = structuredClone(await readJson(SPEC_PATH));
  const inventory = await readJson(INVENTORY_PATH);
  const materializerId = "test://narrow-input-shape";
  const inclusion = seamInclusion(materializerId, await zeroAddedRows());
  // 등재 형상에 없는 키는 그 자체로 거부되므로 spec 쪽 선언도 함께 지운다.
  delete inclusion.stationMapPath;
  spec.packDataInclusions = [inclusion];

  await assert.rejects(
    runWithMaterializers(spec, inventory, new Map([[materializerId, {
      materialize: async (fixture, entry, { readTracked }) => {
        await readTracked(entry.stationMapPath, "stationMapPath");
        return fixture;
      },
      inputs: { paths: [], linePaths: ["topologySnapshotPath"] },
    }]])),
    /synthetic:test:\/\/narrow-input-shape\.stationMapPath is required/,
  );
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
