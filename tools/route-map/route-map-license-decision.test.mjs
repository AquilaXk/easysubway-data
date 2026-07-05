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
  assert.equal(decision.renderingSourceOfTruth, "structured-data");

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
  }

  // 수도권은 public domain official-svg, 상용 준비 완료.
  const seoul = decisionById.get("seoul");
  assert.equal(seoul.renderingStrategy, "official-svg");
  assert.equal(seoul.commercialProductionReady, true);
  assert.equal(seoul.attributionRequired, false);

  // 부산·대구·대전·광주 모두 self-drawn-schematic 전환(원본 SVG는 좌표 검수 참조만).
  for (const id of ["busan", "daegu", "daejeon", "gwangju"]) {
    const region = decisionById.get(id);
    assert.equal(
      region.renderingStrategy,
      "self-drawn-schematic",
      `${id}는 self-drawn-schematic으로 전환되어야 함`,
    );
    assert.equal(region.bundledSvgRole, "review-reference-only");
  }

  // 부산·대구·대전: #1639/#1640 좌표 provenance(사실 데이터) 재검증 + line_tracks를
  // down_path(위상=사실)로 재빌드 + SVG 번들 제거(#1715) 완료 → 상용 승격·attribution 해제.
  for (const id of ["busan", "daegu", "daejeon"]) {
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

  // 광주: CC-BY-SA 2.0 KR ShareAlike라 사실 재구성에도 보수적으로 미승격·attribution 유지.
  const gwangjuRegion = decisionById.get("gwangju");
  assert.equal(gwangjuRegion.commercialProductionReady, false);
  assert.equal(gwangjuRegion.attributionRequired, true);
  assert.equal(manifestById.get("gwangju").license.commercialUseAllowed, false);

  // 광주 ShareAlike 결론이 사실≠저작물 근거와 함께 기록된다.
  const gwangju = decision.gwangjuShareAlikeConclusion;
  assert.ok(/ShareAlike/.test(gwangju.conclusion));
  assert.ok(/파생물이 아니/.test(gwangju.conclusion));
  assert.ok(/Feist/.test(gwangju.legalBasis));
  assert.ok(/ODbL/.test(gwangju.precedent));

  // attribution 필요 지역 목록이 #1641로 전달 가능한 형태로 확정된다.
  const handoff = decision.attributionHandoffTo1641;
  // #1639/#1640: 부산·대구·대전 attribution 해제, 광주(CC-BY-SA)만 유지.
  assert.deepEqual(handoff.attributionRequiredRegions, ["광주"]);
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
