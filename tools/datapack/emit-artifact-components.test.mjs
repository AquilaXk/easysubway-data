import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";

import { canonicalJson } from "./lib/manifest-validation.mjs";
import { loadStationElevatorPathInputs } from "./build-station-elevator-paths.mjs";
import { loadStationPlatformGapInputs } from "./build-station-platform-gaps.mjs";
import { collectSeoulStationLineInfo } from "./collect-seoul-station-line-info.mjs";
import {
  buildKricExitPathObservation,
  buildKricExitPathRawCollection,
  canonicalKricExitPathProviderSnapshotJson,
  collectKricExitPathProviderSnapshot,
} from "./collect-kric-exit-path-provider-snapshot.mjs";
import {
  collectSeoulAccessibilityObservation,
  writeSeoulAccessibilityObservation,
} from "./collect-seoul-accessibility-evidence.mjs";
import { planKricExitPathCollection } from "./plan-kric-exit-path-collection.mjs";
import { canonicalCurrentCapitalRouteEdgeInputJson } from "./current-capital-station-line-contract.mjs";
import { emitArtifactComponents, nationwideTopologyEdgeStairColumns, populateNationwideTopologyEdges, serializeArtifactComponents, validateInputBinding } from "./emit-artifact-components.mjs";
import {
  canonicalRouteEdgeEvaluationJson,
  canonicalRideEdgeSetSha256,
  evaluateRouteAccessibilityEdges,
  routeEdgeSha256,
} from "./evaluate-route-accessibility-edges.mjs";
import {
  canonicalStationLineAccessibilityJson,
  materializeStationLineAccessibility,
} from "./materialize-station-line-accessibility.mjs";
import { copySyntheticCurrentPublicRouteMapRepository } from "./test-fixtures/current-public-route-map-successor.mjs";
import { currentTopologyAdmissionClock } from "./test-fixtures/current-topology-admission-clock.mjs";
import { createIndependentSourceGovernanceFixture } from "./test-fixtures/independent-source-governance.mjs";

const SCRIPT = path.resolve("tools/datapack/emit-artifact-components.mjs");
const CURRENT_CAPITAL_BASE_SOURCE_IDS = Object.freeze([
  "molit-urban-rail-full-route", "seoulmetro-station-line-info", "seoul-metro-route-map-positions",
  "kric-subway-timetable", "seoul-metro-accessibility", "kric-station-convenience-standard",
  "seoul-metro-official-od-fares", "seoul-metro-transfer-distance-duration",
]);
const CURRENT_SOURCE_WINDOW = await selectedSourceWindow();
const CURRENT_ACTIVE_FROM = CURRENT_SOURCE_WINDOW.activeFrom;
const CURRENT_FRESH_UNTIL = CURRENT_SOURCE_WINDOW.freshUntil;
const CURRENT_EVALUATION_AT = CURRENT_SOURCE_WINDOW.evaluationAt;
const CURRENT_SOURCE_EXPIRES_AT = CURRENT_SOURCE_WINDOW.sourceExpiresAt;
// #862: RIDE route edge는 후보 fixture의 RIDE network edge를 하나씩 투영한다. 승인 ITX 원천이 바뀌면
// (11ba30b4…, ITX edge 64→48) 개수도 바뀌므로 고정 상수 대신 tracked 후보 fixture에서 유도한다.
const CURRENT_CANDIDATE_FIXTURE = JSON.parse(await readFile(
  JSON.parse(await readFile("tools/datapack/release/candidate-build-spec.json", "utf8")).fixturePath, "utf8",
));
// #866 PR-C: 수도권 live chain 출력(ENTRY/EXIT 213·환승 30) 대신 전국 후보 준비가 결속한 전국 입력을 쓴다.
// 승강장 기준(#873)이라 ENTRY/EXIT가 없다. 환승 수는 tracked 후보 fixture의 역 안 환승 링크에서 유도한다.
const CURRENT_ACTIVE_CANDIDATE_PACK = CURRENT_CANDIDATE_FIXTURE.packs
  .find(({ id }) => id === CURRENT_CANDIDATE_FIXTURE.manifest.activePack.id);
const CURRENT_PREPARATION = JSON.parse(await readFile("tools/datapack/release/nationwide-candidate-preparation.json", "utf8"));
const buildNowEnvironmentKey = "EASYSUBWAY_DATAPACK_BUILD_NOW";
const hadBuildNowEnvironmentValue = Object.hasOwn(process.env, buildNowEnvironmentKey);
const previousBuildNowEnvironmentValue = process.env[buildNowEnvironmentKey];
process.env[buildNowEnvironmentKey] = CURRENT_EVALUATION_AT;
after(() => {
  if (hadBuildNowEnvironmentValue) {
    process.env[buildNowEnvironmentKey] = previousBuildNowEnvironmentValue;
  } else {
    delete process.env[buildNowEnvironmentKey];
  }
});


async function selectedSourceWindow() {
  const [buildSpec, sourceSnapshots, topologyClock] = await Promise.all([
    readFile("tools/datapack/release/candidate-build-spec.json", "utf8").then(JSON.parse),
    readFile("tools/datapack/release/source-snapshots.json", "utf8").then(JSON.parse),
    currentTopologyAdmissionClock(process.cwd()),
  ]);
  const selected = buildSpec.sourceSnapshotIds.map((snapshotId) => {
    const matches = sourceSnapshots.filter((entry) => entry.snapshotId === snapshotId);
    assert.equal(matches.length, 1, `selected source snapshot identity: ${snapshotId}`);
    return matches[0];
  }).filter((entry) => CURRENT_CAPITAL_BASE_SOURCE_IDS.includes(entry.sourceId));
  const basisAt = Math.max(...selected.flatMap((entry) => [
    entry.retrievedAt,
    entry.sourceUpdatedAt,
    entry.rawReceipt?.storedAt,
  ].filter(Boolean).map(Date.parse)));
  const candidatePublishedAt = Date.parse(buildSpec.publishedAt);
  const freshUntil = Math.min(
    ...selected.map(({ freshnessExpiresAt }) => Date.parse(freshnessExpiresAt)),
    topologyClock.expiredAt.getTime(),
  );
  const evaluationAt = candidatePublishedAt < freshUntil
    ? Math.max(basisAt + 1_000, candidatePublishedAt, topologyClock.inWindow.getTime())
    : Math.max(basisAt + 1_000, topologyClock.inWindow.getTime());
  assert.ok(Number.isFinite(basisAt) && Number.isFinite(candidatePublishedAt)
    && Number.isFinite(freshUntil) && evaluationAt < freshUntil);
  return {
    activeFrom: kstInstant(evaluationAt),
    evaluationAt: new Date(evaluationAt).toISOString(),
    freshUntil: kstInstant(freshUntil),
    sourceExpiresAt: new Date(freshUntil).toISOString(),
  };
}

function kstInstant(milliseconds) {
  return new Date(milliseconds + 9 * 60 * 60 * 1_000).toISOString().replace("Z", "+09:00");
}

// #866 PR-B(D3): emit 입력 결속은 capital@1 하드코딩이 아니라 current.json이 선택한 active production pack을 따른다.
test("emit 입력 결속은 pack id와 무관하게 current.json active production pack의 sqlite에 결속한다", () => {
  const sourceHash = "1".repeat(64);
  const otherHash = "2".repeat(64);
  const buildSpecHash = "3".repeat(64);
  const binding = (id, packs = [{ id, version: "1", artifactKind: "production", sqliteSha256: sourceHash }], activePack = { id, version: "1" }) => {
    const current = { ...(activePack === undefined ? {} : { activePack }), packs };
    const currentHash = createHash("sha256").update(JSON.stringify(current)).digest("hex");
    const provenance = {
      schemaVersion: 1,
      artifactKind: "datapack-field-provenance",
      manifestSha256: currentHash,
      packs: structuredClone(packs),
      candidateBuild: { buildSpecSha256: buildSpecHash },
    };
    return [provenance, current, currentHash, sourceHash, buildSpecHash];
  };
  for (const id of ["capital", "nationwide", "fixture-national-network"]) {
    assert.doesNotThrow(() => validateInputBinding(...binding(id)), id);
    assert.throws(() => validateInputBinding(...binding(id, [{ id, version: "1", artifactKind: "production", sqliteSha256: otherHash }])), /source pack identity mismatch/, id);
    assert.throws(() => validateInputBinding(...binding(id, [{ id, version: "1", artifactKind: "fixture", sqliteSha256: sourceHash }])), /source pack identity mismatch/, id);
  }
  // active pack이 아닌 다른 production pack의 sqlite로는 결속하지 않는다.
  assert.throws(() => validateInputBinding(...binding("nationwide", [
    { id: "capital", version: "1", artifactKind: "production", sqliteSha256: sourceHash },
    { id: "nationwide", version: "1", artifactKind: "production", sqliteSha256: otherHash },
  ])), /source pack identity mismatch/);
  // 리뷰 F3: 같은 id라도 provenance의 pack version이 active pack과 다르면 결속하지 않는다.
  {
    const [provenance, current, currentHash] = binding("nationwide");
    provenance.packs = [{ id: "nationwide", version: "2", artifactKind: "production", sqliteSha256: sourceHash }];
    assert.throws(() => validateInputBinding(provenance, current, currentHash, sourceHash, buildSpecHash), /source pack identity mismatch/);
  }
  // active pack 선택이 없으면 이름으로 추측하지 않고 실패한다.
  assert.throws(() => validateInputBinding(...binding("capital", undefined, null)), /source pack identity mismatch/);
});

