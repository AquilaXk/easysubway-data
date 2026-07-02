#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, values) =>
  value.startsWith("--") ? [[value.slice(2), values[index + 1]]] : [],
));

if (!args.manifest) {
  console.error("usage: build-quality-metric-report.mjs --manifest <current.json> [--output <report.json>]");
  process.exit(1);
}

const ratioKeys = [
  "facilityCoverageRatio",
  "requiredFacilityEvidenceCoverageRatio",
  "strictRouteEligibleFacilityRatio",
  "operationalKnownRatio",
  "freshnessValidRatio",
  "fieldVerifiedPathwayRatio",
  "unknownAccessibilityRatio",
];

try {
  const manifest = JSON.parse(await readFile(args.manifest, "utf8"));
  if (!Array.isArray(manifest.packs) || manifest.packs.length === 0) {
    throw new Error("manifest packs must be a non-empty array");
  }
  const packs = manifest.packs.map((pack) => {
    const metrics = pack.regionalQualityMetrics;
    if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
      throw new Error(`${pack.id}@${pack.version} regionalQualityMetrics must be an object`);
    }
    if (!Number.isInteger(metrics.stationCount) || !Number.isInteger(metrics.edgeCount)) {
      throw new Error(`${pack.id}@${pack.version} stationCount and edgeCount must be integers`);
    }
    for (const key of ratioKeys) {
      if (typeof metrics[key] !== "number" || metrics[key] < 0 || metrics[key] > 1) {
        throw new Error(`${pack.id}@${pack.version} ${key} must be a ratio`);
      }
    }
    for (const key of ["wheelchair", "stroller", "lowMobility"]) {
      const value = metrics.unknownEdgeRatioByProfile?.[key];
      if (typeof value !== "number" || value < 0 || value > 1) {
        throw new Error(`${pack.id}@${pack.version} unknownEdgeRatioByProfile.${key} must be a ratio`);
      }
    }
    return {
      id: pack.id,
      version: pack.version,
      artifactKind: pack.artifactKind ?? null,
      url: pack.url ?? null,
      denominatorPolicy: "station_line_x_required_facility_type",
      freshnessPolicy: "verified_or_retrieved_timestamp_present",
      metrics: {
        stationCount: metrics.stationCount,
        edgeCount: metrics.edgeCount,
        ...Object.fromEntries(ratioKeys.map((key) => [key, metrics[key]])),
        unknownEdgeRatioByProfile: {
          wheelchair: metrics.unknownEdgeRatioByProfile.wheelchair,
          stroller: metrics.unknownEdgeRatioByProfile.stroller,
          lowMobility: metrics.unknownEdgeRatioByProfile.lowMobility,
        },
      },
    };
  });
  const metric = (key) => Math.min(...packs.map((pack) => pack.metrics[key]));
  const report = {
    schemaVersion: 1,
    artifactKind: "datapack-quality-metric-report",
    manifestVersion: manifest.manifestVersion ?? 1,
    channel: manifest.channel ?? null,
    releaseSequence: manifest.releaseSequence ?? null,
    summary: {
      packCount: packs.length,
      worstRequiredFacilityEvidenceCoverageRatio: metric("requiredFacilityEvidenceCoverageRatio"),
      worstFreshnessValidRatio: metric("freshnessValidRatio"),
    },
    packs,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.output) {
    await mkdir(path.dirname(args.output), { recursive: true });
    await writeFile(args.output, json);
  } else {
    process.stdout.write(json);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
