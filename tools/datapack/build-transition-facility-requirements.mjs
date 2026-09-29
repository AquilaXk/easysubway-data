#!/usr/bin/env node
/**
 * transition_facility_requirement 테이블 생성 및 정합성 검증 모듈 (#827)
 *
 * ============================================================================
 * [facility_id 안정 식별자 결정론적 생성 규칙 - Rule SSOT]
 * ============================================================================
 * 1. 식별자 형식: `seoul:${stationCode}:${dtlPstn}:${sequence}`
 *    - stationCode: 서울교통공사 공식 역코드(stnCd, 예: "0249", "0202") 또는 정규화 역코드
 *    - dtlPstn: 서울교통공사 API의 상세위치 원천 문자열(앞뒤 공백 정규화)
 *    - sequence: 동일 역(stationCode) 및 동일 상세위치(dtlPstn) 내 승강기를 구분하는 1-based 순번
 * 2. 삭제 시설 제외:
 *    - oprtngSitu 가 'D'(삭제)인 레코드는 식별자 채번 전 전면 제외한다.
 * 3. 후속 연계 보장 (#419):
 *    - 서울교통공사 실시간 가동 정보 수집기(#419)는 동일한 규칙(stationCode + dtlPstn + sequence)으로
 *      facility_id를 산출하여 상태(AVAILABLE / UNAVAILABLE)를 바인딩해야 한다.
 * ============================================================================
 */

import { codepointCompare } from "../lib/codepoint-compare.mjs";

export const TRANSITION_FACILITY_REQUIREMENT_TABLE_DDL =
  "CREATE TABLE transition_facility_requirement (" +
  "transition_key TEXT NOT NULL, " +
  "segment TEXT NOT NULL, " +
  "facility_id TEXT NOT NULL, " +
  "PRIMARY KEY (transition_key, segment, facility_id)" +
  ")";

export const SEGMENTS = Object.freeze({
  ENTRANCE_CONCOURSE: "출입구-대합실",
  CONCOURSE_PLATFORM: "대합실-승강장",
  TRANSFER_PASSAGE: "환승통로",
});

/**
 * 서울교통공사 엘리베이터 원천 레코드로부터 결정론적 facility_id를 생성한다.
 */
export function buildFacilityId({ stnCd, stationCode, dtlPstn, sequence = 1 }) {
  const code = (stnCd ?? stationCode ?? "").toString().trim();
  if (!code) throw new Error("buildFacilityId: stationCode is required");
  const pos = (dtlPstn ?? "").toString().trim();
  if (!pos) throw new Error("buildFacilityId: dtlPstn is required");
  const seq = Number(sequence);
  if (!Number.isSafeInteger(seq) || seq < 1) {
    throw new Error("buildFacilityId: sequence must be positive safe integer");
  }
  return `seoul:${code}:${pos}:${seq}`;
}

/**
 * dtlPstn 문자열을 무단차 통과 구간(segment)으로 분류한다.
 */
export function classifySegment(dtlPstn) {
  if (!dtlPstn || typeof dtlPstn !== "string") return null;
  const normalized = dtlPstn.trim();
  if (normalized.includes("환승")) {
    return SEGMENTS.TRANSFER_PASSAGE;
  }
  if (normalized.includes("대합실") && normalized.includes("승강장")) {
    return SEGMENTS.CONCOURSE_PLATFORM;
  }
  if (normalized.includes("승강장")) {
    return SEGMENTS.CONCOURSE_PLATFORM;
  }
  if (
    normalized.includes("출입구") ||
    normalized.includes("출구") ||
    normalized.includes("지상") ||
    normalized.includes("외부")
  ) {
    return SEGMENTS.ENTRANCE_CONCOURSE;
  }
  return null;
}

/**
 * 서울교통공사 엘리베이터 레코드와 전환 목록을 매핑하여
 * transition_facility_requirement 행 목록을 생성한다.
 */
