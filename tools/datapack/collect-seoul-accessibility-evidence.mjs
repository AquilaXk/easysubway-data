#!/usr/bin/env node
import { constants as fileSystemConstants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PILOT_STATIONS = ["상록수", "사당"];
const PILOT_LINE_NAME = "4호선";
const DEFAULT_ENDPOINT = "https://apis.data.go.kr/B553766/wksn/getWksnElvtr";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const INVALID_RESPONSE = "Seoul accessibility API response invalid";
const INVALID_OUTPUT_PATH = "output path must stay within allowed root";
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// 공식 oprtngSitu 코드(서울교통공사 wksnElvtr): M 사용가능 / D 삭제 / S 보수중 / T 중지 / I 점검중 / B 공사중.
// M만 실측 가동, S/T/I/B는 실측 비가동(검증된 비가용), D는 폐기 행이므로 증거에서 제외한다.
const OPERATION_SITUATION_STATES = new Map([
  ["M", { operational: true, situationCode: "M", situation: "사용가능" }],
  ["S", { operational: false, situationCode: "S", situation: "보수중" }],
  ["T", { operational: false, situationCode: "T", situation: "중지" }],
  ["I", { operational: false, situationCode: "I", situation: "점검중" }],
  ["B", { operational: false, situationCode: "B", situation: "공사중" }],
]);
const REMOVED_OPERATION_SITUATION = "D";

export function normalizeAccessibilityRows(rows) {
  if (!Array.isArray(rows)) {
    throw new Error(INVALID_RESPONSE);
  }
  const normalized = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(INVALID_RESPONSE);
    }
    const { lineNm, stnNm, oprtngSitu, dtlPstn } = row;
    if (
      typeof stnNm !== "string" ||
      stnNm.trim() === "" ||
      typeof lineNm !== "string" ||
      lineNm.trim() === "" ||
      typeof dtlPstn !== "string" ||
      dtlPstn.trim() === "" ||
      typeof oprtngSitu !== "string"
    ) {
      throw new Error(INVALID_RESPONSE);
    }
    if (oprtngSitu === REMOVED_OPERATION_SITUATION) {
      continue;
    }
    const state = OPERATION_SITUATION_STATES.get(oprtngSitu);
    if (!state) {
      throw new Error(INVALID_RESPONSE);
    }
    normalized.push({
      stationName: stnNm,
      lineName: lineNm,
      operational: state.operational,
      situationCode: state.situationCode,
      situation: state.situation,
      pathDescription: dtlPstn,
    });
  }
  return normalized;
}

export function buildAccessibilitySnapshot(rows, retrievedAt) {
  if (
    !Array.isArray(rows) ||
    rows.some(
      (row) =>
        !row ||
        typeof row.stationName !== "string" ||
        row.stationName.trim() === "" ||
        typeof row.lineName !== "string" ||
        row.lineName.trim() === "" ||
        typeof row.operational !== "boolean" ||
        typeof row.situationCode !== "string" ||
        !OPERATION_SITUATION_STATES.has(row.situationCode) ||
        typeof row.situation !== "string" ||
        row.situation.trim() === "" ||
        typeof row.pathDescription !== "string" ||
        row.pathDescription.trim() === "",
    )
  ) {
    throw new Error(INVALID_RESPONSE);
  }
  const stations = PILOT_STATIONS.map((stationName) => ({
    stationName,
    lineName: PILOT_LINE_NAME,
    facilities: rows
      .filter((row) => row.stationName === stationName && row.lineName === PILOT_LINE_NAME)
      .map(({ operational, situationCode, situation, pathDescription }) => ({
        operational,
        situationCode,
        situation,
        pathDescription,
      })),
  }));
  const missing = stations.find(({ facilities }) => facilities.length === 0);
  if (missing) {
    throw new Error(`accessibility evidence missing for ${missing.stationName}`);
  }
  return { sourceId: "seoul-metro-accessibility", retrievedAt, stations };
}

