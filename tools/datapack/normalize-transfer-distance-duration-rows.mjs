#!/usr/bin/env node
// #1701 Phase 2: 환승역거리 소요시간 공식 raw row → import-transfer-baseline parseTransferRow
// 기대 형식으로 변환하는 얇은 normalizer.
//
// 입력 raw row 형식(공공기관 공식 제공):
//   { 연번:int, 호선:int(정수 예 1,3,4), 환승거리:int(m), 환승노선:string(예 "4호선"),
//     환승소요시간:string "MM:SS"(예 "02:13"), 환승역명:string }
//
// importer의 parseTransferRow는 호선/환승노선을 non-empty string, 환승거리를 non-negative integer,
// 환승소요시간을 non-negative integer(초)로 기대한다. 이 normalizer는 두 축만 손댄다:
//   - 호선 정수 N → "N호선" 문자열(환승노선은 이미 문자열이라 원형 유지).
//   - 환승소요시간 "MM:SS" → 초 정수(MM*60+SS). MM/SS는 0-59 범위를 벗어나거나 형식이
//     어긋나면 변환 실패(malformed)로 남긴다.
//
// 환승노선이 지하철 호선이 아닌 값(공항철도/경의중앙선/GTX-A/우이신설선 등)은 임의로 필터링하지
// 않는다 — 그대로 통과시켜 importer의 matchLineForStation이 자연스럽게 quarantine하게 둔다.
// 형식 파싱 실패 행도 조용히 버리지 않는다 — malformed 배열에 사유와 함께 남겨 정직하게 계측한다.
//
// 반환: { normalizedRows, malformed }.
//   - normalizedRows: parseTransferRow 기대 형식으로 변환된 행.
//   - malformed: { row, reason } — 변환 실패 행(적재 대상에서 제외되지만 은폐되지 않음).
//
// 사용: node tools/datapack/normalize-transfer-distance-duration-rows.mjs \
//   --rows <in.json> --output <out.json>
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseArgs, readJsonFile, requireArg, requiredArray, sortJson } from "./lib/ledger-admission-cli.mjs";

const MINUTE_SECONDS = 60;
const TIME_UNIT_MAX = 59;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = requiredArray(await readJsonFile(requireArg(args, "rows")), "rows");
  const outputPath = requireArg(args, "output");

  const result = normalizeTransferDistanceDurationRows(rows);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(sortJson(result), null, 2)}\n`);
}

/**
 * 순수 함수: raw 환승역거리 소요시간 rows → { normalizedRows, malformed }.
 * 호선 정수 → "N호선" 문자열, 환승소요시간 "MM:SS" → 초 정수로 변환한다.
 * 변환 실패 행은 malformed에 사유와 함께 기록한다(필터링·throw 금지).
 */
export function normalizeTransferDistanceDurationRows(rows) {
  const normalizedRows = [];
  const malformed = [];

  for (const raw of rows ?? []) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      malformed.push({ row: raw, reason: "transfer row must be an object" });
      continue;
    }
    const lineName = normalizeLineNumber(raw["호선"]);
    if (lineName.error) {
      malformed.push({ row: raw, reason: lineName.error });
      continue;
    }
    const transferSeconds = parseMinuteSecond(raw["환승소요시간"]);
    if (transferSeconds.error) {
      malformed.push({ row: raw, reason: transferSeconds.error });
      continue;
    }
    normalizedRows.push({
      ...raw,
      호선: lineName.value,
      환승소요시간: transferSeconds.value,
    });
  }

  return { normalizedRows, malformed };
}

// 호선 정수 N → "N호선" 문자열. 문자열도 전체 N호선 형식만 허용한다.
function normalizeLineNumber(value) {
  if (typeof value === "string" && value.trim() !== "") {
    const trimmed = value.trim();
    if (/^[1-9]\d*호선$/.test(trimmed)) return { value: trimmed };
  }
  if (Number.isInteger(value) && value > 0) {
    return { value: `${value}호선` };
  }
  return { error: `호선 must be a positive integer or N호선 string: ${JSON.stringify(value)}` };
}

// "MM:SS" → 초 정수. 콜론 없음·비숫자·MM/SS 범위(0-59) 초과는 malformed.
function parseMinuteSecond(value) {
  if (typeof value !== "string") {
    return { error: `환승소요시간 must be a "MM:SS" string: ${JSON.stringify(value)}` };
  }
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    return { error: `환승소요시간 format invalid (expected MM:SS): ${value}` };
  }
  const minutes = Number.parseInt(match[1], 10);
  const seconds = Number.parseInt(match[2], 10);
  if (minutes > TIME_UNIT_MAX || seconds > TIME_UNIT_MAX) {
    return { error: `환승소요시간 minute/second out of range (0-${TIME_UNIT_MAX}): ${value}` };
  }
  return { value: minutes * MINUTE_SECONDS + seconds };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
