import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCurrentStaticNetworkSuccessors, runPublicStaticNetworkV2Transition } from "./run-current-static-network-successors.mjs";
import { projectPositions } from "./collect-current-static-network-successors.mjs";
import { parseSeoulRouteMapPositionsCsv } from "./collect-seoul-route-map-positions.mjs";
import { deriveRawRetentionExpiresAt } from "./source-governance-policy.mjs";
import { currentTopologyAdmissionClock } from "./test-fixtures/current-topology-admission-clock.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const currentTopologyClock = await currentTopologyAdmissionClock(repositoryRoot);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const molitBaseline = await readFile(path.join(repositoryRoot, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv"));
const molitRaw = molitBaseline;
const molitRecords = new TextDecoder("euc-kr").decode(molitRaw).trim().split(/\r?\n/u).slice(1).map((row) => {
  const [region_code, region_name, operator_name, line_name, station_sequence, station_name] = row.split(",").map((value) => value.trim());
  return { region_code, region_name, operator_name, line_name, station_sequence: Number(station_sequence), station_name };
});
const positionCsv = await readFile(path.join(repositoryRoot, "tools/datapack/fixtures/seoul-route-map-positions-raw/data-go-15099316.csv"));
const positionProviderFields = ["연번", "호선", "고유역번호(외부역코드)", "역명", "위도", "경도", "작성기준일", "작성일자"];
const positionProviderSchemaFingerprint = sha(JSON.stringify([...positionProviderFields].sort()));
const positionRows = parseSeoulRouteMapPositionsCsv(positionCsv).rawPositions.map(({ line, stationCode, stationName, latitude, longitude, basisDate }, index) => ({ "연번": `${index + 1}`, "호선": line, "고유역번호(외부역코드)": stationCode, "역명": stationName, "위도": `${latitude}`, "경도": `${longitude}`, "작성기준일": basisDate, "작성일자": basisDate }));
const positionsRaw = Buffer.from(JSON.stringify({ currentCount: positionRows.length, data: positionRows, matchCount: positionRows.length, page: 1, perPage: 1000, totalCount: positionRows.length }));
const positionRecords = projectPositions(positionsRaw, "2026-08-22T12:00:00.000Z");

async function validCollection({ sourceSnapshots, observedAt }) {
  const routePrevious = sourceSnapshots.filter(({ sourceId }) => sourceId === "seoulmetro-cyberstation-route-map").find((row) => !sourceSnapshots.some(({ previousSnapshotId }) => previousSnapshotId === row.snapshotId));
  const molitPrevious = sourceSnapshots.filter(({ sourceId }) => sourceId === "molit-urban-rail-full-route").find((row) => !sourceSnapshots.some(({ previousSnapshotId }) => previousSnapshotId === row.snapshotId));
  const molitId = `molit-urban-rail-full-route-current-${observedAt.replaceAll(/[-:.]/gu, "").replace("Z", "Z")}`;
  const molitProjection = Buffer.from(`${JSON.stringify(molitRecords)}\n`);
  const molitMigration = { schemaVersion: 1, artifactKind: "source-projection-migration-evidence", migrationKind: "LEGACY_SAMPLE_TO_FULL_CONSUMED_FIELDS", sourceId: molitPrevious.sourceId, legacySnapshotId: molitPrevious.snapshotId, legacyRawSha256: molitPrevious.rawSha256, legacySchemaFingerprint: molitPrevious.schemaFingerprint, legacyProviderRecordHashes: molitPrevious.providerRecordHashes, fullProjectionSha256: sha(molitProjection), fullProjectionSchemaFingerprint: sha(JSON.stringify(["region_code", "region_name", "operator_name", "line_name", "station_sequence", "station_name"])), fullProjectionRowCount: molitRecords.length, newSnapshotId: molitId };
  return { observedAt, positions: { sourceId: "seoul-metro-route-map-positions", rawBytes: positionsRaw, rawSha256: sha(positionsRaw), providerSchemaFingerprint: positionProviderSchemaFingerprint, records: positionRecords, replaced: routePrevious, replacement: { schemaVersion: 1, artifactKind: "source-projection-migration-evidence", migrationKind: "CROSS_SOURCE_CANONICAL_REPLACEMENT", sourceId: "seoul-metro-route-map-positions", replacedSourceId: routePrevious.sourceId, replacedSnapshotId: routePrevious.snapshotId, replacedRawSha256: routePrevious.rawSha256, replacedSchemaFingerprint: routePrevious.schemaFingerprint, candidateSlotSourceId: routePrevious.sourceId } }, molit: { sourceId: molitPrevious.sourceId, rawBytes: molitRaw, rawSha256: sha(molitRaw), records: molitRecords, previous: molitPrevious, migration: molitMigration } };
}

