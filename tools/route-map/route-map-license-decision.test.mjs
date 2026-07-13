import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

test("route map license decision pins 대안 A(self-drawn) 전환과 근거", () => {
  const decision = readJson("tools/route-map/route-map-license-decision.json");
  const manifest = readJson(
    "apps/mobile/assets/datapacks/metro_map_pack/manifest.json",
  );

  assert.equal(decision.schemaVersion, 1);
  assert.equal(decision.artifactKind, "route-map-license-decision");
  assert.equal(decision.issue, 1637);
  // [2026-07-13 #2068] 하이브리드 렌더링(자작 SVG 바탕층) 전환 후에도
  // renderingSourceOfTruth는 인터랙션(히트·카메라·팝오버·경로 강조)의 진실 출처를
  // 가리키므로 바탕 paint 소스와 무관하게 structured-data로 고정된다.
  assert.equal(decision.renderingSourceOfTruth, "structured-data");
  assert.equal(typeof decision.renderingSourceOfTruthNote, "string");
  assert.ok(decision.renderingSourceOfTruthNote.length > 0);
  assert.ok(decision.strategyValues.includes("self-drawn-hybrid-basemap"));
  assert.ok(decision.bundledSvgRoleValues.includes("hybrid-basemap-source"));

  const decisionById = new Map(decision.regions.map((r) => [r.id, r]));
  const manifestById = new Map(manifest.maps.map((m) => [m.id, m]));

  // 모든 지역 결정이 실제 번들 manifest map과 1:1로 정합한다(수도권 포함).
  for (const region of decision.regions) {
    const map = manifestById.get(region.id);
    assert.ok(map, `${region.id} 결정이 manifest map과 대응해야 함`);
    assert.ok(
      decision.strategyValues.includes(region.renderingStrategy),
      `${region.id} renderingStrategy 값이 허용 목록에 있어야 함`,
    );
    assert.ok(
      decision.bundledSvgRoleValues.includes(region.bundledSvgRole),
      `${region.id} bundledSvgRole 값이 허용 목록에 있어야 함`,
    );
    // 결정 ↔ manifest route_map_strategy 정합 (drift 방지, 모든 지역).
    assert.equal(
      map.route_map_strategy.rendering_strategy,
      region.renderingStrategy,
      `${region.id} rendering_strategy가 결정과 일치해야 함`,
    );
    assert.equal(
      map.route_map_strategy.bundled_svg_role,
      region.bundledSvgRole,
      `${region.id} bundled_svg_role가 결정과 일치해야 함`,
    );
    assert.equal(
      map.route_map_strategy.commercial_production_ready,
      region.commercialProductionReady,
      `${region.id} commercial_production_ready가 결정과 일치해야 함`,
    );
    // attribution 정합: 결정과 shipped manifest license가 어긋나면 안 된다.
    assert.equal(
      map.license.attributionRequired,
      region.attributionRequired,
      `${region.id} attributionRequired가 manifest license와 일치해야 함`,
    );
    // [#1958] redistributionAllowed·reviewStatus 교차 검증(drift 방지, 모든 지역).
    // 정본에 두 필드가 존재하고, 허용 enum 안이며, manifest license와 정확히 일치한다.
    assert.equal(
      typeof region.redistributionAllowed,
      "boolean",
      `${region.id} 정본 redistributionAllowed는 boolean이어야 함`,
    );
    assert.ok(
      decision.reviewStatusValues.includes(region.reviewStatus),
      `${region.id} 정본 reviewStatus 값이 허용 목록에 있어야 함`,
    );
    assert.equal(
      map.license.redistributionAllowed,
      region.redistributionAllowed,
      `${region.id} redistributionAllowed가 manifest license와 일치해야 함`,
    );
    assert.equal(
      map.license.reviewStatus,
      region.reviewStatus,
      `${region.id} reviewStatus가 manifest license와 일치해야 함`,
    );
  }

  // [#2017] 스키마 정합(키 누락 회귀 방지 — gwangju에 licenseStatus/lineColorSource/
  // provenanceVerifiedAt가 빠졌던 회귀). 두 축으로 검증한다:
  //   (1) provenance 3필드는 4권역+수도권 전부에 존재하고 비어있지 않다.
  //   (2) 4권역(busan/daegu/daejeon/gwangju)은 동일 키 집합을 갖는다(수도권은
  //       attributionDropTargetAfterSelfDrawn 부재 등 연혁이 달라 4권역끼리만 대조).
  const allRegionIds = ["seoul", "busan", "daegu", "daejeon", "gwangju"];
  for (const id of allRegionIds) {
    assert.ok(decisionById.get(id), `${id} 결정 항목이 존재해야 함`);
  }
  const provenanceKeys = ["licenseStatus", "lineColorSource", "provenanceVerifiedAt"];
  for (const id of allRegionIds) {
    const region = decisionById.get(id);
    for (const key of provenanceKeys) {
      assert.equal(
        typeof region[key],
        "string",
        `${id} 항목에 ${key} 문자열 필드가 있어야 함`,
      );
      assert.ok(region[key].length > 0, `${id} 항목 ${key}가 비어있지 않아야 함`);
    }
    assert.match(
      region.provenanceVerifiedAt,
      /^\d{4}-\d{2}-\d{2}$/,
      `${id} provenanceVerifiedAt는 YYYY-MM-DD 형식이어야 함`,
    );
  }
  const nonCapitalIds = ["busan", "daegu", "daejeon", "gwangju"];
  const nonCapitalRefKeys = Object.keys(decisionById.get("busan")).sort();
  for (const id of nonCapitalIds) {
    assert.deepEqual(
      Object.keys(decisionById.get(id)).sort(),
      nonCapitalRefKeys,
      `${id} 항목 키 집합이 부산과 동일해야 함(4권역 스키마 정합)`,
    );
  }

  // 수도권은 #1950으로 오너 자작 8선형 도식(self-drawn) 정본 채택, 상용 준비 완료.
  // [2026-07-13 #2068] 자작 SVG를 빌드타임 컴파일한 바탕층 + 구조화 좌표 인터랙션의
  // 하이브리드 렌더링으로 전환.
  const seoul = decisionById.get("seoul");
  assert.equal(seoul.renderingStrategy, "self-drawn-hybrid-basemap");
  assert.equal(seoul.bundledSvgRole, "hybrid-basemap-source");
  assert.equal(seoul.commercialProductionReady, true);
  assert.equal(seoul.attributionRequired, false);
  assert.equal(seoul.licenseStatus, "self-drawn-confirmed");

  // 부산·대구·대전·광주 모두 [2026-07-13 #2068] 하이브리드 렌더링(자작 SVG를
  // 빌드타임 컴파일한 바탕층 + 구조화 좌표 인터랙션)으로 전환됨.
  for (const id of ["busan", "daegu", "daejeon", "gwangju"]) {
    const region = decisionById.get(id);
    assert.equal(
      region.renderingStrategy,
      "self-drawn-hybrid-basemap",
      `${id}는 self-drawn-hybrid-basemap으로 전환되어야 함`,
    );
    assert.equal(region.bundledSvgRole, "hybrid-basemap-source");
  }

  // 부산·대구·대전·광주: #2011 오너 자작 도식 정본 반입으로 self-drawn 확정 승격 →
  // 상용 승격·attribution 해제. 광주는 이전 CC-BY-SA 유지 상태에서 자작 전환으로
  // 함께 해제됐다(attribution 제거가 아니라 계약 전환 — regions[].notes 참조).
  for (const id of ["busan", "daegu", "daejeon", "gwangju"]) {
    const region = decisionById.get(id);
    assert.equal(
      region.commercialProductionReady,
      true,
      `${id}는 사실 데이터 재검증 후 상용 승격되어야 함`,
    );
    assert.equal(
      region.attributionRequired,
      false,
      `${id}는 자체 도식 전환 후 attribution 해제되어야 함`,
    );
    assert.equal(
      manifestById.get(id).license.commercialUseAllowed,
      true,
      `${id} manifest license.commercialUseAllowed는 true여야 함`,
    );
  }

  // 광주: [연혁] CC-BY-SA 2.0 KR ShareAlike라 보수적으로 attribution을 유지했으나,
  // #2011 오너 자작 도식 반입으로 배포 렌더링이 CC-BY-SA SVG(kiwitree) 파생이
  // 아니게 되어 attribution을 해제하고 상용 승격했다(위 self-drawn 루프에 포함).
  const gwangjuRegion = decisionById.get("gwangju");
  assert.equal(gwangjuRegion.reviewStatus, "self-drawn-confirmed");
  assert.equal(gwangjuRegion.selfDrawnSource, "easy-subway-gwangju-v1.svg");

  // 광주 ShareAlike 결론이 사실≠저작물 근거와 함께 기록된다(연혁 근거로 보존).
  const gwangju = decision.gwangjuShareAlikeConclusion;
  assert.ok(/ShareAlike/.test(gwangju.conclusion));
  assert.ok(/파생물이 아니/.test(gwangju.conclusion));
  assert.ok(/Feist/.test(gwangju.legalBasis));
  assert.ok(/ODbL/.test(gwangju.precedent));

  // attribution 필요 지역 목록이 #1641로 전달 가능한 형태로 확정된다.
  const handoff = decision.attributionHandoffTo1641;
  // #2011: 4권역 전부 self-drawn 전환으로 attribution 해제 — 요구 지역 목록은 빈다.
  assert.deepEqual(handoff.attributionRequiredRegions, []);
  // handoff 목록이 per-region attributionRequired 플래그와 정합한다.
  const requiredKoreanNames = decision.regions
    .filter((region) => region.attributionRequired)
    .map((region) => region.region);
  assert.deepEqual(
    [...handoff.attributionRequiredRegions].sort(),
    [...requiredKoreanNames].sort(),
  );
  assert.ok(
    !handoff.attributionRequiredRegions.includes("수도권"),
    "수도권은 public domain으로 attribution 목록에서 제외되어야 함",
  );

  // 상용 앱 벤치마크가 URL과 함께 기록된다(카카오·네이버·Transit 등).
  const services = decision.similarServiceBenchmarks.map((b) => b.service);
  for (const expected of ["카카오맵 / 카카오지하철", "네이버 지도", "Transit 앱"]) {
    assert.ok(
      services.includes(expected),
      `벤치마크에 ${expected}가 포함되어야 함`,
    );
  }
  for (const benchmark of decision.similarServiceBenchmarks) {
    assert.match(benchmark.url, /^https:\/\//);
  }
  assert.ok(decision.references.length >= 3);
});
