#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function usage() {
  return `Usage: node tools/route-map/join-svg-label-polygons.mjs --fixture <catalog-fixture.json> --geometry <svg-geometry.json> --output <joined-fixture.json> [--report report.json]

Joins extracted SVG station label polygons into routeMapPositions when a
region/name match maps to exactly one station-line position.`;
}

function parseArgs(argv) {
  const options = { fixture: "", geometry: "", output: "", report: "" };
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

function rejectPathCollisions(options) {
  const paths = Object.entries(options)
    .filter(([, value]) => value)
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

function routePositionsByLabel(pack) {
  const stationNames = stationNameById(pack);
  const byLabel = new Map();
  for (const position of Array.isArray(pack.routeMapPositions)
    ? pack.routeMapPositions
    : []) {
    const key = positionKey(
      position.region,
      stationNames.get(normalizedText(position.stationId)) ?? position.sourceLabel,
    );
    byLabel.set(key, [...(byLabel.get(key) ?? []), position]);
  }
  return byLabel;
}

function stationLabels(geometry) {
  return (Array.isArray(geometry.labels) ? geometry.labels : []).filter(
    (label) => normalizedText(label.classification) === "STATION_LABEL",
  );
}

function labelName(label) {
  return stationLabelKey(label.normalizedText || label.sourceText);
}

function sortedUnique(values) {
  return [...new Set(values.map(normalizedText).filter(Boolean))].sort();
}

function joinPack(pack, geometry) {
  const byLabel = routePositionsByLabel(pack);
  const matched = [];
  const unmatched = [];
  const ambiguous = [];

  for (const label of stationLabels(geometry)) {
    const candidates = byLabel.get(positionKey(geometry.region, labelName(label))) ?? [];
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
    position.labelPolygon = label.polygon;
    position.labelPolygonSourceSvgSha256 = geometry.sourceSvgSha256 ?? "";
    position.labelPolygonSourceElementKey = label.sourceElementKey ?? "";
    position.labelPolygonIndex = label.polygonIndex ?? 0;
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
      matched: matched.length,
      unmatched: unmatched.length,
      ambiguous: ambiguous.length,
      missingRouteMapPositions: missingRouteMapPositions.length,
    },
    matched,
    unmatched,
    ambiguous,
    missingRouteMapPositions,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const fixture = JSON.parse(await readFile(options.fixture, "utf8"));
  const geometry = JSON.parse(await readFile(options.geometry, "utf8"));
  const packs = Array.isArray(fixture.packs) ? fixture.packs : [];
  const packReports = packs.map((pack) => joinPack(pack, geometry));
  const report = buildReport(options.fixture, options.geometry, geometry, packReports);

  await writeFile(options.output, `${JSON.stringify(fixture, null, 2)}\n`);
  if (options.report) {
    await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

main().catch((error) => {
  console.error(error.message);
  console.error(usage());
  process.exit(1);
});
