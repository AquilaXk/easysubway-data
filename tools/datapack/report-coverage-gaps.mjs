#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targets = JSON.parse(await readFile(requireArg(args, "targets"), "utf8"));
  const inventory = JSON.parse(await readFile(requireArg(args, "inventory"), "utf8"));
  const provenance = args.provenance ? JSON.parse(await readFile(args.provenance, "utf8")) : null;
  const outputPath = requireArg(args, "output");
  const report = buildCoverageGapReport(targets, inventory, provenance);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);

  if (!args.allowGaps && !report.summary.coverageComplete) {
    throw new Error(`nationwide coverage gaps remain: ${report.summary.missingRequirements} missing requirements`);
  }
}

function buildCoverageGapReport(targets, inventory, provenance = null) {
  validateTargets(targets);
  const targetIndex = coverageTargetIndex(targets);
  validateInventory(inventory);
  const sources = inventory.sources.map((source) => normalizeSource(source, targetIndex));
  const provenanceIndex = provenance ? provenanceFieldIndex(provenance) : null;
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
        const sourceIds = [...new Set(fieldCoverage.flatMap((entry) => entry.sourceIds))].sort();
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

  const coveredRequirements = requirements.filter((entry) => entry.status === "covered").length;
  const totalRequirements = requirements.length;
  const missingRequirements = totalRequirements - coveredRequirements;
  return {
    schemaVersion: 1,
    artifactKind: "nationwide-coverage-gap-report",
    targetVersion: targets.targetVersion,
    inventoryRetrievedAt: inventory.retrievedAt,
    candidate: provenanceIndex?.candidate ?? null,
    summary: {
      totalRequirements,
      coveredRequirements,
      missingRequirements,
      coverageRatio: totalRequirements === 0 ? 0 : Number((coveredRequirements / totalRequirements).toFixed(4)),
      coverageComplete: missingRequirements === 0,
    },
    requirements,
  };
}

function coverageTargetIndex(targets) {
  return {
    regionIds: new Set(targets.regions.map((region) => region.id)),
    operatorIds: new Set(targets.regions.flatMap((region) => region.operatorIds)),
    sourceDomains: new Set(targets.requiredSourceDomains.map((domain) => domain.id)),
  };
}

function coveredField(sources, provenanceIndex, regionId, operatorId, sourceDomain, field) {
  const sourceIds = sources
    .filter(
      (source) =>
        source.regionIds.includes(regionId) &&
        source.operatorIds.includes(operatorId) &&
        source.sourceDomains.includes(sourceDomain) &&
        source.fields.includes(field) &&
        (!provenanceIndex || provenanceIndex.officialFieldsBySource.get(source.id)?.has(field)),
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

  const officialFieldsBySource = new Map();
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
      validateProvenanceRecord(record, `${id}@${version}`);
      if (!["OFFICIAL", "FIELD_VERIFIED"].includes(record.derivationKind)) {
        continue;
      }
      const fields = officialFieldsBySource.get(record.sourceId) ?? new Set();
      fields.add(record.field);
      officialFieldsBySource.set(record.sourceId, fields);
    }
  }

  return {
    officialFieldsBySource,
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
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
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
