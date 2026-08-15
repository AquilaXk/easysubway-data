#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const APPLICABLE = "APPLICABLE_TRANSFER_ENDPOINT";
const NOT_APPLICABLE = "NOT_APPLICABLE_IN_CANONICAL_PAIR_SET";

export async function main(argv = process.argv.slice(2), { log = console.log } = {}) {
  const { canonicalPack, transferTopologyMetrics, output } = parseArgs(argv);
  await outputMustBeAbsent(output);
  const [canonicalPackBytes, metricsBytes] = await Promise.all([
    readCanonicalFile(canonicalPack, "canonical pack"),
    readCanonicalFile(transferTopologyMetrics, "transfer topology metrics"),
  ]);
  const result = buildApplicability({
    canonicalPack: parseJson(canonicalPackBytes, "canonical pack"),
    canonicalPackBytes,
    transferTopologyMetrics: parseJson(metricsBytes, "transfer topology metrics"),
    metricsBytes,
  });
  await writeFile(output, canonicalBytes(result), { flag: "wx", mode: 0o600 });
  log(JSON.stringify({ cellCount: result.cells.length, stateSummary: result.stateSummary, artifactSha256: result.artifactSha256 }));
  return result;
}

export function buildApplicability({ canonicalPack, canonicalPackBytes, transferTopologyMetrics, metricsBytes }) {
  if (!Buffer.isBuffer(canonicalPackBytes) || !Buffer.isBuffer(metricsBytes)) throw new Error("NO_GO input bytes mismatch");
  if (!canonicalPackBytes.equals(canonicalBytes(canonicalPack)) || !metricsBytes.equals(canonicalBytes(transferTopologyMetrics))) {
    throw new Error("NO_GO parsed input binding mismatch");
  }
  const canonical = deriveCanonicalTarget(canonicalPack, canonicalPackBytes);
  const metrics = validateMetrics(transferTopologyMetrics, metricsBytes, canonical);
  const applicable = new Set(metrics.metrics.flatMap(({ stationId, fromLineId }) => [cellKey(stationId, fromLineId)]));
  if (applicable.size !== 27) throw new Error("NO_GO transfer endpoint count mismatch");
  const cells = canonical.stationLines.map(({ stationId, lineId }) => ({
    stationId,
    lineId,
    state: applicable.has(cellKey(stationId, lineId)) ? APPLICABLE : NOT_APPLICABLE,
  })).sort(compareCell);
  const stateSummary = countStates(cells);
  if (cells.length !== 213 || stateSummary[APPLICABLE] !== 27 || stateSummary[NOT_APPLICABLE] !== 186) {
    throw new Error("NO_GO applicability partition mismatch");
  }
  const payload = canonicalObject({
    schemaVersion: 1,
    artifactKind: "current-capital-transfer-topology-applicability-pre-candidate",
    productionUseAllowed: false,
    candidateBinding: null,
    canonicalIdentity: metrics.canonicalIdentity,
    sourceIdentity: metrics.sourceIdentity,
    transferTopologyMetricsIdentity: {
      artifactSha256: metrics.artifactSha256,
      physicalPairCount: metrics.physicalPairs.length,
      directedMetricCount: metrics.metrics.length,
      metricProvenanceSummary: metricProvenanceSummary(metrics.metrics),
    },
    physicalPairCount: metrics.physicalPairs.length,
    directedMetricCount: metrics.metrics.length,
    metricProvenanceSummary: metricProvenanceSummary(metrics.metrics),
    stateSummary,
    cells,
  });
  return canonicalObject({ ...payload, artifactSha256: sha256(canonicalBytes(payload)) });
}

function deriveCanonicalTarget(value, bytes) {
  const capital = value?.packs?.filter(({ id }) => id === "capital");
  if (value?.manifest?.channel !== "production" || value?.manifest?.activePack?.id !== "capital"
    || capital?.length !== 1 || capital[0]?.artifactKind !== "production" || capital[0]?.schemaVersion !== "1"
    || value.manifest.activePack.version !== capital[0].version) throw new Error("NO_GO canonical pack identity mismatch");
  const stationLines = capital[0].stationLines;
  if (!Array.isArray(stationLines)) throw new Error("NO_GO canonical station-line schema mismatch");
  return { packSha256: sha256(bytes), capital, stationLines };
}

