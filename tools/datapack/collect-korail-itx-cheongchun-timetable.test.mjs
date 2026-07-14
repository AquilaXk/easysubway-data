import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectKorailItxCheongchunCompleteness,
  collectKorailItxCheongchunTimetable,
  materializeKorailItxRows,
  runKorailItxCompletenessCli,
} from "./collect-korail-itx-cheongchun-timetable.mjs";

const PACK_PATH = "apps/mobile/assets/datapacks/capital.sqlite.gz";
const LIVE_EVIDENCE = JSON.parse(await readFile(
  new URL("./sources/korail-itx-cheongchun-station-sequence-20260713.json", import.meta.url),
  "utf8",
));
const LIVE_TAGO_EVIDENCE = JSON.parse(await readFile(
  new URL("./sources/tago-itx-cheongchun-od-20260714.json", import.meta.url),
  "utf8",
));

function planRow(trainNumber, departure, arrival, departureAt, arrivalAt) {
  return {
    run_ymd: "20260713",
    trn_no: trainNumber,
    dptre_stn_cd: departure === "용산" ? "0104" : "140873",
    dptre_stn_nm: departure,
    arvl_stn_cd: arrival === "춘천" ? "140873" : "130126",
    arvl_stn_nm: arrival,
    trn_plan_dptre_dt: departureAt,
    trn_plan_arvl_dt: arrivalAt,
  };
}

function infoRow(trainNumber, sequence, stationCode, stationName, arrivalAt, departureAt, overrides = {}) {
  return {
    run_ymd: "20260713",
    trn_no: trainNumber,
    trn_run_sn: sequence,
    stn_cd: stationCode,
    stn_nm: stationName,
    mrnt_cd: "GJ",
    mrnt_nm: "경춘선",
    uppln_dn_se_cd: Number(trainNumber) % 2 === 0 ? "U" : "D",
    stop_se_cd: "11",
    stop_se_nm: "여객승하차",
    trn_dptre_dt: departureAt,
    trn_arvl_dt: arrivalAt,
    ...overrides,
  };
}

