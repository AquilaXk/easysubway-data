import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCurrentCapitalRouteEdgeInput, canonicalCurrentCapitalRouteEdgeInputJson, main } from "./build-current-capital-route-edge-input.mjs";
import { buildCurrentCapitalStationLineInput, canonicalCurrentCapitalStationLineInputJson } from "./build-current-capital-station-line-input.mjs";
import { materializeStationLineAccessibility } from "./materialize-station-line-accessibility.mjs";
import { canonicalRideEdgeSetSha256, evaluateRouteAccessibilityEdges } from "./evaluate-route-accessibility-edges.mjs";
import { fixture } from "./build-current-capital-station-line-input.test.mjs";

test("full-capital route fan-in은 2218+213+213+30 edge contract를 만든다", async () => {
  const input = await fixture();
  input.canonicalPack.packs[0].networkEdges = Array.from({ length: 2218 }, (_, index) => ({ id: `ride-${index}`, edgeType: "RIDE", fromNodeId: "station-000:seoul-2", toNodeId: "station-001:seoul-2", durationSeconds: 120, distanceMeters: 1000, serviceClass: "SUBWAY", servicePattern: "LOCAL" }));
  const result = buildCurrentCapitalRouteEdgeInput(input);
  assert.deepEqual(Object.keys(result).sort(), ["candidate", "routeEdges", "stationLines"]);
  assert.equal(result.routeEdges.length, 2674);
  assert.deepEqual(Object.fromEntries(["RIDE", "ENTRY", "EXIT", "IN_STATION_TRANSFER"].map((type) => [type, result.routeEdges.filter((edge) => edge.edgeType === type).length])), { RIDE: 2218, ENTRY: 213, EXIT: 213, IN_STATION_TRANSFER: 30 });
  assert.equal(new Set(result.routeEdges.map(({ edgeId }) => edgeId)).size, 2674);
  assert.ok(result.routeEdges.filter(({ edgeType }) => edgeType === "IN_STATION_TRANSFER").every(({ durationSeconds, distanceMeters }) => durationSeconds === 0 && distanceMeters > 0));
  const station = buildCurrentCapitalStationLineInput(input);
  const materialization = materializeStationLineAccessibility({ ...station, observedAt: "2026-08-01T01:00:00.000Z" });
  const policy = evaluatorPolicy(canonicalRideEdgeSetSha256(result.routeEdges.filter(({ edgeType }) => edgeType === "RIDE")));
  const evaluated = evaluateRouteAccessibilityEdges({ candidate: result.candidate, evaluationAt: "2026-08-01T01:00:00.000Z", stationLines: result.stationLines, routeEdges: result.routeEdges, materialization }, policy);
  assert.equal(evaluated.denominator.edgeCount, 2674);
  const terminalExit = materialization.rows.find(({ state, domain }) => state === "UNVERIFIED_EVIDENCE_BLOCKED" && domain === "EXIT");
  assert.ok(terminalExit);
  const terminalExitEdge = result.routeEdges.find(({ edgeType, fromNodeId }) => edgeType === "EXIT" && fromNodeId === `${terminalExit.stationId}:${terminalExit.lineId}`);
  assert.ok(terminalExitEdge);
  const terminalExitResult = evaluated.results.find(({ edgeId }) => edgeId === terminalExitEdge.edgeId);
  assert.equal(terminalExitResult.state, "BLOCKED");
  assert.equal(terminalExitResult.reason, "출구 이동경로가 검증되지 않아 경로를 차단했습니다.");
});

