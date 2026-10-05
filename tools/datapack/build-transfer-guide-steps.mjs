#!/usr/bin/env node
// #957: 국토교통부 철도역 환승 이동경로(molit-railway-transfer-movement)의 단계 문장(이동내용상세)을 원문 그대로 모바일 데이터팩에 싣는다.
// - 문장은 다듬거나 다시 쓰지 않는다. 바꾸는 것은 앞뒤 공백 정리(trim)뿐이다. 앞 번호("1) ")·층 표기·문장 안 공백은 원천 그대로 둔다.
// - 키는 앱이 경로 결과의 환승 구간에서 바로 만들 수 있는 내부 식별자다.
//   (역, 출발 노선, 출발 노선에서 내린 열차의 직전 역, 도착 노선, 도착 노선 열차가 승차 뒤 가는 다음 역)
//   - 앞 승차 구간(RIDE)의 lineId와 stops[끝-1]이 출발 노선과 직전 역이고, 뒤 승차 구간의 lineId와 stops[1]이 도착 노선과 다음 역이다.
//   - 원천의 방면 표기는 "그 승강장에서 열차가 가는 쪽의 역"이다. 도착 쪽은 다음 역과 같고, 출발 쪽은 직전 역의 반대편 이웃이다.
//     그래서 출발 쪽은 같은 노선 완행 이웃이 정확히 둘일 때만 방면 역의 반대편 이웃을 직전 역으로 바꾼다. 아니면 담지 않는다.
// - 노선·방면 토큰 매핑은 #944 build-transfer-stair-access의 TRANSFER_STAIR_LINE_TABLE과 같은 표를 쓴다. 이름 유사도 매칭·추정 매핑은 하지 않는다.
// - 매핑하지 못한 시퀀스는 팩에 담지 않고 사유와 목록으로 보고한다(excludedSequences).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { partitionMolitTransferTuples } from "./build-accessibility-source-coverage-report.mjs";
import { TRANSFER_STAIR_LINE_TABLE, loadTransferStairAccessInputs } from "./build-transfer-stair-access.mjs";
import { MOLIT_RAILWAY_TRANSFER_MOVEMENT_SOURCE_ID } from "./collect-molit-railway-transfer-movement.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { codepointCompare } from "../lib/codepoint-compare.mjs";

export const TRANSFER_GUIDE_SOURCE_ID = MOLIT_RAILWAY_TRANSFER_MOVEMENT_SOURCE_ID;
export const TRANSFER_GUIDE_DATASET_LABEL = "국토교통부 철도역 환승 이동경로";
export const TRANSFER_GUIDE_PRODUCTION_USE_SCOPE = "MOBILE_DATAPACK_TRANSFER_GUIDE_STEPS";
export const TRANSFER_GUIDE_CONSUMER = "tools/datapack/build-transfer-guide-steps.mjs";
export const TRANSFER_GUIDE_ATTRIBUTION = "국토교통부 철도역 환승 이동경로(공공데이터포털 15130556)";
const REQUIRED_LOCAL_NEIGHBORS = 2;
const STEP_PREFIX = /^\s*(\d+)\)\s*/u;

// 운영 빌드 입력: #944와 같은 검증(승인 상태·gzip hash·행 재현·신선도 정책)으로 잠긴 MOLIT 스냅샷을 읽는다.
// 모바일 데이터팩에 싣는 원천이라 QA 승인 기록(productionUseAdmission)이 먼저 있어야 한다. 없으면 입력을 읽지 않고 실패한다.
export async function loadTransferGuideInputs({ repositoryRoot, evaluationAt }) {
  if (typeof repositoryRoot !== "string" || repositoryRoot === "") throw new Error("repository root is required");
  const candidates = JSON.parse(await readFile(path.join(path.resolve(repositoryRoot), "tools/datapack/source-candidates.json"), "utf8"));
  assertProductionUseAdmission(candidates, TRANSFER_GUIDE_SOURCE_ID);
  const { snapshot, providerCodeCatalog, freshUntil } = await loadTransferStairAccessInputs({ repositoryRoot, evaluationAt });
  return { snapshot, providerCodeCatalog, freshUntil };
}

