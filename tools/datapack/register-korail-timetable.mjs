import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateKorailTimetableFileReceipt } from "./collect-korail-metropolitan-timetable-file.mjs";
import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";
import { readKasiHolidayCalendarFiles } from "./fetch-kasi-public-holiday-calendar.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { SOURCE_REGISTRATION_OUTPUTS, createSourceRegistrationTransaction } from "./lib/source-registration-transaction.mjs";
import { buildRetainedKorailTimetable } from "./parse-korail-metropolitan-timetable.mjs";
import { buildAppendOnlyGovernancePolicyRegistration, deriveRawRetentionExpiresAt, validateSourceGovernancePolicy } from "./source-governance-policy.mjs";

const SOURCE_ID = "korail-metropolitan-planned-timetable";
const SOURCE_FAMILY_ID = "korail-metropolitan-timetable-file";
const OUTPUTS = SOURCE_REGISTRATION_OUTPUTS;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function buildKorailScheduleIds({ lineId, directions = ["up", "down"], dayLabels = ["평일", "휴일"] } = {}) {
  if (!text(lineId) || !same(directions, ["up", "down"]) || !same(dayLabels, ["평일", "휴일"])) fail("IDS");
  const id = (prefix, value) => `${prefix}-${sha(canonicalJson({ sourceId: SOURCE_ID, lineId, ...value }))}`;
  return { routes: Object.fromEntries(directions.map((direction) => [direction, id("route", { direction })])),
    services: Object.fromEntries(dayLabels.map((dayLabel) => [dayLabel, id("service", { dayLabel })])) };
}

/** 날짜·횟수의 수동 pin 없이 입력 identity 전체를 canonical snapshot에 결속한다. */
export function buildKorailScheduleSnapshot(input = {}) {
  const required = ["sourceFamilyId", "originalCapturedAt", "derivedFreshUntil", "serviceEffectiveAt", "serviceEffectiveUntil", "calendarWindow", "originalSelection", "topology", "raw", "calendar", "tables"];
  if (!same(Object.keys(input).sort(order), required.toSorted(order)) || input.sourceFamilyId !== SOURCE_FAMILY_ID
    || !utc(input.originalCapturedAt) || !utc(input.derivedFreshUntil) || !utc(input.serviceEffectiveAt)
    || !(input.serviceEffectiveUntil === null || utc(input.serviceEffectiveUntil)) || !validWindow(input.calendarWindow)
    || !text(input.originalSelection?.lineId) || !text(input.originalSelection?.operatorName) || !text(input.originalSelection?.lineName)
    || !validTopology(input.topology) || !validRaw(input.raw) || !validCalendar(input.calendar) || !validTables(input.tables)) fail("SNAPSHOT");
  if (Date.parse(input.serviceEffectiveAt) > Date.parse(input.derivedFreshUntil)
    || (input.serviceEffectiveUntil !== null && Date.parse(input.serviceEffectiveUntil) < Date.parse(input.serviceEffectiveAt))
    || !windowInside(input.calendarWindow, input.serviceEffectiveAt, input.serviceEffectiveUntil)) fail("SNAPSHOT");
  const rowsSha256 = sha(canonicalJson(input.tables));
  const tripsSha256 = sha(canonicalJson({ transitTrips: input.tables.transitTrips, transitStopTimes: input.tables.transitStopTimes }));
  const content = { schemaVersion: 1, artifactKind: "korail-metropolitan-timetable-snapshot", sourceId: SOURCE_ID,
    sourceFamilyId: SOURCE_FAMILY_ID, originalCapturedAt: input.originalCapturedAt, derivedFreshUntil: input.derivedFreshUntil,
    serviceEffectiveAt: input.serviceEffectiveAt, serviceEffectiveUntil: input.serviceEffectiveUntil,
    calendarWindow: structuredClone(input.calendarWindow), originalSelection: structuredClone(input.originalSelection),
    topology: structuredClone(input.topology), raw: structuredClone(input.raw), calendar: structuredClone(input.calendar),
    tables: structuredClone(input.tables), rowsSha256, tripsSha256 };
  const contentSha256 = sha(canonicalJson(content));
  return { ...content, contentSha256, snapshotId: `${SOURCE_ID}-${contentSha256}` };
}