test("전국 후보 준비가 결속한 route·station-line 입력은 RIDE 정책·evaluation 계약과 일치한다", async () => {
  const [stationLineBytes, routeBytes, policyBytes] = await Promise.all([
    readFile(CURRENT_PREPARATION.stationLineInput.path),
    readFile(CURRENT_PREPARATION.routeEdgeInput.path),
    readFile("release/product-gates/route-edge-evaluation-policy.json"),
  ]);
  assert.equal(createHash("sha256").update(stationLineBytes).digest("hex"), CURRENT_PREPARATION.stationLineInput.sha256);
  assert.equal(createHash("sha256").update(routeBytes).digest("hex"), CURRENT_PREPARATION.routeEdgeInput.sha256);
  const policy = JSON.parse(policyBytes);
  const stationLineInput = JSON.parse(stationLineBytes);
  const input = JSON.parse(routeBytes);
  const observedAt = new Date(Math.max(
    ...stationLineInput.evidenceRows.map(({ capturedAt }) => Date.parse(capturedAt)),
  )).toISOString();
  const materialization = materializeStationLineAccessibility({
    ...stationLineInput,
    observedAt,
  });
  assert.equal(canonicalCurrentCapitalRouteEdgeInputJson(input), routeBytes.toString("utf8"));

  assert.equal(
    input.candidate.topologySha256,
    canonicalRideEdgeSetSha256(input.routeEdges.filter(({ edgeType }) => edgeType === "RIDE")),
  );
  assert.equal(input.candidate.stationSetSha256, stationLineInput.candidate.stationSetSha256);
  assert.equal(input.stationLines.length, CURRENT_ACTIVE_CANDIDATE_PACK.stationLines.length);
  assert.equal(input.stationLines.length, stationLineInput.stationLines.length);
  const counts = Object.fromEntries(input.routeEdges.reduce((values, edge) => {
    values.set(edge.edgeType, (values.get(edge.edgeType) ?? 0) + 1);
    return values;
  }, new Map()));
  assert.equal(counts.ENTRY, undefined);
  assert.equal(counts.EXIT, undefined);
  assert.equal(counts.RIDE, CURRENT_ACTIVE_CANDIDATE_PACK.networkEdges.filter(({ edgeType }) => edgeType === "RIDE").length);
  assert.ok(counts.IN_STATION_TRANSFER > 0);
  assert.deepEqual(Object.keys(counts).filter((type) => !["RIDE", "IN_STATION_TRANSFER", "OUT_OF_STATION_TRANSFER"].includes(type)), []);
  const localRideEdges = input.routeEdges.filter(({ edgeType, serviceClass, servicePattern }) => (
    edgeType === "RIDE" && serviceClass === "SUBWAY" && servicePattern === "LOCAL"
  ));
  const itxRideEdges = input.routeEdges.filter(({ edgeType, serviceClass, servicePattern }) => (
    edgeType === "RIDE" && serviceClass === "ITX_CHEONGCHUN" && servicePattern === "EXPRESS"
  ));
  assert.equal(localRideEdges.length + itxRideEdges.length, counts.RIDE);
  assert.equal(
    canonicalRideEdgeSetSha256(localRideEdges),
    policy.rideInvariant.subwayLocal.admittedEdgeSetSha256,
  );
  assert.equal(
    canonicalRideEdgeSetSha256(itxRideEdges),
    policy.rideInvariant.itxCheongchunExpress.admittedEdgeSetSha256,
  );
  const evaluate = (values = {}) => evaluateRouteAccessibilityEdges({
    ...input,
    evaluationAt: observedAt,
    materialization,
    ...values,
  }, JSON.parse(policyBytes));
  assert.equal(evaluate().denominator.edgeCount, input.routeEdges.length);
  assert.throws(() => evaluate({ stationLines: [] }), /stationLines must be a non-empty array/);
  const staleOperatorMaterialization = structuredClone(materialization);
  staleOperatorMaterialization.rows[0].operatorId = "stale-operator";
  assert.throws(
    () => evaluate({ materialization: staleOperatorMaterialization }),
    /unmapped materialization row/,
  );
});

