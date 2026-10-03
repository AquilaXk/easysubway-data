import { createHash } from "node:crypto";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/**
 * Regional Timetable Integrator for Non-Capital Transit Authorities:
 * 1. Busan Transportation Corp (Lines 1, 2, 3, 4)
 * 2. Daegu Transportation Corp (Lines 1, 2, 3)
 * 3. Daejeon Transportation Corp (Line 1)
 * 4. Gwangju Metropolitan Rapid Transit (Line 1)
 */

export function integrateRegionalTimetables({
  finalPack,
  busanTimetable,
  busanAccessibility,
  daeguTimetable1,
  daeguTimetable2,
  daeguTimetable3,
  daeguAccessibility,
  daejeonTimetable,
  daejeonAccessibility,
  gwangjuTimetable,
  gwangjuAccessibility,
}) {
  const routes = [...(finalPack.transitRoutes ?? [])];
  const trips = [...(finalPack.transitTrips ?? [])];
  const stopTimes = [...(finalPack.transitStopTimes ?? [])];
  const calendars = [...(finalPack.serviceCalendars ?? [])];
  const calendarDates = [...(finalPack.serviceCalendarDates ?? [])];
  // #855: 원천 정차 2개 이상으로 열차를 만들 수 없는 대전·광주 원천 시각. 추정 정차를 붙이지 않고 증거로 남긴다.
  const regionalTimetableQuarantine = [];

  function cleanName(n) {
    return String(n ?? "").replace(/\(.*?\)/g, "").replace(/\d+$/, "").replace(/[·•ㆍ]/g, ".").trim();
  }

  const STATION_NAME_ALIASES = new Map([
    ["성서산단", "성서산업단지"],
    ["성서산업단지", "성서산단"],
    ["광주송정", "광주송정역"],
    ["광주송정역", "광주송정"],
  ]);

  function makeStationResolver(lineId, accessibilityRows) {
    const codeToId = new Map();
    const nameToId = new Map();
    const candidates = finalPack.stationLines.filter((sl) => sl.lineId === lineId);

    const registerName = (name, id) => {
      if (!name) return;
      nameToId.set(name, id);
      nameToId.set(cleanName(name), id);
      if (name.endsWith("역") && name.length > 2 && name !== "서울역") {
        nameToId.set(name.slice(0, -1), id);
        nameToId.set(cleanName(name.slice(0, -1)), id);
      }
      const alias = STATION_NAME_ALIASES.get(name) ?? STATION_NAME_ALIASES.get(cleanName(name));
      if (alias) {
        nameToId.set(alias, id);
        nameToId.set(cleanName(alias), id);
      }
    };

    for (const sl of candidates) {
      const st = finalPack.stations.find((s) => s.id === sl.stationId);
      if (st) {
        registerName(st.nameKo, st.id);
      }
    }

    for (const row of accessibilityRows ?? []) {
      if (row.lineId === lineId || !row.lineId) {
        const rawName = row.stationName;
        const stationId = nameToId.get(cleanName(rawName)) ?? nameToId.get(rawName) ?? (rawName?.endsWith("역") && rawName.length > 2 ? nameToId.get(rawName.slice(0, -1)) : null);
        if (stationId && row.stationCode) {
          codeToId.set(String(row.stationCode), stationId);
        }
      }
    }

    return {
      resolveByIdOrCode(code, rawName) {
        if (code && codeToId.has(String(code))) return codeToId.get(String(code));
        if (rawName) {
          const cleaned = cleanName(rawName);
          if (nameToId.has(cleaned)) return nameToId.get(cleaned);
          if (nameToId.has(rawName)) return nameToId.get(rawName);
          if (rawName.endsWith("역") && rawName.length > 2) {
            const stripped = rawName.slice(0, -1);
            if (nameToId.has(stripped)) return nameToId.get(stripped);
          }
        }
        return null;
      },
    };
  }

  // =========================================================================
  // 1. Busan Transportation Corporation (Lines 1, 2, 3, 4)
  // =========================================================================
  const busanLineMap = {
    "1": "line-ab1a041f6266",
    "2": "line-eb7b47920390",
    "3": "line-d74614a04530",
    "4": "line-d812a5bc1e5f",
  };
  const busanDayMap = {
    "1": "busan-weekday-2026",
    "2": "busan-saturday-2026",
    "3": "busan-holiday-2026",
  };

  for (const [lineNum, lineId] of Object.entries(busanLineMap)) {
    routes.push({
      id: `route-busan-line-${lineNum}`,
      agencyId: "busan-transportation",
      routeShortName: `부산 ${lineNum}호선`,
      routeLongName: `부산 도시철도 ${lineNum}호선`,
      routeType: 1,
      routeColor: lineNum === "1" ? "#f0802b" : lineNum === "2" ? "#2ab564" : lineNum === "3" ? "#bb8c00" : "#225eb3",
      routeTextColor: "#ffffff",
      lineId,
    });
  }

  calendars.push(
    { serviceId: "busan-weekday-2026", monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false, startDate: "20260101", endDate: "20261231" },
    { serviceId: "busan-saturday-2026", monday: false, tuesday: false, wednesday: false, thursday: false, friday: false, saturday: true, sunday: false, startDate: "20260101", endDate: "20261231" },
    { serviceId: "busan-holiday-2026", monday: false, tuesday: false, wednesday: false, thursday: false, friday: false, saturday: false, sunday: true, startDate: "20260101", endDate: "20261231" }
  );

  const busanResolvers = {};
  for (const [lineNum, lineId] of Object.entries(busanLineMap)) {
    busanResolvers[lineNum] = makeStationResolver(lineId, busanAccessibility?.rows);
  }

  if (busanTimetable?.rows) {
    const groups = new Map();
    for (const r of busanTimetable.rows) {
      const key = `${r.line}:${r.day}:${r.trainno}:${r.updown}:${r.endcode}`;
      let list = groups.get(key);
      if (!list) {
        list = [];
        groups.set(key, list);
      }
      list.push(r);
    }

    for (const [key, rows] of groups) {
      const [lineNum, day, trainno, updown, endcode] = key.split(":");
      const lineId = busanLineMap[lineNum];
      if (!lineId || rows.length < 2) continue;

      const resolver = busanResolvers[lineNum];
      const serviceId = busanDayMap[day] ?? "busan-weekday-2026";
      const tripId = `trip-busan-l${lineNum}-d${day}-t${trainno}-${updown}-${endcode}`;

      // Sort rows by departure seconds
      const sortedRows = rows.map((r) => ({
        ...r,
        seconds: parseInt(r.hour, 10) * 3600 + parseInt(r.time, 10) * 60,
      })).sort((a, b) => a.seconds - b.seconds);

      const tripStopTimes = [];
      let seq = 1;
      for (const r of sortedRows) {
        const stationId = resolver.resolveByIdOrCode(r.scode, r.sname);
        if (!stationId) continue;

        tripStopTimes.push({
          tripId,
          stationId,
          lineId,
          stopSequence: seq++,
          arrivalSeconds: r.seconds,
          departureSeconds: r.seconds,
          pickupType: 0,
          dropOffType: 0,
          stopHeadsign: r.endcode,
          sourceId: "busan-transportation-timetable",
        });
      }

      if (tripStopTimes.length >= 2) {
        trips.push({
          id: tripId,
          routeId: `route-busan-line-${lineNum}`,
          serviceId,
          tripHeadsign: sortedRows[sortedRows.length - 1]?.sname ?? "",
          directionId: updown === "0" ? 0 : 1,
          lineId,
          sourceId: "busan-transportation-timetable",
        });
        stopTimes.push(...tripStopTimes);
      }
    }
  }

  // =========================================================================
  // 2. Daegu Transportation Corporation (Lines 1, 2, 3)
  // =========================================================================
  const daeguConfigs = [
    { num: 1, lineId: "line-5b8d9b05e7e6", color: "#d93f3d", timetable: daeguTimetable1 },
    { num: 2, lineId: "line-e2938a4cc492", color: "#00aa80", timetable: daeguTimetable2 },
    { num: 3, lineId: "line-0ffaa95b1b5d", color: "#f5c400", timetable: daeguTimetable3 },
  ];

  for (const cfg of daeguConfigs) {
    routes.push({
      id: `route-daegu-line-${cfg.num}`,
      agencyId: "daegu-transportation",
      routeShortName: `대구 ${cfg.num}호선`,
      routeLongName: `대구 도시철도 ${cfg.num}호선`,
      routeType: 1,
      routeColor: cfg.color,
      routeTextColor: "#ffffff",
      lineId: cfg.lineId,
    });

    calendars.push(
      { serviceId: `daegu-line${cfg.num}-weekday-2026`, monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false, startDate: "20260101", endDate: "20261231" },
      { serviceId: `daegu-line${cfg.num}-saturday-2026`, monday: false, tuesday: false, wednesday: false, thursday: false, friday: false, saturday: true, sunday: false, startDate: "20260101", endDate: "20261231" },
      { serviceId: `daegu-line${cfg.num}-holiday-2026`, monday: false, tuesday: false, wednesday: false, thursday: false, friday: false, saturday: false, sunday: true, startDate: "20260101", endDate: "20261231" }
    );

    const resolver = makeStationResolver(cfg.lineId, daeguAccessibility?.rows);
    const dayCodeToService = {
      WEEK: `daegu-line${cfg.num}-weekday-2026`,
      SAT: `daegu-line${cfg.num}-saturday-2026`,
      HOLI: `daegu-line${cfg.num}-holiday-2026`,
    };

    for (const trip of cfg.timetable?.trips ?? []) {
      const serviceId = dayCodeToService[trip.dayCode] ?? `daegu-line${cfg.num}-weekday-2026`;
      const tripStopTimes = [];
      let seq = 1;

      for (const stop of trip.stops ?? []) {
        const stationId = resolver.resolveByIdOrCode(stop.c, null);
        if (!stationId) continue;

        tripStopTimes.push({
          tripId: trip.id,
          stationId,
          lineId: cfg.lineId,
          stopSequence: seq++,
          arrivalSeconds: stop.a,
          departureSeconds: stop.d,
          pickupType: 0,
          dropOffType: 0,
          sourceId: cfg.timetable.sourceId ?? "daegu-train-timetable",
        });
      }

      if (tripStopTimes.length >= 2) {
        trips.push({
          id: trip.id,
          routeId: `route-daegu-line-${cfg.num}`,
          serviceId,
          tripHeadsign: "",
          directionId: trip.direction === "dn" ? 1 : 0,
          lineId: cfg.lineId,
          sourceId: cfg.timetable.sourceId ?? "daegu-train-timetable",
        });
        stopTimes.push(...tripStopTimes);
      }
    }
  }

  // =========================================================================
  // 3. Daejeon Transportation Corporation (Line 1)
  // =========================================================================
  const daejeonLineId = "line-7051a9c2525c";
  routes.push({
    id: "route-daejeon-line-1",
    agencyId: "daejeon-transportation",
    routeShortName: "대전 1호선",
    routeLongName: "대전 도시철도 1호선",
    routeType: 1,
    routeColor: "#007448",
    routeTextColor: "#ffffff",
    lineId: daejeonLineId,
  });

  calendars.push(
    { serviceId: "daejeon-weekday-2026", monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false, startDate: "20260101", endDate: "20261231" },
    { serviceId: "daejeon-holiday-2026", monday: false, tuesday: false, wednesday: false, thursday: false, friday: false, saturday: true, sunday: true, startDate: "20260101", endDate: "20261231" }
  );

  const daejeonResolver = makeStationResolver(daejeonLineId, daejeonAccessibility?.rows);
  if (daejeonTimetable?.rows) {
    const daejeonDirs = [
      {
        drctType: "1",
        directionId: 0,
        tripHeadsign: "반석",
        stnOrder: Array.from({ length: 22 }, (_, i) => String(101 + i)),
      },
      {
        drctType: "0",
        directionId: 1,
        tripHeadsign: "판암",
        stnOrder: Array.from({ length: 22 }, (_, i) => String(122 - i)),
      },
    ];

    for (const dirCfg of daejeonDirs) {
      for (const dayType of ["0", "1"]) {
        const serviceId = dayType === "0" ? "daejeon-weekday-2026" : "daejeon-holiday-2026";
        const map = new Map();
        for (const s of dirCfg.stnOrder) {
          const matchingRows = daejeonTimetable.rows.filter(
            (r) => r.dayType === dayType && r.drctType === dirCfg.drctType && r.stNum === s
          );
          const times = [];
          for (const r of matchingRows) {
            const hr = parseInt(r.tmZone, 10);
            const mins = String(r.tmList ?? "").trim().split(/\s+/).filter(Boolean);
            for (const m of mins) {
              times.push(hr * 3600 + parseInt(m, 10) * 60);
            }
          }
          map.set(s, times.sort((a, b) => a - b));
        }

        const used = new Map();
        for (const s of dirCfg.stnOrder) used.set(s, new Set());

        for (let i = 0; i < dirCfg.stnOrder.length - 1; i++) {
          const stn = dirCfg.stnOrder[i];
          const departures = map.get(stn) ?? [];
          for (let dIdx = 0; dIdx < departures.length; dIdx++) {
            if (used.get(stn).has(dIdx)) continue;
            used.get(stn).add(dIdx);
            const startSec = departures[dIdx];
            const tripId = `trip-daejeon-d${dayType}-dir${dirCfg.drctType}-s${stn}-${startSec}`;
            const tripStops = [{ stn, time: startSec }];
            let curTime = startSec;

            for (let j = i + 1; j < dirCfg.stnOrder.length - 1; j++) {
              const nextStn = dirCfg.stnOrder[j];
              const nextDeps = map.get(nextStn) ?? [];
              let matchedIdx = -1;
              for (let k = 0; k < nextDeps.length; k++) {
                if (!used.get(nextStn).has(k) && nextDeps[k] >= curTime + 50 && nextDeps[k] <= curTime + 300) {
                  matchedIdx = k;
                  break;
                }
              }
              if (matchedIdx !== -1) {
                used.get(nextStn).add(matchedIdx);
                curTime = nextDeps[matchedIdx];
                tripStops.push({ stn: nextStn, time: curTime });
              } else {
                break;
              }
            }

            // 원천은 역별 시각 하나만 준다(종착역 행 없음). 정차 시각 하나는 도착 = 출발 = 원천 값이고,
            // 원천에 없는 종착역 도착은 만들지 않는다(#855).
            const tripStopTimes = [];
            let seq = 1;
            for (const stopEntry of tripStops) {
              const stationId = daejeonResolver.resolveByIdOrCode(stopEntry.stn, null);
              if (!stationId) continue;

              tripStopTimes.push({
                tripId,
                stationId,
                lineId: daejeonLineId,
                stopSequence: seq++,
                arrivalSeconds: stopEntry.time,
                departureSeconds: stopEntry.time,
                pickupType: 0,
                dropOffType: 0,
                sourceId: "daejeon-train-timetable",
              });
            }

            if (tripStopTimes.length >= 2) {
              trips.push({
                id: tripId,
                routeId: "route-daejeon-line-1",
                serviceId,
                tripHeadsign: dirCfg.tripHeadsign,
                directionId: dirCfg.directionId,
                lineId: daejeonLineId,
                sourceId: "daejeon-train-timetable",
              });
              stopTimes.push(...tripStopTimes);
            } else {
              for (const stopEntry of tripStops) {
                regionalTimetableQuarantine.push({
                  sourceId: "daejeon-train-timetable",
                  serviceId,
                  sourceDayKey: dayType,
                  sourceDirection: dirCfg.drctType,
                  stationCode: stopEntry.stn,
                  stationId: daejeonResolver.resolveByIdOrCode(stopEntry.stn, null),
                  departureSeconds: stopEntry.time,
                  reason: "FEWER_THAN_TWO_SOURCE_STOPS",
                });
              }
            }
          }
        }
      }
    }
  }

  // =========================================================================
  // 4. Gwangju Metropolitan Rapid Transit (Line 1)
  // =========================================================================
  const gwangjuLineId = "line-e57a361e8892";
  // #913: 전국 후보는 광주 시간표를 KRIC 보관본으로 만든다(gwangjuTimetable 없음). 그때는 route·달력도 만들지 않는다.
  if (gwangjuTimetable) routes.push({
    id: "route-gwangju-line-1",
    agencyId: "gwangju-metropolitan-rapid-transit",
    routeShortName: "광주 1호선",
    routeLongName: "광주 도시철도 1호선",
    routeType: 1,
    routeColor: "#009088",
    routeTextColor: "#ffffff",
    lineId: gwangjuLineId,
  });

  if (gwangjuTimetable) calendars.push(
    { serviceId: "gwangju-weekday-2026", monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false, startDate: "20260101", endDate: "20261231" },
    { serviceId: "gwangju-holiday-2026", monday: false, tuesday: false, wednesday: false, thursday: false, friday: false, saturday: true, sunday: true, startDate: "20260101", endDate: "20261231" }
  );

  const gwangjuResolver = makeStationResolver(gwangjuLineId, gwangjuAccessibility?.rows);
  if (gwangjuTimetable?.rows) {
    const gwangjuDayMap = {
      WEEK: "gwangju-weekday-2026",
      DAYOFF: "gwangju-holiday-2026",
    };

    const gwangjuDirs = [
      {
        direction: "pd",
        directionId: 1,
        tripHeadsign: "평동",
        stnOrder: ["100", ...Array.from({ length: 19 }, (_, i) => String(101 + i))],
      },
      {
        direction: "st",
        directionId: 0,
        tripHeadsign: "소태",
        stnOrder: Array.from({ length: 19 }, (_, i) => String(119 - i)),
      },
    ];

    for (const [dayCode, serviceId] of Object.entries(gwangjuDayMap)) {
      for (const dirCfg of gwangjuDirs) {
        const map = new Map();
        for (const s of dirCfg.stnOrder) {
          const matchingRows = gwangjuTimetable.rows.filter(
            (r) => r.dayCode === dayCode && r.direction === dirCfg.direction && r.stationCode === s
          );
          const times = matchingRows.map((r) => {
            const hh = parseInt(r.time.slice(0, 2), 10);
            const mm = parseInt(r.time.slice(2, 4), 10);
            return hh * 3600 + mm * 60;
          }).sort((a, b) => a - b);
          map.set(s, times);
        }

        const used = new Map();
        for (const s of dirCfg.stnOrder) used.set(s, new Set());

        for (let i = 0; i < dirCfg.stnOrder.length - 1; i++) {
          const stn = dirCfg.stnOrder[i];
          const departures = map.get(stn) ?? [];
          for (let dIdx = 0; dIdx < departures.length; dIdx++) {
            if (used.get(stn).has(dIdx)) continue;
            used.get(stn).add(dIdx);
            const startSec = departures[dIdx];
            const tripId = `trip-gwangju-${dayCode}-${dirCfg.direction}-s${stn}-${startSec}`;
            const tripStops = [{ stn, time: startSec }];
            let curTime = startSec;

            for (let j = i + 1; j < dirCfg.stnOrder.length - 1; j++) {
              const nextStn = dirCfg.stnOrder[j];
              const nextDeps = map.get(nextStn) ?? [];
              let matchedIdx = -1;
              for (let k = 0; k < nextDeps.length; k++) {
                if (!used.get(nextStn).has(k) && nextDeps[k] >= curTime + 50 && nextDeps[k] <= curTime + 300) {
                  matchedIdx = k;
                  break;
                }
              }
              if (matchedIdx !== -1) {
                used.get(nextStn).add(matchedIdx);
                curTime = nextDeps[matchedIdx];
                tripStops.push({ stn: nextStn, time: curTime });
              } else {
                break;
              }
            }

            // 원천은 역별 시각 하나만 준다(종착역 행 없음). 정차 시각 하나는 도착 = 출발 = 원천 값이고,
            // 원천에 없는 종착역 도착은 만들지 않는다(#855).
            const tripStopTimes = [];
            let seq = 1;
            for (const stopEntry of tripStops) {
              const stationId = gwangjuResolver.resolveByIdOrCode(stopEntry.stn, null);
              if (!stationId) continue;

              tripStopTimes.push({
                tripId,
                stationId,
                lineId: gwangjuLineId,
                stopSequence: seq++,
                arrivalSeconds: stopEntry.time,
                departureSeconds: stopEntry.time,
                pickupType: 0,
                dropOffType: 0,
                sourceId: "gwangju-transportation-cyberstation-timetable",
              });
            }

            if (tripStopTimes.length >= 2) {
              trips.push({
                id: tripId,
                routeId: "route-gwangju-line-1",
                serviceId,
                tripHeadsign: dirCfg.tripHeadsign,
                directionId: dirCfg.directionId,
                lineId: gwangjuLineId,
                sourceId: "gwangju-transportation-cyberstation-timetable",
              });
              stopTimes.push(...tripStopTimes);
            } else {
              for (const stopEntry of tripStops) {
                regionalTimetableQuarantine.push({
                  sourceId: "gwangju-transportation-cyberstation-timetable",
                  serviceId,
                  sourceDayKey: dayCode,
                  sourceDirection: dirCfg.direction,
                  stationCode: stopEntry.stn,
                  stationId: gwangjuResolver.resolveByIdOrCode(stopEntry.stn, null),
                  departureSeconds: stopEntry.time,
                  reason: "FEWER_THAN_TWO_SOURCE_STOPS",
                });
              }
            }
          }
        }
      }
    }
  }

  return {
    transitRoutes: routes,
    transitTrips: trips,
    transitStopTimes: stopTimes,
    serviceCalendars: calendars,
    serviceCalendarDates: calendarDates,
    regionalTimetableQuarantine,
  };
}
