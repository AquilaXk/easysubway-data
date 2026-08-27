import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { buildPublicStaticNetworkV2Observations } from "./build-public-static-network-v2-observations.mjs";
import { parseSeoulRouteMapPositionsCsv } from "./collect-seoul-route-map-positions.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const ids = Object.freeze(["seoul-metro-route-map-positions", "molit-urban-rail-full-route"]);

async function input() {
  const [inventory, positionCsv, molitRawBytes] = await Promise.all([
    readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/fixtures/seoul-route-map-positions-raw/data-go-15099316.csv")),
    readFile(path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv")),
  ]);
  const publicSources = inventory.sources.filter(({ id }) => id === ids[0]);
  const publicSource = publicSources[0];
  const admission = publicSource?.routeMapAdmissionEvidence?.currentTopologyAdmission;
  if (publicSources.length !== 1 || publicSource.routeMapAdmissionEvidence?.topologySourceId !== "capital-route-topology"
    || !admission) {
    throw new Error("current public topology authority is not unique");
  }
  const topologyBytes = await readFile(path.join(root, `tools/datapack/sources/${admission.topologySnapshotId}.json`));
  const topology = JSON.parse(topologyBytes);
  const capturedAt = topology.capturedAt;
  if (topology.contentSha256 !== admission.topologyContentSha256
    || topology.capturedAt !== admission.reviewedAt || topology.freshUntil !== admission.freshUntil
    || topology.lines.length !== 22
    || topology.lines.reduce((count, line) => count + line.edgeCount, 0) !== 1_438) {
    throw new Error("current topology admission bytes are invalid");
  }
  const positionRows = parseSeoulRouteMapPositionsCsv(positionCsv).rawPositions.map(
    ({ line, stationCode, stationName, latitude, longitude, basisDate }, index) => ({
      "연번": `${index + 1}`, "호선": line, "고유역번호(외부역코드)": stationCode,
      "역명": stationName, "위도": `${latitude}`, "경도": `${longitude}`,
      "작성기준일": basisDate, "작성일자": basisDate,
    }),
  );
  const positionRawBytes = Buffer.from(JSON.stringify({
    currentCount: positionRows.length, data: positionRows, matchCount: positionRows.length,
    page: 1, perPage: 1000, totalCount: positionRows.length,
  }));
  const receipt = (sourceId, rawBytes, extension, contentType) => {
    const snapshotId = `${sourceId}-current-${capturedAt.replaceAll(/[-:.]/gu, "")}`;
    const rawSha256 = sha(rawBytes); const objectKey = `source-raw/${sourceId}/20260825/${rawSha256}.${extension}`;
    return { schemaVersion: 1, artifactKind: "static-network-source-raw-object-receipt", sourceId, snapshotId, capturedAt,
      rawObjectSha256: rawSha256, rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/${objectKey}`,
      ociNamespace: "axvym6vk8g7i", bucket: "easysubway-datapacks", objectKey, contentType, byteSize: rawBytes.length,
      storedAt: capturedAt, rawRetentionExpiresAt: "2026-11-23T00:00:00.000Z" };
  };
  return {
    positionRawBytes, molitRawBytes, capturedAt, admittedTopologyBytes: topologyBytes,
    admittedTopologyId: admission.topologySnapshotId, sourceInventory: inventory,
    positionReceipt: receipt(ids[0], positionRawBytes, "json", "application/json"),
    molitReceipt: receipt(ids[1], molitRawBytes, "csv", "text/csv; charset=euc-kr"),
  };
}

test("public static-network v2 producer emits byte-stable official observations and a current layout admission", async () => {
  const value = await input();
  const first = buildPublicStaticNetworkV2Observations(value);
  const second = buildPublicStaticNetworkV2Observations(structuredClone(value));
  assert.deepEqual(second, first);
  assert.deepEqual(first.observations.map(({ sourceId }) => sourceId), ids);
  assert.equal(first.observations[0].schemaVersion, 2);
  assert.equal(first.observations[0].rowCount, 276);
  assert.equal(Object.hasOwn(first.observations[0].routeMapLayoutArtifact, "legacyDiagnostic"), false);
  assert.equal(first.observations[1].rowCount, 1103);
  assert.equal(first.observations[1].schemaFingerprint,
    sha(JSON.stringify(["region_code", "region_name", "operator_name", "line_name", "station_sequence", "station_name"])));
  assert.deepEqual(Object.keys(first.observations[1].normalizedProjection[0]),
    ["region_code", "region_name", "operator_name", "line_name", "station_sequence", "station_name"]);
  assert.equal("projectionMigration" in first.observations[0], false);
  assert.equal("projectionMigration" in first.observations[1], false);
  assert.deepEqual(first.observations[0].rawReceipt, value.positionReceipt);
  assert.deepEqual(first.observations[1].rawReceipt, value.molitReceipt);
  assert.notEqual(first.observations[0].rawReceipt, value.positionReceipt);
  value.positionReceipt.byteSize = 0;
  assert.notEqual(first.observations[0].rawReceipt.byteSize, value.positionReceipt.byteSize);
  assert.equal(first.currentLayoutAdmission.schemaVersion, 2);
  assert.equal(first.currentLayoutAdmission.status, "ADMITTED");
  assert.equal(first.currentLayoutAdmission.positionSnapshotId, first.observations[0].snapshotId);
  assert.equal(first.currentLayoutAdmission.snapshotSha256,
    sha(Buffer.from(`${JSON.stringify(first.observations[0])}\n`)));
  assert.equal(first.currentLayoutAdmission.layoutAlgorithmVersion, "seoul-public-latlon-line-order-layout-v2");
  assert.deepEqual(Object.keys(first.currentLayoutAdmission).sort(), [
    "aliasLedgerSha256", "aliasLedgerVersion", "artifactKind", "contentSha256", "layoutAlgorithmVersion",
    "layoutArtifactSha256", "layoutPositionsSha256", "layoutTracksSha256", "lineOrderSha256",
    "outputSchemaSha256", "positionSnapshotId", "rawPositionsSha256", "rawSha256", "schemaVersion",
    "semanticInputSha256", "semanticOutputSha256", "snapshotPath", "snapshotSha256", "status",
    "topologySnapshotId", "topologySnapshotIdentity", "topologySnapshotSha256",
  ]);
});

test("public static-network v2 producer fails closed for raw, receipt, topology, scope, schema, and selected-path drift", async () => {
  const base = await input();
  const cases = [
    ["receipt", (value) => { value.positionReceipt.byteSize -= 1; }, /V2_RECEIPT/],
    ["receipt URI", (value) => { value.molitReceipt.rawObjectUri = "s3://wrong/raw.csv"; }, /V2_RECEIPT/],
    ["receipt retained", (value) => { value.molitReceipt.rawRetentionExpiresAt = value.capturedAt; }, /V2_RECEIPT/],
    ["truncated MOLIT", (value) => { value.molitRawBytes = value.molitRawBytes.subarray(0, value.molitRawBytes.length - 100); }, /STATIC_NETWORK_SUCCESSOR_MOLIT_(?:SCHEMA|SCOPE)/],
    ["legacy five-row MOLIT", (value) => { const lines = Buffer.from(value.molitRawBytes).toString("binary").split("\n"); value.molitRawBytes = Buffer.from(`${lines.slice(0, 6).join("\n")}\n`, "binary"); }, /STATIC_NETWORK_SUCCESSOR_MOLIT_SCOPE/],
    ["position membership", (value) => { const raw = JSON.parse(Buffer.from(value.positionRawBytes)); raw.data.pop(); raw.currentCount -= 1; raw.matchCount -= 1; raw.totalCount -= 1; value.positionRawBytes = Buffer.from(JSON.stringify(raw)); }, /STATIC_NETWORK_SUCCESSOR_SEOUL_POSITIONS_SCOPE/],
    ["topology id", (value) => { value.admittedTopologyId = "wrong"; }, /V2_TOPOLOGY/],
    ["topology bytes", (value) => { value.admittedTopologyBytes = Buffer.from("{}"); }, /V2_TOPOLOGY/],
    ["current topology binding", (value) => { value.sourceInventory.sources.find(({ id }) => id === ids[0]).routeMapAdmissionEvidence.currentTopologyAdmission.topologyContentSha256 = "0".repeat(64); }, /V2_TOPOLOGY/],
    ["current topology admission clock", (value) => { value.sourceInventory.sources.find(({ id }) => id === ids[0]).routeMapAdmissionEvidence.currentTopologyAdmission.reviewedAt = "2026-08-24T00:00:00.000Z"; }, /V2_TOPOLOGY/],
    ["malformed topology admission clock", (value) => { const topology = JSON.parse(Buffer.from(value.admittedTopologyBytes).toString("utf8")); topology.capturedAt = "not-a-timestamp"; value.admittedTopologyBytes = Buffer.from(JSON.stringify(topology)); value.sourceInventory.sources.find(({ id }) => id === ids[0]).routeMapAdmissionEvidence.currentTopologyAdmission.reviewedAt = topology.capturedAt; }, /V2_TOPOLOGY/],
    ["future observation clock", (value) => { value.capturedAt = value.sourceInventory.sources.find(({ id }) => id === ids[0]).routeMapAdmissionEvidence.currentTopologyAdmission.freshUntil; }, /V2_TOPOLOGY/],
    ["stale observation clock", (value) => { value.capturedAt = "2026-08-25T00:00:00.000Z"; }, /V2_TOPOLOGY/],
    ["duplicate topology lineage", (value) => { const admission = value.sourceInventory.sources.find(({ id }) => id === ids[0]).routeMapAdmissionEvidence.currentTopologyAdmission; admission.topologyLineages.push({ ...admission.topologyLineages[0] }); }, /V2_TOPOLOGY/],
    ["out-of-scope topology lineage", (value) => { value.sourceInventory.sources.find(({ id }) => id === ids[0]).routeMapAdmissionEvidence.currentTopologyAdmission.topologyLineages[0].lineId = "line-42b5805f3b5a"; }, /V2_TOPOLOGY/],
    ["selected Cyber path", (value) => { value.sourceInventory.sources.find(({ id }) => id === ids[0]).selectedProvider = "cyberstation.js"; }, /V2_SELECTED_PATH/],
    ["selected S3 path", (value) => { value.sourceInventory.sources.find(({ id }) => id === ids[1]).currentReceiptUri = "s3://wrong/raw.csv"; }, /V2_SELECTED_PATH/],
  ];
  for (const [name, mutate, expected] of cases) {
    const value = structuredClone(base); mutate(value);
    assert.throws(() => buildPublicStaticNetworkV2Observations(value), expected, name);
  }
});

test("public static-network v2 producer binds supplied branch order into a fresh deterministic layout identity", async () => {
  const baseline = buildPublicStaticNetworkV2Observations(await input());
  const value = await input();
  const topology = JSON.parse(value.admittedTopologyBytes);
  topology.lines.find(({ lineId }) => lineId === "seoul-2").branchSequences[0].stationNames.reverse();
  value.admittedTopologyBytes = Buffer.from(JSON.stringify(topology));
  const first = buildPublicStaticNetworkV2Observations(value);
  const second = buildPublicStaticNetworkV2Observations(structuredClone(value));
  assert.deepEqual(second, first);
  assert.notEqual(first.observations[0].routeMapLayoutEvidence.lineOrderSha256,
    baseline.observations[0].routeMapLayoutEvidence.lineOrderSha256);
  assert.notEqual(first.observations[0].routeMapLayoutEvidence.semanticInputSha256,
    baseline.observations[0].routeMapLayoutEvidence.semanticInputSha256);
  assert.notEqual(first.observations[0].routeMapLayoutEvidence.layoutArtifactSha256,
    baseline.observations[0].routeMapLayoutEvidence.layoutArtifactSha256);
  assert.notEqual(first.currentLayoutAdmission.snapshotSha256,
    baseline.currentLayoutAdmission.snapshotSha256);
  assert.notEqual(first.currentLayoutAdmission.topologySnapshotSha256,
    baseline.currentLayoutAdmission.topologySnapshotSha256);
});

test("public static-network v2 producer rejects historical predecessor audit input", async () => {
  const value = await input();
  value.sourceInventory.sources.find(({ id }) => id === ids[0]).historicalPredecessorAudit = {
    archivedSourceId: "seoulmetro-cyberstation-route-map", archivedParser: "line-data.js", archivedUri: "s3://not-selected/archive",
  };
  assert.throws(() => buildPublicStaticNetworkV2Observations(value), /V2_HISTORICAL_PREDECESSOR/);
});

test("public static-network v2 producer rejects v1 and five-record migration input", async () => {
  const cases = [
    [ids[0], "projectionMigration", { migrationKind: "CROSS_SOURCE_CANONICAL_REPLACEMENT" }],
    [ids[1], "migration", { migrationKind: "LEGACY_SAMPLE_TO_FULL_CONSUMED_FIELDS" }],
  ];
  for (const [sourceId, key, migration] of cases) {
    const value = await input();
    value.sourceInventory.sources.find(({ id }) => id === sourceId)[key] = migration;
    assert.throws(() => buildPublicStaticNetworkV2Observations(value), /V2_HISTORICAL_PREDECESSOR/);
  }
});
