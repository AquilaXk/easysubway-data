import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { withCurrentCapitalTopologyAdmissions } from "./rebind-capital-route-map-admissions.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const root = path.resolve(import.meta.dirname, "../..");

function fixture(stationName = "서울역") {
  const snapshot = {
    sourceId: "official-route-map",
    topologySourceId: "capital-route-topology",
    topologySnapshotId: "capital-route-topology-20260724",
    topologyContentSha256: "1".repeat(64),
    topologyLineages: [{
      sourceId: "capital-route-topology",
      snapshotId: "capital-route-topology-20260724",
      contentSha256: "1".repeat(64),
      lineId: "seoul-1",
    }],
    lineIds: ["seoul-1"],
    stationCount: 1,
    positions: [{ lineId: "seoul-1", stationName }],
  };
  const snapshotBytes = Buffer.from(JSON.stringify(snapshot));
  const inventory = {
    schemaVersion: 1,
    artifactKind: "production-source-inventory",
    sources: [{
      id: "official-route-map",
      routeMapAdmissionEvidence: {
        snapshotPath: "tools/datapack/sources/official-route-map.json",
        snapshotSha256: sha256(snapshotBytes),
        stationCount: 1,
        lineIds: ["seoul-1"],
        topologySourceId: "capital-route-topology",
        topologySnapshotId: "capital-route-topology-20260724",
        topologyContentSha256: "1".repeat(64),
        topologyLineages: snapshot.topologyLineages,
      },
    }],
  };
  const topology = {
    sourceId: "capital-route-topology",
    contentSha256: "2".repeat(64),
    capturedAt: "2026-08-09T12:04:20.479Z",
    freshUntil: "2026-08-10T12:04:20.479Z",
    lines: [{
      lineId: "seoul-1",
      scope: [{ stationName: "서울역" }],
      branchSequences: [],
    }],
  };
  return { inventory, topology, snapshotBytes };
}

test("historical route-map snapshot은 current capital topology membership 검증 후 별도 admission으로 결속된다", () => {
  const values = fixture();
  const result = withCurrentCapitalTopologyAdmissions({
    inventory: values.inventory,
    topology: values.topology,
    topologySnapshotId: "capital-route-topology-20260809",
    reviewedAt: "2026-08-09T12:04:20.479Z",
    snapshotBytesByPath: new Map([[
      "tools/datapack/sources/official-route-map.json",
      values.snapshotBytes,
    ]]),
  });

  assert.deepEqual(
    result.sources[0].routeMapAdmissionEvidence.currentTopologyAdmission,
    {
      schemaVersion: 1,
      artifactKind: "capital-route-map-current-topology-admission",
      issue: 2776,
      status: "ADMITTED",
      topologySnapshotId: "capital-route-topology-20260809",
      topologyContentSha256: "2".repeat(64),
      positionSnapshotSha256: sha256(values.snapshotBytes),
      reviewedAt: "2026-08-09T12:04:20.479Z",
      freshUntil: "2026-08-10T12:04:20.479Z",
      topologyLineages: [{
        sourceId: "capital-route-topology",
        snapshotId: "capital-route-topology-20260809",
        contentSha256: "2".repeat(64),
        lineId: "seoul-1",
      }],
    },
  );
});

test("current topology에 없는 station은 input을 변경하지 않고 거부한다", () => {
  const values = fixture("없는역");
  const before = structuredClone(values.inventory);

  assert.throws(() => withCurrentCapitalTopologyAdmissions({
    inventory: values.inventory,
    topology: values.topology,
    topologySnapshotId: "capital-route-topology-20260809",
    reviewedAt: "2026-08-09T12:04:20.479Z",
    snapshotBytesByPath: new Map([[
      "tools/datapack/sources/official-route-map.json",
      values.snapshotBytes,
    ]]),
  }), /station membership mismatch/);
  assert.deepEqual(values.inventory, before);
});

test("position snapshot bytes가 admission hash와 다르면 input을 변경하지 않고 거부한다", () => {
  const values = fixture();
  const before = structuredClone(values.inventory);
  assert.throws(() => withCurrentCapitalTopologyAdmissions({
    inventory: values.inventory,
    topology: values.topology,
    topologySnapshotId: "capital-route-topology-20260809",
    reviewedAt: "2026-08-09T12:04:20.479Z",
    snapshotBytesByPath: new Map([[
      "tools/datapack/sources/official-route-map.json",
      Buffer.from("{}"),
    ]]),
  }), /position snapshot byte identity mismatch/);
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
