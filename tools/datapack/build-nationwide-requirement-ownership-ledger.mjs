#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const LEDGER_PATH = "tools/datapack/reports/nationwide-requirement-ownership-ledger.json";
const INPUT_PATHS = {
  targets: "tools/datapack/nationwide-coverage-targets.json",
  tally: "tools/datapack/reports/nationwide-coverage-tally.json",
  inventory: "tools/datapack/source-inventory.json",
  ownership: "tools/datapack/release/nationwide-requirement-ownership.json",
  sourceSnapshots: "tools/datapack/release/source-snapshots.json",
  candidateBuildSpec: "tools/datapack/release/candidate-build-spec.json",
};
const AXES = ["licenseLineage", "freshnessLineage", "admissionLineage", "artifactLineage", "runtimeLineage"];
const ISSUE_URL = "https://github.com/AquilaXk/easysubway-data/issues/";

const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const pk = (row) => [row.regionId, row.operatorId, row.lineId, row.sourceDomain].join(":");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const owner = (issue) => ({ issue, issueUrl: `${ISSUE_URL}${issue}` });
const matches = (rule, row) => ["regionId", "operatorId", "lineId", "sourceDomain"]
  .every((key) => rule[key] === undefined || rule[key] === row[key]);
const specificity = (rule) => ["regionId", "operatorId", "lineId", "sourceDomain"]
  .filter((key) => rule[key] !== undefined).length;

function requiredOwner(rules, row) {
  const candidates = rules.filter((rule) => matches(rule, row));
  const maximum = Math.max(...candidates.map(specificity));
  const effective = candidates.filter((rule) => specificity(rule) === maximum);
  if (effective.length !== 1 || !Number.isInteger(effective[0]?.issue) || effective[0].issue < 1) {
    throw new Error(`unowned or ambiguous PK ${pk(row)}`);
  }
  return owner(effective[0].issue);
}

function strictSourceCovers(source, row) {
  const scope = source.coverageScope;
  const fields = source.fieldsProvided;
  for (const key of ["regionIds", "operatorIds", "lineIds", "sourceDomains"]) {
    if (!Array.isArray(scope?.[key]) || scope[key].length === 0) throw new Error(`empty ${key} for source ${source.id}`);
  }
  if (!Array.isArray(fields) || fields.length === 0) throw new Error(`required fields missing for source ${source.id}`);
  return scope.regionIds.includes(row.regionId)
    && scope.operatorIds.includes(row.operatorId)
    && scope.lineIds.includes(row.lineId)
    && scope.sourceDomains.includes(row.sourceDomain);
}

function currentHeads(sourceSnapshots, candidateBuildSpec) {
  if (!Array.isArray(sourceSnapshots) || !Array.isArray(candidateBuildSpec.sourceSnapshots)
    || !Array.isArray(candidateBuildSpec.sourceSnapshotIds)) throw new Error("current source snapshot inputs are required");
  const snapshotById = new Map(sourceSnapshots.map((snapshot) => [snapshot.snapshotId, snapshot]));
  if (snapshotById.size !== sourceSnapshots.length) throw new Error("current-head source identity mismatch");
  const heads = new Map();
  for (const head of candidateBuildSpec.sourceSnapshots) {
    const snapshot = snapshotById.get(head.snapshotId);
    if (!candidateBuildSpec.sourceSnapshotIds.includes(head.snapshotId)
      || snapshot?.sourceId !== head.sourceId
      || snapshot.rawSha256 !== head.rawSha256
      || snapshot.rawObjectUri !== head.rawObjectUri
      || heads.has(head.sourceId)) throw new Error("current-head source identity mismatch");
    heads.set(head.sourceId, head);
  }
  if (heads.size !== candidateBuildSpec.sourceSnapshots.length) throw new Error("current-head source identity mismatch");
  return heads;
}

function pending(reason, childOwner) { return { state: "PENDING", reason, owner: childOwner }; }

function admittedEvidence(source) {
  return Object.entries(source).filter(([key, value]) => (key === "admissionEvidence" || key.endsWith("AdmissionEvidence"))
    && value && typeof value === "object" && !Array.isArray(value)).map(([kind, value]) => ({ kind, ...value }));
}

function evidenced(refs) { return { state: "EVIDENCED", refs }; }

function firstRuntimeEvidence(source) {
  return source.runtimeLineageEvidence ?? source.runtimeEvidence ?? null;
}

