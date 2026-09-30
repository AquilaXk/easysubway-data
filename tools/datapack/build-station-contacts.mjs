import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "./lib/manifest-validation.mjs";
import { canonicalMappingsFromConvenienceSnapshot } from "./build-station-elevator-paths.mjs";
import { codepointCompare } from "../lib/codepoint-compare.mjs";

export const STATION_CONTACT_SOURCE_ID = "seoul-metro-station-contact";
export const MAPPING_SOURCE_ID = "kric-station-convenience-standard";
export const STATION_CONTACT_INPUTS_PATH = "tools/datapack/release/station-contact-inputs.json";
export const PRODUCTION_USE_SCOPE = "MOBILE_STATION_CATALOG_CONTACT";

const SEOUL_METRO_OPERATOR_CODE = "S1";
const PHONE_PATTERN = /^0\d{1,2}-\d{3,4}-\d{4}$/;
const LINE_DIGIT_PATTERN = /([1-9])/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizePhoneNumber(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/[^0-9-]/g, "");
  if (!PHONE_PATTERN.test(cleaned)) return null;
  return cleaned;
}

export function buildStationContacts({ snapshot, canonicalMappings } = {}) {
  if (!snapshot || snapshot.sourceId !== STATION_CONTACT_SOURCE_ID || !Array.isArray(snapshot.rows)) {
    throw new Error("station contact snapshot identity mismatch");
  }
  if (!Array.isArray(canonicalMappings) || canonicalMappings.length === 0) {
    throw new Error("canonical mappings are required");
  }

  // Canonical mappings index for Seoul Metro (S1)
  const seoulMappingByCode = new Map();
  for (const query of canonicalMappings) {
    if (query.railOprIsttCd === SEOUL_METRO_OPERATOR_CODE && query.lnCd && query.stinCd) {
      const code = String(query.stinCd).padStart(4, "0");
      seoulMappingByCode.set(`${query.lnCd}\0${code}`, query);
    }
  }

  const rows = [];
  const exclusions = [];
  const snapshotId = snapshot.snapshotId ?? "unknown";

  for (const rawRow of snapshot.rows) {
    const phoneRaw = rawRow.phone ?? "";
    const normalizedPhone = normalizePhoneNumber(phoneRaw);
    if (!normalizedPhone) {
      exclusions.push({ reason: "INVALID_PHONE_FORMAT", row: rawRow });
      continue;
    }

    const lineMatch = LINE_DIGIT_PATTERN.exec(rawRow.line ?? "");
    const lineCode = lineMatch ? lineMatch[1] : null;
    const rawStnNo = rawRow.stnNo ?? "";
    const stnCd = rawStnNo ? String(rawStnNo).trim().padStart(4, "0") : null;

    if (!lineCode || !stnCd) {
      exclusions.push({ reason: "INVALID_LINE_OR_STATION_CODE", row: rawRow });
      continue;
    }

    const mapping = seoulMappingByCode.get(`${lineCode}\0${stnCd}`);
    if (!mapping) {
      exclusions.push({ reason: "MAPPING_NOT_FOUND", row: rawRow });
      continue;
    }

    rows.push({
      station_id: mapping.stationId,
      line_id: mapping.lineId,
      phone: normalizedPhone,
      phone_raw: phoneRaw.trim(),
      source_snapshot_id: snapshotId,
    });
  }

  // Deduplicate by (station_id, line_id) preserving deterministic order
  const uniqueRows = [];
  const seenKeys = new Set();
  for (const r of rows) {
    const key = `${r.station_id}\0${r.line_id}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      uniqueRows.push(r);
    }
  }

  uniqueRows.sort((left, right) =>
    codepointCompare(`${left.station_id}\0${left.line_id}`, `${right.station_id}\0${right.line_id}`)
  );

  const report = generateCoverageReport({ rows: uniqueRows, exclusions, snapshot });

  return {
    rows: uniqueRows,
    exclusions,
    report,
  };
}

function generateCoverageReport({ rows, exclusions, snapshot }) {
  const totalRaw = snapshot?.rows?.length ?? 0;
  const validCount = rows.length;
  const exclusionsByReason = {};
  for (const item of exclusions) {
    exclusionsByReason[item.reason] = (exclusionsByReason[item.reason] ?? 0) + 1;
  }

  const stationIds = new Set(rows.map((r) => r.station_id));
  const lineIds = new Set(rows.map((r) => r.line_id));

  return {
    snapshotId: snapshot?.snapshotId ?? "unknown",
    totalRawRows: totalRaw,
    validRowsLoaded: validCount,
    excludedRowsTotal: exclusions.length,
    exclusionsByReason,
    uniqueStationCount: stationIds.size,
    uniqueLineCount: lineIds.size,
  };
}

export async function loadStationContactInputs({ repositoryRoot } = {}) {
  if (typeof repositoryRoot !== "string" || repositoryRoot === "") {
    throw new Error("repository root is required");
  }
  const root = path.resolve(repositoryRoot);

  const manifestPath = path.join(root, STATION_CONTACT_INPUTS_PATH);
  let manifestBytes;
  try {
    manifestBytes = await readFile(manifestPath);
  } catch (error) {
    throw new Error(`station contact inputs is missing: ${STATION_CONTACT_INPUTS_PATH}`, { cause: error });
  }

  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.schemaVersion !== 1 || manifest.artifactKind !== "station-contact-inputs" || manifest.issue !== 838) {
    throw new Error("station contact inputs identity mismatch");
  }

  // Candidates admission check
  const candidatesPath = path.join(root, "tools/datapack/source-candidates.json");
  const candidatesBytes = await readFile(candidatesPath);
  const candidates = JSON.parse(candidatesBytes.toString("utf8"));
  assertProductionUseAdmission(candidates, STATION_CONTACT_SOURCE_ID);

  // Station contact raw collection verification
  const rawPath = path.join(root, manifest.stationContact.rawCollectionPath);
  let rawBytes;
  try {
    rawBytes = await readFile(rawPath);
  } catch (error) {
    throw new Error(`raw collection is missing: ${manifest.stationContact.rawCollectionPath}`, { cause: error });
  }
  const rawSha256 = sha256(rawBytes);
  if (rawSha256 !== manifest.stationContact.rawCollectionSha256) {
    throw new Error("station contact raw collection sha256 mismatch");
  }

  // Station contact snapshot
  const snapshotPath = path.join(root, manifest.stationContact.snapshotPath);
  let snapshotBytes;
  try {
    snapshotBytes = await readFile(snapshotPath);
  } catch (error) {
    throw new Error(`snapshot is missing: ${manifest.stationContact.snapshotPath}`, { cause: error });
  }

  const snapshotSha256 = sha256(snapshotBytes);
  if (snapshotSha256 !== manifest.stationContact.snapshotSha256) {
    throw new Error("station contact snapshot sha256 mismatch");
  }
  const snapshot = JSON.parse(snapshotBytes.toString("utf8"));
  if (snapshot.rawSha256 !== manifest.stationContact.rawCollectionSha256) {
    throw new Error("station contact snapshot rawSha256 mismatch");
  }

  // Canonical mapping snapshot
  const mappingPath = path.join(root, manifest.canonicalMapping.snapshotPath);
  const mappingBytes = await readFile(mappingPath);
  const mappingSha256 = sha256(mappingBytes);
  if (mappingSha256 !== manifest.canonicalMapping.snapshotSha256) {
    throw new Error("canonical mapping snapshot sha256 mismatch");
  }
  const convenienceSnapshot = JSON.parse(mappingBytes.toString("utf8"));
  const canonicalMappings = canonicalMappingsFromConvenienceSnapshot(convenienceSnapshot);

  return buildStationContacts({ snapshot, canonicalMappings });
}

function assertProductionUseAdmission(candidatesDocument, sourceId) {
  const matches = (candidatesDocument?.candidates ?? []).filter(({ id }) => id === sourceId);
  const admission = matches[0]?.evidence?.productionUseAdmission;
  if (
    matches.length !== 1
    || matches[0].capabilities?.stationInfo?.productionUseAllowed !== true
    || admission?.decision !== "APPROVED"
    || admission.productionUseAllowed !== true
    || admission.scope !== PRODUCTION_USE_SCOPE
  ) {
    throw new Error(`source is not admitted for station contacts: ${sourceId}`);
  }
}
