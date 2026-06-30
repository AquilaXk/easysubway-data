#!/usr/bin/env node
import { createHash, createSign } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { tmpdir } from "node:os";
import { usesLocalPlaceholderHost } from "./production-url-policy.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const productionMinimumTableRowNames = [
  "stations",
  "station_lines",
  "network_edges",
  "facilities",
  "station_facility_evidence",
];
const candidateBuildSpecArtifactKind = "datapack-candidate-build-spec";
const candidateBuildSpecHashFields = [
  "sourceSnapshotSetHash",
  "approvedAliasLedgerHash",
  "facilityEvidenceLedgerHash",
  "routeEvidenceLedgerHash",
  "approvedOverrideSetHash",
  "sourceInventorySha256",
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = path.resolve(root, requireArg(args, "output"));
  const { fixture, candidateBuild } = await loadBuildInput(args);
  const schema = await readFile(path.join(root, "tools/datapack/schema/catalog-schema.sql"), "utf8");

  validateFixture(fixture);
  await mkdir(outputDir, { recursive: true });

  const manifestPacks = [];
  const provenancePacks = [];
  for (const pack of fixture.packs) {
    const artifactKind = pack.artifactKind ?? "fixture";
    const packUrl = pack.url ?? `catalog/${pack.id}-v${pack.version}.sqlite.gz`;
    validatePackUrl(packUrl, "pack.url");
    validatePackUrlMatchesStagedPath(packUrl, pack, "pack.url");
    const outputPackPath = outputPathForPack(outputDir, packUrl, pack);
    const sqlitePath = outputPackPath.replace(/\.gz$/, "");
    const compressedPath = outputPackPath;

    await mkdir(path.dirname(sqlitePath), { recursive: true });
    await rm(sqlitePath, { force: true });
    await rm(compressedPath, { force: true });

    buildSqlitePack(sqlitePath, schema, pack);

    const sqliteBytes = await readFile(sqlitePath);
    const compressedBytes = gzipSync(sqliteBytes, { level: 9, mtime: 0 });
    await writeFile(compressedPath, compressedBytes);
    const compressedSha256 = sha256(compressedBytes);
    const sqliteSha256 = sha256(sqliteBytes);
    const sizeBytes = compressedBytes.length;
    const representativeRouteRegressions = canonicalRepresentativeRouteRegressions(
      pack.representativeRouteRegressions,
    );

    const manifestPack = {
      id: pack.id,
      version: pack.version,
      artifactKind,
      url: packUrl,
      sha256: compressedSha256,
      sqliteSha256,
      sizeBytes,
      signature: packSignature({
        id: pack.id,
        version: pack.version,
        manifestVersion: fixture.manifest.manifestVersion ?? 1,
        artifactKind,
        url: packUrl,
        sha256: compressedSha256,
        sqliteSha256,
        sizeBytes,
      }),
      schemaVersion: pack.schemaVersion,
      sourceInventory: pack.sourceInventory,
      regionalQualityMetrics: regionalQualityMetrics(pack),
      representativeRouteRegressions,
      representativeRouteRegressionSignature: representativeRouteRegressionSignature({
        id: pack.id,
        version: pack.version,
        artifactKind,
        url: packUrl,
        sha256: compressedSha256,
        sqliteSha256,
        sizeBytes,
        representativeRouteRegressions,
      }),
      requiredTables: pack.requiredTables,
      minimumTableRows: pack.minimumTableRows ?? {},
    };
    manifestPacks.push(manifestPack);
    provenancePacks.push(packFieldProvenance(pack, {
      artifactKind,
      sqliteSha256,
    }));
  }

  const manifest = {
    ...(fixture.manifest.manifestVersion === 2
      ? {
          manifestVersion: 2,
          channel: requiredString(fixture.manifest.channel, "manifest.channel"),
          releaseSequence: optionalPositiveInteger(fixture.manifest.releaseSequence, "manifest.releaseSequence")
            ?? defaultReleaseSequence(),
          publishedAt: optionalUtcDateString(fixture.manifest.publishedAt, "manifest.publishedAt") ?? buildPublishedAt(),
          expiresAt: optionalUtcDateString(fixture.manifest.expiresAt, "manifest.expiresAt")
            ?? buildExpiresAt(fixture.manifest.publishedAt),
          keyId: requiredString(fixture.manifest.keyId, "manifest.keyId"),
        }
      : {}),
    ttlSeconds: fixture.manifest.ttlSeconds,
    packs: manifestPacks,
  };
  if (fixture.manifest.activePack !== undefined) {
    manifest.activePack = fixture.manifest.activePack;
  }
  if (fixture.manifest.emergencyOverride !== undefined) {
    manifest.emergencyOverride = fixture.manifest.emergencyOverride;
  }
  if (fixture.manifest.manifestVersion === 2) {
    manifest.signature = manifestSignature(manifest, manifestPacks);
  }

  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(outputDir, "current.json"), manifestJson);
  await writeFile(
    path.join(outputDir, "current.provenance.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      artifactKind: "datapack-field-provenance",
      manifestSha256: sha256(Buffer.from(manifestJson)),
      ...(candidateBuild ? { candidateBuild } : {}),
      packs: provenancePacks,
    }, null, 2)}\n`,
  );
}

async function loadBuildInput(args) {
  const fixtureArg = args.fixture;
  const buildSpecArg = args["build-spec"];
  if ((fixtureArg == null) === (buildSpecArg == null)) {
    throw new Error("exactly one of --fixture or --build-spec is required");
  }
  if (fixtureArg != null) {
    return {
      fixture: JSON.parse(await readFile(path.resolve(root, fixtureArg), "utf8")),
      candidateBuild: null,
    };
  }

  const buildSpecPath = await resolveBuildInputPath(buildSpecArg, "buildSpec");
  const buildSpecBytes = await readFile(buildSpecPath);
  const buildSpec = JSON.parse(buildSpecBytes);
  await validateCandidateBuildSpec(buildSpec);
  return {
    fixture: JSON.parse(await readFile(await resolveBuildInputPath(buildSpec.fixturePath, "buildSpec.fixturePath"), "utf8")),
    candidateBuild: candidateBuildProvenance(buildSpec, sha256(buildSpecBytes)),
  };
}

async function validateCandidateBuildSpec(buildSpec) {
  if (!buildSpec || typeof buildSpec !== "object" || Array.isArray(buildSpec)) {
    throw new Error("buildSpec must be an object");
  }
  if (buildSpec.schemaVersion !== 1) {
    throw new Error("buildSpec.schemaVersion must be 1");
  }
  if (requiredString(buildSpec.artifactKind, "buildSpec.artifactKind") !== candidateBuildSpecArtifactKind) {
    throw new Error(`buildSpec.artifactKind must be ${candidateBuildSpecArtifactKind}`);
  }
  requiredString(buildSpec.candidateId, "buildSpec.candidateId");
  requiredString(buildSpec.productionScopeId, "buildSpec.productionScopeId");
  await resolveBuildInputPath(buildSpec.fixturePath, "buildSpec.fixturePath");
  requiredStringArray(buildSpec.sourceSnapshotIds, "buildSpec.sourceSnapshotIds");
  for (const field of candidateBuildSpecHashFields) {
    sha256HexString(buildSpec[field], `buildSpec.${field}`);
  }
  const builderGitSha = requiredString(buildSpec.builderGitSha, "buildSpec.builderGitSha");
  if (!/^[a-f0-9]{7,40}$/i.test(builderGitSha)) {
    throw new Error("buildSpec.builderGitSha must be a git sha");
  }
  requiredString(buildSpec.builderVersion, "buildSpec.builderVersion");
}

function candidateBuildProvenance(buildSpec, buildSpecSha256) {
  const normalizedHashes = Object.fromEntries(candidateBuildSpecHashFields.map((field) => [
    field,
    sha256HexString(buildSpec[field], `buildSpec.${field}`),
  ]));
  return {
    schemaVersion: buildSpec.schemaVersion,
    artifactKind: requiredString(buildSpec.artifactKind, "buildSpec.artifactKind"),
    candidateId: requiredString(buildSpec.candidateId, "buildSpec.candidateId"),
    productionScopeId: requiredString(buildSpec.productionScopeId, "buildSpec.productionScopeId"),
    buildSpecSha256,
    sourceSnapshotIds: requiredStringArray(buildSpec.sourceSnapshotIds, "buildSpec.sourceSnapshotIds"),
    sourceSnapshotSetHash: normalizedHashes.sourceSnapshotSetHash,
    approvedAliasLedgerHash: normalizedHashes.approvedAliasLedgerHash,
    facilityEvidenceLedgerHash: normalizedHashes.facilityEvidenceLedgerHash,
    routeEvidenceLedgerHash: normalizedHashes.routeEvidenceLedgerHash,
    approvedOverrideSetHash: normalizedHashes.approvedOverrideSetHash,
    sourceInventorySha256: normalizedHashes.sourceInventorySha256,
    builderGitSha: requiredString(buildSpec.builderGitSha, "buildSpec.builderGitSha"),
    builderVersion: requiredString(buildSpec.builderVersion, "buildSpec.builderVersion"),
  };
}

async function resolveBuildInputPath(value, label) {
  const resolved = path.resolve(root, requiredString(value, label));
  const canonicalPath = await realpath(resolved);
  if (!(await isWithinAllowedBuildInputRoot(canonicalPath))) {
    throw new Error(`${label} must stay inside repository or temp directory`);
  }
  return canonicalPath;
}

async function isWithinAllowedBuildInputRoot(resolvedPath) {
  const allowedRoots = await allowedBuildInputRoots();
  return allowedRoots.some((allowedRoot) => {
    const relative = path.relative(allowedRoot, resolvedPath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

async function allowedBuildInputRoots() {
  const candidateRoots = [root, tmpdir(), process.env.RUNNER_TEMP]
    .filter((value) => typeof value === "string" && value.trim() !== "")
    .map((value) => path.resolve(value));
  const canonicalRoots = [];
  for (const candidateRoot of candidateRoots) {
    try {
      canonicalRoots.push(await realpath(candidateRoot));
    } catch {
      // Optional CI temp roots may be absent in local runs.
    }
  }
  return canonicalRoots;
}

function packFieldProvenance(pack, { artifactKind, sqliteSha256 }) {
  const sourceUpdatedAt = new Map((pack.sourceInventory ?? []).map((source) => [source.id, source.updatedAt]));
  const sourceFields = new Map((pack.sourceInventory ?? []).map((source) => [source.id, new Set(source.fields ?? [])]));
  const sourceScopes = sourceCoverageScopeMap(pack.sourceInventory ?? []);
  const defaultSourceId = pack.sourceInventory?.length === 1 ? pack.sourceInventory[0].id : "";
  const lineOperatorIds = new Map((pack.lines ?? []).map((line) => [line.id, line.operatorId]).filter(([, operatorId]) => operatorId));
  const stationLineOperatorIds = new Map();
  const stationOperatorIds = new Map();
  for (const stationLine of pack.stationLines ?? []) {
    const operatorId = lineOperatorIds.get(stationLine.lineId);
    if (!operatorId) {
      continue;
    }
    stationLineOperatorIds.set(`${stationLine.stationId}:${stationLine.lineId}`, operatorId);
    const operators = stationOperatorIds.get(stationLine.stationId) ?? new Set();
    operators.add(operatorId);
    stationOperatorIds.set(stationLine.stationId, operators);
  }
  const records = [];
  const addRecord = (row, entityType, entityId, field, operatorIds = []) => {
    const sourceId = row.sourceId ?? defaultSourceId;
    if (!sourceId) {
      return;
    }
    const coverageScope = recordCoverageScope(sourceScopes.get(sourceId), operatorIds);
    const recordDerivationKind =
      entityType === "facility" && field === "status" && !sourceFields.get(sourceId)?.has("status")
        ? "GENERATED"
        : derivationKind(row, artifactKind);
    records.push({
      entityType,
      entityId,
      field,
      sourceId,
      ...(row.sourceSnapshotId ? { sourceSnapshotId: row.sourceSnapshotId } : {}),
      ...(row.providerRecordHash ? { providerRecordHash: row.providerRecordHash } : {}),
      ...(row.evidenceHash ? { evidenceHash: row.evidenceHash } : {}),
      ...(coverageScope ? { coverageScope } : {}),
      derivationKind: recordDerivationKind,
      verifiedAt: row.verifiedAt ?? row.lastVerifiedAt ?? row.reviewedAt ?? row.updatedAt ?? sourceUpdatedAt.get(sourceId) ?? "",
    });
  };

  for (const station of pack.stations ?? []) {
    addRecord(station, "station", station.id, "station_name", [...(stationOperatorIds.get(station.id) ?? [])]);
  }
  for (const stationLine of pack.stationLines ?? []) {
    const entityId = `${stationLine.stationId}:${stationLine.lineId}`;
    const operatorIds = [lineOperatorIds.get(stationLine.lineId)].filter(Boolean);
    addRecord(stationLine, "station_line", entityId, "line", operatorIds);
    addRecord(stationLine, "station_line", entityId, "station_code", operatorIds);
  }
  for (const edge of pack.networkEdges ?? []) {
    const operatorIds = operatorIdsForNodes([edge.fromNodeId, edge.toNodeId], stationLineOperatorIds);
    addRecord(edge, "network_edge", edge.id, "network_edges", operatorIds);
    addRecord(edge, "network_edge", edge.id, "duration_seconds", operatorIds);
    addRecord(edge, "network_edge", edge.id, "distance_meters", operatorIds);
  }
  for (const position of pack.routeMapPositions ?? []) {
    const entityId = `${position.stationId}:${position.lineId}:${position.region ?? ""}`;
    const operatorIds = [lineOperatorIds.get(position.lineId)].filter(Boolean);
    addRecord(position, "route_map_position", entityId, "route_map_position", operatorIds);
    if (Array.isArray(position.labelPolygon) && position.labelPolygon.length > 0) {
      addRecord(position, "route_map_position", entityId, "route_map_label_polygon", operatorIds);
    }
  }
  for (const facility of pack.facilities ?? []) {
    const operatorIds = [...(stationOperatorIds.get(facility.stationId) ?? [])];
    const field = facilityField(facility.type);
    if (field) {
      addRecord(facility, "facility", facility.id, field, operatorIds);
    }
    addRecord(facility, "facility", facility.id, "status", operatorIds);
    if (facility.verifiedAt || facility.lastVerifiedAt) {
      addRecord(facility, "facility", facility.id, "verified_at", operatorIds);
    }
  }
  for (const mapping of pack.realtimeProviderStationMappings ?? []) {
    if (mapping.supportsArrivals === true) {
      const operatorIds = [lineOperatorIds.get(mapping.lineId)].filter(Boolean);
      addRecord(
        mapping,
        "realtime_provider_station_mapping",
        `${mapping.providerId}:${mapping.providerStationId}`,
        "realtime_arrival_reference",
        operatorIds,
      );
    }
  }

  return {
    id: pack.id,
    version: pack.version,
    artifactKind,
    sqliteSha256,
    normalizedSourceInventorySha256: sha256(Buffer.from(JSON.stringify(pack.sourceInventory ?? []))),
    records: records.sort((left, right) =>
      `${left.entityType}:${left.entityId}:${left.field}:${left.sourceId}`.localeCompare(
        `${right.entityType}:${right.entityId}:${right.field}:${right.sourceId}`,
      ),
    ),
  };
}

function sourceCoverageScopeMap(sourceInventory) {
  const scopes = new Map();
  for (const source of sourceInventory) {
    if (!source.coverageScope || typeof source.coverageScope !== "object" || Array.isArray(source.coverageScope)) {
      continue;
    }
    scopes.set(source.id, {
      regionIds: Array.isArray(source.coverageScope.regionIds) ? [...source.coverageScope.regionIds] : [],
      operatorIds: Array.isArray(source.coverageScope.operatorIds) ? [...source.coverageScope.operatorIds] : [],
      sourceDomains: Array.isArray(source.coverageScope.sourceDomains) ? [...source.coverageScope.sourceDomains] : [],
    });
  }
  return scopes;
}

function recordCoverageScope(sourceScope, operatorIds) {
  if (!sourceScope) {
    return null;
  }
  const scopedOperatorIds = sourceScope.operatorIds.filter((operatorId) => operatorIds.includes(operatorId));
  return {
    regionIds: sourceScope.regionIds,
    operatorIds: scopedOperatorIds.length > 0 ? scopedOperatorIds : sourceScope.operatorIds,
    sourceDomains: sourceScope.sourceDomains,
  };
}

function operatorIdsForNodes(nodeIds, stationLineOperatorIds) {
  return [
    ...new Set(
      nodeIds.map((nodeId) => stationLineOperatorIds.get(canonicalStationLineNodeId(nodeId))).filter(Boolean),
    ),
  ].sort();
}

function canonicalStationLineNodeId(nodeId) {
  const parts = String(nodeId).split(":");
  return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : nodeId;
}

function derivationKind(row, artifactKind) {
  if (["OFFICIAL", "FIELD_VERIFIED", "MANUAL_OVERRIDE", "GENERATED", "FIXTURE"].includes(row.derivationKind)) {
    return row.derivationKind;
  }
  if (artifactKind === "fixture") {
    return "FIXTURE";
  }
  if (row.provenanceKind === "OFFICIAL_SOURCE") {
    return "OFFICIAL";
  }
  if (row.provenanceKind === "OPERATOR_CONFIRMED" || row.provenanceKind === "FIELD_SURVEY") {
    return "FIELD_VERIFIED";
  }
  return "GENERATED";
}

function facilityField(type) {
  return {
    ELEVATOR: "elevator",
    ESCALATOR: "escalator",
    WHEELCHAIR_LIFT: "wheelchair_lift",
  }[type];
}

function outputPathForPack(outputDir, packUrl, pack) {
  if (/^https:\/\//.test(packUrl)) {
    return path.join(outputDir, stagedPackPath(pack));
  }
  return path.join(outputDir, packUrl);
}

function validatePackUrl(packUrl, label) {
  requiredString(packUrl, label);
  if (/%[0-9a-f]{2}/i.test(packUrl)) {
    throw new Error(`${label} must be a safe relative path or absolute HTTPS URL`);
  }
  if (/^https:\/\//.test(packUrl)) {
    if (!isAbsoluteHttpsWithHost(packUrl)) {
      throw new Error(`${label} must be a safe relative path or absolute HTTPS URL`);
    }
    return;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(packUrl) || packUrl.startsWith("/") || packUrl.startsWith("//") || packUrl.includes("\\")) {
    throw new Error(`${label} must be a safe relative path or absolute HTTPS URL`);
  }
  if (packUrl.split("/").includes("..")) {
    throw new Error(`${label} must be a safe relative path or absolute HTTPS URL`);
  }
  const normalized = path.posix.normalize(packUrl);
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`${label} must be a safe relative path or absolute HTTPS URL`);
  }
}

function validatePackUrlMatchesStagedPath(packUrl, pack, label) {
  if (!/^https:\/\//.test(packUrl)) {
    return;
  }
  const url = new URL(packUrl);
  const expectedPathSuffix = `/${stagedPackPath(pack)}`;
  if (!url.pathname.endsWith(expectedPathSuffix) || url.search !== "" || url.hash !== "") {
    throw new Error(`${label} absolute HTTPS URL path must end with ${stagedPackPath(pack)}`);
  }
}

function stagedPackPath(pack) {
  return `catalog/${pack.id}-v${pack.version}.sqlite.gz`;
}

function packSignature(pack) {
  if (pack.artifactKind === "production") {
    const canonical = productionSignaturePayload(pack);
    return {
      algorithm: pack.manifestVersion === 2 ? "rsa-sha256-pack-manifest-v2" : "rsa-sha256-pack-manifest-v1",
      value: rsaSha256Signature(signingPrivateKey(), canonical),
    };
  }
  return {
    algorithm: pack.manifestVersion === 2 ? "sha256-pack-manifest-v2" : "sha256-pack-manifest-v1",
    value: sha256(Buffer.from(fixtureSignaturePayload(pack))),
  };
}

function manifestSignature(manifest, packs) {
  const hasProductionPack = packs.some((pack) => pack.artifactKind === "production");
  const canonical = canonicalJson(withoutSignature(manifest));
  if (hasProductionPack) {
    return {
      algorithm: "rsa-sha256-manifest-v2",
      value: rsaSha256Signature(signingPrivateKey(), canonical),
    };
  }
  return {
    algorithm: "sha256-manifest-v2",
    value: sha256(Buffer.from(canonical)),
  };
}

function withoutSignature(value) {
  const copy = { ...value };
  delete copy.signature;
  return copy;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  throw new Error("manifest canonical value is unsupported");
}

function fixtureSignaturePayload(pack) {
  return `${pack.id}:${pack.version}:${pack.sha256}:${pack.sqliteSha256}:${pack.sizeBytes}`;
}

function productionSignaturePayload(pack) {
  return `${fixtureSignaturePayload(pack)}:${canonicalProductionPackUrl(pack.url)}`;
}

function representativeRouteRegressionSignature(pack) {
  if (pack.artifactKind === "production") {
    return {
      algorithm: "rsa-sha256-route-regression-v1",
      value: rsaSha256Signature(signingPrivateKey(), representativeRouteRegressionSignaturePayload(pack)),
    };
  }
  return {
    algorithm: "sha256-route-regression-v1",
    value: sha256(Buffer.from(representativeRouteRegressionSignaturePayload(pack))),
  };
}

function representativeRouteRegressionSignaturePayload(pack) {
  const basePayload = `${fixtureSignaturePayload(pack)}:${representativeRouteRegressionPayload(pack.representativeRouteRegressions)}`;
  if (pack.artifactKind === "production") {
    return `${basePayload}:${canonicalProductionPackUrl(pack.url)}`;
  }
  return basePayload;
}

function representativeRouteRegressionPayload(routes) {
  return JSON.stringify(canonicalRepresentativeRouteRegressions(routes));
}

function canonicalRepresentativeRouteRegressions(routes) {
  return routes.map((route) => ({
    id: requiredString(route.id, "representativeRouteRegressions.id"),
    pattern: requiredString(route.pattern, "representativeRouteRegressions.pattern"),
    fromNodeId: requiredString(route.fromNodeId, "representativeRouteRegressions.fromNodeId"),
    toNodeId: requiredString(route.toNodeId, "representativeRouteRegressions.toNodeId"),
    requiredEdgeIds: route.requiredEdgeIds.map((edgeId) =>
      requiredString(edgeId, "representativeRouteRegressions.requiredEdgeIds"),
    ),
  }));
}

function canonicalProductionPackUrl(packUrl) {
  return new URL(packUrl).toString();
}

function signingPrivateKey() {
  const key = process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM?.trim();
  if (!key) {
    throw new Error("EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM is required for production data pack signatures");
  }
  return key;
}

function rsaSha256Signature(privateKey, value) {
  return createSign("RSA-SHA256").update(value).sign(privateKey).toString("base64url");
}

function regionalQualityMetrics(pack) {
  const stationIds = new Set((pack.stations ?? []).map((station) => station.id));
  const stationCount = stationIds.size;
  const coveredStationIds = new Set(
    (pack.facilities ?? [])
      .map((facility) => facility.stationId)
      .filter((stationId) => stationIds.has(stationId)),
  );
  const edgeCount = pack.networkEdges?.length ?? 0;
  const unknownAccessibilityCount = (pack.networkEdges ?? []).filter(
    (edge) => normalizedAccessibilityStatus(edge.accessibilityStatus, "networkEdges.accessibilityStatus") === "UNKNOWN",
  ).length;
  return {
    stationCount,
    facilityCoverageRatio: stationCount === 0 ? 0 : Number((coveredStationIds.size / stationCount).toFixed(4)),
    edgeCount,
    unknownAccessibilityRatio: edgeCount === 0 ? 0 : Number((unknownAccessibilityCount / edgeCount).toFixed(4)),
  };
}

function buildSqlitePack(sqlitePath, schema, pack) {
  const database = new DatabaseSync(sqlitePath);
  const isProductionPack = pack.artifactKind === "production";
  try {
    database.exec(schema);
    database.exec("BEGIN IMMEDIATE");
    try {
      insertCatalogMetadata(database, pack);
      insertRows(database, "operators", ["id", "name_ko", "name_en"], pack.operators, (row) => [
        requiredString(row.id, "operators.id"),
        requiredString(row.nameKo, "operators.nameKo"),
        row.nameEn ?? "",
      ]);
      insertRows(database, "lines", ["id", "operator_id", "name_ko", "name_en", "color"], pack.lines, (row) => [
        requiredString(row.id, "lines.id"),
        requiredString(row.operatorId, "lines.operatorId"),
        requiredString(row.nameKo, "lines.nameKo"),
        row.nameEn ?? "",
        row.color ?? "",
      ]);
      insertRows(
        database,
        "stations",
        [
          "id",
          "name_ko",
          "name_en",
          "normalized_name",
          "region",
          "latitude",
          "longitude",
          "data_quality_level",
          "data_source_type",
          "last_verified_at",
        ],
        pack.stations,
        (row) => [
          requiredString(row.id, "stations.id"),
          requiredString(row.nameKo, "stations.nameKo"),
          row.nameEn ?? "",
          requiredString(row.normalizedName, "stations.normalizedName"),
          row.region ?? "",
          row.latitude ?? null,
          row.longitude ?? null,
          row.dataQualityLevel ?? "LEVEL_1",
          row.dataSourceType ?? "OFFICIAL_FILE",
          timestamp(row.lastVerifiedAt),
        ],
      );
      insertRows(database, "station_aliases", ["station_id", "alias", "normalized_alias"], pack.stationAliases ?? [], (row) => [
        requiredString(row.stationId, "stationAliases.stationId"),
        requiredString(row.alias, "stationAliases.alias"),
        requiredString(row.normalizedAlias, "stationAliases.normalizedAlias"),
      ]);
      insertRows(
        database,
        "station_lines",
        ["station_id", "line_id", "station_code", "line_sequence", "platform_info"],
        pack.stationLines,
        (row) => [
          requiredString(row.stationId, "stationLines.stationId"),
          requiredString(row.lineId, "stationLines.lineId"),
          row.stationCode ?? "",
          requiredInteger(row.lineSequence, "stationLines.lineSequence"),
          row.platformInfo ?? "",
        ],
      );
      insertRows(
        database,
        "realtime_provider_line_mappings",
        [
          "provider_id",
          "provider_line_id",
          "line_id",
          "source_id",
          "supports_arrivals",
          "supports_train_positions",
          "mapping_confidence",
          "updated_at",
        ],
        pack.realtimeProviderLineMappings ?? [],
        (row) => [
          requiredString(row.providerId, "realtimeProviderLineMappings.providerId"),
          requiredString(row.providerLineId, "realtimeProviderLineMappings.providerLineId"),
          requiredString(row.lineId, "realtimeProviderLineMappings.lineId"),
          requiredString(row.sourceId, "realtimeProviderLineMappings.sourceId"),
          boolFlag(row.supportsArrivals, "realtimeProviderLineMappings.supportsArrivals"),
          boolFlag(row.supportsTrainPositions, "realtimeProviderLineMappings.supportsTrainPositions"),
          row.mappingConfidence ?? "UNKNOWN",
          timestamp(row.updatedAt),
        ],
      );
      insertRows(
        database,
        "realtime_provider_station_mappings",
        [
          "provider_id",
          "provider_line_id",
          "provider_station_id",
          "station_id",
          "line_id",
          "source_id",
          "query_name",
          "supports_arrivals",
          "supports_train_positions",
          "mapping_confidence",
          "updated_at",
        ],
        pack.realtimeProviderStationMappings ?? [],
        (row) => [
          requiredString(row.providerId, "realtimeProviderStationMappings.providerId"),
          requiredString(row.providerLineId, "realtimeProviderStationMappings.providerLineId"),
          requiredString(row.providerStationId, "realtimeProviderStationMappings.providerStationId"),
          requiredString(row.stationId, "realtimeProviderStationMappings.stationId"),
          requiredString(row.lineId, "realtimeProviderStationMappings.lineId"),
          requiredString(row.sourceId, "realtimeProviderStationMappings.sourceId"),
          row.queryName ?? "",
          boolFlag(row.supportsArrivals, "realtimeProviderStationMappings.supportsArrivals"),
          boolFlag(row.supportsTrainPositions, "realtimeProviderStationMappings.supportsTrainPositions"),
          row.mappingConfidence ?? "UNKNOWN",
          timestamp(row.updatedAt),
        ],
      );
      insertRows(
        database,
        "network_edges",
        [
          "id",
          "from_node_id",
          "to_node_id",
          "duration_seconds",
          "distance_meters",
          "edge_type",
          "service_pattern",
          "includes_stairs",
          "stair_access_state",
          "accessibility_status",
          "reliability_score",
          "source_id",
          "source_snapshot_id",
          "provider_record_hash",
          "provenance_kind",
          "verification_status",
          "facility_id",
          "last_verified_at",
          "evidence_hash",
        ],
        pack.networkEdges ?? [],
        (row) => {
          const stairAccessState = row.stairAccessState ?? (row.includesStairs ? "STAIR_ONLY" : "UNKNOWN");
          const accessibilityStatus = normalizedAccessibilityStatus(
            row.accessibilityStatus,
            "networkEdges.accessibilityStatus",
          );

          return [
            requiredString(row.id, "networkEdges.id"),
            requiredString(row.fromNodeId, "networkEdges.fromNodeId"),
            requiredString(row.toNodeId, "networkEdges.toNodeId"),
            row.durationSeconds ?? 0,
            row.distanceMeters ?? 0,
            row.edgeType ?? "WALK",
            row.servicePattern ?? "",
            stairAccessState === "STAIR_ONLY" ? 1 : 0,
            stairAccessState,
            accessibilityStatus,
            row.reliabilityScore ?? 100,
            row.sourceId ?? "",
            row.sourceSnapshotId ?? "",
            row.providerRecordHash ?? "",
            row.provenanceKind ?? "UNKNOWN",
            row.verificationStatus ?? "UNKNOWN",
            row.facilityId ?? null,
            timestamp(row.verifiedAt ?? row.lastVerifiedAt),
            row.evidenceHash ?? "",
          ];
        },
      );
      insertRows(
        database,
        "route_map_positions",
        [
          "station_id",
          "line_id",
          "region",
          "x",
          "y",
          "label_dx",
          "label_dy",
          "label_polygon",
          "up_path",
          "down_path",
          "source_id",
          "source_name",
          "source_url",
          "license",
          "license_status",
          "commercial_use_allowed",
          "attribution_required",
          "reviewed_at",
          "updated_at",
        ],
        pack.routeMapPositions ?? [],
        (row) => [
          requiredString(row.stationId, "routeMapPositions.stationId"),
          requiredString(row.lineId, "routeMapPositions.lineId"),
          requiredString(row.region, "routeMapPositions.region"),
          requiredNonNegativeInteger(row.x, "routeMapPositions.x"),
          requiredNonNegativeInteger(row.y, "routeMapPositions.y"),
          row.labelDx ?? 0,
          row.labelDy ?? 0,
          canonicalLabelPolygon(row.labelPolygon, "routeMapPositions.labelPolygon"),
          row.upPath ?? "",
          row.downPath ?? "",
          requiredString(row.sourceId, "routeMapPositions.sourceId"),
          requiredString(row.sourceName, "routeMapPositions.sourceName"),
          requiredString(row.sourceUrl, "routeMapPositions.sourceUrl"),
          requiredString(row.license, "routeMapPositions.license"),
          requiredString(row.licenseStatus, "routeMapPositions.licenseStatus"),
          boolFlag(row.commercialUseAllowed, "routeMapPositions.commercialUseAllowed"),
          boolFlag(row.attributionRequired, "routeMapPositions.attributionRequired"),
          timestamp(row.reviewedAt),
          timestamp(row.updatedAt),
        ],
      );
      insertRows(database, "station_exits", ["id", "station_id", "exit_number", "description"], pack.stationExits ?? [], (row) => [
        requiredString(row.id, "stationExits.id"),
        requiredString(row.stationId, "stationExits.stationId"),
        requiredString(row.exitNumber, "stationExits.exitNumber"),
        row.description ?? "",
      ]);
      insertRows(
        database,
        "facilities",
        [
          "id",
          "station_id",
          "exit_id",
          "type",
          "name",
          "status",
          "floor_from",
          "floor_to",
          "description",
          "source_id",
          "source_snapshot_id",
          "provider_facility_ref",
          "provider_record_hash",
          "provenance_kind",
          "verified_at",
          "retrieved_at",
          "evidence_hash",
          "status_meaning",
          "operational_status",
          "installation_status",
          "confidence",
        ],
        pack.facilities ?? [],
        (row) => {
          const id = requiredString(row.id, "facilities.id");
          return [
            id,
            requiredString(row.stationId, "facilities.stationId"),
            row.exitId ?? null,
            requiredString(row.type, "facilities.type"),
            requiredString(row.name, "facilities.name"),
            row.status ?? "UNKNOWN",
            row.floorFrom ?? "",
            row.floorTo ?? "",
            row.description ?? "",
            productionFacilityString(row.sourceId, isProductionPack, "sourceId"),
            productionFacilityString(row.sourceSnapshotId, isProductionPack, "sourceSnapshotId"),
            productionFacilityString(row.providerFacilityRef, isProductionPack, "providerFacilityRef") || id,
            productionFacilityString(row.providerRecordHash, isProductionPack, "providerRecordHash"),
            productionFacilityString(row.provenanceKind, isProductionPack, "provenanceKind") || "UNKNOWN",
            productionFacilityTimestamp(row.verifiedAt ?? row.lastVerifiedAt, isProductionPack, "verifiedAt") ?? 0,
            productionFacilityTimestamp(row.retrievedAt, isProductionPack, "retrievedAt") ?? 0,
            productionFacilityString(row.evidenceHash, isProductionPack, "evidenceHash"),
            productionFacilityString(row.statusMeaning, isProductionPack, "statusMeaning"),
            facilityOperationalStatus(row, isProductionPack),
            facilityInstallationStatus(row, isProductionPack),
            row.confidence ?? 0,
          ];
        },
      );
      insertRows(
        database,
        "station_facility_evidence",
        [
          "station_id",
          "line_id",
          "facility_type",
          "evidence_kind",
          "source_id",
          "source_snapshot_id",
          "provider_record_hash",
          "evidence_hash",
          "provenance_kind",
          "installation_status",
          "operational_status",
          "status_meaning",
          "confidence",
          "verified_at",
          "retrieved_at",
          "strict_route_eligible",
          "strict_route_eligible_reason",
        ],
        pack.stationFacilityEvidence ?? [],
        (row) => [
          requiredString(row.stationId, "stationFacilityEvidence.stationId"),
          requiredString(row.lineId, "stationFacilityEvidence.lineId"),
          requiredString(row.facilityType, "stationFacilityEvidence.facilityType"),
          requiredString(row.evidenceKind, "stationFacilityEvidence.evidenceKind"),
          requiredString(row.sourceId, "stationFacilityEvidence.sourceId"),
          requiredString(row.sourceSnapshotId, "stationFacilityEvidence.sourceSnapshotId"),
          requiredString(row.providerRecordHash, "stationFacilityEvidence.providerRecordHash"),
          requiredString(row.evidenceHash, "stationFacilityEvidence.evidenceHash"),
          requiredString(row.provenanceKind, "stationFacilityEvidence.provenanceKind"),
          row.installationStatus ?? "UNKNOWN",
          row.operationalStatus ?? "UNKNOWN",
          row.statusMeaning ?? "",
          row.confidence ?? 0,
          timestamp(row.verifiedAt) ?? 0,
          timestamp(row.retrievedAt) ?? 0,
          boolFlag(row.strictRouteEligible, "stationFacilityEvidence.strictRouteEligible"),
          row.strictRouteEligibleReason ?? "",
        ],
      );
      insertRows(
        database,
        "station_accessibility_summaries",
        ["station_id", "summary", "warning"],
        pack.stationAccessibilitySummaries ?? [],
        (row) => [
          requiredString(row.stationId, "stationAccessibilitySummaries.stationId"),
          requiredString(row.summary, "stationAccessibilitySummaries.summary"),
          row.warning ?? "",
        ],
      );
      insertRows(database, "internal_route_nodes", ["id", "station_id", "label", "node_type"], pack.internalRouteNodes ?? [], (row) => [
        requiredString(row.id, "internalRouteNodes.id"),
        requiredString(row.stationId, "internalRouteNodes.stationId"),
        requiredString(row.label, "internalRouteNodes.label"),
        requiredString(row.nodeType, "internalRouteNodes.nodeType"),
      ]);
      insertRows(
        database,
        "internal_route_edges",
        [
          "id",
          "from_node_id",
          "to_node_id",
          "edge_type",
          "distance_meters",
          "duration_seconds",
          "includes_stairs",
          "requires_elevator",
          "requires_escalator",
          "slope_level",
          "width_level",
          "reliability_score",
          "accessibility_status",
          "source_id",
          "source_snapshot_id",
          "provider_record_hash",
          "provenance_kind",
          "verification_status",
          "facility_id",
          "last_verified_at",
          "evidence_hash",
          "instruction",
        ],
        pack.internalRouteEdges ?? [],
        (row) => [
          requiredString(row.id, "internalRouteEdges.id"),
          requiredString(row.fromNodeId, "internalRouteEdges.fromNodeId"),
          requiredString(row.toNodeId, "internalRouteEdges.toNodeId"),
          row.edgeType ?? "WALK",
          row.distanceMeters ?? 0,
          row.durationSeconds ?? 0,
          row.includesStairs ? 1 : 0,
          row.requiresElevator ? 1 : 0,
          row.requiresEscalator ? 1 : 0,
          row.slopeLevel ?? 1,
          row.widthLevel ?? 2,
          row.reliabilityScore ?? 100,
          normalizedAccessibilityStatus(row.accessibilityStatus, "internalRouteEdges.accessibilityStatus"),
          row.sourceId ?? "",
          row.sourceSnapshotId ?? "",
          row.providerRecordHash ?? "",
          row.provenanceKind ?? "UNKNOWN",
          row.verificationStatus ?? "UNKNOWN",
          row.facilityId ?? null,
          timestamp(row.verifiedAt ?? row.lastVerifiedAt) ?? 0,
          row.evidenceHash ?? "",
          row.instruction ?? "",
        ],
      );
      insertRows(
        database,
        "data_quality_records",
        ["id", "target_type", "target_id", "quality_level", "checked_at"],
        pack.dataQualityRecords ?? [],
        (row) => [
          requiredString(row.id, "dataQualityRecords.id"),
          requiredString(row.targetType, "dataQualityRecords.targetType"),
          requiredString(row.targetId, "dataQualityRecords.targetId"),
          requiredString(row.qualityLevel, "dataQualityRecords.qualityLevel"),
          timestamp(row.checkedAt),
        ],
      );
      database.exec("COMMIT");
      vacuum(database);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

function productionFacilityString(value, isProductionPack, field) {
  if (!isProductionPack) {
    return value ?? "";
  }
  return requiredString(value, `production facilities.${field}`);
}

function productionFacilityTimestamp(value, isProductionPack, field) {
  if (!isProductionPack) {
    return timestamp(value);
  }
  return timestamp(requiredString(value, `production facilities.${field}`));
}

function facilityOperationalStatus(row, isProductionPack) {
  if (isProductionPack) {
    return productionFacilityString(row.operationalStatus, isProductionPack, "operationalStatus");
  }
  if (row.operationalStatus) {
    return row.operationalStatus;
  }
  const status = String(row.status ?? "").toUpperCase();
  if (["NORMAL", "AVAILABLE", "IN_SERVICE", "OPERATING", "OPEN", "ADMIN_VERIFIED"].includes(status)) {
    return "AVAILABLE";
  }
  if (["BROKEN", "UNDER_CONSTRUCTION", "CLOSED", "UNAVAILABLE", "OUT_OF_SERVICE"].includes(status)) {
    return "UNAVAILABLE";
  }
  return "";
}

function facilityInstallationStatus(row, isProductionPack) {
  if (isProductionPack) {
    return productionFacilityString(row.installationStatus, isProductionPack, "installationStatus");
  }
  return row.installationStatus ?? "UNKNOWN";
}

function insertCatalogMetadata(database, pack) {
  const rows = [
    ["schemaVersion", pack.schemaVersion],
    ...Object.entries(pack.metadata ?? {}),
  ];
  const statement = database.prepare("INSERT INTO catalog_metadata (key, value, updated_at) VALUES (?, ?, ?)");
  const updatedAt = Date.UTC(2026, 5, 19) / 1000;
  for (const [key, value] of rows) {
    statement.run(key, String(value), updatedAt);
  }
}

function insertRows(database, table, columns, rows, mapRow) {
  const statement = database.prepare(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  );
  for (const row of rows ?? []) {
    statement.run(...mapRow(row));
  }
}

function vacuum(database) {
  database.exec("PRAGMA optimize");
  database.exec("VACUUM");
}

function validateFixture(fixture) {
  if (!fixture || typeof fixture !== "object") {
    throw new Error("fixture must be an object");
  }
  if (!fixture.manifest || typeof fixture.manifest !== "object" || Array.isArray(fixture.manifest)) {
    throw new Error("fixture manifest must be an object");
  }
  if (
    fixture.manifest.manifestVersion !== undefined &&
    fixture.manifest.manifestVersion !== 1 &&
    fixture.manifest.manifestVersion !== 2
  ) {
    throw new Error("manifest.manifestVersion must be 1 or 2");
  }
  if (!Number.isInteger(fixture.manifest?.ttlSeconds) || fixture.manifest.ttlSeconds <= 0) {
    throw new Error("manifest ttlSeconds must be a positive integer");
  }
  if (!Array.isArray(fixture.packs) || fixture.packs.length === 0) {
    throw new Error("fixture packs must be a non-empty array");
  }
  const packIdentities = new Set(
    fixture.packs.map((pack) => `${pack.id ?? ""}@${pack.version ?? ""}`),
  );
  if (fixture.manifest.activePack !== undefined) {
    validatePackIdentity(fixture.manifest.activePack, "manifest.activePack");
    const activePackIdentity = `${fixture.manifest.activePack.id}@${fixture.manifest.activePack.version}`;
    if (!packIdentities.has(activePackIdentity)) {
      throw new Error("manifest.activePack must match one of fixture packs");
    }
  }
  if (fixture.manifest.emergencyOverride !== undefined) {
    validatePackIdentity(fixture.manifest.emergencyOverride, "manifest.emergencyOverride");
    requiredString(fixture.manifest.emergencyOverride.reason, "manifest.emergencyOverride.reason");
  }
  for (const pack of fixture.packs) {
    validatePackIdentity(pack, "pack");
    const artifactKind = pack.artifactKind ?? "fixture";
    if (artifactKind !== "fixture" && artifactKind !== "production") {
      throw new Error("pack.artifactKind must be fixture or production");
    }
    schemaVersionNumber(pack.schemaVersion, "pack.schemaVersion");
    validatePackUrl(pack.url ?? stagedPackPath(pack), "pack.url");
    validatePackUrlMatchesStagedPath(pack.url ?? stagedPackPath(pack), pack, "pack.url");
    if (artifactKind === "production" && !isAbsoluteHttpsWithHost(pack.url)) {
      throw new Error("production pack url must be an absolute HTTPS URL");
    }
    if (artifactKind === "production" && usesLocalPlaceholderHost(pack.url)) {
      throw new Error("production pack url must not use a local placeholder host");
    }
    validateSourceInventory(pack.sourceInventory, artifactKind);
    validateRepresentativeRouteRegressions(pack.representativeRouteRegressions);
    if (!Array.isArray(pack.requiredTables) || pack.requiredTables.length === 0) {
      throw new Error(`${pack.id} requiredTables must be a non-empty array`);
    }
    validateMinimumTableRows(pack, artifactKind);
  }
}

function validateMinimumTableRows(pack, artifactKind) {
  if (pack.minimumTableRows !== undefined) {
    if (!pack.minimumTableRows || typeof pack.minimumTableRows !== "object" || Array.isArray(pack.minimumTableRows)) {
      throw new Error(`${pack.id} minimumTableRows must be an object`);
    }
    for (const [tableName, minimumRows] of Object.entries(pack.minimumTableRows)) {
      validateTableName(tableName);
      if (!Number.isInteger(minimumRows) || minimumRows < 0) {
        throw new Error(`${pack.id} minimumTableRows entry must be a non-negative integer`);
      }
    }
  }
  if (artifactKind !== "production") {
    return;
  }
  if (!hasProductionMinimumTableRows(pack.minimumTableRows)) {
    throw new Error(
      "production minimumTableRows must define positive stations, station_lines, network_edges, facilities, and station_facility_evidence",
    );
  }
  const actualRowsByTable = {
    stations: pack.stations?.length ?? 0,
    station_lines: pack.stationLines?.length ?? 0,
    network_edges: pack.networkEdges?.length ?? 0,
    facilities: pack.facilities?.length ?? 0,
    station_facility_evidence: pack.stationFacilityEvidence?.length ?? 0,
  };
  for (const tableName of productionMinimumTableRowNames) {
    if (actualRowsByTable[tableName] < pack.minimumTableRows[tableName]) {
      throw new Error(
        `production ${tableName} rows ${actualRowsByTable[tableName]} are below minimumTableRows ${pack.minimumTableRows[tableName]}`,
      );
    }
  }
}

function hasProductionMinimumTableRows(minimumTableRows) {
  return (
    minimumTableRows &&
    typeof minimumTableRows === "object" &&
    !Array.isArray(minimumTableRows) &&
    productionMinimumTableRowNames.every((tableName) => Number.isInteger(minimumTableRows[tableName]) && minimumTableRows[tableName] > 0)
  );
}

function validateTableName(value) {
  const tableName = requiredString(value, "tableName");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
    throw new Error(`invalid table name: ${tableName}`);
  }
}

function validateRepresentativeRouteRegressions(routes) {
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new Error("pack.representativeRouteRegressions must be a non-empty array");
  }
  const requiredPatterns = new Set([
    "DIRECT",
    "TRANSFER",
    "MULTI_TRANSFER",
    "LOOP_BRANCH",
    "EXPRESS_LOCAL",
  ]);
  const seenPatterns = new Set();
  for (const route of routes) {
    requiredString(route.id, "representativeRouteRegressions.id");
    const pattern = requiredString(route.pattern, "representativeRouteRegressions.pattern");
    if (!requiredPatterns.has(pattern)) {
      throw new Error("representativeRouteRegressions.pattern is invalid");
    }
    seenPatterns.add(pattern);
    requiredString(route.fromNodeId, "representativeRouteRegressions.fromNodeId");
    requiredString(route.toNodeId, "representativeRouteRegressions.toNodeId");
    if (!Array.isArray(route.requiredEdgeIds) || route.requiredEdgeIds.length === 0) {
      throw new Error("representativeRouteRegressions.requiredEdgeIds must be a non-empty array");
    }
    for (const edgeId of route.requiredEdgeIds) {
      requiredString(edgeId, "representativeRouteRegressions.requiredEdgeIds");
    }
  }
  for (const pattern of requiredPatterns) {
    if (!seenPatterns.has(pattern)) {
      throw new Error(`representativeRouteRegressions missing required pattern: ${pattern}`);
    }
  }
}

function validateSourceInventory(sourceInventory, artifactKind) {
  if (!Array.isArray(sourceInventory) || sourceInventory.length === 0) {
    throw new Error("pack.sourceInventory must be a non-empty array");
  }
  for (const source of sourceInventory) {
    requiredString(source.id, "sourceInventory.id");
    requiredString(source.owner, "sourceInventory.owner");
    requiredString(source.url, "sourceInventory.url");
    requiredString(source.license, "sourceInventory.license");
    const licenseStatus = requiredString(source.licenseStatus, "sourceInventory.licenseStatus");
    if (typeof source.redistributionAllowed !== "boolean") {
      throw new Error("sourceInventory.redistributionAllowed must be a boolean");
    }
    requiredString(source.updateFrequency, "sourceInventory.updateFrequency");
    requiredString(source.updatedAt, "sourceInventory.updatedAt");
    if (!Array.isArray(source.fields) || source.fields.length === 0) {
      throw new Error("sourceInventory.fields must be a non-empty array");
    }
    for (const field of source.fields) {
      requiredString(field, "sourceInventory.fields");
    }
    if (artifactKind === "production" || source.coverageScope !== undefined) {
      validateSourceInventoryCoverageScope(
        source.coverageScope,
        artifactKind === "production" ? "production sourceInventory.coverageScope" : "sourceInventory.coverageScope",
      );
    }
    if (artifactKind === "production") {
      if (licenseStatus !== "redistributable" || source.redistributionAllowed !== true) {
        throw new Error("production sourceInventory must be redistributable");
      }
      if (!isAbsoluteHttpsWithHost(source.url)) {
        throw new Error("production sourceInventory.url must be HTTPS");
      }
      if (usesLocalPlaceholderHost(source.url)) {
        throw new Error("production sourceInventory.url must not use a local placeholder host");
      }
    }
  }
}

function validateSourceInventoryCoverageScope(coverageScope, label) {
  if (!coverageScope || typeof coverageScope !== "object" || Array.isArray(coverageScope)) {
    throw new Error(`${label} must be an object`);
  }
  requiredStringArray(coverageScope.regionIds, `${label}.regionIds`);
  requiredStringArray(coverageScope.operatorIds, `${label}.operatorIds`);
  requiredStringArray(coverageScope.sourceDomains, `${label}.sourceDomains`);
}

function isAbsoluteHttpsWithHost(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname !== "";
  } catch {
    return false;
  }
}

function validatePackIdentity(value, label) {
  if (!value || typeof value !== "object") {
    throw new Error(`${label} must be an object`);
  }
  const packId = requiredString(value.id, `${label}.id`);
  const version = requiredString(value.version, `${label}.version`);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(packId)) {
    throw new Error(`${label}.id is invalid`);
  }
  if (!/^[0-9]+$/.test(version)) {
    throw new Error(`${label}.version is invalid`);
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument: ${key ?? ""}`);
    }
    args[key.slice(2)] = value;
  }
  return args;
}

