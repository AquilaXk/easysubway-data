import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectGwangjuAccessibility } from "./collect-gwangju-accessibility.mjs";
import { collectGwangjuRouteMapPositions } from "./collect-gwangju-route-map-positions.mjs";
import { collectGwangjuRouteTopology } from "./collect-gwangju-route-topology.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { SOURCE_REGISTRATION_OUTPUTS } from "./lib/source-registration-transaction.mjs";
import { prepareGwangjuTopologyRegistration, publishAndRegisterGwangjuTopology, registerGwangjuTopology } from "./register-gwangju-route-topology.mjs";

test("register retained Gwangju response bytes through the existing source transaction", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gwangju-register-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceId = "gwangju-transportation-route-topology";
  const now = new Date("2025-01-02T00:00:00.000Z");
  const license = { redistributionAllowed: true, evidenceUrl: "https://example.org/license" };
  const termsHash = createHash("sha256").update(canonicalJson(license)).digest("hex");
  const source = { id: sourceId, provider: "GRTC", datasetUrl: "https://example.org/dataset",
    coverageScope: { lineIds: ["line-e57a361e8892"] },
    productionUseAllowed: true, requiredForProductionPack: false, license,
    topologyAdmissionEvidence: { snapshotId: "previous", snapshotPath: "previous.json" } };
  const entry = { sourceId, sourceClassId: "route_graph_topology", retentionClassId: "standard-90d",
    ownerRole: "data-owner", stewardRole: "data-steward", approvalRole: "data-owner", escalationHours: 24, alertRoute: "data-owner",
    licenseReview: { status: "APPROVED", termsHash, termsUrl: license.evidenceUrl, reviewedProvider: source.provider,
      reviewedDatasetUrl: source.datasetUrl, reviewedAt: "2025-01-01T00:00:00.000Z", nextReviewAt: "2025-02-01T00:00:00.000Z",
      redistributionScopes: ["DERIVED_DATAPACK"], approvedByRole: "data-owner" } };
  const governance = { schemaVersion: 1, artifactKind: "datapack-source-governance-policy", policyVersion: "2025-01-01",
    sources: [entry], retentionClasses: [{ id: "standard-90d", retentionDays: 90 }],
    reasonCodeEscalations: [{ responsibleRole: "data-owner", alertRoute: "data-owner", escalationHours: 24,
      reasonCodes: ["SOURCE_LINEAGE_BROKEN", "SOURCE_DIFF_MISSING", "SOURCE_FRESHNESS_POLICY_MISSING", "SOURCE_SNAPSHOT_EXPIRED",
        "RAW_RETENTION_OVERDUE", "LEGAL_HOLD_INVALID", "LICENSE_REVIEW_REQUIRED", "REDISTRIBUTION_NOT_APPROVED", "SOURCE_GOVERNANCE_OWNER_MISSING"] }] };
  const freshness = { sourceClasses: [{ id: "route_graph_topology", sourceIds: [sourceId], basisField: "retrievedAt", reverificationCadence: "P1D" }] };
  const scope = [{ providerStationId: "1", stationCode: "100", stationName: "가" }, { providerStationId: "3", stationCode: "105", stationName: "나" }];
  const snapshot = await collectGwangjuRouteTopology({ stationScope: scope, now,
    fetchImpl: async (url) => {
      const start = scope.find((row) => row.providerStationId === new URL(url).searchParams.get("station_id"));
      const end = scope.find((row) => row !== start);
      return Response.json([{ start_station_id: start.providerStationId, start_station_name: start.stationName,
        end_station_id: end.providerStationId, end_station_name: end.stationName, station_distance: 1, station_time: 2 }]);
    },
  });
  const mapCsvBytes = Buffer.from([
    "역번호,역사명,노선번호,노선명,역위도,역경도,데이터기준일자",
    "100,가,S2901,1호선,35.1,126.8,2022-12-02",
    "105,나,S2901,1호선,35.11,126.81,2022-12-02",
  ].join("\n"));
  const elevatorBytes = Buffer.from([
    "철도운영기관명,선명,역명,출입구번호,상세위치,정원_인원,정원_중량",
    "광주교통공사,1호선,가,1,,,",
  ].join("\n"));
  const escalatorBytes = Buffer.from([
    "철도운영기관명,선명,역명,상하행구분,출입구번호,상세위치,시작층,종료층",
    "광주교통공사,1호선,나,상,1,,,",
  ].join("\n"));
  const schematicCanvas = ["가", "나"].map((stationName, index) => ({
    canvasSourceId: "owner-self-drawn-sma-schematic", stationName, x: 300 + index * 100, y: 400,
    labelDx: 0, labelDy: 0,
    labelPolygon: [{ x: 300, y: 400 }, { x: 301, y: 400 }, { x: 301, y: 401 }, { x: 300, y: 401 }],
  }));
  const topologySource = { ...source, topologyAdmissionEvidence: {
    snapshotId: "fixture-topology", snapshotPath: "tools/datapack/sources/fixture-topology.json",
    capturedAt: snapshot.capturedAt, freshUntil: snapshot.freshUntil, stationCount: snapshot.stationCount,
    edgeCount: snapshot.edgeCount, rawSha256: snapshot.rawSha256, contentSha256: snapshot.contentSha256,
  } };
  const mapSnapshot = collectGwangjuRouteMapPositions({ csvBytes: mapCsvBytes, topologySnapshot: snapshot,
    topologySnapshotId: topologySource.topologyAdmissionEvidence.snapshotId, schematicCanvas, now });
  const accessibilitySnapshot = collectGwangjuAccessibility({ elevatorBytes, escalatorBytes,
    topologySnapshot: snapshot, topologySource, now });
  const projection = scope.map((station, index) => ({ region_code: "04", region_name: "광주",
    operator_name: "광주교통공사", line_name: "1호선", station_sequence: index + 1,
    station_name: station.stationName }));
  const molitRawSha256 = createHash("sha256").update("fixture MOLIT raw").digest("hex");
  const molitContentSha256 = createHash("sha256").update(`${JSON.stringify(projection)}\n`).digest("hex");
  const molitSnapshotId = "molit-fixture";
  const providerRecordHashes = projection.map((row) => createHash("sha256").update(JSON.stringify(row)).digest("hex"));
  const observation = { sourceId: "molit-urban-rail-full-route", snapshotId: molitSnapshotId,
    capturedAt: now.toISOString(), rawSha256: molitRawSha256, contentSha256: molitContentSha256,
    schemaFingerprint: "1".repeat(64), rowCount: projection.length, normalizedProjection: projection,
    providerRecordHashes };
  const observationBytes = Buffer.from(JSON.stringify(observation));
  const currentMolit = { sourceId: observation.sourceId, snapshotId: molitSnapshotId, previousSnapshotId: null,
    retrievedAt: now.toISOString(), sourceUpdatedAt: null, rawSha256: molitRawSha256,
    contentSha256: molitContentSha256, normalizedObservationSha256: createHash("sha256").update(observationBytes).digest("hex"),
    schemaFingerprint: observation.schemaFingerprint, redactedRequestFingerprint: "2".repeat(64),
    rowCount: projection.length, coverageCount: projection.length, providerRecordHashes, diffSummary: null,
    snapshotStatus: "LOCKED", fetchStatus: "SUCCESS", schemaStatus: "PASS", licenseStatus: "PASS",
    redistributionAllowed: true, credentialRedacted: true };
  const membershipEvidence = { lineIds: ["line-e57a361e8892"], membershipSourceId: observation.sourceId,
    membershipSourceRawSha256: "0".repeat(64), membershipSourceSnapshotSha256: "0".repeat(64),
    stationCount: 0, mappingSha256: "0".repeat(64), stationCodesSha256: "0".repeat(64),
    stationCodeSourceId: sourceId, stationCodeSnapshotId: "previous", stationCodeContentSha256: "0".repeat(64),
    verifiedAt: "2025-01-01T00:00:00.000Z" };
  const initial = [{ sources: [topologySource,
    { id: "gwangju-transportation-route-map-positions", requiredForProductionPack: false,
      routeMapAdmissionEvidence: { snapshotId: "prior-map", snapshotPath: "tools/datapack/sources/prior-map.json",
        capturedAt: mapSnapshot.capturedAt, freshUntil: "2025-02-01T00:00:00.000Z", rawSha256: mapSnapshot.rawSha256 } },
    { id: "gwangju-transportation-accessibility", requiredForProductionPack: false,
      accessibilityAdmissionEvidence: { snapshotId: "prior-accessibility", snapshotPath: "tools/datapack/sources/prior-accessibility.json",
        capturedAt: accessibilitySnapshot.capturedAt, freshUntil: accessibilitySnapshot.freshUntil,
        rawSha256: accessibilitySnapshot.rawSha256 } },
    { id: observation.sourceId, requiredForProductionPack: false, admissionEvidence: {
      sourceId: observation.sourceId, decision: "APPROVED", snapshotId: molitSnapshotId, rawSha256: molitRawSha256 } },
    { id: "molit-urban-rail-full-route-gwangju-membership", requiredForProductionPack: false,
      membershipAdmissionEvidence: structuredClone(membershipEvidence) },
    { id: "kric-nationwide-timetable-file", requiredForProductionPack: false,
      retainedScheduleAdmissionEvidence: { snapshotId: "retained", rawSha256: "3".repeat(64),
        topologySourceId: sourceId, topologySnapshotId: "previous", topologyContentSha256: "0".repeat(64) } },
  ].map((row) => row.id === sourceId ? { ...row, membershipAdmissionEvidence: structuredClone(membershipEvidence) } : row) },
    [currentMolit], governance, freshness];
  for (const [index, relative] of SOURCE_REGISTRATION_OUTPUTS.entries()) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), `${JSON.stringify(initial[index], null, 2)}\n`);
  }
  await mkdir(path.join(root, "tools/datapack/sources"), { recursive: true });
  await writeFile(path.join(root, `tools/datapack/sources/${molitSnapshotId}.json`), observationBytes);
  const dependentFiles = {
    mapCsvPath: "tools/datapack/fixtures/map.csv",
    schematicCanvasPath: "tools/datapack/fixtures/canvas.json",
    elevatorPath: "tools/datapack/fixtures/elevator.csv",
    escalatorPath: "tools/datapack/fixtures/escalator.csv",
  };
  await mkdir(path.join(root, "tools/datapack/fixtures"), { recursive: true });
  await Promise.all([
    writeFile(path.join(root, dependentFiles.mapCsvPath), mapCsvBytes),
    writeFile(path.join(root, dependentFiles.schematicCanvasPath), JSON.stringify(schematicCanvas)),
    writeFile(path.join(root, dependentFiles.elevatorPath), elevatorBytes),
    writeFile(path.join(root, dependentFiles.escalatorPath), escalatorBytes),
  ]);
  await writeFile(path.join(root, "tools/datapack/source-candidates.json"), JSON.stringify({ candidates: [{
    id: sourceId, registrationMetadata: { governance: entry, dependentInputs: dependentFiles },
  }] }));
  const snapshotPath = path.join(root, "collected.json"), receiptPath = path.join(root, "receipt.json");
  await writeFile(snapshotPath, JSON.stringify(snapshot));
  const options = { repositoryRoot: root, snapshotPath, receiptPath, now };
  const prepared = await prepareGwangjuTopologyRegistration(options);
  const receipt = { sourceId, snapshotId: prepared.snapshotId, rawObjectSha256: prepared.snapshotSha256,
    rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/${prepared.objectKey}`, byteSize: prepared.snapshotBytes.length,
    storedAt: now.toISOString(), rawRetentionExpiresAt: prepared.rawRetentionExpiresAt };
  await writeFile(receiptPath, JSON.stringify({ ...receipt, rawObjectSha256: "0".repeat(64) }));
  await assert.rejects(registerGwangjuTopology(options), /OCI receipt binding/);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, SOURCE_REGISTRATION_OUTPUTS[1]), "utf8")), [currentMolit]);
  let storedBytes;
  const calls = [];
  const expectedHeadSha = "a".repeat(40);
  const verifiedReceiptPath = path.join(root, "verified-receipt.json");
  await publishAndRegisterGwangjuTopology({ ...options, receiptPath: verifiedReceiptPath, expectedHeadSha,
    gitRunner: async () => expectedHeadSha,
    env: { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/test-only/n/axvym6vk8g7i/b/easysubway-datapacks/o/" },
    client: {
      putObjectIfAbsent: async (_key, bytes) => { calls.push("PUT"); storedBytes = Buffer.from(bytes); return true; },
      readObject: async () => { calls.push("GET"); return { exists: true, body: storedBytes }; },
    },
  });
  assert.deepEqual(calls, ["PUT", "GET"]);
  assert.equal(JSON.parse(await readFile(verifiedReceiptPath, "utf8")).rawObjectSha256, prepared.snapshotSha256);
  const [inventory, ledger] = await Promise.all(SOURCE_REGISTRATION_OUTPUTS.slice(0, 2).map(async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"))));
  assert.equal(inventory.sources[0].topologyAdmissionEvidence.snapshotId, prepared.snapshotId);
  const topologyLedger = ledger.find(({ sourceId: rowSourceId }) => rowSourceId === sourceId);
  assert.equal(topologyLedger.rawObjectSha256, prepared.snapshotSha256);
  assert.equal(topologyLedger.rawSha256, snapshot.rawSha256);
  assert.equal(topologyLedger.freshUntil, snapshot.freshUntil);
  assert.deepEqual(await readFile(path.join(root, inventory.sources[0].topologyAdmissionEvidence.snapshotPath)), prepared.snapshotBytes);
  const mapSource = inventory.sources.find(({ id }) => id === "gwangju-transportation-route-map-positions");
  const accessibilitySource = inventory.sources.find(({ id }) => id === "gwangju-transportation-accessibility");
  assert.equal(mapSource.routeMapAdmissionEvidence.capturedAt, mapSnapshot.capturedAt);
  assert.equal(mapSource.routeMapAdmissionEvidence.freshUntil, "2025-02-01T00:00:00.000Z");
  assert.equal(mapSource.routeMapAdmissionEvidence.topologySnapshotId, prepared.snapshotId);
  assert.equal(accessibilitySource.accessibilityAdmissionEvidence.capturedAt, accessibilitySnapshot.capturedAt);
  assert.equal(accessibilitySource.accessibilityAdmissionEvidence.freshUntil, accessibilitySnapshot.freshUntil);
  assert.equal(accessibilitySource.accessibilityAdmissionEvidence.topologySnapshotId, prepared.snapshotId);
  assert.equal(JSON.parse(await readFile(path.join(root, mapSource.routeMapAdmissionEvidence.snapshotPath), "utf8")).topologySnapshotId, prepared.snapshotId);
  assert.equal(JSON.parse(await readFile(path.join(root, accessibilitySource.accessibilityAdmissionEvidence.snapshotPath), "utf8")).topologyLineages[0].snapshotId, prepared.snapshotId);
  assert.equal(inventory.sources.find(({ id }) => id === "molit-urban-rail-full-route-gwangju-membership")
    .membershipAdmissionEvidence.stationCodeSnapshotId, prepared.snapshotId);
  assert.equal(inventory.sources.find(({ id }) => id === "kric-nationwide-timetable-file")
    .retainedScheduleAdmissionEvidence.topologySnapshotId, prepared.snapshotId);
  assert.deepEqual(inventory.sources[0].membershipAdmissionEvidence,
    inventory.sources.find(({ id }) => id === "molit-urban-rail-full-route-gwangju-membership").membershipAdmissionEvidence);
  assert.equal(inventory.sources[0].membershipAdmissionEvidence.verifiedAt, membershipEvidence.verifiedAt);
  assert.deepEqual(inventory.sources.find(({ id }) => id === "kric-nationwide-timetable-file").retainedScheduleAdmissionEvidence, {
    ...initial[0].sources.find(({ id }) => id === "kric-nationwide-timetable-file").retainedScheduleAdmissionEvidence,
    topologySourceId: sourceId, topologySnapshotId: prepared.snapshotId, topologyContentSha256: snapshot.contentSha256,
  });
});
