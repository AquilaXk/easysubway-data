import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DAEJEON_COVERAGE_OPERATIONS,
  probeDaejeonCoverageApi,
} from "./probe-daejeon-coverage-api.mjs";

const sourceCandidates = JSON.parse(await readFile(new URL("./source-candidates.json", import.meta.url), "utf8"));
const timetableEvidence = JSON.parse(await readFile(
  new URL("./sources/daejeon-train-timetable-20260714.json", import.meta.url), "utf8",
));
const distanceFareEvidence = JSON.parse(await readFile(
  new URL("./sources/daejeon-station-distance-fare-20260714.json", import.meta.url), "utf8",
));

test("대전 coverage probe는 시간표 XML을 검증하고 credential을 제거한다", async () => {
  const secret = "never-print-this-key";
  let requestedUrl;
  const evidence = await probeDaejeonCoverageApi({
    sourceId: "daejeon-train-timetable",
    serviceKey: secret,
    now: new Date("2026-07-14T07:00:00.000Z"),
    fetchImpl: async (url, init) => {
      requestedUrl = url;
      assert.equal(init.headers.accept, "application/xml,text/xml");
      return new Response(`<?xml version="1.0"?><response><header><resultCode>00</resultCode><resultMsg>OK</resultMsg></header><body><items><item><dayType>평일</dayType><drctType>상행</drctType><stNum>101</stNum><tmList>0530</tmList><tmZone>05</tmZone></item></items></body></response>`, {
        status: 200,
        headers: { "content-type": "application/xml" },
      });
    },
  });

  assert.equal(new URL(requestedUrl).searchParams.get("serviceKey"), secret);
  assert.equal(evidence.providerResultCode, "00");
  assert.equal(evidence.observedAt, "2026-07-14T07:00:00.000Z");
  assert.equal(evidence.rowCount, 1);
  assert.deepEqual(evidence.outputFields, ["dayType", "drctType", "stNum", "tmList", "tmZone"]);
  assert.equal(evidence.credentialRedacted, true);
  assert.doesNotMatch(JSON.stringify(evidence), new RegExp(secret));
});

test("대전 coverage probe는 공식 역간 거리·시간·요금 XML schema를 검증한다", async () => {
  const evidence = await probeDaejeonCoverageApi({
    sourceId: "daejeon-station-distance-fare",
    serviceKey: "encoded%2Bkey",
    now: new Date("2026-07-14T10:42:00.000Z"),
    fetchImpl: async (url, init) => {
      assert.equal(new URL(url).searchParams.get("serviceKey"), "encoded+key");
      assert.equal(new URL(url).searchParams.get("strstnno"), "111");
      assert.equal(new URL(url).searchParams.get("endstnno"), "120");
      assert.equal(init.headers.accept, "application/xml,text/xml");
      return new Response(`<?xml version="1.0"?><response><header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header><body><items><item><distfloat>9.8</distfloat><fee>1200</fee><min>19</min><sec>50</sec></item></items><numOfRows>10</numOfRows><pageNo>1</pageNo><totalCount>1</totalCount></body></response>`, {
        status: 200,
        headers: { "content-type": "application/xml" },
      });
    },
  });

  assert.equal(evidence.observedAt, "2026-07-14T10:42:00.000Z");
  assert.equal(evidence.rowCount, 1);
  assert.equal(evidence.rawBytes > 0, true);
  assert.deepEqual(evidence.outputFields, ["distfloat", "fee", "min", "sec"]);
  assert.notEqual(evidence.outputFields,
    DAEJEON_COVERAGE_OPERATIONS["daejeon-station-distance-fare"].expectedFields);
  assert.equal(evidence.schemaStatus, "EXPECTED");
});

