// #2603 캔버스 여백 게이트 — 잉크가 viewBox 안에 있는지 5권역 전수 검사한다.
//
// 배경: 오너 SVG의 viewBox를 잉크에 맞춰 조이면서 우·하단 여유가 39~147단위로
// 줄었다. 여유가 이렇게 얇으면 오너가 가장자리에 요소를 하나 더 얹는 순간
// 캔버스를 넘어서는데, 그걸 잡는 검사가 지금까지 없었다
// (`compile-basemap-vec.test.mjs`는 manifest viewBox의 **길이(4)** 만 봤다).
//
// 넘어선 요소가 어떻게 되는지는 실측해 뒀다: 컴파일러는 viewBox 밖 도형을
// 잘라내지 않고 `.vec`에 그대로 남긴다(viewBox 밖 원을 넣으면 산출물이 156→295
// 바이트로 커진다). 즉 "무성 클립"은 아니다. 그래도 캔버스와 잉크가 어긋나면
// 캔버스 크기를 기준으로 삼는 판단이 전부 틀어지고, 런타임·플랫폼에 따라 컬링될
// 여지도 남는다. 그래서 어긋남 자체를 상시로 막는다.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EXCLUDED_DECOR_LAYER_ID_SET,
  normalizeSvgForCompile,
} from "./compile-basemap-vec.mjs";
import {
  FULL_CANVAS_DECOR_IDS,
  inkBBoxOf,
  viewBoxOf,
} from "./svg-ink-bbox.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const svgDir = path.join(here, "route-map-defs", "svg-sources");

const REGIONS = [
  { id: "seoul", svg: "easy-subway-sma-v4.svg" },
  { id: "busan", svg: "easy-subway-busan-v3.svg" },
  { id: "daegu", svg: "easy-subway-daegu-v3.svg" },
  { id: "daejeon", svg: "easy-subway-daejeon-v3.svg" },
  { id: "gwangju", svg: "easy-subway-gwangju-v3.svg" },
];

/**
 * 크롭 결과 여유(단위: source px) 기준선.
 *
 * 우·하단은 #2603 크롭이 `max(잉크 짧은변 3%, 최대 라벨 1줄 높이)`로 정한 값이고,
 * 좌·상단은 크롭하지 않아 원본 여백이 그대로 남은 값이다(후속 과제). 이 표가
 * 흔들리면 잉크나 캔버스 중 하나가 바뀐 것이므로 의도된 변경인지 확인해야 한다.
 *
 * 대구는 잉크가 원본 캔버스를 이미 x=4510까지 채우고 있어 목표 여유(75)를 넣지
 * 못하고 원본 경계로 클램프했다 — 그래서 우측이 50이다.
 */
const EXPECTED_MARGINS = {
  seoul: { left: 114.22, top: 309.51, right: 79.12, bottom: 79.93 },
  busan: { left: 725.45, top: 976.83, right: 146.9, bottom: 146.11 },
  daegu: { left: 34.55, top: 30.0, right: 50.0, bottom: 76.13 },
  daejeon: { left: 513.0, top: 273.81, right: 41.29, bottom: 44.47 },
  gwangju: { left: 443.0, top: 252.63, right: 39.13, bottom: 40.8 },
};

/** 기준선 허용 오차. 폰트 advance·곡선 극값 계산의 미세 변동만 흡수한다. */
const MARGIN_TOLERANCE = 1.0;

function normalizedOf(region) {
  return normalizeSvgForCompile(
    readFileSync(path.join(svgDir, region.svg), "utf8"),
  );
}

function measure(region) {
  const normalized = normalizedOf(region);
  const viewBox = viewBoxOf(normalized);
  const ink = inkBBoxOf(normalized, { excludeIds: FULL_CANVAS_DECOR_IDS });
  const [vx, vy, vw, vh] = viewBox;
  return {
    normalized,
    viewBox,
    ink,
    margins: {
      left: ink.minX - vx,
      top: ink.minY - vy,
      right: vx + vw - ink.maxX,
      bottom: vy + vh - ink.maxY,
    },
  };
}

