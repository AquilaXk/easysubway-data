// 바탕층 `.vec`의 그리기 명령을 렌더 결과를 바꾸지 않고 합친다(#1495).
//
// 기기 래스터 스레드는 매 프레임 그리기 명령을 하나씩 다시 처리한다(mobile #517).
// 같은 paint로 그리는 path 여럿을 path 하나로 이으면 같은 그림을 명령 하나로 그린다.
//
// 합치는 규칙은 Skia Ganesh의 연산 묶기를 옮긴다(google/skia a625b534, BSD-3-Clause,
// Copyright 2019 Google LLC).
//   - src/gpu/ganesh/ops/OpsTask.cpp 1097-1118행 recordOp: 새 명령을 앞 묶음에 붙여 보고,
//     안 되면 그 묶음과 영역이 겹치지 않을 때만 더 앞 묶음으로 간다. 겹치면 멈춘다
//     (그리는 순서가 바뀌면 그림이 바뀐다). 54-55행 kMaxOpChainDistance=10이 거슬러
//     보는 묶음 수의 상한이다.
//   - src/gpu/ganesh/geometry/GrRect.h 17-22행 GrRectsOverlap: 넓이가 있는 겹침만 겹침이다.
//   - src/core/SkStrokeRec.cpp 151-171행 GetInflationRadius: 선의 영역은 path 영역을
//     선 굵기 절반 × (miter 이음이면 miterLimit, 사각 끝이면 √2)만큼 넓힌 것이다. 굵기 0
//     (hairline)은 기기 픽셀 단위라 viewBox 영역을 알 수 없어 합치지 않는다.
// Skia는 묶은 연산의 도형을 하나씩 그리지만, 여기서는 path 하나로 이어 한 번에 칠한다.
// 그래서 우리가 더한 조건이 있다. 묶음 안 도형끼리도 영역이 겹치지 않아야 한다(겹치면
// nonzero 감김수 합과 반투명 색 겹침이 달라진다). 또 엔진은 화면 밖 명령을 건너뛰므로
// (flutter engine lib/ui/painting/picture_recorder.cc 30행 prepare_rtree=true,
// impeller/display_list/dl_dispatcher.cc 815-826행 cull_rect로 Dispatch), 묶음 크기에
// 상한(MAX_GROUP_EXTENT)을 둬 확대 상태에서 건너뛰던 일을 크게 되살리지 않는다.
//
// 노선 강조 레이어는 바탕 그리기 순서의 부분 수열이다. 바탕에서 정한 묶음을 레이어에도
// 그대로 쓰고, 한 묶음은 같은 레이어 집합에 속한 명령으로만 만든다. 그래서 합친 뒤에도
// 레이어는 바탕의 부분 수열이고 앱이 흐린 바탕 위에 겹쳐 그리는 위치가 그대로다.

export const MAX_OP_CHAIN_DISTANCE = 10;

// 묶음 하나의 최대 크기(viewBox 단위). 엔진은 화면과 겹치는 그리기만 처리하므로 묶음이
// 넓을수록 확대 화면에서 화면 밖 도형까지 다시 처리한다. 수도권 바탕 실측(#1495, 합치기
// 전 명령 2756개)에서 256은 명령을 1654개(−40%)로 줄이고, 최대 줌 한 화면이 처리하는
// 좌표 최댓값을 1991에서 2847로 늘린다(전체 보기가 그리는 좌표 110614의 2.6%). 512는
// 1424개에 6046, 제한 없음은 1166개에 22378이다. 기기 래스터 실측으로 다시 고른다.
export const MAX_GROUP_EXTENT = Object.freeze({ width: 256, height: 256 });

const SRC_OVER_BLEND_MODE = 3;
const STROKE_CAP_SQUARE = 2;
const STROKE_JOIN_MITER = 0;

function pointBounds(points) {
  if (points.length === 0) return null;
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (let i = 0; i < points.length; i += 2) {
    box.minX = Math.min(box.minX, points[i]);
    box.maxX = Math.max(box.maxX, points[i]);
    box.minY = Math.min(box.minY, points[i + 1]);
    box.maxY = Math.max(box.maxY, points[i + 1]);
  }
  return box;
}

