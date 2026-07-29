#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { codepointCompare } from "../lib/codepoint-compare.mjs";

export const KRIC_ACCESSIBILITY_OPERATIONS = Object.freeze([
  {
    sourceId: "kric-station-convenience-standard",
    endpoint: "https://openapi.kric.go.kr/openapi/handicapped/stationCnvFacl",
    responseFields: ["dtlLoc", "grndDvCd", "gubun", "imgPath", "mlFmlDvCd", "stinFlor", "trfcWeakDvCd"],
    tupleIdentityFields: [],
  },
]);

// Provider roster의 개명·오기만 exact tuple로 결속한다. 이름 유사도 fallback은 두지 않는다.
export const KRIC_STATION_TUPLE_MAPPINGS = Object.freeze([
  { stationId: "station-47b514f305d8", lineId: "seoul-4", railOprIsttCd: "KR", lnCd: "4", stinCd: "454" },
  { stationId: "station-47b514f305d8", lineId: "line-558d0bd8312d", railOprIsttCd: "KR", lnCd: "K1", stinCd: "K256" },
  { stationId: "station-9d261727e400", lineId: "line-828f04afc588", railOprIsttCd: "EV", lnCd: "E1", stinCd: "Y120" },
  { stationId: "station-b1a5f63faf69", lineId: "line-42b5805f3b5a", railOprIsttCd: "IC", lnCd: "I2", stinCd: "210" },
]);

export async function collectKricAccessibilitySnapshots({
  roster,
  operations = KRIC_ACCESSIBILITY_OPERATIONS,
  serviceKey,
  fetchImpl = fetch,
  now = new Date(),
  requestTimeoutMs = 30_000,
  requestIntervalMs = 0,
  delayImpl = delay,
} = {}) {
  if (typeof serviceKey !== "string" || serviceKey === "") throw new Error("KRIC_SERVICE_KEY is required");
  if (!Number.isInteger(requestIntervalMs) || requestIntervalMs < 0 || requestIntervalMs > 60_000) {
    throw new Error("KRIC request interval is invalid");
  }
  const tuples = validateRoster(roster);
  const capturedAt = now.toISOString();
  const freshUntil = new Date(now.getTime() + 86_400_000).toISOString();
  const snapshots = [];
  let requestCount = 0;
  const paceRequest = async () => {
    if (requestCount > 0 && requestIntervalMs > 0) await delayImpl(requestIntervalMs);
    requestCount += 1;
  };
  for (const operation of operations) {
    validateOperation(operation);
    const queries = [];
    const responsesByProviderTuple = new Map();
    for (const tuple of tuples) {
      const providerKey = [tuple.railOprIsttCd, tuple.lnCd, tuple.stinCd].join("\0");
      if (!responsesByProviderTuple.has(providerKey)) {
        responsesByProviderTuple.set(providerKey, await requestRows({
          operation, tuple, serviceKey, fetchImpl, requestTimeoutMs, paceRequest,
        }));
      }
      const { rows, rawResponseSha256 } = responsesByProviderTuple.get(providerKey);
      const providerRecordHash = hash(rows);
      queries.push({
        ...tuple,
        status: rows.length === 0 ? "ABSENT_EXPLICIT_ZERO" : "PRESENT",
        rawResponseSha256,
        providerRecordHash,
        rows,
      });
    }
    const contentSha256 = hash(queries.map(({ rawResponseSha256: _, ...query }) => query));
    const rawSha256 = hash(queries.map(({
      stationId, lineId, railOprIsttCd, lnCd, stinCd, rawResponseSha256,
    }) => ({ stationId, lineId, railOprIsttCd, lnCd, stinCd, rawResponseSha256 })));
    const timestamp = capturedAt.replaceAll(/[-:.]/g, "");
    snapshots.push({
      schemaVersion: 1,
      artifactKind: "kric-accessibility-snapshot",
      sourceId: operation.sourceId,
      snapshotId: `${operation.sourceId}-${timestamp}`,
      capturedAt,
      observedAt: capturedAt,
      freshUntil,
      credentialRedacted: true,
      absenceEvidenceMode: "EXHAUSTIVE_LIST",
      queryCount: queries.length,
      rowCount: queries.reduce((sum, query) => sum + query.rows.length, 0),
      rawSha256,
      contentSha256,
      schemaFingerprint: hash([...operation.responseFields].sort(compare)),
      queries,
    });
  }
  return snapshots;
}

