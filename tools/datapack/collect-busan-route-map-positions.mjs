#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateBusanRouteMapConnectorEvidence } from "./collect-busan-route-map-connectors.mjs";

const SOURCE_ID = "busan-transportation-route-map-positions";
const SOURCE_URL = "https://www2.humetro.busan.kr/homepage/cyberstation/map.do";
const DATASET_URL = "https://www.data.go.kr/data/15054957/fileData.do";
const EXPECTED_LINE_STATION_COUNTS = Object.freeze({ "1": 40, "2": 43, "3": 17, "4": 14 });
const EXPECTED_STATION_COUNT = 114;
const EXPECTED_CONNECTOR_COUNT = 110;
const EXPECTED_CONNECTOR_ASSET_COUNT = 32;

export function createBusanRouteMapPositionsSnapshot({ html, css, topology, connectorEvidence, capturedAt }) {
  if (!Buffer.isBuffer(html) || !Buffer.isBuffer(css)) {
    throw new Error("official Busan route map HTML/CSS bytes are required");
  }
  if (topology?.sourceId !== "busan-transportation-route-topology"
    || topology.stationCount !== EXPECTED_STATION_COUNT || topology.scope?.length !== EXPECTED_STATION_COUNT
    || !/^[a-f0-9]{64}$/.test(topology.contentSha256 ?? "")) {
    throw new Error("official Busan topology snapshot is required");
  }
  try {
    validateBusanRouteMapConnectorEvidence(connectorEvidence);
  } catch {
    throw new Error("official Busan connector evidence is required");
  }
  const capturedAtValue = new Date(capturedAt).toISOString();
  if (capturedAtValue !== capturedAt) throw new Error("capturedAt must be an ISO instant");
  if (connectorEvidence.capturedAt !== capturedAt) {
    throw new Error("connector evidence capturedAt mismatch");
  }

  const htmlStations = parseHtmlStations(html.toString("utf8"));
  const cssText = css.toString("utf8");
  const coordinates = parseCssPositions(cssText, /^\.s(\d+)$/);
  const labels = parseCssPositions(cssText, /^\.s(\d+) \.sta-title$/);
  const lineLabelDefaults = parseCssPositions(cssText, /^\.line-(\d+) \.sta-title$/);
  const positions = topology.scope.map((station) => {
    const htmlStation = htmlStations.get(station.stationCode);
    const coordinate = coordinates.get(station.stationCode);
    if (!htmlStation || htmlStation.line !== lineFor(station.lineId)
      || normalizeStationName(htmlStation.stationName) !== normalizeStationName(station.stationName)) {
      throw new Error(`Busan route map station mismatch: ${station.lineId}:${station.stationCode}`);
    }
    if (!coordinate || coordinate.top == null || coordinate.left == null) {
      throw new Error(`Busan route map coordinate missing: ${station.stationCode}`);
    }
    const label = { ...(lineLabelDefaults.get(htmlStation.line) ?? {}), ...(labels.get(station.stationCode) ?? {}) };
    if (label.top == null || label.left == null || label.width == null) {
      throw new Error(`Busan route map label geometry missing: ${station.stationCode}`);
    }
    const transfer = htmlStation.classNames.includes("trans");
    const stationPosition = {
      lineId: station.lineId,
      line: htmlStation.line,
      stationCode: station.stationCode,
      stationName: station.stationName,
      x: Math.round(coordinate.left + (transfer ? 12.5 : 5.5)),
      y: Math.round(coordinate.top + (transfer ? 13 : 5)),
    };
    const labelPolygon = labelPolygonFor({ station: stationPosition, coordinate, label });
    const labelCenterX = (labelPolygon[0].x + labelPolygon[1].x) / 2;
    const labelCenterY = (labelPolygon[0].y + labelPolygon[3].y) / 2;
    return {
      ...stationPosition,
      labelDx: Math.round(labelCenterX - stationPosition.x),
      labelDy: Math.round(labelCenterY - stationPosition.y),
      labelPolygon,
    };
  }).sort(comparePositions);
  const connectors = officialConnectors({
    html: html.toString("utf8"),
    css: cssText,
    positions,
    connectorEvidence,
  });

  const htmlSha256 = sha256(html);
  const cssSha256 = sha256(css);
  const connectorEvidenceSha256 = sha256(JSON.stringify(connectorEvidence));
  const connectorAssetSetSha256 = sha256(JSON.stringify(connectorEvidence.assets.map(({
    assetPath, sourceUrl, sha256: assetSha256, width, height,
  }) => ({ assetPath, sourceUrl, sha256: assetSha256, width, height }))));
  const snapshot = {
    schemaVersion: 1,
    artifactKind: "busan-route-map-positions-snapshot",
    sourceId: SOURCE_ID,
    official: true,
    fixture: false,
    credentialRedacted: true,
    sourceUrl: SOURCE_URL,
    datasetUrl: DATASET_URL,
    capturedAt,
    observedDataUpdatedAt: "2025-11-04",
    htmlSha256,
    cssSha256,
    connectorEvidenceSha256,
    connectorAssetSetSha256,
    rawSha256: sha256(JSON.stringify({
      htmlSha256, cssSha256, connectorEvidenceSha256, connectorAssetSetSha256,
    })),
    topologySourceId: topology.sourceId,
    topologySnapshotId: "busan-transportation-route-topology-20260720",
    topologyContentSha256: topology.contentSha256,
    lineIds: [...new Set(positions.map(({ lineId }) => lineId))].sort(compareStrings),
    lineStationCounts: Object.fromEntries(Object.keys(EXPECTED_LINE_STATION_COUNTS).map((line) => [
      line,
      positions.filter((position) => position.line === line).length,
    ])),
    stationCount: positions.length,
    connectorCount: connectors.length,
    connectorAssetCount: connectors.filter(({ assetSha256 }) => assetSha256).length,
    fieldsProvided: ["route_map_position", "route_map_label_polygon", "route_map_line_track"],
    positionsSha256: sha256(JSON.stringify(positions)),
    positions,
    connectorsSha256: sha256(JSON.stringify(connectors)),
    connectors,
  };
  return validateBusanRouteMapPositionsSnapshot(snapshot);
}

