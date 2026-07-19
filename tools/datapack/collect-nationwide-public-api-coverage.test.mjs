import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNationwidePublicApiSearchPlan,
  collectNationwidePublicApiCoverage,
} from "./collect-nationwide-public-api-coverage.mjs";

const target = {
  regionId: "busan",
  operatorId: "busan-transportation",
  lineId: "line-ab1a041f6266",
  sourceDomain: "schedule_timetable",
  fallback: "STATIC_LOCAL",
  userMessageKo: "공공기관 API에서 시간표 데이터를 제공하지 않습니다.",
  queries: [{
    providerId: "kric",
    endpoint: "https://openapi.kric.go.kr/openapi/trainUseInfo/subwayTimetable",
    operation: "subwayTimetable",
    credentialEnv: "KRIC_SERVICE_KEY",
    credentialParam: "serviceKey",
    format: "xml",
    query: { railOprIsttCd: "B1", lnCd: "1" },
  }],
};

function plan(entries = [target]) {
  return {
    schemaVersion: 1,
    artifactKind: "nationwide-public-api-coverage-search-plan",
    targetVersion: "2026-07-13",
    entries,
  };
}

function xmlResponse({ code = "00", items = "" } = {}) {
  return new Response(
    `<ROOT><header><resultCnt>${items ? 1 : 0}</resultCnt><resultCode>${code}</resultCode><resultMsg>OK</resultMsg></header><body>${items}</body></ROOT>`,
    { status: 200, headers: { "content-type": "application/xml" } },
  );
}

test("수동 검색 plan은 endpoint URL에 포함된 credential을 거부한다", async () => {
  for (const endpoint of [
    "https://user:password@openapi.kric.go.kr/openapi/trainUseInfo/subwayTimetable",
    "https://openapi.kric.go.kr/openapi/trainUseInfo/subwayTimetable?serviceKey=secret",
  ]) {
    await assert.rejects(
      collectNationwidePublicApiCoverage({
        searchPlan: plan([{ ...target, queries: [{ ...target.queries[0], endpoint }] }]),
        credentials: { KRIC_SERVICE_KEY: "key" },
        fetchImpl: async () => xmlResponse(),
      }),
      /endpoint must not contain credentials/,
    );
  }
});

test("전국 target과 fixture에서 line AND domain 실제 검색 계획을 만든다", () => {
  const searchPlan = buildNationwidePublicApiSearchPlan({
    targets: {
      targetVersion: "2026-07-13",
      activeLineScopes: [{ regionId: "busan", operatorId: "busan-transportation", lineId: "busan-1" }],
      requiredSourceDomains: [
        { id: "realtime_arrivals", releaseTier: "LAUNCH_REQUIRED" },
        { id: "demand_reference", releaseTier: "ENHANCEMENT" },
      ],
    },
    fixture: {
      packs: [{
        operators: [{ id: "busan-transportation", nameKo: "부산교통공사" }],
        lines: [{ id: "busan-1", nameKo: "부산 1호선" }],
      }],
    },
  });

  assert.equal(searchPlan.entries.length, 1);
  assert.equal(searchPlan.entries[0].sourceDomain, "realtime_arrivals");
  assert.equal(searchPlan.entries[0].fallback, "UNSUPPORTED_REGION");
  assert.deepEqual(searchPlan.entries[0].queries[0].query.organizations, ["부산교통공사"]);
  assert.equal(searchPlan.entries[0].queries[0].query.page, 0);
  assert.equal(searchPlan.entries[0].queries[0].query.size, 10_000);
  assert.equal(searchPlan.entries[0].queries[0].query.keyword, "1호선");
  assert.equal(searchPlan.entries[0].queries[0].credentialParam, "Authorization");
  assert.deepEqual(searchPlan.entries[0].queries[0].matchTermGroups[1], ["1호선"]);
  const operatorWideQuery = searchPlan.entries[0].queries.find(({ query }) => query.keyword === "실시간도착");
  assert.ok(operatorWideQuery);
  assert.equal(operatorWideQuery.coverageScope, "OPERATOR_DISCOVERY");
  assert.deepEqual(operatorWideQuery.query.organizations, ["부산교통공사"]);
  assert.deepEqual(operatorWideQuery.matchTermGroups, [[
    "실시간도착",
    "실시간열차",
    "열차위치",
    "도착정보",
    "실제일시",
  ]]);
});

