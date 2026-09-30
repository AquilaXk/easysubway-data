import { readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_POSITIONS_PATH = path.resolve(
  import.meta.dirname,
  "sources/seoul-metro-route-map-positions-20260724.json",
);

function numeric(value) {
  if (value == null) return "";
  const str = String(value).trim();
  const digits = str.replace(/[^\d]/g, "");
  return digits.replace(/^0+(?=\d)/, "");
}

export function parseTimeSlotMinutes(header) {
  const match = /^(\d{1,2})시(\d{2})분$/.exec(String(header ?? "").trim());
  if (!match) {
    throw new Error(`invalid time slot header: ${header}`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 24 || minutes < 0 || minutes >= 60) {
    throw new Error(`time slot out of range: ${header}`);
  }
  // Operational day minutes (post-midnight 00:xx -> 24:xx)
  const operationalHours = hours < 4 ? hours + 24 : hours;
  return operationalHours * 60 + minutes;
}

export function parsePermille(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const str = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(str)) return null;
  const num = Number(str);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num * 10);
}

export function normalizeDirection(dirStr) {
  switch (String(dirStr ?? "").trim()) {
    case "상선":
      return "UP";
    case "하선":
      return "DOWN";
    case "내선":
      return "INNER";
    case "외선":
      return "OUTER";
    default:
      return null;
  }
}

export function normalizeDayType(dayStr) {
  switch (String(dayStr ?? "").trim()) {
    case "평일":
      return "WEEKDAY";
    case "토요일":
      return "SATURDAY";
    case "일요일":
      return "SUNDAY";
    default:
      return null;
  }
}

export function buildStationMapping(positions) {
  const mapping = new Map();
  for (const pos of positions ?? []) {
    const lineNum = numeric(pos.line ?? pos.lineId);
    const stationCode = numeric(pos.stationCode);
    if (!lineNum || !stationCode) continue;
    const key = `${lineNum}:${stationCode}`;
    mapping.set(key, {
      stationId: pos.stationId,
      lineId: pos.lineId,
      stationName: pos.stationName ?? "",
      line: lineNum,
      stationCode,
    });
  }
  return mapping;
}

