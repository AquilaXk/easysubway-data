#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { compareStrings } from "./lib/ledger-admission-cli.mjs";

// 게시 범위(capital pilot)의 domain/field 계약 정본. --release-scope 평가는 이 targets로 in-scope gap을 판정한다.
const DEFAULT_RELEASE_SCOPE_TARGETS = "tools/datapack/capital-pilot-coverage-targets.json";
const DEFAULT_ACTIVE_PACK_ID = "capital";
const PUBLIC_API_ORIGINS = new Set([
  "https://api.odcloud.kr",
  "https://apis.data.go.kr",
  "https://openapi.kric.go.kr",
  "https://openapi.seoul.go.kr",
]);
const COVERAGE_FALLBACKS = new Set(["PLANNED", "STATIC_LOCAL", "UNSUPPORTED_REGION"]);
// #2138 증거 모델 축. domain이 "그 도메인의 정본 근거가 어떤 성격인가"를 machine-checkable하게 선언한다.
// official-source: 공식 기관이 그 값 자체를 공표한다(기본값 — 선언하지 않은 도메인은 이 성격이다).
// owner-authored-canonical: 정본이 오너 제작물이고 공식 데이터는 신원 식별·provenance를 댄다.
//   route_map_positions가 그렇다 — 도식 위 좌표를 공표하는 공식 기관이 존재하지 않는다.
// 이 선언은 판정을 느슨하게 하지 않는다: requiredFields·blockingThreshold 충족 요건은 그대로이고,
// 이 값은 requirement 레코드에 실려 "어느 건이 어느 근거 성격으로 섰는가"를 집계 가능하게 만들 뿐이다.
const DEFAULT_DOMAIN_EVIDENCE_MODEL = "official-source";
const DOMAIN_EVIDENCE_MODELS = new Set([DEFAULT_DOMAIN_EVIDENCE_MODEL, "owner-authored-canonical"]);
// #2138이 production 유입을 거부하는 범주. 소스가 스스로 선언하며, 선언한 소스가 requirement를 하나라도
// 뒷받침하면 판정을 내지 않고 그 자리에서 멈춘다(임시값이 완료로 집계되는 경로를 없앤다).
// 선언하지 않은 소스는 기존 판정을 그대로 유지한다(하위 호환).
const PLACEHOLDER_EVIDENCE_CATEGORY = "placeholder-fixture";
const SOURCE_EVIDENCE_CATEGORIES = new Set([PLACEHOLDER_EVIDENCE_CATEGORY]);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targets = JSON.parse(await readFile(requireArg(args, "targets"), "utf8"));
  const inventory = JSON.parse(await readFile(requireArg(args, "inventory"), "utf8"));
  const provenance = args.provenance ? JSON.parse(await readFile(args.provenance, "utf8")) : null;
  if (provenance && !args.manifest) {
    throw new Error("--manifest is required with --provenance");
  }
  const manifestBytes = args.manifest ? await readFile(args.manifest) : null;
  const candidateManifest = manifestBytes
    ? coverageManifestIndex(JSON.parse(manifestBytes), sha256(manifestBytes))
    : null;
  const releaseScope = args.releaseScope ? JSON.parse(await readFile(args.releaseScope, "utf8")) : null;
  // 게시 범위 domain/field 계약은 capital pilot targets가 정본이다. --release-scope가 켜지면 pilot targets를 로드해
  // scope 내 gap을 pilot field 계약으로 평가한다(전국 계약보다 좁은 pilot deferred domain·field가 반영됨).
  const releaseScopeTargets = args.releaseScope
    ? JSON.parse(await readFile(args.releaseTargets ?? DEFAULT_RELEASE_SCOPE_TARGETS, "utf8"))
    : null;
  const resolutionBytes = args.resolutions ? await readFile(args.resolutions) : null;
  if (args.resolutions && !args.resolutionPlan) {
    throw new Error("--resolution-plan is required with --resolutions");
  }
  if (args.resolutionPlan && !args.resolutions) {
    throw new Error("--resolutions is required with --resolution-plan");
  }
  const resolutionPlan = args.resolutionPlan
    ? JSON.parse(await readFile(args.resolutionPlan, "utf8"))
    : null;
  const resolutions = resolutionBytes
    ? { document: JSON.parse(resolutionBytes), sha256: sha256(resolutionBytes), searchPlan: resolutionPlan }
    : null;
  const outputPath = requireArg(args, "output");
  const report = buildCoverageGapReport(
    targets,
    inventory,
    provenance,
    candidateManifest,
    releaseScope,
    releaseScopeTargets,
    resolutions,
  );

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);

  // release-scope 평가: 전국 gap은 전량 산출·기록하되 게시 차단 판정은 게시 범위(pilot region/operator ×
  // capitalPilotTargets.requiredSourceDomains) 내 gap만 대상으로 한다. 전국 gap 은폐 금지 — summary에 양쪽 수치를 남긴다.
  if (releaseScope) {
    // scope의 region/operator id가 pilot targets와 하나도 매칭되지 않으면 in-scope requirement가 0개가 되어
    // missingRequirements === 0으로 공허 통과(게이트 무력화)한다. fail closed — 0 매칭은 scope/targets id 불일치로 본다.
    if (report.summary.releaseScope.totalRequirements === 0) {
      throw new Error(
        "release scope matched zero coverage requirements — scope/targets id 불일치 의심 " +
          `(scopeId: ${report.summary.releaseScope.scopeId}, ` +
          `regionIds: ${report.summary.releaseScope.regionIds.join(",") || "-"}, ` +
          `operatorIds: ${report.summary.releaseScope.operatorIds.join(",") || "-"})`,
      );
    }
    if (!args.allowGaps && report.summary.releaseScope.missingRequirements > 0) {
      throw new Error(
        `in-scope coverage gaps remain: ${report.summary.releaseScope.missingRequirements} missing requirements ` +
          `(nationwide gaps recorded: ${report.summary.missingRequirements})`,
      );
    }
    return;
  }

  if (!args.allowGaps && !report.summary.coverageComplete) {
    throw new Error(`nationwide coverage gaps remain: ${report.summary.missingRequirements} missing requirements`);
  }
}

