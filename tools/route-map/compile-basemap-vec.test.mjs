import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  extractOwnerLabels,
  extractRailTransferChipObstacles,
  extractServiceTagObstacles,
  markLineTerminalBadgeEntries,
  matchingGroupEnd,
  normalizeSvgForCompile,
  parseSvgNumbers,
} from "./compile-basemap-vec.mjs";

test("컴파일 전에 단순 class 스타일을 SVG 속성으로 인라인한다", () => {
  const normalized = normalizeSvgForCompile(`
    <svg>
      <style>
        .route-line { fill:none; stroke-width:8px; }
        .station-name { fill:#14293D; font-size:12.5px; font-weight:700; }
        .station-name.is-long { font-size:11.6px; }
      </style>
      <g id="header-title"><text>통합 노선도</text></g>
      <g id="map-card-clipped-content-layer">
        <g id="main-map-scaled-layer" transform="translate(70 138) scale(0.455)">
        <g id="route-lines-layer">
          <polyline class="route-line" points="0,0 10,10" />
          <g data-state="construction">
            <path class="route-line" d="M 0 0 L 20 20" />
          </g>
          <polyline class="route-line" data-line="line2-phase1" points="0,0 30,30" />
        </g>
        <text class="station-name is-long">테스트역</text>
        </g>
      </g>
    </svg>
  `);

  assert.doesNotMatch(normalized, /통합 노선도/);
  assert.match(normalized, /route-lines-layer/);
  assert.match(normalized, /transform="translate\(70 138\) scale\(0\.455\)"/);
  assert.doesNotMatch(normalized, /construction|line2-phase1|20 20|30,30/);
  assert.match(normalized, /<polyline[^>]*fill="none"[^>]*stroke-width="8px"/);
  assert.match(
    normalized,
    /<polyline[^>]*stroke-linecap="round"[^>]*stroke-linejoin="round"/,
  );
  assert.doesNotMatch(normalized, /테스트역|<text\b/);
  assert.doesNotMatch(normalized, /\/\s+[\w-]+="/);
});

// #2068 오너 v3 반입 회귀: 빈 레이어를 자기폐쇄 태그로 마감한 SVG(busan v3의
// service-tags-layer)에서 extractGroup의 depth 카운터가 다음 형제 레이어를 삼켜
// allow-list 밖 레이어(역명 라벨)가 바탕층에 딸려 들어갔다.
test("자기폐쇄 태그로 마감된 빈 레이어가 뒤따르는 형제 레이어를 삼키지 않는다", () => {
  const normalized = normalizeSvgForCompile(`
    <svg>
      <g id="route-lines-layer">
        <polyline class="route-line" points="0,0 10,10" />
      </g>
      <g id="service-tags-layer" class="render-layer service-tag-layer" />
      <g id="station-name-labels-layer">
        <text id="station-label-test">테스트역</text>
      </g>
      <g id="legend-layer"><text id="legend-caption">범례캡션</text></g>
    </svg>
  `);

  assert.match(normalized, /id="route-lines-layer"/);
  assert.match(normalized, /id="service-tags-layer"/);
  // #2068 SVG 충실도(2026-07-26 오너 결정): 역명 라벨은 이제 바탕층에 굽는다.
  // 자기폐쇄 빈 레이어가 뒤 형제를 삼키지 않는지는 "라벨 레이어가 정확히 한 번만
  // 들어오는지"로 확인한다 — 삼키면 service-tags-layer 슬라이스에도 딸려 들어와
  // 두 번 나온다.
  assert.equal(
    (normalized.match(/id="station-name-labels-layer"/g) ?? []).length,
    1,
  );
  assert.match(normalized, /테스트역/);
  // 장식(범례)은 계약대로 반입되지 않는다.
  assert.doesNotMatch(normalized, /legend-layer|범례캡션/);
});

test("5권역 basemap에는 노선·기존 역 심벌만 남기고 미개통 노선을 제외한다", () => {
  const sources = path.join(import.meta.dirname, "route-map-defs/svg-sources");
  const files = [
    "easy-subway-sma-v4.svg",
    "easy-subway-busan-v3.svg",
    "easy-subway-daegu-v3.svg",
    "easy-subway-daejeon-v3.svg",
    "easy-subway-gwangju-v3.svg",
  ];

  for (const file of files) {
    const normalized = normalizeSvgForCompile(
      readFileSync(path.join(sources, file), "utf8"),
    );
    const rendered = normalized.includes("</defs>")
      ? normalized.slice(normalized.lastIndexOf("</defs>") + 7)
      : normalized;
    assert.match(normalized, /id="route-lines-layer"/);
    assert.match(normalized, /id="station-symbols-layer"/);
    if (!/gwangju|daejeon/.test(file)) {
      assert.match(normalized, /id="transfer-station-symbols-layer"/);
    }
    // #2408: 오너 종점 칩(terminal-route-badges-layer)은 id에 "header-route-badge"
    // 를 포함(오너가 header 배지 템플릿에서 파생). 이는 정상 렌더 대상이므로
    // header 접두 substring이 아니라 header/legend "레이어" id 유입만 배제한다.
    // #2068(2026-07-26): 역명 라벨 레이어는 이제 **본문**이라 반드시 있어야 하고,
    // 캔버스 장식(헤더 바·범례·상단 설명 박스·규격 견본)은 여전히 없어야 한다.
    assert.match(rendered, /id="(?:station-name-labels-layer|station-label-group-)/);
    assert.doesNotMatch(
      rendered,
      /id="header-(?:title|line-chip|status-chip|complete-route-badges|background-pill)|id="legend-layer"|id="top-route-line-explanation-layer"|spec-library|id="route-label-badges-layer"/,
    );
    assert.doesNotMatch(rendered, /<title\b/);
  }

  // #2068 v3: 오너가 두 도식에서 미개통 노선(대전 2호선 트램·충청권 광역철도,
  // 광주 2호선)을 통째로 걷어냈다 — 미개통 마크업 자체가 0건이고, 그래서
  // "미개통 환승 노드에서 뽑아 오던 현재 노선 역 심벌"(v1 대전 5·광주 2)도 0건이
  // 된다(환승 캡슐 없이 실역 circle만 남는 구조).
  const daejeon = normalizeSvgForCompile(
    readFileSync(path.join(sources, "easy-subway-daejeon-v3.svg"), "utf8"),
  );
  assert.doesNotMatch(daejeon, /data-state="construction"/);
  assert.equal(
    (daejeon.match(/data-role="current-line-station"/g) ?? []).length,
    0,
  );
  // 대전 v3는 지도 본문을 map-content-positioned-layer(translate(0 88))로 감쌌다 —
  // 흡수하지 않으면 .vec가 팩 좌표보다 88px 위에 그려진다(#2068 실측).
  assert.match(
    daejeon,
    /<g id="compiled-map-coordinate-layer" transform="translate\(0 88\)"/,
  );
  // 오너가 대전역에 배치한 KTX·SRT 마크는 바탕층에 반입된다(레이어 이동 대응).
  assert.match(daejeon, /id="rail-service-marks-line1-104"/);

  const gwangju = normalizeSvgForCompile(
    readFileSync(path.join(sources, "easy-subway-gwangju-v3.svg"), "utf8"),
  );
  assert.doesNotMatch(gwangju, /data-line="line2-phase/);
  assert.equal(
    (gwangju.match(/data-role="current-line-station"/g) ?? []).length,
    0,
  );
  assert.match(gwangju, /id="rail-service-marks-line1-117"/);
  const gwangjuStations = gwangju.match(
    /id="station-symbols-layer"[\s\S]*?<\/g>/,
  )?.[0];
  assert.ok(gwangjuStations);
  for (const circle of gwangjuStations.match(/<circle\b[^>]*\/>/g) ?? []) {
    assert.match(circle, /stroke="#009088"/);
  }
});

test("scale 레이어 안 텍스트는 font-size를 k배하고 baseline central은 y를 보정한다", () => {
  const normalized = normalizeSvgForCompile(`
    <svg>
      <g id="main-map-scaled-layer" transform="translate(70 138) scale(0.455)">
        <g id="route-lines-layer"><polyline points="0,0 10,10" /></g>
        <g id="transfer-station-symbols-layer">
          <text x="100" y="200" font-size="10.3"
                dominant-baseline="central" alignment-baseline="middle">1</text>
        </g>
      </g>
    </svg>
  `);
  const text = normalized.match(/<text\b[^>]*>/)[0];
  // 10.3 × 0.455 = 4.6865
  assert.match(text, /font-size="4\.6865"/);
  // 200 + 0.35 × 10.3 = 203.605 (로컬 단위)
  assert.match(text, /\sy="203\.605"/);
  assert.doesNotMatch(text, /dominant-baseline|alignment-baseline/);
});

test("scale 없는 권역은 font-size를 유지하고 baseline y만 보정한다", () => {
  const normalized = normalizeSvgForCompile(`
    <svg>
      <g id="route-lines-layer"><polyline points="0,0 10,10" /></g>
      <g id="transfer-station-symbols-layer">
        <text x="100" y="200" font-size="10.3" dominant-baseline="central">1</text>
      </g>
    </svg>
  `);
  const text = normalized.match(/<text\b[^>]*>/)[0];
  assert.match(text, /font-size="10\.3"/); // k=1 → 불변
  assert.match(text, /\sy="203\.605"/);
  assert.doesNotMatch(text, /dominant-baseline/);
});

test("font-size의 px 접미사를 제거하고 k배 순수 숫자로 직렬화한다", () => {
  const normalized = normalizeSvgForCompile(`
    <svg>
      <g id="main-map-scaled-layer" transform="translate(0 0) scale(0.5)">
        <g id="route-lines-layer"><polyline points="0,0 10,10" /></g>
        <g id="transfer-station-symbols-layer">
          <text x="100" y="200" font-size="10.3px" dominant-baseline="central">1</text>
        </g>
      </g>
    </svg>
  `);
  const text = normalized.match(/<text\b[^>]*>/)[0];
  // 10.3 × 0.5 = 5.15, px 접미사 제거
  assert.match(text, /font-size="5\.15"/);
  assert.doesNotMatch(text, /font-size="[^"]*px"/);
});

test("class에서 인라인된 baseline 속성도 제거한다(인라인 이후 적용)", () => {
  const normalized = normalizeSvgForCompile(`
    <svg>
      <style>
        .badge-label { dominant-baseline: central; alignment-baseline: middle; }
      </style>
      <g id="main-map-scaled-layer" transform="translate(0 0) scale(0.5)">
        <g id="route-lines-layer"><polyline points="0,0 10,10" /></g>
        <g id="transfer-station-symbols-layer">
          <text class="badge-label" x="100" y="200" font-size="10">1</text>
        </g>
      </g>
    </svg>
  `);
  const text = normalized.match(/<text\b[^>]*>/)[0];
  assert.doesNotMatch(text, /dominant-baseline|alignment-baseline/);
  assert.match(text, /font-size="5"/); // 10 × 0.5
  assert.match(text, /\sy="203\.5"/); // 200 + 0.35 × 10
});

test("style형 font-size(px 있음)는 text·tspan 모두 ×k 되고 baseline 보정은 없다", () => {
  const normalized = normalizeSvgForCompile(`
    <svg>
      <g id="main-map-scaled-layer" transform="translate(0 0) scale(0.5)">
        <g id="route-lines-layer"><polyline points="0,0 10,10" /></g>
        <g id="transfer-station-symbols-layer">
          <text xml:space="preserve" style="font-weight:bold;font-size:9.37729px;line-height:0.9" x="100" y="200" id="text1"><tspan
            style="font-size:8.79121px;stroke-width:2.1978" x="100" y="200">GTX</tspan><tspan
            style="font-size:8.79121px;stroke-width:2.1978" x="100" y="208" id="tspan2">A</tspan></text>
        </g>
      </g>
    </svg>
  `);
  const outerText = normalized.match(/<text\b[^>]*id="text1"[^>]*>/)[0];
  const tspans = [...normalized.matchAll(/<tspan\b[^>]*>/g)].map((m) => m[0]);
  // 9.37729 × 0.5 = 4.688645 → roundCoord(4자리) = 4.6886
  assert.match(outerText, /font-size:4\.6886px/);
  assert.doesNotMatch(outerText, /dominant-baseline|alignment-baseline/);
  // y는 baseline 보정 대상이 아니라 불변.
  assert.match(outerText, /\sy="200"/);
  // 8.79121 × 0.5 = 4.395605 → roundCoord(4자리) = 4.3956
  assert.equal(tspans.length, 2);
  for (const tspan of tspans) {
    assert.match(tspan, /font-size:4\.3956px/);
  }
  assert.match(normalized, />GTX</);
  assert.match(normalized, />A</);
});

test("style형 font-size(px 없음)도 동일하게 ×k 스케일한다", () => {
  const normalized = normalizeSvgForCompile(`
    <svg>
      <g id="main-map-scaled-layer" transform="translate(0 0) scale(0.5)">
        <g id="route-lines-layer"><polyline points="0,0 10,10" /></g>
        <g id="transfer-station-symbols-layer">
          <text style="font-size:10" x="100" y="200">A</text>
        </g>
      </g>
    </svg>
  `);
  const text = normalized.match(/<text\b[^>]*>/)[0];
  assert.match(text, /font-size:5(?!\d)/); // 10 × 0.5, px 접미사 없음 유지
  assert.doesNotMatch(text, /font-size:5px/);
});

test("extractOwnerLabels: x/y 속성형 위치를 main-map-scaled-layer 변환(×scale+translate)해 뽑는다", () => {
  const entries = extractOwnerLabels(`
    <svg>
      <g id="main-map-scaled-layer" transform="translate(70 138) scale(0.455)">
        <text data-station="시청" data-label-role="transfer"
              font-size="28.571px" x="2196.2356" y="1493.1528"
              ><tspan x="2196.2356" y="1493.1528">시청</tspan></text>
      </g>
    </svg>
  `);
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.station, "시청");
  assert.equal(entry.role, "transfer");
  assert.equal(entry.anchor, "start"); // 미지정 → 기본값.
  // x = 70 + 2196.2356*0.455, y = 138 + 1493.1528*0.455.
  assert.equal(entry.x, Number((70 + 2196.2356 * 0.455).toFixed(4)));
  assert.equal(entry.y, Number((138 + 1493.1528 * 0.455).toFixed(4)));
  assert.equal(entry.fontSizePx, Number((28.571 * 0.455).toFixed(4)));
});

test("extractOwnerLabels: transform=translate + tspan x=0/y=0 위치형(뚝섬형)도 뽑는다", () => {
  const entries = extractOwnerLabels(`
    <svg>
      <g id="main-map-scaled-layer" transform="translate(70 138) scale(0.455)">
        <text data-station="뚝섬" data-label-role="ordinary"
              transform="translate(3100.2 1650.8)" font-size="26.374"
              ><tspan x="0" y="0">뚝섬</tspan></text>
      </g>
    </svg>
  `);
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.station, "뚝섬");
  assert.equal(entry.x, Number((70 + 3100.2 * 0.455).toFixed(4)));
  assert.equal(entry.y, Number((138 + 1650.8 * 0.455).toFixed(4)));
});

test("extractOwnerLabels: scale 없는 권역(main-map-scaled-layer 부재)은 좌표를 그대로 쓴다", () => {
  const entries = extractOwnerLabels(`
    <svg>
      <text data-station="가야" data-label-role="ordinary" text-anchor="middle"
            font-size="12.5" x="1958" y="1430"><tspan x="1958" y="1430" dy="0">가야</tspan></text>
    </svg>
  `);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].x, 1958);
  assert.equal(entries[0].y, 1430);
  assert.equal(entries[0].anchor, "middle");
  assert.equal(entries[0].fontSizePx, 12.5);
});

