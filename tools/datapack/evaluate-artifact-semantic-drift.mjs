import { createHash } from "node:crypto";

export const SOUTH_KOREA_BOUNDS = Object.freeze({
  minLat: 33.0,
  maxLat: 38.7,
  minLng: 124.5,
  maxLng: 132.0,
});

export const CANONICAL_TABLES = Object.freeze([
  "stations",
  "lines",
  "station_lines",
  "edges",
  "transfers",
  "timetables",
  "fares",
  "facilities",
]);

export const DISTRIBUTION_METRICS = Object.freeze([
  "travel_seconds",
  "transfer_walk_distance_m",
  "fare_krw",
  "lat",
  "lng",
]);

const POSITIVE_DOMAIN_METRICS = new Set([
  "travel_seconds",
  "transfer_walk_distance_m",
  "fare_krw",
]);

export const DEFAULT_DRIFT_POLICY = Object.freeze({
  requiredTables: CANONICAL_TABLES,
  maxRowDropRatio: 0.05,
  maxRowSpikeRatio: 0.25,
  maxKeyCardinalityDropRatio: 0.05,
  maxMedianShiftRatio: 0.15,
  maxP95ShiftRatio: 0.20,
  allowZeroOrNegativeMetrics: false,
  requireThreeArtifactParity: true,
});

const ARTIFACT_KEYS = Object.freeze([
  "datapack",
  "server-route-bundle",
  "map-catalog",
]);

const compareStrings = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function canonicalizeValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (value && typeof value === "object") {
    const sortedEntries = Object.keys(value)
      .sort(compareStrings)
      .map((key) => [key, canonicalizeValue(value[key])]);
    return Object.fromEntries(sortedEntries);
  }
  return value;
}

export function canonicalSemanticJson(value) {
  return JSON.stringify(canonicalizeValue(value));
}

function sha256Hex(value) {
  return createHash("sha256").update(canonicalSemanticJson(value)).digest("hex");
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeStringField(value) {
  return isNonEmptyString(value) ? value.trim() : "";
}

function isOutOfSouthKoreaBounds(lat, lng) {
  return (
    !Number.isFinite(lat)
    || !Number.isFinite(lng)
    || lat < SOUTH_KOREA_BOUNDS.minLat
    || lat > SOUTH_KOREA_BOUNDS.maxLat
    || lng < SOUTH_KOREA_BOUNDS.minLng
    || lng > SOUTH_KOREA_BOUNDS.maxLng
  );
}

function quantileFromSortedFloat64(sorted, count, q) {
  if (count === 0) return null;
  if (count === 1) return sorted[0];
  const position = (count - 1) * q;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) return sorted[lowerIndex];
  const weight = position - lowerIndex;
  const interpolated = sorted[lowerIndex] + (sorted[upperIndex] - sorted[lowerIndex]) * weight;
  return Number(interpolated.toFixed(6));
}

export function computeNumericDistribution(rawValues) {
  const length = rawValues.length;
  const buffer = new Float64Array(length);
  let validCount = 0;
  let zeroCount = 0;
  let negativeCount = 0;

  for (let index = 0; index < length; index += 1) {
    const raw = rawValues[index];
    if (raw === null || raw === undefined || raw === "") continue;
    const numeric = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(numeric)) continue;
    if (numeric === 0) zeroCount += 1;
    else if (numeric < 0) negativeCount += 1;
    buffer[validCount] = numeric;
    validCount += 1;
  }

  if (validCount === 0) {
    return {
      count: 0,
      min: null,
      max: null,
      p50: null,
      p95: null,
      zeroCount: 0,
      negativeCount: 0,
    };
  }

  const sorted = buffer.subarray(0, validCount);
  sorted.sort();
  return {
    count: validCount,
    min: sorted[0],
    max: sorted[validCount - 1],
    p50: quantileFromSortedFloat64(sorted, validCount, 0.5),
    p95: quantileFromSortedFloat64(sorted, validCount, 0.95),
    zeroCount,
    negativeCount,
  };
}

function parseTimeSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d{1,2}:\d{2}(:\d{2})?$/.test(value.trim())) {
    const parts = value.trim().split(":").map(Number);
    const [hours, minutes, seconds = 0] = parts;
    return hours * 3600 + minutes * 60 + seconds;
  }
  return null;
}

function isSqliteDatabaseHandle(input) {
  return Boolean(input && typeof input.prepare === "function");
}

