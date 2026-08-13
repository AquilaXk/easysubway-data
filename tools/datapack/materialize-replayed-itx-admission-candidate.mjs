#!/usr/bin/env node
import { createHash } from "node:crypto";
import { link, lstat, mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseArgs } from "./check-timetable-snapshot-freshness.mjs";
import {
  collectKorailItxCheongchunCompleteness,
  runKorailItxCompletenessCli,
} from "./collect-korail-itx-cheongchun-timetable.mjs";
import { inspectItxCurrentCollectionEvidenceCli } from "./inspect-itx-current-collection-evidence.mjs";
import { createProviderResponseReplay } from "./provider-response-capture.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OFFLINE_PROVIDER_KEY = "offline-provider-replay-key";
const EXPECTED_SERVICE_DATES = Object.freeze({ "7": "20260822", "8": "20260813", "9": "20260816" });
const EXPECTED_AGGREGATE = Object.freeze({ expectedOdCount: 918, completedOdCount: 918, failedOdCount: 0 });
const EXPECTED_CAPTURE_BYTES_SHA256 = "3dc2b1f68dc32e8a47cb442483a04762103d6cf55d97db96f35017a6f4b2ee94";
const EXPECTED_REPLAY_EVIDENCE_BYTES_SHA256 = "68440e73376ee9825ff7f2d4898ffee4399676616a7773e0f5f7fd066cba10be";
const EXPECTED_CAPTURE_CONTENT_SHA256 = "99e8272ecf344a14e9723651279bd3f5e3cf9db382edbc3dad571a1f9c0bc6fd";
const EXPECTED_REPLAY_EVIDENCE_HASH = "9fd4131cda3776003f3031a1ab252a5e655fb0d9da9aeec61060d4cbc704abe4";
const CAPTURE_PROVENANCE = Object.freeze({
  workflowRunId: "31620004435",
  artifactId: "9150832350",
  archiveSha256: "e1203894526b794fbf927b3e7c5da4e33507cbe26b12328ffc45c9da5b3085d5",
});
const REPLAY_PROVENANCE = Object.freeze({
  workflowRunId: "31679427374",
  artifactId: "9172854009",
  archiveSha256: "2bb09e208691896f27d372cdd7345e326e4f76a706c201ec3d48ed2fa0990247",
});

