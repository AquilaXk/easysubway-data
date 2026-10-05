import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

import {
  E_SERVER_BUNDLE_DECOMPRESSED_BUDGET,
  buildServerRouteBundleFinalEvidence,
  closeReleaseFinal,
} from "./build-server-route-bundle-final.mjs";
import {
  buildRouteAccessibilityEligibility,
} from "./build-route-accessibility-eligibility.mjs";
import { GENERATED_ACCESSIBILITY_EVIDENCE_TABLE_DDL } from "./emit-artifact-components.mjs";
import {
  canonicalJson,
  sha256,
} from "./lib/manifest-validation.mjs";
import {
  validateServerRouteBundleFinal,
} from "./lib/server-route-bundle-final.mjs";
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
import { signServerRouteBundle } from "./sign-server-route-bundle.mjs";
import { createIndependentSourceGovernanceFixture } from "./test-fixtures/independent-source-governance.mjs";

const CURRENT_SOURCE_WINDOW = await selectedSourceWindow();
const FRESH_AT = CURRENT_SOURCE_WINDOW.evaluationAt;
const STALE_AT = CURRENT_SOURCE_WINDOW.staleAt;
const BUNDLE_ID = "capital-route-bundle-1";
const FIXTURE_PATH_ID = "kric-mv:S1:1:100:101:1";
const FIXTURE_EXIT_ELEVATOR = "smrt-elev:0100:1:1번 출입구";
const FIXTURE_DIRECTION_ELEVATOR = "smrt-elev:0100:1:나역 방면1-1";
const STATION_SET_SHA256 = "1".repeat(64);
const SCOPED_STATION_SET_SHA256 = sha256(Buffer.from(canonicalJson(["station-a", "station-b"])));
const SCRIPT = path.resolve("tools/datapack/build-server-route-bundle-final.mjs");
const signingKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const signingPrivateKey = signingKeys.privateKey.export({ type: "pkcs8", format: "pem" });
const signingPublicKey = signingKeys.publicKey.export({ type: "spki", format: "pem" });

test("route accessibility eligibility report를 FINAL gate에 bound한다", async (t) => {
  const fixture = await createFixture(t);
  const provisional = path.join(fixture.temp, "provisional");
  await build(fixture, provisional, FRESH_AT);
  const reportPath = await createEligibilityReport(fixture, provisional, "eligibility.json");
  const bound = path.join(fixture.temp, "bound");
  await build(fixture, bound, FRESH_AT, undefined, { eligibilityReportPath: reportPath });
  const boundFinal = await readJson(path.join(bound, "server-route-bundle-final.json"));
  assert.deepEqual(boundFinal.gates.routeAccessibilityEligibility, {
    state: "PASS",
    evidenceSha256: await fileSha(reportPath),
  });

  const drifted = await readJson(reportPath);
  delete drifted.eligibilitySha256;
  drifted.stationLineAccessibility.rowCount += 1;
  const driftedReportPath = path.join(fixture.temp, "eligibility-drift.json");
  await writeCanonical(driftedReportPath, {
    ...drifted,
    eligibilitySha256: sha256(Buffer.from(canonicalJson(drifted))),
  });
  const mismatch = path.join(fixture.temp, "eligibility-mismatch");
  await build(fixture, mismatch, FRESH_AT, undefined, { eligibilityReportPath: driftedReportPath });
  const mismatchFinal = await readJson(path.join(mismatch, "server-route-bundle-final.json"));
  assert.equal(mismatchFinal.gates.routeAccessibilityEligibility.state, "IDENTITY_MISMATCH");
});

test("current accessibility eligibility는 canonical prepublication evidence만 집계한다", async (t) => {
  const fixture = await createFixture(t);
  await writeEligibilityInputs(fixture);
  const prepublicationRoot = path.join(fixture.temp, "prepublication");
  await build(fixture, prepublicationRoot, FRESH_AT);

  const report = await buildRouteAccessibilityEligibility(eligibilityInput(
    fixture,
    prepublicationRoot,
    path.join(fixture.temp, "eligibility.json"),
  ));
  assert.equal(report.decision, "ELIGIBLE");
  assert.equal(report.stationLineAccessibility.rowCount, 6);
  assert.equal(report.routeEdgeEvaluation.edgeCount, fixture.routeEdgeInput.routeEdges.length);
  // #866 PR-C: 경로가 요구하는 cell은 환승 끝점 TRANSFER뿐이다(ENTRY→FACILITY 매핑 삭제). 환승 끝점을 UNKNOWN으로 둔다.
  const unresolvedFixture = await createFixture(t, {
    configureInputs: configurePlatformInputs({ transferEndpointState: "UNKNOWN" }),
  });
  await writeEligibilityInputs(unresolvedFixture);
  const unresolvedRoot = path.join(unresolvedFixture.temp, "prepublication");
  await build(unresolvedFixture, unresolvedRoot, FRESH_AT);
  const ineligible = await buildRouteAccessibilityEligibility(eligibilityInput(
    unresolvedFixture,
    unresolvedRoot,
    path.join(unresolvedFixture.temp, "ineligible.json"),
  ));
  assert.equal(ineligible.decision, "INELIGIBLE");
  assert.ok(ineligible.blockers.includes("stationLineAccessibility:UNKNOWN"));

  for (const name of [
    "source-freshness.json",
    "artifact-inventory.json",
    "station-line-accessibility.json",
    "route-edge-evaluation.json",
    "server-route-bundle-final.json",
  ]) {
    const root = path.join(fixture.temp, `mutated-${name}`);
    await cp(prepublicationRoot, root, { recursive: true });
    const target = path.join(root, name);
    const value = await readJson(target);
    value.reviewMutation = true;
    await writeCanonical(target, value);
    const output = path.join(fixture.temp, `${name}.eligibility.json`);
    await assert.rejects(() => buildRouteAccessibilityEligibility(eligibilityInput(fixture, root, output)), /prepublication .* mismatch/);
    await assert.rejects(() => readFile(output), /ENOENT/);
  }
});

test("#873 승강장 기준 입력은 FACILITY UNKNOWN·EXIT MISSING이어도 환승 끝점 TRANSFER가 닫히면 FINAL·eligibility 게이트를 통과한다", async (t) => {
  const fixture = await createFixture(t, { configureInputs: configurePlatformInputs() });
  assert.ok(fixture.routeEdgeInput.routeEdges.every(({ edgeType }) => edgeType !== "ENTRY" && edgeType !== "EXIT"));
  await writeEligibilityInputs(fixture);
  const provisional = path.join(fixture.temp, "provisional");
  await build(fixture, provisional, FRESH_AT);
  const materialization = await readJson(path.join(provisional, "station-line-accessibility.json"));
  // 환승 간선이 쓰지 않는 cell은 닫혀 있지 않다: FACILITY UNKNOWN 2, EXIT MISSING 3(증거 행 없음).
  assert.equal(materialization.stateSummary.UNKNOWN, 2);
  assert.equal(materialization.stateSummary.MISSING, 3);
  const final = await readJson(path.join(provisional, "server-route-bundle-final.json"));
  assert.equal(final.gates.stationLineAccessibility.state, "PASS");
  assert.equal(final.gates.routeEdgeEvaluation.state, "PASS");
  const reportPath = path.join(fixture.temp, "eligibility.json");
  const report = await buildRouteAccessibilityEligibility(eligibilityInput(fixture, provisional, reportPath));
  assert.equal(report.decision, "ELIGIBLE");
  assert.deepEqual(report.blockers, []);
  const bound = path.join(fixture.temp, "bound");
  await build(fixture, bound, FRESH_AT, undefined, { eligibilityReportPath: reportPath });
  const boundFinal = await readJson(path.join(bound, "server-route-bundle-final.json"));
  assert.equal(boundFinal.gates.routeAccessibilityEligibility.state, "PASS");
});

test("#873 승강장 기준 입력도 환승 끝점 TRANSFER cell이 UNKNOWN이면 FINAL·eligibility 게이트가 실패한다", async (t) => {
  const fixture = await createFixture(t, { configureInputs: configurePlatformInputs({ transferEndpointState: "UNKNOWN" }) });
  await writeEligibilityInputs(fixture);
  const provisional = path.join(fixture.temp, "provisional");
  await build(fixture, provisional, FRESH_AT);
  const final = await readJson(path.join(provisional, "server-route-bundle-final.json"));
  assert.equal(final.gates.stationLineAccessibility.state, "UNKNOWN");
  assert.equal(final.gates.routeEdgeEvaluation.state, "UNKNOWN");
  assert.ok(final.blockers.includes("stationLineAccessibility:UNKNOWN"));
  assert.ok(final.blockers.includes("routeEdgeEvaluation:UNKNOWN"));
  const reportPath = path.join(fixture.temp, "eligibility.json");
  const report = await buildRouteAccessibilityEligibility(eligibilityInput(fixture, provisional, reportPath));
  assert.equal(report.decision, "INELIGIBLE");
  for (const blocker of ["routeEdgeEvaluation:INELIGIBLE", "routeEdgeEvaluation:UNKNOWN", "stationLineAccessibility:UNKNOWN"]) {
    assert.ok(report.blockers.includes(blocker), blocker);
  }
  const bound = path.join(fixture.temp, "bound");
  await build(fixture, bound, FRESH_AT, undefined, { eligibilityReportPath: reportPath });
  const boundFinal = await readJson(path.join(bound, "server-route-bundle-final.json"));
  assert.equal(boundFinal.gates.routeAccessibilityEligibility.state, "INELIGIBLE");
});

test("current Data #8 three-handoff input과 materialization bytes를 exact consumer로 수용한다", async () => {
  const [inputBytes, materializationBytes] = await Promise.all([
    readFile("tools/datapack/release/current-station-line-accessibility/station-line-input.json"),
    readFile("tools/datapack/release/current-station-line-accessibility/station-line-accessibility.json"),
  ]);
  const input = JSON.parse(inputBytes);
  const tracked = JSON.parse(materializationBytes);

  assert.equal(inputBytes.toString("utf8"), canonicalJson(input));
  assert.equal(materializationBytes.toString("utf8"), canonicalStationLineAccessibilityJson(tracked));
  const observedAt = sharedEvidenceWindowObservedAt(input.evidenceRows);
  const materialized = materializeStationLineAccessibility({
    ...input,
    observedAt,
  });
  assert.equal(canonicalStationLineAccessibilityJson(materialized), materializationBytes.toString("utf8"));
  assert.equal(materialized.materializationDigest, "561ef3dde0f68e1223b05897d71a193d73b67b34cb677fc91201e99a4ae9eabb");
  assert.throws(
    () => sharedEvidenceWindowObservedAt([{
      capturedAt: "2026-08-15T00:00:00.000Z",
      freshUntil: "2026-08-15T00:00:00.000Z",
    }]),
    /shared evidence window is empty/,
  );
});

