import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parsePrepareCurrentServerRouteBundleFinalArgs, prepareCurrentServerRouteBundleFinal } from "./prepare-current-server-route-bundle-final.mjs";
import { canonicalRideEdgeSetSha256 } from "./evaluate-route-accessibility-edges.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";

const TOPOLOGY_SHA256 = "b".repeat(64);

function routeEdgeInput(topologySha256 = canonicalRideEdgeSetSha256([rideEdge()])) {
  return {
    candidate: {
      candidateId: "candidate",
      evaluatorVersion: "1",
      policyVersion: "policy",
      sourceSetSha256: "c".repeat(64),
      stationSetSha256: "d".repeat(64),
      topologySha256,
    },
    routeEdges: [rideEdge()],
    stationLines: [],
  };
}

function rideEdge() {
  return {
    edgeId: "ride-a-b", edgeType: "RIDE", fromNodeId: "a:l", toNodeId: "b:l",
    servicePattern: "LOCAL", serviceClass: "SUBWAY", durationSeconds: 60, distanceMeters: 100,
  };
}

test("current FINAL preparation은 emitted topology identity와 closed stage order를 보존한다", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-final-preparation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "output");
  const stationLineInputPath = path.join(root, "station.json");
  const routeEdgeInputPath = path.join(root, "route.json");
  await Promise.all([
    writeFile(stationLineInputPath, "{}"),
    writeFile(routeEdgeInputPath, canonicalJson(routeEdgeInput())),
  ]);
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
  const buildSpecSnapshotBytes = Buffer.from("{\"candidateId\":\"candidate\"}");
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
    if (name === "emit") {
      const artifact = path.join(input.output, "server-route-bundle");
      await mkdir(artifact, { recursive: true });
      await writeFile(path.join(artifact, "manifest.signing-input.json"), `{"topologySha256":"${TOPOLOGY_SHA256}"}`);
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
    emitterInputs: {
      evaluationAt: "2026-08-13T00:00:00.000Z",
      buildSpec: "tools/datapack/release/candidate-build-spec.json",
      buildSpecSnapshotBytes,
    },
    stages,
  });
  assert.deepEqual(calls.map(([name]) => name), ["emit", "sign", "final", "eligibility", "final"]);
  assert.equal(calls[1][1].input, path.join(path.dirname(calls[1][1].output), "components", "server-route-bundle"));
  assert.equal(calls[2][1].artifactRoot, calls[1][1].output);
  assert.equal(calls[3][1].prepublicationRoot, calls[2][1].output);
  assert.equal(calls[4][1].eligibilityReportPath, calls[3][1].output);
  assert.equal(calls[0][1].evaluationAt, "2026-08-14T00:00:00.000Z");
  assert.equal(calls[0][1].buildSpec, "tools/datapack/release/candidate-build-spec.json");
  assert.equal(Buffer.isBuffer(calls[0][1].buildSpecSnapshotBytes), true);
  assert.strictEqual(calls[0][1].buildSpecSnapshotBytes, buildSpecSnapshotBytes);
  assert.deepEqual(calls[0][1].routeEdgeInput.candidate, {
    candidateId: "candidate",
    evaluatorVersion: "1",
    policyVersion: "policy",
    sourceSetSha256: "c".repeat(64),
    stationSetSha256: "d".repeat(64),
  });
  const expectedRouteInput = {
    ...routeEdgeInput(),
    candidate: { ...routeEdgeInput().candidate, topologySha256: TOPOLOGY_SHA256 },
  };
  assert.deepEqual(calls[2][1].routeEdgeInput, expectedRouteInput);
  assert.deepEqual(calls[4][1].routeEdgeInput, expectedRouteInput);
  assert.notEqual(calls[3][1].stationLineInput, stationLineInputPath);
  assert.notEqual(calls[3][1].routeEdgeInput, routeEdgeInputPath);
  assert.deepEqual(eligibilityInputBytes, [
    "{}",
    canonicalJson(expectedRouteInput),
  ]);
  assert.deepEqual((await readdir(output)).sort(), ["bound", "components", "provisional", "route-accessibility-eligibility.json", "signed-server-route-bundle"]);
  assert.equal(await readFile(path.join(output, "route-accessibility-eligibility.json"), "utf8"), "eligibility");
});

