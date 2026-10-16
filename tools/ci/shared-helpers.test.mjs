import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { sha256 } from "../lib/hash.mjs";
import { isObject } from "../lib/value.mjs";

// 통합 전 각 도구가 따로 두던 구현. 같은 입력에서 같은 출력인지 대조한다.
const legacySha256 = (value) => createHash("sha256").update(value).digest("hex");
const legacyIsObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const SHA256_CASES = [
  { label: "빈 문자열", input: "", expected: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
  { label: "ASCII 문자열", input: "abc", expected: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
  { label: "한글 문자열(UTF-8)", input: "한글 지하철", expected: "5bb29bd7ce9fc0fe3709ddb6a53ab3664819b5251a6e1772aeb591f6a9ec6c66" },
  { label: "바이너리 Buffer", input: Buffer.from([0, 255, 16, 128]), expected: "a33bb2aed757bc839807d7a9deab0688c3cf06d36e53cb428f2e539c8dc76c5b" },
  { label: "빈 Buffer", input: Buffer.alloc(0), expected: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
];

for (const { label, input, expected } of SHA256_CASES) {
  test(`sha256: ${label}는 고정 기대 해시와 기존 구현 출력을 모두 낸다`, () => {
    assert.equal(sha256(input), expected);
    assert.equal(sha256(input), legacySha256(input));
  });
}

test("sha256: 같은 바이트의 문자열과 Buffer 입력은 같은 해시를 낸다", () => {
  assert.equal(sha256("한글"), sha256(Buffer.from("한글", "utf8")));
});

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
  test(`isObject: ${label}는 ${expected}이며 기존 구현과 같다`, () => {
    assert.equal(isObject(input), expected);
    assert.equal(isObject(input), legacyIsObject(input));
  });
}
