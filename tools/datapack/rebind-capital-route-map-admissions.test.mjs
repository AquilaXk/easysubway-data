import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { ARTIFACT_KIND, CAPITAL_MAP_LINE_IDS } from "./collect-capital-route-topology.mjs";
import { admittedCapitalLineEvidence } from "./build-datapack.mjs";
import { collectSeoulRouteMapPositions } from "./collect-seoul-route-map-positions.mjs";
import { withCurrentCapitalTopologyAdmissions } from "./rebind-capital-route-map-admissions.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const root = path.resolve(import.meta.dirname, "../..");
const positionPath = "tools/datapack/sources/official-route-map.json";
const topologySnapshotId = "capital-route-topology-20260809";
const reviewedAt = "2026-08-09T12:04:20.479Z";
const publicCsvPath = path.join(root, "tools/datapack/fixtures/seoul-route-map-positions-raw/data-go-15099316.csv");
const publicTopologyPath = path.join(root, "tools/datapack/sources/capital-route-topology-20260814.json");

function fixture(stationName = "서울역") {
  const lineId = CAPITAL_MAP_LINE_IDS[0];
  const scope = [{ stationName: "서울역", sequence: 1 }, { stationName: "시청", sequence: 2 }];
  const edges = [{ fromStationName: "서울역", toStationName: "시청", distanceMeters: 1_000 }];
  const line = {
    lineId, datasetId: "capital-route-source",
    stationCount: scope.length, edgeCount: edges.length,
    scope, edges,
    rawSha256: "9".repeat(64),
    contentSha256: sha256(Buffer.from(JSON.stringify({ scope, edges }))),
  };
  const topologyContentSha256 = sha256(Buffer.from(JSON.stringify({
    lines: [{
      lineId: line.lineId, edgeCount: line.edgeCount, stationCount: line.stationCount,
      contentSha256: line.contentSha256, rawSha256: line.rawSha256, datasetId: line.datasetId,
    }],
    topologyGaps: [],
  })));
  const snapshot = {
    sourceId: "official-route-map", topologySourceId: "capital-route-topology",
    topologySnapshotId: "capital-route-topology-20260724", topologyContentSha256: "1".repeat(64),
    topologyLineages: [{
      sourceId: "capital-route-topology", snapshotId: "capital-route-topology-20260724",
      contentSha256: "1".repeat(64), lineId,
    }],
    lineIds: [lineId], stationCount: 2,
    positions: [{ lineId, stationName }, { lineId, stationName: "시청" }],
  };
  const snapshotBytes = Buffer.from(JSON.stringify(snapshot));
  const inventory = {
    schemaVersion: 1,
    artifactKind: "production-source-inventory",
    sources: [{
      id: "official-route-map",
      routeMapAdmissionEvidence: {
        snapshotPath: positionPath, snapshotSha256: sha256(snapshotBytes),
        stationCount: 2, lineIds: [lineId], topologySourceId: "capital-route-topology",
        topologySnapshotId: "capital-route-topology-20260724",
        topologyContentSha256: "1".repeat(64),
        topologyLineages: snapshot.topologyLineages,
      },
    }],
  };
  const topology = {
    schemaVersion: 1, artifactKind: ARTIFACT_KIND, sourceId: "capital-route-topology",
    contentSha256: topologyContentSha256,
    capturedAt: "2026-08-09T12:04:20.479Z", freshUntil: "2026-08-10T12:04:20.479Z",
    topologyGaps: [], lines: [line],
  };
  return { inventory, topology, snapshotBytes, lineId };
}

function rebind(values, snapshotBytes = values.snapshotBytes) {
  return withCurrentCapitalTopologyAdmissions({
    inventory: values.inventory,
    topology: values.topology,
    topologySnapshotId,
    reviewedAt,
    snapshotBytesByPath: new Map([[positionPath, snapshotBytes]]),
  });
}

