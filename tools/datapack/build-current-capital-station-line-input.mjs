#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { canonicalCurrentCapitalFacilitySourceAdmissionJson } from "./build-current-capital-facility-source-admission.mjs";
import { canonicalCurrentExitAdmissionOciReceiptJson } from "./build-current-exit-admission-oci-receipt.mjs";
import { canonicalExitPathAdmissionJson } from "./build-exit-path-admission.mjs";
import { CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_KIND, verifyCurrentCapitalLiveChainFanInComponents } from "./build-current-capital-live-chain-boundary.mjs";
import { validateKricAccessibilitySnapshotIdentity } from "./collect-kric-accessibility-snapshots.mjs";
import { readCurrentCapitalAccessibilityTransitionBoundary } from "./current-capital-accessibility-transition.mjs";
export { canonicalCurrentCapitalStationLineInputJson } from "./current-capital-station-line-contract.mjs";
import { canonicalCurrentCapitalStationLineInputJson } from "./current-capital-station-line-contract.mjs";

const FILES = Object.freeze({
  facility: "tools/datapack/release/current-capital-facility-source-admission.json",
  exitNormalized: "tools/datapack/release/current-exit-admission-v2/exit-path-normalized-source-snapshot.json",
  exitAdmission: "tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json",
  exitReceipt: "tools/datapack/release/current-exit-admission-v2/exit-path-admission-oci-receipt.json",
  transferMetrics: "tools/datapack/release/current-transfer-topology-metrics.json",
  transferApplicability: "tools/datapack/release/current-capital-transfer-topology-applicability.json",
  inventory: "tools/datapack/source-inventory.json",
  snapshots: "tools/datapack/release/source-snapshots.json",
  candidate: "tools/datapack/release/candidate-build-spec.json",
  pack: "tools/datapack/release/capital-production-canonical-pack.json",
  policy: "release/product-gates/route-edge-evaluation-policy.json",
});
const SHA = /^[a-f0-9]{64}$/u;
const MOLIT = "molit-urban-rail-full-route";
const POSITIONS = "seoul-metro-route-map-positions";
const CURRENT_CAPITAL_SOURCE_ROSTER = [
  POSITIONS,
  "kric-subway-timetable",
  "seoul-metro-accessibility",
  "kric-station-convenience-standard",
  MOLIT,
  "seoulmetro-station-line-info",
  "incheon-transit-accessibility",
  "seoul-metro-transfer-distance-duration",
];
const BLOCKED = { stationId: "station-b35616704ce3", lineId: "seoul-2" };

export function buildCurrentCapitalStationLineInput(input) {
  assertInputKeys(input);
  const stationLines = canonicalStationLines(input.canonicalPack, input.facilityAdmission);
  const { candidate, evidenceSourceSetSha256, facilitySourceSetSha256, candidatePublishedAt } = validateCandidate(input, stationLines);
  const facility = buildAuthenticatedCurrentCapitalFacilityEvidenceRows({
    facilityAdmission: input.facilityAdmission,
    facilitySnapshotBytes: input.facilitySnapshotBytes,
    stationLines,
    admissionCandidate: {
      candidateId: candidate.candidateId,
      sourceSnapshotSetHash: facilitySourceSetSha256,
    },
    outputCandidate: candidate,
    candidatePublishedAt,
  });
  const exit = validateExit(input, stationLines, candidate, evidenceSourceSetSha256);
  const transfer = validateTransfer(input, stationLines, candidate);
  validatePolicy(input.policy);
  const evidenceRows = [...facility, ...exit, ...transfer].sort(compareEvidence);
  if (evidenceRows.length !== 641 || new Set(evidenceRows.map((row) => `${row.stationId}\0${row.lineId}\0${row.domain}`)).size !== 639) {
    throw new Error("full-capital evidence denominator mismatch");
  }
  return canonicalObject({ candidate, stationLines, evidenceRows });
}

export async function readCurrentCapitalInputs(repositoryRoot, { readTransitionBoundaryImpl = readCurrentCapitalAccessibilityTransitionBoundary, readCurrentFanInBoundaryImpl = null } = {}) {
  const root = path.resolve(repositoryRoot);
  const [entries, currentFanIn] = await Promise.all([
    Promise.all(Object.entries(FILES).map(async ([key, relative]) => [key, await readJson(root, relative)])),
    readCurrentFanInBoundaryImpl ? readCurrentFanInBoundaryImpl({ repositoryRoot: root }) : Promise.resolve(null),
  ]);
  const values = Object.fromEntries(entries);
  const sourceSetTransition = currentFanIn?.boundary ?? await readTransitionBoundaryImpl({ repositoryRoot: root });
  if (currentFanIn) {
    if (!currentFanIn.components || sourceSetTransition.kind !== CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_KIND) throw new Error("full-capital current fan-in reader mismatch");
  } else if (sourceSetTransition.currentCandidateBytesSha256 !== sha256(values.candidate.bytes)
    || sourceSetTransition.facilityAdmissionBytesSha256 !== sha256(values.facility.bytes)) {
    throw new Error("full-capital transition input snapshot mismatch");
  }
  if (canonicalCurrentCapitalFacilitySourceAdmissionJson(values.facility.value) !== values.facility.bytes.toString("utf8")) throw new Error("FACILITY admission bytes are not canonical");
  const snapshotPath = values.facility.value.sourceIdentity.snapshotPath;
  if (snapshotPath !== `tools/datapack/sources/${values.facility.value.sourceIdentity.snapshotId}.json` || path.isAbsolute(snapshotPath)) throw new Error("FACILITY snapshot path mismatch");
  const facilitySnapshot = await readStable(path.join(root, snapshotPath), "FACILITY snapshot");
  return {
    canonicalPack: values.pack.value,
    candidateBuildSpec: values.candidate.value,
    exitAdmission: values.exitAdmission.value,
    exitAdmissionBytes: values.exitAdmission.bytes,
    exitNormalized: values.exitNormalized.value,
    exitNormalizedBytes: values.exitNormalized.bytes,
    exitReceipt: values.exitReceipt.value,
    facilityAdmission: values.facility.value,
    facilitySnapshotBytes: facilitySnapshot.bytes,
    policy: values.policy.value,
    sourceInventory: values.inventory.value,
    sourceInventoryBytes: values.inventory.bytes,
    sourceSetTransition,
    ...(currentFanIn ? { currentFanInComponents: currentFanIn.components } : {}),
    sourceSnapshots: values.snapshots.value,
    transferApplicability: values.transferApplicability.value,
    transferMetrics: values.transferMetrics.value,
  };
}

