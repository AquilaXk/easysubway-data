import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCurrentCapitalFacilityCollectionPlan,
  canonicalCurrentCapitalFacilityCollectionPlanJson,
  main,
} from "./build-current-capital-facility-collection-plan.mjs";
import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";

const datapackRoot = import.meta.dirname;
const paths = Object.freeze({
  canonicalPack: path.join(datapackRoot, "release/capital-production-canonical-pack.json"),
  coverageTargets: path.join(datapackRoot, "nationwide-coverage-targets.json"),
  providerCodeCatalog: path.join(datapackRoot, "sources/kric-provider-code-catalog-20260228.json"),
  routeRosters: path.join(datapackRoot, "sources/kric-nationwide-route-rosters-20260730T203926676Z.json"),
  sourceInventory: path.join(datapackRoot, "source-inventory.json"),
});

test("canonical capital@1 정본에서 213 FACILITY 수집 계약을 결정적으로 만든다", async () => {
  const input = await readInput();
  const before = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, Buffer.from(value)]));

  const plan = buildCurrentCapitalFacilityCollectionPlan(input);
  const repeated = buildCurrentCapitalFacilityCollectionPlan(input);

  assert.deepEqual(input, before);
  assert.equal(plan.coverage.regionId, "capital");
  assert.equal(plan.coverage.operatorId, "seoul-metro");
  assert.equal(plan.coverage.sourceDomain, "station_line_membership");
  assert.equal(plan.counts.stationLineCount, 213);
  assert.equal(plan.counts.stationCount, 199);
  assert.equal(plan.counts.providerTupleCount, 213);
  assert.equal(plan.stationLineProviderMappings.length, 213);
  assert.equal(new Set(plan.stationLineProviderMappings.map(({ stationId, lineId }) => `${stationId}\0${lineId}`)).size, 213);
  assert.equal(new Set(plan.stationLineProviderMappings.map(({ stationId }) => stationId)).size, 199);
  assert.match(plan.planSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    canonicalCurrentCapitalFacilityCollectionPlanJson(plan),
    canonicalCurrentCapitalFacilityCollectionPlanJson(repeated),
  );
});

