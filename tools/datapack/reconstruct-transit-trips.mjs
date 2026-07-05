// Provider-중립 trip 재구성 코어.
//
// 입력은 특정 provider(KRIC/TAGO) 응답이 아니라 정규화된 "중간 행" 계약이다:
//   { stationId, lineId, trnNo, dayCd, arrivalSeconds, departureSeconds, servicePattern? }
// provider 응답 → 중간 행 normalizer는 라이브 스키마가 확정된 뒤 별도 얇은 층으로 붙인다
// (최악의 경우 코레일 구간이 TAGO 하이브리드가 되어도 이 코어와 검증은 그대로 재사용된다).
//
// 재구성은 (trnNo, dayCd) group-by로 결정적이다(휴리스틱 매칭 아님). 각 group이 한 trip이며,
// 정차는 시각순으로 정렬되고 lineSequence가 방향당 단조(line-wide)임을 강제한다 — 이것이 기존
// blocker(line_wide_trip_stop_sequence_validation_required)가 요구하는 검증이다.

const DEFAULT_SERVICE_PATTERN = "LOCAL";

export function reconstructTransitTrips(rows, context) {
  const lineSequenceByStationLine = asLookup(context?.lineSequenceByStationLine, "lineSequenceByStationLine");
  const routeIdByLineDirection = asLookup(context?.routeIdByLineDirection, "routeIdByLineDirection");
  const serviceIdByDayCd = asLookup(context?.serviceIdByDayCd, "serviceIdByDayCd");

  const groups = new Map();
  for (const row of rows ?? []) {
    requireRow(row);
    // lineId를 키에 포함 — 노선 간 동일 trnNo+dayCd 충돌로 다른 노선 정차가 한 trip으로 병합되는 것을 막는다.
    const key = `${row.lineId}|${row.trnNo}|${row.dayCd}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(row);
  }

  const transitTrips = [];
  const transitStopTimes = [];

  for (const key of [...groups.keys()].sort((left, right) => left.localeCompare(right))) {
    const groupRows = groups.get(key);
    const ordered = [...groupRows]
      .map((row) => ({ ...row, lineSequence: resolveLineSequence(lineSequenceByStationLine, row) }))
      .sort(
        (left, right) =>
          left.departureSeconds - right.departureSeconds ||
          left.arrivalSeconds - right.arrivalSeconds ||
          left.lineSequence - right.lineSequence,
      );

    if (ordered.length < 2) {
      throw new Error(`reconstruct: trip must have at least 2 stops: ${key}`);
    }

    const directionId = validateLineWideOrderAndDirection(ordered, key);
    const lineId = ordered[0].lineId;
    const { trnNo, dayCd } = groupRows[0];
    const routeId = requireMapping(routeIdByLineDirection, `${lineId}|${directionId}`, "route");
    const serviceId = requireMapping(serviceIdByDayCd, dayCd, "serviceId");
    const servicePattern = resolveGroupServicePattern(groupRows, key);
    const tripId = `${routeId}-${trnNo}-${dayCd}`;

    transitTrips.push({
      id: tripId,
      routeId,
      serviceId,
      tripHeadsign: ordered.at(-1).stationId,
      directionId,
      servicePattern,
    });
    ordered.forEach((row, index) => {
      transitStopTimes.push({
        tripId,
        stopSequence: index + 1,
        stationId: row.stationId,
        lineId: row.lineId,
        arrivalSeconds: row.arrivalSeconds,
        departureSeconds: row.departureSeconds,
      });
    });
  }

  return { transitTrips, transitStopTimes };
}

// 시각순으로 정렬된 정차들이 lineSequence 기준 방향당 단조인지 강제하고 방향을 도출한다.
// (zigzag/loop-wrap 같은 비단조 패턴은 거부 — 기존 line-wide 검증과 동일한 계약.)
function validateLineWideOrderAndDirection(ordered, key) {
  let direction = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    const delta = ordered[index].lineSequence - ordered[index - 1].lineSequence;
    if (delta === 0) {
      throw new Error(`reconstruct: lineSequence must change between stops: ${key}`);
    }
    const step = Math.sign(delta);
    if (direction === 0) {
      direction = step;
    } else if (step !== direction) {
      throw new Error(`reconstruct: stop order must follow station lineSequence (line-wide): ${key}`);
    }
  }
  return direction > 0 ? "up" : "down";
}

// 한 trip(그룹)의 servicePattern은 입력 순서가 아니라 그룹 값으로 결정한다. 값이 섞여 있으면
// 데이터 오류이므로 거부하고, 없으면 LOCAL로 본다(결정적).
function resolveGroupServicePattern(groupRows, key) {
  const distinct = [...new Set(groupRows.map((row) => row.servicePattern).filter((value) => value != null && value !== ""))];
  if (distinct.length > 1) {
    throw new Error(
      `reconstruct: inconsistent servicePattern within trip ${key}: ${[...distinct].sort((left, right) => left.localeCompare(right)).join(", ")}`,
    );
  }
  return distinct[0] ?? DEFAULT_SERVICE_PATTERN;
}

function resolveLineSequence(lookup, row) {
  const value = lookup[`${row.stationId}|${row.lineId}`];
  if (!Number.isInteger(value)) {
    throw new TypeError(`reconstruct: unknown lineSequence for ${row.stationId}|${row.lineId}`);
  }
  return value;
}

function requireMapping(lookup, key, label) {
  const value = lookup[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`reconstruct: no ${label} mapping for ${key}`);
  }
  return value;
}

function requireRow(row) {
  for (const field of ["stationId", "lineId", "trnNo", "dayCd"]) {
    if (typeof row?.[field] !== "string" || row[field].length === 0) {
      throw new Error(`reconstruct: row missing field ${field}`);
    }
  }
  for (const field of ["arrivalSeconds", "departureSeconds"]) {
    if (!Number.isInteger(row[field]) || row[field] < 0) {
      throw new Error(`reconstruct: row ${field} must be a non-negative integer`);
    }
  }
  if (row.arrivalSeconds > row.departureSeconds) {
    throw new Error(`reconstruct: arrivalSeconds must be <= departureSeconds: ${row.trnNo}|${row.stationId}`);
  }
}

function asLookup(value, label) {
  if (value instanceof Map) {
    return Object.fromEntries(value);
  }
  if (value && typeof value === "object") {
    return value;
  }
  throw new Error(`reconstruct: context.${label} is required`);
}
