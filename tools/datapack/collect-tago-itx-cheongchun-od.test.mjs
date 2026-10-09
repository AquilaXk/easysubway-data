import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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

test("TAGO ITX roster collector는 malformed credential로 provider를 호출하지 않는다", async () => {
  let calls = 0;
  await assert.rejects(collectTagoItxCheongchunRoster({ serviceKey: "invalid%ZZ", serviceDate: "20260715", kricServiceDayCode: "8", canonicalStations: canonicalRosterStations(), fetchImpl: async () => { calls += 1; } }), /DATA_GO_KR_SERVICE_KEY is invalid/);
  assert.equal(calls, 0);
});

test("TAGO ITX OD collector는 malformed credential로 provider를 호출하지 않는다", async () => {
  let calls = 0;
  await assert.rejects(collectTagoItxCheongchunOd({ serviceKey: "invalid%ZZ", departureDate: "2026-07-14", kricServiceDayCode: "8", now: new Date("2026-07-13T00:00:00.000Z"), fetchImpl: async () => { calls += 1; } }), /DATA_GO_KR_SERVICE_KEY is invalid/);
  assert.equal(calls, 0);
});

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

test("ITX admission 날짜는 KST 오늘~13일과 dayCd 요일을 검증한다", () => {
  const serviceDates = { "8": "20260715", "7": "20260718", "9": "20260719" };
  assert.deepEqual(validateItxServiceDates(serviceDates, {
    now: new Date("2026-07-14T15:00:00.000Z"),
    replay: false,
  }), serviceDates);
  assert.throws(() => validateItxServiceDates({ ...serviceDates, "8": "20260713" }, {
    now: new Date("2026-07-14T00:00:00.000Z"),
    replay: false,
  }), /today through 13 days/);
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
  const liveDates = { "8": "20260811", "7": "20260822", "9": "20260816" };
  assert.deepEqual(validateItxServiceDates(liveDates, {
    now: new Date("2026-08-11T09:17:00.000Z"), replay: false,
  }), liveDates);
  const upperBoundDates = { ...serviceDates, "8": "20260728" };
  assert.deepEqual(validateItxServiceDates(upperBoundDates, {
    now: new Date("2026-07-14T15:00:00.000Z"), replay: false,
  }), upperBoundDates);
  assert.throws(() => validateItxServiceDates({ ...serviceDates, "8": "20260729" }, {
    now: new Date("2026-07-14T15:00:00.000Z"), replay: false,
  }), /today through 13 days/);
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

test("TAGO ITX roster는 selected service date를 보존하고 모든 OD를 D then D+1로 조회한다", async () => {
  for (const { serviceDate, expectedQueryDates } of [
    { serviceDate: "20260731", expectedQueryDates: ["20260731", "20260801"] },
    { serviceDate: "20261231", expectedQueryDates: ["20261231", "20270101"] },
    { serviceDate: "20280229", expectedQueryDates: ["20280229", "20280301"] },
  ]) {
    const requestedDates = [];
    const fallback = validFetch({ responseServiceDate: serviceDate });
    const artifact = await collectTagoItxCheongchunRoster({
      serviceKey: "fixture-credential-must-not-leak",
      serviceDate,
      kricServiceDayCode: "8",
      canonicalStations: canonicalRosterStations(),
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("GetStrtpntAlocFndTrainInfo")) {
          requestedDates.push(parsed.searchParams.get("depPlandTime"));
        }
        return fallback(url);
      },
    });

    assert.deepEqual(requestedDates, [...expectedQueryDates, ...expectedQueryDates]);
    assert.equal(artifact.serviceDate, serviceDate);
    assert.equal(artifact.expectedOdCount, 2);
    assert.equal(artifact.completedOdCount, 2);
    assert.equal(artifact.failedOdCount, 0);
    assert.equal(artifact.credentialRedacted, true);
    assert.equal(JSON.stringify(artifact).includes("fixture-credential-must-not-leak"), false);
  }
});

