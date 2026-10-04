import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

import { resolveItxStationCatalogEvidenceTarget } from "./lib/itx-release-evidence-target.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const execFileAsync = promisify(execFile);
import { stageLocalMobileFixture } from "../ci/stage-local-mobile-fixture.mjs";
stageLocalMobileFixture({ repositoryRoot: root });
const contract = JSON.parse(await readFile(new URL("./itx-cheongchun-coverage-contract.json", import.meta.url), "utf8"));
const targets = JSON.parse(await readFile(new URL("./nationwide-coverage-targets.json", import.meta.url), "utf8"));
const sourceCandidates = JSON.parse(await readFile(new URL("./source-candidates.json", import.meta.url), "utf8"));
const stationSequenceEvidence = JSON.parse(await readFile(
  new URL("./sources/korail-itx-cheongchun-station-sequence-20260713.json", import.meta.url),
  "utf8",
));
const topologyEvidence = JSON.parse(await readFile(
  new URL("./itx-cheongchun-topology-evidence.json", import.meta.url),
  "utf8",
));
const admittedFixtureUrl = new URL("./fixtures/test-only-itx-cheongchun-admitted.json", import.meta.url);

test("deterministic ADMITTED fixture는 test-only이며 production evidence에 연결되지 않는다", async () => {
  let fixtureBytes = null;
  try {
    fixtureBytes = await readFile(admittedFixtureUrl);
  } catch {
    // 아래 assertion이 누락된 fixture를 계약 실패로 보고한다.
  }
  assert.ok(fixtureBytes, "test-only ITX-청춘 ADMITTED fixture가 필요하다");

  const fixture = JSON.parse(fixtureBytes);
  const fixtureSha256 = createHash("sha256").update(fixtureBytes).digest("hex");
  assert.equal(fixture.fixtureClass, "TEST_ONLY");
  assert.equal(fixture.serviceClass, "ITX_CHEONGCHUN");
  assert.equal(fixture.admissionStatus, "ADMITTED");
  assert.equal(fixture.admissionEligible, true);
  assert.deepEqual(fixture.timetableArtifactIdentity, {
    id: "test-only-itx-cheongchun-admitted-v1",
    sha256Source: "FIXTURE_FILE_BYTES",
  });
  const currentProductionPackIdentity = {
    id: topologyEvidence.pack.id,
    sha256: topologyEvidence.pack.outputSha256,
    sqliteSha256: topologyEvidence.pack.outputSqliteSha256,
  };
  assert.match(fixture.canonicalPackIdentity.id, /^test-only-/u);
  assert.match(fixture.canonicalPackIdentity.sha256, /^[a-f0-9]{64}$/u);
  assert.match(fixture.canonicalPackIdentity.sqliteSha256, /^[a-f0-9]{64}$/u);
  assert.notDeepEqual(fixture.canonicalPackIdentity, currentProductionPackIdentity);

  const forbiddenProductionSurfaces = [
    new URL("./source-inventory.json", import.meta.url),
    new URL("./release/candidate-build-spec.json", import.meta.url),
    new URL("./release/capital-production-reviewed-pack.json", import.meta.url),
  ];
  if (process.env.EASYSUBWAY_DATAPACK_OUTPUT) {
    forbiddenProductionSurfaces.push(path.join(process.env.EASYSUBWAY_DATAPACK_OUTPUT, "current.json"));
  }
  if (process.env.EASYSUBWAY_DATAPACK_SCOPE_POLICY) {
    forbiddenProductionSurfaces.push(path.resolve(root, process.env.EASYSUBWAY_DATAPACK_SCOPE_POLICY));
  }
  for (const productionSurface of forbiddenProductionSurfaces) {
    const productionText = await readFile(productionSurface, "utf8");
    assert.doesNotMatch(productionText, /test-only-itx-cheongchun-admitted\.json/);
    assert.equal(productionText.includes(fixture.timetableArtifactIdentity.id), false,
      `${productionSurface}에 test-only fixture artifact ID가 연결됐다`);
    assert.equal(productionText.includes(fixtureSha256), false,
      `${productionSurface}에 test-only fixture hash가 연결됐다`);
  }
});

