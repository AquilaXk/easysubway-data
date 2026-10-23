#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateKricAccessibilitySnapshotIdentity } from "./collect-kric-accessibility-snapshots.mjs";
import {
  KRIC_STANDARD_FACILITY_TYPES,
  KRIC_STANDARD_SOURCE_ID as KRIC_SOURCE_ID,
  kricStandardStationContexts,
  kricStandardQueryFacilities,
  validateKricStandardProviderRows,
} from "./lib/kric-standard-facilities.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { RETIRED_KRIC_ACCESSIBILITY_SOURCE_IDS, RETIRED_KRIC_MOVEMENT_SOURCE_IDS } from "./lib/retired-sources.mjs";

const SEOUL_SOURCE_ID = "seoul-metro-accessibility";
const TERMINAL_POLICY = "EXACT_TUPLE_PROVIDER_RESULT_03";
const TERMINAL_TUPLE = Object.freeze({ stationId: "station-b35616704ce3", lineId: "seoul-2", railOprIsttCd: "S1", lnCd: "2", stinCd: "234-4" });
const TERMINAL_OPERATOR_ID = "seoul-metro";
const TERMINAL_REASON = "시설 존재·부재가 검증되지 않아 경로를 차단했습니다.";
const KRIC_STATUS_EVIDENCE_NOTES = Object.freeze({
  NOT_EXISTS: "KRIC stationCnvFacl exhaustive tuple query에 해당 facility code가 없다.",
  UNKNOWN: "KRIC stationCnvFacl 조회로는 이 시설 유형의 존재·부재를 알 수 없다.",
});