function assertProductionUseAdmission(candidatesDocument, sourceId) {
  const matches = (candidatesDocument?.candidates ?? []).filter(({ id }) => id === sourceId);
  const admission = matches[0]?.evidence?.productionUseAdmission;
  if (matches.length !== 1
    || admission?.decision !== "APPROVED"
    || admission.productionUseAllowed !== true
    || admission.scope !== TRANSFER_GUIDE_PRODUCTION_USE_SCOPE
    || admission.consumer !== TRANSFER_GUIDE_CONSUMER) {
    throw new Error(`source is not admitted for transfer guide steps: ${sourceId}`);
  }
}

export function deriveTransferGuideSteps({ snapshot, providerCodeCatalog, catalog, routeEdges }) {
  if (!snapshot || snapshot.sourceId !== TRANSFER_GUIDE_SOURCE_ID || typeof snapshot.snapshotId !== "string" || !Array.isArray(snapshot.rows)) {
    throw new Error("MOLIT transfer snapshot rows are required");
  }
  if (!Array.isArray(providerCodeCatalog?.providerLines)) throw new Error("KRIC provider code catalog is required");
  if (!Array.isArray(catalog?.stations) || !Array.isArray(catalog?.lines) || !Array.isArray(catalog?.stationLines)) {
    throw new Error("transfer guide station catalog is required");
  }
  if (!Array.isArray(routeEdges)) throw new Error("route edges are required");
  const stations = new Map(catalog.stations.map((station) => [station.id, station]));
  const linesAtStation = new Map();
  for (const { stationId, lineId } of catalog.stationLines) {
    linesAtStation.set(stationId, [...(linesAtStation.get(stationId) ?? []), lineId]);
  }
  const tableLines = resolveTableLines(catalog.lines);
  const neighbors = localNeighbors(routeEdges);

  const excluded = [];
  const exclude = (entry, reason) => excluded.push({
    providerOperatorCode: entry.operatorCode,
    providerLineName: entry.rows[0].LN_NM,
    providerStationName: entry.rows[0].STIN_NM,
    fromDirection: trimmed(entry.rows[0].CHTN_MV_CONT),
    toDirection: trimmed(entry.rows.at(-1).CHTN_MV_CONT),
    pathSha256: entry.pathSha256,
    reason,
  });
  const sequences = groupSequences(snapshot.rows);
  const valid = [];
  for (const entry of sequences) {
    if (entry.invalid) exclude(entry, "STEP_SEQUENCE_INVALID");
    else if (entry.operatorCode === null) exclude(entry, "PROVIDER_OPERATOR_UNPARSEABLE");
    else valid.push(entry);
  }
  const tupleMapping = mapProviderTuples({ rows: valid.flatMap(({ rows }) => rows), providerCodeCatalog, catalog, stations, tableLines });

  const byKey = new Map();
  for (const entry of valid) {
    const mapping = tupleMapping.get(tupleKey(entry.rows[0]));
    if (mapping.reason) {
      exclude(entry, mapping.reason);
      continue;
    }
    const resolved = resolveKey({ entry, mapping, stations, linesAtStation, tableLines, neighbors });
    if (resolved.reason) {
      exclude(entry, resolved.reason);
      continue;
    }
    const key = [resolved.stationId, resolved.fromLineId, resolved.fromPrevStationId, resolved.toLineId, resolved.toNextStationId].join("\0");
    byKey.set(key, [...(byKey.get(key) ?? []), { entry, resolved }]);
  }

  const rows = [];
  let duplicateSequenceCount = 0;
  let mappedSequenceCount = 0;
  for (const candidates of byKey.values()) {
    const texts = new Set(candidates.map(({ entry }) => canonicalJson(entry.details)));
    if (texts.size > 1) {
      for (const { entry } of candidates) exclude(entry, "DUPLICATE_KEY_CONFLICT");
      continue;
    }
    mappedSequenceCount += 1;
    duplicateSequenceCount += candidates.length - 1;
    const [{ entry, resolved }] = candidates;
    entry.details.forEach((detail, index) => rows.push({
      stationId: resolved.stationId,
      fromLineId: resolved.fromLineId,
      fromPrevStationId: resolved.fromPrevStationId,
      toLineId: resolved.toLineId,
      toNextStationId: resolved.toNextStationId,
      stepOrder: index + 1,
      detail,
      sourceSnapshotId: snapshot.snapshotId,
    }));
  }

  rows.sort((left, right) => compareFields(left, right, ["stationId", "fromLineId", "fromPrevStationId", "toLineId", "toNextStationId"]) || left.stepOrder - right.stepOrder);
  excluded.sort((left, right) => compareFields(left, right, ["providerOperatorCode", "providerLineName", "providerStationName", "fromDirection", "toDirection", "pathSha256", "reason"]));
  return {
    sourceId: snapshot.sourceId,
    sourceSnapshotId: snapshot.snapshotId,
    rows,
    excludedSequences: excluded,
    summary: {
      sequenceCount: sequences.length,
      mappedSequenceCount,
      excludedSequenceCount: excluded.length,
      duplicateSequenceCount,
      rowCount: rows.length,
      excludedByReason: countBy(excluded, ({ reason }) => reason),
    },
  };
}

