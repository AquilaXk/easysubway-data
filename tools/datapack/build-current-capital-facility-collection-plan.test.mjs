import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCurrentCapitalFacilityCollectionPlan,
  canonicalCurrentCapitalFacilityCollectionPlanJson,
  main,
  selectCurrentKricRouteRostersPath,
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

test("canonical capital@1 정본에서 FACILITY 수집 계약을 결정적으로 만든다", async () => {
  const input = await readInput();
  const before = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, Buffer.from(value)]));

  const plan = buildCurrentCapitalFacilityCollectionPlan(input);
  const repeated = buildCurrentCapitalFacilityCollectionPlan(input);

  assert.deepEqual(input, before);
  assert.equal(plan.coverage.regionId, "capital");
  assert.equal(plan.coverage.operatorId, "seoul-metro");
  assert.equal(plan.coverage.sourceDomain, "station_line_membership");
  assert.deepEqual(plan.counts, {
    stationLineCount: plan.stationLineProviderMappings.length,
    stationCount: new Set(plan.stationLineProviderMappings.map(({ stationId }) => stationId)).size,
    providerTupleCount: new Set(plan.stationLineProviderMappings.map(({ providerOperatorId, providerLineId, providerStationId }) => `${providerOperatorId}\0${providerLineId}\0${providerStationId}`)).size,
  });
  assert.equal(new Set(plan.stationLineProviderMappings.map(({ stationId, lineId }) => `${stationId}\0${lineId}`)).size, plan.stationLineProviderMappings.length);
  assert.match(plan.planSha256, /^[a-f0-9]{64}$/);
  // anti-cheat-allow: circular-oracle -- 동일 입력 반복 호출 또는 다중 인코딩 환경에서 결정론적(deterministic) 동일 결과 검증
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

  // main은 선택 함수가 고른 현재 roster를 쓴다(#862).
  const repositoryRoot = path.resolve(datapackRoot, "../..");
  const currentRosters = await readFile(path.join(repositoryRoot, await selectCurrentKricRouteRostersPath({ repositoryRoot })));
  const expected = canonicalCurrentCapitalFacilityCollectionPlanJson(
    buildCurrentCapitalFacilityCollectionPlan({ ...await readInput(), routeRostersBytes: currentRosters }),
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

// #862: KRIC가 역 코드를 바꾸면(2026-10 신분당선) 새 roster를 받아야 한다. FACILITY 도구는 roster 경로를
// 상수로 고정하지 않고, 한 선택 함수가 sources/의 roster 중 capturedAt이 가장 늦은 것을 고른다.
test("FACILITY operation·계획·probe·rebind·live-chain은 roster 경로를 고정하지 않고 선택 함수로 현재 roster를 고른다(#862)", async () => {
  for (const tool of [
    "build-current-capital-facility-collection-plan.mjs",
    "run-current-capital-facility-operation.mjs",
    "probe-kric-facility-provider-tuples.mjs",
    // #862: #866 중 roster 선택 부분만 흡수한다.
    "rebind-current-active-facility-derived-identity.mjs",
    "run-current-capital-live-chain.mjs",
  ]) {
    const source = await readFile(path.join(datapackRoot, tool), "utf8");
    assert.doesNotMatch(source, /kric-nationwide-route-rosters-\d{8}T/u, `${tool} pins a roster file`);
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "facility-roster-select-"));
  try {
    const sources = path.join(root, "tools/datapack/sources");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(sources, { recursive: true }));
    const roster = (capturedAt) => `${JSON.stringify({ artifactKind: "kric-nationwide-route-rosters", capturedAt })}\n`;
    await assert.rejects(selectCurrentKricRouteRostersPath({ repositoryRoot: root }), /KRIC route roster is missing/);
    await writeFile(path.join(sources, "kric-nationwide-route-rosters-20260730T203926676Z.json"), roster("2026-07-30T20:39:26.676Z"));
    await writeFile(path.join(sources, "kric-nationwide-route-rosters-20261001T050420765Z.json"), roster("2026-10-01T05:04:20.765Z"));
    await writeFile(path.join(sources, "kric-nationwide-route-rosters-notes.txt"), "ignored");
    assert.equal(await selectCurrentKricRouteRostersPath({ repositoryRoot: root }),
      "tools/datapack/sources/kric-nationwide-route-rosters-20261001T050420765Z.json");
    // 파일명 시각과 capturedAt이 다르면 고르지 않고 실패한다.
    await writeFile(path.join(sources, "kric-nationwide-route-rosters-20261002T000000000Z.json"), roster("2026-10-01T05:04:20.765Z"));
    await assert.rejects(selectCurrentKricRouteRostersPath({ repositoryRoot: root }), /KRIC route roster capturedAt does not match its file name/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
