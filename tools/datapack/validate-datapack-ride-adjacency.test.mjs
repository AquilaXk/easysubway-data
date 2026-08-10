import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { validateProductionRideEdgeAdjacency } from "./validate-datapack.mjs";

const forwardProviderHash = "0123456789abcdef".repeat(4);
const reverseProviderHash = "fedcba9876543210".repeat(4);
const evidenceHash = "1234abcd5678ef90".repeat(4);

function productionPack(source = topologySource()) {
  return {
    id: "capital",
    version: 1,
    artifactKind: "production",
    sourceInventory: [source],
  };
}

function topologySource() {
  return {
    id: "capital-route-topology",
    updatedAt: "2026-08-09T00:00:00.000Z",
    coverageScope: {
      lineIds: ["seoul-6"],
      sourceDomains: ["route_graph_topology"],
    },
  };
}

function branchDatabase({
  reverse = true,
  reverseSnapshotId = "capital-route-topology-20260809",
  reverseEvidenceHash = evidenceHash,
  forwardProvenanceKind = "OFFICIAL_SOURCE",
  forwardLastVerifiedAt = 1786233600,
} = {}) {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE station_lines (
      station_id TEXT NOT NULL,
      line_id TEXT NOT NULL,
      line_sequence INTEGER NOT NULL
    );
    CREATE TABLE network_edges (
      id TEXT NOT NULL PRIMARY KEY,
      from_node_id TEXT NOT NULL,
      to_node_id TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      service_pattern TEXT NOT NULL,
      service_class TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_snapshot_id TEXT NOT NULL,
      provider_record_hash TEXT NOT NULL,
      provenance_kind TEXT NOT NULL,
      verification_status TEXT NOT NULL,
      last_verified_at INTEGER,
      evidence_hash TEXT NOT NULL
    );
    INSERT INTO station_lines VALUES
      ('station-eungam', 'seoul-6', 1),
      ('station-saejeol', 'seoul-6', 7);
  `);
  const insert = database.prepare(`
    INSERT INTO network_edges (
      id, from_node_id, to_node_id, edge_type, service_pattern, service_class,
      source_id, source_snapshot_id, provider_record_hash, provenance_kind,
      verification_status, last_verified_at, evidence_hash
    ) VALUES (?, ?, ?, 'RIDE', 'LOCAL', 'SUBWAY', ?, ?, ?, ?, 'VERIFIED', ?, ?)
  `);
  insert.run(
    "edge-seoul-6-eungam-saejeol",
    "station-eungam:seoul-6",
    "station-saejeol:seoul-6",
    "capital-route-topology",
    "capital-route-topology-20260809",
    forwardProviderHash,
    forwardProvenanceKind,
    forwardLastVerifiedAt,
    evidenceHash,
  );
  if (reverse) {
    insert.run(
      "edge-seoul-6-saejeol-eungam",
      "station-saejeol:seoul-6",
      "station-eungam:seoul-6",
      "capital-route-topology",
      reverseSnapshotId,
      reverseProviderHash,
      "OFFICIAL_SOURCE",
      1786233600,
      reverseEvidenceHash,
    );
  }
  return database;
}

test("공식 topology의 양방향 6호선 순환 분기 edge는 LOCAL로 보존한다", () => {
  const database = branchDatabase();
  try {
    assert.doesNotThrow(() => validateProductionRideEdgeAdjacency(database, productionPack(), true));
  } finally {
    database.close();
  }
});

for (const testCase of [
  {
    name: "역방향 edge 누락",
    database: () => branchDatabase({ reverse: false }),
    pack: () => productionPack(),
  },
  {
    name: "source line scope 누락",
    database: () => branchDatabase(),
    pack: () => productionPack({
      ...topologySource(),
      coverageScope: { lineIds: ["seoul-4"], sourceDomains: ["route_graph_topology"] },
    }),
  },
  {
    name: "역방향 snapshot identity 불일치",
    database: () => branchDatabase({ reverseSnapshotId: "capital-route-topology-forged" }),
    pack: () => productionPack(),
  },
  {
    name: "역방향 evidence identity 불일치",
    database: () => branchDatabase({ reverseEvidenceHash: forwardProviderHash }),
    pack: () => productionPack(),
  },
  {
    name: "OFFICIAL_SOURCE provenance 누락",
    database: () => branchDatabase({ forwardProvenanceKind: "GENERATED" }),
    pack: () => productionPack(),
  },
  {
    name: "검증 timestamp 누락",
    database: () => branchDatabase({ forwardLastVerifiedAt: 0 }),
    pack: () => productionPack(),
  },
]) {
  test(`비인접 LOCAL RIDE는 ${testCase.name}를 거부한다`, () => {
    const database = testCase.database();
    try {
      assert.throws(
        () => validateProductionRideEdgeAdjacency(database, testCase.pack(), true),
        /network_edges LOCAL RIDE edge must connect adjacent station-line sequences/,
      );
    } finally {
      database.close();
    }
  });
}