export async function materializeReplayedItxAdmissionCandidateCli({
  argv = process.argv.slice(2),
  repositoryRoot = repoRoot,
  runCompletenessImpl = runKorailItxCompletenessCli,
  collectCompletenessImpl = collectKorailItxCheongchunCompleteness,
  expectedCaptureBytesSha256 = EXPECTED_CAPTURE_BYTES_SHA256,
  expectedReplayEvidenceBytesSha256 = EXPECTED_REPLAY_EVIDENCE_BYTES_SHA256,
  expectedCaptureContentSha256 = EXPECTED_CAPTURE_CONTENT_SHA256,
  expectedReplayEvidenceHash = EXPECTED_REPLAY_EVIDENCE_HASH,
} = {}) {
  const args = candidateArgs(argv);
  const replayEvidenceBytes = await readFile(args["replay-evidence"]);
  if (sha256(replayEvidenceBytes) !== expectedReplayEvidenceBytesSha256) {
    throw new Error("retained replay evidence bytes differ");
  }
  const replayEvidence = parseReplayEvidence(replayEvidenceBytes);
  if (replayEvidence.evidenceHash !== expectedReplayEvidenceHash) {
    throw new Error("retained replay evidence identity differs");
  }
  const inspection = await inspectItxCurrentCollectionEvidenceCli({
    argv: ["--evidence", args["replay-evidence"]],
  });
  validateInspection(inspection);

  const captureBytes = await readFile(args.capture);
  if (sha256(captureBytes) !== expectedCaptureBytesSha256) {
    throw new Error("retained capture bytes differ");
  }
  const replay = createProviderResponseReplay({ captureBytes });
  if (replay.capture.contentSha256 !== expectedCaptureContentSha256) {
    throw new Error("retained capture content identity differs");
  }
  if (JSON.stringify(replay.capture.selectedServiceDates) !== JSON.stringify(inspection.selectedServiceDates)) {
    throw new Error("replay evidence and capture service dates differ");
  }

  const outputParent = path.dirname(args["candidate-output"]);
  if (path.dirname(args["completeness-output"]) !== outputParent) {
    throw new Error("candidate and completeness output parents must match");
  }
  const stage = await mkdtemp(path.join(outputParent, ".itx-replay-admission-"));
  const stagedCandidate = path.join(stage, "candidate.json");
  const stagedCompleteness = path.join(stage, "completeness.json");
  try {
    let exhaustionChecked = false;
    let deferredCollectionFailure = null;
    const result = await runCompletenessImpl({
      argv: [
        "--day8-date", EXPECTED_SERVICE_DATES["8"],
        "--day7-date", EXPECTED_SERVICE_DATES["7"],
        "--day9-date", EXPECTED_SERVICE_DATES["9"],
        "--station-catalog-pack", args["station-catalog-pack"],
        "--output", stagedCandidate,
        "--completeness-output", stagedCompleteness,
      ],
      env: {},
      providerServiceKey: OFFLINE_PROVIDER_KEY,
      now: new Date(replay.capture.observedAt),
      repositoryRoot,
      fetchImpl: replay.fetchImpl,
      collectImpl: async (options) => {
        try {
          const artifact = await collectCompletenessImpl(options);
          assertReplayProjection(artifact, replayEvidence);
          artifact.sourceTimetableArtifact.replayAdmissionProvenance = replayAdmissionProvenance({
            capture: replay.capture,
            replayEvidence,
          });
          artifact.evidenceHash = evidenceHash(artifact);
          return artifact;
        } catch (error) {
          deferredCollectionFailure ??= error;
          return { validationStatus: "MISSING" };
        }
      },
      onPublicationEvent: async ({ event }) => {
        if (event === "before-stage-created") {
          if (deferredCollectionFailure !== null) throw deferredCollectionFailure;
          replay.assertExhausted();
          exhaustionChecked = true;
        }
      },
    });
    replay.assertExhausted();
    if (!exhaustionChecked) throw new Error("candidate publication did not verify capture exhaustion");
    validateResult(result);
    const candidateBytes = await readFile(stagedCandidate);
    const completenessBytes = await readFile(stagedCompleteness);
    if (sha256(candidateBytes) !== result.outputSha256
      || sha256(completenessBytes) !== result.completenessEvidenceSha256) {
      throw new Error("staged replay admission output identity is invalid");
    }
    await publishFinalOutputs({
      stagedCandidate,
      stagedCompleteness,
      candidateOutput: args["candidate-output"],
      completenessOutput: args["completeness-output"],
    });
    return result;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function publishFinalOutputs({ stagedCandidate, stagedCompleteness, candidateOutput, completenessOutput }) {
  const candidateIdentity = await lstat(stagedCandidate);
  const completenessIdentity = await lstat(stagedCompleteness);
  let completenessPublished = false;
  try {
    await link(stagedCompleteness, completenessOutput);
    completenessPublished = true;
    if (!sameIdentity(await lstat(completenessOutput), completenessIdentity)) {
      throw new Error("final replay admission output identity is invalid");
    }
    await link(stagedCandidate, candidateOutput);
    if (!sameIdentity(await lstat(candidateOutput), candidateIdentity)) {
      throw new Error("final replay admission output identity is invalid");
    }
  } catch (error) {
    if (completenessPublished) await removeOwnedOutput(completenessOutput, completenessIdentity);
    await removeOwnedOutput(candidateOutput, candidateIdentity);
    throw error;
  }
}

async function removeOwnedOutput(output, identity) {
  try {
    if (sameIdentity(await lstat(output), identity)) await unlink(output);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function parseReplayEvidence(bytes) {
  let value;
  try {
    value = JSON.parse(bytes);
  } catch (error) {
    throw new Error("successful replay evidence bytes are invalid", { cause: error });
  }
  if (bytes.toString("utf8") !== `${JSON.stringify(value, null, 2)}\n`
    || value?.evidenceHash !== evidenceHash(value)) {
    throw new Error("successful replay evidence bytes are invalid");
  }
  return value;
}

function assertReplayProjection(admissionArtifact, replayEvidence) {
  const normalized = structuredClone(admissionArtifact);
  delete normalized.sourceTimetableArtifact?.replayAdmissionProvenance;
  normalized.validationMode = "REPLAY";
  normalized.admissionStatus = "REPLAY_ONLY";
  normalized.admissionEligible = false;
  normalized.snapshotDiff = {
    policyVersion: "itx-snapshot-anomaly-v1",
    status: "NOT_EVALUATED",
    serviceDays: [],
  };
  if (normalized.failureStage === "SNAPSHOT_DIFF"
    && normalized.failureReasonCode === "SNAPSHOT_ANOMALY_BLOCKED") {
    delete normalized.failureStage;
    delete normalized.failureReasonCode;
  }
  if (normalized.sourceTimetableArtifact?.status !== undefined) {
    normalized.sourceTimetableArtifact.status = "REPLAY_ONLY";
  }
  normalized.evidenceHash = evidenceHash(normalized);
  if (JSON.stringify(normalized) !== JSON.stringify(replayEvidence)) {
    throw new Error("capture-derived admission projection differs from successful replay evidence");
  }
}

function replayAdmissionProvenance({ capture, replayEvidence }) {
  return {
    schemaVersion: 1,
    capture: {
      ...CAPTURE_PROVENANCE,
      contentSha256: capture.contentSha256,
      requestCount: capture.requestCount,
      observedAt: capture.observedAt,
    },
    replay: {
      ...REPLAY_PROVENANCE,
      evidenceHash: replayEvidence.evidenceHash,
    },
    providerCallCount: 0,
  };
}

function evidenceHash(value) {
  const { evidenceHash: _ignored, ...withoutHash } = value ?? {};
  return createHash("sha256").update(JSON.stringify(withoutHash)).digest("hex");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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