export function validateBusanRouteMapPositionsSnapshot(snapshot) {
  const positions = snapshot?.positions;
  const connectors = snapshot?.connectors;
  const keys = new Set();
  const validPositions = Array.isArray(positions) && positions.length === EXPECTED_STATION_COUNT
    && positions.every((position) => {
      const key = `${position.lineId}:${position.stationCode}`;
      const valid = lineFor(position.lineId) === position.line
        && /^\d{2,3}$/.test(position.stationCode)
        && typeof position.stationName === "string" && position.stationName.length > 0
        && [position.x, position.y, position.labelDx, position.labelDy].every(Number.isInteger)
        && position.x >= 0 && position.x <= 1_680 && position.y >= 0 && position.y <= 980
        && Array.isArray(position.labelPolygon) && position.labelPolygon.length === 4
        && position.labelPolygon.every(({ x, y }) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0)
        && !keys.has(key);
      keys.add(key);
      return valid;
    });
  const connectorKeys = new Set();
  const validConnectors = Array.isArray(connectors) && connectors.length === EXPECTED_CONNECTOR_COUNT
    && connectors.every((connector) => {
      const key = `${connector.lineId}:${connector.fromStationCode}:${connector.toStationCode}`;
      const valid = lineFor(connector.lineId) === connector.line
        && /^\d{2,3}$/.test(connector.fromStationCode)
        && /^\d{2,3}$/.test(connector.toStationCode)
        && connector.cssSelector === `.l${connector.fromStationCode}-${connector.toStationCode}`
        && /^M \d+ \d+(?: L \d+ \d+)+$/.test(connector.path)
        && connector.cssBox && Number.isInteger(connector.cssBox.top) && Number.isInteger(connector.cssBox.left)
        && (connector.assetPath == null || (/^\d+-\d+\.png$/.test(connector.assetPath)
          && /^[a-f0-9]{64}$/.test(connector.assetSha256 ?? "")))
        && !connectorKeys.has(key);
      connectorKeys.add(key);
      return valid;
    });
  if (snapshot?.schemaVersion !== 1 || snapshot.artifactKind !== "busan-route-map-positions-snapshot"
    || snapshot.sourceId !== SOURCE_ID || snapshot.official !== true || snapshot.fixture !== false
    || snapshot.credentialRedacted !== true || snapshot.sourceUrl !== SOURCE_URL
    || snapshot.datasetUrl !== DATASET_URL || Number.isNaN(Date.parse(snapshot.capturedAt))
    || snapshot.observedDataUpdatedAt !== "2025-11-04"
    || !/^[a-f0-9]{64}$/.test(snapshot.htmlSha256 ?? "")
    || !/^[a-f0-9]{64}$/.test(snapshot.cssSha256 ?? "")
    || !/^[a-f0-9]{64}$/.test(snapshot.connectorEvidenceSha256 ?? "")
    || !/^[a-f0-9]{64}$/.test(snapshot.connectorAssetSetSha256 ?? "")
    || snapshot.rawSha256 !== sha256(JSON.stringify({
      htmlSha256: snapshot.htmlSha256,
      cssSha256: snapshot.cssSha256,
      connectorEvidenceSha256: snapshot.connectorEvidenceSha256,
      connectorAssetSetSha256: snapshot.connectorAssetSetSha256,
    }))
    || snapshot.topologySourceId !== "busan-transportation-route-topology"
    || snapshot.topologySnapshotId !== "busan-transportation-route-topology-20260720"
    || !/^[a-f0-9]{64}$/.test(snapshot.topologyContentSha256 ?? "")
    || JSON.stringify(snapshot.lineIds) !== JSON.stringify([
      "line-ab1a041f6266", "line-d74614a04530", "line-d812a5bc1e5f", "line-eb7b47920390",
    ])
    || JSON.stringify(snapshot.lineStationCounts) !== JSON.stringify(EXPECTED_LINE_STATION_COUNTS)
    || snapshot.stationCount !== EXPECTED_STATION_COUNT
    || snapshot.connectorCount !== EXPECTED_CONNECTOR_COUNT
    || snapshot.connectorAssetCount !== EXPECTED_CONNECTOR_ASSET_COUNT
    || JSON.stringify(snapshot.fieldsProvided) !== JSON.stringify([
      "route_map_position", "route_map_label_polygon", "route_map_line_track",
    ])
    || !validPositions || JSON.stringify([...positions].sort(comparePositions)) !== JSON.stringify(positions)
    || snapshot.positionsSha256 !== sha256(JSON.stringify(positions))
    || !validConnectors || snapshot.connectorsSha256 !== sha256(JSON.stringify(connectors))) {
    throw new Error("invalid Busan route map positions snapshot");
  }
  return snapshot;
}

