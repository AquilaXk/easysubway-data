import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  buildRouteGraphTopologyReport,
  main,
  validateCurrentItxTopologyEvidencePack,
} from "./build-route-graph-topology-report.mjs";
import { canonicalRideEdgeSetSha256 } from "./evaluate-route-accessibility-edges.mjs";

const root = path.resolve(import.meta.dirname, "../..");
import { stageLocalMobileFixture } from "../ci/stage-local-mobile-fixture.mjs";
stageLocalMobileFixture({ repositoryRoot: root });
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const topologyEvidencePath = path.join(root, "tools/datapack/itx-cheongchun-topology-evidence.json");
const currentTopologyEvidence = JSON.parse(await readFile(topologyEvidencePath, "utf8"));
const currentBuildSpec = JSON.parse(await readFile(
  path.join(root, "tools/datapack/release/candidate-build-spec.json"),
  "utf8",
));
const emptyItxEdgeSetSha256 = canonicalRideEdgeSetSha256([]);

function buildReport(sqlitePath, pack, admittedItxHash = emptyItxEdgeSetSha256) {
  return buildRouteGraphTopologyReport(sqlitePath, pack, { admittedItxEdgeSetSha256: admittedItxHash });
}

function itxAdmissionHash(rows) {
  return canonicalRideEdgeSetSha256(rows.map(([
    edgeId,
    fromNodeId,
    toNodeId,
    edgeType,
    servicePattern,
    durationSeconds,
    distanceMeters,
    serviceClass,
  ]) => ({
    edgeId,
    fromNodeId,
    toNodeId,
    edgeType,
    servicePattern,
    serviceClass,
    durationSeconds,
    distanceMeters,
  })));
}

test("route graph topology report exposes LOCAL adjacency and speed violations", () => {
  const sqlitePath = createTopologySqlite({
    stationLines: [
      ["station-a", "line-4", 1],
      ["station-b", "line-4", 2],
      ["station-c", "line-4", 5],
    ],
    edges: [
      ["edge-a-b-local", "station-a:line-4", "station-b:line-4", "RIDE", "LOCAL", 120, 1000],
      ["edge-a-c-local", "station-a:line-4", "station-c:line-4", "RIDE", "LOCAL", 30, 5000],
      ["edge-c-a-express", "station-c:line-4", "station-a:line-4", "RIDE", "EXPRESS", 600, 5000],
    ],
  });

  const report = buildReport(sqlitePath, {
    id: "capital",
    version: "1",
    artifactKind: "production",
  });

  assert.equal(report.stationLineNodeCount, 3);
  assert.equal(report.edgeCountsByType.RIDE, 3);
  assert.deepEqual(report.rideCountsByServicePattern, { EXPRESS: 1, LOCAL: 2 });
  assert.deepEqual(report.violations.localRideAdjacency, [
    {
      edgeId: "edge-a-c-local",
      fromNode: "station-a:line-4",
      toNode: "station-c:line-4",
      fromLineSequence: 1,
      toLineSequence: 5,
    },
  ]);
  assert.deepEqual(report.violations.nonAdjacentExpressRide, [
    {
      edgeId: "edge-c-a-express",
      fromNode: "station-c:line-4",
      toNode: "station-a:line-4",
      fromLineSequence: 5,
      toLineSequence: 1,
    },
  ]);
  assert.deepEqual(report.violations.rideSpeed.map((row) => row.edgeId), ["edge-a-c-local"]);
  assert.equal(report.violations.unreachableDirectedPairs.length, 2);
});

test("route graph topology report seeds implicit same-station transfers", () => {
  const sqlitePath = createTopologySqlite({
    stationLines: [
      ["station-a", "line-2", 10],
      ["station-a", "line-4", 20],
      ["station-b", "line-2", 11],
      ["station-c", "line-4", 21],
    ],
    edges: [
      ["edge-a-b-line2", "station-a:line-2", "station-b:line-2", "RIDE", "LOCAL", 120, 1000],
      ["edge-b-a-line2", "station-b:line-2", "station-a:line-2", "RIDE", "LOCAL", 120, 1000],
      ["edge-a-c-line4", "station-a:line-4", "station-c:line-4", "RIDE", "LOCAL", 120, 1000],
      ["edge-c-a-line4", "station-c:line-4", "station-a:line-4", "RIDE", "LOCAL", 120, 1000],
    ],
  });

  const report = buildReport(sqlitePath, {
    id: "capital",
    version: "1",
    artifactKind: "production",
  });

  assert.equal(report.routeGraphNodeCount, 4);
  assert.equal(report.violations.unreachableDirectedPairs.length, 0);
});

