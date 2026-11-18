// 오너 SVG의 **잉크 bbox**(실제로 그려지는 모든 것의 외곽)를 계산한다.
//
// 용도는 캔버스 여백 게이트다(#2603). viewBox를 잉크에 맞춰 조인 뒤로 우·하단
// 여유가 39~80단위밖에 남지 않아, 오너가 가장자리에 요소를 추가하면 캔버스를
// 넘어선다. 넘어선 요소는 컴파일러가 잘라내지 않고 `.vec`에 그대로 남기지만
// (실측: viewBox 밖 원을 넣어도 산출물이 커진다), 캔버스 크기와 잉크가
// 어긋나면 캔버스를 기준으로 삼는 판단이 전부 틀어지고 런타임·플랫폼에 따라
// 컬링될 여지도 생긴다. 그래서 "잉크 ⊆ viewBox"를 상시 게이트로 고정한다.
//
// 입력은 **윤곽선까지 구운 컴파일 입력**(outlineBasemapText(normalizeSvgForCompile(…)).svg)
// 이다. normalizeSvgForCompile이 `<style>` 캐스케이드를 요소 선언으로 펼치고,
// 윤곽선 굽기가 라벨을 참조 페이스의 글리프 `<path>`로 바꾸므로 여기서는 CSS도 글자
// 폭도 다시 모델링하지 않는다. 글자는 `.vec`로 가는 윤곽선 그대로 잰다(커닝·양수
// letter-spacing·halo stroke가 이미 반영돼 있다). 굽기 전 `<text>`는 폭을 어림해야
// 해서 받지 않고 던진다.
//
// 알 수 없는 그리기 태그를 만나면 **던진다** — 조용히 빠뜨리면 게이트가 잉크를
// 놓친 채 green이 되어 존재 이유가 사라진다.

import { firstAttr } from "./basemap-svg-core.mjs";
import {
  applyMatrix,
  composeMatrix,
  parseTransformChain,
} from "./compile-basemap-vec.mjs";

const IDENTITY = [1, 0, 0, 1, 0, 0];

/** 렌더에 참여하지 않는 컨테이너·메타 태그 — 통째로 건너뛴다. */
const NON_RENDERING_TAGS = new Set([
  "defs",
  "clipPath",
  "mask",
  "pattern",
  "marker",
  "symbol",
  "filter",
  "feDropShadow",
  "feGaussianBlur",
  "feOffset",
  "feFlood",
  "feComposite",
  "feColorMatrix",
  "feMerge",
  "feMergeNode",
  "linearGradient",
  "radialGradient",
  "stop",
  "title",
  "desc",
  "metadata",
  "style",
  "script",
  "sodipodi:namedview",
  "inkscape:path-effect",
  "sodipodi:path-effect",
  "namedview",
  "rdf:RDF",
  "cc:Work",
  "dc:format",
  "dc:type",
  "dc:title",
]);

/** 실제로 잉크를 남기는 태그. 이 밖의 태그는 fail-closed로 던진다. */
const DRAWABLE_TAGS = new Set([
  "path",
  "circle",
  "ellipse",
  "rect",
  "line",
  "polyline",
  "polygon",
]);

/** 전면 배경·그리드처럼 캔버스를 통째로 덮는 장식 — 잉크에서 뺀다. */
export const FULL_CANVAS_DECOR_IDS = [
  "page-background",
  "background-grid-overlay",
];

// ── 경로 외곽 정밀 계산 ──────────────────────────────────────────────────────
//
// `visitPathCoordinates`는 curve **제어점**까지 좌표로 방문한다(장애물 회피에는
// 넉넉한 쪽이 안전하므로 의도된 설계다). 하지만 잉크 게이트에는 못 쓴다 —
// 수도권 실측에서 제어점 껍질이 실제 잉크보다 106단위 넓어(3715.4 vs 3608.9)
// 크롭 여유 27단위를 그냥 넘겨버린다. 여기서는 3·2차 베지어의 **극값을 미분근
// 으로 정확히** 구하고, 호(A)는 조밀 샘플링한다.