function seoulOfficialFixture() {
  const values = fixture();
  const source = values.inventory.sources[0];
  const evidence = source.routeMapAdmissionEvidence;
  const snapshot = JSON.parse(values.snapshotBytes);
  source.id = "seoul-metro-route-map-positions";
  source.productionUseAllowed = true;
  source.license = { redistributionAllowed: true };
  Object.assign(evidence, {
    issue: 2470,
    admissionKind: "official-file-latlon",
    materializer: "tools/datapack/materialize-seoul-route-map-positions.mjs",
    verificationTest: "tools/datapack/materialize-seoul-route-map-positions.test.mjs",
    positionsSha256: "2".repeat(64),
    rawSha256: "3".repeat(64),
  });
  delete evidence.topologySourceId;
  delete evidence.topologySnapshotId;
  delete evidence.topologyContentSha256;
  delete evidence.topologyLineages;
  snapshot.sourceId = source.id;
  snapshot.positionsSha256 = evidence.positionsSha256;
  snapshot.rawSha256 = evidence.rawSha256;
  delete snapshot.topologySourceId;
  delete snapshot.topologySnapshotId;
  delete snapshot.topologyContentSha256;
  delete snapshot.topologyLineages;
  values.snapshotBytes = Buffer.from(JSON.stringify(snapshot));
  evidence.snapshotSha256 = sha256(values.snapshotBytes);
  return values;
}

async function seoulCurrentLayoutFixture() {
  const [csvBytes, topologySnapshotBytes] = await Promise.all([
    readFile(publicCsvPath),
    readFile(publicTopologyPath),
  ]);
  const topology = JSON.parse(topologySnapshotBytes);
  const artifact = collectSeoulRouteMapPositions({
    csvBytes,
    topologySnapshotBytes,
    topologySnapshotId: "capital-route-topology-20260814",
    now: new Date(topology.capturedAt),
  });
  const snapshotId = "seoul-metro-route-map-positions-current-20260814T000000000Z";
  const normalizedProjection = artifact.rawPositions.map(({
    line, stationCode, stationName, latitude, longitude, basisDate,
  }) => ({ line, stationCode, stationName, latitude, longitude, basisDate }));
  const layoutEvidence = Object.fromEntries([
    "layoutAlgorithmVersion", "topologySnapshotId", "topologySnapshotSha256",
    "topologySnapshotIdentity", "lineOrderSha256", "aliasLedgerVersion",
    "aliasLedgerSha256", "rawPositionsSha256", "layoutPositionsSha256",
    "layoutTracksSha256", "semanticInputSha256", "semanticOutputSha256",
    "outputSchemaSha256",
  ].map((field) => [field, artifact[field]]));
  layoutEvidence.layoutArtifactSha256 = sha256(Buffer.from(`${JSON.stringify(artifact)}\n`));
  const observation = {
    schemaVersion: 1,
    artifactKind: "static-network-successor-observation",
    sourceId: artifact.sourceId,
    snapshotId,
    capturedAt: artifact.capturedAt,
    rawSha256: artifact.rawSha256,
    contentSha256: sha256(Buffer.from(`${JSON.stringify(normalizedProjection)}\n`)),
    rowCount: normalizedProjection.length,
    normalizedProjection,
    layoutEvidence,
    routeMapLayoutArtifact: artifact,
  };
  const snapshotBytes = Buffer.from(`${JSON.stringify(observation)}\n`);
  const evidence = {
    issue: 2470,
    admissionKind: "official-file-latlon",
    materializer: "tools/datapack/materialize-seoul-route-map-positions.mjs",
    verificationTest: "tools/datapack/materialize-seoul-route-map-positions.test.mjs",
    lineIds: [...artifact.lineIds],
    currentLayoutAdmission: {
      schemaVersion: 2,
      artifactKind: "seoul-public-route-map-layout-admission",
      status: "ADMITTED",
      positionSnapshotId: snapshotId,
      snapshotPath: `tools/datapack/sources/${snapshotId}.json`,
      snapshotSha256: sha256(snapshotBytes),
      rawSha256: observation.rawSha256,
      contentSha256: observation.contentSha256,
      ...layoutEvidence,
    },
  };
  return {
    inventory: {
      schemaVersion: 1,
      artifactKind: "production-source-inventory",
      sources: [{
        id: artifact.sourceId,
        productionUseAllowed: true,
        license: { redistributionAllowed: true },
        routeMapAdmissionEvidence: evidence,
      }],
    },
    topology,
    topologySnapshotBytes,
    snapshotBytes,
    snapshotPath: evidence.currentLayoutAdmission.snapshotPath,
  };
}

