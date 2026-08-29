#!/usr/bin/env node
// 인천교통공사 1·2호선·7호선(인천·부천) 엘리베이터·에스컬레이터·휠체어리프트 공식 FILE CSV를 결정론적 snapshot으로 수집한다.
// API key·포털 활용신청 없이 data.go.kr 파일데이터(15083478·15010199·15146049)만 사용한다.
// 비상시설(환기구·대피) 행은 skip하며 seoul-metro join·장비 발명을 하지 않는다.
// topologyLineIds는 1·2호선만 유지하고, membership scope(lineIds)만 7호선(line-15)을 포함한다.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { decodeOfficialCsv } from "./collect-daegu-datapack-sources.mjs";
import {
  I210_SEOHAE_GU_OFFICE_RENAME,
  validateIncheonStationInfoSnapshot,
} from "./collect-incheon-station-info.mjs";
import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";

const ELEVATOR_DATASET_ID = "15083478";
const ESCALATOR_DATASET_ID = "15010199";
const WHEELCHAIR_DATASET_ID = "15146049";
const DATASET_IDS = Object.freeze([
  ELEVATOR_DATASET_ID,
  ESCALATOR_DATASET_ID,
  WHEELCHAIR_DATASET_ID,
]);
const ELEVATOR_DETAIL_URL = `https://www.data.go.kr/data/${ELEVATOR_DATASET_ID}/fileData.do`;
const ESCALATOR_DETAIL_URL = `https://www.data.go.kr/data/${ESCALATOR_DATASET_ID}/fileData.do`;
const WHEELCHAIR_DETAIL_URL = `https://www.data.go.kr/data/${WHEELCHAIR_DATASET_ID}/fileData.do`;
const SOURCE_ID = "incheon-transit-accessibility";
const ARTIFACT_KIND = "incheon-accessibility-snapshot";
const TOPOLOGY_SOURCE_ID = "incheon-transit-station-info";
const LINE1 = "line-98718184f016";
const LINE2 = "line-42b5805f3b5a";
const LINE7 = "line-15b3b8a93259";
const LINE_IDS = Object.freeze([LINE2, LINE1, LINE7]);
const TOPOLOGY_LINE_IDS = Object.freeze([LINE2, LINE1]);
const CSV_LINE_TO_ID = Object.freeze({
  1: LINE1,
  2: LINE2,
  7: LINE7,
});
const EXPECTED_STATION_COUNT = 71;
const EXPECTED_LINE_STATION_COUNTS = Object.freeze({
  [LINE1]: 33,
  [LINE2]: 27,
  [LINE7]: 11,
});
const EXPECTED_ELEVATOR_CSV_ROWS = 269;
const EXPECTED_ESCALATOR_CSV_ROWS = 653;
const EXPECTED_WHEELCHAIR_CSV_ROWS = 3;
const EXPECTED_ELEVATOR_JOINED = 265;
const EXPECTED_ESCALATOR_JOINED = 653;
const EXPECTED_WHEELCHAIR_JOINED = 3;
const EXPECTED_SKIPPED_LINE7_ELEVATOR = 0;
const EXPECTED_SKIPPED_LINE7_ESCALATOR = 0;
const EXPECTED_SKIPPED_NON_STATION_ELEVATOR = 4;
const ELEVATOR_ESCALATOR_HEADERS = Object.freeze([
  "호선", "역명", "장비종류", "호기", "승강기번호", "운행구간", "설치위치",
]);
const WHEELCHAIR_HEADERS = Object.freeze([
  "호선", "역명", "호기", "운전구간", "정격하중", "비고",
]);
const NON_STATION_FACILITY_NAMES = Object.freeze(new Set([
  "6번환기구(1082)",
  "9번환기구(1072)",
  "대피3",
  "대피4",
]));
const STATION_NAME_ALIASES = Object.freeze({
  문학: "문학경기장",
  [I210_SEOHAE_GU_OFFICE_RENAME.previousNameKo]: I210_SEOHAE_GU_OFFICE_RENAME.currentNameKo,
});
const OBSERVATION_ARTIFACT_KIND = "incheon-accessibility-observation";
const RAW_ARTIFACT_KIND = "incheon-accessibility-raw-collection";
const SHA256 = /^[a-f0-9]{64}$/u;
const TOPOLOGY_SNAPSHOT_KEYS = Object.freeze([
  "schemaVersion", "artifactKind", "sourceId", "detailUrl", "datasetId", "endpoint", "capturedAt", "freshUntil",
  "observedDataUpdatedAt", "official", "fixture", "credentialRequired", "credentialRedacted", "rawRowCount",
  "admittedRowCount", "excludedLine7Count", "admittedLine7Count", "excludedTransferCount", "stationCount",
  "uniqueStationCount", "edgeCount", "positionCount", "topologyLineIds", "lineIds", "lineStationCounts", "operatorId",
  "region", "fieldsProvided", "license", "stationCodeDerivations", "scope", "edges", "positions", "scopeSha256",
  "edgesSha256", "positionsSha256", "rawSha256", "contentSha256",
]);
const CLAIM_TYPES = Object.freeze([
  ["ELEVATOR", "elevator"], ["ESCALATOR", "escalator"], ["WHEELCHAIR_LIFT", "wheelchair_lift"],
]);
const TRACKED_FRESHNESS_POLICY = JSON.parse(readFileSync(
  path.resolve(import.meta.dirname, "../../release/product-gates/datapack-freshness-sla.json"),
  "utf8",
));

