// 바탕층 컴파일러(compile-basemap-vec.mjs)와 라벨 윤곽선 굽기(outline-basemap-text.mjs)가
// 함께 쓰는 SVG 읽기 기반(#1488). 두 모듈은 서로를 불러오지 않고 이 잎 모듈만 불러온다.
// 요소 트리, 속성·상속 조회, XML 엔티티, 길이 문법, 굵기별 참조 페이스를 둔다.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

// 참조 페이스는 오너가 도식을 설계한 Pretendard의 Regular·SemiBold·Bold·ExtraBold·
// Black이다. 바탕층은 라벨을 이 페이스의 글리프 윤곽선으로 굽는다
// (outline-basemap-text.mjs, #1488). 그래서 기기 서체와 무관하게 오너 도식의 글자
// 모양이 그대로 그려진다.
//
// 페이스 파일은 Pretendard v1.3.9 배포본(public/static)과 바이트가 같은 무수정
// 사본이고 OFL.txt와 함께 둔다. 이 서체로 그린 노선도 그림은 OFL이 말하는 "서체로
// 만든 문서"라 서체 라이선스의 적용 대상이 아니다(OFL.txt "does not apply to any
// document created using the fonts"). 서체 이름이나 파일을 고치지 않는다.
// 바이트는 읽는 지점에서 sha256으로 확인한다. 다시 인코딩한 서체는 폭·윤곽선을 바꿔
// 산출물이 조용히 달라진다.
function referenceFace(fileName, sha256) {
  return Object.freeze({
    file: path.join(import.meta.dirname, "fonts", fileName),
    sha256,
  });
}

export const REFERENCE_TEXT_FACES = new Map([
  [400, referenceFace("Pretendard-Regular.otf", "3ffbacde6ab8411f1d2db54bb9b1f0b3ee2a738932033722cf0388c06aed1c93")],
  [600, referenceFace("Pretendard-SemiBold.otf", "c89bc43027dc7cde5726e96223376f8eec09302b2fc1f8147fd5b57cfc376118")],
  [700, referenceFace("Pretendard-Bold.otf", "2e91915fab54df71cc9598ebf608b2bdb54c6fe3c066ac61dff0bc44fca71cc7")],
  [800, referenceFace("Pretendard-ExtraBold.otf", "c35fe941b7568d52a96010561540e47f9d3948dfde66ba25bc1908233e0a40cd")],
  [900, referenceFace("Pretendard-Black.otf", "94628b0bcea8936b6e5c30d98d685eb9bbaffb0fe2ed255542ecc656c248e021")],
]);
export const REFERENCE_TEXT_FONT_WEIGHTS = [...REFERENCE_TEXT_FACES.keys()];

/** 참조 페이스 바이트를 읽는다. 고정 digest와 다르면 던진다. */
export function readReferenceFontBytes(fontPath, expectedSha256) {
  const buffer = readFileSync(fontPath);
  const digest = createHash("sha256").update(buffer).digest("hex");
  if (digest !== expectedSha256) {
    throw new Error(
      `${fontPath}: 참조 서체 바이트가 고정 digest와 다릅니다(sha256 ${digest}, 기대 ${expectedSha256}).`,
    );
  }
  return buffer;
}

