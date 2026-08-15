#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CANONICAL_PACK_FILE = "tools/datapack/release/capital-production-canonical-pack.json";
const SOURCE_CANDIDATES_FILE = "tools/datapack/source-candidates.json";
const KRIC_PROVIDER_CATALOG_FILE = "tools/datapack/sources/kric-provider-code-catalog-20260228.json";
const SOURCE_ID = "seoul-metro-transfer-distance-duration";
const SOURCE_EFFECTIVE_DATE = "2025-12-31";
const SNAPSHOT_FILES = ["manifest.json", "observation.json", "raw-snapshot.json"];
const FIELDS = ["연번", "호선", "환승역명", "환승노선", "환승거리", "환승소요시간"];
const LINE_BY_SOURCE_NAME = new Map([
  ["2호선", "seoul-2"], ["4호선", "seoul-4"], ["5호선", "line-80fc4d5350d4"],
  ["6호선", "line-3f41718e0833"], ["신분당선", "shinbundang"],
]);
const DERIVED_RECIPROCALS = new Map([
  ["station-b35616704ce3\0seoul-2\0line-80fc4d5350d4", "station-b35616704ce3\0line-80fc4d5350d4\0seoul-2"],
  ["station-gangnam\0shinbundang\0seoul-2", "station-gangnam\0seoul-2\0shinbundang"],
]);

export async function main(argv = process.argv.slice(2), { repositoryRoot = fileURLToPath(new URL("../../", import.meta.url)), log = console.log } = {}) {
  const { observationDirectory, output } = parseArgs(argv);
  await outputMustBeAbsent(output);
  const root = path.resolve(repositoryRoot);
  const [canonicalPackBytes, sourceCandidatesBytes, kricCatalogBytes, observation] = await Promise.all([
    readRegularFile(path.join(root, CANONICAL_PACK_FILE), "canonical pack"),
    readRegularFile(path.join(root, SOURCE_CANDIDATES_FILE), "source candidate contract"),
    readRegularFile(path.join(root, KRIC_PROVIDER_CATALOG_FILE), "KRIC line identity"),
    readObservationDirectory(observationDirectory),
  ]);
  const sourceCandidate = validateSourceCandidate(parseJson(sourceCandidatesBytes, "source candidate contract"));
  const canonical = deriveCanonicalTarget(parseJson(canonicalPackBytes, "canonical pack"), kricCatalogBytes);
  const source = validateObservation(observation, sourceCandidate);
  const result = buildTransferTopologyMetrics({ canonical, canonicalPackBytes, observation: source, sourceCandidate, sourceCandidatesBytes });
  const bytes = canonicalBytes(result);
  await writeFile(output, bytes, { flag: "wx", mode: 0o600 });
  log(JSON.stringify({ physicalPairCount: result.physicalPairs.length, metricCount: result.metrics.length, artifactSha256: result.artifactSha256 }));
  return result;
}

export function buildTransferTopologyMetrics({ canonical, canonicalPackBytes, observation, sourceCandidate, sourceCandidatesBytes }) {
  if (!Buffer.isBuffer(canonicalPackBytes) || !Buffer.isBuffer(sourceCandidatesBytes)) throw new Error("NO_GO canonical input bytes mismatch");
  const records = indexSourceRecords(observation.observation.rows, canonical);
  const physicalPairs = canonical.physicalPairs.map((pair) => buildPhysicalPair(pair, records));
  const metrics = physicalPairs.flatMap(({ stationId, lineIds, directions }) => directions.map((direction) => ({ stationId, ...direction })))
    .sort(compareMetric);
  if (physicalPairs.length !== 15 || metrics.length !== 30
    || metrics.filter(({ metricProvenance }) => metricProvenance === "OFFICIAL_SOURCE").length !== 28
    || metrics.filter(({ metricProvenance }) => metricProvenance === "DERIVED_RECIPROCAL").length !== 2) {
    throw new Error("NO_GO transfer topology metric composition mismatch");
  }
  assertExactDerivedReciprocals(metrics);
  const payload = canonicalObject({
    schemaVersion: 1,
    artifactKind: "current-transfer-topology-metrics",
    sourceIdentity: {
      sourceId: SOURCE_ID,
      endpointSha256: observation.manifest.endpointSha256,
      capturedAt: observation.manifest.capturedAt,
      freshnessDate: observation.manifest.freshnessDate,
      manifestSha256: sha256(observation.bytes.manifest),
      observationSha256: sha256(observation.bytes.observation),
      rawSnapshotSha256: sha256(observation.bytes.raw),
      rawSha256: observation.manifest.rawSha256,
      contentSha256: observation.manifest.contentSha256,
      schemaSha256: observation.manifest.schemaSha256,
      rowCount: observation.manifest.rowCount,
      sourceCandidateSha256: sha256(sourceCandidatesBytes),
      kricProviderCatalogSha256: canonical.kricProviderCatalogSha256,
    },
    canonicalIdentity: {
      canonicalPackSha256: sha256(canonicalPackBytes),
      stationLineCount: canonical.stationLines.length,
      stationCount: canonical.stationIds.length,
      physicalPairCount: canonical.physicalPairs.length,
    },
    physicalPairs: physicalPairs.map(({ stationId, lineIds }) => ({ stationId, lineIds })),
    metrics,
  });
  return canonicalObject({ ...payload, artifactSha256: sha256(canonicalJson(payload)) });
}

