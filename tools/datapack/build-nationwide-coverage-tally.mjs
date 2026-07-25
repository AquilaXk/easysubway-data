#!/usr/bin/env node
// #2507 전국 270 coverage 집계 정본화 — tally 도구(tracked ledger 생성기).
//
// #2138 전국 requirement 진행 집계를 이슈 코멘트 수기 집계에서 재현 가능한 커밋 산출물로 옮긴다.
// requirement 분모는 targets의 activeLineScopes × requiredSourceDomains이며, LAUNCH_REQUIRED tier가
// 270건(45 scope × 6 domain), ENHANCEMENT tier가 45건(45 scope × 1 domain)이다.
//
// 입력:
//   --targets     tools/datapack/nationwide-coverage-targets.json (분모·domain 계약 정본)
//   --inventory   tools/datapack/source-inventory.json (coverageScope admission 정본)
//   --resolutions EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE 정본. 생략하면 DEFAULT_RESOLUTIONS_PATH.
//                 (경로를 인자로 받는 이유: resolutions 문서는 재생성 시 파일이 교체된다.)
//   --output      ledger 출력 경로
//   --expected-launch-required-total  분모 drift fail-closed용 기대값(선택). 계산된 LAUNCH_REQUIRED
//                 분모와 다르면 실패한다.
//
// 상태 축(이 ledger가 산출하는 축):
//   INVENTORY_ADMITTED                  source-inventory coverageScope의 (operatorIds, lineIds,
//                                       sourceDomains) 엄격 매칭으로 domain requiredFields를
//                                       blockingThreshold 이상 충족.
//   EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE resolutions 문서의 정본 판정.
//   MISSING                              그 외. dual-operator 미매칭 여부를 하위 구분으로 남긴다.
//
// 범위 밖(별도 축):
//   provenance 기반 게이트 SUPPORTED 판정(report-coverage-gaps.mjs --manifest/--provenance)은 이
//   도구의 축이 아니다. INVENTORY_ADMITTED는 admission 근사치이며 게이트 통과를 뜻하지 않는다.
//   resolutions entry의 만료(nextReviewAt) 재검토 판정도 wall-clock에 의존하므로 게이트 몫이다.
//
// 판정 의미론은 report-coverage-gaps.mjs의 evaluateRequirements/coveredField와 어긋나면 안 된다.
// 특히 빈 lineIds는 와일드카드가 아니다(strictLineScope=true와 동일). 이 도구는 게이트의
// requireProvenance=false 경로(= inventory fieldsProvided 매칭)에 대응한다.
//
// 결정성: 같은 입력 → 같은 출력 바이트. wall-clock(Date.now/new Date)을 쓰지 않고 시각 값은
// 입력 파일에서만 유도한다. 정렬은 로케일 무관 코드포인트 비교로 고정한다.
//
// 사용: node tools/datapack/build-nationwide-coverage-tally.mjs \
//   --targets tools/datapack/nationwide-coverage-targets.json \
//   --inventory tools/datapack/source-inventory.json \
//   --resolutions tools/datapack/release/nationwide-public-api-coverage-resolutions-20260725.json \
//   --expected-launch-required-total 270 \
//   --output tools/datapack/reports/nationwide-coverage-tally.json
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { codepointCompare } from "../lib/codepoint-compare.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";
import { parseArgs, requireArg, sortJson } from "./lib/ledger-admission-cli.mjs";

export const DEFAULT_RESOLUTIONS_PATH =
  "tools/datapack/release/nationwide-public-api-coverage-resolutions-20260725.json";
