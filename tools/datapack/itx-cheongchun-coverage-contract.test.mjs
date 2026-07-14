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
    sha256: "580814a58ce8d94b174de1ca8753ef7f350ce806dd793f6a7f43e07e7aa155b9",
    sqliteSha256: "72b85f941a8cb3a905218287a3e2ff4ce38561397ed5c22d77816576529ffe03",
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

test("ITX-청춘 #2116 evidence wiring은 #1400·#2098·#2099만 허용한다", () => {
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
  assert.deepEqual(contract.allowedConsumerIssues, ["#1400", "#2098", "#2099"]);
  assert.equal(contract.legacyDaejeonRowCount, 0);
  assert.equal(contract.legacyYongsanDaejeonTripCount, 0);
});

test("ITX-청춘 admission contract는 날짜·OD matrix·양방향 completeness를 fail closed한다", () => {
  assert.deepEqual(contract.completenessAdmission, {
    dateInput: "EXPLICIT",
    maxFutureDays: 6,
    replayAdmissionAllowed: false,
    serviceDayCodes: { "8": "WEEKDAY", "7": "SATURDAY", "9": "SUNDAY_OR_HOLIDAY" },
    rosterStationUniverse: "CANONICAL_GYEONGCHUN_INTERSECT_TAGO_TRAIN_STATION_CATALOG",
    excludedStationEvidenceRequired: true,
    odMatrixHashInput: ["date", "depStationId", "arrStationId"],
    odMatrixCanonicalSerialization: "SORTED_TUPLE_ARRAY_JSON_UTF8",
    requiredDirections: ["D", "U"],
    requiredTrainNumberSets: ["ROSTER", "PLAN", "INFO", "MATERIALIZED"],
    incompleteStatus: "MISSING",
    cliFailureExitCode: 1,
  });
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

test("ITX-청춘 admission evidence는 #2097 canonical bundled pack bytes에 결합된다", async () => {
  const canonicalPackBytes = await readFile(new URL(
    "../../apps/mobile/assets/datapacks/capital.sqlite.gz",
    import.meta.url,
  ));
  const canonicalPackSha256 = createHash("sha256").update(canonicalPackBytes).digest("hex");
  const canonicalPackSqliteSha256 = createHash("sha256")
    .update(gunzipSync(canonicalPackBytes))
    .digest("hex");
  assert.deepEqual(contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity, {
    id: "capital",
    sourceIssue: 2097,
    sha256: canonicalPackSha256,
    sqliteSha256: canonicalPackSqliteSha256,
  });
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
  assert.equal(new Date(contract.freshness.nextReviewAt).toISOString(), contract.freshness.nextReviewAt);
  assert.doesNotMatch(serialized, /serviceKey=|KRIC_SERVICE_KEY|DATA_GO_KR_SERVICE_KEY/);
});
