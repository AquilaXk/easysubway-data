import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  assertCompleteKricCollection,
  assertCompleteSaturdayNoData,
  buildCollectionContext,
  buildCollectionTimestamps,
  buildOperationTrainDiagnosticArtifact,
  buildReconstructionAnomalyDiagnosticArtifact,
  buildTimetableNoDataObservation,
  buildTrainDiagnosticArtifact,
  classifyKricRowsForReconstruction,
  classifyKricTimetablePayload,
  buildRawCollectionInventory,
  buildRawResponseRecord,
  buildServicePatternObservation,
  filterRowsByTrainNumbers,
  fetchWithRetry,
  redactKricCredential,
  selectServicePatternProbeRequest,
  summarizeOperationTrainDiagnosticArtifact,
  summarizeTrainDiagnosticArtifact,
  validateServicePatternEvidence,
  validateTimetableNoDataEvidence,
  validateItxOdJoin,
  validateKricTimetablePayload,
} from "./collect-kric-line4-timetables.mjs";
import { normalizeKricSubwayTimetable } from "./normalize-kric-timetable.mjs";
import { reconstructTransitTrips } from "./reconstruct-transit-trips.mjs";

const ROSTER = {
  lnCd: "4",
  stations: [
    { stinConsOrdr: 28, stinCd: "433", railOprIsttCd: "S1", stinNm: "사당" },
    { stinConsOrdr: 29, stinCd: "434", railOprIsttCd: "S1", stinNm: "남태령" },
    { stinConsOrdr: 43, stinCd: "448", railOprIsttCd: "KR", stinNm: "상록수" },
  ],
};
const SERVICE_PATTERN_MAPPING = { LOCAL: "LOCAL", EXPRESS: "EXPRESS" };
const SERVICE_PATTERN_EVIDENCE_PATH = new URL(
  "./kric-subway-timetable-service-pattern-evidence.json",
  import.meta.url,
);
const NO_DATA_EVIDENCE_PATH = new URL(
  "./kric-subway-timetable-no-data-evidence.json",
  import.meta.url,
);

test("service-pattern evidence probe는 exact KRIC 응답의 exptCd domain만 결정적으로 기록한다", () => {
  const rawResponse = JSON.stringify({
    header: { resultCode: "00" },
    body: [
      { trnNo: "4719", exptCd: null },
      { trnNo: "4720", exptCd: "1" },
      { trnNo: "4721", exptCd: null },
    ],
  });
  const request = {
    operation: "subwayTimetableExp",
    requestKey: "subwayTimetableExp|S1|433|8",
    params: { railOprIsttCd: "S1", dayCd: "8", lnCd: "4", stinCd: "433" },
  };
  const rows = JSON.parse(rawResponse).body;

  assert.deepEqual(buildServicePatternObservation(request, rawResponse, rows), {
    schemaVersion: 1,
    artifactKind: "kric-subway-timetable-service-pattern-observation",
    sourceId: "kric-subway-timetable",
    operation: "subwayTimetableExp",
    request: {
      requestKey: "subwayTimetableExp|S1|433|8",
      railOprIsttCd: "S1",
      dayCd: "8",
      lnCd: "4",
      stinCd: "433",
    },
    response: {
      rawSha256: createHash("sha256").update(rawResponse).digest("hex"),
      rowCount: 3,
      observedExptCd: [
        { value: null, count: 2 },
        { value: "1", count: 1 },
      ],
    },
  });
  assert.throws(
    () => buildServicePatternObservation(request, rawResponse, []),
    /probe response rows must be non-empty/,
  );
  assert.throws(
    () => buildServicePatternObservation(request, rawResponse, [{ trnNo: "4719" }]),
    /probe response row exptCd is required/,
  );
  assert.throws(
    () => buildServicePatternObservation(
      { ...request, operation: "subwayTimetable" },
      rawResponse,
      rows,
    ),
    /probe requires subwayTimetableExp/,
  );
  assert.deepEqual(
    selectServicePatternProbeRequest({ requests: [request] }, request.requestKey),
    request,
  );
  assert.throws(
    () => selectServicePatternProbeRequest({ requests: [request] }, "subwayTimetableExp|S1|999|8"),
    /must match exactly one tracked request/,
  );
});

