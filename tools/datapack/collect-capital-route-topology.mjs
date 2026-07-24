#!/usr/bin/env node
/**
 * 국가철도공단(관련) 수도권 역간거리 FILE → capital route topology snapshot.
 *
 * 규칙:
 * - 동일 선명(branch) 내 연속 역 = bidirectional LOCAL SUBWAY RIDE edge
 * - 운영기관 경계는 기본 분리. 공식 스플라이스만 예외(1호선 지하, 3호선 삼송-지축,
 *   7호선 온수-까치울, 서해선 부천종합운동장-소사)
 * - MOLIT 도시철도 전체노선 순번 연속 = bidirectional LOCAL SUBWAY RIDE (거리 0 허용)
 * - 동일 선명에서 기점 재시작(5호선) / 역 재방문 지선(2·경춘)은 새 segment
 * - geo/좌표 휴리스틱 금지. data.go.kr 15058404 미사용.
 *
 * lineId 매핑 (CSV/선명 → pack):
 *   1호선*          → line-472a81add377
 *   2호선           → seoul-2
 *   3호선           → line-41a8c75ec9d8
 *   4호선           → seoul-4
 *   5호선           → line-80fc4d5350d4
 *   6호선           → line-3f41718e0833
 *   7호선           → line-15b3b8a93259
 *   8호선           → line-2b2d9eaa53d0
 *   9호선           → line-f0e747248a31
 *   신분당          → shinbundang
 *   공항            → line-e9e9a5b520a4
 *   경의중앙        → line-6e39be0cb6e2
 *   경춘            → line-54a7b980b7c3
 *   경강            → line-e4939a4b4713
 *   수인분당        → line-558d0bd8312d
 *   에버라인        → line-828f04afc588
 *   우이신설        → line-30886152e4f8
 *   의정부          → line-62096860ab09
 *   인천1호선       → line-98718184f016
 *   인천2호선       → line-42b5805f3b5a
 *   GTX-A(xlsx)     → line-8604048b6430
 *   김포골드라인(MOLIT 순번) → line-5500c1600f71
 *   신림선(MOLIT 순번)      → line-aefa08ccc0a9
 *   서해선(코레일15081858+MOLIT≥10+스플라이스) → line-051552e50435
 *
 * topologyGaps: 없음 (공식 순번/역간거리로 24개 수도권 지도 노선 모두 포함)
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

import { codepointCompare } from "../lib/codepoint-compare.mjs";
import {
  ARTIFACT_KIND as LINE1_ARTIFACT_KIND,
  DATASET_ID as LINE1_DATASET_ID,
  DETAIL_URL as LINE1_DETAIL_URL,
  DOWNLOAD_URL as LINE1_DOWNLOAD_URL,
  LINE_ID as LINE1_LINE_ID,
  SOURCE_ID as LINE1_SOURCE_ID,
  decodeOfficialCsv,
  normalizeStationName,
  parseCapitalLine1RouteTopology,
} from "./collect-capital-line1-route-topology.mjs";

export { decodeOfficialCsv, normalizeStationName };

export const SOURCE_ID = "capital-route-topology";
export const ARTIFACT_KIND = "capital-route-topology-snapshot";
export const FRESHNESS_MILLIS = 24 * 60 * 60 * 1_000;

/** Capital map lineIds that topology apply may replace (SUBWAY LOCAL RIDE). */
export const CAPITAL_MAP_LINE_IDS = Object.freeze([
  "line-472a81add377",
  "seoul-2",
  "line-41a8c75ec9d8",
  "seoul-4",
  "line-80fc4d5350d4",
  "line-3f41718e0833",
  "line-15b3b8a93259",
  "line-2b2d9eaa53d0",
  "line-f0e747248a31",
  "line-8604048b6430",
  "line-e4939a4b4713",
  "line-6e39be0cb6e2",
  "line-54a7b980b7c3",
  "line-e9e9a5b520a4",
  "line-5500c1600f71",
  "line-051552e50435",
  "line-558d0bd8312d",
  "line-aefa08ccc0a9",
  "shinbundang",
  "line-828f04afc588",
  "line-30886152e4f8",
  "line-62096860ab09",
  "line-98718184f016",
  "line-42b5805f3b5a",
]);

/**
 * Per-line official FILE catalog.
 * downloadUrl uses contentUrl-style fileDownload (no login).
 */
