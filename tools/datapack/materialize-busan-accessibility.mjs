#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { observedBusanAccessibilityRows } from "./collect-busan-accessibility.mjs";
import { busanRouteTopologyContentHash } from "./collect-busan-route-topology.mjs";
import { normalizedStationName } from "./materialize-busan-route-topology.mjs";

const SOURCE_ID = "busan-transportation-accessibility";
const TOPOLOGY_SOURCE_ID = "busan-transportation-route-topology";
const PACK_ID = "nationwide-busan-accessibility";
const EXPECTED_STATION_COUNT = 114;
const FRESHNESS_MILLIS = 24 * 60 * 60 * 1_000;
const LINE_IDS = Object.freeze([
  "line-ab1a041f6266",
  "line-d74614a04530",
  "line-d812a5bc1e5f",
  "line-eb7b47920390",
]);
const FACILITY_TYPES = Object.freeze([
  {
    type: "ELEVATOR",
    field: "elevator",
    slug: "elevator",
    labelKo: "엘리베이터",
    countOf: (row) => observedSum(row.el_i, row.el_o),
  },
  {
    type: "ESCALATOR",
    field: "escalator",
    slug: "escalator",
    labelKo: "에스컬레이터",
    countOf: (row) => observedSum(row.es),
  },
  {
    type: "WHEELCHAIR_LIFT",
    field: "wheelchair_lift",
    slug: "wheelchair-lift",
    labelKo: "휠체어리프트",
    countOf: (row) => observedSum(row.wl_i, row.wl_o),
  },
]);

