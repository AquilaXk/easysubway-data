#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const inventoryPath = optionValue("--inventory") ?? "tools/datapack/source-inventory.json";
const scopePath = optionValue("--scope");
const compareStrings = (left, right) => left.localeCompare(right);

try {
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  const scope = scopePath ? JSON.parse(await readFile(scopePath, "utf8")) : null;
  validateInventory(inventory);
  if (scope) {
    validateProductionScope(inventory, scope);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function optionValue(name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return null;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function validateInventory(inventory) {
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) {
    throw new Error("source inventory must be an object");
  }
  assertEqual(inventory.schemaVersion, 1, "schemaVersion");
  assertString(inventory.region, "region");
  assertEqual(inventory.artifactKind, "production-source-inventory", "artifactKind");
  assertDate(inventory.retrievedAt, "retrievedAt");
  if (!Array.isArray(inventory.sources) || inventory.sources.length === 0) {
    throw new Error("sources must be a non-empty array");
  }

  const ids = new Set();
  for (const [index, source] of inventory.sources.entries()) {
    validateSource(source, `sources[${index}]`);
    if (ids.has(source.id)) {
      throw new Error(`duplicate source id: ${source.id}`);
    }
    ids.add(source.id);
  }
}

function validateSource(source, label) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error(`${label} must be an object`);
  }

  const id = assertString(source.id, `${label}.id`);
  assertString(source.displayName, `${id}.displayName`);
  assertString(source.owner, `${id}.owner`);
  assertString(source.provider, `${id}.provider`);
  assertString(source.sourceSystem, `${id}.sourceSystem`);
  assertHttpsUrl(source.datasetUrl, `${id}.datasetUrl`);
  assertString(source.updateFrequency, `${id}.updateFrequency`);
  assertDate(source.retrievedAt, `${id}.retrievedAt`);

  if (typeof source.requiredForProductionPack !== "boolean") {
    throw new TypeError(`${id}.requiredForProductionPack must be boolean`);
  }
  assertDate(source.observedDataUpdatedAt, `${id}.observedDataUpdatedAt`);
  validateLicense(source.license, id);
  validateCoverageScope(source.coverageScope, id);
  validateCapabilities(source.capabilities, source, id);

  if (!Array.isArray(source.fieldsProvided) || source.fieldsProvided.length === 0) {
    throw new Error(`${id}.fieldsProvided must be a non-empty array`);
  }
  for (const field of source.fieldsProvided) {
    assertString(field, `${id}.fieldsProvided[]`);
  }
}

function validateCapabilities(capabilities, source, sourceId) {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    throw new Error(`${sourceId}.capabilities must be an object`);
  }

  const capabilityNames = ["schedule", "realtime", "facility"];
  for (const name of capabilityNames) {
    validateCapability(capabilities[name], source, sourceId, name);
  }

  const declaredCapabilityNames = Object.keys(capabilities).sort(compareStrings);
  const expectedCapabilityNames = [...capabilityNames].sort(compareStrings);
  if (JSON.stringify(declaredCapabilityNames) !== JSON.stringify(expectedCapabilityNames)) {
    throw new Error(`${sourceId}.capabilities must declare exactly schedule, realtime, and facility`);
  }
}

function validateCapability(capability, source, sourceId, name) {
  if (!capability || typeof capability !== "object" || Array.isArray(capability)) {
    throw new Error(`${sourceId}.capabilities.${name} must be an object`);
  }

  const status = assertString(capability.status, `${sourceId}.capabilities.${name}.status`);
  if (!["SUPPORTED", "CANDIDATE", "UNSUPPORTED"].includes(status)) {
    throw new Error(`${sourceId}.capabilities.${name}.status must be SUPPORTED, CANDIDATE, or UNSUPPORTED`);
  }
  if (typeof capability.productionUseAllowed !== "boolean") {
    throw new TypeError(`${sourceId}.capabilities.${name}.productionUseAllowed must be boolean`);
  }
  assertString(capability.coverageStatus, `${sourceId}.capabilities.${name}.coverageStatus`);
  assertString(capability.updateFrequency, `${sourceId}.capabilities.${name}.updateFrequency`);
  assertString(capability.unsupportedNotes, `${sourceId}.capabilities.${name}.unsupportedNotes`);

  if (status === "UNSUPPORTED" && capability.productionUseAllowed !== false) {
    throw new Error(`${sourceId}.capabilities.${name}.productionUseAllowed must be false when unsupported`);
  }
  if (
    capability.productionUseAllowed &&
    (source.license.commercialUseAllowed !== true || source.license.redistributionAllowed !== true)
  ) {
    throw new Error(`${sourceId}.capabilities.${name}.productionUseAllowed requires commercial use and redistribution license`);
  }

  if (name !== "realtime") {
    return;
  }
  if (typeof capability.liveEtaEligible !== "boolean") {
    throw new TypeError(`${sourceId}.capabilities.realtime.liveEtaEligible must be boolean`);
  }
  const rateLimitStatus = assertString(capability.rateLimitStatus, `${sourceId}.capabilities.realtime.rateLimitStatus`);
  if (
    capability.liveEtaEligible &&
    (capability.productionUseAllowed !== true || rateLimitStatus !== "COMPATIBLE")
  ) {
    throw new Error(`${sourceId}.capabilities.realtime live ETA requires compatible provider terms and rate limits`);
  }
}

