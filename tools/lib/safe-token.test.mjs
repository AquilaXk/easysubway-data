import assert from "node:assert/strict";
import test from "node:test";

import { SAFE_TOKEN, isSafeToken } from "./safe-token.mjs";

test("안전한 토큰: 영숫자·점·밑줄·하이픈 1~48자만 받는다", () => {
  for (const value of ["a", "busan-transportation-route-topology", "A.b_c-9", "x".repeat(48)]) assert.equal(isSafeToken(value), true, value);
});

test("안전한 토큰: 빈 값, 49자, 경로·공백·개행·비밀이 섞일 수 있는 문자, 문자열이 아닌 값은 거부한다", () => {
  for (const value of ["", "x".repeat(49), "../../etc", "a b", "a\n", "a/b", "key=secret", "한글", 1, null, undefined, ["a"]]) assert.equal(isSafeToken(value), false, String(value));
  assert.equal(SAFE_TOKEN.test("x".repeat(48)), true);
});
