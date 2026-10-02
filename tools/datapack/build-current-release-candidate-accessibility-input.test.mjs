import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { projectCandidateFixtureForAccessibilityAuthority } from "./build-datapack.mjs";
import {
  buildCurrentReleaseCandidateAccessibilityAuthority,
  canonicalCurrentReleaseCandidateAccessibilityAuthorityJson,
  canonicalCurrentReleaseCandidateFixtureJson,
  main,
  validateCurrentReleaseCandidateAccessibilityAuthorityReplay,
} from "./build-current-release-candidate-accessibility-input.mjs";
import {
  buildCurrentCapitalRouteEdgeInput,
  canonicalCurrentCapitalRouteEdgeInputJson,
} from "./build-current-capital-route-edge-input.mjs";
import { canonicalRideEdgeSetSha256 } from "./evaluate-route-accessibility-edges.mjs";
import {
  buildCurrentCapitalStationLineInput,
  canonicalCurrentCapitalStationLineInputJson,
} from "./build-current-capital-station-line-input.mjs";
import {
  buildCurrentCapitalStationLineInputFixture as fullCapitalFixture,
  FIXTURE_CAPTURED_AT,
  widenFixtureTransferMetricsBeyondCapitalDomain,
} from "./test-fixtures/current-capital-station-line-input.mjs";
import { buildCurrentCapitalAccessibilityRefreshOutputs } from "./refresh-current-capital-accessibility-full.mjs";
import { materializeStationLineAccessibility } from "./materialize-station-line-accessibility.mjs";
import {
  assertNationwideCandidateInputBytes,
  bindNationwideCandidatePreparation,
  main as verifyNationwideCandidateInputBinding,
} from "./nationwide-candidate-input-binding.mjs";
import {
  buildSyntheticNationwideReleaseCandidate,
  rebindSyntheticNationwideReleaseCandidate,
  setSyntheticNationwideEvidenceState,
  SYNTHETIC_NATIONWIDE_CAPTURED_AT,
  SYNTHETIC_NATIONWIDE_PATHS,
  syntheticNationwideAuthorityInput,
  syntheticNationwideTransferEndpoints,
  writeSyntheticNationwideRepository,
} from "./test-fixtures/synthetic-nationwide-release-candidate.mjs";
import { nextSyntheticCurrentStaticNetworkNow } from "./test-fixtures/current-public-route-map-successor.mjs";
import { prepareCurrentStaticNetworkProductionRepository } from "./test-fixtures/current-full-capital-production-artifact.mjs";

test("release authority selects the exact manifest pack without a Capital name pin", async () => {
  const input = await fullInput();
  const source = JSON.parse(input.sourceFixtureBytes);
  for (const fixture of [source, input.projectedFixture]) {
    fixture.manifest.activePack.id = "fixture-national-network";
    fixture.packs[0].id = fixture.manifest.activePack.id;
  }
  input.sourceFixtureBytes = Buffer.from(canonical(source));
  const result = buildCurrentReleaseCandidateAccessibilityAuthority(input);
  assert.equal(result.candidateFixture.packs[0].id, source.manifest.activePack.id);
  assert.equal(result.authority.buildInput.sourceFixtureSha256, sha256(input.sourceFixtureBytes));
  const drift = structuredClone(input.projectedFixture);
  drift.manifest.activePack.id = "different-network";
  drift.packs[0].id = drift.manifest.activePack.id;
  assert.throws(() => buildCurrentReleaseCandidateAccessibilityAuthority({ ...input, projectedFixture: drift }), /active pack identity mismatch/);
  const wrongVersion = structuredClone(input.projectedFixture);
  wrongVersion.packs[0].version = "different-version";
  assert.throws(() => canonicalCurrentReleaseCandidateFixtureJson(wrongVersion), /active pack mismatch/);
});

test("full-capital authority는 입력-derived edge와 materialization exact sets에 결속한다", async () => {
  const input = await fullInput();
  const before = structuredClone(input.projectedFixture);
  const result = buildCurrentReleaseCandidateAccessibilityAuthority(input);

  const sourceRides = JSON.parse(input.sourceFixtureBytes).packs[0].networkEdges;
  const projectedRides = input.projectedFixture.packs[0].networkEdges;
  const routeCounts = edgeCounts(input.route.routeEdges);
  const authorityEdges = input.route.routeEdges.filter(({ edgeType }) => edgeType !== "RIDE");
  assert.equal(sourceRides.length, routeCounts.RIDE);
  assert.equal(projectedRides.length, routeCounts.RIDE);
  assert.equal(result.candidateFixture.packs[0].networkEdges.length, input.route.routeEdges.length);
  assert.deepEqual(edgeCounts(result.candidateFixture.packs[0].networkEdges), routeCounts);
  assert.deepEqual(result.authority.edgeCounts, { ...edgeCounts(authorityEdges), total: authorityEdges.length });
  assert.equal(result.authority.edges.length, authorityEdges.length);
  assert.equal(result.authority.edges.filter(({ requiredCells }) => requiredCells.length === 2).length,
    authorityEdges.filter(({ edgeType }) => edgeType === "IN_STATION_TRANSFER").length);
  assert.match(result.authority.buildInput.buildSpecSha256, /^[a-f0-9]{64}$/u);
  assert.match(result.authority.buildInput.sourceFixtureSha256, /^[a-f0-9]{64}$/u);
  assert.match(result.authority.buildInput.candidateFixtureSha256, /^[a-f0-9]{64}$/u);
  assert.equal(result.authority.buildInput.observedAt, FIXTURE_CAPTURED_AT);
  assert.equal(
    result.authority.buildInput.candidateFixtureSha256,
    sha256(Buffer.from(canonicalCurrentReleaseCandidateFixtureJson(result.candidateFixture))),
  );
  assert.equal(
    result.authority.authoritySha256,
    sha256(Buffer.from(canonicalCurrentReleaseCandidateAccessibilityAuthorityJson(result.authority, { payloadOnly: true }))),
  );
  assert.deepEqual(input.projectedFixture, before);
});

