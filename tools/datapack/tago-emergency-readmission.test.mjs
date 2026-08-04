import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  TagoProviderBoundaryError,
  providerFailureEvidence,
} from "./collect-tago-itx-cheongchun-od.mjs";
import {
  createTagoEmergencyReadmission,
  exactTagoProviderErrorFromCompleteness,
  prepareTagoNetworkAdmission,
  runTagoEmergencyReadmissionCli,
  validateTagoEmergencyReadmission,
} from "./tago-emergency-readmission.mjs";

const ADMITTED_AT = "2026-08-04T14:53:01.000Z";
const EXPIRES_AT = "2026-08-11T14:53:01.000Z";
const bytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function failureEvidence(detail = {}) {
  return providerFailureEvidence(new TagoProviderBoundaryError("TAGO provider failure", {
    operation: "GetVhcleKndList",
    transportStatus: "HTTP_SUCCESS",
    httpStatus: 200,
    schemaStatus: "EXPECTED",
    resultCode: "01",
    ...detail,
  }), { observedAt: "2026-08-04T08:00:38.000Z" });
}

function sourceInputs() {
  return {
    itxCoverageContractBytes: bytes({
      schemaVersion: 2,
      artifactKind: "itx-cheongchun-coverage-contract",
      sourceTimetableArtifact: {
        artifactId: "itx-cheongchun-source-timetable-20260727071853886",
        artifactPath: "tools/datapack/sources/itx-cheongchun-source-timetable-20260727071853886.json",
        sha256: "7".repeat(64),
        freshUntil: "2026-08-03T00:00:00+09:00",
      },
    }),
    capitalTopologyBytes: bytes({
      schemaVersion: 1,
      artifactKind: "capital-route-topology-snapshot",
      capturedAt: "2026-07-24T08:20:00.000Z",
      freshUntil: "2026-07-25T08:20:00.000Z",
      contentSha256: "0".repeat(64),
    }),
    capitalReverificationBytes: bytes({
      schemaVersion: 1,
      artifactKind: "capital-topology-reverification-evidence",
      sourceIssue: 60,
      admissionIssue: 2649,
      baseline: {
        snapshotId: "capital-route-topology-20260724",
        contentSha256: "0".repeat(64),
        normalizedLineSetSha256: "e".repeat(64),
      },
      candidate: {
        capturedAt: "2026-08-03T17:53:50.204Z",
        freshUntil: "2026-08-04T17:53:50.204Z",
        contentSha256: "8".repeat(64),
        normalizedLineSetSha256: "e".repeat(64),
      },
      comparison: {
        changedLineCount: 0,
        addedEdgeCount: 0,
        removedEdgeCount: 0,
        modifiedEdgeCount: 0,
      },
    }),
    capitalTopologyAdmission: {
      schemaVersion: 1,
      artifactKind: "capital-network-edge-admission",
      issue: 2649,
      status: "ADMITTED",
      snapshotId: "capital-route-topology-20260724",
      contentSha256: "0".repeat(64),
      reviewedAt: "2026-08-03T17:57:46.000Z",
      freshUntil: "2026-08-04T17:53:50.204Z",
    },
  };
}

function createDecision(failure = failureEvidence(), override = {}) {
  return createTagoEmergencyReadmission({
    failureEvidenceBytes: bytes(failure),
    ...sourceInputs(),
    admittedAt: ADMITTED_AT,
    ...override,
  });
}

function exactCompletenessFailure() {
  return {
    schemaVersion: 2,
    artifactKind: "korail-itx-cheongchun-completeness-evidence",
    observedAt: "2026-08-04T08:00:38.000Z",
    validationStatus: "MISSING",
    admissionStatus: "MISSING",
    credentialRedacted: true,
    serviceDays: ["8", "7", "9"].map((dayCd) => ({
      dayCd,
      status: "MISSING",
      failureStage: "ROSTER",
      failureReasonCode: "PROVIDER_RESULT_FAILURE",
      failureContext: "operation=GetVhcleKndList,resultCode=01",
    })),
  };
}

function validateDecision(decision, failure = failureEvidence(), override = {}) {
  return validateTagoEmergencyReadmission({
    admissionBytes: bytes(decision),
    failureEvidenceBytes: bytes(failure),
    ...sourceInputs(),
    now: new Date(ADMITTED_AT),
    ...override,
  });
}

async function cliFixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), "tago-emergency-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sources = sourceInputs();
  const files = [
    ["tools/datapack/itx-cheongchun-coverage-contract.json", sources.itxCoverageContractBytes],
    ["tools/datapack/sources/capital-route-topology-20260724.json", sources.capitalTopologyBytes],
    ["tools/datapack/release/capital-topology-reverification-20260804.json", sources.capitalReverificationBytes],
  ];
  for (const [relative, value] of files) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, value);
  }
  const buildSpecPath = path.join(root, "tools/datapack/release/candidate-build-spec.json");
  await writeFile(buildSpecPath, bytes({
    schemaVersion: 1,
    artifactKind: "datapack-candidate-build-spec",
    networkEdgeEvidence: { capitalTopologyAdmission: sources.capitalTopologyAdmission },
  }));
  return {
    root,
    buildSpecPath,
    failurePath: path.join(root, "tools/datapack/release/tago-provider-failure-20260804.json"),
    decisionPath: path.join(root, "tools/datapack/release/tago-emergency-readmission-20260804.json"),
  };
}

