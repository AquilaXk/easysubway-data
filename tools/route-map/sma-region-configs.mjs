#!/usr/bin/env node
// #2011 2단계: 오너 자작 8선형 도식(easy-subway-sma-v*) 반복 파이프라인의 권역
// 파라미터화 단일 원천. 각 권역의 SVG 문법 차이(슬러그·색·정합 규칙·라이선스
// provenance·환승 broadcast 예외)를 한 곳에 모아 apply-sma-svg-positions·
// build-sma-tracks가 공통 코드로 여러 권역을 처리하도록 한다.
//
// 설계 원칙:
//   - regionKey  : route_map_positions.region 값(예: "수도권"/"부산권").
//   - lineNamePrefix : lines.name_ko 접두(예: "수도권 1호선"의 "수도권",
//                      "부산 1호선"의 "부산"). regionKey와 다를 수 있다(부산).
//   - slugToSuffix : SVG data-line 슬러그 → lines.name_ko 접미.
//   - colorToSlug  : SVG 노선 stroke 색(소문자 hex) → 슬러그(build-sma-tracks용).
//   - canonicalRules : SVG data-station 문자열 → canonical station 이름 정규화.
//   - missingLineHint / markerlessFallback / topologyExceptions / excludedStations :
//     각 권역 도식의 실측 예외.
//   - contentBand : 노선 stroke의 콘텐츠 y 밴드(범례 stroke 배제용).
//
// 수도권 값은 #1950/#2011(v2) 정본과 byte-identical 회귀를 위해 apply-sma-svg-positions의
// 기존 하드코딩과 100% 동일하게 유지한다(회귀 게이트).

// #2068 수도권 동명 별개역: 이름은 같지만 카탈로그에 각각 별도 station_id로 실재해
// 좌표 broadcast를 금지하고 노선으로 1:1 해소해야 하는 역(신촌 2호선/경의중앙,
// 양평 5호선/경의중앙). v2는 data-station 콜론 표기가 이 힌트를 담았으나 v4는
// 콜론을 걷어냈다 — 목록을 넓힐 때는 반드시 카탈로그 실측(동일 이름 2행이 서로
// 다른 물리역인지)으로 확인한다.
const SEOUL_DISTINCT_SAME_NAME_STATIONS = new Set(["신촌", "양평"]);

