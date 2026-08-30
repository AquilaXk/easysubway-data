#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

import {
  buildMolitRailwayTransferMovementSnapshot,
  MOLIT_RAILWAY_TRANSFER_MOVEMENT_SOURCE_ID,
} from "./collect-molit-railway-transfer-movement.mjs";
import { validateKricProviderCodeCatalogIdentity } from "./build-molit-nationwide-fixture.mjs";
import { normalizeMolitProviderLineName } from "./lib/molit-svg-provider-identity.mjs";

const VIOLATION_KEYS = Object.freeze([
  "freshness",
  "license",
  "provenance",
  "snapshot",
  "absenceEvidence",
  "placeholder",
  "artifactIdentity",
]);
const ABSENCE_EVIDENCE_MODES = new Set(["EXPLICIT_ZERO", "EXHAUSTIVE_LIST"]);
const COVERAGE_REGION_IDS = Object.freeze({
  "수도권": "capital",
  "부산권": "busan",
  "대구권": "daegu",
  "광주권": "gwangju",
  "대전권": "daejeon",
});

export function buildAccessibilitySourceCoverageReport({
  artifacts,
  inventory,
  snapshots,
  sourceSnapshotPolicies,
  evaluatedAt,
  molitTransferSnapshot,
  providerCodeCatalog,
}) {
  const evaluatedMillis = Date.parse(evaluatedAt);
  if (!Number.isFinite(evaluatedMillis)) throw new TypeError("evaluatedAt must be an ISO instant");
  if (!Array.isArray(artifacts) || !Array.isArray(inventory?.sources) || !Array.isArray(snapshots)
    || !Array.isArray(sourceSnapshotPolicies)) {
    throw new TypeError("artifacts, inventory.sources, snapshots, and sourceSnapshotPolicies must be arrays");
  }

  const violations = Object.fromEntries(VIOLATION_KEYS.map((key) => [key, []]));
  const sources = new Map(inventory.sources.map((source) => [source.id, source]));
  const snapshotsByIdentity = new Map(snapshots.map((snapshot) => [
    `${snapshot.sourceId}\0${snapshot.snapshotId}`,
    snapshot,
  ]));
  const policiesByIdentity = new Map(sourceSnapshotPolicies.map((snapshot) => [
    `${snapshot.sourceId}\0${snapshot.snapshotId}`,
    snapshot,
  ]));
  const artifactIds = new Set();
  const providerDomains = new Map();
  const validClaims = new Set();
  const referencedSourceIds = new Set(
    artifacts.flatMap((artifact) => artifact.claims ?? []).map((claim) => claim.sourceId).filter(Boolean),
  );

  for (const source of inventory.sources) {
    if (referencedSourceIds.has(source.id)) {
      validateSource(source, snapshotsByIdentity, policiesByIdentity, evaluatedMillis, violations);
    }
  }

  for (const artifact of artifacts) {
    if (artifactIds.has(artifact.artifactId)) {
      violations.artifactIdentity.push(`${artifact.artifactId}:DUPLICATE_ARTIFACT_ID`);
    }
    artifactIds.add(artifact.artifactId);
    if (!sha256(artifact.sqliteSha256)) {
      violations.artifactIdentity.push(`${artifact.artifactId}:SQLITE_SHA256_INVALID`);
    }
    for (const claim of artifact.claims ?? []) {
      if (validateClaim(artifact, claim, sources, snapshotsByIdentity, violations)) validClaims.add(claim);
      if (!claim.sourceId) continue;
      const key = `${claim.sourceId}\0${claim.domain}`;
      const entry = providerDomains.get(key) ?? {
        sourceId: claim.sourceId,
        domain: claim.domain,
        artifactIds: new Set(),
        claimCount: 0,
      };
      entry.artifactIds.add(artifact.artifactId);
      entry.claimCount += 1;
      providerDomains.set(key, entry);
    }
  }

  for (const values of Object.values(violations)) values.sort(compareStrings);
  const blockedSources = new Set(
    [violations.freshness, violations.license, violations.snapshot, violations.provenance]
      .flat()
      .filter((value) => value.split(":").length === 2)
      .map((value) => value.split(":", 1)[0]),
  );
  for (const claim of validClaims) {
    if (blockedSources.has(claim.sourceId)) validClaims.delete(claim);
  }
  const providerDomainMatrix = [...providerDomains.values()]
    .map((entry) => ({
      sourceId: entry.sourceId,
      domain: entry.domain,
      artifactIds: [...entry.artifactIds].sort(compareStrings),
      claimCount: entry.claimCount,
      status: !sources.has(entry.sourceId) || blockedSources.has(entry.sourceId) ? "BLOCKED" : "ADMITTED",
    }))
    .sort((left, right) => compareStrings(`${left.sourceId}\0${left.domain}`, `${right.sourceId}\0${right.domain}`));
  const artifactSummaries = artifacts
    .map((artifact) => ({
      artifactId: artifact.artifactId,
      sqliteSha256: artifact.sqliteSha256,
      searchableStationCount: new Set(artifact.searchableStationIds ?? []).size,
      claimCount: artifact.claims?.length ?? 0,
      ...(Array.isArray(artifact.stationLines) ? {
        stationLineCount: artifact.stationLines.length,
        operatorCount: new Set(artifact.stationLines.map(({ operatorId }) => operatorId)).size,
      } : {}),
    }))
    .sort((left, right) => compareStrings(left.artifactId, right.artifactId));

  if (Boolean(molitTransferSnapshot) !== Boolean(providerCodeCatalog)) {
    throw new TypeError("station domain gate inputs must be provided together");
  }
  const stationDomainSourceGate = molitTransferSnapshot && providerCodeCatalog
    ? buildStationDomainSourceGate({
        artifacts,
        validClaims,
        sources,
        molitTransferSnapshot,
        providerCodeCatalog,
      })
    : undefined;

  return {
    schemaVersion: 1,
    artifactKind: "accessibility-source-coverage-report",
    evaluatedAt,
    artifacts: artifactSummaries,
    providerDomainMatrix,
    ...(stationDomainSourceGate ? { stationDomainSourceGate } : {}),
    violations,
    decision: Object.values(violations).every((values) => values.length === 0)
      && (!stationDomainSourceGate || stationDomainSourceGate.decision === "GO") ? "GO" : "NO_GO",
  };
}

