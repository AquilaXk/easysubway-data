// #22: 카탈로그 endpoint·detailUrl 실재 계약. 네트워크 호출 없이 형식과 provider host 규약만 검사한다.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { resolveProviderCallIntegrity } from "./lib/provider-call-integrity.mjs";
import {
  collectKricAccessibilityProviderTupleEvidence,
  KRIC_APPROVED_ACCESSIBILITY_OPERATIONS,
} from "./collect-kric-accessibility-snapshots.mjs";
import {
  preflightKricFacilityProviderProbe,
  resolveKricFacilityProviderProbe,
} from "./probe-kric-facility-provider-tuples.mjs";

const CANDIDATES_PATH = path.join(import.meta.dirname, "source-candidates.json");
const DATAPACK_DIRECTORY = import.meta.dirname;
const KRIC_OPENAPI_HOST = "openapi.kric.go.kr";
const KRIC_PORTAL_DETAIL_URL = "https://data.kric.go.kr/rips/M_01_02/detail.do";
const KRIC_OPENAPI_PATH = /^\/openapi\/([A-Za-z][A-Za-z0-9]*)\/([A-Za-z][A-Za-z0-9]*)$/;

// 2026-08-02 포털 실측으로 확인한 정본 detail 페이지 id. 잘못된 data.go.kr LINK 페이지가 다시 들어오지 못하게 고정한다.
const KRIC_PORTAL_DETAIL_IDS = Object.freeze({
  "kric-station-convenience-standard": "430",
  "kric-station-elevator": "189",
  "kric-station-elevator-movement": "208",
  "kric-station-escalator": "190",
  "kric-station-info": "183",
  "kric-station-movement-detailed": "306",
  "kric-station-movement-standard": "429",
  "kric-station-platform": "433",
  "kric-station-timetable": "182",
  "kric-station-transfer-info": "181",
  "kric-subway-route-info": "431",
  "kric-subway-timetable": "162",
  "kric-subway-timetable-exp": "434",
  "kric-train-operation-organ": "266",
  "kric-transfer-movement-detailed": "307",
  "kric-transfer-movement-standard": "428",
  "kric-wheelchair-lift-location": "205",
  "kric-wheelchair-lift-movement": "209",
});

const URL_FIELDS = Object.freeze([
  ["detailUrl", (candidate) => candidate.detailUrl],
  ["requestUrl", (candidate) => candidate.requestUrl],
  ["evidence.endpoint", (candidate) => candidate.evidence?.endpoint],
  ["evidence.detailPageUrl", (candidate) => candidate.evidence?.detailPageUrl],
  ["evidence.sampleUrl", (candidate) => candidate.evidence?.sampleUrl],
  ["operation.endpoint", (candidate) => candidate.operation?.endpoint],
  ["operation.sampleUrl", (candidate) => candidate.operation?.sampleUrl],
]);