// ── 수도권(seoul): #1950/#2011 정본. #2068 오너 재제작 v4로 교체. ─────────────
const SEOUL = {
  id: "seoul",
  regionKey: "수도권",
  lineNamePrefix: "수도권",
  svgSource: {
    sourceId: "owner-self-drawn-sma-schematic",
    sourceName: "오너 자작 수도권 8선형 정본 도식",
    sourceUrl: "internal:route-map/route-map-defs/svg-sources/easy-subway-sma-v4.svg",
    license: "self-drawn",
    licenseStatus: "confirmed",
    commercialUseAllowed: true,
    attributionRequired: false,
  },
  slugToSuffix: {
    "1": "1호선", "2": "2호선", "3": "3호선", "4": "4호선", "5": "5호선",
    "6": "6호선", "7": "7호선", "8": "8호선", "9": "9호선",
    "airport-railroad": "공항",
    "gyeongui-jungang": "경의중앙",
    "gyeongchun": "경춘",
    "suin-bundang": "수인분당",
    "shinbundang": "신분당",
    "gyeonggang": "경강",
    "seohae": "서해선",
    "incheon-1": "인천1호선",
    "incheon-2": "인천2호선",
    "uijeongbu-lrt": "의정부",
    "everline": "에버라인",
    "ui-sinseol": "우이신설",
    "gimpo-goldline": "김포골드라인",
    "sillim": "신림선",
    "gtx-a": "GTX-A",
  },
  colorToSlug: {
    "#004a85": "1", "#00a23f": "2", "#ed6c00": "3", "#009bce": "4", "#794698": "5",
    "#7c4932": "6", "#6e7e31": "7", "#d11d70": "8", "#a49d87": "9",
    "#6ac2b3": "gyeongui-jungang", "#eca300": "suin-bundang", "#b81b30": "shinbundang",
    "#b4c7e7": "incheon-1", "#0079ac": "airport-railroad", "#bacc50": "ui-sinseol",
    "#5e7dbb": "sillim", "#f0831e": "uijeongbu-lrt", "#44a436": "everline",
    "#f4a462": "incheon-2", "#957326": "gimpo-goldline", "#007a62": "gyeongchun",
    "#0b318f": "gyeonggang", "#5eac41": "seohae", "#9a6292": "gtx-a",
  },
  // data-line 없는 노드(SVG 소스 누락)의 노선 보정 — station→line 멤버십으로 확정.
  missingLineHint: {
    "영종": "airport-railroad",
    "운서": "airport-railroad",
    "청라국제도시": "airport-railroad",
  },
  // 마커 없는 역(라벨만 존재)을 라벨 중심으로 배정.
  // v1 도식 안산선 꼬리 5역(안산·고잔·신길온천·오이도·중앙)은 실제로는 마커가
  // 있었으나 오너 SVG의 정왕/한대앞 캡슐 복붙 재사용으로 data-station이 갱신되지
  // 않아 "마커 없음"으로 오판됐던 것 — 속성 독립 재감사(2026-07-20)로 원인이
  // 밝혀져 SVG를 직접 교정했으므로 이 폴백은 더 이상 필요 없다(빈 배열 유지).
  markerlessFallback: [],
  // 도식 미수록이지만 카탈로그에는 유지되는 명시 예외(위상 보존 게이트).
  topologyExceptions: [
    { name: "도라산", reason: "오너 도식이 임진강까지 수록·도라산 제외(설계 결정). 카탈로그 유지(역 검색 가능)." },
  ],
  // 정합 대상에서 제외할 SVG data-station(범례 등). 수도권 도식엔 없음.
  excludedStations: [],
  // 한 station_id에 기본 상한(100px)을 넘게 떨어진 노드가 복수 배정 후보로 잡히는
  // 알려진 예외. **실측(2026-07-26, v4 geometry + 재생성 팩): 복수 후보 역 0건 ·
  // 최대 spread 0.0px** — 예외가 필요 없다. 새로 생기면 파이프라인이 실패해야 한다
  // (#2068 김포공항 픽토그램 오배정 방어).
  scatteredCandidateExceptions: [],
  // 동명 별개역 목록(위 SEOUL_DISTINCT_SAME_NAME_STATIONS)을 설정 객체로도
  // 노출한다 — 카탈로그의 실제 권역 내 중복 이름 집합과 일치하는지 테스트가
  // 팩 SELECT로 대조해 목록 갱신 누락을 자동 방어한다.
  distinctSameNameStations: SEOUL_DISTINCT_SAME_NAME_STATIONS,
  // canonical 정합 규칙(#1950 대조표): SVG 이름 → {name, disambiguateByLine?}.
  //
  // #2068 v4 실측 표기 변경(v2 → v4):
  //   - `신촌:2호선`/`신촌:경의중앙선` → `신촌`/`신촌(경의중앙선)`
  //   - `양평:5호선`/`양평:경의중앙선` → 둘 다 `양평`
  //   - `이수` → `총신대입구(이수)`
  //   - `시청.용인대`/`전대.에버랜드` → `시청·용인대`/`전대·에버랜드`(가운뎃점)
  // 콜론 표기가 사라져 신촌·양평의 동명 별개역 힌트가 data-station에서 없어졌다.
  // 두 역은 카탈로그에 각각 2행(2호선/경의중앙, 5호선/경의중앙)으로 실재하는
  // **별개 물리역**이라 broadcast(같은 좌표를 두 station_id에 복사)하면 신원이
  // 뒤섞인다. SEOUL_DISTINCT_SAME_NAME_STATIONS 명시 목록으로 노선 1:1 해소를
  // 유지한다(v2 콜론 규칙과 동일 의미). 두 노드 모두 data-line을 정확히 들고
  // 있어 해소가 결정적이다.
  canonicalRules: (svgName) => {
    // v2 콜론 표기 하위호환(구 geometry 재처리·회귀 대조용).
    const colon = svgName.indexOf(":");
    if (colon >= 0) return { name: svgName.slice(0, colon), disambiguateByLine: true };
    // 가운뎃점(U+00B7)을 카탈로그 표기(마침표)로 정규화 — 시청·용인대·전대·에버랜드.
    let name = svgName.replace(/·/g, ".");
    // 괄호 부제 제거 — 총신대입구(이수)→총신대입구, 신촌(경의중앙선)→신촌.
    name = name.replace(/\s*\([^)]*\)\s*$/, "").trim();
    if (name === "하남검단산") name = "하남검단산역";
    if (name === "이수") name = "총신대입구";
    if (SEOUL_DISTINCT_SAME_NAME_STATIONS.has(name)) {
      return { name, disambiguateByLine: true };
    }
    return { name };
  },
  // #2068 오너 기준본 전환(2026-07-19): 오너 v2.1은 viewBox 3800×3020(구 v2는
  // 2400×1860)으로 캔버스 자체가 커져, 구 하드코딩(340~1720)이 실제 콘텐츠
  // 대부분(역 y 실측 범위 334~2852)을 "범례 밖"으로 오판해 5개 노선의 stroke를
  // 통째로 누락시켰다(build-sma-tracks.mjs 실측 — "SVG stroke 없음" 경고).
  // 새 캔버스의 실제 역 y 범위(334~2852)에 여유를 두고 재설정한다.
  contentBand: { minY: 300, maxY: 2900 },
};

