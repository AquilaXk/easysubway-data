#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { buildCurrentCapitalLiveChainBundle, currentCapitalLiveChainOutputPaths } from "./build-current-capital-live-chain-bundle.mjs";
import {
  CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS,
  CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_PATH,
  buildCurrentCapitalLiveChainFanInBoundary,
  canonicalCurrentCapitalLiveChainFanInBoundaryJson,
  readCurrentCapitalLiveChainFanInBoundary,
} from "./build-current-capital-live-chain-boundary.mjs";
import { buildCurrentCapitalLiveChainProviderObject } from "./build-current-capital-live-chain-oci-plan.mjs";
import { buildCurrentKricExitProviderOciPlan, canonicalCurrentKricExitProviderOciPlanJson } from "./build-current-kric-exit-provider-oci-plan.mjs";
import {
  buildCurrentCapitalFacilitySourceAdmission,
  canonicalCurrentCapitalFacilitySourceAdmissionJson,
} from "./build-current-capital-facility-source-admission.mjs";
import { buildCurrentExitAdmissionOciReceipt, buildCurrentExitReboundAdmissionOciReceipt, canonicalCurrentExitAdmissionOciReceiptJson, canonicalCurrentExitReboundAdmissionOciReceiptJson } from "./build-current-exit-admission-oci-receipt.mjs";
import { buildCurrentKricExitCollectionBundle, buildCurrentKricExitCollectionReceipt, canonicalCurrentKricExitCollectionBundleJson } from "./build-current-kric-exit-collection-receipt.mjs";
import { readRegularSnapshot } from "./build-current-kric-exit-collection-plan.mjs";
import { canonicalKricExitPathProviderSnapshotJson } from "./collect-kric-exit-path-provider-snapshot.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import {
  validateCurrentCapitalAccessibilitySourceHandoff,
  verifyCurrentCapitalAccessibilitySourceHandoff,
} from "./current-capital-accessibility-source-handoff.mjs";
import { canonicalKricExitPathCollectionPlanJson } from "./plan-kric-exit-path-collection.mjs";
import { main as buildCurrentCapitalRouteEdgeInput } from "./build-current-capital-route-edge-input.mjs";
import { canonicalRouteEdgeEvaluationJson, evaluateRouteAccessibilityEdges } from "./evaluate-route-accessibility-edges.mjs";
import {
  buildCurrentCapitalExitProviderSourceHandoffFromProviderOci,
  canonicalCurrentCapitalExitProviderCandidateHandoffJson,
  CURRENT_CAPITAL_EXIT_PROVIDER_CANDIDATE_RECEIPT,
  CURRENT_CAPITAL_EXIT_PROVIDER_REBOUND_BUNDLE,
  canonicalCurrentCapitalExitProviderSourceHandoffJson,
  CURRENT_CAPITAL_EXIT_PROVIDER_OCI_PLAN,
  CURRENT_CAPITAL_EXIT_PROVIDER_OCI_RECEIPT,
  CURRENT_CAPITAL_EXIT_PROVIDER_SOURCE_RECEIPT,
} from "./current-capital-exit-provider-handoff.mjs";
import { materializeStationLineAccessibility } from "./materialize-station-line-accessibility.mjs";
import { publishCurrentKricExitProviderOciPlan, requireCurrentCapitalLiveChainOciParBaseUrl } from "./publish-object-storage.mjs";
import { preauthenticatedObjectStorageClient } from "./publish-object-storage.mjs";
import { recoverCurrentCapitalExitProviderCandidate } from "./current-capital-exit-provider-handoff.mjs";
import { rebindCandidateSourceSnapshots, rebindCurrentCandidateSourceSnapshots } from "./rebind-current-candidate-source-snapshots.mjs";
import { validateLineage } from "./source-snapshot-policy.mjs";
import {
  buildCurrentCapitalAccessibilityRefreshOutputs,
  commitCurrentCapitalTerminalManifest,
  refreshCurrentCapitalAccessibilityFull,
} from "./refresh-current-capital-accessibility-full.mjs";
import { rebindCurrentActiveFacilityDerivedIdentity } from "./rebind-current-active-facility-derived-identity.mjs";
import {
  buildCurrentCapitalAccessibilityTransition,
  buildCurrentCapitalAccessibilityTransitionSuccessor,
  canonicalCurrentCapitalAccessibilityTransitionJson,
  canonicalCurrentCapitalAccessibilityTransitionSuccessorJson,
} from "./current-capital-accessibility-transition.mjs";
import { buildCurrentCapitalFacilityCollectionPlan } from "./build-current-capital-facility-collection-plan.mjs";
import { canonicalCurrentCapitalFacilityCollectionPlanJson } from "./build-current-capital-facility-collection-plan.mjs";
import { registerKricStandardAccessibilitySnapshot } from "./register-kric-standard-accessibility-snapshot.mjs";
import {
  buildCurrentCapitalTopologyRefreshOutputs,
  validateCurrentTopologyRefreshItxEvidence,
} from "./activate-current-source-set.mjs";
import { rebindCurrentActivePublicRouteMapMaterialization } from "./rebind-current-active-public-route-map-materialization.mjs";
import { currentLiveChainTransferStageInputs, rebindCurrentLiveChainTransferDerivedIdentities } from "./rebind-current-live-chain-transfer-derived-identities.mjs";
import { assertCurrentStaticNetworkTopologyAdmission } from "./register-current-static-network-successors.mjs";
import { validateCurrentCapitalLiveChainMaterialization } from "./validate-current-capital-live-chain-materialization.mjs";
import { codepointCompare } from "../lib/codepoint-compare.mjs";

const execFile = promisify(execFileCallback);
const DATA_MAIN_REMOTE = "https://github.com/AquilaXk/easysubway-data.git";
const STAGED_INPUTS = Object.freeze([
  "tools/datapack/release", "tools/datapack/sources", "tools/datapack/inputs", "tools/datapack/source-inventory.json", "tools/datapack/source-governance-policy.json", "tools/datapack/source-candidates.json", "tools/datapack/official-od-fare-admission.json", "tools/datapack/nationwide-coverage-targets.json", "release/product-gates/datapack-freshness-sla.json", "release/product-gates/route-edge-evaluation-policy.json",
]);
const EXCLUDED_STAGED_PATHS = Object.freeze([
  "tools/datapack/release/current-station-line-accessibility",
  "tools/datapack/release/current-route-edge-evaluation",
  "tools/datapack/release/current-capital-accessibility-full",
  "tools/datapack/release/current-capital-accessibility-transition.json",
  CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_PATH,
]);
const CURRENT_KRIC_EXIT_PLAN_INPUTS_PATH = "tools/datapack/release/current-kric-exit-plan-inputs.json";
const RETAINED_EXIT_PLAN_MISMATCH = "retained EXIT bundle plan is not provider-equivalent to the current plan";
export const CURRENT_KRIC_EXIT_REQUEST_TIMEOUT_MS = 30_000;
export const CURRENT_KRIC_EXIT_REQUEST_INTERVAL_MS = 250;

function requiredSha(value) { if (!/^[a-f0-9]{40}$/.test(value ?? "")) throw new Error("repository SHA mismatch"); return value; }
function requiredOperation(value) { if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{7,127}$/u.test(value)) throw new Error("operation identity mismatch"); return value; }
async function requireRealDirectory(directory, label) { const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`); }
async function requireAbsent(target, label) { try { await lstat(target); } catch (error) { if (error?.code === "ENOENT") return; throw error; } throw new Error(`${label} must be absent`); }
function narrowRunnerEnv(env) { return { PATH: env.PATH ?? "", RUNNER_TEMP: env.RUNNER_TEMP ?? "" }; }
function narrowOciEnv(env) { return { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: env.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL ?? "" }; }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function exactKeys(value, keys, label) {
  if (value == null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || !keys.every((key) => Object.hasOwn(value, key))) {
    throw new Error(`${label} keys mismatch`);
  }
}
function requiredRelativePath(value, label) {
  if (typeof value !== "string" || value === "" || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes("\\")
    || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${label} path mismatch`);
  }
  return value;
}
function requiredBindingSha(value, label) {
  if (!/^[a-f0-9]{64}$/u.test(value ?? "")) throw new Error(`${label} hash mismatch`);
  return value;
}
function requiredOffsetInstantMillis(value, label) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?(Z|[+-]\d{2}:\d{2})$/u.exec(value ?? "");
  const parts = match?.slice(1, 8).map((part) => Number(part ?? 0));
  const offset = match?.[8];
  const offsetParts = offset && offset !== "Z" ? offset.slice(1).split(":").map(Number) : [0, 0];
  const parsed = Date.parse(value);
  const local = parts == null ? null : new Date(Date.UTC(
    parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5], parts[6],
  ));
  if (match == null || !Number.isFinite(parsed) || offsetParts[0] > 23 || offsetParts[1] > 59
    || local.getUTCFullYear() !== parts[0] || local.getUTCMonth() + 1 !== parts[1]
    || local.getUTCDate() !== parts[2] || local.getUTCHours() !== parts[3]
    || local.getUTCMinutes() !== parts[4] || local.getUTCSeconds() !== parts[5]
    || local.getUTCMilliseconds() !== parts[6]) {
    throw new Error(`${label} mismatch`);
  }
  return parsed;
}
function parsedCanonical(bytes, canonicalizer, label) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new Error(`${label} bytes mismatch`);
  let value;
  try { value = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { throw new Error(`${label} JSON mismatch`); }
  if (!Buffer.from(bytes).equals(Buffer.from(canonicalizer(value)))) throw new Error(`${label} bytes are not canonical`);
  return value;
}
const RETAINED_LINEAGE_OUTPUTS = Object.freeze([
  "tools/datapack/release/candidate-build-spec.json",
  "tools/datapack/release/current-capital-facility-source-admission.json",
  "tools/datapack/release/hash-evidence.json",
  "tools/datapack/release/release-request.json",
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/source-inventory.json",
]);
const LINEAGE_TOPOLOGY_INPUTS = Object.freeze([
  "capitalTopologyPath", "incheonTopologyPath", "incheonLine1TimetablePath", "incheonLine2TimetablePath",
]);
const CURRENT_CAPITAL_TOPOLOGY_HANDOFF = "current-capital-topology-terminal-handoff.json";
const CURRENT_CAPITAL_TERMINAL_MARKERS = Object.freeze([
  "tools/datapack/release/current-capital-accessibility-transition.json",
  "tools/datapack/release/current-capital-accessibility-transition-successor.json",
]);

