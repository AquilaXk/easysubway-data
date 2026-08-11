import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readEvidenceBytes } from "./inspect-itx-current-collection-evidence.mjs";

const execFileAsync = promisify(execFile);
const script = path.resolve("tools/datapack/inspect-itx-current-collection-evidence.mjs");

function evidence(overrides = {}) {
  const value = {
    schemaVersion: 2,
    artifactKind: "korail-itx-cheongchun-completeness-evidence",
    serviceId: "ITX_CHEONGCHUN",
    observedAt: "2026-08-12T00:00:00.000Z",
    timezone: "Asia/Seoul",
    validationMode: "ADMISSION",
    selectedServiceDates: { "8": "20260812", "7": "20260815", "9": "20260816" },
    validationStatus: "MISSING",
    admissionStatus: "MISSING",
    admissionEligible: false,
    allowedConsumerIssues: [],
    legacyDaejeonRowCount: 0,
    legacyYongsanDaejeonTripCount: 0,
    serviceDays: [
      {
        dayCd: "8", serviceDate: "20260812", status: "MISSING",
        failureStage: "PLAN_CORROBORATION", failureReasonCode: "OFFICIAL_RUN_INFO_EMPTY",
        failureContext: "operation=travelerTrainRunInfo2,total=0",
        expectedOdCount: 306, completedOdCount: 306, failedOdCount: 0,
      },
      {
        dayCd: "7", serviceDate: "20260815", status: "MISSING",
        failureStage: "OD_MATERIALIZATION", failureReasonCode: "OD_MATRIX_INCOMPLETE",
        expectedOdCount: 306, completedOdCount: 305, failedOdCount: 1,
      },
      {
        dayCd: "9", serviceDate: "20260816", status: "SUPPORTED",
        expectedOdCount: 306, completedOdCount: 306, failedOdCount: 0,
      },
    ],
    snapshotDiff: { policyVersion: "itx-snapshot-anomaly-v1", status: "NOT_EVALUATED", serviceDays: [] },
    sourceTimetableArtifact: { status: "MISSING", artifactId: "itx-current", policyVersion: "itx-snapshot-anomaly-v1", freshUntil: "2026-08-13T00:00:00+09:00" },
    materialization: { status: "MISSING" },
    stationCatalogPackIdentity: { id: "capital" },
    credentialRedacted: true,
    ...overrides,
  };
  if (!Object.hasOwn(overrides, "evidenceHash")) {
    value.evidenceHash = createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }
  return value;
}

async function invoke(directory, value, file = "evidence.json") {
  const evidencePath = path.join(directory, file);
  await writeFile(evidencePath, JSON.stringify(value));
  return execFileAsync(process.execPath, [script, "--evidence", evidencePath], { encoding: "utf8" });
}

function rehash(value) {
  const { evidenceHash: _hash, ...withoutHash } = value;
  value.evidenceHash = createHash("sha256").update(JSON.stringify(withoutHash)).digest("hex");
  return value;
}

function jsonBytesOfSize(value, size) {
  const json = Buffer.from(JSON.stringify(value));
  assert.ok(json.length <= size);
  return Buffer.concat([json, Buffer.alloc(size - json.length, 0x20)]);
}

async function diagnostic(run) {
  try {
    await run();
    assert.fail("diagnostic failure가 필요합니다");
  } catch (error) {
    return error.stderr.trim();
  }
}

