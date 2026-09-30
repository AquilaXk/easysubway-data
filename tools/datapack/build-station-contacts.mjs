import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { buildStationBindings, numeric } from "./normalize-seoul-metro-congestion.mjs";
import { codepointCompare } from "../lib/codepoint-compare.mjs";

export const STATION_CONTACT_SOURCE_ID = "seoul-metro-station-contact";
export const STATION_CONTACT_INPUTS_PATH = "tools/datapack/release/station-contact-inputs.json";
export const PRODUCTION_USE_SCOPE = "MOBILE_STATION_CATALOG_CONTACT";

const PHONE_PATTERN = /^0\d{1,2}-\d{3,4}-\d{4}$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizePhoneNumber(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/[^0-9-]/g, "");
  if (!PHONE_PATTERN.test(cleaned)) return null;
  return cleaned;
}

// stationBindings: "<호선 번호>:<역번호 숫자>" → { stationId, lineId }
// (서울교통공사 역코드 membership 결속, #842·#844와 같은 규칙. 이름 조인 없음)
export function buildStationContacts({ snapshot, stationBindings } = {}) {
  if (!snapshot || snapshot.sourceId !== STATION_CONTACT_SOURCE_ID || !Array.isArray(snapshot.rows)) {
    throw new Error("station contact snapshot identity mismatch");
  }
  if (typeof snapshot.snapshotId !== "string" || snapshot.snapshotId === "") {
    throw new Error("station contact snapshotId is required");
  }
  if (!(stationBindings instanceof Map) || stationBindings.size === 0) {
    throw new Error("station code bindings are required");
  }

  const snapshotId = snapshot.snapshotId;
  const rowsByKey = new Map();
  const exclusions = [];
  let duplicateIdenticalCount = 0;

  for (const rawRow of snapshot.rows) {
    const phoneRaw = typeof rawRow.phone === "string" ? rawRow.phone : "";
    const normalizedPhone = normalizePhoneNumber(phoneRaw);
    if (!normalizedPhone) {
      exclusions.push({ reason: "INVALID_PHONE_FORMAT", row: rawRow });
      continue;
    }

    const line = numeric(rawRow.line);
    const stationCode = numeric(rawRow.stnNo);
    if (!line || !stationCode) {
      exclusions.push({ reason: "INVALID_LINE_OR_STATION_CODE", row: rawRow });
      continue;
    }

    const binding = stationBindings.get(`${line}:${stationCode}`);
    if (!binding) {
      exclusions.push({ reason: "MAPPING_NOT_FOUND", row: rawRow });
      continue;
    }

    const row = {
      station_id: binding.stationId,
      line_id: binding.lineId,
      phone: normalizedPhone,
      phone_raw: phoneRaw.trim(),
      source_snapshot_id: snapshotId,
    };
    const key = `${row.station_id}\0${row.line_id}`;
    const existing = rowsByKey.get(key);
    if (existing) {
      if (existing.phone !== row.phone) {
        throw new Error(`conflicting station contact numbers for ${row.station_id} ${row.line_id}`);
      }
      duplicateIdenticalCount += 1;
      continue;
    }
    rowsByKey.set(key, row);
  }

  const rows = [...rowsByKey.values()].sort((left, right) =>
    codepointCompare(`${left.station_id}\0${left.line_id}`, `${right.station_id}\0${right.line_id}`)
  );

  const report = generateCoverageReport({ rows, exclusions, snapshot, duplicateIdenticalCount });

  return {
    rows,
    exclusions,
    report,
  };
}

// 운영 팩(stations·stationLines)의 역·노선에 역코드 membership으로 결속해 행을 만든다.
export function bindStationContacts({ snapshot, membership, pack } = {}) {
  return buildStationContacts({ snapshot, stationBindings: buildStationBindings({ membership, pack }) });
}

function generateCoverageReport({ rows, exclusions, snapshot, duplicateIdenticalCount }) {
  const totalRaw = snapshot?.rows?.length ?? 0;
  const validCount = rows.length;
  const exclusionsByReason = {};
  for (const item of exclusions) {
    exclusionsByReason[item.reason] = (exclusionsByReason[item.reason] ?? 0) + 1;
  }

  const stationIds = new Set(rows.map((r) => r.station_id));
  const lineIds = new Set(rows.map((r) => r.line_id));

  return {
    snapshotId: snapshot.snapshotId,
    totalRawRows: totalRaw,
    validRowsLoaded: validCount,
    excludedRowsTotal: exclusions.length,
    duplicateIdenticalCount,
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

  // 서울교통공사 역코드 membership(#842·#844와 같은 승인 원천)
  const membershipPath = manifest.stationCodeMembership?.snapshotPath;
  let membershipBytes;
  try {
    membershipBytes = await readFile(path.join(root, membershipPath));
  } catch (error) {
    throw new Error(`station code membership is missing: ${membershipPath}`, { cause: error });
  }
  if (sha256(membershipBytes) !== manifest.stationCodeMembership.snapshotSha256) {
    throw new Error("station code membership sha256 mismatch");
  }
  const membership = JSON.parse(membershipBytes.toString("utf8"));

  return { snapshot, membership };
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
