import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { exportLedgerHash } from "./export-ledger-hashes.mjs";
import { NATIONWIDE_CANDIDATE_INPUT_PATHS, validateNationwideCandidateSourceSet } from "./validate-candidate-source-set.mjs";
import { releaseRequestBindingViolations } from "./verify-release-request-binding.mjs";
import { CANDIDATE_RELEASE_OUTPUTS, createCandidateReleaseTransaction } from "./lib/source-registration-transaction.mjs";
import { assertNationwideAssemblyInputs } from "./lib/nationwide-assembly-binding.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
// locale에 따라 release bytes가 달라지지 않도록 기존 문자열 코드 순서를 유지한다.
const compareIdentity = (left, right) => left < right ? -1 : left > right ? 1 : 0;

// 지원 범위를 선언할 입력을 계산할 뿐, 운영 승인이나 source 검증 성공을 만들지 않는다.
export function deriveNationwideProductionScope({ policyScope, scopeId, targets, fanIn,
  ownershipLedger, fixture, routeEdges }) {
  const unique = (values) => [...new Set(values)].sort(compareIdentity);
  const key = ({ regionId, operatorId, lineId }) => JSON.stringify([regionId, operatorId, lineId]);
  const active = targets.activeLineScopes;
  const packs = fixture.packs;
  const facilityTypes = policyScope.verifiedAccessibilityScope.requiredFacilityTypes;
  if (typeof scopeId !== "string" || !scopeId.trim() || !Array.isArray(active) || !active.length
    || !Array.isArray(packs) || !packs.length || !Array.isArray(facilityTypes) || !facilityTypes.length
    || new Set(facilityTypes).size !== facilityTypes.length || !Array.isArray(routeEdges)) {
    throw new Error("nationwide scope materialization inputs are invalid");
  }
  const regionIds = unique(active.map((row) => row.regionId));
  if (JSON.stringify(regionIds) !== JSON.stringify(unique(fanIn.scope.regionIds))) throw new Error("scope fan-in regions mismatch");
  const represented = new Set(packs.flatMap((pack) => pack.coverageLineOperatorScopes ?? []).map(key));
  if (active.some((row) => !represented.has(key(row)))) throw new Error("scope materialization is missing a target operator-line pair");
  const lineIds = unique(active.map((row) => row.lineId));
  const operatorIds = unique(active.map((row) => row.operatorId));
  const selectedLines = new Set(lineIds);
  const stations = new Set(packs.flatMap((pack) => pack.stations.map((row) => row.id)));
  const pairs = new Map();
  for (const row of packs.flatMap((pack) => pack.stationLines)) {
    if (!selectedLines.has(row.lineId)) continue;
    if (!stations.has(row.stationId)) throw new Error("scope station membership is missing");
    pairs.set(JSON.stringify([row.stationId, row.lineId]), row);
  }
  if (JSON.stringify(unique([...pairs.values()].map((row) => row.lineId))) !== JSON.stringify(lineIds)) {
    throw new Error("scope materialization is missing a target line");
  }
  const stationIds = unique([...pairs.values()].map((row) => row.stationId));
  const endpoints = new Map(stationIds.map((id) => [id, id]));
  for (const row of pairs.values()) endpoints.set(`${row.stationId}:${row.lineId}`, row.stationId);
  const baseEdges = routeEdges.filter((row) => ["ENTRY", "EXIT"].includes(row.edgeType));
  const transferEdges = routeEdges.filter((row) => ["TRANSFER", "IN_STATION_TRANSFER"].includes(row.edgeType));
  const accessEdges = [...baseEdges, ...transferEdges];
  if (!baseEdges.length || !transferEdges.length || accessEdges.some((row) => !row.edgeId
    || !endpoints.has(row.fromNodeId) || !endpoints.has(row.toNodeId))) {
    throw new Error("scope requires materialized access edges with canonical endpoints");
  }
  const serviceIds = unique(routeEdges.filter((row) => row.edgeType === "RIDE").map((row) => row.serviceClass));
  if (!serviceIds.length || serviceIds.some((id) => typeof id !== "string" || !id)) throw new Error("scope route services are missing");
  const requiredRowIds = unique([...pairs.values()].flatMap(({ stationId, lineId }) =>
    facilityTypes.map((type) => `${stationId}|${lineId}|${type}`)));
  const scope = structuredClone(policyScope);
  const access = { ...scope.verifiedAccessibilityScope, id: scopeId, regionIds,
    includedOperatorIds: operatorIds, includedLineIds: lineIds, includedStationIds: stationIds,
    requiredRowIds, facilityCoverageDenominator: { kind: "station_line_x_required_facility_type", expectedRows: requiredRowIds.length },
    supportedClaimKo: "전국 도시철도 지원 범위 — 운영 evidence 검증 전",
    supportedClaimPolicyKo: "생성한 scope는 지원 성공 주장이 아니다. 운영 evidence가 통과한 범위만 표시한다." };
  scope.verifiedAccessibilityScope = access;
  scope.supportScope = structuredClone(access);
  scope.decision = { currentLaunchDecision: "NO_GO", supportScope: scopeId, blocker: "RELEASE_EVIDENCE_PENDING" };
  scope.routingLaunchScope = { ...scope.routingLaunchScope, id: scopeId, regionIds, operatorIds, lineIds, serviceIds,
    baseRoutingStationIds: stationIds, requiredBaseEdgeIds: unique(baseEdges.map((row) => row.edgeId)),
    requiredTransferEdgeIds: unique(transferEdges.map((row) => row.edgeId)),
    requiredTransferStationIds: unique(transferEdges.flatMap((row) => [endpoints.get(row.fromNodeId), endpoints.get(row.toNodeId)])) };
  const total = ownershipLedger.summary.launchRequired.totalCount;
  if (!Number.isSafeInteger(total) || total < 1) throw new Error("scope launch denominator is invalid");
  scope.nationwideRoadmapScope = { ...scope.nationwideRoadmapScope, id: scopeId,
    targets: NATIONWIDE_CANDIDATE_INPUT_PATHS.targets, launchRequiredCount: total, blocksRoutingLaunch: true };
  const requiredSourceIds = unique(fanIn.selectedSources.map((row) => row.sourceId));
  scope.productionSourceSet = { ...scope.productionSourceSet,
    sourceInventory: NATIONWIDE_CANDIDATE_INPUT_PATHS.inventory, requiredSourceIds };
  for (const field of ["optionalAccessibilitySourceIds", "excludedFromV1SupportClaims"]) {
    if (Array.isArray(scope.productionSourceSet[field])) scope.productionSourceSet[field] = scope.productionSourceSet[field].filter((id) => !requiredSourceIds.includes(id));
  }
  scope.nationwideCoverageContract = { ...scope.nationwideCoverageContract,
    activeLaunchRequiredDomains: targets.requiredSourceDomains.filter((row) => row.releaseTier === "LAUNCH_REQUIRED").map((row) => row.id),
    enhancementDomains: targets.requiredSourceDomains.filter((row) => row.releaseTier === "ENHANCEMENT").map((row) => row.id) };
  return scope;
}