// This CLI deliberately validates only.  The route builder owns the one atomic
// publication directory so a station-only invocation can never publish a half handoff.
export async function main(argv = process.argv.slice(2), { repositoryRoot = fileURLToPath(new URL("../../", import.meta.url)), log = console.log } = {}) {
  if (!Array.isArray(argv) || argv.length !== 0) throw new Error("full-capital station-line arguments mismatch");
  const result = buildCurrentCapitalStationLineInput(await readCurrentCapitalInputs(repositoryRoot));
  log(JSON.stringify({ stationLineCount: result.stationLines.length, evidenceRowCount: result.evidenceRows.length }));
  return result;
}

function validateCandidate(input, stationLines) {
  const spec = input.candidateBuildSpec;
  const exitCandidate = input.exitAdmission?.candidate;
  const transition = input.sourceSetTransition;
  const currentFanIn = transition?.kind === CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_KIND;
  const publicStaticV2Refresh = transition?.kind === "PUBLIC_STATIC_NETWORK_V2_SUCCESSOR_REFRESH";
  if (currentFanIn) {
    verifyCurrentCapitalLiveChainFanInComponents(transition, input.currentFanInComponents);
    verifyCurrentFanInInputProjection(input);
  }
  else assertKeys(transition, publicStaticV2Refresh
    ? ["currentCandidateBytesSha256", "currentCandidateSourceSetSha256", "evidenceSourceSetSha256", "facilityAdmissionBytesSha256", "kind", "molitPreviousSnapshotId", "positionPreviousSnapshotId", "predecessorCandidateSourceSetSha256"]
    : ["currentCandidateBytesSha256", "currentCandidateSourceSetSha256", "evidenceSourceSetSha256", "facilityAdmissionBytesSha256"], "full-capital source-set transition");
  if (typeof spec?.candidateId !== "string" || spec.candidateId === "" || !Array.isArray(spec.sourceSnapshots) || !Array.isArray(spec.sourceSnapshotIds)
    || spec.sourceSnapshots.length !== CURRENT_CAPITAL_SOURCE_ROSTER.length || spec.sourceSnapshotIds.length !== CURRENT_CAPITAL_SOURCE_ROSTER.length
    || !equalArrays(spec.sourceSnapshots.map(({ sourceId }) => sourceId), CURRENT_CAPITAL_SOURCE_ROSTER)
    || spec.sourceSnapshots.some((projection, index) => projection?.snapshotId !== spec.sourceSnapshotIds[index])
    || !SHA.test(spec.sourceSnapshotSetHash ?? "")) {
    throw new Error("full-capital candidate eighth projection mismatch");
  }
  const selected = spec.sourceSnapshotIds.map((id, index) => {
    const row = exactlyOne(input.sourceSnapshots, (entry) => entry?.snapshotId === id, "candidate source snapshot");
    if (row.sourceId !== spec.sourceSnapshots[index]?.sourceId) throw new Error("full-capital candidate source identity mismatch");
    return row;
  });
  const selectedIds = new Set(spec.sourceSnapshotIds);
  const selectedInLedgerOrder = input.sourceSnapshots.filter(({ snapshotId }) => selectedIds.has(snapshotId));
  if (selectedIds.size !== CURRENT_CAPITAL_SOURCE_ROSTER.length || selectedInLedgerOrder.length !== CURRENT_CAPITAL_SOURCE_ROSTER.length || sha256(JSON.stringify(selectedInLedgerOrder)) !== spec.sourceSnapshotSetHash) throw new Error("full-capital candidate source-set mismatch");
  const publicV2 = publicStaticV2Refresh ? {
    positions: requireCurrentPublicV2Head(selected, input.sourceSnapshots, POSITIONS, transition.positionPreviousSnapshotId),
    molit: requireCurrentPublicV2Head(selected, input.sourceSnapshots, MOLIT, transition.molitPreviousSnapshotId),
  } : null;
  const predecessorIds = new Set(currentFanIn ? spec.sourceSnapshotIds.slice(0, -1) : publicStaticV2Refresh
    ? spec.sourceSnapshotIds.slice(0, -1).map((snapshotId, index) => {
      const sourceId = spec.sourceSnapshots[index].sourceId;
      if (sourceId === POSITIONS) return publicV2.positions.previousSnapshotId;
      if (sourceId === MOLIT) return publicV2.molit.previousSnapshotId;
      return snapshotId;
    })
    : spec.sourceSnapshotIds.slice(0, -1));
  const predecessorInLedgerOrder = input.sourceSnapshots.filter(({ snapshotId }) => predecessorIds.has(snapshotId));
  const currentSeoulRows = publicStaticV2Refresh ? selected.filter(({ sourceId }) =>
    sourceId === "seoul-metro-accessibility") : [];
  const previousSeoulSnapshotId = currentSeoulRows[0]?.previousSnapshotId;
  const evidenceIds = currentFanIn ? new Set(spec.sourceSnapshotIds.slice(0, -1)) : publicStaticV2Refresh ? new Set(spec.sourceSnapshotIds.flatMap((snapshotId, index) => {
    const sourceId = spec.sourceSnapshots[index].sourceId;
    if (sourceId === "seoul-metro-transfer-distance-duration") return [];
    if (sourceId === "seoul-metro-accessibility") return [previousSeoulSnapshotId];
    if (sourceId === POSITIONS) return [publicV2.positions.previousSnapshotId];
    if (sourceId === MOLIT) return [publicV2.molit.previousSnapshotId];
    return [snapshotId];
  })) : predecessorIds;
  const evidenceInLedgerOrder = input.sourceSnapshots.filter(({ snapshotId }) => evidenceIds.has(snapshotId));
  if (currentFanIn
    ? transition.currentCandidateSourceSetSha256 !== spec.sourceSnapshotSetHash
      || transition.evidenceSourceSetSha256 === spec.sourceSnapshotSetHash
      || predecessorIds.size !== CURRENT_CAPITAL_SOURCE_ROSTER.length - 1
      || predecessorInLedgerOrder.length !== CURRENT_CAPITAL_SOURCE_ROSTER.length - 1
      || evidenceIds.size !== CURRENT_CAPITAL_SOURCE_ROSTER.length - 1
      || evidenceInLedgerOrder.length !== CURRENT_CAPITAL_SOURCE_ROSTER.length - 1
      || evidenceIds.has(spec.sourceSnapshotIds.at(-1))
      || sha256(JSON.stringify(evidenceInLedgerOrder)) !== transition.evidenceSourceSetSha256
    : ![transition.currentCandidateBytesSha256, transition.evidenceSourceSetSha256, transition.facilityAdmissionBytesSha256].every((value) => SHA.test(value ?? ""))
      || transition.currentCandidateSourceSetSha256 !== spec.sourceSnapshotSetHash
      || transition.evidenceSourceSetSha256 === spec.sourceSnapshotSetHash
      || (publicStaticV2Refresh
      ? !SHA.test(transition.predecessorCandidateSourceSetSha256 ?? "")
        || !nonBlank(transition.positionPreviousSnapshotId)
        || !nonBlank(transition.molitPreviousSnapshotId)
        || predecessorIds.size !== CURRENT_CAPITAL_SOURCE_ROSTER.length - 1 || predecessorInLedgerOrder.length !== CURRENT_CAPITAL_SOURCE_ROSTER.length - 1
        || currentSeoulRows.length !== 1 || !nonBlank(previousSeoulSnapshotId)
        || evidenceIds.size !== CURRENT_CAPITAL_SOURCE_ROSTER.length - 1 || evidenceInLedgerOrder.length !== CURRENT_CAPITAL_SOURCE_ROSTER.length - 1
        || sha256(JSON.stringify(predecessorInLedgerOrder)) !== transition.predecessorCandidateSourceSetSha256
        || sha256(JSON.stringify(evidenceInLedgerOrder)) !== transition.evidenceSourceSetSha256
      : predecessorIds.size !== CURRENT_CAPITAL_SOURCE_ROSTER.length - 1 || predecessorInLedgerOrder.length !== CURRENT_CAPITAL_SOURCE_ROSTER.length - 1
        || sha256(JSON.stringify(predecessorInLedgerOrder)) !== transition.evidenceSourceSetSha256)) throw new Error("full-capital source-set transition mismatch");
  if (!Buffer.isBuffer(input.sourceInventoryBytes) || canonicalJson(input.sourceInventory) !== canonicalJson(JSON.parse(input.sourceInventoryBytes.toString("utf8")))) throw new Error("full-capital source inventory raw binding mismatch");
  const inventorySha256 = sha256(JSON.stringify(input.sourceInventory));
  const inventoryRawSha256 = sha256(input.sourceInventoryBytes);
  if (spec.sourceInventorySha256 !== inventorySha256 || spec.networkEdgeEvidence?.sourceInventory?.path !== "tools/datapack/source-inventory.json" || spec.networkEdgeEvidence.sourceInventory.sha256 !== inventoryRawSha256) throw new Error("full-capital candidate inventory binding mismatch");
  const transferProjection = spec.sourceSnapshots.at(-1);
  const ledger = selected.at(-1);
  const source = exactlyOne(input.sourceInventory.sources ?? [], ({ id }) => id === "seoul-metro-transfer-distance-duration", "transfer source inventory");
  const keys = ["snapshotId", "sourceId", "rawObjectUri", "rawSha256", "redactedRequestFingerprint", "schemaFingerprint", "licenseStatus", "redistributionAllowed", "adminReviewRecordHash", "snapshotStatus", "credentialRedacted", "freshnessExpiresAt", "rawRetentionExpiresAt", "governancePolicyVersion", "governancePolicySha256"];
  const expected = Object.fromEntries(keys.map((keyName) => [keyName, keyName === "adminReviewRecordHash" ? source.admissionEvidence?.adminReviewRecordHash : ledger?.[keyName]]));
  if (ledger.sourceId !== "seoul-metro-transfer-distance-duration" || ledger.snapshotStatus !== "LOCKED" || source.transferAdmissionEvidence?.snapshotId !== ledger.snapshotId || spec.sourceSnapshotIds.at(-1) !== ledger.snapshotId || canonicalJson(transferProjection) !== canonicalJson(expected)) throw new Error("full-capital transfer ledger mismatch");
  if (!exitCandidate || exitCandidate.candidateId !== spec.candidateId || exitCandidate.sourceSetSha256 !== transition.evidenceSourceSetSha256) throw new Error("full-capital EXIT candidate mismatch");
  const stationIds = [...new Set(stationLines.map(({ stationId }) => stationId))].sort(compareBytes);
  if (exitCandidate.stationSetSha256 !== sha256(canonicalJson(stationIds)) || exitCandidate.mappingContractVersion !== "station-line-v1" || exitCandidate.materializerVersion !== "1") {
    throw new Error("full-capital station candidate mismatch");
  }
  return {
    candidate: canonicalObject({
      candidateId: spec.candidateId,
      mappingContractVersion: exitCandidate.mappingContractVersion,
      materializerVersion: exitCandidate.materializerVersion,
      sourceSetSha256: spec.sourceSnapshotSetHash,
      stationSetSha256: exitCandidate.stationSetSha256,
    }),
    evidenceSourceSetSha256: transition.evidenceSourceSetSha256,
    facilitySourceSetSha256: publicStaticV2Refresh ? transition.evidenceSourceSetSha256 : spec.sourceSnapshotSetHash,
    candidatePublishedAt: requiredUtcMillis(spec.publishedAt, "full-capital candidate publishedAt"),
  };
}

