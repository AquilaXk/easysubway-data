import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildFixture } from "./import-official-sources.mjs";
import { facilityAbsenceCoverageBySource } from "./lib/facility-evidence-states.mjs";
import {
  KRIC_STANDARD_ABSENCE_COVERED_TYPES,
  KRIC_STANDARD_SOURCE_ID,
  kricStandardStationContexts,
  kricStandardStatusState,
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
  const liftState = (queries) => {
    const { evidenceKind, statusMeaning } = kricStandardStatusState("WHEELCHAIR_LIFT", kricStandardStationContexts(queries, stationLines).get("station-k"));
    return [evidenceKind, statusMeaning];
  };
  assert.deepEqual(liftState([query("line-5", "00", [{ gubun: "EV" }]), query("line-2", "03", [])]), ["UNKNOWN", "STATION_LINE_NOT_QUERIED"]);
  assert.deepEqual(liftState([query("line-5", "00", [{ gubun: "EV" }]), query("line-2", "00", [])]), ["NOT_EXISTS", "EXHAUSTIVE_LIST_ABSENCE"]);
});
