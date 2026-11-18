import assert from "node:assert/strict";
import test from "node:test";

import { isObject } from "./is-object.mjs";

const IS_OBJECT_CASES = [
  { label: "빈 객체", input: {}, expected: true },
  { label: "일반 객체", input: { a: 1 }, expected: true },
  { label: "null 프로토타입 객체", input: Object.create(null), expected: true },
  { label: "null", input: null, expected: false },
  { label: "undefined", input: undefined, expected: false },
  { label: "빈 배열", input: [], expected: false },
  { label: "비어 있지 않은 배열", input: [{}], expected: false },
  { label: "문자열", input: "text", expected: false },
  { label: "숫자", input: 0, expected: false },
  { label: "boolean", input: false, expected: false },
  { label: "함수", input: () => ({}), expected: false },
];

for (const { label, input, expected } of IS_OBJECT_CASES) {
  test(`isObject: ${label}는 ${expected}다`, () => {
    assert.equal(isObject(input), expected);
  });
}
