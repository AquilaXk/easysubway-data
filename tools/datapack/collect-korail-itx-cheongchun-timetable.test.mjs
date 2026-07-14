import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  collectKorailItxCheongchunTimetable,
  materializeKorailItxRows,
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
      infoRow("02001", 1, "0104", "용산", "20260713060000", "20260713060000", {
        stop_se_cd: "00",
        stop_se_nm: "통과",
      }),
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
    artifactKind: "tago-itx-cheongchun-od-evidence",
    serviceId: "ITX_CHEONGCHUN",
    kricServiceDayCode: "8",
    departureDate: "2026-07-13",
    trainNumbers: ["02001"],
    itineraries: [{
      trainNumber: "02001",
      departureAt: "2026-07-13T06:21:00+09:00",
      arrivalAt: "2026-07-13T08:00:00+09:00",
    }],
    departureStation: { canonicalStationId: "station-b819702fa7d9" },
    arrivalStation: { canonicalStationId: "station-dd14cfb89cbc" },
    evidenceHash: "a".repeat(64),
  };
}

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
  assert.equal(artifact.trainCount, 1);
  assert.equal(artifact.transitTrips.length, 1);
  assert.equal(artifact.transitStopTimes.length, 3);
  assert.ok(artifact.transitTrips.every(({ servicePattern }) => servicePattern === "EXPRESS"));
  assert.deepEqual(
    artifact.transitStopTimes.filter(({ tripId }) => tripId.includes("-2001-")).map(({ stationId }) => stationId),
    ["station-b819702fa7d9", "station-f3d9c93ba7d6", "station-dd14cfb89cbc"],
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

  assert.deepEqual(artifact.materialization, { status: "MISSING_STATION_TIMES", missingTimestampStopCount: 1 });
  assert.equal(artifact.stationSequences.length, 1);
  assert.equal(artifact.stationSequences[0].stops.length, 3);
  assert.deepEqual(artifact.transitTrips, []);
  assert.deepEqual(artifact.transitStopTimes, []);
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
    assert.deepEqual(LIVE_EVIDENCE.transitTrips, []);
    assert.deepEqual(LIVE_EVIDENCE.transitStopTimes, []);
    assert.match(LIVE_EVIDENCE.evidenceHash, /^[a-f0-9]{64}$/);
    assert.equal(LIVE_EVIDENCE.credentialRedacted, true);
    assert.equal(LIVE_TAGO_EVIDENCE.credentialRedacted, true);
    assert.doesNotMatch(JSON.stringify([LIVE_EVIDENCE, LIVE_TAGO_EVIDENCE]),
      /serviceKey|DATA_GO_KR_SERVICE_KEY|KRIC_SERVICE_KEY/);
  },
);

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
    }), /at least 2 canonical stops|canonical endpoint/);
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
    const materialized = materializeKorailItxRows({ ...base, infoRows: overnight });
    assert.ok(materialized.transitStopTimes.at(-1).arrivalSeconds > 86_400);
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
    }), /pagination incomplete/);
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
  const mismatchedEvidence = { ...trainNumberEvidence(), departureDate: "2026-07-14" };
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
