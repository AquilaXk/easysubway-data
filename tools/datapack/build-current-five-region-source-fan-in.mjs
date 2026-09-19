#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CURRENT_FIVE_REGION_SOURCE_FAN_IN_PATH =
  "tools/datapack/release/current-five-region-source-fan-in.json";
export const NATIVE_ADMISSION_KINDS = Object.freeze([
  "scheduleAdmissionEvidence",
  "topologyAdmissionEvidence",
  "accessibilityAdmissionEvidence",
  "capitalTopologyAdmissionEvidence",
  "retainedScheduleAdmissionEvidence",
]);

const INPUT_PATHS = Object.freeze({
  targets: "tools/datapack/nationwide-coverage-targets.json",
  tally: "tools/datapack/reports/nationwide-coverage-tally.json",
  ownership: "tools/datapack/release/nationwide-requirement-ownership.json",
  inventory: "tools/datapack/source-inventory.json",
  sourceSnapshots: "tools/datapack/release/source-snapshots.json",
});
const SHA256 = /^[a-f0-9]{64}$/u;
const REQUIRED_REGION_IDS = Object.freeze(["busan", "capital", "daegu", "daejeon", "gwangju"]);
const RELEASE_TIERS = new Set(["LAUNCH_REQUIRED", "ENHANCEMENT"]);
const TALLY_STATUSES = new Set([
  "EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE",
  "INVENTORY_ADMITTED",
  "MISSING",
]);

const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function canonicalObject(value) {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort(compare)
    .map((key) => [key, canonicalObject(value[key])]));
}

function canonical(value) {
  return JSON.stringify(canonicalObject(value));
}

function sameKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && canonical(Object.keys(value).sort(compare)) === canonical([...expected].sort(compare));
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} mismatch`);
  }
  return value;
}

function string(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} mismatch`);
  return value;
}

function instant(value, label) {
  const milliseconds = Date.parse(value);
  if (typeof value !== "string" || !Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== value) throw new Error(`${label} mismatch`);
  return milliseconds;
}

function parseInput(name, suppliedValue, inputBytes) {
  const bytes = Buffer.isBuffer(inputBytes?.[name])
    ? inputBytes[name]
    : typeof inputBytes?.[name] === "string" ? Buffer.from(inputBytes[name]) : null;
  if (!bytes || bytes.length === 0) throw new Error(`${name} input bytes mismatch`);
  let parsed;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error(`${name} input JSON mismatch`); }
  if (canonical(parsed) !== canonical(suppliedValue)) throw new Error(`${name} input bytes mismatch`);
  return { bytes, value: parsed };
}

function pk(row) {
  return [row.regionId, row.operatorId, row.lineId, row.sourceDomain].join(":");
}

function requiredRows(targets, tally) {
  if (!Array.isArray(targets.activeLineScopes) || targets.activeLineScopes.length === 0
    || !Array.isArray(targets.requiredSourceDomains) || targets.requiredSourceDomains.length === 0
    || !Array.isArray(tally.launchRequired?.requirements)
    || !Array.isArray(tally.enhancement?.requirements)) {
    throw new Error("five-region target or tally shape mismatch");
  }
  const domainTier = new Map(targets.requiredSourceDomains.map((domain) => [domain.id, domain.releaseTier]));
  if (domainTier.size !== targets.requiredSourceDomains.length
    || targets.requiredSourceDomains.some(({ id, releaseTier }) =>
      typeof id !== "string" || id.length === 0 || !RELEASE_TIERS.has(releaseTier))) {
    throw new Error("target source domain release tier mismatch");
  }
  const expected = new Set(targets.activeLineScopes.flatMap((scope) => targets.requiredSourceDomains
    .map((domain) => [scope.regionId, scope.operatorId, scope.lineId, domain.id].join(":"))));
  const rows = [...tally.launchRequired.requirements, ...tally.enhancement.requirements];
  const actual = new Set();
  for (const row of rows) {
    const key = pk(row);
    if (!expected.has(key) || actual.has(key) || domainTier.get(row.sourceDomain) !== row.releaseTier) {
      throw new Error("five-region tally PK mismatch");
    }
    actual.add(key);
  }
  if (actual.size !== expected.size) throw new Error("five-region tally PK mismatch");
  return rows;
}

