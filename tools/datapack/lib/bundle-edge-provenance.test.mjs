import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  assertBundleEdgeProvenanceInvariants,
  deriveBundleEdgeProvenance,
  summarizeBundleEdgeProvenance,
} from "./bundle-edge-provenance.mjs";

// #951 RED 계획. 기대값은 손으로 적는다(도구 출력에서 복사하지 않는다).
// 규칙: 원천이 간선의 값(시간·거리)을 실제로 뒷받침할 때만 그 원천의 출처·검증 상태를 싣고, 나머지는 UNKNOWN으로 남긴다.

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const SNAPSHOT = "seoul-metro-transfer-car-door-duration-20260901T000000000Z";

const transferEdge = (overrides = {}) => ({
  edgeId: "transfer-s1-l1-l2", edgeType: "IN_STATION_TRANSFER", fromNodeId: "s1:l1", toNodeId: "s1:l2",
  durationSeconds: 120, distanceMeters: 150, servicePattern: "", serviceClass: "SUBWAY", ...overrides,
});
const rideEdge = (overrides = {}) => ({
  edgeId: "edge-l1-s1-s2", edgeType: "RIDE", fromNodeId: "s1:l1", toNodeId: "s2:l1",
  durationSeconds: 0, distanceMeters: 0, servicePattern: "LOCAL", serviceClass: "SUBWAY", ...overrides,
});
const rule = (overrides = {}) => ({
  id: "rule-transfer-s1-l1-l2", fromStationId: "s1", fromLineId: "l1", toStationId: "s1", toLineId: "l2",
  transferType: "IN_STATION", minTransferSeconds: 120, pathwayEdgeId: "pathway-s1-l1-l2",
  sourceId: "seoul-metro-transfer-car-door-duration", verificationStatus: "VERIFIED", ...overrides,
});
const pathway = (overrides = {}) => ({
  id: "pathway-s1-l1-l2", durationSeconds: 120, distanceMeters: 150,
  sourceId: "seoul-metro-transfer-car-door-duration", sourceSnapshotId: SNAPSHOT, providerRecordHash: HASH_A,
  provenanceKind: "OFFICIAL_SOURCE", verificationStatus: "VERIFIED", lastVerifiedAt: 1790872404, evidenceHash: HASH_B,
  ...overrides,
});
const sourceRide = (overrides = {}) => ({
  id: "edge-l1-s1-s2", fromNodeId: "s1:l1", toNodeId: "s2:l1", durationSeconds: 0, distanceMeters: 0,
  edgeType: "RIDE", servicePattern: "LOCAL", serviceClass: "SUBWAY",
  sourceId: "capital-route-topology", sourceSnapshotId: "capital-route-topology-20261004", providerRecordHash: HASH_A,
  provenanceKind: "OFFICIAL_SOURCE", verificationStatus: "VERIFIED", lastVerifiedAt: 1791123877, evidenceHash: HASH_B,
  ...overrides,
});
const derive = (input) => deriveBundleEdgeProvenance({ routeEdges: [], sourceEdges: [], transferRules: [], pathwayEdges: [], ...input });

test("공식 환승 이동 근거가 있는 역 안 환승 간선은 그 원천의 출처·검증 상태를 싣는다", () => {
  const [edge] = derive({ routeEdges: [transferEdge()], transferRules: [rule()], pathwayEdges: [pathway()] });
  assert.equal(edge.edgeId, "transfer-s1-l1-l2");
  assert.equal(edge.provenanceKind, "OFFICIAL_SOURCE");
  assert.equal(edge.verificationStatus, "VERIFIED");
  assert.equal(edge.sourceId, "seoul-metro-transfer-car-door-duration");
  assert.equal(edge.sourceSnapshotId, SNAPSHOT);
  assert.equal(edge.providerRecordHash, HASH_A);
  assert.equal(edge.evidenceHash, HASH_B);
  assert.equal(edge.lastVerifiedAt, 1790872404);
  // 시간·거리는 원천 값 그대로이고 바뀌지 않는다.
  assert.equal(edge.durationSeconds, 120);
  assert.equal(edge.distanceMeters, 150);
});