function requireNoLegacyMetadata(value) {
  const visit = (current) => {
    if (Array.isArray(current)) return current.forEach(visit);
    if (!current || typeof current !== "object") return;
    for (const [key, child] of Object.entries(current)) {
      if (["projectionMigration", "migration", "historicalPredecessorAudit", "rootSupersession"].includes(key)) {
        throw new Error("full-capital public v2 legacy metadata mismatch");
      }
      visit(child);
    }
  };
  visit(value);
}

function requireCurrentPublicV2Head(selected, ledger, sourceId, transitionPreviousSnapshotId) {
  const head = exactlyOne(selected, ({ sourceId: actual }) => actual === sourceId, `current ${sourceId} head`);
  const previousSnapshotId = head?.previousSnapshotId;
  const observation = head?.publicStaticNetworkV2Observation;
  requireNoLegacyMetadata(head);
  if (observation?.schemaVersion !== 2
    || observation.artifactKind !== "public-static-network-v2-observation"
    || observation.sourceId !== sourceId
    || observation.snapshotId !== head.snapshotId
    || previousSnapshotId !== transitionPreviousSnapshotId
    || !nonBlank(previousSnapshotId)
    || previousSnapshotId === head.snapshotId
    || ledger.filter(({ snapshotId, sourceId: actual }) => snapshotId === previousSnapshotId && actual === sourceId).length !== 1) {
    throw new Error("full-capital public v2 successor mismatch");
  }
  return { head, previousSnapshotId };
}

