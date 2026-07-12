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

// ── 수도권(seoul): #1950/#2011 정본. 기존 하드코딩과 동일. ─────────────────────
const SEOUL = {
  id: "seoul",
  regionKey: "수도권",
  lineNamePrefix: "수도권",
  svgSource: {
    sourceId: "owner-self-drawn-sma-schematic",
    sourceName: "오너 자작 수도권 8선형 정본 도식",
    sourceUrl: "internal:route-map/route-map-defs/svg-sources/easy-subway-sma-v2.svg",
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
  // 마커 없는 역(라벨만 존재)을 라벨 중심으로 배정(v1 도식 안산선 꼬리 누락 보정).
  markerlessFallback: ["안산", "고잔", "신길온천", "오이도", "중앙"],
  // 도식 미수록이지만 카탈로그에는 유지되는 명시 예외(위상 보존 게이트).
  topologyExceptions: [
    { name: "도라산", reason: "오너 도식이 임진강까지 수록·도라산 제외(설계 결정). 카탈로그 유지(역 검색 가능)." },
  ],
  // 정합 대상에서 제외할 SVG data-station(범례 등). 수도권 도식엔 없음.
  excludedStations: [],
  // canonical 정합 규칙(#1950 대조표): SVG 이름 → {name, disambiguateByLine?}.
  canonicalRules: (svgName) => {
    const colon = svgName.indexOf(":");
    if (colon >= 0) return { name: svgName.slice(0, colon), disambiguateByLine: true };
    if (svgName === "하남검단산") return { name: "하남검단산역" };
    if (svgName === "이수") return { name: "총신대입구" };
    return { name: svgName };
  },
  contentBand: { minY: 340, maxY: 1720 },
};

// ── 부산(busan): #2011 2단계. 오너 자작 easy-subway-busan-v1. ─────────────────
// 문법 차이(수도권 대비): viewBox 4000×2700, route-line은 노선당 단일 <polyline>
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
    sourceUrl: "internal:route-map/route-map-defs/svg-sources/easy-subway-busan-v1.svg",
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
    return { name };
  },
  // 범례 노선 swatch(medY≈166, len 42px)는 콘텐츠 밴드 밖으로 배제한다. 실 노선
  // polyline의 medY는 420~1644이므로 minY 300이면 범례만 걸러진다.
  contentBand: { minY: 300, maxY: 2700 },
};

const REGION_CONFIGS = { seoul: SEOUL, busan: BUSAN };
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

export { SEOUL, BUSAN, REGION_CONFIGS };
