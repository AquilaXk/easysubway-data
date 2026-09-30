import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "./lib/manifest-validation.mjs";
import { canonicalMappingsFromConvenienceSnapshot } from "./build-station-elevator-paths.mjs";

export const PLATFORM_GAP_SOURCE_ID = "seoul-metro-platform-gap";
export const MAPPING_SOURCE_ID = "kric-station-convenience-standard";
export const STATION_PLATFORM_GAP_INPUTS_PATH = "tools/datapack/release/station-platform-gap-inputs.json";
export const PRODUCTION_USE_SCOPE = "SERVER_ROUTE_BUNDLE_PLATFORM_GAP";

const SEOUL_METRO_OPERATOR_CODE = "S1";
const SEOUL_METRO_LINE_NAME = /^([1-9])호선$/u;
const CAR_DOOR_PATTERN = /(?:^|\s)(\d+)-(\d+)$/u;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseIntegerMm(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (str === "") return null;

  // Handle explicit units: cm or mm
  const cmMatch = /^(\d+(?:\.\d+)?)\s*cm$/iu.exec(str);
  if (cmMatch) {
    const num = Number(cmMatch[1]);
    if (!Number.isFinite(num) || num < 0) return null;
    return Math.round(num * 10);
  }
  const mmMatch = /^(\d+(?:\.\d+)?)\s*mm$/iu.exec(str);
  if (mmMatch) {
    const num = Number(mmMatch[1]);
    if (!Number.isFinite(num) || num < 0) return null;
    return Math.round(num);
  }

  // Handle plain numeric string (must be non-negative)
  if (!/^\d+(?:\.\d+)?$/u.test(str)) return null;
  const num = Number(str);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num);
}

export function parsePlatformPosition(value) {
  if (typeof value !== "string") return { position: "", carNumber: null, doorNumber: null };
  const position = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const match = CAR_DOOR_PATTERN.exec(position);
  if (!match) {
    return { position, carNumber: null, doorNumber: null };
  }
  return {
    position,
    carNumber: parseInt(match[1], 10),
    doorNumber: parseInt(match[2], 10),
  };
}

export function buildStationPlatformGaps({ snapshot, canonicalMappings } = {}) {
  if (!snapshot || snapshot.sourceId !== PLATFORM_GAP_SOURCE_ID || !Array.isArray(snapshot.rows)) {
    throw new Error("platform gap snapshot identity mismatch");
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
    const lineName = rawRow.LINE ?? "";
    const lineMatch = SEOUL_METRO_LINE_NAME.exec(lineName);
    const lineCode = lineMatch ? lineMatch[1] : null;

    const rawStnCd = rawRow.SBWY_STNS_CD ?? rawRow.SBWY_STNS_OTSD_CD;
    const stnCd = rawStnCd ? String(rawStnCd).padStart(4, "0") : null;

    if (!lineCode || !stnCd) {
      exclusions.push({ reason: "INVALID_LINE_OR_STATION_CODE", row: rawRow });
      continue;
    }

    const mapping = seoulMappingByCode.get(`${lineCode}\0${stnCd}`);
    if (!mapping) {
      exclusions.push({ reason: "MAPPING_NOT_FOUND", row: rawRow });
      continue;
    }

    let direction;
    if (rawRow.UPLN_DNLN === "상선") {
      direction = "UP";
    } else if (rawRow.UPLN_DNLN === "하선") {
      direction = "DOWN";
    } else {
      exclusions.push({ reason: "INVALID_DIRECTION", row: rawRow });
      continue;
    }

    const gapMm = parseIntegerMm(rawRow.TRN_PLF_INTVL);
    const heightDiffMm = parseIntegerMm(rawRow.HGT_DIFF);
    if (gapMm === null || heightDiffMm === null) {
      exclusions.push({ reason: "NON_NUMERIC_MEASUREMENT", row: rawRow });
      continue;
    }

    const { position, carNumber, doorNumber } = parsePlatformPosition(rawRow.PLF_PSTN);
    const id = `gap:${mapping.stationId}:${mapping.lineId}:${direction}:${position}`;

    rows.push({
      id,
      station_id: mapping.stationId,
      line_id: mapping.lineId,
      direction,
      platform_position: position,
      car_number: carNumber,
      door_number: doorNumber,
      gap_mm: gapMm,
      height_diff_mm: heightDiffMm,
      source_snapshot_id: snapshotId,
    });
  }

  // Deduplicate by ID if needed (preserving deterministic order)
  const uniqueRows = [];
  const seenIds = new Set();
  for (const r of rows) {
    if (!seenIds.has(r.id)) {
      seenIds.add(r.id);
      uniqueRows.push(r);
    }
  }

  const report = generateCoverageReport({ rows: uniqueRows, exclusions, snapshot });

  return {
    rows: uniqueRows,
    exclusions,
    report,
  };
}

