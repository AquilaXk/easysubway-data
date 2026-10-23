import { codepointCompare } from "../../lib/codepoint-compare.mjs";
import { sha256 } from "../../lib/hash.mjs";

export const KRIC_STANDARD_SOURCE_ID = "kric-station-convenience-standard";
// stationCnvFacl 정상 응답 결과 코드. 결과 03(terminal)은 시설 존재·부재를 말하지 않는다.
export const KRIC_PRESENT_RESULT_CODE = "00";
const KRIC_MIXED_SNAPSHOT_RESULT_CODE = "MIXED";
// KRIC official stationCnvFacl contract: EV/ES/WCLF are the only route-relevant facility codes.
const FACILITY_TYPES = new Map([["EV", "ELEVATOR"], ["ES", "ESCALATOR"], ["WCLF", "WHEELCHAIR_LIFT"]]);
const KRIC_FACILITY_CODES = new Set([...FACILITY_TYPES.keys(), "ELEC", "FEED", "INFO", "TOLT"]);
export const KRIC_STANDARD_FACILITY_TYPES = Object.freeze([...FACILITY_TYPES.values()]);
// stationCnvFacl 문서는 gubun ES를 적지만 실측(2026-10-22 snapshot 213조회, 2,019행)에서 ES는 0행이다.
// 그래서 목록에 ES가 없다는 것은 부재가 아니라 UNKNOWN이다. production scope의 supportedV1Scope.facilityAbsenceCoverage KRIC 선언과 같아야 한다.
export const KRIC_STANDARD_ABSENCE_COVERED_TYPES = Object.freeze(["ELEVATOR", "WHEELCHAIR_LIFT"]);
const FACILITY_ID_MAX_LENGTH = 120;
const ABSENT = Object.freeze({
  evidenceKind: "NOT_EXISTS", installationStatus: "NOT_INSTALLED", operationalStatus: "NOT_APPLICABLE",
  statusMeaning: "EXHAUSTIVE_LIST_ABSENCE", confidence: 100, strictRouteEligibleReason: "FACILITY_NOT_INSTALLED",
});
const unknownState = (statusMeaning) => Object.freeze({
  evidenceKind: "UNKNOWN", installationStatus: "UNKNOWN", operationalStatus: "UNKNOWN",
  statusMeaning, confidence: 0, strictRouteEligibleReason: "FACILITY_PRESENCE_UNKNOWN",
});
// 목록에 없다는 사실만으로 부재를 말할 수 없는 경우의 의미다. 입수(admission)도 이 목록만 받는다.
export const KRIC_STANDARD_UNKNOWN_STATUS_MEANINGS = Object.freeze([
  "SOURCE_DOES_NOT_COVER_TYPE", "LISTED_ON_OTHER_LINE_QUERY", "STATION_LINE_NOT_QUERIED",
]);
const UNKNOWN = Object.freeze(Object.fromEntries(KRIC_STANDARD_UNKNOWN_STATUS_MEANINGS.map((meaning) => [meaning, unknownState(meaning)])));

const hash = (value) => sha256(JSON.stringify(value));

// 수집기(collect-kric-accessibility-snapshots)는 결과 03 조회가 있는 MIXED snapshot에만 조회별 providerResultCode를 쓴다.
// 결과 03이 없는 snapshot은 조회별 코드 없이 snapshot 코드 00만 갖고, 그 조회는 모두 결과 00이다.
// MIXED snapshot에서 조회별 코드가 빠진 조회는 결과를 알 수 없으므로 undefined를 돌려 조회된 것으로 치지 않는다.
export function kricQueryResultCode(query, snapshot) {
  if (query.providerResultCode !== undefined) return query.providerResultCode;
  return snapshot.providerResultCode === KRIC_MIXED_SNAPSHOT_RESULT_CODE ? undefined : KRIC_PRESENT_RESULT_CODE;
}

const tuple = ({ railOprIsttCd, lnCd, stinCd }) => ({ railOprIsttCd, lnCd, stinCd });

export function kricFloorLabel(row) {
  if (row.stinFlor === undefined || row.stinFlor === null || row.stinFlor === "") return "";
  if (String(row.grndDvCd) === "1") return `${row.stinFlor}F`;
  if (String(row.grndDvCd) === "2") return `B${row.stinFlor}`;
  throw new Error(`unknown KRIC ground division code: ${row.grndDvCd ?? "<missing>"}`);
}

export function validateKricStandardProviderRows(queries) {
  for (const query of queries) {
    if (!Array.isArray(query?.rows)) throw new Error(`KRIC snapshot canonical mapping missing: ${query?.stationId}`);
    for (const row of query.rows) {
      if (!KRIC_FACILITY_CODES.has(row.gubun)) throw new Error(`unknown KRIC facility code: ${row.gubun}`);
      if (FACILITY_TYPES.has(row.gubun)) kricFloorLabel(row);
    }
  }
}

