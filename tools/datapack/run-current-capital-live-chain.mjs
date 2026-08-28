#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
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
import { buildCurrentCapitalLiveChainOciPlan, buildCurrentCapitalLiveChainProviderObject, canonicalCurrentCapitalLiveChainOciPlanJson } from "./build-current-capital-live-chain-oci-plan.mjs";
import { canonicalCurrentCapitalFacilitySourceAdmissionJson } from "./build-current-capital-facility-source-admission.mjs";
import { buildCurrentExitAdmissionOciReceipt, canonicalCurrentExitAdmissionOciReceiptJson } from "./build-current-exit-admission-oci-receipt.mjs";
import { buildCurrentKricExitCollectionBundle, buildCurrentKricExitCollectionReceipt, canonicalCurrentKricExitCollectionBundleJson } from "./build-current-kric-exit-collection-receipt.mjs";
import { readRegularSnapshot } from "./build-current-kric-exit-collection-plan.mjs";
import { canonicalKricExitPathProviderSnapshotJson } from "./collect-kric-exit-path-provider-snapshot.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { canonicalKricExitPathCollectionPlanJson } from "./plan-kric-exit-path-collection.mjs";
import { main as buildCurrentCapitalRouteEdgeInput } from "./build-current-capital-route-edge-input.mjs";
import { canonicalRouteEdgeEvaluationJson, evaluateRouteAccessibilityEdges } from "./evaluate-route-accessibility-edges.mjs";
import { extractCurrentCapitalLiveChainDirectory } from "./extract-current-capital-live-chain-directory.mjs";
import { materializeStationLineAccessibility } from "./materialize-station-line-accessibility.mjs";
import { fetchCurrentCapitalLiveChainComposite, publishCurrentCapitalLiveChainOciPlan, requireCurrentCapitalLiveChainOciParBaseUrl } from "./publish-object-storage.mjs";
import { rebindCurrentActiveFacilityDerivedIdentity } from "./rebind-current-active-facility-derived-identity.mjs";
import { rebindCurrentActivePublicRouteMapMaterialization } from "./rebind-current-active-public-route-map-materialization.mjs";
import { currentLiveChainTransferStageInputs, rebindCurrentLiveChainTransferDerivedIdentities } from "./rebind-current-live-chain-transfer-derived-identities.mjs";
import { assertCurrentStaticNetworkTopologyAdmission } from "./register-current-static-network-successors.mjs";

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
  const file = await readStagedRegularFile(
    stagedRoot,
    "tools/datapack/release/current-capital-facility-source-admission.json",
    "current capital facility admission",
  );
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

export async function recoverCurrentKricExitCollection({ retainedExitBundle, expectedRetainedExitBundleSha256, currentPlanBytes, repository, repositorySha, operationId, operationNow, root, execFileImpl }) {
  if (!path.isAbsolute(retainedExitBundle ?? "")) throw new Error("retained EXIT bundle must be absolute");
  if (!/^[a-f0-9]{64}$/u.test(expectedRetainedExitBundleSha256 ?? "")) throw new Error("retained EXIT bundle expected digest mismatch");
  if (!(currentPlanBytes instanceof Uint8Array) || currentPlanBytes.byteLength === 0) throw new Error("current EXIT plan bytes are invalid");
  if (!(operationNow instanceof Date) || Number.isNaN(operationNow.valueOf())) throw new Error("current live-chain operation clock mismatch");
  const retained = await readRegularSnapshot(retainedExitBundle, "retained EXIT bundle");
  if (createHash("sha256").update(retained.bytes).digest("hex") !== expectedRetainedExitBundleSha256) {
    throw new Error("retained EXIT bundle expected digest mismatch");
  }
  let bundle;
  try { bundle = JSON.parse(retained.bytes.toString("utf8")); } catch { throw new Error("retained EXIT bundle JSON mismatch"); }
  let canonicalBundle;
  try { canonicalBundle = canonicalCurrentKricExitCollectionBundleJson(bundle); } catch { throw new Error("retained EXIT bundle is invalid"); }
  if (!retained.bytes.equals(Buffer.from(canonicalBundle))) throw new Error("retained EXIT bundle bytes are not canonical");
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
  await execFileImpl("git", ["merge-base", "--is-ancestor", sourceReceipt.repositorySha, repositorySha], { cwd: root });
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
    { id: "evaluate-route-policy", script: "tools/datapack/evaluate-route-accessibility-edges.mjs", args: ["--input", at("tools/datapack/release/current-capital-accessibility-full/route-edge-input.json"), "--output", at("release/product-gates/route-edge-evaluation-policy.json")] },
    { id: "bundle", script: "tools/datapack/build-current-capital-live-chain-bundle.mjs", args: [] },
  ] };
}

async function replaceStagedFile({ from, to }) {
  await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
  await rename(from, to);
}