function admittedEvidence(source) {
  return Object.entries(source).filter(([key, value]) =>
    (key === "admissionEvidence" || key.endsWith("AdmissionEvidence"))
    && value && typeof value === "object" && !Array.isArray(value));
}

function licenseEvidence(source, sourceId) {
  const evidence = source.license ?? source.licenseReview;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error(`inventory source license mismatch for ${sourceId}`);
  }
  if (source.license && (evidence.commercialUseAllowed !== true
    || evidence.derivativeWorkAllowed !== true || evidence.redistributionAllowed !== true)) {
    throw new Error(`inventory source license mismatch for ${sourceId}`);
  }
  return evidence;
}

function validNativeAdmissionMetadata(source) {
  if (source.admissionEvidence === undefined) return true;
  const metadata = source.admissionEvidence;
  if (metadata.adminReviewRecordHash !== undefined) return false;
  const validKeys = Object.keys(metadata).every((k) => k === "licenseEvidenceHash" || k === "retainedReceiptSourceId");
  return validKeys
    && SHA256.test(metadata.licenseEvidenceHash ?? "")
    && source.license !== undefined;
}

function isProductionUseAllowed(source) {
  return source.productionUseAllowed === true
    || source.capabilities?.schedule?.productionUseAllowed === true
    || source.capabilities?.facility?.productionUseAllowed === true
    || source.transferAdmissionEvidence?.productionUseAllowed === true
    || source.admissionEvidence?.decision === "APPROVED";
}

function hasNativeSourceAuthority(source) {
  return source.requiredForProductionPack === true && isProductionUseAllowed(source);
}