// ── 부산(busan): #2011 2단계. 오너 자작 easy-subway-busan-v3(#2068 재제작본). ──
// 문법 차이(수도권 대비): viewBox 12000×7040, route-line은 노선당 단일 <polyline>
// (수도권은 파편 stroke 다수), data-line 슬러그가 line1..line4/donghae/bgl,
// lines.name_ko 접두가 "부산"이나 route_map_positions.region은 "부산권"(불일치),
// 환승 노드는 data-line 빈값(멤버십으로 broadcast), 범례 노드 1개 존재.
const BUSAN = {
  id: "busan",
  regionKey: "부산권",
  lineNamePrefix: "부산",
  svgSource: {
    sourceId: "owner-self-drawn-sma-schematic",
    sourceName: "오너 자작 부산 8선형 정본 도식",
    sourceUrl: "internal:route-map/route-map-defs/svg-sources/easy-subway-busan-v3.svg",
    license: "self-drawn",
    licenseStatus: "confirmed",
    commercialUseAllowed: true,
    attributionRequired: false,
  },
  slugToSuffix: {
    line1: "1호선", line2: "2호선", line3: "3호선", line4: "4호선",
    donghae: "동해",
    bgl: "부산김해경전철",
  },
  colorToSlug: {
    "#f68712": "line1", "#a6da53": "line2", "#d49329": "line3",
    "#7189c5": "line4", "#1c63b7": "donghae", "#854eac": "bgl",
  },
  // 부산 도식은 data-line 없는 환승역을 멤버십으로 해소하므로 힌트 불필요.
  missingLineHint: {},
  markerlessFallback: [],
  // 부산 카탈로그는 도식과 위상 일치(누락 없음). 예외 없음.
  topologyExceptions: [],
  // 범례 노드(data-station="범례")는 카탈로그 역이 아니므로 정합 대상에서 제외.
  excludedStations: ["범례"],
  // #2068 산발 후보 게이트 명시 예외(선재 결함 2건 — **원인이 서로 다르다**).
  // 둘 다 origin/main에도 있던 선재 상태이고, 근본 해소는 #2068 범위 밖이라
  // 여기서는 명시 면제만 한다(팩 실측 근거는 각 reason 참조).
  //
  //  · 동래 — 진짜 카탈로그 오병합. `station-dbfe9e072d98` **하나**가 1호선·
  //    4호선·동해 3노선을 다 물고 있는데, 도식은 1·4호선 동래와 동해선 동래를
  //    660.9px 떨어진 별개 노드로 그린다. 해소하려면 카탈로그를 두 역으로
  //    분리해야 한다.
  //  · 부전 — 오병합이 **아니다**. 카탈로그는 이미 1호선 `station-9acc028dded4`와
  //    동해 `station-ee8407a487c2`로 분리돼 있다. 문제는 BUSAN에 노선 1:1 해소
  //    (disambiguateByLine)가 없어 resolveStationIds가 이름만으로 두 id를 모두
  //    반환하고, 도식의 두 노드가 서로의 id까지 broadcast한다는 것이다 — 문서
  //    순서상 동해선 노드가 먼저 배정돼 1호선 부전까지 (5817,3938)로 끌려간다
  //    (1호선 실제 노드는 (6233,4157) — 470.1px 어긋남). seoul의
  //    distinctSameNameStations/disambiguateByLine 기법을 부산에도 적용하면
  //    해소되지만, 부산 팩 좌표가 바뀌므로 별도 이슈로 뺀다.
  //
  // maxSpreadPx는 "알려진 결함이 만드는 spread"의 실측값에 소폭 여유를 둔 상한이다.
  // 면제를 무제한으로 두면 그 역에서 김포공항형 새 오배정이 생겨도 게이트가 침묵한다.
  // 실측(2026-07-26, busan v3 geometry): 동래 660.9px · 부전 470.1px(2 id 동일).
  // 그 밖의 부산 복수 후보는 공항 2.2px 1건으로 기본 상한 안이라 예외가 필요 없다.
  scatteredCandidateExceptions: [
    {
      name: "동래",
      maxSpreadPx: 700,
      reason:
        "카탈로그 오병합: 단일 station_id(station-dbfe9e072d98)가 1·4호선·동해를 " +
        "모두 물고 있고 도식은 660.9px 떨어진 별개 노드 2개로 그린다. 카탈로그 분리 필요(후속).",
    },
    {
      name: "부전",
      maxSpreadPx: 500,
      reason:
        "노선 1:1 해소 부재로 인한 broadcast: 카탈로그는 1호선(station-9acc028dded4)/" +
        "동해(station-ee8407a487c2)로 이미 분리돼 있으나, BUSAN에 disambiguateByLine이 " +
        "없어 두 노드가 두 id에 모두 broadcast돼 1호선 부전이 동해선 좌표로 470.1px " +
        "끌려간다(선재). seoul식 동명 별개역 해소 적용이 정답 — 부산 팩 좌표가 바뀌므로 후속.",
    },
  ],
  // canonical 정합 규칙(부산 카탈로그 실측 6건):
  //   벡스코 (시립미술관)→벡스코, 괘법 르네시떼→괘법르네시떼,
  //   서부산 유통지구→서부산유통지구, 부산역→부산, 가운뎃점(·)→마침표(.).
  canonicalRules: (svgName) => {
    // 괄호 부제 제거: "벡스코 (시립미술관)" → "벡스코".
    let name = svgName.replace(/\s*\([^)]*\)\s*$/, "").trim();
    // 가운뎃점(U+00B7)을 카탈로그 표기(마침표)로 정규화.
    name = name.replace(/·/g, ".");
    // 내부 공백 제거(괘법 르네시떼·서부산 유통지구 등 도식이 띄어쓴 복합역명).
    name = name.replace(/\s+/g, "");
    // 역 접미 제거(부산역→부산). 카탈로그는 접미 없는 표기.
    if (name.length > 1 && name.endsWith("역")) name = name.slice(0, -1);
    // #2068 좌천: 1호선·동해선 좌천은 별개 물리역(오병합 분리 대상). 도식이 두
    // 노드를 각자 그리므로 노선 힌트로 각 station_id에 1:1 정합한다(broadcast 금지).
    if (name === "좌천") return { name, disambiguateByLine: true };
    return { name };
  },
  // 범례 노선 swatch(medY≈216, len ~107px)는 콘텐츠 밴드 밖으로 배제한다. 전면
  // 재설계(viewBox 12000×7040) 실 노선 polyline의 medY는 2116~4780이므로 minY 300
  // (범례 216 초과)·maxY 6000이면 범례만 걸러지고 6개 노선 stroke가 전부 포함된다.
  contentBand: { minY: 300, maxY: 6000 },
};