test("server-route-bundle은 current #8/#9 evidence를 accessibility bytes에만 결속한다", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "artifact-emitter-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const fixtureRoot = path.join(temp, "repository");
  for (const relative of ["contracts/datapack", "tools/datapack/release", "tools/datapack/schema", "tools/datapack/source-governance-policy.json", "tools/datapack/source-inventory.json", "release/product-gates/datapack-freshness-sla.json", "release/product-gates/route-edge-evaluation-policy.json", "tools/route-map/basemap-build-manifest.json", "tools/route-map/route-map-defs/svg-sources/easy-subway-sma-v4.svg"]) await cp(relative, path.join(fixtureRoot, relative), { recursive: true });
  await copySyntheticCurrentPublicRouteMapRepository(process.cwd(), fixtureRoot, {
    now: new Date(CURRENT_EVALUATION_AT),
  });
  const source = path.join(temp, "source.sqlite");
  const db = new DatabaseSync(source);
  db.exec(await readFile(path.join(fixtureRoot, "tools/datapack/schema/catalog-schema.sql"), "utf8"));
  db.exec("INSERT INTO operators VALUES('o1','운영사','Operator'); INSERT INTO lines(id,operator_id,name_ko,name_en,color) VALUES('l1','o1','1호선','Line 1','#123456'); INSERT INTO stations(id,name_ko,name_en,normalized_name,region) VALUES('s1','가역','Ga','가역','수도권'),('s2','나역','Na','나역','수도권'); INSERT INTO station_aliases(station_id,alias,normalized_alias) VALUES('s1','가','가'); INSERT INTO station_lines(station_id,line_id,line_sequence) VALUES('s1','l1',1),('s2','l1',2); INSERT INTO network_edges(id,from_node_id,to_node_id,duration_seconds,distance_meters,edge_type,service_pattern,service_class) VALUES('walkway-s1','s1:l1','s1:l1',0,0,'WALKWAY','','SUBWAY'),('ride-s1-s2','s1:l1','s2:l1',120,1000,'RIDE','LOCAL','SUBWAY'); INSERT INTO realtime_provider_line_mappings(provider_id,provider_line_id,line_id,source_id) VALUES('p','pl','l1','source'); INSERT INTO realtime_provider_station_mappings(provider_id,provider_line_id,provider_station_id,station_id,line_id,source_id) VALUES('p','pl','ps','s1','l1','source'); INSERT INTO station_pathway_nodes(id,station_id,line_id,node_type,label) VALUES('path-null','s1',NULL,'CONCOURSE','대합실'); INSERT INTO route_map_positions(station_id,line_id,region,x,y,label_dx,label_dy,label_polygon,up_path,down_path,source_id,source_name,source_url,license,license_status) VALUES('s1','l1','수도권',1,2,0,0,'raw polygon','','','source','source','https://example.test','license','PASS'),('s2','l1','수도권',3,4,0,0,'raw polygon','','','source','source','https://example.test','license','PASS'); INSERT INTO route_map_line_tracks(region,line_id,track_index,path,svg_color,source_id,source_name,source_url,license,license_status) VALUES('수도권','l1',1,'M0','#abcdef','source','source','https://example.test','license','PASS');");
  db.exec("UPDATE network_edges SET accessibility_status='UNAVAILABLE' WHERE id='ride-s1-s2'");
  db.exec("INSERT INTO station_exits(id,station_id,exit_number) VALUES('s1-exit-1','s1','1')");
  db.exec("INSERT INTO operators VALUES('seoul-metro','서울교통공사','Seoul Metro'); INSERT INTO lines(id,operator_id,name_ko,name_en,color) VALUES('seoul-2','seoul-metro','2호선','Line 2','#00aa00'); INSERT INTO stations(id,name_ko,name_en,normalized_name,region) VALUES('station-b35616704ce3','검증역','Terminal','검증역','수도권'); INSERT INTO station_lines(station_id,line_id,line_sequence) VALUES('station-b35616704ce3','seoul-2',1); INSERT INTO network_edges(id,from_node_id,to_node_id,duration_seconds,distance_meters,edge_type,service_pattern,service_class,accessibility_status) VALUES('walkway-terminal','station-b35616704ce3:seoul-2','station-b35616704ce3:seoul-2',0,0,'WALKWAY','','SUBWAY','AVAILABLE');");
  db.close();
  await cp("tools/datapack/source-candidates.json", path.join(fixtureRoot, "tools/datapack/source-candidates.json"));
  const stationElevatorPaths = await writeStationElevatorFixtureInputs(fixtureRoot, temp);
  const stationPlatformGaps = await writeStationPlatformGapFixtureInputs(fixtureRoot);
  // emit 입력 결속은 current.json이 선택한 active pack을 따른다(#866 PR-B).
  const current = { activePack: { id: "capital", version: "1" }, packs: [{ id: "capital", version: "1", artifactKind: "production", sqliteSha256: hash(await readFile(source)) }], expiresAt: CURRENT_SOURCE_EXPIRES_AT };
  await writeFile(path.join(temp, "current.json"), canonicalJson(current));
  const spec = await readFile(path.join(fixtureRoot, "tools/datapack/release/candidate-build-spec.json"));
  const buildSpec = JSON.parse(spec);
  const routePolicyPath = path.join(fixtureRoot, "release/product-gates/route-edge-evaluation-policy.json");
  const routePolicy = JSON.parse(await readFile(routePolicyPath, "utf8"));
  routePolicy.rideInvariant.itxCheongchunExpress.admittedEdgeSetSha256 = canonicalRideEdgeSetSha256([]);
  await writeFile(routePolicyPath, `${JSON.stringify(routePolicy, null, 2)}\n`);
  await writeFile(path.join(temp, "current.provenance.json"), canonicalJson({ schemaVersion: 1, artifactKind: "datapack-field-provenance", manifestSha256: hash(Buffer.from(canonicalJson(current))), packs: current.packs, candidateBuild: { buildSpecSha256: hash(spec) } }));
  const stationLineInput = completeStationLineInput(
    buildSpec.sourceSnapshotSetHash,
    buildSpec.candidateId,
  );
  const routeEdgeInput = completeRouteEdgeInput(
    buildSpec.sourceSnapshotSetHash,
    buildSpec.candidateId,
    stationLineInput.candidate.stationSetSha256,
  );
  routePolicy.rideInvariant.subwayLocal.admittedEdgeSetSha256 = canonicalRideEdgeSetSha256(
    routeEdgeInput.routeEdges.filter(({ edgeType, serviceClass, servicePattern }) => edgeType === "RIDE" && serviceClass === "SUBWAY" && servicePattern === "LOCAL"),
  );
  await writeFile(routePolicyPath, `${JSON.stringify(routePolicy, null, 2)}\n`);
  const releaseRun = (name, values = {}) => emitArtifactComponents({ repositoryRoot: fixtureRoot, sourceSqlite: source, sourceProvenance: path.join(temp, "current.provenance.json"), buildSpec: "tools/datapack/release/candidate-build-spec.json", output: path.join(temp, name), mapPackId: "map-v1", catalogPackId: "catalog-v1", bundleId: "bundle-v1", releaseSequence: "1", activeFrom: CURRENT_ACTIVE_FROM, freshUntil: CURRENT_FRESH_UNTIL, builtAt: CURRENT_EVALUATION_AT, keyId: "test-key", evaluationAt: CURRENT_EVALUATION_AT, stationLineInput, routeEdgeInput, ...values });
  const layout = JSON.parse(await readFile(path.join(fixtureRoot, "contracts/datapack/artifact-component-table-layout.json")));
  const serializationContract = JSON.parse(await readFile(path.join(fixtureRoot, "contracts/datapack/server-route-bundle-build-contract.json")));
  const sourceSchemaBytes = await readFile(path.join(fixtureRoot, "tools/datapack/schema/catalog-schema.sql"));
  const mapAssets = {
    basemapManifestBytes: await readFile(path.join(fixtureRoot, serializationContract.capitalMapInput.basemapManifestPath)),
    sourceSvgBytes: await readFile(path.join(fixtureRoot, serializationContract.capitalMapInput.sourcePath)),
  };
  // 직렬화 속성은 실제 승인 시각과 분리하고, 릴리스 진입점의 승인 검증은 아래에서 유지한다.
  const run = async (name, values = {}) => serializeArtifactComponents({
    output: path.join(temp, name), sourceBytes: await readFile(values.sourceSqlite ?? source), sourceSchemaBytes,
    sourceSchema: layout.serverRouteBundle.sourceSchema, layout,
    buildSpec, buildSpecBytes: spec, buildContract: serializationContract, mapAssets,
    ids: { mapPackId: "map-v1", catalogPackId: "catalog-v1", bundleId: "bundle-v1",
      releaseSequence: 1, activeFrom: CURRENT_ACTIVE_FROM, freshUntil: CURRENT_FRESH_UNTIL,
      builtAt: CURRENT_EVALUATION_AT, keyId: "test-key" },
    evaluationAt: CURRENT_EVALUATION_AT, stationLineInput, routeEdgeInput,
    routeEdgePolicy: routePolicy, stationElevatorPaths, stationPlatformGaps, ...values,
  });
  const selectedSources = new Set(buildSpec.sourceSnapshots.map(({ sourceId }) => sourceId));
  const governance = JSON.parse(await readFile(path.join(fixtureRoot, "tools/datapack/source-governance-policy.json")));
  const reviews = governance.sources.filter(({ sourceId }) => selectedSources.has(sourceId));
  assert.equal(reviews.length, selectedSources.size);
  const hasLaterApproval = reviews.some(({ licenseReview }) =>
    Date.parse(licenseReview.reviewedAt) > Date.parse(CURRENT_EVALUATION_AT));
  const applySourceSql = (sql) => { const mutation = new DatabaseSync(source); mutation.exec(sql); mutation.close(); };
  await writeFile(path.join(fixtureRoot, "tools/datapack/release/candidate-build-spec.json"), "{\"tampered\":true}");
  if (hasLaterApproval) {
    await assert.rejects(() => releaseRun("snapshotted", { buildSpecSnapshotBytes: spec }), /LICENSE_REVIEW_REQUIRED/);
    assert.equal(await exists(path.join(temp, "snapshotted")), false);
  } else {
    await releaseRun("snapshotted", { buildSpecSnapshotBytes: spec });
  }
  await writeFile(path.join(fixtureRoot, "tools/datapack/release/candidate-build-spec.json"), JSON.stringify({ ...buildSpec, candidateId: "unbound-candidate" }));
  await assert.rejects(() => releaseRun("unbound-spec"), /build spec identity mismatch/);
  assert.equal(await exists(path.join(temp, "unbound-spec")), false);
  await writeFile(path.join(fixtureRoot, "tools/datapack/release/candidate-build-spec.json"), spec);
  await assert.rejects(
    () => releaseRun("exceeds-manifest-expiry", { freshUntil: kstInstant(Date.parse(CURRENT_SOURCE_EXPIRES_AT) + 60_000) }),
    /--fresh-until exceeds source freshness/,
  );
  assert.equal(await exists(path.join(temp, "exceeds-manifest-expiry")), false);
  await assert.rejects(() => run("missing-elevator-input", { stationElevatorPaths: undefined }), /station elevator path input is required/);
  assert.equal(await exists(path.join(temp, "missing-elevator-input")), false);
  await assert.rejects(() => run("elevator-station-line-outside-bundle", {
    stationElevatorPaths: { ...stationElevatorPaths, facilities: stationElevatorPaths.facilities.map((facility) => ({ ...facility, stationId: "ghost" })) },
  }), /station elevator facility station-line is missing from bundle: ghost\/l1/);
  assert.equal(await exists(path.join(temp, "elevator-station-line-outside-bundle")), false);
  // #827: 연결 완전 경로가 없어 요구 행이 0개면 건너뛰지 않고 빌드를 실패시킨다.
  await assert.rejects(() => run("no-step-free-requirement", {
    stationElevatorPaths: { ...stationElevatorPaths, pathFacilities: stationElevatorPaths.pathFacilities.filter(({ group_kind: groupKind }) => groupKind === "EXIT") },
  }), /transition_facility_requirement is empty/);
  assert.equal(await exists(path.join(temp, "no-step-free-requirement")), false);
  const elevatorInputsPath = path.join(fixtureRoot, "tools/datapack/release/station-elevator-path-inputs.json");
  const elevatorInputs = await readFile(elevatorInputsPath);
  await rm(elevatorInputsPath);
  await assert.rejects(() => releaseRun("missing-elevator-manifest"), /station elevator path inputs is missing/);
  assert.equal(await exists(path.join(temp, "missing-elevator-manifest")), false);
  await writeFile(elevatorInputsPath, elevatorInputs);
  // #837: 승강장 연단 간격 입력이 없거나 결속되는 행이 하나도 없으면 건너뛰지 않고 빌드를 실패시킨다.
  await assert.rejects(() => run("missing-platform-gap-input", { stationPlatformGaps: undefined }), /station platform gap input is required/);
  assert.equal(await exists(path.join(temp, "missing-platform-gap-input")), false);
  await assert.rejects(() => run("platform-gap-nothing-bound", {
    stationPlatformGaps: {
      ...stationPlatformGaps,
      snapshot: { ...stationPlatformGaps.snapshot, rows: stationPlatformGaps.snapshot.rows.map((row) => ({ ...row, SBWY_STNS_CD: "0999" })) },
    },
  }), /station_platform_gaps is empty/);
  assert.equal(await exists(path.join(temp, "platform-gap-nothing-bound")), false);
  const platformGapInputsPath = path.join(fixtureRoot, "tools/datapack/release/station-platform-gap-inputs.json");
  const platformGapInputs = await readFile(platformGapInputsPath);
  await rm(platformGapInputsPath);
  await assert.rejects(() => releaseRun("missing-platform-gap-manifest"), /platform gap inputs is missing/);
  assert.equal(await exists(path.join(temp, "missing-platform-gap-manifest")), false);
  await writeFile(platformGapInputsPath, platformGapInputs);
  await run("one"); await run("two"); await run("three");
  const paths = await emittedPaths(path.join(temp, "one"));
  assert.deepEqual(paths, ["map-pack/manifest.json", "map-pack/payload/interchange-layout.json", "map-pack/payload/line-styles.json", "map-pack/payload/metropolitan.svg", "map-pack/payload/stations-layout.json", "server-route-bundle/compatibility.json", "server-route-bundle/manifest.signing-input.json", "server-route-bundle/payload/accessibility.sqlite.zst", "server-route-bundle/payload/fare.sqlite.zst", "server-route-bundle/payload/timetable.sqlite.zst", "server-route-bundle/payload/topology.sqlite.zst", "server-route-bundle/provenance.json", "station-catalog-pack/manifest.json", "station-catalog-pack/payload/catalog.sqlite"]);
  assert.deepEqual(await emittedPaths(path.join(temp, "two")), paths);
  assert.deepEqual(await emittedPaths(path.join(temp, "three")), paths);
  for (const file of paths) {
    assert.deepEqual(await readFile(path.join(temp, "one", file)), await readFile(path.join(temp, "two", file)), `two: ${file}`);
    assert.deepEqual(await readFile(path.join(temp, "one", file)), await readFile(path.join(temp, "three", file)), `three: ${file}`);
  }
  applySourceSql("DELETE FROM route_map_line_tracks");
  await writeBindings(temp, source, current, spec);
  await run("no-svg-color");
  assert.deepEqual(JSON.parse(await readFile(path.join(temp, "no-svg-color/map-pack/payload/line-styles.json"), "utf8")), [{ lineId: "l1", color: "#123456" }]);
  applySourceSql("INSERT INTO route_map_line_tracks(region,line_id,track_index,path,svg_color,source_id,source_name,source_url,license,license_status) VALUES('수도권','l1',1,'M0','#abcdef','source','source','https://example.test','license','PASS')");
  await writeBindings(temp, source, current, spec);
  applySourceSql("INSERT INTO route_map_line_tracks(region,line_id,track_index,path,svg_color,source_id,source_name,source_url,license,license_status) VALUES('수도권','l1',2,'M1','#fedcba','source','source','https://example.test','license','PASS')");
  await writeBindings(temp, source, current, spec);
  await assert.rejects(() => run("multiple-svg-colors"), /requires one svg color/);
  assert.equal(await exists(path.join(temp, "multiple-svg-colors")), false);
  applySourceSql("DELETE FROM route_map_line_tracks WHERE track_index=2");
  await writeBindings(temp, source, current, spec);
  for (const [name, mutate, pattern] of [
    ["route-seed-extra-topology", (seed) => { seed.candidate.topologySha256 = "f".repeat(64); }, /route-edge seed candidate keys mismatch/],
    ["route-seed-missing-version", (seed) => { delete seed.candidate.evaluatorVersion; }, /route-edge seed candidate keys mismatch/],
    ["route-seed-bundle-mismatch", (seed) => { seed.candidate.candidateId = "other-bundle"; }, /route-edge seed candidate identity mismatch/],
    ["route-seed-sequence-mismatch", (seed) => { seed.stationLines[1].lineSequence = 3; }, /route-edge station-line source projection mismatch/],
    ["route-seed-edge-value-mismatch", (seed) => {
      const edge = { ...seed.routeEdges[0] };
      delete edge.edgeSha256;
      edge.durationSeconds += 1;
      seed.routeEdges[0] = { ...edge, edgeSha256: routeEdgeSha256(edge) };
    }, /route-edge source projection mismatch/],
  ]) {
    const seed = structuredClone(routeEdgeInput);
    mutate(seed);
    await assert.rejects(() => run(name, { routeEdgeInput: seed }), pattern);
    assert.equal(await exists(path.join(temp, name)), false);
  }
  const operatorMismatch = structuredClone(stationLineInput);
  operatorMismatch.stationLines = operatorMismatch.stationLines.map((line) => ({ ...line, operatorId: "other-operator" }));
  operatorMismatch.evidenceRows = operatorMismatch.evidenceRows.map((row) => resealTerminalEvidence({
    ...row,
    operatorId: "other-operator",
  }));
  await assert.rejects(() => run("station-line-operator-mismatch", { stationLineInput: operatorMismatch }), /unmapped materialization row|terminal evidence tuple mismatch/);
  assert.equal(await exists(path.join(temp, "station-line-operator-mismatch")), false);
  const stationCandidateMismatch = structuredClone(stationLineInput);
  stationCandidateMismatch.candidate.candidateId = "other-candidate";
  await assert.rejects(
    () => run("station-line-candidate-mismatch", { stationLineInput: stationCandidateMismatch }),
    /station-line candidate identity mismatch/,
  );
  assert.equal(await exists(path.join(temp, "station-line-candidate-mismatch")), false);

  const routeStationSetMismatch = structuredClone(routeEdgeInput);
  routeStationSetMismatch.candidate.stationSetSha256 = "f".repeat(64);
  await assert.rejects(
    () => run("route-station-set-mismatch", { routeEdgeInput: routeStationSetMismatch }),
    /route-edge station-line candidate station set identity mismatch/,
  );
  assert.equal(await exists(path.join(temp, "route-station-set-mismatch")), false);

  applySourceSql("INSERT INTO lines(id,operator_id,name_ko,name_en,color) VALUES('l2','o1','2호선','Line 2','#654321'); INSERT INTO station_lines(station_id,line_id,line_sequence) VALUES('s1','l2',1)");
  await writeBindings(temp, source, current, spec);
  await assert.rejects(() => run("station-line-source-subset"), /route-edge station-line source projection mismatch/);
  assert.equal(await exists(path.join(temp, "station-line-source-subset")), false);
  applySourceSql("DELETE FROM station_lines WHERE line_id='l2'; DELETE FROM lines WHERE id='l2'");

  applySourceSql("INSERT INTO network_edges(id,from_node_id,to_node_id,duration_seconds,distance_meters,edge_type,service_pattern,service_class) VALUES('ride-s2-s1','s2:l1','s1:l1',120,1000,'RIDE','LOCAL','SUBWAY')");
  await writeBindings(temp, source, current, spec);
  await assert.rejects(() => run("route-edge-source-subset"), /route-edge source projection mismatch/);
  assert.equal(await exists(path.join(temp, "route-edge-source-subset")), false);
  applySourceSql("DELETE FROM network_edges WHERE id='ride-s2-s1'");
  await writeBindings(temp, source, current, spec);

  const stationLineInputPath = path.join(temp, "station-line-input.json");
  const routeEdgeInputPath = path.join(temp, "route-edge-input.json");
  const cliOutput = path.join(temp, "cli-output");
  await writeFile(stationLineInputPath, canonicalJson(stationLineInput));
  await writeFile(routeEdgeInputPath, canonicalJson(routeEdgeInput));
  const cli = spawnSync(process.execPath, [
    SCRIPT,
    "--source-sqlite", source,
    "--source-provenance", path.join(temp, "current.provenance.json"),
    "--build-spec", "tools/datapack/release/candidate-build-spec.json",
    "--output", cliOutput,
    "--map-pack-id", "map-v1",
    "--catalog-pack-id", "catalog-v1",
    "--bundle-id", "bundle-v1",
    "--release-sequence", "1",
    "--active-from", CURRENT_ACTIVE_FROM,
    "--fresh-until", CURRENT_FRESH_UNTIL,
    "--built-at", CURRENT_EVALUATION_AT,
    "--key-id", "test-key",
    "--evaluation-at", CURRENT_EVALUATION_AT,
    "--station-line-input", stationLineInputPath,
    "--route-edge-input", routeEdgeInputPath,
  ], { cwd: fixtureRoot, encoding: "utf8" });
  if (hasLaterApproval) {
    assert.equal(cli.status, 1, cli.stderr);
    assert.match(cli.stderr, /LICENSE_REVIEW_REQUIRED/);
    assert.equal(await exists(cliOutput), false);
  } else {
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(await emittedPaths(cliOutput), paths);
  }
  assert.deepEqual((await readdir(path.join(temp, "one"))).sort(), ["map-pack", "server-route-bundle", "station-catalog-pack"]);
  const mapRoot = path.join(temp, "one", "map-pack");
  const mapManifest = JSON.parse(await readFile(path.join(mapRoot, "manifest.json"), "utf8"));
  assert.equal(mapManifest.payloadSha256, await payloadDigest(mapRoot));
  assert.deepEqual(JSON.parse(await readFile(path.join(mapRoot, "payload/stations-layout.json"), "utf8")), [
    { stationId: "s1", lineId: "l1", region: "수도권", x: 1, y: 2, labelDx: 0, labelDy: 0, labelPolygon: "raw polygon", upPath: "", downPath: "" },
    { stationId: "s2", lineId: "l1", region: "수도권", x: 3, y: 4, labelDx: 0, labelDy: 0, labelPolygon: "raw polygon", upPath: "", downPath: "" },
  ]);
  assert.deepEqual(JSON.parse(await readFile(path.join(mapRoot, "payload/line-styles.json"), "utf8")), [{ lineId: "l1", color: "#abcdef" }]);
  assert.deepEqual(JSON.parse(await readFile(path.join(mapRoot, "payload/interchange-layout.json"), "utf8")), []);
  const catalogRoot = path.join(temp, "one", "station-catalog-pack");
  const catalogManifest = JSON.parse(await readFile(path.join(catalogRoot, "manifest.json"), "utf8"));
  assert.equal(catalogManifest.payloadSha256, await payloadDigest(catalogRoot));
  assert.equal((await readFile(path.join(catalogRoot, "payload/catalog.sqlite"))).readUInt32BE(96), 3053000);
  const catalog = new DatabaseSync(path.join(catalogRoot, "payload/catalog.sqlite"), { readOnly: true });
  assert.deepEqual(catalog.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name COLLATE BINARY").all().map((row) => row.name), ["lines", "station_aliases", "station_contacts", "station_lines", "stations"]);
  assert.deepEqual(catalog.prepare("PRAGMA table_info(stations)").all().map((column) => column.name), ["id", "name_ko", "name_en", "name_sub", "normalized_name", "region"]);
  assert.deepEqual(catalog.prepare("PRAGMA table_info(station_aliases)").all().map((column) => column.name), ["station_id", "alias", "normalized_alias"]);
  assert.deepEqual(catalog.prepare("PRAGMA table_info(lines)").all().map((column) => column.name), ["id", "name_ko", "name_en"]);
  assert.deepEqual(catalog.prepare("PRAGMA table_info(station_lines)").all().map((column) => column.name), ["station_id", "line_id", "station_code", "line_sequence"]);
  assert.deepEqual(catalog.prepare("PRAGMA table_info(station_contacts)").all().map((column) => column.name), ["station_id", "line_id", "phone", "phone_raw", "source_snapshot_id"]);
  assert.deepEqual(catalog.prepare("SELECT id,name_ko,name_en,name_sub,normalized_name,region FROM stations ORDER BY id").all().map((row) => ({ ...row })), [{ id: "s1", name_ko: "가역", name_en: "Ga", name_sub: "", normalized_name: "가역", region: "수도권" }, { id: "s2", name_ko: "나역", name_en: "Na", name_sub: "", normalized_name: "나역", region: "수도권" }, { id: "station-b35616704ce3", name_ko: "검증역", name_en: "Terminal", name_sub: "", normalized_name: "검증역", region: "수도권" }]);
  assert.equal(catalog.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('network_edges','transit_routes','transfer_rules','station_exits','fare_rules','operators')").all().length, 0);
  assert.equal(catalog.prepare("SELECT count(*) AS count FROM pragma_table_info('lines') WHERE name IN ('operator_id','color')").get().count, 0);
  catalog.close();
  const signingInput = JSON.parse(await readFile(path.join(temp, "one", "server-route-bundle/manifest.signing-input.json"), "utf8"));
  // #866 PR-C: route 범위는 승강장 전체(legacy 간선 대상 부분집합 없음)라 번들 역 집합과 같은 식별이다.
  // 다른 역 집합을 넣으면 거부되는지는 routeStationSetMismatch 회귀가 고정한다.
  assert.equal(signingInput.stationSetSha256, routeEdgeInput.candidate.stationSetSha256);
  assert.equal(signingInput.payloadSha256, await payloadDigest(path.join(temp, "one", "server-route-bundle")));
  const buildContract = JSON.parse(await readFile(path.join(fixtureRoot, "contracts/datapack/server-route-bundle-build-contract.json"), "utf8"));
  for (const metadata of ["provenance", "compatibility"]) {
    const value = JSON.parse(await readFile(path.join(temp, "one", `server-route-bundle/${metadata}.json`), "utf8"));
    assert.deepEqual(Object.keys(value).sort(), [...buildContract.metadata[metadata].exactFields].sort());
  }
  assert.equal(signingInput.provenanceSha256, hash(await readFile(path.join(temp, "one", "server-route-bundle/provenance.json"))));
  assert.equal(signingInput.compatibilitySha256, hash(await readFile(path.join(temp, "one", "server-route-bundle/compatibility.json"))));
  for (const component of ["topology", "timetable", "accessibility", "fare"]) assert.equal(signingInput[`${component}Sha256`], hash(await readFile(path.join(temp, "one", `server-route-bundle/payload/${component}.sqlite.zst`))));
  const sourceDb = new DatabaseSync(source, { readOnly: true });
  for (const component of ["topology", "timetable", "accessibility", "fare"]) {
    const sqlite = path.join(temp, `${component}.sqlite`);
    await writeFile(sqlite, zstdDecompressSync(await readFile(path.join(temp, "one", `server-route-bundle/payload/${component}.sqlite.zst`))));
    const componentDb = new DatabaseSync(sqlite, { readOnly: true });
    assert.equal(componentDb.prepare("PRAGMA user_version").get().user_version, 19);
    assert.deepEqual(componentDb.prepare("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(componentDb.prepare("SELECT * FROM artifact_component_identity").all().map((row) => ({ ...row })), [{ bundleId: "bundle-v1", releaseSequence: 1, stationSetSha256: signingInput.stationSetSha256, serviceTimezone: "Asia/Seoul" }]);
    assert.deepEqual(componentDb.prepare("PRAGMA table_info(stations)").all().map((column) => column.name), ["id"]);
    assert.deepEqual(componentDb.prepare("PRAGMA table_info(lines)").all().map((column) => column.name), ["id"]);
    assert.deepEqual(componentDb.prepare("PRAGMA table_info(station_lines)").all().map((column) => column.name), ["station_id", "line_id", "line_sequence"]);
    assert.equal(componentDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('route_map_positions','station_aliases','station_search_index')").all().length, 0);
    assert.deepEqual(componentDb.prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all(), []);
    // #866 PR-C: 역 단위 ENTRY/EXIT 대신 FACILITY를 요구하는 역-노선 WALKWAY로 terminal 차단을 확인한다.
    if (component === "topology") assert.deepEqual(componentDb.prepare("SELECT id, accessibility_status AS status FROM network_edges WHERE id IN ('walkway-terminal','ride-s1-s2','walkway-s1') ORDER BY id").all().map((row) => ({ ...row })), [{ id: "ride-s1-s2", status: "UNAVAILABLE" }, { id: "walkway-s1", status: "UNKNOWN" }, { id: "walkway-terminal", status: "UNAVAILABLE" }]);
    for (const table of ["stations", "station_lines"]) {
      assert.deepEqual(tablePrimaryKey(componentDb, table), tablePrimaryKey(sourceDb, table));
      assert.deepEqual(groupedForeignKeys(componentDb, table), groupedForeignKeys(sourceDb, table));
    }
    if (component === "accessibility") {
      const materialization = materializeStationLineAccessibility({ ...stationLineInput, observedAt: CURRENT_EVALUATION_AT });
      const evaluation = evaluateRouteAccessibilityEdges({
        ...routeEdgeInput,
        candidate: {
          ...routeEdgeInput.candidate,
          stationSetSha256: signingInput.stationSetSha256,
          topologySha256: signingInput.topologySha256,
        },
        evaluationAt: CURRENT_EVALUATION_AT,
        materialization,
      }, routePolicy);
      assert.equal(evaluation.results.find(({ edgeId }) => edgeId === "walkway-terminal").state, "BLOCKED");
      assert.equal(evaluation.results.find(({ edgeId }) => edgeId === "walkway-terminal").reason, "시설 존재·부재가 검증되지 않아 경로를 차단했습니다.");
      // EXIT terminal cell은 materialization에 남지만 어떤 경로 간선도 EXIT domain을 요구하지 않는다(#873).
      assert.equal(evaluation.results.some(({ materializationCells }) => materializationCells.some(({ domain }) => domain === "EXIT")), false);
      assert.deepEqual(componentDb.prepare("PRAGMA table_info(station_line_accessibility_evidence)").all().map((column) => column.name), ["materialization_digest", "canonical_json"]);
      assert.deepEqual(componentDb.prepare("PRAGMA table_info(route_accessibility_edge_evidence)").all().map((column) => column.name), ["evaluation_digest", "materialization_digest", "canonical_json"]);
      assert.deepEqual({ ...componentDb.prepare("SELECT * FROM station_line_accessibility_evidence").get() }, {
        materialization_digest: materialization.materializationDigest,
        canonical_json: canonicalStationLineAccessibilityJson(materialization),
      });
      assert.deepEqual({ ...componentDb.prepare("SELECT * FROM route_accessibility_edge_evidence").get() }, {
        evaluation_digest: evaluation.evaluationDigest,
        materialization_digest: materialization.materializationDigest,
        canonical_json: canonicalRouteEdgeEvaluationJson(evaluation),
      });
      // #834: 운영 빌드 경로가 fixture 역(가역 s1)의 엘리베이터 시설·이동경로·요구 묶음을 실제로 적재한다.
      assert.deepEqual(componentDb.prepare("SELECT id, station_id, exit_id, type, name, status, floor_from, floor_to, description, source_id, source_snapshot_id, provider_facility_ref, provenance_kind, status_meaning, operational_status, installation_status, confidence FROM facilities WHERE id LIKE 'smrt-elev:%' ORDER BY id COLLATE BINARY").all().map((row) => ({ ...row })), [{
        id: "smrt-elev:0201:2:1번 출입구", station_id: "s1", exit_id: "s1-exit-1", type: "ELEVATOR", name: "가역 엘리베이터 1번 출입구",
        status: "UNKNOWN", floor_from: "", floor_to: "", description: "1번 출입구", source_id: "seoul-metro-facility-location",
        source_snapshot_id: "seoul-metro-facility-location-20260930T000001000Z", provider_facility_ref: "0201:2:1번 출입구",
        provenance_kind: "OFFICIAL_SOURCE", status_meaning: "STATIC_LOCATION", operational_status: "UNKNOWN", installation_status: "INSTALLED", confidence: 100,
      }, {
        id: "smrt-elev:0201:2:나역 방면2-3", station_id: "s1", exit_id: null, type: "ELEVATOR", name: "가역 엘리베이터 나역 방면2-3",
        status: "UNKNOWN", floor_from: "", floor_to: "", description: "나역 방면2-3", source_id: "seoul-metro-facility-location",
        source_snapshot_id: "seoul-metro-facility-location-20260930T000001000Z", provider_facility_ref: "0201:2:나역 방면2-3",
        provenance_kind: "OFFICIAL_SOURCE", status_meaning: "STATIC_LOCATION", operational_status: "UNKNOWN", installation_status: "INSTALLED", confidence: 100,
      }]);
      assert.deepEqual(componentDb.prepare("SELECT * FROM station_elevator_path ORDER BY path_id, step").all().map((row) => ({ ...row })), [
        { path_id: "kric-mv:S1:2:201:202:1", station_id: "s1", line_id: "l1", next_station_id: "s2", exit_no: "1", platform_direction: "나역", step: 1, detail: "1) 1번 출입구 옆 엘리베이터로 이동" },
        { path_id: "kric-mv:S1:2:201:202:1", station_id: "s1", line_id: "l1", next_station_id: "s2", exit_no: "1", platform_direction: "나역", step: 2, detail: "2) 나역 방면 승강장 도착" },
      ]);
      assert.deepEqual(componentDb.prepare("SELECT * FROM station_elevator_path_facility ORDER BY group_kind, facility_id").all().map((row) => ({ ...row })), [
        { path_id: "kric-mv:S1:2:201:202:1", group_kind: "DIRECTION", facility_id: "smrt-elev:0201:2:나역 방면2-3" },
        { path_id: "kric-mv:S1:2:201:202:1", group_kind: "EXIT", facility_id: "smrt-elev:0201:2:1번 출입구" },
      ]);
      // #827: 운영 빌드 경로가 번들에 적재된 경로·시설 묶음에서 승강장 노드(s1:l1, #873)의 요구 행을 만든다.
      assert.deepEqual(componentDb.prepare("SELECT * FROM transition_facility_requirement ORDER BY transition_key, path_id, group_kind, facility_id").all().map((row) => ({ ...row })), [
        { transition_key: "s1:l1", path_id: "kric-mv:S1:2:201:202:1", direction_next_station_id: "s2", group_kind: "EXIT_ELEVATORS", facility_id: "smrt-elev:0201:2:1번 출입구" },
        { transition_key: "s1:l1", path_id: "kric-mv:S1:2:201:202:1", direction_next_station_id: "s2", group_kind: "PLATFORM_DIRECTION_ELEVATORS", facility_id: "smrt-elev:0201:2:나역 방면2-3" },
      ]);
      // #837: 운영 빌드 경로가 역코드 membership으로 결속한 승강장 연단 간격 등급 행을 적재한다(결속 실패 행은 제외).
      assert.deepEqual(componentDb.prepare("SELECT * FROM station_platform_gaps ORDER BY id").all().map((row) => ({ ...row })), [
        {
          id: "gap:s1:l1:DOWN:본선 1-2", station_id: "s1", line_id: "l1", direction: "DOWN", platform_position: "본선 1-2",
          car_number: 1, door_number: 2, gap_grade: "WIDE", height_diff_grade: "HIGH", curved: 1,
          source_snapshot_id: "seoul-metro-platform-gap-fixture",
        },
        {
          id: "gap:s1:l1:UP:본선 1-1", station_id: "s1", line_id: "l1", direction: "UP", platform_position: "본선 1-1",
          car_number: 1, door_number: 1, gap_grade: "NARROW", height_diff_grade: "LOW", curved: 0,
          source_snapshot_id: "seoul-metro-platform-gap-fixture",
        },
      ]);
    } else {
      assert.equal(componentDb.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('station_line_accessibility_evidence','route_accessibility_edge_evidence','station_elevator_path','station_elevator_path_facility','station_platform_gaps','transition_facility_requirement')").get().count, 0);
    }
    componentDb.close();
    assert.equal((await readFile(sqlite)).readUInt32BE(96), 3053000);
  }
  sourceDb.close();
  assert.equal(await exists(path.join(temp, "one", "server-route-bundle/manifest.json")), false);
  const allBytes = Buffer.concat(await Promise.all(paths.map((file) => readFile(path.join(temp, "one", file))))).toString("utf8");
  assert.doesNotMatch(allBytes, /"signature"|"probe"/);

  const walSource = path.join(temp, "wal-source.sqlite");
  await cp(source, walSource);
  const walWriter = new DatabaseSync(walSource);
  try {
    walWriter.exec("PRAGMA journal_mode=WAL; INSERT INTO stations(id,name_ko,name_en,normalized_name,region) VALUES('wal-only','WAL 역','WAL','wal','수도권')");
    await writeBindings(temp, walSource, current, spec);
    await run("wal", { sourceSqlite: walSource });
    const walCatalog = new DatabaseSync(path.join(temp, "wal/station-catalog-pack/payload/catalog.sqlite"), { readOnly: true });
    assert.equal(walCatalog.prepare("SELECT 1 FROM stations WHERE id='wal-only'").get(), undefined);
    walCatalog.close();
  } finally {
    walWriter.close();
  }
  await writeBindings(temp, source, current, spec);

  // 운영 snapshot을 재날인하지 않고 독립 입력으로 실제 릴리스 진입점까지 검증한다.
  const independent = await createIndependentSourceGovernanceFixture({ repositoryRoot: fixtureRoot, buildSpec });
  const independentSpec = Buffer.from(canonicalJson(independent.buildSpec));
  const snapshotPath = path.join(fixtureRoot, buildSpec.sourceSnapshotEvidencePath);
  const originalSnapshots = await readFile(snapshotPath);
  const independentExpiry = Math.min(...independent.snapshots.map(({ freshnessExpiresAt }) => Date.parse(freshnessExpiresAt)));
  const independentActiveAt = Date.parse(independent.evaluationAt);
  assert.ok(Number.isFinite(independentActiveAt) && independentActiveAt < independentExpiry);
  const independentCurrent = { ...current, expiresAt: new Date(independentExpiry).toISOString() };
  const temporalInputs = { activeFrom: kstInstant(independentActiveAt), builtAt: independent.evaluationAt, evaluationAt: independent.evaluationAt,
    freshUntil: kstInstant(independentExpiry) };
  try {
    await writeFile(snapshotPath, JSON.stringify(independent.snapshots));
    await writeFile(path.join(fixtureRoot, "tools/datapack/release/candidate-build-spec.json"), independentSpec);
    await writeBindings(temp, source, independentCurrent, independentSpec);
    await assert.rejects(() => releaseRun("late", { ...temporalInputs, freshUntil: kstInstant(independentExpiry + 1) }), /source freshness/);
    assert.equal(await exists(path.join(temp, "late")), false);

    const timezoneLessCurrent = { ...independentCurrent, expiresAt: independentCurrent.expiresAt.replace(/Z$/, "") };
    await writeBindings(temp, source, timezoneLessCurrent, independentSpec);
    await assert.rejects(() => releaseRun("timezone-less-current", temporalInputs), /current\.json\.expiresAt must be an RFC 3339 UTC timestamp/);
    assert.equal(await exists(path.join(temp, "timezone-less-current")), false);

    const overflowCurrent = { ...independentCurrent, expiresAt: "2026-02-30T15:00:00.000Z" };
    await writeBindings(temp, source, overflowCurrent, independentSpec);
    await assert.rejects(() => releaseRun("overflow-current", temporalInputs), /current\.json\.expiresAt must be an RFC 3339 UTC timestamp/);
    assert.equal(await exists(path.join(temp, "overflow-current")), false);
  } finally {
    await writeFile(snapshotPath, originalSnapshots);
    await writeFile(path.join(fixtureRoot, "tools/datapack/release/candidate-build-spec.json"), spec);
  }

  await writeBindings(temp, source, current, spec);
  await writeFile(path.join(temp, "current.provenance.json"), canonicalJson({ schemaVersion: 1, artifactKind: "datapack-field-provenance", manifestSha256: "0".repeat(64), packs: current.packs, candidateBuild: { buildSpecSha256: hash(spec) } }));
  await assert.rejects(() => releaseRun("rejected"), /raw current\.json/);
  assert.equal(await exists(path.join(temp, "rejected")), false);

  await writeBindings(temp, source, current, spec);
  const provenance = JSON.parse(await readFile(path.join(temp, "current.provenance.json"), "utf8"));
  provenance.packs[0].sqliteSha256 = "0".repeat(64);
  await writeFile(path.join(temp, "current.provenance.json"), canonicalJson(provenance));
  await assert.rejects(() => releaseRun("bad-provenance"), /source pack identity/);
  assert.equal(await exists(path.join(temp, "bad-provenance")), false);

  const missingPack = { ...current, packs: [] };
  await writeFile(path.join(temp, "current.json"), canonicalJson(missingPack));
  await writeFile(path.join(temp, "current.provenance.json"), canonicalJson({ schemaVersion: 1, artifactKind: "datapack-field-provenance", manifestSha256: hash(Buffer.from(canonicalJson(missingPack))), packs: current.packs, candidateBuild: { buildSpecSha256: hash(spec) } }));
  await assert.rejects(() => releaseRun("missing-pack"), /source pack identity/);
  assert.equal(await exists(path.join(temp, "missing-pack")), false);

  const duplicatePack = { ...current, packs: [...current.packs, { ...current.packs[0] }] };
  await writeFile(path.join(temp, "current.json"), canonicalJson(duplicatePack));
  await writeFile(path.join(temp, "current.provenance.json"), canonicalJson({ schemaVersion: 1, artifactKind: "datapack-field-provenance", manifestSha256: hash(Buffer.from(canonicalJson(duplicatePack))), packs: duplicatePack.packs, candidateBuild: { buildSpecSha256: hash(spec) } }));
  await assert.rejects(() => releaseRun("duplicate-pack"), /source pack identity/);
  assert.equal(await exists(path.join(temp, "duplicate-pack")), false);

  const mutate = (sql) => { const mutation = new DatabaseSync(source); mutation.exec("PRAGMA foreign_keys=OFF; " + sql); mutation.close(); };
  mutate("PRAGMA user_version=17");
  await writeBindings(temp, source, current, spec);
  await assert.rejects(() => run("bad-version"), /user_version/);
  assert.equal(await exists(path.join(temp, "bad-version")), false);
  mutate("PRAGMA user_version=19");

  mutate("INSERT INTO network_edges(id,from_node_id,to_node_id,edge_type,facility_id) VALUES('cross-component','s1','s1:l1','WALKWAY','missing-facility')");
  await writeBindings(temp, source, current, spec);
  await assert.rejects(() => run("bad-cross-component"), /cross-component reference mismatch/);
  assert.equal(await exists(path.join(temp, "bad-cross-component")), false);
  mutate("DELETE FROM network_edges WHERE id='cross-component'");

  mutate("INSERT INTO network_edges(id,from_node_id,to_node_id,edge_type) VALUES('unknown-walkway','','s1','WALKWAY')");
  await writeBindings(temp, source, current, spec);
  await assert.rejects(() => run("bad-endpoint"), /invalid network endpoint/);
  assert.equal(await exists(path.join(temp, "bad-endpoint")), false);
  mutate("DELETE FROM network_edges WHERE id='unknown-walkway'");

  // #866 PR-C: 역 끝점(ENTRY/EXIT 모양)은 방향과 무관하게 거부한다. 예전에 허용되던 정방향 ENTRY도 실패한다.
  mutate("INSERT INTO network_edges(id,from_node_id,to_node_id,edge_type) VALUES('forward-entry','s1','s1:l1','ENTRY')");
  await writeBindings(temp, source, current, spec);
  await assert.rejects(() => run("forward-entry"), /network edge endpoint mismatch/);
  assert.equal(await exists(path.join(temp, "forward-entry")), false);
  mutate("DELETE FROM network_edges WHERE id='forward-entry'");
  mutate("INSERT INTO network_edges(id,from_node_id,to_node_id,edge_type) VALUES('reversed-entry','s1:l1','s1','ENTRY')");
  await writeBindings(temp, source, current, spec);
  await assert.rejects(() => run("reversed-entry"), /network edge endpoint mismatch/);
  assert.equal(await exists(path.join(temp, "reversed-entry")), false);
  mutate("DELETE FROM network_edges WHERE id='reversed-entry'");

  mutate("INSERT INTO network_edges(id,from_node_id,to_node_id,edge_type) VALUES('station-walkway','s1','s1:l1','WALKWAY')");
  await writeBindings(temp, source, current, spec);
  await assert.rejects(() => run("station-walkway"), /network edge endpoint mismatch/);
  assert.equal(await exists(path.join(temp, "station-walkway")), false);
  mutate("DELETE FROM network_edges WHERE id='station-walkway'");

  mutate("INSERT INTO station_aliases(station_id,alias,normalized_alias) VALUES('orphan','고아','고아')");
  await writeBindings(temp, source, current, spec);
  const beforeOrphanTemps = await taskTemps(temp);
  await assert.rejects(() => run("orphan-alias"), /source foreign key mismatch/);
  assert.equal(await exists(path.join(temp, "orphan-alias")), false);
  assert.deepEqual(await taskTemps(temp), beforeOrphanTemps);
  mutate("DELETE FROM station_aliases WHERE station_id='orphan'");

  mutate("ALTER TABLE network_edges ADD COLUMN schema_drift TEXT");
  await writeBindings(temp, source, current, spec);
  const beforeSchemaDriftTemps = await taskTemps(temp);
  await assert.rejects(() => run("schema-drift"), /source schema mismatch/);
  assert.equal(await exists(path.join(temp, "schema-drift")), false);
  assert.deepEqual(await taskTemps(temp), beforeSchemaDriftTemps);

  const occupied = path.join(temp, "occupied");
  await writeFile(occupied, "marker");
  const beforeTemps = await taskTemps(temp);
  await assert.rejects(() => releaseRun("occupied"), /must not already exist/);
  assert.equal(await readFile(occupied, "utf8"), "marker");
  assert.deepEqual(await taskTemps(temp), beforeTemps);
});

function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function completeStationLineInput(sourceSetSha256, candidateId) {
  const evaluationAt = Date.parse(CURRENT_EVALUATION_AT);
  const capturedAt = new Date(evaluationAt - 60_000).toISOString();
  const freshUntil = new Date(evaluationAt + 24 * 60 * 60 * 1_000).toISOString();
  const candidate = {
    candidateId,
    // #866 PR-C: materialization 분모는 route stationLines 전체다(legacy 간선 대상 집합 분기 삭제). s2도 포함한다.
    stationSetSha256: hash(Buffer.from(canonicalJson(["s1", "s2", "station-b35616704ce3"]))),
    sourceSetSha256,
    mappingContractVersion: "station-line-v1",
    materializerVersion: "1",
  };
  const stationLines = [
    { stationId: "s1", lineId: "l1", operatorId: "o1" },
    { stationId: "s2", lineId: "l1", operatorId: "o1" },
    { stationId: "station-b35616704ce3", lineId: "seoul-2", operatorId: "seoul-metro" },
  ];
  const evidenceRows = stationLines.filter(({ stationId }) => stationId !== "station-b35616704ce3").flatMap((line) => ["FACILITY", "EXIT", "TRANSFER"].map((domain) => ({
    ...candidate,
    ...line,
    domain,
    state: domain === "TRANSFER" ? "NOT_APPLICABLE" : "VERIFIED_PRESENT",
    sourceId: "fixture-source",
    sourceSnapshotId: "fixture-snapshot",
    evidenceRawSha256: "a".repeat(64),
    providerRecordHash: "b".repeat(64),
    capturedAt,
    freshUntil,
    provenanceId: "fixture-provenance",
    licenseId: "fixture-license",
    mappingContractVersion: candidate.mappingContractVersion,
    materializerVersion: candidate.materializerVersion,
    evidenceKind: domain === "TRANSFER" ? "CURRENT_APPLICABILITY_RULE" : "OBSERVED",
    evidenceReason: domain === "TRANSFER" ? "no transfer boundary" : "official current evidence",
  })));
  const terminal = ["ELEVATOR", "ESCALATOR", "WHEELCHAIR_LIFT"].map((facilityType) => ({ ...candidate, stationId: "station-b35616704ce3", lineId: "seoul-2", operatorId: "seoul-metro", domain: "FACILITY", state: "UNVERIFIED_EVIDENCE_BLOCKED", sourceId: "kric-station-convenience-standard", sourceSnapshotId: "fixture-terminal-snapshot", evidenceRawSha256: "a".repeat(64), providerRecordHash: null, capturedAt, freshUntil, provenanceId: "fixture-provenance", licenseId: "fixture-license", mappingContractVersion: candidate.mappingContractVersion, materializerVersion: candidate.materializerVersion, evidenceKind: "UNVERIFIED_EVIDENCE_BLOCKED", evidenceReason: "시설 존재·부재가 검증되지 않아 경로를 차단했습니다.", facilityType, terminalPolicy: "EXACT_TUPLE_PROVIDER_RESULT_03", providerResultCode: "03", strictRouteEligible: false, strictRouteEligibleReason: "UNVERIFIED_PROVIDER_EVIDENCE_BLOCKED", installationStatus: "UNKNOWN", operationalStatus: "UNKNOWN", statusMeaning: "PROVIDER_RESULT_UNVERIFIED", confidence: 0, providerResponseSha256: "c".repeat(64), evidenceHash: hash(Buffer.from(canonicalJson({ sourceSnapshotId: "fixture-terminal-snapshot", stationId: "station-b35616704ce3", lineId: "seoul-2", operatorId: "seoul-metro", facilityType, terminalPolicy: "EXACT_TUPLE_PROVIDER_RESULT_03", providerResponseSha256: "c".repeat(64) }))) }));
  const exitTerminal = { ...candidate, stationId: "station-b35616704ce3", lineId: "seoul-2", operatorId: "seoul-metro", domain: "EXIT", state: "UNVERIFIED_EVIDENCE_BLOCKED", sourceId: "kric-station-movement-standard", sourceSnapshotId: "fixture-exit-snapshot", evidenceRawSha256: "d".repeat(64), providerRecordHash: null, capturedAt, freshUntil, provenanceId: "fixture-provenance", licenseId: "fixture-license", mappingContractVersion: candidate.mappingContractVersion, materializerVersion: candidate.materializerVersion, evidenceKind: "UNVERIFIED_EVIDENCE_BLOCKED", evidenceReason: "출구 이동경로가 검증되지 않아 경로를 차단했습니다.", terminalPolicy: "PROVIDER_NO_DATA_RESULT_03_BLOCKED", providerResultCode: "03", strictRouteEligible: false, strictRouteEligibleReason: "UNVERIFIED_PROVIDER_EVIDENCE_BLOCKED", statusMeaning: "PROVIDER_NO_DATA_NOT_ABSENCE", confidence: 0, providerResponseSha256: "9".repeat(64), evidenceHash: hash(Buffer.from(canonicalJson({ sourceSnapshotId: "fixture-exit-snapshot", stationId: "station-b35616704ce3", lineId: "seoul-2", operatorId: "seoul-metro", domain: "EXIT", terminalPolicy: "PROVIDER_NO_DATA_RESULT_03_BLOCKED", providerResponseSha256: "9".repeat(64) }))) };
  return { candidate, stationLines, evidenceRows: [...evidenceRows, ...terminal, exitTerminal] };
}
function resealTerminalEvidence(row) {
  if (row.state !== "UNVERIFIED_EVIDENCE_BLOCKED") return row;
  return {
    ...row,
    evidenceHash: hash(Buffer.from(canonicalJson({
      sourceSnapshotId: row.sourceSnapshotId,
      stationId: row.stationId,
      lineId: row.lineId,
      operatorId: row.operatorId,
      ...(row.domain === "FACILITY" ? { facilityType: row.facilityType } : { domain: row.domain }),
      terminalPolicy: row.terminalPolicy,
      providerResponseSha256: row.providerResponseSha256,
    }))),
  };
}
function completeRouteEdgeInput(sourceSetSha256, candidateId, stationSetSha256) {
  const rawEdges = [
    { edgeId: "walkway-s1", edgeType: "WALKWAY", fromNodeId: "s1:l1", toNodeId: "s1:l1", durationSeconds: 0, distanceMeters: 0, servicePattern: "", serviceClass: "SUBWAY" },
    { edgeId: "ride-s1-s2", edgeType: "RIDE", fromNodeId: "s1:l1", toNodeId: "s2:l1", durationSeconds: 120, distanceMeters: 1000, servicePattern: "LOCAL", serviceClass: "SUBWAY" },
    { edgeId: "walkway-terminal", edgeType: "WALKWAY", fromNodeId: "station-b35616704ce3:seoul-2", toNodeId: "station-b35616704ce3:seoul-2", durationSeconds: 0, distanceMeters: 0, servicePattern: "", serviceClass: "SUBWAY" },
  ];
  return {
    candidate: {
      candidateId,
      stationSetSha256,
      sourceSetSha256,
      policyVersion: "route-edge-evaluation-v2",
      evaluatorVersion: "1",
    },
    stationLines: [
      { stationId: "s1", lineId: "l1", operatorId: "o1", lineSequence: 1 },
    { stationId: "s2", lineId: "l1", operatorId: "o1", lineSequence: 2 },
    { stationId: "station-b35616704ce3", lineId: "seoul-2", operatorId: "seoul-metro", lineSequence: 1 },
    ],
    routeEdges: rawEdges.map((edge) => ({ ...edge, edgeSha256: routeEdgeSha256(edge) })),
  };
}
async function payloadDigest(artifact) {
  const payload = path.join(artifact, "payload");
  const inventory = [];
  for (const name of await readdir(payload)) {
    const bytes = await readFile(path.join(payload, name));
    inventory.push({ path: `payload/${name}`, sizeBytes: bytes.length, sha256: hash(bytes) });
  }
  return hash(Buffer.from(canonicalJson(inventory.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))))));
}
async function writeBindings(temp, source, current, spec) {
  const sourceHash = hash(await readFile(source));
  const bound = { ...current, packs: current.packs.map((pack) => ({ ...pack, sqliteSha256: sourceHash })) };
  await writeFile(path.join(temp, "current.json"), canonicalJson(bound));
  await writeFile(path.join(temp, "current.provenance.json"), canonicalJson({ schemaVersion: 1, artifactKind: "datapack-field-provenance", manifestSha256: hash(Buffer.from(canonicalJson(bound))), packs: bound.packs, candidateBuild: { buildSpecSha256: hash(spec) } }));
}
function tablePrimaryKey(db, table) { return db.prepare(`PRAGMA table_info(${table})`).all().filter((column) => column.pk).map((column) => ({ name: column.name, pk: column.pk })); }
function groupedForeignKeys(db, table) { const groups = new Map(); for (const row of db.prepare(`PRAGMA foreign_key_list(${table})`).all()) { const value = groups.get(row.id) ?? { table: row.table, from: [], to: [], onUpdate: row.on_update, onDelete: row.on_delete, match: row.match }; value.from[row.seq] = row.from; value.to[row.seq] = row.to; groups.set(row.id, value); } return [...groups.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))); }
async function taskTemps(temp) { return (await readdir(temp)).filter((entry) => entry.startsWith(".artifact-components-")).sort(); }
async function exists(target) { try { await readFile(target); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
async function emittedPaths(root, current = root, paths = []) { for (const entry of await readdir(current, { withFileTypes: true })) { const target = path.join(current, entry.name); if (entry.isDirectory()) await emittedPaths(root, target, paths); else paths.push(path.relative(root, target).split(path.sep).join("/")); } return paths.sort(); }

// #834 fixture: 원천 응답 형식을 손으로 옮긴 가역(S1 2호선 201)·나역(202) stationMovement와 getFcElvtr 응답을
// 실제 수집기에 흘려 snapshot·raw 보관본·manifest를 만들고, 번들 입력 manifest를 fixture repository에 고정한다.
async function writeStationElevatorFixtureInputs(fixtureRoot, temp) {
  const sources = path.join(fixtureRoot, "tools/datapack/sources");
  await mkdir(sources, { recursive: true });
  const stationLines = [["s1", "가역", "201"], ["s2", "나역", "202"]].map(([stationId, stationName]) => ({
    stationId, stationName, stationAliases: [], regionId: "capital", lineId: "l1", lineName: "1호선", operatorId: "o1", operatorName: "운영사",
  }));
  const providerMappings = [["s1", "201"], ["s2", "202"]].map(([stationId, providerStationId]) => ({
    stationId, lineId: "l1", providerOperatorId: "S1", providerLineId: "2", providerStationId,
  }));
  const routeEdges = [["ride-s1-s2", "s1", "s2"], ["ride-s2-s1", "s2", "s1"]].map(([routeEdgeId, fromStationId, toStationId]) => ({
    routeEdgeId, fromStationId, toStationId, lineId: "l1", edgeType: "RIDE", servicePattern: "LOCAL", serviceClass: "SUBWAY",
  }));
  const digest = (value) => hash(Buffer.from(canonicalJson(value)));
  const plan = planKricExitPathCollection({
    candidate: {
      candidateId: "fixture-elevator-candidate",
      stationSetSha256: digest(["s1", "s2"]),
      stationLineSetSha256: digest(stationLines.map(({ stationId, lineId, operatorId }) => ({ stationId, lineId, operatorId }))),
      stationLineMappingSha256: digest(stationLines),
      providerMappingSha256: digest(providerMappings),
      topologySha256: digest([...routeEdges].sort((left, right) => left.routeEdgeId.localeCompare(right.routeEdgeId))),
    },
    stationLines,
    providerMappings,
    routeEdges,
  });
  const row = (exitMvTpOrdr, mvContDtl) => ({
    edMovePath: "나역 방면", elvtSttCd: null, elvtTpCd: null, exitMvTpOrdr, imgPath: "", mvContDtl, mvPathMgNo: 1, stMovePath: "1번 출입구 옆 엘리베이터",
  });
  const bodies = new Map([
    ["201", JSON.stringify({ header: { resultCnt: 2, resultCode: "00", resultMsg: "정상 처리되었습니다." }, body: [row(1, "1) 1번 출입구 옆 엘리베이터로 이동"), row(2, "2) 나역 방면 승강장 도착")] })],
    ["202", JSON.stringify({ header: { resultCode: "03", resultMsg: "데이터가 없습니다." } })],
  ]);
  const rawResponses = [];
  const movementSnapshot = await collectKricExitPathProviderSnapshot({
    collectionPlan: plan,
    sourceId: "kric-station-movement-standard",
    serviceKey: "fixture-kric-key-never-output",
    fetchImpl: async (url) => new Response(bodies.get(new URL(url).searchParams.get("stinCd")), { status: 200 }),
    now: new Date("2026-09-30T00:00:00.000Z"),
    onRawResponse: (entry) => rawResponses.push(entry),
  });
  const movementSnapshotBytes = Buffer.from(canonicalKricExitPathProviderSnapshotJson(movementSnapshot));
  const movementRawBytes = Buffer.from(JSON.stringify(buildKricExitPathRawCollection({ snapshot: movementSnapshot, rawResponses })));
  const movementObservation = buildKricExitPathObservation({
    snapshot: movementSnapshot, snapshotBytes: movementSnapshotBytes, rawCollectionBytes: movementRawBytes,
  });
  const facilityBody = JSON.stringify({ response: { header: { resultCode: "00" }, body: { totalCount: 2, items: { item: [
    { lineNm: "2호선", stnNm: "가역", stnCd: "0201", oprtngSitu: "M", dtlPstn: "1번 출입구" },
    { lineNm: "2호선", stnNm: "가역", stnCd: "0201", oprtngSitu: "M", dtlPstn: "나역 방면2-3" },
  ] } } } });
  const facilityObservationRoot = path.join(temp, "facility-location-observation");
  const facilityObservation = await writeSeoulAccessibilityObservation({
    outputRoot: facilityObservationRoot,
    source: "facility-location",
    observation: await collectSeoulAccessibilityObservation({
      source: "facility-location",
      serviceKey: "secret-must-not-appear",
      retrievedAt: "2026-09-30T00:00:01.000Z",
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => facilityBody }),
    }),
  });
  const files = {
    [`${movementSnapshot.snapshotId}.json`]: movementSnapshotBytes,
    [`${movementSnapshot.snapshotId}.raw.json`]: movementRawBytes,
    [`${movementSnapshot.snapshotId}.observation.json`]: Buffer.from(`${JSON.stringify(movementObservation, null, 2)}\n`),
    [facilityObservation.snapshotFile]: await readFile(path.join(facilityObservationRoot, facilityObservation.snapshotFile)),
    [facilityObservation.rawArtifactFile]: await readFile(path.join(facilityObservationRoot, facilityObservation.rawArtifactFile)),
    [`${facilityObservation.snapshotId}.observation.json`]: await readFile(path.join(facilityObservationRoot, "observation.json")),
    "kric-station-convenience-standard-fixture.json": Buffer.from(JSON.stringify({
      sourceId: "kric-station-convenience-standard",
      artifactKind: "kric-accessibility-snapshot",
      queries: providerMappings.map(({ stationId, lineId, providerOperatorId, providerLineId, providerStationId }) => ({
        stationId, lineId, railOprIsttCd: providerOperatorId, lnCd: providerLineId, stinCd: providerStationId,
        canonicalMappings: [{ artifactId: "bundled-capital", stationId, lineId }],
      })),
    })),
  };
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(sources, name), bytes);
  const entry = (sourceId, snapshotId) => ({
    sourceId,
    observationPath: `tools/datapack/sources/${snapshotId}.observation.json`,
    observationSha256: hash(files[`${snapshotId}.observation.json`]),
    snapshotPath: `tools/datapack/sources/${snapshotId}.json`,
    snapshotSha256: hash(files[`${snapshotId}.json`]),
    rawCollectionPath: `tools/datapack/sources/${snapshotId}.raw.json`,
    rawCollectionSha256: hash(files[`${snapshotId}.raw.json`]),
  });
  await writeFile(path.join(fixtureRoot, "tools/datapack/release/station-elevator-path-inputs.json"), `${JSON.stringify({
    schemaVersion: 1,
    artifactKind: "station-elevator-path-inputs",
    issue: 834,
    movement: entry("kric-station-movement-standard", movementSnapshot.snapshotId),
    facilityLocation: entry("seoul-metro-facility-location", facilityObservation.snapshotId),
    canonicalMapping: {
      sourceId: "kric-station-convenience-standard",
      snapshotPath: "tools/datapack/sources/kric-station-convenience-standard-fixture.json",
      snapshotSha256: hash(files["kric-station-convenience-standard-fixture.json"]),
    },
  }, null, 2)}\n`);
  return loadStationElevatorPathInputs({ repositoryRoot: fixtureRoot });
}