test("route graph topology report는 ITX service layer row를 별도 집계한다", () => {
  const itxEdges = [
    ["edge-a-b-itx", "station-a:line-k2:EXPRESS", "station-b:line-k2:EXPRESS", "RIDE", "EXPRESS", 300, 6000, "ITX_CHEONGCHUN"],
  ];
  const sqlitePath = createTopologySqlite({
    stationLines: [
      ["station-a", "line-k2", 1],
      ["station-b", "line-k2", 2],
    ],
    edges: itxEdges,
  });

  const report = buildReport(sqlitePath, {
    id: "capital",
    version: "1",
    artifactKind: "fixture",
  }, itxAdmissionHash(itxEdges));

  assert.deepEqual(report.rideCountsByServiceClass, { ITX_CHEONGCHUN: 1 });
  assert.equal(report.itxServiceLayerSegmentCount, 1);
  assert.equal(report.violations.nonAdjacentExpressRide.length, 0);
});

test("route graph topology report는 ITX EXPRESS가 아닌 종점 suffix를 거부한다", () => {
  const sqlitePath = createTopologySqlite({
    stationLines: [
      ["station-a", "line-1", 1],
      ["station-b", "line-1", 2],
    ],
    edges: [
      ["edge-a-b-local", "station-a:line-1:LOCAL", "station-b:line-1:LOCAL", "RIDE", "LOCAL", 120, 1000],
    ],
  });

  assert.throws(
    () => buildReport(sqlitePath, { id: "capital", version: "1", artifactKind: "fixture" }),
    /network edge endpoint suffix is unsupported: edge-a-b-local/,
  );
});

test("route graph topology report는 승인되지 않은 ITX 노선 경계 edge를 거부한다", () => {
  const sqlitePath = createTopologySqlite({
    stationLines: [
      ["station-a", "line-k1", 10],
      ["station-b", "line-k2", 20],
    ],
    edges: [
      ["edge-a-b-itx", "station-a:line-k1:EXPRESS", "station-b:line-k2:EXPRESS", "RIDE", "EXPRESS", 0, 0, "ITX_CHEONGCHUN"],
    ],
  });

  assert.throws(
    () => buildReport(sqlitePath, {
      id: "capital",
      version: "1",
      artifactKind: "fixture",
    }, sha256("mismatched current ITX admission")),
    /ITX edge set identity mismatch/,
  );
});

test("route graph topology report는 명시적이고 유효한 ITX admission hash만 받는다", () => {
  const sqlitePath = createTopologySqlite({
    stationLines: [
      ["station-a", "line-k1", 10],
      ["station-b", "line-k2", 20],
    ],
    edges: [
      ["edge-a-b-itx", "station-a:line-k1:EXPRESS", "station-b:line-k2:EXPRESS", "RIDE", "EXPRESS", 0, 0, "ITX_CHEONGCHUN"],
    ],
  });
  const pack = { id: "capital", version: "1", artifactKind: "fixture" };

  assert.throws(
    () => buildRouteGraphTopologyReport(sqlitePath, pack),
    /admitted ITX edge set must be a lowercase sha256/,
  );
  assert.throws(
    () => buildRouteGraphTopologyReport(sqlitePath, pack, { admittedItxEdgeSetSha256: "A".repeat(64) }),
    /admitted ITX edge set must be a lowercase sha256/,
  );
  assert.throws(
    () => buildReport(sqlitePath, pack, sha256("mismatched ITX admission")),
    /ITX edge set identity mismatch/,
  );
});

test("route graph topology report는 인접한 ITX LOCAL edge도 승인하지 않는다", () => {
  const itxEdges = [
    ["edge-a-b-itx-local", "station-a:line-k1", "station-b:line-k1", "RIDE", "LOCAL", 120, 1000, "ITX_CHEONGCHUN"],
  ];
  const sqlitePath = createTopologySqlite({
    stationLines: [
      ["station-a", "line-k1", 10],
      ["station-b", "line-k1", 11],
    ],
    edges: itxEdges,
  });

  const report = buildReport(sqlitePath, {
    id: "capital",
    version: "1",
    artifactKind: "fixture",
  }, itxAdmissionHash(itxEdges));

  assert.deepEqual(report.violations.localRideAdjacency.map(({ edgeId }) => edgeId), [
    "edge-a-b-itx-local",
  ]);
});