const ARC_SAMPLES = 64;

function cubicExtremaAxis(p0, p1, p2, p3, visit) {
  visit(p0);
  visit(p3);
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const at = (t) => {
    const u = 1 - t;
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
  };
  const roots = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) roots.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      roots.push((-b + s) / (2 * a), (-b - s) / (2 * a));
    }
  }
  for (const t of roots) if (t > 0 && t < 1) visit(at(t));
}

function quadExtremaAxis(p0, p1, p2, visit) {
  visit(p0);
  visit(p2);
  const denom = p0 - 2 * p1 + p2;
  if (Math.abs(denom) < 1e-12) return;
  const t = (p0 - p1) / denom;
  if (t > 0 && t < 1) {
    const u = 1 - t;
    visit(u * u * p0 + 2 * u * t * p1 + t * t * p2);
  }
}

/** SVG 호(A)를 중심 파라미터로 바꿔 조밀 샘플링한다(W3C 구현 노트 F.6.5). */
function visitArc(arc, visit) {
  let { rx, ry } = arc;
  const { x1, y1, rotDeg, largeArc, sweep, x2, y2 } = arc;
  if (rx === 0 || ry === 0) {
    visit(x2, y2);
    return;
  }
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (rotDeg * Math.PI) / 180;
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cosP * dx2 + sinP * dy2;
  const y1p = -sinP * dx2 + cosP * dy2;
  let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const sign = largeArc !== sweep ? 1 : -1;
  const num =
    rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;
  const angleOf = (ux, uy) => Math.atan2(uy, ux);
  const theta1 = angleOf((x1p - cxp) / rx, (y1p - cyp) / ry);
  let deltaTheta =
    angleOf((-x1p - cxp) / rx, (-y1p - cyp) / ry) - theta1;
  if (!sweep && deltaTheta > 0) deltaTheta -= 2 * Math.PI;
  if (sweep && deltaTheta < 0) deltaTheta += 2 * Math.PI;
  for (let i = 0; i <= ARC_SAMPLES; i += 1) {
    const t = theta1 + (deltaTheta * i) / ARC_SAMPLES;
    visit(
      cx + rx * Math.cos(t) * cosP - ry * Math.sin(t) * sinP,
      cy + rx * Math.cos(t) * sinP + ry * Math.sin(t) * cosP,
    );
  }
}

