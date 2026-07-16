import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { gunzipSync } from "node:zlib";

const contract = JSON.parse(await readFile(new URL("./itx-cheongchun-coverage-contract.json", import.meta.url), "utf8"));
const targets = JSON.parse(await readFile(new URL("./nationwide-coverage-targets.json", import.meta.url), "utf8"));
const sourceCandidates = JSON.parse(await readFile(new URL("./source-candidates.json", import.meta.url), "utf8"));
const stationSequenceEvidence = JSON.parse(await readFile(
  new URL("./sources/korail-itx-cheongchun-station-sequence-20260713.json", import.meta.url),
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
  assert.deepEqual(fixture.canonicalPackIdentity, {
    id: "capital",
    sha256: "7bb4bb68f0642e45377d98b083e93cd8c1c92aaa58dd353f32189e3f325a1562",
    sqliteSha256: "ed84a649952cd2ccbb238b3a63265f2bd3144497ae8fd36fab5181ad776542fc",
  });

  const forbiddenProductionSurfaces = [
    "./source-inventory.json",
    "./release/candidate-build-spec.json",
    "./release/capital-production-reviewed-pack.json",
    "../../apps/mobile/assets/datapacks/source-inventory.json",
    "../../apps/mobile/assets/datapacks/index.json",
    "../../apps/mobile/release/production-datapack-scope.json",
  ];
  for (const relativePath of forbiddenProductionSurfaces) {
    const productionText = await readFile(new URL(relativePath, import.meta.url), "utf8");
    assert.doesNotMatch(productionText, /test-only-itx-cheongchun-admitted\.json/);
    assert.equal(productionText.includes(fixture.timetableArtifactIdentity.id), false,
      `${relativePath}에 test-only fixture artifact ID가 연결됐다`);
    assert.equal(productionText.includes(fixtureSha256), false, `${relativePath}에 test-only fixture hash가 연결됐다`);
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
    route_graph_topology: "MISSING",
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
  assert.deepEqual(contract.allowedConsumerIssues, ["#2145", "#1400", "#2098", "#2099", "#2058", "#2137"]);
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

test("ITX-청춘 production source artifact는 변경 없는 5-set의 UNCHANGED_AUTO exact bytes로 ADMITTED된다", async () => {
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
    mode: "UNCHANGED_AUTO",
    previousArtifactSha256: "4134ae94f2cae0e6463077ee8c29c2f2417904de9dd2e751782c26ab0af1a2a7",
    previousArtifactPath: "tools/datapack/sources/itx-cheongchun-source-timetable-20260715112641542.json",
    approvalUrl: null,
    approvedArtifactSha256: null,
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
  assert.equal(artifact.promotionStatus, "SUPPORTED");
  assert.equal(artifact.snapshotDiff.status, "SUPPORTED");
  assert.equal(artifact.snapshotDiff.previousArtifactSha256, reference.promotion.previousArtifactSha256);
  const diffByDay = new Map(artifact.snapshotDiff.serviceDays.map((day) => [day.dayCd, day]));
  const expectedDayCds = Object.keys(artifact.selectedServiceDates).sort();
  assert.deepEqual(artifact.normalizedSnapshotSets.map(({ dayCd }) => dayCd).sort(), expectedDayCds);
  assert.deepEqual([...diffByDay.keys()].sort(), expectedDayCds);
  const setNames = ["stationSet", "odSet", "trainSet", "stopSequenceSet", "timetableTupleSet"];
  for (const { dayCd, sets } of artifact.normalizedSnapshotSets) {
    const diff = diffByDay.get(dayCd);
    assert.equal(diff.blocked, false);
    for (const name of setNames) {
      const values = sets[name].map((value) => JSON.stringify(value)).sort().map(JSON.parse);
      assert.deepEqual(diff.sets[name].added, []);
      assert.deepEqual(diff.sets[name].removed, []);
      assert.equal(diff.sets[name].count, values.length);
      assert.equal(
        diff.sets[name].sha256,
        createHash("sha256").update(JSON.stringify(values)).digest("hex"),
      );
    }
  }
  assert.equal(artifact.credentialRedacted, true);
  assert.deepEqual(artifact.selectedServiceDates, { "8": "20260716", "7": "20260718", "9": "20260719" });
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

test("ITX-청춘 live admission evidence는 세 service day 전수 결과를 credential 없이 고정한다", () => {
  assert.deepEqual(contract.officialEvidence.korailCompletenessAdmission, {
    provider: "TAGO + 한국철도공사",
    officialSourceUrl: "https://www.data.go.kr/data/15125762/openapi.do",
    endpoint: "https://apis.data.go.kr/B551457/run/v2/travelerTrainRunInfo2",
    observedAt: "2026-07-14T08:35:44.292Z",
    artifactId: "itx-cheongchun-completeness-admission-20260714T083544292Z",
    canonicalPackIdentity: {
      id: "capital",
      sourceIssue: 2097,
      sha256: "580814a58ce8d94b174de1ca8753ef7f350ce806dd793f6a7f43e07e7aa155b9",
      sqliteSha256: "72b85f941a8cb3a905218287a3e2ff4ce38561397ed5c22d77816576529ffe03",
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

test("ITX-청춘 admission input identity는 #1400 topology output까지 연속 lineage를 이룬다", async () => {
  const canonicalPackBytes = await readFile(new URL(
    "../../apps/mobile/assets/datapacks/capital.sqlite.gz",
    import.meta.url,
  ));
  const canonicalPackSha256 = createHash("sha256").update(canonicalPackBytes).digest("hex");
  const canonicalPackSqliteSha256 = createHash("sha256")
    .update(gunzipSync(canonicalPackBytes))
    .digest("hex");
  const topologyEvidence = JSON.parse(await readFile(new URL(
    "./itx-cheongchun-topology-evidence.json",
    import.meta.url,
  ), "utf8"));
  assert.deepEqual(contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity, {
    id: "capital",
    sourceIssue: 2097,
    sha256: topologyEvidence.pack.inputSha256,
    sqliteSha256: topologyEvidence.pack.inputSqliteSha256,
  });
  assert.equal(topologyEvidence.sourceIssue, 2135);
  assert.equal(topologyEvidence.pack.outputSha256, canonicalPackSha256);
  assert.equal(topologyEvidence.pack.outputSqliteSha256, canonicalPackSqliteSha256);
  assert.equal(
    contract.officialEvidence.korailCompletenessAdmission.artifactId,
    "itx-cheongchun-completeness-admission-20260714T083544292Z",
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