// 데이터팩 provenance에 싣는 보고: 원천 스냅샷 결속, 매핑 성공·실패 수, 제외한 시퀀스 목록(개수와 목록).
export function transferGuideReport({ result, rawSha256 }) {
  if (typeof rawSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(rawSha256)) throw new Error("transfer guide raw sha256 is required");
  return {
    table: "transfer_guide_steps",
    sourceId: result.sourceId,
    sourceSnapshotId: result.sourceSnapshotId,
    rawSha256,
    ...result.summary,
    excludedSequences: result.excludedSequences,
  };
}

// 팩 sources 표 행: 출처 표기와 원천 스냅샷 id·원본 hash를 한 곳에 묶는다.
export function transferGuideSourceRow({ result, rawSha256 }) {
  if (typeof rawSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(rawSha256)) throw new Error("transfer guide raw sha256 is required");
  return {
    sourceSnapshotId: result.sourceSnapshotId,
    datasetLabel: TRANSFER_GUIDE_DATASET_LABEL,
    attribution: TRANSFER_GUIDE_ATTRIBUTION,
    rawSha256,
  };
}

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function resolveTableLines(lines) {
  const resolved = [];
  for (const entry of TRANSFER_STAIR_LINE_TABLE) {
    const matches = lines.filter(({ nameKo }) => nameKo === entry.lineName);
    if (matches.length > 1) throw new Error(`transfer guide line table name is ambiguous: ${entry.lineName}`);
    if (matches.length === 1) resolved.push({ ...entry, lineId: matches[0].id });
  }
  return resolved;
}

function localNeighbors(routeEdges) {
  const neighbors = new Map();
  const add = (stationId, lineId, other) => {
    const key = `${stationId}\0${lineId}`;
    const set = neighbors.get(key) ?? new Set();
    set.add(other);
    neighbors.set(key, set);
  };
  for (const edge of routeEdges) {
    if (edge.edgeType !== "RIDE" || edge.servicePattern !== "LOCAL") continue;
    const from = splitNode(edge.fromNodeId);
    const to = splitNode(edge.toNodeId);
    if (!from || !to || from.lineId !== to.lineId || from.stationId === to.stationId) continue;
    add(from.stationId, from.lineId, to.stationId);
    add(to.stationId, to.lineId, from.stationId);
  }
  return neighbors;
}

function splitNode(nodeId) {
  const parts = String(nodeId).split(":");
  return parts.length === 2 && parts.every(Boolean) ? { stationId: parts[0], lineId: parts[1] } : null;
}

