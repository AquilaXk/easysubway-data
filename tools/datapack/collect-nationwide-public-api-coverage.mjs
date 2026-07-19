#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { scanXmlStructure } from "./lib/source-candidate-evidence-collector.mjs";

const PUBLIC_API_ORIGINS = new Set([
  "https://api.odcloud.kr",
  "https://apis.data.go.kr",
  "https://openapi.kric.go.kr",
  "https://openapi.seoul.go.kr",
]);
// 아래 host는 공식 catalog 존재 판정 전용이다. HTTP endpoint를 fetch allowlist에 넣지 않는다.
const KNOWN_HTTP_PROVIDER_HOSTS = new Set([
  "swopenapi.seoul.go.kr",
  "openapi.seoul.go.kr:8088",
]);
const CREDENTIAL_ENVS = new Set(["DATA_GO_KR_SERVICE_KEY", "KRIC_SERVICE_KEY", "SEOUL_OPENAPI_KEY"]);
const DATA_GO_ORGANIZATION_NAMES = new Map([
  ["korail", "한국철도공사"],
]);
const SOURCE_DOMAIN_SEARCH = Object.freeze({
  station_line_membership: {
    terms: ["역정보", "역명", "역코드", "노선정보", "역사정보"],
    fallback: "STATIC_LOCAL",
    userMessageKo: "공공기관 API에서 역·노선 정보를 제공하지 않습니다.",
  },
  route_graph_topology: {
    terms: ["역간거리", "이동거리", "소요시간", "운행시간"],
    fallback: "STATIC_LOCAL",
    userMessageKo: "공공기관 API에서 경로 거리·소요시간 정보를 제공하지 않습니다.",
  },
  accessibility_facilities: {
    terms: ["교통약자", "편의시설", "엘리베이터", "에스컬레이터", "휠체어리프트"],
    fallback: "PLANNED",
    userMessageKo: "공공기관 API에서 교통약자 시설 정보를 제공하지 않습니다.",
  },
  realtime_arrivals: {
    terms: ["실시간도착", "실시간열차", "열차위치", "도착정보", "실제일시"],
    fallback: "UNSUPPORTED_REGION",
    userMessageKo: "이 노선은 실시간 도착 정보를 아직 제공하지 않아요.",
  },
  schedule_timetable: {
    terms: ["열차시각표", "시간표", "운행일정", "도착예정", "출발예정"],
    fallback: "STATIC_LOCAL",
    userMessageKo: "공공기관 API에서 시간표 정보를 제공하지 않습니다.",
  },
  route_map_positions: {
    terms: ["노선도", "노선좌표", "역위치", "위도", "경도"],
    fallback: "STATIC_LOCAL",
    userMessageKo: "공공기관 API에서 공식 노선도 좌표를 제공하지 않습니다.",
  },
});

export function buildNationwidePublicApiSearchPlan({ targets, fixture, sourceCandidates } = {}) {
  const pack = fixture?.packs?.[0];
  if (!pack || !Array.isArray(pack.operators) || !Array.isArray(pack.lines)) {
    throw new Error("nationwide fixture operators and lines are required");
  }
  const operators = new Map(pack.operators.map((operator) => [operator.id, requiredString(operator.nameKo, "operator.nameKo")]));
  const lines = new Map(pack.lines.map((line) => [line.id, requiredString(line.nameKo, "line.nameKo")]));
  const domains = (targets?.requiredSourceDomains ?? [])
    .filter(({ releaseTier }) => releaseTier === "LAUNCH_REQUIRED")
    .map(({ id }) => id);
  if (!Array.isArray(targets?.activeLineScopes) || domains.length === 0) {
    throw new Error("nationwide targets active scopes and launch domains are required");
  }
  const knownProviderCandidatesByDomain = indexKnownProviderCandidates(sourceCandidates);
  const entries = targets.activeLineScopes.flatMap((scope) => domains.map((sourceDomain) => {
    const domain = SOURCE_DOMAIN_SEARCH[sourceDomain];
    if (!domain) throw new Error(`unsupported launch source domain: ${sourceDomain}`);
    const fixtureOperatorName = requiredString(operators.get(scope.operatorId), `operator ${scope.operatorId}`);
    const operatorName = DATA_GO_ORGANIZATION_NAMES.get(scope.operatorId) ?? fixtureOperatorName;
    const lineName = requiredString(lines.get(scope.lineId), `line ${scope.lineId}`);
    const lineTerms = lineSearchTerms(lineName);
    return {
      ...scope,
      sourceDomain,
      fallback: domain.fallback,
      userMessageKo: domain.userMessageKo,
      knownProviderCandidateIds: (knownProviderCandidatesByDomain.get(sourceDomain) ?? [])
        .filter((candidate) => candidateAppliesToScope(candidate.coverageScope, scope))
        .map(({ id }) => id),
      queries: [
        ...lineTerms.map((keyword) => publicApiSearchQuery({
          operatorName,
          keyword,
          coverageScope: "LINE_EVIDENCE",
          matchTermGroups: [domain.terms, lineTerms],
        })),
        ...domain.terms.map((keyword) => publicApiSearchQuery({
          operatorName,
          keyword,
          coverageScope: "OPERATOR_DISCOVERY",
          matchTermGroups: [domain.terms],
        })),
      ],
    };
  }));
  return {
    schemaVersion: 1,
    artifactKind: "nationwide-public-api-coverage-search-plan",
    targetVersion: requiredString(targets.targetVersion, "targets.targetVersion"),
    entries,
  };
}