export const LINE_SOURCES = Object.freeze([
  {
    slug: "line1",
    lineId: "line-472a81add377",
    datasetId: "15041460",
    detailUrl: "https://www.data.go.kr/data/15041460/fileData.do",
    downloadUrl:
      "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003521015&fileDetailSn=1&insertDataPrcus=N",
    localCsv: "tools/datapack/sources/capital-line1-distance-20260724.csv",
    kind: "line1",
  },
  {
    slug: "line2",
    lineId: "seoul-2",
    datasetId: "15041425",
    detailUrl: "https://www.data.go.kr/data/15041425/fileData.do",
    downloadUrl:
      "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003521017&fileDetailSn=1&insertDataPrcus=N",
    localCsv: "tools/datapack/sources/capital-line2-distance-20260724.csv",
    kind: "csv",
    closeCycleOnFirstSegmentOnly: true,
  },
  {
    slug: "line3",
    lineId: "line-41a8c75ec9d8",
    datasetId: "15041423",
    detailUrl: "https://www.data.go.kr/data/15041423/fileData.do",
    downloadUrl:
      "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003513274&fileDetailSn=1&insertDataPrcus=N",
    localCsv: "tools/datapack/sources/capital-line3-distance-20260724.csv",
    kind: "csv",
    splices: [{ from: "삼송", to: "지축", useTrailingFrom: "삼송" }],
  },
  {
    slug: "line4",
    lineId: "seoul-4",
    datasetId: "15041350",
    detailUrl: "https://www.data.go.kr/data/15041350/fileData.do",
    downloadUrl:
      "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003636914&fileDetailSn=1&insertDataPrcus=N",
    localCsv: "tools/datapack/sources/capital-line4-distance-20260724.csv",
    kind: "csv",
    chainAcrossOperators: true,
  },
  {
    slug: "line5",
    lineId: "line-80fc4d5350d4",
    datasetId: "15041348",
    detailUrl: "https://www.data.go.kr/data/15041348/fileData.do",
    downloadUrl:
      "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003521020&fileDetailSn=1&insertDataPrcus=N",
    localCsv: "tools/datapack/sources/capital-line5-distance-20260724.csv",
    kind: "csv",
    restartOnFirstStation: true,
  },
  {
    slug: "line6",
    lineId: "line-3f41718e0833",
    datasetId: "15041297",
    detailUrl: "https://www.data.go.kr/data/15041297/fileData.do",
    downloadUrl:
      "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003515229&fileDetailSn=1&insertDataPrcus=N",
    localCsv: "tools/datapack/sources/capital-line6-distance-20260724.csv",
    kind: "line6",
  },
  {
    slug: "line7",
    lineId: "line-15b3b8a93259",
    datasetId: "15041340",
    detailUrl: "https://www.data.go.kr/data/15041340/fileData.do",
    downloadUrl:
      "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003521023&fileDetailSn=1&insertDataPrcus=N",
    localCsv: "tools/datapack/sources/capital-line7-distance-20260724.csv",
    kind: "csv",
    splices: [{ from: "온수", to: "까치울", useDistanceOf: "까치울" }],
  },
  {
    slug: "line8",
    lineId: "line-2b2d9eaa53d0",
    datasetId: "15041299",
    detailUrl: "https://www.data.go.kr/data/15041299/fileData.do",
    downloadUrl:
      "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003515516&fileDetailSn=1&insertDataPrcus=N",
    localCsv: "tools/datapack/sources/capital-line8-distance-20260724.csv",
    kind: "csv",
    chainAcrossOperators: true,
  },
  {
    slug: "line9",
    lineId: "line-f0e747248a31",
    datasetId: "15041298",
    detailUrl: "https://www.data.go.kr/data/15041298/fileData.do",
    downloadUrl:
      "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003515511&fileDetailSn=1&insertDataPrcus=N",
    localCsv: "tools/datapack/sources/capital-line9-distance-20260724.csv",
    kind: "csv",
  },
  {
    slug: "shinbundang",
    lineId: "shinbundang",
    datasetId: "15041074",
    detailUrl: "https://www.data.go.kr/data/15041074/fileData.do",
    downloadUrl:
      "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003514009&fileDetailSn=1&insertDataPrcus=N",
    localCsv: "tools/datapack/sources/capital-shinbundang-distance-20260724.csv",
    kind: "csv",
  },
  {
    slug: "airport",
    lineId: "line-e9e9a5b520a4",
    datasetId: "15041310",
    detailUrl: "https://www.data.go.kr/data/15041310/fileData.do",
    downloadUrl:
      "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003508648&fileDetailSn=1&insertDataPrcus=N",
    localCsv: "tools/datapack/sources/capital-airport-distance-20260724.csv",
    kind: "csv",
  },
  {
    slug: "gyeongui",
    lineId: "line-6e39be0cb6e2",
    datasetId: "15041327",
    detailUrl: "https://www.data.go.kr/data/15041327/fileData.do",
    downloadUrl:
      "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003508646&fileDetailSn=1&insertDataPrcus=N",
    localCsv: "tools/datapack/sources/capital-gyeongui-distance-20260724.csv",
    kind: "csv",
  },
  {
    slug: "gyeongchun",
    lineId: "line-54a7b980b7c3",
    datasetId: "15041295",
    detailUrl: "https://www.data.go.kr/data/15041295/fileData.do",
    downloadUrl:
      "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003508652&fileDetailSn=1&insertDataPrcus=N",
    localCsv: "tools/datapack/sources/capital-gyeongchun-distance-20260724.csv",
    kind: "csv",
  },
  {
    slug: "gyeonggang",
    lineId: "line-e4939a4b4713",
    datasetId: "15041296",
    detailUrl: "https://www.data.go.kr/data/15041296/fileData.do",
    downloadUrl:
      "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003515231&fileDetailSn=1&insertDataPrcus=N",
    localCsv: "tools/datapack/sources/capital-gyeonggang-distance-20260724.csv",
    kind: "csv",
  },
  {
    slug: "suinbundang",
    lineId: "line-558d0bd8312d",
    datasetId: "15041284",
    detailUrl: "https://www.data.go.kr/data/15041284/fileData.do",
    downloadUrl:
      "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003508650&fileDetailSn=1&insertDataPrcus=N",
    localCsv: "tools/datapack/sources/capital-suinbundang-distance-20260724.csv",
    kind: "csv",
    note: "수인선 15041269 와 동일 수인분당 CSV",
  },
  {
    slug: "everline",
    lineId: "line-828f04afc588",
    datasetId: "15081850",
    detailUrl: "https://www.data.go.kr/data/15081850/fileData.do",
    downloadUrl:
      "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003639182&fileDetailSn=1&insertDataPrcus=N",
    localCsv: "tools/datapack/sources/capital-everline-distance-20260724.csv",
    kind: "csv",
  },
  {
    slug: "ui",
    lineId: "line-30886152e4f8",
    datasetId: "15081853",
    detailUrl: "https://www.data.go.kr/data/15081853/fileData.do",
    downloadUrl:
      "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003545531&fileDetailSn=1&insertDataPrcus=N",
    localCsv: "tools/datapack/sources/capital-ui-distance-20260724.csv",
    kind: "csv",
  },
  {
    slug: "uijeongbu",
    lineId: "line-62096860ab09",
    datasetId: "15081852",
    detailUrl: "https://www.data.go.kr/data/15081852/fileData.do",
    downloadUrl:
      "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000002426143&fileDetailSn=1&insertDataPrcus=N",
    localCsv: "tools/datapack/sources/capital-uijeongbu-distance-20260724.csv",
    kind: "csv",
  },
  {
    slug: "incheon1",
    lineId: "line-98718184f016",
    datasetId: "15081855",
    detailUrl: "https://www.data.go.kr/data/15081855/fileData.do",
    downloadUrl:
      "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003545376&fileDetailSn=1&insertDataPrcus=N",
    localCsv: "tools/datapack/sources/capital-incheon1-distance-20260724.csv",
    kind: "csv",
  },
  {
    slug: "incheon2",
    lineId: "line-42b5805f3b5a",
    datasetId: "15081856",
    detailUrl: "https://www.data.go.kr/data/15081856/fileData.do",
    downloadUrl:
      "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003639180&fileDetailSn=1&insertDataPrcus=N",
    localCsv: "tools/datapack/sources/capital-incheon2-distance-20260724.csv",
    kind: "csv",
  },
  {
    slug: "gtxa",
    lineId: "line-8604048b6430",
    datasetId: "15138908",
    detailUrl: "https://www.data.go.kr/data/15138908/fileData.do",
    downloadUrl:
      "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003046980&fileDetailSn=1&insertDataPrcus=N",
    localCsv: "tools/datapack/sources/capital-gtxa-distance-20260724.xlsx",
    kind: "gtxa-xlsx",
  },
  {
    slug: "gimpo",
    lineId: "line-5500c1600f71",
    datasetId: "15122916",
    detailUrl: "https://www.data.go.kr/data/15122916/fileData.do",
    downloadUrl: "https://www.data.go.kr/data/15122916/fileData.do",
    localCsv: "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv",
    kind: "molit-sequence",
    molitRouteName: "김포골드라인",
  },
  {
    slug: "sillim",
    lineId: "line-aefa08ccc0a9",
    datasetId: "15122916",
    detailUrl: "https://www.data.go.kr/data/15122916/fileData.do",
    downloadUrl: "https://www.data.go.kr/data/15122916/fileData.do",
    localCsv: "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv",
    kind: "molit-sequence",
    molitRouteName: "신림선",
  },
  {
    slug: "seohae",
    lineId: "line-051552e50435",
    datasetId: "15081858",
    detailUrl: "https://www.data.go.kr/data/15081858/fileData.do",
    downloadUrl:
      "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003639143&fileDetailSn=1&insertDataPrcus=N",
    localCsv: "tools/datapack/sources/capital-seohae-korail-distance-20260724.csv",
    localMolitCsv: "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv",
    kind: "seohae-merged",
    molitRouteName: "서해선",
    molitMinSequence: 10,
    note: "코레일 15081858 서해선(원종 포함)+MOLIT 순번≥10(소사~원시)+부천종합운동장↔소사 스플라이스",
  },
]);