// 재생성 명령에 기록하는 tracked ledger 경로. --output이 임시 경로여도 산출 바이트가 달라지지
// 않도록 명령 문자열은 이 상수를 쓴다(재현성 검증이 임시 출력으로 가능해야 한다).
export const LEDGER_PATH = "tools/datapack/reports/nationwide-coverage-tally.json";
const TOOL_PATH = "tools/datapack/build-nationwide-coverage-tally.mjs";
const ALLOWED_FLAGS = new Set([
  "targets",
  "inventory",
  "resolutions",
  "output",
  "expected-launch-required-total",
]);
const TALLY_STATUSES = ["INVENTORY_ADMITTED", "EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE", "MISSING"];
const MISSING_KINDS = ["DUAL_OPERATOR_UNMATCHED", "NO_ADMITTED_SOURCE"];
const RELEASE_TIERS = ["LAUNCH_REQUIRED", "ENHANCEMENT"];
// 게이트 validateUnsupportedResolution과 같은 allowlist.
const RESOLUTION_REASON_CODE = "PUBLIC_API_NO_DATA";
const COVERAGE_FALLBACKS = ["PLANNED", "STATIC_LOCAL", "UNSUPPORTED_REGION"];
// 게이트의 `new Date(text).toISOString() === text`와 같은 canonical UTC instant. wall-clock을 읽지 않고
// 형식만 강제해 nextReviewAt의 코드포인트 정렬이 시간순 정렬과 일치하도록 보장한다.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function buildNationwideCoverageTally({
  targets,
  inventory,
  resolutions,
  inputs,
  expectedLaunchRequiredTotal = null,
}) {
  validateTargets(targets);
  validateInventory(inventory);
  const targetIndex = coverageTargetIndex(targets);
  const sources = inventory.sources.map((source) => normalizeSource(source, targetIndex));
  const scopes = [...targets.activeLineScopes]
    .map(({ regionId, operatorId, lineId }) => ({ regionId, operatorId, lineId }))
    .sort(compareScopes);
  const domains = [...targets.requiredSourceDomains].sort((left, right) =>
    codepointCompare(left.id, right.id));
  const resolutionIndex = indexResolutions(targets, resolutions, scopes, domains);

  const requirements = scopes.flatMap((scope) =>
    domains.map((domain) => evaluateRequirement(scope, domain, sources, resolutionIndex)));
  const tiers = Object.fromEntries(RELEASE_TIERS.map((releaseTier) => [
    releaseTier,
    summarizeTier(requirements, releaseTier, domains, scopes),
  ]));

  const launchRequiredDomainCount = domains.filter(
    ({ releaseTier }) => releaseTier === "LAUNCH_REQUIRED").length;
  const enhancementDomainCount = domains.filter(
    ({ releaseTier }) => releaseTier === "ENHANCEMENT").length;
  const launchRequiredTotal = tiers.LAUNCH_REQUIRED.totalCount;
  // 분모 drift fail closed: scope × domain 곱과 어긋나면 집계를 신뢰할 수 없다.
  if (launchRequiredTotal !== scopes.length * launchRequiredDomainCount) {
    throw new Error(
      `launch-required denominator is inconsistent: ${launchRequiredTotal} != ` +
        `${scopes.length} scopes × ${launchRequiredDomainCount} domains`,
    );
  }
  if (tiers.ENHANCEMENT.totalCount !== scopes.length * enhancementDomainCount) {
    throw new Error(
      `enhancement denominator is inconsistent: ${tiers.ENHANCEMENT.totalCount} != ` +
        `${scopes.length} scopes × ${enhancementDomainCount} domains`,
    );
  }
  if (expectedLaunchRequiredTotal !== null && launchRequiredTotal !== expectedLaunchRequiredTotal) {
    throw new Error(
      `launch-required denominator drift: expected ${expectedLaunchRequiredTotal}, ` +
        `computed ${launchRequiredTotal}`,
    );
  }

  return {
    schemaVersion: 1,
    artifactKind: "nationwide-coverage-tally-ledger",
    issue: 2507,
    parentIssue: 2138,
    targetVersion: targets.targetVersion,
    regeneration: {
      command: regenerationCommand(inputs, expectedLaunchRequiredTotal),
      ledgerPath: LEDGER_PATH,
      pairedUpdateKo:
        "targets·inventory·resolutions를 바꾸는 PR은 이 명령으로 ledger를 함께 재생성하고, "
        + "tools/datapack/build-nationwide-coverage-tally.test.mjs의 집계 기대 상수(admitted/EU/missing)도 "
        + "같은 커밋에서 갱신해야 한다. 재생성 누락은 datapack 도구 테스트에서 fail closed 된다. "
        + "inventory admission만 늘리는 PR은 search plan·resolutions를 재발행하지 않아도 된다 — 계획은 "
        + "미admission requirement를 전부 덮기만 하면 되고(포함 관계, "
        + "tools/datapack/nationwide-public-api-coverage-evidence.test.mjs가 검증), 계획에 남은 admitted "
        + "entry는 다음 정기 재생성에서 정리한다. 계획을 재생성하면 resolutions의 searchPlanSha256이 "
        + "어긋나므로 live 재크롤로 두 아티팩트를 같은 커밋에서 함께 재발행해야 한다"
        + "(tools/datapack/collect-nationwide-public-api-coverage.mjs 헤더의 재발행 절차 참조).",
    },
    statusAxis: {
      values: [...TALLY_STATUSES],
      missingKinds: [...MISSING_KINDS],
      inventoryAdmittedRuleKo:
        "source-inventory coverageScope의 (operatorIds, lineIds, sourceDomains) 엄격 매칭으로 domain의 "
        + "requiredFields를 blockingThreshold 이상 충족한 requirement. 빈 lineIds는 와일드카드가 아니다.",
      explicitlyUnsupportedRuleKo:
        "resolutions 문서의 EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE entry가 정본이다. supportStartedAt이 있는 "
        + "entry는 게이트와 같이 terminal에서 제외하고 MISSING + resolutionReviewStatus=SUPPORT_STARTED로 남긴다. "
        + "publicApiQueries 재계산·search plan 대조와 nextReviewAt 만료 재검토는 report-coverage-gaps.mjs 게이트 몫이다.",
      resolutionExpiryDivergenceKo:
        "이 ledger는 wall-clock을 읽지 않으므로 nextReviewAt이 지난 entry도 terminal로 계상한다. "
        + "각 tier의 earliestResolutionNextReviewAt이 그 유효 지평이며, 이 시각을 넘기면 입력이 그대로여도 "
        + "게이트는 해당 entry를 MISSING(EXPIRED)로 판정해 수치가 갈린다 — resolutions 재검토로 해소한다.",
      dualOperatorRuleKo:
        "MISSING 중 operator 조건만 풀면 admitted가 되는 requirement는 DUAL_OPERATOR_UNMATCHED로 구분한다. "
        + "같은 노선을 커버하는 소스가 있으나 해당 운영기관이 coverageScope에 없는 경우다.",
      outOfScopeAxisKo:
        "provenance 기반 게이트 SUPPORTED 판정(report-coverage-gaps.mjs --manifest/--provenance)은 별도 축이며 "
        + "이 ledger가 대체하지 않는다. INVENTORY_ADMITTED는 admission 근사치이고 게이트 통과를 의미하지 않는다.",
    },
    inputs: {
      targets: { ...inputRecord(inputs, "targets"), targetVersion: targets.targetVersion },
      inventory: { ...inputRecord(inputs, "inventory"), retrievedAt: inventory.retrievedAt },
      resolutions: {
        ...inputRecord(inputs, "resolutions"),
        generatedAt: resolutions.generatedAt ?? null,
        entryCount: resolutions.entries.length,
      },
    },
    denominator: {
      activeLineScopeCount: scopes.length,
      activeLineCount: new Set(scopes.map(({ lineId }) => lineId)).size,
      launchRequiredDomainCount,
      launchRequiredTotal,
      enhancementDomainCount,
      enhancementTotal: tiers.ENHANCEMENT.totalCount,
      expectedLaunchRequiredTotal,
    },
    launchRequired: tiers.LAUNCH_REQUIRED,
    enhancement: tiers.ENHANCEMENT,
  };
}