function canonicalStationLines(pack, facilityAdmission) {
  const capital = pack?.packs?.filter(({ id }) => id === "capital");
  if (pack?.manifest?.channel !== "production" || pack?.manifest?.activePack?.id !== "capital" || capital?.length !== 1) throw new Error("full-capital canonical pack mismatch");
  if (!Array.isArray(facilityAdmission?.cells) || facilityAdmission.cells.length !== 213) throw new Error("full-capital station selector denominator mismatch");
  const selected = new Map();
  for (const { stationId, lineId } of facilityAdmission.cells) {
    if (!nonBlank(stationId) || !nonBlank(lineId) || selected.has(`${stationId}\0${lineId}`)) throw new Error("full-capital station selector mismatch");
    selected.set(`${stationId}\0${lineId}`, { stationId, lineId });
  }
  const lineMetadata = new Map();
  for (const line of capital[0].lines ?? []) {
    if (!lineMetadata.has(line?.id)) lineMetadata.set(line?.id, []);
    lineMetadata.get(line?.id).push(line);
  }
  const stationLineMetadata = new Map();
  for (const line of capital[0].stationLines ?? []) {
    const lineKey = `${line?.stationId}\0${line?.lineId}`;
    if (!stationLineMetadata.has(lineKey)) stationLineMetadata.set(lineKey, []);
    stationLineMetadata.get(lineKey).push(line);
  }
  const lines = [...selected.entries()].map(([lineKey, identity]) => {
    const stationMatches = stationLineMetadata.get(lineKey) ?? [];
    const operatorMatches = lineMetadata.get(identity.lineId) ?? [];
    if (stationMatches.length !== 1 || operatorMatches.length !== 1) throw new Error("full-capital canonical station selection mismatch");
    return { ...identity, operatorId: operatorMatches[0].operatorId };
  }).sort(compareStationLine);
  if (lines.length !== 213 || new Set(lines.map(({ stationId, lineId }) => `${stationId}\0${lineId}`)).size !== 213 || new Set(lines.map(({ stationId }) => stationId)).size !== 199
    || lines.some(({ stationId, lineId, operatorId }) => !nonBlank(stationId) || !nonBlank(lineId) || operatorId !== "seoul-metro")) throw new Error("full-capital station denominator mismatch");
  return lines;
}

