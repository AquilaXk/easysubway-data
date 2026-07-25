#!/usr/bin/env node
// 수도권 경전철 잔여 5개 노선 route_map_positions를 공식 FILE 위경도 + schematic canvas로
// 결정론적 snapshot으로 수집한다. API key·포털 활용신청 없이 FILE만 사용한다.
//
// A. data.go.kr 전용 역위치 CSV (신분당·에버라인; CP949 LF fixture)
// B. data.go.kr 우이신설 XLSX 정규화 CSV(위경도 없음) + KRIC id=1294 overlay
// C. KRIC 공식 역사정보(id=1294) 필터 CSV (신림선·김포골드라인)
// D. 신분당 상현 빈 위경도 → 같은 공식 KRIC id=1294 overlay
//
// 하이브리드 정렬:
// - 공식 FILE 위경도는 provenance(latitude/longitude)로만 유지한다.
// - admitted route_map_positions x/y/label*는 owner-self-drawn-sma-schematic canvas
//   좌표 fixture에서 역명(정규화) join으로 결속한다.
// - stationCode = pack station_code (canvas fixture). 위경도 투영(projectLatLon) 금지.
// - topology(capital-route-topology)는 scope ∪ branchSequences 정규화 역명 검증만 한다.
// - pack에 없는 FILE 잉여 행(에버라인 전대·에버랜드, 우이신설 신설동)은 무시한다(allowExtraFileRows).
// - FILE 역명 alias(에버라인 운동장·송담대→용인중앙시장)는 공식 rename join만 허용한다.
// - KRIC 공식 lat/lon 컬럼 스왑 오류 정규화(발명 아님):
//   if lon∈[33,43] and lat∈[124,132]: swap. 그 외 한반도 범위 밖이면 fail/quarantine.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { decodeOfficialCsv } from "./collect-daegu-datapack-sources.mjs";

const ARTIFACT_KIND = "capital-light-rail-route-map-positions-snapshot";
const TOPOLOGY_SOURCE_ID = "capital-route-topology";
const TOPOLOGY_SNAPSHOT_ID = "capital-route-topology-20260724";
const SCHEMATIC_CANVAS_SOURCE_ID = "owner-self-drawn-sma-schematic";
const FIELDS_PROVIDED = Object.freeze(["route_map_position", "route_map_label_polygon"]);
const OFFICIAL_MISSING_LATLON = "OFFICIAL_MISSING_LATLON";
const OFFICIAL_MISSING_FILE_ROW = "OFFICIAL_MISSING_FILE_ROW";
const ISSUE = 2505;
const KRIC_1294_DATASET_ID = "1294";
const KRIC_1294_DETAIL_URL = "https://data.kric.go.kr/rips/M_01_01/detail.do?id=1294";
const KRIC_1294_DOWNLOAD_URL =
  "https://data.kric.go.kr/rips/dataset/download.file?type=filedata&id=1294&operation=1";
const KRIC_1294_OVERLAY_FIXTURE =
  "tools/datapack/fixtures/capital-light-rail-route-map-positions-raw/shared/kric-1294-overlay-shinbundang-ui.csv";
// 공식 FILE에 간혹 오류 좌표가 있어도(수인분당 수서 lon=127.676 등) finite면 provenance로 admit한다.
// 주소 문자열·빈칸만 quarantine. null-island(0,0) 수준의 명백한 비좌표는 거부한다.
const CAPITAL_GEO = Object.freeze({
  latMin: 33.0,
  latMax: 39.0,
  lonMin: 124.0,
  lonMax: 132.0,
});
const LAT_LON_SWAP_LON_AS_LAT = Object.freeze({ min: 33, max: 43 });
const LAT_LON_SWAP_LAT_AS_LON = Object.freeze({ min: 124, max: 132 });