/** 공식 소스로 모두 채워진 뒤 비움. */
export const TOPOLOGY_GAPS = Object.freeze([]);

const STANDARD_HEADERS = Object.freeze([
  ["철도운영기관명", "선명", "역명", "역간거리", "후행역간거리"],
  ["철도운영기관명", "선명", "역명", "역간거리(Km)"],
  ["철도운영기관명", "선명", "역명", "역간거리(km)"],
  ["철도운영기관명", "선명", "역명", "역간거리"],
]);

function edgeKey(fromName, toName) {
  return [fromName, toName].sort(codepointCompare).join("\u0000");
}

function parseOptionalKilometers(value) {
  const text = String(value ?? "").trim();
  if (text.length === 0) return null;
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0) throw new Error(`invalid kilometers: ${value}`);
  return number;
}

function kilometersToMeters(value) {
  const meters = Math.round(Number(value) * 1_000);
  if (!Number.isInteger(meters) || meters < 0) throw new Error(`invalid distance km: ${value}`);
  return meters;
}

function parseDistanceCsv(csvBytes) {
  const text = decodeOfficialCsv(csvBytes);
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length < 2) throw new Error("distance CSV is empty");
  const rows = lines.map((line) => line.split(","));
  const [header, ...body] = rows;
  const matched = STANDARD_HEADERS.some((candidate) => JSON.stringify(candidate) === JSON.stringify(header));
  if (!matched) throw new Error(`distance CSV header mismatch: ${header.join(",")}`);
  const hasTrailing = header.length >= 5;
  return body.map((cols, index) => {
    if (cols.length < 4) {
      throw new Error(`CSV column count mismatch at row ${index + 2}`);
    }
    return {
      operatorName: cols[0].trim(),
      branchName: cols[1].trim(),
      stationName: cols[2].trim(),
      distanceKilometers: parseOptionalKilometers(cols[3]),
      trailingDistanceKilometers: hasTrailing ? parseOptionalKilometers(cols[4]) : null,
    };
  });
}

