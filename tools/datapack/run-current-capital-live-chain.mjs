#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { CURRENT_CAPITAL_LIVE_CHAIN_OUTPUT_PATHS, buildCurrentCapitalLiveChainBundle } from "./build-current-capital-live-chain-bundle.mjs";
import {
  CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS,
  CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_PATH,
  buildCurrentCapitalLiveChainFanInBoundary,
  canonicalCurrentCapitalLiveChainFanInBoundaryJson,
  readCurrentCapitalLiveChainFanInBoundary,
} from "./build-current-capital-live-chain-boundary.mjs";
import { buildCurrentCapitalLiveChainOciPlan, buildCurrentCapitalLiveChainProviderObject, canonicalCurrentCapitalLiveChainOciPlanJson } from "./build-current-capital-live-chain-oci-plan.mjs";
import { buildCurrentExitAdmissionOciReceipt, canonicalCurrentExitAdmissionOciReceiptJson } from "./build-current-exit-admission-oci-receipt.mjs";
import { main as buildCurrentCapitalRouteEdgeInput } from "./build-current-capital-route-edge-input.mjs";
import { canonicalRouteEdgeEvaluationJson, evaluateRouteAccessibilityEdges } from "./evaluate-route-accessibility-edges.mjs";
import { extractCurrentCapitalLiveChainDirectory } from "./extract-current-capital-live-chain-directory.mjs";
import { materializeStationLineAccessibility } from "./materialize-station-line-accessibility.mjs";
import { fetchCurrentCapitalLiveChainComposite, publishCurrentCapitalLiveChainOciPlan, requireCurrentCapitalLiveChainOciParBaseUrl } from "./publish-object-storage.mjs";
import { rebindCurrentActiveFacilityDerivedIdentity } from "./rebind-current-active-facility-derived-identity.mjs";
import { rebindCurrentActivePublicRouteMapMaterialization } from "./rebind-current-active-public-route-map-materialization.mjs";
import { rebindCurrentLiveChainTransferDerivedIdentities } from "./rebind-current-live-chain-transfer-derived-identities.mjs";
import { assertCurrentStaticNetworkTopologyAdmission } from "./register-current-static-network-successors.mjs";
import { prepareCurrentStagedPublicRouteMapInventory } from "./prepare-current-staged-public-route-map-inventory.mjs";

const execFile = promisify(execFileCallback);
const DATA_MAIN_REMOTE = "https://github.com/AquilaXk/easysubway-data.git";
export const LIVE_CHAIN_OUTPUTS = CURRENT_CAPITAL_LIVE_CHAIN_OUTPUT_PATHS;
const STAGED_INPUTS = Object.freeze([
  "tools/datapack/release", "tools/datapack/sources", "tools/datapack/inputs", "tools/datapack/source-inventory.json", "tools/datapack/source-governance-policy.json", "tools/datapack/source-candidates.json", "tools/datapack/official-od-fare-admission.json", "tools/datapack/nationwide-coverage-targets.json", "tools/datapack/itx-cheongchun-topology-evidence.json", "release/product-gates/datapack-freshness-sla.json", "release/product-gates/route-edge-evaluation-policy.json",
]);
const EXCLUDED_STAGED_PATHS = Object.freeze([
  "tools/datapack/release/current-station-line-accessibility",
  "tools/datapack/release/current-route-edge-evaluation",
  "tools/datapack/release/current-capital-accessibility-full",
  "tools/datapack/release/current-capital-accessibility-transition.json",
]);

