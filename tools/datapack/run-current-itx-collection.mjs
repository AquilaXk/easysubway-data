#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseArgs } from "./check-timetable-snapshot-freshness.mjs";
import { ITX_ADMISSION_LOOKAHEAD_DAYS } from "./collect-tago-itx-cheongchun-od.mjs";
import { runKorailItxCompletenessCli } from "./collect-korail-itx-cheongchun-timetable.mjs";
import { fetchKasiPublicHolidayCalendar } from "./fetch-kasi-public-holiday-calendar.mjs";
import { normalizeDataGoKrServiceKey } from "./lib/provider-call-integrity.mjs";

function currentCollectionArgs(argv) {
  const args = parseArgs(argv);
  const expected = ["completeness-output", "freshness-output", "output", "station-catalog-pack"];
  const actual = Object.keys(args).sort((left, right) => left.localeCompare(right));
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
    || expected.some((key) => typeof args[key] !== "string" || args[key].length === 0)) {
    throw new Error("current ITX collection requires exactly --output, --completeness-output, --station-catalog-pack, and --freshness-output");
  }
  const outputPaths = [args.output, args["completeness-output"], args["freshness-output"]];
  const stationCatalogPack = args["station-catalog-pack"];
  if (outputPaths.some((value) => !path.isAbsolute(value)) || !path.isAbsolute(stationCatalogPack)) {
    throw new Error("current ITX collection paths must be absolute");
  }
  const resolvedOutputs = outputPaths.map((value) => path.resolve(value));
  const parent = path.dirname(resolvedOutputs[0]);
  if (new Set(resolvedOutputs).size !== resolvedOutputs.length) {
    throw new Error("current ITX collection output paths must differ");
  }
  if (resolvedOutputs.some((value) => path.dirname(value) !== parent)) {
    throw new Error("current ITX collection output paths must share one parent");
  }
  const resolvedStationCatalogPack = path.resolve(stationCatalogPack);
  if (path.dirname(resolvedStationCatalogPack) !== parent || resolvedStationCatalogPack === parent) {
    throw new Error("station catalog pack must be a separate child of the output parent");
  }
  return {
    ...args,
    output: resolvedOutputs[0],
    "completeness-output": resolvedOutputs[1],
    "freshness-output": resolvedOutputs[2],
    "station-catalog-pack": resolvedStationCatalogPack,
  };
}