function validateMetrics(value, bytes, canonical) {
  const required = ["schemaVersion", "artifactKind", "artifactSha256", "canonicalIdentity", "sourceIdentity", "physicalPairs", "metrics"];
  assertExactKeys(value, required, "transfer topology metrics");
  if (value.schemaVersion !== 1 || value.artifactKind !== "current-transfer-topology-metrics"
    || value.artifactSha256 !== sha256(canonicalJson(without(value, "artifactSha256")))) throw new Error("NO_GO transfer topology artifact identity mismatch");
  const identity = value.canonicalIdentity;
  assertExactKeys(identity, ["canonicalPackSha256", "stationLineCount", "stationCount", "physicalPairCount"], "canonical identity");
  if (identity.canonicalPackSha256 !== canonical.packSha256 || identity.stationLineCount !== 213
    || identity.stationCount !== 199 || identity.physicalPairCount !== 15) {
    throw new Error("NO_GO canonical identity mismatch");
  }
  validateSourceIdentity(value.sourceIdentity);
  const lineIds = new Set(value.metrics.map(({ fromLineId, toLineId }) => [fromLineId, toLineId]).flat());
  const stationLines = canonical.stationLines.filter(({ stationId, lineId }) => nonBlank(stationId) && lineIds.has(lineId));
  const stationIds = new Set(stationLines.map(({ stationId }) => stationId));
  if (stationLines.length !== 213 || stationIds.size !== 199 || new Set(stationLines.map(({ stationId, lineId }) => cellKey(stationId, lineId))).size !== 213) {
    throw new Error("NO_GO canonical target denominator mismatch");
  }
  const physicalPairs = derivePairs(stationLines);
  if (physicalPairs.length !== 15 || canonicalJson(physicalPairs) !== canonicalJson(value.physicalPairs)) throw new Error("NO_GO canonical pair identity mismatch");
  if (!Array.isArray(value.metrics) || value.metrics.length !== 30 || metricProvenanceSummary(value.metrics).OFFICIAL_SOURCE !== 28 || metricProvenanceSummary(value.metrics).DERIVED_RECIPROCAL !== 2) {
    throw new Error("NO_GO transfer topology metric composition mismatch");
  }
  const expectedDirections = new Set(physicalPairs.flatMap(({ stationId, lineIds: [a, b] }) => [metricKey(stationId, a, b), metricKey(stationId, b, a)]));
  const actualDirections = new Set();
  const metricsByKey = new Map(value.metrics.map((metric) => [metricKey(metric.stationId, metric.fromLineId, metric.toLineId), metric]));
  for (const metric of value.metrics) {
    assertExactKeys(metric, metric.metricProvenance === "DERIVED_RECIPROCAL"
      ? ["stationId", "fromLineId", "toLineId", "distanceMeters", "officialDurationSecondsReference", "durationRole", "sourceRecordSha256", "metricProvenance", "derivedFrom"]
      : ["stationId", "fromLineId", "toLineId", "distanceMeters", "officialDurationSecondsReference", "durationRole", "sourceRecordSha256", "metricProvenance"], "transfer metric");
    const key = metricKey(metric.stationId, metric.fromLineId, metric.toLineId);
    if (!expectedDirections.has(key) || actualDirections.has(key) || metric.durationRole !== "REFERENCE_ONLY"
      || !Number.isInteger(metric.distanceMeters) || metric.distanceMeters < 0
      || !Number.isInteger(metric.officialDurationSecondsReference) || metric.officialDurationSecondsReference < 0
      || !["OFFICIAL_SOURCE", "DERIVED_RECIPROCAL"].includes(metric.metricProvenance)) throw new Error("NO_GO transfer metric mismatch");
    if (!validSha256(metric.sourceRecordSha256)) throw new Error("NO_GO transfer metric source record identity mismatch");
    if (metric.metricProvenance === "DERIVED_RECIPROCAL") validateDerivedReciprocal(metric, metricsByKey);
    actualDirections.add(key);
  }
  if (actualDirections.size !== expectedDirections.size) throw new Error("NO_GO transfer direction coverage mismatch");
  return { ...value, stationLines };
}

function validateSourceIdentity(source) {
  assertExactKeys(source, ["sourceId", "endpointSha256", "capturedAt", "freshnessDate", "manifestSha256", "observationSha256", "rawSnapshotSha256", "rawSha256", "contentSha256", "schemaSha256", "rowCount", "sourceCandidateSha256", "kricProviderCatalogSha256"], "source identity");
  if (source.sourceId !== "seoul-metro-transfer-distance-duration" || source.rowCount !== 145
    || source.freshnessDate !== "2025-12-31" || !validUtcInstant(source.capturedAt)
    || !["endpointSha256", "manifestSha256", "observationSha256", "rawSnapshotSha256", "rawSha256", "contentSha256", "schemaSha256", "sourceCandidateSha256", "kricProviderCatalogSha256"].every((key) => validSha256(source[key]))) {
    throw new Error("NO_GO source identity mismatch");
  }
}

