#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const inventoryPath = optionValue("--inventory") ?? "tools/datapack/source-inventory.json";

try {
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  validateInventory(inventory);
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

  if (source.requiredForProductionPack !== true) {
    throw new Error(`${id}.requiredForProductionPack must be true`);
  }
  assertDate(source.observedDataUpdatedAt, `${id}.observedDataUpdatedAt`);
  validateLicense(source.license, id);

  if (!Array.isArray(source.fieldsProvided) || source.fieldsProvided.length === 0) {
    throw new Error(`${id}.fieldsProvided must be a non-empty array`);
  }
  for (const field of source.fieldsProvided) {
    assertString(field, `${id}.fieldsProvided[]`);
  }
}

function validateLicense(license, sourceId) {
  if (!license || typeof license !== "object" || Array.isArray(license)) {
    throw new Error(`${sourceId}.license must be an object`);
  }
  assertString(license.type, `${sourceId}.license.type`);
  if (license.type !== "KOGL-1") {
    throw new Error(`${sourceId}.license.type must be KOGL-1`);
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
