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
  const isProductionPack = (input.pack.artifactKind ?? "fixture") === "production";
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
  const networkEdges = routeEdges(input.routeEdges ?? [], allowedSourceIds, mappingBySourceKey, isProductionPack);
  const facilities = facilityRows(input.facilityRows ?? [], allowedSourceIds, mappingBySourceKey, isProductionPack);
  const stationFacilityEvidence = stationFacilityEvidenceRows(input, facilities, isProductionPack);
  const movementCandidates = movementPathCandidates(
    input.movementPathCandidates ?? [],
    allowedSourceIds,
    mappingBySourceKey,
    isProductionPack,
  );
  const routeMapPositions = routeMapPositionRows(input.routeMapPositions ?? [], allowedSourceIds, mappingBySourceKey);
  validateSelectedSourceRows(input, sourceIds);
  validateSupportedScopeDenominator(input, stationRows, networkEdges, facilities, movementCandidates, routeMapPositions);
  validateSupportedFacilityCoverage(input, stationRows, stationFacilityEvidence);
  const requiresRouteMapPositions = sourceDomainEnabled(selectedSources, "route_map_positions");
  if (requiresRouteMapPositions && routeMapPositions.length === 0) {
    throw new Error("routeMapPositions must include at least one row when route_map_positions source coverage is selected");
  }
  const productionMinimumRows = productionMinimumTableRows(input, {
    stations: stations.length,
    stationLines: stationLines.length,
    routeEdges: networkEdges.length,
    facilities: facilities.length,
  });
  const productionCoverageEvidence = productionCoverageEvidenceSummary(input, selectedSources, allowedSourceIds);

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
        requiredTables: input.requiredTables ?? compactUnique([
          "catalog_metadata",
          "operators",
          "lines",
          "stations",
          "station_lines",
          "network_edges",
          ...(requiresRouteMapPositions ? ["route_map_positions"] : []),
          "facilities",
          "station_facility_evidence",
        ]),
        minimumTableRows: {
          catalog_metadata: 2,
          operators: input.operators?.length ?? 0,
          lines: input.lines?.length ?? 0,
          stations: productionMinimumRows?.stations ?? stations.length,
          station_lines: productionMinimumRows?.station_lines ?? stationLines.length,
          network_edges: productionMinimumRows?.network_edges ?? networkEdges.length,
          ...(requiresRouteMapPositions ? { route_map_positions: routeMapPositions.length } : {}),
          facilities: productionMinimumRows?.facilities ?? facilities.length,
          station_facility_evidence: stationFacilityEvidence.length,
        },
        metadata: {
          activePack: requiredString(input.pack.id, "pack.id"),
          sourceIngestAdapter: "official-source-ingest-v1",
          sourceInventoryRetrievedAt: requiredString(inventory.retrievedAt, "inventory.retrievedAt"),
          ...(movementCandidates.length > 0
            ? {
                movementPathCandidateCount: String(movementCandidates.length),
              }
            : {}),
          ...(productionCoverageEvidence
            ? {
                productionCoverageEvidence: JSON.stringify(productionCoverageEvidence),
              }
            : {}),
        },
        operators: input.operators ?? [],
        lines: input.lines ?? [],
        stations,
        stationLines,
        stationAliases: stationAliases(input.stationMappings ?? [], mappingBySourceKey),
        networkEdges,
        routeMapPositions,
        stationExits: input.stationExits ?? [],
        facilities,
        stationFacilityEvidence,
        movementPathCandidates: movementCandidates,
        stationAccessibilitySummaries: input.stationAccessibilitySummaries ?? [],
        representativeRouteRegressions: input.representativeRouteRegressions ?? [],
      },
    ],
  };
}