test("scope, canonical membership, provider roster와 raw identity drift를 fail closed 한다", async () => {
  const input = await readInput();

  const pack = JSON.parse(input.canonicalPackBytes);
  const [capital] = pack.packs;
  capital.metadata.productionCoverageEvidence = JSON.stringify([
    { regionId: "capital", operatorId: "seoul-metro", sourceDomain: "accessibility_facilities", sourceIds: ["kric-station-convenience-standard"] },
  ]);
  assert.throws(() => buildCurrentCapitalFacilityCollectionPlan({
    ...input, canonicalPackBytes: Buffer.from(JSON.stringify(pack)),
  }), /production coverage membership evidence mismatch/);

  const duplicateMembership = JSON.parse(input.canonicalPackBytes);
  duplicateMembership.packs[0].stationLines.push(structuredClone(
    duplicateMembership.packs[0].stationLines.find(({ lineId }) => lineId === "seoul-2"),
  ));
  assert.throws(() => buildCurrentCapitalFacilityCollectionPlan({
    ...input, canonicalPackBytes: Buffer.from(JSON.stringify(duplicateMembership)),
  }), /duplicate canonical station-line/);

  const ambiguousRoster = JSON.parse(input.routeRostersBytes);
  const roster = ambiguousRoster.rosters.find(({ mreaWideCd, lnCd }) => mreaWideCd === "01" && lnCd === "2");
  roster.stations.push(structuredClone(roster.stations[0]));
  assert.throws(() => buildCurrentCapitalFacilityCollectionPlan({
    ...input, routeRostersBytes: Buffer.from(JSON.stringify(ambiguousRoster)),
  }), /duplicate KRIC provider tuple/);

  const providerDrift = JSON.parse(input.routeRostersBytes);
  providerDrift.providerScopes.find(({ lineId, operatorId }) => lineId === "seoul-4" && operatorId === "korail").railOprIsttCd = "WRONG";
  assert.throws(() => buildCurrentCapitalFacilityCollectionPlan({
    ...input, routeRostersBytes: Buffer.from(JSON.stringify(providerDrift)),
  }), /target provider scope identity mismatch/);

  const extraProviderScope = JSON.parse(input.routeRostersBytes);
  extraProviderScope.providerScopes.push({
    ...structuredClone(extraProviderScope.providerScopes.find(({ lineId }) => lineId === "seoul-2")),
    operatorId: "operator-extra-provider",
  });
  extraProviderScope.providerScopeCount += 1;
  assert.throws(() => buildCurrentCapitalFacilityCollectionPlan({
    ...input, routeRostersBytes: Buffer.from(JSON.stringify(extraProviderScope)),
  }), /target provider scope identity mismatch/);

  const missingActiveTarget = JSON.parse(input.coverageTargetsBytes);
  missingActiveTarget.activeLineScopes = missingActiveTarget.activeLineScopes.filter(({ lineId }) => lineId !== "seoul-2");
  assert.throws(() => buildCurrentCapitalFacilityCollectionPlan({
    ...input, coverageTargetsBytes: Buffer.from(JSON.stringify(missingActiveTarget)),
  }), /active target partition mismatch/);

  const retiredTarget = JSON.parse(input.coverageTargetsBytes);
  retiredTarget.inactiveLineExclusions.push({ ...retiredTarget.inactiveLineExclusions[0], lineId: "seoul-2" });
  assert.throws(() => buildCurrentCapitalFacilityCollectionPlan({
    ...input, coverageTargetsBytes: Buffer.from(JSON.stringify(retiredTarget)),
  }), /active target partition mismatch/);

  const suspendedCanonicalLine = JSON.parse(input.canonicalPackBytes);
  suspendedCanonicalLine.packs[0].lines.find(({ id }) => id === "seoul-2").serviceLifecycle = "SUSPENDED";
  assert.throws(() => buildCurrentCapitalFacilityCollectionPlan({
    ...input, canonicalPackBytes: Buffer.from(JSON.stringify(suspendedCanonicalLine)),
  }), /line scope is inactive or empty/);

  const rosterCountDrift = JSON.parse(input.routeRostersBytes);
  rosterCountDrift.providerScopeCount += 1;
  assert.throws(() => buildCurrentCapitalFacilityCollectionPlan({
    ...input, routeRostersBytes: Buffer.from(JSON.stringify(rosterCountDrift)),
  }), /route roster identity mismatch/);

  const rosterVersionDrift = JSON.parse(input.routeRostersBytes);
  rosterVersionDrift.targetVersion = "wrong";
  assert.throws(() => buildCurrentCapitalFacilityCollectionPlan({
    ...input, routeRostersBytes: Buffer.from(JSON.stringify(rosterVersionDrift)),
  }), /route roster identity mismatch/);

  const revokedFacilitySource = JSON.parse(input.sourceInventoryBytes);
  revokedFacilitySource.sources.find(({ id }) => id === "kric-station-convenience-standard").license.commercialUseAllowed = false;
  assert.throws(() => buildCurrentCapitalFacilityCollectionPlan({
    ...input, sourceInventoryBytes: Buffer.from(JSON.stringify(revokedFacilitySource)),
  }), /KRIC FACILITY source admission mismatch/);

  const facilityLicenseHashDrift = JSON.parse(input.sourceInventoryBytes);
  facilityLicenseHashDrift.sources.find(({ id }) => id === "kric-station-convenience-standard")
    .admissionEvidence.licenseEvidenceHash = "0".repeat(64);
  assert.throws(() => buildCurrentCapitalFacilityCollectionPlan({
    ...input, sourceInventoryBytes: Buffer.from(JSON.stringify(facilityLicenseHashDrift)),
  }), /KRIC FACILITY source admission mismatch/);

  const baseline = buildCurrentCapitalFacilityCollectionPlan(input);
  const rebound = buildCurrentCapitalFacilityCollectionPlan({
    ...input, sourceInventoryBytes: Buffer.concat([input.sourceInventoryBytes, Buffer.from("\n")]),
  });
  assert.notEqual(rebound.sourceIdentity.sourceInventorySha256, baseline.sourceIdentity.sourceInventorySha256);
  assert.notEqual(rebound.planSha256, baseline.planSha256);
});

