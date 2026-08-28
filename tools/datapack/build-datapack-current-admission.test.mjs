import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  admittedIncheonTopologyEvidence,
  admittedPinnedIncheonAccessibilityEvidence,
  admittedItxNetworkEdgeEvidence,
  applyCandidateReleaseIdentity,
  candidateNetworkEdgeEvidence,
  materializeIncheonNetworkEdges,
  projectIncheonNetworkEdges,
  projectCandidateFixtureForAccessibilityAuthority,
  validateTrackedItxTopologyEvidence,
  validateProductionIncheonNetworkEdgeFixture,
  validateSourceSeparatedCurrentTopology,
  validateCapitalTopologyReverification,
  validateItxCurrentTopologyAdmission,
  validateCandidateProductionScope,
  productionAccessibilityFreshUntil,
  main as buildDatapackMain,
} from "./build-datapack.mjs";
import {
  admittedIncheonAccessibilityEvidence,
  validateProductionIncheonAccessibilityFixture,
} from "./materialize-incheon-accessibility.mjs";
import { incheonStationInfoPackSource } from "./materialize-incheon-station-info.mjs";
import {
  buildCapitalTopologyReverificationEvidence,
  projectCapitalTopologyOwnership,
} from "./collect-capital-route-topology.mjs";
import { activateCurrentIncheonSourceAdmissions } from "./activate-current-source-set.mjs";
import { retainPreAuthorityRideEdges } from "./apply-accessibility-evidence-to-bundled-pack.mjs";
import { materializeStationLineAccessibility } from "./materialize-station-line-accessibility.mjs";
import {
  materializeCurrentFanInCandidateArtifact,
  prepareCurrentFullCapitalProductionRepository,
} from "./test-fixtures/current-full-capital-production-artifact.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const currentNow = new Date("2026-08-10T00:00:00.000Z");
const PUBLIC_ROUTE_MAP_SOURCE_ID = "seoul-metro-route-map-positions";

const PUBLIC_ROUTE_MAP_LINE_IDS = Object.freeze([
  "line-472a81add377", "seoul-2", "line-41a8c75ec9d8", "seoul-4",
  "line-80fc4d5350d4", "line-3f41718e0833", "line-15b3b8a93259", "line-2b2d9eaa53d0",
]);

async function withEnvironment(values, action) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    return await action();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("build-datapack은 candidate mode만 staged transition을 입력보다 먼저 차단한다", async () => {
  const source = await readFile(path.join(root, "tools/datapack/build-datapack.mjs"), "utf8");
  const candidateMode = source.indexOf('if (args["build-spec"] != null) {');
  const guard = source.indexOf("await assertCurrentCapitalAccessibilityBuildAllowed({ repositoryRoot: root });");
  const buildInput = source.indexOf("await loadBuildInput(");
  assert.ok(candidateMode >= 0, "staged transition guard는 candidate mode에만 적용돼야 한다");
  assert.ok(guard >= 0, "staged transition guard가 필요하다");
  assert.ok(candidateMode < guard, "candidate mode를 확인한 뒤 guard를 실행해야 한다");
  assert.ok(guard < buildInput, "staged transition guard는 candidate 입력보다 먼저 실행돼야 한다");
});
test("retired production transit unprojected fixture는 candidate admission에서 거부된다", async () => {
  const [fixture, policyBytes] = await Promise.all([
    readFile(path.join(root, "tools/datapack/release/capital-production-canonical-pack.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json")),
  ]);
  const buildSpec = { productionScopePolicy: {
    path: "tools/datapack/nationwide-coverage-targets.json", sha256: sha256(policyBytes),
  } };
  await assert.doesNotReject(validateCandidateProductionScope(buildSpec, fixture));
  const unprojected = structuredClone(fixture);
  const pack = unprojected.packs.find(({ id }) => id === "capital");
  const lineId = "line-cbe75f5287a1";
  const stationIds = ["station-04529af2869a", "station-4404e10fdfef", "station-ae2b5b5f2ea5", "station-bdd848e7e432", "station-f311bc307610", "station-fce26411d581"];
  pack.operators.push({ id: "operator-145e4415ee1f", nameKo: "인천공항 자기부상" });
  pack.lines.push({ id: lineId, operatorId: "operator-145e4415ee1f", nameKo: "수도권 자기부상" });
  pack.stationLines.push(...stationIds.map((stationId, index) => ({ stationId, lineId, stationCode: String(index + 1), lineSequence: index + 1, platformInfo: "" })));
  await assert.rejects(
    validateCandidateProductionScope(buildSpec, unprojected),
    /retired transit remains in production fixture/,
  );
});

function rehashAdmission(admission) {
  delete admission.evidenceHash;
  admission.evidenceHash = sha256(Buffer.from(JSON.stringify(admission)));
  return admission;
}

function networkEdgeEvidenceFixture() {
  return {
    sourceInventory: { path: "source-inventory.json", sha256: "1".repeat(64) },
    capitalTopology: {
      path: "capital-topology.json",
      sha256: "2".repeat(64),
      snapshotId: "capital-route-topology-20260809",
    },
    capitalTopologyAdmission: {
      schemaVersion: 1,
      artifactKind: "capital-network-edge-admission",
      issue: 2649,
      status: "ADMITTED",
      snapshotId: "capital-route-topology-20260809",
      contentSha256: "3".repeat(64),
      reviewedAt: "2026-08-09T12:04:20.479Z",
      reverifiedAt: "2026-08-09T12:04:20.479Z",
      freshUntil: "2026-08-20T00:00:00.000Z",
    },
    capitalTopologyCandidate: {
      path: "capital-topology-candidate.json",
      sha256: "4".repeat(64),
      snapshotId: "capital-route-topology-20260809",
    },
    capitalTopologyReverification: {
      path: "capital-topology-reverification.json",
      sha256: "5".repeat(64),
    },
    itxCoverageContract: { path: "itx-coverage.json", sha256: "6".repeat(64) },
  };
}