/** `d`가 실제로 지나는 점(곡선 극값 포함)을 [visit]한다. */
export function visitPathExtremes(d, visit, matrix = IDENTITY) {
  // 복잡한 대안 정규식 대신 명령 문자와 부호 앞에 공백을 넣어 분해한다.
  // `1e-4`의 지수 부호는 앞 문자가 e라 분해 대상이 아니다(lookbehind가 걸러낸다).
  const tokens = d
    .replaceAll(/([MmLlHhVvCcSsQqTtAaZz])/g, " $1 ")
    .replaceAll(/(?<=[0-9.])(?=[+-])/g, " ")
    .split(/[\s,]+/)
    .filter(Boolean);
  let i = 0;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let prevC = null;
  let prevQ = null;
  let cmd = null;
  const num = () => {
    const value = Number(tokens[i++]);
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `svg-ink-bbox: path 좌표를 읽지 못했습니다: "${d.slice(0, 60)}"`,
      );
    }
    return value;
  };
  const point = (x, y) => applyMatrix(matrix, x, y);
  const emit = (x, y) => visit(...point(x, y));
  const curve = (x1, y1, x2, y2, x, y) => {
    const [p0, p1, p2, p3] = [
      point(cx, cy),
      point(x1, y1),
      point(x2, y2),
      point(x, y),
    ];
    cubicExtremaAxis(p0[0], p1[0], p2[0], p3[0], (v) =>
      visit(v, p0[1]),
    );
    cubicExtremaAxis(p0[1], p1[1], p2[1], p3[1], (v) =>
      visit(p0[0], v),
    );
    visit(...p3);
  };
  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) cmd = tokens[i++];
    if (cmd === undefined) break;
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;
    switch (cmd.toUpperCase()) {
      case "M": {
        cx = num() + ox;
        cy = num() + oy;
        sx = cx;
        sy = cy;
        emit(cx, cy);
        cmd = rel ? "l" : "L";
        break;
      }
      case "L": {
        cx = num() + ox;
        cy = num() + oy;
        emit(cx, cy);
        prevC = prevQ = null;
        break;
      }
      case "H": {
        cx = num() + ox;
        emit(cx, cy);
        prevC = prevQ = null;
        break;
      }
      case "V": {
        cy = num() + oy;
        emit(cx, cy);
        prevC = prevQ = null;
        break;
      }
      case "C": {
        const x1 = num() + ox;
        const y1 = num() + oy;
        const x2 = num() + ox;
        const y2 = num() + oy;
        const x = num() + ox;
        const y = num() + oy;
        curve(x1, y1, x2, y2, x, y);
        prevC = [x2, y2];
        prevQ = null;
        cx = x;
        cy = y;
        break;
      }
      case "S": {
        const [px, py] = prevC ?? [cx, cy];
        const x1 = 2 * cx - px;
        const y1 = 2 * cy - py;
        const x2 = num() + ox;
        const y2 = num() + oy;
        const x = num() + ox;
        const y = num() + oy;
        curve(x1, y1, x2, y2, x, y);
        prevC = [x2, y2];
        prevQ = null;
        cx = x;
        cy = y;
        break;
      }
      case "Q": {
        const x1 = num() + ox;
        const y1 = num() + oy;
        const x = num() + ox;
        const y = num() + oy;
        const [p0, p1, p2] = [
          point(cx, cy),
          point(x1, y1),
          point(x, y),
        ];
        quadExtremaAxis(p0[0], p1[0], p2[0], (v) => visit(v, p0[1]));
        quadExtremaAxis(p0[1], p1[1], p2[1], (v) => visit(p0[0], v));
        visit(...p2);
        prevQ = [x1, y1];
        prevC = null;
        cx = x;
        cy = y;
        break;
      }
      case "T": {
        const [px, py] = prevQ ?? [cx, cy];
        const x1 = 2 * cx - px;
        const y1 = 2 * cy - py;
        const x = num() + ox;
        const y = num() + oy;
        const [p0, p1, p2] = [
          point(cx, cy),
          point(x1, y1),
          point(x, y),
        ];
        quadExtremaAxis(p0[0], p1[0], p2[0], (v) => visit(v, p0[1]));
        quadExtremaAxis(p0[1], p1[1], p2[1], (v) => visit(p0[0], v));
        visit(...p2);
        prevQ = [x1, y1];
        prevC = null;
        cx = x;
        cy = y;
        break;
      }
      case "A": {
        const rx = num();
        const ry = num();
        const rot = num();
        const largeArc = num() !== 0;
        const sweep = num() !== 0;
        const x = num() + ox;
        const y = num() + oy;
        visitArc(
          { x1: cx, y1: cy, rx, ry, rotDeg: rot, largeArc, sweep, x2: x, y2: y },
          emit,
        );
        prevC = prevQ = null;
        cx = x;
        cy = y;
        break;
      }
      case "Z": {
        cx = sx;
        cy = sy;
        emit(cx, cy);
        prevC = prevQ = null;
        break;
      }
      default:
        throw new Error(`svg-ink-bbox: 지원하지 않는 path 명령 "${cmd}"입니다.`);
    }
  }
}

/** 게이트 실패 메시지가 "어느 요소가 넘쳤는지" 짚도록 태그를 요약한다. */
function describeTag(tag, name, owner) {
  const id = firstAttr(tag, "id");
  if (id) return `<${name} id="${id}">`;
  return owner ? `<${name}> in #${owner}` : `<${name}>`;
}