test("KORAIL 검색은 공공데이터포털 정식 기관명을 사용한다", () => {
  const searchPlan = buildNationwidePublicApiSearchPlan({
    targets: {
      targetVersion: "2026-07-13",
      activeLineScopes: [{ regionId: "busan", operatorId: "korail", lineId: "donghae" }],
      requiredSourceDomains: [{ id: "route_graph_topology", releaseTier: "LAUNCH_REQUIRED" }],
    },
    fixture: {
      packs: [{
        operators: [{ id: "korail", nameKo: "코레일" }],
        lines: [{ id: "donghae", nameKo: "동해선" }],
      }],
    },
  });

  assert.ok(searchPlan.entries[0].queries.length > 0);
  assert.ok(searchPlan.entries[0].queries.every(
    ({ query }) => query.organizations[0] === "한국철도공사",
  ));
});

test("KORAIL scope도 fixture 운영기관이 없으면 검색 계획 생성을 거부한다", () => {
  assert.throws(
    () => buildNationwidePublicApiSearchPlan({
      targets: {
        targetVersion: "2026-07-13",
        activeLineScopes: [{ regionId: "busan", operatorId: "korail", lineId: "donghae" }],
        requiredSourceDomains: [{ id: "route_graph_topology", releaseTier: "LAUNCH_REQUIRED" }],
      },
      fixture: {
        packs: [{
          operators: [],
          lines: [{ id: "donghae", nameKo: "동해선" }],
        }],
      },
    }),
    /operator korail is required/,
  );
});

