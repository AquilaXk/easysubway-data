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

  function cleanName(n) {
    return String(n ?? "").replace(/\(.*?\)/g, "").replace(/\d+$/, "").replace(/[·•ㆍ]/g, ".").trim();
  }

  function makeStationResolver(lineId, accessibilityRows) {
    const codeToId = new Map();
    const nameToId = new Map();
    const candidates = finalPack.stationLines.filter((sl) => sl.lineId === lineId);

    for (const sl of candidates) {
      const st = finalPack.stations.find((s) => s.id === sl.stationId);
      if (st) {
        nameToId.set(cleanName(st.nameKo), st.id);
        nameToId.set(st.nameKo, st.id);
      }
    }

    for (const row of accessibilityRows ?? []) {
      if (row.lineId === lineId || !row.lineId) {
        const stationId = nameToId.get(cleanName(row.stationName)) ?? nameToId.get(row.stationName);
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
    { serviceId: "busan-weekday-2026", monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, startDate: "20260101", endDate: "20261231" },
    { serviceId: "busan-saturday-2026", monday: 0, tuesday: 0, wednesday: 0, thursday: 0, friday: 0, saturday: 1, sunday: 0, startDate: "20260101", endDate: "20261231" },
    { serviceId: "busan-holiday-2026", monday: 0, tuesday: 0, wednesday: 0, thursday: 0, friday: 0, saturday: 0, sunday: 1, startDate: "20260101", endDate: "20261231" }
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
          stopId: stationId,
          stopSequence: seq++,
          arrivalTimeSeconds: r.seconds,
          departureTimeSeconds: r.seconds,
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
      { serviceId: `daegu-line${cfg.num}-weekday-2026`, monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, startDate: "20260101", endDate: "20261231" },
      { serviceId: `daegu-line${cfg.num}-saturday-2026`, monday: 0, tuesday: 0, wednesday: 0, thursday: 0, friday: 0, saturday: 1, sunday: 0, startDate: "20260101", endDate: "20261231" },
      { serviceId: `daegu-line${cfg.num}-holiday-2026`, monday: 0, tuesday: 0, wednesday: 0, thursday: 0, friday: 0, saturday: 0, sunday: 1, startDate: "20260101", endDate: "20261231" }
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
          stopId: stationId,
          stopSequence: seq++,
          arrivalTimeSeconds: stop.a,
          departureTimeSeconds: stop.d,
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
    { serviceId: "daejeon-weekday-2026", monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, startDate: "20260101", endDate: "20261231" },
    { serviceId: "daejeon-holiday-2026", monday: 0, tuesday: 0, wednesday: 0, thursday: 0, friday: 0, saturday: 1, sunday: 1, startDate: "20260101", endDate: "20261231" }
  );

  const daejeonResolver = makeStationResolver(daejeonLineId, daejeonAccessibility?.rows);
  if (daejeonTimetable?.rows) {
    // Daejeon rows have { dayType, drctType, stNum, tmList, tmZone }
    // Group departures at origin stations: 101 for drctType 1, 122 for drctType 2
    const originRows = daejeonTimetable.rows.filter(
      (r) => (r.drctType === "1" && r.stNum === "101") || (r.drctType === "2" && r.stNum === "122")
    );

    // Build ordered station list for direction 1 (101->122) and direction 2 (122->101)
    const stationsDir1 = Array.from({ length: 22 }, (_, i) => String(101 + i));
    const stationsDir2 = [...stationsDir1].reverse();

    for (const orig of originRows) {
      const minutes = String(orig.tmList ?? "").trim().split(/\s+/).filter(Boolean);
      const hour = parseInt(orig.tmZone, 10);
      const serviceId = orig.dayType === "0" ? "daejeon-weekday-2026" : "daejeon-holiday-2026";
      const stationSeq = orig.drctType === "1" ? stationsDir1 : stationsDir2;

      for (const m of minutes) {
        const startSec = hour * 3600 + parseInt(m, 10) * 60;
        const tripId = `trip-daejeon-d${orig.dayType}-dir${orig.drctType}-${startSec}`;

        const tripStopTimes = [];
        let curTime = startSec;
        let seq = 1;

        for (const stNum of stationSeq) {
          const stationId = daejeonResolver.resolveByIdOrCode(stNum, null);
          if (stationId) {
            tripStopTimes.push({
              tripId,
              stopId: stationId,
              stopSequence: seq++,
              arrivalTimeSeconds: curTime,
              departureTimeSeconds: curTime + 20,
              pickupType: 0,
              dropOffType: 0,
              sourceId: "daejeon-train-timetable",
            });
          }
          curTime += 120; // 2 min inter-station travel time
        }

        if (tripStopTimes.length >= 2) {
          trips.push({
            id: tripId,
            routeId: "route-daejeon-line-1",
            serviceId,
            tripHeadsign: orig.drctType === "1" ? "반석" : "판암",
            directionId: orig.drctType === "1" ? 0 : 1,
            lineId: daejeonLineId,
            sourceId: "daejeon-train-timetable",
          });
          stopTimes.push(...tripStopTimes);
        }
      }
    }
  }

  // =========================================================================
  // 4. Gwangju Metropolitan Rapid Transit (Line 1)
  // =========================================================================
  const gwangjuLineId = "line-e57a361e8892";
  routes.push({
    id: "route-gwangju-line-1",
    agencyId: "gwangju-metropolitan-rapid-transit",
    routeShortName: "광주 1호선",
    routeLongName: "광주 도시철도 1호선",
    routeType: 1,
    routeColor: "#009088",
    routeTextColor: "#ffffff",
    lineId: gwangjuLineId,
  });

  calendars.push(
    { serviceId: "gwangju-weekday-2026", monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, startDate: "20260101", endDate: "20261231" },
    { serviceId: "gwangju-holiday-2026", monday: 0, tuesday: 0, wednesday: 0, thursday: 0, friday: 0, saturday: 1, sunday: 1, startDate: "20260101", endDate: "20261231" }
  );

  const gwangjuResolver = makeStationResolver(gwangjuLineId, gwangjuAccessibility?.rows);
  if (gwangjuTimetable?.rows) {
    // Gwangju rows: { stationCode, dayCode, direction: 'st' | 'pd', endCode, time: 'HHMM' }
    // Origin for 'st' is 119 (Pyeongdong), origin for 'pd' is 101/102 (Nokdong/Sotae)
    const origins = gwangjuTimetable.rows.filter(
      (r) => (r.direction === "st" && r.stationCode === "119") || (r.direction === "pd" && (r.stationCode === "101" || r.stationCode === "102"))
    );

    const gwangjuStnsPd = Array.from({ length: 19 }, (_, i) => String(101 + i));
    const gwangjuStnsSt = [...gwangjuStnsPd].reverse();

    for (const orig of origins) {
      const serviceId = orig.dayCode === "WEEKDAY" ? "gwangju-weekday-2026" : "gwangju-holiday-2026";
      const hh = parseInt(orig.time.slice(0, 2), 10);
      const mm = parseInt(orig.time.slice(2, 4), 10);
      const startSec = hh * 3600 + mm * 60;
      const tripId = `trip-gwangju-${orig.dayCode}-${orig.direction}-${startSec}`;

      const stnSeq = orig.direction === "pd" ? gwangjuStnsPd : gwangjuStnsSt;
      const tripStopTimes = [];
      let curTime = startSec;
      let seq = 1;

      for (const stCode of stnSeq) {
        const stationId = gwangjuResolver.resolveByIdOrCode(stCode, null);
        if (stationId) {
          tripStopTimes.push({
            tripId,
            stopId: stationId,
            stopSequence: seq++,
            arrivalTimeSeconds: curTime,
            departureTimeSeconds: curTime + 20,
            pickupType: 0,
            dropOffType: 0,
            sourceId: "gwangju-transportation-cyberstation-timetable",
          });
        }
        curTime += 120;
      }

      if (tripStopTimes.length >= 2) {
        trips.push({
          id: tripId,
          routeId: "route-gwangju-line-1",
          serviceId,
          tripHeadsign: orig.direction === "pd" ? "평동" : "소태",
          directionId: orig.direction === "pd" ? 1 : 0,
          lineId: gwangjuLineId,
          sourceId: "gwangju-transportation-cyberstation-timetable",
        });
        stopTimes.push(...tripStopTimes);
      }
    }
  }

  return {
    transitRoutes: routes,
    transitTrips: trips,
    transitStopTimes: stopTimes,
    serviceCalendars: calendars,
    serviceCalendarDates: calendarDates,
  };
}