test("TAGO ITX roster는 two-window row를 03:00 service day로 union materialize한다", async (context) => {
  await context.test("live incident의 D+1 next-service rows는 제외하고 D target rows는 보존한다", async () => {
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
          || parsed.searchParams.get("depPlaceId") !== "NAT130126"
          || parsed.searchParams.get("depPlandTime") !== "20260716") return response;
        const payload = await response.json();
        const row = payload.response.body.items.item[0];
        payload.response.body.items.item = [
          { ...row, trainno: "2035", depplandtime: "20260716083000", arrplandtime: "20260716095000" },
          { ...row, trainno: "2036", depplandtime: "20260717025900", arrplandtime: "20260717030400" },
        ];
        payload.response.body.totalCount = 2;
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    assert.equal(artifact.completedOdCount, 2);
    assert.equal(artifact.failedOdCount, 0);
    assert.deepEqual(artifact.trainNumbers, ["2001", "2002"]);
    assert.equal(artifact.itineraries.some(({ trainNumber }) => ["2035", "2036"].includes(trainNumber)), false);
    assert.deepEqual(artifact.calendarDateWindowInventory.slice(0, 2), [
      { queryCalendarOffset: 0, outcome: "ACCEPTED", relationCounts: { same_calendar_day: 1 } },
      {
        queryCalendarOffset: 1,
        outcome: "ACCEPTED",
        relationCounts: { next_calendar_day: 1, non_adjacent_calendar_day: 1 },
      },
    ]);
  });

  await context.test("offset 0의 유효한 D+1 row는 두 창의 exact D target set corroboration에서 제외한다", async () => {
    const fallback = validFetch();
    const requestedDates = [];
    const artifact = await collectTagoItxCheongchunRoster({
      serviceKey: "fixture-credential-must-not-leak",
      serviceDate: "20260715",
      kricServiceDayCode: "8",
      canonicalStations: canonicalRosterStations(),
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        const response = await fallback(url);
        if (!parsed.pathname.endsWith("GetStrtpntAlocFndTrainInfo")
          || parsed.searchParams.get("depPlaceId") !== "NAT130126") return response;
        requestedDates.push(parsed.searchParams.get("depPlandTime"));
        const payload = await response.json();
        const row = payload.response.body.items.item[0];
        payload.response.body.items.item = parsed.searchParams.get("depPlandTime") === "20260715"
          ? [
            row,
            { ...row, trainno: "2035", depplandtime: "20260716030000", arrplandtime: "20260716030500" },
          ]
          : [
            row,
            { ...row, trainno: "2034", depplandtime: "20260716030000", arrplandtime: "20260716030500" },
          ];
        payload.response.body.totalCount = 2;
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    assert.deepEqual(requestedDates, ["20260715", "20260716"]);
    assert.equal(artifact.completedOdCount, 2);
    assert.equal(artifact.failedOdCount, 0);
    assert.equal(artifact.quotaSummary.odRequestCount, 4);
    assert.deepEqual(artifact.trainNumbers, ["2001", "2002"]);
    assert.equal(artifact.itineraries.filter(({ trainNumber }) => ["2034", "2035"].includes(trainNumber)).length, 0);
    assert.deepEqual(artifact.calendarDateWindowInventory, [
      {
        queryCalendarOffset: 0,
        outcome: "ACCEPTED",
        relationCounts: { next_calendar_day: 1, same_calendar_day: 1 },
      },
      {
        queryCalendarOffset: 1,
        outcome: "ACCEPTED",
        relationCounts: { next_calendar_day: 1, same_calendar_day: 1 },
      },
      {
        queryCalendarOffset: 0,
        outcome: "ACCEPTED",
        relationCounts: { same_calendar_day: 1 },
      },
      {
        queryCalendarOffset: 1,
        outcome: "ACCEPTED",
        relationCounts: { same_calendar_day: 1 },
      },
    ]);
    const serializedInventory = JSON.stringify(artifact.calendarDateWindowInventory);
    for (const rawValue of ["fixture-credential-must-not-leak", "20260715", "20260716", "NAT130126", "NAT140873", "2034", "2035"]) {
      assert.equal(serializedInventory.includes(rawValue), false);
    }
  });

  await context.test("valid D+1 departure timestamp의 unrelated fare failure도 relation count에 남긴다", async () => {
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
          || parsed.searchParams.get("depPlaceId") !== "NAT130126"
          || parsed.searchParams.get("depPlandTime") !== "20260715") return response;
        const payload = await response.json();
        const row = payload.response.body.items.item[0];
        payload.response.body.items.item = [
          row,
          { ...row, trainno: "2035", depplandtime: "20260716030000", arrplandtime: "20260716030500", adultcharge: "invalid-fare" },
        ];
        payload.response.body.totalCount = 2;
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    assert.equal(artifact.completedOdCount, 1);
    assert.equal(artifact.failedOdCount, 1);
    assert.equal(artifact.failedOds[0].requestCount, 2);
    assert.equal(artifact.failedOds[0].failureContext, "operation=GetStrtpntAlocFndTrainInfo,reason=field_contract_mismatch");
    assert.deepEqual(artifact.calendarDateWindowInventory.slice(0, 2), [
      { queryCalendarOffset: 0, outcome: "REJECTED", relationCounts: { next_calendar_day: 1, same_calendar_day: 1 } },
      { queryCalendarOffset: 1, outcome: "ACCEPTED", relationCounts: { same_calendar_day: 1 } },
    ]);
  });

  await context.test("D then D+1은 같은 non-date query params로 순서대로 조회하고 adjacent observation을 제외한다", async () => {
    const odQueries = [];
    const fallback = validFetch();
    const artifact = await collectTagoItxCheongchunRoster({
      serviceKey: "key",
      serviceDate: "20260715",
      kricServiceDayCode: "8",
      canonicalStations: canonicalRosterStations(),
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("GetStrtpntAlocFndTrainInfo")) {
          odQueries.push(Object.fromEntries(parsed.searchParams));
        }
        const response = await fallback(url);
        if (!parsed.pathname.endsWith("GetStrtpntAlocFndTrainInfo")) return response;
        const payload = await response.json();
        const row = payload.response.body.items.item[0];
        const queryDate = parsed.searchParams.get("depPlandTime");
        payload.response.body.items.item = [
          row,
          queryDate === "20260715"
            ? { ...row, trainno: "2034", depplandtime: "20260714030000", arrplandtime: "20260714030500" }
            : { ...row, trainno: "2035", depplandtime: "20260716030000", arrplandtime: "20260716030500" },
        ];
        payload.response.body.totalCount = 2;
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    assert.deepEqual(odQueries.map(({ depPlandTime }) => depPlandTime), ["20260715", "20260716", "20260715", "20260716"]);
    const withoutDate = ({ depPlandTime, ...query }) => query;
    assert.deepEqual(withoutDate(odQueries[0]), withoutDate(odQueries[1]));
    assert.deepEqual(withoutDate(odQueries[2]), withoutDate(odQueries[3]));
    assert.deepEqual(withoutDate(odQueries[0]), {
      _type: "json", arrPlaceId: "NAT140873", depPlaceId: "NAT130126", numOfRows: "100", pageNo: "1", serviceKey: "key", trainGradeCode: "07",
    });
    assert.deepEqual(withoutDate(odQueries[2]), {
      _type: "json", arrPlaceId: "NAT130126", depPlaceId: "NAT140873", numOfRows: "100", pageNo: "1", serviceKey: "key", trainGradeCode: "07",
    });
    assert.equal(artifact.completedOdCount, 2);
    assert.equal(artifact.failedOdCount, 0);
    assert.equal(artifact.quotaSummary.initialOdRequestCount, 4);
    assert.equal(artifact.quotaSummary.odRequestCount, 4);
    assert.equal(artifact.operations.filter(({ operation }) => operation === "GetStrtpntAlocFndTrainInfo").length, 4);
    assert.deepEqual(artifact.calendarDateProjection, {
      contractVersion: "tago-itx-calendar-date-projection-v2",
      queryCalendarOffsets: [0, 1],
    });
    assert.deepEqual(artifact.trainNumbers, ["2001", "2002"]);
    assert.equal(artifact.itineraries.some(({ trainNumber }) => ["2034", "2035"].includes(trainNumber)), false);
  });

  await context.test("D+1 02:59 row는 requested service day target으로 union한다", async () => {
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
          || parsed.searchParams.get("depPlaceId") !== "NAT130126"
          || parsed.searchParams.get("depPlandTime") !== "20260716") return response;
        const payload = await response.json();
        payload.response.body.items.item[0].trainno = "2035";
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
    assert.equal(artifact.transitTrips.some(({ trainNo }) => trainNo === "2035"), true);
    assert.equal(artifact.itineraries.some(({ departureAt }) => departureAt === "2026-07-16T02:59:00+09:00"), true);
  });

  await context.test("cross-window extra target row는 deterministic union에 포함한다", async () => {
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
          || parsed.searchParams.get("depPlaceId") !== "NAT130126"
          || parsed.searchParams.get("depPlandTime") !== "20260716") return response;
        const payload = await response.json();
        const row = payload.response.body.items.item[0];
        payload.response.body.items.item = [row, { ...row, trainno: "2035" }];
        payload.response.body.totalCount = 2;
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.equal(artifact.completedOdCount, 2);
    assert.equal(artifact.failedOdCount, 0);
    assert.equal(artifact.itineraries.some(({ trainNumber }) => trainNumber === "2035"), true);
  });

  await context.test("cross-window target value conflict는 partial pair failure로 닫힌다", async () => {
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
            || parsed.searchParams.get("depPlaceId") !== "NAT130126"
            || parsed.searchParams.get("depPlandTime") !== "20260716") return response;
          const payload = await response.json();
          payload.response.body.items.item[0].arrplandtime = "20260715095500";
          return new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });
      assert.equal(artifact.completedOdCount, 1);
      assert.equal(artifact.failedOdCount, 1);
      assert.equal(artifact.transitTrips, undefined);
  });

  await context.test("first-window validation failure도 D then D+1 attempt를 모두 기록하고 first failure로 pair를 닫는다", async () => {
    const odDates = [];
    const fallback = validFetch();
    const artifact = await collectTagoItxCheongchunRoster({
      serviceKey: "key",
      serviceDate: "20260715",
      kricServiceDayCode: "8",
      canonicalStations: canonicalRosterStations(),
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        const response = await fallback(url);
        if (!parsed.pathname.endsWith("GetStrtpntAlocFndTrainInfo")) return response;
        odDates.push(parsed.searchParams.get("depPlandTime"));
        if (parsed.searchParams.get("depPlaceId") !== "NAT130126"
          || parsed.searchParams.get("depPlandTime") !== "20260715") return response;
        const payload = await response.json();
        payload.response.body.items.item[0].traingradename = "KTX";
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.deepEqual(odDates, ["20260715", "20260716", "20260715", "20260716"]);
    assert.equal(artifact.completedOdCount, 1);
    assert.equal(artifact.failedOdCount, 1);
    assert.equal(artifact.failedOds[0].requestCount, 2);
    assert.equal(artifact.quotaSummary.odRequestCount, 4);
    assert.equal(artifact.quotaSummary.actualRequestCount, artifact.quotaSummary.catalogRequestCount + 4);
  });

  await context.test("reverse-order multi-row window도 exact row-set equality면 한 번만 materialize한다", async () => {
    const collectWithRowOrder = async (reverseRows) => {
      const fallback = validFetch();
      return collectTagoItxCheongchunRoster({
        serviceKey: "key",
        serviceDate: "20260715",
        kricServiceDayCode: "8",
        canonicalStations: canonicalRosterStations(),
        now: new Date("2026-07-14T15:00:00.000Z"),
        fetchImpl: async (url) => {
          const parsed = new URL(url);
          const response = await fallback(url);
          if (!parsed.pathname.endsWith("GetStrtpntAlocFndTrainInfo")
            || parsed.searchParams.get("depPlaceId") !== "NAT130126") return response;
          const payload = await response.json();
          const row = payload.response.body.items.item[0];
          const rows = [row, { ...row, trainno: "2003", depplandtime: "20260715100000", arrplandtime: "20260715113000" }];
          payload.response.body.items.item = reverseRows ? rows.reverse() : rows;
          payload.response.body.totalCount = 2;
          return new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });
    };
    const artifact = await collectWithRowOrder(false);
    const reverseOrderArtifact = await collectWithRowOrder(true);
    assert.equal(artifact.completedOdCount, 2);
    assert.equal(artifact.failedOdCount, 0);
    assert.deepEqual(artifact.trainNumbers, ["2001", "2002", "2003"]);
    assert.equal(artifact.itineraries.filter(({ trainNumber }) => trainNumber === "2003").length, 1);
    assert.deepEqual(artifact.calendarDateWindowInventory, [
      { queryCalendarOffset: 0, outcome: "ACCEPTED", relationCounts: { same_calendar_day: 2 } },
      { queryCalendarOffset: 1, outcome: "ACCEPTED", relationCounts: { same_calendar_day: 2 } },
      { queryCalendarOffset: 0, outcome: "ACCEPTED", relationCounts: { same_calendar_day: 1 } },
      { queryCalendarOffset: 1, outcome: "ACCEPTED", relationCounts: { same_calendar_day: 1 } },
    ]);
    assert.deepEqual(reverseOrderArtifact.calendarDateWindowInventory, artifact.calendarDateWindowInventory);
    assert.equal(
      sha256(JSON.stringify(reverseOrderArtifact.calendarDateWindowInventory)),
      sha256(JSON.stringify(artifact.calendarDateWindowInventory)),
    );
  });

  for (const { name, queryDate, timestamp } of [
    { name: "D-1", queryDate: "20260715", timestamp: "20260714030000" },
    { name: "D+1", queryDate: "20260716", timestamp: "20260716030000" },
  ]) {
    await context.test(`malformed allowed adjacent ${name} row도 strict validation으로 fail closed한다`, async () => {
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
            || parsed.searchParams.get("depPlaceId") !== "NAT130126"
            || parsed.searchParams.get("depPlandTime") !== queryDate) return response;
          const payload = await response.json();
          payload.response.body.items.item.push({
            ...payload.response.body.items.item[0],
            trainno: "2035",
            depplandtime: timestamp,
            arrplandtime: timestamp,
          });
          payload.response.body.totalCount = 2;
          return new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });
      assert.equal(artifact.completedOdCount, 1);
      assert.equal(artifact.failedOdCount, 1);
      assert.equal(artifact.failedOds[0].failureContext, "operation=GetStrtpntAlocFndTrainInfo,reason=time_order_mismatch");
    });
  }
});

