#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { codepointCompare } from "../lib/codepoint-compare.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (!args.input) throw new Error("usage: build-route-graph-coverage-report.mjs --input <coverage-input.json> [--output <report.json>]");
  const input = JSON.parse(await readFile(args.input, "utf8"));
  const report = buildRouteGraphCoverageReport(input);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.output) {
    await writeFile(args.output, json);
  } else {
    process.stdout.write(json);
  }
  return report;
}

export function buildRouteGraphCoverageReport(input) {
  const generatedConnectors = Array.isArray(input.generatedConnectors) ? input.generatedConnectors : [];
  const strictOdResults = Array.isArray(input.strictOdResults) ? input.strictOdResults : [];
  return {
    schemaVersion: 1,
    generatedConnector: {
      byStation: aggregate(generatedConnectors, ["stationId", "lineId", "edgeType", "region", "operatorId"]),
      byRegion: aggregate(generatedConnectors, ["region", "operatorId"]),
    },
    generatedConnectorVerifiedAccessibilityCount: generatedConnectors
      .filter((row) => row.generated === true && row.verifiedAccessibility === true).length,
    strictRouteNotFound: strictRouteNotFound(strictOdResults),
    priorityBacklog: strictOdResults
      .filter((row) => row.found === false && row.priority === "HIGH")
      .map((row) => ({
        odId: row.odId,
        originStationId: row.originStationId,
        destinationStationId: row.destinationStationId,
        reasonCode: row.reasonCode ?? "ROUTE_GRAPH_UNKNOWN",
      })),
  };
}

function aggregate(rows, keys) {
  const byKey = new Map();
  for (const row of rows) {
    const key = keys.map((field) => row[field] ?? "").join("\0");
    const current = byKey.get(key) ?? Object.fromEntries(keys.map((field) => [field, row[field] ?? ""]));
    current.generatedCount = (current.generatedCount ?? 0) + (row.generated === true ? 1 : 0);
    current.explicitCount = (current.explicitCount ?? 0) + (row.generated === true ? 0 : 1);
    byKey.set(key, current);
  }
  return [...byKey.values()]
    .map((row) => ({ ...row, ratio: ratio(row.generatedCount, row.generatedCount + row.explicitCount) }))
    .sort((left, right) => codepointCompare(JSON.stringify(left), JSON.stringify(right)));
}

function strictRouteNotFound(rows) {
  const notFound = rows.filter((row) => row.found === false);
  const byReasonCode = {};
  for (const row of notFound) {
    const reasonCode = row.reasonCode ?? "ROUTE_GRAPH_UNKNOWN";
    byReasonCode[reasonCode] = (byReasonCode[reasonCode] ?? 0) + 1;
  }
  return {
    total: rows.length,
    notFoundCount: notFound.length,
    rate: ratio(notFound.length, rows.length),
    byReasonCode,
  };
}

function ratio(count, total) {
  return total === 0 ? 0 : count / total;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${key}`);
    parsed[key.slice(2)] = value;
    index += 1;
  }
  return parsed;
}
