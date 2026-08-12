#!/usr/bin/env node
import { link, lstat, mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseArgs } from "./check-timetable-snapshot-freshness.mjs";
import { runKorailItxCompletenessCli } from "./collect-korail-itx-cheongchun-timetable.mjs";
import {
  createProviderResponseContinuation,
  providerResponseCaptureBytes,
} from "./provider-response-capture.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIVE_REQUEST_MINIMUM = 1;
const LIVE_REQUEST_MAXIMUM = 18;
const KORAIL_PATHS = new Set([
  "/B551457/run/v2/travelerTrainRunPlan2",
  "/B551457/run/v2/travelerTrainRunInfo2",
]);

export async function runContinueCurrentItxCollectionCli({
  argv = process.argv.slice(2),
  env = process.env,
  now = new Date(),
  repositoryRoot = repoRoot,
  providerFetchImpl = fetch,
  runCompletenessImpl = runKorailItxCompletenessCli,
} = {}) {
  const args = continuationArgs(argv);
  await assertOutputsAbsent([args.output, args["completeness-output"], args["extended-capture-output"]]);
  const captureBytes = await readFile(args.capture);
  let serviceDates;
  const continuation = createProviderResponseContinuation({
    captureBytes,
    observedAt: requiredNow(now).toISOString(),
    fetchImpl: providerFetchImpl,
    maxLiveRequests: LIVE_REQUEST_MAXIMUM,
    allowLiveRequest(identity) {
      return isAllowedKorailRequest(identity, serviceDates);
    },
  });
  serviceDates = Object.freeze({ ...continuation.selectedServiceDates });

  const stage = await mkdtemp(path.join(path.dirname(args.output), ".provider-continuation-"));
  const stageIdentity = await lstat(stage);
  const stagedOutput = path.join(stage, "result.json");
  const stagedCompleteness = path.join(stage, "completeness.json");
  const stagedCapture = path.join(stage, "extended-capture.json");
  const published = [];
  try {
    const result = await runCompletenessImpl({
      argv: [
        "--output", stagedOutput,
        "--completeness-output", stagedCompleteness,
        "--station-catalog-pack", args["station-catalog-pack"],
        "--day8-date", serviceDates["8"],
        "--day7-date", serviceDates["7"],
        "--day9-date", serviceDates["9"],
      ],
      env,
      now,
      repositoryRoot,
      fetchImpl: continuation.fetchImpl,
    });
    const extendedCapture = continuation.captureArtifact();
    if (continuation.liveRequestCount < LIVE_REQUEST_MINIMUM
      || continuation.liveRequestCount > LIVE_REQUEST_MAXIMUM) {
      throw new Error("provider continuation live request count is invalid");
    }
    if (result?.artifact?.validationMode !== "ADMISSION"
      || !sameServiceDates(result.artifact.selectedServiceDates, serviceDates)) {
      throw new Error("provider continuation result identity is invalid");
    }
    await assertRegularFile(stagedOutput, "provider continuation result");
    if (result.candidate === null) {
      await assertAbsent(stagedCompleteness, "provider continuation completeness");
    } else {
      await assertRegularFile(stagedCompleteness, "provider continuation completeness");
    }
    const extendedBytes = providerResponseCaptureBytes(extendedCapture);
    await writeFile(stagedCapture, extendedBytes, { flag: "wx", mode: 0o600 });

    await publish(stagedOutput, args.output, published);
    if (result.candidate !== null) {
      await publish(stagedCompleteness, args["completeness-output"], published);
    }
    await publish(stagedCapture, args["extended-capture-output"], published);
    return {
      ...result,
      continuation: {
        baseContentSha256: continuation.baseContentSha256,
        baseRequestCount: continuation.baseRequestCount,
        liveRequestCount: continuation.liveRequestCount,
        extendedContentSha256: extendedCapture.contentSha256,
      },
    };
  } catch (error) {
    for (const publication of published.reverse()) await removeOwnedPublication(publication).catch(() => {});
    throw error;
  } finally {
    await removeOwnedStage(stage, stageIdentity, [stagedOutput, stagedCompleteness, stagedCapture]).catch(() => {});
  }
}

function isAllowedKorailRequest(identity, serviceDates) {
  if (!serviceDates || !KORAIL_PATHS.has(identity.path) || identity.query.length !== 5) return false;
  const query = new Map(identity.query);
  if (query.size !== identity.query.length || query.get("numOfRows") !== "1000"
    || query.get("returnType") !== "JSON" || !/^\d+$/.test(query.get("pageNo") ?? "")
    || Number(query.get("pageNo")) < 1) return false;
  const lower = query.get("cond[run_ymd::GTE]");
  const upper = query.get("cond[run_ymd::LTE]");
  return lower === upper && Object.values(serviceDates).includes(lower);
}

function continuationArgs(argv) {
  const args = parseArgs(argv);
  const expected = ["capture", "completeness-output", "extended-capture-output", "output", "station-catalog-pack"];
  const actual = Object.keys(args).sort(codepointCompare);
  if (JSON.stringify(actual) !== JSON.stringify(expected)
    || expected.some((name) => typeof args[name] !== "string" || !path.isAbsolute(args[name]))) {
    throw new Error("provider continuation requires exactly five absolute paths");
  }
  const normalized = Object.fromEntries(expected.map((name) => [name, path.resolve(args[name])]));
  if (new Set(Object.values(normalized)).size !== expected.length) {
    throw new Error("provider continuation paths must differ");
  }
  const outputParent = path.dirname(normalized.output);
  if ([normalized["completeness-output"], normalized["extended-capture-output"]]
    .some((target) => path.dirname(target) !== outputParent)) {
    throw new Error("provider continuation publication outputs must share one parent");
  }
  return normalized;
}

async function assertOutputsAbsent(targets) {
  for (const target of targets) await assertAbsent(target, "provider continuation output");
}

async function assertAbsent(target, label) {
  try {
    await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} must be absent`);
}

async function assertRegularFile(target, label) {
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is invalid`);
}

async function publish(source, target, published) {
  await link(source, target);
  published.push({ target, identity: await lstat(source) });
}

async function removeOwnedPublication({ target, identity }) {
  try {
    const current = await lstat(target);
    if (current.dev === identity.dev && current.ino === identity.ino) await unlink(target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function removeOwnedStage(stage, identity, files) {
  try {
    const current = await lstat(stage);
    if (!current.isDirectory() || current.isSymbolicLink()
      || current.dev !== identity.dev || current.ino !== identity.ino) return;
    for (const file of files) {
      await unlink(file).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
    await rmdir(stage);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function requiredNow(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("now must be a valid Date");
  return now;
}

function sameServiceDates(left, right) {
  return left?.["7"] === right["7"] && left?.["8"] === right["8"] && left?.["9"] === right["9"];
}

function codepointCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await runContinueCurrentItxCollectionCli();
    console.log(`provider continuation complete: validation=${result.artifact.validationStatus}, liveRequests=${result.continuation.liveRequestCount}`);
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
