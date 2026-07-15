import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildItxOdMatrix,
  collectTagoItxCheongchunOd,
  collectTagoItxCheongchunRoster,
  materializeTagoItxOdRows,
  normalizeTrainNumber,
  validateItxServiceDates,
} from "./collect-tago-itx-cheongchun-od.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function tagoResponse(items, totalCount = items.length) {
  return new Response(JSON.stringify({ response: {
    header: { resultCode: "00", resultMsg: "NORMAL SERVICE." },
    body: { items: { item: items }, pageNo: 1, numOfRows: 100, totalCount },
  } }), { status: 200, headers: { "content-type": "application/json" } });
}

function tagoCatalogResponse(items) {
  return new Response(JSON.stringify({ response: {
    header: { resultCode: "00", resultMsg: "NORMAL SERVICE." },
    body: { items: { item: items } },
  } }), { status: 200, headers: { "content-type": "application/json" } });
}

async function withoutTotalCount(response) {
  const payload = await response.json();
  delete payload.response.body.totalCount;
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("ITX admission 날짜는 KST 오늘~6일과 dayCd 요일을 검증한다", () => {
  const serviceDates = { "8": "20260715", "7": "20260718", "9": "20260719" };
  assert.deepEqual(validateItxServiceDates(serviceDates, {
    now: new Date("2026-07-14T15:00:00.000Z"),
    replay: false,
  }), serviceDates);
  assert.throws(() => validateItxServiceDates({ ...serviceDates, "8": "20260713" }, {
    now: new Date("2026-07-14T00:00:00.000Z"),
    replay: false,
  }), /today through 6 days/);
  assert.throws(() => validateItxServiceDates({ ...serviceDates, "8": "20260718" }, {
    now: new Date("2026-07-14T00:00:00.000Z"),
    replay: false,
  }), /dayCd 8 must be a weekday/);
  assert.deepEqual(validateItxServiceDates({ "8": "20260713", "7": "20260718", "9": "20260719" }, {
    now: new Date("2026-07-14T00:00:00.000Z"),
    replay: true,
  }), { "8": "20260713", "7": "20260718", "9": "20260719" });
  assert.deepEqual(validateItxServiceDates({ "8": "20270101", "7": "20270102", "9": "20270103" }, {
    now: new Date("2026-12-31T15:00:00.000Z"), replay: false,
  }), { "8": "20270101", "7": "20270102", "9": "20270103" });
  assert.deepEqual(validateItxServiceDates({ "8": "20280229", "7": "20280304", "9": "20280305" }, {
    now: new Date("2028-02-27T15:00:00.000Z"), replay: false,
  }), { "8": "20280229", "7": "20280304", "9": "20280305" });
  assert.throws(() => validateItxServiceDates({ ...serviceDates, "8": "20260722" }, {
    now: new Date("2026-07-14T00:00:00.000Z"), replay: false,
  }), /today through 6 days/);
});

test("TAGO ITX roster collector는 serviceDate와 dayCd 요일 불일치를 provider 호출 전에 거부한다", async () => {
  await assert.rejects(collectTagoItxCheongchunRoster({
    serviceKey: "key",
    serviceDate: "20260715",
    kricServiceDayCode: "7",
    canonicalStations: canonicalRosterStations(),
    fetchImpl: async () => assert.fail("provider must not be called"),
  }), /dayCd 7 must be a Saturday/);
});

test("ITX OD matrix hash는 정렬된 service date·canonical/provider endpoint tuple로 결정된다", () => {
  const matrix = buildItxOdMatrix("20260715", [
    { providerStationId: "B" },
    { providerStationId: "A" },
  ]);
  const rows = [
    { date: "20260715", depStationId: "A", arrStationId: "B" },
    { date: "20260715", depStationId: "B", arrStationId: "A" },
  ];
  const tuples = [
    ["20260715", "A", "A", "B", "B"],
    ["20260715", "B", "B", "A", "A"],
  ];
  assert.deepEqual(matrix.rows, rows);
  assert.equal(matrix.expectedOdCount, 2);
  assert.equal(matrix.stationSetHash, sha256(JSON.stringify([["A", "A"], ["B", "B"]])));
  assert.equal(matrix.odMatrixHash, sha256(JSON.stringify(tuples)));
});

test("ITX OD matrix hash는 canonical ID가 같아도 실제 provider station ID가 바뀌면 달라진다", () => {
  const canonical = ["station-a", "station-b"];
  const first = buildItxOdMatrix("20260715", [
    { providerStationId: "NAT-A1", canonicalStationId: canonical[0] },
    { providerStationId: "NAT-B1", canonicalStationId: canonical[1] },
  ]);
  const second = buildItxOdMatrix("20260715", [
    { providerStationId: "NAT-A2", canonicalStationId: canonical[0] },
    { providerStationId: "NAT-B2", canonicalStationId: canonical[1] },
  ]);

  assert.notEqual(first.stationSetHash, second.stationSetHash);
  assert.notEqual(first.odMatrixHash, second.odMatrixHash);
});

test("ITX OD matrix hash는 같은 provider ID 집합의 canonical mapping 교환도 탐지한다", () => {
  const first = buildItxOdMatrix("20260715", [
    { providerStationId: "NAT-A", canonicalStationId: "station-a" },
    { providerStationId: "NAT-B", canonicalStationId: "station-b" },
  ]);
  const swapped = buildItxOdMatrix("20260715", [
    { providerStationId: "NAT-B", canonicalStationId: "station-a" },
    { providerStationId: "NAT-A", canonicalStationId: "station-b" },
  ]);

  assert.notEqual(first.stationSetHash, swapped.stationSetHash);
  assert.notEqual(first.odMatrixHash, swapped.odMatrixHash);
});

test("ITX train number는 digits와 명시적 ITX prefix만 허용한다", () => {
  assert.equal(normalizeTrainNumber("02001"), "2001");
  assert.equal(normalizeTrainNumber("ITX-02001"), "2001");
  assert.throws(() => normalizeTrainNumber("20O1"), /invalid train number/);
  assert.throws(() => normalizeTrainNumber("2001x"), /invalid train number/);
});

test("TAGO pairwise OD는 U/D 정차시각을 추정 없이 결정론적으로 materialize한다", () => {
  const materialized = materializeTagoItxOdRows({
    itineraries: [
      od("02001", "A", "B", "2026-07-15T08:00:00+09:00", "2026-07-15T09:00:00+09:00"),
      od("02001", "A", "C", "2026-07-15T08:00:00+09:00", "2026-07-15T10:00:00+09:00"),
      od("02001", "B", "C", "2026-07-15T09:05:00+09:00", "2026-07-15T10:00:00+09:00"),
      od("02002", "C", "B", "2026-07-15T11:00:00+09:00", "2026-07-15T12:00:00+09:00"),
      od("02002", "C", "A", "2026-07-15T11:00:00+09:00", "2026-07-15T13:00:00+09:00"),
      od("02002", "B", "A", "2026-07-15T12:05:00+09:00", "2026-07-15T13:00:00+09:00"),
    ],
    corridorStations: corridorStations(),
    serviceDate: "20260715",
    kricServiceDayCode: "8",
  });

  assert.deepEqual(materialized.trainNumbers, ["2001", "2002"]);
  assert.deepEqual(materialized.stationSequences.map(({ trainNumber, directionId, terminalVariant, observedOdCount }) => ({
    trainNumber, directionId, terminalVariant, observedOdCount,
  })), [
    { trainNumber: "2001", directionId: "up", terminalVariant: "가→다", observedOdCount: 3 },
    { trainNumber: "2002", directionId: "down", terminalVariant: "다→가", observedOdCount: 3 },
  ]);
  assert.deepEqual(materialized.transitTrips.map(({ id, routeId, serviceId, tripHeadsign }) => ({
    id, routeId, serviceId, tripHeadsign,
  })), [
    {
      id: "route-line-54a7b980b7c3-down-2002-8",
      routeId: "route-line-54a7b980b7c3-down",
      serviceId: "weekday-kric",
      tripHeadsign: "가",
    },
    {
      id: "route-line-54a7b980b7c3-up-2001-8",
      routeId: "route-line-54a7b980b7c3-up",
      serviceId: "weekday-kric",
      tripHeadsign: "다",
    },
  ]);
  assert.deepEqual(materialized.transitStopTimes.filter(({ tripId }) => tripId.includes("-up-")), [
    { tripId: "route-line-54a7b980b7c3-up-2001-8", stopSequence: 1, stationId: "A", lineId: "line-6e39be0cb6e2", arrivalSeconds: 28_800, departureSeconds: 28_800 },
    { tripId: "route-line-54a7b980b7c3-up-2001-8", stopSequence: 2, stationId: "B", lineId: "line-54a7b980b7c3", arrivalSeconds: 32_400, departureSeconds: 32_700 },
    { tripId: "route-line-54a7b980b7c3-up-2001-8", stopSequence: 3, stationId: "C", lineId: "line-54a7b980b7c3", arrivalSeconds: 36_000, departureSeconds: 36_000 },
  ]);
  assert.deepEqual(materialized.reconstructionSummary, {
    trainCount: 2,
    stopCount: 6,
    conflictingTimestampCount: 0,
    missingPairCount: 0,
    duplicateOdCount: 0,
  });
});

test("TAGO OD materialization은 duplicate·pair 누락·시각 충돌·방향 혼합을 정확한 code로 거부한다", () => {
  const base = [
    od("2001", "A", "B", "2026-07-15T08:00:00+09:00", "2026-07-15T09:00:00+09:00"),
    od("2001", "A", "C", "2026-07-15T08:00:00+09:00", "2026-07-15T10:00:00+09:00"),
    od("2001", "B", "C", "2026-07-15T09:05:00+09:00", "2026-07-15T10:00:00+09:00"),
  ];
  const input = (itineraries, stations = corridorStations()) => ({
    itineraries, corridorStations: stations, serviceDate: "20260715", kricServiceDayCode: "8",
  });

  assert.throws(() => materializeTagoItxOdRows(input([...base, base[0]])), (error) => {
    assert.match(error.message, /TAGO_OD_DUPLICATE/);
    assert.equal(error.reconstructionSummary.duplicateOdCount, 1);
    return true;
  });
  assert.throws(() => materializeTagoItxOdRows(input(base.slice(0, 2))), (error) => {
    assert.match(error.message, /TAGO_OD_PAIR_COVERAGE_INCOMPLETE/);
    assert.equal(error.reconstructionSummary.missingPairCount, 1);
    return true;
  });
  assert.throws(() => materializeTagoItxOdRows(input([
    od("2001", "A", "B", "2026-07-15T08:00:00+09:00", "2026-07-15T09:00:00+09:00"),
    od("2001", "B", "C", "2026-07-15T09:05:00+09:00", "2026-07-15T10:00:00+09:00"),
    od("2001", "C", "D", "2026-07-15T10:05:00+09:00", "2026-07-15T11:00:00+09:00"),
  ], [
    ...corridorStations(),
    { stationId: "D", nameKo: "라", corridorSequence: 4, lineId: "line-54a7b980b7c3" },
  ])), (error) => {
    assert.match(error.message, /TAGO_OD_PAIR_COVERAGE_INCOMPLETE/);
    assert.equal(error.reconstructionSummary.missingPairCount, 3);
    return true;
  });
  assert.throws(() => materializeTagoItxOdRows(input([
    base[0],
    { ...base[1], departureAt: "2026-07-15T08:01:00+09:00" },
    base[2],
  ])), (error) => {
    assert.match(error.message, /TAGO_OD_TIME_CONFLICT/);
    assert.equal(error.reconstructionSummary.conflictingTimestampCount, 1);
    return true;
  });
  assert.throws(() => materializeTagoItxOdRows(input([
    ...base,
    od("2001", "C", "A", "2026-07-15T11:00:00+09:00", "2026-07-15T13:00:00+09:00"),
  ])), /TAGO_OD_STOP_SEQUENCE_INVALID/);
  assert.throws(() => materializeTagoItxOdRows(input(base, [
    ...corridorStations(),
    { stationId: "D", nameKo: "라", corridorSequence: 2, lineId: "line-54a7b980b7c3" },
  ].map((station) => station.stationId === "C" ? { ...station, corridorSequence: 2 } : station))), /TAGO_OD_STOP_SEQUENCE_INVALID/);
});

test("TAGO OD materialization은 24:xx를 02:59까지만 허용한다", () => {
  const input = (arrivalAt) => ({
    itineraries: [od("2001", "A", "B", "2026-07-15T23:50:00+09:00", arrivalAt)],
    corridorStations: corridorStations().slice(0, 2),
    serviceDate: "20260715",
    kricServiceDayCode: "8",
  });
  const accepted = materializeTagoItxOdRows(input("2026-07-16T02:59:00+09:00"));
  assert.equal(accepted.transitStopTimes.at(-1).arrivalSeconds, 97_140);
  assert.throws(() => materializeTagoItxOdRows(input("2026-07-16T03:00:00+09:00")), /TAGO_OD_STOP_SEQUENCE_INVALID/);
});

test("TAGO catalog operation은 pagination field와 totalCount를 요구하지 않는다", async (context) => {
  for (const operation of ["GetVhcleKndList", "GetCtyCodeList"]) {
    await context.test(`${operation} totalCount 없음`, async () => {
      const fallback = validFetch();
      const artifact = await collectTagoItxCheongchunOd({
        serviceKey: "key",
        departureDate: "2026-07-14",
        kricServiceDayCode: "8",
        fetchImpl: async (url) => {
          const response = await fallback(url);
          return new URL(url).pathname.endsWith(operation) ? withoutTotalCount(response) : response;
        },
      });
      assert.deepEqual(artifact.trainNumbers, ["2001"]);
    });
  }

  await context.test("pagination query 없음", async () => {
    const fallback = validFetch();
    await collectTagoItxCheongchunOd({
      serviceKey: "key",
      departureDate: "2026-07-14",
      kricServiceDayCode: "8",
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("GetVhcleKndList") || parsed.pathname.endsWith("GetCtyCodeList")) {
          assert.equal(parsed.searchParams.has("pageNo"), false);
          assert.equal(parsed.searchParams.has("numOfRows"), false);
        }
        return fallback(url);
      },
    });
  });
});