function publicApiSearchQuery({ operatorName, keyword, coverageScope, matchTermGroups }) {
  return {
    providerId: "data-go-search",
    endpoint: "https://api.odcloud.kr/api/GetSearchDataList/v1/searchData",
    operation: "searchData",
    credentialEnv: "DATA_GO_KR_SERVICE_KEY",
    credentialParam: "Authorization",
    credentialPlacement: "header",
    method: "POST",
    format: "json",
    coverageScope,
    matchTermGroups,
    query: { page: 0, size: 10_000, dataType: ["API"], organizations: [operatorName], keyword },
  };
}

function lineSearchTerms(lineName) {
  const base = lineName.replace(/^(수도권|부산|대구|대전|광주)\s+/, "").replace(/\s+/g, "");
  if (base === "GTX-A") return ["GTXA"];
  const aliases = [base];
  if (!base.endsWith("선") && !base.endsWith("호선")) aliases.push(`${base}선`);
  if (base === "공항") aliases.push("공항철도");
  if (base === "의정부") aliases.push("의정부경전철");
  return [...new Set(aliases)];
}

export async function collectNationwidePublicApiCoverage({
  searchPlan,
  credentials = process.env,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  validatePlan(searchPlan);
  const entries = [];
  const unresolved = [];
  const requestCache = new Map();
  for (const target of searchPlan.entries) {
    const results = [];
    let unresolvedResult = null;
    for (const query of target.queries) {
      const result = await runQuery(query, credentials, fetchImpl, requestCache);
      if (result.reasonCode) {
        unresolvedResult = result;
        break;
      }
      results.push(result.evidence);
      if (result.evidence.matchCount > 0) {
        unresolvedResult = {
          reasonCode: query.coverageScope === "OPERATOR_DISCOVERY"
            ? "PUBLIC_API_CANDIDATE_REQUIRES_LINE_VALIDATION"
            : "PUBLIC_API_DATA_AVAILABLE",
          matchCount: result.evidence.matchCount,
          ...(result.evidence.capturedRows ? { matches: result.evidence.capturedRows } : {}),
        };
        break;
      }
    }
    if (unresolvedResult) {
      unresolved.push({
        regionId: target.regionId,
        operatorId: target.operatorId,
        lineId: target.lineId,
        sourceDomain: target.sourceDomain,
        ...unresolvedResult,
      });
      continue;
    }
    if (target.knownProviderCandidateIds?.length > 0) {
      unresolved.push({
        regionId: target.regionId,
        operatorId: target.operatorId,
        lineId: target.lineId,
        sourceDomain: target.sourceDomain,
        reasonCode: "KNOWN_PROVIDER_REQUIRES_LINE_VALIDATION",
        providerCandidateIds: target.knownProviderCandidateIds,
      });
      continue;
    }
    const checkedAt = now.toISOString();
    const nextReviewAt = new Date(now);
    nextReviewAt.setUTCDate(nextReviewAt.getUTCDate() + 90);
    entries.push({
      regionId: target.regionId,
      operatorId: target.operatorId,
      lineId: target.lineId,
      sourceDomain: target.sourceDomain,
      state: "EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE",
      reasonCode: "PUBLIC_API_NO_DATA",
      userMessageKo: target.userMessageKo,
      fallback: target.fallback,
      checkedAt,
      reviewedAt: checkedAt,
      reviewerRole: "AUTOMATED_PUBLIC_API_AUDIT",
      nextReviewAt: nextReviewAt.toISOString(),
      requiredProviderIds: [...new Set(target.queries.map(({ providerId }) => providerId))].sort(alphabeticalCompare),
      publicApiQueries: results,
      evidenceHash: sha256(JSON.stringify(results)),
    });
  }
  return {
    schemaVersion: 1,
    artifactKind: "nationwide-coverage-resolutions",
    targetVersion: searchPlan.targetVersion,
    searchPlanSha256: sha256(JSON.stringify(searchPlan)),
    generatedAt: now.toISOString(),
    entries,
    unresolved,
  };
}

function indexKnownProviderCandidates(sourceCandidates) {
  const indexed = new Map();
  for (const [index, candidate] of (sourceCandidates?.candidates ?? []).entries()) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const domain = typeof candidate.domain === "string" ? candidate.domain.trim() : "";
    const endpointValue = candidate.operation?.endpoint ?? candidate.requestUrl;
    if (!id || !domain || typeof endpointValue !== "string") continue;
    validateCoverageScope(candidate.coverageScope, `source candidates[${index}].coverageScope`);
    let endpoint;
    try {
      endpoint = new URL(endpointValue);
    } catch {
      continue;
    }
    if (!isKnownProviderApiEndpoint(endpoint) || domain === "provider_discovery") continue;
    const candidates = indexed.get(domain) ?? [];
    candidates.push({ id, coverageScope: candidate.coverageScope });
    indexed.set(domain, candidates);
  }
  for (const [domain, candidates] of indexed) {
    indexed.set(domain, [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()]
      .sort((a, b) => alphabeticalCompare(a.id, b.id)));
  }
  return indexed;
}