// requirement 하나의 상태를 판정한다. 우선순위는 INVENTORY_ADMITTED > EXPLICITLY_UNSUPPORTED > MISSING이며,
// admitted requirement에 unsupported resolution이 붙으면 판정 충돌이므로 fail closed한다.
// resolution에 supportStartedAt이 있으면 게이트(report-coverage-gaps.mjs applyCoverageResolutions)와 같이
// EU 전이를 취소하고 MISSING으로 남기되 resolutionReviewStatus=SUPPORT_STARTED로 표시한다.
function evaluateRequirement(scope, domain, sources, resolutionIndex) {
  const threshold = domain.blockingThreshold?.minimumOfficialFieldCoverageRatio ?? 1;
  const fieldRows = domain.requiredFields.map((field) => ({
    field,
    sourceIds: admittedSourceIds(sources, scope, domain.id, field, { ignoreOperator: false }),
  }));
  const admittedFieldCount = fieldRows.filter(({ sourceIds }) => sourceIds.length > 0).length;
  const unadmittedFields = fieldRows
    .filter(({ sourceIds }) => sourceIds.length === 0)
    .map(({ field }) => field);
  const key = requirementKey(scope, domain.id);
  const base = {
    regionId: scope.regionId,
    operatorId: scope.operatorId,
    lineId: scope.lineId,
    sourceDomain: domain.id,
    releaseTier: domain.releaseTier,
    requiredFieldCount: fieldRows.length,
    admittedFieldCount,
    admissionRatio: ratio(admittedFieldCount, fieldRows.length),
    blockingThreshold: threshold,
    admittedSourceIds: uniqueSorted(fieldRows.flatMap(({ sourceIds }) => sourceIds)),
    unadmittedFields,
  };
  const resolution = resolutionIndex.get(key) ?? null;
  if (base.admissionRatio >= threshold) {
    // 게이트는 provenance 기반 SUPPORTED와의 충돌만 throw하지만, 이 도구는 더 넓은 INVENTORY_ADMITTED
    // 기준으로 throw한다(의도적으로 게이트보다 엄격). admission-only 소스가 unsupported resolution이 붙은
    // requirement를 덮으면 ledger 재생성이 hard fail하며, resolutions 문서를 정리해야 풀린다 — 두 정본이
    // 서로 반대 판정을 주장하는 상태로 집계가 계속되는 것을 막기 위한 fail closed다.
    if (resolution) {
      throw new Error(`inventory-admitted requirement must not have an unsupported resolution: ${key}`);
    }
    return {
      ...base,
      status: "INVENTORY_ADMITTED",
      missingKind: null,
      dualOperator: null,
      resolution: null,
      resolutionReviewStatus: null,
    };
  }
  if (resolution && !resolution.supportStartedAt) {
    // EU는 terminal 상태라 dual-operator 진단을 계산하지 않는다(가시화 대상은 미해결 MISSING이다).
    return {
      ...base,
      status: "EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE",
      missingKind: null,
      dualOperator: null,
      resolution,
      resolutionReviewStatus: "CURRENT",
    };
  }
  const resolutionReviewStatus = resolution ? "SUPPORT_STARTED" : null;

  // dual-operator 미매칭: operator 조건만 풀면 admitted가 되는지 확인한다.
  const relaxedRows = domain.requiredFields.map((field) => ({
    field,
    sourceIds: admittedSourceIds(sources, scope, domain.id, field, { ignoreOperator: true }),
  }));
  const relaxedRatio = ratio(
    relaxedRows.filter(({ sourceIds }) => sourceIds.length > 0).length,
    relaxedRows.length,
  );
  if (relaxedRatio < threshold) {
    return {
      ...base,
      status: "MISSING",
      missingKind: "NO_ADMITTED_SOURCE",
      dualOperator: null,
      resolution,
      resolutionReviewStatus,
    };
  }
  const unadmitted = new Set(unadmittedFields);
  const coveringSourceIds = uniqueSorted(
    relaxedRows.filter(({ field }) => unadmitted.has(field)).flatMap(({ sourceIds }) => sourceIds),
  );
  const coveringSources = new Set(coveringSourceIds);
  const coveringOperatorIds = uniqueSorted(
    sources
      .filter(({ id }) => coveringSources.has(id))
      .flatMap(({ operatorIds }) => operatorIds)
      .filter((operatorId) => operatorId !== scope.operatorId),
  );
  return {
    ...base,
    status: "MISSING",
    missingKind: "DUAL_OPERATOR_UNMATCHED",
    dualOperator: { coveringOperatorIds, coveringSourceIds },
    resolution,
    resolutionReviewStatus,
  };
}

