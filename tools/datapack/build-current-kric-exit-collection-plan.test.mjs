import assert from "node:assert/strict";
import { constants } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as currentPlan from "./build-current-kric-exit-collection-plan.mjs";
import { canonicalKricExitPathCollectionPlanJson } from "./plan-kric-exit-path-collection.mjs";

const { buildCurrentKricExitCollectionPlan, main } = currentPlan;

const datapackRoot = fileURLToPath(new URL(".", import.meta.url));
const currentNow = new Date("2026-08-14T16:00:00.000Z");
const productionPaths = Object.freeze({
  canonicalPack: path.join(datapackRoot, "release/capital-production-canonical-pack.json"),
  coverageTargets: path.join(datapackRoot, "nationwide-coverage-targets.json"),
  providerCodeCatalog: path.join(datapackRoot, "sources/kric-provider-code-catalog-20260228.json"),
  routeRosters: path.join(datapackRoot, "sources/kric-nationwide-route-rosters-20260730T203926676Z.json"),
  sourceInventory: path.join(datapackRoot, "source-inventory.json"),
  incheonTopology: path.join(datapackRoot, "sources/incheon-transit-station-info-20260814.json"),
});

const buildPlan = (input, options = {}) => buildCurrentKricExitCollectionPlan(input, { now: currentNow, ...options });

test("current production 정본에서 exact EXIT collection plan을 결정적으로 만든다", async () => {
  const input = await readProductionBytes();
  const before = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, Buffer.from(value)]));

  const plan = buildPlan(input);
  const repeated = buildPlan(input);
  const pack = JSON.parse(input.canonicalPackBytes).packs[0];
  const targets = JSON.parse(input.coverageTargetsBytes);
  const activeLineIds = new Set(targets.activeLineScopes.map(({ lineId }) => lineId));
  const activeStationLines = pack.stationLines.filter(({ lineId }) => activeLineIds.has(lineId));
  const incheonLineIds = new Set(["line-42b5805f3b5a", "line-98718184f016"]);
  const retainedLocalRideEdges = pack.networkEdges.filter((edge) => (
    edge.edgeType === "RIDE" && edge.servicePattern === "LOCAL" && edge.serviceClass === "SUBWAY"
      && activeLineIds.has(edge.fromNodeId.split(":")[1])
      && !incheonLineIds.has(edge.fromNodeId.split(":")[1])
  ));
  const incheonTopology = JSON.parse(input.incheonTopologyBytes);

  assert.match(plan.candidate.candidateId, /^current-production-exit-[a-f0-9]{64}$/);
  assert.equal(plan.providerMappings.length, activeStationLines.length);
  assert.equal(plan.stationLineQueries.length, activeStationLines.length);
  assert.equal(plan.routeEdges.length, retainedLocalRideEdges.length + incheonTopology.edgeCount);
  assert.equal(plan.queryPlan.length, plan.routeEdges.length);
  assert.equal(plan.routeEdges.filter(({ lineId }) => incheonLineIds.has(lineId)).length, 116);
  for (const stationId of [
    "station-3359f701c87e", "station-62fe7e203078", "station-996efa447ecf", "station-b78008d08d1f",
  ]) {
    assert.equal(plan.routeEdges.some(({ fromStationId }) => fromStationId === stationId), true);
  }
  assert.ok(plan.stationLineQueries.every(({ queryIds }) => queryIds.length > 0));
  assert.equal(
    canonicalKricExitPathCollectionPlanJson(plan),
    canonicalKricExitPathCollectionPlanJson(repeated),
  );
  for (const [key, value] of Object.entries(input)) assert.deepEqual(value, before[key]);
});

