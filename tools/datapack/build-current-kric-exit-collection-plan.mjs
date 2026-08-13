#!/usr/bin/env node
import { constants } from "node:fs";
import { lstat, open, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { providerLineScopesFor } from "./build-molit-nationwide-fixture.mjs";
import {
  admittedIncheonTopologyEvidence,
  materializeIncheonNetworkEdges,
} from "./build-datapack.mjs";
import { buildKricAccessibilityRoster } from "./collect-kric-accessibility-snapshots.mjs";
import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";
import {
  canonicalKricExitPathCollectionPlanJson,
  planKricExitPathCollection,
} from "./plan-kric-exit-path-collection.mjs";

const INPUT_KEYS = [
  "canonicalPackBytes",
  "coverageTargetsBytes",
  "providerCodeCatalogBytes",
  "routeRostersBytes",
  "sourceInventoryBytes",
  "incheonTopologyBytes",
];
const CANONICAL_PACK_KEYS = ["manifest", "migrationSourceArtifact", "packs"];
const CANONICAL_MANIFEST_KEYS = ["activePack", "channel", "keyId", "manifestVersion", "ttlSeconds"];
const CANONICAL_ACTIVE_PACK_KEYS = ["id", "version"];
const MIGRATION_SOURCE_KEYS = ["gzipSha256", "sqliteSha256"];
const TARGET_KEYS = [
  "activeLineScopeEvidence", "activeLineScopes", "artifactKind", "claimLedger", "coverageGoal",
  "evidenceSources", "expansionRoadmap", "inactiveLineExclusions", "knownSourceDomains",
  "railProductScope", "regions", "requiredSourceDomains", "roadmapConditionAxes",
  "roadmapEvidenceLedger", "roadmapGateCommands", "schemaVersion", "targetVersion",
];
const PROVIDER_CATALOG_KEYS = [
  "artifactKind", "capturedAt", "providerLines", "schemaVersion", "sourceId",
  "sourceSha256", "stationRecordCount",
];
const ROUTE_ROSTER_KEYS = [
  "artifactKind", "capturedAt", "credentialRedacted", "providerScopeCount", "providerScopes",
  "requestCount", "rosters", "schemaVersion", "sourceId", "targetVersion",
];
const ACTIVE_SCOPE_KEYS = ["lineId", "operatorId", "regionId"];
const PROVIDER_SCOPE_KEYS = [
  "lineId", "lnCd", "mreaWideCd", "operatorId", "railOprIsttCd", "regionId",
];
const REQUIRED_PACK_ARRAYS = ["lines", "networkEdges", "operators", "stationLines", "stations"];

export function buildCurrentKricExitCollectionPlan(input, { now = new Date() } = {}) {
  assertKeys(input, INPUT_KEYS, "current EXIT input keys");
  const sources = Object.fromEntries(INPUT_KEYS.map((key) => {
    const label = key.replace(/Bytes$/, "");
    const bytes = requireBytes(input[key], label);
    return [label, { bytes, sha256: sha256(bytes), value: parseJson(bytes, label) }];
  }));

  const pack = structuredClone(validateCanonicalPack(sources.canonicalPack.value));
  const targets = validateCoverageTargets(sources.coverageTargets.value);
  const providerCodeCatalog = validateProviderCodeCatalog(sources.providerCodeCatalog.value);
  const routeRosters = validateRouteRosters(sources.routeRosters.value, targets);
  const incheonAdmission = admittedIncheonTopologyEvidence({
    sourceInventory: sources.sourceInventory.value,
    snapshot: sources.incheonTopology.value,
    snapshotBytes: sources.incheonTopology.bytes,
    now,
  });
  materializeIncheonNetworkEdges(pack, sources.incheonTopology.value, incheonAdmission);

  const linesById = uniqueMap(pack.lines, "id", "canonical line");
  const activeLineIds = validateCandidateLinePartition(pack.lines, targets);
  const coverageScopes = uniqueMap(
    targets.activeLineScopes,
    (scope) => `${scope.regionId}\0${scope.operatorId}\0${scope.lineId}`,
    "active line scope",
  );
  const expectedProviderScopes = providerLineScopesFor(providerCodeCatalog, coverageScopes, linesById);
  if (canonicalJson(expectedProviderScopes) !== canonicalJson(routeRosters.providerScopes)) {
    throw new Error("KRIC provider scope set mismatch");
  }

  const stationById = uniqueMap(pack.stations, "id", "canonical station");
  const operatorById = uniqueMap(pack.operators, "id", "canonical operator");
  const canonicalStationLines = buildCanonicalStationLines(
    pack.stationLines.filter(({ lineId }) => activeLineIds.has(lineId)),
    stationById,
    linesById,
  );
  const roster = buildKricAccessibilityRoster({
    activeLineScopes: targets.activeLineScopes,
    fixture: { providerLineScopes: expectedProviderScopes },
    canonicalStationLines,
    routeRosters,
  });
  const providerScopeByTuple = uniqueMap(
    expectedProviderScopes,
    (scope) => `${scope.lineId}\0${scope.railOprIsttCd}\0${scope.lnCd}`,
    "provider line scope",
  );
  const providerTupleByStationLine = uniqueMap(
    roster,
    (tuple) => `${tuple.stationId}\0${tuple.lineId}`,
    "canonical station-line provider tuple",
  );

  const stationLines = canonicalStationLines.map((membership) => {
    const tuple = providerTupleByStationLine.get(`${membership.stationId}\0${membership.lineId}`);
    if (!tuple) throw new Error(`canonical station-line provider mapping missing: ${membership.stationId}/${membership.lineId}`);
    const scope = providerScopeByTuple.get(`${tuple.lineId}\0${tuple.railOprIsttCd}\0${tuple.lnCd}`);
    if (!scope) throw new Error(`provider line scope missing: ${tuple.lineId}/${tuple.railOprIsttCd}/${tuple.lnCd}`);
    const station = stationById.get(membership.stationId);
    const line = linesById.get(membership.lineId);
    const operator = operatorById.get(scope.operatorId);
    if (!operator) throw new Error(`canonical operator missing: ${scope.operatorId}`);
    return canonicalObject({
      stationId: membership.stationId,
      stationName: requiredString(station.nameKo, "canonical station name"),
      stationAliases: [],
      regionId: scope.regionId,
      lineId: membership.lineId,
      lineName: requiredString(line.nameKo, "canonical line name"),
      operatorId: scope.operatorId,
      operatorName: requiredString(operator.nameKo, "canonical operator name"),
    });
  }).sort(compareStationLines);
  const providerMappings = stationLines.map(({ stationId, lineId }) => {
    const tuple = providerTupleByStationLine.get(`${stationId}\0${lineId}`);
    return canonicalObject({
      stationId,
      lineId,
      providerOperatorId: tuple.railOprIsttCd,
      providerLineId: tuple.lnCd,
      providerStationId: tuple.stinCd,
    });
  }).sort(compareProviderMappings);
  const routeEdges = buildRouteEdges(pack.networkEdges, activeLineIds, new Set(
    stationLines.map(({ stationId, lineId }) => `${stationId}\0${lineId}`),
  ));
  const sourceIdentity = canonicalObject({
    canonicalPackSha256: sources.canonicalPack.sha256,
    coverageTargetsSha256: sources.coverageTargets.sha256,
    providerCodeCatalogSha256: sources.providerCodeCatalog.sha256,
    routeRostersSha256: sources.routeRosters.sha256,
    sourceInventorySha256: sources.sourceInventory.sha256,
    incheonTopologySha256: sources.incheonTopology.sha256,
  });
  const candidate = canonicalObject({
    candidateId: `current-production-exit-${sha256(Buffer.from(canonicalJson(sourceIdentity)))}`,
    stationSetSha256: sha256(Buffer.from(canonicalJson(
      [...new Set(stationLines.map(({ stationId }) => stationId))].sort(compareBytes),
    ))),
    stationLineSetSha256: sha256(Buffer.from(canonicalJson(stationLines.map(({
      stationId, lineId, operatorId,
    }) => ({ stationId, lineId, operatorId }))))),
    stationLineMappingSha256: sha256(Buffer.from(canonicalJson(stationLines))),
    providerMappingSha256: sha256(Buffer.from(canonicalJson(providerMappings))),
    topologySha256: sha256(Buffer.from(canonicalJson(routeEdges))),
  });
  const plan = planKricExitPathCollection({ candidate, stationLines, providerMappings, routeEdges });
  canonicalKricExitPathCollectionPlanJson(plan);
  return plan;
}

function validateCanonicalPack(value) {
  assertKeys(value, CANONICAL_PACK_KEYS, "canonical pack keys");
  if (!Array.isArray(value.packs) || value.packs.length !== 1) throw new Error("canonical pack must contain exactly one pack");
  const [pack] = value.packs;
  if (pack?.id !== "capital" || pack.version !== "1" || pack.artifactKind !== "production" || pack.schemaVersion !== "1") {
    throw new Error("canonical pack identity mismatch");
  }
  assertKeys(value.manifest, CANONICAL_MANIFEST_KEYS, "canonical pack manifest keys");
  if (value.manifest.manifestVersion !== 2 || value.manifest.channel !== "production"
    || !Number.isInteger(value.manifest.ttlSeconds) || value.manifest.ttlSeconds <= 0) {
    throw new Error("canonical pack manifest identity mismatch");
  }
  requiredString(value.manifest.keyId, "canonical pack manifest keyId");
  assertKeys(value.manifest.activePack, CANONICAL_ACTIVE_PACK_KEYS, "canonical pack active identity keys");
  if (value.manifest.activePack.id !== pack.id || value.manifest.activePack.version !== pack.version) {
    throw new Error("canonical pack active identity mismatch");
  }
  assertKeys(value.migrationSourceArtifact, MIGRATION_SOURCE_KEYS, "canonical pack migration source keys");
  for (const key of MIGRATION_SOURCE_KEYS) {
    if (!/^[a-f0-9]{64}$/.test(value.migrationSourceArtifact[key] ?? "")) {
      throw new Error("canonical pack migration source identity mismatch");
    }
  }
  for (const field of REQUIRED_PACK_ARRAYS) {
    if (!Array.isArray(pack[field]) || pack[field].length === 0) throw new Error(`canonical pack ${field} must be non-empty`);
  }
  return pack;
}

function validateCoverageTargets(value) {
  assertKeys(value, TARGET_KEYS, "coverage targets keys");
  if (value.schemaVersion !== 2 || value.artifactKind !== "nationwide-datapack-coverage-targets") {
    throw new Error("coverage targets identity mismatch");
  }
  requiredString(value.targetVersion, "coverage target version");
  if (!Array.isArray(value.activeLineScopes) || value.activeLineScopes.length === 0) {
    throw new Error("coverage targets activeLineScopes must be non-empty");
  }
  for (const scope of value.activeLineScopes) {
    assertKeys(scope, ACTIVE_SCOPE_KEYS, "active line scope keys");
    for (const key of ACTIVE_SCOPE_KEYS) requiredString(scope[key], `active line scope ${key}`);
  }
  return value;
}

function validateProviderCodeCatalog(value) {
  assertKeys(value, PROVIDER_CATALOG_KEYS, "provider code catalog keys");
  return value;
}

function validateCandidateLinePartition(lines, targets) {
  const packLineIds = new Set(lines.map((line) => requiredString(line?.id, "canonical line id")));
  if (packLineIds.size !== lines.length) throw new Error("duplicate canonical line id");
  const activeLineIds = new Set(targets.activeLineScopes.map(({ lineId }) => lineId));
  if (!Array.isArray(targets.inactiveLineExclusions)) throw new Error("inactive line exclusions must be an array");
  const inactiveLineIds = new Set();
  for (const exclusion of targets.inactiveLineExclusions) {
    const lineId = requiredString(exclusion?.lineId, "inactive line exclusion lineId");
    if (inactiveLineIds.has(lineId)) throw new Error(`duplicate inactive line exclusion: ${lineId}`);
    inactiveLineIds.add(lineId);
    if (exclusion.status !== "OUT_OF_ACTIVE_SCOPE" || exclusion.serviceLifecycle !== "RETIRED"
      || !/^\d{4}-\d{2}-\d{2}$/.test(exclusion.effectiveFrom ?? "")
      || !Number.isFinite(Date.parse(exclusion.verifiedAt))
      || typeof exclusion.reasonKo !== "string" || exclusion.reasonKo.trim() === ""
      || !/^source:[A-Za-z0-9._-]+$/.test(exclusion.evidenceRef ?? "")) {
      throw new Error(`inactive line exclusion evidence mismatch: ${lineId}`);
    }
  }
  for (const lineId of activeLineIds) {
    if (!packLineIds.has(lineId) || inactiveLineIds.has(lineId)) throw new Error("candidate line scope partition mismatch");
  }
  for (const lineId of inactiveLineIds) {
    if (!packLineIds.has(lineId)) throw new Error("candidate line scope partition mismatch");
  }
  for (const lineId of packLineIds) {
    if (activeLineIds.has(lineId) === inactiveLineIds.has(lineId)) {
      throw new Error("candidate line scope partition mismatch");
    }
  }
  return activeLineIds;
}

function validateRouteRosters(value, targets) {
  assertKeys(value, ROUTE_ROSTER_KEYS, "route roster keys");
  if (value.schemaVersion !== 1 || value.artifactKind !== "kric-nationwide-route-rosters"
    || value.sourceId !== "kric-subway-route-info" || value.credentialRedacted !== true
    || value.targetVersion !== targets.targetVersion || !Number.isFinite(Date.parse(value.capturedAt))) {
    throw new Error("route roster identity mismatch");
  }
  if (!Array.isArray(value.providerScopes) || value.providerScopes.length === 0
    || !Array.isArray(value.rosters) || value.rosters.length === 0
    || value.providerScopeCount !== value.providerScopes.length || value.requestCount !== value.rosters.length) {
    throw new Error("route roster coverage mismatch");
  }
  for (const scope of value.providerScopes) {
    assertKeys(scope, PROVIDER_SCOPE_KEYS, "provider scope keys");
    for (const key of PROVIDER_SCOPE_KEYS) requiredString(scope[key], `provider scope ${key}`);
  }
  return value;
}

function buildCanonicalStationLines(rows, stationById, linesById) {
  const seen = new Set();
  return rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("canonical station-line must be an object");
    const stationId = requiredString(row.stationId, "canonical station-line stationId");
    const lineId = requiredString(row.lineId, "canonical station-line lineId");
    if (!stationById.has(stationId) || !linesById.has(lineId)) throw new Error("canonical station-line identity mismatch");
    const key = `${stationId}\0${lineId}`;
    if (seen.has(key)) throw new Error(`duplicate canonical station-line: ${stationId}/${lineId}`);
    seen.add(key);
    const station = stationById.get(stationId);
    return {
      artifactId: "production-capital",
      stationId,
      lineId,
      stationCode: typeof row.stationCode === "string" ? row.stationCode : "",
      names: [requiredString(station.nameKo, "canonical station name")],
    };
  }).sort((left, right) => compareBytes(left.stationId, right.stationId) || compareBytes(left.lineId, right.lineId));
}