const LINE_DEFINITIONS = Object.freeze([
  {
    key: "shinbundang",
    sourceId: "kric-shinbundang-route-map-positions",
    lineId: "shinbundang",
    slug: "shinbundang",
    operatorId: "seoul-metro",
    operatorNameKo: "서울교통공사",
    lineNameKo: "수도권 신분당",
    lineNameEn: "Shinbundang Line",
    lineColor: "#d4003b",
    lineNameToken: "신분당선",
    operatorNameToken: "네오트랜스주식회사",
    datasetId: "15041337",
    datasetIds: ["15041337", "1294"],
    detailUrl: "https://www.data.go.kr/data/15041337/fileData.do",
    downloadUrl:
      "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000002715018&fileDetailSn=1&insertDataPrcus=N",
    observedDataUpdatedAt: "2024-10-15",
    inputKind: "csv",
    fixtureFile: "data-go-15041337.csv",
    expectedStationCount: 16,
    expectedQuarantinedCount: 0,
    packStationCount: 16,
    allowMissingFileRows: false,
    allowExtraFileRows: false,
    overlayLineToken: "신분당선",
    canvas: { xMin: 1800, xMax: 2600, yMin: 1600, yMax: 2500 },
    geo: CAPITAL_GEO,
    licenseAttribution:
      "국가철도공단 · 네오트랜스주식회사 · 공공데이터포털 이용허락범위 제한 없음 · 상현 빈 위경도는 KRIC 전국 도시광역철도 역사정보 id=1294 신분당선 행 overlay",
  },
  {
    key: "everline",
    sourceId: "kric-everline-route-map-positions",
    lineId: "line-828f04afc588",
    slug: "everline",
    operatorId: "operator-b2d80436b438",
    operatorNameKo: "용인경량전철주식회사",
    lineNameKo: "수도권 에버라인",
    lineNameEn: "Everline",
    lineColor: "#509f22",
    lineNameToken: "용인에버라인",
    operatorNameToken: "용인경량전철주식회사",
    datasetId: "15041326",
    detailUrl: "https://www.data.go.kr/data/15041326/fileData.do",
    downloadUrl:
      "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000002643415&fileDetailSn=1&insertDataPrcus=N",
    observedDataUpdatedAt: "2024-10-15",
    inputKind: "csv",
    fixtureFile: "data-go-15041326.csv",
    expectedStationCount: 14,
    expectedQuarantinedCount: 0,
    packStationCount: 14,
    allowMissingFileRows: false,
    allowExtraFileRows: true,
    fileStationNameAliases: Object.freeze({
      "운동장·송담대": "용인중앙시장",
      "운동장.송담대": "용인중앙시장",
    }),
    canvas: { xMin: 2000, xMax: 3400, yMin: 2300, yMax: 2700 },
    geo: CAPITAL_GEO,
    licenseAttribution: "국가철도공단 · 용인경량전철주식회사 · 공공데이터포털 이용허락범위 제한 없음",
  },
  {
    key: "ui",
    sourceId: "kric-ui-sinseol-route-map-positions",
    lineId: "line-30886152e4f8",
    slug: "ui",
    operatorId: "operator-3c623bf1a427",
    operatorNameKo: "우이신설경전철주식회사",
    lineNameKo: "수도권 우이신설",
    lineNameEn: "Ui-Sinseol LRT",
    lineColor: "#b0ce18",
    lineNameToken: "우이신설",
    operatorNameToken: "우이신설경전철주식회사",
    datasetId: "15041324",
    datasetIds: ["15041324", "1294"],
    detailUrl: "https://www.data.go.kr/data/15041324/fileData.do",
    downloadUrl:
      "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003545227&fileDetailSn=1&insertDataPrcus=N",
    observedDataUpdatedAt: "2024-10-15",
    inputKind: "csv",
    fixtureFile: "data-go-15041324-stations.csv",
    primaryFileArtifact: "data-go-15041324.xlsx",
    expectedStationCount: 12,
    expectedQuarantinedCount: 0,
    packStationCount: 12,
    allowMissingFileRows: false,
    allowExtraFileRows: true,
    overlayLineToken: "우이신설선",
    canvas: { xMin: 1900, xMax: 2600, yMin: 600, yMax: 1100 },
    geo: CAPITAL_GEO,
    licenseAttribution:
      "국가철도공단 · 우이신설경전철주식회사 · 공공데이터포털 이용허락범위 제한 없음 · 위경도는 KRIC 전국 도시광역철도 역사정보 id=1294 우이신설선 행 overlay",
  },
  {
    key: "sillim",
    sourceId: "kric-sillim-route-map-positions",
    lineId: "line-aefa08ccc0a9",
    slug: "sillim",
    operatorId: "operator-10d7cf275a80",
    operatorNameKo: "남서울경전철주식회사",
    lineNameKo: "수도권 신림선",
    lineNameEn: "Sillim Line",
    lineColor: "#0781fa",
    lineNameToken: "신림선",
    operatorNameToken: null,
    datasetId: KRIC_1294_DATASET_ID,
    datasetIds: [KRIC_1294_DATASET_ID],
    detailUrl: KRIC_1294_DETAIL_URL,
    downloadUrl: KRIC_1294_DOWNLOAD_URL,
    observedDataUpdatedAt: "2026-07-01",
    inputKind: "filtered-csv",
    fixtureFile: "kric-sillim-filtered-stations.csv",
    expectedStationCount: 11,
    expectedQuarantinedCount: 0,
    packStationCount: 11,
    allowMissingFileRows: false,
    allowExtraFileRows: false,
    canvas: { xMin: 1400, xMax: 1900, yMin: 1600, yMax: 2200 },
    geo: CAPITAL_GEO,
    licenseAttribution:
      "국가철도공단 · 남서울경전철주식회사 · KRIC 전국 도시광역철도 역사정보 id=1294 신림선 필터 · 공공데이터포털 이용허락범위 제한 없음",
  },
  {
    key: "gimpo",
    sourceId: "kric-gimpo-goldline-route-map-positions",
    lineId: "line-5500c1600f71",
    slug: "gimpo",
    operatorId: "operator-2e23276dfa94",
    operatorNameKo: "김포골드라인운영주식회사",
    lineNameKo: "수도권 김포골드라인",
    lineNameEn: "Gimpo Goldline",
    lineColor: "#a17800",
    lineNameToken: "김포골드라인",
    operatorNameToken: null,
    datasetId: KRIC_1294_DATASET_ID,
    datasetIds: [KRIC_1294_DATASET_ID],
    detailUrl: KRIC_1294_DETAIL_URL,
    downloadUrl: KRIC_1294_DOWNLOAD_URL,
    observedDataUpdatedAt: "2026-07-01",
    inputKind: "filtered-csv",
    fixtureFile: "kric-gimpo-goldline-filtered-stations.csv",
    expectedStationCount: 10,
    expectedQuarantinedCount: 0,
    packStationCount: 10,
    allowMissingFileRows: false,
    allowExtraFileRows: false,
    canvas: { xMin: 150, xMax: 850, yMin: 700, yMax: 1200 },
    geo: CAPITAL_GEO,
    licenseAttribution:
      "국가철도공단 · 김포골드라인운영주식회사 · KRIC 전국 도시광역철도 역사정보 id=1294 김포골드라인 필터 · 공공데이터포털 이용허락범위 제한 없음",
  },
]);