test("embedded #8/#9 evidence와 current keyless bytes를 deterministic NO_GO FINAL로 결속한다", async (t) => {
  const fixture = await createFixture(t);
  const beforeStation = structuredClone(fixture.stationLineInput);
  const beforeRoute = structuredClone(fixture.routeEdgeInput);
  const firstOutput = path.join(fixture.temp, "evidence-one");
  const secondOutput = path.join(fixture.temp, "evidence-two");

  await build(fixture, firstOutput, FRESH_AT);
  await build(fixture, secondOutput, FRESH_AT);

  assert.deepEqual(fixture.stationLineInput, beforeStation);
  assert.deepEqual(fixture.routeEdgeInput, beforeRoute);
  assert.deepEqual((await readdir(firstOutput)).sort(bytewise), [
    "artifact-inventory.json",
    "route-edge-evaluation.json",
    "server-route-bundle-final.json",
    "source-freshness.json",
    "station-line-accessibility.json",
  ]);
  for (const name of (await readdir(firstOutput)).sort(bytewise)) {
    assert.deepEqual(await readFile(path.join(firstOutput, name)), await readFile(path.join(secondOutput, name)), name);
  }

  const final = await readJson(path.join(firstOutput, "server-route-bundle-final.json"));
  assert.deepEqual(final.gates, {
    artifactInventory: { state: "PASS", evidenceSha256: await fileSha(path.join(firstOutput, "artifact-inventory.json")) },
    publication: { state: "UNAVAILABLE", evidenceSha256: null },
    routeAccessibilityEligibility: { state: "UNAVAILABLE", evidenceSha256: null },
    promotionAuthorization: { state: "UNAVAILABLE", evidenceSha256: null },
    routeEdgeEvaluation: { state: "PASS", evidenceSha256: await fileSha(path.join(firstOutput, "route-edge-evaluation.json")) },
    signature: { state: "UNAVAILABLE", evidenceSha256: null },
    sourceFreshness: { state: "PASS", evidenceSha256: await fileSha(path.join(firstOutput, "source-freshness.json")) },
    stationLineAccessibility: { state: "PASS", evidenceSha256: await fileSha(path.join(firstOutput, "station-line-accessibility.json")) },
  });
  assert.equal(final.result, "NO_GO");
  assert.deepEqual(final.blockers, [
    "promotionAuthorization:UNAVAILABLE",
    "publication:UNAVAILABLE",
    "routeAccessibilityEligibility:UNAVAILABLE",
    "signature:UNAVAILABLE",
  ]);
  assert.equal(final.candidate.repository, "AquilaXk/easysubway-data");
  assert.equal(final.candidate.gitSha, fixture.repositoryGitSha);
  assert.equal(final.candidate.bundleId, BUNDLE_ID);
  assert.equal(final.candidate.sourceSnapshotSetHash, fixture.buildSpec.sourceSnapshotSetHash);
  assert.equal(final.candidate.payloadRootSha256, final.candidate.componentInventorySha256);
  assert.equal(final.candidate.signedManifestRawSha256, null);
  assert.equal(final.candidate.componentDigests.topology, fixture.manifest.topologySha256);
  assert.doesNotThrow(() => validateServerRouteBundleFinal(final));

  const inventory = await readJson(path.join(firstOutput, "artifact-inventory.json"));
  assert.deepEqual(inventory.entries.map(({ path: entryPath }) => entryPath), [
    "payload/accessibility.sqlite.zst",
    "payload/fare.sqlite.zst",
    "payload/timetable.sqlite.zst",
    "payload/topology.sqlite.zst",
  ]);
  assert.equal(inventory.componentInventorySha256, fixture.manifest.payloadSha256);

  await mutateAccessibilityPayload(
    fixture,
    "UPDATE station_line_accessibility_evidence SET canonical_json = canonical_json || ' '",
  );
  const tamperedOutput = path.join(fixture.temp, "tampered-final");
  await assert.rejects(
    () => build(fixture, tamperedOutput, FRESH_AT),
    /embedded station-line accessibility evidence mismatch/,
  );
  await assert.rejects(() => readFile(tamperedOutput), /ENOENT/);
});

test("handoff candidate와 signed bundle identity를 분리한다", async (t) => {
  const fixture = await createFixture(t);
  assert.equal(fixture.stationLineInput.candidate.candidateId, fixture.buildSpec.candidateId);
  assert.equal(fixture.routeEdgeInput.candidate.candidateId, fixture.buildSpec.candidateId);
  assert.notEqual(fixture.buildSpec.candidateId, BUNDLE_ID);

  const output = path.join(fixture.temp, "distinct-candidate-bundle");
  await build(fixture, output, FRESH_AT);
  const final = await readJson(path.join(output, "server-route-bundle-final.json"));
  assert.equal(final.candidate.bundleId, BUNDLE_ID);

  for (const [name, mutate] of [
    ["station", (value) => { value.stationLineInput.candidate.candidateId = "other-candidate"; }],
    ["route", (value) => { value.routeEdgeInput.candidate.candidateId = "other-candidate"; }],
  ]) {
    const rejected = await createFixture(t);
    mutate(rejected);
    const rejectedOutput = path.join(rejected.temp, `wrong-${name}-candidate`);
    await assert.rejects(() => build(rejected, rejectedOutput, FRESH_AT), /candidate identity mismatch/);
    await assert.rejects(() => readFile(rejectedOutput), /ENOENT/);
  }
});

test("embedded #8/#9 evidence의 missing·extra·digest mismatch는 fail closed한다", async (t) => {
  for (const [name, sql, pattern] of [
    ["wrong-user-version", "PRAGMA user_version=18", /embedded accessibility evidence SQLite user_version mismatch/],
    ["missing-route-row", "DELETE FROM route_accessibility_edge_evidence", /embedded route-edge evaluation evidence mismatch/],
    ["extra-station-row", `INSERT INTO station_line_accessibility_evidence VALUES('${"d".repeat(64)}','{}')`, /embedded station-line accessibility evidence mismatch/],
    ["route-digest-mismatch", `UPDATE route_accessibility_edge_evidence SET evaluation_digest='${"e".repeat(64)}'`, /embedded route-edge evaluation evidence mismatch/],
    ["route-schema-without-constraints", "ALTER TABLE route_accessibility_edge_evidence RENAME TO route_accessibility_edge_evidence_old; CREATE TABLE route_accessibility_edge_evidence (evaluation_digest TEXT NOT NULL PRIMARY KEY, materialization_digest TEXT NOT NULL, canonical_json TEXT NOT NULL); INSERT INTO route_accessibility_edge_evidence SELECT * FROM route_accessibility_edge_evidence_old; DROP TABLE route_accessibility_edge_evidence_old", /embedded route_accessibility_edge_evidence schema mismatch/],
    ["missing-route-table", "DROP TABLE route_accessibility_edge_evidence", /embedded route_accessibility_edge_evidence schema mismatch/],
    ["missing-station-elevator-path-table", "DROP TABLE station_elevator_path", /embedded station_elevator_path schema mismatch/],
    ["missing-station-elevator-path-facility-table", "DROP TABLE station_elevator_path_facility", /embedded station_elevator_path_facility schema mismatch/],
    ["missing-station-platform-gaps-table", "DROP TABLE station_platform_gaps", /embedded station_platform_gaps schema mismatch/],
    // #925: 환승 계단 근거 표는 정확한 DDL이어야 하고, 근거 간선은 route-edge 입력의 역 안 환승 간선이어야 한다.
    ["missing-transfer-stair-evidence-table", "DROP TABLE transfer_stair_access_evidence", /embedded transfer_stair_access_evidence schema mismatch/],
    ["orphan-transfer-stair-edge", `INSERT INTO transfer_stair_access_evidence VALUES('transfer-ghost','station-a','station-b','${"a".repeat(64)}','molit-railway-transfer-movement-20260811','GENERAL_TRANSFER_EDGE_NOT_STEP_FREE_PATH')`, /transfer_stair_access_evidence contains edge_id outside in-station transfer route edges: transfer-ghost/],
    ["ride-edge-transfer-stair-evidence", `INSERT INTO transfer_stair_access_evidence VALUES('ride-0000','station-a','station-b','${"a".repeat(64)}','molit-railway-transfer-movement-20260811','GENERAL_TRANSFER_EDGE_NOT_STEP_FREE_PATH')`, /transfer_stair_access_evidence contains edge_id outside in-station transfer route edges: ride-0000/],
    ["orphan-path-id", "INSERT INTO station_elevator_path_facility VALUES('kric-mv:S1:2:201:202:1','EXIT','smrt-elev:0201:2:9번 출입구')", /station_elevator_path_facility contains orphan path_id: kric-mv:S1:2:201:202:1/],
    ["orphan-facility-id", "INSERT INTO station_elevator_path VALUES('kric-mv:S1:2:201:202:1','s1','l1','s2','9','나역',1,'1) 이동'); INSERT INTO station_elevator_path_facility VALUES('kric-mv:S1:2:201:202:1','EXIT','smrt-elev:0201:2:9번 출입구')", /station_elevator_path_facility contains orphan facility_id: smrt-elev:0201:2:9번 출입구/],
    ["missing-facilities-table", "DROP TABLE facilities", /facilities table is missing/],
    ["missing-transition-facility-requirement-table", "DROP TABLE transition_facility_requirement", /embedded transition_facility_requirement schema mismatch/],
    ["empty-transition-facility-requirement", "DELETE FROM transition_facility_requirement", /transition_facility_requirement is empty/],
    ["orphan-transition-key", `INSERT INTO transition_facility_requirement VALUES('station-ghost:line-1','${FIXTURE_PATH_ID}','station-b','EXIT_ELEVATORS','${FIXTURE_EXIT_ELEVATOR}')`, /transition_facility_requirement contains orphan transition_key: station-ghost:line-1/],
    ["other-station-transition-key", `INSERT INTO transition_facility_requirement VALUES('station-b:line-1','${FIXTURE_PATH_ID}','station-b','EXIT_ELEVATORS','${FIXTURE_EXIT_ELEVATOR}')`, /transition_facility_requirement contains orphan transition_key: station-b:line-1/],
    ["legacy-entry-transition-key", `INSERT INTO transition_facility_requirement VALUES('entry-a','${FIXTURE_PATH_ID}','station-b','EXIT_ELEVATORS','${FIXTURE_EXIT_ELEVATOR}')`, /transition_facility_requirement contains orphan transition_key: entry-a/],
    ["orphan-requirement-facility-id", `INSERT INTO transition_facility_requirement VALUES('station-a:line-1','${FIXTURE_PATH_ID}','station-b','EXIT_ELEVATORS','smrt-elev:ghost')`, /transition_facility_requirement contains orphan facility_id: smrt-elev:ghost/],
    ["orphan-requirement-path-id", `INSERT INTO transition_facility_requirement VALUES('station-a:line-1','kric-mv:ghost','station-b','EXIT_ELEVATORS','${FIXTURE_EXIT_ELEVATOR}')`, /transition_facility_requirement contains orphan path_id: kric-mv:ghost/],
    ["requirement-derivation-mismatch", "DELETE FROM transition_facility_requirement WHERE transition_key='station-a:line-1' AND group_kind='EXIT_ELEVATORS'", /transition_facility_requirement does not match station elevator path derivation/],
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture(t);
      await mutateAccessibilityPayload(fixture, sql);
      const output = path.join(fixture.temp, `rejected-${name}`);
      await assert.rejects(() => build(fixture, output, FRESH_AT), pattern);
      await assert.rejects(() => readFile(output), /ENOENT/);
    });
  }
});

// #944 리뷰 F4: FINAL은 topology network_edges도 읽어 근거 간선 집합과 STEP_FREE 역 안 환승 집합이 정확히 같은지,
// STEP_FREE 간선에 계단이 없는지, 근거 행의 snapshotId가 inventory가 잠근 MOLIT 스냅샷인지 검사한다.
test("F4 FINAL은 환승 계단 근거 표와 topology STEP_FREE 간선·MOLIT snapshotId를 대조해 어긋나면 fail closed한다", async (t) => {
  const molitRow = (edgeId, snapshotId) => `INSERT INTO transfer_stair_access_evidence VALUES('${edgeId}','station-a','station-b','${"a".repeat(64)}','${snapshotId}','GENERAL_TRANSFER_EDGE_NOT_STEP_FREE_PATH')`;
  for (const [name, mutate, pattern] of [
    ["topology-step-free-without-evidence", (fixture) => mutateTopologyPayload(fixture, "INSERT INTO network_edges(id,from_node_id,to_node_id,edge_type,includes_stairs,stair_access_state) VALUES('transfer-x','station-a:line-1','station-a:line-2','IN_STATION_TRANSFER',0,'STEP_FREE')"),
      /transfer_stair_access_evidence does not match network_edges STEP_FREE in-station transfers/],
    ["step-free-edge-with-stairs", (fixture) => mutateTopologyPayload(fixture, "INSERT INTO network_edges(id,from_node_id,to_node_id,edge_type,includes_stairs,stair_access_state) VALUES('transfer-y','station-a:line-1','station-a:line-2','IN_STATION_TRANSFER',1,'STEP_FREE')"),
      /network_edges STEP_FREE edge includes stairs: transfer-y/],
    ["missing-topology-network-edges", (fixture) => mutateTopologyPayload(fixture, "DROP TABLE network_edges"),
      /embedded topology network_edges is missing/],
    ["evidence-snapshot-mismatch", (fixture) => mutateAccessibilityPayload(fixture, molitRow("transfer-ghost", "molit-railway-transfer-movement-20250811")),
      /transfer_stair_access_evidence source_snapshot_id does not match the admitted MOLIT snapshot: molit-railway-transfer-movement-20250811/],
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture(t);
      await mutate(fixture);
      const output = path.join(fixture.temp, `rejected-${name}`);
      await assert.rejects(() => build(fixture, output, FRESH_AT), pattern);
      await assert.rejects(() => readFile(output), /ENOENT/);
    });
  }
});

