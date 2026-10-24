import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

// 컴파일러의 숨김 제거와 독립인 오라클. 컴파일러는 여는 태그를 정규식으로 읽고 속성 문자열에
// 정규식을 대는 반면, 여기서는 태그를 따옴표를 존중하는 토큰으로 읽고 속성과 `style` 선언을
// 이름·값 쌍으로 풀어 비교한다. 숨김 형태는 SVG 사양이 정하는 세 가지다: display가 none,
// opacity가 0, 그리고 그 요소의 서브트리 전체. 오라클이 놓치는 형태(예: `<style>` 클래스가 준
// display:none)는 원본에서 안 보이는 요소를 기대에 남겨 테스트가 실패하는 쪽이라 안전한 방향이다.
const TAG_TOKEN = /<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const ATTRIBUTE_TOKEN = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function declarationsOf(attributeText) {
  const declarations = new Map();
  for (const [, name, double, single] of attributeText.matchAll(ATTRIBUTE_TOKEN)) {
    const value = double ?? single;
    if (name === "style") {
      for (const item of value.split(";")) {
        const colon = item.indexOf(":");
        if (colon > 0) {
          declarations.set(item.slice(0, colon).trim().toLowerCase(), item.slice(colon + 1).replace(/!important\s*$/i, "").trim());
        }
      }
    } else if (!declarations.has(name)) {
      declarations.set(name, value.trim());
    }
  }
  return declarations;
}

function isInvisible(declarations) {
  const opacity = declarations.get("opacity");
  return declarations.get("display") === "none" || (opacity !== undefined && opacity !== "" && Number(opacity) === 0);
}

/** 오너 SVG에서 display:none·opacity 0 서브트리를 뺀 뒤 남는 요소의 여는 태그들. */
function visibleOpenTags(svgText) {
  const markup = svgText.replaceAll(/<!--[\s\S]*?-->/g, "");
  const tags = [];
  let hiddenDepth = 0;
  for (const [tag, closing, , attributeText] of markup.matchAll(TAG_TOKEN)) {
    if (closing) {
      if (hiddenDepth > 0) hiddenDepth -= 1;
      continue;
    }
    const selfClosing = attributeText.trimEnd().endsWith("/");
    if (hiddenDepth === 0 && !isInvisible(declarationsOf(attributeText))) tags.push(tag);
    else if (!selfClosing) hiddenDepth += 1;
  }
  return tags.join("");
}

const HIDDEN_FORMS_SVG =
  '<svg><path id="a" display="none"/><path id="b" style="display:none"/><path id="c" style="fill:red; display : none !important"/>' +
  '<path id="d" opacity="0"/><path id="e" opacity="0.0"/><path id="f" style="opacity:0"/><path id="g" style="opacity : 0.0 !important"/>' +
  '<g id="h" opacity="0"><path id="inner-h" d="M0 0"/></g><g id="i" style="display:none"><g><path id="inner-i"/></g></g>' +
  '<path id="shown-1" opacity="0.5"/><path id="shown-2" style="opacity:.05"/><path id="shown-3" style="display:inline"/>' +
  '<path id="shown-4" fill-opacity="0" stroke-opacity="0"/><g id="shown-5"><path id="shown-6"/></g></svg>';
const idsOf = (markup) => [...markup.matchAll(/id="([^"]+)"/g)].map(([, id]) => id);
const SHOWN_IDS = ["shown-1", "shown-2", "shown-3", "shown-4", "shown-5", "shown-6"];

test("가시성 오라클은 사양이 정하는 숨김 형태를 모두 알아본다", () => {
  assert.deepEqual(idsOf(visibleOpenTags(HIDDEN_FORMS_SVG)), SHOWN_IDS);
});

test("컴파일러의 숨김 제거는 오라클과 같은 요소를 남긴다", async () => {
  const { stripHiddenElements } = await import("./compile-basemap-vec.mjs");
  assert.deepEqual(idsOf(stripHiddenElements(HIDDEN_FORMS_SVG)), SHOWN_IDS);
});

