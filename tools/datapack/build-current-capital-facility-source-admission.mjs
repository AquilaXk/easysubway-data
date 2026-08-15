import { canonicalCurrentCapitalFacilityCollectionPlanJson } from "./build-current-capital-facility-collection-plan.mjs";
import { validateKricAccessibilitySnapshotIdentity } from "./collect-kric-accessibility-snapshots.mjs";
import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";

const SOURCE_ID = "kric-station-convenience-standard";
const TYPES = Object.freeze(["ELEVATOR", "ESCALATOR", "WHEELCHAIR_LIFT"]);
const FACILITY_TYPES = new Map([["EV", "ELEVATOR"], ["ES", "ESCALATOR"], ["WCLF", "WHEELCHAIR_LIFT"]]);
const AUXILIARY_CODES = new Set(["ELEC", "FEED", "INFO", "TOLT"]);
const PROJECTION_KEYS = [
  "snapshotId", "sourceId", "rawObjectUri", "rawSha256", "redactedRequestFingerprint",
  "schemaFingerprint", "licenseStatus", "redistributionAllowed", "adminReviewRecordHash",
  "snapshotStatus", "credentialRedacted", "freshnessExpiresAt", "rawRetentionExpiresAt",
  "governancePolicyVersion", "governancePolicySha256",
];
const OUTPUT_KEYS = [
  "schemaVersion", "artifactKind", "observedAt", "candidate", "sourceIdentity",
  "stationLineProviderMappingSha256", "denominatorRows", "denominatorStateSummary",
  "cells", "cellStateSummary", "materializerEvidenceRows", "decision", "admissionDigest",
];

export function buildCurrentCapitalFacilitySourceAdmission(input) {
  const observedAtMillis = requiredUtcInstant(input?.observedAt, "observedAt");
  const observedAt = new Date(observedAtMillis).toISOString();
  const planBytes = requireBytes(input?.planBytes, "capital FACILITY plan");
  const canonicalPackBytes = requireBytes(input?.canonicalPackBytes, "capital canonical pack");
  const snapshotBytes = requireBytes(input?.snapshotBytes, "KRIC snapshot");
  const plan = parse(planBytes, "capital FACILITY plan");
  const pack = parse(canonicalPackBytes, "capital canonical pack");
  const snapshot = validateKricAccessibilitySnapshotIdentity(parse(snapshotBytes, "KRIC snapshot"));
  const mappings = validateCurrentCapitalFacilityPlanAndCanonicalPack({ plan, planBytes, pack, canonicalPackBytes });
  const sourceContext = validateSourceContext({
    candidateBuildSpec: input?.candidateBuildSpec,
    sourceInventory: input?.sourceInventory,
    sourceSnapshots: input?.sourceSnapshots,
    snapshot,
    snapshotBytes,
    observedAtMillis,
  });
  const queries = validateQueryCoverage(snapshot, mappings);
  const denominatorRows = [];
  const cells = [];
  const materializerEvidenceRows = [];
  for (const mapping of mappings) {
    const query = queries.get(mappingKey(mapping));
    const presentTypes = queryFacilityTypes(query);
    const rows = TYPES.map((facilityType) => ({
      stationId: mapping.stationId,
      lineId: mapping.lineId,
      facilityType,
      state: presentTypes.has(facilityType) ? "VERIFIED_PRESENT" : "VERIFIED_ABSENT",
      sourceId: SOURCE_ID,
      snapshotId: snapshot.snapshotId,
    }));
    denominatorRows.push(...rows);
    const state = rows.some((row) => row.state === "VERIFIED_PRESENT")
      ? "ADMITTED_FACILITY_PRESENT"
      : "ADMITTED_FACILITY_ABSENT";
    const cell = {
      stationId: mapping.stationId,
      lineId: mapping.lineId,
      state,
      sourceId: SOURCE_ID,
      snapshotId: snapshot.snapshotId,
    };
    cells.push(cell);
    materializerEvidenceRows.push({
      ...cell,
      evidenceState: state === "ADMITTED_FACILITY_PRESENT" ? "VERIFIED_PRESENT" : "VERIFIED_ABSENT",
    });
  }
  const payload = {
    schemaVersion: 1,
    artifactKind: "current-capital-facility-source-admission",
    observedAt,
    candidate: {
      candidateId: sourceContext.candidateId,
      sourceSnapshotSetHash: sourceContext.sourceSnapshotSetHash,
    },
    sourceIdentity: sourceContext.sourceIdentity,
    stationLineProviderMappingSha256: sha256(canonicalJson(mappings)),
    denominatorRows,
    denominatorStateSummary: summarize(denominatorRows, ["VERIFIED_PRESENT", "VERIFIED_ABSENT"]),
    cells,
    cellStateSummary: summarize(cells, ["ADMITTED_FACILITY_PRESENT", "ADMITTED_FACILITY_ABSENT"]),
    materializerEvidenceRows,
    decision: "GO",
  };
  return { ...payload, admissionDigest: sha256(canonicalJson(payload)) };
}