function numAttr(tag, name, fallback = Number.NaN) {
  const raw = firstAttr(tag, name);
  if (raw === null || raw === undefined || raw === "") return fallback;
  const value = Number(String(raw).trim().replace(/px$/, ""));
  return Number.isFinite(value) ? value : fallback;
}

/**
 * 인라인 `style` 선언 하나를 읽는다. `applyStylesheet`가 `<style>` 캐스케이드를
 * 펼칠 때 일부 선언은 속성이 아니라 `style="…"`으로 들어간다(CSS 우선순위를
 * 보존해야 하므로). 속성만 보면 `style="stroke-width:…"`를 쓰는 요소의 선 굵기를
 * 놓쳐 stroke 바깥 잉크가 줄어든다.
 */
function styleProp(tag, name) {
  const style = firstAttr(tag, "style");
  if (!style) return null;
  const match = style.match(
    new RegExp(String.raw`(?:^|;)\s*${name}\s*:\s*([^;]+)`, "i"),
  );
  return match ? match[1].trim() : null;
}

/**
 * 상속되는 선언(stroke·stroke-width)을 해석한다.
 * 우선순위는 CSS 사양대로 인라인 `style` > presentation 속성 > 상속값이다.
 */
function inheritedAttr(tag, name, inherited) {
  const inline = styleProp(tag, name);
  if (inline !== null && inline !== "") return inline;
  const own = firstAttr(tag, name);
  return own === null || own === undefined || own === ""
    ? inherited
    : own;
}

function strokeHalfOf(tag, inheritedStroke) {
  const stroke = inheritedAttr(tag, "stroke", inheritedStroke.paint);
  if (!stroke || stroke === "none") return 0;
  const widthRaw = inheritedAttr(tag, "stroke-width", inheritedStroke.width);
  const width = Number(String(widthRaw ?? "1").trim().replace(/px$/, ""));
  return Number.isFinite(width) ? width / 2 : 0;
}

/**
 * 태그 하나가 만드는 좌표들을 [matrix]로 절대화해 [visit]한다.
 * stroke가 있으면 반폭만큼 바깥으로 부풀린다(잉크는 stroke 외곽까지다).
 */
function visitTagInk(tag, name, matrix, inherited, visit) {
  const own = firstAttr(tag, "transform");
  const m = own ? composeMatrix(matrix, parseTransformChain(own)) : matrix;
  const half = strokeHalfOf(tag, inherited.stroke);
  const label = describeTag(tag, name, inherited.owner);
  const strokeX = half * Math.hypot(m[0], m[2]);
  const strokeY = half * Math.hypot(m[1], m[3]);
  const putAbsolute = (x, y) => {
    visit(x, y, label);
    if (half > 0) {
      visit(x - strokeX, y - strokeY, label);
      visit(x + strokeX, y + strokeY, label);
    }
  };
  const put = (x, y) => {
    const [ax, ay] = applyMatrix(m, x, y);
    putAbsolute(ax, ay);
  };

  switch (name) {
    case "path": {
      const d = firstAttr(tag, "d");
      if (d) visitPathExtremes(d, putAbsolute, m);
      return;
    }
    case "circle": {
      const cx = numAttr(tag, "cx", 0);
      const cy = numAttr(tag, "cy", 0);
      const r = numAttr(tag, "r");
      if (!Number.isFinite(r)) return;
      const [x, y] = applyMatrix(m, cx, cy);
      const dx = Math.hypot(m[0] * r, m[2] * r);
      const dy = Math.hypot(m[1] * r, m[3] * r);
      putAbsolute(x - dx, y - dy);
      putAbsolute(x + dx, y + dy);
      return;
    }
    case "ellipse": {
      const cx = numAttr(tag, "cx", 0);
      const cy = numAttr(tag, "cy", 0);
      const rx = numAttr(tag, "rx");
      const ry = numAttr(tag, "ry");
      if (!Number.isFinite(rx) || !Number.isFinite(ry)) return;
      const [x, y] = applyMatrix(m, cx, cy);
      const dx = Math.hypot(m[0] * rx, m[2] * ry);
      const dy = Math.hypot(m[1] * rx, m[3] * ry);
      putAbsolute(x - dx, y - dy);
      putAbsolute(x + dx, y + dy);
      return;
    }
    case "rect": {
      const x = numAttr(tag, "x", 0);
      const y = numAttr(tag, "y", 0);
      const w = numAttr(tag, "width");
      const h = numAttr(tag, "height");
      if (!Number.isFinite(w) || !Number.isFinite(h)) return;
      put(x, y);
      put(x + w, y);
      put(x, y + h);
      put(x + w, y + h);
      return;
    }
    case "line": {
      put(numAttr(tag, "x1", 0), numAttr(tag, "y1", 0));
      put(numAttr(tag, "x2", 0), numAttr(tag, "y2", 0));
      return;
    }
    case "polyline":
    case "polygon": {
      const points = firstAttr(tag, "points");
      if (!points) return;
      const nums = points
        .trim()
        .split(/[\s,]+/)
        .map(Number)
        .filter(Number.isFinite);
      for (let i = 0; i + 1 < nums.length; i += 2) put(nums[i], nums[i + 1]);
      return;
    }
    default:
      throw new Error(`visitTagInk: 그리기 태그가 아닙니다: <${name}>`);
  }
}