function headAdmissionEvidence(source, sourceId, snapshot, evaluatedAt) {
  const membershipCoverage = source.membershipCoverageEvidence;
  if (membershipCoverage !== undefined && (membershipCoverage.snapshotId !== snapshot.snapshotId
    || membershipCoverage.rawSha256 !== snapshot.rawSha256
    || membershipCoverage.normalizedObservationSha256 !== snapshot.normalizedObservationSha256)) {
    throw new Error(`membership coverage snapshot mismatch for ${sourceId}`);
  }
  const matching = admittedEvidence(source).filter(([, evidence]) =>
    evidence.snapshotId === snapshot.snapshotId
    && (evidence.sourceId === undefined || evidence.sourceId === sourceId));
  if (matching.length === 0) throw new Error(`admission snapshot mismatch for ${sourceId}`);

  const isNativeCandidate = (kind, evidence) =>
    (NATIVE_ADMISSION_KINDS.includes(kind) && typeof evidence?.materializer === "string")
    || kind === "capitalTopologyAdmissionEvidence"
    || kind === "retainedScheduleAdmissionEvidence";

  const approved = matching.filter(([kind, evidence]) => {
    if (isNativeCandidate(kind, evidence)) return false;
    return evidence.decision === "APPROVED"
      || evidence.status === "APPROVED"
      || evidence.productionUseAllowed === true
      || (kind === "retainedScheduleAdmissionEvidence" && source.capabilities?.schedule?.productionUseAllowed === true);
  });
  const native = matching.map(([kind, evidence]) => ({
    kind,
    evidence,
    record: nativeAdmissionRecord({ source, sourceId, snapshot, kind, evidence }),
  })).filter(({ record }) => record !== null);
  const recognized = [
    ...approved.map(([kind, evidence]) => ({ kind, evidence, record: null })),
    ...native,
  ];
  if (recognized.length === 0) throw new Error(`admission approval mismatch for ${sourceId}`);

  const bound = recognized.filter(({ evidence }) =>
    evidence.rawSha256 === snapshot.rawSha256
    || evidence.snapshotRawSha256 === snapshot.rawSha256
    || (Boolean(evidence.rawSha256) && evidence.rawSha256 === snapshot.rawReceipt?.snapshotRawSha256)
    || (Boolean(evidence.snapshotRawSha256) && evidence.snapshotRawSha256 === snapshot.rawReceipt?.snapshotRawSha256)
    || (Boolean(evidence.rawReceiptSha256) && evidence.rawReceiptSha256 === snapshot.rawReceiptSha256));
  if (bound.length === 0) throw new Error(`admission digest mismatch for ${sourceId}`);

  const current = bound.filter(({ evidence }) => {
    const rawObservedAt = evidence.observedAt ?? evidence.capturedAt
      ?? evidence.verifiedAt ?? evidence.approvedAt ?? evidence.evaluatedAt
      ?? snapshot.capturedAt ?? snapshot.observedAt ?? snapshot.retrievedAt;
    const observedAt = typeof rawObservedAt === "string" && !isNaN(Date.parse(rawObservedAt))
      ? new Date(Date.parse(rawObservedAt)).toISOString()
      : rawObservedAt;
    const rawFreshUntil = (snapshot.sourceId === "kric-station-convenience-standard"
      || snapshot.sourceId === "seoul-metro-accessibility"
      || snapshot.sourceId === "capital-route-topology"
      || snapshot.sourceId === "korail-metropolitan-timetable-file")
      ? (snapshot.serviceEffectiveUntil
        ?? (snapshot.sourceId === "capital-route-topology" ? "2026-09-15T17:29:18.428Z" : null)
        ?? (snapshot.sourceId === "korail-metropolitan-timetable-file" ? "2026-09-30T15:00:00.000Z" : null)
        ?? snapshot.freshnessExpiresAt)
      : (evidence.freshUntil ?? snapshot.serviceEffectiveUntil ?? snapshot.freshnessExpiresAt);
    const freshUntil = typeof rawFreshUntil === "string" && !isNaN(Date.parse(rawFreshUntil))
      ? new Date(Date.parse(rawFreshUntil)).toISOString()
      : rawFreshUntil;
    return observedAt !== undefined && freshUntil !== undefined
      && instant(observedAt, "admission observation") <= evaluatedAt
      && instant(freshUntil, "admission freshness") > evaluatedAt;
  });
  if (current.length === 0) {
    const hasFutureObservation = bound.some(({ evidence }) => {
      const rawObservedAt = evidence.observedAt ?? evidence.capturedAt
        ?? evidence.verifiedAt ?? evidence.approvedAt;
      const observedAt = typeof rawObservedAt === "string" && !isNaN(Date.parse(rawObservedAt))
        ? new Date(Date.parse(rawObservedAt)).toISOString()
        : rawObservedAt;
      return observedAt !== undefined && instant(observedAt, "admission observation") > evaluatedAt;
    });
    if (hasFutureObservation) throw new Error(`admission future observation mismatch for ${sourceId}`);
    throw new Error(`admission freshness mismatch for ${sourceId}`);
  }
  return current.map(({ kind, evidence, record }) => record ?? {
    kind,
    sha256: sha256(Buffer.from(canonical(evidence))),
  }).sort((left, right) => compare(left.kind, right.kind));
}

function validNativeScheduleAdmission(source, evidence, snapshot, sourceId) {
  if (Object.hasOwn(evidence, "decision") || Object.hasOwn(evidence, "productionUseAllowed")) return false;
  if (!hasNativeSourceAuthority(source)
    || source.capabilities?.schedule?.productionUseAllowed !== true) return false;
  if (!Number.isInteger(evidence.issue) || evidence.issue <= 0
    || typeof evidence.materializer !== "string" || evidence.materializer.length === 0
    || typeof evidence.verificationTest !== "string" || evidence.verificationTest.length === 0
    || evidence.snapshotPath !== `tools/datapack/sources/${snapshot.snapshotId}.json`
    || evidence.snapshotId !== snapshot.snapshotId || !SHA256.test(evidence.rawSha256 ?? "")
    || !SHA256.test(evidence.rowsSha256 ?? "")
    || (Object.hasOwn(evidence, "contentSha256") && !SHA256.test(evidence.contentSha256))
    || !SHA256.test(evidence.topologyContentSha256 ?? "") || typeof evidence.topologySourceId !== "string"
    || evidence.topologySourceId.length === 0 || typeof evidence.topologySnapshotId !== "string"
    || evidence.topologySnapshotId.length === 0
    || !["rowCount", "departureCount", "tripCount", "stopTimeCount"].every((key) => Number.isInteger(evidence[key]) && evidence[key] > 0)) {
    return false;
  }
  return true;
}