// report-coverage-gaps.mjs coveredField(strictLineScope=true, requireProvenance=false)와 같은 매칭 규칙.
// 빈 lineIds를 와일드카드로 취급하지 않는다.
function admittedSourceIds(sources, scope, sourceDomain, field, { ignoreOperator }) {
  return sources
    .filter((source) =>
      source.regionIds.includes(scope.regionId)
      && (ignoreOperator || source.operatorIds.includes(scope.operatorId))
      && source.lineIds.includes(scope.lineId)
      && source.sourceDomains.includes(sourceDomain)
      && source.fields.includes(field))
    .map(({ id }) => id);
}

function summarizeTier(requirements, releaseTier, domains, scopes) {
  const tierRequirements = requirements.filter((entry) => entry.releaseTier === releaseTier);
  const tierDomains = domains.filter((domain) => domain.releaseTier === releaseTier);
  const regionIds = uniqueSorted(scopes.map(({ regionId }) => regionId));
  return {
    ...tierCounts(tierRequirements),
    byDomain: tierDomains.map((domain) => ({
      sourceDomain: domain.id,
      ...tierCounts(tierRequirements.filter((entry) => entry.sourceDomain === domain.id)),
    })),
    byRegion: regionIds.map((regionId) => ({
      regionId,
      ...tierCounts(tierRequirements.filter((entry) => entry.regionId === regionId)),
    })),
    requirements: tierRequirements,
  };
}