test("candidate build spec release identity는 wall clock과 workflow run number에 무관하다", async (context) => {
  const directory = await prepareCurrentFullCapitalProductionRepository(root);
  context.after(() => rm(directory, { recursive: true, force: true }));
  const buildSpecPath = "tools/datapack/release/candidate-build-spec.json";
  const buildSpecBytes = await readFile(path.join(directory, buildSpecPath));
  const buildSpec = JSON.parse(buildSpecBytes);
  const topologyAdmission = buildSpec.networkEdgeEvidence.capitalTopologyAdmission;
  const firstBuildAt = Math.max(
    Date.parse(buildSpec.publishedAt),
    Date.parse(topologyAdmission.reverifiedAt),
  );
  const secondBuildAt = firstBuildAt + 1_000;
  assert.ok(Number.isFinite(firstBuildAt));
  assert.ok(secondBuildAt < Date.parse(topologyAdmission.freshUntil));
  const firstBuildNow = new Date(firstBuildAt).toISOString();
  const secondBuildNow = new Date(secondBuildAt).toISOString();
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const candidateStationLine = path.join(directory, "candidate-station-line-input.json");
  const candidateRouteEdge = path.join(directory, "candidate-route-edge-input.json");
  const candidateFixture = path.join(directory, "candidate-fixture.json");
  const routeCoverageAuthority = path.join(directory, "server-route-coverage-authority.json");
  await materializeCurrentFanInCandidateArtifact({
    repositoryRoot: directory, stationLineOutput: candidateStationLine, routeEdgeOutput: candidateRouteEdge,
    fixtureOutput: candidateFixture, authorityOutput: routeCoverageAuthority,
  });
  const directOutput = path.join(directory, "direct-build");
  await assert.rejects(
    withEnvironment({
      EASYSUBWAY_DATAPACK_BUILD_NOW: firstBuildNow,
      EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKey,
      EASYSUBWAY_DATAPACK_SIGNING_KEY_ID: "production-v1",
    }, () => buildDatapackMain([
      "--build-spec", buildSpecPath,
      "--output", directOutput,
    ], { repositoryRoot: directory })),
    /production accessibility evidence mismatch/,
  );
  await assert.rejects(readFile(path.join(directOutput, "current.json")), /ENOENT/);
  const validationOnlyFixturePath = "validation-only-source-fixture.json";
  const validationOnlyBuildSpecPath = "validation-only-build-spec.json";
  const sourceFixture = JSON.parse(await readFile(path.join(directory, buildSpec.fixturePath)));
  const validationOnlyFixture = await projectCandidateFixtureForAccessibilityAuthority({
    buildSpec,
    sourceFixture,
    repositoryRoot: directory,
  });
  const sourcePack = retainPreAuthorityRideEdges(sourceFixture, "validation-only source").packs
    .find(({ id }) => id === "capital");
  const validationOnlyPack = validationOnlyFixture.packs.find(({ id }) => id === "capital");
  validationOnlyPack.networkEdges = structuredClone(sourcePack.networkEdges);
  validationOnlyPack.outOfStationTransferLinks = structuredClone(sourcePack.outOfStationTransferLinks);
  await Promise.all([
    writeFile(
      path.join(directory, validationOnlyFixturePath),
      `${JSON.stringify(validationOnlyFixture, null, 2)}\n`,
    ),
    writeFile(
      path.join(directory, validationOnlyBuildSpecPath),
      `${JSON.stringify({ ...buildSpec, fixturePath: validationOnlyFixturePath }, null, 2)}\n`,
    ),
  ]);
  const validationOnlyOutput = path.join(directory, "validation-only-build");
  await withEnvironment({
    EASYSUBWAY_DATAPACK_BUILD_NOW: firstBuildNow,
    EASYSUBWAY_DATAPACK_BUILD_SPEC_VALIDATION_ONLY: "true",
    EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKey,
    EASYSUBWAY_DATAPACK_SIGNING_KEY_ID: "production-v1",
  }, () => buildDatapackMain([
    "--build-spec", validationOnlyBuildSpecPath,
    "--output", validationOnlyOutput,
  ], { repositoryRoot: directory }));
  const validationOnlyManifest = JSON.parse(await readFile(
    path.join(validationOnlyOutput, "current.json"),
    "utf8",
  ));
  const validationOnlyProvenance = JSON.parse(await readFile(
    path.join(validationOnlyOutput, "current.provenance.json"),
    "utf8",
  ));
  assert.equal(validationOnlyManifest.channel, "dev");
  assert.deepEqual(
    validationOnlyManifest.packs.map(({ artifactKind }) => artifactKind),
    ["fixture"],
  );
  assert.deepEqual(
    validationOnlyProvenance.packs.map(({ artifactKind }) => artifactKind),
    ["fixture"],
  );
  async function build(name, buildNow, runNumber) {
    const output = path.join(directory, name);
    await withEnvironment({
      EASYSUBWAY_DATAPACK_BUILD_NOW: buildNow,
      EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKey,
      EASYSUBWAY_DATAPACK_SIGNING_KEY_ID: "production-v1",
      GITHUB_RUN_NUMBER: runNumber,
    }, () => buildDatapackMain([
      "--build-spec", buildSpecPath,
      "--candidate-fixture-override", candidateFixture,
      "--server-route-coverage-authority", routeCoverageAuthority,
      "--current-capital-station-line-input", candidateStationLine,
      "--current-capital-route-edge-input", candidateRouteEdge,
      "--output", output,
    ], { repositoryRoot: directory }));
    return {
      manifest: await readFile(path.join(output, "current.json")),
      provenance: await readFile(path.join(output, "current.provenance.json")),
      sqlite: await readFile(path.join(output, "catalog/capital-v1.sqlite")),
      gzip: await readFile(path.join(output, "catalog/capital-v1.sqlite.gz")),
    };
  }

  try {
    await readFile(path.join(root, "tools/datapack/release/current-capital-accessibility-transition.json"));
    await assert.rejects(
      build("transition-blocked", secondBuildNow, "303"),
      /CURRENT_ACCESSIBILITY_TRANSITION_BLOCKED/,
    );
    await assert.rejects(
      readFile(path.join(directory, "transition-blocked/current.json")),
      /ENOENT/,
    );
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const first = await build("first", firstBuildNow, "101");
  const second = await build("second", secondBuildNow, "202");
  const manifest = JSON.parse(first.manifest);
  const provenance = JSON.parse(first.provenance);
  const snapshots = await readFile(
    path.join(directory, "tools/datapack/release/source-snapshots.json"),
    "utf8",
  ).then(JSON.parse);
  const publicSnapshot = snapshots.find(({ sourceId }) => sourceId === PUBLIC_ROUTE_MAP_SOURCE_ID);
  assert.ok(publicSnapshot?.routeMapLayoutArtifact);

  assert.equal(manifest.publishedAt, buildSpec.publishedAt);
  assert.equal(manifest.releaseSequence, buildSpec.releaseSequence);
  assert.equal(provenance.candidateBuild.publishedAt, buildSpec.publishedAt);
  assert.equal(provenance.candidateBuild.releaseSequence, buildSpec.releaseSequence);
  for (const key of ["manifest", "provenance", "sqlite", "gzip"]) {
    assert.deepEqual(first[key], second[key], `${key} bytes drifted`);
  }
  const database = new DatabaseSync(path.join(directory, "first/catalog/capital-v1.sqlite"), {
    readOnly: true,
  });
  try {
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM route_map_positions WHERE source_id = ?",
    ).get(PUBLIC_ROUTE_MAP_SOURCE_ID).count, publicSnapshot.routeMapLayoutArtifact.rawPositions.length);
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM route_map_positions WHERE source_id = ?",
    ).get("seoulmetro-cyberstation-route-map").count, 0);
    assert.deepEqual(database.prepare(
      "SELECT DISTINCT line_id FROM route_map_positions WHERE source_id = ? ORDER BY line_id",
    ).all(PUBLIC_ROUTE_MAP_SOURCE_ID).map(({ line_id: lineId }) => lineId), [...PUBLIC_ROUTE_MAP_LINE_IDS].sort());
  } finally {
    database.close();
  }
  for (const field of ["route_map_position", "route_map_label_polygon"]) {
    const records = provenance.packs.flatMap(({ records: rows }) => rows).filter(
      ({ sourceId, field: recordField }) => sourceId === PUBLIC_ROUTE_MAP_SOURCE_ID && recordField === field,
    );
    assert.ok(records.length > 0, `provenance missing field: ${field}`);
    assert.deepEqual(
      [...new Set(records.flatMap(({ coverageScope }) => coverageScope?.lineIds ?? []))].sort(),
      [...PUBLIC_ROUTE_MAP_LINE_IDS].sort(),
    );
  }

  const missingPublishedAt = structuredClone(buildSpec);
  delete missingPublishedAt.publishedAt;
  assert.throws(
    () => applyCandidateReleaseIdentity(missingPublishedAt, { manifest: {} }),
    /buildSpec\.publishedAt must be a non-empty string/,
  );
  assert.throws(
    () => applyCandidateReleaseIdentity(
      { ...buildSpec, publishedAt: "2026-08-14T15:34:07.000" },
      { manifest: {} },
    ),
    /buildSpec\.publishedAt must include timezone offset/,
  );
  assert.throws(
    () => applyCandidateReleaseIdentity({ ...buildSpec, releaseSequence: 0 }, { manifest: {} }),
    /buildSpec\.releaseSequence must be a positive integer/,
  );
  assert.throws(
    () => applyCandidateReleaseIdentity(buildSpec, {
      manifest: { publishedAt: "2026-08-14T15:34:08.000Z" },
    }),
    /manifest\.publishedAt must match buildSpec\.publishedAt/,
  );
  assert.throws(
    () => applyCandidateReleaseIdentity(buildSpec, { manifest: { releaseSequence: 2 } }),
    /manifest\.releaseSequence must match buildSpec\.releaseSequence/,
  );
});