function buildCoverageGapReport(
  targets,
  inventory,
  provenance = null,
  candidateManifest = null,
  releaseScope = null,
  releaseScopeTargets = null,
  resolutions = null,
) {
  validateTargets(targets);
  const targetIndex = coverageTargetIndex(targets);
  validateInventory(inventory);
  const sources = inventory.sources
    .filter((source) => source.rawSnapshotAdmission == null)
    .map((source) => normalizeSource(source, targetIndex));
  const provenanceIndex = provenance ? provenanceFieldIndex(provenance, candidateManifest) : null;

  // 임시값(placeholder-fixture)으로 선언된 소스는 어떤 requirement도 뒷받침할 수 없다(#2138).
  const placeholderSourceIds = new Set(
    sources.filter(({ evidenceCategory }) => evidenceCategory === PLACEHOLDER_EVIDENCE_CATEGORY)
      .map(({ id }) => id),
  );

  // 전국 requirement는 nationwide targets 전량으로 산출한다(은폐 금지 — 전국 gap은 그대로 기록).
  const requirements = evaluateRequirements(targets, sources, provenanceIndex);
  assertNoPlaceholderSupport(requirements, placeholderSourceIds, "nationwide");
  const transitions = applyCoverageResolutions(
    targets,
    requirements,
    resolutions?.document,
    resolutions?.searchPlan,
  );
  const summary = targets.schemaVersion === 2
    ? buildTierSummary(targets, requirements)
    : buildLegacySummary(requirements);

  const report = {
    schemaVersion: targets.schemaVersion,
    artifactKind: "nationwide-coverage-gap-report",
    targetVersion: targets.targetVersion,
    inventoryRetrievedAt: inventory.retrievedAt,
    candidate: provenanceIndex?.candidate ?? null,
    resolutions: resolutions ? {
      sha256: resolutions.sha256,
      searchPlanSha256: resolutions.document.searchPlanSha256,
    } : null,
    summary,
    requirements,
    transitions,
  };

  if (releaseScope) {
    const scopeFilter = resolveReleaseScope(releaseScope);
    // 게시 범위 gap은 pilot targets(capital-pilot-coverage-targets.json)의 domain/field 계약으로 별도 평가한다.
    // pilot 계약은 전국 계약보다 좁다(예: accessibility_facilities에서 status 필드 제외, route_graph 등 deferred domain 제외).
    const pilotTargets = releaseScopeTargets ?? targets;
    validateTargets(pilotTargets);
    const releaseScopes = releaseCoverageScopes(targets, pilotTargets, scopeFilter);
    if (targets.schemaVersion === 2 && releaseScopes.length > 0) {
      validateReleaseScopeParticipation(scopeFilter, releaseScopes);
    }
    const scopeRequirements = evaluateRequirements(pilotTargets, sources, provenanceIndex, {
      scopes: releaseScopes,
      includeLineId: true,
      strictLineScope: pilotTargets.schemaVersion === 2,
    });
    assertNoPlaceholderSupport(scopeRequirements, placeholderSourceIds, "release scope");
    for (const entry of scopeRequirements) {
      entry.inReleaseScope = true;
    }
    const blockingScopeRequirements = pilotTargets.schemaVersion === 2
      ? scopeRequirements.filter((entry) => entry.releaseTier === "LAUNCH_REQUIRED")
      : scopeRequirements;
    const inScopeCovered = blockingScopeRequirements.filter(
      (entry) => entry.status === "covered" || entry.status === "SUPPORTED",
    ).length;
    const inScopeTotal = blockingScopeRequirements.length;
    const inScopeMissing = inScopeTotal - inScopeCovered;
    // 전국 gap은 은폐 금지 — nationwide/in-scope 수치를 분리 기록한다. 게시 차단은 releaseScope.missingRequirements만 본다.
    summary.nationwide = {
      totalRequirements: summary.totalRequirements,
      coveredRequirements: summary.coveredRequirements,
      missingRequirements: summary.missingRequirements,
    };
    summary.releaseScope = {
      scopeId: scopeFilter.scopeId,
      targetVersion: pilotTargets.targetVersion,
      regionIds: [...scopeFilter.regionIds].sort(compareStrings),
      operatorIds: [...scopeFilter.operatorIds].sort(compareStrings),
      sourceDomains: [...new Set(blockingScopeRequirements.map((entry) => entry.sourceDomain))].sort(compareStrings),
      totalRequirements: inScopeTotal,
      coveredRequirements: inScopeCovered,
      missingRequirements: inScopeMissing,
      coverageRatio: inScopeTotal === 0 ? 0 : Number((inScopeCovered / inScopeTotal).toFixed(4)),
      coverageComplete: inScopeMissing === 0,
    };
    report.releaseScopeRequirements = scopeRequirements;
  }

  return report;
}

function buildLegacySummary(requirements) {
  const coveredRequirements = requirements.filter((entry) => entry.status === "covered").length;
  const totalRequirements = requirements.length;
  const missingRequirements = totalRequirements - coveredRequirements;
  return {
    totalRequirements,
    coveredRequirements,
    missingRequirements,
    coverageRatio: totalRequirements === 0 ? 0 : Number((coveredRequirements / totalRequirements).toFixed(4)),
    coverageComplete: missingRequirements === 0,
  };
}

function buildTierSummary(targets, requirements) {
  const launchRequired = summarizeTier(requirements, "LAUNCH_REQUIRED");
  const enhancement = summarizeTier(requirements, "ENHANCEMENT");
  launchRequired.completionReady = launchRequired.missingCount === 0;
  enhancement.progressRatio = enhancement.supportedRatio;
  return {
    totalRequirements: launchRequired.totalCount,
    coveredRequirements: launchRequired.supportedCount,
    missingRequirements: launchRequired.missingCount,
    coverageRatio: launchRequired.supportedRatio,
    coverageComplete: launchRequired.completionReady,
    launchRequiredCompletionRatio: launchRequired.terminalResolutionRatio,
    enhancementProgressRatio: enhancement.supportedRatio,
    activeScopeCount: targets.activeLineScopes.length,
    plannedScopeCount: targets.plannedLineScopes?.length ?? 0,
    launchRequired,
    enhancement,
    scope: {
      activeLineCount: new Set(targets.activeLineScopes.map(({ lineId }) => lineId)).size,
      activeLineOperatorScopeCount: targets.activeLineScopes.length,
    },
  };
}

function summarizeTier(requirements, releaseTier) {
  const tier = requirements.filter((entry) => entry.releaseTier === releaseTier);
  const supportedCount = tier.filter((entry) => entry.status === "SUPPORTED").length;
  const explicitlyUnsupportedCount = tier.filter(
    (entry) => entry.status === "EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE",
  ).length;
  const missingCount = tier.length - supportedCount - explicitlyUnsupportedCount;
  return {
    totalCount: tier.length,
    supportedCount,
    explicitlyUnsupportedCount,
    missingCount,
    supportedRatio: tier.length === 0 ? 0 : Number((supportedCount / tier.length).toFixed(4)),
    terminalResolutionRatio: tier.length === 0
      ? 0
      : Number(((supportedCount + explicitlyUnsupportedCount) / tier.length).toFixed(4)),
  };
}