export function buildStationDomainSourceGate({
  artifacts, validClaims, sources, molitTransferSnapshot, providerCodeCatalog,
}) {
  if (artifacts.some((artifact) => !Array.isArray(artifact.stationLines) || artifact.stationLines.length === 0)) {
    throw new Error("station domain gate requires station-lines for every artifact");
  }
  const stationLines = artifacts.flatMap((artifact) => (artifact.stationLines ?? []).map((row) => ({
    ...row,
    artifactId: artifact.artifactId,
  })));
  if (stationLines.length === 0) throw new Error("station domain gate requires artifact station-lines");
  if (!Array.isArray(molitTransferSnapshot?.rows)
    || molitTransferSnapshot.rows.length !== molitTransferSnapshot.rowCount) {
    throw new Error("MOLIT transfer snapshot row count mismatch");
  }

  const evaluated = collectEvaluatedStationDomains(artifacts, validClaims, sources);
  const matrix = buildStationDomainMatrix(artifacts, stationLines, evaluated);
  const transferTuplePartition = partitionMolitTransferTuples({
    artifacts,
    rows: molitTransferSnapshot.rows,
    providerCodeCatalog,
  });
  const partitionIsComplete = transferTuplePartition.summary.joinedRowCount
    + transferTuplePartition.summary.unmatchedRowCount
    + transferTuplePartition.summary.ambiguousRowCount === molitTransferSnapshot.rowCount;
  if (!partitionIsComplete) throw new Error("MOLIT transfer tuple row partition mismatch");
  const identity = Object.fromEntries([
    "sourceId", "snapshotId", "rawSha256", "gzipSha256", "metadataFileSha256",
    "sourceInventoryFileSha256", "sourceInventorySha256", "candidateBuildSpecSourceInventorySha256", "rowCount",
  ].map((key) => [key, molitTransferSnapshot[key]]));
  if (typeof identity.sourceId !== "string" || identity.sourceId === ""
    || typeof identity.snapshotId !== "string" || identity.snapshotId === ""
    || !Number.isInteger(identity.rowCount) || identity.rowCount < 0
    || ["rawSha256", "gzipSha256", "metadataFileSha256", "sourceInventoryFileSha256",
      "sourceInventorySha256", "candidateBuildSpecSourceInventorySha256"].some((key) => !sha256(identity[key]))) {
    throw new Error("MOLIT transfer snapshot identity is invalid");
  }
  transferTuplePartition.identity = identity;
  const decision = matrix.every(({ status }) => status === "ADMITTED")
    && transferTuplePartition.unmatched.length === 0
    && transferTuplePartition.ambiguous.length === 0 ? "GO" : "NO_GO";
  return { matrix, transferTuplePartition, decision };
}

function collectEvaluatedStationDomains(artifacts, validClaims, sources) {
  const evaluated = new Map();
  for (const artifact of artifacts) {
    const stationLineByKey = new Map((artifact.stationLines ?? []).map((row) => [
      `${row.stationId}\0${row.lineId}`,
      row,
    ]));
    for (const claim of artifact.claims ?? []) {
      const domain = stationDomainForClaim(claim);
      const stationLine = domain && claim.lineId
        ? stationLineByKey.get(`${claim.stationId}\0${claim.lineId}`)
        : undefined;
      const source = sources.get(claim.sourceId);
      if (!stationLine || !validClaims.has(claim)
        || !sourceCoversStationDomain(source, stationLine, domain)) continue;
      const key = `${artifact.artifactId}\0${stationLine.operatorId}\0${domain}`;
      const entry = evaluated.get(key) ?? { stationLines: new Set(), sourceIds: new Set() };
      entry.stationLines.add(`${claim.stationId}\0${claim.lineId}`);
      entry.sourceIds.add(claim.sourceId);
      evaluated.set(key, entry);
    }
  }
  return evaluated;
}

function sourceCoversStationDomain(source, stationLine, domain) {
  const sourceDomain = {
    FACILITY: "accessibility_facilities",
    EXIT: "indoor_movement_paths",
    TRANSFER: "indoor_movement_paths",
  }[domain];
  const scope = source?.coverageScope;
  return ABSENCE_EVIDENCE_MODES.has(source?.accessibilityAdmissionEvidence?.absenceEvidenceMode)
    && scope?.regionIds?.includes(stationLine.regionId)
    && scope?.operatorIds?.includes(stationLine.operatorId)
    && (!scope.lineIds || scope.lineIds.includes(stationLine.lineId))
    && scope?.sourceDomains?.includes(sourceDomain);
}

function buildStationDomainMatrix(artifacts, stationLines, evaluated) {
  const operators = new Map();
  const stationLineCountsByOperator = new Map();
  const artifactStationLineCounts = new Map();
  for (const { operatorId, operatorName } of stationLines) {
    if (operators.has(operatorId) && operators.get(operatorId) !== operatorName) {
      throw new Error(`operator identity mismatch: ${operatorId}`);
    }
    operators.set(operatorId, operatorName);
    stationLineCountsByOperator.set(operatorId, (stationLineCountsByOperator.get(operatorId) ?? 0) + 1);
  }
  for (const artifact of artifacts) {
    for (const { operatorId } of artifact.stationLines ?? []) {
      const key = `${artifact.artifactId}\0${operatorId}`;
      artifactStationLineCounts.set(key, (artifactStationLineCounts.get(key) ?? 0) + 1);
    }
  }
  return [...operators].flatMap(([operatorId, operatorName]) =>
    ["FACILITY", "EXIT", "TRANSFER"].map((domain) => buildStationDomainCell({
      artifacts,
      evaluated,
      stationLineCountsByOperator,
      artifactStationLineCounts,
      operatorId,
      operatorName,
      domain,
    })))
    .sort((left, right) => compareStrings(`${left.operatorId}\0${left.domain}`, `${right.operatorId}\0${right.domain}`));
}

