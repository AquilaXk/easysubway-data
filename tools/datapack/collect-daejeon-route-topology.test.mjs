import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  DAEJEON_LINE1_STATION_NUMBERS,
  collectDaejeonRouteTopology,
} from "./collect-daejeon-route-topology.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { SOURCE_REGISTRATION_OUTPUTS } from "./lib/source-registration-transaction.mjs";
import {
  prepareDaejeonTopologyRegistration,
  registerDaejeonTopology,
} from "./register-daejeon-route-topology.mjs";
import { createCurrentMolitObservationFixture } from "./test-fixtures/current-molit-observation.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const DAY_MS = 24 * 60 * 60 * 1_000;
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const DAEJEON_MAP_XLSX_PATH = path.join(
  repositoryRoot,
  "tools/datapack/fixtures/daejeon-route-map-positions-raw/kric-metropolitan-rail-station-info-20260630.xlsx",
);
const DAEJEON_MAP_CSV_PATH = path.join(
  repositoryRoot,
  "tools/datapack/fixtures/daejeon-route-map-positions-raw/kric-daejeon-stations-20260630.csv",
);
const DAEJEON_MAP_CANVAS_PATH = path.join(
  repositoryRoot,
  "tools/datapack/fixtures/daejeon-route-map-positions-raw/owner-self-drawn-sma-schematic-canvas-20260725.json",
);
const DAEJEON_ELEVATOR_PATH = path.join(
  repositoryRoot,
  "tools/datapack/fixtures/daejeon-accessibility-raw/data-go-15041384.csv",
);
const DAEJEON_ESCALATOR_PATH = path.join(
  repositoryRoot,
  "tools/datapack/fixtures/daejeon-accessibility-raw/data-go-15041361.csv",
);
const DAEJEON_MAP_SNAPSHOT_PATH = path.join(
  repositoryRoot,
  "tools/datapack/sources/daejeon-transportation-route-map-positions-20260725.json",
);
const DAEJEON_ACCESSIBILITY_SNAPSHOT_PATH = path.join(
  repositoryRoot,
  "tools/datapack/sources/daejeon-transportation-accessibility-20260724.json",
);
const DAEJEON_TIMETABLE_SNAPSHOT_PATH = path.join(
  repositoryRoot,
  "tools/datapack/sources/daejeon-train-timetable-20260720.json",
);

test("대전 topology collector는 malformed credential로 provider를 호출하지 않는다", async () => {
  let calls = 0;
  await assert.rejects(collectDaejeonRouteTopology({ serviceKey: "invalid%ZZ", fetchImpl: async () => { calls += 1; } }), /DATA_GO_KR_SERVICE_KEY is invalid/);
  assert.equal(calls, 0);
});

test("대전 topology collector는 encoded percent credential을 provider에 한 번만 decode해 전달한다", async () => {
  const observedKeys = [];
  await collectDaejeonRouteTopology({
    serviceKey: "a%25b",
    fetchImpl: async (url) => {
      observedKeys.push(new URL(url).searchParams.get("serviceKey"));
      return new Response(
        "<response><header><resultCode>00</resultCode></header><body><items><item>"
          + "<distfloat>1.2</distfloat><fee>1400</fee><min>2</min><sec>30</sec>"
          + "</item></items></body></response>",
        { status: 200, headers: { "content-type": "application/xml" } },
      );
    },
  });

  assert.equal(observedKeys.length, 42);
  assert.ok(observedKeys.every((key) => key === "a%b"));
});

