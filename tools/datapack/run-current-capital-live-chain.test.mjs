import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CURRENT_KRIC_EXIT_REQUEST_INTERVAL_MS,
  CURRENT_KRIC_EXIT_REQUEST_TIMEOUT_MS,
  buildCurrentCapitalLiveChainPlan,
  assertCurrentCapitalFacilityAdmission,
  evaluateStagedRoutePolicy,
  parseArgs,
  resolveCurrentLiveChainCandidateStageInputs,
  resolveCurrentKricExitPlanInputs,
  resolveStagedIncheonTopologyPath,
  recoverCurrentKricExitCollection,
  runCurrentCapitalLiveChain,
} from "./run-current-capital-live-chain.mjs";
import { buildCurrentKricExitCollectionBundle, buildCurrentKricExitCollectionReceipt, canonicalCurrentKricExitCollectionBundleJson } from "./build-current-kric-exit-collection-receipt.mjs";
import { buildCurrentKricExitCollectionPlan } from "./build-current-kric-exit-collection-plan.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => JSON.stringify(sort(value));
function sort(value) { if (Array.isArray(value)) return value.map(sort); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.keys(value).sort((left, right) => left.localeCompare(right, "en")).map((key) => [key, sort(value[key])])); }

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
  assert.deepEqual(plan.outputs, planInput.outputPaths);
  assert.throws(() => buildCurrentCapitalLiveChainPlan({ ...planInput, repositorySha: "not-a-sha" }), /repository SHA/);
  assert.throws(() => buildCurrentCapitalLiveChainPlan({ ...planInput, transferReceiptPath: "relative.json" }), /paths must be absolute/);
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
  assert.equal(parseArgs([...argv, "--retained-exit-bundle", "/retained/current-kric-exit.json"])["retained-exit-bundle"], "/retained/current-kric-exit.json");
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
  const bundlePath = path.join(temporary, "retained-exit-bundle.json");
  await writeFile(bundlePath, retained.bytes, { mode: 0o600 });
  const operationNow = new Date(retained.snapshot.capturedAt);
  const calls = [];
  const recovered = await recoverCurrentKricExitCollection({
    retainedExitBundle: bundlePath, currentPlanBytes: retained.planBytes,
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
  await assert.rejects(recoverCurrentKricExitCollection({
    retainedExitBundle: bundlePath, currentPlanBytes: Buffer.from("different"),
    repository: "AquilaXk/easysubway-data", repositorySha: "a".repeat(40), operationId: "current-capital-561",
    operationNow, root: ROOT, execFileImpl: async () => { throw new Error("ancestry must not run"); },
  }), /not the current plan/);
  await assert.rejects(recoverCurrentKricExitCollection({
    retainedExitBundle: bundlePath, currentPlanBytes: retained.planBytes,
    repository: "AquilaXk/easysubway-data", repositorySha: "a".repeat(40), operationId: "current-capital-561",
    operationNow: new Date(Date.parse(retained.snapshot.capturedAt) - 1), root: ROOT,
    execFileImpl: async () => { throw new Error("ancestry must not run"); },
  }), /was not previously captured/);
  await assert.rejects(recoverCurrentKricExitCollection({
    retainedExitBundle: bundlePath, currentPlanBytes: retained.planBytes,
    repository: "AquilaXk/easysubway-data", repositorySha: "a".repeat(40), operationId: "current-capital-561",
    operationNow: new Date(retained.snapshot.freshUntil), root: ROOT,
    execFileImpl: async () => { throw new Error("ancestry must not run"); },
  }), /snapshot is stale/);
  await assert.rejects(recoverCurrentKricExitCollection({
    retainedExitBundle: bundlePath, currentPlanBytes: retained.planBytes,
    repository: "AquilaXk/easysubway-data", repositorySha: "a".repeat(40), operationId: "current-capital-560",
    operationNow, root: ROOT, execFileImpl: async () => { throw new Error("ancestry must not run"); },
  }), /source identity mismatch/);
  await assert.rejects(recoverCurrentKricExitCollection({
    retainedExitBundle: bundlePath, currentPlanBytes: retained.planBytes,
    repository: "AquilaXk/easysubway-data", repositorySha: "b".repeat(40), operationId: "current-capital-561",
    operationNow, root: ROOT, execFileImpl: async () => { throw new Error("ancestry must not run"); },
  }), /source identity mismatch/);
  await assert.rejects(recoverCurrentKricExitCollection({
    retainedExitBundle: bundlePath, currentPlanBytes: retained.planBytes,
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

test("route policy evaluation uses the freshly built staged input and replaces stale staged policy output", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "current-live-chain-route-policy-"));
  const routeEdgeInputPath = path.join(temporary, "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json");
  const stationLineInputPath = path.join(temporary, "tools/datapack/release/current-capital-accessibility-full/station-line-input.json");
  const outputPath = path.join(temporary, "release/product-gates/route-edge-evaluation-policy.json");
  const builtRouteEdgeInput = { candidate: "built-current-input", stationLines: ["built-station-line"], routeEdges: ["built-route-edge"] };
  const builtStationLineInput = { candidate: "built-current-materialization", stationLines: ["materialized-station-line"], evidenceRows: ["built-evidence"] };
  const evaluationAt = "2026-08-25T00:00:00.000Z";
  const materialization = { materializationDigest: "derived-from-staged-station-line-input" };
  const stagedPolicy = { policyVersion: "route-edge-evaluation-v2" };
  const evaluation = { evaluationDigest: "fresh-current-evaluation" };
  try {
    await mkdir(path.dirname(routeEdgeInputPath), { recursive: true });
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(routeEdgeInputPath, JSON.stringify(builtRouteEdgeInput));
    await writeFile(stationLineInputPath, JSON.stringify(builtStationLineInput));
    await writeFile(outputPath, JSON.stringify(stagedPolicy));
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
    assert.notEqual(await readFile(outputPath, "utf8"), JSON.stringify(stagedPolicy));
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

test("candidate-selected versioned ITX topology evidence is staged before every provider or OCI effect", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "current-live-chain-itx-stage-"));
  const runnerTemp = path.join(temporary, "runner");
  const handoffParent = path.join(temporary, "handoff-parent");
  const handoffDirectory = path.join(handoffParent, "handoff");
  const selectedPath = "tools/datapack/itx-cheongchun-topology-evidence-20260824170958799.json";
  const coveragePath = "tools/datapack/itx-cheongchun-coverage-contract.json";
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
