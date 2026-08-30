import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as buildDatapack from "./build-datapack.mjs";
import {
  canonicalCurrentReleaseCandidateAccessibilityAuthorityJson,
  canonicalCurrentReleaseCandidateFixtureJson,
  rebuildCurrentReleaseCandidateFixture,
} from "./build-current-release-candidate-accessibility-input.mjs";

test("candidate fixture override는 original/projected/authority identity를 exact 결속한다", () => {
  const value = overrideFixture();
  const result = buildDatapack.validateCandidateFixtureOverride(value);
  assert.equal(result.fixture.packs[0].networkEdges.length, 2654);
  assert.deepEqual(result.binding, {
    sourceFixtureSha256: sha(value.sourceFixtureBytes),
    candidateFixtureSha256: sha(value.candidateFixtureBytes),
    serverRouteCoverageAuthoritySha256: value.authority.authoritySha256,
  });
});

test("candidate fixture override는 ITX route-service evidence binding을 보존한다", () => {
  const sourcePack = { id: "capital", version: "1" };
  const replacementPack = { id: "capital", version: "1" };
  const sourceFixture = { packs: [sourcePack] };
  const replacementFixture = { packs: [replacementPack] };
  const evidence = { artifactEvidence: {}, stationCatalogEvidence: {} };
  const evidenceStore = new WeakMap([[sourcePack, evidence]]);

  assert.equal(typeof buildDatapack.transferValidatedItxStationCatalogEvidence, "function");
  assert.strictEqual(
    buildDatapack.transferValidatedItxStationCatalogEvidence(
      sourceFixture,
      replacementFixture,
      evidenceStore,
    ),
    replacementFixture,
  );
  assert.strictEqual(evidenceStore.get(replacementPack), evidence);
});

test("candidate fixture override는 authority와 다른 route-edge bytes를 출력 전에 거부한다", () => {
  const { authority } = overrideFixture();
  assert.throws(
    () => buildDatapack.candidateOverrideAccessibilityFreshUntil({
      authority,
      stationLineInputBytes: Buffer.from("{}"),
      routeEdgeInputBytes: Buffer.from("different-route-edge-input"),
      validationNow: new Date("2026-08-16T00:00:00.000Z"),
    }),
    /route-edge input identity mismatch/,
  );
});

test("단독 override·noncanonical·hash·projection drift는 build input 선택 전에 거부된다", async () => {
  const source = await readFile(new URL("./build-datapack.mjs", import.meta.url), "utf8");
  assert.match(source, /--candidate-fixture-override, --server-route-coverage-authority, --current-capital-station-line-input and --current-capital-route-edge-input must be provided together/);
  assert.match(source, /route-edge input identity mismatch/);
  assert.match(source, /candidate fixture override requires --build-spec/);
  for (const [label, mutate, pattern] of [
    ["noncanonical", (value) => { value.candidateFixtureBytes = Buffer.concat([value.candidateFixtureBytes, Buffer.from("\n")]); }, /canonical/i],
    ["source fixture", (value) => { value.sourceFixtureBytes = Buffer.from("{\"changed\":true}"); }, /binding/i],
    ["authority", (value) => { value.authority.authoritySha256 = "0".repeat(64); value.authorityBytes = Buffer.from(canonical(value.authority)); }, /authority hash/i],
    ["candidate hash", (value) => { value.authority.buildInput.candidateFixtureSha256 = "0".repeat(64); resealAuthority(value); }, /binding/i],
    ["required cell endpoint", (value) => { value.authority.edges[0].requiredCells[0].lineId = "seoul-4"; resealAuthority(value); }, /cell endpoint/i],
    ["route edge hash", (value) => { value.authority.edges[0].routeEdgeSha256 = "0".repeat(64); resealAuthority(value); }, /route edge hash/i],
    ["projection", (value) => { value.projectedFixture.packs[0].networkEdges[0].distanceMeters += 1; }, /projection/i],
  ]) {
    const value = overrideFixture();
    mutate(value);
    assert.throws(() => buildDatapack.validateCandidateFixtureOverride(value), pattern, label);
  }
});

