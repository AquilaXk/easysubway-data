#!/usr/bin/env node
import { constants as fileSystemConstants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ENDPOINT = "https://apis.data.go.kr/B553766/wksn/getWksnElvtr";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const INVALID_RESPONSE = "Seoul accessibility API response invalid";
const INVALID_OUTPUT_PATH = "output path must stay within allowed root";
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE_SNAPSHOT_ROOT = resolve(REPOSITORY_ROOT, "tools/datapack/sources");

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
      throw new Error(`${INVALID_RESPONSE}: row`);
    }
    const { lineNm, stnNm, oprtngSitu, dtlPstn } = row;
    for (const [field, value] of Object.entries({ lineNm, stnNm, dtlPstn })) {
      if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`${INVALID_RESPONSE}: requiredField:${field}`);
      }
    }
    if (oprtngSitu !== undefined && oprtngSitu !== null && typeof oprtngSitu !== "string") {
      throw new Error(`${INVALID_RESPONSE}: requiredField:oprtngSitu`);
    }
    const operationCode = oprtngSitu?.trim() ?? "";
    if (operationCode === REMOVED_OPERATION_SITUATION) {
      continue;
    }
    const state = !operationCode
      ? { operational: null, situationCode: null, situation: "PROVIDER_STATUS_MISSING" }
      : OPERATION_SITUATION_STATES.get(operationCode);
    if (!state) {
      throw new Error(`${INVALID_RESPONSE}: operationState`);
    }
    normalized.push({
      stationName: stnNm.trim(),
      lineName: lineNm.trim(),
      operational: state.operational,
      situationCode: state.situationCode,
      situation: state.situation,
      pathDescription: dtlPstn.trim(),
    });
  }
  return normalized;
}

export function buildAccessibilitySnapshot(rows, retrievedAt, { rawRowCount, rawSha256, previousSnapshot = null }) {
  if (
    !Array.isArray(rows) ||
    rows.some(
      (row) =>
        !row ||
        typeof row.stationName !== "string" ||
        row.stationName.trim() === "" ||
        typeof row.lineName !== "string" ||
        row.lineName.trim() === "" ||
        !(
          (typeof row.operational === "boolean" &&
            typeof row.situationCode === "string" &&
            OPERATION_SITUATION_STATES.has(row.situationCode)) ||
          (row.operational === null &&
            row.situationCode === null &&
            row.situation === "PROVIDER_STATUS_MISSING")
        ) ||
        typeof row.situation !== "string" ||
        row.situation.trim() === "" ||
        typeof row.pathDescription !== "string" ||
        row.pathDescription.trim() === "",
    )
  ) {
    throw new Error(INVALID_RESPONSE);
  }
  if (!Number.isSafeInteger(rawRowCount) || rawRowCount < rows.length || !/^[0-9a-f]{64}$/.test(rawSha256 ?? "")) {
    throw new Error(`${INVALID_RESPONSE}: rawIdentity`);
  }
  const retrievedMillis = Date.parse(retrievedAt);
  const snapshotId = `seoul-metro-accessibility-${typeof retrievedAt === "string" ? retrievedAt.replaceAll(/[-:.]/g, "") : ""}`;
  if (typeof retrievedAt !== "string"
    || !Number.isFinite(retrievedMillis)
    || new Date(retrievedMillis).toISOString() !== retrievedAt) {
    throw new Error(`${INVALID_RESPONSE}: snapshotIdentity`);
  }
  let previousSnapshotId = null;
  if (previousSnapshot !== null) {
    const previousMillis = Date.parse(previousSnapshot?.retrievedAt);
    const previousFullId = `seoul-metro-accessibility-${typeof previousSnapshot?.retrievedAt === "string"
      ? previousSnapshot.retrievedAt.replaceAll(/[-:.]/g, "") : ""}`;
    const previousLegacyId = `seoul-metro-accessibility-${typeof previousSnapshot?.retrievedAt === "string"
      ? previousSnapshot.retrievedAt.slice(0, 10).replaceAll("-", "") : ""}`;
    if (previousSnapshot?.schemaVersion !== 1
      || previousSnapshot?.artifactKind !== "seoul-accessibility-snapshot"
      || previousSnapshot?.sourceId !== "seoul-metro-accessibility"
      || !Number.isFinite(previousMillis)
      || new Date(previousMillis).toISOString() !== previousSnapshot.retrievedAt
      || ![previousFullId, previousLegacyId].includes(previousSnapshot.snapshotId)
      || previousMillis >= retrievedMillis) {
      throw new Error(`${INVALID_RESPONSE}: snapshotIdentity`);
    }
    previousSnapshotId = previousSnapshot.snapshotId;
  }
  const stationsByIdentity = new Map();
  for (const row of rows) {
    const key = `${row.lineName}\0${row.stationName}`;
    const station = stationsByIdentity.get(key) ?? {
      stationName: row.stationName,
      lineName: row.lineName,
      facilities: [],
    };
    station.facilities.push({
      operational: row.operational,
      situationCode: row.situationCode,
      situation: row.situation,
      pathDescription: row.pathDescription,
    });
    stationsByIdentity.set(key, station);
  }
  const stations = [...stationsByIdentity.values()].sort((left, right) => (
    compare(`${left.lineName}\0${left.stationName}`, `${right.lineName}\0${right.stationName}`)
  ));
  for (const station of stations) {
    station.facilities.sort((left, right) => compare(JSON.stringify(left), JSON.stringify(right)));
  }
  const contentSha256 = hash(stations);
  return {
    schemaVersion: 1,
    artifactKind: "seoul-accessibility-snapshot",
    sourceId: "seoul-metro-accessibility",
    snapshotId,
    previousSnapshotId,
    retrievedAt,
    capturedAt: retrievedAt,
    observedAt: retrievedAt,
    freshUntil: new Date(retrievedMillis + 86_400_000).toISOString(),
    credentialRedacted: true,
    absenceEvidenceMode: "EXHAUSTIVE_LIST",
    rowCount: rawRowCount,
    normalizedRowCount: rows.length,
    rawSha256,
    contentSha256,
    schemaFingerprint: hash(["dtlPstn", "lineNm", "oprtngSitu", "stnNm"]),
    stations,
  };
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
  const rawPages = [];
  const rowIdentities = new Set();
  let receivedCount = 0;
  let pageNo = 1;
  let totalCount;
  while (totalCount === undefined || receivedCount < totalCount) {
    const url = new URL(endpointUrl);
    url.searchParams.set("serviceKey", serviceKey);
    url.searchParams.set("pageNo", String(pageNo));
    url.searchParams.set("numOfRows", "1000");
    url.searchParams.set("dataType", "JSON");
    let response;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await fetchImpl(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
      } catch {
        if (attempt === 0) continue;
        throw new Error("Seoul accessibility API request failed");
      }
      if (response.ok || response.status < 500 || attempt === 1) break;
    }
    if (!response.ok) {
      throw new Error(`Seoul accessibility API HTTP ${response.status}`);
    }
    let payload;
    let raw;
    try {
      raw = await response.text();
      payload = JSON.parse(raw);
    } catch {
      throw new Error(INVALID_RESPONSE);
    }
    if (payload?.response?.header?.resultCode !== "00") {
      throw new Error(`${INVALID_RESPONSE}: envelope`);
    }
    const body = payload.response?.body;
    const rows = body?.items?.item;
    if (!Array.isArray(rows)) {
      throw new Error(`${INVALID_RESPONSE}: items`);
    }
    const pageTotal = Number(body.totalCount);
    if (!Number.isSafeInteger(pageTotal) || pageTotal < 0 || (totalCount !== undefined && pageTotal !== totalCount)) {
      throw new Error(`${INVALID_RESPONSE}: totalCount`);
    }
    totalCount = pageTotal;
    for (const row of rows) {
      const rowIdentity = hash(row);
      if (rowIdentities.has(rowIdentity)) throw new Error(`${INVALID_RESPONSE}: pagination`);
      rowIdentities.add(rowIdentity);
    }
    rawPages.push({ pageNo, totalCount: pageTotal, rawSha256: hashText(raw) });
    const normalizedRows = normalizeAccessibilityRows(rows);
    collected.push(...normalizedRows);
    receivedCount += rows.length;
    if (receivedCount > totalCount || (receivedCount < totalCount && rows.length === 0)) {
      throw new Error(`${INVALID_RESPONSE}: pagination`);
    }
    pageNo += 1;
  }
  if (totalCount === 0 || collected.length === 0) {
    throw new Error(`${INVALID_RESPONSE}: emptyExhaustiveList`);
  }
  return { rows: collected, rawRowCount: totalCount, rawSha256: hash(rawPages) };
}

