import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { LEDGER_WRITER_WORKFLOWS, REFRESH_CLAIM_PREFIXES } from "../ci/refresh-open-pr-age.mjs";
import {
  SOURCE_REVERIFICATION_RECIPE_IDS,
  SOURCE_REVERIFICATION_REGISTRATION_OUTPUTS,
  isSourceReverificationAllowedPath,
} from "../ci/source-reverification-paths.mjs";
import { P7D_SOURCE_COVERAGE, REVERIFICATION_RECIPES, inventoryChangeViolations, inventoryScopeViolations, p7dSourceIds, recipeById } from "./source-reverification-recipes.mjs";
import { RECIPE_STEPS } from "./run-source-reverification.mjs";
import { collectBusanAccessibility } from "./collect-busan-accessibility.mjs";
import { collectDaeguAccessibility } from "./collect-daegu-accessibility.mjs";
import { loadAdmittedDaeguTopologySnapshots } from "./collect-daegu-datapack-sources.mjs";
import { prepareBusanTimetableRegistration } from "./register-busan-timetable.mjs";
import { prepareDaejeonTimetableRegistration } from "./register-daejeon-timetable.mjs";
import { prepareRegionalAccessibilityRegistration } from "./register-regional-accessibility.mjs";

// #984(#969 남은 단계 1): P7D 원천 재확인 recipe 표. 정책의 P7D 원천은 모두 recipe·외부 workflow·막힌 사유 중 하나를 가져야 하고,
// 빠진 원천이 생기면 CI가 실패한다(커버리지 표를 코드로 둔다).
const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const readJson = async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"));

test("정책의 P7D 원천은 모두 커버리지 표에 있고 표에는 정책에 없는 원천이 없다", async () => {
  const policy = await readJson("release/product-gates/datapack-freshness-sla.json");
  const expected = policy.sourceClasses.filter((entry) => entry.reverificationCadence === "P7D").flatMap((entry) => entry.sourceIds).sort();
  assert.deepEqual(p7dSourceIds(policy), expected);
  assert.deepEqual(Object.keys(P7D_SOURCE_COVERAGE).sort(), expected);
  assert.equal(expected.length, 10);
});

test("커버리지 항목은 recipe·외부 workflow·막힌 사유 중 하나 이상이고 대상이 실제로 있다", () => {
  const recipeIds = new Set(REVERIFICATION_RECIPES.map(({ id }) => id));
  for (const [sourceId, entry] of Object.entries(P7D_SOURCE_COVERAGE)) {
    assert.ok(entry.recipe || entry.external || entry.blocked, sourceId);
    assert.deepEqual(Object.keys(entry).filter((key) => !["recipe", "external", "blocked"].includes(key)), [], sourceId);
    if (entry.recipe) {
      assert.ok(recipeIds.has(entry.recipe), `${sourceId}: ${entry.recipe}`);
      assert.ok(recipeById(entry.recipe).sourceIds.includes(sourceId), `${sourceId} is not a source of ${entry.recipe}`);
    }
    if (entry.external) assert.ok(Object.hasOwn(REFRESH_CLAIM_PREFIXES, entry.external), `${sourceId}: ${entry.external}`);
    if (entry.blocked) assert.ok(typeof entry.blocked === "string" && entry.blocked.length > 20, sourceId);
  }
});

test("이 단계가 맡는 원천은 막힌 사유 없이 recipe를 가진다(data.go.kr 다운로드 모드 병합 뒤)", () => {
  const owned = {
    "korail-metropolitan-timetable-file": "korail-topology",
    "gwangju-transportation-route-topology": "gwangju-topology",
    "busan-transportation-route-topology": "busan-topology",
    "daejeon-station-distance-fare": "daejeon-topology",
    "daegu-line1-route-topology": "daegu-sources",
    "daegu-line2-route-topology": "daegu-sources",
    "daegu-line3-route-topology": "daegu-sources",
    "kric-nationwide-timetable-file": "kric-capital-timetable",
  };
  for (const [sourceId, recipe] of Object.entries(owned)) {
    assert.equal(P7D_SOURCE_COVERAGE[sourceId].recipe, recipe, sourceId);
    assert.equal(P7D_SOURCE_COVERAGE[sourceId].blocked, undefined, sourceId);
  }
  // 이미 자기 workflow가 있는 원천은 외부 workflow로 표시한다(중복 자동화 금지).
  assert.equal(P7D_SOURCE_COVERAGE["capital-route-topology"].external, "current-capital-topology-registration.yml");
  assert.equal(P7D_SOURCE_COVERAGE["incheon-transit-station-info"].external, "current-capital-topology-refresh.yml");
  assert.equal(P7D_SOURCE_COVERAGE["kric-nationwide-timetable-file"].external, "retained-gwangju-timetable-refresh.yml");
});