function overrideFixture() {
  const buildSpec = { candidateId: "capital-full", sourceSnapshotSetHash: "a".repeat(64) };
  const buildSpecBytes = Buffer.from(canonical(buildSpec));
  const sourceFixtureBytes = Buffer.from(canonical({ source: "original" }));
  const projectedFixture = {
    manifest: { activePack: { id: "capital", version: "1" }, channel: "production" },
    packs: [{
      id: "capital",
      version: "1",
      networkEdges: [
        ...Array.from({ length: 2198 }, (_, index) => ride(index)),
      ],
    }],
  };
  const candidate = {
    candidateId: buildSpec.candidateId,
    mappingContractVersion: "station-line-v1",
    materializerVersion: "1",
    sourceSetSha256: buildSpec.sourceSnapshotSetHash,
    stationSetSha256: "b".repeat(64),
  };
  const edges = [
    ...Array.from({ length: 213 }, (_, index) => authorityEdge("ENTRY", index)),
    ...Array.from({ length: 213 }, (_, index) => authorityEdge("EXIT", index)),
    ...Array.from({ length: 30 }, (_, index) => authorityEdge("IN_STATION_TRANSFER", index)),
  ].sort((left, right) => left.edgeId.localeCompare(right.edgeId));
  const payload = {
    schemaVersion: 1,
    artifactKind: "server-route-coverage-authority",
    candidate,
    buildInput: {
      buildSpecSha256: sha(buildSpecBytes),
      sourceFixtureSha256: sha(sourceFixtureBytes),
      candidateFixtureSha256: "0".repeat(64),
      stationLineInputSha256: "c".repeat(64),
      routeEdgeInputSha256: "d".repeat(64),
      materializationDigest: "e".repeat(64),
      observedAt: "2026-08-16T00:00:00.000Z",
    },
    edgeCounts: { ENTRY: 213, EXIT: 213, IN_STATION_TRANSFER: 30, total: 456 },
    edges,
  };
  let authority = { ...payload, authoritySha256: sha(Buffer.from(canonical(payload))) };
  const candidateFixture = rebuildCurrentReleaseCandidateFixture({ projectedFixture, authority });
  const candidateFixtureBytes = Buffer.from(canonicalCurrentReleaseCandidateFixtureJson(candidateFixture));
  authority.buildInput.candidateFixtureSha256 = sha(candidateFixtureBytes);
  authority.authoritySha256 = sha(Buffer.from(canonical(without(authority, "authoritySha256"))));
  const authorityBytes = Buffer.from(canonicalCurrentReleaseCandidateAccessibilityAuthorityJson(authority));
  return {
    authority,
    authorityBytes,
    buildSpec,
    buildSpecBytes,
    candidateFixtureBytes,
    projectedFixture,
    sourceFixtureBytes,
  };
}

function authorityEdge(edgeType, index) {
  const padded = String(index).padStart(3, "0");
  const stationId = `station-${padded}`;
  const lineId = "seoul-2";
  const transfer = edgeType === "IN_STATION_TRANSFER";
  const requiredCells = transfer
    ? [
        cell(stationId, "seoul-2", "TRANSFER", index === 0 ? "UNVERIFIED_EVIDENCE_BLOCKED" : "VERIFIED_PRESENT"),
        cell(stationId, "seoul-4", "TRANSFER", "NOT_APPLICABLE"),
      ]
    : [cell(stationId, lineId, edgeType === "ENTRY" ? "FACILITY" : "EXIT", edgeType === "EXIT" && index === 0 ? "UNVERIFIED_EVIDENCE_BLOCKED" : "VERIFIED_PRESENT")];
  const edge = {
    edgeId: `edge-${edgeType.toLowerCase()}-${padded}`,
    edgeType,
    fromNodeId: edgeType === "ENTRY" ? stationId : `${stationId}:${lineId}`,
    toNodeId: edgeType === "EXIT" ? stationId : transfer ? `${stationId}:seoul-4` : `${stationId}:${lineId}`,
    durationSeconds: edgeType === "ENTRY" ? 90 : edgeType === "EXIT" ? 60 : 0,
    distanceMeters: transfer ? 10 : 0,
    requiredCells,
  };
  return {
    ...edge,
    routeEdgeSha256: sha(canonical({
      edgeId: edge.edgeId,
      edgeType: edge.edgeType,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      durationSeconds: edge.durationSeconds,
      distanceMeters: edge.distanceMeters,
      servicePattern: "",
      serviceClass: "SUBWAY",
    })),
  };
}

function cell(stationId, lineId, domain, state) {
  return { stationId, lineId, domain, state, rowSha256: sha(`${stationId}:${lineId}:${domain}:${state}`) };
}

function ride(index) {
  return {
    id: `ride-${String(index).padStart(4, "0")}`,
    fromNodeId: "station-a:seoul-2",
    toNodeId: "station-b:seoul-2",
    durationSeconds: 120,
    distanceMeters: 1000,
    edgeType: "RIDE",
    servicePattern: "LOCAL",
    serviceClass: "SUBWAY",
    includesStairs: false,
    stairAccessState: "UNKNOWN",
    accessibilityStatus: "UNKNOWN",
    reliabilityScore: 100,
    facilityId: null,
  };
}

function legacy(id, edgeType) {
  return {
    id,
    fromNodeId: edgeType === "ENTRY" ? id : `${id}:line`,
    toNodeId: edgeType === "EXIT" ? id : `${id}:line`,
    durationSeconds: edgeType === "ENTRY" ? 90 : 60,
    distanceMeters: 0,
    edgeType,
  };
}

function resealAuthority(value) {
  value.authority.authoritySha256 = sha(Buffer.from(canonical(without(value.authority, "authoritySha256"))));
  value.authorityBytes = Buffer.from(canonical(value.authority));
}

function without(value, key) {
  const { [key]: _ignored, ...rest } = value;
  return rest;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}
