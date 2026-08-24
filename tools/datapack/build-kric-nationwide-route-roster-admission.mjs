import { createHash } from "node:crypto";

import { codepointCompare } from "../lib/codepoint-compare.mjs";
import { projectKricStationLineMembership } from "./project-kric-station-line-membership.mjs";
import { parseCredentialFreeObjectUri, validateLineage } from "./source-snapshot-policy.mjs";

const SOURCE_ID = "kric-subway-route-info";
const TARGET_VERSION = "2026-07-13";
const REQUIRED_FIELDS = ["line", "station_name", "station_code"];
const EXPECTED_SCOPES = [
  ["korail", "line-051552e50435", "WS", "KR"], ["korail", "line-41a8c75ec9d8", "3", "KR"],
  ["korail", "line-472a81add377", "1", "KR"], ["korail", "line-54a7b980b7c3", "K2", "KR"],
  ["korail", "line-558d0bd8312d", "K1", "KR"], ["korail", "line-6e39be0cb6e2", "K4", "KR"],
  ["korail", "line-e4939a4b4713", "K5", "KR"], ["korail", "seoul-4", "4", "KR"],
  ["operator-c361f9fc17e9", "line-2b2d9eaa53d0", "8", "NU"], ["operator-c361f9fc17e9", "seoul-4", "4", "NU"],
  ["seoul-metro", "line-15b3b8a93259", "7", "S1"], ["seoul-metro", "line-2b2d9eaa53d0", "8", "S1"],
  ["seoul-metro", "line-3f41718e0833", "6", "S1"], ["seoul-metro", "line-41a8c75ec9d8", "3", "S1"],
  ["seoul-metro", "line-472a81add377", "1", "S1"], ["seoul-metro", "line-80fc4d5350d4", "5", "S1"],
  ["seoul-metro", "seoul-2", "2", "S1"], ["seoul-metro", "seoul-4", "4", "S1"],
].map(([operatorId, lineId, lnCd, railOprIsttCd]) => ({
  regionId: "capital", operatorId, lineId, mreaWideCd: "01", lnCd, railOprIsttCd,
}));
const CANONICAL_SCOPES = [...EXPECTED_SCOPES].sort(compareScope);
const ROUTE_ROSTER_ADMISSION_SCOPE_SHA256 = sha256(canonicalJson(CANONICAL_SCOPES));

/**
 * Evaluates whether a fresh #455 operation has supplied every input required to
 * begin admission. This is deliberately a preflight: it never returns ADMITTED
 * and does not create, publish, or register an admission artifact.
 */
export function buildKricNationwideRouteRosterAdmissionContract({
  tally,
  rosterArtifact,
  sourceInventory,
  sourceSnapshots,
  rawReceipt,
  licenseDecision,
  projection,
  now = new Date(),
} = {}) {
  const gaps = [];
  const nowMillis = utcMillis(now);
  const projected = validateTallyRosterAndProjection({ tally, rosterArtifact, projection, gaps });
  const snapshot = validateCurrentSnapshot({ sourceSnapshots, rosterArtifact, nowMillis, gaps });
  validateSourceInventory(sourceInventory, gaps);
  validateLicenseDecision({ licenseDecision, snapshot, gaps });
  validateRawReceipt({ rawReceipt, snapshot, nowMillis, gaps });

  if (gaps.length === 0 && projected != null && snapshot != null) {
    gaps.push(gap("ADMISSION_EXECUTION_REQUIRED"));
  }
  return {
    schemaVersion: 1,
    artifactKind: "kric-nationwide-route-roster-admission-contract",
    status: "PENDING",
    decision: "CONTRACT_GAP",
    sourceId: SOURCE_ID,
    targetVersion: TARGET_VERSION,
    scopeCount: CANONICAL_SCOPES.length,
    scopeSetSha256: ROUTE_ROSTER_ADMISSION_SCOPE_SHA256,
    projectionSha256: projected == null ? null : sha256(canonicalJson(projected.records)),
    gaps,
  };
}

function validateTallyRosterAndProjection({ tally, rosterArtifact, projection, gaps }) {
  let expected;
  try {
    if (tally?.targetVersion !== TARGET_VERSION) throw new Error("target version");
    expected = projectKricStationLineMembership({ tally, rosterArtifact });
  } catch {
    gaps.push(gap("TALLY_ROSTER_PROJECTION_MISMATCH"));
    return null;
  }
  if (expected.sourceId !== SOURCE_ID || expected.targetVersion !== TARGET_VERSION || expected.records.length === 0
    || !sameJson(projection, expected)) {
    gaps.push(gap("PROJECTION_TALLY_BINDING_MISMATCH"));
    return null;
  }
  return expected;
}