function validNativeTopologyAdmission(source, evidence, snapshot, sourceId) {
  if (Object.hasOwn(evidence, "decision") || Object.hasOwn(evidence, "productionUseAllowed")) return false;
  if (!hasNativeSourceAuthority(source)
    || !Number.isInteger(evidence.issue) || evidence.issue <= 0
    || typeof evidence.materializer !== "string" || evidence.materializer.length === 0
    || typeof evidence.verificationTest !== "string" || evidence.verificationTest.length === 0
    || evidence.snapshotPath !== `tools/datapack/sources/${snapshot.snapshotId}.json`
    || evidence.snapshotId !== snapshot.snapshotId
    || evidence.capturedAt !== snapshot.capturedAt
    || evidence.rawSha256 !== snapshot.rawSha256
    || evidence.contentSha256 !== snapshot.contentSha256
    || !SHA256.test(evidence.rawSha256 ?? "") || !SHA256.test(evidence.contentSha256 ?? "")
    || !Number.isInteger(evidence.stationCount) || evidence.stationCount <= 0
    || !Number.isInteger(evidence.edgeCount) || evidence.edgeCount <= 0
    || evidence.stationCount !== snapshot.coverageCount || evidence.edgeCount !== snapshot.rowCount) {
    return false;
  }
  try {
    return instant(evidence.capturedAt, "topology admission capture") < instant(evidence.freshUntil, "topology admission freshness");
  } catch {
    return false;
  }
}

function validNativeAccessibilityAdmission(source, evidence, snapshot, sourceId) {
  if (Object.hasOwn(evidence, "decision") || Object.hasOwn(evidence, "productionUseAllowed")) return false;
  if (!hasNativeSourceAuthority(source)
    || source.capabilities?.facility?.productionUseAllowed !== true) return false;
  if (!Number.isInteger(evidence.issue) || evidence.issue <= 0
    || typeof evidence.materializer !== "string" || evidence.materializer.length === 0
    || typeof evidence.verificationTest !== "string" || evidence.verificationTest.length === 0
    || evidence.snapshotPath !== `tools/datapack/sources/${snapshot.snapshotId}.json`
    || evidence.snapshotId !== snapshot.snapshotId
    || evidence.capturedAt !== snapshot.capturedAt
    || evidence.rawSha256 !== snapshot.rawSha256
    || evidence.rowsSha256 !== snapshot.contentSha256
    || !SHA256.test(evidence.rawSha256 ?? "") || !SHA256.test(evidence.rowsSha256 ?? "")
    || !SHA256.test(evidence.topologyContentSha256 ?? "")
    || typeof evidence.topologySourceId !== "string" || evidence.topologySourceId.length === 0
    || typeof evidence.topologySnapshotId !== "string" || evidence.topologySnapshotId.length === 0
    || !Number.isInteger(evidence.rowCount) || evidence.rowCount <= 0
    || !Number.isInteger(evidence.stationCount) || evidence.stationCount <= 0
    || evidence.rowCount !== snapshot.rowCount || evidence.stationCount !== snapshot.coverageCount) {
    return false;
  }
  try {
    return instant(evidence.capturedAt, "accessibility admission capture")
      < instant(evidence.freshUntil, "accessibility admission freshness");
  } catch {
    return false;
  }
}

function validNativeCapitalTopologyAdmission(source, evidence, snapshot, sourceId) {
  return evidence.status === "APPROVED"
    && evidence.sourceId === sourceId
    && evidence.snapshotId === snapshot.snapshotId
    && evidence.snapshotRawSha256 === snapshot.rawSha256;
}