export function materializeBusanAccessibility({
  baseFixture,
  accessibilitySnapshot,
  topologySnapshot,
  inventory,
}) {
  const rows = validateSnapshot(accessibilitySnapshot);
  // count는 보존 원문에 명시된 값만 쓴다. 빈 필드(미관측)가 섞인 시설 종류는 claim·시설 행을 만들지 않는다.
  const observedRows = observedBusanAccessibilityRows(accessibilitySnapshot);
  const source = requiredSource(inventory, accessibilitySnapshot, topologySnapshot);
  const fixture = structuredClone(baseFixture);
  const pack = fixture.packs?.[0];
  if (!pack || fixture.packs.length !== 1 || pack.artifactKind !== "production") {
    throw new Error("Busan accessibility requires one cumulative production pack");
  }
  if (pack.sourceInventory.some(({ id }) => id === SOURCE_ID)) {
    throw new Error(`${SOURCE_ID} already exists`);
  }
  const stations = canonicalStations(pack, topologySnapshot);
  validateTopologyLineage(pack, source.accessibilityAdmissionEvidence, topologySnapshot, stations);

  const snapshotId = source.accessibilityAdmissionEvidence.snapshotId;
  const facilities = [];
  const evidence = [];
  for (const [rowIndex, row] of rows.entries()) {
    const stationId = stations.get(`${row.lineId}:${row.stationCode}`);
    if (!stationId) {
      throw new Error(`Busan accessibility canonical station missing: ${row.lineId}:${row.stationCode}`);
    }
    const stationName = pack.stations.find(({ id }) => id === stationId)?.nameKo ?? row.stationName;
    for (const facilityType of FACILITY_TYPES) {
      const count = facilityType.countOf(observedRows[rowIndex]);
      if (count === null) continue;
      if (!Number.isInteger(count) || count < 0) {
        throw new Error(`Busan accessibility count invalid: ${row.stationCode}:${facilityType.type}`);
      }
      const exists = count > 0;
      const providerRecordHash = sha256(JSON.stringify({
        stationCode: row.stationCode,
        lineId: row.lineId,
        type: facilityType.type,
        count,
        wl_i: row.wl_i,
        wl_o: row.wl_o,
        el_i: row.el_i,
        el_o: row.el_o,
        es: row.es,
      }));
      const id = `facility-busan-${row.stationCode}-${facilityType.slug}`;
      facilities.push({
        id,
        stationId,
        lineId: row.lineId,
        exitId: null,
        type: facilityType.type,
        name: `${stationName}역 ${facilityType.labelKo} 설치 정보`,
        status: "UNKNOWN",
        floorFrom: "",
        floorTo: "",
        description: exists
          ? `부산교통공사 편의시설 API 기준 ${facilityType.labelKo} ${count}대 설치 정보이며 실시간 운행 상태가 아닙니다.`
          : `부산교통공사 편의시설 API 기준 ${facilityType.labelKo} 미설치(count=0) 기록이며 실시간 운행 상태가 아닙니다.`,
        sourceId: SOURCE_ID,
        sourceSnapshotId: snapshotId,
        providerFacilityRef: `busan-accessibility-${row.stationCode}-${facilityType.slug}`,
        providerRecordHash,
        provenanceKind: "OFFICIAL_SOURCE",
        statusMeaning: "STATIC_LOCATION",
        operationalStatus: "UNKNOWN",
        installationStatus: exists ? "INSTALLED" : "NOT_INSTALLED",
        verifiedAt: accessibilitySnapshot.capturedAt,
        retrievedAt: accessibilitySnapshot.capturedAt,
        evidenceHash: accessibilitySnapshot.rowsSha256,
        confidence: 80,
        derivationKind: "OFFICIAL",
        lastVerifiedAt: accessibilitySnapshot.capturedAt,
      });
      evidence.push({
        stationId,
        lineId: row.lineId,
        facilityType: facilityType.type,
        evidenceKind: exists ? "EXISTS" : "NOT_EXISTS",
        sourceId: SOURCE_ID,
        sourceSnapshotId: snapshotId,
        providerRecordHash,
        evidenceHash: accessibilitySnapshot.rowsSha256,
        provenanceKind: "OFFICIAL_SOURCE",
        installationStatus: exists ? "INSTALLED" : "NOT_INSTALLED",
        operationalStatus: "UNKNOWN",
        statusMeaning: "STATIC_LOCATION",
        confidence: 80,
        verifiedAt: accessibilitySnapshot.capturedAt,
        retrievedAt: accessibilitySnapshot.capturedAt,
        strictRouteEligible: false,
        strictRouteEligibleReason: exists ? "OPERATION_STATUS_UNKNOWN" : "FACILITY_NOT_INSTALLED",
      });
    }
  }
  const expectedFacilityCount = observedFacilityCount(observedRows);
  if (facilities.length !== expectedFacilityCount || evidence.length !== expectedFacilityCount
    || new Set(facilities.map(({ id }) => id)).size !== expectedFacilityCount
    || new Set(evidence.map(({ stationId, lineId, facilityType }) => `${stationId}:${lineId}:${facilityType}`)).size
      !== expectedFacilityCount) {
    throw new Error("Busan accessibility materialized facility counts are invalid");
  }

  pack.sourceInventory.push(packSource(source, accessibilitySnapshot));
  pack.facilities.push(...facilities);
  pack.stationFacilityEvidence = [...(pack.stationFacilityEvidence ?? []), ...evidence];
  pack.minimumTableRows = {
    ...pack.minimumTableRows,
    facilities: pack.facilities.length,
    station_facility_evidence: pack.stationFacilityEvidence.length,
  };
  const version = snapshotId.slice(-8);
  const composition = sha256(JSON.stringify({
    previousPackId: pack.id,
    snapshotId,
    rowsSha256: accessibilitySnapshot.rowsSha256,
    source,
    contentSha256: materializedBusanAccessibilityPackContentHash(pack, version),
  }));
  pack.id = `${PACK_ID}-${composition}`;
  pack.version = version;
  pack.url = `https://objectstorage.ap-seoul-1.oraclecloud.com/n/axvym6vk8g7i/b/easysubway-datapacks/o/catalog/${pack.id}-v${version}.sqlite.gz`;
  fixture.manifest.activePack = { id: pack.id, version };
  return fixture;
}