test("candidate override accessibility freshness는 authority input identity와 earliest expiry에 결속된다", async () => {
  const stationLineInputBytes = await readFile(path.join(
    root,
    "tools/datapack/release/current-capital-accessibility-full/station-line-input.json",
  ));
  const stationLineInput = JSON.parse(stationLineInputBytes);
  const observedAt = new Date(Math.max(...stationLineInput.evidenceRows
    .map(({ capturedAt }) => Date.parse(capturedAt)))).toISOString();
  const materialization = materializeStationLineAccessibility({
    ...stationLineInput,
    observedAt,
  });
  const authority = {
    candidate: stationLineInput.candidate,
    buildInput: {
      stationLineInputSha256: sha256(stationLineInputBytes),
      materializationDigest: materialization.materializationDigest,
      observedAt,
    },
  };
  const { candidateOverrideAccessibilityFreshUntil } = await import("./build-datapack.mjs");
  const expected = new Date(Math.min(...stationLineInput.evidenceRows
    .map(({ freshUntil }) => Date.parse(freshUntil)))).toISOString();

  assert.equal(candidateOverrideAccessibilityFreshUntil({
    authority,
    stationLineInputBytes,
    validationNow: new Date("2026-08-14T15:34:07.000Z"),
  }), expected);
  assert.throws(() => candidateOverrideAccessibilityFreshUntil({
    authority,
    stationLineInputBytes,
    validationNow: new Date(expected),
  }), /station-line input accessibility evidence is stale/);
  assert.throws(() => candidateOverrideAccessibilityFreshUntil({
    authority: {
      ...authority,
      buildInput: { ...authority.buildInput, stationLineInputSha256: "0".repeat(64) },
    },
    stationLineInputBytes,
    validationNow: new Date("2026-08-14T15:34:07.000Z"),
  }), /station-line input identity mismatch/);
  assert.throws(() => candidateOverrideAccessibilityFreshUntil({
    authority: {
      ...authority,
      buildInput: { ...authority.buildInput, observedAt: "2026-08-18T00:00:00.000Z" },
    },
    stationLineInputBytes,
    validationNow: new Date("2026-08-14T15:34:07.000Z"),
  }), /station-line input identity mismatch/);
});