function productionCoverageEvidenceSummary(input, selectedSources, allowedSourceIds) {
  if ((input.pack.artifactKind ?? "fixture") !== "production") {
    return null;
  }
  if (!Array.isArray(input.coverageEvidence) || input.coverageEvidence.length === 0) {
    throw new Error("coverageEvidence must be a non-empty array for production pack");
  }

  const sourceCoverage = sourceCoverageIndex(selectedSources, input.supportedV1Scope);
  const evidenceByKey = new Map();
  for (const entry of input.coverageEvidence) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("coverageEvidence entries must be objects");
    }
    const regionId = requiredString(entry.regionId, "coverageEvidence.regionId");
    const operatorId = requiredString(entry.operatorId, "coverageEvidence.operatorId");
    const sourceDomain = requiredString(entry.sourceDomain, "coverageEvidence.sourceDomain");
    requiredString(entry.evidence, "coverageEvidence.evidence");
    const sourceIds = [...new Set(requiredStringArray(entry.sourceIds, "coverageEvidence.sourceIds"))].sort();
    const key = coverageKey(regionId, operatorId, sourceDomain);
    if (evidenceByKey.has(key)) {
      throw new Error(`duplicate production coverage evidence: ${key}`);
    }
    for (const sourceId of sourceIds) {
      requiredKnownSource(sourceId, allowedSourceIds, "coverageEvidence.sourceIds[]");
      const coveredKeys = sourceCoverage.bySourceId.get(sourceId) ?? new Set();
      if (!coveredKeys.has(key)) {
        throw new Error(`coverage evidence unsupported by source inventory: ${key}`);
      }
    }
    evidenceByKey.set(key, {
      regionId,
      operatorId,
      sourceDomain,
      sourceIds,
    });
  }

  for (const key of sourceCoverage.requiredKeys) {
    if (!evidenceByKey.has(key)) {
      throw new Error(`production coverage evidence missing: ${key}`);
    }
  }

  return [...evidenceByKey.values()].sort((left, right) =>
    coverageKey(left.regionId, left.operatorId, left.sourceDomain).localeCompare(
      coverageKey(right.regionId, right.operatorId, right.sourceDomain),
    ),
  );
}

function sourceCoverageIndex(selectedSources, supportedV1Scope = {}) {
  const bySourceId = new Map();
  const requiredKeys = new Set();
  const supportedRegionIds = new Set(supportedV1Scope.includedRegionIds ?? []);
  const supportedOperatorIds = new Set(supportedV1Scope.includedOperatorIds ?? []);
  for (const source of selectedSources) {
    const sourceId = requiredString(source.id, "source.id");
    const keys = coverageKeysForSource(source, supportedRegionIds, supportedOperatorIds);
    for (const key of keys) requiredKeys.add(key);
    bySourceId.set(sourceId, keys);
  }
  return {
    bySourceId,
    requiredKeys: [...requiredKeys].sort((left, right) => left.localeCompare(right)),
  };
}

function coverageKeysForSource(source, supportedRegionIds, supportedOperatorIds) {
  const sourceId = requiredString(source.id, "source.id");
  const coverage = source.coverageScope;
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) {
    throw new Error(`${sourceId}.coverageScope must be an object`);
  }
  const keys = new Set();
  for (const regionId of requiredStringArray(coverage.regionIds, `${sourceId}.coverageScope.regionIds`)) {
    if (supportedRegionIds.size > 0 && !supportedRegionIds.has(regionId)) continue;
    addOperatorCoverageKeys(sourceId, coverage, regionId, supportedOperatorIds, keys);
  }
  return keys;
}

function addOperatorCoverageKeys(sourceId, coverage, regionId, supportedOperatorIds, keys) {
  for (const operatorId of requiredStringArray(coverage.operatorIds, `${sourceId}.coverageScope.operatorIds`)) {
    if (supportedOperatorIds.size > 0 && !supportedOperatorIds.has(operatorId)) continue;
    for (const sourceDomain of requiredStringArray(coverage.sourceDomains, `${sourceId}.coverageScope.sourceDomains`)) {
      keys.add(coverageKey(regionId, operatorId, sourceDomain));
    }
  }
}

function validateSelectedSourceRows(input, sourceIds) {
  if ((input.pack.artifactKind ?? "fixture") !== "production") {
    return;
  }
  const counts = new Map(sourceIds.map((sourceId) => [sourceId, 0]));
  const add = (sourceId) => {
    if (counts.has(sourceId)) {
      counts.set(sourceId, counts.get(sourceId) + 1);
    }
  };
  for (const row of input.stationLineRows ?? []) add(row.sourceId);
  for (const row of input.routeEdges ?? []) add(row.sourceId);
  for (const row of input.facilityRows ?? []) add(row.sourceId ?? row.station?.sourceId);
  for (const row of input.movementPathCandidates ?? []) add(row.sourceId);
  for (const row of input.routeMapPositions ?? []) add(row.sourceId);
  for (const sourceId of sourceIds) {
    if ((counts.get(sourceId) ?? 0) === 0) {
      throw new Error(`selected production source has no row provenance: ${sourceId}`);
    }
  }
}