test("route graph topology report는 canonical ITX edge가 전부 누락되면 실패한다", () => {
  const sqlitePath = createTopologySqlite({
    stationLines: [
      ["station-a", "line-1", 1],
      ["station-b", "line-1", 2],
    ],
    edges: [
      ["edge-a-b-local", "station-a:line-1", "station-b:line-1", "RIDE", "LOCAL", 120, 1000],
    ],
  });

  assert.throws(
    () => buildReport(sqlitePath, {
      id: "capital",
      version: "1",
      artifactKind: "production",
    }, sha256("missing current ITX admission")),
    /ITX edge set identity mismatch/,
  );
});

test("route graph topology report는 regional production pack의 ITX RIDE가 없으면 canonical empty admission만 반환한다", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "route-graph-no-itx-"));
  const sqlitePath = createTopologySqlite({
    stationLines: [
      ["station-a", "line-1", 1],
      ["station-b", "line-1", 2],
    ],
    edges: [
      ["edge-a-b-local", "station-a:line-1", "station-b:line-1", "RIDE", "LOCAL", 120, 1000],
    ],
  });
  context.after(() => Promise.all([
    rm(directory, { recursive: true, force: true }),
    rm(sqlitePath, { force: true }),
  ]));
  const sqliteBytes = await readFile(sqlitePath);
  await mkdir(path.join(directory, "catalog"), { recursive: true });
  await writeFile(path.join(directory, "catalog", "regional-v1.sqlite.gz"), gzipSync(sqliteBytes));
  const manifestPath = path.join(directory, "current.json");
  const buildSpecPath = path.join(directory, "candidate-build-spec.json");
  const outputPath = path.join(directory, "route-graph-topology-report.json");
  await writeFile(manifestPath, `${JSON.stringify({
    manifestVersion: 2,
    channel: "production",
    packs: [{
      id: "regional",
      version: "1",
      artifactKind: "production",
      url: "catalog/regional-v1.sqlite.gz",
    }],
  })}\n`);
  await writeFile(buildSpecPath, "{}\n");

  const report = await main([
    "--manifest", manifestPath,
    "--root", directory,
    "--build-spec", buildSpecPath,
    "--output", outputPath,
  ], { repositoryRoot: directory });

  assert.equal(report.summary.packCount, 1);
  assert.equal(report.packs[0].itxServiceLayerSegmentCount, 0);
});

test("route graph topology report는 production capital pack의 zero ITX를 fail-closed한다", async (context) => {
  const sqlitePath = createTopologySqlite({
    stationLines: [["station-a", "line-1", 1], ["station-b", "line-1", 2]],
    edges: [["edge-a-b-local", "station-a:line-1", "station-b:line-1", "RIDE", "LOCAL", 120, 1000]],
  });
  context.after(() => rm(sqlitePath, { force: true }));
  const sqliteBytes = await readFile(sqlitePath);
  await assert.rejects(
    validateCurrentItxTopologyEvidencePack({
      compressed: gzipSync(sqliteBytes), sqliteBytes, sqlitePath,
      pack: { id: "capital", version: "1", artifactKind: "production" }, buildSpec: {}, repositoryRoot: root,
    }),
    /production capital pack requires ITX topology evidence/,
  );
});

test("route graph topology report는 ITX RIDE가 있으면 evidence 없는 build spec을 fail-closed한다", async (context) => {
  const sqlitePath = createTopologySqlite({
    stationLines: [
      ["station-a", "line-k2", 1],
      ["station-b", "line-k2", 2],
    ],
    edges: [
      ["edge-a-b-itx", "station-a:line-k2:EXPRESS", "station-b:line-k2:EXPRESS", "RIDE", "EXPRESS", 300, 6000, "ITX_CHEONGCHUN"],
    ],
  });
  context.after(() => rm(sqlitePath, { force: true }));
  const sqliteBytes = await readFile(sqlitePath);

  await assert.rejects(
    validateCurrentItxTopologyEvidencePack({
      compressed: gzipSync(sqliteBytes),
      sqliteBytes,
      sqlitePath,
      pack: { id: "capital", version: "1" },
      buildSpec: {},
      repositoryRoot: root,
    }),
    /ITX topology evidence|build spec|buildSpec/i,
  );
});