test("source-separated current topology는 capital과 Incheon 1/2 line ownership을 겹치지 않는다", async () => {
  const [capital, incheon] = await Promise.all([
    readFile(path.join(root, "tools/datapack/sources/capital-route-topology-20260724.json"), "utf8")
      .then(JSON.parse),
    readFile(path.join(root, "tools/datapack/sources/incheon-transit-station-info-20260828.json"), "utf8")
      .then(JSON.parse),
  ]);
  const projectedCapital = projectCapitalTopologyOwnership(capital);

  assert.deepEqual(
    validateSourceSeparatedCurrentTopology({ capitalTopology: projectedCapital, incheonSnapshot: incheon }),
    {
      capitalLineCount: projectedCapital.lineCount,
      incheonLineIds: ["line-42b5805f3b5a", "line-98718184f016"],
      incheonEdgeCount: 116,
    },
  );
  assert.throws(
    () => validateSourceSeparatedCurrentTopology({ capitalTopology: capital, incheonSnapshot: incheon }),
    /topology line ownership overlap/,
  );
  const missingCapitalLine = structuredClone(projectedCapital);
  missingCapitalLine.lines = missingCapitalLine.lines.slice(1);
  missingCapitalLine.lineCount = missingCapitalLine.lines.length;
  missingCapitalLine.totalEdgeCount = missingCapitalLine.lines
    .reduce((sum, { edgeCount }) => sum + edgeCount, 0);
  missingCapitalLine.contentSha256 = sha256(Buffer.from(JSON.stringify({
    lines: missingCapitalLine.lines.map(({
      lineId, edgeCount, stationCount, contentSha256, rawSha256, datasetId,
    }) => ({ lineId, edgeCount, stationCount, contentSha256, rawSha256, datasetId })),
    topologyGaps: missingCapitalLine.topologyGaps,
  })));
  assert.throws(
    () => validateSourceSeparatedCurrentTopology({
      capitalTopology: missingCapitalLine,
      incheonSnapshot: incheon,
    }),
    /capital topology ownership is invalid/,
  );
});