function buildRouteEdges(rows, activeLineIds, stationLineKeys) {
  const routeEdges = [];
  for (const edge of rows) {
    if (edge?.edgeType !== "RIDE" || edge.servicePattern !== "LOCAL" || edge.serviceClass !== "SUBWAY") continue;
    const from = parseRouteNode(edge.fromNodeId, "from");
    const to = parseRouteNode(edge.toNodeId, "to");
    if (from.lineId !== to.lineId) throw new Error("route edge station-line mismatch");
    if (!activeLineIds.has(from.lineId)) continue;
    if (!stationLineKeys.has(`${from.stationId}\0${from.lineId}`)
      || !stationLineKeys.has(`${to.stationId}\0${to.lineId}`)) {
      throw new Error("route edge station-line mismatch");
    }
    routeEdges.push(canonicalObject({
      routeEdgeId: requiredString(edge.id, "route edge id"),
      fromStationId: from.stationId,
      toStationId: to.stationId,
      lineId: from.lineId,
      edgeType: edge.edgeType,
      servicePattern: edge.servicePattern,
      serviceClass: edge.serviceClass,
    }));
  }
  if (routeEdges.length === 0) throw new Error("canonical LOCAL RIDE topology must be non-empty");
  return routeEdges.sort(compareRouteEdges);
}

