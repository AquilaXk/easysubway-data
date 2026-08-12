#!/usr/bin/env node
import { lstat, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseArgs } from "./check-timetable-snapshot-freshness.mjs";
import {
  collectKorailItxCheongchunCompleteness,
  collectKorailItxCheongchunPlan,
  runKorailItxCompletenessCli,
} from "./collect-korail-itx-cheongchun-timetable.mjs";
import { createProviderResponseReplay } from "./provider-response-capture.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OFFLINE_PROVIDER_KEY = "offline-provider-replay-key";

export async function runReplayCurrentItxCollectionCli({
  argv = process.argv.slice(2),
  repositoryRoot = repoRoot,
  runCompletenessImpl = runKorailItxCompletenessCli,
} = {}) {
  const args = replayArgs(argv);
  await assertOutputAbsent(args.output);
  const captureBytes = await readFile(args.capture);
  const replay = createProviderResponseReplay({ captureBytes });
  const serviceDates = replay.capture.selectedServiceDates;
  let result;
  try {
    result = await runCompletenessImpl({
      argv: [
        "--replay",
        "--day8-date", serviceDates["8"],
        "--day7-date", serviceDates["7"],
        "--day9-date", serviceDates["9"],
        "--station-catalog-pack", args["station-catalog-pack"],
        "--output", args.output,
      ],
      env: { DATA_GO_KR_SERVICE_KEY: OFFLINE_PROVIDER_KEY },
      now: new Date(replay.capture.observedAt),
      repositoryRoot,
      fetchImpl: replay.fetchImpl,
      collectImpl: (options) => collectKorailItxCheongchunCompleteness({
        ...options,
        collectTimetableImpl: collectKorailItxCheongchunPlan,
      }),
    });
    replay.assertExhausted();
    if (result?.candidate !== null || result?.artifact?.validationMode !== "REPLAY"
      || JSON.stringify(result.artifact.selectedServiceDates) !== JSON.stringify(serviceDates)) {
      throw new Error("provider replay result identity is invalid");
    }
    const outputStat = await lstat(args.output);
    if (!outputStat.isFile() || outputStat.isSymbolicLink()) throw new Error("provider replay output is invalid");
    return result;
  } catch (error) {
    await unlink(args.output).catch((cleanupError) => {
      if (cleanupError?.code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
}

function replayArgs(argv) {
  const args = parseArgs(argv);
  const expected = ["capture", "output", "station-catalog-pack"];
  const actual = Object.keys(args).sort(codepointCompare);
  if (JSON.stringify(actual) !== JSON.stringify(expected)
    || expected.some((name) => typeof args[name] !== "string" || !path.isAbsolute(args[name]))) {
    throw new Error("provider replay requires exactly absolute --capture, --output, and --station-catalog-pack");
  }
  const normalized = Object.fromEntries(expected.map((name) => [name, path.resolve(args[name])]));
  if (new Set(Object.values(normalized)).size !== expected.length) {
    throw new Error("provider replay paths must differ");
  }
  return normalized;
}

async function assertOutputAbsent(output) {
  try {
    await lstat(output);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("provider replay output must be absent");
}

function codepointCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await runReplayCurrentItxCollectionCli();
    console.log(`offline provider replay complete: validation=${result.artifact.validationStatus}, requests=consumed`);
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
