import { createHash } from "node:crypto";

import { codepointCompare } from "../lib/codepoint-compare.mjs";
import { projectKricStationLineMembership } from "./project-kric-station-line-membership.mjs";
const SOURCE_ID = "kric-current-station-line-file";
const RECEIPT_KIND = "kric-current-station-line-file-receipt";

/**
 * Evaluates whether a fresh #455 operation has supplied every input required to
 * begin admission. This is deliberately a preflight: it never returns ADMITTED
 * and does not create, publish, or register an admission artifact.
 */
export function buildKricNationwideRouteRosterAdmissionContract({
  workbookBytes,
  receipt,
  denominator,
  projection,
} = {}) {
  const bytes = Buffer.from(workbookBytes ?? []);
  const expected = projectKricStationLineMembership({ workbookBytes: bytes, denominator });
  if (!hasCurrentStationLineReceipt(receipt, bytes)) {
    throw new Error("KRIC_STATION_LINE_RECEIPT_MISMATCH");
  }
  if (!sameJson(projection, expected)) throw new Error("KRIC_STATION_LINE_PROJECTION_MISMATCH");
  return Object.freeze({
    schemaVersion: 1,
    artifactKind: "kric-nationwide-route-roster-admission-contract",
    status: "PENDING",
    decision: "CONTRACT_GAP",
    sourceId: SOURCE_ID,
    recordCount: expected.records.length,
    projectionSha256: expected.recordsSha256,
    gaps: [Object.freeze({ code: "CROSSWALK_NOT_ADMITTED", status: "PENDING", decision: "CONTRACT_GAP" })],
  });
}

function hasCurrentStationLineReceipt(receipt, bytes) {
  if (receipt?.schemaVersion !== 1 || receipt.artifactKind !== RECEIPT_KIND || receipt.sourceId !== SOURCE_ID
    || receipt.byteLength !== bytes.length || receipt.sha256 !== sha256(bytes) || receipt.credentialRedacted !== true
    || typeof receipt.rawFile !== "string" || !/^kric-current-station-line-file-[^/]+\.xlsx$/u.test(receipt.rawFile)
    || typeof receipt.capturedAt !== "string") return false;
  const capturedAt = new Date(receipt.capturedAt);
  return Number.isFinite(capturedAt.getTime()) && capturedAt.toISOString() === receipt.capturedAt;
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value != null && typeof value === "object") {
    const properties = Object.keys(value).sort(compareCanonicalJsonKeys)
      .map((key) => canonicalJsonProperty(key, value[key])).join(",");
    return `{${properties}}`;
  }
  return JSON.stringify(value);
}

function compareCanonicalJsonKeys(left, right) {
  return codepointCompare(left, right);
}

function canonicalJsonProperty(key, value) {
  return `${JSON.stringify(key)}:${canonicalJson(value)}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
