import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectDatagoSourceCandidateEvidence,
  DATAGO_SOURCE_CANDIDATE_IDS,
  resolveDatagoCandidateRequest,
} from "./collect-datago-source-candidate-evidence.mjs";

const candidate = {
  id: "seoul-metro-fast-exit-car-door",
  // 아래 endpoint/sampleUrl은 테스트 전용 합성 픽스처다. 실제 data.go.kr operation path가 아니며 source-candidates.json에 넣지 않는다.
  requestUrl: "https://apis.data.go.kr/B553766/fastExit/getFastExit",
  sampleEvidenceStatus: "sample_url_documented_key_required",
  admissionStatus: "evidence_recorded_admin_review_required",
  evidence: {
    endpoint: "https://apis.data.go.kr/B553766/fastExit/getFastExit",
    sampleUrl: "https://apis.data.go.kr/B553766/fastExit/getFastExit?serviceKey=[서비스키값]&format=json&pageNo=1&numOfRows=1",
    formats: ["JSON", "XML"],
    outputFields: ["stnNm", "carNo"],
  },
};

const xmlCandidate = {
  ...candidate,
  evidence: {
    ...candidate.evidence,
    sampleUrl: candidate.evidence.sampleUrl.replace("format=json", "format=xml"),
  },
};

const dataTypeCandidate = {
  ...candidate,
  evidence: {
    ...candidate.evidence,
    sampleUrl: candidate.evidence.sampleUrl.replace("format=json", "dataType=JSON"),
  },
};

const underscoreTypeCandidate = {
  ...candidate,
  evidence: {
    ...candidate.evidence,
    sampleUrl: candidate.evidence.sampleUrl.replace("format=json", "_type=xml"),
  },
};

const dataTypeCsvCandidate = {
  ...candidate,
  evidence: {
    ...candidate.evidence,
    sampleUrl: candidate.evidence.sampleUrl.replace("format=json", "dataType=csv"),
  },
};

async function assertCollectorCleanup(runnerTemp) {
  assert.equal(existsSync(path.join(runnerTemp, "datago-source-candidate-raw")), false);
  assert.equal(existsSync(path.join(runnerTemp, "datago-source-candidate-staging")), false);
  assert.equal(existsSync(path.join(runnerTemp, "datago-source-candidate-evidence")), false);
}

