import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { MAX_OP_CHAIN_DISTANCE, mergeBasemapDraws } from "./merge-basemap-vec-draws.mjs";
import { decodeVec, encodeVec, VERB } from "./vec-codec.mjs";

const OPEN = { width: 10_000, height: 10_000 };
const RED = { style: "fill", color: 0xffff0000, blendMode: 3, shaderId: null };
const BLUE = { style: "fill", color: 0xff0000ff, blendMode: 3, shaderId: null };
const HALO = { style: "stroke", color: 0xffffffff, cap: 1, join: 1, blendMode: 3, miterLimit: 4, width: 4, shaderId: null };

function rect(x, y, w, h) {
  return {
    fillType: 0,
    verbs: Uint8Array.of(VERB.moveTo, VERB.lineTo, VERB.lineTo, VERB.lineTo, VERB.close),
    points: Float32Array.of(x, y, x + w, y, x + w, y + h, x, y + h),
  };
}

function line(x1, y1, x2, y2) {
  return { fillType: 0, verbs: Uint8Array.of(VERB.moveTo, VERB.lineTo), points: Float32Array.of(x1, y1, x2, y2) };
}

// draws: [paint, path][]. 같은 paint·같은 path 객체는 한 id로 적는다(컴파일러가 같은 값을
// 한 번만 적는 것과 같다).
function docOf(draws, extra = []) {
  const paints = [];
  const commands = [];
  const paths = [];
  const idOf = (list, value) => {
    const id = list.indexOf(value);
    return id < 0 ? list.push(value) - 1 : id;
  };
  for (const [paint, path] of draws) {
    commands.push({ op: "drawPath", pathId: idOf(paths, path), paintId: idOf(paints, paint), patternId: null });
  }
  for (const { at, command } of extra) commands.splice(at, 0, command);
  return decodeVec(encodeVec({ width: 1000, height: 1000, paints, paths, commands }));
}

// 이 장면들에서 합치기는 던지지 않는다. 던지면 호출한 테스트가 단언 실패로 끝나게 감싼다.
function mergeDraws(doc, layers = [], options = {}) {
  let merged;
  assert.doesNotThrow(() => {
    merged = mergeBasemapDraws(doc, layers, options);
  });
  return merged;
}

// 출력 draw마다 [paint, path 안 윤곽선 시작점 x 목록]. 시작점 x가 입력 도형을 가리킨다.
function drawsOf(doc) {
  return doc.commands
    .filter((command) => command.op === "drawPath")
    .map((command) => {
      const { verbs, points } = doc.paths[command.pathId];
      const starts = [];
      let cursor = 0;
      for (const verb of verbs) {
        if (verb === VERB.moveTo) starts.push(points[cursor]);
        cursor += [2, 2, 6, 0][verb];
      }
      return [doc.paints[command.paintId], starts];
    });
}

test("겹치지 않는 같은 paint 도형 둘은 path 하나·그리기 하나가 되고 두 윤곽선이 순서대로 남는다", () => {
  const { base } = mergeDraws(docOf([[RED, rect(0, 0, 10, 10)], [RED, rect(20, 0, 10, 10)]]), [], { maxExtent: OPEN });
  assert.deepEqual(drawsOf(base), [[RED, [0, 20]]]);
});

test("다른 paint가 사이에 있어도 겹치지 않으면 앞 묶음에 붙는다", () => {
  const draws = [[RED, rect(0, 0, 10, 10)], [BLUE, rect(0, 20, 10, 10)], [RED, rect(20, 0, 10, 10)]];
  const { base } = mergeDraws(docOf(draws), [], { maxExtent: OPEN });
  assert.deepEqual(drawsOf(base), [[RED, [0, 20]], [BLUE, [0]]]);
});

test("라벨 테두리·글자 교대는 두 그리기가 되고 둘이 이은 path 하나를 함께 쓴다", () => {
  const labels = [0, 100, 200].flatMap((x) => {
    const glyphs = rect(x, 0, 30, 10);
    return [[HALO, glyphs], [RED, glyphs]];
  });
  const { base } = mergeDraws(docOf(labels), [], { maxExtent: OPEN });
  assert.deepEqual(drawsOf(base), [[HALO, [0, 100, 200]], [RED, [0, 100, 200]]]);
  assert.equal(base.paths.length, 1);
});

test("여러 줄 라벨(줄마다 테두리, 다음에 줄마다 글자)은 줄을 이은 path 하나를 두 paint로 그린다", () => {
  const label = (x) => {
    const lines = [rect(x, 0, 30, 10), rect(x + 1, 20, 30, 10)];
    return [...lines.map((line) => [HALO, line]), ...lines.map((line) => [RED, line])];
  };
  const { base } = mergeDraws(docOf([...label(0), ...label(100)]), [], { maxExtent: OPEN });
  assert.deepEqual(drawsOf(base), [[HALO, [0, 1, 100, 101]], [RED, [0, 1, 100, 101]]]);
  assert.equal(base.paths.length, 1);
});