test("extractOwnerLabels: 동명이역(같은 렌더 텍스트, 다른 위치)은 두 엔트리로 모두 보존한다(#2068 부산 좌천·동래 소실 회귀)", () => {
  // 부산 1호선 좌천·동해선 좌천은 물리적으로 다른 역이나 렌더 텍스트가 같다.
  // 추출은 텍스트를 키로 잡되 두 엔트리를 위치로 구분해 전부 남겨야 한다
  // (하나가 소실되면 실기기에서 1호선 좌천 노드가 무명으로 보임).
  const entries = extractOwnerLabels(`
    <svg>
      <text data-station-key="좌천_1" data-label-role="ordinary" text-anchor="middle"
            font-size="12.5" x="1900" y="1400"><tspan x="1900" y="1400">좌천</tspan></text>
      <text data-station-key="좌천_DH" data-label-role="ordinary" text-anchor="middle"
            font-size="12.5" x="3400" y="800"><tspan x="3400" y="800">좌천</tspan></text>
    </svg>
  `);
  const jwacheon = entries.filter((entry) => entry.station === "좌천");
  assert.equal(jwacheon.length, 2, "동명 라벨 2건이 모두 보존돼야 한다");
  const xs = jwacheon.map((entry) => entry.x).sort((a, b) => a - b);
  assert.deepEqual(xs, [1900, 3400], "두 좌천 라벨은 위치로 구분돼 남는다");
});

test("extractOwnerLabels: text-anchor가 속성 없이 style 선언 안에만 있으면(Inkscape 수작업) 그 값을 읽는다(#2068 수도권 게이트 회귀 — 신검단중앙 사례)", () => {
  const entries = extractOwnerLabels(`
    <svg>
      <text data-station="신검단중앙" data-label-role="ordinary"
            font-size="26.374px" x="913.08093" y="1191.6017"
            style="text-align:center;text-anchor:middle"
            ><tspan x="879.59833" y="1191.6017">신검단</tspan></text>
    </svg>
  `);
  assert.equal(entries.length, 1);
  assert.equal(
    entries[0].anchor,
    "middle",
    "style형 text-anchor를 못 읽으면 start로 오판(좌측 쏠림 → 이웃 라벨과 겹침)",
  );
});

test("extractOwnerLabels: 첫 tspan이 부모 <text>와 다른 x/y를 선언하면(여러 줄 라벨) tspan 값을 우선한다(#2068 수도권 게이트 회귀 — 신검단중앙 사례)", () => {
  const entries = extractOwnerLabels(`
    <svg>
      <text data-station="신검단중앙" data-label-role="ordinary"
            font-size="26.374px" x="913.08093" y="1191.6017"
            style="text-align:center;text-anchor:middle"
            ><tspan x="879.59833" y="1191.6017">신검단</tspan><tspan
             x="879.59833" y="1220.4017">중앙</tspan></text>
    </svg>
  `);
  assert.equal(entries.length, 1);
  assert.equal(
    entries[0].x,
    879.5983,
    'tspan x(실제 앵커 기준)가 아니라 부모 <text> x(913.08)를 쓰면 앵커가 오른쪽으로 밀려 이웃 라벨과 오탐 겹침이 난다',
  );
  assert.equal(entries[0].y, 1191.6017);
});

test("extractOwnerLabels: tspan에 x/y가 없으면(daegu 다음 줄 tspan 관례) 부모 <text>의 x/y를 그대로 쓴다", () => {
  const entries = extractOwnerLabels(`
    <svg>
      <text data-station="동대구" data-label-role="ordinary"
            font-size="13" x="100" y="200"
            ><tspan>동대구</tspan></text>
    </svg>
  `);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].x, 100);
  assert.equal(entries[0].y, 200);
});

test("extractOwnerLabels: 절대 y가 다른 2 tspan(2줄 라벨)은 lines에 두 줄을 담는다(#2068 다줄 라벨 렌더 — 검단사거리 사례)", () => {
  const entries = extractOwnerLabels(`
    <svg>
      <g id="main-map-scaled-layer" transform="translate(0 0) scale(1)">
        <text data-station="검단사거리" data-label-role="ordinary"
              transform="translate(541 1253.4)" font-size="26.374"
              ><tspan x="0" y="0">검단</tspan><tspan x="-11" y="28.8">사거리</tspan></text>
      </g>
    </svg>
  `);
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.station, "검단사거리"); // 매치 키는 여전히 전체 연결 텍스트.
  assert.equal(entry.lines.length, 2);
  assert.equal(entry.lines[0].text, "검단");
  assert.equal(entry.lines[0].x, 541);
  assert.equal(entry.lines[0].y, 1253.4);
  assert.equal(entry.lines[1].text, "사거리");
  assert.equal(entry.lines[1].x, 530); // 541 + (-11).
  assert.equal(entry.lines[1].y, 1282.2); // 1253.4 + 28.8.
});

test("extractOwnerLabels: 절대 y 없이 dy만 있는 다음 줄(daegu/busan/daejeon 관례)도 커서 누적으로 lines에 담는다", () => {
  const entries = extractOwnerLabels(`
    <svg>
      <text data-station="오정한남대" data-label-role="ordinary"
            font-size="26" x="1980" y="900"
            ><tspan x="1980" dy="0">오정</tspan><tspan x="1980" dy="10.8">한남대</tspan></text>
    </svg>
  `);
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.lines.length, 2);
  assert.equal(entry.lines[0].y, 900); // dy=0 → 부모 y 그대로.
  assert.equal(entry.lines[1].y, 910.8); // 900 + 10.8.
});

test("extractOwnerLabels: class=station-sub(daejeon 부기 캡션)는 lines에서 제외돼 단일 줄로 남는다 — lines 필드 자체가 없다(#2068 대동 사례)", () => {
  const entries = extractOwnerLabels(
    `
    <svg>
      <text data-label-role="transfer" font-size="58" x="572" y="740"
            data-full-official-name="1호선 대동 | 2호선 208 대동(하늘공원)"
            ><tspan class="station-main" x="572" dy="0">대동</tspan><tspan
             class="station-sub" x="572" dy="44.11" font-size="37.58px">하늘공원</tspan></text>
    </svg>
  `,
    "daejeon",
  );
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.station, "대동"); // canonical 매치 키 불변.
  assert.deepEqual(entry.lines, []); // station-sub 제외 → 1줄만 남아 lines 미부착.
});