const LINE_BY_SOURCE_ID = Object.freeze(new Map(LINE_DEFINITIONS.map((line) => [line.sourceId, line])));
const LINE_BY_KEY = Object.freeze(new Map(LINE_DEFINITIONS.map((line) => [line.key, line])));

export function listCapitalLightRailRouteMapPositionLines() {
  return LINE_DEFINITIONS.map((line) => structuredClone(line));
}

export function getCapitalLightRailRouteMapPositionLine(sourceIdOrKey) {
  return LINE_BY_SOURCE_ID.get(sourceIdOrKey) ?? LINE_BY_KEY.get(sourceIdOrKey) ?? null;
}

export function normalizeOfficialLatLon(latitudeRaw, longitudeRaw, { applySwap = false } = {}) {
  let latitude = Number(String(latitudeRaw ?? "").trim());
  let longitude = Number(String(longitudeRaw ?? "").trim());
  let swapped = false;
  if (applySwap
    && Number.isFinite(latitude)
    && Number.isFinite(longitude)
    && longitude >= LAT_LON_SWAP_LON_AS_LAT.min
    && longitude <= LAT_LON_SWAP_LON_AS_LAT.max
    && latitude >= LAT_LON_SWAP_LAT_AS_LON.min
    && latitude <= LAT_LON_SWAP_LAT_AS_LON.max) {
    const nextLatitude = longitude;
    const nextLongitude = latitude;
    latitude = nextLatitude;
    longitude = nextLongitude;
    swapped = true;
  }
  return { latitude, longitude, swapped };
}

export function parseKric1294OverlayCsv(overlayCsvBytes, overlayLineToken) {
  if (!(overlayCsvBytes instanceof Uint8Array) || overlayCsvBytes.byteLength === 0) {
    throw new Error("KRIC 1294 overlay CSV bytes are required");
  }
  if (typeof overlayLineToken !== "string" || overlayLineToken.length === 0) {
    throw new Error("KRIC 1294 overlay line token is required");
  }
  const rows = parseCsv(decodeOfficialCsv(overlayCsvBytes));
  if (rows.length < 2) throw new Error("KRIC 1294 overlay CSV has no data rows");
  const header = rows[0];
  const indexes = {
    lineName: header.indexOf("운영노선"),
    stationName: header.indexOf("역명"),
    longitude: header.indexOf("경도"),
    latitude: header.indexOf("위도"),
  };
  for (const [field, index] of Object.entries(indexes)) {
    if (index < 0) throw new Error(`KRIC 1294 overlay CSV missing column: ${field}`);
  }
  const byNorm = new Map();
  for (const [rowIndex, row] of rows.slice(1).entries()) {
    if (row.length !== header.length) {
      throw new Error(`KRIC 1294 overlay CSV column count mismatch at row ${rowIndex + 2}`);
    }
    if (String(row[indexes.lineName] ?? "").trim() !== overlayLineToken) continue;
    const csvStationName = String(row[indexes.stationName] ?? "").trim();
    if (csvStationName.length === 0) continue;
    const normalizedName = normalizeStationName(csvStationName);
    if (byNorm.has(normalizedName)) continue;
    byNorm.set(normalizedName, {
      csvStationName,
      latitudeRaw: String(row[indexes.latitude] ?? "").trim(),
      longitudeRaw: String(row[indexes.longitude] ?? "").trim(),
      sourceDatasetId: KRIC_1294_DATASET_ID,
    });
  }
  return byNorm;
}