test("합성 current public successor는 input-derived metadata, route, authority를 완성한다", async (t) => {
  const sourceRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
  const temp = await mkdtemp(path.join(tmpdir(), "public-route-map-authority-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const repositoryRoot = path.join(temp, "repository");
  await prepareCurrentStaticNetworkProductionRepository(sourceRoot, repositoryRoot, {
    now: await nextSyntheticCurrentStaticNetworkNow(sourceRoot),
  });
  const buildSpecBytes = await readFile(
    path.join(repositoryRoot, "tools/datapack/release/candidate-build-spec.json"),
  );
  const buildSpec = JSON.parse(buildSpecBytes);
  const sourceFixtureBytes = await readFile(
    path.join(repositoryRoot, buildSpec.fixturePath),
  );
  const sourceFixture = JSON.parse(sourceFixtureBytes);
  const projectedFixture = await projectCandidateFixtureForAccessibilityAuthority({
    buildSpec,
    sourceFixture,
    repositoryRoot,
  });
  const [stationOutput, routeOutput] = await buildCurrentCapitalAccessibilityRefreshOutputs({
    repositoryRoot,
  });
  const stationLineInputBytes = stationOutput.bytes;
  const routeBytes = routeOutput.bytes;
  const transferMetricsBytes = await readFile(path.join(
    repositoryRoot,
    "tools/datapack/release/current-transfer-topology-metrics.json",
  ));
  const stationLineInput = JSON.parse(stationLineInputBytes);
  const route = JSON.parse(routeBytes);
  assert.equal(
    stationLineInput.candidate.sourceSetSha256,
    buildSpec.sourceSnapshotSetHash,
  );
  assert.equal(route.candidate.sourceSetSha256, stationLineInput.candidate.sourceSetSha256);
  assert.equal(
    stationLineInputBytes.toString("utf8"),
    canonicalCurrentCapitalStationLineInputJson(stationLineInput),
  );
  assert.equal(
    routeBytes.toString("utf8"),
    canonicalCurrentCapitalRouteEdgeInputJson(route),
  );
  assert.deepEqual(Object.keys(edgeCounts(sourceFixture.packs[0].networkEdges)), ["RIDE"]);
  assert.deepEqual(Object.keys(edgeCounts(projectedFixture.packs[0].networkEdges)), ["RIDE"]);
  const result = buildCurrentReleaseCandidateAccessibilityAuthority({
    buildSpec,
    buildSpecBytes,
    projectedFixture,
    route,
    routeBytes,
    sourceFixtureBytes,
    stationLineInput,
    stationLineInputBytes,
    transferMetrics: JSON.parse(transferMetricsBytes),
    transferMetricsBytes,
  });

  assert.ok(route.stationLines.length > 0);
  assert.equal(result.authority.edges.length, route.routeEdges.filter(({ edgeType }) => edgeType !== "RIDE").length);
  const authorityCells = result.authority.edges.flatMap(({ requiredCells }) => requiredCells);
  const authorityCellKeys = new Set(authorityCells.map(({ stationId, lineId, domain }) =>
    `${stationId}:${lineId}:${domain}`));
  const materialization = materializeStationLineAccessibility({
    ...stationLineInput,
    observedAt: result.authority.buildInput.observedAt,
  });
  // D1(#866): ENTRY/EXIT는 authority 증거 요구에서 빠진다. 차단된 FACILITY/EXIT row가 있어도 authority cell이 되지 않는다.
  assert.ok(materialization.rows.some(({ state }) => state === "UNVERIFIED_EVIDENCE_BLOCKED"));
  assert.ok(authorityCells.length > 0);
  assert.ok(authorityCells.every(({ domain }) => domain === "TRANSFER"));
  assert.equal(authorityCellKeys.size, new Set(result.authority.edges
    .filter(({ edgeType }) => edgeType.endsWith("_TRANSFER"))
    .flatMap(({ fromNodeId, toNodeId }) => [`${fromNodeId}:TRANSFER`, `${toNodeId}:TRANSFER`])).size);
  assert.ok(result.authority.edges
    .filter(({ edgeType }) => edgeType === "ENTRY" || edgeType === "EXIT")
    .every(({ requiredCells }) => requiredCells.length === 0));
  assert.equal(result.candidateFixture.packs[0].networkEdges.length, route.routeEdges.length);
});

test("unresolved·stale·candidate·route·projected RIDE drift는 output 전에 fail-closed다", async () => {
  const cases = [
    ["unresolved transfer endpoint", (value) => {
      const transfer = value.route.routeEdges.find(({ edgeType }) => edgeType === "IN_STATION_TRANSFER");
      const [stationId, lineId] = transfer.fromNodeId.split(":");
      value.stationLineInput.evidenceRows = value.stationLineInput.evidenceRows
        .filter((row) => !(row.stationId === stationId && row.lineId === lineId && row.domain === "TRANSFER"));
    }, /transfer endpoint accessibility evidence is unresolved/],
    ["stale", (value) => { value.stationLineInput.evidenceRows[0].freshUntil = value.stationLineInput.evidenceRows[0].capturedAt; }, /fresh|stale/i],
    ["candidate", (value) => { value.route.candidate.sourceSetSha256 = "0".repeat(64); }, /candidate/i],
    ["route hash", (value) => { value.route.routeEdges[0].edgeSha256 = "0".repeat(64); }, /hash/i],
    ["route RIDE empty ID", (value) => {
      const ride = value.route.routeEdges.find(({ edgeType }) => edgeType === "RIDE");
      assert.ok(ride, "current route input requires one RIDE edge");
      ride.edgeId = "";
      rebindRouteEdge(value.route, ride);
      value.route.candidate.topologySha256 = canonicalRideEdgeSetSha256(
        value.route.routeEdges.filter(({ edgeType }) => edgeType === "RIDE"),
      );
    }, /route edge identifier mismatch/i],
    ["route metadata missing", (value) => { value.route.stationLines.pop(); }, /route station-line/i],
    ["route metadata operator", (value) => { value.route.stationLines[0].operatorId = "drift"; }, /route station-line/i],
    ["projected metadata missing", (value) => { value.projectedFixture.packs[0].stationLines.pop(); }, /route station-line/i],
    ["source RIDE missing", (value) => {
      const source = JSON.parse(value.sourceFixtureBytes);
      source.packs[0].networkEdges.pop();
      value.sourceFixtureBytes = Buffer.from(canonical(source));
    }, /source fixture RIDE denominator/i],
    ["source RIDE extra", (value) => {
      const source = JSON.parse(value.sourceFixtureBytes);
      source.packs[0].networkEdges.push(structuredClone(source.packs[0].networkEdges[0]));
      value.sourceFixtureBytes = Buffer.from(canonical(source));
    }, /source fixture RIDE denominator/i],
    ["source non-RIDE", (value) => {
      const source = JSON.parse(value.sourceFixtureBytes);
      source.packs[0].networkEdges.push(nonRideEdge("extra", "WALKWAY"));
      value.sourceFixtureBytes = Buffer.from(canonical(source));
    }, /source fixture must be RIDE-only/i],
    ["source RIDE field drift", (value) => {
      const source = JSON.parse(value.sourceFixtureBytes);
      source.packs[0].networkEdges[0].durationSeconds += 1;
      value.sourceFixtureBytes = Buffer.from(canonical(source));
    }, /source fixture RIDE mismatch/i],
    ["source RIDE empty ID", (value) => {
      const source = JSON.parse(value.sourceFixtureBytes);
      source.packs[0].networkEdges[0].id = "";
      value.sourceFixtureBytes = Buffer.from(canonical(source));
    }, /source fixture RIDE identifier mismatch/i],
    ["projected RIDE missing", (value) => { value.projectedFixture.packs[0].networkEdges.pop(); }, /projected fixture RIDE denominator/i],
    ["projected extra non-RIDE", (value) => { value.projectedFixture.packs[0].networkEdges.push(nonRideEdge("extra", "WALKWAY")); }, /projected fixture must be RIDE-only/i],
    ["projected RIDE field drift", (value) => {
      value.projectedFixture.packs[0].networkEdges[0].durationSeconds += 1;
    }, /projected fixture RIDE mismatch/i],
    ["non-RIDE service-pattern endpoint", (value) => {
      // Current-only authority: non-RIDE endpoints are station-line nodes, never service-pattern nodes.
      const edge = value.route.routeEdges.find(({ edgeType }) => edgeType !== "RIDE");
      assert.ok(edge, "current route input requires one non-RIDE edge");
      edge.toNodeId = `${edge.toNodeId}:LOCAL`;
      edge.edgeSha256 = sha256(Buffer.from(canonical({
        edgeId: edge.edgeId,
        edgeType: edge.edgeType,
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        durationSeconds: edge.durationSeconds,
        distanceMeters: edge.distanceMeters,
        servicePattern: edge.servicePattern,
        serviceClass: edge.serviceClass,
      })));
    }, /endpoint mismatch|station-line/i],
  ];
  for (const [label, mutate, pattern] of cases) {
    const value = await fullInput();
    mutate(value);
    rebindBytes(value);
    assert.throws(() => buildCurrentReleaseCandidateAccessibilityAuthority(value), pattern, label);
  }
});

test("authority는 authenticated metric의 complete transfer-edge set을 요구한다", async () => {
  const input = await fullInput();
  const transferIndex = input.route.routeEdges
    .findIndex(({ edgeType }) => edgeType === "IN_STATION_TRANSFER");
  assert.notEqual(transferIndex, -1);
  input.route.routeEdges.splice(transferIndex, 1);
  input.routeBytes = Buffer.from(canonical(input.route));

  assert.throws(
    () => buildCurrentReleaseCandidateAccessibilityAuthority(input),
    /transfer edge set mismatch/,
  );
});

// #872 S2(#866에서 전국 경로로 대체 후 삭제): 수도권 후보의 transfer 대조는 route-edge input과 같은 공용 함수로
// 분모 안에 온전히 들어가는 쌍만 대조한다. 그 쌍의 edge가 빠지면 계속 거부한다.
test("authority는 분모 밖 쌍이 있는 지표에서도 분모 안 쌍의 complete transfer-edge set을 요구한다", async () => {
  const input = await fullInput({ widen: true });
  assert.doesNotThrow(() => buildCurrentReleaseCandidateAccessibilityAuthority(input));
  const transferIndex = input.route.routeEdges.findIndex(({ edgeType }) => edgeType === "IN_STATION_TRANSFER");
  assert.notEqual(transferIndex, -1);
  input.route.routeEdges.splice(transferIndex, 1);
  input.routeBytes = Buffer.from(canonical(input.route));
  assert.throws(() => buildCurrentReleaseCandidateAccessibilityAuthority(input), /transfer edge set mismatch/);
});

test("authority validator는 actual edge type denominator를 재집계한다", async () => {
  const input = await fullInput();
  const { authority } = buildCurrentReleaseCandidateAccessibilityAuthority(input);
  const forged = structuredClone(authority);
  const entry = forged.edges.find(({ edgeType }) => edgeType === "ENTRY");
  const exit = forged.edges.find(({ edgeType }) => edgeType === "EXIT");
  Object.assign(exit, {
    edgeType: "ENTRY",
    fromNodeId: entry.fromNodeId,
    toNodeId: entry.toNodeId,
    durationSeconds: entry.durationSeconds,
    distanceMeters: entry.distanceMeters,
    requiredCells: structuredClone(entry.requiredCells),
  });
  exit.routeEdgeSha256 = sha256(Buffer.from(canonical({
    edgeId: exit.edgeId,
    edgeType: exit.edgeType,
    fromNodeId: exit.fromNodeId,
    toNodeId: exit.toNodeId,
    durationSeconds: exit.durationSeconds,
    distanceMeters: exit.distanceMeters,
    servicePattern: "",
    serviceClass: "SUBWAY",
  })));
  const { authoritySha256: _ignored, ...payload } = forged;
  forged.authoritySha256 = sha256(Buffer.from(canonical(payload)));

  assert.throws(
    () => canonicalCurrentReleaseCandidateAccessibilityAuthorityJson(forged),
    /authority edge denominator mismatch/,
  );
});

test("consumer replay는 재봉인한 authority의 required cell·route projection drift를 거부한다", async () => {
  const input = await fullInput();
  const { authority } = buildCurrentReleaseCandidateAccessibilityAuthority(input);
  assert.doesNotThrow(() => validateCurrentReleaseCandidateAccessibilityAuthorityReplay({
    authority,
    projectedFixture: input.projectedFixture,
    stationLineInputBytes: input.stationLineInputBytes,
    routeEdgeInputBytes: input.routeBytes,
    transferMetricsBytes: input.transferMetricsBytes,
  }));

  const requiredCellDrift = structuredClone(authority);
  requiredCellDrift.edges.find(({ edgeType }) => edgeType === "IN_STATION_TRANSFER").requiredCells[0].state = "VERIFIED_ABSENT";
  resealAuthority(requiredCellDrift);
  assert.throws(
    () => validateCurrentReleaseCandidateAccessibilityAuthorityReplay({
      authority: requiredCellDrift,
      projectedFixture: input.projectedFixture,
      stationLineInputBytes: input.stationLineInputBytes,
      routeEdgeInputBytes: input.routeBytes,
      transferMetricsBytes: input.transferMetricsBytes,
    }),
    /authority replay mismatch/,
  );

  const projectionDrift = structuredClone(authority);
  const edge = projectionDrift.edges[0];
  edge.durationSeconds += 1;
  edge.routeEdgeSha256 = sha256(Buffer.from(canonical({
    edgeId: edge.edgeId,
    edgeType: edge.edgeType,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    durationSeconds: edge.durationSeconds,
    distanceMeters: edge.distanceMeters,
    servicePattern: "",
    serviceClass: "SUBWAY",
  })));
  resealAuthority(projectionDrift);
  assert.throws(
    () => validateCurrentReleaseCandidateAccessibilityAuthorityReplay({
      authority: projectionDrift,
      projectedFixture: input.projectedFixture,
      stationLineInputBytes: input.stationLineInputBytes,
      routeEdgeInputBytes: input.routeBytes,
      transferMetricsBytes: input.transferMetricsBytes,
    }),
    /authority replay mismatch/,
  );

  const rideDriftRoute = structuredClone(input.route);
  const ride = rideDriftRoute.routeEdges.find(({ edgeType }) => edgeType === "RIDE");
  ride.durationSeconds += 1;
  ride.edgeSha256 = sha256(Buffer.from(canonical({
    edgeId: ride.edgeId,
    edgeType: ride.edgeType,
    fromNodeId: ride.fromNodeId,
    toNodeId: ride.toNodeId,
    durationSeconds: ride.durationSeconds,
    distanceMeters: ride.distanceMeters,
    servicePattern: ride.servicePattern,
    serviceClass: ride.serviceClass,
  })));
  rideDriftRoute.candidate.topologySha256 = canonicalRideEdgeSetSha256(
    rideDriftRoute.routeEdges.filter(({ edgeType }) => edgeType === "RIDE"),
  );
  const rideDriftBytes = Buffer.from(canonical(rideDriftRoute));
  const rideDriftAuthority = structuredClone(authority);
  rideDriftAuthority.buildInput.routeEdgeInputSha256 = sha256(rideDriftBytes);
  resealAuthority(rideDriftAuthority);
  assert.throws(
    () => validateCurrentReleaseCandidateAccessibilityAuthorityReplay({
      authority: rideDriftAuthority,
      projectedFixture: input.projectedFixture,
      stationLineInputBytes: input.stationLineInputBytes,
      routeEdgeInputBytes: rideDriftBytes,
      transferMetricsBytes: input.transferMetricsBytes,
    }),
    /projected fixture RIDE mismatch/,
  );
});

test("전국 authority(D1)는 ENTRY/EXIT에 증거 cell을 요구하지 않고 환승 간선 양끝 TRANSFER cell만 요구한다", () => {
  const value = buildSyntheticNationwideReleaseCandidate();
  const input = syntheticNationwideAuthorityInput(value);
  const materialization = materializeStationLineAccessibility({
    ...value.stationLineInput,
    observedAt: SYNTHETIC_NATIONWIDE_CAPTURED_AT,
  });
  // 전국 실데이터처럼 EXIT 전체·FACILITY 일부가 UNKNOWN이어도 authority는 만들어진다.
  assert.ok(materialization.stateSummary.UNKNOWN > 0);
  const result = buildCurrentReleaseCandidateAccessibilityAuthority(input);

  assert.deepEqual(result.authority.edgeCounts, {
    ENTRY: 5, EXIT: 5, IN_STATION_TRANSFER: 2, OUT_OF_STATION_TRANSFER: 2, total: 14,
  });
  for (const edge of result.authority.edges) {
    if (edge.edgeType === "ENTRY" || edge.edgeType === "EXIT") {
      assert.deepEqual(edge.requiredCells, [], edge.edgeId);
      continue;
    }
    const [from, to] = [edge.fromNodeId, edge.toNodeId].map((node) => node.split(":"));
    assert.deepEqual(edge.requiredCells.map(({ stationId, lineId, domain, state }) => [stationId, lineId, domain, state]), [
      [from[0], from[1], "TRANSFER", "VERIFIED_PRESENT"],
      [to[0], to[1], "TRANSFER", "VERIFIED_PRESENT"],
    ], edge.edgeId);
  }
  // 간선 자체(ENTRY/EXIT 포함)는 #873 전까지 팩에 남는다.
  assert.deepEqual(edgeCounts(result.candidateFixture.packs[0].networkEdges), edgeCounts(value.route.routeEdges));
  assert.doesNotThrow(() => validateCurrentReleaseCandidateAccessibilityAuthorityReplay({
    authority: result.authority,
    projectedFixture: value.projectedFixture,
    stationLineInputBytes: value.stationLineInputBytes,
    routeEdgeInputBytes: value.routeBytes,
    transferMetricsBytes: value.transferMetricsBytes,
  }));
  assert.equal(
    canonicalCurrentReleaseCandidateAccessibilityAuthorityJson(result.authority),
    canonical(result.authority),
  );
});

test("환승 끝점 TRANSFER cell이 UNKNOWN·MISSING이면 역 안·역 밖 환승 모두 명시적으로 실패한다", () => {
  for (const endpoint of syntheticNationwideTransferEndpoints()) {
    const value = setSyntheticNationwideEvidenceState(
      buildSyntheticNationwideReleaseCandidate(), endpoint, "TRANSFER", "UNKNOWN",
    );
    assert.throws(
      () => buildCurrentReleaseCandidateAccessibilityAuthority(syntheticNationwideAuthorityInput(value)),
      (error) => /transfer endpoint accessibility evidence is unresolved/.test(error.message)
        && error.message.includes(`${endpoint} UNKNOWN`),
      endpoint,
    );
  }
  const missing = buildSyntheticNationwideReleaseCandidate();
  missing.stationLineInput.evidenceRows = missing.stationLineInput.evidenceRows
    .filter((row) => !(row.stationId === "station-c" && row.domain === "TRANSFER"));
  const rebound = rebindSyntheticNationwideReleaseCandidate(missing);
  assert.throws(
    () => buildCurrentReleaseCandidateAccessibilityAuthority(syntheticNationwideAuthorityInput(rebound)),
    /transfer endpoint accessibility evidence is unresolved: 2 edges .*station-c:line-3 MISSING/,
  );
  // 환승이 없는 역의 TRANSFER UNKNOWN과 ENTRY/EXIT 쪽 UNKNOWN은 차단 조건이 아니다(D1).
  const notTransferEndpoint = setSyntheticNationwideEvidenceState(
    buildSyntheticNationwideReleaseCandidate(), "station-d:line-2", "TRANSFER", "UNKNOWN",
  );
  assert.doesNotThrow(() => buildCurrentReleaseCandidateAccessibilityAuthority(
    syntheticNationwideAuthorityInput(notTransferEndpoint),
  ));
});

test("역 안 환승은 같은 역 다른 노선, 역 밖 환승은 다른 역 끝점만 허용한다", () => {
  for (const [label, edgeId, toNodeId] of [
    ["역 안 환승이 다른 역", "transfer-station-a-line-1-line-2", "station-b:line-1"],
    ["역 밖 환승이 같은 역", "out-link-b1-c3", "station-b:line-1"],
  ]) {
    const value = buildSyntheticNationwideReleaseCandidate();
    const edge = value.route.routeEdges.find((candidate) => candidate.edgeId === edgeId);
    edge.toNodeId = toNodeId;
    rebindRouteEdge(value.route, edge);
    const rebound = rebindSyntheticNationwideReleaseCandidate(value);
    assert.throws(
      () => buildCurrentReleaseCandidateAccessibilityAuthority(syntheticNationwideAuthorityInput(rebound)),
      /transfer edge endpoint mismatch/,
      label,
    );
  }
});

test("authority validator는 재봉인해도 ENTRY/EXIT cell 추가·환승 cell 누락·닫히지 않은 cell을 거부한다", () => {
  const { authority } = buildCurrentReleaseCandidateAccessibilityAuthority(
    syntheticNationwideAuthorityInput(buildSyntheticNationwideReleaseCandidate()),
  );
  const transferIndex = authority.edges.findIndex(({ edgeType }) => edgeType === "OUT_OF_STATION_TRANSFER");
  const entryIndex = authority.edges.findIndex(({ edgeType }) => edgeType === "ENTRY");
  for (const [label, mutate, pattern] of [
    ["ENTRY cell 추가", (value) => {
      value.edges[entryIndex].requiredCells = [structuredClone(value.edges[transferIndex].requiredCells[0])];
    }, /required cell denominator mismatch/],
    ["환승 cell 누락", (value) => { value.edges[transferIndex].requiredCells.pop(); }, /required cell denominator mismatch/],
    ["환승 cell UNKNOWN", (value) => { value.edges[transferIndex].requiredCells[0].state = "UNKNOWN"; }, /required cell mismatch/],
    ["환승 cell domain", (value) => { value.edges[transferIndex].requiredCells[0].domain = "EXIT"; }, /required cell endpoint mismatch/],
    ["edgeCounts 키 누락", (value) => { delete value.edgeCounts.OUT_OF_STATION_TRANSFER; }, /edge denominator mismatch/],
  ]) {
    const forged = structuredClone(authority);
    mutate(forged);
    resealAuthority(forged);
    assert.throws(() => canonicalCurrentReleaseCandidateAccessibilityAuthorityJson(forged), pattern, label);
  }
});

test("candidate override freshness는 D1 authority의 ENTRY/EXIT UNKNOWN materialization을 받는다", async () => {
  const value = buildSyntheticNationwideReleaseCandidate();
  const { authority } = buildCurrentReleaseCandidateAccessibilityAuthority(syntheticNationwideAuthorityInput(value));
  const { candidateOverrideAccessibilityFreshUntil } = await import("./build-datapack.mjs");
  assert.equal(candidateOverrideAccessibilityFreshUntil({
    authority,
    stationLineInputBytes: value.stationLineInputBytes,
    routeEdgeInputBytes: value.routeBytes,
    validationNow: new Date(SYNTHETIC_NATIONWIDE_CAPTURED_AT),
    isNationwide: true,
  }), "2026-10-08T00:00:00.000Z");
  assert.throws(() => candidateOverrideAccessibilityFreshUntil({
    authority: { ...authority, buildInput: { ...authority.buildInput, materializationDigest: "0".repeat(64) } },
    stationLineInputBytes: value.stationLineInputBytes,
    validationNow: new Date(SYNTHETIC_NATIONWIDE_CAPTURED_AT),
    isNationwide: true,
  }), /station-line input identity mismatch/);
});

test("CLI는 nationwide-candidate-preparation이 sha로 결속한 전국 입력을 바이트 그대로 출력한다", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "nationwide-rc-input-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const value = buildSyntheticNationwideReleaseCandidate();
  await writeSyntheticNationwideRepository(directory, value);
  const files = outputFiles(directory, "bound");
  const result = await main(cliArgs(files), {
    repositoryRoot: directory,
    projectFixtureImpl: async () => structuredClone(value.projectedFixture),
  });
  const [stationBytes, routeBytes, fixtureBytes, authorityBytes] = await Promise.all([
    readFile(files.stationOutput), readFile(files.routeOutput), readFile(files.fixtureOutput), readFile(files.authorityOutput),
  ]);
  assert.ok(stationBytes.equals(value.stationLineInputBytes));
  assert.ok(routeBytes.equals(value.routeBytes));
  assert.equal(sha256(stationBytes), value.preparation.stationLineInput.sha256);
  assert.equal(sha256(routeBytes), value.preparation.routeEdgeInput.sha256);
  assert.equal(result.authority.buildInput.stationLineInputSha256, value.preparation.stationLineInput.sha256);
  assert.equal(result.authority.buildInput.routeEdgeInputSha256, value.preparation.routeEdgeInput.sha256);
  assert.equal(result.authority.buildInput.transferMetricsSha256, sha256(value.transferMetricsBytes));
  assert.equal(fixtureBytes.toString("utf8"), canonicalCurrentReleaseCandidateFixtureJson(JSON.parse(fixtureBytes)));
  assert.equal(authorityBytes.toString("utf8"), canonicalCurrentReleaseCandidateAccessibilityAuthorityJson(JSON.parse(authorityBytes)));
  for (const file of Object.values(files).filter((target) => path.isAbsolute(target))) {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
  await assert.rejects(main(cliArgs({ ...outputFiles(directory, "collision"), authorityOutput: files.authorityOutput }), {
    repositoryRoot: directory,
    projectFixtureImpl: async () => structuredClone(value.projectedFixture),
  }), /output must be absent/);
  await assertNoOutputs(outputFiles(directory, "collision"), ["authorityOutput"]);
  const sameOutput = path.join(directory, "same-output.json");
  await assert.rejects(main(cliArgs({ ...outputFiles(directory, "same"), stationOutput: sameOutput, authorityOutput: sameOutput }), {
    repositoryRoot: directory,
    projectFixtureImpl: async () => structuredClone(value.projectedFixture),
  }), /output paths must be distinct/);
  await assertFileAbsent(sameOutput);
});

test("CLI는 preparation sha·후보 id·경로 불일치와 preparation 부재를 출력 전에 거부한다", async (context) => {
  const cases = [
    ["route-edge 입력 sha 불일치", async (directory, value) => {
      const route = structuredClone(value.route);
      route.routeEdges = route.routeEdges.filter(({ edgeId }) => edgeId !== "exit-station-d-line-2");
      await writeFile(path.join(directory, SYNTHETIC_NATIONWIDE_PATHS.routeEdgeInput), canonical(route));
    }, /route-edge input sha256 mismatch/],
    ["station-line 입력 sha 불일치", async (directory, value) => {
      await writeFile(path.join(directory, SYNTHETIC_NATIONWIDE_PATHS.stationLineInput), `${canonical(value.stationLineInput)}\n`);
    }, /station-line input sha256 mismatch/],
    ["preparation 후보 id 불일치", async (directory, value) => {
      const preparation = structuredClone(value.preparation);
      preparation.releaseIdentity.candidateId = "nationwide-candidate-20261001-seq901";
      await writeFile(path.join(directory, SYNTHETIC_NATIONWIDE_PATHS.preparation), JSON.stringify(preparation));
    }, /candidate preparation identity mismatch/],
    ["preparation authority 후보 id 불일치", async (directory, value) => {
      const preparation = structuredClone(value.preparation);
      preparation.authority.candidateId = "nationwide-candidate-20261001-seq901";
      await writeFile(path.join(directory, SYNTHETIC_NATIONWIDE_PATHS.preparation), JSON.stringify(preparation));
    }, /candidate preparation identity mismatch/],
    ["preparation fixture 경로 불일치", async (directory, value) => {
      const preparation = structuredClone(value.preparation);
      preparation.materialization.fixturePath = "tools/datapack/release/capital-production-canonical-pack.json";
      await writeFile(path.join(directory, SYNTHETIC_NATIONWIDE_PATHS.preparation), JSON.stringify(preparation));
    }, /candidate preparation identity mismatch/],
    ["preparation 입력 경로 탈출", async (directory, value) => {
      const preparation = structuredClone(value.preparation);
      preparation.routeEdgeInput.path = "../nationwide-route-edge-input.json";
      await writeFile(path.join(directory, SYNTHETIC_NATIONWIDE_PATHS.preparation), JSON.stringify(preparation));
    }, /route-edge input path/],
    ["입력 후보 id 불일치", async (directory, value) => {
      const station = structuredClone(value.stationLineInput);
      station.candidate.candidateId = "nationwide-candidate-20261001-seq901";
      const bytes = canonical(station);
      await writeFile(path.join(directory, SYNTHETIC_NATIONWIDE_PATHS.stationLineInput), bytes);
      const preparation = structuredClone(value.preparation);
      preparation.stationLineInput.sha256 = sha256(bytes);
      await writeFile(path.join(directory, SYNTHETIC_NATIONWIDE_PATHS.preparation), JSON.stringify(preparation));
    }, /station-line input candidate identity mismatch/],
    ["preparation 부재", async (directory) => {
      await rm(path.join(directory, SYNTHETIC_NATIONWIDE_PATHS.preparation));
    }, /ENOENT|candidate preparation/],
  ];
  for (const [label, mutate, pattern] of cases) {
    const directory = await mkdtemp(path.join(tmpdir(), "nationwide-rc-reject-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const value = buildSyntheticNationwideReleaseCandidate();
    await writeSyntheticNationwideRepository(directory, value);
    await mutate(directory, value);
    const files = outputFiles(directory, "rejected");
    await assert.rejects(main(cliArgs(files), {
      repositoryRoot: directory,
      projectFixtureImpl: async () => structuredClone(value.projectedFixture),
    }), pattern, label);
    await assertNoOutputs(files);
  }
});

test("CLI는 환승 끝점 UNKNOWN이면 출력 0개로 명시적으로 실패한다", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "nationwide-rc-unknown-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const value = setSyntheticNationwideEvidenceState(
    buildSyntheticNationwideReleaseCandidate(), "station-a:line-2", "TRANSFER", "UNKNOWN",
  );
  await writeSyntheticNationwideRepository(directory, value);
  const files = outputFiles(directory, "unknown");
  await assert.rejects(main(cliArgs(files), {
    repositoryRoot: directory,
    projectFixtureImpl: async () => structuredClone(value.projectedFixture),
  }), /transfer endpoint accessibility evidence is unresolved/);
  await assertNoOutputs(files);
});

test("CLI는 build spec/fixture path 경계를 fail closed하고 출력 전에 중단한다", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "candidate-input-path-boundary-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const value = buildSyntheticNationwideReleaseCandidate();
  await writeSyntheticNationwideRepository(directory, value);
  const files = outputFiles(directory, "base");
  const noOutput = async (suffix, changes) => {
    const candidate = { ...outputFiles(directory, suffix), ...changes };
    await assert.rejects(main(cliArgs(candidate), {
      repositoryRoot: directory,
      projectFixtureImpl: async () => structuredClone(value.projectedFixture),
    }), /path|mismatch|regular file/i, suffix);
    await assertNoOutputs(candidate);
  };
  await noOutput("absolute", { buildSpec: path.join(directory, files.buildSpec) });
  await noOutput("parent", { buildSpec: "../tools/datapack/release/candidate-build-spec.json" });
  await mkdir(path.join(directory, "release"), { recursive: true });
  await writeFile(path.join(directory, "release/debug-build-spec.json"), value.buildSpecBytes);
  await noOutput("fixture-like", { buildSpec: "release/debug-build-spec.json" });
  await noOutput("sample-fixture", { fixture: "data/sample-nationwide.json" });
  const linkedSpec = path.join(directory, "release", "linked-build-spec.json");
  await symlink(path.join(directory, files.buildSpec), linkedSpec);
  await noOutput("symlink", { buildSpec: "release/linked-build-spec.json" });
  await noOutput("fixture-mismatch", { fixture: "tools/datapack/release/capital-production-canonical-pack.json" });
});

// 리뷰 F1: RC·stage·map-catalog이 함께 쓰는 결속 검사는 필드 하나만 달라도 거부해야 한다.
// scope는 preparation.authority.scopeId도 같이 바꿔 다른 비교가 대신 잡지 못하게 한다.
test("preparation 결속은 scopeId·releaseSequence·입력 source set이 하나만 달라도 거부한다", () => {
  const value = buildSyntheticNationwideReleaseCandidate();
  const preparationBytes = (mutate) => {
    const preparation = structuredClone(value.preparation);
    mutate(preparation);
    return Buffer.from(JSON.stringify(preparation));
  };
  const binding = bindNationwideCandidatePreparation({ preparationBytes: value.preparationBytes, buildSpec: value.buildSpec });
  assert.doesNotThrow(() => assertNationwideCandidateInputBytes({
    binding, buildSpec: value.buildSpec,
    stationLineInputBytes: value.stationLineInputBytes, routeEdgeInputBytes: value.routeBytes,
  }));
  assert.throws(() => bindNationwideCandidatePreparation({
    preparationBytes: preparationBytes((preparation) => {
      preparation.scopeId = "capital_pilot_android_v1";
      preparation.authority.scopeId = "capital_pilot_android_v1";
    }),
    buildSpec: value.buildSpec,
  }), /candidate preparation identity mismatch/, "scopeId");
  assert.throws(() => bindNationwideCandidatePreparation({
    preparationBytes: preparationBytes((preparation) => { preparation.releaseIdentity.releaseSequence += 1; }),
    buildSpec: value.buildSpec,
  }), /candidate preparation identity mismatch/, "releaseSequence");
  for (const [field, label] of [["stationLineInput", "station-line input"], ["route", "route-edge input"]]) {
    const changed = structuredClone(value[field]);
    changed.candidate.sourceSetSha256 = "0".repeat(64);
    const changedBytes = Buffer.from(canonical(changed));
    const changedBinding = structuredClone(binding);
    changedBinding[field === "route" ? "routeEdgeInput" : "stationLineInput"].sha256 = sha256(changedBytes);
    assert.throws(() => assertNationwideCandidateInputBytes({
      binding: changedBinding,
      buildSpec: value.buildSpec,
      stationLineInputBytes: field === "route" ? value.stationLineInputBytes : changedBytes,
      routeEdgeInputBytes: field === "route" ? changedBytes : value.routeBytes,
    }), new RegExp(`${label} candidate identity mismatch`), `${label} sourceSetSha256`);
  }
});

// map-catalog-publish CLI 경로에서는 입력 후보 id·source set을 이 결속만 확인한다.
test("결속 CLI(map-catalog 경로)는 preparation sha는 맞지만 source set이 다른 입력을 거부한다", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "nationwide-binding-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const value = buildSyntheticNationwideReleaseCandidate();
  await writeSyntheticNationwideRepository(directory, value);
  const argv = [
    "--build-spec", SYNTHETIC_NATIONWIDE_PATHS.buildSpec,
    "--candidate-preparation", SYNTHETIC_NATIONWIDE_PATHS.preparation,
    "--station-line-input", SYNTHETIC_NATIONWIDE_PATHS.stationLineInput,
    "--route-edge-input", SYNTHETIC_NATIONWIDE_PATHS.routeEdgeInput,
  ];
  const previous = process.cwd();
  process.chdir(directory);
  try {
    await verifyNationwideCandidateInputBinding(argv);
    const route = structuredClone(value.route);
    route.candidate.sourceSetSha256 = "0".repeat(64);
    const routeBytes = canonical(route);
    await writeFile(SYNTHETIC_NATIONWIDE_PATHS.routeEdgeInput, routeBytes);
    const preparation = structuredClone(value.preparation);
    preparation.routeEdgeInput.sha256 = sha256(routeBytes);
    await writeFile(SYNTHETIC_NATIONWIDE_PATHS.preparation, JSON.stringify(preparation));
    await assert.rejects(verifyNationwideCandidateInputBinding(argv), /route-edge input candidate identity mismatch/);
  } finally {
    process.chdir(previous);
  }
});

