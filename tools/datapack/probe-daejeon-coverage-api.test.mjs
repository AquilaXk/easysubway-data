import assert from "node:assert/strict";
import test from "node:test";

import {
  DAEJEON_COVERAGE_OPERATIONS,
  probeDaejeonCoverageApi,
} from "./probe-daejeon-coverage-api.mjs";

test("대전 coverage probe는 시간표 XML을 검증하고 credential을 제거한다", async () => {
  const secret = "never-print-this-key";
  let requestedUrl;
  const evidence = await probeDaejeonCoverageApi({
    sourceId: "daejeon-train-timetable",
    serviceKey: secret,
    fetchImpl: async (url) => {
      requestedUrl = url;
      return new Response(`<?xml version="1.0"?><response><header><resultCode>00</resultCode><resultMsg>OK</resultMsg></header><body><items><item><dayType>평일</dayType><drctType>상행</drctType><stNum>101</stNum><tmList>0530</tmList><tmZone>05</tmZone></item></items></body></response>`, {
        status: 200,
        headers: { "content-type": "application/xml" },
      });
    },
  });

  assert.equal(new URL(requestedUrl).searchParams.get("serviceKey"), secret);
  assert.equal(evidence.providerResultCode, "00");
  assert.equal(evidence.rowCount, 1);
  assert.deepEqual(evidence.outputFields, ["dayType", "drctType", "stNum", "tmList", "tmZone"]);
  assert.equal(evidence.credentialRedacted, true);
  assert.doesNotMatch(JSON.stringify(evidence), new RegExp(secret));
});

test("대전 coverage probe는 odcloud row schema만 sanitized evidence로 보존한다", async () => {
  const evidence = await probeDaejeonCoverageApi({
    sourceId: "daejeon-station-distance-fare",
    serviceKey: "encoded%2Bkey",
    fetchImpl: async (url) => {
      assert.equal(new URL(url).searchParams.get("serviceKey"), "encoded+key");
      return new Response(JSON.stringify({
        currentCount: 1,
        data: [{ "출발역": "반석", "도착역": "지족", "거리(km)": 1.2, "소요시간(분)": 2, "요금(원)": 1550 }],
        matchCount: 1,
        page: 1,
        perPage: 100,
        totalCount: 1,
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(evidence.rowCount, 1);
  assert.deepEqual(evidence.outputFields, ["거리(km)", "도착역", "소요시간(분)", "요금(원)", "출발역"]);
  assert.equal(evidence.schemaStatus, "EXPECTED");
  assert.equal("rows" in evidence, false);
});

test("대전 coverage probe는 provider/schema 오류를 fail closed한다", async (context) => {
  await context.test("XML provider failure", async () => {
    await assert.rejects(probeDaejeonCoverageApi({
      sourceId: "daejeon-train-timetable",
      serviceKey: "key",
      fetchImpl: async () => new Response("<response><header><resultCode>99</resultCode></header><body/></response>", {
        status: 200,
        headers: { "content-type": "application/xml" },
      }),
    }), /provider resultCode 99/);
  });

  await context.test("JSON schema mismatch", async () => {
    await assert.rejects(probeDaejeonCoverageApi({
      sourceId: "daejeon-braille-guide-map",
      serviceKey: "key",
      fetchImpl: async () => new Response(JSON.stringify({ data: "not-an-array" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    }), /schema mismatch/);
  });

  assert.deepEqual(Object.keys(DAEJEON_COVERAGE_OPERATIONS).sort(), [
    "daejeon-braille-guide-map",
    "daejeon-station-distance-fare",
    "daejeon-train-timetable",
  ]);
});
