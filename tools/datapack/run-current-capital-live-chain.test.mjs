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
  buildCurrentCapitalLiveChainPlan,
  assertCurrentCapitalFacilityAdmission,
  evaluateStagedRoutePolicy,
  parseArgs,
  resolveCurrentLiveChainCandidateStageInputs,
  resolveCurrentKricExitPlanInputs,
  resolveStagedIncheonTopologyPath,
  recoverCurrentKricExitCollection,
  resolveCurrentExitDerivationAt,
  runCurrentCapitalExitOnlyProducer,
  runCurrentCapitalExitTerminalConsumer,
  runCurrentCapitalLiveChain,
  verifyCurrentCapitalTerminalLineage,
} from "./run-current-capital-live-chain.mjs";
import { buildCurrentCapitalFacilityCollectionPlan, canonicalCurrentCapitalFacilityCollectionPlanJson } from "./build-current-capital-facility-collection-plan.mjs";
import { buildCurrentCapitalFacilitySourceAdmission, canonicalCurrentCapitalFacilitySourceAdmissionJson } from "./build-current-capital-facility-source-admission.mjs";
import { collectKricAccessibilitySnapshots } from "./collect-kric-accessibility-snapshots.mjs";
import { rebindCurrentCandidateSourceSnapshots } from "./rebind-current-candidate-source-snapshots.mjs";
import { registerKricStandardAccessibilitySnapshot } from "./register-kric-standard-accessibility-snapshot.mjs";
import { deriveRawRetentionExpiresAt } from "./source-governance-policy.mjs";
import { buildCurrentKricExitCollectionBundle, buildCurrentKricExitCollectionReceipt, canonicalCurrentKricExitCollectionBundleJson } from "./build-current-kric-exit-collection-receipt.mjs";
import { buildCurrentKricExitCollectionPlan } from "./build-current-kric-exit-collection-plan.mjs";
import { currentCapitalLiveChainOutputPaths } from "./build-current-capital-live-chain-bundle.mjs";
import { canonicalKricExitPathCollectionPlanJson } from "./plan-kric-exit-path-collection.mjs";
import { buildCurrentKricExitProviderOciPlan, canonicalCurrentKricExitProviderOciPlanJson } from "./build-current-kric-exit-provider-oci-plan.mjs";
import { buildCurrentKricExitProviderOciReceipt, canonicalCurrentKricExitProviderOciReceiptJson } from "./build-current-kric-exit-provider-oci-receipt.mjs";
import {
  buildCurrentCapitalExitProviderSourceHandoffFromProviderOci,
  canonicalCurrentCapitalExitProviderSourceHandoffJson,
} from "./current-capital-exit-provider-handoff.mjs";
import { validateCurrentCapitalTerminalManifest } from "./refresh-current-capital-accessibility-full.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const execFile = promisify(execFileCallback);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => JSON.stringify(sort(value));
function sort(value) { if (Array.isArray(value)) return value.map(sort); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.keys(value).sort((left, right) => left.localeCompare(right, "en")).map((key) => [key, sort(value[key])])); }

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
  const roster = plan.stationLineProviderMappings.map((mapping) => ({
    stationId: mapping.stationId,
    lineId: mapping.lineId,
    railOprIsttCd: mapping.providerOperatorId,
    lnCd: mapping.providerLineId,
    stinCd: mapping.providerStationId,
    canonicalMappings: [{
      artifactId: "bundled-capital", stationId: mapping.stationId, lineId: mapping.lineId,
    }],
  }));
  const inventory = JSON.parse(input.sourceInventoryBytes);
  const selected = ["kric-station-convenience-standard", "seoul-metro-accessibility"]
    .map((sourceId) => inventory.sources.find(({ id }) => id === sourceId)?.accessibilityAdmissionEvidence);
  const capturedAt = Math.max(...selected.map((evidence) => Date.parse(evidence?.capturedAt ?? ""))) + 60_000;
  if (!Number.isFinite(capturedAt) || capturedAt >= Date.parse(selected[1]?.freshUntil ?? "")) {
    throw new Error("retained FACILITY fixture has no shared source window");
  }
  const operationNow = new Date(capturedAt);
  const [snapshot] = await collectKricAccessibilitySnapshots({
    roster,
    serviceKey: "test-only-key-do-not-reflect",
    now: operationNow,
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      json: async () => ({
        header: { resultCode: "00" },
        body: [{
          dtlLoc: `location-${url.searchParams.get("stinCd")}`,
          grndDvCd: "1", gubun: "EV", imgPath: "", mlFmlDvCd: "", stinFlor: 1, trfcWeakDvCd: "01",
        }],
      }),
    }),
  });
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
    itxCurrentAdmissionPath: spec.networkEdgeEvidence.itxCurrentTopologyAdmission?.path,
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

