#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  link, lstat, mkdtemp, readFile, realpath, rm, unlink, writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseArgs } from "./check-timetable-snapshot-freshness.mjs";
import { runKorailItxCompletenessCli } from "./collect-korail-itx-cheongchun-timetable.mjs";
import { normalizeDataGoKrServiceKey } from "./lib/provider-call-integrity.mjs";
import {
  createProviderResponseContinuation,
  createProviderResponseRecorder,
  parseProviderResponseCapture,
  providerResponseCaptureBytes,
} from "./provider-response-capture.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const KORAIL_SUFFIX_PATHS = new Set([
  "/B551457/run/v2/codes2",
  "/B551457/run/v2/travelerTrainRunPlan2",
  "/B551457/run/v2/travelerTrainRunInfo2",
]);

export async function runContinueCurrentItxCollectionCli({
  argv = process.argv.slice(2),
  env = process.env,
  now = new Date(),
  repositoryRoot = repoRoot,
  liveFetchImpl = fetch,
  runCompletenessImpl = runKorailItxCompletenessCli,
} = {}) {
  const args = await continuationArgs(argv);
  const serviceKey = normalizeDataGoKrServiceKey(env.DATA_GO_KR_SERVICE_KEY);
  const captureBytes = await readFile(args.capture);
  const baseCapture = parseProviderResponseCapture(captureBytes);
  if (baseCapture.contentSha256 !== args["expected-capture-content-sha256"]) {
    throw new Error("provider continuation base capture digest mismatch");
  }

  const stage = await mkdtemp(path.join(args.outputParent, ".itx-continuation-"));
  const stageIdentity = await lstat(stage);
  const staged = {
    output: path.join(stage, "itx-result.json"),
    completeness: path.join(stage, "itx-completeness.json"),
    suffix: path.join(stage, "provider-response-suffix-capture.json"),
    receipt: path.join(stage, "continuation-receipt.json"),
  };
  try {
    const suffixRecorder = createProviderResponseRecorder({
      fetchImpl: liveFetchImpl,
      observedAt: now.toISOString(),
      selectedServiceDates: baseCapture.selectedServiceDates,
    });
    const continuation = createProviderResponseContinuation({
      captureBytes,
      liveFetchImpl: suffixRecorder.fetchImpl,
      allowLiveRequest: ({ path: requestPath }) => KORAIL_SUFFIX_PATHS.has(requestPath),
    });
    const result = await runCompletenessImpl({
      argv: [
        "--output", staged.output,
        "--completeness-output", staged.completeness,
        "--station-catalog-pack", args["station-catalog-pack"],
        "--day8-date", baseCapture.selectedServiceDates["8"],
        "--day7-date", baseCapture.selectedServiceDates["7"],
        "--day9-date", baseCapture.selectedServiceDates["9"],
      ],
      env: {},
      providerServiceKey: serviceKey,
      now: new Date(baseCapture.observedAt),
      repositoryRoot,
      fetchImpl: continuation.fetchImpl,
    });
    continuation.assertExhausted();
    validateResult(result, baseCapture);

    const outputBytes = await readFile(staged.output);
    const completenessBytes = await readFile(staged.completeness);
    if (sha256(outputBytes) !== result.outputSha256
      || sha256(completenessBytes) !== result.completenessEvidenceSha256) {
      throw new Error("provider continuation result digest mismatch");
    }

    const suffixCapture = suffixRecorder.captureArtifact();
    if (suffixCapture.requestCount < 1) throw new Error("provider continuation suffix capture is empty");
    const suffixBytes = providerResponseCaptureBytes(suffixCapture);
    await writeFile(staged.suffix, suffixBytes, { flag: "wx", mode: 0o600 });

    const summary = continuation.summary();
    const receipt = {
      schemaVersion: 1,
      artifactKind: "itx-provider-capture-continuation",
      contractVersion: "itx-provider-capture-continuation-v1",
      baseCapture: {
        contentSha256: summary.baseContentSha256,
        requestCount: summary.baseRequestCount,
        replayedRequestCount: summary.replayedRequestCount,
      },
      suffixCapture: {
        contentSha256: suffixCapture.contentSha256,
        requestCount: suffixCapture.requestCount,
      },
      selectedServiceDates: baseCapture.selectedServiceDates,
      observedAt: baseCapture.observedAt,
      resumedAt: now.toISOString(),
      result: {
        status: "CANDIDATE_READY",
        outputSha256: result.outputSha256,
        completenessEvidenceSha256: result.completenessEvidenceSha256,
      },
      credentialRedacted: true,
    };
    await writeFile(staged.receipt, canonicalBytes(receipt), { flag: "wx", mode: 0o600 });
    await publishAll({
      parentBinding: args.parentBinding,
      publications: [
        [staged.completeness, args["completeness-output"]],
        [staged.suffix, args["suffix-capture-output"]],
        [staged.receipt, args["continuation-receipt-output"]],
        [staged.output, args.output],
      ],
    });
    return { ...result, continuationReceipt: receipt };
  } finally {
    await removeOwnedStage(stage, stageIdentity);
  }
}