function tierCounts(entries) {
  const countStatus = (status) => entries.filter((entry) => entry.status === status).length;
  const inventoryAdmittedCount = countStatus("INVENTORY_ADMITTED");
  const explicitlyUnsupportedWithEvidenceCount = countStatus("EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE");
  const terminalCount = inventoryAdmittedCount + explicitlyUnsupportedWithEvidenceCount;
  return {
    totalCount: entries.length,
    inventoryAdmittedCount,
    explicitlyUnsupportedWithEvidenceCount,
    missingCount: countStatus("MISSING"),
    missingByKind: Object.fromEntries(MISSING_KINDS.map((kind) => [
      kind,
      entries.filter((entry) => entry.missingKind === kind).length,
    ])),
    terminalCount,
    terminalRatio: ratio(terminalCount, entries.length),
    inventoryAdmittedRatio: ratio(inventoryAdmittedCount, entries.length),
    // 게이트가 EU 전이를 취소한 supportStartedAt entry 수 — MISSING에 포함되며 terminal이 아니다.
    supportStartedResolutionCount: entries.filter(
      (entry) => entry.resolutionReviewStatus === "SUPPORT_STARTED").length,
    // EU terminal 계상의 유효 지평. wall-clock을 읽지 않으므로 만료를 판정하지 않고 입력 값만 노출한다.
    // 이 시각이 지나면 게이트는 같은 입력에서도 해당 entry를 MISSING(EXPIRED)로 판정해 수치가 갈린다.
    earliestResolutionNextReviewAt: earliestNextReviewAt(entries),
  };
}

function earliestNextReviewAt(entries) {
  const horizons = entries
    .filter((entry) => entry.status === "EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE")
    .map((entry) => entry.resolution.nextReviewAt)
    .sort(codepointCompare);
  return horizons.length === 0 ? null : horizons[0];
}