export async function assertCurrentCapitalExitItxAuthorityFresh({ repositoryRoot, now = new Date() } = {}) {
  if (!path.isAbsolute(repositoryRoot ?? "") || !(now instanceof Date) || Number.isNaN(now.valueOf())) {
    throw new Error("EXIT topology ITX preflight inputs mismatch");
  }
  const root = path.resolve(repositoryRoot);
  await requireRealDirectory(root, "EXIT topology ITX preflight root");
  const candidateFile = await readStagedRegularFile(
    root,
    "tools/datapack/release/candidate-build-spec.json",
    "EXIT topology ITX candidate",
  );
  let candidate;
  try { candidate = JSON.parse(candidateFile.bytes); } catch { throw new Error("EXIT topology ITX candidate JSON mismatch"); }
  const evidencePath = requiredRelativePath(candidate?.itxTopologyEvidencePath, "EXIT topology ITX evidence");
  if (!/^tools\/datapack\/itx-cheongchun-topology-evidence-[0-9]{17}\.json$/u.test(evidencePath)) {
    throw new Error("EXIT topology ITX evidence identity mismatch");
  }
  const evidenceFile = await readStagedRegularFile(root, evidencePath, "EXIT topology ITX evidence");
  if (sha256(evidenceFile.bytes) !== requiredBindingSha(candidate.itxTopologyEvidenceSha256, "EXIT topology ITX evidence")) {
    throw new Error("EXIT topology ITX evidence hash mismatch");
  }
  let evidence;
  try { evidence = JSON.parse(evidenceFile.bytes); } catch { throw new Error("EXIT topology ITX evidence JSON mismatch"); }
  if (evidence?.artifactKind !== "itx-cheongchun-mobile-topology-evidence") {
    throw new Error("EXIT topology ITX evidence identity mismatch");
  }
  const binding = candidate.networkEdgeEvidence?.itxCurrentTopologyAdmission;
  if (binding == null) {
    validateCurrentTopologyRefreshItxEvidence({
      spec: candidate,
      itxCurrentAdmissionPath: null,
      selectedItxTopologyEvidencePath: evidencePath,
      currentItxTopologyEvidenceBytes: evidenceFile.bytes,
      buildNow: now.toISOString(),
    });
    return Object.freeze({ evidencePath, admissionPath: null });
  }
  exactKeys(binding, ["path", "sha256"], "EXIT topology ITX admission binding");
  const admissionPath = requiredRelativePath(binding.path, "EXIT topology ITX admission");
  if (!/^tools\/datapack\/itx-current-network-edge-admission-[0-9]{8}\.json$/u.test(admissionPath)) {
    throw new Error("EXIT topology ITX admission identity mismatch");
  }
  const admissionFile = await readStagedRegularFile(root, admissionPath, "EXIT topology ITX admission");
  if (sha256(admissionFile.bytes) !== requiredBindingSha(binding.sha256, "EXIT topology ITX admission")) {
    throw new Error("EXIT topology ITX admission hash mismatch");
  }
  let admission;
  try { admission = JSON.parse(admissionFile.bytes); } catch { throw new Error("EXIT topology ITX admission JSON mismatch"); }
  const freshUntil = requiredOffsetInstantMillis(admission?.freshUntil, "EXIT topology ITX admission freshUntil");
  if (admission?.artifactKind !== "itx-current-network-edge-admission"
    || admission.status !== "ADMITTED"
    || admissionPath !== `tools/datapack/${admission.artifactId}.json`
    || freshUntil <= now.valueOf()) {
    throw new Error("EXIT topology ITX admission is not current");
  }
  return Object.freeze({ evidencePath, admissionPath });
}
async function lineageFile(root, relative, label) {
  return readStagedRegularFile(root, relative, label);
}
async function optionalLineageFile(root, relative, label) {
  try { return await lineageFile(root, relative, label); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}
function exactLineageKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort(codepointCompare)) !== JSON.stringify(keys)) {
    throw new Error(`${label} mismatch`);
  }
}
function canonicalBytes(value, canonicalizer) { return Buffer.from(canonicalizer(value)); }
function sortedLineagePaths(paths, label) {
  if (!Array.isArray(paths) || new Set(paths).size !== paths.length
    || paths.some((relative) => requiredRelativePath(relative, label) !== relative)) {
    throw new Error(`${label} mismatch`);
  }
  return [...paths].sort(codepointCompare);
}
async function assertExactCleanGitRoot(root, expectedSha, label, execFileImpl) {
  await requireRealDirectory(root, `${label} root`);
  const [{ stdout: head }, { stdout: dirty }] = await Promise.all([
    execFileImpl("git", ["rev-parse", "HEAD"], { cwd: root }),
    execFileImpl("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root }),
  ]);
  if (head.trim() !== expectedSha || dirty !== "") throw new Error(`${label} exact clean Git identity mismatch`);
}

/**
 * Derive the only terminal lineage receipt from authenticated roots and the
 * generator itself.  No digest is accepted from a caller: a record is usable
 * only when the source transition/successor replay, retained producer output,
 * and private-builder topology bytes all reproduce exactly.
 */
export async function verifyCurrentCapitalTerminalLineage({
  sourceMainRoot,
  retainedRoot,
  privateBuilderRoot,
  sourceMainGitSha,
  facilityHeadGitSha,
  builderGitSha,
  topologyBuild,
  execFileImpl = execFile,
  buildTopologyOutputsImpl = buildCurrentCapitalTopologyRefreshOutputs,
  proofMode = "CURRENT_TERMINAL",
} = {}) {
  if (![sourceMainRoot, retainedRoot, privateBuilderRoot].every((value) => path.isAbsolute(value ?? ""))) {
    throw new Error("terminal lineage roots mismatch");
  }
  [sourceMainGitSha, facilityHeadGitSha, builderGitSha].forEach(requiredSha);
  if (typeof execFileImpl !== "function") throw new Error("terminal lineage git runner mismatch");
  if (typeof buildTopologyOutputsImpl !== "function") {
    throw new Error("terminal topology generator mismatch");
  }
  if (!["CURRENT_TERMINAL", "IMMUTABLE_PREDECESSOR"].includes(proofMode)) {
    throw new Error("terminal topology proof mode mismatch");
  }
  await Promise.all([
    assertExactCleanGitRoot(sourceMainRoot, sourceMainGitSha, "source-main", execFileImpl),
    assertExactCleanGitRoot(retainedRoot, facilityHeadGitSha, "retained", execFileImpl),
    assertExactCleanGitRoot(privateBuilderRoot, builderGitSha, "private builder", execFileImpl),
  ]);
  exactLineageKeys(topologyBuild, ["buildNow", "capitalTopologyPath", "incheonAccessibilityPath", "incheonLine1TimetablePath", "incheonLine2TimetablePath", "incheonTopologyPath", "itxCurrentAdmissionPath", "itxTopologyEvidencePath"], "terminal topology build");
  for (const key of LINEAGE_TOPOLOGY_INPUTS) requiredRelativePath(topologyBuild[key], `terminal topology ${key}`);
  const source = Object.fromEntries(await Promise.all([
    ["candidate", "tools/datapack/release/candidate-build-spec.json"],
    ["facility", "tools/datapack/release/current-capital-facility-source-admission.json"],
    ["transition", "tools/datapack/release/current-capital-accessibility-transition.json"],
    ["successor", "tools/datapack/release/current-capital-accessibility-transition-successor.json"],
    ["previous", "tools/datapack/release/current-station-line-accessibility/station-line-input.json"],
    ["ledger", "tools/datapack/release/source-snapshots.json"],
    ["inventory", "tools/datapack/source-inventory.json"],
  ].map(async ([key, relative]) => [key, await lineageFile(sourceMainRoot, relative, `source-main ${key}`)])));
  const transition = parsedCanonical(source.transition.bytes, canonicalCurrentCapitalAccessibilityTransitionJson, "source-main transition");
  const sourceFacility = parsedCanonical(source.facility.bytes, canonicalCurrentCapitalFacilitySourceAdmissionJson, "source-main FACILITY");
  const successor = parsedCanonical(source.successor.bytes, canonicalCurrentCapitalAccessibilityTransitionSuccessorJson, "source-main successor");
  const previousFacilityBytes = Buffer.from(successor.previousFacilityAdmissionBase64, "base64");
  const previousFacility = parsedCanonical(previousFacilityBytes, canonicalCurrentCapitalFacilitySourceAdmissionJson, "source-main predecessor FACILITY");
  if (successor.supersededTransition.sha256 !== sha256(source.transition.bytes)
    || successor.supersededTransition.transitionSha256 !== transition.transitionSha256
    || successor.previousFacilityAdmission.sha256 !== sha256(previousFacilityBytes)
    || successor.previousFacilityAdmission.admissionDigest !== previousFacility.admissionDigest
    || successor.previousFacilityAdmission.snapshotId !== previousFacility.sourceIdentity.snapshotId) {
    throw new Error("source-main protected marker lineage mismatch");
  }
  const currentTransition = buildCurrentCapitalAccessibilityTransition({
    candidate: JSON.parse(source.candidate.bytes), candidateBytes: source.candidate.bytes,
    previous: JSON.parse(source.previous.bytes), previousBytes: source.previous.bytes,
    facilityAdmission: sourceFacility, facilityBytes: source.facility.bytes,
    ledger: JSON.parse(source.ledger.bytes), ledgerBytes: source.ledger.bytes,
    inventory: JSON.parse(source.inventory.bytes), inventoryBytes: source.inventory.bytes,
  });
  const rebuiltSuccessor = buildCurrentCapitalAccessibilityTransitionSuccessor({
    baseTransitionBytes: source.transition.bytes, previousFacilityBytes, currentTransition,
  });
  if (!source.successor.bytes.equals(Buffer.from(canonicalCurrentCapitalAccessibilityTransitionSuccessorJson(rebuiltSuccessor)))) {
    throw new Error("source-main successor replay mismatch");
  }
  const retained = Object.fromEntries(await Promise.all(RETAINED_LINEAGE_OUTPUTS.map(async (relative) => [relative, await lineageFile(retainedRoot, relative, `retained ${relative}`)])));
  const retainedFacility = parsedCanonical(retained["tools/datapack/release/current-capital-facility-source-admission.json"].bytes, canonicalCurrentCapitalFacilitySourceAdmissionJson, "retained FACILITY");
  const retainedSnapshotPath = requiredRelativePath(retainedFacility.sourceIdentity?.snapshotPath, "retained FACILITY snapshot");
  if (!/^tools\/datapack\/sources\/kric-station-convenience-standard-[0-9]{8}T[0-9]{9}Z\.json$/u.test(retainedSnapshotPath)) {
    throw new Error("retained FACILITY snapshot path mismatch");
  }
  retained[retainedSnapshotPath] = await lineageFile(retainedRoot, retainedSnapshotPath, "retained FACILITY snapshot");
  const retainedCandidate = JSON.parse(retained["tools/datapack/release/candidate-build-spec.json"].bytes);
  const protectedTerminalCandidateId = successor.nextCandidate?.candidateId;
  if (typeof protectedTerminalCandidateId !== "string" || protectedTerminalCandidateId === ""
    || retainedCandidate?.candidateId !== protectedTerminalCandidateId) {
    throw new Error("terminal protected candidate identity mismatch");
  }
  const retainedInventory = JSON.parse(retained["tools/datapack/source-inventory.json"].bytes);
  const retainedLedger = JSON.parse(retained["tools/datapack/release/source-snapshots.json"].bytes);
  const retainedSnapshot = JSON.parse(retained[retainedSnapshotPath].bytes);
  const retainedLedgerEntry = retainedLedger.find((entry) => entry?.sourceId === "kric-station-convenience-standard"
    && entry.snapshotId === retainedSnapshot.snapshotId);
  if (!retainedLedgerEntry?.rawReceipt || retainedLedgerEntry.rawObjectUri == null || retainedLedgerEntry.rawRetentionExpiresAt == null) {
    throw new Error("retained FACILITY receipt metadata mismatch");
  }
  const registrationAt = new Date(retainedLedgerEntry.rawReceipt.storedAt);
  const candidatePublishedAt = new Date(retainedCandidate.publishedAt);
  const facilityObservedAt = new Date(retainedFacility.observedAt);
  if ([registrationAt, candidatePublishedAt, facilityObservedAt].some((value) => Number.isNaN(value.valueOf()))
    || retainedCandidate.publishedAt !== candidatePublishedAt.toISOString()
    || retainedFacility.observedAt !== facilityObservedAt.toISOString()) {
    throw new Error("retained producer timing mismatch");
  }
  const replayParent = await mkdtemp(path.join(path.dirname(path.resolve(sourceMainRoot)), ".current-capital-terminal-lineage-"));
  const replayRoot = path.join(replayParent, "source-main");
  try {
    await cp(sourceMainRoot, replayRoot, { recursive: true, dereference: false, filter: (entry) => path.basename(entry) !== ".git" });
    const replayPlanInput = Object.fromEntries(await Promise.all([
      ["canonicalPackBytes", "tools/datapack/release/capital-production-canonical-pack.json"],
      ["coverageTargetsBytes", "tools/datapack/nationwide-coverage-targets.json"],
      ["providerCodeCatalogBytes", "tools/datapack/sources/kric-provider-code-catalog-20260228.json"],
      ["routeRostersBytes", "tools/datapack/sources/kric-nationwide-route-rosters-20260730T203926676Z.json"],
      ["sourceInventoryBytes", "tools/datapack/source-inventory.json"],
    ].map(async ([key, relative]) => [key, (await lineageFile(replayRoot, relative, `source-main ${key}`)).bytes])));
    const planPath = path.join(replayParent, "facility-plan.json");
    const planBytes = canonicalBytes(buildCurrentCapitalFacilityCollectionPlan(replayPlanInput), canonicalCurrentCapitalFacilityCollectionPlanJson);
    await writeFile(planPath, planBytes, { flag: "wx", mode: 0o600 });
    const rawReceipt = {
      ...retainedLedgerEntry.rawReceipt,
      rawObjectUri: retainedLedgerEntry.rawObjectUri,
      rawRetentionExpiresAt: retainedLedgerEntry.rawRetentionExpiresAt,
    };
    await registerKricStandardAccessibilitySnapshot({
      repositoryRoot: replayRoot,
      snapshotFilePath: retained[retainedSnapshotPath].path,
      snapshotFileSha256: sha256(retained[retainedSnapshotPath].bytes),
      snapshotTargetPath: path.join(replayRoot, retainedSnapshotPath),
      rawReceipt,
      capitalFacilityPlanPath: planPath,
      capitalCanonicalPackPath: path.join(replayRoot, "tools/datapack/release/capital-production-canonical-pack.json"),
      producerNeutralFullRegistration: true,
      now: registrationAt,
    });
    await rebindCurrentCandidateSourceSnapshots({ repositoryRoot: replayRoot, now: candidatePublishedAt });
    const replay = Object.fromEntries(await Promise.all(RETAINED_LINEAGE_OUTPUTS.map(async (relative) => [relative, await lineageFile(replayRoot, relative, `replayed ${relative}`)])));
    replay[retainedSnapshotPath] = await lineageFile(replayRoot, retainedSnapshotPath, "replayed FACILITY snapshot");
    const replayAdmission = buildCurrentCapitalFacilitySourceAdmission({
      observedAt: facilityObservedAt.toISOString(),
      candidateBuildSpec: JSON.parse(replay["tools/datapack/release/candidate-build-spec.json"].bytes),
      sourceInventoryBytes: replay["tools/datapack/source-inventory.json"].bytes,
      sourceSnapshots: JSON.parse(replay["tools/datapack/release/source-snapshots.json"].bytes),
      governancePolicy: JSON.parse((await lineageFile(replayRoot, "tools/datapack/source-governance-policy.json", "replayed governance")).bytes),
      governancePolicyBytes: (await lineageFile(replayRoot, "tools/datapack/source-governance-policy.json", "replayed governance")).bytes,
      freshnessPolicy: JSON.parse((await lineageFile(replayRoot, "release/product-gates/datapack-freshness-sla.json", "replayed freshness")).bytes),
      canonicalPackBytes: replayPlanInput.canonicalPackBytes,
      planBytes,
      snapshotBytes: replay[retainedSnapshotPath].bytes,
      candidateEvaluationAt: retainedCandidate.publishedAt,
    });
    const replayAdmissionBytes = canonicalBytes(replayAdmission, canonicalCurrentCapitalFacilitySourceAdmissionJson);
    replay["tools/datapack/release/current-capital-facility-source-admission.json"] = { bytes: replayAdmissionBytes };
    const retainedPathsForReplay = sortedLineagePaths([...RETAINED_LINEAGE_OUTPUTS, retainedSnapshotPath], "retained lineage output paths");
    for (const relative of retainedPathsForReplay) {
      if (!replay[relative]?.bytes.equals(retained[relative].bytes)) {
        throw new Error(`retained producer replay mismatch: ${relative}`);
      }
    }
  } finally {
    await rm(replayParent, { recursive: true, force: true });
  }
  const generated = await buildTopologyOutputsImpl({
    repositoryRoot: privateBuilderRoot, builderGitSha,
    terminalCandidateId: terminalCandidateIdForLineageProof({
      proofMode,
      protectedTerminalCandidateId,
    }),
    ...topologyBuild,
  });
  const topologyOutputs = generated.outputs.map(({ relativePath, bytes }) => ({ relativePath, bytes }));
  if (topologyOutputs.length === 0 || !topologyOutputs.every(({ relativePath, bytes }) => Buffer.isBuffer(bytes) && bytes.length > 0)) {
    throw new Error("terminal topology generator output mismatch");
  }
  const retainedPaths = sortedLineagePaths([...RETAINED_LINEAGE_OUTPUTS, retainedSnapshotPath], "retained lineage output paths")
    .map((relative) => ({ relative, sha256: sha256(retained[relative].bytes) }));
  const topologyInputPaths = sortedLineagePaths(LINEAGE_TOPOLOGY_INPUTS.map((key) => topologyBuild[key]), "terminal topology input paths");
  const topologyInputs = await Promise.all(topologyInputPaths.map(async (relativePath) => ({
    relativePath, sha256: sha256((await lineageFile(privateBuilderRoot, relativePath, `builder topology ${relativePath}`)).bytes),
  })));
  const topologyProofOutputs = await Promise.all(topologyOutputs.map(async ({ relativePath, bytes }) => {
    const before = await optionalLineageFile(retainedRoot, relativePath, `retained topology ${relativePath}`);
    return { relativePath, beforeSha256: before == null ? null : sha256(before.bytes), generatedSha256: sha256(bytes) };
  }));
  const reverification = topologyProofOutputs.filter(({ relativePath }) => /^tools\/datapack\/release\/capital-topology-reverification-[0-9]{8}\.json$/u.test(relativePath));
  if (topologyProofOutputs.length !== generated.outputs.length || reverification.length !== 1
    || topologyProofOutputs.some(({ beforeSha256, relativePath }) => beforeSha256 == null && !/^tools\/datapack\/release\/capital-topology-reverification-[0-9]{8}\.json$/u.test(relativePath))) {
    throw new Error("terminal topology output subset mismatch");
  }
  const createOncePaths = new Set([
    ...topologyInputPaths,
    ...reverification.map(({ relativePath }) => relativePath),
  ]);
  const replacementPaths = sortedLineagePaths([
    ...new Set([
      ...topologyOutputs.map(({ relativePath }) => relativePath).filter((relativePath) => !createOncePaths.has(relativePath)),
      ...currentCapitalLiveChainOutputPaths({
        candidate: retainedCandidate,
        sourceInventory: retainedInventory,
        sourceSnapshotLedger: retainedLedger,
      }),
      CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_PATH,
    ]),
  ], "terminal replacement prestate paths");
  const replacementPrestates = await Promise.all(replacementPaths.map(async (relativePath) => ({
    relativePath,
    sha256: sha256((await lineageFile(retainedRoot, relativePath, `retained replacement ${relativePath}`)).bytes),
  })));
  const replacementByPath = new Map(replacementPrestates.map((entry) => [entry.relativePath, entry.sha256]));
  if (topologyProofOutputs.some(({ relativePath, beforeSha256 }) => !createOncePaths.has(relativePath)
    && beforeSha256 !== replacementByPath.get(relativePath))) {
    throw new Error("terminal topology replacement prestate mismatch");
  }
  const proof = Object.freeze({
    schemaVersion: 2,
    artifactKind: "current-capital-terminal-lineage",
    sourceMainGitSha,
    facilityHeadGitSha,
    builderGitSha,
    transition: Object.freeze({
      baseSha256: sha256(source.transition.bytes), successorSha256: sha256(source.successor.bytes),
      sourceMainCandidateSha256: sha256(source.candidate.bytes), sourceMainFacilitySha256: sha256(source.facility.bytes),
    }),
    retainedOutputs: Object.freeze(retainedPaths.map(Object.freeze)),
    topologyInputs: Object.freeze(topologyInputs.map(Object.freeze)),
    topologyOutputs: Object.freeze(topologyProofOutputs.sort((left, right) => codepointCompare(left.relativePath, right.relativePath)).map(Object.freeze)),
    replacementPrestates: Object.freeze(replacementPrestates.map(Object.freeze)),
  });
  return Object.freeze({
    proof,
    topologyInputs: Object.freeze((await Promise.all(topologyInputs.map(async ({ relativePath }) => Object.freeze({
      relativePath,
      bytes: Buffer.from((await lineageFile(privateBuilderRoot, relativePath, `builder topology ${relativePath}`)).bytes),
    })) ))),
    topologyOutputs: Object.freeze(topologyOutputs.map(({ relativePath, bytes }) => Object.freeze({ relativePath, bytes: Buffer.from(bytes) }))),
  });
}

export function terminalCandidateIdForLineageProof({
  proofMode,
  protectedTerminalCandidateId,
} = {}) {
  if (!["CURRENT_TERMINAL", "IMMUTABLE_PREDECESSOR"].includes(proofMode)) {
    throw new Error("terminal topology proof mode mismatch");
  }
  if (typeof protectedTerminalCandidateId !== "string" || protectedTerminalCandidateId === "") {
    throw new Error("terminal protected candidate identity mismatch");
  }
  return proofMode === "CURRENT_TERMINAL" ? protectedTerminalCandidateId : undefined;
}

export async function buildCurrentCapitalTopologyTerminalHandoff({
  repository,
  operationId,
  sourceMainGitSha,
  facilityBranch,
  facilityHeadGitSha,
  builderGitSha,
  topologyBuild,
  privateBuilderRoot,
  proof,
  accessibilitySourceHandoff,
}) {
  requiredOperation(operationId);
  [sourceMainGitSha, facilityHeadGitSha, builderGitSha].forEach(requiredSha);
  const proofInputs = new Map(proof.topologyInputs.map((entry) => [entry.relativePath, entry.sha256]));
  const inputs = await Promise.all(LINEAGE_TOPOLOGY_INPUTS.map(async (key) => {
    const relativePath = requiredRelativePath(topologyBuild[key], `topology handoff ${key}`);
    const file = await lineageFile(privateBuilderRoot, relativePath, `topology handoff ${key}`);
    const value = JSON.parse(file.bytes);
    const capturedAt = new Date(value.capturedAt);
    const freshUntil = new Date(value.freshUntil);
    if (value.sourceId == null || Number.isNaN(capturedAt.valueOf()) || Number.isNaN(freshUntil.valueOf())
      || capturedAt.toISOString() !== value.capturedAt || freshUntil.toISOString() !== value.freshUntil
      || proofInputs.get(relativePath) !== sha256(file.bytes)) {
      throw new Error(`topology handoff ${key} identity mismatch`);
    }
    return { key, relativePath, sha256: sha256(file.bytes), sourceId: value.sourceId, capturedAt: value.capturedAt, freshUntil: value.freshUntil };
  }));
  const accessibility = validateCurrentCapitalAccessibilitySourceHandoff(accessibilitySourceHandoff, {
    repository,
    operationId,
    sourceMainGitSha,
    facilityBranch,
    facilityHeadGitSha,
    protectedCandidateId: accessibilitySourceHandoff?.protectedCandidateId,
  });
  const payload = {
    schemaVersion: 2,
    artifactKind: "current-capital-topology-terminal-handoff",
    repository,
    operationId,
    sourceMainGitSha,
    facility: { branch: facilityBranch, headSha: facilityHeadGitSha },
    builderGitSha,
    topologyBuild,
    inputs,
    lineageProofSha256: sha256(Buffer.from(canonicalJson(proof))),
    accessibilitySourceHandoff: {
      handoffSha256: accessibility.handoffSha256,
      operationId: accessibility.operationId,
      operationNow: accessibility.operationNow,
      protectedCandidateId: accessibility.protectedCandidateId,
      providerStartedAt: accessibility.providerStartedAt,
    },
    itxProviderCalls: 0,
  };
  return Object.freeze({ ...payload, handoffSha256: sha256(Buffer.from(canonicalJson(payload))) });
}

function validateCurrentCapitalTopologyTerminalHandoff(bytes, expected) {
  let value;
  try { value = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { throw new Error("topology terminal handoff JSON mismatch"); }
  exactKeys(value, [
    "schemaVersion", "artifactKind", "repository", "operationId", "sourceMainGitSha", "facility",
    "builderGitSha", "topologyBuild", "inputs", "lineageProofSha256", "accessibilitySourceHandoff",
    "itxProviderCalls", "handoffSha256",
  ], "topology terminal handoff");
  exactKeys(value.facility, ["branch", "headSha"], "topology terminal handoff facility");
  const { handoffSha256, ...payload } = value ?? {};
  const accessibility = value?.accessibilitySourceHandoff;
  if (!Buffer.from(bytes).equals(Buffer.from(`${canonicalJson(value)}\n`))
    || handoffSha256 !== sha256(Buffer.from(canonicalJson(payload)))
    || value.schemaVersion !== 2 || value.artifactKind !== "current-capital-topology-terminal-handoff"
    || value.repository !== expected.repository || value.sourceMainGitSha !== expected.sourceMainGitSha
    || value.facility?.branch !== expected.facilityBranch || value.facility?.headSha !== expected.facilityHeadGitSha
    || value.builderGitSha !== expected.builderGitSha
    || canonicalJson(value.topologyBuild) !== canonicalJson(expected.topologyBuild)
    || value.lineageProofSha256 !== sha256(Buffer.from(canonicalJson(expected.proof)))
    || value.itxProviderCalls !== 0 || !Array.isArray(value.inputs) || value.inputs.length !== 4
    || !accessibility || typeof accessibility !== "object" || Array.isArray(accessibility)
    || JSON.stringify(Object.keys(accessibility).sort(codepointCompare)) !== JSON.stringify([
      "handoffSha256", "operationId", "operationNow", "protectedCandidateId", "providerStartedAt",
    ])
    || !/^[a-f0-9]{64}$/u.test(accessibility.handoffSha256 ?? "")
    || accessibility.operationId !== value.operationId
    || typeof accessibility.protectedCandidateId !== "string" || accessibility.protectedCandidateId === ""
    || requiredOffsetInstantMillis(accessibility.providerStartedAt, "accessibility provider start")
      > requiredOffsetInstantMillis(accessibility.operationNow, "accessibility operation now")) {
    throw new Error("topology terminal handoff identity mismatch");
  }
  const proofInputs = new Map(expected.proof.topologyInputs.map((entry) => [entry.relativePath, entry.sha256]));
  for (const key of LINEAGE_TOPOLOGY_INPUTS) {
    const matches = value.inputs.filter((entry) => entry?.key === key);
    const relativePath = expected.topologyBuild[key];
    if (matches.length !== 1 || matches[0].relativePath !== relativePath
      || matches[0].sha256 !== proofInputs.get(relativePath)
      || typeof matches[0].sourceId !== "string" || matches[0].sourceId === ""
      || new Date(matches[0].capturedAt).toISOString() !== matches[0].capturedAt
      || new Date(matches[0].freshUntil).toISOString() !== matches[0].freshUntil) {
      throw new Error("topology terminal handoff input mismatch");
    }
  }
  return Object.freeze(value);
}
function proofHashMap(entries, pathKey, label) {
  if (!Array.isArray(entries)) throw new Error(`${label} mismatch`);
  const mapped = new Map(entries.map((entry) => [entry?.[pathKey], entry?.sha256]));
  if (mapped.size !== entries.length || [...mapped].some(([relativePath, digest]) =>
    requiredRelativePath(relativePath, label) !== relativePath || !/^[a-f0-9]{64}$/u.test(digest ?? ""))) {
    throw new Error(`${label} mismatch`);
  }
  return mapped;
}
function equalHashMaps(left, right, label) {
  if (left.size !== right.size || [...left].some(([relativePath, digest]) => right.get(relativePath) !== digest)) {
    throw new Error(`${label} mismatch`);
  }
}
async function assertAncestorRecoveryByteEquality({ ancestorRoot, currentRoot, entries, pathKey, label }) {
  const expected = proofHashMap(entries, pathKey, label);
  await Promise.all([...expected].map(async ([relativePath, digest]) => {
    const [ancestor, current] = await Promise.all([
      lineageFile(ancestorRoot, relativePath, `ancestor recovery ancestor ${relativePath}`),
      lineageFile(currentRoot, relativePath, `ancestor recovery current ${relativePath}`),
    ]);
    if (sha256(ancestor.bytes) !== digest || !ancestor.bytes.equals(current.bytes)) {
      throw new Error("ancestor recovery retained terminal input mismatch");
    }
  }));
  return expected;
}

/**
 * Rebind an already authenticated producer topology handoff to the current
 * FACILITY head only after every terminal input still has the old proof's
 * exact bytes.  This changes neither the provider source handoff nor its OCI
 * tuple: the returned handoff retains the original source operation ID.
 */
export async function rebuildCurrentCapitalTopologyTerminalHandoffForAncestorRecovery({
  repository,
  sourceMainRoot,
  sourceMainGitSha,
  ancestorRetainedRoot,
  ancestorFacilityHeadGitSha,
  originalPrivateBuilderRoot,
  originalBuilderGitSha,
  currentRetainedRoot,
  currentFacilityBranch,
  currentFacilityHeadGitSha,
  topologyHandoffBytes,
  accessibilitySourceHandoff,
  execFileImpl = execFile,
  verifyTerminalLineageImpl = verifyCurrentCapitalTerminalLineage,
  buildTopologyHandoffImpl = buildCurrentCapitalTopologyTerminalHandoff,
} = {}) {
  if (repository !== "AquilaXk/easysubway-data"
    || !/^automation\/629-kric-facility-refresh-[0-9]+$/u.test(currentFacilityBranch ?? "")
    || !Buffer.isBuffer(topologyHandoffBytes)
    || typeof verifyTerminalLineageImpl !== "function" || typeof buildTopologyHandoffImpl !== "function") {
    throw new Error("ancestor recovery topology handoff inputs mismatch");
  }
  [sourceMainGitSha, ancestorFacilityHeadGitSha, originalBuilderGitSha, currentFacilityHeadGitSha].forEach(requiredSha);
  if (![sourceMainRoot, ancestorRetainedRoot, originalPrivateBuilderRoot, currentRetainedRoot]
    .every((value) => path.isAbsolute(value ?? ""))) {
    throw new Error("ancestor recovery topology handoff roots mismatch");
  }
  let originalTopology;
  try { originalTopology = JSON.parse(topologyHandoffBytes.toString("utf8")); } catch { throw new Error("ancestor recovery topology handoff JSON mismatch"); }
  const topologyBuild = originalTopology?.topologyBuild;
  const originalPrepared = await verifyTerminalLineageImpl({
    sourceMainRoot: path.resolve(sourceMainRoot), retainedRoot: path.resolve(ancestorRetainedRoot),
    privateBuilderRoot: path.resolve(originalPrivateBuilderRoot), sourceMainGitSha,
    facilityHeadGitSha: ancestorFacilityHeadGitSha, builderGitSha: originalBuilderGitSha,
    topologyBuild, execFileImpl, proofMode: "CURRENT_TERMINAL",
  });
  if (!originalPrepared?.proof) throw new Error("ancestor recovery original lineage mismatch");
  const originalHandoff = validateCurrentCapitalTopologyTerminalHandoff(topologyHandoffBytes, {
    repository, sourceMainGitSha, facilityBranch: currentFacilityBranch,
    facilityHeadGitSha: ancestorFacilityHeadGitSha, builderGitSha: originalBuilderGitSha,
    topologyBuild, proof: originalPrepared.proof,
  });
  const reboundAccessibility = validateCurrentCapitalAccessibilitySourceHandoff(accessibilitySourceHandoff, {
    repository,
    operationId: originalHandoff.operationId,
    sourceMainGitSha,
    facilityBranch: currentFacilityBranch,
    facilityHeadGitSha: currentFacilityHeadGitSha,
    protectedCandidateId: originalHandoff.accessibilitySourceHandoff.protectedCandidateId,
  });
  if (reboundAccessibility.providerStartedAt !== originalHandoff.accessibilitySourceHandoff.providerStartedAt
    || reboundAccessibility.operationNow !== originalHandoff.accessibilitySourceHandoff.operationNow) {
    throw new Error("ancestor recovery accessibility source clock mismatch");
  }
  const retained = await assertAncestorRecoveryByteEquality({
    ancestorRoot: path.resolve(ancestorRetainedRoot), currentRoot: path.resolve(currentRetainedRoot),
    entries: originalPrepared.proof.retainedOutputs, pathKey: "relative", label: "ancestor recovery retained outputs",
  });
  const prestates = await assertAncestorRecoveryByteEquality({
    ancestorRoot: path.resolve(ancestorRetainedRoot), currentRoot: path.resolve(currentRetainedRoot),
    entries: originalPrepared.proof.replacementPrestates, pathKey: "relativePath", label: "ancestor recovery replacement prestates",
  });
  await Promise.all(CURRENT_CAPITAL_TERMINAL_MARKERS.map(async (relativePath) => {
    const [ancestor, current] = await Promise.all([
      lineageFile(path.resolve(ancestorRetainedRoot), relativePath, `ancestor recovery ancestor ${relativePath}`),
      lineageFile(path.resolve(currentRetainedRoot), relativePath, `ancestor recovery current ${relativePath}`),
    ]);
    if (!ancestor.bytes.equals(current.bytes)) throw new Error("ancestor recovery retained terminal input mismatch");
  }));
  const currentPrepared = await verifyTerminalLineageImpl({
    sourceMainRoot: path.resolve(sourceMainRoot), retainedRoot: path.resolve(currentRetainedRoot),
    privateBuilderRoot: path.resolve(originalPrivateBuilderRoot), sourceMainGitSha,
    facilityHeadGitSha: currentFacilityHeadGitSha, builderGitSha: originalBuilderGitSha,
    topologyBuild, execFileImpl, proofMode: "CURRENT_TERMINAL",
  });
  if (!currentPrepared?.proof) throw new Error("ancestor recovery current lineage mismatch");
  equalHashMaps(retained, proofHashMap(currentPrepared.proof.retainedOutputs, "relative", "ancestor recovery retained outputs"), "ancestor recovery retained outputs");
  equalHashMaps(prestates, proofHashMap(currentPrepared.proof.replacementPrestates, "relativePath", "ancestor recovery replacement prestates"), "ancestor recovery replacement prestates");
  equalHashMaps(
    proofHashMap(originalPrepared.proof.topologyInputs, "relativePath", "ancestor recovery topology inputs"),
    proofHashMap(currentPrepared.proof.topologyInputs, "relativePath", "ancestor recovery topology inputs"),
    "ancestor recovery topology inputs",
  );
  const topologyHandoff = await buildTopologyHandoffImpl({
    repository, operationId: originalHandoff.operationId, sourceMainGitSha,
    facilityBranch: currentFacilityBranch, facilityHeadGitSha: currentFacilityHeadGitSha,
    builderGitSha: originalBuilderGitSha, topologyBuild,
    privateBuilderRoot: path.resolve(originalPrivateBuilderRoot), proof: currentPrepared.proof,
    accessibilitySourceHandoff: reboundAccessibility,
  });
  return Object.freeze({
    topologyHandoff,
    accessibilitySourceHandoff: reboundAccessibility,
    originalProof: originalPrepared.proof,
    currentProof: currentPrepared.proof,
  });
}
async function readStagedRegularFile(stagedRoot, relativePath, label) {
  const root = path.resolve(stagedRoot);
  await requireRealDirectory(root, "staged repository root");
  const relative = requiredRelativePath(relativePath, label);
  let current = root;
  for (const [index, segment] of relative.split("/").entries()) {
    current = path.join(current, segment);
    const stat = await lstat(current);
    const isLast = index === relative.split("/").length - 1;
    if (stat.isSymbolicLink() || isLast && !stat.isFile() || !isLast && !stat.isDirectory()) {
      throw new Error(`${label} must be a real regular file`);
    }
  }
  return { path: current, bytes: await readFile(current) };
}

async function verifyPreparedTopologyStage(stagedRoot, proof) {
  if (!proof || proof.schemaVersion !== 2
    || !Array.isArray(proof.topologyInputs) || !Array.isArray(proof.topologyOutputs)) {
    throw new Error("terminal staged topology lineage proof mismatch");
  }
  await Promise.all([
    ...proof.topologyInputs.map(async ({ relativePath, sha256: expected }) => {
      const staged = await readStagedRegularFile(stagedRoot, relativePath, `terminal staged topology input ${relativePath}`);
      if (sha256(staged.bytes) !== expected) throw new Error("terminal staged topology input mismatch");
    }),
    ...proof.topologyOutputs.map(async ({ relativePath, generatedSha256 }) => {
      const staged = await readStagedRegularFile(stagedRoot, relativePath, `terminal staged topology output ${relativePath}`);
      if (sha256(staged.bytes) !== generatedSha256) throw new Error("terminal staged topology output mismatch");
    }),
  ]);
}

export async function resolveCurrentKricExitPlanInputs(stagedRoot) {
  const bindingFile = await readStagedRegularFile(stagedRoot, CURRENT_KRIC_EXIT_PLAN_INPUTS_PATH, "current KRIC exit binding");
  let binding;
  try { binding = JSON.parse(bindingFile.bytes.toString("utf8")); } catch { throw new Error("current KRIC exit binding JSON mismatch"); }
  exactKeys(binding, ["schemaVersion", "artifactKind", "providerCodeCatalog", "routeRosters"], "current KRIC exit binding");
  if (binding.schemaVersion !== 1 || binding.artifactKind !== "current-kric-exit-plan-inputs") {
    throw new Error("current KRIC exit binding identity mismatch");
  }
  exactKeys(binding.providerCodeCatalog, ["candidateId", "relativePath", "sha256", "artifactKind", "sourceId"], "provider code catalog binding");
  exactKeys(binding.routeRosters, ["candidateId", "relativePath", "sha256", "artifactKind", "sourceId", "targetVersion"], "route rosters binding");
  const inputs = [
    { key: "providerCodeCatalog", binding: binding.providerCodeCatalog, admissionStatus: "admitted_as_code_mapping" },
    { key: "routeRosters", binding: binding.routeRosters, admissionStatus: "admitted_to_production_inventory" },
  ];
  for (const { key, binding: input, admissionStatus } of inputs) {
    if (typeof input.candidateId !== "string" || input.candidateId === ""
      || typeof input.artifactKind !== "string" || input.artifactKind === ""
      || typeof input.sourceId !== "string" || input.sourceId === "") {
      throw new Error(`${key} binding identity mismatch`);
    }
    requiredBindingSha(input.sha256, `${key} binding`);
    requiredRelativePath(input.relativePath, `${key} binding`);
    const file = await readStagedRegularFile(stagedRoot, input.relativePath, `${key} binding`);
    if (sha256(file.bytes) !== input.sha256) throw new Error(`${key} binding hash mismatch`);
    let source;
    try { source = JSON.parse(file.bytes.toString("utf8")); } catch { throw new Error(`${key} source JSON mismatch`); }
    if (source?.schemaVersion !== 1 || source.artifactKind !== input.artifactKind || source.sourceId !== input.sourceId) {
      throw new Error(`${key} source identity mismatch`);
    }
    if (key === "routeRosters" && source.targetVersion !== input.targetVersion) {
      throw new Error("route roster targetVersion mismatch");
    }
  }
  const [candidatesFile, targetsFile] = await Promise.all([
    readStagedRegularFile(stagedRoot, "tools/datapack/source-candidates.json", "source candidates"),
    readStagedRegularFile(stagedRoot, "tools/datapack/nationwide-coverage-targets.json", "nationwide coverage targets"),
  ]);
  let candidates;
  let targets;
  try {
    candidates = JSON.parse(candidatesFile.bytes.toString("utf8"));
    targets = JSON.parse(targetsFile.bytes.toString("utf8"));
  } catch { throw new Error("current KRIC exit supporting contract JSON mismatch"); }
  for (const { key, binding: input, admissionStatus } of inputs) {
    const matches = candidates?.candidates?.filter(({ id }) => id === input.candidateId) ?? [];
    if (matches.length !== 1 || matches[0].admissionStatus !== admissionStatus) {
      throw new Error(`${key} candidate identity mismatch`);
    }
  }
  if (typeof binding.routeRosters.targetVersion !== "string" || binding.routeRosters.targetVersion === ""
    || targets?.targetVersion !== binding.routeRosters.targetVersion) {
    throw new Error("route roster targetVersion mismatch");
  }
  return {
    providerCodeCatalogRelativePath: binding.providerCodeCatalog.relativePath,
    routeRostersRelativePath: binding.routeRosters.relativePath,
  };
}

export function resolveStagedIncheonTopologyPath(inventory) {
  const matches = inventory?.sources?.filter(({ id }) => id === "incheon-transit-station-info") ?? [];
  if (matches.length !== 1) throw new Error("Incheon topology identity mismatch");
  const source = matches[0];
  const topology = source.topologyAdmissionEvidence;
  const membership = source.membershipAdmissionEvidence;
  const routeMap = source.routeMapAdmissionEvidence;
  const snapshotPath = topology?.snapshotPath;
  if (typeof topology?.snapshotId !== "string" || topology.snapshotId === ""
    || membership?.snapshotId !== topology.snapshotId || routeMap?.snapshotId !== topology.snapshotId
    || routeMap.snapshotPath !== snapshotPath || routeMap.topologySnapshotId !== topology.snapshotId
    || routeMap.topologyContentSha256 !== topology.contentSha256
    || snapshotPath !== `tools/datapack/sources/${topology.snapshotId}.json`
    || path.posix.isAbsolute(snapshotPath) || snapshotPath.includes("\\")
    || snapshotPath.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Incheon topology identity mismatch");
  }
  return snapshotPath;
}

export async function resolveCurrentLiveChainCandidateStageInputs(candidate, repositoryRoot) {
  const topologyPath = candidate?.itxTopologyEvidencePath;
  if (typeof topologyPath !== "string"
    || !/^tools\/datapack\/itx-cheongchun-topology-evidence-[0-9]{17}\.json$/u.test(topologyPath)) {
    throw new Error("candidate ITX topology evidence path is not versioned exactly");
  }
  requiredBindingSha(candidate?.itxTopologyEvidenceSha256, "candidate ITX topology evidence");
  const coverage = candidate?.networkEdgeEvidence?.itxCoverageContract;
  let coveragePath;
  try { coveragePath = requiredRelativePath(coverage?.path, "ITX coverage contract"); } catch { throw new Error("ITX coverage contract path mismatch"); }
  try { requiredBindingSha(coverage?.sha256, "ITX coverage contract"); } catch { throw new Error("ITX coverage contract hash mismatch"); }
  const [topology, coverageFile] = await Promise.all([
    readStagedRegularFile(repositoryRoot, topologyPath, "candidate ITX topology evidence"),
    readStagedRegularFile(repositoryRoot, coveragePath, "ITX coverage contract"),
  ]);
  if (sha256(topology.bytes) !== candidate.itxTopologyEvidenceSha256) {
    throw new Error("candidate ITX topology evidence hash mismatch");
  }
  if (sha256(coverageFile.bytes) !== coverage.sha256) throw new Error("ITX coverage contract hash mismatch");
  return Object.freeze([topologyPath, coveragePath]);
}

export async function assertCurrentCapitalFacilityAdmission({ stagedRoot, now }) {
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) throw new Error("current live-chain operation clock mismatch");
  const [file, inventoryFile, candidateFile, ledgerFile] = await Promise.all([
    readStagedRegularFile(stagedRoot, "tools/datapack/release/current-capital-facility-source-admission.json", "current capital facility admission"),
    readStagedRegularFile(stagedRoot, "tools/datapack/source-inventory.json", "current source inventory"),
    readStagedRegularFile(stagedRoot, "tools/datapack/release/candidate-build-spec.json", "current candidate build spec"),
    readStagedRegularFile(stagedRoot, "tools/datapack/release/source-snapshots.json", "current source snapshot ledger"),
  ]);
  let admission;
  try { admission = JSON.parse(file.bytes.toString("utf8")); } catch { throw new Error("current capital facility admission JSON mismatch"); }
  let canonical;
  try { canonical = canonicalCurrentCapitalFacilitySourceAdmissionJson(admission); } catch { throw new Error("current capital facility admission is invalid"); }
  if (!file.bytes.equals(Buffer.from(canonical))) throw new Error("current capital facility admission bytes are not canonical");
  if ([admission.observedAt, admission.sourceIdentity.capturedAt, admission.sourceIdentity.observedAt]
    .some((value) => Date.parse(value) > now.valueOf())) {
    throw new Error("current capital facility admission is from the future");
  }
  if (Date.parse(admission.sourceIdentity.freshUntil) <= now.valueOf()) {
    throw new Error("current capital facility admission is stale");
  }
  let inventory; let candidate; let ledger; let heads;
  try {
    inventory = JSON.parse(inventoryFile.bytes.toString("utf8"));
    candidate = JSON.parse(candidateFile.bytes.toString("utf8"));
    ledger = JSON.parse(ledgerFile.bytes.toString("utf8"));
    heads = validateLineage(ledger).headsBySource;
  } catch {
    throw new Error("selected accessibility source identity mismatch");
  }
  for (const sourceId of ["seoul-metro-accessibility", "kric-station-convenience-standard"]) {
    const sources = inventory.sources?.filter(({ id }) => id === sourceId) ?? [];
    const projections = candidate.sourceSnapshots?.filter(({ sourceId: selected }) => selected === sourceId) ?? [];
    const source = sources[0]; const projection = projections[0]; const evidence = source?.accessibilityAdmissionEvidence;
    const selectedIndex = candidate.sourceSnapshots?.findIndex(({ sourceId: selected }) => selected === sourceId) ?? -1;
    const selectedSnapshotId = candidate.sourceSnapshotIds?.[selectedIndex];
    const capturedAt = Date.parse(evidence?.capturedAt); const observedAt = Date.parse(evidence?.observedAt);
    const freshUntil = Date.parse(evidence?.freshUntil);
    if (sources.length !== 1 || projections.length !== 1 || selectedIndex < 0
      || selectedSnapshotId !== evidence?.snapshotId || projection?.snapshotId !== evidence?.snapshotId
      || heads[sourceId] !== evidence?.snapshotId) {
      throw new Error(`selected accessibility source identity mismatch: ${sourceId}`);
    }
    if (![capturedAt, observedAt, freshUntil].every(Number.isFinite)
      || capturedAt > now.valueOf() || observedAt > now.valueOf()) {
      throw new Error(`selected accessibility source is from the future: ${sourceId}`);
    }
    if (freshUntil <= now.valueOf()) throw new Error(`selected accessibility source is stale: ${sourceId}`);
    if (sourceId === "kric-station-convenience-standard"
      && (admission.sourceIdentity.snapshotId !== evidence.snapshotId
        || admission.sourceIdentity.freshUntil !== evidence.freshUntil)) {
      throw new Error("current capital facility admission source identity mismatch");
    }
  }
  return admission;
}

function providerEquivalentCurrentPlan(embeddedPlanBytes, currentPlanBytes) {
  let embeddedPlan;
  let currentPlan;
  try {
    embeddedPlan = JSON.parse(embeddedPlanBytes.toString("utf8"));
    currentPlan = JSON.parse(currentPlanBytes.toString("utf8"));
    if (!embeddedPlanBytes.equals(Buffer.from(canonicalKricExitPathCollectionPlanJson(embeddedPlan)))
      || !currentPlanBytes.equals(Buffer.from(canonicalKricExitPathCollectionPlanJson(currentPlan)))) {
      throw new Error("collection plan bytes are not canonical");
    }
  } catch (error) { throw new Error(RETAINED_EXIT_PLAN_MISMATCH, { cause: error }); }
  const normalizedPlan = (plan) => {
    const normalized = structuredClone(plan);
    delete normalized.collectionPlanDigest;
    delete normalized.candidate.candidateId;
    return canonicalJson(normalized);
  };
  if (normalizedPlan(embeddedPlan) !== normalizedPlan(currentPlan)) {
    throw new Error(RETAINED_EXIT_PLAN_MISMATCH);
  }
  return currentPlan;
}

export async function recoverCurrentKricExitCollectionBytes({ retainedExitBundleBytes, expectedRetainedExitBundleSha256, currentPlanBytes, repository, repositorySha, operationId, operationNow, isAncestor }) {
  if (!/^[a-f0-9]{64}$/u.test(expectedRetainedExitBundleSha256 ?? "")) throw new Error("retained EXIT bundle expected digest mismatch");
  if (!(currentPlanBytes instanceof Uint8Array) || currentPlanBytes.byteLength === 0) throw new Error("current EXIT plan bytes are invalid");
  if (!(operationNow instanceof Date) || Number.isNaN(operationNow.valueOf())) throw new Error("current live-chain operation clock mismatch");
  if (!(retainedExitBundleBytes instanceof Uint8Array) || retainedExitBundleBytes.byteLength === 0 || typeof isAncestor !== "function") {
    throw new Error("retained EXIT bundle input mismatch");
  }
  const retainedBytes = Buffer.from(retainedExitBundleBytes);
  if (createHash("sha256").update(retainedBytes).digest("hex") !== expectedRetainedExitBundleSha256) {
    throw new Error("retained EXIT bundle expected digest mismatch");
  }
  let bundle;
  try { bundle = JSON.parse(retainedBytes.toString("utf8")); } catch { throw new Error("retained EXIT bundle JSON mismatch"); }
  let canonicalBundle;
  try { canonicalBundle = canonicalCurrentKricExitCollectionBundleJson(bundle); } catch { throw new Error("retained EXIT bundle is invalid"); }
  if (!retainedBytes.equals(Buffer.from(canonicalBundle))) throw new Error("retained EXIT bundle bytes are not canonical");
  const embeddedPlanBytes = Buffer.from(bundle.collectionPlanJson);
  const currentPlanBuffer = Buffer.from(currentPlanBytes);
  const currentPlan = providerEquivalentCurrentPlan(embeddedPlanBytes, currentPlanBuffer);
  let snapshotBytes = Buffer.from(bundle.providerSnapshotJson);
  let snapshot;
  let sourceReceipt;
  try {
    snapshot = JSON.parse(snapshotBytes.toString("utf8"));
    sourceReceipt = JSON.parse(bundle.collectionReceiptJson);
  } catch { throw new Error("retained EXIT bundle embedded JSON mismatch"); }
  const snapshotPayload = { ...snapshot };
  delete snapshotPayload.snapshotDigest;
  const reboundSnapshotPayload = { ...snapshotPayload, collectionPlanDigest: currentPlan.collectionPlanDigest };
  snapshot = {
    ...reboundSnapshotPayload,
    snapshotDigest: sha256(Buffer.from(canonicalJson(reboundSnapshotPayload))),
  };
  try { snapshotBytes = Buffer.from(canonicalKricExitPathProviderSnapshotJson(snapshot)); } catch {
    throw new Error("retained EXIT bundle snapshot rebound is invalid");
  }
  if (Date.parse(snapshot.capturedAt) > operationNow.valueOf()) throw new Error("retained EXIT bundle snapshot was not previously captured");
  if (Date.parse(snapshot.freshUntil) <= operationNow.valueOf()) throw new Error("retained EXIT bundle snapshot is stale");
  if (sourceReceipt.schemaVersion !== 1 || sourceReceipt.repository !== repository
    || sourceReceipt.repositorySha === repositorySha || sourceReceipt.operationId === operationId) {
    throw new Error("retained EXIT bundle source identity mismatch");
  }
  if (!await isAncestor(sourceReceipt.repositorySha, repositorySha)) {
    throw new Error("retained EXIT bundle source is not an ancestor of the candidate head");
  }
  const receipt = buildCurrentKricExitCollectionReceipt({
    collectionPlanBytes: currentPlanBuffer,
    providerSnapshotBytes: snapshotBytes,
    repository,
    repositorySha,
    operationId,
    recoveredFrom: {
      repositorySha: sourceReceipt.repositorySha,
      operationId: sourceReceipt.operationId,
      receiptSha256: sourceReceipt.receiptSha256,
      bundleSha256: bundle.bundleSha256,
    },
  });
  const recoveredBundle = buildCurrentKricExitCollectionBundle({
    collectionPlanBytes: currentPlanBuffer, providerSnapshotBytes: snapshotBytes, receipt,
  });
  return {
    snapshotBytes,
    snapshot,
    collectionBundleBytes: Buffer.from(canonicalCurrentKricExitCollectionBundleJson(recoveredBundle)),
  };
}

export async function recoverCurrentKricExitCollection({ retainedExitBundle, expectedRetainedExitBundleSha256, currentPlanBytes, repository, repositorySha, operationId, operationNow, root, execFileImpl }) {
  if (!path.isAbsolute(retainedExitBundle ?? "")) throw new Error("retained EXIT bundle must be absolute");
  const retained = await readRegularSnapshot(retainedExitBundle, "retained EXIT bundle");
  return recoverCurrentKricExitCollectionBytes({
    retainedExitBundleBytes: retained.bytes, expectedRetainedExitBundleSha256, currentPlanBytes,
    repository, repositorySha, operationId, operationNow,
    isAncestor: (from, to) => execFileImpl("git", ["merge-base", "--is-ancestor", from, to], { cwd: root }),
  });
}

export function resolveCurrentExitDerivationAt({ retainedExitBundle, providerCapturedAt, operationNow }) {
  if (retainedExitBundle === undefined) return providerCapturedAt;
  if (!(operationNow instanceof Date) || Number.isNaN(operationNow.valueOf())) throw new Error("current live-chain operation clock mismatch");
  return operationNow.toISOString();
}

async function assertRemoteMain({ root, repositorySha, execFileImpl }) {
  const { stdout } = await execFileImpl("git", ["ls-remote", "--exit-code", DATA_MAIN_REMOTE, "refs/heads/main"], { cwd: root });
  if (String(stdout).trimEnd() !== `${repositorySha}\trefs/heads/main`) throw new Error("exact remote main preflight failed");
}

export function buildCurrentCapitalLiveChainPlan({ repositoryRoot, repositorySha, operationId, stagedRoot, transferObservationDirectory, transferReceiptPath, incheonTopologyRelativePath, providerCodeCatalogRelativePath, routeRostersRelativePath, outputPaths }) {
  requiredSha(repositorySha); requiredOperation(operationId);
  if (![repositoryRoot, stagedRoot, transferObservationDirectory, transferReceiptPath].every((value) => path.isAbsolute(value ?? ""))) throw new Error("live-chain plan paths must be absolute");
  if (typeof incheonTopologyRelativePath !== "string" || path.posix.isAbsolute(incheonTopologyRelativePath) || incheonTopologyRelativePath.includes("\\")
    || incheonTopologyRelativePath.split("/").some((part) => part === "" || part === "." || part === "..")) throw new Error("Incheon topology path mismatch");
  requiredRelativePath(providerCodeCatalogRelativePath, "provider code catalog");
  requiredRelativePath(routeRostersRelativePath, "route rosters");
  if (!Array.isArray(outputPaths) || outputPaths.length === 0) throw new Error("live-chain output paths mismatch");
  const at = (...parts) => path.join(stagedRoot, ...parts);
  return { outputs: Object.freeze([...outputPaths]), steps: [
    { id: "materialize-public-route-map", script: "tools/datapack/rebind-current-active-public-route-map-materialization.mjs", args: ["--repository-root", stagedRoot] },
    { id: "rebind-transfer", script: "tools/datapack/rebind-current-live-chain-transfer-derived-identities.mjs", args: ["--repository-root", stagedRoot, "--observation-directory", transferObservationDirectory, "--receipt", transferReceiptPath] },
    { id: "rebind-facility", script: "tools/datapack/rebind-current-active-facility-derived-identity.mjs", args: ["--repository-root", stagedRoot] },
    { id: "build-exit-plan", script: "tools/datapack/build-current-kric-exit-collection-plan.mjs", args: ["--canonical-pack", at("tools/datapack/release/capital-production-canonical-pack.json"), "--coverage-targets", at("tools/datapack/nationwide-coverage-targets.json"), "--provider-code-catalog", at(providerCodeCatalogRelativePath), "--route-rosters", at(routeRostersRelativePath), "--source-inventory", at("tools/datapack/source-inventory.json"), "--incheon-topology", at(incheonTopologyRelativePath), "--coverage-selector", "capital-seoul-metro-production", "--output", at("current-kric-exit-plan.json")] },
    { id: "assert-current-topology-freshness", module: "tools/datapack/register-current-static-network-successors.mjs", exportName: "assertCurrentStaticNetworkTopologyAdmission" },
    { id: "collect-kric-exit", script: "tools/datapack/collect-current-kric-exit-path-provider-snapshot.mjs", args: ["--collection-plan", at("current-kric-exit-plan.json"), "--source-id", "kric-station-movement-standard", "--output", at("current-kric-exit-snapshot.json"), "--request-timeout-ms", String(CURRENT_KRIC_EXIT_REQUEST_TIMEOUT_MS), "--request-interval-ms", String(CURRENT_KRIC_EXIT_REQUEST_INTERVAL_MS)] },
    { id: "bind-exit-collection", script: "tools/datapack/build-current-kric-exit-collection-receipt.mjs", args: ["--collection-plan", at("current-kric-exit-plan.json"), "--provider-snapshot", at("current-kric-exit-snapshot.json"), "--repository", "AquilaXk/easysubway-data", "--repository-sha", repositorySha, "--operation-id", operationId, "--output", at("current-kric-exit-collection-bundle.json")] },
    { id: "admit-exit", script: "tools/datapack/build-current-exit-path-source-admission.mjs", args: ["--provider-snapshot", at("current-kric-exit-snapshot.json"), "--collection-plan", at("current-kric-exit-plan.json"), "--facility-admission", at("tools/datapack/release/current-capital-facility-source-admission.json"), "--candidate-build-spec", at("tools/datapack/release/candidate-build-spec.json"), "--source-inventory", at("tools/datapack/source-inventory.json"), "--source-snapshots", at("tools/datapack/release/source-snapshots.json"), "--observed-at", "FROM_PROVIDER_CAPTURED_AT", "--output-directory", at("current-exit-admission")] },
    { id: "bind-current-fan-in", script: "tools/datapack/build-current-capital-live-chain-boundary.mjs", args: [] },
    { id: "build-full-capital", script: "tools/datapack/build-current-capital-route-edge-input.mjs", args: [] },
    { id: "evaluate-route-policy", script: "tools/datapack/evaluate-route-accessibility-edges.mjs", args: ["--input", at("tools/datapack/release/current-capital-accessibility-full/route-edge-input.json"), "--output", at("tools/datapack/release/current-capital-accessibility-full/route-edge-evaluation.json")] },
    { id: "bundle", script: "tools/datapack/build-current-capital-live-chain-bundle.mjs", args: [] },
  ] };
}

async function replaceStagedFile({ from, to }) {
  await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
  await rename(from, to);
}

function stagedCopyAllowed(repositoryRoot, sourcePath, excludedPaths = EXCLUDED_STAGED_PATHS) {
  const relative = path.relative(repositoryRoot, sourcePath).split(path.sep).join("/");
  return !excludedPaths.some((excluded) => relative === excluded || relative.startsWith(`${excluded}/`));
}

async function buildFanInBoundaryBytes(stagedRoot) {
  const components = Object.fromEntries(await Promise.all(Object.entries(CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS).map(async ([name, relative]) => {
    const bytes = await readFile(path.join(stagedRoot, relative));
    return [name, { bytes, value: JSON.parse(bytes.toString("utf8")) }];
  })));
  const boundary = buildCurrentCapitalLiveChainFanInBoundary(components);
  const bytes = Buffer.from(canonicalCurrentCapitalLiveChainFanInBoundaryJson(boundary));
  const output = path.join(stagedRoot, CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_PATH);
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, bytes, { flag: "wx", mode: 0o600 });
  return bytes;
}