function validateProductionScope(inventory, scope) {
  const sourceSet = scope?.productionSourceSet;
  if (!sourceSet || typeof sourceSet !== "object" || Array.isArray(sourceSet)) {
    throw new Error("productionSourceSet must be an object");
  }
  const requiredSourceIds = new Set(assertStringArray(sourceSet.requiredSourceIds, "productionSourceSet.requiredSourceIds"));
  const optionalSourceIds = new Set(
    assertStringArray(sourceSet.optionalAccessibilitySourceIds, "productionSourceSet.optionalAccessibilitySourceIds"),
  );
  const excludedSourceIds = new Set(
    assertStringArray(sourceSet.excludedFromV1SupportClaims, "productionSourceSet.excludedFromV1SupportClaims"),
  );
  const sources = new Map(inventory.sources.map((source) => [source.id, source]));

  assertDisjoint(requiredSourceIds, optionalSourceIds, "requiredSourceIds", "optionalAccessibilitySourceIds");
  assertDisjoint(requiredSourceIds, excludedSourceIds, "requiredSourceIds", "excludedFromV1SupportClaims");
  assertDisjoint(optionalSourceIds, excludedSourceIds, "optionalAccessibilitySourceIds", "excludedFromV1SupportClaims");

  for (const sourceId of requiredSourceIds) {
    const source = requireInventorySource(sources, sourceId);
    if (source.requiredForProductionPack !== true) {
      throw new Error(`required source ${sourceId} must be requiredForProductionPack`);
    }
  }
  for (const sourceId of optionalSourceIds) {
    const source = requireInventorySource(sources, sourceId);
    if (source.requiredForProductionPack !== false) {
      throw new Error(`optional source ${sourceId} must not be requiredForProductionPack`);
    }
  }
  for (const sourceId of excludedSourceIds) {
    const source = requireInventorySource(sources, sourceId);
    if (source.requiredForProductionPack !== false) {
      throw new Error(`excluded source ${sourceId} must not be requiredForProductionPack`);
    }
  }

  for (const source of inventory.sources) {
    if (source.requiredForProductionPack === true && !requiredSourceIds.has(source.id)) {
      throw new Error(`${source.id}.requiredForProductionPack must match productionSourceSet.requiredSourceIds`);
    }
  }
}

function requireInventorySource(sources, sourceId) {
  const source = sources.get(sourceId);
  if (!source) {
    throw new Error(`source inventory missing: ${sourceId}`);
  }
  return source;
}

function assertDisjoint(left, right, leftLabel, rightLabel) {
  for (const value of left) {
    if (right.has(value)) {
      throw new Error(`${value} cannot be in both ${leftLabel} and ${rightLabel}`);
    }
  }
}

function validateCoverageScope(coverageScope, sourceId) {
  if (!coverageScope || typeof coverageScope !== "object" || Array.isArray(coverageScope)) {
    throw new Error(`${sourceId}.coverageScope must be an object`);
  }
  assertStringArray(coverageScope.regionIds, `${sourceId}.coverageScope.regionIds`);
  assertStringArray(coverageScope.operatorIds, `${sourceId}.coverageScope.operatorIds`);
  assertStringArray(coverageScope.sourceDomains, `${sourceId}.coverageScope.sourceDomains`);
}

function validateLicense(license, sourceId) {
  if (!license || typeof license !== "object" || Array.isArray(license)) {
    throw new Error(`${sourceId}.license must be an object`);
  }
  assertString(license.type, `${sourceId}.license.type`);
  if (!["KOGL-1", "PUBLIC_DATA_FREE_USE"].includes(license.type)) {
    throw new Error(`${sourceId}.license.type must be KOGL-1 or PUBLIC_DATA_FREE_USE`);
  }
  assertString(license.name, `${sourceId}.license.name`);
  assertString(license.attribution, `${sourceId}.license.attribution`);
  assertHttpsUrl(license.evidenceUrl, `${sourceId}.license.evidenceUrl`);

  for (const key of ["commercialUseAllowed", "derivativeWorkAllowed", "redistributionAllowed"]) {
    if (license[key] !== true) {
      throw new Error(`${sourceId}.license.${key} must be true`);
    }
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} must be ${JSON.stringify(expected)}`);
  }
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value;
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  for (const entry of value) {
    assertString(entry, `${label}[]`);
  }
  return value;
}

function assertDate(value, label) {
  assertString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new Error(`${label} must be YYYY-MM-DD`);
  }
}

function assertHttpsUrl(value, label) {
  assertString(value, label);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS`);
  }
}
