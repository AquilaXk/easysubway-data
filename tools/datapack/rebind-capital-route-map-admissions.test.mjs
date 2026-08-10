import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { ARTIFACT_KIND, CAPITAL_MAP_LINE_IDS } from "./collect-capital-route-topology.mjs";
import { admittedCapitalLineEvidence } from "./build-datapack.mjs";
import { withCurrentCapitalTopologyAdmissions } from "./rebind-capital-route-map-admissions.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const root = path.resolve(import.meta.dirname, "../..");
const positionPath = "tools/datapack/sources/official-route-map.json";
const topologySnapshotId = "capital-route-topology-20260809";
const reviewedAt = "2026-08-09T12:04:20.479Z";

function fixture(stationName = "서울역") {
  const lineId = CAPITAL_MAP_LINE_IDS[0];
  const scope = [{ stationName: "서울역", sequence: 1 }, { stationName: "시청", sequence: 2 }];
  const edges = [{ fromStationName: "서울역", toStationName: "시청", distanceMeters: 1_000 }];
  const line = {
    lineId,
    datasetId: "capital-route-source",
    stationCount: scope.length,
    edgeCount: edges.length,
    scope,
    edges,
    rawSha256: "9".repeat(64),
    contentSha256: sha256(Buffer.from(JSON.stringify({ scope, edges }))),
  };
  const topologyContentSha256 = sha256(Buffer.from(JSON.stringify({
    lines: [{
      lineId: line.lineId,
      edgeCount: line.edgeCount,
      stationCount: line.stationCount,
      contentSha256: line.contentSha256,
      rawSha256: line.rawSha256,
      datasetId: line.datasetId,
    }],
    topologyGaps: [],
  })));
  const snapshot = {
    sourceId: "official-route-map",
    topologySourceId: "capital-route-topology",
    topologySnapshotId: "capital-route-topology-20260724",
    topologyContentSha256: "1".repeat(64),
    topologyLineages: [{
      sourceId: "capital-route-topology",
      snapshotId: "capital-route-topology-20260724",
      contentSha256: "1".repeat(64),
      lineId,
    }],
    lineIds: [lineId],
    stationCount: 1,
    positions: [{ lineId, stationName }],
  };
  const snapshotBytes = Buffer.from(JSON.stringify(snapshot));
  const inventory = {
    schemaVersion: 1,
    artifactKind: "production-source-inventory",
    sources: [{
      id: "official-route-map",
      routeMapAdmissionEvidence: {
        snapshotPath: positionPath,
        snapshotSha256: sha256(snapshotBytes),
        stationCount: 1,
        lineIds: [lineId],
        topologySourceId: "capital-route-topology",
        topologySnapshotId: "capital-route-topology-20260724",
        topologyContentSha256: "1".repeat(64),
        topologyLineages: snapshot.topologyLineages,
      },
    }],
  };
  const topology = {
    schemaVersion: 1,
    artifactKind: ARTIFACT_KIND,
    sourceId: "capital-route-topology",
    contentSha256: topologyContentSha256,
    capturedAt: "2026-08-09T12:04:20.479Z",
    freshUntil: "2026-08-10T12:04:20.479Z",
    topologyGaps: [],
    lines: [line],
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

test("historical route-map snapshot은 current capital topology membership 검증 후 별도 admission으로 결속된다", () => {
  const values = fixture();
  const result = rebind(values);

  assert.deepEqual(
    result.sources[0].routeMapAdmissionEvidence.currentTopologyAdmission,
    {
      schemaVersion: 1,
      artifactKind: "capital-route-map-current-topology-admission",
      issue: 2776,
      status: "ADMITTED",
      topologySnapshotId,
      topologyContentSha256: values.topology.contentSha256,
      positionSnapshotSha256: sha256(values.snapshotBytes),
      reviewedAt,
      freshUntil: "2026-08-10T12:04:20.479Z",
      topologyLineages: [{
        sourceId: "capital-route-topology",
        snapshotId: "capital-route-topology-20260809",
        contentSha256: values.topology.contentSha256,
        lineId: values.lineId,
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

test("current topology에 없는 station은 input을 변경하지 않고 거부한다", () => {
  const values = fixture("없는역");
  const before = structuredClone(values.inventory);

  assert.throws(() => rebind(values), /station membership mismatch/);
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

test("source inventory schema는 current topology admission을 closed optional migration field로 고정한다", async () => {
  const schema = JSON.parse(await readFile(
    path.join(root, "contracts/datapack/source-inventory.schema.json"),
    "utf8",
  ));
  const routeMapEvidence = schema.properties.sources.items.properties.routeMapAdmissionEvidence;
  const current = routeMapEvidence.properties.currentTopologyAdmission;

  assert.equal(routeMapEvidence.required.includes("currentTopologyAdmission"), false);
  assert.equal(current.additionalProperties, false);
  assert.deepEqual(current.required, [
    "schemaVersion",
    "artifactKind",
    "issue",
    "status",
    "topologySnapshotId",
    "topologyContentSha256",
    "positionSnapshotSha256",
    "reviewedAt",
    "freshUntil",
    "topologyLineages",
  ]);
  assert.equal(current.properties.artifactKind.const, "capital-route-map-current-topology-admission");
});