function validateSupportedScopeDenominator(input, stationRows, networkEdges, facilities, movementCandidates, routeMapPositions) {
  if ((input.pack.artifactKind ?? "fixture") !== "production") {
    return;
  }
  const supportedV1Scope = input.supportedV1Scope;
  if (!supportedV1Scope || typeof supportedV1Scope !== "object" || Array.isArray(supportedV1Scope)) {
    throw new Error("supportedV1Scope must be an object for production pack");
  }
  const includedStationIds = new Set(
    requiredStringArray(supportedV1Scope.includedStationIds, "supportedV1Scope.includedStationIds"),
  );
  const includedLineIds = new Set(requiredStringArray(supportedV1Scope.includedLineIds, "supportedV1Scope.includedLineIds"));
  const includedOperatorIds = new Set(
    requiredStringArray(supportedV1Scope.includedOperatorIds, "supportedV1Scope.includedOperatorIds"),
  );
  const rowStationIds = new Set(stationRows.map(({ mapping }) => mapping.stationId));
  const rowLineIds = new Set(stationRows.map(({ mapping }) => mapping.lineId));
  const scopedStationIds = new Set(rowStationIds);
  const scopedLineIds = new Set(rowLineIds);
  const lineOperatorIds = new Map();
  const lineReferenceOperatorIds = new Set();
  const operatorMetadataIds = new Set();

  for (const line of input.lines ?? []) {
    const lineId = requiredString(line.id, "lines.id");
    const operatorId = requiredString(line.operatorId, "lines.operatorId");
    scopedLineIds.add(lineId);
    lineReferenceOperatorIds.add(operatorId);
    lineOperatorIds.set(lineId, operatorId);
  }
  for (const operator of input.operators ?? []) {
    operatorMetadataIds.add(requiredString(operator.id, "operators.id"));
  }
  const rowOperatorIds = operatorIdsForLines(rowLineIds, lineOperatorIds);
  addPassThroughScopeIds(input, scopedStationIds, scopedLineIds);
  for (const edge of networkEdges) {
    addNodeScopeIds(edge.fromNodeId, scopedStationIds, scopedLineIds);
    addNodeScopeIds(edge.toNodeId, scopedStationIds, scopedLineIds);
  }
  for (const facility of facilities) {
    scopedStationIds.add(facility.stationId);
  }
  for (const candidate of movementCandidates) {
    scopedStationIds.add(candidate.stationId);
  }
  for (const position of routeMapPositions) {
    scopedStationIds.add(position.stationId);
    scopedLineIds.add(position.lineId);
  }

  assertActualIdsWithinScope(
    scopedStationIds,
    includedStationIds,
    "production scope station outside supportedV1Scope.includedStationIds",
  );
  assertScopeIdsHaveRows(
    includedStationIds,
    rowStationIds,
    "supportedV1Scope.includedStationIds missing production station row",
  );
  assertActualIdsWithinScope(scopedLineIds, includedLineIds, "production scope line outside supportedV1Scope.includedLineIds");
  assertScopeIdsHaveRows(includedLineIds, rowLineIds, "supportedV1Scope.includedLineIds missing production station row");
  assertActualIdsWithinScope(
    new Set([...lineReferenceOperatorIds, ...operatorMetadataIds]),
    includedOperatorIds,
    "production scope operator outside supportedV1Scope.includedOperatorIds",
  );
  assertScopeIdsHaveRows(
    includedOperatorIds,
    operatorMetadataIds,
    "supportedV1Scope.includedOperatorIds missing production operator metadata",
  );
  assertScopeIdsHaveRows(
    includedOperatorIds,
    rowOperatorIds,
    "supportedV1Scope.includedOperatorIds missing production station row",
  );
  const stationLineCount = new Set(stationRows.map(({ mapping }) => `${mapping.stationId}:${mapping.lineId}`)).size;
  validateFacilityCoverageDenominator(supportedV1Scope.facilityCoverageDenominator, stationLineCount, supportedV1Scope);
}

