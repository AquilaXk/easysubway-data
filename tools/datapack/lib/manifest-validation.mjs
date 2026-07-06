import { createHash, createVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { usesLocalPlaceholderHost } from "../production-url-policy.mjs";

const productionMinimumTableRowNames = [
  "stations",
  "station_lines",
  "network_edges",
  "facilities",
  "station_facility_evidence",
];

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function verifyRsaSha256Signature(publicKey, value, signature) {
  return createVerify("RSA-SHA256").update(value).verify(publicKey, Buffer.from(signature, "base64url"));
}

export function signingPublicKey() {
  const key = process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM?.trim();
  if (!key) {
    throw new Error("EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM is required for production data pack validation");
  }
  return key;
}

function signingKeyId() {
  return process.env.EASYSUBWAY_DATAPACK_SIGNING_KEY_ID?.trim() || "production-v1";
}

export function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requiredChannel(value, label) {
  const channel = requiredString(value, label);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(channel)) {
    throw new Error(`${label} must match ^[A-Za-z][A-Za-z0-9_-]*$`);
  }
  return channel;
}

function requiredStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  return value.map((entry) => requiredString(entry, `${label}[]`));
}

function requiredPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function requiredDate(value, label) {
  const rawValue = requiredString(value, label);
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(rawValue)) {
    throw new Error(`${label} must include timezone offset`);
  }
  const parsed = new Date(rawValue);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} must be an ISO date-time`);
  }
  return parsed;
}

export function requiredSha256(value, label) {
  const hash = requiredString(value, label);
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`${label} must be a lowercase sha256 hex string`);
  }
  return hash;
}

export function withoutSignature(value) {
  const copy = { ...value };
  delete copy.signature;
  return copy;
}

export function canonicalJson(value) {
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
    // 서명 계산에 쓰이는 정준 직렬화: 기본 .sort()와 바이트 동일한 UTF-16 code-unit
    // 비교자를 명시한다. localeCompare는 정렬 순서가 달라 이미 서명된 매니페스트의
    // 검증을 깨뜨리므로 사용 금지.
    return Object.fromEntries(
      Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((key) => [key, canonicalValue(value[key])]),
    );
  }
  throw new Error("manifest canonical value is unsupported");
}

export function isAbsoluteHttpsWithHost(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname !== "";
  } catch {
    return false;
  }
}

export function stagedPackPath(pack) {
  return `catalog/${pack.id}-v${pack.version}.sqlite.gz`;
}

function validateTableName(value) {
  const tableName = requiredString(value, "tableName");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
    throw new Error(`invalid table name: ${tableName}`);
  }
}

export function validatePackIdentity(value, label) {
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

export function validatePackUrl(packUrl, label) {
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

export function validatePackUrlMatchesStagedPath(packUrl, pack, label) {
  if (!/^https:\/\//.test(packUrl)) {
    return;
  }
  const url = new URL(packUrl);
  const expectedPathSuffix = `/${stagedPackPath(pack)}`;
  if (!url.pathname.endsWith(expectedPathSuffix) || url.search !== "" || url.hash !== "") {
    throw new Error(`${label} absolute HTTPS URL path must end with ${stagedPackPath(pack)}`);
  }
}

function validateSignature(signature, label, manifestVersion, artifactKind) {
  if (!signature || typeof signature !== "object") {
    throw new Error(`${label} signature must be an object`);
  }
  const algorithm = requiredString(signature.algorithm, "signature.algorithm");
  const expectedAlgorithm = artifactKind === "production"
    ? (manifestVersion === 2 ? "rsa-sha256-pack-manifest-v2" : "rsa-sha256-pack-manifest-v1")
    : (manifestVersion === 2 ? "sha256-pack-manifest-v2" : "sha256-pack-manifest-v1");
  if (algorithm !== expectedAlgorithm) {
    throw new Error(`${label} signature algorithm is unsupported`);
  }
  const value = requiredString(signature.value, "signature.value");
  if (algorithm.startsWith("sha256-")) {
    requiredSha256(value, "signature.value");
  } else if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("signature.value must be a base64url string");
  }
}

function validateSourceInventory(sourceInventory, artifactKind, label) {
  if (!Array.isArray(sourceInventory) || sourceInventory.length === 0) {
    throw new Error(`${label} sourceInventory must be a non-empty array`);
  }
  for (const source of sourceInventory) {
    requiredString(source.id, "sourceInventory.id");
    requiredString(source.owner, "sourceInventory.owner");
    requiredString(source.url, "sourceInventory.url");
    requiredString(source.license, "sourceInventory.license");
    const licenseStatus = requiredString(source.licenseStatus, "sourceInventory.licenseStatus");
    if (typeof source.redistributionAllowed !== "boolean") {
      throw new Error(`${label} sourceInventory.redistributionAllowed must be a boolean`);
    }
    requiredString(source.updateFrequency, "sourceInventory.updateFrequency");
    requiredString(source.updatedAt, "sourceInventory.updatedAt");
    if (!Array.isArray(source.fields) || source.fields.length === 0) {
      throw new Error(`${label} sourceInventory.fields must be a non-empty array`);
    }
    for (const field of source.fields) {
      requiredString(field, "sourceInventory.fields");
    }
    if (artifactKind === "production" || source.coverageScope !== undefined) {
      validateSourceInventoryCoverageScope(
        source.coverageScope,
        artifactKind === "production"
          ? `${label} production sourceInventory.coverageScope`
          : `${label} sourceInventory.coverageScope`,
      );
    }
    if (artifactKind === "production") {
      if (licenseStatus !== "redistributable" || source.redistributionAllowed !== true) {
        throw new Error(`${label} production sourceInventory must be redistributable`);
      }
      if (!isAbsoluteHttpsWithHost(source.url)) {
        throw new Error(`${label} production sourceInventory.url must be HTTPS`);
      }
      if (usesLocalPlaceholderHost(source.url)) {
        throw new Error(`${label} production sourceInventory.url must not use a local placeholder host`);
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

function validateRegionalQualityMetrics(metrics, label) {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
    throw new Error(`${label} regionalQualityMetrics must be an object`);
  }
  if (!Number.isInteger(metrics.stationCount) || metrics.stationCount < 0) {
    throw new Error(`${label} regionalQualityMetrics.stationCount must be a non-negative integer`);
  }
  if (!Number.isInteger(metrics.edgeCount) || metrics.edgeCount < 0) {
    throw new Error(`${label} regionalQualityMetrics.edgeCount must be a non-negative integer`);
  }
  for (const key of [
    "facilityCoverageRatio",
    "requiredFacilityEvidenceCoverageRatio",
    "strictRouteEligibleFacilityRatio",
    "operationalKnownRatio",
    "freshnessValidRatio",
    "fieldVerifiedPathwayRatio",
    "unknownAccessibilityRatio",
  ]) {
    if (typeof metrics[key] !== "number" || metrics[key] < 0 || metrics[key] > 1) {
      throw new Error(`${label} regionalQualityMetrics.${key} must be a ratio`);
    }
  }
  if (!metrics.unknownEdgeRatioByProfile || typeof metrics.unknownEdgeRatioByProfile !== "object") {
    throw new Error(`${label} regionalQualityMetrics.unknownEdgeRatioByProfile must be an object`);
  }
  for (const key of ["wheelchair", "stroller", "lowMobility"]) {
    const value = metrics.unknownEdgeRatioByProfile[key];
    if (typeof value !== "number" || value < 0 || value > 1) {
      throw new Error(`${label} regionalQualityMetrics.unknownEdgeRatioByProfile.${key} must be a ratio`);
    }
  }
}

function validateRouteRegressionScopeManifest(scope, label) {
  if (scope === undefined) {
    return;
  }
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw new Error(`${label} routeRegressionScope must be an object`);
  }
  const mode = requiredString(scope.mode, "routeRegressionScope.mode");
  if (mode !== "DIRECT_ONLY") {
    throw new Error(`${label} routeRegressionScope.mode is invalid`);
  }
  if (!Array.isArray(scope.excludedPatterns)) {
    throw new Error(`${label} routeRegressionScope.excludedPatterns must be an array`);
  }
  for (const pattern of scope.excludedPatterns) {
    requiredString(pattern, "routeRegressionScope.excludedPatterns");
  }
  requiredString(scope.claim, "routeRegressionScope.claim");
}

function validateRepresentativeRouteRegressionManifest(routes, label, scope = null) {
  const requiredPatterns =
    !scope && Array.isArray(routes) && routes.length === 0
      ? new Set()
      : requiredRepresentativeRoutePatterns(scope);
  if (!Array.isArray(routes) || (requiredPatterns.size > 0 && routes.length === 0)) {
    throw new Error(`${label} representativeRouteRegressions must be a non-empty array`);
  }
  const seenPatterns = new Set();
  const seenRouteShapes = new Map();
  for (const route of routes) {
    if (!route || typeof route !== "object" || Array.isArray(route)) {
      throw new Error(`${label} representativeRouteRegressions entries must be objects`);
    }
    requiredString(route.id, "representativeRouteRegressions.id");
    const pattern = requiredString(route.pattern, "representativeRouteRegressions.pattern");
    if (!requiredPatterns.has(pattern)) {
      throw new Error(`${label} representativeRouteRegressions pattern is invalid: ${pattern}`);
    }
    seenPatterns.add(pattern);
    requiredString(route.fromNodeId, "representativeRouteRegressions.fromNodeId");
    requiredString(route.toNodeId, "representativeRouteRegressions.toNodeId");
    if (!Array.isArray(route.requiredEdgeIds) || route.requiredEdgeIds.length === 0) {
      throw new Error(`${label} representativeRouteRegressions.requiredEdgeIds must be a non-empty array`);
    }
    for (const edgeId of route.requiredEdgeIds) {
      requiredString(edgeId, "representativeRouteRegressions.requiredEdgeIds");
    }
    if (scope?.mode !== "DIRECT_ONLY") {
      const shape = `${route.fromNodeId}->${route.toNodeId}:${route.requiredEdgeIds.join(">")}`;
      const firstPattern = seenRouteShapes.get(shape);
      if (firstPattern && firstPattern !== route.pattern) {
        throw new Error(`${label} representativeRouteRegressions duplicate route shape across patterns: ${route.id}`);
      }
      seenRouteShapes.set(shape, route.pattern);
    }
  }
  for (const pattern of requiredPatterns) {
    if (!seenPatterns.has(pattern)) {
      throw new Error(`${label} representativeRouteRegressions missing required pattern: ${pattern}`);
    }
  }
}

export function requiredRepresentativeRoutePatterns(scope = null) {
  if (scope?.mode === "DIRECT_ONLY") {
    return new Set(["DIRECT"]);
  }
  return new Set(["DIRECT", "TRANSFER", "MULTI_TRANSFER", "LOOP_BRANCH", "EXPRESS_LOCAL"]);
}

function validateRepresentativeRouteRegressionSignature(signature, label) {
  if (!signature || typeof signature !== "object") {
    throw new Error(`${label} representativeRouteRegressionSignature must be an object`);
  }
  const algorithm = requiredString(signature.algorithm, "representativeRouteRegressionSignature.algorithm");
  if (algorithm !== "sha256-route-regression-v1" && algorithm !== "rsa-sha256-route-regression-v1") {
    throw new Error(`${label} representativeRouteRegressionSignature algorithm is unsupported`);
  }
  const value = requiredString(signature.value, "representativeRouteRegressionSignature.value");
  if (algorithm === "sha256-route-regression-v1") {
    requiredSha256(value, "representativeRouteRegressionSignature.value");
  } else if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("representativeRouteRegressionSignature.value must be a base64url string");
  }
}

function validateMinimumTableRows(pack, artifactKind, label) {
  if (pack.minimumTableRows !== undefined) {
    if (!pack.minimumTableRows || typeof pack.minimumTableRows !== "object" || Array.isArray(pack.minimumTableRows)) {
      throw new Error(`${label} minimumTableRows must be an object`);
    }
    for (const [tableName, minimumRows] of Object.entries(pack.minimumTableRows)) {
      validateTableName(tableName);
      if (!Number.isInteger(minimumRows) || minimumRows < 0) {
        throw new Error(`${label} minimumTableRows entry must be a non-negative integer`);
      }
    }
  }
  if (artifactKind !== "production") {
    return;
  }
  if (!hasProductionMinimumTableRows(pack.minimumTableRows)) {
    throw new Error(
      `${label} production minimumTableRows must define positive stations, station_lines, network_edges, facilities, and station_facility_evidence`,
    );
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

export function validateManifestJsonSchema(manifest) {
  const schema = JSON.parse(readFileSync(new URL("../schema/manifest.schema.json", import.meta.url), "utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("manifest must match manifest.schema.json");
  }
  for (const key of schema.required ?? []) {
    if (!(key in manifest)) {
      throw new Error(`manifest.schema.json required field missing: ${key}`);
    }
  }
  const allowedProperties = new Set(Object.keys(schema.properties ?? {}));
  for (const key of Object.keys(manifest)) {
    if (!allowedProperties.has(key)) {
      throw new Error(`manifest.schema.json additional field is unsupported: ${key}`);
    }
  }
  const manifestVersion = manifest.manifestVersion ?? 1;
  if (manifestVersion === 2) {
    const versionRule = schema.allOf?.find((rule) => rule?.then?.required?.includes("signature"));
    for (const key of versionRule?.then?.required ?? []) {
      if (!(key in manifest)) {
        throw new Error(`manifest.schema.json v2 required field missing: ${key}`);
      }
    }
  }
}

export function validateManifestV2Envelope(manifest) {
  requiredChannel(manifest.channel, "manifest.channel");
  requiredPositiveInteger(manifest.releaseSequence, "manifest.releaseSequence");
  const publishedAt = requiredDate(manifest.publishedAt, "manifest.publishedAt");
  const expiresAt = requiredDate(manifest.expiresAt, "manifest.expiresAt");
  if (expiresAt <= publishedAt) {
    throw new Error("manifest.expiresAt must be after manifest.publishedAt");
  }
  requiredString(manifest.keyId, "manifest.keyId");
  if (!manifest.signature || typeof manifest.signature !== "object") {
    throw new Error("manifest.signature must be an object");
  }
  const algorithm = requiredString(manifest.signature.algorithm, "manifest.signature.algorithm");
  if (algorithm !== "sha256-manifest-v2" && algorithm !== "rsa-sha256-manifest-v2") {
    throw new Error("manifest.signature algorithm is unsupported");
  }
  const value = requiredString(manifest.signature.value, "manifest.signature.value");
  if (algorithm === "sha256-manifest-v2") {
    requiredSha256(value, "manifest.signature.value");
  } else if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("manifest.signature.value must be a base64url string");
  }
}

export function validateManifestSignature(manifest) {
  const canonical = canonicalJson(withoutSignature(manifest));
  const hasProductionPack = manifest.packs.some((pack) => pack.artifactKind === "production");
  if (hasProductionPack) {
    if (manifest.keyId !== signingKeyId()) {
      throw new Error("manifest.keyId is unknown");
    }
    if (
      manifest.signature.algorithm !== "rsa-sha256-manifest-v2" ||
      !verifyRsaSha256Signature(signingPublicKey(), canonical, manifest.signature.value)
    ) {
      throw new Error("manifest signature mismatch");
    }
    return;
  }
  if (
    manifest.signature.algorithm !== "sha256-manifest-v2" ||
    manifest.signature.value !== sha256(Buffer.from(canonical))
  ) {
    throw new Error("manifest signature mismatch");
  }
}

export function validateManifest(manifest, { requireProduction = false } = {}) {
  validateManifestJsonSchema(manifest);
  if (!manifest || typeof manifest !== "object") {
    throw new Error("manifest must be an object");
  }
  const manifestVersion = manifest.manifestVersion ?? 1;
  if (manifestVersion !== 1 && manifestVersion !== 2) {
    throw new Error("manifestVersion must be 1 or 2");
  }
  if (manifestVersion === 2) {
    validateManifestV2Envelope(manifest);
  }
  if (!Number.isInteger(manifest.ttlSeconds) || manifest.ttlSeconds <= 0) {
    throw new Error("manifest ttlSeconds must be a positive integer");
  }
  if (!Array.isArray(manifest.packs)) {
    throw new Error("manifest packs must be an array");
  }
  const packIdentities = new Set(
    manifest.packs.map((pack) => `${pack.id ?? ""}@${pack.version ?? ""}`),
  );
  if (manifest.activePack !== undefined) {
    validatePackIdentity(manifest.activePack, "activePack");
    const activePackIdentity = `${manifest.activePack.id}@${manifest.activePack.version}`;
    if (!packIdentities.has(activePackIdentity)) {
      throw new Error("activePack must match one of manifest packs");
    }
  }
  if (manifest.emergencyOverride !== undefined) {
    validatePackIdentity(manifest.emergencyOverride, "emergencyOverride");
    requiredString(manifest.emergencyOverride.reason, "emergencyOverride.reason");
  }
  for (const pack of manifest.packs) {
    validatePackIdentity(pack, "pack");
    validatePackUrl(requiredString(pack.url, "pack.url"), "pack.url");
    validatePackUrlMatchesStagedPath(pack.url, pack, "pack.url");
    const artifactKind = requiredString(pack.artifactKind, "pack.artifactKind");
    if (artifactKind !== "fixture" && artifactKind !== "production") {
      throw new Error(`${pack.id}@${pack.version} artifactKind must be fixture or production`);
    }
    if (requireProduction && artifactKind !== "production") {
      throw new Error(`${pack.id}@${pack.version} remote publish requires production artifactKind`);
    }
    if (artifactKind === "production" && !isAbsoluteHttpsWithHost(pack.url)) {
      throw new Error(`${pack.id}@${pack.version} production pack url must be an absolute HTTPS URL`);
    }
    if (artifactKind === "production" && usesLocalPlaceholderHost(pack.url)) {
      throw new Error(`${pack.id}@${pack.version} production pack url must not use a local placeholder host`);
    }
    requiredSha256(pack.sha256, "pack.sha256");
    requiredSha256(pack.sqliteSha256, "pack.sqliteSha256");
    if (!Number.isInteger(pack.sizeBytes) || pack.sizeBytes <= 0) {
      throw new Error(`${pack.id}@${pack.version} sizeBytes must be a positive integer`);
    }
    validateSignature(pack.signature, `${pack.id}@${pack.version}`, manifestVersion, artifactKind);
    validateSourceInventory(pack.sourceInventory, artifactKind, `${pack.id}@${pack.version}`);
    validateRegionalQualityMetrics(pack.regionalQualityMetrics, `${pack.id}@${pack.version}`);
    if (pack.routeRegressionScope !== undefined) {
      validateRouteRegressionScopeManifest(pack.routeRegressionScope, `${pack.id}@${pack.version}`);
    }
    validateRepresentativeRouteRegressionManifest(
      pack.representativeRouteRegressions,
      `${pack.id}@${pack.version}`,
      pack.routeRegressionScope,
    );
    validateRepresentativeRouteRegressionSignature(
      pack.representativeRouteRegressionSignature,
      `${pack.id}@${pack.version}`,
    );
    requiredString(pack.schemaVersion, "pack.schemaVersion");
    if (!Array.isArray(pack.requiredTables) || pack.requiredTables.length === 0) {
      throw new Error(`${pack.id}@${pack.version} requiredTables must be a non-empty array`);
    }
    for (const tableName of pack.requiredTables) {
      validateTableName(tableName);
    }
    validateMinimumTableRows(pack, artifactKind, `${pack.id}@${pack.version}`);
  }
  if (manifestVersion === 2) {
    validateManifestSignature(manifest);
  }
}