// #951: FINAL은 topology 간선의 출처·검증 상태 칸이 서로 모순되면(근거 없는 VERIFIED, 원천이 새는 UNKNOWN, 규칙과 어긋난 환승) fail closed한다.
test("#951 FINAL은 topology 간선 출처 칸과 transfer_rules가 모순되면 fail closed한다", async (t) => {
  const edge = (id, type, from, to, columns) => `INSERT INTO network_edges(id,from_node_id,to_node_id,duration_seconds,edge_type,includes_stairs,stair_access_state,source_id,source_snapshot_id,provider_record_hash,provenance_kind,verification_status,last_verified_at,evidence_hash) VALUES('${id}','${from}','${to}',120,'${type}',0,'UNKNOWN',${columns})`;
  const official = "'seoul-metro-transfer-car-door-duration','snapshot-1','" + "a".repeat(64) + "','OFFICIAL_SOURCE','VERIFIED',1790872404,'" + "b".repeat(64) + "'";
  const unknown = "'','','','UNKNOWN','UNKNOWN',NULL,''";
  const rule = (status, seconds = 120) => `INSERT INTO transfer_rules VALUES('rule-1','station-a','line-1','station-a','line-2',${seconds},'seoul-metro-transfer-car-door-duration','${status}')`;
  const transfer = (columns) => edge("transfer-1", "IN_STATION_TRANSFER", "station-a:line-1", "station-a:line-2", columns);
  for (const [name, sql, pattern] of [
    ["unsupported-pair", edge("ride-1", "RIDE", "station-a:line-1", "station-b:line-1", "'x','y','" + "a".repeat(64) + "','OFFICIAL_SOURCE','UNKNOWN',1790872404,'" + "b".repeat(64) + "'"), /edge provenance pair is not supported: ride-1/],
    ["verified-edge-without-hash", edge("ride-1", "RIDE", "station-a:line-1", "station-b:line-1", official.replace("'" + "a".repeat(64) + "'", "''")), /VERIFIED edge evidence is incomplete: ride-1/],
    ["unknown-edge-with-source", edge("ride-1", "RIDE", "station-a:line-1", "station-b:line-1", unknown.replace("'',", "'leaked-source',")), /UNKNOWN edge must not carry source evidence: ride-1/],
    ["verified-transfer-without-rule", transfer(official), /VERIFIED transfer edge has no VERIFIED rule: transfer-1/],
    ["verified-transfer-with-unverified-rule", `${transfer(official)}; ${rule("UNVERIFIED")}`, /VERIFIED transfer edge has no VERIFIED rule: transfer-1/],
    ["verified-transfer-duration-mismatch", `${transfer(official)}; ${rule("VERIFIED", 90)}`, /VERIFIED transfer edge duration does not match rule: transfer-1/],
    ["verified-rule-without-verified-edge", `${transfer(unknown)}; ${rule("VERIFIED")}`, /VERIFIED transfer rule has no VERIFIED edge: rule-1/],
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture(t);
      await mutateTopologyPayload(fixture, sql);
      const output = path.join(fixture.temp, `provenance-${name}`);
      await assert.rejects(() => build(fixture, output, FRESH_AT), pattern);
      await assert.rejects(() => readFile(output), /ENOENT/);
    });
  }
});

test("current-key signed manifest는 signature gate만 닫고 publication·parity NO_GO를 유지한다", async (t) => {
  const fixture = await createFixture(t);
  installSigningEnvironment(t);
  const signedRoot = path.join(fixture.temp, "signed-bundle");
  await signServerRouteBundle({ input: fixture.artifactRoot, output: signedRoot });
  fixture.artifactRoot = signedRoot;
  const output = path.join(fixture.temp, "signed-final");
  await build(fixture, output, FRESH_AT);

  const manifestSha256 = await fileSha(path.join(signedRoot, "manifest.json"));
  const final = await readJson(path.join(output, "server-route-bundle-final.json"));
  assert.equal(final.candidate.signedManifestRawSha256, manifestSha256);
  assert.deepEqual(final.gates.signature, { state: "PASS", evidenceSha256: manifestSha256 });
  assert.deepEqual(final.blockers, ["promotionAuthorization:UNAVAILABLE", "publication:UNAVAILABLE", "routeAccessibilityEligibility:UNAVAILABLE"]);
  assert.equal(final.result, "NO_GO");
  const inventory = await readJson(path.join(output, "artifact-inventory.json"));
  assert.equal(inventory.signedManifestRawSha256, manifestSha256);
  assert.doesNotThrow(() => validateServerRouteBundleFinal(final));

  const manifestPath = path.join(signedRoot, "manifest.json");
  const manifest = await readJson(manifestPath);
  await writeCanonical(manifestPath, { ...manifest, bundleId: "other-bundle" });
  const driftOutput = path.join(fixture.temp, "manifest-drift");
  await assert.rejects(() => build(fixture, driftOutput, FRESH_AT), /signed manifest does not match signing input/);
  await assert.rejects(() => readFile(driftOutput), /ENOENT/);

  const head = manifest.signature.value[0];
  manifest.signature.value = `${head === "A" ? "B" : "A"}${manifest.signature.value.slice(1)}`;
  await writeCanonical(manifestPath, manifest);
  const rejectedOutput = path.join(fixture.temp, "invalid-signature");
  await assert.rejects(() => build(fixture, rejectedOutput, FRESH_AT), /signed manifest signature mismatch/);
  await assert.rejects(() => readFile(rejectedOutput), /ENOENT/);
});

test("publication receipt와 single-candidate promotion을 동일 FINAL GO로 결속한다", async (t) => {
  const fixture = await createFixture(t);
  installSigningEnvironment(t);
  const signedRoot = path.join(fixture.temp, "signed-release-bundle");
  await signServerRouteBundle({ input: fixture.artifactRoot, output: signedRoot });
  fixture.artifactRoot = signedRoot;

  const provisionalOutput = path.join(fixture.temp, "provisional-final");
  await build(fixture, provisionalOutput, FRESH_AT);
  const eligibilityReportPath = await createEligibilityReport(
    fixture,
    provisionalOutput,
    "release-eligibility.json",
  );
  const prePublicationOutput = path.join(fixture.temp, "pre-publication-final");
  await build(fixture, prePublicationOutput, FRESH_AT, undefined, { eligibilityReportPath });
  const prePublicationFinal = await readJson(
    path.join(prePublicationOutput, "server-route-bundle-final.json"),
  );
  assert.equal(prePublicationFinal.result, "NO_GO");
  assert.deepEqual(prePublicationFinal.blockers, [
    "promotionAuthorization:UNAVAILABLE",
    "publication:UNAVAILABLE",
  ]);

  const releaseEvidence = {
    ...await createReleaseEvidence(fixture, prePublicationFinal),
    eligibilityReportPath,
  };
  const output = path.join(fixture.temp, "release-final");
  await build(fixture, output, FRESH_AT, releaseEvidence);

  const final = await readJson(path.join(output, "server-route-bundle-final.json"));
  assert.equal(final.result, "GO");
  assert.deepEqual(final.blockers, []);
  assert.deepEqual(final.gates.publication, {
    state: "PASS",
    evidenceSha256: await fileSha(releaseEvidence.publicationReceiptPath),
  });
  assert.deepEqual(final.gates.promotionAuthorization, {
    state: "PASS",
    evidenceSha256: await fileSha(releaseEvidence.promotionRequestPath),
  });
  assert.doesNotThrow(() => validateServerRouteBundleFinal(final));
  assert.deepEqual((await readdir(output)).sort(bytewise), [
    "artifact-inventory.json",
    "route-edge-evaluation.json",
    "server-route-bundle-final.json",
    "source-freshness.json",
    "station-line-accessibility.json",
  ]);
});

test("receipt와 promotion inventory를 함께 변조해도 actual bundle bytes mismatch는 거부한다", async (t) => {
  installSigningEnvironment(t);
  const { fixture, releaseEvidence } = await prepareSignedReleaseFixture(t);
  await rewriteReceipt(releaseEvidence.publicationReceiptPath, (receipt) => {
    receipt.objects.find((entry) => entry.path === "compatibility.json").sha256 = "f".repeat(64);
  });
  await rewritePromotionEvidence(releaseEvidence, ({ inventory }) => {
    inventory.entries.find((entry) => (
      entry.path === "server-route-bundle/compatibility.json"
    )).sha256 = "f".repeat(64);
  });
  const output = path.join(fixture.temp, "release-rejected-published-byte-drift");
  await assert.rejects(
    () => build(fixture, output, FRESH_AT, releaseEvidence),
    /publication receipt object inventory mismatch/,
  );
  await assert.rejects(() => readFile(output), /ENOENT/);
});

// #916 리뷰 F1: 발행 단계(closeReleaseFinal)의 cutoff 가드는 발행 전 검사와 독립적으로 거부해야 한다.
// 발행 전 검사를 우회한 FINAL이 들어와도 release evidence를 읽기 전에 막는다.
test("발행 단계 FINAL closure는 발행 전 검사와 별개로 bundle보다 이른 source cutoff를 거부한다", async () => {
  const prePublicationFinal = {
    result: "NO_GO",
    blockers: ["promotionAuthorization:UNAVAILABLE", "publication:UNAVAILABLE"],
    candidate: { freshUntil: "2026-10-10T09:11:32.831+09:00" },
  };
  const freshness = (freshnessExpiresAt) => ({ state: "PASS", evidence: { validation: { results: [{ freshnessExpiresAt }] } } });
  await assert.rejects(() => closeReleaseFinal(prePublicationFinal, {}, [], freshness("2026-10-10T00:05:31.571Z")),
    /source freshness cutoff must cover candidate freshUntil/);
  // cutoff가 bundle 이후면 이 가드를 지나 release evidence 검사로 넘어간다.
  await assert.rejects(() => closeReleaseFinal(prePublicationFinal, {}, [], freshness("2026-10-10T00:11:32.831Z")),
    /release evidence keys/);
});

// #913 후속: RC(발행 전 FINAL)도 발행 경로와 같은 원천 신선도 cutoff 검사를 같은 입력으로 돌린다.
// seq126에서 RC는 통과하고 production-publish의 release FINAL에서만 실패했다(경로 차이).
test("발행 전 FINAL도 bundle보다 이른 source freshness cutoff를 거부한다", async (t) => {
  installSigningEnvironment(t);
  const sourceWindow = await selectedSourceWindow();
  const candidateFreshUntil = kstInstant(Date.parse(sourceWindow.freshUntil) + 1);
  const fixture = await createFixture(t, {
    evaluationAt: sourceWindow.evaluationAt,
    freshUntil: candidateFreshUntil,
    configureBuildSpec: (spec) => {
      spec.productionScopeId = "nationwide_routing_android_v1";
      spec.candidateId = "nationwide-candidate-20260909";
    },
  });
  const signedRoot = path.join(fixture.temp, "signed-prepublication-cutoff");
  await signServerRouteBundle({ input: fixture.artifactRoot, output: signedRoot });
  fixture.artifactRoot = signedRoot;
  const fixtureWindow = await selectedSourceWindow(fixture.repositoryRoot);
  const output = path.join(fixture.temp, "prepublication-cutoff");
  await assert.rejects(() => build(fixture, output, fixtureWindow.evaluationAt), /source freshness cutoff must cover candidate freshUntil/);
  await assert.rejects(() => readFile(output), /ENOENT/);
});