const DATA_GO_FOCUSED_TESTS = Object.freeze({
  "tools/datapack/collect-busan-accessibility.mjs": "tools/datapack/collect-busan-accessibility.test.mjs",
  "tools/datapack/collect-busan-route-topology.mjs": "tools/datapack/collect-busan-route-topology.test.mjs",
  "tools/datapack/collect-busan-timetable.mjs": "tools/datapack/collect-busan-timetable.test.mjs",
  "tools/datapack/collect-daejeon-route-topology.mjs": "tools/datapack/collect-daejeon-route-topology.test.mjs",
  "tools/datapack/collect-datago-source-candidate-evidence.mjs": "tools/datapack/collect-datago-source-candidate-evidence.test.mjs",
  "tools/datapack/collect-gwangju-timetable.mjs": "tools/datapack/collect-gwangju-timetable.test.mjs",
  "tools/datapack/collect-korail-itx-cheongchun-timetable.mjs": "tools/datapack/collect-korail-itx-cheongchun-timetable.test.mjs",
  "tools/datapack/collect-nationwide-public-api-coverage.mjs": "tools/datapack/collect-nationwide-public-api-coverage.test.mjs",
  "tools/datapack/collect-seoul-accessibility-evidence.mjs": "tools/datapack/collect-seoul-accessibility-evidence.test.mjs",
  "tools/datapack/collect-tago-itx-cheongchun-od.mjs": "tools/datapack/collect-tago-itx-cheongchun-od.test.mjs",
  "tools/datapack/fetch-kasi-public-holiday-calendar.mjs": "tools/datapack/fetch-kasi-public-holiday-calendar.test.mjs",
  "tools/datapack/probe-daejeon-coverage-api.mjs": "tools/datapack/probe-daejeon-coverage-api.test.mjs",
  "tools/datapack/probe-korail-train-operation-api.mjs": "tools/datapack/probe-korail-train-operation-api.test.mjs",
  "tools/datapack/probe-seoul-fare-api.mjs": "tools/datapack/probe-seoul-fare-api.test.mjs",
  "tools/datapack/probe-tago-train-date-semantics.mjs": "tools/datapack/probe-tago-train-date-semantics.test.mjs",
  "tools/datapack/revalidate-current-molit-transfer-source.mjs": "tools/datapack/revalidate-current-molit-transfer-source.test.mjs",
  "tools/datapack/run-current-itx-collection.mjs": "tools/datapack/run-current-itx-collection.test.mjs",
  "tools/datapack/validate-tago-schedule-sample.mjs": "tools/datapack/plan-tago-schedule-collection.test.mjs",
});

const document = JSON.parse(await readFile(CANDIDATES_PATH, "utf8"));

test("Seoul 노선별 지하철역 operation은 blank placeholders와 4호선 request token을 쓴다", () => {
  const candidate = document.candidates.find(({ id }) => id === "seoulmetro-station-line-info");
  assert.ok(candidate);
  assert.equal(candidate.evidence.sampleUrl,
    "http://openapi.seoul.go.kr:8088/[서비스키값]/json/SearchSTNBySubwayLineInfo/1/5/%20/%20/4호선");
});

test("FACILITY provider probe는 canonical identity 없이 exact tuple evidence만 만든다", async () => {
  const tuple = { railOprIsttCd: "GX", lnCd: "A", stinCd: "X101", stationName: "운정중앙" };
  const evidence = await collectKricAccessibilityProviderTupleEvidence({
    tuples: [tuple],
    operations: KRIC_APPROVED_ACCESSIBILITY_OPERATIONS.slice(0, 2),
    serviceKey: "super-secret",
    now: new Date("2026-08-05T00:00:00.000Z"),
    fetchImpl: async (url) => {
      const operationForRequest = KRIC_APPROVED_ACCESSIBILITY_OPERATIONS
        .find(({ endpoint }) => new URL(endpoint).pathname === url.pathname);
      return response(200, [Object.fromEntries(operationForRequest.responseFields.map((field) => [
        field, tuple[field] ?? field,
      ]))]);
    },
  });

  assert.equal(evidence.artifactKind, "kric-facility-provider-tuple-probe");
  assert.equal(evidence.productionAdmissionAllowed, false);
  assert.equal(evidence.operationCount, 2);
  assert.equal(evidence.queryCount, 2);
  assert.deepEqual(evidence.operations.map(({ sourceId, queries }) => ({ sourceId, tuples: queries.map((query) => query.providerTuple) })), [
    { sourceId: "kric-station-elevator", tuples: ["GX/A/X101"] },
    { sourceId: "kric-station-escalator", tuples: ["GX/A/X101"] },
  ]);
  assert.doesNotMatch(JSON.stringify(evidence), /stationId|lineId|super-secret|serviceKey/);
});