// 원천 행을 시퀀스(1단계부터 다음 1단계 전까지)로 묶는다. 한 시퀀스는 같은 운영기관·노선·역이고 단계 번호가 1..n이며 문장이 비지 않아야 한다.
function groupSequences(rows) {
  const groups = [];
  for (const row of rows) {
    if (row.CHTN_MV_TP_ORDR === "1" || groups.length === 0) groups.push([]);
    groups.at(-1).push(row);
  }
  return groups.map((group) => {
    const head = group[0];
    const details = group.map((row) => trimmed(row.MV_CONT_DTL));
    const invalid = group.some((row, index) => tupleKey(row) !== tupleKey(head)
      || row.CHTN_MV_TP_ORDR !== String(index + 1)
      || details[index] === ""
      || (STEP_PREFIX.test(details[index]) && STEP_PREFIX.exec(details[index])[1] !== String(index + 1)));
    const operator = /^([A-Z0-9]+)\(([^()]+)\)$/u.exec(head.RAIL_OPR_ISTT_CD);
    return {
      rows: group,
      details,
      invalid,
      operatorCode: operator ? operator[1] : null,
      // #944 pathSha256과 같은 계산이라 두 표의 같은 시퀀스를 같은 hash로 이을 수 있다.
      pathSha256: sha256(canonicalJson(group.map((row) => ({
        RAIL_OPR_ISTT_CD: row.RAIL_OPR_ISTT_CD,
        LN_NM: row.LN_NM,
        STIN_NM: row.STIN_NM,
        CHTN_MV_TP_ORDR: row.CHTN_MV_TP_ORDR,
        MV_CONT_DTL: row.MV_CONT_DTL,
        CHTN_MV_CONT: row.CHTN_MV_CONT,
      })))),
    };
  });
}

function tupleKey(row) {
  return `${row.RAIL_OPR_ISTT_CD}\0${row.LN_NM}\0${row.STIN_NM}`;
}

function subNamed(station) {
  return typeof station.nameSub === "string" && station.nameSub !== "" ? [`${station.nameKo}(${station.nameSub})`] : [];
}

// 원천 (운영기관·노선·역) 묶음을 기존 partitionMolitTransferTuples로 정본 역-노선에 잇는다.
function mapProviderTuples({ rows, providerCodeCatalog, catalog, stations, tableLines }) {
  const stationLines = [];
  for (const entry of tableLines) {
    const catalogLines = entry.providerLines.map(({ railOprIsttCd, lnCd }) => {
      const matches = providerCodeCatalog.providerLines.filter((providerLine) =>
        providerLine.railOprIsttCd === railOprIsttCd && providerLine.lnCd === lnCd);
      if (matches.length !== 1) throw new Error(`transfer guide line table provider line is not in the KRIC catalog: ${railOprIsttCd}/${lnCd}`);
      return matches[0];
    });
    for (const { stationId, lineId } of catalog.stationLines.filter(({ lineId }) => lineId === entry.lineId)) {
      const station = stations.get(stationId);
      if (!station) throw new Error(`transfer guide station is missing: ${stationId}`);
      for (const catalogLine of catalogLines) {
        stationLines.push({
          stationId,
          stationName: station.nameKo,
          stationAliases: subNamed(station),
          lineId,
          lineName: catalogLine.lineName,
          operatorId: catalogLine.railOprIsttCd,
          operatorName: catalogLine.operatorName,
        });
      }
    }
  }
  const partition = partitionMolitTransferTuples({
    artifacts: [{ artifactId: "transfer-guide-steps", stationLines }],
    rows,
    providerCodeCatalog,
  });
  const mapping = new Map();
  const keyOf = (entry) => `${entry.providerOperatorCode}(${entry.providerOperatorName})\0${entry.providerLineName}\0${entry.providerStationName}`;
  for (const entry of partition.joined) {
    const [match] = entry.mappings;
    mapping.set(keyOf(entry), { stationId: match.stationId, lineId: match.lineId });
  }
  for (const entry of [...partition.unmatched, ...partition.ambiguous]) mapping.set(keyOf(entry), { reason: entry.reason });
  for (const row of rows) {
    if (!mapping.has(tupleKey(row))) throw new Error("MOLIT transfer tuple partition is incomplete");
  }
  return mapping;
}

