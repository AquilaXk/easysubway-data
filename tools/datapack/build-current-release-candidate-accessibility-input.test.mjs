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
import { fixture as fullCapitalFixture } from "./build-current-capital-station-line-input.test.mjs";
import { buildCurrentCapitalAccessibilityRefreshOutputs } from "./refresh-current-capital-accessibility-full.mjs";
import { materializeStationLineAccessibility } from "./materialize-station-line-accessibility.mjs";
import {
  copySyntheticCurrentPublicRouteMapRepository,
  nextSyntheticCurrentStaticNetworkNow,
} from "./test-fixtures/current-public-route-map-successor.mjs";

test("full-capital authority는 213/639 input과 456 non-RIDE를 2,664-edge fixture에 결속한다", async () => {
  const input = await fullInput();
  const before = structuredClone(input.projectedFixture);
  const result = buildCurrentReleaseCandidateAccessibilityAuthority(input);

  assert.deepEqual(edgeCounts(JSON.parse(input.sourceFixtureBytes).packs[0].networkEdges), {
    RIDE: 2200,
  });
  assert.deepEqual(edgeCounts(input.projectedFixture.packs[0].networkEdges), {
    RIDE: 2208,
  });
  assert.equal(result.candidateFixture.packs[0].networkEdges.length, 2664);
  assert.equal(input.route.stationLines.length, 1102);
  assert.deepEqual(edgeCounts(result.candidateFixture.packs[0].networkEdges), {
    ENTRY: 213,
    EXIT: 213,
    IN_STATION_TRANSFER: 30,
    RIDE: 2208,
  });
  assert.deepEqual(result.authority.edgeCounts, {
    ENTRY: 213,
    EXIT: 213,
    IN_STATION_TRANSFER: 30,
    total: 456,
  });
  assert.equal(result.authority.edges.length, 456);
  assert.equal(result.authority.edges.filter(({ requiredCells }) => requiredCells.length === 2).length, 30);
  assert.equal(result.authority.edges.flatMap(({ requiredCells }) => requiredCells).filter(({ state }) => state === "UNVERIFIED_EVIDENCE_BLOCKED").length, 2);
  assert.match(result.authority.buildInput.buildSpecSha256, /^[a-f0-9]{64}$/u);
  assert.match(result.authority.buildInput.sourceFixtureSha256, /^[a-f0-9]{64}$/u);
  assert.match(result.authority.buildInput.candidateFixtureSha256, /^[a-f0-9]{64}$/u);
  assert.equal(result.authority.buildInput.observedAt, "2026-08-01T00:00:00.000Z");
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

test("합성 current public successor는 1,102 metadata·2,664 route·456 authority를 완성한다", async (t) => {
  const sourceRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
  const temp = await mkdtemp(path.join(tmpdir(), "public-route-map-authority-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const repositoryRoot = path.join(temp, "repository");
  await copySyntheticCurrentPublicRouteMapRepository(sourceRoot, repositoryRoot, {
    now: await nextSyntheticCurrentStaticNetworkNow(sourceRoot),
    activateStaticNetwork: true,
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
  assert.deepEqual(edgeCounts(sourceFixture.packs[0].networkEdges), { RIDE: 2200 });
  assert.deepEqual(edgeCounts(projectedFixture.packs[0].networkEdges), { RIDE: 2208 });
  const result = buildCurrentReleaseCandidateAccessibilityAuthority({
    buildSpec,
    buildSpecBytes,
    projectedFixture,
    route,
    routeBytes,
    sourceFixtureBytes,
    stationLineInput,
    stationLineInputBytes,
  });

  assert.equal(route.stationLines.length, 1102);
  assert.equal(route.routeEdges.length, 2664);
  assert.equal(result.authority.edges.length, 456);
  const authorityCells = result.authority.edges.flatMap(({ requiredCells }) => requiredCells);
  const authorityCellKeys = new Set(authorityCells.map(({ stationId, lineId, domain }) =>
    `${stationId}:${lineId}:${domain}`));
  const materialization = materializeStationLineAccessibility({
    ...stationLineInput,
    observedAt: result.authority.buildInput.observedAt,
  });
  const expectedBlockedCellCount = materialization.rows.filter(({ stationId, lineId, domain, state }) =>
    state === "UNVERIFIED_EVIDENCE_BLOCKED" && authorityCellKeys.has(`${stationId}:${lineId}:${domain}`)).length;
  assert.ok(expectedBlockedCellCount > 0);
  assert.equal(authorityCells.filter(({ state }) => state === "UNVERIFIED_EVIDENCE_BLOCKED").length, expectedBlockedCellCount);
  assert.equal(result.candidateFixture.packs[0].networkEdges.length, 2664);
});

test("unresolved·stale·candidate·route·projected RIDE drift는 output 전에 fail-closed다", async () => {
  const cases = [
    ["unresolved", (value) => { value.stationLineInput.evidenceRows.pop(); }, /unresolved|denominator|missing/i],
    ["stale", (value) => { value.stationLineInput.evidenceRows[0].freshUntil = "2026-08-01T00:00:00.000Z"; }, /fresh|stale/i],
    ["candidate", (value) => { value.route.candidate.sourceSetSha256 = "0".repeat(64); }, /candidate/i],
    ["route hash", (value) => { value.route.routeEdges[0].edgeSha256 = "0".repeat(64); }, /hash/i],
    ["route metadata missing", (value) => { value.route.stationLines.pop(); }, /route station-line/i],
    ["route metadata operator", (value) => { value.route.stationLines[0].operatorId = "drift"; }, /route station-line/i],
    ["projected metadata missing", (value) => { value.projectedFixture.packs[0].stationLines.pop(); }, /route station-line/i],
    ["RIDE denominator", (value) => { value.projectedFixture.packs[0].networkEdges.pop(); }, /RIDE-only/i],
    ["extra non-RIDE", (value) => { value.projectedFixture.packs[0].networkEdges.push(nonRideEdge("extra", "WALKWAY")); }, /RIDE-only/i],
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
  }));

  const requiredCellDrift = structuredClone(authority);
  requiredCellDrift.edges[0].requiredCells[0].state = "VERIFIED_ABSENT";
  resealAuthority(requiredCellDrift);
  assert.throws(
    () => validateCurrentReleaseCandidateAccessibilityAuthorityReplay({
      authority: requiredCellDrift,
      projectedFixture: input.projectedFixture,
      stationLineInputBytes: input.stationLineInputBytes,
      routeEdgeInputBytes: input.routeBytes,
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
    }),
    /projected fixture RIDE mismatch/,
  );
});

test("CLI는 current tuple을 재생성해 canonical input/fixture/authority 네 파일을 만들고 collision에는 mutation 0이다", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "full-capital-authority-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = await fullInput();
  const buildSpec = {
    ...input.buildSpec,
    fixturePath: "tools/datapack/release/capital-production-canonical-pack.json",
  };
  const buildSpecBytes = Buffer.from(canonical(buildSpec));
  const files = {
    fixture: buildSpec.fixturePath,
    buildSpec: "tools/datapack/release/candidate-build-spec.json",
    stationOutput: path.join(directory, "station.json"),
    routeOutput: path.join(directory, "route.json"),
    fixtureOutput: path.join(directory, "candidate.json"),
    authorityOutput: path.join(directory, "authority.json"),
  };
  await Promise.all([
    mkdir(path.join(directory, path.dirname(files.buildSpec)), { recursive: true }),
    mkdir(path.join(directory, path.dirname(files.fixture)), { recursive: true }),
  ]);
  await writeFile(path.join(directory, files.fixture), input.sourceFixtureBytes);
  await writeFile(path.join(directory, files.buildSpec), buildSpecBytes);
  const argv = cliArgs(files);
  await main(argv, {
    repositoryRoot: directory,
    projectFixtureImpl: async () => structuredClone(input.projectedFixture),
    buildRefreshOutputsImpl: async () => [
      {
        relative: "tools/datapack/release/current-capital-accessibility-full/station-line-input.json",
        bytes: input.stationLineInputBytes,
      },
      {
        relative: "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json",
        bytes: input.routeBytes,
      },
    ],
  });
  const [stationBytes, routeBytes, fixtureBytes, authorityBytes, stationStat, routeStat, fixtureStat, authorityStat] = await Promise.all([
    readFile(files.stationOutput),
    readFile(files.routeOutput),
    readFile(files.fixtureOutput),
    readFile(files.authorityOutput),
    stat(files.stationOutput),
    stat(files.routeOutput),
    stat(files.fixtureOutput),
    stat(files.authorityOutput),
  ]);
  assert.equal(stationBytes.toString("utf8"), canonicalCurrentCapitalStationLineInputJson(input.stationLineInput));
  assert.equal(routeBytes.toString("utf8"), canonicalCurrentCapitalRouteEdgeInputJson(input.route));
  assert.equal(
    fixtureBytes.toString("utf8"),
    canonicalCurrentReleaseCandidateFixtureJson(JSON.parse(fixtureBytes)),
  );
  assert.equal(
    authorityBytes.toString("utf8"),
    canonicalCurrentReleaseCandidateAccessibilityAuthorityJson(JSON.parse(authorityBytes)),
  );
  for (const info of [stationStat, routeStat, fixtureStat, authorityStat]) {
    assert.equal(info.mode & 0o777, 0o600);
  }

  const collisionFixture = path.join(directory, "collision-candidate.json");
  const collisionAuthority = path.join(directory, "collision-authority.json");
  await writeFile(collisionAuthority, "owned");
  await assert.rejects(
    main(cliArgs({ ...files, fixtureOutput: collisionFixture, authorityOutput: collisionAuthority }), {
      repositoryRoot: directory,
      projectFixtureImpl: async () => structuredClone(input.projectedFixture),
      buildRefreshOutputsImpl: async () => [],
    }),
    /output must be absent/,
  );
  await assertFileAbsent(collisionFixture);
  assert.equal(await readFile(collisionAuthority, "utf8"), "owned");

  const sameOutput = path.join(directory, "same-output.json");
  await assert.rejects(
    main(cliArgs({ ...files, stationOutput: sameOutput, authorityOutput: sameOutput }), {
      repositoryRoot: directory,
      projectFixtureImpl: async () => structuredClone(input.projectedFixture),
      buildRefreshOutputsImpl: async () => [],
    }),
    /output paths must be distinct/,
  );
  await assertFileAbsent(sameOutput);
});

test("CLI는 workflow가 검증한 repo-relative build spec과 fixture의 동일 raw bytes를 pre-approval phase로 전달한다", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "per-run-capital-authority-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = await fullInput();
  const buildSpec = {
    ...input.buildSpec,
    fixturePath: "data/capital.json",
  };
  const buildSpecBytes = Buffer.from(`${canonical(buildSpec)}\n`);
  const sourceFixture = JSON.parse(input.sourceFixtureBytes);
  const files = {
    fixture: "./data/capital.json",
    buildSpec: "./release/per-run-build-spec.json",
    stationOutput: path.join(directory, "station.json"),
    routeOutput: path.join(directory, "route.json"),
    fixtureOutput: path.join(directory, "candidate.json"),
    authorityOutput: path.join(directory, "authority.json"),
  };
  await Promise.all([
    mkdir(path.join(directory, path.dirname(files.buildSpec)), { recursive: true }),
    mkdir(path.join(directory, path.dirname(files.fixture)), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(directory, files.fixture), input.sourceFixtureBytes),
    writeFile(path.join(directory, files.buildSpec), buildSpecBytes),
  ]);

  await main(cliArgs(files), {
    repositoryRoot: directory,
    projectFixtureImpl: async ({ buildSpec: selected, sourceFixture: selectedFixture }) => {
      assert.deepEqual(selected, buildSpec);
      assert.deepEqual(selectedFixture, sourceFixture);
      return structuredClone(input.projectedFixture);
    },
    buildRefreshOutputsImpl: async ({ phase, candidateBuildSpec, canonicalPack }) => {
      assert.equal(phase, "PRE_APPROVAL_CURRENT_CANDIDATE");
      assert.deepEqual(candidateBuildSpec, buildSpec);
      assert.deepEqual(canonicalPack, sourceFixture);
      return [
        {
          relative: "tools/datapack/release/current-capital-accessibility-full/station-line-input.json",
          bytes: input.stationLineInputBytes,
        },
        {
          relative: "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json",
          bytes: input.routeBytes,
        },
      ];
    },
  });

  const authority = JSON.parse(await readFile(files.authorityOutput, "utf8"));
  assert.equal(authority.buildInput.buildSpecSha256, sha256(buildSpecBytes));

  await assert.rejects(
    main(cliArgs({
      ...files,
      fixture: "source.json",
      stationOutput: path.join(directory, "mismatch-station.json"),
      routeOutput: path.join(directory, "mismatch-route.json"),
      fixtureOutput: path.join(directory, "mismatch-candidate.json"),
      authorityOutput: path.join(directory, "mismatch-authority.json"),
    }), {
      repositoryRoot: directory,
      projectFixtureImpl: async () => structuredClone(input.projectedFixture),
      buildRefreshOutputsImpl: async () => [],
    }),
    /fixture path mismatch/,
  );
});

test("CLI는 build spec/fixture path 경계를 fail closed하고 출력 전에 중단한다", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "candidate-input-path-boundary-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = await fullInput();
  const buildSpec = { ...input.buildSpec, fixturePath: "data/capital.json" };
  const buildSpecBytes = Buffer.from(`${canonical(buildSpec)}\n`);
  const files = {
    fixture: "data/capital.json",
    buildSpec: "release/per-run-build-spec.json",
    stationOutput: path.join(directory, "station.json"),
    routeOutput: path.join(directory, "route.json"),
    fixtureOutput: path.join(directory, "candidate.json"),
    authorityOutput: path.join(directory, "authority.json"),
  };
  await Promise.all([
    mkdir(path.join(directory, "release"), { recursive: true }),
    mkdir(path.join(directory, "data"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(directory, files.buildSpec), buildSpecBytes),
    writeFile(path.join(directory, files.fixture), input.sourceFixtureBytes),
  ]);
  const noOutput = async (candidate) => {
    await assert.rejects(main(cliArgs(candidate), {
      repositoryRoot: directory,
      projectFixtureImpl: async () => structuredClone(input.projectedFixture),
      buildRefreshOutputsImpl: async () => [],
    }), /path|mismatch|regular file/i);
    await Promise.all([
      assertFileAbsent(candidate.stationOutput),
      assertFileAbsent(candidate.routeOutput),
      assertFileAbsent(candidate.fixtureOutput),
      assertFileAbsent(candidate.authorityOutput),
    ]);
  };
  const candidate = (suffix, changes) => ({
    ...files,
    stationOutput: path.join(directory, `${suffix}-station.json`),
    routeOutput: path.join(directory, `${suffix}-route.json`),
    fixtureOutput: path.join(directory, `${suffix}-candidate.json`),
    authorityOutput: path.join(directory, `${suffix}-authority.json`),
    ...changes,
  });

  await noOutput(candidate("absolute", { buildSpec: path.join(directory, files.buildSpec) }));
  await noOutput(candidate("parent", { buildSpec: "../release/per-run-build-spec.json" }));
  await noOutput(candidate("fixture-like", { buildSpec: "release/debug-build-spec.json" }));
  await noOutput(candidate("sample-fixture", { fixture: "data/sample-capital.json" }));
  const linkedSpec = path.join(directory, "release", "linked-build-spec.json");
  await symlink(path.join(directory, files.buildSpec), linkedSpec);
  await noOutput(candidate("symlink", { buildSpec: "release/linked-build-spec.json" }));
  await noOutput(candidate("fixture-mismatch", { fixture: "data/other.json" }));
});

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

async function fullInput() {
  const source = await fullCapitalFixture();
  const routeOnly = addFullRouteStationLines(source);
  source.canonicalPack.packs[0].networkEdges = [
    ...Array.from({ length: 2208 }, (_, index) => ({
      id: `ride-${index}`,
      edgeType: "RIDE",
      fromNodeId: "station-000:seoul-2",
      toNodeId: "station-001:seoul-2",
      durationSeconds: 120,
      distanceMeters: 1000,
      serviceClass: "SUBWAY",
      servicePattern: "LOCAL",
    })),
  ];
  Object.assign(source.canonicalPack.packs[0].networkEdges[0], {
    fromNodeId: `${routeOnly[0].stationId}:${routeOnly[0].lineId}`,
    toNodeId: `${routeOnly[1].stationId}:${routeOnly[1].lineId}`,
  });
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
  sourceFixture.packs[0].networkEdges = [
    ...Array.from({ length: 2200 }, (_, index) => ({
      id: `ride-${index}`,
      edgeType: "RIDE",
      fromNodeId: "station-000:seoul-2",
      toNodeId: "station-001:seoul-2",
      durationSeconds: 120,
      distanceMeters: 1000,
      serviceClass: "SUBWAY",
      servicePattern: "LOCAL",
    })),
  ];
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
  };
}

function addFullRouteStationLines(input) {
  const pack = input.canonicalPack.packs[0];
  const lineId = "route-only-line";
  pack.lines.push({ id: lineId, operatorId: "route-only-operator" });
  const extras = Array.from({ length: 1102 - pack.stationLines.length }, (_, index) => ({
    stationId: `station-route-${String(index).padStart(4, "0")}`,
    lineId,
    lineSequence: index,
  }));
  pack.stationLines.push(...extras);
  return extras;
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
