import { codepointCompare } from "../../lib/codepoint-compare.mjs";

// #3036 QA 승인 2026-10-23: 시설 증거는 (역, 노선, 유형)마다 EXISTS·NOT_EXISTS·UNKNOWN 세 상태다.
// 원천이 다루는 유형만 "목록에 없음"을 부재(NOT_EXISTS)로 읽을 수 있고, production scope가 원천별로 그 유형을 선언한다.
export const ABSENCE_COVERABLE_FACILITY_TYPES = new Set(["ELEVATOR", "ESCALATOR", "WHEELCHAIR_LIFT"]);

const LABEL = "supportedV1Scope.facilityAbsenceCoverage";

export function facilityAbsenceCoverageBySource(supportedV1Scope, sourceIds) {
  const declared = supportedV1Scope?.facilityAbsenceCoverage;
  if (!Array.isArray(declared)) throw new Error(`${LABEL} must be an array`);
  const coverage = new Map();
  for (const entry of declared) {
    const { sourceId, facilityTypes } = entry ?? {};
    if (typeof sourceId !== "string" || !sourceIds.includes(sourceId) || coverage.has(sourceId)) {
      throw new Error(`${LABEL} sourceId must be a unique selected source: ${String(sourceId)}`);
    }
    if (!Array.isArray(facilityTypes) || facilityTypes.length === 0 || new Set(facilityTypes).size !== facilityTypes.length
      || facilityTypes.some((type) => !ABSENCE_COVERABLE_FACILITY_TYPES.has(type))) {
      throw new Error(`${LABEL}.facilityTypes must be a non-empty unique list of ${[...ABSENCE_COVERABLE_FACILITY_TYPES].join(", ")}: ${sourceId}`);
    }
    coverage.set(sourceId, new Set(facilityTypes));
  }
  return coverage;
}

export function assertFacilityAbsencesCovered(rows, coverageBySource) {
  const uncovered = rows
    .filter(({ evidenceKind, facilityType, sourceId }) => evidenceKind === "NOT_EXISTS"
      && ABSENCE_COVERABLE_FACILITY_TYPES.has(facilityType)
      && !coverageBySource.get(sourceId)?.has(facilityType))
    .map(({ stationId, lineId, facilityType, sourceId }) => `${stationId}:${lineId}:${facilityType} (${sourceId})`)
    .sort(codepointCompare);
  if (uncovered.length > 0) {
    throw new Error(`FACILITY_ABSENCE_WITHOUT_COVERING_SOURCE: ${uncovered.length} rows (${uncovered.slice(0, 5).join(", ")})`);
  }
}
