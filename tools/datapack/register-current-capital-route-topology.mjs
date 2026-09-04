import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";
import { assertCurrentStaticNetworkTopologyAdmission } from "./register-current-static-network-successors.mjs";
import { buildSnapshotDiff } from "./source-snapshot-policy.mjs";
import { buildAppendOnlyGovernancePolicyRegistration, deriveRawRetentionExpiresAt, validateSourceGovernancePolicy } from "./source-governance-policy.mjs";
import { isDeepStrictEqual } from "node:util";

const SOURCE_ID = "capital-route-topology";
const OWNER_SOURCE_ID = "seoul-metro-route-map-positions";
const NAMESPACE = "axvym6vk8g7i";
const BUCKET = "easysubway-datapacks";
const OUTPUTS = Object.freeze([
  "tools/datapack/source-inventory.json",
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/source-governance-policy.json",
  "release/product-gates/datapack-freshness-sla.json",
]);
const JOURNAL = "tools/datapack/.capital-route-topology-registration-transaction.json";
const LOCK = "tools/datapack/.capital-route-topology-registration.lock";
const SHA256 = /^[a-f0-9]{64}$/u;
const SNAPSHOT_ID = new RegExp("^" + SOURCE_ID + "-[0-9]{8}$", "u");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const jsonBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const ADMISSION_INPUT_KEYS = Object.freeze(["inventoryBytes", "candidateBytes", "governanceBytes", "freshnessBytes"]);

function parse(bytes, label) {
  try { return JSON.parse(bytes); } catch { throw new Error(label + " is invalid JSON"); }
}
function instant(value, label) {
  return requiredUtcInstant(value, label);
}
function exactSha(value, label) {
  if (!SHA256.test(value ?? "")) throw new Error(label + " is invalid");
  return value;
}
function rootPath(value) {
  if (!path.isAbsolute(value ?? "")) throw new Error("capital topology registration requires an absolute repository root");
  return path.resolve(value);
}
function target(root, relative) {
  if (!OUTPUTS.includes(relative) && relative !== JOURNAL && relative !== LOCK) throw new Error("capital topology registration target is invalid");
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep)) throw new Error("capital topology registration target escapes repository");
  return file;
}
function selected(items, predicate, label) {
  const matches = items.filter(predicate);
  if (matches.length !== 1) throw new Error(label + " is ambiguous");
  return matches[0];
}
function recordDigest(value) { return sha(Buffer.from(canonicalJson(value))); }
function registrationMetadata(candidate) {
  const metadata = candidate.registrationMetadata;
  const keys = ["inventory", "governance", "freshness"];
  const inventoryStringKeys = ["owner", "provider", "providerDepartment", "sourceSystem", "datasetUrl", "datasetKind", "coverage", "licenseName", "licenseTermsUrl"];
  const inventoryKeys = [...inventoryStringKeys, "commercialUseAllowed", "derivativeWorkAllowed", "redistributionAllowed", "capabilities"];
  const governanceKeys = ["retentionClassId", "ownerRole", "stewardRole", "approvalRole", "escalationHours", "alertRoute", "licenseReview"];
  const licenseReviewKeys = ["status", "termsHash", "reviewedAt", "nextReviewAt", "termsUrl", "reviewedProvider", "reviewedDatasetUrl", "redistributionScopes", "approvedByRole"];
  const freshnessKeys = ["examples", "basisField", "reverificationCadence", "offlinePackEligible", "eventTriggers", "changePublishSla", "freshnessMetric"];
  if (!metadata || JSON.stringify(Object.keys(metadata).sort()) !== JSON.stringify([...keys].sort())
    || JSON.stringify(Object.keys(metadata.inventory ?? {}).sort()) !== JSON.stringify([...inventoryKeys].sort())
    || JSON.stringify(Object.keys(metadata.governance ?? {}).sort()) !== JSON.stringify([...governanceKeys].sort())
    || JSON.stringify(Object.keys(metadata.freshness ?? {}).sort()) !== JSON.stringify([...freshnessKeys].sort())
    || !metadata.governance.licenseReview || typeof metadata.governance.licenseReview !== "object"
    || JSON.stringify(Object.keys(metadata.governance.licenseReview).sort()) !== JSON.stringify([...licenseReviewKeys].sort())
    || !Array.isArray(metadata.freshness.examples) || !Array.isArray(metadata.freshness.eventTriggers)
    || metadata.freshness.reverificationCadence !== "P1D" || metadata.freshness.basisField !== "retrievedAt"
    || metadata.governance.retentionClassId !== "standard-90d"
    || !Number.isInteger(metadata.governance.escalationHours) || metadata.governance.escalationHours <= 0
    || typeof metadata.governance.ownerRole !== "string" || typeof metadata.governance.stewardRole !== "string" || typeof metadata.governance.approvalRole !== "string" || typeof metadata.governance.alertRoute !== "string"
    || metadata.freshness.offlinePackEligible !== true || typeof metadata.freshness.changePublishSla !== "string" || typeof metadata.freshness.freshnessMetric !== "string"
    || inventoryStringKeys.some((key) => typeof metadata.inventory[key] !== "string" || metadata.inventory[key].length === 0)
    || metadata.inventory.commercialUseAllowed !== true || metadata.inventory.derivativeWorkAllowed !== true
    || metadata.inventory.redistributionAllowed !== true
    || JSON.stringify(Object.keys(metadata.inventory.capabilities ?? {})
      .sort((left, right) => left.localeCompare(right))) !== JSON.stringify(["facility", "realtime", "schedule"])
    || Object.values(metadata.inventory.capabilities).some((capability) => capability?.status !== "UNSUPPORTED" || capability.productionUseAllowed !== false)
    || metadata.inventory.capabilities.realtime.liveEtaEligible !== false
    || !metadata.inventory.datasetUrl.startsWith("https://") || !metadata.inventory.licenseTermsUrl.startsWith("https://")
    || typeof candidate.displayName !== "string" || candidate.displayName.length === 0
    || candidate.evidence?.provider !== metadata.inventory.provider || candidate.evidence?.coverage !== metadata.inventory.coverage) {
    throw new Error("capital topology registration metadata is invalid");
  }
  return metadata;
}