test("tracked service-pattern evidence는 exact probe identity와 closed mapping을 결속한다", async () => {
  const evidence = JSON.parse(await readFile(SERVICE_PATTERN_EVIDENCE_PATH, "utf8"));
  const mapping = validateServicePatternEvidence(evidence);
  assert.deepEqual([...mapping.entries()], [[null, "LOCAL"], ["1", "EXPRESS"]]);

  assert.throws(
    () => validateServicePatternEvidence({
      ...evidence,
      probe: { ...evidence.probe, rawSha256: "0".repeat(64) },
    }),
    /probe identity/,
  );
  assert.throws(
    () => validateServicePatternEvidence({
      ...evidence,
      mapping: [...evidence.mapping, { exptCd: "0", servicePattern: "LOCAL" }],
    }),
    /closed mapping/,
  );
});

test("raw response inventory는 tracked request 순서와 exact provider bytes만 결속한다", () => {
  const requests = [
    { requestKey: "subwayTimetableExp|S1|433|8", endpoint: "https://provider.invalid/first" },
    { requestKey: "subwayTimetableExp|KR|448|8", endpoint: "https://provider.invalid/second" },
  ];
  const rawBodies = [
    '{"header":{"resultCode":"00"},"body":[{"exptCd":null}]}',
    '{"header":{"resultCode":"00"},"body":[{"exptCd":"1"}]}',
  ];
  const records = requests.map((request, index) => buildRawResponseRecord(request, rawBodies[index]));
  const inventory = buildRawCollectionInventory({ requests }, records);
  assert.equal(inventory.responseCount, 2);
  assert.match(inventory.inventorySha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(inventory.responses, records);
  assert.equal(Buffer.from(records[0].bodyBase64, "base64").toString("utf8"), rawBodies[0]);
  assert.doesNotMatch(JSON.stringify(inventory), /provider\.invalid|serviceKey/);

  assert.throws(
    () => buildRawCollectionInventory({ requests }, records.toReversed()),
    /request order/,
  );
  assert.throws(
    () => buildRawCollectionInventory({ requests }, [
      { ...records[0], rawSha256: "0".repeat(64) },
      records[1],
    ]),
    /raw response identity/,
  );
});

test("collection time은 성공 완료 뒤 한 UTC instant에서 파생한다", () => {
  assert.deepEqual(buildCollectionTimestamps(new Date("2026-08-09T10:45:12.345Z")), {
    collectedAt: "2026-08-09T10:45:12.345Z",
    capturedAt: "2026-08-09",
  });
  assert.throws(() => buildCollectionTimestamps(new Date(Number.NaN)), /collection clock/);
});

test("dayCd=7 no-data probe는 exact provider code/message/body shape만 기록한다", () => {
  const request = {
    operation: "subwayTimetableExp",
    requestKey: "subwayTimetableExp|S1|433|7",
    params: { railOprIsttCd: "S1", dayCd: "7", lnCd: "4", stinCd: "433" },
  };
  const rawResponse = JSON.stringify({
    header: { resultCode: "03", resultMsg: "데이터가 없습니다." },
  });
  assert.deepEqual(buildTimetableNoDataObservation(
    request,
    rawResponse,
    JSON.parse(rawResponse),
  ), {
    schemaVersion: 1,
    artifactKind: "kric-subway-timetable-no-data-observation",
    sourceId: "kric-subway-timetable",
    operation: "subwayTimetableExp",
    request: {
      requestKey: "subwayTimetableExp|S1|433|7",
      railOprIsttCd: "S1",
      dayCd: "7",
      lnCd: "4",
      stinCd: "433",
    },
    response: {
      rawSha256: createHash("sha256").update(rawResponse).digest("hex"),
      resultCode: "03",
      resultMsg: "데이터가 없습니다.",
      bodyRowCount: 0,
    },
  });
  assert.throws(
    () => buildTimetableNoDataObservation(
      { ...request, params: { ...request.params, dayCd: "8" } },
      rawResponse,
      JSON.parse(rawResponse),
    ),
    /dayCd=7/,
  );
  assert.throws(
    () => buildTimetableNoDataObservation(request, rawResponse, {
      header: { resultCode: "03", resultMsg: "데이터가 없습니다." },
      body: [{ trnNo: "4719" }],
    }),
    /body must be empty/,
  );
});

test("Saturday no-data evidence는 exact 51-request gap만 닫힌 분류로 허용한다", async () => {
  const evidence = JSON.parse(await readFile(NO_DATA_EVIDENCE_PATH, "utf8"));
  const validated = validateTimetableNoDataEvidence(evidence);
  const saturdayRequest = {
    operation: "subwayTimetableExp",
    requestKey: "subwayTimetableExp|S1|433|7",
    params: { railOprIsttCd: "S1", dayCd: "7", lnCd: "4", stinCd: "433" },
  };
  const noDataPayload = { header: { resultCode: "03", resultMsg: "데이터가 없습니다." } };
  assert.deepEqual(classifyKricTimetablePayload(noDataPayload, saturdayRequest, validated), {
    classification: "EXPECTED_NO_DATA_SATURDAY",
    rows: [],
  });
  assert.throws(
    () => classifyKricTimetablePayload(noDataPayload, {
      ...saturdayRequest,
      requestKey: "subwayTimetableExp|S1|433|8",
      params: { ...saturdayRequest.params, dayCd: "8" },
    }, validated),
    /provider resultCode 03/,
  );
  assert.throws(
    () => validateTimetableNoDataEvidence({
      ...evidence,
      probe: { ...evidence.probe, rawSha256: "0".repeat(64) },
    }),
    /no-data evidence identity/,
  );

  const requests = Array.from({ length: 51 }, (_, index) => ({
    requestKey: `subwayTimetableExp|S1|${433 + index}|7`,
    params: { dayCd: "7" },
  }));
  const perRequest = requests.map(({ requestKey }) => ({
    requestKey,
    classification: "EXPECTED_NO_DATA_SATURDAY",
    resultCode: "03",
    rows: 0,
    normalized: 0,
  }));
  assert.doesNotThrow(() => assertCompleteSaturdayNoData({ requests }, perRequest, validated));
  assert.throws(
    () => assertCompleteSaturdayNoData({ requests }, perRequest.slice(1), validated),
    /complete-set/,
  );
});

test("train diagnostic artifact는 complete request raw identity와 exact train rows만 보존한다", () => {
  const requests = [
    { requestKey: "subwayTimetableExp|S1|433|8" },
    { requestKey: "subwayTimetableExp|S1|434|8" },
  ];
  const rawResponses = requests.map((request, index) => buildRawResponseRecord(
    request,
    JSON.stringify({ header: { resultCode: "00" }, body: [{ trnNo: index === 0 ? "K4422" : "K4500" }] }),
  ));
  const rows = [
    { stationId: "station-a", lineId: "seoul-4", trnNo: "K4422", dayCd: "8", arrivalSeconds: null, departureSeconds: 20_000, stopRole: "ORIGIN", servicePattern: "LOCAL" },
    { stationId: "station-b", lineId: "seoul-4", trnNo: "K4422", dayCd: "8", arrivalSeconds: 20_100, departureSeconds: null, stopRole: "TERMINAL", servicePattern: "LOCAL" },
    { stationId: "station-c", lineId: "seoul-4", trnNo: "K4500", dayCd: "8", arrivalSeconds: 21_000, departureSeconds: 21_010, stopRole: "THROUGH", servicePattern: "LOCAL" },
  ];
  const artifact = buildTrainDiagnosticArtifact({
    lineId: "seoul-4",
    trainNumber: "K4422",
    plan: { requests },
    rawResponses,
    rows,
    timestamps: { collectedAt: "2026-08-09T11:00:00.000Z", capturedAt: "2026-08-09" },
  });
  assert.equal(artifact.artifactKind, "kric-line4-timetable-train-diagnostic");
  assert.equal(artifact.trainNumber, "4422");
  assert.equal(artifact.requestCount, 2);
  assert.deepEqual(artifact.rows.map(({ stationId }) => stationId), ["station-a", "station-b"]);
  assert.equal(artifact.rawResponseInventory.responseCount, 2);
  assert.deepEqual(summarizeTrainDiagnosticArtifact(artifact), {
    artifactKind: "kric-line4-timetable-train-diagnostic-summary",
    sourceId: "kric-subway-timetable",
    lineId: "seoul-4",
    trainNumber: "4422",
    collectedAt: "2026-08-09T11:00:00.000Z",
    rowCount: 2,
    rows: artifact.rows.map((row, rowIndex) => ({
      rowIndex,
      stationId: row.stationId,
      arrivalSeconds: row.arrivalSeconds,
      departureSeconds: row.departureSeconds,
      stopRole: row.stopRole,
      servicePattern: row.servicePattern,
    })),
  });
  assert.throws(
    () => buildTrainDiagnosticArtifact({
      lineId: "seoul-4", trainNumber: "K9999", plan: { requests }, rawResponses, rows,
      timestamps: { collectedAt: "2026-08-09T11:00:00.000Z", capturedAt: "2026-08-09" },
    }),
    /no rows/,
  );
});

test("기본 operation 비교 진단은 K4422 provider station/time과 complete raw identity만 보존한다", () => {
  const requests = [
    {
      operation: "subwayTimetable",
      requestKey: "subwayTimetable|S1|445|8",
      params: { railOprIsttCd: "S1", dayCd: "8", lnCd: "4", stinCd: "445" },
    },
    {
      operation: "subwayTimetable",
      requestKey: "subwayTimetable|S1|446|8",
      params: { railOprIsttCd: "S1", dayCd: "8", lnCd: "4", stinCd: "446" },
    },
  ];
  const rawResponses = requests.map((request) => buildRawResponseRecord(
    request,
    JSON.stringify({ header: { resultCode: "00" }, body: [] }),
  ));
  const providerRows = [
    { railOprIsttCd: "S1", trnNo: "K4422", dayCd: "8", dayNm: "평일", stinCd: "445", lnCd: "4", arvTm: null, dptTm: "070700" },
    { railOprIsttCd: "S1", trnNo: "K4500", dayCd: "8", dayNm: "평일", stinCd: "445", lnCd: "4", arvTm: "071000", dptTm: "071030" },
    { railOprIsttCd: "S1", trnNo: "K4422", dayCd: "8", dayNm: "평일", stinCd: "446", lnCd: "4", arvTm: "070400", dptTm: "070430" },
  ];
  const artifact = buildOperationTrainDiagnosticArtifact({
    operation: "subwayTimetable",
    lineId: "seoul-4",
    trainNumber: "K4422",
    plan: { operation: "subwayTimetable", dayCds: ["8"], requests },
    rawResponses,
    providerRows,
    timestamps: { collectedAt: "2026-08-09T12:00:00.000Z", capturedAt: "2026-08-09" },
  });

  assert.equal(artifact.artifactKind, "kric-line4-timetable-operation-train-diagnostic");
  assert.equal(artifact.operation, "subwayTimetable");
  assert.equal(artifact.trainNumber, "4422");
  assert.equal(artifact.rawResponseInventory.responseCount, 2);
  assert.deepEqual(artifact.rows, [providerRows[0], providerRows[2]]);
  assert.deepEqual(summarizeOperationTrainDiagnosticArtifact(artifact), {
    artifactKind: "kric-line4-timetable-operation-train-diagnostic-summary",
    sourceId: "kric-subway-timetable",
    operation: "subwayTimetable",
    lineId: "seoul-4",
    trainNumber: "4422",
    collectedAt: "2026-08-09T12:00:00.000Z",
    requestCount: 2,
    rowCount: 2,
    rows: [providerRows[0], providerRows[2]],
  });
  assert.throws(
    () => buildOperationTrainDiagnosticArtifact({
      operation: "subwayTimetable",
      lineId: "seoul-4",
      trainNumber: "K4422",
      plan: { operation: "subwayTimetable", dayCds: ["8"], requests },
      rawResponses,
      providerRows: [{ ...providerRows[0], stinCd: "999" }],
      timestamps: { collectedAt: "2026-08-09T12:00:00.000Z", capturedAt: "2026-08-09" },
    }),
    /does not match tracked request/,
  );
});

test("EXPRESS 중간 null-arrival은 시각 추정 없이 non-stop으로 분리한다", () => {
  const origin = { stationId: "station-456", lineId: "seoul-4", trnNo: "K4422", dayCd: "8", arrivalSeconds: null, departureSeconds: 24_120, stopRole: "ORIGIN", servicePattern: "EXPRESS" };
  const through = { stationId: "station-455", lineId: "seoul-4", trnNo: "K4422", dayCd: "8", arrivalSeconds: 24_270, departureSeconds: 24_300, stopRole: "THROUGH", servicePattern: "EXPRESS" };
  const nonStop = { stationId: "station-454", lineId: "seoul-4", trnNo: "K4422", dayCd: "8", arrivalSeconds: null, departureSeconds: 24_420, stopRole: "ORIGIN", servicePattern: "EXPRESS" };
  const terminal = { stationId: "station-409", lineId: "seoul-4", trnNo: "K4422", dayCd: "8", arrivalSeconds: 30_630, departureSeconds: null, stopRole: "TERMINAL", servicePattern: "EXPRESS" };

  const classified = classifyKricRowsForReconstruction([terminal, nonStop, through, origin]);
  assert.deepEqual(classified.rows, [origin, through, terminal]);
  assert.deepEqual(classified.excludedNonStopRows, [{
    stationId: "station-454",
    lineId: "seoul-4",
    trnNo: "K4422",
    dayCd: "8",
    passageSeconds: 24_420,
    servicePattern: "EXPRESS",
    reason: "EXPRESS_NO_ARRIVAL",
  }]);
  assert.throws(
    () => classifyKricRowsForReconstruction([
      { ...origin, trnNo: "K4500", servicePattern: "LOCAL" },
      { ...nonStop, trnNo: "K4500", servicePattern: "LOCAL" },
      { ...terminal, trnNo: "K4500", servicePattern: "LOCAL" },
    ]),
    /LOCAL intermediate row has missing arrival/,
  );
});

test("reconstruction anomaly diagnostic은 approved EXPRESS와 blocking LOCAL 누락을 분리한다", () => {
  const request = { requestKey: "subwayTimetableExp|S1|433|8" };
  const rawResponses = [buildRawResponseRecord(
    request,
    JSON.stringify({ header: { resultCode: "00" }, body: [{ trnNo: "K4422" }] }),
  )];
  const rows = [
    { stationId: "station-k-origin", lineId: "seoul-4", trnNo: "K4422", dayCd: "8", arrivalSeconds: null, departureSeconds: 100, stopRole: "ORIGIN", servicePattern: "EXPRESS" },
    { stationId: "station-k-pass", lineId: "seoul-4", trnNo: "K4422", dayCd: "8", arrivalSeconds: null, departureSeconds: 200, stopRole: "ORIGIN", servicePattern: "EXPRESS" },
    { stationId: "station-k-terminal", lineId: "seoul-4", trnNo: "K4422", dayCd: "8", arrivalSeconds: 300, departureSeconds: null, stopRole: "TERMINAL", servicePattern: "EXPRESS" },
    { stationId: "station-s-origin", lineId: "seoul-4", trnNo: "S4219", dayCd: "8", arrivalSeconds: null, departureSeconds: 400, stopRole: "ORIGIN", servicePattern: "LOCAL" },
    { stationId: "station-s-sadang", lineId: "seoul-4", trnNo: "S4219", dayCd: "8", arrivalSeconds: 500, departureSeconds: null, stopRole: "TERMINAL", servicePattern: "LOCAL" },
    { stationId: "station-s-terminal", lineId: "seoul-4", trnNo: "S4219", dayCd: "8", arrivalSeconds: 600, departureSeconds: null, stopRole: "TERMINAL", servicePattern: "LOCAL" },
  ];
  const artifact = buildReconstructionAnomalyDiagnosticArtifact({
    lineId: "seoul-4",
    plan: { requests: [request] },
    rawResponses,
    rows,
    timestamps: { collectedAt: "2026-08-09T12:00:00.000Z", capturedAt: "2026-08-09" },
  });

  assert.equal(artifact.approvedExpressNonStopCount, 1);
  assert.equal(artifact.blockingAnomalyCount, 1);
  assert.deepEqual(artifact.anomalies.map(({ classification, stationId, missingField }) => ({ classification, stationId, missingField })), [
    { classification: "APPROVED_EXPRESS_NON_STOP", stationId: "station-k-pass", missingField: "arvTm" },
    { classification: "BLOCKING_LOCAL_MISSING_DEPARTURE", stationId: "station-s-sadang", missingField: "dptTm" },
  ]);
});

test("buildCollectionContext는 로스터로 재구성 코어 context를 만든다", () => {
  const ctx = buildCollectionContext(ROSTER, "seoul-4", null, SERVICE_PATTERN_MAPPING);
  assert.equal(ctx.stationIdByProviderStation["S1|4|433"], "station-seoul-4-433");
  assert.equal(ctx.stationIdByProviderStation["KR|4|448"], "station-seoul-4-448");
  assert.equal(ctx.lineIdByProviderLine["S1|4"], "seoul-4");
  assert.equal(ctx.lineIdByProviderLine["KR|4"], "seoul-4");
  assert.equal(ctx.lineSequenceByStationLine["station-seoul-4-433|seoul-4"], 28);
  assert.equal(ctx.routeIdByLineDirection["seoul-4|up"], "route-seoul-4-up");
  assert.equal(ctx.serviceIdByDayCd["8"], "weekday-kric");
});

test("KRIC 응답→context→normalizer→코어가 직결(같은 trnNo)을 온전한 trip으로 잇는다", () => {
  const ctx = buildCollectionContext(ROSTER, "seoul-4", null, SERVICE_PATTERN_MAPPING);
  // 같은 trnNo가 사당(S1 조회)·상록수(KR 조회) 응답에 각각 등장(직결)
  const sadangRows = [{ railOprIsttCd: "S1", trnNo: "4719", dayCd: "8", stinCd: "433", lnCd: "4", arvTm: "084830", dptTm: "084900", exptCd: "LOCAL" }];
  const sangnoksuRows = [{ railOprIsttCd: "KR", trnNo: "4719", dayCd: "8", stinCd: "448", lnCd: "4", arvTm: "092930", dptTm: "093000", exptCd: "LOCAL" }];
  const rows = [
    ...normalizeKricSubwayTimetable(sadangRows, ctx),
    ...normalizeKricSubwayTimetable(sangnoksuRows, ctx),
  ];
  const { transitTrips, transitStopTimes } = reconstructTransitTrips(rows, ctx);
  assert.equal(transitTrips.length, 1);
  assert.equal(transitStopTimes.length, 2); // 사당 + 상록수 한 trip으로 연결
  assert.equal(transitTrips[0].serviceId, "weekday-kric");
});

test("canonical fixture가 있으면 provider의 중복 순번 대신 canonical lineSequence를 사용한다", () => {
  const roster = {
    lnCd: "K2",
    stations: [
      { stinConsOrdr: 5, stinCd: "119", railOprIsttCd: "KR", stinNm: "광운대" },
      { stinConsOrdr: 5, stinCd: "K121", railOprIsttCd: "KR", stinNm: "망우" },
    ],
  };
  const fixture = { packs: [{
    stations: [
      { id: "station-gwangun", nameKo: "광운대" },
      { id: "station-mangu", nameKo: "망우(경의중앙)" },
    ],
    stationLines: [
      { stationId: "station-gwangun", lineId: "gyeongchun", lineSequence: 5 },
      { stationId: "station-mangu", lineId: "gyeongchun", lineSequence: 6 },
    ],
  }] };

  const ctx = buildCollectionContext(roster, "gyeongchun", fixture, SERVICE_PATTERN_MAPPING);
  assert.equal(ctx.stationIdByProviderStation["KR|K2|119"], "station-gwangun");
  assert.equal(ctx.stationIdByProviderStation["KR|K2|K121"], "station-mangu");
  assert.equal(ctx.lineSequenceByStationLine["station-gwangun|gyeongchun"], 5);
  assert.equal(ctx.lineSequenceByStationLine["station-mangu|gyeongchun"], 6);
});

test("TAGO ITX train number filter는 KRIC prefix·leading zero를 정규화하고 row mapping을 보존한다", () => {
  const rows = [
    { trnNo: "K2001", servicePattern: "LOCAL" },
    { trnNo: "K8301", servicePattern: "EXPRESS" },
  ];
  assert.deepEqual(filterRowsByTrainNumbers(rows, ["02001"]), [
    { trnNo: "K2001", servicePattern: "LOCAL" },
  ]);
  assert.throws(() => filterRowsByTrainNumbers(rows, null), /train number filter must be a non-empty array/);
  assert.throws(
    () => filterRowsByTrainNumbers([{ trnNo: "K2001" }], ["02001"]),
    /filtered rows must have servicePattern LOCAL or EXPRESS/,
  );
});

test("KRIC collection context는 증거 없는 exptCd mapping 없이 provider 수집을 시작할 수 없다", () => {
  assert.throws(() => buildCollectionContext(ROSTER, "seoul-4"), /servicePatternByExptCd is required/);
  const context = buildCollectionContext(ROSTER, "seoul-4", null, SERVICE_PATTERN_MAPPING);
  assert.deepEqual(context.servicePatternByExptCd, { LOCAL: "LOCAL", EXPRESS: "EXPRESS" });
  assert.throws(() => buildCollectionContext(ROSTER, "seoul-4", null, { LOCAL: "BEST" }), /servicePatternByExptCd.*LOCAL or EXPRESS/);
});

test("KRIC provider 실패·schema mismatch·부분 수집을 성공 artifact로 만들지 않는다", () => {
  assert.throws(
    () => validateKricTimetablePayload({ header: { resultCode: "30" }, body: [] }),
    /provider resultCode 30/,
  );
  assert.throws(
    () => validateKricTimetablePayload({ header: { resultCode: "00" }, body: {} }),
    /body must be an array/,
  );
  assert.deepEqual(
    validateKricTimetablePayload({ header: { resultCode: "00" }, body: [{ trnNo: "2001" }] }),
    [{ trnNo: "2001" }],
  );
  assert.throws(
    () => assertCompleteKricCollection(1, 25, [{
      requestKey: "stationTimetable|KR|K115|8",
      error: "KRIC timetable provider resultCode 30",
    }]),
    /failed requests: 1\/25; diagnostics=KRIC timetable provider resultCode 30/,
  );
});

test("KRIC provider request는 bounded timeout 뒤에만 재시도하고 최종 실패한다", async () => {
  let calls = 0;
  await assert.rejects(
    () => fetchWithRetry("https://provider.invalid/timetable", {
      attempts: 2,
      timeoutMs: 5,
      fetchImpl: async (_url, { signal }) => {
        calls += 1;
        return await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      sleep: async () => {},
    }),
    /KRIC timetable request timed out/,
  );
  assert.equal(calls, 2);
});

test("KRIC 오류 진단은 raw·percent-encoded credential을 모두 제거한다", () => {
  const key = "abc+def/ghi=";
  const redacted = redactKricCredential(
    `raw=${key}&encoded=${encodeURIComponent(key)}`,
    key,
  );
  assert.doesNotMatch(redacted, /abc\+def|abc%2Bdef/);
  assert.equal(redacted, "raw=[KEY]&encoded=[KEY]");
});

test("ITX materialization은 TAGO OD의 양 끝역·열차번호·시각이 모두 일치해야 한다", () => {
  const rows = [
    {
      stationId: "station-cheongnyangni", lineId: "gyeongchun", trnNo: "K2001", dayCd: "8",
      arrivalSeconds: 8 * 3600 + 30 * 60, departureSeconds: 8 * 3600 + 30 * 60,
    },
    {
      stationId: "station-chuncheon", lineId: "gyeongchun", trnNo: "K2001", dayCd: "8",
      arrivalSeconds: 9 * 3600 + 50 * 60, departureSeconds: 9 * 3600 + 50 * 60,
    },
    {
      stationId: "station-cheongnyangni", lineId: "gyeongchun", trnNo: "K2001", dayCd: "7",
      arrivalSeconds: 10 * 3600, departureSeconds: 10 * 3600,
    },
    {
      stationId: "station-chuncheon", lineId: "gyeongchun", trnNo: "K2001", dayCd: "7",
      arrivalSeconds: 11 * 3600 + 20 * 60, departureSeconds: 11 * 3600 + 20 * 60,
    },
  ];
  const evidence = {
    serviceId: "ITX_CHEONGCHUN",
    kricServiceDayCode: "8",
    departureStation: { canonicalStationId: "station-cheongnyangni" },
    arrivalStation: { canonicalStationId: "station-chuncheon" },
    trainNumbers: ["02001"],
    itineraries: [{
      trainNumber: "02001",
      departureAt: "2026-07-14T08:30:00+09:00",
      arrivalAt: "2026-07-14T09:50:00+09:00",
    }],
  };

  assert.doesNotThrow(() => validateItxOdJoin(rows, evidence));
  assert.throws(
    () => validateItxOdJoin(rows.filter(({ stationId, dayCd }) => stationId !== "station-cheongnyangni" || dayCd !== "8"), evidence),
    /missing OD endpoint row/,
  );
  assert.throws(
    () => validateItxOdJoin([...rows, rows[0]], evidence),
    /duplicate OD endpoint row/,
  );
  assert.throws(
    () => validateItxOdJoin([{ ...rows[0], departureSeconds: rows[0].departureSeconds + 60 }, ...rows.slice(1)], evidence),
    /OD time mismatch/,
  );
  assert.throws(
    () => validateItxOdJoin(rows, { ...evidence, kricServiceDayCode: undefined }),
    /kricServiceDayCode must be 7, 8, or 9/,
  );
});