export function buildAuthenticatedCurrentCapitalFacilityEvidenceRows({
  facilityAdmission: value,
  facilitySnapshotBytes: snapshotBytes,
  stationLines,
  admissionCandidate,
  outputCandidate,
  candidatePublishedAt,
}) {
  canonicalCurrentCapitalFacilitySourceAdmissionJson(value);
  if (value.decision !== "GO"
    || value.candidate?.candidateId !== admissionCandidate?.candidateId
    || value.candidate?.sourceSnapshotSetHash !== admissionCandidate?.sourceSnapshotSetHash
    || !nonBlank(outputCandidate?.candidateId)
    || ![outputCandidate?.stationSetSha256, outputCandidate?.sourceSetSha256].every((entry) => SHA.test(entry ?? ""))
    || !nonBlank(outputCandidate?.mappingContractVersion)
    || !nonBlank(outputCandidate?.materializerVersion)) throw new Error("full-capital FACILITY identity mismatch");
  if (!Buffer.isBuffer(snapshotBytes)) throw new Error("full-capital FACILITY snapshot bytes mismatch");
  let snapshot; try { snapshot = validateKricAccessibilitySnapshotIdentity(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(snapshotBytes))); } catch (error) { throw new Error("full-capital FACILITY snapshot identity mismatch", { cause: error }); }
  if (sha256(snapshotBytes) !== value.sourceIdentity.snapshotFileSha256 || snapshot.snapshotId !== value.sourceIdentity.snapshotId || snapshot.sourceId !== value.sourceIdentity.sourceId || snapshot.rawSha256 !== value.sourceIdentity.rawSha256 || snapshot.contentSha256 !== value.sourceIdentity.contentSha256 || snapshot.schemaFingerprint !== value.sourceIdentity.schemaFingerprint || snapshot.redactedRequestFingerprint !== value.sourceIdentity.redactedRequestFingerprint || snapshot.capturedAt !== value.sourceIdentity.capturedAt || snapshot.observedAt !== value.sourceIdentity.observedAt || snapshot.freshUntil !== value.sourceIdentity.freshUntil) throw new Error("full-capital FACILITY snapshot binding mismatch");
  if (!Number.isFinite(candidatePublishedAt)
    || requiredUtcMillis(value.sourceIdentity.freshUntil, "full-capital FACILITY freshUntil") <= candidatePublishedAt) throw new Error("full-capital FACILITY freshness mismatch");
  const cells = indexExact(value.cells, stationLines, "FACILITY cells");
  const blocked = cells.get(key(BLOCKED));
  if (blocked?.state !== "ADMITTED_FACILITY_UNVERIFIED_BLOCKED" || value.cells.filter(({ state }) => state === "ADMITTED_FACILITY_UNVERIFIED_BLOCKED").length !== 1) throw new Error("full-capital FACILITY blocked tuple mismatch");
  const rows = value.denominatorRows.filter(({ stationId, lineId }) => stationId === BLOCKED.stationId && lineId === BLOCKED.lineId);
  const requiredFacilityTypes = ["ELEVATOR", "ESCALATOR", "WHEELCHAIR_LIFT"];
  if (rows.length !== 3 || rows.some(({ state }) => state !== "UNVERIFIED_EVIDENCE_BLOCKED")
    || canonicalJson(rows.map(({ facilityType }) => facilityType).sort(compareBytes)) !== canonicalJson(requiredFacilityTypes)) throw new Error("full-capital FACILITY blocked carrier mismatch");
  const queries = indexExact(snapshot.queries, stationLines, "FACILITY snapshot queries");
  return stationLines.flatMap((line) => {
    const cell = cells.get(key(line));
    const blockedCell = cell.state === "ADMITTED_FACILITY_UNVERIFIED_BLOCKED";
    const query = queries.get(key(line));
    if (blockedCell) return ["ELEVATOR", "ESCALATOR", "WHEELCHAIR_LIFT"].map((facilityType) => terminalEvidence(line, facilityType, query, value.sourceIdentity, outputCandidate));
    const state = cell.state === "ADMITTED_FACILITY_PRESENT" ? "VERIFIED_PRESENT" : "VERIFIED_ABSENT";
    const kind = state === "VERIFIED_PRESENT" ? "OBSERVED" : "EXHAUSTIVE_LIST";
    return [evidence(line, "FACILITY", state, value.sourceIdentity, outputCandidate, kind, query.providerRecordHash)];
  });
}

function validateExit(input, stationLines, candidate, evidenceSourceSetSha256) {
  const receipt = input.exitReceipt;
  if (canonicalCurrentExitAdmissionOciReceiptJson(receipt) !== canonicalJson(receipt)
    || sha256(input.exitNormalizedBytes) !== receipt.normalizedSnapshotSha256 || sha256(input.exitAdmissionBytes) !== receipt.admissionSha256) throw new Error("full-capital EXIT receipt binding mismatch");
  if (canonicalExitPathAdmissionJson(input.exitAdmission) !== input.exitAdmissionBytes.toString("utf8") || input.exitAdmission.admissionDigest !== receipt.admissionDigest || input.exitAdmission.schemaVersion !== 2 || input.exitAdmission.decision !== "GO") throw new Error("full-capital EXIT admission binding mismatch");
  const normalized = input.exitNormalized;
  if (canonicalJson(normalized) !== input.exitNormalizedBytes.toString("utf8") || normalized?.schemaVersion !== 4 || normalized?.sourceId !== input.exitAdmission.sourceIdentity?.sourceId
    || normalized?.snapshotId !== input.exitAdmission.sourceIdentity?.snapshotId || normalized?.queryPlan?.length !== 420 || normalized?.results?.length !== 420) throw new Error("full-capital EXIT normalized identity mismatch");
  if (input.exitAdmission.candidate?.candidateId !== candidate.candidateId || input.exitAdmission.candidate?.sourceSetSha256 !== evidenceSourceSetSha256
    || input.exitAdmission.candidate?.stationSetSha256 !== candidate.stationSetSha256) throw new Error("full-capital EXIT candidate mismatch");
  const projection = stationLines.map(({ stationId, lineId, operatorId }) => ({ stationId, lineId, operatorId })).sort(compareStationLine);
  if (input.exitAdmission.stationLineSetSha256 !== sha256(canonicalJson(projection))) throw new Error("full-capital EXIT station-line set binding mismatch");
  const queries = new Map((input.exitNormalized.queryPlan ?? []).map((query) => [query.queryId, query]));
  const mappings = stationLines.map((line) => {
    const stationLineId = `${line.stationId}:${line.lineId}`;
    const joined = (input.exitAdmission.queryPartition?.joined ?? []).filter((row) => row?.stationLineId === stationLineId).map(({ queryId }) => queries.get(queryId));
    const identities = new Map(joined.map((query) => [canonicalJson({ stationName: query?.stationName, lineName: query?.lineName, operatorName: query?.operatorName, regionId: query?.regionId }), query]));
    if (identities.size !== 1) throw new Error("full-capital EXIT station-line mapping identity mismatch");
    const query = identities.values().next().value;
    return { stationId: line.stationId, stationName: query.stationName, stationAliases: [], regionId: query.regionId, lineId: line.lineId, lineName: query.lineName, operatorId: line.operatorId, operatorName: query.operatorName };
  }).sort(compareStationLine);
  if (input.exitAdmission.stationLineMappingSha256 !== sha256(canonicalJson(mappings))) throw new Error("full-capital EXIT station-line mapping binding mismatch");
  const rows = indexExact(input.exitAdmission.materializerEvidenceRows, stationLines, "EXIT evidence");
  return stationLines.map((line) => {
    const row = rows.get(key(line));
    validateExitEvidenceRow(row, input.exitAdmission);
    return canonicalObject({ ...row, candidateId: candidate.candidateId, stationSetSha256: candidate.stationSetSha256, sourceSetSha256: candidate.sourceSetSha256, mappingContractVersion: candidate.mappingContractVersion, materializerVersion: candidate.materializerVersion });
  });
}

