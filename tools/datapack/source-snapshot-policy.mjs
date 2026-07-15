import { isDeepStrictEqual } from "node:util";

import { requiredUtcInstant } from "./lib/utc-instant.mjs";
import { approvedLegacyGovernanceBinding } from "./legacy-source-governance.mjs";

export function requiredCredentialFreeObjectUri(value, label) {
  return parseCredentialFreeObjectUri(value, label).uri;
}

export function parseCredentialFreeObjectUri(value, label) {
  const uri = requiredText(value, label);
  const pathStart = uri.indexOf("/", uri.indexOf("://") + 3);
  const encodedPath = pathStart < 0 ? "" : uri.slice(pathStart);
  const objectKey = decodedObjectKey(encodedPath, label);
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`${label} must be a credential-free object storage URI`);
  }
  if (!["s3:", "oci:"].includes(parsed.protocol)
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || parsed.port !== ""
    || parsed.hostname === ""
    || parsed.pathname === ""
    || parsed.pathname === "/"
    || uri.includes("@")) {
    throw new Error(`${label} must be a credential-free object storage URI`);
  }
  return {
    uri,
    objectKey,
    sourceAuthority: `${parsed.protocol}//${parsed.hostname}`,
  };
}

export function requiredObjectKey(value, label) {
  const key = requiredText(value, label);
  const segments = key.split("/");
  if (key.startsWith("/") || segments.some((segment) => (
    segment === "" || segment === "." || segment === ".." || /[\u0000-\u001f\u007f]/u.test(segment)
  ))) {
    throw new Error(`${label} must be a canonical object key`);
  }
  try {
    segments.forEach(encodeURIComponent);
  } catch {
    throw new Error(`${label} must be a canonical object key`);
  }
  return key;
}

function decodedObjectKey(encodedPath, label) {
  if (!encodedPath.startsWith("/") || encodedPath === "/") {
    throw new Error(`${label} must be a credential-free object storage URI`);
  }
  try {
    const segments = encodedPath.slice(1).split("/").map((segment) => decodeURIComponent(segment));
    if (segments.some((segment) => segment === "." || segment === "..")) {
      throw new Error("dot segment");
    }
    return requiredObjectKey(segments.join("/"), label);
  } catch {
    throw new Error(`${label} must be a credential-free object storage URI`);
  }
}

export function buildSnapshotDiff(previous, next) {
  validateDiffSnapshot(previous, "previous", true);
  validateDiffSnapshot(next, "next");
  const changes = {
    rawHashChanged: previous.rawSha256 !== next.rawSha256,
    schemaHashChanged: previous.schemaFingerprint !== next.schemaFingerprint,
    requestHashChanged: previous.redactedRequestFingerprint !== next.redactedRequestFingerprint,
    sourceUpdatedAtChanged: optionalUtcInstant(previous.sourceUpdatedAt, "previous.sourceUpdatedAt")
      !== optionalUtcInstant(next.sourceUpdatedAt, "next.sourceUpdatedAt"),
    rowDelta: requiredNonNegativeInteger(next.rowCount, "rowCount")
      - requiredNonNegativeInteger(previous.rowCount, "previous.rowCount"),
    coverageDelta: requiredNonNegativeInteger(next.coverageCount, "coverageCount")
      - requiredCoverageCount(previous, "previous.coverageCount"),
  };
  const changed = changes.rawHashChanged
    || changes.schemaHashChanged
    || changes.requestHashChanged
    || changes.sourceUpdatedAtChanged
    || changes.rowDelta !== 0
    || changes.coverageDelta !== 0;
  return { status: changed ? "CHANGED" : "NO_CHANGE", ...changes };
}