function extractSqliteProfileData(db) {
  const existingTables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  );

  const readRows = (tableName, fallbackAlias = null) => {
    if (existingTables.has(tableName)) {
      return db.prepare(`SELECT * FROM "${tableName}"`).all();
    }
    if (fallbackAlias && existingTables.has(fallbackAlias)) {
      return db.prepare(`SELECT * FROM "${fallbackAlias}"`).all();
    }
    return [];
  };

  let sqliteCteSummary = null;
  if (
    existingTables.has("stations")
    && existingTables.has("lines")
    && existingTables.has("station_lines")
    && existingTables.has("edges")
    && existingTables.has("transfers")
    && existingTables.has("timetables")
    && existingTables.has("fares")
    && existingTables.has("facilities")
  ) {
    sqliteCteSummary = db.prepare(`
      WITH
        valid_station_ids AS (
          SELECT DISTINCT trim(station_id) AS station_id
          FROM stations
          WHERE station_id IS NOT NULL AND trim(station_id) <> ''
        ),
        connected_station_ids AS (
          SELECT trim(station_id) AS station_id
          FROM station_lines
          WHERE station_id IS NOT NULL AND trim(station_id) <> ''
          UNION
          SELECT trim(from_station_id) AS station_id
          FROM edges
          WHERE from_station_id IS NOT NULL AND trim(from_station_id) <> ''
          UNION
          SELECT trim(to_station_id) AS station_id
          FROM edges
          WHERE to_station_id IS NOT NULL AND trim(to_station_id) <> ''
        ),
        station_metrics AS (
          SELECT
            COUNT(*) AS row_count,
            COUNT(DISTINCT CASE WHEN station_id IS NOT NULL AND trim(station_id) <> '' THEN trim(station_id) END) AS key_card,
            SUM(CASE WHEN station_id IS NULL OR trim(station_id) = '' OR name IS NULL OR trim(name) = '' OR lat IS NULL OR lng IS NULL THEN 1 ELSE 0 END) AS null_count,
            SUM(CASE WHEN lat IS NULL OR lng IS NULL OR lat < ${SOUTH_KOREA_BOUNDS.minLat} OR lat > ${SOUTH_KOREA_BOUNDS.maxLat} OR lng < ${SOUTH_KOREA_BOUNDS.minLng} OR lng > ${SOUTH_KOREA_BOUNDS.maxLng} THEN 1 ELSE 0 END) AS oob_count
          FROM stations
        ),
        isolated_metrics AS (
          SELECT COUNT(*) AS isolated_count
          FROM valid_station_ids s
          LEFT JOIN connected_station_ids c ON c.station_id = s.station_id
          WHERE c.station_id IS NULL
        ),
        edge_metrics AS (
          SELECT
            COUNT(*) AS row_count,
            SUM(CASE WHEN from_station_id IS NOT NULL AND to_station_id IS NOT NULL AND trim(from_station_id) <> '' AND trim(from_station_id) = trim(to_station_id) THEN 1 ELSE 0 END) AS self_loop_count
          FROM edges
        )
      SELECT
        station_metrics.row_count AS station_row_count,
        station_metrics.key_card AS station_key_card,
        COALESCE(station_metrics.null_count, 0) AS station_null_count,
        COALESCE(station_metrics.oob_count, 0) AS oob_count,
        isolated_metrics.isolated_count AS isolated_count,
        edge_metrics.row_count AS edge_row_count,
        COALESCE(edge_metrics.self_loop_count, 0) AS self_loop_count
      FROM station_metrics, isolated_metrics, edge_metrics
    `).get();
  }

  return {
    stations: readRows("stations"),
    lines: readRows("lines"),
    station_lines: readRows("station_lines"),
    edges: readRows("edges", "network_edges"),
    transfers: readRows("transfers"),
    timetables: readRows("timetables"),
    fares: readRows("fares"),
    facilities: readRows("facilities"),
    sqliteCteSummary,
  };
}

function normalizeTablesInput(input) {
  if (isSqliteDatabaseHandle(input)) {
    return extractSqliteProfileData(input);
  }
  if (isSqliteDatabaseHandle(input?.db)) {
    return extractSqliteProfileData(input.db);
  }
  const source = input?.tables && typeof input.tables === "object" ? input.tables : (input ?? {});
  return {
    stations: Array.isArray(source.stations) ? source.stations : [],
    lines: Array.isArray(source.lines) ? source.lines : [],
    station_lines: Array.isArray(source.station_lines) ? source.station_lines : [],
    edges: Array.isArray(source.edges)
      ? source.edges
      : Array.isArray(source.network_edges)
        ? source.network_edges
        : [],
    transfers: Array.isArray(source.transfers) ? source.transfers : [],
    timetables: Array.isArray(source.timetables) ? source.timetables : [],
    fares: Array.isArray(source.fares) ? source.fares : [],
    facilities: Array.isArray(source.facilities) ? source.facilities : [],
    sqliteCteSummary: null,
  };
}

function evaluateStationsTable(rows) {
  const seenKeys = new Set();
  let nullOrEmptyCount = 0;
  let duplicateKeyCount = 0;
  let outOfKoreaBoundsCoordCount = 0;
  const latValues = [];
  const lngValues = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] ?? {};
    const stationId = normalizeStringField(row.station_id ?? row.id);
    const stationName = normalizeStringField(row.name ?? row.station_name);
    const lat = typeof row.lat === "number" ? row.lat : Number(row.lat);
    const lng = typeof row.lng === "number" ? row.lng : Number(row.lng);

    if (!stationId || !stationName || row.lat === null || row.lat === undefined || row.lng === null || row.lng === undefined || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      nullOrEmptyCount += 1;
    }
    if (stationId) {
      if (seenKeys.has(stationId)) duplicateKeyCount += 1;
      else seenKeys.add(stationId);
    }
    if (isOutOfSouthKoreaBounds(lat, lng)) {
      outOfKoreaBoundsCoordCount += 1;
    }
    latValues.push(row.lat);
    lngValues.push(row.lng);
  }

  return {
    summary: {
      rowCount: rows.length,
      keyCardinality: seenKeys.size,
      nullOrEmptyCount,
      duplicateKeyCount,
      orphanFkCount: 0,
    },
    stationIds: seenKeys,
    outOfKoreaBoundsCoordCount,
    latValues,
    lngValues,
  };
}

