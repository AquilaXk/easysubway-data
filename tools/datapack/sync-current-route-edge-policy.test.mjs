import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CURRENT_ROUTE_EDGE_INPUT,
  syncCurrentRouteEdgePolicy,
  syncCurrentRouteEdgePolicyFile,
} from "./sync-current-route-edge-policy.mjs";
import { canonicalRideEdgeSetSha256 } from "./evaluate-route-accessibility-edges.mjs";
import * as itxTopology from "./apply-itx-topology-to-bundled-pack.mjs";

test("policy CLI는 current full-capital route output만 소비한다", () => {
  assert.equal(
    CURRENT_ROUTE_EDGE_INPUT,
    "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json",
  );
  assert.equal(CURRENT_ROUTE_EDGE_INPUT.includes("current-route-edge-evaluation"), false);
});

test("current route edge policy는 exact RIDE partition digest만 동기화한다", async () => {
  const raw = (edgeId, serviceClass, servicePattern) => ({ edgeId, edgeType: "RIDE", fromNodeId: `${edgeId}:a`, toNodeId: `${edgeId}:b`, durationSeconds: 1, distanceMeters: 1, serviceClass, servicePattern });
  const { routeEdgeSha256 } = await import("./evaluate-route-accessibility-edges.mjs");
  const edge = (id, serviceClass, servicePattern) => { const value = raw(id, serviceClass, servicePattern); return { ...value, edgeSha256: routeEdgeSha256(value) }; };
  const policy = { policyVersion: "v1", rideInvariant: { subwayLocal: {}, itxCheongchunExpress: {} } };
  const admittedItx = edge("b", "ITX_CHEONGCHUN", "EXPRESS");
  const admittedItxDigest = canonicalRideEdgeSetSha256([admittedItx]);
  const synced = syncCurrentRouteEdgePolicy({ candidate: { policyVersion: "v1" }, routeEdges: [edge("a", "SUBWAY", "LOCAL"), admittedItx] }, policy, admittedItxDigest);
  assert.match(synced.rideInvariant.subwayLocal.admittedEdgeSetSha256, /^[0-9a-f]{64}$/);
  assert.equal(synced.rideInvariant.itxCheongchunExpress.admittedEdgeSetSha256, admittedItxDigest);
  assert.throws(() => syncCurrentRouteEdgePolicy({ candidate: { policyVersion: "v1" }, routeEdges: [edge("a", "SUBWAY", "EXPRESS")] }, policy, admittedItxDigest), /RIDE partition/);
  assert.throws(() => syncCurrentRouteEdgePolicy({ candidate: { policyVersion: "v1" }, routeEdges: [edge("a", "SUBWAY", "LOCAL"), edge("candidate-tamper", "ITX_CHEONGCHUN", "EXPRESS")] }, policy, admittedItxDigest), /ITX EXPRESS edge set identity mismatch/);
});

test("immutable ITX policy digest는 approved source bytes에서 독립 유도된다", async () => {
  const repositoryRoot = path.resolve(import.meta.dirname, "../..");
  const policy = JSON.parse(await readFile(path.join(repositoryRoot, "release/product-gates/route-edge-evaluation-policy.json"), "utf8"));
  assert.equal(
    policy.rideInvariant.itxCheongchunExpress.admittedEdgeSetSha256,
    await itxTopology.readImmutableItxRideEdgeSetSha256(repositoryRoot),
  );
});

test("policy file sync는 digest 두 값만 보존적으로 교체하고 invalid input은 그대로 둔다", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "route-policy-sync-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { routeEdgeSha256 } = await import("./evaluate-route-accessibility-edges.mjs");
  const raw = { edgeId: "local", edgeType: "RIDE", fromNodeId: "a", toNodeId: "b", durationSeconds: 1, distanceMeters: 1, serviceClass: "SUBWAY", servicePattern: "LOCAL" };
  const inputPath = path.join(root, "input.json");
  const policyPath = path.join(root, "policy.json");
  const policyText = '{\n  "policyVersion": "v1",\n  "rideInvariant": { "subwayLocal": { "admittedEdgeSetSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, "itxCheongchunExpress": { "admittedEdgeSetSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } },\n  "untouched": "keep me"\n}\n';
  await writeFile(inputPath, JSON.stringify({ candidate: { policyVersion: "v1" }, routeEdges: [{ ...raw, edgeSha256: routeEdgeSha256(raw) }] }));
  await writeFile(policyPath, policyText);
  const options = {
    repositoryRoot: root,
    inputPath,
    policyPath,
    readAdmittedItxRideEdgeSetSha256Impl: async () => canonicalRideEdgeSetSha256([]),
  };
  await syncCurrentRouteEdgePolicyFile(options);
  const updated = await readFile(policyPath, "utf8");
  assert.equal(updated.includes('"untouched": "keep me"'), true);
  assert.equal(updated.replace(/[0-9a-f]{64}/g, "<digest>"), policyText.replace(/[0-9a-f]{64}/g, "<digest>"));
  await writeFile(inputPath, JSON.stringify({ candidate: { policyVersion: "v1" }, routeEdges: [{ ...raw, edgeSha256: "0".repeat(64) }] }));
  await assert.rejects(syncCurrentRouteEdgePolicyFile(options), /hash/);
  assert.equal(await readFile(policyPath, "utf8"), updated);
});