export async function writeSeoulAccessibilityEvidence({
  endpoint,
  serviceKey,
  output,
  outputRoot = REPOSITORY_ROOT,
  fetchImpl = fetch,
  retrievedAt = new Date().toISOString(),
  previousSnapshot = null,
}) {
  const { outputPath: requestedOutputPath } = await validatedOutputPath(output, outputRoot);
  const collected = await collectSeoulAccessibility({ endpoint, serviceKey, fetchImpl });
  const snapshot = buildAccessibilitySnapshot(collected.rows, retrievedAt, { ...collected, previousSnapshot });
  const outputPath = extname(requestedOutputPath) === ".json"
    ? requestedOutputPath
    : join(requestedOutputPath, `${snapshot.snapshotId}.json`);
  if (extname(requestedOutputPath) === ".json"
    && basename(requestedOutputPath) !== `${snapshot.snapshotId}.json`) {
    throw new Error("output filename must match snapshot ID");
  }
  const { canonicalRoot } = await validatedOutputPath(outputPath, outputRoot);
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
        fileSystemConstants.O_EXCL |
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

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function main() {
  const previousSnapshotArgument = process.argv.length === 8
    && process.argv[6] === "--previous-snapshot";
  if (
    (process.argv.length !== 6 && !previousSnapshotArgument) ||
    process.argv[2] !== "--output" ||
    process.argv[4] !== "--output-root"
  ) {
    throw new Error(
      "usage: collect-seoul-accessibility-evidence.mjs --output <path-or-directory> --output-root <path> [--previous-snapshot <repository-relative-path>]",
    );
  }
  const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;
  if (!serviceKey) {
    throw new Error("DATA_GO_KR_SERVICE_KEY env is required");
  }
  let previousSnapshot = null;
  if (previousSnapshotArgument) {
    const canonicalSourceRoot = await realpath(SOURCE_SNAPSHOT_ROOT);
    const canonicalPreviousPath = await realpath(resolve(REPOSITORY_ROOT, process.argv[7]));
    if (!isPathWithin(canonicalSourceRoot, canonicalPreviousPath)) {
      throw new Error(`${INVALID_RESPONSE}: snapshotIdentity`);
    }
    previousSnapshot = JSON.parse(await readFile(canonicalPreviousPath, "utf8"));
  }
  await writeSeoulAccessibilityEvidence({
    endpoint: DEFAULT_ENDPOINT,
    serviceKey,
    output: process.argv[3],
    outputRoot: process.argv[5],
    previousSnapshot,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "accessibility collection failed"}\n`);
    process.exitCode = 1;
  });
}