function outputFiles(directory, suffix) {
  return {
    fixture: SYNTHETIC_NATIONWIDE_PATHS.fixture,
    buildSpec: SYNTHETIC_NATIONWIDE_PATHS.buildSpec,
    stationOutput: path.join(directory, `${suffix}-station.json`),
    routeOutput: path.join(directory, `${suffix}-route.json`),
    fixtureOutput: path.join(directory, `${suffix}-candidate.json`),
    authorityOutput: path.join(directory, `${suffix}-authority.json`),
  };
}

async function assertNoOutputs(files, except = []) {
  for (const name of ["stationOutput", "routeOutput", "fixtureOutput", "authorityOutput"]) {
    if (!except.includes(name)) await assertFileAbsent(files[name]);
  }
}

function cliArgs(files) {
  return [
    "--fixture", files.fixture,
    "--build-spec", files.buildSpec,
    "--station-line-output", files.stationOutput,
    "--route-edge-output", files.routeOutput,
    "--fixture-output", files.fixtureOutput,
    "--authority-output", files.authorityOutput,
  ];
}

async function assertFileAbsent(file) {
  await assert.rejects(stat(file), (error) => error?.code === "ENOENT");
}

async function fullInput({ widen = false } = {}) {
  const source = await fullCapitalFixture();
  if (widen) widenFixtureTransferMetricsBeyondCapitalDomain(source);
  const routeOnly = source.canonicalPack.packs[0].stationLines;
  source.canonicalPack.packs[0].networkEdges = [
    ...routeOnly.slice(0, 2).map(({ stationId, lineId }, index) => ({
      id: `ride-${index}`,
      edgeType: "RIDE",
      fromNodeId: `${stationId}:${lineId}`,
      toNodeId: `${routeOnly[(index + 1) % routeOnly.length].stationId}:${routeOnly[(index + 1) % routeOnly.length].lineId}`,
      durationSeconds: 120,
      distanceMeters: 1000,
      serviceClass: "SUBWAY",
      servicePattern: "LOCAL",
    })),
  ];
  const stationLineInput = buildCurrentCapitalStationLineInput(source);
  const route = buildCurrentCapitalRouteEdgeInput(source);
  const projectedFixture = {
    manifest: { activePack: { id: "capital", version: "1" }, channel: "production", keyId: "fixture", manifestVersion: 2, ttlSeconds: 3600 },
    packs: [{
      id: "capital",
      version: "1",
      lines: structuredClone(source.canonicalPack.packs[0].lines),
      stationLines: structuredClone(source.canonicalPack.packs[0].stationLines),
      networkEdges: [
        ...route.routeEdges.filter(({ edgeType }) => edgeType === "RIDE").map(routeRide),
      ],
    }],
  };
  const sourceFixture = structuredClone(projectedFixture);
  const buildSpec = { candidateId: stationLineInput.candidate.candidateId, sourceSnapshotSetHash: stationLineInput.candidate.sourceSetSha256 };
  return {
    buildSpec,
    buildSpecBytes: Buffer.from(canonical(buildSpec)),
    projectedFixture,
    route,
    routeBytes: Buffer.from(canonical(route)),
    sourceFixtureBytes: Buffer.from(canonical(sourceFixture)),
    stationLineInput,
    stationLineInputBytes: Buffer.from(canonical(stationLineInput)),
    transferMetrics: source.transferMetrics,
    transferMetricsBytes: Buffer.from(canonical(source.transferMetrics)),
  };
}