test("ITX-청춘 coverage contract는 sequence 성공을 timetable 시각 지원으로 과장하지 않는다", () => {
  assert.deepEqual(contract.searchScopePolicy, {
    operatingRoute: "GYEONGCHUN_LINE_ONLY",
    legacyDaejeonData: "REJECT",
    partitionKey: "CANONICAL_OD_STATION_MEMBERSHIP",
    metropolitanRouteSearch: {
      SUBWAY: "EXCLUDED",
      SUBWAY_AND_TRAIN: "CANONICAL_OD_STATIONS_IN_CAPITAL_METROPOLITAN_NETWORK",
    },
    duplicatePhysicalStationAllowed: false,
  });
  assert.deepEqual(contract.coverageStates, {
    station_line_membership: "SUPPORTED",
    route_graph_topology: "SUPPORTED",
    schedule_timetable: "MISSING",
  });
  assert.equal(contract.officialEvidence.tagoTrainOd.providerResultCode, "00");
  assert.equal(contract.officialEvidence.tagoTrainOd.rowCount, 18);
  assert.equal(contract.officialEvidence.tagoTrainOd.query.kricServiceDayCode, "8");
  assert.equal(contract.officialEvidence.tagoTrainOd.limitation, "OD 결과는 완전한 trip stop sequence가 아니다.");
  assert.equal(contract.officialEvidence.kricUrbanTimetable.trainNumberJoinCount, 0);
  assert.equal(contract.officialEvidence.kricStationTimetable.providerResultCode, "00");
  assert.equal(contract.officialEvidence.kricStationTimetable.tagoTrainNumberJoinCount, 0);
  assert.deepEqual(contract.officialEvidence.korailStationSequence.routeCodeMapping,
    stationSequenceEvidence.routeCodeMapping);
  assert.equal(contract.officialEvidence.korailStationSequence.trainCount, stationSequenceEvidence.trainCount);
  assert.equal(contract.officialEvidence.korailStationSequence.stationSequenceRowCount,
    stationSequenceEvidence.stationSequenceRowCount);
  assert.equal(contract.officialEvidence.korailStationSequence.missingTimestampStopCount,
    stationSequenceEvidence.materialization.missingTimestampStopCount);
  assert.deepEqual(contract.officialEvidence.korailStationSequence.stationTimeCapability,
    stationSequenceEvidence.materialization.stationTimeCapability);
  const korailRunInfo = sourceCandidates.candidates.find(({ id }) => id === "korail-traveler-train-run-info");
  assert.deepEqual(korailRunInfo.evidence.liveMaterialization.stationTimeCapability,
    stationSequenceEvidence.materialization.stationTimeCapability);
  assert.equal(contract.officialEvidence.korailStationSequence.disposition, "SUPPORTED_FOR_CANONICAL_STOP_SEQUENCE_ONLY");
  assert.equal(contract.materialization.status, "MISSING_STATION_TIMES");
  assert.equal(contract.claimGate.supportClaimAllowed, false);
  assert.equal(contract.claimGate.currentStatus, "NO_GO");
});

test("ITX-청춘 source artifact는 승인된 후속 이슈만 소비할 수 있다", () => {
  const itxTarget = targets.railProductScope.routeMapAndRouting
    .find(({ serviceId }) => serviceId === "ITX_CHEONGCHUN");
  assert.equal(Object.hasOwn(contract.searchScopePolicy, "trainSearch"), false);
  assert.equal(Object.hasOwn(itxTarget, "trainSearchCoverage"), false);
  assert.equal(itxTarget.operatingRoute, contract.searchScopePolicy.operatingRoute);
  assert.equal(itxTarget.legacyDaejeonData, contract.searchScopePolicy.legacyDaejeonData);
  assert.equal(
    itxTarget.metropolitanRouteSearchCoverage,
    contract.searchScopePolicy.metropolitanRouteSearch.SUBWAY_AND_TRAIN,
  );
  assert.equal(targets.railProductScope.trainSearchOnly.services.includes("ITX_CHEONGCHUN"), false);
  assert.deepEqual(contract.allowedConsumerIssues, ["#2145", "#1400", "#2098", "#2099", "#2058", "#2137", "#2649"]);
  assert.deepEqual(itxTarget.coverageStates, contract.coverageStates);
  assert.equal(contract.legacyDaejeonRowCount, 0);
  assert.equal(contract.legacyYongsanDaejeonTripCount, 0);
});