test("historical route-map snapshot은 current capital topology membership 검증 후 별도 admission으로 결속된다", () => {
  const values = fixture();
  const result = rebind(values);

  assert.deepEqual(
    result.sources[0].routeMapAdmissionEvidence.currentTopologyAdmission,
    {
      schemaVersion: 1, artifactKind: "capital-route-map-current-topology-admission",
      issue: 2776, status: "ADMITTED", topologySnapshotId,
      topologyContentSha256: values.topology.contentSha256,
      positionSnapshotSha256: sha256(values.snapshotBytes),
      reviewedAt, freshUntil: "2026-08-10T12:04:20.479Z",
      topologyLineages: [{
        sourceId: "capital-route-topology", snapshotId: "capital-route-topology-20260809",
        contentSha256: values.topology.contentSha256, lineId: values.lineId,
      }],
    },
  );
});

test("rebound current admission은 production line admission으로 사용된다", () => {
  const values = fixture();
  const inventory = rebind(values);
  const admit = (candidate) => admittedCapitalLineEvidence(
    candidate, values.topology, topologySnapshotId, reviewedAt, new Date("2026-08-10T00:00:00.000Z"),
  );
  assert.deepEqual(admit(inventory).get(values.lineId), {
    verifiedAt: reviewedAt,
    freshUntil: values.topology.freshUntil,
  });

  const tampered = structuredClone(inventory);
  tampered.sources[0].routeMapAdmissionEvidence.currentTopologyAdmission.topologyContentSha256 = "d".repeat(64);
  assert.throws(() => admit(tampered), /current topology admission identity mismatch/);

  const stale = structuredClone(inventory);
  stale.sources[0].routeMapAdmissionEvidence.currentTopologyAdmission.freshUntil = "2026-08-09T13:00:00.000Z";
  assert.throws(() => admit(stale), /current topology admission is stale/);
});

test("서울 공식 1~8호선 position snapshot은 current capital topology admission으로 결속된다", () => {
  const values = seoulOfficialFixture();
  const inventory = rebind(values);
  const evidence = inventory.sources[0].routeMapAdmissionEvidence;

  assert.equal(evidence.topologySourceId, "capital-route-topology");
  assert.equal(evidence.topologySnapshotId, undefined);
  assert.deepEqual(
    admittedCapitalLineEvidence(
      inventory,
      values.topology,
      topologySnapshotId,
      reviewedAt,
      new Date("2026-08-10T00:00:00.000Z"),
    ).get(values.lineId),
    { verifiedAt: reviewedAt, freshUntil: values.topology.freshUntil },
  );

  const invalid = seoulOfficialFixture();
  invalid.inventory.sources[0].routeMapAdmissionEvidence.issue = 2471;
  assert.throws(() => rebind(invalid), /Seoul route-map position source contract is invalid/);
});

test("서울 공식 current position admission은 다음 current topology에 exact 재결속된다", () => {
  const values = seoulOfficialFixture();
  const first = rebind(values);
  const repeated = rebind({ ...values, inventory: first });

  assert.deepEqual(
    repeated.sources[0].routeMapAdmissionEvidence.currentTopologyAdmission,
    first.sources[0].routeMapAdmissionEvidence.currentTopologyAdmission,
  );

  const drifted = structuredClone(first);
  drifted.sources[0].routeMapAdmissionEvidence
    .currentTopologyAdmission.positionSnapshotSha256 = "f".repeat(64);
  assert.throws(
    () => rebind({ ...values, inventory: drifted }),
    /Seoul route-map position source contract is invalid/,
  );
});

