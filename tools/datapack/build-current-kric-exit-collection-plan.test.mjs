import assert from "node:assert/strict";
import { constants } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as currentPlan from "./build-current-kric-exit-collection-plan.mjs";
import {
  admittedIncheonTopologyEvidence,
  materializeIncheonNetworkEdges,
} from "./build-datapack.mjs";
import { canonicalKricExitPathCollectionPlanJson } from "./plan-kric-exit-path-collection.mjs";

const { buildCurrentKricExitCollectionPlan, main } = currentPlan;
const datapackRoot = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const productionPaths = Object.freeze({
  canonicalPack: path.join(datapackRoot, "release/capital-production-canonical-pack.json"),
  coverageTargets: path.join(datapackRoot, "nationwide-coverage-targets.json"),
  providerCodeCatalog: path.join(datapackRoot, "sources/kric-provider-code-catalog-20260228.json"),
  routeRosters: path.join(datapackRoot, "sources/kric-nationwide-route-rosters-20260730T203926676Z.json"),
  sourceInventory: path.join(datapackRoot, "source-inventory.json"),
});

const buildPlan = (input, options = {}) => buildCurrentKricExitCollectionPlan(input, {
  now: new Date(admittedIncheonTopology(input).capturedAt),
  ...options,
});

test("current production 정본에서 exact EXIT collection plan을 결정적으로 만든다", async () => {
  const input = await readProductionBytes();
  const before = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, Buffer.from(value)]));

  const plan = buildPlan(input);
  const repeated = buildPlan(input);
  const pack = JSON.parse(input.canonicalPackBytes).packs[0];
  const targets = JSON.parse(input.coverageTargetsBytes);
  const activeLineIds = new Set(targets.activeLineScopes.map(({ lineId }) => lineId));
  const activeStationLines = pack.stationLines.filter(({ lineId }) => activeLineIds.has(lineId));
  const incheonTopology = JSON.parse(input.incheonTopologyBytes);
  const incheonLineIds = new Set(incheonTopology.topologyLineIds);
  const retainedLocalRideEdges = pack.networkEdges.filter((edge) => (
    edge.edgeType === "RIDE" && edge.servicePattern === "LOCAL" && edge.serviceClass === "SUBWAY"
      && activeLineIds.has(edge.fromNodeId.split(":")[1])
      && !incheonLineIds.has(edge.fromNodeId.split(":")[1])
  ));
  const projectedPack = structuredClone(pack);
  const incheonAdmission = admittedIncheonTopologyEvidence({
    sourceInventory: JSON.parse(input.sourceInventoryBytes),
    snapshot: incheonTopology,
    snapshotBytes: input.incheonTopologyBytes,
    now: new Date(incheonTopology.capturedAt),
    requireFresh: true,
  });
  materializeIncheonNetworkEdges(projectedPack, incheonTopology, incheonAdmission);
  const expectedIncheonEdgeIds = projectedPack.networkEdges
    .filter((edge) => edge.edgeType === "RIDE"
      && edge.servicePattern === "LOCAL"
      && edge.serviceClass === "SUBWAY"
      && incheonLineIds.has(edge.fromNodeId.split(":")[1]))
    .map(({ id }) => id)
    .sort();
  const actualIncheonEdgeIds = plan.routeEdges
    .filter(({ lineId }) => incheonLineIds.has(lineId))
    .map(({ routeEdgeId }) => routeEdgeId)
    .sort();

  assert.match(plan.candidate.candidateId, /^current-production-exit-[a-f0-9]{64}$/);
  assert.equal(plan.providerMappings.length, activeStationLines.length);
  assert.equal(plan.stationLineQueries.length, activeStationLines.length);
  assert.equal(plan.routeEdges.length, retainedLocalRideEdges.length + incheonTopology.edgeCount);
  assert.equal(plan.queryPlan.length, plan.routeEdges.length);
  assert.deepEqual(actualIncheonEdgeIds, expectedIncheonEdgeIds);
  assert.ok(plan.stationLineQueries.every(({ queryIds }) => queryIds.length > 0));
  assert.equal(
    canonicalKricExitPathCollectionPlanJson(plan),
    canonicalKricExitPathCollectionPlanJson(repeated),
  );
  for (const [key, value] of Object.entries(input)) assert.deepEqual(value, before[key]);
});

