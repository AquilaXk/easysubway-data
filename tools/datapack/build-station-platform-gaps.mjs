import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { buildStationBindings, numeric } from "./normalize-seoul-metro-congestion.mjs";

export const PLATFORM_GAP_SOURCE_ID = "seoul-metro-platform-gap";
export const STATION_PLATFORM_GAP_INPUTS_PATH = "tools/datapack/release/station-platform-gap-inputs.json";
export const PRODUCTION_USE_SCOPE = "SERVER_ROUTE_BUNDLE_PLATFORM_GAP";

const CAR_DOOR_PATTERN = /(?:^|\s)(\d+)-(\d+)$/u;
const DIRECTIONS = new Map([["상선", "UP"], ["하선", "DOWN"]]);
const GAP_GRADES = new Map([["좁음", "NARROW"], ["보통", "NORMAL"], ["넓음", "WIDE"]]);
const HEIGHT_DIFF_GRADES = new Map([["낮음", "LOW"], ["보통", "NORMAL"], ["높음", "HIGH"]]);
const CURVED_FLAGS = new Map([["직선", 0], ["곡선", 1]]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// 승강장 위치는 원문 그대로 보존한다. 끝이 정확히 "N-M"(칸-문)일 때만 칸·문 번호를 채운다.
export function parsePlatformPosition(value) {
  if (typeof value !== "string") return { position: "", carNumber: null, doorNumber: null };
  const match = CAR_DOOR_PATTERN.exec(value);
  if (!match) return { position: value, carNumber: null, doorNumber: null };
  return { position: value, carNumber: parseInt(match[1], 10), doorNumber: parseInt(match[2], 10) };
}

function count(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

// stationBindings: "<호선 번호>:<역코드 숫자>" → { stationId, lineId } (역코드 membership 결속, 이름 조인 없음)
export function buildStationPlatformGaps({ snapshot, stationBindings } = {}) {
  if (!snapshot || snapshot.sourceId !== PLATFORM_GAP_SOURCE_ID || !Array.isArray(snapshot.rows)) {
    throw new Error("platform gap snapshot identity mismatch");
  }
  if (!(stationBindings instanceof Map)) throw new Error("stationBindings map is required");

  const snapshotId = snapshot.snapshotId ?? "unknown";
  const rows = [];
  const exclusions = [];
  const seen = new Map();
  const unmapped = new Map();

  for (const raw of snapshot.rows) {
    const exclude = (reason) => exclusions.push({ reason, row: raw });
    const direction = DIRECTIONS.get(raw.UPLN_DNLN);
    if (!direction) { exclude("UNKNOWN_DIRECTION"); continue; }
    const gapGrade = GAP_GRADES.get(raw.TRN_PLF_INTVL);
    if (!gapGrade) { exclude("UNKNOWN_GAP_GRADE"); continue; }
    const heightDiffGrade = HEIGHT_DIFF_GRADES.get(raw.HGT_DIFF);
    if (!heightDiffGrade) { exclude("UNKNOWN_HEIGHT_DIFF_GRADE"); continue; }
    const curved = CURVED_FLAGS.get(raw.PLF_LNR);
    if (curved === undefined) { exclude("UNKNOWN_PLATFORM_LINEARITY"); continue; }
    if (typeof raw.PLF_PSTN !== "string" || raw.PLF_PSTN === "") { exclude("MISSING_PLATFORM_POSITION"); continue; }

    const line = numeric(raw.LINE);
    const stationCode = numeric(raw.SBWY_STNS_CD);
    const binding = stationBindings.get(`${line}:${stationCode}`);
    if (!binding) {
      exclude("UNMAPPED_STATION");
      const key = `${line}:${stationCode}`;
      const entry = unmapped.get(key) ?? { line, stationCode: String(raw.SBWY_STNS_CD ?? ""), stationName: String(raw.SBWY_STNS_NM ?? ""), rowCount: 0 };
      entry.rowCount += 1;
      unmapped.set(key, entry);
      continue;
    }

    const { position, carNumber, doorNumber } = parsePlatformPosition(raw.PLF_PSTN);
    const built = {
      id: `gap:${binding.stationId}:${binding.lineId}:${direction}:${position}`,
      station_id: binding.stationId,
      line_id: binding.lineId,
      direction,
      platform_position: position,
      car_number: carNumber,
      door_number: doorNumber,
      gap_grade: gapGrade,
      height_diff_grade: heightDiffGrade,
      curved,
      source_snapshot_id: snapshotId,
    };
    const previous = seen.get(built.id);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(built)) {
        throw new Error(`duplicate platform gap key with conflicting values: ${built.id}`);
      }
      exclude("DUPLICATE_IDENTICAL_ROW");
      continue;
    }
    seen.set(built.id, built);
    rows.push(built);
  }

  return {
    rows,
    exclusions,
    report: generateCoverageReport({ rows, exclusions, snapshot, unmapped: [...unmapped.values()] }),
  };
}

