import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { integrateRegionalTimetables } from "./lib/regional-timetable-integrator.mjs";

// 생성 도구의 계약 검사·증거 경로. 각 테스트가 따로 RED/GREEN을 보이도록 동적으로 읽는다.
async function carDoorContract() {
  const module = await import("./prepare-nationwide-candidate-run.mjs");
  assert.equal(typeof module.carDoorHintContractViolations, "function", "carDoorHintContractViolations export");
  assert.equal(typeof module.CAR_DOOR_HINT_QUARANTINE_PATH, "string", "CAR_DOOR_HINT_QUARANTINE_PATH export");
  return module;
}

// #854 결함 3: 지역 시간표 통합(#814)이 transitStopTimes를 stopId·arrivalTimeSeconds·
// departureTimeSeconds로 쓰고 lineId를 빠뜨려 build-datapack이
// "transitStopTimes.stationId must be a non-empty string"으로 실패했다.
// #854 결함 4: KRIC 칸·문 안내 확대(#814 Phase 3)가 station_car_door_hints 계약
// (schema CHECK·빠른하차 importer 방향 어휘) 밖 행을 팩에 실었다. QA 결정(2026-10-01)으로
// 생성 단계에서 격리하고 사유·식별자·개수를 증거 파일로 남긴다.

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const canonicalPackPath = "tools/datapack/release/nationwide-production-canonical-pack.json";
const CONTRACT_FACILITY_TYPES = new Set(["STAIR", "ELEVATOR", "ESCALATOR", "TRANSFER"]);
const CONTRACT_DIRECTIONS = new Set(["", "UP", "DOWN", "INNER", "OUTER"]);

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function activePackOf(fixture) {
  const activeId = fixture.manifest?.activePack?.id;
  const matches = (fixture.packs ?? []).filter(({ id }) => id === activeId);
  assert.equal(matches.length, 1, `activePack ${activeId}은 정확히 한 팩과 맞아야 한다`);
  return matches[0];
}

test("지역 시간표 통합은 정차 시각을 stationId·lineId·arrivalSeconds·departureSeconds로 쓴다", () => {
  const lineId = "line-5b8d9b05e7e6";
  const integrated = integrateRegionalTimetables({
    finalPack: {
      stations: [
        { id: "station-a", nameKo: "가역" },
        { id: "station-b", nameKo: "나역" },
      ],
      stationLines: [
        { stationId: "station-a", lineId },
        { stationId: "station-b", lineId },
      ],
    },
    daeguAccessibility: {
      rows: [
        { stationCode: "101", stationName: "가역", lineId },
        { stationCode: "102", stationName: "나역", lineId },
      ],
    },
    daeguTimetable1: {
      sourceId: "daegu-line1-train-timetable",
      trips: [{
        id: "trip-daegu-1-up-week-1",
        dayCode: "WEEK",
        direction: "up",
        stops: [{ c: "101", a: 100, d: 110 }, { c: "102", a: 200, d: 210 }],
      }],
    },
  });

  const stopTimes = integrated.transitStopTimes.filter(({ tripId }) => tripId === "trip-daegu-1-up-week-1");
  assert.deepEqual(
    stopTimes.map(({ tripId, stationId, lineId: rowLineId, stopSequence, arrivalSeconds, departureSeconds }) => (
      { tripId, stationId, lineId: rowLineId, stopSequence, arrivalSeconds, departureSeconds }
    )),
    [
      { tripId: "trip-daegu-1-up-week-1", stationId: "station-a", lineId, stopSequence: 1, arrivalSeconds: 100, departureSeconds: 110 },
      { tripId: "trip-daegu-1-up-week-1", stationId: "station-b", lineId, stopSequence: 2, arrivalSeconds: 200, departureSeconds: 210 },
    ],
  );
  for (const row of stopTimes) {
    assert.equal(Object.hasOwn(row, "stopId"), false);
    assert.equal(Object.hasOwn(row, "arrivalTimeSeconds"), false);
    assert.equal(Object.hasOwn(row, "departureTimeSeconds"), false);
  }
});

test("커밋된 전국 정본 팩의 모든 transitStopTimes가 build-datapack 계약 필드와 trip 노선을 갖는다", () => {
  const pack = activePackOf(readJson(canonicalPackPath));
  const tripLineIds = new Map(pack.transitTrips.map((trip) => [trip.id, trip.lineId]));
  const stationLineKeys = new Set(pack.stationLines.map(({ stationId, lineId }) => `${stationId}:${lineId}`));
  const offenders = [];

  for (const row of pack.transitStopTimes) {
    const tripLineId = tripLineIds.get(row.tripId);
    const problems = [];
    if (typeof row.stationId !== "string" || row.stationId === "") problems.push("stationId");
    if (typeof row.lineId !== "string" || row.lineId === "") problems.push("lineId");
    if (!Number.isInteger(row.arrivalSeconds) || row.arrivalSeconds < 0) problems.push("arrivalSeconds");
    if (!Number.isInteger(row.departureSeconds) || row.departureSeconds < 0) problems.push("departureSeconds");
    if (tripLineId !== undefined && row.lineId !== tripLineId) problems.push("trip lineId");
    if (!stationLineKeys.has(`${row.stationId}:${row.lineId}`)) problems.push("stationLines");
    if (problems.length > 0) offenders.push(`${row.sourceId ?? "?"}:${row.tripId}#${row.stopSequence} ${problems.join(",")}`);
  }

  assert.equal(offenders.length, 0, offenders.slice(0, 5).join("\n"));
});