test("대전 topology collector는 22개 역 인접 21구간을 양방향으로 검증한다", async () => {
  const secret = "do-not-store-daejeon-key";
  const requests = [];
  const responseBytes = Buffer.from(
    "<response><header><resultCode>00</resultCode></header><body><items><item>"
      + "<distfloat>1.2</distfloat><fee>1400</fee><min>2</min><sec>30</sec>"
      + "</item></items></body></response>",
  );
  const artifact = await collectDaejeonRouteTopology({
    serviceKey: secret,
    now: new Date("2026-07-20T00:00:00.000Z"),
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      requests.push({
        from: parsed.searchParams.get("strstnno"),
        to: parsed.searchParams.get("endstnno"),
        key: parsed.searchParams.get("serviceKey"),
      });
      return new Response(responseBytes, { status: 200, headers: { "content-type": "application/xml" } });
    },
  });

  assert.deepEqual(DAEJEON_LINE1_STATION_NUMBERS,
    Array.from({ length: 22 }, (_, index) => String(101 + index)));
  assert.equal(requests.length, 42);
  assert.ok(requests.every(({ key }) => key === secret));
  assert.equal(artifact.rowCount, 42);
  assert.equal(artifact.rows.length, 42);
  assert.deepEqual(artifact.rawResponses, requests.map(({ from, to }) => ({
    fromStationNumber: from,
    toStationNumber: to,
    bytesBase64: responseBytes.toString("base64"),
  })));
  assert.ok(artifact.rows.every(({ responseSha256 }) => responseSha256
    === createHash("sha256").update(responseBytes).digest("hex")));
  assert.deepEqual(artifact.rows[0], {
    fromStationNumber: "101",
    toStationNumber: "102",
    distanceKilometers: 1.2,
    fareWon: 1400,
    travelTimeSeconds: 150,
    responseSha256: artifact.rows[0].responseSha256,
  });
  assert.deepEqual(artifact.rows[1], {
    fromStationNumber: "102",
    toStationNumber: "101",
    distanceKilometers: 1.2,
    fareWon: 1400,
    travelTimeSeconds: 150,
    responseSha256: artifact.rows[1].responseSha256,
  });
  assert.equal(artifact.rowsSha256,
    createHash("sha256").update(JSON.stringify(artifact.rows)).digest("hex"));
  assert.equal(artifact.contentSha256, artifact.rowsSha256);
  assert.equal(artifact.rawSha256, createHash("sha256")
    .update(JSON.stringify(artifact.rows.map(({ responseSha256 }) => responseSha256))).digest("hex"));
  assert.equal(artifact.excludedTransferCount, 0);
  assert.equal(artifact.credentialRedacted, true);
  assert.doesNotMatch(JSON.stringify(artifact), new RegExp(secret));
});

test("대전 topology collector는 인접 OD가 단일 row가 아니면 fail closed한다", async () => {
  await assert.rejects(collectDaejeonRouteTopology({
    serviceKey: "key",
    fetchImpl: async () => new Response(
      "<response><header><resultCode>00</resultCode></header><body><items>"
        + "<item><distfloat>1</distfloat><fee>1400</fee><min>2</min><sec>0</sec></item>"
        + "<item><distfloat>2</distfloat><fee>1400</fee><min>4</min><sec>0</sec></item>"
        + "</items></body></response>",
      { status: 200, headers: { "content-type": "application/xml" } },
    ),
  }), /must return exactly one row/);
});