function operatorIdsForLines(lineIds, lineOperatorIds) {
  const operatorIds = new Set();
  for (const lineId of lineIds) {
    const operatorId = lineOperatorIds.get(lineId);
    if (!operatorId) {
      throw new Error(`production scope line metadata missing: ${lineId}`);
    }
    operatorIds.add(operatorId);
  }
  return operatorIds;
}

function addPassThroughScopeIds(input, stationIds, lineIds) {
  for (const mapping of input.stationMappings ?? []) {
    stationIds.add(requiredString(mapping.stationId, "stationMappings.stationId"));
    lineIds.add(requiredString(mapping.lineId, "stationMappings.lineId"));
  }
  for (const exit of input.stationExits ?? []) {
    stationIds.add(requiredString(exit.stationId, "stationExits.stationId"));
  }
  for (const summary of input.stationAccessibilitySummaries ?? []) {
    stationIds.add(requiredString(summary.stationId, "stationAccessibilitySummaries.stationId"));
  }
  for (const route of input.representativeRouteRegressions ?? []) {
    addNodeScopeIds(route.fromNodeId, stationIds, lineIds, "representativeRouteRegressions.fromNodeId");
    addNodeScopeIds(route.toNodeId, stationIds, lineIds, "representativeRouteRegressions.toNodeId");
  }
}

function addNodeScopeIds(nodeId, stationIds, lineIds, label = "networkEdges.nodeId") {
  const [stationId, lineId] = requiredString(nodeId, label).split(":");
  stationIds.add(stationId);
  if (lineId) {
    lineIds.add(lineId);
  }
}

function validateFacilityCoverageDenominator(value, stationLineCount, supportedV1Scope) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("supportedV1Scope.facilityCoverageDenominator must be an object for production pack");
  }
  if (value.kind !== "station_line_x_required_facility_type") {
    throw new Error("supportedV1Scope.facilityCoverageDenominator.kind must be station_line_x_required_facility_type");
  }
  const requiredFacilityTypes = requiredStringArray(
    supportedV1Scope.requiredFacilityTypes,
    "supportedV1Scope.requiredFacilityTypes",
  );
  const expectedRows = requiredInteger(
    value.expectedRows,
    "supportedV1Scope.facilityCoverageDenominator.expectedRows",
  );
  const computedRows = stationLineCount * requiredFacilityTypes.length;
  if (expectedRows !== computedRows) {
    throw new Error(
      `supportedV1Scope.facilityCoverageDenominator.expectedRows must equal stationLines x requiredFacilityTypes: ${computedRows}`,
    );
  }
}

function assertActualIdsWithinScope(actualIds, allowedIds, message) {
  for (const id of [...actualIds].sort((left, right) => left.localeCompare(right))) {
    if (!allowedIds.has(id)) {
      throw new Error(`${message}: ${id}`);
    }
  }
}

function assertScopeIdsHaveRows(allowedIds, actualIds, message) {
  for (const id of [...allowedIds].sort((left, right) => left.localeCompare(right))) {
    if (!actualIds.has(id)) {
      throw new Error(`${message}: ${id}`);
    }
  }
}

function validateSupportedFacilityCoverage(input, stationRows, stationFacilityEvidence) {
  if ((input.pack.artifactKind ?? "fixture") !== "production") {
    return;
  }
  const requiredFacilityTypes = input.supportedV1Scope?.requiredFacilityTypes;
  if (!Array.isArray(requiredFacilityTypes) || requiredFacilityTypes.length === 0) {
    throw new Error("supportedV1Scope.requiredFacilityTypes must be a non-empty array for production pack");
  }
  const stationLineKeys = new Set(stationRows.map(({ mapping }) => `${mapping.stationId}:${mapping.lineId}`));
  const evidenceKeys = new Set(
    stationFacilityEvidence.map((evidence) => {
      const lineId = requiredString(evidence.lineId, "stationFacilityEvidence.lineId");
      const facilityType = requiredString(evidence.facilityType, "stationFacilityEvidence.facilityType");
      return `${evidence.stationId}:${lineId}:${facilityType}`;
    }),
  );
  for (const stationLineKey of [...stationLineKeys].sort((left, right) => left.localeCompare(right))) {
    for (const facilityType of requiredStringArray(requiredFacilityTypes, "supportedV1Scope.requiredFacilityTypes")) {
      const key = `${stationLineKey}:${facilityType}`;
      if (!evidenceKeys.has(key)) {
        throw new Error(`production facility evidence missing: ${key}`);
      }
    }
  }
}