export function normalizedIncheonStationName(name) {
  let value = String(name).normalize("NFKC").trim();
  value = value.replace(/\([^)]*\)/gu, "").trim();
  if (value.endsWith("역")) value = value.slice(0, -1);
  return STATION_NAME_ALIASES[value] ?? value;
}

export function parseIncheonAccessibilityCsv({
  elevatorBytes,
  escalatorBytes,
  wheelchairBytes,
  topologySnapshot,
}) {
  if (!(elevatorBytes instanceof Uint8Array) || elevatorBytes.byteLength === 0) {
    throw new Error("Incheon elevator CSV bytes are required");
  }
  if (!(escalatorBytes instanceof Uint8Array) || escalatorBytes.byteLength === 0) {
    throw new Error("Incheon escalator CSV bytes are required");
  }
  if (!(wheelchairBytes instanceof Uint8Array) || wheelchairBytes.byteLength === 0) {
    throw new Error("Incheon wheelchair CSV bytes are required");
  }
  const { scope } = validateTopologySnapshot(topologySnapshot);
  const scopeByKey = new Map(scope.map((station) => [
    `${station.lineId}:${normalizedIncheonStationName(station.stationName)}`,
    station,
  ]));
  if (scopeByKey.size !== EXPECTED_STATION_COUNT) {
    throw new Error("Incheon accessibility topology normalization collided");
  }

  const elevator = countFacilityRows({
    bytes: elevatorBytes,
    expectedHeaders: ELEVATOR_ESCALATOR_HEADERS,
    expectedCsvRowCount: EXPECTED_ELEVATOR_CSV_ROWS,
    expectedJoinedCount: EXPECTED_ELEVATOR_JOINED,
    expectedSkippedLine7: EXPECTED_SKIPPED_LINE7_ELEVATOR,
    expectedSkippedNonStation: EXPECTED_SKIPPED_NON_STATION_ELEVATOR,
    label: "elevator",
    scopeByKey,
    allowNonStationSkip: true,
  });
  const escalator = countFacilityRows({
    bytes: escalatorBytes,
    expectedHeaders: ELEVATOR_ESCALATOR_HEADERS,
    expectedCsvRowCount: EXPECTED_ESCALATOR_CSV_ROWS,
    expectedJoinedCount: EXPECTED_ESCALATOR_JOINED,
    expectedSkippedLine7: EXPECTED_SKIPPED_LINE7_ESCALATOR,
    expectedSkippedNonStation: 0,
    label: "escalator",
    scopeByKey,
    allowNonStationSkip: true,
  });
  const wheelchair = countFacilityRows({
    bytes: wheelchairBytes,
    expectedHeaders: WHEELCHAIR_HEADERS,
    expectedCsvRowCount: EXPECTED_WHEELCHAIR_CSV_ROWS,
    expectedJoinedCount: EXPECTED_WHEELCHAIR_JOINED,
    expectedSkippedLine7: 0,
    expectedSkippedNonStation: 0,
    label: "wheelchair",
    scopeByKey,
    allowNonStationSkip: false,
  });

  // topology membership(1·2·7호선 71역) 전량 admit. CSV에 없는 역·시설은 공식 미게재로 count=0(장비 발명 금지).
  const rows = scope.map((station) => ({
    stationCode: station.stationCode,
    stationName: station.stationName,
    lineId: station.lineId,
    wheelchair_lift: wheelchair.counts.get(station.stationCode) ?? 0,
    elevator: elevator.counts.get(station.stationCode) ?? 0,
    escalator: escalator.counts.get(station.stationCode) ?? 0,
  })).sort((left, right) => {
    const lineCmp = left.lineId.localeCompare(right.lineId, "en");
    return lineCmp !== 0 ? lineCmp : left.stationCode.localeCompare(right.stationCode, "en");
  });

  if (rows.length !== EXPECTED_STATION_COUNT) {
    throw new Error(`Incheon accessibility station count mismatch: ${rows.length}`);
  }
  for (const [lineId, expected] of Object.entries(EXPECTED_LINE_STATION_COUNTS)) {
    if (rows.filter((row) => row.lineId === lineId).length !== expected) {
      throw new Error(`Incheon accessibility line station count mismatch: ${lineId}`);
    }
  }
  if (rows.reduce((sum, row) => sum + row.elevator, 0) !== EXPECTED_ELEVATOR_JOINED
    || rows.reduce((sum, row) => sum + row.escalator, 0) !== EXPECTED_ESCALATOR_JOINED
    || rows.reduce((sum, row) => sum + row.wheelchair_lift, 0) !== EXPECTED_WHEELCHAIR_JOINED) {
    throw new Error("Incheon accessibility aggregated facility counts mismatch");
  }
  return {
    rows,
    skippedNonStationFacilityRows: elevator.skippedNonStationNames,
    skippedLine7RowCounts: {
      elevator: elevator.skippedLine7,
      escalator: escalator.skippedLine7,
      wheelchair_lift: wheelchair.skippedLine7,
    },
  };
}