function buildPhysicalPair(pair, records) {
  const [first, second] = pair.lineIds;
  const forwardKey = directionKey(pair.stationId, first, second);
  const reverseKey = directionKey(pair.stationId, second, first);
  const forward = records.get(forwardKey);
  const reverse = records.get(reverseKey);
  if (!forward && !reverse) throw new Error("NO_GO canonical transfer pair is absent from official observation");
  if (forward && reverse && (forward.distanceMeters !== reverse.distanceMeters || forward.officialDurationSecondsReference !== reverse.officialDurationSecondsReference)) {
    throw new Error("NO_GO reciprocal official transfer metric conflict");
  }
  const source = forward ?? reverse;
  const missingKey = forward ? (reverse ? null : reverseKey) : forwardKey;
  if (missingKey !== null && DERIVED_RECIPROCALS.get(missingKey) !== directionKey(pair.stationId, source.fromLineId, source.toLineId)) {
    throw new Error("NO_GO derived reciprocal direction mismatch");
  }
  const direction = (fromLineId, toLineId, record) => record
    ? canonicalObject({ fromLineId, toLineId, distanceMeters: record.distanceMeters, officialDurationSecondsReference: record.officialDurationSecondsReference, durationRole: "REFERENCE_ONLY", sourceRecordSha256: record.sourceRecordSha256, metricProvenance: "OFFICIAL_SOURCE" })
    : canonicalObject({ fromLineId, toLineId, distanceMeters: source.distanceMeters, officialDurationSecondsReference: source.officialDurationSecondsReference, durationRole: "REFERENCE_ONLY", sourceRecordSha256: source.sourceRecordSha256, metricProvenance: "DERIVED_RECIPROCAL", derivedFrom: { stationId: pair.stationId, fromLineId: source.fromLineId, toLineId: source.toLineId, sourceRecordSha256: source.sourceRecordSha256 } });
  return { stationId: pair.stationId, lineIds: pair.lineIds, directions: [direction(first, second, forward), direction(second, first, reverse)] };
}

function assertExactDerivedReciprocals(metrics) {
  const derived = metrics.filter(({ metricProvenance }) => metricProvenance === "DERIVED_RECIPROCAL");
  if (derived.length !== DERIVED_RECIPROCALS.size
    || derived.some((metric) => DERIVED_RECIPROCALS.get(directionKey(metric.stationId, metric.fromLineId, metric.toLineId)) !== directionKey(metric.derivedFrom.stationId, metric.derivedFrom.fromLineId, metric.derivedFrom.toLineId))) {
    throw new Error("NO_GO derived reciprocal set mismatch");
  }
}

function indexSourceRecords(rows, canonical) {
  const stationByName = new Map(canonical.stations.map(({ id, nameKo }) => [nameKo, id]));
  const targetKeys = new Set(canonical.physicalPairs.flatMap(({ stationId, lineIds: [a, b] }) => [directionKey(stationId, a, b), directionKey(stationId, b, a)]));
  const records = new Map();
  for (const row of rows) {
    const stationId = stationByName.get(row["환승역명"]);
    const fromLineId = sourceLineId(normalizeLineName(row["호선"]), row["환승역명"], stationId);
    const toLineId = sourceLineId(row["환승노선"], row["환승역명"], stationId);
    if (!stationId || !fromLineId || !toLineId || fromLineId === toLineId) continue;
    const key = directionKey(stationId, fromLineId, toLineId);
    if (!targetKeys.has(key)) continue;
    const duration = parseDuration(row["환승소요시간"]);
    const expected = Math.round(row["환승거리"] / 1.2);
    if (duration !== expected) throw new Error("NO_GO official transfer reference duration mismatch");
    const record = { fromLineId, toLineId, distanceMeters: row["환승거리"], officialDurationSecondsReference: duration, sourceRecordSha256: sha256(canonicalJson(row)) };
    if (records.has(key)) throw new Error("NO_GO duplicate official transfer direction");
    records.set(key, record);
  }
  return records;
}