test("Daejeon topology registration replays retained sources and refreshes current MOLIT membership", async () => {
  const authority = await createCurrentMolitObservationFixture(await fullMolitProjection());
  const now = new Date(Date.parse(authority.observation.capturedAt) + 86_400_000);
  const responseBytes = Buffer.from(
    "<response><header><resultCode>00</resultCode></header><body><items><item>"
      + "<distfloat>1.2</distfloat><fee>1400</fee><min>2</min><sec>30</sec>"
      + "</item></items></body></response>",
  );
  const snapshot = await collectDaejeonRouteTopology({
    serviceKey: "test-key",
    now: new Date(now.valueOf() - 60_000),
    fetchImpl: async () => new Response(responseBytes, { headers: { "content-type": "application/xml" } }),
  });
  const snapshotPath = path.join(authority.root, "retained-daejeon-topology.json");
  const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot)}\n`);
  await writeFile(snapshotPath, snapshotBytes);

  const sourceId = "daejeon-station-distance-fare";
  const membershipSourceId = "molit-urban-rail-full-route-daejeon-membership";
  const source = {
    id: sourceId,
    provider: "Test Daejeon operator",
    datasetUrl: "https://example.test/daejeon",
    productionUseAllowed: true,
    requiredForProductionPack: false,
    license: { redistributionAllowed: true, evidenceUrl: "https://example.test/license" },
    topologyAdmissionEvidence: { issue: 1, materializer: "topology", verificationTest: "topology-test" },
    membershipAdmissionEvidence: { issue: 2, materializer: "membership", verificationTest: "membership-test" },
  };
  const membershipSource = {
    id: membershipSourceId,
    productionUseAllowed: true,
    requiredForProductionPack: false,
    license: { redistributionAllowed: true, evidenceUrl: "https://example.test/molit-license" },
    membershipAdmissionEvidence: structuredClone(source.membershipAdmissionEvidence),
  };
  const dependentFixtures = await retainedDependentFixtures(authority.root);
  const mapSource = {
    id: "daejeon-transportation-route-map-positions",
    routeMapAdmissionEvidence: structuredClone(dependentFixtures.mapSnapshot),
  };
  const accessibilitySource = {
    id: "daejeon-transportation-accessibility",
    accessibilityAdmissionEvidence: structuredClone(dependentFixtures.accessibilitySnapshot),
  };
  const timetableSource = {
    id: "daejeon-train-timetable",
    scheduleAdmissionEvidence: structuredClone(dependentFixtures.timetableSnapshot),
  };
  const governanceEntry = governanceFor(source, now);
  const inventory = {
    sources: [
      authority.inventory.sources[0], source, membershipSource, mapSource, accessibilitySource, timetableSource,
    ],
  };
  const ledger = [authority.current];
  const governance = governancePolicy(governanceEntry);
  const freshness = { sourceClasses: [{
    id: "route_graph_topology",
    sourceIds: [sourceId],
    basisField: "retrievedAt",
    reverificationCadence: "P1D",
  }] };
  const candidate = { candidates: [{ id: sourceId, domain: "route_graph_topology", registrationMetadata: {
    governance: governanceEntry,
    dependentInputs: dependentFixtures.paths,
  } }] };
  for (const [index, relative] of SOURCE_REGISTRATION_OUTPUTS.entries()) {
    await mkdir(path.dirname(path.join(authority.root, relative)), { recursive: true });
    await writeFile(path.join(authority.root, relative), `${JSON.stringify([inventory, ledger, governance, freshness][index], null, 2)}\n`);
  }
  await writeFile(path.join(authority.root, "tools/datapack/source-candidates.json"), `${JSON.stringify(candidate)}\n`);

  const env = {
    EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL:
      "https://objectstorage.ap-seoul-1.oraclecloud.com/p/test/n/axvym6vk8g7i/b/easysubway-datapacks/o/",
  };
  const receiptPath = path.join(authority.root, "daejeon-receipt.json");
  const options = { repositoryRoot: authority.root, snapshotPath, receiptPath, now, env };
  const prepared = await prepareDaejeonTopologyRegistration(options);
  await writeFile(receiptPath, `${JSON.stringify(receiptFor(prepared, now))}\n`);
  await registerDaejeonTopology(options);

  const [registeredInventory, registeredLedger] = await Promise.all(SOURCE_REGISTRATION_OUTPUTS.slice(0, 2)
    .map(async (relative) => JSON.parse(await readFile(path.join(authority.root, relative), "utf8"))));
  const registeredTopology = registeredInventory.sources.find(({ id }) => id === sourceId);
  const registeredMembership = registeredInventory.sources.find(({ id }) => id === membershipSourceId);
  assert.equal(registeredTopology.requiredForProductionPack, true);
  assert.equal(registeredTopology.topologyAdmissionEvidence.snapshotId, prepared.snapshotId);
  assert.equal(registeredTopology.topologyAdmissionEvidence.rawSha256, snapshot.rawSha256);
  assert.deepEqual(registeredTopology.membershipAdmissionEvidence, registeredMembership.membershipAdmissionEvidence);
  assert.equal(registeredTopology.membershipAdmissionEvidence.verifiedAt, authority.current.retrievedAt);
  assert.equal(registeredTopology.membershipAdmissionEvidence.membershipSourceRawSha256, authority.current.rawSha256);
  assert.equal(registeredTopology.membershipAdmissionEvidence.stationCodeSnapshotId, prepared.snapshotId);
  const registeredMap = registeredInventory.sources.find(({ id }) => id === mapSource.id);
  const registeredAccessibility = registeredInventory.sources.find(({ id }) => id === accessibilitySource.id);
  const registeredTimetable = registeredInventory.sources.find(({ id }) => id === timetableSource.id);
  assert.equal(registeredMap.routeMapAdmissionEvidence.topologySnapshotId, prepared.snapshotId);
  assert.equal(registeredMap.routeMapAdmissionEvidence.rawSha256, dependentFixtures.mapSnapshot.rawSha256);
  assert.equal(registeredMap.routeMapAdmissionEvidence.capturedAt, dependentFixtures.mapSnapshot.capturedAt);
  assert.equal(registeredMap.routeMapAdmissionEvidence.freshUntil, dependentFixtures.mapSnapshot.freshUntil);
  assert.match(registeredMap.routeMapAdmissionEvidence.snapshotId, /^daejeon-transportation-route-map-positions-/);
  assert.deepEqual(
    await readFile(path.join(authority.root, registeredMap.routeMapAdmissionEvidence.snapshotPath)),
    prepared.dependentSnapshots.find(({ sourceId: id }) => id === mapSource.id).bytes,
  );
  assert.equal(registeredAccessibility.accessibilityAdmissionEvidence.topologySnapshotId, prepared.snapshotId);
  assert.equal(registeredAccessibility.accessibilityAdmissionEvidence.rawSha256, dependentFixtures.accessibilitySnapshot.rawSha256);
  assert.equal(registeredAccessibility.accessibilityAdmissionEvidence.capturedAt, dependentFixtures.accessibilitySnapshot.capturedAt);
  assert.equal(registeredAccessibility.accessibilityAdmissionEvidence.freshUntil, dependentFixtures.accessibilitySnapshot.freshUntil);
  assert.match(registeredAccessibility.accessibilityAdmissionEvidence.snapshotId, /^daejeon-transportation-accessibility-/);
  assert.deepEqual(
    await readFile(path.join(authority.root, registeredAccessibility.accessibilityAdmissionEvidence.snapshotPath)),
    prepared.dependentSnapshots.find(({ sourceId: id }) => id === accessibilitySource.id).bytes,
  );
  assert.equal(registeredTimetable.scheduleAdmissionEvidence.snapshotId, dependentFixtures.timetableSnapshot.snapshotId);
  assert.equal(registeredTimetable.scheduleAdmissionEvidence.capturedAt, dependentFixtures.timetableSnapshot.capturedAt);
  assert.equal(registeredTimetable.scheduleAdmissionEvidence.freshUntil, dependentFixtures.timetableSnapshot.freshUntil);
  assert.equal(registeredTimetable.scheduleAdmissionEvidence.rawSha256, dependentFixtures.timetableSnapshot.rawSha256);
  assert.equal(registeredTimetable.scheduleAdmissionEvidence.rowsSha256, dependentFixtures.timetableSnapshot.rowsSha256);
  assert.equal(registeredTimetable.scheduleAdmissionEvidence.topologySnapshotId, prepared.snapshotId);
  assert.equal(registeredLedger.at(-1).snapshotId, prepared.snapshotId);
  assert.equal(registeredLedger.at(-1).coverageCount, snapshot.stationNumbers.length);
  assert.deepEqual(await readFile(path.join(authority.root, prepared.snapshotRelative)), snapshotBytes);
});

function governanceFor(source, now) {
  const termsHash = sha(canonicalJson(source.license));
  source.admissionEvidence = { licenseEvidenceHash: termsHash };
  return {
    sourceId: source.id,
    sourceClassId: "route_graph_topology",
    retentionClassId: "standard-90d",
    ownerRole: "data-owner",
    stewardRole: "data-steward",
    approvalRole: "data-owner",
    escalationHours: 24,
    alertRoute: "data-owner",
    licenseReview: {
      status: "APPROVED",
      termsHash,
      termsUrl: source.license.evidenceUrl,
      reviewedProvider: source.provider,
      reviewedDatasetUrl: source.datasetUrl,
      reviewedAt: new Date(now.valueOf() - 86_400_000).toISOString(),
      nextReviewAt: new Date(now.valueOf() + 86_400_000).toISOString(),
      redistributionScopes: ["DERIVED_DATAPACK"],
      approvedByRole: "data-owner",
    },
  };
}

async function retainedDependentFixtures(root) {
  const [mapXlsxBytes, canvasBytes, elevatorBytes, escalatorBytes, mapBytes, accessibilityBytes, timetableBytes] = await Promise.all([
    readFile(DAEJEON_MAP_XLSX_PATH),
    readFile(DAEJEON_MAP_CANVAS_PATH),
    readFile(DAEJEON_ELEVATOR_PATH),
    readFile(DAEJEON_ESCALATOR_PATH),
    readFile(DAEJEON_MAP_SNAPSHOT_PATH),
    readFile(DAEJEON_ACCESSIBILITY_SNAPSHOT_PATH),
    readFile(DAEJEON_TIMETABLE_SNAPSHOT_PATH),
  ]);
  const paths = {
    mapXlsxPath: "retained/map.xlsx",
    schematicCanvasPath: "retained/canvas.json",
    elevatorPath: "retained/elevator.csv",
    escalatorPath: "retained/escalator.csv",
  };
  await Promise.all(Object.entries({
    [paths.mapXlsxPath]: mapXlsxBytes,
    [paths.schematicCanvasPath]: canvasBytes,
    [paths.elevatorPath]: elevatorBytes,
    [paths.escalatorPath]: escalatorBytes,
    "tools/datapack/sources/daejeon-train-timetable-20260720.json": timetableBytes,
  }).map(async ([relative, bytes]) => {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }));
  const mapSnapshot = JSON.parse(mapBytes);
  const accessibilitySnapshot = JSON.parse(accessibilityBytes);
  const timetableSnapshot = JSON.parse(timetableBytes);
  return {
    paths,
    mapSnapshot: {
      snapshotId: path.basename(DAEJEON_MAP_SNAPSHOT_PATH, ".json"),
      snapshotPath: path.relative(repositoryRoot, DAEJEON_MAP_SNAPSHOT_PATH),
      snapshotSha256: sha(mapBytes),
      capturedAt: mapSnapshot.capturedAt,
      freshUntil: new Date(Date.parse(mapSnapshot.capturedAt) + 365 * DAY_MS).toISOString(),
      stationCount: mapSnapshot.stationCount,
      rawStationCount: mapSnapshot.rawStationCount,
      quarantinedCount: mapSnapshot.quarantinedCount,
      datasetId: mapSnapshot.datasetId,
      datasetIds: mapSnapshot.datasetIds,
      rawSha256: mapSnapshot.rawSha256,
      positionsSha256: mapSnapshot.positionsSha256,
      lineIds: mapSnapshot.lineIds,
      lineStationCounts: mapSnapshot.lineStationCounts,
      observedDataUpdatedAt: mapSnapshot.observedDataUpdatedAt,
      topologySourceId: "daejeon-station-distance-fare",
      topologySnapshotId: "retained-topology",
      topologyContentSha256: "retained-content",
      topologyLineages: [],
    },
    accessibilitySnapshot: {
      snapshotId: path.basename(DAEJEON_ACCESSIBILITY_SNAPSHOT_PATH, ".json"),
      snapshotPath: path.relative(repositoryRoot, DAEJEON_ACCESSIBILITY_SNAPSHOT_PATH),
      capturedAt: accessibilitySnapshot.capturedAt,
      freshUntil: accessibilitySnapshot.freshUntil,
      stationCount: accessibilitySnapshot.stationCount,
      rowCount: accessibilitySnapshot.rowCount,
      facilityCount: accessibilitySnapshot.rows.reduce((count, row) => count
        + Number(row.elevator !== null)
        + Number(row.escalator !== null)
        + Number(row.wheelchair_lift !== null), 0),
      rawSha256: accessibilitySnapshot.rawSha256,
      rowsSha256: accessibilitySnapshot.rowsSha256,
      datasetIds: accessibilitySnapshot.datasetIds,
      topologySourceId: "daejeon-station-distance-fare",
      topologySnapshotId: "retained-topology",
      topologyContentSha256: "retained-content",
      topologyLineages: [],
    },
    timetableSnapshot: {
      snapshotId: path.basename(DAEJEON_TIMETABLE_SNAPSHOT_PATH, ".json"),
      snapshotPath: path.relative(repositoryRoot, DAEJEON_TIMETABLE_SNAPSHOT_PATH),
      capturedAt: timetableSnapshot.observedAt,
      freshUntil: new Date(Date.parse(timetableSnapshot.observedAt) + DAY_MS).toISOString(),
      rowCount: timetableSnapshot.rowCount,
      rawSha256: timetableSnapshot.rawSha256,
      rowsSha256: timetableSnapshot.rowsSha256,
      topologySourceId: "daejeon-station-distance-fare",
      topologySnapshotId: "retained-topology",
      topologyContentSha256: "retained-content",
    },
  };
}

function governancePolicy(entry) {
  return {
    schemaVersion: 1,
    artifactKind: "datapack-source-governance-policy",
    policyVersion: "2026-09-09",
    sources: [entry],
    retentionClasses: [{ id: "standard-90d", retentionDays: 90 }],
    reasonCodeEscalations: [{
      responsibleRole: "data-owner",
      alertRoute: "data-owner",
      escalationHours: 24,
      reasonCodes: [
        "SOURCE_LINEAGE_BROKEN", "SOURCE_DIFF_MISSING", "SOURCE_FRESHNESS_POLICY_MISSING",
        "SOURCE_SNAPSHOT_EXPIRED", "RAW_RETENTION_OVERDUE", "LEGAL_HOLD_INVALID",
        "LICENSE_REVIEW_REQUIRED", "REDISTRIBUTION_NOT_APPROVED", "SOURCE_GOVERNANCE_OWNER_MISSING",
      ],
    }],
  };
}

function receiptFor(prepared, now) {
  const date = prepared.snapshot.observedAt.slice(0, 10).replaceAll("-", "");
  const objectKey = `source-raw/daejeon-station-distance-fare/${date}/${prepared.snapshotSha256}.json`;
  return {
    schemaVersion: 1,
    artifactKind: "static-network-source-raw-object-receipt",
    sourceId: "daejeon-station-distance-fare",
    snapshotId: prepared.snapshotId,
    capturedAt: prepared.snapshot.observedAt,
    rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/${objectKey}`,
    rawObjectSha256: prepared.snapshotSha256,
    byteSize: prepared.snapshotBytes.length,
    storedAt: now.toISOString(),
    rawRetentionExpiresAt: prepared.rawRetentionExpiresAt,
    ociNamespace: "axvym6vk8g7i",
    bucket: "easysubway-datapacks",
    objectKey,
    contentType: "application/json",
  };
}