test("서울 public v2 layout observation은 exact admission과 topology bytes에 재결속된다", async () => {
  const values = await seoulCurrentLayoutFixture();
  const result = withCurrentCapitalTopologyAdmissions({
    inventory: values.inventory,
    topology: values.topology,
    topologySnapshotId: "capital-route-topology-20260814",
    reviewedAt: values.topology.capturedAt,
    snapshotBytesByPath: new Map([[values.snapshotPath, values.snapshotBytes]]),
    topologySnapshotBytes: values.topologySnapshotBytes,
  });
  const evidence = result.sources[0].routeMapAdmissionEvidence;
  assert.equal(
    evidence.currentTopologyAdmission.positionSnapshotSha256,
    evidence.currentLayoutAdmission.snapshotSha256,
  );
  assert.deepEqual(evidence.currentLayoutAdmission, values.inventory.sources[0].routeMapAdmissionEvidence.currentLayoutAdmission);

  const tampered = await seoulCurrentLayoutFixture();
  tampered.inventory.sources[0].routeMapAdmissionEvidence
    .currentLayoutAdmission.layoutPositionsSha256 = "0".repeat(64);
  assert.throws(() => withCurrentCapitalTopologyAdmissions({
    inventory: tampered.inventory,
    topology: tampered.topology,
    topologySnapshotId: "capital-route-topology-20260814",
    reviewedAt: tampered.topology.capturedAt,
    snapshotBytesByPath: new Map([[tampered.snapshotPath, tampered.snapshotBytes]]),
    topologySnapshotBytes: tampered.topologySnapshotBytes,
  }), /layout observation identity/);
});

test("tracked 서울 공식 position snapshot의 exact renamed-station aliases는 current 22-line admission을 완성한다", async () => {
  const [inventory, topology] = await Promise.all([
    readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/sources/capital-route-topology-20260813.json"), "utf8").then(JSON.parse),
  ]);
  const snapshotBytesByPath = new Map();
  for (const source of inventory.sources) {
    if (source.routeMapAdmissionEvidence?.topologySourceId === "capital-route-topology"
      || source.id === "seoul-metro-route-map-positions") {
      snapshotBytesByPath.set(
        source.routeMapAdmissionEvidence.snapshotPath,
        await readFile(path.join(root, source.routeMapAdmissionEvidence.snapshotPath)),
      );
    }
  }
  const rebound = withCurrentCapitalTopologyAdmissions({
    inventory,
    topology,
    topologySnapshotId: "capital-route-topology-20260813",
    reviewedAt: topology.capturedAt,
    snapshotBytesByPath,
  });
  const admissions = admittedCapitalLineEvidence(
    rebound,
    topology,
    "capital-route-topology-20260813",
    topology.capturedAt,
    new Date("2026-08-13T16:19:47.000Z"),
  );

  assert.equal(admissions.size, 22);
  for (const lineId of [
    "line-472a81add377", "seoul-4", "line-80fc4d5350d4",
    "line-15b3b8a93259", "line-2b2d9eaa53d0",
  ]) {
    assert.equal(admissions.has(lineId), true, lineId);
  }
});

test("current topology에 없는 station은 input을 변경하지 않고 거부한다", () => {
  const values = fixture("없는역");
  const before = structuredClone(values.inventory);

  assert.throws(() => rebind(values), /station membership mismatch/);
  assert.deepEqual(values.inventory, before);
});

