import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalJson } from "./lib/manifest-validation.mjs";
import {
  assertServerRouteCoverageConsumed,
  isAuthorizedServerRouteCoverageGap,
  parseArgs,
  parseServerRouteCoverageProvenance,
  parseServerRouteCoverageEvidence,
} from "./validate-datapack.mjs";

// #866 PR-B: 인정 경로는 capital@1·213·30·456 상수가 아니라 pack의 비RIDE 간선에서 분모를 유도한다.
// D1: 환승(역 안·역 밖)은 양끝 TRANSFER cell이 닫혀야 한다.
// #873: 전국 authority·팩에는 ENTRY/EXIT 간선이 없고 coverage 필수 쌍은 환승뿐이다. 수도권 live chain(legacy)
// authority만 ENTRY/EXIT를 requiredCells []로 열거한다(PR-C(#866)에서 제거).
const SHAPES = [
  ["capital@1(legacy, ENTRY/EXIT 213 열거·환승 30)", { id: "capital", legacyAccessStations: 213, transfers: 30, outOfStation: 0 }],
  ["nationwide@1", { id: "nationwide", transfers: 6, outOfStation: 2 }],
  ["다른 pack id", { id: "fixture-national-network", transfers: 2, outOfStation: 2 }],
];
const NATIONWIDE = { id: "nationwide", transfers: 6, outOfStation: 2 };

for (const [label, shape] of SHAPES) {
  test(`server route coverage authority는 ${label}의 pack 유도 분모·1:1 결속·provenance를 한 번 소비한다`, () => {
    const report = authorityReport(shape);
    const bytes = Buffer.from(canonicalJson(report));
    assert.deepEqual(parseServerRouteCoverageEvidence(bytes), report);
    assert.throws(() => parseServerRouteCoverageEvidence(Buffer.concat([bytes, Buffer.from("\n")])), /canonical/);
    assert.throws(() => parseServerRouteCoverageEvidence(Buffer.from(canonicalJson({ ...report, authoritySha256: "b".repeat(64) }))), /hash/);
    const args = authorizationArgs(report, shape);
    assert.equal(isAuthorizedServerRouteCoverageGap(args), true);
    assert.equal(isAuthorizedServerRouteCoverageGap({ ...args, pack: { ...args.pack, version: "2" } }), false);
    assert.equal(isAuthorizedServerRouteCoverageGap({ ...args, pack: { ...args.pack, artifactKind: "fixture" } }), false);
    assert.equal(isAuthorizedServerRouteCoverageGap({ ...args, provenance: { ...args.provenance, candidateFixtureSha256: "0".repeat(64) } }), false);
    assert.equal(isAuthorizedServerRouteCoverageGap({ ...args, unverifiedAccessibilityCoverageEdges: ["edge-entry-000"] }), false);
    assert.equal(isAuthorizedServerRouteCoverageGap({ ...args, coverage: { ...args.coverage, transfer: { ...args.coverage.transfer, missingCount: args.coverage.transfer.missingCount - 1 } } }), false);
  });
}

test("authority에 없는 비RIDE 간선·누락 간선·시간·거리·끝점·상태 불일치는 인정하지 않는다", () => {
  const shape = NATIONWIDE;
  const report = authorityReport(shape);
  const args = authorizationArgs(report, shape);
  const rows = args.edgeRows;
  const index = rows.findIndex(({ edge_type: type }) => type === "OUT_OF_STATION_TRANSFER");
  const cases = [
    ["authority에 없는 ENTRY", [...rows, accessRow("ENTRY")]],
    ["authority에 없는 EXIT", [...rows, accessRow("EXIT")]],
    ["authority에 없는 역 밖 환승", [...rows, { ...rows[index], id: "edge-out-extra" }]],
    ["pack에서 빠진 간선", rows.filter((_, position) => position !== index)],
    ["중복 간선", [...rows, rows[index]]],
    ["시간 불일치", rows.map((row, position) => position === index ? { ...row, duration_seconds: row.duration_seconds + 1 } : row)],
    ["거리 불일치", rows.map((row, position) => position === index ? { ...row, distance_meters: row.distance_meters + 1 } : row)],
    ["끝점 불일치", rows.map((row, position) => position === index ? { ...row, to_node_id: "station-999:line-x" } : row)],
    ["type 불일치", rows.map((row, position) => position === index ? { ...row, edge_type: "IN_STATION_TRANSFER" } : row)],
    ["검증 상태 혼입", rows.map((row, position) => position === index ? { ...row, verification_status: "NOT_VERIFIED" } : row)],
  ];
  for (const [label, edgeRows] of cases) {
    assert.equal(isAuthorizedServerRouteCoverageGap({ ...args, edgeRows }), false, label);
  }
});

