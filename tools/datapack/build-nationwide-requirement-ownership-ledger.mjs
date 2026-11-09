#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildCurrentFiveRegionSourceFanIn,
  REPRODUCTION_GOVERNANCE,
  canonicalCurrentFiveRegionSourceFanInJson,
  CURRENT_FIVE_REGION_SOURCE_FAN_IN_PATH,
  nativeAdmissionRecordForHead,
  validateCurrentFiveRegionSourceFanIn,
} from "./build-current-five-region-source-fan-in.mjs";
import { inventoryCoverageFields, inventoryCoverageScope, matchesInventoryLineOperatorScope } from "./report-coverage-gaps.mjs";

export const LEDGER_PATH = "tools/datapack/reports/nationwide-requirement-ownership-ledger.json";
const INPUT_PATHS = {
  targets: "tools/datapack/nationwide-coverage-targets.json",
  tally: "tools/datapack/reports/nationwide-coverage-tally.json",
  inventory: "tools/datapack/source-inventory.json",
  ownership: "tools/datapack/release/nationwide-requirement-ownership.json",
  sourceSnapshots: "tools/datapack/release/source-snapshots.json",
  fanIn: CURRENT_FIVE_REGION_SOURCE_FAN_IN_PATH,
};
const AXES = ["licenseLineage", "freshnessLineage", "admissionLineage", "artifactLineage", "runtimeLineage"];
const ISSUE_URL = "https://github.com/AquilaXk/easysubway-data/issues/";
const RULE_KEYS = Object.freeze(["regionId", "operatorId", "lineId", "sourceDomain"]);
export const DEMAND_REFERENCE_DOMAIN = "demand_reference";
export const DEMAND_REFERENCE_OWNER_ISSUE = 453;
export const DEMAND_REFERENCE_SOURCE_ID = "seoul-subway-hourly-boarding";
export const FIVE_REGION_IDS = Object.freeze(["busan", "capital", "daegu", "daejeon", "gwangju"]);
export const SEOUL_METRO_DEMAND_REFERENCE_LINE_IDS = Object.freeze([
  "line-15b3b8a93259",
  "line-2b2d9eaa53d0",
  "line-3f41718e0833",
  "line-41a8c75ec9d8",
  "line-472a81add377",
  "line-80fc4d5350d4",
  "seoul-2",
  "seoul-4",
]);
const EXPECTED_FIVE_REGION_LINE_COUNTS = Object.freeze({
  busan: 6,
  capital: 33,
  daegu: 4,
  daejeon: 1,
  gwangju: 1,
});
const DEMAND_REFERENCE_REQUIRED_FIELDS = Object.freeze([
  "hourly_boarding_count",
  "hourly_alighting_count",
]);

const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const pk = (row) => [row.regionId, row.operatorId, row.lineId, row.sourceDomain].join(":");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const owner = (issue) => ({ issue, issueUrl: `${ISSUE_URL}${issue}` });
const matches = (rule, row) => RULE_KEYS
  .every((key) => rule[key] === undefined || rule[key] === row[key]);
const specificity = (rule) => RULE_KEYS
  .filter((key) => rule[key] !== undefined).length;
const subsumesRule = (parent, child) => RULE_KEYS
  .every((key) => parent[key] === undefined || parent[key] === child[key]);
const compatibleRules = (left, right) => RULE_KEYS
  .every((key) => left[key] === undefined || right[key] === undefined || left[key] === right[key]);

export function normalizeNationwideOwnershipRules(rules) {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error("owner rules are required");
  }
  return rules.filter((rule) => {
    const ruleSpecificity = specificity(rule);
    const hasNonConflictedGeneralParent = rules.some((parent) =>
      parent !== rule
      && parent.issue === rule.issue
      && subsumesRule(parent, rule)
      && specificity(parent) < ruleSpecificity
      && !rules.some((other) =>
        other.issue !== rule.issue
        && compatibleRules(other, rule)
        && specificity(other) >= specificity(parent)));
    return !hasNonConflictedGeneralParent;
  });
}

