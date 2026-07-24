#!/usr/bin/env node
/**
 * 국가철도공단 수도권1호선 역간거리(FILE) → capital line-1 topology snapshot.
 * 동일 선명(경인/경부/서동탄/광명) 내 연속 행이 공식 인접 edge다.
 * 운영기관이 바뀌는 경계(종착↔청량리 목록)는 이어붙이지 않고,
 * 코레일 회기→남영 건너뛰기와 서울교통공사 지하 구간을 공식 스플라이스로 복원한다.
 *
 * 수도권 전 노선은 collect-capital-route-topology.mjs 가 이 모듈의 line-1 파서를 재사용한다.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { codepointCompare } from "../lib/codepoint-compare.mjs";

export const SOURCE_ID = "capital-line1-route-topology";
export const DATASET_ID = "15041460";
export const DETAIL_URL = `https://www.data.go.kr/data/${DATASET_ID}/fileData.do`;
export const DOWNLOAD_URL =
  "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003521015&fileDetailSn=1&insertDataPrcus=N";
export const LINE_ID = "line-472a81add377";
export const ARTIFACT_KIND = "capital-line1-route-topology-snapshot";
export const EXPECTED_BRANCHES = Object.freeze([
  "1호선(경인선)",
  "1호선(경부선)",
  "1호선(서동탄선)",
  "1호선(광명선)",
]);
const FRESHNESS_MILLIS = 24 * 60 * 60 * 1_000;
const HEADER = Object.freeze(["철도운영기관명", "선명", "역명", "역간거리", "후행역간거리"]);

export function decodeOfficialCsv(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new Error("official CSV bytes are required");
  }
  const buffer = Buffer.from(bytes);
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString("utf8");
  }
  const utf8 = buffer.toString("utf8");
  return utf8.includes("�") ? new TextDecoder("euc-kr").decode(buffer) : utf8;
}

export function normalizeStationName(name) {
  return String(name).normalize("NFKC").replace(/\([^)]*\)/gu, "").trim();
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length < 2) throw new Error("capital line-1 CSV is empty");
  const rows = lines.map((line) => line.split(","));
  const [header, ...body] = rows;
  if (JSON.stringify(header) !== JSON.stringify(HEADER)) {
    throw new Error(`capital line-1 CSV header mismatch: ${header.join(",")}`);
  }
  for (const [index, row] of body.entries()) {
    if (row.length !== HEADER.length) {
      throw new Error(`CSV column count mismatch at row ${index + 2}: expected ${HEADER.length}, got ${row.length}`);
    }
  }
  return body.map((cols) => ({
    operatorName: cols[0].trim(),
    branchName: cols[1].trim(),
    stationName: cols[2].trim(),
    distanceKilometers: parseOptionalKilometers(cols[3]),
    trailingDistanceKilometers: parseOptionalKilometers(cols[4]),
  }));
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

function compareBranch(left, right) {
  return EXPECTED_BRANCHES.indexOf(left) - EXPECTED_BRANCHES.indexOf(right)
    || codepointCompare(left, right);
}

function operatorRuns(rows) {
  const runs = [];
  let current = [];
  for (const row of rows) {
    if (current.length > 0 && current[0].operatorName !== row.operatorName) {
      runs.push(current);
      current = [];
    }
    current.push(row);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

function edgeKey(fromName, toName) {
  return [fromName, toName].sort(codepointCompare).join("\u0000");
}

/**
 * 공식 CSV bytes → topology snapshot.
 * durationSeconds는 원문에 없으므로 0으로 둔다(거리만 공식값).
 */
