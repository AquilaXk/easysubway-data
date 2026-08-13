import { createHash } from "node:crypto";

import { requiredUtcInstant } from "./lib/utc-instant.mjs";

const REQUIRED_FACILITY_TYPES = ["ELEVATOR", "ESCALATOR", "WHEELCHAIR_LIFT"];
const FACILITY_TYPES = new Set([...REQUIRED_FACILITY_TYPES, "ACCESSIBILITY_STATUS_PROBE"]);
const CELL_STATES = [
  "ADMITTED_FACILITY_PATH",
  "ADMITTED_VERIFIED_ABSENCE",
  "UNKNOWN",
  "MISSING",
  "STALE",
];
const CANDIDATE_KEYS = [
  "candidateId", "stationSetSha256", "sourceSetSha256", "mappingContractVersion", "materializerVersion",
];
const SOURCE_KEYS = [
  "sourceId", "snapshotId", "sourceSetSha256", "rawSha256", "capturedAt", "freshUntil", "productionUseAllowed",
  "provenanceId", "licenseId",
];
const FACILITY_ROW_KEYS = [
  "stationId", "lineId", "facilityType", "evidenceKind", "sourceId", "sourceSnapshotId",
  "providerRecordHash", "evidenceHash", "provenanceKind", "installationStatus", "operationalStatus",
  "statusMeaning", "confidence", "verifiedAt", "retrievedAt", "strictRouteEligible",
  "strictRouteEligibleReason",
];
const OUTPUT_KEYS = [
  "schemaVersion", "artifactKind", "candidate", "sources", "cells", "materializerEvidenceRows",
  "stateSummary", "decision", "admissionDigest",
];

export function buildFacilityAccessibilityAdmission(input) {
  assertKeys(input, ["candidate", "observedAt", "stationLines", "sources", "facilityRows"], "FACILITY input keys");
  const candidate = validateCandidate(input.candidate);
  const observedAt = requiredUtcInstant(input.observedAt, "observedAt");
  const stationLines = validateStationLines(input.stationLines, candidate.stationSetSha256);
  const sources = validateSources(input.sources, candidate.sourceSetSha256);
  const sourceIndex = new Map(sources.map((source) => [sourceKey(source.sourceId, source.snapshotId), source]));
  const rows = validateFacilityRows(input.facilityRows, stationLines, sourceIndex);
  const rowsByStationLine = groupRows(rows);
  const cells = stationLines.map((stationLine) => buildCell({
    stationLine,
    rows: rowsByStationLine.get(stationAndLineKey(stationLine)) ?? [],
    sourceIndex,
    observedAt,
  }));
  const materializerEvidenceRows = cells
    .filter(({ state }) => state !== "MISSING")
    .map((cell) => materializerEvidenceRow(cell, candidate, sourceIndex));
  const stateSummary = Object.fromEntries(CELL_STATES.map((state) => [
    state, cells.filter((cell) => cell.state === state).length,
  ]));
  const decision = cells.length > 0 && cells.every(({ state }) => (
    state === "ADMITTED_FACILITY_PATH" || state === "ADMITTED_VERIFIED_ABSENCE"
  )) ? "GO" : "NO_GO";
  const payload = canonicalObject({
    schemaVersion: 1,
    artifactKind: "facility-accessibility-admission-matrix",
    candidate,
    sources,
    cells,
    materializerEvidenceRows,
    stateSummary,
    decision,
  });
  return canonicalObject({ ...payload, admissionDigest: sha256(canonicalJson(payload)) });
}

export function canonicalFacilityAccessibilityAdmissionJson(result) {
  assertKeys(result, OUTPUT_KEYS, "FACILITY admission output keys");
  const { admissionDigest, ...payload } = result;
  assertSha256(admissionDigest, "FACILITY admission digest");
  if (sha256(canonicalJson(payload)) !== admissionDigest) throw new Error("FACILITY admission digest mismatch");
  return canonicalJson(result);
}

function validateCandidate(value) {
  assertKeys(value, CANDIDATE_KEYS, "candidate identity keys");
  for (const key of CANDIDATE_KEYS) assertNonBlank(value[key], `candidate ${key}`);
  assertSha256(value.stationSetSha256, "candidate stationSetSha256");
  assertSha256(value.sourceSetSha256, "candidate sourceSetSha256");
  return canonicalObject(value);
}