export function materializeAccessibilitySourceInput({ input, kricSnapshot, seoulSnapshot }) {
  if (kricSnapshot?.sourceId !== KRIC_SOURCE_ID || seoulSnapshot?.sourceId !== SEOUL_SOURCE_ID) {
    throw new Error("accessibility snapshot source identity mismatch");
  }
  const packStationLines = (input.stationMappings ?? []).filter(({ sourceId }) => sourceId === "molit-urban-rail-full-route");
  const mappings = new Map(packStationLines.map((mapping) => [mapping.stationId, mapping]));
  const facilityIdsByProviderRef = new Map();
  const providerRefsByFacilityId = new Map();
  for (const row of (input.facilityRows ?? []).filter(({ sourceId }) => sourceId === KRIC_SOURCE_ID)) {
    if (!/^[0-9a-f]{64}$/.test(row.providerRecordHash ?? "")
      || typeof row.providerFacilityRef !== "string"
      || !row.providerFacilityRef.endsWith(`:${row.providerRecordHash}`)
      || typeof row.id !== "string" || row.id === "" || row.id.length > 120) {
      throw new Error(`malformed facility identity fields: ${row.id ?? "<unknown>"}`);
    }
    if ((facilityIdsByProviderRef.has(row.providerFacilityRef)
        && facilityIdsByProviderRef.get(row.providerFacilityRef) !== row.id)
      || (providerRefsByFacilityId.has(row.id)
        && providerRefsByFacilityId.get(row.id) !== row.providerFacilityRef)) {
      throw new Error("facility identity collision");
    }
    facilityIdsByProviderRef.set(row.providerFacilityRef, row.id);
    providerRefsByFacilityId.set(row.id, row.providerFacilityRef);
  }
  const facilityRows = [];
  const absenceRows = [];
  const snapshotQueries = kricSnapshot.queries ?? [];
  validateKricStandardProviderRows(snapshotQueries);
  const stationContexts = kricStandardStationContexts(kricSnapshot, snapshotQueries, packStationLines);
  const regionalRoster = input.kricStandardAccessibilityRoster;
  const regionalRosterKeys = regionalRoster == null ? null : exactRosterKeys(regionalRoster);
  const regionalQueries = regionalRosterKeys == null
    ? snapshotQueries
    : snapshotQueries.filter((query) => regionalRosterKeys.has(rosterKey(query)));
  for (const query of regionalQueries) {
    const mapping = mappings.get(query.stationId);
    if (!mapping || mapping.lineId !== query.lineId || !Array.isArray(query.rows)) {
      throw new Error(`KRIC snapshot canonical mapping missing: ${query?.stationId}`);
    }
    if (isTerminalQuery(query)) {
      for (const facilityType of KRIC_STANDARD_FACILITY_TYPES) absenceRows.push({
        stationId: query.stationId,
        lineId: query.lineId,
        operatorId: TERMINAL_OPERATOR_ID,
        facilityType,
        state: "UNVERIFIED_EVIDENCE_BLOCKED",
        evidenceKind: "UNVERIFIED_EVIDENCE_BLOCKED",
        terminalPolicy: TERMINAL_POLICY,
        providerResultCode: "03",
        sourceId: KRIC_SOURCE_ID,
        sourceSnapshotId: kricSnapshot.snapshotId,
        providerRecordHash: null,
        providerResponseSha256: query.rawResponseSha256,
        evidenceHash: createHash("sha256").update(canonicalJson({
          sourceSnapshotId: kricSnapshot.snapshotId,
          stationId: query.stationId,
          lineId: query.lineId,
          operatorId: TERMINAL_OPERATOR_ID,
          facilityType,
          terminalPolicy: TERMINAL_POLICY,
          providerResponseSha256: query.rawResponseSha256,
        })).digest("hex"),
        provenanceKind: "OFFICIAL_SOURCE",
        installationStatus: "UNKNOWN",
        operationalStatus: "UNKNOWN",
        statusMeaning: "PROVIDER_RESULT_UNVERIFIED",
        confidence: 0,
        verifiedAt: kricSnapshot.observedAt,
        retrievedAt: kricSnapshot.capturedAt,
        strictRouteEligible: false,
        strictRouteEligibleReason: "UNVERIFIED_PROVIDER_EVIDENCE_BLOCKED",
        evidenceReason: TERMINAL_REASON,
        note: "KRIC provider result 03은 시설 존재·부재로 해석하지 않는다.",
      });
      continue;
    }
    const { facilities, statusEvidence } = kricStandardQueryFacilities({
      snapshot: kricSnapshot, query, stationName: stationLineIdentity(input, mapping).stationNameKo, stationContexts,
    });
    for (const facility of facilities) {
      const { providerFacilityRef } = facility;
      const facilityId = facilityIdsByProviderRef.get(providerFacilityRef) ?? facility.id;
      if (providerRefsByFacilityId.has(facilityId)
          && providerRefsByFacilityId.get(facilityId) !== providerFacilityRef) {
        throw new Error("facility identity collision");
      }
      facilityIdsByProviderRef.set(providerFacilityRef, facilityId);
      providerRefsByFacilityId.set(facilityId, providerFacilityRef);
      facilityRows.push({
        sourceId: KRIC_SOURCE_ID,
        id: facilityId,
        station: { sourceId: mapping.sourceId, sourceStationCode: mapping.sourceStationCode, lineId: mapping.lineId },
        type: facility.type,
        name: facility.name,
        status: "UNKNOWN",
        statusMeaning: "STATIC_LOCATION",
        operationalStatus: "UNKNOWN",
        installationStatus: "INSTALLED",
        providerFacilityRef,
        provenanceKind: "OFFICIAL_SOURCE",
        floorFrom: facility.floorFrom,
        floorTo: "",
        description: facility.description,
        verifiedAt: kricSnapshot.observedAt,
        retrievedAt: kricSnapshot.capturedAt,
        sourceSnapshotId: kricSnapshot.snapshotId,
        providerRecordHash: facility.providerRecordHash,
        evidenceHash: facility.evidenceHash,
        confidence: 100,
      });
    }
    absenceRows.push(...statusEvidence.map((row) => ({ ...row, note: KRIC_STATUS_EVIDENCE_NOTES[row.evidenceKind] })));
  }

  const seoulStations = new Map((seoulSnapshot.stations ?? []).map((station) => [
    `${normalize(station.stationName)}\0${station.lineName}`,
    station,
  ]));
  const seoulRows = (input.supportedV1Scope?.includedStationIds ?? []).map((stationId) => {
    const mapping = mappings.get(stationId);
    if (!mapping) throw new Error(`station mapping missing: ${stationId}`);
    const stationName = stationLineIdentity(input, mapping).stationNameKo;
    const lineNumber = mapping.lineId.match(/(\d+)$/)?.[1];
    if (!lineNumber) throw new Error(`station line number missing: ${stationId}`);
    const lineName = `${lineNumber}호선`;
    const station = seoulStations.get(`${normalize(stationName)}\0${lineName}`);
    const states = station?.facilities?.map(({ operational }) => operational) ?? [];
    const evidenceKind = station ? "EXISTS" : "NOT_EXISTS";
    const operationalStatus = !station ? "NOT_COVERED"
      : states.some((state) => state === false) ? "UNDER_MAINTENANCE"
        : states.length > 0 && states.every((state) => state === true) ? "AVAILABLE" : "UNKNOWN";
    const providerRecordHash = hash(station ?? { stationId, lineName, status: "NOT_COVERED" });
    return {
      stationId,
      lineId: mapping.lineId,
      facilityType: "ACCESSIBILITY_STATUS_PROBE",
      evidenceKind,
      sourceId: SEOUL_SOURCE_ID,
      sourceSnapshotId: seoulSnapshot.snapshotId,
      providerRecordHash,
      evidenceHash: seoulStatusEvidenceHash({ snapshotId: seoulSnapshot.snapshotId, stationId, lineId: mapping.lineId, providerRecordHash }),
      provenanceKind: "OFFICIAL_SOURCE",
      installationStatus: station ? "INSTALLED" : "NOT_COVERED",
      operationalStatus,
      statusMeaning: station ? "REALTIME_OPERATION" : "FEED_ABSENCE_RECORD",
      confidence: 100,
      verifiedAt: seoulSnapshot.observedAt,
      retrievedAt: seoulSnapshot.capturedAt,
      strictRouteEligibleReason: station ? "STATUS_PROBE_NOT_ROUTE_EVIDENCE" : "NO_OFFICIAL_STATUS_FEED",
      note: station ? "서울교통공사 전체 승강기 운행상황 snapshot 실측." : "서울교통공사 운행상황 feed의 구조적 미커버.",
    };
  });

  const replacedSourceIds = new Set(RETIRED_KRIC_ACCESSIBILITY_SOURCE_IDS);
  const sourceIds = [...new Set([
    ...input.sourceIds.filter((sourceId) => !replacedSourceIds.has(sourceId)), KRIC_SOURCE_ID, SEOUL_SOURCE_ID,
  ])];
  const coverageEvidence = input.coverageEvidence.map((entry) => entry.sourceDomain !== "accessibility_facilities"
    ? entry
    : { ...entry, sourceIds: [KRIC_SOURCE_ID, SEOUL_SOURCE_ID] });
  const blockedMovementSourceIds = new Set(RETIRED_KRIC_MOVEMENT_SOURCE_IDS);
  const statusByStation = new Map(seoulRows.map((row) => [row.stationId, row]));
  const routeEdges = (input.routeEdges ?? []).map((edge) => {
    if (edge.sourceId !== SEOUL_SOURCE_ID || !["ENTRY", "EXIT"].includes(edge.edgeType)) return edge;
    const endpoint = edge.edgeType === "ENTRY" ? edge.to : edge.from;
    const stationCode = endpoint?.sourceStationCode;
    const matchingMappings = [...mappings.values()].filter((entry) =>
      entry.lineId === endpoint?.lineId && entry.sourceStationCode.endsWith(`-${stationCode}`));
    if (matchingMappings.length !== 1) throw new Error(`Seoul edge station mapping invalid: ${edge.id}`);
    const status = statusByStation.get(matchingMappings[0].stationId);
    if (!status) throw new Error(`Seoul edge station evidence missing: ${edge.id}`);
    return {
      ...edge,
      stairAccessState: "UNKNOWN",
      accessibilityStatus: status.evidenceKind === "NOT_EXISTS" ? "NO_OFFICIAL_FEED" : "UNKNOWN",
      verificationStatus: "NOT_VERIFIED",
      lastVerifiedAt: seoulSnapshot.observedAt,
      sourceSnapshotId: seoulSnapshot.snapshotId,
      providerRecordHash: status.providerRecordHash,
      evidenceHash: seoulEdgeEvidenceHash({ edgeId: edge.id, sourceSnapshotId: seoulSnapshot.snapshotId, providerRecordHash: status.providerRecordHash }),
    };
  });
  const minimumFacilities = input.minimumProductionCoverage?.facilities;
  if (!Number.isSafeInteger(minimumFacilities) || facilityRows.length < minimumFacilities) {
    throw new Error(`accessibility facility coverage below declared minimum: ${facilityRows.length}/${minimumFacilities}`);
  }
  return {
    ...input,
    sourceIds,
    coverageEvidence,
    movementPathCandidates: (input.movementPathCandidates ?? [])
      .filter(({ sourceId }) => !blockedMovementSourceIds.has(sourceId)),
    routeEdges,
    facilityRows,
    accessibilityStatusEvidence: [...absenceRows, ...seoulRows],
  };
}

