#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function usage() {
  return `Usage: node tools/route-map/join-svg-label-polygons.mjs --fixture <catalog-fixture.json> --geometry <svg-geometry.json> --output <joined-fixture.json> [--report report.json] [--reviewed-matches reviewed.json] [--fail-on AMBIGUOUS,UNMATCHED,MISSING_ROUTE_MAP_POSITIONS]

Joins extracted SVG station label polygons into routeMapPositions when a
region/name match maps to exactly one station-line position. Reviewed matches
can resolve transfer-station ambiguity by sourceElementKey.`;
}

function parseArgs(argv) {
  const options = {
    fixture: "",
    geometry: "",
    output: "",
    report: "",
    reviewedMatches: "",
    failOn: new Set(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--fixture":
        options.fixture = argv[++index] ?? "";
        break;
      case "--geometry":
        options.geometry = argv[++index] ?? "";
        break;
      case "--output":
        options.output = argv[++index] ?? "";
        break;
      case "--report":
        options.report = argv[++index] ?? "";
        break;
      case "--reviewed-matches":
        options.reviewedMatches = argv[++index] ?? "";
        break;
      case "--fail-on":
        options.failOn = parseFailOn(argv[++index] ?? "");
        break;
      case "--help":
      case "-h":
        process.stdout.write(usage());
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  for (const name of ["fixture", "geometry", "output"]) {
    if (!options[name]) throw new Error(`--${name} is required`);
  }
  rejectPathCollisions(options);
  return options;
}

function parseFailOn(value) {
  const keysByInput = new Map([
    ["AMBIGUOUS", "ambiguous"],
    ["UNMATCHED", "unmatched"],
    ["MISSING_ROUTE_MAP_POSITIONS", "missingRouteMapPositions"],
  ]);
  const tokens = value.split(",").map((token) => token.trim()).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error("--fail-on requires at least one condition");
  }
  const failOn = new Set();
  for (const token of tokens) {
    const key = keysByInput.get(token.toUpperCase());
    if (!key) {
      throw new Error(`Unknown --fail-on condition: ${token}`);
    }
    failOn.add(key);
  }
  return failOn;
}

function rejectPathCollisions(options) {
  const paths = Object.entries(options)
    .filter(([, value]) => typeof value === "string" && value)
    .map(([name, value]) => [name, path.resolve(value)]);
  for (let leftIndex = 0; leftIndex < paths.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < paths.length; rightIndex += 1) {
      const [leftName, leftPath] = paths[leftIndex];
      const [rightName, rightPath] = paths[rightIndex];
      if (leftPath === rightPath) {
        throw new Error(`--${leftName} and --${rightName} must not use the same path`);
      }
    }
  }
}

function normalizedText(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ");
}

function stationLabelKey(value) {
  return normalizedText(value)
    .replace(/\([^)]*\)/gu, "")
    .replace(/\[[^\]]*\]/gu, "")
    .replace(/[·ㆍ･.\s]/gu, "")
    .replace(/역$/u, "");
}

function hasPolygon(value) {
  return Array.isArray(value) && value.length >= 3;
}

function stationNameById(pack) {
  return new Map(
    (Array.isArray(pack.stations) ? pack.stations : []).map((station) => [
      normalizedText(station.id),
      stationLabelKey(station.nameKo),
    ]),
  );
}

function positionKey(region, stationName) {
  return `${normalizedText(region)}\u0000${stationLabelKey(stationName)}`;
}

function targetKey(region, stationId, lineId) {
  return `${normalizedText(region)}\u0000${normalizedText(stationId)}\u0000${normalizedText(lineId)}`;
}

function routePositionsByLabel(pack, ignoredTargetKeys = new Set()) {
  const stationNames = stationNameById(pack);
  const byLabel = new Map();
  for (const position of Array.isArray(pack.routeMapPositions)
    ? pack.routeMapPositions
    : []) {
    if (ignoredTargetKeys.has(targetKey(position.region, position.stationId, position.lineId))) {
      continue;
    }
    const key = positionKey(
      position.region,
      stationNames.get(normalizedText(position.stationId)) ?? position.sourceLabel,
    );
    byLabel.set(key, [...(byLabel.get(key) ?? []), position]);
  }
  return byLabel;
}

