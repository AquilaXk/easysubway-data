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
// #872 S2: 원천의 "호선"은 서울교통공사 1~8호선이다. "환승노선"은 상대 노선 이름이다. 둘 다 정본 팩 노선 id와
// 노선 이름(nameKo)이 정확히 같을 때만 쓴다. 이름 유사도·추정 매핑은 쓰지 않는다.
const SEOUL_METRO_LINES = Object.freeze([
  ["1호선", "line-472a81add377", "수도권 1호선"], ["2호선", "seoul-2", "수도권 2호선"], ["3호선", "line-41a8c75ec9d8", "수도권 3호선"],
  ["4호선", "seoul-4", "수도권 4호선"], ["5호선", "line-80fc4d5350d4", "수도권 5호선"], ["6호선", "line-3f41718e0833", "수도권 6호선"],
  ["7호선", "line-15b3b8a93259", "수도권 7호선"], ["8호선", "line-2b2d9eaa53d0", "수도권 8호선"],
]);
const COUNTERPART_LINES = Object.freeze([
  ...SEOUL_METRO_LINES,
  ["9호선", "line-f0e747248a31", "수도권 9호선"], ["공항철도", "line-e9e9a5b520a4", "수도권 공항"], ["경의중앙선", "line-6e39be0cb6e2", "수도권 경의중앙"],
  ["경춘선", "line-54a7b980b7c3", "수도권 경춘"], ["수인분당선", "line-558d0bd8312d", "수도권 수인분당"], ["신분당선", "shinbundang", "수도권 신분당"],
  ["우이신설선", "line-30886152e4f8", "수도권 우이신설"], ["김포골드라인", "line-5500c1600f71", "수도권 김포골드라인"], ["서해선", "line-051552e50435", "수도권 서해선"],
  ["신림선", "line-aefa08ccc0a9", "수도권 신림선"], ["GTX-A", "line-8604048b6430", "수도권 GTX-A"],
]);
const SEOUL_METRO_LINE_BY_SOURCE_NAME = new Map(SEOUL_METRO_LINES.map(([sourceName, lineId]) => [sourceName, lineId]));
const COUNTERPART_LINE_BY_SOURCE_NAME = new Map(COUNTERPART_LINES.map(([sourceName, lineId]) => [sourceName, lineId]));
const LINE_NAME_BY_ID = new Map(COUNTERPART_LINES.map(([, lineId, nameKo]) => [lineId, nameKo]));
// 쓰지 않는 원천 행은 연번과 행 전체 값으로 고정하고 사유를 밝힌다. 원천 값이 바뀌면 NO_GO다.
// - BRANCH_TRANSFER_MODEL_ABSENT: 같은 노선 지선 환승(성수·신도림·강동). 정본 팩은 지선을 같은 노선 id 안에서 표현하므로
//   역내 환승 간선으로 나타낼 수 없다(후속 과제).
// - AMBIGUOUS_COUNTERPART_LINE_NAME: 상대 노선명이 정본 팩 노선 하나로 정해지지 않는다(국철·경원선).
const EXCLUDED_SOURCE_ROWS = new Map([
  [24, { row: { 호선: "2호선", 환승역명: "성수", 환승노선: "2호선", 환승거리: 23, 환승소요시간: "00:19" }, reason: "BRANCH_TRANSFER_MODEL_ABSENT" }],
  [35, { row: { 호선: "2호선", 환승역명: "신도림", 환승노선: "2호선", 환승거리: 81, 환승소요시간: "01:08" }, reason: "BRANCH_TRANSFER_MODEL_ABSENT" }],
  [59, { row: { 호선: "3호선", 환승역명: "수서", 환승노선: "국철", 환승거리: 92, 환승소요시간: "01:17" }, reason: "AMBIGUOUS_COUNTERPART_LINE_NAME" }],
  [102, { row: { 호선: "5호선", 환승역명: "강동", 환승노선: "5호선", 환승거리: 19, 환승소요시간: "00:16" }, reason: "BRANCH_TRANSFER_MODEL_ABSENT" }],
  [107, { row: { 호선: "6호선", 환승역명: "석계", 환승노선: "경원선", 환승거리: 125, 환승소요시간: "01:44" }, reason: "AMBIGUOUS_COUNTERPART_LINE_NAME" }],
]);
// 공식 소요시간은 거리/1.2m/s 반올림과 같아야 한다. 아래 행만 공식 값이 이 관계와 다르다(원천 내부 불일치 의심,
// 제공기관 확인 필요). 공식 원천 우선 원칙에 따라 값을 바꾸지 않고 OFFICIAL_SOURCE로 쓴다.
const OFFICIAL_DURATION_REFERENCE_EXCEPTIONS = new Map([
  [79, { row: { 호선: "5호선", 환승역명: "김포공항", 환승노선: "공항철도", 환승거리: 122, 환승소요시간: "04:42" }, reason: "SOURCE_INTERNAL_INCONSISTENCY_SUSPECTED" }],
]);