async function assertAbsent(paths) {
  for (const target of paths) {
    try {
      await lstat(target);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    throw new Error("current ITX collection output paths must be absent");
  }
}

async function bindOutputParent(output) {
  const parent = path.dirname(output);
  try {
    const stat = await lstat(parent);
    const real = await realpath(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    return { parent: real, identity: stat };
  } catch {
    throw new Error("current ITX collection output parent must be an existing non-symlink directory");
  }
}

async function assertBoundOutputParent(binding) {
  try {
    const stat = await lstat(binding.parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== binding.identity.dev || stat.ino !== binding.identity.ino
      || await realpath(binding.parent) !== binding.parent) throw new Error();
  } catch {
    throw new Error("current ITX collection output parent was replaced");
  }
}

async function openBoundOutputParent(binding) {
  if (!Number.isInteger(constants.O_DIRECTORY) || !Number.isInteger(constants.O_NOFOLLOW)) {
    throw new Error("current ITX collection secure output is unsupported");
  }
  let handle;
  try {
    handle = await open(binding.parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isDirectory() || stat.dev !== binding.identity.dev || stat.ino !== binding.identity.ino) throw new Error();
    return { handle };
  } catch {
    await handle?.close();
    throw new Error("current ITX collection output parent was replaced");
  }
}

function kstWindow(now) {
  const shifted = new Date(now.getTime() + 9 * 3_600_000);
  const base = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return Array.from({ length: ITX_ADMISSION_LOOKAHEAD_DAYS }, (_, offset) => {
    const candidate = new Date(base + offset * 86_400_000);
    return {
      date: `${candidate.getUTCFullYear()}${String(candidate.getUTCMonth() + 1).padStart(2, "0")}${String(candidate.getUTCDate()).padStart(2, "0")}`,
      weekday: candidate.getUTCDay(),
      month: candidate.getUTCMonth() + 1,
      year: candidate.getUTCFullYear(),
    };
  });
}

function holidayAwareServiceDates(window, holidays) {
  const day8 = window.find(({ date, weekday }) => weekday >= 1 && weekday <= 5 && !holidays.has(date));
  const day7 = window.find(({ date, weekday }) => weekday === 6 && !holidays.has(date));
  const day9 = window.find(({ weekday }) => weekday === 0);
  if (!day8 || !day7 || !day9) throw new Error("no holiday-aware ITX admission date within window");
  return { "8": day8.date, "7": day7.date, "9": day9.date };
}

async function defaultPublicHolidays({ now, env, fetchHolidayCalendar }) {
  const requested = new Map();
  for (const { year, month } of kstWindow(now)) {
    if (!requested.has(year)) requested.set(year, new Set());
    requested.get(year).add(month);
  }
  const holidays = new Set();
  for (const [year, months] of requested) {
    const serviceKey = normalizeDataGoKrServiceKey(env.DATA_GO_KR_SERVICE_KEY);
    const result = await fetchHolidayCalendar({ serviceKey, year, months });
    for (const date of result) holidays.add(date);
  }
  return holidays;
}

export async function runCurrentItxCollectionCli({
  argv = process.argv.slice(2),
  env = process.env,
  now = new Date(),
  repositoryRoot,
  fetchPublicHolidays,
  fetchHolidayCalendar = fetchKasiPublicHolidayCalendar,
  beforeFreshnessWrite = async () => {},
  beforeFailureReceiptWrite = async () => {},
  collectImpl = runKorailItxCompletenessCli,
} = {}) {
  const args = currentCollectionArgs(argv);
  normalizeDataGoKrServiceKey(env.DATA_GO_KR_SERVICE_KEY);
  await assertAbsent([args.output, args["completeness-output"], args["freshness-output"]]);
  const outputParent = await bindOutputParent(args.output);
  const receiptParent = await openBoundOutputParent(outputParent);
  let holidayDates;
  try {
    holidayDates = await (fetchPublicHolidays ?? defaultPublicHolidays)({ now, env, fetchHolidayCalendar });
  } catch (error) {
    try {
      await beforeFailureReceiptWrite();
      await writeKasiFailureReceipt(receiptParent, args["freshness-output"], error);
    } finally {
      await receiptParent.handle.close();
    }
    throw error;
  }
  await receiptParent.handle.close();
  if (!(holidayDates instanceof Set) || [...holidayDates].some((date) => typeof date !== "string" || !/^\d{8}$/.test(date))) {
    throw new Error("KASI public holiday calendar is invalid");
  }
  const serviceDates = holidayAwareServiceDates(kstWindow(now), holidayDates);
  const freshnessEvidence = {
    schemaVersion: 1,
    artifactKind: "itx-admission-service-dates",
    timezone: "Asia/Seoul",
    serviceDates,
  };
  await beforeFreshnessWrite();
  await assertBoundOutputParent(outputParent);
  await writeFile(path.join(outputParent.parent, path.basename(args["freshness-output"])), `${JSON.stringify(freshnessEvidence, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  const result = await collectImpl({
    argv: [
      "--output", args.output,
      "--completeness-output", args["completeness-output"],
      "--station-catalog-pack", args["station-catalog-pack"],
      "--day8-date", serviceDates["8"],
      "--day7-date", serviceDates["7"],
      "--day9-date", serviceDates["9"],
    ],
    env,
    now,
    repositoryRoot,
  });
  return { ...result, freshnessEvidence, serviceDates };
}

async function writeKasiFailureReceipt(receiptParent, freshnessOutput, error) {
  const receipt = {
    schemaVersion: 1,
    artifactKind: "itx-current-collection-preflight",
    status: "FAILED",
    operation: "KASI_PUBLIC_HOLIDAY_CALENDAR",
    failureCategory: safeFailureCategory(error?.failureCategory),
    attemptCount: safeAttemptCount(error?.attemptCount),
  };
  await writeBoundOutput(receiptParent.handle.fd, path.basename(freshnessOutput), `${JSON.stringify(receipt, null, 2)}\n`);
}

async function writeBoundOutput(parentFd, basename, contents) {
  const helperDirectory = path.dirname(fileURLToPath(import.meta.url));
  await new Promise((resolve, reject) => {
    const failure = () => reject(new Error("current ITX collection secure output write failed"));
    const child = spawn("/usr/bin/python3", ["write-bound-output.py", basename], {
      cwd: helperDirectory,
      shell: false,
      stdio: ["pipe", "ignore", "ignore", parentFd],
    });
    child.once("error", failure);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else failure();
    });
    child.stdin.once("error", failure);
    child.stdin.end(contents);
  });
}

function safeFailureCategory(value) {
  const categories = new Set([
    "NETWORK_DNS",
    "NETWORK_TLS",
    "NETWORK_CONNECT_TIMEOUT",
    "NETWORK_REQUEST_TIMEOUT",
    "NETWORK_SOCKET",
    "NETWORK_UNKNOWN",
    "KASI_HTTP",
    "KASI_SCHEMA",
  ]);
  return categories.has(value) ? value : "KASI_FAILURE";
}

function safeAttemptCount(value) {
  return value === 1 || value === 2 ? value : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { exitCode } = await runCurrentItxCollectionCli();
    process.exitCode = exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