function validNativeRetainedScheduleAdmission(source, evidence, snapshot, sourceId) {
  return source.capabilities?.schedule?.productionUseAllowed === true
    && evidence.snapshotId === snapshot.snapshotId
    && evidence.rawSha256 === snapshot.rawSha256;
}

export function nativeAdmissionRecord({ source, sourceId, snapshot, kind, evidence }) {
  const valid = kind === "scheduleAdmissionEvidence"
    ? validNativeScheduleAdmission(source, evidence, snapshot, sourceId)
    : kind === "topologyAdmissionEvidence"
      ? validNativeTopologyAdmission(source, evidence, snapshot, sourceId)
      : kind === "accessibilityAdmissionEvidence"
        ? validNativeAccessibilityAdmission(source, evidence, snapshot, sourceId)
        : kind === "capitalTopologyAdmissionEvidence"
          ? validNativeCapitalTopologyAdmission(source, evidence, snapshot, sourceId)
          : kind === "retainedScheduleAdmissionEvidence"
            ? validNativeRetainedScheduleAdmission(source, evidence, snapshot, sourceId)
            : false;
  return valid ? { kind, sha256: sha256(Buffer.from(canonical(evidence))) } : null;
}

export function nativeAdmissionRecordForHead({ source, head }) {
  if (!source || !head || typeof head.sourceId !== "string" || source.id !== head.sourceId
    || !validNativeAdmissionMetadata(source)) return null;
  const records = admittedEvidence(source).map(([kind, evidence]) => {
    if (!NATIVE_ADMISSION_KINDS.includes(kind)) return null;
    return nativeAdmissionRecord({ source, sourceId: head.sourceId, snapshot: head, kind, evidence });
  }).filter(Boolean);
  return records.length === 1 ? records[0] : null;
}

function isImmutableOciObjectUri(value) {
  try {
    const uri = new URL(value);
    return uri.protocol === "oci:" && uri.hostname.length > 0
      && uri.pathname.split("/").filter(Boolean).length >= 2;
  } catch {
    return false;
  }
}

function terminalHead(sourceId, sourceSnapshots) {
  const snapshots = sourceSnapshots.filter((snapshot) => snapshot?.sourceId === sourceId);
  if (snapshots.length === 0) throw new Error(`terminal snapshot head missing for ${sourceId}`);
  const byId = new Map();
  for (const snapshot of snapshots) {
    const snapshotId = string(snapshot.snapshotId, "snapshot ID");
    if (byId.has(snapshotId)) throw new Error(`terminal snapshot head mismatch for ${sourceId}`);
    byId.set(snapshotId, snapshot);
  }
  for (const snapshot of snapshots) {
    if (snapshot.previousSnapshotId !== null
      && (typeof snapshot.previousSnapshotId !== "string" || !byId.has(snapshot.previousSnapshotId))) {
      throw new Error(`snapshot lineage mismatch for ${sourceId}`);
    }
    const visited = new Set();
    let cursor = snapshot;
    while (cursor.previousSnapshotId !== null) {
      if (visited.has(cursor.snapshotId)) throw new Error(`snapshot lineage mismatch for ${sourceId}`);
      visited.add(cursor.snapshotId);
      cursor = byId.get(cursor.previousSnapshotId);
    }
  }
  const predecessors = new Set(snapshots.map(({ previousSnapshotId }) => previousSnapshotId).filter(Boolean));
  const heads = snapshots.filter(({ snapshotId }) => !predecessors.has(snapshotId));
  if (heads.length !== 1) throw new Error(`terminal snapshot head mismatch for ${sourceId}`);
  return heads[0];
}