test("줄끼리 겹치는 여러 줄 라벨은 줄을 한 path로 잇지 않는다", () => {
  const lines = [rect(0, 0, 30, 10), rect(1, 9, 30, 10)];
  const draws = [...lines.map((line) => [HALO, line]), ...lines.map((line) => [RED, line])];
  assert.equal(mergeDraws(docOf(draws), [], { maxExtent: OPEN }).base.commands.length, 4);
});

test("사이의 다른 paint 도형과 겹치는 그리기는 앞으로 넘어가지 않는다(그리는 순서 보존)", () => {
  const draws = [[RED, rect(0, 0, 10, 10)], [BLUE, rect(15, 0, 10, 10)], [RED, rect(20, 0, 10, 10)]];
  const { base } = mergeDraws(docOf(draws), [], { maxExtent: OPEN });
  assert.deepEqual(drawsOf(base), [[RED, [0]], [BLUE, [15]], [RED, [20]]]);
});

test("같은 paint라도 영역이 겹치는 도형은 한 path로 잇지 않는다(감김수·반투명 겹침 보존)", () => {
  const { base } = mergeDraws(docOf([[RED, rect(0, 0, 10, 10)], [RED, rect(5, 5, 10, 10)]]), [], { maxExtent: OPEN });
  assert.equal(base.commands.length, 2);
});

test("변만 맞닿은 도형은 겹침이 아니다(넓이 있는 겹침만 막는다)", () => {
  const { base } = mergeDraws(docOf([[RED, rect(0, 0, 10, 10)], [RED, rect(10, 0, 10, 10)]]), [], { maxExtent: OPEN });
  assert.equal(base.commands.length, 1);
});

test("선 영역은 선 굵기만큼 넓혀 겹침을 본다", () => {
  const strokes = [[HALO, rect(0, 0, 10, 10)], [BLUE, rect(13, 0, 5, 5)], [HALO, rect(20, 0, 10, 10)]];
  const { base } = mergeDraws(docOf(strokes), [], { maxExtent: OPEN });
  // HALO 반폭 2 × miterLimit 무관(round join) → [−2,12]와 BLUE [13,18]은 안 겹치고
  // [18,32]와는 변만 닿는다. 첫째 HALO 묶음에 셋째가 붙는다.
  assert.deepEqual(drawsOf(base), [[HALO, [0, 20]], [BLUE, [13]]]);
  // BLUE [13,19]는 셋째 HALO의 path [20,30]과는 떨어져 있지만 선 영역 [18,32]와 겹친다.
  const touching = [[HALO, rect(0, 0, 10, 10)], [BLUE, rect(13, 0, 6, 5)], [HALO, rect(20, 0, 10, 10)]];
  assert.equal(mergeDraws(docOf(touching), [], { maxExtent: OPEN }).base.commands.length, 3);
});

test("사각 끝 선은 반폭의 √2배까지 넓혀 겹침을 본다", () => {
  const square = { ...HALO, cap: 2 };
  // 셋째 선 [20,30]은 반폭 2로는 [18,32]라 BLUE [16,17.5]를 넘어 첫째와 묶이지만,
  // 사각 끝 2√2로는 [17.17,32.83]이라 BLUE와 겹쳐 넘어가지 못한다.
  const draws = [[square, line(0, 5, 10, 5)], [BLUE, rect(16, 0, 1.5, 10)], [square, line(20, 5, 30, 5)]];
  assert.equal(mergeDraws(docOf(draws), [], { maxExtent: OPEN }).base.commands.length, 3);
});

// 원점이 0이 아닌 장면에서도 크기는 (끝 − 시작)이다. 양수·음수 원점 모두에서 확인한다.
const ORIGINS = [[500, 500], [-200, -200], [500, -200], [-200, 500]];

test("묶음 크기는 끝에서 시작을 뺀 값으로 재며 원점이 어디든 같다(가로)", () => {
  for (const [ox, oy] of ORIGINS) {
    const draws = [[RED, rect(ox, oy, 10, 10)], [RED, rect(ox + 50, oy, 10, 10)], [RED, rect(ox + 95, oy, 10, 10)]];
    const { base } = mergeDraws(docOf(draws), [], { maxExtent: { width: 100, height: 100 } });
    assert.deepEqual(drawsOf(base), [[RED, [ox, ox + 50]], [RED, [ox + 95]]], `원점 ${ox},${oy}`);
  }
});