function applyCoverageResolutions(targets, requirements, document, searchPlan) {
  if (!document) return [];
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("coverage resolutions must be an object");
  }
  if (document.schemaVersion !== 1) throw new Error("coverage resolutions schemaVersion must be 1");
  if (document.artifactKind !== "nationwide-coverage-resolutions") {
    throw new Error("coverage resolutions artifactKind must be nationwide-coverage-resolutions");
  }
  if (document.targetVersion !== targets.targetVersion) {
    throw new Error("coverage resolutions targetVersion must match coverage targets");
  }
  if (!Array.isArray(document.entries)) throw new Error("coverage resolutions entries must be an array");
  const planByKey = coverageResolutionPlanIndex(targets, document, searchPlan);

  const byKey = new Map(requirements.map((entry) => [requirementKey(entry), entry]));
  const seen = new Set();
  const transitions = [];
  for (const [index, resolution] of document.entries.entries()) {
    const label = `coverage resolutions entries[${index}]`;
    if (!resolution || typeof resolution !== "object" || Array.isArray(resolution)) {
      throw new Error(`${label} must be an object`);
    }
    const key = requirementKey({
      regionId: requiredString(resolution.regionId, `${label}.regionId`),
      operatorId: requiredString(resolution.operatorId, `${label}.operatorId`),
      lineId: requiredString(resolution.lineId, `${label}.lineId`),
      sourceDomain: requiredString(resolution.sourceDomain, `${label}.sourceDomain`),
    });
    if (seen.has(key)) throw new Error(`duplicate coverage resolution: ${key}`);
    seen.add(key);
    const requirement = byKey.get(key);
    if (!requirement) throw new Error(`unknown coverage resolution requirement: ${key}`);
    if (resolution.state !== "EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE") {
      throw new Error(`coverage resolution state is invalid: ${resolution.state ?? "missing"}`);
    }
    if (requirement.status === "SUPPORTED") {
      throw new Error(`supported requirement must not have unsupported resolution: ${key}`);
    }
    const evidence = validateUnsupportedResolution(resolution, label);
    validateResolutionSearchPlan(resolution, planByKey.get(key), label);
    if (evidence.expired || resolution.supportStartedAt) {
      requirement.resolutionReviewStatus = resolution.supportStartedAt ? "SUPPORT_STARTED" : "EXPIRED";
      continue;
    }
    requirement.status = resolution.state;
    requirement.capabilityFallback = resolution.fallback;
    requirement.reasonCode = resolution.reasonCode;
    requirement.userMessageKo = resolution.userMessageKo;
    requirement.resolutionEvidenceHash = resolution.evidenceHash;
    requirement.resolutionReviewStatus = "CURRENT";
    requirement.publicApiQueries = resolution.publicApiQueries;
    transitions.push({
      requirementKey: key,
      before: "MISSING",
      after: resolution.state,
      reasonCode: resolution.reasonCode,
      evidenceHash: resolution.evidenceHash,
      reviewedAt: resolution.reviewedAt,
    });
  }
  return transitions;
}

function coverageResolutionPlanIndex(targets, resolutions, plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error("coverage resolution search plan must be an object");
  }
  if (plan.schemaVersion !== 1) throw new Error("coverage resolution search plan schemaVersion must be 1");
  if (plan.artifactKind !== "nationwide-public-api-coverage-search-plan") {
    throw new Error("coverage resolution search plan artifactKind is invalid");
  }
  if (plan.targetVersion !== targets.targetVersion) {
    throw new Error("coverage resolution search plan targetVersion must match coverage targets");
  }
  const actualHash = sha256(JSON.stringify(plan));
  if (requiredString(resolutions.searchPlanSha256, "coverage resolutions.searchPlanSha256") !== actualHash) {
    throw new Error("coverage resolutions search plan hash mismatch");
  }
  if (!Array.isArray(plan.entries) || plan.entries.length === 0) {
    throw new Error("coverage resolution search plan entries must be a non-empty array");
  }
  const byKey = new Map();
  for (const [index, entry] of plan.entries.entries()) {
    const label = `coverage resolution search plan entries[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${label} must be an object`);
    const key = requirementKey({
      regionId: requiredString(entry.regionId, `${label}.regionId`),
      operatorId: requiredString(entry.operatorId, `${label}.operatorId`),
      lineId: requiredString(entry.lineId, `${label}.lineId`),
      sourceDomain: requiredString(entry.sourceDomain, `${label}.sourceDomain`),
    });
    if (byKey.has(key)) throw new Error(`duplicate coverage resolution search plan entry: ${key}`);
    if (!Array.isArray(entry.queries) || entry.queries.length === 0) {
      throw new Error(`${label}.queries must be a non-empty array`);
    }
    byKey.set(key, entry);
  }
  return byKey;
}