function apiResponse(rows, { totalCount = rows.length, pageNo = 1 } = {}) {
  return new Response(JSON.stringify({
    response: {
      header: { resultCode: "0", resultMsg: "NORMAL SERVICE." },
      body: {
        items: { item: rows },
        numOfRows: 1000,
        pageNo,
        totalCount,
      },
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function fixtureRows() {
  return {
    plans: [
      planRow("02001", "용산", "춘천", "20260713060000", "20260713080000"),
      planRow("02002", "춘천", "청량리", "20260713070000", "20260713090000"),
    ],
    info: [
      infoRow("02001", 1, "0104", "용산", "20260713060000", "20260713060000"),
      infoRow("02001", 2, "130126", "청량리", "20260713062000", "20260713062100"),
      infoRow("02001", 3, "140701", "평내호평", "20260713071000", "20260713071100"),
      infoRow("02001", 4, "140873", "춘천", "20260713080000", "-"),
      infoRow("02002", 1, "140873", "춘천", "20260713070000", "20260713070000"),
      infoRow("02002", 2, "140701", "평내호평", "20260713074800", "20260713074900"),
      infoRow("02002", 3, "130126", "청량리", "20260713090000", "20260713090000"),
    ],
  };
}

function trainNumberEvidence() {
  return {
    artifactKind: "tago-itx-cheongchun-roster-evidence",
    serviceId: "ITX_CHEONGCHUN",
    kricServiceDayCode: "8",
    serviceDate: "20260713",
    expectedOdCount: 2,
    completedOdCount: 2,
    failedOdCount: 0,
    stationSetHash: "b".repeat(64),
    odMatrixHash: "c".repeat(64),
    trainNumbers: ["02001", "02002"],
    itineraries: [
      {
        trainNumber: "02001",
        departureStationId: "station-b819702fa7d9",
        arrivalStationId: "station-dd14cfb89cbc",
        departureAt: "2026-07-13T06:21:00+09:00",
        arrivalAt: "2026-07-13T08:00:00+09:00",
      },
      {
        trainNumber: "02002",
        departureStationId: "station-dd14cfb89cbc",
        arrivalStationId: "station-b819702fa7d9",
        departureAt: "2026-07-13T07:00:00+09:00",
        arrivalAt: "2026-07-13T09:00:00+09:00",
      },
    ],
    evidenceHash: "a".repeat(64),
  };
}

test("ITX completeness는 dayCd 8/7/9를 독립 수집해 하나의 admission artifact로 묶는다", async () => {
  const calls = [];
  const artifact = await collectKorailItxCheongchunCompleteness({
    serviceKey: "secret",
    serviceDates: { "8": "20260715", "7": "20260718", "9": "20260719" },
    packPath: PACK_PATH,
    now: new Date("2026-07-14T00:00:00.000Z"),
    collectRosterImpl: async ({ serviceDate, kricServiceDayCode }) => ({
      ...trainNumberEvidence(), serviceDate, kricServiceDayCode,
    }),
    collectTimetableImpl: async ({ runDate, kricServiceDayCode }) => {
      calls.push([kricServiceDayCode, runDate]);
      return {
        runDate,
        kricServiceDayCode,
        materialization: { status: "SUPPORTED" },
        legacyDaejeonRowCount: 0,
        legacyYongsanDaejeonTripCount: 0,
        credentialRedacted: true,
      };
    },
  });

  assert.deepEqual(calls, [["8", "20260715"], ["7", "20260718"], ["9", "20260719"]]);
  assert.deepEqual(artifact.selectedServiceDates, { "8": "20260715", "7": "20260718", "9": "20260719" });
  assert.equal(artifact.admissionStatus, "SUPPORTED");
  assert.equal(artifact.admissionEligible, true);
  assert.deepEqual(artifact.allowedConsumerIssues, ["#1400", "#2098", "#2099"]);
  assert.equal(artifact.serviceDays.length, 3);
  assert.match(artifact.evidenceHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(artifact), /secret/);
});

test("ITX completeness는 partial day·replay·provider 오류를 admission하지 않는다", async (context) => {
  const serviceDates = { "8": "20260715", "7": "20260718", "9": "20260719" };
  const roster = async ({ serviceDate, kricServiceDayCode }) => ({
    ...trainNumberEvidence(), serviceDate, kricServiceDayCode,
  });

  await context.test("한 날짜 MISSING", async () => {
    const artifact = await collectKorailItxCheongchunCompleteness({
      serviceKey: "key", serviceDates, packPath: PACK_PATH,
      now: new Date("2026-07-14T00:00:00.000Z"), collectRosterImpl: roster,
      collectTimetableImpl: async ({ kricServiceDayCode }) => ({
        materialization: { status: kricServiceDayCode === "7" ? "MISSING_STATION_TIMES" : "SUPPORTED" },
        legacyDaejeonRowCount: 0,
        legacyYongsanDaejeonTripCount: 0,
      }),
    });
    assert.equal(artifact.admissionStatus, "MISSING");
    assert.equal(artifact.admissionEligible, false);
    assert.equal(artifact.serviceDays.length, 3);
    assert.equal(artifact.serviceDays[1].failureStage, "TIMETABLE");
    assert.equal(artifact.serviceDays[1].failureReasonCode, "PLANNED_TIME_MISSING");
  });

  await context.test("replay", async () => {
    const artifact = await collectKorailItxCheongchunCompleteness({
      serviceKey: "key",
      serviceDates: { "8": "20260713", "7": "20260711", "9": "20260712" },
      packPath: PACK_PATH,
      now: new Date("2026-07-14T00:00:00.000Z"), replay: true, collectRosterImpl: roster,
      collectTimetableImpl: async () => ({
        materialization: { status: "SUPPORTED" },
        legacyDaejeonRowCount: 0,
        legacyYongsanDaejeonTripCount: 0,
      }),
    });
    assert.equal(artifact.admissionStatus, "REPLAY_ONLY");
    assert.equal(artifact.admissionEligible, false);
  });

  await context.test("provider 오류", async () => {
    const attemptedDates = [];
    const artifact = await collectKorailItxCheongchunCompleteness({
      serviceKey: "key", serviceDates, packPath: PACK_PATH,
      now: new Date("2026-07-14T00:00:00.000Z"),
      collectRosterImpl: async ({ serviceDate }) => {
        attemptedDates.push(serviceDate);
        throw new Error("TAGO GetStrtpntAlocFndTrainInfo HTTP 503");
      },
      collectTimetableImpl: async () => assert.fail("must not run"),
    });
    assert.equal(artifact.admissionStatus, "MISSING");
    assert.equal(artifact.admissionEligible, false);
    assert.equal(artifact.serviceDays[0].failureStage, "ROSTER");
    assert.equal(artifact.serviceDays[0].failureReasonCode, "PROVIDER_HTTP_FAILURE");
    assert.deepEqual(attemptedDates, ["20260715", "20260718", "20260719"]);
    assert.equal(artifact.serviceDays.length, 3);
    assert.doesNotMatch(JSON.stringify(artifact), /503/);
  });

  await context.test("OD 일부 실패", async () => {
    const artifact = await collectKorailItxCheongchunCompleteness({
      serviceKey: "key", serviceDates, packPath: PACK_PATH,
      now: new Date("2026-07-14T00:00:00.000Z"),
      collectRosterImpl: async ({ serviceDate, kricServiceDayCode }) => ({
        ...trainNumberEvidence(), serviceDate, kricServiceDayCode,
        completedOdCount: 1,
        failedOdCount: 1,
      }),
      collectTimetableImpl: async () => assert.fail("must not run"),
    });
    assert.equal(artifact.serviceDays[0].failureReasonCode, "OD_MATRIX_INCOMPLETE");
    assert.equal(artifact.serviceDays[0].completedOdCount, 1);
    assert.equal(artifact.serviceDays[0].failedOdCount, 1);
    assert.equal(artifact.admissionStatus, "MISSING");
  });

  await context.test("station mapping 오류", async () => {
    const artifact = await collectKorailItxCheongchunCompleteness({
      serviceKey: "key", serviceDates, packPath: PACK_PATH,
      now: new Date("2026-07-14T00:00:00.000Z"),
      collectRosterImpl: async () => { throw new Error("TAGO station mapping is missing or ambiguous: 갈매"); },
      collectTimetableImpl: async () => assert.fail("must not run"),
    });
    assert.equal(artifact.serviceDays[0].failureReasonCode, "STATION_MAPPING_INCOMPLETE");
    assert.equal(artifact.serviceDays[0].failureContext, "갈매");
  });

  await context.test("canonical passenger-stop mapping 오류", async () => {
    const artifact = await collectKorailItxCheongchunCompleteness({
      serviceKey: "key", serviceDates, packPath: PACK_PATH,
      now: new Date("2026-07-14T00:00:00.000Z"), collectRosterImpl: roster,
      collectTimetableImpl: async () => {
        throw new Error("Korail ITX passenger stop canonical mapping missing: 2001/UNKNOWN");
      },
    });
    assert.equal(artifact.serviceDays[0].failureReasonCode, "CANONICAL_STATION_MAPPING_INCOMPLETE");
  });

  await context.test("timetable 오류에도 완료된 OD evidence를 보존", async () => {
    const artifact = await collectKorailItxCheongchunCompleteness({
      serviceKey: "key", serviceDates, packPath: PACK_PATH,
      now: new Date("2026-07-14T00:00:00.000Z"), collectRosterImpl: roster,
      collectTimetableImpl: async () => {
        throw new Error(
          "Korail train operation API pagination incomplete: " +
          "operation=travelerTrainRunInfo2,collected=1000,total=1500,pages=2",
        );
      },
    });
    assert.equal(artifact.serviceDays[0].failureStage, "TIMETABLE");
    assert.equal(artifact.serviceDays[0].expectedOdCount, 2);
    assert.equal(artifact.serviceDays[0].completedOdCount, 2);
    assert.equal(artifact.serviceDays[0].failedOdCount, 0);
    assert.equal(artifact.serviceDays[0].stationSetHash, "b".repeat(64));
    assert.equal(artifact.serviceDays[0].odMatrixHash, "c".repeat(64));
    assert.equal(artifact.serviceDays[0].roster.evidenceHash, "a".repeat(64));
    assert.equal(
      artifact.serviceDays[0].failureContext,
      "operation=travelerTrainRunInfo2,collected=1000,total=1500,pages=2",
    );
  });

  await context.test("공식 run info 0건", async () => {
    const artifact = await collectKorailItxCheongchunCompleteness({
      serviceKey: "key", serviceDates, packPath: PACK_PATH,
      now: new Date("2026-07-14T00:00:00.000Z"), collectRosterImpl: roster,
      collectTimetableImpl: async () => { throw new Error("Korail ITX run info returned zero rows"); },
    });
    assert.equal(artifact.serviceDays[0].failureReasonCode, "OFFICIAL_RUN_INFO_EMPTY");
    assert.equal(artifact.serviceDays[0].failureContext, "operation=travelerTrainRunInfo2,total=0");
  });

  await context.test("legacy 대전 위반 count 보존", async () => {
    const artifact = await collectKorailItxCheongchunCompleteness({
      serviceKey: "key", serviceDates, packPath: PACK_PATH,
      now: new Date("2026-07-14T00:00:00.000Z"), collectRosterImpl: roster,
      collectTimetableImpl: async () => {
        const error = new Error("Korail ITX legacy Daejeon data must be zero");
        error.legacyDaejeonRowCount = 2;
        error.legacyYongsanDaejeonTripCount = 1;
        throw error;
      },
    });
    assert.equal(artifact.serviceDays[0].failureReasonCode, "LEGACY_DAEJEON_DATA_PRESENT");
    assert.equal(artifact.serviceDays[0].legacyDaejeonRowCount, 2);
    assert.equal(artifact.serviceDays[0].legacyYongsanDaejeonTripCount, 1);
    assert.equal(artifact.legacyDaejeonRowCount, 6);
    assert.equal(artifact.legacyYongsanDaejeonTripCount, 3);
  });
});

test("ITX CLI는 runtime 실패를 MISSING artifact로 저장하고 non-zero를 반환한다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "itx-cli-test-"));
  const output = path.join(dir, "evidence.json");
  try {
    const result = await runKorailItxCompletenessCli({
      argv: [
        "--day8-date", "20260715",
        "--day7-date", "20260718",
        "--day9-date", "20260719",
        "--canonical-pack", PACK_PATH,
        "--output", output,
      ],
      env: { DATA_GO_KR_SERVICE_KEY: "secret" },
      now: new Date("2026-07-14T00:00:00.000Z"),
      collectImpl: async () => { throw new Error("provider HTTP 503 secret"); },
    });
    const artifact = JSON.parse(await readFile(output, "utf8"));
    assert.equal(result.exitCode, 1);
    assert.equal(artifact.admissionStatus, "MISSING");
    assert.equal(artifact.admissionEligible, false);
    assert.equal(artifact.failureReasonCode, "PROVIDER_HTTP_FAILURE");
    assert.doesNotMatch(JSON.stringify(artifact), /503|secret/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ITX CLI는 invalid input을 artifact 생성 전에 거부한다", async (context) => {
  const dir = await mkdtemp(path.join(tmpdir(), "itx-cli-invalid-"));
  const base = [
    "--day8-date", "20260715",
    "--day7-date", "20260718",
    "--day9-date", "20260719",
    "--canonical-pack", PACK_PATH,
  ];
  try {
    for (const scenario of [
      { name: "잘못된 날짜", argv: base.with(1, "20260718"), env: { DATA_GO_KR_SERVICE_KEY: "key" }, pattern: /dayCd 8/ },
      { name: "pack 누락", argv: base.slice(0, -2), env: { DATA_GO_KR_SERVICE_KEY: "key" }, pattern: /--canonical-pack/ },
      { name: "credential 누락", argv: base, env: {}, pattern: /DATA_GO_KR_SERVICE_KEY/ },
    ]) {
      await context.test(scenario.name, async () => {
        const output = path.join(dir, `${scenario.name}.json`);
        await assert.rejects(runKorailItxCompletenessCli({
          argv: [...scenario.argv, "--output", output],
          env: scenario.env,
          now: new Date("2026-07-14T00:00:00.000Z"),
          collectImpl: async () => assert.fail("must not run"),
        }), scenario.pattern);
        await assert.rejects(readFile(output), /ENOENT/);
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Korail ITX-청춘 collector는 공식 station rows를 canonical EXPRESS trip으로 만든다", async () => {
  const { plans, info } = fixtureRows();
  const requested = [];
  const artifact = await collectKorailItxCheongchunTimetable({
    serviceKey: "never-print-this-key",
    runDate: "20260713",
    kricServiceDayCode: "8",
    packPath: PACK_PATH,
    trainNumberEvidence: trainNumberEvidence(),
    now: new Date("2026-07-14T06:00:00.000Z"),
    fetchImpl: async (url) => {
      requested.push(url);
      if (url.pathname.endsWith("codes2")) {
        return url.searchParams.get("cond[type::EQ]") === "mrnt_cd"
          ? apiResponse([{ code: "GJ", type: "mrnt_cd", value: "경춘선" }])
          : apiResponse([{ code: "11", type: "stop_se_cd", value: "여객승하차" }]);
      }
      return apiResponse(url.pathname.endsWith("travelerTrainRunPlan2") ? plans : info);
    },
  });

  assert.equal(requested.length, 4);
  assert.equal(requested[0].searchParams.get("cond[type::EQ]"), "mrnt_cd");
  assert.equal(requested[1].searchParams.get("cond[type::EQ]"), "stop_se_cd");
  assert.equal(requested[3].searchParams.get("cond[mrnt_cd::EQ]"), "GJ");
  assert.deepEqual(artifact.routeCodeMapping, { providerCode: "GJ", providerName: "경춘선" });
  assert.equal(artifact.providerResultCode, "0");
  assert.equal(artifact.trainCount, 2);
  assert.equal(artifact.transitTrips.length, 2);
  assert.equal(artifact.transitStopTimes.length, 7);
  assert.ok(artifact.transitTrips.every(({ servicePattern }) => servicePattern === "EXPRESS"));
  assert.deepEqual(artifact.directions, ["D", "U"]);
  assert.deepEqual(artifact.terminalVariants, [
    { directionCode: "D", originStationName: "용산", destinationStationName: "춘천" },
    { directionCode: "U", originStationName: "춘천", destinationStationName: "청량리" },
  ]);
  assert.deepEqual(artifact.trainNumberSets, {
    roster: ["2001", "2002"],
    plan: ["2001", "2002"],
    info: ["2001", "2002"],
    materialized: ["2001", "2002"],
  });
  assert.deepEqual(
    artifact.transitStopTimes.filter(({ tripId }) => tripId.includes("-2001-")).map(({ stationId }) => stationId),
    ["station-8aa315864466", "station-b819702fa7d9", "station-f3d9c93ba7d6", "station-dd14cfb89cbc"],
  );
  assert.equal(artifact.credentialRedacted, true);
  assert.doesNotMatch(JSON.stringify(artifact), /never-print-this-key/);
});

test("Korail station row의 시각이 비면 sequence evidence만 보존하고 timetable 지원을 열지 않는다", async () => {
  const { plans, info } = fixtureRows();
  const missingTimes = info.map((row) => row.trn_no === "02001" && row.stn_nm === "청량리"
    ? { ...row, trn_arvl_dt: "", trn_dptre_dt: "" }
    : row);
  const artifact = await collectKorailItxCheongchunTimetable({
    serviceKey: "key",
    runDate: "20260713",
    kricServiceDayCode: "8",
    packPath: PACK_PATH,
    trainNumberEvidence: trainNumberEvidence(),
    fetchImpl: async (url) => {
      if (url.pathname.endsWith("codes2")) {
        return url.searchParams.get("cond[type::EQ]") === "mrnt_cd"
          ? apiResponse([{ code: "GJ", type: "mrnt_cd", value: "경춘선" }])
          : apiResponse([{ code: "11", type: "stop_se_cd", value: "여객승하차" }]);
      }
      return apiResponse(url.pathname.endsWith("travelerTrainRunPlan2") ? plans : missingTimes);
    },
  });

  assert.deepEqual(artifact.materialization, {
    status: "MISSING_STATION_TIMES",
    missingTimestampStopCount: 1,
    stationTimeCapability: {
      status: "MISSING",
      reasonCode: "PARTIAL_OFFICIAL_OPERATION_FIELDS_EMPTY",
      checkedStopCount: 7,
      populatedTimestampStopCount: 6,
      requiredTimestampFieldCount: 10,
      populatedTimestampFieldCount: 8,
    },
  });
  assert.equal(artifact.stationSequences.length, 2);
  assert.equal(artifact.stationSequences[0].stops.length, 4);
  assert.deepEqual(artifact.transitTrips, []);
  assert.deepEqual(artifact.transitStopTimes, []);
});

test("Korail station row의 필수 시각이 부분적으로 있으면 전체 필드 empty로 분류하지 않는다", async () => {
  const { plans, info } = fixtureRows();
  const lastSequenceByTrain = new Map([["02001", 4], ["02002", 3]]);
  const partialTimes = info.map((row) => ({
    ...row,
    trn_dptre_dt: row.trn_run_sn < lastSequenceByTrain.get(row.trn_no) ? "" : row.trn_dptre_dt,
    trn_arvl_dt: row.trn_run_sn === lastSequenceByTrain.get(row.trn_no) ? "" : row.trn_arvl_dt,
  }));
  const artifact = await collectKorailItxCheongchunTimetable({
    serviceKey: "key",
    runDate: "20260713",
    kricServiceDayCode: "8",
    packPath: PACK_PATH,
    trainNumberEvidence: trainNumberEvidence(),
    fetchImpl: async (url) => {
      if (url.pathname.endsWith("codes2")) {
        return url.searchParams.get("cond[type::EQ]") === "mrnt_cd"
          ? apiResponse([{ code: "GJ", type: "mrnt_cd", value: "경춘선" }])
          : apiResponse([{ code: "11", type: "stop_se_cd", value: "여객승하차" }]);
      }
      return apiResponse(url.pathname.endsWith("travelerTrainRunPlan2") ? plans : partialTimes);
    },
  });

  assert.deepEqual(artifact.materialization.stationTimeCapability, {
    status: "MISSING",
    reasonCode: "PARTIAL_OFFICIAL_OPERATION_FIELDS_EMPTY",
    checkedStopCount: 7,
    populatedTimestampStopCount: 0,
    requiredTimestampFieldCount: 10,
    populatedTimestampFieldCount: 3,
  });
});

test("Korail collector는 legacy 대전 row를 canonical mapping 전에 count와 함께 거부한다", async () => {
  const { plans, info } = fixtureRows();
  const legacyPlans = plans.map((row) => row.trn_no === "02001"
    ? { ...row, arvl_stn_cd: "0010", arvl_stn_nm: "대전" }
    : row);
  const legacyInfo = info.map((row) => row.trn_no === "02001" && row.trn_run_sn === 4
    ? { ...row, stn_cd: "0010", stn_nm: "대전" }
    : row);
  await assert.rejects(collectKorailItxCheongchunTimetable({
    serviceKey: "key",
    runDate: "20260713",
    kricServiceDayCode: "8",
    packPath: PACK_PATH,
    trainNumberEvidence: trainNumberEvidence(),
    fetchImpl: async (url) => {
      if (url.pathname.endsWith("codes2")) {
        return url.searchParams.get("cond[type::EQ]") === "mrnt_cd"
          ? apiResponse([{ code: "GJ", type: "mrnt_cd", value: "경춘선" }])
          : apiResponse([{ code: "11", type: "stop_se_cd", value: "여객승하차" }]);
      }
      return apiResponse(url.pathname.endsWith("travelerTrainRunPlan2") ? legacyPlans : legacyInfo);
    },
  }), (error) => {
    assert.match(error.message, /legacy Daejeon data must be zero/);
    assert.equal(error.legacyDaejeonRowCount, 1);
    assert.equal(error.legacyYongsanDaejeonTripCount, 1);
    return true;
  });
});

test(
  `live evidence는 TAGO 18편을 Korail canonical sequence로 검증하고 빈 시각을 거부한다 ` +
    `(sequences=${LIVE_EVIDENCE.stationSequenceRowCount},missing=${LIVE_EVIDENCE.materialization.missingTimestampStopCount})`,
  () => {
    assert.equal(LIVE_EVIDENCE.artifactKind, "korail-itx-cheongchun-station-sequence-evidence");
    assert.equal(LIVE_EVIDENCE.trainCount, 18);
    assert.equal(LIVE_TAGO_EVIDENCE.trainNumbers.length, 18);
    assert.equal(LIVE_TAGO_EVIDENCE.evidenceHash, LIVE_EVIDENCE.trainNumberFilter.evidenceHash);
    assert.equal(LIVE_EVIDENCE.trainNumberFilter.trainNumberCount, 18);
    assert.ok(LIVE_EVIDENCE.stationSequenceRowCount > 0);
    assert.equal(LIVE_EVIDENCE.stationSequences.length, 18);
    assert.equal(LIVE_EVIDENCE.materialization.status, "MISSING_STATION_TIMES");
    assert.ok(LIVE_EVIDENCE.materialization.missingTimestampStopCount > 0);
    assert.deepEqual(LIVE_EVIDENCE.materialization.stationTimeCapability, {
      status: "EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE",
      reasonCode: "OFFICIAL_OPERATION_FIELDS_EMPTY",
      checkedStopCount: 113,
      populatedTimestampStopCount: 0,
      requiredTimestampFieldCount: 190,
      populatedTimestampFieldCount: 0,
      verifiedAt: "2026-07-14T06:36:22.122Z",
      travelerTrainRunInfo2RawResponseSha256: "ff64cf6683de1fbc089dde751af198b4745bbd71260b3867cef69f615bafce4c",
    });
    assert.deepEqual(LIVE_EVIDENCE.transitTrips, []);
    assert.deepEqual(LIVE_EVIDENCE.transitStopTimes, []);
    assert.match(LIVE_EVIDENCE.evidenceHash, /^[a-f0-9]{64}$/);
    assert.equal(LIVE_EVIDENCE.credentialRedacted, true);
    assert.equal(LIVE_TAGO_EVIDENCE.credentialRedacted, true);
    assert.doesNotMatch(JSON.stringify([LIVE_EVIDENCE, LIVE_TAGO_EVIDENCE]),
      /serviceKey|DATA_GO_KR_SERVICE_KEY|KRIC_SERVICE_KEY/);
  },
);

test("Korail ITX materialization은 경춘선 밖 역을 포함한 용산~춘천 전체 trip을 보존한다", () => {
  const { plans, info } = fixtureRows();
  const fullTrip = info
    .filter(({ trn_no }) => trn_no === "02001")
    .map((row) => ({ ...row, trn_run_sn: row.trn_run_sn + (row.trn_run_sn > 1 ? 2 : 0) }));
  fullTrip[0] = { ...fullTrip[0], stop_se_cd: "11", stop_se_nm: "여객승하차" };
  fullTrip.splice(
    1,
    0,
    infoRow("02001", 2, "0106", "옥수", "20260713060800", "20260713060900"),
    infoRow("02001", 3, "0111", "왕십리", "20260713061400", "20260713061500"),
  );

  const materialized = materializeKorailItxRows({
    plans,
    infoRows: fullTrip,
    runDate: "20260713",
    kricServiceDayCode: "8",
    packPath: PACK_PATH,
    trainNumbers: ["02001"],
    routeCode: "GJ",
    passengerStopCodes: new Map([["11", "여객승하차"]]),
  });

  assert.deepEqual(materialized.transitStopTimes.map(({ stationId }) => stationId), [
    "station-8aa315864466",
    "station-c0679b9a6cf8",
    "station-e5cf592cf355",
    "station-b819702fa7d9",
    "station-f3d9c93ba7d6",
    "station-dd14cfb89cbc",
  ]);
  assert.deepEqual(materialized.transitStopTimes.map(({ lineId }) => lineId), [
    "line-6e39be0cb6e2",
    "line-6e39be0cb6e2",
    "line-6e39be0cb6e2",
    "line-54a7b980b7c3",
    "line-54a7b980b7c3",
    "line-54a7b980b7c3",
  ]);
});

test("Korail collector는 한 방향 roster를 timetable로 admission하지 않는다", async () => {
  const { plans, info } = fixtureRows();
  const roster = trainNumberEvidence();
  await assert.rejects(collectKorailItxCheongchunTimetable({
    serviceKey: "key",
    runDate: "20260713",
    kricServiceDayCode: "8",
    packPath: PACK_PATH,
    trainNumberEvidence: {
      ...roster,
      trainNumbers: ["02001"],
      itineraries: [roster.itineraries[0]],
    },
    fetchImpl: async (url) => {
      if (url.pathname.endsWith("codes2")) {
        return url.searchParams.get("cond[type::EQ]") === "mrnt_cd"
          ? apiResponse([{ code: "GJ", type: "mrnt_cd", value: "경춘선" }])
          : apiResponse([{ code: "11", type: "stop_se_cd", value: "여객승하차" }]);
      }
      return apiResponse(url.pathname.endsWith("travelerTrainRunPlan2") ? plans : info);
    },
  }), /both directions/);
});

test("Korail materialization은 현재 시종착 변형을 plan endpoint 그대로 보존한다", () => {
  const { info } = fixtureRows();
  const materialized = materializeKorailItxRows({
    plans: [planRow("02001", "용산", "평내호평", "20260713060000", "20260713071000")],
    infoRows: info.filter(({ trn_no, stn_nm }) => trn_no === "02001" && stn_nm !== "춘천"),
    runDate: "20260713",
    kricServiceDayCode: "8",
    packPath: PACK_PATH,
    trainNumbers: ["02001"],
    routeCode: "GJ",
    passengerStopCodes: new Map([["11", "여객승하차"]]),
  });

  assert.equal(materialized.transitTrips[0].tripHeadsign, "평내호평");
  assert.deepEqual(materialized.transitStopTimes.map(({ stationId }) => stationId), [
    "station-8aa315864466",
    "station-b819702fa7d9",
    "station-f3d9c93ba7d6",
  ]);
});

test("Korail ITX materialization은 누락·중복·역순·시각 역전을 거부한다", async (context) => {
  const { plans, info } = fixtureRows();
  const base = {
    plans,
    infoRows: info,
    runDate: "20260713",
    kricServiceDayCode: "8",
    packPath: PACK_PATH,
    trainNumbers: trainNumberEvidence().trainNumbers,
    routeCode: "GJ",
    passengerStopCodes: new Map([["11", "여객승하차"]]),
  };

  await context.test("양 끝역 누락", () => {
    assert.throws(() => materializeKorailItxRows({
      ...base,
      infoRows: info.filter(({ stn_nm }) => stn_nm !== "춘천"),
    }), /at least 2 canonical stops|plan endpoint|plan arrival/);
  });

  await context.test("중복 정차", () => {
    assert.throws(() => materializeKorailItxRows({
      ...base,
      infoRows: [...info, { ...info[2], trn_run_sn: 3.5 }],
    }), /duplicate canonical stop|trn_run_sn/);
  });

  await context.test("역순 정차", () => {
    const zigzag = info.map((row) => row.trn_no === "02001" && row.stn_nm === "춘천"
      ? { ...row, trn_run_sn: 5 }
      : row);
    zigzag.splice(3, 0, infoRow("02001", 4, "130161", "상봉", "20260713073000", "20260713073100"));
    assert.throws(() => materializeKorailItxRows({ ...base, infoRows: zigzag }), /lineSequence/);
  });

  await context.test("시각 역전", () => {
    const reversedTime = info.map((row) => row.trn_no === "02001" && row.stn_nm === "평내호평"
      ? { ...row, trn_arvl_dt: "20260713071200", trn_dptre_dt: "20260713071100" }
      : row);
    assert.throws(() => materializeKorailItxRows({ ...base, infoRows: reversedTime }), /arrival.*departure/);
  });

  await context.test("중간역 계획 출발시각 누락", () => {
    const missingDeparture = info.map((row) => row.trn_no === "02001" && row.stn_nm === "평내호평"
      ? { ...row, trn_dptre_dt: "" }
      : row);
    assert.throws(() => materializeKorailItxRows({ ...base, infoRows: missingDeparture }), /planned timestamp missing/);
  });

  await context.test("plan 출발시각 누락", () => {
    const missingPlanTime = plans.map((row) => row.trn_no === "02001"
      ? { ...row, trn_plan_dptre_dt: "" }
      : row);
    assert.throws(() => materializeKorailItxRows({ ...base, plans: missingPlanTime }), /plan timestamp missing/);
  });

  await context.test("plan 시각의 service date 불일치", () => {
    const wrongPlanDate = plans.map((row) => row.trn_no === "02001"
      ? { ...row, trn_plan_dptre_dt: "20260712060000" }
      : row);
    assert.throws(() => materializeKorailItxRows({ ...base, plans: wrongPlanDate }), /runDate or the immediately following date/);
  });

  await context.test("plan 출발시각과 첫 정차 출발시각 불일치", () => {
    const mismatchedPlanDeparture = plans.map((row) => row.trn_no === "02001"
      ? { ...row, trn_plan_dptre_dt: "20260713060100" }
      : row);
    assert.throws(() => materializeKorailItxRows({
      ...base,
      plans: mismatchedPlanDeparture,
    }), /plan departure.*first stop departure/);
  });

  await context.test("plan 도착시각과 마지막 정차 도착시각 불일치", () => {
    const mismatchedPlanArrival = plans.map((row) => row.trn_no === "02001"
      ? { ...row, trn_plan_arvl_dt: "20260713075900" }
      : row);
    assert.throws(() => materializeKorailItxRows({
      ...base,
      plans: mismatchedPlanArrival,
    }), /plan arrival.*last stop arrival/);
  });

  await context.test("지원하지 않는 service day", () => {
    assert.throws(() => materializeKorailItxRows({
      ...base,
      kricServiceDayCode: "6",
    }), /kricServiceDayCode must be 7, 8, or 9/);
  });

  await context.test("U/D가 아닌 방향 code", () => {
    const invalidDirection = info.map((row) => row.trn_no === "02001"
      ? { ...row, uppln_dn_se_cd: null }
      : row);
    assert.throws(() => materializeKorailItxRows({
      ...base,
      infoRows: invalidDirection,
    }), /direction code/);
  });

  await context.test("canonical mapping이 없는 여객 정차", () => {
    const withInteriorGap = info.map((row) => {
      if (row.trn_no !== "02001" || row.trn_run_sn < 3) return row;
      return { ...row, trn_run_sn: row.trn_run_sn + 1 };
    });
    withInteriorGap.push(infoRow(
      "02001", 3, "999999", "미등록역", "20260713065000", "20260713065100",
    ));
    assert.throws(() => materializeKorailItxRows({
      ...base,
      infoRows: withInteriorGap,
    }), /passenger stop canonical mapping missing/);
  });

  await context.test("여객 정차 code-name 불일치", () => {
    const mismatchedStopName = info.map((row) => row.trn_no === "02001" && row.stn_nm === "평내호평"
      ? { ...row, stop_se_nm: "통과" }
      : row);
    assert.throws(() => materializeKorailItxRows({ ...base, infoRows: mismatchedStopName }), /passenger stop name mismatch/);
  });

  await context.test("익일 도착", () => {
    const overnight = info.map((row) => {
      if (row.trn_no !== "02001") return row;
      if (row.stn_nm === "청량리") return { ...row, trn_arvl_dt: "20260713235000", trn_dptre_dt: "20260713235100" };
      if (row.stn_nm === "평내호평") return { ...row, trn_arvl_dt: "20260714003000", trn_dptre_dt: "20260714003100" };
      if (row.stn_nm === "춘천") return { ...row, trn_arvl_dt: "20260714010000", trn_dptre_dt: "-" };
      return row;
    });
    const overnightPlans = plans.map((row) => row.trn_no === "02001"
      ? { ...row, trn_plan_arvl_dt: "20260714010000" }
      : row);
    const materialized = materializeKorailItxRows({
      ...base,
      plans: overnightPlans,
      infoRows: overnight,
    });
    assert.ok(materialized.transitStopTimes
      .filter(({ tripId }) => tripId.includes("-2001-"))
      .at(-1).arrivalSeconds > 86_400);
  });
});

test("Korail ITX collector는 provider/schema/pagination 오류를 fail closed한다", async (context) => {
  const base = {
    serviceKey: "key",
    runDate: "20260713",
    kricServiceDayCode: "8",
    packPath: PACK_PATH,
    trainNumberEvidence: trainNumberEvidence(),
  };

  await context.test("provider failure", async () => {
    await assert.rejects(collectKorailItxCheongchunTimetable({
      ...base,
      fetchImpl: async () => new Response(JSON.stringify({ response: { header: { resultCode: "30" }, body: {} } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    }), /provider resultCode 30/);
  });

  await context.test("schema mismatch", async () => {
    await assert.rejects(collectKorailItxCheongchunTimetable({
      ...base,
      fetchImpl: async () => apiResponse([{ run_ymd: "20260713" }]),
    }), /fields missing/);
  });

  await context.test("2페이지 정상 수집", async () => {
    const { plans, info } = fixtureRows();
    const artifact = await collectKorailItxCheongchunTimetable({
      ...base,
      fetchImpl: async (url) => {
        if (url.pathname.endsWith("codes2") && url.searchParams.get("cond[type::EQ]") === "mrnt_cd") {
          return url.searchParams.get("pageNo") === "1"
            ? apiResponse([{ code: "GJ", type: "mrnt_cd", value: "경춘선" }], { totalCount: 2 })
            : apiResponse([{ code: "XX", type: "other", value: "기타" }], { totalCount: 2, pageNo: 2 });
        }
        if (url.pathname.endsWith("codes2")) {
          return apiResponse([{ code: "11", type: "stop_se_cd", value: "여객승하차" }]);
        }
        return apiResponse(url.pathname.endsWith("travelerTrainRunPlan2") ? plans : info);
      },
    });
    assert.equal(artifact.operations[0].pageCount, 2);
  });

  await context.test("빈 중간 페이지", async () => {
    await assert.rejects(collectKorailItxCheongchunTimetable({
      ...base,
      fetchImpl: async (url) => url.searchParams.get("pageNo") === "1"
        ? apiResponse([{ code: "GJ", type: "mrnt_cd", value: "경춘선" }], { totalCount: 2 })
        : apiResponse([], { totalCount: 2, pageNo: 2 }),
    }), /pagination incomplete: operation=codes2,collected=1,total=2,pages=2/);
  });

  await context.test("공식 totalCount 0은 pagination 오류로 오분류하지 않음", async () => {
    const { plans } = fixtureRows();
    await assert.rejects(collectKorailItxCheongchunTimetable({
      ...base,
      fetchImpl: async (url) => {
        if (url.pathname.endsWith("codes2")) {
          return url.searchParams.get("cond[type::EQ]") === "mrnt_cd"
            ? apiResponse([{ code: "GJ", type: "mrnt_cd", value: "경춘선" }])
            : apiResponse([{ code: "11", type: "stop_se_cd", value: "여객승하차" }]);
        }
        return url.pathname.endsWith("travelerTrainRunPlan2")
          ? apiResponse(plans)
          : apiResponse([], { totalCount: 0 });
      },
    }), /run info returned zero rows/);
  });

  await context.test("페이지 사이 totalCount 변경", async () => {
    await assert.rejects(collectKorailItxCheongchunTimetable({
      ...base,
      fetchImpl: async (url) => url.searchParams.get("pageNo") === "1"
        ? apiResponse([{ code: "GJ", type: "mrnt_cd", value: "경춘선" }], { totalCount: 2 })
        : apiResponse([{ code: "XX", type: "other", value: "기타" }], { totalCount: 3, pageNo: 2 }),
    }), /totalCount changed/);
  });
});

test("Korail/TAGO timetable join은 service date가 다르면 거부한다", async () => {
  const { plans, info } = fixtureRows();
  const mismatchedEvidence = { ...trainNumberEvidence(), serviceDate: "20260714" };
  await assert.rejects(collectKorailItxCheongchunTimetable({
    serviceKey: "key",
    runDate: "20260713",
    kricServiceDayCode: "8",
    packPath: PACK_PATH,
    trainNumberEvidence: mismatchedEvidence,
    fetchImpl: async (url) => {
      if (url.pathname.endsWith("codes2")) {
        return url.searchParams.get("cond[type::EQ]") === "mrnt_cd"
          ? apiResponse([{ code: "GJ", type: "mrnt_cd", value: "경춘선" }])
          : apiResponse([{ code: "11", type: "stop_se_cd", value: "여객승하차" }]);
      }
      return apiResponse(url.pathname.endsWith("travelerTrainRunPlan2") ? plans : info);
    },
  }), /service date mismatch/);
});
