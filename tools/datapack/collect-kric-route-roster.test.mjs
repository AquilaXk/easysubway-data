import assert from "node:assert/strict";
import test from "node:test";

import { collectKricRouteRoster } from "./collect-kric-route-roster.mjs";
import { defineKricResultCodeRetryTests, defineSourceCollectionRetryTests } from "./lib/source-collection-retry-test-support.mjs";
import { createTransientRetryBudget } from "./lib/transient-retry.mjs";

const noSleep = async () => {};
const retryOptions = (sleepImpl = noSleep) => ({ retrySleepImpl: sleepImpl, retryBudget: createTransientRetryBudget(), retryRandomImpl: () => 0 });
const ITEM = "<item><lnCd>K2</lnCd><mreaWideCd>01</mreaWideCd><railOprIsttCd>KR</railOprIsttCd><routCd>K2</routCd><routNm>경춘선</routNm><stinCd>K117</stinCd><stinConsOrdr>1</stinConsOrdr><stinNm>청량리</stinNm></item>";
const xmlResponse = (resultCode, body = ITEM) => new Response(`<ROOT><header><resultCode>${resultCode}</resultCode></header><body>${body}</body></ROOT>`,
  { status: 200, headers: { "content-type": "application/xml" } });

test("KRIC route roster는 schema·순서·credential redaction을 검증한다", async () => {
  const secret = "never-print-kric-key";
  const roster = await collectKricRouteRoster({
    mreaWideCd: "01",
    lnCd: "K2",
    serviceKey: secret,
    now: new Date("2026-07-13T00:00:00.000Z"),
    fetchImpl: async (url) => {
      assert.equal(new URL(url).searchParams.get("serviceKey"), secret);
      return new Response(`<ROOT><header><resultCode>00</resultCode><resultMsg>OK</resultMsg></header><body>
        <item><lnCd>K2</lnCd><mreaWideCd>01</mreaWideCd><railOprIsttCd>KR</railOprIsttCd><routCd>K2</routCd><routNm>경춘선</routNm><stinCd>K117</stinCd><stinConsOrdr>1</stinConsOrdr><stinNm>청량리</stinNm></item>
        <item><lnCd>K2</lnCd><mreaWideCd>01</mreaWideCd><railOprIsttCd>KR</railOprIsttCd><routCd>K2</routCd><routNm>경춘선</routNm><stinCd>P140</stinCd><stinConsOrdr>2</stinConsOrdr><stinNm>춘천</stinNm></item>
      </body></ROOT>`, { status: 200, headers: { "content-type": "application/xml" } });
    },
  });

  assert.equal(roster.resultCode, "00");
  assert.equal(roster.stationCount, 2);
  assert.deepEqual(roster.stations.map(({ stinCd, stinConsOrdr }) => [stinCd, stinConsOrdr]), [["K117", 1], ["P140", 2]]);
  assert.equal(roster.credentialRedacted, true);
  assert.doesNotMatch(JSON.stringify(roster), new RegExp(secret));
});