test("source-separated current topology materialization은 Incheon 1/2 exact 116 edges만 교체한다", async () => {
  const inventory = await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8").then(JSON.parse);
  const sourceDir = path.join(root, "tools/datapack/sources");
  const topologySnapshotName = (await readdir(sourceDir))
    .filter((name) => /^incheon-transit-station-info-[0-9]{8}\.json$/u.test(name))
    .sort()
    .at(-1);
  if (topologySnapshotName == null) {
    throw new Error("current Incheon topology admission is missing");
  }
  const topologySnapshotPath = `tools/datapack/sources/${topologySnapshotName}`;
  const snapshotBytes = await readFile(path.join(root, topologySnapshotPath));
  const snapshot = JSON.parse(snapshotBytes);
  const dateParts = Object.fromEntries(new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(snapshot.capturedAt)).map(({ type, value }) => [type, value]));
  const compactDate = `${dateParts.year}${dateParts.month}${dateParts.day}`;
  const accessibilitySnapshotPath = `tools/datapack/sources/incheon-transit-accessibility-${compactDate}.json`;
  const timetableSnapshotPaths = {
    1: `tools/datapack/sources/incheon-line1-train-timetable-${compactDate}.json`,
    2: `tools/datapack/sources/incheon-line2-train-timetable-${compactDate}.json`,
  };
  const [accessibilityBytes, line1TimetableBytes, line2TimetableBytes, fixture] = await Promise.all([
    readFile(path.join(root, accessibilitySnapshotPath)),
    readFile(path.join(root, timetableSnapshotPaths[1])),
    readFile(path.join(root, timetableSnapshotPaths[2])),
    readFile(path.join(root, "tools/datapack/release/capital-production-canonical-pack.json"), "utf8")
      .then(JSON.parse),
  ]);
  const accessibilitySnapshot = JSON.parse(accessibilityBytes);
  const timetableSnapshots = {
    1: JSON.parse(line1TimetableBytes),
    2: JSON.parse(line2TimetableBytes),
  };
  const now = new Date(Math.max(
    Date.parse(snapshot.capturedAt),
    Date.parse(accessibilitySnapshot.capturedAt),
    ...Object.values(timetableSnapshots).map(({ capturedAt }) => Date.parse(capturedAt)),
  ) + 1);
  const currentInventory = activateCurrentIncheonSourceAdmissions({
    sourceInventory: inventory,
    topologySnapshot: snapshot,
    topologySnapshotBytes: snapshotBytes,
    topologySnapshotPath,
    accessibilitySnapshot,
    accessibilitySnapshotBytes: accessibilityBytes,
    accessibilitySnapshotPath,
    timetableSnapshots,
    timetableSnapshotBytes: { 1: line1TimetableBytes, 2: line2TimetableBytes },
    timetableSnapshotPaths,
    now: now.toISOString(),
  });
  const incheonAdmission = currentInventory.sources.find(({ id }) => id === "incheon-transit-station-info")
    ?.topologyAdmissionEvidence;
  if (!incheonAdmission?.snapshotId || !incheonAdmission?.freshUntil) {
    throw new Error("current Incheon topology admission is missing");
  }
  const legacyCorrectionSnapshot = structuredClone(snapshot);
  legacyCorrectionSnapshot.stationCodeCorrections = [];
  const legacyCorrectionBytes = Buffer.from(`${JSON.stringify(legacyCorrectionSnapshot)}\n`);
  assert.throws(() => admittedIncheonTopologyEvidence({
    sourceInventory: currentInventory,
    snapshot: legacyCorrectionSnapshot,
    snapshotBytes: legacyCorrectionBytes,
    now,
  }), /current Incheon legacy station code corrections are forbidden/);
  const admission = admittedIncheonTopologyEvidence({
    sourceInventory: currentInventory,
    snapshot,
    snapshotBytes,
    now,
  });
  const accessibilityAdmission = admittedIncheonAccessibilityEvidence({
    sourceInventory: currentInventory,
    snapshot: accessibilitySnapshot,
    topologySnapshot: snapshot,
    now,
  });
  assert.equal(accessibilityAdmission.snapshotId,
    currentInventory.sources.find(({ id }) => id === "incheon-transit-accessibility")
      .accessibilityAdmissionEvidence.snapshotId);
  assert.equal(accessibilityAdmission.freshUntil, accessibilitySnapshot.freshUntil);
  const accessibilityPin = {
    path: accessibilitySnapshotPath,
    sha256: sha256(accessibilityBytes),
    snapshotId: accessibilityAdmission.snapshotId,
  };
  assert.deepEqual(await admittedPinnedIncheonAccessibilityEvidence(accessibilityPin, {
    sourceInventory: currentInventory,
    topologySnapshot: snapshot,
    repositoryRoot: root,
    now,
  }), accessibilityAdmission);
  await assert.rejects(admittedPinnedIncheonAccessibilityEvidence({
    ...accessibilityPin,
    sha256: "0".repeat(64),
  }, {
    sourceInventory: currentInventory,
    topologySnapshot: snapshot,
    repositoryRoot: root,
    now,
  }), /sha256 must match tracked input bytes/);
  await assert.rejects(admittedPinnedIncheonAccessibilityEvidence({
    ...accessibilityPin,
    snapshotId: "incheon-transit-accessibility-20260827",
  }, {
    sourceInventory: currentInventory,
    topologySnapshot: snapshot,
    repositoryRoot: root,
    now,
  }), /pinned Incheon accessibility admission identity mismatch/);
  const pack = structuredClone(fixture.packs[0]);
  const stationInfoSource = incheonStationInfoPackSource(admission.source, snapshot);
  assert.equal(stationInfoSource.sourceSha256, snapshot.rawSha256);
  assert.equal(stationInfoSource.updatedAt, snapshot.capturedAt);
  assert.deepEqual(stationInfoSource.coverageScope, admission.source.coverageScope);
  const existingStationInfoSource = pack.sourceInventory.find(({ id }) => id === stationInfoSource.id);
  if (existingStationInfoSource == null) {
    pack.sourceInventory.push(stationInfoSource);
  } else {
    assert.deepEqual(existingStationInfoSource, stationInfoSource);
  }
  const incheonLineIds = new Set(["line-42b5805f3b5a", "line-98718184f016"]);
  const unrelatedBefore = pack.networkEdges.filter(({ fromNodeId }) => (
    !incheonLineIds.has(fromNodeId.split(":").at(-1))
  ));

  assert.deepEqual(materializeIncheonNetworkEdges(pack, snapshot, admission), {
    snapshotId: incheonAdmission.snapshotId,
    edgeCount: snapshot.edgeCount,
  });
  assert.deepEqual(pack.sourceInventory.find(({ id }) => id === stationInfoSource.id), stationInfoSource);
  assert.deepEqual(materializeIncheonNetworkEdges(pack, snapshot, admission), {
    snapshotId: incheonAdmission.snapshotId,
    edgeCount: snapshot.edgeCount,
  });
  assert.deepEqual(pack.sourceInventory.find(({ id }) => id === stationInfoSource.id), stationInfoSource);
  const sourceShaDrift = structuredClone(pack);
  sourceShaDrift.sourceInventory.find(({ id }) => id === stationInfoSource.id).sourceSha256 = "0".repeat(64);
  assert.throws(
    () => materializeIncheonNetworkEdges(sourceShaDrift, snapshot, admission),
    /Incheon topology pack source inventory mismatch/,
  );
  const coverageDrift = structuredClone(pack);
  coverageDrift.sourceInventory.find(({ id }) => id === stationInfoSource.id).coverageScope.lineIds.pop();
  assert.throws(
    () => materializeIncheonNetworkEdges(coverageDrift, snapshot, admission),
    /Incheon topology pack source inventory mismatch/,
  );
  const duplicateSource = structuredClone(pack);
  duplicateSource.sourceInventory.push(structuredClone(stationInfoSource));
  assert.throws(
    () => materializeIncheonNetworkEdges(duplicateSource, snapshot, admission),
    /Incheon topology pack source inventory mismatch/,
  );
  const incheonEdges = pack.networkEdges.filter(({ fromNodeId }) => (
    incheonLineIds.has(fromNodeId.split(":").at(-1))
  ));
  assert.equal(incheonEdges.length, snapshot.edgeCount);
  assert.equal(incheonEdges.every(({ sourceId }) => sourceId === "incheon-transit-station-info"), true);
  assert.deepEqual(incheonEdges, projectIncheonNetworkEdges(pack, snapshot, admission));
  assert.doesNotThrow(() => validateProductionIncheonNetworkEdgeFixture(pack, incheonEdges));
  assert.throws(() => validateProductionIncheonNetworkEdgeFixture({
    ...pack,
    networkEdges: pack.networkEdges.filter(({ id }) => id !== incheonEdges[0].id),
  }, incheonEdges), /does not match pinned admission/);
  const driftedIncheonEdge = { ...incheonEdges[0], evidenceHash: "0".repeat(64) };
  assert.throws(() => validateProductionIncheonNetworkEdgeFixture({
    ...pack,
    networkEdges: pack.networkEdges.map((edge) => edge.id === driftedIncheonEdge.id
      ? driftedIncheonEdge
      : edge),
  }, incheonEdges), /does not match pinned admission/);
  const wrongIdIncheonEdge = { ...incheonEdges[0], id: `${incheonEdges[0].id}-wrong` };
  assert.throws(() => validateProductionIncheonNetworkEdgeFixture({
    ...pack,
    networkEdges: pack.networkEdges.map((edge) => edge.id === incheonEdges[0].id
      ? wrongIdIncheonEdge
      : edge),
  }, incheonEdges), /does not match pinned admission/);
  const missingProvenanceEdge = { ...incheonEdges[0] };
  delete missingProvenanceEdge.evidenceHash;
  assert.throws(() => validateProductionIncheonNetworkEdgeFixture({
    ...pack,
    networkEdges: pack.networkEdges.map((edge) => edge.id === missingProvenanceEdge.id
      ? missingProvenanceEdge
      : edge),
  }, incheonEdges), /does not match pinned admission/);
  assert.throws(() => validateProductionIncheonNetworkEdgeFixture({
    ...pack,
    networkEdges: [...pack.networkEdges, {
      id: "edge-unrelated-provenance",
      edgeType: "TRANSFER",
      sourceId: "unrelated-provenance-source",
    }],
  }, incheonEdges), /production network edge fixture must not contain provenance/);
  assert.deepEqual(
    pack.networkEdges.filter(({ fromNodeId }) => !incheonLineIds.has(fromNodeId.split(":").at(-1))),
    unrelatedBefore,
  );
  for (const stationId of ["station-62fe7e203078", "station-b78008d08d1f", "station-996efa447ecf"]) {
    assert.equal(incheonEdges.some(({ fromNodeId }) => (
      fromNodeId === `${stationId}:line-98718184f016`
    )), true);
  }
  assert.throws(() => admittedIncheonTopologyEvidence({
    sourceInventory: currentInventory,
    snapshot,
    snapshotBytes,
    now: new Date(Date.parse(incheonAdmission.freshUntil) + 1),
  }), /Incheon topology admission is stale/);

  const accessibilityFixture = {
    facilities: structuredClone(accessibilityAdmission.fixtureRows.facilities),
    stationFacilityEvidence: structuredClone(accessibilityAdmission.fixtureRows.evidence),
  };
  assert.doesNotThrow(() => validateProductionIncheonAccessibilityFixture(
    [accessibilityFixture], accessibilityAdmission,
  ));
  assert.equal(productionAccessibilityFreshUntil(
    [accessibilityFixture],
    currentInventory,
    [],
    now,
    { admittedNonLedgerAccessibility: new Map([[accessibilityAdmission.source.id, accessibilityAdmission]]) },
  ), accessibilityAdmission.freshUntil);
  assert.throws(() => productionAccessibilityFreshUntil(
    [accessibilityFixture], currentInventory, [], now,
  ), /production accessibility snapshot mismatch: incheon-transit-accessibility/);
  const wrongEvidenceFixture = structuredClone(accessibilityFixture);
  wrongEvidenceFixture.facilities[0].evidenceHash = "0".repeat(64);
  assert.throws(() => validateProductionIncheonAccessibilityFixture(
    [wrongEvidenceFixture], accessibilityAdmission,
  ), /does not match pinned admission/);
  const wrongSemanticFixture = structuredClone(accessibilityFixture);
  wrongSemanticFixture.stationFacilityEvidence[0].strictRouteEligible = true;
  assert.throws(() => validateProductionIncheonAccessibilityFixture(
    [wrongSemanticFixture], accessibilityAdmission,
  ), /does not match pinned admission/);
  const missingFacilityFixture = structuredClone(accessibilityFixture);
  missingFacilityFixture.facilities.pop();
  assert.throws(() => validateProductionIncheonAccessibilityFixture(
    [missingFacilityFixture], accessibilityAdmission,
  ), /does not match pinned admission/);
  const wrongIdentityFixture = structuredClone(accessibilityFixture);
  wrongIdentityFixture.facilities[0].id = `${wrongIdentityFixture.facilities[0].id}-wrong`;
  assert.throws(() => validateProductionIncheonAccessibilityFixture(
    [wrongIdentityFixture], accessibilityAdmission,
  ), /does not match pinned admission/);
  const unrelatedFixture = structuredClone(accessibilityFixture);
  const ledgerOnlySource = currentInventory.sources.find(({ id }) =>
    id === "kric-station-convenience-standard");
  unrelatedFixture.facilities[0] = {
    ...unrelatedFixture.facilities[0],
    sourceId: ledgerOnlySource.id,
    sourceSnapshotId: ledgerOnlySource.accessibilityAdmissionEvidence.snapshotId,
    evidenceHash: ledgerOnlySource.accessibilityAdmissionEvidence.rowsSha256,
  };
  assert.throws(() => productionAccessibilityFreshUntil(
    [unrelatedFixture], currentInventory, [], now,
    { admittedNonLedgerAccessibility: new Map([[accessibilityAdmission.source.id, accessibilityAdmission]]) },
  ), /production accessibility snapshot mismatch: kric-station-convenience-standard/);
});