function rosterKey(value) {
  const fields = ["stationId", "lineId", "railOprIsttCd", "lnCd", "stinCd"];
  if (!value || fields.some((field) => typeof value[field] !== "string" || value[field] === "")) {
    throw new Error("KRIC accessibility roster is invalid");
  }
  return fields.map((field) => value[field]).join("\0");
}

function exactRosterKeys(values) {
  if (!Array.isArray(values) || values.length === 0) throw new Error("KRIC accessibility roster is invalid");
  const keys = new Set(values.map(rosterKey));
  if (keys.size !== values.length) throw new Error("KRIC accessibility roster is invalid");
  return keys;
}

function isTerminalQuery(query) {
  return query?.providerResultCode === "03"
    && query.terminalPolicy === TERMINAL_POLICY
    && query.providerRecordHash === null
    && query.rows?.length === 0
    && /^[0-9a-f]{64}$/.test(query.rawResponseSha256 ?? "")
    && Object.entries(TERMINAL_TUPLE).every(([field, value]) => query[field] === value);
}

function stationLineIdentity(input, mapping) {
  const stationCode = mapping.sourceStationCode.split("-").at(-1);
  const matches = input.stationLineRows.filter((row) =>
    row.sourceId === mapping.sourceId
    && row.sourceStationCode === mapping.sourceStationCode
    && row.stationCode === stationCode
    && row.lineId === mapping.lineId);
  if (matches.length !== 1 || typeof matches[0].stationNameKo !== "string" || matches[0].stationNameKo.trim() === "") {
    throw new Error(`${matches.length > 1 ? "station identity ambiguous" : "station name missing"}: ${mapping.stationId}`);
  }
  return matches[0];
}