test("묶음 크기는 끝에서 시작을 뺀 값으로 재며 원점이 어디든 같다(세로)", () => {
  for (const [ox, oy] of ORIGINS) {
    const draws = [[RED, rect(ox, oy, 10, 10)], [RED, rect(ox + 20, oy + 50, 10, 10)], [RED, rect(ox + 40, oy + 95, 10, 10)]];
    const { base } = mergeDraws(docOf(draws), [], { maxExtent: { width: 100, height: 100 } });
    assert.deepEqual(drawsOf(base), [[RED, [ox, ox + 20]], [RED, [ox + 40]]], `원점 ${ox},${oy}`);
  }
});

test("출하하는 묶음 상한 256은 가로·세로 모두 256까지는 묶고 넘으면 가른다", () => {
  const horizontal = (right) => docOf([[RED, rect(500, 0, 10, 10)], [RED, rect(right - 10, 0, 10, 10)]]);
  const vertical = (bottom) => docOf([[RED, rect(0, 500, 10, 10)], [RED, rect(20, bottom - 10, 10, 10)]]);
  assert.equal(mergeDraws(horizontal(756)).base.commands.length, 1);
  assert.equal(mergeDraws(horizontal(757)).base.commands.length, 2);
  assert.equal(mergeDraws(vertical(756)).base.commands.length, 1);
  assert.equal(mergeDraws(vertical(757)).base.commands.length, 2);
});

test(`앞으로 거슬러 보는 묶음 수는 Skia kMaxOpChainDistance(${MAX_OP_CHAIN_DISTANCE})까지다`, () => {
  const between = (count) =>
    Array.from({ length: count }, (_, index) => [
      { ...BLUE, color: 0xff000000 + index },
      rect(100 + 20 * index, 0, 10, 10),
    ]);
  const within = [[RED, rect(0, 0, 10, 10)], ...between(MAX_OP_CHAIN_DISTANCE - 1), [RED, rect(0, 50, 10, 10)]];
  assert.equal(mergeDraws(docOf(within), [], { maxExtent: OPEN }).base.commands.length, MAX_OP_CHAIN_DISTANCE);
  const beyond = [[RED, rect(0, 0, 10, 10)], ...between(MAX_OP_CHAIN_DISTANCE), [RED, rect(0, 50, 10, 10)]];
  assert.equal(mergeDraws(docOf(beyond), [], { maxExtent: OPEN }).base.commands.length, MAX_OP_CHAIN_DISTANCE + 2);
});

test("clip·restore를 넘어 묶지 않는다", () => {
  const draws = [[RED, rect(0, 0, 10, 10)], [RED, rect(20, 0, 10, 10)]];
  const extra = [
    { at: 1, command: { op: "clipPath", pathId: 0 } },
    { at: 3, command: { op: "restore" } },
  ];
  const { base } = mergeDraws(docOf(draws, extra), [], { maxExtent: OPEN });
  assert.deepEqual(base.commands.map(({ op }) => op), ["drawPath", "clipPath", "drawPath", "restore"]);
});

// 텍스트 라벨 변형(#1495). 텍스트는 기기 서체로 그려 칠할 영역을 알 수 없고, 런타임은 글자 덩이를
// 다음 위치 갱신까지 미뤄 그린다(vector_graphics 1.2.3 listener.dart 629-750행). 그래서 위치 갱신과
// 텍스트 그리기는 장벽이라 아무것도 그 너머로 옮겨지지 않는다.
const LABEL = { xAnchorMultiplier: 0.5, fontSize: 12, fontWeight: 6, decoration: 0, decorationStyle: 0, decorationColor: 0, fontFamily: "Pretendard" };
const positionAt = (x) => ({ x, y: 30, dx: null, dy: null, reset: true, transform: null });
const drawAt = (pathId) => ({ op: "drawPath", pathId, paintId: 0, patternId: null });
const moveTo = (textPositionId) => ({ op: "updateTextPosition", textPositionId });
const haloText = (textId) => ({ op: "drawText", textId, fillId: null, strokeId: 1, patternId: null });
const fillText = (textId) => ({ op: "drawText", textId, fillId: 0, strokeId: null, patternId: null });

function labeledScene(commands, paints = [RED, HALO]) {
  return decodeVec(
    encodeVec({
      width: 1000,
      height: 1000,
      paints,
      paths: [rect(0, 0, 10, 10), rect(20, 0, 10, 10), rect(40, 0, 10, 10)],
      textPositions: [positionAt(100), positionAt(200)],
      texts: [{ ...LABEL, text: "서면" }, { ...LABEL, text: "부전" }],
      commands,
    }),
  );
}

// 명령마다 id가 아니라 가리키는 값. 다시 번호를 매겨도 같은 그림이면 같다.
function resolvedCommands(doc) {
  return doc.commands.map((command) => {
    switch (command.op) {
      case "drawPath":
        return [command.op, doc.paints[command.paintId], Array.from(doc.paths[command.pathId].points), command.patternId];
      case "updateTextPosition":
        return [command.op, doc.textPositions[command.textPositionId]];
      case "drawText":
        return [
          command.op,
          doc.texts[command.textId],
          doc.paints[command.fillId] ?? null,
          doc.paints[command.strokeId] ?? null,
          command.patternId,
        ];
      default:
        return [command.op];
    }
  });
}