test("networkEdgeEvidence는 current source evidence와 historical topology overlay를 구분한다", () => {
  const previousBuildNow = process.env.EASYSUBWAY_DATAPACK_BUILD_NOW;
  process.env.EASYSUBWAY_DATAPACK_BUILD_NOW = currentNow.toISOString();
  try {
    const legacy = networkEdgeEvidenceFixture();
    assert.equal(
      Object.hasOwn(candidateNetworkEdgeEvidence(legacy), "itxCurrentTopologyAdmissionSha256"),
      false,
    );

    const current = {
      ...legacy,
      itxCurrentTopologyAdmission: {
        path: "tools/datapack/itx-current-network-edge-admission-20260810.json",
        sha256: "7".repeat(64),
      },
    };
    assert.equal(
      candidateNetworkEdgeEvidence(current).itxCurrentTopologyAdmissionSha256,
      "7".repeat(64),
    );
    assert.throws(
      () => candidateNetworkEdgeEvidence({ ...current, unknown: true }),
      /unknown is not allowed/,
    );
  } finally {
    if (previousBuildNow === undefined) delete process.env.EASYSUBWAY_DATAPACK_BUILD_NOW;
    else process.env.EASYSUBWAY_DATAPACK_BUILD_NOW = previousBuildNow;
  }
});