test("TAGO ITX roster는 canonical 역의 양방향 OD 전체를 수집한다", async () => {
  const odRequests = [];
  const artifact = await collectTagoItxCheongchunRoster({
    serviceKey: "never-print-data-key",
    serviceDate: "20260715",
    kricServiceDayCode: "8",
    canonicalStations: canonicalRosterStations(),
    now: new Date("2026-07-14T00:00:00.000Z"),
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("GetVhcleKndList")) {
        return tagoResponse([{ vehiclekndid: "07", vehiclekndnm: "ITX-청춘" }]);
      }
      if (parsed.pathname.endsWith("GetCtyCodeList")) {
        return tagoResponse([{ citycode: "11", cityname: "서울" }, { citycode: "32", cityname: "강원" }]);
      }
      if (parsed.pathname.endsWith("GetCtyAcctoTrainSttnList")) {
        return parsed.searchParams.get("cityCode") === "11"
          ? tagoResponse([{ nodeid: "NAT130126", nodename: "청량리" }])
          : tagoResponse([{ nodeid: "NAT140873", nodename: "춘천" }]);
      }
      odRequests.push([
        parsed.searchParams.get("depPlaceId"),
        parsed.searchParams.get("arrPlaceId"),
      ]);
      const forward = parsed.searchParams.get("depPlaceId") === "NAT130126";
      return tagoResponse([{
        trainno: forward ? "2001" : "2002",
        traingradename: "ITX-청춘",
        depplandtime: forward ? "20260715083000" : "20260715103000",
        arrplandtime: forward ? "20260715095000" : "20260715115000",
        depplacename: forward ? "청량리" : "춘천",
        arrplacename: forward ? "춘천" : "청량리",
        adultcharge: "9800",
      }]);
    },
  });

  assert.deepEqual(odRequests, [
    ["NAT130126", "NAT140873"],
    ["NAT140873", "NAT130126"],
  ]);
  assert.equal(artifact.expectedOdCount, 2);
  assert.equal(artifact.completedOdCount, 2);
  assert.equal(artifact.failedOdCount, 0);
  assert.deepEqual(artifact.trainNumbers, ["2001", "2002"]);
  assert.match(artifact.stationSetHash, /^[a-f0-9]{64}$/);
  assert.match(artifact.odMatrixHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(artifact), /never-print-data-key/);
});