function buildStationDomainCell({
  artifacts, evaluated, stationLineCountsByOperator, artifactStationLineCounts,
  operatorId, operatorName, domain,
}) {
  const stationLineCount = stationLineCountsByOperator.get(operatorId) ?? 0;
  const evaluatedKeys = new Set();
  const sourceIds = new Set();
  const artifactScopes = [];
  for (const artifact of artifacts) {
    const entry = evaluated.get(`${artifact.artifactId}\0${operatorId}\0${domain}`);
    const artifactStationLineCount = artifactStationLineCounts.get(`${artifact.artifactId}\0${operatorId}`) ?? 0;
    if (artifactStationLineCount === 0) continue;
    for (const stationLine of entry?.stationLines ?? []) {
      evaluatedKeys.add(`${artifact.artifactId}\0${stationLine}`);
    }
    for (const sourceId of entry?.sourceIds ?? []) sourceIds.add(sourceId);
    artifactScopes.push({
      artifactId: artifact.artifactId,
      stationLineCount: artifactStationLineCount,
      evaluatedStationLineCount: entry?.stationLines.size ?? 0,
      missingStationLineCount: artifactStationLineCount - (entry?.stationLines.size ?? 0),
    });
  }
  artifactScopes.sort((left, right) => compareStrings(left.artifactId, right.artifactId));
  const missingStationLineCount = stationLineCount - evaluatedKeys.size;
  const blockingReasons = [];
  if (sourceIds.size === 0) blockingReasons.push("NO_ADMITTED_SOURCE");
  if (missingStationLineCount > 0) blockingReasons.push("STATION_LINE_COVERAGE_INCOMPLETE");
  return {
    operatorId,
    operatorName,
    domain,
    stationLineCount,
    evaluatedStationLineCount: evaluatedKeys.size,
    missingStationLineCount,
    artifacts: artifactScopes,
    sourceIds: [...sourceIds].sort(compareStrings),
    blockingReasons,
    requiredEvidence: requiredEvidenceFor(domain),
    status: blockingReasons.length === 0 ? "ADMITTED" : "BLOCKED",
  };
}

export function partitionMolitTransferTuples({ artifacts, rows, providerCodeCatalog }) {
  if (!Array.isArray(rows) || !Array.isArray(providerCodeCatalog?.providerLines)) {
    throw new TypeError("MOLIT rows and provider code catalog are required");
  }
  const { canonical, artifactsByProviderLine } = indexCanonicalStationLines(artifacts);
  const tuples = groupMolitTransferTuples(rows);
  const partition = { joined: [], unmatched: [], ambiguous: [] };
  for (const [, tuple] of [...tuples].sort(([left], [right]) => compareStrings(left, right))) {
    const classified = classifyMolitTransferTuple({
      ...tuple,
      providerCodeCatalog,
      canonical,
      artifactsByProviderLine,
    });
    partition[classified.kind].push(classified.entry);
  }
  const sumRows = (entries) => entries.reduce((total, entry) => total + entry.rowCount, 0);
  return {
    summary: {
      rowCount: rows.length,
      tupleCount: tuples.size,
      joinedTupleCount: partition.joined.length,
      joinedRowCount: sumRows(partition.joined),
      unmatchedTupleCount: partition.unmatched.length,
      unmatchedRowCount: sumRows(partition.unmatched),
      ambiguousTupleCount: partition.ambiguous.length,
      ambiguousRowCount: sumRows(partition.ambiguous),
    },
    ...partition,
  };
}

function indexCanonicalStationLines(artifacts) {
  const canonical = new Map();
  const artifactsByProviderLine = new Map();
  for (const artifact of artifacts) {
    for (const stationLine of artifact.stationLines ?? []) {
      const providerLineKey = `${stationLine.operatorName}\0${normalizeMolitProviderLineName(stationLine.lineName)}`;
      const artifactIds = artifactsByProviderLine.get(providerLineKey) ?? new Set();
      artifactIds.add(artifact.artifactId);
      artifactsByProviderLine.set(providerLineKey, artifactIds);
      const entry = { ...stationLine, artifactId: artifact.artifactId };
      for (const name of [stationLine.stationName, ...(stationLine.stationAliases ?? [])]) {
        const nameKey = `${artifact.artifactId}\0${providerLineKey}\0${normalizeStationName(name)}`;
        const byIdentity = canonical.get(nameKey) ?? new Map();
        const identity = `${stationLine.operatorId}\0${stationLine.lineId}\0${stationLine.stationId}`;
        byIdentity.set(identity, entry);
        canonical.set(nameKey, byIdentity);
      }
    }
  }
  return { canonical, artifactsByProviderLine };
}

function groupMolitTransferTuples(rows) {
  const tuples = new Map();
  for (const row of rows) {
    const values = [row.RAIL_OPR_ISTT_CD, row.LN_NM, row.STIN_NM];
    if (values.some((value) => typeof value !== "string" || value.trim() === "")) {
      throw new Error("MOLIT transfer tuple identity is blank");
    }
    const key = values.join("\0");
    const tuple = tuples.get(key) ?? { row, rowCount: 0 };
    tuple.rowCount += 1;
    tuples.set(key, tuple);
  }
  return tuples;
}

function classifyMolitTransferTuple({
  row, rowCount, providerCodeCatalog, canonical, artifactsByProviderLine,
}) {
  const provider = parseMolitOperator(row.RAIL_OPR_ISTT_CD);
  const lineName = normalizeMolitProviderLineName(row.LN_NM);
  const providerLines = providerCodeCatalog.providerLines.filter((line) =>
    line.railOprIsttCd === provider.code && normalizeMolitProviderLineName(line.lineName) === lineName);
  const base = {
    providerOperatorCode: provider.code,
    providerOperatorName: provider.name,
    providerLineName: row.LN_NM,
    providerStationName: row.STIN_NM,
    rowCount,
  };
  if (providerLines.length === 0) {
    return { kind: "unmatched", entry: { ...base, reason: "PROVIDER_LINE_SCOPE_UNMAPPED" } };
  }
  if (providerLines.length > 1) {
    return { kind: "ambiguous", entry: { ...base, reason: "PROVIDER_LINE_SCOPE_AMBIGUOUS" } };
  }
  const [providerLine] = providerLines;
  if (provider.name !== providerLine.operatorName) {
    return {
      kind: "unmatched",
      entry: {
        ...base,
        reason: "PROVIDER_OPERATOR_IDENTITY_MISMATCH",
        catalogOperatorName: providerLine.operatorName,
      },
    };
  }
  const providerLineKey = `${providerLine.operatorName}\0${lineName}`;
  const artifactIds = [...(artifactsByProviderLine.get(providerLineKey) ?? [])].sort(compareStrings);
  if (artifactIds.length === 0) {
    return { kind: "unmatched", entry: { ...base, reason: "CANONICAL_LINE_SCOPE_UNMATCHED" } };
  }
  const matchesByArtifact = canonicalMatchesByArtifact({
    artifactIds,
    canonical,
    providerLineKey,
    stationName: row.STIN_NM,
  });
  const ambiguous = matchesByArtifact.filter(({ matches }) => matches.length > 1);
  const unmatched = matchesByArtifact.filter(({ matches }) => matches.length === 0);
  if (ambiguous.length > 0) {
    return {
      kind: "ambiguous",
      entry: {
        ...base,
        reason: "CANONICAL_STATION_AMBIGUOUS",
        candidates: ambiguous.flatMap(({ matches }) => matches),
      },
    };
  }
  if (unmatched.length > 0) {
    return {
      kind: "unmatched",
      entry: {
        ...base,
        reason: "CANONICAL_STATION_UNMATCHED",
        unmatchedArtifactIds: unmatched.map(({ artifactId }) => artifactId),
      },
    };
  }
  return {
    kind: "joined",
    entry: {
      ...base,
      mappings: matchesByArtifact.map(({ matches: [match] }) => {
        const mapping = { ...match };
        delete mapping.stationAliases;
        return mapping;
      }),
    },
  };
}

