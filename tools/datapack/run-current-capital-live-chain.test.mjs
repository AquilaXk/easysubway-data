import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  CURRENT_KRIC_EXIT_REQUEST_INTERVAL_MS,
  CURRENT_KRIC_EXIT_REQUEST_TIMEOUT_MS,
  assertCurrentCapitalExitItxAuthorityFresh,
  buildCurrentCapitalExitExecutionPlan,
  buildCurrentCapitalTopologyTerminalHandoff,
  assertCurrentCapitalFacilityAdmission,
  assertRemoteMain,
  resolveCurrentLiveChainCandidateStageInputs,
  resolveCurrentKricExitPlanInputs,
  resolveStagedIncheonTopologyPath,
  recoverCurrentKricExitCollection,
  resolveCurrentExitDerivationAt,
  runCurrentCapitalExitOnlyProducer,
  runCurrentCapitalExitTerminalConsumer,
  requireTerminalTransferRebindOutputs,
  rebuildCurrentCapitalTopologyTerminalHandoffForAncestorRecovery,
  terminalCandidateIdForLineageProof,
  verifyCurrentCapitalTerminalLineage,
  writeTerminalRoutePolicyEvaluation,
} from "./run-current-capital-live-chain.mjs";
import { buildCurrentCapitalFacilityCollectionPlan, canonicalCurrentCapitalFacilityCollectionPlanJson } from "./build-current-capital-facility-collection-plan.mjs";
import { buildCurrentCapitalFacilitySourceAdmission, canonicalCurrentCapitalFacilitySourceAdmissionJson } from "./build-current-capital-facility-source-admission.mjs";
import { rebindCurrentCandidateSourceSnapshots } from "./rebind-current-candidate-source-snapshots.mjs";
import { currentLiveChainTransferOutputPaths } from "./rebind-current-live-chain-transfer-derived-identities.mjs";
import { registerKricStandardAccessibilitySnapshot } from "./register-kric-standard-accessibility-snapshot.mjs";
import { buildCurrentCapitalTopologyRefreshOutputs } from "./activate-current-source-set.mjs";
import { deriveRawRetentionExpiresAt } from "./source-governance-policy.mjs";
import { buildCurrentKricExitCollectionBundle, buildCurrentKricExitCollectionReceipt, canonicalCurrentKricExitCollectionBundleJson } from "./build-current-kric-exit-collection-receipt.mjs";
import { buildCurrentKricExitCollectionPlan } from "./build-current-kric-exit-collection-plan.mjs";
import { currentCapitalLiveChainOutputPaths } from "./validate-current-capital-live-chain-materialization.mjs";
import { canonicalKricExitPathCollectionPlanJson } from "./plan-kric-exit-path-collection.mjs";
import { buildCurrentKricExitProviderOciPlan, canonicalCurrentKricExitProviderOciPlanJson } from "./build-current-kric-exit-provider-oci-plan.mjs";
import { buildCurrentKricExitProviderOciReceipt, canonicalCurrentKricExitProviderOciReceiptJson } from "./build-current-kric-exit-provider-oci-receipt.mjs";
import {
  buildCurrentCapitalExitProviderSourceHandoffFromProviderOci,
  canonicalCurrentCapitalExitProviderSourceHandoffJson,
} from "./current-capital-exit-provider-handoff.mjs";
import { commitCurrentCapitalTerminalManifest, validateCurrentCapitalTerminalManifest } from "./refresh-current-capital-accessibility-full.mjs";
import { CURRENT_CAPITAL_ACCESSIBILITY_SOURCE_FIXED_OUTPUTS } from "./current-capital-accessibility-source-handoff.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { preparePendingCurrentAccessibilityTransitionRepository } from "./test-fixtures/current-full-capital-production-artifact.mjs";
import { nextSyntheticCurrentStaticNetworkNow } from "./test-fixtures/current-public-route-map-successor.mjs";
import { currentTopologyAdmissionClock } from "./test-fixtures/current-topology-admission-clock.mjs";
import { assertCurrentStaticNetworkTopologyAdmission } from "./register-current-static-network-successors.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const execFile = promisify(execFileCallback);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => JSON.stringify(sort(value));
function sort(value) { if (Array.isArray(value)) return value.map(sort); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.keys(value).sort((left, right) => left.localeCompare(right, "en")).map((key) => [key, sort(value[key])])); }

async function unchangedTransferRebindProof({ repositoryRoot }) {
  const inventory = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/source-inventory.json")));
  const descriptorPath = inventory.sources.find(({ id }) =>
    id === "seoul-metro-transfer-distance-duration")?.transferAdmissionEvidence?.snapshotPath;
  assert.equal(typeof descriptorPath, "string");
  return {
    outputs: await Promise.all(currentLiveChainTransferOutputPaths(descriptorPath).map(async (relative) => {
      const bytes = await readFile(path.join(repositoryRoot, relative));
      return { relative, bytes, prestate: Buffer.from(bytes) };
    })),
  };
}

function terminalAccessibilitySourceHandoff({
  beforeByPath = new Map(),
  afterByPath = new Map(),
  operationId = "current-capital-673",
  sourceMainGitSha = "a".repeat(40),
  facilityBranch = "automation/629-kric-facility-refresh-123",
  facilityHeadSha = "b".repeat(40),
} = {}) {
  const sources = [
    ["seoul-metro-accessibility", "seoul-accessibility-raw-object-receipt", "c"],
    ["kric-station-convenience-standard", "kric-accessibility-raw-object-receipt", "d"],
  ].map(([sourceId, artifactKind, fill]) => {
    const snapshotId = `${sourceId}-20990101T000000000Z`;
    const snapshotPath = `tools/datapack/sources/${snapshotId}.json`;
    const snapshotBytes = afterByPath.get(snapshotPath) ?? Buffer.from(`after:${snapshotPath}`);
    const rawReceipt = {
      schemaVersion: 1, artifactKind, sourceId, snapshotId,
      snapshotRawSha256: fill.repeat(64), capturedAt: "2099-01-01T00:00:00.000Z",
      snapshotFileSha256: sha(snapshotBytes), rawObjectUri: `oci://fixture/${sourceId}/${fill.repeat(64)}.json`,
      rawObjectSha256: fill.repeat(64), byteSize: 123, storedAt: "2099-01-01T00:00:01.000Z",
      rawRetentionExpiresAt: "2099-04-01T00:00:00.000Z",
    };
    return {
      action: "REFRESH", sourceId, snapshotId, snapshotPath, snapshotSha256: sha(snapshotBytes),
      rawReceiptSha256: sha(Buffer.from(canonicalJson(rawReceipt))),
    };
  });
  const outputs = [
    ...CURRENT_CAPITAL_ACCESSIBILITY_SOURCE_FIXED_OUTPUTS.map((relativePath) => ({
      relativePath, operation: "replace",
      beforeSha256: sha(beforeByPath.get(relativePath) ?? Buffer.from(`before:${relativePath}`)),
      afterSha256: sha(afterByPath.get(relativePath) ?? Buffer.from(`after:${relativePath}`)),
    })),
    ...sources.map(({ snapshotPath }) => ({
      relativePath: snapshotPath, operation: "create", beforeSha256: null,
      afterSha256: sha(afterByPath.get(snapshotPath) ?? Buffer.from(`after:${snapshotPath}`)),
    })),
  ].sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
  const payload = {
    schemaVersion: 2, artifactKind: "current-capital-accessibility-source-handoff",
    repository: "AquilaXk/easysubway-data", operationId,
    sourceMainGitSha, facility: { branch: facilityBranch, headSha: facilityHeadSha },
    providerStartedAt: "2099-01-01T00:00:00.000Z",
    operationNow: "2099-01-01T00:00:02.000Z", protectedCandidateId: "capital-candidate-protected",
    sources, outputs,
  };
  return { ...payload, handoffSha256: sha(Buffer.from(canonicalJson(payload))) };
}

async function terminalAccessibilityVerifierResult(repositoryRoot, outputs = []) {
  const [candidateBytes, operationNow] = await Promise.all([
    readFile(path.join(repositoryRoot, "tools/datapack/release/candidate-build-spec.json")),
    nextSyntheticCurrentStaticNetworkNow(repositoryRoot),
  ]);
  const operationNowValue = operationNow.toISOString();
  return {
    handoffSha256: "9".repeat(64),
    operationId: "current-capital-560",
    providerStartedAt: new Date(operationNow.getTime() - 60_000).toISOString(),
    operationNow: operationNowValue,
    protectedCandidateId: JSON.parse(candidateBytes).candidateId,
    sources: [
      { action: "REFRESH", sourceId: "kric-station-convenience-standard" },
      { action: "REFRESH", sourceId: "seoul-metro-accessibility" },
    ],
    outputs,
  };
}

function terminalAccessibilityProjection(value) {
  return Object.fromEntries([
    "handoffSha256", "operationId", "operationNow", "protectedCandidateId", "providerStartedAt",
  ].map((key) => [key, value[key]]));
}

async function terminalConsumerProof(repositoryRoot = ROOT) {
  const [candidate, sourceInventory, sourceSnapshotLedger] = await Promise.all([
    "tools/datapack/release/candidate-build-spec.json",
    "tools/datapack/source-inventory.json",
    "tools/datapack/release/source-snapshots.json",
  ].map(async (relative) => JSON.parse(await readFile(path.join(repositoryRoot, relative), "utf8"))));
  const replacementPaths = [
    ...currentCapitalLiveChainOutputPaths({ candidate, sourceInventory, sourceSnapshotLedger }),
    "tools/datapack/release/current-capital-live-chain-fan-in.json",
  ];
  return {
    schemaVersion: 2,
    artifactKind: "current-capital-terminal-lineage",
    sourceMainGitSha: "a".repeat(40), facilityHeadGitSha: "b".repeat(40), builderGitSha: "c".repeat(40),
    transition: {
      baseSha256: "d".repeat(64), successorSha256: "e".repeat(64),
      sourceMainCandidateSha256: "f".repeat(64), sourceMainFacilitySha256: "0".repeat(64),
    },
    retainedOutputs: [], topologyInputs: [], topologyOutputs: [],
    replacementPrestates: await Promise.all(replacementPaths.map(async (relativePath) => ({
      relativePath, sha256: sha(await readFile(path.join(repositoryRoot, relativePath))),
    }))),
  };
}

test("terminal consumer requires a TRANSFER rebind proof", () => {
  assert.throws(
    () => requireTerminalTransferRebindOutputs(undefined),
    /terminal consumer TRANSFER rebind proof mismatch/,
  );
  assert.throws(
    () => requireTerminalTransferRebindOutputs({ outputs: [] }),
    /terminal consumer TRANSFER rebind proof mismatch/,
  );
  const outputs = [{ relative: "tools/datapack/release/candidate-build-spec.json" }];
  assert.equal(requireTerminalTransferRebindOutputs({ outputs }), outputs);
});

test("EXIT topology preflight rejects a stale selected ITX authority before collection", async (t) => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "current-exit-itx-preflight-"));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const evidencePath = "tools/datapack/itx-cheongchun-topology-evidence-20260830151508786.json";
  const admissionPath = "tools/datapack/itx-current-network-edge-admission-20260901.json";
  const evidenceBytes = Buffer.from(`${JSON.stringify({ artifactKind: "itx-cheongchun-mobile-topology-evidence" })}\n`);
  const admissionBytes = Buffer.from(`${JSON.stringify({
    artifactKind: "itx-current-network-edge-admission",
    artifactId: "itx-current-network-edge-admission-20260901",
    status: "ADMITTED",
    freshUntil: "2026-09-02T00:00:00+09:00",
  })}\n`);
  const candidate = {
    itxTopologyEvidencePath: evidencePath,
    itxTopologyEvidenceSha256: sha(evidenceBytes),
    networkEdgeEvidence: { itxCurrentTopologyAdmission: { path: admissionPath, sha256: sha(admissionBytes) } },
  };
  for (const [relative, bytes] of [
    ["tools/datapack/release/candidate-build-spec.json", Buffer.from(`${JSON.stringify(candidate)}\n`)],
    [evidencePath, evidenceBytes],
    [admissionPath, admissionBytes],
  ]) {
    const target = path.join(repositoryRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
  }
  await assert.doesNotReject(assertCurrentCapitalExitItxAuthorityFresh({
    repositoryRoot,
    now: new Date("2026-09-01T14:59:59.999Z"),
  }));
  await assert.rejects(assertCurrentCapitalExitItxAuthorityFresh({
    repositoryRoot,
    now: new Date("2026-09-01T15:00:00.000Z"),
  }), /admission is not current/);
});

async function cloneCleanFixture(source, target) {
  await execFile("git", ["clone", "--shared", "--quiet", source, target]);
  return (await execFile("git", ["rev-parse", "HEAD"], { cwd: target })).stdout.trim();
}

