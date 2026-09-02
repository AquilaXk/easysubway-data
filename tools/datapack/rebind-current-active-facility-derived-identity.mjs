#!/usr/bin/env node
// Rebinds the already-active FACILITY admission to the current candidate only.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildCurrentCapitalFacilityCollectionPlan, canonicalCurrentCapitalFacilityCollectionPlanJson } from "./build-current-capital-facility-collection-plan.mjs";
import { buildCurrentCapitalFacilitySourceAdmission, canonicalCurrentCapitalFacilitySourceAdmissionJson } from "./build-current-capital-facility-source-admission.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import {
  buildCurrentCapitalAccessibilityTransition,
  buildCurrentCapitalAccessibilityTransitionSuccessor,
  canonicalCurrentCapitalAccessibilityTransitionSuccessorJson,
} from "./current-capital-accessibility-transition.mjs";
import { verifyCurrentCapitalPublicRouteMapDocument } from "./materialize-seoul-route-map-positions.mjs";
import { validateLineage } from "./source-snapshot-policy.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUTPUT = "tools/datapack/release/current-capital-facility-source-admission.json";
const TRANSITION = "tools/datapack/release/current-capital-accessibility-transition.json";
const SUCCESSOR = "tools/datapack/release/current-capital-accessibility-transition-successor.json";
const SOURCE = "kric-station-convenience-standard";
const POSITION = "seoul-metro-route-map-positions";
const JOURNAL = "tools/datapack/.active-facility-derived-identity-rebind.json";
const LOCK = "tools/datapack/.active-facility-derived-identity-rebind.lock";
const PROTECTED_SEMANTIC_FIELDS = [
  "sourceIdentity", "stationLineProviderMappingSha256", "denominatorRows",
  "denominatorStateSummary", "cells", "cellStateSummary",
  "materializerEvidenceRows", "decision",
];
const sha = (v) => createHash("sha256").update(v).digest("hex");

function rootOf(value) { if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("repository root must be absolute"); return path.resolve(value); }
async function stable(file, label) { const h = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); try { const a = await h.stat(); if (!a.isFile()) throw new Error(`${label} must be a regular file`); const bytes = await h.readFile(); const b = await h.stat(); if (a.dev !== b.dev || a.ino !== b.ino || a.size !== b.size || a.mtimeMs !== b.mtimeMs) throw new Error(`${label} changed during read`); return bytes; } finally { await h.close(); } }
async function json(root, relative) { const bytes = await stable(path.join(root, relative), relative); return { bytes, value: JSON.parse(bytes) }; }
function exactlyOne(rows, predicate, label) { const matches = rows.filter(predicate); if (matches.length !== 1) throw new Error(`${label} must be exactly one`); return matches[0]; }
export function validateCurrentPublicRouteMapReplacementProof(candidate, inventory, snapshots, canonical) {
  const position = exactlyOne(candidate.sourceSnapshots ?? [], ({ sourceId }) => sourceId === POSITION, "current public route-map candidate member");
  const row = exactlyOne(snapshots, ({ snapshotId }) => snapshotId === position.snapshotId, "current public route-map snapshot");
  const source = exactlyOne(inventory.sources ?? [], ({ id }) => id === POSITION, "current public route-map inventory");
  const admission = source?.routeMapAdmissionEvidence?.currentLayoutAdmission;
  const lineage = validateLineage(snapshots);
  const chain = lineage.chainsBySource[POSITION] ?? [];
  const selectedIndex = chain.indexOf(row.snapshotId);
  const snapshotsById = new Map(snapshots.map((snapshot) => [snapshot.snapshotId, snapshot]));
  const replacementMarkers = chain.slice(0, selectedIndex).map((snapshotId) => snapshotsById.get(snapshotId)).filter((snapshot) =>
    snapshot?.projectionMigration?.migrationKind === "CROSS_SOURCE_CANONICAL_REPLACEMENT"
      && snapshot.projectionMigration.sourceId === POSITION
      && snapshot.projectionMigration.replacedSourceId === "seoulmetro-cyberstation-route-map",
  );
  if (row.sourceId !== POSITION || lineage.headsBySource[POSITION] !== row.snapshotId
    || selectedIndex < 1 || replacementMarkers.length !== 1
    || admission?.status !== "ADMITTED" || admission.positionSnapshotId !== row.snapshotId
    || admission.snapshotPath !== `tools/datapack/sources/${row.snapshotId}.json`
    || admission.rawSha256 !== row.rawSha256 || admission.contentSha256 !== row.contentSha256
    || admission.layoutArtifactSha256 !== row.routeMapLayoutEvidence?.layoutArtifactSha256) throw new Error("current public route-map replacement proof mismatch");
  verifyCurrentCapitalPublicRouteMapDocument(canonical, row, "current facility canonical pack");
}
export function activeFacilitySnapshotObservedAt(snapshotBytes) {
  let snapshot;
  try { snapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(snapshotBytes)); } catch { throw new Error("active FACILITY snapshot JSON invalid"); }
  const capturedAt = Date.parse(snapshot?.capturedAt ?? "");
  const observedAt = Date.parse(snapshot?.observedAt ?? "");
  if (!Number.isFinite(capturedAt) || !Number.isFinite(observedAt) || capturedAt > observedAt) throw new Error("active FACILITY snapshot time proof mismatch");
  return new Date(observedAt).toISOString();
}