export function materializedBusanAccessibilityPackContentHash(pack, version) {
  const content = { ...pack };
  delete content.id;
  delete content.version;
  delete content.url;
  return sha256(JSON.stringify({ version, content }));
}

function observedSum(...values) {
  return values.some((value) => value === null) ? null : values.reduce((total, value) => total + value, 0);
}

// 등록 도구(register-regional-accessibility.mjs)의 facilityCount와 같은 규칙: count가 관측된 시설 종류 셀 수.
function observedFacilityCount(rows) {
  return rows.reduce((total, row) => total + FACILITY_TYPES
    .filter((facilityType) => facilityType.countOf(row) !== null).length, 0);
}

function validateSnapshot(snapshot) {
  if (snapshot?.schemaVersion !== 1 || snapshot.artifactKind !== "busan-accessibility-snapshot"
    || snapshot.sourceId !== SOURCE_ID || snapshot.official !== true || snapshot.fixture !== false
    || snapshot.credentialRedacted !== true || snapshot.requestCount !== EXPECTED_STATION_COUNT
    || snapshot.stationCount !== EXPECTED_STATION_COUNT || snapshot.rowCount !== EXPECTED_STATION_COUNT
    || snapshot.rows?.length !== EXPECTED_STATION_COUNT
    || snapshot.rowsSha256 !== sha256(JSON.stringify(snapshot.rows))
    || !/^[a-f0-9]{64}$/.test(snapshot.rawSha256 ?? "")
    || JSON.stringify(snapshot.lineIds) !== JSON.stringify(LINE_IDS)
    || JSON.stringify(snapshot.fieldsProvided) !== JSON.stringify([
      "elevator", "escalator", "wheelchair_lift", "status", "verified_at",
    ])) {
    throw new Error("invalid Busan accessibility snapshot");
  }
  const codes = new Set();
  for (const row of snapshot.rows) {
    if (!LINE_IDS.includes(row.lineId) || !/^\d{2,3}$/.test(row.stationCode) || codes.has(row.stationCode)
      || [row.wl_i, row.wl_o, row.el_i, row.el_o, row.es]
        .some((value) => value !== null && (!Number.isInteger(value) || value < 0))) {
      throw new Error(`invalid Busan accessibility row: ${row?.stationCode}`);
    }
    codes.add(row.stationCode);
  }
  if (codes.size !== EXPECTED_STATION_COUNT) throw new Error("invalid Busan accessibility snapshot scope");
  return snapshot.rows;
}

