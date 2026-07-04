import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { buildTagoScheduleCollectionPlan } from "./validate-tago-schedule-sample.mjs";

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