export function canonicalCurrentCapitalFacilitySourceAdmissionJson(value) {
  validateRenderedAdmission(value);
  return `${canonicalJson(value)}\n`;
}

export function validateCurrentCapitalFacilityPlanAndCanonicalPack({ plan, planBytes, pack, canonicalPackBytes }) {
  if (canonicalCurrentCapitalFacilityCollectionPlanJson(plan) !== planBytes.toString("utf8")) {
    throw new Error("capital FACILITY plan bytes are not canonical");
  }
  if (plan?.counts?.stationLineCount !== 213 || plan.counts.stationCount !== 199
    || plan.counts.providerTupleCount !== 213
    || plan.sourceIdentity?.canonicalPackSha256 !== sha256(canonicalPackBytes)) {
    throw new Error("capital FACILITY plan identity mismatch");
  }
  const capital = pack?.packs?.length === 1 ? pack.packs[0] : undefined;
  if (pack?.manifest?.channel !== "production" || pack?.manifest?.activePack?.id !== "capital"
    || capital?.id !== "capital" || capital?.version !== "1") {
    throw new Error("capital canonical pack identity mismatch");
  }
  const capitalLineIds = new Set((capital.lines ?? [])
    .filter(({ operatorId }) => operatorId === "seoul-metro")
    .map(({ id }) => id));
  const canonicalMembership = new Set((capital.stationLines ?? [])
    .filter(({ lineId }) => capitalLineIds.has(lineId))
    .map(({ stationId, lineId }) => `${stationId}\0${lineId}`));
  const mappings = plan.stationLineProviderMappings;
  if (!Array.isArray(mappings) || mappings.length !== 213) throw new Error("capital FACILITY mapping coverage mismatch");
  const seen = new Set();
  for (const mapping of mappings) {
    if (mapping?.regionId !== "capital" || mapping.operatorId !== "seoul-metro"
      || !canonicalMembership.has(`${mapping.stationId}\0${mapping.lineId}`)
      || seen.has(`${mapping.stationId}\0${mapping.lineId}`)) {
      throw new Error("capital FACILITY plan/canonical membership mismatch");
    }
    seen.add(`${mapping.stationId}\0${mapping.lineId}`);
  }
  if (seen.size !== 213 || canonicalMembership.size !== 213
    || [...canonicalMembership].some((stationLine) => !seen.has(stationLine))
    || new Set(mappings.map(({ stationId }) => stationId)).size !== 199) {
    throw new Error("capital FACILITY mapping coverage mismatch");
  }
  return mappings;
}

