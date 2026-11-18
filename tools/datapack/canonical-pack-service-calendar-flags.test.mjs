import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { integrateRegionalTimetables } from "./lib/regional-timetable-integrator.mjs";
import { HOLIDAYS_2026 } from "./materialize-incheon-timetable.mjs";

// #854 결함 1: build-datapack.mjs boolFlag는 serviceCalendars 요일 값을 boolean으로만 받는다.
// 지역 시간표 통합(#814)이 0/1 숫자를 써서 release-candidate 빌드가
// "serviceCalendars.monday must be a boolean"으로 실패했다.

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function activePackOf(fixture) {
  const activeId = fixture.manifest?.activePack?.id;
  assert.equal(typeof activeId, "string", "manifest.activePack.id가 있어야 한다");
  const matches = (fixture.packs ?? []).filter(({ id }) => id === activeId);
  assert.equal(matches.length, 1, `activePack ${activeId}은 정확히 한 팩과 맞아야 한다`);
  return matches[0];
}

function nonBooleanFlags(calendars) {
  const offenders = [];
  for (const calendar of calendars) {
    for (const day of WEEKDAYS) {
      if (typeof calendar[day] !== "boolean") {
        offenders.push(`${calendar.serviceId}.${day}=${JSON.stringify(calendar[day])}`);
      }
    }
  }
  return offenders;
}

test("지역 시간표 통합은 14개 serviceCalendars의 요일 값을 boolean으로 쓴다(광주 시간표 입력이 없으면 광주 달력을 만들지 않는다, #913)", () => {
  const integrated = integrateRegionalTimetables({
    finalPack: { stations: [], stationLines: [], serviceCalendars: [] },
    holidayDates: HOLIDAYS_2026,
  });
  const days = (calendar) => WEEKDAYS.filter((day) => calendar[day] === true);
  const byServiceId = new Map(integrated.serviceCalendars.map((calendar) => [calendar.serviceId, calendar]));

  assert.equal(integrated.serviceCalendars.length, 14);
  assert.equal(integrated.serviceCalendars.some(({ serviceId }) => serviceId.startsWith("gwangju-")), false);
  assert.deepEqual(nonBooleanFlags(integrated.serviceCalendars), []);

  const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday"];
  for (const serviceId of [
    "busan-weekday-2026",
    "daegu-line1-weekday-2026",
    "daegu-line2-weekday-2026",
    "daegu-line3-weekday-2026",
    "daejeon-weekday-2026",
  ]) {
    assert.deepEqual(days(byServiceId.get(serviceId)), weekdays, serviceId);
  }
  for (const serviceId of [
    "busan-saturday-2026",
    "daegu-line1-saturday-2026",
    "daegu-line2-saturday-2026",
    "daegu-line3-saturday-2026",
  ]) {
    assert.deepEqual(days(byServiceId.get(serviceId)), ["saturday"], serviceId);
  }
  for (const serviceId of [
    "busan-holiday-2026",
    "daegu-line1-holiday-2026",
    "daegu-line2-holiday-2026",
    "daegu-line3-holiday-2026",
  ]) {
    assert.deepEqual(days(byServiceId.get(serviceId)), ["sunday"], serviceId);
  }
  for (const serviceId of ["daejeon-holiday-2026"]) {
    assert.deepEqual(days(byServiceId.get(serviceId)), ["saturday", "sunday"], serviceId);
  }
});

test("커밋된 전국 정본 팩의 모든 serviceCalendars 요일 값이 boolean이다", () => {
  const fixture = JSON.parse(readFileSync(
    path.join(root, "tools/datapack/release/nationwide-production-canonical-pack.json"),
    "utf8",
  ));
  const pack = activePackOf(fixture);

  assert.ok(pack.serviceCalendars.length > 0, "serviceCalendars가 비어 있으면 안 된다");
  assert.deepEqual(nonBooleanFlags(pack.serviceCalendars), []);
});