async function admissionInputBytes(root, supplied) {
  if (supplied == null) {
    const values = await Promise.all([
      readFile(path.join(root, OUTPUTS[0])),
      readFile(path.join(root, "tools/datapack/source-candidates.json")),
      readFile(path.join(root, OUTPUTS[2])),
      readFile(path.join(root, OUTPUTS[3])),
    ]);
    return Object.fromEntries(ADMISSION_INPUT_KEYS.map((key, index) => [key, values[index]]));
  }
  if (typeof supplied !== "object" || Array.isArray(supplied)
    || JSON.stringify(Object.keys(supplied).sort()) !== JSON.stringify([...ADMISSION_INPUT_KEYS].sort())
    || ADMISSION_INPUT_KEYS.some((key) => !Buffer.isBuffer(supplied[key]))) {
    throw new Error("capital topology admission input snapshot is invalid");
  }
  return Object.fromEntries(ADMISSION_INPUT_KEYS.map((key) => [key, Buffer.from(supplied[key])]));
}

export async function readCurrentCapitalRouteTopologyAdmission({ repositoryRoot, now = new Date(), inputBytes = null } = {}) {
  const root = rootPath(repositoryRoot);
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) throw new Error("capital topology admission time is invalid");
  const { inventoryBytes, candidateBytes, governanceBytes, freshnessBytes } = await admissionInputBytes(root, inputBytes);
  const inventory = parse(inventoryBytes, "source inventory");
  const canonicalOwner = selected(Array.isArray(inventory.sources) ? inventory.sources : [], (source) => source?.id === OWNER_SOURCE_ID, "capital topology canonical owner");
  const protectedTopology = await assertCurrentStaticNetworkTopologyAdmission({ repositoryRoot: root, now });
  if (!isDeepStrictEqual(canonicalOwner.routeMapAdmissionEvidence?.currentTopologyAdmission, protectedTopology.topologyAdmission)) {
    throw new Error("capital topology input snapshot changed during validation");
  }
  const ownerScope = canonicalOwner.coverageScope;
  const lineIds = ownerScope?.lineIds;
  if (!Array.isArray(lineIds) || lineIds.length === 0 || new Set(lineIds).size !== lineIds.length
    || !Array.isArray(ownerScope.regionIds) || !Array.isArray(ownerScope.operatorIds)) throw new Error("capital topology canonical owner scope is invalid");
  const candidates = parse(candidateBytes, "source candidates").candidates;
  const candidate = selected(Array.isArray(candidates) ? candidates : [], (entry) => entry?.id === SOURCE_ID, "capital topology source candidate");
  if (candidate.domain !== "route_graph_topology" || !candidate.operation || !candidate.operation.sourceDefinition
    || !exactSha(candidate.operation.sourceDefinition.sourceSetSha256, "capital topology operation identity")) throw new Error("capital topology source candidate is invalid");
  const registration = registrationMetadata(candidate);
  const metadata = registration.inventory;
  const { topologyAdmission, topologyRelative, topologyBytes, topology } = protectedTopology;
  const snapshotId = topologyAdmission.topologySnapshotId;
  const protectedLineIds = topologyAdmission.topologyLineages.map((lineage) => lineage?.lineId);
  if (!SNAPSHOT_ID.test(snapshotId) || protectedLineIds.length !== lineIds.length
    || protectedLineIds.some((lineId) => !lineIds.includes(lineId))) throw new Error("capital topology canonical owner scope is invalid");
  const capturedAt = instant(topology.capturedAt, "capital topology capturedAt");
  const freshUntil = instant(topology.freshUntil, "capital topology freshUntil");
  const capturedDate = topology.capturedAt.slice(0, 10).replaceAll("-", "");
  if (snapshotId.slice(-capturedDate.length) !== capturedDate || freshUntil <= capturedAt || now.valueOf() < capturedAt || now.valueOf() >= freshUntil) throw new Error("capital topology protected admission is not current");
  const baseGovernancePolicy = parse(governanceBytes, "capital topology governance policy");
  const baseFreshnessPolicy = parse(freshnessBytes, "capital topology freshness policy");
  const governance = { sourceId: SOURCE_ID, sourceClassId: candidate.domain, ...registration.governance };
  const freshness = { id: candidate.domain, sourceIds: [SOURCE_ID], ...registration.freshness };
  const existingGovernance = (baseGovernancePolicy.sources ?? []).filter((entry) => entry?.sourceId === SOURCE_ID);
  const existingFreshness = (baseFreshnessPolicy.sourceClasses ?? []).filter((entry) => entry?.id === candidate.domain);
  if (existingGovernance.length > 1 || existingFreshness.length > 1
    || (existingGovernance.length === 1) !== (existingFreshness.length === 1)
    || (existingGovernance.length === 1 && (!isDeepStrictEqual(existingGovernance[0], governance) || !isDeepStrictEqual(existingFreshness[0], freshness)))) {
    throw new Error("capital topology registration policy binding is invalid");
  }
  const governancePolicy = existingGovernance.length === 1 ? baseGovernancePolicy
    : buildAppendOnlyGovernancePolicyRegistration({
      predecessorPolicyBytes: governanceBytes,
      addedSources: [governance],
    }).policy;
  const freshnessPolicy = existingFreshness.length === 1 ? baseFreshnessPolicy : { ...baseFreshnessPolicy, sourceClasses: [...baseFreshnessPolicy.sourceClasses, freshness] };
  const review = governance.licenseReview;
  const reviewedAt = instant(review?.reviewedAt, "capital topology license reviewedAt");
  const nextReviewAt = instant(review?.nextReviewAt, "capital topology license nextReviewAt");
  if (governance.sourceClassId !== candidate.domain || typeof governance.retentionClassId !== "string"
    || freshness.reverificationCadence !== "P1D" || JSON.stringify(freshness.sourceIds) !== JSON.stringify([SOURCE_ID]) || freshness.basisField !== "retrievedAt") throw new Error("capital topology governance or freshness selection is invalid");
  const expectedFreshUntil = deriveFreshnessExpiresAt({ policy: freshnessPolicy, sourceClassId: candidate.domain, basisAt: topology.capturedAt, evaluationAt: now.toISOString() });
  if (expectedFreshUntil !== topology.freshUntil) throw new Error("capital topology freshness extends protected snapshot");
  const license = topology.license;
  if (!license || license.type !== "KOGL-1" || typeof license.attribution !== "string" || license.attribution.length === 0
    || license.redistributionAllowed !== metadata.redistributionAllowed || license.evidenceUrl !== metadata.datasetUrl
    || review.status !== "APPROVED" || review.termsHash !== recordDigest(license) || review.termsUrl !== metadata.licenseTermsUrl
    || review.reviewedProvider !== metadata.owner || review.reviewedDatasetUrl !== metadata.datasetUrl
    || JSON.stringify(review.redistributionScopes) !== JSON.stringify(["DERIVED_DATAPACK"])
    || review.approvedByRole !== governance.approvalRole || reviewedAt > now.valueOf() || nextReviewAt <= now.valueOf()) throw new Error("capital topology license is invalid");
  return { sourceId: SOURCE_ID, snapshotId, capturedDate, topologyAdmission, topologyRelative, topologyBytes, topology, lineIds: [...lineIds], coverageScope: { regionIds: [...ownerScope.regionIds], operatorIds: [...ownerScope.operatorIds] }, fieldsProvided: [...topology.fieldsProvided], candidate, metadata, registration, governancePolicy, governance, freshnessPolicy, freshness, governanceRecordSha256: recordDigest(governance), freshnessClassSha256: recordDigest(freshness), inputBindings: [
    { relative: "tools/datapack/source-candidates.json", bytes: candidateBytes },
    { relative: topologyRelative, bytes: topologyBytes },
  ] };
}

