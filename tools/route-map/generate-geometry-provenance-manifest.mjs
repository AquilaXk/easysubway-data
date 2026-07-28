#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { canonicalJson } from "../datapack/lib/manifest-validation.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";
import { normalizeSvgForCompile } from "./compile-basemap-vec.mjs";
import { cleanupPackDir, openPack, repoRoot } from "./pack-io.mjs";
import { FULL_CANVAS_DECOR_IDS, inkBBoxOf, viewBoxOf } from "./svg-ink-bbox.mjs";

const REGIONS = [
  { id: "seoul", region: "수도권", source: "easy-subway-sma-v4" },
  { id: "busan", region: "부산권", source: "easy-subway-busan-v3" },
  { id: "daegu", region: "대구권", source: "easy-subway-daegu-v3" },
  { id: "daejeon", region: "대전권", source: "easy-subway-daejeon-v3" },
  { id: "gwangju", region: "광주권", source: "easy-subway-gwangju-v3" },
];
const GEOMETRY_SCHEMA_KEYS = [
  "schemaVersion",
  "region",
  "sourceSvgSha256",
  "extractorVersion",
  "browser",
  "sourceViewBox",
  "labels",
  "strokes",
  "stationNodes",
];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const compareRows = (a, b) =>
  compareText(String(a.station_id), String(b.station_id)) ||
  compareText(String(a.line_id), String(b.line_id)) ||
  compareText(String(a.region), String(b.region));

function canonicalGeometryContent(geometry) {
  const keys = Object.keys(geometry);
  const missing = GEOMETRY_SCHEMA_KEYS.filter((key) => !keys.includes(key));
  const unexpected = keys.filter((key) => !GEOMETRY_SCHEMA_KEYS.includes(key));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `geometry schema keys mismatch: missing=${missing.join(",")} unexpected=${unexpected.join(",")}`,
    );
  }
  const { browser, ...content } = geometry;
  return canonicalJson(content);
}

function sourceElementKeysOf(geometry) {
  return Object.fromEntries(
    ["labels", "strokes", "stationNodes"].map((kind) => [
      kind,
      (geometry[kind] ?? []).map((row, index) => {
        if (!/^[a-f0-9]{64}$/.test(row.sourceElementKey ?? "")) {
          throw new Error(`geometry ${kind}[${index}] sourceElementKey invalid`);
        }
        return row.sourceElementKey;
      }),
    ]),
  );
}

function packSourceElementKeys(sourceElementKeys) {
  return Buffer.concat(
    Object.values(sourceElementKeys).flat().map((key) => Buffer.from(key, "hex")),
  ).toString("base64");
}

function unpackSourceElementKeys(value, region) {
  if (typeof value !== "string") {
    throw new Error(`${region} sourceElementKey evidence missing`);
  }
  const packed = Buffer.from(value, "base64");
  if (packed.length % 32 !== 0 || packed.toString("base64") !== value) {
    throw new Error(`${region} sourceElementKey evidence invalid`);
  }
  const keys = [];
  for (let offset = 0; offset < packed.length; offset += 32) {
    keys.push(packed.subarray(offset, offset + 32).toString("hex"));
  }
  return keys;
}

