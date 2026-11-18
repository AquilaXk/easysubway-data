import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createProviderResponseRecorder,
  providerResponseCaptureBytes,
} from "./provider-response-capture.mjs";
import { materializeReplayedItxAdmissionCandidateCli } from "./materialize-replayed-itx-admission-candidate.mjs";

const SERVICE_DATES = Object.freeze({ "7": "20260822", "8": "20260813", "9": "20260816" });

function request(operation, key = "capture-key") {
  return `https://apis.data.go.kr/1613000/TrainInfo/${operation}?serviceKey=${key}&_type=json`;
}

async function capturedBytes(serviceDates = SERVICE_DATES, responseMarker = "exact") {
  const recorder = createProviderResponseRecorder({
    observedAt: "2026-08-13T00:00:00.000Z",
    selectedServiceDates: serviceDates,
    fetchImpl: async (url) => new Response(JSON.stringify({
      operation: new URL(url).pathname.split("/").at(-1),
      responseMarker,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  await recorder.fetchImpl(request("GetVhcleKndList"));
  await recorder.fetchImpl(request("GetCtyCodeList"));
  return providerResponseCaptureBytes(recorder.captureArtifact());
}

function replayEvidence(overrides = {}) {
  const value = {
    schemaVersion: 2,
    artifactKind: "korail-itx-cheongchun-completeness-evidence",
    serviceId: "ITX_CHEONGCHUN",
    observedAt: "2026-08-13T00:00:00.000Z",
    timezone: "Asia/Seoul",
    validationMode: "REPLAY",
    selectedServiceDates: SERVICE_DATES,
    validationStatus: "SUPPORTED",
    admissionStatus: "REPLAY_ONLY",
    admissionEligible: false,
    allowedConsumerIssues: [],
    legacyDaejeonRowCount: 0,
    legacyYongsanDaejeonTripCount: 0,
    serviceDays: ["8", "7", "9"].map((dayCd) => ({
      dayCd,
      serviceDate: SERVICE_DATES[dayCd],
      status: "SUPPORTED",
      expectedOdCount: 306,
      completedOdCount: 306,
      failedOdCount: 0,
    })),
    snapshotDiff: { policyVersion: "itx-snapshot-anomaly-v1", status: "NOT_EVALUATED", serviceDays: [] },
    sourceTimetableArtifact: {
      status: "REPLAY_ONLY",
      artifactId: "itx-cheongchun-source-timetable-20260813000000000",
      policyVersion: "itx-snapshot-anomaly-v1",
      freshUntil: "2026-08-23T00:00:00+09:00",
    },
    materialization: { status: "SUPPORTED" },
    stationCatalogPackIdentity: { id: "capital" },
    credentialRedacted: true,
    ...overrides,
  };
  const { evidenceHash: _ignored, ...withoutHash } = value;
  value.evidenceHash = createHash("sha256").update(JSON.stringify(withoutHash)).digest("hex");
  return value;
}

function admissionEvidence(overrides = {}) {
  const value = replayEvidence();
  value.validationMode = "ADMISSION";
  value.admissionStatus = "SUPPORTED";
  value.snapshotDiff = { policyVersion: "itx-snapshot-anomaly-v1", status: "SUPPORTED", serviceDays: [] };
  value.sourceTimetableArtifact.status = "SUPPORTED";
  Object.assign(value, overrides);
  const { evidenceHash: _ignored, ...withoutHash } = value;
  value.evidenceHash = createHash("sha256").update(JSON.stringify(withoutHash)).digest("hex");
  return value;
}

function valueAfter(argv, name) {
  const index = argv.indexOf(name);
  assert.notEqual(index, -1, `${name} argument가 필요합니다`);
  return argv[index + 1];
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "itx-replay-admission-"));
  const values = {
    directory,
    capture: path.join(directory, "capture.json"),
    replayEvidence: path.join(directory, "replay.json"),
    stationCatalogPack: path.join(directory, "station-catalog-pack"),
    candidate: path.join(directory, "candidate.json"),
    completeness: path.join(directory, "completeness.json"),
  };
  const captureBytes = await capturedBytes();
  const replayBytes = Buffer.from(`${JSON.stringify(replayEvidence(), null, 2)}\n`);
  await writeFile(values.capture, captureBytes);
  await writeFile(values.replayEvidence, replayBytes);
  values.captureBytesSha256 = createHash("sha256").update(captureBytes).digest("hex");
  values.replayBytesSha256 = createHash("sha256").update(replayBytes).digest("hex");
  values.captureContentSha256 = JSON.parse(captureBytes).contentSha256;
  values.replayEvidenceHash = JSON.parse(replayBytes).evidenceHash;
  return values;
}

function pins(values, overrides = {}) {
  return {
    expectedCaptureBytesSha256: values.captureBytesSha256,
    expectedReplayEvidenceBytesSha256: values.replayBytesSha256,
    expectedCaptureContentSha256: values.captureContentSha256,
    expectedReplayEvidenceHash: values.replayEvidenceHash,
    ...overrides,
  };
}

function argv(values) {
  return [
    "--capture", values.capture,
    "--replay-evidence", values.replayEvidence,
    "--station-catalog-pack", values.stationCatalogPack,
    "--candidate-output", values.candidate,
    "--completeness-output", values.completeness,
  ];
}

test("successful replay identity를 network 없이 existing ADMISSION candidate boundary로 전달한다", async () => {
  const values = await fixture();
  let received;
  try {
    const result = await materializeReplayedItxAdmissionCandidateCli({
      argv: argv(values),
      repositoryRoot: values.directory,
      ...pins(values),
      collectCompletenessImpl: async (options) => {
        for (const operation of ["GetVhcleKndList", "GetCtyCodeList"]) {
          const response = await options.fetchImpl(request(operation, "different-runtime-key"));
          assert.match(await response.text(), new RegExp(operation));
        }
        return admissionEvidence();
      },
      runCompletenessImpl: async (options) => {
        received = options;
        const artifact = await options.collectImpl({ fetchImpl: options.fetchImpl });
        await options.onPublicationEvent({ event: "before-stage-created" });
        const candidateBytes = "candidate\n";
        const completenessBytes = "completeness\n";
        await writeFile(valueAfter(options.argv, "--output"), candidateBytes);
        await writeFile(valueAfter(options.argv, "--completeness-output"), completenessBytes);
        return {
          artifact,
          candidate: { validationStatus: "SUPPORTED" },
          outputSha256: createHash("sha256").update(candidateBytes).digest("hex"),
          completenessEvidenceSha256: createHash("sha256").update(completenessBytes).digest("hex"),
          exitCode: 0,
        };
      },
    });

    assert.deepEqual(received.argv.slice(0, 8), [
      "--day8-date", SERVICE_DATES["8"],
      "--day7-date", SERVICE_DATES["7"],
      "--day9-date", SERVICE_DATES["9"],
      "--station-catalog-pack", values.stationCatalogPack,
    ]);
    const stagedCandidate = valueAfter(received.argv, "--output");
    const stagedCompleteness = valueAfter(received.argv, "--completeness-output");
    assert.equal(path.dirname(stagedCandidate), path.dirname(stagedCompleteness));
    assert.equal(path.dirname(path.dirname(stagedCandidate)), values.directory);
    assert.match(path.basename(path.dirname(stagedCandidate)), /^\.itx-replay-admission-/);
    assert.notEqual(stagedCandidate, values.candidate);
    assert.notEqual(stagedCompleteness, values.completeness);
    assert.deepEqual(received.env, {});
    assert.equal(received.providerServiceKey, "offline-provider-replay-key");
    assert.equal(received.now.toISOString(), "2026-08-13T00:00:00.000Z");
    assert.equal(await readFile(values.candidate, "utf8"), "candidate\n");
    assert.equal(await readFile(values.completeness, "utf8"), "completeness\n");
    assert.equal(result.outputSha256, createHash("sha256").update("candidate\n").digest("hex"));
    assert.deepEqual(result.artifact.sourceTimetableArtifact.replayAdmissionProvenance, {
      schemaVersion: 1,
      capture: {
        workflowRunId: "31620004435",
        artifactId: "9150832350",
        archiveSha256: "e1203894526b794fbf927b3e7c5da4e33507cbe26b12328ffc45c9da5b3085d5",
        contentSha256: result.artifact.sourceTimetableArtifact.replayAdmissionProvenance.capture.contentSha256,
        requestCount: 2,
        observedAt: "2026-08-13T00:00:00.000Z",
      },
      replay: {
        workflowRunId: "31679427374",
        artifactId: "9172854009",
        archiveSha256: "2bb09e208691896f27d372cdd7345e326e4f76a706c201ec3d48ed2fa0990247",
        evidenceHash: replayEvidence().evidenceHash,
      },
      providerCallCount: 0,
    });
  } finally {
    await rm(values.directory, { recursive: true, force: true });
  }
});

test("replay evidence/capture identity drift와 unconsumed record는 output 0으로 거부한다", async () => {
  const values = await fixture();
  let calls = 0;
  try {
    const driftedCapture = await capturedBytes({ ...SERVICE_DATES, "8": "20260814" });
    await writeFile(values.capture, driftedCapture);
    await assert.rejects(materializeReplayedItxAdmissionCandidateCli({
      argv: argv(values),
      repositoryRoot: values.directory,
      ...pins(values, {
        expectedCaptureBytesSha256: createHash("sha256").update(driftedCapture).digest("hex"),
        expectedCaptureContentSha256: JSON.parse(driftedCapture).contentSha256,
      }),
      runCompletenessImpl: async () => { calls += 1; },
    }), /replay evidence and capture service dates differ/);
    assert.equal(calls, 0);
    await assert.rejects(readFile(values.candidate), /ENOENT/);
    await assert.rejects(readFile(values.completeness), /ENOENT/);

    await writeFile(values.capture, await capturedBytes());
    await assert.rejects(materializeReplayedItxAdmissionCandidateCli({
      argv: argv(values),
      repositoryRoot: values.directory,
      ...pins(values),
      collectCompletenessImpl: async (options) => {
        await options.fetchImpl(request("GetVhcleKndList"));
        return admissionEvidence();
      },
      runCompletenessImpl: async (options) => {
        await options.collectImpl({ fetchImpl: options.fetchImpl });
        await options.onPublicationEvent({ event: "before-stage-created" });
      },
    }), /provider replay has 1 unconsumed record/);
    await assert.rejects(readFile(values.candidate), /ENOENT/);
    await assert.rejects(readFile(values.completeness), /ENOENT/);
  } finally {
    await rm(values.directory, { recursive: true, force: true });
  }
});

test("capture-derived projection drift는 publication 전에 output 0으로 거부한다", async () => {
  const values = await fixture();
  let publicationStarted = false;
  try {
    await assert.rejects(materializeReplayedItxAdmissionCandidateCli({
      argv: argv(values),
      repositoryRoot: values.directory,
      ...pins(values),
      collectCompletenessImpl: async (options) => {
        for (const operation of ["GetVhcleKndList", "GetCtyCodeList"]) {
          await options.fetchImpl(request(operation));
        }
        const artifact = admissionEvidence();
        artifact.serviceDays[0].completedOdCount = 305;
        const { evidenceHash: _ignored, ...withoutHash } = artifact;
        artifact.evidenceHash = createHash("sha256").update(JSON.stringify(withoutHash)).digest("hex");
        return artifact;
      },
      runCompletenessImpl: async (options) => {
        try {
          await options.collectImpl({ fetchImpl: options.fetchImpl });
        } catch {
          // The production completeness CLI converts collection failure to MISSING before publication.
        }
        await options.onPublicationEvent({ event: "before-stage-created" });
        publicationStarted = true;
        await writeFile(valueAfter(options.argv, "--output"), "unexpected missing artifact\n");
        return { artifact: { validationStatus: "MISSING" }, exitCode: 1 };
      },
    }), /capture-derived admission projection differs/);
    assert.equal(publicationStarted, false);
    await assert.rejects(readFile(values.candidate), /ENOENT/);
    await assert.rejects(readFile(values.completeness), /ENOENT/);
  } finally {
    await rm(values.directory, { recursive: true, force: true });
  }
});

test("retained capture와 replay evidence의 exact member bytes가 아니면 collector 전에 거부한다", async () => {
  const values = await fixture();
  let calls = 0;
  try {
    await writeFile(values.capture, await capturedBytes(SERVICE_DATES, "alternate"));
    await assert.rejects(materializeReplayedItxAdmissionCandidateCli({
      argv: argv(values),
      repositoryRoot: values.directory,
      ...pins(values),
      runCompletenessImpl: async () => { calls += 1; },
    }), /retained capture bytes differ/);
    assert.equal(calls, 0);
    await assert.rejects(readFile(values.candidate), /ENOENT/);
    await assert.rejects(readFile(values.completeness), /ENOENT/);

    await writeFile(values.capture, await capturedBytes());
    await writeFile(values.replayEvidence, `${JSON.stringify(replayEvidence({
      allowedConsumerIssues: ["#219"],
    }), null, 2)}\n`);
    await assert.rejects(materializeReplayedItxAdmissionCandidateCli({
      argv: argv(values),
      repositoryRoot: values.directory,
      ...pins(values),
      runCompletenessImpl: async () => { calls += 1; },
    }), /retained replay evidence bytes differ/);
    assert.equal(calls, 0);
    await assert.rejects(readFile(values.candidate), /ENOENT/);
    await assert.rejects(readFile(values.completeness), /ENOENT/);
  } finally {
    await rm(values.directory, { recursive: true, force: true });
  }
});

test("staged output identity 검증 실패는 final candidate와 completeness를 남기지 않는다", async () => {
  const values = await fixture();
  try {
    await assert.rejects(materializeReplayedItxAdmissionCandidateCli({
      argv: argv(values),
      repositoryRoot: values.directory,
      ...pins(values),
      collectCompletenessImpl: async (options) => {
        for (const operation of ["GetVhcleKndList", "GetCtyCodeList"]) {
          await options.fetchImpl(request(operation));
        }
        return admissionEvidence();
      },
      runCompletenessImpl: async (options) => {
        const artifact = await options.collectImpl({ fetchImpl: options.fetchImpl });
        await options.onPublicationEvent({ event: "before-stage-created" });
        await writeFile(valueAfter(options.argv, "--output"), "candidate\n");
        await writeFile(valueAfter(options.argv, "--completeness-output"), "completeness\n");
        return {
          artifact,
          candidate: { validationStatus: "SUPPORTED" },
          outputSha256: "0".repeat(64),
          completenessEvidenceSha256: "1".repeat(64),
          exitCode: 0,
        };
      },
    }), /staged replay admission output identity is invalid/);
    await assert.rejects(readFile(values.candidate), /ENOENT/);
    await assert.rejects(readFile(values.completeness), /ENOENT/);
  } finally {
    await rm(values.directory, { recursive: true, force: true });
  }
});

test("tampered replay evidence hash는 collector 호출 전에 거부한다", async () => {
  const values = await fixture();
  let calls = 0;
  try {
    const tampered = replayEvidence();
    tampered.evidenceHash = "0".repeat(64);
    const tamperedBytes = Buffer.from(`${JSON.stringify(tampered, null, 2)}\n`);
    await writeFile(values.replayEvidence, tamperedBytes);
    await assert.rejects(materializeReplayedItxAdmissionCandidateCli({
      argv: argv(values),
      repositoryRoot: values.directory,
      ...pins(values, {
        expectedReplayEvidenceBytesSha256: createHash("sha256").update(tamperedBytes).digest("hex"),
      }),
      runCompletenessImpl: async () => { calls += 1; },
    }), /successful replay evidence bytes are invalid/);
    assert.equal(calls, 0);
  } finally {
    await rm(values.directory, { recursive: true, force: true });
  }
});