test("TAGO two-window preflight는 expected OD pair의 doubled floor 미만이면 OD 호출 전에 닫힌다", async () => {
  let odCalls = 0;
  await assert.rejects(collectTagoItxCheongchunRoster({
    serviceKey: "key",
    serviceDate: "20260715",
    kricServiceDayCode: "8",
    canonicalStations: canonicalRosterStations(),
    requestBudget: { limit: 10, remaining: 7 },
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("GetStrtpntAlocFndTrainInfo")) odCalls += 1;
      return validFetch()(url);
    },
  }), /TAGO_QUOTA_BUDGET_EXHAUSTED/);
  assert.equal(odCalls, 0);
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
    ["NAT130126", "NAT140873"],
    ["NAT140873", "NAT130126"],
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
  // anti-cheat-allow: circular-oracle -- 동일 입력 반복 호출 또는 다중 인코딩 환경에서 결정론적(deterministic) 동일 결과 검증
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  // anti-cheat-allow: circular-oracle -- 동일 입력 반복 호출 또는 다중 인코딩 환경에서 결정론적(deterministic) 동일 결과 검증
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

test("TAGO ITX roster는 일시적 HTTP 응답을 OD 실패 확정 전에 재시도한다", async () => {
  let forwardAttempts = 0;
  const artifact = await collectTagoItxCheongchunRoster({
    waitImpl: async () => {},
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

  assert.equal(forwardAttempts, 4);
  assert.equal(artifact.completedOdCount, 2);
  assert.equal(artifact.failedOdCount, 0);
});

test("TAGO 429는 server Retry-After를 operation 전체에서 정확히 한 번 따른다", async () => {
  const fallback = validFetch();
  const delays = [];
  let odRequestCount = 0;
  const artifact = await collectTagoItxCheongchunRoster({
    serviceKey: "fixture-key-must-not-leak",
    serviceDate: "20260715",
    kricServiceDayCode: "8",
    canonicalStations: canonicalRosterStations(),
    waitImpl: async (milliseconds) => { delays.push(milliseconds); },
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (!parsed.pathname.endsWith("GetStrtpntAlocFndTrainInfo")) return fallback(url);
      odRequestCount += 1;
      if (odRequestCount === 1) {
        return new Response("raw-provider-body-must-not-leak", {
          status: 429,
          headers: { "retry-after": "1" },
        });
      }
      return fallback(url);
    },
  });

  assert.deepEqual(delays, [1_000]);
  assert.equal(odRequestCount, 5);
  assert.equal(artifact.completedOdCount, 2);
  assert.equal(artifact.failedOdCount, 0);
  const serialized = JSON.stringify(artifact);
  assert.equal(serialized.includes("fixture-key-must-not-leak"), false);
  assert.equal(serialized.includes("raw-provider-body-must-not-leak"), false);
});

test("TAGO 429가 cooldown 뒤 반복되면 later window와 OD를 호출하지 않는다", async () => {
  const fallback = validFetch();
  const delays = [];
  let odRequestCount = 0;
  let captured;
  await assert.rejects(collectTagoItxCheongchunRoster({
    serviceKey: "fixture-key-must-not-leak",
    serviceDate: "20260715",
    kricServiceDayCode: "8",
    canonicalStations: canonicalRosterStations(),
    waitImpl: async (milliseconds) => { delays.push(milliseconds); },
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (!parsed.pathname.endsWith("GetStrtpntAlocFndTrainInfo")) return fallback(url);
      odRequestCount += 1;
      return new Response("raw-provider-body-must-not-leak", {
        status: 429,
        headers: { "retry-after": "1" },
      });
    },
  }), (error) => {
    captured = error;
    return error?.name === "TagoRateLimitedError"
      && error.message === "TAGO GetStrtpntAlocFndTrainInfo HTTP 429"
      && error.attemptCount === 2
      && error.cooldownUsed === true;
  });

  assert.deepEqual(delays, [1_000]);
  assert.equal(odRequestCount, 2);
  const serialized = JSON.stringify(captured);
  assert.equal(serialized.includes("fixture-key-must-not-leak"), false);
  assert.equal(serialized.includes("raw-provider-body-must-not-leak"), false);
});