test("capital Seoul Metro production selector는 canonical metadata와 실제 membership에서 213/420 scope를 만든다", async () => {
  const input = await readProductionBytes();
  const plan = buildPlan(input, { coverageSelector: "capital-seoul-metro-production" });
  const nationwide = buildPlan(input);

  assert.equal(nationwide.providerMappings.length, 1102);
  assert.equal(nationwide.queryPlan.length, 2134);
  assert.equal(plan.providerMappings.length, 213);
  assert.equal(plan.stationLineQueries.length, 213);
  assert.equal(new Set(plan.providerMappings.map(({ stationId }) => stationId)).size, 199);
  assert.equal(plan.queryPlan.length, 420);
  assert.deepEqual(Object.fromEntries([...new Map(plan.queryPlan.map(({ lineName }) => [lineName, 0])).keys()]
    .sort()
    .map((lineName) => [lineName, plan.queryPlan.filter((query) => query.lineName === lineName).length])), {
    "수도권 2호선": 102,
    "수도권 4호선": 100,
    "수도권 5호선": 110,
    "수도권 6호선": 78,
    "수도권 신분당": 30,
  });
  assert.equal(new Set(plan.providerMappings.map(({ stationId, lineId }) => `${stationId}\0${lineId}`)).size, 213);
  assert.ok(plan.routeEdges.every(({ fromStationId, toStationId, lineId }) => (
    plan.providerMappings.some((row) => row.stationId === fromStationId && row.lineId === lineId)
      && plan.providerMappings.some((row) => row.stationId === toStationId && row.lineId === lineId)
  )));

  const asymmetricTopology = JSON.parse(input.canonicalPackBytes);
  const [targetEdge] = plan.routeEdges;
  const selectedStationIds = plan.providerMappings
    .filter(({ lineId }) => lineId === targetEdge.lineId)
    .map(({ stationId }) => stationId);
  const alternateStationId = selectedStationIds.find((stationId) => (
    stationId !== targetEdge.fromStationId && stationId !== targetEdge.toStationId
      && !plan.routeEdges.some((edge) => (
        edge.lineId === targetEdge.lineId
          && edge.fromStationId === targetEdge.toStationId
          && edge.toStationId === stationId
      ))
  ));
  assert.ok(alternateStationId);
  const reverse = asymmetricTopology.packs[0].networkEdges.find((edge) => (
    edge.fromNodeId === `${targetEdge.toStationId}:${targetEdge.lineId}`
      && edge.toNodeId === `${targetEdge.fromStationId}:${targetEdge.lineId}`
  ));
  assert.ok(reverse);
  reverse.toNodeId = `${alternateStationId}:${targetEdge.lineId}`;
  const selectedLineIds = new Set(plan.providerMappings.map(({ lineId }) => lineId));
  const alteredSelectedEdges = asymmetricTopology.packs[0].networkEdges.filter((edge) => (
    edge.edgeType === "RIDE" && edge.servicePattern === "LOCAL" && edge.serviceClass === "SUBWAY"
      && selectedLineIds.has(edge.fromNodeId.split(":")[1])
  ));
  assert.equal(alteredSelectedEdges.length, 420);
  assert.ok(alteredSelectedEdges.every((edge) => {
    const [fromStationId, lineId] = edge.fromNodeId.split(":");
    const [toStationId, toLineId] = edge.toNodeId.split(":");
    return lineId === toLineId
      && plan.providerMappings.some((row) => row.stationId === fromStationId && row.lineId === lineId)
      && plan.providerMappings.some((row) => row.stationId === toStationId && row.lineId === lineId);
  }));
  assert.throws(
    () => buildPlan({ ...input, canonicalPackBytes: Buffer.from(JSON.stringify(asymmetricTopology)) }, {
      coverageSelector: "capital-seoul-metro-production",
    }),
    /capital Seoul Metro production route symmetry mismatch/,
  );

  const metadataDrift = JSON.parse(input.canonicalPackBytes);
  metadataDrift.packs[0].metadata.productionCoverageEvidence = "[]";
  assert.throws(
    () => buildPlan({ ...input, canonicalPackBytes: Buffer.from(JSON.stringify(metadataDrift)) }, {
      coverageSelector: "capital-seoul-metro-production",
    }),
    /capital Seoul Metro production coverage metadata mismatch/,
  );
  assert.throws(
    () => buildPlan(input, { coverageSelector: "wrong" }),
    /EXIT collection-plan coverage selector mismatch/,
  );
});

