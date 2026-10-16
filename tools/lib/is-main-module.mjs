import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * relative argv[1]도 import.meta.url과 같게 비교한다.
 * metaUrl에 기본값이 없고 file: URL 문자열만 받는다. lib 자신의 URL이 기본값이면 인자 없는 호출이 항상 false가 되어 CLI가 조용히 아무것도 하지 않는다.
 */
export function isMainModule(metaUrl, argv1 = process.argv[1]) {
  if (typeof metaUrl !== "string" || !metaUrl.startsWith("file:")) {
    throw new TypeError("IS_MAIN_MODULE_META_URL: isMainModule(import.meta.url)처럼 호출 모듈의 file: URL(import.meta.url)을 넘겨야 한다.");
  }
  if (!argv1) {
    return false;
  }
  return metaUrl === pathToFileURL(path.resolve(argv1)).href;
}