function evaluateLinesTable(rows) {
  const seenKeys = new Set();
  let nullOrEmptyCount = 0;
  let duplicateKeyCount = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] ?? {};
    const lineId = normalizeStringField(row.line_id ?? row.id);
    const lineName = normalizeStringField(row.name ?? row.line_name);
    if (!lineId || !lineName) {
      nullOrEmptyCount += 1;
    }
    if (lineId) {
      if (seenKeys.has(lineId)) duplicateKeyCount += 1;
      else seenKeys.add(lineId);
    }
  }

  return {
    summary: {
      rowCount: rows.length,
      keyCardinality: seenKeys.size,
      nullOrEmptyCount,
      duplicateKeyCount,
      orphanFkCount: 0,
    },
    lineIds: seenKeys,
  };
}

function evaluateStationLinesTable(rows, stationIds, lineIds, connectedStationIds) {
  const seenKeys = new Set();
  let nullOrEmptyCount = 0;
  let duplicateKeyCount = 0;
  let orphanFkCount = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] ?? {};
    const stationId = normalizeStringField(row.station_id);
    const lineId = normalizeStringField(row.line_id);
    if (!stationId || !lineId) {
      nullOrEmptyCount += 1;
      continue;
    }
    connectedStationIds.add(stationId);
    const compositeKey = `${stationId}:${lineId}`;
    if (seenKeys.has(compositeKey)) duplicateKeyCount += 1;
    else seenKeys.add(compositeKey);
    if (!stationIds.has(stationId) || !lineIds.has(lineId)) {
      orphanFkCount += 1;
    }
  }

  return {
    rowCount: rows.length,
    keyCardinality: seenKeys.size,
    nullOrEmptyCount,
    duplicateKeyCount,
    orphanFkCount,
  };
}

function evaluateEdgesTable(rows, stationIds, lineIds, connectedStationIds) {
  const seenKeys = new Set();
  let nullOrEmptyCount = 0;
  let duplicateKeyCount = 0;
  let orphanFkCount = 0;
  let selfLoopEdgeCount = 0;
  const travelSecondsValues = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] ?? {};
    const fromStationId = normalizeStringField(row.from_station_id);
    const toStationId = normalizeStringField(row.to_station_id);
    const lineId = normalizeStringField(row.line_id);
    const explicitId = normalizeStringField(row.edge_id ?? row.id);
    const key = explicitId || (fromStationId && toStationId && lineId ? `${fromStationId}:${toStationId}:${lineId}` : "");
    const travelSeconds = row.travel_seconds;

    if (fromStationId) connectedStationIds.add(fromStationId);
    if (toStationId) connectedStationIds.add(toStationId);

    if (!fromStationId || !toStationId || !lineId || travelSeconds === null || travelSeconds === undefined || !Number.isFinite(Number(travelSeconds))) {
      nullOrEmptyCount += 1;
    }
    if (key) {
      if (seenKeys.has(key)) duplicateKeyCount += 1;
      else seenKeys.add(key);
    }
    if (fromStationId && toStationId && fromStationId === toStationId) {
      selfLoopEdgeCount += 1;
    }
    if (
      (fromStationId && !stationIds.has(fromStationId))
      || (toStationId && !stationIds.has(toStationId))
      || (lineId && !lineIds.has(lineId))
    ) {
      orphanFkCount += 1;
    }
    travelSecondsValues.push(travelSeconds);
  }

  return {
    summary: {
      rowCount: rows.length,
      keyCardinality: seenKeys.size,
      nullOrEmptyCount,
      duplicateKeyCount,
      orphanFkCount,
    },
    selfLoopEdgeCount,
    travelSecondsValues,
  };
}

function evaluateTransfersTable(rows, stationIds, lineIds) {
  const seenKeys = new Set();
  let nullOrEmptyCount = 0;
  let duplicateKeyCount = 0;
  let orphanFkCount = 0;
  let orphanTransferStationCount = 0;
  const walkDistanceValues = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] ?? {};
    const fromStationId = normalizeStringField(row.from_station_id);
    const toStationId = normalizeStringField(row.to_station_id);
    const fromLineId = normalizeStringField(row.from_line_id);
    const toLineId = normalizeStringField(row.to_line_id);
    const explicitId = normalizeStringField(row.transfer_id ?? row.id);
    const key = explicitId || (fromStationId && toStationId ? `${fromStationId}:${toStationId}:${fromLineId}:${toLineId}` : "");
    const walkDistance = row.transfer_walk_distance_m;

    if (!fromStationId || !toStationId || walkDistance === null || walkDistance === undefined || !Number.isFinite(Number(walkDistance))) {
      nullOrEmptyCount += 1;
    }
    if (key) {
      if (seenKeys.has(key)) duplicateKeyCount += 1;
      else seenKeys.add(key);
    }
    const stationMissing = (fromStationId && !stationIds.has(fromStationId)) || (toStationId && !stationIds.has(toStationId));
    const lineMissing = (fromLineId && !lineIds.has(fromLineId)) || (toLineId && !lineIds.has(toLineId));
    if (stationMissing) {
      orphanTransferStationCount += 1;
    }
    if (stationMissing || lineMissing) {
      orphanFkCount += 1;
    }
    walkDistanceValues.push(walkDistance);
  }

  return {
    summary: {
      rowCount: rows.length,
      keyCardinality: seenKeys.size,
      nullOrEmptyCount,
      duplicateKeyCount,
      orphanFkCount,
    },
    orphanTransferStationCount,
    walkDistanceValues,
  };
}