export function buildKricAccessibilityRoster({ activeLineScopes, fixture, canonicalStationLines, routeRosters }) {
  if (!Array.isArray(fixture?.providerLineScopes) || !Array.isArray(canonicalStationLines)
    || !Array.isArray(routeRosters?.providerScopes) || !Array.isArray(routeRosters?.rosters)) {
    throw new Error("KRIC fixture, canonical station lines, provider scopes, and route rosters are required");
  }
  const stationLines = new Map();
  for (const membership of canonicalStationLines) {
    stationLines.set(`${membership.artifactId}\0${membership.stationId}\0${membership.lineId}`, membership);
  }
  const canonicalByLineAndName = new Map();
  const canonicalByLineAndCode = new Map();
  const canonicalByProviderTuple = new Map();
  for (const membership of stationLines.values()) {
    if (!Array.isArray(membership.names) || membership.names.length === 0) {
      throw new Error(`canonical station names missing: ${membership.stationId}`);
    }
    for (const name of membership.names) {
      const key = `${membership.lineId}\0${normalizeStationName(name)}`;
      const matches = canonicalByLineAndName.get(key) ?? [];
      if (!matches.some(({ artifactId, stationId }) => (
        artifactId === membership.artifactId && stationId === membership.stationId
      ))) matches.push(membership);
      canonicalByLineAndName.set(key, matches);
    }
    if (typeof membership.stationCode === "string" && membership.stationCode !== "") {
      const key = `${membership.lineId}\0${membership.stationCode}`;
      const matches = canonicalByLineAndCode.get(key) ?? [];
      matches.push(membership);
      canonicalByLineAndCode.set(key, matches);
    }
  }
  for (const mapping of KRIC_STATION_TUPLE_MAPPINGS) {
    const matches = [...stationLines.values()].filter(({ stationId, lineId }) => (
      stationId === mapping.stationId && lineId === mapping.lineId
    ));
    if (matches.length > 0) canonicalByProviderTuple.set(providerTupleKey(mapping), matches);
  }
  const rosterByRequest = new Map(routeRosters.rosters.map((roster) => [
    `${roster.mreaWideCd}\0${roster.lnCd}`,
    roster,
  ]));
  const tuples = [];
  const coveredMemberships = new Set();
  const scopedLineIds = new Set();
  const activeScopes = routeRosters.providerScopes;
  const expectedScopeKeys = uniqueActiveScopeKeys(activeLineScopes);
  const actualScopeKeys = uniqueActiveScopeKeys(activeScopes);
  if (expectedScopeKeys.length !== actualScopeKeys.length
    || expectedScopeKeys.some((key, index) => key !== actualScopeKeys[index])) {
    throw new Error("KRIC active provider scope set mismatch");
  }
  const fixtureScopeKeys = new Set(fixture.providerLineScopes.map((scope) => (
    `${scope.lineId}\0${scope.railOprIsttCd}\0${scope.lnCd}`
  )));
  for (const scope of activeScopes) {
    if (!fixtureScopeKeys.has(`${scope.lineId}\0${scope.railOprIsttCd}\0${scope.lnCd}`)) {
      throw new Error(`KRIC active provider scope missing from fixture: ${scope.lineId}/${scope.railOprIsttCd}`);
    }
    scopedLineIds.add(scope.lineId);
    const roster = rosterByRequest.get(`${scope.mreaWideCd}\0${scope.lnCd}`);
    if (!roster || roster.resultCode !== "00" || !Array.isArray(roster.stations)) {
      throw new Error(`KRIC route roster missing: ${scope.mreaWideCd}/${scope.lnCd}`);
    }
    for (const station of roster.stations.filter(({ railOprIsttCd }) => railOprIsttCd === scope.railOprIsttCd)) {
      const matches = [...new Map([
        ...(canonicalByLineAndName.get(`${scope.lineId}\0${normalizeStationName(station.stinNm)}`) ?? []),
        ...(canonicalByLineAndCode.get(`${scope.lineId}\0${station.stinCd}`) ?? []),
        ...(canonicalByProviderTuple.get(providerTupleKey({ ...station, lineId: scope.lineId })) ?? []),
      ].map((match) => [`${match.artifactId}\0${match.stationId}`, match])).values()];
      const matchesByArtifact = new Map();
      for (const match of matches) {
        const artifactMatches = matchesByArtifact.get(match.artifactId) ?? [];
        artifactMatches.push(match);
        matchesByArtifact.set(match.artifactId, artifactMatches);
      }
      if ([...matchesByArtifact.values()].some((artifactMatches) => artifactMatches.length > 1)) {
        throw new Error(
          `ambiguous canonical KRIC station join: ${scope.lineId}/${station.stinNm}/${matches.map(({ artifactId, stationId }) => `${artifactId}:${stationId}`).sort(compare).join(",")}`,
        );
      }
      if (matches.length === 0) continue;
      const canonicalMappings = matches.map(({ artifactId, stationId, lineId }) => ({
        artifactId,
        stationId,
        lineId,
      })).sort((left, right) => compare(
        `${left.artifactId}\0${left.stationId}\0${left.lineId}`,
        `${right.artifactId}\0${right.stationId}\0${right.lineId}`,
      ));
      for (const membership of matches) {
        coveredMemberships.add(`${membership.artifactId}\0${membership.stationId}\0${membership.lineId}`);
      }
      const mappingsByIdentity = new Map();
      for (const mapping of canonicalMappings) {
        const identity = `${mapping.stationId}\0${mapping.lineId}`;
        const identityMappings = mappingsByIdentity.get(identity) ?? [];
        identityMappings.push(mapping);
        mappingsByIdentity.set(identity, identityMappings);
      }
      for (const identityMappings of mappingsByIdentity.values()) {
        tuples.push({
          stationId: identityMappings[0].stationId,
          lineId: identityMappings[0].lineId,
          railOprIsttCd: station.railOprIsttCd,
          lnCd: station.lnCd,
          stinCd: station.stinCd,
          canonicalMappings: identityMappings,
        });
      }
    }
  }
  const uncovered = [...stationLines.values()]
    .filter(({ artifactId, stationId, lineId }) => scopedLineIds.has(lineId)
      && !coveredMemberships.has(`${artifactId}\0${stationId}\0${lineId}`))
    .map(({ artifactId, stationId, lineId }) => `${artifactId}|${stationId}|${lineId}`)
    .sort(compare);
  if (uncovered.length > 0) {
    throw new Error(`canonical KRIC station join missing: ${uncovered.join(",")}`);
  }
  return validateRoster(tuples);
}