async function fullMolitProjection() {
  const stationNames = (await readFile(DAEJEON_MAP_CSV_PATH, "utf8"))
    .trim()
    .split("\n")
    .slice(1)
    .map((row) => row.split(",")[1]);
  if (stationNames.length !== 22) throw new Error("Daejeon retained mapping fixture is incomplete");
  const operatorCounts = {
    "공항철도주식회사": 14, "광주교통공사": 20, "구리도시공사": 3, "김포골드라인운영주식회사": 10,
    "남서울경전철주식회사": 11, "남양주도시공사": 5, "네오트랜스주식회사": 16, "대구교통공사": 94,
    "대전교통공사": 22, "부산교통공사": 114, "부산김해경전철주식회사": 21, "서울교통공사": 277,
    "서울시메트로9호선주식회사": 38, "서해철도주식회사": 12, "용인경량전철주식회사": 15,
    "우이신설경전철주식회사": 13, "의정부경량전철주식회사": 15, "인천교통공사": 68,
    "인천국제공항공사": 6, "주식회사 SR": 1, "지티엑스에이운영": 8, "코레일": 320,
  };
  const rows = [];
  for (let sequence = 1; sequence <= 22; sequence += 1) {
    rows.push({
      region_code: "05",
      region_name: "대전",
      operator_name: "대전교통공사",
      line_name: "1호선",
      station_sequence: sequence,
      station_name: stationNames[sequence - 1],
    });
  }
  for (const [operator, count] of Object.entries(operatorCounts)) {
    if (operator === "대전교통공사") continue;
    for (let sequence = 1; sequence <= count; sequence += 1) {
      rows.push({
        region_code: "01",
        region_name: "수도권",
        operator_name: operator,
        line_name: "검증선",
        station_sequence: sequence,
        station_name: `${operator}-${sequence}`,
      });
    }
  }
  const regionalCounts = new Map([["01", 802], ["02", 158], ["03", 101], ["04", 20], ["05", 22]]);
  for (const row of rows.filter(({ region_code: regionCode }) => regionCode === "01")) {
    const next = [...regionalCounts.entries()].find(([, count]) => count > 0);
    row.region_code = next[0];
    row.region_name = next[0] === "04" ? "광주" : next[0] === "02" ? "부산" : next[0] === "03" ? "대구" : "수도권";
    regionalCounts.set(next[0], next[1] - 1);
  }
  return rows;
}