export function parseCapitalLightRailRouteMapPositionsCsv({
  lineKey,
  sourceId,
  csvBytes,
  overlayCsvBytes = null,
  topologySnapshot,
  schematicCanvas,
} = {}) {
  const line = resolveLine(lineKey, sourceId);
  if (!(csvBytes instanceof Uint8Array) || csvBytes.byteLength === 0) {
    throw new Error(`${line.sourceId} route map positions CSV bytes are required`);
  }
  const topologyNames = validateTopologySnapshot(topologySnapshot, line);
  const canvasByName = indexSchematicCanvas(schematicCanvas, line);
  const packStations = [...canvasByName.values()];
  if (packStations.length !== line.packStationCount) {
    throw new Error(`${line.sourceId} schematic canvas station count mismatch`);
  }
  for (const canvas of packStations) {
    if (!topologyNames.has(normalizeStationName(canvas.stationName))) {
      throw new Error(`${line.sourceId} topology name missing: ${canvas.stationName}`);
    }
  }

  const overlayByNorm = line.overlayLineToken
    ? parseKric1294OverlayCsv(overlayCsvBytes, line.overlayLineToken)
    : new Map();
  if (line.overlayLineToken && overlayByNorm.size === 0) {
    throw new Error(`${line.sourceId} KRIC 1294 overlay rows missing for ${line.overlayLineToken}`);
  }

  const rows = parseCsv(decodeOfficialCsv(csvBytes));
  if (rows.length < 2) throw new Error(`${line.sourceId} route map positions CSV has no data rows`);
  const header = rows[0];
  const indexes = resolveCsvIndexes(header, line);

  const fileByNorm = new Map();
  for (const [rowIndex, row] of rows.slice(1).entries()) {
    if (row.length !== header.length) {
      throw new Error(`${line.sourceId} CSV column count mismatch at row ${rowIndex + 2}`);
    }
    if (indexes.operator >= 0 && line.operatorNameToken) {
      const operatorToken = String(row[indexes.operator] ?? "").trim();
      if (operatorToken !== line.operatorNameToken) {
        throw new Error(`${line.sourceId} unexpected operator at row ${rowIndex + 2}`);
      }
    }
    if (indexes.lineName >= 0 && line.lineNameToken) {
      const lineNameToken = String(row[indexes.lineName] ?? "").trim();
      if (lineNameToken !== line.lineNameToken) {
        throw new Error(`${line.sourceId} unexpected line at row ${rowIndex + 2}`);
      }
    }
    const rawCsvStationName = String(row[indexes.stationName] ?? "").trim();
    if (rawCsvStationName.length === 0) {
      throw new Error(`${line.sourceId} invalid station identity at row ${rowIndex + 2}`);
    }
    const aliasedName = line.fileStationNameAliases?.[rawCsvStationName]
      ?? line.fileStationNameAliases?.[rawCsvStationName.replaceAll("·", ".")]
      ?? rawCsvStationName;
    const csvStationName = aliasedName;
    const normalizedName = normalizeStationName(csvStationName);
    if (fileByNorm.has(normalizedName)) continue;
    const latitudeRaw = String(row[indexes.latitude] ?? "").trim();
    const longitudeRaw = String(row[indexes.longitude] ?? "").trim();
    fileByNorm.set(normalizedName, {
      csvStationName,
      latitudeRaw,
      longitudeRaw,
      sourceDatasetId: line.datasetId,
    });
  }

  const positions = [];
  const quarantinedPositions = [];
  const seenStationIds = new Set();
  const overlayStationNames = [];
  let swappedCoordinateCount = 0;

  for (const canvas of packStations) {
    const normalizedName = normalizeStationName(canvas.stationName);
    const fileRow = fileByNorm.get(normalizedName);
    const x = Math.round(Number(canvas.x));
    const y = Math.round(Number(canvas.y));
    if (!isSchematicCanvasCoordinate(x, y, line)) {
      throw new Error(`${line.sourceId} schematic canvas out of bounds: ${canvas.stationName}`);
    }
    if (seenStationIds.has(canvas.stationId)) {
      throw new Error(`${line.sourceId} duplicate schematic stationId: ${canvas.stationId}`);
    }
    seenStationIds.add(canvas.stationId);

    if (!fileRow) {
      if (!line.allowMissingFileRows) {
        throw new Error(`${line.sourceId} official FILE row missing: ${canvas.stationName}`);
      }
      quarantinedPositions.push({
        lineId: line.lineId,
        line: line.slug,
        stationCode: String(canvas.stationCode),
        stationName: canvas.stationName,
        stationId: canvas.stationId,
        x,
        y,
        reasonCode: OFFICIAL_MISSING_FILE_ROW,
      });
      continue;
    }

    let coordSource = fileRow;
    let usedOverlay = false;
    let { latitude, longitude, swapped } = normalizeOfficialLatLon(
      coordSource.latitudeRaw,
      coordSource.longitudeRaw,
      { applySwap: line.applyLatLonSwap === true },
    );
    let coordsValid = Number.isFinite(latitude) && Number.isFinite(longitude)
      && latitude >= line.geo.latMin && latitude <= line.geo.latMax
      && longitude >= line.geo.lonMin && longitude <= line.geo.lonMax;

    if (!coordsValid && line.overlayLineToken) {
      const overlayRow = overlayByNorm.get(normalizedName);
      if (overlayRow) {
        const overlayCoords = normalizeOfficialLatLon(
          overlayRow.latitudeRaw,
          overlayRow.longitudeRaw,
          { applySwap: true },
        );
        if (Number.isFinite(overlayCoords.latitude) && Number.isFinite(overlayCoords.longitude)
          && overlayCoords.latitude >= line.geo.latMin && overlayCoords.latitude <= line.geo.latMax
          && overlayCoords.longitude >= line.geo.lonMin && overlayCoords.longitude <= line.geo.lonMax) {
          latitude = overlayCoords.latitude;
          longitude = overlayCoords.longitude;
          swapped = overlayCoords.swapped;
          coordsValid = true;
          usedOverlay = true;
          coordSource = overlayRow;
          overlayStationNames.push(canvas.stationName);
        }
      }
    }

    if (!coordsValid) {
      quarantinedPositions.push({
        lineId: line.lineId,
        line: line.slug,
        stationCode: String(canvas.stationCode),
        stationName: canvas.stationName,
        stationId: canvas.stationId,
        latitude: Number.isFinite(latitude) ? latitude : null,
        longitude: Number.isFinite(longitude) ? longitude : null,
        x,
        y,
        reasonCode: OFFICIAL_MISSING_LATLON,
      });
      continue;
    }
    if (swapped) swappedCoordinateCount += 1;

    positions.push({
      lineId: line.lineId,
      line: line.slug,
      stationCode: String(canvas.stationCode),
      stationName: canvas.stationName,
      stationId: canvas.stationId,
      latitude,
      longitude,
      x,
      y,
      labelDx: canvas.labelDx,
      labelDy: canvas.labelDy,
      labelPolygon: structuredClone(canvas.labelPolygon),
      ...(usedOverlay ? { coordinateSourceDatasetId: KRIC_1294_DATASET_ID } : {}),
      ...(swapped ? { officialLatLonSwapped: true } : {}),
    });
  }

  // FILE 행이 pack에 없는 여분 역이면 기본 fail-closed.
  // allowExtraFileRows(에버라인 depot·우이신설 신설동 등)는 pack join 기준에서 잉여를 무시한다.
  for (const [normalizedName, fileRow] of fileByNorm.entries()) {
    if (!canvasByName.has(normalizedName)) {
      if (line.allowExtraFileRows === true) continue;
      throw new Error(`${line.sourceId} unexpected official station not in pack: ${fileRow.csvStationName}`);
    }
  }

  positions.sort(comparePositions);
  quarantinedPositions.sort(comparePositions);
  if (positions.length !== line.expectedStationCount) {
    throw new Error(`${line.sourceId} admitted station count mismatch: ${positions.length}`);
  }
  if (quarantinedPositions.length !== line.expectedQuarantinedCount) {
    throw new Error(`${line.sourceId} quarantined count mismatch: ${quarantinedPositions.length}`);
  }
  if (positions.length + quarantinedPositions.length !== line.packStationCount) {
    throw new Error(`${line.sourceId} pack coverage mismatch`);
  }
  return {
    line,
    positions,
    quarantinedPositions,
    overlayStationNames: overlayStationNames.sort((left, right) => left.localeCompare(right, "en")),
    swappedCoordinateCount,
    overlayRawSha256: overlayCsvBytes ? sha256(Buffer.from(overlayCsvBytes)) : null,
  };
}