test("텍스트 위치 갱신과 텍스트 그리기를 넘어 묶지 않고, 텍스트 명령은 같은 순서·같은 값으로 남는다", () => {
  const scene = labeledScene([drawAt(0), moveTo(0), haloText(0), drawAt(1), moveTo(0), fillText(0), drawAt(2)]);
  const { base } = mergeDraws(scene, [], { maxExtent: OPEN });
  assert.deepEqual(resolvedCommands(base), resolvedCommands(scene));
  assert.deepEqual(base.texts, [{ ...LABEL, text: "서면" }]);
  assert.deepEqual(base.textPositions, [positionAt(100)]);
});

test("텍스트가 없는 구간의 그리기는 전처럼 합치고, 텍스트 앞뒤 구간끼리는 합치지 않는다", () => {
  const scene = labeledScene([drawAt(0), drawAt(1), moveTo(1), fillText(1), drawAt(2)]);
  const { base } = mergeDraws(scene, [], { maxExtent: OPEN });
  assert.deepEqual(base.commands.map(({ op }) => op), ["drawPath", "updateTextPosition", "drawText", "drawPath"]);
  assert.deepEqual(drawsOf(base), [[RED, [0, 20]], [RED, [40]]]);
});

test("노선 강조 레이어의 텍스트는 바탕과 같은 값으로 남고, 레이어가 쓰는 텍스트만 다시 번호를 매긴다", () => {
  const scene = labeledScene([moveTo(0), fillText(0), drawAt(0), moveTo(1), haloText(1), moveTo(1), fillText(1), drawAt(1)]);
  const layer = labeledScene([moveTo(1), haloText(1), moveTo(1), fillText(1), drawAt(1)]);
  const merged = mergeDraws(scene, [{ name: "b", doc: layer }], { maxExtent: OPEN });
  const layerDoc = merged.layers[0].doc;
  assert.deepEqual(resolvedCommands(layerDoc), resolvedCommands(layer));
  assert.deepEqual(layerDoc.texts, [{ ...LABEL, text: "부전" }]);
  assert.deepEqual(layerDoc.textPositions, [positionAt(200)]);
  assert.deepEqual(resolvedCommands(merged.base), resolvedCommands(scene));
});

test("바탕 순서에 없는 텍스트를 그리는 레이어는 실패한다", () => {
  const scene = labeledScene([moveTo(0), fillText(0), drawAt(0)]);
  const layer = labeledScene([moveTo(0), fillText(1), drawAt(0)]);
  assert.throws(() => mergeBasemapDraws(scene, [{ name: "b", doc: layer }]), /b: 그리기 명령 1번이 바탕 순서에 없습니다/);
  const recolored = labeledScene([moveTo(0), fillText(0), drawAt(0)], [BLUE, HALO]);
  assert.throws(() => mergeBasemapDraws(scene, [{ name: "b", doc: recolored }]), /b: 그리기 명령 1번이 바탕 순서에 없습니다/);
});

test("무늬 정의(pattern ~ restore) 안의 그리기는 밖의 그리기와 묶지 않는다", () => {
  const draws = [[RED, rect(0, 0, 10, 10)], [RED, rect(20, 0, 10, 10)]];
  const identity = Float64Array.from({ length: 16 }, (_, i) => (i % 5 === 0 ? 1 : 0));
  const extra = [
    { at: 0, command: { op: "pattern", x: 0, y: 0, width: 44, height: 44, transform: identity } },
    { at: 2, command: { op: "restore" } },
  ];
  const { base } = mergeDraws(docOf(draws, extra), [], { maxExtent: OPEN });
  assert.deepEqual(base.commands.map(({ op }) => op), ["pattern", "drawPath", "restore", "drawPath"]);
});

test("무늬를 쓰는 그리기는 같은 paint라도 묶지 않고 무늬 id를 지킨다", () => {
  const identity = Float64Array.from({ length: 16 }, (_, i) => (i % 5 === 0 ? 1 : 0));
  const extra = [
    { at: 0, command: { op: "pattern", x: 0, y: 0, width: 44, height: 44, transform: identity } },
    { at: 1, command: { op: "restore" } },
  ];
  const doc = docOf([[RED, rect(0, 0, 10, 10)], [RED, rect(20, 0, 10, 10)], [RED, rect(40, 0, 10, 10)]], extra);
  doc.commands[3].patternId = 0;
  const { base } = mergeDraws(doc, [], { maxExtent: OPEN });
  assert.deepEqual(
    base.commands.filter(({ op }) => op === "drawPath").map(({ patternId }) => patternId),
    [null, 0, null],
  );
});

