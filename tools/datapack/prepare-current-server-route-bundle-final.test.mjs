import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parsePrepareCurrentServerRouteBundleFinalArgs, prepareCurrentServerRouteBundleFinal } from "./prepare-current-server-route-bundle-final.mjs";

test("current FINAL preparation은 closed stage order와 output inventory를 보존한다", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-final-preparation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "output");
  const stationLineInputPath = path.join(root, "station.json");
  const routeEdgeInputPath = path.join(root, "route.json");
  await Promise.all([writeFile(stationLineInputPath, "{}"), writeFile(routeEdgeInputPath, "{}")]);
  const calls = [];
  const argv = [
    "--source-sqlite", "source.sqlite", "--source-provenance", "provenance.json", "--build-spec", "tools/datapack/release/candidate-build-spec.json",
    "--output", output, "--map-pack-id", "map", "--catalog-pack-id", "catalog", "--bundle-id", "bundle", "--release-sequence", "7",
    "--active-from", "2026-08-14T09:00:00.000+09:00", "--fresh-until", "2026-08-15T09:00:00.000+09:00", "--built-at", "2026-08-14T00:00:00.000Z",
    "--key-id", "key", "--evaluation-at", "2026-08-14T00:00:00.000Z", "--station-line-input", stationLineInputPath,
    "--route-edge-input", routeEdgeInputPath, "--repository-git-sha", "a".repeat(40),
  ];
  const parsed = parsePrepareCurrentServerRouteBundleFinalArgs(argv);
  assert.equal(parsed.emitterInputs.releaseSequence, 7);
  assert.equal(parsed.stationLineInputPath, stationLineInputPath);
  assert.equal(parsed.routeEdgeInputPath, routeEdgeInputPath);
  assert.equal(parsed.repositoryGitSha, "a".repeat(40));
  assert.equal(parsed.emitterInputs.evaluationAt, undefined);
  assert.throws(() => parsePrepareCurrentServerRouteBundleFinalArgs([...argv, "--extra", "x"]), /CLI arguments mismatch/);
  let eligibilityInputBytes;
  const stages = Object.fromEntries(["emit", "sign", "final", "eligibility"].map((name) => [name, async (input) => {
    calls.push([name, input]);
    if (name === "eligibility") {
      eligibilityInputBytes = await Promise.all([
        readFile(input.stationLineInput, "utf8"),
        readFile(input.routeEdgeInput, "utf8"),
      ]);
      await writeFile(input.output, name);
    } else {
      await mkdir(input.output, { recursive: true });
      await writeFile(path.join(input.output, ".done"), name);
    }
    if (name === "sign") {
      await Promise.all([
        writeFile(stationLineInputPath, '{"mutated":true}'),
        writeFile(routeEdgeInputPath, '{"mutated":true}'),
      ]);
    }
  }]));
  await prepareCurrentServerRouteBundleFinal({
    output,
    repositoryGitSha: "a".repeat(40),
    evaluationAt: "2026-08-14T00:00:00.000Z",
    stationLineInputPath,
    routeEdgeInputPath,
    emitterInputs: { evaluationAt: "2026-08-13T00:00:00.000Z" },
    stages,
  });
  assert.deepEqual(calls.map(([name]) => name), ["emit", "sign", "final", "eligibility", "final"]);
  assert.equal(calls[1][1].input, path.join(path.dirname(calls[1][1].output), "components", "server-route-bundle"));
  assert.equal(calls[2][1].artifactRoot, calls[1][1].output);
  assert.equal(calls[3][1].prepublicationRoot, calls[2][1].output);
  assert.equal(calls[4][1].eligibilityReportPath, calls[3][1].output);
  assert.equal(calls[0][1].evaluationAt, "2026-08-14T00:00:00.000Z");
  assert.notEqual(calls[3][1].stationLineInput, stationLineInputPath);
  assert.notEqual(calls[3][1].routeEdgeInput, routeEdgeInputPath);
  assert.deepEqual(eligibilityInputBytes, ["{}", "{}"]);
  assert.deepEqual((await readdir(output)).sort(), ["bound", "components", "provisional", "route-accessibility-eligibility.json", "signed-server-route-bundle"]);
  assert.equal(await readFile(path.join(output, "route-accessibility-eligibility.json"), "utf8"), "eligibility");
});

test("current FINAL preparation middle failure는 output 없이 종료하고 publisher를 의존하지 않는다", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-final-preparation-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stationLineInputPath = path.join(root, "station.json");
  const routeEdgeInputPath = path.join(root, "route.json");
  await Promise.all([writeFile(stationLineInputPath, "{}"), writeFile(routeEdgeInputPath, "{}")]);
  const output = path.join(root, "output");
  await assert.rejects(() => prepareCurrentServerRouteBundleFinal({
    output, repositoryGitSha: "a".repeat(40), evaluationAt: "2026-08-14T00:00:00.000Z", stationLineInputPath, routeEdgeInputPath,
    stages: {
      emit: async ({ output: stageOutput }) => { await mkdir(stageOutput, { recursive: true }); },
      sign: async () => { throw new Error("representative middle failure"); },
    },
  }), /representative middle failure/);
  await assert.rejects(() => readFile(output), /ENOENT/);
  assert.doesNotMatch(await readFile(new URL("./prepare-current-server-route-bundle-final.mjs", import.meta.url), "utf8"), /publish-server-route-bundle/);
});