function evaluateTimetablesTable(rows, stationIds, lineIds) {
  const seenKeys = new Set();
  let nullOrEmptyCount = 0;
  let duplicateKeyCount = 0;
  let orphanFkCount = 0;
  let invertedTimetableOrNegativeIntervalCount = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] ?? {};
    const stationId = normalizeStringField(row.station_id);
    const lineId = normalizeStringField(row.line_id);
    const dayType = normalizeStringField(row.day_type) || "ALL";
    const directionId = normalizeStringField(row.direction_id) || "ALL";
    const explicitId = normalizeStringField(row.timetable_id ?? row.id);
    const firstSec = parseTimeSeconds(row.first_departure_sec ?? row.first_train_sec ?? row.first_time);
    const lastSec = parseTimeSeconds(row.last_departure_sec ?? row.last_train_sec ?? row.last_time);
    const intervalRaw = row.headway_seconds ?? row.stop_interval_seconds ?? row.interval_seconds;
    const intervalSec = intervalRaw === undefined || intervalRaw === null ? 60 : Number(intervalRaw);
    const key = explicitId || (stationId && lineId ? `${lineId}:${stationId}:${dayType}:${directionId}:${firstSec ?? ""}:${lastSec ?? ""}` : "");

    if (!stationId || !lineId || firstSec === null || lastSec === null) {
      nullOrEmptyCount += 1;
    }
    if (key) {
      if (seenKeys.has(key)) duplicateKeyCount += 1;
      else seenKeys.add(key);
    }
    if ((stationId && !stationIds.has(stationId)) || (lineId && !lineIds.has(lineId))) {
      orphanFkCount += 1;
    }
    if (
      (firstSec !== null && lastSec !== null && firstSec > lastSec)
      || !Number.isFinite(intervalSec)
      || intervalSec <= 0
    ) {
      invertedTimetableOrNegativeIntervalCount += 1;
    }
  }

  return {
    summary: {
      rowCount: rows.length,
      keyCardinality: seenKeys.size,
      nullOrEmptyCount,
      duplicateKeyCount,
      orphanFkCount,
    },
    invertedTimetableOrNegativeIntervalCount,
  };
}

function evaluateFaresTable(rows, stationIds) {
  const seenKeys = new Set();
  let nullOrEmptyCount = 0;
  let duplicateKeyCount = 0;
  let orphanFkCount = 0;
  const fareValues = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] ?? {};
    const fromStationId = normalizeStringField(row.from_station_id);
    const toStationId = normalizeStringField(row.to_station_id);
    const explicitId = normalizeStringField(row.fare_id ?? row.id);
    const key = explicitId || (fromStationId && toStationId ? `${fromStationId}:${toStationId}` : "");
    const fareKrw = row.fare_krw;

    if (!fromStationId || !toStationId || fareKrw === null || fareKrw === undefined || !Number.isFinite(Number(fareKrw))) {
      nullOrEmptyCount += 1;
    }
    if (key) {
      if (seenKeys.has(key)) duplicateKeyCount += 1;
      else seenKeys.add(key);
    }
    if ((fromStationId && !stationIds.has(fromStationId)) || (toStationId && !stationIds.has(toStationId))) {
      orphanFkCount += 1;
    }
    fareValues.push(fareKrw);
  }

  return {
    summary: {
      rowCount: rows.length,
      keyCardinality: seenKeys.size,
      nullOrEmptyCount,
      duplicateKeyCount,
      orphanFkCount,
    },
    fareValues,
  };
}

function evaluateFacilitiesTable(rows, stationIds) {
  const seenKeys = new Set();
  let nullOrEmptyCount = 0;
  let duplicateKeyCount = 0;
  let orphanFkCount = 0;
  let orphanFacilityStationCount = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] ?? {};
    const facilityId = normalizeStringField(row.facility_id ?? row.id);
    const stationId = normalizeStringField(row.station_id);
    const facilityType = normalizeStringField(row.facility_type ?? row.type);

    if (!facilityId || !stationId || !facilityType) {
      nullOrEmptyCount += 1;
    }
    if (facilityId) {
      if (seenKeys.has(facilityId)) duplicateKeyCount += 1;
      else seenKeys.add(facilityId);
    }
    if (stationId && !stationIds.has(stationId)) {
      orphanFkCount += 1;
      orphanFacilityStationCount += 1;
    }
  }

  return {
    summary: {
      rowCount: rows.length,
      keyCardinality: seenKeys.size,
      nullOrEmptyCount,
      duplicateKeyCount,
      orphanFkCount,
    },
    orphanFacilityStationCount,
  };
}

function symmetricSetDifferenceCount(baseSet, otherSet) {
  let diff = 0;
  for (const item of baseSet) {
    if (!otherSet.has(item)) diff += 1;
  }
  for (const item of otherSet) {
    if (!baseSet.has(item)) diff += 1;
  }
  return diff;
}