export function currentTransferLineIds() {
  return [...new Set(COUNTERPART_LINE_BY_SOURCE_NAME.values())].toSorted(compareBytes);
}

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
  const result = rebuildAuthenticatedTransferTopologyMetrics({
    canonicalPack: parseJson(canonicalPackBytes, "canonical pack"), canonicalPackBytes, observation,
    sourceCandidatesBytes, kricCatalogBytes,
  });
  const bytes = canonicalBytes(result);
  await writeFile(output, bytes, { flag: "wx", mode: 0o600 });
  log(JSON.stringify({ physicalPairCount: result.physicalPairs.length, metricCount: result.metrics.length, artifactSha256: result.artifactSha256 }));
  return result;
}

// Registration consumes the same #339 authentication and topology derivation
// as the builder; it never reimplements an abbreviated metric check.
export function rebuildAuthenticatedTransferTopologyMetrics({ canonicalPack, canonicalPackBytes, observation, sourceCandidatesBytes, kricCatalogBytes }) {
  if (!Buffer.isBuffer(canonicalPackBytes) || !Buffer.isBuffer(sourceCandidatesBytes) || !Buffer.isBuffer(kricCatalogBytes)) {
    throw new Error("NO_GO canonical input bytes mismatch");
  }
  const sourceCandidate = validateSourceCandidate(parseJson(sourceCandidatesBytes, "source candidate contract"));
  const canonical = deriveCanonicalTarget(canonicalPack, kricCatalogBytes);
  const source = validateObservation(observation, sourceCandidate);
  return buildTransferTopologyMetrics({ canonical, canonicalPackBytes, observation: source, sourceCandidate, sourceCandidatesBytes });
}

// The collector and publisher admit the same sealed observation contract as
// the metrics builder, including the tracked endpoint binding.
export function validateAuthenticatedTransferObservation({ observation, sourceCandidatesBytes }) {
  if (!Buffer.isBuffer(sourceCandidatesBytes)) throw new Error("NO_GO source candidate contract bytes mismatch");
  return validateObservation(observation, validateSourceCandidate(parseJson(sourceCandidatesBytes, "source candidate contract")));
}

