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

const xmlCandidate = {
  ...candidate,
  evidence: {
    ...candidate.evidence,
    sampleUrl: candidate.evidence.sampleUrl.replace("format=json", "format=xml"),
  },
};

async function assertCollectorCleanup(runnerTemp) {
  assert.equal(existsSync(path.join(runnerTemp, "kric-source-candidate-raw")), false);
  assert.equal(existsSync(path.join(runnerTemp, "kric-source-candidate-staging")), false);
  assert.equal(existsSync(path.join(runnerTemp, "kric-source-candidate-evidence")), false);
}

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
      expectedError: /output field missing: "railOprIsttNm"/,
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

test("KRIC evidence collector는 URLSearchParams form key와 string-start parameter 및 C1 control을 숨긴다", async () => {
  const runnerTemp = await mkdtemp(path.join(tmpdir(), "easysubway-kric-form-redaction-"));
  const serviceKey = "test/key+with space~";
  const formEncodedKey = new URLSearchParams({ serviceKey }).toString().slice("serviceKey=".length);
  try {
    await assert.rejects(
      collectKricSourceCandidateEvidence({
        candidateId: candidate.id,
        candidatesDocument: { candidates: [candidate] },
        runnerTemp,
        serviceKey,
        fetchImpl: async () => {
          throw new Error(`serviceKey=${formEncodedKey}\u0085\u009f`);
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

test("KRIC evidence collector는 HTTP 200 XML application error를 고정된 안전 진단으로 분류한다", async () => {
  const runnerTemp = await mkdtemp(path.join(tmpdir(), "easysubway-kric-envelope-"));
  const serviceKey = "credential-sentinel-application-error";
  const resultMessage = `등록되지 않은 서비스키입니다: ${serviceKey}`;
  try {
    await assert.rejects(
      collectKricSourceCandidateEvidence({
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
        assert.match(error.message, /KRIC XML diagnostic:/);
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

test("KRIC evidence collector는 HTTP 200 XML zero-item envelope를 application error와 구분한다", async () => {
  const runnerTemp = await mkdtemp(path.join(tmpdir(), "easysubway-kric-zero-item-"));
  try {
    await assert.rejects(
      collectKricSourceCandidateEvidence({
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
        assert.match(error.message, /KRIC XML diagnostic:/);
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

test("KRIC evidence collector는 CDATA/comment/PI의 XML 모양 text를 구조 진단에서 제외한다", async () => {
  const runnerTemp = await mkdtemp(path.join(tmpdir(), "easysubway-kric-structural-xml-"));
  const structuralSecret = "credential-sentinel-non-structural-markup";
  const raw = [
    "<?xml version=\"1.0\"?>",
    "<?probe <item><nested><piSafeTag>hidden</piSafeTag></nested></item>?>",
    "<!DOCTYPE ROOT [<!ENTITY fake \"<item><nested><declarationSafeTag>hidden</declarationSafeTag></nested></item>\">]>",
    "<ROOT>",
    `<metadata><![CDATA[<resultCode>AUTHCDATA</resultCode><item><nested><cdataSafeTag>${structuralSecret}</cdataSafeTag></nested></item>]]></metadata>`,
    "<!-- <resultCode>AUTHCOMMENT</resultCode><item><nested><commentSafeTag>hidden</commentSafeTag></nested></item> -->",
    `<header><resultCode>00</resultCode><resultMsg><![CDATA[<item><nested><messageSafeTag>${structuralSecret}</messageSafeTag></nested></item>]]></resultMsg></header>`,
    "<body><items></items></body>",
    "</ROOT>",
  ].join("");
  try {
    await assert.rejects(
      collectKricSourceCandidateEvidence({
        candidateId: xmlCandidate.id,
        candidatesDocument: { candidates: [xmlCandidate] },
        runnerTemp,
        serviceKey: "credential-sentinel-structural-service-key",
        fetchImpl: async () => new Response(raw, {
          status: 200,
          headers: { "content-type": "application/xml" },
        }),
      }),
      (error) => {
        assert.match(error.message, /xmlTags=ROOT,metadata,header,resultCode,resultMsg,body,items/);
        assert.match(error.message, /itemCount=0/);
        assert.match(error.message, /resultCode=00/);
        assert.match(error.message, /classification=no-data/);
        for (const nonStructuralValue of [
          structuralSecret,
          "AUTHCDATA",
          "AUTHCOMMENT",
          "piSafeTag",
          "cdataSafeTag",
          "commentSafeTag",
          "declarationSafeTag",
          "messageSafeTag",
        ]) {
          assert.doesNotMatch(error.message, new RegExp(nonStructuralValue));
        }
        return true;
      },
    );
    await assertCollectorCleanup(runnerTemp);
  } finally {
    await rm(runnerTemp, { recursive: true, force: true });
  }
});

test("KRIC evidence collector는 item이 있지만 leaf row가 없는 XML을 parser-shape drift로 분류한다", async () => {
  const runnerTemp = await mkdtemp(path.join(tmpdir(), "easysubway-kric-parser-shape-"));
  try {
    await assert.rejects(
      collectKricSourceCandidateEvidence({
        candidateId: xmlCandidate.id,
        candidatesDocument: { candidates: [xmlCandidate] },
        runnerTemp,
        serviceKey: "credential-sentinel-parser-shape",
        fetchImpl: async () => new Response(
          "<ROOT><body><items><item><nested><value>record-value</value></nested></item></items></body></ROOT>",
          { status: 200, headers: { "content-type": "application/xml" } },
        ),
      }),
      (error) => {
        assert.match(error.message, /itemCount=1/);
        assert.match(error.message, /classification=parser-shape/);
        assert.doesNotMatch(error.message, /record-value/);
        return true;
      },
    );
    await assertCollectorCleanup(runnerTemp);
  } finally {
    await rm(runnerTemp, { recursive: true, force: true });
  }
});

test("KRIC evidence collector는 unsafe XML code/message/tag와 credential sentinel을 노출하지 않는다", async () => {
  const runnerTemp = await mkdtemp(path.join(tmpdir(), "easysubway-kric-unsafe-envelope-"));
  const serviceKey = "credential-sentinel-unsafe-input";
  const unsafeTag = `credential-${"x".repeat(80)}`;
  const unsafeCode = `BAD/CODE-${"y".repeat(80)}`;
  const unsafeMessage = `provider-secret-message\u0007-${serviceKey}-${encodeURIComponent(serviceKey)}`;
  try {
    await assert.rejects(
      collectKricSourceCandidateEvidence({
        candidateId: xmlCandidate.id,
        candidatesDocument: { candidates: [xmlCandidate] },
        runnerTemp,
        serviceKey,
        fetchImpl: async () => new Response(
          `<ROOT><header><resultCode>${unsafeCode}</resultCode><resultMsg>${unsafeMessage}</resultMsg></header><${unsafeTag}>value-must-not-leak</${unsafeTag}></ROOT>`,
          { status: 200, headers: { "content-type": "application/problem+xml" } },
        ),
      }),
      (error) => {
        assert.match(error.message, /contentType=\[unsafe\]/);
        assert.match(error.message, /xmlTags=ROOT,header,resultCode,resultMsg,\[unsafe\]/);
        assert.match(error.message, /resultCode=\[unsafe\]/);
        for (const secret of [serviceKey, encodeURIComponent(serviceKey), unsafeTag, unsafeCode, "provider-secret-message", "value-must-not-leak"]) {
          assert.doesNotMatch(error.message, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        }
        assert.doesNotMatch(error.message, /[\u0000-\u001f\u007f]/);
        return true;
      },
    );
    await assertCollectorCleanup(runnerTemp);
  } finally {
    await rm(runnerTemp, { recursive: true, force: true });
  }
});

test("KRIC evidence collector는 malformed 반복 item을 scalar count하고 cleanup한다", async () => {
  const runnerTemp = await mkdtemp(path.join(tmpdir(), "easysubway-kric-repeated-item-"));
  const repeatedItemCount = 128;
  try {
    await assert.rejects(
      collectKricSourceCandidateEvidence({
        candidateId: xmlCandidate.id,
        candidatesDocument: { candidates: [xmlCandidate] },
        runnerTemp,
        serviceKey: "credential-sentinel-repeated-item",
        fetchImpl: async () => new Response(
          `<ROOT><body><items>${"<item>".repeat(repeatedItemCount)}</items></body></ROOT>`,
          { status: 200, headers: { "content-type": "application/xml" } },
        ),
      }),
      (error) => {
        assert.match(error.message, new RegExp(`itemCount=${repeatedItemCount}(?:\\s|$)`));
        assert.match(error.message, /classification=parser-shape/);
        return true;
      },
    );
    await assertCollectorCleanup(runnerTemp);

    const collectorSource = await readFile(new URL("./collect-kric-source-candidate-evidence.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(collectorSource, /\[\s*\.\.\.[^\]]*matchAll/);
  } finally {
    await rm(runnerTemp, { recursive: true, force: true });
  }
});

test("KRIC evidence collector는 초장문 tag와 scalar를 bounded state로 진단하고 cleanup한다", async () => {
  const runnerTemp = await mkdtemp(path.join(tmpdir(), "easysubway-kric-long-xml-token-"));
  const longTag = `attacker-tag-${"x".repeat(8_192)}`;
  const longResultCode = `CODE-${"z".repeat(4_096)}`;
  const longResultMessage = `scalar-sentinel-${"y".repeat(16_384)}`;
  try {
    await assert.rejects(
      collectKricSourceCandidateEvidence({
        candidateId: xmlCandidate.id,
        candidatesDocument: { candidates: [xmlCandidate] },
        runnerTemp,
        serviceKey: "credential-sentinel-long-xml-token",
        fetchImpl: async () => new Response(
          `<ROOT><header><resultCode>${longResultCode}</resultCode><resultMsg>${longResultMessage}</resultMsg></header><${longTag}>hidden</${longTag}></ROOT>`,
          { status: 200, headers: { "content-type": "application/xml" } },
        ),
      }),
      (error) => {
        assert.match(error.message, /xmlTags=ROOT,header,resultCode,resultMsg,\[unsafe\]/);
        assert.match(error.message, /itemCount=0/);
        assert.match(error.message, /resultCode=\[unsafe\]/);
        assert.doesNotMatch(error.message, /attacker-tag|scalar-sentinel|CODE-/);
        return true;
      },
    );
    await assertCollectorCleanup(runnerTemp);

    const collectorSource = await readFile(new URL("./collect-kric-source-candidate-evidence.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(collectorSource, /raw\.slice\(nameStart,\s*cursor\)/);
    assert.doesNotMatch(collectorSource, /raw\.slice\(index,\s*textEnd\)/);
  } finally {
    await rm(runnerTemp, { recursive: true, force: true });
  }
});

test("KRIC evidence collector는 기존 XML item 성공 경로를 그대로 유지한다", async () => {
  const runnerTemp = await mkdtemp(path.join(tmpdir(), "easysubway-kric-xml-success-"));
  const serviceKey = "credential-sentinel-xml-success";
  try {
    const outputs = await collectKricSourceCandidateEvidence({
      candidateId: xmlCandidate.id,
      candidatesDocument: { candidates: [xmlCandidate] },
      runnerTemp,
      serviceKey,
      fetchImpl: async () => new Response(
        "<ROOT><body><items><item><railOprIsttCd>S1</railOprIsttCd><railOprIsttNm>서울교통공사</railOprIsttNm></item></items></body></ROOT>",
        { status: 200, headers: { "content-type": "application/xml" } },
      ),
    });

    const sample = JSON.parse(await readFile(outputs.sample, "utf8"));
    assert.equal(sample.format, "xml");
    assert.equal(sample.rowCount, 1);
    assert.deepEqual(sample.fields, ["railOprIsttCd", "railOprIsttNm"]);
    assert.equal(existsSync(path.join(runnerTemp, "kric-source-candidate-raw")), false);
    assert.doesNotMatch(JSON.stringify(sample), new RegExp(serviceKey));
  } finally {
    await rm(runnerTemp, { recursive: true, force: true });
  }
});