test("칸·문 안내 계약 검사는 대상 시설·칸·문·방향 위반 사유를 모두 돌려준다", async () => {
  const { carDoorHintContractViolations } = await carDoorContract();
  const valid = { targetFacilityType: "ELEVATOR", carNumber: 3, doorNumber: 2, direction: "UP" };
  assert.deepEqual(carDoorHintContractViolations(valid), []);
  assert.deepEqual(carDoorHintContractViolations({ ...valid, direction: "" }), []);
  assert.deepEqual(carDoorHintContractViolations({ ...valid, direction: "INNER" }), []);
  assert.deepEqual(
    carDoorHintContractViolations({ ...valid, targetFacilityType: "WHEELCHAIR_LIFT" }),
    ["TARGET_FACILITY_TYPE_OUTSIDE_CONTRACT"],
  );
  assert.deepEqual(carDoorHintContractViolations({ ...valid, doorNumber: 5 }), ["DOOR_NUMBER_OUTSIDE_CONTRACT"]);
  assert.deepEqual(carDoorHintContractViolations({ ...valid, carNumber: 11 }), ["CAR_NUMBER_OUTSIDE_CONTRACT"]);
  assert.deepEqual(carDoorHintContractViolations({ ...valid, direction: "BOTH" }), ["DIRECTION_OUTSIDE_CONTRACT"]);
  assert.deepEqual(
    carDoorHintContractViolations({ targetFacilityType: "WHEELCHAIR_LIFT", carNumber: 4, doorNumber: 6, direction: "BOTH" }),
    ["TARGET_FACILITY_TYPE_OUTSIDE_CONTRACT", "DOOR_NUMBER_OUTSIDE_CONTRACT", "DIRECTION_OUTSIDE_CONTRACT"],
  );
});

test("커밋된 전국 정본 팩의 칸·문 안내는 모두 계약 안이고, 격리 행은 증거 파일에 사유와 함께 남는다", async () => {
  const pack = activePackOf(readJson(canonicalPackPath));
  const offenders = pack.stationCarDoorHints.filter((hint) => (
    !CONTRACT_FACILITY_TYPES.has(hint.targetFacilityType)
    || !Number.isInteger(hint.carNumber) || hint.carNumber < 1 || hint.carNumber > 10
    || !Number.isInteger(hint.doorNumber) || hint.doorNumber < 1 || hint.doorNumber > 4
    || !CONTRACT_DIRECTIONS.has(hint.direction ?? "")
  ));
  assert.deepEqual(offenders.map(({ id }) => id), []);

  const { CAR_DOOR_HINT_QUARANTINE_PATH, carDoorHintContractViolations } = await carDoorContract();
  const evidence = readJson(CAR_DOOR_HINT_QUARANTINE_PATH);
  assert.equal(evidence.artifactKind, "datapack-car-door-hint-quarantine");
  assert.equal(evidence.sourceId, "kric-station-convenience-standard");
  assert.ok(evidence.rows.length > 0, "격리 행이 있어야 한다");
  assert.equal(evidence.summary.quarantinedCount, evidence.rows.length);
  assert.equal(
    evidence.summary.generatedCount,
    evidence.summary.admittedCount + evidence.summary.quarantinedCount,
  );
  assert.equal(
    pack.stationCarDoorHints.filter(({ sourceId }) => sourceId === evidence.sourceId).length,
    evidence.summary.admittedCount,
  );

  const packIds = new Set(pack.stationCarDoorHints.map(({ id }) => id));
  const byReason = {};
  for (const row of evidence.rows) {
    assert.equal(packIds.has(row.id), false, `격리 행 ${row.id}이 팩에 남으면 안 된다`);
    assert.deepEqual(row.reasons, carDoorHintContractViolations(row), `${row.id} 사유`);
    assert.ok(row.reasons.length > 0, `${row.id} 격리 사유가 있어야 한다`);
    assert.equal(typeof row.dtlLoc, "string");
    for (const reason of row.reasons) byReason[reason] = (byReason[reason] ?? 0) + 1;
  }
  assert.deepEqual(evidence.summary.byReason, byReason);
});