test("TAGO roster artifact는 같은 provider body와 observedAt에서 byte-identical하다", async () => {
  const input = () => ({
    serviceKey: "key",
    serviceDate: "20260715",
    kricServiceDayCode: "8",
    canonicalStations: canonicalRosterStations(),
    now: new Date("2026-07-14T00:00:00.000Z"),
    fetchImpl: validFetch(),
  });
  const first = await collectTagoItxCheongchunRoster(input());
  const second = await collectTagoItxCheongchunRoster(input());
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.evidenceHash, second.evidenceHash);
});

test("TAGO catalog는 non-paginated로 한 번만 수집하고 station·OD는 strict pagination을 유지한다", async () => {
  const catalogCalls = new Map();
  const artifact = await collectTagoItxCheongchunRoster({
    serviceKey: "key",
    serviceDate: "20260715",
    kricServiceDayCode: "8",
    canonicalStations: canonicalRosterStations(),
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      const operation = parsed.pathname.split("/").at(-1);
      if (["GetVhcleKndList", "GetCtyCodeList"].includes(operation)) {
        catalogCalls.set(operation, (catalogCalls.get(operation) ?? 0) + 1);
        assert.equal(parsed.searchParams.has("pageNo"), false);
        assert.equal(parsed.searchParams.has("numOfRows"), false);
        return tagoCatalogResponse(operation === "GetVhcleKndList"
          ? [{ vehiclekndid: "07", vehiclekndnm: "ITX-청춘" }]
          : [{ citycode: "11", cityname: "서울" }, { citycode: "32", cityname: "강원" }]);
      }
      assert.equal(parsed.searchParams.get("pageNo"), "1");
      assert.equal(parsed.searchParams.get("numOfRows"), "100");
      if (operation === "GetCtyAcctoTrainSttnList") {
        return parsed.searchParams.get("cityCode") === "11"
          ? tagoResponse([{ nodeid: "NAT130126", nodename: "청량리" }])
          : tagoResponse([{ nodeid: "NAT140873", nodename: "춘천" }]);
      }
      const reverse = parsed.searchParams.get("depPlaceId") === "NAT140873";
      return tagoResponse([{
        trainno: reverse ? "2002" : "2001",
        traingradename: "ITX-청춘",
        depplandtime: reverse ? "20260715103000" : "20260715083000",
        arrplandtime: reverse ? "20260715115000" : "20260715095000",
        depplacename: reverse ? "춘천" : "청량리",
        arrplacename: reverse ? "청량리" : "춘천",
        adultcharge: "9800",
      }]);
    },
  });

  assert.deepEqual(Object.fromEntries(catalogCalls), {
    GetVhcleKndList: 1,
    GetCtyCodeList: 1,
  });
  assert.equal(artifact.completedOdCount, 2);
});