test("대전 역간 XML은 빈 row와 잘못된 수치를 거부한다", async (context) => {
  const cases = [
    ["empty", "<items></items>"],
    ["missing field", "<items><item><distfloat>9.8</distfloat><fee>1200</fee><min>19</min></item></items>"],
    ["missing field per item", "<items><item><distfloat>9.8</distfloat><min>19</min><sec>50</sec></item><item><distfloat>1.2</distfloat><fee>1200</fee><min>2</min><sec>10</sec></item></items>"],
    ["distance zero", "<items><item><distfloat>0</distfloat><fee>1200</fee><min>19</min><sec>50</sec></item></items>"],
    ["distance non-number", "<items><item><distfloat>NaN</distfloat><fee>1200</fee><min>19</min><sec>50</sec></item></items>"],
    ["distance infinite", "<items><item><distfloat>Infinity</distfloat><fee>1200</fee><min>19</min><sec>50</sec></item></items>"],
    ["distance exponent", "<items><item><distfloat>9.8e0</distfloat><fee>1200</fee><min>19</min><sec>50</sec></item></items>"],
    ["distance hex", "<items><item><distfloat>0x10</distfloat><fee>1200</fee><min>19</min><sec>50</sec></item></items>"],
    ["fee empty", "<items><item><distfloat>9.8</distfloat><fee></fee><min>19</min><sec>50</sec></item></items>"],
    ["minute whitespace", "<items><item><distfloat>9.8</distfloat><fee>1200</fee><min> </min><sec>50</sec></item></items>"],
    ["second empty", "<items><item><distfloat>9.8</distfloat><fee>1200</fee><min>19</min><sec></sec></item></items>"],
    ["fee exponent", "<items><item><distfloat>9.8</distfloat><fee>12e2</fee><min>19</min><sec>50</sec></item></items>"],
    ["second hex", "<items><item><distfloat>9.8</distfloat><fee>1200</fee><min>19</min><sec>0x10</sec></item></items>"],
    ["fee negative", "<items><item><distfloat>9.8</distfloat><fee>-1</fee><min>19</min><sec>50</sec></item></items>"],
    ["fee fractional", "<items><item><distfloat>9.8</distfloat><fee>1.5</fee><min>19</min><sec>50</sec></item></items>"],
    ["minute negative", "<items><item><distfloat>9.8</distfloat><fee>1200</fee><min>-1</min><sec>50</sec></item></items>"],
    ["minute fractional", "<items><item><distfloat>9.8</distfloat><fee>1200</fee><min>1.5</min><sec>50</sec></item></items>"],
    ["second negative", "<items><item><distfloat>9.8</distfloat><fee>1200</fee><min>19</min><sec>-1</sec></item></items>"],
    ["second overflow", "<items><item><distfloat>9.8</distfloat><fee>1200</fee><min>19</min><sec>60</sec></item></items>"],
    ["second fractional", "<items><item><distfloat>9.8</distfloat><fee>1200</fee><min>19</min><sec>1.5</sec></item></items>"],
  ];

  for (const [name, items] of cases) {
    await context.test(name, async () => {
      await assert.rejects(probeDaejeonCoverageApi({
        sourceId: "daejeon-station-distance-fare",
        serviceKey: "key",
        fetchImpl: async () => new Response(`<response><header><resultCode>00</resultCode></header><body>${items}</body></response>`, {
          status: 200,
          headers: { "content-type": "application/xml" },
        }),
      }), /schema mismatch/);
    });
  }
});

test("대전 열차시각표 candidate는 live XML schema만 admission하고 coverage는 계속 fail closed한다", () => {
  const candidate = sourceCandidates.candidates.find(({ id }) => id === "daejeon-train-timetable");
  assert.equal(candidate.sampleEvidenceStatus, "validated_live_sample");
  assert.equal(candidate.admissionStatus, "validated_live_schema_admitted");
  assert.equal(candidate.evidence.liveValidation.providerResultCode, "00");
  assert.equal(candidate.evidence.liveValidation.rowCount, 1628);
  assert.equal(candidate.evidence.liveValidation.observedAt, "2026-07-14T07:02:58.606Z");
  assert.equal(candidate.evidence.coverageAssessment.state, "MISSING");
  assert.equal(candidate.evidence.liveValidation.evidenceArtifact,
    "tools/datapack/sources/daejeon-train-timetable-20260714.json");
  assert.equal(timetableEvidence.sourceId, candidate.id);
  assert.equal(timetableEvidence.rawSha256, candidate.evidence.liveValidation.rawSha256);
  assert.deepEqual(timetableEvidence.outputFields, candidate.evidence.outputFields);
});