test("TAGO 429의 absent·invalid·out-of-range Retry-After는 대기나 later OD 없이 닫힌다", async (context) => {
  for (const retryAfter of [null, "not-a-number", "0", "61"]) {
    await context.test(retryAfter ?? "absent", async () => {
      const fallback = validFetch();
      const delays = [];
      let odRequestCount = 0;
      let captured;
      await assert.rejects(collectTagoItxCheongchunRoster({
        serviceKey: "fixture-key-must-not-leak",
        serviceDate: "20260715",
        kricServiceDayCode: "8",
        canonicalStations: canonicalRosterStations(),
        waitImpl: async (milliseconds) => { delays.push(milliseconds); },
        fetchImpl: async (url) => {
          const parsed = new URL(url);
          if (!parsed.pathname.endsWith("GetStrtpntAlocFndTrainInfo")) return fallback(url);
          odRequestCount += 1;
          const headers = retryAfter === null ? undefined : { "retry-after": retryAfter };
          return new Response("raw-provider-body-must-not-leak", { status: 429, headers });
        },
      }), (error) => {
        captured = error;
        return error?.name === "TagoRateLimitedError"
          && error.message === "TAGO GetStrtpntAlocFndTrainInfo HTTP 429"
          && error.attemptCount === 1
          && error.cooldownUsed === false;
      });

      assert.deepEqual(delays, []);
      assert.equal(odRequestCount, 1);
      const serialized = JSON.stringify(captured);
      assert.equal(serialized.includes("fixture-key-must-not-leak"), false);
      assert.equal(serialized.includes("raw-provider-body-must-not-leak"), false);
      assert.equal(serialized.includes(retryAfter ?? "retry-after"), false);
    });
  }
});

test("TAGO retry는 최종 503 body를 정리하고 6회(첫 시도 + 재시도 5)에서 종료한다", async () => {
  let attempts = 0;
  let cancellations = 0;
  await assert.rejects(collectTagoItxCheongchunRoster({
    serviceKey: "key",
    serviceDate: "20260715",
    kricServiceDayCode: "8",
    canonicalStations: canonicalRosterStations(),
    waitImpl: async () => {},
    fetchImpl: async () => {
      attempts += 1;
      return new Response(new ReadableStream({
        cancel() { cancellations += 1; },
      }), { status: 503 });
    },
  }), /^Error: TAGO GetVhcleKndList HTTP 503$/);
  assert.equal(attempts, 6);
  assert.equal(cancellations, 6);
});

test("TAGO retry는 최종 transport 실패까지 6회에서 종료한다", async () => {
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
  assert.equal(attempts, 6);
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 16_000]);
});

// ---- #1089: TAGO 일시 오류(resultCode 99, HTTP 5xx, 전송 오류) 재시도 ----
// fixture는 itx-current-promotion run 37970736919(2026-10-09T18:05Z)의 provider-response-capture에서 꺼낸 실제 응답 바이트다.
const REAL = JSON.parse(readFileSync(new URL("./test-fixtures/tago-itx-run-37970736919-responses.json", import.meta.url), "utf8"));
const REAL_HEADERS = { "content-type": "application/json;charset=UTF-8" };
const realBody = (name) => new Response(REAL[name], { status: 200, headers: REAL_HEADERS });
const BACKOFF = [1_000, 2_000, 4_000, 8_000, 16_000];

test("fixture는 실제 실패 run의 응답 바이트와 기록된 sha256이 같다", () => {
  for (const name of ["unknownError99", "gradeList", "cityCodeList"]) {
    assert.equal(sha256(REAL[name]), REAL.sha256[name], name);
  }
  assert.equal(REAL.unknownError99, '{"header":{"resultCode":"99","resultMsg":"UNKNOWN_ERROR."}}');
});

// 실제 grade·city 응답을 쓰고, 강원(32)에만 춘천, 서울(11)에만 청량리를 둔다. failures는 operation별로 앞에서부터 소모하는 일시 오류다.
function realRosterFetch({ failures = {}, calls = [] } = {}) {
  const remaining = new Map(Object.entries(failures).map(([operation, list]) => [operation, [...list]]));
  return async (url) => {
    const parsed = new URL(url);
    const operation = parsed.pathname.split("/").at(-1);
    calls.push(operation);
    const queue = remaining.get(operation);
    if (queue?.length) {
      const next = queue.shift();
      if (next === "99") return realBody("unknownError99");
      if (next === "22") return new Response('{"header":{"resultCode":"22","resultMsg":"LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR"}}', { status: 200, headers: REAL_HEADERS });
      if (next === "503") return new Response("temporary", { status: 503 });
      if (next === "throw") throw new Error("socket unavailable");
    }
    if (operation === "GetVhcleKndList") return realBody("gradeList");
    if (operation === "GetCtyCodeList") return realBody("cityCodeList");
    if (operation === "GetCtyAcctoTrainSttnList") {
      const city = parsed.searchParams.get("cityCode");
      return tagoResponse(city === "11" ? [{ nodeid: "NAT130126", nodename: "청량리" }] : city === "32" ? [{ nodeid: "NAT140873", nodename: "춘천" }] : []);
    }
    const forward = parsed.searchParams.get("depPlaceId") === "NAT130126";
    return tagoResponse([{
      trainno: forward ? "2001" : "2002", traingradename: "ITX-청춘",
      depplandtime: forward ? "20260715083000" : "20260715103000", arrplandtime: forward ? "20260715095000" : "20260715115000",
      depplacename: forward ? "청량리" : "춘천", arrplacename: forward ? "춘천" : "청량리", adultcharge: "9800",
    }]);
  };
}