function normalCliArgs(fixture) {
  return [
    "--day8-date", "20260804",
    "--day7-date", "20260808",
    "--day9-date", "20260809",
    "--canonical-pack", "apps/mobile/assets/datapacks/capital.sqlite.gz",
    "--failure-output", fixture.failurePath,
    "--decision-output", fixture.decisionPath,
    "--build-spec", "tools/datapack/release/candidate-build-spec.json",
    "--update-build-spec",
  ];
}

test("fresh 성공은 emergency factory를 호출하지 않는다", async () => {
  let emergencyCalls = 0;
  const result = await prepareTagoNetworkAdmission({
    collectFresh: async () => ({ artifactId: "fresh-itx" }),
    createEmergency: () => { emergencyCalls += 1; },
  });
  assert.deepEqual(result, { mode: "FRESH", freshArtifact: { artifactId: "fresh-itx" } });
  assert.equal(emergencyCalls, 0);
});

test("current 3-service-day runner의 동일한 TAGO 01만 structured error로 승격한다", () => {
  const error = exactTagoProviderErrorFromCompleteness(exactCompletenessFailure());
  assert.ok(error instanceof TagoProviderBoundaryError);
  assert.deepEqual(error.detail, {
    operation: "GetVhcleKndList",
    transportStatus: "HTTP_SUCCESS",
    httpStatus: 200,
    schemaStatus: "EXPECTED",
    resultCode: "01",
  });

  for (const mutate of [
    (artifact) => artifact.serviceDays.pop(),
    (artifact) => { artifact.serviceDays[1].failureContext = "operation=GetVhcleKndList,resultCode=02"; },
    (artifact) => { artifact.serviceDays[2].failureReasonCode = "PROVIDER_SCHEMA_FAILURE"; },
  ]) {
    const artifact = exactCompletenessFailure();
    mutate(artifact);
    assert.throws(() => exactTagoProviderErrorFromCompleteness(artifact), /not eligible for emergency readmission/);
  }
});

test("exact TAGO 01 failure만 7일 decision과 source identity에 결속한다", async () => {
  const providerError = new TagoProviderBoundaryError("TAGO provider resultCode 01", {
    operation: "GetVhcleKndList",
    transportStatus: "HTTP_SUCCESS",
    httpStatus: 200,
    schemaStatus: "EXPECTED",
    resultCode: "01",
  });
  const sources = sourceInputs();
  const result = await prepareTagoNetworkAdmission({
    collectFresh: async () => { throw providerError; },
    createEmergency: (failure) => createTagoEmergencyReadmission({
      failureEvidenceBytes: bytes(failure),
      ...sources,
      admittedAt: ADMITTED_AT,
    }),
    observedAt: "2026-08-04T08:00:38.000Z",
  });

  assert.equal(result.mode, "EMERGENCY_REVALIDATED");
  assert.equal(result.emergencyReadmission.expiresAt, EXPIRES_AT);
  assert.equal(result.emergencyReadmission.dataIssue, 60);
  assert.equal(result.emergencyReadmission.hubIssue, 2649);
  assert.equal(result.emergencyReadmission.launchDenominatorDecision, "NO_GO");
  assert.equal(result.emergencyReadmission.itx.sourceFreshUntil, "2026-08-03T00:00:00+09:00");
  assert.equal(result.emergencyReadmission.capitalTopology.contentSha256, "0".repeat(64));
});

test("decision validator는 exact bytes와 반개방 7일 window만 허용한다", () => {
  const failure = failureEvidence();
  const decision = createDecision(failure);
  const admissionBytes = bytes(decision);
  assert.deepEqual(validateDecision(decision, failure), {
    status: "EMERGENCY_REVALIDATED",
    sourceFreshUntil: "2026-08-03T00:00:00+09:00",
    expiresAt: EXPIRES_AT,
    decisionSha256: sha256(admissionBytes),
  });
  assert.throws(
    () => validateDecision(decision, failure, { now: new Date(EXPIRES_AT) }),
    /emergency TAGO readmission is expired/,
  );
  assert.throws(
    () => validateDecision(decision, failure, { now: new Date("2026-08-04T14:53:00.999Z") }),
    /emergency TAGO readmission is not active/,
  );
});