function canonicalMatchesByArtifact({ artifactIds, canonical, providerLineKey, stationName }) {
  return artifactIds.map((artifactId) => ({
    artifactId,
    matches: [...(canonical.get(
      `${artifactId}\0${providerLineKey}\0${normalizeStationName(stationName)}`,
    )?.values() ?? [])].sort((left, right) => compareStrings(
      `${left.operatorId}\0${left.lineId}\0${left.stationId}`,
      `${right.operatorId}\0${right.lineId}\0${right.stationId}`,
    )),
  }));
}

function stationDomainForClaim(claim) {
  if (["STATION_FACILITY_EVIDENCE", "FACILITY"].includes(claim.domain)) return "FACILITY";
  if (claim.domain === "STATION_EXIT") return "EXIT";
  if (claim.domain === "NETWORK_EDGE" && claim.facilityType === "OUT_OF_STATION_TRANSFER") return "TRANSFER";
  return undefined;
}

function requiredEvidenceFor(domain) {
  return {
    FACILITY: "OFFICIAL_EXHAUSTIVE_FACILITY_SNAPSHOT_OR_EXPLICIT_ZERO",
    EXIT: "OFFICIAL_EXHAUSTIVE_EXIT_PATH_SNAPSHOT_OR_EXPLICIT_ZERO",
    TRANSFER: "OFFICIAL_TRANSFER_TOPOLOGY_AND_ACCESSIBILITY_SNAPSHOT",
  }[domain];
}

function parseMolitOperator(value) {
  const match = /^([A-Z0-9]+)\(([^()]+)\)$/.exec(value);
  if (!match) throw new Error(`MOLIT provider operator identity is invalid: ${value}`);
  return { code: match[1], name: match[2].trim() };
}

