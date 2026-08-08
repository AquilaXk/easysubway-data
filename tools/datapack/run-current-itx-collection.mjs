#!/usr/bin/env node
import { lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { computeItxAdmissionServiceDates, parseArgs } from "./check-timetable-snapshot-freshness.mjs";
import { runKorailItxCompletenessCli } from "./collect-korail-itx-cheongchun-timetable.mjs";

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

export async function runCurrentItxCollectionCli({
  argv = process.argv.slice(2),
  env = process.env,
  now = new Date(),
  repositoryRoot,
  computeServiceDates = computeItxAdmissionServiceDates,
  collectImpl = runKorailItxCompletenessCli,
} = {}) {
  const args = currentCollectionArgs(argv);
  await assertAbsent([args.output, args["completeness-output"], args["freshness-output"]]);
  const serviceDates = computeServiceDates(now);
  const freshnessEvidence = {
    schemaVersion: 1,
    artifactKind: "itx-admission-service-dates",
    timezone: "Asia/Seoul",
    serviceDates,
  };
  await writeFile(args["freshness-output"], `${JSON.stringify(freshnessEvidence, null, 2)}\n`, { flag: "wx", mode: 0o644 });
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { exitCode } = await runCurrentItxCollectionCli();
    process.exitCode = exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