test("TAGO ITX roster는 일시적 HTTP 응답을 OD 실패 확정 전에 최대 두 번 재시도한다", async () => {
  let forwardAttempts = 0;
  const artifact = await collectTagoItxCheongchunRoster({
    serviceKey: "key",
    serviceDate: "20260715",
    kricServiceDayCode: "8",
    canonicalStations: canonicalRosterStations(),
    now: new Date("2026-07-14T00:00:00.000Z"),
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("GetVhcleKndList")) {
        return tagoResponse([{ vehiclekndid: "07", vehiclekndnm: "ITX-청춘" }]);
      }
      if (parsed.pathname.endsWith("GetCtyCodeList")) {
        return tagoResponse([{ citycode: "11", cityname: "서울" }, { citycode: "32", cityname: "강원" }]);
      }
      if (parsed.pathname.endsWith("GetCtyAcctoTrainSttnList")) {
        return parsed.searchParams.get("cityCode") === "11"
          ? tagoResponse([{ nodeid: "NAT130126", nodename: "청량리" }])
          : tagoResponse([{ nodeid: "NAT140873", nodename: "춘천" }]);
      }
      const forward = parsed.searchParams.get("depPlaceId") === "NAT130126";
      if (forward && ++forwardAttempts < 3) return new Response("temporary", { status: 503 });
      return tagoResponse([{
        trainno: forward ? "2001" : "2002",
        traingradename: "ITX-청춘",
        depplandtime: forward ? "20260715083000" : "20260715103000",
        arrplandtime: forward ? "20260715095000" : "20260715115000",
        depplacename: forward ? "청량리" : "춘천",
        arrplacename: forward ? "춘천" : "청량리",
        adultcharge: "9800",
      }]);
    },
  });

  assert.equal(forwardAttempts, 3);
  assert.equal(artifact.completedOdCount, 2);
  assert.equal(artifact.failedOdCount, 0);
});

test("TAGO retry는 최종 503 body를 정리하고 3회에서 종료한다", async () => {
  let attempts = 0;
  let cancellations = 0;
  await assert.rejects(collectTagoItxCheongchunRoster({
    serviceKey: "key",
    serviceDate: "20260715",
    kricServiceDayCode: "8",
    canonicalStations: canonicalRosterStations(),
    fetchImpl: async () => {
      attempts += 1;
      return new Response(new ReadableStream({
        cancel() { cancellations += 1; },
      }), { status: 503 });
    },
  }), /^Error: TAGO GetVhcleKndList HTTP 503$/);
  assert.equal(attempts, 3);
  assert.equal(cancellations, 3);
});

test("TAGO retry는 최종 transport 실패까지 3회에서 종료한다", async () => {
  let attempts = 0;
  const delays = [];
  await assert.rejects(collectTagoItxCheongchunRoster({
    serviceKey: "key",
    serviceDate: "20260715",
    kricServiceDayCode: "8",
    canonicalStations: canonicalRosterStations(),
    waitImpl: async (milliseconds) => { delays.push(milliseconds); },
    fetchImpl: async () => {
      attempts += 1;
      throw new Error("socket unavailable");
    },
  }), /^Error: TAGO transport failure$/);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [250, 500]);
});

test("TAGO grade와 corridor metadata는 후속 provider quota 전에 검증한다", async (context) => {
  await context.test("invalid corridor", async () => {
    let calls = 0;
    await assert.rejects(collectTagoItxCheongchunRoster({
      serviceKey: "key",
      serviceDate: "20260715",
      kricServiceDayCode: "8",
      canonicalStations: [
        { canonicalStationId: "station-a", nameKo: "청량리", corridorSequence: 0, lineId: "line-54a7b980b7c3" },
        ...canonicalRosterStations().slice(1),
      ],
      fetchImpl: async () => { calls += 1; return assert.fail("provider must not be called"); },
    }), /canonicalStations corridor metadata is invalid/);
    assert.equal(calls, 0);
  });

  await context.test("missing grade id", async () => {
    let calls = 0;
    await assert.rejects(collectTagoItxCheongchunRoster({
      serviceKey: "key",
      serviceDate: "20260715",
      kricServiceDayCode: "8",
      canonicalStations: canonicalRosterStations(),
      fetchImpl: async () => {
        calls += 1;
        return tagoCatalogResponse([{ vehiclekndnm: "ITX-청춘" }]);
      },
    }), /vehiclekndid is required/);
    assert.equal(calls, 1);
  });
});