// resolutions는 EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE의 정본이다. 이 도구는 requirement 매핑 무결성과
// 게이트 validateUnsupportedResolution의 계약 축(state·reasonCode·fallback allowlist, evidenceHash 형식,
// ISO instant 형식)을 fail closed로 확인한다. publicApiQueries 재계산·search plan 대조·wall-clock 만료
// 판정은 report-coverage-gaps.mjs 게이트에 남긴다. 게이트가 PR CI가 아니라 datapack-release workflow에서만
// 돌기 때문에, 무효 entry가 이 ledger의 terminal 수치를 부풀리는 경로는 여기서 막는다.
function indexResolutions(targets, resolutions, scopes, domains) {
  if (!resolutions || typeof resolutions !== "object" || Array.isArray(resolutions)) {
    throw new Error("coverage resolutions must be an object");
  }
  if (resolutions.schemaVersion !== 1) throw new Error("coverage resolutions schemaVersion must be 1");
  if (resolutions.artifactKind !== "nationwide-coverage-resolutions") {
    throw new Error("coverage resolutions artifactKind must be nationwide-coverage-resolutions");
  }
  if (resolutions.targetVersion !== targets.targetVersion) {
    throw new Error("coverage resolutions targetVersion must match coverage targets");
  }
  if (!Array.isArray(resolutions.entries)) {
    throw new Error("coverage resolutions entries must be an array");
  }
  const requirementKeys = new Set(
    scopes.flatMap((scope) => domains.map((domain) => requirementKey(scope, domain.id))),
  );
  const byKey = new Map();
  for (const [index, entry] of resolutions.entries.entries()) {
    const label = `coverage resolutions entries[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${label} must be an object`);
    }
    if (entry.state !== "EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE") {
      throw new Error(`${label}.state is invalid: ${entry.state ?? "missing"}`);
    }
    const key = requirementKey(
      {
        regionId: requiredString(entry.regionId, `${label}.regionId`),
        operatorId: requiredString(entry.operatorId, `${label}.operatorId`),
        lineId: requiredString(entry.lineId, `${label}.lineId`),
      },
      requiredString(entry.sourceDomain, `${label}.sourceDomain`),
    );
    if (byKey.has(key)) throw new Error(`duplicate coverage resolution: ${key}`);
    if (!requirementKeys.has(key)) throw new Error(`unknown coverage resolution requirement: ${key}`);
    if (entry.reasonCode !== RESOLUTION_REASON_CODE) {
      throw new Error(`${label}.reasonCode must be ${RESOLUTION_REASON_CODE}: ${entry.reasonCode ?? "missing"}`);
    }
    if (!COVERAGE_FALLBACKS.includes(entry.fallback)) {
      throw new Error(`${label}.fallback is invalid: ${entry.fallback ?? "missing"}`);
    }
    if (!/^[a-f0-9]{64}$/.test(entry.evidenceHash ?? "")) {
      throw new Error(`${label}.evidenceHash must be sha256 hex`);
    }
    byKey.set(key, {
      reasonCode: entry.reasonCode,
      fallback: entry.fallback,
      evidenceHash: entry.evidenceHash,
      reviewedAt: isoInstant(entry.reviewedAt, `${label}.reviewedAt`),
      nextReviewAt: isoInstant(entry.nextReviewAt, `${label}.nextReviewAt`),
      // 게이트는 supportStartedAt이 있으면 EU 전이를 취소한다. 순수 입력 필드라 결정성에 영향이 없다.
      supportStartedAt: entry.supportStartedAt === undefined
        ? null
        : isoInstant(entry.supportStartedAt, `${label}.supportStartedAt`),
    });
  }
  return byKey;
}

