#!/usr/bin/env node
import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";
import { KRIC_STATION_TUPLE_MAPPINGS } from "./collect-kric-accessibility-snapshots.mjs";
import { providerLineScopesFor, validateKricProviderCodeCatalogIdentity } from "./build-molit-nationwide-fixture.mjs";

const INPUT_KEYS = [
  "canonicalPackBytes",
  "coverageTargetsBytes",
  "providerCodeCatalogBytes",
  "routeRostersBytes",
  "sourceInventoryBytes",
];
const SOURCE_ID = "kric-station-convenience-standard";
const EXPECTED = Object.freeze({ stationLineCount: 213, stationCount: 199, providerTupleCount: 213 });
const TARGET_KEYS = [
  "activeLineScopeEvidence", "activeLineScopes", "artifactKind", "claimLedger", "coverageGoal",
  "evidenceSources", "expansionRoadmap", "inactiveLineExclusions", "knownSourceDomains",
  "railProductScope", "regions", "requiredSourceDomains", "roadmapConditionAxes",
  "roadmapEvidenceLedger", "roadmapGateCommands", "schemaVersion", "targetVersion",
];
const PROVIDER_CATALOG_KEYS = ["artifactKind", "capturedAt", "providerLines", "schemaVersion", "sourceId", "sourceSha256", "stationRecordCount"];
const ROUTE_ROSTER_KEYS = ["artifactKind", "capturedAt", "credentialRedacted", "providerScopeCount", "providerScopes", "requestCount", "rosters", "schemaVersion", "sourceId", "targetVersion"];
const OUTPUT_KEYS = [
  "schemaVersion", "artifactKind", "coverage", "sourceIdentity", "stationLineProviderMappings", "counts", "planSha256",
];
const CANONICAL_INPUTS = Object.freeze({
  canonicalPackBytes: "tools/datapack/release/capital-production-canonical-pack.json",
  coverageTargetsBytes: "tools/datapack/nationwide-coverage-targets.json",
  providerCodeCatalogBytes: "tools/datapack/sources/kric-provider-code-catalog-20260228.json",
  routeRostersBytes: "tools/datapack/sources/kric-nationwide-route-rosters-20260730T203926676Z.json",
  sourceInventoryBytes: "tools/datapack/source-inventory.json",
});