test("TAGO invalid train number는 OD별 failed evidence로 보존한다", async () => {
  const fallback = validFetch();
  const artifact = await collectTagoItxCheongchunRoster({
    serviceKey: "key",
    serviceDate: "20260715",
    kricServiceDayCode: "8",
    canonicalStations: canonicalRosterStations(),
    fetchImpl: async (url) => {
      const response = await fallback(url);
      const parsed = new URL(url);
      if (!parsed.pathname.endsWith("GetStrtpntAlocFndTrainInfo")
        || parsed.searchParams.get("depPlaceId") !== "NAT140873") return response;
      const payload = await response.json();
      payload.response.body.items.item[0].trainno = "ITX";
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(artifact.completedOdCount, 1);
  assert.equal(artifact.failedOdCount, 1);
  assert.equal(artifact.failedOds[0].reasonCode, "PROVIDER_SCHEMA_FAILURE");
  assert.equal(
    artifact.failedOds[0].failureContext,
    "operation=GetStrtpntAlocFndTrainInfo,reason=field_contract_mismatch",
  );
});

test("TAGO ITX roster는 OD 일부 실패를 count한 뒤 admission이 거부할 evidence를 반환한다", async () => {
  const fallback = validFetch();
  const artifact = await collectTagoItxCheongchunRoster({
    serviceKey: "key",
    serviceDate: "20260715",
    kricServiceDayCode: "8",
    canonicalStations: canonicalRosterStations(),
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("GetStrtpntAlocFndTrainInfo")
        && parsed.searchParams.get("depPlaceId") === "NAT140873") {
        return new Response("unavailable", { status: 503 });
      }
      return fallback(url);
    },
  });

  assert.equal(artifact.expectedOdCount, 2);
  assert.equal(artifact.completedOdCount, 1);
  assert.equal(artifact.failedOdCount, 1);
  assert.deepEqual(artifact.failedOds, [{
    departureStationId: "station-b",
    arrivalStationId: "station-a",
    requestCount: 3,
    reasonCode: "PROVIDER_HTTP_FAILURE",
    failureContext: "operation=GetStrtpntAlocFndTrainInfo,httpStatus=503",
  }]);
  assert.equal(artifact.quotaSummary.odRequestCount, 4);
  assert.equal(artifact.quotaSummary.failedOdRequestCount, 3);
  assert.equal(
    artifact.quotaSummary.actualRequestCount,
    artifact.quotaSummary.catalogRequestCount + artifact.quotaSummary.odRequestCount,
  );
  assert.deepEqual(artifact.trainNumbers, ["2001"]);
});

test("TAGO ITX roster는 non-retryable 4xx를 HTTP failure로 기록한다", async () => {
  const fallback = validFetch();
  const artifact = await collectTagoItxCheongchunRoster({
    serviceKey: "key",
    serviceDate: "20260715",
    kricServiceDayCode: "8",
    canonicalStations: canonicalRosterStations(),
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("GetStrtpntAlocFndTrainInfo")
        && parsed.searchParams.get("depPlaceId") === "NAT140873") {
        return new Response("not found", { status: 404 });
      }
      return fallback(url);
    },
  });

  assert.equal(artifact.failedOdCount, 1);
  assert.equal(artifact.failedOds[0].reasonCode, "PROVIDER_HTTP_FAILURE");
  assert.equal(
    artifact.failedOds[0].failureContext,
    "operation=GetStrtpntAlocFndTrainInfo,httpStatus=404",
  );
});

test("TAGO content-type mismatch는 응답 body를 취소한다", async () => {
  const fallback = validFetch();
  let cancellations = 0;
  const artifact = await collectTagoItxCheongchunRoster({
    serviceKey: "key",
    serviceDate: "20260715",
    kricServiceDayCode: "8",
    canonicalStations: canonicalRosterStations(),
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("GetStrtpntAlocFndTrainInfo")
        && parsed.searchParams.get("depPlaceId") === "NAT140873") {
        return new Response(new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode("not-json")); },
          cancel() { cancellations += 1; },
        }), { status: 200, headers: { "content-type": "text/plain" } });
      }
      return fallback(url);
    },
  });

  assert.equal(cancellations, 1);
  assert.equal(artifact.failedOdCount, 1);
  assert.equal(artifact.failedOds[0].reasonCode, "PROVIDER_SCHEMA_FAILURE");
});

test("TAGO 공유 quota는 paginated OD의 실제 retry attempt마다 차감한다", async () => {
  const fallback = validFetch();
  const attempts = new Map();
  let actualRequestCount = 0;
  await assert.rejects(collectTagoItxCheongchunRoster({
    serviceKey: "key",
    serviceDate: "20260715",
    kricServiceDayCode: "8",
    canonicalStations: canonicalRosterStations(),
    requestBudget: { limit: 10, remaining: 10 },
    fetchImpl: async (url) => {
      actualRequestCount += 1;
      const parsed = new URL(url);
      if (!parsed.pathname.endsWith("GetStrtpntAlocFndTrainInfo")
        || parsed.searchParams.get("depPlaceId") !== "NAT130126") return fallback(url);
      const pageNo = parsed.searchParams.get("pageNo");
      const count = (attempts.get(pageNo) ?? 0) + 1;
      attempts.set(pageNo, count);
      if (count < 3) return new Response("retry", { status: 503 });
      const row = {
        trainno: "2001", traingradename: "ITX-청춘",
        depplandtime: "20260715083000", arrplandtime: "20260715095000",
        depplacename: "청량리", arrplacename: "춘천", adultcharge: "9800",
      };
      return tagoResponse(pageNo === "1" ? Array.from({ length: 100 }, () => row) : [row], 101);
    },
  }), /TAGO_QUOTA_BUDGET_EXHAUSTED/);
  assert.equal(actualRequestCount, 10);
  assert.deepEqual([...attempts.values()], [3, 3]);
});

test("TAGO materialization 실패는 완료된 OD matrix evidence를 error에 보존한다", async () => {
  const names = new Map([["A", "청량리"], ["B", "평내호평"], ["C", "춘천"]]);
  const times = new Map([
    ["A:B", ["080000", "090000"]],
    ["A:C", ["080100", "100000"]],
    ["B:C", ["090500", "100000"]],
    ["C:B", ["110000", "120000"]],
    ["C:A", ["110000", "130000"]],
    ["B:A", ["120500", "130000"]],
  ]);
  await assert.rejects(collectTagoItxCheongchunRoster({
    serviceKey: "key",
    serviceDate: "20260715",
    kricServiceDayCode: "8",
    canonicalStations: [...names].map(([canonicalStationId, nameKo], index) => ({
      canonicalStationId, nameKo, corridorSequence: index + 1, lineId: "line-54a7b980b7c3",
    })),
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("GetVhcleKndList")) {
        return tagoCatalogResponse([{ vehiclekndid: "07", vehiclekndnm: "ITX-청춘" }]);
      }
      if (parsed.pathname.endsWith("GetCtyCodeList")) {
        return tagoCatalogResponse([{ citycode: "11", cityname: "수도권" }]);
      }
      if (parsed.pathname.endsWith("GetCtyAcctoTrainSttnList")) {
        return tagoResponse([...names].map(([nodeid, nodename]) => ({ nodeid, nodename })));
      }
      const departure = parsed.searchParams.get("depPlaceId");
      const arrival = parsed.searchParams.get("arrPlaceId");
      const [departureTime, arrivalTime] = times.get(`${departure}:${arrival}`);
      return tagoResponse([{
        trainno: departure < arrival ? "2001" : "2002",
        traingradename: "ITX-청춘",
        depplandtime: `20260715${departureTime}`,
        arrplandtime: `20260715${arrivalTime}`,
        depplacename: names.get(departure),
        arrplacename: names.get(arrival),
        adultcharge: "9800",
      }]);
    },
  }), (error) => {
    assert.match(error.message, /TAGO_OD_TIME_CONFLICT/);
    assert.equal(error.rosterEvidence.expectedOdCount, 6);
    assert.equal(error.rosterEvidence.completedOdCount, 6);
    assert.equal(error.rosterEvidence.failedOdCount, 0);
    assert.match(error.rosterEvidence.stationSetHash, /^[a-f0-9]{64}$/);
    assert.match(error.rosterEvidence.odMatrixHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(error.rosterEvidence.reconstructionSummary, {
      trainCount: 2,
      stopCount: 0,
      conflictingTimestampCount: 1,
      missingPairCount: 0,
      duplicateOdCount: 0,
    });
    return true;
  });
});