// 준비 scope는 교체할 출력이다. 이를 불변 외부 입력으로 다시 검사하면
// 자기 자신의 첫 write를 drift로 오인하므로 출력 prestate CAS로 보호한다.
export async function commitNationwideReleaseArtifacts({ repositoryRoot, productionScopeBytes,
  materialization, releaseIdentity, builderIdentity, authority, failAfter = null,
  preparationBindings = [], scopePrestateBytes } = {}) {
  if (!path.isAbsolute(repositoryRoot ?? "") || !Buffer.isBuffer(productionScopeBytes)) {
    throw new Error("candidate commit requires an absolute root and prepared scope bytes");
  }
  const prestate = await Promise.all(CANDIDATE_RELEASE_OUTPUTS.map((relative) => readFile(path.join(repositoryRoot, relative))));
  if (scopePrestateBytes && !prestate[1].equals(scopePrestateBytes)) throw new Error("scope policy prestate drift");
  const inputs = await Promise.all(Object.entries(NATIONWIDE_CANDIDATE_INPUT_PATHS).map(async ([name, relative]) =>
    ({ name, relative, bytes: await readFile(path.join(repositoryRoot, relative)) })));
  const prepared = await buildNationwideReleaseArtifacts({ repositoryRoot, materialization,
    releaseIdentity, builderIdentity, authority,
    inputBytes: { ...Object.fromEntries(inputs.map(({ name, bytes }) => [name, bytes])), productionScope: productionScopeBytes } });
  inputs.push(...preparationBindings);
  for (const binding of [prepared.fixtureBinding, prepared.overridesBinding]) {
    if (CANDIDATE_RELEASE_OUTPUTS.includes(binding.path)) throw new Error("materialization overlaps candidate outputs");
    const bytes = await readFile(materializedPath(repositoryRoot, binding.path));
    if (sha256(bytes) !== binding.sha256) throw new Error("materialization input drift detected");
    inputs.push({ relative: binding.path, bytes });
  }
  const next = [prepared.candidateBytes, prepared.productionScopeBytes, prepared.requestBytes, prepared.hashEvidenceBytes];
  const outputs = CANDIDATE_RELEASE_OUTPUTS.map((relative, index) =>
    ({ relative, bytes: next[index], prestateBytes: prestate[index], inputs }));
  const transaction = createCandidateReleaseTransaction({ label: "nationwide candidate", validateOutputs(values) {
    if (!Array.isArray(values) || values.length !== CANDIDATE_RELEASE_OUTPUTS.length
      || values.some((value, index) => value.relative !== CANDIDATE_RELEASE_OUTPUTS[index]
        || !Buffer.isBuffer(value.bytes) || !Buffer.isBuffer(value.prestateBytes))) {
      throw new Error("candidate transaction outputs mismatch");
    }
  } });
  await transaction.commit({ repositoryRoot, outputs, failAfter });
  return { candidateId: prepared.buildSpec.candidateId, buildSpecSha256: sha256(prepared.candidateBytes),
    targets: CANDIDATE_RELEASE_OUTPUTS };
}

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
  const admission = new Map(candidate.sourceSnapshots.map((row) => [row.snapshotId, row]));
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
      rawSha256: row.rawSha256, ...(admission.get(row.snapshotId).adminReviewRecordHash
        ? { adminReviewRecordHash: admission.get(row.snapshotId).adminReviewRecordHash }
        : { admissionRecordSha256s: admission.get(row.snapshotId).admissionRecordSha256s }),
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
  // 개발 조립 결과는 운영 candidate/request/hash evidence의 입력이 아니다.
  if (fixture.fixtureClass === "TEST_ONLY") {
    throw new Error("TEST_ONLY artifact cannot be used as datapack build input");
  }
  assertNationwideAssemblyInputs({
    assemblyInputs: fixture.assemblyInputs,
    expectedSourceIds: materialization.assemblySourceIds,
    selectedSources: fanIn.selectedSources,
  });
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
    const source = bySource.get(snapshot.sourceId);
    if (!source) throw new Error("candidate source inventory binding is required");
    const common = {
      snapshotId: snapshot.snapshotId, sourceId: snapshot.sourceId, rawObjectUri: snapshot.rawObjectUri,
      rawSha256: snapshot.rawSha256, redactedRequestFingerprint: snapshot.redactedRequestFingerprint,
      schemaFingerprint: snapshot.schemaFingerprint, licenseStatus: snapshot.licenseStatus,
      redistributionAllowed: snapshot.redistributionAllowed,
      snapshotStatus: snapshot.snapshotStatus, credentialRedacted: snapshot.credentialRedacted,
      freshnessExpiresAt: snapshot.freshnessExpiresAt,
    };
    if (source.admissionEvidence !== undefined) {
      const adminReviewRecordHash = source.admissionEvidence?.adminReviewRecordHash;
      if (!/^[a-f0-9]{64}$/.test(adminReviewRecordHash ?? "")) throw new Error("source admission adminReviewRecordHash is required");
      return { ...common, adminReviewRecordHash };
    }
    const head = fanIn.selectedSources.find(({ sourceId }) => sourceId === snapshot.sourceId);
    if (!source.scheduleAdmissionEvidence || !Array.isArray(head?.admissionRecordSha256s)) {
      throw new Error("native schedule admission records are required");
    }
    return { ...common, admissionRecordSha256s: structuredClone(head.admissionRecordSha256s) };
  });
  const buildSpec = {
    schemaVersion: 1, artifactKind: "datapack-candidate-build-spec",
    candidateId: releaseIdentity.candidateId, publishedAt: releaseIdentity.publishedAt,
    releaseSequence: releaseIdentity.releaseSequence, builderGitSha: builderIdentity.gitSha,
    builderVersion: builderIdentity.version, fixturePath: materialization.fixturePath,
    fixtureSha256: sha256(fixtureBytes),
    assemblySourceIds: [...materialization.assemblySourceIds].sort(compareIdentity),
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

export async function main(argv = process.argv.slice(2), { repositoryRoot = process.cwd() } = {}) {
  if (argv.length !== 2 || argv[0] !== "--preparation") throw new Error("usage: --preparation <repository-relative JSON>");
  const bindings = [];
  const read = async (relative) => {
    const bytes = await readFile(materializedPath(repositoryRoot, relative));
    bindings.push({ relative, bytes });
    return bytes;
  };
  const preparation = JSON.parse(await read(argv[1]));
  const keys = ["schemaVersion", "artifactKind", "scopeId", "materialization", "releaseIdentity", "builderIdentity", "authority", "routeEdgeInput"];
  if (!preparation || Object.keys(preparation).length !== keys.length || keys.some((key) => !Object.hasOwn(preparation, key))
    || preparation.schemaVersion !== 1 || preparation.artifactKind !== "nationwide-candidate-preparation") {
    throw new Error("candidate preparation shape mismatch");
  }
  const inputs = Object.fromEntries(await Promise.all(Object.entries(NATIONWIDE_CANDIDATE_INPUT_PATHS)
    .map(async ([name, relative]) => [name, JSON.parse(await read(relative))])));
  const scopePrestateBytes = await readFile(path.join(repositoryRoot, CANDIDATE_RELEASE_OUTPUTS[1]));
  const fixture = JSON.parse(await read(preparation.materialization.fixturePath));
  const routeBytes = await read(preparation.routeEdgeInput.path);
  if (sha256(routeBytes) !== preparation.routeEdgeInput.sha256) throw new Error("prepared route input digest mismatch");
  const route = JSON.parse(routeBytes);
  const selected = new Set(inputs.fanIn.selectedSources.map((row) => row.snapshotId));
  const sourceSetHash = sha256(JSON.stringify(inputs.sourceSnapshots.filter((row) => selected.has(row.snapshotId))));
  if (route.candidate?.candidateId !== preparation.releaseIdentity.candidateId
    || route.candidate?.sourceSetSha256 !== sourceSetHash) throw new Error("prepared route candidate identity mismatch");
  const scope = deriveNationwideProductionScope({ policyScope: JSON.parse(scopePrestateBytes),
    scopeId: preparation.scopeId, targets: inputs.targets, fanIn: inputs.fanIn,
    ownershipLedger: inputs.ownershipLedger, fixture, routeEdges: route.routeEdges });
  if (bindings.some(({ relative }) => CANDIDATE_RELEASE_OUTPUTS.includes(path.posix.normalize(relative)))) {
    throw new Error("preparation inputs overlap candidate outputs");
  }
  return commitNationwideReleaseArtifacts({ repositoryRoot, productionScopeBytes: jsonBytes(scope),
    materialization: preparation.materialization, releaseIdentity: preparation.releaseIdentity,
    builderIdentity: preparation.builderIdentity, authority: preparation.authority,
    preparationBindings: bindings, scopePrestateBytes });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await main();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
