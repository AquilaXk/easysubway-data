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

  // 부산·대구·대전·광주는 self-drawn 전환 + 상용 미승격 + 번들 중 attribution 유지.
  for (const id of ["busan", "daegu", "daejeon", "gwangju"]) {
    const region = decisionById.get(id);
    assert.equal(
      region.renderingStrategy,
      "self-drawn-schematic",
      `${id}는 self-drawn-schematic으로 전환되어야 함`,
    );
    assert.equal(region.bundledSvgRole, "review-reference-only");
    assert.equal(
      region.commercialProductionReady,
      false,
      `${id}는 원본 라이선스로 상용 승격되지 않아야 함`,
    );
    // 원본 SVG 번들 유지 중에는 attribution을 유지한다(license 위반 방지).
    assert.equal(
      region.attributionRequired,
      true,
      `${id}는 SVG 번들 유지 중 attributionRequired=true여야 함`,
    );

    // 상용 불명확 원본은 production으로 승격하지 않는다: manifest도 상용 불가.
    assert.equal(
      manifestById.get(id).license.commercialUseAllowed,
      false,
      `${id} manifest license.commercialUseAllowed는 false여야 함`,
    );
  }

  // 광주 ShareAlike 결론이 사실≠저작물 근거와 함께 기록된다.
  const gwangju = decision.gwangjuShareAlikeConclusion;
  assert.ok(/ShareAlike/.test(gwangju.conclusion));
  assert.ok(/파생물이 아니/.test(gwangju.conclusion));
  assert.ok(/Feist/.test(gwangju.legalBasis));
  assert.ok(/ODbL/.test(gwangju.precedent));

  // attribution 필요 지역 목록이 #1641로 전달 가능한 형태로 확정된다.
  const handoff = decision.attributionHandoffTo1641;
  assert.deepEqual(handoff.attributionRequiredRegions, [
    "부산",
    "대구",
    "대전",
    "광주",
  ]);
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