test("canonical FACILITY plan은 rehash된 semantic/nested order drift도 거부한다", async () => {
  const plan = buildCurrentCapitalFacilityCollectionPlan(await readInput());
  const semanticDrift = structuredClone(plan);
  semanticDrift.counts.stationCount = 198;
  rehash(semanticDrift);
  assert.throws(() => canonicalCurrentCapitalFacilityCollectionPlanJson(semanticDrift), /count mismatch/);

  const duplicate = structuredClone(plan);
  duplicate.stationLineProviderMappings[1] = structuredClone(duplicate.stationLineProviderMappings[0]);
  rehash(duplicate);
  assert.throws(() => canonicalCurrentCapitalFacilityCollectionPlanJson(duplicate), /mapping duplicate/);

  const reordered = structuredClone(plan);
  reordered.stationLineProviderMappings.reverse();
  rehash(reordered);
  assert.throws(() => canonicalCurrentCapitalFacilityCollectionPlanJson(reordered), /mapping order mismatch/);
});

test("candidate root의 다섯 정본 입력을 canonical FACILITY plan으로 외부에 독점 materialize한다", async (t) => {
  const outputParent = await mkdtemp(path.join(os.tmpdir(), "easysubway-facility-plan-"));
  const outsideParent = await mkdtemp(path.join(os.tmpdir(), "easysubway-facility-plan-outside-"));
  t.after(async () => {
    await Promise.all([rm(outputParent, { recursive: true, force: true }), rm(outsideParent, { recursive: true, force: true })]);
  });
  const output = path.join(await realpath(outputParent), "plan.json");
  const canonicalOutsideParent = await realpath(outsideParent);

  await main(["--repository-root", path.resolve(datapackRoot, "../.."), "--output", output], { log: () => {} });

  const expected = canonicalCurrentCapitalFacilityCollectionPlanJson(
    buildCurrentCapitalFacilityCollectionPlan(await readInput()),
  );
  assert.equal(await readFile(output, "utf8"), expected);
  await assert.rejects(
    () => main(["--repository-root", path.resolve(datapackRoot, "../.."), "--output", output], { log: () => {} }),
    /output must not already exist/,
  );
  await assert.rejects(
    () => main(["--repository-root", "relative", "--output", path.join(outsideParent, "relative.json")], { log: () => {} }),
    /repository root must be an absolute path/,
  );
  await assert.rejects(
    () => main(["--repository-root", path.resolve(datapackRoot, "../.."), "--output", path.join(datapackRoot, "plan.json")], { log: () => {} }),
    /output must stay outside repository root/,
  );
  const linkedParent = path.join(outputParent, "linked");
  await symlink(canonicalOutsideParent, linkedParent);
  await assert.rejects(
    () => main(["--repository-root", path.resolve(datapackRoot, "../.."), "--output", path.join(linkedParent, "plan.json")], { log: () => {} }),
    /output parent must be a regular non-symlink directory/,
  );
  await writeFile(path.join(canonicalOutsideParent, "existing.json"), "already exists");
  await assert.rejects(
    () => main(["--repository-root", path.resolve(datapackRoot, "../.."), "--output", path.join(canonicalOutsideParent, "existing.json")], { log: () => {} }),
    /output must not already exist/,
  );
});

async function readInput() {
  const [canonicalPackBytes, coverageTargetsBytes, providerCodeCatalogBytes, routeRostersBytes, sourceInventoryBytes] = await Promise.all([
    readFile(paths.canonicalPack),
    readFile(paths.coverageTargets),
    readFile(paths.providerCodeCatalog),
    readFile(paths.routeRosters),
    readFile(paths.sourceInventory),
  ]);
  return { canonicalPackBytes, coverageTargetsBytes, providerCodeCatalogBytes, routeRostersBytes, sourceInventoryBytes };
}

function rehash(plan) {
  const { planSha256: _, ...payload } = plan;
  plan.planSha256 = sha256(Buffer.from(canonicalJson(payload)));
}