function officialConnectors({ html, css, positions, connectorEvidence }) {
  const htmlPairs = parseHtmlConnectorPairs(html);
  const cssRules = parseCssConnectorRules(css);
  const assets = new Map(connectorEvidence.assets.map((asset) => [asset.assetPath, asset]));
  const connectors = [];
  const byLine = Map.groupBy(positions, ({ lineId }) => lineId);
  for (const [lineId, linePositions] of [...byLine.entries()].sort(([left], [right]) => compareStrings(left, right))) {
    for (let index = 0; index + 1 < linePositions.length; index += 1) {
      const from = linePositions[index];
      const to = linePositions[index + 1];
      const pair = `${from.stationCode}-${to.stationCode}`;
      const cssSelector = `.l${pair}`;
      const rule = cssRules.get(pair);
      if (!htmlPairs.has(pair) || !rule || rule.top == null || rule.left == null) {
        throw new Error(`Busan route map connector missing: ${pair}`);
      }
      const asset = rule.assetPath ? assets.get(rule.assetPath) : null;
      if (rule.assetPath && !asset) throw new Error(`Busan route map connector asset missing: ${rule.assetPath}`);
      const points = asset
        ? orientConnectorPoints(asset.centerline.map(({ x, y }) => ({ x: rule.left + x, y: rule.top + y })), from, to)
        : [{ x: from.x, y: from.y }, { x: to.x, y: to.y }];
      connectors.push({
        lineId,
        line: from.line,
        fromStationCode: from.stationCode,
        toStationCode: to.stationCode,
        cssSelector,
        cssBox: Object.fromEntries(["top", "left", "width", "height"]
          .filter((field) => rule[field] != null).map((field) => [field, rule[field]])),
        ...(asset ? { assetPath: asset.assetPath, assetSha256: asset.sha256 } : {}),
        path: pathForPoints(points),
      });
    }
  }
  if (connectors.length !== EXPECTED_CONNECTOR_COUNT
    || connectors.filter(({ assetSha256 }) => assetSha256).length !== EXPECTED_CONNECTOR_ASSET_COUNT) {
    throw new Error("Busan route map connector count mismatch");
  }
  return connectors;
}

