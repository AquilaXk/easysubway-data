import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LIVE_CHAIN_OUTPUTS, buildCurrentCapitalLiveChainPlan, evaluateStagedRoutePolicy, parseArgs, runCurrentCapitalLiveChain } from "./run-current-capital-live-chain.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");

const planInput = {
  repositoryRoot: "/repository", repositorySha: "a".repeat(40), operationId: "current-capital-560", stagedRoot: "/runner/staged",
  transferObservationDirectory: "/retained/transfer/observation", transferReceiptPath: "/retained/transfer/receipt.json",
};

test("live chain fixes the staged P/F/T to EXIT to full-capital order and invokes the collector exactly once", () => {
  const plan = buildCurrentCapitalLiveChainPlan(planInput);
  assert.equal(plan.steps.filter(({ id }) => id === "collect-kric-exit").length, 1);
  assert.deepEqual(plan.steps.map(({ id }) => id), [
    "prepare-staged-public-route-map-inventory", "materialize-public-route-map", "rebind-transfer", "rebind-facility", "build-exit-plan",
    "collect-kric-exit", "bind-exit-collection", "admit-exit", "bind-current-fan-in", "build-full-capital", "evaluate-route-policy", "bundle",
  ]);
  assert.equal(plan.steps.findIndex(({ id }) => id === "prepare-staged-public-route-map-inventory") + 1, plan.steps.findIndex(({ id }) => id === "materialize-public-route-map"));
  assert.equal(plan.steps.some(({ script }) => /current-station-line-accessibility|current-route-edge-evaluation|refresh-current-capital-accessibility-full|rebind-current-active-transfer-derived-identities/.test(script)), false);
  assert.deepEqual(plan.steps.find(({ id }) => id === "rebind-transfer").args.slice(-4), ["--observation-directory", planInput.transferObservationDirectory, "--receipt", planInput.transferReceiptPath]);
  assert.deepEqual(plan.outputs, LIVE_CHAIN_OUTPUTS);
  assert.throws(() => buildCurrentCapitalLiveChainPlan({ ...planInput, repositorySha: "not-a-sha" }), /repository SHA/);
  assert.throws(() => buildCurrentCapitalLiveChainPlan({ ...planInput, transferReceiptPath: "relative.json" }), /paths must be absolute/);
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

test("staged inventory preparation failure stops before the provider and OCI boundaries", async () => {
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
        if (args.join(" ") === "status --porcelain=v1 --untracked-files=all") return { stdout: "" };
        throw new Error("provider execution must not start");
      },
      prepareStagedPublicRouteMapInventoryImpl: async () => { throw new Error("staged inventory preparation failed"); },
      publishImpl: async () => { throw new Error("OCI publication must not start"); },
    }), /staged inventory preparation failed/);
    assert.equal(calls.length, 4);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