test("extractOwnerLabels: 단일 줄 라벨은 lines가 빈 배열이다(스키마 최소화)", () => {
  const entries = extractOwnerLabels(`
    <svg>
      <text data-station="시청" data-label-role="transfer"
            font-size="28.571px" x="100" y="200"
            ><tspan x="100" y="200">시청</tspan></text>
    </svg>
  `);
  assert.deepEqual(entries[0].lines, []);
});

test("extractOwnerLabels: <g data-label-role> 감싸인 gwangju형 다줄 라벨도 g의 transform을 lines 각 줄에 더한다(#2068 학동증심사입구 사례)", () => {
  const entries = extractOwnerLabels(`
    <svg>
      <g id="station-label-group-1" data-station-name="학동"
         data-label-role="ordinary" transform="translate(10,20)">
        <text font-size="26"><tspan x="1942" y="889">학동</tspan><tspan
              x="1942" y="944">증심사입구</tspan></text>
      </g>
    </svg>
  `);
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.lines.length, 2);
  assert.equal(entry.lines[0].x, 1952); // 1942 + groupTranslate.dx(10).
  assert.equal(entry.lines[0].y, 909); // 889 + groupTranslate.dy(20).
  assert.equal(entry.lines[1].y, 964); // 944 + 20.
});

// #2068 벡스코 오배치(2026-07-26 실측 확정): SVG/CSS 명세상 style 선언이 동명
// presentation attribute를 이긴다. 종전 구현이 반대로 읽어 부산 벡스코 등 7건의
// 앵커가 뒤집혔고, 앱이 라벨을 폭만큼 반대쪽으로 그렸다.
test("extractOwnerLabels: style형 text-anchor가 속성형보다 우선한다(SVG 명세)", () => {
  const entries = extractOwnerLabels(`
    <svg>
      <text data-station="가야" data-label-role="ordinary" text-anchor="end"
            font-size="12.5" x="1958" y="1430" style="text-anchor:middle"
            >가야</text>
    </svg>
  `);
  assert.equal(entries[0].anchor, "middle");
});

test("extractOwnerLabels: style에 text-anchor가 없으면 속성형을 쓴다", () => {
  const entries = extractOwnerLabels(`
    <svg>
      <text data-station="가야" data-label-role="ordinary" text-anchor="end"
            font-size="12.5" x="1958" y="1430" style="text-align:end"
            >가야</text>
    </svg>
  `);
  assert.equal(entries[0].anchor, "end");
});

// #2068 벡스코 실측: 첫 줄 tspan이 wrapper(자기 텍스트 없음)이고 그 안 leaf
// tspan이 글리프별 dy 리스트를 가지면, 종전 구현은 (1) wrapper 매치가 다음 `<`를
// 소비해 leaf 줄을 통째로 잃고 (2) Number("0 0 … 59.27")=NaN으로 그 줄을 버려
// 다줄 라벨이 통째로 빈 배열이 됐다.
test("extractOwnerLabels: wrapper tspan + 글리프별 dy 리스트여도 두 줄을 모두 뽑는다", () => {
  const entries = extractOwnerLabels(`
    <svg>
      <text data-station="벡스코" data-label-role="transfer" font-size="54.6"
            x="9646" y="2928" text-anchor="start"
            style="text-align:end;text-anchor:end"><tspan
        sodipodi:role="line" x="9301.377" y="2928.2429"><tspan
        x="9301.377" dy="0 0 0 59.27">벡스코</tspan></tspan><tspan
        sodipodi:role="line" x="9299.9766" y="3000.8716">(시립미술관)</tspan></text>
    </svg>
  `);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].anchor, "end");
  assert.deepEqual(
    entries[0].lines.map((line) => line.text),
    ["벡스코", "(시립미술관)"],
  );
  assert.equal(entries[0].lines[0].x, 9301.377);
  assert.equal(entries[0].lines[0].y, 2928.2429);
  assert.equal(entries[0].lines[1].y, 3000.8716);
});

test("extractOwnerLabels: <g data-label-role>에 감싸인 gwangju형은 g의 transform도 더하고 CSS class font-size로 폴백한다", () => {
  const entries = extractOwnerLabels(`
    <svg>
      <style>
        .station-label-terminal { fill:#111111; font-size:15px; font-weight:700; }
      </style>
      <g id="station-label-group-119" data-station="119" data-station-name="평동"
         data-label-role="terminal" transform="translate(3.0637434,55.147382)">
        <text x="110" y="918" class="station-label station-label-terminal"
              text-anchor="middle">평동</text>
      </g>
    </svg>
  `);
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.station, "평동"); // data-station(코드 "119")이 아니라 텍스트 내용.
  assert.equal(entry.role, "terminal");
  assert.equal(entry.x, Number((110 + 3.0637434).toFixed(4)));
  assert.equal(entry.y, Number((918 + 55.147382).toFixed(4)));
  assert.equal(entry.fontSizePx, 15); // 인라인 font-size 없음 → CSS class 폴백.
});

test("extractOwnerLabels: code role과 construction/planned 상태는 제외한다", () => {
  const entries = extractOwnerLabels(`
    <svg>
      <text data-label-role="code" font-size="10" x="0" y="0">312</text>
      <text data-label-role="ordinary" data-status="construction" font-size="13"
            x="10" y="10">가수원네거리</text>
      <text data-label-role="planned" font-size="13" x="20" y="20">용두광역철도</text>
      <text data-label-role="regional" data-status="construction" font-size="13"
            x="30" y="30">흑석리</text>
      <g data-label-role="ordinary" data-state="planned">
        <text x="40" y="40">미개통역</text>
      </g>
      <text data-label-role="ordinary" font-size="13" x="50" y="50">정상역</text>
    </svg>
  `);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].station, "정상역");
});

test("extractOwnerLabels: daejeon 환승 복합 표기는 data-full-official-name의 canonical 1호선 역명을 station 키로 쓴다(#2068 실기기 확정 — 텍스트 flatten 대신)", () => {
  const entries = extractOwnerLabels(
    `
    <svg>
      <text data-label-role="transfer" font-size="14.2" x="0" y="0"
            data-full-official-name="1호선 대동 | 2호선 208 대동(하늘공원)"
            ><tspan x="0" dy="0">대동</tspan><tspan x="0" dy="10.8">하늘공원</tspan></text>
      <text data-label-role="transfer" font-size="14.2" x="0" y="0"
            data-full-official-name="1호선 대전역 | 2호선 206 대전역(중앙시장)"
            >대전역</text>
      <text data-label-role="ordinary" font-size="13.2" x="0" y="0"
            data-full-official-name="구암">구암</text>
    </svg>
  `,
    "daejeon",
  );
  const byStation = Object.fromEntries(entries.map((e) => [e.station, e]));
  assert.ok(byStation["대동"], "복합 표기 flatten(대동하늘공원) 대신 canonical 키(대동)여야 한다");
  assert.ok(!byStation["대동하늘공원"]);
  assert.ok(byStation["대전"], "역 접미 정규화(대전역→대전)까지 적용돼야 한다");
  assert.ok(!byStation["대전역"]);
  assert.ok(byStation["구암"], "data-full-official-name이 단순 역명이면 그대로 유지");
});

// #2068 대전·광주 v3: 오너가 두 권역 라벨 신원 속성을 data-full-official-name
// 하나로 통일했다. 이 분기가 DAEJEON.canonicalRules에 고정돼 있으면 광주 라벨이
// 대전 규칙(역 접미 제거·가운뎃점 보존)으로 뽑혀 카탈로그 표기와 어긋난다
// (광주송정역→광주송정, 학동·증심사입구 그대로) — 그 두 역만 폴백 미니 크기로
// 회귀한다(#2068 광주송정역 사례와 동형). 권역 규칙으로 뽑아야 한다.
test("extractOwnerLabels: gwangju data-full-official-name 라벨 키는 GWANGJU.canonicalRules로 뽑는다(DAEJEON 규칙 고정 금지)", () => {
  const svgText = `
    <svg>
      <g id="station-name-labels-layer">
        <text data-label-role="ordinary" font-size="34" x="0" y="0"
              data-full-official-name="광주송정역">광주송정역 </text>
        <text data-label-role="ordinary" font-size="34" x="0" y="10"
              data-full-official-name="학동·증심사입구">학동·증심사입구</text>
        <text data-label-role="ordinary" font-size="34" x="0" y="20"
              data-full-official-name="김대중컨벤션센터(마륵)">김대중컨벤션센터</text>
      </g>
    </svg>
  `;
  assert.deepEqual(
    new Set(extractOwnerLabels(svgText, "gwangju").map((e) => e.station)),
    new Set(["광주송정역", "학동증심사입구", "김대중컨벤션센터"]),
  );
  // 같은 마크업이라도 대전 규칙으로 뽑으면 두 역이 카탈로그와 어긋난다(회귀 대조).
  assert.deepEqual(
    new Set(extractOwnerLabels(svgText, "daejeon").map((e) => e.station)),
    new Set(["광주송정", "학동·증심사입구", "김대중컨벤션센터"]),
  );
});

// #2068 대전 v3: 오너가 상단 안내 영역과의 겹침을 피하려고 지도 본문을
// <g id="map-content-positioned-layer" transform="translate(0 88)">로 감쌌다.
// seoul의 main-map-scaled-layer와 같은 "지도 본문 래퍼"인데 id가 달라 흡수되지
// 않으면 ① .vec가 88px 위에 그려지고 ② 오너 라벨 sidecar 좌표도 88px 어긋나
// 바탕↔인터랙션 정합(<5px 하드 게이트)이 통째로 깨진다.
test("map-content-positioned-layer 래퍼 transform을 흡수한다(#2068 대전 v3 — .vec·라벨 sidecar 동시)", () => {
  const svgText = `
    <svg>
      <g id="map-card-clipped-content-layer">
        <g id="map-content-positioned-layer" transform="translate(0 88)">
          <g id="route-lines-layer"><polyline points="0,0 10,10" /></g>
          <g id="station-symbols-layer">
            <circle cx="540" cy="360" r="9" />
          </g>
          <g id="station-name-labels-layer">
            <text data-label-role="ordinary" font-size="34" x="100" y="200"
                  data-full-official-name="판암">판암</text>
          </g>
        </g>
      </g>
    </svg>
  `;
  assert.match(
    normalizeSvgForCompile(svgText),
    /<g id="compiled-map-coordinate-layer" transform="translate\(0 88\)"/,
  );
  const [entry] = extractOwnerLabels(svgText, "daejeon");
  assert.equal(entry.x, 100);
  assert.equal(entry.y, 288); // 200 + 88 — 노드(360+88=448)와 같은 좌표계.
});