function receiptFor({ receipt, admission, receiptBytes, now }) {
  const expectedRawSha256 = sha(admission.topologyBytes);
  const objectKey = "source-raw/" + admission.sourceId + "/" + admission.capturedDate + "/" + expectedRawSha256 + ".json";
  const keys = ["schemaVersion", "artifactKind", "sourceId", "snapshotId", "capturedAt", "rawObjectUri", "rawObjectSha256", "byteSize", "storedAt", "rawRetentionExpiresAt", "ociNamespace", "bucket", "objectKey", "contentType"];
  if (!receipt || JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify([...keys].sort())
    || receipt.schemaVersion !== 1 || receipt.artifactKind !== "static-network-source-raw-object-receipt" || receipt.sourceId !== admission.sourceId || receipt.snapshotId !== admission.snapshotId
    || receipt.capturedAt !== admission.topology.capturedAt || receipt.rawObjectSha256 !== expectedRawSha256 || receipt.byteSize !== admission.topologyBytes.length
    || receipt.ociNamespace !== NAMESPACE || receipt.bucket !== BUCKET || receipt.objectKey !== objectKey || receipt.rawObjectUri !== "oci://" + NAMESPACE + "/" + BUCKET + "/" + objectKey || receipt.contentType !== "application/json"
    || instant(receipt.storedAt, "capital topology receipt storedAt") < instant(admission.topology.capturedAt, "capital topology capturedAt")
    || instant(receipt.storedAt, "capital topology receipt storedAt") > now.valueOf() || instant(receipt.rawRetentionExpiresAt, "capital topology receipt retention") <= now.valueOf()) throw new Error("capital topology OCI receipt binding is invalid");
  const retention = deriveRawRetentionExpiresAt({ policy: admission.governancePolicy, sourceId: admission.sourceId, retrievedAt: admission.topology.capturedAt });
  if (receipt.rawRetentionExpiresAt !== retention) throw new Error("capital topology OCI receipt retention is invalid");
  return { receipt, rawReceiptSha256: sha(receiptBytes) };
}