test("capital topology reverification은 combined current candidate를 거부한다", async () => {
  const [baseline, candidate, reverification] = await Promise.all([
    readFile(path.join(root, "tools/datapack/sources/capital-route-topology-20260724.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/sources/capital-route-topology-20260804.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/capital-topology-reverification-20260804.json"), "utf8").then(JSON.parse),
  ]);
  const admission = {
    schemaVersion: 1,
    artifactKind: "capital-network-edge-admission",
    issue: 2649,
    status: "ADMITTED",
    snapshotId: "capital-route-topology-20260804",
    contentSha256: candidate.contentSha256,
    reviewedAt: candidate.capturedAt,
    reverifiedAt: candidate.capturedAt,
    freshUntil: candidate.freshUntil,
  };

  assert.throws(
    () => validateCapitalTopologyReverification(
      reverification,
      baseline,
      candidate,
      admission,
      admission.snapshotId,
      "capital-route-topology-20260724",
    ),
    /capital topology reverification identity is invalid/,
  );
});

test("direct-current reverification은 historical baseline만 동일 ownership으로 투영한다", async () => {
  const [baseline, candidate] = await Promise.all([
    readFile(path.join(root, "tools/datapack/sources/capital-route-topology-20260724.json"), "utf8")
      .then(JSON.parse),
    readFile(path.join(root, "tools/datapack/sources/capital-route-topology-20260804.json"), "utf8")
      .then(JSON.parse),
  ]);
  const projectedBaseline = projectCapitalTopologyOwnership(baseline);
  const projectedCandidate = projectCapitalTopologyOwnership(candidate);
  assert.equal(baseline.lines.length, 24);
  assert.equal(projectedBaseline.lines.length, 22);
  assert.equal(projectedCandidate.lines.length, 22);
  const evidence = buildCapitalTopologyReverificationEvidence(projectedBaseline, projectedCandidate);
  const admission = {
    schemaVersion: 1,
    artifactKind: "capital-network-edge-admission",
    issue: 2649,
    status: "ADMITTED",
    snapshotId: "capital-route-topology-20260804",
    contentSha256: projectedCandidate.contentSha256,
    reviewedAt: projectedCandidate.capturedAt,
    reverifiedAt: projectedCandidate.capturedAt,
    freshUntil: projectedCandidate.freshUntil,
  };

  assert.doesNotThrow(() => validateCapitalTopologyReverification(
    evidence,
    baseline,
    projectedCandidate,
    admission,
    admission.snapshotId,
    "capital-route-topology-20260724",
  ));
});

test("source-separated current reverification은 official baseline identity를 유지한다", async () => {
  const topology = JSON.parse(await readFile(
    path.join(root, "tools/datapack/sources/capital-route-topology-20260825.json"),
    "utf8",
  ));
  const evidence = buildCapitalTopologyReverificationEvidence(topology, topology);
  evidence.baseline.snapshotId = "capital-route-topology-20260825";
  const admission = {
    schemaVersion: 1,
    artifactKind: "capital-network-edge-admission",
    issue: 2649,
    status: "ADMITTED",
    snapshotId: "capital-route-topology-20260825",
    contentSha256: topology.contentSha256,
    reviewedAt: topology.capturedAt,
    reverifiedAt: topology.capturedAt,
    freshUntil: topology.freshUntil,
  };

  assert.doesNotThrow(() => validateCapitalTopologyReverification(
    evidence,
    topology,
    topology,
    admission,
    admission.snapshotId,
    admission.snapshotId,
  ));
});

