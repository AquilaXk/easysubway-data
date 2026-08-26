import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runPublicStaticNetworkV2Operation } from "./run-public-static-network-v2-operation.mjs";
import { parseSeoulRouteMapPositionsCsv } from "./collect-seoul-route-map-positions.mjs";
import { currentTopologyAdmissionClock } from "./test-fixtures/current-topology-admission-clock.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const { inWindow: now } = await currentTopologyAdmissionClock(root);
const sourceInventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json")));
const staticTopologyAdmission = sourceInventory.sources
  .find(({ id }) => id === "seoul-metro-route-map-positions")
  .routeMapAdmissionEvidence.currentTopologyAdmission;
const staticTopologyExpiredAt = new Date(staticTopologyAdmission.freshUntil);
const staticTopologyFutureAt = new Date(Date.parse(staticTopologyAdmission.reviewedAt) - 1);
const env = { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "oci-par-fixture" };
const positionCsv = await readFile(path.join(root, "tools/datapack/fixtures/seoul-route-map-positions-raw/data-go-15099316.csv"));
const rows = parseSeoulRouteMapPositionsCsv(positionCsv).rawPositions.map(({ line, stationCode, stationName, latitude, longitude, basisDate }, index) => ({
  "연번": `${index + 1}`, "호선": line, "고유역번호(외부역코드)": stationCode, "역명": stationName,
  "위도": `${latitude}`, "경도": `${longitude}`, "작성기준일": basisDate, "작성일자": basisDate,
}));
const raw = {
  positionRawBytes: Buffer.from(JSON.stringify({ currentCount: rows.length, data: rows, matchCount: rows.length, page: 1, perPage: 1000, totalCount: rows.length })),
  molitRawBytes: await readFile(path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv")),
  capturedAt: now.toISOString(),
};

async function preflightRepository(mutateInventory = (inventory) => inventory) {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "public-static-v2-topology-"));
  const inventoryBytes = await readFile(path.join(root, "tools/datapack/source-inventory.json"));
  const inventory = mutateInventory(JSON.parse(inventoryBytes));
  const topologySnapshotId = inventory.sources.find(({ id }) => id === "seoul-metro-route-map-positions")
    .routeMapAdmissionEvidence.currentTopologyAdmission.topologySnapshotId;
  const topologyRelativePath = path.join("tools", "datapack", "sources", `${topologySnapshotId}.json`);
  const topologyBytes = await readFile(path.join(root, topologyRelativePath));
  await mkdir(path.dirname(path.join(repositoryRoot, topologyRelativePath)), { recursive: true });
  await Promise.all([
    writeFile(path.join(repositoryRoot, "tools/datapack/source-inventory.json"), `${JSON.stringify(inventory)}\n`),
    writeFile(path.join(repositoryRoot, topologyRelativePath), topologyBytes),
  ]);
  return repositoryRoot;
}

test("one-shot v2 operation validates both raws before exactly two OCI publications and one transition", async (t) => {
  const operationRoot = await mkdtemp(path.join(os.tmpdir(), "public-static-v2-operation-"));
  t.after(() => rm(operationRoot, { recursive: true, force: true }));
  const published = []; const transitions = [];
  const result = await runPublicStaticNetworkV2Operation({
    repositoryRoot: root, operationRoot, now, env, serviceKey: "test-key",
    assertExactMain: async () => "a".repeat(40), collectImpl: async () => raw,
    publishImpl: async (input) => { published.push(input); return { sourceId: input.sourceId, snapshotId: input.snapshotId, capturedAt: input.capturedAt }; },
    transitionImpl: async (input) => { transitions.push(input); return { outputs: Array(5).fill("output") }; },
  });
  assert.deepEqual(result, { outputs: Array(5).fill("output") });
  assert.deepEqual(published.map(({ sourceId, rawRelativePath }) => [sourceId, rawRelativePath]), [
    ["seoul-metro-route-map-positions", "positions.raw.json"], ["molit-urban-rail-full-route", "molit.raw.csv"],
  ]);
  assert.equal(transitions.length, 1);
  assert.deepEqual(transitions[0].positionRawBytes, raw.positionRawBytes);
  assert.deepEqual(transitions[0].molitRawBytes, raw.molitRawBytes);
  assert.deepEqual(await readFile(path.join(operationRoot, "positions.raw.json")), raw.positionRawBytes);
  assert.deepEqual(await readFile(path.join(operationRoot, "molit.raw.csv")), raw.molitRawBytes);
});