export function parseCapitalLine1RouteTopology(csvBytes, { capturedAt = new Date() } = {}) {
  const captured = validDate(capturedAt, "capturedAt");
  const rows = parseCsv(decodeOfficialCsv(csvBytes));
  const branches = [...new Set(rows.map(({ branchName }) => branchName))].sort(compareBranch);
  if (JSON.stringify(branches) !== JSON.stringify([...EXPECTED_BRANCHES])) {
    throw new Error(`capital line-1 branch scope mismatch: ${branches.join(",") || "none"}`);
  }

  /** @type {Map<string, {fromStationName:string,toStationName:string,distanceMeters:number,branchNames:Set<string>}>} */
  const undirected = new Map();
  const branchSequences = [];

  for (const branchName of EXPECTED_BRANCHES) {
    const sequence = rows.filter((row) => row.branchName === branchName);
    if (sequence.length < 2) throw new Error(`capital line-1 branch too short: ${branchName}`);
    const runs = operatorRuns(sequence);
    const korail = runs.find((run) => run[0].operatorName === "코레일") ?? null;
    const seoul = runs.find((run) => run[0].operatorName === "서울교통공사") ?? null;
    branchSequences.push({
      branchName,
      stationNames: sequence.map(({ stationName }) => stationName),
      operatorRunCount: runs.length,
    });

    for (const run of runs) {
      for (let index = 1; index < run.length; index += 1) {
        const from = run[index - 1];
        const to = run[index];
        const fromName = normalizeStationName(from.stationName);
        const toName = normalizeStationName(to.stationName);
        // 코레일 목록의 회기→남영은 지하 구간을 건너뛴 표기이므로 스플라이스 대상으로 제외한다.
        if (fromName === "회기" && toName === "남영" && seoul != null) continue;
        if (to.distanceKilometers == null || to.distanceKilometers <= 0) continue;
        upsertUndirected(undirected, fromName, toName, kilometersToMeters(to.distanceKilometers), branchName);
      }
    }

    if (korail != null && seoul != null) {
      const hoegi = korail.find((row) => normalizeStationName(row.stationName) === "회기");
      const cheongnyangni = seoul.find((row) => normalizeStationName(row.stationName) === "청량리");
      const seoulStation = seoul.find((row) => normalizeStationName(row.stationName) === "서울역");
      if (hoegi == null || cheongnyangni == null || seoulStation == null) {
        throw new Error(`capital line-1 underground splice stations missing: ${branchName}`);
      }
      const hoegiToCheong = hoegi.trailingDistanceKilometers != null && hoegi.trailingDistanceKilometers > 0
        ? kilometersToMeters(hoegi.trailingDistanceKilometers)
        : 0;
      const seoulToNamyeong = seoulStation.trailingDistanceKilometers != null
        && seoulStation.trailingDistanceKilometers > 0
        ? kilometersToMeters(seoulStation.trailingDistanceKilometers)
        : 0;
      upsertUndirected(undirected, "회기", "청량리", hoegiToCheong, branchName);
      upsertUndirected(undirected, "서울역", "남영", seoulToNamyeong, branchName);
    }
  }

  const stationNames = [...new Set(
    [...undirected.values()].flatMap(({ fromStationName, toStationName }) => [fromStationName, toStationName]),
  )].sort(codepointCompare);
  const scope = stationNames.map((stationName, index) => ({
    stationName,
    sequence: index + 1,
  }));

  const edges = [];
  for (const edge of [...undirected.values()]
    .sort((left, right) => codepointCompare(left.fromStationName, right.fromStationName)
      || codepointCompare(left.toStationName, right.toStationName))) {
    const branchNames = [...edge.branchNames].sort(compareBranch);
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

  assertAnyangContract(edges);

  const scopeSha256 = sha256(JSON.stringify(scope));
  const edgesSha256 = sha256(JSON.stringify(edges));
  const rawSha256 = sha256(Buffer.from(csvBytes));
  return {
    schemaVersion: 1,
    artifactKind: ARTIFACT_KIND,
    sourceId: SOURCE_ID,
    official: true,
    fixture: false,
    detailUrl: DETAIL_URL,
    endpoint: DOWNLOAD_URL,
    datasetId: DATASET_ID,
    lineId: LINE_ID,
    capturedAt: captured.toISOString(),
    freshUntil: new Date(captured.getTime() + FRESHNESS_MILLIS).toISOString(),
    credentialRequired: false,
    credentialRedacted: true,
    branchNames: [...EXPECTED_BRANCHES],
    branchSequences,
    stationCount: scope.length,
    edgeCount: edges.length,
    fieldsProvided: [
      "network_edges",
      "distance_meters",
      "line",
      "station_name",
      "branch_name",
    ],
    license: {
      type: "KOGL-1",
      attribution: "국가철도공단, 공공누리 제1유형(출처표시)",
      redistributionAllowed: true,
      evidenceUrl: DETAIL_URL,
    },
    scope,
    edges,
    scopeSha256,
    edgesSha256,
    rawSha256,
    contentSha256: sha256(JSON.stringify({ scope, edges })),
    // admission 훅: 전체 production inventory 연동 전에 스냅샷 identity만 고정한다.
    admission: {
      status: "SNAPSHOT",
      issue: null,
      sourceId: SOURCE_ID,
      contentSha256: sha256(JSON.stringify({ scope, edges })),
      lineId: LINE_ID,
      edgeCount: edges.length,
    },
  };
}

function upsertUndirected(map, fromStationName, toStationName, distanceMeters, branchName) {
  if (fromStationName === toStationName) {
    throw new Error(`capital line-1 self edge: ${fromStationName}`);
  }
  if (!Number.isInteger(distanceMeters) || distanceMeters < 0) {
    throw new Error(`capital line-1 distance invalid: ${fromStationName}-${toStationName}`);
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
    throw new Error(
      `capital line-1 distance conflict: ${fromStationName}-${toStationName} `
      + `${existing.distanceMeters} vs ${distanceMeters}`,
    );
  }
  if (existing.distanceMeters === 0 && distanceMeters > 0) {
    existing.distanceMeters = distanceMeters;
  }
  existing.branchNames.add(branchName);
}

function assertAnyangContract(edges) {
  const neighbors = new Set();
  for (const edge of edges) {
    if (edge.fromStationName === "안양") neighbors.add(edge.toStationName);
  }
  const expected = ["관악", "명학"];
  if (neighbors.size !== 2 || expected.some((name) => !neighbors.has(name)) || neighbors.has("소사")) {
    throw new Error(`capital line-1 Anyang neighbor contract failed: ${[...neighbors].join(",") || "none"}`);
  }
}

export async function collectCapitalLine1RouteTopology({
  csvBytes = null,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  const bytes = csvBytes == null
    ? await downloadOfficialCsv(fetchImpl)
    : Buffer.from(csvBytes);
  return parseCapitalLine1RouteTopology(bytes, { capturedAt: now });
}

async function downloadOfficialCsv(fetchImpl) {
  const response = await fetchImpl(DOWNLOAD_URL, {
    headers: {
      "User-Agent": "easysubway-datapack-collector/1.0",
      Referer: DETAIL_URL,
    },
  });
  if (!response.ok) {
    throw new Error(`capital line-1 CSV HTTP ${response.status}`);
  }
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
  const csvPath = option("--csv");
  const output = option(
    "--output",
    path.join(root, "tools/datapack/sources/capital-line1-route-topology-20260724.json"),
  );
  const capturedAt = option("--captured-at", "2026-07-24T07:42:32.000Z");
  const csvBytes = csvPath == null ? null : await readFile(path.resolve(csvPath));
  const snapshot = await collectCapitalLine1RouteTopology({
    csvBytes,
    now: new Date(capturedAt),
  });
  await writeFile(output, `${JSON.stringify(snapshot)}\n`);
  process.stdout.write(
    `capital line-1 topology snapshot ready: stations=${snapshot.stationCount} `
    + `edges=${snapshot.edgeCount} path=${output}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