function sourceDomainEnabled(selectedSources, sourceDomain) {
  return selectedSources.some((source) => source.coverageScope?.sourceDomains?.includes(sourceDomain));
}

function coverageKey(regionId, operatorId, sourceDomain) {
  return `${regionId}:${operatorId}:${sourceDomain}`;
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
  if (inventoryRegion !== "nationwide" && inventoryRegion !== expectedRegion) {
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
    if (typeof source.requiredForProductionPack !== "boolean") {
      throw new TypeError(`${id}.requiredForProductionPack must be boolean`);
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
    coverageScope: {
      regionIds: requiredStringArray(source.coverageScope?.regionIds, `${source.id}.coverageScope.regionIds`),
      operatorIds: requiredStringArray(source.coverageScope?.operatorIds, `${source.id}.coverageScope.operatorIds`),
      sourceDomains: requiredStringArray(source.coverageScope?.sourceDomains, `${source.id}.coverageScope.sourceDomains`),
    },
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
      sourceId: row.sourceId,
      derivationKind: "OFFICIAL",
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
      sourceId: row.sourceId,
      derivationKind: "OFFICIAL",
      lastVerifiedAt: requiredString(row.lastVerifiedAt, "stationLineRows.lastVerifiedAt"),
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

function routeEdges(rows, allowedSourceIds, mappingBySourceKey, isProductionPack) {
  return rows.map((row) => {
    requiredKnownSource(row.sourceId, allowedSourceIds, "routeEdges.sourceId");
    const id = requiredString(row.id, "routeEdges.id");
    return {
      id,
      fromNodeId: nodeIdForEndpoint(row.from, allowedSourceIds, mappingBySourceKey),
      toNodeId: nodeIdForEndpoint(row.to, allowedSourceIds, mappingBySourceKey),
      durationSeconds: row.durationSeconds ?? 0,
      distanceMeters: row.distanceMeters ?? 0,
      edgeType: row.edgeType ?? "RIDE",
      servicePattern: row.servicePattern ?? "LOCAL",
      includesStairs: row.includesStairs === true,
      stairAccessState: row.stairAccessState ?? (row.includesStairs ? "STAIR_ONLY" : "UNKNOWN"),
      accessibilityStatus:
        productionString(row.accessibilityStatus, isProductionPack, "routeEdges.accessibilityStatus") ?? "UNKNOWN",
      reliabilityScore: productionInteger(row.reliabilityScore, isProductionPack, "routeEdges.reliabilityScore") ?? 100,
      sourceId: row.sourceId,
      sourceSnapshotId: productionString(row.sourceSnapshotId, isProductionPack, "routeEdges.sourceSnapshotId"),
      providerRecordHash: productionEvidenceHash(
        row.providerRecordHash,
        isProductionPack,
        id,
        "routeEdges.providerRecordHash",
      ),
      provenanceKind:
        productionString(row.provenanceKind, isProductionPack, "routeEdges.provenanceKind") ?? "OFFICIAL_SOURCE",
      verificationStatus:
        productionString(row.verificationStatus, isProductionPack, "routeEdges.verificationStatus") ?? "VERIFIED",
      facilityId: row.facilityId ?? undefined,
      lastVerifiedAt: requiredString(row.verifiedAt ?? row.lastVerifiedAt, "routeEdges.lastVerifiedAt"),
      evidenceHash: productionEvidenceHash(row.evidenceHash, isProductionPack, id, "routeEdges.evidenceHash"),
    };
  });
}

function facilityRows(rows, allowedSourceIds, mappingBySourceKey, isProductionPack) {
  return rows.map((row) => {
    const sourceId = row.sourceId ?? row.station?.sourceId;
    requiredKnownSource(sourceId, allowedSourceIds, "facilityRows.sourceId");
    const id = requiredString(row.id, "facilityRows.id");
    const evidenceHash = productionEvidenceHash(row.evidenceHash, isProductionPack, id, "facilityRows.evidenceHash");
    const providerRecordHash = productionEvidenceHash(
      row.providerRecordHash,
      isProductionPack,
      id,
      "facilityRows.providerRecordHash",
    );
    const stationMapping = mappingForEndpoint(row.station, allowedSourceIds, mappingBySourceKey);
    return {
      id,
      stationId: stationMapping.stationId,
      lineId: stationMapping.lineId,
      exitId: row.exitId ?? null,
      type: requiredString(row.type, "facilityRows.type"),
      name: requiredString(row.name, "facilityRows.name"),
      status: row.status ?? "UNKNOWN",
      floorFrom: row.floorFrom ?? "",
      floorTo: row.floorTo ?? "",
      description: row.description ?? "",
      sourceId,
      sourceSnapshotId: productionString(row.sourceSnapshotId, isProductionPack, "facilityRows.sourceSnapshotId"),
      providerFacilityRef:
        productionString(row.providerFacilityRef, isProductionPack, "facilityRows.providerFacilityRef") ?? id,
      providerRecordHash,
      provenanceKind:
        productionString(row.provenanceKind, isProductionPack, "facilityRows.provenanceKind") ?? "OFFICIAL_SOURCE",
      statusMeaning: productionString(row.statusMeaning, isProductionPack, "facilityRows.statusMeaning"),
      operationalStatus:
        productionString(row.operationalStatus, isProductionPack, "facilityRows.operationalStatus") ?? "UNKNOWN",
      installationStatus:
        productionString(row.installationStatus, isProductionPack, "facilityRows.installationStatus") ?? "UNKNOWN",
      verifiedAt: productionString(row.verifiedAt, isProductionPack, "facilityRows.verifiedAt") ?? row.lastVerifiedAt,
      retrievedAt: productionString(row.retrievedAt, isProductionPack, "facilityRows.retrievedAt"),
      evidenceHash,
      confidence: productionPercentageInteger(row.confidence, isProductionPack, "facilityRows.confidence"),
      derivationKind: "OFFICIAL",
      lastVerifiedAt: productionString(row.verifiedAt, isProductionPack, "facilityRows.verifiedAt") ?? row.lastVerifiedAt,
    };
  });
}

function stationFacilityEvidenceRows(input, facilities, isProductionPack) {
  if (!isProductionPack) {
    return [];
  }
  const includedStationIds = requiredStringArray(
    input.supportedV1Scope?.includedStationIds,
    "supportedV1Scope.includedStationIds",
  );
  const requiredFacilityTypes = requiredStringArray(
    input.supportedV1Scope?.requiredFacilityTypes,
    "supportedV1Scope.requiredFacilityTypes",
  );

  const facilitiesByCoverageKey = new Map();
  for (const facility of facilities) {
    const key = `${facility.stationId}:${facility.lineId}:${requiredString(facility.type, "facilities.type")}`;
    const current = facilitiesByCoverageKey.get(key);
    if (!current || facility.id.localeCompare(current.id) < 0) {
      facilitiesByCoverageKey.set(key, facility);
    }
  }

  const rows = [];
  for (const stationId of [...includedStationIds].sort((left, right) => left.localeCompare(right))) {
    for (const facilityType of [...requiredFacilityTypes].sort((left, right) => left.localeCompare(right))) {
      for (const facility of [...facilitiesByCoverageKey.values()]
        .filter((entry) => entry.stationId === stationId && entry.type === facilityType)
        .sort((left, right) => left.lineId.localeCompare(right.lineId))) {
        rows.push({
          stationId,
          lineId: facility.lineId,
          facilityType,
          evidenceKind: "EXISTS",
          sourceId: facility.sourceId,
          sourceSnapshotId: facility.sourceSnapshotId,
          providerRecordHash: facility.providerRecordHash,
          evidenceHash: facility.evidenceHash,
          provenanceKind: facility.provenanceKind,
          installationStatus: facility.installationStatus,
          operationalStatus: facility.operationalStatus,
          statusMeaning: facility.statusMeaning,
          confidence: facility.confidence,
          verifiedAt: facility.verifiedAt,
          retrievedAt: facility.retrievedAt,
          strictRouteEligible: true,
          strictRouteEligibleReason: "FACILITY_EXISTS_AND_PROVENANCE_VERIFIED",
        });
      }
    }
  }
  return rows;
}

function productionString(value, isProductionPack, label) {
  if (!isProductionPack) {
    return value;
  }
  return requiredString(value, label);
}

function productionInteger(value, isProductionPack, label) {
  if (!isProductionPack) {
    return value;
  }
  return requiredInteger(value, label);
}

function productionPercentageInteger(value, isProductionPack, label) {
  if (!isProductionPack) {
    return value;
  }
  const integer = requiredInteger(value, label);
  if (integer < 0 || integer > 100) {
    throw new Error(`${label} must be between 0 and 100`);
  }
  return integer;
}

function productionEvidenceHash(value, isProductionPack, rowId, label) {
  if (!isProductionPack) {
    return value;
  }
  const hash = requiredString(value, label);
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error(`${label} must be lowercase sha256: ${rowId}`);
  }
  if (/^([0-9a-f])\1{63}$/.test(hash)) {
    throw new Error(`${label} is placeholder evidence: ${rowId}`);
  }
  return hash;
}

function movementPathCandidates(rows, allowedSourceIds, mappingBySourceKey, isProductionPack) {
  return rows.map((row) => {
    requiredKnownSource(row.sourceId, allowedSourceIds, "movementPathCandidates.sourceId");
    const id = requiredString(row.id, "movementPathCandidates.id");
    return {
      id,
      sourceId: requiredString(row.sourceId, "movementPathCandidates.sourceId"),
      sourceSnapshotId: productionString(row.sourceSnapshotId, isProductionPack, "movementPathCandidates.sourceSnapshotId"),
      providerRecordHash: productionEvidenceHash(
        row.providerRecordHash,
        isProductionPack,
        id,
        "movementPathCandidates.providerRecordHash",
      ),
      evidenceHash: productionEvidenceHash(row.evidenceHash, isProductionPack, id, "movementPathCandidates.evidenceHash"),
      stationId: stationIdForEndpoint(row.station, allowedSourceIds, mappingBySourceKey),
      facilityType: requiredString(row.facilityType, "movementPathCandidates.facilityType"),
      fromLabel: requiredString(row.fromLabel, "movementPathCandidates.fromLabel"),
      toLabel: requiredString(row.toLabel, "movementPathCandidates.toLabel"),
      movementOrder: requiredInteger(row.movementOrder, "movementPathCandidates.movementOrder"),
      instruction: requiredString(row.instruction, "movementPathCandidates.instruction"),
      sourceImageUrl: row.sourceImageUrl ?? "",
      reviewStatus: "PENDING_ADMIN_REVIEW",
    };
  });
}

function routeMapPositionRows(rows, allowedSourceIds, mappingBySourceKey) {
  return rows.map((row) => {
    const sourceId = requiredKnownSource(row.sourceId, allowedSourceIds, "routeMapPositions.sourceId");
    const mapping = mappingForEndpoint(row.station, allowedSourceIds, mappingBySourceKey);
    return {
      stationId: mapping.stationId,
      lineId: mapping.lineId,
      region: requiredString(row.region, "routeMapPositions.region"),
      x: requiredNonNegativeInteger(row.x, "routeMapPositions.x"),
      y: requiredNonNegativeInteger(row.y, "routeMapPositions.y"),
      labelPolygon: row.labelPolygon ?? undefined,
      sourceId,
      sourceName: requiredString(row.sourceName, "routeMapPositions.sourceName"),
      sourceUrl: requiredString(row.sourceUrl, "routeMapPositions.sourceUrl"),
      sourceSha256: requiredString(row.sourceSha256, "routeMapPositions.sourceSha256"),
      license: row.license ?? "",
      licenseStatus: requiredString(row.licenseStatus, "routeMapPositions.licenseStatus"),
      commercialUseAllowed: row.commercialUseAllowed === true,
      attributionRequired: row.attributionRequired !== false,
      derivationKind: "OFFICIAL",
      sourceLabel: row.sourceLabel ?? "",
      reviewedAt: requiredString(row.reviewedAt, "routeMapPositions.reviewedAt"),
    };
  });
}

function nodeIdForEndpoint(endpoint, allowedSourceIds, mappingBySourceKey) {
  const mapping = mappingForEndpoint(endpoint, allowedSourceIds, mappingBySourceKey);
  if (endpoint.nodeKind === "STATION") {
    return mapping.stationId;
  }
  if (endpoint.nodeKind && endpoint.nodeKind !== "STATION_LINE") {
    throw new Error(`endpoint.nodeKind is invalid: ${endpoint.nodeKind}`);
  }
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

function requiredNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function compactUnique(values) {
  return [...new Set(values)];
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
