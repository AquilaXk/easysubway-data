#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseArgs } from "./check-timetable-snapshot-freshness.mjs";
import { runKorailItxCompletenessCli } from "./collect-korail-itx-cheongchun-timetable.mjs";
import { inspectItxCurrentCollectionEvidenceCli } from "./inspect-itx-current-collection-evidence.mjs";
import { createProviderResponseReplay } from "./provider-response-capture.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OFFLINE_PROVIDER_KEY = "offline-provider-replay-key";
const EXPECTED_SERVICE_DATES = Object.freeze({ "7": "20260822", "8": "20260813", "9": "20260816" });
const EXPECTED_AGGREGATE = Object.freeze({ expectedOdCount: 918, completedOdCount: 918, failedOdCount: 0 });

export async function materializeReplayedItxAdmissionCandidateCli({
  argv = process.argv.slice(2),
  repositoryRoot = repoRoot,
  runCompletenessImpl = runKorailItxCompletenessCli,
} = {}) {
  const args = candidateArgs(argv);
  const inspection = await inspectItxCurrentCollectionEvidenceCli({
    argv: ["--evidence", args["replay-evidence"]],
  });
  validateInspection(inspection);

  const captureBytes = await readFile(args.capture);
  const replay = createProviderResponseReplay({ captureBytes });
  if (JSON.stringify(replay.capture.selectedServiceDates) !== JSON.stringify(inspection.selectedServiceDates)) {
    throw new Error("replay evidence and capture service dates differ");
  }

  let exhaustionChecked = false;
  const result = await runCompletenessImpl({
    argv: [
      "--day8-date", EXPECTED_SERVICE_DATES["8"],
      "--day7-date", EXPECTED_SERVICE_DATES["7"],
      "--day9-date", EXPECTED_SERVICE_DATES["9"],
      "--station-catalog-pack", args["station-catalog-pack"],
      "--output", args["candidate-output"],
      "--completeness-output", args["completeness-output"],
    ],
    env: {},
    providerServiceKey: OFFLINE_PROVIDER_KEY,
    now: new Date(replay.capture.observedAt),
    repositoryRoot,
    fetchImpl: replay.fetchImpl,
    onPublicationEvent: async ({ event }) => {
      if (event === "before-stage-created") {
        replay.assertExhausted();
        exhaustionChecked = true;
      }
    },
  });
  replay.assertExhausted();
  if (!exhaustionChecked) throw new Error("candidate publication did not verify capture exhaustion");
  validateResult(result);
  return result;
}

function candidateArgs(argv) {
  const args = parseArgs(argv);
  const expected = [
    "candidate-output", "capture", "completeness-output", "replay-evidence", "station-catalog-pack",
  ];
  if (JSON.stringify(Object.keys(args).sort(codepointCompare)) !== JSON.stringify(expected)
    || expected.some((name) => typeof args[name] !== "string" || !path.isAbsolute(args[name]))) {
    throw new Error("replay admission candidate requires exactly five absolute paths");
  }
  const normalized = Object.fromEntries(expected.map((name) => [name, path.resolve(args[name])]));
  if (new Set(Object.values(normalized)).size !== expected.length) {
    throw new Error("replay admission candidate paths must differ");
  }
  return normalized;
}

function validateInspection(value) {
  if (value?.schemaVersion !== 1
    || value.artifactKind !== "itx-current-collection-evidence-inspection"
    || JSON.stringify(value.selectedServiceDates) !== JSON.stringify(EXPECTED_SERVICE_DATES)
    || value.validationStatus !== "SUPPORTED"
    || value.admissionStatus !== "REPLAY_ONLY"
    || value.serviceDayCount !== 3
    || JSON.stringify(value.aggregate) !== JSON.stringify(EXPECTED_AGGREGATE)
    || !Array.isArray(value.failures) || value.failures.length !== 0) {
    throw new Error("successful replay evidence identity is invalid");
  }
}

function validateResult(result) {
  if (result?.exitCode !== 0
    || result.candidate?.validationStatus !== "SUPPORTED"
    || result.artifact?.validationMode !== "ADMISSION"
    || result.artifact.validationStatus !== "SUPPORTED"
    || result.artifact.materialization?.status !== "SUPPORTED"
    || JSON.stringify(result.artifact.selectedServiceDates) !== JSON.stringify(EXPECTED_SERVICE_DATES)
    || !/^[a-f0-9]{64}$/.test(result.outputSha256 ?? "")
    || !/^[a-f0-9]{64}$/.test(result.completenessEvidenceSha256 ?? "")) {
    throw new Error("replayed admission candidate result is invalid");
  }
}

function codepointCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await materializeReplayedItxAdmissionCandidateCli();
    process.stdout.write(`replayed ITX admission candidate ready: candidateSha256=${result.outputSha256}, completenessSha256=${result.completenessEvidenceSha256}\n`);
  } catch (error) {
    process.stderr.write(`replayed ITX admission candidate failed: ${error instanceof Error ? error.message : "UNKNOWN"}\n`);
    process.exitCode = 1;
  }
}
