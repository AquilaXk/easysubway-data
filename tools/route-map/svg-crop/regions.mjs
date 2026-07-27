// svg-crop 도구가 공유하는 권역 정의와 저장소 내부 경로.
//
// 도구는 **CLI로 임의 경로를 받지 않는다.** 권역 id만 받아 저장소 안에서 경로를
// 해석하고, 산출물도 저장소 안 `.out/`에만 쓴다. 저장소 도구가 바깥 파일을 읽고
// 쓸 이유가 없고, 경로를 인자로 받으면 그 자체가 사고 경로가 된다.

import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** `tools/route-map/svg-crop` */
export const scriptDir = here;

/** 오너 SVG 원본이 있는 디렉터리. */
export const svgSourceDir = path.join(here, "..", "route-map-defs", "svg-sources");

/** 렌더 산출물 디렉터리(저장소 안, .gitignore 대상). */
export const outDir = path.join(here, ".out");

export const REGIONS = Object.freeze({
  seoul: "easy-subway-sma-v4.svg",
  busan: "easy-subway-busan-v3.svg",
  daegu: "easy-subway-daegu-v3.svg",
  daejeon: "easy-subway-daejeon-v3.svg",
  gwangju: "easy-subway-gwangju-v3.svg",
});

/** 권역 id → 오너 SVG 절대경로. 모르는 id는 던진다. */
export function svgPathFor(regionId) {
  const file = Object.hasOwn(REGIONS, regionId) ? REGIONS[regionId] : null;
  if (!file) {
    throw new Error(
      `알 수 없는 권역 "${regionId}" — ${Object.keys(REGIONS).join(", ")} 중 하나여야 합니다.`,
    );
  }
  return path.join(svgSourceDir, file);
}

/** 저장소 루트 기준 상대경로(git show용). */
export function repoRelativeSvg(regionId) {
  const repoRoot = path.resolve(here, "..", "..", "..");
  return path.relative(repoRoot, svgPathFor(regionId)).replaceAll(path.sep, "/");
}

/** 저장소 루트 절대경로. */
export function repoRoot() {
  return path.resolve(here, "..", "..", "..");
}

/** git ref로 쓸 수 있는 안전한 문자열인지 확인한다. */
export function assertSafeRef(ref) {
  if (!/^[\w./@^~-]+$/.test(ref)) {
    throw new Error(`git ref에 쓸 수 없는 문자가 있습니다: "${ref}"`);
  }
  return ref;
}