function validateStationLines(value, expectedStationSetSha256) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("stationLines must be a non-empty array");
  const stationLines = value.map((row) => {
    assertKeys(row, ["stationId", "lineId", "operatorId"], "station line keys");
    for (const key of ["stationId", "lineId", "operatorId"]) assertNonBlank(row[key], `station line ${key}`);
    return canonicalObject(row);
  }).toSorted(compareStationLines);
  const seen = new Set();
  const operatorByStationLine = new Map();
  for (const row of stationLines) {
    const key = stationLineKey(row);
    if (seen.has(key)) throw new Error("duplicate canonical station line");
    seen.add(key);
    const stationLine = stationAndLineKey(row);
    const existingOperator = operatorByStationLine.get(stationLine);
    if (existingOperator && existingOperator !== row.operatorId) throw new Error("station line identity mismatch");
    operatorByStationLine.set(stationLine, row.operatorId);
  }
  const stationIds = [...new Set(stationLines.map(({ stationId }) => stationId))].toSorted(compareBytes);
  if (sha256(canonicalJson(stationIds)) !== expectedStationSetSha256) throw new Error("station set identity mismatch");
  return stationLines;
}

function validateSources(value, expectedSourceSetSha256) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("sources must be a non-empty array");
  const sources = value.map((source) => {
    assertKeys(source, SOURCE_KEYS, "FACILITY source keys");
    for (const key of ["sourceId", "snapshotId", "provenanceId", "licenseId"]) {
      assertNonBlank(source[key], `FACILITY source ${key}`);
    }
    assertSha256(source.sourceSetSha256, "FACILITY source sourceSetSha256");
    if (source.sourceSetSha256 !== expectedSourceSetSha256) throw new Error("source set identity mismatch");
    assertSha256(source.rawSha256, "FACILITY source rawSha256");
    if (typeof source.productionUseAllowed !== "boolean") {
      throw new Error("FACILITY source productionUseAllowed must be boolean");
    }
    const capturedAt = requiredUtcInstant(source.capturedAt, "FACILITY source capturedAt");
    const freshUntil = requiredUtcInstant(source.freshUntil, "FACILITY source freshUntil");
    if (freshUntil <= capturedAt) throw new Error("FACILITY source freshness interval is invalid");
    return canonicalObject({
      ...source,
      capturedAt: new Date(capturedAt).toISOString(),
      freshUntil: new Date(freshUntil).toISOString(),
    });
  }).toSorted(compareSources);
  const seen = new Set();
  for (const source of sources) {
    const key = sourceKey(source.sourceId, source.snapshotId);
    if (seen.has(key)) throw new Error("duplicate FACILITY source identity");
    seen.add(key);
  }
  return sources;
}

function validateFacilityRows(value, stationLines, sourceIndex) {
  if (!Array.isArray(value)) throw new Error("facilityRows must be an array");
  const stationLineIndex = new Set(stationLines.map(stationAndLineKey));
  const rows = value.map((row) => {
    assertKeys(row, FACILITY_ROW_KEYS, "FACILITY row keys");
    for (const key of [
      "stationId", "lineId", "facilityType", "evidenceKind", "sourceId", "sourceSnapshotId",
      "provenanceKind", "installationStatus", "operationalStatus", "statusMeaning",
      "strictRouteEligibleReason",
    ]) assertNonBlank(row[key], `FACILITY row ${key}`);
    if (!FACILITY_TYPES.has(row.facilityType)) throw new Error("unsupported FACILITY type");
    if (!new Set(["EXISTS", "NOT_EXISTS"]).has(row.evidenceKind)) throw new Error("unsupported FACILITY evidence kind");
    if (row.provenanceKind !== "OFFICIAL_SOURCE") throw new Error("FACILITY provenance mismatch");
    if (!Number.isInteger(row.confidence) || row.confidence < 0 || row.confidence > 100) {
      throw new Error("FACILITY confidence is invalid");
    }
    if (typeof row.strictRouteEligible !== "boolean") throw new Error("FACILITY strictRouteEligible must be boolean");
    assertSha256(row.providerRecordHash, "FACILITY providerRecordHash");
    assertSha256(row.evidenceHash, "FACILITY evidenceHash");
    requiredUtcInstant(row.verifiedAt, "FACILITY verifiedAt");
    requiredUtcInstant(row.retrievedAt, "FACILITY retrievedAt");
    if (!stationLineIndex.has(stationAndLineKey(row))) {
      throw new Error("unmapped facility evidence");
    }
    if (!sourceIndex.has(sourceKey(row.sourceId, row.sourceSnapshotId))) {
      throw new Error("source identity mismatch");
    }
    return canonicalObject(row);
  }).toSorted(compareFacilityRows);
  const seen = new Set();
  for (const row of rows) {
    const key = canonicalJson(row);
    if (seen.has(key)) throw new Error("duplicate FACILITY row");
    seen.add(key);
  }
  return rows;
}