test("MISSING top-level/per-day failure를 raw 없이 canonical aggregate로 출력한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "itx-evidence-inspector-"));
  try {
    const value = evidence({ failureStage: "SNAPSHOT_DIFF", failureReasonCode: "SNAPSHOT_ANOMALY_BLOCKED" });
    const { stdout, stderr } = await invoke(directory, value);
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), {
      schemaVersion: 1,
      artifactKind: "itx-current-collection-evidence-inspection",
      selectedServiceDates: { "7": "20260815", "8": "20260812", "9": "20260816" },
      validationStatus: "MISSING",
      admissionStatus: "MISSING",
      serviceDayCount: 3,
      aggregate: { expectedOdCount: 918, completedOdCount: 917, failedOdCount: 1 },
      failures: [
        { scope: "TOP_LEVEL", failureStage: "SNAPSHOT_DIFF", failureReasonCode: "SNAPSHOT_ANOMALY_BLOCKED", failureContexts: [] },
        { scope: "SERVICE_DAY", dayCd: "8", failureStage: "PLAN_CORROBORATION", failureReasonCode: "OFFICIAL_RUN_INFO_EMPTY", failureContexts: ["KORAIL_RUN_INFO_EMPTY"] },
        { scope: "SERVICE_DAY", dayCd: "7", failureStage: "OD_MATERIALIZATION", failureReasonCode: "OD_MATRIX_INCOMPLETE", failureContexts: [] },
      ],
    });
    assert.doesNotMatch(stdout, /travelerTrainRunInfo2|station|credential|artifactId|observedAt/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SUPPORTED evidence도 같은 closed schema로 출력한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "itx-evidence-inspector-supported-"));
  try {
    const supported = evidence({
      validationStatus: "SUPPORTED", admissionStatus: "SUPPORTED", serviceDays: evidence().serviceDays.map((day) => ({
        dayCd: day.dayCd, serviceDate: day.serviceDate, status: "SUPPORTED",
        expectedOdCount: 306, completedOdCount: 306, failedOdCount: 0,
      })),
    });
    const { stdout } = await invoke(directory, supported);
    assert.deepEqual(JSON.parse(stdout).failures, []);
    assert.deepEqual(JSON.parse(stdout).aggregate, { expectedOdCount: 918, completedOdCount: 918, failedOdCount: 0 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("current producer admission status와 closed TAGO roster failure context를 보존하되 raw ID는 출력하지 않는다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "itx-evidence-inspector-tago-context-"));
  try {
    const values = [
      ["SUPPORTED", null, []],
      ["BOOTSTRAP_REVIEW_REQUIRED", null, []],
      ["CHANGE_REVIEW_REQUIRED", null, []],
      ["REPLAY_ONLY", null, []],
      ["MISSING", "operation=GetStrtpntAlocFndTrainInfo,reason=date_mismatch,relation=previous_calendar_day,departureStationId=station-secret-a,arrivalStationId=station-secret-b", ["TAGO_OD_DATE_MISMATCH"]],
      ["MISSING", "operation=GetStrtpntAlocFndTrainInfo,reason=schema_mismatch,body,bodyFields=trainno,departureStationId=station-secret-a,arrivalStationId=station-secret-b", ["TAGO_OD_SCHEMA_FAILURE"]],
      ["MISSING", "operation=GetStrtpntAlocFndTrainInfo,departureStationId=station-secret-a,arrivalStationId=station-secret-b", ["TAGO_OD_PROVIDER_FAILURE"]],
    ];
    for (const [admissionStatus, failureContext, expectedContexts] of values) {
      const value = evidence({
        validationStatus: admissionStatus === "MISSING" ? "MISSING" : "SUPPORTED",
        admissionStatus,
        serviceDays: evidence().serviceDays.map((day) => ({
          dayCd: day.dayCd, serviceDate: day.serviceDate, status: "SUPPORTED",
          expectedOdCount: 1, completedOdCount: 1, failedOdCount: 0,
        })),
      });
      if (failureContext) {
        value.serviceDays[0] = {
          ...value.serviceDays[0], status: "MISSING", failureStage: "OD_MATERIALIZATION",
          failureReasonCode: "PROVIDER_SCHEMA_FAILURE", failureContext,
        };
      }
      const { evidenceHash: _hash, ...withoutHash } = value;
      value.evidenceHash = createHash("sha256").update(JSON.stringify(withoutHash)).digest("hex");
      const { stdout } = await invoke(directory, value, `${admissionStatus}.json`);
      const inspection = JSON.parse(stdout);
      assert.equal(inspection.admissionStatus, admissionStatus);
      assert.deepEqual(inspection.failures.at(-1)?.failureContexts ?? [], expectedContexts);
      assert.doesNotMatch(stdout, /station-secret|bodyFields|previous_calendar_day/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("evidenceHash tamper와 open 뒤 path replacement를 fail-closed 또는 original handle로 처리한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "itx-evidence-inspector-handle-"));
  try {
    const staleHash = evidence({ evidenceHash: "0".repeat(64) });
    await assert.rejects(invoke(directory, staleHash, "stale-hash.json"));

    const original = Buffer.from(JSON.stringify(evidence()));
    const originalPath = path.join(directory, "replacement.json");
    const movedPath = path.join(directory, "replacement-original.json");
    await writeFile(originalPath, original);
    const read = await readEvidenceBytes(originalPath, {
      afterOpen: async () => {
        await rename(originalPath, movedPath);
        await writeFile(originalPath, JSON.stringify(evidence({ evidenceHash: "f".repeat(64) })));
      },
    });
    assert.deepEqual(read, original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pre-service-day MISSING catch evidence는 reason-only closed failure로 출력한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "itx-evidence-inspector-pre-service-day-"));
  try {
    const failedBeforeServiceDays = evidence({
      failureReasonCode: "PROVIDER_HTTP_FAILURE",
      serviceDays: [],
    });
    for (const key of ["snapshotDiff", "sourceTimetableArtifact", "stationCatalogPackIdentity"]) {
      delete failedBeforeServiceDays[key];
    }
    const { evidenceHash: _hash, ...withoutHash } = failedBeforeServiceDays;
    failedBeforeServiceDays.evidenceHash = createHash("sha256").update(JSON.stringify(withoutHash)).digest("hex");
    const { stdout } = await invoke(directory, failedBeforeServiceDays);
    assert.deepEqual(JSON.parse(stdout), {
      schemaVersion: 1,
      artifactKind: "itx-current-collection-evidence-inspection",
      selectedServiceDates: { "7": "20260815", "8": "20260812", "9": "20260816" },
      validationStatus: "MISSING",
      admissionStatus: "MISSING",
      serviceDayCount: 0,
      aggregate: { expectedOdCount: 0, completedOdCount: 0, failedOdCount: 0 },
      failures: [{ scope: "TOP_LEVEL", failureReasonCode: "PROVIDER_HTTP_FAILURE" }],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("relative, symlink, oversize, malformed, extra/wrong-type evidence를 내용 반사 없이 거부한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "itx-evidence-inspector-invalid-"));
  const secret = "RAW_PROVIDER_BODY_MUST_NOT_LEAK";
  try {
    const run = (args) => execFileAsync(process.execPath, [script, ...args], { encoding: "utf8" });
    await assert.rejects(run(["--evidence", "relative.json"]), (error) => !error.stderr.includes(secret));

    const target = path.join(directory, "target.json");
    const linked = path.join(directory, "linked.json");
    await writeFile(target, JSON.stringify(evidence()));
    await symlink(target, linked);
    await assert.rejects(run(["--evidence", linked]), (error) => !error.stderr.includes(secret));

    const malformed = path.join(directory, "malformed.json");
    await writeFile(malformed, `{\"secret\":\"${secret}\"`);
    await assert.rejects(run(["--evidence", malformed]), (error) => !error.stderr.includes(secret));

    const extra = path.join(directory, "extra.json");
    await writeFile(extra, JSON.stringify(evidence({ providerBody: secret })));
    await assert.rejects(run(["--evidence", extra]), (error) => !error.stderr.includes(secret));

    const wrongType = path.join(directory, "wrong-type.json");
    await writeFile(wrongType, JSON.stringify(evidence({ credentialRedacted: "true" })));
    await assert.rejects(run(["--evidence", wrongType]), (error) => !error.stderr.includes(secret));

    const oversized = path.join(directory, "oversized.json");
    await writeFile(oversized, jsonBytesOfSize(evidence(), 4_194_305));
    await assert.rejects(run(["--evidence", oversized]), (error) => !error.stderr.includes(secret));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("closed diagnostic code는 오류 원인만 출력하고 evidence 값·경로·credential을 반사하지 않는다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "itx-evidence-inspector-diagnostics-"));
  const secret = "RAW_PROVIDER_BODY_MUST_NOT_LEAK";
  try {
    const run = (args) => execFileAsync(process.execPath, [script, ...args], { encoding: "utf8" });
    const cases = [];
    cases.push(["ARGUMENT", () => run(["--evidence", "relative.json"])]);

    const target = path.join(directory, "target.json");
    const linked = path.join(directory, "linked.json");
    await writeFile(target, JSON.stringify(evidence()));
    await symlink(target, linked);
    cases.push(["FILE_OPEN", () => run(["--evidence", linked])]);

    const oversized = path.join(directory, "oversized.json");
    await writeFile(oversized, jsonBytesOfSize(evidence(), 4_194_305));
    cases.push(["FILE_IDENTITY", () => run(["--evidence", oversized])]);

    const malformed = path.join(directory, "malformed.json");
    await writeFile(malformed, `{\"credential\":\"${secret}\"`);
    cases.push(["JSON", () => run(["--evidence", malformed])]);

    cases.push(["TOP_LEVEL_SHAPE", () => invoke(directory, evidence({ providerBody: secret }), "top-level.json")]);
    cases.push(["BASE_IDENTITY", () => invoke(directory, evidence({ credentialRedacted: false }), "base.json")]);
    cases.push(["EVIDENCE_HASH", () => invoke(directory, evidence({ evidenceHash: "0".repeat(64) }), "hash.json")]);

    const preServiceExtra = evidence({ failureReasonCode: "PROVIDER_HTTP_FAILURE", serviceDays: [] });
    for (const key of ["snapshotDiff", "sourceTimetableArtifact"]) delete preServiceExtra[key];
    rehash(preServiceExtra);
    cases.push(["PRE_SERVICE_SHAPE", () => invoke(directory, preServiceExtra, "pre-service.json")]);

    const badDay = evidence();
    badDay.serviceDays[1].dayCd = "8";
    rehash(badDay);
    cases.push(["SERVICE_DAY_SHAPE", () => invoke(directory, badDay, "service-day.json")]);

    const badContext = evidence();
    badContext.serviceDays[0].failureContext = `raw=${secret}`;
    rehash(badContext);
    cases.push(["FAILURE_CONTEXT", () => invoke(directory, badContext, "failure-context.json")]);

    for (const [code, runCase] of cases) {
      const stderr = await diagnostic(runCase);
      assert.equal(stderr, code);
      assert.doesNotMatch(stderr, /RAW_PROVIDER|credential|target|\.json|[a-f0-9]{64}/i);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("current producer-sized regular evidence를 수용하고 4 MiB 초과는 FILE_IDENTITY로 거부한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "itx-evidence-inspector-size-"));
  try {
    const producerSized = path.join(directory, "producer-sized.json");
    await writeFile(producerSized, jsonBytesOfSize(evidence(), 2_308_657));
    const { stdout } = await execFileAsync(process.execPath, [script, "--evidence", producerSized], { encoding: "utf8" });
    assert.equal(JSON.parse(stdout).serviceDayCount, 3);

    const oversized = path.join(directory, "oversized.json");
    await writeFile(oversized, jsonBytesOfSize(evidence(), 4_194_305));
    assert.equal(
      await diagnostic(() => execFileAsync(process.execPath, [script, "--evidence", oversized], { encoding: "utf8" })),
      "FILE_IDENTITY",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FIFO와 numeric/date/failureContext 경계는 closed diagnostic으로 fail-closed한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "itx-evidence-inspector-review-"));
  try {
    const fifo = path.join(directory, "evidence.fifo");
    await execFileAsync("mkfifo", [fifo]);
    assert.equal(
      await diagnostic(() => execFileAsync(process.execPath, [script, "--evidence", fifo], { encoding: "utf8", timeout: 1_000 })),
      "FILE_IDENTITY",
    );

    const overflowing = evidence();
    overflowing.serviceDays[0].expectedOdCount = Number.MAX_SAFE_INTEGER;
    overflowing.serviceDays[1].expectedOdCount = Number.MAX_SAFE_INTEGER;
    rehash(overflowing);
    assert.equal(await diagnostic(() => invoke(directory, overflowing, "overflowing.json")), "SERVICE_DAY_SHAPE");

    const numericDate = evidence();
    numericDate.selectedServiceDates["8"] = 20260812;
    rehash(numericDate);
    assert.equal(await diagnostic(() => invoke(directory, numericDate, "numeric-date.json")), "BASE_IDENTITY");

    const objectFailureContext = evidence();
    objectFailureContext.serviceDays[0].failureContext = { code: "not-a-string" };
    rehash(objectFailureContext);
    assert.equal(await diagnostic(() => invoke(directory, objectFailureContext, "object-context.json")), "FAILURE_CONTEXT");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