// #837 fixture: 가역(0201, 2호선 → 번들 l1) 연단 간격 등급 스냅샷과 그 역코드 membership을 fixture repository에 고정한다.
async function writeStationPlatformGapFixtureInputs(fixtureRoot) {
  const sources = path.join(fixtureRoot, "tools/datapack/sources");
  await mkdir(sources, { recursive: true });
  const realMembership = JSON.parse(await readFile("tools/datapack/sources/seoul-station-code-membership-20260909T041501Z.json", "utf8"));
  const realCsv = Buffer.from(realMembership.snapshot.rawBytesBase64, "base64");
  const header = realCsv.subarray(0, realCsv.indexOf(0x0a) + 1);
  const csvBytes = Buffer.concat([header, Buffer.from("0201,GA,GA,2,201,,\n")]);
  const membershipSnapshot = collectSeoulStationLineInfo({ csvBytes, capturedAt: "2026-09-30T00:00:00.000Z" });
  const records = [{
    regionId: "capital", operatorId: "seoul-metro", lineId: "l1", canonicalStationName: "가역",
    sourceStationCode: "0201", externalStationCode: "201", sourceRowSha256: hash(Buffer.from(JSON.stringify(membershipSnapshot.rows[0]))),
  }];
  const membership = {
    schemaVersion: 1, artifactKind: "seoul-station-code-membership-binding", sourceId: "seoulmetro-station-line-info",
    capturedAt: membershipSnapshot.capturedAt, snapshot: membershipSnapshot, records,
    recordsSha256: hash(Buffer.from(JSON.stringify(records))),
  };
  const membershipBytes = Buffer.from(`${JSON.stringify(membership, null, 2)}\n`);
  const gapRow = (overrides) => ({
    LINE: "2호선", SBWY_STNS_OTSD_CD: "201", SBWY_STNS_CD: "0201", SBWY_STNS_NM: "가역", UPLN_DNLN: "상선",
    PLF_PSTN: "본선 1-1", TRN_PLF_INTVL: "좁음", HGT_DIFF: "낮음", PLF_LNR: "직선", ...overrides,
  });
  const rows = [
    gapRow({}),
    gapRow({ UPLN_DNLN: "하선", PLF_PSTN: "본선 1-2", TRN_PLF_INTVL: "넓음", HGT_DIFF: "높음", PLF_LNR: "곡선" }),
    gapRow({ SBWY_STNS_CD: "0999", SBWY_STNS_OTSD_CD: "999", SBWY_STNS_NM: "미결속역" }),
  ];
  const rawBytes = Buffer.from(JSON.stringify({ pages: [{ start: 1, end: rows.length, sanitizedJson: { TbSubwayLineInfo: { row: rows } } }] }));
  const snapshot = {
    schemaVersion: 1, artifactKind: "seoul-platform-gap-snapshot", sourceId: "seoul-metro-platform-gap",
    snapshotId: "seoul-metro-platform-gap-fixture", capturedAt: "2026-09-30T00:00:00.000Z", rowCount: rows.length,
    rawSha256: hash(rawBytes), contentSha256: hash(Buffer.from(JSON.stringify(rows))), rows,
  };
  const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
  await writeFile(path.join(sources, "seoul-metro-platform-gap-fixture.json"), snapshotBytes);
  await writeFile(path.join(sources, "seoul-metro-platform-gap-fixture.raw.json"), rawBytes);
  await writeFile(path.join(sources, "seoul-station-code-membership-fixture.json"), membershipBytes);
  await writeFile(path.join(fixtureRoot, "tools/datapack/release/station-platform-gap-inputs.json"), `${JSON.stringify({
    schemaVersion: 1, artifactKind: "station-platform-gap-inputs", issue: 837,
    platformGap: {
      sourceId: "seoul-metro-platform-gap",
      snapshotPath: "tools/datapack/sources/seoul-metro-platform-gap-fixture.json", snapshotSha256: hash(snapshotBytes),
      rawCollectionPath: "tools/datapack/sources/seoul-metro-platform-gap-fixture.raw.json", rawCollectionSha256: hash(rawBytes),
    },
    stationCodeMembership: {
      sourceId: "seoulmetro-station-line-info",
      snapshotPath: "tools/datapack/sources/seoul-station-code-membership-fixture.json", snapshotSha256: hash(membershipBytes),
    },
  }, null, 2)}\n`);
  // fixture 스냅샷도 운영과 같은 승격 게이트를 통과해야 하므로 승인 기록의 해시를 fixture 스냅샷에 맞춘다.
  const candidatesPath = path.join(fixtureRoot, "tools/datapack/source-candidates.json");
  const candidates = JSON.parse(await readFile(candidatesPath, "utf8"));
  const admission = candidates.candidates.find(({ id }) => id === "seoul-metro-platform-gap").evidence.productionUseAdmission;
  admission.rawSha256 = snapshot.rawSha256;
  admission.contentSha256 = snapshot.contentSha256;
  await writeFile(candidatesPath, JSON.stringify(candidates, null, 2));
  return loadStationPlatformGapInputs({ repositoryRoot: fixtureRoot });
}