function validateTargets(targets) {
  if (!targets || typeof targets !== "object" || Array.isArray(targets)) {
    throw new Error("coverage targets must be an object");
  }
  if (targets.schemaVersion !== 2) throw new Error("coverage targets schemaVersion must be 2");
  if (targets.artifactKind !== "nationwide-datapack-coverage-targets") {
    throw new Error("coverage targets artifactKind must be nationwide-datapack-coverage-targets");
  }
  requiredString(targets.targetVersion, "coverage targets targetVersion");
  if (!Array.isArray(targets.requiredSourceDomains) || targets.requiredSourceDomains.length === 0) {
    throw new Error("coverage targets requiredSourceDomains must be a non-empty array");
  }
  const domainIds = new Set();
  for (const domain of targets.requiredSourceDomains) {
    const id = requiredString(domain?.id, "requiredSourceDomains.id");
    if (domainIds.has(id)) throw new Error(`duplicate source domain id: ${id}`);
    domainIds.add(id);
    if (!RELEASE_TIERS.includes(domain.releaseTier)) {
      throw new Error(`${id}.releaseTier must be LAUNCH_REQUIRED or ENHANCEMENT`);
    }
    requiredStringArray(domain.requiredFields, `${id}.requiredFields`);
    const threshold = domain.blockingThreshold?.minimumOfficialFieldCoverageRatio ?? 1;
    if (typeof threshold !== "number" || threshold <= 0 || threshold > 1) {
      throw new Error(`${id}.blockingThreshold.minimumOfficialFieldCoverageRatio must be between 0 and 1`);
    }
  }
  if (!targets.requiredSourceDomains.some(({ releaseTier }) => releaseTier === "LAUNCH_REQUIRED")) {
    throw new Error("coverage targets must include at least one LAUNCH_REQUIRED domain");
  }
  if (!Array.isArray(targets.regions) || targets.regions.length === 0) {
    throw new Error("coverage targets regions must be a non-empty array");
  }
  const regionIds = new Set();
  for (const region of targets.regions) {
    const id = requiredString(region?.id, "regions.id");
    if (regionIds.has(id)) throw new Error(`duplicate region id: ${id}`);
    regionIds.add(id);
    requiredStringArray(region.operatorIds, `${id}.operatorIds`);
  }
  if (!Array.isArray(targets.activeLineScopes) || targets.activeLineScopes.length === 0) {
    throw new Error("coverage targets activeLineScopes must be a non-empty array");
  }
  // scope 중복은 분모를 부풀리므로 fail closed.
  const scopeKeys = new Set();
  for (const scope of targets.activeLineScopes) {
    const lineId = requiredString(scope?.lineId, "activeLineScopes.lineId");
    const regionId = requiredString(scope.regionId, `${lineId}.regionId`);
    if (!regionIds.has(regionId)) {
      throw new Error(`${lineId}.regionId contains undefined region: ${regionId}`);
    }
    const key = [regionId, requiredString(scope.operatorId, `${lineId}.operatorId`), lineId].join(":");
    if (scopeKeys.has(key)) throw new Error(`duplicate active line scope: ${key}`);
    scopeKeys.add(key);
  }
}

function validateInventory(inventory) {
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) {
    throw new Error("source inventory must be an object");
  }
  if (inventory.schemaVersion !== 1) throw new Error("source inventory schemaVersion must be 1");
  if (!Array.isArray(inventory.sources) || inventory.sources.length === 0) {
    throw new Error("source inventory sources must be a non-empty array");
  }
  requiredString(inventory.retrievedAt, "source inventory retrievedAt");
}

function normalizeSource(source, targetIndex) {
  const id = requiredString(source?.id, "source.id");
  const coverage = source.coverageScope;
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) {
    throw new Error(`${id}.coverageScope must be an object`);
  }
  const normalized = {
    id,
    regionIds: requiredStringArray(coverage.regionIds, `${id}.coverageScope.regionIds`),
    operatorIds: requiredStringArray(coverage.operatorIds, `${id}.coverageScope.operatorIds`),
    sourceDomains: requiredStringArray(coverage.sourceDomains, `${id}.coverageScope.sourceDomains`),
    lineIds: optionalStringArray(coverage.lineIds, `${id}.coverageScope.lineIds`),
    fields: requiredStringArray(source.fieldsProvided ?? source.fields, `${id}.fieldsProvided`),
  };
  // 게이트 validateKnownValues 대응. 오타 id를 조용한 매칭 실패(=과소 집계)로 흘리지 않고 fail closed한다.
  validateKnownValues(normalized.regionIds, targetIndex.regionIds, `${id}.coverageScope.regionIds`, "region");
  validateKnownValues(normalized.operatorIds, targetIndex.operatorIds, `${id}.coverageScope.operatorIds`, "operator");
  validateKnownValues(
    normalized.sourceDomains,
    targetIndex.sourceDomains,
    `${id}.coverageScope.sourceDomains`,
    "source domain",
  );
  if (targetIndex.lineIds.size > 0) {
    validateKnownValues(normalized.lineIds, targetIndex.lineIds, `${id}.coverageScope.lineIds`, "line");
  }
  return normalized;
}