export async function loadCanonicalStationLinesFromBundledIndex({ bundledIndex, bundledRoot }) {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "easysubway-kric-accessibility-roster-"));
  try {
    const memberships = new Map();
    for (const [index, pack] of (bundledIndex?.packs ?? []).entries()) {
      const sqliteBytes = gunzipSync(await readFile(path.resolve(bundledRoot, pack.asset)));
      if (hashBytes(sqliteBytes) !== pack.sqliteSha256) throw new Error(`${pack.id}:SQLITE_SHA256_MISMATCH`);
      const sqlitePath = path.join(temporaryDirectory, `${index}.sqlite`);
      await writeFile(sqlitePath, sqliteBytes);
      const database = new DatabaseSync(sqlitePath, { readOnly: true });
      try {
        for (const row of database.prepare(`
          SELECT stations.id AS station_id, stations.name_ko, station_lines.line_id,
                 station_lines.station_code
          FROM stations
          JOIN station_lines ON station_lines.station_id = stations.id
        `).all()) {
          const key = `${pack.id}\0${row.station_id}\0${row.line_id}`;
          const membership = memberships.get(key) ?? {
            artifactId: `bundled-${pack.id}`,
            stationId: row.station_id,
            lineId: row.line_id,
            stationCode: row.station_code,
            names: new Set(),
          };
          membership.names.add(row.name_ko);
          memberships.set(key, membership);
        }
      } finally {
        database.close();
      }
    }
    return [...memberships.values()].map((membership) => ({
      artifactId: membership.artifactId,
      stationId: membership.stationId,
      lineId: membership.lineId,
      stationCode: membership.stationCode,
      names: [...membership.names].sort(compare),
    })).sort((left, right) => compare(
      `${left.artifactId}\0${left.stationId}\0${left.lineId}`,
      `${right.artifactId}\0${right.stationId}\0${right.lineId}`,
    ));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function validateRoster(roster) {
  if (!Array.isArray(roster) || roster.length === 0) throw new Error("KRIC roster is required");
  const seen = new Set();
  return roster.map((tuple) => {
    for (const field of ["stationId", "lineId", "railOprIsttCd", "lnCd", "stinCd"]) {
      if (typeof tuple?.[field] !== "string" || tuple[field] === "") throw new Error(`KRIC roster ${field} is required`);
    }
    const key = tupleKey(tuple);
    if (seen.has(key)) throw new Error(`duplicate KRIC station tuple: ${key}`);
    seen.add(key);
    return { ...tuple };
  }).sort((left, right) => compare(tupleKey(left), tupleKey(right)));
}

function validateOperation(operation) {
  const endpoint = new URL(operation.endpoint);
  if (endpoint.origin !== "https://openapi.kric.go.kr" || !endpoint.pathname.startsWith("/openapi/")) {
    throw new Error(`invalid KRIC accessibility endpoint: ${operation.sourceId}`);
  }
  if (!Array.isArray(operation.responseFields) || operation.responseFields.length === 0) {
    throw new Error(`invalid KRIC accessibility response fields: ${operation.sourceId}`);
  }
  if (operation.tupleIdentityFields !== undefined && !Array.isArray(operation.tupleIdentityFields)) {
    throw new Error(`invalid KRIC accessibility tuple identity fields: ${operation.sourceId}`);
  }
}

async function requestRows({ operation, tuple, serviceKey, fetchImpl, requestTimeoutMs, paceRequest }) {
  const url = new URL(operation.endpoint);
  url.searchParams.set("serviceKey", serviceKey);
  url.searchParams.set("format", "json");
  for (const field of ["railOprIsttCd", "lnCd", "stinCd"]) url.searchParams.set(field, tuple[field]);
  let response;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await paceRequest();
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
    } catch {
      if (attempt === 0) continue;
      throw new Error(
        `KRIC accessibility request failed: ${operation.sourceId}/${tuple.railOprIsttCd}/${tuple.lnCd}/${tuple.stinCd}`,
      );
    }
    if (response.ok || response.status < 500 || attempt === 1) break;
  }
  if (!response?.ok) throw new Error(`KRIC accessibility HTTP ${response?.status ?? "unknown"}: ${operation.sourceId}`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`KRIC accessibility schema invalid: ${operation.sourceId}`);
  }
  const rawResponseSha256 = hash(payload);
  const resultCode = payload?.header?.resultCode;
  if (resultCode === "00" && Array.isArray(payload?.body)) {
    payload = payload.body;
  } else {
    const safeCode = /^[A-Za-z0-9._-]{1,32}$/.test(resultCode ?? "") ? resultCode : "UNKNOWN";
    const safeKeys = Object.keys(payload ?? {}).filter((key) => /^[A-Za-z0-9._-]{1,32}$/.test(key))
      .sort(codepointCompare).slice(0, 12);
    const safeBodyKeys = Object.keys(payload?.body ?? {}).filter((key) => /^[A-Za-z0-9._-]{1,32}$/.test(key))
      .sort(codepointCompare).slice(0, 12);
    throw new Error(`KRIC accessibility provider result invalid: ${operation.sourceId}/${safeCode}; keys=${safeKeys.join(",")}; bodyKeys=${safeBodyKeys.join(",")}`);
  }
  const tupleIdentityFields = operation.tupleIdentityFields ?? ["railOprIsttCd", "lnCd", "stinCd"];
  for (const row of payload) {
    if (!row || typeof row !== "object" || operation.responseFields.some((field) => !(field in row))
      || tupleIdentityFields.some((field) => row[field] !== tuple[field])) {
      throw new Error(`KRIC accessibility schema invalid: ${operation.sourceId}`);
    }
  }
  return {
    rows: payload.map((row) => Object.fromEntries(
      operation.responseFields.map((field) => [field, row[field]]),
    )),
    rawResponseSha256,
  };
}

