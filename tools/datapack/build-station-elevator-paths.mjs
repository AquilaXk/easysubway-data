import { createHash } from "node:crypto";
import { codepointCompare } from "../lib/codepoint-compare.mjs";

export const KRIC_MOVEMENT_PATH_DIRECTION_CODES = Object.freeze({
  "1": "ENTRY",     // 출입구 -> 승강장
  "2": "EXIT",      // 승강장 -> 출입구
  "3": "TRANSFER",  // 환승경로
});

export function normalizeDtlLoc(value) {
  return String(value ?? "").normalize("NFKC").trim();
}

export function buildElevatorFacilityId(row) {
  const exitPart = row.exitNo != null && String(row.exitNo).trim() !== "" ? String(row.exitNo).trim() : "none";
  const floorFr = row.runStinFlorFr != null ? String(row.runStinFlorFr).trim() : "";
  const floorTo = row.runStinFlorTo != null ? String(row.runStinFlorTo).trim() : "";
  const floorSpan = `${floorFr}-${floorTo}`;
  const normalizedLoc = normalizeDtlLoc(row.dtlLoc);
  const locHash12 = createHash("sha256").update(normalizedLoc).digest("hex").slice(0, 12);
  return `kric-elev:${row.railOprIsttCd}:${row.lnCd}:${row.stinCd}:${exitPart}:${floorSpan}:${locHash12}`;
}

function formatFloor(grndDv, flor) {
  if (flor == null || flor === "") return "";
  if (grndDv === "지하") return `B${flor}`;
  if (grndDv === "지상") return `${flor}F`;
  return String(flor);
}

export function buildStationElevatorPaths({
  elevatorRows = [],
  movementRows = [],
  canonicalMappings = [],
  stationExits = [],
} = {}) {
  const mappingByTuple = new Map();
  for (const m of canonicalMappings) {
    mappingByTuple.set(`${m.railOprIsttCd}:${m.lnCd}:${m.stinCd}`, m);
  }

  const exitByStationAndNumber = new Map();
  for (const ex of stationExits) {
    exitByStationAndNumber.set(`${ex.station_id ?? ex.stationId}:${ex.exit_number ?? ex.exitNumber}`, ex);
  }

  // 1. Process elevatorRows
  const facilityCountById = new Map();
  const rawRowsById = new Map();

  for (const row of elevatorRows) {
    const fid = buildElevatorFacilityId(row);
    facilityCountById.set(fid, (facilityCountById.get(fid) ?? 0) + 1);
    const existing = rawRowsById.get(fid) ?? [];
    existing.push(row);
    rawRowsById.set(fid, existing);
  }

  const unidentifiableFacilities = [];
  const excludedStations = [];
  const validFacilities = [];

  // Sort facility keys deterministically
  const sortedFacilityIds = [...rawRowsById.keys()].sort(codepointCompare);

  for (const fid of sortedFacilityIds) {
    const rows = rawRowsById.get(fid);
    const count = facilityCountById.get(fid);
    const sampleRow = rows[0];
    const tupleKey = `${sampleRow.railOprIsttCd}:${sampleRow.lnCd}:${sampleRow.stinCd}`;
    const mapping = mappingByTuple.get(tupleKey);

    if (!mapping) {
      for (const row of rows) {
        excludedStations.push({
          row,
          tuple: `${row.railOprIsttCd}/${row.lnCd}/${row.stinCd}`,
          reason: "MAPPING_NOT_FOUND",
        });
      }
      continue;
    }

    if (count > 1) {
      // 중복 조합은 "식별 불가"로 전량 분리
      for (const row of rows) {
        unidentifiableFacilities.push({
          id: fid,
          row,
          tuple: `${row.railOprIsttCd}/${row.lnCd}/${row.stinCd}`,
          reason: "DUPLICATE_COMBINATION",
        });
      }
      continue;
    }

    const row = sampleRow;
    const exitNo = row.exitNo != null && String(row.exitNo).trim() !== "" ? String(row.exitNo).trim() : null;
    const matchedExit = exitNo ? exitByStationAndNumber.get(`${mapping.stationId}:${exitNo}`) : null;

    validFacilities.push({
      id: fid,
      stationId: mapping.stationId,
      lineId: mapping.lineId,
      exitNo,
      exitId: matchedExit?.id ?? null,
      type: "ELEVATOR",
      name: `${mapping.stationId} ${row.dtlLoc || exitNo || "엘리베이터"}`,
      status: "UNKNOWN",
      floorFrom: formatFloor(row.grndDvNmFr, row.runStinFlorFr),
      floorTo: formatFloor(row.grndDvNmTo, row.runStinFlorTo),
      description: row.dtlLoc ?? "",
      sourceId: "kric-station-elevator",
      railOprIsttCd: row.railOprIsttCd,
      lnCd: row.lnCd,
      stinCd: row.stinCd,
      rawRow: row,
    });
  }

  // Facilities index for step matching
  const facilitiesByStation = new Map();
  for (const fac of validFacilities) {
    const list = facilitiesByStation.get(fac.stationId) ?? [];
    list.push(fac);
    facilitiesByStation.set(fac.stationId, list);
  }

  // 2. Process movementRows
  const pathsGrouped = new Map();
  for (const row of movementRows) {
    const tupleKey = `${row.railOprIsttCd}:${row.lnCd}:${row.stinCd}`;
    const mapping = mappingByTuple.get(tupleKey);
    if (!mapping) {
      excludedStations.push({
        row,
        tuple: `${row.railOprIsttCd}/${row.lnCd}/${row.stinCd}`,
        reason: "MAPPING_NOT_FOUND",
      });
      continue;
    }

    const pathKey = `${mapping.stationId}:${mapping.lineId}:${row.mvPathMgNo}`;
    const group = pathsGrouped.get(pathKey) ?? {
      stationId: mapping.stationId,
      lineId: mapping.lineId,
      mvPathMgNo: row.mvPathMgNo,
      mvPathDvCd: row.mvPathDvCd,
      mvPathDvNm: row.mvPathDvNm,
      steps: [],
    };
    group.steps.push(row);
    pathsGrouped.set(pathKey, group);
  }

  const generatedPaths = [];
  const pathSummaries = [];

  const sortedPathKeys = [...pathsGrouped.keys()].sort(codepointCompare);

  for (const pathKey of sortedPathKeys) {
    const group = pathsGrouped.get(pathKey);
    const pathId = `path-${group.stationId}-${group.lineId}-${group.mvPathMgNo}`;
    const platformDirection = KRIC_MOVEMENT_PATH_DIRECTION_CODES[String(group.mvPathDvCd)] ?? String(group.mvPathDvCd);

    // Extract path-level exitNo from steps if present
    let pathExitNo = null;
    for (const stepRow of group.steps) {
      const match = stepRow.mvContDtl?.match(/(?:(\d+)번\s*출입구|(\d+)번\s*출구)/);
      if (match) {
        pathExitNo = match[1] || match[2];
        break;
      }
    }

    const stationFacs = facilitiesByStation.get(group.stationId) ?? [];
    let hasElevatorSteps = false;
    let allElevatorStepsConnected = true;

    // Sort steps by mvTpOrdr
    group.steps.sort((a, b) => a.mvTpOrdr - b.mvTpOrdr);

    for (const stepRow of group.steps) {
      const isElevatorStep = /엘리베이터|승강기/.test(stepRow.mvContDtl ?? "");
      let facilityId = null;

      if (isElevatorStep) {
        hasElevatorSteps = true;
        // Step exitNo if mentioned, otherwise pathExitNo
        const stepExitMatch = stepRow.mvContDtl?.match(/(?:(\d+)번\s*출입구|(\d+)번\s*출구)/);
        const stepExitNo = stepExitMatch ? (stepExitMatch[1] || stepExitMatch[2]) : pathExitNo;

        // Try exact match with station facilities
        const matches = stationFacs.filter((f) => {
          if (stepExitNo != null && f.exitNo != null && f.exitNo !== stepExitNo) {
            return false;
          }
          // Floor check if step details contain floor info
          return true;
        });

        if (matches.length === 1) {
          facilityId = matches[0].id;
        } else if (matches.length > 1 && stepExitNo != null) {
          // If multiple matches, filter by exitNo exact match
          const exactExitMatches = matches.filter((f) => f.exitNo === stepExitNo);
          if (exactExitMatches.length === 1) {
            facilityId = exactExitMatches[0].id;
          } else {
            facilityId = null;
          }
        } else {
          facilityId = null;
        }

        if (facilityId == null) {
          allElevatorStepsConnected = false;
        }
      }

      generatedPaths.push({
        path_id: pathId,
        station_id: group.stationId,
        line_id: group.lineId,
        path_kind: group.mvPathDvNm,
        exit_no: pathExitNo,
        platform_direction: platformDirection,
        step: stepRow.mvTpOrdr,
        detail: stepRow.mvContDtl ?? "",
        facility_id: facilityId,
      });
    }

    const isComplete = hasElevatorSteps && allElevatorStepsConnected;
    pathSummaries.push({
      pathId,
      stationId: group.stationId,
      lineId: group.lineId,
      mvPathMgNo: group.mvPathMgNo,
      pathKind: group.mvPathDvNm,
      platformDirection,
      isComplete,
      hasElevatorSteps,
    });
  }

  return {
    facilities: validFacilities,
    paths: generatedPaths,
    pathSummaries,
    excludedStations,
    unidentifiableFacilities,
  };
}