function stationLabels(geometry, ignoredSourceElementKeys = new Set()) {
  return (Array.isArray(geometry.labels) ? geometry.labels : []).filter(
    (label) =>
      normalizedText(label.classification) === "STATION_LABEL" &&
      !ignoredSourceElementKeys.has(normalizedText(label.sourceElementKey)),
  );
}

function labelName(label) {
  return stationLabelKey(label.normalizedText || label.sourceText);
}

function stationLabelsByKey(geometry, ignoredSourceElementKeys) {
  const byKey = new Map();
  for (const label of stationLabels(geometry, ignoredSourceElementKeys)) {
    const key = positionKey(geometry.region, labelName(label));
    byKey.set(key, [...(byKey.get(key) ?? []), label]);
  }
  return byKey;
}

function sortedUnique(values) {
  return [...new Set(values.map(normalizedText).filter(Boolean))].sort();
}

function applyLabelPolygon(position, label, geometry) {
  position.labelPolygon = label.polygon;
  position.labelPolygonSourceSvgSha256 = geometry.sourceSvgSha256 ?? "";
  position.labelPolygonSourceElementKey = label.sourceElementKey ?? "";
  position.labelPolygonIndex = label.polygonIndex ?? 0;
}

function routePositionsByTarget(pack) {
  const byTarget = new Map();
  for (const position of Array.isArray(pack.routeMapPositions)
    ? pack.routeMapPositions
    : []) {
    byTarget.set(
      targetKey(position.region, position.stationId, position.lineId),
      position,
    );
  }
  return byTarget;
}

function routePositionsByTargetInFixture(fixture) {
  const byTarget = new Map();
  for (const pack of Array.isArray(fixture.packs) ? fixture.packs : []) {
    for (const [key, position] of routePositionsByTarget(pack)) {
      byTarget.set(key, position);
    }
  }
  return byTarget;
}

function stationLabelsBySourceElementKey(geometry) {
  const bySourceElementKey = new Map();
  for (const label of stationLabels(geometry)) {
    const sourceElementKey = normalizedText(label.sourceElementKey);
    if (sourceElementKey) {
      bySourceElementKey.set(sourceElementKey, label);
    }
  }
  return bySourceElementKey;
}

function parseReviewedMatches(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("--reviewed-matches must be a JSON object");
  }
  if (!Array.isArray(raw.matches)) {
    throw new Error("--reviewed-matches matches must be an array");
  }
  const rows = raw.matches;
  return rows.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`reviewed match ${index} must be an object`);
    }
    const match = {
      region: normalizedText(row.region),
      stationId: normalizedText(row.stationId),
      lineId: normalizedText(row.lineId),
      sourceElementKey: normalizedText(row.sourceElementKey),
      reviewedAt: normalizedText(row.reviewedAt),
      reviewedBy: normalizedText(row.reviewedBy),
      reason: normalizedText(row.reason),
    };
    for (const field of ["region", "stationId", "lineId", "sourceElementKey"]) {
      if (!match[field]) {
        throw new Error(`reviewed match ${index} missing ${field}`);
      }
    }
    return match;
  });
}

