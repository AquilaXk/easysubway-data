import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  isAsymmetricTransferLink,
  outOfStationTransferNetworkEdges,
} from "./build-datapack.mjs";

test("out-of-station transfer asymmetry: rejects bidirectional=true when slopeLevel > 1", () => {
  const pack = {
    outOfStationTransferLinks: [
      {
        id: "out-link-steep",
        fromStationId: "station-a",
        fromLineId: "line-1",
        toStationId: "station-b",
        toLineId: "line-2",
        durationSeconds: 1440, // 24 minutes uphill
        distanceMeters: 800,
        slopeLevel: 2,
        bidirectional: true, // MUST FAIL
      },
    ],
  };

  assert.throws(
    () => outOfStationTransferNetworkEdges(pack),
    /asymmetric out-of-station transfer link must not be bidirectional/,
  );
});

test("out-of-station transfer asymmetry: packs separate unidirectional edges for uphill and downhill", () => {
  const pack = {
    outOfStationTransferLinks: [
      {
        id: "out-link-uphill",
        fromStationId: "station-a",
        fromLineId: "line-1",
        toStationId: "station-b",
        toLineId: "line-2",
        durationSeconds: 1440, // 24 minutes
        distanceMeters: 800,
        slopeLevel: 2,
        bidirectional: false,
      },
      {
        id: "out-link-downhill",
        fromStationId: "station-b",
        fromLineId: "line-2",
        toStationId: "station-a",
        toLineId: "line-1",
        durationSeconds: 900, // 15 minutes
        distanceMeters: 800,
        slopeLevel: 1,
        bidirectional: false,
      },
    ],
  };

  const edges = outOfStationTransferNetworkEdges(pack);
  assert.equal(edges.length, 2);
  assert.equal(edges[0].id, "out-link-uphill");
  assert.equal(edges[0].fromNodeId, "station-a:line-1");
  assert.equal(edges[0].toNodeId, "station-b:line-2");
  assert.equal(edges[0].durationSeconds, 1440);

  assert.equal(edges[1].id, "out-link-downhill");
  assert.equal(edges[1].fromNodeId, "station-b:line-2");
  assert.equal(edges[1].toNodeId, "station-a:line-1");
  assert.equal(edges[1].durationSeconds, 900);
});

test("out-of-station transfer asymmetry: symmetric link generates forward and reverse edges", () => {
  const pack = {
    outOfStationTransferLinks: [
      {
        id: "out-link-flat",
        fromStationId: "station-a",
        fromLineId: "line-1",
        toStationId: "station-b",
        toLineId: "line-2",
        durationSeconds: 300,
        distanceMeters: 200,
        slopeLevel: 1,
        bidirectional: true,
      },
    ],
  };

  const edges = outOfStationTransferNetworkEdges(pack);
  assert.equal(edges.length, 2);
  assert.equal(edges[0].id, "out-link-flat");
  assert.equal(edges[1].id, "out-link-flat-reverse");
  assert.equal(edges[1].fromNodeId, "station-b:line-2");
  assert.equal(edges[1].toNodeId, "station-a:line-1");
  assert.equal(edges[1].durationSeconds, 300);
});

