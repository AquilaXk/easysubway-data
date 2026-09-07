import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { selectRetainedKricTimetable } from "./build-kric-retained-file-pending-handoff.mjs";
import { loadCurrentMolitGwangjuStationMappings } from "./current-molit-observation.mjs";
import { validateRetainedGwangjuSource } from "./materialize-gwangju-timetable.mjs";
import { validateRetainedKricTimetableReceipt } from "./publish-retained-kric-timetable.mjs";
import { prepareRetainedKricTimetablePublication } from "./prepare-retained-kric-timetable-publication.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { SOURCE_REGISTRATION_OUTPUTS, createSourceRegistrationTransaction } from "./lib/source-registration-transaction.mjs";
import { buildSnapshotDiff, validateLineage } from "./source-snapshot-policy.mjs";
import { buildAppendOnlyGovernancePolicyRegistration, validateSourceGovernancePolicy } from "./source-governance-policy.mjs";

const SOURCE_ID = "kric-nationwide-timetable-file";
const TOPOLOGY_SOURCE_ID = "gwangju-transportation-route-topology";
const SUPERSEDED_SOURCE_ID = "gwangju-transportation-cyberstation-timetable";
const OUTPUTS = SOURCE_REGISTRATION_OUTPUTS;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const bytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

export async function buildRetainedKricTimetableRegistrationOutputs({ repositoryRoot, sourceInputPath, now = new Date(), env = process.env } = {}) {
  const root = rootPath(repositoryRoot), inputPath = absolute(sourceInputPath, "SOURCE_INPUT");
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) fail("TIME");
  const [inventoryBytes, ledgerBytes, governanceBytes, freshnessBytes, candidateBytes, inputBytes] = await Promise.all([
    ...OUTPUTS.map((relative) => readFile(path.join(root, relative))),
    readFile(path.join(root, "tools/datapack/source-candidates.json")), readFile(inputPath),
  ]);
  const input = exactInput(parse(inputBytes, "SOURCE_INPUT"));
  const paths = Object.fromEntries(Object.entries(input).filter(([key]) => key.endsWith("Path")));
  const resolved = Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, absolute(value, key)]));
  const unique = Object.values(resolved);
  const outputPaths = OUTPUTS.map((relative) => path.join(root, relative));
  if (new Set(unique).size !== unique.length || unique.includes(inputPath)
    || [...unique, inputPath].some((value) => outputPaths.includes(value))) fail("INPUT_ALIAS");
  const [observationBytes, collectionReceiptBytes, publicationReceiptBytes, contractBytes] = await Promise.all([
    readFile(resolved.observationPath), readFile(resolved.collectionReceiptPath), readFile(resolved.publicationReceiptPath),
    readFile(resolved.retainedContractPath),
  ]);
  const [inventory, ledger, governance, freshness, candidates, observation, collectionReceipt, contract] = [
    parse(inventoryBytes, "INVENTORY"), parse(ledgerBytes, "LEDGER"), parse(governanceBytes, "GOVERNANCE"), parse(freshnessBytes, "FRESHNESS"),
    parse(candidateBytes, "CANDIDATES"), parse(observationBytes, "OBSERVATION"), parse(collectionReceiptBytes, "COLLECTION_RECEIPT"),
    parse(contractBytes, "CONTRACT"),
  ];
  const candidate = select(candidates.candidates, (entry) => entry?.id === SOURCE_ID, "CANDIDATE");
  const topology = select(inventory.sources, (entry) => entry?.id === TOPOLOGY_SOURCE_ID, "TOPOLOGY");
  const state = registrationState({ inventory, ledger, governance, freshness, candidate });
  const topologyPath = topologySnapshotPath(root, topology);
  const topologyBytes = await readFile(topologyPath);
  const topologySnapshot = parse(topologyBytes, "TOPOLOGY_SNAPSHOT");
  const molit = await loadCurrentMolitGwangjuStationMappings({
    repositoryRoot: root, inventory, inventoryBytes, snapshots: ledger, snapshotsBytes: ledgerBytes,
    topologySnapshot, topologyBytes,
  });
  const mappings = molit.mappings;
  const governanceEntry = verifiedGovernanceEntry(input.governanceEntry, candidate, now);
  const registration = state.kind === "initial"
    ? buildAppendOnlyGovernancePolicyRegistration({ predecessorPolicyBytes: governanceBytes, addedSources: [governanceEntry] })
    : { policy: governance, bytes: governanceBytes };
  const freshnessClass = confirmationClass(candidate);
  if (state.kind === "refresh" && (canonicalJson(governanceEntry) !== canonicalJson(state.governanceEntry)
    || canonicalJson(freshnessClass) !== canonicalJson(state.freshnessClass))) fail("REFRESH_POLICY");
  const nextFreshness = state.kind === "initial"
    ? { ...freshness, sourceClasses: [...freshness.sourceClasses, freshnessClass] }
    : freshness;
  const retainedTimetable = { ...contract, observation, receipt: collectionReceipt };
  const selected = selectRetainedKricTimetable({ observation, receipt: collectionReceipt, routeNumber: retainedTimetable.routeNumber });
  const prepared = prepareRetainedKricTimetablePublication({ candidate, observationBytes, receipt: collectionReceipt,
    routeNumber: retainedTimetable.routeNumber, sourcePath: "observation.json", evaluationAt: now.toISOString(), providerValidUntil: input.providerValidUntil });
  const publication = validateRetainedKricTimetableReceipt({ receiptBytes: publicationReceiptBytes, observationBytes,
    receipt: collectionReceipt, candidate, routeNumber: retainedTimetable.routeNumber, governancePolicy: registration.policy,
    env, evaluationAt: now.toISOString(), providerValidUntil: input.providerValidUntil });
  if (publication.snapshotId !== `${SOURCE_ID}-${selected.summary.observationIdentitySha256}` || publication.observationIdentitySha256 !== selected.summary.observationIdentitySha256
    || publication.freshnessExpiresAt !== prepared.freshnessExpiresAt) fail("PUBLICATION");
  const retainedContractSha256 = sha(canonicalJson(contract));
  const evidence = {
    snapshotId: publication.snapshotId, rawSha256: selected.summary.rawSha256, recordsSha256: selected.summary.recordsSha256,
    observationIdentitySha256: selected.summary.observationIdentitySha256, receiptSha256: selected.summary.receiptSha256,
    observedAt: selected.summary.observedAt, retainedContractSha256, topologySourceId: TOPOLOGY_SOURCE_ID,
    topologySnapshotId: topology.topologyAdmissionEvidence.snapshotId, topologyContentSha256: topologySnapshot.contentSha256,
  };
  const licenseEvidence = { type: candidate.evidence.license, provider: candidate.evidence.provider,
    evidenceUrl: candidate.evidence.licenseEvidenceUrl, redistributionAllowed: true };
  const inventorySource = {
    id: SOURCE_ID, displayName: candidate.displayName, owner: candidate.evidence.provider, provider: candidate.evidence.provider,
    providerDepartment: candidate.evidence.providerDepartment, sourceSystem: "국가철도공단 철도산업정보센터", datasetUrl: candidate.detailUrl,
    datasetKind: "official-static-file", coverage: "광주 1호선 retained official timetable admission",
    coverageScope: { ...structuredClone(topology.coverageScope), sourceDomains: ["schedule_timetable"] },
    requiredForProductionPack: true, productionUseAllowed: true,
    updateFrequency: candidate.confirmationPolicy.reverificationCadence, observedDataUpdatedAt: candidate.evidence.modifiedAt,
    retrievedAt: selected.summary.observedAt.slice(0, 10), license: { type: "PUBLIC_DATA_FREE_USE", name: candidate.evidence.license,
      attribution: candidate.evidence.provider, commercialUseAllowed: true, derivativeWorkAllowed: true, redistributionAllowed: true,
      evidenceUrl: candidate.evidence.licenseEvidenceUrl }, fieldsProvided: ["service_calendar", "trip", "stop_time"],
    capabilities: { schedule: { status: "SUPPORTED", productionUseAllowed: true, updateFrequency: candidate.confirmationPolicy.reverificationCadence,
      coverageStatus: "GWANGJU_LINE_1", unsupportedNotes: "Admission covers the retained Gwangju timetable only; other routes require separate admission." }, realtime: unsupported("NO_REALTIME_FIELDS"), facility: unsupported("NO_FACILITY_FIELDS") },
    retainedScheduleAdmissionEvidence: evidence, admissionEvidence: { licenseEvidenceHash: sha(canonicalJson(licenseEvidence)) },
  };
  const nextInventory = state.kind === "initial"
    ? { ...inventory, sources: [...inventory.sources.filter((entry) => entry?.id !== SUPERSEDED_SOURCE_ID), inventorySource] }
    : { ...inventory, sources: inventory.sources.map((entry) => entry?.id === SOURCE_ID ? inventorySource : entry) };
  const semantic = validateRetainedGwangjuSource({
    retainedTimetable, topologySnapshot, canonicalStationMappings: mappings, source: inventorySource,
  });
  const governancePolicyBytes = registration.bytes;
  const ledgerRow = {
    schemaVersion: 1, artifactKind: "official-source-snapshot", sourceId: SOURCE_ID, snapshotId: publication.snapshotId,
    previousSnapshotId: state.kind === "refresh" ? state.head.snapshotId : null, observedAt: selected.summary.observedAt,
    capturedAt: selected.summary.observedAt, retrievedAt: selected.summary.observedAt, sourceUpdatedAt: null,
    provider: candidate.evidence.provider, rowCount: selected.records.length,
    coverageCount: semantic.tables.transitStopTimes.length,
    rawSha256: selected.summary.rawSha256, contentSha256: selected.summary.observationIdentitySha256,
    rawObjectUri: publication.rawObjectUri, rawObjectSha256: publication.rawObjectSha256, rawReceiptSha256: sha(publicationReceiptBytes),
    byteSize: publication.byteSize, freshUntil: publication.freshnessExpiresAt, freshnessExpiresAt: publication.freshnessExpiresAt,
    rawRetentionExpiresAt: publication.rawRetentionExpiresAt, governancePolicyVersion: registration.policy.policyVersion,
    governancePolicySha256: sha(governancePolicyBytes), schemaFingerprint: sha(canonicalJson({ artifactKind: observation.artifactKind,
      observationKeys: Object.keys(observation).sort(compare), recordKeys: Object.keys(observation.records[0] ?? {}).sort(compare) })),
    redactedRequestFingerprint: sha(canonicalJson(candidate.operation)), snapshotStatus: "LOCKED", schemaStatus: "PASS", licenseStatus: "PASS",
    fetchStatus: "SUCCESS", redistributionAllowed: true, credentialRedacted: true,
    admissionEvidence: { licenseEvidenceHash: sha(canonicalJson(licenseEvidence)) },
  };
  if (state.kind === "refresh") {
    if (ledger.some((entry) => entry?.snapshotId === ledgerRow.snapshotId)
      || Date.parse(ledgerRow.observedAt) <= Date.parse(state.head.observedAt)) fail("REFRESH_OBSERVATION");
    ledgerRow.diffSummary = buildSnapshotDiff(state.head, ledgerRow);
  } else ledgerRow.diffSummary = null;
  const nextLedger = [...ledger, ledgerRow];
  validateLineage(nextLedger);
  validateSourceGovernancePolicy({ policy: registration.policy, inventory: nextInventory, freshnessPolicy: nextFreshness });
  const inputs = [
    [inputPath, inputBytes], [path.join(root, "tools/datapack/source-candidates.json"), candidateBytes],
    [resolved.observationPath, observationBytes], [resolved.collectionReceiptPath, collectionReceiptBytes],
    [resolved.publicationReceiptPath, publicationReceiptBytes], [resolved.retainedContractPath, contractBytes],
    [path.join(root, molit.observationPath), molit.observationBytes], [topologyPath, topologyBytes],
  ].map(([absolute, value]) => ({ absolute, bytes: value }));
  exactInputs(inputs);
  const values = [bytes(nextInventory), bytes(nextLedger), governancePolicyBytes,
    state.kind === "initial" ? bytes(nextFreshness) : freshnessBytes];
  return OUTPUTS.map((relative, index) => ({ relative, prestateBytes: [inventoryBytes, ledgerBytes, governanceBytes, freshnessBytes][index], bytes: values[index], inputs }));
}