export function generateCoverageReport({ rows, exclusions, snapshot } = {}) {
  const totalRaw = snapshot?.rowCount ?? (rows.length + exclusions.length);
  const validCount = rows.length;

  const exclusionsByReason = {};
  for (const exc of exclusions) {
    exclusionsByReason[exc.reason] = (exclusionsByReason[exc.reason] ?? 0) + 1;
  }

  const stationLineCounts = {};
  let maxGap = 0;
  const gapDistribution = {
    under50mm: 0,
    between50and100mm: 0,
    over100mm: 0,
  };

  for (const r of rows) {
    const key = `${r.line_id}:${r.station_id}`;
    stationLineCounts[key] = (stationLineCounts[key] ?? 0) + 1;
    if (r.gap_mm > maxGap) maxGap = r.gap_mm;
    if (r.gap_mm < 50) gapDistribution.under50mm += 1;
    else if (r.gap_mm <= 100) gapDistribution.between50and100mm += 1;
    else gapDistribution.over100mm += 1;
  }

  return {
    snapshotId: snapshot?.snapshotId ?? "unknown",
    totalRawRows: totalRaw,
    validRowsLoaded: validCount,
    excludedRowsTotal: exclusions.length,
    exclusionsByReason,
    stationLineCount: Object.keys(stationLineCounts).length,
    maxGapMm: maxGap,
    gapDistribution,
  };
}

export async function loadStationPlatformGapInputs({ repositoryRoot } = {}) {
  if (typeof repositoryRoot !== "string" || repositoryRoot === "") {
    throw new Error("repository root is required");
  }
  const root = path.resolve(repositoryRoot);

  const manifestPath = path.join(root, STATION_PLATFORM_GAP_INPUTS_PATH);
  let manifestBytes;
  try {
    manifestBytes = await readFile(manifestPath);
  } catch (error) {
    throw new Error(`platform gap inputs is missing: ${STATION_PLATFORM_GAP_INPUTS_PATH}`, { cause: error });
  }

  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.schemaVersion !== 1 || manifest.artifactKind !== "station-platform-gap-inputs" || manifest.issue !== 837) {
    throw new Error("station platform gap inputs identity mismatch");
  }

  // Candidates admission check
  const candidatesPath = path.join(root, "tools/datapack/source-candidates.json");
  const candidatesBytes = await readFile(candidatesPath);
  const candidates = JSON.parse(candidatesBytes.toString("utf8"));
  assertProductionUseAdmission(candidates, PLATFORM_GAP_SOURCE_ID);

  // Platform gap raw collection verification
  const rawPath = path.join(root, manifest.platformGap.rawCollectionPath);
  let rawBytes;
  try {
    rawBytes = await readFile(rawPath);
  } catch (error) {
    throw new Error(`raw collection is missing: ${manifest.platformGap.rawCollectionPath}`, { cause: error });
  }
  const rawSha256 = sha256(rawBytes);
  if (rawSha256 !== manifest.platformGap.rawCollectionSha256) {
    throw new Error("platform gap raw collection sha256 mismatch");
  }

  // Platform gap snapshot
  const snapshotPath = path.join(root, manifest.platformGap.snapshotPath);
  let snapshotBytes;
  try {
    snapshotBytes = await readFile(snapshotPath);
  } catch (error) {
    throw new Error(`snapshot is missing: ${manifest.platformGap.snapshotPath}`, { cause: error });
  }

  const snapshotSha256 = sha256(snapshotBytes);
  if (snapshotSha256 !== manifest.platformGap.snapshotSha256) {
    throw new Error("platform gap snapshot sha256 mismatch");
  }
  const snapshot = JSON.parse(snapshotBytes.toString("utf8"));
  if (snapshot.rawSha256 !== manifest.platformGap.rawCollectionSha256) {
    throw new Error("platform gap snapshot rawSha256 mismatch");
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

  return buildStationPlatformGaps({ snapshot, canonicalMappings });
}

function assertProductionUseAdmission(candidatesDocument, sourceId) {
  const matches = (candidatesDocument?.candidates ?? []).filter(({ id }) => id === sourceId);
  const admission = matches[0]?.evidence?.productionUseAdmission;
  if (
    matches.length !== 1
    || matches[0].capabilities?.facility?.productionUseAllowed !== true
    || admission?.decision !== "APPROVED"
    || admission.productionUseAllowed !== true
    || admission.scope !== PRODUCTION_USE_SCOPE
  ) {
    throw new Error(`source is not admitted for platform gaps: ${sourceId}`);
  }
}
