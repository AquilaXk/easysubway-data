import assert from "node:assert/strict";
import test from "node:test";

import { collectTagoItxCheongchunOd } from "./collect-tago-itx-cheongchun-od.mjs";

function tagoResponse(items, totalCount = items.length) {
  return new Response(JSON.stringify({ response: {
    header: { resultCode: "00", resultMsg: "NORMAL SERVICE." },
    body: { items: { item: items }, pageNo: 1, numOfRows: 100, totalCount },
  } }), { status: 200, headers: { "content-type": "application/json" } });
}

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
    const row = {
      trainno: "2001", traingradename: "ITX-청춘", depplandtime: "20260714083000",
      arrplandtime: reverseTime ? "20260714082000" : "20260714095000",
      depplacename: "청량리", arrplacename: "춘천", adultcharge: "9800",
    };
    return tagoResponse(duplicateOd ? [row, row] : [row]);
  };
}
