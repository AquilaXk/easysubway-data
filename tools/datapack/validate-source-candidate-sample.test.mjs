import { mkdir, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256 } from "../lib/hash.mjs";
import { execFileAsync } from "./test-fixtures/datapack-tools-support.mjs";

const root = path.resolve(import.meta.dirname, "../..");

const KRIC_SUBWAY_ROUTE_INFO_FIELDS = [
  "lnCd",
  "mreaWideCd",
  "railOprIsttCd",
  "routCd",
  "routNm",
  "stinCd",
  "stinConsOrdr",
  "stinNm",
];

function runValidateCandidateSample(candidateId, samplePath, extraArgs = []) {
  return execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-source-candidate-sample.mjs",
      ...extraArgs,
      "--candidate",
      candidateId,
      "--sample",
      samplePath,
    ],
    { cwd: root },
  );
}

async function withSampleFile(prefix, sample, fn) {
  const outputDir = path.join(tmpdir(), `easysubway-source-candidate-${prefix}-${Date.now()}`);
  const samplePath = path.join(outputDir, "sample.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(samplePath, `${JSON.stringify(sample, null, 2)}\n`);
  try {
    await fn({ outputDir, samplePath });
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

async function withFieldDiagnosticFixture(prefix, { outputFields, fields }, fn) {
  const outputDir = path.join(tmpdir(), `easysubway-source-field-${prefix}-${Date.now()}`);
  const candidatesPath = path.join(outputDir, "source-candidates.json");
  const samplePath = path.join(outputDir, "sample.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    candidatesPath,
    `${JSON.stringify({
      candidates: [{
        id: "field-diagnostic-test",
        evidence: {
          endpoint: "https://provider.invalid/field-diagnostic",
          formats: ["JSON"],
          outputFields,
        },
      }],
    }, null, 2)}\n`,
  );
  await writeFile(
    samplePath,
    `${JSON.stringify({
      candidateId: "field-diagnostic-test",
      endpoint: "https://provider.invalid/field-diagnostic",
      format: "json",
      fields,
    }, null, 2)}\n`,
  );
  try {
    await fn(() => runValidateCandidateSample("field-diagnostic-test", samplePath, ["--candidates", candidatesPath]));
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

async function withBuiltEvidenceSample({ prefix, candidateId, responseFileName = "response.json", responseContent }, fn) {
  const outputDir = path.join(tmpdir(), `easysubway-${prefix}-${Date.now()}`);
  const responsePath = path.join(outputDir, responseFileName);
  const evidencePath = path.join(outputDir, "evidence.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(responsePath, responseContent);
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-source-candidate-sample-evidence.mjs",
        "--candidate",
        candidateId,
        "--response",
        responsePath,
      ],
      { cwd: root },
    );
    await writeFile(evidencePath, stdout);
    const evidence = JSON.parse(stdout);
    await fn({
      evidence,
      validateEvidence: () => runValidateCandidateSample(candidateId, evidencePath),
    });
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

test("source candidate sample 검증기는 KRIC live evidence metadata를 허용한다", async () => {
  const sample = {
    candidateId: "kric-subway-route-info",
    endpoint: "https://openapi.kric.go.kr/openapi/trainUseInfo/subwayRouteInfo",
    format: "json",
    fields: KRIC_SUBWAY_ROUTE_INFO_FIELDS,
    rowCount: 1,
    rawSha256: sha256("kric-subway-route-info raw sample"),
    schemaFingerprint: sha256(JSON.stringify(KRIC_SUBWAY_ROUTE_INFO_FIELDS)),
    credentialRedacted: true,
    providerRecordHashes: [sha256("kric-subway-route-info row")],
  };
  sample.evidenceHash = sha256(JSON.stringify(sample));

  await withSampleFile("sample", sample, async ({ samplePath }) => {
    const { stdout } = await runValidateCandidateSample("kric-subway-route-info", samplePath);
    assert.match(stdout, /source candidate sample evidence valid: kric-subway-route-info/);
  });
});

test("source candidate sample 검증기는 evidence hash metadata 누락을 거부한다", async () => {
  await withSampleFile(
    "sample-hash",
    {
      candidateId: "kric-subway-route-info",
      endpoint: "https://openapi.kric.go.kr/openapi/trainUseInfo/subwayRouteInfo",
      format: "json",
      fields: KRIC_SUBWAY_ROUTE_INFO_FIELDS,
    },
    async ({ samplePath }) => {
      await assert.rejects(
        runValidateCandidateSample("kric-subway-route-info", samplePath),
        /rawSha256 must be a sha256 hex string/,
      );
    },
  );
});

test("source candidate sample 검증기는 hand-edited evidence hash를 거부한다", async () => {
  const sample = {
    candidateId: "kric-train-operation-organ",
    endpoint: "https://openapi.kric.go.kr/openapi/convenientInfo/trainOperationOrgan",
    format: "json",
    fields: ["railOprIsttCd", "railOprIsttNm"],
    rowCount: 1,
    rawSha256: sha256("raw"),
    schemaFingerprint: sha256(JSON.stringify(["railOprIsttCd", "railOprIsttNm"])),
    credentialRedacted: true,
    providerRecordHashes: [sha256("row")],
  };
  sample.evidenceHash = sha256(JSON.stringify(sample));
  sample.fields.push("unexpectedField");

  await withSampleFile("stale-hash", sample, async ({ samplePath }) => {
    await assert.rejects(
      runValidateCandidateSample("kric-train-operation-organ", samplePath),
      /output field missing|schemaFingerprint does not match fields/,
    );
  });
});

test("source candidate sample 검증기는 endpoint mismatch를 거부한다", async () => {
  await withSampleFile(
    "endpoint",
    {
      candidateId: "kric-subway-route-info",
      endpoint: "https://openapi.kric.go.kr/openapi/convenientInfo/stationInfo",
      format: "json",
      fields: KRIC_SUBWAY_ROUTE_INFO_FIELDS,
    },
    async ({ samplePath }) => {
      await assert.rejects(
        runValidateCandidateSample("kric-subway-route-info", samplePath),
        /endpoint mismatch/,
      );
    },
  );
});

test("source candidate sample 검증기는 control과 delimiter field name을 한 줄 JSON string으로 escape한다", async () => {
  await withFieldDiagnosticFixture(
    "control",
    {
      outputFields: ["expected"],
      fields: ["line\nbreak", "\u001b[31mred\u001b[0m", "nul\u0000field", "comma,name;next"],
    },
    async (runValidation) => {
      await assert.rejects(
        runValidation(),
        (error) => {
          const diagnostic = error.stderr.trimEnd();
          assert.equal(
            diagnostic,
            "output field missing: \"expected\"; available fields: \"\\u001b[31mred\\u001b[0m\", \"comma,name;next\", \"line\\nbreak\", \"nul\\u0000field\"",
          );
          assert.equal(diagnostic.split("\n").length, 1);
          assert.doesNotMatch(diagnostic, /\u001b|\u0000/);
          return true;
        },
      );
    },
  );
});

test("source candidate sample 검증기는 credential-like field name을 generic 오류로 차단한다", async () => {
  const credentialLikeField = "https://provider.invalid/sample?serviceKey=credential-like-field-secret";
  await withFieldDiagnosticFixture(
    "credential",
    {
      outputFields: ["expected"],
      fields: ["safeField", credentialLikeField],
    },
    async (runValidation) => {
      await assert.rejects(
        runValidation(),
        (error) => {
          assert.equal(error.stderr.trim(), "sample field names must not contain credentials");
          assert.doesNotMatch(error.stderr, /credential-like-field-secret/);
          assert.equal(error.stderr.includes(credentialLikeField), false);
          return true;
        },
      );
    },
  );
});

test("source candidate sample 검증기는 ambiguous 첫 field에서 missing 진단을 즉시 확정한다", async () => {
  await withFieldDiagnosticFixture(
    "ambiguous",
    {
      outputFields: ["foo", "bar"],
      fields: ["FOO", "Foo", "BAR"],
    },
    async (runValidation) => {
      await assert.rejects(
        runValidation(),
        (error) => {
          assert.equal(
            error.stderr.trim(),
            "output field missing: \"foo\"; available fields: \"BAR\", \"FOO\", \"Foo\"",
          );
          return true;
        },
      );
    },
  );
});

test("source candidate sample 검증기는 output field 대소문자 불일치를 field name만으로 진단한다", async () => {
  await withFieldDiagnosticFixture(
    "case-mismatch",
    {
      outputFields: ["updnDvcd"],
      fields: ["updnDvCd"],
    },
    async (runValidation) => {
      await assert.rejects(
        runValidation(),
        (error) => {
          assert.equal(
            error.stderr.trim(),
            "output field case mismatch: expected \"updnDvcd\"; actual \"updnDvCd\"",
          );
          return true;
        },
      );
    },
  );
});

test("source candidate sample 검증기는 true missing field를 sorted field name만으로 진단한다", async () => {
  await withSampleFile(
    "missing-field",
    {
      candidateId: "kric-station-platform",
      endpoint: "https://openapi.kric.go.kr/openapi/convenientInfo/stPlf",
      format: "json",
      fields: [
        "zProviderField",
        "stinFlor",
        "stinCd",
        "sfFotExt",
        "scrCharExt",
        "runDirTmnStinCd",
        "railOprIsttCd",
        "plfTpNm",
        "plfTpCd",
        "plfNo",
        "plfCplFlg",
        "lnCd",
        "grndDvCd",
        "aProviderField",
      ],
      providerSample: { updnDvCd: "SENTINEL_SAMPLE_VALUE" },
      observedUrl: "https://provider.invalid/sample?serviceKey=credential-like-secret",
    },
    async ({ samplePath }) => {
      await assert.rejects(
        runValidateCandidateSample("kric-station-platform", samplePath),
        (error) => {
          assert.equal(
            error.stderr.trim(),
            "output field missing: \"updnDvCd\"; available fields: \"aProviderField\", \"grndDvCd\", \"lnCd\", \"plfCplFlg\", \"plfNo\", \"plfTpCd\", \"plfTpNm\", \"railOprIsttCd\", \"runDirTmnStinCd\", \"scrCharExt\", \"sfFotExt\", \"stinCd\", \"stinFlor\", \"zProviderField\"",
          );
          assert.doesNotMatch(error.stderr, /SENTINEL_SAMPLE_VALUE/);
          assert.doesNotMatch(error.stderr, /credential-like-secret/);
          return true;
        },
      );
    },
  );
});

test("source candidate sample 검증기는 KRIC 이동동선 route graph 자동 승격을 거부한다", async () => {
  await withSampleFile(
    "route-edge",
    {
      candidateId: "kric-transfer-movement-standard",
      endpoint: "https://openapi.kric.go.kr/openapi/handicapped/transferMovement",
      format: "json",
      fields: [
        "chtnMvTpOrdr",
        "edMovePath",
        "elvtSttCd",
        "elvtTpCd",
        "imgPath",
        "mvContDtl",
        "mvPathMgNo",
        "stMovePath",
        "https://provider.invalid/sample?serviceKey=route-graph-secret",
      ],
      routeGraphEdgeAdmission: "allowed",
    },
    async ({ samplePath }) => {
      await assert.rejects(
        runValidateCandidateSample("kric-transfer-movement-standard", samplePath),
        (error) => {
          assert.equal(
            error.stderr.trim(),
            "route graph edge admission requires confirmed fields: distanceMeters, durationSeconds",
          );
          assert.doesNotMatch(error.stderr, /route-graph-secret/);
          return true;
        },
      );
    },
  );
});

test("source candidate sample 검증기는 serviceKey credential 포함을 거부한다", async () => {
  await withSampleFile(
    "secret",
    {
      candidateId: "kric-train-operation-organ",
      endpoint: "https://openapi.kric.go.kr/openapi/convenientInfo/trainOperationOrgan",
      format: "json",
      fields: ["railOprIsttCd", "railOprIsttNm"],
      observedUrl: "https://openapi.kric.go.kr/openapi/convenientInfo/trainOperationOrgan?serviceKey=actual-secret",
    },
    async ({ samplePath }) => {
      await assert.rejects(
        runValidateCandidateSample("kric-train-operation-organ", samplePath),
        /sample evidence must not contain serviceKey credentials: observedUrl/,
      );
    },
  );
});

test("source candidate sample 검증기는 TOPIS path serviceKey credential 포함을 거부한다", async () => {
  await withSampleFile(
    "topis-secret",
    {
      candidateId: "seoul-topis-realtime-station-arrival",
      endpoint: "http://swopenapi.seoul.go.kr/api/subway/{serviceKey}/json/realtimeStationArrival",
      format: "json",
      fields: [
        "arvlCd",
        "arvlMsg2",
        "arvlMsg3",
        "barvlDt",
        "bstatnNm",
        "btrainNo",
        "recptnDt",
        "statnId",
        "statnNm",
        "subwayId",
        "trainLineNm",
        "updnLine",
      ],
      observedUrl: "http://swopenapi.seoul.go.kr/api/subway/actual-secret/json/realtimeStationArrival/0/5/서울",
    },
    async ({ samplePath }) => {
      await assert.rejects(
        runValidateCandidateSample("seoul-topis-realtime-station-arrival", samplePath),
        /sample evidence must not contain serviceKey credentials: observedUrl/,
      );
    },
  );
});

test("source candidate sample evidence builder는 raw JSON response를 validator 입력으로 변환한다", async () => {
  await withBuiltEvidenceSample(
    {
      prefix: "source-candidate-json-evidence",
      candidateId: "kric-train-operation-organ",
      responseContent: `${JSON.stringify([{ railOprIsttCd: "S1" }, { railOprIsttNm: "서울교통공사" }])}\n`,
    },
    async ({ evidence, validateEvidence }) => {
      assert.match(evidence.rawSha256, /^[0-9a-f]{64}$/);
      assert.match(evidence.schemaFingerprint, /^[0-9a-f]{64}$/);
      assert.equal(evidence.credentialRedacted, true);
      assert.equal(evidence.rowCount, 2);
      assert.equal(evidence.providerRecordHashes.length, 2);
      assert.match(evidence.evidenceHash, /^[0-9a-f]{64}$/);
      await validateEvidence();
    },
  );
});

test("KRIC 역사별 승강장 live JSON은 tracked candidate metadata로 builder와 validator를 통과한다", async () => {
  await withBuiltEvidenceSample(
    {
      prefix: "kric-station-platform-live",
      candidateId: "kric-station-platform",
      responseContent: `${JSON.stringify([{
        grndDvCd: "G",
        lnCd: "1",
        plfCplFlg: "Y",
        plfNo: "1",
        plfTpCd: "1",
        plfTpNm: "상대식",
        railOprIsttCd: "S1",
        runDirTmnStinCd: "0152",
        scrCharExt: "10",
        sfFotExt: "200",
        stinCd: "0152",
        stinFlor: "B2",
        updnDvCd: "U",
      }])}\n`,
    },
    async ({ evidence, validateEvidence }) => {
      assert.ok(evidence.fields.includes("updnDvCd"));
      assert.ok(!evidence.fields.includes("updnDvcd"));
      await validateEvidence();
    },
  );
});

test("source candidate sample builder와 validator는 code-unit field 정렬을 공유한다", async () => {
  await withBuiltEvidenceSample(
    {
      prefix: "source-candidate-field-sort",
      candidateId: "kric-station-transfer-info",
      responseContent: `${JSON.stringify([{
        stinCd: "312",
        stLocCont: "3호선 승강장",
        railOprIsttCd: "S1",
        lnCd: "3",
        clsLocCont: "환승 통로",
        chtnLn: "4",
        chtnDst: "120",
      }])}\n`,
    },
    async ({ evidence, validateEvidence }) => {
      assert.deepEqual(evidence.fields, [
        "chtnDst",
        "chtnLn",
        "clsLocCont",
        "lnCd",
        "railOprIsttCd",
        "stLocCont",
        "stinCd",
      ]);
      await validateEvidence();
    },
  );
});

test("source candidate sample evidence builder는 raw XML response를 validator 입력으로 변환한다", async () => {
  await withBuiltEvidenceSample(
    {
      prefix: "source-candidate-xml-evidence",
      candidateId: "kric-train-operation-organ",
      responseFileName: "response.xml",
      responseContent: `<response><body><items><item>
      <railOprIsttCd>S1</railOprIsttCd>
    </item><item>
      <railOprIsttCd>S2</railOprIsttCd>
      <railOprIsttNm/>
    </item></items></body></response>\n`,
    },
    async ({ evidence, validateEvidence }) => {
      assert.match(evidence.rawSha256, /^[0-9a-f]{64}$/);
      assert.match(evidence.schemaFingerprint, /^[0-9a-f]{64}$/);
      assert.equal(evidence.credentialRedacted, true);
      assert.equal(evidence.rowCount, 2);
      assert.equal(evidence.providerRecordHashes.length, 2);
      assert.match(evidence.evidenceHash, /^[0-9a-f]{64}$/);
      await validateEvidence();
    },
  );
});