function validateExitEvidenceRow(row, admission) {
  const admissionCandidate = admission.candidate;
  const source = admission.sourceIdentity;
  if (row?.domain !== "EXIT" || row.candidateId !== admissionCandidate.candidateId
    || row.stationSetSha256 !== admissionCandidate.stationSetSha256 || row.sourceSetSha256 !== admissionCandidate.sourceSetSha256
    || row.mappingContractVersion !== admissionCandidate.mappingContractVersion || row.materializerVersion !== admissionCandidate.materializerVersion
    || row.sourceId !== source.sourceId || row.sourceSnapshotId !== source.snapshotId
    || row.evidenceRawSha256 !== source.rawSha256) throw new Error("full-capital EXIT identity mismatch");
  if (["VERIFIED_PRESENT", "VERIFIED_ABSENT"].includes(row.state)) {
    const allowedKind = row.state === "VERIFIED_PRESENT" ? "OBSERVED" : ["EXPLICIT_ZERO", "EXHAUSTIVE_LIST"];
    if ((Array.isArray(allowedKind) ? !allowedKind.includes(row.evidenceKind) : row.evidenceKind !== allowedKind)
      || !SHA.test(row.providerRecordHash ?? "")) throw new Error("full-capital EXIT state mismatch");
    return;
  }
  if (row.state !== "UNVERIFIED_EVIDENCE_BLOCKED" || row.evidenceKind !== "UNVERIFIED_EVIDENCE_BLOCKED"
    || row.sourceId !== "kric-station-movement-standard" || row.providerRecordHash !== null
    || row.evidenceReason !== "출구 이동경로가 검증되지 않아 경로를 차단했습니다."
    || row.terminalPolicy !== "PROVIDER_NO_DATA_RESULT_03_BLOCKED" || row.providerResultCode !== "03"
    || row.strictRouteEligible !== false || row.strictRouteEligibleReason !== "UNVERIFIED_PROVIDER_EVIDENCE_BLOCKED"
    || row.statusMeaning !== "PROVIDER_NO_DATA_NOT_ABSENCE" || row.confidence !== 0
    || !SHA.test(row.providerResponseSha256 ?? "")) throw new Error("full-capital EXIT terminal mismatch");
  const expectedEvidenceHash = sha256(canonicalJson({
    sourceSnapshotId: row.sourceSnapshotId,
    stationId: row.stationId,
    lineId: row.lineId,
    operatorId: row.operatorId,
    domain: "EXIT",
    terminalPolicy: row.terminalPolicy,
    providerResponseSha256: row.providerResponseSha256,
  }));
  if (row.evidenceHash !== expectedEvidenceHash) throw new Error("full-capital EXIT terminal hash mismatch");
}

