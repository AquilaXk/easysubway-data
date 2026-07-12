#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { compareStrings } from "./lib/ledger-admission-cli.mjs";

// 게시 범위(capital pilot)의 domain/field 계약 정본. --release-scope 평가는 이 targets로 in-scope gap을 판정한다.
const DEFAULT_RELEASE_SCOPE_TARGETS = "tools/datapack/capital-pilot-coverage-targets.json";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targets = JSON.parse(await readFile(requireArg(args, "targets"), "utf8"));
  const inventory = JSON.parse(await readFile(requireArg(args, "inventory"), "utf8"));
  const provenance = args.provenance ? JSON.parse(await readFile(args.provenance, "utf8")) : null;
  const releaseScope = args.releaseScope ? JSON.parse(await readFile(args.releaseScope, "utf8")) : null;
  // 게시 범위 domain/field 계약은 capital pilot targets가 정본이다. --release-scope가 켜지면 pilot targets를 로드해
  // scope 내 gap을 pilot field 계약으로 평가한다(전국 계약보다 좁은 pilot deferred domain·field가 반영됨).
  const releaseScopeTargets = args.releaseScope
    ? JSON.parse(await readFile(args.releaseTargets ?? DEFAULT_RELEASE_SCOPE_TARGETS, "utf8"))
    : null;
  const outputPath = requireArg(args, "output");
  const report = buildCoverageGapReport(targets, inventory, provenance, releaseScope, releaseScopeTargets);

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

