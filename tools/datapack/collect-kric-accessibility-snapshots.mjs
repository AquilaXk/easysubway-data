#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { codepointCompare } from "../lib/codepoint-compare.mjs";

export const KRIC_APPROVED_ACCESSIBILITY_OPERATIONS = Object.freeze([
  {
    sourceId: "kric-station-elevator",
    endpoint: "https://openapi.kric.go.kr/openapi/convenientInfo/stationElevator",
    responseFields: ["dtlLoc", "exitNo", "grndDvNmFr", "grndDvNmTo", "lnCd", "railOprIsttCd", "rglnPsno", "rglnWgt", "runStinFlorFr", "runStinFlorTo", "stinCd"],
    tupleIdentityFields: ["railOprIsttCd", "lnCd", "stinCd"],
  },
  {
    sourceId: "kric-station-escalator",
    endpoint: "https://openapi.kric.go.kr/openapi/convenientInfo/stationEscalator",
    responseFields: ["dtlLoc", "exitNo", "grndDvNmFr", "grndDvNmTo", "lnCd", "railOprIsttCd", "runStinFlorFr", "runStinFlorTo", "stinCd", "updnDvNm"],
    tupleIdentityFields: ["railOprIsttCd", "lnCd", "stinCd"],
  },
  {
    sourceId: "kric-wheelchair-lift-location",
    endpoint: "https://openapi.kric.go.kr/openapi/vulnerableUserInfo/stationWheelchairLiftLocation",
    responseFields: ["bndWgt", "dtlLoc", "exitNo", "grndDvNmFr", "grndDvNmTo", "len", "lnCd", "railOprIsttCd", "runStinFlorFr", "runStinFlorTo", "stinCd", "wd"],
    tupleIdentityFields: ["railOprIsttCd", "lnCd", "stinCd"],
  },
  {
    sourceId: "kric-station-elevator-movement",
    endpoint: "https://openapi.kric.go.kr/openapi/vulnerableUserInfo/stationElevatorMovement",
    responseFields: ["lnCd", "mvContDtl", "mvDst", "mvPathDvCd", "mvPathDvNm", "mvPathMgNo", "mvTpOrdr", "railOprIsttCd", "stinCd"],
    tupleIdentityFields: ["railOprIsttCd", "lnCd", "stinCd"],
  },
  {
    sourceId: "kric-wheelchair-lift-movement",
    endpoint: "https://openapi.kric.go.kr/openapi/vulnerableUserInfo/stationWheelchairLiftMovement",
    responseFields: ["lnCd", "mvContDtl", "mvDst", "mvPathDvCd", "mvPathDvNm", "mvPathMgNo", "mvTpOrdr", "railOprIsttCd", "stinCd"],
    tupleIdentityFields: ["railOprIsttCd", "lnCd", "stinCd"],
  },
]);

export const KRIC_ACCESSIBILITY_OPERATIONS = Object.freeze([{
  sourceId: "kric-station-convenience-standard",
  endpoint: "https://openapi.kric.go.kr/openapi/handicapped/stationCnvFacl",
  responseFields: ["dtlLoc", "grndDvCd", "gubun", "imgPath", "mlFmlDvCd", "stinFlor", "trfcWeakDvCd"],
  tupleIdentityFields: [],
}]);

// Provider roster의 개명·오기만 exact tuple로 결속한다. 이름 유사도 fallback은 두지 않는다.
export const KRIC_STATION_TUPLE_MAPPINGS = Object.freeze([
  { stationId: "station-47b514f305d8", lineId: "seoul-4", railOprIsttCd: "KR", lnCd: "4", stinCd: "454" },
  { stationId: "station-47b514f305d8", lineId: "line-558d0bd8312d", railOprIsttCd: "KR", lnCd: "K1", stinCd: "K256" },
  { stationId: "station-9d261727e400", lineId: "line-828f04afc588", railOprIsttCd: "EV", lnCd: "E1", stinCd: "Y120" },
  { stationId: "station-b1a5f63faf69", lineId: "line-42b5805f3b5a", railOprIsttCd: "IC", lnCd: "I2", stinCd: "210" },
]);