function evaluateThreeArtifactParity({ artifactsInput, defaultTargetVersion, datapackStationIds, datapackLineIds }) {
  const raw = artifactsInput && typeof artifactsInput === "object" ? artifactsInput : {};
  const datapackDesc = raw.datapack ?? {
    targetVersion: defaultTargetVersion,
    stationIds: [...datapackStationIds],
    lineIds: [...datapackLineIds],
  };
  const bundleDesc = raw["server-route-bundle"] ?? raw.serverRouteBundle ?? null;
  const catalogDesc = raw["map-catalog"] ?? raw.mapCatalog ?? null;

  const descriptors = {
    datapack: datapackDesc,
    "server-route-bundle": bundleDesc,
    "map-catalog": catalogDesc,
  };

  const presentArtifacts = ARTIFACT_KEYS.filter((key) => descriptors[key] && typeof descriptors[key] === "object");
  const completeThreeArtifactSet = presentArtifacts.length === ARTIFACT_KEYS.length;

  const targetVersions = {};
  const stationSets = {};
  const lineSets = {};
  const stationIdCountByArtifact = {};
  const lineIdCountByArtifact = {};

  for (const key of ARTIFACT_KEYS) {
    const desc = descriptors[key];
    if (!desc) {
      targetVersions[key] = null;
      stationIdCountByArtifact[key] = 0;
      lineIdCountByArtifact[key] = 0;
      continue;
    }
    targetVersions[key] = normalizeStringField(desc.targetVersion) || null;
    const stSet = new Set((desc.stationIds ?? []).map(normalizeStringField).filter(Boolean));
    const lnSet = new Set((desc.lineIds ?? []).map(normalizeStringField).filter(Boolean));
    stationSets[key] = stSet;
    lineSets[key] = lnSet;
    stationIdCountByArtifact[key] = stSet.size;
    lineIdCountByArtifact[key] = lnSet.size;
  }

  const baseVersion = targetVersions.datapack;
  const targetVersionAligned = Boolean(baseVersion)
    && presentArtifacts.every((key) => targetVersions[key] === baseVersion);

  let stationIdDiffCount = 0;
  let lineIdDiffCount = 0;
  const baseStations = stationSets.datapack ?? datapackStationIds;
  const baseLines = lineSets.datapack ?? datapackLineIds;

  for (const key of presentArtifacts) {
    if (key === "datapack") continue;
    stationIdDiffCount += symmetricSetDifferenceCount(baseStations, stationSets[key]);
    lineIdDiffCount += symmetricSetDifferenceCount(baseLines, lineSets[key]);
  }

  const aligned = completeThreeArtifactSet
    && targetVersionAligned
    && stationIdDiffCount === 0
    && lineIdDiffCount === 0;

  return {
    presentArtifacts,
    completeThreeArtifactSet,
    targetVersions,
    targetVersionAligned,
    stationIdCountByArtifact,
    lineIdCountByArtifact,
    stationIdDiffCount,
    lineIdDiffCount,
    aligned,
  };
}

export function buildArtifactSemanticProfile(input, options = {}) {
  const tablesData = normalizeTablesInput(input);
  const targetVersion = normalizeStringField(
    options.targetVersion
    ?? input?.targetVersion
    ?? options.artifacts?.datapack?.targetVersion
    ?? input?.artifacts?.datapack?.targetVersion
    ?? "unknown",
  );
  const artifactsInput = options.artifacts ?? input?.artifacts ?? null;

  const stationsEval = evaluateStationsTable(tablesData.stations);
  const linesEval = evaluateLinesTable(tablesData.lines);
  const connectedStationIds = new Set();
  const stationLinesSummary = evaluateStationLinesTable(
    tablesData.station_lines,
    stationsEval.stationIds,
    linesEval.lineIds,
    connectedStationIds,
  );
  const edgesEval = evaluateEdgesTable(
    tablesData.edges,
    stationsEval.stationIds,
    linesEval.lineIds,
    connectedStationIds,
  );
  const transfersEval = evaluateTransfersTable(
    tablesData.transfers,
    stationsEval.stationIds,
    linesEval.lineIds,
  );
  const timetablesEval = evaluateTimetablesTable(
    tablesData.timetables,
    stationsEval.stationIds,
    linesEval.lineIds,
  );
  const faresEval = evaluateFaresTable(tablesData.fares, stationsEval.stationIds);
  const facilitiesEval = evaluateFacilitiesTable(tablesData.facilities, stationsEval.stationIds);

  let isolatedStationCount = 0;
  for (const stationId of stationsEval.stationIds) {
    if (!connectedStationIds.has(stationId)) {
      isolatedStationCount += 1;
    }
  }
  if (tablesData.sqliteCteSummary) {
    isolatedStationCount = Number(tablesData.sqliteCteSummary.isolated_count);
  }

  const tables = {
    stations: stationsEval.summary,
    lines: linesEval.summary,
    station_lines: stationLinesSummary,
    edges: edgesEval.summary,
    transfers: transfersEval.summary,
    timetables: timetablesEval.summary,
    fares: faresEval.summary,
    facilities: facilitiesEval.summary,
  };

  let totalNullOrEmptyCount = 0;
  let totalDuplicateKeyCount = 0;
  let totalOrphanFkCount = 0;
  for (const tableName of CANONICAL_TABLES) {
    totalNullOrEmptyCount += tables[tableName].nullOrEmptyCount;
    totalDuplicateKeyCount += tables[tableName].duplicateKeyCount;
    totalOrphanFkCount += tables[tableName].orphanFkCount;
  }

  const distributions = {
    travel_seconds: computeNumericDistribution(edgesEval.travelSecondsValues),
    transfer_walk_distance_m: computeNumericDistribution(transfersEval.walkDistanceValues),
    fare_krw: computeNumericDistribution(faresEval.fareValues),
    lat: computeNumericDistribution(stationsEval.latValues),
    lng: computeNumericDistribution(stationsEval.lngValues),
  };

  const domainViolationTotal =
    edgesEval.selfLoopEdgeCount
    + isolatedStationCount
    + stationsEval.outOfKoreaBoundsCoordCount
    + timetablesEval.invertedTimetableOrNegativeIntervalCount
    + facilitiesEval.orphanFacilityStationCount
    + transfersEval.orphanTransferStationCount
    + totalNullOrEmptyCount
    + totalDuplicateKeyCount
    + totalOrphanFkCount;

  const domainInvariants = {
    selfLoopEdgeCount: edgesEval.selfLoopEdgeCount,
    isolatedStationCount,
    outOfKoreaBoundsCoordCount: stationsEval.outOfKoreaBoundsCoordCount,
    invertedTimetableOrNegativeIntervalCount: timetablesEval.invertedTimetableOrNegativeIntervalCount,
    orphanFacilityStationCount: facilitiesEval.orphanFacilityStationCount,
    orphanTransferStationCount: transfersEval.orphanTransferStationCount,
    totalViolationCount: domainViolationTotal,
  };

  const artifactParity = evaluateThreeArtifactParity({
    artifactsInput,
    defaultTargetVersion: targetVersion,
    datapackStationIds: stationsEval.stationIds,
    datapackLineIds: linesEval.lineIds,
  });

  const payload = {
    schemaVersion: 1,
    artifactKind: "datapack-semantic-profile",
    targetVersion,
    tables,
    integrityTotals: {
      totalNullOrEmptyCount,
      totalDuplicateKeyCount,
      totalOrphanFkCount,
    },
    distributions,
    domainInvariants,
    artifactParity,
  };

  return {
    ...payload,
    profileSha256: sha256Hex(payload),
  };
}