// ── 대구(daegu): #2011 3단계. 오너 자작 easy-subway-daegu-v3(#2068 재제작본). ──
// 문법 차이(수도권 대비): viewBox 4560.00×2340.00, route-line은 노선당 단일 <path>
// (route-line-1/2/3/daegyeong 그룹), data-line 슬러그가 line1..line3/daegyeong,
// lines.name_ko 접두가 "대구"이나 route_map_positions.region은 "대구권"(불일치),
// 역 노드는 부산과 동일하게 [data-node-role][data-station] g(circle/g)로 마킹되고
// 환승역은 data-line 빈값(멤버십 broadcast), 범례 노드(data-station="범례") 1개 존재.
// 색↔슬러그는 도식 data-line-color 실측(line1=#ee265b·line2=#00b794·line3=#ffc513·
// daegyeong=#0066b3). 대경선은 #1951 확정 4노선의 하나.
const DAEGU = {
  id: "daegu",
  regionKey: "대구권",
  lineNamePrefix: "대구",
  svgSource: {
    sourceId: "owner-self-drawn-sma-schematic",
    sourceName: "오너 자작 대구 8선형 정본 도식",
    sourceUrl: "internal:route-map/route-map-defs/svg-sources/easy-subway-daegu-v3.svg",
    license: "self-drawn",
    licenseStatus: "confirmed",
    commercialUseAllowed: true,
    attributionRequired: false,
  },
  slugToSuffix: {
    line1: "1호선", line2: "2호선", line3: "3호선",
    daegyeong: "대경선",
  },
  colorToSlug: {
    "#ee265b": "line1", "#00b794": "line2", "#ffc513": "line3", "#0066b3": "daegyeong",
  },
  // 대구 도식은 data-line 없는 환승역을 멤버십으로 해소하므로 힌트 불필요.
  missingLineHint: {},
  markerlessFallback: [],
  // 대구 카탈로그는 도식과 위상 일치(누락 없음). 예외 없음.
  topologyExceptions: [],
  // 정합 대상에서 제외할 SVG data-station:
  //   범례(비역 노드)만 제외. 북삼(대경선 개통역)은 #2019에서 카탈로그에 정식
  //   반영(왜관↔사곡 사이 seq 6)했으므로 이제 도식 노드가 카탈로그와 매핑된다.
  excludedStations: ["범례"],
  // 산발 후보 게이트 명시 예외. **실측(2026-07-26, daegu v3 geometry): 복수 후보 역 0건 ·
  // 최대 spread 0.0px** — 예외 없음. 소비처 `?? []` 폴백에 기대지 않고 권역마다
  // 명시해 게이트 커버리지를 균일하게 둔다.
  scatteredCandidateExceptions: [],
  // canonical 정합 규칙(대구 카탈로그 실측): 괄호 부제 제거(부호(경일대·호산대)→부호,
  // 하양(대구가톨릭대)→하양), 서대구→서대구역.
  canonicalRules: (svgName) => {
    let name = svgName.replace(/\s*\([^)]*\)\s*$/, "").trim();
    if (name === "서대구") name = "서대구역";
    return { name };
  },
  // 범례 노선 swatch(medY≈166, len 42px)를 콘텐츠 밴드 밖으로 배제한다. 실 노선
  // path의 medY는 820~1193이므로 minY 300이면 범례 swatch만 걸러진다.
  contentBand: { minY: 300, maxY: 1800 },
};