function isStrictlyAfter(value, publishedAt) {
  const timestamp = Date.parse(value);
  const cutoff = Date.parse(publishedAt);
  return Number.isFinite(timestamp) && Number.isFinite(cutoff) && timestamp > cutoff;
}

function lineageFor(sources, heads, publishedAt, childOwner, dispositionStatus) {
  const pendingReason = dispositionStatus === "INVENTORY_ADMITTED"
    ? "CURRENT_SOURCE_SNAPSHOT_HEAD_REQUIRED" : "CONTRACT_GAP";
  const centralHeads = sources.map(({ id }) => heads.get(id)).filter(Boolean);
  const allCentral = centralHeads.length === sources.length && sources.length > 0;
  const evidence = sources.flatMap(admittedEvidence);
  const licenses = sources.filter(({ license, licenseReview }) => license || licenseReview)
    .map(({ id, license, licenseReview }) => ({ sourceId: id, license: license ?? null, licenseReview: licenseReview ?? null }));
  const fresh = sources.map((source) => ({
    sourceId: source.id, observedDataUpdatedAt: source.observedDataUpdatedAt ?? null,
    retrievedAt: source.retrievedAt ?? null,
    admissionEvidence: admittedEvidence(source).map(({ kind, capturedAt, freshUntil }) => ({ kind, capturedAt: capturedAt ?? null, freshUntil: freshUntil ?? null })),
    currentHead: heads.get(source.id) ? {
      snapshotId: heads.get(source.id).snapshotId,
      freshnessExpiresAt: heads.get(source.id).freshnessExpiresAt ?? null,
    } : null,
  }));
  const freshEnough = fresh.length > 0 && fresh.every((ref) => isStrictlyAfter(ref.currentHead?.freshnessExpiresAt, publishedAt)
    || ref.admissionEvidence.some(({ freshUntil }) => isStrictlyAfter(freshUntil, publishedAt)));
  const inventoryArtifacts = evidence.filter(({ snapshotId, snapshotPath, rawSha256 }) => snapshotId && snapshotPath && rawSha256)
    .map(({ kind, snapshotId, snapshotPath, rawSha256 }) => ({ kind, snapshotId, snapshotPath, rawSha256 }));
  const runtime = sources.map(firstRuntimeEvidence).filter(Boolean);
  return {
    licenseLineage: sources.length > 0 && licenses.length === sources.length ? evidenced(licenses) : pending(pendingReason, childOwner),
    freshnessLineage: freshEnough ? evidenced(fresh) : pending(pendingReason, childOwner),
    admissionLineage: sources.length > 0 && sources.every((source) => source.productionUseAllowed === true
      && admittedEvidence(source).some(({ decision }) => decision === "APPROVED"))
      ? evidenced(sources.map(({ id, productionUseAllowed }) => ({ sourceId: id, productionUseAllowed, admissions: admittedEvidence(sources.find((source) => source.id === id)) })))
      : pending(pendingReason, childOwner),
    artifactLineage: allCentral
      ? evidenced(centralHeads.map(({ sourceId, snapshotId, rawSha256, rawObjectUri }) => ({ sourceId, snapshotId, rawSha256, rawObjectUri })).sort((left, right) => compare(left.sourceId, right.sourceId)))
      : sources.length > 0 && inventoryArtifacts.length === sources.length ? evidenced(inventoryArtifacts) : pending(pendingReason, childOwner),
    runtimeLineage: sources.length > 0 && runtime.length === sources.length ? evidenced(runtime) : pending("RUNTIME_LINEAGE_REQUIRED", childOwner),
  };
}