test("route CLI만 temporary fixed target에 exact two-file handoff를 원자 publish한다", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-capital-full-"));
  const input = await fixture();
  input.sourceSnapshots = JSON.parse(canonical(input.sourceSnapshots));
  const sourceSet = sha(JSON.stringify(input.sourceSnapshots));
  const evidenceSourceSet = sha(JSON.stringify(input.sourceSnapshots.slice(0, -1)));
  input.candidateBuildSpec.sourceSnapshotSetHash = sourceSet;
  input.sourceSetTransition.currentCandidateSourceSetSha256 = sourceSet;
  input.sourceSetTransition.evidenceSourceSetSha256 = evidenceSourceSet;
  input.exitAdmission.candidate.sourceSetSha256 = evidenceSourceSet;
  input.exitAdmission.materializerEvidenceRows = input.exitAdmission.materializerEvidenceRows.map((row) => ({ ...row, sourceSetSha256: evidenceSourceSet }));
  resealAdmission(input.exitAdmission);
  input.facilityAdmission.candidate.sourceSnapshotSetHash = evidenceSourceSet;
  resealFacility(input.facilityAdmission);
  input.exitReceipt.admissionDigest = input.exitAdmission.admissionDigest;
  input.exitReceipt.admissionSha256 = sha(canonical(input.exitAdmission));
  resealReceipt(input.exitReceipt);
  input.candidateBuildSpec.sourceInventorySha256 = sha(canonical(input.sourceInventory));
  input.candidateBuildSpec.networkEdgeEvidence.sourceInventory.sha256 = sha(canonical(input.sourceInventory));
  input.canonicalPack.packs[0].networkEdges = Array.from({ length: 2218 }, (_, index) => ({ id: `ride-${index}`, edgeType: "RIDE", fromNodeId: "station-000:seoul-2", toNodeId: "station-001:seoul-2", durationSeconds: 120, distanceMeters: 1000, serviceClass: "SUBWAY", servicePattern: "LOCAL" }));
  const entries = {
    "tools/datapack/release/current-capital-facility-source-admission.json": input.facilityAdmission,
    [input.facilityAdmission.sourceIdentity.snapshotPath]: input.facilitySnapshotBytes,
    "tools/datapack/release/current-exit-admission-v2/exit-path-normalized-source-snapshot.json": input.exitNormalized,
    "tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json": input.exitAdmission,
    "tools/datapack/release/current-exit-admission-v2/exit-path-admission-artifact-receipt.json": input.exitReceipt,
    "tools/datapack/release/current-transfer-topology-metrics.json": input.transferMetrics,
    "tools/datapack/release/current-capital-transfer-topology-applicability.json": input.transferApplicability,
    "tools/datapack/source-inventory.json": input.sourceInventory,
    "tools/datapack/release/source-snapshots.json": input.sourceSnapshots,
    "tools/datapack/release/candidate-build-spec.json": input.candidateBuildSpec,
    "tools/datapack/release/capital-production-canonical-pack.json": input.canonicalPack,
    "release/product-gates/route-edge-evaluation-policy.json": input.policy,
  };
  await Promise.all(Object.entries(entries).map(async ([relative, value]) => {
    const target = path.join(root, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, Buffer.isBuffer(value) ? value : relative.endsWith("current-capital-facility-source-admission.json") ? `${canonical(value)}\n` : canonical(value));
  }));
  const dependencies = { repositoryRoot: root, log: () => {}, readTransitionBoundaryImpl: async () => input.sourceSetTransition };
  const result = await main([], dependencies);
  const output = path.join(root, "tools/datapack/release/current-capital-accessibility-full");
  const stationPath = path.join(output, "station-line-input.json"); const routePath = path.join(output, "route-edge-input.json");
  assert.equal(await readFile(stationPath, "utf8"), canonicalCurrentCapitalStationLineInputJson(result.station));
  assert.equal(await readFile(routePath, "utf8"), canonicalCurrentCapitalRouteEdgeInputJson(result.route));
  assert.equal((await stat(stationPath)).mode & 0o777, 0o600);
  assert.equal((await stat(routePath)).mode & 0o777, 0o600);
  await assert.rejects(main([], dependencies), /absent/i);
});

function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function sha(value) { return createHash("sha256").update(value).digest("hex"); }
function resealAdmission(value) { const { admissionDigest: _ignored, ...payload } = value; value.admissionDigest = sha(canonical(payload)); }
function resealFacility(value) { const { admissionDigest: _ignored, ...payload } = value; value.admissionDigest = sha(canonical(payload)); }
function resealReceipt(value) { const { receiptSha256: _ignored, ...payload } = value; value.receiptSha256 = sha(canonical(payload)); }
function evaluatorPolicy(rideHash) { const both = ["IN_STATION_TRANSFER", "OUT_OF_STATION_TRANSFER", "LEGACY_TRANSFER"], facility = ["WALKWAY", "ELEVATOR", "RAMP", "STAIR", "ESCALATOR", "FACILITY_CONNECTOR"]; return { schemaVersion: 1, artifactKind: "route-edge-evaluation-policy", policyVersion: "route-edge-evaluation-v2", states: ["PASS", "BLOCKED", "NOT_APPLICABLE", "UNKNOWN", "MISSING", "STALE", "NOT_EVALUATED"], unresolvedStatePrecedence: ["STALE", "MISSING", "UNKNOWN"], edgeDomainMap: Object.fromEntries([...["ENTRY"].map((key) => [key, { endpointTarget: "TO", domains: ["FACILITY"] }]), ...["EXIT"].map((key) => [key, { endpointTarget: "FROM", domains: ["EXIT"] }]), ...both.map((key) => [key, { endpointTarget: "BOTH", domains: ["TRANSFER"] }]), ...facility.map((key) => [key, { endpointTarget: "BOTH", domains: ["FACILITY"] }]), ["RIDE", { endpointTarget: "NONE", domains: [] }]]), rideInvariant: { subwayLocal: { serviceClass: "SUBWAY", servicePattern: "LOCAL", sameLine: true, measuredSpeedKmhMinimum: 15, measuredSpeedKmhMaximum: 110, admittedEdgeSetSha256: rideHash, digestShape: "sqlite-route-graph-v1" }, itxCheongchunExpress: { serviceClass: "ITX_CHEONGCHUN", servicePattern: "EXPRESS", admittedEdgeSetSha256: canonicalRideEdgeSetSha256([]), digestShape: "sqlite-route-graph-v1" } } }; }