function upsertUndirected(map, fromStationName, toStationName, distanceMeters, branchName) {
  if (fromStationName === toStationName) {
    throw new Error(`self edge: ${fromStationName}`);
  }
  if (!Number.isInteger(distanceMeters) || distanceMeters < 0) {
    throw new Error(`distance invalid: ${fromStationName}-${toStationName}`);
  }
  const key = edgeKey(fromStationName, toStationName);
  const existing = map.get(key);
  if (existing == null) {
    const [left, right] = [fromStationName, toStationName].sort(codepointCompare);
    map.set(key, {
      fromStationName: left,
      toStationName: right,
      distanceMeters,
      branchNames: new Set([branchName]),
    });
    return;
  }
  if (existing.distanceMeters !== distanceMeters
    && existing.distanceMeters > 0
    && distanceMeters > 0) {
    // Prefer positive consistent; allow equal. Conflict → keep existing if both >0 differ? throw.
    throw new Error(
      `distance conflict: ${fromStationName}-${toStationName} `
      + `${existing.distanceMeters} vs ${distanceMeters}`,
    );
  }
  if (existing.distanceMeters === 0 && distanceMeters > 0) {
    existing.distanceMeters = distanceMeters;
  }
  existing.branchNames.add(branchName);
}

function materializeEdges(undirected) {
  const edges = [];
  for (const edge of [...undirected.values()]
    .sort((left, right) => codepointCompare(left.fromStationName, right.fromStationName)
      || codepointCompare(left.toStationName, right.toStationName))) {
    const branchNames = [...edge.branchNames].sort(codepointCompare);
    edges.push({
      fromStationName: edge.fromStationName,
      toStationName: edge.toStationName,
      distanceMeters: edge.distanceMeters,
      durationSeconds: 0,
      branchNames,
    });
    edges.push({
      fromStationName: edge.toStationName,
      toStationName: edge.fromStationName,
      distanceMeters: edge.distanceMeters,
      durationSeconds: 0,
      branchNames,
    });
  }
  edges.sort((left, right) => codepointCompare(left.fromStationName, right.fromStationName)
    || codepointCompare(left.toStationName, right.toStationName));
  return edges;
}

function buildScope(undirected) {
  const stationNames = [...new Set(
    [...undirected.values()].flatMap(({ fromStationName, toStationName }) => [
      fromStationName,
      toStationName,
    ]),
  )].sort(codepointCompare);
  return stationNames.map((stationName, index) => ({ stationName, sequence: index + 1 }));
}

function findRow(rows, name) {
  const normalized = normalizeStationName(name);
  return rows.find((row) => normalizeStationName(row.stationName) === normalized) ?? null;
}

/**
 * Generic CSV → undirected edges for one capital line.
 */
export function parseGenericCapitalDistanceCsv(csvBytes, source) {
  const rows = parseDistanceCsv(csvBytes);
  if (rows.length < 2) throw new Error(`${source.slug}: too few rows`);
  const undirected = new Map();
  const branchSequences = [];

  const branchNames = [...new Set(rows.map(({ branchName }) => branchName))].sort(codepointCompare);

  for (const branchName of branchNames) {
    const branchRows = rows.filter((row) => row.branchName === branchName);
    const segments = splitBranchSegments(branchRows, source);
    for (const [segmentIndex, segment] of segments.entries()) {
      branchSequences.push({
        branchName,
        stationNames: segment.map(({ stationName }) => stationName),
        operatorRunCount: new Set(segment.map(({ operatorName }) => operatorName)).size,
      });
      addConsecutiveEdges(undirected, segment, branchName, source);
      const closeCycle = (source.closeCycleOnSegmentEnd && segment.length >= 3)
        || (source.closeCycleOnFirstSegmentOnly && segmentIndex === 0 && segment.length >= 3);
      if (closeCycle) {
        const first = segment[0];
        const last = segment[segment.length - 1];
        if (first.distanceKilometers != null && first.distanceKilometers > 0) {
          upsertUndirected(
            undirected,
            normalizeStationName(last.stationName),
            normalizeStationName(first.stationName),
            kilometersToMeters(first.distanceKilometers),
            branchName,
          );
        }
      }
    }
  }

  applyConfiguredSplices(undirected, rows, source);
  return { undirected, branchNames, branchSequences, rows };
}

function splitBranchSegments(branchRows, source) {
  if (source.chainAcrossOperators) {
    return splitByRestartAndRevisit(branchRows, source);
  }
  // Default: operator runs, then restart/revisit inside each run.
  const runs = [];
  let current = [];
  for (const row of branchRows) {
    if (current.length > 0 && current[0].operatorName !== row.operatorName) {
      runs.push(current);
      current = [];
    }
    current.push(row);
  }
  if (current.length > 0) runs.push(current);
  return runs.flatMap((run) => splitByRestartAndRevisit(run, source));
}

function splitByRestartAndRevisit(rows, source) {
  if (rows.length === 0) return [];
  const segments = [];
  let segment = [];
  /** 동일 선명 목록 전체에서 이미 나온 역 — 지선 재방문(2호선 성수/신도림) 감지용 */
  const seenInBranch = new Set();
  const firstName = normalizeStationName(rows[0].stationName);

  for (const row of rows) {
    const name = normalizeStationName(row.stationName);
    const restart = source.restartOnFirstStation
      && segment.length > 0
      && name === firstName
      && (row.distanceKilometers == null || row.distanceKilometers === 0);
    const revisit = segment.length > 0 && seenInBranch.has(name);
    if (restart || revisit) {
      if (segment.length > 0) segments.push(segment);
      segment = [row];
      // 분기 루트 역은 이미 seen. restart(5호선 방화)는 기점 재시작이라 seen에 남겨도 된다.
      continue;
    }
    segment.push(row);
    seenInBranch.add(name);
  }
  if (segment.length > 0) segments.push(segment);
  return segments;
}

