import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildNationwideCandidateSpec, buildNationwideReleaseArtifacts, commitNationwideReleaseArtifacts,
  deriveNationwideProductionScope } from "./build-nationwide-candidate.mjs";
import { releaseRequestBindingViolations } from "./verify-release-request-binding.mjs";
import { NATIONWIDE_CANDIDATE_INPUT_PATHS } from "./validate-candidate-source-set.mjs";
import { CANDIDATE_RELEASE_OUTPUTS, CANDIDATE_RELEASE_JOURNAL_PATH, CANDIDATE_RELEASE_LOCK_PATH,
  createCandidateReleaseTransaction } from "./lib/source-registration-transaction.mjs";
import { buildNationwideRequirementOwnershipLedger } from "./build-nationwide-requirement-ownership-ledger.mjs";
import { fiveRegionCandidateSourceSetInput, fixtureBytes, fixtureLedgerInput } from "./test-fixtures/five-region-source-input.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");

async function inputs(context, { admitted = true } = {}) {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "nationwide-candidate-test-"));
  context.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const source = fiveRegionCandidateSourceSetInput();
  if (admitted) source.inventory.sources[0].admissionEvidence.adminReviewRecordHash = "d".repeat(64);
  const bound = fixtureLedgerInput(source);
  const inputBytes = {
    ...bound.inputBytes,
    productionScope: source.inputBytes.productionScope,
    ownershipLedger: fixtureBytes(buildNationwideRequirementOwnershipLedger(bound)),
  };
  const fixture = { packs: [{
    stationAliases: [{ stationId: "station-a", alias: "A", normalizedAlias: "a" }],
    stationFacilityEvidence: [{ stationId: "station-a", lineId: "line-a", facilityType: "ELEVATOR",
      evidenceHash: "e".repeat(64), providerRecordHash: "f".repeat(64) }],
    networkEdges: [{ id: "edge-a", fromNodeId: "node-a", toNodeId: "node-b", edgeType: "RIDE" }],
  }] };
  const overrides = { artifactKind: "datapack-manual-override-ledger", ledgerSource: "manual_overrides", facilityStatusUpdates: [] };
  await writeFile(path.join(repositoryRoot, "pack.json"), fixtureBytes(fixture));
  await writeFile(path.join(repositoryRoot, "overrides.json"), fixtureBytes(overrides));
  return {
    repositoryRoot, inputBytes,
    materialization: { fixturePath: "pack.json", overridesPath: "overrides.json",
      networkEdgeEvidence: { preparedReference: { path: "evidence.json", sha256: "e".repeat(64) } },
      officialOdFareEvidence: { sourceId: "fixture-fares" } },
    releaseIdentity: { candidateId: "fixture-nationwide-candidate", publishedAt: source.evaluatedAt, releaseSequence: 1 },
    builderIdentity: { gitSha: "a".repeat(40), version: "fixture-builder" },
  };
}

test("nationwide candidate constructor requires its actual inputs", async () => {
  await assert.rejects(buildNationwideCandidateSpec({}), /targets input bytes are required/);
});