function parseRouteNode(value, label) {
  const raw = requiredString(value, `route edge ${label} node`);
  const parts = raw.split(":");
  if (parts.length !== 2 || parts.some((part) => part === "")) throw new Error("route edge station-line mismatch");
  return { stationId: parts[0], lineId: parts[1] };
}

function uniqueMap(values, keyOrField, label) {
  if (!Array.isArray(values) || values.length === 0) throw new Error(`${label} must be a non-empty array`);
  const keyFor = typeof keyOrField === "function" ? keyOrField : (value) => value?.[keyOrField];
  const result = new Map();
  for (const value of values) {
    const key = requiredString(keyFor(value), `${label} identity`);
    if (result.has(key)) throw new Error(`duplicate ${label}: ${key.replaceAll("\0", "/")}`);
    result.set(key, value);
  }
  return result;
}

function requireBytes(value, label) {
  if (!Buffer.isBuffer(value) || value.length === 0) throw new Error(`${label} bytes must be non-empty`);
  return value;
}

function parseJson(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} must be strict UTF-8 JSON`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} must be strict UTF-8 JSON`);
  }
}

function assertKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} mismatch`);
  const actual = Object.keys(value).sort(compareBytes);
  const expected = [...keys].sort(compareBytes);
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`${label} mismatch`);
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be non-blank`);
  return value;
}

