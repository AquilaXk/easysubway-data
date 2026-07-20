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

test("5권역 basemap에는 노선·기존 역 심벌만 남기고 미개통 노선을 제외한다", () => {
  const sources = path.join(import.meta.dirname, "route-map-defs/svg-sources");
  const files = [
    "easy-subway-sma-v2.svg",
    "easy-subway-busan-v1.svg",
    "easy-subway-daegu-v1.svg",
    "easy-subway-daejeon-v1.svg",
    "easy-subway-gwangju-v1.svg",
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
    assert.doesNotMatch(rendered, /station-name-labels-layer|header-|legend/);
    assert.doesNotMatch(rendered, /<title\b/);
  }

  const daejeon = normalizeSvgForCompile(
    readFileSync(path.join(sources, "easy-subway-daejeon-v1.svg"), "utf8"),
  );
  assert.doesNotMatch(daejeon, /data-state="construction"/);
  assert.equal(
    (daejeon.match(/data-role="current-line-station"/g) ?? []).length,
    5,
  );

  const gwangju = normalizeSvgForCompile(
    readFileSync(path.join(sources, "easy-subway-gwangju-v1.svg"), "utf8"),
  );
  assert.doesNotMatch(gwangju, /data-line="line2-phase/);
  assert.equal(
    (gwangju.match(/data-role="current-line-station"/g) ?? []).length,
    2,
  );
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
  const entries = extractOwnerLabels(`
    <svg>
      <text data-label-role="transfer" font-size="58" x="572" y="740"
            data-full-official-name="1호선 대동 | 2호선 208 대동(하늘공원)"
            ><tspan class="station-main" x="572" dy="0">대동</tspan><tspan
             class="station-sub" x="572" dy="44.11" font-size="37.58px">하늘공원</tspan></text>
    </svg>
  `);
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

test("extractOwnerLabels: 속성형 text-anchor가 style형보다 우선한다", () => {
  const entries = extractOwnerLabels(`
    <svg>
      <text data-station="가야" data-label-role="ordinary" text-anchor="end"
            font-size="12.5" x="1958" y="1430" style="text-anchor:middle"
            >가야</text>
    </svg>
  `);
  assert.equal(entries[0].anchor, "end");
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
  const entries = extractOwnerLabels(`
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
  `);
  const byStation = Object.fromEntries(entries.map((e) => [e.station, e]));
  assert.ok(byStation["대동"], "복합 표기 flatten(대동하늘공원) 대신 canonical 키(대동)여야 한다");
  assert.ok(!byStation["대동하늘공원"]);
  assert.ok(byStation["대전"], "역 접미 정규화(대전역→대전)까지 적용돼야 한다");
  assert.ok(!byStation["대전역"]);
  assert.ok(byStation["구암"], "data-full-official-name이 단순 역명이면 그대로 유지");
});

test("extractOwnerLabels: 5권역 실 SVG에서 ordinary/transfer/terminal 개수가 실측과 일치한다", () => {
  const sources = path.join(import.meta.dirname, "route-map-defs/svg-sources");
  const expected = {
    // #2068 오너 v3(최종 디자인) 통합(2026-07-20): 오너가 처음부터 새로 그린
    // 확정본으로 easy-subway-sma-v2.svg 자체가 교체됐다 — 이 수는 실측치라
    // 새 소스의 실제 라벨 구성을 그대로 반영한다(ordinary 502→501, v3 자체
    // 라벨 구성 차이. transfer는 불변. terminal 30은 이식한 종점 마크 30개와
    // 정확히 일치 — 형상 비침습 기계 이식, 위치는 v3 역 좌표 기준 재계산).
    "easy-subway-sma-v2.svg": { ordinary: 501, transfer: 124, terminal: 30 },
    // #2068 벡스코 병합: 2호선·동해선을 단일 환승 station_id로 합치면서, 동해선
    // 노드용 중복 ordinary 라벨(벡스코_DH)을 제거했다(단일 환승 캡슐이 전사 라벨을
    // 이미 가지므로 중복 표기 불필요) → ordinary 129→128.
    "easy-subway-busan-v1.svg": { ordinary: 128, transfer: 12, terminal: 7 },
    "easy-subway-daegu-v1.svg": { ordinary: 84, transfer: 5, terminal: 8 },
    // daejeon: SVG상 ordinary/transfer/terminal 64건 중 39건이 미개통(2호선
    // 트램) data-status="construction"이라 제외 → 25건(15/8/2)만 남는다.
    "easy-subway-daejeon-v1.svg": { ordinary: 15, transfer: 8, terminal: 2 },
    "easy-subway-gwangju-v1.svg": { ordinary: 53, transfer: 7, terminal: 2 },
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

test("build manifest가 source·normalized·vec hash와 viewBox를 결합한다", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const manifest = JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, "basemap-build-manifest.json"),
      "utf8",
    ),
  );
  assert.equal(manifest.compiler.version, "1.2.6");
  assert.deepEqual(manifest.content, {
    svgLayer: "route-lines-and-station-symbols",
    stationSymbols: "owner-svg",
    labels: "owner-svg-anchor-with-solver-fallback",
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
    const ownerLabels = extractOwnerLabels(source.toString("utf8"));
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

test("extractServiceTagObstacles·extractRailTransferChipObstacles: main-map-scaled-layer가 없는 권역(busan·daegu·daejeon·gwangju)은 mapScale=1로 obstacle 좌표가 항등 변환된다(회귀 가드)", () => {
  const svgSourceDir = path.join(
    import.meta.dirname,
    "route-map-defs/svg-sources",
  );
  for (const [id, file] of [
    ["busan", "easy-subway-busan-v1.svg"],
    ["daegu", "easy-subway-daegu-v1.svg"],
    ["daejeon", "easy-subway-daejeon-v1.svg"],
    ["gwangju", "easy-subway-gwangju-v1.svg"],
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