export async function loadSelectableAccessibilityArtifacts({
  manifest,
  manifestRoot,
  bundledIndex,
  bundledRoot,
}) {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "easysubway-accessibility-source-report-"));
  try {
    const artifacts = [];
    const seenHashes = new Set();
    for (const [kind, document, root] of [
      ["bundled", bundledIndex, bundledRoot],
      ["manifest", manifest, manifestRoot],
    ]) {
      for (const pack of document?.packs ?? []) {
        const compressedPath = resolvePackPath(root, pack);
        const sqliteBytes = gunzipSync(await readFile(compressedPath));
        const sqliteSha256 = digest(sqliteBytes);
        if (sqliteSha256 !== pack.sqliteSha256) {
          throw new Error(`${kind}-${pack.id}:SQLITE_SHA256_MISMATCH`);
        }
        if (seenHashes.has(sqliteSha256)) continue;
        seenHashes.add(sqliteSha256);
        const sqlitePath = path.join(temporaryDirectory, `${artifacts.length}.sqlite`);
        await writeFile(sqlitePath, sqliteBytes);
        artifacts.push(readAccessibilityArtifact(sqlitePath, `${kind}-${pack.id}`, sqliteSha256));
      }
    }
    return artifacts;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function loadAccessibilityAdmissionSnapshots({ sources, referencedSourceIds, repositoryRoot }) {
  return Promise.all(sources.filter(({ id }) => referencedSourceIds.has(id)).map(async (source) => {
    const evidence = source.accessibilityAdmissionEvidence;
    if (!evidence?.snapshotPath) return { sourceId: source.id };
    const bytes = await readFile(path.resolve(repositoryRoot, evidence.snapshotPath));
    const snapshot = JSON.parse(bytes);
    return {
      ...snapshot,
      sourceId: snapshot.sourceId,
      snapshotPath: evidence.snapshotPath,
      snapshotFileSha256: digest(bytes),
    };
  }));
}

export async function loadMolitTransferSnapshot({
  metadataPath, inventory, inventoryBytes, candidateBuildSpec, repositoryRoot, evaluatedAt,
}) {
  const source = inventory?.sources?.find(({ id }) => id === MOLIT_RAILWAY_TRANSFER_MOVEMENT_SOURCE_ID);
  const admission = source?.rawSnapshotAdmission;
  const expectedMetadataPath = path.resolve(repositoryRoot, admission?.metadataPath ?? "");
  if (admission?.status !== "LOCKED"
    || !expectedMetadataPath.endsWith(".csv.gz.json")
    || path.resolve(metadataPath) !== expectedMetadataPath) {
    throw new Error("MOLIT transfer metadata path is not inventory-bound");
  }
  const [metadataBytes, gzipBytes] = await Promise.all([
    readFile(expectedMetadataPath),
    readFile(expectedMetadataPath.replace(/\.json$/, "")),
  ]);
  const metadataFileSha256 = digest(metadataBytes);
  const sourceInventoryFileSha256 = digest(inventoryBytes);
  const sourceInventorySha256 = digest(JSON.stringify(inventory));
  const metadata = JSON.parse(metadataBytes);
  if (metadataFileSha256 !== admission.metadataFileSha256
    || digest(gzipBytes) !== admission.gzipSha256
    || metadata.sourceId !== source.id
    || metadata.snapshotId !== admission.snapshotId
    || metadata.gzipSha256 !== admission.gzipSha256
    || metadata.rawSha256 !== admission.rawSha256
    || metadata.rowCount !== admission.rowCount
    || candidateBuildSpec?.sourceInventorySha256 !== sourceInventorySha256) {
    throw new Error("MOLIT transfer snapshot binding mismatch");
  }
  const evaluatedMillis = Date.parse(evaluatedAt);
  const capturedMillis = Date.parse(metadata.capturedAt);
  const observedMillis = Date.parse(metadata.observedAt);
  const freshUntilMillis = Date.parse(metadata.freshUntil);
  if (![evaluatedMillis, capturedMillis, observedMillis, freshUntilMillis].every(Number.isFinite)) {
    throw new TypeError("MOLIT transfer snapshot freshness is invalid");
  }
  if (capturedMillis > evaluatedMillis || observedMillis > evaluatedMillis) {
    throw new Error("MOLIT transfer snapshot is future-dated");
  }
  if (freshUntilMillis <= evaluatedMillis) throw new Error("MOLIT transfer snapshot is stale");
  const rebuilt = buildMolitRailwayTransferMovementSnapshot({
    bytes: gunzipSync(gzipBytes),
    capturedAt: metadata.capturedAt,
  });
  const rows = rebuilt.rows;
  const rebuiltMetadata = { ...rebuilt };
  delete rebuiltMetadata.gzipBytes;
  delete rebuiltMetadata.rows;
  delete rebuiltMetadata.gzipSha256;
  const logicalMetadata = { ...metadata };
  delete logicalMetadata.gzipSha256;
  if (canonicalJson({ ...rebuiltMetadata, gzipPath: metadata.gzipPath }) !== canonicalJson(logicalMetadata)) {
    throw new Error("MOLIT transfer logical metadata mismatch");
  }
  return {
    ...metadata,
    metadataFileSha256,
    sourceInventoryFileSha256,
    sourceInventorySha256,
    candidateBuildSpecSourceInventorySha256: candidateBuildSpec.sourceInventorySha256,
    rows,
  };
}

function readAccessibilityArtifact(sqlitePath, artifactId, sqliteSha256) {
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const stationNames = tableHasColumns(database, "stations", ["name_ko"])
      ? new Map(database.prepare("SELECT id, name_ko FROM stations").all().map(({ id, name_ko }) => [id, name_ko]))
      : new Map();
    const searchableStationIds = database.prepare(`
      SELECT DISTINCT stations.id
      FROM stations
      JOIN station_lines ON station_lines.station_id = stations.id
      ORDER BY stations.id
    `).all().map(({ id }) => id);
    const stationAliases = tableExists(database, "station_aliases")
      ? database.prepare("SELECT station_id, alias FROM station_aliases ORDER BY station_id, alias").all()
        .reduce((aliases, row) => {
          aliases.set(row.station_id, [...(aliases.get(row.station_id) ?? []), row.alias]);
          return aliases;
        }, new Map())
      : new Map();
    const stationLines = ["operators", "lines", "station_lines", "stations"].every((table) => tableExists(database, table))
      && tableHasColumns(database, "operators", ["id", "name_ko"])
      && tableHasColumns(database, "lines", ["id", "operator_id", "name_ko"])
      && tableHasColumns(database, "station_lines", ["station_id", "line_id"])
      && tableHasColumns(database, "stations", ["id", "name_ko", "region"])
      ? database.prepare(`
          SELECT station_lines.station_id AS station_id, stations.name_ko AS station_name,
                 stations.region AS region_id,
                 station_lines.line_id AS line_id, lines.name_ko AS line_name,
                 operators.id AS operator_id, operators.name_ko AS operator_name
          FROM station_lines
          JOIN stations ON stations.id = station_lines.station_id
          JOIN lines ON lines.id = station_lines.line_id
          JOIN operators ON operators.id = lines.operator_id
          ORDER BY operators.id, lines.id, stations.id
        `).all().map((row) => ({
          stationId: row.station_id,
          stationName: row.station_name,
          stationAliases: stationAliases.get(row.station_id) ?? [],
          regionId: COVERAGE_REGION_IDS[row.region_id],
          lineId: row.line_id,
          lineName: row.line_name,
          operatorId: row.operator_id,
          operatorName: row.operator_name,
        }))
      : undefined;
    const evidenceClaims = tableExists(database, "station_facility_evidence")
      ? database.prepare(`
          SELECT station_id, line_id, facility_type, evidence_kind, source_id, source_snapshot_id,
                 provider_record_hash, evidence_hash
          FROM station_facility_evidence
          ORDER BY station_id, line_id, facility_type
        `).all().map((row) => ({
          stationId: row.station_id,
          lineId: row.line_id,
          facilityType: row.facility_type,
          domain: "STATION_FACILITY_EVIDENCE",
          evidenceKind: row.evidence_kind,
          sourceId: row.source_id,
          sourceSnapshotId: row.source_snapshot_id,
          providerRecordHash: row.provider_record_hash,
          evidenceHash: row.evidence_hash,
        }))
      : [];
    const facilityClaims = tableExists(database, "facilities")
      ? database.prepare(tableHasColumns(database, "facilities", ["source_id", "source_snapshot_id", "provider_record_hash", "evidence_hash"])
        ? `
          SELECT id, station_id, type, source_id, source_snapshot_id,
                 provider_record_hash, evidence_hash
          FROM facilities
          ORDER BY station_id, type, id
        `
        : `SELECT id, station_id, type, '' AS source_id, '' AS source_snapshot_id,
                  '' AS provider_record_hash, '' AS evidence_hash
           FROM facilities ORDER BY station_id, type, id`).all().map((row) => ({
          claimId: row.id,
          stationId: row.station_id,
          lineId: "",
          facilityType: row.type,
          domain: "FACILITY",
          evidenceKind: "EXISTS",
          sourceId: row.source_id,
          sourceSnapshotId: row.source_snapshot_id,
          providerRecordHash: row.provider_record_hash,
          evidenceHash: row.evidence_hash,
        }))
      : [];
    const exitClaims = tableExists(database, "station_exits")
      ? database.prepare(tableHasColumns(database, "station_exits", ["source_id", "source_snapshot_id"])
        ? `
          SELECT id, station_id, source_id, source_snapshot_id,
                 '' AS provider_record_hash, '' AS evidence_hash
          FROM station_exits
          WHERE has_elevator_connection = 1
          ORDER BY station_id, id
        `
        : `SELECT id, station_id, '' AS source_id, '' AS source_snapshot_id,
                  '' AS provider_record_hash, '' AS evidence_hash
           FROM station_exits WHERE has_elevator_connection = 1 ORDER BY station_id, id`).all().map((row) => ({
          claimId: row.id,
          stationId: row.station_id,
          lineId: "",
          facilityType: "ELEVATOR_CONNECTION",
          domain: "STATION_EXIT",
          evidenceKind: "EXISTS",
          sourceId: row.source_id,
          sourceSnapshotId: row.source_snapshot_id,
          providerRecordHash: row.provider_record_hash,
          evidenceHash: row.evidence_hash,
        }))
      : [];
    const edgeClaims = tableExists(database, "network_edges")
      ? database.prepare(tableHasColumns(database, "network_edges", ["source_id", "source_snapshot_id", "provider_record_hash", "evidence_hash"])
        ? `
          SELECT id, from_node_id, to_node_id, edge_type, accessibility_status,
                 source_id, source_snapshot_id, provider_record_hash, evidence_hash
          FROM network_edges
          WHERE edge_type <> 'RIDE'
          ORDER BY id
        `
        : `SELECT id, from_node_id, to_node_id, edge_type, accessibility_status,
                  '' AS source_id, '' AS source_snapshot_id, '' AS provider_record_hash,
                  '' AS evidence_hash
           FROM network_edges WHERE edge_type <> 'RIDE' ORDER BY id`).all().map(routeEdgeClaim)
      : [];
    const internalEdgeClaims = tableExists(database, "internal_route_edges")
      ? database.prepare(tableHasColumns(database, "internal_route_edges", ["source_id", "source_snapshot_id", "provider_record_hash", "evidence_hash"])
        ? `
          SELECT id, from_node_id, to_node_id, edge_type, accessibility_status,
                 source_id, source_snapshot_id, provider_record_hash, evidence_hash
          FROM internal_route_edges
          WHERE accessibility_status <> 'UNKNOWN'
          ORDER BY id
        `
        : `SELECT id, from_node_id, to_node_id, edge_type, accessibility_status,
                  '' AS source_id, '' AS source_snapshot_id, '' AS provider_record_hash,
                  '' AS evidence_hash
           FROM internal_route_edges WHERE accessibility_status <> 'UNKNOWN' ORDER BY id`).all().map(routeEdgeClaim)
      : [];
    const pathwayEdgeClaims = tableExists(database, "station_pathway_edges")
      && tableExists(database, "station_pathway_nodes")
      ? database.prepare(`
          SELECT edge.id, COALESCE(node.station_id, other.station_id, '') AS station_id,
                 COALESCE(node.line_id, other.line_id, '') AS line_id,
                 edge.edge_type, edge.accessibility_status,
                 ${provenanceColumns(database, "station_pathway_edges", "edge")}
          FROM station_pathway_edges edge
          LEFT JOIN station_pathway_nodes node ON node.id = edge.from_node_id
          LEFT JOIN station_pathway_nodes other ON other.id = edge.to_node_id
          WHERE edge.accessibility_status <> 'UNKNOWN'
          ORDER BY edge.id
        `).all().map((row) => ({
          claimId: row.id,
          stationId: row.station_id,
          lineId: row.line_id,
          facilityType: row.edge_type,
          domain: "NETWORK_EDGE",
          evidenceKind: row.accessibility_status === "NO_OFFICIAL_FEED" ? "NOT_EXISTS" : "EXISTS",
          sourceId: row.source_id,
          sourceSnapshotId: row.source_snapshot_id,
          providerRecordHash: row.provider_record_hash,
          evidenceHash: row.evidence_hash,
        }))
      : [];
    const outsideTransferClaims = tableExists(database, "out_of_station_transfer_links")
      ? database.prepare(`
          SELECT link.id, link.from_station_id AS station_id, link.from_line_id AS line_id,
                 link.accessibility_status,
                 ${provenanceColumns(database, "out_of_station_transfer_links", "link")}
          FROM out_of_station_transfer_links link
          WHERE link.accessibility_status <> 'UNKNOWN'
          ORDER BY link.id
        `).all().map((row) => ({
          claimId: row.id,
          stationId: row.station_id,
          lineId: row.line_id,
          facilityType: "OUT_OF_STATION_TRANSFER",
          domain: "NETWORK_EDGE",
          evidenceKind: row.accessibility_status === "NO_OFFICIAL_FEED" ? "NOT_EXISTS" : "EXISTS",
          sourceId: row.source_id,
          sourceSnapshotId: row.source_snapshot_id,
          providerRecordHash: row.provider_record_hash,
          evidenceHash: row.evidence_hash,
        }))
      : [];
    const claims = [
      ...evidenceClaims,
      ...facilityClaims,
      ...exitClaims,
      ...edgeClaims,
      ...internalEdgeClaims,
      ...pathwayEdgeClaims,
      ...outsideTransferClaims,
    ].map((claim) => {
      const stationName = stationNames.get(claim.stationId);
      return stationName ? { ...claim, stationName } : claim;
    });
    return {
      artifactId,
      sqliteSha256,
      searchableStationIds,
      ...(stationLines ? { stationLines } : {}),
      claims,
    };
  } finally {
    database.close();
  }
}