test("역방향 유도값(경로 행 없는 UNVERIFIED 규칙)과 규칙이 없는 환승 간선은 UNKNOWN으로 남는다", () => {
  const derived = rule({ id: "rule-transfer-s1-l2-l1", fromLineId: "l2", toLineId: "l1", pathwayEdgeId: null, verificationStatus: "UNVERIFIED" });
  const edges = derive({
    routeEdges: [
      transferEdge({ edgeId: "transfer-s1-l2-l1", fromNodeId: "s1:l2", toNodeId: "s1:l1" }),
      transferEdge({ edgeId: "transfer-s9-l1-l2", fromNodeId: "s9:l1", toNodeId: "s9:l2" }),
    ],
    transferRules: [derived],
  });
  for (const edge of edges) {
    assert.equal(edge.provenanceKind ?? "UNKNOWN", "UNKNOWN");
    assert.equal(edge.verificationStatus ?? "UNKNOWN", "UNKNOWN");
    assert.equal(edge.sourceId ?? "", "");
    assert.equal(edge.providerRecordHash ?? "", "");
  }
});

test("VERIFIED 규칙인데 근거 행이 없거나 값·원천이 어긋나면 추정으로 덮지 않고 실패한다", () => {
  const run = (overrides) => () => derive({ routeEdges: [transferEdge()], transferRules: [rule(overrides.rule)], pathwayEdges: overrides.pathways ?? [pathway(overrides.pathway)] });
  assert.throws(run({ rule: { pathwayEdgeId: null } }), /VERIFIED transfer rule has no pathway edge: rule-transfer-s1-l1-l2/);
  assert.throws(run({ pathways: [] }), /transfer rule pathway edge is missing: pathway-s1-l1-l2/);
  assert.throws(run({ pathway: { durationSeconds: 121 } }), /transfer pathway edge value does not match route edge: transfer-s1-l1-l2/);
  assert.throws(run({ pathway: { distanceMeters: 151 } }), /transfer pathway edge value does not match route edge: transfer-s1-l1-l2/);
  assert.throws(run({ rule: { minTransferSeconds: 119 } }), /transfer rule duration does not match route edge: transfer-s1-l1-l2/);
  assert.throws(run({ pathway: { sourceId: "other-source" } }), /transfer pathway edge source does not match rule: transfer-s1-l1-l2/);
  assert.throws(run({ pathway: { provenanceKind: "UNKNOWN" } }), /transfer pathway edge is not official verified evidence: transfer-s1-l1-l2/);
  assert.throws(run({ pathway: { verificationStatus: "UNVERIFIED" } }), /transfer pathway edge is not official verified evidence: transfer-s1-l1-l2/);
  assert.throws(run({ pathway: { providerRecordHash: "" } }), /transfer pathway edge evidence is incomplete: transfer-s1-l1-l2/);
  assert.throws(run({ pathway: { sourceSnapshotId: "" } }), /transfer pathway edge evidence is incomplete: transfer-s1-l1-l2/);
  assert.throws(run({ pathway: { lastVerifiedAt: 0 } }), /transfer pathway edge evidence is incomplete: transfer-s1-l1-l2/);
  assert.throws(() => derive({ routeEdges: [transferEdge()], transferRules: [rule(), rule({ id: "rule-dup" })], pathwayEdges: [pathway()] }), /transfer edge matches more than one rule: transfer-s1-l1-l2/);
});

test("원천에서 이미 공식 확인된 RIDE 간선만 그 출처를 싣고 같은 값일 때만 인정한다", () => {
  const [edge] = derive({ routeEdges: [rideEdge()], sourceEdges: [sourceRide()] });
  assert.equal(edge.provenanceKind, "OFFICIAL_SOURCE");
  assert.equal(edge.verificationStatus, "VERIFIED");
  assert.equal(edge.sourceId, "capital-route-topology");
  assert.equal(edge.sourceSnapshotId, "capital-route-topology-20261004");
  assert.equal(edge.lastVerifiedAt, 1791123877);
  for (const mismatch of [{ durationSeconds: 120 }, { distanceMeters: 5 }, { fromNodeId: "s3:l1" }, { toNodeId: "s3:l1" }, { servicePattern: "EXPRESS" }, { serviceClass: "ITX_CHEONGCHUN" }, { edgeType: "WALKWAY" }]) {
    assert.throws(() => derive({ routeEdges: [rideEdge()], sourceEdges: [sourceRide(mismatch)] }), /source network edge value does not match route edge: edge-l1-s1-s2/);
  }
  assert.throws(() => derive({ routeEdges: [rideEdge()], sourceEdges: [sourceRide({ provenanceKind: "OFFICIAL_SOURCE", verificationStatus: "NOT_VERIFIED" })] }), /source network edge provenance is not supported: edge-l1-s1-s2/);
  assert.throws(() => derive({ routeEdges: [rideEdge()], sourceEdges: [sourceRide({ providerRecordHash: "" })] }), /source network edge evidence is incomplete: edge-l1-s1-s2/);
  // 출처와 검증 상태가 섞인 원천 행은 UNKNOWN으로 조용히 낮추지 않고 실패한다(#956 F1).
  for (const mixed of [{ provenanceKind: "OFFICIAL_SOURCE", verificationStatus: "UNKNOWN" }, { provenanceKind: "UNKNOWN", verificationStatus: "VERIFIED" }]) {
    assert.throws(() => derive({ routeEdges: [rideEdge()], sourceEdges: [sourceRide(mixed)] }), /source network edge provenance is not supported: edge-l1-s1-s2/);
  }
});