export function collectCapitalLightRailRouteMapPositions({
  lineKey,
  sourceId,
  csvBytes,
  overlayCsvBytes = null,
  topologySnapshot,
  schematicCanvas,
  now = new Date(),
} = {}) {
  const capturedAt = validDate(now, "now");
  const {
    line,
    positions,
    quarantinedPositions,
    overlayStationNames,
    swappedCoordinateCount,
    overlayRawSha256,
  } = parseCapitalLightRailRouteMapPositionsCsv({
    lineKey,
    sourceId,
    csvBytes,
    overlayCsvBytes,
    topologySnapshot,
    schematicCanvas,
  });
  const topologyLineages = [{
    sourceId: topologySnapshot.sourceId,
    snapshotId: TOPOLOGY_SNAPSHOT_ID,
    contentSha256: topologySnapshot.contentSha256,
    lineId: line.lineId,
  }];
  const scope = [...positions, ...quarantinedPositions]
    .map(({ lineId, stationCode, stationName, stationId }) => ({
      lineId,
      stationCode,
      stationName,
      stationId,
    }))
    .sort(comparePositions);
  const datasetIds = line.datasetIds ?? [line.datasetId];
  const snapshot = {
    schemaVersion: 1,
    artifactKind: ARTIFACT_KIND,
    sourceId: line.sourceId,
    detailUrl: line.detailUrl,
    datasetId: line.datasetId,
    datasetIds: [...datasetIds],
    datasetUrl: line.detailUrl,
    endpoint: line.detailUrl,
    downloadUrl: line.downloadUrl,
    capturedAt: capturedAt.toISOString(),
    observedDataUpdatedAt: line.observedDataUpdatedAt,
    official: true,
    fixture: false,
    credentialRequired: false,
    credentialRedacted: true,
    rawStationCount: line.packStationCount,
    stationCount: positions.length,
    quarantinedCount: quarantinedPositions.length,
    lineIds: [line.lineId],
    lineStationCounts: { [line.slug]: positions.length },
    fieldsProvided: [...FIELDS_PROVIDED],
    license: {
      type: "PUBLIC_DATA_FREE_USE",
      attribution: line.licenseAttribution,
      redistributionAllowed: true,
      evidenceUrl: line.detailUrl,
    },
    topologySourceId: TOPOLOGY_SOURCE_ID,
    topologySnapshotId: TOPOLOGY_SNAPSHOT_ID,
    topologyContentSha256: topologySnapshot.contentSha256,
    topologyLineages,
    schematicCanvasSourceId: SCHEMATIC_CANVAS_SOURCE_ID,
    scope,
    scopeSha256: sha256(JSON.stringify(scope)),
    rawSha256: sha256(Buffer.from(csvBytes)),
    positionsSha256: sha256(JSON.stringify(positions)),
    positions,
    quarantinedPositions,
    ...(line.overlayLineToken ? {
      overlayDatasetId: KRIC_1294_DATASET_ID,
      overlayDetailUrl: KRIC_1294_DETAIL_URL,
      overlayDownloadUrl: KRIC_1294_DOWNLOAD_URL,
      overlayFixturePath: KRIC_1294_OVERLAY_FIXTURE,
      overlayLineToken: line.overlayLineToken,
      overlayStationNames,
      overlayRawSha256,
    } : {}),
    ...(line.applyLatLonSwap ? {
      officialLatLonSwapRule: "if lon∈[33,43] and lat∈[124,132]: swap",
      swappedCoordinateCount,
    } : {}),
  };
  return validateCapitalLightRailRouteMapPositionsSnapshot(snapshot);
}