async function continuationArgs(argv) {
  const parsed = parseArgs(argv);
  const expected = [
    "capture", "completeness-output", "continuation-receipt-output",
    "expected-capture-content-sha256", "output", "station-catalog-pack",
    "suffix-capture-output",
  ];
  const actual = Object.keys(parsed).sort(codepointCompare);
  if (JSON.stringify(actual) !== JSON.stringify(expected)
    || expected.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("provider continuation arguments are invalid");
  }
  const pathKeys = expected.filter((key) => key !== "expected-capture-content-sha256");
  const normalized = Object.fromEntries(pathKeys.map((key) => [key, path.resolve(parsed[key])]));
  if (pathKeys.some((key) => !path.isAbsolute(parsed[key]))
    || new Set(Object.values(normalized)).size !== pathKeys.length
    || !/^[0-9a-f]{64}$/.test(parsed["expected-capture-content-sha256"])) {
    throw new Error("provider continuation paths or digest are invalid");
  }
  const outputs = [
    normalized.output,
    normalized["completeness-output"],
    normalized["suffix-capture-output"],
    normalized["continuation-receipt-output"],
  ];
  const requestedOutputParent = path.dirname(outputs[0]);
  if (outputs.some((output) => path.dirname(output) !== requestedOutputParent)) {
    throw new Error("provider continuation outputs must share one parent");
  }
  const parentStat = await lstat(requestedOutputParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error("provider continuation output parent is invalid");
  }
  const outputParent = await realpath(requestedOutputParent);
  for (const key of ["output", "completeness-output", "suffix-capture-output", "continuation-receipt-output"]) {
    normalized[key] = path.join(outputParent, path.basename(normalized[key]));
  }
  for (const output of outputs) await assertAbsent(output);
  const captureStat = await lstat(normalized.capture);
  if (!captureStat.isFile() || captureStat.isSymbolicLink()) {
    throw new Error("provider continuation capture is invalid");
  }
  return {
    ...normalized,
    "expected-capture-content-sha256": parsed["expected-capture-content-sha256"],
    outputParent,
    parentBinding: { path: outputParent, dev: parentStat.dev, ino: parentStat.ino },
  };
}

function validateResult(result, capture) {
  if (result?.exitCode !== 0 || result?.candidate == null
    || result?.artifact?.validationMode !== "ADMISSION"
    || JSON.stringify(result.artifact.selectedServiceDates) !== JSON.stringify(capture.selectedServiceDates)
    || result.artifact.observedAt !== capture.observedAt
    || !/^[0-9a-f]{64}$/.test(result.outputSha256 ?? "")
    || !/^[0-9a-f]{64}$/.test(result.completenessEvidenceSha256 ?? "")) {
    throw new Error("provider continuation result is not admission-ready");
  }
}

async function publishAll({ parentBinding, publications }) {
  await assertParent(parentBinding);
  const linked = [];
  try {
    for (const [source, target] of publications) {
      await assertParent(parentBinding);
      const identity = await lstat(source);
      if (!identity.isFile() || identity.isSymbolicLink()) throw new Error("provider continuation staged output is invalid");
      await link(source, target);
      const published = await lstat(target);
      if (published.dev !== identity.dev || published.ino !== identity.ino) {
        throw new Error("provider continuation publication identity mismatch");
      }
      linked.push({ target, identity });
    }
  } catch (error) {
    for (const { target, identity } of linked.reverse()) {
      await removeOwnedFile(target, identity);
    }
    throw error;
  }
}

async function assertParent(binding) {
  const stat = await lstat(binding.path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== binding.dev || stat.ino !== binding.ino
    || await realpath(binding.path) !== binding.path) {
    throw new Error("provider continuation output parent was replaced");
  }
}

async function removeOwnedFile(target, identity) {
  try {
    const stat = await lstat(target);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.dev === identity.dev && stat.ino === identity.ino) {
      await unlink(target);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function removeOwnedStage(stage, identity) {
  try {
    const stat = await lstat(stage);
    if (stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === identity.dev && stat.ino === identity.ino) {
      await rm(stage, { recursive: true });
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function assertAbsent(target) {
  try {
    await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("provider continuation output must be absent");
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function codepointCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function main() {
  const result = await runContinueCurrentItxCollectionCli();
  console.log(
    `sanitized ITX continuation ready: status=CANDIDATE_READY,` +
    ` baseRequests=${result.continuationReceipt.baseCapture.requestCount},` +
    ` suffixRequests=${result.continuationReceipt.suffixCapture.requestCount},` +
    ` candidateSha256=${result.outputSha256}`,
  );
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "ITX continuation failed");
    process.exitCode = 1;
  });
}