test("edgeCounts가 pack 간선 수와 다르면 재봉인해도 인정하지 않는다", () => {
  const shape = NATIONWIDE;
  const report = authorityReport(shape);
  const args = authorizationArgs(report, shape);
  // authority 자체는 edgeCounts와 실제 간선이 어긋나면 파싱에서 거부된다.
  const forged = structuredClone(report);
  forged.edgeCounts.IN_STATION_TRANSFER += 1;
  forged.edgeCounts.total += 1;
  reseal(forged);
  assert.throws(() => parseServerRouteCoverageEvidence(Buffer.from(canonicalJson(forged))), /denominator/);
  // pack에만 간선이 더 있는 경우(authority 분모 밖)도 인정하지 않는다.
  const extraTransfer = { ...args.edgeRows.find(({ edge_type: type }) => type === "IN_STATION_TRANSFER"), id: "edge-in-station-transfer-zzz" };
  assert.equal(isAuthorizedServerRouteCoverageGap({ ...args, edgeRows: [...args.edgeRows, extraTransfer] }), false);
});

test("coverage 필수 쌍이 authority 간선으로 뒷받침되지 않으면 인정하지 않는다", () => {
  const shape = NATIONWIDE;
  const report = authorityReport(shape);
  const args = authorizationArgs(report, shape);
  const transfer = new Set(args.requiredPairs.transfer);
  transfer.add("station-000:line-a->station-001:line-a");
  assert.equal(isAuthorizedServerRouteCoverageGap({
    ...args,
    requiredPairs: { ...args.requiredPairs, transfer },
    coverage: { ...args.coverage, transfer: { denominator: transfer.size, missingCount: transfer.size } },
  }), false);
  const { requiredPairs: _ignored, ...withoutPairs } = args;
  assert.equal(isAuthorizedServerRouteCoverageGap(withoutPairs), false);
});

test("authority edge/cell/candidate/provenance drift는 canonical hash를 다시 봉인해도 거부된다", () => {
  const shape = NATIONWIDE;
  const transferIndex = (value) => value.edges.findIndex(({ edgeType }) => edgeType === "OUT_OF_STATION_TRANSFER");
  for (const [label, mutate, pattern] of [
    ["edge denominator", (value) => { value.edges.pop(); }, /denominator|coverage/i],
    ["환승 끝점 UNKNOWN", (value) => { value.edges[transferIndex(value)].requiredCells[0].state = "UNKNOWN"; }, /cell|state/i],
    ["환승 cell 누락", (value) => { value.edges[transferIndex(value)].requiredCells.pop(); }, /required cell denominator/i],
    ["전국 ENTRY 간선 추가", (value) => { addAuthorityEdge(value, edge("ENTRY", 0)); }, /nationwide authority must not contain ENTRY\/EXIT edges/],
    ["전국 EXIT 간선 추가", (value) => { addAuthorityEdge(value, edge("EXIT", 0)); }, /nationwide authority must not contain ENTRY\/EXIT edges/],
    ["cell endpoint", (value) => { value.edges[transferIndex(value)].requiredCells[0].lineId = "seoul-4"; }, /cell endpoint/i],
    ["route hash", (value) => { value.edges[0].routeEdgeSha256 = "0".repeat(64); }, /route edge hash/i],
    ["candidate", (value) => { value.candidate.sourceSetSha256 = "0".repeat(64); }, /candidate|binding/i],
    ["build input", (value) => { value.buildInput.candidateFixtureSha256 = "0".repeat(64); }, /binding|provenance/i],
  ]) {
    const report = authorityReport(shape);
    mutate(report);
    reseal(report);
    if (label === "candidate" || label === "build input") {
      const parsed = parseServerRouteCoverageEvidence(Buffer.from(canonicalJson(report)));
      assert.equal(isAuthorizedServerRouteCoverageGap({
        ...authorizationArgs(parsed, shape),
        provenance: parseServerRouteCoverageProvenance(provenanceBytes(authorityReport(shape))),
      }), false, label);
    } else {
      assert.throws(() => parseServerRouteCoverageEvidence(Buffer.from(canonicalJson(report))), pattern, label);
    }
  }
});