function deriveCanonicalTarget(value, kricCatalogBytes) {
  const pack = value?.packs?.filter(({ id }) => id === "capital");
  if (value?.manifest?.channel !== "production" || value?.manifest?.activePack?.id !== "capital" || pack?.length !== 1 || pack[0]?.artifactKind !== "production" || pack[0]?.schemaVersion !== "1" || value.manifest.activePack.version !== pack[0].version) throw new Error("NO_GO canonical pack identity mismatch");
  const capital = pack[0];
  const evidence = parseProductionCoverageEvidence(capital.metadata?.productionCoverageEvidence);
  if (!evidence.some(({ regionId, operatorId, sourceDomain }) => regionId === "capital" && operatorId === "seoul-metro" && sourceDomain === "station_line_membership")) throw new Error("NO_GO canonical coverage identity mismatch");
  validateShinbundangIdentity(parseJson(kricCatalogBytes, "KRIC line identity"));
  const lines = new Map(capital.lines?.map((line) => [line.id, line]));
  const activeIds = new Set(["seoul-2", "seoul-4", "line-80fc4d5350d4", "line-3f41718e0833", "shinbundang"]);
  if ([...activeIds].some((id) => lines.get(id)?.operatorId !== "seoul-metro")) throw new Error("NO_GO canonical line identity mismatch");
  const stations = capital.stations?.filter(({ id, nameKo }) => nonBlank(id) && nonBlank(nameKo));
  const stationLines = capital.stationLines?.filter(({ stationId, lineId }) => activeIds.has(lineId) && nonBlank(stationId));
  if (!Array.isArray(stations) || !Array.isArray(stationLines) || stationLines.length !== 213 || new Set(stationLines.map(({ stationId }) => stationId)).size !== 199) throw new Error("NO_GO canonical target denominator mismatch");
  const stationIds = new Set(stations.map(({ id }) => id));
  if (stationIds.size !== stations.length || stationLines.some(({ stationId }) => !stationIds.has(stationId))) throw new Error("NO_GO canonical station identity mismatch");
  const seen = new Set();
  for (const { stationId, lineId } of stationLines) { const key = `${stationId}\0${lineId}`; if (seen.has(key)) throw new Error("NO_GO duplicate canonical station-line"); seen.add(key); }
  const grouped = Map.groupBy(stationLines, ({ stationId }) => stationId);
  const physicalPairs = [...grouped.entries()].flatMap(([stationId, memberships]) => combinations(memberships.map(({ lineId }) => lineId).sort(compareBytes), 2).map((lineIds) => ({ stationId, lineIds }))).sort(comparePair);
  if (physicalPairs.length !== 15) throw new Error("NO_GO canonical physical transfer pair count mismatch");
  return { stations, stationIds: [...new Set(stationLines.map(({ stationId }) => stationId))].sort(compareBytes), stationLines, physicalPairs, kricProviderCatalogSha256: sha256(kricCatalogBytes) };
}