// #913: nationwide도 예외 없이 거부한다. 예외(#761)가 있으면 원천이 만료된 시간표를 번들이 계속 서빙해도 FINAL이 통과한다.
test("FINAL closure는 bundle보다 이른 source freshness cutoff를 scope와 상관없이 거부한다", async (t) => {
  installSigningEnvironment(t);
  const sourceWindow = await selectedSourceWindow();
  const sourceExpiry = Date.parse(sourceWindow.freshUntil);
  const candidateFreshUntil = kstInstant(sourceExpiry + 1);
  assert.ok(Date.parse(sourceWindow.evaluationAt) < sourceExpiry && sourceExpiry < Date.parse(candidateFreshUntil));

  for (const scenario of [
    { scopeId: "capital_routing_android_v1", candidateId: "capital-candidate-20260909" },
    { scopeId: "nationwide_routing_android_v1", candidateId: "nationwide-candidate-20260909" },
  ]) {
    // #913 후속: 발행 전 FINAL(RC)에서 먼저 거부되므로 release evidence를 만들 수 없다(발행 단계까지 가지 않는다).
    await assert.rejects(prepareSignedReleaseFixture(t, {
      evaluationAt: sourceWindow.evaluationAt,
      freshUntil: candidateFreshUntil,
      configureBuildSpec: (spec) => {
        spec.productionScopeId = scenario.scopeId;
        spec.candidateId = scenario.candidateId;
      },
    }), /source freshness cutoff must cover candidate freshUntil/, scenario.scopeId);
  }
});

test("release evidence mismatch·stale·mutation은 FINAL output 전에 fail closed한다", async (t) => {
  installSigningEnvironment(t);
  for (const [name, mutate, pattern, evaluationAt = FRESH_AT] of [
    ["partial-input", async ({ releaseEvidence }) => {
      delete releaseEvidence.approvalEvidencePath;
    }, /release evidence keys mismatch/],
    ["receipt-final", async ({ releaseEvidence }) => {
      await rewriteReceipt(releaseEvidence.publicationReceiptPath, (receipt) => {
        receipt.candidate.prePublicationFinalSha256 = "f".repeat(64);
      });
    }, /publication receipt FINAL identity mismatch/],
    ["receipt-noncanonical", async ({ releaseEvidence }) => {
      const receipt = await readJson(releaseEvidence.publicationReceiptPath);
      await writeFile(releaseEvidence.publicationReceiptPath, JSON.stringify(receipt, null, 2));
    }, /publication receipt must be canonical JSON/],
    ["promotion-git", async ({ releaseEvidence }) => {
      await rewritePromotionEvidence(releaseEvidence, ({ component }) => {
        component.gitSha = "f".repeat(40);
      });
    }, /promotion candidate identity mismatch/],
    ["promotion-release", async ({ releaseEvidence }) => {
      await rewritePromotionEvidence(releaseEvidence, ({ component }) => {
        component.releaseSequence += 1;
      });
    }, /promotion candidate identity mismatch/],
    ["promotion-source", async ({ releaseEvidence }) => {
      await rewritePromotionEvidence(releaseEvidence, ({ component }) => {
        component.provenance.sourceSnapshotSetHash = "f".repeat(64);
      });
    }, /promotion candidate identity mismatch/],
    ["server-digest", async ({ releaseEvidence }) => {
      await rewritePromotionEvidence(releaseEvidence, ({ inventory }) => {
        inventory.entries.find((entry) => entry.path === "server-route-bundle/provenance.json").sha256 = "f".repeat(64);
      });
    }, /promotion server-route-bundle inventory mismatch/],
    ["server-missing", async ({ releaseEvidence }) => {
      await rewritePromotionEvidence(releaseEvidence, ({ inventory }) => {
        inventory.entries = inventory.entries.filter((entry) => (
          entry.path !== "server-route-bundle/payload/fare.sqlite.zst"
        ));
      });
    }, /promotion server-route-bundle inventory mismatch/],
    ["server-extra", async ({ releaseEvidence }) => {
      await rewritePromotionEvidence(releaseEvidence, ({ inventory }) => {
        inventory.entries.push({
          path: "server-route-bundle/extra.bin",
          sizeBytes: 1,
          sha256: "e".repeat(64),
        });
        inventory.entries.sort((left, right) => bytewise(left.path, right.path));
      });
    }, /promotion server-route-bundle inventory mismatch/],
    ["inventory-duplicate", async ({ releaseEvidence }) => {
      await rewritePromotionEvidence(releaseEvidence, ({ inventory }) => {
        inventory.entries.push(structuredClone(inventory.entries.find((entry) => (
          entry.path === "server-route-bundle/provenance.json"
        ))));
        inventory.entries.sort((left, right) => bytewise(left.path, right.path));
      });
    }, /inventory entry is invalid/],
    ["inventory-order", async ({ releaseEvidence }) => {
      await rewritePromotionEvidence(releaseEvidence, ({ inventory }) => {
        inventory.entries.reverse();
      });
    }, /inventory entry is invalid/],
    ["symlink", async ({ fixture, releaseEvidence }) => {
      const target = path.join(fixture.temp, "approval-target.json");
      await rename(releaseEvidence.approvalEvidencePath, target);
      await symlink(target, releaseEvidence.approvalEvidencePath);
    }, /approvalEvidencePath must be a regular non-symlink/],
    ["stale", async () => {}, /embedded station-line accessibility evidence mismatch/, STALE_AT],
    ["wall-clock-expired", async () => ({
      clock: () => Date.parse(STALE_AT),
    }), /candidate freshUntil must be in the future at FINAL closure/],
    ["changed-during-build", async ({ releaseEvidence }) => ({
      beforeReleaseOutput: async () => {
        await writeFile(releaseEvidence.promotionRequestPath, "changed");
      },
    }), /promotionRequestPath changed during FINAL build/],
    ["candidate-execution-evidence-changed-during-build", async ({ releaseEvidence }) => ({
      beforeReleaseOutput: async () => {
        await writeFile(
          path.join(releaseEvidence.candidateExecutionEvidenceRoot, "release-decision.json"),
          "changed",
        );
      },
    }), /candidateReleaseDecisionPath changed during FINAL build/],
    ["eligibility-changed-during-build", async ({ releaseEvidence }) => ({
      beforeReleaseOutput: async () => {
        await writeFile(releaseEvidence.eligibilityReportPath, "changed");
      },
    }), /eligibilityReportPath changed during FINAL build/],
  ]) {
    await t.test(name, async () => {
      const { fixture, releaseEvidence } = await prepareSignedReleaseFixture(t);
      const extraInput = await mutate({ fixture, releaseEvidence }) ?? {};
      const output = path.join(fixture.temp, `release-rejected-${name}`);
      await assert.rejects(
        () => build(fixture, output, evaluationAt, releaseEvidence, extraInput),
        pattern,
      );
      await assert.rejects(() => readFile(output), /ENOENT/);
    });
  }
});

test("stale source와 unresolved #8/#9 denominator를 NO_GO gate로 보존한다", async (t) => {
  const stale = await createFixture(t, { evaluationAt: STALE_AT });
  const staleOutput = path.join(stale.temp, "stale");
  await build(stale, staleOutput, STALE_AT);
  const staleFinal = await readJson(path.join(staleOutput, "server-route-bundle-final.json"));
  assert.equal(staleFinal.gates.sourceFreshness.state, "STALE");
  assert.ok(staleFinal.blockers.includes("sourceFreshness:STALE"));

  // #866 PR-C: 경로가 요구하는 cell(환승 끝점 TRANSFER) 하나를 지운다. 승강장 기준 입력이라 EXIT 행은 원래 없다.
  const configurePlatform = configurePlatformInputs();
  const incomplete = await createFixture(t, {
    configureInputs: (inputs) => {
      configurePlatform(inputs);
      inputs.stationLineInput.evidenceRows = inputs.stationLineInput.evidenceRows.filter((row) => !(
        row.stationId === "station-a" && row.lineId === "line-1" && row.domain === "TRANSFER"
      ));
    },
  });
  const incompleteOutput = path.join(incomplete.temp, "incomplete");
  await build(incomplete, incompleteOutput, FRESH_AT);
  const incompleteFinal = await readJson(path.join(incompleteOutput, "server-route-bundle-final.json"));
  assert.equal(incompleteFinal.gates.stationLineAccessibility.state, "MISSING");
  assert.equal(incompleteFinal.gates.routeEdgeEvaluation.state, "MISSING");
  assert.ok(incompleteFinal.blockers.includes("stationLineAccessibility:MISSING"));
  assert.ok(incompleteFinal.blockers.includes("routeEdgeEvaluation:MISSING"));
  const materialization = await readJson(path.join(incompleteOutput, "station-line-accessibility.json"));
  const evaluation = await readJson(path.join(incompleteOutput, "route-edge-evaluation.json"));
  // EXIT 3개(역-노선 3개, 증거 행 없음)와 지운 환승 끝점 TRANSFER 1개가 MISSING이다. 게이트는 환승 끝점만 본다.
  assert.equal(materialization.stateSummary.MISSING, 4);
  assert.equal(evaluation.denominator.edgeCount, incomplete.routeEdgeInput.routeEdges.length);
  assert.equal(evaluation.stateSummary.MISSING, 2);
});

test("evidence observation time이 candidate publishedAt보다 이전일 때 candidate publishedAt 기준으로 source freshness를 평가한다", async (t) => {
  const fixture = await createFixture(t);
  const output = path.join(fixture.temp, "published-at-freshness");
  await build(fixture, output, FRESH_AT);
  const final = await readJson(path.join(output, "server-route-bundle-final.json"));
  assert.equal(final.gates.sourceFreshness.state, "PASS");
  const freshness = await readJson(path.join(output, "source-freshness.json"));
  assert.equal(freshness.state, "PASS");
  if (Date.parse(fixture.buildSpec.publishedAt) > Date.parse(FRESH_AT)) {
    assert.equal(freshness.evaluationAt, fixture.buildSpec.publishedAt);
  }
});

test("artifact와 candidate identity mismatch는 output 전에 fail closed한다", async (t) => {
  for (const [name, mutate, pattern] of [
    ["component-digest", async (fixture) => {
      const manifest = await readJson(path.join(fixture.artifactRoot, "manifest.signing-input.json"));
      manifest.topologySha256 = "f".repeat(64);
      await writeCanonical(path.join(fixture.artifactRoot, "manifest.signing-input.json"), manifest);
    }, /topology payload digest mismatch/],
    ["station-identity", async (fixture) => {
      fixture.stationLineInput.candidate.stationSetSha256 = "f".repeat(64);
    }, /station set identity mismatch/],
    ["route-station-scope", async (fixture) => {
      fixture.routeEdgeInput.candidate.stationSetSha256 = "f".repeat(64);
    }, /route-edge station-line candidate station set identity mismatch/],
    ["both-station-route-scope", async (fixture) => {
      fixture.stationLineInput.candidate.stationSetSha256 = "f".repeat(64);
      fixture.routeEdgeInput.candidate.stationSetSha256 = "f".repeat(64);
    }, /station-line scoped station set identity mismatch/],
    ["source-identity", async (fixture) => {
      fixture.routeEdgeInput.candidate.sourceSetSha256 = "f".repeat(64);
    }, /source set identity mismatch/],
    ["topology-identity", async (fixture) => {
      fixture.routeEdgeInput.candidate.topologySha256 = "f".repeat(64);
    }, /topology identity mismatch/],
    ["git-identity", async (fixture) => {
      fixture.repositoryGitSha = "f".repeat(40);
    }, /repositoryGitSha does not match repository HEAD/],
    ["bundle-identity", async (fixture) => {
      const provenancePath = path.join(fixture.artifactRoot, "provenance.json");
      const provenance = await readJson(provenancePath);
      provenance.bundleId = "other-bundle";
      await writeCanonical(provenancePath, provenance);
    }, /bundle identity mismatch/],
    ["release-identity", async (fixture) => {
      const compatibilityPath = path.join(fixture.artifactRoot, "compatibility.json");
      const compatibility = await readJson(compatibilityPath);
      compatibility.releaseSequence = 2;
      await writeCanonical(compatibilityPath, compatibility);
    }, /release sequence identity mismatch/],
    ["time-identity", async (fixture) => {
      const provenancePath = path.join(fixture.artifactRoot, "provenance.json");
      const provenance = await readJson(provenancePath);
      provenance.freshUntil = "2026-08-08T07:00:00.000+09:00";
      await writeCanonical(provenancePath, provenance);
    }, /freshUntil identity mismatch/],
    ["missing-file", async (fixture) => {
      await rm(path.join(fixture.artifactRoot, "payload/fare.sqlite.zst"));
    }, /artifact payload file set mismatch/],
    ["extra-file", async (fixture) => {
      await writeFile(path.join(fixture.artifactRoot, "payload/extra.sqlite.zst"), "extra");
    }, /artifact payload file set mismatch/],
    ["empty-file", async (fixture) => {
      await writeFile(path.join(fixture.artifactRoot, "payload/fare.sqlite.zst"), Buffer.alloc(0));
    }, /artifact file must be non-empty/],
    ["symlink-file", async (fixture) => {
      const target = path.join(fixture.temp, "topology-target");
      const source = path.join(fixture.artifactRoot, "payload/topology.sqlite.zst");
      await rename(source, target);
      await symlink(target, source);
    }, /artifact file must be a regular non-symlink/],
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture(t);
      const output = path.join(fixture.temp, `rejected-${name}`);
      await mutate(fixture);
      await assert.rejects(() => build(fixture, output, FRESH_AT), pattern);
      await assert.rejects(() => readFile(output), /ENOENT/);
      assert.deepEqual((await readdir(fixture.temp)).filter((entry) => entry.startsWith(".server-route-final-")), []);
    });
  }
});

