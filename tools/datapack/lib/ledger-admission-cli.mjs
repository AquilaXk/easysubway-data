// #1397 원장 해시 exporter / admin review record 생성기 공유 헬퍼.
//
// export-ledger-hashes.mjs와 build-admin-review-record.mjs가 공유하는
// CLI 인자 파싱·타입 검증·canonical 직렬화·JSON 파일 읽기 헬퍼를 한곳에 모은다.
// 두 도구의 CLI 인터페이스·출력 계약·위조 방지 로직은 불변이다.
import { readFile } from "node:fs/promises";

// `--flag value` 반복 형식만 허용하는 엄격한 인자 파서.
// 값 없는 플래그, `--`로 시작하지 않는 토큰은 거부한다.
export function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--")) throw new TypeError(`unexpected argument: ${flag}`);
    if (value == null || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    args[flag.slice(2)] = value;
    index += 1;
  }
  return args;
}

// 필수 인자를 non-empty 문자열로 강제한다.
export function requireArg(args, name) {
  return requiredString(args[name], `--${name}`);
}

export function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} is required`);
  }
  return value;
}

export function requiredArray(value, label) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value;
}

// 사전순 비교자 — 문자열 key/값 정렬에 재사용.
export function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

// 객체 key를 재귀적으로 사전순 정렬 — 결정적 canonical 직렬화의 기반.
export function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

// root 기준 상대 경로 JSON 파일을 읽어 파싱한다.
export async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}
