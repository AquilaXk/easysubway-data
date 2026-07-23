import path from "node:path";
import { pathToFileURL } from "node:url";

/** relative argv[1]도 import.meta.url과 같게 비교한다. */
export function isMainModule(metaUrl = import.meta.url, argv1 = process.argv[1]) {
  if (!argv1) {
    return false;
  }
  return metaUrl === pathToFileURL(path.resolve(argv1)).href;
}
