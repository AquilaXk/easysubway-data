#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

const severityRank = new Map([
  ["BLOCKER", 0],
  ["HIGH", 1],
  ["MEDIUM", 2],
  ["LOW", 3],
  ["INFO", 4],
]);

function usage() {
  return `Usage: node tools/route-map/audit-route-map.mjs --fixture <catalog-fixture.json> [--reviewed-ambiguities reviewed.json] [--fail-on BLOCKER,HIGH] [--pretty]

Audits routeMapPositions against stationLines so production route-map coordinate
coverage can be checked before rebuilding datapacks.`;
}

function parseArgs(argv) {
  const options = {
    fixture: null,
    reviewedAmbiguities: null,
    failOn: [],
    pretty: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--fixture":
        options.fixture = argv[++index];
        break;
      case "--reviewed-ambiguities":
        options.reviewedAmbiguities = argv[++index];
        break;
      case "--fail-on":
        options.failOn = (argv[++index] ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        break;
      case "--pretty":
        options.pretty = true;
        break;
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.fixture) {
    throw new Error("--fixture is required");
  }
  for (const severity of options.failOn) {
    if (!severityRank.has(severity)) {
      throw new Error(`Unknown severity in --fail-on: ${severity}`);
    }
  }
  return options;
}

function stationLineKeyFor(row) {
  return `${row.stationId ?? ""}\u0000${row.lineId ?? ""}`;
}

function routeMapPositionKeyFor(row) {
  return `${row.stationId ?? ""}\u0000${row.lineId ?? ""}\u0000${row.region ?? ""}`;
}

function duplicateCoordinateKeyFor({ region, lineId, x, y, stationIds }) {
  return [
    normalizedText(region),
    normalizedText(lineId),
    Number(x),
    Number(y),
    ...stationIds.map(normalizedText).sort(),
  ].join("\u0000");
}

function normalizedText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedStationLabel(value) {
  return normalizedText(value)
    .normalize("NFKC")
    .replace(/\([^)]*\)/gu, "")
    .replace(/\[[^\]]*\]/gu, "")
    .replace(/[·ㆍ･.\s]/gu, "")
    .replace(/역$/u, "");
}

function addFinding(findings, finding) {
  findings.push({
    severity: finding.severity,
    code: finding.code,
    packId: finding.packId,
    region: finding.region ?? "",
    lineId: finding.lineId ?? "",
    stationId: finding.stationId ?? "",
    message: finding.message,
  });
}

function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonNegativeFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function polygonArea(points) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return Math.abs(area / 2);
}