test("KRIC route roster는 provider 실패·중복 순서·schema mismatch를 거부한다", async (context) => {
  await context.test("sanitized transport failure", async () => {
    const failure = Object.assign(new Error("never-print-kric-key"), { code: "ENOTFOUND" });
    await assert.rejects(collectKricRouteRoster({
      mreaWideCd: "01", lnCd: "K2", serviceKey: "never-print-kric-key", ...retryOptions(),
      fetchImpl: async () => { throw failure; },
    }), (error) => {
      assert.match(error.message, /transport failure; code=ENOTFOUND/);
      assert.doesNotMatch(error.message, /never-print-kric-key/);
      assert.equal(error.cause, undefined, "원본 전송 오류(URL·키가 실릴 수 있음)를 cause로 싣지 않는다");
      return true;
    });
    await assert.rejects(collectKricRouteRoster({
      mreaWideCd: "01", lnCd: "K2", serviceKey: "key", ...retryOptions(),
      fetchImpl: async () => { throw Object.assign(new Error("hidden"), { code: "ESECRET_TOKEN" }); },
    }), /transport failure; code=UNKNOWN/);
  });
  await context.test("provider failure", async () => {
    await assert.rejects(collectKricRouteRoster({
      mreaWideCd: "01", lnCd: "K2", serviceKey: "key", ...retryOptions(),
      fetchImpl: async () => xmlResponse("99", ""),
    }), /provider resultCode 99/);
  });
  await context.test("duplicate order", async () => {
    const item = "<item><lnCd>K2</lnCd><mreaWideCd>01</mreaWideCd><railOprIsttCd>KR</railOprIsttCd><routCd>K2</routCd><routNm>경춘선</routNm><stinCd>K117</stinCd><stinConsOrdr>1</stinConsOrdr><stinNm>청량리</stinNm></item>";
    await assert.rejects(collectKricRouteRoster({
      mreaWideCd: "01", lnCd: "K2", serviceKey: "key",
      fetchImpl: async () => new Response(`<ROOT><header><resultCode>00</resultCode></header><body>${item}${item}</body></ROOT>`, {
        status: 200, headers: { "content-type": "application/xml" },
      }),
    }), /duplicate station/);
  });
});

test("KRIC route roster는 다른 운영기관이 같은 역코드를 쓰는 shared line을 허용한다", async () => {
  const roster = await collectKricRouteRoster({
    mreaWideCd: "01", lnCd: "3", serviceKey: "key",
    fetchImpl: async () => new Response(`<ROOT><header><resultCode>00</resultCode></header><body>
      <item><lnCd>3</lnCd><mreaWideCd>01</mreaWideCd><railOprIsttCd>KR</railOprIsttCd><routCd>3</routCd><routNm>3호선</routNm><stinCd>309</stinCd><stinConsOrdr>1</stinConsOrdr><stinNm>대화</stinNm></item>
      <item><lnCd>3</lnCd><mreaWideCd>01</mreaWideCd><railOprIsttCd>S1</railOprIsttCd><routCd>3</routCd><routNm>3호선</routNm><stinCd>309</stinCd><stinConsOrdr>11</stinConsOrdr><stinNm>지축</stinNm></item>
    </body></ROOT>`, { status: 200, headers: { "content-type": "application/xml" } }),
  });
  assert.equal(roster.stationCount, 2);
  assert.deepEqual(roster.stations.map(({ railOprIsttCd, stinCd }) => [railOprIsttCd, stinCd]), [
    ["KR", "309"],
    ["S1", "309"],
  ]);
});

defineKricResultCodeRetryTests({
  name: "KRIC route roster",
  rejectedResponse: (resultCode) => xmlResponse(resultCode, ""),
  delegate: async () => xmlResponse("00"),
  run: ({ fetchImpl }) => collectKricRouteRoster({ mreaWideCd: "01", lnCd: "K2", serviceKey: "key", fetchImpl, ...retryOptions() }),
  assertRecovered: (roster) => assert.equal(roster.stationCount, 1),
  assertFinal: (outcome, resultCode) => assert.rejects(outcome, new RegExp(`provider resultCode ${resultCode}`, "u")),
});

test("KRIC route roster: HTTP 503은 3회까지 시도한 뒤 HTTP 오류로 실패하고 오류에 키가 없다", async () => {
  let calls = 0;
  const error = await collectKricRouteRoster({
    mreaWideCd: "01", lnCd: "K2", serviceKey: "never-print-kric-key", ...retryOptions(),
    fetchImpl: async () => { calls += 1; return new Response("down", { status: 503 }); },
  }).catch((caught) => caught);
  assert.equal(error.message, "KRIC route roster HTTP 503");
  assert.equal(calls, 3);
});

defineSourceCollectionRetryTests({
  name: "KRIC route roster",
  httpError: /KRIC route roster HTTP 403/u,
  delegate: async () => xmlResponse("00"),
  run: ({ fetchImpl, sleepImpl }) => collectKricRouteRoster({
    mreaWideCd: "01", lnCd: "K2", serviceKey: "key", now: new Date("2026-10-18T00:00:00.000Z"), fetchImpl, ...retryOptions(sleepImpl),
  }),
});
