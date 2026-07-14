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
  collectTagoStationDiscovery,
  collectTagoSchedules,
  validateTagoScheduleSample,
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
  assert.equal(plan.stationCount, 2);
  assert.equal(plan.totalRequestCount, 12);
  assert.equal(plan.completedRequestCount, 1);
  assert.deepEqual(
    plan.batches.map((batch) => batch.requests.length),
    [3, 3, 3, 2],
  );
  assert.equal(plan.batches[0].requests[0].requestKey, "MTRKR4448|01|D");
  assert.ok(plan.batches.every((batch) => batch.requests.length <= 3));
});

test("TAGO 시간표 수집 plan은 명시된 providerStationId를 formula보다 우선한다", () => {
  const plan = buildTagoScheduleCollectionPlan(
    {
      stationLineRows: [{ stationCode: "433", lineId: "seoul-4", providerStationId: "MTRS14433" }],
    },
    { completedRequestKeys: [] },
    12,
  );
  assert.equal(plan.stationCount, 1);
  assert.ok(
    plan.batches.every((batch) => batch.requests.every((request) => request.requestKey.startsWith("MTRS14433|"))),
    "plan은 discovery로 확인된 providerStationId(MTRS14433)를 써야 한다",
  );
  assert.ok(
    !plan.batches.some((batch) => batch.requests.some((request) => request.requestKey.startsWith("MTRKR4433"))),
    "formula로 만든 잘못된 MTRKR4433을 쓰면 안 된다",
  );
});