async function removeTerminalMarkersAndCommit(root) {
  const markers = [
    "tools/datapack/release/current-capital-accessibility-transition.json",
    "tools/datapack/release/current-capital-accessibility-transition-successor.json",
  ];
  await Promise.all(markers.map((relative) => rm(path.join(root, relative))));
  await execFile("git", ["add", "-u", "--", ...markers], { cwd: root });
  await execFile("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "Remove terminal markers"], { cwd: root });
  return (await execFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
}

async function terminalLineageRoots(t, prefix) {
  const parent = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return {
    fixtureSource: await pendingTransitionRepository(t, { initializeGit: true }),
    sourceMainRoot: path.join(parent, "source-main"),
    retainedRoot: path.join(parent, "retained"),
    privateBuilderRoot: path.join(parent, "private-builder"),
  };
}

async function pendingTransitionRepository(t, { initializeGit = false } = {}) {
  const generatedRoot = await preparePendingCurrentAccessibilityTransitionRepository(ROOT);
  t.after(() => rm(generatedRoot, { recursive: true, force: true }));
  const parent = await mkdtemp(path.join(os.tmpdir(), "pending-transition-git-"));
  const repositoryRoot = path.join(parent, "repository");
  t.after(() => rm(parent, { recursive: true, force: true }));
  await cloneCleanFixture(ROOT, repositoryRoot);
  await Promise.all(["tools", "release"].map((relative) => cp(
    path.join(generatedRoot, relative),
    path.join(repositoryRoot, relative),
    { recursive: true, force: true },
  )));
  if (!initializeGit) return repositoryRoot;

  await execFile("git", ["add", "--all"], { cwd: repositoryRoot });
  await execFile("git", [
    "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit", "--quiet", "-m", "Create pending transition fixture",
  ], { cwd: repositoryRoot });
  return repositoryRoot;
}

async function buildRetainedFacilityFixture(root) {
  const read = (relative) => readFile(path.join(root, relative));
  const parsed = async (relative) => JSON.parse(await read(relative));
  const input = {
    canonicalPackBytes: await read("tools/datapack/release/capital-production-canonical-pack.json"),
    coverageTargetsBytes: await read("tools/datapack/nationwide-coverage-targets.json"),
    providerCodeCatalogBytes: await read("tools/datapack/sources/kric-provider-code-catalog-20260228.json"),
    routeRostersBytes: await read("tools/datapack/sources/kric-nationwide-route-rosters-20260730T203926676Z.json"),
    sourceInventoryBytes: await read("tools/datapack/source-inventory.json"),
  };
  const plan = buildCurrentCapitalFacilityCollectionPlan(input);
  const inventory = JSON.parse(input.sourceInventoryBytes);
  const selected = ["kric-station-convenience-standard", "seoul-metro-accessibility"]
    .map((sourceId) => inventory.sources.find(({ id }) => id === sourceId)?.accessibilityAdmissionEvidence);
  const capturedAt = Math.max(...selected.map((evidence) => Date.parse(evidence?.capturedAt ?? ""))) + 60_000;
  if (!Number.isFinite(capturedAt) || capturedAt >= Date.parse(selected[1]?.freshUntil ?? "")) {
    throw new Error("retained FACILITY fixture has no shared source window");
  }
  const operationNow = new Date(capturedAt);
  const previousSnapshot = await parsed(selected[0].snapshotPath);
  const capturedAtIso = operationNow.toISOString();
  const snapshot = {
    ...previousSnapshot,
    snapshotId: `kric-station-convenience-standard-${capturedAtIso.replaceAll(/[-:.]/g, "")}`,
    capturedAt: capturedAtIso,
    observedAt: capturedAtIso,
    freshUntil: new Date(operationNow.getTime() + 86_400_000).toISOString(),
  };
  const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
  const stagingPath = path.join(root, "staging", `${snapshot.snapshotId}.json`);
  const snapshotRelative = `tools/datapack/sources/${snapshot.snapshotId}.json`;
  const snapshotTarget = path.join(root, snapshotRelative);
  await mkdir(path.dirname(stagingPath), { recursive: true });
  await writeFile(stagingPath, snapshotBytes);
  const governance = await parsed("tools/datapack/source-governance-policy.json");
  const rawReceipt = {
    rawObjectUri: `oci://test-only/${snapshot.sourceId}/${sha(snapshotBytes)}.json`,
    sourceId: snapshot.sourceId,
    snapshotId: snapshot.snapshotId,
    snapshotRawSha256: snapshot.rawSha256,
    capturedAt: snapshot.capturedAt,
    snapshotFileSha256: sha(snapshotBytes),
    rawObjectSha256: "e".repeat(64),
    byteSize: snapshotBytes.length,
    storedAt: new Date(operationNow.getTime() + 1_000).toISOString(),
    rawRetentionExpiresAt: deriveRawRetentionExpiresAt({
      policy: governance, sourceId: snapshot.sourceId, retrievedAt: snapshot.capturedAt,
    }),
  };
  const planBytes = Buffer.from(canonicalCurrentCapitalFacilityCollectionPlanJson(plan));
  const planPath = path.join(root, "facility-plan.json");
  await writeFile(planPath, planBytes);
  await registerKricStandardAccessibilitySnapshot({
    repositoryRoot: root,
    snapshotFilePath: stagingPath,
    snapshotFileSha256: sha(snapshotBytes),
    snapshotTargetPath: snapshotTarget,
    rawReceipt,
    capitalFacilityPlanPath: planPath,
    capitalCanonicalPackPath: path.join(root, "tools/datapack/release/capital-production-canonical-pack.json"),
    producerNeutralFullRegistration: true,
    now: new Date(operationNow.getTime() + 1_000),
  });
  await rebindCurrentCandidateSourceSnapshots({
    repositoryRoot: root, now: new Date(operationNow.getTime() + 2_000),
  });
  const [candidate, inventoryBytes, sourceSnapshots, governanceBytes, freshnessPolicy] = await Promise.all([
    parsed("tools/datapack/release/candidate-build-spec.json"),
    read("tools/datapack/source-inventory.json"),
    parsed("tools/datapack/release/source-snapshots.json"),
    read("tools/datapack/source-governance-policy.json"),
    parsed("release/product-gates/datapack-freshness-sla.json"),
  ]);
  const admission = buildCurrentCapitalFacilitySourceAdmission({
    observedAt: snapshot.observedAt,
    candidateEvaluationAt: candidate.publishedAt,
    planBytes,
    canonicalPackBytes: input.canonicalPackBytes,
    snapshotBytes: await readFile(snapshotTarget),
    candidateBuildSpec: candidate,
    sourceInventoryBytes: inventoryBytes,
    sourceSnapshots,
    governancePolicy: JSON.parse(governanceBytes),
    governancePolicyBytes: governanceBytes,
    freshnessPolicy,
  });
  await writeFile(
    path.join(root, "tools/datapack/release/current-capital-facility-source-admission.json"),
    canonicalCurrentCapitalFacilitySourceAdmissionJson(admission),
  );
  await rm(path.dirname(stagingPath), { recursive: true });
  await rm(planPath);
  const retainedPaths = [
    "tools/datapack/release/candidate-build-spec.json",
    "tools/datapack/release/current-capital-facility-source-admission.json",
    "tools/datapack/release/hash-evidence.json",
    "tools/datapack/release/release-request.json",
    "tools/datapack/release/source-snapshots.json",
    "tools/datapack/source-inventory.json",
    snapshotRelative,
  ];
  await execFile("git", ["add", "--", ...retainedPaths], { cwd: root });
  await execFile("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "Build retained FACILITY state"], { cwd: root });
  return (await execFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
}

async function currentTopologyFixture(root) {
  const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json")));
  const spec = JSON.parse(await readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json")));
  const source = (sourceId) => inventory.sources.find(({ id }) => id === sourceId);
  const capitalAdmission = inventory.sources
    .map(({ routeMapAdmissionEvidence }) => routeMapAdmissionEvidence?.currentTopologyAdmission)
    .find(({ topologySnapshotId } = {}) => /^capital-route-topology-[0-9]{8}$/u.test(topologySnapshotId));
  const topologyBuild = {
    capitalTopologyPath: `tools/datapack/sources/${capitalAdmission.topologySnapshotId}.json`,
    incheonTopologyPath: source("incheon-transit-station-info").topologyAdmissionEvidence.snapshotPath,
    incheonAccessibilityPath: `tools/datapack/sources/${source("incheon-transit-accessibility").admissionEvidence.snapshotId}.json`,
    incheonLine1TimetablePath: source("incheon-line1-train-timetable").scheduleAdmissionEvidence.snapshotPath,
    incheonLine2TimetablePath: source("incheon-line2-train-timetable").scheduleAdmissionEvidence.snapshotPath,
    itxCurrentAdmissionPath: spec.networkEdgeEvidence.itxCurrentTopologyAdmission?.path ?? null,
    itxTopologyEvidencePath: spec.itxTopologyEvidencePath,
  };
  const topologySnapshots = await Promise.all([
    topologyBuild.capitalTopologyPath,
    topologyBuild.incheonTopologyPath,
    topologyBuild.incheonAccessibilityPath,
    topologyBuild.incheonLine1TimetablePath,
    topologyBuild.incheonLine2TimetablePath,
  ].map(async (relative) => JSON.parse(await readFile(path.join(root, relative)))));
  const itxContract = JSON.parse(await readFile(path.join(root, "tools/datapack/itx-cheongchun-coverage-contract.json")));
  const itxSource = JSON.parse(await readFile(path.join(root, itxContract.sourceTimetableArtifact.artifactPath)));
  topologyBuild.buildNow = new Date(Math.max(
    Date.parse(itxSource.observedAt), ...topologySnapshots.map(({ capturedAt: value }) => Date.parse(value)),
  ) + 1).toISOString();
  return topologyBuild;
}

const planInput = {
  repositoryRoot: "/repository", repositorySha: "a".repeat(40), operationId: "current-capital-560", stagedRoot: "/runner/staged",
  transferObservationDirectory: "/retained/transfer/observation", transferReceiptPath: "/retained/transfer/receipt.json",
  incheonTopologyRelativePath: "tools/datapack/sources/incheon-transit-station-info-20991231.json",
  providerCodeCatalogRelativePath: "tools/datapack/sources/provider-code-catalog.json",
  routeRostersRelativePath: "tools/datapack/sources/route-rosters.json",
  outputPaths: ["derived/current-output.json"],
};

test("EXIT execution plan fixes the staged P/F/T to EXIT to full-capital order and invokes the collector exactly once", () => {
  const plan = buildCurrentCapitalExitExecutionPlan(planInput);
  assert.equal(plan.steps.filter(({ id }) => id === "collect-kric-exit").length, 1);
  assert.deepEqual(plan.steps.map(({ id }) => id), [
    "materialize-public-route-map", "rebind-transfer", "rebind-facility", "build-exit-plan", "assert-current-topology-freshness",
    "collect-kric-exit", "bind-exit-collection", "admit-exit", "bind-current-fan-in", "build-full-capital", "evaluate-route-policy",
  ]);
  assert.equal(plan.steps.findIndex(({ id }) => id === "materialize-public-route-map") + 1, plan.steps.findIndex(({ id }) => id === "rebind-transfer"));
  assert.equal(plan.steps.findIndex(({ id }) => id === "build-exit-plan") + 1, plan.steps.findIndex(({ id }) => id === "assert-current-topology-freshness"));
  assert.equal(plan.steps.findIndex(({ id }) => id === "assert-current-topology-freshness") + 1, plan.steps.findIndex(({ id }) => id === "collect-kric-exit"));
  assert.equal(plan.steps.some(({ script }) => /current-station-line-accessibility|current-route-edge-evaluation|refresh-current-capital-accessibility-full|rebind-current-active-transfer-derived-identities/.test(script)), false);
  assert.deepEqual(plan.steps.find(({ id }) => id === "rebind-transfer").args.slice(-4), ["--observation-directory", planInput.transferObservationDirectory, "--receipt", planInput.transferReceiptPath]);
  const exitPlanArgs = plan.steps.find(({ id }) => id === "build-exit-plan").args;
  assert.equal(exitPlanArgs[exitPlanArgs.indexOf("--incheon-topology") + 1], path.join(planInput.stagedRoot, planInput.incheonTopologyRelativePath));
  const evaluationArgs = plan.steps.find(({ id }) => id === "evaluate-route-policy").args;
  assert.equal(evaluationArgs[evaluationArgs.indexOf("--output") + 1], path.join(planInput.stagedRoot, "tools/datapack/release/current-capital-accessibility-full/route-edge-evaluation.json"));
  assert.deepEqual(plan.outputs, planInput.outputPaths);
  assert.throws(() => buildCurrentCapitalExitExecutionPlan({ ...planInput, repositorySha: "not-a-sha" }), /repository SHA/);
  assert.throws(() => buildCurrentCapitalExitExecutionPlan({ ...planInput, transferReceiptPath: "relative.json" }), /paths must be absolute/);
});

test("terminal manifest accepts only a verifier-shaped proof and rejects caller lineage hashes", async (t) => {
  const repositoryRoot = await pendingTransitionRepository(t);
  const markers = [
    "tools/datapack/release/current-capital-accessibility-transition.json",
    "tools/datapack/release/current-capital-accessibility-transition-successor.json",
  ];
  const markerBytes = await Promise.all(markers.map((relative) => readFile(path.join(repositoryRoot, relative))));
  const [candidate, inventory, ledger] = await Promise.all([
    "tools/datapack/release/candidate-build-spec.json",
    "tools/datapack/source-inventory.json",
    "tools/datapack/release/source-snapshots.json",
  ].map(async (relative) => JSON.parse(await readFile(path.join(repositoryRoot, relative), "utf8"))));
  const liveChainOutputs = currentCapitalLiveChainOutputPaths({
    candidate, sourceInventory: inventory, sourceSnapshotLedger: ledger,
  });
  const topologyInputs = [
    "tools/datapack/sources/capital-route-topology-20990101.json",
    "tools/datapack/sources/incheon-transit-station-info-20990101.json",
    "tools/datapack/sources/incheon-line1-train-timetable-20990101.json",
    "tools/datapack/sources/incheon-line2-train-timetable-20990101.json",
  ];
  const topologyOutputs = [
    "tools/datapack/source-inventory.json",
    "tools/datapack/release/candidate-build-spec.json",
    "tools/datapack/release/capital-topology-reverification-20990101.json",
  ];
  const proofClassPaths = [...new Set([
    ...topologyInputs, ...topologyOutputs, ...liveChainOutputs,
    "tools/datapack/release/current-capital-live-chain-fan-in.json",
  ])];
  const accessibilitySourceHandoff = terminalAccessibilitySourceHandoff({
    beforeByPath: new Map(proofClassPaths.map((relative) => [relative, Buffer.from(relative)])),
  });
  const replacementPaths = [...new Set([
    ...accessibilitySourceHandoff.outputs.map(({ relativePath }) => relativePath),
    ...topologyInputs,
    ...topologyOutputs,
    ...liveChainOutputs,
    "tools/datapack/release/current-capital-live-chain-fan-in.json",
  ])].sort((left, right) => left.localeCompare(right));
  const createOncePaths = new Set([
    ...topologyInputs,
    ...topologyOutputs.filter((relative) => /reverification/.test(relative)),
    ...accessibilitySourceHandoff.outputs.filter(({ operation }) => operation === "create").map(({ relativePath }) => relativePath),
  ]);
  const replacementPrestates = proofClassPaths.filter((relative) => !createOncePaths.has(relative))
    .map((relativePath) => ({ relativePath, sha256: sha(Buffer.from(relativePath)) }));
  const proof = {
    schemaVersion: 2,
    artifactKind: "current-capital-terminal-lineage",
    sourceMainGitSha: "a".repeat(40),
    facilityHeadGitSha: "b".repeat(40),
    builderGitSha: "c".repeat(40),
    transition: {
      baseSha256: sha(markerBytes[0]), successorSha256: sha(markerBytes[1]),
      sourceMainCandidateSha256: sha(Buffer.from(JSON.stringify(candidate))),
      sourceMainFacilitySha256: sha(Buffer.from("facility")),
    },
    retainedOutputs: [{ relative: "tools/datapack/release/candidate-build-spec.json", sha256: sha(Buffer.from(JSON.stringify(candidate))) }],
    topologyInputs: topologyInputs.map((relative) => ({ relativePath: relative, sha256: sha(Buffer.from(relative)) })),
    topologyOutputs: topologyOutputs.map((relative) => ({
      relativePath: relative,
      beforeSha256: /reverification/.test(relative) ? null : replacementPrestates.find((entry) => entry.relativePath === relative)?.sha256,
      generatedSha256: sha(Buffer.from(`${relative}:producer`)),
    })),
    replacementPrestates,
  };
  const manifest = {
    accessibilitySourceHandoff,
    topologyInputs, topologyOutputs, liveChainOutputs,
    fanInPath: "tools/datapack/release/current-capital-live-chain-fan-in.json",
    markerPaths: markers,
    markerState: "PRESENT",
    replacementPaths,
    proof,
    materialization: {
      repository: "AquilaXk/easysubway-data", repositorySha: "d".repeat(40), operationId: "current-capital-673",
      entries: [...liveChainOutputs].sort().map((entryPath) => ({ path: entryPath, sha256: sha(Buffer.from(entryPath)) })),
      fanIn: { path: "tools/datapack/release/current-capital-live-chain-fan-in.json", sha256: sha(Buffer.from("fan-in")) },
    },
  };
  const checked = validateCurrentCapitalTerminalManifest(manifest);
  assert.deepEqual(checked.replacements, replacementPaths);
  assert.equal(checked.topologyInputs.length, 4);
  assert.equal(checked.liveChainOutputs.length, 17);
  assert.deepEqual(await Promise.all(markers.map((relative) => readFile(path.join(repositoryRoot, relative)))), markerBytes);
  assert.throws(() => validateCurrentCapitalTerminalManifest({
    ...manifest, replacementPaths: replacementPaths.slice(1),
  }), /replacement manifest mismatch/);
  assert.throws(() => validateCurrentCapitalTerminalManifest({
    ...manifest, lineageProof: { baseTransitionSha256: sha(markerBytes[0]) },
  }), /manifest mismatch/);
  assert.throws(() => validateCurrentCapitalTerminalManifest({
    ...manifest,
    proof: { ...proof, replacementPrestates: proof.replacementPrestates.slice(1) },
  }), /replacement prestates mismatch/);
  assert.throws(() => validateCurrentCapitalTerminalManifest({
    ...manifest,
    proof: { ...proof, topologyOutputs: proof.topologyOutputs.map((entry) => entry.beforeSha256 == null
      ? entry : { ...entry, beforeSha256: "f".repeat(64) }) },
  }), /topology replacement prestate mismatch/);
});

async function terminalCommitFixture(repositoryRoot) {
  const [candidate, sourceInventory, sourceSnapshotLedger, marker, successor] = await Promise.all([
    "tools/datapack/release/candidate-build-spec.json",
    "tools/datapack/source-inventory.json",
    "tools/datapack/release/source-snapshots.json",
    "tools/datapack/release/current-capital-accessibility-transition.json",
    "tools/datapack/release/current-capital-accessibility-transition-successor.json",
  ].map(async (relative) => readFile(path.join(repositoryRoot, relative))));
  const liveChainOutputs = currentCapitalLiveChainOutputPaths({
    candidate: JSON.parse(candidate), sourceInventory: JSON.parse(sourceInventory), sourceSnapshotLedger: JSON.parse(sourceSnapshotLedger),
  });
  const topologyInputs = [
    "tools/datapack/sources/capital-route-topology-20990101.json",
    "tools/datapack/sources/incheon-transit-station-info-20990101.json",
    "tools/datapack/sources/incheon-line1-train-timetable-20990101.json",
    "tools/datapack/sources/incheon-line2-train-timetable-20990101.json",
  ];
  const topologyOutputs = [
    "tools/datapack/source-inventory.json",
    "tools/datapack/release/candidate-build-spec.json",
    "tools/datapack/release/capital-topology-reverification-20990101.json",
  ];
  const fanInPath = "tools/datapack/release/current-capital-live-chain-fan-in.json";
  const facilitySourcePaths = [
    "tools/datapack/sources/seoul-metro-accessibility-20990101T000000000Z.json",
    "tools/datapack/sources/kric-station-convenience-standard-20990101T000000000Z.json",
  ];
  const proofClassPaths = [...new Set([...topologyInputs, ...topologyOutputs, ...liveChainOutputs, fanInPath])];
  const replacementPaths = [...new Set([
    ...proofClassPaths, ...CURRENT_CAPITAL_ACCESSIBILITY_SOURCE_FIXED_OUTPUTS, ...facilitySourcePaths,
  ])].sort((left, right) => left.localeCompare(right));
  const createOnce = new Set([...topologyInputs, topologyOutputs[2], ...facilitySourcePaths]);
  const beforeByPath = new Map(await Promise.all(replacementPaths.filter((relative) => !createOnce.has(relative))
    .map(async (relative) => [relative, await readFile(path.join(repositoryRoot, relative))])));
  const afterByPath = new Map(replacementPaths.map((relative) => [relative, Buffer.from(`terminal-after:${relative}`)]));
  const accessibilitySourceHandoff = terminalAccessibilitySourceHandoff({ beforeByPath, afterByPath });
  const generatedByPath = new Map(topologyOutputs.map((relative) => [relative,
    relative === topologyOutputs[2] ? afterByPath.get(relative) : Buffer.from(`terminal-generated:${relative}`)]));
  const replacementPrestates = proofClassPaths.filter((relative) => !createOnce.has(relative))
    .map((relativePath) => ({ relativePath, sha256: sha(beforeByPath.get(relativePath)) }));
  const proof = {
    schemaVersion: 2, artifactKind: "current-capital-terminal-lineage",
    sourceMainGitSha: "a".repeat(40), facilityHeadGitSha: "b".repeat(40), builderGitSha: "c".repeat(40),
    transition: {
      baseSha256: sha(marker), successorSha256: sha(successor),
      sourceMainCandidateSha256: sha(candidate), sourceMainFacilitySha256: "d".repeat(64),
    },
    retainedOutputs: [{ relative: "tools/datapack/release/candidate-build-spec.json", sha256: sha(candidate) }],
    topologyInputs: topologyInputs.map((relativePath) => ({ relativePath, sha256: sha(afterByPath.get(relativePath)) })),
    topologyOutputs: topologyOutputs.map((relativePath) => ({
      relativePath,
      beforeSha256: createOnce.has(relativePath) ? null : sha(beforeByPath.get(relativePath)),
      generatedSha256: sha(generatedByPath.get(relativePath)),
    })),
    replacementPrestates,
  };
  const manifest = {
    accessibilitySourceHandoff,
    topologyInputs, topologyOutputs, liveChainOutputs, fanInPath,
    markerPaths: [
      "tools/datapack/release/current-capital-accessibility-transition.json",
      "tools/datapack/release/current-capital-accessibility-transition-successor.json",
    ],
    markerState: "PRESENT",
    replacementPaths, proof,
    materialization: {
      repository: "AquilaXk/easysubway-data", repositorySha: "e".repeat(40), operationId: "current-capital-673",
      entries: [...liveChainOutputs].sort().map((relativePath) => ({ path: relativePath, sha256: sha(afterByPath.get(relativePath)) })),
      fanIn: { path: fanInPath, sha256: sha(afterByPath.get(fanInPath)) },
    },
  };
  return {
    manifest,
    outputs: replacementPaths.map((relative) => ({
      relative,
      bytes: afterByPath.get(relative),
      prestate: createOnce.has(relative) ? null : { bytes: beforeByPath.get(relative) },
    })),
    marker: { bytes: marker }, successor: { bytes: successor }, fanInPath,
  };
}

async function derivedAbsentTerminalCommitFixture(t, prefix) {
  const parent = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const fixtureSource = await pendingTransitionRepository(t, { initializeGit: true });
  const root = path.join(parent, "derived");
  await cloneCleanFixture(fixtureSource, root);
  const fixture = await terminalCommitFixture(root);
  fixture.manifest.markerState = "DERIVED_ABSENT";
  await Promise.all(fixture.manifest.markerPaths.map((relative) => rm(path.join(root, relative))));
  return { root, fixture };
}

test("terminal CAS verifies proof-bound fan-in and every replacement prestate", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "current-capital-terminal-commit-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const fixtureSource = await pendingTransitionRepository(t, { initializeGit: true });
  const successRoot = path.join(parent, "success");
  await cloneCleanFixture(fixtureSource, successRoot);
  const success = await terminalCommitFixture(successRoot);
  await commitCurrentCapitalTerminalManifest({ repositoryRoot: successRoot, ...success });
  assert.deepEqual(await readFile(path.join(successRoot, success.fanInPath)), success.outputs.find(({ relative }) => relative === success.fanInPath).bytes);

  for (const [name, target] of [
    ["fan-in", success.fanInPath],
    ["route-evaluation", "tools/datapack/release/current-capital-accessibility-full/route-edge-evaluation.json"],
  ]) {
    const tamperedRoot = path.join(parent, `tampered-${name}`);
    await cloneCleanFixture(fixtureSource, tamperedRoot);
    const fixture = await terminalCommitFixture(tamperedRoot);
    await writeFile(path.join(tamperedRoot, target), "foreign replacement");
    await assert.rejects(
      commitCurrentCapitalTerminalManifest({ repositoryRoot: tamperedRoot, ...fixture }),
      /preserves foreign replacement/,
    );
  }
});

test("DERIVED_ABSENT terminal CAS keeps absent markers out of the journaled transaction", async (t) => {
  const { root, fixture } = await derivedAbsentTerminalCommitFixture(
    t,
    "current-capital-terminal-derived-commit-",
  );
  await commitCurrentCapitalTerminalManifest({ repositoryRoot: root, ...fixture });
  await Promise.all(fixture.manifest.markerPaths.map((relative) =>
    assert.rejects(stat(path.join(root, relative)), { code: "ENOENT" })));
});

test("DERIVED_ABSENT terminal recovery rejects marker resurrection before replay", async (t) => {
  const { root, fixture } = await derivedAbsentTerminalCommitFixture(
    t,
    "current-capital-terminal-derived-recovery-",
  );
  const records = fixture.outputs.map(({ relative, bytes, prestate }) => ({
    operation: prestate == null ? "create" : "replace",
    relative,
    before: prestate == null ? null : prestate.bytes.toString("base64"),
    beforeSha256: prestate == null ? null : sha(prestate.bytes),
    after: bytes.toString("base64"),
    afterSha256: sha(bytes),
  }));
  const journalPath = path.join(root, "tools/datapack/.current-capital-terminal-transaction.json");
  await writeFile(journalPath, JSON.stringify({
    schemaVersion: 1,
    state: "PREPARED",
    manifest: fixture.manifest,
    records,
  }));
  const resurrectedPath = path.join(root, fixture.manifest.markerPaths[0]);
  await writeFile(resurrectedPath, fixture.marker.bytes);
  await assert.rejects(
    commitCurrentCapitalTerminalManifest({ repositoryRoot: root, ...fixture }),
    /marker resurrection/,
  );
  assert.equal((await readFile(journalPath)).length > 0, true);
  assert.deepEqual(await readFile(resurrectedPath), fixture.marker.bytes);
});

test("terminal lineage replays the retained FACILITY producer and rejects builder tampering before journaling", async (t) => {
  const { fixtureSource, sourceMainRoot, retainedRoot, privateBuilderRoot } = await terminalLineageRoots(
    t,
    "current-terminal-lineage-",
  );
  const sourceMainGitSha = await cloneCleanFixture(fixtureSource, sourceMainRoot);
  await cloneCleanFixture(fixtureSource, retainedRoot);
  const builderGitSha = await cloneCleanFixture(fixtureSource, privateBuilderRoot);
  const facilityHeadGitSha = await buildRetainedFacilityFixture(retainedRoot);
  const topologyBuild = await currentTopologyFixture(privateBuilderRoot);
  let observedTerminalCandidateId = null;
  const verified = await verifyCurrentCapitalTerminalLineage({
    sourceMainRoot,
    retainedRoot,
    privateBuilderRoot,
    sourceMainGitSha,
    facilityHeadGitSha,
    builderGitSha,
    topologyBuild,
    buildTopologyOutputsImpl: async (options) => {
      observedTerminalCandidateId = options.terminalCandidateId;
      return buildCurrentCapitalTopologyRefreshOutputs(options);
    },
  });
  assert.equal(verified.proof.sourceMainGitSha, sourceMainGitSha);
  assert.equal(verified.proof.facilityHeadGitSha, facilityHeadGitSha);
  assert.equal(verified.proof.builderGitSha, builderGitSha);
  const sourceFacilityBytes = await readFile(path.join(
    sourceMainRoot,
    "tools/datapack/release/current-capital-facility-source-admission.json",
  ));
  const retainedFacilityBytes = await readFile(path.join(
    retainedRoot,
    "tools/datapack/release/current-capital-facility-source-admission.json",
  ));
  assert.deepEqual(verified.successorFacilityBytes, sourceFacilityBytes);
  assert.notDeepEqual(verified.successorFacilityBytes, retainedFacilityBytes);
  assert.equal(verified.topologyInputs.length, 4);
  assert.ok(verified.topologyOutputs.length > 0);
  const retainedCandidate = JSON.parse(await readFile(
    path.join(retainedRoot, "tools/datapack/release/candidate-build-spec.json"),
  ));
  const generatedCandidate = verified.topologyOutputs.find(({ relativePath }) =>
    relativePath === "tools/datapack/release/candidate-build-spec.json");
  assert.ok(generatedCandidate);
  assert.equal(JSON.parse(generatedCandidate.bytes).candidateId, retainedCandidate.candidateId);
  assert.equal(observedTerminalCandidateId, retainedCandidate.candidateId);

  const tamperedPath = path.join(privateBuilderRoot, topologyBuild.capitalTopologyPath);
  await writeFile(tamperedPath, Buffer.concat([await readFile(tamperedPath), Buffer.from("\n")]));
  await assert.rejects(verifyCurrentCapitalTerminalLineage({
    sourceMainRoot,
    retainedRoot,
    privateBuilderRoot,
    sourceMainGitSha,
    facilityHeadGitSha,
    builderGitSha,
    topologyBuild,
  }), /private builder exact clean Git identity mismatch/);
  await assert.rejects(
    stat(path.join(retainedRoot, "tools/datapack/.current-capital-terminal-transaction.json")),
    { code: "ENOENT" },
  );
});

test("DERIVED_ABSENT terminal lineage derives staging-only canonical markers from clean roots", async (t) => {
  const { fixtureSource, sourceMainRoot, retainedRoot, privateBuilderRoot } = await terminalLineageRoots(
    t,
    "current-terminal-derived-absent-",
  );
  await cloneCleanFixture(fixtureSource, sourceMainRoot);
  const sourceMainGitSha = await removeTerminalMarkersAndCommit(sourceMainRoot);
  await cloneCleanFixture(sourceMainRoot, retainedRoot);
  const facilityHeadGitSha = await buildRetainedFacilityFixture(retainedRoot);
  await cloneCleanFixture(sourceMainRoot, privateBuilderRoot);
  const builderGitSha = (await execFile("git", ["rev-parse", "HEAD"], { cwd: privateBuilderRoot })).stdout.trim();
  const topologyBuild = await currentTopologyFixture(privateBuilderRoot);

  const derived = await verifyCurrentCapitalTerminalLineage({
    sourceMainRoot,
    retainedRoot,
    privateBuilderRoot,
    sourceMainGitSha,
    facilityHeadGitSha,
    builderGitSha,
    topologyBuild,
  });
  assert.equal(derived.markerState, "DERIVED_ABSENT");
  assert.equal(Object.hasOwn(derived.proof, "markerState"), false);
  assert.ok(Buffer.isBuffer(derived.marker.bytes));
  assert.ok(Buffer.isBuffer(derived.successor.bytes));
  assert.deepEqual(
    derived.successorFacilityBytes,
    await readFile(path.join(
      retainedRoot,
      "tools/datapack/release/current-capital-facility-source-admission.json",
    )),
  );
  assert.notEqual(sha(derived.marker.bytes), sha(derived.successor.bytes));
  await Promise.all([
    assert.rejects(stat(path.join(sourceMainRoot, "tools/datapack/release/current-capital-accessibility-transition.json")), { code: "ENOENT" }),
    assert.rejects(stat(path.join(retainedRoot, "tools/datapack/release/current-capital-accessibility-transition-successor.json")), { code: "ENOENT" }),
  ]);

  const mixedMarker = "tools/datapack/release/current-capital-accessibility-transition.json";
  await writeFile(path.join(retainedRoot, mixedMarker), await readFile(path.join(fixtureSource, mixedMarker)));
  await execFile("git", ["add", "--", mixedMarker], { cwd: retainedRoot });
  await execFile("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "Create mixed terminal marker fixture"], { cwd: retainedRoot });
  const mixedHead = (await execFile("git", ["rev-parse", "HEAD"], { cwd: retainedRoot })).stdout.trim();
  await assert.rejects(verifyCurrentCapitalTerminalLineage({
    sourceMainRoot,
    retainedRoot,
    privateBuilderRoot,
    sourceMainGitSha,
    facilityHeadGitSha: mixedHead,
    builderGitSha,
    topologyBuild,
  }), /retained terminal marker state mismatch/);
});

test("lineage proof purpose separates topology-derived and protected terminal candidates", () => {
  const topologyDerivedCandidateId = "capital-pilot-candidate-20260902";
  const protectedTerminalCandidateId = "capital-pilot-candidate-20260830";
  assert.notEqual(topologyDerivedCandidateId, protectedTerminalCandidateId);
  assert.equal(terminalCandidateIdForLineageProof({
    proofMode: "IMMUTABLE_PREDECESSOR",
    protectedTerminalCandidateId,
  }), undefined);
  assert.equal(terminalCandidateIdForLineageProof({
    proofMode: "CURRENT_TERMINAL",
    protectedTerminalCandidateId,
  }), protectedTerminalCandidateId);
});

test("ancestor recovery rebuilds only a current-head topology handoff and rejects retained byte drift", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "current-terminal-ancestor-recovery-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const fixtureSource = await pendingTransitionRepository(t, { initializeGit: true });
  const sourceMainRoot = path.join(parent, "source-main");
  const ancestorRetainedRoot = path.join(parent, "ancestor-retained");
  const originalPrivateBuilderRoot = path.join(parent, "original-private-builder");
  const currentRetainedRoot = path.join(parent, "current-retained");
  const sourceMainGitSha = await cloneCleanFixture(fixtureSource, sourceMainRoot);
  await cloneCleanFixture(fixtureSource, ancestorRetainedRoot);
  const originalBuilderGitSha = await cloneCleanFixture(fixtureSource, originalPrivateBuilderRoot);
  const ancestorFacilityHeadGitSha = await buildRetainedFacilityFixture(ancestorRetainedRoot);
  const topologyBuild = await currentTopologyFixture(originalPrivateBuilderRoot);
  const originalProof = await verifyCurrentCapitalTerminalLineage({
    sourceMainRoot, retainedRoot: ancestorRetainedRoot, privateBuilderRoot: originalPrivateBuilderRoot,
    sourceMainGitSha, facilityHeadGitSha: ancestorFacilityHeadGitSha, builderGitSha: originalBuilderGitSha,
    topologyBuild, proofMode: "CURRENT_TERMINAL",
  });
  const originalTopologyHandoff = await buildCurrentCapitalTopologyTerminalHandoff({
    repository: "AquilaXk/easysubway-data", operationId: "kric-exit-full-capital-refresh-123",
    sourceMainGitSha, facilityBranch: "automation/629-kric-facility-refresh-123",
    facilityHeadGitSha: ancestorFacilityHeadGitSha, builderGitSha: originalBuilderGitSha,
    topologyBuild, privateBuilderRoot: originalPrivateBuilderRoot, proof: originalProof.proof,
    accessibilitySourceHandoff: terminalAccessibilitySourceHandoff({
      operationId: "kric-exit-full-capital-refresh-123",
      sourceMainGitSha,
      facilityHeadSha: ancestorFacilityHeadGitSha,
    }),
  });
  await cloneCleanFixture(ancestorRetainedRoot, currentRetainedRoot);
  await writeFile(path.join(currentRetainedRoot, "recovery-note.txt"), "current head only\n");
  await execFile("git", ["add", "--", "recovery-note.txt"], { cwd: currentRetainedRoot });
  await execFile("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "Advance current FACILITY head"], { cwd: currentRetainedRoot });
  const currentFacilityHeadGitSha = (await execFile("git", ["rev-parse", "HEAD"], { cwd: currentRetainedRoot })).stdout.trim();

  const observedProofModes = [];
  const rebuilt = await rebuildCurrentCapitalTopologyTerminalHandoffForAncestorRecovery({
    repository: "AquilaXk/easysubway-data", sourceMainRoot, sourceMainGitSha,
    ancestorRetainedRoot, ancestorFacilityHeadGitSha, originalPrivateBuilderRoot, originalBuilderGitSha,
    currentRetainedRoot, currentFacilityBranch: "automation/629-kric-facility-refresh-123",
    currentFacilityHeadGitSha, topologyBuild,
    topologyHandoffBytes: Buffer.from(`${canonicalJson(originalTopologyHandoff)}\n`),
    accessibilitySourceHandoff: terminalAccessibilitySourceHandoff({
      operationId: "kric-exit-full-capital-refresh-123",
      sourceMainGitSha,
      facilityHeadSha: currentFacilityHeadGitSha,
    }),
    verifyTerminalLineageImpl: async (options) => {
      observedProofModes.push(options.proofMode);
      return verifyCurrentCapitalTerminalLineage(options);
    },
  });
  assert.deepEqual(observedProofModes, ["CURRENT_TERMINAL", "CURRENT_TERMINAL"]);
  assert.equal(rebuilt.topologyHandoff.operationId, originalTopologyHandoff.operationId);
  assert.equal(rebuilt.topologyHandoff.schemaVersion, 2);
  assert.equal(rebuilt.topologyHandoff.facility.headSha, currentFacilityHeadGitSha);
  assert.equal(rebuilt.topologyHandoff.builderGitSha, originalBuilderGitSha);
  assert.deepEqual(
    rebuilt.topologyHandoff.accessibilitySourceHandoff,
    terminalAccessibilityProjection(rebuilt.accessibilitySourceHandoff),
  );
  assert.equal(originalTopologyHandoff.lineageProofSha256, sha(Buffer.from(canonicalJson(rebuilt.originalProof))));
  assert.equal(rebuilt.topologyHandoff.lineageProofSha256, sha(Buffer.from(canonicalJson(rebuilt.currentProof))));
  assert.notEqual(originalTopologyHandoff.lineageProofSha256, rebuilt.topologyHandoff.lineageProofSha256);
  assert.notEqual(rebuilt.topologyHandoff.handoffSha256, originalTopologyHandoff.handoffSha256);

  const driftPath = path.join(currentRetainedRoot, "tools/datapack/release/candidate-build-spec.json");
  await writeFile(driftPath, Buffer.concat([await readFile(driftPath), Buffer.from("\n")]));
  await execFile("git", ["add", "--", "tools/datapack/release/candidate-build-spec.json"], { cwd: currentRetainedRoot });
  await execFile("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "Drift retained candidate"], { cwd: currentRetainedRoot });
  const driftedCurrentFacilityHeadGitSha = (await execFile("git", ["rev-parse", "HEAD"], { cwd: currentRetainedRoot })).stdout.trim();
  await assert.rejects(rebuildCurrentCapitalTopologyTerminalHandoffForAncestorRecovery({
    repository: "AquilaXk/easysubway-data", sourceMainRoot, sourceMainGitSha,
    ancestorRetainedRoot, ancestorFacilityHeadGitSha, originalPrivateBuilderRoot, originalBuilderGitSha,
    currentRetainedRoot, currentFacilityBranch: "automation/629-kric-facility-refresh-123",
    currentFacilityHeadGitSha: driftedCurrentFacilityHeadGitSha,
    topologyBuild, topologyHandoffBytes: Buffer.from(`${canonicalJson(originalTopologyHandoff)}\n`),
    accessibilitySourceHandoff: terminalAccessibilitySourceHandoff({
      operationId: "kric-exit-full-capital-refresh-123",
      sourceMainGitSha,
      facilityHeadSha: driftedCurrentFacilityHeadGitSha,
    }),
  }), /ancestor recovery retained terminal input mismatch/);
});

test("EXIT-only producer refuses provider access without a validated same-repository FACILITY PR", async () => {
  await assert.rejects(runCurrentCapitalExitOnlyProducer({
    repositoryRoot: "/repository", runnerTemp: "/runner", handoffDirectory: "/handoff", repository: "AquilaXk/easysubway-data",
    repositorySha: "a".repeat(40), operationId: "current-capital-647",
    env: { KRIC_SERVICE_KEY: "key", EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/token/n/axvym6vk8g7i/b/easysubway-datapacks/o/" },
    execFileImpl: async () => { throw new Error("provider boundary must not start"); },
  }), /validated same-repository FACILITY pull request is required/);
});

async function rejectExitOnlyProducerAtPreflight({
  topologyFailure,
  facilityFailure,
  privateBuilderRoot = ROOT,
  accessibilitySourceHandoff = { outputs: [] },
  afterVerification,
  expectedFailure,
  inspectFacility,
  verificationFailure,
}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "current-exit-producer-facility-paths-"));
  const runnerTemp = path.join(temporary, "runner");
  const handoffParent = path.join(temporary, "handoff-parent");
  const required = [
    "tools/datapack/release/candidate-build-spec.json",
    "tools/datapack/release/current-capital-facility-source-admission.json",
    "tools/datapack/release/source-snapshots.json",
    "tools/datapack/source-inventory.json",
    "tools/datapack/release/release-request.json",
    "tools/datapack/release/hash-evidence.json",
    "tools/datapack/sources/kric-station-convenience-standard-fixture.json",
  ];
  let reachedPlanning = false;
  let stagedCandidateEvidenceVerified = false;
  let topologyPreflightReached = false;
  let facilityPreflightReached = false;
  let providerCalls = 0;
  let publicationCalls = 0;
  try {
    await mkdir(runnerTemp); await mkdir(handoffParent);
    await assert.rejects(runCurrentCapitalExitOnlyProducer({
      repositoryRoot: ROOT,
      retainedRoot: ROOT,
      privateBuilderRoot,
      builderGitSha: "b".repeat(40),
      topologyBuild: {
        buildNow: "2099-01-01T00:00:00.000Z",
        capitalTopologyPath: "tools/datapack/sources/capital-route-topology-20990101.json",
        incheonTopologyPath: "tools/datapack/sources/incheon-transit-station-info-20990101.json",
        incheonAccessibilityPath: "tools/datapack/sources/incheon-transit-accessibility-20990101T000000000Z.json",
        incheonLine1TimetablePath: "tools/datapack/sources/incheon-line1-train-timetable-20990101.json",
        incheonLine2TimetablePath: "tools/datapack/sources/incheon-line2-train-timetable-20990101.json",
        itxCurrentAdmissionPath: null,
        itxTopologyEvidencePath: "tools/datapack/itx-cheongchun-topology-evidence-20990101000000000.json",
      },
      runnerTemp,
      handoffDirectory: path.join(handoffParent, "handoff"),
      repository: "AquilaXk/easysubway-data",
      repositorySha: "a".repeat(40),
      operationId: "current-capital-647",
      facilityPullRequest: {
        repository: "AquilaXk/easysubway-data",
        branch: "automation/629-kric-facility-refresh-123",
        headSha: "b".repeat(40),
      },
      accessibilitySourceHandoff,
      verifyAccessibilityHandoffImpl: async () => {
        if (verificationFailure) throw new Error(verificationFailure);
        if (afterVerification) await afterVerification();
        return accessibilitySourceHandoff;
      },
      env: {
        PATH: process.env.PATH,
        KRIC_SERVICE_KEY: "test-key",
        EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/test/n/axvym6vk8g7i/b/easysubway-datapacks/o/",
      },
      verifyTerminalLineageImpl: async () => ({
        proof: {},
        topologyInputs: [
          "capital-route-topology-20990101.json",
          "incheon-transit-station-info-20990101.json",
          "incheon-line1-train-timetable-20990101.json",
          "incheon-line2-train-timetable-20990101.json",
        ].map((name) => ({ relativePath: `tools/datapack/sources/${name}`, bytes: Buffer.from(`fixture:${name}`) })),
        topologyOutputs: [{
          relativePath: "tools/datapack/source-inventory.json",
          bytes: await readFile(path.join(privateBuilderRoot, "tools/datapack/source-inventory.json")),
        }],
      }),
      buildTopologyHandoffImpl: async () => ({ schemaVersion: 1, artifactKind: "test-topology-handoff" }),
      execFileImpl: async (commandPath, args, options) => {
        const command = args.join(" ");
        if (command === "remote get-url origin") return { stdout: "https://github.com/AquilaXk/easysubway-data.git\n" };
        if (command === "rev-parse HEAD" || command === "rev-parse origin/main") return { stdout: `${"a".repeat(40)}\n` };
        if (command === "branch --show-current") return { stdout: "main\n" };
        if (command === "status --porcelain=v1 --untracked-files=all") return { stdout: "" };
        if (command === "ls-remote --exit-code https://github.com/AquilaXk/easysubway-data.git refs/heads/main") return { stdout: `${"a".repeat(40)}\trefs/heads/main\n` };
        if (command === "rev-parse refs/remotes/origin/automation/629-kric-facility-refresh-123") return { stdout: `${"b".repeat(40)}\n` };
        if (command === `merge-base --is-ancestor ${"a".repeat(40)} ${"b".repeat(40)}`) return { stdout: "" };
        if (command === `diff --name-only ${"a".repeat(40)} ${"b".repeat(40)}`) return { stdout: `${required.join("\n")}\n` };
        if (args[0] === "tools/datapack/build-current-kric-exit-collection-plan.mjs") {
          const canonicalPackPath = args[args.indexOf("--canonical-pack") + 1];
          const stagedRoot = path.resolve(path.dirname(canonicalPackPath), "../../..");
          const candidate = JSON.parse(await readFile(path.join(stagedRoot, "tools/datapack/release/candidate-build-spec.json"), "utf8"));
          await stat(path.join(stagedRoot, candidate.itxTopologyEvidencePath));
          await stat(path.join(stagedRoot, candidate.networkEdgeEvidence.itxCoverageContract.path));
          await assert.rejects(stat(path.join(stagedRoot, "tools/datapack/itx-cheongchun-topology-evidence.json")), { code: "ENOENT" });
          await assert.rejects(stat(path.join(stagedRoot, "tools/datapack/release/current-capital-live-chain-fan-in.json")), { code: "ENOENT" });
          stagedCandidateEvidenceVerified = true;
          reachedPlanning = true;
          return execFile(commandPath, args, options);
        }
        if (args[0] === "tools/datapack/collect-current-kric-exit-path-provider-snapshot.mjs") providerCalls += 1;
        throw new Error(`provider boundary must not start: ${command}`);
      },
      assertCurrentTopologyAdmissionImpl: async () => {
        topologyPreflightReached = true;
        if (topologyFailure) throw new Error(topologyFailure);
      },
      assertCurrentFacilityAdmissionImpl: async ({ stagedRoot }) => {
        facilityPreflightReached = true;
        if (inspectFacility) await inspectFacility(stagedRoot);
        if (facilityFailure) throw new Error(facilityFailure);
      },
      publishImpl: async () => { publicationCalls += 1; throw new Error("OCI publication must not start"); },
    }), new RegExp(expectedFailure ?? verificationFailure ?? topologyFailure ?? facilityFailure));
    return { reachedPlanning, stagedCandidateEvidenceVerified, topologyPreflightReached, facilityPreflightReached, providerCalls, publicationCalls };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test("EXIT-only producer validates staged inputs and topology before provider or OCI", async () => {
  const result = await rejectExitOnlyProducerAtPreflight({ topologyFailure: "producer topology preflight reached" });
  assert.deepEqual(result, {
    reachedPlanning: true,
    stagedCandidateEvidenceVerified: true,
    topologyPreflightReached: true,
    facilityPreflightReached: false,
    providerCalls: 0,
    publicationCalls: 0,
  });
});

test("EXIT-only producer validates FACILITY after topology and before provider or OCI", async () => {
  const result = await rejectExitOnlyProducerAtPreflight({ facilityFailure: "current capital facility admission is stale" });
  assert.deepEqual(result, {
    reachedPlanning: true,
    stagedCandidateEvidenceVerified: true,
    topologyPreflightReached: true,
    facilityPreflightReached: true,
    providerCalls: 0,
    publicationCalls: 0,
  });
});

test("EXIT-only producer verifies accessibility outputs before preflight", async () => {
  const result = await rejectExitOnlyProducerAtPreflight({
    verificationFailure: "prepared output digest mismatch",
    facilityFailure: "facility preflight must not start",
  });
  assert.deepEqual(result, {
    reachedPlanning: false,
    stagedCandidateEvidenceVerified: false,
    topologyPreflightReached: false,
    facilityPreflightReached: false,
    providerCalls: 0,
    publicationCalls: 0,
  });
});

test("EXIT-only producer rejects accessibility bytes changed after verification", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "current-exit-producer-accessibility-drift-"));
  const privateBuilderRoot = path.join(temporary, "private-builder");
  const inventoryPath = "tools/datapack/source-inventory.json";
  const outputPath = "tools/datapack/sources/seoul-accessibility-test.json";
  const verifiedBytes = Buffer.from('{"identity":"verified"}\n');
  try {
    await mkdir(path.join(privateBuilderRoot, "tools/datapack/sources"), { recursive: true });
    await writeFile(
      path.join(privateBuilderRoot, inventoryPath),
      await readFile(path.join(ROOT, inventoryPath)),
    );
    await writeFile(path.join(privateBuilderRoot, outputPath), verifiedBytes);
    const result = await rejectExitOnlyProducerAtPreflight({
      privateBuilderRoot,
      accessibilitySourceHandoff: {
        outputs: [{
          relativePath: outputPath,
          operation: "create",
          afterSha256: sha(verifiedBytes),
        }],
      },
      afterVerification: () => writeFile(
        path.join(privateBuilderRoot, outputPath),
        '{"identity":"changed"}\n',
      ),
      expectedFailure: "prepared accessibility source output digest mismatch",
      facilityFailure: "facility preflight must not start",
    });
    assert.deepEqual(result, {
      reachedPlanning: false,
      stagedCandidateEvidenceVerified: false,
      topologyPreflightReached: false,
      facilityPreflightReached: false,
      providerCalls: 0,
      publicationCalls: 0,
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("EXIT-only producer applies authenticated accessibility outputs before preflight", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "current-exit-producer-accessibility-overlay-"));
  const privateBuilderRoot = path.join(temporary, "private-builder");
  const inventoryPath = "tools/datapack/source-inventory.json";
  try {
    const inventory = JSON.parse(await readFile(path.join(ROOT, inventoryPath), "utf8"));
    inventory.testPreparedAccessibilityIdentity = "refreshed-seoul";
    const inventoryBytes = Buffer.from(`${JSON.stringify(inventory)}\n`);
    await mkdir(path.join(privateBuilderRoot, "tools/datapack"), { recursive: true });
    await writeFile(path.join(privateBuilderRoot, inventoryPath), inventoryBytes);
    const result = await rejectExitOnlyProducerAtPreflight({
      facilityFailure: "producer facility preflight reached",
      privateBuilderRoot,
      accessibilitySourceHandoff: {
        outputs: [{
          relativePath: inventoryPath,
          operation: "replace",
          afterSha256: sha(inventoryBytes),
        }],
      },
      inspectFacility: async (stagedRoot) => {
        const stagedInventory = JSON.parse(await readFile(path.join(stagedRoot, inventoryPath), "utf8"));
        assert.equal(stagedInventory.testPreparedAccessibilityIdentity, "refreshed-seoul");
      },
    });
    assert.deepEqual(result, {
      reachedPlanning: true,
      stagedCandidateEvidenceVerified: true,
      topologyPreflightReached: true,
      facilityPreflightReached: true,
      providerCalls: 0,
      publicationCalls: 0,
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

function terminalGitPreflight(command, args) {
  if (command !== "git") throw new Error("only terminal child scripts may execute outside git preflight");
  const key = args.join(" ");
  const values = new Map([
    ["remote get-url origin", "https://github.com/AquilaXk/easysubway-data.git\n"],
    ["branch --show-current", "automation/629-kric-facility-refresh-647\n"],
    ["rev-parse HEAD", `${"b".repeat(40)}\n`],
    ["rev-parse --abbrev-ref --symbolic-full-name @{upstream}", "origin/automation/629-kric-facility-refresh-647\n"],
    ["rev-parse @{upstream}", `${"b".repeat(40)}\n`],
    ["status --porcelain=v1 --untracked-files=all", ""],
  ]);
  if (!values.has(key)) throw new Error(`unexpected terminal git preflight: ${key}`);
  return Promise.resolve({ stdout: values.get(key) });
}

function memoryOciObject(bytes, key) {
  let gets = 0;
  return {
    get gets() { return gets; },
    async readObject(requestedKey) {
      gets += 1;
      return requestedKey === key ? { exists: true, body: Buffer.from(bytes) } : { exists: false };
    },
  };
}

async function terminalProviderHandoff({ repositoryRoot = ROOT, mutatePlan = (plan) => plan } = {}) {
  const paths = {
    canonicalPackBytes: "tools/datapack/release/capital-production-canonical-pack.json",
    coverageTargetsBytes: "tools/datapack/nationwide-coverage-targets.json",
    providerCodeCatalogBytes: "tools/datapack/sources/kric-provider-code-catalog-20260228.json",
    routeRostersBytes: "tools/datapack/sources/kric-nationwide-route-rosters-20260730T203926676Z.json",
    sourceInventoryBytes: "tools/datapack/source-inventory.json",
  };
  const input = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, relative]) =>
    [key, await readFile(path.join(repositoryRoot, relative))],
  )));
  const inventory = JSON.parse(input.sourceInventoryBytes);
  const incheon = inventory.sources.find(({ id }) => id === "incheon-transit-station-info").topologyAdmissionEvidence;
  input.incheonTopologyBytes = await readFile(path.join(repositoryRoot, incheon.snapshotPath));
  const operationNow = await nextSyntheticCurrentStaticNetworkNow(repositoryRoot);
  const capturedAt = operationNow.toISOString();
  const plan = buildCurrentKricExitCollectionPlan(input, {
    now: operationNow, coverageSelector: "capital-seoul-metro-production",
  });
  plan.candidate.candidateId = `${plan.candidate.candidateId}-source`;
  mutatePlan(plan);
  delete plan.collectionPlanDigest;
  plan.collectionPlanDigest = sha(canonical(plan));
  const planBytes = Buffer.from(canonicalKricExitPathCollectionPlanJson(plan));
  const rows = [{ edMovePath: null, elvtSttCd: null, elvtTpCd: null, exitMvTpOrdr: "1", imgPath: null, mvContDtl: null, mvPathMgNo: "1", stMovePath: null }];
  const results = plan.queryPlan.map((query, index) => ({
    queryId: query.queryId, state: index === 0 ? "ROWS_OBSERVED" : "EXPLICIT_ZERO", providerResultCode: "00",
    rawResponseSha256: sha(`terminal-raw-${index}`), rawResponseByteSize: 1,
    providerRecordHash: sha(canonical(index === 0 ? rows : [])), rows: index === 0 ? rows : [],
  }));
  const snapshotPayload = {
    schemaVersion: 1, artifactKind: "kric-exit-path-provider-snapshot", sourceId: "kric-station-movement-standard",
    snapshotId: `kric-station-movement-standard-${capturedAt.replaceAll(/[-:.]/gu, "")}`,
    capturedAt,
    freshUntil: new Date(operationNow.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    credentialRedacted: true,
    collectionPlanDigest: plan.collectionPlanDigest, queryPlanSha256: plan.queryPlanSha256,
    coverage: { requestPlanComplete: true, queryIds: plan.queryPlan.map(({ queryId }) => queryId) }, queryPlan: plan.queryPlan, results,
  };
  const snapshotBytes = Buffer.from(canonical({ ...snapshotPayload, snapshotDigest: sha(canonical(snapshotPayload)) }));
  const receipt = buildCurrentKricExitCollectionReceipt({
    collectionPlanBytes: planBytes, providerSnapshotBytes: snapshotBytes,
    repository: "AquilaXk/easysubway-data", repositorySha: "a".repeat(40), operationId: "current-capital-560",
  });
  const bundleBytes = Buffer.from(canonicalCurrentKricExitCollectionBundleJson(buildCurrentKricExitCollectionBundle({
    collectionPlanBytes: planBytes, providerSnapshotBytes: snapshotBytes, receipt,
  })));
  const providerPlan = buildCurrentKricExitProviderOciPlan({
    mainSha: "a".repeat(40), operationId: "current-capital-560", providerCollectionBundleBytes: bundleBytes,
    providerCapturedAt: capturedAt,
  });
  const providerOciPlanBytes = Buffer.from(`${canonicalCurrentKricExitProviderOciPlanJson(providerPlan)}\n`);
  const providerOciReceiptBytes = Buffer.from(`${canonicalCurrentKricExitProviderOciReceiptJson(
    buildCurrentKricExitProviderOciReceipt({ planBytes: providerOciPlanBytes }), { planBytes: providerOciPlanBytes },
  )}\n`);
  const source = buildCurrentCapitalExitProviderSourceHandoffFromProviderOci({
    providerOciPlanBytes, providerOciReceiptBytes, fetchedProviderCollectionBundleBytes: bundleBytes,
    repository: "AquilaXk/easysubway-data", repositorySha: "a".repeat(40), operationId: "current-capital-560",
  });
  return {
    operationNow, bundleBytes, providerObject: providerPlan.providerObject,
    providerOciPlanBytes, providerOciReceiptBytes,
    sourceReceiptBytes: Buffer.from(`${canonicalCurrentCapitalExitProviderSourceHandoffJson(source)}\n`),
  };
}

function changeProviderMappingIdentity(plan) {
  const mapping = plan.providerMappings[0];
  const stationLineId = `${mapping.stationId}:${mapping.lineId}`;
  const stationLineQueries = plan.stationLineQueries.find((entry) => entry.stationLineId === stationLineId);
  const affectedQueryIds = new Set(stationLineQueries.queryIds);
  mapping.providerOperatorId = `${mapping.providerOperatorId}-source`;
  plan.candidate.providerMappingSha256 = sha(canonical(plan.providerMappings));
  const replacementIds = new Map();
  for (const query of plan.queryPlan) {
    if (!affectedQueryIds.has(query.queryId)) continue;
    const previousId = query.queryId;
    query.providerOperatorId = mapping.providerOperatorId;
    query.queryId = sha(canonical({
      providerLineId: query.providerLineId,
      providerNextStationId: query.providerNextStationId,
      providerOperatorId: query.providerOperatorId,
      providerStationId: query.providerStationId,
      routeEdgeId: query.routeEdgeId,
    }));
    replacementIds.set(previousId, query.queryId);
  }
  stationLineQueries.queryIds = stationLineQueries.queryIds.map((queryId) => replacementIds.get(queryId));
  const compareQuery = (left, right) => Buffer.compare(Buffer.from(left.providerStationId), Buffer.from(right.providerStationId))
    || Buffer.compare(Buffer.from(left.providerNextStationId), Buffer.from(right.providerNextStationId))
    || Buffer.compare(Buffer.from(left.routeEdgeId), Buffer.from(right.routeEdgeId))
    || Buffer.compare(Buffer.from(left.queryId), Buffer.from(right.queryId));
  plan.queryPlan.sort(compareQuery);
  const queryById = new Map(plan.queryPlan.map((query) => [query.queryId, query]));
  stationLineQueries.queryIds.sort((left, right) => compareQuery(queryById.get(left), queryById.get(right)));
  plan.queryPlanSha256 = sha(canonical(plan.queryPlan));
}

test("terminal consumer orders P/T/F and CAS before one OCI recovery and semantic refresh", async (t) => {
  const runnerTemp = await mkdtemp(path.join(os.tmpdir(), "current-capital-terminal-consumer-"));
  t.after(() => rm(runnerTemp, { recursive: true, force: true }));
  const repositoryRoot = await pendingTransitionRepository(t);
  const handoff = await terminalProviderHandoff({ repositoryRoot });
  const preparedRoot = path.join(runnerTemp, "prepared-accessibility");
  const accessibilityPath = "tools/datapack/sources/seoul-metro-accessibility-20990101T000000000Z.json";
  const accessibilityBytes = Buffer.from("prepared fresh accessibility\n");
  await mkdir(path.join(preparedRoot, path.dirname(accessibilityPath)), { recursive: true });
  await writeFile(path.join(preparedRoot, accessibilityPath), accessibilityBytes);
  const accessibilitySourceHandoff = await terminalAccessibilityVerifierResult(repositoryRoot, [{
      relativePath: accessibilityPath,
      operation: "create",
      beforeSha256: null,
      afterSha256: sha(accessibilityBytes),
    }]);
  // Ancestor recovery retains KRIC, but its prior replacement remains part
  // of the immutable-base predecessor advancement alongside refreshed Seoul.
  accessibilitySourceHandoff.sources.find(({ sourceId }) =>
    sourceId === "kric-station-convenience-standard").action = "RETAIN";
  const markers = [
    "tools/datapack/release/current-capital-accessibility-transition.json",
    "tools/datapack/release/current-capital-accessibility-transition-successor.json",
  ];
  const rootPrestates = await Promise.all([
    "tools/datapack/release/candidate-build-spec.json", ...markers,
  ].map(async (relative) => [relative, await readFile(path.join(repositoryRoot, relative))]));
  const retainedFacilityBytes = await readFile(path.join(
    repositoryRoot,
    "tools/datapack/release/current-capital-facility-source-admission.json",
  ));
  const stagedFacility = JSON.parse(retainedFacilityBytes);
  stagedFacility.candidate.sourceSnapshotSetHash = "f".repeat(64);
  delete stagedFacility.admissionDigest;
  stagedFacility.admissionDigest = sha(canonicalJson(stagedFacility));
  const stagedFacilityBytes = Buffer.from(canonicalCurrentCapitalFacilitySourceAdmissionJson(stagedFacility));
  const calls = [];
  const client = memoryOciObject(handoff.bundleBytes, handoff.providerObject.objectKey);
  const stageRoots = [];
  let terminalCommit;
  const result = await runCurrentCapitalExitTerminalConsumer({
    repositoryRoot, runnerTemp, repository: "AquilaXk/easysubway-data", candidateOperationId: "current-capital-647",
    sourceMainRoot: repositoryRoot, sourceMainGitSha: "a".repeat(40), privateBuilderRoot: preparedRoot, builderGitSha: "b".repeat(40), topologyBuild: {
      buildNow: "2026-09-01T00:00:00.000Z", capitalTopologyPath: "tools/datapack/sources/capital-route-topology-20260901.json",
      incheonAccessibilityPath: "tools/datapack/sources/incheon-transit-accessibility-20260901.json", incheonLine1TimetablePath: "tools/datapack/sources/incheon-line1-train-timetable-20260901.json",
      incheonLine2TimetablePath: "tools/datapack/sources/incheon-line2-train-timetable-20260901.json", incheonTopologyPath: "tools/datapack/sources/incheon-transit-station-info-20260901.json",
      itxCurrentAdmissionPath: "tools/datapack/release/current-itx-admission.json", itxTopologyEvidencePath: "tools/datapack/itx-topology-evidence.json",
    }, topologyHandoffBytes: Buffer.from("{}\n"), accessibilitySourceHandoffBytes: Buffer.from("{}\n"), verifyTerminalLineageImpl: async () => ({
      markerState: "PRESENT", proof: await terminalConsumerProof(repositoryRoot),
      successorFacilityBytes: retainedFacilityBytes, topologyInputs: [], topologyOutputs: [],
    }),
    verifyTopologyHandoffImpl: () => ({
      operationId: "current-capital-560",
      accessibilitySourceHandoff: terminalAccessibilityProjection(accessibilitySourceHandoff),
    }),
    verifyAccessibilityHandoffImpl: async () => accessibilitySourceHandoff,
    commitTerminalManifestImpl: async (input) => { terminalCommit = input; return { repositoryRoot: stageRoots[0] }; },
    operationNow: handoff.operationNow, sourceReceiptBytes: handoff.sourceReceiptBytes,
    providerOciPlanBytes: handoff.providerOciPlanBytes, providerOciReceiptBytes: handoff.providerOciReceiptBytes,
    client, isAncestor: async (from, to) => from === "a".repeat(40) && to === "b".repeat(40),
    transferObservationDirectory: "/retained/transfer/observation", transferReceiptPath: "/retained/transfer/receipt.json",
    execFileImpl: async (command, args, options) => command === "git"
      ? terminalGitPreflight(command, args)
      : (await import("node:child_process")).execFileSync(command, args, options),
    rebindPublicRouteMapImpl: async ({ repositoryRoot }) => {
      calls.push("P"); stageRoots.push(repositoryRoot);
      assert.deepEqual(await readFile(path.join(repositoryRoot, accessibilityPath)), accessibilityBytes);
      await writeFile(
        path.join(repositoryRoot, "tools/datapack/release/current-capital-facility-source-admission.json"),
        stagedFacilityBytes,
      );
    },
    rebindTransferImpl: async ({ repositoryRoot }) => {
      calls.push("T");
      assert.equal(repositoryRoot, stageRoots[0]);
      return unchangedTransferRebindProof({ repositoryRoot });
    },
    rebindFacilityImpl: async ({
      repositoryRoot,
      replaceExistingSuccessor,
      allowedPredecessorSourceIds,
      existingSuccessorFacilityBytes,
    }) => {
      calls.push("F");
      assert.equal(repositoryRoot, stageRoots[0]);
      assert.equal(replaceExistingSuccessor, true);
      assert.deepEqual(existingSuccessorFacilityBytes, retainedFacilityBytes);
      assert.deepEqual(
        await readFile(path.join(repositoryRoot, "tools/datapack/release/current-capital-facility-source-admission.json")),
        stagedFacilityBytes,
      );
      await writeFile(
        path.join(repositoryRoot, "tools/datapack/release/current-capital-facility-source-admission.json"),
        retainedFacilityBytes,
      );
      assert.deepEqual(allowedPredecessorSourceIds, [
        "kric-station-convenience-standard",
        "seoul-metro-accessibility",
      ]);
    },
  });
  assert.deepEqual(calls, ["P", "T", "F"]);
  assert.equal(client.gets, 1);
  assert.deepEqual({ providerCalls: result.providerCalls, ociGetCalls: result.ociGetCalls, ociPutCalls: result.ociPutCalls }, { providerCalls: 0, ociGetCalls: 1, ociPutCalls: 0 });
  assert.equal(result.outputPaths.length, 17);
  assert.equal(result.fanInPath, "tools/datapack/release/current-capital-live-chain-fan-in.json");
  assert.equal(result.markerState, "PRESENT");
  assert.ok(terminalCommit);
  assert.equal(terminalCommit.manifest.accessibilitySourceHandoff, accessibilitySourceHandoff);
  assert.equal(terminalCommit.outputs.length, new Set(terminalCommit.manifest.replacementPaths).size);
  assert.equal(terminalCommit.outputs.filter(({ prestate }) => prestate == null).length, 1);
  assert.deepEqual(terminalCommit.manifest.liveChainOutputs, result.outputPaths);
  await Promise.all(result.outputPaths.map((relative) => stat(path.join(result.stagedRoot, relative))));
  await stat(path.join(result.stagedRoot, result.fanInPath));
  await Promise.all(markers.map((relative) => assert.rejects(stat(path.join(result.stagedRoot, relative)), { code: "ENOENT" })));
  assert.deepEqual(result.deletedMarkerPaths, markers);
  await assert.rejects(stat(path.join(repositoryRoot, accessibilityPath)), { code: "ENOENT" });
  for (const [relative, before] of rootPrestates) {
    assert.deepEqual(await readFile(path.join(repositoryRoot, relative)), before, `source root mutated: ${relative}`);
  }
});

test("terminal consumer stops before OCI recovery when route-map rebind fails", async (t) => {
  const runnerTemp = await mkdtemp(path.join(os.tmpdir(), "current-capital-terminal-route-map-failure-"));
  t.after(() => rm(runnerTemp, { recursive: true, force: true }));
  const repositoryRoot = await pendingTransitionRepository(t);
  const handoff = await terminalProviderHandoff({ repositoryRoot });
  const sourceReceipt = JSON.parse(handoff.sourceReceiptBytes);
  const accessibilitySourceHandoff = await terminalAccessibilityVerifierResult(repositoryRoot);
  const client = memoryOciObject(handoff.bundleBytes, handoff.providerObject.objectKey);
  const terminalHeadSha = (await terminalGitPreflight("git", ["rev-parse", "HEAD"])).stdout.trim();
  await assert.rejects(runCurrentCapitalExitTerminalConsumer({
    repositoryRoot,
    sourceMainRoot: repositoryRoot,
    sourceMainGitSha: sourceReceipt.sourceMainSha,
    privateBuilderRoot: repositoryRoot,
    builderGitSha: terminalHeadSha,
    topologyBuild: await currentTopologyFixture(repositoryRoot),
    topologyHandoffBytes: Buffer.from("{}\n"),
    accessibilitySourceHandoffBytes: Buffer.from("{}\n"),
    runnerTemp,
    repository: sourceReceipt.repository,
    candidateOperationId: `${sourceReceipt.sourceOperationId}-candidate`,
    operationNow: handoff.operationNow,
    sourceReceiptBytes: handoff.sourceReceiptBytes,
    providerOciPlanBytes: handoff.providerOciPlanBytes,
    providerOciReceiptBytes: handoff.providerOciReceiptBytes,
    client,
    isAncestor: async () => true,
    transferObservationDirectory: path.join(runnerTemp, "unused-transfer-observation"),
    transferReceiptPath: path.join(runnerTemp, "unused-transfer-receipt.json"),
    execFileImpl: terminalGitPreflight,
    verifyTerminalLineageImpl: async () => ({
      markerState: "PRESENT", proof: await terminalConsumerProof(repositoryRoot),
      successorFacilityBytes: await readFile(path.join(
        repositoryRoot,
        "tools/datapack/release/current-capital-facility-source-admission.json",
      )),
      topologyInputs: [],
      topologyOutputs: [],
    }),
    verifyTopologyHandoffImpl: () => ({
      operationId: sourceReceipt.sourceOperationId,
      accessibilitySourceHandoff: terminalAccessibilityProjection(accessibilitySourceHandoff),
    }),
    verifyAccessibilityHandoffImpl: async () => accessibilitySourceHandoff,
    rebindPublicRouteMapImpl: async () => { throw new Error("route-map rebind failed"); },
  }), /route-map rebind failed/);
  assert.equal(client.gets, 0);
});

test("terminal consumer rejects accessibility identity outside the topology v2 projection", async (t) => {
  const runnerTemp = await mkdtemp(path.join(os.tmpdir(), "current-capital-terminal-accessibility-identity-"));
  t.after(() => rm(runnerTemp, { recursive: true, force: true }));
  const repositoryRoot = await pendingTransitionRepository(t);
  const operationNow = (await currentTopologyAdmissionClock(repositoryRoot)).inWindow;
  const accessibilitySourceHandoff = await terminalAccessibilityVerifierResult(repositoryRoot);
  let rebindStarted = false;
  await assert.rejects(runCurrentCapitalExitTerminalConsumer({
    repositoryRoot,
    sourceMainRoot: repositoryRoot,
    sourceMainGitSha: "a".repeat(40),
    privateBuilderRoot: repositoryRoot,
    builderGitSha: "b".repeat(40),
    topologyBuild: {},
    topologyHandoffBytes: Buffer.from("{}\n"),
    accessibilitySourceHandoffBytes: Buffer.from("{}\n"),
    runnerTemp,
    repository: "AquilaXk/easysubway-data",
    candidateOperationId: "current-capital-647",
    operationNow,
    sourceReceiptBytes: Buffer.from("{}\n"),
    providerOciPlanBytes: Buffer.from("{}\n"),
    providerOciReceiptBytes: Buffer.from("{}\n"),
    transferObservationDirectory: "/retained/transfer/observation",
    transferReceiptPath: "/retained/transfer/receipt.json",
    isAncestor: async () => true,
    execFileImpl: async (command, args) => command === "git" ? terminalGitPreflight(command, args) : null,
    verifyTerminalLineageImpl: async () => ({
      markerState: "PRESENT",
      proof: {},
      successorFacilityBytes: await readFile(path.join(
        repositoryRoot,
        "tools/datapack/release/current-capital-facility-source-admission.json",
      )),
      topologyInputs: [],
      topologyOutputs: [],
    }),
    verifyTopologyHandoffImpl: () => ({
      operationId: accessibilitySourceHandoff.operationId,
      accessibilitySourceHandoff: {
        ...terminalAccessibilityProjection(accessibilitySourceHandoff),
        handoffSha256: "8".repeat(64),
      },
    }),
    verifyAccessibilityHandoffImpl: async () => accessibilitySourceHandoff,
    rebindPublicRouteMapImpl: async () => { rebindStarted = true; },
  }), /terminal accessibility source identity mismatch/u);
  assert.equal(rebindStarted, false);
});

test("terminal consumer verifies generated topology bytes before the first rebind", async (t) => {
  const runnerTemp = await mkdtemp(path.join(os.tmpdir(), "current-capital-terminal-generated-proof-"));
  t.after(() => rm(runnerTemp, { recursive: true, force: true }));
  const repositoryRoot = await pendingTransitionRepository(t);
  const handoff = await terminalProviderHandoff({ repositoryRoot });
  const topologyOutputPath = "tools/datapack/source-inventory.json";
  const topologyBefore = await readFile(path.join(repositoryRoot, topologyOutputPath));
  const accessibilitySourceHandoff = await terminalAccessibilityVerifierResult(repositoryRoot);
  let firstRebindCalled = false;
  await assert.rejects(runCurrentCapitalExitTerminalConsumer({
    repositoryRoot, runnerTemp, repository: "AquilaXk/easysubway-data", candidateOperationId: "current-capital-647",
    sourceMainRoot: repositoryRoot, sourceMainGitSha: "a".repeat(40), privateBuilderRoot: repositoryRoot, builderGitSha: "b".repeat(40), topologyBuild: {
      buildNow: "2026-09-01T00:00:00.000Z", capitalTopologyPath: "tools/datapack/sources/capital-route-topology-20260901.json",
      incheonAccessibilityPath: "tools/datapack/sources/incheon-transit-accessibility-20260901.json", incheonLine1TimetablePath: "tools/datapack/sources/incheon-line1-train-timetable-20260901.json",
      incheonLine2TimetablePath: "tools/datapack/sources/incheon-line2-train-timetable-20260901.json", incheonTopologyPath: "tools/datapack/sources/incheon-transit-station-info-20260901.json",
      itxCurrentAdmissionPath: "tools/datapack/release/current-itx-admission.json", itxTopologyEvidencePath: "tools/datapack/itx-topology-evidence.json",
    }, topologyHandoffBytes: Buffer.from("{}\n"), accessibilitySourceHandoffBytes: Buffer.from("{}\n"), verifyTerminalLineageImpl: async () => {
      const proof = await terminalConsumerProof(repositoryRoot);
      proof.topologyOutputs = [{
        relativePath: topologyOutputPath,
        beforeSha256: sha(topologyBefore), generatedSha256: sha(topologyBefore),
      }];
      return {
        markerState: "PRESENT", proof, topologyInputs: [],
        successorFacilityBytes: await readFile(path.join(
          repositoryRoot,
          "tools/datapack/release/current-capital-facility-source-admission.json",
        )),
        topologyOutputs: [{ relativePath: topologyOutputPath, bytes: Buffer.from("tampered generated topology") }],
      };
    },
    verifyTopologyHandoffImpl: () => ({
      operationId: "current-capital-560",
      accessibilitySourceHandoff: terminalAccessibilityProjection(accessibilitySourceHandoff),
    }),
    verifyAccessibilityHandoffImpl: async () => accessibilitySourceHandoff,
    commitTerminalManifestImpl: async () => { throw new Error("terminal commit must not start"); },
    operationNow: handoff.operationNow, sourceReceiptBytes: handoff.sourceReceiptBytes,
    providerOciPlanBytes: handoff.providerOciPlanBytes, providerOciReceiptBytes: handoff.providerOciReceiptBytes,
    client: memoryOciObject(handoff.bundleBytes, handoff.providerObject.objectKey), isAncestor: async () => true,
    transferObservationDirectory: "/retained/transfer/observation", transferReceiptPath: "/retained/transfer/receipt.json",
    execFileImpl: async (command, args, options) => command === "git"
      ? terminalGitPreflight(command, args)
      : (await import("node:child_process")).execFileSync(command, args, options),
    rebindPublicRouteMapImpl: async () => { firstRebindCalled = true; },
  }), /terminal staged topology output mismatch/);
  assert.equal(firstRebindCalled, false);
});

test("terminal consumer rejects an inconsistent real OCI source before refresh or marker deletion", async (t) => {
  const runnerTemp = await mkdtemp(path.join(os.tmpdir(), "current-capital-terminal-reject-"));
  t.after(() => rm(runnerTemp, { recursive: true, force: true }));
  const repositoryRoot = await pendingTransitionRepository(t);
  const handoff = await terminalProviderHandoff({ repositoryRoot, mutatePlan: changeProviderMappingIdentity });
  const client = memoryOciObject(handoff.bundleBytes, handoff.providerObject.objectKey);
  const accessibilitySourceHandoff = await terminalAccessibilityVerifierResult(repositoryRoot);
  const routeEvaluationRelative = "tools/datapack/release/current-capital-accessibility-full/route-edge-evaluation.json";
  const routeEvaluationPrestate = await readFile(path.join(repositoryRoot, routeEvaluationRelative));
  let stagedRoot;
  await assert.rejects(runCurrentCapitalExitTerminalConsumer({
    repositoryRoot, runnerTemp, repository: "AquilaXk/easysubway-data", candidateOperationId: "current-capital-647",
    sourceMainRoot: repositoryRoot, sourceMainGitSha: "a".repeat(40), privateBuilderRoot: repositoryRoot, builderGitSha: "b".repeat(40), topologyBuild: {
      buildNow: "2026-09-01T00:00:00.000Z", capitalTopologyPath: "tools/datapack/sources/capital-route-topology-20260901.json",
      incheonAccessibilityPath: "tools/datapack/sources/incheon-transit-accessibility-20260901.json", incheonLine1TimetablePath: "tools/datapack/sources/incheon-line1-train-timetable-20260901.json",
      incheonLine2TimetablePath: "tools/datapack/sources/incheon-line2-train-timetable-20260901.json", incheonTopologyPath: "tools/datapack/sources/incheon-transit-station-info-20260901.json",
      itxCurrentAdmissionPath: "tools/datapack/release/current-itx-admission.json", itxTopologyEvidencePath: "tools/datapack/itx-topology-evidence.json",
    }, topologyHandoffBytes: Buffer.from("{}\n"), accessibilitySourceHandoffBytes: Buffer.from("{}\n"), verifyTerminalLineageImpl: async () => ({
      markerState: "PRESENT", proof: await terminalConsumerProof(repositoryRoot),
      successorFacilityBytes: await readFile(path.join(
        repositoryRoot,
        "tools/datapack/release/current-capital-facility-source-admission.json",
      )),
      topologyInputs: [], topologyOutputs: [],
    }),
    verifyTopologyHandoffImpl: () => ({
      operationId: "current-capital-560",
      accessibilitySourceHandoff: terminalAccessibilityProjection(accessibilitySourceHandoff),
    }),
    verifyAccessibilityHandoffImpl: async () => accessibilitySourceHandoff,
    commitTerminalManifestImpl: async () => ({ repositoryRoot: stagedRoot }),
    operationNow: handoff.operationNow, sourceReceiptBytes: handoff.sourceReceiptBytes,
    providerOciPlanBytes: handoff.providerOciPlanBytes, providerOciReceiptBytes: handoff.providerOciReceiptBytes,
    client, isAncestor: async () => true,
    transferObservationDirectory: "/retained/transfer/observation", transferReceiptPath: "/retained/transfer/receipt.json",
    execFileImpl: async (command, args, options) => command === "git"
      ? terminalGitPreflight(command, args)
      : (await import("node:child_process")).execFileSync(command, args, options),
    rebindPublicRouteMapImpl: async ({ repositoryRoot }) => { stagedRoot = repositoryRoot; },
    rebindTransferImpl: unchangedTransferRebindProof, rebindFacilityImpl: async () => {},
  }), /not provider-equivalent to the current plan/);
  assert.equal(client.gets, 1);
  assert.ok(stagedRoot);
  await Promise.all([
    "tools/datapack/release/current-capital-accessibility-transition.json",
    "tools/datapack/release/current-capital-accessibility-transition-successor.json",
  ].map((relative) => stat(path.join(stagedRoot, relative))));
  assert.deepEqual(await readFile(path.join(stagedRoot, routeEvaluationRelative)), routeEvaluationPrestate);
});

test("Incheon topology path is derived from the current staged inventory head", () => {
  const snapshotId = "incheon-transit-station-info-20991231";
  const snapshotPath = `tools/datapack/sources/${snapshotId}.json`;
  const inventory = { sources: [{
    id: "incheon-transit-station-info",
    membershipAdmissionEvidence: { snapshotId },
    topologyAdmissionEvidence: { snapshotId, snapshotPath, contentSha256: "a".repeat(64) },
    routeMapAdmissionEvidence: { snapshotId, snapshotPath, topologySnapshotId: snapshotId, topologyContentSha256: "a".repeat(64) },
  }] };
  assert.equal(resolveStagedIncheonTopologyPath(inventory), snapshotPath);
  const drifted = structuredClone(inventory);
  drifted.sources[0].routeMapAdmissionEvidence.snapshotPath = "tools/datapack/sources/incheon-transit-station-info-20260814.json";
  assert.throws(() => resolveStagedIncheonTopologyPath(drifted), /Incheon topology identity mismatch/);
  const escaped = structuredClone(inventory);
  escaped.sources[0].topologyAdmissionEvidence.snapshotPath = "../outside.json";
  escaped.sources[0].routeMapAdmissionEvidence.snapshotPath = "../outside.json";
  assert.throws(() => resolveStagedIncheonTopologyPath(escaped), /Incheon topology identity mismatch/);
});

test("current KRIC EXIT plan inputs are exact staged bindings and reject identity drift", async (t) => {
  const stagedRoot = await mkdtemp(path.join(os.tmpdir(), "current-kric-exit-plan-inputs-"));
  t.after(() => rm(stagedRoot, { recursive: true, force: true }));
  const paths = [
    "tools/datapack/release/current-kric-exit-plan-inputs.json",
    "tools/datapack/sources/kric-provider-code-catalog-20260228.json",
    "tools/datapack/sources/kric-nationwide-route-rosters-20260730T203926676Z.json",
    "tools/datapack/source-candidates.json",
    "tools/datapack/nationwide-coverage-targets.json",
  ];
  await Promise.all(paths.map(async (relative) => {
    const destination = path.join(stagedRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(ROOT, relative), destination);
  }));
  const resolved = await resolveCurrentKricExitPlanInputs(stagedRoot);
  assert.deepEqual(resolved, {
    providerCodeCatalogRelativePath: "tools/datapack/sources/kric-provider-code-catalog-20260228.json",
    routeRostersRelativePath: "tools/datapack/sources/kric-nationwide-route-rosters-20260730T203926676Z.json",
  });
  const plan = buildCurrentCapitalExitExecutionPlan({ ...planInput, stagedRoot, ...resolved });
  const exitPlanArgs = plan.steps.find(({ id }) => id === "build-exit-plan").args;
  assert.equal(exitPlanArgs[exitPlanArgs.indexOf("--provider-code-catalog") + 1], path.join(stagedRoot, resolved.providerCodeCatalogRelativePath));
  assert.equal(exitPlanArgs[exitPlanArgs.indexOf("--route-rosters") + 1], path.join(stagedRoot, resolved.routeRostersRelativePath));
  const collectArgs = plan.steps.find(({ id }) => id === "collect-kric-exit").args;
  assert.equal(collectArgs[collectArgs.indexOf("--request-timeout-ms") + 1], String(CURRENT_KRIC_EXIT_REQUEST_TIMEOUT_MS));
  assert.equal(collectArgs[collectArgs.indexOf("--request-interval-ms") + 1], String(CURRENT_KRIC_EXIT_REQUEST_INTERVAL_MS));

  const bindingPath = path.join(stagedRoot, "tools/datapack/release/current-kric-exit-plan-inputs.json");
  const originalBinding = JSON.parse(await readFile(bindingPath, "utf8"));
  const cases = [
    ["hash", (value) => { value.providerCodeCatalog.sha256 = "0".repeat(64); }, /binding hash mismatch/],
    ["path", (value) => { value.routeRosters.relativePath = "../route-rosters.json"; }, /binding path mismatch/],
    ["candidate", (value) => { value.providerCodeCatalog.candidateId = "other"; }, /candidate identity mismatch/],
  ];
  for (const [, mutate, pattern] of cases) {
    const drifted = structuredClone(originalBinding);
    mutate(drifted);
    await writeFile(bindingPath, `${JSON.stringify(drifted)}\n`);
    await assert.rejects(resolveCurrentKricExitPlanInputs(stagedRoot), pattern);
  }
  await writeFile(bindingPath, `${JSON.stringify(originalBinding)}\n`);
  const targetPath = path.join(stagedRoot, "tools/datapack/nationwide-coverage-targets.json");
  const targets = JSON.parse(await readFile(targetPath, "utf8"));
  targets.targetVersion = "2099-01-01";
  await writeFile(targetPath, `${JSON.stringify(targets)}\n`);
  await assert.rejects(resolveCurrentKricExitPlanInputs(stagedRoot), /route roster targetVersion mismatch/);
});

test("current FACILITY admission is canonical and fresh at the actual operation clock", async (t) => {
  const stagedRoot = await mkdtemp(path.join(os.tmpdir(), "current-live-chain-facility-admission-"));
  t.after(() => rm(stagedRoot, { recursive: true, force: true }));
  const relative = "tools/datapack/release/current-capital-facility-source-admission.json";
  for (const input of [
    relative,
    "tools/datapack/release/candidate-build-spec.json",
    "tools/datapack/release/source-snapshots.json",
    "tools/datapack/source-inventory.json",
  ]) {
    const target = path.join(stagedRoot, input);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(ROOT, input), target);
  }
  const target = path.join(stagedRoot, relative);
  const admission = JSON.parse(await readFile(target, "utf8"));
  const sourceInventory = JSON.parse(await readFile(path.join(stagedRoot, "tools/datapack/source-inventory.json"), "utf8"));
  const commonNow = new Date(Math.max(
    Date.parse(admission.observedAt),
    ...sourceInventory.sources
      .filter(({ id }) => ["seoul-metro-accessibility", "kric-station-convenience-standard"].includes(id))
      .map(({ accessibilityAdmissionEvidence }) => Date.parse(accessibilityAdmissionEvidence.observedAt)),
  ));
  await assert.doesNotReject(assertCurrentCapitalFacilityAdmission({
    stagedRoot, now: commonNow,
  }));
  await assert.rejects(assertCurrentCapitalFacilityAdmission({
    stagedRoot, now: new Date(admission.sourceIdentity.freshUntil),
  }), /facility admission is stale/);
  await assert.rejects(assertCurrentCapitalFacilityAdmission({
    stagedRoot, now: new Date(Date.parse(admission.observedAt) - 1),
  }), /facility admission is from the future/);

  const inventoryPath = path.join(stagedRoot, "tools/datapack/source-inventory.json");
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  const seoul = inventory.sources.find(({ id }) => id === "seoul-metro-accessibility");
  assert.ok(seoul?.accessibilityAdmissionEvidence);
  seoul.accessibilityAdmissionEvidence.freshUntil = commonNow.toISOString();
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  await assert.rejects(assertCurrentCapitalFacilityAdmission({
    stagedRoot, now: commonNow,
  }), /selected accessibility source is stale: seoul-metro-accessibility/);
});

test("retained topology admission fails closed at its derived freshness boundary", async () => {
  const clock = await currentTopologyAdmissionClock(ROOT);
  await assert.rejects(assertCurrentStaticNetworkTopologyAdmission({
    repositoryRoot: ROOT,
    now: clock.expiredAt,
  }), /topology|fresh|stale|current/i);
});

async function retainedExitBundleFixture() {
  const paths = {
    canonicalPackBytes: "tools/datapack/release/capital-production-canonical-pack.json",
    coverageTargetsBytes: "tools/datapack/nationwide-coverage-targets.json",
    providerCodeCatalogBytes: "tools/datapack/sources/kric-provider-code-catalog-20260228.json",
    routeRostersBytes: "tools/datapack/sources/kric-nationwide-route-rosters-20260730T203926676Z.json",
    sourceInventoryBytes: "tools/datapack/source-inventory.json",
  };
  const input = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, relative]) => [key, await readFile(path.join(ROOT, relative))])));
  const inventory = JSON.parse(input.sourceInventoryBytes);
  const admission = inventory.sources.find(({ id }) => id === "incheon-transit-station-info").topologyAdmissionEvidence;
  input.incheonTopologyBytes = await readFile(path.join(ROOT, admission.snapshotPath));
  const plan = buildCurrentKricExitCollectionPlan(input, { now: new Date(admission.capturedAt), coverageSelector: "capital-seoul-metro-production" });
  const rows = [{ edMovePath: null, elvtSttCd: null, elvtTpCd: null, exitMvTpOrdr: "1", imgPath: null, mvContDtl: null, mvPathMgNo: "1", stMovePath: null }];
  const results = plan.queryPlan.map((query, index) => ({
    queryId: query.queryId, state: index === 0 ? "ROWS_OBSERVED" : "EXPLICIT_ZERO", providerResultCode: "00",
    rawResponseSha256: sha(`raw-${index}`), rawResponseByteSize: 1,
    providerRecordHash: sha(canonical(index === 0 ? rows : [])), rows: index === 0 ? rows : [],
  }));
  const payload = {
    schemaVersion: 1, artifactKind: "kric-exit-path-provider-snapshot", sourceId: "kric-station-movement-standard",
    snapshotId: `kric-station-movement-standard-${admission.capturedAt.replaceAll(/[-:.]/gu, "")}`,
    capturedAt: admission.capturedAt, freshUntil: admission.freshUntil, credentialRedacted: true,
    collectionPlanDigest: plan.collectionPlanDigest, queryPlanSha256: plan.queryPlanSha256,
    coverage: { requestPlanComplete: true, queryIds: plan.queryPlan.map(({ queryId }) => queryId) }, queryPlan: plan.queryPlan, results,
  };
  const snapshot = sort({ ...payload, snapshotDigest: sha(canonical(payload)) });
  const planBytes = Buffer.from(canonical(plan));
  const snapshotBytes = Buffer.from(canonical(snapshot));
  const receipt = buildCurrentKricExitCollectionReceipt({
    collectionPlanBytes: planBytes, providerSnapshotBytes: snapshotBytes,
    repository: "AquilaXk/easysubway-data", repositorySha: "b".repeat(40), operationId: "current-capital-560",
  });
  const bundle = buildCurrentKricExitCollectionBundle({ collectionPlanBytes: planBytes, providerSnapshotBytes: snapshotBytes, receipt });
  return { planBytes, snapshot, bytes: Buffer.from(canonicalCurrentKricExitCollectionBundleJson(bundle)) };
}

test("retained EXIT recovery rebuilds v2 provenance from an exact current plan without collection", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "current-live-chain-recovery-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const retained = await retainedExitBundleFixture();
  const retainedSha256 = sha(retained.bytes);
  const bundlePath = path.join(temporary, "retained-exit-bundle.json");
  await writeFile(bundlePath, retained.bytes, { mode: 0o600 });
  const operationNow = new Date(retained.snapshot.capturedAt);
  const calls = [];
  const recovered = await recoverCurrentKricExitCollection({
    retainedExitBundle: bundlePath, expectedRetainedExitBundleSha256: retainedSha256, currentPlanBytes: retained.planBytes,
    repository: "AquilaXk/easysubway-data", repositorySha: "a".repeat(40), operationId: "current-capital-561",
    operationNow, root: ROOT,
    execFileImpl: async (command, args) => { calls.push([command, args]); return { stdout: "" }; },
  });
  const bundle = JSON.parse(recovered.collectionBundleBytes);
  const receipt = JSON.parse(bundle.collectionReceiptJson);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["git", ["merge-base", "--is-ancestor", "b".repeat(40), "a".repeat(40)]]);
  assert.equal(receipt.schemaVersion, 2);
  assert.deepEqual(receipt.recoveredFrom, {
    repositorySha: "b".repeat(40), operationId: "current-capital-560",
    receiptSha256: JSON.parse(JSON.parse(retained.bytes).collectionReceiptJson).receiptSha256,
    bundleSha256: JSON.parse(retained.bytes).bundleSha256,
  });
  const identityOnlyCurrentPlan = JSON.parse(retained.planBytes);
  identityOnlyCurrentPlan.candidate.candidateId = `${identityOnlyCurrentPlan.candidate.candidateId}-current`;
  const { collectionPlanDigest: previousPlanDigest, ...identityOnlyPayload } = identityOnlyCurrentPlan;
  identityOnlyCurrentPlan.collectionPlanDigest = sha(canonical(identityOnlyPayload));
  const identityOnlyCurrentPlanBytes = Buffer.from(canonical(identityOnlyCurrentPlan));
  const identityOnlyRecovered = await recoverCurrentKricExitCollection({
    retainedExitBundle: bundlePath, expectedRetainedExitBundleSha256: retainedSha256,
    currentPlanBytes: identityOnlyCurrentPlanBytes,
    repository: "AquilaXk/easysubway-data", repositorySha: "a".repeat(40), operationId: "current-capital-562",
    operationNow, root: ROOT, execFileImpl: async () => ({ stdout: "" }),
  });
  const identityOnlyBundle = JSON.parse(identityOnlyRecovered.collectionBundleBytes);
  const identityOnlySnapshot = JSON.parse(identityOnlyBundle.providerSnapshotJson);
  assert.equal(identityOnlyBundle.collectionPlanJson, identityOnlyCurrentPlanBytes.toString("utf8"));
  assert.equal(identityOnlySnapshot.collectionPlanDigest, identityOnlyCurrentPlan.collectionPlanDigest);
  assert.notEqual(identityOnlySnapshot.collectionPlanDigest, previousPlanDigest);
  assert.notEqual(identityOnlySnapshot.snapshotDigest, retained.snapshot.snapshotDigest);
  assert.deepEqual(identityOnlySnapshot.results, retained.snapshot.results);
  const driftedCurrentPlan = structuredClone(identityOnlyCurrentPlan);
  driftedCurrentPlan.candidate.stationSetSha256 = "c".repeat(64);
  delete driftedCurrentPlan.collectionPlanDigest;
  driftedCurrentPlan.collectionPlanDigest = sha(canonical(driftedCurrentPlan));
  await assert.rejects(recoverCurrentKricExitCollection({
    retainedExitBundle: bundlePath, expectedRetainedExitBundleSha256: retainedSha256,
    currentPlanBytes: Buffer.from(canonical(driftedCurrentPlan)),
    repository: "AquilaXk/easysubway-data", repositorySha: "a".repeat(40), operationId: "current-capital-563",
    operationNow, root: ROOT, execFileImpl: async () => ({ stdout: "" }),
  }), /not provider-equivalent to the current plan/);
  assert.equal(resolveCurrentExitDerivationAt({
    retainedExitBundle: bundlePath, providerCapturedAt: retained.snapshot.capturedAt,
    operationNow: new Date("2026-08-27T10:20:00.000Z"),
  }), "2026-08-27T10:20:00.000Z");
  assert.equal(resolveCurrentExitDerivationAt({
    retainedExitBundle: undefined, providerCapturedAt: retained.snapshot.capturedAt, operationNow,
  }), retained.snapshot.capturedAt);
  await assert.rejects(recoverCurrentKricExitCollection({
    retainedExitBundle: bundlePath, expectedRetainedExitBundleSha256: "0".repeat(64), currentPlanBytes: retained.planBytes,
    repository: "AquilaXk/easysubway-data", repositorySha: "a".repeat(40), operationId: "current-capital-561",
    operationNow, root: ROOT, execFileImpl: async () => { throw new Error("ancestry must not run"); },
  }), /expected digest mismatch/);
  await assert.rejects(recoverCurrentKricExitCollection({
    retainedExitBundle: bundlePath, expectedRetainedExitBundleSha256: retainedSha256, currentPlanBytes: Buffer.from("different"),
    repository: "AquilaXk/easysubway-data", repositorySha: "a".repeat(40), operationId: "current-capital-561",
    operationNow, root: ROOT, execFileImpl: async () => { throw new Error("ancestry must not run"); },
  }), /not provider-equivalent to the current plan/);
  await assert.rejects(recoverCurrentKricExitCollection({
    retainedExitBundle: bundlePath, expectedRetainedExitBundleSha256: retainedSha256, currentPlanBytes: retained.planBytes,
    repository: "AquilaXk/easysubway-data", repositorySha: "a".repeat(40), operationId: "current-capital-561",
    operationNow: new Date(Date.parse(retained.snapshot.capturedAt) - 1), root: ROOT,
    execFileImpl: async () => { throw new Error("ancestry must not run"); },
  }), /was not previously captured/);
  await assert.rejects(recoverCurrentKricExitCollection({
    retainedExitBundle: bundlePath, expectedRetainedExitBundleSha256: retainedSha256, currentPlanBytes: retained.planBytes,
    repository: "AquilaXk/easysubway-data", repositorySha: "a".repeat(40), operationId: "current-capital-561",
    operationNow: new Date(retained.snapshot.freshUntil), root: ROOT,
    execFileImpl: async () => { throw new Error("ancestry must not run"); },
  }), /snapshot is stale/);
  await assert.rejects(recoverCurrentKricExitCollection({
    retainedExitBundle: bundlePath, expectedRetainedExitBundleSha256: retainedSha256, currentPlanBytes: retained.planBytes,
    repository: "AquilaXk/easysubway-data", repositorySha: "a".repeat(40), operationId: "current-capital-560",
    operationNow, root: ROOT, execFileImpl: async () => { throw new Error("ancestry must not run"); },
  }), /source identity mismatch/);
  await assert.rejects(recoverCurrentKricExitCollection({
    retainedExitBundle: bundlePath, expectedRetainedExitBundleSha256: retainedSha256, currentPlanBytes: retained.planBytes,
    repository: "AquilaXk/easysubway-data", repositorySha: "b".repeat(40), operationId: "current-capital-561",
    operationNow, root: ROOT, execFileImpl: async () => { throw new Error("ancestry must not run"); },
  }), /source identity mismatch/);
  await assert.rejects(recoverCurrentKricExitCollection({
    retainedExitBundle: bundlePath, expectedRetainedExitBundleSha256: retainedSha256, currentPlanBytes: retained.planBytes,
    repository: "AquilaXk/easysubway-data", repositorySha: "a".repeat(40), operationId: "current-capital-561",
    operationNow, root: ROOT,
    execFileImpl: async () => { throw new Error("source SHA is not an ancestor"); },
  }), /source SHA is not an ancestor/);
});