test("expired historical ITX admission은 current source admission으로 재사용되지 않는다", async () => {
  const admission = JSON.parse(await readFile(
    path.join(root, "tools/datapack/itx-current-network-edge-admission-20260810.json"),
    "utf8",
  ));
  const contract = JSON.parse(await readFile(
    path.join(root, "tools/datapack/itx-cheongchun-coverage-contract.json"),
    "utf8",
  ));
  const currentSource = JSON.parse(await readFile(
    path.join(root, contract.sourceTimetableArtifact.artifactPath),
    "utf8",
  ));
  assert.throws(() => validateItxCurrentTopologyAdmission(admission, {
    previousArtifactSha256: contract.sourceTimetableArtifact.sha256,
    stationSequences: currentSource.stationSequences,
    now: new Date("2026-08-25T00:00:00.000Z"),
  }), /identity mismatch|stale/);
});

test("tracked current source topology evidence는 expired overlay 없이 exact admission을 만든다", async () => {
  const [buildSpec, contract, fixture] = await Promise.all([
    readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/itx-cheongchun-coverage-contract.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/capital-production-canonical-pack.json"), "utf8").then(JSON.parse),
  ]);
  assert.equal(Object.hasOwn(buildSpec.networkEdgeEvidence, "itxCurrentTopologyAdmission"), false);
  const topology = await validateTrackedItxTopologyEvidence(buildSpec, fixture);
  assert.equal(
    fixture.packs.find(({ id }) => id === "capital").networkEdges
      .filter(({ serviceClass }) => serviceClass === "ITX_CHEONGCHUN").length,
    74,
  );
  const previousBuildNow = process.env.EASYSUBWAY_DATAPACK_BUILD_NOW;
  process.env.EASYSUBWAY_DATAPACK_BUILD_NOW = "2026-08-25T00:00:00.000Z";
  try {
    const admitted = await admittedItxNetworkEdgeEvidence(contract, topology);
    assert.equal(admitted.sourceSnapshotId, contract.sourceTimetableArtifact.artifactId);
    assert.equal(admitted.pairHashes.size, 74);
    assert.equal(admitted.routeServiceArtifactEvidence.artifactEvidence.admissionStatus, "ADMITTED");
    assert.equal(admitted.routeServiceArtifactEvidence.stationCatalogEvidence.admissionStatus, "ADMITTED");
  } finally {
    if (previousBuildNow == null) delete process.env.EASYSUBWAY_DATAPACK_BUILD_NOW;
    else process.env.EASYSUBWAY_DATAPACK_BUILD_NOW = previousBuildNow;
  }
});

test("tracked current source admission은 review-required approval identity mutation을 거부한다", async (context) => {
  const [buildSpec, contract, fixture] = await Promise.all([
    readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/itx-cheongchun-coverage-contract.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/capital-production-canonical-pack.json"), "utf8").then(JSON.parse),
  ]);
  const topology = await validateTrackedItxTopologyEvidence(buildSpec, fixture);
  const cases = [
    ["missing-url", (reference) => { reference.promotion.approvalUrl = ""; }],
    ["wrong-approved-sha", (reference) => { reference.promotion.approvedArtifactSha256 = "0".repeat(64); }],
    ["wrong-mode", (reference) => { reference.promotion.mode = "UNCHANGED_AUTO"; }],
  ];
  const previousBuildNow = process.env.EASYSUBWAY_DATAPACK_BUILD_NOW;
  process.env.EASYSUBWAY_DATAPACK_BUILD_NOW = "2026-08-13T00:00:00.000Z";
  try {
    for (const [name, mutate] of cases) {
      await context.test(name, async () => {
        const candidate = structuredClone(contract);
        mutate(candidate.sourceTimetableArtifact);
        await assert.rejects(
          admittedItxNetworkEdgeEvidence(candidate, topology),
          /approval identity|topology is not admitted/,
        );
      });
    }
  } finally {
    if (previousBuildNow == null) delete process.env.EASYSUBWAY_DATAPACK_BUILD_NOW;
    else process.env.EASYSUBWAY_DATAPACK_BUILD_NOW = previousBuildNow;
  }
});

test("tracked topology admission은 legacy migration evidence를 거부한다", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "build-current-legacy-itx-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const [buildSpec, fixture, evidence] = await Promise.all([
    readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/capital-production-canonical-pack.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/itx-cheongchun-topology-evidence.json"), "utf8").then(JSON.parse),
  ]);
  for (const field of ["migration", "routeServiceEvidence"]) {
    const candidate = structuredClone(evidence);
    candidate[field] = {};
    const bytes = Buffer.from(`${JSON.stringify(candidate)}\n`);
    const evidencePath = path.join(directory, `${field}.json`);
    await writeFile(evidencePath, bytes);
    await assert.rejects(
      validateTrackedItxTopologyEvidence({
        ...buildSpec,
        itxTopologyEvidencePath: path.basename(evidencePath),
        itxTopologyEvidenceSha256: sha256(bytes),
      }, fixture, directory),
      /migration evidence is forbidden by the current-only datapack contract/,
    );
  }
});