test("nationwide preparation CLI consumes serialized inputs and writes the bound candidate", async (context) => {
  const input = await inputs(context);
  const targets = JSON.parse(input.inputBytes.targets);
  const pack = JSON.parse(await readFile(path.join(input.repositoryRoot, "pack.json"))).packs[0];
  pack.coverageLineOperatorScopes = targets.activeLineScopes;
  pack.stations = [{ id: "station-a" }];
  pack.stationLines = targets.activeLineScopes.map(({ lineId }) => ({ stationId: "station-a", lineId }));
  const routeEdges = pack.stationLines.flatMap(({ stationId, lineId }) => [
    { edgeId: `entry-${lineId}`, edgeType: "ENTRY", fromNodeId: stationId, toNodeId: `${stationId}:${lineId}` },
    { edgeId: `exit-${lineId}`, edgeType: "EXIT", fromNodeId: `${stationId}:${lineId}`, toNodeId: stationId },
  ]);
  routeEdges.push({ edgeId: "transfer", edgeType: "IN_STATION_TRANSFER",
    fromNodeId: `station-a:${pack.stationLines[0].lineId}`, toNodeId: `station-a:${pack.stationLines[1].lineId}` },
  { edgeId: "ride", edgeType: "RIDE", serviceClass: "SUBWAY" });
  const put = async (relative, bytes) => {
    await mkdir(path.dirname(path.join(input.repositoryRoot, relative)), { recursive: true });
    await writeFile(path.join(input.repositoryRoot, relative), bytes);
  };
  await put("pack.json", fixtureBytes({ packs: [pack] }));
  for (const [name, relative] of Object.entries(NATIONWIDE_CANDIDATE_INPUT_PATHS)) await put(relative, input.inputBytes[name]);
  for (const relative of CANDIDATE_RELEASE_OUTPUTS) await put(relative, fixtureBytes({ original: relative }));
  const policyScope = JSON.parse(input.inputBytes.productionScope);
  policyScope.verifiedAccessibilityScope.requiredFacilityTypes = ["ELEVATOR"];
  await put(CANDIDATE_RELEASE_OUTPUTS[1], fixtureBytes(policyScope));
  const routeBytes = fixtureBytes({ candidate: { candidateId: input.releaseIdentity.candidateId,
    sourceSetSha256: sha(JSON.stringify(JSON.parse(input.inputBytes.sourceSnapshots))) }, routeEdges });
  await put("route-input.json", routeBytes);
  const preparation = { schemaVersion: 1, artifactKind: "nationwide-candidate-preparation",
    scopeId: policyScope.routingLaunchScope.id, materialization: input.materialization,
    releaseIdentity: input.releaseIdentity, builderIdentity: input.builderIdentity,
    authority: { candidateId: input.releaseIdentity.candidateId, scopeId: policyScope.routingLaunchScope.id,
      approvalId: "fixture-approval", requestedBy: "fixture-requester", approvedBy: "fixture-owner" },
    routeEdgeInput: { path: "route-input.json", sha256: sha(routeBytes) } };
  await put("preparation.json", fixtureBytes(preparation));
  const command = spawnSync(process.execPath, [fileURLToPath(new URL("./build-nationwide-candidate.mjs", import.meta.url)),
    "--preparation", "preparation.json"], { cwd: input.repositoryRoot, encoding: "utf8", timeout: 15000 });
  assert.equal(command.status, 0, command.stderr);
  const candidateBytes = await readFile(path.join(input.repositoryRoot, CANDIDATE_RELEASE_OUTPUTS[0]));
  assert.equal(JSON.parse(command.stdout).buildSpecSha256, sha(candidateBytes));
  const scope = JSON.parse(await readFile(path.join(input.repositoryRoot, CANDIDATE_RELEASE_OUTPUTS[1])));
  assert.equal(scope.verifiedAccessibilityScope.requiredRowIds.length, pack.stationLines.length);
  assert.equal(scope.decision.currentLaunchDecision, "NO_GO");
  assert.deepEqual(await readFile(path.join(input.repositoryRoot, "route-input.json")), routeBytes);
});

test("nationwide scope derives multi-line rows and route sets without pilot counts or approval", () => {
  const source = fiveRegionCandidateSourceSetInput();
  const active = source.targets.activeLineScopes;
  const stationLines = active.map(({ lineId }, index) => ({ stationId: `station-${index}`, lineId }));
  stationLines.push({ stationId: stationLines[0].stationId, lineId: stationLines[1].lineId });
  const fixture = { packs: [{ coverageLineOperatorScopes: active, stationLines,
    stations: active.map((_, index) => ({ id: `station-${index}` })) }] };
  const routeEdges = stationLines.flatMap(({ stationId, lineId }) => [
    { edgeId: `entry-${stationId}-${lineId}`, edgeType: "ENTRY", fromNodeId: stationId, toNodeId: `${stationId}:${lineId}` },
    { edgeId: `exit-${stationId}-${lineId}`, edgeType: "EXIT", fromNodeId: `${stationId}:${lineId}`, toNodeId: stationId },
  ]);
  routeEdges.push({ edgeId: "transfer", edgeType: "IN_STATION_TRANSFER",
    fromNodeId: `${stationLines[0].stationId}:${active[0].lineId}`,
    toNodeId: `${stationLines[0].stationId}:${active[1].lineId}` },
  { edgeId: "ride", edgeType: "RIDE", serviceClass: "SUBWAY" });
  const policyScope = { ...source.productionScope,
    decision: { approvalState: "old-approved", approvedAt: "historical" },
    verifiedAccessibilityScope: { requiredFacilityTypes: ["ELEVATOR", "ESCALATOR"] },
    productionPromotionCriteria: { routeSafetyRequired: true, releaseModeAllowGaps: false } };
  const args = { policyScope, scopeId: "fixture-nationwide", targets: source.targets,
    fanIn: source.fanIn, ownershipLedger: source.ownershipLedger, fixture, routeEdges };
  const actual = deriveNationwideProductionScope(args);
  assert.deepEqual(actual.productionPromotionCriteria, policyScope.productionPromotionCriteria);
  assert.equal(actual.verifiedAccessibilityScope.facilityCoverageDenominator.expectedRows, stationLines.length * 2);
  assert.ok(actual.verifiedAccessibilityScope.requiredRowIds.includes(`${stationLines[0].stationId}|${active[1].lineId}|ELEVATOR`));
  assert.deepEqual(actual.routingLaunchScope.requiredTransferStationIds, [stationLines[0].stationId]);
  assert.deepEqual(actual.routingLaunchScope.requiredTransferEdgeIds, ["transfer"]);
  assert.equal(actual.routingLaunchScope.requiredBaseEdgeIds.length, stationLines.length * 2);
  assert.equal(actual.decision.currentLaunchDecision, "NO_GO");
  assert.equal(Object.hasOwn(actual.decision, "approvedAt"), false);
  assert.equal(actual.nationwideRoadmapScope.blocksRoutingLaunch, true);
  assert.equal(actual.nationwideRoadmapScope.launchRequiredCount, source.ownershipLedger.summary.launchRequired.totalCount);
  const missing = structuredClone(fixture);
  missing.packs[0].coverageLineOperatorScopes.pop();
  assert.throws(() => deriveNationwideProductionScope({ ...args, fixture: missing }), /target operator-line pair/);
  assert.throws(() => deriveNationwideProductionScope({ ...args, routeEdges: routeEdges.filter((row) => row.edgeId !== "transfer") }), /materialized access edges/);
});

