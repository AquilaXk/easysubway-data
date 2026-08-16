import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCurrentExitAdmissionArtifactReceipt,
  canonicalCurrentExitAdmissionArtifactReceiptJson,
  main,
} from "./build-current-exit-admission-artifact-receipt.mjs";

const root = path.dirname(new URL(import.meta.url).pathname);
const normalizedName = "exit-path-normalized-source-snapshot.json";
const admissionName = "exit-path-source-admission.json";
const receiptName = "exit-path-admission-artifact-receipt.json";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("불완전한 EXIT denominator archive는 receipt 전에 fail closed한다", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "exit-admission-receipt-"));
  try {
    const normalized = await readFile(path.join(root, "release/current-exit-admission", normalizedName));
    const admission = await readFile(path.join(root, "release/current-exit-admission", admissionName));
    const archive = zip([{ name: normalizedName, bytes: normalized }, { name: admissionName, bytes: admission }]);
    const archivePath = path.join(temporary, "admission.zip");
    const output = path.join(temporary, "output");
    await writeFile(archivePath, archive, { mode: 0o600 });
    assert.throws(() => buildCurrentExitAdmissionArtifactReceipt({
      artifactArchiveBytes: archive,
      repository: "AquilaXk/easysubway-data",
      admissionWorkflowRunId: 2,
      providerWorkflowRunId: 1,
      headSha: "a".repeat(40),
      artifactId: 3,
      artifactName: "kric-exit-path-source-admission-1",
      artifactArchiveSha256: sha256(archive),
    }), /(?:normalized snapshot identity|EXIT denominator) mismatch/);
    await assert.rejects(main([
      "--artifact-archive", archivePath, "--repository", "AquilaXk/easysubway-data",
      "--admission-workflow-run-id", "2", "--provider-workflow-run-id", "1",
      "--head-sha", "a".repeat(40), "--artifact-id", "3",
      "--artifact-name", "kric-exit-path-source-admission-1",
      "--artifact-archive-sha256", sha256(archive), "--output-directory", output,
    ], { log() {} }), /(?:normalized snapshot identity|EXIT denominator) mismatch/);
    await assert.rejects(lstat(output));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("receipt의 flat metadata와 deterministic self-hash를 고정한다", () => {
  const payload = {
    schemaVersion: 1, artifactKind: "current-exit-admission-artifact-receipt", repository: "AquilaXk/easysubway-data",
    admissionWorkflowRunId: 2, providerWorkflowRunId: 1, headSha: "a".repeat(40), artifactId: 3,
    artifactName: "kric-exit-path-source-admission-1", artifactArchiveSha256: "b".repeat(64),
    normalizedSnapshotSha256: "c".repeat(64), admissionSha256: "d".repeat(64), admissionDigest: "e".repeat(64),
  };
  const receipt = { ...payload, receiptSha256: sha256(JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b, "en"))))) };
  assert.equal(canonicalCurrentExitAdmissionArtifactReceiptJson(receipt), JSON.stringify(Object.fromEntries(Object.entries(receipt).sort(([a], [b]) => a.localeCompare(b, "en")))));
});