function addConsecutiveEdges(undirected, segment, branchName, source) {
  for (let index = 1; index < segment.length; index += 1) {
    const from = segment[index - 1];
    const to = segment[index];
    if (!source.chainAcrossOperators && from.operatorName !== to.operatorName) continue;
    let km = to.distanceKilometers;
    if ((km == null || km <= 0) && from.trailingDistanceKilometers != null && from.trailingDistanceKilometers > 0) {
      km = from.trailingDistanceKilometers;
    }
    if (km == null || km <= 0) continue;
    upsertUndirected(
      undirected,
      normalizeStationName(from.stationName),
      normalizeStationName(to.stationName),
      kilometersToMeters(km),
      branchName,
    );
  }
}

function applyConfiguredSplices(undirected, rows, source) {
  for (const splice of source.splices ?? []) {
    const fromRow = findRow(rows, splice.from);
    const toRow = findRow(rows, splice.to);
    if (fromRow == null || toRow == null) {
      throw new Error(`${source.slug}: splice stations missing ${splice.from}-${splice.to}`);
    }
    let km = null;
    if (splice.useTrailingFrom) {
      const anchor = findRow(rows, splice.useTrailingFrom);
      km = anchor?.trailingDistanceKilometers ?? null;
    } else if (splice.useDistanceOf) {
      const anchor = findRow(rows, splice.useDistanceOf);
      km = anchor?.distanceKilometers ?? null;
    }
    if (km == null || km <= 0) {
      throw new Error(`${source.slug}: splice distance missing ${splice.from}-${splice.to}`);
    }
    upsertUndirected(
      undirected,
      normalizeStationName(splice.from),
      normalizeStationName(splice.to),
      kilometersToMeters(km),
      fromRow.branchName,
    );
  }
}

/**
 * 6호선 응암순환: CSV는 응암→…→구산→새절이지만
 * - 응암 행 역간거리 = 구산→응암
 * - 새절 행 역간거리 = 응암→새절
 * 구산→새절 직접 edge는 만들지 않는다.
 */
export function parseLine6DistanceCsv(csvBytes, source) {
  const rows = parseDistanceCsv(csvBytes);
  const undirected = new Map();
  const loopNames = ["응암", "역촌", "불광", "독바위", "연신내", "구산"];
  const normalized = rows.map((row) => ({
    ...row,
    norm: normalizeStationName(row.stationName),
  }));
  const loopRows = [];
  for (const name of loopNames) {
    const row = normalized.find((item) => item.norm === name);
    if (row == null) throw new Error("line6 eungam loop station missing: " + name);
    loopRows.push(row);
  }
  const eungam = loopRows[0];
  const gusan = loopRows[loopRows.length - 1];
  for (let index = 1; index < loopRows.length; index += 1) {
    const to = loopRows[index];
    if (to.distanceKilometers == null || to.distanceKilometers <= 0) {
      throw new Error(`line6 loop distance missing at ${to.stationName}`);
    }
    upsertUndirected(
      undirected,
      loopRows[index - 1].norm,
      to.norm,
      kilometersToMeters(to.distanceKilometers),
      "6호선",
    );
  }
  if (eungam.distanceKilometers == null || eungam.distanceKilometers <= 0) {
    throw new Error("line6 eungam closing distance missing");
  }
  upsertUndirected(
    undirected,
    gusan.norm,
    eungam.norm,
    kilometersToMeters(eungam.distanceKilometers),
    "6호선",
  );

  const saejeolIndex = normalized.findIndex((row) => row.norm === "새절");
  if (saejeolIndex < 0) throw new Error("line6 새절 missing");
  const saejeol = normalized[saejeolIndex];
  if (saejeol.distanceKilometers == null || saejeol.distanceKilometers <= 0) {
    throw new Error("line6 응암→새절 distance missing");
  }
  upsertUndirected(
    undirected,
    eungam.norm,
    saejeol.norm,
    kilometersToMeters(saejeol.distanceKilometers),
    "6호선",
  );
  for (let index = saejeolIndex + 1; index < normalized.length; index += 1) {
    const from = normalized[index - 1];
    const to = normalized[index];
    if (to.distanceKilometers == null || to.distanceKilometers <= 0) continue;
    upsertUndirected(
      undirected,
      from.norm,
      to.norm,
      kilometersToMeters(to.distanceKilometers),
      "6호선",
    );
  }

  return {
    undirected,
    branchNames: ["6호선"],
    branchSequences: [{
      branchName: "6호선",
      stationNames: rows.map(({ stationName }) => stationName),
      operatorRunCount: 1,
    }],
    rows,
  };
}

const MOLIT_FULL_ROUTE_HEADER = Object.freeze([
  "권역",
  "권역명",
  "철도운영기관명",
  "노선명",
  "순번",
  "역명",
]);

/**
 * MOLIT 도시철도 전체노선 CSV → 동일 노선명 순번 연속 bidirectional edges (거리 0).
 */
export function parseMolitSequenceCsv(csvBytes, source) {
  const routeName = source.molitRouteName;
  if (typeof routeName !== "string" || routeName.length === 0) {
    throw new Error(`${source.slug}: molitRouteName required`);
  }
  const rows = parseMolitFullRouteRows(csvBytes)
    .filter((row) => row.routeName === routeName)
    .sort((left, right) => left.sequence - right.sequence);
  if (rows.length < 2) {
    throw new Error(`${source.slug}: MOLIT route ${routeName} has too few stations`);
  }
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].sequence !== rows[index - 1].sequence + 1) {
      throw new Error(
        `${source.slug}: MOLIT ${routeName} sequence gap `
        + `${rows[index - 1].sequence} → ${rows[index].sequence}`,
      );
    }
  }
  const undirected = new Map();
  for (let index = 1; index < rows.length; index += 1) {
    upsertUndirected(
      undirected,
      normalizeStationName(rows[index - 1].stationName),
      normalizeStationName(rows[index].stationName),
      0,
      routeName,
    );
  }
  return {
    undirected,
    branchNames: [routeName],
    branchSequences: [{
      branchName: routeName,
      stationNames: rows.map(({ stationName }) => stationName),
      operatorRunCount: new Set(rows.map(({ operatorName }) => operatorName)).size,
    }],
    rows,
  };
}