test("TAGO 시간표 수집 plan은 providerStationId 없으면 seoul-4 formula로 폴백한다", () => {
  const plan = buildTagoScheduleCollectionPlan(
    { stationLineRows: [{ stationCode: "448", lineId: "seoul-4" }] },
    { completedRequestKeys: [] },
    12,
  );
  assert.ok(
    plan.batches.every((batch) => batch.requests.every((request) => request.requestKey.startsWith("MTRKR4448|"))),
    "providerStationId 없으면 seoul-4 formula(MTRKR4448)로 폴백해야 한다",
  );
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
  const outputPath = path.join(dir, "nested", "plan.json");
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

test("TAGO 시간표 수집 plan CLI는 quiet 모드에서 stdout을 비운다", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tago-plan-quiet-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const inputPath = path.join(dir, "input.json");
  const outputPath = path.join(dir, "plan.json");
  await writeFile(
    inputPath,
    `${JSON.stringify({
      stationLineRows: [{ stationCode: "448", lineId: "seoul-4" }],
    })}\n`,
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [tagoScheduleToolPath, "--plan", "--quiet", "--input", inputPath, "--output", outputPath],
    { timeout: 10_000 },
  );

  assert.equal(stdout, "");
  const plan = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(plan.totalRequestCount, 6);
});

test("TAGO station discovery는 역명 query별 provider 후보를 secret 없이 남긴다", async () => {
  const fetchUrls = [];
  const discovery = await collectTagoStationDiscovery(
    {
      stationLineRows: [
        { stationNameKo: "상록수" },
        { stationNameKo: "사당" },
        { stationNameKo: "사당" },
      ],
    },
    {
      serviceKey: "actual-secret-key",
      serviceKeyEnv: "DATA_GO_KR_SERVICE_KEY",
      discoveredAt: "2026-07-05T00:00:00.000Z",
      fetchImpl: async (url) => {
        fetchUrls.push(url);
        const params = new URL(url).searchParams;
        return {
          ok: true,
          status: 200,
          async text() {
            return tagoStationDiscoveryResponse(params.get("subwayStationName"));
          },
        };
      },
    },
  );

  assert.equal(discovery.artifactKind, "tago-station-discovery");
  assert.equal(discovery.queryCount, 2);
  assert.equal(discovery.quotaObservedRequestCount, 2);
  assert.deepEqual(
    discovery.queries.map((query) => query.stationNameKo),
    ["상록수", "사당"],
  );
  assert.equal(discovery.queries[0].candidates[0].subwayStationId, "MTRKR4448");
  assert.equal(discovery.queries[1].candidates[0].subwayStationId, "MTRKR433");
  assert.equal(new URL(fetchUrls[0]).searchParams.get("serviceKey"), "actual-secret-key");
  assert.doesNotMatch(JSON.stringify(discovery), /actual-secret-key|serviceKey=/);
});

test("TAGO station discovery 실패는 partial artifact에 quota와 성공 query를 보존한다", async () => {
  await assert.rejects(
    async () =>
      collectTagoStationDiscovery(
        {
          stationLineRows: [{ stationNameKo: "상록수" }, { stationNameKo: "사당" }],
        },
        {
          serviceKey: "actual-secret-key",
          serviceKeyEnv: "DATA_GO_KR_SERVICE_KEY",
          discoveredAt: "2026-07-05T00:00:00.000Z",
          fetchImpl: async (url) => {
            const stationNameKo = new URL(url).searchParams.get("subwayStationName");
            if (stationNameKo === "사당") {
              return {
                ok: false,
                status: 503,
                async text() {
                  return "";
                },
              };
            }
            return {
              ok: true,
              status: 200,
              async text() {
                return tagoStationDiscoveryResponse(stationNameKo);
              },
            };
          },
        },
      ),
    (error) => {
      assert.equal(error.name, "TagoStationDiscoveryError");
      assert.equal(error.collection.collectionStatus, "partial_failed");
      assert.equal(error.collection.failedStationNameKo, "사당");
      assert.equal(error.collection.quotaObservedRequestCount, 2);
      assert.deepEqual(
        error.collection.queries.map((query) => query.stationNameKo),
        ["상록수"],
      );
      assert.doesNotMatch(JSON.stringify(error.collection), /actual-secret-key|serviceKey=/);
      return true;
    },
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
  assert.equal(summary.scheduleRows.length, 2);
  assert.equal(summary.scheduleRows[0].subwayStationId, "MTRKR4448");
  assert.equal(summary.scheduleRows[0].depTime, "051500");
  assert.doesNotMatch(JSON.stringify(summary.scheduleRows), /rawText|serviceKey|actual-secret-key/);
});

test("TAGO 시간표 검증은 provider row order에 의존하지 않는다", () => {
  const validation = validateTagoScheduleSample(
    tagoResponse("MTRKR4448", "01", "U", [
      ["052000", "052500"],
      ["051000", "051500"],
    ]),
  );

  assert.deepEqual(
    validation.departures.map((departure) => departure.departureSeconds),
    [18_900, 19_500],
  );
});

test("TAGO 시간표 검증은 arrTime이 '0'(서울교통공사 미제공)이면 도착=출발로 처리한다", () => {
  const validation = validateTagoScheduleSample(
    tagoResponse("MTRS14433", "01", "U", [
      ["0", "051500"],
      ["0", "052500"],
    ]),
  );

  assert.deepEqual(
    validation.departures.map((departure) => departure.departureSeconds),
    [18_900, 19_500],
  );
  assert.deepEqual(
    validation.departures.map((departure) => departure.arrivalSeconds),
    [18_900, 19_500],
  );
});

test("TAGO 시간표 검증은 depTime이 '0'(종착 열차)이면 출발=도착으로 처리한다", () => {
  const validation = validateTagoScheduleSample(
    tagoResponse("MTRS14433", "01", "U", [
      ["051000", "0"],
      ["052000", "0"],
    ]),
  );

  assert.deepEqual(
    validation.departures.map((departure) => departure.arrivalSeconds),
    [18_600, 19_200],
  );
  assert.deepEqual(
    validation.departures.map((departure) => departure.departureSeconds),
    [18_600, 19_200],
  );
});

test("TAGO 시간표 검증은 arrTime과 depTime이 모두 '0'이면 거부한다", () => {
  assert.throws(
    () => validateTagoScheduleSample(tagoResponse("MTRS14433", "01", "U", [["0", "0"]])),
    /has neither arrTime nor depTime/,
  );
});

test("TAGO 시간표 검증은 같은 시간 row도 deterministic하게 정렬한다", () => {
  const first = validateTagoScheduleSample(
    tagoResponse("MTRKR4448", "01", "U", [
      ["051000", "051500", "MTRKR410"],
      ["051000", "051500", "MTRKR409"],
    ]),
  );
  const second = validateTagoScheduleSample(
    tagoResponse("MTRKR4448", "01", "U", [
      ["051000", "051500", "MTRKR409"],
      ["051000", "051500", "MTRKR410"],
    ]),
  );

  assert.deepEqual(first.providerRecordHashes, second.providerRecordHashes);
});

test("TAGO 시간표 단독 검증은 빈 provider 응답을 거부한다", () => {
  assert.throws(
    () => validateTagoScheduleSample(emptyTagoResponse()),
    /TAGO schedule sample has no rows/,
  );
});

test("TAGO 시간표 수집 summary는 빈 provider 응답을 완료 요청으로 기록한다", () => {
  const summary = buildTagoScheduleCollectionSummary({
    responses: [
      {
        requestKey: "MTRKR4448|02|U",
        rawText: emptyTagoResponse(),
      },
    ],
  });

  assert.deepEqual(summary.completedRequestKeys, ["MTRKR4448|02|U"]);
  assert.deepEqual(summary.responseRequestKeys, ["MTRKR4448|02|U"]);
  assert.deepEqual(summary.emptyResponseRequestKeys, ["MTRKR4448|02|U"]);
  assert.equal(summary.responseCount, 1);
  assert.equal(summary.rowCount, 0);
  assert.deepEqual(summary.providerRecordHashes, []);
  assert.match(summary.rawSha256ByRequest["MTRKR4448|02|U"], /^[0-9a-f]{64}$/);
});

test("TAGO 시간표 수집 summary는 malformed 빈 응답을 checkpoint 완료로 보지 않는다", () => {
  for (const rawText of [
    JSON.stringify({}),
    JSON.stringify({ response: { body: { items: {} } } }),
    JSON.stringify({ response: { header: { resultCode: "00" }, body: {} } }),
  ]) {
    assert.throws(
      () =>
        buildTagoScheduleCollectionSummary({
          responses: [
            {
              requestKey: "MTRKR4448|02|U",
              rawText,
            },
          ],
        }),
      /TAGO schedule empty response shape is invalid/,
    );
  }
});

test("TAGO 시간표 수집 summary evidence hash는 checkpoint 상태를 포함한다", () => {
  const response = {
    requestKey: "MTRKR4448|02|U",
    rawText: tagoResponse("MTRKR4448", "02", "U"),
  };
  const baseSummary = buildTagoScheduleCollectionSummary({
    checkpoint: { completedRequestKeys: ["MTRKR4448|01|U"] },
    responses: [response],
  });
  const editedCheckpointSummary = buildTagoScheduleCollectionSummary({
    checkpoint: { completedRequestKeys: ["MTRKR4448|01|D"] },
    responses: [response],
  });

  assert.notEqual(baseSummary.evidenceHash, editedCheckpointSummary.evidenceHash);
});

test("TAGO 시간표 수집 summary는 완료 checkpoint no-op을 허용한다", () => {
  const summary = buildTagoScheduleCollectionSummary({
    checkpoint: { completedRequestKeys: ["MTRKR4448|01|U"] },
    responses: [],
  });

  assert.equal(summary.responseCount, 0);
  assert.equal(summary.rowCount, 0);
  assert.deepEqual(summary.completedRequestKeys, ["MTRKR4448|01|U"]);
});

test("TAGO 시간표 수집 summary는 응답과 checkpoint가 모두 없으면 거부한다", () => {
  assert.throws(
    () =>
      buildTagoScheduleCollectionSummary({
        responses: [],
      }),
    /responses must be non-empty unless checkpoint has completedRequestKeys/,
  );
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

test("TAGO 시간표 수집기는 checkpoint 다음 batch만 호출하고 secret을 출력하지 않는다", async () => {
  const fetchUrls = [];
  const collection = await collectTagoSchedules(
    {
      stationLineRows: [
        { stationCode: "448", lineId: "seoul-4" },
        { stationCode: "433", lineId: "seoul-4" },
      ],
    },
    {
      checkpoint: { completedRequestKeys: ["MTRKR4448|01|U"] },
      dailyLimit: 2,
      serviceKey: "actual-secret-key",
      serviceKeyEnv: "DATA_GO_KR_SERVICE_KEY",
      collectedAt: "2026-07-05T00:00:00.000Z",
      fetchImpl: async (url) => {
        fetchUrls.push(url);
        const params = new URL(url).searchParams;
        return {
          ok: true,
          status: 200,
          async text() {
            return tagoResponse(
              params.get("subwayStationId"),
              params.get("dailyTypeCode"),
              params.get("upDownTypeCode"),
            );
          },
        };
      },
    },
  );

  assert.equal(collection.artifactKind, "tago-schedule-collection");
  assert.equal(collection.requestedCount, 2);
  assert.equal(collection.pendingRequestCount, 9);
  assert.equal(collection.collectionStatus, "completed_batch");
  assert.deepEqual(collection.collectionReport, {
    stationCount: 2,
    totalCallCount: 12,
    attemptedCallCount: 2,
    successfulCallCount: 2,
    failedCallCount: 0,
    retryCount: 0,
    quotaObservedRequestCount: 2,
    quotaDailyLimit: 2,
  });
  assert.deepEqual(
    collection.responses.map((response) => response.requestKey),
    ["MTRKR4448|01|D", "MTRKR4448|02|U"],
  );
  assert.deepEqual(collection.checkpoint.completedRequestKeys, [
    "MTRKR4448|01|D",
    "MTRKR4448|01|U",
    "MTRKR4448|02|U",
  ]);
  assert.deepEqual(collection.completedRequestKeys, collection.checkpoint.completedRequestKeys);
  assert.equal(new URL(fetchUrls[0]).searchParams.get("serviceKey"), "actual-secret-key");
  assert.doesNotMatch(JSON.stringify(collection), /actual-secret-key/);

  const resumedPlan = buildTagoScheduleCollectionPlan(
    {
      stationLineRows: [
        { stationCode: "448", lineId: "seoul-4" },
        { stationCode: "433", lineId: "seoul-4" },
      ],
    },
    collection,
    2,
  );
  assert.equal(resumedPlan.completedRequestCount, 3);
  assert.equal(resumedPlan.pendingRequestCount, 9);
  assert.equal(resumedPlan.batches[0].requests[0].requestKey, "MTRKR4448|02|D");

  const summary = buildTagoScheduleCollectionSummary(collection);
  assert.deepEqual(summary.completedRequestKeys, collection.checkpoint.completedRequestKeys);
  assert.deepEqual(
    summary.responseRequestKeys,
    collection.responses.map((response) => response.requestKey),
  );
  assert.equal(summary.responseCount, collection.responses.length);
  assert.deepEqual(summary.checkpoint.completedRequestKeys, collection.checkpoint.completedRequestKeys);
});

test("TAGO 시간표 수집기는 빈 provider 응답을 checkpoint에 포함하고 계속 진행한다", async () => {
  const collection = await collectTagoSchedules(
    {
      stationLineRows: [{ stationCode: "448", lineId: "seoul-4" }],
    },
    {
      dailyLimit: 3,
      serviceKey: "actual-secret-key",
      fetchImpl: async (url) => {
        const params = new URL(url).searchParams;
        return {
          ok: true,
          status: 200,
          async text() {
            if (params.get("dailyTypeCode") === "02" && params.get("upDownTypeCode") === "U") {
              return emptyTagoResponse();
            }
            return tagoResponse(
              params.get("subwayStationId"),
              params.get("dailyTypeCode"),
              params.get("upDownTypeCode"),
            );
          },
        };
      },
    },
  );

  assert.equal(collection.collectionStatus, "completed_batch");
  assert.deepEqual(collection.completedRequestKeys, ["MTRKR4448|01|D", "MTRKR4448|01|U", "MTRKR4448|02|U"]);
  assert.deepEqual(
    collection.responses.map((response) => response.requestKey),
    ["MTRKR4448|01|U", "MTRKR4448|01|D", "MTRKR4448|02|U"],
  );

  const summary = buildTagoScheduleCollectionSummary(collection);
  assert.deepEqual(summary.emptyResponseRequestKeys, ["MTRKR4448|02|U"]);
  assert.equal(summary.responseCount, 3);
  assert.equal(summary.rowCount, 4);
});

test("TAGO 시간표 수집기는 encoded service key를 이중 인코딩하지 않는다", async () => {
  const fetchUrls = [];
  await collectTagoSchedules(
    {
      stationLineRows: [{ stationCode: "448", lineId: "seoul-4" }],
    },
    {
      dailyLimit: 1,
      serviceKey: "encoded%2Bkey%3D",
      fetchImpl: async (url) => {
        fetchUrls.push(url);
        const params = new URL(url).searchParams;
        return {
          ok: true,
          status: 200,
          async text() {
            return tagoResponse(
              params.get("subwayStationId"),
              params.get("dailyTypeCode"),
              params.get("upDownTypeCode"),
            );
          },
        };
      },
    },
  );

  assert.match(fetchUrls[0], /serviceKey=encoded%2Bkey%3D/);
  assert.doesNotMatch(fetchUrls[0], /%252B|%253D/);
});

test("TAGO 시간표 수집기는 decoded service key를 URL 인코딩한다", async () => {
  const fetchUrls = [];
  await collectTagoSchedules(
    {
      stationLineRows: [{ stationCode: "448", lineId: "seoul-4" }],
    },
    {
      dailyLimit: 1,
      serviceKey: "decoded+key=",
      fetchImpl: async (url) => {
        fetchUrls.push(url);
        const params = new URL(url).searchParams;
        return {
          ok: true,
          status: 200,
          async text() {
            return tagoResponse(
              params.get("subwayStationId"),
              params.get("dailyTypeCode"),
              params.get("upDownTypeCode"),
            );
          },
        };
      },
    },
  );

  assert.match(fetchUrls[0], /serviceKey=decoded%2Bkey%3D/);
});

test("TAGO 시간표 수집기는 batch 중간 실패 시 성공분 checkpoint를 보존한다", async () => {
  await assert.rejects(
    () =>
      collectTagoSchedules(
        {
          stationLineRows: [
            { stationCode: "448", lineId: "seoul-4" },
            { stationCode: "433", lineId: "seoul-4" },
          ],
        },
        {
          checkpoint: { completedRequestKeys: ["MTRKR4448|01|U"] },
          dailyLimit: 3,
          serviceKey: "actual-secret-key",
          fetchImpl: async (url) => {
            const params = new URL(url).searchParams;
            if (params.get("upDownTypeCode") === "U" && params.get("dailyTypeCode") === "02") {
              throw new Error("provider timeout");
            }
            return {
              ok: true,
              status: 200,
              async text() {
                return tagoResponse(
                  params.get("subwayStationId"),
                  params.get("dailyTypeCode"),
                  params.get("upDownTypeCode"),
                );
              },
            };
          },
        },
      ),
    (error) => {
      assert.equal(error.name, "TagoScheduleCollectionError");
      assert.equal(error.message, "TAGO schedule fetch failed before response: MTRKR4448|02|U");
      assert.equal(error.collection.collectionStatus, "partial_failed");
      assert.equal(error.collection.failedRequestKey, "MTRKR4448|02|U");
      assert.equal(error.collection.collectionReport.failedCallCount, 1);
      assert.equal(error.collection.collectionReport.quotaObservedRequestCount, 2);
      assert.deepEqual(error.collection.completedRequestKeys, ["MTRKR4448|01|D", "MTRKR4448|01|U"]);
      assert.deepEqual(
        error.collection.responses.map((response) => response.requestKey),
        ["MTRKR4448|01|D"],
      );
      assert.doesNotMatch(JSON.stringify(error.collection), /actual-secret-key/);
      return true;
    },
  );
});

test("TAGO 시간표 수집기는 body read 실패 시 성공분 checkpoint를 보존한다", async () => {
  await assert.rejects(
    () =>
      collectTagoSchedules(
        {
          stationLineRows: [
            { stationCode: "448", lineId: "seoul-4" },
            { stationCode: "433", lineId: "seoul-4" },
          ],
        },
        {
          checkpoint: { completedRequestKeys: ["MTRKR4448|01|U"] },
          dailyLimit: 3,
          serviceKey: "actual-secret-key",
          fetchImpl: async (url) => {
            const params = new URL(url).searchParams;
            return {
              ok: true,
              status: 200,
              async text() {
                if (params.get("upDownTypeCode") === "U" && params.get("dailyTypeCode") === "02") {
                  throw new Error("connection dropped");
                }
                return tagoResponse(
                  params.get("subwayStationId"),
                  params.get("dailyTypeCode"),
                  params.get("upDownTypeCode"),
                );
              },
            };
          },
        },
      ),
    (error) => {
      assert.equal(error.name, "TagoScheduleCollectionError");
      assert.equal(error.message, "TAGO schedule response read failed: MTRKR4448|02|U");
      assert.equal(error.collection.collectionStatus, "partial_failed");
      assert.deepEqual(error.collection.completedRequestKeys, ["MTRKR4448|01|D", "MTRKR4448|01|U"]);
      assert.deepEqual(
        error.collection.responses.map((response) => response.requestKey),
        ["MTRKR4448|01|D"],
      );
      return true;
    },
  );
});

test("TAGO 시간표 수집기는 service key가 없으면 provider 호출 전에 실패한다", async () => {
  await assert.rejects(
    () =>
      collectTagoSchedules(
        { stationLineRows: [{ stationCode: "448", lineId: "seoul-4" }] },
        {
          serviceKey: undefined,
          fetchImpl: async () => {
            throw new Error("must not fetch");
          },
        },
      ),
    /serviceKey is required/,
  );
});

function tagoResponse(
  stationId,
  dailyTypeCode,
  upDownTypeCode,
  times = [
    ["051000", "051500"],
    ["052000", "052500"],
  ],
) {
  return JSON.stringify({
    response: {
      header: { resultCode: "00" },
      body: {
        items: {
          item: times.map(([arrTime, depTime, endSubwayStationId]) =>
            tagoRow(stationId, dailyTypeCode, upDownTypeCode, arrTime, depTime, endSubwayStationId),
          ),
        },
      },
    },
  });
}

function emptyTagoResponse() {
  return JSON.stringify({
    response: {
      header: { resultCode: "00" },
      body: {
        items: {},
      },
    },
  });
}

function tagoStationDiscoveryResponse(stationNameKo) {
  const id = stationNameKo === "상록수" ? "MTRKR4448" : "MTRKR433";
  return JSON.stringify({
    response: {
      header: { resultCode: "00" },
      body: {
        items: {
          item: [
            {
              subwayStationId: id,
              subwayStationNm: stationNameKo,
              subwayRouteId: "MTRKR4",
            },
          ],
        },
      },
    },
  });
}

function tagoRow(stationId, dailyTypeCode, upDownTypeCode, arrTime, depTime, endSubwayStationId = "MTRKR409") {
  return {
    subwayRouteId: "MTRKR4",
    subwayStationId: stationId,
    subwayStationNm: "상록수",
    dailyTypeCode,
    upDownTypeCode,
    arrTime,
    depTime,
    endSubwayStationNm: "당고개",
    endSubwayStationId,
  };
}