test("다른 provider failure와 변조된 decision/source는 fail closed한다", async () => {
  for (const [label, detail] of [
    ["resultCode", { resultCode: "02" }],
    ["operation", { operation: "GetCtyCodeList" }],
    ["HTTP", { httpStatus: 503 }],
    ["schema", { schemaStatus: "MISMATCH" }],
  ]) {
    assert.throws(() => createDecision(failureEvidence(detail)), new RegExp(label));
  }

  for (const message of ["TAGO_QUOTA_BUDGET_EXHAUSTED", "TAGO schema mismatch"]) {
    await assert.rejects(prepareTagoNetworkAdmission({
      collectFresh: async () => { throw new Error(message); },
      createEmergency: () => assert.fail("emergency must not run"),
      observedAt: "2026-08-04T08:00:38.000Z",
    }), new RegExp(message));
  }

  const failure = failureEvidence();
  const badFingerprint = structuredClone(failure);
  badFingerprint.failureFingerprint = "f".repeat(64);
  assert.throws(() => createDecision(badFingerprint), /failureFingerprint/);

  const shortWindow = createDecision(failure);
  shortWindow.expiresAt = "2026-08-10T14:53:01.000Z";
  assert.throws(() => validateDecision(shortWindow, failure), /exactly seven days/);

  const unexpectedField = createDecision(failure);
  unexpectedField.fallback = true;
  assert.throws(() => validateDecision(unexpectedField, failure), /decision keys/);

  const sources = sourceInputs();
  const tamperedItx = Buffer.concat([sources.itxCoverageContractBytes, Buffer.from(" ")]);
  assert.throws(
    () => validateDecision(createDecision(failure), failure, { itxCoverageContractBytes: tamperedItx }),
    /ITX coverage contract SHA-256/,
  );
});

test("CLI는 key 누락 시 current runner를 호출하지 않는다", async () => {
  let calls = 0;
  await assert.rejects(runTagoEmergencyReadmissionCli({
    argv: [],
    env: {},
    runFreshImpl: async () => { calls += 1; },
  }), /DATA_GO_KR_SERVICE_KEY is required/);
  assert.equal(calls, 0);
});

test("CLI fresh 성공은 emergency 파일과 build spec을 변경하지 않는다", async (context) => {
  const fixture = await cliFixture(context);
  const beforeSpec = await readFile(fixture.buildSpecPath);
  const result = await runTagoEmergencyReadmissionCli({
    argv: normalCliArgs(fixture),
    env: { DATA_GO_KR_SERVICE_KEY: "key" },
    repositoryRoot: fixture.root,
    now: new Date(ADMITTED_AT),
    decisionNow: () => assert.fail("fresh path must not create an emergency decision"),
    runFreshImpl: async () => ({
      exitCode: 0,
      artifact: { validationStatus: "SUPPORTED" },
      candidate: { artifactKind: "itx-cheongchun-source-timetable-candidate" },
      outputSha256: "a".repeat(64),
    }),
  });
  assert.equal(result.mode, "FRESH");
  assert.deepEqual(await readFile(fixture.buildSpecPath), beforeSpec);
  await assert.rejects(readFile(fixture.failurePath), { code: "ENOENT" });
  await assert.rejects(readFile(fixture.decisionPath), { code: "ENOENT" });
});

test("CLI exact outage만 decision을 쓰고 validate mode는 network를 호출하지 않는다", async (context) => {
  const fixture = await cliFixture(context);
  let freshFinished = false;
  const result = await runTagoEmergencyReadmissionCli({
    argv: normalCliArgs(fixture),
    env: { DATA_GO_KR_SERVICE_KEY: "key" },
    repositoryRoot: fixture.root,
    now: new Date(ADMITTED_AT),
    decisionNow: () => {
      assert.equal(freshFinished, true);
      return new Date(ADMITTED_AT);
    },
    runFreshImpl: async () => {
      freshFinished = true;
      return { exitCode: 1, artifact: exactCompletenessFailure(), candidate: null };
    },
  });
  assert.equal(result.mode, "EMERGENCY_REVALIDATED");
  const decisionBytes = await readFile(fixture.decisionPath);
  const decision = JSON.parse(decisionBytes);
  const spec = JSON.parse(await readFile(fixture.buildSpecPath));
  assert.equal(decision.expiresAt, EXPIRES_AT);
  assert.deepEqual(spec.networkEdgeEvidence.emergencyReadmission, {
    path: "tools/datapack/release/tago-emergency-readmission-20260804.json",
    sha256: sha256(decisionBytes),
  });

  let networkCalls = 0;
  const validated = await runTagoEmergencyReadmissionCli({
    argv: [
      "--validate",
      "--failure", fixture.failurePath,
      "--decision", fixture.decisionPath,
      "--build-spec", "tools/datapack/release/candidate-build-spec.json",
    ],
    env: {},
    repositoryRoot: fixture.root,
    now: new Date(ADMITTED_AT),
    runFreshImpl: async () => { networkCalls += 1; },
  });
  assert.equal(validated.status, "EMERGENCY_REVALIDATED");
  assert.equal(networkCalls, 0);
});