test("넓이가 없는 채우기는 아무것도 칠하지 않으므로 빠지고, 같은 path의 선은 남는다", () => {
  const segment = line(0, 0, 0, 40);
  const { base } = mergeDraws(docOf([[RED, segment], [HALO, segment]]), [], { maxExtent: OPEN });
  assert.deepEqual(drawsOf(base), [[HALO, [0]]]);
});

test("다른 노선 레이어 집합에 속한 그리기는 묶지 않고, 레이어는 바탕의 부분 수열로 남는다", () => {
  const a = [RED, rect(0, 0, 10, 10)];
  const b = [RED, rect(20, 0, 10, 10)];
  const c = [RED, rect(40, 0, 10, 10)];
  const base = docOf([a, b, c]);
  const layers = [
    { name: "line-1", doc: docOf([a, c]) },
    { name: "line-2", doc: docOf([b]) },
  ];
  const merged = mergeDraws(base, layers, { maxExtent: OPEN });
  assert.deepEqual(drawsOf(merged.base), [[RED, [0, 40]], [RED, [20]]]);
  assert.deepEqual(drawsOf(merged.layers[0].doc), [[RED, [0, 40]]]);
  assert.deepEqual(drawsOf(merged.layers[1].doc), [[RED, [20]]]);
});

test("레이어에 있는 clip·restore는 합친 레이어에도 같은 자리에 남는다", () => {
  const a = [RED, rect(0, 0, 10, 10)];
  const b = [RED, rect(20, 0, 10, 10)];
  const clip = [
    { at: 0, command: { op: "clipPath", pathId: 0 } },
    { at: 3, command: { op: "restore" } },
  ];
  const merged = mergeDraws(docOf([a, b], clip), [{ name: "line-1", doc: docOf([a, b], clip) }], { maxExtent: OPEN });
  assert.deepEqual(merged.layers[0].doc.commands.map(({ op }) => op), ["clipPath", "drawPath", "restore"]);
});

test("바탕 순서에 없는 그리기가 있는 레이어는 실패한다", () => {
  const base = docOf([[RED, rect(0, 0, 10, 10)]]);
  const stray = { name: "line-x", doc: docOf([[BLUE, rect(0, 0, 10, 10)]]) };
  assert.throws(() => mergeBasemapDraws(base, [stray], { maxExtent: OPEN }), /line-x/);
});

// ── 장벽: 합칠 수 없는 그리기는 그 너머로 아무것도 옮기지 않는다 ─────────────────

const MULTIPLY = { ...RED, blendMode: 12 };
const HAIRLINE = { ...HALO, width: 0 };

test("기본 합성(srcOver)이 아닌 그리기는 장벽이라 같은 paint 도형이 그 너머로 붙지 않고 순서가 남는다", () => {
  for (const fill of [MULTIPLY, { ...HALO, blendMode: 12 }]) {
    const draws = [[RED, rect(0, 0, 10, 10)], [fill, rect(100, 0, 10, 10)], [RED, rect(200, 0, 10, 10)]];
    const merged = mergeDraws(docOf(draws), [], { maxExtent: OPEN });
    assert.deepEqual(drawsOf(merged.base), [[RED, [0]], [fill, [100]], [RED, [200]]]);
  }
});

test("기본 합성이 아닌 같은 paint 그리기끼리도 합치지 않는다", () => {
  const merged = mergeDraws(docOf([[MULTIPLY, rect(0, 0, 10, 10)], [MULTIPLY, rect(20, 0, 10, 10)]]), [], { maxExtent: OPEN });
  assert.deepEqual(drawsOf(merged.base), [[MULTIPLY, [0]], [MULTIPLY, [20]]]);
});

test("영역을 알 수 없는 hairline(굵기 0) 선은 장벽이라 같은 paint 선이 그 너머로 붙지 않고 순서가 남는다", () => {
  const draws = [[HALO, rect(0, 0, 10, 10)], [HAIRLINE, rect(100, 0, 10, 10)], [HALO, rect(200, 0, 10, 10)]];
  const merged = mergeDraws(docOf(draws), [], { maxExtent: OPEN });
  assert.deepEqual(drawsOf(merged.base), [[HALO, [0]], [HAIRLINE, [100]], [HALO, [200]]]);
});

test("hairline 선끼리도 합치지 않는다", () => {
  const merged = mergeDraws(docOf([[HAIRLINE, rect(0, 0, 10, 10)], [HAIRLINE, rect(20, 0, 10, 10)]]), [], { maxExtent: OPEN });
  assert.deepEqual(drawsOf(merged.base), [[HAIRLINE, [0]], [HAIRLINE, [20]]]);
});