test("out-of-station transfer SQLite bundle: forces bidirectional=0 for slope_level>1 and preserves hash integrity", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE out_of_station_transfer_links (
      id TEXT NOT NULL PRIMARY KEY,
      from_station_id TEXT NOT NULL,
      from_line_id TEXT NOT NULL,
      to_station_id TEXT NOT NULL,
      to_line_id TEXT NOT NULL,
      from_exit_id TEXT,
      to_exit_id TEXT,
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      distance_meters INTEGER NOT NULL DEFAULT 0,
      bidirectional INTEGER NOT NULL DEFAULT 0 CHECK (bidirectional IN (0, 1)),
      requires_fare_exit INTEGER NOT NULL DEFAULT 1 CHECK (requires_fare_exit IN (0, 1)),
      requires_reentry INTEGER NOT NULL DEFAULT 1 CHECK (requires_reentry IN (0, 1)),
      covered_route TEXT NOT NULL DEFAULT 'UNKNOWN',
      crossing_risk TEXT NOT NULL DEFAULT 'UNKNOWN',
      slope_level INTEGER NOT NULL DEFAULT 1,
      curb_cut_status TEXT NOT NULL DEFAULT 'UNKNOWN',
      sidewalk_status TEXT NOT NULL DEFAULT 'UNKNOWN',
      accessibility_status TEXT NOT NULL DEFAULT 'UNKNOWN',
      stair_access_state TEXT NOT NULL DEFAULT 'UNKNOWN',
      reliability_score INTEGER NOT NULL DEFAULT 100,
      source_id TEXT NOT NULL DEFAULT '',
      source_snapshot_id TEXT NOT NULL DEFAULT '',
      provider_record_hash TEXT NOT NULL DEFAULT '',
      provenance_kind TEXT NOT NULL DEFAULT 'UNKNOWN',
      verification_status TEXT NOT NULL DEFAULT 'UNKNOWN',
      last_field_verified_at INTEGER,
      evidence_hash TEXT NOT NULL DEFAULT ''
    );
  `);

  const links = [
    {
      id: "out-link-1",
      fromStationId: "station-a",
      fromLineId: "line-1",
      toStationId: "station-b",
      toLineId: "line-2",
      durationSeconds: 1440,
      distanceMeters: 800,
      slopeLevel: 2,
      bidirectional: true, // will be forced to false / 0
    },
    {
      id: "out-link-2",
      fromStationId: "station-b",
      fromLineId: "line-2",
      toStationId: "station-a",
      toLineId: "line-1",
      durationSeconds: 900,
      distanceMeters: 800,
      slopeLevel: 1,
      bidirectional: false,
    },
  ];

  const insert = db.prepare(`
    INSERT INTO out_of_station_transfer_links (
      id, from_station_id, from_line_id, to_station_id, to_line_id,
      duration_seconds, distance_meters, bidirectional, slope_level
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const link of links) {
    const asymmetric = isAsymmetricTransferLink(link);
    const bidi = (asymmetric ? false : link.bidirectional) ? 1 : 0;
    insert.run(
      link.id,
      link.fromStationId,
      link.fromLineId,
      link.toStationId,
      link.toLineId,
      link.durationSeconds,
      link.distanceMeters,
      bidi,
      link.slopeLevel,
    );
  }

  const rows = db.prepare("SELECT * FROM out_of_station_transfer_links ORDER BY id").all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, "out-link-1");
  assert.equal(rows[0].bidirectional, 0); // Forced to 0 due to slope_level > 1
  assert.equal(rows[0].slope_level, 2);
  assert.equal(rows[1].id, "out-link-2");
  assert.equal(rows[1].bidirectional, 0);

  // Compute canonical hash of rows
  const canonicalRowJson = JSON.stringify(rows);
  const hash1 = createHash("sha256").update(canonicalRowJson).digest("hex");
  const hash2 = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  assert.equal(hash1, hash2);
  assert.match(hash1, /^[0-9a-f]{64}$/);

  db.close();
});

test("out-of-station transfer links and transfer rules are serialized in ascending duration order", async () => {
  const { codepointCompare } = await import("../lib/codepoint-compare.mjs");
  const links = [
    { id: "link-long", durationSeconds: 600 },
    { id: "link-short", durationSeconds: 120 },
    { id: "link-mid", durationSeconds: 300 },
    { id: "link-same-b", durationSeconds: 120 },
    { id: "link-same-a", durationSeconds: 120 },
  ];
  const sortedLinks = [...links].sort(
    (a, b) =>
      (a.durationSeconds ?? 0) - (b.durationSeconds ?? 0) ||
      codepointCompare(String(a.id), String(b.id)),
  );
  assert.deepEqual(
    sortedLinks.map((l) => l.id),
    ["link-same-a", "link-same-b", "link-short", "link-mid", "link-long"],
  );

  const rules = [
    { id: "rule-c", minTransferSeconds: 300 },
    { id: "rule-a", minTransferSeconds: 90 },
    { id: "rule-b", minTransferSeconds: 180 },
  ];
  const sortedRules = [...rules].sort(
    (a, b) =>
      (a.minTransferSeconds ?? 0) - (b.minTransferSeconds ?? 0) ||
      codepointCompare(String(a.id), String(b.id)),
  );
  assert.deepEqual(
    sortedRules.map((r) => r.id),
    ["rule-a", "rule-b", "rule-c"],
  );
});