export function validateKricAccessibilityProviderGapEvidence(evidence) {
  if (evidence?.schemaVersion !== 1
    || evidence?.artifactKind !== "kric-accessibility-provider-gap-evidence"
    || evidence?.sourceId !== "kric-station-convenience-standard"
    || evidence?.resultCodeInterpretation !== "UNDEFINED_NOT_ABSENCE"
    || !Array.isArray(evidence?.gaps) || evidence.gaps.length === 0) {
    throw new Error("KRIC accessibility provider gap evidence is invalid");
  }
  if (!Number.isFinite(Date.parse(evidence.observedAt))
    || !/^https:\/\/github\.com\/AquilaXk\/easysubway\/actions\/runs\/\d+$/.test(evidence.workflowRunUrl)) {
    throw new Error("KRIC accessibility provider gap provenance is invalid");
  }
  const seen = new Set();
  const operatorCounts = {};
  for (const gap of evidence.gaps) {
    for (const field of ["railOprIsttCd", "lnCd", "stinCd"]) {
      if (typeof gap?.[field] !== "string" || gap[field] === "") {
        throw new Error(`KRIC accessibility provider gap ${field} is invalid`);
      }
    }
    if (gap.resultCode !== "03") throw new Error("KRIC accessibility provider gap resultCode must be 03");
    const key = [gap.railOprIsttCd, gap.lnCd, gap.stinCd].join("/");
    if (seen.has(key)) throw new Error(`duplicate KRIC accessibility provider gap: ${key}`);
    seen.add(key);
    operatorCounts[gap.railOprIsttCd] = (operatorCounts[gap.railOprIsttCd] ?? 0) + 1;
  }
  return {
    count: evidence.gaps.length,
    operatorCounts: Object.fromEntries(Object.entries(operatorCounts).sort(([left], [right]) => compare(left, right))),
  };
}

export async function collectKricAccessibilitySnapshots(options = {}) {
  return (await collectKricAccessibilitySnapshotResults(options)).snapshots;
}

async function collectKricAccessibilitySnapshotResults({
  roster,
  operations = KRIC_ACCESSIBILITY_OPERATIONS,
  serviceKey,
  fetchImpl = fetch,
  now = new Date(),
  requestTimeoutMs = 30_000,
  requestIntervalMs = 0,
  delayImpl = delay,
  retainRawResponses = false,
} = {}) {
  if (typeof serviceKey !== "string" || serviceKey === "") throw new Error("KRIC_SERVICE_KEY is required");
  if (!Number.isInteger(requestIntervalMs) || requestIntervalMs < 0 || requestIntervalMs > 60_000) {
    throw new Error("KRIC request interval is invalid");
  }
  const tuples = validateRoster(roster);
  const capturedAt = now.toISOString();
  const freshUntil = new Date(now.getTime() + 86_400_000).toISOString();
  const snapshots = [];
  const rawCollections = [];
  let requestCount = 0;
  const paceRequest = async () => {
    if (requestCount > 0 && requestIntervalMs > 0) await delayImpl(requestIntervalMs);
    requestCount += 1;
  };
  for (const operation of operations) {
    validateOperation(operation);
    const queries = [];
    const rawResponses = [];
    const providerGaps = [];
    const responsesByProviderTuple = new Map();
    for (const tuple of tuples) {
      const providerKey = [tuple.railOprIsttCd, tuple.lnCd, tuple.stinCd].join("\0");
      if (!responsesByProviderTuple.has(providerKey)) {
        try {
          const requested = await requestRows({
            operation, tuple, serviceKey, fetchImpl, requestTimeoutMs, paceRequest,
          });
          responsesByProviderTuple.set(providerKey, requested);
          if (retainRawResponses) rawResponses.push(requested.rawResponse);
        } catch (error) {
          if (error?.kricResultCode !== "03") throw error;
          providerGaps.push(`${error.kricRequestIdentity}/${error.kricResultCode}`);
          responsesByProviderTuple.set(providerKey, null);
        }
      }
      const response = responsesByProviderTuple.get(providerKey);
      if (response === null) continue;
      const { rows, rawResponseSha256 } = response;
      const providerRecordHash = hash(rows);
      queries.push({
        ...tuple,
        status: rows.length === 0 ? "ABSENT_EXPLICIT_ZERO" : "PRESENT",
        rawResponseSha256,
        providerRecordHash,
        rows,
      });
    }
    if (providerGaps.length > 0) {
      throw new Error(`KRIC accessibility provider gaps: count=${providerGaps.length}; tuples=${providerGaps.sort(compare).join(",")}`);
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
      providerResultCode: "00",
      schemaStatus: "PASS",
      absenceEvidenceMode: "EXHAUSTIVE_LIST",
      queryCount: queries.length,
      rowCount: queries.reduce((sum, query) => sum + query.rows.length, 0),
      rawSha256,
      contentSha256,
      schemaFingerprint: hash([...operation.responseFields].sort(compare)),
      redactedRequestFingerprint: hash({
        endpoint: operation.endpoint,
        tuples: queries.map(({ railOprIsttCd, lnCd, stinCd }) => ({ railOprIsttCd, lnCd, stinCd })),
      }),
      queries,
    });
    if (retainRawResponses) rawCollections.push({ sourceId: operation.sourceId, responses: rawResponses });
  }
  return { snapshots, rawCollections };
}