test("잉크가 viewBox 안에 있다 — 5권역 전수(#2603 캔버스 여백 게이트)", () => {
  const failures = [];
  for (const region of REGIONS) {
    const { viewBox, ink, margins } = measure(region);
    const [vx, vy, vw, vh] = viewBox;
    for (const [side, value] of Object.entries(margins)) {
      if (value < 0) {
        const culprit = {
          left: ink.edges.minX,
          top: ink.edges.minY,
          right: ink.edges.maxX,
          bottom: ink.edges.maxY,
        }[side];
        failures.push(
          `${region.id}: ${side} 여유 ${value.toFixed(2)} < 0 — ` +
            `viewBox [${vx} ${vy} ${vw} ${vh}] 밖으로 ${(-value).toFixed(2)}단위 ` +
            `넘친 요소 ${culprit}`,
        );
      }
    }
  }
  assert.deepEqual(
    failures,
    [],
    "오너 SVG의 잉크가 캔버스(viewBox)를 넘어섰습니다 — 캔버스를 넓히거나 " +
      "요소를 안쪽으로 옮겨야 합니다:\n" + failures.join("\n"),
  );
});

test("권역별 크롭 여유 기준선(#2603)", () => {
  const actual = {};
  for (const region of REGIONS) {
    const { margins } = measure(region);
    actual[region.id] = margins;
  }
  const drift = [];
  for (const [id, expected] of Object.entries(EXPECTED_MARGINS)) {
    for (const [side, value] of Object.entries(expected)) {
      const measured = actual[id][side];
      if (Math.abs(measured - value) > MARGIN_TOLERANCE) {
        drift.push(
          `${id}.${side}: 기준선 ${value} ↔ 실측 ${measured.toFixed(2)} ` +
            `(Δ ${(measured - value).toFixed(2)}, 허용 ±${MARGIN_TOLERANCE})`,
        );
      }
    }
  }
  assert.deepEqual(
    drift,
    [],
    "크롭 여유가 기준선에서 벗어났습니다 — 잉크나 캔버스가 바뀐 것이니 " +
      "의도된 변경이면 EXPECTED_MARGINS를 갱신하세요:\n" + drift.join("\n"),
  );
});

test("viewBox 원점은 5권역 모두 0 0이다(#2603 .vec 앵커 이탈 방지)", () => {
  // 원점이 0이 아니면 vector_graphics_compiler가 그 값을 지오메트리에 굽고,
  // 앱(route_map_basemap_view)은 .vec 좌표 == 소스 좌표를 전제로 재생하므로
  // 바탕층이 통째로 어긋난다. 게다가 이탈량이 요소마다 달라(transform 없는
  // 배지는 1회, transform 붙은 역명은 y만 2회) 앱에서 되돌릴 수도 없다.
  for (const region of REGIONS) {
    const [x, y] = viewBoxOf(normalizedOf(region));
    assert.equal(x, 0, `${region.id}: viewBox x 원점은 0이어야 합니다.`);
    assert.equal(y, 0, `${region.id}: viewBox y 원점은 0이어야 합니다.`);
  }
});