function isKnownProviderApiEndpoint(endpoint) {
  return PUBLIC_API_ORIGINS.has(endpoint.origin)
    || (endpoint.protocol === "http:" && KNOWN_HTTP_PROVIDER_HOSTS.has(endpoint.host));
}

function validateCoverageScope(scope, label) {
  if (scope === undefined) return;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) throw new Error(`${label} is invalid`);
  const allowedFields = new Set(["regionIds", "operatorIds", "lineIds"]);
  if (Object.keys(scope).some((field) => !allowedFields.has(field))) throw new Error(`${label} is invalid`);
  for (const field of allowedFields) {
    if (scope[field] !== undefined && (
      !Array.isArray(scope[field])
      || scope[field].length === 0
      || scope[field].some((id) => typeof id !== "string" || id.trim() === "")
      || new Set(scope[field]).size !== scope[field].length
    )) throw new Error(`${label}.${field} is invalid`);
  }
}

function candidateAppliesToScope(coverageScope, targetScope) {
  return coverageScope === undefined || [
    ["regionIds", "regionId"],
    ["operatorIds", "operatorId"],
    ["lineIds", "lineId"],
  ].every(([ids, id]) => coverageScope[ids] === undefined || coverageScope[ids].includes(targetScope[id]));
}

async function runQuery(query, credentials, fetchImpl, requestCache) {
  const credential = decodedCredential(
    requiredString(credentials[query.credentialEnv], query.credentialEnv),
    query.credentialEnv,
  );
  const url = new URL(query.endpoint);
  if (query.method !== "POST") {
    for (const [name, value] of Object.entries(query.query)) url.searchParams.set(name, String(value));
    url.searchParams.set("format", query.format);
  }
  if (query.credentialPlacement !== "header") url.searchParams.set(query.credentialParam, credential);
  const authorization = query.credentialPlacement === "header"
    ? { [query.credentialParam]: `Infuser ${credential}` }
    : {};
  const requestKey = JSON.stringify({
    endpoint: query.endpoint,
    method: query.method ?? "GET",
    format: query.format,
    credentialEnv: query.credentialEnv,
    credentialPlacement: query.credentialPlacement ?? "query",
    query: query.query,
  });
  let fetchedPromise = requestCache.get(requestKey);
  if (!fetchedPromise) {
    fetchedPromise = query.format === "json"
      ? fetchAllDataGoPages({ query, url, authorization, fetchImpl })
      : fetchPublicApiPage({
        url,
        request: {
          redirect: "error",
          headers: { accept: "application/xml,text/xml", ...authorization },
        },
        expectedContentTypes: new Set(["application/xml", "text/xml"]),
        fetchImpl,
      });
    requestCache.set(requestKey, fetchedPromise);
  }
  const fetched = await fetchedPromise;
  if (fetched.reasonCode) return fetched;
  const { raw, httpStatus, contentType } = fetched;
  const matchTermGroups = query.matchTermGroups ?? (query.matchAnyTerms ? [query.matchAnyTerms] : undefined);
  const parsed = query.format === "json"
    ? matchDataGoRows(fetched.rows, matchTermGroups)
    : parseXml(raw);
  if (parsed.reasonCode) return { ...parsed, httpStatus, contentType };
  return {
    evidence: {
      providerId: query.providerId,
      endpoint: query.endpoint,
      operation: query.operation,
      query: query.query,
      httpStatus,
      providerResultCode: "00",
      schemaStatus: "EXPECTED",
      matchCount: parsed.matchCount,
      responseSha256: sha256(raw),
      ...(fetched.pageCount ? { pageCount: fetched.pageCount } : {}),
      ...(query.matchAnyTerms ? { matchAnyTerms: query.matchAnyTerms } : {}),
      ...(query.matchTermGroups ? { matchTermGroups: query.matchTermGroups } : {}),
      ...(query.captureFields ? { captureFields: query.captureFields } : {}),
      ...(parsed.capturedRows ? { capturedRows: parsed.capturedRows } : {}),
      ...(query.captureFields ? { capturedRows: captureXmlRows(raw, query.captureFields) } : {}),
    },
  };
}

