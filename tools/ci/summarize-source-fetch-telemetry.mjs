#!/usr/bin/env node
// 원천 수집 시도별 계측(tools/datapack/lib/source-fetch-telemetry.mjs, Refs AquilaXk/easysubway#3036)을 호스트별 Markdown 표로 모은다.
// source-reverification의 마지막 보고 step 바로 앞 step이 이 출력을 job summary에 붙인다. 표는 관측일 뿐이라 수집 결과·job 결과를 바꾸지 않는다.
//
// 열: 호스트, 시도 수, 실패 수, 오류 코드별 개수(전송 오류는 코드, 본문 resultCode 재시도는 resultCode <코드>, HTTP 실패는 HTTP <status>), p50·p95 소요(ms, 모든 시도의 nearest-rank).
// 계측 파일이 없으면(환경 변수 없음 포함) "계측 파일 없음", 파일은 있는데 기록이 없으면 "기록된 수집 시도가 없다"로 구분해 쓴다. 읽을 수 없는 줄은 건너뛰고 개수를 적는다(집계가 계측 한 줄 때문에 멈추지 않게 한다).
//
// 사용: node tools/ci/summarize-source-fetch-telemetry.mjs --input <telemetry.jsonl>
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { codepointCompare } from "../lib/codepoint-compare.mjs";

const PERCENTILES = Object.freeze({ p50: 50, p95: 95 });

/** nearest-rank 백분위수. values는 비어 있지 않아야 한다. */
export function percentile(values, rank) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1)];
}

const isRecord = (value) => typeof value === "object" && value !== null && typeof value.host === "string"
  && typeof value.outcome === "string" && Number.isFinite(value.durationMs);

/** JSONL 본문을 기록과 건너뛴 줄 수로 나눈다. */
export function parseTelemetry(text) {
  const records = [];
  let skipped = 0;
  for (const line of text.split("\n").filter((candidate) => candidate.trim() !== "")) {
    try {
      const parsed = JSON.parse(line);
      if (isRecord(parsed)) records.push(parsed); else skipped += 1;
    } catch { skipped += 1; }
  }
  return { records, skipped };
}

const compareText = ([left], [right]) => codepointCompare(left, right);

// 실패 행의 이름: 전송 오류는 오류 코드, 2xx지만 본문 resultCode 때문에 재시도한 시도는 resultCode, 그 밖의 HTTP 실패는 HTTP <status>.
function failureLabel(record) {
  if (record.outcome === "error") return String(record.errorCode ?? "UNKNOWN");
  if (record.outcome === "retryable_result") return `resultCode ${record.resultCode ?? "?"}`;
  return `HTTP ${record.status ?? "?"}`;
}

/** 호스트별 집계 행(호스트 이름순). */
export function summarizeByHost(records) {
  const byHost = new Map();
  for (const record of records) byHost.set(record.host, [...(byHost.get(record.host) ?? []), record]);
  return [...byHost.entries()].sort(compareText).map(([host, attempts]) => {
    const failures = attempts.filter(({ outcome }) => outcome !== "success");
    const codeCounts = new Map();
    for (const failure of failures) codeCounts.set(failureLabel(failure), (codeCounts.get(failureLabel(failure)) ?? 0) + 1);
    const durations = attempts.map(({ durationMs }) => durationMs);
    return {
      host,
      attempts: attempts.length,
      failures: failures.length,
      errorCodes: [...codeCounts.entries()].sort(compareText).map(([code, count]) => `${code} ${count}`).join(", "),
      p50Ms: percentile(durations, PERCENTILES.p50),
      p95Ms: percentile(durations, PERCENTILES.p95),
    };
  });
}

const escapeCell = (value) => String(value).replaceAll("|", String.raw`\|`);

/** job summary에 붙일 Markdown. */
export function renderSummary(text) {
  const { records, skipped } = parseTelemetry(text);
  const heading = "### 원천 수집 시도 계측";
  const skippedNote = skipped === 0 ? [] : ["", `읽을 수 없는 계측 ${skipped}줄은 집계에서 제외했다.`];
  if (records.length === 0) return [heading, "", "이번 실행에서 기록된 수집 시도가 없다.", ...skippedNote, ""].join("\n");
  const rows = summarizeByHost(records).map((row) => `| ${escapeCell(row.host)} | ${row.attempts} | ${row.failures} | ${escapeCell(row.errorCodes || "-")} | ${row.p50Ms} | ${row.p95Ms} |`);
  return [heading, "", "| 호스트 | 시도 | 실패 | 오류 코드별 | p50 ms | p95 ms |", "| --- | ---: | ---: | --- | ---: | ---: |", ...rows, ...skippedNote, ""].join("\n");
}

export const TELEMETRY_FILE_MISSING_SUMMARY = "### 원천 수집 시도 계측\n\n계측 파일 없음(계측 비활성 또는 수집 미실행).\n";

/** file이 비었거나 없으면 "계측 파일 없음"이다. 파일은 있는데 기록이 없는 경우("기록된 수집 시도가 없다")와 구분한다. */
export async function summarizeFile(file) {
  if (!file) return TELEMETRY_FILE_MISSING_SUMMARY;
  try { return renderSummary(await readFile(file, "utf8")); } catch (error) {
    if (error?.code === "ENOENT") return TELEMETRY_FILE_MISSING_SUMMARY;
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const inputIndex = process.argv.indexOf("--input");
  const input = inputIndex === -1 ? undefined : process.argv[inputIndex + 1];
  if (input === undefined) {
    console.error("usage: node tools/ci/summarize-source-fetch-telemetry.mjs --input <telemetry.jsonl>");
    process.exit(2);
  }
  process.stdout.write(await summarizeFile(input));
}