function polygonBounds(points) {
  return points.reduce(
    (bounds, point) => ({
      minX: Math.min(bounds.minX, point.x),
      minY: Math.min(bounds.minY, point.y),
      maxX: Math.max(bounds.maxX, point.x),
      maxY: Math.max(bounds.maxY, point.y),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
}

function boundsOverlap(a, b) {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

function labelPolygonError(value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  if (!Array.isArray(value) || value.length < 3) {
    return "labelPolygon must be a polygon with at least three points.";
  }
  for (const [index, point] of value.entries()) {
    if (!point || typeof point !== "object" || Array.isArray(point)) {
      return `labelPolygon[${index}] must be an object point.`;
    }
    if (!isNonNegativeFiniteNumber(point.x) || !isNonNegativeFiniteNumber(point.y)) {
      return `labelPolygon[${index}] must contain finite non-negative x/y.`;
    }
  }
  if (polygonArea(value) <= 0) {
    return "labelPolygon area must be greater than 0.";
  }
  return "";
}

function coverageRatio(coveredCount, totalCount) {
  return totalCount === 0
    ? 1
    : Number((coveredCount / totalCount).toFixed(4));
}

function regionCoverageSummaries(stationLines, positions) {
  const lineIdsByRegion = new Map();
  const positionKeysByRegion = new Map();
  for (const position of positions) {
    const region = normalizedText(position.region);
    const lineId = normalizedText(position.lineId);
    if (!region || !lineId) {
      continue;
    }
    const lineIds = lineIdsByRegion.get(region) ?? new Set();
    lineIds.add(lineId);
    lineIdsByRegion.set(region, lineIds);

    const keys = positionKeysByRegion.get(region) ?? new Set();
    keys.add(stationLineKeyFor(position));
    positionKeysByRegion.set(region, keys);
  }

  return [...lineIdsByRegion.entries()]
    .map(([region, lineIds]) => {
      const stationLineKeys = stationLines
        .filter((row) => lineIds.has(normalizedText(row.lineId)))
        .map(stationLineKeyFor);
      const positionKeys = positionKeysByRegion.get(region) ?? new Set();
      const coveredCount = stationLineKeys.filter((key) =>
        positionKeys.has(key),
      ).length;
      return {
        region,
        stationLineCount: stationLineKeys.length,
        routeMapPositionCount: positionKeys.size,
        coveredStationLineCount: coveredCount,
        coverageRatio: coverageRatio(coveredCount, stationLineKeys.length),
      };
    })
    .sort((a, b) => a.region.localeCompare(b.region));
}

function reviewedAmbiguityEntries(raw) {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (Array.isArray(raw?.reviewedAmbiguities)) {
    return raw.reviewedAmbiguities;
  }
  throw new Error(
    "reviewed ambiguities must be an array or contain reviewedAmbiguities array",
  );
}

function parseReviewedAmbiguities(raw) {
  const reviewed = new Map();
  for (const [index, entry] of reviewedAmbiguityEntries(raw).entries()) {
    const region = normalizedText(entry?.region);
    const lineId = normalizedText(entry?.lineId);
    const reason = normalizedText(entry?.reason);
    const reviewedAt = normalizedText(entry?.reviewedAt);
    const reviewedBy = normalizedText(entry?.reviewedBy);
    const reviewSource = normalizedText(entry?.reviewSource);
    const stationIds = Array.isArray(entry?.stationIds)
      ? entry.stationIds.map(normalizedText).filter(Boolean)
      : [];
    const x = Number(entry?.x);
    const y = Number(entry?.y);
    if (!region || !lineId || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(
        `reviewedAmbiguities[${index}] must include region, lineId, x, and y`,
      );
    }
    if (stationIds.length < 2) {
      throw new Error(
        `reviewedAmbiguities[${index}].stationIds must include at least two station ids`,
      );
    }
    if (!reason || !reviewedAt || !reviewedBy || !reviewSource) {
      throw new Error(
        `reviewedAmbiguities[${index}] must include reason, reviewedAt, reviewedBy, and reviewSource`,
      );
    }
    reviewed.set(
      duplicateCoordinateKeyFor({ region, lineId, x, y, stationIds }),
      {
        region,
        lineId,
        x,
        y,
        stationIds: stationIds.sort(),
        reason,
        reviewedAt,
        reviewedBy,
        reviewSource,
      },
    );
  }
  return reviewed;
}

function auditPack(pack, reviewedAmbiguities) {
  const findings = [];
  const stationsById = new Map(
    (Array.isArray(pack.stations) ? pack.stations : []).map((station) => [
      normalizedText(station.id),
      station,
    ]),
  );
  const stationLines = Array.isArray(pack.stationLines) ? pack.stationLines : [];
  const positions = Array.isArray(pack.routeMapPositions)
    ? pack.routeMapPositions
    : [];
  const stationLineKeys = new Set(stationLines.map(stationLineKeyFor));
  const positionKeys = new Set();
  const positionedStationLineKeys = new Set();
  const coordinateGroups = new Map();
  const labelPolygons = [];

  for (const position of positions) {
    const key = routeMapPositionKeyFor(position);
    const stationLineKey = stationLineKeyFor(position);
    if (positionKeys.has(key)) {
      addFinding(findings, {
        severity: "BLOCKER",
        code: "DUPLICATE_ROUTE_MAP_POSITION",
        packId: pack.id,
        region: position.region,
        lineId: position.lineId,
        stationId: position.stationId,
        message: "routeMapPositions has duplicate stationId/lineId rows.",
      });
    }
    positionKeys.add(key);
    positionedStationLineKeys.add(stationLineKey);

    if (!isNonNegativeInteger(position.x) || !isNonNegativeInteger(position.y)) {
      addFinding(findings, {
        severity: "BLOCKER",
        code: "INVALID_ROUTE_MAP_COORDINATE",
        packId: pack.id,
        region: position.region,
        lineId: position.lineId,
        stationId: position.stationId,
        message: "routeMapPositions x/y must be finite non-negative integers.",
      });
    }

    const polygonError = labelPolygonError(position.labelPolygon);
    if (polygonError) {
      addFinding(findings, {
        severity: "BLOCKER",
        code: "INVALID_ROUTE_MAP_LABEL_POLYGON",
        packId: pack.id,
        region: position.region,
        lineId: position.lineId,
        stationId: position.stationId,
        message: polygonError,
      });
    } else if (Array.isArray(position.labelPolygon) && position.labelPolygon.length >= 3) {
      labelPolygons.push({
        position,
        bounds: polygonBounds(position.labelPolygon),
      });
    }

    if (!stationLineKeys.has(stationLineKey)) {
      addFinding(findings, {
        severity: "BLOCKER",
        code: "ROUTE_MAP_POSITION_WITHOUT_STATION_LINE",
        packId: pack.id,
        region: position.region,
        lineId: position.lineId,
        stationId: position.stationId,
        message:
          "routeMapPositions row does not match a stationLines membership.",
      });
    }

    const sourceFields = [
      ["sourceId", position.sourceId],
      ["sourceName", position.sourceName],
      ["sourceUrl", position.sourceUrl],
      ["licenseStatus", position.licenseStatus],
    ].filter(([, value]) => normalizedText(value) === "");
    if (sourceFields.length > 0) {
      addFinding(findings, {
        severity: "HIGH",
        code: "MISSING_ROUTE_MAP_SOURCE",
        packId: pack.id,
        region: position.region,
        lineId: position.lineId,
        stationId: position.stationId,
        message: `routeMapPositions source fields are missing: ${sourceFields
          .map(([name]) => name)
          .join(", ")}.`,
      });
    }

    if (!/^[a-f0-9]{64}$/.test(normalizedText(position.sourceSha256))) {
      addFinding(findings, {
        severity: "HIGH",
        code: "MISSING_ROUTE_MAP_SOURCE_SHA",
        packId: pack.id,
        region: position.region,
        lineId: position.lineId,
        stationId: position.stationId,
        message:
          "routeMapPositions row must include a sourceSha256 for the coordinate source snapshot.",
      });
    }

    if (normalizedText(position.reviewedAt) === "") {
      addFinding(findings, {
        severity: "HIGH",
        code: "MISSING_ROUTE_MAP_REVIEW",
        packId: pack.id,
        region: position.region,
        lineId: position.lineId,
        stationId: position.stationId,
        message: "routeMapPositions row has no reviewedAt timestamp.",
      });
    }

    const sourceLabel = normalizedText(position.sourceLabel);
    if (sourceLabel !== "") {
      const stationName = stationsById.get(normalizedText(position.stationId))?.nameKo;
      if (
        normalizedStationLabel(sourceLabel) !==
        normalizedStationLabel(stationName)
      ) {
        addFinding(findings, {
          severity: "HIGH",
          code: "ROUTE_MAP_SOURCE_LABEL_MISMATCH",
          packId: pack.id,
          region: position.region,
          lineId: position.lineId,
          stationId: position.stationId,
          message:
            "routeMapPositions sourceLabel does not match the station name.",
        });
      }
    }

    const coordinateKey = [
      normalizedText(position.region),
      normalizedText(position.lineId),
      Number(position.x),
      Number(position.y),
    ].join("\u0000");
    const group = coordinateGroups.get(coordinateKey) ?? [];
    group.push(position);
    coordinateGroups.set(coordinateKey, group);
  }

  for (let leftIndex = 0; leftIndex < labelPolygons.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < labelPolygons.length; rightIndex += 1) {
      const left = labelPolygons[leftIndex];
      const right = labelPolygons[rightIndex];
      if (normalizedText(left.position.region) !== normalizedText(right.position.region)) {
        continue;
      }
      if (!boundsOverlap(left.bounds, right.bounds)) {
        continue;
      }
      addFinding(findings, {
        severity: "MEDIUM",
        code: "OVERLAPPING_ROUTE_MAP_LABEL_POLYGON",
        packId: pack.id,
        region: left.position.region,
        lineId: left.position.lineId,
        stationId: `${left.position.stationId},${right.position.stationId}`,
        message: "routeMapPositions labelPolygon bounding boxes overlap.",
      });
    }
  }

  for (const membership of stationLines) {
    if (positionedStationLineKeys.has(stationLineKeyFor(membership))) {
      continue;
    }
    addFinding(findings, {
      severity: "BLOCKER",
      code: "MISSING_ROUTE_MAP_POSITION",
      packId: pack.id,
      region: "",
      lineId: membership.lineId,
      stationId: membership.stationId,
      message:
        "stationLines membership has no matching routeMapPositions coordinate.",
    });
  }

  for (const group of coordinateGroups.values()) {
    const uniqueStationIds = new Set(group.map((row) => row.stationId));
    if (uniqueStationIds.size < 2) {
      continue;
    }
    const first = group[0];
    const stationIds = [...uniqueStationIds].sort();
    const ambiguityKey = duplicateCoordinateKeyFor({
      region: first.region,
      lineId: first.lineId,
      x: first.x,
      y: first.y,
      stationIds,
    });
    const reviewed = reviewedAmbiguities.get(ambiguityKey);
    if (reviewed != null) {
      addFinding(findings, {
        severity: "INFO",
        code: "REVIEWED_AMBIGUITY",
        packId: pack.id,
        region: first.region,
        lineId: first.lineId,
        stationId: stationIds.join(","),
        message: `Reviewed duplicate source coordinate: ${reviewed.reason} (${reviewed.reviewedAt}, ${reviewed.reviewedBy}, ${reviewed.reviewSource}).`,
      });
      continue;
    }
    addFinding(findings, {
      severity: "HIGH",
      code: "DUPLICATE_SOURCE_COORDINATE",
      packId: pack.id,
      region: first.region,
      lineId: first.lineId,
      stationId: stationIds.join(","),
      message:
        "Multiple stations share the same region/line/source coordinate and need explicit review.",
    });
  }

  const findingCounts = {};
  for (const severity of severityRank.keys()) {
    findingCounts[severity] = 0;
  }
  for (const finding of findings) {
    findingCounts[finding.severity] += 1;
  }

  return {
    id: pack.id ?? "",
    version: pack.version ?? "",
    summary: {
      stationLineCount: stationLines.length,
      routeMapPositionCount: positions.length,
      coveredStationLineCount: [...stationLineKeys].filter((key) =>
        positionedStationLineKeys.has(key),
      ).length,
      coverageRatio: coverageRatio(
        [...stationLineKeys].filter((key) => positionedStationLineKeys.has(key))
          .length,
        stationLines.length,
      ),
      regions: regionCoverageSummaries(stationLines, positions),
      findingsBySeverity: findingCounts,
    },
    findings: findings.sort((a, b) => {
      const severityDelta =
        severityRank.get(a.severity) - severityRank.get(b.severity);
      if (severityDelta !== 0) {
        return severityDelta;
      }
      return `${a.code}:${a.lineId}:${a.stationId}`.localeCompare(
        `${b.code}:${b.lineId}:${b.stationId}`,
      );
    }),
  };
}

function auditFixture(fixturePath, fixture, reviewedAmbiguities) {
  const packs = Array.isArray(fixture.packs) ? fixture.packs : [];
  const auditedPacks = packs.map((pack) =>
    auditPack(pack, reviewedAmbiguities),
  );
  const findings = auditedPacks.flatMap((pack) => pack.findings);
  const findingCounts = {};
  for (const severity of severityRank.keys()) {
    findingCounts[severity] = 0;
  }
  for (const finding of findings) {
    findingCounts[finding.severity] += 1;
  }
  return {
    schemaVersion: 1,
    artifactKind: "route-map-position-audit",
    source: path.normalize(fixturePath),
    summary: {
      packCount: auditedPacks.length,
      findingsBySeverity: findingCounts,
    },
    packs: auditedPacks,
    findings,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const fixtureText = await readFile(options.fixture, "utf8");
  const fixture = JSON.parse(fixtureText);
  const reviewedAmbiguities = options.reviewedAmbiguities
    ? parseReviewedAmbiguities(
        JSON.parse(await readFile(options.reviewedAmbiguities, "utf8")),
      )
    : new Map();
  const report = auditFixture(options.fixture, fixture, reviewedAmbiguities);
  console.log(JSON.stringify(report, null, options.pretty ? 2 : 0));

  const failed = options.failOn.some(
    (severity) => report.summary.findingsBySeverity[severity] > 0,
  );
  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  console.error(usage());
  process.exit(1);
});