export function validateCapitalLightRailRouteMapPositionsSnapshot(snapshot) {
  const line = LINE_BY_SOURCE_ID.get(snapshot?.sourceId);
  if (!line) throw new Error("unknown capital-light rail route map positions sourceId");
  const positions = snapshot?.positions;
  const quarantinedPositions = snapshot?.quarantinedPositions;
  const keys = new Set();
  const canvasOwners = new Map();
  const validPositions = Array.isArray(positions) && positions.length === line.expectedStationCount
    && positions.every((position) => {
      const key = `${position.lineId}:${position.stationId}`;
      const owner = position.stationId;
      const canvasKey = `${position.x},${position.y}`;
      const canvasOwner = canvasOwners.get(canvasKey);
      const uniqueCanvas = canvasOwner == null || canvasOwner === owner;
      const valid = position.lineId === line.lineId
        && position.line === line.slug
        && typeof position.stationCode === "string" && position.stationCode.length > 0
        && typeof position.stationName === "string" && position.stationName.length > 0
        && typeof position.stationId === "string" && position.stationId.startsWith("station-")
        && Number.isInteger(position.x) && Number.isInteger(position.y)
        && isSchematicCanvasCoordinate(position.x, position.y, line)
        && Number.isInteger(position.labelDx) && Number.isInteger(position.labelDy)
        && Number.isFinite(position.latitude) && Number.isFinite(position.longitude)
        && position.latitude >= line.geo.latMin && position.latitude <= line.geo.latMax
        && position.longitude >= line.geo.lonMin && position.longitude <= line.geo.lonMax
        && Array.isArray(position.labelPolygon) && position.labelPolygon.length === 4
        && position.labelPolygon.every(({ x, y }) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0)
        && !keys.has(key)
        && uniqueCanvas;
      keys.add(key);
      canvasOwners.set(canvasKey, owner);
      return valid;
    });
  const quarantinedKeys = new Set();
  const validQuarantine = Array.isArray(quarantinedPositions)
    && quarantinedPositions.length === line.expectedQuarantinedCount
    && quarantinedPositions.every((entry) => {
      const key = `${entry.lineId}:${entry.stationId}`;
      const reasonOk = entry.reasonCode === OFFICIAL_MISSING_LATLON
        || entry.reasonCode === OFFICIAL_MISSING_FILE_ROW;
      const coordsOk = entry.reasonCode === OFFICIAL_MISSING_FILE_ROW
        || entry.latitude == null || entry.longitude == null
        || (Number.isFinite(entry.latitude) && Number.isFinite(entry.longitude));
      const valid = entry.lineId === line.lineId
        && entry.line === line.slug
        && typeof entry.stationCode === "string" && entry.stationCode.length > 0
        && typeof entry.stationName === "string" && entry.stationName.length > 0
        && typeof entry.stationId === "string" && entry.stationId.startsWith("station-")
        && Number.isInteger(entry.x) && Number.isInteger(entry.y)
        && isSchematicCanvasCoordinate(entry.x, entry.y, line)
        && reasonOk
        && coordsOk
        && !quarantinedKeys.has(key)
        && !keys.has(key);
      quarantinedKeys.add(key);
      return valid;
    });
  const datasetIds = line.datasetIds ?? [line.datasetId];
  if (snapshot?.schemaVersion !== 1 || snapshot.artifactKind !== ARTIFACT_KIND
    || snapshot.sourceId !== line.sourceId || snapshot.official !== true || snapshot.fixture !== false
    || snapshot.credentialRequired !== false || snapshot.credentialRedacted !== true
    || snapshot.datasetId !== line.datasetId || snapshot.detailUrl !== line.detailUrl
    || snapshot.datasetUrl !== line.detailUrl || snapshot.endpoint !== line.detailUrl
    || snapshot.downloadUrl !== line.downloadUrl
    || JSON.stringify(snapshot.datasetIds) !== JSON.stringify(datasetIds)
    || Number.isNaN(Date.parse(snapshot.capturedAt))
    || snapshot.observedDataUpdatedAt !== line.observedDataUpdatedAt
    || snapshot.rawStationCount !== line.packStationCount
    || snapshot.stationCount !== line.expectedStationCount
    || snapshot.quarantinedCount !== line.expectedQuarantinedCount
    || snapshot.rawStationCount !== snapshot.stationCount + snapshot.quarantinedCount
    || JSON.stringify(snapshot.lineIds) !== JSON.stringify([line.lineId])
    || JSON.stringify(snapshot.lineStationCounts) !== JSON.stringify({ [line.slug]: line.expectedStationCount })
    || JSON.stringify(snapshot.fieldsProvided) !== JSON.stringify(FIELDS_PROVIDED)
    || snapshot.topologySourceId !== TOPOLOGY_SOURCE_ID
    || snapshot.topologySnapshotId !== TOPOLOGY_SNAPSHOT_ID
    || snapshot.schematicCanvasSourceId !== SCHEMATIC_CANVAS_SOURCE_ID
    || !/^[a-f0-9]{64}$/.test(snapshot.topologyContentSha256 ?? "")
    || !Array.isArray(snapshot.topologyLineages) || snapshot.topologyLineages.length !== 1
    || snapshot.topologyLineages[0]?.sourceId !== TOPOLOGY_SOURCE_ID
    || snapshot.topologyLineages[0]?.snapshotId !== TOPOLOGY_SNAPSHOT_ID
    || snapshot.topologyLineages[0]?.contentSha256 !== snapshot.topologyContentSha256
    || snapshot.topologyLineages[0]?.lineId !== line.lineId
    || !/^[a-f0-9]{64}$/.test(snapshot.rawSha256 ?? "")
    || !/^[a-f0-9]{64}$/.test(snapshot.scopeSha256 ?? "")
    || snapshot.scopeSha256 !== sha256(JSON.stringify(snapshot.scope))
    || !validPositions
    || !validQuarantine
    || JSON.stringify([...positions].sort(comparePositions)) !== JSON.stringify(positions)
    || JSON.stringify([...quarantinedPositions].sort(comparePositions)) !== JSON.stringify(quarantinedPositions)
    || snapshot.positionsSha256 !== sha256(JSON.stringify(positions))) {
    throw new Error(`invalid ${line.sourceId} route map positions snapshot`);
  }
  return snapshot;
}