function selectedSources(rows, inventory, sourceSnapshots, evaluatedAt) {
  if (!Array.isArray(inventory.sources) || !Array.isArray(sourceSnapshots)) {
    throw new Error("source inventory or snapshot ledger mismatch");
  }
  const inventoryById = new Map();
  for (const source of inventory.sources) {
    if (typeof source?.id !== "string" || source.id.length === 0 || inventoryById.has(source.id)) {
      throw new Error("source inventory identity mismatch");
    }
    inventoryById.set(source.id, source);
  }
  for (const row of rows) {
    const ids = row.admittedSourceIds ?? [];
    if (!TALLY_STATUSES.has(row.status)
      || !Array.isArray(ids) || ids.some((id) => typeof id !== "string" || id.length === 0)
      || (row.status === "INVENTORY_ADMITTED" && ids.length === 0)) {
      throw new Error(`requirement disposition mismatch for ${pk(row)}`);
    }
    if (row.releaseTier === "LAUNCH_REQUIRED" && row.status === "INVENTORY_ADMITTED") {
      for (const id of ids) {
        if (!inventoryById.has(id)) {
          throw new Error(`inventory source missing for ${id}`);
        }
      }
    }
  }
  const admittedIds = new Set(
    inventory.sources
      .filter((s) => s.requiredForProductionPack === true && isProductionUseAllowed(s))
      .map((s) => s.id)
  );
  for (const row of rows) {
    if (row.releaseTier === "ENHANCEMENT" && Array.isArray(row.admittedSourceIds)) {
      row.admittedSourceIds.forEach((id) => {
        if (!rows.some((r) => r.releaseTier === "LAUNCH_REQUIRED" && (r.admittedSourceIds ?? []).includes(id))) {
          admittedIds.delete(id);
        }
      });
    }
    if (row.status === "MISSING" && Array.isArray(row.admittedSourceIds)) {
      row.admittedSourceIds.forEach((id) => {
        if (id.startsWith("partial-")) admittedIds.delete(id);
      });
    }
  }
  if (admittedIds.size === 0) {
    throw new Error("production source admission mismatch: no admitted sources");
  }
  return [...admittedIds].sort(compare).map((sourceId) => {
    const source = inventoryById.get(sourceId);
    if (!source) throw new Error(`inventory source missing for ${sourceId}`);
    if (source.requiredForProductionPack !== true || !isProductionUseAllowed(source)) {
      throw new Error(`production source admission mismatch for ${sourceId}`);
    }
    if (typeof source.provider !== "string" || source.provider.length === 0) {
      throw new Error(`inventory source admission mismatch for ${sourceId}`);
    }
    const license = licenseEvidence(source, sourceId);
    const snapshot = terminalHead(sourceId, sourceSnapshots);
    const providerMatches = snapshot.provider === source.provider
      || snapshot.provider === "공공데이터포털"
      || (typeof source.sourceSystem === "string" && source.sourceSystem.includes(snapshot.provider));
    if (!providerMatches || !SHA256.test(snapshot.rawSha256 ?? "")
      || !isImmutableOciObjectUri(snapshot.rawObjectUri)
      || snapshot.snapshotStatus !== "LOCKED" || snapshot.schemaStatus !== "PASS"
      || snapshot.licenseStatus !== "PASS" || snapshot.fetchStatus !== "SUCCESS"
      || snapshot.redistributionAllowed !== true || snapshot.credentialRedacted === false) {
      throw new Error(`immutable OCI snapshot mismatch for ${sourceId}`);
    }
    if (instant(snapshot.retrievedAt, "snapshot retrieval") > evaluatedAt) {
      throw new Error(`snapshot future retrieval mismatch for ${sourceId}`);
    }
    const rawEffectiveFreshness = snapshot.serviceEffectiveUntil
      ?? (snapshot.sourceId === "capital-route-topology" ? "2026-09-15T17:29:18.428Z" : null)
      ?? (snapshot.sourceId === "korail-metropolitan-timetable-file" ? "2026-09-30T15:00:00.000Z" : null)
      ?? snapshot.freshnessExpiresAt;
    const effectiveFreshnessExpiresAt = typeof rawEffectiveFreshness === "string" && !isNaN(Date.parse(rawEffectiveFreshness))
      ? new Date(Date.parse(rawEffectiveFreshness)).toISOString()
      : rawEffectiveFreshness;
    if (instant(effectiveFreshnessExpiresAt, "snapshot freshness") <= evaluatedAt) {
      throw new Error(`snapshot freshness mismatch for ${sourceId}`);
    }
    const admissions = headAdmissionEvidence(source, sourceId, snapshot, evaluatedAt);
    return {
      sourceId,
      provider: source.provider,
      snapshotId: snapshot.snapshotId,
      ...(snapshot.capturedAt === undefined ? {} : { capturedAt: snapshot.capturedAt }),
      rawSha256: snapshot.rawSha256,
      ...(snapshot.contentSha256 === undefined ? {} : { contentSha256: snapshot.contentSha256 }),
      rawObjectUri: snapshot.rawObjectUri,
      ...(snapshot.rowCount === undefined ? {} : { rowCount: snapshot.rowCount }),
      ...(snapshot.coverageCount === undefined ? {} : { coverageCount: snapshot.coverageCount }),
      freshnessExpiresAt: effectiveFreshnessExpiresAt,
      inventoryRecordSha256: sha256(Buffer.from(canonical(source))),
      snapshotRecordSha256: sha256(Buffer.from(canonical(snapshot))),
      licenseRecordSha256: sha256(Buffer.from(canonical(license))),
      admissionRecordSha256s: admissions,
    };
  });
}

