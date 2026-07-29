#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { codepointCompare } from "../lib/codepoint-compare.mjs";

const KRIC_SOURCE_ID = "kric-station-convenience-standard";
const SEOUL_SOURCE_ID = "seoul-metro-accessibility";
// KRIC official stationCnvFacl contract: EV/ES/WCLF are the only route-relevant facility codes.
const FACILITY_TYPES = new Map([["EV", "ELEVATOR"], ["ES", "ESCALATOR"], ["WCLF", "WHEELCHAIR_LIFT"]]);
const KRIC_FACILITY_CODES = new Set([...FACILITY_TYPES.keys(), "ELEC", "FEED", "INFO", "TOLT"]);

export function materializeAccessibilitySourceInput({ input, kricSnapshot, seoulSnapshot }) {
  if (kricSnapshot?.sourceId !== KRIC_SOURCE_ID || seoulSnapshot?.sourceId !== SEOUL_SOURCE_ID) {
    throw new Error("accessibility snapshot source identity mismatch");
  }
  const mappings = new Map((input.stationMappings ?? [])
    .filter(({ sourceId }) => sourceId === "molit-urban-rail-full-route")
    .map((mapping) => [mapping.stationId, mapping]));
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
  for (const query of kricSnapshot.queries ?? []) {
    const mapping = mappings.get(query.stationId);
    if (!mapping || mapping.lineId !== query.lineId || !Array.isArray(query.rows)) {
      throw new Error(`KRIC snapshot canonical mapping missing: ${query?.stationId}`);
    }
    const stationName = stationLineIdentity(input, mapping).stationNameKo;
    const counts = new Map();
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
    for (const { row, type, providerRecordHash } of supportedRows
      .sort((left, right) => codepointCompare(left.providerRecordHash, right.providerRecordHash))) {
      const number = (counts.get(type) ?? 0) + 1;
      counts.set(type, number);
      const providerFacilityRef = `${query.railOprIsttCd}:${query.lnCd}:${query.stinCd}:${row.gubun}:${providerRecordHash}`;
      const facilityId = facilityIdsByProviderRef.get(providerFacilityRef)
        ?? `facility-${query.stationId}-${type.toLowerCase()}-kric-standard-${providerRecordHash.slice(0, 16)}`;
      if (facilityId.length > 120) {
        throw new Error(`facility identity exceeds 120 characters: ${facilityId}`);
      }
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
        type,
        name: `${stationName}역 ${type} ${number}`,
        status: "UNKNOWN",
        statusMeaning: "STATIC_LOCATION",
        operationalStatus: "UNKNOWN",
        installationStatus: "INSTALLED",
        providerFacilityRef,
        provenanceKind: "OFFICIAL_SOURCE",
        floorFrom: kricFloorLabel(row),
        floorTo: "",
        description: row.dtlLoc,
        verifiedAt: kricSnapshot.observedAt,
        retrievedAt: kricSnapshot.capturedAt,
        sourceSnapshotId: kricSnapshot.snapshotId,
        providerRecordHash,
        evidenceHash: hash({ snapshotId: kricSnapshot.snapshotId, query: tuple(query), providerRecordHash }),
        confidence: 100,
      });
    }
    for (const type of FACILITY_TYPES.values()) {
      if (counts.has(type)) continue;
      absenceRows.push({
        stationId: query.stationId,
        lineId: query.lineId,
        facilityType: type,
        evidenceKind: "NOT_EXISTS",
        sourceId: KRIC_SOURCE_ID,
        sourceSnapshotId: kricSnapshot.snapshotId,
        providerRecordHash: query.providerRecordHash,
        evidenceHash: hash({ snapshotId: kricSnapshot.snapshotId, query: tuple(query), type, evidenceKind: "NOT_EXISTS" }),
        provenanceKind: "OFFICIAL_SOURCE",
        installationStatus: "NOT_INSTALLED",
        operationalStatus: "NOT_APPLICABLE",
        statusMeaning: "EXHAUSTIVE_LIST_ABSENCE",
        confidence: 100,
        verifiedAt: kricSnapshot.observedAt,
        retrievedAt: kricSnapshot.capturedAt,
        strictRouteEligibleReason: "FACILITY_NOT_INSTALLED",
        note: "KRIC stationCnvFacl exhaustive tuple query에 해당 facility code가 없다.",
      });
    }
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
      evidenceHash: hash({ snapshotId: seoulSnapshot.snapshotId, stationId, lineId: mapping.lineId, providerRecordHash }),
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

  const replacedSourceIds = new Set(["kric-station-elevator", "kric-station-escalator", "kric-wheelchair-lift-location"]);
  const sourceIds = [...new Set([
    ...input.sourceIds.filter((sourceId) => !replacedSourceIds.has(sourceId)), KRIC_SOURCE_ID, SEOUL_SOURCE_ID,
  ])];
  const coverageEvidence = input.coverageEvidence.map((entry) => entry.sourceDomain !== "accessibility_facilities"
    ? entry
    : { ...entry, sourceIds: [KRIC_SOURCE_ID, "kric-station-elevator-movement", "kric-wheelchair-lift-movement", SEOUL_SOURCE_ID] });
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
      evidenceHash: hash({ edgeId: edge.id, sourceSnapshotId: seoulSnapshot.snapshotId, providerRecordHash: status.providerRecordHash }),
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
    routeEdges,
    facilityRows,
    accessibilityStatusEvidence: [...absenceRows, ...seoulRows],
  };
}

function tuple(query) {
  return { railOprIsttCd: query.railOprIsttCd, lnCd: query.lnCd, stinCd: query.stinCd };
}

function kricFloorLabel(row) {
  if (row.stinFlor === undefined || row.stinFlor === null || row.stinFlor === "") return "";
  if (String(row.grndDvCd) === "1") return `${row.stinFlor}F`;
  if (String(row.grndDvCd) === "2") return `B${row.stinFlor}`;
  throw new Error(`unknown KRIC ground division code: ${row.grndDvCd ?? "<missing>"}`);
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
  const output = materializeAccessibilitySourceInput({ input, kricSnapshot, seoulSnapshot });
  await writeFile(args.output, `${JSON.stringify(output, null, 2)}\n`);
}

async function readJson(file) { return JSON.parse(await readFile(file, "utf8")); }

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