export function collectIncheonAccessibility({
  elevatorBytes,
  escalatorBytes,
  wheelchairBytes,
  topologySnapshot,
  freshnessPolicy,
  now = new Date(),
} = {}) {
  const capturedAt = validDate(now, "now");
  const {
    rows,
    skippedNonStationFacilityRows,
    skippedLine7RowCounts,
  } = parseIncheonAccessibilityCsv({
    elevatorBytes,
    escalatorBytes,
    wheelchairBytes,
    topologySnapshot,
  });
  const scope = rows.map(({ stationCode, stationName, lineId }) => ({ stationCode, stationName, lineId }));
  const { snapshotId, contentSha256, scope: topologyScope } = validateTopologySnapshot(topologySnapshot);
  const lineageFor = (lineId) => ({
    sourceId: TOPOLOGY_SOURCE_ID,
    snapshotId,
    contentSha256,
    lineId,
  });
  // topology edges are admitted for 1·2 only; line-15 is membership-backed.
  const topologyLineages = TOPOLOGY_LINE_IDS.map(lineageFor);
  const membershipLineages = [LINE7].map(lineageFor);
  const elevatorSha256 = sha256(Buffer.from(elevatorBytes));
  const escalatorSha256 = sha256(Buffer.from(escalatorBytes));
  const wheelchairSha256 = sha256(Buffer.from(wheelchairBytes));
  const claimTopology = topologyScope.map(({ stationId, lineId, stationCode }) => ({ stationId, lineId, stationCode }));
  const claimBindings = deriveClaimBindings(rows, claimTopology);
  const rowsSha256 = sha256(JSON.stringify(rows));
  const schemaFingerprint = sha256(JSON.stringify({
    fieldsProvided: ["elevator", "escalator", "wheelchair_lift", "status", "verified_at"],
    lineIds: [...LINE_IDS], claimFields: Object.keys(claimBindings[0]),
  }));
  return {
    schemaVersion: 1,
    artifactKind: ARTIFACT_KIND,
    sourceId: SOURCE_ID,
    snapshotId: `${SOURCE_ID}-${capturedAt.toISOString().replaceAll(/[-:.]/gu, "")}`,
    detailUrl: ELEVATOR_DETAIL_URL,
    detailUrls: {
      elevator: ELEVATOR_DETAIL_URL,
      escalator: ESCALATOR_DETAIL_URL,
      wheelchair_lift: WHEELCHAIR_DETAIL_URL,
    },
    datasetIds: [...DATASET_IDS],
    endpoint: ELEVATOR_DETAIL_URL,
    capturedAt: capturedAt.toISOString(),
    observedAt: capturedAt.toISOString(),
    freshUntil: deriveFreshnessExpiresAt({ policy: freshnessPolicy, sourceClassId: "static_accessibility_facility", basisAt: capturedAt.toISOString(), evaluationAt: capturedAt.toISOString() }),
    official: true,
    fixture: false,
    credentialRequired: false,
    credentialRedacted: true,
    stationCount: rows.length,
    rowCount: rows.length,
    elevatorRowCount: EXPECTED_ELEVATOR_JOINED,
    escalatorRowCount: EXPECTED_ESCALATOR_JOINED,
    wheelchairRowCount: EXPECTED_WHEELCHAIR_JOINED,
    elevatorCsvRowCount: EXPECTED_ELEVATOR_CSV_ROWS,
    escalatorCsvRowCount: EXPECTED_ESCALATOR_CSV_ROWS,
    wheelchairCsvRowCount: EXPECTED_WHEELCHAIR_CSV_ROWS,
    skippedNonStationFacilityRows,
    skippedLine7RowCounts,
    lineIds: [...LINE_IDS],
    fieldsProvided: ["elevator", "escalator", "wheelchair_lift", "status", "verified_at"],
    license: {
      type: "PUBLIC_DATA_FREE_USE",
      attribution: "인천교통공사, 공공데이터포털 이용허락범위 제한 없음",
      redistributionAllowed: true,
      evidenceUrl: ELEVATOR_DETAIL_URL,
    },
    topologyLineages,
    membershipLineages,
    scope,
    scopeSha256: sha256(JSON.stringify(scope)),
    rawSha256: sha256(JSON.stringify({
      [ELEVATOR_DATASET_ID]: elevatorSha256,
      [ESCALATOR_DATASET_ID]: escalatorSha256,
      [WHEELCHAIR_DATASET_ID]: wheelchairSha256,
    })),
    elevatorRawSha256: elevatorSha256,
    escalatorRawSha256: escalatorSha256,
    wheelchairRawSha256: wheelchairSha256,
    rowsSha256,
    contentSha256: rowsSha256,
    schemaFingerprint,
    absenceEvidenceMode: "EXHAUSTIVE_LIST",
    claimTopology,
    claimBindings,
    claimBindingsSha256: sha256(JSON.stringify(claimBindings)),
    rows,
  };
}