test("live chain fixes the staged P/F/T to EXIT to full-capital order and invokes the collector exactly once", () => {
  const plan = buildCurrentCapitalLiveChainPlan(planInput);
  assert.equal(plan.steps.filter(({ id }) => id === "collect-kric-exit").length, 1);
  assert.deepEqual(plan.steps.map(({ id }) => id), [
    "materialize-public-route-map", "rebind-transfer", "rebind-facility", "build-exit-plan", "assert-current-topology-freshness",
    "collect-kric-exit", "bind-exit-collection", "admit-exit", "bind-current-fan-in", "build-full-capital", "evaluate-route-policy", "bundle",
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
  assert.throws(() => buildCurrentCapitalLiveChainPlan({ ...planInput, repositorySha: "not-a-sha" }), /repository SHA/);
  assert.throws(() => buildCurrentCapitalLiveChainPlan({ ...planInput, transferReceiptPath: "relative.json" }), /paths must be absolute/);
});

test("terminal manifest accepts only a verifier-shaped proof and rejects caller lineage hashes", async () => {
  const markers = [
    "tools/datapack/release/current-capital-accessibility-transition.json",
    "tools/datapack/release/current-capital-accessibility-transition-successor.json",
  ];
  const markerBytes = await Promise.all(markers.map((relative) => readFile(path.join(ROOT, relative))));
  const [candidate, inventory, ledger] = await Promise.all([
    "tools/datapack/release/candidate-build-spec.json",
    "tools/datapack/source-inventory.json",
    "tools/datapack/release/source-snapshots.json",
  ].map(async (relative) => JSON.parse(await readFile(path.join(ROOT, relative), "utf8"))));
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
  const replacementPaths = [...new Set([
    ...topologyInputs,
    ...topologyOutputs,
    ...liveChainOutputs,
    "tools/datapack/release/current-capital-live-chain-fan-in.json",
  ])].sort((left, right) => left.localeCompare(right));
  const proof = {
    schemaVersion: 1,
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
      beforeSha256: /reverification/.test(relative) ? null : sha(Buffer.from(relative)),
      afterSha256: sha(Buffer.from(`${relative}:producer`)),
    })),
  };
  const manifest = {
    topologyInputs, topologyOutputs, liveChainOutputs,
    fanInPath: "tools/datapack/release/current-capital-live-chain-fan-in.json",
    markerPaths: markers,
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
  assert.deepEqual(await Promise.all(markers.map((relative) => readFile(path.join(ROOT, relative)))), markerBytes);
  assert.throws(() => validateCurrentCapitalTerminalManifest({
    ...manifest, replacementPaths: replacementPaths.slice(1),
  }), /replacement manifest mismatch/);
  assert.throws(() => validateCurrentCapitalTerminalManifest({
    ...manifest, lineageProof: { baseTransitionSha256: sha(markerBytes[0]) },
  }), /manifest mismatch/);
});

test("terminal lineage replays the retained FACILITY producer and rejects builder tampering before journaling", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "current-terminal-lineage-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const sourceMainRoot = path.join(parent, "source-main");
  const retainedRoot = path.join(parent, "retained");
  const privateBuilderRoot = path.join(parent, "private-builder");
  const sourceMainGitSha = await cloneCleanFixture(ROOT, sourceMainRoot);
  await cloneCleanFixture(ROOT, retainedRoot);
  const builderGitSha = await cloneCleanFixture(ROOT, privateBuilderRoot);
  const facilityHeadGitSha = await buildRetainedFacilityFixture(retainedRoot);
  const topologyBuild = await currentTopologyFixture(privateBuilderRoot);
  const verified = await verifyCurrentCapitalTerminalLineage({
    sourceMainRoot,
    retainedRoot,
    privateBuilderRoot,
    sourceMainGitSha,
    facilityHeadGitSha,
    builderGitSha,
    topologyBuild,
  });
  assert.equal(verified.proof.sourceMainGitSha, sourceMainGitSha);
  assert.equal(verified.proof.facilityHeadGitSha, facilityHeadGitSha);
  assert.equal(verified.proof.builderGitSha, builderGitSha);
  assert.equal(verified.topologyInputs.length, 4);
  assert.ok(verified.topologyOutputs.length > 0);

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

test("EXIT-only producer refuses provider access without a validated same-repository FACILITY PR", async () => {
  await assert.rejects(runCurrentCapitalExitOnlyProducer({
    repositoryRoot: "/repository", runnerTemp: "/runner", handoffDirectory: "/handoff", repository: "AquilaXk/easysubway-data",
    repositorySha: "a".repeat(40), operationId: "current-capital-647",
    env: { KRIC_SERVICE_KEY: "key", EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/token/n/axvym6vk8g7i/b/easysubway-datapacks/o/" },
    execFileImpl: async () => { throw new Error("provider boundary must not start"); },
  }), /validated same-repository FACILITY pull request is required/);
});

test("EXIT-only producer requires every fixed FACILITY release artifact", async () => {
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
  try {
    await mkdir(runnerTemp); await mkdir(handoffParent);
    await assert.rejects(runCurrentCapitalExitOnlyProducer({
      repositoryRoot: ROOT,
      retainedRoot: ROOT,
      privateBuilderRoot: ROOT,
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
          bytes: await readFile(path.join(ROOT, "tools/datapack/source-inventory.json")),
        }],
      }),
      buildTopologyHandoffImpl: async () => ({ schemaVersion: 1, artifactKind: "test-topology-handoff" }),
      execFileImpl: async (_command, args) => {
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
          reachedPlanning = true;
          throw new Error("producer planning reached");
        }
        throw new Error(`provider boundary must not start: ${command}`);
      },
      assertCurrentTopologyAdmissionImpl: async () => { throw new Error("producer planning reached"); },
      publishImpl: async () => { throw new Error("OCI publication must not start"); },
    }), /producer planning reached/);
    assert.equal(reachedPlanning, true);
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