export function buildTransitionFacilityRequirements({
  elevatorRecords = [],
  transitions = [],
}) {
  // 1. oprtngSitu === 'D' (삭제) 시설 제외
  const activeRecords = elevatorRecords.filter(
    (row) => row && row.oprtngSitu !== "D" && typeof row.dtlPstn === "string" && row.dtlPstn.trim() !== "",
  );

  // 2. 역별·상세위치별 정렬 및 sequence 부여
  const sortedRecords = [...activeRecords].sort((left, right) => {
    const codeLeft = (left.stnCd ?? left.stationCode ?? "").toString().trim();
    const codeRight = (right.stnCd ?? right.stationCode ?? "").toString().trim();
    const codeComp = codepointCompare(codeLeft, codeRight);
    if (codeComp !== 0) return codeComp;
    const posComp = codepointCompare(left.dtlPstn.trim(), right.dtlPstn.trim());
    if (posComp !== 0) return posComp;
    return codepointCompare(JSON.stringify(left), JSON.stringify(right));
  });

  // stationCode -> Map<segment, string[]> (facilityIds)
  const stationFacilitySegments = new Map();
  const sequenceCounters = new Map();

  for (const record of sortedRecords) {
    const stationCode = (record.stnCd ?? record.stationCode ?? "").toString().trim();
    const dtlPstn = record.dtlPstn.trim();
    const seqKey = `${stationCode}\0${dtlPstn}`;
    const seq = (sequenceCounters.get(seqKey) ?? 0) + 1;
    sequenceCounters.set(seqKey, seq);

    const facilityId = buildFacilityId({ stnCd: stationCode, dtlPstn, sequence: seq });
    const segment = classifySegment(dtlPstn);
    if (!segment) continue;

    if (!stationFacilitySegments.has(stationCode)) {
      stationFacilitySegments.set(stationCode, new Map());
    }
    const segmentsMap = stationFacilitySegments.get(stationCode);
    if (!segmentsMap.has(segment)) {
      segmentsMap.set(segment, []);
    }
    segmentsMap.get(segment).push(facilityId);
  }

  // 3. 전환별 구간 매핑 (추정 매핑 금지: 근거가 있는 구간만 행 생성)
  const requirementRows = [];

  for (const transition of transitions) {
    const key = transition.transitionKey ?? transition.id;
    if (!key) continue;
    const edgeType = transition.edgeType;
    const stationCode = (transition.stationCode ?? transition.stnCd ?? "").toString().trim();
    const segmentsMap = stationFacilitySegments.get(stationCode);

    if (!segmentsMap) {
      // 해당 역에 엘리베이터 실측 근거가 없으면 행을 만들지 않는다 (추정 매핑 금지)
      continue;
    }

    if (edgeType === "ENTRY" || edgeType === "EXIT") {
      // 출입: 출입구-대합실, 대합실-승강장 중 실제 존재하는 구간만 매핑
      for (const segmentName of [SEGMENTS.ENTRANCE_CONCOURSE, SEGMENTS.CONCOURSE_PLATFORM]) {
        const facilityIds = segmentsMap.get(segmentName);
        if (facilityIds && facilityIds.length > 0) {
          for (const facilityId of facilityIds) {
            requirementRows.push({
              transition_key: key,
              segment: segmentName,
              facility_id: facilityId,
            });
          }
        }
      }
    } else if (edgeType === "IN_STATION_TRANSFER") {
      // 환승: 환승통로가 있으면 환승통로, 또는 대합실-승강장 구간 매핑
      const transferFacilities = segmentsMap.get(SEGMENTS.TRANSFER_PASSAGE);
      if (transferFacilities && transferFacilities.length > 0) {
        for (const facilityId of transferFacilities) {
          requirementRows.push({
            transition_key: key,
            segment: SEGMENTS.TRANSFER_PASSAGE,
            facility_id: facilityId,
          });
        }
      } else {
        const concoursePlatform = segmentsMap.get(SEGMENTS.CONCOURSE_PLATFORM);
        if (concoursePlatform && concoursePlatform.length > 0) {
          for (const facilityId of concoursePlatform) {
            requirementRows.push({
              transition_key: key,
              segment: SEGMENTS.CONCOURSE_PLATFORM,
              facility_id: facilityId,
            });
          }
        }
      }
    }
  }

  // 4. 결정론적 정렬 및 중복 제거
  const uniqueKeyMap = new Map();
  for (const row of requirementRows) {
    const rowKey = `${row.transition_key}\0${row.segment}\0${row.facility_id}`;
    if (!uniqueKeyMap.has(rowKey)) {
      uniqueKeyMap.set(rowKey, row);
    }
  }

  return [...uniqueKeyMap.values()].sort((left, right) => {
    const tk = codepointCompare(left.transition_key, right.transition_key);
    if (tk !== 0) return tk;
    const seg = codepointCompare(left.segment, right.segment);
    if (seg !== 0) return seg;
    return codepointCompare(left.facility_id, right.facility_id);
  });
}