function validateTransfer(input, stationLines, candidate) {
  const { transferMetrics: metrics, transferApplicability: applicability, sourceInventory: inventory } = input;
  if (metrics?.artifactKind !== "current-transfer-topology-metrics" || metrics?.physicalPairs?.length !== 15 || metrics?.metrics?.length !== 30
    || metrics.metrics.filter(({ metricProvenance }) => metricProvenance === "OFFICIAL_SOURCE").length !== 28 || metrics.metrics.filter(({ metricProvenance }) => metricProvenance === "DERIVED_RECIPROCAL").length !== 2
    || metrics.metrics.some(({ durationRole, distanceMeters, officialDurationSecondsReference }) => durationRole !== "REFERENCE_ONLY" || !Number.isSafeInteger(distanceMeters) || distanceMeters <= 0 || !Number.isSafeInteger(officialDurationSecondsReference) || officialDurationSecondsReference <= 0)
    || metrics.artifactSha256 !== sha256(canonicalJson(without(metrics, "artifactSha256")))) throw new Error("full-capital TRANSFER metrics mismatch");
  const stationLineKeys = new Set(stationLines.map(key));
  const expectedDirections = new Set();
  for (const pair of metrics.physicalPairs) {
    if (!nonBlank(pair?.stationId) || !Array.isArray(pair.lineIds) || pair.lineIds.length !== 2 || pair.lineIds[0] === pair.lineIds[1]
      || pair.lineIds.some((lineId) => !stationLineKeys.has(`${pair.stationId}\0${lineId}`))) throw new Error("full-capital TRANSFER physical pair mismatch");
    expectedDirections.add(transferDirectionKey(pair.stationId, pair.lineIds[0], pair.lineIds[1]));
    expectedDirections.add(transferDirectionKey(pair.stationId, pair.lineIds[1], pair.lineIds[0]));
  }
  const actualDirections = new Set(metrics.metrics.map(({ stationId, fromLineId, toLineId }) => transferDirectionKey(stationId, fromLineId, toLineId)));
  if (expectedDirections.size !== 30 || actualDirections.size !== 30 || !equalSets(expectedDirections, actualDirections)) throw new Error("full-capital TRANSFER directed pair mismatch");
  if (applicability?.artifactKind !== "current-capital-transfer-topology-applicability-pre-candidate" || applicability.candidateBinding !== null || applicability.productionUseAllowed !== false
    || applicability.artifactSha256 !== sha256(`${canonicalJson(without(applicability, "artifactSha256"))}\n`) || canonicalJson(applicability.canonicalIdentity) !== canonicalJson(metrics.canonicalIdentity)
    || canonicalJson(applicability.sourceIdentity) !== canonicalJson(metrics.sourceIdentity) || applicability.transferTopologyMetricsIdentity?.artifactSha256 !== metrics.artifactSha256) throw new Error("full-capital TRANSFER applicability mismatch");
  const source = exactlyOne(inventory?.sources ?? [], ({ id }) => id === "seoul-metro-transfer-distance-duration", "transfer source inventory");
  const admission = source.transferAdmissionEvidence;
  if (source.requiredForProductionPack !== true || admission?.decision !== "APPROVED" || admission.metricsArtifactSha256 !== metrics.artifactSha256 || admission.applicabilityArtifactSha256 !== applicability.artifactSha256
    || admission.physicalPairCount !== 15 || admission.directedMetricCount !== 30 || admission.officialMetricCount !== 28 || admission.derivedReciprocalMetricCount !== 2 || admission.durationRole !== "REFERENCE_ONLY") throw new Error("full-capital TRANSFER admission mismatch");
  const cells = indexExact(applicability.cells, stationLines, "TRANSFER applicability");
  const endpoints = new Set(metrics.metrics.flatMap(({ stationId, fromLineId, toLineId }) => [`${stationId}\0${fromLineId}`, `${stationId}\0${toLineId}`]));
  const applicableEndpoints = new Set([...cells.entries()].filter(([, { state }]) => state === "APPLICABLE_TRANSFER_ENDPOINT").map(([cellKey]) => cellKey));
  if (endpoints.size !== 27 || applicableEndpoints.size !== 27 || !equalSets(endpoints, applicableEndpoints)) throw new Error("full-capital TRANSFER endpoint mismatch");
  return stationLines.map((line) => {
    const state = cells.get(key(line)).state;
    if (!["APPLICABLE_TRANSFER_ENDPOINT", "NOT_APPLICABLE_IN_CANONICAL_PAIR_SET"].includes(state)) throw new Error("full-capital TRANSFER state mismatch");
    return evidence(line, "TRANSFER", state === "APPLICABLE_TRANSFER_ENDPOINT" ? "VERIFIED_PRESENT" : "NOT_APPLICABLE", {
      sourceId: metrics.sourceIdentity.sourceId, snapshotId: admission.snapshotId, rawSha256: metrics.sourceIdentity.rawSha256,
      capturedAt: metrics.sourceIdentity.capturedAt, freshUntil: admission.freshUntil, licenseEvidenceHash: admission.licenseEvidenceHash,
    }, candidate, state === "APPLICABLE_TRANSFER_ENDPOINT" ? "OBSERVED" : "CURRENT_APPLICABILITY_RULE", metrics.artifactSha256);
  });
}

function evidence(line, domain, state, source, candidate, evidenceKind, providerRecordHash = undefined) {
  if (["UNKNOWN", "MISSING", "STALE", "NOT_EVALUATED"].includes(state) || !nonBlank(source?.sourceId) || !SHA.test(source?.rawSha256 ?? "")) throw new Error("full-capital unresolved evidence state");
  if (!SHA.test(providerRecordHash ?? "")) throw new Error("full-capital provider record binding mismatch");
  return canonicalObject({ candidateId: candidate.candidateId, stationSetSha256: candidate.stationSetSha256, sourceSetSha256: candidate.sourceSetSha256, stationId: line.stationId, lineId: line.lineId, operatorId: line.operatorId, domain, state, sourceId: source.sourceId, sourceSnapshotId: source.snapshotId, evidenceRawSha256: source.rawSha256, providerRecordHash, capturedAt: source.capturedAt, freshUntil: source.freshUntil, provenanceId: source.rawSha256, licenseId: source.licenseEvidenceHash, mappingContractVersion: candidate.mappingContractVersion, materializerVersion: candidate.materializerVersion, evidenceKind, evidenceReason: evidenceKind === "CURRENT_APPLICABILITY_RULE" ? "canonical transfer applicability" : "current full-capital admission" });
}