function resolveLine(lineKey, sourceId) {
  const line = getCapitalLightRailRouteMapPositionLine(sourceId ?? lineKey);
  if (!line) throw new Error(`unknown capital-light rail line: ${sourceId ?? lineKey}`);
  return line;
}

function resolveCsvIndexes(header, line) {
  const stationName = header.findIndex((value) => ["역명", "역사명"].includes(value));
  const longitude = header.findIndex((value) => ["경도", "역경도", "역 위치(경도)"].includes(value));
  const latitude = header.findIndex((value) => ["위도", "역위도", "역 위치(위도)"].includes(value));
  const lineName = header.findIndex((value) => ["선명", "노선명", "운영노선"].includes(value));
  const operator = header.findIndex((value) => ["철도운영기관", "철도운영기관명", "운영기관명"].includes(value));
  if (stationName < 0 || longitude < 0 || latitude < 0) {
    throw new Error(`${line.sourceId} CSV missing lat/lon/name columns`);
  }
  if (line.inputKind !== "filtered-csv" && lineName < 0) {
    throw new Error(`${line.sourceId} CSV missing line column`);
  }
  return { stationName, longitude, latitude, lineName, operator };
}

function indexSchematicCanvas(schematicCanvas, line) {
  const resolved = resolveSchematicCanvas(schematicCanvas, line);
  const byName = new Map();
  for (const entry of resolved.stations) {
    if (typeof entry.stationName !== "string" || entry.stationName.length === 0) {
      throw new Error(`${line.sourceId} schematic canvas stationName is required`);
    }
    if (typeof entry.stationId !== "string" || !entry.stationId.startsWith("station-")) {
      throw new Error(`${line.sourceId} schematic canvas stationId is required: ${entry.stationName}`);
    }
    if (entry.stationCode == null || String(entry.stationCode).length === 0) {
      throw new Error(`${line.sourceId} schematic canvas stationCode is required: ${entry.stationName}`);
    }
    if (!isSchematicCanvasCoordinate(entry.x, entry.y, line)
      || !Number.isInteger(entry.labelDx) || !Number.isInteger(entry.labelDy)
      || !Array.isArray(entry.labelPolygon) || entry.labelPolygon.length !== 4
      || !entry.labelPolygon.every(({ x, y }) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0)) {
      throw new Error(`${line.sourceId} schematic canvas invalid geometry: ${entry.stationName}`);
    }
    const key = normalizeStationName(entry.stationName);
    if (byName.has(key)) {
      throw new Error(`${line.sourceId} schematic canvas duplicate station name: ${key}`);
    }
    byName.set(key, {
      stationCode: String(entry.stationCode),
      stationName: entry.stationName,
      stationId: entry.stationId,
      x: entry.x,
      y: entry.y,
      labelDx: entry.labelDx,
      labelDy: entry.labelDy,
      labelPolygon: entry.labelPolygon,
    });
  }
  return byName;
}

function resolveSchematicCanvas(schematicCanvas, line) {
  if (Array.isArray(schematicCanvas)) {
    if (schematicCanvas.length !== line.packStationCount) {
      throw new Error(`${line.sourceId} schematic canvas fixture station count mismatch`);
    }
    if (schematicCanvas.some((entry) => entry?.canvasSourceId !== SCHEMATIC_CANVAS_SOURCE_ID)) {
      throw new Error(`${line.sourceId} schematic canvasSourceId mismatch`);
    }
    return { sourceId: SCHEMATIC_CANVAS_SOURCE_ID, stations: schematicCanvas };
  }
  if (schematicCanvas?.sourceId !== SCHEMATIC_CANVAS_SOURCE_ID
    || schematicCanvas.lineId !== line.lineId
    || !Array.isArray(schematicCanvas.stations)
    || schematicCanvas.stations.length !== line.packStationCount) {
    throw new Error(`${line.sourceId} schematic canvas fixture station count mismatch`);
  }
  return schematicCanvas;
}

function isSchematicCanvasCoordinate(x, y, line) {
  return Number.isFinite(x) && Number.isFinite(y)
    && x >= line.canvas.xMin && x <= line.canvas.xMax
    && y >= line.canvas.yMin && y <= line.canvas.yMax;
}