function requiredSource(inventory, snapshot, topologySnapshot) {
  const source = inventory?.sources?.find(({ id }) => id === SOURCE_ID);
  const evidence = source?.accessibilityAdmissionEvidence;
  const topologyEvidence = inventory?.sources?.find(({ id }) => id === TOPOLOGY_SOURCE_ID)
    ?.topologyAdmissionEvidence;
  if (source?.productionUseAllowed !== true || source.license?.redistributionAllowed !== true
    || source.license?.type !== "KOGL-1"
    || source.capabilities?.facility?.productionUseAllowed !== true
    || source.capabilities?.facility?.status !== "SUPPORTED"
    || evidence?.issue !== 2374
    || evidence.materializer !== "tools/datapack/materialize-busan-accessibility.mjs"
    || evidence.verificationTest !== "tools/datapack/materialize-busan-accessibility.test.mjs"
    || !/^busan-transportation-accessibility-[a-f0-9]{64}-\d{8}$/.test(evidence.snapshotId ?? "")
    || evidence.snapshotPath !== `tools/datapack/sources/${evidence.snapshotId}.json`
    || evidence.capturedAt !== snapshot.capturedAt || evidence.freshUntil !== snapshot.freshUntil
    || evidence.stationCount !== EXPECTED_STATION_COUNT || evidence.rowCount !== EXPECTED_STATION_COUNT
    || evidence.facilityCount !== observedFacilityCount(snapshot.rows)
    || evidence.rawSha256 !== snapshot.rawSha256 || evidence.rowsSha256 !== snapshot.rowsSha256
    || evidence.topologySourceId !== TOPOLOGY_SOURCE_ID
    || JSON.stringify(source.coverageScope) !== JSON.stringify({
      regionIds: ["busan"],
      operatorIds: ["busan-transportation"],
      lineIds: LINE_IDS,
      sourceDomains: ["accessibility_facilities"],
    })
    || JSON.stringify(source.fieldsProvided) !== JSON.stringify(snapshot.fieldsProvided)) {
    throw new Error(`${SOURCE_ID} inventory evidence does not match snapshot`);
  }
  if (topologySnapshot?.sourceId !== TOPOLOGY_SOURCE_ID
    || evidence.topologySnapshotId !== topologyEvidence?.snapshotId
    || evidence.topologyContentSha256 !== topologyEvidence?.contentSha256
    || evidence.topologyContentSha256 !== topologySnapshot.contentSha256
    || topologySnapshot.contentSha256 !== busanRouteTopologyContentHash(
      topologySnapshot.edges,
      topologySnapshot.scope,
    )) {
    throw new Error("Busan accessibility topology lineage mismatch");
  }
  const expectedSnapshotId = `${SOURCE_ID}-${sha256(JSON.stringify(snapshot))}-${compactSeoulDate(evidence.capturedAt)}`;
  if (evidence.snapshotId !== expectedSnapshotId) {
    throw new Error(`${SOURCE_ID} snapshotId must bind exact snapshot bytes`);
  }
  const version = evidence.snapshotId.slice(-8);
  if (version !== compactSeoulDate(evidence.capturedAt)) {
    throw new Error(`${SOURCE_ID} snapshotId must match capturedAt Asia/Seoul date`);
  }
  const capturedAt = Date.parse(evidence.capturedAt);
  const freshUntil = Date.parse(evidence.freshUntil);
  if (!Number.isFinite(capturedAt) || freshUntil !== capturedAt + FRESHNESS_MILLIS) {
    throw new Error(`${SOURCE_ID} evidence freshness is invalid`);
  }
  return source;
}

function validateTopologyLineage(pack, evidence, topologySnapshot, stations) {
  const hasTopology = pack.sourceInventory.some(({ id }) => id === TOPOLOGY_SOURCE_ID);
  // 누적 topology는 canonical ID를 보존하므로 방향성 양 끝점으로 공식 edge를 결속한다.
  const edgeKey = ({ fromNodeId, toNodeId }) => `${fromNodeId}\0${toNodeId}`;
  const compareEdges = (left, right) => edgeKey(left).localeCompare(edgeKey(right), "en");
  const actual = pack.networkEdges.filter(({ sourceId }) => sourceId === TOPOLOGY_SOURCE_ID)
    .sort(compareEdges);
  const expected = topologySnapshot.edges.map((edge) => {
    const from = stations.get(`${edge.lineId}:${edge.fromStationCode}`);
    const to = stations.get(`${edge.lineId}:${edge.toStationCode}`);
    return {
      fromNodeId: `${from}:${edge.lineId}`,
      toNodeId: `${to}:${edge.lineId}`,
      durationSeconds: edge.durationSeconds + edge.stoppingSeconds,
      distanceMeters: edge.distanceMeters,
      sourceSnapshotId: evidence.topologySnapshotId,
      providerRecordHash: sha256(JSON.stringify(edge)),
      evidenceHash: evidence.topologyContentSha256,
    };
  }).sort(compareEdges);
  const comparable = actual.map((edge) => Object.fromEntries(
    Object.keys(expected[0]).map((key) => [key, edge[key]]),
  ));
  if (!hasTopology || actual.length !== expected.length
    || actual.some(({ id }) => typeof id !== "string" || id.length === 0)
    || new Set(actual.map(({ id }) => id)).size !== actual.length
    || new Set(actual.map(edgeKey)).size !== actual.length
    || JSON.stringify(comparable) !== JSON.stringify(expected)) {
    throw new Error("Busan accessibility topology lineage mismatch");
  }
}