export async function collectKricStandardAccessibilityObservation(options = {}) {
  const { snapshots, rawCollections } = await collectKricAccessibilitySnapshotResults({
    ...options,
    operations: KRIC_ACCESSIBILITY_OPERATIONS,
    retainRawResponses: true,
  });
  if (snapshots.length !== 1 || rawCollections.length !== 1) {
    throw new Error("KRIC standard accessibility observation is invalid");
  }
  const snapshot = validateKricAccessibilitySnapshotIdentity(snapshots[0]);
  const responses = rawCollections[0].responses;
  const rawArtifact = validateKricAccessibilityRawCollection({
    schemaVersion: 1,
    artifactKind: "kric-accessibility-raw-collection",
    sourceId: snapshot.sourceId,
    snapshotId: snapshot.snapshotId,
    capturedAt: snapshot.capturedAt,
    snapshotRawSha256: snapshot.rawSha256,
    credentialRedacted: true,
    requestCount: responses.length,
    inventorySha256: hash(responses.map(({ bodyBase64: _, ...response }) => response)),
    responses,
  }, snapshot);
  return { snapshot, rawArtifact };
}

export function validateKricAccessibilityRawCollection(rawArtifact, snapshotValue) {
  const snapshot = validateKricAccessibilitySnapshotIdentity(snapshotValue);
  const expectedKeys = [
    "schemaVersion", "artifactKind", "sourceId", "snapshotId", "capturedAt", "snapshotRawSha256",
    "credentialRedacted", "requestCount", "inventorySha256", "responses",
  ];
  if (!rawArtifact || !exactKeys(rawArtifact, expectedKeys)
    || rawArtifact.schemaVersion !== 1
    || rawArtifact.artifactKind !== "kric-accessibility-raw-collection"
    || rawArtifact.sourceId !== snapshot.sourceId
    || rawArtifact.snapshotId !== snapshot.snapshotId
    || rawArtifact.capturedAt !== snapshot.capturedAt
    || rawArtifact.snapshotRawSha256 !== snapshot.rawSha256
    || rawArtifact.credentialRedacted !== true
    || !Array.isArray(rawArtifact.responses)
    || rawArtifact.requestCount !== rawArtifact.responses.length
    || !/^[0-9a-f]{64}$/.test(rawArtifact.inventorySha256 ?? "")) {
    throw new Error("KRIC accessibility raw collection is invalid");
  }
  const seen = new Set();
  for (const response of rawArtifact.responses) {
    if (!exactKeys(response, [
      "railOprIsttCd", "lnCd", "stinCd", "providerResultCode", "rawResponseSha256", "byteSize", "bodyBase64",
    ]) || !["railOprIsttCd", "lnCd", "stinCd"].every((field) => typeof response[field] === "string" && response[field] !== "")
      || response.providerResultCode !== "00"
      || !/^[0-9a-f]{64}$/.test(response.rawResponseSha256 ?? "")
      || !Number.isSafeInteger(response.byteSize) || response.byteSize < 1
      || typeof response.bodyBase64 !== "string" || response.bodyBase64 === "") {
      throw new Error("KRIC accessibility raw collection is invalid");
    }
    const bytes = Buffer.from(response.bodyBase64, "base64");
    if (bytes.toString("base64") !== response.bodyBase64 || bytes.length !== response.byteSize
      || hashBytes(bytes) !== response.rawResponseSha256) {
      throw new Error("KRIC accessibility raw collection is invalid");
    }
    let payload;
    try { payload = JSON.parse(bytes); } catch { throw new Error("KRIC accessibility raw collection is invalid"); }
    if (payload?.header?.resultCode !== "00" || !Array.isArray(payload?.body)) {
      throw new Error("KRIC accessibility raw collection is invalid");
    }
    const key = [response.railOprIsttCd, response.lnCd, response.stinCd].join("\0");
    if (seen.has(key)) throw new Error("KRIC accessibility raw collection is invalid");
    seen.add(key);
  }
  const queryKeys = new Set(snapshot.queries.map(({ railOprIsttCd, lnCd, stinCd }) => [railOprIsttCd, lnCd, stinCd].join("\0")));
  const responseHashes = new Map(rawArtifact.responses.map((response) => [[
    response.railOprIsttCd, response.lnCd, response.stinCd,
  ].join("\0"), response.rawResponseSha256]));
  if (seen.size !== queryKeys.size || [...queryKeys].some((key) => !seen.has(key))
    || snapshot.queries.some((query) => responseHashes.get([
      query.railOprIsttCd, query.lnCd, query.stinCd,
    ].join("\0")) !== query.rawResponseSha256)
    || rawArtifact.inventorySha256 !== hash(rawArtifact.responses.map(({ bodyBase64: _, ...response }) => response))) {
    throw new Error("KRIC accessibility raw collection is invalid");
  }
  return rawArtifact;
}