function groupRows(rows) {
  const result = new Map();
  for (const row of rows) {
    const key = stationAndLineKey(row);
    const current = result.get(key) ?? [];
    current.push(row);
    result.set(key, current);
  }
  return result;
}

function buildCell({ stationLine, rows, sourceIndex, observedAt }) {
  const base = {
    stationLineId: `${stationLine.stationId}:${stationLine.lineId}`,
    stationId: stationLine.stationId,
    lineId: stationLine.lineId,
    operatorId: stationLine.operatorId,
  };
  if (rows.length === 0) {
    return canonicalObject({
      ...base,
      state: "MISSING",
      admissionReason: "FACILITY_EVIDENCE_MISSING",
      evidenceIdentity: null,
    });
  }

  const eligible = rows.filter((row) => isEligiblePresent(row));
  const admittedEligible = eligible.filter((row) => sourceIndex.get(sourceKey(
    row.sourceId, row.sourceSnapshotId,
  )).productionUseAllowed);
  const freshEligible = admittedEligible.filter((row) => isSourceUsable(
    sourceIndex.get(sourceKey(row.sourceId, row.sourceSnapshotId)), observedAt,
  ));
  if (freshEligible.length > 0) {
    return cellWithEvidence(base, "ADMITTED_FACILITY_PATH", "OFFICIAL_FACILITY_OPERATION_AVAILABLE", freshEligible);
  }
  if (admittedEligible.length > 0) {
    return cellWithEvidence(base, "STALE", "FACILITY_SOURCE_STALE", admittedEligible);
  }
  if (eligible.length > 0) {
    return cellWithEvidence(base, "UNKNOWN", "SOURCE_NOT_PRODUCTION_ADMITTED", eligible);
  }

  const requiredRows = rows.filter(({ facilityType }) => REQUIRED_FACILITY_TYPES.includes(facilityType));
  const absentRows = REQUIRED_FACILITY_TYPES.map((facilityType) => requiredRows.filter((row) => (
    row.facilityType === facilityType && isVerifiedAbsence(row)
  )));
  const exhaustiveAbsence = absentRows.every((matches) => matches.length > 0)
    && !requiredRows.some(({ installationStatus }) => installationStatus === "INSTALLED");
  if (exhaustiveAbsence) {
    const evidence = absentRows.flat();
    const sources = evidence.map((row) => sourceIndex.get(sourceKey(row.sourceId, row.sourceSnapshotId)));
    if (sources.every(({ productionUseAllowed }) => productionUseAllowed)
      && evidence.every((row) => isSourceUsable(sourceIndex.get(sourceKey(row.sourceId, row.sourceSnapshotId)), observedAt))) {
      return cellWithEvidence(
        base,
        "ADMITTED_VERIFIED_ABSENCE",
        "OFFICIAL_REQUIRED_FACILITIES_ABSENT",
        evidence,
      );
    }
    if (sources.every(({ productionUseAllowed }) => productionUseAllowed)) {
      return cellWithEvidence(base, "STALE", "FACILITY_SOURCE_STALE", evidence);
    }
    return cellWithEvidence(base, "UNKNOWN", "SOURCE_NOT_PRODUCTION_ADMITTED", evidence);
  }

  const cause = requiredRows.find(({ installationStatus }) => installationStatus === "INSTALLED") ?? rows[0];
  const source = sourceIndex.get(sourceKey(cause.sourceId, cause.sourceSnapshotId));
  if (!isSourceUsable(source, observedAt) && source.productionUseAllowed) {
    return cellWithEvidence(base, "STALE", "FACILITY_SOURCE_STALE", [cause]);
  }
  return cellWithEvidence(base, "UNKNOWN", cause.strictRouteEligibleReason, [cause]);
}

function isEligiblePresent(row) {
  if (!REQUIRED_FACILITY_TYPES.includes(row.facilityType) || !row.strictRouteEligible) return false;
  if (row.evidenceKind !== "EXISTS" || row.installationStatus !== "INSTALLED" || row.operationalStatus !== "AVAILABLE") {
    throw new Error("strict route eligible FACILITY row shape mismatch");
  }
  return true;
}

function isVerifiedAbsence(row) {
  return row.evidenceKind === "NOT_EXISTS"
    && row.installationStatus === "NOT_INSTALLED"
    && row.operationalStatus === "NOT_APPLICABLE"
    && row.statusMeaning === "EXHAUSTIVE_LIST_ABSENCE";
}

