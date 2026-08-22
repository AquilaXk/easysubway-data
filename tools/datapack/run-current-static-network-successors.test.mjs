import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCurrentStaticNetworkSuccessors } from "./run-current-static-network-successors.mjs";
import { buildLegacySampleToFullConsumedFieldsMigration } from "./lib/seoulmetro-line-data-parser.mjs";
import { deriveRawRetentionExpiresAt } from "./source-governance-policy.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const molitBaseline = await readFile(path.join(repositoryRoot, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv"));
const molitRecords = new TextDecoder("euc-kr").decode(molitBaseline).trim().split(/\r?\n/u).slice(1).map((row) => {
  const [region_code, region_name, operator_name, line_name, station_sequence, station_name] = row.split(",").map((value) => value.trim());
  return { region_code, region_name, operator_name, line_name, station_sequence, station_name };
});

async function validCollection({ sourceSnapshots, baselineRouteMapBytes, observedAt }) {
  const routePrevious = sourceSnapshots.filter(({ sourceId }) => sourceId === "seoulmetro-cyberstation-route-map").find((row) => !sourceSnapshots.some(({ previousSnapshotId }) => previousSnapshotId === row.snapshotId));
  const molitPrevious = sourceSnapshots.filter(({ sourceId }) => sourceId === "molit-urban-rail-full-route").find((row) => !sourceSnapshots.some(({ previousSnapshotId }) => previousSnapshotId === row.snapshotId));
  const routeId = `seoulmetro-cyberstation-route-map-current-${observedAt.replaceAll(/[-:.]/gu, "").replace("Z", "Z")}`;
  const molitId = `molit-urban-rail-full-route-current-${observedAt.replaceAll(/[-:.]/gu, "").replace("Z", "Z")}`;
  const molitProjection = Buffer.from(`${JSON.stringify(molitRecords)}\n`);
  const molitMigration = { schemaVersion: 1, artifactKind: "source-projection-migration-evidence", migrationKind: "LEGACY_SAMPLE_TO_FULL_CONSUMED_FIELDS", sourceId: molitPrevious.sourceId, legacySnapshotId: molitPrevious.snapshotId, legacyRawSha256: molitPrevious.rawSha256, legacySchemaFingerprint: molitPrevious.schemaFingerprint, legacyProviderRecordHashes: molitPrevious.providerRecordHashes, retainedBaselineRawSha256: sha(molitBaseline), fullProjectionSha256: sha(molitProjection), fullProjectionSchemaFingerprint: sha(JSON.stringify(["region_code", "region_name", "operator_name", "line_name", "station_sequence", "station_name"])), fullProjectionRowCount: molitRecords.length, newSnapshotId: molitId };
  return { observedAt, routeMap: { sourceId: routePrevious.sourceId, rawBytes: baselineRouteMapBytes, rawSha256: sha(baselineRouteMapBytes), previous: routePrevious, migration: buildLegacySampleToFullConsumedFieldsMigration({ legacyHead: routePrevious, baselineRawBytes: baselineRouteMapBytes, freshRawBytes: baselineRouteMapBytes, snapshotId: routeId }) }, molit: { sourceId: molitPrevious.sourceId, rawBytes: Buffer.from("molit-current"), rawSha256: sha(Buffer.from("molit-current")), records: molitRecords, previous: molitPrevious, migration: molitMigration } };
}

async function receiptFor(input, operationRoot, now) {
  const extension = input.sourceId === "seoulmetro-cyberstation-route-map" ? "js" : "csv";
  const contentType = extension === "js" ? "application/javascript" : "text/csv; charset=euc-kr";
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

test("runner stages publisher-contract raw.js/raw.csv, publishes exactly two bound receipts, then registers once", async (t) => {
  const operationRoot = await mkdtemp(path.join(os.tmpdir(), "static-network-runner-success-"));
  t.after(() => rm(operationRoot, { recursive: true, force: true }));
  const calls = []; let registered;
  const now = new Date("2026-08-22T12:00:00.000Z");
  await runCurrentStaticNetworkSuccessors({ repositoryRoot, operationRoot, now, assertExactMain: async () => "0".repeat(40), collectImpl: validCollection,
    publishImpl: async (input) => { calls.push(input); return receiptFor(input, operationRoot, now); },
    registerImpl: async (input) => { registered = input; return { outputs: [] }; },
  });
  assert.deepEqual(calls.map(({ sourceId, rawRelativePath }) => [sourceId, rawRelativePath]), [["seoulmetro-cyberstation-route-map", "raw.js"], ["molit-urban-rail-full-route", "raw.csv"]]);
  assert.equal(calls.length, 2); assert.equal(registered.observations.length, 2);
  for (const { snapshot } of registered.observations) assert.equal(snapshot.providerRecordHashes.length, snapshot.rowCount);
  assert.notDeepEqual(registered.observations[0].snapshot.providerRecordHashes, registered.observations[0].snapshot.projectionMigration.legacyProviderRecordHashes);
});

test("runner rejects an invalid second observation before the first publication", async (t) => {
  const operationRoot = await mkdtemp(path.join(os.tmpdir(), "static-network-runner-invalid-"));
  t.after(() => rm(operationRoot, { recursive: true, force: true }));
  let publishes = 0;
  await assert.rejects(runCurrentStaticNetworkSuccessors({ repositoryRoot, operationRoot, now: new Date("2026-08-22T12:00:00.000Z"), assertExactMain: async () => "0".repeat(40), collectImpl: async (input) => { const value = await validCollection(input); value.molit.rawSha256 = "0".repeat(64); return value; }, publishImpl: async () => { publishes += 1; }, registerImpl: async () => {} }), /MOLIT projection identity/);
  assert.equal(publishes, 0);
});

test("runner does not register when the second immutable publication fails", async (t) => {
  const operationRoot = await mkdtemp(path.join(os.tmpdir(), "static-network-runner-publish-failure-"));
  t.after(() => rm(operationRoot, { recursive: true, force: true }));
  let publishes = 0; let registrations = 0;
  const now = new Date("2026-08-22T12:00:00.000Z");
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