const rosterInput = (extra) => ({
  serviceKey: "fixture-credential-must-not-leak", serviceDate: "20260715", kricServiceDayCode: "8",
  canonicalStations: canonicalRosterStations(), now: new Date("2026-07-14T00:00:00.000Z"), ...extra,
});

test("TAGO resultCode 99(UNKNOWN_ERROR) 뒤에 정상 응답이 오면 같은 요청을 다시 보내 수집을 끝낸다", async () => {
  const delays = [];
  const calls = [];
  const requestBudget = { limit: 10_000, remaining: 10_000 };
  const artifact = await collectTagoItxCheongchunRoster(rosterInput({
    requestBudget, waitImpl: async (milliseconds) => { delays.push(milliseconds); },
    // 실패 run과 같은 모양: 도시 코드 목록 1회, 역 목록 1회, OD 1회 실패.
    fetchImpl: realRosterFetch({ calls, failures: { GetCtyCodeList: ["99"], GetCtyAcctoTrainSttnList: ["99"], GetStrtpntAlocFndTrainInfo: ["99"] } }),
  }));

  assert.equal(artifact.completedOdCount, 2);
  assert.equal(artifact.failedOdCount, 0);
  assert.deepEqual(delays, [1_000, 1_000, 1_000]);
  const byOperation = Object.fromEntries(artifact.operations.map(({ operation, requestCount }) => [operation, requestCount]));
  assert.equal(byOperation.GetCtyCodeList, 2, "시도 수는 재시도를 포함한 실제 요청 수다");
  assert.equal(byOperation.GetVhcleKndList, 1);
  // 일일 한도 예산은 시도마다 차감된다.
  assert.equal(requestBudget.limit - requestBudget.remaining, calls.length);
  assert.equal(artifact.quotaSummary.actualRequestCount, calls.length);
  assert.equal(JSON.stringify(artifact).includes("fixture-credential-must-not-leak"), false);
  assert.equal(JSON.stringify(artifact).includes("UNKNOWN_ERROR"), false, "실패한 시도의 본문은 증거에 남기지 않는다");
});

test("TAGO resultCode 99가 끝까지 이어지면 5번 재시도한 뒤 지금처럼 resultCode 오류로 끝난다", async () => {
  const delays = [];
  const calls = [];
  await assert.rejects(collectTagoItxCheongchunRoster(rosterInput({
    waitImpl: async (milliseconds) => { delays.push(milliseconds); },
    fetchImpl: realRosterFetch({ calls, failures: { GetCtyCodeList: Array(10).fill("99") } }),
  })), /^Error: TAGO GetCtyCodeList provider resultCode 99$/);
  assert.equal(calls.filter((operation) => operation === "GetCtyCodeList").length, 6);
  assert.deepEqual(delays, BACKOFF);
  assert.equal(calls.includes("GetCtyAcctoTrainSttnList"), false, "실패한 operation 뒤의 호출은 하지 않는다");
});

test("TAGO 99 이외의 provider 코드는 재시도하지 않는다", async () => {
  const delays = [];
  const calls = [];
  await assert.rejects(collectTagoItxCheongchunRoster(rosterInput({
    waitImpl: async (milliseconds) => { delays.push(milliseconds); },
    fetchImpl: realRosterFetch({ calls, failures: { GetCtyCodeList: ["22"] } }),
  })), /^Error: TAGO GetCtyCodeList provider resultCode 22$/);
  assert.equal(calls.filter((operation) => operation === "GetCtyCodeList").length, 1);
  assert.deepEqual(delays, []);
});

test("TAGO HTTP 5xx와 전송 오류는 같은 요청을 1·2·4·8·16초 간격으로 5번까지 다시 보낸다", async () => {
  for (const kind of ["503", "throw"]) {
    const delays = [];
    const calls = [];
    const artifact = await collectTagoItxCheongchunRoster(rosterInput({
      waitImpl: async (milliseconds) => { delays.push(milliseconds); },
      fetchImpl: realRosterFetch({ calls, failures: { GetVhcleKndList: Array(5).fill(kind) } }),
    }));
    assert.equal(artifact.completedOdCount, 2, kind);
    assert.deepEqual(delays, BACKOFF, kind);
    assert.equal(calls.filter((operation) => operation === "GetVhcleKndList").length, 6, kind);
  }
});

test("TAGO 재시도 한도는 99·5xx·전송 오류가 한 요청 안에서 함께 쓴다", async () => {
  const delays = [];
  const calls = [];
  await assert.rejects(collectTagoItxCheongchunRoster(rosterInput({
    waitImpl: async (milliseconds) => { delays.push(milliseconds); },
    fetchImpl: realRosterFetch({ calls, failures: { GetCtyCodeList: ["503", "99", "throw", "99", "503", "99", "99"] } }),
  })), /^Error: TAGO GetCtyCodeList provider resultCode 99$/);
  assert.equal(calls.filter((operation) => operation === "GetCtyCodeList").length, 6);
  assert.deepEqual(delays, BACKOFF);
});

test("TAGO 일일 요청 예산이 바닥나면 재시도하지 않고 예산 오류로 멈춘다", async () => {
  const calls = [];
  await assert.rejects(collectTagoItxCheongchunRoster(rosterInput({
    requestBudget: { limit: 10_000, remaining: 3 },
    waitImpl: async () => {},
    fetchImpl: realRosterFetch({ calls, failures: { GetCtyCodeList: Array(10).fill("99") } }),
  })), /TAGO_QUOTA_BUDGET_EXHAUSTED/);
  assert.equal(calls.length, 3, "예산 3건: 등급 1 + 도시 코드 2(첫 시도와 재시도 1)");
});

