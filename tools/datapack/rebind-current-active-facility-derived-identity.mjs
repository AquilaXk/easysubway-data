#!/usr/bin/env node
// Rebinds the already-active FACILITY admission to the current candidate only.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildCurrentCapitalFacilityCollectionPlan, canonicalCurrentCapitalFacilityCollectionPlanJson } from "./build-current-capital-facility-collection-plan.mjs";
import { buildCurrentCapitalFacilitySourceAdmission, canonicalCurrentCapitalFacilitySourceAdmissionJson } from "./build-current-capital-facility-source-admission.mjs";
import { verifyCurrentCapitalPublicRouteMapDocument } from "./materialize-seoul-route-map-positions.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUTPUT = "tools/datapack/release/current-capital-facility-source-admission.json";
const SOURCE = "kric-station-convenience-standard";
const POSITION = "seoul-metro-route-map-positions";
const JOURNAL = "tools/datapack/.active-facility-derived-identity-rebind.json";
const LOCK = "tools/datapack/.active-facility-derived-identity-rebind.lock";
const sha = (v) => createHash("sha256").update(v).digest("hex");

function rootOf(value) { if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("repository root must be absolute"); return path.resolve(value); }
async function stable(file, label) { const h = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); try { const a = await h.stat(); if (!a.isFile()) throw new Error(`${label} must be a regular file`); const bytes = await h.readFile(); const b = await h.stat(); if (a.dev !== b.dev || a.ino !== b.ino || a.size !== b.size || a.mtimeMs !== b.mtimeMs) throw new Error(`${label} changed during read`); return bytes; } finally { await h.close(); } }
async function json(root, relative) { const bytes = await stable(path.join(root, relative), relative); return { bytes, value: JSON.parse(bytes) }; }
function currentProof(candidate, inventory, snapshots, canonical) {
  const position = candidate.sourceSnapshots?.find(({ sourceId }) => sourceId === POSITION);
  const row = snapshots.find(({ snapshotId }) => snapshotId === position?.snapshotId);
  const source = inventory.sources?.find(({ id }) => id === POSITION);
  const admission = source?.routeMapAdmissionEvidence?.currentLayoutAdmission;
  if (!position || !row || row.previousSnapshotId !== null || row.projectionMigration?.migrationKind !== "CROSS_SOURCE_CANONICAL_REPLACEMENT" || row.projectionMigration.sourceId !== POSITION || row.projectionMigration.replacedSourceId !== "seoulmetro-cyberstation-route-map" || admission?.status !== "ADMITTED" || admission.positionSnapshotId !== row.snapshotId || admission.rawSha256 !== row.rawSha256 || admission.contentSha256 !== row.contentSha256 || admission.layoutArtifactSha256 !== row.routeMapLayoutEvidence?.layoutArtifactSha256) throw new Error("current public route-map replacement proof mismatch");
  verifyCurrentCapitalPublicRouteMapDocument(canonical, row, "current facility canonical pack");
}
function observedAt(candidate, snapshots) { const ids = new Set(candidate.sourceSnapshotIds); const instants = snapshots.filter(({ snapshotId }) => ids.has(snapshotId)).flatMap((row) => [row.retrievedAt, row.sourceUpdatedAt, row.rawReceipt?.storedAt]).filter(Boolean).map(Date.parse); const value = Math.max(...instants); if (!Number.isFinite(value)) throw new Error("current candidate proof clock missing"); return new Date(value).toISOString(); }