function requireArg(args, name) {
  if (!args[name]) {
    throw new Error(`--${name} is required`);
  }
  return args[name];
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function sha256HexString(value, label) {
  const text = requiredString(value, label);
  if (!/^[a-f0-9]{64}$/i.test(text)) {
    throw new Error(`${label} must be a sha256 hex string`);
  }
  return text.toLowerCase();
}

function requiredUtcDateString(value, label) {
  const rawValue = requiredString(value, label);
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(rawValue)) {
    throw new Error(`${label} must include timezone offset`);
  }
  const parsed = new Date(rawValue);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} must be an ISO date-time`);
  }
  return rawValue;
}

function optionalUtcDateString(value, label) {
  return value === undefined ? null : requiredUtcDateString(value, label);
}

function optionalPositiveInteger(value, label) {
  return value === undefined ? null : requiredPositiveInteger(value, label);
}

function buildPublishedAt() {
  return new Date().toISOString();
}

function buildExpiresAt(rawPublishedAt) {
  const publishedAt = new Date(rawPublishedAt ?? buildPublishedAt());
  return new Date(publishedAt.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
}

function defaultReleaseSequence() {
  const runNumber = Number(process.env.GITHUB_RUN_NUMBER);
  return Number.isInteger(runNumber) && runNumber > 0 ? runNumber : 1;
}

function requiredStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  return value.map((entry) => requiredString(entry, `${label}[]`));
}

function normalizedAccessibilityStatus(value, label) {
  return requiredString(value ?? "UNKNOWN", label).toUpperCase();
}

function requiredInteger(value, label) {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  return value;
}

function requiredPositiveInteger(value, label) {
  const integer = requiredInteger(value, label);
  if (integer <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return integer;
}

function requiredNonNegativeInteger(value, label) {
  const integer = requiredInteger(value, label);
  if (integer < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return integer;
}

function canonicalLabelPolygon(value, label) {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  if (!Array.isArray(value) || value.length < 3) {
    throw new Error(`${label} must be a polygon with at least three points`);
  }
  const polygon = value.map((point, index) => {
    if (!point || typeof point !== "object" || Array.isArray(point)) {
      throw new Error(`${label}[${index}] must be an object point`);
    }
    return {
      x: requiredNonNegativeFiniteNumber(point.x, `${label}[${index}].x`),
      y: requiredNonNegativeFiniteNumber(point.y, `${label}[${index}].y`),
    };
  });
  return JSON.stringify(polygon);
}

function requiredNonNegativeFiniteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  if (value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return Math.round(value * 1000) / 1000;
}

function schemaVersionNumber(value, label) {
  const version = Number(requiredString(value, label));
  if (!Number.isInteger(version) || version <= 0) {
    throw new Error(`${label} must be a positive integer string`);
  }
  return version;
}

function boolFlag(value, label) {
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value ? 1 : 0;
}

function timestamp(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const millis = Date.parse(value);
  if (Number.isNaN(millis)) {
    throw new Error(`invalid timestamp: ${value}`);
  }
  return Math.floor(millis / 1000);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