export function validateStationElevatorPathsIntegrity({ facilities, paths }) {
  const facilityIds = new Set(facilities.map((f) => f.id));
  const orphans = paths
    .filter((p) => p.facility_id != null && !facilityIds.has(p.facility_id))
    .map((p) => p.facility_id);

  if (orphans.length > 0) {
    throw new Error(`station_elevator_path contains orphan facility_id: ${[...new Set(orphans)].join(", ")}`);
  }
}

export function buildStationElevatorCoverageReport({
  facilities = [],
  pathSummaries = [],
  excludedStations = [],
  unidentifiableFacilities = [],
} = {}) {
  const stationLineKeys = new Set([
    ...facilities.map((f) => `${f.stationId}\0${f.lineId}`),
    ...pathSummaries.map((p) => `${p.stationId}\0${p.lineId}`),
  ]);

  const byStationLine = [];
  for (const key of [...stationLineKeys].sort(codepointCompare)) {
    const [stationId, lineId] = key.split("\0");
    const stFacilities = facilities.filter((f) => f.stationId === stationId && f.lineId === lineId);
    const stPaths = pathSummaries.filter((p) => p.stationId === stationId && p.lineId === lineId);
    const completePaths = stPaths.filter((p) => p.isComplete);

    byStationLine.push({
      stationId,
      lineId,
      facilityCount: stFacilities.length,
      pathCount: stPaths.length,
      completePathCount: completePaths.length,
      incompletePathCount: stPaths.length - completePaths.length,
    });
  }

  const summary = {
    totalFacilities: facilities.length,
    totalPaths: pathSummaries.length,
    totalCompletePaths: pathSummaries.filter((p) => p.isComplete).length,
    totalIncompletePaths: pathSummaries.filter((p) => !p.isComplete).length,
    totalExcludedStations: excludedStations.length,
    totalUnidentifiableFacilities: unidentifiableFacilities.length,
  };

  return {
    summary,
    byStationLine,
    excludedStations,
    unidentifiableFacilities,
  };
}