function ensureProfile(input) {
  if (input?.artifactKind === "datapack-semantic-profile" && typeof input.profileSha256 === "string") {
    return input;
  }
  return buildArtifactSemanticProfile(input);
}

function indexWaivers(waivers) {
  const map = new Map();
  if (!Array.isArray(waivers)) return map;
  for (let index = 0; index < waivers.length; index += 1) {
    const waiver = waivers[index];
    if (!waiver || typeof waiver !== "object") continue;
    const ruleId = normalizeStringField(waiver.ruleId);
    const metricKey = normalizeStringField(waiver.metricKey);
    if (!ruleId || !metricKey) continue;
    map.set(`${ruleId}::${metricKey}`, waiver);
  }
  return map;
}

function evaluateWaiverForFinding(finding, waiverMap, evaluatedAtMs) {
  const key = `${finding.ruleId}::${finding.metricKey}`;
  const matchingWaiver = waiverMap.get(key) ?? null;

  if (!finding.waivable) {
    return {
      ...finding,
      disposition: "BLOCKED",
      appliedWaiver: null,
      waiverRejectedReason: matchingWaiver ? "UNWAIVABLE_INVARIANT" : null,
    };
  }

  if (!matchingWaiver) {
    return {
      ...finding,
      disposition: "BLOCKED",
      appliedWaiver: null,
      waiverRejectedReason: null,
    };
  }

  const expiresAtMs = Date.parse(matchingWaiver.expiresAt);
  const validOwnerIssue = Number.isInteger(matchingWaiver.ownerIssue) && matchingWaiver.ownerIssue > 0;
  const validReason = isNonEmptyString(matchingWaiver.reason);
  if (!validOwnerIssue || !validReason || !Number.isFinite(expiresAtMs)) {
    return {
      ...finding,
      disposition: "BLOCKED",
      appliedWaiver: null,
      waiverRejectedReason: "INVALID_WAIVER",
    };
  }

  if (expiresAtMs <= evaluatedAtMs) {
    return {
      ...finding,
      disposition: "BLOCKED",
      appliedWaiver: null,
      waiverRejectedReason: "WAIVER_EXPIRED",
    };
  }

  return {
    ...finding,
    disposition: "WAIVED_WITH_EVIDENCE",
    appliedWaiver: {
      ruleId: matchingWaiver.ruleId,
      metricKey: matchingWaiver.metricKey,
      ownerIssue: matchingWaiver.ownerIssue,
      reason: matchingWaiver.reason.trim(),
      expiresAt: matchingWaiver.expiresAt,
    },
    waiverRejectedReason: null,
  };
}