// ── 대전(daejeon): #2011 3단계. 오너 자작 easy-subway-daejeon-v3(#2068 재제작본). ──
// 문법 차이(수도권·부산·대구 대비): 역 마커 g(station-symbol)는 역 정체(이름)를
// data-official-station-name으로만 들고, 정합에 쓰는 역 정체와 노드 좌표는 <text>
// station-label의 data-full-official-name·data-node-x·data-node-y에 실린다.
// 추출기의 라벨 앵커 노드 소스(data-node-x/y+data-full-official-name)가 이를
// stationNodes로 승격한다.
//
// #2068 v3 재제작 실측(v1 대비):
//   - `data-station` 전면 제거. 역 심벌 id가 station-node-* → station-symbol-line{N}-{id}.
//   - 카탈로그 밖 노선(도시철도 순환2호선 data-line="2"·충청권 광역철도 regional)을
//     도식에서 통째로 걷어냈다 — construction/planned 마크업 0건이라 nodeFilter의
//     미개통 배제 분기는 발동하지 않는다(v1 호환용으로 유지).
//   - 22개 운영역 전부가 data-line="1"·data-status="active" 라벨 단일 갈래로 실린다
//     (v1의 "1호선 <역명> | 2호선 …" 복합 표기 환승 라벨 5건은 소멸). canonicalRules는
//     v1 geometry 재처리 호환을 위해 복합 표기 분해를 그대로 남긴다.
//   - 지도 본문이 <g id="map-content-positioned-layer" transform="translate(0 88)">로
//     한 겹 감싸였다(상단 안내 영역 겹침 회피). 추출기는 CTM으로 자연 흡수하고,
//     컴파일러는 compile-basemap-vec.mjs의 MAP_WRAPPER_LAYER_IDS로 흡수한다.
const DAEJEON = {
  id: "daejeon",
  regionKey: "대전권",
  lineNamePrefix: "대전",
  svgSource: {
    sourceId: "owner-self-drawn-sma-schematic",
    sourceName: "오너 자작 대전 8선형 정본 도식",
    sourceUrl: "internal:route-map/route-map-defs/svg-sources/easy-subway-daejeon-v3.svg",
    license: "self-drawn",
    licenseStatus: "confirmed",
    commercialUseAllowed: true,
    attributionRequired: false,
  },
  slugToSuffix: {
    "1": "1호선",
  },
  // 대전 1호선 색(#00975a)만 카탈로그 대상. 2호선·광역철도 색은 배제(build-sma-tracks
  // 는 colorToSlug 미등록 stroke를 자연 배제한다).
  colorToSlug: {
    "#00975a": "1",
  },
  missingLineHint: {},
  markerlessFallback: [],
  topologyExceptions: [],
  // 산발 후보 게이트 명시 예외. **실측(2026-07-26, daejeon v1 geometry): 복수 후보 역 0건 ·
  // 최대 spread 0.0px** — 예외 없음. 소비처 `?? []` 폴백에 기대지 않고 권역마다
  // 명시해 게이트 커버리지를 균일하게 둔다.
  scatteredCandidateExceptions: [],
  excludedStations: [],
  // 1호선 실역만 정합 대상으로 남긴다. (a) data-line=1·active, (b) data-line=transfer·
  // active이며 이름이 "1호선 "으로 시작(1호선 환승역). 나머지(2호선·광역철도·미개통·
  // 1호선 미개통 식장산)는 fail-closed로 배제한다(카탈로그 미수록).
  // v3는 22역 전부 (a)에 해당하고 미개통 마크업이 0건이라 (b)·status 분기가 발동하지
  // 않는다 — v1 geometry 재처리 호환을 위해 그대로 남긴다.
  nodeFilter: (node) => {
    const status = node.dataStatus || "";
    const line = node.dataLine || "";
    const name = node.dataStation || "";
    if (status !== "active") return false;
    if (line === "1") return true;
    if (line === "transfer" && /^1호선\s/.test(name)) return true;
    return false;
  },
  // canonical 정합 규칙(대전 카탈로그 실측):
  //   - 환승 복합 표기 "1호선 대전역 | 2호선 …" → 파이프 앞의 "1호선 " 뒤 토큰만.
  //   - 괄호 부제 제거, 대전역→대전.
  canonicalRules: (svgName) => {
    let name = svgName;
    // 환승 복합 표기: 파이프 이전 segment에서 "1호선 " 접두 제거.
    const pipe = name.indexOf("|");
    if (pipe >= 0) name = name.slice(0, pipe).trim();
    name = name.replace(/^1호선\s+/, "").trim();
    // 괄호 부제 제거.
    name = name.replace(/\s*\([^)]*\)\s*$/, "").trim();
    // 역 접미 정규화(대전역→대전). 카탈로그는 접미 없는 표기.
    if (name.length > 1 && name.endsWith("역")) name = name.slice(0, -1);
    return { name };
  },
  // 대전 도식 노드 좌표(data-node-x/y)는 콘텐츠 밴드 제약이 track 추출에만 적용된다.
  // #2068 v3 실측 교정: 상단 안내 카드(top-route-line-explanation-layer)의 1호선
  // 색 범례 stroke가 medY 158로 그려져 minY:0이면 buildTracksDoc이 그것을 1호선
  // track으로 삼는다(v1은 같은 범례 stroke 3개 + 라벨 장식 2개가 실제로 팩
  // route_map_line_tracks에 5행 중 4행으로 들어가 있었다 — 선재 결함). 실 노선
  // path의 medY는 1438이므로 광주(minY 340)·수도권(300)과 같은 하한을 두면 범례만
  // 걸러지고 본선은 그대로 남는다.
  contentBand: { minY: 300, maxY: 1800 },
};

