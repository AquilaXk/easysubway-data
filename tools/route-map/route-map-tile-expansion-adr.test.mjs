import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

test("route map tile expansion ADR pins v1 local pack + future tile design", () => {
  const adr = readJson("tools/route-map/route-map-tile-expansion-adr.json");
  const contract = readJson(
    "tools/route-map/structured-route-map-contract.json",
  );

  assert.equal(adr.schemaVersion, 1);
  assert.equal(adr.artifactKind, "route-map-tile-expansion-adr");
  assert.equal(adr.status, "accepted");
  assert.equal(adr.issue, 1644);

  // v1은 로컬 데이터팩으로 닫고 서버 tile은 후속 확장으로 분리한다.
  assert.equal(adr.v1ClosesWithLocalPack, true);
  assert.ok(
    adr.nonGoalsForV1.includes("서버 vector tile 구현"),
    "서버 vector tile은 v1 non-goal이어야 함",
  );

  // 옵션 중 정확히 하나만 chosen이고, region 단위 pack이 선택된다.
  const chosen = adr.options.filter((option) => option.chosen);
  assert.equal(chosen.length, 1, "선택된 옵션은 정확히 하나");
  assert.equal(chosen[0].id, "region-single-pack");
  // 표준 Web Mercator 옵션은 도식 좌표에 부적합으로 기각된다.
  const mercator = adr.options.find((o) => o.id === "mvt-web-mercator");
  assert.ok(mercator && mercator.chosen === false);

  // layer 매핑이 #1636 스키마 source(route_map_positions/파생)와 1:1로 4개 layer를
  // 표준 geometry 타입으로 덮는다.
  const tileLayers = adr.layerMapping.map((m) => m.tileLayer);
  assert.deepEqual(
    [...tileLayers].sort(),
    ["line_path", "station_label", "station_point", "transfer_node"],
  );
  for (const mapping of adr.layerMapping) {
    assert.ok(
      ["Point", "LineString", "Polygon"].includes(mapping.geometry),
      `${mapping.tileLayer} geometry는 표준 MVT 타입`,
    );
    assert.ok(
      typeof mapping.schemaSource === "string" && mapping.schemaSource.length > 0,
    );
  }
  // 매핑 대상이 실제 #1636 계약의 route_map_positions 컬럼 체계를 참조한다.
  assert.ok(
    adr.layerMapping.some((m) => m.schemaSource.includes("route_map_positions")),
  );
  assert.ok(contract.layers.length > 0);

  // feature id 전략이 #1636 체계(region:station:line)를 따른다.
  assert.match(adr.featureIdStrategy, /\{region\}:\{station_id\}:\{line_id\}/);

  // cache/versioning이 기존 배포·검증 도구를 재사용한다.
  assert.match(adr.cacheVersioning, /publish-object-storage\.mjs/);
  assert.match(adr.cacheVersioning, /validate-remote-datapack-artifact\.mjs/);

  // 오프라인 fallback: 원격 실패 시 로컬 데이터팩 유지.
  assert.match(adr.offlineFallback, /로컬 데이터팩/);

  // 서버 API 경계: manifest만 제공 + 실시간(#1649) 분리.
  assert.match(adr.serverApiBoundary, /manifest/);
  assert.match(adr.serverApiBoundary, /#1649/);

  // 스키마 호환 결론 + 근거.
  assert.ok(/막지 않는다/.test(adr.schemaCompatibility.conclusion));
  assert.ok(Array.isArray(adr.schemaCompatibility.evidence));
  assert.ok(adr.schemaCompatibility.evidence.length >= 3);

  assert.ok(adr.references.length >= 1);
  for (const reference of adr.references) {
    assert.match(reference, /^https:\/\//);
  }
});