function terminalEvidence(line, facilityType, query, source, candidate) {
  if (query?.providerResultCode !== "03" || !SHA.test(query.rawResponseSha256 ?? "") || query.providerRecordHash !== null) throw new Error("full-capital terminal provider binding mismatch");
  const terminalPolicy = "EXACT_TUPLE_PROVIDER_RESULT_03";
  const evidenceHash = sha256(canonicalJson({ sourceSnapshotId: source.snapshotId, stationId: line.stationId, lineId: line.lineId, operatorId: line.operatorId, facilityType, terminalPolicy, providerResponseSha256: query.rawResponseSha256 }));
  return canonicalObject({ candidateId: candidate.candidateId, stationSetSha256: candidate.stationSetSha256, sourceSetSha256: candidate.sourceSetSha256, stationId: line.stationId, lineId: line.lineId, operatorId: line.operatorId, domain: "FACILITY", state: "UNVERIFIED_EVIDENCE_BLOCKED", sourceId: source.sourceId, sourceSnapshotId: source.snapshotId, evidenceRawSha256: source.rawSha256, providerRecordHash: null, capturedAt: source.capturedAt, freshUntil: source.freshUntil, provenanceId: source.rawSha256, licenseId: source.licenseEvidenceHash, mappingContractVersion: candidate.mappingContractVersion, materializerVersion: candidate.materializerVersion, evidenceKind: "UNVERIFIED_EVIDENCE_BLOCKED", evidenceReason: "시설 존재·부재가 검증되지 않아 경로를 차단했습니다.", facilityType, terminalPolicy, providerResultCode: "03", strictRouteEligible: false, strictRouteEligibleReason: "UNVERIFIED_PROVIDER_EVIDENCE_BLOCKED", installationStatus: "UNKNOWN", operationalStatus: "UNKNOWN", statusMeaning: "PROVIDER_RESULT_UNVERIFIED", confidence: 0, providerResponseSha256: query.rawResponseSha256, evidenceHash });
}

function validatePolicy(policy) { if (policy?.artifactKind !== "route-edge-evaluation-policy" || policy.policyVersion !== "route-edge-evaluation-v2" || policy.edgeDomainMap?.RIDE?.endpointTarget !== "NONE") throw new Error("full-capital route policy mismatch"); }
function assertInputKeys(input) {
  const base = ["canonicalPack", "candidateBuildSpec", "exitAdmission", "exitAdmissionBytes", "exitNormalized", "exitNormalizedBytes", "exitReceipt", "facilityAdmission", "facilitySnapshotBytes", "policy", "sourceInventory", "sourceInventoryBytes", "sourceSetTransition", "sourceSnapshots", "transferApplicability", "transferMetrics"];
  const currentFanIn = input?.sourceSetTransition?.kind === CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_KIND;
  assertKeys(input, currentFanIn ? [...base, "currentFanInComponents"] : base, "full-capital input");
}
function verifyCurrentFanInInputProjection(input) {
  const expected = {
    candidateBuildSpec: input.candidateBuildSpec,
    facilityAdmission: input.facilityAdmission,
    transferMetrics: input.transferMetrics,
    transferApplicability: input.transferApplicability,
    sourceInventory: input.sourceInventory,
    sourceSnapshotLedger: input.sourceSnapshots,
    exitNormalized: input.exitNormalized,
    exitAdmission: input.exitAdmission,
    exitAdmissionOciReceipt: input.exitReceipt,
  };
  for (const [name, value] of Object.entries(expected)) {
    if (canonicalJson(value) !== canonicalJson(input.currentFanInComponents?.[name]?.value)) throw new Error(`full-capital current fan-in ${name} projection mismatch`);
  }
}
function indexExact(rows, stationLines, label) { if (!Array.isArray(rows) || rows.length !== 213) throw new Error(`${label} denominator mismatch`); const map = new Map(rows.map((row) => [key(row), row])); if (map.size !== 213 || stationLines.some((line) => !map.has(key(line)))) throw new Error(`${label} mapping mismatch`); return map; }
async function readJson(root, relative) { return readStable(path.join(root, relative), relative); }
async function readStable(file, label) {
  if (!Number.isInteger(constants.O_NOFOLLOW)) throw new Error(`${label} cannot enforce O_NOFOLLOW`);
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { throw new Error(`${label} must be a regular non-symlink file`, { cause: error }); }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const boundPath = await lstat(file);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.dev !== boundPath.dev || before.ino !== boundPath.ino || boundPath.isSymbolicLink()) throw new Error(`${label} changed while reading`);
    let value;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new Error(`${label} must be UTF-8 JSON`); }
    return { bytes, value };
  } finally { await handle.close(); }
}
function assertKeys(value, keys, label) { if (!value || typeof value !== "object" || Array.isArray(value) || canonicalJson(Object.keys(value).sort(compareBytes)) !== canonicalJson([...keys].sort(compareBytes))) throw new Error(`${label} keys mismatch`); }
function exactlyOne(rows, predicate, label) { const matches = rows.filter(predicate); if (matches.length !== 1) throw new Error(`${label} must be exactly one`); return matches[0]; }
function transferDirectionKey(stationId, fromLineId, toLineId) { return `${stationId}\0${fromLineId}\0${toLineId}`; }
function equalSets(left, right) { return left.size === right.size && [...left].every((value) => right.has(value)); }
function equalArrays(left, right) { return left.length === right.length && left.every((value, index) => value === right[index]); }
function key({ stationId, lineId }) { return `${stationId}\0${lineId}`; }
function compareStationLine(left, right) { return compareBytes(left.stationId, right.stationId) || compareBytes(left.lineId, right.lineId) || compareBytes(left.operatorId, right.operatorId); }
function compareEvidence(left, right) { return compareStationLine(left, right) || compareBytes(left.domain, right.domain); }
function canonicalObject(value) { if (Array.isArray(value)) return value.map(canonicalObject); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.keys(value).sort(compareBytes).map((keyName) => [keyName, canonicalObject(value[keyName])])); }
function canonicalJson(value) { return JSON.stringify(canonicalObject(value)); }
function without(value, name) { const { [name]: _ignored, ...rest } = value; return rest; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function nonBlank(value) { return typeof value === "string" && value.trim() !== ""; }
function requiredUtcMillis(value, label) { const millis = Date.parse(value ?? ""); if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) throw new Error(`${label} mismatch`); return millis; }
function compareBytes(left, right) { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