function canonicalObject(value) {
  return JSON.parse(canonicalJson(value));
}

function compareStationLines(left, right) {
  return compareBytes(left.stationId, right.stationId)
    || compareBytes(left.lineId, right.lineId)
    || compareBytes(left.operatorId, right.operatorId);
}

function compareProviderMappings(left, right) {
  return compareBytes(left.stationId, right.stationId) || compareBytes(left.lineId, right.lineId);
}

function compareRouteEdges(left, right) {
  return compareBytes(left.routeEdgeId, right.routeEdgeId);
}

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function parseArgs(argv) {
  const flags = [
    "canonical-pack", "coverage-targets", "provider-code-catalog", "route-rosters",
    "source-inventory", "incheon-topology", "output",
  ];
  if (argv.length !== flags.length * 2) throw new Error("EXIT collection-plan arguments mismatch");
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]?.replace(/^--/, "");
    if (!flags.includes(flag) || result[flag] !== undefined) throw new Error("EXIT collection-plan arguments mismatch");
    const value = argv[index + 1];
    if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`--${flag} must be an absolute path`);
    result[flag] = path.resolve(value);
  }
  if (flags.some((flag) => result[flag] === undefined)) throw new Error("EXIT collection-plan arguments mismatch");
  return result;
}

export async function readRegularSnapshot(target, label, { openImpl = open } = {}) {
  if (!Number.isInteger(constants.O_NOFOLLOW)) throw new Error(`${label} cannot enforce O_NOFOLLOW`);
  let handle;
  try {
    handle = await openImpl(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`${label} must be a regular file`, { cause: error });
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameIdentity(before, after) || bytes.length !== after.size) throw new Error(`${label} changed during read`);
    return { target, label, bytes, identity: identity(after) };
  } finally {
    await handle.close();
  }
}