function validateResolutionSearchPlan(resolution, planEntry, label) {
  if (!planEntry) throw new Error(`${label} has no matching search plan entry`);
  if (resolution.fallback !== planEntry.fallback || resolution.userMessageKo !== planEntry.userMessageKo) {
    throw new Error(`${label} search plan resolution contract mismatch`);
  }
  const actual = resolution.publicApiQueries.map(publicApiQueryContract).map(canonicalJson).sort(compareStrings);
  const expected = planEntry.queries.map(publicApiQueryContract).map(canonicalJson).sort(compareStrings);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} search plan query mismatch`);
  }
}

function publicApiQueryContract(query) {
  if (!query || typeof query !== "object" || Array.isArray(query)) return query;
  return Object.fromEntries([
    "providerId",
    "endpoint",
    "operation",
    "query",
    "matchAnyTerms",
    "matchTermGroups",
    "captureFields",
  ].flatMap((field) => query[field] === undefined ? [] : [[field, query[field]]]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort(compareStrings).map((key) => [key, canonicalValue(value[key])]));
}

function validateUnsupportedResolution(resolution, label) {
  if (requiredString(resolution.reasonCode, `${label}.reasonCode`) !== "PUBLIC_API_NO_DATA") {
    throw new Error(`${label}.reasonCode must be PUBLIC_API_NO_DATA`);
  }
  requiredString(resolution.userMessageKo, `${label}.userMessageKo`);
  if (!COVERAGE_FALLBACKS.has(resolution.fallback)) {
    throw new Error(`${label}.fallback is invalid: ${resolution.fallback ?? "missing"}`);
  }
  requiredDate(resolution.checkedAt, `${label}.checkedAt`);
  requiredDate(resolution.reviewedAt, `${label}.reviewedAt`);
  requiredString(resolution.reviewerRole, `${label}.reviewerRole`);
  const nextReviewAt = requiredDate(resolution.nextReviewAt, `${label}.nextReviewAt`);
  if (resolution.supportStartedAt !== undefined) {
    requiredDate(resolution.supportStartedAt, `${label}.supportStartedAt`);
  }
  const requiredProviderIds = [...new Set(requiredStringArray(
    resolution.requiredProviderIds,
    `${label}.requiredProviderIds`,
  ))].sort(compareStrings);
  if (requiredProviderIds.length !== resolution.requiredProviderIds.length) {
    throw new Error(`${label}.requiredProviderIds must not contain duplicates`);
  }
  if (!Array.isArray(resolution.publicApiQueries) || resolution.publicApiQueries.length === 0) {
    throw new Error(`${label}.publicApiQueries must be a non-empty array`);
  }
  const queriedProviderIds = [...new Set(resolution.publicApiQueries.map((query, index) =>
    validatePublicApiQuery(query, `${label}.publicApiQueries[${index}]`)))].sort(compareStrings);
  if (JSON.stringify(requiredProviderIds) !== JSON.stringify(queriedProviderIds)) {
    throw new Error(`${label}.publicApiQueries must cover every requiredProviderId`);
  }
  const evidenceHash = requiredString(resolution.evidenceHash, `${label}.evidenceHash`);
  if (!/^[a-f0-9]{64}$/.test(evidenceHash)) throw new Error(`${label}.evidenceHash must be sha256 hex`);
  if (evidenceHash !== sha256(JSON.stringify(resolution.publicApiQueries))) {
    throw new Error(`${label}.evidenceHash mismatch`);
  }
  return { expired: nextReviewAt.getTime() <= Date.now() };
}

function validatePublicApiQuery(query, label) {
  if (!query || typeof query !== "object" || Array.isArray(query)) throw new Error(`${label} must be an object`);
  const providerId = requiredString(query.providerId, `${label}.providerId`);
  const endpoint = new URL(requiredString(query.endpoint, `${label}.endpoint`));
  if (!PUBLIC_API_ORIGINS.has(endpoint.origin)) throw new Error(`${label} public API origin is not allowed`);
  if (endpoint.username || endpoint.password || endpoint.hash
    || [...endpoint.searchParams.keys()].some(isCredentialName)) {
    throw new Error(`${label}.endpoint must not contain credentials`);
  }
  requiredString(query.operation, `${label}.operation`);
  if (!query.query || typeof query.query !== "object" || Array.isArray(query.query)) {
    throw new Error(`${label}.query must be an object`);
  }
  for (const [name, value] of Object.entries(query.query)) {
    if (isCredentialName(name)) throw new Error(`${label}.query must not contain credentials`);
    requiredString(String(value), `${label}.query.${name}`);
  }
  if (!Number.isInteger(query.httpStatus) || query.httpStatus < 200 || query.httpStatus >= 300) {
    throw new Error(`${label}.httpStatus must be successful`);
  }
  if (query.providerResultCode !== "00") throw new Error(`${label}.providerResultCode must be 00`);
  if (query.schemaStatus !== "EXPECTED") throw new Error(`${label}.schemaStatus must be EXPECTED`);
  if (query.matchCount !== 0) throw new Error(`${label}.matchCount must be 0`);
  if (typeof query.responseSha256 !== "string" || !/^[a-f0-9]{64}$/.test(query.responseSha256)) {
    throw new Error(`${label}.responseSha256 must be sha256 hex`);
  }
  return providerId;
}

function isCredentialName(name) {
  return new Set(["apikey", "apitoken", "credential", "key", "secret", "servicekey", "token"])
    .has(name.replace(/[^a-z]/gi, "").toLowerCase());
}

function requirementKey({ regionId, operatorId, lineId, sourceDomain }) {
  return `${regionId}:${operatorId}:${lineId}:${sourceDomain}`;
}

function requiredDate(value, label) {
  const text = requiredString(value, label);
  const date = new Date(text);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== text) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return date;
}

function evaluateRequirements(targets, sources, provenanceIndex, options = {}) {
  const requirements = [];
  const regionNames = new Map(targets.regions.map((region) => [region.id, region.displayName]));
  const scopes = options.scopes ?? (targets.schemaVersion === 2
    ? targets.activeLineScopes
    : targets.regions.flatMap((region) =>
        region.operatorIds.map((operatorId) => ({
          regionId: region.id,
          regionName: region.displayName,
          operatorId,
          lineId: "",
        })),
      ));
  const strictLineScope = options.strictLineScope ?? targets.schemaVersion === 2;
  for (const scope of scopes) {
    for (const domain of targets.requiredSourceDomains) {
        const fieldCoverage = domain.requiredFields.map((field) =>
          coveredField(
            sources,
            provenanceIndex,
            scope.regionId,
            scope.operatorId,
            scope.lineId ?? "",
            domain.id,
            field,
            { strictLineScope, requireProvenance: targets.schemaVersion === 2 },
          ),
        );
        const coveredFields = fieldCoverage.filter((entry) => entry.status === "covered").length;
        const denominator = fieldCoverage.length;
        const threshold = domain.blockingThreshold?.minimumOfficialFieldCoverageRatio ?? 1;
        const coverageRatio = denominator === 0 ? 0 : Number((coveredFields / denominator).toFixed(4));
        const sourceIds = [...new Set(fieldCoverage.flatMap((entry) => entry.sourceIds))].sort((a, b) => {
          if (a < b) return -1;
          if (a > b) return 1;
          return 0;
        });
        requirements.push({
          regionId: scope.regionId,
          regionName: scope.regionName ?? regionNames.get(scope.regionId),
          operatorId: scope.operatorId,
          ...(targets.schemaVersion === 2 || options.includeLineId ? { lineId: scope.lineId } : {}),
          ...(targets.schemaVersion === 2
            ? {
                serviceLifecycle: targets.activeLineScopeEvidence.serviceLifecycle,
                releaseTier: domain.releaseTier,
                effectiveFrom: targets.activeLineScopeEvidence.effectiveFrom,
                verifiedAt: targets.activeLineScopeEvidence.verifiedAt,
                evidenceRef: targets.activeLineScopeEvidence.evidenceRef,
              }
            : {}),
          sourceDomain: domain.id,
          // 근거 성격 선언(#2138). 판정에는 관여하지 않고 requirement마다 실려 범주별 집계의 축이 된다 —
          // 선언하지 않은 도메인은 official-source로 기록돼 기존 판정·기록이 그대로 유지된다.
          evidenceModel: domainEvidenceModel(domain),
          status: targets.schemaVersion === 2
            ? (coverageRatio >= threshold ? "SUPPORTED" : "MISSING")
            : (coverageRatio >= threshold ? "covered" : "missing"),
          denominator,
          coveredFields,
          coverageRatio,
          blockingThreshold: threshold,
          sourceIds,
          missingFields: fieldCoverage.filter((entry) => entry.status === "missing").map((entry) => entry.field),
          fieldCoverage,
        });
    }
  }
  return requirements;
}

function releaseCoverageScopes(targets, pilotTargets, scopeFilter) {
  const regionNames = new Map([
    ...targets.regions.map((region) => [region.id, region.displayName]),
    ...pilotTargets.regions.map((region) => [region.id, region.displayName]),
  ]);
  if (targets.schemaVersion === 2) {
    return targets.activeLineScopes
      .filter(
        ({ regionId, operatorId, lineId }) =>
          scopeFilter.regionIds.has(regionId) &&
          scopeFilter.operatorIds.has(operatorId) &&
          scopeFilter.lineIds.has(lineId),
      )
      .map(({ regionId, operatorId, lineId }) => ({
        regionId,
        regionName: regionNames.get(regionId),
        operatorId,
        lineId,
      }));
  }
  return pilotTargets.regions.flatMap((region) => {
    if (!scopeFilter.regionIds.has(region.id)) {
      return [];
    }
    return region.operatorIds
      .filter((operatorId) => scopeFilter.operatorIds.has(operatorId))
      .flatMap((operatorId) =>
        [...scopeFilter.lineIds].map((lineId) => ({
          regionId: region.id,
          regionName: region.displayName,
          operatorId,
          lineId,
        })),
      );
  });
}

function validateReleaseScopeParticipation(scopeFilter, releaseScopes) {
  for (const [field, values] of [
    ["regionId", scopeFilter.regionIds],
    ["operatorId", scopeFilter.operatorIds],
    ["lineId", scopeFilter.lineIds],
  ]) {
    for (const value of values) {
      if (!releaseScopes.some((scope) => scope[field] === value)) {
        throw new Error(`release scope ${field} has no matching active coverage pair: ${value}`);
      }
    }
  }
}

function resolveReleaseScope(releaseScope) {
  if (!releaseScope || typeof releaseScope !== "object" || Array.isArray(releaseScope)) {
    throw new Error("release scope must be an object");
  }
  const supportScope = releaseScope.verifiedAccessibilityScope;
  if (!supportScope || typeof supportScope !== "object" || Array.isArray(supportScope)) {
    throw new Error("release scope verifiedAccessibilityScope must be an object");
  }
  const scopeId = requiredString(supportScope.id, "release scope verifiedAccessibilityScope.id");
  const regionIds = requiredStringArray(
    supportScope.regionIds,
    "release scope verifiedAccessibilityScope.regionIds",
  );
  const operatorIds = requiredStringArray(
    supportScope.includedOperatorIds,
    "release scope verifiedAccessibilityScope.includedOperatorIds",
  );
  const lineIds = requiredStringArray(
    supportScope.includedLineIds,
    "release scope verifiedAccessibilityScope.includedLineIds",
  );
  return {
    scopeId,
    regionIds: new Set(regionIds),
    operatorIds: new Set(operatorIds),
    lineIds: new Set(lineIds),
  };
}

// domain 증거 모델 선언 검사. 값은 열거형 allowlist로 고정하고 한국어 사유를 함께 요구한다 —
// 사유가 없으면 "왜 이 도메인의 정본이 오너 제작물인가"가 계약에서 사라지고 선언만 남는다.
// 반대로 사유만 있고 모델 선언이 없으면 아무것도 하지 않는 죽은 서술이므로 그것도 거부한다.
function validateDomainEvidenceModel(domain, id) {
  if (domain.evidenceModel === undefined) {
    if (domain.evidenceModelReasonKo !== undefined) {
      throw new Error(`${id}.evidenceModelReasonKo requires evidenceModel`);
    }
    return DEFAULT_DOMAIN_EVIDENCE_MODEL;
  }
  const evidenceModel = requiredString(domain.evidenceModel, `${id}.evidenceModel`);
  if (!DOMAIN_EVIDENCE_MODELS.has(evidenceModel)) {
    throw new Error(
      `${id}.evidenceModel must be one of ${[...DOMAIN_EVIDENCE_MODELS].join(",")}: ${evidenceModel}`,
    );
  }
  requiredString(domain.evidenceModelReasonKo, `${id}.evidenceModelReasonKo`);
  return evidenceModel;
}

function domainEvidenceModel(domain) {
  return domain.evidenceModel ?? DEFAULT_DOMAIN_EVIDENCE_MODEL;
}

// placeholder-fixture로 선언된 소스가 requirement를 하나라도 뒷받침하면 판정을 내지 않는다.
// #2138은 임시값이 완료로 집계되는 것을 막는데, 그 경계를 서술이 아니라 판정 경로에서 강제한다.
function assertNoPlaceholderSupport(requirements, placeholderSourceIds, label) {
  if (placeholderSourceIds.size === 0) return;
  for (const requirement of requirements) {
    const offending = (requirement.sourceIds ?? []).filter((id) => placeholderSourceIds.has(id));
    if (offending.length > 0) {
      throw new Error(
        `${label} requirement ${requirement.regionId}:${requirement.operatorId}:`
          + `${requirement.lineId ?? ""}:${requirement.sourceDomain} is supported by `
          + `${PLACEHOLDER_EVIDENCE_CATEGORY} sources: ${offending.join(",")}`,
      );
    }
  }
}

function coverageTargetIndex(targets) {
  return {
    regionIds: new Set([
      ...targets.regions.map((region) => region.id),
      ...optionalStringArray(targets.knownRegionIds, "knownRegionIds"),
    ]),
    operatorIds: new Set([
      ...targets.regions.flatMap((region) => region.operatorIds),
      ...(targets.activeLineScopes ?? []).map((scope) => scope.operatorId),
      ...optionalStringArray(targets.knownOperatorIds, "knownOperatorIds"),
    ]),
    lineIds: new Set([
      ...(targets.activeLineScopes ?? []).map((scope) => scope.lineId),
      ...(targets.inactiveLineExclusions ?? []).map((exclusion) => exclusion.lineId),
    ]),
    sourceDomains: new Set([
      ...targets.requiredSourceDomains.map((domain) => domain.id),
      ...optionalStringArray(targets.knownSourceDomains, "knownSourceDomains"),
    ]),
  };
}

function coveredField(
  sources,
  provenanceIndex,
  regionId,
  operatorId,
  lineId,
  sourceDomain,
  field,
  { strictLineScope, requireProvenance },
) {
  const candidateSources = sources.filter(
    (source) =>
      source.regionIds.includes(regionId) &&
      source.operatorIds.includes(operatorId) &&
      (lineId === "" || source.lineIds.includes(lineId) || (!strictLineScope && source.lineIds.length === 0)) &&
      source.sourceDomains.includes(sourceDomain),
  );
  let sourceIds = [];
  if (provenanceIndex) {
    const sourceIdsByPack = [...provenanceIndex.officialFieldScopesByPack.values()].map((officialFieldScopes) =>
      candidateSources
        .filter(
          (source) =>
            officialFieldScopes.has(coverageKey(
              source.id,
              regionId,
              operatorId,
              lineId,
              sourceDomain,
              field,
            )) || (!strictLineScope && source.lineIds.length === 0 && officialFieldScopes.has(coverageKey(
              source.id,
              regionId,
              operatorId,
              "",
              sourceDomain,
              field,
            ))),
        )
        .map((source) => source.id),
    );
    if (sourceIdsByPack.length > 0 && sourceIdsByPack.every((ids) => ids.length > 0)) {
      sourceIds = [...new Set(sourceIdsByPack.flat())].sort(compareStrings);
    }
  } else if (!requireProvenance) {
    sourceIds = candidateSources.filter((source) => source.fields.includes(field)).map((source) => source.id).sort();
  }
  return {
    field,
    status: sourceIds.length > 0 ? "covered" : "missing",
    sourceIds,
  };
}

function validateTargets(targets) {
  if (!targets || typeof targets !== "object" || Array.isArray(targets)) {
    throw new Error("coverage targets must be an object");
  }
  if (![1, 2].includes(targets.schemaVersion)) {
    throw new Error("coverage targets schemaVersion must be 1 or 2");
  }
  if (targets.artifactKind !== "nationwide-datapack-coverage-targets") {
    throw new Error("coverage targets artifactKind must be nationwide-datapack-coverage-targets");
  }
  requiredString(targets.targetVersion, "targetVersion");
  if (!Array.isArray(targets.requiredSourceDomains) || targets.requiredSourceDomains.length === 0) {
    throw new Error("requiredSourceDomains must be a non-empty array");
  }
  optionalStringArray(targets.knownRegionIds, "knownRegionIds");
  optionalStringArray(targets.knownOperatorIds, "knownOperatorIds");
  optionalStringArray(targets.knownSourceDomains, "knownSourceDomains");
  const domainIds = new Set();
  for (const domain of targets.requiredSourceDomains) {
    const id = requiredString(domain.id, "requiredSourceDomains.id");
    if (domainIds.has(id)) {
      throw new Error(`duplicate source domain id: ${id}`);
    }
    domainIds.add(id);
    requiredString(domain.displayName, `${id}.displayName`);
    requiredStringArray(domain.requiredFields, `${id}.requiredFields`);
    if (targets.schemaVersion === 2 && !["LAUNCH_REQUIRED", "ENHANCEMENT"].includes(domain.releaseTier)) {
      throw new Error(`${id}.releaseTier must be LAUNCH_REQUIRED or ENHANCEMENT`);
    }
    const threshold = domain.blockingThreshold?.minimumOfficialFieldCoverageRatio ?? 1;
    if (typeof threshold !== "number" || threshold <= 0 || threshold > 1) {
      throw new Error(`${id}.blockingThreshold.minimumOfficialFieldCoverageRatio must be between 0 and 1`);
    }
    validateDomainEvidenceModel(domain, id);
  }
  if (
    targets.schemaVersion === 2 &&
    !targets.requiredSourceDomains.some(({ releaseTier }) => releaseTier === "LAUNCH_REQUIRED")
  ) {
    throw new Error("schemaVersion 2 targets must include at least one LAUNCH_REQUIRED domain");
  }
  if (!Array.isArray(targets.regions) || targets.regions.length === 0) {
    throw new Error("regions must be a non-empty array");
  }
  const regionIds = new Set();
  for (const region of targets.regions) {
    const id = requiredString(region.id, "regions.id");
    if (regionIds.has(id)) {
      throw new Error(`duplicate region id: ${id}`);
    }
    regionIds.add(id);
    requiredString(region.displayName, `${id}.displayName`);
    requiredStringArray(region.operatorIds, `${id}.operatorIds`);
  }
  if (targets.schemaVersion === 2) {
    if (!Array.isArray(targets.activeLineScopes) || targets.activeLineScopes.length === 0) {
      throw new Error("activeLineScopes must be a non-empty array");
    }
    const evidence = targets.activeLineScopeEvidence;
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
      throw new Error("activeLineScopeEvidence must be an object");
    }
    if (evidence.serviceLifecycle !== "ACTIVE") {
      throw new Error("activeLineScopeEvidence.serviceLifecycle must be ACTIVE");
    }
    requiredString(evidence.effectiveFrom, "activeLineScopeEvidence.effectiveFrom");
    requiredString(evidence.verifiedAt, "activeLineScopeEvidence.verifiedAt");
    evidenceSourceId(evidence.evidenceRef, "activeLineScopeEvidence.evidenceRef");
    if (!Array.isArray(targets.evidenceSources)) {
      throw new Error("evidenceSources must be an array");
    }
    const evidenceSourceIds = new Set();
    for (const source of targets.evidenceSources) {
      const id = requiredString(source.id, "evidenceSources.id");
      if (evidenceSourceIds.has(id)) {
        throw new Error(`duplicate evidence source id: ${id}`);
      }
      evidenceSourceIds.add(id);
      requiredString(source.publisher, `${id}.publisher`);
      requiredString(source.title, `${id}.title`);
      requiredString(source.publishedAt, `${id}.publishedAt`);
      const url = requiredString(source.url, `${id}.url`);
      if (!url.startsWith("https://")) {
        throw new Error(`${id}.url must use https`);
      }
    }
    if (!Array.isArray(targets.inactiveLineExclusions)) {
      throw new Error("inactiveLineExclusions must be an array");
    }
    const inactiveLineIds = new Set();
    for (const exclusion of targets.inactiveLineExclusions) {
      const lineId = requiredString(exclusion.lineId, "inactiveLineExclusions.lineId");
      if (inactiveLineIds.has(lineId)) {
        throw new Error(`duplicate inactive line exclusion: ${lineId}`);
      }
      inactiveLineIds.add(lineId);
      if (exclusion.status !== "OUT_OF_ACTIVE_SCOPE") {
        throw new Error(`${lineId}.status must be OUT_OF_ACTIVE_SCOPE`);
      }
      if (!["SUSPENDED", "RETIRED"].includes(exclusion.serviceLifecycle)) {
        throw new Error(`${lineId}.serviceLifecycle must be SUSPENDED or RETIRED`);
      }
      requiredString(exclusion.effectiveFrom, `${lineId}.effectiveFrom`);
      requiredString(exclusion.verifiedAt, `${lineId}.verifiedAt`);
      requiredString(exclusion.reasonKo, `${lineId}.reasonKo`);
      const sourceId = evidenceSourceId(exclusion.evidenceRef, "inactiveLineExclusions.evidenceRef");
      if (!evidenceSourceIds.has(sourceId)) {
        throw new Error(`${lineId}.evidenceRef contains undefined evidence source: ${sourceId}`);
      }
    }
    const lineScopeKeys = new Set();
    for (const scope of targets.activeLineScopes) {
      const lineId = requiredString(scope.lineId, "activeLineScopes.lineId");
      const regionId = requiredString(scope.regionId, `${lineId}.regionId`);
      const operatorId = requiredString(scope.operatorId, `${lineId}.operatorId`);
      if (!regionIds.has(regionId)) {
        throw new Error(`${lineId}.regionId contains undefined region: ${regionId}`);
      }
      const key = `${regionId}:${operatorId}:${lineId}`;
      if (lineScopeKeys.has(key)) {
        throw new Error(`duplicate active line scope: ${key}`);
      }
      if (inactiveLineIds.has(lineId)) {
        throw new Error(`inactive line appears in activeLineScopes: ${lineId}`);
      }
      lineScopeKeys.add(key);
    }
    validateRailProductScope(targets.railProductScope, lineScopeKeys);
  }
}

function validateRailProductScope(scope, activeLineScopeKeys) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw new Error("railProductScope must be an object");
  }
  if (!Array.isArray(scope.routeMapAndRouting) || scope.routeMapAndRouting.length !== 2) {
    throw new Error("railProductScope.routeMapAndRouting must contain GTX-A and ITX-청춘 only");
  }
  const routeServices = new Map();
  for (const entry of scope.routeMapAndRouting) {
    const serviceId = requiredString(entry.serviceId, "railProductScope.routeMapAndRouting.serviceId");
    if (routeServices.has(serviceId)) throw new Error(`duplicate route rail service: ${serviceId}`);
    routeServices.set(serviceId, entry);
    const lineId = requiredString(entry.lineId, `${serviceId}.lineId`);
    if (![...activeLineScopeKeys].some((key) => key.endsWith(`:${lineId}`))) {
      throw new Error(`${serviceId}.lineId must be an active line scope`);
    }
  }
  const expected = {
    GTX_A: ["line-8604048b6430", "LOCAL", "ACTIVE_CAPITAL_LINE"],
    ITX_CHEONGCHUN: ["line-54a7b980b7c3", "EXPRESS", "SERVICE_PATTERN_ON_EXISTING_LINE"],
  };
  for (const [serviceId, [lineId, servicePattern, representation]] of Object.entries(expected)) {
    const entry = routeServices.get(serviceId);
    if (!entry || entry.lineId !== lineId || entry.servicePattern !== servicePattern
      || entry.representation !== representation) {
      throw new Error(`railProductScope route contract is invalid for ${serviceId}`);
    }
  }
  const itx = routeServices.get("ITX_CHEONGCHUN");
  const itxStates = itx.coverageStates;
  const allowedStates = new Set(["SUPPORTED", "EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE", "MISSING"]);
  if (itx.operatingRoute !== "GYEONGCHUN_LINE_ONLY"
    || itx.legacyDaejeonData !== "REJECT"
    || itx.metropolitanRouteSearchCoverage !== "CANONICAL_OD_STATIONS_IN_CAPITAL_METROPOLITAN_NETWORK"
    || itx.coverageContract !== "tools/datapack/itx-cheongchun-coverage-contract.json"
    || !itxStates || ["station_line_membership", "route_graph_topology", "schedule_timetable"]
      .some((domain) => !allowedStates.has(itxStates[domain]))
    || itx.supportClaimAllowed !== Object.values(itxStates).every((state) => state === "SUPPORTED")) {
    throw new Error("ITX_CHEONGCHUN missing timetable must fail closed for route support claims");
  }
  const searchOnly = scope.trainSearchOnly;
  if (!searchOnly || searchOnly.routeMapProvided !== false || searchOnly.trackingIssue !== 2094) {
    throw new Error("railProductScope.trainSearchOnly contract is invalid");
  }
  const services = requiredStringArray(searchOnly.services, "railProductScope.trainSearchOnly.services");
  if (new Set(services).size !== services.length) {
    throw new Error("railProductScope.trainSearchOnly.services must not contain duplicates");
  }
  for (const serviceId of services) {
    if (routeServices.has(serviceId)) {
      throw new Error(`train-search-only service must not appear in route scope: ${serviceId}`);
    }
  }
}

function evidenceSourceId(value, label) {
  const evidenceRef = requiredString(value, label);
  const match = /^source:([a-z0-9][a-z0-9-]*)$/.exec(evidenceRef);
  if (!match) {
    throw new Error(`${label} must use source:<id>`);
  }
  return match[1];
}

function validateInventory(inventory) {
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) {
    throw new Error("source inventory must be an object");
  }
  if (inventory.schemaVersion !== 1) {
    throw new Error("source inventory schemaVersion must be 1");
  }
  if (!Array.isArray(inventory.sources) || inventory.sources.length === 0) {
    throw new Error("source inventory sources must be a non-empty array");
  }
  requiredString(inventory.retrievedAt, "inventory.retrievedAt");
}

function normalizeSource(source, targetIndex) {
  const id = requiredString(source.id, "source.id");
  const coverage = source.coverageScope;
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) {
    throw new Error(`${id}.coverageScope must be an object`);
  }
  const regionIds = requiredStringArray(coverage.regionIds, `${id}.coverageScope.regionIds`);
  const operatorIds = requiredStringArray(coverage.operatorIds, `${id}.coverageScope.operatorIds`);
  const sourceDomains = requiredStringArray(coverage.sourceDomains, `${id}.coverageScope.sourceDomains`);
  const lineIds = optionalStringArray(coverage.lineIds, `${id}.coverageScope.lineIds`);
  const fields = requiredStringArray(source.fieldsProvided ?? source.fields, `${id}.fieldsProvided`);
  // 소스 증거 범주 선언(#2138). 선언하지 않으면 undefined로 남아 기존 판정이 그대로 유지된다.
  if (source.evidenceCategory !== undefined) {
    const evidenceCategory = requiredString(source.evidenceCategory, `${id}.evidenceCategory`);
    if (!SOURCE_EVIDENCE_CATEGORIES.has(evidenceCategory)) {
      throw new Error(
        `${id}.evidenceCategory must be one of ${[...SOURCE_EVIDENCE_CATEGORIES].join(",")}: ${evidenceCategory}`,
      );
    }
    requiredString(source.evidenceCategoryReasonKo, `${id}.evidenceCategoryReasonKo`);
  } else if (source.evidenceCategoryReasonKo !== undefined) {
    throw new Error(`${id}.evidenceCategoryReasonKo requires evidenceCategory`);
  }
  validateKnownValues(regionIds, targetIndex.regionIds, `${id}.coverageScope.regionIds`, "region");
  validateKnownValues(operatorIds, targetIndex.operatorIds, `${id}.coverageScope.operatorIds`, "operator");
  validateKnownValues(sourceDomains, targetIndex.sourceDomains, `${id}.coverageScope.sourceDomains`, "source domain");
  if (targetIndex.lineIds.size > 0) {
    validateKnownValues(lineIds, targetIndex.lineIds, `${id}.coverageScope.lineIds`, "line");
  }
  return {
    id,
    regionIds,
    operatorIds,
    sourceDomains,
    lineIds,
    fields,
    evidenceCategory: source.evidenceCategory,
  };
}

function provenanceFieldIndex(provenance, candidateManifest) {
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) {
    throw new Error("field provenance must be an object");
  }
  if (provenance.schemaVersion !== 1) {
    throw new Error("field provenance schemaVersion must be 1");
  }
  if (provenance.artifactKind !== "datapack-field-provenance") {
    throw new Error("field provenance artifactKind must be datapack-field-provenance");
  }
  const manifestSha256 = requiredString(provenance.manifestSha256, "field provenance manifestSha256");
  if (manifestSha256 !== candidateManifest.sha256) {
    throw new Error("field provenance manifestSha256 does not match --manifest");
  }
  if (!Array.isArray(provenance.packs) || provenance.packs.length === 0) {
    throw new Error("field provenance packs must be a non-empty array");
  }

  const officialFieldScopesByPack = new Map(
    [...candidateManifest.requiredPacks.keys()].map((identity) => [identity, new Set()]),
  );
  const packs = [];
  const packIdentities = new Set();
  for (const pack of provenance.packs) {
    const id = requiredString(pack.id, "field provenance pack.id");
    const version = requiredString(pack.version, "field provenance pack.version");
    const sqliteSha256 = requiredString(pack.sqliteSha256, "field provenance pack.sqliteSha256");
    const artifactKind = requiredString(pack.artifactKind, "field provenance pack.artifactKind");
    const identity = `${id}@${version}`;
    if (packIdentities.has(identity)) {
      throw new Error(`duplicate field provenance pack: ${identity}`);
    }
    packIdentities.add(identity);
    const manifestPack = candidateManifest.requiredPacks.get(identity);
    if (!manifestPack) {
      continue;
    }
    if (artifactKind !== manifestPack.artifactKind) {
      throw new Error(`${identity} field provenance artifactKind does not match --manifest`);
    }
    if (artifactKind !== "production") {
      throw new Error(`${identity} active field provenance pack must be production`);
    }
    if (sqliteSha256 !== manifestPack.sqliteSha256) {
      throw new Error(`${identity} field provenance sqliteSha256 does not match --manifest`);
    }
    const officialFieldScopes = officialFieldScopesByPack.get(identity);
    packs.push({ id, version, artifactKind, sqliteSha256 });
    if (!Array.isArray(pack.records)) {
      throw new Error(`${id}@${version} field provenance records must be an array`);
    }
    for (const record of pack.records) {
      const normalizedRecord = validateProvenanceRecord(record, `${id}@${version}`);
      if (!["OFFICIAL", "FIELD_VERIFIED"].includes(record.derivationKind)) {
        continue;
      }
      for (const regionId of normalizedRecord.coverageScope.regionIds) {
        for (const operatorId of normalizedRecord.coverageScope.operatorIds) {
          for (const lineId of normalizedRecord.coverageScope.lineIds) {
            for (const sourceDomain of normalizedRecord.coverageScope.sourceDomains) {
              officialFieldScopes.add(
                coverageKey(record.sourceId, regionId, operatorId, lineId, sourceDomain, record.field),
              );
              officialFieldScopes.add(
                coverageKey(record.sourceId, regionId, operatorId, "", sourceDomain, record.field),
              );
            }
          }
        }
      }
    }
  }

  return {
    officialFieldScopesByPack,
    candidate: {
      manifestSha256,
      packs,
    },
  };
}

function coverageManifestIndex(manifest, manifestSha256) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("coverage manifest must be an object");
  }
  if (!Array.isArray(manifest.packs) || manifest.packs.length === 0) {
    throw new Error("coverage manifest packs must be a non-empty array");
  }
  const packsByIdentity = new Map();
  for (const pack of manifest.packs) {
    const identity = packIdentity(pack, "coverage manifest pack");
    if (packsByIdentity.has(identity)) {
      throw new Error(`duplicate coverage manifest pack: ${identity}`);
    }
    requiredString(pack.artifactKind, `${identity}.artifactKind`);
    requiredString(pack.sqliteSha256, `${identity}.sqliteSha256`);
    packsByIdentity.set(identity, pack);
  }

  const activePackIdentity = manifest.activePack === undefined
    ? null
    : packIdentity(manifest.activePack, "coverage manifest activePack");
  if (activePackIdentity && !packsByIdentity.has(activePackIdentity)) {
    throw new Error(`coverage manifest active pack is missing: ${activePackIdentity}`);
  }
  const overridePackIdentity = manifest.emergencyOverride === undefined
    ? null
    : packIdentity(manifest.emergencyOverride, "coverage manifest emergencyOverride");
  if (overridePackIdentity && !packsByIdentity.has(overridePackIdentity)) {
    throw new Error(`coverage manifest emergency override pack is missing: ${overridePackIdentity}`);
  }
  const fallbackRootIdentity = activePackIdentity
    ?? packIdentity(defaultActivePack(manifest.packs), "coverage manifest default active pack");
  // 앱은 emergency override를 먼저 열지만 파일 누락·손상 시 current active pack으로 fallback한다.
  // 두 팩의 provenance를 합산하지 않고 각각 같은 coverage 계약을 만족해야 안전한 런타임 선택이 된다.
  const requiredRootIdentities = [...new Set([
    ...(overridePackIdentity ? [overridePackIdentity] : []),
    fallbackRootIdentity,
  ])];
  const requiredPacks = new Map(
    requiredRootIdentities.map((identity) => [identity, packsByIdentity.get(identity)]),
  );
  return { sha256: manifestSha256, requiredPacks };
}

function defaultActivePack(packs) {
  const candidates = packs.filter((pack) => pack.id === DEFAULT_ACTIVE_PACK_ID);
  if (candidates.length === 0) {
    throw new Error(`coverage manifest default active pack is missing: ${DEFAULT_ACTIVE_PACK_ID}`);
  }
  return candidates.reduce((selected, pack) =>
    versionNumber(pack.version) > versionNumber(selected.version) ? pack : selected,
  );
}

function versionNumber(version) {
  return /^\d+$/.test(version) ? BigInt(version) : 0n;
}

function packIdentity(pack, label) {
  if (!pack || typeof pack !== "object" || Array.isArray(pack)) {
    throw new Error(`${label} must be an object`);
  }
  return `${requiredString(pack.id, `${label}.id`)}@${requiredString(pack.version, `${label}.version`)}`;
}

function validateProvenanceRecord(record, label) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`${label} field provenance record must be an object`);
  }
  requiredString(record.entityType, `${label}.entityType`);
  requiredString(record.entityId, `${label}.entityId`);
  requiredString(record.field, `${label}.field`);
  requiredString(record.sourceId, `${label}.sourceId`);
  requiredString(record.verifiedAt, `${label}.verifiedAt`);
  const derivationKind = requiredString(record.derivationKind, `${label}.derivationKind`);
  if (!["OFFICIAL", "FIELD_VERIFIED", "MANUAL_OVERRIDE", "GENERATED", "FIXTURE"].includes(derivationKind)) {
    throw new Error(`${label}.derivationKind is invalid: ${derivationKind}`);
  }
  if (!["OFFICIAL", "FIELD_VERIFIED"].includes(derivationKind)) {
    return { derivationKind };
  }
  if (!record.coverageScope || typeof record.coverageScope !== "object" || Array.isArray(record.coverageScope)) {
    throw new Error(`${label}.coverageScope must be an object for official field provenance`);
  }
  const operatorIds = requiredStringArray(record.coverageScope.operatorIds, `${label}.coverageScope.operatorIds`);
  const lineIds = record.coverageScope.lineIds === undefined
    ? [""]
    : requiredStringArray(record.coverageScope.lineIds, `${label}.coverageScope.lineIds`);
  if (record.coverageScope.lineIds !== undefined && (operatorIds.length !== 1 || lineIds.length !== 1)) {
    throw new Error(`${label} line-scoped field provenance must identify exactly one operator-line pair`);
  }
  return {
    derivationKind,
    coverageScope: {
      regionIds: requiredStringArray(record.coverageScope.regionIds, `${label}.coverageScope.regionIds`),
      operatorIds,
      lineIds,
      sourceDomains: requiredStringArray(record.coverageScope.sourceDomains, `${label}.coverageScope.sourceDomains`),
    },
  };
}

function coverageKey(sourceId, regionId, operatorId, lineId, sourceDomain, field) {
  return `${sourceId}:${regionId}:${operatorId}:${lineId}:${sourceDomain}:${field}`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateKnownValues(values, knownValues, label, valueLabel) {
  for (const value of values) {
    if (!knownValues.has(value)) {
      throw new Error(`${label} contains undefined ${valueLabel}: ${value}`);
    }
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value;
}

function requiredStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  return value;
}

function optionalStringArray(value, label) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new Error(`${label} must be a string array`);
  }
  return value;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-gaps") {
      args.allowGaps = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for --${arg.slice(2)}`);
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

function requireArg(args, key) {
  const value = args[key];
  if (!value) {
    throw new Error(`--${key} is required`);
  }
  return value;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