test("position snapshot의 declared station subset은 좌표를 추정하지 않고 current topology에 결속된다", () => {
  const values = fixture();
  const snapshot = JSON.parse(values.snapshotBytes);
  snapshot.positions.pop();
  snapshot.stationCount = 1;
  values.snapshotBytes = Buffer.from(JSON.stringify(snapshot));
  const evidence = values.inventory.sources[0].routeMapAdmissionEvidence;
  evidence.snapshotSha256 = sha256(values.snapshotBytes);
  evidence.stationCount = 1;

  const result = rebind(values);
  assert.equal(
    result.sources[0].routeMapAdmissionEvidence.currentTopologyAdmission.topologySnapshotId,
    topologySnapshotId,
  );
  assert.equal(snapshot.positions.length, 1);
});

test("position snapshot의 duplicate station은 input을 변경하지 않고 거부한다", () => {
  const values = fixture();
  const snapshot = JSON.parse(values.snapshotBytes);
  snapshot.positions[1] = { ...snapshot.positions[0] };
  values.snapshotBytes = Buffer.from(JSON.stringify(snapshot));
  const evidence = values.inventory.sources[0].routeMapAdmissionEvidence;
  evidence.snapshotSha256 = sha256(values.snapshotBytes);
  const before = structuredClone(values.inventory);

  assert.throws(() => rebind(values), /duplicate position/);
  assert.deepEqual(values.inventory, before);
});

test("position snapshot bytes가 admission hash와 다르면 input을 변경하지 않고 거부한다", () => {
  const values = fixture();
  const before = structuredClone(values.inventory);
  assert.throws(() => rebind(values, Buffer.from("{}")), /position snapshot byte identity mismatch/);
  assert.deepEqual(values.inventory, before);
});

test("current topology line content가 선언 hash와 다르면 input을 변경하지 않고 거부한다", () => {
  const values = fixture();
  values.topology.lines[0].edges[0].distanceMeters = 9_999;
  const before = structuredClone(values.inventory);

  assert.throws(() => rebind(values), /line contentSha256 mismatch/);
  assert.deepEqual(values.inventory, before);
});

test("capital topology admission 대상 source가 없으면 input을 변경하지 않고 거부한다", () => {
  const values = fixture();
  values.inventory.sources = [];
  const before = structuredClone(values.inventory);
  assert.throws(() => withCurrentCapitalTopologyAdmissions({
    inventory: values.inventory,
    topology: values.topology,
    topologySnapshotId: "capital-route-topology-20260809",
    reviewedAt: "2026-08-09T12:04:20.479Z",
    snapshotBytesByPath: new Map(),
  }), /capital route-map admissions are missing/);
  assert.deepEqual(values.inventory, before);
});

test("source inventory schema는 capital topology source에 current admission을 필수화한다", async () => {
  const schema = JSON.parse(await readFile(
    path.join(root, "contracts/datapack/source-inventory.schema.json"),
    "utf8",
  ));
  const routeMapEvidence = schema.properties.sources.items.properties.routeMapAdmissionEvidence;
  const current = routeMapEvidence.properties.currentTopologyAdmission;

  assert.deepEqual(routeMapEvidence.allOf, [{
    if: {
      required: ["topologySourceId"],
      properties: { topologySourceId: { const: "capital-route-topology" } },
    },
    then: { required: ["currentTopologyAdmission"] },
  }]);
  assert.equal(current.additionalProperties, false);
  assert.deepEqual(current.required, [
    "schemaVersion", "artifactKind", "issue", "status", "topologySnapshotId",
    "topologyContentSha256", "positionSnapshotSha256", "reviewedAt", "freshUntil",
    "topologyLineages",
  ]);
  assert.equal(current.properties.artifactKind.const, "capital-route-map-current-topology-admission");
  const layout = routeMapEvidence.properties.currentLayoutAdmission;
  assert.equal(layout.additionalProperties, false);
  assert.equal(layout.properties.schemaVersion.const, 2);
  assert.equal(layout.properties.artifactKind.const, "seoul-public-route-map-layout-admission");
  assert.equal(layout.required.length, 22);
});
