import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildItxOdMatrix,
  collectTagoItxCheongchunOd,
  collectTagoItxCheongchunRoster,
  validateItxServiceDates,
} from "./collect-tago-itx-cheongchun-od.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function tagoResponse(items, totalCount = items.length) {
  return new Response(JSON.stringify({ response: {
    header: { resultCode: "00", resultMsg: "NORMAL SERVICE." },
    body: { items: { item: items }, pageNo: 1, numOfRows: 100, totalCount },
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
    canonicalStations: [
      { canonicalStationId: "station-a", nameKo: "청량리" },
      { canonicalStationId: "station-b", nameKo: "춘천" },
    ],
    fetchImpl: async () => assert.fail("provider must not be called"),
  }), /dayCd 7 must be a Saturday/);
});

test("ITX OD matrix hash는 정렬된 date·depStationId·arrStationId tuple 직렬화로 결정된다", () => {
  const matrix = buildItxOdMatrix("20260715", [
    { providerStationId: "B" },
    { providerStationId: "A" },
  ]);
  const tuples = [["20260715", "A", "B"], ["20260715", "B", "A"]];
  assert.deepEqual(matrix.rows, tuples.map(([date, depStationId, arrStationId]) => ({
    date, depStationId, arrStationId,
  })));
  assert.equal(matrix.expectedOdCount, 2);
  assert.equal(matrix.stationSetHash, sha256(JSON.stringify(["A", "B"])));
  assert.equal(matrix.odMatrixHash, sha256(JSON.stringify(tuples)));
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
    canonicalStations: [
      { canonicalStationId: "station-a", nameKo: "청량리" },
      { canonicalStationId: "station-b", nameKo: "춘천" },
    ],
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

test("TAGO ITX roster는 일시적 HTTP 응답을 OD 실패 확정 전에 한 번 재시도한다", async () => {
  let forwardAttempts = 0;
  const artifact = await collectTagoItxCheongchunRoster({
    serviceKey: "key",
    serviceDate: "20260715",
    kricServiceDayCode: "8",
    canonicalStations: [
      { canonicalStationId: "station-a", nameKo: "청량리" },
      { canonicalStationId: "station-b", nameKo: "춘천" },
    ],
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
      if (forward && ++forwardAttempts === 1) return new Response("temporary", { status: 503 });
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

  assert.equal(forwardAttempts, 2);
  assert.equal(artifact.completedOdCount, 2);
  assert.equal(artifact.failedOdCount, 0);
});

test("TAGO ITX roster는 OD 일부 실패를 count한 뒤 admission이 거부할 evidence를 반환한다", async () => {
  const fallback = validFetch();
  const artifact = await collectTagoItxCheongchunRoster({
    serviceKey: "key",
    serviceDate: "20260715",
    kricServiceDayCode: "8",
    canonicalStations: [
      { canonicalStationId: "station-a", nameKo: "청량리" },
      { canonicalStationId: "station-b", nameKo: "춘천" },
    ],
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
    departureStationId: "NAT140873",
    arrivalStationId: "NAT130126",
    reasonCode: "PROVIDER_OR_SCHEMA_FAILURE",
  }]);
  assert.deepEqual(artifact.trainNumbers, ["2001"]);
});

test("TAGO ITX roster는 공식 totalCount가 없는 OD 응답을 완료로 세지 않는다", async () => {
  const fallback = validFetch();
  const artifact = await collectTagoItxCheongchunRoster({
    serviceKey: "key",
    serviceDate: "20260715",
    kricServiceDayCode: "8",
    canonicalStations: [
      { canonicalStationId: "station-a", nameKo: "청량리" },
      { canonicalStationId: "station-b", nameKo: "춘천" },
    ],
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
    departureStationId: "NAT140873",
    arrivalStationId: "NAT130126",
    reasonCode: "PROVIDER_OR_SCHEMA_FAILURE",
  }]);
  assert.deepEqual(artifact.trainNumbers, ["2001"]);
});

test("TAGO ITX roster는 요청과 다른 OD·날짜 응답을 완료로 세지 않는다", async (context) => {
  for (const scenario of [
    {
      name: "요청과 다른 역",
      mutate: (payload) => {
        payload.response.body.items.item[0].depplacename = "청량리";
      },
    },
    {
      name: "요청과 다른 날짜",
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
        canonicalStations: [
          { canonicalStationId: "station-a", nameKo: "청량리" },
          { canonicalStationId: "station-b", nameKo: "춘천" },
        ],
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
    });
  }
});

test("TAGO roster matrix는 provider station catalog와 canonical 경춘선의 교집합을 증명한다", async () => {
  const artifact = await collectTagoItxCheongchunRoster({
    serviceKey: "key",
    serviceDate: "20260715",
    kricServiceDayCode: "8",
    canonicalStations: [
      { canonicalStationId: "station-x", nameKo: "회기" },
      { canonicalStationId: "station-a", nameKo: "청량리" },
      { canonicalStationId: "station-b", nameKo: "춘천" },
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