// 환승역 시설은 한 노선 조회에만 실리기도 한다(청구 6호선 조회의 "신금호방면5-3" 승강기, 신당 6호선 조회의 환승통로 리프트).
// 그래서 부재는 역 단위로 판단한다. 팩에 있는 그 역의 역-노선이 모두 결과 00으로 조회됐고 어느 조회에도 없는 유형만 부재다.
// 다른 노선 조회에 있으면 LISTED_ON_OTHER_LINE_QUERY, 조회되지 않은(결과 03 포함) 역-노선이 남으면 STATION_LINE_NOT_QUERIED다.
export function kricStandardStationContexts(snapshot, queries, stationLines) {
  const contexts = new Map();
  const contextOf = (stationId) => {
    if (!contexts.has(stationId)) contexts.set(stationId, { listedTypes: new Set(), unqueriedLineIds: new Set() });
    return contexts.get(stationId);
  };
  for (const { stationId, lineId } of stationLines) contextOf(stationId).unqueriedLineIds.add(lineId);
  for (const query of queries.filter((candidate) => kricQueryResultCode(candidate, snapshot) === KRIC_PRESENT_RESULT_CODE)) {
    const context = contextOf(query.stationId);
    context.unqueriedLineIds.delete(query.lineId);
    for (const { gubun } of query.rows) {
      const type = FACILITY_TYPES.get(gubun);
      if (type) context.listedTypes.add(type);
    }
  }
  return contexts;
}

// 조회 목록에 없는 유형의 상태다. 생산(materializer·후보 팩)과 검증(coverage report)이 같은 규칙을 쓴다.
export function kricStandardStatusState(facilityType, { listedTypes, unqueriedLineIds }) {
  if (!KRIC_STANDARD_ABSENCE_COVERED_TYPES.includes(facilityType)) return UNKNOWN.SOURCE_DOES_NOT_COVER_TYPE;
  if (listedTypes.has(facilityType)) return UNKNOWN.LISTED_ON_OTHER_LINE_QUERY;
  return unqueriedLineIds.size > 0 ? UNKNOWN.STATION_LINE_NOT_QUERIED : ABSENT;
}

export function kricStandardQueryFacilities({ snapshot, query, stationName, stationContexts }) {
  const resultCode = kricQueryResultCode(query, snapshot);
  if (resultCode !== KRIC_PRESENT_RESULT_CODE) throw new Error(`KRIC provider result is not ${KRIC_PRESENT_RESULT_CODE}: ${resultCode ?? "<missing>"}`);
  const seenProviderRecordHashes = new Set();
  const supportedRows = [];
  for (const row of query.rows) {
    if (!KRIC_FACILITY_CODES.has(row.gubun)) throw new Error(`unknown KRIC facility code: ${row.gubun}`);
    const type = FACILITY_TYPES.get(row.gubun);
    if (!type) continue;
    const providerRecordHash = hash(row);
    if (seenProviderRecordHashes.has(providerRecordHash)) continue;
    seenProviderRecordHashes.add(providerRecordHash);
    supportedRows.push({ row, type, providerRecordHash });
  }
  const counts = new Map();
  const facilities = [...supportedRows]
    .sort((left, right) => codepointCompare(left.providerRecordHash, right.providerRecordHash))
    .map(({ row, type, providerRecordHash }) => {
      const number = (counts.get(type) ?? 0) + 1;
      counts.set(type, number);
      const id = `facility-${query.stationId}-${type.toLowerCase()}-kric-standard-${providerRecordHash.slice(0, 16)}`;
      if (id.length > FACILITY_ID_MAX_LENGTH) throw new Error(`facility identity exceeds ${FACILITY_ID_MAX_LENGTH} characters: ${id}`);
      return {
        id,
        type,
        name: `${stationName}역 ${type} ${number}`,
        providerFacilityRef: `${query.railOprIsttCd}:${query.lnCd}:${query.stinCd}:${row.gubun}:${providerRecordHash}`,
        providerRecordHash,
        floorFrom: kricFloorLabel(row),
        description: row.dtlLoc,
        evidenceHash: hash({ snapshotId: snapshot.snapshotId, query: tuple(query), providerRecordHash }),
      };
    });
  const listedOnQuery = new Set(facilities.map(({ type }) => type));
  const stationContext = stationContexts.get(query.stationId);
  const statusEvidence = KRIC_STANDARD_FACILITY_TYPES.filter((type) => !listedOnQuery.has(type)).map((facilityType) => {
    const state = kricStandardStatusState(facilityType, stationContext);
    return {
      stationId: query.stationId,
      lineId: query.lineId,
      facilityType,
      evidenceKind: state.evidenceKind,
      sourceId: KRIC_STANDARD_SOURCE_ID,
      sourceSnapshotId: snapshot.snapshotId,
      providerRecordHash: query.providerRecordHash,
      evidenceHash: hash({ snapshotId: snapshot.snapshotId, query: tuple(query), type: facilityType, evidenceKind: state.evidenceKind }),
      provenanceKind: "OFFICIAL_SOURCE",
      installationStatus: state.installationStatus,
      operationalStatus: state.operationalStatus,
      statusMeaning: state.statusMeaning,
      confidence: state.confidence,
      verifiedAt: snapshot.observedAt,
      retrievedAt: snapshot.capturedAt,
      strictRouteEligibleReason: state.strictRouteEligibleReason,
    };
  });
  return { facilities, statusEvidence };
}