test("recipe id는 경로·증거 계약의 id 목록과 같고 단계 구현과 1:1이다", () => {
  assert.deepEqual(REVERIFICATION_RECIPES.map(({ id }) => id), [...SOURCE_REVERIFICATION_RECIPE_IDS]);
  assert.deepEqual(Object.keys(RECIPE_STEPS).sort(), [...SOURCE_REVERIFICATION_RECIPE_IDS].sort());
  for (const [id, steps] of Object.entries(RECIPE_STEPS)) {
    assert.ok(steps.length > 0, id);
    for (const step of steps) {
      assert.match(step.id, /^[a-z0-9-]+$/u, id);
      assert.ok(["collect", "register", "collect-register", "glue"].includes(step.kind), `${id}/${step.id}`);
      assert.equal(typeof step.run, "function", `${id}/${step.id}`);
    }
    assert.equal(new Set(steps.map(({ id: stepId }) => stepId)).size, steps.length, id);
  }
});

test("의존은 앞선 recipe만 가리키고(순환 없음) 의존 recipe는 자기 만료 기준 없이 의존 대상이 돌 때만 돈다", () => {
  const seen = new Set();
  for (const recipe of REVERIFICATION_RECIPES) {
    for (const dependency of recipe.dependsOn) assert.ok(seen.has(dependency), `${recipe.id} -> ${dependency}`);
    seen.add(recipe.id);
    assert.equal(Boolean(recipe.due) !== (recipe.dependsOn.length > 0), true, `${recipe.id}: a recipe either owns a due rule or follows its dependency`);
  }
  assert.deepEqual(recipeById("korail-planned-timetable").dependsOn, ["korail-topology"]);
  assert.deepEqual(recipeById("gwangju-accessibility").dependsOn, ["gwangju-topology"]);
  assert.deepEqual(recipeById("daejeon-accessibility").dependsOn, ["daejeon-topology"]);
});

// #1122: 수집기가 24시간 근거(freshUntil)를 싣는 부산·대전·대구 원천 4건은 만료 기준을 따로 갖지 않고, 결속된 topology recipe가 돌 때 함께 다시 등록된다.
// 이 recipe가 없으면 근거가 2026-10-03부터 만료된 채 남는다(refreshStage NONE). 날짜·개수가 아니라 소유 구조를 고정한다.
const TOPOLOGY_BOUND_RECIPES = [
  ["busan-accessibility", "busan-transportation-accessibility", "busan-topology"],
  ["busan-timetable", "busan-transportation-timetable", "busan-topology"],
  ["daejeon-timetable", "daejeon-train-timetable", "daejeon-topology"],
  ["daegu-accessibility", "daegu-transportation-accessibility", "daegu-sources"],
];

test("부산·대전·대구 24시간 근거 원천은 결속된 topology recipe가 돌 때 함께 재등록하는 recipe가 맡는다 (#1122)", () => {
  for (const [recipeId, sourceId, topologyRecipeId] of TOPOLOGY_BOUND_RECIPES) {
    const recipe = recipeById(recipeId);
    assert.deepEqual(recipe.sourceIds, [sourceId], recipeId);
    assert.deepEqual(recipe.dependsOn, [topologyRecipeId], recipeId);
    assert.equal(recipe.due, null, recipeId);
    assert.deepEqual(Object.keys(recipe.inventoryChanges), [sourceId], recipeId);
  }
});

test("recipe의 원천은 모두 inventory와 신선도 정책 어딘가에 있다", async () => {
  const [inventory, policy] = await Promise.all([readJson("tools/datapack/source-inventory.json"), readJson("release/product-gates/datapack-freshness-sla.json")]);
  const inventoryIds = new Set(inventory.sources.map(({ id }) => id));
  const policyIds = new Set(policy.sourceClasses.flatMap(({ sourceIds }) => sourceIds));
  for (const recipe of REVERIFICATION_RECIPES) {
    for (const sourceId of recipe.sourceIds) {
      assert.ok(inventoryIds.has(sourceId), `${recipe.id}: inventory ${sourceId}`);
      assert.ok(policyIds.has(sourceId), `${recipe.id}: policy ${sourceId}`);
    }
  }
});