test("ITX-청춘 admission contract는 날짜·OD matrix·양방향 completeness를 fail closed한다", () => {
  assert.deepEqual(contract.completenessAdmission, {
    dateInput: "EXPLICIT",
    maxFutureDays: 6,
    replayAdmissionAllowed: false,
    serviceDayCodes: { "8": "WEEKDAY", "7": "SATURDAY", "9": "SUNDAY_OR_HOLIDAY" },
    rosterStationUniverse: "CANONICAL_ITX_CORRIDOR_28_INTERSECT_TAGO_TRAIN_STATION_CATALOG",
    excludedStationEvidenceRequired: true,
    stationSetHashInput: ["canonicalStationId", "providerStationId"],
    odMatrixHashInput: [
      "date",
      "depCanonicalStationId",
      "depProviderStationId",
      "arrCanonicalStationId",
      "arrProviderStationId",
    ],
    odMatrixCanonicalSerialization: "SORTED_TUPLE_ARRAY_JSON_UTF8",
    requiredDirections: ["up", "down"],
    requiredTrainNumberSets: ["TAGO_OD", "MATERIALIZED"],
    korailPlanCorroboration: {
      required: false,
      missingDisposition: "KORAIL_PLAN_NOT_AVAILABLE_WARNING",
      duplicateDisposition: "KORAIL_PLAN_DUPLICATE_FAIL_CLOSED",
      mismatchDisposition: "KORAIL_PLAN_MISMATCH_FAIL_CLOSED",
    },
    snapshotAnomalyPolicy: {
      policyId: "itx-snapshot-anomaly-v1",
      threshold: "ZERO_TOLERANCE",
      comparisonUnit: "DAY_CD",
      normalizedSets: ["stationSet", "odSet", "trainSet", "stopSequenceSet", "timetableTupleSet"],
      bootstrapStatus: "BOOTSTRAP_REVIEW_REQUIRED",
      changeStatus: "CHANGE_REVIEW_REQUIRED",
      failureReasonCode: "SNAPSHOT_ANOMALY_BLOCKED",
    },
    failureStages: ["ROSTER", "OD_MATERIALIZATION", "PLAN_CORROBORATION", "SNAPSHOT_DIFF"],
    completenessSupportedStatus: "SUPPORTED",
    admittedReferenceStatus: "ADMITTED",
    freshnessBasis: "LATEST_SELECTED_SERVICE_DATE_NEXT_DAY_00_00_ASIA_SEOUL",
    operationResponseContracts: {
      nonPaginated: ["GetVhcleKndList", "GetCtyCodeList"],
      paginated: ["GetCtyAcctoTrainSttnList", "GetStrtpntAlocFndTrainInfo"],
    },
    incompleteStatus: "MISSING",
    quotaExhaustionCode: "TAGO_QUOTA_BUDGET_EXHAUSTED",
    cliFailureExitCode: 1,
  });
});