function validateSourceInventory(sourceInventory, gaps) {
  const matches = Array.isArray(sourceInventory?.sources)
    ? sourceInventory.sources.filter(({ id }) => id === SOURCE_ID)
    : [];
  if (matches.length !== 1) {
    gaps.push(gap("SOURCE_INVENTORY_IDENTITY_MISMATCH"));
    return;
  }
  const [source] = matches;
  if (source.productionUseAllowed !== true
    || source.coverageScope?.sourceDomains?.length !== 1
    || source.coverageScope.sourceDomains[0] !== "station_line_membership") {
    gaps.push(gap("SOURCE_INVENTORY_PRODUCTION_SCOPE_MISSING"));
  }
  if (!sameSorted(source.fieldsProvided, REQUIRED_FIELDS)) {
    gaps.push(gap("SOURCE_REQUIRED_FIELDS_INCOMPLETE"));
  }
}

function validateCurrentSnapshot({ sourceSnapshots, rosterArtifact, nowMillis, gaps }) {
  const snapshots = Array.isArray(sourceSnapshots) ? sourceSnapshots : [];
  let lineage;
  try {
    lineage = validateLineage(snapshots);
  } catch {
    gaps.push(gap("SOURCE_LINEAGE_OR_DIFF_INVALID"));
    return null;
  }
  const sourceEntries = snapshots.filter((snapshot) => snapshot?.sourceId === SOURCE_ID);
  const headId = lineage.headsBySource[SOURCE_ID];
  const snapshot = sourceEntries.find(({ snapshotId }) => snapshotId === headId);
  if (sourceEntries.length === 0 || snapshot == null || rosterArtifact?.snapshotId !== snapshot.snapshotId
    || rosterArtifact?.capturedAt == null || utcMillis(rosterArtifact.capturedAt) == null
    || utcMillis(rosterArtifact.capturedAt) > nowMillis || utcMillis(snapshot.retrievedAt) > nowMillis
    || utcMillis(snapshot.freshUntil) == null || utcMillis(snapshot.freshUntil) <= nowMillis) {
    gaps.push(gap("SNAPSHOT_NOT_CURRENT"));
    return null;
  }
  return snapshot;
}

function validateLicenseDecision({ licenseDecision, snapshot, gaps }) {
  if (snapshot == null || licenseDecision?.sourceId !== SOURCE_ID || licenseDecision.snapshotId !== snapshot.snapshotId
    || licenseDecision.snapshotRawSha256 !== snapshot.rawSha256 || !nonBlank(licenseDecision.licenseId)
    || licenseDecision.commercialUseAllowed !== true || licenseDecision.derivativeWorkAllowed !== true
    || licenseDecision.redistributionAllowed !== true || licenseDecision.quotaDecision !== "CONFIRMED"
    || licenseDecision.productionUseAllowed !== true || licenseDecision.decision !== "APPROVED") {
    gaps.push(gap("LICENSE_PRODUCTION_DECISION_MISSING"));
  }
}

function validateRawReceipt({ rawReceipt, snapshot, nowMillis, gaps }) {
  try {
    if (snapshot == null || rawReceipt?.sourceId !== SOURCE_ID || rawReceipt.snapshotId !== snapshot.snapshotId
      || rawReceipt.snapshotRawSha256 !== snapshot.rawSha256 || rawReceipt.rawObjectSha256 !== snapshot.rawSha256
      || !/^[0-9a-f]{64}$/.test(rawReceipt.rawObjectSha256 ?? "") || !Number.isInteger(rawReceipt.byteSize)
      || rawReceipt.byteSize <= 0 || utcMillis(rawReceipt.storedAt) == null
      || utcMillis(rawReceipt.rawRetentionExpiresAt) == null || utcMillis(rawReceipt.rawRetentionExpiresAt) <= nowMillis) {
      throw new Error("receipt fields");
    }
    const uri = parseCredentialFreeObjectUri(rawReceipt.rawObjectUri, "raw receipt URI");
    if (!uri.uri.startsWith("oci://") || uri.sourceAuthority !== `oci://${rawReceipt.ociNamespace}`
      || rawReceipt.rawObjectUri !== `oci://${rawReceipt.ociNamespace}/${rawReceipt.bucket}/${rawReceipt.objectKey}`) {
      throw new Error("receipt OCI binding");
    }
  } catch {
    gaps.push(gap("OCI_RAW_RECEIPT_MISMATCH"));
  }
}

function gap(code) {
  return { code, status: "PENDING", decision: "CONTRACT_GAP" };
}

function compareScope(left, right) {
  return codepointCompare(left.regionId, right.regionId)
    || codepointCompare(left.operatorId, right.operatorId)
    || codepointCompare(left.lineId, right.lineId)
    || codepointCompare(left.mreaWideCd, right.mreaWideCd)
    || codepointCompare(left.lnCd, right.lnCd)
    || codepointCompare(left.railOprIsttCd, right.railOprIsttCd);
}

function sameSorted(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && [...actual].sort(codepointCompare).every((value, index) => value === [...expected].sort(codepointCompare)[index]);
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value != null && typeof value === "object") {
    return `{${Object.keys(value).sort(codepointCompare).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function utcMillis(value) {
  const millis = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

function nonBlank(value) {
  return typeof value === "string" && value.trim() !== "";
}

export { ROUTE_ROSTER_ADMISSION_SCOPE_SHA256 };