async function terminalProviderHandoff({ mutatePlan = (plan) => plan } = {}) {
  const paths = {
    canonicalPackBytes: "tools/datapack/release/capital-production-canonical-pack.json",
    coverageTargetsBytes: "tools/datapack/nationwide-coverage-targets.json",
    providerCodeCatalogBytes: "tools/datapack/sources/kric-provider-code-catalog-20260228.json",
    routeRostersBytes: "tools/datapack/sources/kric-nationwide-route-rosters-20260730T203926676Z.json",
    sourceInventoryBytes: "tools/datapack/source-inventory.json",
  };
  const input = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, relative]) =>
    [key, await readFile(path.join(ROOT, relative))],
  )));
  const inventory = JSON.parse(input.sourceInventoryBytes);
  const incheon = inventory.sources.find(({ id }) => id === "incheon-transit-station-info").topologyAdmissionEvidence;
  input.incheonTopologyBytes = await readFile(path.join(ROOT, incheon.snapshotPath));
  const plan = buildCurrentKricExitCollectionPlan(input, {
    now: new Date(incheon.capturedAt), coverageSelector: "capital-seoul-metro-production",
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
    snapshotId: `kric-station-movement-standard-${incheon.capturedAt.replaceAll(/[-:.]/gu, "")}`,
    capturedAt: incheon.capturedAt, freshUntil: incheon.freshUntil, credentialRedacted: true,
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
    providerCapturedAt: incheon.capturedAt,
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
    operationNow: new Date(incheon.capturedAt), bundleBytes, providerObject: providerPlan.providerObject,
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
  const handoff = await terminalProviderHandoff();
  const markers = [
    "tools/datapack/release/current-capital-accessibility-transition.json",
    "tools/datapack/release/current-capital-accessibility-transition-successor.json",
  ];
  const rootPrestates = await Promise.all([
    "tools/datapack/release/candidate-build-spec.json", ...markers,
  ].map(async (relative) => [relative, await readFile(path.join(ROOT, relative))]));
  const calls = [];
  const client = memoryOciObject(handoff.bundleBytes, handoff.providerObject.objectKey);
  const stageRoots = [];
  let terminalCommit;
  const result = await runCurrentCapitalExitTerminalConsumer({
    repositoryRoot: ROOT, runnerTemp, repository: "AquilaXk/easysubway-data", candidateOperationId: "current-capital-647",
    sourceMainRoot: ROOT, sourceMainGitSha: "a".repeat(40), privateBuilderRoot: ROOT, builderGitSha: "b".repeat(40), topologyBuild: {
      buildNow: "2026-09-01T00:00:00.000Z", capitalTopologyPath: "tools/datapack/sources/capital-route-topology-20260901.json",
      incheonAccessibilityPath: "tools/datapack/sources/incheon-transit-accessibility-20260901.json", incheonLine1TimetablePath: "tools/datapack/sources/incheon-line1-train-timetable-20260901.json",
      incheonLine2TimetablePath: "tools/datapack/sources/incheon-line2-train-timetable-20260901.json", incheonTopologyPath: "tools/datapack/sources/incheon-transit-station-info-20260901.json",
      itxCurrentAdmissionPath: "tools/datapack/release/current-itx-admission.json", itxTopologyEvidencePath: "tools/datapack/itx-topology-evidence.json",
    }, topologyHandoffBytes: Buffer.from("{}\n"), verifyTerminalLineageImpl: async () => ({
      proof: { topologyInputs: [], topologyOutputs: [] }, topologyInputs: [], topologyOutputs: [],
    }),
    verifyTopologyHandoffImpl: () => ({ operationId: "current-capital-560" }),
    commitTerminalManifestImpl: async (input) => { terminalCommit = input; return { repositoryRoot: stageRoots[0] }; },
    operationNow: handoff.operationNow, sourceReceiptBytes: handoff.sourceReceiptBytes,
    providerOciPlanBytes: handoff.providerOciPlanBytes, providerOciReceiptBytes: handoff.providerOciReceiptBytes,
    client, isAncestor: async (from, to) => from === "a".repeat(40) && to === "b".repeat(40),
    transferObservationDirectory: "/retained/transfer/observation", transferReceiptPath: "/retained/transfer/receipt.json",
    execFileImpl: async (command, args, options) => command === "git"
      ? terminalGitPreflight(command, args)
      : (await import("node:child_process")).execFileSync(command, args, options),
    rebindPublicRouteMapImpl: async ({ repositoryRoot }) => { calls.push("P"); stageRoots.push(repositoryRoot); },
    rebindTransferImpl: async ({ repositoryRoot }) => { calls.push("T"); assert.equal(repositoryRoot, stageRoots[0]); },
    rebindFacilityImpl: async ({ repositoryRoot }) => { calls.push("F"); assert.equal(repositoryRoot, stageRoots[0]); },
  });
  assert.deepEqual(calls, ["P", "T", "F"]);
  assert.equal(client.gets, 1);
  assert.deepEqual({ providerCalls: result.providerCalls, ociGetCalls: result.ociGetCalls, ociPutCalls: result.ociPutCalls }, { providerCalls: 0, ociGetCalls: 1, ociPutCalls: 0 });
  assert.equal(result.outputPaths.length, 17);
  assert.equal(result.fanInPath, "tools/datapack/release/current-capital-live-chain-fan-in.json");
  assert.ok(terminalCommit);
  assert.equal(terminalCommit.outputs.length, new Set(terminalCommit.manifest.replacementPaths).size);
  assert.equal(terminalCommit.outputs.filter(({ prestate }) => prestate == null).length, 0);
  assert.deepEqual(terminalCommit.manifest.liveChainOutputs, result.outputPaths);
  await Promise.all(result.outputPaths.map((relative) => stat(path.join(result.stagedRoot, relative))));
  await stat(path.join(result.stagedRoot, result.fanInPath));
  await Promise.all(markers.map((relative) => assert.rejects(stat(path.join(result.stagedRoot, relative)), { code: "ENOENT" })));
  assert.deepEqual(result.deletedMarkerPaths, markers);
  for (const [relative, before] of rootPrestates) assert.deepEqual(await readFile(path.join(ROOT, relative)), before, `ROOT mutated: ${relative}`);
});

