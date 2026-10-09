import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { expandExternalStopTimes } from "./lib/external-stop-times.mjs";
import { candidatePinnedWorkspace } from "./test-fixtures/candidate-pinned-inputs.mjs";
import { bindBuildSpecToCurrentItx } from "./test-fixtures/current-itx-bound-build-spec.mjs";
import { createGatedPromotionRoot } from "./test-fixtures/itx-gated-promotion-root.mjs";

import {
  admittedIncheonTopologyEvidence,
  admittedTrackedIncheonAccessibilityEvidence,
  admittedRegisteredIncheonAccessibilityEvidence,
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
  validateRegisteredIncheonAccessibilityFixture,
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
import { main as buildCurrentReleaseCandidateAccessibilityInput } from "./build-current-release-candidate-accessibility-input.mjs";
import { buildSyntheticNationwideReleaseCandidate } from "./test-fixtures/synthetic-nationwide-release-candidate.mjs";

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

// #866 PR-C: 수도권 accessibility transition 표지(staged transition guard)는 live chain과 함께 삭제됐다.
// 표지 파일이 없어 항상 통과하던 guard다. validation-only 분류와 shape 확정 순서는 그대로 고정한다.
test("build-datapack은 validation-only 요청을 먼저 분류하고 validation-only shape를 output 전에 확정한다", async () => {
  const source = await readFile(path.join(root, "tools/datapack/build-datapack.mjs"), "utf8");
  const validationOnlyRequest = source.indexOf("const buildSpecValidationOnlyRequested =");
  const buildInput = source.indexOf("await loadBuildInput(");
  const validationOnlyShape = source.indexOf("if (buildSpecValidationOnlyRequested && validationOnlyProductionFixture !== true) {");
  const fixtureValidation = source.indexOf("validateFixture(fixture);");
  assert.ok(validationOnlyRequest >= 0, "validation-only 요청을 명시적으로 분류해야 한다");
  assert.equal(source.includes("AccessibilityBuildAllowed"), false, "삭제된 transition guard가 남으면 안 된다");
  assert.ok(validationOnlyRequest < buildInput, "validation-only 요청은 candidate 입력보다 먼저 분류해야 한다");
  assert.ok(buildInput < validationOnlyShape && validationOnlyShape < fixtureValidation, "validation-only shape는 input 검증 후 output 전에 확정해야 한다");
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
    incheonTimetables: {
      line1: {
        path: "tools/datapack/sources/incheon-line1-train-timetable-20260810.json",
        sha256: "8".repeat(64),
        snapshotId: "incheon-line1-train-timetable-20260810",
      },
      line2: {
        path: "tools/datapack/sources/incheon-line2-train-timetable-20260810.json",
        sha256: "9".repeat(64),
        snapshotId: "incheon-line2-train-timetable-20260810",
      },
    },
    itxCoverageContract: { path: "itx-coverage.json", sha256: "6".repeat(64) },
  };
}

// #866 PR-C: 수도권 live chain 합성 저장소 대신 커밋된 전국 후보와 release workflow의 RC 경로
// (build-current-release-candidate-accessibility-input → build-datapack override·authority)로 같은 불변식을 고정한다.
test("candidate build spec release identity는 wall clock과 workflow run number에 무관하다", async (context) => {
  // #942: 후보 빌드 재현은 후보가 고정한 입력 바이트를 담은 작업 공간에서 한다(원천만 등록한 PR에서도 같은 결과).
  const { root: candidateRoot } = await candidatePinnedWorkspace();
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-release-identity-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const buildSpecPath = "tools/datapack/release/candidate-build-spec.json";
  const buildSpecBytes = await readFile(path.join(candidateRoot, buildSpecPath));
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
  await buildCurrentReleaseCandidateAccessibilityInput([
    "--fixture", buildSpec.fixturePath,
    "--build-spec", buildSpecPath,
    "--station-line-output", candidateStationLine,
    "--route-edge-output", candidateRouteEdge,
    "--fixture-output", candidateFixture,
    "--authority-output", routeCoverageAuthority,
  ], { repositoryRoot: candidateRoot });
  const directOutput = path.join(directory, "direct-build");
  await assert.rejects(
    withEnvironment({
      EASYSUBWAY_DATAPACK_BUILD_NOW: firstBuildNow,
      EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKey,
      EASYSUBWAY_DATAPACK_SIGNING_KEY_ID: "production-v1",
    }, () => buildDatapackMain([
      "--build-spec", buildSpecPath,
      "--output", directOutput,
    ], { repositoryRoot: candidateRoot })),
    /production accessibility evidence mismatch/,
  );
  await assert.rejects(readFile(path.join(directOutput, "current.json")), /ENOENT/);
  const validationOnlyFixturePath = path.join(directory, "validation-only-source-fixture.json");
  const validationOnlyBuildSpecPath = path.join(directory, "validation-only-build-spec.json");
  // #899: 정본 팩이 sha로 결속한 외부 공식 시간표를 펼친 fixture가 release 경로의 원본이다.
  const sourceFixture = expandExternalStopTimes(JSON.parse(await readFile(path.join(candidateRoot, buildSpec.fixturePath))), { repositoryRoot: candidateRoot });
  const activePackId = sourceFixture.manifest.activePack.id;
  const validationOnlyFixture = await projectCandidateFixtureForAccessibilityAuthority({
    buildSpec,
    sourceFixture,
    repositoryRoot: candidateRoot,
  });
  const sourcePack = retainPreAuthorityRideEdges(sourceFixture, "validation-only source").packs
    .find(({ id }) => id === activePackId);
  const validationOnlyPack = validationOnlyFixture.packs.find(({ id }) => id === activePackId);
  validationOnlyPack.networkEdges = structuredClone(sourcePack.networkEdges);
  validationOnlyPack.outOfStationTransferLinks = structuredClone(sourcePack.outOfStationTransferLinks);
  // 전국 build spec은 정본 팩 bytes(fixtureSha256)에 결속한다. validation-only 팩은 그 bytes 결속만 새 bytes로 바꾼다.
  const validationOnlyFixtureBytes = Buffer.from(`${JSON.stringify(validationOnlyFixture, null, 2)}\n`);
  await Promise.all([
    writeFile(validationOnlyFixturePath, validationOnlyFixtureBytes),
    writeFile(
      validationOnlyBuildSpecPath,
      `${JSON.stringify({
        ...buildSpec,
        fixturePath: validationOnlyFixturePath,
        ...(Object.hasOwn(buildSpec, "fixtureSha256") ? { fixtureSha256: sha256(validationOnlyFixtureBytes) } : {}),
      }, null, 2)}\n`,
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
  ], { repositoryRoot: candidateRoot }));
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
    ], { repositoryRoot: candidateRoot }));
    return {
      manifest: await readFile(path.join(output, "current.json")),
      provenance: await readFile(path.join(output, "current.provenance.json")),
      sqlite: await readFile(path.join(output, `catalog/${activePackId}-v1.sqlite`)),
      gzip: await readFile(path.join(output, `catalog/${activePackId}-v1.sqlite.gz`)),
    };
  }

  await assert.rejects(
    withEnvironment({
      EASYSUBWAY_DATAPACK_BUILD_NOW: secondBuildNow,
      EASYSUBWAY_DATAPACK_BUILD_SPEC_VALIDATION_ONLY: "true",
      EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKey,
      EASYSUBWAY_DATAPACK_SIGNING_KEY_ID: "production-v1",
    }, () => buildDatapackMain([
      "--build-spec", buildSpecPath,
      "--candidate-fixture-override", candidateFixture,
      "--server-route-coverage-authority", routeCoverageAuthority,
      "--current-capital-station-line-input", candidateStationLine,
      "--current-capital-route-edge-input", candidateRouteEdge,
      "--output", path.join(directory, "validation-only-replay-blocked"),
    ], { repositoryRoot: candidateRoot })),
    /build-spec validation-only requires a production source fixture without accessibility authority replay/,
  );

  const first = await build("first", firstBuildNow, "101");
  const second = await build("second", secondBuildNow, "202");
  const manifest = JSON.parse(first.manifest);
  const provenance = JSON.parse(first.provenance);
  const snapshots = await readFile(
    path.join(candidateRoot, "tools/datapack/release/source-snapshots.json"),
    "utf8",
  ).then(JSON.parse);
  const selectedIds = new Set(buildSpec.sourceSnapshotIds);
  const publicSnapshot = snapshots.find(({ sourceId, snapshotId }) =>
    sourceId === PUBLIC_ROUTE_MAP_SOURCE_ID && selectedIds.has(snapshotId));
  assert.ok(publicSnapshot?.routeMapLayoutArtifact);

  assert.equal(manifest.publishedAt, buildSpec.publishedAt);
  assert.equal(manifest.releaseSequence, buildSpec.releaseSequence);
  assert.equal(provenance.candidateBuild.publishedAt, buildSpec.publishedAt);
  assert.equal(provenance.candidateBuild.releaseSequence, buildSpec.releaseSequence);
  // #913 후속·#916 리뷰 F2: 전국 발행 빌드의 팩 만료는 network 창, 시간표 원천, spec 인용 원천 전체의 최솟값이다.
  // 기대값은 production 계산을 다시 부르지 않고 커밋된 spec 원천 행과 승인된 ITX 원천 파일에서 직접 고른다.
  // #971: 커밋된 후보에서 network 창(ITX-청춘 승인 원천 freshUntil)이 spec 인용 원천(P7D)보다 이르다. 후보 만료는 ITX 창이 정한다.
  const artifactFreshness = provenance.candidateBuild.artifactFreshness;
  const earliestCited = [...buildSpec.sourceSnapshots]
    .sort((left, right) => Date.parse(left.freshnessExpiresAt) - Date.parse(right.freshnessExpiresAt))[0];
  const itxContract = JSON.parse(await readFile(path.join(candidateRoot, "tools/datapack/itx-cheongchun-coverage-contract.json"), "utf8"));
  const itxSource = JSON.parse(await readFile(path.join(candidateRoot, itxContract.sourceTimetableArtifact.artifactPath), "utf8"));
  const itxFreshUntil = new Date(itxSource.freshUntil).toISOString();
  assert.equal(artifactFreshness.citedSourceFreshUntil, earliestCited.freshnessExpiresAt);
  assert.ok(Date.parse(itxFreshUntil) < Date.parse(earliestCited.freshnessExpiresAt), "ITX window is the binding network window");
  assert.equal(artifactFreshness.networkFreshUntil, itxFreshUntil);
  assert.equal(manifest.expiresAt, itxFreshUntil);
  assert.equal(artifactFreshness.freshUntil, itxFreshUntil);
  assert.deepEqual(artifactFreshness.decidedBy, [{ kind: "network" }]);
  // 가장 이른 인용 원천은 후보 spec의 인용 행에서 고르되, spec이 스스로를 증명하지 않도록 원장 행과 대조한다(#1053).
  // 예전에는 원천 id(capital-route-topology)를 하드코딩해 원천 id가 바뀌면 드러나게 했다. 그 값은 후보를 다시 만들 때마다 달라져
  // 자동 후보 PR이 테스트를 고칠 수 없는 required-pr를 막았다. 이제 같은 의도는 다음에서 보장된다.
  //   1) 원천 id·만료가 바뀐 사실은 후보 PR diff(spec·fan-in·원장)와 자동 병합 증거 블록에 드러난다.
  //   2) 아래 대조가 spec의 모든 인용 행이 원장 행의 원천 id·만료와 같고 가장 이른 만료가 원장 기준임을 단언한다(순환 검증이 아니다).
  //   3) release의 head 일치 검사(validate-candidate-source-set.mjs 114행)가 후보 원천이 원장 head와 같음을 요구한다.
  const ledgerById = new Map(snapshots.map((row) => [row.snapshotId, row]));
  for (const cited of buildSpec.sourceSnapshots) {
    const row = ledgerById.get(cited.snapshotId);
    assert.ok(row, `cited snapshot ${cited.snapshotId} must be a ledger row`);
    assert.equal(row.sourceId, cited.sourceId, cited.snapshotId);
    assert.equal(row.freshnessExpiresAt, cited.freshnessExpiresAt, cited.snapshotId);
    // 인용 행은 그 원천의 원장 terminal head여야 한다. 한 단계 뒤처진 snapshot은 자기 행의 만료와 일치해도 통과하면 안 된다(#1053 리뷰 F2).
    assert.equal(snapshots.some((other) => other.sourceId === cited.sourceId && other.previousSnapshotId === cited.snapshotId), false,
      `${cited.sourceId}: ${cited.snapshotId}은 원장 terminal head가 아니다`);
  }
  const ledgerEarliest = Math.min(...buildSpec.sourceSnapshots.map(({ snapshotId }) => Date.parse(ledgerById.get(snapshotId).freshnessExpiresAt)));
  assert.equal(Date.parse(earliestCited.freshnessExpiresAt), ledgerEarliest);
  // 시간표 원천은 모두 팩 만료보다 늦다(시간표 창이 만료를 정하지 않는다). 목록이 비면 every가 공허하게 통과하므로 비어 있지 않음을 먼저 단언한다.
  assert.ok(artifactFreshness.timetableSources.length > 0, "timetable sources must be reported");
  const earliestTimetableSource = [...artifactFreshness.timetableSources]
    .sort((left, right) => Date.parse(left.freshnessExpiresAt) - Date.parse(right.freshnessExpiresAt))[0];
  assert.equal(earliestTimetableSource.sourceId, "kric-nationwide-timetable-file");
  assert.ok(artifactFreshness.timetableSources.every(({ freshnessExpiresAt }) => Date.parse(freshnessExpiresAt) > Date.parse(manifest.expiresAt)));
  // 검증 전용 빌드(dev 채널)는 시간표 신선도를 계산하지 않고 사유를 남긴다.
  assert.deepEqual(validationOnlyProvenance.candidateBuild.artifactFreshness,
    { timetableFreshness: "SKIPPED", skipReason: "VALIDATION_ONLY_BUILD", freshUntil: validationOnlyManifest.expiresAt });
  // spec이 결속한 inventory와 다른 sha면 빌드가 실패한다.
  const mismatchedSpecPath = path.join(directory, "inventory-mismatch-build-spec.json");
  await writeFile(mismatchedSpecPath, `${JSON.stringify({ ...buildSpec, sourceInventorySha256: "0".repeat(64) }, null, 2)}\n`);
  await assert.rejects(withEnvironment({
    EASYSUBWAY_DATAPACK_BUILD_NOW: firstBuildNow,
    EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKey,
    EASYSUBWAY_DATAPACK_SIGNING_KEY_ID: "production-v1",
  }, () => buildDatapackMain([
    "--build-spec", mismatchedSpecPath,
    "--candidate-fixture-override", candidateFixture,
    "--server-route-coverage-authority", routeCoverageAuthority,
    "--current-capital-station-line-input", candidateStationLine,
    "--current-capital-route-edge-input", candidateRouteEdge,
    "--output", path.join(directory, "inventory-mismatch"),
  ], { repositoryRoot: candidateRoot })), /sourceInventorySha256|source inventory semantic hash mismatch/);
  for (const key of ["manifest", "provenance", "sqlite", "gzip"]) {
    assert.deepEqual(first[key], second[key], `${key} bytes drifted`);
  }
  const database = new DatabaseSync(path.join(directory, `first/catalog/${activePackId}-v1.sqlite`), {
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
    // #957: 후보 빌드가 환승 안내 두 표를 실제로 적재하고 provenance 보고와 같은 수·원천 hash로 결속한다.
    const guideReport = provenance.packs.find(({ id }) => id === activePackId).derivedTables?.transfer_guide_steps;
    assert.ok(guideReport, "provenance missing derivedTables.transfer_guide_steps");
    const molitMetadata = JSON.parse(await readFile(
      path.join(candidateRoot, "tools/datapack/sources/molit-railway-transfer-movement-20260811.csv.gz.json"),
      "utf8",
    ));
    assert.equal(guideReport.sourceSnapshotId, molitMetadata.snapshotId);
    assert.equal(guideReport.rawSha256, molitMetadata.rawSha256);
    assert.equal(guideReport.sequenceCount, 1152);
    assert.equal(guideReport.mappedSequenceCount + guideReport.duplicateSequenceCount + guideReport.excludedSequenceCount, guideReport.sequenceCount);
    assert.equal(guideReport.excludedSequences.length, guideReport.excludedSequenceCount);
    assert.ok(guideReport.rowCount > 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM transfer_guide_steps").get().count, guideReport.rowCount);
    assert.deepEqual(database.prepare("SELECT source_snapshot_id AS id, raw_sha256 AS sha FROM transfer_guide_sources").all().map((row) => ({ ...row })),
      [{ id: molitMetadata.snapshotId, sha: molitMetadata.rawSha256 }]);
    assert.deepEqual(database.prepare("SELECT DISTINCT source_snapshot_id AS id FROM transfer_guide_steps").all().map(({ id }) => id), [molitMetadata.snapshotId]);
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
  // #866 PR-C: 합성 전국 station-line 입력을 쓴다. 이 테스트는 전국이 아닌 후보 id(벽시계 기준 stale 판정) 분기를 고정한다.
  const stationLineInput = buildSyntheticNationwideReleaseCandidate().stationLineInput;
  stationLineInput.candidate.candidateId = "release-identity-candidate";
  for (const row of stationLineInput.evidenceRows) row.candidateId = stationLineInput.candidate.candidateId;
  const stationLineInputBytes = Buffer.from(JSON.stringify(stationLineInput));
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
    validationNow: new Date(stationLineInput.evidenceRows[0].capturedAt),
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
    validationNow: new Date(stationLineInput.evidenceRows[0].capturedAt),
  }), /station-line input identity mismatch/);
  assert.throws(() => candidateOverrideAccessibilityFreshUntil({
    authority: {
      ...authority,
      buildInput: { ...authority.buildInput, observedAt: new Date(Date.parse(observedAt) + 1_000).toISOString() },
    },
    stationLineInputBytes,
    validationNow: new Date(stationLineInput.evidenceRows[0].capturedAt),
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
  const [inventory, buildSpec] = await Promise.all([
    readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8")
      .then(JSON.parse),
  ]);
  const source = (id) => inventory.sources.find((entry) => entry.id === id);
  const topologySnapshotPath = source("incheon-transit-station-info")
    ?.topologyAdmissionEvidence?.snapshotPath;
  const accessibilityRegistration = source("incheon-transit-accessibility")
    ?.registrationEvidence;
  const accessibilitySnapshotPath = typeof accessibilityRegistration?.snapshotId === "string"
    ? `tools/datapack/sources/${accessibilityRegistration.snapshotId}.json`
    : null;
  const timetableSnapshotPaths = {
    1: source("incheon-line1-train-timetable")?.scheduleAdmissionEvidence?.snapshotPath,
    2: source("incheon-line2-train-timetable")?.scheduleAdmissionEvidence?.snapshotPath,
  };
  if (!/^tools\/datapack\/sources\/incheon-transit-station-info-[0-9]{8}\.json$/u.test(topologySnapshotPath ?? "")
    || !/^tools\/datapack\/sources\/incheon-transit-accessibility-[0-9]{8}T[0-9]{9}Z\.json$/u.test(accessibilitySnapshotPath ?? "")
    || Object.values(timetableSnapshotPaths).some((snapshotPath) =>
      !/^tools\/datapack\/sources\/incheon-line[12]-train-timetable-[0-9]{8}\.json$/u.test(snapshotPath ?? ""))) {
    throw new Error("current Incheon source admission paths are missing");
  }
  const snapshotBytes = await readFile(path.join(root, topologySnapshotPath));
  const snapshot = JSON.parse(snapshotBytes);
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
    snapshotBytes: accessibilityBytes,
    topologySnapshot: snapshot,
    topologyMode: "registered-topology-successor",
    now,
  });
  assert.equal(accessibilityAdmission.snapshotId, accessibilitySnapshot.snapshotId);
  assert.equal(accessibilityAdmission.freshUntil, accessibilitySnapshot.freshUntil);
  const accessibilityPin = {
    path: accessibilitySnapshotPath,
    sha256: sha256(accessibilityBytes),
    snapshotId: accessibilityAdmission.snapshotId,
  };
  assert.deepEqual(await admittedTrackedIncheonAccessibilityEvidence(accessibilityPin, {
    sourceInventory: currentInventory,
    topologySnapshot: snapshot,
    topologyMode: "registered-topology-successor",
    repositoryRoot: root,
    now,
  }), accessibilityAdmission);
  await assert.rejects(admittedTrackedIncheonAccessibilityEvidence({
    ...accessibilityPin,
    sha256: "0".repeat(64),
  }, {
    sourceInventory: currentInventory,
    topologySnapshot: snapshot,
    topologyMode: "registered-topology-successor",
    repositoryRoot: root,
    now,
  }), /sha256 must match tracked input bytes/);
  await assert.rejects(admittedTrackedIncheonAccessibilityEvidence({
    ...accessibilityPin,
    snapshotId: "incheon-transit-accessibility-20260827",
  }, {
    sourceInventory: currentInventory,
    topologySnapshot: snapshot,
    topologyMode: "registered-topology-successor",
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
    buildSpec.sourceSnapshots,
    now,
    { admittedAccessibilityEvidence: new Map([[accessibilityAdmission.source.id, accessibilityAdmission]]) },
  ), accessibilityAdmission.freshUntil);
  assert.throws(() => productionAccessibilityFreshUntil(
    [accessibilityFixture], currentInventory, buildSpec.sourceSnapshots, now,
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
    { admittedAccessibilityEvidence: new Map([[accessibilityAdmission.source.id, accessibilityAdmission]]) },
  ), /production accessibility snapshot mismatch: kric-station-convenience-standard/);
});

