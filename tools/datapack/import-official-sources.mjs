#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inventory = JSON.parse(await readFile(requireArg(args, "inventory"), "utf8"));
  const input = JSON.parse(await readFile(requireArg(args, "input"), "utf8"));
  const outputPath = requireArg(args, "output");
  const fixture = buildFixture(inventory, input);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(fixture, null, 2)}\n`);
}

function buildFixture(inventory, input) {
  validateHeader(input);
  validateInventoryHeader(inventory, input.region);
  const inventorySources = inventorySourceMap(inventory);
  const sourceIds = requiredStringArray(input.sourceIds, "sourceIds");
  const selectedSources = sourceIds.map((sourceId) => {
    const source = inventorySources.get(sourceId);
    if (!source) {
      throw new Error(`source inventory missing: ${sourceId}`);
    }
    return source;
  });
  const allowedSourceIds = new Set(sourceIds);
  const retiredStationIds = retiredStationIdSet(input.retiredStationIds ?? []);
  const mappingBySourceKey = stationMappingBySourceKey(input.stationMappings, allowedSourceIds, retiredStationIds);
  const stationRows = stationLineRows(input.stationLineRows, allowedSourceIds, mappingBySourceKey);
  const stations = normalizedStations(stationRows);
  const stationLines = normalizedStationLines(stationRows);
  const networkEdges = routeEdges(input.routeEdges ?? [], allowedSourceIds, mappingBySourceKey);
  const facilities = facilityRows(input.facilityRows ?? [], allowedSourceIds, mappingBySourceKey);
  const productionMinimumRows = productionMinimumTableRows(input, {
    stations: stations.length,
    stationLines: stationLines.length,
    routeEdges: networkEdges.length,
    facilities: facilities.length,
  });

  return {
    manifest: input.manifest,
    packs: [
      {
        id: requiredString(input.pack.id, "pack.id"),
        version: requiredString(input.pack.version, "pack.version"),
        artifactKind: input.pack.artifactKind ?? "fixture",
        schemaVersion: requiredString(input.pack.schemaVersion, "pack.schemaVersion"),
        url: input.pack.url ?? `catalog/${input.pack.id}-v${input.pack.version}.sqlite.gz`,
        sourceInventory: selectedSources.map(packSourceInventoryEntry),
        requiredTables: input.requiredTables ?? [
          "catalog_metadata",
          "operators",
          "lines",
          "stations",
          "station_lines",
          "network_edges",
        ],
        minimumTableRows: {
          catalog_metadata: 2,
          operators: input.operators?.length ?? 0,
          lines: input.lines?.length ?? 0,
          stations: productionMinimumRows?.stations ?? stations.length,
          station_lines: productionMinimumRows?.station_lines ?? stationLines.length,
          network_edges: productionMinimumRows?.network_edges ?? networkEdges.length,
          facilities: productionMinimumRows?.facilities ?? facilities.length,
        },
        metadata: {
          activePack: requiredString(input.pack.id, "pack.id"),
          sourceIngestAdapter: "official-source-ingest-v1",
          sourceInventoryRetrievedAt: requiredString(inventory.retrievedAt, "inventory.retrievedAt"),
        },
        operators: input.operators ?? [],
        lines: input.lines ?? [],
        stations,
        stationLines,
        stationAliases: stationAliases(input.stationMappings ?? [], mappingBySourceKey),
        networkEdges,
        stationExits: input.stationExits ?? [],
        facilities,
        stationAccessibilitySummaries: input.stationAccessibilitySummaries ?? [],
        representativeRouteRegressions: input.representativeRouteRegressions ?? [],
      },
    ],
  };
}

function productionMinimumTableRows(input, actualCounts) {
  if ((input.pack.artifactKind ?? "fixture") !== "production") {
    return null;
  }
  const coverage = input.minimumProductionCoverage;
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) {
    throw new Error("minimumProductionCoverage must be an object for production pack");
  }
  return {
    stations: requiredCoverageCount(coverage.stations, "stations", actualCounts.stations),
    station_lines: requiredCoverageCount(coverage.stationLines, "stationLines", actualCounts.stationLines),
    network_edges: requiredCoverageCount(coverage.routeEdges, "routeEdges", actualCounts.routeEdges),
    facilities: requiredCoverageCount(coverage.facilities, "facilities", actualCounts.facilities),
  };
}

function requiredCoverageCount(value, label, actualCount) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`minimumProductionCoverage.${label} must be a positive integer`);
  }
  if (actualCount < value) {
    throw new Error(`production coverage ${label} ${actualCount} is below required minimum ${value}`);
  }
  return value;
}

function validateHeader(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("source ingest input must be an object");
  }
  if (input.schemaVersion !== 1) {
    throw new Error("source ingest input schemaVersion must be 1");
  }
  requiredString(input.region, "region");
  if (!input.pack || typeof input.pack !== "object" || Array.isArray(input.pack)) {
    throw new Error("pack must be an object");
  }
  if (!input.manifest || typeof input.manifest !== "object" || Array.isArray(input.manifest)) {
    throw new Error("manifest must be an object");
  }
  if (!Number.isInteger(input.manifest.ttlSeconds) || input.manifest.ttlSeconds <= 0) {
    throw new Error("manifest.ttlSeconds must be a positive integer");
  }
}

function validateInventoryHeader(inventory, expectedRegion) {
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) {
    throw new Error("source inventory must be an object");
  }
  if (inventory.schemaVersion !== 1) {
    throw new Error("source inventory schemaVersion must be 1");
  }
  const inventoryRegion = requiredString(inventory.region, "inventory.region");
  if (inventoryRegion !== expectedRegion) {
    throw new Error(`inventory.region must match input.region: ${inventoryRegion} !== ${expectedRegion}`);
  }
}

function inventorySourceMap(inventory) {
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) {
    throw new Error("source inventory must be an object");
  }
  if (!Array.isArray(inventory.sources) || inventory.sources.length === 0) {
    throw new Error("source inventory sources must be a non-empty array");
  }
  const sources = new Map();
  for (const source of inventory.sources) {
    const id = requiredString(source.id, "inventory.sources.id");
    if (source.requiredForProductionPack !== true) {
      throw new Error(`${id}.requiredForProductionPack must be true`);
    }
    if (!source.license || source.license.redistributionAllowed !== true) {
      throw new Error(`${id}.license.redistributionAllowed must be true`);
    }
    requiredString(source.observedDataUpdatedAt, `${id}.observedDataUpdatedAt`);
    if (sources.has(id)) {
      throw new Error(`duplicate source id: ${id}`);
    }
    sources.set(id, source);
  }
  return sources;
}

function packSourceInventoryEntry(source) {
  return {
    id: requiredString(source.id, "source.id"),
    owner: requiredString(source.owner, `${source.id}.owner`),
    url: requiredString(source.datasetUrl, `${source.id}.datasetUrl`),
    license: requiredString(source.license?.name, `${source.id}.license.name`),
    licenseStatus: "redistributable",
    redistributionAllowed: true,
    updateFrequency: requiredString(source.updateFrequency, `${source.id}.updateFrequency`),
    updatedAt: `${requiredString(source.observedDataUpdatedAt, `${source.id}.observedDataUpdatedAt`)}T00:00:00.000Z`,
    fields: requiredStringArray(source.fieldsProvided, `${source.id}.fieldsProvided`),
  };
}

function retiredStationIdSet(retiredStationIds) {
  if (!Array.isArray(retiredStationIds)) {
    throw new Error("retiredStationIds must be an array");
  }
  const ids = new Set();
  for (const entry of retiredStationIds) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("retiredStationIds entries must be objects");
    }
    const stationId = requiredString(entry.stationId, "retiredStationIds.stationId");
    requiredString(entry.reason, "retiredStationIds.reason");
    ids.add(stationId);
  }
  return ids;
}

function stationMappingBySourceKey(stationMappings, allowedSourceIds, retiredStationIds) {
  if (!Array.isArray(stationMappings) || stationMappings.length === 0) {
    throw new Error("stationMappings must be a non-empty array");
  }
  const mappings = new Map();
  for (const mapping of stationMappings) {
    const sourceId = requiredKnownSource(mapping.sourceId, allowedSourceIds, "stationMappings.sourceId");
    const sourceStationCode = requiredString(mapping.sourceStationCode, "stationMappings.sourceStationCode");
    const lineId = requiredString(mapping.lineId, "stationMappings.lineId");
    const stationId = requiredString(mapping.stationId, "stationMappings.stationId");
    const stationLineId = requiredString(mapping.stationLineId, "stationMappings.stationLineId");
    const mappingStatus = mapping.mappingStatus ?? "active";
    if (!["active", "renamed", "merged"].includes(mappingStatus)) {
      throw new Error(`station mapping status is invalid: ${mappingStatus}`);
    }
    if (mappingStatus !== "active" && !hasMappingEvidence(mapping)) {
      throw new Error(`station mapping evidence is required: ${stationId}`);
    }
    if (retiredStationIds.has(stationId)) {
      throw new Error(`station id reuse is forbidden: ${stationId}`);
    }
    if (stationLineId !== `${stationId}:${lineId}`) {
      throw new Error(`stationLineId must equal stationId:lineId: ${stationLineId}`);
    }
    const key = sourceKey({ sourceId, sourceStationCode, lineId });
    if (mappings.has(key)) {
      throw new Error(`duplicate station mapping: ${key}`);
    }
    mappings.set(key, {
      ...mapping,
      sourceId,
      sourceStationCode,
      lineId,
      stationId,
      stationLineId,
      mappingStatus,
    });
  }
  return mappings;
}

function hasMappingEvidence(mapping) {
  return (
    (Array.isArray(mapping.previousNames) && mapping.previousNames.length > 0) ||
    (Array.isArray(mapping.mergedFromStationIds) && mapping.mergedFromStationIds.length > 0) ||
    typeof mapping.evidence === "string" && mapping.evidence.trim() !== ""
  );
}

function stationLineRows(rows, allowedSourceIds, mappingBySourceKey) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("stationLineRows must be a non-empty array");
  }
  return rows.map((row) => {
    requiredKnownSource(row.sourceId, allowedSourceIds, "stationLineRows.sourceId");
    const key = sourceKey(row);
    const mapping = mappingBySourceKey.get(key);
    if (!mapping) {
      throw new Error(`source mapping missing: ${key}`);
    }
    return { row, mapping };
  });
}

function normalizedStations(stationRows) {
  const stations = new Map();
  for (const { row, mapping } of stationRows) {
    const station = {
      id: mapping.stationId,
      nameKo: requiredString(row.stationNameKo, "stationLineRows.stationNameKo"),
      nameEn: row.stationNameEn ?? "",
      normalizedName: requiredString(row.normalizedName ?? row.stationNameKo, "stationLineRows.normalizedName"),
      region: row.region ?? "",
      latitude: row.latitude ?? null,
      longitude: row.longitude ?? null,
      dataQualityLevel: row.dataQualityLevel ?? "LEVEL_2",
      dataSourceType: row.dataSourceType ?? "OFFICIAL_FILE",
      lastVerifiedAt: requiredString(row.lastVerifiedAt, "stationLineRows.lastVerifiedAt"),
    };
    const existing = stations.get(station.id);
    if (existing && existing.nameKo !== station.nameKo) {
      throw new Error(`station mapping conflict: ${station.id}`);
    }
    stations.set(station.id, existing ?? station);
  }
  return [...stations.values()];
}

function normalizedStationLines(stationRows) {
  const stationLines = new Map();
  for (const { row, mapping } of stationRows) {
    const stationLine = {
      stationId: mapping.stationId,
      lineId: mapping.lineId,
      stationCode: requiredString(row.stationCode ?? row.sourceStationCode, "stationLineRows.stationCode"),
      lineSequence: requiredInteger(row.lineSequence, "stationLineRows.lineSequence"),
      platformInfo: row.platformInfo ?? "",
    };
    const key = `${stationLine.stationId}:${stationLine.lineId}`;
    const existing = stationLines.get(key);
    if (existing) {
      assertSameStationLine(existing, stationLine, key);
      continue;
    }
    stationLines.set(key, stationLine);
  }
  return [...stationLines.values()];
}

function assertSameStationLine(existing, next, key) {
  for (const field of ["stationCode", "lineSequence", "platformInfo"]) {
    if (existing[field] !== next[field]) {
      throw new Error(`station line mapping conflict: ${key}.${field}`);
    }
  }
}

function stationAliases(stationMappings, mappingBySourceKey) {
  const aliases = [];
  for (const mapping of stationMappings) {
    const normalized = mappingBySourceKey.get(sourceKey(mapping));
    for (const previousName of mapping.previousNames ?? []) {
      aliases.push({
        stationId: normalized.stationId,
        alias: requiredString(previousName, "stationMappings.previousNames"),
        normalizedAlias: requiredString(previousName, "stationMappings.previousNames"),
      });
    }
  }
  return aliases;
}

function routeEdges(rows, allowedSourceIds, mappingBySourceKey) {
  return rows.map((row) => {
    requiredKnownSource(row.sourceId, allowedSourceIds, "routeEdges.sourceId");
    return {
      id: requiredString(row.id, "routeEdges.id"),
      fromNodeId: nodeIdForEndpoint(row.from, allowedSourceIds, mappingBySourceKey),
      toNodeId: nodeIdForEndpoint(row.to, allowedSourceIds, mappingBySourceKey),
      durationSeconds: row.durationSeconds ?? 0,
      distanceMeters: row.distanceMeters ?? 0,
      edgeType: row.edgeType ?? "RIDE",
      servicePattern: row.servicePattern ?? "LOCAL",
      includesStairs: row.includesStairs === true,
      stairAccessState: row.stairAccessState ?? (row.includesStairs ? "STAIR_ONLY" : "UNKNOWN"),
      accessibilityStatus: row.accessibilityStatus ?? "UNKNOWN",
      reliabilityScore: row.reliabilityScore ?? 100,
      facilityId: row.facilityId ?? undefined,
      lastVerifiedAt: requiredString(row.lastVerifiedAt, "routeEdges.lastVerifiedAt"),
    };
  });
}

function facilityRows(rows, allowedSourceIds, mappingBySourceKey) {
  return rows.map((row) => ({
    id: requiredString(row.id, "facilityRows.id"),
    stationId: stationIdForEndpoint(row.station, allowedSourceIds, mappingBySourceKey),
    exitId: row.exitId ?? null,
    type: requiredString(row.type, "facilityRows.type"),
    name: requiredString(row.name, "facilityRows.name"),
    status: row.status ?? "NORMAL",
    floorFrom: row.floorFrom ?? "",
    floorTo: row.floorTo ?? "",
    description: row.description ?? "",
  }));
}

function nodeIdForEndpoint(endpoint, allowedSourceIds, mappingBySourceKey) {
  const mapping = mappingForEndpoint(endpoint, allowedSourceIds, mappingBySourceKey);
  const suffix = endpoint.nodeSuffix ? `:${requiredString(endpoint.nodeSuffix, "endpoint.nodeSuffix")}` : "";
  return `${mapping.stationId}:${mapping.lineId}${suffix}`;
}

function stationIdForEndpoint(endpoint, allowedSourceIds, mappingBySourceKey) {
  return mappingForEndpoint(endpoint, allowedSourceIds, mappingBySourceKey).stationId;
}

function mappingForEndpoint(endpoint, allowedSourceIds, mappingBySourceKey) {
  if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) {
    throw new Error("endpoint must be an object");
  }
  requiredKnownSource(endpoint.sourceId, allowedSourceIds, "endpoint.sourceId");
  const key = sourceKey(endpoint);
  const mapping = mappingBySourceKey.get(key);
  if (!mapping) {
    throw new Error(`source mapping missing: ${key}`);
  }
  return mapping;
}

function sourceKey(value) {
  return `${requiredString(value.sourceId, "sourceId")}:${requiredString(value.sourceStationCode, "sourceStationCode")}:${requiredString(value.lineId, "lineId")}`;
}

function requiredKnownSource(value, allowedSourceIds, label) {
  const sourceId = requiredString(value, label);
  if (!allowedSourceIds.has(sourceId)) {
    throw new Error(`source is not enabled for ingest: ${sourceId}`);
  }
  return sourceId;
}

function requiredStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  return value.map((entry) => requiredString(entry, `${label}[]`));
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requiredInteger(value, label) {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  return value;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument: ${key ?? ""}`);
    }
    const normalizedKey = key.slice(2);
    if (Object.hasOwn(args, normalizedKey)) {
      throw new Error(`duplicate argument: --${normalizedKey}`);
    }
    args[normalizedKey] = value;
  }
  return args;
}

function requireArg(args, name) {
  if (!args[name]) {
    throw new Error(`--${name} is required`);
  }
  return args[name];
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
