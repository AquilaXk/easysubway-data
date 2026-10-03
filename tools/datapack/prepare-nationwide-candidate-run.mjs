import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { canonicalJson } from "./lib/manifest-validation.mjs";
import { observedBusanAccessibilityRows } from "./collect-busan-accessibility.mjs";
import { cleanRegionalStationName, regionalProviderStationNameKey } from "./lib/regional-station-name.mjs";
import { terminalHead } from "./build-current-five-region-source-fan-in.mjs";
import { buildNationwideAssemblyInputs } from "./lib/nationwide-assembly-binding.mjs";
import { canonicalRideEdgeSetSha256, routeEdgeSha256 } from "./evaluate-route-accessibility-edges.mjs";
import {
  canonicalCurrentCapitalRouteEdgeInputJson,
  canonicalCurrentCapitalStationLineInputJson,
} from "./current-capital-station-line-contract.mjs";
import { outOfStationTransferNetworkEdges } from "./build-datapack.mjs";
import { HOLIDAYS_2026, materializeIncheonTimetable } from "./materialize-incheon-timetable.mjs";
import { buildNationwidePlatformInfoMap } from "./lib/nationwide-platform-resolver.mjs";
import { integrateRegionalTimetables } from "./lib/regional-timetable-integrator.mjs";
import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";
import { deriveApprovedItxTopologyEvidencePath } from "./activate-current-source-set.mjs";
import { officialOdFareAdmissionsBySource, officialOdFareQuoteSetHash } from "./lib/official-od-fare-evidence.mjs";
import { capitalTopologyReverificationPathForSnapshotId } from "./lib/capital-route-topology-snapshot-id.mjs";
import {
  BUSAN_TRANSFER_METRICS_PATH,
  buildBusanTransferMetrics,
  canonicalBusanTransferMetricsJson,
  readBusanTransferMetricsInputs,
} from "./build-busan-transfer-metrics.mjs";
import {
  SEOUL_MEASURED_TRANSFER_METRICS_PATH,
  buildSeoulMeasuredTransferMetrics,
  canonicalSeoulMeasuredTransferMetricsJson,
  readSeoulMeasuredTransferMetricsInputs,
} from "./build-seoul-measured-transfer-metrics.mjs";
import { validateLineage } from "./source-snapshot-policy.mjs";
import {
  EXTERNAL_STOP_TIMES_KEY,
  OFFICIAL_STOP_TIMES_PATH,
  buildExternalStopTimesArtifact,
} from "./lib/external-stop-times.mjs";
import {
  CAPITAL_TIMETABLE_EVIDENCE_KEY,
  CAPITAL_TIMETABLE_REPORT_PATH,
  CAPITAL_TIMETABLE_SOURCE_ID,
  buildCapitalOfficialTimetable,
  removeLine4PilotTimetable,
} from "./lib/capital-official-timetable.mjs";
import {
  KORAIL_TIMETABLE_EVIDENCE_KEY,
  KORAIL_TIMETABLE_SERVICE_ID_PREFIX,
  KORAIL_TIMETABLE_TRIP_ID_PREFIX,
  kricKorailOfficialTimetable,
} from "./lib/kric-korail-timetable.mjs";
import {
  STATION_LINES_SERVICE_ID_PREFIX,
  STATION_LINES_TIMETABLE_SOURCE_ID,
  STATION_LINES_TRIP_ID_PREFIX,
  kricStationLinesOfficialTimetable,
} from "./lib/kric-station-lines-timetable.mjs";
import { materializeOfficialLineTimetables } from "./lib/official-line-timetable.mjs";
import { materializeKorailTimetable } from "./materialize-korail-timetable.mjs";
import { buildRetainedGwangjuScheduleTables } from "./materialize-gwangju-timetable.mjs";
import {
  RETAINED_GWANGJU_PROJECTION_EVIDENCE_KEY,
  RETAINED_GWANGJU_PROJECTION_SOURCE_ID,
  validateRetainedGwangjuProjection,
} from "./lib/kric-retained-gwangju-projection.mjs";

export { CAPITAL_TIMETABLE_REPORT_PATH, OFFICIAL_STOP_TIMES_PATH };
// 팩 JSON 밖 결정적 gzip 파일로 싣는 공식 원천 시간표. trip이 원천 공통 provenance와 행 hash를 가진 원천만 둔다.
const EXTERNAL_TIMETABLE_SOURCE_IDS = Object.freeze([
  CAPITAL_TIMETABLE_SOURCE_ID, "incheon-line1-train-timetable", "incheon-line2-train-timetable", STATION_LINES_TIMETABLE_SOURCE_ID,
]);
// #903: 코레일 6개 노선·역별 API 5개 노선의 노선별 적재 요약과 격리 행.
export const OFFICIAL_LINE_TIMETABLE_REPORT_PATH = "tools/datapack/release/nationwide-official-line-timetable-report.json";
// 공용 적재기 운행 달력과 격리 상한(수도권과 같은 값).
const OFFICIAL_LINE_CALENDAR = Object.freeze({ startDate: "20260101", endDate: "20261231", maxQuarantineRatio: 0.05 });

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

// station_car_door_hints 계약: catalog-schema.sql CHECK(대상 시설·칸 1~10·문 1~4)와
// 빠른하차 importer(import-car-door-hints.mjs)의 방향 어휘(UP/DOWN/INNER/OUTER, 미상은 '').
// 계약 밖 KRIC 행은 팩에 싣지 않고 사유와 함께 격리 증거 파일에 남긴다(#854, QA 결정 2026-10-01).
export const CAR_DOOR_HINT_QUARANTINE_PATH = "tools/datapack/release/nationwide-car-door-hint-quarantine.json";
export const REGIONAL_TIMETABLE_QUARANTINE_PATH = "tools/datapack/release/nationwide-regional-timetable-quarantine.json";
const CAR_DOOR_HINT_FACILITY_TYPES = ["STAIR", "ELEVATOR", "ESCALATOR", "TRANSFER"];
const CAR_DOOR_HINT_DIRECTIONS = ["", "UP", "DOWN", "INNER", "OUTER"];

export function carDoorHintContractViolations(hint) {
  const reasons = [];
  if (!CAR_DOOR_HINT_FACILITY_TYPES.includes(hint.targetFacilityType)) {
    reasons.push("TARGET_FACILITY_TYPE_OUTSIDE_CONTRACT");
  }
  if (!Number.isInteger(hint.carNumber) || hint.carNumber < 1 || hint.carNumber > 10) {
    reasons.push("CAR_NUMBER_OUTSIDE_CONTRACT");
  }
  if (!Number.isInteger(hint.doorNumber) || hint.doorNumber < 1 || hint.doorNumber > 4) {
    reasons.push("DOOR_NUMBER_OUTSIDE_CONTRACT");
  }
  if (!CAR_DOOR_HINT_DIRECTIONS.includes(hint.direction ?? "")) {
    reasons.push("DIRECTION_OUTSIDE_CONTRACT");
  }
  return reasons;
}

export function formatPlatformInfo(info) {
  if (!info) return "";
  if (typeof info === "string") return info;
  if (typeof info !== "object" || Array.isArray(info)) return "";

  const canonical = {};
  if (info.oppositeCrossing !== undefined && info.oppositeCrossing !== null && info.oppositeCrossing !== "") {
    if (typeof info.oppositeCrossing === "boolean") {
      canonical.oppositeCrossing = info.oppositeCrossing ? "Y" : "N";
    } else {
      canonical.oppositeCrossing = String(info.oppositeCrossing);
    }
  } else if (info.plfCplFlg !== undefined && info.plfCplFlg !== null && info.plfCplFlg !== "") {
    canonical.oppositeCrossing = String(info.plfCplFlg);
  } else if (info.opposite_side !== undefined && info.opposite_side !== null && info.opposite_side !== "") {
    canonical.oppositeCrossing = (info.opposite_side === "가능" || info.opposite_side === "Y" || info.opposite_side === true) ? "Y" : "N";
  }

  if (info.platformType !== undefined && info.platformType !== null && info.platformType !== "") {
    canonical.platformType = String(info.platformType);
  } else if (info.plfTpNm !== undefined && info.plfTpNm !== null && info.plfTpNm !== "") {
    canonical.platformType = String(info.plfTpNm);
  } else if (info.platform !== undefined && info.platform !== null && info.platform !== "") {
    canonical.platformType = String(info.platform);
  }

  if (info.screenDoor !== undefined && info.screenDoor !== null && info.screenDoor !== "") {
    canonical.screenDoor = String(info.screenDoor);
  } else if (info.scrCharExt !== undefined && info.scrCharExt !== null && info.scrCharExt !== "") {
    canonical.screenDoor = String(info.scrCharExt);
  } else if (info.screen_door !== undefined && info.screen_door !== null && info.screen_door !== "") {
    canonical.screenDoor = String(info.screen_door);
  }

  if (info.safetyGap !== undefined && info.safetyGap !== null && info.safetyGap !== "") {
    canonical.safetyGap = String(info.safetyGap);
  } else if (info.sfFotExt !== undefined && info.sfFotExt !== null && info.sfFotExt !== "") {
    canonical.safetyGap = String(info.sfFotExt);
  }

  if (info.unloadDoor !== undefined && info.unloadDoor !== null && info.unloadDoor !== "") {
    canonical.unloadDoor = String(info.unloadDoor);
  } else if (info.unload_door !== undefined && info.unload_door !== null && info.unload_door !== "") {
    canonical.unloadDoor = String(info.unload_door);
  }

  if (Object.keys(canonical).length === 0) return "";
  return JSON.stringify(canonical);
}

// #862 결정 #15: 후보 입력 snapshot은 고정 경로가 아니라 원장 head에서 고른다.
// 원장(source-snapshots.json) 원천은 fan-in과 같은 terminal head 선택을 쓰고, fan-in 선택·시계와 맞아야 한다.
// 인천 원천은 원장 행이 없어 inventory admission evidence가 가리키는 snapshot을 쓴다.
const LEDGER_SELECTED_INPUT_SOURCE_IDS = Object.freeze({
  busanAccessibility: "busan-transportation-accessibility",
  daeguAccessibility: "daegu-transportation-accessibility",
  daejeonAccessibility: "daejeon-transportation-accessibility",
  gwangjuAccessibility: "gwangju-transportation-accessibility",
  kricConvenience: "kric-station-convenience-standard",
  busanTimetable: "busan-transportation-timetable",
  daeguTimetable1: "daegu-line1-train-timetable",
  daeguTimetable2: "daegu-line2-train-timetable",
  daeguTimetable3: "daegu-line3-train-timetable",
  daejeonTimetable: "daejeon-train-timetable",
});
const ADMISSION_EVIDENCE_INPUTS = Object.freeze({
  incheonTopology: ["incheon-transit-station-info", "topologyAdmissionEvidence"],
  incheonLine1: ["incheon-line1-train-timetable", "scheduleAdmissionEvidence"],
  incheonLine2: ["incheon-line2-train-timetable", "scheduleAdmissionEvidence"],
});
const CONTENT_BOUND_INPUT_SOURCE_IDS = Object.freeze({
  daegyeongTimetable: "korail-metropolitan-planned-timetable",
  stationLinesTimetable: STATION_LINES_TIMETABLE_SOURCE_ID,
});
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function exactInventorySource(sourceInventory, sourceId) {
  const matches = (Array.isArray(sourceInventory?.sources) ? sourceInventory.sources : [])
    .filter((source) => source?.id === sourceId);
  if (matches.length !== 1) throw new Error(`nationwide candidate input inventory source missing or ambiguous for ${sourceId}`);
  return matches[0];
}

function exactSnapshotEvidence(sourceId, snapshotId, evidences) {
  const matching = evidences.filter((evidence) => evidence?.snapshotId === snapshotId && typeof evidence.snapshotPath === "string");
  const paths = new Set(matching.map(({ snapshotPath }) => snapshotPath));
  const rawShas = new Set(matching.map(({ rawSha256 }) => rawSha256));
  if (paths.size !== 1 || rawShas.size !== 1) {
    throw new Error(`nationwide candidate input snapshot path missing or ambiguous for ${sourceId}`);
  }
  const [snapshotPath] = paths;
  const [rawSha256] = rawShas;
  if (snapshotPath !== `tools/datapack/sources/${snapshotId}.json` || !SHA256_PATTERN.test(rawSha256 ?? "")) {
    throw new Error(`nationwide candidate input snapshot path mismatch for ${sourceId}`);
  }
  return { snapshotPath, rawSha256 };
}

async function boundInputSnapshot({ sourceId, snapshotId, snapshotPath, rawSha256, ledgerHead, readSourceBytes }) {
  const bytes = await readSourceBytes(snapshotPath);
  let snapshot;
  try { snapshot = JSON.parse(bytes); } catch { throw new Error(`nationwide candidate input is invalid JSON for ${sourceId}`); }
  const ledgerRawSha256s = ledgerHead == null ? [rawSha256] : [ledgerHead.rawSha256, ledgerHead.rawReceipt?.snapshotRawSha256];
  if (snapshot?.sourceId !== sourceId || (snapshot.snapshotId !== undefined && snapshot.snapshotId !== snapshotId)
    || snapshot.rawSha256 !== rawSha256 || !ledgerRawSha256s.includes(snapshot.rawSha256)) {
    throw new Error(`nationwide candidate input raw binding mismatch for ${sourceId}`);
  }
  return Buffer.from(bytes);
}