function unsupported(coverageStatus) { return { status: "UNSUPPORTED", productionUseAllowed: false, liveEtaEligible: false, rateLimitStatus: "NOT_APPLICABLE", updateFrequency: "not applicable", coverageStatus, unsupportedNotes: "Official static timetable does not provide this capability." }; }
function registrationState({ inventory, ledger, governance, freshness, candidate }) {
  if (![inventory.sources, ledger, governance.sources, freshness.sourceClasses].every(Array.isArray)) fail("REGISTRATION_STATE");
  const inventorySources = inventory.sources.filter((entry) => entry?.id === SOURCE_ID);
  const sourceLedger = ledger.filter((entry) => entry?.sourceId === SOURCE_ID);
  const governanceEntries = governance.sources.filter((entry) => entry?.sourceId === SOURCE_ID);
  const freshnessClasses = freshness.sourceClasses.filter((entry) => entry?.id === candidate.confirmationPolicy?.id);
  const oldInventory = inventory.sources.filter((entry) => entry?.id === SUPERSEDED_SOURCE_ID);
  const oldAbsent = ledger.some((entry) => entry?.sourceId === SUPERSEDED_SOURCE_ID)
    || governance.sources.some((entry) => entry?.sourceId === SUPERSEDED_SOURCE_ID);
  if (inventorySources.length === 0 && sourceLedger.length === 0 && governanceEntries.length === 0 && freshnessClasses.length === 0) {
    if (oldInventory.length !== 1 || oldAbsent) fail("SUPERSEDED_SOURCE");
    return { kind: "initial" };
  }
  if (inventorySources.length !== 1 || sourceLedger.length === 0 || governanceEntries.length !== 1
    || freshnessClasses.length !== 1 || oldInventory.length !== 0 || oldAbsent) fail("REFRESH_PARTIAL");
  const lineage = validateLineage(ledger);
  const headId = lineage.headsBySource[SOURCE_ID];
  const head = sourceLedger.find((entry) => entry?.snapshotId === headId);
  const evidence = inventorySources[0].retainedScheduleAdmissionEvidence;
  if (!head || evidence?.snapshotId !== head.snapshotId || evidence.rawSha256 !== head.rawSha256
    || evidence.observationIdentitySha256 !== head.contentSha256 || evidence.observedAt !== head.observedAt) fail("REFRESH_HEAD");
  return { kind: "refresh", head, governanceEntry: governanceEntries[0], freshnessClass: freshnessClasses[0] };
}
function confirmationClass(candidate) {
  const policy = candidate?.confirmationPolicy;
  if (!policy || policy.id !== "official_static_timetable_confirmation" || JSON.stringify(policy.sourceIds) !== JSON.stringify([SOURCE_ID])) fail("CONFIRMATION_POLICY");
  return structuredClone(policy);
}
function verifiedGovernanceEntry(entry, candidate, now) {
  const expectedLicense = { type: candidate.evidence?.license, provider: candidate.evidence?.provider, evidenceUrl: candidate.evidence?.licenseEvidenceUrl, redistributionAllowed: true };
  const review = entry?.licenseReview;
  if (candidate.evidence?.license !== "unrestricted"
    || candidate.licenseEvidenceStatus !== "confirmed_unrestricted_public_data_free_use"
    || !entry || entry.sourceId !== SOURCE_ID || entry.sourceClassId !== candidate.confirmationPolicy?.id || !review
    || review.status !== "APPROVED" || review.termsHash !== sha(canonicalJson(expectedLicense))
    || review.reviewedProvider !== candidate.evidence.provider || review.reviewedDatasetUrl !== candidate.detailUrl
    || review.termsUrl !== candidate.evidence.licenseEvidenceUrl || Date.parse(review.reviewedAt) > now.valueOf() || Date.parse(review.nextReviewAt) <= now.valueOf()
    || ![entry.retentionClassId, entry.ownerRole, entry.stewardRole, entry.approvalRole, entry.alertRoute].every((value) => typeof value === "string" && value !== "")
    || !Number.isSafeInteger(entry.escalationHours) || entry.escalationHours <= 0) fail("GOVERNANCE");
  return structuredClone(entry);
}
function topologySnapshotPath(root, topology) {
  const evidence = topology?.topologyAdmissionEvidence, relative = evidence?.snapshotPath;
  if (!evidence || typeof evidence.snapshotId !== "string" || relative !== `tools/datapack/sources/${evidence.snapshotId}.json`) fail("TOPOLOGY");
  const directory = path.resolve(root, "tools/datapack/sources"), resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${directory}${path.sep}`)) fail("TOPOLOGY"); return resolved;
}
function select(items, predicate, code) { const matches = Array.isArray(items) ? items.filter(predicate) : []; if (matches.length !== 1) fail(code); return matches[0]; }
function exactInput(value) {
  const keys = ["schemaVersion", "artifactKind", "observationPath", "collectionReceiptPath", "publicationReceiptPath", "retainedContractPath", "governanceEntry", "providerValidUntil"].sort(compare);
  if (value?.schemaVersion !== 1 || value.artifactKind !== "retained-kric-timetable-registration-input" || JSON.stringify(Object.keys(value).sort(compare)) !== JSON.stringify(keys)
    || [value.observationPath, value.collectionReceiptPath, value.publicationReceiptPath, value.retainedContractPath].some((item) => !path.isAbsolute(item ?? ""))
    || !(value.providerValidUntil === null || utc(value.providerValidUntil))) fail("SOURCE_INPUT"); return value;
}
function exactInputs(inputs) { if (new Set(inputs.map(({ absolute }) => absolute)).size !== inputs.length || inputs.some(({ absolute, bytes }) => !path.isAbsolute(absolute) || !Buffer.isBuffer(bytes))) fail("INPUTS"); }
function exactOutputs(outputs) { const inputs = outputs?.[0]?.inputs; if (!Array.isArray(outputs) || outputs.length !== OUTPUTS.length || JSON.stringify(outputs.map(({ relative }) => relative)) !== JSON.stringify(OUTPUTS) || !Array.isArray(inputs) || outputs.some((entry) => entry.inputs !== inputs || !Buffer.isBuffer(entry.bytes) || !Buffer.isBuffer(entry.prestateBytes))) fail("OUTPUTS"); exactInputs(inputs); }
const transaction = createSourceRegistrationTransaction({ label: "Retained KRIC timetable", validateOutputs: exactOutputs });
export async function recoverRetainedKricTimetableRegistration({ repositoryRoot } = {}) { return transaction.recover({ repositoryRoot: rootPath(repositoryRoot) }); }
export async function commitRetainedKricTimetableRegistrationOutputs({ repositoryRoot, outputs, failAfter = null } = {}) { return transaction.commit({ repositoryRoot: rootPath(repositoryRoot), outputs, failAfter }); }
export async function registerRetainedKricTimetable(options = {}) { await recoverRetainedKricTimetableRegistration({ repositoryRoot: options.repositoryRoot }); return commitRetainedKricTimetableRegistrationOutputs({ repositoryRoot: options.repositoryRoot, outputs: await buildRetainedKricTimetableRegistrationOutputs(options) }); }
function parse(value, code) { try { return JSON.parse(value); } catch { fail(code); } }
function rootPath(value) { if (!path.isAbsolute(value ?? "")) fail("ROOT"); return path.resolve(value); }
function absolute(value, code) { if (!path.isAbsolute(value ?? "")) fail(code); return path.resolve(value); }
function utc(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function fail(code) { throw new Error(`RETAINED_KRIC_TIMETABLE_REGISTRATION_${code}`); }