export function buildCurrentCapitalFacilityCollectionPlan(input) {
  assertInput(input);
  const sources = Object.fromEntries(INPUT_KEYS.map((key) => {
    const bytes = requireBytes(input[key], key);
    return [key, { bytes, sha256: sha256(bytes), value: parseJson(bytes, key) }];
  }));
  const pack = canonicalCapitalPack(sources.canonicalPackBytes.value);
  const coverageTargets = validateCoverageTargets(sources.coverageTargetsBytes.value);
  const coverage = productionMembershipCoverage(pack);
  validateFacilitySource(sources.sourceInventoryBytes.value);
  const catalog = validateProviderCatalog(sources.providerCodeCatalogBytes.value);
  const rosters = validateRouteRosters(sources.routeRostersBytes.value, coverageTargets.targetVersion);
  const stationById = uniqueMap(pack.stations, "id", "canonical station");
  const linesById = uniqueMap(pack.lines, "id", "canonical line");

  const selectedLines = pack.lines.filter(({ operatorId }) => operatorId === coverage.operatorId);
  if (selectedLines.length === 0 || selectedLines.some((line) => line.serviceLifecycle !== undefined && line.serviceLifecycle !== "ACTIVE")) {
    throw new Error("capital FACILITY line scope is inactive or empty");
  }
  const selectedLineIds = new Set(selectedLines.map(({ id }) => id));
  assertActiveTargetPartition(coverageTargets, selectedLineIds, pack.lines);
  const targets = selectTargets(pack.stationLines, selectedLineIds, stationById, linesById, coverage);
  const rosterByRequest = uniqueMap(rosters.rosters, ({ mreaWideCd, lnCd }) => `${mreaWideCd}\0${lnCd}`, "KRIC route roster");
  assertTargetProviderScopeIdentity({ coverageTargets, catalog, linesById, routeProviderScopes: rosters.providerScopes, selectedLineIds });
  const scopeByLine = selectProviderScopes(rosters.providerScopes, selectedLines, coverage);
  const catalogTuples = new Set(catalog.providerLines.map(({ railOprIsttCd, lnCd }) => `${railOprIsttCd}\0${lnCd}`));
  const providerTuplesByLine = providerScopeTuplesByLine(rosters.providerScopes, selectedLineIds, coverage);
  const mappings = bindProviderTuples({ targets, scopeByLine, providerTuplesByLine, rosterByRequest, catalogTuples });

  const counts = canonicalObject({
    stationLineCount: targets.length,
    stationCount: new Set(targets.map(({ stationId }) => stationId)).size,
    providerTupleCount: new Set(mappings.map(providerTupleKey)).size,
  });
  for (const [key, expected] of Object.entries(EXPECTED)) {
    if (counts[key] !== expected) throw new Error(`capital FACILITY ${key} mismatch: ${counts[key]}`);
  }
  const payload = canonicalObject({
    schemaVersion: 1,
    artifactKind: "capital-facility-collection-plan",
    coverage,
    sourceIdentity: canonicalObject({
      canonicalPackSha256: sources.canonicalPackBytes.sha256,
      coverageTargetsSha256: sources.coverageTargetsBytes.sha256,
      providerCodeCatalogSha256: sources.providerCodeCatalogBytes.sha256,
      routeRostersSha256: sources.routeRostersBytes.sha256,
      sourceInventorySha256: sources.sourceInventoryBytes.sha256,
    }),
    stationLineProviderMappings: mappings,
    counts,
  });
  return canonicalObject({ ...payload, planSha256: sha256(Buffer.from(canonicalJson(payload))) });
}

export function canonicalCurrentCapitalFacilityCollectionPlanJson(value) {
  assertKeys(value, OUTPUT_KEYS, "capital FACILITY collection plan");
  if (value.schemaVersion !== 1 || value.artifactKind !== "capital-facility-collection-plan") {
    throw new Error("capital FACILITY collection plan identity mismatch");
  }
  validatePlanPayload(value);
  assertSha256(value.planSha256, "capital FACILITY collection plan digest");
  const { planSha256, ...payload } = value;
  if (sha256(Buffer.from(canonicalJson(payload))) !== planSha256) {
    throw new Error("capital FACILITY collection plan digest mismatch");
  }
  return `${canonicalJson(value)}\n`;
}

export async function main(argv, { log = console.log } = {}) {
  const { repositoryRoot, output } = parseArguments(argv);
  const root = await regularDirectory(repositoryRoot, "repository root");
  const outputPath = await externalAbsentOutput(root, output);
  const input = Object.fromEntries(await Promise.all(Object.entries(CANONICAL_INPUTS).map(async ([key, relative]) => [
    key,
    await readStableRegularInput(root, relative),
  ])));
  const bytes = Buffer.from(canonicalCurrentCapitalFacilityCollectionPlanJson(
    buildCurrentCapitalFacilityCollectionPlan(input),
  ));
  await exclusiveWrite(outputPath, bytes);
  log(JSON.stringify({ planSha256: sha256(bytes), output: outputPath }));
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 4 || argv[0] !== "--repository-root" || argv[2] !== "--output") {
    throw new Error("usage: --repository-root <absolute-path> --output <absolute-path>");
  }
  for (const [value, label] of [[argv[1], "repository root"], [argv[3], "output"]]) {
    if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  }
  return { repositoryRoot: path.resolve(argv[1]), output: path.resolve(argv[3]) };
}

async function regularDirectory(value, label) {
  const initial = await lstat(value).catch(() => { throw new Error(`${label} must be a regular non-symlink directory`); });
  if (!initial.isDirectory() || initial.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink directory`);
  const resolved = await realpath(value);
  const current = await lstat(resolved);
  if (!current.isDirectory() || current.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink directory`);
  return resolved;
}