export async function evaluateStagedRoutePolicy({
  stagedRoot,
  evaluationAt,
  routeEdgeInputBytes = null,
  stationLineInputBytes = null,
  materializeStationLineAccessibilityImpl = materializeStationLineAccessibility,
  evaluateRouteAccessibilityEdgesImpl = evaluateRouteAccessibilityEdges,
  canonicalRouteEdgeEvaluationJsonImpl = canonicalRouteEdgeEvaluationJson,
}) {
  const routeEdgeInputPath = path.join(stagedRoot, "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json");
  const stationLineInputPath = path.join(stagedRoot, "tools/datapack/release/current-capital-accessibility-full/station-line-input.json");
  const policyPath = path.join(stagedRoot, "release/product-gates/route-edge-evaluation-policy.json");
  const outputPath = path.join(stagedRoot, "tools/datapack/release/current-capital-accessibility-full/route-edge-evaluation.json");
  if ((routeEdgeInputBytes == null) !== (stationLineInputBytes == null)
    || (routeEdgeInputBytes != null && (!Buffer.isBuffer(routeEdgeInputBytes) || !Buffer.isBuffer(stationLineInputBytes)))) {
    throw new Error("staged route policy input bytes mismatch");
  }
  const [resolvedRouteEdgeInputBytes, resolvedStationLineInputBytes, policyBytes] = await Promise.all([
    routeEdgeInputBytes ?? readFile(routeEdgeInputPath), stationLineInputBytes ?? readFile(stationLineInputPath), readFile(policyPath),
  ]);
  const routeEdgeInput = JSON.parse(resolvedRouteEdgeInputBytes.toString("utf8"));
  const stationLineInput = JSON.parse(resolvedStationLineInputBytes.toString("utf8"));
  const materialization = materializeStationLineAccessibilityImpl({ ...stationLineInput, observedAt: evaluationAt });
  const evaluation = evaluateRouteAccessibilityEdgesImpl(
    { ...routeEdgeInput, evaluationAt, materialization },
    JSON.parse(policyBytes.toString("utf8")),
  );
  const evaluationBytes = Buffer.from(canonicalRouteEdgeEvaluationJsonImpl(evaluation));
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, evaluationBytes, { flag: "wx", mode: 0o600 });
  await rename(temporaryPath, outputPath);
  return evaluationBytes;
}

