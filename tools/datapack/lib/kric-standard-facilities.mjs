import { codepointCompare } from "../../lib/codepoint-compare.mjs";
import { sha256 } from "../../lib/hash.mjs";

export const KRIC_STANDARD_SOURCE_ID = "kric-station-convenience-standard";
// stationCnvFacl 정상 응답 결과 코드. 결과 03(terminal)은 시설 존재·부재를 말하지 않는다.
export const KRIC_PRESENT_RESULT_CODE = "00";
// KRIC official stationCnvFacl contract: EV/ES/WCLF are the only route-relevant facility codes.
const FACILITY_TYPES = new Map([["EV", "ELEVATOR"], ["ES", "ESCALATOR"], ["WCLF", "WHEELCHAIR_LIFT"]]);
const KRIC_FACILITY_CODES = new Set([...FACILITY_TYPES.keys(), "ELEC", "FEED", "INFO", "TOLT"]);
export const KRIC_STANDARD_FACILITY_TYPES = Object.freeze([...FACILITY_TYPES.values()]);
// stationCnvFacl 문서는 gubun ES를 적지만 실측(2026-10-22 snapshot 213조회, 2,019행)에서 ES는 0행이다.
// 그래서 목록에 ES가 없다는 것은 부재가 아니라 UNKNOWN이다. inventory capabilities.facility.absenceCoveredFacilityTypes와 같아야 한다.
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
const UNKNOWN_NOT_COVERED = unknownState("SOURCE_DOES_NOT_COVER_TYPE");
const UNKNOWN_OTHER_LINE = unknownState("LISTED_ON_OTHER_LINE_QUERY");

const hash = (value) => sha256(JSON.stringify(value));
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
// 그래서 부재는 역 단위로 판단한다: 같은 역의 어느 조회에도 없는 유형만 그 역-노선에서 부재이고, 다른 노선 조회에 있으면 UNKNOWN이다.
export function kricStandardListedTypesByStation(queries) {
  const listed = new Map();
  for (const query of queries) {
    for (const { gubun } of query.rows) {
      const type = FACILITY_TYPES.get(gubun);
      if (!type) continue;
      if (!listed.has(query.stationId)) listed.set(query.stationId, new Set());
      listed.get(query.stationId).add(type);
    }
  }
  return listed;
}

// 조회 목록에 없는 유형의 상태다. 생산(materializer·후보 팩)과 검증(coverage report)이 같은 규칙을 쓴다.
export function kricStandardStatusState(facilityType, listedAtStation) {
  if (!KRIC_STANDARD_ABSENCE_COVERED_TYPES.includes(facilityType)) return UNKNOWN_NOT_COVERED;
  return listedAtStation.has(facilityType) ? UNKNOWN_OTHER_LINE : ABSENT;
}

export function kricStandardQueryFacilities({ snapshot, query, stationName, listedTypesByStation }) {
  if (query.providerResultCode === "03") throw new Error("KRIC terminal provider result is invalid");
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
  const listedAtStation = listedTypesByStation.get(query.stationId) ?? new Set();
  const statusEvidence = KRIC_STANDARD_FACILITY_TYPES.filter((type) => !listedOnQuery.has(type)).map((facilityType) => {
    const state = kricStandardStatusState(facilityType, listedAtStation);
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
