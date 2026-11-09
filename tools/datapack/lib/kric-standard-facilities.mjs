import { codepointCompare } from "../../lib/codepoint-compare.mjs";
import { sha256 } from "../../lib/hash.mjs";

export const KRIC_STANDARD_SOURCE_ID = "kric-station-convenience-standard";
export const KRIC_ESCALATOR_SOURCE_ID = "kric-station-escalator-detailed";
// KRIC 시설 정기 갱신(kric-current-facility-refresh)이 수집·게시·등록하는 원천이다. run 하나가 이 중 하나를 갱신한다(#3036).
export const KRIC_FACILITY_REFRESH_SOURCE_IDS = Object.freeze([KRIC_STANDARD_SOURCE_ID, KRIC_ESCALATOR_SOURCE_ID]);
// #3036 이전 operation journal에는 sourceId 키가 없다. 그때는 표준 원천만 갱신했으므로 키가 없을 때만 표준으로 읽는다.
// 키가 있는 값은 null·빈 값·모르는 원천이어도 그대로 돌려줘 호출자의 원천 검사가 거부하게 한다.
export const kricFacilityJournalSourceId = (journal) => (Object.hasOwn(journal, "sourceId") ? journal.sourceId : KRIC_STANDARD_SOURCE_ID);
// KRIC 정상 응답 결과 코드. 결과 03(terminal)은 시설 존재·부재를 말하지 않는다.
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

// KRIC 시설 원천마다 행을 시설 유형으로 읽는 규칙, 증거를 내는 유형, 목록에 없을 때 부재를 말할 수 있는 유형이 다르다.
// stationCnvFacl은 gubun으로 유형을 고르고 ES를 다루지 못한다. stationEscalator(#3036 QA 승인 2026-10-23)는 행 하나가 에스컬레이터 하나다.
const KRIC_FACILITY_PROFILES = new Map([
  [KRIC_STANDARD_SOURCE_ID, Object.freeze({
    idTag: "kric-standard",
    reportedTypes: KRIC_STANDARD_FACILITY_TYPES,
    absenceCoveredTypes: KRIC_STANDARD_ABSENCE_COVERED_TYPES,
    rowType: (row) => FACILITY_TYPES.get(row.gubun),
    providerCode: (row) => row.gubun,
    floorFrom: (row) => kricFloorLabel(row),
    validateRow: (row) => {
      if (!KRIC_FACILITY_CODES.has(row.gubun)) throw new Error(`unknown KRIC facility code: ${row.gubun}`);
    },
  })],
  [KRIC_ESCALATOR_SOURCE_ID, Object.freeze({
    idTag: "kric-escalator",
    reportedTypes: Object.freeze(["ESCALATOR"]),
    absenceCoveredTypes: Object.freeze(["ESCALATOR"]),
    rowType: () => "ESCALATOR",
    providerCode: () => "ES",
    floorFrom: () => "",
    validateRow: () => {},
  })],
]);

// 대전 1호선(DJ/1)·광주 1호선(GJ/1)은 엘리베이터·에스컬레이터를 지역 접근성 CSV 원천이 다루므로,
// KRIC 역사편의시설 원천에서는 휠체어리프트(WCLF → WHEELCHAIR_LIFT)만 시설·증거로 다룬다.
export const KRIC_REGIONAL_WHEELCHAIR_LIFT_LINE_SCOPES = new Map([
  ["line-7051a9c2525c", Object.freeze({ regionId: "daejeon", operatorId: "daejeon-transportation", railOprIsttCd: "DJ", lnCd: "1" })],
  ["line-e57a361e8892", Object.freeze({ regionId: "gwangju", operatorId: "gwangju-metropolitan-rapid-transit", railOprIsttCd: "GJ", lnCd: "1" })],
]);
export const KRIC_REGIONAL_WHEELCHAIR_LIFT_CUTOVER_CAPTURED_AT = "2026-11-09T13:10:42.779Z";