function collectHardInvariantFindings(candidate, policy) {
  const findings = [];
  const requiredTables = policy.requiredTables ?? CANONICAL_TABLES;

  for (const tableName of requiredTables) {
    const stats = candidate.tables[tableName];
    if (!stats || stats.rowCount === 0 || stats.keyCardinality === 0) {
      findings.push({
        ruleId: "REQUIRED_TABLE_EMPTY",
        metricKey: `table:${tableName}:rowCount`,
        waivable: false,
        baselineValue: null,
        candidateValue: stats?.rowCount ?? 0,
        message: `Required table ${tableName} is empty`,
      });
    }
    if (stats?.nullOrEmptyCount > 0) {
      findings.push({
        ruleId: "REQUIRED_COLUMN_NULL_OR_EMPTY",
        metricKey: `table:${tableName}:nullOrEmptyCount`,
        waivable: false,
        baselineValue: 0,
        candidateValue: stats.nullOrEmptyCount,
        message: `Table ${tableName} has ${stats.nullOrEmptyCount} null or empty required column(s)`,
      });
    }
    if (stats?.duplicateKeyCount > 0) {
      findings.push({
        ruleId: "DUPLICATE_PRIMARY_KEY",
        metricKey: `table:${tableName}:duplicateKeyCount`,
        waivable: false,
        baselineValue: 0,
        candidateValue: stats.duplicateKeyCount,
        message: `Table ${tableName} has ${stats.duplicateKeyCount} duplicate primary key(s)`,
      });
    }
    if (stats?.orphanFkCount > 0) {
      findings.push({
        ruleId: "ORPHAN_FOREIGN_KEY",
        metricKey: `table:${tableName}:orphanFkCount`,
        waivable: false,
        baselineValue: 0,
        candidateValue: stats.orphanFkCount,
        message: `Table ${tableName} has ${stats.orphanFkCount} orphan foreign key(s)`,
      });
    }
  }

  const inv = candidate.domainInvariants;
  const invariantRules = [
    ["DOMAIN_SELF_LOOP_EDGE", "selfLoopEdgeCount", "Self-loop edges detected"],
    ["DOMAIN_ISOLATED_STATION", "isolatedStationCount", "Isolated stations detected"],
    ["DOMAIN_COORD_OUT_OF_KOREA_BOUNDS", "outOfKoreaBoundsCoordCount", "Coordinates outside South Korea bounds detected"],
    ["DOMAIN_TIMETABLE_INVERTED_OR_NEGATIVE_INTERVAL", "invertedTimetableOrNegativeIntervalCount", "Inverted first/last train or non-positive interval detected"],
    ["DOMAIN_ORPHAN_FACILITY_STATION", "orphanFacilityStationCount", "Facilities referencing non-existent stations detected"],
    ["DOMAIN_ORPHAN_TRANSFER_STATION", "orphanTransferStationCount", "Transfers referencing non-existent stations detected"],
  ];

  for (const [ruleId, field, label] of invariantRules) {
    if (inv[field] > 0) {
      findings.push({
        ruleId,
        metricKey: `invariant:${field}`,
        waivable: false,
        baselineValue: 0,
        candidateValue: inv[field],
        message: `${label}: ${inv[field]}`,
      });
    }
  }

  if (policy.allowZeroOrNegativeMetrics === false) {
    for (const metricName of DISTRIBUTION_METRICS) {
      const dist = candidate.distributions[metricName];
      if (!dist) continue;
      const badCount = POSITIVE_DOMAIN_METRICS.has(metricName)
        ? dist.zeroCount + dist.negativeCount
        : dist.negativeCount;
      if (badCount > 0) {
        findings.push({
          ruleId: "METRIC_ZERO_OR_NEGATIVE",
          metricKey: `distribution:${metricName}:zeroOrNegativeCount`,
          waivable: false,
          baselineValue: 0,
          candidateValue: badCount,
          message: `Metric ${metricName} has ${badCount} zero or negative value(s)`,
        });
      }
    }
  }

  const shouldCheckParity = policy.requireThreeArtifactParity !== false
    && (candidate.artifactParity.presentArtifacts.length > 1 || policy.requireThreeArtifactParity === true);
  if (shouldCheckParity && !candidate.artifactParity.aligned) {
    findings.push({
      ruleId: "THREE_ARTIFACT_PARITY_MISMATCH",
      metricKey: "artifactParity:aligned",
      waivable: false,
      baselineValue: true,
      candidateValue: false,
      message: "3-artifact (datapack, server-route-bundle, map-catalog) version or station/line ID set mismatch",
    });
  }

  return findings;
}