test("ITX-청춘 current source artifact는 OWNER-approved admission bytes를 그대로 보존한다", async () => {
  const reference = contract.sourceTimetableArtifact;
  assert.equal(reference.status, "ADMITTED");
  assert.equal(reference.admissionEligible, true);
  assert.match(reference.artifactId, /^itx-cheongchun-source-timetable-\d{17}$/);
  assert.equal(reference.artifactPath, `tools/datapack/sources/${reference.artifactId}.json`);
  assert.match(reference.sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    reference.completenessEvidencePath,
    `tools/datapack/sources/${reference.artifactId}-completeness-evidence.json`,
  );
  assert.match(reference.completenessEvidenceSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(reference.promotion, {
    mode: "CURRENT_CANDIDATE_OWNER_APPROVED",
    previousArtifactSha256: "11ba30b4306ec2a5deca909934ab1d9d0a7aef71d6b62a964c8cc6f55ea81658",
    previousArtifactPath: "tools/datapack/sources/itx-cheongchun-source-timetable-20260930163854026.json",
    approvalUrl: "https://github.com/AquilaXk/easysubway-data/issues/636#issuecomment-5981684543",
    approvedArtifactSha256: "32ad533e0c5d66794b2626cf6616c826e446f0120de7e4989eb961ee59fe5189",
  });

  const previousBytes = await readFile(new URL(`../../${reference.promotion.previousArtifactPath}`, import.meta.url));
  assert.equal(
    createHash("sha256").update(previousBytes).digest("hex"),
    reference.promotion.previousArtifactSha256,
  );

  const artifactBytes = await readFile(new URL(`../../${reference.artifactPath}`, import.meta.url));
  assert.equal(createHash("sha256").update(artifactBytes).digest("hex"), reference.sha256);
  const artifact = JSON.parse(artifactBytes);
  const completenessBytes = await readFile(new URL(`../../${reference.completenessEvidencePath}`, import.meta.url));
  assert.equal(
    createHash("sha256").update(completenessBytes).digest("hex"),
    reference.completenessEvidenceSha256,
  );
  const completeness = JSON.parse(completenessBytes);
  assert.equal(artifact.completenessEvidenceSha256, reference.completenessEvidenceSha256);
  assert.equal(completeness.validationStatus, "SUPPORTED");
  assert.equal(completeness.materialization.status, "SUPPORTED");
  assert.deepEqual(completeness.selectedServiceDates, artifact.selectedServiceDates);
  assert.equal(artifact.artifactId, reference.artifactId);
  assert.equal(artifact.artifactKind, "itx-cheongchun-source-timetable");
  assert.equal(artifact.promotionStatus, "CHANGE_REVIEW_REQUIRED");
  assert.equal(artifact.snapshotDiff.status, "CHANGE_REVIEW_REQUIRED");
  assert.equal(artifact.snapshotDiff.previousArtifactSha256, reference.promotion.previousArtifactSha256);
  const diffByDay = new Map(artifact.snapshotDiff.serviceDays.map((day) => [day.dayCd, day]));
  const expectedDayCds = Object.keys(artifact.selectedServiceDates).sort();
  assert.deepEqual(artifact.normalizedSnapshotSets.map(({ dayCd }) => dayCd).sort(), expectedDayCds);
  assert.deepEqual([...diffByDay.keys()].sort(), expectedDayCds);
  const setNames = ["stationSet", "odSet", "trainSet", "stopSequenceSet", "timetableTupleSet"];
  // QA 승인 체크포인트(#848): 평일(8)만 정차 순서·시각 튜플이 바뀌어 차단됐고, 토·일은 변화가 없다.
  const expectedBlockedByDay = { "7": false, "8": true, "9": false };
  for (const { dayCd, sets } of artifact.normalizedSnapshotSets) {
    const diff = diffByDay.get(dayCd);
    assert.equal(diff.blocked, expectedBlockedByDay[dayCd]);
    for (const name of setNames) {
      const values = sets[name].map((value) => JSON.stringify(value)).sort().map(JSON.parse);
      assert.equal(diff.sets[name].count, values.length);
      assert.equal(
        diff.sets[name].sha256,
        createHash("sha256").update(JSON.stringify(values)).digest("hex"),
      );
    }
  }
  assert.equal(artifact.credentialRedacted, true);
  assert.deepEqual(artifact.selectedServiceDates, { "8": "20261001", "7": "20261010", "9": "20261004" });
  for (const dayCd of ["8", "7", "9"]) {
    assert.deepEqual(
      [...new Set(artifact.stationSequences.filter((row) => row.dayCd === dayCd).map((row) => row.directionId))].sort(),
      ["down", "up"],
    );
  }
  assert.equal(artifact.stationSequences.filter(({ trainNumber }) => trainNumber === "2035").length, 1);
  assert.doesNotMatch(
    artifactBytes.toString("utf8"),
    /serviceKey(?:=|["']?\s*:)|KRIC_SERVICE_KEY|DATA_GO_KR_SERVICE_KEY/i,
  );
  assert.doesNotMatch(
    completenessBytes.toString("utf8"),
    /serviceKey(?:=|["']?\s*:)|KRIC_SERVICE_KEY|DATA_GO_KR_SERVICE_KEY/i,
  );
});

test("ITX-청춘 admission evidence는 historical 관측과 current pack identities를 credential 없이 고정한다", () => {
  assert.deepEqual(contract.officialEvidence.korailCompletenessAdmission, {
    provider: "TAGO + 한국철도공사",
    officialSourceUrl: "https://www.data.go.kr/data/15125762/openapi.do",
    endpoint: "https://apis.data.go.kr/B551457/run/v2/travelerTrainRunInfo2",
    observedAt: "2026-07-14T08:35:44.292Z",
    artifactId: "itx-cheongchun-completeness-admission-20260714T083544292Z",
    topologyInputPackIdentity: {
      id: "capital",
      sha256: "609a74095859b5bf7602c25e142caa47cc212170a72d6240e2d01b39f874047a",
      sqliteSha256: "bba39f717671c82278a44d0be731801c41d90b7a92dd11a9f184e6ec0f55da98",
      byteSize: 388623,
    },
    selectedServiceDates: { "8": "20260715", "7": "20260718", "9": "20260719" },
    admissionStatus: "MISSING",
    admissionEligible: false,
    canonicalStationCount: 25,
    rosterStationCount: 15,
    stationSetHash: "fe20a22d4c8fab383e287dfcb32b1fddb99e344441101a9c1e4d358a33d6f673",
    serviceDays: [
      {
        dayCd: "8", serviceDate: "20260715", rosterTrainNumberCount: 36,
        expectedOdCount: 210, completedOdCount: 210, failedOdCount: 0,
        odMatrixHash: "2f1cf28e24b20e6d279ed4ce06663a5a3a7629718511a0066ddf8529fdcf1934",
        rosterEvidenceHash: "14c2f5003f4da2489c795f5df07eec72389ed5cb814a72aa796466df715af3d6",
        failureStage: "TIMETABLE", failureReasonCode: "OFFICIAL_RUN_INFO_EMPTY",
        failureContext: "operation=travelerTrainRunInfo2,total=0",
      },
      {
        dayCd: "7", serviceDate: "20260718", rosterTrainNumberCount: 52,
        expectedOdCount: 210, completedOdCount: 210, failedOdCount: 0,
        odMatrixHash: "b7b68526820e5a49f003289cffe6309ce52961e0da96e067bef34cf28de1ebec",
        rosterEvidenceHash: "5d15a55d214f65851dd6d6cd43293279c07ba80c0e358a2dee55b4df846aed0b",
        failureStage: "TIMETABLE", failureReasonCode: "OFFICIAL_RUN_INFO_EMPTY",
        failureContext: "operation=travelerTrainRunInfo2,total=0",
      },
      {
        dayCd: "9", serviceDate: "20260719", rosterTrainNumberCount: 52,
        expectedOdCount: 210, completedOdCount: 210, failedOdCount: 0,
        odMatrixHash: "550af97e469ccc20fde2ad9a531c0896bcf8a41d746f900023a5b2c98ac28e20",
        rosterEvidenceHash: "5e038a74413bae4ebaee6c3dcfb7333ac237daa96faa7050f782f6dcd4686bb9",
        failureStage: "TIMETABLE", failureReasonCode: "OFFICIAL_RUN_INFO_EMPTY",
        failureContext: "operation=travelerTrainRunInfo2,total=0",
      },
    ],
    artifactEvidenceHash: "347aec507ec951dde65c10a1c4bff9f94454f762d76a5a74064a40662008336c",
    credentialRedacted: true,
    stationCatalogPackIdentity: {
      artifactKind: "station-catalog-pack",
      manifestVersion: 1,
      catalogPackId: "itx-current-station-catalog-v1",
      stationSetSha256: "bcbbb7f738a7ca2f581ac571574d88499a988d038cdc71ba79ef1936d60e9b6c",
      payloadSha256: "37e8fb4bd6c0946cb52b8ffdac43457b5e8b51436b49617d28ea2c8fcd4204a1",
      manifestSha256: "5328c25ffaf78085707a3e296993228f3cc3453706420a163ef4b539cb0973b9",
    },
  });
  const korailCandidate = sourceCandidates.candidates.find(({ id }) => id === "korail-traveler-train-run-info");
  assert.deepEqual(korailCandidate.evidence.currentCompletenessAdmission, {
    evidenceRef: "tools/datapack/itx-cheongchun-coverage-contract.json#officialEvidence.korailCompletenessAdmission",
    observedAt: "2026-07-14T08:35:44.292Z",
    selectedServiceDates: { "8": "20260715", "7": "20260718", "9": "20260719" },
    serviceDayCount: 3,
    totalExpectedOdCount: 630,
    totalCompletedOdCount: 630,
    totalFailedOdCount: 0,
    rosterTrainNumberCounts: { "8": 36, "7": 52, "9": 52 },
    failureReasonCode: "OFFICIAL_RUN_INFO_EMPTY",
    admissionStatus: "MISSING",
    admissionEligible: false,
    artifactEvidenceHash: "347aec507ec951dde65c10a1c4bff9f94454f762d76a5a74064a40662008336c",
    nextReviewAt: "2026-07-20T00:00:00.000Z",
    credentialRedacted: true,
  });
});

async function assertCurrentItxStationCatalogEvidence(target, context) {
  const { label, activePack, packBytes: canonicalPackBytes } = target;
  const canonicalPackSha256 = createHash("sha256").update(canonicalPackBytes).digest("hex");
  const canonicalPackSqliteSha256 = createHash("sha256")
    .update(gunzipSync(canonicalPackBytes))
    .digest("hex");
  assert.equal(activePack.sha256, canonicalPackSha256, `${label}: manifest sha256과 팩 gzip bytes가 달라졌다`);
  assert.equal(activePack.sqliteSha256, canonicalPackSqliteSha256, `${label}: manifest sqliteSha256과 팩 bytes가 달라졌다`);

  const temporaryDir = await mkdtemp(path.join(tmpdir(), "easysubway-itx-release-schema-"));
  context.after(() => rm(temporaryDir, { recursive: true, force: true }));
  const sqlitePath = path.join(temporaryDir, "capital.sqlite");
  await writeFile(sqlitePath, gunzipSync(canonicalPackBytes));
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const stationCatalogColumns = database.prepare("PRAGMA table_info(route_service_station_catalog_evidence)")
      .all()
      .map(({ name }) => name);
    assert.equal(stationCatalogColumns.some((name) => name.startsWith("canonical_pack_")), false);
    assert.deepEqual(stationCatalogColumns.filter((name) => name.startsWith("station_catalog_")), [
      "station_catalog_artifact_kind",
      "station_catalog_manifest_version",
      "station_catalog_pack_id",
      "station_catalog_station_set_sha256",
      "station_catalog_payload_sha256",
      "station_catalog_manifest_sha256",
    ], `${label}: route_service_station_catalog_evidence schema`);
    const evidence = database.prepare(`
      SELECT admission_status, admission_eligible,
             station_catalog_artifact_kind, station_catalog_manifest_version
      FROM route_service_station_catalog_evidence
      WHERE service_class = 'ITX_CHEONGCHUN'
    `).get();
    assert.deepEqual({ ...evidence }, {
      admission_status: "ADMITTED",
      admission_eligible: 1,
      station_catalog_artifact_kind: "station-catalog-pack",
      station_catalog_manifest_version: 1,
    }, `${label}: ITX_CHEONGCHUN station catalog evidence 행`);
    const artifactColumns = database.prepare("PRAGMA table_info(route_service_artifact_evidence)")
      .all()
      .map(({ name }) => name);
    assert.equal(artifactColumns.some((name) => name.startsWith("canonical_pack_")), true);
    const artifactEvidence = database.prepare(`
      SELECT admission_status, admission_eligible, canonical_pack_id
      FROM route_service_artifact_evidence
      WHERE service_class = 'ITX_CHEONGCHUN'
    `).get();
    assert.deepEqual({ ...artifactEvidence }, {
      admission_status: "ADMITTED",
      admission_eligible: 1,
      canonical_pack_id: "capital",
    }, `${label}: ITX_CHEONGCHUN artifact evidence 행`);
  } finally {
    database.close();
  }
}

async function buildExploratoryFixtureCandidate(context) {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-itx-exploratory-candidate-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  await execFileAsync(process.execPath, [
    "tools/datapack/build-datapack.mjs",
    "--fixture",
    "tools/datapack/fixtures/catalog-fixture.json",
    "--output",
    outputDir,
  ], { cwd: root });
  return outputDir;
}

test("ITX-청춘 station-catalog evidence: release-candidate 모드는 새로 빌드한 후보 팩을, PR CI·exploratory 모드는 bundled capital 팩을 current schema와 exact bytes로 검사한다", async (context) => {
  const target = await resolveItxStationCatalogEvidenceTarget({ env: process.env, repositoryRoot: root });
  await assertCurrentItxStationCatalogEvidence(target, context);
});

test("exploratory 픽스처 후보는 release-candidate 검사 대상이 아니다: PR CI·exploratory는 bundled 팩을 검사하고 release-candidate 모드는 픽스처 후보를 거부한다", async (context) => {
  const fixtureOutput = await buildExploratoryFixtureCandidate(context);
  const fixtureManifest = JSON.parse(await readFile(path.join(fixtureOutput, "current.json"), "utf8"));
  assert.deepEqual(fixtureManifest.packs.map(({ artifactKind }) => artifactKind), ["fixture"]);
  const fixturePackBytes = await readFile(path.join(fixtureOutput, "catalog", "capital-v1.sqlite.gz"));
  const bundledPackBytes = await readFile(path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"));

  for (const env of [
    { EASYSUBWAY_DATAPACK_RELEASE_MODE: "exploratory", EASYSUBWAY_DATAPACK_OUTPUT: fixtureOutput },
    {},
  ]) {
    const target = await resolveItxStationCatalogEvidenceTarget({ env, repositoryRoot: root });
    assert.equal(target.kind, "bundled-pack");
    assert.equal(target.activePack.id, "capital");
    assert.deepEqual(target.packBytes, bundledPackBytes);
    assert.notDeepEqual(target.packBytes, fixturePackBytes);
  }

  await assert.rejects(
    resolveItxStationCatalogEvidenceTarget({
      env: { EASYSUBWAY_DATAPACK_RELEASE_MODE: "release-candidate", EASYSUBWAY_DATAPACK_OUTPUT: fixtureOutput },
      repositoryRoot: root,
    }),
    /release-candidate ITX 검사 대상은 production 후보 팩이어야 한다: fixture/,
  );
  await assert.rejects(
    resolveItxStationCatalogEvidenceTarget({
      env: { EASYSUBWAY_DATAPACK_RELEASE_MODE: "release-candidate" },
      repositoryRoot: root,
    }),
    /release-candidate 모드는 EASYSUBWAY_DATAPACK_OUTPUT 후보 팩이 필요하다/,
  );
  await assert.rejects(
    resolveItxStationCatalogEvidenceTarget({
      env: { EASYSUBWAY_DATAPACK_RELEASE_MODE: "production-publish", EASYSUBWAY_DATAPACK_OUTPUT: fixtureOutput },
      repositoryRoot: root,
    }),
    /ITX 검사 대상을 정할 수 없는 release mode: production-publish/,
  );
});

test("release-candidate 모드 후보 팩에 ITX_CHEONGCHUN station catalog evidence 행이 없으면 실패한다", async (context) => {
  const candidateOutput = await buildExploratoryFixtureCandidate(context);
  // 행 누락 판정만 격리하려고 임시 사본의 artifactKind만 production으로 표시한다. 팩 bytes와 sha는 빌드 산출물 그대로다.
  const manifestPath = path.join(candidateOutput, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.packs = manifest.packs.map((pack) => ({ ...pack, artifactKind: "production" }));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const target = await resolveItxStationCatalogEvidenceTarget({
    env: { EASYSUBWAY_DATAPACK_RELEASE_MODE: "release-candidate", EASYSUBWAY_DATAPACK_OUTPUT: candidateOutput },
    repositoryRoot: root,
  });
  assert.equal(target.kind, "release-candidate-pack");
  assert.deepEqual(target.packBytes, await readFile(path.join(candidateOutput, "catalog", "capital-v1.sqlite.gz")));
  await assert.rejects(
    assertCurrentItxStationCatalogEvidence(target, context),
    (error) => error instanceof assert.AssertionError
      && /ITX_CHEONGCHUN station catalog evidence 행/.test(error.message),
  );
});

test("ITX-청춘 evidence는 공식 URL·schema/hash·재검토 시점을 갖고 credential을 포함하지 않는다", () => {
  const serialized = JSON.stringify(contract);
  for (const evidence of Object.values(contract.officialEvidence)) {
    assert.match(evidence.officialSourceUrl, /^https:\/\/(?:data\.kric\.go\.kr|www\.data\.go\.kr)\//);
    assert.match(evidence.endpoint, /^https:\/\/(?:openapi\.kric\.go\.kr|apis\.data\.go\.kr)\//);
  }
  assert.match(contract.officialEvidence.kricRouteRoster.schemaFingerprint, /^[a-f0-9]{64}$/);
  assert.match(contract.officialEvidence.tagoTrainOd.evidenceHash, /^[a-f0-9]{64}$/);
  assert.equal(contract.officialEvidence.korailStationSequence.evidenceArtifact,
    "tools/datapack/sources/korail-itx-cheongchun-station-sequence-20260713.json");
  assert.match(contract.freshness.nextReviewAt, /(?:Z|[+-]\d{2}:\d{2})$/);
  assert.equal(Date.parse(contract.freshness.nextReviewAt), Date.parse(contract.sourceTimetableArtifact.freshUntil));
  assert.doesNotMatch(serialized, /serviceKey=|KRIC_SERVICE_KEY|DATA_GO_KR_SERVICE_KEY/);
});