test("재시도 대기 합계는 run 단위 5분 예산을 넘지 않고, 넘기 전에 TAGO_RETRY_TIME_BUDGET_EXHAUSTED로 수집을 멈춘다 (F1)", async () => {
  const requestBudget = { limit: 10_000, remaining: 10_000 };
  const delays = [];
  const calls = [];
  // 장애가 계속되는 공급자: 카탈로그는 정상이고 모든 OD 요청이 99다. 운행일 3개가 같은 requestBudget(= 같은 run)을 쓴다.
  const outage = realRosterFetch({ calls, failures: { GetStrtpntAlocFndTrainInfo: Array(1000).fill("99") } });
  const outcomes = [];
  for (let day = 0; day < 3; day += 1) {
    try {
      outcomes.push(await collectTagoItxCheongchunRoster(rosterInput({
        requestBudget, waitImpl: async (milliseconds) => { delays.push(milliseconds); }, fetchImpl: outage,
      })));
    } catch (error) {
      outcomes.push(error);
    }
  }
  // 1·2일차: 예산 안에서 OD마다 5번 재시도한 뒤 OD 실패(MISSING 증거)로 남는다. 3일차: 예산이 닿기 전에 수집을 멈춘다.
  for (const artifact of outcomes.slice(0, 2)) {
    assert.equal(artifact.completedOdCount, 0);
    assert.equal(artifact.failedOdCount, 2);
    assert.ok(artifact.failedOds.every(({ reasonCode }) => reasonCode === "PROVIDER_RESULT_FAILURE"));
  }
  assert.ok(outcomes[2] instanceof Error);
  assert.equal(outcomes[2].message, "TAGO_RETRY_TIME_BUDGET_EXHAUSTED");
  const total = delays.reduce((sum, value) => sum + value, 0);
  assert.ok(total <= 300_000, `waited ${total}ms`);
  // 1·2일차 4요청×31초씩 248초, 3일차는 31초 + 15초(1+2+4+8)까지 기다리다 다음 16초가 예산을 넘는 순간 멈춘다.
  assert.equal(total, 294_000);
  // 최악 시간 상한: 시도 수 × 15초(요청 timeout) + 대기 합계가 가장 짧은 workflow timeout(45분)보다 짧다.
  const odAttempts = calls.filter((operation) => operation === "GetStrtpntAlocFndTrainInfo").length;
  assert.ok(odAttempts * 15_000 + total < 45 * 60_000);
  // 같은 run의 이후 호출도 남은 예산(6초)만 쓰고 합계는 끝까지 5분을 넘지 않는다.
  await assert.rejects(collectTagoItxCheongchunRoster(rosterInput({
    requestBudget, waitImpl: async (milliseconds) => { delays.push(milliseconds); }, fetchImpl: outage,
  })), /TAGO_RETRY_TIME_BUDGET_EXHAUSTED/);
  assert.ok(delays.reduce((sum, value) => sum + value, 0) <= 300_000);
});

test("재시도 시간 예산은 요청 단위 한도(5회)와 함께 쓰이며 예산 안에서는 기존 동작과 같다", async () => {
  const delays = [];
  const requestBudget = { limit: 10_000, remaining: 10_000 };
  const artifact = await collectTagoItxCheongchunRoster(rosterInput({
    requestBudget, waitImpl: async (milliseconds) => { delays.push(milliseconds); },
    fetchImpl: realRosterFetch({ failures: { GetCtyCodeList: ["99", "99", "99", "99", "99"] } }),
  }));
  assert.equal(artifact.completedOdCount, 2);
  assert.deepEqual(delays, BACKOFF);
});

test("재시도 유무와 관계없이 정상 응답의 rawResponseSha256·pageCount·evidenceHash는 서버가 준 정상 본문만으로 정해진다 (F2)", async () => {
  // 독립 oracle: fetch가 실제로 돌려준 정상(00) 본문의 sha256을 직접 기록하고, 단일 페이지 operation의 기대값 sha256(bodySha)를 여기서 계산한다.
  const withServedBodies = (inner) => {
    const served = [];
    const fetchImpl = async (url) => {
      const response = await inner(url);
      const text = await response.clone().text();
      if (response.status === 200 && JSON.parse(text)?.response?.header?.resultCode === "00") {
        served.push({ operation: new URL(url).pathname.split("/").at(-1), bodySha256: sha256(text) });
      }
      return response;
    };
    return { served, fetchImpl };
  };
  const failures = {
    GetVhcleKndList: ["99", "503"], GetCtyCodeList: ["99", "throw"], GetCtyAcctoTrainSttnList: ["99", "99"], GetStrtpntAlocFndTrainInfo: ["99", "503", "throw"],
  };
  for (const [label, scenario] of [["clean", {}], ["retried", failures]]) {
    const { served, fetchImpl } = withServedBodies(realRosterFetch({ failures: scenario }));
    const artifact = await collectTagoItxCheongchunRoster(rosterInput({ fetchImpl, waitImpl: async () => {} }));
    // 증거의 operation 순서(등급, 도시, 역…, OD…)에 맞춰 기대 해시를 만든다.
    const expectedByOperation = new Map();
    for (const { operation, bodySha256 } of served) {
      expectedByOperation.set(operation, [...(expectedByOperation.get(operation) ?? []), sha256(bodySha256)]);
    }
    assert.equal(expectedByOperation.get("GetVhcleKndList")[0], sha256(REAL.sha256.gradeList), label);
    assert.equal(expectedByOperation.get("GetCtyCodeList")[0], sha256(REAL.sha256.cityCodeList), label);
    const cursor = new Map();
    for (const operation of artifact.operations) {
      const index = cursor.get(operation.operation) ?? 0;
      cursor.set(operation.operation, index + 1);
      assert.equal(operation.rawResponseSha256, expectedByOperation.get(operation.operation)[index], `${label} ${operation.operation}`);
      assert.equal(operation.pageCount, 1, `${label} ${operation.operation}`);
    }
    // 실패한 시도의 본문(99)은 어떤 해시에도 들어가지 않는다.
    assert.equal(JSON.stringify(artifact).includes(REAL.sha256.unknownError99), false, label);
    assert.equal(JSON.stringify(artifact).includes(sha256(REAL.sha256.unknownError99)), false, label);
    // evidenceHash는 자기 자신을 뺀 증거의 sha256이다(요청 수는 실제 시도 수를 반영한다).
    const { evidenceHash, ...rest } = artifact;
    assert.equal(evidenceHash, sha256(JSON.stringify(rest)), label);
    if (label === "retried") {
      const attempts = artifact.operations.reduce((sum, { requestCount }) => sum + requestCount, 0);
      assert.equal(attempts, artifact.operations.length + 9, "재시도 9번(등급 2 + 도시 2 + 역 2 + OD 3)이 requestCount에 드러난다");
    }
  }
});

test("HTTP 408은 1초 대기 뒤 같은 요청을 다시 보낸다 (F3)", async () => {
  const delays = [];
  const calls = [];
  let first = true;
  const base = realRosterFetch({ calls });
  const artifact = await collectTagoItxCheongchunRoster(rosterInput({
    waitImpl: async (milliseconds) => { delays.push(milliseconds); },
    fetchImpl: async (url) => {
      if (new URL(url).pathname.endsWith("GetVhcleKndList") && first) { first = false; return new Response("timeout", { status: 408 }); }
      return base(url);
    },
  }));
  assert.equal(artifact.completedOdCount, 2);
  assert.deepEqual(delays, [1_000]);
  assert.equal(calls.filter((operation) => operation === "GetVhcleKndList").length, 1, "408 이후 재시도 한 번만 base에 도달");
  assert.equal(artifact.operations.find(({ operation }) => operation === "GetVhcleKndList").requestCount, 2);
});

test("본문을 읽다가 timeout·연결 끊김이 나도 같은 요청을 재시도하고, 끝까지 실패하면 transport failure다 (F4)", async () => {
  const bodyFailure = (kind) => ({
    ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }),
    body: null,
    text: async () => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: kind }); },
  });
  for (const kind of ["TimeoutError", "AbortError"]) {
    const delays = [];
    const base = realRosterFetch();
    let failures = 2;
    const artifact = await collectTagoItxCheongchunRoster(rosterInput({
      waitImpl: async (milliseconds) => { delays.push(milliseconds); },
      fetchImpl: async (url) => {
        if (new URL(url).pathname.endsWith("GetCtyCodeList") && failures > 0) { failures -= 1; return bodyFailure(kind); }
        return base(url);
      },
    }));
    assert.equal(artifact.completedOdCount, 2, kind);
    assert.deepEqual(delays, [1_000, 2_000], kind);
    assert.equal(artifact.operations.find(({ operation }) => operation === "GetCtyCodeList").requestCount, 3, kind);
  }
  const delays = [];
  const attempts = [];
  await assert.rejects(collectTagoItxCheongchunRoster(rosterInput({
    waitImpl: async (milliseconds) => { delays.push(milliseconds); },
    fetchImpl: async (url) => { attempts.push(url); return bodyFailure("TimeoutError"); },
  })), /^Error: TAGO transport failure$/);
  assert.equal(attempts.length, 6);
  assert.deepEqual(delays, BACKOFF);
});

