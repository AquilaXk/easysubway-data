import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { copySyntheticCurrentPublicRouteMapRepository } from "./test-fixtures/current-public-route-map-successor.mjs";

import {
  buildCurrentActivePublicRouteMapMaterializationOutputs,
  captureCurrentActivePublicRouteMapPublishPrestate,
  commitCurrentActivePublicRouteMapMaterializationOutputs,
  parseCurrentActivePublicRouteMapMaterializationArgs,
  recoverCurrentActivePublicRouteMapMaterialization,
  rebindCurrentActivePublicRouteMapMaterialization,
} from "./rebind-current-active-public-route-map-materialization.mjs";

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUTPUTS = [
  "tools/datapack/release/capital-production-canonical-pack.json",
  "tools/datapack/release/candidate-build-spec.json",
  "tools/datapack/release/release-request.json",
  "tools/datapack/release/hash-evidence.json",
];
const P_INPUTS = [
  ...OUTPUTS,
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/source-inventory.json",
  "tools/datapack/source-governance-policy.json",
  "release/product-gates/datapack-freshness-sla.json",
  "release/product-gates/production-datapack-scope.json",
];

async function preparedPStage() {
  const stage = await mkdtemp(path.join(os.tmpdir(), "current-public-route-map-stage-"));
  const candidate = JSON.parse(await readFile(path.join(ROOT, "tools/datapack/release/candidate-build-spec.json"), "utf8"));
  // 등록 중인 inventory와 이전 candidate를 섞지 않고 동일한 테스트 입력을 생성한다.
  try {
    await copySyntheticCurrentPublicRouteMapRepository(ROOT, stage, {
      now: new Date(candidate.publishedAt),
    });
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
  return stage;
}

async function prepareProtectedParents(root) {
  await Promise.all([
    mkdir(path.join(root, "tools/datapack/sources"), { recursive: true }),
    mkdir(path.join(root, "tools/datapack/release"), { recursive: true }),
    mkdir(path.join(root, "release/product-gates"), { recursive: true }),
  ]);
}

test("current public route-map materialization preserves capital identity and completes public evidence", async () => {
  const stage = await preparedPStage();
  try {
  const plan = await buildCurrentActivePublicRouteMapMaterializationOutputs({ repositoryRoot: stage });
  assert.deepEqual(plan.outputs.map(({ relative }) => relative), OUTPUTS);
  const candidate = JSON.parse(plan.inputCapture.find(({ relative }) => relative === "tools/datapack/release/candidate-build-spec.json").bytes);
  const stagedInventoryBytes = await readFile(path.join(stage, "tools/datapack/source-inventory.json"));
  const stagedInventory = JSON.parse(stagedInventoryBytes);
  const admission = stagedInventory.sources.find(({ id }) => id === "seoul-metro-route-map-positions")
    .routeMapAdmissionEvidence.currentLayoutAdmission;
  const expectedInputs = new Set([
    ...P_INPUTS,
    candidate.itxTopologyEvidencePath,
    admission.snapshotPath,
    `tools/datapack/sources/${admission.topologySnapshotId}.json`,
  ]);
  assert.deepEqual(new Set(plan.inputCapture.map(({ relative }) => relative)), expectedInputs);
  const scopeRelative = "release/product-gates/production-datapack-scope.json";
  assert.equal(OUTPUTS.includes(scopeRelative), false);
  assert.deepEqual(
    plan.inputCapture.find(({ relative }) => relative === scopeRelative).bytes,
    await readFile(path.join(stage, scopeRelative)),
  );

  const document = JSON.parse(plan.outputs[0].bytes);
  assert.equal(plan.outputs[0].bytes.toString(), `${JSON.stringify(document)}\n`);
  assert.equal(plan.outputs[0].bytes.toString().includes("\n  \""), false);
  const pack = document.packs.find(({ id }) => id === "capital");
  const publicRows = pack.routeMapPositions.filter(({ sourceId }) => sourceId === "seoul-metro-route-map-positions");
  const publicTracks = pack.routeMapLineTracks.filter(({ sourceId }) => sourceId === "seoul-metro-route-map-positions");
  assert.deepEqual(document.manifest.activePack, { id: "capital", version: pack.version });
  const observationPath = admission.snapshotPath;
  const observation = JSON.parse(await readFile(path.join(stage, observationPath), "utf8"));
  assert.equal(publicRows.length, observation.routeMapLayoutArtifact.rawPositions.length);
  assert.equal(publicTracks.length, observation.routeMapLayoutArtifact.layoutTracks.length);
  assert.equal(pack.routeMapPositions.some(({ sourceId }) => sourceId === "seoulmetro-cyberstation-route-map"), false);
  assert.equal(pack.sourceInventory.some(({ id }) => id === "seoulmetro-cyberstation-route-map"), false);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

test("candidate ITX topology evidence path is confined to the versioned root-relative contract", async () => {
  const stage = await preparedPStage();
  try {
    const candidatePath = path.join(stage, "tools/datapack/release/candidate-build-spec.json");
    const candidate = JSON.parse(await readFile(candidatePath, "utf8"));
    assert.equal(candidate.itxTopologyEvidencePath, "tools/datapack/itx-cheongchun-topology-evidence-20260830151508786.json");
    await assert.doesNotReject(buildCurrentActivePublicRouteMapMaterializationOutputs({ repositoryRoot: stage }));
    candidate.itxTopologyEvidencePath = "../outside.json";
    await writeFile(candidatePath, `${JSON.stringify(candidate)}\n`);
    await assert.rejects(
      buildCurrentActivePublicRouteMapMaterializationOutputs({ repositoryRoot: stage }),
      /candidate ITX topology evidence path is invalid/,
    );
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

test("CLI는 절대 staged repository root와 check를 정확히 전달한다", async () => {
  const stage = await preparedPStage();
  try {
    assert.deepEqual(
      parseCurrentActivePublicRouteMapMaterializationArgs(["--repository-root", stage, "--check"]),
      { repositoryRoot: stage, check: true },
    );
    for (const argv of [
      ["--repository-root", "relative"], ["--repository-root"], ["--check", "--check"],
      ["--unknown"], ["--repository-root", stage, "unexpected"],
      ["--repository-root", ROOT, "--repository-root", stage],
    ]) {
      assert.throws(() => parseCurrentActivePublicRouteMapMaterializationArgs(argv), /arguments are invalid/);
    }
    const cli = path.join(ROOT, "tools/datapack/rebind-current-active-public-route-map-materialization.mjs");
    await execFileAsync(process.execPath, [cli, "--repository-root", stage]);
    await execFileAsync(process.execPath, [cli, "--check", "--repository-root", stage]);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

test("check mode reports current materialization drift without writes", async () => {
  const stage = await preparedPStage();
  try {
  const before = await Promise.all(OUTPUTS.map((relative) => readFile(path.join(stage, relative))));
  const driftedCanonical = Buffer.concat([before[0], Buffer.from("\n")]);
  await writeFile(path.join(stage, OUTPUTS[0]), driftedCanonical);
  await assert.rejects(
    rebindCurrentActivePublicRouteMapMaterialization({ repositoryRoot: stage, check: true }),
    /current public route-map materialization drift:/,
  );
  const after = await Promise.all(OUTPUTS.map((relative) => readFile(path.join(stage, relative))));
  assert.deepEqual(after[0], driftedCanonical);
  assert.deepEqual(after.slice(1), before.slice(1));
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

test("injected replacement failure restores the exact output prestate", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "current-public-route-map-"));
  try {
    await prepareProtectedParents(temporaryRoot);
    const before = await Promise.all(OUTPUTS.map(async (relative, index) => {
      const file = path.join(temporaryRoot, relative);
      await mkdir(path.dirname(file), { recursive: true });
      const bytes = Buffer.from(`before-${index}`);
      await writeFile(file, bytes);
      return { relative, bytes };
    }));
    const outputs = before.map(({ relative }, index) => ({
      relative,
      bytes: Buffer.from(`after-${index}`),
    }));
    const capture = await captureCurrentActivePublicRouteMapPublishPrestate({ repositoryRoot: temporaryRoot });
    await assert.rejects(
      commitCurrentActivePublicRouteMapMaterializationOutputs({
        repositoryRoot: temporaryRoot,
        outputs,
        inputCapture: capture.outputPrestate,
        ...capture,
        failAfter: 2,
      }),
      /injected transaction failure/,
    );
    const after = await Promise.all(before.map(({ relative }) => readFile(path.join(temporaryRoot, relative))));
    assert.deepEqual(after, before.map(({ bytes }) => bytes));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("publish refuses symlinked dynamic source and product-gate parents", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "current-public-route-map-symlink-"));
  try {
    for (const relative of ["tools/datapack/sources", "release/product-gates"]) {
      await prepareProtectedParents(temporaryRoot);
      const target = path.join(temporaryRoot, `outside-${relative.replaceAll("/", "-")}`);
      await mkdir(target);
      await rm(path.join(temporaryRoot, relative), { recursive: true });
      await symlink(target, path.join(temporaryRoot, relative));
      await assert.rejects(
        captureCurrentActivePublicRouteMapPublishPrestate({ repositoryRoot: temporaryRoot }),
        /parent is not a root-bound regular directory/,
      );
      await rm(path.join(temporaryRoot, relative));
      await mkdir(path.join(temporaryRoot, relative), { recursive: true });
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("post-write input drift rolls back only owned output bytes", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "current-public-route-map-input-drift-"));
  try {
    await prepareProtectedParents(temporaryRoot);
    const before = await Promise.all(OUTPUTS.map(async (relative, index) => {
      const file = path.join(temporaryRoot, relative);
      await mkdir(path.dirname(file), { recursive: true });
      const bytes = Buffer.from(`before-${index}`);
      await writeFile(file, bytes);
      return { relative, bytes };
    }));
    const inputRelative = "tools/datapack/source-inventory.json";
    const inputFile = path.join(temporaryRoot, inputRelative);
    await writeFile(inputFile, "captured-input");
    const capture = await captureCurrentActivePublicRouteMapPublishPrestate({ repositoryRoot: temporaryRoot });
    await assert.rejects(
      commitCurrentActivePublicRouteMapMaterializationOutputs({
        repositoryRoot: temporaryRoot,
        outputs: before.map(({ relative }, index) => ({ relative, bytes: Buffer.from(`after-${index}`) })),
        inputCapture: [{ relative: inputRelative, bytes: Buffer.from("captured-input") }],
        ...capture,
        afterOutputWrites: async () => writeFile(inputFile, "drifted-input"),
      }),
      /captured input changed: tools\/datapack\/source-inventory.json/,
    );
    assert.deepEqual(
      await Promise.all(before.map(({ relative }) => readFile(path.join(temporaryRoot, relative)))),
      before.map(({ bytes }) => bytes),
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("PREPARED partial journal automatically rolls back known after bytes", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "current-public-route-map-journal-"));
  try {
    await prepareProtectedParents(temporaryRoot);
    const before = await Promise.all(OUTPUTS.map(async (relative, index) => {
      const file = path.join(temporaryRoot, relative);
      await mkdir(path.dirname(file), { recursive: true });
      const bytes = Buffer.from(`before-${index}`);
      await writeFile(file, bytes);
      return { relative, bytes };
    }));
    const capture = await captureCurrentActivePublicRouteMapPublishPrestate({ repositoryRoot: temporaryRoot });
    const outputs = before.map(({ relative }, index) => ({ relative, bytes: Buffer.from(`after-${index}`) }));
    await writeFile(path.join(temporaryRoot, "tools/datapack/release/.current-public-route-map-materialization.journal.json"), JSON.stringify({
      schemaVersion: 1,
      state: "PREPARED",
      parents: capture.parents,
      outputs: outputs.map(({ relative, bytes }, index) => ({
        relative,
        before: before[index].bytes.toString("base64"),
        after: bytes.toString("base64"),
      })),
    }));
    await writeFile(path.join(temporaryRoot, OUTPUTS[0]), outputs[0].bytes);
    await recoverCurrentActivePublicRouteMapMaterialization({ repositoryRoot: temporaryRoot });
    assert.deepEqual(
      await Promise.all(before.map(({ relative }) => readFile(path.join(temporaryRoot, relative)))),
      before.map(({ bytes }) => bytes),
    );
    await assert.rejects(
      readFile(path.join(temporaryRoot, "tools/datapack/release/.current-public-route-map-materialization.journal.json")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