test("one-shot v2 operation never publishes after collection or raw validation failure", async (t) => {
  const operationRoot = await mkdtemp(path.join(os.tmpdir(), "public-static-v2-operation-fail-"));
  t.after(() => rm(operationRoot, { recursive: true, force: true }));
  let publications = 0; let transitions = 0;
  await assert.rejects(runPublicStaticNetworkV2Operation({
    repositoryRoot: root, operationRoot, now, env, serviceKey: "test-key", assertExactMain: async () => "a".repeat(40),
    collectImpl: async () => ({ ...raw, molitRawBytes: Buffer.from("invalid") }),
    publishImpl: async () => { publications += 1; }, transitionImpl: async () => { transitions += 1; },
  }), /PUBLIC_STATIC_NETWORK_V2_MOLIT_SCHEMA/);
  assert.equal(publications, 0); assert.equal(transitions, 0);
});

test("one-shot v2 operation rejects stale, future-dated, or mismatched topology before collection, publication, or transition", async (t) => {
  const mismatchedRoot = await preflightRepository((inventory) => {
    inventory.sources.find(({ id }) => id === "seoul-metro-route-map-positions")
      .routeMapAdmissionEvidence.currentTopologyAdmission.topologyContentSha256 = "0".repeat(64);
    return inventory;
  });
  t.after(() => rm(mismatchedRoot, { recursive: true, force: true }));
  for (const { repositoryRoot, at, expected } of [
    { repositoryRoot: root, at: staticTopologyExpiredAt, expected: /topology admission snapshot is stale or future-dated/ },
    { repositoryRoot: root, at: staticTopologyFutureAt, expected: /topology admission snapshot is stale or future-dated/ },
    { repositoryRoot: mismatchedRoot, at: now, expected: /static network topology identity is invalid/ },
  ]) {
    const operationRoot = await mkdtemp(path.join(os.tmpdir(), "public-static-v2-topology-operation-"));
    t.after(() => rm(operationRoot, { recursive: true, force: true }));
    let collections = 0; let publications = 0; let transitions = 0;
    await assert.rejects(runPublicStaticNetworkV2Operation({
      repositoryRoot, operationRoot, now: at, env, serviceKey: "test-key", assertExactMain: async () => "a".repeat(40),
      collectImpl: async () => { collections += 1; return raw; },
      publishImpl: async () => { publications += 1; }, transitionImpl: async () => { transitions += 1; },
    }), expected);
    assert.equal(collections, 0); assert.equal(publications, 0); assert.equal(transitions, 0);
  }
});

test("one-shot v2 operation stops before transition when main changes after both publications", async (t) => {
  const operationRoot = await mkdtemp(path.join(os.tmpdir(), "public-static-v2-operation-main-drift-"));
  t.after(() => rm(operationRoot, { recursive: true, force: true }));
  let mainChecks = 0; let publications = 0; let transitions = 0;
  await assert.rejects(runPublicStaticNetworkV2Operation({
    repositoryRoot: root, operationRoot, now, env, serviceKey: "test-key",
    assertExactMain: async () => (mainChecks += 1) === 1 ? "a".repeat(40) : "b".repeat(40),
    collectImpl: async () => raw,
    publishImpl: async () => { publications += 1; return { published: publications }; },
    transitionImpl: async () => { transitions += 1; },
  }), /PUBLIC_STATIC_NETWORK_V2_REPOSITORY_CHANGED/);
  assert.equal(publications, 2); assert.equal(transitions, 0); assert.equal(mainChecks, 2);
});

test("one-shot v2 operation rejects malformed DATA_GO_KR_SERVICE_KEY before collection", async (t) => {
  const operationRoot = await mkdtemp(path.join(os.tmpdir(), "public-static-v2-operation-key-"));
  t.after(() => rm(operationRoot, { recursive: true, force: true }));
  let calls = 0;
  await assert.rejects(runPublicStaticNetworkV2Operation({
    repositoryRoot: root, operationRoot, now, env, serviceKey: "invalid%ZZ",
    collectImpl: async () => { calls += 1; },
  }), /PUBLIC_STATIC_NETWORK_V2_ARGUMENT/);
  assert.equal(calls, 0);
});