function tupleKey(tuple) {
  return `${tuple.railOprIsttCd}\0${tuple.lnCd}\0${tuple.stinCd}\0${tuple.stationId}\0${tuple.lineId}`;
}

function providerTupleKey(tuple) {
  return `${tuple.lineId}\0${tuple.railOprIsttCd}\0${tuple.lnCd}\0${tuple.stinCd}`;
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function tableExists(database, table) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeStationName(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\([^)]*\)/g, "")
    .replace(/역$/u, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLocaleLowerCase("ko-KR");
}

function uniqueActiveScopeKeys(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) return [];
  const keys = scopes.map((scope) => ["regionId", "operatorId", "lineId"].map((field) => {
    if (typeof scope?.[field] !== "string" || scope[field] === "") {
      throw new Error("KRIC active provider scope set mismatch");
    }
    return scope[field];
  }).join("\0"));
  if (new Set(keys).size !== keys.length) throw new Error("KRIC active provider scope set mismatch");
  return keys.sort(compare);
}

async function main(argv) {
  const args = parseArgs(argv);
  const [bundledIndex, targets, fixture, routeRosters] = await Promise.all([
    readJson(args["bundled-index"]),
    readJson(args.targets),
    readJson(args.fixture),
    readJson(args["route-rosters"]),
  ]);
  const canonicalStationLines = await loadCanonicalStationLinesFromBundledIndex({
    bundledIndex,
    bundledRoot: path.resolve(path.dirname(args["bundled-index"]), "../.."),
  });
  const roster = buildKricAccessibilityRoster({
    activeLineScopes: targets.activeLineScopes,
    fixture,
    canonicalStationLines,
    routeRosters,
  });
  if (args["validate-roster-only"] === true) {
    process.stdout.write(`validated KRIC accessibility roster: tuples=${roster.length}\n`);
    return;
  }
  const snapshots = await collectKricAccessibilitySnapshots({
    roster,
    serviceKey: process.env.KRIC_SERVICE_KEY,
    requestIntervalMs: Number(args["request-interval-ms"] ?? 0),
  });
  await mkdir(args["output-root"], { recursive: true });
  for (const snapshot of snapshots) {
    await writeFile(
      path.join(args["output-root"], `${snapshot.snapshotId}.json`),
      `${JSON.stringify(snapshot, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  process.stdout.write(`sanitized KRIC accessibility snapshots ready: tuples=${roster.length} sources=${snapshots.length}\n`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length;) {
    if (argv[index] === "--validate-roster-only") {
      args["validate-roster-only"] = true;
      index += 1;
      continue;
    }
    if (!argv[index]?.startsWith("--") || argv[index + 1] === undefined) throw new Error("invalid arguments");
    args[argv[index].slice(2)] = argv[index + 1];
    index += 2;
  }
  for (const name of ["bundled-index", "targets", "fixture", "route-rosters", "output-root"]) {
    if (!args[name]) throw new Error(`missing --${name}`);
  }
  if (!path.isAbsolute(args["output-root"])) throw new Error("--output-root must be absolute");
  return args;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "KRIC accessibility collection failed"}\n`);
    process.exitCode = 1;
  });
}