export function generateCoverageReport({ rows, exclusions, snapshot, unmapped = [] }) {
  const exclusionsByReason = {};
  for (const exclusion of exclusions) count(exclusionsByReason, exclusion.reason);
  const gapGradeCounts = { NARROW: 0, NORMAL: 0, WIDE: 0 };
  const heightDiffGradeCounts = { LOW: 0, NORMAL: 0, HIGH: 0 };
  const curvedCounts = { 0: 0, 1: 0 };
  const rowsByLine = {};
  const stationLines = new Set();
  const stations = new Set();
  for (const row of rows) {
    gapGradeCounts[row.gap_grade] += 1;
    heightDiffGradeCounts[row.height_diff_grade] += 1;
    curvedCounts[row.curved] += 1;
    count(rowsByLine, row.line_id);
    stationLines.add(`${row.station_id}|${row.line_id}`);
    stations.add(row.station_id);
  }
  const sortedRowsByLine = Object.fromEntries(Object.entries(rowsByLine).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return {
    snapshotId: snapshot?.snapshotId ?? "unknown",
    totalRawRows: snapshot?.rows?.length ?? rows.length + exclusions.length,
    validRowsLoaded: rows.length,
    excludedRowsTotal: exclusions.length,
    exclusionsByReason,
    gapGradeCounts,
    heightDiffGradeCounts,
    curvedCounts,
    stationCount: stations.size,
    stationLineCount: stationLines.size,
    rowsByLine: sortedRowsByLine,
    unmappedStationCount: unmapped.length,
    unmappedStations: unmapped,
  };
}

// 운영 팩(stations·stationLines)의 역·노선에 역코드 membership으로 결속해 행을 만든다.
export function bindStationPlatformGaps({ snapshot, membership, pack } = {}) {
  return buildStationPlatformGaps({ snapshot, stationBindings: buildStationBindings({ membership, pack }) });
}

async function readRequired(root, relative, missingMessage) {
  try {
    return await readFile(path.join(root, relative));
  } catch (error) {
    throw new Error(`${missingMessage}: ${relative}`, { cause: error });
  }
}

export async function loadStationPlatformGapInputs({ repositoryRoot } = {}) {
  if (typeof repositoryRoot !== "string" || repositoryRoot === "") throw new Error("repository root is required");
  const root = path.resolve(repositoryRoot);

  const manifest = JSON.parse((await readRequired(root, STATION_PLATFORM_GAP_INPUTS_PATH, "platform gap inputs is missing")).toString("utf8"));
  if (manifest.schemaVersion !== 1 || manifest.artifactKind !== "station-platform-gap-inputs" || manifest.issue !== 837) {
    throw new Error("station platform gap inputs identity mismatch");
  }

  const rawBytes = await readRequired(root, manifest.platformGap.rawCollectionPath, "raw collection is missing");
  if (sha256(rawBytes) !== manifest.platformGap.rawCollectionSha256) throw new Error("platform gap raw collection sha256 mismatch");
  const snapshotBytes = await readRequired(root, manifest.platformGap.snapshotPath, "snapshot is missing");
  if (sha256(snapshotBytes) !== manifest.platformGap.snapshotSha256) throw new Error("platform gap snapshot sha256 mismatch");
  const snapshot = JSON.parse(snapshotBytes.toString("utf8"));
  if (snapshot.rawSha256 !== manifest.platformGap.rawCollectionSha256) throw new Error("platform gap snapshot rawSha256 mismatch");

  const candidates = JSON.parse(await readFile(path.join(root, "tools/datapack/source-candidates.json"), "utf8"));
  assertProductionUseAdmission(candidates, PLATFORM_GAP_SOURCE_ID, snapshot);

  const membershipBytes = await readRequired(root, manifest.stationCodeMembership.snapshotPath, "station code membership is missing");
  if (sha256(membershipBytes) !== manifest.stationCodeMembership.snapshotSha256) throw new Error("station code membership sha256 mismatch");
  const membership = JSON.parse(membershipBytes.toString("utf8"));

  return { snapshot, membership };
}

function assertProductionUseAdmission(candidatesDocument, sourceId, snapshot) {
  const notAdmitted = (reason) => new Error(`source is not admitted for platform gaps: ${sourceId}${reason ? ` (${reason})` : ""}`);
  const matches = (candidatesDocument?.candidates ?? []).filter(({ id }) => id === sourceId);
  const admission = matches[0]?.evidence?.productionUseAdmission;
  if (
    matches.length !== 1
    || matches[0].capabilities?.facility?.productionUseAllowed !== true
    || admission?.decision !== "APPROVED"
    || admission.productionUseAllowed !== true
    || admission.scope !== PRODUCTION_USE_SCOPE
  ) {
    throw notAdmitted();
  }
  if (admission.rawSha256 !== snapshot.rawSha256 || admission.contentSha256 !== snapshot.contentSha256) {
    throw notAdmitted(`approval does not cover snapshot ${snapshot.snapshotId}`);
  }
}