function validateDerivedReciprocal(metric, metricsByKey) {
  const { derivedFrom } = metric;
  assertExactKeys(derivedFrom, ["stationId", "fromLineId", "toLineId", "sourceRecordSha256"], "derived reciprocal identity");
  if (derivedFrom.stationId !== metric.stationId || derivedFrom.fromLineId !== metric.toLineId
    || derivedFrom.toLineId !== metric.fromLineId || derivedFrom.sourceRecordSha256 !== metric.sourceRecordSha256) {
    throw new Error("NO_GO derived reciprocal direction mismatch");
  }
  const source = metricsByKey.get(metricKey(derivedFrom.stationId, derivedFrom.fromLineId, derivedFrom.toLineId));
  if (!source || source.metricProvenance !== "OFFICIAL_SOURCE" || source.sourceRecordSha256 !== metric.sourceRecordSha256
    || source.distanceMeters !== metric.distanceMeters || source.officialDurationSecondsReference !== metric.officialDurationSecondsReference) {
    throw new Error("NO_GO derived reciprocal source mismatch");
  }
}

function derivePairs(stationLines) {
  const byStation = Map.groupBy(stationLines, ({ stationId }) => stationId);
  return [...byStation.entries()].flatMap(([stationId, memberships]) => combinations(memberships.map(({ lineId }) => lineId).sort(compareBytes), 2).map((lineIds) => ({ stationId, lineIds }))).sort(comparePair);
}

function metricProvenanceSummary(metrics) { return Object.fromEntries(["DERIVED_RECIPROCAL", "OFFICIAL_SOURCE"].map((state) => [state, metrics.filter(({ metricProvenance }) => metricProvenance === state).length])); }
function countStates(cells) { return Object.fromEntries([APPLICABLE, NOT_APPLICABLE].map((state) => [state, cells.filter((cell) => cell.state === state).length])); }
function parseArgs(argv) { if (!Array.isArray(argv) || argv.length !== 6 || argv[0] !== "--canonical-pack" || argv[2] !== "--transfer-topology-metrics" || argv[4] !== "--output" || !argv.slice(1).filter((_, index) => index % 2 === 0).every((value) => path.isAbsolute(value))) throw new Error("arguments must be --canonical-pack <absolute> --transfer-topology-metrics <absolute> --output <absolute absent>"); return { canonicalPack: path.resolve(argv[1]), transferTopologyMetrics: path.resolve(argv[3]), output: path.resolve(argv[5]) }; }
async function readCanonicalFile(file, label) { const bytes = await readRegularFile(file, label); const value = parseJson(bytes, label); if (!bytes.equals(canonicalBytes(value))) throw new Error(`${label} bytes are not canonical`); return bytes; }
async function readRegularFile(file, label) { const before = await lstat(file); if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`); const bytes = await readFile(file); const after = await lstat(file); if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(`${label} changed while reading`); return bytes; }
async function outputMustBeAbsent(file) { if (!path.isAbsolute(file)) throw new Error("output path must be absolute"); const parent = await lstat(path.dirname(file)); if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("output parent must be a regular directory"); try { await lstat(file); } catch (error) { if (error?.code === "ENOENT") return; throw error; } throw new Error("output must be absent"); }
function parseJson(bytes, label) { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error(`${label} must be strict UTF-8 JSON`); } }
function assertExactKeys(value, keys, label) { if (!value || typeof value !== "object" || Array.isArray(value) || canonicalJson(Object.keys(value).sort(compareBytes)) !== canonicalJson([...keys].sort(compareBytes))) throw new Error(`NO_GO ${label} schema mismatch`); }
function combinations(values, size) { return values.flatMap((value, index) => size === 1 ? [[value]] : combinations(values.slice(index + 1), size - 1).map((tail) => [value, ...tail])); }
function canonicalObject(value) { return sortValue(value); }
function canonicalBytes(value) { return Buffer.from(`${canonicalJson(value)}\n`); }
function canonicalJson(value) { return JSON.stringify(sortValue(value)); }
function sortValue(value) { if (Array.isArray(value)) return value.map(sortValue); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort(compareBytes).map((key) => [key, sortValue(value[key])])); return value; }
function without(value, key) { const { [key]: _ignored, ...result } = value; return result; }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function nonBlank(value) { return typeof value === "string" && value.trim() !== ""; }
function validSha256(value) { return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value); }
function validUtcInstant(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && !Number.isNaN(Date.parse(value)); }
function cellKey(stationId, lineId) { return `${stationId}\0${lineId}`; }
function metricKey(stationId, fromLineId, toLineId) { return `${stationId}\0${fromLineId}\0${toLineId}`; }
function compareBytes(left, right) { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }
function comparePair(left, right) { return compareBytes(`${left.stationId}\0${left.lineIds.join("\0")}`, `${right.stationId}\0${right.lineIds.join("\0")}`); }
function compareCell(left, right) { return compareBytes(cellKey(left.stationId, left.lineId), cellKey(right.stationId, right.lineId)); }

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "transfer applicability failed"}\n`);
    process.exitCode = 1;
  });
}