export async function resolveNationwideCandidateInputSnapshots({ sourceInventory, sourceSnapshots, fanIn, freshnessPolicy, readSourceBytes }) {
  if (!Array.isArray(sourceSnapshots) || !Array.isArray(fanIn?.selectedSources) || typeof readSourceBytes !== "function"
    || !Array.isArray(freshnessPolicy?.sourceClasses)) {
    throw new Error("nationwide candidate input selection arguments are invalid");
  }
  const evaluatedAt = Date.parse(fanIn.evaluatedAt);
  if (!Number.isFinite(evaluatedAt) || new Date(evaluatedAt).toISOString() !== fanIn.evaluatedAt) {
    throw new Error("nationwide candidate input fan-in clock is invalid");
  }
  const selected = {};
  for (const [key, sourceId] of Object.entries(LEDGER_SELECTED_INPUT_SOURCE_IDS)) {
    const head = terminalHead(sourceId, sourceSnapshots);
    const fanInRows = fanIn.selectedSources.filter((row) => row?.sourceId === sourceId);
    if (fanInRows.length !== 1) throw new Error(`nationwide candidate input is not selected by fan-in for ${sourceId}`);
    if (fanInRows[0].snapshotId !== head.snapshotId) {
      throw new Error(`nationwide candidate input fan-in selection does not match ledger head for ${sourceId}`);
    }
    const freshnessExpiresAt = fanInRows[0].freshnessExpiresAt;
    const freshUntil = Date.parse(freshnessExpiresAt);
    if (!Number.isFinite(freshUntil) || freshUntil <= evaluatedAt) {
      throw new Error(`nationwide candidate input is expired for ${sourceId}`);
    }
    const source = exactInventorySource(sourceInventory, sourceId);
    const { snapshotPath, rawSha256 } = exactSnapshotEvidence(sourceId, head.snapshotId,
      Object.values(source).filter((value) => value && typeof value === "object" && !Array.isArray(value)));
    selected[key] = {
      sourceId, snapshotId: head.snapshotId, path: snapshotPath, freshnessExpiresAt,
      bytes: await boundInputSnapshot({ sourceId, snapshotId: head.snapshotId, snapshotPath, rawSha256, ledgerHead: head, readSourceBytes }),
    };
  }
  // 인천 3개는 원장 행·fan-in 선택이 없다(원장·거버넌스 등록은 QA 라이선스 검토가 필요한 후속 이슈).
  // #862 결정 B: inventory admission evidence의 수집 시각에 정책 클래스(시간표 incheon_timetable_observation,
  // station-info route_graph_topology)를 적용해 신선도를 유도하고 후보 시계와 비교한다.
  for (const [key, [sourceId, evidenceKey]] of Object.entries(ADMISSION_EVIDENCE_INPUTS)) {
    const evidence = exactInventorySource(sourceInventory, sourceId)[evidenceKey];
    const snapshotId = evidence?.snapshotId;
    if (typeof snapshotId !== "string" || snapshotId.length === 0) {
      throw new Error(`nationwide candidate input snapshot path missing or ambiguous for ${sourceId}`);
    }
    const { snapshotPath, rawSha256 } = exactSnapshotEvidence(sourceId, snapshotId, [evidence]);
    const capturedAt = requiredInstant(evidence.capturedAt, `${sourceId} capturedAt`);
    if (Date.parse(capturedAt) > evaluatedAt) {
      throw new Error(`nationwide candidate input is observed after the candidate clock for ${sourceId}`);
    }
    // admission evidence에는 원장의 retrievedAt이 없다. capturedAt이 수집(조회) 시각이므로 두 basisField에 같은 값을 쓴다.
    const freshnessExpiresAt = policyFreshUntil({
      policy: freshnessPolicy, sourceId, record: { capturedAt, retrievedAt: capturedAt }, evaluationAt: fanIn.evaluatedAt,
    });
    if (Date.parse(freshnessExpiresAt) <= evaluatedAt) {
      throw new Error(`nationwide candidate input is expired for ${sourceId}`);
    }
    selected[key] = {
      sourceId, snapshotId, path: snapshotPath, freshnessExpiresAt,
      bytes: await boundInputSnapshot({ sourceId, snapshotId, snapshotPath, rawSha256, ledgerHead: null, readSourceBytes }),
    };
  }
  // #899: 수도권 공식 시간표(KRIC 전체_도시철도운행정보 projection)도 원장 행이 없다. inventory admission evidence가
  // 가리키는 snapshot을 쓰고, 신선도는 원천 정책 클래스(official_static_timetable_confirmation, observedAt)로 유도한다.
  // #903: 같은 원천·같은 수집의 코레일 6개 노선 projection(korailScheduleAdmissionEvidence)도 같은 규칙으로 고른다.
  for (const [key, evidenceKey] of [["capitalTimetable", CAPITAL_TIMETABLE_EVIDENCE_KEY], ["korailTimetable", KORAIL_TIMETABLE_EVIDENCE_KEY]]) {
    const sourceId = CAPITAL_TIMETABLE_SOURCE_ID;
    const evidence = exactInventorySource(sourceInventory, sourceId)[evidenceKey];
    const snapshotId = evidence?.snapshotId;
    if (typeof snapshotId !== "string" || snapshotId.length === 0) {
      throw new Error(`nationwide candidate input snapshot path missing or ambiguous for ${sourceId} ${evidenceKey}`);
    }
    const { snapshotPath, rawSha256 } = exactSnapshotEvidence(sourceId, snapshotId, [evidence]);
    const observedAt = requiredInstant(evidence.observedAt, `${sourceId} observedAt`);
    if (Date.parse(observedAt) > evaluatedAt) {
      throw new Error(`nationwide candidate input is observed after the candidate clock for ${sourceId}`);
    }
    const freshnessExpiresAt = policyFreshUntil({
      policy: freshnessPolicy, sourceId, record: { observedAt }, evaluationAt: fanIn.evaluatedAt,
    });
    if (Date.parse(freshnessExpiresAt) <= evaluatedAt) {
      throw new Error(`nationwide candidate input is expired for ${sourceId}`);
    }
    selected[key] = {
      sourceId, snapshotId, path: snapshotPath, freshnessExpiresAt,
      bytes: await boundInputSnapshot({ sourceId, snapshotId, snapshotPath, rawSha256, ledgerHead: null, readSourceBytes }),
    };
  }
  // #903: 대경선 계획 시각표·KRIC 역별 시간표 파생 스냅샷은 원장 head·fan-in으로 고르고, 스냅샷 내용 해시를
  // 원장 행·inventory evidence와 대조한다(두 스냅샷은 원본 sha를 최상위가 아닌 raw 블록에 둔다).
  for (const [key, sourceId] of Object.entries(CONTENT_BOUND_INPUT_SOURCE_IDS)) {
    const head = terminalHead(sourceId, sourceSnapshots);
    const fanInRows = fanIn.selectedSources.filter((row) => row?.sourceId === sourceId);
    if (fanInRows.length !== 1 || fanInRows[0].snapshotId !== head.snapshotId) {
      throw new Error(`nationwide candidate input fan-in selection does not match ledger head for ${sourceId}`);
    }
    const freshnessExpiresAt = fanInRows[0].freshnessExpiresAt;
    if (!(Date.parse(freshnessExpiresAt) > evaluatedAt)) throw new Error(`nationwide candidate input is expired for ${sourceId}`);
    const evidence = exactInventorySource(sourceInventory, sourceId).scheduleAdmissionEvidence;
    const snapshotPath = `tools/datapack/sources/${head.snapshotId}.json`;
    if (evidence?.snapshotId !== head.snapshotId || evidence.snapshotPath !== snapshotPath || evidence.contentSha256 !== head.contentSha256) {
      throw new Error(`nationwide candidate input admission evidence does not match ledger head for ${sourceId}`);
    }
    const bytes = await readSourceBytes(snapshotPath);
    let snapshot;
    try { snapshot = JSON.parse(bytes); } catch { throw new Error(`nationwide candidate input is invalid JSON for ${sourceId}`); }
    if (snapshot?.sourceId !== sourceId || snapshot.snapshotId !== head.snapshotId || snapshot.contentSha256 !== head.contentSha256) {
      throw new Error(`nationwide candidate input content binding mismatch for ${sourceId}`);
    }
    selected[key] = { sourceId, snapshotId: head.snapshotId, path: snapshotPath, freshnessExpiresAt, bytes: Buffer.from(bytes) };
  }
  // #913: 광주 1호선 시간표는 원장 head(fan-in 선택)가 결속한 KRIC 보관본의 계약 노선 projection이다.
  // 신선도는 보관본 head의 정책 신선도(fan-in 행)다. projection이 현재 head에서 만든 것이 아니면 실패한다.
  {
    const sourceId = RETAINED_GWANGJU_PROJECTION_SOURCE_ID;
    const head = terminalHead(sourceId, sourceSnapshots);
    const fanInRows = fanIn.selectedSources.filter((row) => row?.sourceId === sourceId);
    if (fanInRows.length !== 1 || fanInRows[0].snapshotId !== head.snapshotId) {
      throw new Error(`nationwide candidate input fan-in selection does not match ledger head for ${sourceId}`);
    }
    const freshnessExpiresAt = fanInRows[0].freshnessExpiresAt;
    if (!(Date.parse(freshnessExpiresAt) > evaluatedAt)) throw new Error(`nationwide candidate input is expired for ${sourceId} retained Gwangju`);
    const source = exactInventorySource(sourceInventory, sourceId);
    const retainedEvidence = source.retainedScheduleAdmissionEvidence;
    if (retainedEvidence?.snapshotId !== head.snapshotId) {
      throw new Error(`nationwide candidate input admission evidence does not match ledger head for ${sourceId} retained Gwangju`);
    }
    const evidence = source[RETAINED_GWANGJU_PROJECTION_EVIDENCE_KEY];
    if (typeof evidence?.snapshotPath !== "string" || evidence.snapshotPath !== `tools/datapack/sources/${evidence.snapshotId}.json`) {
      throw new Error(`nationwide candidate input snapshot path missing or ambiguous for ${sourceId} ${RETAINED_GWANGJU_PROJECTION_EVIDENCE_KEY}`);
    }
    const bytes = await readSourceBytes(evidence.snapshotPath);
    let snapshot;
    try { snapshot = JSON.parse(bytes); } catch { throw new Error(`nationwide candidate input is invalid JSON for ${sourceId} retained Gwangju`); }
    validateRetainedGwangjuProjection({ snapshot, evidence, retainedEvidence });
    const contract = head.retainedTimetableInputs?.contract;
    if (!contract || createHash("sha256").update(canonicalJson(contract)).digest("hex") !== retainedEvidence.retainedContractSha256) {
      throw new Error(`nationwide candidate retained Gwangju contract does not match the admitted head for ${sourceId}`);
    }
    selected.gwangjuTimetable = {
      sourceId, snapshotId: evidence.snapshotId, path: evidence.snapshotPath, freshnessExpiresAt, bytes: Buffer.from(bytes),
      retainedSnapshotId: head.snapshotId, contract, retainedEvidence,
    };
  }
  return selected;
}

// #862: 후보 증거의 신선도·식별자는 상수가 아니라 fan-in head(원장·정책), inventory head, 정책에서 가져온다.
function fanInHead(fanIn, sourceId) {
  const rows = (fanIn?.selectedSources ?? []).filter((row) => row?.sourceId === sourceId);
  if (rows.length !== 1) throw new Error(`nationwide candidate evidence is not selected by fan-in for ${sourceId}`);
  return rows[0];
}

function requiredInstant(value, label) {
  const millis = Date.parse(value);
  if (typeof value !== "string" || !Number.isFinite(millis)) throw new Error(`nationwide candidate ${label} is missing`);
  return value;
}

function policyFreshUntil({ policy, sourceId, record, evaluationAt }) {
  const classes = (policy?.sourceClasses ?? []).filter(({ sourceIds }) => sourceIds?.includes(sourceId));
  if (classes.length !== 1) throw new Error(`nationwide candidate freshness policy missing or ambiguous for ${sourceId}`);
  const [sourceClass] = classes;
  return deriveFreshnessExpiresAt({
    policy,
    sourceClassId: sourceClass.id,
    basisAt: requiredInstant(record?.[sourceClass.basisField], `${sourceId} ${sourceClass.basisField}`),
    providerValidUntil: sourceClass.providerValidityEndField ? record?.[sourceClass.providerValidityEndField] : undefined,
    evaluationAt,
  });
}

function policyBasisAt({ policy, sourceId, record }) {
  const classes = (policy?.sourceClasses ?? []).filter(({ sourceIds }) => sourceIds?.includes(sourceId));
  if (classes.length !== 1) throw new Error(`nationwide candidate freshness policy missing or ambiguous for ${sourceId}`);
  return requiredInstant(record?.[classes[0].basisField], `${sourceId} ${classes[0].basisField}`);
}

// MOLIT 환승 이동 원천은 원장 행이 없다. inventory rawSnapshotAdmission이 head이고, 신선도는 정책으로 유도한다.
// 유도한 freshUntil이 후보 시계 이전이면 만료로 실패한다(#862).
export async function resolveMolitTransferSnapshot({ sourceInventory, freshnessPolicy, evaluatedAt, read }) {
  const molitAdmission = exactInventorySource(sourceInventory, "molit-railway-transfer-movement").rawSnapshotAdmission;
  if (molitAdmission?.status !== "LOCKED" || typeof molitAdmission.metadataPath !== "string") {
    throw new Error("nationwide candidate MOLIT transfer snapshot admission is missing");
  }
  const molitTransferMetaBytes = await read(molitAdmission.metadataPath);
  if (sha256(molitTransferMetaBytes) !== molitAdmission.metadataFileSha256) {
    throw new Error("nationwide candidate MOLIT transfer metadata binding mismatch");
  }
  const molitTransferMeta = JSON.parse(molitTransferMetaBytes);
  if (molitTransferMeta.snapshotId !== molitAdmission.snapshotId || molitTransferMeta.rawSha256 !== molitAdmission.rawSha256
    || molitTransferMeta.gzipSha256 !== molitAdmission.gzipSha256 || typeof molitTransferMeta.gzipPath !== "string") {
    throw new Error("nationwide candidate MOLIT transfer metadata identity mismatch");
  }
  const molitTransferGzipBytes = await read(path.posix.join(path.posix.dirname(molitAdmission.metadataPath), molitTransferMeta.gzipPath));
  if (sha256(molitTransferGzipBytes) !== molitAdmission.gzipSha256) {
    throw new Error("nationwide candidate MOLIT transfer raw binding mismatch");
  }
  const evaluatedMillis = Date.parse(requiredInstant(evaluatedAt, "MOLIT transfer evaluatedAt"));
  if (Date.parse(policyBasisAt({ policy: freshnessPolicy, sourceId: "molit-railway-transfer-movement", record: molitTransferMeta })) > evaluatedMillis) {
    throw new Error("nationwide candidate MOLIT transfer snapshot is observed after the candidate clock");
  }
  const molitTransferFreshUntil = policyFreshUntil({
    policy: freshnessPolicy, sourceId: "molit-railway-transfer-movement", record: molitTransferMeta, evaluationAt: evaluatedAt,
  });
  if (molitTransferMeta.freshUntil !== molitTransferFreshUntil) {
    throw new Error("nationwide candidate MOLIT transfer freshness does not match the freshness policy");
  }
  if (Date.parse(molitTransferFreshUntil) <= evaluatedMillis) {
    throw new Error("nationwide candidate MOLIT transfer snapshot is expired");
  }
  return { admission: molitAdmission, metadata: molitTransferMeta, gzipBytes: molitTransferGzipBytes, freshUntil: molitTransferFreshUntil };
}

// #872 S3: 공식 환승 지표 원천(서울교통공사·부산교통공사)을 방향별로 모은다. 방향마다 원천 id·snapshot·검증 시각과
// 원천 시간을 함께 들고, 두 원천(또는 한 원천의 중복 행)이 같은 방향을 주장하면 어느 값도 고르지 않고 실패한다.
export function officialTransferMetricsByDirection(sources) {
  const byDirection = new Map();
  for (const { sourceId, sourceSnapshotId, lastVerifiedAt, metrics, durationOf } of sources) {
    for (const metric of metrics) {
      const key = `${metric.stationId}:${metric.fromLineId}->${metric.toLineId}`;
      if (byDirection.has(key)) throw new Error(`nationwide candidate transfer metric is claimed by two sources: ${key}`);
      byDirection.set(key, { metric, sourceId, sourceSnapshotId, lastVerifiedAt, durationSeconds: durationOf(metric) });
    }
  }
  return byDirection;
}

// #872 S3: 부산교통공사 공식 환승 지표는 fan-in이 고른 부산 원천 head snapshot에서 다시 만든 결과와 커밋된 산출물이
// 바이트까지 같고, 원천 식별(snapshot·raw·content·수집 시각)이 그 head와 같을 때만 쓴다.
export async function resolveBusanTransferMetrics({ fanIn, sourceInventory, read }) {
  const head = fanInHead(fanIn, "busan-transportation-route-topology");
  const inputs = await readBusanTransferMetricsInputs({ snapshotId: head.snapshotId, read });
  const rebuilt = Buffer.from(canonicalBusanTransferMetricsJson(buildBusanTransferMetrics({
    ...inputs, sourceInventoryBytes: Buffer.from(JSON.stringify(sourceInventory)),
  })));
  const committed = await read(BUSAN_TRANSFER_METRICS_PATH);
  if (!Buffer.isBuffer(committed) || !committed.equals(rebuilt)) {
    throw new Error("nationwide candidate Busan transfer metrics differ from the rebuild");
  }
  const artifact = JSON.parse(committed);
  const identity = artifact.sourceIdentity;
  if (identity.snapshotId !== head.snapshotId || identity.rawSha256 !== head.rawSha256
    || identity.contentSha256 !== head.contentSha256 || identity.capturedAt !== head.capturedAt) {
    throw new Error("nationwide candidate Busan transfer metrics do not match the fan-in head");
  }
  return { artifact, metrics: artifact.metrics, head };
}

// #876(QA 결정 2026-10-02): 서울교통공사_서울 도시철도 환승정보(15098252)의 실측 소요시간은 공식 환승 시간 원천이다.
// 이 원천은 fan-in 선택 집합 밖(requiredForProductionPack=false)이다. inventory admission의 snapshot이 원장 head와 같고,
// 그 snapshot으로 다시 만든 지표가 커밋된 산출물과 바이트까지 같고, 정책으로 유도한 신선도가 원장과 같고 후보 시계 이후일 때만 쓴다.
const MEASURED_TRANSFER_SOURCE_ID = "seoul-metro-transfer-car-door-duration";
const DISTANCE_TRANSFER_SOURCE_ID = "seoul-metro-transfer-distance-duration";
// #879 리뷰 F1: 후보 시계(evaluatedAt = publishedAt)는 후보가 인용하는 원문 OCI 객체의 저장 시각보다 앞설 수 없다.
export function assertCandidateClockAfterRawStorage({ evaluatedAt, stored }) {
  const evaluatedMillis = Date.parse(requiredInstant(evaluatedAt, "candidate clock"));
  for (const { sourceId, storedAt } of stored) {
    const storedMillis = Date.parse(storedAt);
    if (typeof storedAt !== "string" || !Number.isFinite(storedMillis) || new Date(storedMillis).toISOString() !== storedAt) {
      throw new Error(`nationwide candidate cited raw object storedAt is invalid: ${sourceId}`);
    }
    if (storedMillis > evaluatedMillis) {
      throw new Error(`nationwide candidate clock precedes the raw object storage of a cited source: ${sourceId}`);
    }
  }
}

export async function resolveSeoulMeasuredTransferMetrics({ sourceInventory, sourceSnapshots, freshnessPolicy, evaluatedAt, read }) {
  const admission = exactInventorySource(sourceInventory, MEASURED_TRANSFER_SOURCE_ID).admissionEvidence;
  const head = validateLineage(sourceSnapshots).headsBySource[MEASURED_TRANSFER_SOURCE_ID];
  if (typeof admission?.snapshotId !== "string" || head !== admission.snapshotId) {
    throw new Error("nationwide candidate Seoul measured transfer admission is not the ledger head");
  }
  const row = sourceSnapshots.find(({ snapshotId }) => snapshotId === head);
  const inputs = await readSeoulMeasuredTransferMetricsInputs({ snapshotId: head, read });
  const rebuilt = Buffer.from(canonicalSeoulMeasuredTransferMetricsJson(buildSeoulMeasuredTransferMetrics({
    ...inputs, sourceInventoryBytes: Buffer.from(JSON.stringify(sourceInventory)),
  })));
  const committed = await read(SEOUL_MEASURED_TRANSFER_METRICS_PATH);
  if (!Buffer.isBuffer(committed) || !committed.equals(rebuilt)) {
    throw new Error("nationwide candidate Seoul measured transfer metrics differ from the rebuild");
  }
  const artifact = JSON.parse(committed);
  const identity = artifact.sourceIdentity;
  if (identity.snapshotId !== row.snapshotId || identity.rawSha256 !== row.rawSha256
    || identity.contentSha256 !== row.contentSha256 || identity.capturedAt !== row.capturedAt) {
    throw new Error("nationwide candidate Seoul measured transfer metrics do not match the ledger head");
  }
  const snapshot = JSON.parse(inputs.snapshotBytes);
  const evaluatedMillis = Date.parse(requiredInstant(evaluatedAt, "Seoul measured transfer evaluatedAt"));
  if (Date.parse(policyBasisAt({ policy: freshnessPolicy, sourceId: MEASURED_TRANSFER_SOURCE_ID, record: snapshot })) > evaluatedMillis) {
    throw new Error("nationwide candidate Seoul measured transfer snapshot is observed after the candidate clock");
  }
  const freshUntil = policyFreshUntil({ policy: freshnessPolicy, sourceId: MEASURED_TRANSFER_SOURCE_ID, record: snapshot, evaluationAt: evaluatedAt });
  if (row.freshnessExpiresAt !== freshUntil) {
    throw new Error("nationwide candidate Seoul measured transfer freshness does not match the freshness policy");
  }
  if (Date.parse(freshUntil) <= evaluatedMillis) throw new Error("nationwide candidate Seoul measured transfer snapshot is expired");
  // #879 F1: 등록기가 보존한 OCI 영수증은 원장 영수증 hash와 같아야 하고, 그 저장 시각 이후의 후보 시계에서만 쓴다.
  const receiptBytes = await read(`tools/datapack/sources/${head}.receipt.json`);
  const receipt = JSON.parse(receiptBytes);
  if (sha256(receiptBytes) !== row.rawReceiptSha256 || receipt.sourceId !== MEASURED_TRANSFER_SOURCE_ID || receipt.snapshotId !== head
    || receipt.rawObjectUri !== row.rawObjectUri || receipt.rawObjectSha256 !== row.rawObjectSha256) {
    throw new Error("nationwide candidate Seoul measured transfer receipt does not match the ledger");
  }
  assertCandidateClockAfterRawStorage({ evaluatedAt, stored: [{ sourceId: MEASURED_TRANSFER_SOURCE_ID, storedAt: receipt.storedAt }] });
  // #876: 끝점 TRANSFER 칸의 라이선스 id는 fan-in licenseRecordSha256과 같은 기준(inventory license 레코드 hash)이다.
  const licenseRecordSha256 = sha256(canonicalJson(exactInventorySource(sourceInventory, MEASURED_TRANSFER_SOURCE_ID).license));
  if (admission.licenseEvidenceHash !== licenseRecordSha256) {
    throw new Error("nationwide candidate Seoul measured transfer license evidence does not match the inventory license");
  }
  return { artifact, metrics: artifact.metrics, row, receipt, licenseRecordSha256 };
}

