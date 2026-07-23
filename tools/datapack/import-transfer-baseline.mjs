#!/usr/bin/env node
// #1701 Phase 2: 환승소요시간 공식 데이터 → transfer_rules + station_pathway_edges
// (OFFICIAL_BASELINE) 정규화 도구.
//
// 입력 raw row(6종): 연번, 호선, 환승역명, 환승노선, 환승거리(m 정수), 환승소요시간(초 정수).
// canonical roster를 경유해 환승역명 → stationId, 호선/환승노선 → lineId를 확정한다.
// 매칭 실패·모호는 quarantine에 기록하고 적재하지 않는다(throw 금지).
//
// transfer_rules는 같은 역 내부 환승이므로 from_station_id = to_station_id 이며
// from_line_id=호선, to_line_id=환승노선이다. 환승소요시간은 공식값이므로 대응
// station_pathway_edge의 시간 source는 OFFICIAL_BASELINE이며 provenance_kind는
// OFFICIAL_SOURCE다. 산정기준 1.2 m/s를 metadata에 문자열로 기록한다.
//
// 사용: node tools/datapack/import-transfer-baseline.mjs \
//   --roster <roster.json> --rows <rows.json> \
//   [--pathway-edges <edges.json>] [--pathway-nodes <nodes.json>] \
//   [--source-id <id>] [--snapshot-id <id>] [--verification-status <status>] \
//   [--verified-at <ISO-8601>] [--evidence-hash <sha256>] \
//   --output <out.json>
import { isMainModule } from "../lib/is-main-module.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { parseArgs, readJsonFile, requireArg, requiredArray, sortJson } from "./lib/ledger-admission-cli.mjs";
import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";
import { buildRosterIndex } from "./lib/station-roster.mjs";
import { codepointCompare } from "../lib/codepoint-compare.mjs";