export function resolveNationwideRequirementOwner(rules, row) {
  const normalizedRules = normalizeNationwideOwnershipRules(rules);
  const candidates = normalizedRules.filter((rule) => matches(rule, row));
  const maximum = Math.max(...candidates.map(specificity));
  const effective = candidates.filter((rule) => specificity(rule) === maximum);
  if (effective.length !== 1 || !Number.isInteger(effective[0]?.issue) || effective[0].issue < 1) {
    throw new Error(`unowned or ambiguous PK ${pk(row)}`);
  }
  return owner(effective[0].issue);
}

export function validateDemandReferenceOwnershipContract(ledgerOrInput, options = {}) {
  const input = Array.isArray(ledgerOrInput?.rows)
    ? { ledger: ledgerOrInput, ...options }
    : (ledgerOrInput ?? {});
  const { ledger, targets, inventory, ownership } = input;
  if (!ledger || !Array.isArray(ledger.rows)) {
    throw new Error("valid ownership ledger is required");
  }
  if (ledger.summary?.enhancement?.blocking !== false) {
    throw new Error("enhancement.blocking must be false");
  }
  let canonicalRule = { issue: DEMAND_REFERENCE_OWNER_ISSUE, sourceDomain: DEMAND_REFERENCE_DOMAIN };
  if (ownership?.ownerRules !== undefined) {
    const normalizedRules = normalizeNationwideOwnershipRules(ownership.ownerRules);
    const demandRules = normalizedRules.filter((rule) => rule.sourceDomain === DEMAND_REFERENCE_DOMAIN);
    if (
      demandRules.length !== 1
      || demandRules[0].issue !== DEMAND_REFERENCE_OWNER_ISSUE
      || demandRules[0].regionId !== undefined
      || demandRules[0].operatorId !== undefined
      || demandRules[0].lineId !== undefined
    ) {
      throw new Error("demand_reference ownership rule must normalize to single issue 453 rule");
    }
    [canonicalRule] = demandRules;
  }

  if (inventory?.sources !== undefined) {
    const demandSource = inventory.sources.find((source) => source.id === DEMAND_REFERENCE_SOURCE_ID);
    const scope = demandSource?.coverageScope;
    const fields = demandSource?.fieldsProvided ?? [];
    if (
      !demandSource
      || !scope?.regionIds?.includes("capital")
      || !scope?.operatorIds?.includes("seoul-metro")
      || !scope?.sourceDomains?.includes(DEMAND_REFERENCE_DOMAIN)
      || !DEMAND_REFERENCE_REQUIRED_FIELDS.every((field) => fields.includes(field))
    ) {
      throw new Error("seoul-subway-hourly-boarding demand_reference inventory contract mismatch");
    }
  }

  const demandRows = ledger.rows
    .filter((row) => row.sourceDomain === DEMAND_REFERENCE_DOMAIN)
    .sort((left, right) => compare(left.pk, right.pk));
  if (demandRows.length !== 45) {
    throw new Error(`expected 45 demand_reference PKs across 5 regions, got ${demandRows.length}`);
  }
  if (Array.isArray(targets?.activeLineScopes)) {
    const expectedTargetPks = targets.activeLineScopes
      .map((scope) => `${scope.regionId}:${scope.operatorId}:${scope.lineId}:${DEMAND_REFERENCE_DOMAIN}`)
      .sort(compare);
    const actualPks = demandRows.map((row) => row.pk);
    if (JSON.stringify(actualPks) !== JSON.stringify(expectedTargetPks)) {
      throw new Error("demand_reference PK set does not match activeLineScopes");
    }
  }

  const regionCounts = Object.fromEntries(FIVE_REGION_IDS.map((regionId) => [regionId, 0]));
  const expectedAdmittedPks = new Set(
    SEOUL_METRO_DEMAND_REFERENCE_LINE_IDS.map((lineId) => `capital:seoul-metro:${lineId}:${DEMAND_REFERENCE_DOMAIN}`),
  );
  const admittedPks = [];
  const missingPks = [];
  const expectedIssueUrl = `${ISSUE_URL}${DEMAND_REFERENCE_OWNER_ISSUE}`;

  for (const row of demandRows) {
    if (!Object.hasOwn(regionCounts, row.regionId)) {
      throw new Error(`unexpected regionId ${row.regionId} in ${row.pk}`);
    }
    regionCounts[row.regionId] += 1;
    if (row.releaseTier !== "ENHANCEMENT") {
      throw new Error(`demand_reference releaseTier drift for ${row.pk}`);
    }
    if (row.childOwner?.issue !== DEMAND_REFERENCE_OWNER_ISSUE || row.childOwner?.issueUrl !== expectedIssueUrl) {
      throw new Error(`demand_reference owner drift for ${row.pk}`);
    }
    if (expectedAdmittedPks.has(row.pk)) {
      if (
        row.disposition?.status !== "INVENTORY_ADMITTED"
        || JSON.stringify(row.disposition?.admittedSourceIds) !== JSON.stringify([DEMAND_REFERENCE_SOURCE_ID])
      ) {
        throw new Error(`expected INVENTORY_ADMITTED for ${row.pk}`);
      }
      admittedPks.push(row.pk);
    } else {
      if (
        row.disposition?.status !== "MISSING"
        || !Array.isArray(row.disposition?.admittedSourceIds)
        || row.disposition.admittedSourceIds.length !== 0
      ) {
        throw new Error(`expected MISSING disposition for ${row.pk}`);
      }
      if (
        row.officialSourceFamily?.state !== "PENDING"
        || row.officialSourceFamily?.reason !== "CONTRACT_GAP"
        || row.officialSourceFamily?.owner?.issue !== DEMAND_REFERENCE_OWNER_ISSUE
        || row.lineage?.licenseLineage?.reason !== "CONTRACT_GAP"
        || row.lineage?.freshnessLineage?.reason !== "CONTRACT_GAP"
        || row.lineage?.artifactLineage?.reason !== "CONTRACT_GAP"
      ) {
        throw new Error(`expected CONTRACT_GAP for MISSING demand_reference PK ${row.pk}`);
      }
      missingPks.push(row.pk);
    }
  }

  for (const regionId of FIVE_REGION_IDS) {
    if (regionCounts[regionId] !== EXPECTED_FIVE_REGION_LINE_COUNTS[regionId]) {
      throw new Error(`demand_reference region count drift for ${regionId}`);
    }
  }

  return {
    issue: DEMAND_REFERENCE_OWNER_ISSUE,
    sourceDomain: DEMAND_REFERENCE_DOMAIN,
    releaseTier: "ENHANCEMENT",
    blocking: false,
    totalPkCount: demandRows.length,
    regionCounts,
    admittedSourceId: DEMAND_REFERENCE_SOURCE_ID,
    admittedPkCount: admittedPks.length,
    admittedPks,
    missingContractGapCount: missingPks.length,
    missingPks,
    canonicalRule,
  };
}