test("raw source identity는 candidate ID에 결속되고 provider scope drift는 거부한다", async () => {
  const input = await readProductionBytes();
  const baseline = buildPlan(input);
  const whitespaceOnly = {
    ...input,
    coverageTargetsBytes: Buffer.concat([input.coverageTargetsBytes, Buffer.from("\n")]),
  };
  const rebound = buildPlan(whitespaceOnly);
  assert.notEqual(rebound.candidate.candidateId, baseline.candidate.candidateId);

  const routeRosters = JSON.parse(input.routeRostersBytes);
  routeRosters.providerScopes[0].lnCd = "WRONG";
  assert.throws(
    () => buildPlan({
      ...input,
      routeRostersBytes: Buffer.from(JSON.stringify(routeRosters)),
    }),
    /provider scope set mismatch/,
  );

  const unexpectedScopeAndRoster = JSON.parse(input.routeRostersBytes);
  unexpectedScopeAndRoster.providerScopes.push({
    ...unexpectedScopeAndRoster.providerScopes[0],
    lineId: "unexpected-line",
    regionId: "unexpected-region",
    operatorId: "unexpected-operator",
    mreaWideCd: "99",
    lnCd: "EXTRA",
    railOprIsttCd: "EXTRA",
  });
  unexpectedScopeAndRoster.rosters.push({
    ...unexpectedScopeAndRoster.rosters[0],
    mreaWideCd: "99",
    lnCd: "EXTRA",
  });
  unexpectedScopeAndRoster.providerScopeCount += 1;
  unexpectedScopeAndRoster.requestCount += 1;
  assert.throws(
    () => buildPlan({
      ...input,
      routeRostersBytes: Buffer.from(JSON.stringify(unexpectedScopeAndRoster)),
    }),
    /provider scope set mismatch/,
  );

  const targets = JSON.parse(input.coverageTargetsBytes);
  targets.inactiveLineExclusions = [];
  assert.throws(
    () => buildPlan({
      ...input,
      coverageTargetsBytes: Buffer.from(JSON.stringify(targets)),
    }),
    /candidate line scope partition mismatch/,
  );

  const sourceInventory = JSON.parse(input.sourceInventoryBytes);
  sourceInventory.sources.find(({ id }) => id === "incheon-transit-station-info")
    .routeMapAdmissionEvidence.snapshotSha256 = "0".repeat(64);
  assert.throws(
    () => buildPlan({
      ...input,
      sourceInventoryBytes: Buffer.from(JSON.stringify(sourceInventory)),
    }),
    /Incheon topology admission identity mismatch/,
  );
});

test("canonical wrapper manifest와 migration source identity drift는 plan 전에 거부한다", async () => {
  const input = await readProductionBytes();

  const missingManifest = JSON.parse(input.canonicalPackBytes);
  missingManifest.manifest = null;
  assert.throws(
    () => buildPlan({
      ...input,
      canonicalPackBytes: Buffer.from(JSON.stringify(missingManifest)),
    }),
    /canonical pack manifest/,
  );

  const staleActivePack = JSON.parse(input.canonicalPackBytes);
  staleActivePack.manifest.activePack.version = "0";
  assert.throws(
    () => buildPlan({
      ...input,
      canonicalPackBytes: Buffer.from(JSON.stringify(staleActivePack)),
    }),
    /canonical pack active identity/,
  );

  const invalidMigrationSource = JSON.parse(input.canonicalPackBytes);
  invalidMigrationSource.migrationSourceArtifact.gzipSha256 = "A".repeat(64);
  assert.throws(
    () => buildPlan({
      ...input,
      canonicalPackBytes: Buffer.from(JSON.stringify(invalidMigrationSource)),
    }),
    /canonical pack migration source/,
  );
});

test("canonical topology와 provider mapping drift는 plan output 전에 fail closed한다", async () => {
  const input = await readProductionBytes();
  const canonicalPack = JSON.parse(input.canonicalPackBytes);
  const targets = JSON.parse(input.coverageTargetsBytes);
  const activeLineIds = new Set(targets.activeLineScopes.map(({ lineId }) => lineId));
  const incheonLineIds = new Set(["line-42b5805f3b5a", "line-98718184f016"]);
  const localRide = canonicalPack.packs[0].networkEdges.find((edge) => (
    edge.edgeType === "RIDE" && edge.servicePattern === "LOCAL" && edge.serviceClass === "SUBWAY"
      && activeLineIds.has(edge.fromNodeId.split(":")[1])
      && !incheonLineIds.has(edge.fromNodeId.split(":")[1])
  ));
  localRide.fromNodeId = "station-missing:line-missing";
  assert.throws(
    () => buildPlan({
      ...input,
      canonicalPackBytes: Buffer.from(JSON.stringify(canonicalPack)),
    }),
    /route edge station-line mismatch/,
  );

  const routeRosters = JSON.parse(input.routeRostersBytes);
  routeRosters.rosters[0].stations.push({ ...routeRosters.rosters[0].stations[0] });
  assert.throws(
    () => buildPlan({
      ...input,
      routeRostersBytes: Buffer.from(JSON.stringify(routeRosters)),
    }),
    /duplicate KRIC station tuple|ambiguous canonical KRIC station join|duplicate canonical station-line provider tuple/,
  );
});