function currentHead(ledger, snapshotId) {
  if (!Array.isArray(ledger)) throw new Error("capital topology snapshot ledger is invalid");
  if (ledger.filter((snapshot) => snapshot?.snapshotId === snapshotId).length !== 0) throw new Error("capital topology snapshot ID already exists");
  const snapshots = ledger.filter((snapshot) => snapshot?.sourceId === SOURCE_ID);
  if (snapshots.length === 0) return null;
  const byId = new Map();
  for (const snapshot of snapshots) {
    if (typeof snapshot.snapshotId !== "string" || byId.has(snapshot.snapshotId) || !exactSha(snapshot.rawSha256, "capital topology predecessor raw digest")) throw new Error("capital topology predecessor lineage is invalid");
    byId.set(snapshot.snapshotId, snapshot);
  }
  const children = new Map();
  for (const snapshot of snapshots) {
    if (snapshot.previousSnapshotId == null) continue;
    if (!byId.has(snapshot.previousSnapshotId) || children.has(snapshot.previousSnapshotId)) throw new Error("capital topology predecessor lineage is invalid");
    children.set(snapshot.previousSnapshotId, snapshot.snapshotId);
  }
  const roots = snapshots.filter((snapshot) => snapshot.previousSnapshotId == null);
  if (roots.length !== 1) throw new Error("capital topology predecessor lineage is invalid");
  let head = roots[0]; const seen = new Set();
  while (children.has(head.snapshotId)) {
    if (seen.has(head.snapshotId)) throw new Error("capital topology predecessor lineage is invalid");
    seen.add(head.snapshotId); head = byId.get(children.get(head.snapshotId));
  }
  if (seen.size + 1 !== snapshots.length) throw new Error("capital topology predecessor lineage is invalid");
  return head;
}