function routeEdgeClaim(row) {
  const nodeId = [row.from_node_id, row.to_node_id].find((value) => String(value).includes(":"))
    ?? row.from_node_id;
  return {
    claimId: row.id,
    stationId: String(nodeId).split(":")[0],
    lineId: String(nodeId).split(":")[1] ?? "",
    facilityType: row.edge_type,
    domain: "NETWORK_EDGE",
    evidenceKind: row.accessibility_status === "NO_OFFICIAL_FEED" ? "NOT_EXISTS" : "EXISTS",
    sourceId: row.source_id,
    sourceSnapshotId: row.source_snapshot_id,
    providerRecordHash: row.provider_record_hash,
    evidenceHash: row.evidence_hash,
  };
}

function tableExists(database, table) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function tableHasColumns(database, table, columns) {
  const available = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map(({ name }) => name));
  return columns.every((column) => available.has(column));
}

function provenanceColumns(database, table, alias) {
  return tableHasColumns(database, table, [
    "source_id", "source_snapshot_id", "provider_record_hash", "evidence_hash",
  ])
    ? `${alias}.source_id, ${alias}.source_snapshot_id,
       ${alias}.provider_record_hash, ${alias}.evidence_hash`
    : "'' AS source_id, '' AS source_snapshot_id, '' AS provider_record_hash, '' AS evidence_hash";
}