function validateTopologySnapshot(topologySnapshot, line) {
  if (topologySnapshot?.sourceId !== TOPOLOGY_SOURCE_ID
    || !/^[a-f0-9]{64}$/.test(topologySnapshot.contentSha256 ?? "")
    || !Array.isArray(topologySnapshot.lines)) {
    throw new Error(`${line.sourceId} topology snapshot is invalid`);
  }
  const topologyLine = topologySnapshot.lines.find(({ lineId }) => lineId === line.lineId);
  if (!topologyLine || !Array.isArray(topologyLine.scope)) {
    throw new Error(`${line.sourceId} topology line scope is invalid`);
  }
  const expectedLineHash = sha256(JSON.stringify({
    scope: topologyLine.scope,
    edges: topologyLine.edges,
  }));
  if (topologyLine.contentSha256 !== expectedLineHash) {
    throw new Error(`${line.sourceId} topology line contentSha256 mismatch`);
  }
  const topologyNames = new Set();
  for (const entry of topologyLine.scope) {
    topologyNames.add(normalizeStationName(entry.stationName));
  }
  for (const branch of topologyLine.branchSequences ?? []) {
    for (const stationName of branch.stationNames ?? []) {
      topologyNames.add(normalizeStationName(stationName));
    }
  }
  return topologyNames;
}

export function normalizeCapitalLightStationName(value) {
  return normalizeStationName(value);
}

function normalizeStationName(value) {
  return String(value).normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[·ㆍ]/g, ".")
    .replace(/\([^()]*\)$/, "")
    .replace(/역$/, "");
}

function parseCsv(text) {
  const rows = text.split(/\r?\n/).filter((line) => line.length > 0).map((line) => line.split(","));
  const [header, ...body] = rows;
  if (header) {
    for (const [index, row] of body.entries()) {
      if (row.length !== header.length) {
        throw new Error(`CSV column count mismatch at row ${index + 2}: expected ${header.length}, got ${row.length}`);
      }
    }
  }
  return rows;
}

function comparePositions(left, right) {
  const leftCode = Number(left.stationCode);
  const rightCode = Number(right.stationCode);
  if (Number.isFinite(leftCode) && Number.isFinite(rightCode) && leftCode !== rightCode) {
    return leftCode - rightCode;
  }
  return String(left.stationCode).localeCompare(String(right.stationCode), "en")
    || String(left.stationId ?? "").localeCompare(String(right.stationId ?? ""), "en")
    || String(left.stationName ?? "").localeCompare(String(right.stationName ?? ""), "en");
}

function validDate(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} is invalid`);
  return date;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--")) {
      throw new Error("usage: collect-kric-capital-light-rail-route-map-positions.mjs --line <key|sourceId> --input <csv> --topology <json> --schematic <json> --output <absolute.json> [--overlay <csv>] [--captured-at <iso>]");
    }
    args[argv[index].slice(2)] = argv[index + 1];
  }
  if (!args.line || !args.input || !args.topology || !args.schematic || !args.output || !path.isAbsolute(args.output)) {
    throw new Error("usage: collect-kric-capital-light-rail-route-map-positions.mjs --line <key|sourceId> --input <csv> --topology <json> --schematic <json> --output <absolute.json> [--overlay <csv>] [--captured-at <iso>]");
  }
  return args;
}

export async function runCapitalLightRailRouteMapPositionsCollector(argv) {
  const args = parseArgs(argv);
  const line = resolveLine(args.line);
  const reads = [
    readFile(args.input),
    readFile(args.topology, "utf8").then(JSON.parse),
    readFile(args.schematic, "utf8").then(JSON.parse),
  ];
  if (line.overlayLineToken) {
    const overlayPath = args.overlay
      ?? path.resolve(import.meta.dirname, "../..", KRIC_1294_OVERLAY_FIXTURE);
    reads.push(readFile(overlayPath));
  }
  const [csvBytes, topologySnapshot, schematicCanvas, overlayCsvBytes = null] = await Promise.all(reads);
  const snapshot = collectCapitalLightRailRouteMapPositions({
    lineKey: args.line,
    csvBytes,
    overlayCsvBytes,
    topologySnapshot,
    schematicCanvas,
    now: args["captured-at"] ? new Date(args["captured-at"]) : new Date(),
  });
  await writeFile(args.output, `${JSON.stringify(snapshot)}\n`);
  console.log(`${snapshot.sourceId} ready: admitted=${snapshot.stationCount} quarantined=${snapshot.quarantinedCount}`);
  return snapshot;
}

export {
  ARTIFACT_KIND,
  ISSUE,
  KRIC_1294_DATASET_ID,
  KRIC_1294_DETAIL_URL,
  KRIC_1294_DOWNLOAD_URL,
  KRIC_1294_OVERLAY_FIXTURE,
  OFFICIAL_MISSING_FILE_ROW,
  OFFICIAL_MISSING_LATLON,
  SCHEMATIC_CANVAS_SOURCE_ID,
  TOPOLOGY_SNAPSHOT_ID,
  TOPOLOGY_SOURCE_ID,
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runCapitalLightRailRouteMapPositionsCollector(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "capital-light rail route map position collection failed");
    process.exitCode = 1;
  }
}