test("213/199/420 synthetic admission ZIP을 canonical 3-file receipt로 deterministically publish한다", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "exit-admission-receipt-positive-"));
  try {
    const { normalized, admission } = syntheticPair();
    const normalizedBytes = Buffer.from(canonical(normalized)); const admissionBytes = Buffer.from(canonical(admission));
    const archive = zip([{ name: normalizedName, bytes: normalizedBytes, descriptor: true }, { name: admissionName, bytes: admissionBytes }]);
    const archivePath = path.join(temporary, "admission.zip"); const outputA = path.join(temporary, "output-a"); const outputB = path.join(temporary, "output-b");
    await writeFile(archivePath, archive, { mode: 0o600 });
    const input = { artifactArchiveBytes: archive, repository: "AquilaXk/easysubway-data", admissionWorkflowRunId: 2, providerWorkflowRunId: 1, headSha: "a".repeat(40), artifactId: 3, artifactName: "kric-exit-path-source-admission-1", artifactArchiveSha256: sha256(archive) };
    const expected = buildCurrentExitAdmissionArtifactReceipt(input);
    assert.equal(expected.normalizedSnapshotSha256, sha256(normalizedBytes)); assert.equal(expected.admissionSha256, sha256(admissionBytes));
    const argv = (output) => ["--artifact-archive", archivePath, "--repository", input.repository, "--admission-workflow-run-id", "2", "--provider-workflow-run-id", "1", "--head-sha", input.headSha, "--artifact-id", "3", "--artifact-name", input.artifactName, "--artifact-archive-sha256", input.artifactArchiveSha256, "--output-directory", output];
    assert.deepEqual(await main(argv(outputA), { log() {} }), expected); await main(argv(outputB), { log() {} });
    const names = [normalizedName, admissionName, receiptName]; assert.deepEqual((await readdir(outputA)).sort(), [...names].sort());
    for (const name of names) {
      assert.equal((await lstat(path.join(outputA, name))).mode & 0o777, 0o600);
      assert.deepEqual(await readFile(path.join(outputA, name)), await readFile(path.join(outputB, name)));
    }
    assert.deepEqual(await readFile(path.join(outputA, normalizedName)), normalizedBytes); assert.deepEqual(await readFile(path.join(outputA, admissionName)), admissionBytes);
    assert.deepEqual(JSON.parse(await readFile(path.join(outputA, receiptName), "utf8")), expected);
    const observedNormalized = structuredClone(normalized); const observedAdmission = structuredClone(admission);
    observedNormalized.results[0] = { queryId: observedNormalized.results[0].queryId, state: "OBSERVED_EXIT_PATH", records: [{ recordId: "observed-path", classification: "EXIT_TO_PLATFORM_PATH", providerRecordHash: sha256(canonical({ recordId: "observed-path", classification: "EXIT_TO_PLATFORM_PATH" })) }], zeroEvidenceSha256: null, providerResponseSha256: sha256(canonical({ queryId: observedNormalized.results[0].queryId, state: "OBSERVED_EXIT_PATH" })) };
    refreshAdmissionBindings(observedNormalized, observedAdmission);
    const observedCell = observedAdmission.cells.find((cell) => cell.stationLineId === observedAdmission.queryPartition.joined[0].stationLineId);
    observedCell.state = "ADMITTED_EXIT_PATH"; observedCell.admissionReason = "OFFICIAL_EXIT_PATH_PRESENT"; refreshMaterializerAndSummary(observedAdmission); rehashAdmission(observedAdmission);
    const observedArchive = zip([{ name: normalizedName, bytes: Buffer.from(canonical(observedNormalized)) }, { name: admissionName, bytes: Buffer.from(canonical(observedAdmission)) }]);
    assert.doesNotThrow(() => buildCurrentExitAdmissionArtifactReceipt({ ...input, artifactArchiveBytes: observedArchive, artifactArchiveSha256: sha256(observedArchive) }));
    const terminalNormalized = structuredClone(normalized); const terminalAdmission = structuredClone(admission);
    const terminalCellId = terminalAdmission.queryPartition.joined[0].stationLineId;
    const terminalJoined = terminalAdmission.queryPartition.joined.filter((item) => item.stationLineId === terminalCellId);
    for (const joined of terminalJoined) {
      const result = terminalNormalized.results.find((item) => item.queryId === joined.queryId);
      result.state = "PROVIDER_NO_DATA"; result.records = []; result.zeroEvidenceSha256 = null;
      result.providerResponseSha256 = sha256(canonical({ queryId: result.queryId, state: result.state }));
    }
    const observedTerminalResult = terminalNormalized.results.find((item) => item.queryId === terminalJoined.at(-1).queryId);
    observedTerminalResult.state = "OBSERVED_EXIT_PATH";
    observedTerminalResult.records = [{ recordId: "mixed-observed-path", classification: "EXIT_TO_PLATFORM_PATH", providerRecordHash: sha256(canonical({ recordId: "mixed-observed-path", classification: "EXIT_TO_PLATFORM_PATH" })) }];
    observedTerminalResult.zeroEvidenceSha256 = null;
    observedTerminalResult.providerResponseSha256 = sha256(canonical({ queryId: observedTerminalResult.queryId, state: observedTerminalResult.state }));
    refreshAdmissionBindings(terminalNormalized, terminalAdmission);
    const terminalCell = terminalAdmission.cells.find((cell) => cell.stationLineId === terminalCellId);
    const terminalResponses = terminalAdmission.queryPartition.joined
      .filter((item) => item.stationLineId === terminalCellId)
      .filter(({ queryId }) => terminalNormalized.results.find((result) => result.queryId === queryId).state === "PROVIDER_NO_DATA")
      .map(({ queryId }) => ({ queryId, providerResponseSha256: terminalNormalized.results.find((result) => result.queryId === queryId).providerResponseSha256 }))
      .sort((left, right) => left.queryId.localeCompare(right.queryId));
    terminalCell.state = "ADMITTED_EXIT_UNVERIFIED_BLOCKED";
    terminalCell.admissionReason = "PROVIDER_NO_DATA_UNVERIFIED_BLOCKED";
    terminalCell.providerResponseSha256 = sha256(canonical(terminalResponses));
    refreshMaterializerAndSummary(terminalAdmission); rehashAdmission(terminalAdmission);
    const terminalArchive = zip([{ name: normalizedName, bytes: Buffer.from(canonical(terminalNormalized)) }, { name: admissionName, bytes: Buffer.from(canonical(terminalAdmission)) }]);
    assert.doesNotThrow(() => buildCurrentExitAdmissionArtifactReceipt({ ...input, artifactArchiveBytes: terminalArchive, artifactArchiveSha256: sha256(terminalArchive) }));
    const terminalHashDrift = structuredClone(terminalAdmission); terminalHashDrift.cells.find((cell) => cell.stationLineId === terminalCellId).providerResponseSha256 = "f".repeat(64); refreshMaterializerAndSummary(terminalHashDrift); rehashAdmission(terminalHashDrift);
    const terminalHashDriftArchive = zip([{ name: normalizedName, bytes: Buffer.from(canonical(terminalNormalized)) }, { name: admissionName, bytes: Buffer.from(canonical(terminalHashDrift)) }]);
    assert.throws(() => buildCurrentExitAdmissionArtifactReceipt({ ...input, artifactArchiveBytes: terminalHashDriftArchive, artifactArchiveSha256: sha256(terminalHashDriftArchive) }), /admission cell (?:result binding|outcome) mismatch/);
    for (const state of ["FAILED"]) {
      const invalidNormalized = structuredClone(normalized); const invalidAdmission = structuredClone(admission);
      for (const joined of invalidAdmission.queryPartition.joined.filter((item) => item.stationLineId === invalidAdmission.queryPartition.joined[0].stationLineId)) {
        const result = invalidNormalized.results.find((item) => item.queryId === joined.queryId); result.state = state; result.records = []; result.zeroEvidenceSha256 = null;
      }
      refreshAdmissionBindings(invalidNormalized, invalidAdmission); rehashAdmission(invalidAdmission);
      const invalidArchive = zip([{ name: normalizedName, bytes: Buffer.from(canonical(invalidNormalized)) }, { name: admissionName, bytes: Buffer.from(canonical(invalidAdmission)) }]);
      assert.throws(() => buildCurrentExitAdmissionArtifactReceipt({ ...input, artifactArchiveBytes: invalidArchive, artifactArchiveSha256: sha256(invalidArchive) }), /admission cell outcome mismatch/);
    }
    const identityDrift = structuredClone(admission); identityDrift.cells[0].capturedAt = "2026-08-14T01:00:00.000Z"; identityDrift.materializerEvidenceRows[0].capturedAt = identityDrift.cells[0].capturedAt; rehashAdmission(identityDrift);
    const identityDriftArchive = zip([{ name: normalizedName, bytes: normalizedBytes }, { name: admissionName, bytes: Buffer.from(canonical(identityDrift)) }]);
    assert.throws(() => buildCurrentExitAdmissionArtifactReceipt({ ...input, artifactArchiveBytes: identityDriftArchive, artifactArchiveSha256: sha256(identityDriftArchive) }), /admission cell binding mismatch/);
    const drift = structuredClone(admission); drift.sourceIdentity.providerQueryPlanSha256 = "f".repeat(64); rehashAdmission(drift);
    const driftArchive = zip([{ name: normalizedName, bytes: normalizedBytes }, { name: admissionName, bytes: Buffer.from(canonical(drift)) }]);
    assert.throws(() => buildCurrentExitAdmissionArtifactReceipt({ ...input, artifactArchiveBytes: driftArchive, artifactArchiveSha256: sha256(driftArchive) }), /EXIT source\/provider binding mismatch/);
    const malformedCell = structuredClone(admission); malformedCell.cells[0].stationLineId = "forged"; rehashAdmission(malformedCell); const malformedCellArchive = zip([{ name: normalizedName, bytes: normalizedBytes }, { name: admissionName, bytes: Buffer.from(canonical(malformedCell)) }]);
    assert.throws(() => buildCurrentExitAdmissionArtifactReceipt({ ...input, artifactArchiveBytes: malformedCellArchive, artifactArchiveSha256: sha256(malformedCellArchive) }), /admission cell binding mismatch/);
    const malformedCandidate = structuredClone(admission); malformedCandidate.candidate.candidateId = "forged"; rehashAdmission(malformedCandidate); const malformedCandidateArchive = zip([{ name: normalizedName, bytes: normalizedBytes }, { name: admissionName, bytes: Buffer.from(canonical(malformedCandidate)) }]);
    assert.throws(() => buildCurrentExitAdmissionArtifactReceipt({ ...input, artifactArchiveBytes: malformedCandidateArchive, artifactArchiveSha256: sha256(malformedCandidateArchive) }), /admission cell binding mismatch/);
    const malformedQuery = structuredClone(admission); malformedQuery.queryPartition.joined.pop(); rehashAdmission(malformedQuery); const malformedQueryArchive = zip([{ name: normalizedName, bytes: normalizedBytes }, { name: admissionName, bytes: Buffer.from(canonical(malformedQuery)) }]);
    assert.throws(() => buildCurrentExitAdmissionArtifactReceipt({ ...input, artifactArchiveBytes: malformedQueryArchive, artifactArchiveSha256: sha256(malformedQueryArchive) }), /query partition mismatch/);
    const malformedLineSet = structuredClone(admission); malformedLineSet.stationLineSetSha256 = "f".repeat(64); rehashAdmission(malformedLineSet); const malformedLineSetArchive = zip([{ name: normalizedName, bytes: normalizedBytes }, { name: admissionName, bytes: Buffer.from(canonical(malformedLineSet)) }]);
    assert.throws(() => buildCurrentExitAdmissionArtifactReceipt({ ...input, artifactArchiveBytes: malformedLineSetArchive, artifactArchiveSha256: sha256(malformedLineSetArchive) }), /(?:cell binding|station denominator) mismatch/);
    const malformedMaterializer = structuredClone(admission); malformedMaterializer.materializerEvidenceRows[0].evidenceReason = "forged"; rehashAdmission(malformedMaterializer); const malformedMaterializerArchive = zip([{ name: normalizedName, bytes: normalizedBytes }, { name: admissionName, bytes: Buffer.from(canonical(malformedMaterializer)) }]);
    assert.throws(() => buildCurrentExitAdmissionArtifactReceipt({ ...input, artifactArchiveBytes: malformedMaterializerArchive, artifactArchiveSha256: sha256(malformedMaterializerArchive) }), /materializer mismatch/);
    const malformedResult = structuredClone(normalized); delete malformedResult.results[0].records; const malformedResultBytes = Buffer.from(canonical(malformedResult)); const malformedResultArchive = zip([{ name: normalizedName, bytes: malformedResultBytes }, { name: admissionName, bytes: admissionBytes }]);
    assert.throws(() => buildCurrentExitAdmissionArtifactReceipt({ ...input, artifactArchiveBytes: malformedResultArchive, artifactArchiveSha256: sha256(malformedResultArchive) }), /normalized result keys/);
    const corrupted = Buffer.from(archive); corrupted[40] ^= 1;
    assert.throws(() => buildCurrentExitAdmissionArtifactReceipt({ ...input, artifactArchiveBytes: corrupted, artifactArchiveSha256: sha256(corrupted) }), /ZIP (?:integrity|local entry) mismatch/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("archive/output collision은 fail closed하고 기존 대상을 보존한다", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "exit-admission-receipt-collision-"));
  try {
    const archivePath = path.join(temporary, "bad.zip");
    const output = path.join(temporary, "output");
    await writeFile(archivePath, zip([{ name: normalizedName, bytes: Buffer.from("{}") }, { name: "nested/" + admissionName, bytes: Buffer.from("{}") }]));
    await writeFile(output, "preserve", { mode: 0o600 });
    await assert.rejects(main([
      "--artifact-archive", archivePath, "--repository", "AquilaXk/easysubway-data",
      "--admission-workflow-run-id", "2", "--provider-workflow-run-id", "1", "--head-sha", "a".repeat(40),
      "--artifact-id", "3", "--artifact-name", "kric-exit-path-source-admission-1",
      "--artifact-archive-sha256", sha256(await readFile(archivePath)), "--output-directory", output,
    ], { log() {} }));
    assert.equal(await readFile(output, "utf8"), "preserve");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("symlink output parent는 publish 전에 fail closed한다", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "exit-admission-receipt-parent-"));
  try {
    const { normalized, admission } = syntheticPair(); const archive = zip([{ name: normalizedName, bytes: Buffer.from(canonical(normalized)) }, { name: admissionName, bytes: Buffer.from(canonical(admission)) }]);
    const archivePath = path.join(temporary, "admission.zip"); const realParent = path.join(temporary, "real"); const linkedParent = path.join(temporary, "linked"); await writeFile(archivePath, archive); await mkdir(realParent); await symlink(realParent, linkedParent);
    await assert.rejects(main(["--artifact-archive", archivePath, "--repository", "AquilaXk/easysubway-data", "--admission-workflow-run-id", "2", "--provider-workflow-run-id", "1", "--head-sha", "a".repeat(40), "--artifact-id", "3", "--artifact-name", "kric-exit-path-source-admission-1", "--artifact-archive-sha256", sha256(archive), "--output-directory", path.join(linkedParent, "output")], { log() {} }), /non-symlink directory/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

function zip(entries) {
  let offset = 0; const locals = []; const centrals = [];
  for (const entry of entries) {
    const name = Buffer.from(entry.name); const bytes = Buffer.from(entry.bytes); const descriptor = entry.descriptor === true; const crc = crc32(bytes);
    const local = Buffer.alloc(30 + name.length + bytes.length + (descriptor ? 16 : 0));
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(descriptor ? 8 : 0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(descriptor ? 0 : crc, 14); local.writeUInt32LE(descriptor ? 0 : bytes.length, 18); local.writeUInt32LE(descriptor ? 0 : bytes.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    name.copy(local, 30); bytes.copy(local, 30 + name.length); locals.push(local);
    if (descriptor) { const position = 30 + name.length + bytes.length; local.writeUInt32LE(0x08074b50, position); local.writeUInt32LE(crc, position + 4); local.writeUInt32LE(bytes.length, position + 8); local.writeUInt32LE(bytes.length, position + 12); }
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10);
    central.writeUInt16LE(descriptor ? 8 : 0, 8); central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt32LE((0o100600 << 16) >>> 0, 38); central.writeUInt32LE(offset, 42); name.copy(central, 46); centrals.push(central); offset += local.length;
  }
  const centralBytes = Buffer.concat(centrals); const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0); footer.writeUInt16LE(entries.length, 8); footer.writeUInt16LE(entries.length, 10); footer.writeUInt32LE(centralBytes.length, 12); footer.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, footer]);
}

function syntheticPair() {
  const queryIds = Array.from({ length: 420 }, (_, index) => `query-${String(index).padStart(3, "0")}`);
  const provider = { sourceId: "source", snapshotId: "snapshot", capturedAt: "2026-08-14T00:00:00.000Z", freshUntil: "2026-08-15T00:00:00.000Z", snapshotDigest: "1".repeat(64), rawSha256: "2".repeat(64), collectionPlanDigest: "3".repeat(64), queryPlanSha256: "4".repeat(64) };
  const stationLines = Array.from({ length: 213 }, (_, index) => ({ stationId: `station-${String(index % 199).padStart(3, "0")}`, lineId: `line-${String(index).padStart(3, "0")}` }));
  const queries = queryIds.map((queryId, index) => ({ queryId, routeEdgeId: `edge-${String(index).padStart(3, "0")}`, providerOperatorId: "operator", providerLineId: "line", providerStationId: `station-${String(index).padStart(3, "0")}`, providerNextStationId: `next-${String(index).padStart(3, "0")}`, operatorName: "Operator", lineName: "Line", stationName: `Station-${String(index).padStart(3, "0")}`, regionId: "capital" }));
  const results = queryIds.map((queryId) => { const responseSha256 = sha256(canonical({ queryId, state: "EXPLICIT_ZERO" })); return { queryId, state: "EXPLICIT_ZERO", records: [], zeroEvidenceSha256: responseSha256, providerResponseSha256: responseSha256 }; });
  const normalized = { schemaVersion: 4, artifactKind: "exit-path-normalized-source-snapshot", sourceId: provider.sourceId, snapshotId: provider.snapshotId, capturedAt: provider.capturedAt, freshUntil: provider.freshUntil, providerSnapshotIdentity: provider, coverage: { exhaustive: true, queryIds }, queryPlan: queries, results };
  const normalizedBytes = Buffer.from(canonical(normalized)); const normalizedEvidenceSha256 = sha256(canonical({ coverage: normalized.coverage, queryPlan: normalized.queryPlan, results: normalized.results }));
  const candidate = { candidateId: "candidate", stationSetSha256: sha256(canonical([...new Set(stationLines.map(({ stationId }) => stationId))].sort())), sourceSetSha256: "c".repeat(64), mappingContractVersion: "v1", materializerVersion: "v1" }; const mapping = "a".repeat(64); const lineSet = sha256(canonical(stationLines.map(({ stationId, lineId }) => ({ stationId, lineId, operatorId: "operator" })).sort((a, b) => a.stationId.localeCompare(b.stationId) || a.lineId.localeCompare(b.lineId))));
  const sourceIdentity = { sourceId: provider.sourceId, snapshotId: provider.snapshotId, rawSha256: sha256(normalizedBytes), capturedAt: provider.capturedAt, freshUntil: provider.freshUntil, queryPlanSha256: sha256(canonical(normalized.queryPlan)), coverageScopeSha256: "5".repeat(64), approvedAt: provider.capturedAt, decision: "APPROVED", productionUseAllowed: true, provenanceId: "6".repeat(64), licenseId: "7".repeat(64), providerSnapshotDigest: provider.snapshotDigest, providerSnapshotRawSha256: provider.rawSha256, providerCollectionPlanDigest: provider.collectionPlanDigest, providerQueryPlanSha256: provider.queryPlanSha256, facilityAdmissionDigest: "8".repeat(64), facilityStationLineMappingSha256: mapping };
  const joined = queries.map((query, index) => ({ ...query, stationLineId: `${stationLines[index % 213].stationId}:${stationLines[index % 213].lineId}` }));
  const cells = stationLines.map(({ stationId, lineId }) => { const stationLineId = `${stationId}:${lineId}`; const joinedResults = joined.filter((item) => item.stationLineId === stationLineId).map(({ queryId }) => results.find((result) => result.queryId === queryId)); return { candidateId: candidate.candidateId, stationSetSha256: candidate.stationSetSha256, sourceSetSha256: candidate.sourceSetSha256, stationLineMappingSha256: mapping, stationLineSetSha256: lineSet, stationLineId, stationId, lineId, operatorId: "operator", domain: "EXIT", sourceId: provider.sourceId, sourceSnapshotId: provider.snapshotId, evidenceRawSha256: sourceIdentity.rawSha256, capturedAt: provider.capturedAt, freshUntil: provider.freshUntil, provenanceId: sourceIdentity.provenanceId, licenseId: sourceIdentity.licenseId, mappingContractVersion: candidate.mappingContractVersion, materializerVersion: candidate.materializerVersion, normalizedEvidenceSha256, state: "ADMITTED_VERIFIED_ABSENCE", admissionReason: "OFFICIAL_EXIT_EXPLICIT_ZERO", providerRecordHash: sha256(canonical(joinedResults)), providerResponseSha256: null }; });
  const rows = cells.map((cell) => ({ candidateId: cell.candidateId, stationSetSha256: cell.stationSetSha256, sourceSetSha256: cell.sourceSetSha256, stationId: cell.stationId, lineId: cell.lineId, operatorId: cell.operatorId, domain: "EXIT", state: "VERIFIED_ABSENT", sourceId: cell.sourceId, sourceSnapshotId: cell.sourceSnapshotId, evidenceRawSha256: cell.evidenceRawSha256, providerRecordHash: cell.providerRecordHash, capturedAt: cell.capturedAt, freshUntil: cell.freshUntil, provenanceId: cell.provenanceId, licenseId: cell.licenseId, mappingContractVersion: cell.mappingContractVersion, materializerVersion: cell.materializerVersion, evidenceKind: "EXPLICIT_ZERO", evidenceReason: cell.admissionReason }));
  const partition = { summary: { queryCount: 420, joinedCount: 420, unmatchedCount: 0, ambiguousCount: 0 }, joined, unmatched: [], ambiguous: [] };
  const payload = { schemaVersion: 2, artifactKind: "exit-path-admission-matrix", candidate, sourceIdentity, stationLineMappingSha256: mapping, stationLineSetSha256: lineSet, normalizedEvidenceSha256, queryPartition: partition, cells, materializerEvidenceRows: rows, stateSummary: { ADMITTED_EXIT_PATH: 0, ADMITTED_VERIFIED_ABSENCE: 213, BLOCKED_WITH_EVIDENCE: 0, MISSING: 0, STALE: 0, UNKNOWN: 0, ADMITTED_EXIT_UNVERIFIED_BLOCKED: 0 }, decision: "GO" };
  return { normalized, admission: { ...payload, admissionDigest: sha256(canonical(payload)) } };
}

function canonical(value) { if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(canonical(item)))); if (!value || typeof value !== "object") return JSON.stringify(value); return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, JSON.parse(canonical(value[key]))]))); }
function rehashAdmission(admission) { admission.admissionDigest = sha256(canonical(Object.fromEntries(Object.entries(admission).filter(([key]) => key !== "admissionDigest")))); }
function refreshAdmissionBindings(normalized, admission) {
  const normalizedBytes = Buffer.from(canonical(normalized)); const normalizedEvidenceSha256 = sha256(canonical({ coverage: normalized.coverage, queryPlan: normalized.queryPlan, results: normalized.results }));
  admission.sourceIdentity.rawSha256 = sha256(normalizedBytes); admission.normalizedEvidenceSha256 = normalizedEvidenceSha256;
  const results = new Map(normalized.results.map((result) => [result.queryId, result]));
  for (const cell of admission.cells) {
    cell.evidenceRawSha256 = admission.sourceIdentity.rawSha256; cell.normalizedEvidenceSha256 = normalizedEvidenceSha256;
    cell.providerRecordHash = sha256(canonical(admission.queryPartition.joined.filter((joined) => joined.stationLineId === cell.stationLineId).map(({ queryId }) => results.get(queryId))));
  }
  refreshMaterializerAndSummary(admission);
}
function refreshMaterializerAndSummary(admission) {
  admission.materializerEvidenceRows = admission.cells.map((cell) => {
    if (cell.state === "ADMITTED_EXIT_UNVERIFIED_BLOCKED") {
      const evidenceHash = sha256(canonical({ sourceSnapshotId: cell.sourceSnapshotId, stationId: cell.stationId, lineId: cell.lineId, operatorId: cell.operatorId, domain: "EXIT", terminalPolicy: "PROVIDER_NO_DATA_RESULT_03_BLOCKED", providerResponseSha256: cell.providerResponseSha256 }));
      return { candidateId: cell.candidateId, stationSetSha256: cell.stationSetSha256, sourceSetSha256: cell.sourceSetSha256, stationId: cell.stationId, lineId: cell.lineId, operatorId: cell.operatorId, domain: "EXIT", state: "UNVERIFIED_EVIDENCE_BLOCKED", sourceId: cell.sourceId, sourceSnapshotId: cell.sourceSnapshotId, evidenceRawSha256: cell.evidenceRawSha256, providerRecordHash: null, capturedAt: cell.capturedAt, freshUntil: cell.freshUntil, provenanceId: cell.provenanceId, licenseId: cell.licenseId, mappingContractVersion: cell.mappingContractVersion, materializerVersion: cell.materializerVersion, evidenceKind: "UNVERIFIED_EVIDENCE_BLOCKED", evidenceReason: "출구 이동경로가 검증되지 않아 경로를 차단했습니다.", terminalPolicy: "PROVIDER_NO_DATA_RESULT_03_BLOCKED", providerResultCode: "03", strictRouteEligible: false, strictRouteEligibleReason: "UNVERIFIED_PROVIDER_EVIDENCE_BLOCKED", statusMeaning: "PROVIDER_NO_DATA_NOT_ABSENCE", confidence: 0, providerResponseSha256: cell.providerResponseSha256, evidenceHash };
    }
    return { candidateId: cell.candidateId, stationSetSha256: cell.stationSetSha256, sourceSetSha256: cell.sourceSetSha256, stationId: cell.stationId, lineId: cell.lineId, operatorId: cell.operatorId, domain: "EXIT", state: cell.state === "ADMITTED_EXIT_PATH" ? "VERIFIED_PRESENT" : "VERIFIED_ABSENT", sourceId: cell.sourceId, sourceSnapshotId: cell.sourceSnapshotId, evidenceRawSha256: cell.evidenceRawSha256, providerRecordHash: cell.providerRecordHash, capturedAt: cell.capturedAt, freshUntil: cell.freshUntil, provenanceId: cell.provenanceId, licenseId: cell.licenseId, mappingContractVersion: cell.mappingContractVersion, materializerVersion: cell.materializerVersion, evidenceKind: cell.state === "ADMITTED_EXIT_PATH" ? "OBSERVED" : "EXPLICIT_ZERO", evidenceReason: cell.admissionReason };
  });
  admission.stateSummary = Object.fromEntries(["ADMITTED_EXIT_PATH", "ADMITTED_VERIFIED_ABSENCE", "BLOCKED_WITH_EVIDENCE", "MISSING", "STALE", "UNKNOWN", "ADMITTED_EXIT_UNVERIFIED_BLOCKED"].map((state) => [state, admission.cells.filter((cell) => cell.state === state).length]));
}
function crc32(bytes) { let crc = 0xffffffff; for (const value of bytes) { crc ^= value; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