export function isKricRegionalWheelchairLiftQuery(query) {
  return KRIC_REGIONAL_WHEELCHAIR_LIFT_LINE_SCOPES.has(query?.lineId)
    || query?.railOprIsttCd === "DJ"
    || query?.railOprIsttCd === "GJ";
}

const KRIC_REGIONAL_WHEELCHAIR_LIFT_PROFILE = Object.freeze({
  idTag: "kric-standard",
  reportedTypes: Object.freeze(["WHEELCHAIR_LIFT"]),
  absenceCoveredTypes: Object.freeze(["WHEELCHAIR_LIFT"]),
  rowType: (row) => (row.gubun === "WCLF" ? "WHEELCHAIR_LIFT" : undefined),
  providerCode: (row) => row.gubun,
  floorFrom: (row) => kricFloorLabel(row),
  validateRow: (row) => {
    if (!KRIC_FACILITY_CODES.has(row.gubun)) throw new Error(`unknown KRIC facility code: ${row.gubun}`);
  },
});

function kricFacilityProfile(snapshot, query) {
  const profile = KRIC_FACILITY_PROFILES.get(snapshot?.sourceId);
  if (!profile) throw new Error(`unknown KRIC facility source: ${snapshot?.sourceId ?? "<missing>"}`);
  if (snapshot?.sourceId === KRIC_STANDARD_SOURCE_ID && isKricRegionalWheelchairLiftQuery(query)) {
    return KRIC_REGIONAL_WHEELCHAIR_LIFT_PROFILE;
  }
  return profile;
}

const hash = (value) => sha256(JSON.stringify(value));