test("원천 근거가 없는 RIDE 간선과 환승·RIDE 밖 간선은 UNKNOWN으로 남고 값은 그대로다", () => {
  const unknownSource = sourceRide({ sourceId: "", sourceSnapshotId: "", providerRecordHash: "", provenanceKind: "UNKNOWN", verificationStatus: "UNKNOWN", lastVerifiedAt: null, evidenceHash: "", durationSeconds: 120, reliabilityScore: 80 });
  const edges = derive({
    routeEdges: [rideEdge({ durationSeconds: 120 }), rideEdge({ edgeId: "edge-l9-a-b", fromNodeId: "a:l9", toNodeId: "b:l9" }), { ...rideEdge({ edgeId: "walkway-1", edgeType: "WALKWAY", fromNodeId: "s1:l1", toNodeId: "s1:l1" }) }],
    sourceEdges: [unknownSource],
  });
  assert.deepEqual(edges.map((edge) => [edge.provenanceKind ?? "UNKNOWN", edge.verificationStatus ?? "UNKNOWN", edge.sourceId ?? ""]), [["UNKNOWN", "UNKNOWN", ""], ["UNKNOWN", "UNKNOWN", ""], ["UNKNOWN", "UNKNOWN", ""]]);
  assert.equal(edges[0].durationSeconds, 120);
});

test("출처 집계 표는 간선 종류·출처·검증 상태·원천별 건수를 정렬해 센다", () => {
  const summary = summarizeBundleEdgeProvenance([
    { edgeType: "RIDE", provenanceKind: "OFFICIAL_SOURCE", verificationStatus: "VERIFIED", sourceId: "capital-route-topology" },
    { edgeType: "RIDE", provenanceKind: "OFFICIAL_SOURCE", verificationStatus: "VERIFIED", sourceId: "capital-route-topology" },
    { edgeType: "RIDE", provenanceKind: "UNKNOWN", verificationStatus: "UNKNOWN", sourceId: "" },
    { edgeType: "IN_STATION_TRANSFER", provenanceKind: "UNKNOWN", verificationStatus: "UNKNOWN", sourceId: "" },
    { edgeType: "IN_STATION_TRANSFER", provenanceKind: "OFFICIAL_SOURCE", verificationStatus: "VERIFIED", sourceId: "busan-transportation-route-topology" },
  ]);
  assert.deepEqual(summary, [
    { edgeType: "IN_STATION_TRANSFER", provenanceKind: "OFFICIAL_SOURCE", verificationStatus: "VERIFIED", sourceId: "busan-transportation-route-topology", count: 1 },
    { edgeType: "IN_STATION_TRANSFER", provenanceKind: "UNKNOWN", verificationStatus: "UNKNOWN", sourceId: "", count: 1 },
    { edgeType: "RIDE", provenanceKind: "OFFICIAL_SOURCE", verificationStatus: "VERIFIED", sourceId: "capital-route-topology", count: 2 },
    { edgeType: "RIDE", provenanceKind: "UNKNOWN", verificationStatus: "UNKNOWN", sourceId: "", count: 1 },
  ]);
});