async function fetchAllDataGoPages({ query, url, authorization, fetchImpl }) {
  const firstOffset = Number(query.query.page ?? 0);
  const pageSize = Number(query.query.size ?? 10_000);
  if (firstOffset !== 0 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 10_000) {
    return { reasonCode: "PUBLIC_API_SCHEMA_MISMATCH" };
  }
  const raws = [];
  const rows = [];
  const pageDiagnostics = [];
  let totalCount = null;
  for (let pageOffset = 0; pageOffset < 100; pageOffset += 1) {
    const page = rows.length;
    const fetched = await fetchPublicApiPage({
      url,
      request: {
        method: "POST",
        redirect: "error",
        headers: { accept: "application/json", "content-type": "application/json", ...authorization },
        body: JSON.stringify({ ...query.query, page }),
      },
      expectedContentTypes: new Set(["application/json"]),
      fetchImpl,
    });
    if (fetched.reasonCode) return fetched;
    const parsed = parseDataGoSearchPage(fetched.raw);
    if (parsed.reasonCode) return { ...parsed, httpStatus: fetched.httpStatus, contentType: fetched.contentType };
    pageDiagnostics.push({
      page,
      totalCount: parsed.totalCount,
      dataCount: parsed.dataCount,
      returnedCount: parsed.rows.length,
      responseSha256: sha256(fetched.raw),
    });
    if (totalCount === null) totalCount = parsed.totalCount;
    if (parsed.totalCount !== totalCount || parsed.dataCount !== parsed.rows.length) {
      return { reasonCode: "PUBLIC_API_SEARCH_INCOMPLETE", totalCount, collectedCount: rows.length, pageDiagnostics };
    }
    raws.push(fetched.raw);
    rows.push(...parsed.rows);
    if (rows.length >= totalCount) {
      if (rows.length !== totalCount) {
        return { reasonCode: "PUBLIC_API_SEARCH_INCOMPLETE", totalCount, collectedCount: rows.length, pageDiagnostics };
      }
      return {
        raw: raws.join("\n"),
        rows,
        pageCount: raws.length,
        httpStatus: fetched.httpStatus,
        contentType: fetched.contentType,
      };
    }
    if (parsed.rows.length === 0) {
      return { reasonCode: "PUBLIC_API_SEARCH_INCOMPLETE", totalCount, collectedCount: rows.length, pageDiagnostics };
    }
  }
  return { reasonCode: "PUBLIC_API_SEARCH_INCOMPLETE", totalCount, collectedCount: rows.length, pageDiagnostics };
}