test("경계 밖 요소를 넣으면 게이트가 실패한다(게이트 실효성 실증)", () => {
  const region = REGIONS.find((r) => r.id === "gwangju");
  const normalized = normalizedOf(region);
  const [vx, vy, vw, vh] = viewBoxOf(normalized);

  // 현행은 통과한다.
  const before = inkBBoxOf(normalized, { excludeIds: FULL_CANVAS_DECOR_IDS });
  assert.ok(before.maxX <= vx + vw, "주입 전에는 잉크가 캔버스 안이어야 합니다.");

  // 우측 경계 밖 20단위 지점에 요소를 하나 얹는다.
  const intruder =
    `<circle id="gate-probe-out-of-canvas" cx="${vx + vw + 20}" cy="100" r="5" fill="#000"/>`;
  const injected = normalized.replace("</svg>", `${intruder}</svg>`);
  const after = inkBBoxOf(injected, { excludeIds: FULL_CANVAS_DECOR_IDS });

  assert.ok(
    after.maxX > vx + vw,
    "경계 밖 요소를 넣었는데 잉크 bbox가 캔버스를 넘지 않았습니다 — " +
      "게이트가 잉크를 놓치고 있습니다.",
  );
  assert.equal(after.edges.maxX, '<circle id="gate-probe-out-of-canvas">');
  assert.ok(
    vy + vh - after.maxY >= 0,
    "세로 여유는 주입과 무관하게 유지돼야 합니다.",
  );
});

test("회전 도형은 변환된 네 모서리의 외곽으로 판정한다", () => {
  const svg =
    '<svg viewBox="0 0 10 10"><rect x="9" y="0" width="1" height="1" ' +
    'transform="rotate(45 9.5 .5)"/></svg>';
  assert.ok(
    inkBBoxOf(svg).maxX > 10,
    "회전된 사각형의 우측 모서리가 viewBox를 넘는 것을 잡아야 합니다.",
  );
});

test("텍스트 stroke 외곽이 viewBox를 넘으면 게이트가 실패한다", () => {
  const svg =
    '<svg viewBox="0 0 10 10"><text x="8" y="5" font-size="1" ' +
    'stroke="#000" stroke-width="4">A</text></svg>';
  assert.ok(
    inkBBoxOf(svg).maxX > 10,
    "텍스트 fill이 안쪽이어도 stroke 외곽이 경계를 넘으면 잡아야 합니다.",
  );
});

test("crop-viewbox는 유한한 양수 width/height만 허용한다", () => {
  const script = path.join(here, "svg-crop", "crop-viewbox.py");
  for (const [width, height] of [
    ["nan", "10"],
    ["0", "10"],
    ["10", "-1"],
  ]) {
    const result = spawnSync(
      "python3",
      [script, "gwangju", "0", "0", width, height, "--dry"],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0, `${width}×${height} viewBox가 거부돼야 합니다.`);
    assert.match(result.stderr, /유한수|0보다 커야/);
  }
});

test("장식 제외 집합 정합 — 헤더·범례는 정규화가 이미 걷어내고, 전면 배경만 잉크에서 뺀다", () => {
  for (const region of REGIONS) {
    const raw = readFileSync(path.join(svgDir, region.svg), "utf8");
    const normalized = normalizedOf(region);

    // 헤더·범례 레이어는 컴파일 입력 단계에서 이미 사라진다 → 잉크 계산이
    // 따로 제외할 필요가 없다(제외 목록을 이중으로 들고 있으면 drift 난다).
    for (const id of EXCLUDED_DECOR_LAYER_ID_SET) {
      assert.ok(
        !normalized.includes(`id="${id}"`),
        `${region.id}: 장식 레이어 ${id}가 컴파일 입력에 남아 있습니다.`,
      );
    }
    assert.ok(
      raw.length > 0,
      `${region.id}: 원본 SVG를 읽지 못했습니다.`,
    );

    // 전면 배경·그리드는 정규화가 남기므로 잉크 계산에서 빼야 한다. 남아 있는
    // 권역에서는 실제로 캔버스 전체를 덮는지 확인한다 — 그래야 "제외해도
    // 잉크를 잃지 않는다"가 성립한다.
    const [, , vw, vh] = viewBoxOf(normalized);
    for (const id of FULL_CANVAS_DECOR_IDS) {
      if (!normalized.includes(`id="${id}"`)) continue;
      const tag = normalized.match(
        new RegExp(`<rect\\b[^>]*\\bid="${id}"[^>]*>`),
      );
      assert.ok(tag, `${region.id}: ${id}는 <rect>여야 합니다.`);
      const width = Number(tag[0].match(/\bwidth="([^"]+)"/)?.[1]);
      const height = Number(tag[0].match(/\bheight="([^"]+)"/)?.[1]);
      assert.ok(
        width >= vw && height >= vh,
        `${region.id}: ${id}가 캔버스를 다 덮지 않습니다(${width}×${height} < ${vw}×${vh}) — ` +
          "잉크에서 빼면 실제 잉크를 잃습니다.",
      );
    }
  }
});

