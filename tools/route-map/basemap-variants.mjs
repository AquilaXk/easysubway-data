// 바탕층 .vec 변형(#1495). 두 변형은 같은 정규화와 같은 노선 강조 레이어 분할에서 나오고,
// 라벨을 .vec에 담는 방식만 다르다.
//   outlined  라벨을 참조 서체의 글리프 윤곽선 path로 굽는다(#1488). 기기 서체와 무관하다.
//   text      라벨을 .vec 텍스트 그리기로 둔다. 런타임이 기기 서체로 글자를 그린다.
// 앱은 렌더러에 맞는 변형을 고른다. Skia OpenGL 렌더러에서는 윤곽선 path가 텍스트보다 느리다.
// outlined 파일 이름은 변형을 나누기 전 이름 그대로다.
//
// 변형마다 최적화가 다르다(mergeDraws). 같은 paint 그리기를 이어 명령 수를 줄이는 합치기는
// Impeller에서 빨라지지만 Skia OpenGL에서는 이은 다중 윤곽선 path를 매 프레임 다시 처리해
// 느려진다(Galaxy A17 실측: 합친 텍스트 .vec는 합치기 전보다 벡터 경로 28~39% 느리고 2호선 래스터
// p50이 11.95에서 74.75 ms). 그래서 Skia 변형(text)은 합치지 않고, 두 변형 모두 불투명도 0 요소와
// 넓이 없는 채우기를 덜어낸다.

import { decodeXmlText, encodeXmlAttributeValue, firstFamilyOf } from "./basemap-svg-core.mjs";

export const OUTLINED_VARIANT_ID = "outlined";
export const TEXT_VARIANT_ID = "text";

// .vec TextConfig.fontFamily는 서체 이름 하나로 쓰인다(vector_graphics 1.2.3 listener.dart 686-698행 →
// dart:ui TextStyle.fontFamily, Flutter 3.44 text.dart 3613-3618행). CSS 목록 문자열은 없는 서체
// 하나로 풀려 기기 서체로 대체된다. 윤곽선 변형은 윤곽선 단계가 첫 서체(firstFamilyOf)로 글리프를
// 꺼내므로, 텍스트 변형도 같은 규칙으로 목록을 첫 서체로 줄여 같은 서체를 가리키게 한다.
// 속성(`font-family="…"`)과 style·CSS 선언(`font-family:…`)을 모두 줄인다. 선언 값에는
// `&quot;`처럼 `;`로 끝나는 엔티티가 들어올 수 있어 엔티티를 한 덩어리로 읽는다.
const FONT_FAMILY_ATTRIBUTE_RE = /(\sfont-family=")([^"]*)(")/g;
const FONT_FAMILY_DECLARATION_RE = /((?<![\w-])font-family\s*:\s*)((?:&[A-Za-z]+;|[^;"}])+)/g;

function reduceFontFamiliesToFirst(markup) {
  return markup
    .replace(
      FONT_FAMILY_ATTRIBUTE_RE,
      (_match, open, list, close) => `${open}${encodeXmlAttributeValue(firstFamilyOf(decodeXmlText(list)))}${close}`,
    )
    .replace(
      FONT_FAMILY_DECLARATION_RE,
      (_match, open, list) => `${open}${encodeXmlAttributeValue(firstFamilyOf(decodeXmlText(list)))}`,
    );
}

export const BASEMAP_VARIANTS = Object.freeze([
  Object.freeze({
    id: OUTLINED_VARIANT_ID,
    labels: "outlined-into-vec",
    fileSuffix: "",
    mergeDraws: true,
    compileInput: (normalizedSvg, outlineBasemapText) => outlineBasemapText(normalizedSvg).svg,
  }),
  Object.freeze({
    id: TEXT_VARIANT_ID,
    labels: "text-into-vec",
    fileSuffix: ".text",
    mergeDraws: false,
    compileInput: reduceFontFamiliesToFirst,
  }),
]);

export function basemapVariant(variantId) {
  const variant = BASEMAP_VARIANTS.find(({ id }) => id === variantId);
  if (!variant) throw new Error(`알 수 없는 바탕층 변형 ${variantId}`);
  return variant;
}

// 파일 이름 `<권역>.<노선>.text.vec`는 점으로 나뉘고 `.text` 접미가 변형을 가른다. 점이나 `.text`가 든
// id는 되읽을 때 다른 권역·노선·변형으로 읽히므로 이름을 만들 때 거부한다.
const BASEMAP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

function assertBasemapId(kind, id) {
  if (typeof id !== "string" || !BASEMAP_ID_PATTERN.test(id)) {
    throw new Error(`${kind} id ${JSON.stringify(id)}가 파일 이름에 쓸 수 있는 형식(${BASEMAP_ID_PATTERN})이 아닙니다.`);
  }
}

/** 권역 바탕(lineId 없음) 또는 노선 강조 레이어의 .vec 파일 이름. */
export function basemapVectorFileName(variantId, regionId, lineId = null) {
  assertBasemapId("권역", regionId);
  if (lineId !== null) assertBasemapId("노선", lineId);
  const stem = lineId === null ? regionId : `${regionId}.${lineId}`;
  return `${stem}${basemapVariant(variantId).fileSuffix}.vec`;
}

/** basemapVectorFileName의 역. 형식에 맞지 않으면 던진다. */
export function parseBasemapVectorFileName(name) {
  if (!name.endsWith(".vec")) throw new Error(`${name}: .vec 파일 이름이 아닙니다.`);
  const stem = name.slice(0, -".vec".length);
  const variant =
    BASEMAP_VARIANTS.find(({ fileSuffix }) => fileSuffix !== "" && stem.endsWith(fileSuffix)) ??
    basemapVariant(OUTLINED_VARIANT_ID);
  const [regionId, ...rest] = stem.slice(0, stem.length - variant.fileSuffix.length).split(".");
  return { variantId: variant.id, regionId, lineId: rest.length === 0 ? null : rest.join(".") };
}