export async function buildKorailTimetableRegistrationOutputs({ repositoryRoot, sourceInputPath, now = new Date() } = {}) {
  const context = await prepareKorailTimetableRegistration({ repositoryRoot, sourceInputPath, now });
  const { root, inputPath, inputBytes, input, inventoryBytes, ledgerBytes, governanceBytes, freshnessBytes, candidateBytes,
    inventory, ledger, candidate, topologySource, topologySnapshot, rawBytes, collectionReceiptBytes, collectionReceipt,
    membershipBytes, membershipReceiptBytes, catalogBytes, publicationReceiptBytes, calendarManifestBytes, calendarFiles,
    tables, snapshot, registration, freshness, scheduleCadence } = context;
  if (inventory.sources.some((entry) => entry?.id === SOURCE_ID) || ledger.some((entry) => entry?.sourceId === SOURCE_ID)) fail("FIRST_ONLY");
  const snapshotRelative = `tools/datapack/sources/${snapshot.snapshotId}.json`, snapshotBytes = json(snapshot);
  await writeDerivedSnapshot(path.join(root, snapshotRelative), snapshotBytes);
  const source = inventorySource({ candidate, input, snapshot, topologySource, scheduleCadence });
  const nextInventory = { ...inventory, sources: [...inventory.sources, source] };
  const policyBytes = json(registration.policy);
  const ledgerRow = { schemaVersion: 1, artifactKind: "official-source-snapshot", sourceId: SOURCE_ID,
    snapshotId: snapshot.snapshotId, previousSnapshotId: null, capturedAt: snapshot.originalCapturedAt,
    retrievedAt: snapshot.originalCapturedAt, sourceUpdatedAt: null, serviceEffectiveAt: snapshot.serviceEffectiveAt,
    serviceEffectiveUntil: snapshot.serviceEffectiveUntil,
    provider: candidate.evidence.provider, rowCount: snapshot.tables.transitStopTimes.length,
    coverageCount: snapshot.tables.transitTrips.length, rawSha256: snapshot.raw.rawSha256, contentSha256: snapshot.contentSha256,
    rawObjectUri: snapshot.raw.rawObjectUri, rawObjectSha256: snapshot.raw.rawSha256,
    rawReceiptSha256: snapshot.raw.publicationReceiptSha256, byteSize: snapshot.raw.byteSize,
    freshUntil: snapshot.derivedFreshUntil, freshnessExpiresAt: snapshot.derivedFreshUntil,
    rawRetentionExpiresAt: deriveRawRetentionExpiresAt({ policy: registration.policy, sourceId: SOURCE_ID, retrievedAt: snapshot.originalCapturedAt }),
    governancePolicyVersion: registration.policy.policyVersion, governancePolicySha256: sha(policyBytes),
    schemaFingerprint: sha(canonicalJson({ artifactKind: snapshot.artifactKind, keys: Object.keys(snapshot).sort(order) })),
    redactedRequestFingerprint: sha(canonicalJson({ sourceFamilyId: SOURCE_FAMILY_ID, collectionReceiptSha256: snapshot.raw.collectionReceiptSha256 })),
    snapshotStatus: "LOCKED", schemaStatus: "PASS", licenseStatus: "PASS", fetchStatus: "SUCCESS", redistributionAllowed: true,
    credentialRedacted: true, admissionEvidence: { licenseEvidenceHash: licenseHash(candidate) } };
  const nextLedger = [...ledger, ledgerRow];
  validateSourceGovernancePolicy({ policy: registration.policy, inventory: nextInventory, freshnessPolicy: freshness });
  const inputs = [
    [inputPath, inputBytes], [path.join(root, "tools/datapack/source-candidates.json"), candidateBytes],
    [input.retainedWorkbookPath, rawBytes], [input.collectionReceiptPath, collectionReceiptBytes],
    [input.publicationReceiptPath, publicationReceiptBytes], [input.topologySnapshotPath, context.topologyBytes],
    [input.stationLineObservationPath, membershipBytes], [input.stationLineReceiptPath, membershipReceiptBytes],
    [input.canonicalCatalogPath, catalogBytes], [path.join(input.calendarDirectory, "months.json"), calendarManifestBytes],
    ...calendarFiles.map(({ absolute, bytes }) => [absolute, bytes]),
    [path.join(root, snapshotRelative), snapshotBytes],
  ].map(([absolute, bytes]) => ({ absolute, bytes }));
  const values = [json(nextInventory), json(nextLedger), policyBytes, json(freshness)];
  return OUTPUTS.map((relative, index) => ({ relative, prestateBytes: [inventoryBytes, ledgerBytes, governanceBytes, freshnessBytes][index], bytes: values[index], inputs }));
}