export function buildTransferTopologyMetrics({ canonical, canonicalPackBytes, observation, sourceCandidate, sourceCandidatesBytes }) {
  if (!Buffer.isBuffer(canonicalPackBytes) || !Buffer.isBuffer(sourceCandidatesBytes)) throw new Error("NO_GO canonical input bytes mismatch");
  const records = indexSourceRecords(observation.observation.rows, canonical);
  // #872 S2: 쌍은 원천이 실제로 덮는 (역, 노선 2개)뿐이다. 원천에 없는 쌍은 만들지 않는다.
  const sourcePairs = [...new Map([...records.values()].map(({ stationId, fromLineId, toLineId }) => {
    const lineIds = [fromLineId, toLineId].sort(compareBytes);
    return [directionKey(stationId, ...lineIds), { stationId, lineIds }];
  })).values()].sort(comparePair);
  const physicalPairs = sourcePairs.map((pair) => buildPhysicalPair(pair, records));
  const metrics = physicalPairs.flatMap(({ stationId, lineIds, directions }) => directions.map((direction) => ({ stationId, ...direction })))
    .sort(compareMetric);
  const derivedCount = metrics.filter(({ metricProvenance }) => metricProvenance === "DERIVED_RECIPROCAL").length;
  const officialCount = metrics.filter(({ metricProvenance }) => metricProvenance === "OFFICIAL_SOURCE").length;
  if (physicalPairs.length === 0 || metrics.length !== physicalPairs.length * 2
    || officialCount !== records.size || derivedCount !== metrics.length - officialCount) {
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
      physicalPairCount: physicalPairs.length,
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
  // D4: 원천에 없는 반대 방향은 원천 방향 값을 DERIVED_RECIPROCAL로만 표기한다.
  const source = forward ?? reverse;
  const direction = (fromLineId, toLineId, record) => record
    ? canonicalObject({ fromLineId, toLineId, distanceMeters: record.distanceMeters, officialDurationSecondsReference: record.officialDurationSecondsReference, durationRole: "REFERENCE_ONLY", sourceRecordSha256: record.sourceRecordSha256, metricProvenance: "OFFICIAL_SOURCE" })
    : canonicalObject({ fromLineId, toLineId, distanceMeters: source.distanceMeters, officialDurationSecondsReference: source.officialDurationSecondsReference, durationRole: "REFERENCE_ONLY", sourceRecordSha256: source.sourceRecordSha256, metricProvenance: "DERIVED_RECIPROCAL", derivedFrom: { stationId: pair.stationId, fromLineId: source.fromLineId, toLineId: source.toLineId, sourceRecordSha256: source.sourceRecordSha256 } });
  return { stationId: pair.stationId, lineIds: pair.lineIds, directions: [direction(first, second, forward), direction(second, first, reverse)] };
}

export function assertExactDerivedReciprocals(metrics) {
  const byKey = new Map(metrics.map((metric) => [directionKey(metric.stationId, metric.fromLineId, metric.toLineId), metric]));
  for (const metric of metrics.filter(({ metricProvenance }) => metricProvenance === "DERIVED_RECIPROCAL")) {
    const { derivedFrom } = metric;
    const source = byKey.get(directionKey(derivedFrom.stationId, derivedFrom.fromLineId, derivedFrom.toLineId));
    if (derivedFrom.stationId !== metric.stationId || derivedFrom.fromLineId !== metric.toLineId || derivedFrom.toLineId !== metric.fromLineId
      || source?.metricProvenance !== "OFFICIAL_SOURCE" || source.sourceRecordSha256 !== metric.sourceRecordSha256 || derivedFrom.sourceRecordSha256 !== metric.sourceRecordSha256
      || source.distanceMeters !== metric.distanceMeters || source.officialDurationSecondsReference !== metric.officialDurationSecondsReference) {
      throw new Error("NO_GO derived reciprocal set mismatch");
    }
  }
}

// 원천 행마다 (역, 출발 노선, 도착 노선)을 하나로 정한다. 제외 목록 밖에서 정해지지 않는 행은 NO_GO다.
function indexSourceRecords(rows, canonical) {
  const records = new Map();
  const consumed = new Set();
  for (const row of rows) {
    const serial = row["연번"];
    const fromName = normalizeLineName(row["호선"]);
    const toName = row["환승노선"];
    const excluded = EXCLUDED_SOURCE_ROWS.get(serial);
    if (excluded) {
      assertPinnedRow(row, excluded.row, "NO_GO excluded official transfer row drift");
      const fromLineId = SEOUL_METRO_LINE_BY_SOURCE_NAME.get(fromName);
      const toLineId = COUNTERPART_LINE_BY_SOURCE_NAME.get(toName);
      const holds = excluded.reason === "BRANCH_TRANSFER_MODEL_ABSENT" ? fromLineId !== undefined && fromLineId === toLineId
        : excluded.reason === "AMBIGUOUS_COUNTERPART_LINE_NAME" ? fromLineId !== undefined && toLineId === undefined : false;
      if (!holds) throw new Error("NO_GO excluded official transfer row reason mismatch");
      consumed.add(serial);
      continue;
    }
    const fromLineId = SEOUL_METRO_LINE_BY_SOURCE_NAME.get(fromName);
    const toLineId = COUNTERPART_LINE_BY_SOURCE_NAME.get(toName);
    if (!fromLineId || !toLineId || fromLineId === toLineId) throw new Error(`NO_GO unmapped official transfer row: ${serial}`);
    const stationId = resolveStation(canonical, row["환승역명"], fromLineId, toLineId, serial);
    const duration = parseDuration(row["환승소요시간"]);
    const exception = OFFICIAL_DURATION_REFERENCE_EXCEPTIONS.get(serial);
    if (exception) {
      assertPinnedRow(row, exception.row, "NO_GO official duration exception row drift");
      if (duration === Math.round(row["환승거리"] / 1.2)) throw new Error("NO_GO official duration exception is stale");
    } else if (duration !== Math.round(row["환승거리"] / 1.2)) {
      throw new Error("NO_GO official transfer reference duration mismatch");
    }
    const key = directionKey(stationId, fromLineId, toLineId);
    if (records.has(key)) throw new Error("NO_GO duplicate official transfer direction");
    records.set(key, { stationId, fromLineId, toLineId, distanceMeters: row["환승거리"], officialDurationSecondsReference: duration, sourceRecordSha256: sha256(canonicalJson(row)) });
    consumed.add(serial);
  }
  for (const serial of [...EXCLUDED_SOURCE_ROWS.keys(), ...OFFICIAL_DURATION_REFERENCE_EXCEPTIONS.keys()]) {
    if (!consumed.has(serial)) throw new Error("NO_GO pinned official transfer row is absent");
  }
  if (consumed.size !== rows.length) throw new Error("NO_GO official transfer row accounting mismatch");
  return records;
}

// 역은 정본 팩 역의 nameKo 또는 nameSub가 원천 역명과 정확히 같고 두 노선을 모두 가진 역 하나뿐이어야 한다.
function resolveStation(canonical, stationName, fromLineId, toLineId, serial) {
  const matches = canonical.stations.filter(({ id, nameKo, nameSub }) => (nameKo === stationName || nameSub === stationName)
    && canonical.membership.get(id)?.has(fromLineId) && canonical.membership.get(id)?.has(toLineId));
  if (matches.length !== 1) throw new Error(`NO_GO official transfer station mapping mismatch: ${serial}`);
  return matches[0].id;
}

function assertPinnedRow(row, pinned, message) {
  if (normalizeLineName(row["호선"]) !== pinned.호선 || row["환승역명"] !== pinned.환승역명 || row["환승노선"] !== pinned.환승노선
    || row["환승거리"] !== pinned.환승거리 || row["환승소요시간"] !== pinned.환승소요시간) throw new Error(message);
}

function deriveCanonicalTarget(value, kricCatalogBytes) {
  const pack = value?.packs?.filter(({ id }) => id === "capital");
  if (value?.manifest?.channel !== "production" || value?.manifest?.activePack?.id !== "capital" || pack?.length !== 1 || pack[0]?.artifactKind !== "production" || pack[0]?.schemaVersion !== "1" || value.manifest.activePack.version !== pack[0].version) throw new Error("NO_GO canonical pack identity mismatch");
  const capital = pack[0];
  const evidence = parseProductionCoverageEvidence(capital.metadata?.productionCoverageEvidence);
  if (!evidence.some(({ regionId, operatorId, sourceDomain }) => regionId === "capital" && operatorId === "seoul-metro" && sourceDomain === "station_line_membership")) throw new Error("NO_GO canonical coverage identity mismatch");
  validateShinbundangIdentity(parseJson(kricCatalogBytes, "KRIC line identity"));
  const lines = Map.groupBy(capital.lines ?? [], ({ id }) => id);
  const activeIds = new Set(currentTransferLineIds());
  // 운영기관 표기가 아니라 노선 id와 노선 이름이 정확히 같은지로 노선을 확인한다.
  if ([...activeIds].some((id) => lines.get(id)?.length !== 1 || lines.get(id)[0].nameKo !== LINE_NAME_BY_ID.get(id))) throw new Error("NO_GO canonical line identity mismatch");
  const stations = capital.stations?.filter(({ id, nameKo }) => nonBlank(id) && nonBlank(nameKo));
  const stationLines = capital.stationLines?.filter(({ stationId, lineId }) => activeIds.has(lineId) && nonBlank(stationId));
  if (!Array.isArray(stations) || !Array.isArray(stationLines) || stationLines.length === 0) throw new Error("NO_GO canonical target denominator mismatch");
  const stationIds = new Set(stations.map(({ id }) => id));
  if (stationIds.size !== stations.length || stationLines.some(({ stationId }) => !stationIds.has(stationId))) throw new Error("NO_GO canonical station identity mismatch");
  const seen = new Set();
  for (const { stationId, lineId } of stationLines) { const key = `${stationId}\0${lineId}`; if (seen.has(key)) throw new Error("NO_GO duplicate canonical station-line"); seen.add(key); }
  const membership = new Map([...Map.groupBy(stationLines, ({ stationId }) => stationId).entries()].map(([stationId, rows]) => [stationId, new Set(rows.map(({ lineId }) => lineId))]));
  return { stations, membership, stationIds: [...new Set(stationLines.map(({ stationId }) => stationId))].sort(compareBytes), stationLines, kricProviderCatalogSha256: sha256(kricCatalogBytes) };
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

function validateRows(rows, requireCompleteSerials = true) { const serials = new Set(); for (const row of rows) { assertKeys(row, FIELDS, "official transfer row"); if (!Number.isInteger(row["연번"]) || row["연번"] < 1 || serials.has(row["연번"]) || !nonBlank(normalizeLineName(row["호선"])) || !nonBlank(row["환승역명"]) || !nonBlank(row["환승노선"]) || !Number.isInteger(row["환승거리"]) || row["환승거리"] < 0 || !validDuration(row["환승소요시간"])) throw new Error("NO_GO official transfer row schema mismatch"); serials.add(row["연번"]); } if (requireCompleteSerials && (serials.size !== 145 || [...serials].some((serial) => serial > 145))) throw new Error("NO_GO official transfer serial mismatch"); }
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
function validDuration(value) { const match = typeof value === "string" ? /^(\d{2}):(\d{2})$/u.exec(value) : null; return match !== null && Number(match[1]) <= 59 && Number(match[2]) <= 59; }
function parseDuration(value) { const [minutes, seconds] = value.split(":").map(Number); if (minutes > 59 || seconds > 59) throw new Error("NO_GO official duration schema mismatch"); return minutes * 60 + seconds; }
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