// ── 텍스트 위치 선언 완결화(#2068 대전 라벨 이중 이동, 2026-07-26) ───────────
// vector_graphics_compiler 1.2.6은 x·y(또는 dx·dy)가 **둘 다** 선언된 텍스트 위치
// 노드에서만 조상 transform을 좌표로 흡수한다. 오너 라벨의
// `<text x y><tspan x dy="0">`은 부모만 흡수하고 자식은 transform을 .vec에 실어,
// 런타임이 같은 변환을 한 번 더 적용했다(대전 +88px·부산 최대 +968px).
test("transform이 걸린 <text> 안의 부분 선언 tspan을 절대 x·y로 완결한다(#2068 이중 적용 차단)", () => {
  const normalized = normalizeSvgForCompile(`
    <svg>
      <g id="map-card-clipped-content-layer">
        <g id="map-content-positioned-layer" transform="translate(0 88)">
          <g id="route-lines-layer"><polyline points="0,0 10,10" /></g>
          <g id="station-name-labels-layer">
            <text data-label-role="ordinary" font-size="34" x="1608.404" y="607.727"
                  data-full-official-name="월드컵경기장"><tspan class="station-main"
                  x="1608.404" dy="0">월드컵경기장</tspan></text>
          </g>
        </g>
      </g>
    </svg>
  `);
  const tspan = normalized.match(/<tspan\b[^>]*>/)[0];
  assert.match(tspan, /\sx="1608\.404"/);
  assert.match(tspan, /\sy="607\.727"/);
  assert.doesNotMatch(tspan, /\sdy=/, "dy는 절대 y로 접혀 사라져야 한다");
});

test("여러 줄 라벨의 dy는 누적 절대 y로 접힌다(줄 간격 보존)", () => {
  const normalized = normalizeSvgForCompile(`
    <svg>
      <g id="map-card-clipped-content-layer">
        <g id="map-content-positioned-layer" transform="translate(0 88)">
          <g id="route-lines-layer"><polyline points="0,0 10,10" /></g>
          <g id="station-name-labels-layer">
            <text data-label-role="ordinary" font-size="34" x="100" y="200"
                  data-full-official-name="두줄"><tspan x="100" dy="0">첫째</tspan><tspan
                  x="100" dy="40">둘째</tspan></text>
          </g>
        </g>
      </g>
    </svg>
  `);
  const tspans = [...normalized.matchAll(/<tspan\b[^>]*>/g)].map((m) => m[0]);
  assert.match(tspans[0], /\sy="200"/);
  assert.match(tspans[1], /\sy="240"/);
});

// 오너 소스의 실제 형태(수도권 총신대입구·부산 벡스코·광주 광주송정역)는 중첩
// tspan이다 — 바깥 껍데기 tspan이 줄(x·y)을 잡고 안쪽 tspan이 글자를 담는다.
// 안쪽 tspan은 x만 선언하므로 완결화 대상이고, 그 y는 바깥 껍데기가 옮겨 놓은
// 펜 위치에서 와야 한다(부모 <text>의 y가 아니다).
test("중첩 tspan(껍데기 줄 + 안쪽 글자)도 바깥이 옮긴 펜 y를 상속해 완결된다", () => {
  const normalized = normalizeSvgForCompile(`
    <svg>
      <g id="map-card-clipped-content-layer">
        <g id="map-content-positioned-layer" transform="translate(0 88)">
          <g id="route-lines-layer"><polyline points="0,0 10,10" /></g>
          <g id="station-name-labels-layer">
            <text data-label-role="transfer" font-size="34" x="9646.0859" y="2928.2429"
                  data-full-official-name="벡스코"><tspan id="line1" x="9301.377"
                  y="2928.2429"><tspan id="glyph1" x="9301.377" dy="0">벡스코</tspan></tspan><tspan
                  id="line2" x="9299.9766" y="3000.8716">(시립미술관)</tspan></text>
          </g>
        </g>
      </g>
    </svg>
  `);
  const openTagOf = (id) =>
    normalized.match(new RegExp(`<tspan\\b[^>]*\\bid="${id}"[^>]*>`))[0];
  // 껍데기 줄은 이미 완전 선언이라 불변.
  assert.match(openTagOf("line1"), /\sy="2928\.2429"/);
  assert.doesNotMatch(openTagOf("line1"), /\sdy=/);
  // 안쪽 글자는 부모 <text>의 y가 아니라 껍데기가 옮긴 펜 y를 상속한다.
  assert.match(openTagOf("glyph1"), /\sx="9301\.377"/);
  assert.match(openTagOf("glyph1"), /\sy="2928\.2429"/);
  assert.doesNotMatch(openTagOf("glyph1"), /\sdy=/);
  // 중첩에서 빠져나온 다음 형제 줄은 자기 절대 y를 그대로 유지한다.
  assert.match(openTagOf("line2"), /\sy="3000\.8716"/);
});

test("중첩 tspan의 dy는 바깥 줄 y에서 누적된다(펜이 <text> y로 되돌아가지 않는다)", () => {
  const normalized = normalizeSvgForCompile(`
    <svg>
      <g id="map-card-clipped-content-layer">
        <g id="map-content-positioned-layer" transform="translate(0 88)">
          <g id="route-lines-layer"><polyline points="0,0 10,10" /></g>
          <g id="station-name-labels-layer">
            <text data-label-role="ordinary" font-size="34" x="100" y="200"
                  data-full-official-name="중첩"><tspan id="outer" x="100"
                  y="300"><tspan id="inner" x="100" dy="40">중첩</tspan></tspan></text>
          </g>
        </g>
      </g>
    </svg>
  `);
  const inner = normalized.match(/<tspan\b[^>]*\bid="inner"[^>]*>/)[0];
  assert.match(inner, /\sy="340"/); // 300(바깥 줄) + 40(dy) — 200(부모 text)이 아니다.
  assert.doesNotMatch(inner, /\sdy=/);
});

test("조상 transform이 항등이면 tspan 선언을 건드리지 않는다(정합 권역 산출 불변)", () => {
  const tspan = normalizeSvgForCompile(`
    <svg>
      <g id="route-lines-layer"><polyline points="0,0 10,10" /></g>
      <g id="station-name-labels-layer">
        <text data-label-role="ordinary" font-size="34" x="100" y="200"
              data-full-official-name="항등"><tspan x="100" dy="0">항등</tspan></text>
      </g>
    </svg>
  `).match(/<tspan\b[^>]*>/)[0];
  assert.match(tspan, /\sdy="0"/, "항등 변환에서는 흡수 판정이 갈리지 않아 원문 그대로다");
  assert.doesNotMatch(tspan, /\sy="/);
});

test("이미 x·y를 둘 다 선언한 tspan은 그대로 둔다(수도권 산출 바이트 보존)", () => {
  const normalized = normalizeSvgForCompile(`
    <svg>
      <g id="map-card-clipped-content-layer">
        <g id="main-map-scaled-layer" transform="translate(70 138) scale(0.455)">
          <g id="route-lines-layer"><polyline points="0,0 10,10" /></g>
          <g id="station-name-labels-layer">
            <text data-label-role="ordinary" font-size="34" x="100" y="200"
                  data-full-official-name="완전"><tspan x="120" y="220">완전</tspan></text>
          </g>
        </g>
      </g>
    </svg>
  `);
  assert.match(normalized.match(/<tspan\b[^>]*>/)[0], /<tspan x="120" y="220">/);
});

test("transform이 걸린 <text> 안에서 x를 선언하지 않은 tspan은 조용히 넘기지 않고 실패한다", () => {
  assert.throws(
    () =>
      normalizeSvgForCompile(`
        <svg>
          <g id="map-card-clipped-content-layer">
            <g id="map-content-positioned-layer" transform="translate(0 88)">
              <g id="route-lines-layer"><polyline points="0,0 10,10" /></g>
              <g id="station-name-labels-layer">
                <text data-label-role="ordinary" font-size="34" x="100" y="200"
                      id="station-label-x-less"><tspan dy="0">x없음</tspan></text>
              </g>
            </g>
          </g>
        </svg>
      `),
    /x를 선언하지 않은 <tspan>/,
  );
});

// #2068 대전·광주 v3: KTX·SRT 마크가 rail-transfer-layer(v1에선 빈 레이어)에서
// station-name-labels-layer 안 역 앵커 그룹(class="rail-service-marks")으로
// 옮겨졌다. 그 레이어는 바탕층 allow-list 밖이라 손대지 않으면 ① 마크가 .vec에서
// 통째로 사라지고 ② 라벨 회피 obstacle도 0건이 된다.
test("rail-service-marks(대전·광주 v3 KTX·SRT)는 바탕층에 반입되고 라벨 회피 obstacle이 된다", () => {
  const svgText = `
    <svg>
      <g id="map-card-clipped-content-layer">
        <g id="map-content-positioned-layer" transform="translate(0 88)">
          <g id="route-lines-layer"><polyline points="0,0 10,10" /></g>
          <g id="station-name-labels-layer">
            <text data-label-role="ordinary" font-size="34" x="100" y="200"
                  data-full-official-name="대전역">대전역</text>
            <g id="rail-service-marks-line1-104" class="rail-service-marks"
               data-station-name="대전역" data-services="KTX,SRT">
              <title>대전역 KTX·SRT 고속철도 환승</title>
              <g id="rail-service-ktx-line1-104" data-logo="KTX"
                 transform="matrix(0.05,0,0,0.05,660,880)">
                <path d="M 0 0 L 200 0 L 200 100 L 0 100 Z" />
              </g>
            </g>
          </g>
        </g>
      </g>
    </svg>
  `;
  const normalized = normalizeSvgForCompile(svgText);
  assert.match(normalized, /id="rail-service-marks-line1-104"/);
  assert.match(normalized, /id="rail-service-ktx-line1-104"/);
  // #2068(2026-07-26): 역명 라벨 레이어 자체가 본문이 됐다 — 표장은 그 레이어의
  // 일부로 정확히 한 번만 반입되고(중복 반입 금지), 역명 텍스트도 함께 온다.
  assert.equal(
    (normalized.match(/id="rail-service-marks-line1-104"/g) ?? []).length,
    1,
  );
  assert.match(normalized, /대전역</);
  assert.doesNotMatch(normalized, /<title\b/);

  const [obstacle] = extractRailTransferChipObstacles(svgText);
  assert.equal(obstacle.station, "대전역");
  // 로컬 path [0,200]×[0,100] → matrix(0.05,…,660,880) → [660,670]×[880,885],
  // 그 위에 지도 본문 래퍼 translate(0 88).
  assert.equal(obstacle.x, 665);
  assert.equal(obstacle.y, 882.5 + 88);
  assert.equal(obstacle.halfWidth, 5);
  assert.equal(obstacle.halfHeight, 2.5);
});

test("extractOwnerLabels: 5권역 실 SVG에서 ordinary/transfer/terminal 개수가 실측과 일치한다", () => {
  const sources = path.join(import.meta.dirname, "route-map-defs/svg-sources");
  const expected = {
    // #2068 오너 v3(최종 디자인) 통합(2026-07-20): 오너가 처음부터 새로 그린
    // 확정본으로 수도권 소스 자체가 교체됐다 — 이 수는 실측치라 새 소스의 실제
    // 라벨 구성을 그대로 반영한다(ordinary 502→501, v3 자체 라벨 구성 차이.
    // transfer는 불변. terminal 30은 이식한 종점 마크 30개와 정확히 일치 —
    // 형상 비침습 기계 이식, 위치는 v3 역 좌표 기준 재계산).
    // #2068 v4 반입(2026-07-25): 세 role 개수 모두 v2와 동일(501/124/30) —
    // v4의 변경은 라벨 개수가 아니라 표기 정규화(신촌·양평 콜론 제거 등)와
    // 좌표 재배치라는 실측 근거.
    "easy-subway-sma-v4.svg": { ordinary: 501, transfer: 124, terminal: 30 },
    // #2068 벡스코 병합: 2호선·동해선을 단일 환승 station_id로 합치면서, 동해선
    // 노드용 중복 ordinary 라벨(벡스코_DH)을 제거했다(단일 환승 캡슐이 전사 라벨을
    // 이미 가지므로 중복 표기 불필요) → ordinary 129→128.
    "easy-subway-busan-v3.svg": { ordinary: 128, transfer: 12, terminal: 7 },
    "easy-subway-daegu-v3.svg": { ordinary: 84, transfer: 5, terminal: 8 },
    // #2068 대전·광주 v3 반입(2026-07-25): 오너가 두 도식을 전면 재제작하며
    // 카탈로그 밖 노선(대전 2호선 트램·충청권 광역철도, 광주 2호선)을 도식에서
    // 통째로 걷어냈다 — 라벨이 카탈로그 실역만 남는다(대전 22 = 운영 22역,
    // 광주 20 = 운영 20역). v1의 25(15/8/2)·62(53/7/2)에는 미개통 노선 라벨과
    // 환승 role 표기가 섞여 있었다. 두 권역 모두 활성 환승역이 0이라 transfer
    // role은 0이고, 종점 2역(대전 판암·반석, 광주 평동·녹동)만 terminal이다.
    "easy-subway-daejeon-v3.svg": { ordinary: 20, transfer: 0, terminal: 2 },
    "easy-subway-gwangju-v3.svg": { ordinary: 18, transfer: 0, terminal: 2 },
  };
  for (const [file, counts] of Object.entries(expected)) {
    const entries = extractOwnerLabels(
      readFileSync(path.join(sources, file), "utf8"),
    );
    const byRole = { ordinary: 0, transfer: 0, terminal: 0 };
    for (const entry of entries) byRole[entry.role] += 1;
    assert.deepEqual(byRole, counts, file);
    for (const entry of entries) {
      assert.ok(entry.station.length > 0, `${file}: 빈 station 키`);
      assert.ok(Number.isFinite(entry.x) && Number.isFinite(entry.y), file);
      assert.ok(entry.fontSizePx > 0, file);
      assert.ok(["start", "middle", "end"].includes(entry.anchor), file);
    }
  }
});

// #2068 대전·광주 v3 반입 회귀 가드 — 컴파일러를 손댈 때(권역별 canonicalRules
// 확장·지도 본문 래퍼 흡수·rail-service-marks 반입) 산출물이 정말 그대로인지
// 커밋된 파일과 직접 대조한다. 라벨 sidecar와 정규화 SVG(=.vec 입력) 양쪽을
// 본다 — 둘 다 같으면 .vec 바이트도 같다(결정적 컴파일).
//
// **5권역 전부**를 돈다. 미변경 3권역(seoul·busan·daegu)은 "건드리지 않았음"을,
// 변경 2권역(daejeon·gwangju)은 "의도한 값으로 고정됐음"을 각각 고정한다 —
// 이 PR이 새로 도입한 두 축이 정확히 sidecar의 station 키(권역별
// OWNER_LABEL_CANONICAL_RULES)와 x/y(MAP_WRAPPER_LAYER_IDS의 대전
// translate(0 88) 흡수)를 결정하므로, 두 권역을 빼면 그 두 축의 회귀를
// node 층에서 아무도 못 잡는다(개수·부가 필드만 보던 상태).
test("5권역 오너 라벨 sidecar·정규화 SVG가 커밋된 산출물과 완전히 동일하다", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const manifest = JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, "basemap-build-manifest.json"),
      "utf8",
    ),
  );
  const sidecar = JSON.parse(
    readFileSync(
      path.join(
        root,
        "apps/mobile/assets/datapacks/metro_map_pack/basemap/labels.json",
      ),
      "utf8",
    ),
  );
  for (const id of ["seoul", "busan", "daegu", "daejeon", "gwangju"]) {
    const map = manifest.maps.find((entry) => entry.id === id);
    assert.ok(map, `${id}: build manifest 항목 없음`);
    const source = readFileSync(path.join(root, map.source), "utf8");
    assert.deepEqual(
      markLineTerminalBadgeEntries(extractOwnerLabels(source, id), source),
      sidecar.regions[id],
      `${id}: 오너 라벨 sidecar가 달라졌습니다(station 키·x/y 포함)`,
    );
    assert.equal(
      createHash("sha256")
        .update(normalizeSvgForCompile(source))
        .digest("hex"),
      map.normalizedSvgSha256,
      `${id}: 컴파일 입력(정규화 SVG)이 달라졌습니다`,
    );
  }
});

