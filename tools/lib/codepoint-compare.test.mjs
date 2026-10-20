import assert from "node:assert/strict";
import test from "node:test";

import { codepointCompare } from "./codepoint-compare.mjs";

// 인자 없는 Array.prototype.sort()의 기본 순서(UTF-16 code unit)를 비교자로 옮긴 것이어야 한다.
// 정렬 결과가 datapack 바이트·해시에 들어가므로 localeCompare·code point 순서와 달라지면 안 된다.
const SAMPLES = ["b", "a", "B", "", "10", "9", "한글", "가", "나", "ABC", "abc", "😀", "～", "\u{1F600}x", "𠮷", "a-b", "a_b"];

test("codepointCompare는 기본 sort()와 같은 UTF-16 code unit 순서로 정렬한다", () => {
  assert.deepEqual([...SAMPLES].sort(codepointCompare), [...SAMPLES].sort());
});

test("서로게이트 쌍은 code point가 아니라 code unit으로 비교한다", () => {
  // U+1F600은 D83D DE00이라 code unit 순서에서 U+FF5E(FF5E)보다 앞서고, code point 순서에서는 뒤다.
  assert.equal(codepointCompare("\u{1F600}", "～"), -1);
  assert.equal(codepointCompare("～", "\u{1F600}"), 1);
});

test("한글은 가나다 코드 순서이고 로케일에 의존하지 않는다", () => {
  assert.deepEqual(["나", "다", "가", "힣", "ㄱ"].sort(codepointCompare), ["ㄱ", "가", "나", "다", "힣"]);
  assert.equal(codepointCompare("가", "가"), 0);
});

test("대문자는 소문자보다 앞서고 숫자 문자열은 문자 순서로 비교한다", () => {
  assert.equal(codepointCompare("B", "a"), -1);
  assert.equal(codepointCompare("10", "9"), -1);
});