test("#873 coverage는 환승 필수 쌍만 요구하고, 환승 coverage가 빠지거나 덜 미검증이면 인정하지 않는다", () => {
  const report = authorityReport(NATIONWIDE);
  const args = authorizationArgs(report, NATIONWIDE);
  assert.deepEqual(Object.keys(args.coverage), ["transfer"]);
  assert.equal(isAuthorizedServerRouteCoverageGap(args), true);
  const { transfer: _transfer, ...withoutTransferCoverage } = args.coverage;
  assert.equal(isAuthorizedServerRouteCoverageGap({ ...args, coverage: withoutTransferCoverage }), false);
  assert.equal(isAuthorizedServerRouteCoverageGap({ ...args, requiredPairs: {} }), false);
  assert.equal(isAuthorizedServerRouteCoverageGap({
    ...args,
    coverage: { transfer: { ...args.coverage.transfer, denominator: args.coverage.transfer.denominator + 1 } },
  }), false);
  // 환승 authority 간선이 빠지면 필수 쌍을 뒷받침하지 못한다.
  const withoutTransferEdges = args.edgeRows.filter(({ edge_type: type }) => type !== "IN_STATION_TRANSFER");
  assert.equal(isAuthorizedServerRouteCoverageGap({ ...args, edgeRows: withoutTransferEdges }), false);
});

test("legacy(수도권) authority는 ENTRY·EXIT가 둘 다 있거나 둘 다 없어야 한다(PR-C에서 제거)", () => {
  const legacy = { id: "capital", legacyAccessStations: 3, transfers: 2, outOfStation: 0 };
  assert.doesNotThrow(() => parseServerRouteCoverageEvidence(Buffer.from(canonicalJson(authorityReport(legacy)))));
  assert.doesNotThrow(() => parseServerRouteCoverageEvidence(Buffer.from(canonicalJson(authorityReport({ ...legacy, legacyAccessStations: 0 })))));
  for (const removed of ["ENTRY", "EXIT"]) {
    const report = authorityReport(legacy);
    report.edges = report.edges.filter(({ edgeType }) => edgeType !== removed);
    delete report.edgeCounts[removed];
    report.edgeCounts.total = report.edges.length;
    reseal(report);
    assert.throws(() => parseServerRouteCoverageEvidence(Buffer.from(canonicalJson(report))), /shape mismatch|denominator/, removed);
  }
});