test("대전 역간 candidate는 official XML만 active로 admission하고 topology는 MISSING이다", () => {
  const candidate = sourceCandidates.candidates.find(({ id }) => id === "daejeon-station-distance-fare");
  assert.equal(candidate.detailUrl, "https://www.data.go.kr/data/15158794/openapi.do");
  assert.equal(candidate.requestUrl, "https://apis.data.go.kr/B554695/TimeDistSVC/getTimeDist01");
  assert.equal(candidate.admissionStatus, "validated_live_schema_admitted");
  assert.equal(candidate.evidence.liveValidation.rowCount > 0, true);
  assert.equal(candidate.evidence.coverageAssessment.state, "MISSING");
  assert.deepEqual(candidate.evidence.coverageLimitations, [
    "대전도시철도 1호선의 역간 소요시간·거리·요금 자료",
  ]);
  assert.equal(candidate.evidence.historicalSources[0].reasonCode, "SUPERSEDED_FOR_LIVE_PROBE");
  assert.equal(candidate.evidence.historicalSources[0].runtimeEligible, false);
  assert.equal(candidate.nextAction,
    "전체 OD와 canonical station mapping을 별도 이슈에서 검증한 뒤 topology materialization을 판정한다.");
  assert.equal(distanceFareEvidence.rawSha256, candidate.evidence.liveValidation.rawSha256);
  assert.equal(distanceFareEvidence.rawBytes > 0, true);
  assert.equal(distanceFareEvidence.observedAt.startsWith("2026-07-14"), true);
  assert.equal("rows" in distanceFareEvidence, false);
  assert.equal("raw" in distanceFareEvidence, false);
  assert.equal("body" in distanceFareEvidence, false);
});

test("대전 coverage probe는 provider/schema 오류를 fail closed한다", async (context) => {
  await context.test("유효한 XML 본문도 JSON content-type이면 거부한다", async () => {
    await assert.rejects(probeDaejeonCoverageApi({
      sourceId: "daejeon-train-timetable",
      serviceKey: "key",
      fetchImpl: async () => new Response(
        `<?xml version="1.0"?><response><header><resultCode>00</resultCode><resultMsg>OK</resultMsg></header><body><items><item><dayType>평일</dayType><drctType>상행</drctType><stNum>101</stNum><tmList>0530</tmList><tmZone>05</tmZone></item></items></body></response>`,
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    }), /schema mismatch: content-type application\/json/);
  });

  await context.test("XML content-type mismatch는 credential 없는 hash 진단을 남긴다", async () => {
    const secret = "do-not-log-content-type-key";
    await assert.rejects(probeDaejeonCoverageApi({
      sourceId: "daejeon-station-distance-fare",
      serviceKey: secret,
      now: new Date("2026-07-14T10:43:00.000Z"),
      fetchImpl: async () => new Response("<response><header><resultCode>00</resultCode></header><body><items><item><distfloat>9.8</distfloat><fee>1200</fee><min>19</min><sec>50</sec></item></items></body></response>", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    }), (error) => {
      assert.match(error.message, /schema mismatch: content-type text\/plain/);
      assert.equal(error.message.match(/text\/plain/g)?.length, 1);
      assert.match(error.message, /observedAt=2026-07-14T10:43:00.000Z/);
      assert.match(error.message, /rawBytes=\d+; rawSha256=[a-f0-9]{64}/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    });
  });

  await context.test("HTTP failure는 credential 없는 HTTP/hash 진단을 남긴다", async () => {
    const secret = "do-not-log-http-key";
    await assert.rejects(probeDaejeonCoverageApi({
      sourceId: "daejeon-station-distance-fare",
      serviceKey: secret,
      now: new Date("2026-07-14T07:20:00.000Z"),
      fetchImpl: async () => new Response("forbidden", {
        status: 403,
        headers: { "content-type": "text/plain" },
      }),
    }), (error) => {
      assert.match(error.message, /HTTP 403/);
      assert.match(error.message, /observedAt=2026-07-14T07:20:00.000Z/);
      assert.match(error.message, /contentType=text\/plain; rawBytes=9; rawSha256=[a-f0-9]{64}/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    });
  });

  await context.test("XML envelope 누락은 credential 없는 HTTP/hash 진단을 남긴다", async () => {
    const secret = "do-not-log-this-key";
    await assert.rejects(probeDaejeonCoverageApi({
      sourceId: "daejeon-train-timetable",
      serviceKey: secret,
      now: new Date("2026-07-14T07:10:00.000Z"),
      fetchImpl: async () => new Response("", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    }), (error) => {
      assert.match(error.message, /provider resultCode UNKNOWN/);
      assert.match(error.message, /observedAt=2026-07-14T07:10:00.000Z/);
      assert.match(error.message, /httpStatus=200; contentType=text\/plain; rawBytes=0; rawSha256=[a-f0-9]{64}/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    });
  });

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

  assert.deepEqual(Object.keys(DAEJEON_COVERAGE_OPERATIONS).sort(), [
    "daejeon-station-distance-fare",
    "daejeon-train-timetable",
  ]);
});