function deriveClaimBindings(rows, topologyScope) {
  const members = new Map(topologyScope.map(({ stationId, lineId, stationCode }) => [`${lineId}:${stationCode}`, { stationId, lineId, stationCode }]));
  const bindings = [];
  for (const row of rows) {
    const member = members.get(`${row.lineId}:${row.stationCode}`);
    if (!member || typeof member.stationId !== "string" || member.stationId === "") throw new Error("Incheon accessibility claim topology membership is invalid");
    for (const [facilityType, field] of CLAIM_TYPES) {
      const count = row[field]; const installed = count > 0;
      const common = {
        stationId: member.stationId, lineId: member.lineId, stationCode: member.stationCode, facilityType, count,
        providerRecordHash: sha256(JSON.stringify({ stationCode: row.stationCode, lineId: row.lineId, type: facilityType, count, elevator: row.elevator, escalator: row.escalator, wheelchair_lift: row.wheelchair_lift })),
        evidenceKind: installed ? "EXISTS" : "NOT_EXISTS", absenceEvidenceMode: installed ? null : "EXHAUSTIVE_LIST",
        installationStatus: installed ? "INSTALLED" : "NOT_INSTALLED", strictRouteEligible: false,
        strictRouteEligibleReason: installed ? "OPERATION_STATUS_UNKNOWN" : "FACILITY_NOT_INSTALLED",
      };
      bindings.push({ stationId: member.stationId, lineId: "", sourceLineId: member.lineId, stationCode: member.stationCode, facilityType, providerRecordHash: common.providerRecordHash, evidenceHash: sha256(JSON.stringify(rows)) });
      bindings.push({ stationId: member.stationId, lineId: member.lineId, sourceLineId: member.lineId, stationCode: member.stationCode, facilityType, providerRecordHash: common.providerRecordHash, evidenceHash: sha256(JSON.stringify(rows)) });
    }
  }
  if (bindings.length !== EXPECTED_STATION_COUNT * CLAIM_TYPES.length * 2
    || new Set(bindings.map(({ stationId, lineId, sourceLineId, stationCode, facilityType }) => `${stationId}:${lineId}:${sourceLineId}:${stationCode}:${facilityType}`)).size !== bindings.length) {
    throw new Error("Incheon accessibility claim bindings are invalid");
  }
  return bindings;
}

function canonicalTopologySnapshot(snapshot) {
  const providerKeys = Object.keys(snapshot).filter((key) => key !== "snapshotId").sort();
  if (JSON.stringify(providerKeys) !== JSON.stringify([...TOPOLOGY_SNAPSHOT_KEYS].sort())) throw new Error("Incheon topology snapshot has unexpected fields");
  const canonical = Object.fromEntries(TOPOLOGY_SNAPSHOT_KEYS.map((key) => [key, canonicalTopologyValue(key, snapshot[key])]));
  const capturedDate = canonical.capturedAt?.slice(0, 10).replaceAll("-", "");
  if (!/^\d{8}$/u.test(capturedDate ?? "")) throw new Error("Incheon topology snapshot capturedAt is invalid");
  const snapshotId = `${TOPOLOGY_SOURCE_ID}-${capturedDate}`;
  if (snapshot.snapshotId != null && snapshot.snapshotId !== snapshotId) throw new Error("Incheon topology snapshotId is invalid");
  validateIncheonStationInfoSnapshot(canonical);
  return { ...canonical, snapshotId };
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`Incheon topology ${label} has unexpected fields`);
  }
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function canonicalTopologyValue(key, value) {
  if (key === "license") exactObject(value, ["type", "attribution", "redistributionAllowed", "evidenceUrl"], "license");
  if (key === "stationCodeDerivations") value.forEach((entry) => exactObject(entry, ["lineId", "rawStationCode", "stationName", "internalStationCode", "lineSequence", "basis", "datasetId"], "stationCodeDerivation"));
  if (key === "scope") value.forEach((entry) => exactObject(entry, ["lineId", "stationCode", "stationName", "stationId", "nameEn", "latitude", "longitude", "lineSequence"], "scope"));
  if (key === "edges") value.forEach((entry) => exactObject(entry, ["edgeId", "lineId", "fromStationCode", "toStationCode", "fromStationId", "toStationId", "durationSeconds", "distanceMeters"], "edge"));
  if (key === "positions") value.forEach((entry) => { exactObject(entry, ["lineId", "stationCode", "stationName", "stationId", "latitude", "longitude", "x", "y", "labelDx", "labelDy", "labelPolygon"], "position"); entry.labelPolygon.forEach((point) => exactObject(point, ["x", "y"], "labelPolygon point")); });
  if (key === "lineStationCounts") exactObject(value, Object.keys(value), "lineStationCounts");
  return structuredClone(value);
}