function routeRide(edge) {
  return {
    id: edge.edgeId,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    durationSeconds: edge.durationSeconds,
    distanceMeters: edge.distanceMeters,
    edgeType: edge.edgeType,
    servicePattern: edge.servicePattern,
    serviceClass: edge.serviceClass,
    includesStairs: false,
    stairAccessState: "UNKNOWN",
    accessibilityStatus: "UNKNOWN",
    reliabilityScore: 100,
    facilityId: null,
  };
}

function nonRideEdge(id, edgeType) {
  return {
    id,
    fromNodeId: edgeType === "ENTRY" ? id : `${id}:line`,
    toNodeId: edgeType === "EXIT" ? id : `${id}:line`,
    durationSeconds: edgeType === "ENTRY" ? 90 : 60,
    distanceMeters: 0,
    edgeType,
    servicePattern: "",
    includesStairs: false,
    stairAccessState: "UNKNOWN",
    accessibilityStatus: "UNKNOWN",
    reliabilityScore: 90,
    verificationStatus: "NOT_VERIFIED",
  };
}

function edgeCounts(edges) {
  return Object.fromEntries([...new Set(edges.map(({ edgeType }) => edgeType))].sort().map((edgeType) => [edgeType, edges.filter((edge) => edge.edgeType === edgeType).length]));
}

function rebindBytes(value) {
  value.buildSpecBytes = Buffer.from(canonical(value.buildSpec));
  value.routeBytes = Buffer.from(canonical(value.route));
  value.stationLineInputBytes = Buffer.from(canonical(value.stationLineInput));
}

function rebindRouteEdge(route, edge) {
  edge.edgeSha256 = sha256(Buffer.from(canonical({
    edgeId: edge.edgeId,
    edgeType: edge.edgeType,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    durationSeconds: edge.durationSeconds,
    distanceMeters: edge.distanceMeters,
    servicePattern: edge.servicePattern,
    serviceClass: edge.serviceClass,
  })));
}

function resealAuthority(authority) {
  const { authoritySha256: _ignored, ...payload } = authority;
  authority.authoritySha256 = sha256(Buffer.from(canonical(payload)));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