// #2068 대전·광주 v3: canonicalRules 변환이 걸린 4건이 **카탈로그 표기**로
// 떨어지는지 직접 못 박는다. 위 sidecar deepEqual이 값 전체를 고정하지만, 그
// 고정값이 왜 그 문자열이어야 하는지(=카탈로그와 매칭되어야 앱이 오너 라벨로
// 렌더한다)는 드러나지 않는다 — 변환 전 마크업 원문이 키로 남으면 그 역만
// 조용히 폴백 미니 크기가 되는 #2068 광주송정역 사례라, 원문 표기가 키에
// 없다는 것까지 함께 고정한다.
test("대전·광주 sidecar 키는 마크업 원문이 아니라 카탈로그 표기다(canonicalRules 변환 4건)", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const sidecar = JSON.parse(
    readFileSync(
      path.join(
        root,
        "apps/mobile/assets/datapacks/metro_map_pack/basemap/labels.json",
      ),
      "utf8",
    ),
  );
  // [권역, 마크업 data-full-official-name, 카탈로그 표기]
  const conversions = [
    ["daejeon", "대전역", "대전"],
    ["gwangju", "김대중컨벤션센터(마륵)", "김대중컨벤션센터"],
    ["gwangju", "문화전당(구도청)", "문화전당"],
    ["gwangju", "학동·증심사입구", "학동증심사입구"],
  ];
  for (const [id, markup, catalog] of conversions) {
    const keys = new Set(sidecar.regions[id].map((entry) => entry.station));
    assert.ok(keys.has(catalog), `${id}: 카탈로그 표기 '${catalog}' 키가 없다`);
    assert.ok(
      !keys.has(markup),
      `${id}: 마크업 원문 '${markup}'이 키로 남았다(권역 규칙 미적용 회귀)`,
    );
  }
  // 나머지 키는 변환 없이 마크업 표기 그대로다(대전 21 / 광주 17).
  assert.equal(sidecar.regions.daejeon.length, 22);
  assert.equal(sidecar.regions.gwangju.length, 20);
});

test("build manifest가 source·normalized·vec hash와 viewBox를 결합한다", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const manifest = JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, "basemap-build-manifest.json"),
      "utf8",
    ),
  );
  // #2068 리뷰 M2: compiler.version은 pubspec.lock에 잠긴 **패키지 버전**이어야
  // 한다(하드코딩 상수와 lock 양쪽을 대조해 드리프트를 막는다). 산출 의미의 개정은
  // 별도 pipelineRevision이 기록한다.
  assert.equal(manifest.compiler.version, "1.2.6");
  const lockedCompilerVersion = readFileSync(
    path.join(root, "apps/mobile/pubspec.lock"),
    "utf8",
  ).match(/vector_graphics_compiler:[\s\S]*?version: "([^"]+)"/)?.[1];
  assert.equal(
    manifest.compiler.version,
    lockedCompilerVersion,
    "manifest.compiler.version은 pubspec.lock의 vector_graphics_compiler 버전과 같아야 합니다.",
  );
  assert.equal(manifest.pipelineRevision, 2);
  assert.deepEqual(manifest.content, {
    svgLayer: "owner-svg-map-body-layers",
    stationSymbols: "owner-svg",
    labels: "baked-into-vec",
    decoration: "excluded",
    interaction: "route_map_positions",
  });
  assert.equal(manifest.maps.length, 5);

  for (const map of manifest.maps) {
    const source = readFileSync(path.join(root, map.source));
    const normalized = normalizeSvgForCompile(source.toString("utf8"));
    const vec = readFileSync(path.join(root, map.compiledVector));
    const hash = (value) => createHash("sha256").update(value).digest("hex");
    assert.equal(map.sourceSvgSha256, hash(source));
    assert.equal(map.normalizedSvgSha256, hash(normalized));
    assert.equal(map.compiledVectorSha256, hash(vec));
    assert.equal(map.viewBox.length, 4);
    // #2068: 프로덕션 경로(main())가 extractOwnerLabels(sourceText, region.id)로
    // 권역 규칙을 태우므로 계약 테스트도 같은 인자를 넘겨야 한다. regionId를
    // 빼면 daejeon·gwangju는 data-full-official-name 원문이 키가 돼(대전역·
    // 학동·증심사입구·문화전당(구도청)·김대중컨벤션센터(마륵)) 프로덕션과 다른
    // 코드 경로를 검증하게 된다 — 개수만 비교해 통과하던 사각지대.
    const ownerLabels = extractOwnerLabels(source.toString("utf8"), map.id);
    assert.equal(map.ownerLabelCount, ownerLabels.length);
  }

  const sidecarPath = path.join(root, manifest.ownerLabelsSidecar.path);
  const sidecar = readFileSync(sidecarPath, "utf8");
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  assert.equal(manifest.ownerLabelsSidecar.sha256, hash(sidecar));
  const parsedSidecar = JSON.parse(sidecar);
  assert.equal(parsedSidecar.artifactKind, "route-map-basemap-owner-labels");
  assert.deepEqual(
    Object.keys(parsedSidecar.regions).sort(),
    ["busan", "daegu", "daejeon", "gwangju", "seoul"],
  );
  for (const map of manifest.maps) {
    assert.equal(
      parsedSidecar.regions[map.id].length,
      map.ownerLabelCount,
      map.id,
    );
  }
});

test("markLineTerminalBadgeEntries: line-terminal-badge가 없으면 원본을 그대로 반환한다", () => {
  const entries = [
    { station: "평동", role: "terminal", x: 0, y: 0, anchor: "start", fontSizePx: 10 },
  ];
  const result = markLineTerminalBadgeEntries(entries, "<svg></svg>");
  assert.equal(result, entries); // .map 없이 원본 참조 그대로.
});