test("server route coverage evidence는 provenance와 --require-production이 함께여야 하고 한 번만 소비된다", () => {
  const parsedArgs = parseArgs(["--manifest", "manifest.json", "--root", "out", "--require-production", "--server-route-coverage-evidence", "authority.json", "--server-route-coverage-provenance", "provenance.json"]);
  assert.equal(parsedArgs["server-route-coverage-evidence"], "authority.json");
  assert.throws(() => parseArgs(["--manifest", "manifest.json", "--root", "out", "--require-production", "--server-route-coverage-evidence", "authority.json"]), /evidence and provenance/);
  assert.doesNotThrow(() => assertServerRouteCoverageConsumed(null));
  assert.doesNotThrow(() => assertServerRouteCoverageConsumed({ consumptionCount: 1 }));
  assert.throws(() => assertServerRouteCoverageConsumed({ consumptionCount: 0 }), /not consumed exactly once/);
});

function authorizationArgs(report, shape) {
  const edgeRows = sqliteRows(report);
  const requiredPairs = requiredPairsFrom(report);
  return {
    pack: { id: shape.id, version: "1", artifactKind: "production" },
    report,
    provenance: parseServerRouteCoverageProvenance(provenanceBytes(report)),
    coverage: Object.fromEntries(Object.entries(requiredPairs)
      .map(([kind, pairs]) => [kind, { denominator: pairs.size, missingCount: pairs.size }])),
    requiredPairs,
    edgeRows,
    unverifiedAccessibilityCoverageEdges: [],
  };
}

// validate-datapack은 claimed scope의 역-노선에서 환승 필수 쌍만 만든다(#873). 여기서는 authority 간선과 같은 쌍을 쓴다.
function requiredPairsFrom(report) {
  const pairs = { transfer: new Set() };
  for (const edge of report.edges) {
    if (edge.edgeType === "IN_STATION_TRANSFER") pairs.transfer.add(`${edge.fromNodeId}->${edge.toNodeId}`);
  }
  return pairs;
}

function accessRow(edgeType) {
  const value = edge(edgeType, 999);
  return {
    id: value.edgeId,
    from_node_id: value.fromNodeId,
    to_node_id: value.toNodeId,
    edge_type: value.edgeType,
    duration_seconds: value.durationSeconds,
    distance_meters: value.distanceMeters,
    verification_status: "UNKNOWN",
    stair_access_state: "UNKNOWN",
    accessibility_status: "UNKNOWN",
  };
}

function addAuthorityEdge(report, value) {
  report.edges = [...report.edges, value].sort((left, right) => Buffer.compare(Buffer.from(left.edgeId), Buffer.from(right.edgeId)));
  report.edgeCounts = { ...report.edgeCounts, [value.edgeType]: (report.edgeCounts[value.edgeType] ?? 0) + 1, total: report.edges.length };
}

function authorityReport({ id, legacyAccessStations = 0, transfers, outOfStation }) {
  const candidate = {
    candidateId: id === "capital" ? "current-capital-candidate-20260816" : "nationwide-candidate-20261001-seq900",
    mappingContractVersion: "station-line-v1",
    materializerVersion: "1",
    sourceSetSha256: "a".repeat(64),
    stationSetSha256: "b".repeat(64),
  };
  const edges = [
    ...Array.from({ length: legacyAccessStations }, (_, index) => edge("ENTRY", index)),
    ...Array.from({ length: legacyAccessStations }, (_, index) => edge("EXIT", index)),
    ...Array.from({ length: transfers }, (_, index) => edge("IN_STATION_TRANSFER", index)),
    ...Array.from({ length: outOfStation }, (_, index) => edge("OUT_OF_STATION_TRANSFER", index)),
  ].sort((left, right) => Buffer.compare(Buffer.from(left.edgeId), Buffer.from(right.edgeId)));
  const edgeCounts = Object.fromEntries(Object.entries({
    ENTRY: legacyAccessStations, EXIT: legacyAccessStations, IN_STATION_TRANSFER: transfers, OUT_OF_STATION_TRANSFER: outOfStation,
  }).filter(([, count]) => count > 0));
  const payload = {
    schemaVersion: 1,
    artifactKind: "server-route-coverage-authority",
    candidate,
    buildInput: {
      buildSpecSha256: "c".repeat(64),
      sourceFixtureSha256: "d".repeat(64),
      candidateFixtureSha256: "e".repeat(64),
      stationLineInputSha256: "f".repeat(64),
      routeEdgeInputSha256: "1".repeat(64),
      transferMetricsSha256: sha(Buffer.from("fixture-transfer-metrics")),
      materializationDigest: "2".repeat(64),
      observedAt: "2026-08-16T00:00:00.000Z",
    },
    edgeCounts: { ...edgeCounts, total: edges.length },
    edges,
  };
  return JSON.parse(canonicalJson({ ...payload, authoritySha256: sha(canonicalJson(payload)) }));
}