test("recipe가 부르는 도구는 모두 저장소에 있다", async () => {
  const text = await readFile(path.join(root, "tools/datapack/run-source-reverification.mjs"), "utf8");
  const scripts = [...text.matchAll(/"((?:collect|register)-[a-z0-9-]+\.mjs)"/gu)].map(([, name]) => name);
  assert.ok(scripts.length >= 14, `scripts: ${scripts.length}`);
  for (const script of new Set(scripts)) assert.ok(existsSync(path.join(root, "tools/datapack", script)), script);
});

test("새 workflow는 claim 접두어를 갖고 원장을 쓰는 workflow 직렬화 목록에 든다", () => {
  assert.equal(REFRESH_CLAIM_PREFIXES["source-reverification.yml"], "automation/984-source-reverification-");
  assert.ok(LEDGER_WRITER_WORKFLOWS.includes("source-reverification.yml"));
});

test("허용 경로는 원천 등록 결과 세 파일과 새 snapshot 파일뿐이다", () => {
  assert.deepEqual([...SOURCE_REVERIFICATION_REGISTRATION_OUTPUTS], [
    "tools/datapack/source-inventory.json", "tools/datapack/release/source-snapshots.json",
    "tools/datapack/source-governance-policy.json",
  ]);
  // #987 리뷰 F4: 신선도 정책은 등록 도구가 읽기만 한다. 허용 경로가 아니다.
  assert.equal(isSourceReverificationAllowedPath("release/product-gates/datapack-freshness-sla.json"), false);
  for (const relative of SOURCE_REVERIFICATION_REGISTRATION_OUTPUTS) assert.equal(isSourceReverificationAllowedPath(relative), true, relative);
  assert.equal(isSourceReverificationAllowedPath(`tools/datapack/sources/gwangju-transportation-route-topology-${"a".repeat(64)}.json`), true);
  for (const relative of [
    "tools/datapack/release/candidate-build-spec.json", "tools/datapack/release/current-busan-transfer-metrics.json", "tools/datapack/sources/nested/x.json",
    "tools/datapack/sources/x.csv", "tools/datapack/sources/../source-inventory.json", ".github/workflows/ci.yml", "tools/datapack/.capital-route-topology-registration.lock",
    "tools/datapack/.capital-route-topology-registration-transaction.json", "/tmp/x.json", "",
  ]) assert.equal(isSourceReverificationAllowedPath(relative), false, relative);
  assert.equal(isSourceReverificationAllowedPath(undefined), false);
});

// #987 N1: 재확인 PR이 inventory에서 바꿀 수 있는 항목과 필드는 recipe 정의가 명시한 것뿐이다(의존 항목 포함). 정책성 필드는 어떤 recipe도 바꾸지 못한다.
const POLICY_FIELDS = ["productionUseAllowed", "requiredForProductionPack", "license", "datasetUrl", "coverage", "id", "provider", "owner"];

test("모든 recipe는 소유 원천마다 갱신 대상 필드를 명시하고 정책성 필드는 하나도 허용하지 않는다", () => {
  for (const recipe of REVERIFICATION_RECIPES) {
    const owned = Object.keys(recipe.inventoryChanges ?? {});
    for (const sourceId of recipe.sourceIds) assert.ok(owned.includes(sourceId), `${recipe.id}: ${sourceId}`);
    assert.ok(owned.length > 0, recipe.id);
    for (const [sourceId, fields] of Object.entries(recipe.inventoryChanges)) {
      assert.ok(Array.isArray(fields) && fields.length > 0, `${recipe.id}/${sourceId}`);
      for (const field of fields) assert.equal(POLICY_FIELDS.includes(field), false, `${recipe.id}/${sourceId}: ${field}`);
    }
  }
  // 의존 항목은 정의에 이름이 있어야 한다.
  assert.deepEqual(Object.keys(recipeById("gwangju-topology").inventoryChanges).sort(), [
    "gwangju-transportation-accessibility", "gwangju-transportation-route-map-positions", "gwangju-transportation-route-topology",
    "kric-nationwide-timetable-file", "molit-urban-rail-full-route-gwangju-membership",
  ]);
});