export function normalizeSeoulMetroCongestion({
  snapshot,
  positions,
  positionsPath = DEFAULT_POSITIONS_PATH,
} = {}) {
  if (!snapshot || !Array.isArray(snapshot.rows)) {
    throw new Error("snapshot with rows array is required");
  }

  let stationMapping;
  if (positions) {
    stationMapping = buildStationMapping(positions);
  } else {
    // Synchronously require or expect positions to be provided
    throw new Error("positions array is required for normalization");
  }

  const snapshotId = snapshot.snapshotId ?? path.basename(snapshot.datasetLabel ?? "seoul-metro-congestion");
  const sources = [
    {
      source_snapshot_id: snapshotId,
      dataset_label: snapshot.datasetLabel ?? "",
      captured_at: snapshot.capturedAt ?? new Date().toISOString(),
      attribution: "서울교통공사 (공공데이터포털)",
    },
  ];

  const stats = [];
  const seenKeys = new Set();
  const unmappedStations = [];
  let excludedDirectionCount = 0;
  let excludedDayTypeCount = 0;
  let invalidValueCount = 0;
  let loadedCellCount = 0;

  for (const row of snapshot.rows) {
    const direction = normalizeDirection(row["상하구분"]);
    if (!direction) {
      excludedDirectionCount += 1;
      continue;
    }

    const dayType = normalizeDayType(row["구분"]);
    if (!dayType) {
      excludedDayTypeCount += 1;
      continue;
    }

    const lineNum = numeric(row["호선"]);
    const stationCode = numeric(row["역번호"]);
    const mappingKey = `${lineNum}:${stationCode}`;
    const stationInfo = stationMapping.get(mappingKey);
    if (!stationInfo) {
      unmappedStations.push({
        line: lineNum,
        stationCode,
        stationName: row["역명"] ?? "",
        rawLine: row["호선"] ?? "",
      });
      continue;
    }

    // Identify all time slot headers in row
    const slotHeaders = Object.keys(row).filter((key) => /^(\d{1,2})시(\d{2})분$/.test(key));
    slotHeaders.sort((a, b) => parseTimeSlotMinutes(a) - parseTimeSlotMinutes(b));

    for (const header of slotHeaders) {
      const slotStartMinute = parseTimeSlotMinutes(header);
      const permille = parsePermille(row[header]);
      if (permille == null) {
        invalidValueCount += 1;
        continue;
      }

      const compositeKey = `${stationInfo.stationId}:${stationInfo.lineId}:${direction}:${dayType}:${slotStartMinute}`;
      if (seenKeys.has(compositeKey)) {
        throw new Error(`duplicate key for station_congestion_stats: ${compositeKey}`);
      }
      seenKeys.add(compositeKey);

      stats.push({
        station_id: stationInfo.stationId,
        line_id: stationInfo.lineId,
        direction,
        day_type: dayType,
        slot_start_minute: slotStartMinute,
        congestion_permille: permille,
        source_snapshot_id: snapshotId,
      });
      loadedCellCount += 1;
    }
  }

  const distinctStations = new Set(stats.map((s) => s.station_id));
  const distinctLines = new Set(stats.map((s) => s.line_id));

  // Distinct unmapped station codes
  const uniqueUnmappedMap = new Map();
  for (const u of unmappedStations) {
    const key = `${u.line}:${u.stationCode}`;
    if (!uniqueUnmappedMap.has(key)) {
      uniqueUnmappedMap.set(key, u);
    }
  }
  const uniqueUnmappedList = [...uniqueUnmappedMap.values()];

  const report = {
    rawRowCount: snapshot.rows.length,
    loadedCellCount,
    distinctStationCount: distinctStations.size,
    distinctLineCount: distinctLines.size,
    excludedDirectionCount,
    excludedDayTypeCount,
    invalidValueCount,
    unmappedRowFailureCount: unmappedStations.length,
    unmappedStationCount: uniqueUnmappedList.length,
    unmappedStations: uniqueUnmappedList,
  };

  return { stats, sources, report };
}

export function buildCongestionCoverageReport(stats, snapshot, report) {
  const lineStats = new Map();
  for (const item of stats) {
    const currentMax = lineStats.get(item.line_id) ?? 0;
    if (item.congestion_permille > currentMax) {
      lineStats.set(item.line_id, item.congestion_permille);
    }
  }

  const linesSummary = [...lineStats.entries()]
    .map(([lineId, maxPermille]) => `- \`${lineId}\`: 최대 ${(maxPermille / 10).toFixed(1)}% (${maxPermille}‰)`)
    .join("\n");

  const unmappedList = report.unmappedStations
    .map((u) => `- [${u.rawLine || `${u.line}호선`}] ${u.stationName} (역번호: ${u.stationCode})`)
    .join("\n");

  return `### 서울교통공사 지하철 혼잡도 통계 커버리지 리포트

- **원천 데이터셋**: \`${snapshot?.datasetLabel ?? "서울교통공사_지하철혼잡도정보"}\`
- **원천 행 수**: ${report.rawRowCount.toLocaleString()}행
- **적재 행 수(칸 단위)**: ${report.loadedCellCount.toLocaleString()}칸 (30분 슬롯 통계)
- **적재 역 수**: ${report.distinctStationCount}개 역
- **적재 노선 수**: ${report.distinctLineCount}개 노선
- **방향·요일 제외 수**: 방향 ${report.excludedDirectionCount}건, 요일 ${report.excludedDayTypeCount}건
- **값 형식 실패 칸 수**: ${report.invalidValueCount}건
- **매핑 실패 역 수**: ${report.unmappedStationCount}개 역 (관련 행 ${report.unmappedRowFailureCount}행)
${unmappedList.length > 0 ? `${unmappedList}\n` : ""}
#### 노선별 최대 혼잡도
${linesSummary}
`;
}
