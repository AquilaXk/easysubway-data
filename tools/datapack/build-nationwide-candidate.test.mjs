import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildNationwideCandidateSpec, buildNationwideReleaseArtifacts, commitNationwideReleaseArtifacts } from "./build-nationwide-candidate.mjs";
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