/**
 * 서해선: 코레일 역간거리(원종 포함) + MOLIT 순번≥10(소사~원시) + 운영기관 경계 스플라이스.
 */
export function parseSeohaeMerged(korailBytes, molitBytes, source) {
  const korailParsed = parseGenericCapitalDistanceCsv(korailBytes, {
    ...source,
    slug: `${source.slug}-korail`,
    splices: [],
  });
  const routeName = source.molitRouteName ?? "서해선";
  const minSequence = Number.isInteger(source.molitMinSequence) ? source.molitMinSequence : 10;
  const molitRows = parseMolitFullRouteRows(molitBytes)
    .filter((row) => row.routeName === routeName && row.sequence >= minSequence)
    .sort((left, right) => left.sequence - right.sequence);
  if (molitRows.length < 2) {
    throw new Error(`${source.slug}: MOLIT ${routeName} seq>=${minSequence} too few stations`);
  }
  for (let index = 1; index < molitRows.length; index += 1) {
    if (molitRows[index].sequence !== molitRows[index - 1].sequence + 1) {
      throw new Error(
        `${source.slug}: MOLIT ${routeName} sequence gap `
        + `${molitRows[index - 1].sequence} → ${molitRows[index].sequence}`,
      );
    }
  }
  const undirected = korailParsed.undirected;
  for (let index = 1; index < molitRows.length; index += 1) {
    upsertUndirected(
      undirected,
      normalizeStationName(molitRows[index - 1].stationName),
      normalizeStationName(molitRows[index].stationName),
      0,
      routeName,
    );
  }
  // 코레일 종점(부천종합운동장) ↔ 서해철도 기점(소사) — MOLIT 순번상 인접, 거리 미제공 → 0.
  upsertUndirected(
    undirected,
    normalizeStationName("부천종합운동장역"),
    normalizeStationName("소사"),
    0,
    routeName,
  );
  return {
    undirected,
    branchNames: [...new Set([...korailParsed.branchNames, routeName])].sort(codepointCompare),
    branchSequences: [
      ...korailParsed.branchSequences,
      {
        branchName: routeName,
        stationNames: molitRows.map(({ stationName }) => stationName),
        operatorRunCount: new Set(molitRows.map(({ operatorName }) => operatorName)).size,
      },
    ],
    rows: [...korailParsed.rows, ...molitRows],
  };
}

function parseMolitFullRouteRows(csvBytes) {
  const text = decodeOfficialCsv(csvBytes);
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length < 2) throw new Error("MOLIT full-route CSV is empty");
  const rows = lines.map((line) => line.split(","));
  const [header, ...body] = rows;
  if (JSON.stringify(header) !== JSON.stringify(MOLIT_FULL_ROUTE_HEADER)) {
    throw new Error(`MOLIT full-route header mismatch: ${header.join(",")}`);
  }
  return body.map((cols, index) => {
    if (cols.length < 6) {
      throw new Error(`MOLIT column count mismatch at row ${index + 2}`);
    }
    const sequence = Number(cols[4].trim());
    if (!Number.isInteger(sequence) || sequence < 1) {
      throw new Error(`MOLIT invalid sequence at row ${index + 2}: ${cols[4]}`);
    }
    return {
      regionCode: cols[0].trim(),
      regionName: cols[1].trim(),
      operatorName: cols[2].trim(),
      routeName: cols[3].trim(),
      sequence,
      stationName: cols[5].trim(),
    };
  });
}

/** GTX-A 철도거리표 xlsx (sharedStrings + sheet1). */
export function parseGtxADistanceXlsx(xlsxBytes) {
  if (!(xlsxBytes instanceof Uint8Array) && !Buffer.isBuffer(xlsxBytes)) {
    throw new Error("gtxa xlsx bytes required");
  }
  const buffer = Buffer.from(xlsxBytes);
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error("gtxa source is not a zip/xlsx");
  }
  // Minimal unzip via node:zlib is only inflateRaw — use manual zip local file parse.
  const files = unzipXlsx(buffer);
  const shared = files.get("xl/sharedStrings.xml");
  const sheet = files.get("xl/worksheets/sheet1.xml");
  if (shared == null || sheet == null) throw new Error("gtxa xlsx missing sheet/sharedStrings");
  const strings = [...shared.toString("utf8").matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1]);
  const rows = parseSheetRows(sheet.toString("utf8"), strings);
  // Expected columns: 노선명, 정거장명, 철도거리(역간), ...
  const header = rows[0] ?? [];
  const nameIdx = header.indexOf("정거장명");
  const lineIdx = header.indexOf("노선명");
  const distIdx = header.indexOf("철도거리(역간)");
  if (nameIdx < 0 || lineIdx < 0 || distIdx < 0) {
    throw new Error(`gtxa header mismatch: ${header.join(",")}`);
  }
  const undirected = new Map();
  const branchSequences = [];
  /** @type {Map<string, Array<{name:string, dist:number|null}>>} */
  const seq = new Map();
  for (const row of rows.slice(1)) {
    const lineName = String(row[lineIdx] ?? "").trim();
    let station = String(row[nameIdx] ?? "").trim();
    if (!lineName || !station || station === "(기점)" || station === "(종점)") continue;
    if (station === "서울") station = "서울역";
    const distRaw = String(row[distIdx] ?? "").trim();
    const dist = distRaw === "" || distRaw === "-" ? null : Number(distRaw);
    if (dist != null && !Number.isFinite(dist)) throw new Error(`gtxa invalid dist ${distRaw}`);
    if (!seq.has(lineName)) seq.set(lineName, []);
    seq.get(lineName).push({ name: station, dist });
  }
  for (const [lineName, stations] of seq) {
    branchSequences.push({
      branchName: lineName,
      stationNames: stations.map(({ name }) => name),
      operatorRunCount: 1,
    });
    for (let index = 1; index < stations.length; index += 1) {
      const to = stations[index];
      // 승객 정거장만 모은 뒤이므로 각 행 역간거리 = 직전 정거장과의 거리.
      // (기점→첫역 거리는 기점 행을 버려 자연히 제외된다.)
      if (to.dist == null || to.dist <= 0) continue;
      upsertUndirected(
        undirected,
        normalizeStationName(stations[index - 1].name),
        normalizeStationName(to.name),
        kilometersToMeters(to.dist),
        lineName,
      );
    }
  }
  return {
    undirected,
    branchNames: [...seq.keys()],
    branchSequences,
    rows: [],
  };
}