// ── 단위: 한 요소의 채우기와 선, 여러 줄 라벨의 테두리와 글자는 한 묶음으로 옮긴다 ──

function otherPaints(count) {
  return Array.from({ length: count }, (_, index) => [{ ...BLUE, color: 0xff000000 + index }, rect(100 + 20 * index, 0, 10, 10)]);
}

test("한 요소의 채우기와 선은 한 단위라 다른 그리기 9개를 건너 앞 묶음에 붙는다(단위가 아니면 거슬러 보는 거리 10을 넘는다)", () => {
  const element = (x) => {
    const outline = rect(x, 0, 30, 10);
    return [[RED, outline], [HALO, outline]];
  };
  const draws = [...element(0), ...otherPaints(MAX_OP_CHAIN_DISTANCE - 1), ...element(500)];
  const { base } = mergeDraws(docOf(draws), [], { maxExtent: OPEN });
  assert.equal(base.commands.length, MAX_OP_CHAIN_DISTANCE + 1);
  assert.deepEqual(drawsOf(base).slice(0, 2), [[RED, [0, 500]], [HALO, [0, 500]]]);
});

test("여러 줄 라벨은 한 단위라 다른 그리기 9개를 건너 앞 묶음에 붙는다(단위가 아니면 거슬러 보는 거리 10을 넘는다)", () => {
  const label = (x) => {
    const lines = [rect(x, 0, 30, 10), rect(x + 1, 20, 30, 10)];
    return [...lines.map((line) => [HALO, line]), ...lines.map((line) => [RED, line])];
  };
  const draws = [...label(0), ...otherPaints(MAX_OP_CHAIN_DISTANCE - 1), ...label(500)];
  const { base } = mergeDraws(docOf(draws), [], { maxExtent: OPEN });
  assert.equal(base.commands.length, MAX_OP_CHAIN_DISTANCE + 1);
  assert.deepEqual(drawsOf(base).slice(0, 2), [[HALO, [0, 1, 500, 501]], [RED, [0, 1, 500, 501]]]);
});

test("한 블록 안에 같은 path가 두 번 있으면(겹쳐 두 번 칠한다) 그 path들을 한 path로 잇지 않는다", () => {
  const first = rect(0, 0, 10, 10);
  const second = rect(20, 0, 10, 10);
  const draws = [[RED, first], [RED, second], [RED, second], [RED, first], [RED, second], [RED, second]];
  const { base } = mergeDraws(docOf(draws), [], { maxExtent: OPEN });
  assert.deepEqual(drawsOf(base), draws.map(([paint, path]) => [paint, [path.points[0]]]));
});

test("레이어 집합이 다른 그리기가 낀 라벨은 단위로 묶지 않는다", () => {
  const lines = [rect(0, 0, 30, 10), rect(1, 20, 30, 10)];
  const draws = [...lines.map((line) => [HALO, line]), ...lines.map((line) => [RED, line])];
  const layered = mergeDraws(docOf(draws), [{ name: "line-1", doc: docOf([draws[1], draws[3]]) }], { maxExtent: OPEN });
  assert.deepEqual(drawsOf(layered.layers[0].doc), [[HALO, [1]], [RED, [1]]]);
  assertSamePicture(
    draws.map(([paint, path]) => ({ paint, path })),
    layered.base,
    "레이어가 낀 라벨",
  );
});

test("출하 상한 256을 넘는 여러 줄 라벨은 한 path로 잇지 않고 줄 단위로 자르며, 안이면 잇는다", () => {
  const label = (gap) => {
    const lines = [rect(0, 0, 30, 10), rect(1, gap, 30, 10)];
    return docOf([...lines.map((line) => [HALO, line]), ...lines.map((line) => [RED, line])]);
  };
  assert.deepEqual(drawsOf(mergeDraws(label(200)).base), [[HALO, [0, 1]], [RED, [0, 1]]]);
  assert.deepEqual(drawsOf(mergeDraws(label(300)).base), [[HALO, [0]], [RED, [0]], [HALO, [1]], [RED, [1]]]);
});

const SMALL = { maxExtent: { width: 100, height: 100 } };

// 줄 둘의 테두리가 서로 겹쳐도(줄 간격 13 < 테두리 폭을 더한 키) 한 줄의 글자는 다른 줄의 테두리와
// 겹치지 않으면 줄마다 테두리와 글자를 한 단위로 자른다. 그러면 줄마다 path 하나를 테두리와 글자가
// 나눠 쓴다.
test("줄 테두리가 서로 겹치는 여러 줄 라벨도 줄마다 테두리와 글자가 path 하나를 나눠 쓴다", () => {
  const lines = [rect(0, 0, 30, 10), rect(1, 13, 30, 10)];
  const draws = [...lines.map((line) => [HALO, line]), ...lines.map((line) => [RED, line])];
  const { base } = mergeDraws(docOf(draws), [], SMALL);
  assert.deepEqual(drawsOf(base), [[HALO, [0]], [RED, [0]], [HALO, [1]], [RED, [1]]]);
  assert.equal(base.paths.length, 2, "줄 path는 테두리와 글자가 나눠 쓴다");
  assertSamePicture(draws.map(([paint, path]) => ({ paint, path })), base, "겹치는 테두리 줄");
});