export async function prepareKorailTimetableRegistration({ repositoryRoot, sourceInputPath, now = new Date() } = {}) {
  const root = rootPath(repositoryRoot), inputPath = absolute(sourceInputPath, "SOURCE_INPUT");
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) fail("TIME");
  const [inventoryBytes, ledgerBytes, governanceBytes, freshnessBytes, candidateBytes, inputBytes] = await Promise.all([
    ...OUTPUTS.map((relative) => readFile(path.join(root, relative))), readFile(path.join(root, "tools/datapack/source-candidates.json")), readFile(inputPath),
  ]);
  const input = exactInput(parse(inputBytes, "SOURCE_INPUT"));
  const [inventory, ledger, governance, freshnessBase, candidates] = [parse(inventoryBytes, "INVENTORY"), parse(ledgerBytes, "LEDGER"), parse(governanceBytes, "GOVERNANCE"), parse(freshnessBytes, "FRESHNESS"), parse(candidateBytes, "CANDIDATES")];
  const candidate = only(candidates.candidates, (entry) => entry?.id === SOURCE_ID, "CANDIDATE");
  const topologySource = only(inventory.sources, (entry) => entry?.id === SOURCE_FAMILY_ID, "TOPOLOGY_SOURCE");
  const topologyEvidence = topologySource.topologyAdmissionEvidence;
  if (!topologyEvidence || input.topologySnapshotPath !== path.join(root, `tools/datapack/sources/${topologyEvidence.snapshotId}.json`)) fail("TOPOLOGY_INPUT");
  const [topologyBytes, rawBytes, collectionReceiptBytes, publicationReceiptBytes, membershipBytes, membershipReceiptBytes, catalogBytes, calendar] = await Promise.all([
    readFile(input.topologySnapshotPath), readFile(input.retainedWorkbookPath), readFile(input.collectionReceiptPath),
    readFile(input.publicationReceiptPath), readFile(input.stationLineObservationPath), readFile(input.stationLineReceiptPath),
    readFile(input.canonicalCatalogPath), readKasiHolidayCalendarFiles(input.calendarDirectory),
  ]);
  const calendarManifestBytes = await readFile(path.join(input.calendarDirectory, "months.json"));
  const calendarFiles = calendar.months.map(({ year, month, raw }) => ({
    absolute: path.join(input.calendarDirectory, `${year}-${String(month).padStart(2, "0")}.xml`), bytes: Buffer.from(raw),
  }));
  const [topologySnapshot, collectionReceipt] = [parse(topologyBytes, "TOPOLOGY"), parse(collectionReceiptBytes, "COLLECTION_RECEIPT")];
  validateParentSnapshot(topologySnapshot);
  if (sha(rawBytes) !== topologySnapshot.rawSha256 || topologySnapshot.contentSha256 !== topologyEvidence.contentSha256
    || topologySnapshot.snapshotId !== topologyEvidence.snapshotId || topologySnapshot.sourceId !== SOURCE_FAMILY_ID) fail("TOPOLOGY_BINDING");
  try { validateKorailTimetableFileReceipt(collectionReceipt, { rawSha256: sha(rawBytes), rawByteLength: rawBytes.length }); } catch { fail("COLLECTION_RECEIPT"); }
  if (collectionReceipt.capturedAt !== topologySnapshot.capturedAt) fail("COLLECTION_RECEIPT");
  const parentLedger = only(ledger, (entry) => entry?.sourceId === SOURCE_FAMILY_ID && entry.snapshotId === topologySnapshot.snapshotId, "PARENT_LEDGER");
  const publicationReceipt = validateParentPublicationReceipt({ bytes: publicationReceiptBytes, topologySnapshot, parentLedger, collectionReceiptBytes, rawBytes, now });
  if (parentLedger.rawSha256 !== sha(rawBytes) || parentLedger.contentSha256 !== topologySnapshot.contentSha256
    || parentLedger.capturedAt !== topologySnapshot.capturedAt || parentLedger.retrievedAt !== topologySnapshot.capturedAt
    || parentLedger.rawReceiptSha256 !== sha(publicationReceiptBytes)
    || parentLedger.rawObjectUri !== publicationReceipt.rawObjectUri || parentLedger.rawObjectSha256 !== sha(rawBytes)
    || parentLedger.byteSize !== rawBytes.length || parentLedger.rawRetentionExpiresAt !== publicationReceipt.rawRetentionExpiresAt) fail("PARENT_BINDING");
  const sourceClass = only(freshnessBase.sourceClasses, (entry) => entry?.id === "planned_timetable", "FRESHNESS_CLASS");
  const freshness = structuredClone(freshnessBase); const nextClass = freshness.sourceClasses.find((entry) => entry.id === sourceClass.id);
  if (nextClass.sourceIds.includes(SOURCE_ID)) fail("FIRST_ONLY"); nextClass.sourceIds = [...nextClass.sourceIds, SOURCE_ID].sort(order);
  const retainedLicenseHash = topologySource.admissionEvidence?.licenseEvidenceHash;
  if (!hash(retainedLicenseHash) || retainedLicenseHash !== licenseHash(candidate)) fail("LICENSE_BINDING");
  const registration = buildAppendOnlyGovernancePolicyRegistration({ predecessorPolicyBytes: governanceBytes, addedSources: [verifiedGovernance(input.governanceEntry, candidate, now, retainedLicenseHash)] });
  const ids = buildKorailScheduleIds({ lineId: input.lineId });
  const retained = await buildRetainedKorailTimetable({ inputPath: input.retainedWorkbookPath, sha256: sha(rawBytes), holidayDirectory: input.calendarDirectory,
    startDate: input.calendarWindow.startDate, endDate: input.calendarWindow.endDate, serviceIds: ids.services, routeIds: ids.routes,
    stationLineObservation: topologySnapshot.observation.sources.membership ? parse(membershipBytes, "MEMBERSHIP") : fail("MEMBERSHIP"),
    stationLineReceipt: parse(membershipReceiptBytes, "MEMBERSHIP_RECEIPT"), operatorName: input.operatorName, lineName: input.lineName,
    canonicalCatalogPath: input.canonicalCatalogPath, canonicalCatalogSha256: input.canonicalCatalogSha256, lineId: input.lineId });
  const stableInputs = await Promise.all([
    readFile(input.retainedWorkbookPath), readFile(input.collectionReceiptPath), readFile(input.publicationReceiptPath),
    readFile(input.topologySnapshotPath), readFile(input.stationLineObservationPath), readFile(input.stationLineReceiptPath),
    readFile(input.canonicalCatalogPath), readFile(path.join(input.calendarDirectory, "months.json")),
    ...calendarFiles.map(({ absolute }) => readFile(absolute)),
  ]);
  const frozenInputs = [rawBytes, collectionReceiptBytes, publicationReceiptBytes, topologyBytes, membershipBytes,
    membershipReceiptBytes, catalogBytes, calendarManifestBytes, ...calendarFiles.map(({ bytes }) => bytes)];
  if (stableInputs.some((bytes, index) => !bytes.equals(frozenInputs[index]))) fail("INPUT_STABILITY");
  const derivedFreshUntil = deriveFreshnessExpiresAt({ policy: freshness, sourceClassId: "planned_timetable", basisAt: input.serviceEffectiveAt, providerValidUntil: input.serviceEffectiveUntil, evaluationAt: now.toISOString() });
  if (Date.parse(derivedFreshUntil) <= now.valueOf()) fail("FRESHNESS");
  if (retained.observation.sources.catalog.rawSha256 !== sha(catalogBytes)
    || retained.calendarManifestSha256 !== sha(calendarManifestBytes)
    || !same(retained.tables.holidayCalendarSources, calendar.months.map(({ year, month, sha256, raw }) => ({ year, month, rawSha256: sha256, rawByteLength: raw.byteLength }))
      .sort((left, right) => left.year - right.year || left.month - right.month))) fail("CALENDAR_BINDING");
  const snapshot = buildKorailScheduleSnapshot({ sourceFamilyId: SOURCE_FAMILY_ID, originalCapturedAt: topologySnapshot.capturedAt,
    derivedFreshUntil, serviceEffectiveAt: input.serviceEffectiveAt, serviceEffectiveUntil: input.serviceEffectiveUntil,
    calendarWindow: input.calendarWindow, originalSelection: { lineId: input.lineId, operatorName: input.operatorName, lineName: input.lineName },
    topology: { sourceId: SOURCE_FAMILY_ID, snapshotId: topologySnapshot.snapshotId, contentSha256: topologySnapshot.contentSha256 },
    raw: { sourceId: SOURCE_FAMILY_ID, rawSha256: sha(rawBytes), byteSize: rawBytes.length, collectionReceiptSha256: sha(collectionReceiptBytes), publicationReceiptSha256: sha(publicationReceiptBytes), rawObjectUri: parentLedger.rawObjectUri },
    calendar: { manifestSha256: retained.calendarManifestSha256, months: retained.tables.holidayCalendarSources.map(({ year, month, rawSha256 }) => ({ year, month, sha256: rawSha256 })) }, tables: retained.tables });
  return { root, inputPath, input, inputBytes, inventoryBytes, ledgerBytes, governanceBytes, freshnessBytes, candidateBytes, inventory, ledger, candidate, topologySource, topologySnapshot, topologyBytes, rawBytes, collectionReceipt, collectionReceiptBytes, publicationReceiptBytes, membershipBytes, membershipReceiptBytes, catalogBytes, calendarManifestBytes, calendarFiles, tables: retained.tables, snapshot, registration, freshness, scheduleCadence: nextClass.reverificationCadence ?? nextClass.maximumReverificationCadence };
}