// AquilaXk/easysubway-backend#480: 계단 정보가 없는 동선을 includes_stairs=0으로 "계단 없음"이라 주장하지 않는다.
// SQLite 계약(catalog-schema.sql network_edges.includes_stairs INTEGER NOT NULL, 모바일 Drift bool)은 null을 담을 수 없다.
// 그래서 stair_access_state(STEP_FREE·STAIR_ONLY·UNKNOWN)를 기준값으로 삼는다.
// includes_stairs는 "확인된 계단(STAIR_ONLY)"일 때만 1이다. 계단 없음은 STEP_FREE로만 표현한다.
test("서버 번들 network_edges의 계단 칸은 stair_access_state에서만 유도하고 미확인은 UNKNOWN으로 드러낸다", () => {
  const columns = (edge) => nationwideTopologyEdgeStairColumns({ edgeId: "edge-x", ...edge });
  // 원천에 계단 정보가 없는 전국 route-edge 입력 행(현재 환승 309개·RIDE 2182개 전부)
  assert.deepEqual(columns({}), { includesStairs: 0, stairAccessState: "UNKNOWN" });
  assert.deepEqual(columns({ stairAccessState: "STAIR_ONLY" }), { includesStairs: 1, stairAccessState: "STAIR_ONLY" });
  assert.deepEqual(columns({ stairAccessState: "STEP_FREE" }), { includesStairs: 0, stairAccessState: "STEP_FREE" });
  assert.deepEqual(columns({ includesStairs: true }), { includesStairs: 1, stairAccessState: "STAIR_ONLY" });
  // includesStairs=false는 계단 없음 근거가 아니다. 상태가 없으면 UNKNOWN으로 남긴다.
  assert.deepEqual(columns({ includesStairs: false }), { includesStairs: 0, stairAccessState: "UNKNOWN" });
  // 계단 여부와 상태가 서로 어긋나거나 상태 값이 계약 밖이면 번들을 만들지 않는다.
  for (const edge of [
    { includesStairs: true, stairAccessState: "UNKNOWN" },
    { includesStairs: true, stairAccessState: "STEP_FREE" },
    { includesStairs: false, stairAccessState: "STAIR_ONLY" },
    { stairAccessState: "NO_STAIRS" },
    { includesStairs: "false" },
  ]) {
    assert.throws(() => columns(edge), /network edge stair state is invalid: edge-x/u);
  }
});

