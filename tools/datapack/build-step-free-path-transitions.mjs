import { codepointCompare } from "../lib/codepoint-compare.mjs";

function parseCostValue(val) {
  if (val == null || val === "") return null;
  if (typeof val === "number" && Number.isFinite(val)) return val;
  const match = String(val).replace(/,/g, "").match(/([0-9]+(?:\.[0-9]+)?)/);
  if (match) {
    const num = parseFloat(match[1]);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

export function buildStepFreePathTransitions({
  paths = [],
  facilities = [],
  pathSummaries = [],
} = {}) {
  const facilityIds = new Set(
    facilities.map((f) => (typeof f === "string" ? f : f.id)),
  );

  const summaryByPathId = new Map();
  for (const s of pathSummaries) {
    summaryByPathId.set(s.pathId, s);
  }

  // 1. Group paths if provided as steps
  const groupedPaths = new Map();
  for (const item of paths) {
    if (Array.isArray(item.steps)) {
      groupedPaths.set(item.path_id, item);
    } else {
      const pid = item.path_id;
      const existing = groupedPaths.get(pid) ?? {
        path_id: pid,
        station_id: item.station_id,
        line_id: item.line_id,
        path_kind: item.path_kind,
        exit_no: item.exit_no,
        platform_direction: item.platform_direction,
        mvDst: item.mvDst ?? item.distance_meters,
        mvPathMgNo: item.mvPathMgNo,
        steps: [],
      };
      existing.steps.push(item);
      groupedPaths.set(pid, existing);
    }
  }

  const generatedTransitions = [];
  const generatedRequirements = [];
  const excludedPaths = [];

  const sortedPathIds = [...groupedPaths.keys()].sort(codepointCompare);

  for (const pathId of sortedPathIds) {
    const p = groupedPaths.get(pathId);
    const stationId = p.station_id;
    const lineId = p.line_id;
    const summary = summaryByPathId.get(pathId);

    // 1. Completeness check
    let isComplete = summary ? summary.isComplete : p.isComplete;
    const pathElevatorFacilityIds = new Set();

    let hasElevatorStep = false;
    let allElevatorStepsConnected = true;

    for (const step of p.steps) {
      const isElevator = step.facility_id != null || /엘리베이터|승강기/.test(step.detail ?? "");
      if (isElevator) {
        hasElevatorStep = true;
        if (step.facility_id != null) {
          pathElevatorFacilityIds.add(step.facility_id);
        } else {
          allElevatorStepsConnected = false;
        }
      }
    }

    if (isComplete === undefined) {
      isComplete = hasElevatorStep && allElevatorStepsConnected;
    }

    if (!isComplete || pathElevatorFacilityIds.size === 0) {
      excludedPaths.push({
        pathId,
        stationId,
        lineId,
        reason: "INCOMPLETE_FACILITY_CONNECTION",
      });
      continue;
    }

    // 2. Cost check (mvDst / distanceMeters / durationSeconds)
    let totalDistance = parseCostValue(p.mvDst ?? p.distanceMeters);
    let totalDuration = parseCostValue(p.durationSeconds);

    if (totalDistance == null && totalDuration == null) {
      // Check individual steps
      for (const step of p.steps) {
        const d = parseCostValue(step.mvDst ?? step.distanceMeters);
        if (d != null) {
          totalDistance = (totalDistance ?? 0) + d;
        }
        const s = parseCostValue(step.durationSeconds);
        if (s != null) {
          totalDuration = (totalDuration ?? 0) + s;
        }
      }
    }

    if ((totalDistance == null || totalDistance <= 0) && (totalDuration == null || totalDuration <= 0)) {
      excludedPaths.push({
        pathId,
        stationId,
        lineId,
        reason: "MISSING_COST",
      });
      continue;
    }

    // 3. Direction check
    const direction = p.platform_direction;
    let edgeType;
    let prefix;
    let fromNodeId;
    let toNodeId;

    if (direction === "ENTRY") {
      edgeType = "ENTRY";
      prefix = "edge-entry";
      fromNodeId = stationId;
      toNodeId = `${stationId}:${lineId}`;
    } else if (direction === "EXIT") {
      edgeType = "EXIT";
      prefix = "edge-exit";
      fromNodeId = `${stationId}:${lineId}`;
      toNodeId = stationId;
    } else {
      excludedPaths.push({
        pathId,
        stationId,
        lineId,
        reason: "UNSUPPORTED_DIRECTION",
      });
      continue;
    }

    const pathTag = p.mvPathMgNo != null
      ? String(p.mvPathMgNo)
      : (p.path_id.match(/path-(?:.*-)?([^-\s]+)$/)?.[1] || p.path_id);
    const edgeId = `${prefix}-${stationId}-${lineId}-path-${pathTag}`;

    const transitionEdge = {
      edgeId,
      edgeType,
      fromNodeId,
      toNodeId,
      durationSeconds: Math.round(totalDuration ?? 0),
      distanceMeters: Math.round(totalDistance ?? 0),
      pathId: p.path_id,
      exitNo: p.exit_no != null && String(p.exit_no).trim() !== "" ? String(p.exit_no).trim() : null,
      stationId,
      lineId,
    };

    generatedTransitions.push(transitionEdge);

    const sortedFacIds = [...pathElevatorFacilityIds].sort(codepointCompare);
    for (const fid of sortedFacIds) {
      generatedRequirements.push({
        transition_key: edgeId,
        facility_id: fid,
      });
    }
  }

  generatedTransitions.sort((a, b) => codepointCompare(a.edgeId, b.edgeId));
  generatedRequirements.sort((a, b) => (
    codepointCompare(a.transition_key, b.transition_key)
    || codepointCompare(a.facility_id, b.facility_id)
  ));

  return {
    transitions: generatedTransitions,
    requirements: generatedRequirements,
    excludedPaths,
  };
}

export function validateTransitionRequirementsIntegrity(
  requirements = [],
  { validTransitions, validFacilities } = {},
) {
  if (
    !validFacilities
    || (validFacilities instanceof Set && validFacilities.size === 0)
    || (Array.isArray(validFacilities) && validFacilities.length === 0)
  ) {
    throw new Error("facilities table is missing or empty");
  }

  const facilitySet = validFacilities instanceof Set
    ? validFacilities
    : new Set(validFacilities.map((f) => (typeof f === "string" ? f : f.id)));

  const transitionSet = validTransitions instanceof Set
    ? validTransitions
    : new Set(validTransitions?.map((t) => (typeof t === "string" ? t : t.edgeId ?? t.id)) ?? []);

  for (const req of requirements) {
    if (!transitionSet.has(req.transition_key)) {
      throw new Error(`transition_facility_requirement contains orphan transition_key: ${req.transition_key}`);
    }
    if (!facilitySet.has(req.facility_id)) {
      throw new Error(`transition_facility_requirement contains orphan facility_id: ${req.facility_id}`);
    }
  }
}

export function buildStepFreeTransitionCoverageReport({
  transitions = [],
  requirements = [],
  excludedPaths = [],
} = {}) {
  const stationLineKeys = new Set([
    ...transitions.map((t) => `${t.stationId}\0${t.lineId}`),
    ...excludedPaths.map((p) => `${p.stationId}\0${p.lineId}`),
  ]);

  const excludedByReason = {};
  for (const p of excludedPaths) {
    excludedByReason[p.reason] = (excludedByReason[p.reason] ?? 0) + 1;
  }

  const byStationLine = [];
  for (const key of [...stationLineKeys].sort(codepointCompare)) {
    const [stationId, lineId] = key.split("\0");
    const stTransitions = transitions.filter((t) => t.stationId === stationId && t.lineId === lineId);
    const stTransKeys = new Set(stTransitions.map((t) => t.edgeId));
    const stRequirements = requirements.filter((r) => stTransKeys.has(r.transition_key));
    const stExcluded = excludedPaths.filter((p) => p.stationId === stationId && p.lineId === lineId);

    byStationLine.push({
      stationId,
      lineId,
      transitionCount: stTransitions.length,
      requirementCount: stRequirements.length,
      excludedPathCount: stExcluded.length,
    });
  }

  const summary = {
    totalTransitions: transitions.length,
    totalRequirements: requirements.length,
    totalExcludedPaths: excludedPaths.length,
    excludedByReason,
  };

  return {
    summary,
    byStationLine,
    excludedPaths,
  };
}
