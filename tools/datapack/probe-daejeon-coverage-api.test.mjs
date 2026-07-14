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

test("대전 coverage probe는 odcloud row schema만 sanitized evidence로 보존한다", async () => {
  const evidence = await probeDaejeonCoverageApi({
    sourceId: "daejeon-station-distance-fare",
    serviceKey: "encoded%2Bkey",
    fetchImpl: async (url, init) => {
      assert.equal(new URL(url).searchParams.get("serviceKey"), "encoded+key");
      assert.equal(init.headers.accept, "application/json");
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

test("대전 coverage probe는 provider/schema 오류를 fail closed한다", async (context) => {
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