export function validateFacilityDerivedIdentityRebind(previous, next, previousBytes, nextBytes) {
  if (!(previousBytes instanceof Uint8Array) || !(nextBytes instanceof Uint8Array)) throw new Error("FACILITY rebind bytes missing");
  if (Buffer.from(previousBytes).equals(Buffer.from(nextBytes))) return;
  const candidateIdChanged = previous.candidate?.candidateId !== next.candidate?.candidateId;
  const sourceSetChanged = previous.candidate?.sourceSnapshotSetHash !== next.candidate?.sourceSnapshotSetHash;
  const observedAtChanged = previous.observedAt !== next.observedAt;
  const digestChanged = previous.admissionDigest !== next.admissionDigest;
  if (!candidateIdChanged && !sourceSetChanged && !observedAtChanged) throw new Error("FACILITY same-state derived identity drift");
  if (!digestChanged) throw new Error("FACILITY derived identity rebind mismatch");
}

export function validateFacilityProtectedSemanticIdentity(previous, next) {
  for (const key of PROTECTED_SEMANTIC_FIELDS) {
    if (canonicalJson(previous[key]) !== canonicalJson(next[key])) {
      throw new Error("FACILITY semantic identity changed during rebind");
    }
  }
}

export async function buildCurrentActiveFacilityDerivedIdentityOutput({ repositoryRoot = ROOT } = {}) {
  const root = rootOf(repositoryRoot);
  const files = await Promise.all([
    "tools/datapack/release/capital-production-canonical-pack.json", "tools/datapack/nationwide-coverage-targets.json", "tools/datapack/sources/kric-provider-code-catalog-20260228.json", "tools/datapack/sources/kric-nationwide-route-rosters-20260730T203926676Z.json", "tools/datapack/source-inventory.json", "tools/datapack/release/candidate-build-spec.json", "tools/datapack/release/source-snapshots.json", "tools/datapack/source-governance-policy.json", "release/product-gates/datapack-freshness-sla.json", OUTPUT,
  ].map((relative) => json(root, relative)));
  const [pack, coverage, catalog, rosters, inventory, candidate, snapshots, governance, freshness, previous] = files;
  validateCurrentPublicRouteMapReplacementProof(candidate.value, inventory.value, snapshots.value, pack.value);
  const active = inventory.value.sources.find(({ id }) => id === SOURCE)?.accessibilityAdmissionEvidence;
  if (!active?.snapshotPath || active.snapshotId !== candidate.value.sourceSnapshots.find(({ sourceId }) => sourceId === SOURCE)?.snapshotId) throw new Error("active FACILITY snapshot proof mismatch");
  const snapshotBytes = await stable(path.join(root, active.snapshotPath), "active FACILITY snapshot");
  const plan = buildCurrentCapitalFacilityCollectionPlan({ canonicalPackBytes: pack.bytes, coverageTargetsBytes: coverage.bytes, providerCodeCatalogBytes: catalog.bytes, routeRostersBytes: rosters.bytes, sourceInventoryBytes: inventory.bytes });
  const next = buildCurrentCapitalFacilitySourceAdmission({ observedAt: activeFacilitySnapshotObservedAt(snapshotBytes), candidateEvaluationAt: candidate.value.publishedAt, planBytes: Buffer.from(canonicalCurrentCapitalFacilityCollectionPlanJson(plan)), canonicalPackBytes: pack.bytes, snapshotBytes, candidateBuildSpec: candidate.value, sourceInventoryBytes: inventory.bytes, sourceSnapshots: snapshots.value, governancePolicy: governance.value, governancePolicyBytes: governance.bytes, freshnessPolicy: freshness.value });
  const bytes = Buffer.from(canonicalCurrentCapitalFacilitySourceAdmissionJson(next));
  const old = previous.value;
  if (canonicalCurrentCapitalFacilitySourceAdmissionJson(old) !== previous.bytes.toString("utf8")) throw new Error("active FACILITY admission bytes are not canonical");
  validateFacilityProtectedSemanticIdentity(old, next);
  validateFacilityDerivedIdentityRebind(old, next, previous.bytes, bytes);
  return { relative: OUTPUT, bytes, prestate: previous.bytes };
}
export async function buildCurrentActiveFacilityDerivedIdentitySuccessorTransaction({ repositoryRoot = ROOT, replaceExistingSuccessor = false } = {}) {
  const root = rootOf(repositoryRoot);
  const facility = await buildCurrentActiveFacilityDerivedIdentityOutput({ repositoryRoot: root });
  if (!facilityDerivedIdentityRebindState(facility)) return { facility, successor: null, base: null };
  const [baseBytes, candidate, previous, ledger, inventory] = await Promise.all([
    stable(path.join(root, TRANSITION), "current accessibility transition"),
    json(root, "tools/datapack/release/candidate-build-spec.json"),
    json(root, "tools/datapack/release/current-station-line-accessibility/station-line-input.json"),
    json(root, "tools/datapack/release/source-snapshots.json"),
    json(root, "tools/datapack/source-inventory.json"),
  ]);
  let successorPrestate = null;
  let previousFacilityBytes = facility.prestate;
  try {
    successorPrestate = await stable(path.join(root, SUCCESSOR), "current accessibility transition successor");
    if (!replaceExistingSuccessor) throw new Error("current accessibility transition successor already exists");
    const existing = JSON.parse(successorPrestate);
    if (canonicalCurrentCapitalAccessibilityTransitionSuccessorJson(existing) !== successorPrestate.toString("utf8")) {
      throw new Error("existing successor transition bytes are not canonical");
    }
    previousFacilityBytes = Buffer.from(existing.previousFacilityAdmissionBase64, "base64");
    const existingTransition = {
      schemaVersion: existing.schemaVersion,
      artifactKind: "current-capital-accessibility-transition",
      state: existing.state,
      nextCandidate: existing.nextCandidate,
      previousCandidate: existing.previousCandidate,
      previousProduction: existing.previousProduction,
      facilityAdmission: existing.facilityAdmission,
      pendingPrerequisites: existing.pendingPrerequisites,
      transitionSha256: existing.transitionSha256,
    };
    const expected = buildCurrentCapitalAccessibilityTransitionSuccessor({
      baseTransitionBytes: baseBytes,
      previousFacilityBytes,
      currentTransition: existingTransition,
    });
    if (canonicalJson(existing) !== canonicalJson(expected)) {
      throw new Error("existing successor transition binding mismatch");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    if (replaceExistingSuccessor) throw new Error("terminal successor transition prestate is missing");
  }
  const currentTransition = buildCurrentCapitalAccessibilityTransition({
    candidate: candidate.value, candidateBytes: candidate.bytes,
    previous: previous.value, previousBytes: previous.bytes,
    facilityAdmission: JSON.parse(facility.bytes), facilityBytes: facility.bytes,
    ledger: ledger.value, ledgerBytes: ledger.bytes,
    inventory: inventory.value, inventoryBytes: inventory.bytes,
  });
  const successorValue = buildCurrentCapitalAccessibilityTransitionSuccessor({
    baseTransitionBytes: baseBytes,
    previousFacilityBytes,
    currentFacilityBytes: facility.bytes,
    currentLedger: ledger.value,
    currentTransition,
  });
  return {
    facility,
    base: { relative: TRANSITION, bytes: baseBytes },
    successor: { relative: SUCCESSOR, bytes: Buffer.from(canonicalCurrentCapitalAccessibilityTransitionSuccessorJson(successorValue)), prestate: successorPrestate },
  };
}
async function replace(root, output) { const file = path.join(root, output.relative); const actual = await stable(file, "FACILITY admission"); if (!actual.equals(output.prestate)) throw new Error("FACILITY rebind input drift"); const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`); try { const h = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); try { await h.writeFile(output.bytes); await h.sync(); } finally { await h.close(); } if (!(await stable(file, "FACILITY admission")).equals(output.prestate)) throw new Error("FACILITY rebind input drift"); await rename(temp, file); } finally { await unlink(temp).catch(() => {}); } }
async function createOnce(root, output) {
  const file = path.join(root, output.relative); const parent = path.dirname(file);
  const parentInfo = await lstat(parent); if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error("successor transition parent mismatch");
  try { await lstat(file); throw new Error("current accessibility transition successor already exists"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const temp = path.join(parent, `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(output.bytes); await handle.sync(); } finally { await handle.close(); }
    try { await lstat(file); throw new Error("current accessibility transition successor already exists"); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    await link(temp, file);
  } finally { await unlink(temp).catch(() => {}); }
}
export function facilityDerivedIdentityRebindState(output, { check = false } = {}) {
  if (!Buffer.isBuffer(output?.bytes) || !Buffer.isBuffer(output?.prestate)) throw new Error("FACILITY rebind output bytes missing");
  if (output.bytes.equals(output.prestate)) return false;
  if (check) throw new Error("active FACILITY derived identity drift");
  return true;
}
export async function rebindCurrentActiveFacilityDerivedIdentity({ repositoryRoot = ROOT, check = false, replaceExistingSuccessor = false, failAfter = async () => {} } = {}) {
  const root = rootOf(repositoryRoot); const transaction = await buildCurrentActiveFacilityDerivedIdentitySuccessorTransaction({ repositoryRoot: root, replaceExistingSuccessor });
  if (!facilityDerivedIdentityRebindState(transaction.facility, { check })) return { changed: false };
  const lock = path.join(root, LOCK); await mkdir(lock, { mode: 0o700 }); const journal = path.join(root, JOURNAL);
  let preserveJournal = false;
  const records = [
    { operation: "replace", relative: transaction.facility.relative, before: transaction.facility.prestate.toString("base64"), after: transaction.facility.bytes.toString("base64") },
    transaction.successor.prestate == null
      ? { operation: "create", relative: transaction.successor.relative, after: transaction.successor.bytes.toString("base64") }
      : { operation: "replace", relative: transaction.successor.relative, before: transaction.successor.prestate.toString("base64"), after: transaction.successor.bytes.toString("base64") },
  ];
  try {
    await writeFile(journal, JSON.stringify({ schemaVersion: 2, state: "PREPARED", records }), { flag: "wx", mode: 0o600 });
    preserveJournal = true;
    try {
      if (!(await stable(path.join(root, TRANSITION), "current accessibility transition")).equals(transaction.base.bytes)) throw new Error("successor transition input drift");
      await replace(root, transaction.facility); await failAfter({ stage: "facility" });
      if (transaction.successor.prestate == null) await createOnce(root, transaction.successor);
      else await replace(root, transaction.successor);
      await failAfter({ stage: "successor" });
      if (!(await stable(path.join(root, transaction.facility.relative), "FACILITY admission")).equals(transaction.facility.bytes)
        || !(await stable(path.join(root, transaction.successor.relative), "current accessibility transition successor")).equals(transaction.successor.bytes)) throw new Error("FACILITY successor transaction verification failed");
    } catch (error) {
      try {
        const successor = await stable(path.join(root, transaction.successor.relative), "FACILITY successor rollback").catch((missing) => missing?.code === "ENOENT" ? null : Promise.reject(missing));
        const successorMatchesPrestate = transaction.successor.prestate != null
          && successor?.equals(transaction.successor.prestate);
        if (successor && !successor.equals(transaction.successor.bytes) && !successorMatchesPrestate) throw new Error("FACILITY successor transaction preserves foreign successor");
        if (transaction.successor.prestate == null) {
          if (successor) await unlink(path.join(root, transaction.successor.relative));
        } else if (successor?.equals(transaction.successor.bytes)) {
          await replace(root, { ...transaction.successor, bytes: transaction.successor.prestate, prestate: transaction.successor.bytes });
        }
        const current = await stable(path.join(root, transaction.facility.relative), "FACILITY rollback");
        if (current.equals(transaction.facility.bytes)) await replace(root, { ...transaction.facility, bytes: transaction.facility.prestate, prestate: transaction.facility.bytes });
        if (!(await stable(path.join(root, transaction.facility.relative), "FACILITY rollback verification")).equals(transaction.facility.prestate)
          || (transaction.successor.prestate != null
            && !(await stable(path.join(root, transaction.successor.relative), "successor rollback verification")).equals(transaction.successor.prestate))) {
          throw new Error("FACILITY successor transaction rollback failed");
        }
        await unlink(journal); preserveJournal = false;
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "FACILITY successor transaction rollback failed");
      }
      throw error;
    }
    await unlink(journal); preserveJournal = false;
    return { changed: true, admissionDigest: sha(transaction.facility.bytes), successorSha256: sha(transaction.successor.bytes) };
  } finally {
    if (!preserveJournal) await unlink(journal).catch(() => {});
    await rmdir(lock).catch(() => {});
  }
}
function parseArgs(argv) { const root = argv[argv.indexOf("--repository-root") + 1]; if (!root) throw new Error("--repository-root is required"); return { repositoryRoot: root, check: argv.includes("--check") }; }
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) rebindCurrentActiveFacilityDerivedIdentity(parseArgs(process.argv.slice(2))).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