export async function buildCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot, receiptPath, now = new Date() } = {}) {
  const root = rootPath(repositoryRoot);
  if (!path.isAbsolute(receiptPath ?? "") || !(now instanceof Date) || Number.isNaN(now.valueOf())) throw new Error("capital topology registration arguments are invalid");
  const [inventoryBytes, ledgerBytes, candidateBytes, governanceBytes, freshnessBytes, receiptBytes] = await Promise.all([
    readFile(target(root, OUTPUTS[0])), readFile(target(root, OUTPUTS[1])), readFile(path.join(root, "tools/datapack/source-candidates.json")),
    readFile(target(root, OUTPUTS[2])), readFile(target(root, OUTPUTS[3])), readFile(receiptPath),
  ]);
  const admission = await readCurrentCapitalRouteTopologyAdmission({
    repositoryRoot: root,
    now,
    inputBytes: { inventoryBytes, candidateBytes, governanceBytes, freshnessBytes },
  });
  const inventory = parse(inventoryBytes, "source inventory");
  const ledger = parse(ledgerBytes, "source snapshot ledger");
  const { receipt, rawReceiptSha256 } = receiptFor({ receipt: parse(receiptBytes, "capital topology receipt"), admission, receiptBytes, now });
  const sourceMatches = (Array.isArray(inventory.sources) ? inventory.sources : []).filter((source) => source?.id === SOURCE_ID);
  if (sourceMatches.length > 1) throw new Error("capital topology inventory is duplicate");
  const predecessor = currentHead(ledger, admission.snapshotId);
  if ((sourceMatches.length === 0) !== (predecessor == null)) throw new Error("capital topology inventory and ledger registration disagree");
  if (predecessor != null && !isDeepStrictEqual(sourceMatches[0].capitalTopologyAdmissionEvidence, predecessor.admissionEvidence)) throw new Error("capital topology inventory evidence does not bind the current ledger head");
  const predecessorSnapshotIds = predecessor == null ? [] : [predecessor.snapshotId];
  const evidence = { schemaVersion: 1, artifactKind: "capital-topology-admission-evidence", status: "APPROVED", issue: 456, sourceId: admission.sourceId, snapshotId: admission.snapshotId, snapshotPath: admission.topologyRelative, snapshotFileSha256: sha(admission.topologyBytes), snapshotRawSha256: receipt.rawObjectSha256, contentSha256: admission.topology.contentSha256, lineIds: admission.lineIds, orderedScopeSha256: sha(Buffer.from(canonicalJson(admission.lineIds))), operationSetSha256: admission.candidate.operation.sourceDefinition.sourceSetSha256, rawReceiptSha256, rawObjectUri: receipt.rawObjectUri, rawObjectSha256: receipt.rawObjectSha256, byteSize: receipt.byteSize, licenseSha256: recordDigest(admission.topology.license), governanceRecordSha256: admission.governanceRecordSha256, freshnessClassSha256: admission.freshnessClassSha256, evaluatedAt: now.toISOString(), predecessorSnapshotIds };
  const source = {
    id: admission.sourceId,
    displayName: admission.candidate.displayName,
    owner: admission.metadata.owner,
    provider: admission.metadata.provider,
    providerDepartment: admission.metadata.providerDepartment,
    sourceSystem: admission.metadata.sourceSystem,
    datasetUrl: admission.metadata.datasetUrl,
    datasetKind: admission.metadata.datasetKind,
    coverage: admission.metadata.coverage,
    coverageScope: {
      regionIds: admission.coverageScope.regionIds,
      operatorIds: admission.coverageScope.operatorIds,
      lineIds: admission.lineIds,
      sourceDomains: [admission.candidate.domain],
    },
    requiredForProductionPack: true,
    productionUseAllowed: true,
    updateFrequency: admission.freshness.reverificationCadence,
    observedDataUpdatedAt: admission.topology.capturedAt.slice(0, 10),
    retrievedAt: admission.topology.capturedAt.slice(0, 10),
    license: {
      type: admission.topology.license.type,
      name: admission.metadata.licenseName,
      attribution: admission.topology.license.attribution,
      commercialUseAllowed: admission.metadata.commercialUseAllowed,
      derivativeWorkAllowed: admission.metadata.derivativeWorkAllowed,
      redistributionAllowed: admission.metadata.redistributionAllowed,
      evidenceUrl: admission.topology.license.evidenceUrl,
    },
    admissionEvidence: { licenseEvidenceHash: evidence.licenseSha256 },
    fieldsProvided: admission.fieldsProvided,
    capabilities: admission.metadata.capabilities,
    capitalTopologyAdmissionEvidence: evidence,
  };
  const snapshot = { schemaVersion: 1, artifactKind: "official-source-snapshot", sourceId: admission.sourceId, snapshotId: admission.snapshotId, previousSnapshotId: predecessor?.snapshotId ?? null, capturedAt: admission.topology.capturedAt, retrievedAt: admission.topology.capturedAt, sourceUpdatedAt: admission.topology.capturedAt, provider: admission.candidate.evidence?.provider, rowCount: admission.lineIds.length, coverageCount: admission.lineIds.length, rawSha256: receipt.rawObjectSha256, contentSha256: admission.topology.contentSha256, rawObjectUri: receipt.rawObjectUri, rawObjectSha256: receipt.rawObjectSha256, rawReceiptSha256, byteSize: receipt.byteSize, freshUntil: admission.topology.freshUntil, freshnessExpiresAt: admission.topology.freshUntil, rawRetentionExpiresAt: receipt.rawRetentionExpiresAt, schemaFingerprint: sha(Buffer.from(canonicalJson({ artifactKind: admission.topology.artifactKind, keys: Object.keys(admission.topology).sort((left, right) => left.localeCompare(right)) }))), redactedRequestFingerprint: recordDigest(admission.candidate.operation), snapshotStatus: "LOCKED", schemaStatus: "PASS", licenseStatus: "PASS", fetchStatus: "SUCCESS", redistributionAllowed: true, admissionEvidence: evidence };
  if (predecessor != null) snapshot.diffSummary = buildSnapshotDiff(predecessor, snapshot);
  const nextInventory = sourceMatches.length === 0 ? { ...inventory, sources: [...inventory.sources, source] } : { ...inventory, sources: inventory.sources.map((entry) => entry.id === SOURCE_ID ? source : entry) };
  const nextLedger = [...ledger, snapshot];
  const nextGovernancePolicy = admission.governancePolicy;
  const nextFreshnessPolicy = admission.freshnessPolicy;
  validateSourceGovernancePolicy({ policy: nextGovernancePolicy, inventory: nextInventory, freshnessPolicy: nextFreshnessPolicy });
  const inputs = [...admission.inputBindings, { absolute: path.resolve(receiptPath), bytes: receiptBytes }];
  const outputs = [
    { relative: OUTPUTS[0], prestateBytes: inventoryBytes, bytes: jsonBytes(nextInventory) },
    { relative: OUTPUTS[1], prestateBytes: ledgerBytes, bytes: jsonBytes(nextLedger) },
    { relative: OUTPUTS[2], prestateBytes: governanceBytes, bytes: jsonBytes(nextGovernancePolicy) },
    { relative: OUTPUTS[3], prestateBytes: freshnessBytes, bytes: jsonBytes(nextFreshnessPolicy) },
  ];
  outputs.forEach((output) => { output.inputs = inputs; });
  return outputs;
}