/** Validate the persisted source shape before it can enter an OCI receipt. */
export function validateIncheonAccessibilitySnapshotIdentity(snapshot, freshnessPolicy = TRACKED_FRESHNESS_POLICY, topologySnapshot = null) {
  if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.artifactKind !== ARTIFACT_KIND
    || snapshot.sourceId !== SOURCE_ID || !/^incheon-transit-accessibility-\d{8}T\d{9}Z$/u.test(snapshot.snapshotId ?? "")
    || !Number.isFinite(Date.parse(snapshot.capturedAt)) || !Number.isFinite(Date.parse(snapshot.freshUntil))
    || snapshot.official !== true || snapshot.fixture !== false || snapshot.credentialRequired !== false
    || snapshot.credentialRedacted !== true || !Array.isArray(snapshot.datasetIds)
    || JSON.stringify(snapshot.datasetIds) !== JSON.stringify(DATASET_IDS)
    || !SHA256.test(snapshot.rawSha256 ?? "") || !SHA256.test(snapshot.elevatorRawSha256 ?? "")
    || !SHA256.test(snapshot.escalatorRawSha256 ?? "") || !SHA256.test(snapshot.wheelchairRawSha256 ?? "")
    || snapshot.rawSha256 !== sha256(JSON.stringify({
      [ELEVATOR_DATASET_ID]: snapshot.elevatorRawSha256,
      [ESCALATOR_DATASET_ID]: snapshot.escalatorRawSha256,
      [WHEELCHAIR_DATASET_ID]: snapshot.wheelchairRawSha256,
    }))
    || snapshot.license?.type !== "PUBLIC_DATA_FREE_USE" || snapshot.license?.redistributionAllowed !== true
    || !Array.isArray(snapshot.rows) || snapshot.rows.length !== EXPECTED_STATION_COUNT
    || snapshot.rowsSha256 !== sha256(JSON.stringify(snapshot.rows))
    || !Array.isArray(snapshot.scope) || snapshot.scope.length !== EXPECTED_STATION_COUNT
    || snapshot.scopeSha256 !== sha256(JSON.stringify(snapshot.scope))
    || snapshot.observedAt !== snapshot.capturedAt || snapshot.contentSha256 !== snapshot.rowsSha256
    || !SHA256.test(snapshot.schemaFingerprint ?? "") || snapshot.absenceEvidenceMode !== "EXHAUSTIVE_LIST"
    || !Array.isArray(snapshot.claimTopology) || snapshot.claimTopology.length !== 71
    || !Array.isArray(snapshot.claimBindings) || snapshot.claimBindings.length !== 426
    || snapshot.claimBindingsSha256 !== sha256(JSON.stringify(snapshot.claimBindings))
    || !Array.isArray(snapshot.topologyLineages) || snapshot.topologyLineages.length !== 2
    || !Array.isArray(snapshot.membershipLineages) || snapshot.membershipLineages.length !== 1) {
    throw new Error("Incheon accessibility snapshot identity is invalid");
  }
  const expectedId = `${SOURCE_ID}-${snapshot.capturedAt.replaceAll(/[-:.]/gu, "")}`;
  const claimBindings = deriveClaimBindings(snapshot.rows, snapshot.claimTopology);
  const expectedFreshUntil = deriveFreshnessExpiresAt({ policy: freshnessPolicy, sourceClassId: "static_accessibility_facility", basisAt: snapshot.capturedAt, evaluationAt: snapshot.capturedAt });
  const expectedSchemaFingerprint = sha256(JSON.stringify({
    fieldsProvided: ["elevator", "escalator", "wheelchair_lift", "status", "verified_at"],
    lineIds: [...LINE_IDS], claimFields: Object.keys(claimBindings[0]),
  }));
  const lineages = [...snapshot.topologyLineages, ...snapshot.membershipLineages];
  const expectedLineages = [...TOPOLOGY_LINE_IDS, LINE7];
  if (snapshot.snapshotId !== expectedId || Date.parse(snapshot.freshUntil) <= Date.parse(snapshot.capturedAt)
    || snapshot.freshUntil !== expectedFreshUntil || snapshot.schemaFingerprint !== expectedSchemaFingerprint
    || snapshot.rows.some(({ stationCode, stationName, lineId, elevator, escalator, wheelchair_lift }) => (
      typeof stationCode !== "string" || typeof stationName !== "string" || !LINE_IDS.includes(lineId)
      || !Number.isInteger(elevator) || elevator < 0 || !Number.isInteger(escalator) || escalator < 0
      || !Number.isInteger(wheelchair_lift) || wheelchair_lift < 0
    )) || claimBindings.length !== snapshot.claimBindings.length || JSON.stringify(claimBindings) !== JSON.stringify(snapshot.claimBindings)
    || JSON.stringify(lineages.map(({ sourceId, snapshotId, contentSha256, lineId }) => ({ sourceId, snapshotId, contentSha256, lineId }))) !== JSON.stringify(expectedLineages.map((lineId) => ({ sourceId: TOPOLOGY_SOURCE_ID, snapshotId: lineages[0]?.snapshotId, contentSha256: lineages[0]?.contentSha256, lineId })))) throw new Error("Incheon accessibility snapshot identity is invalid");
  if (topologySnapshot) {
    const topology = validateTopologySnapshot(canonicalTopologySnapshot(topologySnapshot));
    if (lineages.some((lineage) => lineage.snapshotId !== topology.snapshotId || lineage.contentSha256 !== topology.contentSha256)
      || JSON.stringify(snapshot.claimTopology) !== JSON.stringify(topology.scope.map(({ stationId, lineId, stationCode }) => ({ stationId, lineId, stationCode })))) {
      throw new Error("Incheon accessibility snapshot topology lineage is invalid");
    }
  }
  return snapshot;
}

