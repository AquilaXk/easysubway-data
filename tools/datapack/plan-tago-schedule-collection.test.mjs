import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  buildTagoScheduleCollectionPlan,
  buildTagoScheduleCollectionSummary,
} from "./validate-tago-schedule-sample.mjs";

const execFileAsync = promisify(execFile);
const tagoScheduleToolPath = path.resolve(import.meta.dirname, "validate-tago-schedule-sample.mjs");

test("TAGO 시간표 수집 plan은 daily limit과 checkpoint resume을 적용한다", () => {
  const plan = buildTagoScheduleCollectionPlan(
    {
      stationLineRows: [
        { stationCode: "448", lineId: "seoul-4" },
        { stationCode: "433", lineId: "seoul-4" },
      ],
    },
    { completedRequestKeys: ["MTRKR4448|01|U"] },
    3,
  );
  assert.equal(plan.artifactKind, "tago-schedule-collection-plan");
  assert.equal(plan.dailyLimit, 3);
  assert.equal(plan.totalRequestCount, 12);
  assert.equal(plan.completedRequestCount, 1);
  assert.deepEqual(
    plan.batches.map((batch) => batch.requests.length),
    [3, 3, 3, 2],
  );
  assert.equal(plan.batches[0].requests[0].requestKey, "MTRKR4448|01|D");
  assert.ok(plan.batches.every((batch) => batch.requests.length <= 3));
});

test("TAGO 시간표 수집 plan은 파일럿 매핑 대상이 아닌 lineId를 거부한다", () => {
  assert.throws(
    () =>
      buildTagoScheduleCollectionPlan({
        stationLineRows: [{ stationCode: "113", lineId: "busan-1" }],
      }),
    /Unsupported lineId for pilot mapping: busan-1/,
  );
});

test("TAGO 시간표 수집 plan CLI는 checkpoint와 output을 적용한다", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tago-plan-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const inputPath = path.join(dir, "input.json");
  const checkpointPath = path.join(dir, "checkpoint.json");
  const outputPath = path.join(dir, "plan.json");
  await writeFile(
    inputPath,
    `${JSON.stringify({
      stationLineRows: [{ stationCode: "448", lineId: "seoul-4" }],
    })}\n`,
  );
  await writeFile(checkpointPath, `${JSON.stringify({ completedRequestKeys: ["MTRKR4448|01|U"] })}\n`);

  await execFileAsync(
    process.execPath,
    [
      tagoScheduleToolPath,
      "--plan",
      "--input",
      inputPath,
      "--checkpoint",
      checkpointPath,
      "--daily-limit",
      "2",
      "--output",
      outputPath,
    ],
    { timeout: 10_000 },
  );

  const plan = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(plan.dailyLimit, 2);
  assert.equal(plan.totalRequestCount, 6);
  assert.equal(plan.completedRequestCount, 1);
  assert.deepEqual(
    plan.batches.map((batch) => batch.requests.length),
    [2, 2, 1],
  );
});

test("TAGO 시간표 수집 summary는 완료 checkpoint와 evidence hash를 남긴다", () => {
  const summary = buildTagoScheduleCollectionSummary({
    responses: [
      {
        requestKey: "MTRKR4448|01|U",
        rawText: tagoResponse("MTRKR4448", "01", "U"),
      },
    ],
  });

  assert.equal(summary.artifactKind, "tago-schedule-collection-summary");
  assert.deepEqual(summary.completedRequestKeys, ["MTRKR4448|01|U"]);
  assert.deepEqual(summary.checkpoint, { completedRequestKeys: ["MTRKR4448|01|U"] });
  assert.equal(summary.rowCount, 2);
  assert.equal(summary.providerRecordHashes.length, 2);
  assert.match(summary.rawSha256ByRequest["MTRKR4448|01|U"], /^[0-9a-f]{64}$/);
  assert.match(summary.evidenceHash, /^[0-9a-f]{64}$/);
  assert.equal(summary.productionUseAllowed, false);
});

test("TAGO 시간표 수집 summary는 requestKey와 raw 응답 불일치를 거부한다", () => {
  assert.throws(
    () =>
      buildTagoScheduleCollectionSummary({
        responses: [
          {
            requestKey: "MTRKR4448|01|D",
            rawText: tagoResponse("MTRKR4448", "01", "U"),
          },
        ],
      }),
    /response does not match requestKey: MTRKR4448\|01\|D/,
  );
});

test("TAGO 시간표 수집 summary는 중복 또는 malformed requestKey를 거부한다", () => {
  assert.throws(
    () =>
      buildTagoScheduleCollectionSummary({
        responses: [
          { requestKey: "MTRKR4448|01|U", rawText: tagoResponse("MTRKR4448", "01", "U") },
          { requestKey: "MTRKR4448|01|U", rawText: tagoResponse("MTRKR4448", "01", "U") },
        ],
      }),
    /duplicate requestKey: MTRKR4448\|01\|U/,
  );
  assert.throws(
    () =>
      buildTagoScheduleCollectionSummary({
        responses: [
          {
            requestKey: "MTRKR4448|01|U|retry",
            rawText: tagoResponse("MTRKR4448", "01", "U"),
          },
        ],
      }),
    /response does not match requestKey: MTRKR4448\|01\|U\|retry/,
  );
});

test("TAGO 시간표 수집 summary CLI는 rawPath 목록에서 checkpoint summary를 생성한다", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tago-summary-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const rawPath = path.join(dir, "response.json");
  const inputPath = path.join(dir, "collection.json");
  const outputPath = path.join(dir, "summary.json");
  await writeFile(rawPath, `${tagoResponse("MTRKR4448", "01", "U")}\n`);
  await writeFile(
    inputPath,
    `${JSON.stringify({
      responses: [{ requestKey: "MTRKR4448|01|U", rawPath: path.basename(rawPath) }],
    })}\n`,
  );

  await execFileAsync(
    process.execPath,
    [tagoScheduleToolPath, "--summary", "--input", inputPath, "--output", outputPath],
    { timeout: 10_000 },
  );

  const summary = JSON.parse(await readFile(outputPath, "utf8"));
  assert.deepEqual(summary.checkpoint, { completedRequestKeys: ["MTRKR4448|01|U"] });
  assert.equal(summary.rowCount, 2);
});

function tagoResponse(stationId, dailyTypeCode, upDownTypeCode) {
  return JSON.stringify({
    response: {
      header: { resultCode: "00" },
      body: {
        items: {
          item: [
            tagoRow(stationId, dailyTypeCode, upDownTypeCode, "051000", "051500"),
            tagoRow(stationId, dailyTypeCode, upDownTypeCode, "052000", "052500"),
          ],
        },
      },
    },
  });
}

function tagoRow(stationId, dailyTypeCode, upDownTypeCode, arrTime, depTime) {
  return {
    subwayRouteId: "MTRKR4",
    subwayStationId: stationId,
    subwayStationNm: "상록수",
    dailyTypeCode,
    upDownTypeCode,
    arrTime,
    depTime,
    endSubwayStationNm: "당고개",
    endSubwayStationId: "MTRKR409",
  };
}