test("한 줄의 글자가 다른 줄의 테두리와 겹치면 그리는 순서가 바뀌므로 자르지 않는다", () => {
  const lines = [rect(0, 0, 30, 10), rect(1, 11, 30, 10)];
  const draws = [...lines.map((line) => [HALO, line]), ...lines.map((line) => [RED, line])];
  const { base } = mergeDraws(docOf(draws), [], SMALL);
  assertSamePicture(draws.map(([paint, path]) => ({ paint, path })), base, "글자와 테두리가 겹치는 줄");
  assert.equal(base.commands.length, 3, "테두리 둘은 겹쳐 따로, 글자 둘은 하나로 남는다");
});

test("자른 줄 단위는 이웃 라벨의 같은 줄 단위와 묶인다", () => {
  const label = (x) => {
    const lines = [rect(x, 0, 30, 10), rect(x + 1, 120, 30, 10)];
    return [...lines.map((line) => [HALO, line]), ...lines.map((line) => [RED, line])];
  };
  const { base } = mergeDraws(docOf([...label(0), ...label(40)]), [], SMALL);
  assert.deepEqual(drawsOf(base), [[HALO, [0, 40]], [RED, [0, 40]], [HALO, [1, 41]], [RED, [1, 41]]]);
});

test("혼자서도 상한을 넘는 줄은 단위로 묶지 않고 앞 줄만 단위로 둔다", () => {
  const lines = [rect(0, 0, 100, 10), rect(1, 20, 300, 10)];
  const draws = [...lines.map((line) => [HALO, line]), ...lines.map((line) => [RED, line])];
  const { base } = mergeDraws(docOf(draws));
  assert.deepEqual(
    base.commands.map((command) => base.paints[command.paintId].style),
    ["stroke", "fill", "stroke", "fill"],
  );
  assert.deepEqual(base.commands.map((command) => base.paths[command.pathId].points.length), [8, 8, 8, 8]);
  assertSamePicture(draws.map(([paint, path]) => ({ paint, path })), base, "넓은 둘째 줄");
});

// ── 무작위 문서로 렌더 동등 계약을 확인한다 ─────────────────────────────────────

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function overlaps(a, b) {
  return a.maxX > b.minX && a.maxY > b.minY && b.maxX > a.minX && b.maxY > a.minY;
}

function randomScene(seed) {
  const next = random(seed);
  const palette = [RED, BLUE, HALO, { ...HALO, color: 0x80000000, join: 0, miterLimit: 3 }];
  const draws = [];
  for (let index = 0; index < 300; index += 1) {
    // 시작점 x를 도형마다 다르게 해 출력 윤곽선이 어느 입력에서 왔는지 알 수 있게 한다.
    const x = 2 + index * 3 + next();
    const y = next() * 900;
    const paintIndex = Math.floor(next() * palette.length);
    const path = rect(x, y, 4 + next() * 40, 4 + next() * 40);
    const lines = next() < 0.5 ? ["a"] : ["a", "b"];
    draws.push({ paint: palette[paintIndex], path, lines });
    // 같은 path를 다른 paint로 한 번 더 그리거나(한 요소의 채우기와 선), 둘째 줄을 더해
    // 줄마다 테두리, 다음에 줄마다 글자를 그린다(여러 줄 라벨).
    const second = palette[(paintIndex + 1) % palette.length];
    const roll = next();
    if (roll < 0.4) {
      draws.push({ paint: second, path, lines });
    } else if (roll < 0.6) {
      const nextLine = rect(x + 0.5, y + 8 + next() * 50, 4 + next() * 40, 4 + next() * 40);
      draws.push({ paint: palette[paintIndex], path: nextLine, lines });
      draws.push({ paint: second, path, lines }, { paint: second, path: nextLine, lines });
    }
  }
  return draws;
}

function boundsOf(paint, path) {
  const xs = [];
  const ys = [];
  for (let i = 0; i < path.points.length; i += 2) {
    xs.push(path.points[i]);
    ys.push(path.points[i + 1]);
  }
  const outset = paint.style === "stroke" ? (paint.width / 2) * (paint.join === 0 ? Math.max(1, paint.miterLimit) : 1) : 0;
  return { minX: Math.min(...xs) - outset, minY: Math.min(...ys) - outset, maxX: Math.max(...xs) + outset, maxY: Math.max(...ys) + outset };
}