async function externalAbsentOutput(root, output) {
  const parent = path.dirname(output);
  const initial = await lstat(parent).catch(() => { throw new Error("output parent must be a regular non-symlink directory"); });
  if (!initial.isDirectory() || initial.isSymbolicLink()) throw new Error("output parent must be a regular non-symlink directory");
  const resolvedParent = await realpath(parent);
  const current = await lstat(resolvedParent);
  if (!current.isDirectory() || current.isSymbolicLink() || resolvedParent !== parent) {
    throw new Error("output parent must be a regular non-symlink directory");
  }
  const target = path.join(resolvedParent, path.basename(output));
  if (within(root, target)) throw new Error("output must stay outside repository root");
  await lstat(target).then(() => { throw new Error("output must not already exist"); }).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  return target;
}

async function readStableRegularInput(root, relative) {
  if (!Number.isInteger(constants.O_NOFOLLOW)) throw new Error("canonical input cannot enforce O_NOFOLLOW");
  const target = path.join(root, relative);
  const pathBefore = await lstat(target).catch(() => { throw new Error(`canonical input is not a regular file: ${relative}`); });
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || await realpath(target) !== target) {
    throw new Error(`canonical input is not a regular file: ${relative}`);
  }
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameIdentity(pathBefore, before)) {
      throw new Error(`canonical input changed while reading: ${relative}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(target).catch(() => { throw new Error(`canonical input changed while reading: ${relative}`); });
    if (!sameFile(before, after) || !sameFile(after, pathAfter) || bytes.length !== before.size) {
      throw new Error(`canonical input changed while reading: ${relative}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function exclusiveWrite(target, bytes) {
  if (!Number.isInteger(constants.O_NOFOLLOW)) throw new Error("output cannot enforce O_NOFOLLOW");
  let handle;
  try {
    handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("output must not already exist");
    throw error;
  }
  let reserved;
  let completed = false;
  try {
    reserved = await handle.stat();
    await handle.writeFile(bytes);
    await handle.sync();
    const after = await handle.stat();
    const pathAfter = await lstat(target).catch(() => { throw new Error("output changed while writing"); });
    if (!sameIdentity(reserved, after) || !sameIdentity(after, pathAfter) || after.size !== bytes.length) {
      throw new Error("output changed while writing");
    }
    completed = true;
  } finally {
    await handle.close().catch(() => {});
    if (completed) return;
    const current = await lstat(target).catch(() => null);
    if (current && sameIdentity(reserved, current)) await unlink(target);
  }
}

function sameFile(left, right) {
  return sameIdentity(left, right) && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function within(root, target) { return target === root || target.startsWith(`${root}${path.sep}`); }

function validatePlanPayload(value) {
  assertKeys(value.coverage, ["operatorId", "regionId", "sourceDomain", "sourceIds"], "capital FACILITY coverage");
  if (value.coverage.regionId !== "capital" || value.coverage.operatorId !== "seoul-metro"
    || value.coverage.sourceDomain !== "station_line_membership"
    || canonicalJson(value.coverage.sourceIds) !== canonicalJson(["molit-urban-rail-full-route", "seoulmetro-station-line-info"])) {
    throw new Error("capital FACILITY coverage identity mismatch");
  }
  assertKeys(value.sourceIdentity, ["canonicalPackSha256", "coverageTargetsSha256", "providerCodeCatalogSha256", "routeRostersSha256", "sourceInventorySha256"], "capital FACILITY source identity");
  for (const field of Object.keys(value.sourceIdentity)) assertSha256(value.sourceIdentity[field], `capital FACILITY ${field}`);
  assertKeys(value.counts, ["providerTupleCount", "stationCount", "stationLineCount"], "capital FACILITY counts");
  if (canonicalJson(value.counts) !== canonicalJson(EXPECTED) || !Array.isArray(value.stationLineProviderMappings)
    || value.stationLineProviderMappings.length !== EXPECTED.stationLineCount) {
    throw new Error("capital FACILITY count mismatch");
  }
  const stationLineKeys = new Set();
  const providerTupleKeys = new Set();
  const stations = new Set();
  let previous;
  for (const mapping of value.stationLineProviderMappings) {
    assertKeys(mapping, ["lineId", "operatorId", "providerLineId", "providerOperatorId", "providerStationId", "regionId", "stationId"], "capital FACILITY mapping");
    if (mapping.regionId !== "capital" || mapping.operatorId !== "seoul-metro") throw new Error("capital FACILITY mapping scope mismatch");
    for (const field of Object.keys(mapping)) requiredString(mapping[field], `capital FACILITY mapping ${field}`);
    const stationLineKey = `${mapping.stationId}\0${mapping.lineId}`;
    const providerTuple = providerTupleKey(mapping);
    if (stationLineKeys.has(stationLineKey) || providerTupleKeys.has(providerTuple)) throw new Error("capital FACILITY mapping duplicate");
    const current = `${mapping.stationId}\0${mapping.lineId}\0${providerTuple}`;
    if (previous !== undefined && compare(previous, current) >= 0) throw new Error("capital FACILITY mapping order mismatch");
    previous = current;
    stationLineKeys.add(stationLineKey);
    providerTupleKeys.add(providerTuple);
    stations.add(mapping.stationId);
  }
  if (stationLineKeys.size !== EXPECTED.stationLineCount || providerTupleKeys.size !== EXPECTED.providerTupleCount
    || stations.size !== EXPECTED.stationCount) throw new Error("capital FACILITY mapping cardinality mismatch");
}

function canonicalCapitalPack(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.packs) || value.packs.length !== 1) {
    throw new Error("canonical capital pack identity mismatch");
  }
  const pack = value.packs[0];
  if (pack?.id !== "capital" || pack.version !== "1" || pack.artifactKind !== "production" || pack.schemaVersion !== "1"
    || value.manifest?.channel !== "production" || value.manifest?.activePack?.id !== "capital" || value.manifest?.activePack?.version !== "1") {
    throw new Error("canonical capital pack identity mismatch");
  }
  for (const key of ["stations", "stationLines", "lines", "operators"]) {
    if (!Array.isArray(pack[key]) || pack[key].length === 0) throw new Error(`canonical capital ${key} is required`);
  }
  return pack;
}

function productionMembershipCoverage(pack) {
  let evidence;
  try { evidence = JSON.parse(pack.metadata?.productionCoverageEvidence); } catch { throw new Error("production coverage membership evidence mismatch"); }
  if (!Array.isArray(evidence)) throw new Error("production coverage membership evidence mismatch");
  const matches = evidence.filter((row) => row?.regionId === "capital" && row?.operatorId === "seoul-metro"
    && row?.sourceDomain === "station_line_membership");
  if (matches.length !== 1 || !Array.isArray(matches[0].sourceIds)
    || canonicalJson([...new Set(matches[0].sourceIds)].sort(compare)) !== canonicalJson(["molit-urban-rail-full-route", "seoulmetro-station-line-info"])) {
    throw new Error("production coverage membership evidence mismatch");
  }
  return canonicalObject({
    regionId: matches[0].regionId,
    operatorId: matches[0].operatorId,
    sourceDomain: matches[0].sourceDomain,
    sourceIds: [...matches[0].sourceIds].sort(compare),
  });
}

function validateCoverageTargets(value) {
  assertKeys(value, TARGET_KEYS, "coverage targets");
  if (value.schemaVersion !== 2 || value.artifactKind !== "nationwide-datapack-coverage-targets"
    || !Array.isArray(value.activeLineScopes) || value.activeLineScopes.length === 0
    || !Array.isArray(value.inactiveLineExclusions) || value.inactiveLineExclusions.length === 0
    || typeof value.targetVersion !== "string" || value.targetVersion === "") {
    throw new Error("coverage targets identity mismatch");
  }
  const evidence = value.activeLineScopeEvidence;
  if (evidence?.serviceLifecycle !== "ACTIVE" || !/^\d{4}-\d{2}-\d{2}$/.test(evidence.effectiveFrom ?? "")
    || !Number.isFinite(Date.parse(evidence.verifiedAt)) || !/^source:[A-Za-z0-9._-]+$/.test(evidence.evidenceRef ?? "")) {
    throw new Error("active coverage scope evidence mismatch");
  }
  uniqueMap(value.activeLineScopes, (scope) => `${requiredString(scope?.regionId, "active scope region")}\0${requiredString(scope?.operatorId, "active scope operator")}\0${requiredString(scope?.lineId, "active scope line")}`, "active coverage scope");
  for (const exclusion of value.inactiveLineExclusions) {
    if (typeof exclusion?.lineId !== "string" || exclusion.lineId === "" || exclusion.status !== "OUT_OF_ACTIVE_SCOPE"
      || exclusion.serviceLifecycle !== "RETIRED" || !/^\d{4}-\d{2}-\d{2}$/.test(exclusion.effectiveFrom ?? "")
      || !Number.isFinite(Date.parse(exclusion.verifiedAt)) || !/^source:[A-Za-z0-9._-]+$/.test(exclusion.evidenceRef ?? "")) {
      throw new Error("inactive coverage exclusion mismatch");
    }
  }
  if (new Set(value.inactiveLineExclusions.map(({ lineId }) => lineId)).size !== value.inactiveLineExclusions.length) {
    throw new Error("duplicate inactive coverage exclusion");
  }
  return value;
}

function assertTargetProviderScopeIdentity({ coverageTargets, catalog, linesById, routeProviderScopes, selectedLineIds }) {
  const targetScopes = coverageTargets.activeLineScopes.filter(({ lineId }) => selectedLineIds.has(lineId));
  const byIdentity = uniqueMap(targetScopes, (scope) => `${scope.regionId}\0${scope.operatorId}\0${scope.lineId}`, "target active provider scope");
  const expected = providerLineScopesFor(catalog, byIdentity, linesById);
  const actual = routeProviderScopes.filter(({ lineId }) => selectedLineIds.has(lineId)).sort(compareProviderScope);
  if (canonicalJson(expected) !== canonicalJson(actual)) throw new Error("KRIC target provider scope identity mismatch");
}

function assertActiveTargetPartition(targets, targetLineIds, lines) {
  const activeByLine = new Map();
  for (const scope of targets.activeLineScopes) {
    const values = activeByLine.get(scope.lineId) ?? [];
    values.push(scope);
    activeByLine.set(scope.lineId, values);
  }
  const inactiveLineIds = new Set(targets.inactiveLineExclusions.map(({ lineId }) => lineId));
  const linesById = uniqueMap(lines, "id", "canonical line");
  for (const lineId of targetLineIds) {
    const line = linesById.get(lineId);
    const candidates = (activeByLine.get(lineId) ?? []).filter(({ regionId }) => regionId === "capital");
    const ownerMatches = candidates.filter(({ operatorId }) => operatorId === line.operatorId);
    const selected = ownerMatches.length === 1 ? ownerMatches : candidates.length === 1 ? candidates : [];
    if (inactiveLineIds.has(lineId) || selected.length !== 1) {
      throw new Error(`capital FACILITY active target partition mismatch: ${lineId}`);
    }
  }
  for (const lineId of inactiveLineIds) {
    if (activeByLine.has(lineId) || linesById.has(lineId)) throw new Error("coverage target active/inactive partition mismatch");
  }
}

function validateFacilitySource(value) {
  const source = value?.sources?.filter(({ id }) => id === SOURCE_ID);
  if (!Array.isArray(source) || source.length !== 1 || source[0].productionUseAllowed !== true
    || source[0].requiredForProductionPack !== true || source[0].capabilities?.facility?.status !== "SUPPORTED"
    || source[0].capabilities.facility.productionUseAllowed !== true
    || source[0].license?.commercialUseAllowed !== true || source[0].license?.derivativeWorkAllowed !== true
    || source[0].license?.redistributionAllowed !== true || typeof source[0].license?.attribution !== "string"
    || source[0].license.attribution.trim() === "" || source[0].admissionEvidence?.decision !== "APPROVED"
    || source[0].accessibilityAdmissionEvidence?.decision !== "APPROVED"
    || source[0].accessibilityAdmissionEvidence.productionUseAllowed !== true
    || source[0].accessibilityAdmissionEvidence.licenseEvidenceHash !== source[0].admissionEvidence.licenseEvidenceHash) {
    throw new Error("KRIC FACILITY source admission mismatch");
  }
  assertSha256(source[0].admissionEvidence.licenseEvidenceHash, "KRIC FACILITY license evidence");
}

function validateProviderCatalog(value) {
  assertKeys(value, PROVIDER_CATALOG_KEYS, "KRIC provider catalog");
  if (value?.schemaVersion !== 1 || value.artifactKind !== "kric-provider-line-catalog"
    || value.sourceId !== "kric-provider-code-catalog-20260228" || !Array.isArray(value.providerLines)
    || !Number.isInteger(value.stationRecordCount) || value.stationRecordCount < 1 || !Number.isFinite(Date.parse(value.capturedAt))
    || !/^[a-f0-9]{64}$/.test(value.sourceSha256 ?? "")) {
    throw new Error("KRIC provider catalog identity mismatch");
  }
  validateKricProviderCodeCatalogIdentity(value);
  uniqueMap(value.providerLines, ({ railOprIsttCd, lnCd }) => `${requiredString(railOprIsttCd, "provider operator")}\0${requiredString(lnCd, "provider line")}`, "KRIC provider catalog tuple");
  return value;
}

function validateRouteRosters(value, targetVersion) {
  assertKeys(value, ROUTE_ROSTER_KEYS, "KRIC route rosters");
  if (value?.schemaVersion !== 1 || value.artifactKind !== "kric-nationwide-route-rosters"
    || value.sourceId !== "kric-subway-route-info" || value.credentialRedacted !== true
    || !Array.isArray(value.providerScopes) || !Array.isArray(value.rosters)
    || !Number.isFinite(Date.parse(value.capturedAt)) || value.targetVersion !== targetVersion
    || value.providerScopeCount !== value.providerScopes.length || value.requestCount !== value.rosters.length) {
    throw new Error("KRIC route roster identity mismatch");
  }
  uniqueMap(value.providerScopes, (scope) => ["lineId", "regionId", "operatorId", "mreaWideCd", "lnCd", "railOprIsttCd"]
    .map((field) => requiredString(scope?.[field], `KRIC provider scope ${field}`)).join("\0"), "KRIC provider scope");
  uniqueMap(value.rosters, (roster) => `${requiredString(roster?.mreaWideCd, "KRIC roster region")}\0${requiredString(roster?.lnCd, "KRIC roster line")}`, "KRIC route roster");
  return value;
}

function selectTargets(rows, selectedLineIds, stationById, linesById, coverage) {
  const seen = new Set();
  const targets = [];
  for (const row of rows) {
    const stationId = requiredString(row?.stationId, "canonical station-line station");
    const lineId = requiredString(row?.lineId, "canonical station-line line");
    if (!selectedLineIds.has(lineId)) continue;
    const station = stationById.get(stationId);
    const line = linesById.get(lineId);
    if (!station || !line || line.operatorId !== coverage.operatorId) throw new Error("canonical station-line identity mismatch");
    const key = `${stationId}\0${lineId}`;
    if (seen.has(key)) throw new Error(`duplicate canonical station-line: ${stationId}/${lineId}`);
    seen.add(key);
    targets.push(canonicalObject({ stationId, lineId, regionId: coverage.regionId, operatorId: coverage.operatorId, stationName: requiredString(station.nameKo, "canonical station name") }));
  }
  if (targets.length === 0) throw new Error("capital FACILITY target membership is empty");
  return targets.sort(compareTarget);
}

function selectProviderScopes(scopes, selectedLines, coverage) {
  const selected = new Map();
  for (const line of selectedLines) {
    const candidates = scopes.filter((scope) => scope?.lineId === line.id && scope?.regionId === coverage.regionId);
    const operatorMatches = candidates.filter((scope) => scope.operatorId === coverage.operatorId);
    const eligible = operatorMatches.length === 1 ? operatorMatches : candidates.length === 1 ? candidates : [];
    if (eligible.length !== 1) throw new Error(`KRIC provider scope is ambiguous: ${line.id}`);
    const scope = eligible[0];
    for (const key of ["mreaWideCd", "lnCd", "railOprIsttCd"]) requiredString(scope[key], `KRIC provider scope ${key}`);
    selected.set(line.id, scope);
  }
  return selected;
}

function providerScopeTuplesByLine(scopes, selectedLineIds, coverage) {
  const result = new Map();
  for (const scope of scopes) {
    if (!selectedLineIds.has(scope?.lineId)) continue;
    if (scope.regionId !== coverage.regionId) throw new Error(`KRIC provider scope region mismatch: ${scope.lineId}`);
    const tuple = `${requiredString(scope.railOprIsttCd, "KRIC provider scope operator")}\0${requiredString(scope.lnCd, "KRIC provider scope line")}`;
    const values = result.get(scope.lineId) ?? new Set();
    values.add(tuple);
    result.set(scope.lineId, values);
  }
  if (result.size !== selectedLineIds.size || [...selectedLineIds].some((lineId) => !result.has(lineId))) {
    throw new Error("KRIC provider scope coverage mismatch");
  }
  return result;
}

function bindProviderTuples({ targets, scopeByLine, providerTuplesByLine, rosterByRequest, catalogTuples }) {
  const targetByLineAndName = new Map();
  for (const target of targets) {
    const key = `${target.lineId}\0${normalizeStationName(target.stationName)}`;
    const matches = targetByLineAndName.get(key) ?? [];
    matches.push(target);
    targetByLineAndName.set(key, matches);
  }
  const mappingByTarget = new Map();
  for (const [lineId, scope] of scopeByLine) {
    const roster = rosterByRequest.get(`${scope.mreaWideCd}\0${scope.lnCd}`);
    if (!roster || roster.resultCode !== "00" || !Array.isArray(roster.stations)) {
      throw new Error(`KRIC route roster missing: ${scope.mreaWideCd}/${scope.lnCd}`);
    }
    for (const station of roster.stations) {
      const key = `${lineId}\0${normalizeStationName(station?.stinNm)}`;
      const targetsForName = targetByLineAndName.get(key) ?? [];
      if (targetsForName.length === 0) continue;
      if (targetsForName.length !== 1) throw new Error(`ambiguous canonical KRIC station join: ${lineId}/${station.stinNm}`);
      for (const field of ["railOprIsttCd", "lnCd", "stinCd"]) requiredString(station[field], `KRIC roster ${field}`);
      const providerLineTuple = `${station.railOprIsttCd}\0${station.lnCd}`;
      if (station.lnCd !== scope.lnCd || !catalogTuples.has(providerLineTuple)
        || !providerTuplesByLine.get(lineId)?.has(providerLineTuple)) {
        throw new Error(`KRIC provider tuple identity mismatch: ${lineId}/${station.stinNm}`);
      }
      const target = targetsForName[0];
      const targetKey = `${target.stationId}\0${target.lineId}`;
      const mapping = canonicalObject({
        stationId: target.stationId, lineId: target.lineId, regionId: target.regionId, operatorId: target.operatorId,
        providerOperatorId: station.railOprIsttCd, providerLineId: station.lnCd, providerStationId: station.stinCd,
      });
      const existing = mappingByTarget.get(targetKey);
      if (existing && canonicalJson(existing) !== canonicalJson(mapping)) {
        throw new Error(`ambiguous canonical KRIC station join: ${lineId}/${station.stinNm}`);
      }
      if (existing) throw new Error(`duplicate KRIC provider tuple: ${lineId}/${station.stinNm}`);
      mappingByTarget.set(targetKey, mapping);
    }
  }
  for (const tuple of KRIC_STATION_TUPLE_MAPPINGS) {
    const targetKey = `${tuple.stationId}\0${tuple.lineId}`;
    if (mappingByTarget.has(targetKey) || !scopeByLine.has(tuple.lineId)) continue;
    const scope = scopeByLine.get(tuple.lineId);
    const roster = rosterByRequest.get(`${scope.mreaWideCd}\0${scope.lnCd}`);
    const exactProviderTuple = `${tuple.railOprIsttCd}\0${tuple.lnCd}\0${tuple.stinCd}`;
    if (tuple.lnCd !== scope.lnCd || !catalogTuples.has(`${tuple.railOprIsttCd}\0${tuple.lnCd}`)
      || !providerTuplesByLine.get(tuple.lineId)?.has(`${tuple.railOprIsttCd}\0${tuple.lnCd}`)
      || !roster?.stations?.some((station) => `${station.railOprIsttCd}\0${station.lnCd}\0${station.stinCd}` === exactProviderTuple)) {
      throw new Error(`KRIC provider tuple identity mismatch: ${tuple.lineId}/${tuple.stationId}`);
    }
    const target = targets.find(({ stationId, lineId }) => `${stationId}\0${lineId}` === targetKey);
    if (!target) continue;
    mappingByTarget.set(targetKey, canonicalObject({
      stationId: target.stationId, lineId: target.lineId, regionId: target.regionId, operatorId: target.operatorId,
      providerOperatorId: tuple.railOprIsttCd, providerLineId: tuple.lnCd, providerStationId: tuple.stinCd,
    }));
  }
  if (mappingByTarget.size !== targets.length) {
    const missing = targets.filter(({ stationId, lineId }) => !mappingByTarget.has(`${stationId}\0${lineId}`));
    throw new Error(`canonical KRIC station join missing: ${missing.slice(0, 12).map(({ stationId, lineId }) => `${stationId}/${lineId}`).join(",")}`);
  }
  const mappings = [...mappingByTarget.values()].sort(compareMapping);
  if (new Set(mappings.map(providerTupleKey)).size !== mappings.length) throw new Error("duplicate KRIC provider tuple");
  return mappings;
}

function assertInput(value) { assertKeys(value, INPUT_KEYS, "capital FACILITY input"); }
function requireBytes(value, label) { if (!Buffer.isBuffer(value) || value.length === 0) throw new Error(`${label} must be non-empty bytes`); return value; }
function parseJson(bytes, label) { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error(`${label} must be strict UTF-8 JSON`); } }
function uniqueMap(values, keyFor, label) { if (!Array.isArray(values) || values.length === 0) throw new Error(`${label} must be non-empty`); const result = new Map(); for (const value of values) { const key = typeof keyFor === "function" ? keyFor(value) : requiredString(value?.[keyFor], label); if (result.has(key)) throw new Error(`duplicate ${label}: ${key.replaceAll("\0", "/")}`); result.set(key, value); } return result; }
function requiredString(value, label) { if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`); return value; }
function assertSha256(value, label) { if (!/^[a-f0-9]{64}$/.test(value ?? "")) throw new Error(`${label} is invalid`); }
function assertKeys(value, expected, label) { if (!value || typeof value !== "object" || Array.isArray(value) || canonicalJson(Object.keys(value).sort(compare)) !== canonicalJson([...expected].sort(compare))) throw new Error(`${label} keys mismatch`); }
function canonicalObject(value) { return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compare(left, right))); }
function normalizeStationName(value) { return requiredString(value, "KRIC roster station name").normalize("NFKC").replace(/\([^)]*\)/g, "").replace(/역$/u, "").replace(/[^\p{L}\p{N}]+/gu, "").toLocaleLowerCase("ko-KR"); }
function providerTupleKey(value) { return `${value.providerOperatorId}\0${value.providerLineId}\0${value.providerStationId}`; }
function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function compareTarget(left, right) { return compare(left.stationId, right.stationId) || compare(left.lineId, right.lineId); }
function compareMapping(left, right) { return compareTarget(left, right) || compare(providerTupleKey(left), providerTupleKey(right)); }
function compareProviderScope(left, right) { return compare(`${left.regionId}\0${left.operatorId}\0${left.lineId}`, `${right.regionId}\0${right.operatorId}\0${right.lineId}`); }

const invokedAsScript = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedAsScript) main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