function strokeInflation({ width, join, miterLimit, cap }) {
  let multiplier = 1;
  if (join === STROKE_JOIN_MITER) multiplier = Math.max(multiplier, miterLimit);
  if (cap === STROKE_CAP_SQUARE) multiplier = Math.max(multiplier, Math.SQRT2);
  return (width / 2) * multiplier;
}

/** drawPath 명령이 칠할 수 있는 영역(viewBox 좌표). 알 수 없으면 null. */
export function commandBounds(doc, command) {
  if (command.op !== "drawPath") return null;
  const paint = doc.paints[command.paintId];
  const box = pointBounds(doc.paths[command.pathId].points);
  if (!box) return null;
  if (paint.style === "fill") return box;
  if (paint.width <= 0) return null;
  const outset = strokeInflation(paint);
  return { minX: box.minX - outset, minY: box.minY - outset, maxX: box.maxX + outset, maxY: box.maxY + outset };
}

// 제어점이 모두 한 직선 위에 있으면 곡선도 그 위에 있어 칠할 넓이가 없다. 오너 SVG의
// 직선 path는 기본 fill(검정)과 stroke를 함께 가져 fill 그리기가 빈 그리기로 남는다.
function enclosesNoArea({ points }) {
  const x0 = points[0];
  const y0 = points[1];
  let dx = 0;
  let dy = 0;
  for (let i = 2; i < points.length; i += 2) {
    const ex = points[i] - x0;
    const ey = points[i + 1] - y0;
    if (dx === 0 && dy === 0) {
      dx = ex;
      dy = ey;
    } else if (dx * ey - dy * ex !== 0) {
      return false;
    }
  }
  return true;
}

/** 두 영역이 넓이 있게 겹치는지(GrRectsOverlap). */
export function rectsOverlap(a, b) {
  return a.maxX > b.minX && a.maxY > b.minY && b.maxX > a.minX && b.maxY > a.minY;
}