function stagedCopyAllowed(repositoryRoot, sourcePath) {
  const relative = path.relative(repositoryRoot, sourcePath).split(path.sep).join("/");
  return !EXCLUDED_STAGED_PATHS.some((excluded) => relative === excluded || relative.startsWith(`${excluded}/`));
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
  materializeStationLineAccessibilityImpl = materializeStationLineAccessibility,
  evaluateRouteAccessibilityEdgesImpl = evaluateRouteAccessibilityEdges,
  canonicalRouteEdgeEvaluationJsonImpl = canonicalRouteEdgeEvaluationJson,
}) {
  const routeEdgeInputPath = path.join(stagedRoot, "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json");
  const stationLineInputPath = path.join(stagedRoot, "tools/datapack/release/current-capital-accessibility-full/station-line-input.json");
  const outputPath = path.join(stagedRoot, "release/product-gates/route-edge-evaluation-policy.json");
  const [routeEdgeInputBytes, stationLineInputBytes, policyBytes] = await Promise.all([
    readFile(routeEdgeInputPath), readFile(stationLineInputPath), readFile(outputPath),
  ]);
  const routeEdgeInput = JSON.parse(routeEdgeInputBytes.toString("utf8"));
  const stationLineInput = JSON.parse(stationLineInputBytes.toString("utf8"));
  const materialization = materializeStationLineAccessibilityImpl({ ...stationLineInput, observedAt: evaluationAt });
  const evaluation = evaluateRouteAccessibilityEdgesImpl(
    { ...routeEdgeInput, evaluationAt, materialization },
    JSON.parse(policyBytes.toString("utf8")),
  );
  const evaluationBytes = Buffer.from(canonicalRouteEdgeEvaluationJsonImpl(evaluation));
  const temporaryPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, evaluationBytes, { flag: "wx", mode: 0o600 });
  await rename(temporaryPath, outputPath);
  return evaluationBytes;
}

export async function runCurrentCapitalLiveChain({ repositoryRoot, runnerTemp, repository, repositorySha, operationId, transferObservationDirectory, transferReceiptPath, handoffDirectory, retainedExitBundle = undefined, retainedExitBundleSha256 = undefined, env = process.env, execFileImpl = execFile, clock = () => new Date(), assertCurrentTopologyAdmissionImpl = assertCurrentStaticNetworkTopologyAdmission, assertCurrentFacilityAdmissionImpl = assertCurrentCapitalFacilityAdmission, rebindPublicRouteMapImpl = rebindCurrentActivePublicRouteMapMaterialization, rebindTransferImpl = rebindCurrentLiveChainTransferDerivedIdentities, rebindFacilityImpl = rebindCurrentActiveFacilityDerivedIdentity, publishImpl = publishCurrentCapitalLiveChainOciPlan, fetchImpl = fetchCurrentCapitalLiveChainComposite, extractImpl = extractCurrentCapitalLiveChainDirectory }) {
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
  const ociPlan = buildCurrentCapitalLiveChainOciPlan({ mainSha: repositorySha, operationId, providerCollectionBundleBytes: collectionBundleBytes, providerCapturedAt: snapshot.capturedAt, compositeBundleBytes: bundle });
  const ociPlanBytes = Buffer.from(`${canonicalCurrentCapitalLiveChainOciPlanJson(ociPlan)}\n`);
  const ociPlanPath = path.join(stagedRoot, "current-capital-live-chain-oci-plan.json");
  const externalReceiptPath = path.join(stagedRoot, "current-capital-live-chain-oci-receipt.json");
  const fetchedProviderCollectionPath = path.join(stagedRoot, "fetched-current-kric-exit-collection-bundle.json");
  const fetchedBundlePath = path.join(stagedRoot, "fetched-current-capital-live-chain-bundle.json");
  await writeFile(ociPlanPath, ociPlanBytes, { flag: "wx", mode: 0o600 });
  const ociEnv = narrowOciEnv(env);
  await publishImpl({ planBytes: ociPlanBytes, root: stagedRoot, receiptPath: externalReceiptPath, env: ociEnv });
  await fetchImpl({ planBytes: ociPlanBytes, receiptPath: externalReceiptPath, providerDestinationPath: fetchedProviderCollectionPath, destinationPath: fetchedBundlePath, env: ociEnv });
  const externalReceiptBytes = await readFile(externalReceiptPath);
  const fetchedProviderCollectionBundleBytes = await readFile(fetchedProviderCollectionPath);
  const fetchedBundleBytes = await readFile(fetchedBundlePath);
  await extractImpl({ ociPlanBytes, externalReceiptBytes, fetchedProviderCollectionBundleBytes, fetchedBundleBytes, destinationDirectory: handoffDirectory, repository, repositorySha, operationId });
  return { stagedRoot, handoffDirectory: path.resolve(handoffDirectory), plan, bundleSha256: JSON.parse(bundle).bundleSha256, providerCollectionBundleSha256: providerObject.sha256, ociPlan };
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