function resolveKey({ entry, mapping, stations, linesAtStation, tableLines, neighbors }) {
  const from = parseDirection(entry.rows[0].CHTN_MV_CONT);
  const to = parseDirection(entry.rows.at(-1).CHTN_MV_CONT);
  if (!from || !to) return { reason: "DIRECTION_FORMAT_UNSUPPORTED" };
  const stationLines = linesAtStation.get(mapping.stationId) ?? [];
  const linesForToken = (token) => tableLines
    .filter(({ directionTokens, lineId }) => directionTokens.includes(token) && stationLines.includes(lineId))
    .map(({ lineId }) => lineId);
  const fromLines = linesForToken(from.lineToken);
  if (fromLines.length !== 1 || fromLines[0] !== mapping.lineId) return { reason: "FROM_LINE_MISMATCH" };
  const toLines = linesForToken(to.lineToken);
  if (toLines.length !== 1 || toLines[0] === mapping.lineId) return { reason: "TO_LINE_UNRESOLVED" };
  const fromHeading = neighborByName(mapping.stationId, mapping.lineId, from.stationName, stations, neighbors);
  const toNext = neighborByName(mapping.stationId, toLines[0], to.stationName, stations, neighbors);
  if (!fromHeading || !toNext) return { reason: "DIRECTION_NAME_UNRESOLVED" };
  const fromNeighbors = [...(neighbors.get(`${mapping.stationId}\0${mapping.lineId}`) ?? [])];
  if (fromNeighbors.length !== REQUIRED_LOCAL_NEIGHBORS) return { reason: "FROM_ARRIVAL_AMBIGUOUS" };
  const [fromPrev] = fromNeighbors.filter((neighborId) => neighborId !== fromHeading);
  return {
    stationId: mapping.stationId,
    fromLineId: mapping.lineId,
    fromPrevStationId: fromPrev,
    toLineId: toLines[0],
    toNextStationId: toNext,
  };
}

function parseDirection(value) {
  const match = /^(\S+) (\S+) 방면$/u.exec(trimmed(value));
  return match ? { lineToken: match[1], stationName: match[2] } : null;
}

function neighborByName(stationId, lineId, name, stations, neighbors) {
  const wanted = normalizeStationName(name);
  const matches = [...(neighbors.get(`${stationId}\0${lineId}`) ?? [])].filter((neighborId) => {
    const neighbor = stations.get(neighborId);
    return neighbor && [neighbor.nameKo, ...subNamed(neighbor)].some((candidate) => normalizeStationName(candidate) === wanted);
  });
  return matches.length === 1 ? matches[0] : null;
}

// partitionMolitTransferTuples·#944와 같은 역명 정규화(NFKC, 끝의 "역", 문자·숫자 외 제거)다.
function normalizeStationName(value) {
  return String(value ?? "").normalize("NFKC").replace(/역$/u, "").replace(/[^\p{L}\p{N}]+/gu, "");
}

function countBy(values, keyOf) {
  const counts = {};
  for (const value of values) counts[keyOf(value)] = (counts[keyOf(value)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => codepointCompare(left, right)));
}

function compareFields(left, right, fields) {
  for (const field of fields) {
    const result = codepointCompare(left[field], right[field]);
    if (result) return result;
  }
  return 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// 보고 CLI: 후보 팩(canonical pack JSON)의 역·노선·완행 간선으로 매핑 성공·실패 수와 제외 목록을 JSON으로 출력한다.
async function main(argv) {
  const args = Object.fromEntries(argv.reduce((pairs, value, index) => (index % 2 === 0 ? [...pairs, [value, argv[index + 1]]] : pairs), []));
  const { "--repository-root": repositoryRoot, "--pack": packPath, "--pack-id": packId, "--evaluation-at": evaluationAt } = args;
  if (argv.length !== 8 || !repositoryRoot || !packPath || !packId || !evaluationAt) {
    throw new Error("usage: build-transfer-guide-steps.mjs --repository-root <path> --pack <canonical-pack.json> --pack-id <id> --evaluation-at <iso>");
  }
  const inputs = await loadTransferGuideInputs({ repositoryRoot, evaluationAt });
  const pack = JSON.parse(await readFile(path.resolve(packPath), "utf8")).packs?.find(({ id }) => id === packId);
  if (!pack) throw new Error(`pack is missing: ${packId}`);
  const result = deriveTransferGuideSteps({
    ...inputs,
    catalog: { stations: pack.stations, lines: pack.lines, stationLines: pack.stationLines },
    routeEdges: pack.networkEdges ?? [],
  });
  process.stdout.write(`${JSON.stringify(transferGuideReport({ result, rawSha256: inputs.snapshot.rawSha256 }), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`build-transfer-guide-steps: ${error.message}\n`);
    process.exitCode = 1;
  });
}