function parseHtmlConnectorPairs(html) {
  const pairs = new Set();
  for (const [, classNames] of html.matchAll(/<div class="([^"]*\bl\d+-\d+\b[^"]*)"><\/div>/g)) {
    for (const className of classNames.split(/\s+/)) {
      const match = /^l(\d+)-(\d+)$/.exec(className);
      if (match && Number(match[1]) < Number(match[2])) pairs.add(`${match[1]}-${match[2]}`);
    }
  }
  return pairs;
}

function parseCssConnectorRules(css) {
  const rules = new Map();
  for (const match of css.matchAll(/\.l(\d+)-(\d+)\s*\{([^}]+)\}/g)) {
    const [, from, to, body] = match;
    if (Number(from) >= Number(to)) continue;
    const pair = `${from}-${to}`;
    if (rules.has(pair)) throw new Error(`Busan route map duplicate connector rule: ${pair}`);
    const assetPath = /url\([^)]*\/([0-9]+-[0-9]+\.png)\)/.exec(body)?.[1];
    rules.set(pair, {
      top: cssNumber(body, "top"),
      left: cssNumber(body, "left"),
      width: cssNumber(body, "width"),
      height: cssNumber(body, "height"),
      ...(assetPath ? { assetPath } : {}),
    });
  }
  return rules;
}

function orientConnectorPoints(centerline, from, to) {
  const forward = pointDistance(centerline[0], from) + pointDistance(centerline.at(-1), to);
  const reverse = pointDistance(centerline.at(-1), from) + pointDistance(centerline[0], to);
  const ordered = reverse < forward ? [...centerline].reverse() : centerline;
  return deduplicatePoints([{ x: from.x, y: from.y }, ...ordered, { x: to.x, y: to.y }]);
}

