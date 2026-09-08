import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { exportLedgerHash } from "./export-ledger-hashes.mjs";
import { validateNationwideCandidateSourceSet } from "./validate-candidate-source-set.mjs";
import { releaseRequestBindingViolations } from "./verify-release-request-binding.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

// 승인 사실은 입력으로만 받는다. 계산된 해시나 과거 후보의 승인으로 대체하지 않는다.
// 네 결과를 먼저 준비하며, 실제 파일 교체는 호출자의 단일 transaction이 담당한다.
export async function buildNationwideReleaseArtifacts({ authority, ...input } = {}) {
  if (!authority || ["candidateId", "scopeId", "approvalId", "requestedBy", "approvedBy"]
    .some((key) => typeof authority[key] !== "string" || !authority[key].trim())
    || authority.requestedBy === authority.approvedBy
    || authority.candidateId !== input.releaseIdentity?.candidateId
    || !Buffer.isBuffer(input.inputBytes?.productionScope)
    || authority.scopeId !== JSON.parse(input.inputBytes.productionScope).routingLaunchScope?.id) {
    throw new Error("release authority must identify this candidate, scope and distinct actors");
  }
  const prepared = await buildNationwideCandidateSpec(input);
  const candidate = prepared.buildSpec;
  const candidateBytes = jsonBytes(candidate);
  const request = {
    schemaVersion: 1, artifactKind: "datapack-release-request",
    candidateId: candidate.candidateId, scopeId: candidate.productionScopeId,
    buildSpecSha256: sha256(candidateBytes), sourceSnapshotSetHash: candidate.sourceSnapshotSetHash,
    approvedLedgerHash: candidate.approvedAliasLedgerHash,
    requestedBy: authority.requestedBy, approvedBy: authority.approvedBy,
    approvalId: authority.approvalId, targetChannel: "production",
  };
  const violations = releaseRequestBindingViolations({ buildSpec: candidate,
    buildSpecSha256: sha256(candidateBytes), releaseRequest: request, expectedApprovalId: authority.approvalId });
  if (violations.length) throw new Error(`release authority binding failed: ${violations.join("; ")}`);
  const selectedIds = new Set(candidate.sourceSnapshotIds);
  const selected = JSON.parse(input.inputBytes.sourceSnapshots).filter((row) => selectedIds.has(row.snapshotId));
  const admission = new Map(candidate.sourceSnapshots.map((row) => [row.snapshotId, row.adminReviewRecordHash]));
  const evidence = {
    schemaVersion: 1, artifactKind: "datapack-build-spec-hash-evidence",
    builderGitSha: candidate.builderGitSha, builderVersion: candidate.builderVersion,
    productionScopeId: candidate.productionScopeId, ledgerHashes: prepared.ledgerEvidence,
    sourceSnapshotSetHash: { value: candidate.sourceSnapshotSetHash },
    sourceInventorySha256: { value: candidate.sourceInventorySha256 },
    fixturePath: { value: prepared.fixtureBinding.path, sha256: prepared.fixtureBinding.sha256 },
    overrides: prepared.overridesBinding,
    identifiers: { candidateId: { value: candidate.candidateId }, approvalId: { value: authority.approvalId } },
    perSourceEvidence: selected.map((row) => ({ sourceId: row.sourceId, snapshotId: row.snapshotId,
      rawSha256: row.rawSha256, adminReviewRecordHash: admission.get(row.snapshotId),
      perSourceSnapshotSetHash: sha256(JSON.stringify([row])) })),
  };
  return { ...prepared, candidateBytes, productionScopeBytes: Buffer.from(input.inputBytes.productionScope),
    requestBytes: jsonBytes(request), hashEvidenceBytes: jsonBytes(evidence) };
}