function normalize(value) {
  return String(value ?? "").normalize("NFKC").replace(/역$/u, "").replace(/[^\p{L}\p{N}]+/gu, "");
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// 서울 접근성 증거 해시의 계산 방식(키 순서가 해시를 정한다). 자동 병합 정책(refresh-stage-contracts)이 같은 함수로 다시 계산해 대조한다.
export function seoulStatusEvidenceHash({ snapshotId, stationId, lineId, providerRecordHash }) {
  return hash({ snapshotId, stationId, lineId, providerRecordHash });
}

export function seoulEdgeEvidenceHash({ edgeId, sourceSnapshotId, providerRecordHash }) {
  return hash({ edgeId, sourceSnapshotId, providerRecordHash });
}

async function main(argv) {
  const allowed = new Set(["input", "kric-snapshot", "seoul-snapshot", "output"]);
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || !allowed.has(key.slice(2))) {
      throw new Error(`unknown argument: ${key ?? ""}`);
    }
    if (Object.hasOwn(args, key.slice(2))) throw new Error(`duplicate argument: ${key}`);
    args[key.slice(2)] = value;
  }
  for (const name of ["input", "kric-snapshot", "seoul-snapshot", "output"]) if (!args[name]) throw new Error(`missing --${name}`);
  const [input, kricSnapshot, seoulSnapshot] = await Promise.all([
    readJson(args.input), readJson(args["kric-snapshot"]), readJson(args["seoul-snapshot"]),
  ]);
  const validatedKricSnapshot = validateKricAccessibilitySnapshotIdentity(kricSnapshot);
  const output = materializeAccessibilitySourceInput({ input, kricSnapshot: validatedKricSnapshot, seoulSnapshot });
  output.kricStandardAccessibilitySnapshot = {
    snapshotId: validatedKricSnapshot.snapshotId,
    contentSha256: validatedKricSnapshot.contentSha256,
    freshUntil: validatedKricSnapshot.freshUntil,
  };
  await writeFile(args.output, `${JSON.stringify(output, null, 2)}\n`);
}

async function readJson(file) { return JSON.parse(await readFile(file, "utf8")); }

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