test("occupied output을 교체하지 않고 기존 bytes를 보존한다", async (t) => {
  const fixture = await createFixture(t);
  const output = path.join(fixture.temp, "occupied");
  await writeFile(output, "owner bytes");
  await assert.rejects(() => build(fixture, output, FRESH_AT), /output must not already exist/);
  assert.equal(await readFile(output, "utf8"), "owner bytes");
  const ownerTarget = path.join(fixture.temp, "owner-target");
  const symlinkOutput = path.join(fixture.temp, "occupied-symlink");
  await writeFile(ownerTarget, "owner symlink bytes");
  await symlink(ownerTarget, symlinkOutput);
  await assert.rejects(() => build(fixture, symlinkOutput, FRESH_AT), /output must not already exist/);
  assert.equal(await readFile(ownerTarget, "utf8"), "owner symlink bytes");
  assert.deepEqual((await readdir(fixture.temp)).filter((entry) => entry.startsWith(".server-route-final-")), []);
});

test("standalone CLI도 exact inputs로 같은 FINAL을 생성한다", async (t) => {
  const fixture = await createFixture(t);
  const stationLineInputPath = path.join(fixture.temp, "station-line-input.json");
  const routeEdgeInputPath = path.join(fixture.temp, "route-edge-input.json");
  const output = path.join(fixture.temp, "cli-output");
  await writeFile(stationLineInputPath, canonicalJson(fixture.stationLineInput));
  await writeFile(routeEdgeInputPath, canonicalJson(fixture.routeEdgeInput));

  const result = spawnSync(process.execPath, [
    SCRIPT,
    "--artifact-root", fixture.artifactRoot,
    "--station-line-input", stationLineInputPath,
    "--route-edge-input", routeEdgeInputPath,
    "--repository-git-sha", fixture.repositoryGitSha,
    "--evaluation-at", FRESH_AT,
    "--output", output,
  ], { cwd: fixture.repositoryRoot, encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^NO_GO [a-f0-9]{64}\n$/);
  const final = JSON.parse(await readFile(path.join(output, "server-route-bundle-final.json"), "utf8"));
  assert.doesNotThrow(() => validateServerRouteBundleFinal(final));

  await writeFile(stationLineInputPath, JSON.stringify(fixture.stationLineInput, null, 2));
  const rejectedOutput = path.join(fixture.temp, "noncanonical-cli-output");
  const rejected = spawnSync(process.execPath, [
    SCRIPT,
    "--artifact-root", fixture.artifactRoot,
    "--station-line-input", stationLineInputPath,
    "--route-edge-input", routeEdgeInputPath,
    "--repository-git-sha", fixture.repositoryGitSha,
    "--evaluation-at", FRESH_AT,
    "--output", rejectedOutput,
  ], { cwd: fixture.repositoryRoot, encoding: "utf8" });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /station-line input must be canonical JSON/);
  await assert.rejects(() => readFile(rejectedOutput), /ENOENT/);
});