function validateReviewedMatches(fixture, geometry, reviewedMatches) {
  const labelsBySourceElementKey = stationLabelsBySourceElementKey(geometry);
  const positionsByTarget = routePositionsByTargetInFixture(fixture);
  const reviewedSourceElementKeys = new Set();
  const reviewedTargetKeys = new Set();

  for (const match of reviewedMatches) {
    if (normalizedText(match.region) !== normalizedText(geometry.region)) {
      continue;
    }
    const positionKey = targetKey(match.region, match.stationId, match.lineId);
    if (reviewedSourceElementKeys.has(match.sourceElementKey)) {
      throw new Error(`duplicate reviewed match sourceElementKey: ${match.sourceElementKey}`);
    }
    if (reviewedTargetKeys.has(positionKey)) {
      throw new Error(`duplicate reviewed match target: ${match.region} ${match.stationId}/${match.lineId}`);
    }
    reviewedSourceElementKeys.add(match.sourceElementKey);
    reviewedTargetKeys.add(positionKey);
    if (!labelsBySourceElementKey.has(match.sourceElementKey)) {
      throw new Error(`reviewed match sourceElementKey not found: ${match.sourceElementKey}`);
    }
    if (!positionsByTarget.has(positionKey)) {
      throw new Error(`reviewed match station-line row not found: ${match.region} ${match.stationId}/${match.lineId}`);
    }
  }
}

function applyReviewedMatches(pack, geometry, reviewedMatches) {
  const labelsBySourceElementKey = stationLabelsBySourceElementKey(geometry);
  const positionsByTarget = routePositionsByTarget(pack);
  const reviewedMatched = [];
  const reviewedSourceElementKeys = new Set();
  const reviewedTargetKeys = new Set();

  for (const match of reviewedMatches) {
    if (normalizedText(match.region) !== normalizedText(geometry.region)) {
      continue;
    }
    const positionKey = targetKey(match.region, match.stationId, match.lineId);
    if (reviewedSourceElementKeys.has(match.sourceElementKey)) {
      throw new Error(`duplicate reviewed match sourceElementKey: ${match.sourceElementKey}`);
    }
    if (reviewedTargetKeys.has(positionKey)) {
      throw new Error(`duplicate reviewed match target: ${match.region} ${match.stationId}/${match.lineId}`);
    }
    const position = positionsByTarget.get(positionKey);
    if (!position) {
      continue;
    }
    const label = labelsBySourceElementKey.get(match.sourceElementKey);
    if (!label) {
      throw new Error(`reviewed match sourceElementKey not found: ${match.sourceElementKey}`);
    }
    applyLabelPolygon(position, label, geometry);
    reviewedSourceElementKeys.add(match.sourceElementKey);
    reviewedTargetKeys.add(positionKey);
    reviewedMatched.push({
      stationId: position.stationId ?? "",
      lineId: position.lineId ?? "",
      region: position.region ?? "",
      sourceText: label.sourceText ?? "",
      polygonIndex: label.polygonIndex ?? null,
      sourceElementKey: label.sourceElementKey ?? "",
      reviewedAt: match.reviewedAt,
      reviewedBy: match.reviewedBy,
      reason: match.reason,
    });
  }

  return { reviewedMatched, reviewedSourceElementKeys, reviewedTargetKeys };
}