async function assertSnapshotUnchanged(snapshot) {
  const current = await lstat(snapshot.target);
  if (!sameIdentity(snapshot.identity, current)) throw new Error(`${snapshot.label} changed during generation`);
}

function identity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mode: stat.mode,
  };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.mode === right.mode;
}

async function outputMustBeAbsent(target) {
  try {
    await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("output must be absent");
}

export async function main(argv, { log = console.log, now = new Date() } = {}) {
  const args = parseArgs(argv);
  const outputParent = await lstat(path.dirname(args.output));
  if (!outputParent.isDirectory() || outputParent.isSymbolicLink()) throw new Error("output parent must be a regular directory");
  await outputMustBeAbsent(args.output);
  const entries = await Promise.all([
    ["canonicalPack", "canonical-pack"],
    ["coverageTargets", "coverage-targets"],
    ["providerCodeCatalog", "provider-code-catalog"],
    ["routeRosters", "route-rosters"],
    ["sourceInventory", "source-inventory"],
    ["incheonTopology", "incheon-topology"],
  ].map(async ([key, flag]) => [key, await readRegularSnapshot(args[flag], flag)]));
  const snapshots = Object.fromEntries(entries);
  const plan = buildCurrentKricExitCollectionPlan(Object.fromEntries(
    Object.entries(snapshots).map(([key, snapshot]) => [`${key}Bytes`, snapshot.bytes]),
  ), { now });
  await Promise.all(Object.values(snapshots).map(assertSnapshotUnchanged));
  await outputMustBeAbsent(args.output);
  const bytes = Buffer.from(canonicalKricExitPathCollectionPlanJson(plan));
  await writeFile(args.output, bytes, { flag: "wx", mode: 0o600 });
  log(`current KRIC EXIT collection plan ready: queries=${plan.queryPlan.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "current KRIC EXIT collection plan failed");
    process.exitCode = 1;
  }
}
