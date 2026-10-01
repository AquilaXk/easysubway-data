import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { canonicalJson } from "./lib/manifest-validation.mjs";
import { terminalHead } from "./build-current-five-region-source-fan-in.mjs";
import { buildNationwideAssemblyInputs } from "./lib/nationwide-assembly-binding.mjs";
import { canonicalRideEdgeSetSha256, routeEdgeSha256 } from "./evaluate-route-accessibility-edges.mjs";
import { canonicalCurrentCapitalRouteEdgeInputJson } from "./build-current-capital-route-edge-input.mjs";
import { canonicalCurrentCapitalStationLineInputJson } from "./current-capital-station-line-contract.mjs";
import { outOfStationTransferNetworkEdges } from "./build-datapack.mjs";
import { materializeIncheonTimetable } from "./materialize-incheon-timetable.mjs";
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

// 광주 접근성 행의 FACILITY 판정. 공식 행이 없는 유형(null)은 미관측이다. 관측된 시설이 하나도 없고
// 미관측 유형이 남아 있으면 부재로 단정하지 않고 UNKNOWN으로 막는다(#862: 휠체어리프트 0만으로
// VERIFIED_ABSENT가 되던 문제). 세 유형이 모두 0일 때만 부재다.
export function gwangjuFacilityState({ elevator, wheelchair_lift: wheelchairLift, escalator }) {
  const facilityCounts = [elevator, wheelchairLift, escalator];
  if (facilityCounts.some((count) => count > 0)) return "VERIFIED_PRESENT";
  if (facilityCounts.some((count) => count === null)) return "UNKNOWN";
  return "VERIFIED_ABSENT";
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
    transferMetricsBytes, gwangjuTimetableBytes, freshnessPolicyBytes,
  ] = await Promise.all([
    read("tools/datapack/nationwide-coverage-targets.json"),
    read("tools/datapack/release/current-five-region-source-fan-in.json"),
    read("tools/datapack/release/source-snapshots.json"),
    read("tools/datapack/release/capital-production-canonical-pack.json"),
    read("tools/datapack/fixtures/admin-review-overrides.json"),
    read("tools/datapack/source-inventory.json"),
    read("tools/datapack/release/current-transfer-topology-metrics.json"),
    // 광주 cyberstation 시간표는 inventory·원장 행이 없다. KRIC 열차별 원천 전환(#861)에서 바꾼다.
    read("tools/datapack/sources/gwangju-transportation-cyberstation-timetable-20260720.json"),
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
  const gwangjuTimetable = JSON.parse(gwangjuTimetableBytes);

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

  const entryEdges = [...pairs.values()].map(({ stationId, lineId }) => {
    const normalized = {
      edgeId: `entry-${stationId}-${lineId}`,
      edgeType: "ENTRY",
      fromNodeId: stationId,
      toNodeId: `${stationId}:${lineId}`,
      durationSeconds: 0,
      distanceMeters: 0,
      servicePattern: "",
      serviceClass: "SUBWAY",
    };
    return { ...normalized, edgeSha256: routeEdgeSha256(normalized) };
  });

  const exitEdges = [...pairs.values()].map(({ stationId, lineId }) => {
    const normalized = {
      edgeId: `exit-${stationId}-${lineId}`,
      edgeType: "EXIT",
      fromNodeId: `${stationId}:${lineId}`,
      toNodeId: stationId,
      durationSeconds: 0,
      distanceMeters: 0,
      servicePattern: "",
      serviceClass: "SUBWAY",
    };
    return { ...normalized, edgeSha256: routeEdgeSha256(normalized) };
  });

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
  const officialTransferMetricMap = new Map();
  const addOfficialTransferMetric = (metric, entry) => {
    const key = `${metric.stationId}:${metric.fromLineId}->${metric.toLineId}`;
    if (officialTransferMetricMap.has(key)) throw new Error(`nationwide candidate transfer metric is claimed by two sources: ${key}`);
    officialTransferMetricMap.set(key, { metric, ...entry });
  };
  for (const m of transferMetrics.metrics) {
    addOfficialTransferMetric(m, {
      sourceId: "seoul-metro-transfer-distance-duration", sourceSnapshotId: seoulTransferHead.snapshotId,
      lastVerifiedAt: seoulTransferCapturedAt, durationSeconds: m.officialDurationSecondsReference,
    });
  }
  for (const m of busanTransfer.metrics) {
    addOfficialTransferMetric(m, {
      sourceId: "busan-transportation-route-topology", sourceSnapshotId: busanTransfer.head.snapshotId,
      lastVerifiedAt: requiredInstant(busanTransfer.head.capturedAt, "Busan transfer capturedAt"), durationSeconds: m.officialDurationSeconds,
    });
  }

  const stationPathwayNodes = [];
  const stationPathwayEdges = [];
  const transferEdges = [];
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

  const makeOutOfStationLink = ({
    id, fromStationId, fromLineId, toStationId, toLineId,
    durationSeconds, distanceMeters, bidirectional = false,
    slopeLevel = 1, coveredRoute = "UNKNOWN", stairAccessState = "UNKNOWN",
  }) => ({
    id,
    fromStationId,
    fromLineId,
    toStationId,
    toLineId,
    durationSeconds,
    distanceMeters,
    bidirectional,
    slopeLevel,
    requiresFareExit: true,
    requiresReentry: true,
    coveredRoute,
    crossingRisk: "UNKNOWN",
    curbCutStatus: "UNKNOWN",
    sidewalkStatus: "UNKNOWN",
    accessibilityStatus: "UNKNOWN",
    stairAccessState,
    reliabilityScore: 0,
    sourceId: "",
    sourceSnapshotId: "",
    providerRecordHash: "",
    provenanceKind: "UNVERIFIED",
    verificationStatus: "UNVERIFIED",
    lastFieldVerifiedAt: null,
    evidenceHash: "",
  });

  const outOfStationTransferLinks = [
    // 1. 수도권: 신촌 2호선 <-> 신촌 경의중앙선
    makeOutOfStationLink({
      id: "out-link-sinchon-2-to-gj",
      fromStationId: "station-4e123a19a88f",
      fromLineId: "seoul-2",
      toStationId: "station-d6935359840d",
      toLineId: "line-6e39be0cb6e2",
      durationSeconds: 600,
      distanceMeters: 550,
      slopeLevel: 2,
    }),
    makeOutOfStationLink({
      id: "out-link-sinchon-gj-to-2",
      fromStationId: "station-d6935359840d",
      fromLineId: "line-6e39be0cb6e2",
      toStationId: "station-4e123a19a88f",
      toLineId: "seoul-2",
      durationSeconds: 540,
      distanceMeters: 550,
    }),
    // 2. 수도권: 석남 7호선 <-> 석남 인천2호선
    makeOutOfStationLink({
      id: "out-link-seongnam-7-incheon2",
      fromStationId: "station-57db2f1fb4f6",
      fromLineId: "line-15b3b8a93259",
      toStationId: "station-37866f28b417",
      toLineId: "line-42b5805f3b5a",
      durationSeconds: 240,
      distanceMeters: 180,
      bidirectional: true,
    }),
    // 3. 부산권: 동래 1호선 <-> 동래 동해선
    makeOutOfStationLink({
      id: "out-link-dongnae-1-to-dh",
      fromStationId: "station-dbfe9e072d98",
      fromLineId: "line-ab1a041f6266",
      toStationId: "station-b65d6408d975",
      toLineId: "line-f52eb59d8497",
      durationSeconds: 420,
      distanceMeters: 350,
      slopeLevel: 2,
    }),
    makeOutOfStationLink({
      id: "out-link-dongnae-dh-to-1",
      fromStationId: "station-b65d6408d975",
      fromLineId: "line-f52eb59d8497",
      toStationId: "station-dbfe9e072d98",
      toLineId: "line-ab1a041f6266",
      durationSeconds: 360,
      distanceMeters: 350,
    }),
    // 4. 부산권: 부전 1호선 <-> 동해선
    makeOutOfStationLink({
      id: "out-link-bujeon-1-to-dh",
      fromStationId: "station-9acc028dded4",
      fromLineId: "line-ab1a041f6266",
      toStationId: "station-ee8407a487c2",
      toLineId: "line-f52eb59d8497",
      durationSeconds: 300,
      distanceMeters: 260,
      bidirectional: true,
    }),
    // 5. 대구권: 청라언덕 <-> 반월당
    makeOutOfStationLink({
      id: "out-link-daegu-cheongna-to-banwoldang",
      fromStationId: "station-3de9d5097085",
      fromLineId: "line-e2938a4cc492",
      toStationId: "station-44dc03b65cae",
      toLineId: "line-5b8d9b05e7e6",
      durationSeconds: 600,
      distanceMeters: 550,
      slopeLevel: 2,
    }),
    makeOutOfStationLink({
      id: "out-link-daegu-banwoldang-to-cheongna",
      fromStationId: "station-44dc03b65cae",
      fromLineId: "line-5b8d9b05e7e6",
      toStationId: "station-3de9d5097085",
      toLineId: "line-e2938a4cc492",
      durationSeconds: 540,
      distanceMeters: 550,
    }),
    // 6. 대전권: 서대전네거리 <-> 오룡
    makeOutOfStationLink({
      id: "out-link-daejeon-seodaejeon-to-oryong",
      fromStationId: "station-ee3cc9d04ee7",
      fromLineId: "line-7051a9c2525c",
      toStationId: "station-49f924643e04",
      toLineId: "line-7051a9c2525c",
      durationSeconds: 600,
      distanceMeters: 500,
      slopeLevel: 2,
    }),
    makeOutOfStationLink({
      id: "out-link-daejeon-oryong-to-seodaejeon",
      fromStationId: "station-49f924643e04",
      fromLineId: "line-7051a9c2525c",
      toStationId: "station-ee3cc9d04ee7",
      toLineId: "line-7051a9c2525c",
      durationSeconds: 500,
      distanceMeters: 500,
    }),
    // 7. 광주권: 광주송정역 <-> 도산
    makeOutOfStationLink({
      id: "out-link-gwangju-songjeong-dosan",
      fromStationId: "station-45d732c94df2",
      fromLineId: "line-e57a361e8892",
      toStationId: "station-25f856602c61",
      toLineId: "line-e57a361e8892",
      durationSeconds: 480,
      distanceMeters: 400,
      bidirectional: true,
    }),
  ];

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
  const cleanOutOfStationTransferLinks = outOfStationTransferLinks.map((link) => {
    const clean = {
      ...link,
      accessibilityStatus: "UNKNOWN",
      stairAccessState: "UNKNOWN",
      curbCutStatus: "UNKNOWN",
      sidewalkStatus: "UNKNOWN",
      crossingRisk: "UNKNOWN",
      coveredRoute: "UNKNOWN",
    };
    delete clean.sourceId;
    delete clean.sourceSnapshotId;
    delete clean.providerRecordHash;
    delete clean.provenanceKind;
    delete clean.verificationStatus;
    delete clean.lastFieldVerifiedAt;
    delete clean.lastVerifiedAt;
    delete clean.evidenceHash;
    return clean;
  });
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

  const incheonNow = new Date(Math.max(Date.parse(incheonLine1.capturedAt), Date.parse(incheonLine2.capturedAt)) + 1000);
  const materializedFixture = materializeIncheonTimetable({
    baseFixture: nationwideFixture,
    topologySnapshot: { ...incheonTopology, snapshotId: inputSnapshots.incheonTopology.snapshotId },
    timetableSnapshots: { 1: incheonLine1, 2: incheonLine2 },
    inventory: sourceInventory,
    now: incheonNow,
  });

  const finalPack = materializedFixture.packs[0];

  function cleanStationName(n) {
    return n.replace(/\(.*?\)/g, "").replace(/\d+$/, "").replace(/[·•ㆍ]/g, ".").trim();
  }

  function findRegionalStationId(lineId, rawName) {
    let name = cleanStationName(rawName);
    if (name === "성서산단") name = "성서산업단지";
    if (name === "광주송정") name = "광주송정역";
    const candidates = finalPack.stationLines.filter((sl) => sl.lineId === lineId);
    const found = candidates.find((sl) => {
      const st = finalPack.stations.find((s) => s.id === sl.stationId);
      return st && (cleanStationName(st.nameKo) === name);
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

  // 1. Busan
  for (const row of busanAccessibility.rows) {
    const stationId = findRegionalStationId(row.lineId, row.stationName);
    const stationName = finalPack.stations.find((s) => s.id === stationId)?.nameKo ?? row.stationName;
    const types = [
      { type: "ELEVATOR", count: row.el_i + row.el_o, slug: "elevator", labelKo: "엘리베이터" },
      { type: "ESCALATOR", count: row.es, slug: "escalator", labelKo: "에스컬레이터" },
      { type: "WHEELCHAIR_LIFT", count: row.wl_i + row.wl_o, slug: "wheelchair-lift", labelKo: "휠체어리프트" },
    ];
    for (const t of types) {
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
    const types = [
      { type: "ELEVATOR", count: row.elevator, slug: "elevator", labelKo: "엘리베이터" },
      { type: "ESCALATOR", count: row.escalator, slug: "escalator", labelKo: "에스컬레이터" },
      { type: "WHEELCHAIR_LIFT", count: row.wheelchair_lift, slug: "wheelchair-lift", labelKo: "휠체어리프트" },
    ];
    for (const t of types) {
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
    const types = [
      { type: "ELEVATOR", count: row.elevator, slug: "elevator", labelKo: "엘리베이터" },
      { type: "ESCALATOR", count: row.escalator, slug: "escalator", labelKo: "에스컬레이터" },
      { type: "WHEELCHAIR_LIFT", count: row.wheelchair_lift, slug: "wheelchair-lift", labelKo: "휠체어리프트" },
    ];
    for (const t of types) {
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
    const types = [
      { type: "ELEVATOR", count: row.elevator, slug: "elevator", labelKo: "엘리베이터" },
      { type: "ESCALATOR", count: row.escalator, slug: "escalator", labelKo: "에스컬레이터" },
      { type: "WHEELCHAIR_LIFT", count: row.wheelchair_lift ?? 0, slug: "wheelchair-lift", labelKo: "휠체어리프트" },
    ];
    for (const t of types) {
      if (t.count == null) continue;
      const exists = t.count > 0;
      const providerRecordHash = sha256(JSON.stringify({
        stationCode: row.stationCode, lineId: row.lineId, type: t.type, count: t.count,
        elevator: row.elevator, escalator: row.escalator, wheelchair_lift: row.wheelchair_lift ?? 0,
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
    gwangjuTimetable,
    gwangjuAccessibility,
  });

  finalPack.transitRoutes = regionalSchedule.transitRoutes;
  finalPack.transitTrips = regionalSchedule.transitTrips;
  finalPack.transitStopTimes = regionalSchedule.transitStopTimes;
  finalPack.serviceCalendars = regionalSchedule.serviceCalendars;
  finalPack.serviceCalendarDates = regionalSchedule.serviceCalendarDates;

  // #855: 대전·광주 원천은 역별 시각 하나만 준다. 원천 정차 2개 이상으로 열차를 만들 수 없는
  // 원천 시각은 팩에 싣지 않고 사유·식별자·개수를 격리 증거로 남긴다.
  const timetableQuarantine = regionalSchedule.regionalTimetableQuarantine;
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
      { sourceId: "gwangju-transportation-cyberstation-timetable", rawSha256: gwangjuTimetable.rawSha256 },
    ].map((source) => ({
      ...source,
      admittedStopTimeCount: finalPack.transitStopTimes.filter(({ sourceId }) => sourceId === source.sourceId).length,
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
  ];

  for (const item of regionalSourcesToAdd) {
    if (!finalPack.sourceInventory.some((s) => s.id === item.id)) {
      const source = sourceInventory.sources.find((s) => s.id === item.id);
      if (!source) throw new Error(`Source not found in inventory: ${item.id}`);
      finalPack.sourceInventory.push(packSource(source, item.updatedAt));
    }
  }

  if (!finalPack.sourceInventory.some((s) => s.id === "gwangju-transportation-cyberstation-timetable")) {
    finalPack.sourceInventory.push({
      id: "gwangju-transportation-cyberstation-timetable",
      owner: "광주교통공사",
      url: gwangjuTimetable.detailUrl ?? "https://www.grtc.co.kr/subway/menu/trainTimetableSubMenu",
      license: "공공데이터포털 이용허락범위 제한 없음",
      licenseStatus: "redistributable",
      redistributionAllowed: true,
      updateFrequency: "daily admission refresh",
      updatedAt: gwangjuTimetable.capturedAt,
      fields: [...(gwangjuTimetable.fieldsProvided ?? ["service_calendar", "trip", "stop_time"])],
      coverageScope: {
        regionIds: ["gwangju"],
        operatorIds: ["gwangju-metropolitan-rapid-transit"],
        sourceDomains: ["schedule_timetable"],
      },
    });
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
  const nationwidePackBytes = Buffer.from(`${JSON.stringify(materializedFixture)}\n`);
  if (writeFiles) {
    await writeFile(path.join(repositoryRoot, nationwidePackRelPath), nationwidePackBytes);
  }

  // 3. Prepare route edges
  const routeEdges = [...entryEdges, ...exitEdges, ...transferEdges, ...outOfStationEdges, ...rideEdges]
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

  // KRIC 출구(EXIT) 원천은 원장 등록기가 없어 원장 행이 0개다. 행은 PROVIDER_NO_DATA로만 쓰며, 원장 등록은 #866에서 한다.
  const kricMovementRawSha = "9e9e66356d1f1a7275578f299882b3d2a42637d9cc5b4ce8b874ee78f3815106";
  const kricMovementLicenseId = "80555d4f86dfa1d51e0618df22b8392fc439a33daf80fed3a9c4f2a728fec9bb";
  const kricMovementCapturedAt = "2026-09-04T17:29:43.075Z";
  const kricMovementFreshUntil = "2027-09-05T17:29:43.075Z";

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
  const daeguMap = new Map(daeguAccessibility.rows.map((r) => [`${findRegionalStationId(r.lineId, r.stationName)}\0${r.lineId}`, r]));
  const daejeonMap = new Map(daejeonAccessibility.rows.map((r) => [`${findRegionalStationId(r.lineId, r.stationName)}\0${r.lineId}`, r]));
  const gwangjuMap = new Map(gwangjuAccessibility.rows.map((r) => [`${findRegionalStationId(r.lineId, r.stationName)}\0${r.lineId}`, r]));
  const kricMap = new Map((kricConvenience.queries ?? []).map((q) => [`${q.stationId}\0${q.lineId}`, q]));

  const outOfStationTransferStationIds = new Set(
    outOfStationTransferLinks.flatMap((l) => [l.fromStationId, l.toStationId])
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
      const hasFac = (r.el_i + r.el_o) > 0 || (r.wl_i + r.wl_o) > 0 || r.es > 0;
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

    // EXIT
    evidenceRows.push({
      ...stationLineCandidate,
      stationId,
      lineId,
      operatorId,
      domain: "EXIT",
      state: "UNKNOWN",
      sourceId: "kric-station-movement-standard",
      sourceSnapshotId: "kric-station-movement-standard-20260904T172943075Z",
      evidenceRawSha256: kricMovementRawSha,
      providerRecordHash: sha256(canonicalJson({ stationId, lineId, domain: "EXIT", state: "UNKNOWN" })),
      capturedAt: kricMovementCapturedAt,
      freshUntil: kricMovementFreshUntil,
      provenanceId: kricMovementRawSha,
      licenseId: kricMovementLicenseId,
      mappingContractVersion: "station-line-v1",
      materializerVersion: "1",
      evidenceKind: "PROVIDER_NO_DATA",
      evidenceReason: "EXIT_DATA_NOT_PROVIDED",
    });

    // TRANSFER
    const isTransfer = (stationToLines.get(stationId)?.length ?? 0) > 1 || outOfStationTransferStationIds.has(stationId);
    const isBusanDaeguTransfer = busanDaeguTransferStationIds.has(stationId);
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
      const matchedMetrics = (transferMetrics?.metrics ?? []).filter(
        (m) => m.stationId === stationId && (m.fromLineId === lineId || m.toLineId === lineId)
      );
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