/**
 * 고아 행(orphan rows) 검사: 모든 transition_key와 facility_id가 유효 집합에 속하는지 검증
 */
export function validateRequirementsIntegrity(requirements, { validTransitions, validFacilities } = {}) {
  if (!Array.isArray(requirements)) throw new Error("requirements must be an array");

  for (const row of requirements) {
    if (!row || typeof row !== "object") throw new Error("requirement row must be an object");
    const { transition_key, segment, facility_id } = row;
    if (!transition_key || typeof transition_key !== "string") {
      throw new Error("requirement transition_key is required");
    }
    if (!segment || typeof segment !== "string") {
      throw new Error("requirement segment is required");
    }
    if (!facility_id || typeof facility_id !== "string") {
      throw new Error("requirement facility_id is required");
    }

    if (validTransitions && !validTransitions.has(transition_key)) {
      throw new Error(`transition_facility_requirement contains orphan transition_key: ${transition_key}`);
    }
    if (validFacilities && !validFacilities.has(facility_id)) {
      throw new Error(`transition_facility_requirement contains orphan facility_id: ${facility_id}`);
    }
  }
}

/**
 * 커버리지 리포트 생성
 */
export function buildTransitionCoverageReport({ requirements = [], transitions = [] }) {
  const mappedKeys = new Set(requirements.map((r) => r.transition_key));
  const totalTransitions = transitions.length;
  const mappedTransitions = transitions.filter((t) => mappedKeys.has(t.transitionKey ?? t.id)).length;
  const ratioNum = totalTransitions === 0 ? 0 : (mappedTransitions / totalTransitions) * 100;
  const coverageRatio = `${ratioNum.toFixed(2)}%`;

  const byEdgeType = {};
  for (const t of transitions) {
    const type = t.edgeType ?? "UNKNOWN";
    if (!byEdgeType[type]) byEdgeType[type] = { total: 0, mapped: 0 };
    byEdgeType[type].total += 1;
    if (mappedKeys.has(t.transitionKey ?? t.id)) {
      byEdgeType[type].mapped += 1;
    }
  }

  const byStation = new Map();
  for (const t of transitions) {
    const stationId = t.stationId ?? "unknown";
    const stationName = t.stationName ?? stationId;
    const lineId = t.lineId ?? t.fromLineId ?? "unknown";
    const lineName = t.lineName ?? lineId;
    const key = `${stationId}:${lineId}`;
    if (!byStation.has(key)) {
      byStation.set(key, { stationId, stationName, lineId, lineName, total: 0, mapped: 0 });
    }
    const entry = byStation.get(key);
    entry.total += 1;
    if (mappedKeys.has(t.transitionKey ?? t.id)) {
      entry.mapped += 1;
    }
  }

  const lines = [
    "# Transition Facility Requirement Coverage Report",
    `- Total Transitions: ${totalTransitions}`,
    `- Mapped Transitions: ${mappedTransitions}`,
    `- Coverage Ratio: ${coverageRatio}`,
    "",
    "## Breakdown by Edge Type",
  ];
  for (const [type, stats] of Object.entries(byEdgeType).sort((a, b) => a[0].localeCompare(b[0]))) {
    const pct = stats.total === 0 ? "0.00%" : `${((stats.mapped / stats.total) * 100).toFixed(2)}%`;
    lines.push(`- ${type}: ${stats.mapped} / ${stats.total} (${pct})`);
  }

  return {
    totalTransitions,
    mappedTransitions,
    coverageRatio,
    byEdgeType,
    stationBreakdown: [...byStation.values()],
    formattedText: lines.join("\n"),
  };
}