test("번들 불변식은 근거 없는 VERIFIED·원천 없는 출처·규칙과 어긋난 환승 간선을 거부한다", () => {
  const verified = (overrides = {}) => ({
    id: "transfer-s1-l1-l2", edgeType: "IN_STATION_TRANSFER", fromNodeId: "s1:l1", toNodeId: "s1:l2", durationSeconds: 120,
    sourceId: "seoul-metro-transfer-car-door-duration", sourceSnapshotId: SNAPSHOT, providerRecordHash: HASH_A,
    provenanceKind: "OFFICIAL_SOURCE", verificationStatus: "VERIFIED", lastVerifiedAt: 1790872404, evidenceHash: HASH_B, ...overrides,
  });
  const unknown = (overrides = {}) => verified({ sourceId: "", sourceSnapshotId: "", providerRecordHash: "", provenanceKind: "UNKNOWN", verificationStatus: "UNKNOWN", lastVerifiedAt: null, evidenceHash: "", ...overrides });
  const ruleRow = (overrides = {}) => ({ id: "rule-1", fromStationId: "s1", fromLineId: "l1", toStationId: "s1", toLineId: "l2", minTransferSeconds: 120, sourceId: "seoul-metro-transfer-car-door-duration", verificationStatus: "VERIFIED", ...overrides });
  assert.doesNotThrow(() => assertBundleEdgeProvenanceInvariants({ edges: [verified()], transferRules: [ruleRow()] }));
  assert.doesNotThrow(() => assertBundleEdgeProvenanceInvariants({ edges: [unknown()], transferRules: [ruleRow({ sourceId: "x", verificationStatus: "UNVERIFIED" })] }));
  assert.doesNotThrow(() => assertBundleEdgeProvenanceInvariants({ edges: [unknown({ id: "edge-r", edgeType: "RIDE", fromNodeId: "s1:l1", toNodeId: "s2:l1" })], transferRules: [] }));
  const reject = (edges, rules, pattern) => assert.throws(() => assertBundleEdgeProvenanceInvariants({ edges, transferRules: rules }), pattern);
  reject([verified({ provenanceKind: "UNKNOWN" })], [ruleRow()], /edge provenance pair is not supported: transfer-s1-l1-l2/);
  reject([verified({ verificationStatus: "UNKNOWN" })], [ruleRow()], /edge provenance pair is not supported: transfer-s1-l1-l2/);
  reject([verified({ providerRecordHash: "" })], [ruleRow()], /VERIFIED edge evidence is incomplete: transfer-s1-l1-l2/);
  reject([verified({ lastVerifiedAt: null })], [ruleRow()], /VERIFIED edge evidence is incomplete: transfer-s1-l1-l2/);
  // #956 F2: 증거 hash는 64자 소문자 hex이고, 스냅샷 id는 그 간선의 원천 id로 시작하며, RIDE도 원천 id가 있어야 한다.
  const rideVerified = (overrides = {}) => verified({ id: "edge-r", edgeType: "RIDE", fromNodeId: "s1:l1", toNodeId: "s2:l1", sourceId: "capital-route-topology", sourceSnapshotId: "capital-route-topology-20261004", ...overrides });
  assert.doesNotThrow(() => assertBundleEdgeProvenanceInvariants({ edges: [rideVerified()], transferRules: [] }));
  for (const bad of [{ providerRecordHash: "not-a-hash" }, { providerRecordHash: "A".repeat(64) }, { evidenceHash: "b".repeat(63) }, { evidenceHash: `${"b".repeat(63)}g` }]) {
    reject([rideVerified(bad)], [], /VERIFIED edge evidence is incomplete: edge-r/);
  }
  reject([rideVerified({ sourceId: "" })], [], /VERIFIED edge evidence is incomplete: edge-r/);
  reject([rideVerified({ sourceSnapshotId: "incheon-transit-station-info-20261004" })], [], /VERIFIED edge source snapshot does not belong to its source: edge-r/);
  // UNKNOWN 간선은 증거 칸이 하나라도 새면 거부한다(#956 F1): 칸마다 따로 확인한다.
  for (const leak of [{ sourceId: "leaked-source" }, { sourceSnapshotId: "leaked-snapshot" }, { providerRecordHash: HASH_A }, { evidenceHash: HASH_B }, { lastVerifiedAt: 1790872404 }]) {
    reject([unknown(leak)], [ruleRow({ verificationStatus: "UNVERIFIED" })], /UNKNOWN edge must not carry source evidence: transfer-s1-l1-l2/);
  }
  reject([verified()], [], /VERIFIED transfer edge has no VERIFIED rule: transfer-s1-l1-l2/);
  reject([verified()], [ruleRow({ verificationStatus: "UNVERIFIED" })], /VERIFIED transfer edge has no VERIFIED rule: transfer-s1-l1-l2/);
  reject([verified()], [ruleRow({ sourceId: "other" })], /VERIFIED transfer edge source does not match rule: transfer-s1-l1-l2/);
  reject([verified()], [ruleRow({ minTransferSeconds: 90 })], /VERIFIED transfer edge duration does not match rule: transfer-s1-l1-l2/);
  reject([unknown()], [ruleRow()], /VERIFIED transfer rule has no VERIFIED edge: rule-1/);
});

