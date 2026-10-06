// 대구·대전·광주 공식 수집기가 공유하는 `--download` 모드 인자 해석과 입력 적재.
import { readFile } from "node:fs/promises";
import path from "node:path";

import { downloadDataGoFiles } from "./data-go-file-download.mjs";

const hasValue = (value) => typeof value === "string" && value.length > 0 && !value.startsWith("--");

// 규칙을 어기면 usage 한 줄로 실패한다. 다운로드 capture 시각은 FILE 본문을 받은 시각이라 지정할 수 없다.
export function parseDownloadModeArgs(argv, {
  usage, valueFlags, fileModeRequired, downloadRequired, downloadForbidden, absolute,
}) {
  const args = { download: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (seen.has(flag)) throw new Error(usage);
    seen.add(flag);
    if (flag === "--download") {
      args.download = true;
      continue;
    }
    const name = flag?.startsWith("--") ? flag.slice(2) : "";
    if (!valueFlags.includes(name) || !hasValue(argv[index + 1])) throw new Error(usage);
    args[name] = argv[index + 1];
    index += 1;
  }
  const required = args.download ? downloadRequired : fileModeRequired;
  const forbidden = args.download ? downloadForbidden : [];
  if (required.some((name) => !args[name]) || forbidden.some((name) => args[name] !== undefined)
    || absolute.some((name) => args[name] !== undefined && !path.isAbsolute(args[name]))) {
    throw new Error(usage);
  }
  return args;
}

function validDate(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} is invalid`);
  return date;
}

export function resolveCapturedAt(args, now = () => new Date()) {
  if (args.download) return validDate(now(), "now");
  return args["captured-at"] ? validDate(args["captured-at"], "captured-at") : validDate(now(), "now");
}

// 파일 모드의 inputPaths는 datasetIds와 같은 순서이며, 다운로드 모드에서는 쓰지 않는다.
export async function loadDataGoInputs({ args, fetchImpl, datasetIds, inputPaths }) {
  if (args.download) return downloadDataGoFiles(fetchImpl, datasetIds);
  return {
    bytes: await Promise.all(inputPaths.map((inputPath) => readFile(inputPath))),
    downloadProvenance: undefined,
  };
}