export function buildRegionProvenance({
  expectedRegion,
  svg,
  geometryBytes,
  routeMapPositionRows,
}) {
  const geometry = JSON.parse(Buffer.from(geometryBytes).toString("utf8"));
  if (geometry.region !== expectedRegion) {
    throw new Error(`geometry region mismatch: ${geometry.region} != ${expectedRegion}`);
  }
  const sourceSvgSha256 = sha256(svg);
  if (geometry.sourceSvgSha256 !== sourceSvgSha256) {
    throw new Error(
      `geometry sourceSvgSha256 mismatch: ${geometry.sourceSvgSha256} != ${sourceSvgSha256}`,
    );
  }

  const normalized = normalizeSvgForCompile(svg);
  const sourceViewBox = viewBoxOf(normalized);
  if (!isDeepStrictEqual(geometry.sourceViewBox, sourceViewBox)) {
    throw new Error(
      `geometry sourceViewBox mismatch: ${JSON.stringify(geometry.sourceViewBox)} != ${JSON.stringify(sourceViewBox)}`,
    );
  }
  const ink = inkBBoxOf(normalized, { excludeIds: FULL_CANVAS_DECOR_IDS });
  const rows = routeMapPositionRows.slice().sort(compareRows);
  const sourceElementKeys = sourceElementKeysOf(geometry);

  return {
    sourceSvgSha256,
    normalizedSvgSha256: sha256(normalized),
    sourceViewBox,
    fullInkBounds: {
      minX: ink.minX,
      minY: ink.minY,
      maxX: ink.maxX,
      maxY: ink.maxY,
    },
    extractorVersion: geometry.extractorVersion,
    geometrySha256: sha256(canonicalGeometryContent(geometry)),
    sourceElementKeysBase64: packSourceElementKeys(sourceElementKeys),
    sourceElementKeysSha256: sha256(canonicalJson(sourceElementKeys)),
    routeMapPositionsSha256: sha256(canonicalJson(rows)),
    labelSourceCount: (geometry.labels ?? []).filter(
      ({ classification }) => classification === "STATION_LABEL",
    ).length,
    stationNodeCount: (geometry.stationNodes ?? []).length,
    generatorContractVersion: 3,
  };
}

export function verifySourceElementKeyRotation(expected, actual) {
  for (const [region, next] of Object.entries(actual.regions ?? {})) {
    const previous = expected.regions?.[region];
    if (previous && previous.sourceSvgSha256 !== next.sourceSvgSha256) {
      const previousKeys = new Set(
        unpackSourceElementKeys(previous.sourceElementKeysBase64, `${region} previous`),
      );
      for (const key of unpackSourceElementKeys(next.sourceElementKeysBase64, region)) {
        if (previousKeys.has(key)) {
          throw new Error(`${region} sourceElementKey did not rotate with sourceSvgSha256: ${key}`);
        }
      }
    }
  }
}

export function generateGeometryProvenanceManifest({
  pack = "apps/mobile/assets/datapacks/capital.sqlite.gz",
} = {}) {
  const opened = openPack(pack, "geometry-provenance-");
  try {
    const regions = {};
    for (const item of REGIONS) {
      const svgPath = path.join(
        repoRoot,
        "tools/route-map/route-map-defs/svg-sources",
        `${item.source}.svg`,
      );
      const geometryPath = path.join(
        repoRoot,
        "tools/route-map/route-map-defs",
        `${item.source}-geometry.json`,
      );
      const rows = opened.db
        .prepare(
          "SELECT * FROM route_map_positions WHERE region = ? ORDER BY station_id, line_id, region",
        )
        .all(item.region);
      regions[item.id] = buildRegionProvenance({
        expectedRegion: item.region,
        svg: readFileSync(svgPath, "utf8"),
        geometryBytes: readFileSync(geometryPath),
        routeMapPositionRows: rows,
      });
    }
    return {
      schemaVersion: 1,
      artifactKind: "route-map-geometry-provenance-manifest",
      regions,
    };
  } finally {
    opened.db.close();
    cleanupPackDir(opened.dir);
  }
}

export function verifyGeometryProvenanceManifest(expected, actual) {
  if (!isDeepStrictEqual(expected, actual)) {
    throw new Error("geometry provenance drift");
  }
}

function main() {
  const output = path.join(
    repoRoot,
    "tools/route-map/geometry-provenance-manifest.json",
  );
  const manifest = generateGeometryProvenanceManifest();
  if (existsSync(output)) {
    verifySourceElementKeyRotation(JSON.parse(readFileSync(output, "utf8")), manifest);
  }
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${path.relative(repoRoot, output)}\n`);
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