test("TAGO 필수 역 mapping 누락은 Unicode-safe 역 이름을 보존한다", async () => {
  await assert.rejects(collectTagoItxCheongchunRoster({
    serviceKey: "key",
    serviceDate: "20260715",
    kricServiceDayCode: "8",
    canonicalStations: canonicalRosterStations(),
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("GetVhcleKndList")) {
        return tagoCatalogResponse([{ vehiclekndid: "07", vehiclekndnm: "ITX-청춘" }]);
      }
      if (parsed.pathname.endsWith("GetCtyCodeList")) {
        return tagoCatalogResponse([
          { citycode: "11", cityname: "서울" },
          { citycode: "32", cityname: "강원" },
        ]);
      }
      if (parsed.pathname.endsWith("GetCtyAcctoTrainSttnList")) {
        return parsed.searchParams.get("cityCode") === "11"
          ? tagoResponse([{ nodeid: "NAT130126", nodename: "청량리" }])
          : tagoResponse([]);
      }
      return assert.fail("OD provider must not be called");
    },
  }), /TAGO required station mapping is incomplete: 춘천/);
});

test("TAGO ITX roster는 공식 totalCount가 없는 OD 응답을 완료로 세지 않는다", async () => {
  const fallback = validFetch();
  const artifact = await collectTagoItxCheongchunRoster({
    serviceKey: "key",
    serviceDate: "20260715",
    kricServiceDayCode: "8",
    canonicalStations: canonicalRosterStations(),
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("GetStrtpntAlocFndTrainInfo")
        && parsed.searchParams.get("depPlaceId") === "NAT140873") {
        const response = await fallback(url);
        const payload = await response.json();
        delete payload.response.body.totalCount;
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return fallback(url);
    },
  });

  assert.equal(artifact.expectedOdCount, 2);
  assert.equal(artifact.completedOdCount, 1);
  assert.equal(artifact.failedOdCount, 1);
  assert.deepEqual(artifact.failedOds, [{
    departureStationId: "station-b",
    arrivalStationId: "station-a",
    requestCount: 1,
    reasonCode: "PROVIDER_SCHEMA_FAILURE",
    failureContext: "operation=GetStrtpntAlocFndTrainInfo,reason=schema_mismatch,totalCount,bodyFields=items,numOfRows,pageNo",
  }]);
  assert.deepEqual(artifact.trainNumbers, ["2001"]);
});

test("TAGO paginated schema mismatch는 값 없이 정렬된 body field만 진단한다", async () => {
  const fallback = validFetch();
  await assert.rejects(collectTagoItxCheongchunRoster({
    serviceKey: "key",
    serviceDate: "20260715",
    kricServiceDayCode: "8",
    canonicalStations: canonicalRosterStations(),
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      const response = await fallback(url);
      if (!parsed.pathname.endsWith("GetCtyAcctoTrainSttnList")) return response;
      const payload = await response.json();
      delete payload.response.body.totalCount;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  }), /^Error: TAGO GetCtyAcctoTrainSttnList schema mismatch: totalCount bodyFields=items,numOfRows,pageNo$/);
});