test("운영기관 공통 검색 결과는 현재 line 지원 증거가 아니라 검증 대기 후보로 남긴다", async () => {
  const searchTarget = {
    ...target,
    queries: [{
      providerId: "data-go-search",
      endpoint: "https://api.odcloud.kr/api/GetSearchDataList/v1/searchData",
      operation: "searchData",
      credentialEnv: "DATA_GO_KR_SERVICE_KEY",
      credentialParam: "Authorization",
      credentialPlacement: "header",
      method: "POST",
      format: "json",
      coverageScope: "OPERATOR_DISCOVERY",
      matchTermGroups: [["실시간도착", "도착정보"]],
      query: { page: 0, size: 10_000, dataType: ["API"], organizations: ["부산교통공사"], keyword: "실시간도착" },
    }],
  };
  const resolutions = await collectNationwidePublicApiCoverage({
    searchPlan: plan([searchTarget]),
    credentials: { DATA_GO_KR_SERVICE_KEY: "key" },
    fetchImpl: async () => new Response(JSON.stringify({
      statusCode: 200,
      result: { sum: 1, dataCount: 1, data: [{ dataName: "부산교통공사 실시간도착정보" }] },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  assert.equal(resolutions.entries.length, 0);
  assert.equal(resolutions.unresolved[0].reasonCode, "PUBLIC_API_CANDIDATE_REQUIRES_LINE_VALIDATION");
});

test("전국 공통 provider 후보가 있으면 운영기관 catalog 0건을 공식 미지원으로 확정하지 않는다", async () => {
  const searchPlan = buildNationwidePublicApiSearchPlan({
    targets: {
      targetVersion: "2026-07-13",
      activeLineScopes: [{ regionId: "busan", operatorId: "busan-transportation", lineId: "busan-1" }],
      requiredSourceDomains: [{ id: "schedule_timetable", releaseTier: "LAUNCH_REQUIRED" }],
    },
    fixture: {
      packs: [{
        operators: [{ id: "busan-transportation", nameKo: "부산교통공사" }],
        lines: [{ id: "busan-1", nameKo: "부산 1호선" }],
      }],
    },
    sourceCandidates: {
      candidates: [{
        id: "kric-subway-timetable",
        domain: "schedule_timetable",
        operation: { endpoint: "https://openapi.kric.go.kr/openapi/trainUseInfo/subwayTimetable" },
      }],
    },
  });

  assert.deepEqual(searchPlan.entries[0].knownProviderCandidateIds, ["kric-subway-timetable"]);

  const resolutions = await collectNationwidePublicApiCoverage({
    searchPlan,
    credentials: { DATA_GO_KR_SERVICE_KEY: "key" },
    fetchImpl: async () => new Response(JSON.stringify({
      statusCode: 200,
      result: { sum: 0, dataCount: 0, data: [] },
    }), { status: 200, headers: { "content-type": "application/json" } }),
    now: new Date("2026-07-13T00:00:00.000Z"),
  });

  assert.equal(resolutions.entries.length, 0);
  assert.deepEqual(resolutions.unresolved[0], {
    regionId: "busan",
    operatorId: "busan-transportation",
    lineId: "busan-1",
    sourceDomain: "schedule_timetable",
    reasonCode: "KNOWN_PROVIDER_REQUIRES_LINE_VALIDATION",
    providerCandidateIds: ["kric-subway-timetable"],
  });
});

test("지역 전용 provider 후보는 다른 지역의 공식 미지원 판정을 막지 않는다", () => {
  const searchPlan = buildNationwidePublicApiSearchPlan({
    targets: {
      targetVersion: "2026-07-13",
      activeLineScopes: [
        { regionId: "busan", operatorId: "busan-transportation", lineId: "busan-1" },
        { regionId: "daejeon", operatorId: "daejeon-transportation", lineId: "daejeon-1" },
      ],
      requiredSourceDomains: [{ id: "route_graph_topology", releaseTier: "LAUNCH_REQUIRED" }],
    },
    fixture: {
      packs: [{
        operators: [
          { id: "busan-transportation", nameKo: "부산교통공사" },
          { id: "daejeon-transportation", nameKo: "대전교통공사" },
        ],
        lines: [
          { id: "busan-1", nameKo: "부산 1호선" },
          { id: "daejeon-1", nameKo: "대전 1호선" },
        ],
      }],
    },
    sourceCandidates: {
      candidates: [{
        id: "daejeon-station-distance-fare",
        domain: "route_graph_topology",
        requestUrl: "https://api.odcloud.kr/api/15082979/v1/example",
        coverageScope: { lineIds: ["daejeon-1"] },
      }],
    },
  });

  assert.deepEqual(searchPlan.entries.map(({ lineId, knownProviderCandidateIds }) => ({
    lineId,
    knownProviderCandidateIds,
  })), [
    { lineId: "busan-1", knownProviderCandidateIds: [] },
    { lineId: "daejeon-1", knownProviderCandidateIds: ["daejeon-station-distance-fare"] },
  ]);
});

test("기존 HTTP 공식 provider도 정확한 scope의 미지원 판정을 막는다", () => {
  const searchPlan = buildNationwidePublicApiSearchPlan({
    targets: {
      targetVersion: "2026-07-13",
      activeLineScopes: [
        { regionId: "capital", operatorId: "seoul-metro", lineId: "seoul-2" },
        { regionId: "busan", operatorId: "busan-transportation", lineId: "busan-1" },
      ],
      requiredSourceDomains: [{ id: "realtime_arrivals", releaseTier: "LAUNCH_REQUIRED" }],
    },
    fixture: {
      packs: [{
        operators: [
          { id: "seoul-metro", nameKo: "서울교통공사" },
          { id: "busan-transportation", nameKo: "부산교통공사" },
        ],
        lines: [
          { id: "seoul-2", nameKo: "수도권 2호선" },
          { id: "busan-1", nameKo: "부산 1호선" },
        ],
      }],
    },
    sourceCandidates: {
      candidates: [{
        id: "seoul-topis-realtime-station-arrival",
        domain: "realtime_arrivals",
        requestUrl: "http://swopenapi.seoul.go.kr/api/subway/{serviceKey}/json/realtimeStationArrival",
        coverageScope: { regionIds: ["capital"] },
      }],
    },
  });

  assert.deepEqual(searchPlan.entries.map(({ lineId, knownProviderCandidateIds }) => ({
    lineId,
    knownProviderCandidateIds,
  })), [
    { lineId: "seoul-2", knownProviderCandidateIds: ["seoul-topis-realtime-station-arrival"] },
    { lineId: "busan-1", knownProviderCandidateIds: [] },
  ]);
});

test("공공데이터 검색이 거부하는 GTX-A 문장부호는 안전한 alias로 정규화한다", () => {
  const searchPlan = buildNationwidePublicApiSearchPlan({
    targets: {
      targetVersion: "2026-07-13",
      activeLineScopes: [{ regionId: "capital", operatorId: "gtx-a", lineId: "gtx-a" }],
      requiredSourceDomains: [{ id: "realtime_arrivals", releaseTier: "LAUNCH_REQUIRED" }],
    },
    fixture: {
      packs: [{
        operators: [{ id: "gtx-a", nameKo: "지티엑스에이운영" }],
        lines: [{ id: "gtx-a", nameKo: "수도권 GTX-A" }],
      }],
    },
  });

  assert.deepEqual(searchPlan.entries[0].queries.map(({ query }) => query.keyword), [
    "GTXA",
    "실시간도착",
    "실시간열차",
    "열차위치",
    "도착정보",
    "실제일시",
  ]);
  assert.deepEqual(searchPlan.entries[0].queries[0].matchTermGroups[1], ["GTXA"]);
});

test("공공기관 API 정상 0건만 공식 미지원 resolution을 생성한다", async () => {
  const secret = "never-print-this-key";
  const resolutions = await collectNationwidePublicApiCoverage({
    searchPlan: plan(),
    credentials: { KRIC_SERVICE_KEY: secret },
    fetchImpl: async () => xmlResponse(),
    now: new Date("2026-07-13T00:00:00.000Z"),
  });

  assert.equal(resolutions.entries.length, 1);
  assert.equal(resolutions.unresolved.length, 0);
  assert.match(resolutions.searchPlanSha256, /^[a-f0-9]{64}$/);
  assert.equal(resolutions.entries[0].state, "EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE");
  assert.equal(resolutions.entries[0].publicApiQueries[0].providerResultCode, "00");
  assert.equal(resolutions.entries[0].publicApiQueries[0].schemaStatus, "EXPECTED");
  assert.equal(resolutions.entries[0].publicApiQueries[0].matchCount, 0);
  assert.deepEqual(resolutions.entries[0].requiredProviderIds, ["kric"]);
  assert.doesNotMatch(JSON.stringify(resolutions), new RegExp(secret));
});

test("공식 미지원 provider ID는 locale 순서로 고정한다", async () => {
  const resolutions = await collectNationwidePublicApiCoverage({
    searchPlan: plan([{
      ...target,
      queries: [
        { ...target.queries[0], providerId: "Zulu" },
        { ...target.queries[0], providerId: "alpha" },
      ],
    }]),
    credentials: { KRIC_SERVICE_KEY: "key" },
    fetchImpl: async () => xmlResponse(),
    now: new Date("2026-07-13T00:00:00.000Z"),
  });

  assert.deepEqual(resolutions.entries[0].requiredProviderIds, ["alpha", "Zulu"]);
});

test("공공데이터포털 검색 API를 POST로 실제 조회해 전체 검색 건수를 판정한다", async () => {
  const searchTarget = {
    ...target,
    sourceDomain: "realtime_arrivals",
    fallback: "UNSUPPORTED_REGION",
    userMessageKo: "공공기관 API에서 실시간 도착 데이터를 제공하지 않습니다.",
    queries: [{
      providerId: "data-go-search",
      endpoint: "https://api.odcloud.kr/api/GetSearchDataList/v1/searchData",
      operation: "searchData",
      credentialEnv: "DATA_GO_KR_SERVICE_KEY",
      credentialParam: "Authorization",
      credentialPlacement: "header",
      method: "POST",
      format: "json",
      query: { page: 0, size: 10_000, dataType: ["API"], keyword: "부산교통공사 실시간 도착" },
    }],
  };
  const resolutions = await collectNationwidePublicApiCoverage({
    searchPlan: plan([searchTarget]),
    credentials: { DATA_GO_KR_SERVICE_KEY: "encoded%2Bkey" },
    fetchImpl: async (url, init) => {
      assert.equal(init.method, "POST");
      assert.equal(init.headers["content-type"], "application/json");
      assert.equal(init.headers.Authorization, "Infuser encoded+key");
      assert.deepEqual(JSON.parse(init.body), searchTarget.queries[0].query);
      assert.equal(url.searchParams.has("serviceKey"), false);
      return new Response(JSON.stringify({ statusCode: 200, result: { sum: 0, dataCount: 0, data: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    now: new Date("2026-07-13T00:00:00.000Z"),
  });

  assert.equal(resolutions.entries.length, 1);
  assert.equal(resolutions.entries[0].publicApiQueries[0].matchCount, 0);
  assert.equal(resolutions.entries[0].publicApiQueries[0].providerResultCode, "00");
});

test("같은 공공기관 검색 request는 여러 domain에서 한 번만 호출한다", async () => {
  const query = {
    providerId: "data-go-search",
    endpoint: "https://api.odcloud.kr/api/GetSearchDataList/v1/searchData",
    operation: "searchData",
    credentialEnv: "DATA_GO_KR_SERVICE_KEY",
    credentialParam: "Authorization",
    credentialPlacement: "header",
    method: "POST",
    format: "json",
    query: { page: 0, size: 10_000, dataType: ["API"], organizations: ["부산교통공사"], keyword: "1호선" },
  };
  let calls = 0;
  const resolutions = await collectNationwidePublicApiCoverage({
    searchPlan: plan([
      { ...target, queries: [{ ...query, matchAnyTerms: ["시간표"] }] },
      {
        ...target,
        sourceDomain: "realtime_arrivals",
        fallback: "UNSUPPORTED_REGION",
        queries: [{ ...query, matchAnyTerms: ["실시간도착"] }],
      },
    ]),
    credentials: { DATA_GO_KR_SERVICE_KEY: "key" },
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ statusCode: 200, result: { sum: 0, dataCount: 0, data: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(calls, 1);
  assert.equal(resolutions.entries.length, 2);
});

test("JSON schema mismatch는 값 없이 bounded field contract만 남긴다", async () => {
  const searchTarget = {
    ...target,
    queries: [{
      providerId: "data-go-search",
      endpoint: "https://api.odcloud.kr/api/GetSearchDataList/v1/searchData",
      operation: "searchData",
      credentialEnv: "DATA_GO_KR_SERVICE_KEY",
      credentialParam: "Authorization",
      credentialPlacement: "header",
      method: "POST",
      format: "json",
      query: { keyword: "secret-free-query" },
    }],
  };
  const resolutions = await collectNationwidePublicApiCoverage({
    searchPlan: plan([searchTarget]),
    credentials: { DATA_GO_KR_SERVICE_KEY: "never-print-this-key" },
    fetchImpl: async () => new Response(JSON.stringify({
      statusCode: 200,
      currentCount: 0,
      data: [],
      metadata: { requestId: "private-value", elapsedMs: 12 },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  assert.deepEqual(resolutions.unresolved[0].jsonShape, {
    currentCount: "number",
    data: "array(empty)",
    metadata: { elapsedMs: "number", requestId: "string" },
    statusCode: "number",
  });
  assert.doesNotMatch(JSON.stringify(resolutions), /private-value|never-print-this-key/);
});

test("공공데이터 검색 결과는 공개 metadata의 domain term과 일치한 행만 센다", async () => {
  const searchTarget = {
    ...target,
    sourceDomain: "realtime_arrivals",
    queries: [{
      providerId: "data-go-search",
      endpoint: "https://api.odcloud.kr/api/GetSearchDataList/v1/searchData",
      operation: "searchData",
      credentialEnv: "DATA_GO_KR_SERVICE_KEY",
      credentialParam: "Authorization",
      credentialPlacement: "header",
      method: "POST",
      format: "json",
      matchTermGroups: [["실시간도착", "열차위치"], ["1호선"]],
      query: { page: 0, size: 10_000, dataType: ["API"], organizations: ["부산교통공사"] },
    }],
  };
  const resolutions = await collectNationwidePublicApiCoverage({
    searchPlan: plan([searchTarget]),
    credentials: { DATA_GO_KR_SERVICE_KEY: "key" },
    fetchImpl: async () => new Response(JSON.stringify({
      statusCode: 200,
      result: {
        sum: 2,
        dataCount: 2,
        data: [
          {
            dataName: "부산 도시철도 1호선 실시간도착",
            dataDescription: "열차 도착 정보",
            keywords: ["도착"],
            organization: "부산교통공사",
            detailPageUrl: "https://www.data.go.kr/data/123/openapi.do",
            privateField: "수집하면 안 됨",
          },
          { dataName: "부산 도시철도 2호선 시간표", dataDescription: "표준 시각", keywords: ["시간표"] },
        ],
      },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  assert.equal(resolutions.entries.length, 0);
  assert.equal(resolutions.unresolved[0].reasonCode, "PUBLIC_API_DATA_AVAILABLE");
  assert.equal(resolutions.unresolved[0].matchCount, 1);
  assert.deepEqual(resolutions.unresolved[0].matches, [{
    dataName: "부산 도시철도 1호선 실시간도착",
    dataDescription: "열차 도착 정보",
    organization: "부산교통공사",
    keywords: ["도착"],
    detailPageUrl: "https://www.data.go.kr/data/123/openapi.do",
  }]);
  assert.doesNotMatch(JSON.stringify(resolutions), /privateField|수집하면 안 됨/);
});

test("metadata relevance 검색은 전체 page를 결합한 뒤 공식 미지원 여부를 판정한다", async () => {
  const searchTarget = {
    ...target,
    queries: [{
      providerId: "data-go-search",
      endpoint: "https://api.odcloud.kr/api/GetSearchDataList/v1/searchData",
      operation: "searchData",
      credentialEnv: "DATA_GO_KR_SERVICE_KEY",
      credentialParam: "Authorization",
      credentialPlacement: "header",
      method: "POST",
      format: "json",
      matchAnyTerms: ["시간표"],
      query: { page: 0, size: 1, dataType: ["API"], organizations: ["부산교통공사"] },
    }],
  };
  const requestedPages = [];
  const resolutions = await collectNationwidePublicApiCoverage({
    searchPlan: plan([searchTarget]),
    credentials: { DATA_GO_KR_SERVICE_KEY: "key" },
    fetchImpl: async (_url, init) => {
      const { page } = JSON.parse(init.body);
      requestedPages.push(page);
      return new Response(JSON.stringify({
        statusCode: 200,
        result: {
          sum: 2,
          dataCount: 1,
          data: [{ dataName: page === 0 ? "운행정보" : "1호선 시간표" }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(resolutions.entries.length, 0);
  assert.equal(resolutions.unresolved[0].reasonCode, "PUBLIC_API_DATA_AVAILABLE");
  assert.equal(resolutions.unresolved[0].matchCount, 1);
  assert.deepEqual(requestedPages, [0, 1]);
});

test("공공데이터 pagination이 빈 page나 반복 page로 정체되면 MISSING으로 남긴다", async () => {
  const searchTarget = {
    ...target,
    queries: [{
      providerId: "data-go-search",
      endpoint: "https://api.odcloud.kr/api/GetSearchDataList/v1/searchData",
      operation: "searchData",
      credentialEnv: "DATA_GO_KR_SERVICE_KEY",
      credentialParam: "Authorization",
      credentialPlacement: "header",
      method: "POST",
      format: "json",
      matchAnyTerms: ["시간표"],
      query: { page: 0, size: 1, dataType: ["API"], organizations: ["부산교통공사"] },
    }],
  };
  const resolutions = await collectNationwidePublicApiCoverage({
    searchPlan: plan([searchTarget]),
    credentials: { DATA_GO_KR_SERVICE_KEY: "key" },
    fetchImpl: async (_url, init) => {
      const { page } = JSON.parse(init.body);
      return new Response(JSON.stringify({
        statusCode: 200,
        result: {
          sum: 2,
          dataCount: page === 0 ? 1 : 0,
          data: page === 0 ? [{ dataName: "운행정보" }] : [],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(resolutions.entries.length, 0);
  assert.equal(resolutions.unresolved[0].reasonCode, "PUBLIC_API_SEARCH_INCOMPLETE");
  assert.equal(resolutions.unresolved[0].totalCount, 2);
  assert.equal(resolutions.unresolved[0].collectedCount, 1);
});

test("데이터 존재·provider 실패·bounded retry 실패는 MISSING으로 남긴다", async () => {
  let retryCalls = 0;
  const entries = [
    { ...target, queries: [{ ...target.queries[0], captureFields: ["stinCd"] }] },
    {
      ...target,
      lineId: "line-d74614a04530",
      queries: [{ ...target.queries[0], query: { railOprIsttCd: "B1", lnCd: "2" } }],
    },
    {
      ...target,
      lineId: "line-d812a5bc1e5f",
      queries: [{ ...target.queries[0], query: { railOprIsttCd: "B1", lnCd: "3" } }],
    },
  ];
  const resolutions = await collectNationwidePublicApiCoverage({
    searchPlan: plan(entries),
    credentials: { KRIC_SERVICE_KEY: "secret" },
    fetchImpl: async (url) => {
      if (url.searchParams.get("lnCd") === "1") {
        return xmlResponse({ items: "<item><stinCd>101</stinCd></item>" });
      }
      if (url.searchParams.get("lnCd") === "2") return xmlResponse({ code: "99" });
      retryCalls += 1;
      throw new TypeError("network unavailable");
    },
    now: new Date("2026-07-13T00:00:00.000Z"),
  });

  assert.equal(resolutions.entries.length, 0);
  assert.deepEqual(resolutions.unresolved.map(({ reasonCode }) => reasonCode), [
    "PUBLIC_API_DATA_AVAILABLE",
    "PUBLIC_API_PROVIDER_FAILURE",
    "PUBLIC_API_FETCH_FAILED",
  ]);
  assert.equal(retryCalls, 2);
  assert.deepEqual(resolutions.unresolved[0].matches, [{ stinCd: "101" }]);
  assert.equal(resolutions.unresolved[2].attempts, 2);
});

test("bounded retry는 attempt마다 새 timeout signal을 사용한다", async () => {
  const signals = [];
  const resolutions = await collectNationwidePublicApiCoverage({
    searchPlan: plan(),
    credentials: { KRIC_SERVICE_KEY: "key" },
    fetchImpl: async (_url, init) => {
      signals.push(init.signal);
      if (signals.length === 1) throw new DOMException("timed out", "TimeoutError");
      return xmlResponse();
    },
    now: new Date("2026-07-13T00:00:00.000Z"),
  });

  assert.equal(resolutions.entries.length, 1);
  assert.equal(signals.length, 2);
  assert.notEqual(signals[0], signals[1]);
});