function requiredSha(value) { if (!/^[a-f0-9]{40}$/.test(value ?? "")) throw new Error("repository SHA mismatch"); return value; }
function requiredOperation(value) { if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{7,127}$/u.test(value)) throw new Error("operation identity mismatch"); return value; }
async function requireRealDirectory(directory, label) { const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`); }
async function requireAbsent(target, label) { try { await lstat(target); } catch (error) { if (error?.code === "ENOENT") return; throw error; } throw new Error(`${label} must be absent`); }
function narrowRunnerEnv(env) { return { PATH: env.PATH ?? "", RUNNER_TEMP: env.RUNNER_TEMP ?? "" }; }
function narrowOciEnv(env) { return { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: env.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL ?? "" }; }

async function assertRemoteMain({ root, repositorySha, execFileImpl }) {
  const { stdout } = await execFileImpl("git", ["ls-remote", "--exit-code", DATA_MAIN_REMOTE, "refs/heads/main"], { cwd: root });
  if (String(stdout).trimEnd() !== `${repositorySha}\trefs/heads/main`) throw new Error("exact remote main preflight failed");
}

export function buildCurrentCapitalLiveChainPlan({ repositoryRoot, repositorySha, operationId, stagedRoot, transferObservationDirectory, transferReceiptPath }) {
  requiredSha(repositorySha); requiredOperation(operationId);
  if (![repositoryRoot, stagedRoot, transferObservationDirectory, transferReceiptPath].every((value) => path.isAbsolute(value ?? ""))) throw new Error("live-chain plan paths must be absolute");
  const at = (...parts) => path.join(stagedRoot, ...parts);
  return { outputs: LIVE_CHAIN_OUTPUTS, steps: [
    { id: "prepare-staged-public-route-map-inventory", script: "tools/datapack/prepare-current-staged-public-route-map-inventory.mjs", args: ["--source-repository-root", repositoryRoot, "--staged-root", stagedRoot] },
    { id: "materialize-public-route-map", script: "tools/datapack/rebind-current-active-public-route-map-materialization.mjs", args: ["--repository-root", stagedRoot] },
    { id: "rebind-transfer", script: "tools/datapack/rebind-current-live-chain-transfer-derived-identities.mjs", args: ["--repository-root", stagedRoot, "--observation-directory", transferObservationDirectory, "--receipt", transferReceiptPath] },
    { id: "rebind-facility", script: "tools/datapack/rebind-current-active-facility-derived-identity.mjs", args: ["--repository-root", stagedRoot] },
    { id: "build-exit-plan", script: "tools/datapack/build-current-kric-exit-collection-plan.mjs", args: ["--canonical-pack", at("tools/datapack/release/capital-production-canonical-pack.json"), "--coverage-targets", at("tools/datapack/nationwide-coverage-targets.json"), "--provider-code-catalog", at("tools/datapack/sources/kric-provider-code-catalog-20260228.json"), "--route-rosters", at("tools/datapack/sources/kric-nationwide-route-rosters-20260730T203926676Z.json"), "--source-inventory", at("tools/datapack/source-inventory.json"), "--incheon-topology", at("tools/datapack/sources/incheon-transit-station-info-20260814.json"), "--coverage-selector", "capital-seoul-metro-production", "--output", at("current-kric-exit-plan.json")] },
    { id: "assert-current-topology-freshness", module: "tools/datapack/register-current-static-network-successors.mjs", exportName: "assertCurrentStaticNetworkTopologyAdmission" },
    { id: "collect-kric-exit", script: "tools/datapack/collect-current-kric-exit-path-provider-snapshot.mjs", args: ["--collection-plan", at("current-kric-exit-plan.json"), "--source-id", "kric-station-movement-standard", "--output", at("current-kric-exit-snapshot.json"), "--request-timeout-ms", "30000", "--request-interval-ms", "250"] },
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

export async function runCurrentCapitalLiveChain({ repositoryRoot, runnerTemp, repository, repositorySha, operationId, transferObservationDirectory, transferReceiptPath, handoffDirectory, env = process.env, execFileImpl = execFile, clock = () => new Date(), assertCurrentTopologyAdmissionImpl = assertCurrentStaticNetworkTopologyAdmission, prepareStagedPublicRouteMapInventoryImpl = prepareCurrentStagedPublicRouteMapInventory, rebindPublicRouteMapImpl = rebindCurrentActivePublicRouteMapMaterialization, rebindTransferImpl = rebindCurrentLiveChainTransferDerivedIdentities, rebindFacilityImpl = rebindCurrentActiveFacilityDerivedIdentity, publishImpl = publishCurrentCapitalLiveChainOciPlan, fetchImpl = fetchCurrentCapitalLiveChainComposite, extractImpl = extractCurrentCapitalLiveChainDirectory }) {
  if (repository !== "AquilaXk/easysubway-data") throw new Error("repository identity mismatch");
  if (![repositoryRoot, runnerTemp, transferObservationDirectory, transferReceiptPath, handoffDirectory].every((value) => path.isAbsolute(value ?? ""))) throw new Error("current live-chain paths must be absolute");
  requiredSha(repositorySha); requiredOperation(operationId);
  const root = path.resolve(repositoryRoot);
  await requireRealDirectory(path.resolve(runnerTemp), "runner temp");
  await requireRealDirectory(path.dirname(path.resolve(handoffDirectory)), "handoff parent");
  await requireAbsent(path.resolve(handoffDirectory), "handoff directory");
  if (typeof env.KRIC_SERVICE_KEY !== "string" || env.KRIC_SERVICE_KEY === "") throw new Error("KRIC service key is required");
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
  const stagedRoot = await mkdtemp(path.join(path.resolve(runnerTemp), "current-capital-live-chain-"));
  for (const relative of STAGED_INPUTS) {
    const source = path.join(root, relative); const destination = path.join(stagedRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await cp(source, destination, { recursive: true, force: false, verbatimSymlinks: true, filter: (candidate) => stagedCopyAllowed(root, candidate) });
  }
  const plan = buildCurrentCapitalLiveChainPlan({ repositoryRoot: root, repositorySha, operationId, stagedRoot, transferObservationDirectory, transferReceiptPath });
  await prepareStagedPublicRouteMapInventoryImpl({ repositoryRoot: root, stagedRoot });
  await rebindPublicRouteMapImpl({ repositoryRoot: stagedRoot });
  await rebindTransferImpl({ repositoryRoot: stagedRoot, observationDirectory: transferObservationDirectory, receiptPath: transferReceiptPath });
  await rebindFacilityImpl({ repositoryRoot: stagedRoot });
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
  const snapshotBytes = await readFile(path.join(stagedRoot, "current-kric-exit-snapshot.json"));
  const snapshot = JSON.parse(snapshotBytes.toString("utf8"));
  const admissionStep = plan.steps.find((entry) => entry.id === "admit-exit");
  const admissionArgs = admissionStep.args.map((value) => value === "FROM_PROVIDER_CAPTURED_AT" ? snapshot.capturedAt : value);
  await execFileImpl(process.execPath, [admissionStep.script, ...admissionArgs], { cwd: root, env: { ...narrowRunnerEnv(env), RUNNER_TEMP: stagedRoot } });
  await replaceStagedFile({ from: path.join(stagedRoot, "current-exit-admission", "exit-path-normalized-source-snapshot.json"), to: path.join(stagedRoot, "tools/datapack/release/current-exit-admission-v2/exit-path-normalized-source-snapshot.json") });
  await replaceStagedFile({ from: path.join(stagedRoot, "current-exit-admission", "exit-path-source-admission.json"), to: path.join(stagedRoot, "tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json") });
  const collectionBundleBytes = await readFile(path.join(stagedRoot, "current-kric-exit-collection-bundle.json"));
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
  await evaluateStagedRoutePolicy({ stagedRoot, evaluationAt: snapshot.capturedAt });
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
  const allowed = new Set(["repository-root", "runner-temp", "repository", "repository-sha", "operation-id", "transfer-observation-directory", "transfer-receipt", "handoff-directory"]);
  if (!Array.isArray(argv) || argv.length !== allowed.size * 2) throw new Error("current live-chain arguments mismatch");
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]?.replace(/^--/u, ""); const value = argv[index + 1];
    if (!allowed.has(flag) || Object.hasOwn(values, flag) || typeof value !== "string" || value === "") throw new Error("current live-chain arguments mismatch");
    values[flag] = value;
  }
  if (["repository-root", "runner-temp", "transfer-observation-directory", "transfer-receipt", "handoff-directory"].some((flag) => !path.isAbsolute(values[flag] ?? ""))) throw new Error("current live-chain paths must be absolute");
  return values;
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv);
  const result = await runCurrentCapitalLiveChain({
    repositoryRoot: args["repository-root"], runnerTemp: args["runner-temp"], repository: args.repository,
    repositorySha: args["repository-sha"], operationId: args["operation-id"],
    transferObservationDirectory: args["transfer-observation-directory"], transferReceiptPath: args["transfer-receipt"],
    handoffDirectory: args["handoff-directory"], ...dependencies,
  });
  (dependencies.log ?? console.log)(JSON.stringify({ result: "PASS", repositorySha: args["repository-sha"], operationId: args["operation-id"], bundleSha256: result.bundleSha256, providerCollectionBundleSha256: result.providerCollectionBundleSha256, handoffDirectory: result.handoffDirectory }));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
