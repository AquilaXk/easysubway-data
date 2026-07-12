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

// ── 대구(daegu): #2011 3단계. 오너 자작 easy-subway-daegu-v1. ─────────────────
// 문법 차이(수도권 대비): viewBox 2400×1800, route-line은 노선당 단일 <path>
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
    sourceUrl: "internal:route-map/route-map-defs/svg-sources/easy-subway-daegu-v1.svg",
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

// ── 대전(daejeon): #2011 3단계. 오너 자작 easy-subway-daejeon-v1. ─────────────
// 문법 차이(수도권·부산·대구 대비): 역 마커 g(station-symbol)는 data-node-role
// 없이 data-line·data-station-code만 들고, 역 정체(이름)와 노드 좌표는 <text>
// station-label의 data-full-official-name·data-node-x·data-node-y에 실린다.
// 추출기의 라벨 앵커 노드 소스(data-node-x/y+data-full-official-name)가 이를
// stationNodes로 승격한다. 도식은 카탈로그 밖 노선까지 그린다: 대전 2호선(도시철도
// 순환2호선, data-line="2", 전부 construction), 충청권 광역철도(regional,
// construction), 미개통 라벨(construction/planned). 카탈로그는 대전 1호선 1개
// (22역)뿐이므로 nodeFilter로 1호선 실역만 남긴다.
// 1호선 역은 두 갈래로 실린다: (a) data-line="1"·active 라벨 17개, (b) 환승역은
// data-line="transfer"·active 라벨로 그려지며 이름이 "1호선 <역명> | 2호선 …"
// 복합 표기다(5개: 대전역·대동·서대전네거리·정부청사·유성온천). canonicalRules가
// 복합 표기에서 1호선 역명을 뽑고 카탈로그 표기로 정규화(대전역→대전 등).
const DAEJEON = {
  id: "daejeon",
  regionKey: "대전권",
  lineNamePrefix: "대전",
  svgSource: {
    sourceId: "owner-self-drawn-sma-schematic",
    sourceName: "오너 자작 대전 8선형 정본 도식",
    sourceUrl: "internal:route-map/route-map-defs/svg-sources/easy-subway-daejeon-v1.svg",
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
  excludedStations: [],
  // 1호선 실역만 정합 대상으로 남긴다. (a) data-line=1·active, (b) data-line=transfer·
  // active이며 이름이 "1호선 "으로 시작(1호선 환승역). 나머지(2호선·광역철도·미개통·
  // 1호선 미개통 식장산)는 fail-closed로 배제한다(카탈로그 미수록).
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
  // 1호선 stroke의 medY 범위를 포함하도록 넉넉히 둔다.
  contentBand: { minY: 0, maxY: 1800 },
};

// ── 광주(gwangju): #2011 3단계. 오너 자작 easy-subway-gwangju-v1. ─────────────
// 문법 차이(수도권·부산·대구·대전 대비): 역 정체(코드+이름)가 label group
// <g id="station-label-group-NNN" data-label-role data-station(코드) data-station-name(이름)>에
// 실리고, 마커 dot(circle.station-node)은 정체 없이 stroke 색만 든다. 추출기의
// 라벨 그룹 노드 소스(g[data-label-role])가 라벨 그룹 bbox 중심을 노드 좌표로
// 승격한다(광주에만 존재하는 선택자라 타 권역 무영향). 코드 1xx=1호선, 2xx=2호선.
// 카탈로그는 광주 1호선 1개(20역)뿐이라 nodeFilter로 코드 1xx(또는 1호선-2호선
// 복합 코드 1xx-2xx 환승)만 남긴다. 라이선스 특례: 기존 CC BY-SA 2.0 KR(attribution
// 필수) 데이터가 자작 도식으로 대체되므로 attribution을 자작 기준으로 전환한다.
const GWANGJU = {
  id: "gwangju",
  regionKey: "광주권",
  lineNamePrefix: "광주",
  svgSource: {
    sourceId: "owner-self-drawn-sma-schematic",
    sourceName: "오너 자작 광주 8선형 정본 도식",
    sourceUrl: "internal:route-map/route-map-defs/svg-sources/easy-subway-gwangju-v1.svg",
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
  excludedStations: [],
  // 1호선 실역만 정합 대상으로 남긴다: label group 코드가 1xx(순수 1호선) 또는
  // 1xx-2xx(1호선-2호선 복합 코드 환승: 남광주 103-214·상무 113-203)인 노드.
  // 2xx(2호선 전용)·transfer-capsule(모두 2xx)은 fail-closed로 배제(카탈로그 미수록).
  nodeFilter: (node) => {
    const code = node.dataStationCode || "";
    return /^1\d\d($|-)/.test(code);
  },
  // canonical 정합 규칙(광주 카탈로그 실측):
  //   가운뎃점(·) 제거(학동·증심사입구→학동증심사입구·금남로4가 등 그대로),
  //   광주송정→광주송정역, 괄호 부제 제거.
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