function edge(edgeType, index) {
  const suffix = String(index).padStart(3, "0");
  const stationId = `station-${suffix}`;
  const nextStationId = `station-${String(index + 1).padStart(3, "0")}`;
  const nodes = {
    ENTRY: [stationId, `${stationId}:line-a`],
    EXIT: [`${stationId}:line-a`, stationId],
    IN_STATION_TRANSFER: [`${stationId}:line-a`, `${stationId}:line-b`],
    OUT_OF_STATION_TRANSFER: [`${stationId}:line-a`, `${nextStationId}:line-c`],
  }[edgeType];
  const transfer = edgeType.endsWith("_TRANSFER");
  const value = {
    edgeId: `edge-${edgeType.toLowerCase().replaceAll("_", "-")}-${suffix}`,
    edgeType,
    fromNodeId: nodes[0],
    toNodeId: nodes[1],
    durationSeconds: transfer ? 120 : 0,
    distanceMeters: transfer ? 150 : 0,
    // legacy(수도권) ENTRY/EXIT만 증거 cell 없이 열거한다(D1). 전국 authority에는 ENTRY/EXIT가 없다(#873).
    requiredCells: transfer
      ? [
        cell(...nodes[0].split(":"), "TRANSFER", "VERIFIED_PRESENT"),
        cell(...nodes[1].split(":"), "TRANSFER", index === 0 ? "NOT_APPLICABLE" : "VERIFIED_PRESENT"),
      ]
      : [],
  };
  return {
    ...value,
    routeEdgeSha256: sha(canonicalJson({
      edgeId: value.edgeId,
      edgeType: value.edgeType,
      fromNodeId: value.fromNodeId,
      toNodeId: value.toNodeId,
      durationSeconds: value.durationSeconds,
      distanceMeters: value.distanceMeters,
      servicePattern: "",
      serviceClass: "SUBWAY",
    })),
  };
}

function cell(stationId, lineId, domain, state) {
  return { stationId, lineId, domain, state, rowSha256: sha(`${stationId}:${lineId}:${domain}:${state}`) };
}

function provenanceBytes(report) {
  return Buffer.from(JSON.stringify({
    candidateBuild: {
      candidateId: report.candidate.candidateId,
      sourceSnapshotSetHash: report.candidate.sourceSetSha256,
      buildSpecSha256: report.buildInput.buildSpecSha256,
      sourceFixtureSha256: report.buildInput.sourceFixtureSha256,
      candidateFixtureSha256: report.buildInput.candidateFixtureSha256,
      serverRouteCoverageAuthoritySha256: report.authoritySha256,
    },
  }));
}

function sqliteRows(report) {
  return report.edges.map((edge) => ({
    id: edge.edgeId,
    from_node_id: edge.fromNodeId,
    to_node_id: edge.toNodeId,
    edge_type: edge.edgeType,
    duration_seconds: edge.durationSeconds,
    distance_meters: edge.distanceMeters,
    verification_status: "UNKNOWN",
    stair_access_state: "UNKNOWN",
    accessibility_status: "UNKNOWN",
  }));
}

function reseal(report) {
  report.authoritySha256 = sha(canonicalJson(without(report, "authoritySha256")));
}

function without(value, key) {
  const { [key]: _ignored, ...rest } = value;
  return rest;
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}
