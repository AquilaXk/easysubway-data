import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { validateKorailTimetableFileReceipt } from "./collect-korail-metropolitan-timetable-file.mjs";
import { SOURCE_REGISTRATION_OUTPUTS, createSourceRegistrationTransaction } from "./lib/source-registration-transaction.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { prepareKorailTopologyPublication } from "./parse-korail-metropolitan-timetable.mjs";
import { validateSourceGovernancePolicy } from "./source-governance-policy.mjs";

const SOURCE_ID = "korail-metropolitan-timetable-file";
const OUTPUTS = SOURCE_REGISTRATION_OUTPUTS;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
function utf16Compare(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export async function buildKorailTopologyRegistrationOutputs({ repositoryRoot, sourceInputPath, receiptPath, now = new Date() } = {}) {
  const context = await prepareKorailTopologyRegistration({ repositoryRoot, sourceInputPath, now });
  const { root, inputPath, sourceInput, inventoryBytes, ledgerBytes, governanceBytes, freshnessBytes, candidatesBytes,
    inputBytes, membershipBytes, membershipReceiptBytes, catalogBytes, collectionReceiptBytes, rawBytes, inventory,
    ledger, candidate, collectionReceipt, rawSha256, preparation } = context;
  const rawReceiptPath = absolute(receiptPath, "RECEIPT");
  const rawReceiptBytes = await readFile(rawReceiptPath);
  const snapshot = preparation.snapshot;
  const rawReceipt = validateRawReceipt(parse(rawReceiptBytes, "RAW_RECEIPT"), preparation, collectionReceiptBytes, rawSha256, rawBytes.length, now);
  if (snapshot.snapshotId !== `${SOURCE_ID}-${snapshot.contentSha256}` || (ledger ?? []).some((entry) => entry?.snapshotId === snapshot.snapshotId)) fail("FIRST_ONLY");
  const snapshotRelative = `tools/datapack/sources/${snapshot.snapshotId}.json`, snapshotBytes = json(snapshot);
  await writeDerivedSnapshot(path.join(root, snapshotRelative), snapshotBytes);
  const cadence = preparation.projectedFreshnessPolicy.sourceClasses.find((entry) => entry.id === candidate.topologyRegistration.sourceClassId)?.reverificationCadence;
  if (typeof cadence !== "string") fail("FRESHNESS");
  const evidence = { issue: 457, materializer: "tools/datapack/materialize-korail-route-topology.mjs", verificationTest: "tools/datapack/materialize-korail-route-topology.test.mjs", snapshotId: snapshot.snapshotId, snapshotPath: snapshotRelative, capturedAt: snapshot.capturedAt, freshUntil: snapshot.freshUntil, stationCount: snapshot.stationCount, edgeCount: snapshot.edgeCount, excludedTransferCount: 0, rawSha256, contentSha256: snapshot.contentSha256 };
  const provider = candidate.evidence?.provider;
  if (typeof provider !== "string" || provider === "") fail("CANDIDATE");
  const inventorySource = {
    id: SOURCE_ID, displayName: candidate.displayName, owner: provider, provider,
    providerDepartment: "", sourceSystem: "공공데이터포털", datasetUrl: candidate.detailUrl,
    datasetKind: "fileData", coverage: candidate.displayName,
    coverageScope: { ...candidate.coverageScope, sourceDomains: [candidate.domain] },
    requiredForProductionPack: true, productionUseAllowed: true, updateFrequency: cadence,
    observedDataUpdatedAt: sourceInput.observedDataUpdatedAt, retrievedAt: snapshot.capturedAt.slice(0, 10),
    license: { type: "PUBLIC_DATA_FREE_USE", name: "공공데이터 이용허락범위 제한없음", attribution: provider,
      commercialUseAllowed: true, derivativeWorkAllowed: true, redistributionAllowed: true,
      evidenceUrl: candidate.detailUrl },
    fieldsProvided: ["network_edges", "duration_seconds"],
    capabilities: {
      schedule: { status: "CANDIDATE", productionUseAllowed: false, updateFrequency: cadence,
        coverageStatus: "TOPOLOGY_ONLY", unsupportedNotes: "Service calendars are not admitted by topology registration." },
      realtime: { status: "UNSUPPORTED", productionUseAllowed: false, liveEtaEligible: false,
        rateLimitStatus: "NOT_APPLICABLE", updateFrequency: "not applicable", coverageStatus: "NO_REALTIME_FIELDS",
        unsupportedNotes: "The source contains a static timetable, not live train observations." },
      facility: { status: "UNSUPPORTED", productionUseAllowed: false, updateFrequency: "not applicable",
        coverageStatus: "NO_FACILITY_FIELDS", unsupportedNotes: "The source contains no facility observations." },
    },
    topologyAdmissionEvidence: evidence,
    admissionEvidence: { licenseEvidenceHash: preparation.licenseEvidenceSha256 },
  };
  const policyBytes = json(preparation.projectedGovernancePolicy);
  const ledgerRow = {
    schemaVersion: 1, artifactKind: "official-source-snapshot", sourceId: SOURCE_ID,
    snapshotId: snapshot.snapshotId, previousSnapshotId: null, capturedAt: snapshot.capturedAt,
    retrievedAt: snapshot.capturedAt, sourceUpdatedAt: sourceInput.sourceUpdatedAt, provider,
    rowCount: snapshot.edgeCount, coverageCount: snapshot.stationCount, rawSha256,
    contentSha256: snapshot.contentSha256, rawObjectUri: rawReceipt.rawObjectUri,
    rawObjectSha256: rawSha256, rawReceiptSha256: sha(rawReceiptBytes), byteSize: rawBytes.length,
    freshUntil: snapshot.freshUntil, freshnessExpiresAt: snapshot.freshUntil,
    rawRetentionExpiresAt: rawReceipt.rawRetentionExpiresAt,
    governancePolicyVersion: preparation.projectedGovernancePolicy.policyVersion,
    governancePolicySha256: sha(policyBytes),
    schemaFingerprint: sha(canonicalJson({ artifactKind: snapshot.artifactKind, keys: Object.keys(snapshot).sort(utf16Compare) })),
    redactedRequestFingerprint: sha(canonicalJson({
      collectionContract: candidate.evidence.collectionContract, officialUrl: collectionReceipt.officialUrl,
    })),
    snapshotStatus: "LOCKED", schemaStatus: "PASS", licenseStatus: "PASS", fetchStatus: "SUCCESS",
    redistributionAllowed: true, credentialRedacted: true,
    admissionEvidence: { licenseEvidenceHash: preparation.licenseEvidenceSha256 },
  };
  const nextInventory = { ...inventory, sources: [...inventory.sources, inventorySource] }, nextLedger = [...ledger, ledgerRow];
  validateSourceGovernancePolicy({ policy: preparation.projectedGovernancePolicy, inventory: nextInventory, freshnessPolicy: preparation.projectedFreshnessPolicy });
  const inputs = [inputPath, rawReceiptPath, sourceInput.stationLineObservationPath, sourceInput.stationLineReceiptPath, sourceInput.canonicalCatalogPath, path.join(sourceInput.collectionDirectory, "receipt.json"), path.join(sourceInput.collectionDirectory, "timetable.xlsx")].map((absolute, index) => ({ absolute, bytes: [inputBytes, rawReceiptBytes, membershipBytes, membershipReceiptBytes, catalogBytes, collectionReceiptBytes, rawBytes][index] }));
  inputs.push({ absolute: path.join(root, "tools/datapack/source-candidates.json"), bytes: candidatesBytes },
    { absolute: path.join(root, snapshotRelative), bytes: snapshotBytes });
  const values = [json(nextInventory), json(nextLedger), policyBytes, json(preparation.projectedFreshnessPolicy)];
  return OUTPUTS.map((relative, index) => ({ relative, prestateBytes: [inventoryBytes, ledgerBytes, governanceBytes, freshnessBytes][index], bytes: values[index], inputs }));
}

export async function prepareKorailTopologyRegistration({ repositoryRoot, sourceInputPath, now = new Date() } = {}) {
  const root = rootPath(repositoryRoot), inputPath = absolute(sourceInputPath, "SOURCE_INPUT");
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) fail("TIME");
  const [inventoryBytes, ledgerBytes, governanceBytes, freshnessBytes, candidatesBytes, inputBytes] = await Promise.all([
    ...OUTPUTS.map((relative) => readFile(path.join(root, relative))), readFile(path.join(root, "tools/datapack/source-candidates.json")), readFile(inputPath),
  ]);
  const sourceInput = exactSourceInput(parse(inputBytes, "SOURCE_INPUT"));
  const [membershipBytes, membershipReceiptBytes, catalogBytes, collectionReceiptBytes, rawBytes] = await Promise.all([
    readFile(sourceInput.stationLineObservationPath), readFile(sourceInput.stationLineReceiptPath), readFile(sourceInput.canonicalCatalogPath),
    readFile(path.join(sourceInput.collectionDirectory, "receipt.json")), readFile(path.join(sourceInput.collectionDirectory, "timetable.xlsx")),
  ]);
  if (sha(catalogBytes) !== sourceInput.canonicalCatalogSha256) fail("CATALOG");
  const inventory = parse(inventoryBytes, "INVENTORY"), ledger = parse(ledgerBytes, "LEDGER"), candidates = parse(candidatesBytes, "CANDIDATES");
  if ((inventory.sources ?? []).some((source) => source?.id === SOURCE_ID) || (ledger ?? []).some((snapshot) => snapshot?.sourceId === SOURCE_ID)) fail("FIRST_ONLY");
  const matches = (candidates.candidates ?? []).filter((entry) => entry?.id === SOURCE_ID);
  if (matches.length !== 1 || !matches[0].coverageScope?.lineIds?.includes(sourceInput.lineId)) fail("CANDIDATE");
  const candidate = matches[0], collectionReceipt = parse(collectionReceiptBytes, "COLLECTION_RECEIPT"), rawSha256 = sha(rawBytes);
  try { validateKorailTimetableFileReceipt(collectionReceipt, { rawSha256, rawByteLength: rawBytes.length }); } catch { fail("COLLECTION_RECEIPT"); }
  const membership = parse(membershipBytes, "MEMBERSHIP"), membershipReceipt = parse(membershipReceiptBytes, "MEMBERSHIP_RECEIPT");
  const preparation = await prepareKorailTopologyPublication({ candidate, freshnessPolicy: parse(freshnessBytes, "FRESHNESS"),
    governancePolicyBytes: governanceBytes, inventory, governanceEntry: sourceInput.governanceEntry, evaluationAt: now.toISOString(), collectionDirectory: sourceInput.collectionDirectory,
    stationLineObservation: membership, stationLineReceipt: membershipReceipt, canonicalCatalogPath: sourceInput.canonicalCatalogPath,
    canonicalCatalogSha256: sourceInput.canonicalCatalogSha256, operatorName: sourceInput.operatorName, lineName: sourceInput.lineName, lineId: sourceInput.lineId });
  const snapshot = preparation.snapshot, source = snapshot.observation?.sources?.timetable;
  if (sourceInput.observedDataUpdatedAt > snapshot.capturedAt.slice(0, 10)
    || (sourceInput.sourceUpdatedAt !== null && Date.parse(sourceInput.sourceUpdatedAt) > Date.parse(snapshot.capturedAt))) fail("SOURCE_TIME");
  if (snapshot.rawSha256 !== rawSha256 || source?.rawSha256 !== rawSha256 || source.rawByteLength !== rawBytes.length
    || source.collectionReceiptSha256 !== sha(collectionReceiptBytes) || !same(collectionReceipt, source.collectionReceipt)) fail("BINDING");
  return { root, inputPath, sourceInput, inventoryBytes, ledgerBytes, governanceBytes, freshnessBytes, candidatesBytes,
    inputBytes, membershipBytes, membershipReceiptBytes, catalogBytes, collectionReceiptBytes, rawBytes, inventory,
    ledger, candidate, collectionReceipt, rawSha256, preparation };
}