function canonicalStations(pack, topologySnapshot) {
  const expected = new Map();
  for (const lineId of topologySnapshot.lineIds) {
    topologySnapshot.scope.filter((station) => station.lineId === lineId)
      .sort((left, right) => Number(left.stationCode) - Number(right.stationCode))
      .forEach((station, index) => expected.set(`${lineId}:${station.stationCode}`, {
        stationName: station.stationName,
        lineSequence: index + 1,
      }));
  }
  const stationNames = new Map(pack.stations.map(({ id, nameKo }) => [id, nameKo]));
  const stations = new Map();
  for (const stationLine of pack.stationLines) {
    const key = `${stationLine.lineId}:${stationLine.stationCode}`;
    const expectedStation = expected.get(key);
    if (!expectedStation) continue;
    if (stations.has(key)) throw new Error(`Busan accessibility duplicate canonical station: ${key}`);
    if (stationLine.sourceId !== TOPOLOGY_SOURCE_ID
      || stationLine.lineSequence !== expectedStation.lineSequence
      // Topology가 인정한 동일 역의 표기 차이는 표시 이름을 바꾸지 않고 비교한다.
      || normalizedStationName(stationNames.get(stationLine.stationId) ?? "")
        !== normalizedStationName(expectedStation.stationName)) {
      throw new Error(`Busan accessibility topology lineage mismatch: ${key}`);
    }
    stations.set(key, stationLine.stationId);
  }
  if (stations.size !== EXPECTED_STATION_COUNT) {
    throw new Error(`Busan accessibility canonical station scope mismatch: ${stations.size}`);
  }
  return stations;
}

function packSource(source, snapshot) {
  return {
    id: source.id,
    owner: source.owner,
    url: source.datasetUrl,
    license: source.license.name,
    licenseStatus: "redistributable",
    redistributionAllowed: true,
    updateFrequency: source.updateFrequency,
    updatedAt: snapshot.capturedAt,
    fields: [...source.fieldsProvided],
    coverageScope: structuredClone(source.coverageScope),
  };
}

function compactSeoulDate(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(value)).map(({ type, value: part }) => [type, part]));
  return `${parts.year}${parts.month}${parts.day}`;
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function parseArgs(argv) {
  const expected = [
    "--base-fixture",
    "--accessibility-snapshot",
    "--topology-snapshot",
    "--inventory",
    "--output",
  ];
  if (argv.length !== expected.length * 2 || expected.some((flag, index) => argv[index * 2] !== flag)
    || !path.isAbsolute(argv.at(-1))) {
    throw new Error("usage: materialize-busan-accessibility.mjs --base-fixture <json> --accessibility-snapshot <json> --topology-snapshot <json> --inventory <json> --output <absolute.json>");
  }
  return Object.fromEntries(expected.map((flag, index) => [flag.slice(2), argv[index * 2 + 1]]));
}

export async function runBusanAccessibilityMaterializer(argv) {
  const args = parseArgs(argv);
  const [baseFixture, accessibilitySnapshot, topologySnapshot, inventory] = await Promise.all([
    readFile(args["base-fixture"], "utf8").then(JSON.parse),
    readFile(args["accessibility-snapshot"], "utf8").then(JSON.parse),
    readFile(args["topology-snapshot"], "utf8").then(JSON.parse),
    readFile(args.inventory, "utf8").then(JSON.parse),
  ]);
  const fixture = materializeBusanAccessibility({
    baseFixture,
    accessibilitySnapshot,
    topologySnapshot,
    inventory,
  });
  fixture.fixtureClass = "TEST_ONLY";
  await writeFile(args.output, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`Busan accessibility materialized: stations=${EXPECTED_STATION_COUNT} facilities=${fixture.packs[0].facilities.filter(({ sourceId }) => sourceId === SOURCE_ID).length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runBusanAccessibilityMaterializer(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Busan accessibility materialization failed");
    process.exitCode = 1;
  }
}