test("markLineTerminalBadgeEntries: 있으면 terminal role 엔트리에만 표시하고 나머지는 불변", () => {
  const entries = [
    { station: "평동", role: "terminal", x: 0, y: 0, anchor: "start", fontSizePx: 10 },
    { station: "녹동", role: "terminal", x: 1, y: 1, anchor: "start", fontSizePx: 10 },
    { station: "도산", role: "ordinary", x: 2, y: 2, anchor: "start", fontSizePx: 10 },
  ];
  const svgText = '<g data-role="line-terminal-badge"><circle /></g>';
  const result = markLineTerminalBadgeEntries(entries, svgText);
  assert.equal(result[0].hasLineTerminalBadge, true);
  assert.equal(result[1].hasLineTerminalBadge, true);
  assert.equal(result[2].hasLineTerminalBadge, undefined);
  // 원본 배열/객체는 변경하지 않는다(순수 함수).
  assert.equal(entries[0].hasLineTerminalBadge, undefined);
});

test("labels.json sidecar: 5권역 모두 terminal 엔트리에 hasLineTerminalBadge, 비-terminal은 플래그 없음", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const sidecarPath = path.join(
    root,
    "apps/mobile/assets/datapacks/metro_map_pack/basemap/labels.json",
  );
  const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
  // 부산(#2068): 6개 노선의 비환승 종점 7곳에 line-terminal-badge를 그려
  // 앱 배지 억제를 켠다. markLineTerminalBadgeEntries는 권역 단위 감지라 terminal
  // role 엔트리 전부에 플래그가 붙고, 부산 terminal 라벨 7건은 모두 그 종점이다.
  // 대구(#2068): 1·2·3호선(원+숫자)·대경선(캡슐+대경) 종점 8곳에 동일 배지를 그려
  // 같은 억제를 켠다 — terminal 라벨 8건 전부에 플래그가 붙는다.
  // 수도권(#2068): 24개 노선의 비환승 종점 30곳(대전 스타일 원+숫자/캡슐 배지)에
  // line-terminal-badge를 그려 같은 억제를 켠다 — terminal 라벨 30건 전부에 플래그가
  // 붙는다. 환승 종점은 기존 환승 캡슐이 노선을 표시하므로 배지를 두지 않는다.
  for (const regionId of ["gwangju", "daejeon", "busan", "daegu", "seoul"]) {
    const terminals = sidecar.regions[regionId].filter(
      (entry) => entry.role === "terminal",
    );
    assert.ok(terminals.length > 0, regionId);
    for (const entry of terminals) {
      assert.equal(entry.hasLineTerminalBadge, true, `${regionId}:${entry.station}`);
    }
    // 비-terminal(ordinary/transfer) 엔트리에는 플래그가 붙지 않는다.
    for (const entry of sidecar.regions[regionId]) {
      if (entry.role !== "terminal") {
        assert.equal(
          entry.hasLineTerminalBadge,
          undefined,
          `${regionId}:${entry.station}`,
        );
      }
    }
  }
});

// #2068 대전·광주 마감: 재설계된 두 권역 SVG는 부산·대구형 service-tag 마크업
// (class="service-tag"·data-station) 대신 rail-transfer-layer 안 rail chip
// (data-services·data-station-name)으로 KTX·SRT 표장을 담는다. 전용 인식기가
// chip <g>만(내부 로고 서브그룹 제외) 잡아 절대 좌표 bbox 장애물을 낸다.
test("extractRailTransferChipObstacles: rail-transfer-layer chip을 transform 합성으로 잡는다", () => {
  const svg = `<svg viewBox="0 0 2400 1800">
    <g id="rail-transfer-layer">
      <g id="chip-a" data-station-name="대전역(혁신도시)" data-services="KTX,SRT"
         transform="translate(-10,-20)">
        <title>207 대전역 KTX·SRT 환승</title>
        <g transform="matrix(0.05,0,0,0.05,1000,600)" data-logo="KTX">
          <path d="M 0 0 L 100 0 L 100 200 L 0 200 Z" />
        </g>
      </g>
      <rect x="500" y="500" width="58" height="20" />
      <text x="520" y="510">경전선</text>
    </g>
  </svg>`;
  const obstacles = extractRailTransferChipObstacles(svg);
  assert.equal(obstacles.length, 1); // rect·text 캡션과 로고 서브그룹은 chip 아님.
  const [chip] = obstacles;
  assert.equal(chip.station, "대전역(혁신도시)");
  // 로컬 path [0,0]-[100,200]에 matrix(0.05) → [0,0]-[5,10], +translate(1000,600)
  // → [1000,600]-[1005,610], chip translate(-10,-20) → [990,580]-[995,590].
  assert.equal(chip.x, 992.5);
  assert.equal(chip.y, 585);
  assert.equal(chip.halfWidth, 2.5);
  assert.equal(chip.halfHeight, 5);
});

test("extractRailTransferChipObstacles: rail-transfer-layer가 없으면 빈 배열", () => {
  assert.deepEqual(
    extractRailTransferChipObstacles('<svg><g id="route-lines-layer"></g></svg>'),
    [],
  );
});

// #2068 ITX-청춘 chip 반입 대비 파서 강화(정본). 기존 `/-?\d+\.?\d*/g`(정수부
// 우선)는 벡터 최적화 export가 흔히 내는 "선행 0 생략 + 연접 소수"(예:
// ".191.132" = 0.191과 0.132 두 숫자)를 "191.132" 하나로 오병합했다 —
// extract-svg-geometry.mjs의 pathEndpointVertices가 이미 쓰는 순서(부호 →
// 선택 정수부 → 선택 소수부 → 필수 최소 1자리)로 교체해 정확히 분리한다.
test("SVG_NUMBER_TOKEN_RE(parseSvgNumbers): 선행 0 생략·연접 소수를 개별 숫자로 정확히 나눈다", () => {
  assert.deepEqual(parseSvgNumbers(".191.132"), [0.191, 0.132]);
  assert.deepEqual(parseSvgNumbers("12.34.56"), [12.34, 0.56]);
  assert.deepEqual(parseSvgNumbers("-.58.58"), [-0.58, 0.58]);
  assert.deepEqual(parseSvgNumbers("123 -45.6 .78"), [123, -45.6, 0.78]);
});

// collectShapeBounds(내부)는 커맨드 인식 파서(visitPathCoordinates)로 절대좌표를
// 정확히 추적한다 — A(호, rx ry x축회전 large-arc sweep x y 7개 인자 중 마지막
// 2개만 좌표)의 비좌표 인자를 좌표로 오인하지 않고, 상대좌표(소문자) 명령의
// 누적도 정확히 처리해야 한다(ITX-청춘 로고가 이 두 특성을 모두 씀 — 실측:
// 나이브 파서로는 로고 자체 bbox가 viewBox 300 대비 590으로 부풀었다).
test("extractServiceTagObstacles: A(호)·상대좌표 혼용 path도 정확한 bbox를 낸다(커맨드 인식 파서)", () => {
  const svg = `<svg viewBox="0 0 2400 1800">
    <g id="service-tags-layer" class="render-layer service-tag-layer">
      <g id="service-tag-a" class="service-tag" data-station="테스트역" data-services="ITX">
        <title>테스트역 · ITX</title>
        <g transform="matrix(1,0,0,1,0,0)" data-logo="ITX">
          <path d="M10 10 l 10 0 a 5 5 0 0 1 5 5 l 0 10 h -5 v -5 z" />
        </g>
      </g>
    </g>
  </svg>`;
  const [obstacle] = extractServiceTagObstacles(svg);
  // 수동 절대좌표 추적: M(10,10) L(20,10) A..→(25,15) L(25,25) H(20,25) V(20,20) Z.
  // bbox: x[10,25] y[10,25] (제어점 없는 A/L/H/V만 있어 endpoint == bbox 극값).
  assert.equal(obstacle.x, (10 + 25) / 2);
  assert.equal(obstacle.y, (10 + 25) / 2);
  assert.equal(obstacle.halfWidth, (25 - 10) / 2);
  assert.equal(obstacle.halfHeight, (25 - 10) / 2);
});

// #2068 수도권 표장 마감: obstacle 좌표계 정합. main-map-scaled-layer(seoul형
// scale(k)+translate)가 있으면 service-tag·rail-transfer chip이 그 안에 로컬
// (pre-scale) 좌표로 쓰이므로, extractOwnerLabels와 같은 공식(로컬×mapScale+
// mapTranslate)으로 최종 좌표계로 변환돼야 라벨 sidecar·route_map_positions와
// 정합한다(오버레이 게이트가 그 좌표계로 obstacle을 비교하기 때문).
test("extractServiceTagObstacles: main-map-scaled-layer 안 chip은 mapScale·mapTranslate를 적용해 최종 좌표로 낸다", () => {
  const svg = `<svg viewBox="0 0 2400 1800">
    <g id="main-map-scaled-layer" transform="translate(70 138) scale(0.455)">
      <g id="service-tags-layer" class="render-layer service-tag-layer">
        <g id="service-tag-a" class="service-tag" data-station="서울역" data-services="KTX"
           transform="translate(1000,600)">
          <title>서울역 · KTX</title>
          <g transform="matrix(1,0,0,1,0,0)" data-logo="KTX">
            <path d="M 0 0 L 100 0 L 100 200 L 0 200 Z" />
          </g>
        </g>
      </g>
    </g>
  </svg>`;
  const [obstacle] = extractServiceTagObstacles(svg);
  // 로컬 bbox center=(1050,700), halfW=50, halfH=100.
  // 최종 = translate(70,138) + scale(0.455)*로컬.
  assert.equal(obstacle.x, 70 + 1050 * 0.455);
  assert.equal(obstacle.y, 138 + 700 * 0.455);
  assert.equal(obstacle.halfWidth, 50 * 0.455);
  assert.equal(obstacle.halfHeight, 100 * 0.455);
});

test("extractServiceTagObstacles: 표장 레이어 자신의 transform도 체인에 합성한다", () => {
  // 레이어 <g>와 표장 <g>가 각자 transform을 가지면 SVG 렌더는 둘을 합성한다
  // (레이어가 바깥). 레이어 transform을 빠뜨리면 obstacle이 실제 렌더 위치에서
  // 어긋난다(#2068 대구 동대구역 KTX·SRT 유령 겹침의 원인).
  const svgText = `
    <svg>
      <g id="service-tags-layer" transform="matrix(2,0,0,3,100,200)">
        <g id="service-tag-ktx-1" class="service-tag" data-station="테스트역"
           transform="translate(10 20)">
          <rect x="0" y="0" width="5" height="7" />
        </g>
      </g>
    </svg>`;
  const [obstacle] = extractServiceTagObstacles(svgText);
  // 로컬 rect [0,5]×[0,7] → tag translate → 레이어 matrix.
  // x: 2*(0+10)+100 = 120 … 2*(5+10)+100 = 130 → center 125 halfWidth 5
  // y: 3*(0+20)+200 = 260 … 3*(7+20)+200 = 281 → center 270.5 halfHeight 10.5
  assert.equal(obstacle.station, "테스트역");
  assert.equal(obstacle.x, 125);
  assert.equal(obstacle.y, 270.5);
  assert.equal(obstacle.halfWidth, 5);
  assert.equal(obstacle.halfHeight, 10.5);
});

