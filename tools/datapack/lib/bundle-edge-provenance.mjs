// #951: 서버 경로 번들 network_edges의 출처(provenance_kind)·검증 상태(verification_status)를 실제 원천 근거대로 싣는다.
// - 원천이 간선의 값(시간·거리)을 실제로 뒷받침할 때만 그 원천의 출처·검증 상태를 싣는다. 나머지는 UNKNOWN으로 남기고 추정하지 않는다.
// - 역 안 환승 간선: 같은 방향의 transfer_rules가 VERIFIED이고, 규칙이 가리키는 station_pathway_edges 행이 공식 원천(OFFICIAL_SOURCE/VERIFIED)이며
//   그 행의 시간·거리가 간선 값과 같을 때만 그 행의 원천 칸을 싣는다. 경로 행 없는 UNVERIFIED 규칙(역방향 유도값)과 규칙 없는 간선은 UNKNOWN이다.
// - RIDE 간선: 원천 팩의 network_edges 행이 이미 OFFICIAL_SOURCE/VERIFIED이고 값이 같을 때만 그 칸을 싣는다. 원천 행이 UNKNOWN이거나 없으면 UNKNOWN이다.
// - 근거가 있다고 주장하는데 값·원천이 어긋나면 UNKNOWN으로 낮추지 않고 실패한다(손상된 근거를 조용히 덮지 않는다).
const OFFICIAL = Object.freeze({ provenanceKind: "OFFICIAL_SOURCE", verificationStatus: "VERIFIED" });
const EVIDENCE_COLUMNS = Object.freeze(["sourceId", "sourceSnapshotId", "providerRecordHash", "evidenceHash"]);
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const ROUTE_VALUE_COLUMNS = Object.freeze(["fromNodeId", "toNodeId", "durationSeconds", "distanceMeters", "edgeType", "servicePattern", "serviceClass"]);

export function deriveBundleEdgeProvenance({ routeEdges, sourceEdges, transferRules, pathwayEdges }) {
  for (const [name, value] of Object.entries({ routeEdges, sourceEdges, transferRules, pathwayEdges })) {
    if (!Array.isArray(value)) throw new Error(`bundle edge provenance input is invalid: ${name}`);
  }
  const sourceById = new Map(sourceEdges.map((row) => [row.id, row]));
  const pathwayById = new Map(pathwayEdges.map((row) => [row.id, row]));
  const rulesByDirection = new Map();
  for (const row of transferRules) {
    const key = directionKey(row.fromStationId, row.fromLineId, row.toStationId, row.toLineId);
    rulesByDirection.set(key, [...(rulesByDirection.get(key) ?? []), row]);
  }
  return routeEdges.map((edge) => {
    if (edge.edgeType === "IN_STATION_TRANSFER") return withEvidence(edge, transferEvidence(edge, rulesByDirection, pathwayById));
    if (edge.edgeType === "RIDE") return withEvidence(edge, rideEvidence(edge, sourceById.get(edge.edgeId)));
    return edge;
  });
}

function transferEvidence(edge, rulesByDirection, pathwayById) {
  const from = endpoint(edge.fromNodeId);
  const to = endpoint(edge.toNodeId);
  const rules = rulesByDirection.get(directionKey(from.stationId, from.lineId, to.stationId, to.lineId)) ?? [];
  if (rules.length > 1) throw new Error(`transfer edge matches more than one rule: ${edge.edgeId}`);
  const [rule] = rules;
  if (!rule || rule.verificationStatus !== "VERIFIED") return null;
  if (!rule.pathwayEdgeId) throw new Error(`VERIFIED transfer rule has no pathway edge: ${rule.id}`);
  const pathway = pathwayById.get(rule.pathwayEdgeId);
  if (!pathway) throw new Error(`transfer rule pathway edge is missing: ${rule.pathwayEdgeId}`);
  if (rule.minTransferSeconds !== edge.durationSeconds) throw new Error(`transfer rule duration does not match route edge: ${edge.edgeId}`);
  if (pathway.durationSeconds !== edge.durationSeconds || pathway.distanceMeters !== edge.distanceMeters) {
    throw new Error(`transfer pathway edge value does not match route edge: ${edge.edgeId}`);
  }
  if (pathway.sourceId !== rule.sourceId) throw new Error(`transfer pathway edge source does not match rule: ${edge.edgeId}`);
  if (pathway.provenanceKind !== OFFICIAL.provenanceKind || pathway.verificationStatus !== OFFICIAL.verificationStatus) {
    throw new Error(`transfer pathway edge is not official verified evidence: ${edge.edgeId}`);
  }
  if (!completeEvidence(pathway)) throw new Error(`transfer pathway edge evidence is incomplete: ${edge.edgeId}`);
  return evidenceOf(pathway);
}

function rideEvidence(edge, source) {
  if (!source || (source.provenanceKind === "UNKNOWN" && source.verificationStatus === "UNKNOWN")) return null;
  if (source.provenanceKind !== OFFICIAL.provenanceKind || source.verificationStatus !== OFFICIAL.verificationStatus) {
    throw new Error(`source network edge provenance is not supported: ${edge.edgeId}`);
  }
  if (ROUTE_VALUE_COLUMNS.some((column) => source[column] !== edge[column])) {
    throw new Error(`source network edge value does not match route edge: ${edge.edgeId}`);
  }
  if (!completeEvidence(source)) throw new Error(`source network edge evidence is incomplete: ${edge.edgeId}`);
  return evidenceOf(source);
}