function inventorySource({ candidate, input, snapshot, topologySource, scheduleCadence }) {
  const provider = candidate.evidence.provider;
  return { id: SOURCE_ID, displayName: candidate.displayName, owner: provider, provider, providerDepartment: "", sourceSystem: topologySource.sourceSystem,
    datasetUrl: candidate.detailUrl, datasetKind: "official-static-file", coverage: candidate.evidence.coverage,
    coverageScope: { ...structuredClone(candidate.coverageScope), sourceDomains: [candidate.domain] }, requiredForProductionPack: true, productionUseAllowed: true,
    updateFrequency: scheduleCadence, observedDataUpdatedAt: snapshot.originalCapturedAt.slice(0, 10), retrievedAt: snapshot.originalCapturedAt.slice(0, 10),
    license: { type: "PUBLIC_DATA_FREE_USE", name: candidate.evidence.license, attribution: provider, commercialUseAllowed: true, derivativeWorkAllowed: true, redistributionAllowed: true, evidenceUrl: candidate.evidence.licenseEvidenceUrl },
    fieldsProvided: ["service_calendar", "trip", "stop_time"], capabilities: { schedule: { status: "SUPPORTED", productionUseAllowed: true, updateFrequency: scheduleCadence, coverageStatus: "DAEGYEONG_LINE", unsupportedNotes: "Admission is limited to the selected Korail metropolitan line." }, realtime: unsupported("NO_REALTIME_FIELDS"), facility: unsupported("NO_FACILITY_FIELDS") },
    scheduleAdmissionEvidence: { issue: 454, materializer: "tools/datapack/materialize-korail-timetable.mjs", verificationTest: "tools/datapack/materialize-korail-timetable.test.mjs", snapshotId: snapshot.snapshotId, snapshotPath: `tools/datapack/sources/${snapshot.snapshotId}.json`, capturedAt: snapshot.originalCapturedAt, freshUntil: snapshot.derivedFreshUntil, rowCount: snapshot.tables.transitStopTimes.length, departureCount: snapshot.tables.transitStopTimes.filter(({ departureSeconds }) => Number.isSafeInteger(departureSeconds)).length, tripCount: snapshot.tables.transitTrips.length, stopTimeCount: snapshot.tables.transitStopTimes.length, rawSha256: snapshot.raw.rawSha256, rowsSha256: snapshot.rowsSha256, topologySourceId: SOURCE_FAMILY_ID, topologySnapshotId: snapshot.topology.snapshotId, topologyContentSha256: snapshot.topology.contentSha256, contentSha256: snapshot.contentSha256, tripsSha256: snapshot.tripsSha256 },
    admissionEvidence: { licenseEvidenceHash: topologySource.admissionEvidence.licenseEvidenceHash, retainedReceiptSourceId: SOURCE_FAMILY_ID } };
}