/** Validate the raw OCI payload and recompute every CSV identity from its bytes. */
export function validateIncheonAccessibilityRawCollection(raw, snapshot, freshnessPolicy = TRACKED_FRESHNESS_POLICY) {
  const keys = ["schemaVersion", "artifactKind", "sourceId", "snapshotId", "capturedAt", "snapshotRawSha256", "topologySnapshot", "topologySnapshotId", "topologyContentSha256", "freshnessPolicy", "credentialRedacted", "payloadCount", "inventorySha256", "payloads"];
  if (!raw || JSON.stringify(Object.keys(raw)) !== JSON.stringify(keys)
    || raw.schemaVersion !== 1 || raw.artifactKind !== RAW_ARTIFACT_KIND || raw.sourceId !== SOURCE_ID
    || raw.snapshotId !== snapshot.snapshotId || raw.capturedAt !== snapshot.capturedAt
    || raw.snapshotRawSha256 !== snapshot.rawSha256 || raw.credentialRedacted !== true
    || raw.payloadCount !== DATASET_IDS.length || !SHA256.test(raw.inventorySha256 ?? "")
    || !raw.topologySnapshot || raw.topologySnapshotId !== `incheon-transit-station-info-${raw.topologySnapshot.capturedAt?.slice(0, 10).replaceAll("-", "")}`
    || raw.topologyContentSha256 !== raw.topologySnapshot.contentSha256
    || !Array.isArray(raw.freshnessPolicy?.sourceClasses) || raw.freshnessPolicy.sourceClasses.length !== 1
    || !Array.isArray(raw.payloads) || raw.payloads.length !== DATASET_IDS.length) {
    throw new Error("Incheon accessibility raw collection is invalid");
  }
  const topologySnapshot = canonicalTopologySnapshot(raw.topologySnapshot);
  if (JSON.stringify(topologySnapshot) !== JSON.stringify(raw.topologySnapshot)
    || raw.topologySnapshotId !== topologySnapshot.snapshotId
    || raw.topologyContentSha256 !== topologySnapshot.contentSha256) {
    throw new Error("Incheon accessibility raw collection topology mismatch");
  }
  const expectedFreshnessClass = freshnessPolicy?.sourceClasses?.find(({ id }) => id === "static_accessibility_facility");
  if (!expectedFreshnessClass
    || JSON.stringify(raw.freshnessPolicy) !== JSON.stringify({ sourceClasses: [expectedFreshnessClass] })) {
    throw new Error("Incheon accessibility raw collection freshness policy mismatch");
  }
  const expected = [
    [ELEVATOR_DATASET_ID, "data-go-15083478.csv", "elevatorRawSha256"],
    [ESCALATOR_DATASET_ID, "data-go-15010199.csv", "escalatorRawSha256"],
    [WHEELCHAIR_DATASET_ID, "data-go-15146049.csv", "wheelchairRawSha256"],
  ];
  for (const [index, [datasetId, fileName, field]] of expected.entries()) {
    const entry = raw.payloads[index];
    if (!entry || JSON.stringify(Object.keys(entry)) !== JSON.stringify(["datasetId", "detailUrl", "fileName", "byteSize", "rawSha256", "bodyBase64"])
      || entry.datasetId !== datasetId || entry.fileName !== fileName || entry.detailUrl !== snapshot.detailUrls?.[index === 0 ? "elevator" : index === 1 ? "escalator" : "wheelchair_lift"]
      || !Number.isSafeInteger(entry.byteSize) || entry.byteSize < 1 || !SHA256.test(entry.rawSha256 ?? "")
      || typeof entry.bodyBase64 !== "string") throw new Error("Incheon accessibility raw collection is invalid");
    const bytes = Buffer.from(entry.bodyBase64, "base64");
    if (bytes.length === 0 || bytes.toString("base64") !== entry.bodyBase64 || bytes.length !== entry.byteSize || sha256(bytes) !== entry.rawSha256 || entry.rawSha256 !== snapshot[field]) {
      throw new Error("Incheon accessibility raw collection identity mismatch");
    }
  }
  if (raw.inventorySha256 !== sha256(JSON.stringify(raw.payloads.map(({ datasetId, detailUrl, fileName, byteSize, rawSha256 }) => ({ datasetId, detailUrl, fileName, byteSize, rawSha256 }))))) {
    throw new Error("Incheon accessibility raw collection inventory mismatch");
  }
  validateIncheonAccessibilitySnapshotIdentity(snapshot, freshnessPolicy, topologySnapshot);
  const rerun = collectIncheonAccessibility({
    elevatorBytes: Buffer.from(raw.payloads[0].bodyBase64, "base64"), escalatorBytes: Buffer.from(raw.payloads[1].bodyBase64, "base64"),
    wheelchairBytes: Buffer.from(raw.payloads[2].bodyBase64, "base64"), topologySnapshot: raw.topologySnapshot, freshnessPolicy, now: new Date(snapshot.capturedAt),
  });
  if (JSON.stringify(rerun) !== JSON.stringify(snapshot)) throw new Error("Incheon accessibility raw collection snapshot mismatch");
  return raw;
}