export async function runCurrentCapitalLiveChain({ repositoryRoot, runnerTemp, repository, repositorySha, operationId, transferObservationDirectory, transferReceiptPath, handoffDirectory, retainedExitBundle = undefined, retainedExitBundleSha256 = undefined, env = process.env, execFileImpl = execFile, clock = () => new Date(), assertCurrentTopologyAdmissionImpl = assertCurrentStaticNetworkTopologyAdmission, assertCurrentFacilityAdmissionImpl = assertCurrentCapitalFacilityAdmission, rebindPublicRouteMapImpl = rebindCurrentActivePublicRouteMapMaterialization, rebindTransferImpl = rebindCurrentLiveChainTransferDerivedIdentities, rebindFacilityImpl = rebindCurrentActiveFacilityDerivedIdentity, publishImpl = publishCurrentKricExitProviderOciPlan }) {
  if (repository !== "AquilaXk/easysubway-data") throw new Error("repository identity mismatch");
  if (![repositoryRoot, runnerTemp, transferObservationDirectory, transferReceiptPath, handoffDirectory].every((value) => path.isAbsolute(value ?? ""))) throw new Error("current live-chain paths must be absolute");
  requiredSha(repositorySha); requiredOperation(operationId);
  const root = path.resolve(repositoryRoot);
  await requireRealDirectory(path.resolve(runnerTemp), "runner temp");
  await requireRealDirectory(path.dirname(path.resolve(handoffDirectory)), "handoff parent");
  await requireAbsent(path.resolve(handoffDirectory), "handoff directory");
  if ((retainedExitBundle === undefined) !== (retainedExitBundleSha256 === undefined)) throw new Error("retained EXIT bundle arguments must be paired");
  if (retainedExitBundle !== undefined && (!path.isAbsolute(retainedExitBundle) || !/^[a-f0-9]{64}$/u.test(retainedExitBundleSha256))) throw new Error("retained EXIT bundle identity mismatch");
  if (retainedExitBundle === undefined && (typeof env.KRIC_SERVICE_KEY !== "string" || env.KRIC_SERVICE_KEY === "")) throw new Error("KRIC service key is required");
  requireCurrentCapitalLiveChainOciParBaseUrl(env);
  const [{ stdout: origin }, { stdout: head }, { stdout: main }, { stdout: branch }, { stdout: dirty }] = await Promise.all([
    execFileImpl("git", ["remote", "get-url", "origin"], { cwd: root }),
    execFileImpl("git", ["rev-parse", "HEAD"], { cwd: root }),
    execFileImpl("git", ["rev-parse", "origin/main"], { cwd: root }),
    execFileImpl("git", ["branch", "--show-current"], { cwd: root }),
    execFileImpl("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root }),
  ]);
  if (!new Set([DATA_MAIN_REMOTE, "git@github.com:AquilaXk/easysubway-data.git"]).has(origin.trim()) || head.trim() !== repositorySha || main.trim() !== repositorySha || branch.trim() !== "main" || dirty !== "") throw new Error("exact clean main preflight failed");
  await assertRemoteMain({ root, repositorySha, execFileImpl });
  let currentCandidate;
  try { currentCandidate = JSON.parse(await readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8")); } catch { throw new Error("current candidate JSON mismatch"); }
  const transferStageInputs = currentLiveChainTransferStageInputs(currentCandidate, root);
  const candidateStageInputs = await resolveCurrentLiveChainCandidateStageInputs(currentCandidate, root);
  const stagedRoot = await mkdtemp(path.join(path.resolve(runnerTemp), "current-capital-live-chain-"));
  for (const relative of new Set([...STAGED_INPUTS, ...transferStageInputs, ...candidateStageInputs])) {
    const source = path.join(root, relative); const destination = path.join(stagedRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await cp(source, destination, { recursive: true, force: false, verbatimSymlinks: true, filter: (candidate) => stagedCopyAllowed(root, candidate) });
  }
  await rebindPublicRouteMapImpl({ repositoryRoot: stagedRoot });
  await rebindTransferImpl({ repositoryRoot: stagedRoot, observationDirectory: transferObservationDirectory, receiptPath: transferReceiptPath });
  await rebindFacilityImpl({ repositoryRoot: stagedRoot });
  const currentKricExitPlanInputs = await resolveCurrentKricExitPlanInputs(stagedRoot);
  const [stagedCandidate, stagedInventory, stagedSnapshotLedger] = await Promise.all([
    readFile(path.join(stagedRoot, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(stagedRoot, "tools/datapack/source-inventory.json"), "utf8").then(JSON.parse),
    readFile(path.join(stagedRoot, "tools/datapack/release/source-snapshots.json"), "utf8").then(JSON.parse),
  ]);
  const incheonTopologyRelativePath = resolveStagedIncheonTopologyPath(stagedInventory);
  const outputPaths = currentCapitalLiveChainOutputPaths({ candidate: stagedCandidate, sourceInventory: stagedInventory, sourceSnapshotLedger: stagedSnapshotLedger });
  const plan = buildCurrentCapitalLiveChainPlan({ repositoryRoot: root, repositorySha, operationId, stagedRoot, transferObservationDirectory, transferReceiptPath, incheonTopologyRelativePath, ...currentKricExitPlanInputs, outputPaths });
  const buildExitPlan = plan.steps.find((entry) => entry.id === "build-exit-plan");
  await execFileImpl(process.execPath, [buildExitPlan.script, ...buildExitPlan.args], { cwd: root, env: { ...narrowRunnerEnv(env), RUNNER_TEMP: stagedRoot } });
  const operationNow = clock();
  if (!(operationNow instanceof Date) || Number.isNaN(operationNow.valueOf())) throw new Error("current live-chain operation clock mismatch");
  await assertCurrentTopologyAdmissionImpl({ repositoryRoot: stagedRoot, now: operationNow });
  await assertCurrentFacilityAdmissionImpl({ stagedRoot, now: operationNow });
  await assertRemoteMain({ root, repositorySha, execFileImpl });
  const currentPlan = await readRegularSnapshot(path.join(stagedRoot, "current-kric-exit-plan.json"), "current EXIT plan");
  let snapshotBytes;
  let snapshot;
  let collectionBundleBytes;
  if (retainedExitBundle === undefined) {
    const collectExit = plan.steps.find((entry) => entry.id === "collect-kric-exit");
    await execFileImpl(process.execPath, [collectExit.script, ...collectExit.args], { cwd: root, env: { ...narrowRunnerEnv(env), RUNNER_TEMP: stagedRoot, KRIC_SERVICE_KEY: env.KRIC_SERVICE_KEY } });
    const bindExit = plan.steps.find((entry) => entry.id === "bind-exit-collection");
    await execFileImpl(process.execPath, [bindExit.script, ...bindExit.args], { cwd: root, env: { ...narrowRunnerEnv(env), RUNNER_TEMP: stagedRoot } });
    snapshotBytes = await readFile(path.join(stagedRoot, "current-kric-exit-snapshot.json"));
    snapshot = JSON.parse(snapshotBytes.toString("utf8"));
    collectionBundleBytes = await readFile(path.join(stagedRoot, "current-kric-exit-collection-bundle.json"));
  } else {
    const recovered = await recoverCurrentKricExitCollection({
      retainedExitBundle, expectedRetainedExitBundleSha256: retainedExitBundleSha256,
      currentPlanBytes: currentPlan.bytes, repository, repositorySha, operationId,
      operationNow, root, execFileImpl,
    });
    snapshotBytes = recovered.snapshotBytes;
    snapshot = recovered.snapshot;
    collectionBundleBytes = recovered.collectionBundleBytes;
    await writeFile(path.join(stagedRoot, "current-kric-exit-snapshot.json"), snapshotBytes, { flag: "wx", mode: 0o600 });
    await writeFile(path.join(stagedRoot, "current-kric-exit-collection-bundle.json"), collectionBundleBytes, { flag: "wx", mode: 0o600 });
  }
  const derivationAt = resolveCurrentExitDerivationAt({ retainedExitBundle, providerCapturedAt: snapshot.capturedAt, operationNow });
  const admissionStep = plan.steps.find((entry) => entry.id === "admit-exit");
  const admissionArgs = admissionStep.args.map((value) => value === "FROM_PROVIDER_CAPTURED_AT" ? derivationAt : value);
  await execFileImpl(process.execPath, [admissionStep.script, ...admissionArgs], { cwd: root, env: { ...narrowRunnerEnv(env), RUNNER_TEMP: stagedRoot } });
  await replaceStagedFile({ from: path.join(stagedRoot, "current-exit-admission", "exit-path-normalized-source-snapshot.json"), to: path.join(stagedRoot, "tools/datapack/release/current-exit-admission-v2/exit-path-normalized-source-snapshot.json") });
  await replaceStagedFile({ from: path.join(stagedRoot, "current-exit-admission", "exit-path-source-admission.json"), to: path.join(stagedRoot, "tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json") });
  const normalizedBytes = await readFile(path.join(stagedRoot, "tools/datapack/release/current-exit-admission-v2/exit-path-normalized-source-snapshot.json"));
  const admissionBytes = await readFile(path.join(stagedRoot, "tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json"));
  const providerObject = buildCurrentCapitalLiveChainProviderObject({ mainSha: repositorySha, operationId, providerCollectionBundleBytes: collectionBundleBytes, providerCapturedAt: snapshot.capturedAt });
  const exitReceipt = buildCurrentExitAdmissionOciReceipt({ repository, mainSha: repositorySha, operationId, providerCapturedAt: snapshot.capturedAt, providerCollectionBundleBytes: collectionBundleBytes, providerObjectUri: providerObject.ociUri, providerObjectSha256: providerObject.sha256, providerObjectByteSize: providerObject.sizeBytes, normalizedBytes, admissionBytes });
  await writeFile(path.join(stagedRoot, "tools/datapack/release/current-exit-admission-v2/exit-path-admission-oci-receipt.json"), `${canonicalCurrentExitAdmissionOciReceiptJson(exitReceipt)}\n`, { flag: "w", mode: 0o600 });
  const boundaryBytes = await buildFanInBoundaryBytes(stagedRoot);
  await buildCurrentCapitalRouteEdgeInput([], {
    repositoryRoot: stagedRoot,
    readCurrentFanInBoundaryImpl: readCurrentCapitalLiveChainFanInBoundary,
    log: () => {},
  });
  await evaluateStagedRoutePolicy({ stagedRoot, evaluationAt: derivationAt });
  const bundle = await buildCurrentCapitalLiveChainBundle({ root, outputDirectory: stagedRoot, repository, repositorySha, operationId, boundaryBytes });
  await writeFile(path.join(stagedRoot, "current-capital-live-chain-bundle.json"), bundle, { flag: "wx", mode: 0o600 });
  const ociPlan = buildCurrentKricExitProviderOciPlan({ mainSha: repositorySha, operationId, providerCollectionBundleBytes: collectionBundleBytes, providerCapturedAt: snapshot.capturedAt });
  const ociPlanBytes = Buffer.from(`${canonicalCurrentKricExitProviderOciPlanJson(ociPlan)}\n`);
  const ociPlanPath = path.join(stagedRoot, CURRENT_CAPITAL_EXIT_PROVIDER_OCI_PLAN);
  const externalReceiptPath = path.join(stagedRoot, CURRENT_CAPITAL_EXIT_PROVIDER_OCI_RECEIPT);
  await writeFile(ociPlanPath, ociPlanBytes, { flag: "wx", mode: 0o600 });
  const ociEnv = narrowOciEnv(env);
  await publishImpl({ planBytes: ociPlanBytes, root: stagedRoot, receiptPath: externalReceiptPath, env: ociEnv });
  const externalReceiptBytes = await readFile(externalReceiptPath);
  const sourceHandoff = buildCurrentCapitalExitProviderSourceHandoffFromProviderOci({
    providerOciPlanBytes: ociPlanBytes, providerOciReceiptBytes: externalReceiptBytes,
    fetchedProviderCollectionBundleBytes: collectionBundleBytes, repository, repositorySha, operationId,
  });
  const handoffRoot = path.resolve(handoffDirectory);
  await writeFile(path.join(handoffRoot, CURRENT_CAPITAL_EXIT_PROVIDER_OCI_PLAN), ociPlanBytes, { flag: "wx", mode: 0o600 });
  await writeFile(path.join(handoffRoot, CURRENT_CAPITAL_EXIT_PROVIDER_OCI_RECEIPT), externalReceiptBytes, { flag: "wx", mode: 0o600 });
  await writeFile(path.join(handoffRoot, CURRENT_CAPITAL_EXIT_PROVIDER_SOURCE_RECEIPT), `${canonicalCurrentCapitalExitProviderSourceHandoffJson(sourceHandoff)}\n`, { flag: "wx", mode: 0o600 });
  return { stagedRoot, handoffDirectory: handoffRoot, plan, bundleSha256: JSON.parse(bundle).bundleSha256, providerCollectionBundleSha256: ociPlan.providerObject.sha256, sourceHandoff, ociPlan };
}

/**
 * Consume one immutable EXIT provider object on the validated FACILITY branch.
 * The caller owns constructing the target EXIT plan and the admission/fan-in
 * materialization; this function owns the protected ordering and verifies that
 * neither provider collection nor an OCI write can occur on the consumer path.
 */
export async function runCurrentCapitalExitTerminalConsumer({
  repositoryRoot,
  sourceMainRoot,
  sourceMainGitSha,
  privateBuilderRoot,
  builderGitSha,
  topologyBuild,
  topologyHandoffBytes,
  accessibilitySourceHandoffBytes,
  runnerTemp,
  repository,
  candidateOperationId,
  operationNow,
  sourceReceiptBytes,
  providerOciPlanBytes,
  providerOciReceiptBytes,
  reboundOutputPath = CURRENT_CAPITAL_EXIT_PROVIDER_REBOUND_BUNDLE,
  client,
  isAncestor,
  transferObservationDirectory,
  transferReceiptPath,
  env = process.env,
  execFileImpl = execFile,
  rebindPublicRouteMapImpl = rebindCurrentActivePublicRouteMapMaterialization,
  rebindTransferImpl = rebindCurrentLiveChainTransferDerivedIdentities,
  rebindFacilityImpl = rebindCurrentActiveFacilityDerivedIdentity,
  verifyTerminalLineageImpl = verifyCurrentCapitalTerminalLineage,
  verifyTopologyHandoffImpl = validateCurrentCapitalTopologyTerminalHandoff,
  verifyAccessibilityHandoffImpl = verifyCurrentCapitalAccessibilitySourceHandoff,
  commitTerminalManifestImpl = commitCurrentCapitalTerminalManifest,
} = {}) {
  if (repository !== "AquilaXk/easysubway-data") throw new Error("repository identity mismatch");
  if (![repositoryRoot, sourceMainRoot, privateBuilderRoot, runnerTemp, transferObservationDirectory, transferReceiptPath].every((value) => path.isAbsolute(value ?? ""))
    || !Buffer.isBuffer(topologyHandoffBytes) || !Buffer.isBuffer(accessibilitySourceHandoffBytes)
    || !(operationNow instanceof Date) || Number.isNaN(operationNow.valueOf())) {
    throw new Error("terminal consumer inputs mismatch");
  }
  [sourceMainGitSha, builderGitSha].forEach(requiredSha);
  if (typeof verifyTerminalLineageImpl !== "function" || typeof verifyTopologyHandoffImpl !== "function"
    || typeof commitTerminalManifestImpl !== "function") throw new Error("terminal consumer transaction collaborators are required");
  if (typeof isAncestor !== "function") throw new Error("terminal consumer ancestry is required");
  const root = path.resolve(repositoryRoot);
  await requireRealDirectory(root, "terminal candidate repository root");
  await requireRealDirectory(path.resolve(runnerTemp), "terminal runner temp");
  const preflight = await terminalCandidatePreflight(root, execFileImpl);
  const candidateRootSha = preflight.headSha;
  const preparedTerminal = await verifyTerminalLineageImpl({
    sourceMainRoot: path.resolve(sourceMainRoot), retainedRoot: root, privateBuilderRoot: path.resolve(privateBuilderRoot),
    sourceMainGitSha, facilityHeadGitSha: candidateRootSha, builderGitSha, topologyBuild, execFileImpl,
  });
  if (!preparedTerminal?.proof || !Array.isArray(preparedTerminal.topologyInputs)
    || !Array.isArray(preparedTerminal.topologyOutputs)) {
    throw new Error("terminal consumer lineage preparation mismatch");
  }
  const topologyHandoff = verifyTopologyHandoffImpl(topologyHandoffBytes, {
    repository,
    sourceMainGitSha,
    facilityBranch: preflight.branch,
    facilityHeadGitSha: candidateRootSha,
    builderGitSha,
    topologyBuild,
    proof: preparedTerminal.proof,
  });
  const [currentCandidate, candidateStageInputs] = await Promise.all([
    readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse)
      .then((candidate) => resolveCurrentLiveChainCandidateStageInputs(candidate, root)),
  ]);
  const accessibilitySourceHandoff = await verifyAccessibilityHandoffImpl({
    handoffBytes: accessibilitySourceHandoffBytes,
    retainedRoot: root,
    preparedRoot: path.resolve(privateBuilderRoot),
    expected: {
      repository,
      operationId: topologyHandoff.operationId,
      sourceMainGitSha,
      facilityBranch: preflight.branch,
      facilityHeadGitSha: candidateRootSha,
      protectedCandidateId: currentCandidate.candidateId,
    },
  });
  const accessibilityIdentity = topologyHandoff.accessibilitySourceHandoff;
  if (accessibilitySourceHandoff.handoffSha256 !== accessibilityIdentity?.handoffSha256
    || accessibilitySourceHandoff.operationId !== accessibilityIdentity?.operationId
    || accessibilitySourceHandoff.providerStartedAt !== accessibilityIdentity?.providerStartedAt
    || accessibilitySourceHandoff.operationNow !== accessibilityIdentity?.operationNow
    || accessibilitySourceHandoff.protectedCandidateId !== accessibilityIdentity?.protectedCandidateId
    || requiredOffsetInstantMillis(accessibilitySourceHandoff.operationNow, "accessibility source operation now")
      > operationNow.valueOf()) {
    throw new Error("terminal accessibility source identity mismatch");
  }
  const transferStageInputs = currentLiveChainTransferStageInputs(currentCandidate, root);
  const stagedRoot = await mkdtemp(path.join(path.resolve(runnerTemp), "current-capital-exit-terminal-"));
  // Terminal refresh needs the currently committed output bytes and both
  // markers as CAS prestates.  They never leave this isolated staging root.
  for (const relative of new Set([...STAGED_INPUTS, ...transferStageInputs, ...candidateStageInputs])) {
    const source = path.join(root, relative); const destination = path.join(stagedRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await cp(source, destination, { recursive: true, force: false, verbatimSymlinks: true,
      filter: (entry) => stagedCopyAllowed(root, entry, []) });
  }
  for (const { relativePath, operation } of accessibilitySourceHandoff.outputs) {
    requiredRelativePath(relativePath, "terminal accessibility source output");
    const bytes = await readStagedRegularFile(path.resolve(privateBuilderRoot), relativePath, "prepared accessibility source output");
    const destination = path.join(stagedRoot, relativePath);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes.bytes, { flag: operation === "create" ? "wx" : "w", mode: 0o600 });
  }
  for (const { relativePath, bytes } of preparedTerminal.topologyInputs) {
    requiredRelativePath(relativePath, "terminal topology input");
    if (!Buffer.isBuffer(bytes)) throw new Error("terminal topology input bytes mismatch");
    const destination = path.join(stagedRoot, relativePath);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  }
  for (const { relativePath, bytes } of preparedTerminal.topologyOutputs) {
    requiredRelativePath(relativePath, "terminal topology output");
    if (!Buffer.isBuffer(bytes)) throw new Error("terminal topology output bytes mismatch");
    const destination = path.join(stagedRoot, relativePath);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { flag: "w", mode: 0o600 });
  }
  await verifyPreparedTopologyStage(stagedRoot, preparedTerminal.proof);
  await rebindPublicRouteMapImpl({ repositoryRoot: stagedRoot });
  const transferRebind = await rebindTransferImpl({ repositoryRoot: stagedRoot, observationDirectory: transferObservationDirectory, receiptPath: transferReceiptPath });
  const allowedPredecessorSourceIds = accessibilitySourceHandoff.sources
    .filter(({ action }) => action === "REFRESH")
    .map(({ sourceId }) => sourceId)
    .sort();
  await rebindFacilityImpl({
    repositoryRoot: stagedRoot,
    replaceExistingSuccessor: true,
    allowedPredecessorSourceIds,
  });
  // This create-once transaction is the boundary between P/T/F materialization
  // and every candidate-dependent EXIT/fan-in operation.  All later inputs are
  // read from its committed staged bytes.
  await rebindCurrentCandidateSourceSnapshots({ repositoryRoot: stagedRoot, now: operationNow });
  const currentKricExitPlanInputs = await resolveCurrentKricExitPlanInputs(stagedRoot);
  const [stagedCandidate, stagedInventory, stagedSnapshotLedger] = await Promise.all([
    readFile(path.join(stagedRoot, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(stagedRoot, "tools/datapack/source-inventory.json"), "utf8").then(JSON.parse),
    readFile(path.join(stagedRoot, "tools/datapack/release/source-snapshots.json"), "utf8").then(JSON.parse),
  ]);
  const incheonTopologyRelativePath = resolveStagedIncheonTopologyPath(stagedInventory);
  const outputPaths = currentCapitalLiveChainOutputPaths({ candidate: stagedCandidate, sourceInventory: stagedInventory, sourceSnapshotLedger: stagedSnapshotLedger });
  const plan = buildCurrentCapitalLiveChainPlan({
    repositoryRoot: root, repositorySha: candidateRootSha, operationId: candidateOperationId,
    stagedRoot, transferObservationDirectory, transferReceiptPath, incheonTopologyRelativePath,
    ...currentKricExitPlanInputs, outputPaths,
  });
  const buildExitPlan = plan.steps.find((entry) => entry.id === "build-exit-plan");
  await execFileImpl(process.execPath, [buildExitPlan.script, ...buildExitPlan.args], {
    cwd: root, env: { ...narrowRunnerEnv(env), RUNNER_TEMP: stagedRoot },
  });
  await assertCurrentStaticNetworkTopologyAdmission({ repositoryRoot: stagedRoot, now: operationNow });
  await assertCurrentCapitalFacilityAdmission({ stagedRoot, now: operationNow });
  const targetPlan = await readRegularSnapshot(path.join(stagedRoot, "current-kric-exit-plan.json"), "terminal EXIT plan");
  const recoveryClient = client ?? preauthenticatedObjectStorageClient(
    requireCurrentCapitalLiveChainOciParBaseUrl(env), { includeErrorBody: false },
  );
  const recovered = await recoverCurrentCapitalExitProviderCandidate({
    sourceReceiptBytes, providerOciPlanBytes, providerOciReceiptBytes,
    targetPlanBytes: targetPlan.bytes, candidateOperationId, operationNow, preflight,
    reboundOutputPath, client: recoveryClient,
    isAncestor,
  });
  if (recovered.providerCalls !== 0 || recovered.ociPutCalls !== 0) throw new Error("terminal consumer provider boundary mismatch");
  if (topologyHandoff.operationId !== recovered.sourceReceipt.sourceOperationId) {
    throw new Error("topology and EXIT source operation mismatch");
  }
  const reboundBundlePath = path.join(stagedRoot, reboundOutputPath);
  await writeFile(reboundBundlePath, recovered.reboundBundleBytes, { flag: "wx", mode: 0o600 });
  const recoveredBundle = JSON.parse(recovered.reboundBundleBytes.toString("utf8"));
  const recoveredSnapshotBytes = Buffer.from(recoveredBundle.providerSnapshotJson);
  await writeFile(path.join(stagedRoot, "current-kric-exit-snapshot.json"), recoveredSnapshotBytes, { flag: "wx", mode: 0o600 });
  await writeFile(path.join(stagedRoot, CURRENT_CAPITAL_EXIT_PROVIDER_CANDIDATE_RECEIPT),
    `${canonicalCurrentCapitalExitProviderCandidateHandoffJson(recovered.candidateReceipt)}\n`, { flag: "wx", mode: 0o600 });
  const admissionStep = plan.steps.find((entry) => entry.id === "admit-exit");
  const derivationAt = recovered.candidateReceipt.providerCapturedAt;
  const admissionArgs = admissionStep.args.map((value) => value === "FROM_PROVIDER_CAPTURED_AT" ? derivationAt : value);
  await execFileImpl(process.execPath, [admissionStep.script, ...admissionArgs], {
    cwd: root, env: { ...narrowRunnerEnv(env), RUNNER_TEMP: stagedRoot },
  });
  await replaceStagedFile({ from: path.join(stagedRoot, "current-exit-admission", "exit-path-normalized-source-snapshot.json"), to: path.join(stagedRoot, "tools/datapack/release/current-exit-admission-v2/exit-path-normalized-source-snapshot.json") });
  await replaceStagedFile({ from: path.join(stagedRoot, "current-exit-admission", "exit-path-source-admission.json"), to: path.join(stagedRoot, "tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json") });
  const [normalizedBytes, admissionBytes] = await Promise.all([
    readFile(path.join(stagedRoot, "tools/datapack/release/current-exit-admission-v2/exit-path-normalized-source-snapshot.json")),
    readFile(path.join(stagedRoot, "tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json")),
  ]);
  const providerObject = recovered.sourceReceipt.providerObject;
  const exitReceipt = buildCurrentExitReboundAdmissionOciReceipt({
    repository,
    sourceMainSha: recovered.sourceReceipt.sourceMainSha,
    sourceOperationId: recovered.sourceReceipt.sourceOperationId,
    candidateHeadSha: candidateRootSha,
    candidateOperationId,
    providerCapturedAt: derivationAt,
    providerCollectionBundleBytes: recovered.fetchedProviderCollectionBundleBytes,
    providerObjectUri: providerObject.ociUri,
    providerObjectSha256: providerObject.sha256,
    providerObjectByteSize: providerObject.sizeBytes,
    sourceReceiptSha256: recovered.sourceReceipt.receiptSha256,
    candidateReceiptSha256: recovered.candidateReceipt.receiptSha256,
    reboundCollectionBundleBytes: recovered.reboundBundleBytes,
    normalizedBytes,
    admissionBytes,
  });
  await writeFile(path.join(stagedRoot, "tools/datapack/release/current-exit-admission-v2/exit-path-admission-oci-receipt.json"),
    `${canonicalCurrentExitReboundAdmissionOciReceiptJson(exitReceipt)}\n`, { flag: "w", mode: 0o600 });
  const proposedOutputs = await buildCurrentCapitalAccessibilityRefreshOutputs({
    repositoryRoot: stagedRoot,
    transferRebindOutputs: transferRebind?.outputs,
  });
  const proposedByPath = new Map([
    ...proposedOutputs.map(({ relative, bytes }) => [relative, bytes]),
    [proposedOutputs[0].fanIn.relative, proposedOutputs[0].fanIn.bytes],
  ]);
  await evaluateStagedRoutePolicy({
    stagedRoot,
    evaluationAt: derivationAt,
    routeEdgeInputBytes: proposedByPath.get("tools/datapack/release/current-capital-accessibility-full/route-edge-input.json"),
    stationLineInputBytes: proposedByPath.get("tools/datapack/release/current-capital-accessibility-full/station-line-input.json"),
  });
  const refresh = await refreshCurrentCapitalAccessibilityFull({
    repositoryRoot: stagedRoot,
    transferRebindOutputs: transferRebind?.outputs,
  });
  if (!refresh || JSON.stringify(refresh.outputs) !== JSON.stringify([
    "tools/datapack/release/current-capital-accessibility-full/station-line-input.json",
    "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json",
    CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_PATH,
  ])) throw new Error("terminal consumer refresh transaction mismatch");
  const markerPaths = [
    "tools/datapack/release/current-capital-accessibility-transition.json",
    "tools/datapack/release/current-capital-accessibility-transition-successor.json",
  ];
  const validation = await validateCurrentCapitalLiveChainMaterialization({
    outputDirectory: stagedRoot,
    repository,
    repositorySha: candidateRootSha,
    operationId: candidateOperationId,
    boundaryBytes: await readFile(path.join(stagedRoot, CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_PATH)),
  });
  if (JSON.stringify(validation.outputPaths) !== JSON.stringify(outputPaths)) {
    throw new Error("terminal consumer post-CAS output identity mismatch");
  }
  const boundaryBytes = await readFile(path.join(stagedRoot, CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_PATH));
  const materialization = Object.freeze({
    repository, repositorySha: candidateRootSha, operationId: candidateOperationId,
    entries: await Promise.all(validation.outputPaths.map(async (entryPath) => ({
      path: entryPath,
      sha256: sha256((await readStagedRegularFile(stagedRoot, entryPath, `terminal materialization ${entryPath}`)).bytes),
    }))),
    fanIn: { path: CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_PATH, sha256: sha256(boundaryBytes) },
  });
  const topologyInputs = preparedTerminal.proof.topologyInputs?.map(({ relativePath }) => relativePath);
  const topologyOutputs = preparedTerminal.proof.topologyOutputs?.map(({ relativePath }) => relativePath);
  if (!Array.isArray(topologyInputs) || !Array.isArray(topologyOutputs)) throw new Error("terminal consumer lineage proof mismatch");
  const replacementPaths = [...new Set([
    ...accessibilitySourceHandoff.outputs.map(({ relativePath }) => relativePath),
    ...topologyInputs, ...topologyOutputs, ...outputPaths, CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_PATH,
  ])].sort(codepointCompare);
  const createOnce = new Set([
    ...accessibilitySourceHandoff.outputs.filter(({ operation }) => operation === "create").map(({ relativePath }) => relativePath),
    ...topologyInputs,
    ...topologyOutputs.filter((relative) => /^tools\/datapack\/release\/capital-topology-reverification-[0-9]{8}\.json$/u.test(relative)),
  ]);
  const replacementPrestates = new Map(preparedTerminal.proof.replacementPrestates?.map((entry) => [entry.relativePath, entry.sha256]));
  if (JSON.stringify([...replacementPrestates.keys()].sort(codepointCompare))
    !== JSON.stringify([...new Set([...topologyOutputs, ...outputPaths, CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_PATH])]
      .filter((relative) => !createOnce.has(relative)).sort(codepointCompare))) {
    throw new Error("terminal consumer replacement prestate proof mismatch");
  }
  const accessibilityPrestates = new Map(accessibilitySourceHandoff.outputs
    .filter(({ operation }) => operation === "replace").map(({ relativePath, beforeSha256 }) => [relativePath, beforeSha256]));
  const terminalOutputs = await Promise.all(replacementPaths.map(async (relative) => {
    const staged = await readStagedRegularFile(stagedRoot, relative, `terminal staged ${relative}`);
    const prestate = createOnce.has(relative) ? null : await readStagedRegularFile(root, relative, `terminal retained ${relative}`);
    const expectedPrestate = replacementPrestates.get(relative) ?? accessibilityPrestates.get(relative);
    if (prestate != null && sha256(prestate.bytes) !== expectedPrestate) {
      throw new Error("terminal consumer replacement prestate mismatch");
    }
    return { relative, bytes: staged.bytes, prestate };
  }));
  const [marker, successor] = await Promise.all(markerPaths.map((relative) => readStagedRegularFile(root, relative, `terminal retained ${relative}`)));
  const manifest = {
    accessibilitySourceHandoff,
    topologyInputs, topologyOutputs, liveChainOutputs: outputPaths,
    fanInPath: CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_PATH, markerPaths, replacementPaths,
    proof: preparedTerminal.proof, materialization,
  };
  const commitResult = await commitTerminalManifestImpl({ repositoryRoot: root, manifest, outputs: terminalOutputs, marker, successor });
  const finalRoot = commitResult?.repositoryRoot == null ? root : path.resolve(commitResult.repositoryRoot);
  await validateCurrentCapitalLiveChainMaterialization({
    outputDirectory: finalRoot, repository, repositorySha: candidateRootSha, operationId: candidateOperationId,
    boundaryBytes: await readFile(path.join(finalRoot, CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_PATH)),
  });
  for (const relative of markerPaths) await requireAbsent(path.join(finalRoot, relative), "terminal consumer marker");
  return Object.freeze({
    providerCalls: 0,
    ociGetCalls: 1,
    ociPutCalls: 0,
    candidateReceipt: recovered.candidateReceipt,
    stagedRoot: finalRoot,
    outputPaths,
    fanInPath: CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_PATH,
    deletedMarkerPaths: Object.freeze(markerPaths),
    replacementPaths: Object.freeze(replacementPaths),
  });
}

async function terminalCandidatePreflight(root, execFileImpl = execFile) {
  const run = async (args) => String((await execFileImpl("git", args, { cwd: root })).stdout).trim();
  const [origin, branch, headSha, upstream, remoteHeadSha, dirty] = await Promise.all([
    run(["remote", "get-url", "origin"]), run(["branch", "--show-current"]), run(["rev-parse", "HEAD"]),
    run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
    run(["rev-parse", "@{upstream}"]), run(["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  if (!new Set([DATA_MAIN_REMOTE, "git@github.com:AquilaXk/easysubway-data.git"]).has(origin)
    || branch === "" || branch === "main" || upstream !== `origin/${branch}` || headSha !== remoteHeadSha || dirty !== "") {
    throw new Error("exact clean remote non-main terminal preflight failed");
  }
  return { origin, branch, headSha, upstream, remoteHeadSha, clean: true };
}

/**
 * Produce the immutable KRIC EXIT source object from exact clean main.  This
 * deliberately stops before the FACILITY-dependent fan-in and the canonical
 * output transaction: those are terminal-consumer responsibilities on the
 * validated FACILITY branch.  Keeping the boundary here makes it impossible
 * for the provider operation to mutate a candidate output.
 */
export async function runCurrentCapitalExitOnlyProducer({
  repositoryRoot,
  retainedRoot,
  privateBuilderRoot,
  builderGitSha,
  topologyBuild,
  runnerTemp,
  repository,
  repositorySha,
  operationId,
  handoffDirectory,
  facilityPullRequest,
  accessibilitySourceHandoff,
  env = process.env,
  execFileImpl = execFile,
  clock = () => new Date(),
  assertCurrentTopologyAdmissionImpl = assertCurrentStaticNetworkTopologyAdmission,
  publishImpl = publishCurrentKricExitProviderOciPlan,
  verifyTerminalLineageImpl = verifyCurrentCapitalTerminalLineage,
  buildTopologyHandoffImpl = buildCurrentCapitalTopologyTerminalHandoff,
}) {
  if (repository !== "AquilaXk/easysubway-data") throw new Error("repository identity mismatch");
  if (!facilityPullRequest || facilityPullRequest.repository !== repository
    || !/^automation\/629-kric-facility-refresh-[0-9]+$/u.test(facilityPullRequest.branch ?? "")
    || !/^[a-f0-9]{40}$/u.test(facilityPullRequest.headSha ?? "")) {
    throw new Error("validated same-repository FACILITY pull request is required");
  }
  if (![repositoryRoot, retainedRoot, privateBuilderRoot, runnerTemp, handoffDirectory]
    .every((value) => path.isAbsolute(value ?? ""))) throw new Error("EXIT-only producer paths must be absolute");
  requiredSha(repositorySha); requiredSha(builderGitSha); requiredOperation(operationId);
  if (typeof verifyTerminalLineageImpl !== "function" || typeof buildTopologyHandoffImpl !== "function") {
    throw new Error("EXIT-only producer lineage collaborators are required");
  }
  if (typeof env.KRIC_SERVICE_KEY !== "string" || env.KRIC_SERVICE_KEY === "") throw new Error("KRIC service key is required");
  requireCurrentCapitalLiveChainOciParBaseUrl(env);
  const root = path.resolve(repositoryRoot);
  await requireRealDirectory(path.resolve(runnerTemp), "runner temp");
  await requireRealDirectory(path.dirname(path.resolve(handoffDirectory)), "handoff parent");
  await requireAbsent(path.resolve(handoffDirectory), "handoff directory");
  const [{ stdout: origin }, { stdout: head }, { stdout: main }, { stdout: branch }, { stdout: dirty }] = await Promise.all([
    execFileImpl("git", ["remote", "get-url", "origin"], { cwd: root }),
    execFileImpl("git", ["rev-parse", "HEAD"], { cwd: root }),
    execFileImpl("git", ["rev-parse", "origin/main"], { cwd: root }),
    execFileImpl("git", ["branch", "--show-current"], { cwd: root }),
    execFileImpl("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root }),
  ]);
  if (!new Set([DATA_MAIN_REMOTE, "git@github.com:AquilaXk/easysubway-data.git"]).has(origin.trim()) || head.trim() !== repositorySha || main.trim() !== repositorySha || branch.trim() !== "main" || dirty !== "") throw new Error("exact clean main preflight failed");
  await assertRemoteMain({ root, repositorySha, execFileImpl });
  const facilityRef = `refs/remotes/origin/${facilityPullRequest.branch}`;
  const [{ stdout: facilityHead }, facilityAncestor, { stdout: facilityPaths }] = await Promise.all([
    execFileImpl("git", ["rev-parse", facilityRef], { cwd: root }),
    execFileImpl("git", ["merge-base", "--is-ancestor", repositorySha, facilityPullRequest.headSha], { cwd: root }),
    execFileImpl("git", ["diff", "--name-only", repositorySha, facilityPullRequest.headSha], { cwd: root }),
  ]);
  if (facilityAncestor === undefined || facilityHead.trim() !== facilityPullRequest.headSha) throw new Error("FACILITY pull request remote identity mismatch");
  const requiredFacilityPaths = new Set([
    "tools/datapack/release/candidate-build-spec.json",
    "tools/datapack/release/current-capital-facility-source-admission.json",
    "tools/datapack/release/source-snapshots.json",
    "tools/datapack/source-inventory.json",
    "tools/datapack/release/release-request.json",
    "tools/datapack/release/hash-evidence.json",
  ]);
  const actualFacilityPaths = String(facilityPaths).split("\n").filter(Boolean);
  if (!requiredFacilityPaths.isSubsetOf(new Set(actualFacilityPaths))
    || actualFacilityPaths.some((relative) => !requiredFacilityPaths.has(relative) && !/^tools\/datapack\/sources\/[^/]+\.json$/u.test(relative))) {
    throw new Error("FACILITY pull request path identity mismatch");
  }
  const preparedTerminal = await verifyTerminalLineageImpl({
    sourceMainRoot: root,
    retainedRoot: path.resolve(retainedRoot),
    privateBuilderRoot: path.resolve(privateBuilderRoot),
    sourceMainGitSha: repositorySha,
    facilityHeadGitSha: facilityPullRequest.headSha,
    builderGitSha,
    topologyBuild,
    execFileImpl,
  });
  if (!preparedTerminal?.proof || !Array.isArray(preparedTerminal.topologyInputs)
    || preparedTerminal.topologyInputs.length !== 4 || !Array.isArray(preparedTerminal.topologyOutputs)
    || preparedTerminal.topologyOutputs.length === 0) {
    throw new Error("EXIT-only producer topology lineage mismatch");
  }
  const topologyHandoff = await buildTopologyHandoffImpl({
    repository,
    operationId,
    sourceMainGitSha: repositorySha,
    facilityBranch: facilityPullRequest.branch,
    facilityHeadGitSha: facilityPullRequest.headSha,
    builderGitSha,
    topologyBuild,
    privateBuilderRoot: path.resolve(privateBuilderRoot),
    proof: preparedTerminal.proof,
    accessibilitySourceHandoff,
  });
  let candidate;
  const retained = path.resolve(retainedRoot);
  try { candidate = JSON.parse(await readFile(path.join(retained, "tools/datapack/release/candidate-build-spec.json"), "utf8")); } catch { throw new Error("retained candidate JSON mismatch"); }
  const candidateStageInputs = await resolveCurrentLiveChainCandidateStageInputs(candidate, retained);
  const stagedRoot = await mkdtemp(path.join(path.resolve(runnerTemp), "current-capital-exit-producer-"));
  for (const relative of new Set([...STAGED_INPUTS, ...candidateStageInputs])) {
    const source = path.join(retained, relative); const destination = path.join(stagedRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await cp(source, destination, { recursive: true, force: false, verbatimSymlinks: true, filter: (entry) => stagedCopyAllowed(retained, entry) });
  }
  for (const { relativePath, bytes } of preparedTerminal.topologyInputs) {
    const destination = path.join(stagedRoot, requiredRelativePath(relativePath, "producer topology input"));
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  }
  for (const { relativePath, bytes } of preparedTerminal.topologyOutputs) {
    const destination = path.join(stagedRoot, requiredRelativePath(relativePath, "producer topology output"));
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { flag: "w", mode: 0o600 });
  }
  const currentKricExitPlanInputs = await resolveCurrentKricExitPlanInputs(stagedRoot);
  const stagedInventory = JSON.parse(await readFile(path.join(stagedRoot, "tools/datapack/source-inventory.json"), "utf8"));
  const incheonTopologyRelativePath = resolveStagedIncheonTopologyPath(stagedInventory);
  const plan = buildCurrentCapitalLiveChainPlan({ repositoryRoot: root, repositorySha, operationId, stagedRoot, transferObservationDirectory: path.join(stagedRoot, "unused-transfer-observation"), transferReceiptPath: path.join(stagedRoot, "unused-transfer-receipt.json"), incheonTopologyRelativePath, ...currentKricExitPlanInputs, outputPaths: ["producer-only"] });
  const buildExitPlan = plan.steps.find((entry) => entry.id === "build-exit-plan");
  await execFileImpl(process.execPath, [buildExitPlan.script, ...buildExitPlan.args], { cwd: root, env: { ...narrowRunnerEnv(env), RUNNER_TEMP: stagedRoot } });
  const operationNow = clock();
  if (!(operationNow instanceof Date) || Number.isNaN(operationNow.valueOf())) throw new Error("current live-chain operation clock mismatch");
  await assertCurrentTopologyAdmissionImpl({ repositoryRoot: stagedRoot, now: operationNow });
  await assertRemoteMain({ root, repositorySha, execFileImpl });
  const collectExit = plan.steps.find((entry) => entry.id === "collect-kric-exit");
  await execFileImpl(process.execPath, [collectExit.script, ...collectExit.args], { cwd: root, env: { ...narrowRunnerEnv(env), RUNNER_TEMP: stagedRoot, KRIC_SERVICE_KEY: env.KRIC_SERVICE_KEY } });
  const bindExit = plan.steps.find((entry) => entry.id === "bind-exit-collection");
  await execFileImpl(process.execPath, [bindExit.script, ...bindExit.args], { cwd: root, env: { ...narrowRunnerEnv(env), RUNNER_TEMP: stagedRoot } });
  const [snapshotBytes, collectionBundleBytes] = await Promise.all([
    readFile(path.join(stagedRoot, "current-kric-exit-snapshot.json")), readFile(path.join(stagedRoot, "current-kric-exit-collection-bundle.json")),
  ]);
  const snapshot = JSON.parse(snapshotBytes.toString("utf8"));
  const ociPlan = buildCurrentKricExitProviderOciPlan({ mainSha: repositorySha, operationId, providerCollectionBundleBytes: collectionBundleBytes, providerCapturedAt: snapshot.capturedAt });
  const ociPlanBytes = Buffer.from(`${canonicalCurrentKricExitProviderOciPlanJson(ociPlan)}\n`);
  const receiptPath = path.join(stagedRoot, CURRENT_CAPITAL_EXIT_PROVIDER_OCI_RECEIPT);
  await publishImpl({ planBytes: ociPlanBytes, root: stagedRoot, receiptPath, env: narrowOciEnv(env) });
  const receiptBytes = await readFile(receiptPath);
  const sourceHandoff = buildCurrentCapitalExitProviderSourceHandoffFromProviderOci({ providerOciPlanBytes: ociPlanBytes, providerOciReceiptBytes: receiptBytes, fetchedProviderCollectionBundleBytes: collectionBundleBytes, repository, repositorySha, operationId });
  const handoffRoot = path.resolve(handoffDirectory); await mkdir(handoffRoot, { mode: 0o700 });
  await writeFile(path.join(handoffRoot, CURRENT_CAPITAL_EXIT_PROVIDER_OCI_PLAN), ociPlanBytes, { flag: "wx", mode: 0o600 });
  await writeFile(path.join(handoffRoot, CURRENT_CAPITAL_EXIT_PROVIDER_OCI_RECEIPT), receiptBytes, { flag: "wx", mode: 0o600 });
  await writeFile(path.join(handoffRoot, CURRENT_CAPITAL_EXIT_PROVIDER_SOURCE_RECEIPT), `${canonicalCurrentCapitalExitProviderSourceHandoffJson(sourceHandoff)}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(path.join(handoffRoot, CURRENT_CAPITAL_TOPOLOGY_HANDOFF), `${canonicalJson(topologyHandoff)}\n`, { flag: "wx", mode: 0o600 });
  return Object.freeze({ stagedRoot, handoffDirectory: handoffRoot, ociPlan, sourceHandoff, topologyHandoff, topologyProof: preparedTerminal.proof });
}

export function parseArgs(argv) {
  const required = new Set(["repository-root", "runner-temp", "repository", "repository-sha", "operation-id", "transfer-observation-directory", "transfer-receipt", "handoff-directory"]);
  const allowed = new Set([...required, "retained-exit-bundle", "retained-exit-bundle-sha256"]);
  if (!Array.isArray(argv) || (argv.length !== required.size * 2 && argv.length !== allowed.size * 2)) throw new Error("current live-chain arguments mismatch");
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]?.replace(/^--/u, ""); const value = argv[index + 1];
    if (!allowed.has(flag) || Object.hasOwn(values, flag) || typeof value !== "string" || value === "") throw new Error("current live-chain arguments mismatch");
    values[flag] = value;
  }
  if (["repository-root", "runner-temp", "transfer-observation-directory", "transfer-receipt", "handoff-directory", "retained-exit-bundle"].some((flag) => values[flag] !== undefined && !path.isAbsolute(values[flag]))) throw new Error("current live-chain paths must be absolute");
  if ([...required].some((flag) => values[flag] === undefined)) throw new Error("current live-chain arguments mismatch");
  if ((values["retained-exit-bundle"] === undefined) !== (values["retained-exit-bundle-sha256"] === undefined)
    || (values["retained-exit-bundle-sha256"] !== undefined && !/^[a-f0-9]{64}$/u.test(values["retained-exit-bundle-sha256"]))) {
    throw new Error("retained EXIT bundle arguments mismatch");
  }
  return values;
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv);
  const result = await runCurrentCapitalLiveChain({
    repositoryRoot: args["repository-root"], runnerTemp: args["runner-temp"], repository: args.repository,
    repositorySha: args["repository-sha"], operationId: args["operation-id"],
    transferObservationDirectory: args["transfer-observation-directory"], transferReceiptPath: args["transfer-receipt"],
    handoffDirectory: args["handoff-directory"], retainedExitBundle: args["retained-exit-bundle"], retainedExitBundleSha256: args["retained-exit-bundle-sha256"], ...dependencies,
  });
  (dependencies.log ?? console.log)(JSON.stringify({ result: "PASS", repositorySha: args["repository-sha"], operationId: args["operation-id"], bundleSha256: result.bundleSha256, providerCollectionBundleSha256: result.providerCollectionBundleSha256, handoffDirectory: result.handoffDirectory }));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
