import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildCurrentKricExitCollectionPlan,
  main,
} from "./build-current-kric-exit-collection-plan.mjs";
import { canonicalKricExitPathCollectionPlanJson } from "./plan-kric-exit-path-collection.mjs";

const datapackRoot = fileURLToPath(new URL(".", import.meta.url));
const currentNow = new Date("2026-08-13T16:00:00.000Z");
const productionPaths = Object.freeze({
  canonicalPack: path.join(datapackRoot, "release/capital-production-canonical-pack.json"),
  coverageTargets: path.join(datapackRoot, "nationwide-coverage-targets.json"),
  providerCodeCatalog: path.join(datapackRoot, "sources/kric-provider-code-catalog-20260228.json"),
  routeRosters: path.join(datapackRoot, "sources/kric-nationwide-route-rosters-20260730T203926676Z.json"),
  sourceInventory: path.join(datapackRoot, "source-inventory.json"),
  incheonTopology: path.join(datapackRoot, "sources/incheon-transit-station-info-20260813.json"),
});

const buildPlan = (input) => buildCurrentKricExitCollectionPlan(input, { now: currentNow });

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
  return [
    "--canonical-pack", overrides.canonicalPack ?? productionPaths.canonicalPack,
    "--coverage-targets", productionPaths.coverageTargets,
    "--provider-code-catalog", productionPaths.providerCodeCatalog,
    "--route-rosters", productionPaths.routeRosters,
    "--source-inventory", productionPaths.sourceInventory,
    "--incheon-topology", productionPaths.incheonTopology,
    "--output", output,
  ];
}