test("TAGO ITX roster는 요청과 다른 OD·날짜 응답을 완료로 세지 않는다", async (context) => {
  await context.test("요청일 02:59는 제외하고 03:00은 포함", async () => {
    const fallback = validFetch();
    const artifact = await collectTagoItxCheongchunRoster({
      serviceKey: "key",
      serviceDate: "20260715",
      kricServiceDayCode: "8",
      canonicalStations: canonicalRosterStations(),
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        const response = await fallback(url);
        if (!parsed.pathname.endsWith("GetStrtpntAlocFndTrainInfo")
          || parsed.searchParams.get("depPlaceId") !== "NAT130126") return response;
        const payload = await response.json();
        const row = payload.response.body.items.item[0];
        payload.response.body.items.item = [
          { ...row, trainno: "2034", depplandtime: "20260715025900", arrplandtime: "20260715030400" },
          { ...row, trainno: "2035", depplandtime: "20260715030000", arrplandtime: "20260715030500" },
        ];
        payload.response.body.totalCount = 2;
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.equal(artifact.trainNumbers.includes("2034"), false);
    assert.equal(artifact.trainNumbers.includes("2035"), true);
  });

  await context.test("제외될 요청일 02:59 row도 schema와 station을 먼저 검증", async () => {
    const fallback = validFetch();
    const artifact = await collectTagoItxCheongchunRoster({
      serviceKey: "key",
      serviceDate: "20260715",
      kricServiceDayCode: "8",
      canonicalStations: canonicalRosterStations(),
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        const response = await fallback(url);
        if (!parsed.pathname.endsWith("GetStrtpntAlocFndTrainInfo")
          || parsed.searchParams.get("depPlaceId") !== "NAT130126") return response;
        const payload = await response.json();
        const row = payload.response.body.items.item[0];
        payload.response.body.items.item = [
          { ...row, depplandtime: "20260715025900", arrplandtime: "20260715030400", depplacename: "잘못된역" },
          { ...row, depplandtime: "20260715030000", arrplandtime: "20260715030500" },
        ];
        payload.response.body.totalCount = 2;
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.equal(artifact.failedOdCount, 1);
    assert.equal(
      artifact.failedOds[0].failureContext,
      "operation=GetStrtpntAlocFndTrainInfo,reason=station_mismatch",
    );
  });

  await context.test("익일 02:59 출발은 26:59 service time으로 허용", async () => {
    const fallback = validFetch();
    const artifact = await collectTagoItxCheongchunRoster({
      serviceKey: "key",
      serviceDate: "20260715",
      kricServiceDayCode: "8",
      canonicalStations: canonicalRosterStations(),
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        const response = await fallback(url);
        if (!parsed.pathname.endsWith("GetStrtpntAlocFndTrainInfo")
          || parsed.searchParams.get("depPlaceId") !== "NAT140873") return response;
        const payload = await response.json();
        payload.response.body.items.item[0].depplandtime = "20260716025900";
        payload.response.body.items.item[0].arrplandtime = "20260716025930";
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.equal(artifact.completedOdCount, 2);
    assert.equal(artifact.failedOdCount, 0);
    const tripId = artifact.transitTrips.find(({ id }) => id.includes("-down-2002-"))?.id;
    assert.equal(
      artifact.transitStopTimes.find(({ tripId: value, stopSequence }) => value === tripId && stopSequence === 1)?.departureSeconds,
      97_140,
    );
  });

  await context.test("열차 2035의 요청일·익일 occurrence 중 익일 행만 요청 service day에 포함", async () => {
    const fallback = validFetch();
    const artifact = await collectTagoItxCheongchunRoster({
      serviceKey: "key",
      serviceDate: "20260715",
      kricServiceDayCode: "8",
      canonicalStations: canonicalRosterStations(),
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        const response = await fallback(url);
        if (!parsed.pathname.endsWith("GetStrtpntAlocFndTrainInfo")
          || parsed.searchParams.get("depPlaceId") !== "NAT130126") return response;
        const payload = await response.json();
        const row = payload.response.body.items.item[0];
        payload.response.body.items.item = [
          { ...row, trainno: "2035", depplandtime: "20260715000100", arrplandtime: "20260715000400" },
          { ...row, trainno: "2035", depplandtime: "20260716000100", arrplandtime: "20260716000400" },
        ];
        payload.response.body.totalCount = 2;
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.equal(artifact.failedOdCount, 0);
    assert.equal(artifact.itineraries.filter(({ trainNumber }) => trainNumber === "2035").length, 1);
    assert.equal(
      artifact.itineraries.find(({ trainNumber }) => trainNumber === "2035")?.departureAt,
      "2026-07-16T00:01:00+09:00",
    );
  });

  await context.test("partition 내부의 진짜 duplicate는 계속 거부", async () => {
    const fallback = validFetch();
    await assert.rejects(collectTagoItxCheongchunRoster({
      serviceKey: "key",
      serviceDate: "20260715",
      kricServiceDayCode: "8",
      canonicalStations: canonicalRosterStations(),
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        const response = await fallback(url);
        if (!parsed.pathname.endsWith("GetStrtpntAlocFndTrainInfo")
          || parsed.searchParams.get("depPlaceId") !== "NAT130126") return response;
        const payload = await response.json();
        const row = {
          ...payload.response.body.items.item[0],
          trainno: "2035",
          depplandtime: "20260716000100",
          arrplandtime: "20260716000400",
        };
        payload.response.body.items.item = [row, { ...row }];
        payload.response.body.totalCount = 2;
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    }), /TAGO_OD_DUPLICATE/);
  });

  for (const scenario of [
    {
      name: "요청과 다른 역",
      failureContext: "operation=GetStrtpntAlocFndTrainInfo,reason=station_mismatch",
      mutate: (payload) => {
        payload.response.body.items.item[0].depplacename = "청량리";
      },
    },
    {
      name: "익일 03:00 출발",
      failureContext: "operation=GetStrtpntAlocFndTrainInfo,reason=date_mismatch",
      mutate: (payload) => {
        payload.response.body.items.item[0].depplandtime = "20260716030000";
        payload.response.body.items.item[0].arrplandtime = "20260716031000";
      },
    },
    {
      name: "요청과 다른 날짜",
      failureContext: "operation=GetStrtpntAlocFndTrainInfo,reason=date_mismatch",
      mutate: (payload) => {
        payload.response.body.items.item[0].depplandtime = "20260714083000";
        payload.response.body.items.item[0].arrplandtime = "20260714095000";
      },
    },
  ]) {
    await context.test(scenario.name, async () => {
      const fallback = validFetch();
      const artifact = await collectTagoItxCheongchunRoster({
        serviceKey: "key",
        serviceDate: "20260715",
        kricServiceDayCode: "8",
        canonicalStations: canonicalRosterStations(),
        fetchImpl: async (url) => {
          const parsed = new URL(url);
          const response = await fallback(url);
          if (!parsed.pathname.endsWith("GetStrtpntAlocFndTrainInfo")
            || parsed.searchParams.get("depPlaceId") !== "NAT140873") return response;
          const payload = await response.json();
          scenario.mutate(payload);
          return new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });

      assert.equal(artifact.completedOdCount, 1);
      assert.equal(artifact.failedOdCount, 1);
      assert.equal(artifact.failedOds[0].reasonCode, "PROVIDER_SCHEMA_FAILURE");
      assert.equal(artifact.failedOds[0].failureContext, scenario.failureContext);
    });
  }
});

test("TAGO roster matrix는 provider station catalog와 canonical 경춘선의 교집합을 증명한다", async () => {
  const artifact = await collectTagoItxCheongchunRoster({
    serviceKey: "key",
    serviceDate: "20260715",
    kricServiceDayCode: "8",
    canonicalStations: [
      { canonicalStationId: "station-x", nameKo: "회기", corridorSequence: 3, lineId: "line-54a7b980b7c3" },
      ...canonicalRosterStations(),
    ],
    fetchImpl: validFetch(),
  });

  assert.equal(artifact.canonicalStationCount, 3);
  assert.equal(artifact.rosterStationCount, 2);
  assert.deepEqual(artifact.excludedCanonicalStations, [
    { canonicalStationId: "station-x", nameKo: "회기", reasonCode: "NOT_IN_TAGO_TRAIN_STATION_CATALOG" },
  ]);
  assert.equal(artifact.expectedOdCount, 2);
});

test("TAGO ITX-청춘 probe는 grade·station·OD를 연결하고 secret을 제거한다", async () => {
  const secret = "never-print-data-key";
  const artifact = await collectTagoItxCheongchunOd({
    serviceKey: secret,
    departureDate: "2026-07-14",
    kricServiceDayCode: "8",
    now: new Date("2026-07-13T00:00:00.000Z"),
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("serviceKey"), secret);
      if (parsed.pathname.endsWith("GetVhcleKndList")) {
        return tagoResponse([{ vehiclekndid: "07", vehiclekndnm: "ITX-청춘" }]);
      }
      if (parsed.pathname.endsWith("GetCtyCodeList")) {
        return tagoResponse([{ citycode: "11", cityname: "서울" }, { citycode: "32", cityname: "강원" }]);
      }
      if (parsed.pathname.endsWith("GetCtyAcctoTrainSttnList")) {
        return parsed.searchParams.get("cityCode") === "11"
          ? tagoResponse([{ nodeid: "NAT130126", nodename: "청량리" }])
          : tagoResponse([{ nodeid: "NAT140873", nodename: "춘천" }]);
      }
      return tagoResponse([{
        trainno: "2001", traingradename: "ITX-청춘", depplandtime: "20260714083000",
        arrplandtime: "20260714095000", depplacename: "청량리", arrplacename: "춘천", adultcharge: "9800",
      }]);
    },
  });

  assert.deepEqual(artifact.trainGrade, { code: "07", name: "ITX-청춘", serviceId: "ITX_CHEONGCHUN" });
  assert.equal(artifact.departureStation.providerStationId, "NAT130126");
  assert.equal(artifact.arrivalStation.providerStationId, "NAT140873");
  assert.deepEqual(artifact.trainNumbers, ["2001"]);
  assert.equal(artifact.kricServiceDayCode, "8");
  assert.equal(artifact.itineraries[0].adultFareWon, 9800);
  assert.equal(artifact.pickupDropoff.status, "EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE");
  assert.doesNotMatch(JSON.stringify(artifact), new RegExp(secret));
});

function od(trainNumber, departureStationId, arrivalStationId, departureAt, arrivalAt) {
  return { trainNumber, departureStationId, arrivalStationId, departureAt, arrivalAt };
}

function corridorStations() {
  return [
    { stationId: "A", nameKo: "가", corridorSequence: 1, lineId: "line-6e39be0cb6e2" },
    { stationId: "B", nameKo: "나", corridorSequence: 2, lineId: "line-54a7b980b7c3" },
    { stationId: "C", nameKo: "다", corridorSequence: 3, lineId: "line-54a7b980b7c3" },
  ];
}

function canonicalRosterStations() {
  return [
    { canonicalStationId: "station-a", nameKo: "청량리", corridorSequence: 1, lineId: "line-54a7b980b7c3" },
    { canonicalStationId: "station-b", nameKo: "춘천", corridorSequence: 2, lineId: "line-54a7b980b7c3" },
  ];
}

test("TAGO ITX-청춘 probe는 grade 없음·provider failure·역순 시간을 거부한다", async (context) => {
  await context.test("KRIC service day code missing", async () => {
    await assert.rejects(collectTagoItxCheongchunOd({
      serviceKey: "key", departureDate: "2026-07-14",
    }), /kricServiceDayCode must be 7, 8, or 9/);
  });
  await context.test("grade missing", async () => {
    await assert.rejects(collectTagoItxCheongchunOd({
      serviceKey: "key", departureDate: "2026-07-14", kricServiceDayCode: "8",
      fetchImpl: async () => tagoResponse([{ vehiclekndid: "00", vehiclekndnm: "KTX" }]),
    }), /ITX-청춘 train grade is missing/);
  });
  await context.test("provider failure", async () => {
    await assert.rejects(collectTagoItxCheongchunOd({
      serviceKey: "key", departureDate: "2026-07-14", kricServiceDayCode: "8",
      fetchImpl: async () => new Response(JSON.stringify({ response: { header: { resultCode: "99" } } }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    }), /provider resultCode 99/);
  });
  await context.test("duplicate train number", async () => {
    await assert.rejects(collectTagoItxCheongchunOd({
      serviceKey: "key", departureDate: "2026-07-14", kricServiceDayCode: "8",
      fetchImpl: validFetch({ duplicateOd: true }),
    }), /duplicate train number/);
  });
  await context.test("arrival before departure", async () => {
    await assert.rejects(collectTagoItxCheongchunOd({
      serviceKey: "key", departureDate: "2026-07-14", kricServiceDayCode: "8",
      fetchImpl: validFetch({ reverseTime: true }),
    }), /arrival must follow departure/);
  });
});

function validFetch({ duplicateOd = false, reverseTime = false } = {}) {
  return async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("GetVhcleKndList")) {
      return tagoResponse([{ vehiclekndid: "07", vehiclekndnm: "ITX-청춘" }]);
    }
    if (parsed.pathname.endsWith("GetCtyCodeList")) {
      return tagoResponse([{ citycode: "11", cityname: "서울" }, { citycode: "32", cityname: "강원" }]);
    }
    if (parsed.pathname.endsWith("GetCtyAcctoTrainSttnList")) {
      return parsed.searchParams.get("cityCode") === "11"
        ? tagoResponse([{ nodeid: "NAT130126", nodename: "청량리" }])
        : tagoResponse([{ nodeid: "NAT140873", nodename: "춘천" }]);
    }
    const reverse = parsed.searchParams.get("depPlaceId") === "NAT140873";
    const serviceDate = parsed.searchParams.get("depPlandTime") ?? "20260714";
    const row = {
      trainno: reverse ? "2002" : "2001",
      traingradename: "ITX-청춘",
      depplandtime: `${serviceDate}${reverse ? "103000" : "083000"}`,
      arrplandtime: reverseTime
        ? `${serviceDate}082000`
        : `${serviceDate}${reverse ? "115000" : "095000"}`,
      depplacename: reverse ? "춘천" : "청량리",
      arrplacename: reverse ? "청량리" : "춘천",
      adultcharge: "9800",
    };
    return tagoResponse(duplicateOd ? [row, row] : [row]);
  };
}