function validateObservation(value, sourceCandidate) {
  const { manifest, observation, raw } = value;
  assertKeys(manifest, ["artifactKind", "sourceId", "endpointSha256", "capturedAt", "freshnessDate", "rowCount", "rawSha256", "contentSha256", "schemaSha256", "credentialRedacted"], "manifest");
  assertKeys(observation, ["artifactKind", "sourceId", "capturedAt", "rowCount", "rawSha256", "contentSha256", "rows", "credentialRedacted"], "observation");
  assertKeys(raw, ["artifactKind", "sourceId", "pages"], "raw snapshot");
  if (manifest.artifactKind !== "seoul-transfer-distance-duration-snapshot-manifest" || observation.artifactKind !== "seoul-transfer-distance-duration-observation" || raw.artifactKind !== "seoul-transfer-distance-duration-raw-snapshot" || [manifest.sourceId, observation.sourceId, raw.sourceId].some((id) => id !== SOURCE_ID) || manifest.endpointSha256 !== sha256(sourceCandidate.endpoint) || manifest.credentialRedacted !== true || observation.credentialRedacted !== true || manifest.rowCount !== 145 || observation.rowCount !== 145 || observation.rows.length !== 145 || observation.capturedAt !== manifest.capturedAt || observation.rawSha256 !== manifest.rawSha256 || observation.contentSha256 !== manifest.contentSha256 || !validDate(manifest.capturedAt) || manifest.freshnessDate !== SOURCE_EFFECTIVE_DATE) throw new Error("NO_GO observation identity mismatch");
  if (manifest.rawSha256 !== sha256(value.bytes.raw) || manifest.contentSha256 !== sha256(snapshotBytes(observation.rows)) || manifest.schemaSha256 !== sha256(snapshotBytes({ fields: FIELDS }))) throw new Error("NO_GO observation hash mismatch");
  validateRows(observation.rows);
  validateRawPages(raw, observation.rows);
  return value;
}

function validateRawPages(raw, rows) {
  if (!Array.isArray(raw.pages) || raw.pages.length !== 2) throw new Error("NO_GO raw page count mismatch");
  const combined = [];
  for (const [index, page] of raw.pages.entries()) {
    assertKeys(page, ["page", "perPage", "sha256", "base64"], "raw page");
    const bytes = Buffer.from(page.base64, "base64");
    if (bytes.toString("base64") !== page.base64 || sha256(bytes) !== page.sha256) throw new Error("NO_GO raw page hash mismatch");
    const envelope = parseJson(bytes, "raw page");
    assertKeys(envelope, ["currentCount", "data", "matchCount", "page", "perPage", "totalCount"], "raw page envelope");
    const expected = index === 0 ? 100 : 45;
    if (page.page !== index + 1 || page.perPage !== 100 || envelope.page !== page.page || envelope.perPage !== 100 || envelope.currentCount !== expected || envelope.data.length !== expected || envelope.matchCount !== 145 || envelope.totalCount !== 145) throw new Error("NO_GO raw page envelope mismatch");
    validateRows(envelope.data, false); combined.push(...envelope.data);
  }
  const sorted = [...combined].sort((left, right) => compareBytes(FIELDS.map((field) => left[field]).join("\0"), FIELDS.map((field) => right[field]).join("\0")));
  if (canonicalJson(sorted) !== canonicalJson(rows)) throw new Error("NO_GO raw observation row mismatch");
}

