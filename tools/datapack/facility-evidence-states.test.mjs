import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildFixture } from "./import-official-sources.mjs";
import { facilityAbsenceCoverageBySource } from "./lib/facility-evidence-states.mjs";
import {
  KRIC_ESCALATOR_SOURCE_ID,
  KRIC_STANDARD_ABSENCE_COVERED_TYPES,
  KRIC_STANDARD_SOURCE_ID,
  kricFacilityStatusState,
  kricQueryFacilities,
  kricRowsOfType,
  kricStationContexts,
} from "./lib/kric-standard-facilities.mjs";
import { capitalPilotProductionSourceInput, testOnlyInventoryPath } from "./test-fixtures/datapack-tools-source-ingest.mjs";

// #3036 QA 승인 2026-10-23: 시설 증거는 (역, 노선, 유형)마다 EXISTS·NOT_EXISTS·UNKNOWN 세 상태다.
// 부재(NOT_EXISTS)는 그 유형을 다루는 원천(production scope의 facilityAbsenceCoverage)이 낼 때만 인정한다.
async function pilotFacilityImport(t, { mutateInput = () => {} } = {}) {
  const outputDir = path.join(tmpdir(), `easysubway-pilot-facility-states-${process.pid}-${Date.now()}`);
  await mkdir(outputDir, { recursive: true });
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const inventory = JSON.parse(await readFile(await testOnlyInventoryPath(outputDir), "utf8"));
  const input = await capitalPilotProductionSourceInput();
  mutateInput(input);
  return () => buildFixture(inventory, input);
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const escalatorRows = (input) => input.accessibilityStatusEvidence.filter(({ facilityType }) => facilityType === "ESCALATOR");

test("#3036 pilot 입력은 에스컬레이터를 부재가 아닌 UNKNOWN 증거로 싣고 시설 증거 게이트를 통과한다", async (t) => {
  const fixture = (await pilotFacilityImport(t))();
  const evidence = fixture.packs[0].stationFacilityEvidence;
  assert.deepEqual(
    evidence.filter(({ facilityType }) => facilityType === "ESCALATOR")
      .map(({ stationId, lineId, evidenceKind, installationStatus }) => `${stationId}:${lineId}:${evidenceKind}:${installationStatus}`).sort(),
    ["station-sadang:seoul-4:UNKNOWN:UNKNOWN", "station-sangnoksu:seoul-4:UNKNOWN:UNKNOWN"],
  );
  assert.deepEqual(evidence.filter(({ evidenceKind, facilityType }) => evidenceKind === "NOT_EXISTS" && facilityType === "ESCALATOR"), []);
});

test("#3036 원천이 다루지 않는 유형의 부재는 FACILITY_ABSENCE_WITHOUT_COVERING_SOURCE로 실패한다", async (t) => {
  const asAbsence = (row) => Object.assign(row, {
    evidenceKind: "NOT_EXISTS", installationStatus: "NOT_INSTALLED", operationalStatus: "NOT_APPLICABLE",
    statusMeaning: "EXHAUSTIVE_LIST_ABSENCE", confidence: 100, strictRouteEligibleReason: "FACILITY_NOT_INSTALLED",
  });
  const escalatorAbsence = await pilotFacilityImport(t, { mutateInput: (input) => escalatorRows(input).forEach(asAbsence) });
  assert.throws(escalatorAbsence, /FACILITY_ABSENCE_WITHOUT_COVERING_SOURCE: 2 rows \(station-sadang:seoul-4:ESCALATOR \(test-only-capital-accessibility-fixture\), station-sangnoksu:seoul-4:ESCALATOR/);

  const undeclared = await pilotFacilityImport(t, {
    mutateInput: (input) => { input.supportedV1Scope.facilityAbsenceCoverage = []; },
  });
  assert.throws(undeclared, /FACILITY_ABSENCE_WITHOUT_COVERING_SOURCE: 2 rows \(station-sadang:seoul-4:WHEELCHAIR_LIFT/);
});

test("#3036 UNKNOWN도 없는 칸은 여전히 실패하고 검증된 칸 수 하한을 강제한다", async (t) => {
  const missing = await pilotFacilityImport(t, {
    mutateInput: (input) => {
      input.accessibilityStatusEvidence = input.accessibilityStatusEvidence.filter(({ facilityType }) => facilityType !== "ESCALATOR");
    },
  });
  assert.throws(missing, /production facility evidence missing: station-sadang:seoul-4:ESCALATOR/);

  const aboveVerified = await pilotFacilityImport(t, {
    mutateInput: (input) => { input.supportedV1Scope.facilityCoverageDenominator.minimumVerifiedRows = 5; },
  });
  assert.throws(aboveVerified, /FACILITY_VERIFIED_ROWS_BELOW_MINIMUM: 4\/5/);

  const undeclaredMinimum = await pilotFacilityImport(t, {
    mutateInput: (input) => { delete input.supportedV1Scope.facilityCoverageDenominator.minimumVerifiedRows; },
  });
  assert.throws(undeclaredMinimum, /facilityCoverageDenominator\.minimumVerifiedRows/);
});

test("#3036 production scope는 원천별로 부재를 단정할 수 있는 시설 유형을 닫힌 목록으로만 선언한다", () => {
  const scope = (facilityAbsenceCoverage) => ({ facilityAbsenceCoverage });
  const sourceIds = [KRIC_STANDARD_SOURCE_ID];
  assert.deepEqual(
    facilityAbsenceCoverageBySource(scope([{ sourceId: KRIC_STANDARD_SOURCE_ID, facilityTypes: ["ELEVATOR", "WHEELCHAIR_LIFT"] }]), sourceIds),
    new Map([[KRIC_STANDARD_SOURCE_ID, new Set(["ELEVATOR", "WHEELCHAIR_LIFT"])]]),
  );
  for (const declared of [
    undefined,
    [{ sourceId: KRIC_STANDARD_SOURCE_ID, facilityTypes: ["STAIR"] }],
    [{ sourceId: KRIC_STANDARD_SOURCE_ID, facilityTypes: ["ELEVATOR", "ELEVATOR"] }],
    [{ sourceId: KRIC_STANDARD_SOURCE_ID, facilityTypes: [] }],
    [{ sourceId: "unselected-source", facilityTypes: ["ELEVATOR"] }],
    [{ sourceId: KRIC_STANDARD_SOURCE_ID, facilityTypes: ["ELEVATOR"] }, { sourceId: KRIC_STANDARD_SOURCE_ID, facilityTypes: ["WHEELCHAIR_LIFT"] }],
  ]) {
    assert.throws(() => facilityAbsenceCoverageBySource(scope(declared), sourceIds), /supportedV1Scope\.facilityAbsenceCoverage/, JSON.stringify(declared));
  }
});

const trackedPilotInput = async () => JSON.parse(await readFile(path.join(import.meta.dirname, "inputs/capital-pilot-production-source-input.json"), "utf8"));

test("#3036 pilot scope의 KRIC 편의시설 선언은 부재를 만드는 규칙과 같고 에스컬레이터를 포함하지 않는다", async () => {
  const input = await trackedPilotInput();
  const declared = input.supportedV1Scope.facilityAbsenceCoverage.find(({ sourceId }) => sourceId === KRIC_STANDARD_SOURCE_ID);
  assert.deepEqual(declared.facilityTypes, [...KRIC_STANDARD_ABSENCE_COVERED_TYPES]);
  assert.equal(declared.facilityTypes.includes("ESCALATOR"), false);
});

test("#3036 pilot scope의 검증된 칸 하한은 원천이 존재·부재를 말할 수 없는 유형의 칸을 뺀 수다", async () => {
  const input = await trackedPilotInput();
  const { requiredFacilityTypes, facilityCoverageDenominator } = input.supportedV1Scope;
  const stationLines = input.stationMappings.filter(({ sourceId }) => sourceId === "molit-urban-rail-full-route").length;
  const uncoveredTypes = requiredFacilityTypes.filter((type) => !KRIC_STANDARD_ABSENCE_COVERED_TYPES.includes(type));
  assert.deepEqual(uncoveredTypes, ["ESCALATOR"]);
  assert.equal(facilityCoverageDenominator.expectedRows, stationLines * requiredFacilityTypes.length);
  assert.equal(facilityCoverageDenominator.minimumVerifiedRows, facilityCoverageDenominator.expectedRows - stationLines * uncoveredTypes.length);
  assert.deepEqual([facilityCoverageDenominator.expectedRows, facilityCoverageDenominator.minimumVerifiedRows], [6, 4]);
});

test("#3036 결과 03 조회는 그 역-노선을 조회한 것으로 치지 않아 형제 역-노선의 부재 단정을 막는다", () => {
  const stationLines = ["line-5", "line-2"].map((lineId) => ({ stationId: "station-k", lineId }));
  const query = (lineId, providerResultCode, rows) => ({ stationId: "station-k", lineId, providerResultCode, rows });
  const liftState = (queries, snapshot = { sourceId: KRIC_STANDARD_SOURCE_ID, providerResultCode: "MIXED" }) => {
    const { evidenceKind, statusMeaning } = kricFacilityStatusState("WHEELCHAIR_LIFT", kricStationContexts(snapshot, queries, stationLines).get("station-k"));
    return [evidenceKind, statusMeaning];
  };
  assert.deepEqual(liftState([query("line-5", "00", [{ gubun: "EV" }]), query("line-2", "03", [])]), ["UNKNOWN", "STATION_LINE_NOT_QUERIED"]);
  assert.deepEqual(liftState([query("line-5", "00", [{ gubun: "EV" }]), query("line-2", "00", [])]), ["NOT_EXISTS", "EXHAUSTIVE_LIST_ABSENCE"]);
});

test("#3036 조회별 결과 코드가 없는 조회는 결과 03이 없는 snapshot에서만 결과 00이다", () => {
  const stationLines = ["line-5", "line-2"].map((lineId) => ({ stationId: "station-k", lineId }));
  const queries = [{ stationId: "station-k", lineId: "line-5", rows: [{ gubun: "EV" }] }, { stationId: "station-k", lineId: "line-2", rows: [] }];
  const standard = (fields) => ({ sourceId: KRIC_STANDARD_SOURCE_ID, ...fields });
  const liftState = (snapshot) => {
    const { evidenceKind, statusMeaning } = kricFacilityStatusState("WHEELCHAIR_LIFT", kricStationContexts(snapshot, queries, stationLines).get("station-k"));
    return [evidenceKind, statusMeaning];
  };
  assert.deepEqual(liftState(standard({ providerResultCode: "00" })), ["NOT_EXISTS", "EXHAUSTIVE_LIST_ABSENCE"]);
  assert.deepEqual(liftState(standard({})), ["NOT_EXISTS", "EXHAUSTIVE_LIST_ABSENCE"]);
  assert.deepEqual(liftState(standard({ providerResultCode: "MIXED" })), ["UNKNOWN", "STATION_LINE_NOT_QUERIED"]);
  const explicitTerminal = [queries[0], { ...queries[1], providerResultCode: "03" }];
  const { evidenceKind } = kricFacilityStatusState("WHEELCHAIR_LIFT", kricStationContexts(standard({ providerResultCode: "00" }), explicitTerminal, stationLines).get("station-k"));
  assert.equal(evidenceKind, "UNKNOWN", "snapshot 코드가 00이어도 명시적 결과 03 조회는 조회된 것으로 치지 않는다");
});

// #3036 QA 승인 2026-10-23: 에스컬레이터는 stationEscalator(새 원천 id)로 다시 받는다. 행 하나가 에스컬레이터 하나이고,
// 결과 00 조회가 아무 행도 주지 않고 그 역의 팩 역-노선이 모두 결과 00으로 조회됐을 때만 부재다. 결과 03·조회 누락은 UNKNOWN이다.
const escalatorRow = (stinCd, dtlLoc) => ({
  dtlLoc, exitNo: "1", grndDvNmFr: "지하", grndDvNmTo: "지하", lnCd: "1", railOprIsttCd: "S1",
  runStinFlorFr: "1", runStinFlorTo: "2", stinCd, updnDvNm: "상행",
});
const escalatorQuery = (stationId, lineId, stinCd, rows, fields = {}) => ({
  stationId, lineId, railOprIsttCd: "S1", lnCd: "1", stinCd, rows, providerRecordHash: `hash-${stationId}-${lineId}`, ...fields,
});
const escalatorSnapshot = (queries, fields = {}) => ({
  sourceId: KRIC_ESCALATOR_SOURCE_ID, snapshotId: "kric-station-escalator-detailed-20261023T000000000Z",
  observedAt: "2026-10-23T00:00:00.000Z", capturedAt: "2026-10-23T00:00:00.000Z", providerResultCode: "00", queries, ...fields,
});
const escalatorStationLines = [
  ["station-single", "line-1"], ["station-transfer", "line-1"], ["station-transfer", "line-2"],
  ["station-partial", "line-1"], ["station-partial", "line-9"], ["station-listed", "line-1"],
].map(([stationId, lineId]) => ({ stationId, lineId }));

function escalatorStates(snapshot) {
  const contexts = kricStationContexts(snapshot, snapshot.queries, escalatorStationLines);
  const states = {};
  for (const query of snapshot.queries.filter(({ providerResultCode }) => providerResultCode !== "03")) {
    const { facilities, statusEvidence } = kricQueryFacilities({ snapshot, query, stationName: query.stationId, stationContexts: contexts });
    for (const { type } of facilities) states[`${query.stationId}|${query.lineId}|${type}`] = "EXISTS";
    for (const row of statusEvidence) states[`${row.stationId}|${row.lineId}|${row.facilityType}`] = `${row.evidenceKind}:${row.statusMeaning}:${row.sourceId}`;
  }
  return states;
}

const ESCALATOR_STATE_QUERIES = [
  escalatorQuery("station-single", "line-1", "101", []),
  escalatorQuery("station-transfer", "line-1", "102", [escalatorRow("102", "환승통로")]),
  escalatorQuery("station-transfer", "line-2", "202", []),
  escalatorQuery("station-partial", "line-1", "103", []),
  escalatorQuery("station-listed", "line-1", "104", [escalatorRow("104", "1번 출구"), escalatorRow("104", "대합실")]),
];
const ESCALATOR_EXPECTED_STATES = {
  "station-single|line-1|ESCALATOR": `NOT_EXISTS:EXHAUSTIVE_LIST_ABSENCE:${KRIC_ESCALATOR_SOURCE_ID}`,
  "station-transfer|line-1|ESCALATOR": "EXISTS",
  "station-transfer|line-2|ESCALATOR": `UNKNOWN:LISTED_ON_OTHER_LINE_QUERY:${KRIC_ESCALATOR_SOURCE_ID}`,
  "station-partial|line-1|ESCALATOR": `UNKNOWN:STATION_LINE_NOT_QUERIED:${KRIC_ESCALATOR_SOURCE_ID}`,
  "station-listed|line-1|ESCALATOR": "EXISTS",
};

test("#3036 에스컬레이터 원천은 결과 00 조회의 행을 에스컬레이터로 읽고 역 단위 규칙으로만 부재를 낸다(조회별 코드 없는 snapshot)", () => {
  assert.deepEqual(escalatorStates(escalatorSnapshot(ESCALATOR_STATE_QUERIES)), ESCALATOR_EXPECTED_STATES);
});

test("#3036 에스컬레이터 원천 혼합 snapshot에서 결과 03 역-노선은 조회되지 않은 것이라 같은 역의 부재를 막는다", () => {
  const mixed = escalatorSnapshot([
    ...ESCALATOR_STATE_QUERIES.map((query) => ({ ...query, providerResultCode: "00" })),
    escalatorQuery("station-single", "line-1", "101", [], { providerResultCode: "03", status: "UNVERIFIED_EVIDENCE_BLOCKED" }),
  ].filter((query, index) => index !== 0), { providerResultCode: "MIXED" });
  assert.deepEqual(escalatorStates(mixed), {
    ...Object.fromEntries(Object.entries(ESCALATOR_EXPECTED_STATES).filter(([key]) => !key.startsWith("station-single"))),
  });
  const terminalSibling = escalatorSnapshot([
    escalatorQuery("station-transfer", "line-1", "102", [], { providerResultCode: "00" }),
    escalatorQuery("station-transfer", "line-2", "202", [], { providerResultCode: "03" }),
  ], { providerResultCode: "MIXED" });
  assert.deepEqual(escalatorStates(terminalSibling), {
    "station-transfer|line-1|ESCALATOR": `UNKNOWN:STATION_LINE_NOT_QUERIED:${KRIC_ESCALATOR_SOURCE_ID}`,
  });
  const codeless = escalatorSnapshot([escalatorQuery("station-single", "line-1", "101", [])], { providerResultCode: "MIXED" });
  assert.throws(() => escalatorStates(codeless), /KRIC provider result is not 00: <missing>/);
});

test("#3036 에스컬레이터 원천은 에스컬레이터 증거만 내고 시설 행은 원천 id·조회 tuple·원문 hash로 정해진다", () => {
  const snapshot = escalatorSnapshot(ESCALATOR_STATE_QUERIES);
  const query = ESCALATOR_STATE_QUERIES[4];
  const { facilities, statusEvidence } = kricQueryFacilities({
    snapshot, query, stationName: "리스트", stationContexts: kricStationContexts(snapshot, snapshot.queries, escalatorStationLines),
  });
  const rowHashes = query.rows.map((row) => sha256(JSON.stringify(row))).sort();
  assert.deepEqual(statusEvidence, []);
  assert.deepEqual(facilities.map(({ id, type, name, providerFacilityRef, floorFrom, description }) => ({ id, type, name, providerFacilityRef, floorFrom, description })),
    rowHashes.map((rowHash, index) => ({
      id: `facility-station-listed-escalator-kric-escalator-${rowHash.slice(0, 16)}`,
      type: "ESCALATOR",
      name: `리스트역 ESCALATOR ${index + 1}`,
      providerFacilityRef: `S1:1:104:ES:${rowHash}`,
      floorFrom: "",
      description: query.rows.find((row) => sha256(JSON.stringify(row)) === rowHash).dtlLoc,
    })));
  for (const facility of facilities) {
    assert.equal(facility.evidenceHash, sha256(JSON.stringify({
      snapshotId: snapshot.snapshotId, query: { railOprIsttCd: "S1", lnCd: "1", stinCd: "104" }, providerRecordHash: facility.providerRecordHash,
    })));
  }
  const [absence] = kricQueryFacilities({
    snapshot, query: ESCALATOR_STATE_QUERIES[0], stationName: "단일", stationContexts: kricStationContexts(snapshot, snapshot.queries, escalatorStationLines),
  }).statusEvidence;
  assert.equal(absence.evidenceHash, sha256(JSON.stringify({
    snapshotId: snapshot.snapshotId, query: { railOprIsttCd: "S1", lnCd: "1", stinCd: "101" }, type: "ESCALATOR", evidenceKind: "NOT_EXISTS",
  })));
  assert.deepEqual(kricRowsOfType(snapshot, query.rows, "ESCALATOR"), query.rows);
  assert.equal(kricRowsOfType(snapshot, query.rows, "ELEVATOR"), null, "에스컬레이터 원천은 승강기 증거를 말하지 않는다");
});

test("#3036 표준 원천은 계속 에스컬레이터를 다루지 않는 유형으로 두고 ES 행은 gubun으로만 읽는다", () => {
  const snapshot = { sourceId: KRIC_STANDARD_SOURCE_ID, snapshotId: "standard", providerResultCode: "00", queries: [] };
  const rows = [{ gubun: "ES" }, { gubun: "EV" }, { gubun: "TOLT" }];
  assert.deepEqual(kricRowsOfType(snapshot, rows, "ESCALATOR"), [{ gubun: "ES" }]);
  assert.deepEqual(kricRowsOfType(snapshot, rows, "ELEVATOR"), [{ gubun: "EV" }]);
  const contexts = kricStationContexts(snapshot, [], [{ stationId: "station-k", lineId: "line-1" }]);
  assert.equal(kricFacilityStatusState("ESCALATOR", contexts.get("station-k")).statusMeaning, "SOURCE_DOES_NOT_COVER_TYPE");
});

test("#3036 등록되지 않은 원천 id의 snapshot은 증거를 만들지 않고 실패하며 결속에도 쓰이지 않는다", () => {
  for (const sourceId of [undefined, "kric-station-escalator", "kric-station-elevator"]) {
    const snapshot = escalatorSnapshot(ESCALATOR_STATE_QUERIES, { sourceId });
    assert.throws(() => kricStationContexts(snapshot, snapshot.queries, escalatorStationLines), /unknown KRIC facility source/, String(sourceId));
    assert.throws(() => kricQueryFacilities({ snapshot, query: ESCALATOR_STATE_QUERIES[0], stationName: "단일", stationContexts: new Map() }),
      /unknown KRIC facility source/, String(sourceId));
    assert.equal(kricRowsOfType(snapshot, ESCALATOR_STATE_QUERIES[4].rows, "ESCALATOR"), null, String(sourceId));
  }
});
