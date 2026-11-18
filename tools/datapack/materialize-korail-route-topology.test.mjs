import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalJson } from "./lib/manifest-validation.mjs";
import { materializeKorailRouteTopology } from "./materialize-korail-route-topology.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const NOW = new Date("2040-01-02T00:00:00.000Z");

test("replaces selected-line RIDE rows while preserving non-RIDE and unrelated-line rows", () => {
  const value = fixture(), before = structuredClone(value.pack);
  const result = materializeKorailRouteTopology({ ...value, now: NOW });
  assert.deepEqual(value.pack, before);
  assert.equal(result.networkEdges.some(({ id }) => id === "old-selected-ride"), false);
  assert.deepEqual(result.networkEdges.filter(({ id }) => ["entry", "transfer", "other-ride"].includes(id)), before.networkEdges.filter(({ id }) => ["entry", "transfer", "other-ride"].includes(id)));
  const edge = result.networkEdges.find(({ id }) => id === "edge-line-a-a-b");
  assert.equal(edge.durationSeconds, 120);
  assert.equal(edge.witness.trainNo, "T1");
  assert.equal(edge.fieldProvenance.duration_seconds.derivationKind, "GENERATED");
  assert.equal(result.minimumTableRows.network_edges, result.networkEdges.length);
  assert.equal(result.sourceInventory.filter(({ id }) => id === value.snapshot.sourceId).length, 1);
  assert.deepEqual(result.sourceInventory.at(-1).fields, ["network_edges", "duration_seconds"]);
  assert.equal(result.networkEdges.some(({ id }) => id === "stale-selected-ride"), false);
});

test("accepts unrelated pack metadata but rejects binding, stale, and ledger identity drift", () => {
  const value = fixture();
  assert.doesNotThrow(() => materializeKorailRouteTopology({ ...value, pack: { ...value.pack, unrelated: { changed: true } }, now: NOW }));
  const brokenBinding = structuredClone(value.snapshot); brokenBinding.observation.stationBindings[0].stationId = "wrong";
  assert.throws(() => materializeKorailRouteTopology({ ...value, snapshot: brokenBinding, now: NOW }), /BINDINGS|SNAPSHOT/);
  assert.throws(() => materializeKorailRouteTopology({ ...value, now: new Date(value.snapshot.freshUntil) }), /SNAPSHOT|LEDGER/);
  assert.throws(() => materializeKorailRouteTopology({ ...value, ledger: [{ ...value.ledger[0], contentSha256: "0".repeat(64) }], now: NOW }), /LEDGER/);
  assert.throws(() => materializeKorailRouteTopology({ ...value, ledger: [{ ...value.ledger[0], rawRetentionExpiresAt: "invalid" }], now: NOW }), /LEDGER/);
});

test("rejects incomplete directional coverage without changing the existing pack", () => {
  const value = fixture(false), before = structuredClone(value.pack);
  assert.throws(() => materializeKorailRouteTopology({ ...value, now: NOW }), /DIRECTIONAL_COVERAGE/);
  assert.deepEqual(value.pack, before);
});