test("route graph topology report는 current evidence가 pin한 v19 ITX pack만 허용한다", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "route-graph-admitted-itx-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const sqlitePath = path.join(directory, "capital.sqlite");
  const candidate = JSON.parse(await readFile(
    path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8",
  ));
  const candidateEvidenceBytes = await readFile(path.join(root, candidate.itxTopologyEvidencePath));
  assert.equal(sha256(candidateEvidenceBytes), candidate.itxTopologyEvidenceSha256);
  const evidenceBytes = await readFile(topologyEvidencePath);
  const evidence = JSON.parse(evidenceBytes);
  const deployedBuildSpec = {
    ...candidate,
    itxTopologyEvidencePath: path.relative(root, topologyEvidencePath),
    itxTopologyEvidenceSha256: sha256(evidenceBytes),
  };
  const mobilePackBytes = await readFile(path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"));
  assert.equal(sha256(mobilePackBytes), evidence.pack.outputSha256);
  await writeFile(sqlitePath, gunzipSync(mobilePackBytes));
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  const packVersion = database.prepare("PRAGMA user_version").get().user_version;
  database.close();

  const binding = await validateCurrentItxTopologyEvidencePack({
    compressed: mobilePackBytes,
    sqliteBytes: gunzipSync(mobilePackBytes),
    sqlitePath,
    pack: { id: "capital", version: "1" },
    buildSpec: deployedBuildSpec,
    repositoryRoot: root,
  });
  const report = buildRouteGraphTopologyReport(sqlitePath, {
    id: "capital",
    version: String(packVersion),
    artifactKind: "production",
  }, binding);

  assert.equal(report.version, String(packVersion));
  assert.equal(report.itxServiceLayerSegmentCount, evidence.topology.edgeCount);
  assert.deepEqual(report.violations.nonAdjacentExpressRide, []);
});

test("route graph topology report는 SUBWAY 연결성을 ITX edge로 보완하지 않는다", () => {
  const itxEdges = [
    ["itx-b-c", "station-b:line-k2:EXPRESS", "station-c:line-k2:EXPRESS", "RIDE", "EXPRESS", 120, 1000, "ITX_CHEONGCHUN"],
    ["itx-c-b", "station-c:line-k2:EXPRESS", "station-b:line-k2:EXPRESS", "RIDE", "EXPRESS", 120, 1000, "ITX_CHEONGCHUN"],
  ];
  const sqlitePath = createTopologySqlite({
    stationLines: [
      ["station-a", "line-k2", 1],
      ["station-b", "line-k2", 2],
      ["station-c", "line-k2", 3],
    ],
    edges: [
      ["subway-a-b", "station-a:line-k2", "station-b:line-k2", "RIDE", "LOCAL", 120, 1000],
      ["subway-b-a", "station-b:line-k2", "station-a:line-k2", "RIDE", "LOCAL", 120, 1000],
      ...itxEdges,
    ],
  });

  const report = buildReport(sqlitePath, {
    id: "capital",
    version: "1",
    artifactKind: "fixture",
  }, itxAdmissionHash(itxEdges));

  assert.deepEqual(report.violations.disconnectedNodes, ["station-c:line-k2"]);
  assert.equal(report.violations.unreachableDirectedPairs.length, 4);
});