// 실제 materialization에서 후보 입력을 준비한다. 승인·전체 pack 검증·발행은
// 기존 admission/build/release 경계의 책임이며, 이 함수는 파일을 쓰지 않는다.
export async function buildNationwideCandidateSpec({
  repositoryRoot,
  inputBytes,
  materialization,
  releaseIdentity,
  builderIdentity,
} = {}) {
  const bytes = inputBytes ?? {};
  for (const name of ["targets", "tally", "ownership", "inventory", "sourceSnapshots", "fanIn", "ownershipLedger", "productionScope"]) {
    if (!Buffer.isBuffer(bytes[name])) throw new Error(`${name} input bytes are required`);
  }
  if (!path.isAbsolute(repositoryRoot ?? "")) throw new Error("repositoryRoot must be absolute");
  if (typeof releaseIdentity?.candidateId !== "string" || !releaseIdentity.candidateId.trim()
    || !Number.isSafeInteger(releaseIdentity.releaseSequence) || releaseIdentity.releaseSequence < 1
    || !/^[a-f0-9]{40}$/.test(builderIdentity?.gitSha ?? "")
    || typeof builderIdentity?.version !== "string" || !builderIdentity.version.trim()) {
    throw new Error("candidate release and builder identities are required");
  }
  const [inventory, snapshots, fanIn, scope] = ["inventory", "sourceSnapshots", "fanIn", "productionScope"]
    .map((name) => JSON.parse(bytes[name]));
  const fixturePath = materializedPath(repositoryRoot, materialization?.fixturePath);
  const overridesPath = materializedPath(repositoryRoot, materialization?.overridesPath);
  if (fixturePath === overridesPath) throw new Error("materialization paths must be distinct");
  if (!materialization.networkEdgeEvidence || !materialization.officialOdFareEvidence) {
    throw new Error("prepared network and fare evidence are required");
  }
  const fixtureBytes = await readFile(fixturePath);
  const overridesBytes = await readFile(overridesPath);
  const fixture = JSON.parse(fixtureBytes);
  if (!Array.isArray(fixture.packs) || fixture.packs.length === 0
    || !fixture.packs.every((pack) => Array.isArray(pack.stationFacilityEvidence) && pack.stationFacilityEvidence.length > 0)) {
    throw new Error("prepared packs require stationFacilityEvidence");
  }
  const ledger = (kind) => exportLedgerHash(kind, {
    fixture: fixturePath,
    ...(kind === "override" ? { overrides: overridesPath } : {}),
  });
  const ledgerResults = await Promise.all([
    ledger("alias"), ledger("facility-evidence"), ledger("route-evidence"), ledger("override"),
  ]);
  const fields = ["approvedAliasLedgerHash", "facilityEvidenceLedgerHash", "routeEvidenceLedgerHash", "approvedOverrideSetHash"];
  const ledgerHashes = Object.fromEntries(fields.map((field, index) => [field, ledgerResults[index].ledgerHash]));
  if (!fixtureBytes.equals(await readFile(fixturePath)) || !overridesBytes.equals(await readFile(overridesPath))) {
    throw new Error("materialization input drift detected");
  }
  const selectedIds = new Set(fanIn.selectedSources.map(({ snapshotId }) => snapshotId));
  const selected = snapshots.filter(({ snapshotId }) => selectedIds.has(snapshotId));
  const bySource = new Map(inventory.sources.map((source) => [source.id, source]));
  const sourceSnapshots = selected.map((snapshot) => {
    const adminReviewRecordHash = bySource.get(snapshot.sourceId)?.admissionEvidence?.adminReviewRecordHash;
    if (!/^[a-f0-9]{64}$/.test(adminReviewRecordHash ?? "")) throw new Error("source admission adminReviewRecordHash is required");
    return {
      snapshotId: snapshot.snapshotId, sourceId: snapshot.sourceId, rawObjectUri: snapshot.rawObjectUri,
      rawSha256: snapshot.rawSha256, redactedRequestFingerprint: snapshot.redactedRequestFingerprint,
      schemaFingerprint: snapshot.schemaFingerprint, licenseStatus: snapshot.licenseStatus,
      redistributionAllowed: snapshot.redistributionAllowed, adminReviewRecordHash,
      snapshotStatus: snapshot.snapshotStatus, credentialRedacted: snapshot.credentialRedacted,
      freshnessExpiresAt: snapshot.freshnessExpiresAt,
    };
  });
  const buildSpec = {
    schemaVersion: 1, artifactKind: "datapack-candidate-build-spec",
    candidateId: releaseIdentity.candidateId, publishedAt: releaseIdentity.publishedAt,
    releaseSequence: releaseIdentity.releaseSequence, builderGitSha: builderIdentity.gitSha,
    builderVersion: builderIdentity.version, fixturePath: materialization.fixturePath,
    sourceSnapshotEvidencePath: "tools/datapack/release/source-snapshots.json",
    sourceSnapshotIds: sourceSnapshots.map(({ snapshotId }) => snapshotId), sourceSnapshots,
    sourceSnapshotSetHash: sha256(JSON.stringify(selected)), sourceInventorySha256: sha256(JSON.stringify(inventory)),
    productionScope: { path: "release/product-gates/production-datapack-scope.json", sha256: sha256(bytes.productionScope) },
    productionScopePolicy: { path: "tools/datapack/nationwide-coverage-targets.json", sha256: sha256(bytes.targets) },
    productionScopeId: scope.routingLaunchScope.id,
    networkEdgeEvidence: { ...materialization.networkEdgeEvidence, sourceInventory: { path: "tools/datapack/source-inventory.json", sha256: sha256(bytes.inventory) } },
    officialOdFareEvidence: materialization.officialOdFareEvidence,
    ...(materialization.itxTopologyEvidencePath ? { itxTopologyEvidencePath: materialization.itxTopologyEvidencePath, itxTopologyEvidenceSha256: materialization.itxTopologyEvidenceSha256 } : {}),
    ...ledgerHashes,
  };
  const proof = validateNationwideCandidateSourceSet({ candidate: buildSpec, inputBytes: bytes });
  return {
    buildSpec,
    fixtureBinding: { path: materialization.fixturePath, sha256: sha256(fixtureBytes) },
    overridesBinding: { path: materialization.overridesPath, sha256: sha256(overridesBytes) },
    ledgerEvidence: Object.fromEntries(fields.map((field, index) => [field, {
      value: ledgerResults[index].ledgerHash,
      exporterKind: ledgerResults[index].kind,
      rowCount: ledgerResults[index].rowCount,
      ledgerSource: field === "approvedOverrideSetHash" ? materialization.overridesPath : materialization.fixturePath,
    }])),
    sourceBinding: proof,
  };
}

function materializedPath(root, relative) {
  if (typeof relative !== "string" || !relative.endsWith(".json") || path.isAbsolute(relative)) {
    throw new Error("materialization requires a repository-relative JSON path");
  }
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("materialization path escapes repository");
  return resolved;
}