function exactOutputs(outputs) {
  const inputs = outputs?.[0]?.inputs;
  if (!Array.isArray(outputs) || outputs.length !== OUTPUTS.length || JSON.stringify(outputs.map((entry) => entry.relative)) !== JSON.stringify(OUTPUTS)
    || outputs.some((entry) => !Buffer.isBuffer(entry.bytes) || !Buffer.isBuffer(entry.prestateBytes) || entry.inputs !== inputs)
    || !Array.isArray(inputs) || inputs.length !== 9 || new Set(inputs.map((entry) => entry.absolute)).size !== inputs.length
    || inputs.some((entry) => !path.isAbsolute(entry?.absolute ?? "") || !Buffer.isBuffer(entry.bytes))) fail("OUTPUTS");
}
const transaction = createSourceRegistrationTransaction({
  label: "Korail route topology",
  validateOutputs: exactOutputs,
});
export async function recoverKorailRouteTopologyRegistration({ repositoryRoot } = {}) {
  return transaction.recover({ repositoryRoot: rootPath(repositoryRoot) });
}
export async function commitKorailTopologyRegistrationOutputs({ repositoryRoot, outputs, failAfter = null } = {}) { return transaction.commit({ repositoryRoot: rootPath(repositoryRoot), outputs, failAfter }); }
export async function registerKorailRouteTopology(options = {}) {
  await recoverKorailRouteTopologyRegistration({ repositoryRoot: options.repositoryRoot });
  const outputs = await buildKorailTopologyRegistrationOutputs(options);
  return commitKorailTopologyRegistrationOutputs({ repositoryRoot: options.repositoryRoot, outputs });
}