test("route graph topology report CLI writes artifact json", async (context) => {
  const dir = await mkdtemp(path.join(tmpdir(), "route-graph-topology-report-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "catalog"), { recursive: true });
  const { itxEdgeRows } = await readMobileItxRows(context);
  const sqlitePath = createTopologySqlite({
    stationLines: [
      ["station-a", "line-4", 1],
      ["station-b", "line-4", 2],
    ],
    edges: [
      ["edge-a-b-local", "station-a:line-4", "station-b:line-4", "RIDE", "LOCAL", 120, 1000],
      ["edge-b-a-local", "station-b:line-4", "station-a:line-4", "RIDE", "LOCAL", 120, 1000],
      ...itxEdgeRows,
    ],
    userVersion: 19,
  });
  context.after(() => rm(sqlitePath, { force: true }));
  const sqliteBytes = await readFile(sqlitePath);
  const gzipBytes = gzipSync(sqliteBytes);
  await writeFile(path.join(dir, "catalog", "capital-v1.sqlite.gz"), gzipBytes);
  const manifestPath = path.join(dir, "current.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      manifestVersion: 2,
      channel: "production",
      releaseSequence: 7,
      packs: [
        {
          id: "capital",
          version: "1",
          artifactKind: "production",
          url: "catalog/capital-v1.sqlite.gz",
        },
      ],
    })}\n`,
  );
  const outputPath = path.join(dir, "route-graph-topology-report.json");
  const fixtureEvidencePath = path.join(dir, "itx-topology-evidence.json");
  const buildSpecPath = path.join(dir, "candidate-build-spec.json");
  const fixtureEvidence = structuredClone(currentTopologyEvidence);
  const fixtureEvidenceBytes = Buffer.from(`${JSON.stringify(fixtureEvidence)}\n`);
  await writeFile(fixtureEvidencePath, fixtureEvidenceBytes);
  const fixtureBuildSpec = {
    ...currentBuildSpec,
    itxTopologyEvidencePath: fixtureEvidencePath,
    itxTopologyEvidenceSha256: sha256(fixtureEvidenceBytes),
  };
  await writeFile(buildSpecPath, `${JSON.stringify(fixtureBuildSpec)}\n`);
  const malformedEvidence = structuredClone(fixtureEvidence);
  malformedEvidence.topology.edgeCount = -1;
  await writeFile(fixtureEvidencePath, `${JSON.stringify(malformedEvidence)}\n`);

  await assert.rejects(
    main([
      "--manifest",
      manifestPath,
      "--root",
      dir,
      "--build-spec",
      buildSpecPath,
      "--output",
      outputPath,
    ], { repositoryRoot: root }),
    /buildSpec\.itxTopologyEvidenceSha256 must match tracked evidence bytes/,
  );

  await writeFile(fixtureEvidencePath, fixtureEvidenceBytes);
  await main([
    "--manifest",
    manifestPath,
    "--root",
    dir,
    "--build-spec",
    buildSpecPath,
    "--output",
    outputPath,
  ], { repositoryRoot: root });

  const report = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(report.artifactKind, "route-graph-topology-report");
  assert.equal(report.summary.packCount, 1);
  assert.equal(report.summary.localRideAdjacencyViolationCount, 0);
  assert.equal(report.summary.nonAdjacentExpressRideViolationCount, 0);
  assert.equal(report.summary.rideSpeedViolationCount, 0);
  assert.equal(report.summary.unreachableDirectedPairCount, 0);
});

test("route graph topology report는 candidate build spec의 일치하는 pack bytes와 ITX 위상을 검증한다", async (context) => {
  const { sqlitePath, mobilePackBytes, mobileSqliteBytes } = await stageMobileCapitalSqlite(context);
  // #862: 증거 sha·ITX 구간 수는 고정 상수 대신 tracked 증거 파일에서 유도한다(승인 ITX 원천 반영 후 48).
  const trackedEvidenceBytes = await readFile(path.join(root, "tools/datapack/itx-cheongchun-topology-evidence.json"));
  const matchingBuildSpec = {
    ...currentBuildSpec,
    itxTopologyEvidencePath: "tools/datapack/itx-cheongchun-topology-evidence.json",
    itxTopologyEvidenceSha256: sha256(trackedEvidenceBytes),
  };
  const binding = await validateCurrentItxTopologyEvidencePack({
    compressed: mobilePackBytes,
    sqliteBytes: mobileSqliteBytes,
    sqlitePath,
    pack: { id: "capital", version: "1" },
    buildSpec: matchingBuildSpec,
    repositoryRoot: root,
  });

  assert.equal(typeof binding.admittedItxEdgeSetSha256, "string");
  const report = buildRouteGraphTopologyReport(sqlitePath, {
    id: "capital",
    version: "1",
    artifactKind: "production",
  }, binding);
  assert.equal(report.itxServiceLayerSegmentCount, JSON.parse(trackedEvidenceBytes).topology.edgeCount);
});

// #862 첫 전국 RC run(36993677881): RC가 빌드한 pack은 id `nationwide`이고 바이트도 Mobile 번들 capital pack과 다르다.
// ITX topology evidence의 `pack` 블록은 Mobile 번들 pack 변환(apply-itx-topology-to-bundled-pack) 증거이며, 그 바이트 결속은
// release workflow의 `Verify current ITX-청춘 release freshness`(apply --check)가 고정 Mobile fixture로 확인한다.
// RC pack은 바이트가 아니라 ITX 위상 내용(승인 원천에서 유도한 edge 집합)으로 evidence에 결속한다.
test("route graph topology report는 Mobile 번들 pack과 id·바이트가 다른 RC pack도 승인 ITX 위상과 같으면 결속한다", async (context) => {
  const { sqlitePath, sqliteBytes, compressed } = await stageRcPackWithMobileItxEdges(context);
  assert.notEqual(sha256(compressed), currentTopologyEvidence.pack.outputSha256);

  const binding = await validateCurrentItxTopologyEvidencePack({
    compressed,
    sqliteBytes,
    sqlitePath,
    pack: { id: "nationwide", version: "1", artifactKind: "production" },
    buildSpec: currentBuildSpec,
    repositoryRoot: root,
  });

  const report = buildRouteGraphTopologyReport(sqlitePath, {
    id: "nationwide",
    version: "1",
    artifactKind: "production",
  }, binding);
  assert.equal(report.itxServiceLayerSegmentCount, currentTopologyEvidence.topology.edgeCount);
  assert.deepEqual(report.violations.nonAdjacentExpressRide, []);
  assert.deepEqual(report.violations.localRideAdjacency, []);
});

test("route graph topology report는 수·EXPRESS가 같아도 승인 원천과 다른 ITX edge 집합을 fail-closed한다", async (context) => {
  const { sqlitePath, sqliteBytes, compressed } = await stageRcPackWithMobileItxEdges(context, (edges) => {
    const [first, second] = edges;
    first.to_node_id = second.to_node_id === first.to_node_id ? second.from_node_id : second.to_node_id;
    return edges;
  });
  await assert.rejects(
    validateCurrentItxTopologyEvidencePack({
      compressed,
      sqliteBytes,
      sqlitePath,
      pack: { id: "nationwide", version: "1", artifactKind: "production" },
      buildSpec: currentBuildSpec,
      repositoryRoot: root,
    }),
    /ITX topology evidence edge set mismatch/,
  );
});

test("route graph topology report는 승인 원천 위상과 다른 evidence topology identity를 fail-closed한다", async (context) => {
  const { sqlitePath, sqliteBytes, compressed } = await stageRcPackWithMobileItxEdges(context);
  const directory = await mkdtemp(path.join(tmpdir(), "route-graph-topology-identity-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const tampered = structuredClone(currentTopologyEvidence);
  tampered.topology.sha256 = "0".repeat(64);
  const tamperedBytes = Buffer.from(`${JSON.stringify(tampered)}\n`);
  const tamperedPath = path.join(directory, "itx-topology-evidence.json");
  await writeFile(tamperedPath, tamperedBytes);
  await assert.rejects(
    validateCurrentItxTopologyEvidencePack({
      compressed,
      sqliteBytes,
      sqlitePath,
      pack: { id: "nationwide", version: "1", artifactKind: "production" },
      buildSpec: {
        ...currentBuildSpec,
        itxTopologyEvidencePath: tamperedPath,
        itxTopologyEvidenceSha256: sha256(tamperedBytes),
      },
      repositoryRoot: root,
    }),
    /ITX topology evidence topology identity mismatch/,
  );
});

test("route graph topology report는 coverage contract 승인 원천과 다른 evidence source artifact를 fail-closed한다", async (context) => {
  const { sqlitePath, sqliteBytes, compressed } = await stageRcPackWithMobileItxEdges(context);
  const directory = await mkdtemp(path.join(tmpdir(), "route-graph-topology-source-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const tampered = structuredClone(currentTopologyEvidence);
  tampered.sourceArtifact.sha256 = "1".repeat(64);
  const tamperedBytes = Buffer.from(`${JSON.stringify(tampered)}\n`);
  const tamperedPath = path.join(directory, "itx-topology-evidence.json");
  await writeFile(tamperedPath, tamperedBytes);
  await assert.rejects(
    validateCurrentItxTopologyEvidencePack({
      compressed,
      sqliteBytes,
      sqlitePath,
      pack: { id: "nationwide", version: "1", artifactKind: "production" },
      buildSpec: {
        ...currentBuildSpec,
        itxTopologyEvidencePath: tamperedPath,
        itxTopologyEvidenceSha256: sha256(tamperedBytes),
      },
      repositoryRoot: root,
    }),
    /ITX topology evidence source artifact mismatch/,
  );
});

test("route graph topology report는 candidate build spec이어도 ITX 위상 변조를 fail-closed한다", async (context) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "route-graph-mismatch-"));
  context.after(() => rm(tempDir, { recursive: true, force: true }));

  const patternSqlite = createTopologySqlite({
    stationLines: [["station-a", "line-k2", 1], ["station-b", "line-k2", 2]],
    edges: [["edge-a-b-itx", "station-a:line-k2:LOCAL", "station-b:line-k2:LOCAL", "RIDE", "LOCAL", 300, 6000, "ITX_CHEONGCHUN"]],
  });
  context.after(() => rm(patternSqlite, { force: true }));
  const patternBytes = await readFile(patternSqlite);
  const patternGzip = gzipSync(patternBytes);
  const patternEvidence = fixtureTopologyEvidence({
    gzip: patternGzip,
    sqlite: patternBytes,
    edgeCount: 1,
  });
  const patternEvidenceBytes = Buffer.from(`${JSON.stringify(patternEvidence)}\n`);
  const patternEvidencePath = path.join(tempDir, "pattern-evidence.json");
  await writeFile(patternEvidencePath, patternEvidenceBytes);
  const patternBuildSpec = {
    ...currentBuildSpec,
    itxTopologyEvidencePath: patternEvidencePath,
    itxTopologyEvidenceSha256: sha256(patternEvidenceBytes),
  };

  await assert.rejects(
    validateCurrentItxTopologyEvidencePack({
      compressed: patternGzip,
      sqliteBytes: patternBytes,
      sqlitePath: patternSqlite,
      pack: { id: "capital", version: "1" },
      buildSpec: patternBuildSpec,
      repositoryRoot: root,
    }),
    /ITX topology evidence service layer mismatch/,
  );

  const countSqlite = createTopologySqlite({
    stationLines: [["station-a", "line-k2", 1], ["station-b", "line-k2", 2]],
    edges: [["edge-a-b-itx", "station-a:line-k2:EXPRESS", "station-b:line-k2:EXPRESS", "RIDE", "EXPRESS", 300, 6000, "ITX_CHEONGCHUN"]],
  });
  context.after(() => rm(countSqlite, { force: true }));
  const countBytes = await readFile(countSqlite);
  const countGzip = gzipSync(countBytes);
  const countEvidence = fixtureTopologyEvidence({
    gzip: countGzip,
    sqlite: countBytes,
    edgeCount: 2,
  });
  const countEvidenceBytes = Buffer.from(`${JSON.stringify(countEvidence)}\n`);
  const countEvidencePath = path.join(tempDir, "count-evidence.json");
  await writeFile(countEvidencePath, countEvidenceBytes);
  const countBuildSpec = {
    ...currentBuildSpec,
    itxTopologyEvidencePath: countEvidencePath,
    itxTopologyEvidenceSha256: sha256(countEvidenceBytes),
  };

  await assert.rejects(
    validateCurrentItxTopologyEvidencePack({
      compressed: countGzip,
      sqliteBytes: countBytes,
      sqlitePath: countSqlite,
      pack: { id: "capital", version: "1" },
      buildSpec: countBuildSpec,
      repositoryRoot: root,
    }),
    /ITX topology evidence service layer mismatch/,
  );
});

// 고정 Mobile 번들 pack(evidence가 바이트로 결속한 산출물)의 station_lines·ITX RIDE edge row를 읽는다.
// ITX 위상 oracle은 Mobile pack이고 report 구현의 위상 유도를 쓰지 않는다.
async function readMobileItxRows(context) {
  const { sqlitePath: mobileSqlitePath } = await stageMobileCapitalSqlite(context);
  const database = new DatabaseSync(mobileSqlitePath, { readOnly: true });
  try {
    const stationLines = database
      .prepare("SELECT station_id, line_id, line_sequence FROM station_lines ORDER BY line_id, line_sequence, station_id")
      .all()
      .map(({ station_id: stationId, line_id: lineId, line_sequence: lineSequence }) => [stationId, lineId, lineSequence]);
    const itxEdges = database.prepare(`
      SELECT id, from_node_id, to_node_id, edge_type, service_pattern, duration_seconds, distance_meters, service_class
      FROM network_edges
      WHERE edge_type = 'RIDE' AND service_class = 'ITX_CHEONGCHUN'
      ORDER BY id
    `).all().map((edge) => ({ ...edge }));
    assert.equal(itxEdges.length, currentTopologyEvidence.topology.edgeCount);
    return { stationLines, itxEdges, itxEdgeRows: itxEdges.map(itxEdgeRow) };
  } finally {
    database.close();
  }
}

function itxEdgeRow(edge) {
  return [
    edge.id,
    edge.from_node_id,
    edge.to_node_id,
    edge.edge_type,
    edge.service_pattern,
    edge.duration_seconds,
    edge.distance_meters,
    edge.service_class,
  ];
}

// Mobile pack의 station_lines·ITX edge만 옮겨 id·바이트가 다른 RC pack을 만든다.
async function stageRcPackWithMobileItxEdges(context, mutateItxEdges = (edges) => edges) {
  const { stationLines, itxEdges } = await readMobileItxRows(context);
  const sqlitePath = createTopologySqlite({
    stationLines,
    edges: mutateItxEdges(itxEdges).map(itxEdgeRow),
    userVersion: 19,
  });
  context.after(() => rm(sqlitePath, { force: true }));
  const sqliteBytes = await readFile(sqlitePath);
  return { sqlitePath, sqliteBytes, compressed: gzipSync(sqliteBytes) };
}

async function stageMobileCapitalSqlite(context, filename = "capital.sqlite") {
  const directory = await mkdtemp(path.join(tmpdir(), "route-graph-staged-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const sqlitePath = path.join(directory, filename);
  const mobilePackBytes = await readFile(path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"));
  const mobileSqliteBytes = gunzipSync(mobilePackBytes);
  await writeFile(sqlitePath, mobileSqliteBytes);
  return { sqlitePath, mobilePackBytes, mobileSqliteBytes };
}

function fixtureTopologyEvidence({ gzip, sqlite, edgeCount }) {
  const evidence = structuredClone(currentTopologyEvidence);
  evidence.topology.edgeCount = edgeCount;
  evidence.pack.outputSha256 = sha256(gzip);
  evidence.pack.outputSqliteSha256 = sha256(sqlite);
  evidence.pack.byteSize = gzip.byteLength;
  evidence.pack.byteSizeDelta = gzip.byteLength - evidence.pack.inputByteSize;
  return evidence;
}

function createTopologySqlite({ stationLines, edges, userVersion = 0 }) {
  const sqlitePath = path.join(tmpdir(), `route-graph-topology-${Date.now()}-${Math.random()}.sqlite`);
  const database = new DatabaseSync(sqlitePath);
  try {
    database.exec(`
      CREATE TABLE station_lines (
        station_id TEXT NOT NULL,
        line_id TEXT NOT NULL,
        line_sequence INTEGER NOT NULL
      );
      CREATE TABLE network_edges (
        id TEXT NOT NULL,
        from_node_id TEXT NOT NULL,
        to_node_id TEXT NOT NULL,
        edge_type TEXT NOT NULL,
        service_pattern TEXT NOT NULL,
        service_class TEXT NOT NULL DEFAULT 'SUBWAY',
        duration_seconds INTEGER NOT NULL,
        distance_meters INTEGER NOT NULL
      );
      PRAGMA user_version = ${userVersion};
    `);
    const insertStationLine = database.prepare("INSERT INTO station_lines VALUES (?, ?, ?)");
    const insertEdge = database.prepare(`
      INSERT INTO network_edges (
        id, from_node_id, to_node_id, edge_type, service_pattern,
        duration_seconds, distance_meters, service_class
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of stationLines) {
      insertStationLine.run(...row);
    }
    for (const row of edges) {
      insertEdge.run(...row, ...(row.length === 7 ? ["SUBWAY"] : []));
    }
  } finally {
    database.close();
  }
  return sqlitePath;
}