function pointDistance(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function deduplicatePoints(points) {
  return points.filter((point, index) => index === 0
    || point.x !== points[index - 1].x || point.y !== points[index - 1].y);
}

function pathForPoints(points) {
  return points.map(({ x, y }, index) => `${index === 0 ? "M" : "L"} ${x} ${y}`).join(" ");
}

function parseHtmlStations(html) {
  const stations = new Map();
  const pattern = /<div class="([^"]*\bs(\d+)\b[^"]*)">\s*<a[^>]+one_point\('([^']+)',\s*'(\d+)',\s*'([^']+)'/g;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const [, className, classCode, stationCode, line, stationName] = match;
    if (classCode !== stationCode) throw new Error(`Busan route map station code mismatch: ${stationCode}`);
    if (stations.has(stationCode)) throw new Error(`Busan route map duplicate station: ${stationCode}`);
    stations.set(stationCode, { classNames: className.split(/\s+/), line, stationName });
  }
  return stations;
}

function parseCssPositions(css, selectorPattern) {
  const positions = new Map();
  const rulePattern = /([^{}]+)\{([^}]+)\}/g;
  let match;
  while ((match = rulePattern.exec(css)) !== null) {
    const selector = match[1].trim().split(/[\n,]/).at(-1).trim();
    const selectorMatch = selectorPattern.exec(selector);
    if (!selectorMatch) continue;
    const top = cssNumber(match[2], "top");
    const left = cssNumber(match[2], "left");
    const width = cssNumber(match[2], "width");
    const lineHeight = cssNumber(match[2], "line-height");
    if (top == null && left == null && width == null && lineHeight == null) continue;
    const stationCode = selectorMatch[1];
    if (positions.has(stationCode)) throw new Error(`Busan route map duplicate coordinate: ${stationCode}`);
    positions.set(stationCode, Object.fromEntries(
      Object.entries({ top, left, width, lineHeight }).filter(([, value]) => value != null),
    ));
  }
  return positions;
}

function cssNumber(body, property) {
  const match = new RegExp(`${property}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)px`).exec(body);
  return match ? Number(match[1]) : null;
}

function lineFor(lineId) {
  return {
    "line-ab1a041f6266": "1",
    "line-eb7b47920390": "2",
    "line-d74614a04530": "3",
    "line-d812a5bc1e5f": "4",
  }[lineId];
}

function normalizeStationName(value) {
  return String(value).normalize("NFKC").replace(/\s+/g, "").replace(/\([^()]*\)$/, "");
}

function labelPolygonFor({ station, coordinate, label }) {
  const width = label.width;
  const lineHeight = label.lineHeight ?? 14;
  const estimatedTextWidth = [...normalizeStationName(station.stationName)].length * 12;
  const height = Math.max(14, Math.ceil(estimatedTextWidth / width) * lineHeight);
  const left = Math.max(0, Math.round(coordinate.left + label.left));
  const top = Math.max(0, Math.round(coordinate.top + label.top));
  const right = Math.max(0, Math.round(left + width));
  const bottom = Math.max(0, Math.round(top + height));
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
}

function comparePositions(left, right) {
  return compareStrings(left.lineId, right.lineId) || Number(left.stationCode) - Number(right.stationCode);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const expected = ["--html", "--css", "--topology", "--connectors", "--captured-at", "--output"];
  if (argv.length !== expected.length * 2 || expected.some((flag, index) => argv[index * 2] !== flag)
    || !path.isAbsolute(argv.at(-1))) {
    throw new Error("usage: collect-busan-route-map-positions.mjs --html <path> --css <path> --topology <json> --connectors <json> --captured-at <iso> --output <absolute.json>");
  }
  return Object.fromEntries(expected.map((flag, index) => [flag.slice(2), argv[index * 2 + 1]]));
}

async function main(argv) {
  const args = parseArgs(argv);
  const [html, css, topology, connectorEvidence] = await Promise.all([
    readFile(args.html),
    readFile(args.css),
    readFile(args.topology, "utf8").then(JSON.parse),
    readFile(args.connectors, "utf8").then(JSON.parse),
  ]);
  const snapshot = createBusanRouteMapPositionsSnapshot({
    html, css, topology, connectorEvidence, capturedAt: args["captured-at"],
  });
  await writeFile(args.output, `${JSON.stringify(snapshot)}\n`);
  console.log(`Busan route map positions collected: stations=${snapshot.stationCount}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Busan route map position collection failed");
    process.exitCode = 1;
  }
}