function countFacilityRows({
  bytes,
  expectedHeaders,
  expectedCsvRowCount,
  expectedJoinedCount,
  expectedSkippedLine7,
  expectedSkippedNonStation,
  label,
  scopeByKey,
  allowNonStationSkip,
}) {
  const table = parseCsv(decodeOfficialCsv(bytes));
  if (table.length < 2) throw new Error(`Incheon ${label} CSV has no data rows`);
  const header = table[0];
  if (JSON.stringify(header) !== JSON.stringify(expectedHeaders)) {
    throw new Error(`Incheon ${label} CSV missing column`);
  }
  const lineIndex = header.indexOf("호선");
  const nameIndex = header.indexOf("역명");
  const counts = new Map();
  let skippedLine7 = 0;
  const skippedNonStationNames = [];
  for (const [rowIndex, row] of table.slice(1).entries()) {
    if (row.length !== header.length) {
      throw new Error(`Incheon ${label} CSV column count mismatch at row ${rowIndex + 2}`);
    }
    const lineRaw = String(row[lineIndex] ?? "").normalize("NFKC").trim();
    const lineId = CSV_LINE_TO_ID[lineRaw];
    if (!lineId) {
      throw new Error(`Incheon ${label} unexpected line at row ${rowIndex + 2}: ${lineRaw}`);
    }
    const stationNameRaw = String(row[nameIndex] ?? "").normalize("NFKC").trim();
    if (stationNameRaw.length === 0) {
      throw new Error(`Incheon ${label} empty station name at row ${rowIndex + 2}`);
    }
    if (NON_STATION_FACILITY_NAMES.has(stationNameRaw)) {
      if (!allowNonStationSkip) {
        throw new Error(`Incheon ${label} unexpected non-station facility row: ${stationNameRaw}`);
      }
      skippedNonStationNames.push(stationNameRaw);
      continue;
    }
    const station = scopeByKey.get(`${lineId}:${normalizedIncheonStationName(stationNameRaw)}`);
    if (!station) {
      throw new Error(`Incheon accessibility station join failed: ${lineRaw}:${stationNameRaw}`);
    }
    counts.set(station.stationCode, (counts.get(station.stationCode) ?? 0) + 1);
  }
  if (table.length - 1 !== expectedCsvRowCount) {
    throw new Error(`Incheon ${label} CSV row count mismatch: ${table.length - 1}`);
  }
  if (skippedLine7 !== expectedSkippedLine7) {
    throw new Error(`Incheon ${label} line7 skip count mismatch: ${skippedLine7}`);
  }
  if (skippedNonStationNames.length !== expectedSkippedNonStation) {
    throw new Error(`Incheon ${label} non-station skip count mismatch: ${skippedNonStationNames.length}`);
  }
  const joined = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (joined !== expectedJoinedCount) {
    throw new Error(`Incheon ${label} joined row count mismatch: ${joined}`);
  }
  return { counts, skippedLine7, skippedNonStationNames };
}

function validateTopologySnapshot(topologySnapshot) {
  validateIncheonStationInfoSnapshot(topologySnapshot);
  const capturedDate = topologySnapshot.capturedAt?.slice(0, 10).replaceAll("-", "");
  const snapshotId = `${TOPOLOGY_SOURCE_ID}-${capturedDate}`;
  const topologyScope = (topologySnapshot.scope ?? [])
    .filter((station) => LINE_IDS.includes(station.lineId));
  if (topologySnapshot.sourceId !== TOPOLOGY_SOURCE_ID
    || !/^\d{8}$/u.test(capturedDate ?? "")
    || topologySnapshot.snapshotId !== snapshotId
    || JSON.stringify(topologySnapshot.topologyLineIds) !== JSON.stringify([...TOPOLOGY_LINE_IDS])
    || JSON.stringify(topologySnapshot.lineIds) !== JSON.stringify([...LINE_IDS])
    || topologyScope.length !== EXPECTED_STATION_COUNT) {
    throw new Error("invalid Incheon topology snapshot");
  }
  return { scope: topologyScope, snapshotId, contentSha256: topologySnapshot.contentSha256 };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }
  if (cell || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.trim() !== "")) rows.push(row);
  }
  return rows;
}