export async function writeKricStandardAccessibilityObservation({ outputRoot, observation } = {}) {
  if (typeof outputRoot !== "string" || !path.isAbsolute(outputRoot)) {
    throw new Error("KRIC observation output root must be absolute");
  }
  try {
    await lstat(outputRoot);
    throw new Error("KRIC observation output root already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const { snapshot, rawArtifact } = observation ?? {};
  validateKricAccessibilityRawCollection(rawArtifact, snapshot);
  const snapshotFile = `${snapshot.snapshotId}.json`;
  const rawArtifactFile = `${snapshot.snapshotId}.raw.json`;
  const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
  const rawArtifactBytes = Buffer.from(`${JSON.stringify(rawArtifact, null, 2)}\n`);
  const manifest = {
    schemaVersion: 1,
    artifactKind: "kric-standard-accessibility-observation",
    sourceId: snapshot.sourceId,
    capturedAt: snapshot.capturedAt,
    snapshotId: snapshot.snapshotId,
    snapshotRawSha256: snapshot.rawSha256,
    snapshotFile,
    snapshotFileSha256: hashBytes(snapshotBytes),
    rawArtifactFile,
    rawObjectSha256: hashBytes(rawArtifactBytes),
    rawObjectChecksumSha256: createHash("sha256").update(rawArtifactBytes).digest("base64"),
    rawObjectByteSize: rawArtifactBytes.length,
    credentialRedacted: true,
  };
  await mkdir(path.dirname(outputRoot), { recursive: true });
  const temporary = path.join(path.dirname(outputRoot), `.${path.basename(outputRoot)}.${randomUUID()}.tmp`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    await Promise.all([
      writeFile(path.join(temporary, snapshotFile), snapshotBytes, { flag: "wx", mode: 0o600 }),
      writeFile(path.join(temporary, rawArtifactFile), rawArtifactBytes, { flag: "wx", mode: 0o600 }),
      writeFile(path.join(temporary, "observation.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 }),
    ]);
    await rename(temporary, outputRoot);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return manifest;
}

export async function collectKricAccessibilityProviderTupleEvidence({
  tuples,
  operations = KRIC_APPROVED_ACCESSIBILITY_OPERATIONS,
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
  const providerTuples = validateProviderTuples(tuples);
  if (!Array.isArray(operations) || operations.length === 0) throw new Error("KRIC operations are required");
  const seenOperations = new Set();
  const capturedAt = now.toISOString();
  let requestCount = 0;
  const paceRequest = async () => {
    if (requestCount > 0 && requestIntervalMs > 0) await delayImpl(requestIntervalMs);
    requestCount += 1;
  };
  const collectedOperations = [];
  for (const operation of operations) {
    validateOperation(operation);
    if (seenOperations.has(operation.sourceId)) throw new Error(`duplicate KRIC operation: ${operation.sourceId}`);
    seenOperations.add(operation.sourceId);
    const queries = [];
    for (const tuple of providerTuples) {
      const response = await requestRows({
        operation, tuple, serviceKey, fetchImpl, requestTimeoutMs, paceRequest,
      });
      if (response.rows.length === 0) {
        throw new Error(`KRIC provider tuple probe empty response: ${operation.sourceId}/${providerTuple(tuple)}`);
      }
      queries.push({
        providerTuple: providerTuple(tuple),
        stationName: tuple.stationName,
        rowCount: response.rows.length,
        rawResponseSha256: response.rawResponseSha256,
        providerRecordHash: hash(response.rows),
        rows: response.rows,
      });
    }
    collectedOperations.push({ sourceId: operation.sourceId, queries });
  }
  return {
    schemaVersion: 1,
    artifactKind: "kric-facility-provider-tuple-probe",
    capturedAt,
    credentialRedacted: true,
    publishAllowed: false,
    productionAdmissionAllowed: false,
    operationCount: collectedOperations.length,
    queryCount: collectedOperations.reduce((sum, operation) => sum + operation.queries.length, 0),
    rowCount: collectedOperations.reduce((sum, operation) => (
      sum + operation.queries.reduce((querySum, query) => querySum + query.rowCount, 0)
    ), 0),
    contentSha256: hash(collectedOperations.map((operation) => ({
      sourceId: operation.sourceId,
      queries: operation.queries.map(({ rawResponseSha256: _, ...query }) => query),
    }))),
    rawSha256: hash(collectedOperations.map(({ sourceId, queries }) => ({
      sourceId,
      queries: queries.map(({ providerTuple: tuple, rawResponseSha256 }) => ({ providerTuple: tuple, rawResponseSha256 })),
    }))),
    operations: collectedOperations,
  };
}

export function validateKricAccessibilitySnapshotIdentity(snapshot) {
  const operation = KRIC_ACCESSIBILITY_OPERATIONS.find(({ sourceId }) => sourceId === snapshot?.sourceId)
    ?? KRIC_APPROVED_ACCESSIBILITY_OPERATIONS.find(({ sourceId }) => sourceId === snapshot?.sourceId);
  if (!operation || snapshot?.schemaVersion !== 1 || snapshot?.artifactKind !== "kric-accessibility-snapshot"
    || snapshot.providerResultCode !== "00" || snapshot.schemaStatus !== "PASS"
    || snapshot.absenceEvidenceMode !== "EXHAUSTIVE_LIST" || snapshot.credentialRedacted !== true || !Array.isArray(snapshot.queries)
    || typeof snapshot.snapshotId !== "string" || typeof snapshot.sourceId !== "string"
    || !Number.isFinite(Date.parse(snapshot.capturedAt)) || !Number.isFinite(Date.parse(snapshot.observedAt))
    || !Number.isFinite(Date.parse(snapshot.freshUntil))) {
    throw new Error("KRIC accessibility snapshot identity is invalid");
  }
  const timestamp = snapshot.capturedAt.replaceAll(/[-:.]/g, "");
  if (snapshot.snapshotId !== `${snapshot.sourceId}-${timestamp}` || snapshot.observedAt !== snapshot.capturedAt) {
    throw new Error("KRIC accessibility snapshot identity is invalid");
  }
  const tupleKeys = new Set();
  for (const query of snapshot.queries) {
    if (!query || !["stationId", "lineId", "railOprIsttCd", "lnCd", "stinCd"].every((field) =>
      typeof query[field] === "string" && query[field] !== "")
      || !Array.isArray(query.rows) || !Array.isArray(query.canonicalMappings)
      || !/^[0-9a-f]{64}$/.test(query.rawResponseSha256 ?? "")
      || !/^[0-9a-f]{64}$/.test(query.providerRecordHash ?? "")
      || query.status !== (query.rows.length === 0 ? "ABSENT_EXPLICIT_ZERO" : "PRESENT")
      || query.canonicalMappings.length === 0
      || query.canonicalMappings.some((mapping) => !mapping
        || !["artifactId", "stationId", "lineId"].every((field) => typeof mapping[field] === "string" && mapping[field] !== "")
        || mapping.stationId !== query.stationId || mapping.lineId !== query.lineId)
      || query.providerRecordHash !== hash(query.rows)
      || query.rows.some((row) => !row || typeof row !== "object"
        || Object.keys(row).length !== operation.responseFields.length
        || Object.keys(row).some((field) => !operation.responseFields.includes(field))
        || operation.tupleIdentityFields.some((field) => row[field] !== query[field]))) {
      throw new Error("KRIC accessibility snapshot identity is invalid");
    }
    const tupleKey = [query.stationId, query.lineId, query.railOprIsttCd, query.lnCd, query.stinCd].join("\0");
    if (tupleKeys.has(tupleKey)) throw new Error("KRIC accessibility snapshot identity is invalid");
    tupleKeys.add(tupleKey);
  }
  const contentSha256 = hash(snapshot.queries.map(({ rawResponseSha256: _, ...query }) => query));
  const rawSha256 = hash(snapshot.queries.map(({
    stationId, lineId, railOprIsttCd, lnCd, stinCd, rawResponseSha256,
  }) => ({ stationId, lineId, railOprIsttCd, lnCd, stinCd, rawResponseSha256 })));
  const schemaFingerprint = hash([...operation.responseFields].sort(compare));
  const redactedRequestFingerprint = hash({
    endpoint: operation.endpoint,
    tuples: snapshot.queries.map(({ railOprIsttCd, lnCd, stinCd }) => ({ railOprIsttCd, lnCd, stinCd })),
  });
  if (snapshot.queryCount !== snapshot.queries.length
    || snapshot.rowCount !== snapshot.queries.reduce((sum, query) => sum + (query.rows?.length ?? 0), 0)
    || snapshot.contentSha256 !== contentSha256 || snapshot.rawSha256 !== rawSha256
    || snapshot.schemaFingerprint !== schemaFingerprint
    || snapshot.redactedRequestFingerprint !== redactedRequestFingerprint) {
    throw new Error("KRIC accessibility snapshot identity is invalid");
  }
  return snapshot;
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
  if (typeof bundledRoot !== "string" || !path.isAbsolute(bundledRoot)) {
    throw new Error("bundled root is invalid");
  }
  const resolvedPacks = (bundledIndex?.packs ?? []).map((pack, index) => {
    const packUrl = pack?.url;
    const packPath = typeof packUrl === "string" ? path.resolve(bundledRoot, packUrl) : "";
    const relativePackPath = packPath === "" ? "" : path.relative(bundledRoot, packPath);
    if (typeof packUrl !== "string"
      || packUrl === ""
      || path.isAbsolute(packUrl)
      || packUrl.includes("\\")
      || !packUrl.endsWith(".sqlite.gz")
      || relativePackPath === ""
      || relativePackPath === ".."
      || relativePackPath.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativePackPath)) {
      throw new Error(`${pack?.id ?? "unknown"}: pack url is invalid`);
    }
    return { index, pack, packPath };
  });
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "easysubway-kric-accessibility-roster-"));
  try {
    const memberships = new Map();
    for (const { index, pack, packPath } of resolvedPacks) {
      const sqliteBytes = gunzipSync(await readFile(packPath));
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

function validateProviderTuples(tuples) {
  if (!Array.isArray(tuples) || tuples.length === 0) throw new Error("KRIC provider tuples are required");
  const seen = new Set();
  return tuples.map((tuple) => {
    for (const field of ["railOprIsttCd", "lnCd", "stinCd", "stationName"]) {
      if (typeof tuple?.[field] !== "string" || tuple[field] === "") {
        throw new Error(`KRIC provider tuple ${field} is required`);
      }
    }
    const key = providerTuple(tuple);
    if (seen.has(key)) throw new Error(`duplicate KRIC provider tuple: ${key}`);
    seen.add(key);
    return { ...tuple };
  }).sort((left, right) => compare(providerTuple(left), providerTuple(right)));
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
  const requestIdentity = `${operation.sourceId}/${tuple.railOprIsttCd}/${tuple.lnCd}/${tuple.stinCd}`;
  const url = new URL(operation.endpoint);
  url.searchParams.set("serviceKey", serviceKey);
  url.searchParams.set("format", "json");
  for (const field of ["railOprIsttCd", "lnCd", "stinCd"]) url.searchParams.set(field, tuple[field]);
  let response;
  await paceRequest();
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
  } catch {
    throw new Error(`KRIC accessibility request failed: ${requestIdentity}`);
  }
  if (!response?.ok) throw new Error(`KRIC accessibility HTTP ${response?.status ?? "unknown"}: ${requestIdentity}`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`KRIC accessibility schema invalid: ${requestIdentity}`);
  }
  const rawResponseBytes = Buffer.from(JSON.stringify(payload));
  if (containsStringValue(payload, serviceKey)) {
    throw new Error(`KRIC accessibility credential reflection rejected: ${requestIdentity}`);
  }
  const rawResponseSha256 = hashBytes(rawResponseBytes);
  const resultCode = payload?.header?.resultCode;
  if (resultCode === "00" && Array.isArray(payload?.body)) {
    payload = payload.body;
  } else {
    const safeCode = /^[A-Za-z0-9._-]{1,32}$/.test(resultCode ?? "") ? resultCode : "UNKNOWN";
    const safeKeys = Object.keys(payload ?? {}).filter((key) => /^[A-Za-z0-9._-]{1,32}$/.test(key))
      .sort(codepointCompare).slice(0, 12);
    const safeBodyKeys = Object.keys(payload?.body ?? {}).filter((key) => /^[A-Za-z0-9._-]{1,32}$/.test(key))
      .sort(codepointCompare).slice(0, 12);
    const error = new Error(`KRIC accessibility provider result invalid: ${requestIdentity}/${safeCode}; keys=${safeKeys.join(",")}; bodyKeys=${safeBodyKeys.join(",")}`);
    error.kricRequestIdentity = requestIdentity;
    error.kricResultCode = safeCode;
    throw error;
  }
  const tupleIdentityFields = operation.tupleIdentityFields ?? ["railOprIsttCd", "lnCd", "stinCd"];
  for (const row of payload) {
    if (!row || typeof row !== "object" || operation.responseFields.some((field) => !(field in row))
      || tupleIdentityFields.some((field) => row[field] !== tuple[field])) {
      throw new Error(`KRIC accessibility schema invalid: ${requestIdentity}`);
    }
  }
  return {
    rows: payload.map((row) => Object.fromEntries(
      operation.responseFields.map((field) => [field, row[field]]),
    )),
    rawResponseSha256,
    rawResponse: {
      railOprIsttCd: tuple.railOprIsttCd,
      lnCd: tuple.lnCd,
      stinCd: tuple.stinCd,
      providerResultCode: "00",
      rawResponseSha256,
      byteSize: rawResponseBytes.length,
      bodyBase64: rawResponseBytes.toString("base64"),
    },
  };
}

function tupleKey(tuple) {
  return `${tuple.railOprIsttCd}\0${tuple.lnCd}\0${tuple.stinCd}\0${tuple.stationId}\0${tuple.lineId}`;
}

function providerTupleKey(tuple) {
  return `${tuple.lineId}\0${tuple.railOprIsttCd}\0${tuple.lnCd}\0${tuple.stinCd}`;
}

function providerTuple(tuple) {
  return `${tuple.railOprIsttCd}/${tuple.lnCd}/${tuple.stinCd}`;
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactKeys(value, expected) {
  return value != null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === expected.length
    && expected.every((key, index) => Object.keys(value)[index] === key);
}

function containsStringValue(value, expected) {
  if (typeof value === "string") return value.includes(expected);
  if (Array.isArray(value)) return value.some((item) => containsStringValue(item, expected));
  return value != null && typeof value === "object"
    && Object.entries(value).some(([key, item]) => key.includes(expected) || containsStringValue(item, expected));
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
    bundledRoot: args["bundled-root"],
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
  const observation = await collectKricStandardAccessibilityObservation({
    roster,
    serviceKey: process.env.KRIC_SERVICE_KEY,
    requestIntervalMs: Number(args["request-interval-ms"] ?? 0),
  });
  await writeKricStandardAccessibilityObservation({ outputRoot: args["output-root"], observation });
  process.stdout.write(`sanitized KRIC accessibility observation ready: tuples=${roster.length} sources=1\n`);
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
  for (const name of ["bundled-index", "bundled-root", "targets", "fixture", "route-rosters", "output-root"]) {
    if (!args[name]) throw new Error(`missing --${name}`);
  }
  if (!path.isAbsolute(args["bundled-root"])) throw new Error("--bundled-root must be absolute");
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