// 번들(topology component)에 실린 간선 행의 불변식. 생성기 규칙을 다시 계산하지 않고, 행끼리 서로 모순이 없는지만 본다.
// - 출처·검증 상태 쌍은 (UNKNOWN, UNKNOWN) 또는 (OFFICIAL_SOURCE, VERIFIED)뿐이다.
// - VERIFIED 간선은 원천 칸이 모두 있고, UNKNOWN 간선은 원천 칸이 비어 있다.
// - 역 안 환승 간선의 VERIFIED는 같은 방향 transfer_rules의 VERIFIED(같은 원천·같은 시간)와 일대일로 맞는다.
export function assertBundleEdgeProvenanceInvariants({ edges, transferRules }) {
  const rulesByDirection = new Map();
  for (const rule of transferRules) {
    const key = directionKey(rule.fromStationId, rule.fromLineId, rule.toStationId, rule.toLineId);
    rulesByDirection.set(key, [...(rulesByDirection.get(key) ?? []), rule]);
  }
  const verifiedRuleDirections = new Set();
  for (const edge of edges) {
    const official = edge.provenanceKind === OFFICIAL.provenanceKind && edge.verificationStatus === OFFICIAL.verificationStatus;
    const unknown = edge.provenanceKind === "UNKNOWN" && edge.verificationStatus === "UNKNOWN";
    if (!official && !unknown) throw new Error(`edge provenance pair is not supported: ${edge.id}`);
    if (unknown) {
      const hasEvidence = EVIDENCE_COLUMNS.some((column) => (edge[column] ?? "") !== "") || (edge.lastVerifiedAt ?? null) !== null;
      if (hasEvidence) throw new Error(`UNKNOWN edge must not carry source evidence: ${edge.id}`);
    } else {
      if (!completeEvidence(edge)) throw new Error(`VERIFIED edge evidence is incomplete: ${edge.id}`);
      // 스냅샷 id는 그 간선의 원천 id로 시작한다(다른 원천의 스냅샷을 가리키는 근거를 거부한다).
      if (!edge.sourceSnapshotId.startsWith(`${edge.sourceId}-`)) throw new Error(`VERIFIED edge source snapshot does not belong to its source: ${edge.id}`);
    }
    if (edge.edgeType !== "IN_STATION_TRANSFER") continue;
    const from = endpoint(edge.fromNodeId);
    const to = endpoint(edge.toNodeId);
    const key = directionKey(from.stationId, from.lineId, to.stationId, to.lineId);
    const rule = (rulesByDirection.get(key) ?? []).find(({ verificationStatus }) => verificationStatus === "VERIFIED");
    if (official) {
      if (!rule) throw new Error(`VERIFIED transfer edge has no VERIFIED rule: ${edge.id}`);
      if (rule.sourceId !== edge.sourceId) throw new Error(`VERIFIED transfer edge source does not match rule: ${edge.id}`);
      if (rule.minTransferSeconds !== edge.durationSeconds) throw new Error(`VERIFIED transfer edge duration does not match rule: ${edge.id}`);
      verifiedRuleDirections.add(key);
    }
  }
  for (const rule of transferRules.filter(({ verificationStatus }) => verificationStatus === "VERIFIED")) {
    if (!verifiedRuleDirections.has(directionKey(rule.fromStationId, rule.fromLineId, rule.toStationId, rule.toLineId))) {
      throw new Error(`VERIFIED transfer rule has no VERIFIED edge: ${rule.id}`);
    }
  }
}

// 간선 종류·출처·검증 상태·원천별 건수 표(바이트 순 정렬). release 검토와 테스트가 같은 표를 쓴다.
export function summarizeBundleEdgeProvenance(rows) {
  const counts = new Map();
  for (const { edgeType, provenanceKind, verificationStatus, sourceId } of rows) {
    const key = JSON.stringify([edgeType, provenanceKind, verificationStatus, sourceId]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) => {
    const [edgeType, provenanceKind, verificationStatus, sourceId] = JSON.parse(key);
    return { edgeType, provenanceKind, verificationStatus, sourceId, count };
  }).sort((left, right) => compareBytes(JSON.stringify([left.edgeType, left.provenanceKind, left.verificationStatus, left.sourceId]),
    JSON.stringify([right.edgeType, right.provenanceKind, right.verificationStatus, right.sourceId])));
}

function withEvidence(edge, evidence) {
  return evidence === null ? edge : { ...edge, ...evidence };
}

function evidenceOf(row) {
  return {
    sourceId: row.sourceId,
    sourceSnapshotId: row.sourceSnapshotId,
    providerRecordHash: row.providerRecordHash,
    provenanceKind: OFFICIAL.provenanceKind,
    verificationStatus: OFFICIAL.verificationStatus,
    lastVerifiedAt: row.lastVerifiedAt,
    evidenceHash: row.evidenceHash,
  };
}

function completeEvidence(row) {
  return EVIDENCE_COLUMNS.every((column) => typeof row[column] === "string" && row[column] !== "")
    && SHA256_HEX.test(row.providerRecordHash) && SHA256_HEX.test(row.evidenceHash)
    && Number.isSafeInteger(row.lastVerifiedAt) && row.lastVerifiedAt > 0;
}

function endpoint(nodeId) {
  const parts = String(nodeId).split(":");
  if (parts.length !== 2 || parts.some((part) => part === "")) throw new Error(`bundle edge endpoint is invalid: ${nodeId}`);
  return { stationId: parts[0], lineId: parts[1] };
}

function directionKey(fromStationId, fromLineId, toStationId, toLineId) {
  return JSON.stringify([fromStationId, fromLineId, toStationId, toLineId]);
}

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