test("terminal consumer rejects an inconsistent real OCI source before refresh or marker deletion", async (t) => {
  const runnerTemp = await mkdtemp(path.join(os.tmpdir(), "current-capital-terminal-reject-"));
  t.after(() => rm(runnerTemp, { recursive: true, force: true }));
  const handoff = await terminalProviderHandoff({ mutatePlan: changeProviderMappingIdentity });
  const client = memoryOciObject(handoff.bundleBytes, handoff.providerObject.objectKey);
  const routeEvaluationRelative = "tools/datapack/release/current-capital-accessibility-full/route-edge-evaluation.json";
  const routeEvaluationPrestate = await readFile(path.join(ROOT, routeEvaluationRelative));
  let stagedRoot;
  await assert.rejects(runCurrentCapitalExitTerminalConsumer({
    repositoryRoot: ROOT, runnerTemp, repository: "AquilaXk/easysubway-data", candidateOperationId: "current-capital-647",
    sourceMainRoot: ROOT, sourceMainGitSha: "a".repeat(40), privateBuilderRoot: ROOT, builderGitSha: "b".repeat(40), topologyBuild: {
      buildNow: "2026-09-01T00:00:00.000Z", capitalTopologyPath: "tools/datapack/sources/capital-route-topology-20260901.json",
      incheonAccessibilityPath: "tools/datapack/sources/incheon-transit-accessibility-20260901.json", incheonLine1TimetablePath: "tools/datapack/sources/incheon-line1-train-timetable-20260901.json",
      incheonLine2TimetablePath: "tools/datapack/sources/incheon-line2-train-timetable-20260901.json", incheonTopologyPath: "tools/datapack/sources/incheon-transit-station-info-20260901.json",
      itxCurrentAdmissionPath: "tools/datapack/release/current-itx-admission.json", itxTopologyEvidencePath: "tools/datapack/itx-topology-evidence.json",
    }, topologyHandoffBytes: Buffer.from("{}\n"), verifyTerminalLineageImpl: async () => ({
      proof: { topologyInputs: [], topologyOutputs: [] }, topologyInputs: [], topologyOutputs: [],
    }),
    verifyTopologyHandoffImpl: () => ({ operationId: "current-capital-560" }),
    commitTerminalManifestImpl: async () => ({ repositoryRoot: stagedRoot }),
    operationNow: handoff.operationNow, sourceReceiptBytes: handoff.sourceReceiptBytes,
    providerOciPlanBytes: handoff.providerOciPlanBytes, providerOciReceiptBytes: handoff.providerOciReceiptBytes,
    client, isAncestor: async () => true,
    transferObservationDirectory: "/retained/transfer/observation", transferReceiptPath: "/retained/transfer/receipt.json",
    execFileImpl: async (command, args, options) => command === "git"
      ? terminalGitPreflight(command, args)
      : (await import("node:child_process")).execFileSync(command, args, options),
    rebindPublicRouteMapImpl: async ({ repositoryRoot }) => { stagedRoot = repositoryRoot; },
    rebindTransferImpl: async () => {}, rebindFacilityImpl: async () => {},
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
  const plan = buildCurrentCapitalLiveChainPlan({ ...planInput, stagedRoot, ...resolved });
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

test("CLI accepts every exact live-chain identity and path once", () => {
  const argv = [
    "--repository-root", "/repo", "--runner-temp", "/runner", "--repository", "AquilaXk/easysubway-data",
    "--repository-sha", "a".repeat(40), "--operation-id", "current-capital-560",
    "--transfer-observation-directory", planInput.transferObservationDirectory, "--transfer-receipt", planInput.transferReceiptPath,
    "--handoff-directory", "/handoff/current-capital-560",
  ];
  assert.equal(parseArgs(argv)["handoff-directory"], "/handoff/current-capital-560");
  assert.throws(() => parseArgs([...argv.slice(0, -2), "--handoff-directory", "relative"]), /paths must be absolute/);
  assert.throws(() => parseArgs([...argv.slice(0, -2), "--repository-root", "/other"]), /arguments mismatch/);
  assert.throws(() => parseArgs(argv.filter((value) => value !== "--operation-id" && value !== "current-capital-560")), /arguments mismatch/);
  const retainedArgs = [...argv, "--retained-exit-bundle", "/retained/current-kric-exit.json", "--retained-exit-bundle-sha256", "d".repeat(64)];
  assert.equal(parseArgs(retainedArgs)["retained-exit-bundle"], "/retained/current-kric-exit.json");
  assert.throws(() => parseArgs([...argv, "--retained-exit-bundle", "/retained/current-kric-exit.json"]), /arguments mismatch/);
  assert.throws(() => parseArgs([...argv, "--retained-exit-bundle-sha256", "d".repeat(64)]), /arguments mismatch/);
});

test("current FACILITY admission is canonical and fresh at the actual operation clock", async (t) => {
  const stagedRoot = await mkdtemp(path.join(os.tmpdir(), "current-live-chain-facility-admission-"));
  t.after(() => rm(stagedRoot, { recursive: true, force: true }));
  const relative = "tools/datapack/release/current-capital-facility-source-admission.json";
  const target = path.join(stagedRoot, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(ROOT, relative), target);
  const admission = JSON.parse(await readFile(target, "utf8"));
  await assert.doesNotReject(assertCurrentCapitalFacilityAdmission({
    stagedRoot, now: new Date(admission.observedAt),
  }));
  await assert.rejects(assertCurrentCapitalFacilityAdmission({
    stagedRoot, now: new Date(admission.sourceIdentity.freshUntil),
  }), /facility admission is stale/);
  await assert.rejects(assertCurrentCapitalFacilityAdmission({
    stagedRoot, now: new Date(Date.parse(admission.observedAt) - 1),
  }), /facility admission is from the future/);
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

test("stale 또는 malformed remote main은 provider/OCI boundary 전에 중단한다", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "current-live-chain-remote-main-"));
  const runnerTemp = path.join(temporary, "runner");
  const handoffParent = path.join(temporary, "handoff-parent");
  const calls = [];
  try {
    await mkdir(runnerTemp); await mkdir(handoffParent);
    await assert.rejects(runCurrentCapitalLiveChain({
      repositoryRoot: ROOT, runnerTemp, repository: "AquilaXk/easysubway-data", repositorySha: "a".repeat(40), operationId: "current-capital-560",
      transferObservationDirectory: "/retained/transfer/observation", transferReceiptPath: "/retained/transfer/receipt.json", handoffDirectory: path.join(handoffParent, "handoff"),
      env: { PATH: process.env.PATH, KRIC_SERVICE_KEY: "test-key", EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/test/n/axvym6vk8g7i/b/easysubway-datapacks/o/" },
      execFileImpl: async (_command, args) => {
        calls.push(args);
        if (args.join(" ") === "remote get-url origin") return { stdout: "https://github.com/AquilaXk/easysubway-data.git\n" };
        if (args.join(" ") === "rev-parse HEAD" || args.join(" ") === "rev-parse origin/main") return { stdout: `${"a".repeat(40)}\n` };
        if (args.join(" ") === "branch --show-current") return { stdout: "main\n" };
        if (args.join(" ") === "status --porcelain=v1 --untracked-files=all") return { stdout: "" };
        if (args[0] === "ls-remote") return { stdout: `${"b".repeat(40)}\trefs/heads/main\n` };
        throw new Error("provider or OCI boundary must not start");
      },
    }), /exact remote main preflight failed/);
    assert.equal(calls.some((args) => args[0] === "collect-current-kric-exit-path-provider-snapshot.mjs"), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
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
    const bytes = await evaluateStagedRoutePolicy({
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

test("public route-map materialization failure stops before the provider and OCI boundaries", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "current-live-chain-preparer-"));
  const runnerTemp = path.join(temporary, "runner");
  const handoffParent = path.join(temporary, "handoff-parent");
  const calls = [];
  try {
    await mkdir(runnerTemp); await mkdir(handoffParent);
    await assert.rejects(runCurrentCapitalLiveChain({
      repositoryRoot: ROOT, runnerTemp, repository: "AquilaXk/easysubway-data", repositorySha: "a".repeat(40), operationId: "current-capital-560",
      transferObservationDirectory: "/retained/transfer/observation", transferReceiptPath: "/retained/transfer/receipt.json", handoffDirectory: path.join(handoffParent, "handoff"),
      env: { PATH: process.env.PATH, KRIC_SERVICE_KEY: "test-key", EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/test/n/axvym6vk8g7i/b/easysubway-datapacks/o/" },
      execFileImpl: async (command, args) => {
        calls.push([command, args]);
        if (args.join(" ") === "remote get-url origin") return { stdout: "https://github.com/AquilaXk/easysubway-data.git\n" };
        if (args.join(" ") === "rev-parse HEAD" || args.join(" ") === "rev-parse origin/main") return { stdout: `${"a".repeat(40)}\n` };
        if (args.join(" ") === "branch --show-current") return { stdout: "main\n" };
        if (args.join(" ") === "status --porcelain=v1 --untracked-files=all") return { stdout: "" };
        if (args.join(" ") === `ls-remote --exit-code https://github.com/AquilaXk/easysubway-data.git refs/heads/main`) return { stdout: `${"a".repeat(40)}\trefs/heads/main\n` };
        throw new Error("provider execution must not start");
      },
      rebindPublicRouteMapImpl: async () => { throw new Error("public route-map materialization failed"); },
      publishImpl: async () => { throw new Error("OCI publication must not start"); },
    }), /public route-map materialization failed/);
    assert.equal(calls.length, 6);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("tracked live-chain fan-in is not copied into create-new staging output", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "current-live-chain-fan-in-staging-"));
  const runnerTemp = path.join(temporary, "runner");
  const handoffParent = path.join(temporary, "handoff-parent");
  const fanInPath = "tools/datapack/release/current-capital-live-chain-fan-in.json";
  try {
    await mkdir(runnerTemp); await mkdir(handoffParent);
    await stat(path.join(ROOT, fanInPath));
    await assert.rejects(runCurrentCapitalLiveChain({
      repositoryRoot: ROOT, runnerTemp, repository: "AquilaXk/easysubway-data", repositorySha: "a".repeat(40), operationId: "current-capital-560",
      transferObservationDirectory: "/retained/transfer/observation", transferReceiptPath: "/retained/transfer/receipt.json", handoffDirectory: path.join(handoffParent, "handoff"),
      env: { PATH: process.env.PATH, KRIC_SERVICE_KEY: "test-key", EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/test/n/axvym6vk8g7i/b/easysubway-datapacks/o/" },
      execFileImpl: async (_command, args) => {
        if (args.join(" ") === "remote get-url origin") return { stdout: "https://github.com/AquilaXk/easysubway-data.git\n" };
        if (args.join(" ") === "rev-parse HEAD" || args.join(" ") === "rev-parse origin/main") return { stdout: `${"a".repeat(40)}\n` };
        if (args.join(" ") === "branch --show-current") return { stdout: "main\n" };
        if (args.join(" ") === "status --porcelain=v1 --untracked-files=all") return { stdout: "" };
        if (args.join(" ") === `ls-remote --exit-code https://github.com/AquilaXk/easysubway-data.git refs/heads/main`) return { stdout: `${"a".repeat(40)}\trefs/heads/main\n` };
        throw new Error("provider execution must not start");
      },
      rebindPublicRouteMapImpl: async ({ repositoryRoot }) => {
        await assert.rejects(stat(path.join(repositoryRoot, fanInPath)), { code: "ENOENT" });
        throw new Error("fan-in staging exclusion verified");
      },
      publishImpl: async () => { throw new Error("OCI publication must not start"); },
    }), /fan-in staging exclusion verified/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("candidate-selected versioned ITX topology evidence is staged before every provider or OCI effect", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "current-live-chain-itx-stage-"));
  const runnerTemp = path.join(temporary, "runner");
  const handoffParent = path.join(temporary, "handoff-parent");
  const handoffDirectory = path.join(handoffParent, "handoff");
  const candidate = JSON.parse(await readFile(path.join(ROOT, "tools/datapack/release/candidate-build-spec.json"), "utf8"));
  const selectedPath = candidate.itxTopologyEvidencePath;
  const coveragePath = candidate.networkEdgeEvidence.itxCoverageContract.path;
  let providerCount = 0;
  let publicationCount = 0;
  try {
    await mkdir(runnerTemp); await mkdir(handoffParent);
    await assert.rejects(runCurrentCapitalLiveChain({
      repositoryRoot: ROOT, runnerTemp, repository: "AquilaXk/easysubway-data", repositorySha: "a".repeat(40), operationId: "current-capital-560",
      transferObservationDirectory: "/retained/transfer/observation", transferReceiptPath: "/retained/transfer/receipt.json", handoffDirectory,
      env: { PATH: process.env.PATH, KRIC_SERVICE_KEY: "test-key", EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/test/n/axvym6vk8g7i/b/easysubway-datapacks/o/" },
      execFileImpl: async (command, args) => {
        if (args.join(" ") === "remote get-url origin") return { stdout: "https://github.com/AquilaXk/easysubway-data.git\n" };
        if (args.join(" ") === "rev-parse HEAD" || args.join(" ") === "rev-parse origin/main") return { stdout: `${"a".repeat(40)}\n` };
        if (args.join(" ") === "branch --show-current") return { stdout: "main\n" };
        if (args.join(" ") === "status --porcelain=v1 --untracked-files=all") return { stdout: "" };
        if (args.join(" ") === `ls-remote --exit-code https://github.com/AquilaXk/easysubway-data.git refs/heads/main`) return { stdout: `${"a".repeat(40)}\trefs/heads/main\n` };
        if (command === process.execPath && args[0] === "tools/datapack/collect-current-kric-exit-path-provider-snapshot.mjs") providerCount += 1;
        throw new Error("provider execution must not start");
      },
      rebindPublicRouteMapImpl: async () => {},
      rebindTransferImpl: async ({ repositoryRoot }) => {
        await stat(path.join(repositoryRoot, selectedPath));
        await stat(path.join(repositoryRoot, coveragePath));
        await assert.rejects(stat(path.join(repositoryRoot, "tools/datapack/itx-cheongchun-topology-evidence.json")), { code: "ENOENT" });
        throw new Error("staged candidate ITX evidence verified");
      },
      publishImpl: async () => { publicationCount += 1; },
    }), /staged candidate ITX evidence verified/);
    assert.equal(providerCount, 0);
    assert.equal(publicationCount, 0);
    await assert.rejects(stat(handoffDirectory), { code: "ENOENT" });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
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

test("actual-now topology freshness failure stops before every provider and OCI side effect", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "current-live-chain-topology-freshness-"));
  const runnerTemp = path.join(temporary, "runner");
  const handoffParent = path.join(temporary, "handoff-parent");
  const operationNow = new Date("2026-08-26T01:02:03.004Z");
  const calls = [];
  let publicationCount = 0;
  let fetchCount = 0;
  let extractionCount = 0;
  try {
    await mkdir(runnerTemp); await mkdir(handoffParent);
    await assert.rejects(runCurrentCapitalLiveChain({
      repositoryRoot: ROOT, runnerTemp, repository: "AquilaXk/easysubway-data", repositorySha: "a".repeat(40), operationId: "current-capital-560",
      transferObservationDirectory: "/retained/transfer/observation", transferReceiptPath: "/retained/transfer/receipt.json", handoffDirectory: path.join(handoffParent, "handoff"),
      env: { PATH: process.env.PATH, KRIC_SERVICE_KEY: "test-key", EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/test/n/axvym6vk8g7i/b/easysubway-datapacks/o/" },
      execFileImpl: async (command, args) => {
        calls.push([command, args]);
        if (args.join(" ") === "remote get-url origin") return { stdout: "https://github.com/AquilaXk/easysubway-data.git\n" };
        if (args.join(" ") === "rev-parse HEAD" || args.join(" ") === "rev-parse origin/main") return { stdout: `${"a".repeat(40)}\n` };
        if (args.join(" ") === "branch --show-current") return { stdout: "main\n" };
        if (args.join(" ") === "status --porcelain=v1 --untracked-files=all") return { stdout: "" };
        if (args.join(" ") === `ls-remote --exit-code https://github.com/AquilaXk/easysubway-data.git refs/heads/main`) return { stdout: `${"a".repeat(40)}\trefs/heads/main\n` };
        if (command === process.execPath && args[0] === "tools/datapack/build-current-kric-exit-collection-plan.mjs") return { stdout: "" };
        throw new Error("provider execution must not start");
      },
      clock: () => operationNow,
      rebindPublicRouteMapImpl: async () => {},
      rebindTransferImpl: async () => {},
      rebindFacilityImpl: async () => {},
      assertCurrentTopologyAdmissionImpl: async ({ repositoryRoot, now }) => {
        assert.ok(repositoryRoot.includes("current-capital-live-chain-"));
        assert.equal(now, operationNow);
        throw new Error("current topology admission is stale");
      },
      publishImpl: async () => { publicationCount += 1; },
      fetchImpl: async () => { fetchCount += 1; },
      extractImpl: async () => { extractionCount += 1; },
    }), /current topology admission is stale/);
    assert.equal(calls.filter(([, args]) => args[0] === "tools/datapack/collect-current-kric-exit-path-provider-snapshot.mjs").length, 0);
    assert.equal(publicationCount, 0);
    assert.equal(fetchCount, 0);
    assert.equal(extractionCount, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("stale current FACILITY admission stops before provider, publish, fetch, and extraction", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "current-live-chain-facility-freshness-"));
  const runnerTemp = path.join(temporary, "runner");
  const handoffParent = path.join(temporary, "handoff-parent");
  let providerCount = 0;
  let publicationCount = 0;
  let fetchCount = 0;
  let extractionCount = 0;
  try {
    await mkdir(runnerTemp); await mkdir(handoffParent);
    await assert.rejects(runCurrentCapitalLiveChain({
      repositoryRoot: ROOT, runnerTemp, repository: "AquilaXk/easysubway-data", repositorySha: "a".repeat(40), operationId: "current-capital-560",
      transferObservationDirectory: "/retained/transfer/observation", transferReceiptPath: "/retained/transfer/receipt.json", handoffDirectory: path.join(handoffParent, "handoff"),
      env: { PATH: process.env.PATH, KRIC_SERVICE_KEY: "test-key", EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/test/n/axvym6vk8g7i/b/easysubway-datapacks/o/" },
      execFileImpl: async (command, args) => {
        if (args.join(" ") === "remote get-url origin") return { stdout: "https://github.com/AquilaXk/easysubway-data.git\n" };
        if (args.join(" ") === "rev-parse HEAD" || args.join(" ") === "rev-parse origin/main") return { stdout: `${"a".repeat(40)}\n` };
        if (args.join(" ") === "branch --show-current") return { stdout: "main\n" };
        if (args.join(" ") === "status --porcelain=v1 --untracked-files=all") return { stdout: "" };
        if (args.join(" ") === `ls-remote --exit-code https://github.com/AquilaXk/easysubway-data.git refs/heads/main`) return { stdout: `${"a".repeat(40)}\trefs/heads/main\n` };
        if (command === process.execPath && args[0] === "tools/datapack/build-current-kric-exit-collection-plan.mjs") return { stdout: "" };
        if (command === process.execPath && args[0] === "tools/datapack/collect-current-kric-exit-path-provider-snapshot.mjs") providerCount += 1;
        throw new Error("provider execution must not start");
      },
      clock: () => new Date("2026-08-26T01:02:03.004Z"),
      rebindPublicRouteMapImpl: async () => {}, rebindTransferImpl: async () => {}, rebindFacilityImpl: async () => {},
      assertCurrentTopologyAdmissionImpl: async () => {},
      assertCurrentFacilityAdmissionImpl: async () => { throw new Error("current capital facility admission is stale"); },
      publishImpl: async () => { publicationCount += 1; },
      fetchImpl: async () => { fetchCount += 1; },
      extractImpl: async () => { extractionCount += 1; },
    }), /current capital facility admission is stale/);
    assert.equal(providerCount, 0);
    assert.equal(publicationCount, 0);
    assert.equal(fetchCount, 0);
    assert.equal(extractionCount, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