function collectReleaseDiffFindings(baseline, candidate, policy) {
  const findings = [];
  const tableDiffs = {};
  const distributionDiffs = {};

  for (const tableName of CANONICAL_TABLES) {
    const baseStats = baseline.tables[tableName];
    const candStats = candidate.tables[tableName];
    const baseRows = baseStats?.rowCount ?? 0;
    const candRows = candStats?.rowCount ?? 0;
    const rowDelta = candRows - baseRows;
    const rowChangeRatio = baseRows > 0 ? Number((rowDelta / baseRows).toFixed(6)) : null;

    const baseCard = baseStats?.keyCardinality ?? 0;
    const candCard = candStats?.keyCardinality ?? 0;
    const cardDelta = candCard - baseCard;
    const cardChangeRatio = baseCard > 0 ? Number((cardDelta / baseCard).toFixed(6)) : null;

    tableDiffs[tableName] = {
      baselineRowCount: baseRows,
      candidateRowCount: candRows,
      rowDelta,
      rowChangeRatio,
      baselineKeyCardinality: baseCard,
      candidateKeyCardinality: candCard,
      keyCardinalityDelta: cardDelta,
      keyCardinalityChangeRatio: cardChangeRatio,
    };

    if (baseRows > 0 && candRows < baseRows) {
      const dropRatio = (baseRows - candRows) / baseRows;
      if (dropRatio > policy.maxRowDropRatio) {
        findings.push({
          ruleId: "TABLE_ROW_DROP",
          metricKey: `table:${tableName}:rowCount`,
          waivable: true,
          baselineValue: baseRows,
          candidateValue: candRows,
          observedRatio: Number(dropRatio.toFixed(6)),
          thresholdRatio: policy.maxRowDropRatio,
          message: `Table ${tableName} rowCount dropped by ${(dropRatio * 100).toFixed(2)}%`,
        });
      }
    } else if (baseRows > 0 && candRows > baseRows) {
      const spikeRatio = (candRows - baseRows) / baseRows;
      if (spikeRatio > policy.maxRowSpikeRatio) {
        findings.push({
          ruleId: "TABLE_ROW_SPIKE",
          metricKey: `table:${tableName}:rowCount`,
          waivable: true,
          baselineValue: baseRows,
          candidateValue: candRows,
          observedRatio: Number(spikeRatio.toFixed(6)),
          thresholdRatio: policy.maxRowSpikeRatio,
          message: `Table ${tableName} rowCount spiked by ${(spikeRatio * 100).toFixed(2)}%`,
        });
      }
    }
  }

  for (const metricName of DISTRIBUTION_METRICS) {
    const baseDist = baseline.distributions[metricName];
    const candDist = candidate.distributions[metricName];
    const baseP50 = baseDist?.p50;
    const candP50 = candDist?.p50;
    const baseP95 = baseDist?.p95;
    const candP95 = candDist?.p95;

    const p50ShiftRatio =
      Number.isFinite(baseP50) && baseP50 !== 0 && Number.isFinite(candP50)
        ? Number((Math.abs(candP50 - baseP50) / Math.abs(baseP50)).toFixed(6))
        : null;
    const p95ShiftRatio =
      Number.isFinite(baseP95) && baseP95 !== 0 && Number.isFinite(candP95)
        ? Number((Math.abs(candP95 - baseP95) / Math.abs(baseP95)).toFixed(6))
        : null;

    distributionDiffs[metricName] = {
      baselineP50: baseP50 ?? null,
      candidateP50: candP50 ?? null,
      p50ShiftRatio,
      baselineP95: baseP95 ?? null,
      candidateP95: candP95 ?? null,
      p95ShiftRatio,
    };

    if (p50ShiftRatio !== null && p50ShiftRatio > policy.maxMedianShiftRatio) {
      findings.push({
        ruleId: "DISTRIBUTION_P50_SHIFT",
        metricKey: `distribution:${metricName}:p50`,
        waivable: true,
        baselineValue: baseP50,
        candidateValue: candP50,
        observedRatio: p50ShiftRatio,
        thresholdRatio: policy.maxMedianShiftRatio,
        message: `Distribution ${metricName} p50 shifted by ${(p50ShiftRatio * 100).toFixed(2)}%`,
      });
    }

    if (p95ShiftRatio !== null && p95ShiftRatio > policy.maxP95ShiftRatio) {
      findings.push({
        ruleId: "DISTRIBUTION_P95_SHIFT",
        metricKey: `distribution:${metricName}:p95`,
        waivable: true,
        baselineValue: baseP95,
        candidateValue: candP95,
        observedRatio: p95ShiftRatio,
        thresholdRatio: policy.maxP95ShiftRatio,
        message: `Distribution ${metricName} p95 shifted by ${(p95ShiftRatio * 100).toFixed(2)}%`,
      });
    }
  }

  return { findings, tableDiffs, distributionDiffs };
}

export function evaluateArtifactSemanticDrift({
  baseline,
  candidate,
  policy = {},
  waivers = [],
  evaluatedAt = "1970-01-01T00:00:00.000Z",
} = {}) {
  if (!baseline || !candidate) {
    throw new Error("baseline and candidate semantic profiles or snapshots are required");
  }
  const evaluatedAtMs = Date.parse(evaluatedAt);
  if (!Number.isFinite(evaluatedAtMs)) {
    throw new Error("valid ISO evaluatedAt timestamp is required");
  }

  const resolvedPolicy = { ...DEFAULT_DRIFT_POLICY, ...policy };
  const baselineProfile = ensureProfile(baseline);
  const candidateProfile = ensureProfile(candidate);
  const waiverMap = indexWaivers(waivers);

  const hardFindings = collectHardInvariantFindings(candidateProfile, resolvedPolicy);
  const { findings: diffFindings, tableDiffs, distributionDiffs } = collectReleaseDiffFindings(
    baselineProfile,
    candidateProfile,
    resolvedPolicy,
  );

  const evaluatedFindings = [...hardFindings, ...diffFindings].map((finding) =>
    evaluateWaiverForFinding(finding, waiverMap, evaluatedAtMs),
  );

  const blockedCount = evaluatedFindings.filter((item) => item.disposition === "BLOCKED").length;
  const waivedCount = evaluatedFindings.filter((item) => item.disposition === "WAIVED_WITH_EVIDENCE").length;
  const status = blockedCount > 0 ? "FAIL" : waivedCount > 0 ? "WAIVED_WITH_EVIDENCE" : "PASS";
  const blocking = blockedCount > 0;

  const payload = {
    schemaVersion: 1,
    artifactKind: "datapack-semantic-drift-evaluation",
    issue: 87,
    evaluatedAt,
    status,
    blocking,
    baselineProfileSha256: baselineProfile.profileSha256,
    candidateProfileSha256: candidateProfile.profileSha256,
    policy: resolvedPolicy,
    summary: {
      totalFindingCount: evaluatedFindings.length,
      blockedFindingCount: blockedCount,
      waivedFindingCount: waivedCount,
    },
    releaseDiff: {
      baselineTargetVersion: baselineProfile.targetVersion,
      candidateTargetVersion: candidateProfile.targetVersion,
      tables: tableDiffs,
      distributions: distributionDiffs,
    },
    findings: evaluatedFindings,
  };

  return {
    ...payload,
    evaluationSha256: sha256Hex(payload),
  };
}