test("Data.go.kr evidence collector는 정확한 2개 allowlist와 tracked endpoint를 강제한다", () => {
  assert.deepEqual(DATAGO_SOURCE_CANDIDATE_IDS, [
    "seoul-metro-transfer-distance-duration",
    "seoul-metro-fast-exit-car-door",
  ]);

  const request = resolveDatagoCandidateRequest({ candidates: [candidate] }, candidate.id);
  assert.equal(request.candidateId, candidate.id);
  assert.equal(request.endpoint, candidate.evidence.endpoint);
  assert.equal(request.format, "json");

  assert.throws(
    () => resolveDatagoCandidateRequest({ candidates: [candidate] }, "kric-subway-timetable"),
    /candidate is not allowed/,
  );
  assert.throws(
    () => resolveDatagoCandidateRequest({
      candidates: [{
        ...candidate,
        requestUrl: "https://apis.data.go.kr/B553766/facility/getFcElvtr",
      }],
    }, candidate.id),
    /requestUrl must match evidence endpoint/,
  );
  assert.throws(
    () => resolveDatagoCandidateRequest({
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
    /provider origin must be a data\.go\.kr origin/,
  );
});

test("Data.go.kr evidence collector는 dataType/_type 쿼리 파라미터도 sample format으로 인식한다", () => {
  const dataTypeRequest = resolveDatagoCandidateRequest({ candidates: [dataTypeCandidate] }, dataTypeCandidate.id);
  assert.equal(dataTypeRequest.format, "json");

  const underscoreTypeRequest = resolveDatagoCandidateRequest(
    { candidates: [underscoreTypeCandidate] },
    underscoreTypeCandidate.id,
  );
  assert.equal(underscoreTypeRequest.format, "xml");

  assert.throws(
    () => resolveDatagoCandidateRequest({ candidates: [dataTypeCsvCandidate] }, dataTypeCsvCandidate.id),
    /csv sample collection not yet supported/,
  );

  const unsupportedDataTypeCandidate = {
    ...candidate,
    evidence: {
      ...candidate.evidence,
      sampleUrl: candidate.evidence.sampleUrl.replace("format=json", "dataType=yaml"),
    },
  };
  assert.throws(
    () => resolveDatagoCandidateRequest({ candidates: [unsupportedDataTypeCandidate] }, unsupportedDataTypeCandidate.id),
    /sample format is not supported: yaml/,
  );
});

test("Data.go.kr evidence collector는 endpoint 미확정 후보를 수집 전에 게이트한다", () => {
  // 실제 source-candidates.json 신규 2건 형태: evidence에 endpoint/sampleUrl 없음, 최상위 requestUrl 없음.
  const unconfirmed = {
    id: "seoul-metro-transfer-distance-duration",
    sampleEvidenceStatus: "sample_url_documented_key_required",
    admissionStatus: "evidence_recorded_admin_review_required",
    evidence: {
      formats: ["CSV", "JSON", "XML"],
    },
  };
  assert.throws(
    () => resolveDatagoCandidateRequest({ candidates: [unconfirmed] }, unconfirmed.id),
    /endpoint not yet confirmed; cannot collect until data\.go\.kr endpoint is documented/,
  );

  const fastExitUnconfirmed = {
    id: "seoul-metro-fast-exit-car-door",
    sampleEvidenceStatus: "sample_url_documented_key_required",
    admissionStatus: "evidence_recorded_admin_review_required",
    evidence: {
      formats: ["JSON", "XML"],
    },
  };
  assert.throws(
    () => resolveDatagoCandidateRequest({ candidates: [fastExitUnconfirmed] }, fastExitUnconfirmed.id),
    /endpoint not yet confirmed; cannot collect until data\.go\.kr endpoint is documented/,
  );
});

test("Data.go.kr evidence collector는 raw를 제거하고 sanitized sample/report/hashes만 남긴다", async () => {
  const runnerTemp = await mkdtemp(path.join(tmpdir(), "easysubway-datago-evidence-"));
  const serviceKey = "test-datago-service-key";
  try {
    const outputs = await collectDatagoSourceCandidateEvidence({
      candidateId: candidate.id,
      candidatesDocument: { candidates: [candidate] },
      runnerTemp,
      serviceKey,
      fetchImpl: async (url, options) => {
        assert.equal(options.redirect, "error");
        assert.equal(url.searchParams.get("serviceKey"), serviceKey);
        return new Response(JSON.stringify([
          { stnNm: "사당", carNo: "3-2" },
        ]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    assert.equal(existsSync(path.join(runnerTemp, "datago-source-candidate-raw")), false);
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

test("Data.go.kr evidence collector는 실패 단계와 무관하게 raw와 uploadable output을 제거하고 key를 숨긴다", async (t) => {
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
        { stnNm: "사당" },
      ]), { status: 200 }),
      expectedError: /output field missing: "carNo"/,
    },
  ];

  for (const failureCase of cases) {
    await t.test(failureCase.name, async () => {
      const runnerTemp = await mkdtemp(path.join(tmpdir(), "easysubway-datago-evidence-failure-"));
      try {
        await assert.rejects(
          collectDatagoSourceCandidateEvidence({
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
        assert.equal(existsSync(path.join(runnerTemp, "datago-source-candidate-raw")), false);
        assert.equal(existsSync(path.join(runnerTemp, "datago-source-candidate-staging")), false);
        assert.equal(existsSync(path.join(runnerTemp, "datago-source-candidate-evidence")), false);
      } finally {
        await rm(runnerTemp, { recursive: true, force: true });
      }
    });
  }
});

test("Data.go.kr evidence collector는 URLSearchParams form key와 string-start parameter 및 C1 control을 숨긴다", async () => {
  const runnerTemp = await mkdtemp(path.join(tmpdir(), "easysubway-datago-form-redaction-"));
  const serviceKey = "test/key+with space~";
  const formEncodedKey = new URLSearchParams({ serviceKey }).toString().slice("serviceKey=".length);
  try {
    await assert.rejects(
      collectDatagoSourceCandidateEvidence({
        candidateId: candidate.id,
        candidatesDocument: { candidates: [candidate] },
        runnerTemp,
        serviceKey,
        fetchImpl: async () => {
          throw new Error(`serviceKey=${formEncodedKey}`);
        },
      }),
      (error) => {
        assert.match(error.message, /^serviceKey=\[REDACTED\]/);
        assert.doesNotMatch(error.message, new RegExp(serviceKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.doesNotMatch(error.message, new RegExp(formEncodedKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.doesNotMatch(error.message, /[\u0000-\u001f\u007f-\u009f]/);
        return true;
      },
    );
    await assertCollectorCleanup(runnerTemp);
  } finally {
    await rm(runnerTemp, { recursive: true, force: true });
  }
});

test("Data.go.kr evidence collector는 HTTP 200 XML application error를 고정된 안전 진단으로 분류한다", async () => {
  const runnerTemp = await mkdtemp(path.join(tmpdir(), "easysubway-datago-envelope-"));
  const serviceKey = "credential-sentinel-application-error";
  const resultMessage = `등록되지 않은 서비스키입니다: ${serviceKey}`;
  try {
    await assert.rejects(
      collectDatagoSourceCandidateEvidence({
        candidateId: xmlCandidate.id,
        candidatesDocument: { candidates: [xmlCandidate] },
        runnerTemp,
        serviceKey,
        fetchImpl: async () => new Response(
          `<ROOT><header><resultCode>AUTH001</resultCode><resultMsg>${resultMessage}</resultMsg></header></ROOT>`,
          { status: 200, headers: { "content-type": "application/xml; charset=UTF-8" } },
        ),
      }),
      (error) => {
        assert.match(error.message, /Data\.go\.kr XML diagnostic:/);
        assert.match(error.message, /httpStatus=200/);
        assert.match(error.message, /contentType=application\/xml/);
        assert.match(error.message, /requestedFormat=xml/);
        assert.match(error.message, /xmlTags=ROOT,header,resultCode,resultMsg/);
        assert.match(error.message, /itemCount=0/);
        assert.match(error.message, /resultCode=AUTH001/);
        assert.match(error.message, /classification=authorization/);
        assert.doesNotMatch(error.message, /등록되지 않은 서비스키/);
        assert.doesNotMatch(error.message, new RegExp(serviceKey));
        return true;
      },
    );
    await assertCollectorCleanup(runnerTemp);
  } finally {
    await rm(runnerTemp, { recursive: true, force: true });
  }
});

test("Data.go.kr evidence collector는 HTTP 200 XML zero-item envelope를 application error와 구분한다", async () => {
  const runnerTemp = await mkdtemp(path.join(tmpdir(), "easysubway-datago-zero-item-"));
  try {
    await assert.rejects(
      collectDatagoSourceCandidateEvidence({
        candidateId: xmlCandidate.id,
        candidatesDocument: { candidates: [xmlCandidate] },
        runnerTemp,
        serviceKey: "credential-sentinel-zero-item",
        fetchImpl: async () => new Response(
          "<ROOT><header><resultCode>00</resultCode><resultMsg>정상 처리되었습니다.</resultMsg></header><body><items></items></body></ROOT>",
          { status: 200, headers: { "content-type": "text/xml" } },
        ),
      }),
      (error) => {
        assert.match(error.message, /Data\.go\.kr XML diagnostic:/);
        assert.match(error.message, /contentType=text\/xml/);
        assert.match(error.message, /itemCount=0/);
        assert.match(error.message, /resultCode=00/);
        assert.match(error.message, /classification=no-data/);
        assert.doesNotMatch(error.message, /정상 처리/);
        return true;
      },
    );
    await assertCollectorCleanup(runnerTemp);
  } finally {
    await rm(runnerTemp, { recursive: true, force: true });
  }
});

test("Data.go.kr evidence collector는 기존 XML item 성공 경로를 그대로 유지한다", async () => {
  const runnerTemp = await mkdtemp(path.join(tmpdir(), "easysubway-datago-xml-success-"));
  const serviceKey = "credential-sentinel-xml-success";
  try {
    const outputs = await collectDatagoSourceCandidateEvidence({
      candidateId: xmlCandidate.id,
      candidatesDocument: { candidates: [xmlCandidate] },
      runnerTemp,
      serviceKey,
      fetchImpl: async () => new Response(
        "<ROOT><body><items><item><stnNm>사당</stnNm><carNo>3-2</carNo></item></items></body></ROOT>",
        { status: 200, headers: { "content-type": "application/xml" } },
      ),
    });

    const sample = JSON.parse(await readFile(outputs.sample, "utf8"));
    assert.equal(sample.format, "xml");
    assert.equal(sample.rowCount, 1);
    assert.deepEqual(sample.fields, ["carNo", "stnNm"]);
    assert.equal(existsSync(path.join(runnerTemp, "datago-source-candidate-raw")), false);
    assert.doesNotMatch(JSON.stringify(sample), new RegExp(serviceKey));
  } finally {
    await rm(runnerTemp, { recursive: true, force: true });
  }
});