test("retained producer preflight rejects stale remote main", async () => {
  const repositorySha = "a".repeat(40);
  await assert.rejects(assertRemoteMain({
    root: ROOT,
    repositorySha,
    execFileImpl: async (command, args) => {
      assert.equal(command, "git");
      assert.deepEqual(args, ["ls-remote", "--exit-code", "https://github.com/AquilaXk/easysubway-data.git", "refs/heads/main"]);
      return { stdout: `${"b".repeat(40)}\trefs/heads/main\n` };
    },
  }), /exact remote main preflight failed/);
});

test("route policy evaluation preserves policy bytes and writes a separate staged evaluation", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "current-live-chain-route-policy-"));
  const routeEdgeInputPath = path.join(temporary, "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json");
  const stationLineInputPath = path.join(temporary, "tools/datapack/release/current-capital-accessibility-full/station-line-input.json");
  const policyPath = path.join(temporary, "release/product-gates/route-edge-evaluation-policy.json");
  const outputPath = path.join(temporary, "tools/datapack/release/current-capital-accessibility-full/route-edge-evaluation.json");
  const builtRouteEdgeInput = { candidate: "built-current-input", stationLines: ["built-station-line"], routeEdges: ["built-route-edge"] };
  const builtStationLineInput = { candidate: "built-current-materialization", stationLines: ["materialized-station-line"], evidenceRows: ["built-evidence"] };
  const evaluationAt = "2026-08-25T00:00:00.000Z";
  const materialization = { materializationDigest: "derived-from-staged-station-line-input" };
  const stagedPolicy = { policyVersion: "route-edge-evaluation-v2" };
  const evaluation = { evaluationDigest: "fresh-current-evaluation" };
  try {
    await mkdir(path.dirname(routeEdgeInputPath), { recursive: true });
    await mkdir(path.dirname(policyPath), { recursive: true });
    await writeFile(routeEdgeInputPath, JSON.stringify(builtRouteEdgeInput));
    await writeFile(stationLineInputPath, JSON.stringify(builtStationLineInput));
    await writeFile(policyPath, JSON.stringify(stagedPolicy));
    const bytes = await writeTerminalRoutePolicyEvaluation({
      stagedRoot: temporary,
      evaluationAt,
      materializeStationLineAccessibilityImpl: (input) => {
        assert.deepEqual(input, { ...builtStationLineInput, observedAt: evaluationAt });
        return materialization;
      },
      evaluateRouteAccessibilityEdgesImpl: (input, policy) => {
        assert.deepEqual(Object.keys(input), ["candidate", "stationLines", "routeEdges", "evaluationAt", "materialization"]);
        assert.deepEqual(input, { ...builtRouteEdgeInput, evaluationAt, materialization });
        assert.deepEqual(policy, stagedPolicy);
        return evaluation;
      },
      canonicalRouteEdgeEvaluationJsonImpl: (value) => {
        assert.equal(value, evaluation);
        return '{"evaluationDigest":"fresh-current-evaluation"}';
      },
    });
    assert.equal(bytes.toString("utf8"), '{"evaluationDigest":"fresh-current-evaluation"}');
    assert.equal(await readFile(outputPath, "utf8"), '{"evaluationDigest":"fresh-current-evaluation"}');
    assert.equal(await readFile(policyPath, "utf8"), JSON.stringify(stagedPolicy));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("current-only delivery removes legacy EXIT workflows and retains the OCI contract gate", async () => {
  const legacyPaths = [
    ".github/workflows/kric-exit-path-provider-snapshot.yml",
    ".github/workflows/kric-exit-path-source-admission.yml",
    ".github/workflows/kric-exit-timeout-diagnostic.yml",
    "tools/datapack/run-current-kric-exit-path-source-admission.mjs",
    "tools/datapack/run-current-kric-exit-path-source-admission.test.mjs",
    "tools/ci/kric-exit-path-provider-snapshot-workflow.test.mjs",
    "tools/ci/kric-exit-path-source-admission-workflow.test.mjs",
    "tools/ci/kric-exit-timeout-diagnostic-workflow.test.mjs",
  ];
  await Promise.all(legacyPaths.map((relativePath) =>
    assert.rejects(stat(path.join(ROOT, relativePath)), { code: "ENOENT" }),
  ));

  const ci = await readFile(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /Verify current capital live-chain OCI contracts/);
  assert.match(ci, /node --test tools\/datapack\/run-current-capital-live-chain\.test\.mjs/);
  for (const oldTest of [
    "tools/datapack/run-current-kric-exit-path-source-admission.test.mjs",
    "tools/ci/kric-exit-path-provider-snapshot-workflow.test.mjs",
    "tools/ci/kric-exit-path-source-admission-workflow.test.mjs",
    "tools/ci/kric-exit-timeout-diagnostic-workflow.test.mjs",
  ]) assert.doesNotMatch(ci, new RegExp(oldTest.replaceAll(".", "\\.")));
});

test("candidate-pinned ITX network evidence rejects path escape and digest drift before staging", async () => {
  const candidate = JSON.parse(await readFile(path.join(ROOT, "tools/datapack/release/candidate-build-spec.json"), "utf8"));
  const expected = [candidate.itxTopologyEvidencePath, candidate.networkEdgeEvidence.itxCoverageContract.path].sort();
  assert.deepEqual([...await resolveCurrentLiveChainCandidateStageInputs(candidate, ROOT)].sort(), expected);

  const escaped = structuredClone(candidate);
  escaped.networkEdgeEvidence.itxCoverageContract.path = "../itx-cheongchun-coverage-contract.json";
  await assert.rejects(resolveCurrentLiveChainCandidateStageInputs(escaped, ROOT), /ITX coverage contract path mismatch/);

  const drifted = structuredClone(candidate);
  drifted.networkEdgeEvidence.itxCoverageContract.sha256 = "0".repeat(64);
  await assert.rejects(resolveCurrentLiveChainCandidateStageInputs(drifted, ROOT), /ITX coverage contract hash mismatch/);
});
