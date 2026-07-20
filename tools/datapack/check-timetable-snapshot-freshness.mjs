#!/usr/bin/env node
// 서버 timetable snapshot의 freshUntil 잔여 유효기간을 계산해 상태/심각도를 산출하고,
// Prometheus exposition 형식 메트릭과 evidence JSON을 남긴다. 자동 갱신 워크플로가
// 이 산출물로 T-24h/T-6h 경보를 발화하고, 재수집 실행 여부(shouldRefresh)를 판정한다.
//
// 실행: node tools/datapack/check-timetable-snapshot-freshness.mjs \
//   [--evidence <server-timetable-snapshot-evidence.json>] \
//   [--output <evidence.json>] [--metrics-output <metrics.prom>] \
//   [--warn-seconds N] [--critical-seconds N] [--refresh-lead-seconds N] \
//   [--github-output <path>] [--fail-on-critical]
import { readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DAY_SECONDS = 86_400;
export const DEFAULT_WARN_SECONDS = 24 * 3600; // T-24h
export const DEFAULT_CRITICAL_SECONDS = 6 * 3600; // T-6h
export const DEFAULT_REFRESH_LEAD_SECONDS = 3 * DAY_SECONDS; // T-72h
const DEFAULT_EVIDENCE_PATH = "tools/datapack/server-timetable-snapshot-evidence.json";
const METRIC_NS = "easysubway_timetable_snapshot";

export function classifySnapshotFreshness({
  freshUntil,
  now,
  warnSeconds = DEFAULT_WARN_SECONDS,
  criticalSeconds = DEFAULT_CRITICAL_SECONDS,
  refreshLeadSeconds = DEFAULT_REFRESH_LEAD_SECONDS,
}) {
  const freshUntilMs = Date.parse(freshUntil);
  if (!Number.isFinite(freshUntilMs)) {
    throw new Error(`invalid freshUntil timestamp: ${String(freshUntil)}`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("now must be a valid Date");
  }
  if (!(warnSeconds >= criticalSeconds)) {
    throw new Error("warn-seconds must be greater than or equal to critical-seconds");
  }
  const remainingSeconds = Math.floor((freshUntilMs - now.getTime()) / 1000);
  const expired = remainingSeconds <= 0;
  let status = "OK";
  let severity = "none";
  if (expired || remainingSeconds <= criticalSeconds) {
    status = "FIRING";
    severity = "critical";
  } else if (remainingSeconds <= warnSeconds) {
    status = "FIRING";
    severity = "warning";
  }
  return {
    freshUntil,
    freshUntilEpochSeconds: Math.floor(freshUntilMs / 1000),
    evaluatedAt: now.toISOString(),
    evaluatedAtEpochSeconds: Math.floor(now.getTime() / 1000),
    remainingSeconds,
    expired,
    status,
    severity,
    shouldRefresh: remainingSeconds <= refreshLeadSeconds,
    thresholds: { warnSeconds, criticalSeconds, refreshLeadSeconds },
  };
}

export function renderPrometheusMetrics(result) {
  return [
    `# HELP ${METRIC_NS}_fresh_until_timestamp_seconds Server timetable snapshot freshUntil deadline as a Unix timestamp.`,
    `# TYPE ${METRIC_NS}_fresh_until_timestamp_seconds gauge`,
    `${METRIC_NS}_fresh_until_timestamp_seconds ${result.freshUntilEpochSeconds}`,
    `# HELP ${METRIC_NS}_remaining_seconds Seconds remaining until the server timetable snapshot expires (negative once expired).`,
    `# TYPE ${METRIC_NS}_remaining_seconds gauge`,
    `${METRIC_NS}_remaining_seconds ${result.remainingSeconds}`,
    `# HELP ${METRIC_NS}_expired Whether the server timetable snapshot is already expired (1) or still valid (0).`,
    `# TYPE ${METRIC_NS}_expired gauge`,
    `${METRIC_NS}_expired ${result.expired ? 1 : 0}`,
    "",
  ].join("\n");
}

function kstCalendarParts(now) {
  const shifted = new Date(now.getTime() + 9 * 3600 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
}

// KRIC 운행일 코드(8=평일, 7=토요일, 9=일요일)별로 오늘부터 +6일(Asia/Seoul) 범위에서
// 조건을 만족하는 가장 이른 날짜를 고른다. 7일 창에는 세 유형이 모두 존재한다.
export function computeItxAdmissionServiceDates(now) {
  const { year, month, day } = kstCalendarParts(now);
  const base = Date.UTC(year, month, day);
  const dates = {};
  const matchers = {
    "8": (weekday) => weekday >= 1 && weekday <= 5,
    "7": (weekday) => weekday === 6,
    "9": (weekday) => weekday === 0,
  };
  for (const [dayCd, matches] of Object.entries(matchers)) {
    for (let offset = 0; offset <= 6; offset += 1) {
      const candidate = new Date(base + offset * DAY_SECONDS * 1000);
      if (matches(candidate.getUTCDay())) {
        const yyyy = candidate.getUTCFullYear();
        const mm = String(candidate.getUTCMonth() + 1).padStart(2, "0");
        const dd = String(candidate.getUTCDate()).padStart(2, "0");
        dates[dayCd] = `${yyyy}-${mm}-${dd}`;
        break;
      }
    }
    if (!dates[dayCd]) {
      throw new Error(`no admission date within window for dayCd ${dayCd}`);
    }
  }
  return dates;
}

// "--"로 시작하되 실제 플래그 이름 형태(문자 시작, 이어서 단어문자·하이픈만)가 아닌 값은
// 플래그가 아니라 값으로 취급한다(예: 값이 우연히 "--"로 시작하는 파일명인 경우).
function looksLikeFlag(token) {
  return typeof token === "string" && /^--[a-zA-Z][\w-]*$/.test(token);
}

export function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]?.replace(/^--/, "");
    const next = argv[index + 1];
    if (next === undefined || looksLikeFlag(next)) result[key] = true;
    else result[key] = argv[index += 1];
  }
  return result;
}