function joinPack(pack, geometry, reviewedMatches) {
  const { reviewedMatched, reviewedSourceElementKeys, reviewedTargetKeys } = applyReviewedMatches(
    pack,
    geometry,
    reviewedMatches,
  );
  const byLabel = routePositionsByLabel(pack, reviewedTargetKeys);
  const matched = [];
  const unmatched = [];
  const ambiguous = [];

  for (const [labelKey, labels] of stationLabelsByKey(geometry, reviewedSourceElementKeys)) {
    const [label] = labels;
    const candidates = byLabel.get(labelKey) ?? [];
    if (labels.length > 1) {
      ambiguous.push({
        sourceText: sortedUnique(labels.map((row) => row.sourceText)).join(" / "),
        normalizedText: labelName(label),
        stationIds: sortedUnique(candidates.map((row) => row.stationId)),
        lineIds: sortedUnique(candidates.map((row) => row.lineId)),
        polygonIndexes: labels.map((row) => row.polygonIndex ?? null),
        sourceElementKeys: sortedUnique(labels.map((row) => row.sourceElementKey)),
        duplicateLabelCount: labels.length,
      });
      continue;
    }
    if (candidates.length === 0) {
      unmatched.push({
        sourceText: label.sourceText ?? "",
        normalizedText: labelName(label),
        polygonIndex: label.polygonIndex ?? null,
        sourceElementKey: label.sourceElementKey ?? "",
      });
      continue;
    }
    if (candidates.length > 1) {
      ambiguous.push({
        sourceText: label.sourceText ?? "",
        normalizedText: labelName(label),
        stationIds: sortedUnique(candidates.map((row) => row.stationId)),
        lineIds: sortedUnique(candidates.map((row) => row.lineId)),
        polygonIndex: label.polygonIndex ?? null,
        sourceElementKey: label.sourceElementKey ?? "",
      });
      continue;
    }
    const [position] = candidates;
    applyLabelPolygon(position, label, geometry);
    matched.push({
      stationId: position.stationId ?? "",
      lineId: position.lineId ?? "",
      region: position.region ?? "",
      sourceText: label.sourceText ?? "",
      polygonIndex: label.polygonIndex ?? null,
      sourceElementKey: label.sourceElementKey ?? "",
    });
  }

  const missingRouteMapPositions = (Array.isArray(pack.routeMapPositions)
    ? pack.routeMapPositions
    : []).filter(
      (position) =>
        normalizedText(position.region) === normalizedText(geometry.region) &&
        !hasPolygon(position.labelPolygon),
    );

  return {
    reviewedMatched,
    matched,
    unmatched,
    ambiguous,
    missingRouteMapPositions: missingRouteMapPositions.map((position) => ({
      stationId: position.stationId ?? "",
      lineId: position.lineId ?? "",
      region: position.region ?? "",
    })),
  };
}

function buildReport(fixturePath, geometryPath, geometry, packReports) {
  const reviewedMatched = packReports.flatMap((report) => report.reviewedMatched);
  const matched = packReports.flatMap((report) => report.matched);
  const unmatched = packReports.flatMap((report) => report.unmatched);
  const ambiguous = packReports.flatMap((report) => report.ambiguous);
  const missingRouteMapPositions = packReports.flatMap(
    (report) => report.missingRouteMapPositions,
  );
  return {
    schemaVersion: 1,
    artifactKind: "route-map-label-polygon-join-report",
    fixture: path.normalize(fixturePath),
    geometry: path.normalize(geometryPath),
    region: geometry.region ?? "",
    sourceSvgSha256: geometry.sourceSvgSha256 ?? "",
    summary: {
      reviewedMatched: reviewedMatched.length,
      matched: matched.length,
      unmatched: unmatched.length,
      ambiguous: ambiguous.length,
      missingRouteMapPositions: missingRouteMapPositions.length,
    },
    reviewedMatched,
    matched,
    unmatched,
    ambiguous,
    missingRouteMapPositions,
  };
}

function failureMessage(report, failOn) {
  const failed = [...failOn]
    .filter((key) => (report.summary[key] ?? 0) > 0)
    .map((key) => `${key}=${report.summary[key]}`);
  if (failed.length === 0) {
    return "";
  }
  return `SVG label polygon join failed: ${failed.join(", ")}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const fixture = JSON.parse(await readFile(options.fixture, "utf8"));
  const geometry = JSON.parse(await readFile(options.geometry, "utf8"));
  const reviewedMatches = options.reviewedMatches
    ? parseReviewedMatches(JSON.parse(await readFile(options.reviewedMatches, "utf8")))
    : [];
  const packs = Array.isArray(fixture.packs) ? fixture.packs : [];
  validateReviewedMatches(fixture, geometry, reviewedMatches);
  const packReports = packs.map((pack) =>
    joinPack(pack, geometry, reviewedMatches),
  );
  const report = buildReport(options.fixture, options.geometry, geometry, packReports);

  await writeFile(options.output, `${JSON.stringify(fixture, null, 2)}\n`);
  if (options.report) {
    await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  const message = failureMessage(report, options.failOn);
  if (message) {
    console.error(message);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  console.error(usage());
  process.exit(1);
});