test("emitted topology identity의 missing·noncanonical·invalid 값은 output 없이 거부한다", async (t) => {
  for (const [name, manifestBytes, pattern] of [
    ["missing", null, /emitted signing input is missing/],
    ["noncanonical", `{"topologySha256": "${TOPOLOGY_SHA256}"}`, /emitted signing input must be canonical JSON/],
    ["invalid", '{"topologySha256":"not-a-sha"}', /emitted topology sha256 must be lowercase SHA-256/],
  ]) {
    await t.test(name, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), `current-final-topology-${name}-`));
      t.after(() => rm(root, { recursive: true, force: true }));
      const stationLineInputPath = path.join(root, "station.json");
      const routeEdgeInputPath = path.join(root, "route.json");
      const output = path.join(root, "output");
      await Promise.all([
        writeFile(stationLineInputPath, "{}"),
        writeFile(routeEdgeInputPath, canonicalJson(routeEdgeInput())),
      ]);
      await assert.rejects(() => prepareCurrentServerRouteBundleFinal({
        output,
        repositoryGitSha: "a".repeat(40),
        evaluationAt: "2026-08-14T00:00:00.000Z",
        stationLineInputPath,
        routeEdgeInputPath,
        stages: {
          emit: async ({ output: stageOutput }) => {
            const artifact = path.join(stageOutput, "server-route-bundle");
            await mkdir(artifact, { recursive: true });
            if (manifestBytes !== null) {
              await writeFile(path.join(artifact, "manifest.signing-input.json"), manifestBytes);
            }
          },
          sign: async () => { throw new Error("sign must not run"); },
        },
      }), pattern);
      await assert.rejects(() => readFile(output), /ENOENT/);
    });
  }
});

test("current FINAL preparation middle failure는 output 없이 종료하고 publisher를 의존하지 않는다", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-final-preparation-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stationLineInputPath = path.join(root, "station.json");
  const routeEdgeInputPath = path.join(root, "route.json");
  await Promise.all([
    writeFile(stationLineInputPath, "{}"),
    writeFile(routeEdgeInputPath, canonicalJson(routeEdgeInput())),
  ]);
  const output = path.join(root, "output");
  await assert.rejects(() => prepareCurrentServerRouteBundleFinal({
    output, repositoryGitSha: "a".repeat(40), evaluationAt: "2026-08-14T00:00:00.000Z", stationLineInputPath, routeEdgeInputPath,
    stages: {
      emit: async ({ output: stageOutput }) => {
        const artifact = path.join(stageOutput, "server-route-bundle");
        await mkdir(artifact, { recursive: true });
        await writeFile(path.join(artifact, "manifest.signing-input.json"), `{"topologySha256":"${TOPOLOGY_SHA256}"}`);
      },
      sign: async () => { throw new Error("representative middle failure"); },
    },
  }), /representative middle failure/);
  await assert.rejects(() => readFile(output), /ENOENT/);
  assert.doesNotMatch(await readFile(new URL("./prepare-current-server-route-bundle-final.mjs", import.meta.url), "utf8"), /publish-server-route-bundle/);
});

test("semantic RIDE topology digest mismatch는 emit 전에 output 없이 거부한다", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-final-topology-mismatch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stationLineInputPath = path.join(root, "station.json");
  const routeEdgeInputPath = path.join(root, "route.json");
  const output = path.join(root, "output");
  await Promise.all([
    writeFile(stationLineInputPath, "{}"),
    writeFile(routeEdgeInputPath, canonicalJson(routeEdgeInput("e".repeat(64)))),
  ]);
  await assert.rejects(() => prepareCurrentServerRouteBundleFinal({
    output, repositoryGitSha: "a".repeat(40), evaluationAt: "2026-08-14T00:00:00.000Z", stationLineInputPath, routeEdgeInputPath,
    stages: { emit: async () => { throw new Error("emit must not run"); } },
  }), /route-edge producer topology identity mismatch/);
  await assert.rejects(() => readFile(output), /ENOENT/);
});