/**
 * [openIndex]에서 시작하는 `<name>`의 짝이 되는 `</name>` **뒤** 인덱스.
 * 자기폐쇄 `<name … />`는 깊이를 올리지 않는다(올리면 seoul처럼 자기폐쇄
 * `<g/>`를 가진 문서에서 짝을 영영 못 찾는다).
 */
function matchingEnd(text, openIndex, name) {
  const tagRe = new RegExp(String.raw`<(/?)${name}\b([^>]*)>`, "g");
  tagRe.lastIndex = openIndex;
  let depth = 0;
  let match;
  while ((match = tagRe.exec(text))) {
    const [full, closing, attrs] = match;
    const selfClose = attrs.endsWith("/") ? "/" : "";
    if (closing === "/") {
      depth -= 1;
      if (depth === 0) return match.index + full.length;
      continue;
    }
    if (selfClose === "/") {
      if (depth === 0) return match.index + full.length;
      continue;
    }
    depth += 1;
  }
  throw new Error(`<${name}> 닫는 태그를 찾지 못했습니다.`);
}

const CONTAINER_TAGS = new Set(["g", "svg", "a", "switch"]);

/** 컨테이너가 자식에게 물려줄 transform·상속 선언. */
function childContext(openTag, matrix, inherited) {
  const childTransform = firstAttr(openTag, "transform");
  return {
    matrix: childTransform
      ? composeMatrix(matrix, parseTransformChain(childTransform))
      : matrix,
    inherited: {
      owner: firstAttr(openTag, "id") ?? inherited.owner,
      stroke: {
        paint: inheritedAttr(openTag, "stroke", inherited.stroke.paint),
        width: inheritedAttr(openTag, "stroke-width", inherited.stroke.width),
      },
    },
  };
}

/** 렌더에 참여하지 않거나 제외된 서브트리인지 판정한다. */
function isSkipped(name, id, excluded) {
  return NON_RENDERING_TAGS.has(name) || Boolean(id && excluded.has(id));
}

/** 처리할 수 없는 태그는 조용히 넘기지 않고 던진다. */
function rejectUnknownTag(name) {
  if (name === "use") {
    throw new TypeError(
      "svg-ink-bbox: <use>는 아직 지원하지 않습니다 — 참조 대상 잉크를 " +
        "놓치지 않도록 fail-closed로 막습니다.",
    );
  }
  if (name === "text") {
    throw new TypeError(
      "svg-ink-bbox: <text>는 글자 폭을 어림해야 해서 재지 않습니다 — " +
        "outlineBasemapText로 윤곽선을 구운 컴파일 입력을 넘기세요.",
    );
  }
  throw new TypeError(
    `svg-ink-bbox: 알 수 없는 태그 <${name}>입니다. 잉크를 놓친 채 게이트가 ` +
      "통과하지 않도록 fail-closed로 막습니다 — 렌더에 참여하면 " +
      "DRAWABLE_TAGS에, 아니면 NON_RENDERING_TAGS에 등록하세요.",
  );
}