function union(a, b) {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

function withinExtent(box, maxExtent) {
  return box.maxX - box.minX <= maxExtent.width && box.maxY - box.minY <= maxExtent.height;
}

function unionAll(boxes) {
  return boxes.slice(1).reduce(union, boxes[0]);
}

function paintKey(paint) {
  return JSON.stringify(paint);
}

function pathKey({ fillType, verbs, points }) {
  return `${fillType}|${Array.from(verbs).join(",")}|${Array.from(points).join(",")}`;
}

function commandKey(doc, command) {
  switch (command.op) {
    case "drawPath":
      return `draw|${paintKey(doc.paints[command.paintId])}|${pathKey(doc.paths[command.pathId])}|${command.patternId}`;
    case "saveLayer":
      return `saveLayer|${paintKey(doc.paints[command.paintId])}`;
    case "clipPath":
      return `clip|${pathKey(doc.paths[command.pathId])}`;
    case "pattern":
      return `pattern|${command.x},${command.y},${command.width},${command.height}|${Array.from(command.transform).join(",")}`;
    default:
      return command.op;
  }
}

// 레이어 명령 열이 바탕 명령 열의 부분 수열인지 확인하고, 레이어 명령마다 바탕 위치를 낸다.
function embedLayer(baseKeys, layer, layerName) {
  const positions = [];
  let cursor = 0;
  for (const command of layer.commands) {
    const key = commandKey(layer, command);
    while (cursor < baseKeys.length && baseKeys[cursor] !== key) cursor += 1;
    if (cursor === baseKeys.length) {
      throw new Error(`${layerName}: 그리기 명령 ${positions.length}번이 바탕 순서에 없습니다.`);
    }
    positions.push(cursor);
    cursor += 1;
  }
  return positions;
}

// 합칠 수 있는 명령: 기본 합성(srcOver)으로 칠하는 drawPath. pattern·restore·clip·
// saveLayer·mask와 무늬를 쓰는 drawPath(런타임이 paint의 shader를 바꾼다, vector_graphics
// 1.2.3 listener.dart 328-335행)는 장벽이라 아무것도 그 너머로 옮겨지지 않는다. 그래서
// 무늬 정의(pattern ~ restore) 안의 그리기는 그 안에서만 묶인다.
function classifyCommands(doc) {
  return doc.commands.map((command) => {
    if (command.op !== "drawPath" || command.patternId !== null) return { barrier: true };
    const paint = doc.paints[command.paintId];
    const path = doc.paths[command.pathId];
    if (paint.style === "fill" && enclosesNoArea(path)) return { paintsNothing: true };
    const bounds = commandBounds(doc, command);
    if (paint.blendMode !== SRC_OVER_BLEND_MODE || !bounds) return { barrier: true };
    return { barrier: false, bounds, mergeKey: `${path.fillType}|${paintKey(paint)}` };
  });
}

// 한 요소를 paint마다 다시 그리는 명령 묶음은 한 단위로 옮긴다. 채우기와 선은 같은 path를
// 잇달아 그리고(블록 크기 1), paint-order로 나눈 여러 줄 라벨은 줄 path 열을 테두리로 한 번,
// 글자로 한 번 그린다(블록 크기 = 줄 수). 단위끼리 묶으면 이은 path 하나를 단위의 paint 순서대로
// 다시 그리므로, 컴파일러가 한 번만 적던 path를 계속 한 번만 적는다. 한 paint 안에서
// 이어 칠하는 조각끼리도 겹치지 않아야 한다.
function sameBlockPaint(head) {
  return (draw) => !draw.barrier && draw.layers === head.layers && draw.mergeKey === head.mergeKey;
}

function piecesDisjoint(block) {
  return block.every((a, i) => block.slice(i + 1).every((b) => !rectsOverlap(a.bounds, b.bounds)));
}

// 머리 draw의 path가 처음 다시 나오는 거리가 블록 크기다(블록 안 path는 서로 다르다).
// 단위 하나도 묶음 하나처럼 최대 크기를 넘지 않는다. 넘으면 단위로 묶지 않고 draw를 하나씩 둔다.
function repeatedBlocks(draws, start, maxExtent) {
  const head = draws[start];
  const inHeadBlock = sameBlockPaint(head);
  let size = 1;
  while (start + size < draws.length && draws[start + size].command.pathId !== head.command.pathId) {
    if (!inHeadBlock(draws[start + size])) return [[head]];
    size += 1;
  }
  const pathIds = draws.slice(start, start + size).map(({ command }) => command.pathId);
  if (new Set(pathIds).size !== size) return [[head]];
  const blocks = [draws.slice(start, start + size)];
  for (let next = start + size; next + size <= draws.length; next += size) {
    const block = draws.slice(next, next + size);
    const inBlock = sameBlockPaint(block[0]);
    const repeats = block.every(
      (draw, index) => inBlock(draw) && draw.layers === head.layers && draw.command.pathId === pathIds[index],
    );
    if (!repeats) break;
    blocks.push(block);
  }
  const bounds = unionAll(blocks.flat().map((draw) => draw.bounds));
  return blocks.length >= 2 && blocks.every(piecesDisjoint) && withinExtent(bounds, maxExtent) ? blocks : [[head]];
}

function buildUnits(draws, maxExtent) {
  const units = [];
  for (let start = 0; start < draws.length; ) {
    if (draws[start].barrier) {
      units.push({ barrier: true, layers: draws[start].layers, commands: [draws[start].command] });
      start += 1;
      continue;
    }
    const blocks = repeatedBlocks(draws, start, maxExtent);
    const members = blocks.flat();
    units.push({
      barrier: false,
      mergeKey: blocks.map(([first]) => first.mergeKey).join("\n"),
      layers: blocks[0][0].layers,
      bounds: unionAll(members.map(({ bounds }) => bounds)),
      pathIds: blocks[0].map(({ command }) => command.pathId),
      commands: blocks.map(([first]) => first.command),
    });
    start += members.length;
  }
  return units;
}

function canJoin(group, unit, maxExtent) {
  if (group.barrier || group.mergeKey !== unit.mergeKey || group.layers !== unit.layers) return false;
  if (!withinExtent(union(group.bounds, unit.bounds), maxExtent)) return false;
  return group.units.every((member) => !rectsOverlap(member.bounds, unit.bounds));
}

// OpsTask::recordOp(1097-1118행)의 뒤로 붙이기. 붙일 묶음이 없으면 null.
function joinTarget(groups, unit, maxExtent) {
  const lookback = Math.min(MAX_OP_CHAIN_DISTANCE, groups.length);
  for (let i = 1; i <= lookback; i += 1) {
    const candidate = groups[groups.length - i];
    if (canJoin(candidate, unit, maxExtent)) return candidate;
    if (candidate.barrier || rectsOverlap(candidate.bounds, unit.bounds)) return null;
  }
  return null;
}

function planGroups(units, maxExtent) {
  const groups = [];
  for (const unit of units) {
    const target = unit.barrier ? null : joinTarget(groups, unit, maxExtent);
    if (target) {
      target.units.push(unit);
      target.bounds = union(target.bounds, unit.bounds);
    } else {
      groups.push({ ...unit, units: [unit] });
    }
  }
  return groups;
}

function concatPaths(paths) {
  if (paths.length === 1) return paths[0];
  const verbCount = paths.reduce((sum, { verbs }) => sum + verbs.length, 0);
  const pointCount = paths.reduce((sum, { points }) => sum + points.length, 0);
  const verbs = new Uint8Array(verbCount);
  const points = new Float32Array(pointCount);
  let verbOffset = 0;
  let pointOffset = 0;
  for (const path of paths) {
    verbs.set(path.verbs, verbOffset);
    points.set(path.points, pointOffset);
    verbOffset += path.verbs.length;
    pointOffset += path.points.length;
  }
  return { fillType: paths[0].fillType, verbs, points };
}

// 컴파일러 DrawCommandBuilder(draw_command_builder.dart 27행 _getOrGenerateId)처럼 path와
// paint를 처음 쓰는 순서대로 번호를 매기고 같은 값은 한 번만 적는다.
function emitDoc(source, groups) {
  const paints = [];
  const paths = [];
  const paintIds = new Map();
  const pathIds = new Map();
  const internPaint = (paint) => {
    const key = paintKey(paint);
    if (!paintIds.has(key)) {
      paintIds.set(key, paints.length);
      paints.push(paint);
    }
    return paintIds.get(key);
  };
  const internPath = (path) => {
    const key = pathKey(path);
    if (!pathIds.has(key)) {
      pathIds.set(key, paths.length);
      paths.push(path);
    }
    return pathIds.get(key);
  };
  const remap = (command) => {
    switch (command.op) {
      case "drawPath":
        return {
          ...command,
          pathId: internPath(source.paths[command.pathId]),
          paintId: internPaint(source.paints[command.paintId]),
        };
      case "saveLayer":
        return { ...command, paintId: internPaint(source.paints[command.paintId]) };
      case "clipPath":
        return { ...command, pathId: internPath(source.paths[command.pathId]) };
      default:
        return command;
    }
  };
  const commands = [];
  for (const { barrier, units } of groups) {
    if (barrier) {
      commands.push(remap(units[0].commands[0]));
      continue;
    }
    const pieces = units.flatMap(({ pathIds }) => pathIds.map((id) => source.paths[id]));
    const pathId = internPath(concatPaths(pieces));
    for (const command of units[0].commands) {
      commands.push({ ...command, pathId, paintId: internPaint(source.paints[command.paintId]) });
    }
  }
  return { width: source.width, height: source.height, paints, paths, commands };
}

/**
 * 바탕 [base]와 노선 강조 레이어 [layers]({ name, doc }[])의 그리기 명령을 합친다.
 * 반환은 { base, layers: { name, doc }[] }이고 레이어는 바탕의 부분 수열로 남는다.
 */
export function mergeBasemapDraws(base, layers = [], { maxExtent = MAX_GROUP_EXTENT } = {}) {
  const membership = base.commands.map(() => []);
  const baseKeys = base.commands.map((command) => commandKey(base, command));
  for (const { name, doc } of layers) {
    for (const position of embedLayer(baseKeys, doc, name)) membership[position].push(name);
  }
  const classes = classifyCommands(base);
  const draws = base.commands
    .map((command, index) => ({ ...classes[index], command, layers: membership[index].join("\n") }))
    .filter(({ paintsNothing }) => !paintsNothing);
  const groups = planGroups(buildUnits(draws, maxExtent), maxExtent);
  return {
    base: emitDoc(base, groups),
    layers: layers.map(({ name }) => ({
      name,
      doc: emitDoc(
        base,
        groups.filter((group) => group.layers.split("\n").includes(name)),
      ),
    })),
  };
}
