import { createHash } from "node:crypto";

/** 문자열(UTF-8)이나 Buffer 입력의 SHA-256을 소문자 hex로 돌려준다. */
export const sha256 = (input) => createHash("sha256").update(input).digest("hex");