export function kricQueryResultCode(query, snapshot) {
  if (typeof query?.providerResultCode === "string" && query.providerResultCode !== "") return query.providerResultCode;
  return snapshot?.providerResultCode === KRIC_PRESENT_RESULT_CODE ? KRIC_PRESENT_RESULT_CODE : undefined;
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

// 그 snapshot 원천이 이 유형을 말하는 행. 규칙이 없는 원천이거나 원천이 이 유형의 증거를 내지 않으면 null이다.
// coverage report 결속이 쓰며, null인 증거는 결속하지 않는다.
export function kricRowsOfType(snapshot, rows, facilityType, query) {
  const baseProfile = KRIC_FACILITY_PROFILES.get(snapshot?.sourceId);
  if (!baseProfile) return null;
  const profile = snapshot?.sourceId === KRIC_STANDARD_SOURCE_ID && isKricRegionalWheelchairLiftQuery(query)
    ? KRIC_REGIONAL_WHEELCHAIR_LIFT_PROFILE
    : baseProfile;
  if (!profile.reportedTypes.includes(facilityType)) return null;
  return rows.filter((row) => profile.rowType(row) === facilityType);
}

// 환승역 시설은 한 노선 조회에만 실리기도 한다(청구 6호선 조회의 "신금호방면5-3" 승강기, 신당 6호선 조회의 환승통로 리프트).
// 그래서 부재는 역 단위로 판단한다. 팩에 있는 그 역의 역-노선이 모두 결과 00으로 조회됐고 어느 조회에도 없는 유형만 부재다.
// 다른 노선 조회에 있으면 LISTED_ON_OTHER_LINE_QUERY, 조회되지 않은(결과 03 포함) 역-노선이 남으면 STATION_LINE_NOT_QUERIED다.
export function kricStationContexts(snapshot, queries, stationLines) {
  const defaultProfile = kricFacilityProfile(snapshot);
  const contexts = new Map();
  const contextOf = (stationId, absenceCoveredTypes = defaultProfile.absenceCoveredTypes) => {
    if (!contexts.has(stationId)) contexts.set(stationId, { absenceCoveredTypes, listedTypes: new Set(), unqueriedLineIds: new Set() });
    return contexts.get(stationId);
  };
  for (const { stationId, lineId } of stationLines) {
    const profile = kricFacilityProfile(snapshot, { lineId });
    contextOf(stationId, profile.absenceCoveredTypes).unqueriedLineIds.add(lineId);
  }
  for (const query of queries.filter((candidate) => kricQueryResultCode(candidate, snapshot) === KRIC_PRESENT_RESULT_CODE)) {
    const profile = kricFacilityProfile(snapshot, query);
    const context = contextOf(query.stationId, profile.absenceCoveredTypes);
    context.absenceCoveredTypes = profile.absenceCoveredTypes;
    context.unqueriedLineIds.delete(query.lineId);
    for (const row of query.rows) {
      const type = profile.rowType(row);
      if (type) context.listedTypes.add(type);
    }
  }
  return contexts;
}

// 조회 목록에 없는 유형의 상태다. 생산(materializer·후보 팩)과 검증(coverage report)이 같은 규칙을 쓴다.
export function kricFacilityStatusState(facilityType, { absenceCoveredTypes, listedTypes, unqueriedLineIds }) {
  if (!absenceCoveredTypes.includes(facilityType)) return UNKNOWN.SOURCE_DOES_NOT_COVER_TYPE;
  if (listedTypes.has(facilityType)) return UNKNOWN.LISTED_ON_OTHER_LINE_QUERY;
  return unqueriedLineIds.size > 0 ? UNKNOWN.STATION_LINE_NOT_QUERIED : ABSENT;
}

function supportedQueryRows(profile, query) {
  const seenProviderRecordHashes = new Set();
  const supportedRows = [];
  for (const row of query.rows) {
    profile.validateRow(row);
    const type = profile.rowType(row);
    if (!type) continue;
    const providerRecordHash = hash(row);
    if (seenProviderRecordHashes.has(providerRecordHash)) continue;
    seenProviderRecordHashes.add(providerRecordHash);
    supportedRows.push({ row, type, providerRecordHash });
  }
  return supportedRows.toSorted((left, right) => codepointCompare(left.providerRecordHash, right.providerRecordHash));
}

export function kricQueryFacilities({ snapshot, query, stationName, stationContexts }) {
  const profile = kricFacilityProfile(snapshot, query);
  const resultCode = kricQueryResultCode(query, snapshot);
  if (resultCode !== KRIC_PRESENT_RESULT_CODE) throw new Error(`KRIC provider result is not ${KRIC_PRESENT_RESULT_CODE}: ${resultCode ?? "<missing>"}`);
  const counts = new Map();
  const facilities = supportedQueryRows(profile, query).map(({ row, type, providerRecordHash }) => {
    const number = (counts.get(type) ?? 0) + 1;
    counts.set(type, number);
    const id = `facility-${query.stationId}-${type.toLowerCase()}-${profile.idTag}-${providerRecordHash.slice(0, 16)}`;
    if (id.length > FACILITY_ID_MAX_LENGTH) throw new Error(`facility identity exceeds ${FACILITY_ID_MAX_LENGTH} characters: ${id}`);
    return {
      id,
      type,
      name: `${stationName}역 ${type} ${number}`,
      providerFacilityRef: `${query.railOprIsttCd}:${query.lnCd}:${query.stinCd}:${profile.providerCode(row)}:${providerRecordHash}`,
      providerRecordHash,
      floorFrom: profile.floorFrom(row),
      description: row.dtlLoc,
      evidenceHash: hash({ snapshotId: snapshot.snapshotId, query: tuple(query), providerRecordHash }),
    };
  });
  const listedOnQuery = new Set(facilities.map(({ type }) => type));
  const stationContext = stationContexts.get(query.stationId);
  const statusEvidence = profile.reportedTypes.filter((type) => !listedOnQuery.has(type)).map((facilityType) => {
    const state = kricFacilityStatusState(facilityType, stationContext);
    return {
      stationId: query.stationId,
      lineId: query.lineId,
      facilityType,
      evidenceKind: state.evidenceKind,
      sourceId: snapshot.sourceId,
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