function strictSourceCovers(source, row) {
  const scope = inventoryCoverageScope(source);
  const fields = source.fieldsProvided;
  for (const key of ["regionIds", "operatorIds", "lineIds", "sourceDomains"]) {
    if (!Array.isArray(scope?.[key]) || scope[key].length === 0) throw new Error(`empty ${key} for source ${source.id}`);
  }
  if (!Array.isArray(fields) || fields.length === 0) throw new Error(`required fields missing for source ${source.id}`);
  return scope.regionIds.includes(row.regionId)
    && scope.operatorIds.includes(row.operatorId)
    && scope.lineIds.includes(row.lineId)
    && matchesInventoryLineOperatorScope(scope, row)
    && scope.sourceDomains.includes(row.sourceDomain);
}

function selectedHeads(fanIn) {
  const heads = new Map();
  for (const head of fanIn.selectedSources) {
    if (typeof head?.sourceId !== "string" || head.sourceId.length === 0 || heads.has(head.sourceId)) {
      throw new Error("fan-in selected source identity mismatch");
    }
    heads.set(head.sourceId, head);
  }
  return heads;
}

function currentFanIn(inputs) {
  const { targets, tally, ownership, inventory, sourceSnapshots, fanIn, inputBytes = {} } = inputs;
  if (Object.hasOwn(inputs, "candidateBuildSpec")) throw new Error("candidate build spec input is not supported");
  const fanInBytes = inputBytes.fanIn;
  if (!(Buffer.isBuffer(fanInBytes) || typeof fanInBytes === "string")) throw new Error("fan-in input bytes are required");
  const validated = validateCurrentFiveRegionSourceFanIn(fanIn, fanInBytes);
  const reconstructed = buildCurrentFiveRegionSourceFanIn({
    targets,
    tally,
    ownership,
    inventory,
    sourceSnapshots,
    inputBytes: Object.fromEntries(["targets", "tally", "ownership", "inventory", "sourceSnapshots"].map((name) => [name, inputBytes[name]])),
    evaluatedAt: validated.evaluatedAt,
    // 커밋된 fan-in은 CLI가 거버넌스 정책을 확인해 만든 바이트다. 여기서는 그 바이트를 다시 만들 뿐 새 이월을 인정하지 않는다.
    governance: REPRODUCTION_GOVERNANCE,
  });
  if (canonicalCurrentFiveRegionSourceFanInJson(reconstructed)
    !== canonicalCurrentFiveRegionSourceFanInJson(validated)) throw new Error("fan-in reconstruction mismatch");
  return { fanIn: validated, fanInBytes: Buffer.isBuffer(fanInBytes) ? fanInBytes : Buffer.from(fanInBytes), heads: selectedHeads(validated) };
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
  const runtime = sources.map(firstRuntimeEvidence).filter(Boolean);
  return {
    licenseLineage: sources.length > 0 && licenses.length === sources.length ? evidenced(licenses) : pending(pendingReason, childOwner),
    freshnessLineage: freshEnough ? evidenced(fresh) : pending(pendingReason, childOwner),
    admissionLineage: sources.length > 0 && sources.every((source) => {
      const head = heads.get(source.id);
      const nativeRecord = nativeAdmissionRecordForHead({ source, head });
      return source.productionUseAllowed === true
        && (admittedEvidence(source).some(({ decision }) => decision === "APPROVED")
          || (nativeRecord !== null
            && JSON.stringify(head?.admissionRecordSha256s) === JSON.stringify([nativeRecord])));
    })
      ? evidenced(sources.map(({ id, productionUseAllowed }) => ({ sourceId: id, productionUseAllowed, admissions: admittedEvidence(sources.find((source) => source.id === id)) })))
      : pending("PRODUCTION_ADMISSION_REQUIRED", childOwner),
    artifactLineage: allCentral
      ? evidenced(centralHeads.map(({ sourceId, snapshotId, rawSha256, rawObjectUri }) => ({ sourceId, snapshotId, rawSha256, rawObjectUri })).sort((left, right) => compare(left.sourceId, right.sourceId)))
      : pending(pendingReason, childOwner),
    runtimeLineage: sources.length > 0 && runtime.length === sources.length ? evidenced(runtime) : pending("RUNTIME_LINEAGE_REQUIRED", childOwner),
  };
}