function unsupported(coverageStatus) { return { status: "UNSUPPORTED", productionUseAllowed: false, liveEtaEligible: false, rateLimitStatus: "NOT_APPLICABLE", updateFrequency: "not applicable", coverageStatus, unsupportedNotes: "Official static timetable does not provide this capability." }; }
function verifiedGovernance(entry, candidate, now, retainedLicenseHash) { const expected = licenseHash(candidate), review = entry?.licenseReview; if (!hash(retainedLicenseHash) || retainedLicenseHash !== expected || !entry || entry.sourceId !== SOURCE_ID || entry.sourceClassId !== "planned_timetable" || entry.retentionClassId !== "standard-90d" || !review || review.status !== "APPROVED" || review.termsHash !== retainedLicenseHash || review.reviewedProvider !== candidate.evidence.provider || review.reviewedDatasetUrl !== candidate.detailUrl || review.termsUrl !== candidate.evidence.licenseEvidenceUrl || !utc(review.reviewedAt) || !utc(review.nextReviewAt) || Date.parse(review.reviewedAt) > now.valueOf() || Date.parse(review.nextReviewAt) <= now.valueOf()) fail("GOVERNANCE"); return structuredClone(entry); }
function licenseHash(candidate) { return sha(canonicalJson({ type: candidate.evidence?.license, provider: candidate.evidence?.provider, evidenceUrl: candidate.evidence?.licenseEvidenceUrl, redistributionAllowed: true })); }
function exactInput(value) { const keys = ["schemaVersion", "artifactKind", "retainedWorkbookPath", "collectionReceiptPath", "publicationReceiptPath", "topologySnapshotPath", "stationLineObservationPath", "stationLineReceiptPath", "canonicalCatalogPath", "canonicalCatalogSha256", "calendarDirectory", "calendarWindow", "serviceEffectiveAt", "serviceEffectiveUntil", "operatorName", "lineName", "lineId", "governanceEntry"].sort(order); if (value?.schemaVersion !== 1 || value.artifactKind !== "korail-timetable-registration-input" || !same(Object.keys(value).sort(order), keys) || [value.retainedWorkbookPath, value.collectionReceiptPath, value.publicationReceiptPath, value.topologySnapshotPath, value.stationLineObservationPath, value.stationLineReceiptPath, value.canonicalCatalogPath, value.calendarDirectory].some((item) => !path.isAbsolute(item ?? "")) || !hash(value.canonicalCatalogSha256) || !validWindow(value.calendarWindow) || !utc(value.serviceEffectiveAt) || !(value.serviceEffectiveUntil === null || utc(value.serviceEffectiveUntil)) || [value.operatorName, value.lineName, value.lineId].some((item) => !text(item)) || !value.governanceEntry) fail("SOURCE_INPUT"); return value; }
function exactOutputs(outputs) { const inputs = outputs?.[0]?.inputs; if (!Array.isArray(outputs) || outputs.length !== OUTPUTS.length || !same(outputs.map(({ relative }) => relative), OUTPUTS) || !Array.isArray(inputs) || outputs.some((item) => item.inputs !== inputs || !Buffer.isBuffer(item.bytes) || !Buffer.isBuffer(item.prestateBytes))) fail("OUTPUTS"); }
const transaction = createSourceRegistrationTransaction({ label: "Korail timetable", validateOutputs: exactOutputs });
export async function recoverKorailTimetableRegistration({ repositoryRoot } = {}) { return transaction.recover({ repositoryRoot: rootPath(repositoryRoot) }); }
export async function commitKorailTimetableRegistrationOutputs({ repositoryRoot, outputs, failAfter = null } = {}) { return transaction.commit({ repositoryRoot: rootPath(repositoryRoot), outputs, failAfter }); }
export async function registerKorailTimetable(options = {}) { await recoverKorailTimetableRegistration({ repositoryRoot: options.repositoryRoot }); return commitKorailTimetableRegistrationOutputs({ repositoryRoot: options.repositoryRoot, outputs: await buildKorailTimetableRegistrationOutputs(options) }); }
async function writeDerivedSnapshot(file, bytes) { await mkdir(path.dirname(file), { recursive: true }); try { await writeFile(file, bytes, { flag: "wx", mode: 0o600 }); } catch (error) { if (error?.code !== "EEXIST" || !(await readFile(file)).equals(bytes)) fail("SNAPSHOT_WRITE"); } }
function validTables(value) { const keys = ["serviceCalendars", "serviceCalendarDates", "transitRoutes", "transitTrips", "transitStopTimes", "holidayCalendarSources"].sort(order); return value && same(Object.keys(value).sort(order), keys) && keys.every((key) => Array.isArray(value[key])); }
function validTopology(value) { return value?.sourceId === SOURCE_FAMILY_ID && text(value.snapshotId) && hash(value.contentSha256); }
function validRaw(value) { return value?.sourceId === SOURCE_FAMILY_ID && hash(value.rawSha256) && Number.isSafeInteger(value.byteSize) && value.byteSize > 0 && hash(value.collectionReceiptSha256) && hash(value.publicationReceiptSha256) && /^oci:\/\//u.test(value.rawObjectUri ?? ""); }
function validCalendar(value) { return hash(value?.manifestSha256) && Array.isArray(value.months) && value.months.length > 0 && value.months.every((month) => Number.isSafeInteger(month.year) && Number.isSafeInteger(month.month) && month.month >= 1 && month.month <= 12 && hash(month.sha256)); }
function validWindow(value) { return validDate(value?.startDate) && validDate(value?.endDate) && value.startDate <= value.endDate; }
function windowInside(window, start, until) { const first = serviceDayStart(window.startDate), last = serviceDayEnd(window.endDate); return Date.parse(start) <= Date.parse(first) && (until === null || Date.parse(until) >= Date.parse(last)); }
function serviceDayStart(value) { return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00.000+09:00`; }
function serviceDayEnd(value) { return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T23:59:59.999+09:00`; }
function validDate(value) { if (!/^\d{8}$/u.test(value ?? "")) return false; const day = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`, instant = `${day}T00:00:00.000Z`; return Number.isFinite(Date.parse(instant)) && new Date(instant).toISOString().slice(0, 10) === day; }
function utc(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function hash(value) { return /^[a-f0-9]{64}$/u.test(value ?? ""); }
function text(value) { return typeof value === "string" && value.length > 0; }
function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function only(rows, predicate, code) { const matches = Array.isArray(rows) ? rows.filter(predicate) : []; if (matches.length !== 1) fail(code); return matches[0]; }
function parse(bytes, code) { try { return JSON.parse(bytes); } catch { fail(code); } }
function rootPath(value) { if (!path.isAbsolute(value ?? "")) fail("ROOT"); return path.resolve(value); }
function absolute(value, code) { if (!path.isAbsolute(value ?? "")) fail(code); return path.resolve(value); }
function validateParentSnapshot(snapshot) { const { snapshotId, contentSha256, ...content } = snapshot ?? {}; if (!text(snapshotId) || !hash(contentSha256) || sha(canonicalJson(content)) !== contentSha256) fail("TOPOLOGY_BINDING"); }
function validateParentPublicationReceipt({ bytes, topologySnapshot, parentLedger, collectionReceiptBytes, rawBytes, now }) {
  const value = parse(bytes, "PUBLICATION_RECEIPT");
  const keys = ["schemaVersion", "artifactKind", "sourceId", "snapshotId", "contentSha256", "collectionReceiptSha256", "capturedAt", "rawObjectUri", "rawObjectSha256", "byteSize", "storedAt", "rawRetentionExpiresAt"].sort(order);
  if (!same(Object.keys(value).sort(order), keys) || value.schemaVersion !== 1 || value.artifactKind !== "korail-metropolitan-timetable-raw-receipt" || value.sourceId !== SOURCE_FAMILY_ID || value.snapshotId !== topologySnapshot.snapshotId || value.contentSha256 !== topologySnapshot.contentSha256 || value.collectionReceiptSha256 !== sha(collectionReceiptBytes) || value.capturedAt !== topologySnapshot.capturedAt || value.rawObjectUri !== parentLedger.rawObjectUri || value.rawObjectSha256 !== sha(rawBytes) || value.byteSize !== rawBytes.length || !utc(value.storedAt) || !utc(value.rawRetentionExpiresAt) || Date.parse(value.storedAt) < Date.parse(value.capturedAt) || Date.parse(value.storedAt) > now.valueOf() || Date.parse(value.rawRetentionExpiresAt) <= now.valueOf() || parentLedger.rawObjectSha256 !== value.rawObjectSha256 || parentLedger.rawReceiptSha256 !== sha(bytes)) fail("PUBLICATION_RECEIPT");
  return value;
}
function fail(code) { throw new Error(`KORAIL_TIMETABLE_REGISTRATION_${code}`); }

async function main(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) fail("CLI");
    values.set(key, value);
  }
  if (!same([...values.keys()].sort(order), ["--repository-root", "--source-input"].sort(order))) fail("CLI");
  await registerKorailTimetable({ repositoryRoot: values.get("--repository-root"), sourceInputPath: values.get("--source-input") });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