// SVG 요소 트리(여는 태그 스트림 기반). 컴파일러의 표장 전수 수집·장식 bbox 판정과
// 윤곽선 굽기가 쓴다. 기존 레이어 슬라이스 경로(extractGroup)는 이 트리를 쓰지 않는다.
export function buildSvgTree(svgText) {
  const root = {
    name: "#root",
    openTag: "",
    start: 0,
    end: svgText.length,
    children: [],
    parent: null,
  };
  const stack = [root];
  for (const match of svgText.matchAll(
    /<(\/?)([A-Za-z][\w:.-]*)\b([^>]*?)(\/?)>/g,
  )) {
    const [full, closing, name, , selfClosing] = match;
    if (closing) {
      if (stack.length > 1) {
        stack.at(-1).end = match.index + full.length;
        stack.pop();
      }
      continue;
    }
    const node = {
      name,
      openTag: full,
      start: match.index,
      end: match.index + full.length,
      children: [],
      parent: stack.at(-1),
    };
    stack.at(-1).children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

// XML 엔티티 ↔ 평문. `<style>` 내용은 XML 텍스트라 `&quot;` 같은 엔티티가 그대로
// 들어온다(오너 SVG의 `[data-label-role=&quot;ordinary&quot;]`·font-family 목록).
// 디코드하지 않으면 선택자 파싱과 `;` 분리가 모두 깨진다.
const XML_ENTITIES = [
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&apos;", "'"],
];

export function decodeXmlText(value) {
  let result = value;
  for (const [entity, plain] of XML_ENTITIES) result = result.replaceAll(entity, plain);
  return result.replaceAll("&amp;", "&");
}

/** XML 속성값 안에 쓸 수 있게 `& < > "`를 엔티티로 바꾼다. */
export function encodeXmlAttributeValue(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** font-family 목록의 첫 서체 이름(따옴표 제거). 윤곽선 단계와 텍스트 변형이 같은 규칙을 쓴다. */
export function firstFamilyOf(list) {
  const first = list.split(",")[0].trim();
  return first.replace(/^(['"])(.*)\1$/, "$2").trim();
}

// 텍스트 property의 CSS 초기값. 초기값은 렌더 차이가 없다. 윤곽선 단계는 letter-spacing을
// 배치에 쓰고 나머지는 초기값만 받으며(outline-basemap-text.mjs TEXT_PROPERTY_POLICY),
// 텍스트 변형은 초기값이 아닌 선언만 `.vec`가 담지 못하는 선언으로 센다
// (compile-basemap-vec.mjs unrepresentableTextDeclarations). 두 쪽이 이 표 하나를 읽는다.
export const TEXT_PROPERTY_INITIAL_VALUES = new Map(
  Object.entries({
    "letter-spacing": ["normal", "0", "0px"],
    "font-style": ["normal"],
    "font-variant": ["normal"],
    "font-stretch": ["normal"],
    "font-kerning": ["auto", "normal"],
    "font-feature-settings": ["normal"],
    "font-variant-ligatures": ["normal"],
    kerning: ["auto"],
    "word-spacing": ["normal", "0", "0px"],
    "writing-mode": ["lr-tb", "lr", "horizontal-tb"],
    direction: ["ltr"],
    "baseline-shift": ["baseline", "0", "0px"],
    "dominant-baseline": ["auto"],
    "alignment-baseline": ["auto", "baseline"],
    "text-decoration": ["none"],
    rotate: [],
    textLength: [],
    lengthAdjust: [],
  }).map(([name, values]) => [name, new Set(values)]),
);

export function firstAttr(tag, name) {
  const match = tag.match(new RegExp(String.raw`\s${name}="([^"]*)"`));
  return match ? match[1] : null;
}

/** 여는 태그에 선언된 property 값(인라인 style이 동명 presentation attribute를 이긴다). */
export function declaredStyleOrAttr(openTag, property) {
  const style = firstAttr(openTag, "style");
  if (style) {
    const declared = style.match(
      new RegExp(String.raw`(?:^|;)\s*${property}\s*:\s*([^;]+)`),
    )?.[1];
    if (declared != null) return declared.trim();
  }
  return firstAttr(openTag, property);
}

/**
 * 조상 체인까지 거슬러 상속 property의 유효 선언을 찾는다.
 * (font-size·stroke-width·letter-spacing 등 SVG 상속 property용.)
 */
export function inheritedStyleOrAttr(node, property) {
  for (let current = node; current && current.name !== "#root"; current = current.parent) {
    const value = declaredStyleOrAttr(current.openTag, property);
    if (value != null && value !== "" && value !== "inherit") return value;
  }
  return null;
}

// 결정성 유지를 위해 고정 소수 4자리로 직렬화(trailing zero는 Number가 정리).
export function roundCoord(value) {
  return Number(value.toFixed(4));
}

// SVG 길이 property(font-size·stroke-width·letter-spacing·x·y 등)가 받는 문법은 부호
// 있는 `<number>` 뒤에 선택적 `px`다. 숫자는 정수부 또는 소수부가 하나 이상이고, 정수부 뒤
// 소수점은 소수부를 `(?:\.\d*)?`로 묶어 정수부와 소수부가 한 숫자열을 나눠 갖지 못하게 한다.
// 이 모호함이 있으면(`\d+\.?\d*`) 긴 숫자열 거부에서 역추적이 제곱 시간이 된다.
const SVG_NUMBER_SOURCE = String.raw`-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?`;

/** 길이를 숫자(그룹 1)와 px 접미사(그룹 2)로 나누는 정규식 조각. */
const SVG_LENGTH_SOURCE = `(${SVG_NUMBER_SOURCE})([pP][xX])?`;
const SVG_LENGTH_RE = new RegExp(`^${SVG_LENGTH_SOURCE}$`);

/**
 * 길이 문자열을 `{ number, unit }`(unit은 "px" 또는 "")로 읽는다. 문법에 맞지 않거나
 * Number()가 Infinity로 넘치는 값(`1e999`, 수백 자리 숫자열)이면 null이다.
 */
export function parseSvgLength(raw) {
  const match = SVG_LENGTH_RE.exec(String(raw).trim());
  const number = match && Number(match[1]);
  return Number.isFinite(number) ? { number, unit: match[2]?.toLowerCase() ?? "" } : null;
}