export function buildNationwideRequirementOwnershipLedger(inputs) {
  const { targets, tally, inventory, ownership, sourceSnapshots, candidateBuildSpec, inputBytes = {} } = inputs;
  if (targets.targetVersion !== tally.targetVersion || targets.targetVersion !== ownership.targetVersion) throw new Error("targetVersion drift");
  if (!Array.isArray(ownership.ownerRules) || ownership.ownerRules.length === 0) throw new Error("owner rules are required");
  const heads = currentHeads(sourceSnapshots, candidateBuildSpec);
  const targetPks = new Set(targets.activeLineScopes.flatMap((scope) => targets.requiredSourceDomains
    .map((domain) => `${scope.regionId}:${scope.operatorId}:${scope.lineId}:${domain.id}`)));
  const seen = new Set();
  const rows = [...tally.launchRequired.requirements, ...tally.enhancement.requirements].map((tallyRow) => {
    const key = pk(tallyRow);
    if (!targetPks.has(key) || seen.has(key)) throw new Error(`tally PK drift ${key}`);
    seen.add(key);
    const childOwner = requiredOwner(ownership.ownerRules, tallyRow);
    const admittedSourceIds = [...(tallyRow.admittedSourceIds ?? [])].sort(compare);
    const admittedSources = [];
    if (tallyRow.status === "INVENTORY_ADMITTED") {
      if (admittedSourceIds.length === 0) throw new Error(`admitted source missing for ${key}`);
      const providedFields = new Set();
      for (const sourceId of admittedSourceIds) {
        const source = inventory.sources.find((candidate) => candidate.id === sourceId);
        if (!source || !strictSourceCovers(source, tallyRow)) throw new Error(`admitted source mismatch for ${key}: ${sourceId}`);
        admittedSources.push(source);
        source.fieldsProvided.forEach((field) => providedFields.add(field));
      }
      if (providedFields.size < tallyRow.admittedFieldCount) throw new Error(`required fields mismatch for ${key}`);
    } else if (admittedSourceIds.length !== 0) throw new Error(`unexpected admitted source for ${key}`);
    const pendingReason = tallyRow.status === "INVENTORY_ADMITTED"
      ? "CURRENT_SOURCE_SNAPSHOT_HEAD_REQUIRED" : "CONTRACT_GAP";
    const officialSources = admittedSources.filter(({ id, provider, datasetUrl, sourceSystem }) =>
      id && provider && datasetUrl && sourceSystem).map(({ id, provider, datasetUrl, sourceSystem }) =>
      ({ sourceId: id, provider, datasetUrl, sourceSystem }));
    return {
      pk: key, regionId: tallyRow.regionId, operatorId: tallyRow.operatorId, lineId: tallyRow.lineId,
      sourceDomain: tallyRow.sourceDomain, releaseTier: tallyRow.releaseTier,
      disposition: {
        status: tallyRow.status, missingKind: tallyRow.missingKind ?? null,
        resolutionReviewStatus: tallyRow.resolutionReviewStatus ?? null, admittedSourceIds,
      },
      childOwner,
      officialSourceFamily: officialSources.length === admittedSources.length && admittedSources.length > 0
        ? evidenced(officialSources) : pending(pendingReason, childOwner),
      lineage: lineageFor(admittedSources, heads, candidateBuildSpec.publishedAt, childOwner, tallyRow.status),
    };
  }).sort((left, right) => compare(left.pk, right.pk));
  if (seen.size !== targetPks.size) throw new Error("ownership PK set drift");
  const launchRows = rows.filter(({ releaseTier }) => releaseTier === "LAUNCH_REQUIRED");
  const count = (status) => launchRows.filter((row) => row.disposition.status === status).length;
  return {
    schemaVersion: 1, artifactKind: "nationwide-requirement-ownership-ledger", issue: 449,
    targetVersion: targets.targetVersion,
    provenance: {
      regeneration: { command: "node tools/datapack/build-nationwide-requirement-ownership-ledger.mjs", outputPath: LEDGER_PATH },
      inputs: Object.fromEntries(Object.entries(INPUT_PATHS).map(([name, inputPath]) => [name, {
        path: inputPath, sha256: hash(inputBytes[name] ?? JSON.stringify(inputs[name])),
      }])),
    },
    summary: {
      launchRequired: {
        totalCount: launchRows.length, inventoryAdmittedCount: count("INVENTORY_ADMITTED"),
        explicitlyUnsupportedWithEvidenceCount: count("EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE"),
        missingCount: count("MISSING"), terminalCount: count("INVENTORY_ADMITTED") + count("EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE"),
      },
      enhancement: { totalCount: rows.length - launchRows.length, blocking: false },
      duplicatePkCount: 0, unownedPkCount: 0, nationwideEligibility: "NO_GO",
    },
    rows,
  };
}

async function main() {
  const root = process.cwd();
  const records = await Promise.all(Object.entries(INPUT_PATHS).map(async ([name, relativePath]) => {
    const bytes = await readFile(path.join(root, relativePath), "utf8");
    return [name, JSON.parse(bytes), bytes];
  }));
  const inputs = Object.fromEntries(records.map(([name, value]) => [name, value]));
  inputs.inputBytes = Object.fromEntries(records.map(([name, , bytes]) => [name, bytes]));
  await writeFile(path.join(root, LEDGER_PATH), `${JSON.stringify(buildNationwideRequirementOwnershipLedger(inputs), null, 2)}\n`);
}
if (process.argv[1] === new URL(import.meta.url).pathname) main();