function positiveSeconds(value, fallback, label) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

export async function runCheckTimetableSnapshotFreshnessCli({
  argv = process.argv.slice(2),
  now = new Date(),
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv);
  const evidencePath = path.resolve(cwd, typeof args.evidence === "string" ? args.evidence : DEFAULT_EVIDENCE_PATH);
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  const freshUntil = evidence.freshUntil;
  if (typeof freshUntil !== "string") {
    throw new Error(`snapshot evidence at ${evidencePath} is missing freshUntil`);
  }
  const warnSeconds = positiveSeconds(args["warn-seconds"], DEFAULT_WARN_SECONDS, "--warn-seconds");
  const criticalSeconds = positiveSeconds(args["critical-seconds"], DEFAULT_CRITICAL_SECONDS, "--critical-seconds");
  const refreshLeadSeconds = positiveSeconds(
    args["refresh-lead-seconds"],
    DEFAULT_REFRESH_LEAD_SECONDS,
    "--refresh-lead-seconds",
  );
  const result = classifySnapshotFreshness({ freshUntil, now, warnSeconds, criticalSeconds, refreshLeadSeconds });
  const serviceDates = computeItxAdmissionServiceDates(now);
  const output = { schemaVersion: 1, artifactKind: "timetable-snapshot-freshness-alert", ...result, serviceDates };

  if (typeof args.output === "string") {
    await writeFile(path.resolve(cwd, args.output), `${JSON.stringify(output, null, 2)}\n`, { mode: 0o644 });
  }
  if (typeof args["metrics-output"] === "string") {
    await writeFile(path.resolve(cwd, args["metrics-output"]), renderPrometheusMetrics(result), { mode: 0o644 });
  }
  if (typeof args["github-output"] === "string") {
    await appendFile(
      path.resolve(cwd, args["github-output"]),
      [
        `status=${result.status}`,
        `severity=${result.severity}`,
        `remaining_seconds=${result.remainingSeconds}`,
        `expired=${result.expired}`,
        `should_refresh=${result.shouldRefresh}`,
        `fresh_until=${result.freshUntil}`,
        `day8_date=${serviceDates["8"]}`,
        `day7_date=${serviceDates["7"]}`,
        `day9_date=${serviceDates["9"]}`,
        "",
      ].join("\n"),
    );
  }
  console.log(
    `timetable snapshot freshness: status=${result.status} severity=${result.severity} ` +
    `remainingSeconds=${result.remainingSeconds} expired=${result.expired} ` +
    `shouldRefresh=${result.shouldRefresh} freshUntil=${result.freshUntil}`,
  );
  const failOnCritical = args["fail-on-critical"] === true;
  return { result, serviceDates, exitCode: failOnCritical && result.severity === "critical" ? 1 : 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCheckTimetableSnapshotFreshnessCli()
    .then(({ exitCode }) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