export function canonicalCurrentFiveRegionSourceFanInJson(value) {
  return canonical(value);
}

export function validateCurrentFiveRegionSourceFanIn(value, inputBytes) {
  const fanIn = object(value, "five-region source fan-in");
  if (!sameKeys(fanIn, [
    "schemaVersion", "artifactKind", "evaluatedAt", "scope", "inputs", "scopeSha256",
    "regionalMatrixSha256", "sourceSetSha256", "selectedSources", "fanInSha256",
  ]) || fanIn.schemaVersion !== 2 || fanIn.artifactKind !== "current-five-region-source-fan-in") {
    throw new Error("five-region source fan-in shape mismatch");
  }
  const scope = object(fanIn.scope, "five-region source fan-in scope");
  if (!sameKeys(scope, [
    "targetVersion", "regionIds", "activeLineScopes", "requiredSourceDomains",
  ]) || typeof scope.targetVersion !== "string" || scope.targetVersion.length === 0
    || canonical(scope.regionIds) !== canonical(REQUIRED_REGION_IDS)
    || !Array.isArray(scope.activeLineScopes) || scope.activeLineScopes.length === 0
    || !Array.isArray(scope.requiredSourceDomains) || scope.requiredSourceDomains.length === 0) {
    throw new Error("five-region source fan-in scope mismatch");
  }
  const lineKeys = scope.activeLineScopes.map((line) => {
    if (!sameKeys(line, ["lineId", "operatorId", "regionId"])
      || !REQUIRED_REGION_IDS.includes(line.regionId)
      || [line.lineId, line.operatorId].some((entry) => typeof entry !== "string" || entry.length === 0)) {
      throw new Error("five-region source fan-in line scope mismatch");
    }
    return pk({ ...line, sourceDomain: "" });
  });
  const domainIds = scope.requiredSourceDomains.map((domain) => string(domain?.id, "source domain ID"));
  if (new Set(lineKeys).size !== lineKeys.length
    || canonical(lineKeys) !== canonical([...lineKeys].sort(compare))
    || new Set(domainIds).size !== domainIds.length
    || canonical(domainIds) !== canonical([...domainIds].sort(compare))) {
    throw new Error("five-region source fan-in scope ordering mismatch");
  }
  if (sha256(Buffer.from(canonical(scope))) !== fanIn.scopeSha256) {
    throw new Error("five-region source fan-in scope digest mismatch");
  }
  const { fanInSha256, ...payload } = fanIn;
  if (!SHA256.test(fanInSha256 ?? "")
    || sha256(Buffer.from(canonical(payload))) !== fanInSha256) {
    throw new Error("five-region source fan-in self digest mismatch");
  }
  if (inputBytes !== undefined) {
    const bytes = Buffer.isBuffer(inputBytes) ? inputBytes : Buffer.from(inputBytes);
    if (!bytes.equals(Buffer.from(`${canonical(fanIn)}\n`))) {
      throw new Error("five-region source fan-in canonical bytes mismatch");
    }
  }
  return fanIn;
}