export function validateLineage(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    throw new Error("SOURCE_LINEAGE_BROKEN: snapshots are required");
  }
  const byId = new Map();
  for (const snapshot of snapshots) {
    const snapshotId = requiredText(snapshot?.snapshotId, "snapshotId");
    requiredText(snapshot.sourceId, "sourceId");
    validateDiffSnapshot(snapshot, "snapshot", true);
    if (byId.has(snapshotId)) throw new Error("SOURCE_LINEAGE_BROKEN: duplicate snapshot ID");
    byId.set(snapshotId, snapshot);
  }

  const children = new Map();
  for (const snapshot of snapshots) {
    if (snapshot.previousSnapshotId == null) continue;
    const previous = byId.get(snapshot.previousSnapshotId);
    if (!previous || previous.sourceId !== snapshot.sourceId) {
      throw new Error("SOURCE_LINEAGE_BROKEN: previous snapshot");
    }
    if (requiredUtcInstant(snapshot.retrievedAt, "snapshot.retrievedAt")
      <= requiredUtcInstant(previous.retrievedAt, "previous.retrievedAt")) {
      throw new Error("SOURCE_LINEAGE_BROKEN: retrievedAt order");
    }
    const childIds = children.get(previous.snapshotId) ?? [];
    childIds.push(snapshot.snapshotId);
    if (childIds.length > 1) throw new Error("SOURCE_LINEAGE_BROKEN: snapshot fork");
    children.set(previous.snapshotId, childIds);
    if (!isDeepStrictEqual(snapshot.diffSummary, buildSnapshotDiff(previous, snapshot))) {
      throw new Error("SOURCE_DIFF_MISSING: snapshot diff");
    }
  }

  const headsBySource = {};
  const chainsBySource = {};
  for (const sourceId of new Set(snapshots.map((snapshot) => snapshot.sourceId))) {
    const sourceSnapshots = snapshots.filter((snapshot) => snapshot.sourceId === sourceId);
    const roots = sourceSnapshots.filter((snapshot) => snapshot.previousSnapshotId == null);
    if (roots.length !== 1) throw new Error("SOURCE_LINEAGE_BROKEN: source root");
    if (roots[0].diffSummary != null) throw new Error("SOURCE_DIFF_MISSING: root snapshot diff");
    const chain = [];
    const visited = new Set();
    let current = roots[0];
    while (current) {
      if (visited.has(current.snapshotId)) throw new Error("SOURCE_LINEAGE_BROKEN: snapshot cycle");
      visited.add(current.snapshotId);
      chain.push(current.snapshotId);
      const childId = children.get(current.snapshotId)?.[0];
      current = childId ? byId.get(childId) : null;
    }
    if (visited.size !== sourceSnapshots.length) {
      throw new Error("SOURCE_LINEAGE_BROKEN: disconnected snapshot chain");
    }
    headsBySource[sourceId] = chain.at(-1);
    chainsBySource[sourceId] = chain;
  }
  return { headsBySource, chainsBySource };
}

function optionalUtcInstant(value, label) {
  return value == null ? null : requiredUtcInstant(value, label);
}

function validateDiffSnapshot(snapshot, label, allowLegacyRootCoverage = false) {
  try {
    requiredUtcInstant(snapshot?.retrievedAt, `${label}.retrievedAt`);
  } catch {
    throw new Error(`SOURCE_LINEAGE_BROKEN: ${label}.retrievedAt`);
  }
  for (const field of ["rawSha256", "schemaFingerprint", "redactedRequestFingerprint"]) {
    if (!/^[0-9a-f]{64}$/.test(snapshot?.[field] ?? "")) {
      throw new Error(`SOURCE_DIFF_MISSING: ${label}.${field}`);
    }
  }
  if (!("sourceUpdatedAt" in (snapshot ?? {}))) {
    throw new Error(`SOURCE_DIFF_MISSING: ${label}.sourceUpdatedAt`);
  }
  if (snapshot.sourceUpdatedAt != null) {
    try {
      requiredUtcInstant(snapshot.sourceUpdatedAt, `${label}.sourceUpdatedAt`);
    } catch {
      throw new Error(`SOURCE_DIFF_MISSING: ${label}.sourceUpdatedAt`);
    }
  }
  requiredNonNegativeInteger(snapshot.rowCount, `${label}.rowCount`);
  if (allowLegacyRootCoverage
    && snapshot.coverageCount == null
    && snapshot.previousSnapshotId == null
    && snapshot.diffSummary == null
    && approvedLegacyGovernanceBinding(snapshot) != null) {
    return;
  }
  requiredNonNegativeInteger(snapshot.coverageCount, `${label}.coverageCount`);
}

function requiredCoverageCount(snapshot, label) {
  if (snapshot.coverageCount == null
    && snapshot.previousSnapshotId == null
    && snapshot.diffSummary == null
    && approvedLegacyGovernanceBinding(snapshot) != null) {
    return requiredNonNegativeInteger(snapshot.rowCount, `${label} legacy rowCount`);
  }
  return requiredNonNegativeInteger(snapshot.coverageCount, label);
}

function requiredText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function requiredNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`SOURCE_DIFF_MISSING: ${label}`);
  return value;
}