async function receiptFor(input, operationRoot, now) {
  const extension = input.sourceId === "seoul-metro-route-map-positions" ? "json" : "csv";
  const contentType = extension === "json" ? "application/json" : "text/csv; charset=euc-kr";
  const rawBytes = await readFile(path.join(operationRoot, `raw.${extension}`));
  const rawSha256 = sha(rawBytes); const date = input.capturedAt.slice(0, 10).replaceAll("-", "");
  const objectKey = `source-raw/${input.sourceId}/${date}/${rawSha256}.${extension}`;
  const policy = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/source-governance-policy.json"), "utf8"));
  return { schemaVersion: 1, artifactKind: "static-network-source-raw-object-receipt", sourceId: input.sourceId, snapshotId: input.snapshotId,
    capturedAt: input.capturedAt, rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/${objectKey}`, rawObjectSha256: rawSha256,
    byteSize: rawBytes.length, storedAt: now.toISOString(), rawRetentionExpiresAt: deriveRawRetentionExpiresAt({ policy, sourceId: input.sourceId, retrievedAt: input.capturedAt }),
    ociNamespace: "axvym6vk8g7i", bucket: "easysubway-datapacks", objectKey, contentType };
}

test("runner validates both official observations before the first immutable publication", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-network-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let publishes = 0;
  let registers = 0;
  await assert.rejects(runCurrentStaticNetworkSuccessors({
    repositoryRoot: path.resolve(import.meta.dirname, "../.."), operationRoot: root,
    assertExactMain: async () => {},
    collectImpl: async () => { throw new Error("STATIC_NETWORK_SUCCESSOR_MATERIAL_CHANGE"); },
    publishImpl: async () => { publishes += 1; },
    registerImpl: async () => { registers += 1; },
  }), /STATIC_NETWORK_SUCCESSOR_MATERIAL_CHANGE/);
  assert.equal(publishes, 0);
  assert.equal(registers, 0);
});

test("v2 transition is input-only, builds once, exact-main fences registration, and registers once", async () => {
  const calls = []; const positionRawBytes = Buffer.from("position"); const molitRawBytes = Buffer.from("molit");
  const result = await runPublicStaticNetworkV2Transition({ repositoryRoot, positionRawBytes, molitRawBytes, positionReceipt: { receipt: "position" }, molitReceipt: { receipt: "molit" }, capturedAt: "2026-08-25T00:00:00.000Z",
    assertExactMain: async () => { calls.push("main"); return "a".repeat(40); },
    produceImpl: (input) => { calls.push(input); return { output: true }; },
    registerImpl: async (input) => { calls.push(input); return { outputs: ["ok"] }; },
  });
  assert.deepEqual(result, { outputs: ["ok"] }); assert.equal(calls.filter((value) => value === "main").length, 2);
  assert.equal(calls[1].positionRawBytes, positionRawBytes); assert.equal(calls[1].molitRawBytes, molitRawBytes);
  assert.deepEqual(calls[3].rawBytesBySource, { "seoul-metro-route-map-positions": positionRawBytes, "molit-urban-rail-full-route": molitRawBytes });
});

test("runner stages publisher-contract raw.json/raw.csv, publishes exactly two bound receipts, then registers once", async (t) => {
  const operationRoot = await mkdtemp(path.join(os.tmpdir(), "static-network-runner-success-"));
  t.after(() => rm(operationRoot, { recursive: true, force: true }));
  const calls = []; let registered;
  const now = currentTopologyClock.inWindow;
  await runCurrentStaticNetworkSuccessors({ repositoryRoot, operationRoot, now, assertExactMain: async () => "0".repeat(40), collectImpl: validCollection,
    publishImpl: async (input) => { calls.push(input); return receiptFor(input, operationRoot, now); },
    registerImpl: async (input) => { registered = input; return { outputs: [] }; },
  });
  assert.deepEqual(calls.map(({ sourceId, rawRelativePath }) => [sourceId, rawRelativePath]), [["seoul-metro-route-map-positions", "raw.json"], ["molit-urban-rail-full-route", "raw.csv"]]);
  assert.equal(calls.length, 2); assert.equal(registered.observations.length, 2);
  for (const { snapshot } of registered.observations) assert.equal(snapshot.providerRecordHashes.length, snapshot.rowCount);
  assert.equal(registered.observations[0].snapshot.previousSnapshotId, null);
  assert.equal(registered.observations[0].snapshot.schemaFingerprint, positionProviderSchemaFingerprint);
  assert.equal(registered.observations[0].snapshot.projectionMigration.migrationKind, "CROSS_SOURCE_CANONICAL_REPLACEMENT");
  assert.deepEqual(registered.observations.map(({ rawBytes }) => rawBytes.length), [positionsRaw.length, molitRaw.length]);
});

test("runner rejects an expired topology admission before the first immutable publication", async (t) => {
  const operationRoot = await mkdtemp(path.join(os.tmpdir(), "static-network-runner-expired-topology-"));
  t.after(() => rm(operationRoot, { recursive: true, force: true }));
  let publishes = 0;
  await assert.rejects(runCurrentStaticNetworkSuccessors({
    repositoryRoot, operationRoot, now: currentTopologyClock.expiredAt,
    assertExactMain: async () => "0".repeat(40), collectImpl: validCollection,
    publishImpl: async () => { publishes += 1; }, registerImpl: async () => {},
  }), /topology admission snapshot is stale or future-dated/);
  assert.equal(publishes, 0);
});

test("runner rejects an invalid second observation before the first publication", async (t) => {
  const operationRoot = await mkdtemp(path.join(os.tmpdir(), "static-network-runner-invalid-"));
  t.after(() => rm(operationRoot, { recursive: true, force: true }));
  let publishes = 0;
  await assert.rejects(runCurrentStaticNetworkSuccessors({ repositoryRoot, operationRoot, now: currentTopologyClock.inWindow, assertExactMain: async () => "0".repeat(40), collectImpl: async (input) => { const value = await validCollection(input); value.molit.rawSha256 = "0".repeat(64); return value; }, publishImpl: async () => { publishes += 1; }, registerImpl: async () => {} }), /MOLIT projection identity/);
  assert.equal(publishes, 0);
});

test("runner rejects an unbound provider schema before the first publication", async (t) => {
  const operationRoot = await mkdtemp(path.join(os.tmpdir(), "static-network-runner-provider-schema-"));
  t.after(() => rm(operationRoot, { recursive: true, force: true }));
  let publishes = 0;
  await assert.rejects(runCurrentStaticNetworkSuccessors({ repositoryRoot, operationRoot, now: currentTopologyClock.inWindow, assertExactMain: async () => "0".repeat(40), collectImpl: async (input) => { const value = await validCollection(input); value.positions.providerSchemaFingerprint = "0".repeat(64); return value; }, publishImpl: async () => { publishes += 1; }, registerImpl: async () => {} }), /public replacement identity/);
  assert.equal(publishes, 0);
});

test("runner does not register when the second immutable publication fails", async (t) => {
  const operationRoot = await mkdtemp(path.join(os.tmpdir(), "static-network-runner-publish-failure-"));
  t.after(() => rm(operationRoot, { recursive: true, force: true }));
  let publishes = 0; let registrations = 0;
  const now = currentTopologyClock.inWindow;
  await assert.rejects(runCurrentStaticNetworkSuccessors({ repositoryRoot, operationRoot, now, assertExactMain: async () => "0".repeat(40), collectImpl: validCollection, publishImpl: async (input) => { publishes += 1; if (publishes === 2) throw new Error("second publish failed"); return receiptFor(input, operationRoot, now); }, registerImpl: async () => { registrations += 1; } }), /second publish failed/);
  assert.equal(publishes, 2); assert.equal(registrations, 0);
});

test("runner rejects an operation-root symlink even when its resolved target is inside the repository", async (t) => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "static-network-operation-link-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const link = path.join(outside, "repository");
  await symlink(repositoryRoot, link);
  let collected = 0;
  await assert.rejects(runCurrentStaticNetworkSuccessors({ repositoryRoot, operationRoot: path.join(link, "tools", "datapack"), assertExactMain: async () => "0".repeat(40), collectImpl: async () => { collected += 1; }, publishImpl: async () => {}, registerImpl: async () => {} }), /operation root must be outside the repository/);
  assert.equal(collected, 0);
});