export async function buildCurrentActiveFacilityDerivedIdentityOutput({ repositoryRoot = ROOT } = {}) {
  const root = rootOf(repositoryRoot);
  const files = await Promise.all([
    "tools/datapack/release/capital-production-canonical-pack.json", "tools/datapack/nationwide-coverage-targets.json", "tools/datapack/sources/kric-provider-code-catalog-20260228.json", "tools/datapack/sources/kric-nationwide-route-rosters-20260730T203926676Z.json", "tools/datapack/source-inventory.json", "tools/datapack/release/candidate-build-spec.json", "tools/datapack/release/source-snapshots.json", "tools/datapack/source-governance-policy.json", "release/product-gates/datapack-freshness-sla.json", OUTPUT,
  ].map((relative) => json(root, relative)));
  const [pack, coverage, catalog, rosters, inventory, candidate, snapshots, governance, freshness, previous] = files;
  currentProof(candidate.value, inventory.value, snapshots.value, pack.value);
  const active = inventory.value.sources.find(({ id }) => id === SOURCE)?.accessibilityAdmissionEvidence;
  if (!active?.snapshotPath || active.snapshotId !== candidate.value.sourceSnapshots.find(({ sourceId }) => sourceId === SOURCE)?.snapshotId) throw new Error("active FACILITY snapshot proof mismatch");
  const snapshotBytes = await stable(path.join(root, active.snapshotPath), "active FACILITY snapshot");
  const plan = buildCurrentCapitalFacilityCollectionPlan({ canonicalPackBytes: pack.bytes, coverageTargetsBytes: coverage.bytes, providerCodeCatalogBytes: catalog.bytes, routeRostersBytes: rosters.bytes, sourceInventoryBytes: inventory.bytes });
  const next = buildCurrentCapitalFacilitySourceAdmission({ observedAt: observedAt(candidate.value, snapshots.value), planBytes: Buffer.from(canonicalCurrentCapitalFacilityCollectionPlanJson(plan)), canonicalPackBytes: pack.bytes, snapshotBytes, candidateBuildSpec: candidate.value, sourceInventoryBytes: inventory.bytes, sourceSnapshots: snapshots.value, governancePolicy: governance.value, governancePolicyBytes: governance.bytes, freshnessPolicy: freshness.value });
  const bytes = Buffer.from(canonicalCurrentCapitalFacilitySourceAdmissionJson(next));
  const old = previous.value;
  for (const key of ["sourceIdentity", "stationLineProviderMappingSha256", "denominatorRows", "denominatorStateSummary", "cells", "cellStateSummary", "materializerEvidenceRows", "decision"]) if (JSON.stringify(old[key]) !== JSON.stringify(next[key])) throw new Error("FACILITY semantic identity changed during rebind");
  if (old.candidate?.candidateId !== next.candidate.candidateId || old.candidate?.sourceSnapshotSetHash === next.candidate.sourceSnapshotSetHash || old.admissionDigest === next.admissionDigest) throw new Error("FACILITY derived identity rebind mismatch");
  return { relative: OUTPUT, bytes, prestate: previous.bytes };
}
async function replace(root, output) { const file = path.join(root, output.relative); const actual = await stable(file, "FACILITY admission"); if (!actual.equals(output.prestate)) throw new Error("FACILITY rebind input drift"); const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`); try { const h = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); try { await h.writeFile(output.bytes); await h.sync(); } finally { await h.close(); } if (!(await stable(file, "FACILITY admission")).equals(output.prestate)) throw new Error("FACILITY rebind input drift"); await rename(temp, file); } finally { await unlink(temp).catch(() => {}); } }
export async function rebindCurrentActiveFacilityDerivedIdentity({ repositoryRoot = ROOT, check = false } = {}) { const root = rootOf(repositoryRoot); const output = await buildCurrentActiveFacilityDerivedIdentityOutput({ repositoryRoot: root }); if (check) { if (!output.bytes.equals(output.prestate)) throw new Error("active FACILITY derived identity drift"); return { changed: false }; } const lock = path.join(root, LOCK); await mkdir(lock, { mode: 0o700 }); const journal = path.join(root, JOURNAL); try { await writeFile(journal, JSON.stringify({ relative: output.relative, before: output.prestate.toString("base64"), after: output.bytes.toString("base64") }), { flag: "wx", mode: 0o600 }); try { await replace(root, output); } catch (error) { const now = await stable(path.join(root, output.relative), "FACILITY rollback"); if (now.equals(output.bytes)) await replace(root, { ...output, bytes: output.prestate, prestate: output.bytes }); throw error; } await unlink(journal); return { changed: true, admissionDigest: sha(output.bytes) }; } finally { await unlink(journal).catch(() => {}); await rmdir(lock).catch(() => {}); } }
function parseArgs(argv) { const root = argv[argv.indexOf("--repository-root") + 1]; if (!root) throw new Error("--repository-root is required"); return { repositoryRoot: root, check: argv.includes("--check") }; }
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) rebindCurrentActiveFacilityDerivedIdentity(parseArgs(process.argv.slice(2))).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