// 게이트 coverageTargetIndex와 같은 known id 집합.
function coverageTargetIndex(targets) {
  return {
    regionIds: new Set([
      ...targets.regions.map((region) => region.id),
      ...optionalStringArray(targets.knownRegionIds, "knownRegionIds"),
    ]),
    operatorIds: new Set([
      ...targets.regions.flatMap((region) => region.operatorIds),
      ...targets.activeLineScopes.map((scope) => scope.operatorId),
      ...optionalStringArray(targets.knownOperatorIds, "knownOperatorIds"),
    ]),
    lineIds: new Set([
      ...targets.activeLineScopes.map((scope) => scope.lineId),
      ...(targets.inactiveLineExclusions ?? []).map((exclusion) => exclusion.lineId),
    ]),
    sourceDomains: new Set([
      ...targets.requiredSourceDomains.map((domain) => domain.id),
      ...optionalStringArray(targets.knownSourceDomains, "knownSourceDomains"),
    ]),
  };
}

function validateKnownValues(values, knownValues, label, valueLabel) {
  for (const value of values) {
    if (!knownValues.has(value)) {
      throw new Error(`${label} contains undefined ${valueLabel}: ${value}`);
    }
  }
}

function regenerationCommand(inputs, expectedLaunchRequiredTotal) {
  const expected = expectedLaunchRequiredTotal === null
    ? []
    : ["--expected-launch-required-total", String(expectedLaunchRequiredTotal)];
  return [
    "node",
    TOOL_PATH,
    "--targets",
    inputRecord(inputs, "targets").path,
    "--inventory",
    inputRecord(inputs, "inventory").path,
    "--resolutions",
    inputRecord(inputs, "resolutions").path,
    ...expected,
    "--output",
    LEDGER_PATH,
  ].join(" ");
}

function inputRecord(inputs, name) {
  const record = inputs?.[name];
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`inputs.${name} must be an object`);
  }
  return {
    path: requiredString(record.path, `inputs.${name}.path`),
    sha256: requiredString(record.sha256, `inputs.${name}.sha256`),
  };
}

function requirementKey({ regionId, operatorId, lineId }, sourceDomain) {
  return `${regionId}:${operatorId}:${lineId}:${sourceDomain}`;
}

function compareScopes(left, right) {
  return codepointCompare(left.regionId, right.regionId)
    || codepointCompare(left.operatorId, right.operatorId)
    || codepointCompare(left.lineId, right.lineId);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort(codepointCompare);
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value;
}

function isoInstant(value, label) {
  if (!ISO_INSTANT.test(requiredString(value, label))) {
    throw new Error(`${label} must be a canonical UTC instant (YYYY-MM-DDTHH:MM:SS.sssZ)`);
  }
  return value;
}

function requiredStringArray(value, label) {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.some((entry) => typeof entry !== "string" || entry.trim() === "")
  ) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  return value;
}

function optionalStringArray(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new Error(`${label} must be a string array`);
  }
  return value;
}

async function readJsonInput(filePath) {
  const bytes = await readFile(filePath);
  return {
    document: JSON.parse(bytes.toString("utf8")),
    input: { path: filePath, sha256: createHash("sha256").update(bytes).digest("hex") },
  };
}

async function main(argv) {
  const args = parseArgs(argv);
  for (const flag of Object.keys(args)) {
    if (!ALLOWED_FLAGS.has(flag)) throw new Error(`unexpected argument: --${flag}`);
  }
  const outputPath = requireArg(args, "output");
  const targets = await readJsonInput(requireArg(args, "targets"));
  const inventory = await readJsonInput(requireArg(args, "inventory"));
  const resolutions = await readJsonInput(args.resolutions ?? DEFAULT_RESOLUTIONS_PATH);
  const expectedRaw = args["expected-launch-required-total"];
  if (expectedRaw !== undefined && !/^\d+$/.test(expectedRaw)) {
    throw new Error("--expected-launch-required-total must be a non-negative integer");
  }

  const ledger = buildNationwideCoverageTally({
    targets: targets.document,
    inventory: inventory.document,
    resolutions: resolutions.document,
    inputs: {
      targets: targets.input,
      inventory: inventory.input,
      resolutions: resolutions.input,
    },
    expectedLaunchRequiredTotal: expectedRaw === undefined ? null : Number(expectedRaw),
  });

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(sortJson(ledger), null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