// #876 메인 결정 B(2026-10-02): 실측 환승시간과 서울교통공사 거리 원천의 우선순위.
// - 두 원천이 같은 방향을 덮으면 시간은 실측 원천, 거리는 서울교통공사 공식 거리다. 행의 원천 id는 시간 원천이고,
//   거리 원천(id·snapshot·레코드 hash·표기)은 distanceSource로 함께 들고 간다. 레코드 hash는 두 원천 레코드 hash의 결속이다.
// - 거리 원천이 역방향(DERIVED_RECIPROCAL)이면 그 표기를 유지한다(경로 행 없이 route edge만, #872 D4 보완).
// - #878(QA 결정 2026-10-02, 스키마 v20 계획 대체): 실측 원천만 있는 방향은 실측 시간을 표준 보행속도(1.2 m/s, #1700 앵커)로
//   걸은 시간으로 보고 거리 = round(실측초 × 1.2)m로 유도한다. 시간은 실측 그대로다. 행 원천은 시간 원천이고,
//   유도 표기(distanceDerivation·derivationPaceMetersPerSecond)를 함께 들고 간다. 레코드 hash는 유도 표기와 실측 레코드 hash의 결속이라
//   실측 레코드 hash만 가진 행(공식 측정 거리)과 구별된다. 팩 v19에는 유도 표기 열이 없으므로 이 결속이 팩 행의 표기다.
// - 실측 0초 방향은 유도 거리도 0이다. 서버 근거 판별(거리 > 0 또는 시간 > 0)이 0/0을 버리므로 값을 만들지 않고 사용 불가로 남긴다.
// - 실측 원천이 부산교통공사 등 다른 공식 원천과 겹치면 우선순위가 정해지지 않았으므로 실패한다.
export const STANDARD_PACE_DISTANCE_DERIVATION = "STANDARD_PACE_FROM_MEASURED_TIME";
// 1.2 m/s를 정수 비율(12/10)로 곱한다. 초 × 12는 짝수라 반올림 경계(.5)가 생기지 않는다.
const STANDARD_PACE_METERS_PER_SECOND = 1.2;
const standardPaceDistanceMeters = (seconds) => Math.round((seconds * 12) / 10);
export function applyMeasuredTransferTimePrecedence({ officialByDirection, measured }) {
  const byDirection = new Map(officialByDirection);
  const derivedDistanceDirections = [];
  const unavailableDirections = [];
  const seen = new Set();
  for (const metric of measured.metrics) {
    if (metric?.distanceMeters !== null || metric.metricProvenance !== "OFFICIAL_SOURCE" || metric.measurement !== "MEASURED"
      || !Number.isSafeInteger(metric.measuredDurationSeconds) || metric.measuredDurationSeconds < 0
      || !/^[a-f0-9]{64}$/u.test(metric.sourceRecordSha256 ?? "")) {
      throw new Error("nationwide candidate measured transfer metric contract mismatch");
    }
    const key = `${metric.stationId}:${metric.fromLineId}->${metric.toLineId}`;
    if (seen.has(key)) throw new Error(`nationwide candidate measured transfer direction is duplicated: ${key}`);
    seen.add(key);
    const distance = officialByDirection.get(key);
    if (!distance) {
      const direction = { stationId: metric.stationId, fromLineId: metric.fromLineId, toLineId: metric.toLineId,
        measuredDurationSeconds: metric.measuredDurationSeconds, sourceRecordSha256: metric.sourceRecordSha256 };
      const distanceMeters = standardPaceDistanceMeters(metric.measuredDurationSeconds);
      if (distanceMeters === 0) {
        unavailableDirections.push({ ...direction, reason: "ZERO_MEASURED_DURATION" });
        continue;
      }
      derivedDistanceDirections.push({ ...direction, distanceMeters });
      byDirection.set(key, {
        metric: {
          stationId: metric.stationId,
          fromLineId: metric.fromLineId,
          toLineId: metric.toLineId,
          distanceMeters,
          metricProvenance: "OFFICIAL_SOURCE",
          sourceRecordSha256: sha256(canonicalJson({
            derivationPaceMetersPerSecond: STANDARD_PACE_METERS_PER_SECOND,
            distanceDerivation: STANDARD_PACE_DISTANCE_DERIVATION,
            durationSourceRecordSha256: metric.sourceRecordSha256,
          })),
        },
        sourceId: measured.sourceId,
        sourceSnapshotId: measured.sourceSnapshotId,
        lastVerifiedAt: measured.lastVerifiedAt,
        durationSeconds: metric.measuredDurationSeconds,
        durationSourceRecordSha256: metric.sourceRecordSha256,
        distanceDerivation: STANDARD_PACE_DISTANCE_DERIVATION,
        derivationPaceMetersPerSecond: STANDARD_PACE_METERS_PER_SECOND,
      });
      continue;
    }
    if (distance.sourceId !== DISTANCE_TRANSFER_SOURCE_ID) {
      throw new Error(`nationwide candidate measured transfer time overlaps a non-distance official source: ${key}`);
    }
    if (!Number.isSafeInteger(distance.metric.distanceMeters) || distance.metric.distanceMeters <= 0) {
      throw new Error(`nationwide candidate measured transfer distance source is invalid: ${key}`);
    }
    byDirection.set(key, {
      metric: {
        stationId: metric.stationId,
        fromLineId: metric.fromLineId,
        toLineId: metric.toLineId,
        distanceMeters: distance.metric.distanceMeters,
        metricProvenance: distance.metric.metricProvenance,
        sourceRecordSha256: sha256(canonicalJson({
          distanceSourceRecordSha256: distance.metric.sourceRecordSha256,
          durationSourceRecordSha256: metric.sourceRecordSha256,
        })),
      },
      sourceId: measured.sourceId,
      sourceSnapshotId: measured.sourceSnapshotId,
      lastVerifiedAt: measured.lastVerifiedAt,
      durationSeconds: metric.measuredDurationSeconds,
      durationSourceRecordSha256: metric.sourceRecordSha256,
      distanceSource: {
        sourceId: distance.sourceId,
        sourceSnapshotId: distance.sourceSnapshotId,
        sourceRecordSha256: distance.metric.sourceRecordSha256,
        metricProvenance: distance.metric.metricProvenance,
      },
    });
  }
  return { byDirection, derivedDistanceDirections, unavailableDirections };
}

// #876(#866 메인 결정 D1 선행): 역내 환승 간선의 끝점 TRANSFER 칸을 닫는 근거는 그 간선 방향을 실제로 뒷받침하는 공식 환승 원천의 레코드다.
// route edge가 없는 방향(실측 0초 등)과 다른 원천이 뒷받침하는 방향의 레코드는 모으지 않는다. 한 칸을 두 원천이 함께 뒷받침하면
// 우선순위가 정해지지 않았으므로 실패한다. 반환: `${stationId}\0${lineId}` → { sourceId, metrics(원천 레코드 원문) }.
export function officialTransferEndpointRecords({ edgeDirections, officialByDirection, sources }) {
  const byCell = new Map();
  for (const { sourceId, metrics } of sources) {
    for (const metric of metrics) {
      const direction = `${metric.stationId}:${metric.fromLineId}->${metric.toLineId}`;
      if (!edgeDirections.has(direction) || officialByDirection.get(direction)?.sourceId !== sourceId) continue;
      for (const lineId of [metric.fromLineId, metric.toLineId]) {
        const cell = `${metric.stationId}\0${lineId}`;
        const records = byCell.get(cell);
        if (records && records.sourceId !== sourceId) {
          throw new Error(`nationwide candidate transfer endpoint is claimed by two official transfer sources: ${metric.stationId} ${lineId}`);
        }
        if (records) records.metrics.push(metric);
        else byCell.set(cell, { sourceId, metrics: [metric] });
      }
    }
  }
  return byCell;
}

// #872 후속(#866 메인 결정 D1 선행): 역 밖 환승 링크는 링크 자체에 공식 VERIFIED 근거가 있을 때만 쓴다.
// 근거는 OFFICIAL_SOURCE·VERIFIED 표기, inventory에서 productionUseAllowed인 원천 id, 그 원천의 원장 snapshot id,
// 64자 소문자 hex 레코드 hash·evidence hash, 0보다 큰 거리·시간이다(#883 F1).
// 근거가 없는 링크는 고정 거리·시간으로 채우지 않고 끝점과 사유만 제외 목록에 남긴다(Fallback 금지, #872 D1).
export function admitOutOfStationTransferLinks(links, { sourceInventory, sourceSnapshots }) {
  const admitted = [];
  const excluded = [];
  const hash = (value) => typeof value === "string" && SHA256_PATTERN.test(value);
  const boundToLedger = (link) => (Array.isArray(sourceInventory?.sources) ? sourceInventory.sources : [])
    .filter((source) => source?.id === link.sourceId && source.productionUseAllowed === true).length === 1
    && (Array.isArray(sourceSnapshots) ? sourceSnapshots : [])
      .some((row) => row?.sourceId === link.sourceId && row.snapshotId === link.sourceSnapshotId);
  const positive = (value) => Number.isInteger(value) && value > 0;
  for (const link of links) {
    let reason = null;
    if (link.provenanceKind !== "OFFICIAL_SOURCE" || link.verificationStatus !== "VERIFIED"
      || !boundToLedger(link) || !hash(link.providerRecordHash) || !hash(link.evidenceHash)) {
      reason = "NO_OFFICIAL_VERIFIED_EVIDENCE";
    } else if (!positive(link.durationSeconds) || !positive(link.distanceMeters)) {
      reason = "NO_OFFICIAL_MEASUREMENT";
    }
    if (reason === null) {
      admitted.push(link);
      continue;
    }
    const { id, fromStationId, fromLineId, toStationId, toLineId } = link;
    excluded.push({ id, fromStationId, fromLineId, toStationId, toLineId, bidirectional: link.bidirectional === true, reason });
  }
  return { admitted, excluded };
}

// 팩에 싣는 역 밖 환승 링크. 접근성 필드는 공식 근거가 없으므로 UNKNOWN으로 두고, 출처 필드(원천·snapshot·hash·검증 표기)는 지우지 않고 보존한다(#883 F2).
export function packOutOfStationTransferLinks(links) {
  return links.map((link) => ({
    ...link,
    accessibilityStatus: "UNKNOWN",
    stairAccessState: "UNKNOWN",
    curbCutStatus: "UNKNOWN",
    sidewalkStatus: "UNKNOWN",
    crossingRisk: "UNKNOWN",
    coveredRoute: "UNKNOWN",
  }));
}

// 광주 접근성 행의 FACILITY 판정. 공식 행이 없는 유형(null)은 미관측이다. 관측된 시설이 하나도 없고
// 미관측 유형이 남아 있으면 부재로 단정하지 않고 UNKNOWN으로 막는다(#862: 휠체어리프트 0만으로
// VERIFIED_ABSENT가 되던 문제). 세 유형이 모두 0일 때만 부재다.
export function gwangjuFacilityState({ elevator, wheelchair_lift: wheelchairLift, escalator }) {
  const facilityCounts = [elevator, wheelchairLift, escalator];
  if (facilityCounts.some((count) => count > 0)) return "VERIFIED_PRESENT";
  if (facilityCounts.some((count) => count === null)) return "UNKNOWN";
  return "VERIFIED_ABSENT";
}

const REGIONAL_FACILITY_TYPES = Object.freeze({
  ELEVATOR: { slug: "elevator", labelKo: "엘리베이터" },
  ESCALATOR: { slug: "escalator", labelKo: "에스컬레이터" },
  WHEELCHAIR_LIFT: { slug: "wheelchair-lift", labelKo: "휠체어리프트" },
});

function observedSum(...values) {
  return values.some((value) => value === null || value === undefined)
    ? null
    : values.reduce((total, value) => total + value, 0);
}

// 지역 접근성 원천이 공표한 시설 종류별 count. null은 미관측(부산 원문 빈 필드)이며 0으로 바꾸지 않는다.
// 대전·광주 원천(엘리베이터·에스컬레이터 파일)에는 휠체어리프트 열이 없으므로 그 종류를 만들지 않는다.
// 이전 수집기가 저장한 wheelchair_lift 0은 관측값이 아니다(QA 승인 2026-10-02, Fallback 금지).
export function regionalFacilityTypeCounts(region, row) {
  const counts = region === "busan"
    ? [
      ["ELEVATOR", observedSum(row.el_i, row.el_o)],
      ["ESCALATOR", observedSum(row.es)],
      ["WHEELCHAIR_LIFT", observedSum(row.wl_i, row.wl_o)],
    ]
    : [
      ["ELEVATOR", observedSum(row.elevator)],
      ["ESCALATOR", observedSum(row.escalator)],
      ...(region === "daegu" ? [["WHEELCHAIR_LIFT", observedSum(row.wheelchair_lift)]] : []),
    ];
  return counts.map(([type, count]) => ({ type, count, ...REGIONAL_FACILITY_TYPES[type] }));
}

// 부산 FACILITY 판정도 광주와 같은 규칙: 관측된 양수가 있으면 존재, 미관측이 남아 있으면 UNKNOWN, 전부 0일 때만 부재.
export function busanFacilityState(observedRow) {
  const counts = Object.fromEntries(regionalFacilityTypeCounts("busan", observedRow).map(({ type, count }) => [type, count]));
  return gwangjuFacilityState({
    elevator: counts.ELEVATOR,
    wheelchair_lift: counts.WHEELCHAIR_LIFT,
    escalator: counts.ESCALATOR,
  });
}

