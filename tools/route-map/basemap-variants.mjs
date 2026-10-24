// 바탕층 .vec 변형(#1495). 두 변형은 같은 정규화와 같은 노선 강조 레이어 분할에서 나오고,
// 라벨을 .vec에 담는 방식만 다르다.
//   outlined  라벨을 참조 서체의 글리프 윤곽선 path로 굽는다(#1488). 기기 서체와 무관하다.
//   text      라벨을 .vec 텍스트 그리기로 둔다. 런타임이 기기 서체로 글자를 그린다.
// 앱은 렌더러에 맞는 변형을 고른다. Skia OpenGL 렌더러에서는 윤곽선 path가 텍스트보다 느리다.
// outlined 파일 이름은 변형을 나누기 전 이름 그대로다.

export const BASEMAP_VARIANTS = Object.freeze([
  Object.freeze({
    id: "outlined",
    labels: "outlined-into-vec",
    fileSuffix: "",
    compileInput: (normalizedSvg, outlineBasemapText) => outlineBasemapText(normalizedSvg).svg,
  }),
  Object.freeze({
    id: "text",
    labels: "text-into-vec",
    fileSuffix: ".text",
    compileInput: (normalizedSvg) => normalizedSvg,
  }),
]);

export function basemapVariant(variantId) {
  const variant = BASEMAP_VARIANTS.find(({ id }) => id === variantId);
  if (!variant) throw new Error(`알 수 없는 바탕층 변형 ${variantId}`);
  return variant;
}

/** 권역 바탕(lineId 없음) 또는 노선 강조 레이어의 .vec 파일 이름. */
export function basemapVectorFileName(variantId, regionId, lineId = null) {
  const stem = lineId === null ? regionId : `${regionId}.${lineId}`;
  return `${stem}${basemapVariant(variantId).fileSuffix}.vec`;
}

/** basemapVectorFileName의 역. 형식에 맞지 않으면 던진다. */
export function parseBasemapVectorFileName(name) {
  if (!name.endsWith(".vec")) throw new Error(`${name}: .vec 파일 이름이 아닙니다.`);
  const stem = name.slice(0, -".vec".length);
  const variant =
    BASEMAP_VARIANTS.find(({ fileSuffix }) => fileSuffix !== "" && stem.endsWith(fileSuffix)) ??
    basemapVariant("outlined");
  const [regionId, ...rest] = stem.slice(0, stem.length - variant.fileSuffix.length).split(".");
  return { variantId: variant.id, regionId, lineId: rest.length === 0 ? null : rest.join(".") };
}
