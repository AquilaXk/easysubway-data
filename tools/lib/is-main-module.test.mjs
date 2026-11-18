import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { isMainModule } from "./is-main-module.mjs";

const SCRIPT = path.resolve("tools/ci/example.mjs");
const SCRIPT_URL = pathToFileURL(SCRIPT).href;

test("argv[1]이 호출 모듈이면 true, 상대 경로도 같게 비교한다", () => {
  assert.equal(isMainModule(SCRIPT_URL, SCRIPT), true);
  assert.equal(isMainModule(SCRIPT_URL, "tools/ci/example.mjs"), true);
});

test("argv[1]이 다른 모듈이거나 없으면 false", () => {
  assert.equal(isMainModule(SCRIPT_URL, path.resolve("tools/ci/other.mjs")), false);
  assert.equal(isMainModule(SCRIPT_URL, undefined), false);
});

// lib 자신의 URL이 기본값이면 호출부가 항상 false를 받아 CLI가 아무것도 하지 않고 성공한다(#1287).
test("metaUrl이 file: URL 문자열이 아니면 던진다", () => {
  for (const metaUrl of [undefined, null, 42, {}, "", SCRIPT, "https://example.com/a.mjs"]) {
    assert.throws(() => isMainModule(metaUrl, SCRIPT), /IS_MAIN_MODULE_META_URL/);
  }
  assert.throws(() => isMainModule(), /IS_MAIN_MODULE_META_URL/);
});