test("TAGO OD 단독 probe도 resultCode 99를 같은 규칙으로 재시도한다", async () => {
  const delays = [];
  const failures = { GetVhcleKndList: ["99"] };
  const fetchImpl = realRosterFetch({ failures });
  const artifact = await collectTagoItxCheongchunOd({
    serviceKey: "key", departureDate: "2026-07-15", kricServiceDayCode: "8", now: new Date("2026-07-14T00:00:00.000Z"),
    waitImpl: async (milliseconds) => { delays.push(milliseconds); }, fetchImpl,
  });
  assert.deepEqual(delays, [1_000]);
  assert.equal(artifact.operations[0].requestCount, 2);
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
    waitImpl: async () => {},
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
    // D와 D+1 두 창이 각각 첫 시도 + 재시도 5번(#1089)을 쓴다.
    requestCount: 12,
    reasonCode: "PROVIDER_HTTP_FAILURE",
    failureContext: "operation=GetStrtpntAlocFndTrainInfo,httpStatus=503",
  }]);
  assert.equal(artifact.quotaSummary.odRequestCount, 14);
  assert.equal(artifact.quotaSummary.failedOdRequestCount, 12);
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

  assert.equal(cancellations, 2);
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
    waitImpl: async () => {},
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
    requestCount: 2,
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
  await context.test("요청일 02:59는 이전 service day로 제외하고 03:00은 target에 포함", async () => {
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
          || parsed.searchParams.get("depPlaceId") !== "NAT130126"
          || parsed.searchParams.get("depPlandTime") !== "20260715") return response;
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

  await context.test("익일 02:59 추가 row는 requested service day target에 포함한다", async () => {
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
        const row = payload.response.body.items.item[0];
        payload.response.body.items.item = [
          row,
          { ...row, trainno: "2035", depplandtime: "20260716025900", arrplandtime: "20260716025930" },
        ];
        payload.response.body.totalCount = 2;
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.equal(artifact.completedOdCount, 2);
    assert.equal(artifact.failedOdCount, 0);
    assert.equal(artifact.itineraries.some(({ trainNumber }) => trainNumber === "2035"), true);
  });

  await context.test("raw calendar date보다 derived service day가 target projection을 결정", async () => {
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
        payload.response.body.items.item = [parsed.searchParams.get("depPlandTime") === "20260715"
          ? { ...row, trainno: "2035", depplandtime: "20260715000100", arrplandtime: "20260715000400" }
          : { ...row, trainno: "2034", depplandtime: "20260716000100", arrplandtime: "20260716000400" }];
        payload.response.body.totalCount = 1;
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.equal(artifact.failedOdCount, 0);
    assert.equal(artifact.itineraries.filter(({ trainNumber }) => trainNumber === "2035").length, 0);
    assert.equal(
      artifact.itineraries.find(({ trainNumber }) => trainNumber === "2034")?.departureAt,
      "2026-07-16T00:01:00+09:00",
    );
  });

  await context.test("window 내부 target duplicate는 pair failure로 닫힌다", async () => {
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
          || parsed.searchParams.get("depPlaceId") !== "NAT130126"
          || parsed.searchParams.get("depPlandTime") !== "20260715") return response;
        const payload = await response.json();
        const row = {
          ...payload.response.body.items.item[0],
          trainno: "2035",
          depplandtime: "20260715083000",
          arrplandtime: "20260715095000",
        };
        payload.response.body.items.item = [row, { ...row }];
        payload.response.body.totalCount = 2;
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.equal(artifact.completedOdCount, 1);
    assert.equal(artifact.failedOdCount, 1);
  });

  for (const scenario of [
    {
      name: "요청과 다른 역",
      failureContext: "operation=GetStrtpntAlocFndTrainInfo,reason=station_mismatch",
      rawValues: ["fixture-credential-must-not-leak", "20260715", "8", "NAT140873", "NAT130126", "2002", "ITX-청춘", "춘천", "청량리", "9800"],
      mutate: (payload) => {
        payload.response.body.items.item[0].depplacename = "청량리";
      },
    },
    {
      name: "익일 03:00 추가 출발",
      expectedSuccess: true,
      mutate: (payload) => {
        const row = payload.response.body.items.item[0];
        payload.response.body.items.item = [
          row,
          { ...row, trainno: "2035", depplandtime: "20260716030000", arrplandtime: "20260716031000" },
        ];
        payload.response.body.totalCount = 2;
      },
    },
    {
      name: "요청 전일 출발",
      failureContext: "operation=GetStrtpntAlocFndTrainInfo,reason=date_mismatch,relation=previous_calendar_day,queryCalendarOffset=1",
      rawValues: ["fixture-credential-must-not-leak", "20260715", "8", "NAT140873", "NAT130126", "2002", "ITX-청춘", "춘천", "청량리", "9800", "20260714083000", "20260714095000"],
      mutate: (payload) => {
        payload.response.body.items.item[0].depplandtime = "20260714083000";
        payload.response.body.items.item[0].arrplandtime = "20260714095000";
      },
    },
    {
      name: "요청일 이틀 뒤 출발",
      failureContext: "operation=GetStrtpntAlocFndTrainInfo,reason=date_mismatch,relation=non_adjacent_calendar_day,queryCalendarOffset=0",
      rawValues: ["fixture-credential-must-not-leak", "20260715", "8", "NAT140873", "NAT130126", "2002", "ITX-청춘", "춘천", "청량리", "9800", "20260717083000", "20260717095000"],
      mutate: (payload) => {
        payload.response.body.items.item[0].depplandtime = "20260717083000";
        payload.response.body.items.item[0].arrplandtime = "20260717095000";
      },
    },
    {
      name: "불가능한 달력 날짜",
      failureContext: "operation=GetStrtpntAlocFndTrainInfo,reason=field_contract_mismatch",
      rawValues: ["fixture-credential-must-not-leak", "20260715", "8", "NAT140873", "NAT130126", "2002", "ITX-청춘", "춘천", "청량리", "9800", "20260230083000", "20260230095000"],
      mutate: (payload) => {
        payload.response.body.items.item[0].depplandtime = "20260230083000";
        payload.response.body.items.item[0].arrplandtime = "20260230095000";
      },
    },
  ]) {
    await context.test(scenario.name, async () => {
      const fallback = validFetch();
      const artifact = await collectTagoItxCheongchunRoster({
        serviceKey: "fixture-credential-must-not-leak",
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

      if (scenario.expectedSuccess) {
        assert.equal(artifact.completedOdCount, 2);
        assert.equal(artifact.failedOdCount, 0);
        assert.equal(artifact.itineraries.some(({ trainNumber }) => trainNumber === "2035"), false);
        return;
      }
      assert.equal(artifact.completedOdCount, 1);
      assert.equal(artifact.failedOdCount, 1);
      assert.equal(artifact.failedOds[0].reasonCode, "PROVIDER_SCHEMA_FAILURE");
      assert.equal(artifact.failedOds[0].failureContext, scenario.failureContext);
      assert.equal(artifact.failedOds[0].requestCount, 2);
      assert.deepEqual(Object.keys(artifact.failedOds[0]).sort(), ["arrivalStationId", "departureStationId", "failureContext", "reasonCode", "requestCount"]);
      const serializedFailure = JSON.stringify(artifact.failedOds[0]);
      assert.doesNotMatch(serializedFailure, /depplandtime|arrplandtime|serviceKey|https?:\/\//i);
      for (const rawValue of scenario.rawValues) {
        assert.equal(serializedFailure.includes(rawValue), false);
      }
    });
  }

  await context.test("D+1 query의 요청일 03:00 이전 행은 previous service day로 닫힌다", async () => {
    const fallback = validFetch();
    const artifact = await collectTagoItxCheongchunRoster({
      serviceKey: "fixture-credential-must-not-leak",
      serviceDate: "20260715",
      kricServiceDayCode: "8",
      canonicalStations: canonicalRosterStations(),
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        const response = await fallback(url);
        if (!parsed.pathname.endsWith("GetStrtpntAlocFndTrainInfo")
          || parsed.searchParams.get("depPlaceId") !== "NAT140873"
          || parsed.searchParams.get("depPlandTime") !== "20260716") return response;
        const payload = await response.json();
        payload.response.body.items.item[0].depplandtime = "20260715020000";
        payload.response.body.items.item[0].arrplandtime = "20260715021000";
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
      "operation=GetStrtpntAlocFndTrainInfo,reason=date_mismatch,relation=previous_service_day,queryCalendarOffset=1",
    );
    assert.equal(artifact.failedOds[0].requestCount, 2);
    const serializedFailure = JSON.stringify(artifact.failedOds[0]);
    assert.doesNotMatch(serializedFailure, /depplandtime|arrplandtime|serviceKey|https?:\/\//i);
    for (const rawValue of ["fixture-credential-must-not-leak", "20260715", "20260715020000", "20260715021000", "NAT140873", "NAT130126"]) {
      assert.equal(serializedFailure.includes(rawValue), false);
    }
  });

  await context.test("D+1 query date mismatch는 sanitized queryCalendarOffset=1로 닫힌다", async () => {
    const fallback = validFetch();
    const artifact = await collectTagoItxCheongchunRoster({
      serviceKey: "fixture-credential-must-not-leak",
      serviceDate: "20260715",
      kricServiceDayCode: "8",
      canonicalStations: canonicalRosterStations(),
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        const response = await fallback(url);
        if (!parsed.pathname.endsWith("GetStrtpntAlocFndTrainInfo")
          || parsed.searchParams.get("depPlaceId") !== "NAT140873"
          || parsed.searchParams.get("depPlandTime") !== "20260716") return response;
        const payload = await response.json();
        payload.response.body.items.item[0].depplandtime = "20260717030000";
        payload.response.body.items.item[0].arrplandtime = "20260717031000";
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
      "operation=GetStrtpntAlocFndTrainInfo,reason=date_mismatch,relation=non_adjacent_calendar_day,queryCalendarOffset=1",
    );
    assert.equal(artifact.failedOds[0].requestCount, 2);
    const serializedFailure = JSON.stringify(artifact.failedOds[0]);
    assert.doesNotMatch(serializedFailure, /depplandtime|arrplandtime|serviceKey|https?:\/\//i);
    for (const rawValue of ["fixture-credential-must-not-leak", "20260716", "20260717030000", "20260717031000", "NAT140873", "NAT130126"]) {
      assert.equal(serializedFailure.includes(rawValue), false);
    }
  });
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

test("TAGO ITX-청춘 probe도 catalog와 OD 전체에서 cooldown을 한 번만 사용한다", async () => {
  const fallback = validFetch({ useQueryDate: true });
  const delays = [];
  const operations = [];
  let gradeCalls = 0;
  let captured;
  await assert.rejects(collectTagoItxCheongchunOd({
    serviceKey: "fixture-key-must-not-leak",
    departureDate: "2026-07-14",
    kricServiceDayCode: "8",
    waitImpl: async (milliseconds) => { delays.push(milliseconds); },
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      const operation = parsed.pathname.split("/").at(-1);
      operations.push(operation);
      if (parsed.pathname.endsWith("GetVhcleKndList") && gradeCalls++ === 0) {
        return new Response("first-provider-body-must-not-leak", {
          status: 429,
          headers: { "retry-after": "1" },
        });
      }
      if (parsed.pathname.endsWith("GetCtyCodeList")) {
        return new Response("second-provider-body-must-not-leak", {
          status: 429,
          headers: { "retry-after": "1" },
        });
      }
      return fallback(url);
    },
  }), (error) => {
    captured = error;
    return error?.name === "TagoRateLimitedError"
      && error.message === "TAGO GetCtyCodeList HTTP 429"
      && error.attemptCount === 1
      && error.cooldownUsed === true;
  });

  assert.deepEqual(delays, [1_000]);
  assert.deepEqual(operations, ["GetVhcleKndList", "GetVhcleKndList", "GetCtyCodeList"]);
  const serialized = JSON.stringify(captured);
  for (const rawValue of [
    "fixture-key-must-not-leak",
    "first-provider-body-must-not-leak",
    "second-provider-body-must-not-leak",
  ]) {
    assert.equal(serialized.includes(rawValue), false);
  }
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
      serviceKey: "key", departureDate: "2026-07-14", kricServiceDayCode: "8", waitImpl: async () => {},
      fetchImpl: async () => new Response(JSON.stringify({ response: { header: { resultCode: "99" } } }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    }), /provider resultCode 99/);
  });
  await context.test("duplicate train number", async () => {
    await assert.rejects(collectTagoItxCheongchunOd({
      serviceKey: "key", departureDate: "2026-07-14", kricServiceDayCode: "8",
      fetchImpl: validFetch({ duplicateOd: true, useQueryDate: true }),
    }), /duplicate train number/);
  });
  await context.test("arrival before departure", async () => {
    await assert.rejects(collectTagoItxCheongchunOd({
      serviceKey: "key", departureDate: "2026-07-14", kricServiceDayCode: "8",
      fetchImpl: validFetch({ reverseTime: true, useQueryDate: true }),
    }), /arrival must follow departure/);
  });
});

function validFetch({
  duplicateOd = false,
  reverseTime = false,
  responseServiceDate = "20260715",
  useQueryDate = false,
} = {}) {
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
    const serviceDate = useQueryDate
      ? parsed.searchParams.get("depPlandTime") ?? "20260714"
      : responseServiceDate;
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