function fixture(complete = true) {
  const capturedAt = new Date(NOW.valueOf() - 86400000).toISOString(), rawSha256 = "a".repeat(64);
  const witness = { sheetName: "weekday", trainNo: "T1", durationSeconds: 120, departure: { cellId: "B1", rawValue: "0.5", seconds: 43200 }, arrival: { cellId: "B2", rawValue: String(43320 / 86400), seconds: 43320 } };
  const bindings = [{ stationNumber: "1", stationName: "A", stationId: "a" }, { stationNumber: "2", stationName: "B", stationId: "b" }];
  const observation = { selection: { lineId: "line-a" }, stationBindings: bindings, topology: { orders: [{ stations: [{ stationNumber: "1", stationName: "A" }, { stationNumber: "2", stationName: "B" }] }], edges: [{ fromStationNumber: "1", toStationNumber: "2", observations: [witness] }] } };
  observation.topologyDurations = [{ lineId: "line-a", fromStationId: "a", toStationId: "b", durationSeconds: 120, derivationPolicy: "MIN_OBSERVED_SCHEDULED_DURATION_V1", witness }];
  if (complete) {
    const reverseWitness = { ...witness, sheetName: "reverse", trainNo: "T2" };
    observation.topology.orders.push({ stations: [...observation.topology.orders[0].stations].reverse() });
    observation.topology.edges.push({ fromStationNumber: "2", toStationNumber: "1", observations: [reverseWitness] });
    observation.topologyDurations.push({ lineId: "line-a", fromStationId: "b", toStationId: "a", durationSeconds: 120, derivationPolicy: "MIN_OBSERVED_SCHEDULED_DURATION_V1", witness: reverseWitness });
  }
  const snapshot = { schemaVersion: 1, artifactKind: "korail-metropolitan-topology-snapshot", status: "PENDING", releaseEligible: false, sourceId: "korail-metropolitan-timetable-file", capturedAt, freshUntil: new Date(NOW.valueOf() + 86400000).toISOString(), rawSha256, stationCount: 2, edgeCount: 1, observation };
  snapshot.edgeCount = observation.topologyDurations.length;
  snapshot.contentSha256 = sha(canonicalJson(snapshot)); snapshot.snapshotId = `${snapshot.sourceId}-${snapshot.contentSha256}`;
  const evidence = { snapshotId: snapshot.snapshotId, snapshotPath: `tools/datapack/sources/${snapshot.snapshotId}.json`, contentSha256: snapshot.contentSha256, rawSha256, capturedAt, freshUntil: snapshot.freshUntil, stationCount: 2, edgeCount: 1, excludedTransferCount: 0 };
  evidence.edgeCount = snapshot.edgeCount;
  const source = { id: snapshot.sourceId, requiredForProductionPack: true, productionUseAllowed: true, coverageScope: { lineIds: ["line-a"], operatorIds: ["korail"] }, topologyAdmissionEvidence: evidence };
  Object.assign(source, { owner: "fixture provider", datasetUrl: "https://example.org/fixture", license: { name: "fixture license", redistributionAllowed: true },
    updateFrequency: "P1D", fieldsProvided: ["network_edges", "duration_seconds"] });
  const ledger = [{ snapshotId: snapshot.snapshotId, sourceId: snapshot.sourceId, previousSnapshotId: null, retrievedAt: capturedAt, sourceUpdatedAt: null, rawSha256, schemaFingerprint: "b".repeat(64), redactedRequestFingerprint: "c".repeat(64), rowCount: 1, coverageCount: 2, contentSha256: snapshot.contentSha256, capturedAt, freshnessExpiresAt: snapshot.freshUntil, rawRetentionExpiresAt: new Date(NOW.valueOf() + 90 * 86400000).toISOString(), rawObjectUri: "oci://bucket/source-raw/x", rawReceiptSha256: "d".repeat(64), snapshotStatus: "LOCKED", schemaStatus: "PASS", licenseStatus: "PASS", fetchStatus: "SUCCESS", redistributionAllowed: true }];
  const pack = { stations: [{ id: "a", nameKo: "A" }, { id: "b", nameKo: "B" }, { id: "x", nameKo: "X" }], lines: [{ id: "line-a", operatorId: "korail" }, { id: "other", operatorId: "other" }], stationLines: [{ stationId: "a", lineId: "line-a", lineSequence: 1 }, { stationId: "b", lineId: "line-a", lineSequence: 2 }], networkEdges: [{ id: "old-selected-ride", fromNodeId: "a:line-a", toNodeId: "b:line-a", edgeType: "RIDE" }, { id: "entry", fromNodeId: "a:line-a", toNodeId: "gate", edgeType: "ENTRY" }, { id: "transfer", fromNodeId: "a:line-a", toNodeId: "x:other", edgeType: "TRANSFER" }, { id: "other-ride", fromNodeId: "x:other", toNodeId: "y:other", edgeType: "RIDE" }], sourceInventory: [], minimumTableRows: { stations: 3 } };
  pack.networkEdges.push({ id: "stale-selected-ride", fromNodeId: "removed:line-a", toNodeId: "a:line-a", edgeType: "RIDE" });
  return { pack, snapshot, inventory: { sources: [source] }, ledger };
}