async function fetchPublicApiPage({ url, request, expectedContentTypes, fetchImpl }) {
  let response;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetchImpl(url, { ...request, signal: AbortSignal.timeout(15_000) });
      break;
    } catch {
      if (attempt === 1) return { reasonCode: "PUBLIC_API_FETCH_FAILED", attempts: 2 };
    }
  }
  if (!response.ok) return { reasonCode: "PUBLIC_API_HTTP_FAILURE", httpStatus: response.status };
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (!expectedContentTypes.has(contentType)) {
    return { reasonCode: "PUBLIC_API_SCHEMA_MISMATCH", httpStatus: response.status, contentType: contentType ?? null };
  }
  return { raw: await response.text(), httpStatus: response.status, contentType };
}

function captureXmlRows(raw, fields) {
  const items = [...raw.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].slice(0, 100);
  return items.map(([, item]) => Object.fromEntries(fields.flatMap((field) => {
    const match = new RegExp(`<${field}\\b[^>]*>([^<]{0,512})<\\/${field}>`, "i").exec(item);
    return match ? [[field, decodeXml(match[1].trim())]] : [];
  })));
}

function decodeXml(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

function decodedCredential(value, credentialEnv) {
  if (credentialEnv !== "DATA_GO_KR_SERVICE_KEY" || !/%[0-9a-f]{2}/i.test(value)) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseXml(raw) {
  const parsed = scanXmlStructure(raw);
  if (parsed.resultCode !== "00") {
    return {
      reasonCode: "PUBLIC_API_PROVIDER_FAILURE",
      providerResultCode: /^[A-Za-z0-9._-]{1,32}$/.test(parsed.resultCode ?? "") ? parsed.resultCode : null,
      matchCount: parsed.itemCount,
      xmlTags: parsed.tagSummary,
    };
  }
  const tags = new Set(parsed.tagSummary.split(","));
  const expectedEnvelope = ["ROOT", "header", "resultCode", "body"].every((tag) => tags.has(tag));
  if (!expectedEnvelope || (!tags.has("resultCnt") && !tags.has("items"))) {
    return {
      reasonCode: "PUBLIC_API_SCHEMA_MISMATCH",
      providerResultCode: parsed.resultCode,
      matchCount: parsed.itemCount,
      xmlTags: parsed.tagSummary,
    };
  }
  return { matchCount: parsed.itemCount };
}

function parseDataGoSearchPage(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { reasonCode: "PUBLIC_API_SCHEMA_MISMATCH" };
  }
  if (parsed?.statusCode !== 200) return { reasonCode: "PUBLIC_API_PROVIDER_FAILURE" };
  const result = Array.isArray(parsed.result) ? parsed.result[0] : parsed.result;
  if (!result || !Number.isInteger(result.sum) || result.sum < 0 || !Number.isInteger(result.dataCount)
    || result.dataCount < 0 || !Array.isArray(result.data)) {
    return { reasonCode: "PUBLIC_API_SCHEMA_MISMATCH", jsonShape: jsonShape(parsed) };
  }
  return { totalCount: result.sum, dataCount: result.dataCount, rows: result.data };
}

function matchDataGoRows(rows, matchTermGroups) {
  if (!matchTermGroups) return { matchCount: rows.length, capturedRows: rows.slice(0, 100).map(capturePublicMetadata) };
  const groups = matchTermGroups.map((group) => group.map(normalizeSearchText));
  const matches = rows.filter((row) => {
    const haystack = normalizeSearchText(JSON.stringify(row));
    return groups.every((group) => group.some((term) => haystack.includes(term)));
  });
  return {
    matchCount: matches.length,
    capturedRows: matches.slice(0, 100).map(capturePublicMetadata),
  };
}

function capturePublicMetadata(row) {
  const captured = {};
  for (const field of ["dataName", "dataDescription", "organization", "dataProvisionType", "dataType", "updateDate"]) {
    if (typeof row?.[field] === "string" && row[field].trim() !== "") captured[field] = row[field].slice(0, 2_000);
  }
  if (Array.isArray(row?.keywords)) {
    captured.keywords = row.keywords
      .filter((value) => typeof value === "string" && value.trim() !== "")
      .slice(0, 50)
      .map((value) => value.slice(0, 200));
  }
  if (typeof row?.detailPageUrl === "string") {
    try {
      const url = new URL(row.detailPageUrl);
      if (url.origin === "https://www.data.go.kr" && /^\/data\/\d+\/openapi\.do$/.test(url.pathname)) {
        captured.detailPageUrl = url.href;
      }
    } catch {
      // Malformed public metadata is omitted from the sanitized evidence.
    }
  }
  return captured;
}

function normalizeSearchText(value) {
  return String(value).toLocaleLowerCase("ko-KR").replace(/[^\p{L}\p{N}]+/gu, "");
}

function jsonShape(value, depth = 0) {
  if (Array.isArray(value)) return value.length === 0 ? "array(empty)" : { array: jsonShape(value[0], depth + 1) };
  if (value === null) return "null";
  if (typeof value !== "object") return typeof value;
  if (depth >= 4) return "object";
  return Object.fromEntries(Object.keys(value).sort(alphabeticalCompare).slice(0, 50)
    .map((key) => [key, jsonShape(value[key], depth + 1)]));
}

function alphabeticalCompare(left, right) {
  return left.localeCompare(right, "en");
}

function validatePlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("search plan must be an object");
  if (plan.schemaVersion !== 1) throw new Error("search plan schemaVersion must be 1");
  if (plan.artifactKind !== "nationwide-public-api-coverage-search-plan") {
    throw new Error("search plan artifactKind is invalid");
  }
  requiredString(plan.targetVersion, "search plan targetVersion");
  if (!Array.isArray(plan.entries) || plan.entries.length === 0) {
    throw new Error("search plan entries must be a non-empty array");
  }
  for (const [index, entry] of plan.entries.entries()) {
    const label = `search plan entries[${index}]`;
    for (const field of ["regionId", "operatorId", "lineId", "sourceDomain", "fallback", "userMessageKo"]) {
      requiredString(entry[field], `${label}.${field}`);
    }
    if (entry.knownProviderCandidateIds !== undefined && (
      !Array.isArray(entry.knownProviderCandidateIds)
      || entry.knownProviderCandidateIds.some((id) => typeof id !== "string" || id.trim() === "")
      || new Set(entry.knownProviderCandidateIds).size !== entry.knownProviderCandidateIds.length
    )) {
      throw new Error(`${label}.knownProviderCandidateIds is invalid`);
    }
    if (!Array.isArray(entry.queries) || entry.queries.length === 0) throw new Error(`${label}.queries is required`);
    for (const [queryIndex, query] of entry.queries.entries()) {
      validateQuery(query, `${label}.queries[${queryIndex}]`);
    }
  }
}