function unzipXlsx(buffer) {
  /** @type {Map<string, Buffer>} */
  const out = new Map();
  let offset = 0;
  while (offset + 30 < buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const flags = buffer.readUInt16LE(offset + 6);
    let compSize = buffer.readUInt32LE(offset + 18);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLen).toString("utf8");
    let start = offset + 30 + nameLen + extraLen;
    if ((flags & 0x8) !== 0 && compSize === 0) {
      // Data descriptor follows the payload; scan for next signature (best-effort).
      throw new Error(`xlsx entry uses data descriptor unsupported: ${name}`);
    }
    const compressed = buffer.subarray(start, start + compSize);
    let data;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = inflateRawSync(compressed);
    else throw new Error(`unsupported zip method ${method} for ${name}`);
    out.set(name, data);
    offset = start + compSize;
  }
  if (!out.has("xl/sharedStrings.xml") || !out.has("xl/worksheets/sheet1.xml")) {
    throw new Error("failed to unzip xlsx local entries");
  }
  return out;
}

function parseSheetRows(xml, strings) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = new Map();
    for (const cellMatch of rowMatch[1].matchAll(/<c r="([A-Z]+)(\d+)"([^>]*)>(?:<v>([^<]*)<\/v>)?/g)) {
      const col = cellMatch[1];
      const attrs = cellMatch[3] ?? "";
      const value = cellMatch[4] ?? "";
      let text = value;
      if (attrs.includes('t="s"')) text = strings[Number(value)] ?? "";
      cells.set(col, text);
    }
    if (cells.size === 0) continue;
    const maxCol = [...cells.keys()].sort().at(-1);
    const width = columnToIndex(maxCol) + 1;
    const row = Array.from({ length: width }, (_, index) => cells.get(indexToColumn(index)) ?? "");
    rows.push(row);
  }
  return rows;
}