function validateRawReceipt(value, preparation, collectionReceiptBytes, rawSha256, byteSize, now) {
  const snapshot = preparation.snapshot, key = `source-raw/${SOURCE_ID}/${snapshot.capturedAt.slice(0, 10).replaceAll("-", "")}/${rawSha256}.xlsx`, uri = `oci://axvym6vk8g7i/easysubway-datapacks/${key}`;
  const keys = ["schemaVersion", "artifactKind", "sourceId", "snapshotId", "contentSha256", "collectionReceiptSha256", "capturedAt", "rawObjectUri", "rawObjectSha256", "byteSize", "storedAt", "rawRetentionExpiresAt"];
  if (!same(Object.keys(value).sort(utf16Compare), keys.toSorted(utf16Compare)) || value.schemaVersion !== 1
    || value.artifactKind !== "korail-metropolitan-timetable-raw-receipt" || value.sourceId !== SOURCE_ID
    || value.snapshotId !== snapshot.snapshotId || value.contentSha256 !== snapshot.contentSha256
    || value.collectionReceiptSha256 !== sha(collectionReceiptBytes) || value.capturedAt !== snapshot.capturedAt
    || value.rawObjectUri !== uri || value.rawObjectSha256 !== rawSha256 || value.byteSize !== byteSize
    || !utc(value.storedAt) || !utc(value.rawRetentionExpiresAt)
    || Date.parse(value.storedAt) < Date.parse(snapshot.capturedAt) || Date.parse(value.storedAt) > now.valueOf()
    || now.valueOf() >= Date.parse(snapshot.freshUntil) || now.valueOf() >= Date.parse(value.rawRetentionExpiresAt)
    || value.rawRetentionExpiresAt !== preparation.rawRetentionExpiresAt) fail("RAW_RECEIPT");
  return value;
}
async function writeDerivedSnapshot(file, bytes) { await mkdir(path.dirname(file), { recursive: true }); try { await writeFile(file, bytes, { flag: "wx", mode: 0o600 }); } catch (error) { if (error?.code !== "EEXIST" || !(await readFile(file)).equals(bytes)) fail("SNAPSHOT"); } }
function exactSourceInput(value) {
  const keys = ["schemaVersion", "artifactKind", "collectionDirectory", "stationLineObservationPath",
    "stationLineReceiptPath", "canonicalCatalogPath", "canonicalCatalogSha256", "operatorName", "lineName",
    "lineId", "governanceEntry", "observedDataUpdatedAt", "sourceUpdatedAt"].sort(utf16Compare);
  if (value?.schemaVersion !== 1 || value.artifactKind !== "korail-topology-registration-input"
    || !same(Object.keys(value).sort(utf16Compare), keys)
    || [value.collectionDirectory, value.stationLineObservationPath, value.stationLineReceiptPath,
      value.canonicalCatalogPath].some((entry) => !path.isAbsolute(entry ?? ""))
    || !/^[a-f0-9]{64}$/u.test(value.canonicalCatalogSha256 ?? "")
    || !/^\d{4}-\d{2}-\d{2}$/u.test(value.observedDataUpdatedAt ?? "")
    || !utc(`${value.observedDataUpdatedAt}T00:00:00.000Z`) || !utcOrNull(value.sourceUpdatedAt)
    || [value.operatorName, value.lineName, value.lineId].some((entry) => typeof entry !== "string" || entry === "")
    || !value.governanceEntry) fail("SOURCE_INPUT");
  return value;
}
function parse(bytes, code) { try { return JSON.parse(bytes); } catch { fail(code); } }
function rootPath(value) { if (!path.isAbsolute(value ?? "")) fail("ROOT"); return path.resolve(value); }
function absolute(value, code) { if (!path.isAbsolute(value ?? "")) fail(code); return path.resolve(value); }
function utc(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function utcOrNull(value) { return value === null || utc(value); }
function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function fail(code) { throw new Error(`KORAIL_TOPOLOGY_REGISTRATION_${code}`); }