// 같은 그림의 조건: 입력 도형이 같은 paint로 정확히 한 번 그려지고, 영역이 겹치는 두
// 입력 도형의 그리는 순서가 같으며, 한 그리기 안의 도형끼리는 겹치지 않는다.
function assertSamePicture(input, output, label) {
  const position = new Map();
  drawsOf(output).forEach(([paint, starts], drawIndex) => {
    for (const start of starts) {
      const key = `${JSON.stringify(paint)}@${start}`;
      assert.ok(!position.has(key), `${label}: ${key}가 두 번 그려진다`);
      position.set(key, drawIndex);
    }
  });
  assert.equal(position.size, input.length, `${label}: 그려지는 도형 수`);
  input.forEach((a, i) => {
    const keyA = `${JSON.stringify(a.paint)}@${a.path.points[0]}`;
    assert.ok(position.has(keyA), `${label}: ${keyA}가 사라졌다`);
    for (const b of input.slice(i + 1)) {
      if (!overlaps(boundsOf(a.paint, a.path), boundsOf(b.paint, b.path))) continue;
      const keyB = `${JSON.stringify(b.paint)}@${b.path.points[0]}`;
      assert.ok(position.get(keyA) < position.get(keyB), `${label}: 겹치는 ${keyA}와 ${keyB}의 순서가 바뀌거나 한 path로 이어졌다`);
    }
  });
}

test("무작위 장면 20개에서 바탕과 레이어 모두 같은 그림이고 그리기 수는 줄며 레이어는 바탕의 부분 수열이다", () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    const scene = randomScene(seed);
    const toDoc = (draws) => docOf(draws.map(({ paint, path }) => [paint, path]));
    const layerB = scene.filter(({ lines }) => lines.includes("b"));
    const merged = mergeDraws(toDoc(scene), [{ name: "b", doc: toDoc(layerB) }], {
      maxExtent: { width: 300, height: 300 },
    });
    assertSamePicture(scene, merged.base, `seed ${seed} 바탕`);
    assertSamePicture(layerB, merged.layers[0].doc, `seed ${seed} 레이어`);
    assert.ok(merged.base.commands.length < scene.length, `seed ${seed}: 그리기 수가 줄지 않았다`);
    const baseKeys = merged.base.commands.map((command) => JSON.stringify(drawsOf({ ...merged.base, commands: [command] })));
    let cursor = 0;
    for (const command of merged.layers[0].doc.commands) {
      const key = JSON.stringify(drawsOf({ ...merged.layers[0].doc, commands: [command] }));
      while (cursor < baseKeys.length && baseKeys[cursor] !== key) cursor += 1;
      assert.ok(cursor < baseKeys.length, `seed ${seed}: 레이어 그리기가 바탕 순서에 없다`);
      cursor += 1;
    }
  }
});

// ── 배포 산출물(고정 mobile 픽스처) ─────────────────────────────────────────────

const basemapDir = path.resolve(import.meta.dirname, "../../apps/mobile/assets/datapacks/metro_map_pack/basemap");

function drawValues(doc) {
  return resolvedCommands(doc).map((values) => JSON.stringify(values));
}

test("두 변형 모두 배포 노선 강조 레이어는 그리기 명령 단위로 그 변형 바탕의 부분 수열이고, 넓이 없는 채우기가 없다", () => {
  const index = JSON.parse(readFileSync(path.join(basemapDir, "line-overlays.json"), "utf8"));
  const read = (name) => decodeVec(new Uint8Array(readFileSync(path.join(basemapDir, name))));
  assert.deepEqual(Object.keys(index.variants), ["outlined", "text"]);
  const regions = Object.entries(index.variants).flatMap(([variantId, { regions: byRegion }]) =>
    Object.entries(byRegion).map(([region, entry]) => [`${variantId}/${region}`, entry]),
  );
  assert.equal(regions.length, 10);
  for (const [region, { baseVector, lines }] of regions) {
    const base = read(baseVector);
    const baseDraws = drawValues(base);
    for (const { vector } of Object.values(lines)) {
      let cursor = 0;
      for (const draw of drawValues(read(vector))) {
        while (cursor < baseDraws.length && baseDraws[cursor] !== draw) cursor += 1;
        assert.ok(cursor < baseDraws.length, `${region}: ${vector}의 그리기가 바탕 순서에 없다`);
        cursor += 1;
      }
    }
    for (const command of base.commands) {
      if (command.op !== "drawPath" || base.paints[command.paintId].style !== "fill") continue;
      const { points } = base.paths[command.pathId];
      const xs = points.filter((_, i) => i % 2 === 0);
      const ys = points.filter((_, i) => i % 2 === 1);
      assert.ok(
        Math.max(...xs) > Math.min(...xs) && Math.max(...ys) > Math.min(...ys),
        `${region}: 넓이 없는 축 정렬 채우기가 남았다`,
      );
    }
  }
});