/** 여는 태그 하나가 차지하는 범위의 끝 인덱스(자식 포함). */
function elementEnd(text, openIndex, openTag, name, selfClose) {
  return selfClose
    ? openIndex + openTag.length
    : matchingEnd(text, openIndex, name);
}

/** 컨테이너 하나를 파고든다. */
function walkContainer(node, matrix, inherited, excluded, visit) {
  const { text, openIndex, openTag, name, selfClose } = node;
  if (selfClose) return openIndex + openTag.length;
  const child = childContext(openTag, matrix, inherited);
  const end = matchingEnd(text, openIndex, name);
  const body = text.slice(openIndex + openTag.length, end - `</${name}>`.length);
  walk(body, child.matrix, child.inherited, excluded, visit);
  return end;
}

function walk(text, matrix, inherited, excluded, visit) {
  const tagRe = /<([a-zA-Z][\w:.-]*)\b([^>]*)>/g;
  let match;
  while ((match = tagRe.exec(text))) {
    const [openTag, name, attrs] = match;
    const node = {
      text,
      openIndex: match.index,
      openTag,
      name,
      selfClose: attrs.endsWith("/"),
    };

    if (isSkipped(name, firstAttr(openTag, "id"), excluded)) {
      tagRe.lastIndex = elementEnd(text, match.index, openTag, name, node.selfClose);
    } else if (CONTAINER_TAGS.has(name)) {
      tagRe.lastIndex = walkContainer(node, matrix, inherited, excluded, visit);
    } else if (DRAWABLE_TAGS.has(name)) {
      visitTagInk(openTag, name, matrix, inherited, visit);
      tagRe.lastIndex = elementEnd(text, match.index, openTag, name, node.selfClose);
    } else {
      rejectUnknownTag(name);
    }
  }
}

/**
 * [svgText](윤곽선까지 구운 컴파일 입력)의 잉크 bbox를 낸다.
 * [excludeIds]로 지정한 id의 서브트리는 통째로 제외한다.
 */
export function inkBBoxOf(svgText, { excludeIds = [] } = {}) {
  const excluded = new Set(excludeIds);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const edges = { minX: null, minY: null, maxX: null, maxY: null };
  const rootMatch = svgText.match(/<svg\b[^>]*>/);
  if (!rootMatch) throw new Error("svg-ink-bbox: <svg> 루트를 찾지 못했습니다.");
  const body = svgText.slice(
    rootMatch.index + rootMatch[0].length,
    svgText.lastIndexOf("</svg>"),
  );
  walk(
    body,
    IDENTITY,
    { owner: null, stroke: { paint: null, width: null } },
    excluded,
    (x, y, label) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (x < minX) { minX = x; edges.minX = label; }
      if (y < minY) { minY = y; edges.minY = label; }
      if (x > maxX) { maxX = x; edges.maxX = label; }
      if (y > maxY) { maxY = y; edges.maxY = label; }
    },
  );
  if (!Number.isFinite(minX)) {
    throw new TypeError("svg-ink-bbox: 잉크를 하나도 찾지 못했습니다.");
  }
  return { minX, minY, maxX, maxY, edges };
}

/** 루트 `<svg>`의 viewBox를 [x, y, width, height]로 읽는다. */
export function viewBoxOf(svgText) {
  const raw = svgText.match(/<svg\b[^>]*?\bviewBox="([^"]+)"/);
  if (!raw) throw new Error("svg-ink-bbox: 루트 viewBox를 찾지 못했습니다.");
  const parts = raw[1].trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) {
    throw new Error(`svg-ink-bbox: viewBox 값이 유효하지 않습니다: "${raw[1]}"`);
  }
  return parts;
}
