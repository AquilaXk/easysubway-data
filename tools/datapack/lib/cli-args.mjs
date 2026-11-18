// `--flag value` 쌍만 받는 CLI 인자 파서. 중복 플래그를 거부해 같은 인자를 두 번 넘긴 실수가
// 조용히 마지막 값으로 덮이지 않게 한다.
// ledger-admission-cli.mjs의 parseArgs와 달리 Map을 돌려주고 중복을 오류로 본다 — release 경로
// 스크립트들이 쓰던 관용구를 그대로 옮긴 것이다.
export function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`invalid argument near ${key ?? "<end>"}`);
    }
    if (args.has(key.slice(2))) throw new Error(`duplicate argument: ${key}`);
    args.set(key.slice(2), value);
  }
  return args;
}

export function requiredArg(args, name) {
  const value = args.get(name);
  if (typeof value !== "string" || value.length === 0) throw new Error(`--${name} is required`);
  return value;
}