async function safeParent(file) {
  const stat = await lstat(path.dirname(file));
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("capital topology transaction parent is unsafe");
}
async function syncParent(file) {
  const directory = await open(path.dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}
async function currentBytes(file) {
  try { const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("capital topology transaction target is unsafe"); return await readFile(file); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}
async function assertBytes(file, expected) {
  const actual = await currentBytes(file);
  if ((actual == null) !== (expected == null) || (actual != null && !actual.equals(expected))) throw new Error("capital topology transaction preserves foreign replacement");
}
async function atomicWrite(file, value, expected) {
  await safeParent(file); if (expected !== undefined) await assertBytes(file, expected);
  const temporary = path.join(path.dirname(file), "." + path.basename(file) + "." + randomUUID() + ".tmp");
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
    if (expected !== undefined) await assertBytes(file, expected);
    if (expected === null) { await link(temporary, file); await unlink(temporary); } else await rename(temporary, file);
    await syncParent(file); await assertBytes(file, value);
  } finally { await unlink(temporary).catch(() => {}); }
}
function exactOutputs(outputs) {
  const inputs = outputs?.[0]?.inputs;
  if (!Array.isArray(outputs) || outputs.length !== OUTPUTS.length || JSON.stringify(outputs.map(({ relative }) => relative)) !== JSON.stringify(OUTPUTS)
    || outputs.some(({ bytes, prestateBytes }) => !Buffer.isBuffer(bytes) || !Buffer.isBuffer(prestateBytes) || inputs !== outputs[0].inputs)
    || !Array.isArray(inputs) || inputs.length !== 3
    || inputs[0]?.relative !== "tools/datapack/source-candidates.json"
    || !/^tools\/datapack\/sources\/capital-route-topology-[0-9]{8}\.json$/u.test(inputs[1]?.relative ?? "")
    || !path.isAbsolute(inputs[2]?.absolute ?? "") || inputs.some(({ bytes }) => !Buffer.isBuffer(bytes))) throw new Error("capital topology transaction outputs are invalid");
}
function inputFile(root, input) {
  if (typeof input.relative === "string") {
    const file = path.resolve(root, input.relative);
    if (!file.startsWith(root + path.sep)) throw new Error("capital topology transaction input escapes repository");
    return file;
  }
  return input.absolute;
}
async function assertInputs(root, inputs) {
  for (const input of inputs) {
    const actual = await readFile(inputFile(root, input));
    if (!actual.equals(input.bytes)) throw new Error("capital topology transaction preserves input binding");
  }
}
function journalRecords(outputs) {
  return outputs.map(({ relative, bytes, prestateBytes }) => ({ relative, beforeBase64: prestateBytes.toString("base64"), beforeSha256: sha(prestateBytes), nextBase64: bytes.toString("base64"), nextSha256: sha(bytes) }));
}
function validateJournal(journal) {
  if (!journal || journal.schemaVersion !== 1 || !["PREPARED", "COMMITTED"].includes(journal.state) || !Array.isArray(journal.records) || journal.records.length !== OUTPUTS.length || JSON.stringify(journal.records.map(({ relative }) => relative)) !== JSON.stringify(OUTPUTS)) throw new Error("capital topology transaction recovery is invalid");
  for (const record of journal.records) {
    const before = Buffer.from(record.beforeBase64 ?? "", "base64"); const next = Buffer.from(record.nextBase64 ?? "", "base64");
    if (before.toString("base64") !== record.beforeBase64 || next.toString("base64") !== record.nextBase64 || sha(before) !== record.beforeSha256 || sha(next) !== record.nextSha256) throw new Error("capital topology transaction recovery is invalid");
  }
}
async function recover(root) {
  const journalPath = target(root, JOURNAL); const journalBytes = await currentBytes(journalPath); if (journalBytes == null) return;
  const journal = parse(journalBytes, "capital topology transaction journal"); validateJournal(journal);
  for (const record of journal.records) {
    const before = Buffer.from(record.beforeBase64, "base64"); const next = Buffer.from(record.nextBase64, "base64"); const file = target(root, record.relative); const actual = await currentBytes(file);
    if (journal.state === "PREPARED") { if (actual.equals(before)) continue; if (!actual.equals(next)) throw new Error("capital topology transaction preserves foreign replacement"); await atomicWrite(file, before, next); }
    else { if (actual.equals(next)) continue; if (!actual.equals(before)) throw new Error("capital topology transaction preserves foreign replacement"); await atomicWrite(file, next, before); }
  }
  await unlink(journalPath); await syncParent(journalPath);
}
async function acquireLock(root) {
  const lock = target(root, LOCK); await safeParent(lock);
  try { await mkdir(lock, { mode: 0o700 }); } catch (error) { if (error?.code === "EEXIST") throw new Error("capital topology transaction lock residue exists"); throw error; }
  return async () => { await rmdir(lock); };
}

export async function recoverCurrentCapitalRouteTopologyRegistration({ repositoryRoot } = {}) {
  const root = rootPath(repositoryRoot); const release = await acquireLock(root);
  try { await recover(root); } finally { await release(); }
}
export async function commitCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot, outputs, failAfter = null } = {}) {
  const root = rootPath(repositoryRoot); exactOutputs(outputs); const release = await acquireLock(root);
  try {
    await recover(root); for (const output of outputs) await assertBytes(target(root, output.relative), output.prestateBytes);
    await assertInputs(root, outputs[0].inputs);
    const records = journalRecords(outputs); const journalPath = target(root, JOURNAL);
    await atomicWrite(journalPath, Buffer.from(JSON.stringify({ schemaVersion: 1, state: "PREPARED", records })), null);
    try {
      for (const [index, record] of records.entries()) {
        await assertInputs(root, outputs[0].inputs);
        await atomicWrite(target(root, record.relative), Buffer.from(record.nextBase64, "base64"), Buffer.from(record.beforeBase64, "base64"));
        if (failAfter === index) throw new Error("injected capital topology transaction failure");
      }
    } catch (error) { await recover(root); throw error; }
    const prepared = await currentBytes(journalPath);
    await atomicWrite(journalPath, Buffer.from(JSON.stringify({ schemaVersion: 1, state: "COMMITTED", records })), prepared);
    await recover(root); return { targets: OUTPUTS };
  } finally { await release(); }
}
export async function registerCurrentCapitalRouteTopology(options = {}) {
  await recoverCurrentCapitalRouteTopologyRegistration({ repositoryRoot: options.repositoryRoot });
  const outputs = await buildCurrentCapitalRouteTopologyRegistrationOutputs(options);
  return commitCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: options.repositoryRoot, outputs });
}