test("standalone CLI release mode는 exact evidence set만 받아 GO를 생성한다", async (t) => {
  installSigningEnvironment(t);
  const { fixture, releaseEvidence } = await prepareSignedReleaseFixture(t);
  const clockPath = path.join(fixture.temp, "release-cli-clock.mjs");
  await writeFile(clockPath, `Date.now = () => ${Date.parse(FRESH_AT)};\n`);
  const stationLineInputPath = path.join(fixture.temp, "release-station-line-input.json");
  const routeEdgeInputPath = path.join(fixture.temp, "release-route-edge-input.json");
  await writeFile(stationLineInputPath, canonicalJson(fixture.stationLineInput));
  await writeFile(routeEdgeInputPath, canonicalJson(fixture.routeEdgeInput));
  const output = path.join(fixture.temp, "release-cli-output");
  const baseArgs = [
    SCRIPT,
    "--artifact-root", fixture.artifactRoot,
    "--station-line-input", stationLineInputPath,
    "--route-edge-input", routeEdgeInputPath,
    "--repository-git-sha", fixture.repositoryGitSha,
    "--evaluation-at", FRESH_AT,
    "--output", output,
    "--eligibility-report", releaseEvidence.eligibilityReportPath,
    "--publication-receipt", releaseEvidence.publicationReceiptPath,
    "--promotion-request", releaseEvidence.promotionRequestPath,
    "--promotion-component", releaseEvidence.promotionComponentPath,
    "--promotion-inventory", releaseEvidence.promotionInventoryPath,
    "--compatibility-evidence", releaseEvidence.compatibilityEvidencePath,
    "--candidate-execution-evidence-root", releaseEvidence.candidateExecutionEvidenceRoot,
    "--approval-evidence", releaseEvidence.approvalEvidencePath,
    "--promotion-workflow-run-id", releaseEvidence.promotionWorkflowRunId,
  ];
  const result = spawnSync(process.execPath, ["--import", clockPath, ...baseArgs], {
    cwd: fixture.repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^GO [a-f0-9]{64}\n$/);
  const final = await readJson(path.join(output, "server-route-bundle-final.json"));
  assert.equal(final.result, "GO");

  const rejectedOutput = path.join(fixture.temp, "partial-release-cli-output");
  const partialArgs = baseArgs.slice(0, -2);
  partialArgs[partialArgs.indexOf("--output") + 1] = rejectedOutput;
  const partial = spawnSync(process.execPath, ["--import", clockPath, ...partialArgs], {
    cwd: fixture.repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(partial.status, 1);
  assert.match(partial.stderr, /CLI arguments mismatch/);
  await assert.rejects(() => readFile(rejectedOutput), /ENOENT/);
});

test("seed topology candidate input is accepted and bound to artifact topology", async (t) => {
  const fixture = await createFixture(t);
  const rides = fixture.routeEdgeInput.routeEdges.filter(({ edgeType }) => edgeType === "RIDE");
  fixture.routeEdgeInput.candidate.topologySha256 = canonicalRideEdgeSetSha256(rides);
  const output = path.join(fixture.temp, "seed-topology-output");
  await build(fixture, output, FRESH_AT);
  const finalJson = await readJson(path.join(output, "server-route-bundle-final.json"));
  assert.equal(finalJson.candidate.bundleId, fixture.manifest.bundleId);
  assert.equal(finalJson.candidate.componentDigests.topology, fixture.manifest.topologySha256);
});

test("server route bundle decompressed budget enforces limit and fails closed without output", async (t) => {
  const fixture = await createFixture(t);
  const output = path.join(fixture.temp, "budget-fail-output");
  await assert.rejects(
    () => buildServerRouteBundleFinalEvidence({
      repositoryRoot: fixture.repositoryRoot,
      repositoryGitSha: fixture.repositoryGitSha,
      artifactRoot: fixture.artifactRoot,
      stationLineInput: fixture.stationLineInput,
      routeEdgeInput: fixture.routeEdgeInput,
      evaluationAt: FRESH_AT,
      output,
      maxTotalDecompressedBytes: 100,
    }),
    (err) => {
      assert.equal(err.code, E_SERVER_BUNDLE_DECOMPRESSED_BUDGET);
      return true;
    },
  );
  await assert.rejects(() => readFile(output), /ENOENT/);
});

test("server route bundle decompressed budget records accurate component bytes and passes at exact limit", async (t) => {
  const fixture = await createFixture(t);
  const output = path.join(fixture.temp, "budget-exact-output");

  const accessibilityBytes = zstdDecompressSync(await readFile(path.join(fixture.artifactRoot, "payload/accessibility.sqlite.zst"))).length;
  const fareBytes = 12; // "fare payload"
  const timetableBytes = 17; // "timetable payload"
  const topologyBytes = zstdDecompressSync(await readFile(path.join(fixture.artifactRoot, "payload/topology.sqlite.zst"))).length;
  const exactTotal = accessibilityBytes + fareBytes + timetableBytes + topologyBytes;

  await buildServerRouteBundleFinalEvidence({
    repositoryRoot: fixture.repositoryRoot,
    repositoryGitSha: fixture.repositoryGitSha,
    artifactRoot: fixture.artifactRoot,
    stationLineInput: fixture.stationLineInput,
    routeEdgeInput: fixture.routeEdgeInput,
    evaluationAt: FRESH_AT,
    output,
    maxTotalDecompressedBytes: exactTotal,
  });

  const inventory = await readJson(path.join(output, "artifact-inventory.json"));
  assert.deepEqual(inventory.decompressedBudget, {
    components: {
      accessibility: accessibilityBytes,
      fare: 12,
      timetable: 17,
      topology: topologyBytes,
    },
    totalBytes: exactTotal,
    maxTotalBytes: exactTotal,
    headroomBytes: 0,
    headroomRatio: 0,
  });
});

async function createFixture(t, options = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "server-route-final-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const repositoryRoot = path.join(temp, "repository");
  await copyRepositoryInputs(repositoryRoot);
  const policyPath = path.join(repositoryRoot, "release/product-gates/route-edge-evaluation-policy.json");
  const policy = await readJson(policyPath);
  const specPath = path.join(repositoryRoot, "tools/datapack/release/candidate-build-spec.json");
  const buildSpec = await readJson(specPath);
  if (options.configureBuildSpec) {
    options.configureBuildSpec(buildSpec);
    await writeFile(specPath, `${JSON.stringify(buildSpec, null, 2)}\n`);
  }
  const artifactRoot = path.join(temp, "server-route-bundle");
  const buildContract = await readJson(path.join(repositoryRoot, "contracts/datapack/server-route-bundle-build-contract.json"));
  const topologyBytes = zstdCompressSync(await fixtureTopologySqliteBytes(), {
    params: {
      [constants.ZSTD_c_compressionLevel]: buildContract.compressionProfile.compressionLevel,
      [constants.ZSTD_c_checksumFlag]: buildContract.compressionProfile.checksumFlag,
    },
  });
  const stationLineInput = completeStationLineInput(buildSpec.sourceSnapshotSetHash, buildSpec.candidateId);
  const routeEdgeInput = completeRouteEdgeInput(
    buildSpec.sourceSnapshotSetHash,
    sha256(topologyBytes),
    buildSpec.candidateId,
  );
  options.configureInputs?.({ stationLineInput, routeEdgeInput });
  policy.rideInvariant.subwayLocal.admittedEdgeSetSha256 = canonicalRideEdgeSetSha256(
    routeEdgeInput.routeEdges.filter(({ edgeType, serviceClass, servicePattern }) => edgeType === "RIDE" && serviceClass === "SUBWAY" && servicePattern === "LOCAL"),
  );
  policy.rideInvariant.itxCheongchunExpress.admittedEdgeSetSha256 = canonicalRideEdgeSetSha256(
    routeEdgeInput.routeEdges.filter(({ edgeType, serviceClass }) => edgeType === "RIDE" && serviceClass === "ITX_CHEONGCHUN"),
  );
  await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
  const repositoryGitSha = initializeRepository(repositoryRoot);
  const { manifest } = await createArtifact(
    repositoryRoot,
    artifactRoot,
    buildSpec,
    stationLineInput,
    routeEdgeInput,
    options.evaluationAt ?? FRESH_AT,
    options.freshUntil ?? (await selectedSourceWindow(repositoryRoot)).freshUntil,
  );
  return { temp, repositoryRoot, repositoryGitSha, artifactRoot, buildSpec, manifest, stationLineInput, routeEdgeInput };
}

async function copyRepositoryInputs(repositoryRoot) {
  for (const relative of [
    "contracts/datapack/artifact-component-table-layout.json",
    "contracts/datapack/server-route-bundle-build-contract.json",
    "release/product-gates/datapack-freshness-sla.json",
    "release/product-gates/route-edge-evaluation-policy.json",
    "tools/datapack/release/candidate-build-spec.json",
    "tools/datapack/release/source-snapshots.json",
    "tools/datapack/schema/catalog-schema.sql",
    "tools/datapack/source-governance-policy.json",
    "tools/datapack/source-inventory.json",
  ]) {
    await mkdir(path.dirname(path.join(repositoryRoot, relative)), { recursive: true });
    await cp(relative, path.join(repositoryRoot, relative));
  }
  // 운영 후보 재생 대신 독립 source 입력으로 실제 FINAL 검증 경계를 실행한다.
  const specPath = path.join(repositoryRoot, "tools/datapack/release/candidate-build-spec.json");
  const fixture = await createIndependentSourceGovernanceFixture({
    repositoryRoot, buildSpec: await readJson(specPath),
  });
  await writeFile(specPath, JSON.stringify(fixture.buildSpec));
  await writeFile(path.join(repositoryRoot, fixture.buildSpec.sourceSnapshotEvidencePath), JSON.stringify(fixture.snapshots));
}

async function selectedSourceWindow(repositoryRoot = process.cwd()) {
  const fixture = await createIndependentSourceGovernanceFixture({
    repositoryRoot,
    buildSpec: await readJson(path.join(repositoryRoot, "tools/datapack/release/candidate-build-spec.json")),
  });
  const buildSpec = fixture.buildSpec, sourceSnapshots = fixture.snapshots;
  const selected = buildSpec.sourceSnapshotIds.map((snapshotId) => {
    const matches = sourceSnapshots.filter((entry) => entry.snapshotId === snapshotId);
    assert.equal(matches.length, 1, `selected source snapshot identity: ${snapshotId}`);
    return matches[0];
  });
  const basisAt = Math.max(...selected.flatMap((entry) => [
    entry.retrievedAt,
    entry.sourceUpdatedAt,
    entry.rawReceipt?.storedAt,
  ].filter(Boolean).map(Date.parse)));
  const freshUntil = Math.min(...selected.map(({ freshnessExpiresAt }) => Date.parse(freshnessExpiresAt)));
  const evaluationAt = new Date(fixture.evaluationAt);
  assert.ok(Number.isFinite(basisAt) && Number.isFinite(freshUntil) && evaluationAt.getTime() < freshUntil);
  return {
    evaluationAt: evaluationAt.toISOString(),
    evidenceFreshUntil: new Date(freshUntil).toISOString(),
    freshUntil: kstInstant(freshUntil),
    staleAt: new Date(freshUntil + 1).toISOString(),
  };
}

function kstInstant(milliseconds) {
  return new Date(milliseconds + 9 * 60 * 60 * 1_000).toISOString().replace("Z", "+09:00");
}

function sharedEvidenceWindowObservedAt(evidenceRows) {
  const capturedAt = Math.max(...evidenceRows.map(({ capturedAt: value }) => Date.parse(value)));
  const freshUntil = Math.min(...evidenceRows.map(({ freshUntil: value }) => Date.parse(value)));
  assert.ok(Number.isFinite(capturedAt) && Number.isFinite(freshUntil) && capturedAt < freshUntil,
    "shared evidence window is empty");
  return new Date(capturedAt + 1).toISOString();
}

async function createArtifact(
  repositoryRoot,
  artifactRoot,
  buildSpec,
  stationLineInput,
  routeEdgeInput,
  evaluationAt,
  freshUntil = CURRENT_SOURCE_WINDOW.freshUntil,
) {
  const routePolicy = await readJson(path.join(repositoryRoot, "release/product-gates/route-edge-evaluation-policy.json"));
  const materialization = materializeStationLineAccessibility({ ...stationLineInput, observedAt: evaluationAt });
  const evaluation = evaluateRouteAccessibilityEdges({
    ...routeEdgeInput,
    candidate: { ...routeEdgeInput.candidate, stationSetSha256: STATION_SET_SHA256 },
    evaluationAt,
    materialization,
  }, routePolicy);
  await mkdir(artifactRoot, { recursive: true });
  const accessibilitySqlite = path.join(artifactRoot, ".accessibility.sqlite");
  const accessibilityDatabase = new DatabaseSync(accessibilitySqlite);
  accessibilityDatabase.exec(Object.values(GENERATED_ACCESSIBILITY_EVIDENCE_TABLE_DDL).join("; "));
  accessibilityDatabase.prepare("INSERT INTO station_line_accessibility_evidence VALUES(?,?)").run(
    materialization.materializationDigest,
    canonicalStationLineAccessibilityJson(materialization),
  );
  accessibilityDatabase.prepare("INSERT INTO route_accessibility_edge_evidence VALUES(?,?,?)").run(
    evaluation.evaluationDigest,
    materialization.materializationDigest,
    canonicalRouteEdgeEvaluationJson(evaluation),
  );
  // #827 fixture: station-a/line-1의 연결 완전 경로 1개와 승강장 노드(station-a:line-1) 요구 행(#873).
  accessibilityDatabase.exec(`
    CREATE TABLE facilities (id TEXT NOT NULL PRIMARY KEY);
    INSERT INTO facilities VALUES('${FIXTURE_EXIT_ELEVATOR}'), ('${FIXTURE_DIRECTION_ELEVATOR}');
    INSERT INTO station_elevator_path VALUES('${FIXTURE_PATH_ID}','station-a','line-1','station-b','1','나역',1,'1) 1번 출입구 엘리베이터로 이동');
    INSERT INTO station_elevator_path_facility VALUES('${FIXTURE_PATH_ID}','EXIT','${FIXTURE_EXIT_ELEVATOR}'), ('${FIXTURE_PATH_ID}','DIRECTION','${FIXTURE_DIRECTION_ELEVATOR}');
    INSERT INTO transition_facility_requirement VALUES
      ('station-a:line-1','${FIXTURE_PATH_ID}','station-b','EXIT_ELEVATORS','${FIXTURE_EXIT_ELEVATOR}'),
      ('station-a:line-1','${FIXTURE_PATH_ID}','station-b','PLATFORM_DIRECTION_ELEVATORS','${FIXTURE_DIRECTION_ELEVATOR}');
  `);
  accessibilityDatabase.exec("PRAGMA user_version=19; VACUUM");
  accessibilityDatabase.close();
  const buildContract = await readJson(path.join(repositoryRoot, "contracts/datapack/server-route-bundle-build-contract.json"));
  const compress = (buf) => zstdCompressSync(buf, {
    params: {
      [constants.ZSTD_c_compressionLevel]: buildContract.compressionProfile.compressionLevel,
      [constants.ZSTD_c_checksumFlag]: buildContract.compressionProfile.checksumFlag,
    },
  });
  const payloads = {
    accessibility: compress(await readFile(accessibilitySqlite)),
    fare: compress(Buffer.from("fare payload")),
    timetable: compress(Buffer.from("timetable payload")),
    topology: compress(await fixtureTopologySqliteBytes()),
  };
  await mkdir(path.join(artifactRoot, "payload"), { recursive: true });
  for (const [name, bytes] of Object.entries(payloads)) {
    await writeFile(path.join(artifactRoot, `payload/${name}.sqlite.zst`), bytes);
  }
  await rm(accessibilitySqlite);

  const buildSpecBytes = await readFile(path.join(repositoryRoot, "tools/datapack/release/candidate-build-spec.json"));
  const layout = await readJson(path.join(repositoryRoot, "contracts/datapack/artifact-component-table-layout.json"));
  const provenance = {
    schemaVersion: 1,
    artifactKind: "server-route-bundle-provenance",
    bundleId: BUNDLE_ID,
    releaseSequence: 1,
    stationSetSha256: STATION_SET_SHA256,
    serviceTimezone: "Asia/Seoul",
    activeFrom: "2026-08-15T00:34:07.000+09:00",
    freshUntil,
    builtAt: FRESH_AT,
    buildSpecSha256: sha256(buildSpecBytes),
    sourceSnapshotSetHash: buildSpec.sourceSnapshotSetHash,
    sourceInventorySha256: buildSpec.sourceInventorySha256,
    sourceSnapshotIds: [...new Set(buildSpec.sourceSnapshotIds)].sort(bytewise),
  };
  const compatibility = {
    schemaVersion: 1,
    artifactKind: "server-route-bundle-compatibility",
    bundleId: BUNDLE_ID,
    releaseSequence: 1,
    stationSetSha256: STATION_SET_SHA256,
    serviceTimezone: "Asia/Seoul",
    manifestVersion: 1,
    tableLayoutSchemaVersion: layout.schemaVersion,
    sourceSchemaPath: layout.serverRouteBundle.sourceSchema.path,
    sourceSqliteUserVersion: layout.serverRouteBundle.sourceSchema.sqliteUserVersion,
    sourceSchemaSha256: layout.serverRouteBundle.sourceSchema.sha256,
    schemaCompatibility: buildContract.manifestLifecycle.schemaCompatibility,
    compressionProfile: buildContract.compressionProfile,
    encoderRuntime: { node: process.versions.node, zstd: process.versions.zstd },
  };
  const provenanceBytes = Buffer.from(canonicalJson(provenance));
  const compatibilityBytes = Buffer.from(canonicalJson(compatibility));
  await writeFile(path.join(artifactRoot, "provenance.json"), provenanceBytes);
  await writeFile(path.join(artifactRoot, "compatibility.json"), compatibilityBytes);
  const entries = Object.entries(payloads).map(([name, bytes]) => ({
    path: `payload/${name}.sqlite.zst`, sizeBytes: bytes.length, sha256: sha256(bytes),
  })).sort((left, right) => bytewise(left.path, right.path));
  const manifest = {
    manifestVersion: 1,
    artifactKind: "server-route-bundle",
    bundleId: BUNDLE_ID,
    releaseSequence: 1,
    stationSetSha256: STATION_SET_SHA256,
    payloadSha256: sha256(Buffer.from(canonicalJson(entries))),
    topologySha256: sha256(payloads.topology),
    timetableSha256: sha256(payloads.timetable),
    accessibilitySha256: sha256(payloads.accessibility),
    fareSha256: sha256(payloads.fare),
    provenanceSha256: sha256(provenanceBytes),
    compatibilitySha256: sha256(compatibilityBytes),
    serviceTimezone: "Asia/Seoul",
    activeFrom: provenance.activeFrom,
    freshUntil: provenance.freshUntil,
    schemaCompatibility: buildContract.manifestLifecycle.schemaCompatibility,
    keyId: "production-v1",
  };
  await writeCanonical(path.join(artifactRoot, "manifest.signing-input.json"), manifest);
  return { manifest, provenance, compatibility };
}

async function rebindPayloadManifest(artifactRoot) {
  const manifestPath = path.join(artifactRoot, "manifest.signing-input.json");
  const manifest = await readJson(manifestPath);
  const entries = [];
  for (const component of ["accessibility", "fare", "timetable", "topology"]) {
    const bytes = await readFile(path.join(artifactRoot, `payload/${component}.sqlite.zst`));
    const digest = sha256(bytes);
    manifest[`${component}Sha256`] = digest;
    entries.push({ path: `payload/${component}.sqlite.zst`, sizeBytes: bytes.length, sha256: digest });
  }
  manifest.payloadSha256 = sha256(Buffer.from(canonicalJson(entries.sort((left, right) => bytewise(left.path, right.path)))));
  await writeCanonical(manifestPath, manifest);
}

// #951: FINAL은 간선 출처 칸과 transfer_rules도 읽으므로 fixture topology도 그 칸을 가진다(원천 근거 없는 간선은 UNKNOWN 기본값).
const TOPOLOGY_FIXTURE_DDL = [
  "CREATE TABLE network_edges (id TEXT PRIMARY KEY, from_node_id TEXT NOT NULL, to_node_id TEXT NOT NULL, duration_seconds INTEGER NOT NULL DEFAULT 0, edge_type TEXT NOT NULL, includes_stairs INTEGER NOT NULL, stair_access_state TEXT NOT NULL, source_id TEXT NOT NULL DEFAULT '', source_snapshot_id TEXT NOT NULL DEFAULT '', provider_record_hash TEXT NOT NULL DEFAULT '', provenance_kind TEXT NOT NULL DEFAULT 'UNKNOWN', verification_status TEXT NOT NULL DEFAULT 'UNKNOWN', last_verified_at INTEGER, evidence_hash TEXT NOT NULL DEFAULT '')",
  "CREATE TABLE transfer_rules (id TEXT PRIMARY KEY, from_station_id TEXT NOT NULL, from_line_id TEXT NOT NULL, to_station_id TEXT NOT NULL, to_line_id TEXT NOT NULL, min_transfer_seconds INTEGER NOT NULL DEFAULT 0, source_id TEXT NOT NULL DEFAULT '', verification_status TEXT NOT NULL DEFAULT 'UNKNOWN')",
].join("; ");

// #944 F4: FINAL이 topology network_edges를 읽으므로 fixture topology도 실제 SQLite다(역 안 환승 STEP_FREE 없음).
async function fixtureTopologySqliteBytes() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "server-route-final-topology-"));
  try {
    const file = path.join(directory, "topology.sqlite");
    const database = new DatabaseSync(file);
    database.exec(TOPOLOGY_FIXTURE_DDL);
    database.exec("INSERT INTO network_edges(id,from_node_id,to_node_id,edge_type,includes_stairs,stair_access_state) VALUES('ride-0000','station-a:line-1','station-b:line-1','RIDE',0,'UNKNOWN'); PRAGMA user_version=19; VACUUM");
    database.close();
    return await readFile(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function mutateTopologyPayload(fixture, sql) {
  const topologyPath = path.join(fixture.artifactRoot, "payload/topology.sqlite.zst");
  const sqlitePath = path.join(fixture.temp, "mutated-topology.sqlite");
  await writeFile(sqlitePath, zstdDecompressSync(await readFile(topologyPath)));
  const database = new DatabaseSync(sqlitePath);
  database.exec(sql);
  database.close();
  const buildContract = await readJson(path.join(fixture.repositoryRoot, "contracts/datapack/server-route-bundle-build-contract.json"));
  await writeFile(topologyPath, zstdCompressSync(await readFile(sqlitePath), {
    params: {
      [constants.ZSTD_c_compressionLevel]: buildContract.compressionProfile.compressionLevel,
      [constants.ZSTD_c_checksumFlag]: buildContract.compressionProfile.checksumFlag,
    },
  }));
  await rebindPayloadManifest(fixture.artifactRoot);
  fixture.routeEdgeInput.candidate.topologySha256 = sha256(await readFile(topologyPath));
}

async function mutateAccessibilityPayload(fixture, sql) {
  const accessibilityPath = path.join(fixture.artifactRoot, "payload/accessibility.sqlite.zst");
  const sqlitePath = path.join(fixture.temp, "mutated-accessibility.sqlite");
  await writeFile(sqlitePath, zstdDecompressSync(await readFile(accessibilityPath)));
  const database = new DatabaseSync(sqlitePath);
  database.exec(sql);
  database.close();
  const buildContract = await readJson(path.join(fixture.repositoryRoot, "contracts/datapack/server-route-bundle-build-contract.json"));
  await writeFile(accessibilityPath, zstdCompressSync(await readFile(sqlitePath), {
    params: {
      [constants.ZSTD_c_compressionLevel]: buildContract.compressionProfile.compressionLevel,
      [constants.ZSTD_c_checksumFlag]: buildContract.compressionProfile.checksumFlag,
    },
  }));
  await rebindPayloadManifest(fixture.artifactRoot);
}

function completeStationLineInput(sourceSetSha256, candidateId) {
  const candidate = {
    candidateId,
    stationSetSha256: SCOPED_STATION_SET_SHA256,
    sourceSetSha256,
    mappingContractVersion: "station-line-v1",
    materializerVersion: "1",
  };
  const stationLines = [
    { stationId: "station-a", lineId: "line-1", operatorId: "operator-1" },
    { stationId: "station-b", lineId: "line-1", operatorId: "operator-1" },
  ];
  const evidenceRows = stationLines.flatMap((line) => [
    evidence(candidate, line, "FACILITY", "VERIFIED_PRESENT", "OBSERVED", "official facility"),
    evidence(candidate, line, "EXIT", "VERIFIED_ABSENT", "EXPLICIT_ZERO", "official zero exit"),
    evidence(candidate, line, "TRANSFER", "NOT_APPLICABLE", "CURRENT_APPLICABILITY_RULE", "no transfer boundary"),
  ]);
  return { candidate, stationLines, evidenceRows };
}

function evidence(candidate, line, domain, state, evidenceKind, evidenceReason) {
  return {
    ...candidate,
    ...line,
    domain,
    state,
    sourceId: "official-accessibility",
    sourceSnapshotId: "official-accessibility-20260813",
    evidenceRawSha256: "b".repeat(64),
    providerRecordHash: "c".repeat(64),
    capturedAt: FRESH_AT,
    freshUntil: CURRENT_SOURCE_WINDOW.evidenceFreshUntil,
    provenanceId: "official-provider",
    licenseId: "public-data-license",
    evidenceKind,
    evidenceReason,
  };
}

// #873 승강장 기준 입력: ENTRY/EXIT 간선과 EXIT 증거 행이 없다. station-a에 역 안 환승(line-1↔line-2)이 있고,
// 환승이 쓰지 않는 cell(station-b·station-a:line-2 FACILITY)은 UNKNOWN이다.
function configurePlatformInputs({ transferEndpointState = "VERIFIED_PRESENT" } = {}) {
  return ({ stationLineInput, routeEdgeInput }) => {
    const extra = { stationId: "station-a", lineId: "line-2", operatorId: "operator-2" };
    const candidate = stationLineInput.candidate;
    const unknown = (line, domain) => evidence(candidate, line, domain, "UNKNOWN", "PROVIDER_NO_DATA", "provider no data");
    const present = (line, domain) => evidence(candidate, line, domain, "VERIFIED_PRESENT", "OBSERVED", "official transfer");
    stationLineInput.stationLines.push(extra);
    stationLineInput.evidenceRows = [
      ...stationLineInput.evidenceRows
        .filter(({ domain }) => domain !== "EXIT")
        .map((row) => {
          if (row.stationId === "station-b" && row.domain === "FACILITY") return unknown(row, "FACILITY");
          if (row.stationId === "station-a" && row.domain === "TRANSFER") return present(row, "TRANSFER");
          return row;
        }),
      unknown(extra, "FACILITY"),
      transferEndpointState === "VERIFIED_PRESENT" ? present(extra, "TRANSFER") : unknown(extra, "TRANSFER"),
    ];
    routeEdgeInput.stationLines.push({ ...extra, lineSequence: 1 });
    routeEdgeInput.routeEdges = [
      ...routeEdgeInput.routeEdges.filter(({ edgeType }) => edgeType !== "ENTRY" && edgeType !== "EXIT"),
      edge({ edgeId: "transfer-a-1-2", edgeType: "IN_STATION_TRANSFER", fromNodeId: "station-a:line-1", toNodeId: "station-a:line-2", durationSeconds: 90, distanceMeters: 100 }),
      edge({ edgeId: "transfer-a-2-1", edgeType: "IN_STATION_TRANSFER", fromNodeId: "station-a:line-2", toNodeId: "station-a:line-1", durationSeconds: 90, distanceMeters: 100 }),
    ];
  };
}

function completeRouteEdgeInput(sourceSetSha256, topologySha256, candidateId) {
  const candidate = {
    candidateId,
    stationSetSha256: SCOPED_STATION_SET_SHA256,
    sourceSetSha256,
    topologySha256,
    policyVersion: "route-edge-evaluation-v2",
    evaluatorVersion: "1",
  };
  const stationLines = [
    { stationId: "station-a", lineId: "line-1", operatorId: "operator-1", lineSequence: 1 },
    { stationId: "station-b", lineId: "line-1", operatorId: "operator-1", lineSequence: 2 },
  ];
  return {
    candidate,
    stationLines,
    routeEdges: [
      ...Array.from({ length: 2220 }, (_, index) => edge({
        edgeId: `ride-${String(index).padStart(4, "0")}`,
        edgeType: "RIDE",
        fromNodeId: index % 2 === 0 ? "station-a:line-1" : "station-b:line-1",
        toNodeId: index % 2 === 0 ? "station-b:line-1" : "station-a:line-1",
        durationSeconds: 120,
        distanceMeters: 1000,
        servicePattern: "LOCAL",
      })),
    ],
  };
}

function edge(value) {
  const raw = {
    edgeId: value.edgeId,
    edgeType: value.edgeType,
    fromNodeId: value.fromNodeId,
    toNodeId: value.toNodeId,
    durationSeconds: value.durationSeconds ?? 0,
    distanceMeters: value.distanceMeters ?? 0,
    servicePattern: value.servicePattern ?? "",
    serviceClass: value.serviceClass ?? "SUBWAY",
  };
  return { ...raw, edgeSha256: routeEdgeSha256(raw) };
}

async function createReleaseEvidence(fixture, prePublicationFinal) {
  const objectPrefix = `server-route-bundles/v1/${prePublicationFinal.candidate.signedManifestRawSha256}/`;
  const signedPaths = [
    "compatibility.json",
    "manifest.json",
    "manifest.signing-input.json",
    "payload/accessibility.sqlite.zst",
    "payload/fare.sqlite.zst",
    "payload/timetable.sqlite.zst",
    "payload/topology.sqlite.zst",
    "provenance.json",
  ];
  const objects = [];
  for (const entryPath of signedPaths) {
    const bytes = await readFile(path.join(fixture.artifactRoot, entryPath));
    objects.push({
      path: entryPath,
      objectKey: `${objectPrefix}${entryPath}`,
      sizeBytes: bytes.length,
      sha256: sha256(bytes),
    });
  }
  const receiptPayload = {
    schemaVersion: 1,
    artifactKind: "server-route-bundle-publication-receipt",
    repository: {
      name: "AquilaXk/easysubway-data",
      gitSha: fixture.repositoryGitSha,
    },
    candidate: {
      bundleId: prePublicationFinal.candidate.bundleId,
      releaseSequence: prePublicationFinal.candidate.releaseSequence,
      stationSetSha256: prePublicationFinal.candidate.stationSetSha256,
      sourceSnapshotSetHash: prePublicationFinal.candidate.sourceSnapshotSetHash,
      signingInputSha256: prePublicationFinal.candidate.signingInputSha256,
      signedManifestRawSha256: prePublicationFinal.candidate.signedManifestRawSha256,
      payloadRootSha256: prePublicationFinal.candidate.payloadRootSha256,
      componentInventorySha256: prePublicationFinal.candidate.componentInventorySha256,
      componentDigests: prePublicationFinal.candidate.componentDigests,
      activeFrom: prePublicationFinal.candidate.activeFrom,
      freshUntil: prePublicationFinal.candidate.freshUntil,
      keyId: prePublicationFinal.candidate.keyId,
      prePublicationFinalSha256: prePublicationFinal.finalSha256,
    },
    locator: {
      publicBaseUrl: "https://objectstorage.ap-seoul-1.oraclecloud.com/n/easysubway/b/releases/o",
      objectPrefix,
    },
    objects,
  };
  const receipt = {
    ...receiptPayload,
    receiptSha256: sha256(Buffer.from(canonicalJson(receiptPayload))),
  };
  const publicationReceiptPath = path.join(fixture.temp, "publication-receipt.json");
  await writeCanonical(publicationReceiptPath, receipt);

  const inventory = {
    schemaVersion: 1,
    artifactKind: "datapack-candidate-inventory",
    entries: [
      { path: "map-pack/manifest.json", sizeBytes: 1, sha256: "a".repeat(64) },
      ...objects.map((entry) => ({
        path: `server-route-bundle/${entry.path}`,
        sizeBytes: entry.sizeBytes,
        sha256: entry.sha256,
      })),
      { path: "station-catalog-pack/manifest.json", sizeBytes: 1, sha256: "b".repeat(64) },
    ].sort((left, right) => bytewise(left.path, right.path)),
  };
  const inventoryBytes = Buffer.from(canonicalJson(inventory));
  const component = {
    schemaVersion: 1,
    component: "data",
    repository: "AquilaXk/easysubway-data",
    gitSha: fixture.repositoryGitSha,
    workflowRunId: "123",
    dataVersion: "1",
    releaseSequence: prePublicationFinal.candidate.releaseSequence,
    manifestSha256: "c".repeat(64),
    provenance: {
      sourceSnapshotSetHash: prePublicationFinal.candidate.sourceSnapshotSetHash,
    },
    artifactInventorySha256: sha256(inventoryBytes),
    contractVersion: "datapack-contract-v3",
    issueRef: "AquilaXk/easysubway#2705",
  };
  const compatibility = {
    schemaVersion: 1,
    artifactKind: "datapack-mobile-compatibility-evidence",
    decision: "PASS",
    candidate: structuredClone(component),
  };
  const compatibilityBytes = Buffer.from(canonicalJson(compatibility));
  const executionEvidence = await createCandidateExecutionEvidence(fixture.temp, component);
  const approval = [{
    state: "approved",
    environments: [{ name: "datapack-promotion" }],
    user: { login: "AquilaXk" },
  }];
  const approvalBytes = Buffer.from(canonicalJson(approval));
  const promotionWorkflowRunId = "456";
  const request = {
    schemaVersion: 1,
    artifactKind: "datapack-promotion-request",
    candidate: structuredClone(component),
    compatibilityEvidenceSha256: sha256(compatibilityBytes),
    candidateExecutionEvidence: executionEvidence.hashes,
    requestedBy: "AquilaXk",
    approval: {
      workflowRunId: promotionWorkflowRunId,
      environment: "datapack-promotion",
      reviewer: "AquilaXk",
      approvalEvidenceSha256: sha256(approvalBytes),
    },
    contractVersion: "datapack-promotion-v2",
    issueRef: component.issueRef,
  };

  const paths = {
    promotionRequestPath: path.join(fixture.temp, "promotion-request.json"),
    promotionComponentPath: path.join(fixture.temp, "promotion-component.json"),
    promotionInventoryPath: path.join(fixture.temp, "promotion-inventory.json"),
    compatibilityEvidencePath: path.join(fixture.temp, "compatibility-evidence.json"),
    candidateExecutionEvidenceRoot: executionEvidence.root,
    approvalEvidencePath: path.join(fixture.temp, "promotion-approvals.json"),
  };
  for (const [target, bytes] of [
    [paths.promotionRequestPath, Buffer.from(canonicalJson(request))],
    [paths.promotionComponentPath, Buffer.from(canonicalJson(component))],
    [paths.promotionInventoryPath, inventoryBytes],
    [paths.compatibilityEvidencePath, compatibilityBytes],
    [paths.approvalEvidencePath, approvalBytes],
  ]) await writeFile(target, bytes);
  return { publicationReceiptPath, promotionWorkflowRunId, ...paths };
}

async function prepareSignedReleaseFixture(t, options = {}) {
  const fixture = await createFixture(t, options);
  const evaluationAt = options.evaluationAt ?? FRESH_AT;
  const signedRoot = path.join(fixture.temp, "signed-release-fixture");
  await signServerRouteBundle({ input: fixture.artifactRoot, output: signedRoot });
  fixture.artifactRoot = signedRoot;
  const provisionalOutput = path.join(fixture.temp, "provisional-fixture");
  await build(fixture, provisionalOutput, evaluationAt);
  const eligibilityReportPath = await createEligibilityReport(
    fixture,
    provisionalOutput,
    "fixture-eligibility.json",
  );
  const prePublicationOutput = path.join(fixture.temp, "pre-publication-fixture");
  await build(fixture, prePublicationOutput, evaluationAt, undefined, { eligibilityReportPath });
  const prePublicationFinal = await readJson(
    path.join(prePublicationOutput, "server-route-bundle-final.json"),
  );
  return {
    fixture,
    releaseEvidence: {
      ...await createReleaseEvidence(fixture, prePublicationFinal),
      eligibilityReportPath,
    },
  };
}

async function rewriteReceipt(target, mutate) {
  const receipt = await readJson(target);
  delete receipt.receiptSha256;
  mutate(receipt);
  receipt.receiptSha256 = sha256(Buffer.from(canonicalJson(receipt)));
  await writeCanonical(target, receipt);
}

async function rewritePromotionEvidence(releaseEvidence, mutate) {
  const inventory = await readJson(releaseEvidence.promotionInventoryPath);
  const component = await readJson(releaseEvidence.promotionComponentPath);
  await mutate({ inventory, component });
  const inventoryBytes = Buffer.from(canonicalJson(inventory));
  component.artifactInventorySha256 = sha256(inventoryBytes);
  const compatibility = {
    schemaVersion: 1,
    artifactKind: "datapack-mobile-compatibility-evidence",
    decision: "PASS",
    candidate: structuredClone(component),
  };
  const compatibilityBytes = Buffer.from(canonicalJson(compatibility));
  const executionEvidence = await createCandidateExecutionEvidence(
    path.dirname(releaseEvidence.candidateExecutionEvidenceRoot), component,
  );
  const approvalBytes = await readFile(releaseEvidence.approvalEvidencePath);
  const request = {
    schemaVersion: 1,
    artifactKind: "datapack-promotion-request",
    candidate: structuredClone(component),
    compatibilityEvidenceSha256: sha256(compatibilityBytes),
    candidateExecutionEvidence: executionEvidence.hashes,
    requestedBy: "AquilaXk",
    approval: {
      workflowRunId: releaseEvidence.promotionWorkflowRunId,
      environment: "datapack-promotion",
      reviewer: "AquilaXk",
      approvalEvidenceSha256: sha256(approvalBytes),
    },
    contractVersion: "datapack-promotion-v2",
    issueRef: component.issueRef,
  };
  for (const [target, bytes] of [
    [releaseEvidence.promotionRequestPath, Buffer.from(canonicalJson(request))],
    [releaseEvidence.promotionComponentPath, Buffer.from(canonicalJson(component))],
    [releaseEvidence.promotionInventoryPath, inventoryBytes],
    [releaseEvidence.compatibilityEvidencePath, compatibilityBytes],
  ]) await writeFile(target, bytes);
}

async function createCandidateExecutionEvidence(rootParent, component) {
  const root = path.join(rootParent, "candidate-execution-evidence");
  await mkdir(root, { recursive: true });
  const bundle = {
    schemaVersion: 1, artifactKind: "datapack-release-evidence-bundle", releaseMode: "release-candidate",
    candidateId: "capital@1", buildCandidateId: "candidate-1", candidateBuilderGitSha: "9".repeat(40),
    builderGitSha: component.gitSha, buildSpecSha256: "8".repeat(64), manifestSha256: component.manifestSha256,
    releaseSequence: component.releaseSequence, sourceSnapshotSetHash: component.provenance.sourceSnapshotSetHash,
    validatorStatus: "PASS", manifestSignatureStatus: "PASS", createdAt: "2026-08-28T00:00:00.000Z",
    workflowRunUrl: `https://github.com/AquilaXk/easysubway-data/actions/runs/${component.workflowRunId}`,
    candidateServerRouteEvidence: { candidateId: "candidate-1", sourceSnapshotSetHash: component.provenance.sourceSnapshotSetHash, buildSpecSha256: "8".repeat(64), manifestSha256: component.manifestSha256, eligibility: { path: "server-route-bundle-evidence/route-accessibility-eligibility.json", sha256: "7".repeat(64) }, final: { path: "server-route-bundle-evidence/server-route-bundle-final.json", sha256: "6".repeat(64) } },
  };
  const decision = { schemaVersion: 1, artifactKind: "datapack-release-decision", outcome: "CHANGE_BLOCKED", productionWriteAllowed: false, materialChange: true, approvalValid: false, strictValidationPassed: true, publishRequired: true, publishAttempted: false, remoteValidationPassed: false, sourceSnapshotSetHash: component.provenance.sourceSnapshotSetHash, selectedManifestSha256: null, selectedReleaseSequence: null, reasonCodes: ["MATERIAL_CHANGE_UNAPPROVED"], evaluationAt: "2026-08-28T00:00:00.000Z" };
  const bundleBytes = Buffer.from(canonicalJson(bundle));
  const decisionBytes = Buffer.from(canonicalJson(decision));
  await writeFile(path.join(root, "release-evidence-bundle.json"), bundleBytes);
  await writeFile(path.join(root, "release-decision.json"), decisionBytes);
  return { root, hashes: { releaseEvidenceBundleSha256: sha256(bundleBytes), releaseDecisionSha256: sha256(decisionBytes) } };
}

async function build(fixture, output, evaluationAt, releaseEvidence = undefined, extraInput = {}) {
  const { eligibilityReportPath, ...releaseOnly } = releaseEvidence ?? {};
  return buildServerRouteBundleFinalEvidence({
    repositoryRoot: fixture.repositoryRoot,
    repositoryGitSha: fixture.repositoryGitSha,
    artifactRoot: fixture.artifactRoot,
    stationLineInput: fixture.stationLineInput,
    routeEdgeInput: fixture.routeEdgeInput,
    evaluationAt,
    output,
    ...(releaseEvidence === undefined ? {} : { releaseEvidence: releaseOnly, eligibilityReportPath }),
    ...(releaseEvidence === undefined ? {} : { clock: () => Date.parse(FRESH_AT) }),
    ...extraInput,
  });
}

async function createEligibilityReport(fixture, prepublicationRoot, name) {
  const final = await readJson(path.join(prepublicationRoot, "server-route-bundle-final.json"));
  const station = await readJson(path.join(prepublicationRoot, "station-line-accessibility.json"));
  const route = await readJson(path.join(prepublicationRoot, "route-edge-evaluation.json"));
  const payload = {
    schemaVersion: 1,
    artifactKind: "route-accessibility-eligibility",
    decision: "ELIGIBLE",
    candidate: final.candidate,
    stationLineAccessibility: {
      rowCount: station.rows.length,
      stateSummary: station.stateSummary,
      materializationDigest: station.materializationDigest,
      evidenceSha256: await fileSha(path.join(prepublicationRoot, "station-line-accessibility.json")),
    },
    routeEdgeEvaluation: {
      edgeCount: route.results.length,
      stateSummary: route.stateSummary,
      evaluationDigest: route.evaluationDigest,
      evidenceSha256: await fileSha(path.join(prepublicationRoot, "route-edge-evaluation.json")),
    },
    blockers: [],
  };
  const reportPath = path.join(fixture.temp, name);
  await writeCanonical(reportPath, {
    ...payload,
    eligibilitySha256: sha256(Buffer.from(canonicalJson(payload))),
  });
  return reportPath;
}

function eligibilityInput(fixture, prepublicationRoot, output) {
  return {
    prepublicationRoot,
    artifactRoot: fixture.artifactRoot,
    stationLineInput: path.join(fixture.temp, "eligibility-station-line-input.json"),
    routeEdgeInput: path.join(fixture.temp, "eligibility-route-edge-input.json"),
    repositoryGitSha: fixture.repositoryGitSha,
    evaluationAt: FRESH_AT,
    output,
    repositoryRoot: fixture.repositoryRoot,
  };
}

async function writeEligibilityInputs(fixture) {
  await Promise.all([
    writeCanonical(path.join(fixture.temp, "eligibility-station-line-input.json"), fixture.stationLineInput),
    writeCanonical(path.join(fixture.temp, "eligibility-route-edge-input.json"), fixture.routeEdgeInput),
  ]);
}

function installSigningEnvironment(t) {
  const names = [
    "EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM",
    "EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM",
    "EASYSUBWAY_DATAPACK_SIGNING_KEY_ID",
  ];
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM = signingPrivateKey;
  process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM = signingPublicKey;
  process.env.EASYSUBWAY_DATAPACK_SIGNING_KEY_ID = "production-v1";
  t.after(() => {
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
  });
}

async function writeCanonical(target, value) {
  await writeFile(target, Buffer.from(canonicalJson(value)));
}

async function readJson(target) {
  return JSON.parse(await readFile(target, "utf8"));
}

async function fileSha(target) {
  return sha256(await readFile(target));
}

function bytewise(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function initializeRepository(repositoryRoot) {
  const environment = {
    ...process.env,
    GIT_AUTHOR_DATE: "2026-08-07T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-08-07T00:00:00Z",
  };
  for (const args of [
    ["init", "--quiet"],
    ["add", "."],
    ["-c", "user.name=EasySubway Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"],
  ]) {
    const result = spawnSync("git", args, { cwd: repositoryRoot, env: environment, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