function buildCoverageGapReport(targets, inventory, provenance = null, releaseScope = null, releaseScopeTargets = null) {
  validateTargets(targets);
  const targetIndex = coverageTargetIndex(targets);
  validateInventory(inventory);
  const sources = inventory.sources.map((source) => normalizeSource(source, targetIndex));
  const provenanceIndex = provenance ? provenanceFieldIndex(provenance) : null;

  // 전국 requirement는 nationwide targets 전량으로 산출한다(은폐 금지 — 전국 gap은 그대로 기록).
  const requirements = evaluateRequirements(targets, sources, provenanceIndex);
  const coveredRequirements = requirements.filter((entry) => entry.status === "covered").length;
  const totalRequirements = requirements.length;
  const missingRequirements = totalRequirements - coveredRequirements;
  const summary = {
    totalRequirements,
    coveredRequirements,
    missingRequirements,
    coverageRatio: totalRequirements === 0 ? 0 : Number((coveredRequirements / totalRequirements).toFixed(4)),
    coverageComplete: missingRequirements === 0,
  };

  const report = {
    schemaVersion: 1,
    artifactKind: "nationwide-coverage-gap-report",
    targetVersion: targets.targetVersion,
    inventoryRetrievedAt: inventory.retrievedAt,
    candidate: provenanceIndex?.candidate ?? null,
    summary,
    requirements,
  };

  if (releaseScope) {
    const scopeFilter = resolveReleaseScope(releaseScope);
    // 게시 범위 gap은 pilot targets(capital-pilot-coverage-targets.json)의 domain/field 계약으로 별도 평가한다.
    // pilot 계약은 전국 계약보다 좁다(예: accessibility_facilities에서 status 필드 제외, route_graph 등 deferred domain 제외).
    const pilotTargets = releaseScopeTargets ?? targets;
    validateTargets(pilotTargets);
    const pilotTargetIndex = coverageTargetIndex(pilotTargets);
    const pilotSources = inventory.sources.map((source) => normalizeSource(source, pilotTargetIndex));
    const scopeRequirements = evaluateRequirements(pilotTargets, pilotSources, provenanceIndex).filter(
      (entry) => scopeFilter.regionIds.has(entry.regionId) && scopeFilter.operatorIds.has(entry.operatorId),
    );
    for (const entry of scopeRequirements) {
      entry.inReleaseScope = true;
    }
    const inScopeCovered = scopeRequirements.filter((entry) => entry.status === "covered").length;
    const inScopeTotal = scopeRequirements.length;
    const inScopeMissing = inScopeTotal - inScopeCovered;
    // 전국 gap은 은폐 금지 — nationwide/in-scope 수치를 분리 기록한다. 게시 차단은 releaseScope.missingRequirements만 본다.
    summary.nationwide = {
      totalRequirements,
      coveredRequirements,
      missingRequirements,
    };
    summary.releaseScope = {
      scopeId: scopeFilter.scopeId,
      targetVersion: pilotTargets.targetVersion,
      regionIds: [...scopeFilter.regionIds].sort(compareStrings),
      operatorIds: [...scopeFilter.operatorIds].sort(compareStrings),
      sourceDomains: [...new Set(scopeRequirements.map((entry) => entry.sourceDomain))].sort(compareStrings),
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

function evaluateRequirements(targets, sources, provenanceIndex) {
  const requirements = [];
  for (const region of targets.regions) {
    for (const operatorId of region.operatorIds) {
      for (const domain of targets.requiredSourceDomains) {
        const fieldCoverage = domain.requiredFields.map((field) =>
          coveredField(sources, provenanceIndex, region.id, operatorId, domain.id, field),
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
          regionId: region.id,
          regionName: region.displayName,
          operatorId,
          sourceDomain: domain.id,
          status: coverageRatio >= threshold ? "covered" : "missing",
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
  }
  return requirements;
}

function resolveReleaseScope(releaseScope) {
  if (!releaseScope || typeof releaseScope !== "object" || Array.isArray(releaseScope)) {
    throw new Error("release scope must be an object");
  }
  const supportScope = releaseScope.supportScope;
  if (!supportScope || typeof supportScope !== "object" || Array.isArray(supportScope)) {
    throw new Error("release scope supportScope must be an object");
  }
  const scopeId = requiredString(supportScope.id, "release scope supportScope.id");
  const regionIds = requiredStringArray(supportScope.regionIds, "release scope supportScope.regionIds");
  const operatorIds = requiredStringArray(
    supportScope.includedOperatorIds,
    "release scope supportScope.includedOperatorIds",
  );
  return {
    scopeId,
    regionIds: new Set(regionIds),
    operatorIds: new Set(operatorIds),
  };
}

function coverageTargetIndex(targets) {
  return {
    regionIds: new Set([
      ...targets.regions.map((region) => region.id),
      ...optionalStringArray(targets.knownRegionIds, "knownRegionIds"),
    ]),
    operatorIds: new Set([
      ...targets.regions.flatMap((region) => region.operatorIds),
      ...optionalStringArray(targets.knownOperatorIds, "knownOperatorIds"),
    ]),
    sourceDomains: new Set([
      ...targets.requiredSourceDomains.map((domain) => domain.id),
      ...optionalStringArray(targets.knownSourceDomains, "knownSourceDomains"),
    ]),
  };
}

function coveredField(sources, provenanceIndex, regionId, operatorId, sourceDomain, field) {
  const sourceIds = sources
    .filter(
      (source) =>
        source.regionIds.includes(regionId) &&
        source.operatorIds.includes(operatorId) &&
        source.sourceDomains.includes(sourceDomain) &&
        (provenanceIndex
          ? provenanceIndex.officialFieldScopes.has(coverageKey(source.id, regionId, operatorId, sourceDomain, field))
          : source.fields.includes(field)),
    )
    .map((source) => source.id)
    .sort();
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
  if (targets.schemaVersion !== 1) {
    throw new Error("coverage targets schemaVersion must be 1");
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
    const threshold = domain.blockingThreshold?.minimumOfficialFieldCoverageRatio ?? 1;
    if (typeof threshold !== "number" || threshold <= 0 || threshold > 1) {
      throw new Error(`${id}.blockingThreshold.minimumOfficialFieldCoverageRatio must be between 0 and 1`);
    }
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
  const fields = requiredStringArray(source.fieldsProvided ?? source.fields, `${id}.fieldsProvided`);
  validateKnownValues(regionIds, targetIndex.regionIds, `${id}.coverageScope.regionIds`, "region");
  validateKnownValues(operatorIds, targetIndex.operatorIds, `${id}.coverageScope.operatorIds`, "operator");
  validateKnownValues(sourceDomains, targetIndex.sourceDomains, `${id}.coverageScope.sourceDomains`, "source domain");
  return {
    id,
    regionIds,
    operatorIds,
    sourceDomains,
    fields,
  };
}

function provenanceFieldIndex(provenance) {
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) {
    throw new Error("field provenance must be an object");
  }
  if (provenance.schemaVersion !== 1) {
    throw new Error("field provenance schemaVersion must be 1");
  }
  if (provenance.artifactKind !== "datapack-field-provenance") {
    throw new Error("field provenance artifactKind must be datapack-field-provenance");
  }
  requiredString(provenance.manifestSha256, "field provenance manifestSha256");
  if (!Array.isArray(provenance.packs) || provenance.packs.length === 0) {
    throw new Error("field provenance packs must be a non-empty array");
  }

  const officialFieldScopes = new Set();
  const packs = [];
  for (const pack of provenance.packs) {
    const id = requiredString(pack.id, "field provenance pack.id");
    const version = requiredString(pack.version, "field provenance pack.version");
    const sqliteSha256 = requiredString(pack.sqliteSha256, "field provenance pack.sqliteSha256");
    const artifactKind = requiredString(pack.artifactKind, "field provenance pack.artifactKind");
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
          for (const sourceDomain of normalizedRecord.coverageScope.sourceDomains) {
            officialFieldScopes.add(coverageKey(record.sourceId, regionId, operatorId, sourceDomain, record.field));
          }
        }
      }
    }
  }

  return {
    officialFieldScopes,
    candidate: {
      manifestSha256: provenance.manifestSha256,
      packs,
    },
  };
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
  return {
    derivationKind,
    coverageScope: {
      regionIds: requiredStringArray(record.coverageScope.regionIds, `${label}.coverageScope.regionIds`),
      operatorIds: requiredStringArray(record.coverageScope.operatorIds, `${label}.coverageScope.operatorIds`),
      sourceDomains: requiredStringArray(record.coverageScope.sourceDomains, `${label}.coverageScope.sourceDomains`),
    },
  };
}

function coverageKey(sourceId, regionId, operatorId, sourceDomain, field) {
  return `${sourceId}:${regionId}:${operatorId}:${sourceDomain}:${field}`;
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