test("CLI는 regular input만 한 번 읽고 existing·symlink output을 덮어쓰지 않는다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-exit-production-plan-"));
  try {
    const output = path.join(directory, "plan.json");
    await main(cliArgs(output), { now: currentNow });
    const first = await readFile(output);
    assert.equal(first.toString("utf8"), canonicalKricExitPathCollectionPlanJson(
      buildPlan(await readProductionBytes()),
    ));

    await assert.rejects(() => main(cliArgs(output), { now: currentNow }), /output must be absent/);
    assert.deepEqual(await readFile(output), first);

    const symlinkOutput = path.join(directory, "symlink.json");
    await symlink(output, symlinkOutput);
    await assert.rejects(() => main(cliArgs(symlinkOutput), { now: currentNow }), /output must be absent/);
    assert.deepEqual(await readFile(output), first);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("input snapshot은 O_NOFOLLOW single descriptor의 stat/read/stat에 결속된다", async () => {
  assert.equal(typeof currentPlan.readRegularSnapshot, "function");
  const bytes = Buffer.from("descriptor-bound");
  const stableStat = fakeStat({ size: bytes.length });
  const events = [];
  const handle = {
    async stat() {
      events.push("stat");
      return stableStat;
    },
    async readFile() {
      events.push("read");
      return bytes;
    },
    async close() {
      events.push("close");
    },
  };
  const snapshot = await currentPlan.readRegularSnapshot("/not-read-by-path", "input", {
    openImpl: async (target, flags) => {
      events.push(["open", target, flags]);
      return handle;
    },
  });

  assert.deepEqual(snapshot.bytes, bytes);
  assert.deepEqual(events, [
    ["open", "/not-read-by-path", constants.O_RDONLY | constants.O_NOFOLLOW],
    "stat",
    "read",
    "stat",
    "close",
  ]);

  let statCall = 0;
  let closed = false;
  await assert.rejects(
    () => currentPlan.readRegularSnapshot("/replaced", "input", {
      openImpl: async () => ({
        async stat() {
          statCall += 1;
          return fakeStat({ ino: statCall });
        },
        async readFile() {
          return Buffer.alloc(1);
        },
        async close() {
          closed = true;
        },
      }),
    }),
    /input changed during read/,
  );
  assert.equal(closed, true);
});

test("preflight 실패는 output과 input bytes를 남기거나 바꾸지 않는다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-exit-production-failure-"));
  try {
    const invalidPack = path.join(directory, "invalid-pack.json");
    const output = path.join(directory, "plan.json");
    await writeFile(invalidPack, "{}", { flag: "wx" });
    await assert.rejects(() => main(cliArgs(output, { canonicalPack: invalidPack }), { now: currentNow }), /canonical pack/);
    await assert.rejects(() => readFile(output), { code: "ENOENT" });
    assert.equal(await readFile(invalidPack, "utf8"), "{}");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function readProductionBytes() {
  const [
    canonicalPackBytes,
    coverageTargetsBytes,
    providerCodeCatalogBytes,
    routeRostersBytes,
    sourceInventoryBytes,
    incheonTopologyBytes,
  ] = await Promise.all([
    readFile(productionPaths.canonicalPack),
    readFile(productionPaths.coverageTargets),
    readFile(productionPaths.providerCodeCatalog),
    readFile(productionPaths.routeRosters),
    readFile(productionPaths.sourceInventory),
    readFile(productionPaths.incheonTopology),
  ]);
  return {
    canonicalPackBytes,
    coverageTargetsBytes,
    providerCodeCatalogBytes,
    routeRostersBytes,
    sourceInventoryBytes,
    incheonTopologyBytes,
  };
}

function cliArgs(output, overrides = {}) {
  const args = [
    "--canonical-pack", overrides.canonicalPack ?? productionPaths.canonicalPack,
    "--coverage-targets", productionPaths.coverageTargets,
    "--provider-code-catalog", productionPaths.providerCodeCatalog,
    "--route-rosters", productionPaths.routeRosters,
    "--source-inventory", productionPaths.sourceInventory,
    "--incheon-topology", productionPaths.incheonTopology,
  ];
  if (overrides.coverageSelector !== undefined) {
    args.push("--coverage-selector", overrides.coverageSelector);
  }
  return [
    ...args,
    "--output", output,
  ];
}

function fakeStat(overrides = {}) {
  return {
    dev: 1,
    ino: 1,
    size: 1,
    mtimeMs: 1,
    mode: 0o100600,
    isFile: () => true,
    ...overrides,
  };
}