// #2068 전량 반입 계약(2026-07-26 오너 최종 지시) — 배포 basemap 콘텐츠 정책을
// **실제 컴파일 입력·배포 바이트와 대조해** 고정한다. 정책이 "오너 SVG 렌더 대상
// 전량"으로 바뀌었으므로, 종전처럼 장식 id 부재를 확인하는 대신 **선별 없음**을
// 확인한다: 오너 SVG의 렌더 대상 요소가 컴파일 입력에 하나도 빠지지 않는지.
// 라이선스 판단(오너 자작·attribution 불요)은 이 테스트의 대상이 아니다.
test("배포 basemap 콘텐츠 정책이 실제 컴파일 입력과 일치한다(전량 반입 계약)", async () => {
  const decision = readJson("tools/route-map/route-map-license-decision.json");
  const policy = decision.distributedBasemapContentPolicy;

  assert.equal(policy.revisedAt, "2026-07-26");
  assert.equal(
    policy.contractTest,
    "tools/route-map/route-map-license-decision.test.mjs",
  );
  assert.equal(policy.included.length, 1);
  assert.match(policy.included[0], /전량/);
  assert.equal(policy.excluded.length, 1);
  assert.match(policy.excluded[0], /렌더되지 않는/);

  const { normalizeSvgForCompile } = await import("./compile-basemap-vec.mjs");

  const sources = path.join(root, "tools/route-map/route-map-defs/svg-sources");
  const regionSvgs = [
    "easy-subway-sma-v4.svg",
    "easy-subway-busan-v3.svg",
    "easy-subway-daegu-v3.svg",
    "easy-subway-daejeon-v3.svg",
    "easy-subway-gwangju-v3.svg",
  ];

  // 렌더 대상 요소의 id 전수를 오너 SVG에서 뽑아 컴파일 입력에 그대로 있는지 본다.
  // display:none·opacity 0 서브트리(비렌더)는 SVG 사양대로 제외 대상이라 기대에서 뺀다.
  // 기대 집합은 컴파일러의 숨김 제거(stripHiddenElements)와 코드를 공유하지 않는 아래
  // 오라클(visibleOpenTags)이 정한다.
  const RENDERABLE = /<(path|circle|rect|line|polyline|polygon|text|image|use|ellipse)\b[^>]*\bid="([^"]+)"/g;

  for (const file of regionSvgs) {
    const svgText = readFileSync(path.join(sources, file), "utf8");
    const normalized = normalizeSvgForCompile(svgText);
    const visibleSource = visibleOpenTags(svgText);

    const missing = [];
    for (const match of visibleSource.matchAll(RENDERABLE)) {
      const id = match[2];
      if (!normalized.includes(`id="${id}"`)) missing.push(id);
    }
    assert.deepEqual(
      missing,
      [],
      `${file}: 오너 SVG의 렌더 대상 요소가 컴파일 입력에서 빠졌습니다 — 전량 반입 계약 위반:\n` +
        missing.slice(0, 10).join("\n"),
    );
  }

  // 컴파일 입력뿐 아니라 **실제 배포 바이트(.vec)** 로도 확인한다 — 정책이
  // 기술하는 대상은 배포물이다. 라벨은 참조 서체 글리프 윤곽선으로 구워져(#1488)
  // 배포 .vec에 텍스트 바이트가 없으므로, 종전 "역명 UTF-8이 .vec에 있다" 검사를
  // 같은 성질의 세 단계로 옮긴다.
  //   (1) 오너 SVG → 윤곽선 컴파일 입력을 지금 코드로 다시 만든 sha256이 manifest가
  //       고정한 compileInputSvgSha256과 같다(배포 입력이 오너 도식 전량에서 나왔다).
  //   (2) 배포 .vec의 sha256이 manifest의 compiledVectorSha256과 같다(배포 바이트가
  //       그 입력에서 나왔다).
  //   (3) 오너 도식의 대표 역명이 윤곽선 그룹(data-label-role 그룹 안의 path)으로 입력에 있고,
  //       <text>는 한 개도 남지 않으며, 배포 .vec에는 그 역명의 UTF-8 바이트가 없다
  //       (기기 서체에 기대는 글자 그리기가 배포물에 없다).
  const { outlineBasemapText } = await import("./outline-basemap-text.mjs");
  const manifest = readJson("tools/route-map/basemap-build-manifest.json");
  assert.equal(manifest.content.labels, "outlined-into-vec");
  const basemapDir = path.join(
    root,
    "apps/mobile/assets/datapacks/metro_map_pack/basemap",
  );
  const distributed = {
    seoul: { svg: "easy-subway-sma-v4.svg", stations: ["전곡", "뚝섬"] },
    busan: { svg: "easy-subway-busan-v3.svg", stations: ["벡스코(시립미술관)", "서면"] },
  };
  const sha256Of = (value) => createHash("sha256").update(value).digest("hex");
  for (const [id, { svg, stations }] of Object.entries(distributed)) {
    const map = manifest.maps.find((entry) => entry.id === id);
    assert.ok(map, `${id}: build manifest에 권역이 있어야 합니다.`);

    const outlined = outlineBasemapText(
      normalizeSvgForCompile(readFileSync(path.join(sources, svg), "utf8")),
    ).svg;
    assert.equal(
      sha256Of(outlined),
      map.compileInputSvgSha256,
      `${id}: 오너 SVG에서 다시 만든 윤곽선 컴파일 입력이 manifest 기록과 다릅니다.`,
    );

    const vecBytes = readFileSync(path.join(basemapDir, `${id}.vec`));
    assert.equal(
      sha256Of(vecBytes),
      map.compiledVectorSha256,
      `${id}.vec: 배포 바이트가 manifest가 고정한 컴파일 산출과 다릅니다.`,
    );

    assert.ok(!/<text\b/.test(outlined), `${id}: 윤곽선 입력에 <text>가 남았습니다.`);
    const outlinedStations = new Set(
      [
        ...outlined.matchAll(
          /<g\b[^>]*\bdata-label-role="[^"]*"[^>]*>(?:\s*<g\b[^>]*>)*\s*<path d="M/g,
        ),
      ].map((match) => match[0].match(/\bdata-station="([^"]*)"/)?.[1]),
    );
    for (const station of stations) {
      assert.ok(
        outlinedStations.has(station),
        `${id}: 오너 도식의 역명 "${station}"가 윤곽선 그룹으로 입력에 없습니다.`,
      );
      assert.ok(
        !vecBytes.includes(Buffer.from(station.split("(")[0], "utf8")),
        `${id}.vec: 역명 "${station}"가 텍스트 바이트로 남아 기기 서체에 기대고 있습니다.`,
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