function isSourceUsable(source, observedAt) {
  return source.productionUseAllowed && requiredUtcInstant(source.freshUntil, "FACILITY source freshUntil") > observedAt;
}

function cellWithEvidence(base, state, admissionReason, rows) {
  return canonicalObject({
    ...base,
    state,
    admissionReason,
    evidenceIdentity: evidenceIdentity(rows),
  });
}

function evidenceIdentity(rows) {
  const ordered = rows.toSorted(compareFacilityRows);
  return canonicalObject({
    sourceKeys: [...new Set(ordered.map((row) => sourceKey(row.sourceId, row.sourceSnapshotId)))].toSorted(compareBytes),
    providerRecordHashes: [...new Set(ordered.map(({ providerRecordHash }) => providerRecordHash))].toSorted(compareBytes),
  });
}

function materializerEvidenceRow(cell, candidate, sourceIndex) {
  const sources = cell.evidenceIdentity.sourceKeys.map((key) => sourceIndex.get(key));
  if (sources.some((source) => !source)) throw new Error("FACILITY evidence source lookup failed");
  const identityPayload = canonicalObject({
    sources: sources.map(({ sourceId, snapshotId, rawSha256 }) => ({ sourceId, snapshotId, rawSha256 })),
    providerRecordHashes: cell.evidenceIdentity.providerRecordHashes,
  });
  const identityDigest = sha256(canonicalJson(identityPayload));
  const singleSource = sources.length === 1 ? sources[0] : null;
  const [state, evidenceKind] = cell.state === "ADMITTED_FACILITY_PATH"
    ? ["VERIFIED_PRESENT", "OBSERVED"]
    : cell.state === "ADMITTED_VERIFIED_ABSENCE"
      ? ["VERIFIED_ABSENT", "EXHAUSTIVE_LIST"]
      : ["UNKNOWN", "UNSUPPORTED"];
  return canonicalObject({
    ...candidate,
    stationId: cell.stationId,
    lineId: cell.lineId,
    operatorId: cell.operatorId,
    domain: "FACILITY",
    state,
    sourceId: singleSource?.sourceId ?? "facility-accessibility-composite",
    sourceSnapshotId: singleSource?.snapshotId ?? `facility-accessibility-composite-${identityDigest.slice(0, 16)}`,
    evidenceRawSha256: singleSource?.rawSha256 ?? sha256(canonicalJson(sources.map(({ rawSha256 }) => rawSha256))),
    providerRecordHash: cell.evidenceIdentity.providerRecordHashes.length === 1
      ? cell.evidenceIdentity.providerRecordHashes[0]
      : sha256(canonicalJson(cell.evidenceIdentity.providerRecordHashes)),
    capturedAt: sources.map(({ capturedAt }) => capturedAt).toSorted(compareBytes).at(-1),
    freshUntil: sources.map(({ freshUntil }) => freshUntil).toSorted(compareBytes)[0],
    provenanceId: singleSource?.provenanceId ?? `facility-accessibility-composite-${identityDigest}`,
    licenseId: singleSource?.licenseId ?? `facility-accessibility-composite-${identityDigest}`,
    evidenceKind,
    evidenceReason: cell.admissionReason,
  });
}

function stationLineKey(value) {
  return `${value.stationId}\0${value.lineId}\0${value.operatorId}`;
}

function stationAndLineKey(value) {
  return `${value.stationId}\0${value.lineId}`;
}

function sourceKey(sourceId, snapshotId) {
  return `${sourceId}\0${snapshotId}`;
}

function compareStationLines(left, right) {
  return compareBytes(left.stationId, right.stationId)
    || compareBytes(left.lineId, right.lineId)
    || compareBytes(left.operatorId, right.operatorId);
}

function compareSources(left, right) {
  return compareBytes(left.sourceId, right.sourceId) || compareBytes(left.snapshotId, right.snapshotId);
}

function compareFacilityRows(left, right) {
  return compareBytes(left.stationId, right.stationId)
    || compareBytes(left.lineId, right.lineId)
    || compareBytes(left.facilityType, right.facilityType)
    || compareBytes(left.sourceId, right.sourceId)
    || compareBytes(left.sourceSnapshotId, right.sourceSnapshotId)
    || compareBytes(left.providerRecordHash, right.providerRecordHash);
}

function assertKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).toSorted(compareBytes);
  const wanted = [...expected].toSorted(compareBytes);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} mismatch`);
  }
}

function assertNonBlank(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-blank string`);
}

function assertSha256(value, label) {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be sha256`);
}

function canonicalObject(value) {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).toSorted(compareBytes).map((key) => [key, canonicalObject(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalObject(value));
}

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