test("nationwide candidate transaction rolls back partial replacement and commits one bound tuple", async (context) => {
  const input = await inputs(context);
  const put = async (relative, bytes) => {
    const target = path.join(input.repositoryRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  };
  const before = CANDIDATE_RELEASE_OUTPUTS.map((relative) => fixtureBytes({ original: relative }));
  for (const [index, relative] of CANDIDATE_RELEASE_OUTPUTS.entries()) await put(relative, before[index]);
  for (const [name, relative] of Object.entries(NATIONWIDE_CANDIDATE_INPUT_PATHS)) await put(relative, input.inputBytes[name]);
  const authority = { candidateId: input.releaseIdentity.candidateId,
    scopeId: JSON.parse(input.inputBytes.productionScope).routingLaunchScope.id,
    approvalId: "fixture-approval", requestedBy: "fixture-requester", approvedBy: "fixture-owner" };
  const args = { ...input, authority, productionScopeBytes: input.inputBytes.productionScope };
  const readOutputs = () => Promise.all(CANDIDATE_RELEASE_OUTPUTS.map((relative) => readFile(path.join(input.repositoryRoot, relative))));
  await assert.rejects(commitNationwideReleaseArtifacts({ ...args, failAfter: 1 }), /injected/);
  assert.deepEqual(await readOutputs(), before);
  const result = await commitNationwideReleaseArtifacts(args);
  const [candidateBytes, scopeBytes, requestBytes, evidenceBytes] = await readOutputs();
  const candidate = JSON.parse(candidateBytes), request = JSON.parse(requestBytes);
  assert.equal(result.buildSpecSha256, sha(candidateBytes));
  assert.equal(candidate.productionScope.sha256, sha(scopeBytes));
  assert.deepEqual(releaseRequestBindingViolations({ buildSpec: candidate,
    buildSpecSha256: sha(candidateBytes), releaseRequest: request }), []);
  assert.equal(JSON.parse(evidenceBytes).identifiers.candidateId.value, candidate.candidateId);
  for (const relative of [CANDIDATE_RELEASE_JOURNAL_PATH, CANDIDATE_RELEASE_LOCK_PATH]) {
    await assert.rejects(readFile(path.join(input.repositoryRoot, relative)), { code: "ENOENT" });
  }
  // 오래된 prestate로 다른 작업의 변경을 덮어쓰지 않는다.
  const transaction = createCandidateReleaseTransaction({ label: "fixture", validateOutputs() {} });
  await assert.rejects(transaction.commit({ repositoryRoot: input.repositoryRoot,
    outputs: CANDIDATE_RELEASE_OUTPUTS.map((relative, index) => ({ relative, prestateBytes: before[index],
      bytes: before[index], inputs: [] })) }), /preserves foreign replacement/);
  assert.deepEqual(await readOutputs(), [candidateBytes, scopeBytes, requestBytes, evidenceBytes]);
});

test("nationwide release preparation binds recorded authority to exact candidate bytes", async (context) => {
  const input = await inputs(context);
  const authority = { candidateId: input.releaseIdentity.candidateId,
    scopeId: JSON.parse(input.inputBytes.productionScope).routingLaunchScope.id,
    approvalId: "fixture-release-approval", requestedBy: "fixture-requester", approvedBy: "fixture-owner" };
  const result = await buildNationwideReleaseArtifacts({ ...input, authority });
  const candidate = JSON.parse(result.candidateBytes);
  const request = JSON.parse(result.requestBytes);
  const evidence = JSON.parse(result.hashEvidenceBytes);
  assert.deepEqual(releaseRequestBindingViolations({ buildSpec: candidate,
    buildSpecSha256: sha(result.candidateBytes), releaseRequest: request,
    expectedApprovalId: authority.approvalId }), []);
  assert.equal(request.scopeId, authority.scopeId);
  assert.deepEqual(result.productionScopeBytes, input.inputBytes.productionScope);
  assert.equal(evidence.identifiers.approvalId.value, authority.approvalId);
  assert.equal(evidence.fixturePath.sha256, sha(await readFile(path.join(input.repositoryRoot, "pack.json"))));
  assert.equal(evidence.ledgerHashes.approvedAliasLedgerHash.value, candidate.approvedAliasLedgerHash);
  const selected = JSON.parse(input.inputBytes.sourceSnapshots);
  assert.deepEqual(evidence.perSourceEvidence.map((row) => row.perSourceSnapshotSetHash),
    selected.map((row) => sha(JSON.stringify([row]))));
  assert.equal(Object.hasOwn(evidence, "buildDryRun"), false);
  for (const changedAuthority of [undefined, { ...authority, candidateId: "other" },
    { ...authority, scopeId: "other" }, { ...authority, approvedBy: authority.requestedBy }]) {
    await assert.rejects(buildNationwideReleaseArtifacts({ ...input, authority: changedAuthority }), /release authority/);
  }
});

test("nationwide candidate derives hashes from the prepared pack, not a previous spec", async (context) => {
  const input = await inputs(context);
  const beforeBytes = await readFile(path.join(input.repositoryRoot, "pack.json"));
  const result = await buildNationwideCandidateSpec(input);
  assert.equal(result.buildSpec.artifactKind, "datapack-candidate-build-spec");
  assert.equal(result.buildSpec.candidateId, input.releaseIdentity.candidateId);
  assert.equal(result.buildSpec.productionScopeId, JSON.parse(input.inputBytes.productionScope).routingLaunchScope.id);
  assert.deepEqual(result.fixtureBinding, { path: "pack.json", sha256: sha(beforeBytes) });
  assert.equal(result.buildSpec.sourceSnapshots[0].adminReviewRecordHash, "d".repeat(64));
  // exporter의 정렬 계약과 독립적인 단일 행 기대값이다.
  const alias = { alias: "A", normalizedAlias: "a", stationId: "station-a" };
  assert.equal(result.buildSpec.approvedAliasLedgerHash, sha(JSON.stringify([JSON.stringify(alias)])));
  assert.equal(result.ledgerEvidence.approvedAliasLedgerHash.value, result.buildSpec.approvedAliasLedgerHash);
  assert.equal(result.ledgerEvidence.approvedAliasLedgerHash.ledgerSource, "pack.json");
  assert.equal(result.buildSpec.sourceSnapshotSetHash, sha(JSON.stringify(JSON.parse(input.inputBytes.sourceSnapshots))));
  assert.equal(result.buildSpec.networkEdgeEvidence.sourceInventory.sha256, sha(input.inputBytes.inventory));
  assert.equal(result.buildSpec.productionScope.sha256, sha(input.inputBytes.productionScope));
  assert.deepEqual(await readFile(path.join(input.repositoryRoot, "pack.json")), beforeBytes);

  const changed = JSON.parse(beforeBytes);
  changed.packs[0].stationAliases[0].alias = "A changed";
  const changedBytes = fixtureBytes(changed);
  await writeFile(path.join(input.repositoryRoot, "pack.json"), changedBytes);
  const successor = await buildNationwideCandidateSpec(input);
  assert.notEqual(successor.buildSpec.approvedAliasLedgerHash, result.buildSpec.approvedAliasLedgerHash);
  assert.equal(successor.fixtureBinding.sha256, sha(changedBytes));
  assert.equal(successor.buildSpec.routeEvidenceLedgerHash, result.buildSpec.routeEvidenceLedgerHash);
});

test("nationwide candidate does not invent a missing admission record", async (context) => {
  await assert.rejects(buildNationwideCandidateSpec(await inputs(context, { admitted: false })), /adminReviewRecordHash is required/);
});

test("nationwide candidate preserves current scope and publication-time freshness", async (context) => {
  const input = await inputs(context);
  await assert.rejects(buildNationwideCandidateSpec({ ...input,
    releaseIdentity: { ...input.releaseIdentity, publishedAt: "2040-01-03T00:00:00.000Z" },
  }), /freshness expired/);
  const scope = JSON.parse(input.inputBytes.productionScope);
  scope.routingLaunchScope.regionIds.pop();
  await assert.rejects(buildNationwideCandidateSpec({ ...input,
    inputBytes: { ...input.inputBytes, productionScope: fixtureBytes(scope) },
  }), /region set mismatch/);
  await assert.rejects(buildNationwideCandidateSpec({ ...input,
    materialization: { ...input.materialization, fixturePath: "../outside.json" },
  }), /escapes repository/);
});