export async function prepareNationwideCandidate({
  repositoryRoot = root,
  releaseSequence = 122,
  candidateId: candidateIdOverride = null,
  requestedBy: requestedByOption = null,
  approvedBy: approvedByOption = null,
  platformInfoMap = null,
  writeFiles = true,
} = {}) {
  const requestedBy = requestedByOption
    || process.env.DATAPACK_REQUESTED_BY
    || (process.argv.find((a) => a.startsWith("--requested-by="))?.split("=")[1]);
  const approvedBy = approvedByOption
    || process.env.DATAPACK_APPROVED_BY
    || (process.argv.find((a) => a.startsWith("--approved-by="))?.split("=")[1]);

  if (!requestedBy || typeof requestedBy !== "string" || requestedBy.trim() === "") {
    throw new Error("DATAPACK_REQUESTED_BY (--requested-by) is required");
  }
  if (!approvedBy || typeof approvedBy !== "string" || approvedBy.trim() === "") {
    throw new Error("DATAPACK_APPROVED_BY (--approved-by) is required");
  }
  if (requestedBy.trim().toLowerCase() === approvedBy.trim().toLowerCase()) {
    throw new Error(`Two-person rule violation: requester and approver cannot be the same person (${requestedBy.trim()})`);
  }

  const read = async (rel) => readFile(path.join(repositoryRoot, rel));

  const [
    targetsBytes, fanInBytes, snapshotsBytes, basePackBytes, overridesBytes, sourceInventoryBytes,
    transferMetricsBytes, freshnessPolicyBytes,
  ] = await Promise.all([
    read("tools/datapack/nationwide-coverage-targets.json"),
    read("tools/datapack/release/current-five-region-source-fan-in.json"),
    read("tools/datapack/release/source-snapshots.json"),
    read("tools/datapack/release/capital-production-canonical-pack.json"),
    read("tools/datapack/fixtures/admin-review-overrides.json"),
    read("tools/datapack/source-inventory.json"),
    read("tools/datapack/release/current-transfer-topology-metrics.json"),
    read("release/product-gates/datapack-freshness-sla.json"),
  ]);

  const targets = JSON.parse(targetsBytes);
  const fanIn = JSON.parse(fanInBytes);
  const snapshots = JSON.parse(snapshotsBytes);
  const baseFixture = JSON.parse(basePackBytes);
  const pack = baseFixture.packs[0];
  const sourceInventory = JSON.parse(sourceInventoryBytes);
  const freshnessPolicy = JSON.parse(freshnessPolicyBytes);

  const {
    admission: molitAdmission, metadata: molitTransferMeta, gzipBytes: molitTransferGzipBytes, freshUntil: molitTransferFreshUntil,
  } = await resolveMolitTransferSnapshot({
    sourceInventory, freshnessPolicy, evaluatedAt: fanIn.evaluatedAt, read,
  });

  // #879 F1: fan-in이 고른 원장 행 중 영수증 저장 시각을 담은 행도 후보 시계 이전에 저장됐어야 한다.
  const selectedSnapshotIdsForClock = new Set(fanIn.selectedSources.map(({ snapshotId }) => snapshotId));
  assertCandidateClockAfterRawStorage({
    evaluatedAt: fanIn.evaluatedAt,
    stored: snapshots.filter(({ snapshotId, rawReceipt }) => selectedSnapshotIdsForClock.has(snapshotId) && rawReceipt?.storedAt !== undefined)
      .map(({ sourceId, rawReceipt }) => ({ sourceId, storedAt: rawReceipt.storedAt })),
  });

  // 서울 환승 거리·시간은 fan-in head(원장)와 환승 지표 원천 식별이 같아야 한다.
  const seoulTransferHead = fanInHead(fanIn, "seoul-metro-transfer-distance-duration");
  const inputSnapshots = await resolveNationwideCandidateInputSnapshots({
    sourceInventory,
    sourceSnapshots: snapshots,
    fanIn,
    freshnessPolicy,
    readSourceBytes: read,
  });
  const inputJson = (key) => JSON.parse(inputSnapshots[key].bytes);
  const incheonTopology = inputJson("incheonTopology");
  const incheonLine1 = inputJson("incheonLine1");
  const incheonLine2 = inputJson("incheonLine2");
  const busanAccessibility = inputJson("busanAccessibility");
  const daeguAccessibility = inputJson("daeguAccessibility");
  const daejeonAccessibility = inputJson("daejeonAccessibility");
  const gwangjuAccessibility = inputJson("gwangjuAccessibility");
  const transferMetrics = JSON.parse(transferMetricsBytes);
  if (transferMetrics.sourceIdentity?.sourceId !== seoulTransferHead.sourceId
    || transferMetrics.sourceIdentity?.rawSha256 !== seoulTransferHead.rawSha256) {
    throw new Error("nationwide candidate Seoul transfer metrics do not match the fan-in head");
  }
  const seoulTransferCapturedAt = requiredInstant(transferMetrics.sourceIdentity.capturedAt, "Seoul transfer capturedAt");
  const busanTransfer = await resolveBusanTransferMetrics({ fanIn, sourceInventory, read });
  const kricConvenience = inputJson("kricConvenience");
  const busanTimetable = inputJson("busanTimetable");
  const daeguTimetable1 = inputJson("daeguTimetable1");
  const daeguTimetable2 = inputJson("daeguTimetable2");
  const daeguTimetable3 = inputJson("daeguTimetable3");
  const daejeonTimetable = inputJson("daejeonTimetable");
  // #913: 광주 1호선 시간표는 KRIC 보관본 projection(원장 head 결속)이다. 원천 만료가 지난 cyberstation snapshot은 쓰지 않는다.
  const gwangjuTimetable = inputSnapshots.gwangjuTimetable;
  const gwangjuRetainedRecords = JSON.parse(gwangjuTimetable.bytes).records;
  const capitalTimetable = inputJson("capitalTimetable");
  const korailTimetable = inputJson("korailTimetable");
  const daegyeongTimetable = inputJson("daegyeongTimetable");
  const stationLinesTimetable = inputJson("stationLinesTimetable");

  const molitTransferUncompressed = gunzipSync(molitTransferGzipBytes);
  const molitTransferText = new TextDecoder("euc-kr").decode(molitTransferUncompressed);
  const molitLines = molitTransferText.split(/\r?\n/).filter(Boolean);
  const molitRows = molitLines.slice(1).map((line) => {
    const parts = line.split(",");
    return {
      RAIL_OPR_ISTT_CD: parts[0],
      LN_NM: parts[1],
      STIN_NM: parts[2],
      CHTN_MV_TP_ORDR: parts[3],
      MV_CONT_DTL: parts[4],
      CHTN_MV_CONT: parts.slice(5).join(","),
    };
  });

  // 1. Prepare edges and transfer rules
  const selectedLines = new Set(targets.activeLineScopes.map((r) => r.lineId));
  const pairs = new Map();
  for (const row of pack.stationLines) {
    if (!selectedLines.has(row.lineId)) continue;
    pairs.set(JSON.stringify([row.stationId, row.lineId]), row);
  }

  // #873: 경로는 승강장(역-노선)에서 시작해 승강장에서 끝난다. 역 단위 ENTRY/EXIT 간선은 만들지 않는다.
  // 출구·엘리베이터는 역 정보(station-elevator path)로만 제공하고 경로 계산에 쓰지 않는다.

  const stationToLines = new Map();
  for (const { stationId, lineId } of pairs.values()) {
    if (!stationToLines.has(stationId)) stationToLines.set(stationId, []);
    stationToLines.get(stationId).push(lineId);
  }

  const busanDaeguTransferInfo = new Map([
    ["station-dbfe9e072d98", { molitStation: "동래", lineMapping: { "line-ab1a041f6266": "1호선", "line-d812a5bc1e5f": "4호선" } }],
    ["station-1fc7a7c971c8", { molitStation: "서면", lineMapping: { "line-ab1a041f6266": "1호선", "line-eb7b47920390": "2호선" } }],
    ["station-803200d76012", { molitStation: "연산", lineMapping: { "line-ab1a041f6266": "1호선", "line-d74614a04530": "3호선" } }],
    ["station-85f3b04485c3", { molitStation: "덕천(부산과기대)", lineMapping: { "line-d74614a04530": "3호선", "line-eb7b47920390": "2호선" } }],
    ["station-fbcc387e1db9", { molitStation: "벡스코(시립미술관)", lineMapping: { "line-eb7b47920390": "2호선", "line-f52eb59d8497": "동해선" } }],
    ["station-2d67389c6338", { molitStation: "사상(서부터미널)", lineMapping: { "line-e4cce88f0d7f": "부산김해경전철", "line-eb7b47920390": "2호선" } }],
    ["station-902ff39b9a39", { molitStation: "수영", lineMapping: { "line-d74614a04530": "3호선", "line-eb7b47920390": "2호선" } }],
    ["station-623ba7995f56", { molitStation: "거제(법원.검찰청)", lineMapping: { "line-d74614a04530": "3호선", "line-f52eb59d8497": "동해선" } }],
    ["station-e0daeeda6b37", { molitStation: "대저", lineMapping: { "line-d74614a04530": "3호선", "line-e4cce88f0d7f": "부산김해경전철" } }],
    ["station-3b042820c466", { molitStation: "미남", lineMapping: { "line-d74614a04530": "3호선", "line-d812a5bc1e5f": "4호선" } }],
    ["station-a94cb65fc5ee", { molitStation: "명덕(2.28민주운동기념회관)", lineMapping: { "line-0ffaa95b1b5d": "3호선", "line-5b8d9b05e7e6": "1호선" } }],
    ["station-44dc03b65cae", { molitStation: "반월당", lineMapping: { "line-5b8d9b05e7e6": "1호선", "line-e2938a4cc492": "2호선" } }],
    ["station-3de9d5097085", { molitStation: "청라언덕", lineMapping: { "line-0ffaa95b1b5d": "3호선", "line-e2938a4cc492": "2호선" } }],
  ]);
  const busanDaeguTransferStationIds = new Set(busanDaeguTransferInfo.keys());

  // #872 S3: 공식 환승 지표는 서울교통공사 지표와 부산교통공사 지표다. 방향마다 원천 id·snapshot·검증 시각과
  // 값(거리, 원천 시간)을 함께 들고, 두 원천이 같은 방향을 주장하면 실패한다.
  const distanceTransferMetricMap = officialTransferMetricsByDirection([
    {
      sourceId: "seoul-metro-transfer-distance-duration", sourceSnapshotId: seoulTransferHead.snapshotId,
      lastVerifiedAt: seoulTransferCapturedAt, metrics: transferMetrics.metrics, durationOf: (m) => m.officialDurationSecondsReference,
    },
    {
      sourceId: "busan-transportation-route-topology", sourceSnapshotId: busanTransfer.head.snapshotId,
      lastVerifiedAt: requiredInstant(busanTransfer.head.capturedAt, "Busan transfer capturedAt"),
      metrics: busanTransfer.metrics, durationOf: (m) => m.officialDurationSeconds,
    },
  ]);
  // #876: 실측 환승시간 원천을 우선순위 규칙으로 합친다. #878: 거리 없이 시간만 있는 방향은 표준 보행속도로 거리를 유도해 쓰고,
  // 실측 0초 방향만 사용 불가로 남는다.
  const measuredTransfer = await resolveSeoulMeasuredTransferMetrics({
    sourceInventory, sourceSnapshots: snapshots, freshnessPolicy, evaluatedAt: fanIn.evaluatedAt, read,
  });
  const { byDirection: officialTransferMetricMap } = applyMeasuredTransferTimePrecedence({
    officialByDirection: distanceTransferMetricMap,
    measured: {
      sourceId: MEASURED_TRANSFER_SOURCE_ID,
      sourceSnapshotId: measuredTransfer.row.snapshotId,
      lastVerifiedAt: requiredInstant(measuredTransfer.row.capturedAt, "Seoul measured transfer capturedAt"),
      metrics: measuredTransfer.metrics,
    },
  });

  const stationPathwayNodes = [];
  const stationPathwayEdges = [];
  const transferEdges = [];
  const transferEdgeDirections = new Set();
  const transferRules = [];

  for (const [stationId, lines] of stationToLines) {
    if (lines.length > 1) {
      for (const lineId of lines) {
        stationPathwayNodes.push({
          id: `pathway-node-${stationId}-${lineId}`,
          stationId,
          lineId,
          nodeType: "PLATFORM",
          label: `${stationId}:${lineId} 승강장`,
          level: "",
          legacyInternalRouteNodeId: "",
        });
      }

      for (let i = 0; i < lines.length; i++) {
        for (let j = 0; j < lines.length; j++) {
          if (i === j) continue;
          const fromLine = lines[i];
          const toLine = lines[j];
          const ruleId = `rule-transfer-${stationId}-${fromLine}-${toLine}`;
          const official = officialTransferMetricMap.get(`${stationId}:${fromLine}->${toLine}`);
          const officialMetric = official?.metric;

          // #872 S1: 공식 거리·시간이 없는 환승은 경로 행·route edge를 만들지 않는다. 규칙은 FK 없이 UNVERIFIED로 남겨
          // 서버가 사용 불가로 드러내게 한다. MOLIT 환승 이동 원천은 거리·시간이 없어 여기서 쓰지 않는다.
          // 무단차 간선은 공식 경로와 공식 거리가 함께 있는 원천이 생길 때만 만든다(현재 없음).
          if (!official) {
            transferRules.push({
              id: ruleId,
              fromStationId: stationId,
              fromLineId: fromLine,
              toStationId: stationId,
              toLineId: toLine,
              transferType: "IN_STATION",
              minTransferSeconds: 0,
              pathwayEdgeId: null,
              strictStepFreePathwayEdgeId: null,
              sourceId: "",
              verificationStatus: "UNVERIFIED",
            });
            continue;
          }
          if (!["OFFICIAL_SOURCE", "DERIVED_RECIPROCAL"].includes(officialMetric.metricProvenance)) {
            throw new Error(`nationwide candidate transfer metric provenance is not allowed: ${stationId} ${fromLine}->${toLine}`);
          }
          const normalized = {
            edgeId: `transfer-${stationId}-${fromLine}-${toLine}`,
            edgeType: "IN_STATION_TRANSFER",
            fromNodeId: `${stationId}:${fromLine}`,
            toNodeId: `${stationId}:${toLine}`,
            durationSeconds: official.durationSeconds,
            distanceMeters: officialMetric.distanceMeters,
            servicePattern: "",
            serviceClass: "SUBWAY",
          };
          transferEdges.push({ ...normalized, edgeSha256: routeEdgeSha256(normalized) });
          transferEdgeDirections.add(`${stationId}:${fromLine}->${toLine}`);

          // D4(보완): 역방향 값(DERIVED_RECIPROCAL)은 #350 승인대로 길찾기 route edge에만 쓴다. production pathway 계약은
          // DERIVED_RECIPROCAL을 받지 않으므로 경로 행을 만들지 않고, 규칙은 FK 없이 UNVERIFIED로 둔다.
          if (officialMetric.metricProvenance === "DERIVED_RECIPROCAL") {
            transferRules.push({
              id: ruleId,
              fromStationId: stationId,
              fromLineId: fromLine,
              toStationId: stationId,
              toLineId: toLine,
              transferType: "IN_STATION",
              minTransferSeconds: official.durationSeconds,
              pathwayEdgeId: null,
              strictStepFreePathwayEdgeId: null,
              sourceId: official.sourceId,
              verificationStatus: "UNVERIFIED",
            });
            continue;
          }

          const walkPathwayEdgeId = `pathway-edge-${stationId}-${fromLine}-${toLine}-walk`;

          stationPathwayEdges.push({
            id: walkPathwayEdgeId,
            fromNodeId: `pathway-node-${stationId}-${fromLine}`,
            toNodeId: `pathway-node-${stationId}-${toLine}`,
            edgeType: "WALK",
            durationSeconds: official.durationSeconds,
            distanceMeters: officialMetric.distanceMeters,
            bidirectional: false,
            includesStairs: false,
            requiresElevator: false,
            requiresEscalator: false,
            accessibilityStatus: "UNKNOWN",
            reliabilityScore: 100,
            sourceId: official.sourceId,
            sourceSnapshotId: official.sourceSnapshotId,
            providerRecordHash: officialMetric.sourceRecordSha256,
            provenanceKind: "OFFICIAL_SOURCE",
            verificationStatus: "VERIFIED",
            lastVerifiedAt: official.lastVerifiedAt,
            evidenceHash: officialMetric.sourceRecordSha256,
            instruction: "환승 이동 경로",
          });

          transferRules.push({
            id: ruleId,
            fromStationId: stationId,
            fromLineId: fromLine,
            toStationId: stationId,
            toLineId: toLine,
            transferType: "IN_STATION",
            minTransferSeconds: official.durationSeconds,
            pathwayEdgeId: walkPathwayEdgeId,
            strictStepFreePathwayEdgeId: null,
            sourceId: official.sourceId,
            verificationStatus: "VERIFIED",
          });
        }
      }
    }
  }

  // #876(#866 D1 선행): 실측·부산 원천이 뒷받침하는 역내 환승 간선의 끝점은 그 원천 레코드로 TRANSFER 칸을 닫는다.
  // 서울 거리 원천은 아래 기존 경로(지표가 닿는 역-노선)로 닫는다.
  const officialEndpointRecords = officialTransferEndpointRecords({
    edgeDirections: transferEdgeDirections,
    officialByDirection: officialTransferMetricMap,
    sources: [
      { sourceId: MEASURED_TRANSFER_SOURCE_ID, metrics: measuredTransfer.metrics },
      { sourceId: "busan-transportation-route-topology", metrics: busanTransfer.metrics },
    ],
  });
  const officialEndpointSources = new Map([
    [MEASURED_TRANSFER_SOURCE_ID, {
      sourceSnapshotId: measuredTransfer.row.snapshotId,
      rawSha256: measuredTransfer.row.rawSha256,
      capturedAt: requiredInstant(measuredTransfer.row.capturedAt, "Seoul measured transfer capturedAt"),
      freshUntil: measuredTransfer.row.freshnessExpiresAt,
      licenseId: measuredTransfer.licenseRecordSha256,
    }],
    ["busan-transportation-route-topology", {
      sourceSnapshotId: busanTransfer.head.snapshotId,
      rawSha256: busanTransfer.head.rawSha256,
      capturedAt: requiredInstant(busanTransfer.head.capturedAt, "Busan transfer capturedAt"),
      freshUntil: busanTransfer.head.freshnessExpiresAt,
      licenseId: busanTransfer.head.licenseRecordSha256,
    }],
  ]);

  // 역 밖 환승 후보(끝점만). 공식 거리·시간·접근성 근거가 없으므로 값을 싣지 않는다.
  // admitOutOfStationTransferLinks가 공식 VERIFIED 근거가 있는 링크만 남기고, 나머지는 제외 사유 목록으로 돌려준다(#872).
  const outOfStationTransferCandidates = [
    // 1. 수도권: 신촌 2호선 <-> 신촌 경의중앙선
    { id: "out-link-sinchon-2-to-gj", fromStationId: "station-4e123a19a88f", fromLineId: "seoul-2", toStationId: "station-d6935359840d", toLineId: "line-6e39be0cb6e2" },
    { id: "out-link-sinchon-gj-to-2", fromStationId: "station-d6935359840d", fromLineId: "line-6e39be0cb6e2", toStationId: "station-4e123a19a88f", toLineId: "seoul-2" },
    // 2. 수도권: 석남 7호선 <-> 석남 인천2호선
    { id: "out-link-seongnam-7-incheon2", fromStationId: "station-57db2f1fb4f6", fromLineId: "line-15b3b8a93259", toStationId: "station-37866f28b417", toLineId: "line-42b5805f3b5a", bidirectional: true },
    // 3. 부산권: 동래 1호선 <-> 동래 동해선
    { id: "out-link-dongnae-1-to-dh", fromStationId: "station-dbfe9e072d98", fromLineId: "line-ab1a041f6266", toStationId: "station-b65d6408d975", toLineId: "line-f52eb59d8497" },
    { id: "out-link-dongnae-dh-to-1", fromStationId: "station-b65d6408d975", fromLineId: "line-f52eb59d8497", toStationId: "station-dbfe9e072d98", toLineId: "line-ab1a041f6266" },
    // 4. 부산권: 부전 1호선 <-> 동해선
    { id: "out-link-bujeon-1-to-dh", fromStationId: "station-9acc028dded4", fromLineId: "line-ab1a041f6266", toStationId: "station-ee8407a487c2", toLineId: "line-f52eb59d8497", bidirectional: true },
    // 5. 대구권: 청라언덕 <-> 반월당
    { id: "out-link-daegu-cheongna-to-banwoldang", fromStationId: "station-3de9d5097085", fromLineId: "line-e2938a4cc492", toStationId: "station-44dc03b65cae", toLineId: "line-5b8d9b05e7e6" },
    { id: "out-link-daegu-banwoldang-to-cheongna", fromStationId: "station-44dc03b65cae", fromLineId: "line-5b8d9b05e7e6", toStationId: "station-3de9d5097085", toLineId: "line-e2938a4cc492" },
    // 6. 대전권: 서대전네거리 <-> 오룡
    { id: "out-link-daejeon-seodaejeon-to-oryong", fromStationId: "station-ee3cc9d04ee7", fromLineId: "line-7051a9c2525c", toStationId: "station-49f924643e04", toLineId: "line-7051a9c2525c" },
    { id: "out-link-daejeon-oryong-to-seodaejeon", fromStationId: "station-49f924643e04", fromLineId: "line-7051a9c2525c", toStationId: "station-ee3cc9d04ee7", toLineId: "line-7051a9c2525c" },
    // 7. 광주권: 광주송정역 <-> 도산
    { id: "out-link-gwangju-songjeong-dosan", fromStationId: "station-45d732c94df2", fromLineId: "line-e57a361e8892", toStationId: "station-25f856602c61", toLineId: "line-e57a361e8892", bidirectional: true },
  ].map((candidate) => ({ bidirectional: false, ...candidate, provenanceKind: "UNVERIFIED", verificationStatus: "UNVERIFIED" }));
  const { admitted: outOfStationTransferLinks, excluded: excludedOutOfStationTransferLinks } =
    admitOutOfStationTransferLinks(outOfStationTransferCandidates, { sourceInventory, sourceSnapshots: snapshots });

  const rides = pack.networkEdges.filter((e) => e.edgeType === "RIDE");
  const rideEdges = rides.map((edge) => {
    const normalized = {
      edgeId: edge.id,
      edgeType: edge.edgeType,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      durationSeconds: edge.durationSeconds ?? 0,
      distanceMeters: edge.distanceMeters ?? 0,
      servicePattern: edge.servicePattern ?? "LOCAL",
      serviceClass: edge.serviceClass ?? "SUBWAY",
    };
    return { ...normalized, edgeSha256: routeEdgeSha256(normalized) };
  });

  // 2. Prepare nationwide canonical pack
  const nationwideFixture = structuredClone(baseFixture);
  const nationwidePack = nationwideFixture.packs[0];
  nationwidePack.coverageLineOperatorScopes = targets.activeLineScopes;
  nationwidePack.stationPathwayNodes = stationPathwayNodes;
  nationwidePack.stationPathwayEdges = stationPathwayEdges;
  nationwidePack.transferRules = transferRules;
  const cleanOutOfStationTransferLinks = packOutOfStationTransferLinks(outOfStationTransferLinks);
  nationwidePack.outOfStationTransferLinks = cleanOutOfStationTransferLinks;
  nationwidePack.networkEdges = rides;

  // 2.1 Extract out-of-station route edges
  const outOfStationNetworkEdgesList = outOfStationTransferNetworkEdges(nationwidePack);
  const outOfStationEdges = outOfStationNetworkEdgesList.map((edge) => {
    const normalized = {
      edgeId: edge.id,
      edgeType: edge.edgeType,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      durationSeconds: edge.durationSeconds ?? 0,
      distanceMeters: edge.distanceMeters ?? 0,
      servicePattern: "",
      serviceClass: "SUBWAY",
    };
    return { ...normalized, edgeSha256: routeEdgeSha256(normalized) };
  });

  // 2.2 Preserve authentic base timetable routes, trips, stop times, and calendars,
  // excluding Incheon items which will be cleanly materialized by materializeIncheonTimetable below.
  const incheonSourceIds = new Set(["incheon-line1-train-timetable", "incheon-line2-train-timetable"]);
  nationwidePack.sourceInventory = (baseFixture.packs[0].sourceInventory ?? []).filter((s) => !incheonSourceIds.has(s.id));
  nationwidePack.serviceCalendars = (baseFixture.packs[0].serviceCalendars ?? []).filter((c) => !c.serviceId.startsWith("incheon-line"));
  nationwidePack.serviceCalendarDates = (baseFixture.packs[0].serviceCalendarDates ?? []).filter((d) => !d.serviceId.startsWith("incheon-line"));
  nationwidePack.transitRoutes = (baseFixture.packs[0].transitRoutes ?? []).filter((r) => !r.id.startsWith("route-incheon-"));
  nationwidePack.transitTrips = (baseFixture.packs[0].transitTrips ?? []).filter((t) => !t.id.startsWith("trip-incheon-"));
  nationwidePack.transitStopTimes = (baseFixture.packs[0].transitStopTimes ?? []).filter((st) => !st.tripId.startsWith("trip-incheon-"));
  nationwidePack.stationCarDoorHints = baseFixture.packs[0].stationCarDoorHints ?? [];
  // #899: 4호선 pilot(상록수·사당 2정차)은 아래 수도권 공식 시간표(4호선 전 노선)로 교체한다.
  Object.assign(nationwidePack, removeLine4PilotTimetable(nationwidePack));

  const incheonNow = new Date(Math.max(Date.parse(incheonLine1.capturedAt), Date.parse(incheonLine2.capturedAt)) + 1000);
  const materializedFixture = materializeIncheonTimetable({
    baseFixture: nationwideFixture,
    topologySnapshot: { ...incheonTopology, snapshotId: inputSnapshots.incheonTopology.snapshotId },
    timetableSnapshots: { 1: incheonLine1, 2: incheonLine2 },
    inventory: sourceInventory,
    now: incheonNow,
  });

  const finalPack = materializedFixture.packs[0];

  // #899: 수도권 공식 시간표(정차 순서를 명시한 노선)를 싣는다. 역 미매칭·노선 trip 0·격리 상한 초과는 실패한다.
  const capitalSchedule = buildCapitalOfficialTimetable({
    pack: finalPack,
    snapshot: capitalTimetable,
    inventorySource: exactInventorySource(sourceInventory, CAPITAL_TIMETABLE_SOURCE_ID),
    holidayDates: HOLIDAYS_2026,
  });
  for (const [table, rows] of Object.entries(capitalSchedule.tables)) finalPack[table] = [...finalPack[table], ...rows];
  if (finalPack.sourceInventory.some(({ id }) => id === CAPITAL_TIMETABLE_SOURCE_ID)) {
    throw new Error(`nationwide candidate pack source already exists: ${CAPITAL_TIMETABLE_SOURCE_ID}`);
  }
  finalPack.sourceInventory.push(capitalSchedule.packSource);

  // #903: 코레일 6개 노선(파일 900 역별 행 재구성)과 KRIC 역별 API 5개 노선을 같은 공용 적재기로 싣는다.
  // 역 미매칭·노선 trip 0·운행일 종류 누락·격리 상한 초과·급행 고정 집합 불일치는 실패한다.
  const kricSource = exactInventorySource(sourceInventory, CAPITAL_TIMETABLE_SOURCE_ID);
  const korailEvidence = kricSource[KORAIL_TIMETABLE_EVIDENCE_KEY];
  const korailInput = kricKorailOfficialTimetable(korailTimetable, { observedAt: korailEvidence.observedAt });
  const stationLinesSource = exactInventorySource(sourceInventory, STATION_LINES_TIMETABLE_SOURCE_ID);
  const stationLinesInput = kricStationLinesOfficialTimetable(stationLinesTimetable, stationLinesSource.scheduleAdmissionEvidence);
  const officialLineResults = [
    ["korail", korailInput, KORAIL_TIMETABLE_SERVICE_ID_PREFIX, KORAIL_TIMETABLE_TRIP_ID_PREFIX],
    ["stationLines", stationLinesInput, STATION_LINES_SERVICE_ID_PREFIX, STATION_LINES_TRIP_ID_PREFIX],
  ].map(([name, { provider, lineBindings }, serviceIdPrefix, tripIdPrefix]) => {
    const { quarantine, lineSummaries, ...tables } = materializeOfficialLineTimetables({
      pack: finalPack, provider, lineBindings, serviceIdPrefix, tripIdPrefix, holidayDates: HOLIDAYS_2026, ...OFFICIAL_LINE_CALENDAR,
    });
    for (const [table, rows] of Object.entries(tables)) finalPack[table] = [...finalPack[table], ...rows];
    return { name, provider, quarantine, lineSummaries };
  });
  // 코레일 projection은 수도권과 같은 원천·같은 관측이다: 팩 원천 항목 하나에 노선 범위를 합친다.
  if (korailEvidence.observedAt !== capitalSchedule.packSource.updatedAt) {
    throw new Error("nationwide candidate korail timetable observation differs from the capital observation of the same source");
  }
  for (const field of ["regionIds", "operatorIds", "lineIds"]) {
    capitalSchedule.packSource.coverageScope[field] = [...new Set([...capitalSchedule.packSource.coverageScope[field], ...korailEvidence.coverageScope[field]])]
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  }
  if (finalPack.sourceInventory.some(({ id }) => id === STATION_LINES_TIMETABLE_SOURCE_ID)) {
    throw new Error(`nationwide candidate pack source already exists: ${STATION_LINES_TIMETABLE_SOURCE_ID}`);
  }
  finalPack.sourceInventory.push({
    id: STATION_LINES_TIMETABLE_SOURCE_ID, owner: stationLinesSource.owner, url: stationLinesSource.datasetUrl,
    license: stationLinesSource.license.name, licenseStatus: "redistributable", redistributionAllowed: true,
    updateFrequency: stationLinesSource.updateFrequency, updatedAt: stationLinesTimetable.collectedAt,
    fields: ["service_calendar", "trip", "stop_time"], coverageScope: structuredClone(stationLinesSource.coverageScope),
  });
  const officialLineTimetableReport = {
    schemaVersion: 1,
    artifactKind: "datapack-official-line-timetable-report",
    issue: "https://github.com/AquilaXk/easysubway-data/issues/903",
    sources: officialLineResults.map(({ name, provider, quarantine, lineSummaries }) => ({
      name, sourceId: provider.sourceId, snapshotId: provider.sourceSnapshotId, rawSha256: provider.rawSha256,
      recordsSha256: provider.recordsSha256, observedAt: provider.observedAt, lines: lineSummaries,
      summary: { lineCount: lineSummaries.length, admittedTripCount: lineSummaries.reduce((sum, line) => sum + line.admittedTripCount, 0),
        quarantinedCount: quarantine.length },
      rows: quarantine,
    })),
  };

  // #903: 대경선(코레일 광역전철 계획 시각표)을 승인 snapshot 그대로 싣는다(부모 topology·원장 결속은 materializer가 검증).
  Object.assign(finalPack, materializeKorailTimetable({
    pack: finalPack, snapshot: daegyeongTimetable, inventory: sourceInventory, ledger: snapshots, now: new Date(fanIn.evaluatedAt),
  }));

  function findRegionalStationId(lineId, rawName) {
    const name = regionalProviderStationNameKey(rawName);
    const candidates = finalPack.stationLines.filter((sl) => sl.lineId === lineId);
    const found = candidates.find((sl) => {
      const st = finalPack.stations.find((s) => s.id === sl.stationId);
      return st && (cleanRegionalStationName(st.nameKo) === name);
    });
    if (!found) throw new Error(`Station not found: ${lineId} ${rawName}`);
    return found.stationId;
  }

  const busanSnapshotId = inputSnapshots.busanAccessibility.snapshotId;
  const daeguSnapshotId = inputSnapshots.daeguAccessibility.snapshotId;
  const daejeonSnapshotId = inputSnapshots.daejeonAccessibility.snapshotId;
  const gwangjuSnapshotId = inputSnapshots.gwangjuAccessibility.snapshotId;

  const regionalFacilities = [];
  const regionalEvidence = [];
  const busanObservedRows = observedBusanAccessibilityRows(busanAccessibility);

  // 1. Busan — count는 잠긴 snapshot의 보존 원문에 명시된 값만 쓴다(빈 필드는 미관측).
  for (const [rowIndex, row] of busanAccessibility.rows.entries()) {
    const stationId = findRegionalStationId(row.lineId, row.stationName);
    const stationName = finalPack.stations.find((s) => s.id === stationId)?.nameKo ?? row.stationName;
    const types = regionalFacilityTypeCounts("busan", busanObservedRows[rowIndex]);
    for (const t of types) {
      if (t.count === null) continue;
      const exists = t.count > 0;
      const providerRecordHash = sha256(JSON.stringify({
        stationCode: row.stationCode, lineId: row.lineId, type: t.type, count: t.count,
        wl_i: row.wl_i, wl_o: row.wl_o, el_i: row.el_i, el_o: row.el_o, es: row.es,
      }));
      const id = `facility-busan-${row.stationCode}-${t.slug}`;
      regionalFacilities.push({
        id,
        stationId,
        lineId: row.lineId,
        exitId: null,
        type: t.type,
        name: `${stationName}역 ${t.labelKo} 설치 정보`,
        status: "UNKNOWN",
        floorFrom: "",
        floorTo: "",
        description: exists
          ? `부산교통공사 편의시설 API 기준 ${t.labelKo} ${t.count}대 설치 정보이며 실시간 운행 상태가 아닙니다.`
          : `부산교통공사 편의시설 API 기준 ${t.labelKo} 미설치(count=0) 기록이며 실시간 운행 상태가 아닙니다.`,
        sourceId: "busan-transportation-accessibility",
        sourceSnapshotId: busanSnapshotId,
        providerFacilityRef: `busan-accessibility-${row.stationCode}-${t.slug}`,
        providerRecordHash,
        provenanceKind: "OFFICIAL_SOURCE",
        statusMeaning: "STATIC_LOCATION",
        operationalStatus: "UNKNOWN",
        installationStatus: exists ? "INSTALLED" : "NOT_INSTALLED",
        verifiedAt: busanAccessibility.capturedAt,
        retrievedAt: busanAccessibility.capturedAt,
        evidenceHash: busanAccessibility.rowsSha256,
        confidence: 80,
        derivationKind: "OFFICIAL",
        lastVerifiedAt: busanAccessibility.capturedAt,
      });
      regionalEvidence.push({
        stationId,
        lineId: row.lineId,
        facilityType: t.type,
        evidenceKind: exists ? "EXISTS" : "NOT_EXISTS",
        sourceId: "busan-transportation-accessibility",
        sourceSnapshotId: busanSnapshotId,
        providerRecordHash,
        evidenceHash: busanAccessibility.rowsSha256,
        provenanceKind: "OFFICIAL_SOURCE",
        installationStatus: exists ? "INSTALLED" : "NOT_INSTALLED",
        operationalStatus: "UNKNOWN",
        statusMeaning: "STATIC_LOCATION",
        confidence: 80,
        verifiedAt: busanAccessibility.capturedAt,
        retrievedAt: busanAccessibility.capturedAt,
        strictRouteEligible: false,
        strictRouteEligibleReason: exists ? "OPERATION_STATUS_UNKNOWN" : "FACILITY_NOT_INSTALLED",
      });
    }
  }

  // 2. Daegu
  for (const row of daeguAccessibility.rows) {
    const stationId = findRegionalStationId(row.lineId, row.stationName);
    const stationName = finalPack.stations.find((s) => s.id === stationId)?.nameKo ?? row.stationName;
    const types = regionalFacilityTypeCounts("daegu", row);
    for (const t of types) {
      if (t.count === null) continue;
      const exists = t.count > 0;
      const providerRecordHash = sha256(JSON.stringify({
        stationCode: row.stationCode, lineId: row.lineId, type: t.type, count: t.count,
        elevator: row.elevator, escalator: row.escalator, wheelchair_lift: row.wheelchair_lift,
      }));
      const id = `facility-daegu-${row.stationCode}-${t.slug}`;
      regionalFacilities.push({
        id,
        stationId,
        lineId: row.lineId,
        exitId: null,
        type: t.type,
        name: `${stationName}역 ${t.labelKo} 설치 정보`,
        status: "UNKNOWN",
        floorFrom: "",
        floorTo: "",
        description: exists
          ? `대구교통공사 역사별 장애인 편의시설 현황 기준 ${t.labelKo} ${t.count}대 설치 정보이며 실시간 운행 상태가 아닙니다.`
          : `대구교통공사 역사별 장애인 편의시설 현황 기준 ${t.labelKo} 미설치(count=0) 기록이며 실시간 운행 상태가 아닙니다.`,
        sourceId: "daegu-transportation-accessibility",
        sourceSnapshotId: daeguSnapshotId,
        providerFacilityRef: `daegu-accessibility-${row.stationCode}-${t.slug}`,
        providerRecordHash,
        provenanceKind: "OFFICIAL_SOURCE",
        statusMeaning: "STATIC_LOCATION",
        operationalStatus: "UNKNOWN",
        installationStatus: exists ? "INSTALLED" : "NOT_INSTALLED",
        verifiedAt: daeguAccessibility.capturedAt,
        retrievedAt: daeguAccessibility.capturedAt,
        evidenceHash: daeguAccessibility.rowsSha256,
        confidence: 80,
        derivationKind: "OFFICIAL",
        lastVerifiedAt: daeguAccessibility.capturedAt,
      });
      regionalEvidence.push({
        stationId,
        lineId: row.lineId,
        facilityType: t.type,
        evidenceKind: exists ? "EXISTS" : "NOT_EXISTS",
        sourceId: "daegu-transportation-accessibility",
        sourceSnapshotId: daeguSnapshotId,
        providerRecordHash,
        evidenceHash: daeguAccessibility.rowsSha256,
        provenanceKind: "OFFICIAL_SOURCE",
        installationStatus: exists ? "INSTALLED" : "NOT_INSTALLED",
        operationalStatus: "UNKNOWN",
        statusMeaning: "STATIC_LOCATION",
        confidence: 80,
        verifiedAt: daeguAccessibility.capturedAt,
        retrievedAt: daeguAccessibility.capturedAt,
        strictRouteEligible: false,
        strictRouteEligibleReason: exists ? "OPERATION_STATUS_UNKNOWN" : "FACILITY_NOT_INSTALLED",
      });
    }
  }

  // 3. Daejeon
  for (const row of daejeonAccessibility.rows) {
    const stationId = findRegionalStationId(row.lineId, row.stationName);
    const stationName = finalPack.stations.find((s) => s.id === stationId)?.nameKo ?? row.stationName;
    const types = regionalFacilityTypeCounts("daejeon", row);
    for (const t of types) {
      if (t.count === null) continue;
      const exists = t.count > 0;
      const providerRecordHash = sha256(JSON.stringify({
        stationCode: row.stationCode, lineId: row.lineId, type: t.type, count: t.count,
        elevator: row.elevator, escalator: row.escalator, wheelchair_lift: row.wheelchair_lift,
      }));
      const id = `facility-daejeon-${row.stationCode}-${t.slug}`;
      regionalFacilities.push({
        id,
        stationId,
        lineId: row.lineId,
        exitId: null,
        type: t.type,
        name: `${stationName}역 ${t.labelKo} 설치 정보`,
        status: "UNKNOWN",
        floorFrom: "",
        floorTo: "",
        description: exists
          ? `대전교통공사 역별 편의시설 현황 기준 ${t.labelKo} ${t.count}대 설치 정보이며 실시간 운행 상태가 아닙니다.`
          : `대전교통공사 역별 편의시설 현황 기준 ${t.labelKo} 미설치(count=0) 기록이며 실시간 운행 상태가 아닙니다.`,
        sourceId: "daejeon-transportation-accessibility",
        sourceSnapshotId: daejeonSnapshotId,
        providerFacilityRef: `daejeon-accessibility-${row.stationCode}-${t.slug}`,
        providerRecordHash,
        provenanceKind: "OFFICIAL_SOURCE",
        statusMeaning: "STATIC_LOCATION",
        operationalStatus: "UNKNOWN",
        installationStatus: exists ? "INSTALLED" : "NOT_INSTALLED",
        verifiedAt: daejeonAccessibility.capturedAt,
        retrievedAt: daejeonAccessibility.capturedAt,
        evidenceHash: daejeonAccessibility.rowsSha256,
        confidence: 80,
        derivationKind: "OFFICIAL",
        lastVerifiedAt: daejeonAccessibility.capturedAt,
      });
      regionalEvidence.push({
        stationId,
        lineId: row.lineId,
        facilityType: t.type,
        evidenceKind: exists ? "EXISTS" : "NOT_EXISTS",
        sourceId: "daejeon-transportation-accessibility",
        sourceSnapshotId: daejeonSnapshotId,
        providerRecordHash,
        evidenceHash: daejeonAccessibility.rowsSha256,
        provenanceKind: "OFFICIAL_SOURCE",
        installationStatus: exists ? "INSTALLED" : "NOT_INSTALLED",
        operationalStatus: "UNKNOWN",
        statusMeaning: "STATIC_LOCATION",
        confidence: 80,
        verifiedAt: daejeonAccessibility.capturedAt,
        retrievedAt: daejeonAccessibility.capturedAt,
        strictRouteEligible: false,
        strictRouteEligibleReason: exists ? "OPERATION_STATUS_UNKNOWN" : "FACILITY_NOT_INSTALLED",
      });
    }
  }

  // 4. Gwangju
  for (const row of gwangjuAccessibility.rows) {
    const stationId = findRegionalStationId(row.lineId, row.stationName);
    const stationName = finalPack.stations.find((s) => s.id === stationId)?.nameKo ?? row.stationName;
    const types = regionalFacilityTypeCounts("gwangju", row);
    for (const t of types) {
      if (t.count === null) continue;
      const exists = t.count > 0;
      const providerRecordHash = sha256(JSON.stringify({
        stationCode: row.stationCode, lineId: row.lineId, type: t.type, count: t.count,
        elevator: row.elevator, escalator: row.escalator, wheelchair_lift: row.wheelchair_lift,
      }));
      const id = `facility-gwangju-${row.stationCode}-${t.slug}`;
      regionalFacilities.push({
        id,
        stationId,
        lineId: row.lineId,
        exitId: null,
        type: t.type,
        name: `${stationName}역 ${t.labelKo} 설치 정보`,
        status: "UNKNOWN",
        floorFrom: "",
        floorTo: "",
        description: exists
          ? `광주교통공사 역사별 장애인 편의시설 현황 기준 ${t.labelKo} ${t.count}대 설치 정보이며 실시간 운행 상태가 아닙니다.`
          : `광주교통공사 역사별 장애인 편의시설 현황 기준 ${t.labelKo} 미설치(count=0) 기록이며 실시간 운행 상태가 아닙니다.`,
        sourceId: "gwangju-transportation-accessibility",
        sourceSnapshotId: gwangjuSnapshotId,
        providerFacilityRef: `gwangju-accessibility-${row.stationCode}-${t.slug}`,
        providerRecordHash,
        provenanceKind: "OFFICIAL_SOURCE",
        statusMeaning: "STATIC_LOCATION",
        operationalStatus: "UNKNOWN",
        installationStatus: exists ? "INSTALLED" : "NOT_INSTALLED",
        verifiedAt: gwangjuAccessibility.capturedAt,
        retrievedAt: gwangjuAccessibility.capturedAt,
        evidenceHash: gwangjuAccessibility.rowsSha256,
        confidence: 80,
        derivationKind: "OFFICIAL",
        lastVerifiedAt: gwangjuAccessibility.capturedAt,
      });
      regionalEvidence.push({
        stationId,
        lineId: row.lineId,
        facilityType: t.type,
        evidenceKind: exists ? "EXISTS" : "NOT_EXISTS",
        sourceId: "gwangju-transportation-accessibility",
        sourceSnapshotId: gwangjuSnapshotId,
        providerRecordHash,
        evidenceHash: gwangjuAccessibility.rowsSha256,
        provenanceKind: "OFFICIAL_SOURCE",
        installationStatus: exists ? "INSTALLED" : "NOT_INSTALLED",
        operationalStatus: "UNKNOWN",
        statusMeaning: "STATIC_LOCATION",
        confidence: 80,
        verifiedAt: gwangjuAccessibility.capturedAt,
        retrievedAt: gwangjuAccessibility.capturedAt,
        strictRouteEligible: false,
        strictRouteEligibleReason: exists ? "OPERATION_STATUS_UNKNOWN" : "FACILITY_NOT_INSTALLED",
      });
    }
  }

  finalPack.facilities.push(...regionalFacilities);
  finalPack.stationFacilityEvidence.push(...regionalEvidence);

  const packSource = (source, updatedAt) => {
    const coverageScope = structuredClone(source.coverageScope);
    if (source.id === "molit-railway-transfer-movement") {
      delete coverageScope.mappingStatus;
      coverageScope.regionIds = ["busan", "daegu"];
      coverageScope.operatorIds = ["busan-transportation", "daegu-transportation"];
      coverageScope.sourceDomains = ["indoor_movement_paths"];
    }
    return {
      id: source.id,
      owner: source.owner,
      url: source.datasetUrl,
      license: source.license.name,
      licenseStatus: "redistributable",
      redistributionAllowed: true,
      updateFrequency: source.updateFrequency,
      updatedAt,
      fields: [...source.fieldsProvided],
      coverageScope,
    };
  };

  // Integrate Regional Timetables (Busan, Daegu, Daejeon, Gwangju)
  const regionalSchedule = integrateRegionalTimetables({
    finalPack,
    busanTimetable,
    busanAccessibility,
    daeguTimetable1,
    daeguTimetable2,
    daeguTimetable3,
    daeguAccessibility,
    daejeonTimetable,
    daejeonAccessibility,
    gwangjuTimetable: null,
    gwangjuAccessibility,
  });

  finalPack.transitRoutes = regionalSchedule.transitRoutes;
  finalPack.transitTrips = regionalSchedule.transitTrips;
  finalPack.transitStopTimes = regionalSchedule.transitStopTimes;
  finalPack.serviceCalendars = regionalSchedule.serviceCalendars;
  finalPack.serviceCalendarDates = regionalSchedule.serviceCalendarDates;

  // #913: 광주 1호선 route·trip·stop_time·달력은 KRIC 보관본 계약(원장 head)과 projection 행으로 만든다.
  const gwangjuTopologyEvidence = exactInventorySource(sourceInventory, "gwangju-transportation-route-topology").topologyAdmissionEvidence;
  const gwangjuTopologyHead = fanInHead(fanIn, "gwangju-transportation-route-topology");
  if (gwangjuTopologyEvidence?.snapshotId !== gwangjuTopologyHead.snapshotId
    || gwangjuTopologyEvidence.snapshotPath !== `tools/datapack/sources/${gwangjuTopologyHead.snapshotId}.json`) {
    throw new Error("nationwide candidate Gwangju topology evidence does not match the fan-in head");
  }
  const gwangjuTopologySnapshot = JSON.parse(await read(gwangjuTopologyEvidence.snapshotPath));
  if (gwangjuTopologySnapshot.contentSha256 !== gwangjuTopologyHead.contentSha256) {
    throw new Error("nationwide candidate Gwangju topology snapshot does not match the fan-in head");
  }
  const gwangjuSchedule = buildRetainedGwangjuScheduleTables({
    records: gwangjuRetainedRecords,
    contract: gwangjuTimetable.contract,
    retainedEvidence: gwangjuTimetable.retainedEvidence,
    topologySnapshot: gwangjuTopologySnapshot,
    packStationIds: new Set(finalPack.stationLines.filter(({ lineId }) => lineId === "line-e57a361e8892").map(({ stationId }) => stationId)),
  });
  for (const table of ["transitRoutes", "transitTrips", "transitStopTimes", "serviceCalendars", "serviceCalendarDates"]) {
    finalPack[table] = [...finalPack[table], ...gwangjuSchedule[table]];
  }
  const gwangjuTopologySource = exactInventorySource(sourceInventory, "gwangju-transportation-route-topology");
  for (const field of ["regionIds", "operatorIds", "lineIds"]) {
    capitalSchedule.packSource.coverageScope[field] = [...new Set([...capitalSchedule.packSource.coverageScope[field],
      ...(gwangjuTopologySource.coverageScope?.[field] ?? [])])].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  }

  // #855: 대전·광주 원천은 역별 시각 하나만 준다. 원천 정차 2개 이상으로 열차를 만들 수 없는
  // 원천 시각은 팩에 싣지 않고 사유·식별자·개수를 격리 증거로 남긴다.
  const timetableQuarantine = [
    ...regionalSchedule.regionalTimetableQuarantine,
    // #913: 보관본 열차 묶음 중 승객 정차가 2개 미만인 묶음(차량기지 출입 등)은 trip으로 만들지 않고 여기 남긴다.
    ...gwangjuSchedule.nonRoutableGroups.map(({ identity, records, reason }) => ({
      sourceId: RETAINED_GWANGJU_PROJECTION_SOURCE_ID, sourceSnapshotId: gwangjuTimetable.retainedSnapshotId,
      trainNumber: identity.trainNumber, weekdayType: identity.weekdayType,
      originStationName: identity.originStationName, destinationStationName: identity.destinationStationName,
      sourceRowNumbers: records.map(({ sourceRowNumber }) => sourceRowNumber), reason,
    })),
  ];
  const timetableQuarantineByReason = {};
  for (const { reason } of timetableQuarantine) {
    timetableQuarantineByReason[reason] = (timetableQuarantineByReason[reason] ?? 0) + 1;
  }
  const regionalTimetableQuarantine = {
    schemaVersion: 1,
    artifactKind: "datapack-regional-timetable-quarantine",
    issue: "https://github.com/AquilaXk/easysubway-data/issues/855",
    contract: {
      stopTime: "원천 시각 하나인 정차는 arrivalSeconds = departureSeconds = 원천 값. 원천 시각이 없는 정차(종착역 도착)는 만들지 않는다.",
      references: [
        "tools/datapack/schema/catalog-schema.sql transit_stop_times arrival_seconds NOT NULL, arrival_seconds <= departure_seconds",
        "tools/datapack/reconstruct-transit-trips.mjs arrivalSeconds ?? departureSeconds",
      ],
    },
    sources: [
      { sourceId: "daejeon-train-timetable", rawSha256: daejeonTimetable.rawSha256 },
      { sourceId: RETAINED_GWANGJU_PROJECTION_SOURCE_ID, sourceSnapshotId: gwangjuTimetable.retainedSnapshotId,
        rawSha256: gwangjuTimetable.retainedEvidence.rawSha256 },
    ].map((source) => ({
      ...source,
      admittedStopTimeCount: finalPack.transitStopTimes.filter(({ sourceId, sourceSnapshotId }) => sourceId === source.sourceId
        && (source.sourceSnapshotId === undefined || sourceSnapshotId === source.sourceSnapshotId)).length,
      quarantinedCount: timetableQuarantine.filter(({ sourceId }) => sourceId === source.sourceId).length,
    })),
    summary: {
      quarantinedCount: timetableQuarantine.length,
      byReason: timetableQuarantineByReason,
    },
    rows: timetableQuarantine,
  };
  if (writeFiles) {
    await writeFile(path.join(repositoryRoot, REGIONAL_TIMETABLE_QUARANTINE_PATH), jsonBytes(regionalTimetableQuarantine));
    await writeFile(path.join(repositoryRoot, CAPITAL_TIMETABLE_REPORT_PATH), jsonBytes(capitalSchedule.report));
    await writeFile(path.join(repositoryRoot, OFFICIAL_LINE_TIMETABLE_REPORT_PATH), jsonBytes(officialLineTimetableReport));
  }

  // Expand nationwide station_car_door_hints with KRIC elevator platform door positions
  const seenCarDoorKey = new Set();
  const mergedCarDoorHints = [];
  const quarantinedCarDoorHints = [];
  let kricCarDoorHintCount = 0;

  for (const hint of (finalPack.stationCarDoorHints ?? [])) {
    const key = `${hint.stationId}:${hint.lineId}:${hint.direction}:${hint.targetFacilityType}:${hint.carNumber}:${hint.doorNumber}`;
    if (!seenCarDoorKey.has(key)) {
      seenCarDoorKey.add(key);
      mergedCarDoorHints.push(hint);
    }
  }

  for (const q of kricConvenience.queries ?? []) {
    for (const row of q.rows ?? []) {
      const loc = row.dtlLoc || "";
      if (!loc) continue;

      const parts = loc.split(/[,/]/);
      for (const part of parts) {
        const matches = [...part.matchAll(/([0-9]{1,2})\s*[-–—~]\s*([0-9]{1,2})/g)];
        for (const m of matches) {
          const car = parseInt(m[1], 10);
          const door = parseInt(m[2], 10);
          if (car >= 1 && car <= 10 && door >= 1 && door <= 10) {
            const prefix = part.slice(0, m.index);
            let direction = "BOTH";
            if (prefix.includes("상선") || prefix.includes("상행")) direction = "UP";
            else if (prefix.includes("하선") || prefix.includes("하행")) direction = "DOWN";
            else if (prefix.includes("내선")) direction = "INNER";
            else if (prefix.includes("외선")) direction = "OUTER";

            let targetFacilityType = "ELEVATOR";
            if (row.gubun === "WCLF") targetFacilityType = "WHEELCHAIR_LIFT";

            const key = `${q.stationId}:${q.lineId}:${direction}:${targetFacilityType}:${car}:${door}`;
            if (!seenCarDoorKey.has(key)) {
              seenCarDoorKey.add(key);
              const hash = sha256(canonicalJson({
                stationId: q.stationId,
                lineId: q.lineId,
                direction,
                targetFacilityType,
                carNumber: car,
                doorNumber: door,
                dtlLoc: loc,
              }));
              const hint = {
                id: `cardoor-${q.stationId}-${q.lineId}-${direction}-${targetFacilityType}-${car}-${door}-${hash.slice(0, 16)}`,
                stationId: q.stationId,
                lineId: q.lineId,
                direction,
                targetFacilityType,
                carNumber: car,
                doorNumber: door,
                sourceId: "kric-station-convenience-standard",
                sourceSnapshotId: kricConvenience.snapshotId,
                providerRecordHash: q.providerRecordHash,
                provenanceKind: "OFFICIAL_SOURCE",
                verificationStatus: "VERIFIED",
                lastVerifiedAt: kricConvenience.capturedAt,
                evidenceHash: kricConvenience.rawSha256,
              };
              kricCarDoorHintCount += 1;
              const reasons = carDoorHintContractViolations(hint);
              if (reasons.length > 0) {
                quarantinedCarDoorHints.push({
                  id: hint.id,
                  stationId: hint.stationId,
                  lineId: hint.lineId,
                  direction: hint.direction,
                  targetFacilityType: hint.targetFacilityType,
                  carNumber: hint.carNumber,
                  doorNumber: hint.doorNumber,
                  gubun: row.gubun ?? "",
                  dtlLoc: loc,
                  providerRecordHash: hint.providerRecordHash,
                  reasons,
                });
              } else {
                mergedCarDoorHints.push(hint);
              }
            }
          }
        }
      }
    }
  }

  finalPack.stationCarDoorHints = mergedCarDoorHints;

  const quarantineByReason = {};
  for (const { reasons } of quarantinedCarDoorHints) {
    for (const reason of reasons) quarantineByReason[reason] = (quarantineByReason[reason] ?? 0) + 1;
  }
  const carDoorHintQuarantine = {
    schemaVersion: 1,
    artifactKind: "datapack-car-door-hint-quarantine",
    issue: "https://github.com/AquilaXk/easysubway-data/issues/854",
    sourceId: "kric-station-convenience-standard",
    sourceSnapshotId: kricConvenience.snapshotId,
    rawSha256: kricConvenience.rawSha256,
    contract: {
      targetFacilityTypes: CAR_DOOR_HINT_FACILITY_TYPES,
      carNumber: { min: 1, max: 10 },
      doorNumber: { min: 1, max: 4 },
      directions: CAR_DOOR_HINT_DIRECTIONS,
      references: [
        "tools/datapack/schema/catalog-schema.sql station_car_door_hints CHECK",
        "tools/datapack/import-car-door-hints.mjs DIRECTION_MAP",
      ],
    },
    summary: {
      generatedCount: kricCarDoorHintCount,
      admittedCount: kricCarDoorHintCount - quarantinedCarDoorHints.length,
      quarantinedCount: quarantinedCarDoorHints.length,
      byReason: quarantineByReason,
    },
    rows: quarantinedCarDoorHints,
  };
  if (writeFiles) {
    await writeFile(path.join(repositoryRoot, CAR_DOOR_HINT_QUARANTINE_PATH), jsonBytes(carDoorHintQuarantine));
  }

  const regionalSourcesToAdd = [
    {
      id: "kric-station-platform",
      updatedAt: requiredInstant(exactInventorySource(sourceInventory, "kric-station-platform").observedDataUpdatedAt,
        "kric-station-platform observedDataUpdatedAt"),
    },
    { id: "busan-transportation-accessibility", updatedAt: busanAccessibility.capturedAt },
    { id: "busan-transportation-timetable", updatedAt: policyBasisAt({ policy: freshnessPolicy, sourceId: "busan-transportation-timetable", record: busanTimetable }) },
    { id: "daegu-transportation-accessibility", updatedAt: daeguAccessibility.capturedAt },
    { id: "daegu-line1-train-timetable", updatedAt: policyBasisAt({ policy: freshnessPolicy, sourceId: "daegu-line1-train-timetable", record: daeguTimetable1 }) },
    { id: "daegu-line2-train-timetable", updatedAt: policyBasisAt({ policy: freshnessPolicy, sourceId: "daegu-line2-train-timetable", record: daeguTimetable2 }) },
    { id: "daegu-line3-train-timetable", updatedAt: policyBasisAt({ policy: freshnessPolicy, sourceId: "daegu-line3-train-timetable", record: daeguTimetable3 }) },
    { id: "daejeon-transportation-accessibility", updatedAt: daejeonAccessibility.capturedAt },
    { id: "daejeon-train-timetable", updatedAt: policyBasisAt({ policy: freshnessPolicy, sourceId: "daejeon-train-timetable", record: daejeonTimetable }) },
    { id: "gwangju-transportation-accessibility", updatedAt: gwangjuAccessibility.capturedAt },
    { id: "molit-railway-transfer-movement", updatedAt: molitTransferMeta.capturedAt },
    // #872 S3: 부산 공식 환승 경로 행이 이 원천을 가리킨다(production pathway 계약: source_id는 팩 sourceInventory에 있어야 한다).
    { id: "busan-transportation-route-topology", updatedAt: busanTransfer.head.capturedAt },
    // #876: 실측 환승시간 원천을 시간 원천으로 인용하는 경로 행·규칙이 이 원천을 가리킨다.
    { id: MEASURED_TRANSFER_SOURCE_ID, updatedAt: measuredTransfer.row.capturedAt },
  ];

  for (const item of regionalSourcesToAdd) {
    if (!finalPack.sourceInventory.some((s) => s.id === item.id)) {
      const source = sourceInventory.sources.find((s) => s.id === item.id);
      if (!source) throw new Error(`Source not found in inventory: ${item.id}`);
      finalPack.sourceInventory.push(packSource(source, item.updatedAt));
    }
  }

  // #872 S3 리뷰 F3: 부산 원천 설명에 이 원천이 실제로 채우는 환승 표와 공식 환승 도메인을 더한다. 하드코딩하지 않고 유도한다.
  // - 필드: inventory fieldsProvided(팩 표·컬럼 이름)에, 팩에서 이 원천을 인용하는 환승 표 이름을 더한다.
  // - 도메인: inventory 도메인에, 공식 환승 거리·시간 원천(서울교통공사) inventory가 선언한 도메인을 더한다.
  // #876: 실측 환승시간 원천도 같은 규칙으로 유도한다.
  for (const transferSourceId of ["busan-transportation-route-topology", MEASURED_TRANSFER_SOURCE_ID]) {
    const transferPackSource = finalPack.sourceInventory.find(({ id }) => id === transferSourceId);
    const citingTables = [["station_pathway_edges", stationPathwayEdges], ["transfer_rules", transferRules]]
      .filter(([, rows]) => rows.some(({ sourceId }) => sourceId === transferPackSource.id))
      .map(([table]) => table);
    const transferDomains = exactInventorySource(sourceInventory, "seoul-metro-transfer-distance-duration").coverageScope?.sourceDomains;
    if (!Array.isArray(transferDomains) || transferDomains.length === 0) {
      throw new Error("nationwide candidate official transfer source domain is missing");
    }
    transferPackSource.fields = [...new Set([...transferPackSource.fields, ...citingTables])];
    transferPackSource.coverageScope.sourceDomains = [...new Set([...transferPackSource.coverageScope.sourceDomains, ...transferDomains])];
  }


  const defaultPlatformMap = buildNationwidePlatformInfoMap(finalPack);
  finalPack.stationLines = finalPack.stationLines.map((sl) => {
    const key = `${sl.stationId}:${sl.lineId}`;
    let entry = null;
    if (platformInfoMap && (platformInfoMap instanceof Map || typeof platformInfoMap === "object")) {
      const getLookup = (k) => (platformInfoMap instanceof Map ? platformInfoMap.get(k) : platformInfoMap[k]);
      entry = getLookup(key) ?? getLookup(sl.stationId);
    }
    const raw = entry || sl.platformInfo || defaultPlatformMap.get(key);
    return { ...sl, platformInfo: formatPlatformInfo(raw) };
  });

  finalPack.id = "nationwide";
  finalPack.version = "1";
  finalPack.url = "https://objectstorage.ap-seoul-1.oraclecloud.com/n/axvym6vk8g7i/b/easysubway-datapacks/o/catalog/nationwide-v1.sqlite.gz";
  finalPack.transferRules = transferRules;
  finalPack.metadata = {
    ...finalPack.metadata,
    activePack: "nationwide",
  };
  materializedFixture.manifest.activePack = { id: "nationwide", version: "1" };

  finalPack.minimumTableRows = {
    ...finalPack.minimumTableRows,
    stations: finalPack.stations.length,
    station_lines: finalPack.stationLines.length,
    facilities: finalPack.facilities.length,
    station_facility_evidence: finalPack.stationFacilityEvidence.length,
    station_pathway_nodes: stationPathwayNodes.length,
    station_pathway_edges: stationPathwayEdges.length,
    transfer_rules: transferRules.length,
    out_of_station_transfer_links: outOfStationTransferLinks.length,
    network_edges: rides.length + outOfStationEdges.length,
    transit_routes: finalPack.transitRoutes.length,
    transit_trips: finalPack.transitTrips.length,
    transit_stop_times: finalPack.transitStopTimes.length,
    service_calendars: finalPack.serviceCalendars.length,
    service_calendar_dates: finalPack.serviceCalendarDates.length,
    station_car_door_hints: finalPack.stationCarDoorHints?.length ?? 0,
  };

  materializedFixture.assemblyInputs = buildNationwideAssemblyInputs({
    baseFixtureBytes: basePackBytes,
    selectedSources: fanIn.selectedSources,
    auxiliaryInputs: {
      overrides: overridesBytes,
    },
  });

  const nationwidePackRelPath = "tools/datapack/release/nationwide-production-canonical-pack.json";
  // #899: 공식 원천(수도권 KRIC·인천 1·2호선) trip·stop_times는 결정적 gzip 파일로 분리하고 팩에는 sha·건수만 결속한다.
  // 반환하는 finalPack은 펼친 상태 그대로다(읽는 쪽은 expandExternalStopTimes로 같은 표를 얻는다).
  const officialStopTimes = buildExternalStopTimesArtifact({
    trips: finalPack.transitTrips,
    stopTimes: finalPack.transitStopTimes,
    sourceIds: EXTERNAL_TIMETABLE_SOURCE_IDS,
    // #913: 광주 보관본 trip은 열차 번호를 가진 다른 trip 형태라 외부 파일로 떼지 않고 팩에 둔다.
    inlineSourceSnapshotIds: [gwangjuTimetable.retainedSnapshotId],
  });
  const writtenFixture = {
    ...materializedFixture,
    packs: [{
      ...finalPack,
      transitTrips: officialStopTimes.inlineTrips,
      transitStopTimes: officialStopTimes.inlineStopTimes,
      [EXTERNAL_STOP_TIMES_KEY]: officialStopTimes.binding,
    }, ...materializedFixture.packs.slice(1)],
  };
  const nationwidePackBytes = Buffer.from(`${JSON.stringify(writtenFixture)}\n`);
  if (writeFiles) {
    await writeFile(path.join(repositoryRoot, OFFICIAL_STOP_TIMES_PATH), officialStopTimes.bytes);
    await writeFile(path.join(repositoryRoot, nationwidePackRelPath), nationwidePackBytes);
  }

  // 3. Prepare route edges
  const routeEdges = [...transferEdges, ...outOfStationEdges, ...rideEdges]
    .sort((a, b) => Buffer.compare(Buffer.from(a.edgeId), Buffer.from(b.edgeId)));

  const selectedSnapshotIds = new Set(fanIn.selectedSources.map((s) => s.snapshotId));
  const selectedSnapshots = snapshots.filter((s) => selectedSnapshotIds.has(s.snapshotId));
  const sourceSetSha256 = sha256(JSON.stringify(selectedSnapshots));

  const stationIds = [...new Set(finalPack.stations.map((s) => s.id))].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const stationSetSha256 = sha256(JSON.stringify(stationIds));
  const topologySha256 = canonicalRideEdgeSetSha256(rideEdges);

  // 후보 ID 날짜는 후보 시계(fan-in evaluatedAt = publishedAt)의 UTC 날짜다.
  const candidateDate = requiredInstant(fanIn.evaluatedAt, "fan-in evaluatedAt").slice(0, 10).replaceAll("-", "");
  const candidateId = candidateIdOverride ?? `nationwide-candidate-${candidateDate}-seq${releaseSequence}`;
  const scopeId = "nationwide_routing_android_v1";

  const lineOperatorMap = new Map(finalPack.lines.map((l) => [l.id, l.operatorId]));

  const stationLinesForRoute = [...pairs.values()].map(({ stationId, lineId, lineSequence }) => ({
    stationId,
    lineId,
    operatorId: lineOperatorMap.get(lineId),
    lineSequence,
  })).sort((a, b) => Buffer.compare(Buffer.from(a.stationId), Buffer.from(b.stationId))
    || Buffer.compare(Buffer.from(a.lineId), Buffer.from(b.lineId)));

  const routeInput = {
    candidate: {
      candidateId,
      evaluatorVersion: "1",
      policyVersion: "route-edge-evaluation-v2",
      sourceSetSha256,
      stationSetSha256,
      topologySha256,
    },
    stationLines: stationLinesForRoute,
    routeEdges,
  };

  const routeInputRelPath = "tools/datapack/release/nationwide-route-edge-input.json";
  const routeInputBytes = Buffer.from(canonicalCurrentCapitalRouteEdgeInputJson(routeInput));
  if (writeFiles) {
    await writeFile(path.join(repositoryRoot, routeInputRelPath), routeInputBytes);
  }

  // 3.1 Prepare nationwide station-line input with complete accessibility evidence rows
  const stationLinesForAccessibility = [...pairs.values()].map(({ stationId, lineId }) => ({
    stationId,
    lineId,
    operatorId: lineOperatorMap.get(lineId),
  })).sort((a, b) => Buffer.compare(Buffer.from(a.stationId), Buffer.from(b.stationId))
    || Buffer.compare(Buffer.from(a.lineId), Buffer.from(b.lineId)));

  const stationLineCandidate = {
    candidateId,
    mappingContractVersion: "station-line-v1",
    materializerVersion: "1",
    sourceSetSha256,
    stationSetSha256,
  };

  const kricConvenienceRawSha = kricConvenience.rawSha256;
  const kricConvenienceLicenseId = fanInHead(fanIn, "kric-station-convenience-standard").licenseRecordSha256;
  const kricConvenienceCapturedAt = kricConvenience.capturedAt;
  const kricConvenienceFreshUntil = inputSnapshots.kricConvenience.freshnessExpiresAt;

  const seoulTransferRawSha = seoulTransferHead.rawSha256;
  const seoulTransferLicenseId = seoulTransferHead.licenseRecordSha256;
  const seoulTransferSnapshotId = seoulTransferHead.snapshotId;
  const seoulTransferFreshUntil = seoulTransferHead.freshnessExpiresAt;

  const molitTransferRawSha = molitAdmission.rawSha256;
  const molitTransferLicenseId = molitTransferMeta.licenseSha256;
  const molitTransferCapturedAt = molitTransferMeta.capturedAt;

  const regionalAccessibility = (key, sourceId, snapshot) => ({
    rawSha: snapshot.rawSha256,
    licenseId: fanInHead(fanIn, sourceId).licenseRecordSha256,
    capturedAt: snapshot.capturedAt,
    freshUntil: inputSnapshots[key].freshnessExpiresAt,
  });
  const busan = regionalAccessibility("busanAccessibility", "busan-transportation-accessibility", busanAccessibility);
  const daegu = regionalAccessibility("daeguAccessibility", "daegu-transportation-accessibility", daeguAccessibility);
  const daejeon = regionalAccessibility("daejeonAccessibility", "daejeon-transportation-accessibility", daejeonAccessibility);
  const gwangju = regionalAccessibility("gwangjuAccessibility", "gwangju-transportation-accessibility", gwangjuAccessibility);
  const { rawSha: busanRawSha, licenseId: busanLicenseId, capturedAt: busanCapturedAt, freshUntil: busanFreshUntil } = busan;
  const { rawSha: daeguRawSha, licenseId: daeguLicenseId, capturedAt: daeguCapturedAt, freshUntil: daeguFreshUntil } = daegu;
  const { rawSha: daejeonRawSha, licenseId: daejeonLicenseId, capturedAt: daejeonCapturedAt, freshUntil: daejeonFreshUntil } = daejeon;
  const { rawSha: gwangjuRawSha, licenseId: gwangjuLicenseId, capturedAt: gwangjuCapturedAt, freshUntil: gwangjuFreshUntil } = gwangju;

  const busanMap = new Map(busanAccessibility.rows.map((r) => [`${findRegionalStationId(r.lineId, r.stationName)}\0${r.lineId}`, r]));
  const busanObservedByCode = new Map(observedBusanAccessibilityRows(busanAccessibility).map((r) => [r.stationCode, r]));
  const daeguMap = new Map(daeguAccessibility.rows.map((r) => [`${findRegionalStationId(r.lineId, r.stationName)}\0${r.lineId}`, r]));
  const daejeonMap = new Map(daejeonAccessibility.rows.map((r) => [`${findRegionalStationId(r.lineId, r.stationName)}\0${r.lineId}`, r]));
  const gwangjuMap = new Map(gwangjuAccessibility.rows.map((r) => [`${findRegionalStationId(r.lineId, r.stationName)}\0${r.lineId}`, r]));
  const kricMap = new Map((kricConvenience.queries ?? []).map((q) => [`${q.stationId}\0${q.lineId}`, q]));

  // 제외된 역 밖 환승 후보의 끝점도 환승역으로 본다. 근거가 없으므로 TRANSFER 칸은 환승 없음이 아니라 사용 불가로 남는다(#872).
  const outOfStationTransferStationIds = new Set(
    outOfStationTransferCandidates.flatMap((l) => [l.fromStationId, l.toStationId])
  );

  const evidenceRows = [];
  for (const { stationId, lineId, operatorId } of stationLinesForAccessibility) {
    const key = `${stationId}\0${lineId}`;

    // FACILITY
    if (kricMap.has(key)) {
      const q = kricMap.get(key);
      if (q.status === "UNVERIFIED_EVIDENCE_BLOCKED") {
        evidenceRows.push({
          ...stationLineCandidate,
          stationId,
          lineId,
          operatorId,
          domain: "FACILITY",
          state: "UNKNOWN",
          sourceId: "kric-station-convenience-standard",
          sourceSnapshotId: inputSnapshots.kricConvenience.snapshotId,
          evidenceRawSha256: kricConvenienceRawSha,
          providerRecordHash: sha256(canonicalJson({ stationId, lineId, domain: "FACILITY", state: "UNKNOWN" })),
          capturedAt: kricConvenienceCapturedAt,
          freshUntil: kricConvenienceFreshUntil,
          provenanceId: kricConvenienceRawSha,
          licenseId: kricConvenienceLicenseId,
          mappingContractVersion: "station-line-v1",
          materializerVersion: "1",
          evidenceKind: "PROVIDER_NO_DATA",
          evidenceReason: "UNVERIFIED_PROVIDER_EVIDENCE_BLOCKED",
        });
      } else {
        evidenceRows.push({
          ...stationLineCandidate,
          stationId,
          lineId,
          operatorId,
          domain: "FACILITY",
          state: "VERIFIED_PRESENT",
          sourceId: "kric-station-convenience-standard",
          sourceSnapshotId: inputSnapshots.kricConvenience.snapshotId,
          evidenceRawSha256: kricConvenienceRawSha,
          providerRecordHash: q.providerRecordHash,
          capturedAt: kricConvenienceCapturedAt,
          freshUntil: kricConvenienceFreshUntil,
          provenanceId: kricConvenienceRawSha,
          licenseId: kricConvenienceLicenseId,
          mappingContractVersion: "station-line-v1",
          materializerVersion: "1",
          evidenceKind: "OBSERVED",
          evidenceReason: "OFFICIAL_FACILITY_OBSERVED",
        });
      }
    } else if (busanMap.has(key)) {
      const r = busanMap.get(key);
      const facilityState = busanFacilityState(busanObservedByCode.get(r.stationCode));
      if (facilityState === "UNKNOWN") {
        evidenceRows.push({
          ...stationLineCandidate,
          stationId,
          lineId,
          operatorId,
          domain: "FACILITY",
          state: "UNKNOWN",
          sourceId: "busan-transportation-accessibility",
          sourceSnapshotId: busanSnapshotId,
          evidenceRawSha256: busanRawSha,
          providerRecordHash: sha256(canonicalJson({ stationId, lineId, domain: "FACILITY", state: "UNKNOWN" })),
          capturedAt: busanCapturedAt,
          freshUntil: busanFreshUntil,
          provenanceId: busanRawSha,
          licenseId: busanLicenseId,
          mappingContractVersion: "station-line-v1",
          materializerVersion: "1",
          evidenceKind: "PROVIDER_NO_DATA",
          evidenceReason: "UNVERIFIED_PROVIDER_EVIDENCE_BLOCKED",
        });
      } else {
        const hasFac = facilityState === "VERIFIED_PRESENT";
        evidenceRows.push({
          ...stationLineCandidate,
          stationId,
          lineId,
          operatorId,
          domain: "FACILITY",
          state: hasFac ? "VERIFIED_PRESENT" : "VERIFIED_ABSENT",
          sourceId: "busan-transportation-accessibility",
          sourceSnapshotId: busanSnapshotId,
          evidenceRawSha256: busanRawSha,
          providerRecordHash: sha256(canonicalJson(r)),
          capturedAt: busanCapturedAt,
          freshUntil: busanFreshUntil,
          provenanceId: busanRawSha,
          licenseId: busanLicenseId,
          mappingContractVersion: "station-line-v1",
          materializerVersion: "1",
          evidenceKind: hasFac ? "OBSERVED" : "EXPLICIT_ZERO",
          evidenceReason: hasFac ? "OFFICIAL_FACILITY_OBSERVED" : "OFFICIAL_FACILITY_ZERO_RECORD",
        });
      }
    } else if (daeguMap.has(key)) {
      const r = daeguMap.get(key);
      const hasFac = (r.elevator > 0) || (r.wheelchair_lift > 0) || (r.escalator > 0);
      evidenceRows.push({
        ...stationLineCandidate,
        stationId,
        lineId,
        operatorId,
        domain: "FACILITY",
        state: hasFac ? "VERIFIED_PRESENT" : "VERIFIED_ABSENT",
        sourceId: "daegu-transportation-accessibility",
        sourceSnapshotId: daeguSnapshotId,
        evidenceRawSha256: daeguRawSha,
        providerRecordHash: sha256(canonicalJson(r)),
        capturedAt: daeguCapturedAt,
        freshUntil: daeguFreshUntil,
        provenanceId: daeguRawSha,
        licenseId: daeguLicenseId,
        mappingContractVersion: "station-line-v1",
        materializerVersion: "1",
        evidenceKind: hasFac ? "OBSERVED" : "EXPLICIT_ZERO",
        evidenceReason: hasFac ? "OFFICIAL_FACILITY_OBSERVED" : "OFFICIAL_FACILITY_ZERO_RECORD",
      });
    } else if (daejeonMap.has(key)) {
      const r = daejeonMap.get(key);
      const hasFac = (r.elevator > 0) || (r.wheelchair_lift > 0) || (r.escalator > 0);
      evidenceRows.push({
        ...stationLineCandidate,
        stationId,
        lineId,
        operatorId,
        domain: "FACILITY",
        state: hasFac ? "VERIFIED_PRESENT" : "VERIFIED_ABSENT",
        sourceId: "daejeon-transportation-accessibility",
        sourceSnapshotId: daejeonSnapshotId,
        evidenceRawSha256: daejeonRawSha,
        providerRecordHash: sha256(canonicalJson(r)),
        capturedAt: daejeonCapturedAt,
        freshUntil: daejeonFreshUntil,
        provenanceId: daejeonRawSha,
        licenseId: daejeonLicenseId,
        mappingContractVersion: "station-line-v1",
        materializerVersion: "1",
        evidenceKind: hasFac ? "OBSERVED" : "EXPLICIT_ZERO",
        evidenceReason: hasFac ? "OFFICIAL_FACILITY_OBSERVED" : "OFFICIAL_FACILITY_ZERO_RECORD",
      });
    } else if (gwangjuMap.has(key)) {
      const r = gwangjuMap.get(key);
      const facilityState = gwangjuFacilityState(r);
      if (facilityState === "UNKNOWN") {
        evidenceRows.push({
          ...stationLineCandidate,
          stationId,
          lineId,
          operatorId,
          domain: "FACILITY",
          state: "UNKNOWN",
          sourceId: "gwangju-transportation-accessibility",
          sourceSnapshotId: gwangjuSnapshotId,
          evidenceRawSha256: gwangjuRawSha,
          providerRecordHash: sha256(canonicalJson({ stationId, lineId, domain: "FACILITY", state: "UNKNOWN" })),
          capturedAt: gwangjuCapturedAt,
          freshUntil: gwangjuFreshUntil,
          provenanceId: gwangjuRawSha,
          licenseId: gwangjuLicenseId,
          mappingContractVersion: "station-line-v1",
          materializerVersion: "1",
          evidenceKind: "PROVIDER_NO_DATA",
          evidenceReason: "UNVERIFIED_PROVIDER_EVIDENCE_BLOCKED",
        });
      } else {
        const hasFac = facilityState === "VERIFIED_PRESENT";
        evidenceRows.push({
          ...stationLineCandidate,
          stationId,
          lineId,
          operatorId,
          domain: "FACILITY",
          state: facilityState,
          sourceId: "gwangju-transportation-accessibility",
          sourceSnapshotId: gwangjuSnapshotId,
          evidenceRawSha256: gwangjuRawSha,
          providerRecordHash: sha256(canonicalJson(r)),
          capturedAt: gwangjuCapturedAt,
          freshUntil: gwangjuFreshUntil,
          provenanceId: gwangjuRawSha,
          licenseId: gwangjuLicenseId,
          mappingContractVersion: "station-line-v1",
          materializerVersion: "1",
          evidenceKind: hasFac ? "OBSERVED" : "EXPLICIT_ZERO",
          evidenceReason: hasFac ? "OFFICIAL_FACILITY_OBSERVED" : "OFFICIAL_FACILITY_ZERO_RECORD",
        });
      }
    } else {
      evidenceRows.push({
        ...stationLineCandidate,
        stationId,
        lineId,
        operatorId,
        domain: "FACILITY",
        state: "UNKNOWN",
        sourceId: "kric-station-convenience-standard",
        sourceSnapshotId: inputSnapshots.kricConvenience.snapshotId,
        evidenceRawSha256: kricConvenienceRawSha,
        providerRecordHash: sha256(canonicalJson({ stationId, lineId, domain: "FACILITY", state: "UNKNOWN" })),
        capturedAt: kricConvenienceCapturedAt,
        freshUntil: kricConvenienceFreshUntil,
        provenanceId: kricConvenienceRawSha,
        licenseId: kricConvenienceLicenseId,
        mappingContractVersion: "station-line-v1",
        materializerVersion: "1",
        evidenceKind: "PROVIDER_NO_DATA",
        evidenceReason: "FACILITY_DATA_NOT_PROVIDED",
      });
    }

    // EXIT: #873 승강장 기준 경로에서는 출구 이동 증거를 경로 판단에 쓰지 않는다. 원장 근거 없는 하드코딩 행을 만들지 않는다.

    // TRANSFER
    const isTransfer = (stationToLines.get(stationId)?.length ?? 0) > 1 || outOfStationTransferStationIds.has(stationId);
    const isBusanDaeguTransfer = busanDaeguTransferStationIds.has(stationId);
    const matchedMetrics = (transferMetrics?.metrics ?? []).filter(
      (m) => m.stationId === stationId && (m.fromLineId === lineId || m.toLineId === lineId)
    );
    const endpointRecords = officialEndpointRecords.get(key);
    if (!isTransfer) {
      evidenceRows.push({
        ...stationLineCandidate,
        stationId,
        lineId,
        operatorId,
        domain: "TRANSFER",
        state: "NOT_APPLICABLE",
        sourceId: "seoul-metro-transfer-distance-duration",
        sourceSnapshotId: seoulTransferSnapshotId,
        evidenceRawSha256: seoulTransferRawSha,
        providerRecordHash: sha256(canonicalJson({ stationId, lineId, domain: "TRANSFER", state: "NOT_APPLICABLE" })),
        capturedAt: seoulTransferCapturedAt,
        freshUntil: seoulTransferFreshUntil,
        provenanceId: seoulTransferRawSha,
        licenseId: seoulTransferLicenseId,
        mappingContractVersion: "station-line-v1",
        materializerVersion: "1",
        evidenceKind: "CURRENT_APPLICABILITY_RULE",
        evidenceReason: "canonical transfer applicability",
      });
    } else if (endpointRecords && matchedMetrics.length === 0) {
      // #876: 서울 거리 지표가 닿지 않는 끝점은 간선을 뒷받침하는 실측·부산 원천 레코드로 닫는다. 부산 환승 간선 끝점은
      // MOLIT 환승 존재 대신 부산교통공사 공식 레코드가 근거다(#872: MOLIT는 새 근거로 쓰지 않는다).
      const source = officialEndpointSources.get(endpointRecords.sourceId);
      evidenceRows.push({
        ...stationLineCandidate,
        stationId,
        lineId,
        operatorId,
        domain: "TRANSFER",
        state: "VERIFIED_PRESENT",
        sourceId: endpointRecords.sourceId,
        sourceSnapshotId: source.sourceSnapshotId,
        evidenceRawSha256: source.rawSha256,
        providerRecordHash: sha256(canonicalJson(endpointRecords.metrics)),
        capturedAt: source.capturedAt,
        freshUntil: source.freshUntil,
        provenanceId: source.rawSha256,
        licenseId: source.licenseId,
        mappingContractVersion: "station-line-v1",
        materializerVersion: "1",
        evidenceKind: "OBSERVED",
        evidenceReason: "OFFICIAL_TRANSFER_TOPOLOGY_PRESENT",
      });
    } else if (isBusanDaeguTransfer) {
      const info = busanDaeguTransferInfo.get(stationId);
      const molitLine = info?.lineMapping[lineId];
      let lineMatched = molitRows.filter((r) => r.STIN_NM === info?.molitStation && r.LN_NM === molitLine);
      if (lineMatched.length === 0) {
        lineMatched = molitRows.filter((r) => r.STIN_NM === info?.molitStation);
      }
      const transferLineRecordHash = sha256(canonicalJson(lineMatched));

      evidenceRows.push({
        ...stationLineCandidate,
        stationId,
        lineId,
        operatorId,
        domain: "TRANSFER",
        state: "VERIFIED_PRESENT",
        sourceId: "molit-railway-transfer-movement",
        sourceSnapshotId: molitAdmission.snapshotId,
        evidenceRawSha256: molitTransferRawSha,
        providerRecordHash: transferLineRecordHash,
        capturedAt: molitTransferCapturedAt,
        freshUntil: molitTransferFreshUntil,
        provenanceId: molitTransferRawSha,
        licenseId: molitTransferLicenseId,
        mappingContractVersion: "station-line-v1",
        materializerVersion: "1",
        evidenceKind: "OBSERVED",
        evidenceReason: "OFFICIAL_TRANSFER_TOPOLOGY_PRESENT",
      });
    } else {
      if (matchedMetrics.length > 0) {
        evidenceRows.push({
          ...stationLineCandidate,
          stationId,
          lineId,
          operatorId,
          domain: "TRANSFER",
          state: "VERIFIED_PRESENT",
          sourceId: "seoul-metro-transfer-distance-duration",
          sourceSnapshotId: seoulTransferSnapshotId,
          evidenceRawSha256: seoulTransferRawSha,
          providerRecordHash: sha256(canonicalJson(matchedMetrics)),
          capturedAt: seoulTransferCapturedAt,
          freshUntil: seoulTransferFreshUntil,
          provenanceId: seoulTransferRawSha,
          licenseId: seoulTransferLicenseId,
          mappingContractVersion: "station-line-v1",
          materializerVersion: "1",
          evidenceKind: "OBSERVED",
          evidenceReason: "OFFICIAL_TRANSFER_TOPOLOGY_PRESENT",
        });
      } else {
        evidenceRows.push({
          ...stationLineCandidate,
          stationId,
          lineId,
          operatorId,
          domain: "TRANSFER",
          state: "UNKNOWN",
          sourceId: "seoul-metro-transfer-distance-duration",
          sourceSnapshotId: seoulTransferSnapshotId,
          evidenceRawSha256: seoulTransferRawSha,
          providerRecordHash: sha256(canonicalJson({ stationId, lineId, domain: "TRANSFER", state: "UNKNOWN" })),
          capturedAt: seoulTransferCapturedAt,
          freshUntil: seoulTransferFreshUntil,
          provenanceId: seoulTransferRawSha,
          licenseId: seoulTransferLicenseId,
          mappingContractVersion: "station-line-v1",
          materializerVersion: "1",
          evidenceKind: "PROVIDER_NO_DATA",
          evidenceReason: "TRANSFER_DATA_NOT_PROVIDED",
        });
      }
    }
  }

  const stationLineInput = {
    candidate: stationLineCandidate,
    stationLines: stationLinesForAccessibility,
    evidenceRows,
  };

  const stationLineInputRelPath = "tools/datapack/release/nationwide-station-line-input.json";
  const stationLineInputBytes = Buffer.from(canonicalCurrentCapitalStationLineInputJson(stationLineInput));
  if (writeFiles) {
    await writeFile(path.join(repositoryRoot, stationLineInputRelPath), stationLineInputBytes);
  }

  const gitBin = process.env.GIT_BIN || "git";
  let gitSha;
  try {
    gitSha = execFileSync(gitBin, ["rev-parse", "HEAD"], { cwd: repositoryRoot }).toString().trim();
  } catch (err) {
    throw new Error(`Failed to resolve git HEAD commit in ${repositoryRoot}: ${err.message}`);
  }
  if (!/^[0-9a-f]{40}$/.test(gitSha)) {
    throw new Error(`Invalid git HEAD commit sha: "${gitSha}"`);
  }

  // 수도권 topology 네트워크 증거: fan-in head → inventory admission → 재검증 증거(공식 도구의 파일 이름 규칙) → 기준 snapshot.
  const capitalHead = fanInHead(fanIn, "capital-route-topology");
  const capitalAdmissionEvidence = exactInventorySource(sourceInventory, "capital-route-topology").capitalTopologyAdmissionEvidence;
  const capitalCandidatePath = `tools/datapack/sources/${capitalHead.snapshotId}.json`;
  if (capitalAdmissionEvidence?.snapshotId !== capitalHead.snapshotId || capitalAdmissionEvidence.snapshotPath !== capitalCandidatePath) {
    throw new Error("nationwide candidate capital topology admission does not match the fan-in head");
  }
  const capitalCandidateBytes = await read(capitalCandidatePath);
  const capitalCandidate = JSON.parse(capitalCandidateBytes);
  if (sha256(capitalCandidateBytes) !== capitalAdmissionEvidence.snapshotFileSha256
    || capitalCandidate.contentSha256 !== capitalHead.contentSha256) {
    throw new Error("nationwide candidate capital topology snapshot binding mismatch");
  }
  const capitalReverificationPath = capitalTopologyReverificationPathForSnapshotId(capitalHead.snapshotId);
  const capitalReverificationBytes = await read(capitalReverificationPath);
  const capitalReverification = JSON.parse(capitalReverificationBytes);
  if (capitalReverification.candidate?.contentSha256 !== capitalHead.contentSha256
    || capitalReverification.candidate?.capturedAt !== capitalCandidate.capturedAt
    || typeof capitalReverification.baseline?.snapshotId !== "string") {
    throw new Error("nationwide candidate capital topology reverification does not match the fan-in head");
  }
  const capitalBaselinePath = `tools/datapack/sources/${capitalReverification.baseline.snapshotId}.json`;
  const capitalBaselineBytes = await read(capitalBaselinePath);

  const itxCoverageContractPath = "tools/datapack/itx-cheongchun-coverage-contract.json";
  const itxCoverageContractBytes = await read(itxCoverageContractPath);
  const itxTopologyEvidencePath = deriveApprovedItxTopologyEvidencePath(
    JSON.parse(itxCoverageContractBytes).sourceTimetableArtifact,
  );
  const itxTopologyEvidenceBytes = await read(itxTopologyEvidencePath);

  // 공식 OD 운임 증거: 팩에 실린 quote의 원천 admission(승인 묶음)에서 build-datapack이 검증하는 전체 형태로 만든다.
  const odFareAdmissionBytes = await read("tools/datapack/official-od-fare-admission.json");
  const odFareQuoteSourceIds = [...new Set((finalPack.officialOdFareQuotes ?? []).map(({ sourceId }) => sourceId))];
  if (odFareQuoteSourceIds.length !== 1) throw new Error("nationwide candidate official OD fare quotes must come from one source");
  const [odFareSourceId] = odFareQuoteSourceIds;
  const odFareAdmission = officialOdFareAdmissionsBySource(JSON.parse(odFareAdmissionBytes)).get(odFareSourceId);
  const odFareQuotes = finalPack.officialOdFareQuotes.filter(({ sourceId }) => sourceId === odFareSourceId);
  if (odFareAdmission?.decision !== "APPROVED" || odFareQuotes.length !== odFareAdmission.quoteCount
    || officialOdFareQuoteSetHash(odFareQuotes) !== odFareAdmission.quoteSetHash
    || odFareQuotes.some(({ snapshotId }) => snapshotId !== odFareAdmission.snapshotId)) {
    throw new Error("nationwide candidate official OD fare quotes do not match the approved admission");
  }

  const preparation = {
    schemaVersion: 1,
    artifactKind: "nationwide-candidate-preparation",
    scopeId,
    materialization: {
      fixturePath: nationwidePackRelPath,
      overridesPath: "tools/datapack/fixtures/admin-review-overrides.json",
      assemblySourceIds: fanIn.selectedSources.map((s) => s.sourceId),
      networkEdgeEvidence: {
        capitalTopology: {
          path: capitalBaselinePath,
          sha256: sha256(capitalBaselineBytes),
          snapshotId: capitalReverification.baseline.snapshotId,
        },
        capitalTopologyCandidate: {
          path: capitalCandidatePath,
          sha256: sha256(capitalCandidateBytes),
          snapshotId: capitalHead.snapshotId,
        },
        capitalTopologyReverification: {
          path: capitalReverificationPath,
          sha256: sha256(capitalReverificationBytes),
        },
        capitalTopologyAdmission: {
          schemaVersion: 1,
          artifactKind: "capital-network-edge-admission",
          issue: capitalReverification.admissionIssue,
          status: "ADMITTED",
          snapshotId: capitalHead.snapshotId,
          contentSha256: capitalHead.contentSha256,
          reviewedAt: capitalCandidate.capturedAt,
          reverifiedAt: capitalCandidate.capturedAt,
          freshUntil: capitalCandidate.freshUntil,
        },
        itxCoverageContract: {
          path: itxCoverageContractPath,
          sha256: sha256(itxCoverageContractBytes),
        },
        incheonTimetables: Object.fromEntries([["line1", "incheonLine1"], ["line2", "incheonLine2"]].map(([line, key]) => [line, {
          path: inputSnapshots[key].path,
          sha256: sha256(inputSnapshots[key].bytes),
          snapshotId: inputSnapshots[key].snapshotId,
        }])),
      },
      officialOdFareEvidence: {
        sourceId: odFareSourceId,
        snapshotId: odFareAdmission.snapshotId,
        evidenceHash: odFareAdmission.evidenceHash,
        admissionHash: sha256(odFareAdmissionBytes),
        quoteSetHash: odFareAdmission.quoteSetHash,
        mappingLedgerHash: odFareAdmission.fareStationLineMappingLedgerHash,
        quotes: odFareQuotes,
      },
      itxTopologyEvidencePath,
      itxTopologyEvidenceSha256: sha256(itxTopologyEvidenceBytes),
    },
    releaseIdentity: {
      candidateId,
      publishedAt: fanIn.evaluatedAt,
      releaseSequence,
    },
    builderIdentity: {
      gitSha,
      version: "build-datapack.mjs@26",
    },
    authority: {
      candidateId,
      scopeId,
      approvalId: `release-request-${candidateId}`,
      requestedBy,
      approvedBy,
    },
    routeEdgeInput: {
      path: routeInputRelPath,
      sha256: sha256(routeInputBytes),
    },
    stationLineInput: {
      path: stationLineInputRelPath,
      sha256: sha256(stationLineInputBytes),
    },
  };

  const preparationRelPath = "tools/datapack/release/nationwide-candidate-preparation.json";
  if (writeFiles) {
    await writeFile(path.join(repositoryRoot, preparationRelPath), jsonBytes(preparation));
  }

  // 후보 spec·production scope·release request·hash evidence는 build-nationwide-candidate.mjs --preparation 한 경로로만 만든다(#862).
  // 이전처럼 커밋된 spec 일부 필드만 고치면 sourceSnapshotIds·sourceSnapshotSetHash·publishedAt·ledger 해시가 fan-in head와 어긋난다.

  return {
    candidateId,
    releaseSequence,
    materializedFixture,
    finalPack,
    routeInput,
    stationLineInput,
    excludedOutOfStationTransferLinks,
    preparation,
    preparationRelPath,
    routeInputRelPath,
    stationLineInputRelPath,
    nationwidePackRelPath,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  let releaseSequence = 122;
  const seqArg = args.find((a) => a.startsWith("--sequence="));
  if (seqArg) releaseSequence = Number(seqArg.split("=")[1]);
  prepareNationwideCandidate({ releaseSequence }).then((res) => {
    console.log("Prepared:", res);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