function validateQuery(query, label) {
  const endpoint = new URL(requiredString(query.endpoint, `${label}.endpoint`));
  if (!PUBLIC_API_ORIGINS.has(endpoint.origin)) throw new Error(`${label} public API origin is not allowed`);
  if (endpoint.username || endpoint.password || endpoint.hash
    || [...endpoint.searchParams.keys()].some(isCredentialName)) {
    throw new Error(`${label}.endpoint must not contain credentials`);
  }
  requiredString(query.providerId, `${label}.providerId`);
  requiredString(query.operation, `${label}.operation`);
  if (!CREDENTIAL_ENVS.has(query.credentialEnv)) throw new Error(`${label}.credentialEnv is not allowed`);
  requiredString(query.credentialParam, `${label}.credentialParam`);
  if (query.credentialPlacement !== undefined && !new Set(["header", "query"]).has(query.credentialPlacement)) {
    throw new Error(`${label}.credentialPlacement is invalid`);
  }
  if (query.credentialPlacement === "header" && query.credentialParam !== "Authorization") {
    throw new Error(`${label}.credentialParam must be Authorization for header authentication`);
  }
  if (query.coverageScope !== undefined
    && !new Set(["LINE_EVIDENCE", "OPERATOR_DISCOVERY"]).has(query.coverageScope)) {
    throw new Error(`${label}.coverageScope is invalid`);
  }
  if (!new Set(["json", "xml"]).has(query.format)) throw new Error(`${label}.format is invalid`);
  if (query.format === "json" && query.method !== "POST") throw new Error(`${label}.json search must use POST`);
  if (query.format === "xml" && query.method !== undefined && query.method !== "GET") {
    throw new Error(`${label}.xml query must use GET`);
  }
  if (query.captureFields !== undefined && (
    query.format !== "xml" ||
    !Array.isArray(query.captureFields) ||
    query.captureFields.length === 0 ||
    query.captureFields.some((field) => typeof field !== "string" || !/^[A-Za-z_][A-Za-z0-9_.-]{0,39}$/.test(field))
  )) {
    throw new Error(`${label}.captureFields is invalid`);
  }
  if (query.matchAnyTerms !== undefined && (
    query.format !== "json" ||
    !Array.isArray(query.matchAnyTerms) ||
    query.matchAnyTerms.length === 0 ||
    query.matchAnyTerms.length > 20 ||
    query.matchAnyTerms.some((term) => typeof term !== "string" || term.trim() === "" || term.length > 80)
  )) {
    throw new Error(`${label}.matchAnyTerms is invalid`);
  }
  if (query.matchTermGroups !== undefined && (
    query.format !== "json" ||
    !Array.isArray(query.matchTermGroups) ||
    query.matchTermGroups.length === 0 ||
    query.matchTermGroups.length > 5 ||
    query.matchTermGroups.some((group) => (
      !Array.isArray(group) || group.length === 0 || group.length > 20 ||
      group.some((term) => typeof term !== "string" || term.trim() === "" || term.length > 80)
    ))
  )) {
    throw new Error(`${label}.matchTermGroups is invalid`);
  }
  if (!query.query || typeof query.query !== "object" || Array.isArray(query.query)) {
    throw new Error(`${label}.query must be an object`);
  }
  for (const [name, value] of Object.entries(query.query)) {
    if (isCredentialName(name)) throw new Error(`${label}.query must not contain credentials`);
    requiredString(String(value), `${label}.query.${name}`);
  }
}