test("FACILITY provider probe는 empty 또는 partial operation을 evidence로 만들지 않는다", async () => {
  await assert.rejects(() => collectKricAccessibilityProviderTupleEvidence({
    tuples: [{ railOprIsttCd: "KR", lnCd: "1", stinCd: "116", stationName: "창동" }],
    operations: KRIC_APPROVED_ACCESSIBILITY_OPERATIONS.slice(0, 2),
    serviceKey: "key",
    fetchImpl: async (url) => {
      const operationForRequest = KRIC_APPROVED_ACCESSIBILITY_OPERATIONS
        .find(({ endpoint }) => new URL(endpoint).pathname === url.pathname);
      return response(200, url.pathname.endsWith("stationElevator") ? [Object.fromEntries(
        operationForRequest.responseFields.map((field) => [
          field, { railOprIsttCd: "KR", lnCd: "1", stinCd: "116" }[field] ?? field,
        ]),
      )] : []);
    },
  }), /KRIC provider tuple probe empty response: kric-station-escalator\/KR\/1\/116/);
});

test("FACILITY provider probe input은 tracked ledger·roster·catalog의 exact 20 tuple만 허용한다", async () => {
  const [resolution, routeRosters] = await Promise.all([
    readFile(new URL("./sources/facility-gap-resolution-evidence-20260731.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("./sources/kric-nationwide-route-rosters-20260730T203926676Z.json", import.meta.url), "utf8").then(JSON.parse),
  ]);

  const input = resolveKricFacilityProviderProbe({ resolution, routeRosters, candidatesDocument: document });
  assert.equal(input.tuples.length, 20);
  assert.equal(input.tuples.filter(({ railOprIsttCd }) => railOprIsttCd === "GX").length, 5);
  assert.equal(input.tuples.filter(({ railOprIsttCd }) => railOprIsttCd === "KR").length, 15);
  assert.deepEqual(input.operations.map(({ sourceId }) => sourceId), [
    "kric-station-elevator",
    "kric-station-escalator",
    "kric-wheelchair-lift-location",
    "kric-station-elevator-movement",
    "kric-wheelchair-lift-movement",
  ]);
  assert.throws(() => resolveKricFacilityProviderProbe({
    resolution,
    routeRosters: { ...routeRosters, rosters: [] },
    candidatesDocument: document,
  }), /KRIC FACILITY provider probe inputs are invalid/);
  assert.throws(() => resolveKricFacilityProviderProbe({
    resolution,
    routeRosters: {
      ...routeRosters,
      rosters: [{ ...routeRosters.rosters[0], resultCode: "03" }, ...routeRosters.rosters.slice(1)],
    },
    candidatesDocument: document,
  }), /KRIC FACILITY provider probe inputs are invalid/);
  assert.throws(() => resolveKricFacilityProviderProbe({
    resolution: {
      ...resolution,
      blockedGroups: resolution.blockedGroups.map((group, index) => index === 0
        ? { ...group, providerTuples: ["KR/A/X101", ...group.providerTuples.slice(1)] }
        : group),
    },
    routeRosters,
    candidatesDocument: document,
  }), /KRIC FACILITY blocked group is invalid/);
  assert.throws(() => resolveKricFacilityProviderProbe({
    resolution,
    routeRosters: {
      ...routeRosters,
      rosters: [{ ...routeRosters.rosters[0], stationCount: undefined, stations: undefined }, ...routeRosters.rosters.slice(1)],
    },
    candidatesDocument: document,
  }), /KRIC FACILITY provider probe inputs are invalid/);
});

test("FACILITY provider probe는 동일 키 control operation 성공 전 target을 호출하지 않는다", async () => {
  const serviceKey = `Aa1$${"a".repeat(56)}`;
  let calls = 0;
  const delays = [];
  const result = await preflightKricFacilityProviderProbe({
    candidatesDocument: document,
    serviceKey,
    requestIntervalMs: 250,
    delayImpl: async (milliseconds) => { delays.push(milliseconds); },
    fetchImpl: async (url) => {
      calls += 1;
      assert.equal(url.pathname, "/openapi/handicapped/stationCnvFacl");
      return response(200, [{ dtlLoc: "대합실", gubun: "1", stinFlor: "B1" }]);
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(delays, [250]);
  assert.deepEqual(result, { credentialRedacted: true, controlOperationId: "kric-station-convenience-standard" });

  calls = 0;
  await assert.rejects(() => preflightKricFacilityProviderProbe({
    candidatesDocument: document,
    serviceKey: "short",
    fetchImpl: async () => { calls += 1; },
  }), /kric credential length does not match/);
  assert.equal(calls, 0);

  await assert.rejects(() => preflightKricFacilityProviderProbe({
    candidatesDocument: document,
    serviceKey,
    fetchImpl: async () => response(200, [], "30"),
  }), /KRIC accessibility provider result invalid/);

  const twoRowControl = structuredClone(document);
  twoRowControl.providers.kric.controlOperation.expectedSuccess.minimumRowCount = 2;
  await assert.rejects(() => preflightKricFacilityProviderProbe({
    candidatesDocument: twoRowControl,
    serviceKey,
    fetchImpl: async () => response(200, [{ dtlLoc: "대합실", gubun: "1", stinFlor: "B1" }]),
  }), /KRIC FACILITY control operation success contract is invalid/);
});

function response(status, body, resultCode = "00") {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ header: { resultCode, resultMsg: "redacted" }, body }),
  };
}

function kricOpenApiCandidates() {
  return document.candidates.filter((candidate) => {
    if (typeof candidate.requestUrl !== "string") return false;
    return URL.parse(candidate.requestUrl)?.host === KRIC_OPENAPI_HOST;
  });
}

test("카탈로그의 endpoint·detail URL은 형식적으로 유효하고 credential-free다", () => {
  for (const candidate of document.candidates) {
    for (const [field, read] of URL_FIELDS) {
      const value = read(candidate);
      if (value == null) continue;
      const label = `${candidate.id}.${field}`;
      assert.equal(typeof value, "string", `${label} must be a string`);
      const url = URL.parse(value);
      assert.ok(url, `${label} must be a valid URL: ${value}`);
      assert.ok(["http:", "https:"].includes(url.protocol), `${label} must use HTTP(S): ${value}`);
      assert.ok(url.hostname, `${label} must have a host: ${value}`);
      assert.equal(url.username, "", `${label} must not embed credentials`);
      assert.equal(url.password, "", `${label} must not embed credentials`);
      assert.equal(url.hash, "", `${label} must not carry a fragment`);
    }
  }
});

test("MOLIT 도시철도 전체노선은 official public 20251211 CSV artifact만 쓴다", async () => {
  const candidate = document.candidates.find(({ id }) => id === "molit-urban-rail-full-route");
  assert.ok(candidate);
  const expected = "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003561913&fileDetailSn=1&insertDataPrcus=N";
  assert.equal(candidate.requestUrl, expected);
  assert.equal(candidate.evidence.endpoint, expected);
  assert.equal(candidate.serviceKeyHandling, "not_required");
  assert.deepEqual(candidate.evidence.formats, ["CSV"]);
  assert.doesNotMatch(JSON.stringify(candidate), /api\.odcloud|uddi:|Authorization/u);
  const runner = await readFile(path.join(
    DATAPACK_DIRECTORY,
    "revalidate-current-static-network-sources.mjs",
  ), "utf8");
  assert.doesNotMatch(runner, /DATA_GO_KR_SERVICE_KEY|normalizeDataGoKrServiceKey|api\.odcloud|Authorization|serviceKey/u);
});

test("evidence.endpoint는 requestUrl과 같은 provider host를 가리킨다", () => {
  const foreignHosts = document.candidates
    .filter((candidate) => candidate.evidence?.endpoint != null && candidate.requestUrl != null)
    .filter((candidate) => URL.parse(candidate.evidence.endpoint)?.host !== URL.parse(candidate.requestUrl)?.host)
    .map((candidate) => `${candidate.id}: ${candidate.evidence.endpoint}`);
  assert.deepEqual(foreignHosts, []);

  const organizationCodedEndpoints = document.candidates
    .filter((candidate) => URL_FIELDS.some(([, read]) => String(read(candidate) ?? "").includes("apis.data.go.kr/B551181")))
    .map((candidate) => candidate.id);
  assert.deepEqual(organizationCodedEndpoints, []);
});

test("KRIC OpenAPI candidate는 endpoint 3중 일치와 포털 정본 detail 페이지를 쓴다", () => {
  const candidates = kricOpenApiCandidates();
  assert.equal(candidates.length, 18);

  for (const candidate of candidates) {
    const requestUrl = new URL(candidate.requestUrl);
    const operationPath = KRIC_OPENAPI_PATH.exec(requestUrl.pathname);
    assert.ok(operationPath, `${candidate.id}.requestUrl must be /openapi/<service>/<operation>`);
    const [, service, operation] = operationPath;

    for (const field of ["evidence.endpoint", "operation.endpoint"]) {
      const value = field === "evidence.endpoint" ? candidate.evidence?.endpoint : candidate.operation?.endpoint;
      if (value == null) continue;
      assert.equal(value, candidate.requestUrl, `${candidate.id}.${field} must match requestUrl`);
    }

    const detailUrl = new URL(candidate.detailUrl);
    assert.equal(
      `${detailUrl.origin}${detailUrl.pathname}`,
      KRIC_PORTAL_DETAIL_URL,
      `${candidate.id}.detailUrl must be the KRIC portal detail page`,
    );
    assert.equal(detailUrl.searchParams.get("service"), service, `${candidate.id}.detailUrl service must match the operation path`);
    assert.equal(detailUrl.searchParams.get("operation"), operation, `${candidate.id}.detailUrl operation must match the operation path`);
    assert.equal(
      detailUrl.searchParams.get("id"),
      KRIC_PORTAL_DETAIL_IDS[candidate.id],
      `${candidate.id}.detailUrl id must match the verified portal dataset id`,
    );
    if (candidate.evidence?.detailPageUrl != null) {
      assert.equal(candidate.evidence.detailPageUrl, candidate.detailUrl, `${candidate.id}.evidence.detailPageUrl must match detailUrl`);
    }
  }

  assert.deepEqual(candidates.map(({ id }) => id).sort(), Object.keys(KRIC_PORTAL_DETAIL_IDS).sort());
});

test("KRIC provider는 키 형상 계약과 검증된 대조군 operation을 카탈로그에 명시한다", () => {
  const integrity = resolveProviderCallIntegrity(document, "kric");
  assert.equal(integrity.credential.env, "KRIC_SERVICE_KEY");

  const control = document.candidates.find(({ id }) => id === integrity.controlOperation.candidateId);
  assert.ok(control, "control operation candidate must exist in the catalog");
  assert.equal(integrity.controlOperation.endpoint, control.requestUrl);
  assert.equal(
    integrity.controlOperation.sampleUrl,
    control.operation?.sampleUrl ?? control.evidence.sampleUrl,
    "control operation sampleUrl must match the tracked candidate sample",
  );
  assert.equal(new URL(control.requestUrl).pathname, "/openapi/handicapped/stationCnvFacl");

  // 기대 성공 형태는 창작이 아니라 대조군 candidate가 카탈로그에 기록한 provider 출력 필드에서만 나온다.
  const documentedFields = new Set(control.operation?.responseFields ?? control.evidence.outputFields);
  const undocumented = integrity.controlOperation.expectedSuccess.requiredFields
    .filter((field) => !documentedFields.has(field));
  assert.deepEqual(undocumented, [], "expectedSuccess.requiredFields must be documented provider output fields");
  assert.ok(integrity.controlOperation.expectedSuccess.minimumRowCount >= 1);

  // credential 신호 코드도 창작이 아니다. 카탈로그가 실측으로 기록한 AUTHORIZATION_REQUIRED 관찰이 출처다.
  const observedAuthorizationCodes = new Set(document.candidates
    .map((entry) => entry.evidence?.operationLiveValidation)
    .filter((observation) => observation?.schemaStatus === "AUTHORIZATION_REQUIRED")
    .map((observation) => observation.providerResultCode));
  assert.ok(observedAuthorizationCodes.size > 0, "catalog must record at least one AUTHORIZATION_REQUIRED observation");
  const unobserved = integrity.credentialSignalResultCodes
    .filter((code) => !observedAuthorizationCodes.has(code));
  assert.deepEqual(unobserved, [], "credentialSignalResultCodes must come from recorded AUTHORIZATION_REQUIRED observations");
});

test("DATA_GO_KR_SERVICE_KEY runner는 공통 deterministic credential-validation 계약을 구현한다", async () => {
  const coverage = document.credentialBearingProviderCoverage;
  assert.ok(Array.isArray(coverage), "credentialBearingProviderCoverage must be an array");
  assert.equal(coverage.length, 1, "DATA_GO_KR_SERVICE_KEY coverage must have one provider entry");

  const [dataGoKr] = coverage;
  assert.deepEqual(Object.keys(dataGoKr).sort(), [
    "credentialEnv",
    "implementationStatus",
    "providerId",
    "reason",
    "requiredClassification",
    "runners",
  ]);
  assert.equal(dataGoKr.providerId, "data-go-kr");
  assert.equal(dataGoKr.credentialEnv, "DATA_GO_KR_SERVICE_KEY");
  assert.equal(dataGoKr.requiredClassification, "DETERMINISTIC_CREDENTIAL_VALIDATION_ONLY");
  assert.equal(dataGoKr.implementationStatus, "IMPLEMENTED");
  assert.equal(
    dataGoKr.reason,
    "all current runners validate DATA_GO_KR_SERVICE_KEY through the shared deterministic boundary before provider calls",
  );

  const files = await readdir(DATAPACK_DIRECTORY, { recursive: true });
  const expectedRunners = [];
  for (const file of files) {
    if (!file.endsWith(".mjs") || file.endsWith(".test.mjs")) continue;
    const runner = path.posix.join("tools/datapack", file.split(path.sep).join(path.posix.sep));
    const source = await readFile(path.join(DATAPACK_DIRECTORY, file), "utf8");
    if (!source.includes("DATA_GO_KR_SERVICE_KEY")) continue;
    assert.match(source, /import\s*\{[^}]*\bnormalizeDataGoKrServiceKey\b[^}]*\}\s*from\s*["']\.\/lib\/provider-call-integrity\.mjs["']/s, `${runner} must import the shared normalizer`);
    assert.match(source, /(?<!function\s)normalizeDataGoKrServiceKey\s*\(/, `${runner} must call the shared normalizer`);
    expectedRunners.push(runner);
  }
  expectedRunners.sort();

  assert.deepEqual(dataGoKr.runners, expectedRunners);
  assert.equal(new Set(dataGoKr.runners).size, dataGoKr.runners.length, "runners must be unique");
  assert.deepEqual(dataGoKr.runners, [...dataGoKr.runners].sort(), "runners must be path-sorted");
});

test("모든 DATA_GO runner는 정확히 대응하는 focused test에서 malformed credential의 provider 호출 0회를 증명한다", async () => {
  const [dataGoKr] = document.credentialBearingProviderCoverage;
  const files = await readdir(DATAPACK_DIRECTORY, { recursive: true });
  const discoveredRunners = [];
  for (const file of files) {
    if (!file.endsWith(".mjs") || file.endsWith(".test.mjs")) continue;
    const runner = path.posix.join("tools/datapack", file.split(path.sep).join(path.posix.sep));
    const source = await readFile(path.join(DATAPACK_DIRECTORY, file), "utf8");
    if (source.includes("DATA_GO_KR_SERVICE_KEY")) discoveredRunners.push(runner);
  }
  discoveredRunners.sort();

  assert.deepEqual(Object.keys(DATA_GO_FOCUSED_TESTS).sort(), discoveredRunners);
  assert.deepEqual(Object.keys(DATA_GO_FOCUSED_TESTS).sort(), dataGoKr.runners);
  for (const [runner, focusedTest] of Object.entries(DATA_GO_FOCUSED_TESTS)) {
    const testSource = await readFile(path.join(DATAPACK_DIRECTORY, path.basename(focusedTest)), "utf8");
    assert.match(testSource, /invalid%ZZ/, `${focusedTest} must cover malformed DATA_GO_KR_SERVICE_KEY for ${runner}`);
    assert.match(testSource, /assert\.equal\(calls, 0\)/, `${focusedTest} must prove provider/delegate calls stay at zero for ${runner}`);
  }
});

test("4개 DATA_GO runner는 malformed credential을 URL·cache·fetch·delegate보다 먼저 preflight하고 matching focused test가 calls=0을 증명한다", async () => {
  const orderingContracts = [
    {
      runner: "tools/datapack/collect-datago-source-candidate-evidence.mjs",
      test: "tools/datapack/collect-datago-source-candidate-evidence.test.mjs",
      functionName: "collectDatagoSourceCandidateEvidence",
      before: ["readFile(CANDIDATES_PATH", "resolveDatagoCandidateRequest(", "collectSourceCandidateEvidence("],
    },
    {
      runner: "tools/datapack/collect-seoul-accessibility-evidence.mjs",
      test: "tools/datapack/collect-seoul-accessibility-evidence.test.mjs",
      functionName: "collectSeoulAccessibility",
      before: ["new URL(endpoint)", "fetchImpl("],
    },
    {
      runner: "tools/datapack/fetch-kasi-public-holiday-calendar.mjs",
      test: "tools/datapack/fetch-kasi-public-holiday-calendar.test.mjs",
      functionName: "fetchKasiPublicHolidayCalendar",
      before: ["new URL(ENDPOINT)", "fetchImpl("],
    },
    {
      runner: "tools/datapack/collect-nationwide-public-api-coverage.mjs",
      test: "tools/datapack/collect-nationwide-public-api-coverage.test.mjs",
      functionName: "collectNationwidePublicApiCoverage",
      before: ["validatePlan(searchPlan)", "new Map()", "runQuery("],
    },
  ];
  assert.deepEqual(
    orderingContracts.map(({ runner }) => runner),
    [
      "tools/datapack/collect-datago-source-candidate-evidence.mjs",
      "tools/datapack/collect-seoul-accessibility-evidence.mjs",
      "tools/datapack/fetch-kasi-public-holiday-calendar.mjs",
      "tools/datapack/collect-nationwide-public-api-coverage.mjs",
    ],
  );

  for (const contract of orderingContracts) {
    const [runnerSource, testSource] = await Promise.all([
      readFile(path.join(DATAPACK_DIRECTORY, path.basename(contract.runner)), "utf8"),
      readFile(path.join(DATAPACK_DIRECTORY, path.basename(contract.test)), "utf8"),
    ]);
    const functionStart = runnerSource.indexOf(`export async function ${contract.functionName}`);
    assert.ok(functionStart >= 0, `${contract.runner} must export ${contract.functionName}`);
    const functionEnd = runnerSource.indexOf("\n}\n", functionStart);
    const body = runnerSource.slice(functionStart, functionEnd);
    const normalizerIndex = body.indexOf("normalizeDataGoKrServiceKey(");
    assert.ok(normalizerIndex >= 0, `${contract.runner} must preflight DATA_GO_KR_SERVICE_KEY`);
    for (const operation of contract.before) {
      const operationIndex = body.indexOf(operation);
      assert.ok(operationIndex >= 0, `${contract.runner} must contain ${operation}`);
      assert.ok(normalizerIndex < operationIndex, `${contract.runner} must preflight before ${operation}`);
    }
    assert.match(testSource, /invalid%ZZ/, `${contract.test} must exercise malformed percent encoding`);
    assert.match(testSource, /assert\.equal\(calls, 0\)/, `${contract.test} must prove provider calls stay at zero`);
  }
});