function resolvePackPath(root, pack) {
  const relativePath = pack.asset ?? pack.path ?? localManifestAsset(pack.url);
  if (typeof relativePath !== "string" || relativePath === "") {
    throw new Error(`pack ${pack.id ?? "<unknown>"} has no local asset`);
  }
  return path.resolve(root, relativePath);
}

function localManifestAsset(url) {
  try {
    const name = path.basename(new URL(url).pathname);
    return name ? path.join("catalog", name) : undefined;
  } catch {
    return undefined;
  }
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateSource(source, snapshotsByIdentity, policiesByIdentity, evaluatedMillis, violations) {
  const evidence = source.accessibilityAdmissionEvidence;
  if (source.productionUseAllowed !== true
    || source.license?.redistributionAllowed !== true
    || typeof source.license?.attribution !== "string"
    || source.license.attribution.trim() === "") {
    violations.license.push(`${source.id}:LICENSE_NOT_REDISTRIBUTABLE`);
  }
  if (!evidence) {
    violations.snapshot.push(`${source.id}:SNAPSHOT_IDENTITY_MISSING`);
    return;
  }
  if (!sha256(evidence.licenseEvidenceHash)
    || evidence.licenseEvidenceHash !== source.admissionEvidence?.licenseEvidenceHash) {
    violations.license.push(`${source.id}:LICENSE_EVIDENCE_MISMATCH`);
  }
  if (evidence.decision !== "APPROVED" || evidence.productionUseAllowed !== true) {
    violations.provenance.push(`${source.id}:ACCESSIBILITY_ADMISSION_NOT_APPROVED`);
  }
  const capturedMillis = Date.parse(evidence.capturedAt);
  const observedMillis = Date.parse(evidence.observedAt);
  const freshUntilMillis = Date.parse(evidence.freshUntil);
  if (!Number.isFinite(capturedMillis)
    || !Number.isFinite(observedMillis)
    || !Number.isFinite(freshUntilMillis)
    || capturedMillis > evaluatedMillis
    || observedMillis > evaluatedMillis) {
    violations.freshness.push(`${source.id}:SNAPSHOT_TIME_INVALID`);
  }
  const snapshot = snapshotsByIdentity.get(`${source.id}\0${evidence.snapshotId}`);
  if (!snapshot || [
    "snapshotPath",
    "capturedAt",
    "observedAt",
    "freshUntil",
    "rawSha256",
    "contentSha256",
    "schemaFingerprint",
    "snapshotFileSha256",
    "absenceEvidenceMode",
  ].some((key) => snapshot[key] !== evidence[key])
    || !sha256(evidence.rawSha256)
    || !sha256(evidence.contentSha256)) {
    violations.snapshot.push(`${source.id}:SNAPSHOT_IDENTITY_MISMATCH`);
  }
  const policy = policiesByIdentity.get(`${source.id}\0${evidence.snapshotId}`);
  if (!policy
    || policy.snapshotStatus !== "LOCKED"
    || policy.fetchStatus !== "SUCCESS"
    || policy.schemaStatus !== "PASS"
    || policy.licenseStatus !== "PASS") {
    violations.snapshot.push(`${source.id}:SNAPSHOT_POLICY_MISMATCH`);
  } else if (!Number.isFinite(Date.parse(policy.freshnessExpiresAt))
    || evaluatedMillis >= Date.parse(policy.freshnessExpiresAt)) {
    violations.freshness.push(`${source.id}:SNAPSHOT_STALE`);
  }
}

function validateClaim(artifact, claim, sources, snapshotsByIdentity, violations) {
  const claimId = `${artifact.artifactId}:${claim.stationId}|${claim.lineId ?? ""}|${claim.facilityType}|${claim.domain}`;
  const source = sources.get(claim.sourceId);
  const evidence = source?.accessibilityAdmissionEvidence;
  const provenanceMissing = !source
    || !claim.sourceId
    || claim.sourceSnapshotId !== evidence?.snapshotId
    || !sha256(claim.providerRecordHash)
    || !sha256(claim.evidenceHash);
  let valid = true;
  if (provenanceMissing) {
    violations.provenance.push(`${claimId}:PROVENANCE_MISSING`);
    valid = false;
  } else {
    const snapshot = snapshotsByIdentity.get(`${claim.sourceId}\0${claim.sourceSnapshotId}`);
    if (!claimMatchesSnapshot(snapshot, claim)) {
      violations.provenance.push(`${claimId}:CLAIM_SNAPSHOT_BINDING_MISMATCH`);
      valid = false;
    }
  }
  if (placeholderHash(claim.providerRecordHash) || placeholderHash(claim.evidenceHash)) {
    violations.placeholder.push(`${claimId}:EVIDENCE_HASH_PLACEHOLDER`);
    valid = false;
  }
  if (claim.evidenceKind === "NOT_EXISTS"
    && !ABSENCE_EVIDENCE_MODES.has(evidence?.absenceEvidenceMode)) {
    violations.absenceEvidence.push(`${claimId}:ABSENCE_EVIDENCE_MISSING`);
    valid = false;
  }
  return valid;
}

function claimMatchesSnapshot(snapshot, claim) {
  if (!snapshot) return false;
  if (Array.isArray(snapshot.claimBindings)) {
    return snapshot.claimBindings.some((binding) => [
      "stationId", "lineId", "facilityType", "providerRecordHash", "evidenceHash",
    ].every((field) => binding[field] === claim[field]));
  }
  if (snapshot.artifactKind === "kric-accessibility-snapshot") {
    const code = { ELEVATOR: "EV", ESCALATOR: "ES", WHEELCHAIR_LIFT: "WCLF" }[claim.facilityType];
    if (!code) return false;
    return (snapshot.queries ?? []).filter((query) => query.stationId === claim.stationId
      && (!claim.lineId || query.lineId === claim.lineId)).some((query) => {
      const tuple = { railOprIsttCd: query.railOprIsttCd, lnCd: query.lnCd, stinCd: query.stinCd };
      const rows = (query.rows ?? []).filter(({ gubun }) => gubun === code);
      if (rows.length > 0) return claim.evidenceKind === "EXISTS" && rows.some((row) => {
        const providerRecordHash = digest(JSON.stringify(row));
        return providerRecordHash === claim.providerRecordHash
          && digest(JSON.stringify({ snapshotId: snapshot.snapshotId, query: tuple, providerRecordHash })) === claim.evidenceHash;
      });
      return claim.evidenceKind === "NOT_EXISTS"
        && query.providerRecordHash === claim.providerRecordHash
        && digest(JSON.stringify({
          snapshotId: snapshot.snapshotId,
          query: tuple,
          type: claim.facilityType,
          evidenceKind: "NOT_EXISTS",
        })) === claim.evidenceHash;
    });
  }
  if (snapshot.artifactKind === "seoul-accessibility-snapshot") {
    const lineNumber = String(claim.lineId ?? "").match(/(\d+)$/)?.[1];
    const lineName = lineNumber ? `${lineNumber}호선` : null;
    const matchingStations = lineName && claim.stationName
      ? (snapshot.stations ?? []).filter((station) => normalizeStationName(station.stationName) === normalizeStationName(claim.stationName)
        && station.lineName === lineName)
      : [];
    const absentHash = lineNumber
      ? digest(JSON.stringify({ stationId: claim.stationId, lineName, status: "NOT_COVERED" }))
      : null;
    if (claim.evidenceKind === "NOT_EXISTS") {
      if (!claim.stationName || matchingStations.length > 0 || claim.providerRecordHash !== absentHash) return false;
    } else if (!matchingStations.some((station) => digest(JSON.stringify(station)) === claim.providerRecordHash)) {
      return false;
    }
    const expectedEvidenceHash = claim.domain === "NETWORK_EDGE"
      ? digest(JSON.stringify({
        edgeId: claim.claimId,
        sourceSnapshotId: snapshot.snapshotId,
        providerRecordHash: claim.providerRecordHash,
      }))
      : digest(JSON.stringify({
        snapshotId: snapshot.snapshotId,
        stationId: claim.stationId,
        lineId: claim.lineId,
        providerRecordHash: claim.providerRecordHash,
      }));
    return expectedEvidenceHash === claim.evidenceHash;
  }
  return false;
}

function normalizeStationName(value) {
  return String(value ?? "").normalize("NFKC").replace(/역$/u, "").replace(/[^\p{L}\p{N}]+/gu, "");
}

function sha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function placeholderHash(value) {
  return typeof value === "string" && /^([0-9a-f])\1{63}$/.test(value);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  return JSON.stringify(value, (_key, inner) => inner && typeof inner === "object" && !Array.isArray(inner)
    ? Object.fromEntries(Object.entries(inner).sort(([left], [right]) => compareStrings(left, right)))
    : inner);
}

async function main(argv) {
  const args = parseArgs(argv);
  for (const name of ["manifest", "bundled-index", "inventory", "source-snapshots", "evaluation-at", "output"]) {
    if (!args[name]) throw new Error(`missing --${name}`);
  }
  if (args["station-domain-gate"] !== undefined && args["station-domain-gate"] !== "true") {
    throw new Error("--station-domain-gate must be true");
  }
  const gateEnabled = args["station-domain-gate"] === "true";
  if (gateEnabled && ["molit-transfer-metadata", "kric-provider-code-catalog", "candidate-build-spec"]
    .some((name) => !args[name])) {
    throw new Error("station domain gate inputs are required");
  }
  if (args["expected-station-domain-decision"]
    && (!gateEnabled || !new Set(["GO", "NO_GO"]).has(args["expected-station-domain-decision"]))) {
    throw new Error("--expected-station-domain-decision requires the gate and must be GO or NO_GO");
  }
  const inventoryBytes = await readFile(args.inventory);
  const [manifest, bundledIndex, sourceSnapshotPolicies] = await Promise.all([
    readJson(args.manifest),
    readJson(args["bundled-index"]),
    readJson(args["source-snapshots"]),
  ]);
  const inventory = JSON.parse(inventoryBytes);
  const artifacts = await loadSelectableAccessibilityArtifacts({
    manifest,
    manifestRoot: args["manifest-root"] ?? manifestAssetRoot(args.manifest),
    bundledIndex,
    bundledRoot: args["bundled-root"] ?? packAssetRoot(args["bundled-index"]),
  });
  const referencedSourceIds = new Set(
    artifacts.flatMap(({ claims }) => claims).map(({ sourceId }) => sourceId).filter(Boolean),
  );
  const snapshots = await loadAccessibilityAdmissionSnapshots({
    sources: inventory.sources,
    referencedSourceIds,
    repositoryRoot: path.resolve(path.dirname(args.inventory), "../.."),
  });
  let molitTransferSnapshot;
  let providerCodeCatalog;
  if (gateEnabled) {
    [providerCodeCatalog, molitTransferSnapshot] = await Promise.all([
      readJson(args["kric-provider-code-catalog"]),
      loadMolitTransferSnapshot({
        metadataPath: args["molit-transfer-metadata"],
        inventory,
        inventoryBytes,
        candidateBuildSpec: await readJson(args["candidate-build-spec"]),
        repositoryRoot: path.resolve(path.dirname(args.inventory), "../.."),
        evaluatedAt: args["evaluation-at"],
      }),
    ]);
    validateKricProviderCodeCatalogIdentity(providerCodeCatalog);
  }
  const report = buildAccessibilitySourceCoverageReport({
    artifacts,
    inventory,
    snapshots,
    sourceSnapshotPolicies,
    evaluatedAt: args["evaluation-at"],
    molitTransferSnapshot,
    providerCodeCatalog,
  });
  await mkdir(path.dirname(args.output), { recursive: true });
  await writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`);
  if (args["expected-station-domain-decision"]
    ? Object.values(report.violations).some((values) => values.length > 0)
      || report.stationDomainSourceGate.decision !== args["expected-station-domain-decision"]
    : report.decision !== "GO") process.exitCode = 1;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!name?.startsWith("--") || argv[index + 1] === undefined) throw new Error("invalid arguments");
    args[name.slice(2)] = argv[index + 1];
  }
  return args;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function packAssetRoot(indexPath) {
  return path.resolve(path.dirname(indexPath), "../..");
}

export function manifestAssetRoot(manifestPath) {
  return path.dirname(manifestPath);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