function isCredentialName(name) {
  return new Set(["apikey", "apitoken", "credential", "key", "secret", "servicekey", "token"])
    .has(name.replace(/[^a-z]/gi, "").toLowerCase());
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  if (argv.length === 8 && argv[0] === "--targets" && argv[2] === "--fixture"
    && argv[4] === "--source-candidates" && argv[6] === "--plan-output") {
    return { mode: "build", targets: argv[1], fixture: argv[3], sourceCandidates: argv[5], output: argv[7] };
  }
  if (argv.length === 4 && argv[0] === "--plan" && argv[2] === "--output") {
    return { mode: "collect", plan: argv[1], output: argv[3] };
  }
  throw new Error("usage: collect-nationwide-public-api-coverage.mjs --targets <targets.json> --fixture <fixture.json> --source-candidates <source-candidates.json> --plan-output <plan.json> | --plan <plan.json> --output <resolutions.json>");
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.mode === "build") {
    const targets = JSON.parse(await readFile(args.targets, "utf8"));
    const fixture = JSON.parse(await readFile(args.fixture, "utf8"));
    const sourceCandidates = JSON.parse(await readFile(args.sourceCandidates, "utf8"));
    const plan = buildNationwidePublicApiSearchPlan({ targets, fixture, sourceCandidates });
    await writeFile(args.output, `${JSON.stringify(plan, null, 2)}\n`);
    console.log(`public API coverage search plan ready: entries=${plan.entries.length}`);
    return;
  }
  const searchPlan = JSON.parse(await readFile(args.plan, "utf8"));
  const resolutions = await collectNationwidePublicApiCoverage({ searchPlan });
  await writeFile(args.output, `${JSON.stringify(resolutions, null, 2)}\n`);
  console.log(`public API coverage search complete: unsupported=${resolutions.entries.length} unresolved=${resolutions.unresolved.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