function validateSourceContext({ candidateBuildSpec, sourceInventory, sourceSnapshots, snapshot, snapshotBytes, observedAtMillis }) {
  if (candidateBuildSpec?.schemaVersion !== 1 || candidateBuildSpec.artifactKind !== "datapack-candidate-build-spec"
    || !Array.isArray(candidateBuildSpec.sourceSnapshotIds) || !Array.isArray(candidateBuildSpec.sourceSnapshots)
    || candidateBuildSpec.sourceSnapshotIds.length !== candidateBuildSpec.sourceSnapshots.length
    || typeof candidateBuildSpec.candidateId !== "string" || candidateBuildSpec.candidateId === ""
    || !sha(candidateBuildSpec.sourceSnapshotSetHash)) {
    throw new Error("candidate build spec identity mismatch");
  }
  if (!Array.isArray(sourceInventory?.sources) || !Array.isArray(sourceSnapshots)) {
    throw new Error("source registries must be arrays");
  }
  const selected = candidateBuildSpec.sourceSnapshotIds.map((snapshotId, index) => {
    const ledger = exactlyOne(sourceSnapshots, (entry) => entry?.snapshotId === snapshotId, "candidate source snapshot");
    const projection = candidateBuildSpec.sourceSnapshots[index];
    for (const key of PROJECTION_KEYS) {
      if (projection?.[key] !== ledger[key]) throw new Error("candidate source snapshot projection mismatch");
    }
    return ledger;
  });
  if (new Set(candidateBuildSpec.sourceSnapshotIds).size !== selected.length
    || sha256(JSON.stringify(selected)) !== candidateBuildSpec.sourceSnapshotSetHash) {
    throw new Error("candidate source snapshot set identity mismatch");
  }
  const source = exactlyOne(sourceInventory.sources, ({ id }) => id === SOURCE_ID, "KRIC source inventory");
  const evidence = source.accessibilityAdmissionEvidence;
  const admission = source.admissionEvidence;
  if (source.productionUseAllowed !== true || source.requiredForProductionPack !== true
    || source.capabilities?.facility?.status !== "SUPPORTED" || source.capabilities.facility.productionUseAllowed !== true
    || source.license?.commercialUseAllowed !== true || source.license?.derivativeWorkAllowed !== true
    || source.license?.redistributionAllowed !== true || typeof source.license?.attribution !== "string" || source.license.attribution === ""
    || admission?.decision !== "APPROVED" || evidence?.decision !== "APPROVED"
    || evidence.productionUseAllowed !== true || evidence.licenseEvidenceHash !== admission.licenseEvidenceHash
    || !sha(evidence.licenseEvidenceHash)) {
    throw new Error("KRIC source production admission mismatch");
  }
  const snapshotFileSha256 = sha256(snapshotBytes);
  const expectedPath = `tools/datapack/sources/${snapshot.snapshotId}.json`;
  if (evidence.snapshotId !== snapshot.snapshotId || evidence.snapshotPath !== expectedPath
    || evidence.rawSha256 !== snapshot.rawSha256 || evidence.contentSha256 !== snapshot.contentSha256
    || evidence.schemaFingerprint !== snapshot.schemaFingerprint || evidence.snapshotFileSha256 !== snapshotFileSha256
    || evidence.capturedAt !== snapshot.capturedAt || evidence.observedAt !== snapshot.observedAt
    || evidence.freshUntil !== snapshot.freshUntil || evidence.absenceEvidenceMode !== "EXHAUSTIVE_LIST") {
    throw new Error("KRIC accessibility evidence identity mismatch");
  }
  const ledger = exactlyOne(sourceSnapshots, (entry) => entry?.sourceId === SOURCE_ID && entry.snapshotId === snapshot.snapshotId, "KRIC source snapshot ledger");
  const member = exactlyOne(candidateBuildSpec.sourceSnapshots, (entry) => entry?.sourceId === SOURCE_ID && entry.snapshotId === snapshot.snapshotId, "KRIC candidate membership");
  if (candidateBuildSpec.sourceSnapshotIds.filter((id) => id === snapshot.snapshotId).length !== 1
    || !["LOCKED", "SUCCESS", "PASS", "PASS"].every((expected, index) => [ledger.snapshotStatus, ledger.fetchStatus, ledger.schemaStatus, ledger.licenseStatus][index] === expected)
    || ledger.credentialRedacted !== true || ledger.redistributionAllowed !== true
    || ledger.schemaVersion !== 1 || ledger.artifactKind !== "official-source-snapshot" || ledger.sourceId !== SOURCE_ID
    || ledger.provider !== source.provider || ledger.coverageCount !== 213 || ledger.rowCount !== snapshot.rowCount
    || ledger.contentSha256 !== snapshot.contentSha256 || ledger.schemaFingerprint !== snapshot.schemaFingerprint
    || ledger.redactedRequestFingerprint !== snapshot.redactedRequestFingerprint
    || ledger.adminReviewRecordHash !== admission.adminReviewRecordHash
    || ledger.retrievedAt !== snapshot.capturedAt || ledger.sourceUpdatedAt !== snapshot.observedAt
    || typeof ledger.previousSnapshotId !== "string" || ledger.previousSnapshotId === ""
    || !ledger.diffSummary || typeof ledger.diffSummary !== "object" || Array.isArray(ledger.diffSummary)
    || !sha(ledger.rawSha256)) {
    throw new Error("KRIC source snapshot ledger mismatch");
  }
  for (const key of PROJECTION_KEYS) {
    if (member[key] !== ledger[key]) throw new Error("KRIC candidate membership mismatch");
  }
  const receipt = ledger.rawReceipt;
  if (receipt?.sourceId !== SOURCE_ID || receipt.snapshotId !== snapshot.snapshotId
    || receipt.snapshotRawSha256 !== snapshot.rawSha256 || receipt.snapshotFileSha256 !== snapshotFileSha256
    || receipt.rawObjectSha256 !== ledger.rawSha256
    || receipt.capturedAt !== snapshot.capturedAt
    || !Number.isSafeInteger(receipt.byteSize) || receipt.byteSize <= 0) {
    throw new Error("KRIC raw receipt identity mismatch");
  }
  const capturedAt = requiredUtcInstant(snapshot.capturedAt, "KRIC capturedAt");
  const observedAt = requiredUtcInstant(snapshot.observedAt, "KRIC observedAt");
  const freshUntil = requiredUtcInstant(snapshot.freshUntil, "KRIC freshUntil");
  const ledgerFreshUntil = requiredUtcInstant(ledger.freshnessExpiresAt, "KRIC ledger freshness");
  const storedAt = requiredUtcInstant(receipt.storedAt, "KRIC receipt storedAt");
  if (capturedAt > observedAt || capturedAt > storedAt || storedAt > observedAtMillis
    || observedAt > observedAtMillis || freshUntil <= observedAtMillis
    || ledgerFreshUntil <= observedAtMillis || requiredUtcInstant(ledger.rawRetentionExpiresAt, "KRIC raw retention") <= observedAtMillis
    || typeof ledger.rawObjectUri !== "string" || ledger.rawObjectUri.trim() === ""
    || !sha(ledger.governancePolicySha256) || typeof ledger.governancePolicyVersion !== "string" || ledger.governancePolicyVersion === "") {
    throw new Error("KRIC source time or governance mismatch");
  }
  return {
    candidateId: candidateBuildSpec.candidateId,
    sourceSnapshotSetHash: candidateBuildSpec.sourceSnapshotSetHash,
    sourceIdentity: {
      sourceId: SOURCE_ID,
      snapshotId: snapshot.snapshotId,
      snapshotPath: expectedPath,
      rawSha256: snapshot.rawSha256,
      redactedRequestFingerprint: snapshot.redactedRequestFingerprint,
      contentSha256: snapshot.contentSha256,
      schemaFingerprint: snapshot.schemaFingerprint,
      snapshotFileSha256,
      capturedAt: snapshot.capturedAt,
      observedAt: snapshot.observedAt,
      freshUntil: snapshot.freshUntil,
      rawObjectUri: ledger.rawObjectUri,
      rawObjectSha256: ledger.rawSha256,
      credentialRedacted: true,
      licenseEvidenceHash: evidence.licenseEvidenceHash,
    },
  };
}