// 커밋된 후보 fixture의 값으로, 입력이 바뀌어도(원천 갱신 PR) 깨지지 않는 구조 불변식을 건다. 숫자는 fixture에서 유도한다.
test("커밋된 전국 후보의 역 안 환승 간선은 규칙이 VERIFIED인 것만 공식 원천을 싣고 나머지는 UNKNOWN이다", async () => {
  const preparation = JSON.parse(await readFile("tools/datapack/release/nationwide-candidate-preparation.json", "utf8"));
  const [fixture, routeInput] = await Promise.all([
    readFile(JSON.parse(await readFile("tools/datapack/release/candidate-build-spec.json", "utf8")).fixturePath, "utf8").then(JSON.parse),
    readFile(preparation.routeEdgeInput.path, "utf8").then(JSON.parse),
  ]);
  const pack = fixture.packs.find(({ id }) => id === fixture.manifest.activePack.id);
  const transferEdges = routeInput.routeEdges.filter(({ edgeType }) => edgeType === "IN_STATION_TRANSFER");
  assert.ok(transferEdges.length > 0);
  const derived = deriveBundleEdgeProvenance({
    routeEdges: transferEdges,
    sourceEdges: [],
    transferRules: pack.transferRules,
    // 팩 fixture의 시각은 ISO 문자열이고, 번들 SQLite에는 초 단위 정수(build-datapack의 timestamp())로 실린다.
    pathwayEdges: pack.stationPathwayEdges.map((row) => ({ ...row, lastVerifiedAt: Math.floor(Date.parse(row.lastVerifiedAt) / 1000) })),
  });
  const rules = new Map(pack.transferRules.map((row) => [`${row.fromStationId}:${row.fromLineId}>${row.toStationId}:${row.toLineId}`, row]));
  const verifiedEdgeIds = new Set(derived.filter(({ verificationStatus }) => verificationStatus === "VERIFIED").map(({ edgeId }) => edgeId));
  const expectedVerified = transferEdges.filter(({ fromNodeId, toNodeId }) => rules.get(`${fromNodeId}>${toNodeId}`)?.verificationStatus === "VERIFIED");
  assert.ok(expectedVerified.length > 0);
  assert.equal(verifiedEdgeIds.size, expectedVerified.length);
  for (const edge of derived) {
    const row = rules.get(`${edge.fromNodeId}>${edge.toNodeId}`);
    if (verifiedEdgeIds.has(edge.edgeId)) {
      assert.equal(edge.provenanceKind, "OFFICIAL_SOURCE");
      assert.equal(edge.sourceId, row.sourceId);
      assert.equal(edge.durationSeconds, row.minTransferSeconds);
    } else {
      assert.equal(edge.provenanceKind ?? "UNKNOWN", "UNKNOWN");
      assert.equal(edge.sourceId ?? "", "");
    }
  }
  // 집계 표의 합은 간선 수와 같고, 출처가 있는 칸은 모두 공식 검증이다.
  const summary = summarizeBundleEdgeProvenance(derived.map((edge) => ({ ...edge, provenanceKind: edge.provenanceKind ?? "UNKNOWN", verificationStatus: edge.verificationStatus ?? "UNKNOWN", sourceId: edge.sourceId ?? "" })));
  assert.equal(summary.reduce((sum, { count }) => sum + count, 0), transferEdges.length);
  assert.ok(summary.every(({ sourceId, provenanceKind, verificationStatus }) => sourceId === "" ? provenanceKind === "UNKNOWN" && verificationStatus === "UNKNOWN" : provenanceKind === "OFFICIAL_SOURCE" && verificationStatus === "VERIFIED"));
});

test("번들 topology SQLite 행으로도 같은 불변식을 확인한다", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE network_edges (id TEXT, edge_type TEXT, from_node_id TEXT, to_node_id TEXT, duration_seconds INTEGER, source_id TEXT, source_snapshot_id TEXT, provider_record_hash TEXT, provenance_kind TEXT, verification_status TEXT, last_verified_at INTEGER, evidence_hash TEXT)");
    db.prepare("INSERT INTO network_edges VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("edge-r", "RIDE", "s1:l1", "s2:l1", 0, "", "", "", "UNKNOWN", "UNKNOWN", null, "");
    const rows = db.prepare("SELECT id, edge_type AS edgeType, from_node_id AS fromNodeId, to_node_id AS toNodeId, duration_seconds AS durationSeconds, source_id AS sourceId, source_snapshot_id AS sourceSnapshotId, provider_record_hash AS providerRecordHash, provenance_kind AS provenanceKind, verification_status AS verificationStatus, last_verified_at AS lastVerifiedAt, evidence_hash AS evidenceHash FROM network_edges").all().map((row) => ({ ...row }));
    assert.doesNotThrow(() => assertBundleEdgeProvenanceInvariants({ edges: rows, transferRules: [] }));
  } finally {
    db.close();
  }
});
