// #22: 카탈로그 endpoint·detailUrl 실재 계약. 네트워크 호출 없이 형식과 provider host 규약만 검사한다.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { resolveProviderCallIntegrity } from "./lib/provider-call-integrity.mjs";
import {
  collectKricAccessibilityProviderTupleEvidence,
  KRIC_APPROVED_ACCESSIBILITY_OPERATIONS,
} from "./collect-kric-accessibility-snapshots.mjs";
import { resolveKricFacilityProviderProbe } from "./probe-kric-facility-provider-tuples.mjs";

const CANDIDATES_PATH = path.join(import.meta.dirname, "source-candidates.json");
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

const document = JSON.parse(await readFile(CANDIDATES_PATH, "utf8"));

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
