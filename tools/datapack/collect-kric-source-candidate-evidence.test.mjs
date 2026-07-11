import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectKricSourceCandidateEvidence,
  KRIC_SOURCE_CANDIDATE_IDS,
  resolveKricCandidateRequest,
} from "./collect-kric-source-candidate-evidence.mjs";

const candidate = {
  id: "kric-train-operation-organ",
  requestUrl: "https://openapi.kric.go.kr/openapi/convenientInfo/trainOperationOrgan",
  sampleEvidenceStatus: "sample_url_documented_key_required",
  admissionStatus: "evidence_recorded_admin_review_required",
  evidence: {
    endpoint: "https://openapi.kric.go.kr/openapi/convenientInfo/trainOperationOrgan",
    sampleUrl: "https://openapi.kric.go.kr/openapi/convenientInfo/trainOperationOrgan?serviceKey=[서비스키값]&format=json&railOprIsttCd=DJ",
    formats: ["JSON", "XML"],
    outputFields: ["railOprIsttCd", "railOprIsttNm"],
  },
};

test("KRIC evidence collector는 정확한 10개 allowlist와 tracked endpoint를 강제한다", () => {
  assert.deepEqual(KRIC_SOURCE_CANDIDATE_IDS, [
    "kric-subway-route-info",
    "kric-station-info",
    "kric-train-operation-organ",
    "kric-station-transfer-info",
    "kric-station-platform",
    "kric-station-movement-standard",
    "kric-station-movement-detailed",
    "kric-transfer-movement-standard",
    "kric-transfer-movement-detailed",
    "kric-station-convenience-standard",
  ]);

  const request = resolveKricCandidateRequest({ candidates: [candidate] }, candidate.id);
  assert.equal(request.candidateId, candidate.id);
  assert.equal(request.endpoint, candidate.evidence.endpoint);
  assert.equal(request.format, "json");

  assert.throws(
    () => resolveKricCandidateRequest({ candidates: [candidate] }, "kric-subway-timetable"),
    /candidate is not allowed/,
  );
  assert.throws(
    () => resolveKricCandidateRequest({
      candidates: [{
        ...candidate,
        requestUrl: "https://openapi.kric.go.kr/openapi/convenientInfo/stationInfo",
      }],
    }, candidate.id),
    /requestUrl must match evidence endpoint/,
  );
  assert.throws(
    () => resolveKricCandidateRequest({
      candidates: [{
        ...candidate,
        requestUrl: "https://example.com/source",
        evidence: {
          ...candidate.evidence,
          endpoint: "https://example.com/source",
          sampleUrl: "https://example.com/source?serviceKey=[서비스키값]&format=json",
        },
      }],
    }, candidate.id),
    /provider origin must be https:\/\/openapi\.kric\.go\.kr/,
  );
});

test("KRIC evidence collector는 raw를 제거하고 sanitized sample/report/hashes만 남긴다", async () => {
  const runnerTemp = await mkdtemp(path.join(tmpdir(), "easysubway-kric-evidence-"));
  const serviceKey = "test-kric-service-key";
  try {
    const outputs = await collectKricSourceCandidateEvidence({
      candidateId: candidate.id,
      candidatesDocument: { candidates: [candidate] },
      runnerTemp,
      serviceKey,
      fetchImpl: async (url, options) => {
        assert.equal(options.redirect, "error");
        assert.equal(url.searchParams.get("serviceKey"), serviceKey);
        return new Response(JSON.stringify([
          { railOprIsttCd: "S1", railOprIsttNm: "서울교통공사" },
        ]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    assert.equal(existsSync(path.join(runnerTemp, "kric-source-candidate-raw")), false);
    assert.deepEqual(Object.keys(outputs).sort(), ["hashes", "report", "sample"]);
    const sample = JSON.parse(await readFile(outputs.sample, "utf8"));
    const report = await readFile(outputs.report, "utf8");
    const hashes = JSON.parse(await readFile(outputs.hashes, "utf8"));
    assert.equal(sample.candidateId, candidate.id);
    assert.match(report, /source candidate sample evidence valid/);
    assert.equal(hashes.candidateId, candidate.id);
    assert.equal(hashes.rawSha256, sample.rawSha256);
    assert.equal(hashes.evidenceHash, sample.evidenceHash);
    assert.doesNotMatch(`${JSON.stringify(sample)}\n${report}\n${JSON.stringify(hashes)}`, new RegExp(serviceKey));
  } finally {
    await rm(runnerTemp, { recursive: true, force: true });
  }
});

test("KRIC evidence collector는 실패 단계와 무관하게 raw와 uploadable output을 제거하고 key를 숨긴다", async (t) => {
  const serviceKey = "test/key+with space";
  const encodedServiceKey = encodeURIComponent(serviceKey);
  const cases = [
    {
      name: "fetch failure",
      fetchImpl: async () => {
        throw new Error(`request failed for ${serviceKey} and ${encodedServiceKey}`);
      },
      expectedError: /request failed for \[REDACTED\] and \[REDACTED\]/,
    },
    {
      name: "builder failure",
      fetchImpl: async () => new Response(JSON.stringify({ serviceKey }), { status: 200 }),
      expectedError: /raw sample response must not contain serviceKey credentials/,
    },
    {
      name: "validator failure",
      fetchImpl: async () => new Response(JSON.stringify([
        { railOprIsttCd: "S1" },
      ]), { status: 200 }),
      expectedError: /output field missing: railOprIsttNm/,
    },
  ];

  for (const failureCase of cases) {
    await t.test(failureCase.name, async () => {
      const runnerTemp = await mkdtemp(path.join(tmpdir(), "easysubway-kric-evidence-failure-"));
      try {
        await assert.rejects(
          collectKricSourceCandidateEvidence({
            candidateId: candidate.id,
            candidatesDocument: { candidates: [candidate] },
            runnerTemp,
            serviceKey,
            fetchImpl: failureCase.fetchImpl,
          }),
          (error) => {
            assert.match(error.message, failureCase.expectedError);
            assert.doesNotMatch(error.message, new RegExp(serviceKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
            assert.doesNotMatch(error.message, new RegExp(encodedServiceKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
            return true;
          },
        );
        assert.equal(existsSync(path.join(runnerTemp, "kric-source-candidate-raw")), false);
        assert.equal(existsSync(path.join(runnerTemp, "kric-source-candidate-staging")), false);
        assert.equal(existsSync(path.join(runnerTemp, "kric-source-candidate-evidence")), false);
      } finally {
        await rm(runnerTemp, { recursive: true, force: true });
      }
    });
  }
});