// 1.2 m/s 산정 앵커. 환승소요시간이 공식값이므로 시간을 추정하지 않지만,
// 데이터 산정 기준을 산출 메타데이터에 기록한다.
const SPEED_ANCHOR_METERS_PER_SECOND = 1.2;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const roster = requiredArray(await readJsonFile(requireArg(args, "roster")), "roster");
  const rows = requiredArray(await readJsonFile(requireArg(args, "rows")), "rows");
  const existingEdges = args["pathway-edges"] ? requiredArray(await readJsonFile(args["pathway-edges"]), "pathwayEdges") : [];
  const existingNodes = args["pathway-nodes"] ? requiredArray(await readJsonFile(args["pathway-nodes"]), "pathwayNodes") : [];
  const outputPath = requireArg(args, "output");

  const fixture = buildTransferBaseline({
    roster,
    rows,
    existingEdges,
    existingNodes,
    sourceId: args["source-id"] ?? "",
    snapshotId: args["snapshot-id"] ?? "",
    verificationStatus: args["verification-status"] ?? "VERIFIED",
    verifiedAt: args["verified-at"] ?? "",
    evidenceHash: args["evidence-hash"] ?? "",
  });

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(sortJson(fixture), null, 2)}\n`);
}

/**
 * 순수 함수: 환승소요시간 raw rows + roster → 정규화 산출.
 * 반환: { transferRules, stationPathwayNodes, stationPathwayEdges, quarantine,
 *         directionPairReport, duplicateReport, metadata }.
 */
export function buildTransferBaseline({
  roster,
  rows,
  existingEdges = [],
  existingNodes = [],
  sourceId = "",
  snapshotId = "",
  verificationStatus = "VERIFIED",
  verifiedAt = "",
  evidenceHash = "",
}) {
  const index = buildRosterIndex(roster);
  const platformNodesByStationLine = platformNodeIndex(existingNodes);
  const existingEdgePairs = existingEdgePairKeys(existingEdges, existingNodes);

  const transferRules = [];
  const stationPathwayNodes = [];
  const stationPathwayEdges = [];
  const quarantine = [];
  const duplicateReport = [];
  // ruleKey(station:fromLine:toLine) → 첫 적재 소요시간. 중복은 리포트만 하고 첫 값 유지.
  const seenRuleKeys = new Map();
  // (station, fromLine, toLine) → { fromLine, toLine, minTransferSeconds } 방향쌍 대조용.
  const directionRecords = new Map();

  for (const raw of rows) {
    const resolved = resolveTransferRow(index, raw);
    if (resolved.error) {
      quarantine.push({ reason: resolved.error, row: raw });
      continue;
    }
    const { stationId, fromLineId, toLineId, distanceMeters, transferSeconds } = resolved;
    const providerRecordHash = sha256(canonicalJson(raw));
    const ruleKey = `${stationId}:${fromLineId}:${toLineId}`;

    if (seenRuleKeys.has(ruleKey)) {
      duplicateReport.push({
        ruleKey,
        stationId,
        fromLineId,
        toLineId,
        firstMinTransferSeconds: seenRuleKeys.get(ruleKey),
        duplicateMinTransferSeconds: transferSeconds,
      });
      continue;
    }
    seenRuleKeys.set(ruleKey, transferSeconds);
    directionRecords.set(ruleKey, {
      stationId,
      fromLineId,
      toLineId,
      minTransferSeconds: transferSeconds,
    });

    const pathwayEdgeId = appendBaselineEdge({
      existingEdgePairs,
      platformNodesByStationLine,
      stationPathwayEdges,
      quarantine,
      record: resolved,
      raw,
      sourceId,
      snapshotId,
      providerRecordHash,
      verificationStatus,
      verifiedAt,
      evidenceHash,
    });

    transferRules.push({
      id: `transfer-${stationId}-${fromLineId}-${toLineId}`,
      fromStationId: stationId,
      fromLineId,
      toStationId: stationId,
      toLineId,
      minTransferSeconds: transferSeconds,
      pathwayEdgeId,
      sourceId,
      verificationStatus,
      providerRecordHash,
    });
  }

  const directionPairReport = buildDirectionPairReport(directionRecords);

  return {
    transferRules,
    stationPathwayNodes,
    stationPathwayEdges,
    quarantine,
    directionPairReport,
    duplicateReport,
    metadata: { speedAnchorMetersPerSecond: SPEED_ANCHOR_METERS_PER_SECOND },
  };
}

function resolveTransferRow(index, raw) {
  const parsed = parseTransferRow(raw);
  if (parsed.error) return parsed;
  const stationMatch = index.matchStation(parsed.stationName);
  if (stationMatch.error) return stationMatch;
  const fromLineMatch = index.matchLineForStation(stationMatch.stationId, parsed.fromLineName);
  if (fromLineMatch.error) return fromLineMatch;
  const toLineMatch = index.matchLineForStation(stationMatch.stationId, parsed.toLineName);
  if (toLineMatch.error) return toLineMatch;
  return {
    stationId: stationMatch.stationId,
    fromLineId: fromLineMatch.lineId,
    toLineId: toLineMatch.lineId,
    distanceMeters: parsed.distanceMeters,
    transferSeconds: parsed.transferSeconds,
  };
}

function appendBaselineEdge({
  existingEdgePairs,
  platformNodesByStationLine,
  stationPathwayEdges,
  quarantine,
  record,
  raw,
  sourceId,
  snapshotId,
  providerRecordHash,
  verificationStatus,
  verifiedAt,
  evidenceHash,
}) {
  const { stationId, fromLineId, toLineId, distanceMeters, transferSeconds } = record;
  if (existingEdgePairs.has(pathwayEdgePairKey(stationId, fromLineId, toLineId))) return null;

  const fromNodeId = platformNodesByStationLine.get(`${stationId}:${fromLineId}`);
  const toNodeId = platformNodesByStationLine.get(`${stationId}:${toLineId}`);
  if (!fromNodeId || !toNodeId) {
    quarantine.push({
      reason: `platform node missing for baseline pathway edge: ${stationId}:${fromLineId}->${toLineId}`,
      row: raw,
    });
    return null;
  }

  const id = `pathedge-baseline-${stationId}-${fromLineId}-${toLineId}`;
  stationPathwayEdges.push({
    id,
    fromNodeId,
    toNodeId,
    edgeType: "WALK",
    durationSeconds: transferSeconds,
    distanceMeters,
    bidirectional: false,
    sourceId,
    sourceSnapshotId: snapshotId,
    providerRecordHash,
    provenanceKind: "OFFICIAL_SOURCE",
    verificationStatus,
    verifiedAt,
    evidenceHash,
  });
  return id;
}

// 방향쌍(A→B / B→A) 존재 여부와 소요시간 불일치를 리포트한다(적재 거부 아님).
function buildDirectionPairReport(directionRecords) {
  const report = [];
  const seenPairs = new Set();
  for (const record of directionRecords.values()) {
    const { stationId, fromLineId, toLineId, minTransferSeconds } = record;
    const canonicalPairKey = [fromLineId, toLineId].sort(compareText).join("|");
    const dedupeKey = `${stationId}:${canonicalPairKey}`;
    if (seenPairs.has(dedupeKey)) {
      continue;
    }
    seenPairs.add(dedupeKey);
    const reverse = directionRecords.get(`${stationId}:${toLineId}:${fromLineId}`);
    report.push({
      stationId,
      fromLineId,
      toLineId,
      forwardMinTransferSeconds: minTransferSeconds,
      hasReverse: reverse !== undefined,
      reverseMinTransferSeconds: reverse ? reverse.minTransferSeconds : null,
      secondsMismatch: reverse ? reverse.minTransferSeconds !== minTransferSeconds : false,
    });
  }
  return report.sort((left, right) =>
    codepointCompare(`${left.stationId}:${left.fromLineId}:${left.toLineId}`, `${right.stationId}:${right.fromLineId}:${right.toLineId}`),
  );
}

// raw row 필드 파싱 및 형식 검증. 실패 시 { error } 반환(throw 금지).
function parseTransferRow(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "transfer row must be an object" };
  }
  const stationName = raw["환승역명"];
  const fromLineName = raw["호선"];
  const toLineName = raw["환승노선"];
  const distanceMeters = raw["환승거리"];
  const transferSeconds = raw["환승소요시간"];
  if (typeof stationName !== "string" || stationName.trim() === "") {
    return { error: "환승역명 must be a non-empty string" };
  }
  if (typeof fromLineName !== "string" || fromLineName.trim() === "") {
    return { error: "호선 must be a non-empty string" };
  }
  if (typeof toLineName !== "string" || toLineName.trim() === "") {
    return { error: "환승노선 must be a non-empty string" };
  }
  if (!Number.isInteger(distanceMeters) || distanceMeters < 0) {
    return { error: "환승거리 must be a non-negative integer" };
  }
  if (!Number.isInteger(transferSeconds) || transferSeconds < 0) {
    return { error: "환승소요시간 must be a non-negative integer" };
  }
  return {
    stationName: stationName.trim(),
    fromLineName: fromLineName.trim(),
    toLineName: toLineName.trim(),
    distanceMeters,
    transferSeconds,
  };
}

// PLATFORM 타입 노드만 stationId:lineId → nodeId 로 색인. 같은 키가 여러 개면 첫 노드 유지.
function platformNodeIndex(nodes) {
  const byStationLine = new Map();
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    if (String(node.nodeType ?? node.node_type ?? "") !== "PLATFORM") continue;
    const stationId = node.stationId ?? node.station_id;
    const lineId = node.lineId ?? node.line_id;
    const id = node.id;
    if (!stationId || !lineId || !id) continue;
    const key = `${stationId}:${lineId}`;
    if (!byStationLine.has(key)) {
      byStationLine.set(key, id);
    }
  }
  return byStationLine;
}

// 기존 station_pathway_edges에서 (station, fromLine, toLine) 방향 무관 쌍 키를 뽑는다.
// node id는 stationId:lineId... 형식을 가정하되, 없으면 명시적 stationId/lineId를 쓴다.
function existingEdgePairKeys(edges, nodes) {
  const pairs = new Set();
  const endpointsByNodeId = new Map();
  for (const node of nodes) {
    const id = node?.id;
    const stationId = node?.stationId ?? node?.station_id;
    const lineId = node?.lineId ?? node?.line_id;
    if (id && stationId && lineId) endpointsByNodeId.set(id, { stationId, lineId });
  }
  for (const edge of edges) {
    if (!edge || typeof edge !== "object") continue;
    const fromNodeId = edge.fromNodeId ?? edge.from_node_id;
    const toNodeId = edge.toNodeId ?? edge.to_node_id;
    const from =
      endpointsByNodeId.get(fromNodeId) ?? pathwayEndpointStationLine(fromNodeId, edge.fromStationId, edge.fromLineId);
    const to = endpointsByNodeId.get(toNodeId) ?? pathwayEndpointStationLine(toNodeId, edge.toStationId, edge.toLineId);
    if (!from || !to) continue;
    if (from.stationId !== to.stationId) continue;
    pairs.add(pathwayEdgePairKey(from.stationId, from.lineId, to.lineId));
  }
  return pairs;
}

function pathwayEndpointStationLine(nodeId, explicitStationId, explicitLineId) {
  if (explicitStationId && explicitLineId) {
    return { stationId: explicitStationId, lineId: explicitLineId };
  }
  if (typeof nodeId !== "string") return null;
  const parts = nodeId.split(":");
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return { stationId: parts[0], lineId: parts[1] };
}

// 방향 무관 쌍 키(정렬된 lineId 쌍) — 반대 방향 edge가 이미 있으면 baseline 생성 안 함.
function pathwayEdgePairKey(stationId, lineA, lineB) {
  return `${stationId}:${[lineA, lineB].sort(compareText).join("|")}`;
}

function compareText(left, right) {
  return codepointCompare(String(left), String(right));
}

if (isMainModule(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