// #2068 리뷰 지적(2026-07-25): 자기폐쇄 `<g …/>`를 depth로 세던 결함이 표장
// 추출기 두 곳에 남아 있었다 — 균형이 깨지면 조용히 빈 배열이 되어 표장 회피가
// 통째로 사라져도 게이트가 green이었다. 아래 4건이 그 시나리오를 고정한다.
test("extractServiceTagObstacles: 앞선 자기폐쇄 빈 레이어가 표장 레이어 인식을 깨뜨리지 않는다", () => {
  const svgText = `
    <svg>
      <g id="terminal-route-badges-layer" class="render-layer" />
      <g id="service-tags-layer">
        <g id="service-tag-ktx-1" class="service-tag" data-station="테스트역">
          <rect x="0" y="0" width="10" height="4" />
        </g>
      </g>
    </svg>`;
  const obstacles = extractServiceTagObstacles(svgText);
  assert.equal(obstacles.length, 1);
  assert.equal(obstacles[0].station, "테스트역");
  assert.equal(obstacles[0].halfWidth, 5);
  assert.equal(obstacles[0].halfHeight, 2);
});

test("extractServiceTagObstacles·extractRailTransferChipObstacles: 레이어 안의 자기폐쇄 <g/>가 표장을 잃게 하지 않는다", () => {
  const serviceSvg = `
    <svg>
      <g id="service-tags-layer">
        <g id="spacer" data-note="빈 자리표시" />
        <g id="service-tag-ktx-1" class="service-tag" data-station="테스트역">
          <rect x="0" y="0" width="10" height="4" />
        </g>
      </g>
      <g id="station-name-labels-layer"><text>테스트역</text></g>
    </svg>`;
  const serviceObstacles = extractServiceTagObstacles(serviceSvg);
  assert.equal(serviceObstacles.length, 1);
  assert.equal(serviceObstacles[0].station, "테스트역");

  const railSvg = `
    <svg>
      <g id="rail-transfer-layer">
        <g id="spacer" data-note="빈 자리표시" />
        <g id="chip-1" data-services="KTX" data-station-name="테스트역">
          <rect x="0" y="0" width="10" height="4" />
        </g>
      </g>
    </svg>`;
  const railObstacles = extractRailTransferChipObstacles(railSvg);
  assert.equal(railObstacles.length, 1);
  assert.equal(railObstacles[0].station, "테스트역");
});

// #2068 리뷰 후속: 레이어 한 단계 아래 "블록 스캐너"(service-tag 블록·rail chip
// 블록·collectShapeBoundsRecursive의 중첩 <g>)에도 같은 규칙을 적용했다. 후속
// PR이 반입할 수도권 SVG에 자기폐쇄 <g/>가 다수라 실제로 밟히는 경로다.
test("표장 블록 안의 자기폐쇄 <g/>가 obstacle을 버리거나 bbox를 부풀리지 않는다", () => {
  const serviceSvg = `
    <svg>
      <g id="service-tags-layer">
        <g id="service-tag-ktx-1" class="service-tag" data-station="테스트역">
          <g id="spacer" data-note="빈 자리표시" />
          <g id="logo" transform="translate(100 200)">
            <rect x="0" y="0" width="10" height="4" />
          </g>
        </g>
        <g id="service-tag-ktx-2" class="service-tag" data-station="다음역">
          <rect x="500" y="500" width="10" height="10" />
        </g>
      </g>
    </svg>`;
  const obstacles = extractServiceTagObstacles(serviceSvg);
  // 자기폐쇄 <g/>를 depth로 세면 첫 블록이 다음 형제까지 삼켜 bbox가 부풀거나
  // 균형을 못 찾아 통째로 버려진다. 두 표장이 각자 정확한 bbox로 나와야 한다.
  assert.equal(obstacles.length, 2);
  assert.deepEqual(obstacles[0], {
    station: "테스트역",
    x: 105,
    y: 202,
    halfWidth: 5,
    halfHeight: 2,
  });
  assert.deepEqual(obstacles[1], {
    station: "다음역",
    x: 505,
    y: 505,
    halfWidth: 5,
    halfHeight: 5,
  });

  const railSvg = `
    <svg>
      <g id="rail-transfer-layer">
        <g id="chip-1" data-services="KTX" data-station-name="테스트역">
          <g id="spacer" data-note="빈 자리표시" />
          <g id="logo" transform="translate(100 200)">
            <rect x="0" y="0" width="10" height="4" />
          </g>
        </g>
      </g>
    </svg>`;
  const railObstacles = extractRailTransferChipObstacles(railSvg);
  assert.equal(railObstacles.length, 1);
  assert.deepEqual(railObstacles[0], {
    station: "테스트역",
    x: 105,
    y: 202,
    halfWidth: 5,
    halfHeight: 2,
  });
});

// 블록·중첩 층위의 fail-closed 가드는 공개 진입점으로 도달할 수 없다 — 레이어
// 슬라이스가 균형을 이루면 그 안은 well-nested가 보장돼, 블록이 닫히지 않은
// 입력은 레이어 스캔이 먼저 잡는다. 아래 첫 테스트가 그 사실을 실측으로 고정하고
// (어떤 배치든 예외가 레이어 층위에서 난다), 둘째 테스트가 블록·중첩 층위 가드를
// matchingGroupEnd 직접 호출로 덮는다.
test("블록 미종료 입력은 어떤 배치든 레이어 층위 fail-closed가 먼저 잡는다", () => {
  const layerMessage = /service-tags-layer의 닫는 태그를 찾지 못했습니다/;
  // 블록만 닫히지 않은 형태(레이어 닫는 태그를 블록이 흡수한다).
  assert.throws(
    () =>
      extractServiceTagObstacles(
        '<svg><g id="service-tags-layer"><g id="service-tag-ktx-1" class="service-tag" data-station="테스트역"><rect x="0" y="0" width="10" height="4" /></g>',
      ),
    layerMessage,
  );
  // 블록 안 중첩 <g> 2개가 닫히지 않은 형태.
  assert.throws(
    () =>
      extractServiceTagObstacles(
        '<svg><g id="service-tags-layer"><g id="service-tag-ktx-1" class="service-tag" data-station="테스트역"><g id="a"><g id="b"></g></g></g></svg>',
      ),
    layerMessage,
  );
  // 잉여 </g>가 블록 앞에 온 형태 — 레이어 슬라이스가 블록 전에 끝나 표장 0건.
  assert.deepEqual(
    extractServiceTagObstacles(
      '<svg><g id="service-tags-layer"></g><g id="service-tag-ktx-1" class="service-tag" data-station="테스트역"><rect x="0" y="0" width="10" height="4" /></g></svg>',
    ),
    [],
  );
});

test("matchingGroupEnd: 블록·중첩 층위 가드 — 자기폐쇄는 태그 끝, 미종료는 실패한다", () => {
  // 자기폐쇄 여는 태그는 그 태그 하나가 곧 빈 그룹이다.
  const selfClosing = '<g id="spacer" data-note="빈 자리표시" /><rect />';
  assert.equal(
    matchingGroupEnd(selfClosing, 0, "블록"),
    '<g id="spacer" data-note="빈 자리표시" />'.length,
  );

  // 내부 자기폐쇄 <g/>는 depth를 올리지 않는다 — 형제까지 삼키지 않는다.
  const withInnerSelfClosing =
    '<g id="a"><g id="spacer" /><rect /></g><g id="b"></g>';
  assert.equal(
    matchingGroupEnd(withInnerSelfClosing, 0, "블록"),
    withInnerSelfClosing.indexOf("</g>") + "</g>".length,
  );

  // 닫는 태그가 없으면 부분 슬라이스로 넘기지 않고 실패한다(fail-closed).
  assert.throws(
    () =>
      matchingGroupEnd(
        '<g id="service-tag-ktx-1"><rect />',
        0,
        "service-tag 블록(테스트역)",
      ),
    /service-tag 블록\(테스트역\)의 닫는 태그를 찾지 못했습니다/,
  );
  // 중첩이 하나 더 열려 균형이 모자란 경우도 동일하다.
  assert.throws(
    () => matchingGroupEnd('<g id="a"><g id="b"></g>', 0, "중첩 <g>(a)"),
    /중첩 <g>\(a\)의 닫는 태그를 찾지 못했습니다/,
  );
  // 여는 <g> 태그로 시작하지 않으면 해석 실패로 알린다.
  assert.throws(
    () => matchingGroupEnd("<rect />", 0, "블록"),
    /블록의 여는 <g> 태그를 해석하지 못했습니다/,
  );
});

test("extractServiceTagObstacles: service-tag <g>의 id가 첫 속성이 아니어도 인식한다(속성 순서 무관)", () => {
  const svgText = `
    <svg>
      <g id="service-tags-layer">
        <g class="service-tag" transform="translate(10 20)" data-station="테스트역" id="service-tag-ktx-9">
          <rect x="0" y="0" width="10" height="4" />
        </g>
      </g>
    </svg>`;
  const obstacles = extractServiceTagObstacles(svgText);
  assert.equal(obstacles.length, 1);
  assert.equal(obstacles[0].station, "테스트역");
  assert.deepEqual(obstacles[0], {
    station: "테스트역",
    x: 15,
    y: 22,
    halfWidth: 5,
    halfHeight: 2,
  });
});

// #2068 SVG 충실도(2026-07-26): rotate는 "미지원 → throw"가 아니라 정확한 회전
// 행렬로 지원한다 — 오너 부산 v3 재수정본이 환승 심벌·종점 배지에 rotate(±90,cx,cy)를
// 쓰기 때문이다. skew 등 나머지는 여전히 fail-closed(조용한 항등 무시 금지).
test("parseTransformChain: rotate(a,cx,cy)를 정확히 합성한다(항등 무시도 실패도 아님)", () => {
  const rotatedLayer = `
    <svg>
      <g id="service-tags-layer" transform="rotate(-90,100,200)">
        <g id="service-tag-ktx-1" class="service-tag" data-station="테스트역">
          <rect x="100" y="200" width="10" height="4" />
        </g>
      </g>
    </svg>`;
  // 회전 중심 (100,200) 기준 -90°: 로컬 [100,110]×[200,204] →
  // (x,y) → (cx + (y-cy), cy - (x-cx)) = [100,104]×[190,200].
  const [rotated] = extractServiceTagObstacles(rotatedLayer);
  assert.equal(rotated.station, "테스트역");
  assert.ok(Math.abs(rotated.x - 102) < 1e-6, `x=${rotated.x}`);
  assert.ok(Math.abs(rotated.y - 195) < 1e-6, `y=${rotated.y}`);
  assert.ok(Math.abs(rotated.halfWidth - 2) < 1e-6);
  assert.ok(Math.abs(rotated.halfHeight - 5) < 1e-6);
});

