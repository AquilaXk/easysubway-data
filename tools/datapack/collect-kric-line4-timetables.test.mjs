import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  assertCompleteKricCollection,
  buildCollectionContext,
  buildServicePatternObservation,
  filterRowsByTrainNumbers,
  redactKricCredential,
  selectServicePatternProbeRequest,
  validateServicePatternEvidence,
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