// #1122: 새 recipe 4개의 inventoryChanges가 등록기가 실제로 쓰는 필드를 덮는지 실제 등록기로 증명한다(표 모양만 보지 않는다).
// 네트워크와 OCI 없이: 시간표는 inventory가 가리키는 보관 snapshot을 그 관측 시각 + 1시간에 재생하고, 접근성은 현재 topology head 범위로 합성 응답·fixture CSV에서 snapshot을 만든다.
// 시각은 모두 저장소 데이터에서 읽어 주입한다(시계에 의존하지 않는다). 등록기는 admissionEvidence(라이선스 해시)도 다시 쓰지만 license가 같으면 값이 같아 변하지 않는다.
// 필드 집합에 admissionEvidence를 넣지 않았으므로 license 해시가 어긋나면 이 검사와 재확인 PR의 범위 게이트가 함께 멈춘다(사람이 라이선스 변경을 본다).
const BUSAN_ACCESSIBILITY_FIELDS = { wl_i: "0", wl_o: "0", el_i: "2", el_o: "1", es: "3", blindroad: "1", ourbridge: "1", helptake: "2", toilet: "1", toilet_gubun: "분리" };

// sourceId는 독립 표(TOPOLOGY_BOUND_RECIPES)에서 받는다. recipe 표에서 꺼내 쓰면 기대값이 생산 함수에서 나온 순환 oracle이 된다.
async function registrarWrite(recipeId, sourceId) {
  const base = await readJson("tools/datapack/source-inventory.json");
  const source = (id) => base.sources.find((entry) => entry.id === id);
  const candidates = (await readJson("tools/datapack/source-candidates.json")).candidates;
  const reviewedPlusHour = (id) => new Date(Date.parse(candidates.find((entry) => entry.id === id).registrationMetadata.governance.licenseReview.reviewedAt) + 3_600_000);
  const dir = await mkdtemp(path.join(os.tmpdir(), "recipe-scope-"));
  try {
    const snapshotPath = path.join(dir, "snapshot.json");
    const prepare = async (fn, input) => ({ prepared: await fn({ repositoryRoot: root, snapshotPath, ...input }) });
    if (recipeId === "daejeon-timetable" || recipeId === "busan-timetable") {
      const evidence = source(sourceId).scheduleAdmissionEvidence;
      await writeFile(snapshotPath, await readFile(path.join(root, evidence.snapshotPath)));
      const now = new Date(Date.parse(evidence.capturedAt) + 3_600_000);
      return { base, ...(await prepare(recipeId === "busan-timetable" ? prepareBusanTimetableRegistration : prepareDaejeonTimetableRegistration, { now })) };
    }
    if (recipeId === "busan-accessibility") {
      const now = reviewedPlusHour(sourceId);
      const topology = await readJson(source("busan-transportation-route-topology").topologyAdmissionEvidence.snapshotPath);
      const snapshot = await collectBusanAccessibility({
        serviceKey: "a".repeat(40), stationScopes: topology.scope, now,
        fetchImpl: async (url) => {
          const station = topology.scope.find(({ stationCode }) => stationCode === new URL(url).searchParams.get("scode"));
          const fields = Object.entries({ sname: station.stationName, ...BUSAN_ACCESSIBILITY_FIELDS }).map(([name, value]) => `<${name}>${value}</${name}>`).join("");
          return new Response(`<?xml version="1.0" encoding="UTF-8"?><response><header><resultCode>00</resultCode><resultMsg>정상</resultMsg></header><body>${fields}</body></response>`, { headers: { "content-type": "application/xml" } });
        },
      });
      await writeFile(snapshotPath, JSON.stringify(snapshot));
      return { base, ...(await prepare(prepareRegionalAccessibilityRegistration, { now })) };
    }
    const now = reviewedPlusHour(sourceId);
    const snapshot = collectDaeguAccessibility({
      facilitiesBytes: await readFile(path.join(root, "tools/datapack/fixtures/daegu-accessibility-raw/data-go-15149872.csv")),
      topologySnapshots: await loadAdmittedDaeguTopologySnapshots(path.join(root, "tools/datapack/sources"), base), now,
    });
    await writeFile(snapshotPath, JSON.stringify(snapshot));
    return { base, ...(await prepare(prepareRegionalAccessibilityRegistration, { now })) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// 등록기가 쓰기 전 상태를 "옛 topology head에 결속된 직전 등록본"으로 만든다(재확인이 실제로 고치는 상태). 이 직전 상태 대비 등록기의 쓰기가 갱신 필드 안인지 본다.
function staleBase(base, sourceId) {
  const stale = structuredClone(base);
  const row = stale.sources.find(({ id }) => id === sourceId);
  const key = ["accessibilityAdmissionEvidence", "scheduleAdmissionEvidence"].find((name) => row[name] !== undefined);
  row[key].topologySnapshotId = "stale-topology-head";
  // 시간표 등록기만 관측 일자(retrievedAt)를 다시 쓴다. 접근성 등록기는 근거 객체만 쓴다.
  if (key === "scheduleAdmissionEvidence") row.retrievedAt = "2000-01-01";
  return stale;
}

for (const [recipeId, ownedSourceId] of TOPOLOGY_BOUND_RECIPES) {
  test(`${recipeId}: 등록기가 실제로 쓰는 inventory 변경은 recipe의 갱신 필드 범위 안이다 (#1122)`, async () => {
    const { base: current, prepared } = await registrarWrite(recipeId, ownedSourceId);
    const base = staleBase(current, ownedSourceId);
    // 비어 있는 증명이 되지 않게: 등록기가 직전 상태의 근거를 실제로 다시 썼다.
    assert.notDeepEqual(prepared.inventory.sources.find(({ id }) => id === ownedSourceId), base.sources.find(({ id }) => id === ownedSourceId));
    assert.deepEqual(inventoryChangeViolations({ base, head: prepared.inventory, recipeIds: [recipeId] }), []);
    // 범위 게이트가 이 쓰기를 실제로 본다: 갱신 필드를 비우면 같은 쓰기가 위반으로 잡힌다.
    assert.ok(inventoryScopeViolations({ base, head: prepared.inventory, allowed: new Map([[ownedSourceId, new Set()]]) }).length > 0);
  });
}

test("inventory 변경 검사: 소유하지 않은 항목의 변화와 소유 항목의 허용 밖 필드 변화를 항목별 사유로 돌려준다", () => {
  const base = { sources: [{ id: "a", x: 1 }, { id: "gwangju-transportation-route-topology", datasetUrl: "u", retrievedAt: "1" }] };
  const same = inventoryChangeViolations({ base, head: structuredClone(base), recipeIds: ["gwangju-topology"] });
  assert.deepEqual(same, []);
  const ok = structuredClone(base);
  ok.sources[1].retrievedAt = "2";
  assert.deepEqual(inventoryChangeViolations({ base, head: ok, recipeIds: ["gwangju-topology"] }), []);
  const bad = structuredClone(ok);
  bad.sources[0].x = 2;
  bad.sources[1].datasetUrl = "v";
  const found = inventoryChangeViolations({ base, head: bad, recipeIds: ["gwangju-topology"] });
  assert.equal(found.length, 2);
  assert.match(found[0], /^a: .*not owned/u);
  assert.match(found[1], /^gwangju-transportation-route-topology: .*datasetUrl/u);
  // recipe가 없으면 소유 항목도 없다.
  assert.equal(inventoryChangeViolations({ base, head: ok, recipeIds: ["busan-topology"] }).length, 1);
});

// #989: 등록 단계가 같은 범위 검사를 쓴다. recipe 없이 항목 id -> 갱신 필드 집합만으로 같은 규칙을 적용한다.
test("inventory 범위 검사(공용): 허용 필드만 바뀌면 통과하고 정책성 필드 변화·소유 밖 항목 변화·항목 추가·삭제는 사유를 돌려준다", () => {
  const base = { sources: [{ id: "a", x: 1 }, { id: "b", datasetUrl: "u", retrievedAt: "1" }] };
  const allowed = new Map([["b", new Set(["retrievedAt"])]]);
  const ok = structuredClone(base);
  ok.sources[1].retrievedAt = "2";
  assert.deepEqual(inventoryScopeViolations({ base, head: ok, allowed }), []);
  const policy = structuredClone(ok);
  policy.sources[1].datasetUrl = "v";
  assert.match(inventoryScopeViolations({ base, head: policy, allowed })[0], /^b: .*datasetUrl/u);
  const unowned = structuredClone(ok);
  unowned.sources[0].x = 2;
  assert.match(inventoryScopeViolations({ base, head: unowned, allowed })[0], /^a: .*not owned/u);
  assert.match(inventoryScopeViolations({ base, head: { sources: [...ok.sources, { id: "c" }] }, allowed })[0], /^c: .*added/u);
  assert.match(inventoryScopeViolations({ base, head: { sources: ok.sources.slice(0, 1) }, allowed })[0], /^b: .*removed/u);
  // 소유 항목에 허용 필드가 하나도 없으면(빈 집합) 어떤 필드도 바뀔 수 없다.
  assert.match(inventoryScopeViolations({ base, head: ok, allowed: new Map([["b", new Set()]]) })[0], /^b: .*retrievedAt/u);
});