export async function collectSeoulAccessibility({
  endpoint,
  serviceKey,
  fetchImpl = fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  const endpointUrl = new URL(endpoint);
  if (endpointUrl.protocol !== "https:") {
    throw new Error("HTTPS endpoint is required");
  }
  const collected = [];
  for (const stationName of PILOT_STATIONS) {
    const url = new URL(endpointUrl);
    url.searchParams.set("serviceKey", serviceKey);
    url.searchParams.set("pageNo", "1");
    url.searchParams.set("numOfRows", "1000");
    url.searchParams.set("dataType", "JSON");
    url.searchParams.set("lineNm", PILOT_LINE_NAME);
    url.searchParams.set("stnNm", stationName);
    let response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
    } catch {
      throw new Error("Seoul accessibility API request failed");
    }
    if (!response.ok) {
      throw new Error(`Seoul accessibility API HTTP ${response.status}`);
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(INVALID_RESPONSE);
    }
    if (payload?.response?.header?.resultCode !== "00") {
      throw new Error(INVALID_RESPONSE);
    }
    const rows = payload.response?.body?.items?.item;
    if (!Array.isArray(rows)) {
      throw new Error(INVALID_RESPONSE);
    }
    const normalizedRows = normalizeAccessibilityRows(rows);
    if (
      normalizedRows.some(
        (row) => row.stationName !== stationName || row.lineName !== PILOT_LINE_NAME,
      )
    ) {
      throw new Error(INVALID_RESPONSE);
    }
    collected.push(...normalizedRows);
  }
  return collected;
}

export async function writeSeoulAccessibilityEvidence({
  endpoint,
  serviceKey,
  output,
  outputRoot = REPOSITORY_ROOT,
  fetchImpl = fetch,
  retrievedAt = new Date().toISOString(),
}) {
  const { outputPath, canonicalRoot } = await validatedOutputPath(output, outputRoot);
  const rows = await collectSeoulAccessibility({ endpoint, serviceKey, fetchImpl });
  const snapshot = buildAccessibilitySnapshot(rows, retrievedAt);
  await mkdir(dirname(outputPath), { recursive: true });
  const canonicalParent = await realpath(dirname(outputPath));
  if (!isPathWithin(canonicalRoot, canonicalParent)) {
    throw new Error(INVALID_OUTPUT_PATH);
  }
  await writeOutputFileNoFollow(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  return snapshot;
}

async function validatedOutputPath(output, outputRoot) {
  if (typeof output !== "string" || output.trim() === "") {
    throw new Error(INVALID_OUTPUT_PATH);
  }
  const resolvedRoot = resolve(outputRoot);
  const outputPath = resolve(resolvedRoot, output);
  if (!isPathWithin(resolvedRoot, outputPath)) {
    throw new Error(INVALID_OUTPUT_PATH);
  }
  const canonicalRoot = await realpath(resolvedRoot);
  const canonicalAncestor = await nearestExistingCanonicalPath(dirname(outputPath));
  if (!isPathWithin(canonicalRoot, canonicalAncestor)) {
    throw new Error(INVALID_OUTPUT_PATH);
  }
  try {
    if ((await lstat(outputPath)).isSymbolicLink()) {
      throw new Error(INVALID_OUTPUT_PATH);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  return { outputPath, canonicalRoot };
}

async function writeOutputFileNoFollow(outputPath, contents) {
  if (!Number.isInteger(fileSystemConstants.O_NOFOLLOW)) {
    throw new Error(INVALID_OUTPUT_PATH);
  }
  let outputFile;
  try {
    outputFile = await open(
      outputPath,
      fileSystemConstants.O_WRONLY |
        fileSystemConstants.O_CREAT |
        fileSystemConstants.O_TRUNC |
        fileSystemConstants.O_NOFOLLOW,
      0o600,
    );
    await outputFile.writeFile(contents);
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new Error(INVALID_OUTPUT_PATH);
    }
    throw error;
  } finally {
    await outputFile?.close();
  }
}

async function nearestExistingCanonicalPath(candidate) {
  let current = candidate;
  while (true) {
    try {
      return await realpath(current);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) {
        throw new Error(INVALID_OUTPUT_PATH);
      }
      current = parent;
    }
  }
}

function isPathWithin(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== "--output") {
    throw new Error("usage: collect-seoul-accessibility-evidence.mjs --output <path>");
  }
  const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;
  if (!serviceKey) {
    throw new Error("DATA_GO_KR_SERVICE_KEY env is required");
  }
  await writeSeoulAccessibilityEvidence({ endpoint: DEFAULT_ENDPOINT, serviceKey, output: process.argv[3] });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "accessibility collection failed"}\n`);
    process.exitCode = 1;
  });
}
