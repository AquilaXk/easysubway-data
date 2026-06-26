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
  return `Usage: node tools/route-map/audit-route-map.mjs --fixture <catalog-fixture.json> [--fail-on BLOCKER,HIGH] [--pretty]

Audits routeMapPositions against stationLines so production route-map coordinate
coverage can be checked before rebuilding datapacks.`;
}

function parseArgs(argv) {
  const options = {
    fixture: null,
    failOn: [],
    pretty: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--fixture":
        options.fixture = argv[++index];
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

function normalizedText(value) {
  return typeof value === "string" ? value.trim() : "";
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

function auditPack(pack) {
  const findings = [];
  const stationLines = Array.isArray(pack.stationLines) ? pack.stationLines : [];
  const positions = Array.isArray(pack.routeMapPositions)
    ? pack.routeMapPositions
    : [];
  const stationLineKeys = new Set(stationLines.map(stationLineKeyFor));
  const positionKeys = new Set();
  const positionedStationLineKeys = new Set();
  const coordinateGroups = new Map();

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
    addFinding(findings, {
      severity: "HIGH",
      code: "DUPLICATE_SOURCE_COORDINATE",
      packId: pack.id,
      region: first.region,
      lineId: first.lineId,
      stationId: group.map((row) => row.stationId).join(","),
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
      coverageRatio:
        stationLines.length === 0
          ? 1
          : Number(
              (
                [...stationLineKeys].filter((key) =>
                  positionedStationLineKeys.has(key),
                ).length / stationLines.length
              ).toFixed(4),
            ),
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

function auditFixture(fixturePath, fixture) {
  const packs = Array.isArray(fixture.packs) ? fixture.packs : [];
  const auditedPacks = packs.map(auditPack);
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
  const report = auditFixture(options.fixture, fixture);
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