function validateRows(rows, requireCompleteSerials = true) { const serials = new Set(); for (const row of rows) { assertKeys(row, FIELDS, "official transfer row"); if (!Number.isInteger(row["연번"]) || row["연번"] < 1 || serials.has(row["연번"]) || !nonBlank(normalizeLineName(row["호선"])) || !nonBlank(row["환승역명"]) || !nonBlank(row["환승노선"]) || !Number.isInteger(row["환승거리"]) || row["환승거리"] < 0 || !/^\d{2}:\d{2}$/u.test(row["환승소요시간"])) throw new Error("NO_GO official transfer row schema mismatch"); serials.add(row["연번"]); } if (requireCompleteSerials && (serials.size !== 145 || [...serials].some((serial) => serial > 145))) throw new Error("NO_GO official transfer serial mismatch"); }
function validateSourceCandidate(value) { const candidate = value?.candidates?.filter(({ id }) => id === SOURCE_ID); if (candidate?.length !== 1 || candidate[0].requestUrl !== candidate[0].operation?.endpoint || candidate[0].operation?.method !== "GET" || !Array.isArray(candidate[0].evidence?.outputFields) || canonicalJson(candidate[0].evidence.outputFields) !== canonicalJson(FIELDS)) throw new Error("NO_GO source candidate contract mismatch"); return { endpoint: candidate[0].requestUrl }; }
function validateShinbundangIdentity(value) { const tuple = value?.providerLines?.filter(({ railOprIsttCd, lnCd }) => railOprIsttCd === "DX" && lnCd === "D1"); if (tuple?.length !== 1 || tuple[0].operatorName !== "네오트랜스주식회사" || tuple[0].lineName !== "신분당") throw new Error("NO_GO Shinbundang alias identity mismatch"); }
async function readObservationDirectory(directory) { if (!path.isAbsolute(directory)) throw new Error("observation directory must be absolute"); const stats = await lstat(directory); if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("observation directory must be regular"); const inventory = (await readdir(directory)).sort(compareBytes); if (canonicalJson(inventory) !== canonicalJson(SNAPSHOT_FILES)) throw new Error("observation directory inventory mismatch"); const entries = await Promise.all(SNAPSHOT_FILES.map(async (name) => [name, await readRegularFile(path.join(directory, name), `observation ${name}`)])); const bytes = Object.fromEntries(entries.map(([name, contents]) => [name.replace("-snapshot", "").replace(".json", ""), contents])); return { manifest: parseCanonicalJson(bytes.manifest, "manifest"), observation: parseCanonicalJson(bytes.observation, "observation"), raw: parseCanonicalJson(bytes.raw, "raw snapshot"), bytes: { manifest: bytes.manifest, observation: bytes.observation, raw: bytes.raw } }; }
async function readRegularFile(file, label) { const before = await lstat(file); if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`); const bytes = await readFile(file); const after = await lstat(file); if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(`${label} changed while reading`); return bytes; }
function parseArgs(argv) { if (!Array.isArray(argv) || argv.length !== 4 || argv[0] !== "--observation-directory" || argv[2] !== "--output" || !path.isAbsolute(argv[1]) || !path.isAbsolute(argv[3])) throw new Error("arguments must be --observation-directory <absolute regular non-symlink directory> --output <absolute absent file>"); return { observationDirectory: path.resolve(argv[1]), output: path.resolve(argv[3]) }; }
async function outputMustBeAbsent(file) { try { await lstat(file); } catch (error) { if (error?.code === "ENOENT") return; throw error; } throw new Error("output must be absent"); }
function parseCanonicalJson(bytes, label) { let value; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error(`${label} must be strict UTF-8 JSON`); } if (!Buffer.from(`${JSON.stringify(value)}\n`, "utf8").equals(bytes)) throw new Error(`${label} bytes are not canonical`); return value; }
function parseJson(bytes, label) { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error(`${label} must be strict UTF-8 JSON`); } }
function parseProductionCoverageEvidence(value) { try { const parsed = JSON.parse(value); if (!Array.isArray(parsed)) throw new Error(); return parsed; } catch { throw new Error("NO_GO canonical coverage evidence mismatch"); } }
function normalizeLineName(value) { return Number.isInteger(value) ? `${value}호선` : value; }
function sourceLineId(sourceLineName, stationName, stationId) { if (sourceLineName !== "신분당선") return LINE_BY_SOURCE_NAME.get(sourceLineName); return stationName === "강남" && stationId === "station-gangnam" ? "shinbundang" : undefined; }
function parseDuration(value) { const [minutes, seconds] = value.split(":").map(Number); if (minutes > 59 || seconds > 59) throw new Error("NO_GO official duration schema mismatch"); return minutes * 60 + seconds; }
function combinations(values, size) { return values.flatMap((value, index) => size === 1 ? [[value]] : combinations(values.slice(index + 1), size - 1).map((tail) => [value, ...tail])); }
function directionKey(stationId, fromLineId, toLineId) { return `${stationId}\0${fromLineId}\0${toLineId}`; }
function compareMetric(left, right) { return compareBytes(left.stationId, right.stationId) || compareBytes(left.fromLineId, right.fromLineId) || compareBytes(left.toLineId, right.toLineId); }
function comparePair(left, right) { return compareBytes(left.stationId, right.stationId) || compareBytes(left.lineIds.join("\0"), right.lineIds.join("\0")); }
function canonicalBytes(value) { return Buffer.from(`${canonicalJson(value)}\n`, "utf8"); }
function snapshotBytes(value) { return Buffer.from(`${JSON.stringify(value)}\n`, "utf8"); }
function canonicalJson(value) { return JSON.stringify(canonicalObject(value)); }
function canonicalObject(value) { if (Array.isArray(value)) return value.map(canonicalObject); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort(compareBytes).map((key) => [key, canonicalObject(value[key])])); return value; }
function assertKeys(value, keys, label) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) throw new Error(`${label} keys mismatch`); }
function nonBlank(value) { return typeof value === "string" && value.trim() !== ""; }
function validDate(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function compareBytes(left, right) { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsScript) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