// 리뷰 F1(#923): 계단 칸 규칙은 서버 번들 network_edges를 실제로 채우는 호출부를 통과해야 한다.
test("서버 번들 topology network_edges 행은 stair_access_state 기준 계단 칸으로 기록되고 어긋난 입력은 거부된다", async () => {
  const schema = await readFile(path.join(import.meta.dirname, "schema/catalog-schema.sql"), "utf8");
  const ddl = /CREATE TABLE network_edges \([\s\S]*?\n\);/u.exec(schema)?.[0];
  assert.ok(ddl, "catalog-schema network_edges DDL");
  const edge = (edgeId, stair) => ({
    edgeId, fromNodeId: `${edgeId}-a:line-x`, toNodeId: `${edgeId}-b:line-x`, durationSeconds: 60, distanceMeters: 80,
    edgeType: "IN_STATION_TRANSFER", ...stair,
  });
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(ddl);
    populateNationwideTopologyEdges(database, [
      edge("edge-stair", { includesStairs: true, stairAccessState: "STAIR_ONLY" }),
      edge("edge-step-free", { includesStairs: false, stairAccessState: "STEP_FREE" }),
      edge("edge-unknown", { includesStairs: false }),
      edge("edge-absent", {}),
    ]);
    assert.deepEqual(database.prepare("SELECT id, includes_stairs, stair_access_state FROM network_edges ORDER BY id").all()
      .map((row) => ({ ...row })), [
      { id: "edge-absent", includes_stairs: 0, stair_access_state: "UNKNOWN" },
      { id: "edge-stair", includes_stairs: 1, stair_access_state: "STAIR_ONLY" },
      { id: "edge-step-free", includes_stairs: 0, stair_access_state: "STEP_FREE" },
      { id: "edge-unknown", includes_stairs: 0, stair_access_state: "UNKNOWN" },
    ]);
    assert.throws(() => populateNationwideTopologyEdges(database, [edge("edge-bad", { includesStairs: true, stairAccessState: "UNKNOWN" })]),
      /network edge stair state is invalid: edge-bad/u);
  } finally {
    database.close();
  }
});