export function buildNationwideRequirementOwnershipLedger(inputs) {
  const { targets, tally, inventory, ownership, inputBytes = {} } = inputs;
  if (targets.targetVersion !== tally.targetVersion || targets.targetVersion !== ownership.targetVersion) throw new Error("targetVersion drift");
  const normalizedOwnerRules = normalizeNationwideOwnershipRules(ownership.ownerRules);
  const current = currentFanIn(inputs);
  const targetPks = new Set(targets.activeLineScopes.flatMap((scope) => targets.requiredSourceDomains
    .map((domain) => `${scope.regionId}:${scope.operatorId}:${scope.lineId}:${domain.id}`)));
  const seen = new Set();
  const rows = [...tally.launchRequired.requirements, ...tally.enhancement.requirements].map((tallyRow) => {
    const key = pk(tallyRow);
    if (!targetPks.has(key) || seen.has(key)) throw new Error(`tally PK drift ${key}`);
    seen.add(key);
    const childOwner = resolveNationwideRequirementOwner(normalizedOwnerRules, tallyRow);
    const admittedSourceIds = [...(tallyRow.admittedSourceIds ?? [])].sort(compare);
    const admittedSources = [];
    // 일부 필드의 출처도 검증하되, 요구사항 전체의 MISSING 판정은 유지한다.
    const partialAdmission = tallyRow.status === "MISSING" && admittedSourceIds.length > 0
      && tallyRow.admittedFieldCount > 0 && tallyRow.admittedFieldCount < tallyRow.requiredFieldCount;
    if (tallyRow.status === "INVENTORY_ADMITTED" || partialAdmission) {
      if (admittedSourceIds.length === 0) throw new Error(`admitted source missing for ${key}`);
      const providedFields = new Set();
      for (const sourceId of admittedSourceIds) {
        const source = inventory.sources.find((candidate) => candidate.id === sourceId);
        if (!source || !strictSourceCovers(source, tallyRow)) throw new Error(`admitted source mismatch for ${key}: ${sourceId}`);
        admittedSources.push(source);
        inventoryCoverageFields(source).forEach((field) => providedFields.add(field));
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
      lineage: lineageFor(admittedSources, current.heads, current.fanIn.evaluatedAt, childOwner, tallyRow.status),
    };
  }).sort((left, right) => compare(left.pk, right.pk));
  if (seen.size !== targetPks.size) throw new Error("ownership PK set drift");
  const launchRows = rows.filter(({ releaseTier }) => releaseTier === "LAUNCH_REQUIRED");
  const count = (status) => launchRows.filter((row) => row.disposition.status === status).length;
  const terminalLaunchRow = (row) => row.disposition.status === "INVENTORY_ADMITTED"
    || row.disposition.status === "EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE";
  const completeAdmittedLineage = (row) => row.disposition.status !== "INVENTORY_ADMITTED"
    || AXES.every((axis) => row.lineage[axis].state === "EVIDENCED");
  const nationwideEligibility = launchRows.every((row) => terminalLaunchRow(row) && completeAdmittedLineage(row))
    ? "GO" : "NO_GO";
  return {
    schemaVersion: 1, artifactKind: "nationwide-requirement-ownership-ledger", issue: 449,
    targetVersion: current.fanIn.scope.targetVersion,
    provenance: {
      regeneration: { command: "node tools/datapack/build-nationwide-requirement-ownership-ledger.mjs", outputPath: LEDGER_PATH },
      inputs: {
        ...Object.fromEntries(Object.entries(INPUT_PATHS).filter(([name]) => name !== "fanIn").map(([name, inputPath]) => [name, {
          path: inputPath, sha256: hash(inputBytes[name]),
        }])),
        fanIn: {
          path: INPUT_PATHS.fanIn,
          sha256: hash(current.fanInBytes),
          fanInSha256: current.fanIn.fanInSha256,
          scopeSha256: current.fanIn.scopeSha256,
          sourceSetSha256: current.fanIn.sourceSetSha256,
          regionalMatrixSha256: current.fanIn.regionalMatrixSha256,
        },
      },
    },
    summary: {
      launchRequired: {
        totalCount: launchRows.length, inventoryAdmittedCount: count("INVENTORY_ADMITTED"),
        explicitlyUnsupportedWithEvidenceCount: count("EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE"),
        missingCount: count("MISSING"), terminalCount: count("INVENTORY_ADMITTED") + count("EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE"),
      },
      enhancement: { totalCount: rows.length - launchRows.length, blocking: false },
      duplicatePkCount: 0, unownedPkCount: 0, nationwideEligibility,
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
if (process.argv[1] === new URL(import.meta.url).pathname) await main();