// ── 광주(gwangju): #2011 3단계. 오너 자작 easy-subway-gwangju-v3(#2068 재제작본). ──
// 라이선스 특례: 기존 CC BY-SA 2.0 KR(attribution 필수) 데이터가 자작 도식으로
// 대체되므로 attribution을 자작 기준으로 전환한다.
//
// #2068 v3 재제작 실측(v1 대비): 대전 v3와 같은 규격(easy_subway_sma_v4 패밀리)으로
// 통일됐다.
//   - v1은 역 정체(코드+이름)를 label group <g data-label-role data-station(코드)
//     data-station-name(이름)>에 실어 추출기의 "라벨 그룹 노드 소스"가 그룹 bbox
//     중심을 노드 좌표로 승격했다. v3는 `data-station` 전면 제거 + <text> 라벨의
//     data-full-official-name·data-node-x·data-node-y로 통일 — 대전과 같은 "라벨
//     앵커 노드 소스"를 타고, 좌표가 bbox 근사가 아니라 오너가 명시한 노드 좌표다.
//   - 역 심벌 id가 station-node-* → station-symbol-line{N}-{id}, 코드는
//     data-station-code(100~119).
//   - 카탈로그 밖 2호선(phase1/2/3)을 도식에서 통째로 걷어냈다 — nodeFilter의
//     1xx 필터는 전 노드를 통과시킨다(계약은 그대로 유지).
//   - KTX·SRT 마크가 rail-transfer-layer(v1은 빈 껍데기)에서 station-name-labels-layer
//     안 <g class="rail-service-marks" data-services data-station-name>으로 이동.
const GWANGJU = {
  id: "gwangju",
  regionKey: "광주권",
  lineNamePrefix: "광주",
  svgSource: {
    sourceId: "owner-self-drawn-sma-schematic",
    sourceName: "오너 자작 광주 8선형 정본 도식",
    sourceUrl: "internal:route-map/route-map-defs/svg-sources/easy-subway-gwangju-v3.svg",
    license: "self-drawn",
    licenseStatus: "confirmed",
    commercialUseAllowed: true,
    attributionRequired: false,
  },
  slugToSuffix: {
    "1": "1호선",
  },
  // 광주 1호선 색(#009088)만 카탈로그 대상. 2호선(phase1/2/3) 색은 배제.
  colorToSlug: {
    "#009088": "1",
  },
  missingLineHint: {},
  markerlessFallback: [],
  topologyExceptions: [],
  // 산발 후보 게이트 명시 예외. **실측(2026-07-26, gwangju v1 geometry): 복수 후보 역 0건 ·
  // 최대 spread 0.0px** — 예외 없음. 소비처 `?? []` 폴백에 기대지 않고 권역마다
  // 명시해 게이트 커버리지를 균일하게 둔다.
  scatteredCandidateExceptions: [],
  excludedStations: [],
  // 1호선 실역만 정합 대상으로 남긴다: 라벨 코드(data-station-code)가 1xx(순수
  // 1호선) 또는 1xx-2xx(1호선-2호선 복합 코드 환승: v1의 남광주 103-214·상무
  // 113-203)인 노드. 2xx(2호선 전용)·transfer-capsule(모두 2xx)은 fail-closed로
  // 배제(카탈로그 미수록). v3는 2호선이 도식에서 빠져 전 노드(100~119)가 통과한다.
  nodeFilter: (node) => {
    const code = node.dataStationCode || "";
    return /^1\d\d($|-)/.test(code);
  },
  // canonical 정합 규칙(광주 카탈로그 실측):
  //   가운뎃점(·) 제거(학동·증심사입구→학동증심사입구·금남로4가 등 그대로),
  //   광주송정→광주송정역, 괄호 부제 제거(김대중컨벤션센터(마륵)→김대중컨벤션센터,
  //   문화전당(구도청)→문화전당).
  // #2068: compile-basemap-vec.mjs의 오너 라벨 sidecar 키도 이 규칙을 그대로 쓴다
  // (OWNER_LABEL_CANONICAL_RULES) — v3가 라벨 신원을 data-full-official-name으로
  // 통일해, 대전 규칙으로 뽑으면 광주송정역·학동증심사입구 2역이 카탈로그와 어긋난다.
  canonicalRules: (svgName) => {
    let name = svgName.replace(/·/g, "").trim();
    if (name === "광주송정") name = "광주송정역";
    name = name.replace(/\s*\([^)]*\)\s*$/, "").trim();
    return { name };
  },
  // 범례("노선 색상 안내") 스와치가 1호선 색(#009088) horizontal stroke(medY≈158)이라
  // minY:0이면 buildTracksDoc이 범례를 1호선 track에 섞는다(실측: 스와치 M 260 158 L 302 158이
  // 별도 track으로 산출됨). 범례 카드는 y=[136,240], 실역 콘텐츠는 y=[930,1210]이므로
  // minY를 340으로 올려 범례를 배제한다(수도권과 동일 하한).
  contentBand: { minY: 340, maxY: 1800 },
};

const REGION_CONFIGS = { seoul: SEOUL, busan: BUSAN, daegu: DAEGU, daejeon: DAEJEON, gwangju: GWANGJU };
// regionKey(예: "부산권")로도 조회 가능.
const BY_REGION_KEY = new Map(Object.values(REGION_CONFIGS).map((c) => [c.regionKey, c]));

export function getRegionConfig(idOrRegionKey) {
  const config = REGION_CONFIGS[idOrRegionKey] || BY_REGION_KEY.get(idOrRegionKey);
  if (!config) {
    const known = Object.keys(REGION_CONFIGS).join(", ");
    throw new Error(`알 수 없는 권역: ${idOrRegionKey} (지원: ${known} 또는 regionKey)`);
  }
  return config;
}

export { SEOUL, BUSAN, DAEGU, DAEJEON, GWANGJU, REGION_CONFIGS };