/**
 * `*-geometry.json`의 provenance가 현재 SVG와 어긋난 권역(#2606).
 *
 * 손으로 `sourceSvgSha256`만 갱신하면 안 된다 — `extract-svg-geometry.mjs`가
 * `sourceElementKey`를 그 sha로 만들기 때문에 파일 안에서 키와 provenance가
 * 모순된다. 제대로 고치려면 재추출 + `join-svg-label-polygons` 재실행이 필요하고,
 * 그건 datapack 좌표에 파급되므로 viewBox 전용 변경(#2603)과 섞지 않았다.
 *
 * 여기서는 **드리프트를 늘리지 못하게** 고정만 한다. #2606에서 해소하면 이
 * 목록을 비운다.
 */
const KNOWN_GEOMETRY_PROVENANCE_DRIFT = new Set([
  "seoul",
  "busan",
  "daegu",
  "daejeon",
  "gwangju",
]);

test("geometry.json provenance drift가 늘지 않는다(#2606 추적)", () => {
  const drifted = [];
  const fixed = [];
  for (const region of REGIONS) {
    const geometryPath = path.join(
      here,
      "route-map-defs",
      `${region.svg.replace(/\.svg$/, "")}-geometry.json`,
    );
    const geometry = JSON.parse(readFileSync(geometryPath, "utf8"));
    const actual = createHash("sha256")
      .update(readFileSync(path.join(svgDir, region.svg)))
      .digest("hex");
    if (geometry.sourceSvgSha256 === actual) fixed.push(region.id);
    else drifted.push(region.id);
  }

  const unexpected = drifted.filter(
    (id) => !KNOWN_GEOMETRY_PROVENANCE_DRIFT.has(id),
  );
  assert.deepEqual(
    unexpected,
    [],
    "geometry.json provenance가 새로 어긋났습니다 — SVG를 바꿨으면 #2606 절차대로 " +
      `재추출하세요: ${unexpected.join(", ")}`,
  );

  const staleEntries = fixed.filter((id) =>
    KNOWN_GEOMETRY_PROVENANCE_DRIFT.has(id),
  );
  assert.deepEqual(
    staleEntries,
    [],
    "provenance가 맞춰졌는데 drift 목록에 남아 있습니다 — " +
      `KNOWN_GEOMETRY_PROVENANCE_DRIFT에서 빼세요: ${staleEntries.join(", ")}`,
  );
});

test("알 수 없는 그리기 태그를 만나면 fail-closed로 던진다", () => {
  const svg =
    '<svg viewBox="0 0 10 10"><foreignObject x="0" y="0" width="5" height="5"/></svg>';
  assert.throws(
    () => inkBBoxOf(svg),
    /알 수 없는 태그 <foreignObject>/,
    "미지원 태그를 조용히 건너뛰면 잉크를 놓친 채 green이 됩니다.",
  );
});

test("곡선 외곽은 제어점이 아니라 실제 극값으로 잰다", () => {
  // 제어점 껍질을 쓰면 x가 100까지 벌어지지만, 3차 베지어의 실제 최대 x는 75다.
  const svg =
    '<svg viewBox="0 0 200 200"><path d="M 0 0 C 100 0 100 100 0 100"/></svg>';
  const ink = inkBBoxOf(svg);
  assert.ok(
    Math.abs(ink.maxX - 75) < 1e-6,
    `곡선 최대 x는 75여야 하는데 ${ink.maxX}입니다(제어점 껍질이면 100).`,
  );
});