function columnToIndex(col) {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function indexToColumn(index) {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function lineSnapshotFromUndirected(source, csvBytes, parsed, capturedAt) {
  const edges = materializeEdges(parsed.undirected);
  const scope = buildScope(parsed.undirected);
  const rawSha256 = sha256(Buffer.from(csvBytes));
  return {
    lineId: source.lineId,
    slug: source.slug,
    datasetId: source.datasetId,
    detailUrl: source.detailUrl,
    endpoint: source.downloadUrl,
    branchNames: parsed.branchNames,
    branchSequences: parsed.branchSequences,
    stationCount: scope.length,
    edgeCount: edges.length,
    scope,
    edges,
    scopeSha256: sha256(JSON.stringify(scope)),
    edgesSha256: sha256(JSON.stringify(edges)),
    rawSha256,
    contentSha256: sha256(JSON.stringify({ scope, edges })),
    capturedAt: capturedAt.toISOString(),
  };
}

export function parseLineSource(source, fileBytes, { capturedAt = new Date(), secondaryBytes = null } = {}) {
  const captured = validDate(capturedAt, "capturedAt");
  if (source.kind === "line1") {
    const snap = parseCapitalLine1RouteTopology(fileBytes, { capturedAt: captured });
    return {
      lineId: snap.lineId,
      slug: source.slug,
      datasetId: snap.datasetId,
      detailUrl: snap.detailUrl,
      endpoint: snap.endpoint,
      branchNames: snap.branchNames,
      branchSequences: snap.branchSequences,
      stationCount: snap.stationCount,
      edgeCount: snap.edgeCount,
      scope: snap.scope,
      edges: snap.edges,
      scopeSha256: snap.scopeSha256,
      edgesSha256: snap.edgesSha256,
      rawSha256: snap.rawSha256,
      contentSha256: snap.contentSha256,
      capturedAt: snap.capturedAt,
    };
  }
  if (source.kind === "line6") {
    return lineSnapshotFromUndirected(source, fileBytes, parseLine6DistanceCsv(fileBytes, source), captured);
  }
  if (source.kind === "gtxa-xlsx") {
    return lineSnapshotFromUndirected(source, fileBytes, parseGtxADistanceXlsx(fileBytes), captured);
  }
  if (source.kind === "molit-sequence") {
    return lineSnapshotFromUndirected(
      source,
      fileBytes,
      parseMolitSequenceCsv(fileBytes, source),
      captured,
    );
  }
  if (source.kind === "seohae-merged") {
    if (secondaryBytes == null) {
      throw new Error(`${source.slug}: MOLIT secondaryBytes required for seohae-merged`);
    }
    const parsed = parseSeohaeMerged(fileBytes, secondaryBytes, source);
    const rawSha256 = sha256(Buffer.concat([
      Buffer.from(fileBytes),
      Buffer.from("\n"),
      Buffer.from(secondaryBytes),
    ]));
    const edges = materializeEdges(parsed.undirected);
    const scope = buildScope(parsed.undirected);
    return {
      lineId: source.lineId,
      slug: source.slug,
      datasetId: source.datasetId,
      detailUrl: source.detailUrl,
      endpoint: source.downloadUrl,
      branchNames: parsed.branchNames,
      branchSequences: parsed.branchSequences,
      stationCount: scope.length,
      edgeCount: edges.length,
      scope,
      edges,
      scopeSha256: sha256(JSON.stringify(scope)),
      edgesSha256: sha256(JSON.stringify(edges)),
      rawSha256,
      contentSha256: sha256(JSON.stringify({ scope, edges })),
      capturedAt: captured.toISOString(),
    };
  }
  return lineSnapshotFromUndirected(
    source,
    fileBytes,
    parseGenericCapitalDistanceCsv(fileBytes, source),
    captured,
  );
}

export async function collectCapitalRouteTopology({
  root = path.resolve(import.meta.dirname, "../.."),
  fetchImpl = fetch,
  now = new Date(),
  useLocalFiles = true,
  sources = LINE_SOURCES,
} = {}) {
  const captured = validDate(now, "now");
  const lines = [];
  for (const source of sources) {
    const bytes = useLocalFiles
      ? await readFile(path.resolve(root, source.localCsv))
      : await downloadBytes(fetchImpl, source);
    let secondaryBytes = null;
    if (source.kind === "seohae-merged") {
      if (typeof source.localMolitCsv !== "string" || source.localMolitCsv.length === 0) {
        throw new Error(`${source.slug}: localMolitCsv required`);
      }
      secondaryBytes = await readFile(path.resolve(root, source.localMolitCsv));
    }
    lines.push(parseLineSource(source, bytes, { capturedAt: captured, secondaryBytes }));
  }
  lines.sort((left, right) => codepointCompare(left.lineId, right.lineId));
  const topologyGaps = [...TOPOLOGY_GAPS];
  const payload = {
    lines: lines.map(({ lineId, edgeCount, stationCount, contentSha256, rawSha256, datasetId }) => ({
      lineId,
      edgeCount,
      stationCount,
      contentSha256,
      rawSha256,
      datasetId,
    })),
    topologyGaps,
  };
  return {
    schemaVersion: 1,
    artifactKind: ARTIFACT_KIND,
    sourceId: SOURCE_ID,
    official: true,
    fixture: false,
    capturedAt: captured.toISOString(),
    freshUntil: new Date(captured.getTime() + FRESHNESS_MILLIS).toISOString(),
    credentialRequired: false,
    credentialRedacted: true,
    capitalMapLineIds: [...CAPITAL_MAP_LINE_IDS],
    fieldsProvided: [
      "network_edges",
      "distance_meters",
      "line",
      "station_name",
      "branch_name",
    ],
    license: {
      type: "KOGL-1",
      attribution: "국가철도공단, 국토교통부(MOLIT 도시철도 전체노선), 공공누리 제1유형(출처표시)",
      redistributionAllowed: true,
      evidenceUrl: "https://www.data.go.kr/",
    },
    lineCount: lines.length,
    totalEdgeCount: lines.reduce((sum, line) => sum + line.edgeCount, 0),
    topologyGaps,
    lines,
    contentSha256: sha256(JSON.stringify(payload)),
    admission: {
      status: "SNAPSHOT",
      issue: null,
      sourceId: SOURCE_ID,
      contentSha256: sha256(JSON.stringify(payload)),
      lineCount: lines.length,
      totalEdgeCount: lines.reduce((sum, line) => sum + line.edgeCount, 0),
      gapLineIds: topologyGaps.map(({ lineId }) => lineId),
    },
    // Keep line1 identity fields for thin re-export consumers.
    line1: {
      artifactKind: LINE1_ARTIFACT_KIND,
      sourceId: LINE1_SOURCE_ID,
      datasetId: LINE1_DATASET_ID,
      detailUrl: LINE1_DETAIL_URL,
      endpoint: LINE1_DOWNLOAD_URL,
      lineId: LINE1_LINE_ID,
    },
  };
}

async function downloadBytes(fetchImpl, source) {
  const response = await fetchImpl(source.downloadUrl, {
    headers: {
      "User-Agent": "easysubway-datapack-collector/1.0",
      Referer: source.detailUrl,
    },
  });
  if (!response.ok) throw new Error(`${source.slug} CSV HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function validDate(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a valid date`);
  return date;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

async function main() {
  const root = path.resolve(import.meta.dirname, "../..");
  const output = option(
    "--output",
    path.join(root, "tools/datapack/sources/capital-route-topology-20260724.json"),
  );
  const capturedAt = option("--captured-at", "2026-07-24T08:20:00.000Z");
  const download = process.argv.includes("--download");
  const snapshot = await collectCapitalRouteTopology({
    root,
    now: new Date(capturedAt),
    useLocalFiles: !download,
  });
  await writeFile(output, `${JSON.stringify(snapshot)}\n`);
  process.stdout.write(
    `capital route topology snapshot ready: lines=${snapshot.lineCount} `
    + `edges=${snapshot.totalEdgeCount} gaps=${snapshot.topologyGaps.length} path=${output}\n`,
  );
  for (const line of snapshot.lines) {
    process.stdout.write(`  ${line.lineId} edges=${line.edgeCount} stations=${line.stationCount}\n`);
  }
  for (const gap of snapshot.topologyGaps) {
    process.stdout.write(`  GAP ${gap.lineId} ${gap.nameKo}: ${gap.reason}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