function validateQueryCoverage(snapshot, mappings) {
  const expected = new Set(mappings.map(mappingKey));
  const queries = new Map((snapshot.queries ?? []).map((query) => [queryKey(query), query]));
  if (snapshot.queryCount !== 213 || snapshot.queries?.length !== 213 || queries.size !== 213
    || expected.size !== 213 || [...expected].some((key) => !queries.has(key))) {
    throw new Error("capital FACILITY snapshot tuple coverage mismatch");
  }
  return queries;
}

function queryFacilityTypes(query) {
  const present = new Set();
  for (const row of query.rows ?? []) {
    if (!FACILITY_TYPES.has(row.gubun) && !AUXILIARY_CODES.has(row.gubun)) {
      throw new Error("unknown KRIC facility code");
    }
    if (FACILITY_TYPES.has(row.gubun)) present.add(FACILITY_TYPES.get(row.gubun));
  }
  return present;
}

function validateRenderedAdmission(value) {
  assertExactKeys(value, OUTPUT_KEYS, "capital FACILITY admission output");
  if (value.schemaVersion !== 1 || value.artifactKind !== "current-capital-facility-source-admission"
    || value.decision !== "GO" || new Date(requiredUtcInstant(value.observedAt, "observedAt")).toISOString() !== value.observedAt) {
    throw new Error("capital FACILITY admission schema mismatch");
  }
  assertExactKeys(value.candidate, ["candidateId", "sourceSnapshotSetHash"], "capital FACILITY candidate");
  if (typeof value.candidate.candidateId !== "string" || value.candidate.candidateId === "" || !sha(value.candidate.sourceSnapshotSetHash)) {
    throw new Error("capital FACILITY candidate schema mismatch");
  }
  const sourceKeys = ["sourceId", "snapshotId", "snapshotPath", "rawSha256", "redactedRequestFingerprint", "contentSha256", "schemaFingerprint", "snapshotFileSha256", "capturedAt", "observedAt", "freshUntil", "rawObjectUri", "rawObjectSha256", "credentialRedacted", "licenseEvidenceHash"];
  assertExactKeys(value.sourceIdentity, sourceKeys, "capital FACILITY source identity");
  if (value.sourceIdentity.sourceId !== SOURCE_ID || value.sourceIdentity.credentialRedacted !== true
    || ![value.sourceIdentity.rawSha256, value.sourceIdentity.redactedRequestFingerprint, value.sourceIdentity.contentSha256, value.sourceIdentity.schemaFingerprint, value.sourceIdentity.snapshotFileSha256, value.sourceIdentity.rawObjectSha256, value.sourceIdentity.licenseEvidenceHash].every(sha)
    || ![value.sourceIdentity.snapshotId, value.sourceIdentity.snapshotPath, value.sourceIdentity.rawObjectUri].every((entry) => typeof entry === "string" && entry.trim() !== "")
    || ["capturedAt", "observedAt", "freshUntil"].some((key) => new Date(requiredUtcInstant(value.sourceIdentity[key], `source identity ${key}`)).toISOString() !== value.sourceIdentity[key])) {
    throw new Error("capital FACILITY source identity schema mismatch");
  }
  const capturedAt = requiredUtcInstant(value.sourceIdentity.capturedAt, "source identity capturedAt");
  const sourceObservedAt = requiredUtcInstant(value.sourceIdentity.observedAt, "source identity observedAt");
  const admissionObservedAt = requiredUtcInstant(value.observedAt, "observedAt");
  const freshUntil = requiredUtcInstant(value.sourceIdentity.freshUntil, "source identity freshUntil");
  if (capturedAt > sourceObservedAt || sourceObservedAt > admissionObservedAt || admissionObservedAt >= freshUntil
    || value.sourceIdentity.snapshotPath !== `tools/datapack/sources/${value.sourceIdentity.snapshotId}.json`) {
    throw new Error("capital FACILITY source identity time or path mismatch");
  }
  const rowKey = (row) => `${row.stationId}\0${row.lineId}`;
  if (!Array.isArray(value.denominatorRows) || value.denominatorRows.length !== 639
    || !Array.isArray(value.cells) || value.cells.length !== 213 || !Array.isArray(value.materializerEvidenceRows) || value.materializerEvidenceRows.length !== 213
    || new Set(value.cells.map(rowKey)).size !== 213 || new Set(value.cells.map(({ stationId }) => stationId)).size !== 199) {
    throw new Error("capital FACILITY admission matrix mismatch");
  }
  for (let index = 0; index < value.cells.length; index += 1) {
    const cell = value.cells[index];
    const evidence = value.materializerEvidenceRows[index];
    assertExactKeys(cell, ["stationId", "lineId", "state", "sourceId", "snapshotId"], "capital FACILITY cell");
    assertExactKeys(evidence, ["stationId", "lineId", "state", "sourceId", "snapshotId", "evidenceState"], "capital FACILITY materializer evidence");
    if (!rowEqual(cell, evidence, ["stationId", "lineId", "state", "sourceId", "snapshotId"])
      || evidence.evidenceState !== (cell.state === "ADMITTED_FACILITY_PRESENT" ? "VERIFIED_PRESENT" : "VERIFIED_ABSENT")) {
      throw new Error("capital FACILITY materializer evidence mismatch");
    }
    if (cell.sourceId !== value.sourceIdentity.sourceId || cell.snapshotId !== value.sourceIdentity.snapshotId
      || evidence.sourceId !== value.sourceIdentity.sourceId || evidence.snapshotId !== value.sourceIdentity.snapshotId) {
      throw new Error("capital FACILITY row provenance mismatch");
    }
    const rows = value.denominatorRows.slice(index * TYPES.length, (index + 1) * TYPES.length);
    if (rows.length !== 3 || !rowEqual(cell, rows[0], ["stationId", "lineId", "sourceId", "snapshotId"]) || rows.some((row, typeIndex) => {
      assertExactKeys(row, ["stationId", "lineId", "facilityType", "state", "sourceId", "snapshotId"], "capital FACILITY denominator row");
      return row.facilityType !== TYPES[typeIndex] || !["VERIFIED_PRESENT", "VERIFIED_ABSENT"].includes(row.state)
        || !rowEqual(cell, row, ["stationId", "lineId", "sourceId", "snapshotId"])
        || row.sourceId !== value.sourceIdentity.sourceId || row.snapshotId !== value.sourceIdentity.snapshotId;
    })) {
      throw new Error("capital FACILITY denominator ordering mismatch");
    }
    const expectedCell = rows.some(({ state }) => state === "VERIFIED_PRESENT") ? "ADMITTED_FACILITY_PRESENT" : "ADMITTED_FACILITY_ABSENT";
    if (cell.state !== expectedCell) throw new Error("capital FACILITY cell state mismatch");
    if (index > 0 && compareStationLine(value.cells[index - 1], cell) >= 0) {
      throw new Error("capital FACILITY cell ordering mismatch");
    }
  }
  assertExactKeys(value.denominatorStateSummary, ["VERIFIED_PRESENT", "VERIFIED_ABSENT"], "capital FACILITY denominator summary");
  assertExactKeys(value.cellStateSummary, ["ADMITTED_FACILITY_PRESENT", "ADMITTED_FACILITY_ABSENT"], "capital FACILITY cell summary");
  if (canonicalJson(value.denominatorStateSummary) !== canonicalJson(summarize(value.denominatorRows, ["VERIFIED_PRESENT", "VERIFIED_ABSENT"]))
    || canonicalJson(value.cellStateSummary) !== canonicalJson(summarize(value.cells, ["ADMITTED_FACILITY_PRESENT", "ADMITTED_FACILITY_ABSENT"]))
    || !sha(value.stationLineProviderMappingSha256)) {
    throw new Error("capital FACILITY admission summary mismatch");
  }
  const { admissionDigest, ...payload } = value;
  if (!sha(admissionDigest) || sha256(canonicalJson(payload)) !== admissionDigest) {
    throw new Error("capital FACILITY admission digest mismatch");
  }
}

function mappingKey(value) { return [value.stationId, value.lineId, value.providerOperatorId, value.providerLineId, value.providerStationId].join("\0"); }
function queryKey(value) { return [value.stationId, value.lineId, value.railOprIsttCd, value.lnCd, value.stinCd].join("\0"); }
function summarize(rows, states) { return Object.fromEntries(states.map((state) => [state, rows.filter((row) => row.state === state).length])); }
function exactlyOne(values, predicate, label) { const matches = values.filter(predicate); if (matches.length !== 1) throw new Error(`${label} must be exactly one`); return matches[0]; }
function assertExactKeys(value, keys, label) { if (!value || typeof value !== "object" || Array.isArray(value) || canonicalJson(Object.keys(value).sort(compare)) !== canonicalJson([...keys].sort(compare))) throw new Error(`${label} keys mismatch`); }
function rowEqual(left, right, keys) { return keys.every((key) => left[key] === right[key]); }
function compareStationLine(left, right) { return compare(left.stationId, right.stationId) || compare(left.lineId, right.lineId); }
function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function sha(value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function requireBytes(value, label) { if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) throw new Error(`${label} bytes are invalid`); return Buffer.from(value); }
function parse(bytes, label) { try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} is invalid JSON`); } }
