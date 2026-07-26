import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
  assert.equal(gwangjuRegion.selfDrawnSource, "easy-subway-gwangju-v3.svg");

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

// #2068 리뷰 M1(2026-07-26) — 배포 basemap 콘텐츠 정책을 **실제 컴파일 산출과
// 대조해** 고정한다. 종전에는 이 블록을 검사하는 계약 테스트가 없어, 배포물이
// 바뀌었는데도 결정문의 excluded 목록이 낡은 채 남는 드리프트가 조용히 발생했다.
// 라이선스 판단(오너 자작·attribution 불요)은 이 테스트의 대상이 아니다 —
// "무엇이 배포되는가"가 문서와 일치하는지만 기계적으로 확인한다.
test("배포 basemap 콘텐츠 정책이 실제 컴파일 입력과 일치한다(#2068 M1 드리프트 방지)", async () => {
  const decision = readJson("tools/route-map/route-map-license-decision.json");
  const policy = decision.distributedBasemapContentPolicy;

  assert.equal(policy.revisedAt, "2026-07-26");
  assert.equal(
    policy.contractTest,
    "tools/route-map/route-map-license-decision.test.mjs",
  );
  assert.deepEqual(policy.included, [
    "현재 운행 노선 형상(route-lines·terminal-route-extensions)",
    "역·환승·종점 심벌(station-symbols·transfer-station-symbols·terminal-station-symbols)",
    "노선 배지(terminal-route-badges·line-terminal-badges·route-midline-markers·route-number-badges)",
    "SVG station-name label text",
    "KTX/SRT service marks drawn by the owner in the map body",
  ]);
  assert.deepEqual(policy.excluded, [
    "map title, header bar and status chips",
    "legend and top route-line explanation box",
    "card background, border and page background",
    "component spec library samples (display:none)",
    "header legend samples of KTX/SRT logos",
    "planned or construction routes absent from structured catalog",
  ]);

  const {
    collectServiceMarks,
    normalizeSvgForCompile,
    resolveStationNameLabelLayerId,
    DECOR_SERVICE_MARK_SAMPLE_IDS,
  } = await import("./compile-basemap-vec.mjs");

  const sources = path.join(root, "tools/route-map/route-map-defs/svg-sources");
  const regionSvgs = [
    "easy-subway-sma-v4.svg",
    "easy-subway-busan-v3.svg",
    "easy-subway-daegu-v3.svg",
    "easy-subway-daejeon-v3.svg",
    "easy-subway-gwangju-v3.svg",
  ];

  for (const file of regionSvgs) {
    const svgText = readFileSync(path.join(sources, file), "utf8");
    const normalized = normalizeSvgForCompile(svgText);

    // included: 역명 라벨 레이어와 오너 표장이 실제로 배포물에 있다.
    const labelLayerId = resolveStationNameLabelLayerId(svgText);
    assert.match(
      normalized,
      new RegExp(`id="${labelLayerId}"`),
      `${file}: 정책이 included로 선언한 역명 라벨이 컴파일 입력에 없습니다.`,
    );
    const marks = collectServiceMarks(svgText);
    assert.ok(
      marks.length > 0,
      `${file}: 정책이 included로 선언한 KTX·SRT 표장이 0건입니다.`,
    );

    // excluded: 장식 요소가 실제로 배포물에 없다.
    const rendered = normalized.includes("</defs>")
      ? normalized.slice(normalized.lastIndexOf("</defs>") + 7)
      : normalized;
    for (const marker of [
      /id="header-title-legend-and-status-layer"/,
      /id="header-complete-route-badges-layer"/,
      /id="top-route-line-explanation-layer"/,
      /id="legend-layer"/,
      /id="header-line-chip"/,
      /id="header-status-chip"/,
      /id="page-background"/,
      /id="main-map-card-background"/,
      /spec-library/,
    ]) {
      assert.doesNotMatch(
        rendered,
        marker,
        `${file}: 정책이 excluded로 선언한 장식이 컴파일 입력에 있습니다 — ${marker}`,
      );
    }
    // 헤더 범례 KTX/SRT 견본은 명시 목록으로 제외된다.
    for (const sample of DECOR_SERVICE_MARK_SAMPLE_IDS) {
      assert.ok(
        !marks.some((mark) => mark.id === sample.id),
        `${file}: 헤더 범례 견본 ${sample.id}가 배포 표장 목록에 있습니다.`,
      );
    }
  }

  // 컴파일 입력뿐 아니라 **실제 배포 바이트(.vec)** 로도 확인한다 — 정책이
  // 기술하는 대상은 배포물이다.
  const basemapDir = path.join(
    root,
    "apps/mobile/assets/datapacks/metro_map_pack/basemap",
  );
  const distributed = {
    "seoul.vec": { present: ["전곡", "뚝섬"], absent: ["통합 노선도", "간선 색상별"] },
    "busan.vec": { present: ["벡스코", "서면"], absent: ["통합 노선도"] },
  };
  for (const [vecName, expectation] of Object.entries(distributed)) {
    const bytes = readFileSync(path.join(basemapDir, vecName), "latin1");
    for (const text of expectation.present) {
      assert.ok(
        bytes.includes(Buffer.from(text, "utf8").toString("latin1")),
        `${vecName}: 정책이 included로 선언한 역명 "${text}"가 배포 .vec에 없습니다.`,
      );
    }
    for (const text of expectation.absent) {
      assert.ok(
        !bytes.includes(Buffer.from(text, "utf8").toString("latin1")),
        `${vecName}: 정책이 excluded로 선언한 장식 텍스트 "${text}"가 배포 .vec에 있습니다.`,
      );
    }
  }
});