test("parseTransformChain: 여전히 미지원인 transform(skew)은 항등 무시가 아니라 실패한다", () => {
  const skewedChip = `
    <svg>
      <g id="rail-transfer-layer">
        <g id="chip-1" data-services="KTX" data-station-name="테스트역" transform="skewX(10)">
          <rect x="0" y="0" width="10" height="4" />
        </g>
      </g>
    </svg>`;
  assert.throws(
    () => extractRailTransferChipObstacles(skewedChip),
    /지원하지 않는 transform 함수 skewX\(\.\.\.\)/,
  );

  // 지원 함수 조합은 그대로 통과한다(회귀 가드).
  const supported = `
    <svg>
      <g id="service-tags-layer" transform="matrix(2,0,0,3,100,200)">
        <g id="service-tag-ktx-1" class="service-tag" data-station="테스트역" transform="translate(10 20) scale(2)">
          <rect x="0" y="0" width="5" height="1" />
        </g>
      </g>
    </svg>`;
  const [obstacle] = extractServiceTagObstacles(supported);
  assert.equal(obstacle.station, "테스트역");
  assert.equal(obstacle.halfWidth, 10); // 5 × scale 2 × matrix a 2 → 폭 20.
  assert.equal(obstacle.halfHeight, 3); // 1 × 2 × 3 → 높이 6.
});

test("extractServiceTagObstacles·extractRailTransferChipObstacles: 닫히지 않은 표장 레이어는 빈 배열이 아니라 실패한다(fail-closed)", () => {
  const serviceSvg =
    '<svg><g id="service-tags-layer"><g id="service-tag-ktx-1" class="service-tag" data-station="테스트역"><rect x="0" y="0" width="10" height="4" /></g></svg>';
  assert.throws(
    () => extractServiceTagObstacles(serviceSvg),
    /service-tags-layer의 닫는 태그를 찾지 못했습니다/,
  );
  const railSvg =
    '<svg><g id="rail-transfer-layer"><g id="chip-1" data-services="KTX"><rect x="0" y="0" width="10" height="4" /></g></svg>';
  assert.throws(
    () => extractRailTransferChipObstacles(railSvg),
    /rail-transfer-layer의 닫는 태그를 찾지 못했습니다/,
  );
});

test("extractServiceTagObstacles: 자기폐쇄로 마감된 빈 표장 레이어는 빈 목록이다(부산 v3 실 SVG)", () => {
  const svgText = readFileSync(
    path.join(
      import.meta.dirname,
      "route-map-defs/svg-sources/easy-subway-busan-v3.svg",
    ),
    "utf8",
  );
  assert.match(svgText, /<g\b[^>]*\bid="service-tags-layer"[^>]*?\/>/);
  assert.deepEqual(extractServiceTagObstacles(svgText), []);
});

test("extractServiceTagObstacles: 대구 동대구역 KTX·SRT 표장 bbox가 Chrome 실측과 일치한다", () => {
  // Chrome(headless, getBBox/getScreenCTM) 실측 — root viewBox 사용자 좌표.
  // 이 값은 오너 도식이 실제로 렌더하는 위치이며, 동대구역 환승 라벨 실측
  // bbox(minX=2344.771)와 4.19px 떨어져 있어 겹치지 않는다.
  const svgText = readFileSync(
    path.join(
      import.meta.dirname,
      "route-map-defs/svg-sources/easy-subway-daegu-v3.svg",
    ),
    "utf8",
  );
  const [obstacle] = extractServiceTagObstacles(svgText);
  assert.equal(obstacle.station, "동대구역");
  const measured = {
    minX: 2277.7148,
    minY: 839.9228,
    maxX: 2340.5828,
    maxY: 866.0353,
  };
  const actual = {
    minX: obstacle.x - obstacle.halfWidth,
    minY: obstacle.y - obstacle.halfHeight,
    maxX: obstacle.x + obstacle.halfWidth,
    maxY: obstacle.y + obstacle.halfHeight,
  };
  for (const edge of ["minX", "minY", "maxX", "maxY"]) {
    assert.ok(
      Math.abs(actual[edge] - measured[edge]) < 0.01,
      `${edge}: 산정 ${actual[edge]} vs Chrome 실측 ${measured[edge]}`,
    );
  }
  // 표장 오른쪽 끝이 라벨 왼쪽 끝(실측 2344.771)보다 왼쪽 — 겹침 없음.
  assert.ok(actual.maxX < 2344.771);
});

test("extractServiceTagObstacles·extractRailTransferChipObstacles: 비수도권 4권역 obstacle 좌표가 커밋된 sidecar와 일치한다(회귀 가드)", () => {
  const svgSourceDir = path.join(
    import.meta.dirname,
    "route-map-defs/svg-sources",
  );
  for (const [id, file] of [
    ["busan", "easy-subway-busan-v3.svg"],
    ["daegu", "easy-subway-daegu-v3.svg"],
    ["daejeon", "easy-subway-daejeon-v3.svg"],
    ["gwangju", "easy-subway-gwangju-v3.svg"],
  ]) {
    const svgText = readFileSync(path.join(svgSourceDir, file), "utf8");
    assert.doesNotMatch(
      svgText,
      /<g\b[^>]*\bid="main-map-scaled-layer"[^>]*\btransform=/,
      `${id}: main-map-scaled-layer 부재 가정이 깨졌습니다(mapScale=1 전제 무효화)`,
    );
    const obstacles = [
      ...extractServiceTagObstacles(svgText),
      ...extractRailTransferChipObstacles(svgText),
    ];
    const sidecar = JSON.parse(
      readFileSync(
        path.join(
          import.meta.dirname,
          "../../apps/mobile/assets/datapacks/metro_map_pack/basemap/labels.json",
        ),
        "utf8",
      ),
    );
    assert.deepEqual(
      obstacles,
      sidecar.serviceTagObstacles[id],
      `${id}: mapScale 리팩토링 전후 obstacle 좌표가 달라졌습니다`,
    );
  }
});

// #2068 오너 v4 회귀 가드 — 종점 칩 글자 크기 이중 스케일.
//
// 렌더러가 칩 텍스트에 적용하는 실효 배율은 (칩 그룹 스케일 s × 맵 레이어 스케일
// k)다. 따라서 .vec에 적히는 font-size는 로컬 원값 L이어야 최종 렌더 em이 오너
// 의도값 L×s×k가 된다. v2는 s×k≈1(2.198×0.455)이라 어떤 계수를 써도 티가 안
// 났지만, v4(matrix 2.7475, s×k=1.25)에서 `×s` 계수가 칩 숫자를 1.25배 키우고
// 캡슐 중심 위로 띄웠다(badge center 게이트 실측 ratio -0.19).
test("foldTerminalChipScale: 칩 텍스트 font-size는 그룹 스케일과 무관하게 로컬 원값이다", () => {
  const chipSvg = (chipTransform) => `
    <svg id="seoul-metro-map" viewBox="0 0 100 100">
      <g id="main-map-scaled-layer" transform="translate(10 20) scale(0.455)">
        <g id="route-lines-layer"></g>
        <g id="terminal-route-badges-layer">
          <g class="ui-chip terminal-route-badge" transform="${chipTransform}">
            <rect x="0" y="0" width="30" height="23" rx="11.5" fill="#004a85" />
            <text x="15" y="11.5" font-size="10.5" text-anchor="middle"
                  dominant-baseline="central">1</text>
          </g>
        </g>
      </g>
    </svg>
  `;
  const fontSizeOf = (svg) =>
    Number(
      /<text\b[^>]*\bfont-size="([\d.]+)"/.exec(normalizeSvgForCompile(svg))[1],
    );
  const yOf = (svg) =>
    Number(/<text\b[^>]*\sy="([\d.]+)"/.exec(normalizeSvgForCompile(svg))[1]);

  // v4형(matrix)·v2형(translate scale translate) 모두 로컬 원값 10.5로 남는다.
  assert.equal(fontSizeOf(chipSvg("matrix(2.7475,0,0,2.7475,5,7)")), 10.5);
  assert.equal(
    fontSizeOf(chipSvg("translate(5 7) scale(2.198) translate(-15 -11.5)")),
    10.5,
  );
  // central baseline 보정은 로컬 프레임 기준 0.35×L만큼 y를 내린다(그룹 스케일 무관).
  assert.equal(yOf(chipSvg("matrix(2.7475,0,0,2.7475,5,7)")), 11.5 + 0.35 * 10.5);
});

test("easy-subway-sma-v4: 종점 칩 라벨은 오너 로컬 font-size를 그대로 컴파일한다", () => {
  const sources = path.join(import.meta.dirname, "route-map-defs/svg-sources");
  const normalized = normalizeSvgForCompile(
    readFileSync(path.join(sources, "easy-subway-sma-v4.svg"), "utf8"),
  );
  const label = /<text\b[^>]*\bid="terminal-1-56-header-route-badge-1-label"[^>]*>/.exec(
    normalized,
  );
  assert.ok(label, "신창(1호선) 종점 칩 라벨을 찾지 못했습니다.");
  assert.equal(Number(/\bfont-size="([\d.]+)"/.exec(label[0])[1]), 10.5);
  assert.equal(
    Number(/\sy="([\d.]+)"/.exec(label[0])[1]),
    Number((88.134506 + 0.35 * 10.5).toFixed(4)),
  );
});

// #2068 리뷰 A6: 칩 폰트 면제 표식이 <text>에만 붙으면, 소비 측
// scaleStyleFontSize가 <text|tspan> 양쪽을 대상으로 잡으므로 칩 내부 tspan의
// style font-size만 ×k돼 한 칩 안에 두 배율이 섞인다(v4 실측 해당 tspan 0건 —
// 잠복 결함). 표식이 tspan에도 붙어 로컬 원값이 유지되는지 고정한다.
test("foldTerminalChipScale: 칩 내부 tspan의 style font-size도 맵 스케일 ×k에서 면제된다", () => {
  const normalized = normalizeSvgForCompile(`
    <svg id="seoul-metro-map" viewBox="0 0 100 100">
      <g id="main-map-scaled-layer" transform="translate(10 20) scale(0.455)">
        <g id="route-lines-layer"></g>
        <g id="terminal-route-badges-layer">
          <g class="ui-chip terminal-route-badge" transform="matrix(2.7475,0,0,2.7475,5,7)">
            <rect x="0" y="0" width="30" height="23" rx="11.5" fill="#004a85" />
            <text x="15" y="11.5" font-size="10.5" text-anchor="middle"
                  dominant-baseline="central"><tspan x="15" y="11.5"
                  style="font-size:10.5px">1</tspan></text>
          </g>
        </g>
      </g>
    </svg>
  `);
  const tspan = /<tspan\b[^>]*>/.exec(normalized)[0];
  // 로컬 원값 10.5 그대로여야 한다(×k = 4.7775가 되면 안 된다).
  assert.match(tspan, /font-size:10\.5px/);
  // 면제 표식은 컴파일 입력에 남지 않는다.
  assert.doesNotMatch(normalized, /data-basemap-chip-font-exempt/);
  // 칩 밖 텍스트는 기존대로 ×k 된다(면제가 전역으로 새지 않는지 대조).
  const outside = normalizeSvgForCompile(`
    <svg id="seoul-metro-map" viewBox="0 0 100 100">
      <g id="main-map-scaled-layer" transform="translate(10 20) scale(0.455)">
        <g id="route-lines-layer"></g>
        <g id="station-symbols-layer">
          <text x="5" y="5" font-size="10"><tspan x="5" y="5" style="font-size:10px">A</tspan></text>
        </g>
      </g>
    </svg>
  `);
  assert.match(outside, /font-size:4\.55px/);
});