test("registered Incheon accessibility projection binds the current candidate and every materialized row", async () => {
  // #1038: 후보와 대조하는 spec·inventory·topology snapshot은 작업 트리가 아니라 후보가 고정한 바이트로 읽는다. 재결속 PR이 inventory를 다시 쓰므로
  // 작업 트리 inventory를 후보 spec과 대조하면 후보를 다시 만들기 전까지 항상 어긋난다(#943). 고정 입력이 작업 트리와 같으면 저장소 루트 그대로다.
  const { root: candidateRoot } = await candidatePinnedWorkspace();
  const [buildSpec, sourceInventory] = await Promise.all([
    readFile(path.join(candidateRoot, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(candidateRoot, "tools/datapack/source-inventory.json"), "utf8").then(JSON.parse),
  ]);
  const topologySource = sourceInventory.sources.find(({ id }) => id === "incheon-transit-station-info");
  const topologySnapshot = await readFile(
    path.join(candidateRoot, topologySource.topologyAdmissionEvidence.snapshotPath),
    "utf8",
  ).then(JSON.parse);
  const registeredNow = new Date(Math.min(
    Date.parse(buildSpec.publishedAt),
    Date.parse(buildSpec.networkEdgeEvidence?.capitalTopologyAdmission?.freshUntil ?? buildSpec.publishedAt) - 1_000,
    ...buildSpec.sourceSnapshots.map(({ freshnessExpiresAt }) => Date.parse(freshnessExpiresAt) - 1_000),
  ));
  const registered = await admittedRegisteredIncheonAccessibilityEvidence(buildSpec, {
    sourceInventory,
    topologySnapshot,
    topologyMode: "registered-topology-successor",
    repositoryRoot: candidateRoot,
    now: registeredNow,
  });
  const externalLegacyKey = structuredClone(buildSpec.networkEdgeEvidence);
  externalLegacyKey.incheonAccessibility = {
    path: `tools/datapack/sources/${registered.admission.snapshotId}.json`,
    sha256: registered.admission.source.registrationEvidence.snapshotFileSha256,
    snapshotId: registered.admission.snapshotId,
  };
  const previousBuildNow = process.env.EASYSUBWAY_DATAPACK_BUILD_NOW;
  process.env.EASYSUBWAY_DATAPACK_BUILD_NOW = registeredNow.toISOString();
  try {
    assert.throws(
      () => candidateNetworkEdgeEvidence(externalLegacyKey),
      /incheonAccessibility is not allowed/,
    );
    assert.doesNotThrow(() => candidateNetworkEdgeEvidence(buildSpec.networkEdgeEvidence));
  } finally {
    if (previousBuildNow == null) delete process.env.EASYSUBWAY_DATAPACK_BUILD_NOW;
    else process.env.EASYSUBWAY_DATAPACK_BUILD_NOW = previousBuildNow;
  }
  const fixture = {
    facilities: structuredClone(registered.admission.fixtureRows.facilities),
    stationFacilityEvidence: structuredClone(registered.admission.fixtureRows.evidence),
  };
  assert.doesNotThrow(() => validateRegisteredIncheonAccessibilityFixture(
    [fixture], registered, registeredNow,
  ));
  assert.equal(productionAccessibilityFreshUntil(
    [fixture],
    sourceInventory,
    buildSpec.sourceSnapshots,
    registeredNow,
    { admittedAccessibilityEvidence: new Map([[
      registered.admission.source.id,
      registered.admission,
    ]]) },
  ), registered.projection.freshnessExpiresAt);

  const absentProjection = structuredClone(buildSpec);
  absentProjection.sourceSnapshots = absentProjection.sourceSnapshots.filter(
    ({ sourceId }) => sourceId !== "incheon-transit-accessibility",
  );
  await assert.rejects(admittedRegisteredIncheonAccessibilityEvidence(absentProjection, {
    sourceInventory, topologySnapshot, topologyMode: "registered-topology-successor",
    repositoryRoot: candidateRoot, now: registeredNow,
  }), /exactly one registered Incheon accessibility projection/);
  const duplicateProjection = structuredClone(buildSpec);
  duplicateProjection.sourceSnapshots.push(structuredClone(registered.projection));
  await assert.rejects(admittedRegisteredIncheonAccessibilityEvidence(duplicateProjection, {
    sourceInventory, topologySnapshot, topologyMode: "registered-topology-successor",
    repositoryRoot: candidateRoot, now: registeredNow,
  }), /exactly one registered Incheon accessibility projection/);

  const byteHashDrift = structuredClone(sourceInventory);
  byteHashDrift.sources.find(({ id }) => id === "incheon-transit-accessibility")
    .registrationEvidence.snapshotFileSha256 = "0".repeat(64);
  await assert.rejects(admittedRegisteredIncheonAccessibilityEvidence(buildSpec, {
    sourceInventory: byteHashDrift, topologySnapshot,
    topologyMode: "registered-topology-successor", repositoryRoot: candidateRoot, now: registeredNow,
  }), /sha256 must match tracked input bytes/);
  const normalizedSchemaDrift = structuredClone(sourceInventory);
  normalizedSchemaDrift.sources.find(({ id }) => id === "incheon-transit-accessibility")
    .registrationEvidence.normalizedSchemaFingerprint = "0".repeat(64);
  await assert.rejects(admittedRegisteredIncheonAccessibilityEvidence(buildSpec, {
    sourceInventory: normalizedSchemaDrift, topologySnapshot,
    topologyMode: "registered-topology-successor", repositoryRoot: candidateRoot, now: registeredNow,
  }), /registration evidence does not match tracked snapshot bytes/);
  const adminReviewDrift = structuredClone(buildSpec);
  adminReviewDrift.sourceSnapshots.find(({ sourceId }) => sourceId === "incheon-transit-accessibility")
    .adminReviewRecordHash = "0".repeat(64);
  await assert.rejects(admittedRegisteredIncheonAccessibilityEvidence(adminReviewDrift, {
    sourceInventory, topologySnapshot, topologyMode: "registered-topology-successor",
    repositoryRoot: candidateRoot, now: registeredNow,
  }), /projection does not match tracked ledger/);
  const ociDrift = structuredClone(buildSpec);
  ociDrift.sourceSnapshots.find(({ sourceId }) => sourceId === "incheon-transit-accessibility")
    .rawObjectUri = "oci://axvym6vk8g7i/easysubway-datapacks/source-raw/invalid.json";
  await assert.rejects(admittedRegisteredIncheonAccessibilityEvidence(ociDrift, {
    sourceInventory, topologySnapshot, topologyMode: "registered-topology-successor",
    repositoryRoot: candidateRoot, now: registeredNow,
  }), /projection does not match tracked ledger/);
  const ledgerFreshnessDrift = structuredClone(buildSpec);
  ledgerFreshnessDrift.sourceSnapshots.find(({ sourceId }) => sourceId === "incheon-transit-accessibility")
    .freshnessExpiresAt = "2026-12-01T00:00:00.000Z";
  await assert.rejects(admittedRegisteredIncheonAccessibilityEvidence(ledgerFreshnessDrift, {
    sourceInventory, topologySnapshot, topologyMode: "registered-topology-successor",
    repositoryRoot: candidateRoot, now: registeredNow,
  }), /projection does not match tracked ledger/);
  const staleProjection = structuredClone(registered);
  staleProjection.projection.freshnessExpiresAt = "2026-08-01T00:00:00.000Z";
  assert.throws(() => validateRegisteredIncheonAccessibilityFixture(
    [fixture], staleProjection, registeredNow,
  ), /projection is invalid or stale/);
  const rowEvidenceDrift = structuredClone(fixture);
  rowEvidenceDrift.facilities[0].evidenceHash = "0".repeat(64);
  assert.throws(() => validateRegisteredIncheonAccessibilityFixture(
    [rowEvidenceDrift], registered, registeredNow,
  ), /registered Incheon accessibility row does not match admission/);
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
    const legacyIncheonAccessibility = {
      ...current,
      incheonAccessibility: {
        path: "tools/datapack/sources/incheon-transit-accessibility-20260828T043356000Z.json",
        sha256: "a".repeat(64),
        snapshotId: "incheon-transit-accessibility-20260828T043356000Z",
      },
    };
    assert.throws(
      () => candidateNetworkEdgeEvidence(legacyIncheonAccessibility),
      /incheonAccessibility is not allowed/,
    );
    assert.equal(
      candidateNetworkEdgeEvidence(current).itxCurrentTopologyAdmissionSha256,
      "7".repeat(64),
    );
    assert.deepEqual(candidateNetworkEdgeEvidence(current).incheonTimetableSnapshotIds, {
      line1: "incheon-line1-train-timetable-20260810",
      line2: "incheon-line2-train-timetable-20260810",
    });
    const missingTimetable = structuredClone(current);
    delete missingTimetable.incheonTimetables.line2;
    assert.throws(
      () => candidateNetworkEdgeEvidence(missingTimetable),
      /incheonTimetables.*line2|exact keys/,
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

// ITX 원천의 수집 시각(artifactId의 UTC stamp YYYYMMDDHHmmssSSS). 승격마다 바뀌는 시계를 literal로 박지 않기 위해 쓴다(#979).
function itxObservedAtMillis(contract) {
  const stamp = contract.sourceTimetableArtifact.artifactId.slice("itx-cheongchun-source-timetable-".length);
  return Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), +stamp.slice(8, 10), +stamp.slice(10, 12), +stamp.slice(12, 14), +stamp.slice(14, 17));
}

test("tracked current source topology evidence는 expired overlay 없이 exact admission을 만든다", async () => {
  const [buildSpec, contract, fixture] = await Promise.all([
    readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/itx-cheongchun-coverage-contract.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/capital-production-canonical-pack.json"), "utf8").then(JSON.parse),
  ]);
  assert.equal(Object.hasOwn(buildSpec.networkEdgeEvidence, "itxCurrentTopologyAdmission"), false);
  const topology = await validateTrackedItxTopologyEvidence(await bindBuildSpecToCurrentItx(buildSpec, root), fixture);
  const expectedItxEdgeCount = topology.evidence.topology.edgeCount;
  // 승인 승격이면 승인 URL이 근거이고, 게이트 승격이면 커밋된 영수증이 근거다(작업 트리 영수증을 다시 계산한다).
  if (contract.sourceTimetableArtifact.promotion.mode === "CURRENT_CANDIDATE_OWNER_APPROVED") {
    contract.sourceTimetableArtifact.promotion.approvalUrl =
      "https://github.com/AquilaXk/easysubway-data/issues/636#issuecomment-123";
  }
  assert.equal(
    fixture.packs.find(({ id }) => id === "capital").networkEdges
      .filter(({ serviceClass }) => serviceClass === "ITX_CHEONGCHUN").length,
    expectedItxEdgeCount,
  );
  const previousBuildNow = process.env.EASYSUBWAY_DATAPACK_BUILD_NOW;
  // 승격마다 바뀌는 시각이라 literal 대신 현재 승인 원천의 수집 시각에서 도출한다: 관측 직후부터 신선도 경계 전까지만 유효하다.
  const evaluationAt = new Date(Math.min(
    Math.max(Date.parse(buildSpec.publishedAt), itxObservedAtMillis(contract) + 1_000),
    Date.parse(contract.sourceTimetableArtifact.freshUntil) - 1_000,
  ));
  process.env.EASYSUBWAY_DATAPACK_BUILD_NOW = evaluationAt.toISOString();
  try {
    const admitted = await admittedItxNetworkEdgeEvidence(contract, topology);
    assert.equal(admitted.sourceSnapshotId, contract.sourceTimetableArtifact.artifactId);
    assert.equal(admitted.pairHashes.size, expectedItxEdgeCount);
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
  const topology = await validateTrackedItxTopologyEvidence(await bindBuildSpecToCurrentItx(buildSpec, root), fixture);
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

test("tracked current source admission은 게이트 승격을 커밋된 영수증 재계산으로 받아들이고 변조를 거부한다 (F1)", async (context) => {
  const [buildSpec, fixture] = await Promise.all([
    readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/capital-production-canonical-pack.json"), "utf8").then(JSON.parse),
  ]);
  const topology = await validateTrackedItxTopologyEvidence(await bindBuildSpecToCurrentItx(buildSpec, root), fixture);
  const previousBuildNow = process.env.EASYSUBWAY_DATAPACK_BUILD_NOW;
  const gated = await createGatedPromotionRoot();
  process.env.EASYSUBWAY_DATAPACK_BUILD_NOW = new Date(itxObservedAtMillis(gated.contract) + 1_000).toISOString();
  context.after(async () => {
    await gated.cleanup();
    if (previousBuildNow == null) delete process.env.EASYSUBWAY_DATAPACK_BUILD_NOW;
    else process.env.EASYSUBWAY_DATAPACK_BUILD_NOW = previousBuildNow;
  });
  const admitted = await admittedItxNetworkEdgeEvidence(gated.contract, topology, null, gated.root);
  assert.equal(admitted.sourceSnapshotId, gated.reference.artifactId);
  // 구조 검사만 통과하는 변조는 거부한다: 영수증이 없는 루트, 승인 키 혼입, 잘못된 정책, 영수증 변조.
  await assert.rejects(admittedItxNetworkEdgeEvidence(gated.contract, topology, null, root), /ENOENT|ITX_PROMOTION_/u);
  for (const [name, mutate] of [
    ["approval-url-mixed-in", (reference) => { reference.promotion.approvalUrl = "https://github.com/AquilaXk/easysubway-data/issues/636#issuecomment-1"; }],
    ["wrong-gated-sha", (reference) => { reference.promotion.gatedArtifactSha256 = "0".repeat(64); }],
    ["wrong-policy", (reference) => { reference.promotion.gate.policyId = "itx-promotion-gate-v0"; }],
  ]) {
    await context.test(name, async () => {
      const candidate = structuredClone(gated.contract);
      mutate(candidate.sourceTimetableArtifact);
      await assert.rejects(admittedItxNetworkEdgeEvidence(candidate, topology, null, gated.root), /approval identity/);
    });
  }
  await context.test("receipt-sha-mismatch", async () => {
    const candidate = structuredClone(gated.contract);
    candidate.sourceTimetableArtifact.promotion.gate.receiptSha256 = "0".repeat(64);
    await assert.rejects(admittedItxNetworkEdgeEvidence(candidate, topology, null, gated.root), /ITX_PROMOTION_RECEIPT_SHA256_MISMATCH/);
  });
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