// [2026-07-26 #2571] 오너 결정으로 구버전 SVG 보관 조항이 폐기됐다. 종전에는 각
// 권역 notes가 "v1 SVG는 삭제하지 않고 review-reference로 보관한다"고 못박아
// v1·v2가 정본과 나란히 남아 있었고, 어느 쪽이 정본인지 혼동을 키웠다. 폐기
// 상태를 문서로만 두면 다음 반입 때 구버전이 조용히 다시 쌓이므로, 작업 트리에
// 권역별 정본 1개씩만 있다는 것을 여기서 고정한다.
test("구버전 SVG 보관 조항 폐기 — svg-sources에 권역별 정본만 남는다(#2571)", () => {
  const decision = readJson("tools/route-map/route-map-license-decision.json");
  const policy = decision.priorVersionSvgRetentionPolicy;

  assert.equal(policy.status, "abolished");
  assert.equal(policy.decidedAt, "2026-07-26");
  assert.equal(policy.issue, 2571);
  assert.equal(
    policy.contractTest,
    "tools/route-map/route-map-license-decision.test.mjs",
  );

  // 폐기 조항의 정본 목록은 결정문의 regions와 1:1이어야 한다(드리프트 방지).
  assert.deepEqual(
    [...policy.canonicalSvgs].sort(),
    decision.regions
      .map((region) => path.basename(region.sourceUrl))
      .sort(),
  );

  // 작업 트리 실측 — route-map-defs 하위 전체를 재귀로 훑는다. 1단 목록만 보면
  // svg-sources/archive/ 같은 하위 디렉터리나 defs 루트로 구버전이 다시 들어와도
  // green이 된다. 확장자는 대소문자를 가리지 않는다(.SVG 회피 차단).
  const defsDir = path.join(root, "tools/route-map/route-map-defs");
  const defsEntries = readdirSync(defsDir, { recursive: true }).map(String);
  const byExtension = (extension) =>
    defsEntries
      .filter((entry) => entry.toLowerCase().endsWith(extension))
      .map((entry) => path.basename(entry))
      .sort();

  assert.deepEqual(
    byExtension(".svg"),
    [...policy.canonicalSvgs].sort(),
    "route-map-defs에 정본이 아닌 SVG가 있습니다 — 구버전은 git 히스토리로만 보관합니다(#2571).",
  );

  // 파생 추출 JSON도 정본에서 나온 것만 남는다. 이름 접두사(easy-subway-)에
  // 기대지 않고 -geometry.json 전수를 정본 파생 목록과 대조한다.
  assert.deepEqual(
    byExtension("-geometry.json"),
    policy.canonicalSvgs
      .map((svg) => svg.replace(/\.svg$/i, "-geometry.json"))
      .sort(),
    "정본이 아닌 SVG의 추출 JSON이 남아 있습니다(#2571).",
  );

  // 삭제 목록에 오른 파일이 실제로 없다.
  for (const relativePath of policy.removedAt) {
    assert.ok(
      !existsSync(path.join(root, relativePath)),
      `${relativePath}는 #2571로 삭제됐어야 합니다.`,
    );
  }
});

// [2026-07-26 #2571] stale SHA256SUMS.txt 폐기. 구버전 SVG와 달리 이 파일은
// 생성기도 읽는 게이트도 없이 pubspec asset 등재만으로 배포됐고, 기록 8행 중
// 7행이 실제 해시와 어긋나 있었다. 폐기 사실을 기록만 해 두면 같은 파일이 다시
// 커밋돼도 아무도 모르므로 부재를 여기서 고정한다.
test("stale 자산 폐기 기록의 파일이 저장소에 없다(#2571)", () => {
  const decision = readJson("tools/route-map/route-map-license-decision.json");
  const retired = decision.retiredStaleArtifacts;

  assert.equal(retired.decidedAt, "2026-07-26");
  assert.equal(retired.issue, 2571);
  assert.equal(
    retired.contractTest,
    "tools/route-map/route-map-license-decision.test.mjs",
  );
  assert.ok(retired.items.length > 0, "폐기 기록이 비어 있습니다.");

  for (const item of retired.items) {
    assert.ok(
      typeof item.reason === "string" && item.reason.length > 0,
      `${item.path}: 폐기 사유가 필요합니다.`,
    );
    assert.ok(
      !existsSync(path.join(root, item.path)),
      `${item.path}는 #2571로 폐기됐어야 합니다 — 재유입이라면 생성기와 검증 게이트를 함께 신설하고 이 기록을 갱신하세요.`,
    );
  }

  // pubspec asset 등재도 함께 걷혔는지 확인한다(등재가 남으면 flutter 빌드가 깨진다).
  const pubspec = readFileSync(path.join(root, "apps/mobile/pubspec.yaml"), "utf8");
  for (const item of retired.items) {
    const assetPath = item.path.replace(/^apps\/mobile\//, "");
    assert.ok(
      !pubspec.includes(assetPath),
      `${assetPath}가 pubspec.yaml assets에 남아 있습니다.`,
    );
  }
});