test("capital Seoul Metro production selector는 canonical metadata와 실제 membership의 exact scope를 만든다", async () => {
  const input = await readProductionBytes();
  const plan = buildPlan(input, { coverageSelector: "capital-seoul-metro-production" });
  const pack = JSON.parse(input.canonicalPackBytes).packs[0];
  const targets = JSON.parse(input.coverageTargetsBytes);
  const [membershipEvidence] = JSON.parse(pack.metadata.productionCoverageEvidence)
    .filter(({ sourceDomain }) => sourceDomain === "station_line_membership");
  const activeRegionLineIds = new Set(targets.activeLineScopes
    .filter(({ regionId }) => regionId === membershipEvidence.regionId)
    .map(({ lineId }) => lineId));
  const selectedLineIds = new Set(pack.lines
    .filter(({ id, operatorId }) => operatorId === membershipEvidence.operatorId
      && activeRegionLineIds.has(id))
    .map(({ id }) => id));
  const expectedStationLineKeys = pack.stationLines
    .filter(({ lineId }) => selectedLineIds.has(lineId))
    .map(({ stationId, lineId }) => `${stationId}\0${lineId}`)
    .sort();
  const actualStationLineKeys = plan.providerMappings
    .map(({ stationId, lineId }) => `${stationId}\0${lineId}`)
    .sort();

  assert.deepEqual(actualStationLineKeys, expectedStationLineKeys);
  assert.deepEqual(
    plan.stationLineQueries.map(({ stationLineId }) => stationLineId).sort(),
    expectedStationLineKeys.map((key) => key.replace("\0", ":")).sort(),
  );
  assert.deepEqual(
    plan.queryPlan.map(({ routeEdgeId }) => routeEdgeId).sort(),
    plan.routeEdges.map(({ routeEdgeId }) => routeEdgeId).sort(),
  );
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
  const alteredSelectedEdges = asymmetricTopology.packs[0].networkEdges.filter((edge) => (
    edge.edgeType === "RIDE" && edge.servicePattern === "LOCAL" && edge.serviceClass === "SUBWAY"
      && selectedLineIds.has(edge.fromNodeId.split(":")[1])
  ));
  assert.equal(alteredSelectedEdges.length, plan.routeEdges.length);
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

test("capital selector는 비대상 Incheon freshness에 결합하지 않고 nationwide는 stale을 거부한다", async () => {
  const input = await readProductionBytes();
  const afterIncheonExpiry = new Date(Date.parse(admittedIncheonTopology(input).freshUntil) + 1);

  assert.throws(
    () => buildCurrentKricExitCollectionPlan(input, { now: afterIncheonExpiry }),
    /Incheon topology admission is stale/,
  );

  const plan = buildCurrentKricExitCollectionPlan(input, {
    now: afterIncheonExpiry,
    coverageSelector: "capital-seoul-metro-production",
  });
  const incheonLineIds = new Set(["line-42b5805f3b5a", "line-98718184f016"]);
  const stationLineKeys = new Set(plan.providerMappings.map(
    ({ stationId, lineId }) => `${stationId}\0${lineId}`,
  ));

  assert.equal(stationLineKeys.size, plan.providerMappings.length);
  assert.equal(plan.queryPlan.length, plan.routeEdges.length);
  assert.equal(plan.routeEdges.some(({ lineId }) => incheonLineIds.has(lineId)), false);
  assert.ok(plan.routeEdges.every(({ fromStationId, toStationId, lineId }) => (
    stationLineKeys.has(`${fromStationId}\0${lineId}`)
      && stationLineKeys.has(`${toStationId}\0${lineId}`)
  )));

  const identityDrift = JSON.parse(input.sourceInventoryBytes);
  identityDrift.sources.find(({ id }) => id === "incheon-transit-station-info")
    .routeMapAdmissionEvidence.snapshotSha256 = "0".repeat(64);
  assert.throws(
    () => buildCurrentKricExitCollectionPlan({
      ...input,
      sourceInventoryBytes: Buffer.from(JSON.stringify(identityDrift)),
    }, {
      now: afterIncheonExpiry,
      coverageSelector: "capital-seoul-metro-production",
    }),
    /Incheon topology admission identity mismatch/,
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

  const invalidCoverageScopeUnion = JSON.parse(input.canonicalPackBytes);
  invalidCoverageScopeUnion.coverageLineOperatorScopes.pop();
  assert.throws(
    () => buildPlan({
      ...input,
      canonicalPackBytes: Buffer.from(JSON.stringify(invalidCoverageScopeUnion)),
    }),
    /canonical pack coverage line operator scope union/,
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
    const input = await readProductionBytes();
    const sourceInventory = path.join(directory, "source-inventory.json");
    const incheonTopology = path.join(directory, "incheon-topology.json");
    await Promise.all([
      writeFile(sourceInventory, input.sourceInventoryBytes, { flag: "wx" }),
      writeFile(incheonTopology, input.incheonTopologyBytes, { flag: "wx" }),
    ]);
    const currentCliArgs = cliArgs(output, { sourceInventory, incheonTopology });
    await main(currentCliArgs, { now: new Date(admittedIncheonTopology(input).capturedAt) });
    const first = await readFile(output);
    assert.equal(first.toString("utf8"), canonicalKricExitPathCollectionPlanJson(
      buildPlan(input),
    ));

    await assert.rejects(() => main(currentCliArgs, {
      now: new Date(admittedIncheonTopology(input).capturedAt),
    }), /output must be absent/);
    assert.deepEqual(await readFile(output), first);

    const symlinkOutput = path.join(directory, "symlink.json");
    await symlink(output, symlinkOutput);
    await assert.rejects(() => main(cliArgs(symlinkOutput, { sourceInventory, incheonTopology }), {
      now: new Date(admittedIncheonTopology(input).capturedAt),
    }), /output must be absent/);
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
    const input = await readProductionBytes();
    const invalidPack = path.join(directory, "invalid-pack.json");
    const output = path.join(directory, "plan.json");
    await writeFile(invalidPack, "{}", { flag: "wx" });
    await assert.rejects(() => main(cliArgs(output, {
      canonicalPack: invalidPack,
      incheonTopology: admittedIncheonTopologyPath(input),
    }), { now: new Date(admittedIncheonTopology(input).capturedAt) }), /canonical pack/);
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
  ] = await Promise.all([
    readFile(productionPaths.canonicalPack),
    readFile(productionPaths.coverageTargets),
    readFile(productionPaths.providerCodeCatalog),
    readFile(productionPaths.routeRosters),
    readFile(productionPaths.sourceInventory),
  ]);
  const sourceInventory = JSON.parse(sourceInventoryBytes);
  const admission = sourceInventory.sources.find(({ id }) => id === "incheon-transit-station-info")
    ?.topologyAdmissionEvidence;
  if (!admission?.snapshotPath) throw new Error("current Incheon topology snapshot path is missing");
  const incheonTopologyBytes = await readFile(path.resolve(repositoryRoot, admission.snapshotPath));
  return {
    canonicalPackBytes,
    coverageTargetsBytes,
    providerCodeCatalogBytes,
    routeRostersBytes,
    sourceInventoryBytes,
    incheonTopologyBytes,
  };
}

function admittedIncheonTopology(input) {
  const admission = JSON.parse(input.sourceInventoryBytes).sources
    .find(({ id }) => id === "incheon-transit-station-info")?.topologyAdmissionEvidence;
  if (!admission?.capturedAt || !admission?.freshUntil) {
    throw new Error("current Incheon topology admission window is missing");
  }
  return admission;
}

function admittedIncheonTopologyPath(input) {
  const snapshotPath = admittedIncheonTopology(input).snapshotPath;
  if (!snapshotPath) throw new Error("current Incheon topology snapshot path is missing");
  return path.resolve(repositoryRoot, snapshotPath);
}

function cliArgs(output, overrides = {}) {
  if (!overrides.incheonTopology) throw new Error("test Incheon topology path is required");
  const args = [
    "--canonical-pack", overrides.canonicalPack ?? productionPaths.canonicalPack,
    "--coverage-targets", productionPaths.coverageTargets,
    "--provider-code-catalog", productionPaths.providerCodeCatalog,
    "--route-rosters", productionPaths.routeRosters,
    "--source-inventory", overrides.sourceInventory ?? productionPaths.sourceInventory,
    "--incheon-topology", overrides.incheonTopology,
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