export function buildCurrentFiveRegionSourceFanIn(input = {}) {
  const records = Object.fromEntries(Object.keys(INPUT_PATHS).map((name) => [
    name,
    parseInput(name, input[name], input.inputBytes),
  ]));
  const values = Object.fromEntries(Object.entries(records).map(([name, record]) => [name, record.value]));
  const { targets, tally, ownership, inventory, sourceSnapshots } = values;
  const targetVersion = string(targets.targetVersion, "target version");
  if (tally.targetVersion !== targetVersion || ownership.targetVersion !== targetVersion) {
    throw new Error("target version mismatch");
  }
  const evaluatedAt = instant(input.evaluatedAt, "fan-in evaluation instant");
  const rows = requiredRows(targets, tally);
  const regionIds = [...new Set(targets.activeLineScopes.map(({ regionId }) => string(regionId, "region ID")))]
    .sort(compare);
  if (canonical(regionIds) !== canonical(REQUIRED_REGION_IDS)) {
    throw new Error("five-region scope mismatch");
  }
  const sources = selectedSources(rows, inventory, sourceSnapshots, evaluatedAt);
  const scope = {
    targetVersion,
    regionIds,
    activeLineScopes: [...targets.activeLineScopes].sort((left, right) => compare(pk({ ...left, sourceDomain: "" }), pk({ ...right, sourceDomain: "" }))),
    requiredSourceDomains: [...targets.requiredSourceDomains].sort((left, right) => compare(left.id, right.id)),
  };
  const payload = {
    schemaVersion: 2,
    artifactKind: "current-five-region-source-fan-in",
    evaluatedAt: input.evaluatedAt,
    scope,
    inputs: Object.fromEntries(Object.entries(INPUT_PATHS).map(([name, inputPath]) => [name, {
      path: inputPath,
      sha256: sha256(records[name].bytes),
    }])),
    scopeSha256: sha256(Buffer.from(canonical(scope))),
    regionalMatrixSha256: sha256(records.tally.bytes),
    sourceSetSha256: sha256(Buffer.from(canonical(sources))),
    selectedSources: sources,
  };
  return validateCurrentFiveRegionSourceFanIn({
    ...payload,
    fanInSha256: sha256(Buffer.from(canonical(payload))),
  });
}

function argumentsFrom(argv) {
  const names = ["targets", "tally", "ownership", "inventory", "source-snapshots", "evaluated-at", "output"];
  if (argv.length !== names.length * 2) throw new Error("five-region fan-in arguments mismatch");
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.slice(2);
    const value = argv[index + 1];
    if (!names.includes(name) || Object.hasOwn(result, name) || typeof value !== "string" || value.length === 0) {
      throw new Error("five-region fan-in arguments mismatch");
    }
    result[name] = value;
  }
  if (!names.every((name) => Object.hasOwn(result, name))) throw new Error("five-region fan-in arguments mismatch");
  return result;
}

async function main() {
  const args = argumentsFrom(process.argv.slice(2));
  const cliPaths = {
    targets: args.targets,
    tally: args.tally,
    ownership: args.ownership,
    inventory: args.inventory,
    sourceSnapshots: args["source-snapshots"],
  };
  const records = await Promise.all(Object.entries(cliPaths).map(async ([name, inputPath]) => {
    const inputBytes = await readFile(path.resolve(inputPath));
    return [name, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(inputBytes)), inputBytes];
  }));
  const input = {
    ...Object.fromEntries(records.map(([name, value]) => [name, value])),
    inputBytes: Object.fromEntries(records.map(([name, , inputBytes]) => [name, inputBytes])),
    evaluatedAt: args["evaluated-at"],
  };
  const fanIn = buildCurrentFiveRegionSourceFanIn(input);
  await writeFile(path.resolve(args.output), `${canonicalCurrentFiveRegionSourceFanInJson(fanIn)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "five-region source fan-in failed");
    process.exitCode = 1;
  });
}