function validDate(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} is invalid`);
  return date;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--")) {
      throw new Error("usage: collect-incheon-accessibility.mjs --elevator-input <csv> --escalator-input <csv> --wheelchair-input <csv> --topology-snapshot <json> (--output <absolute.json> | --observation-output <absolute-dir>) [--captured-at <iso>]");
    }
    args[argv[index].slice(2)] = argv[index + 1];
  }
  const hasSnapshotOutput = typeof args.output === "string" && path.isAbsolute(args.output);
  const hasObservationOutput = typeof args["observation-output"] === "string" && path.isAbsolute(args["observation-output"]);
  if (!args["elevator-input"] || !args["escalator-input"] || !args["wheelchair-input"]
    || !args["topology-snapshot"] || (hasSnapshotOutput === hasObservationOutput)) {
    throw new Error("usage: collect-incheon-accessibility.mjs --elevator-input <csv> --escalator-input <csv> --wheelchair-input <csv> --topology-snapshot <json> (--output <absolute.json> | --observation-output <absolute-dir>) [--captured-at <iso>]");
  }
  return args;
}

export async function runIncheonAccessibilityCollector(argv) {
  const args = parseArgs(argv);
  const topologyPath = args["topology-snapshot"];
  const topologySnapshotId = path.basename(topologyPath, ".json");
  if (!/^incheon-transit-station-info-\d{8}$/u.test(topologySnapshotId)) {
    throw new Error("Incheon topology snapshot path is invalid");
  }
  const [elevatorBytes, escalatorBytes, wheelchairBytes, topologySnapshot, freshnessPolicy] = await Promise.all([
    readFile(args["elevator-input"]),
    readFile(args["escalator-input"]),
    readFile(args["wheelchair-input"]),
    readFile(topologyPath, "utf8").then(JSON.parse),
    readFile(path.resolve(import.meta.dirname, "../../release/product-gates/datapack-freshness-sla.json"), "utf8").then(JSON.parse),
  ]);
  const boundTopologySnapshot = canonicalTopologySnapshot(topologySnapshot);
  const snapshot = collectIncheonAccessibility({
    elevatorBytes,
    escalatorBytes,
    wheelchairBytes,
    topologySnapshot: boundTopologySnapshot,
    freshnessPolicy,
    now: args["captured-at"] ? new Date(args["captured-at"]) : new Date(),
  });
  if (args.output) {
    await writeFile(args.output, `${JSON.stringify(snapshot)}\n`);
  } else {
    const root = path.resolve(args["observation-output"]);
    const rawPayloads = [
      [ELEVATOR_DATASET_ID, ELEVATOR_DETAIL_URL, "data-go-15083478.csv", elevatorBytes, snapshot.elevatorRawSha256],
      [ESCALATOR_DATASET_ID, ESCALATOR_DETAIL_URL, "data-go-15010199.csv", escalatorBytes, snapshot.escalatorRawSha256],
      [WHEELCHAIR_DATASET_ID, WHEELCHAIR_DETAIL_URL, "data-go-15146049.csv", wheelchairBytes, snapshot.wheelchairRawSha256],
    ].map(([datasetId, detailUrl, fileName, bytes, rawSha256]) => ({ datasetId, detailUrl, fileName, byteSize: bytes.length, rawSha256, bodyBase64: Buffer.from(bytes).toString("base64") }));
    const raw = {
      schemaVersion: 1, artifactKind: RAW_ARTIFACT_KIND, sourceId: SOURCE_ID, snapshotId: snapshot.snapshotId,
      capturedAt: snapshot.capturedAt, snapshotRawSha256: snapshot.rawSha256, topologySnapshot: boundTopologySnapshot,
      topologySnapshotId, topologyContentSha256: boundTopologySnapshot.contentSha256,
      freshnessPolicy: { sourceClasses: [freshnessPolicy.sourceClasses.find(({ id }) => id === "static_accessibility_facility")] },
      credentialRedacted: true, payloadCount: rawPayloads.length,
      inventorySha256: sha256(JSON.stringify(rawPayloads.map(({ datasetId, detailUrl, fileName, byteSize, rawSha256 }) => ({ datasetId, detailUrl, fileName, byteSize, rawSha256 })))), payloads: rawPayloads,
    };
    validateIncheonAccessibilitySnapshotIdentity(snapshot, freshnessPolicy, boundTopologySnapshot);
    validateIncheonAccessibilityRawCollection(raw, snapshot, freshnessPolicy);
    const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
    const rawBytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`);
    const manifest = {
      schemaVersion: 1, artifactKind: OBSERVATION_ARTIFACT_KIND, sourceId: SOURCE_ID, capturedAt: snapshot.capturedAt,
      snapshotId: snapshot.snapshotId, snapshotRawSha256: snapshot.rawSha256, snapshotFile: `${snapshot.snapshotId}.json`,
      snapshotFileSha256: sha256(snapshotBytes), rawArtifactFile: `${snapshot.snapshotId}.raw.json`, rawObjectSha256: sha256(rawBytes),
      rawObjectChecksumSha256: createHash("sha256").update(rawBytes).digest("base64"), rawObjectByteSize: rawBytes.length, credentialRedacted: true,
    };
    const parent = path.dirname(root);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const parentStat = await lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("Incheon accessibility observation parent is invalid");
    const finalOutput = path.join(await realpath(parent), path.basename(root));
    try { await mkdir(finalOutput, { mode: 0o700 }); } catch (error) {
      if (error?.code === "EEXIST") throw new Error("Incheon accessibility observation output already exists");
      throw error;
    }
    try {
      for (const [name, bytes] of [[manifest.snapshotFile, snapshotBytes], [manifest.rawArtifactFile, rawBytes], ["observation.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)]]) {
        await writeFile(path.join(finalOutput, name), bytes, { flag: "wx", mode: 0o600 });
      }
    } catch (error) {
      await rm(finalOutput, { recursive: true, force: true });
      throw error;
    }
  }
  console.log(`Incheon accessibility snapshot ready: stations=${snapshot.stationCount} rows=${snapshot.rowCount}`);
  return snapshot;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runIncheonAccessibilityCollector(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Incheon accessibility collection failed");
    process.exitCode = 1;
  }
}
