import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCurrentActivePublicRouteMapMaterializationOutputs,
  captureCurrentActivePublicRouteMapPublishPrestate,
  commitCurrentActivePublicRouteMapMaterializationOutputs,
  recoverCurrentActivePublicRouteMapMaterialization,
  rebindCurrentActivePublicRouteMapMaterialization,
} from "./rebind-current-active-public-route-map-materialization.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUTPUTS = [
  "tools/datapack/release/capital-production-canonical-pack.json",
  "tools/datapack/release/candidate-build-spec.json",
  "tools/datapack/release/release-request.json",
  "tools/datapack/release/hash-evidence.json",
];

async function prepareProtectedParents(root) {
  await Promise.all([
    mkdir(path.join(root, "tools/datapack/sources"), { recursive: true }),
    mkdir(path.join(root, "tools/datapack/release"), { recursive: true }),
    mkdir(path.join(root, "release/product-gates"), { recursive: true }),
  ]);
}

test("current public route-map materialization preserves capital identity and completes public evidence", async () => {
  const plan = await buildCurrentActivePublicRouteMapMaterializationOutputs({ repositoryRoot: ROOT });
  assert.deepEqual(plan.outputs.map(({ relative }) => relative), OUTPUTS);
  assert.equal(plan.inputCapture.length, 11);

  const document = JSON.parse(plan.outputs[0].bytes);
  assert.equal(plan.outputs[0].bytes.toString(), `${JSON.stringify(document)}\n`);
  assert.equal(plan.outputs[0].bytes.toString().includes("\n  \""), false);
  const pack = document.packs.find(({ id }) => id === "capital");
  const publicRows = pack.routeMapPositions.filter(({ sourceId }) => sourceId === "seoul-metro-route-map-positions");
  const publicTracks = pack.routeMapLineTracks.filter(({ sourceId }) => sourceId === "seoul-metro-route-map-positions");
  assert.deepEqual(document.manifest.activePack, { id: "capital", version: pack.version });
  assert.equal(publicRows.length, 276);
  assert.equal(publicTracks.length, 14);
  assert.equal(pack.routeMapPositions.some(({ sourceId }) => sourceId === "seoulmetro-cyberstation-route-map"), false);
  assert.equal(pack.sourceInventory.some(({ id }) => id === "seoulmetro-cyberstation-route-map"), false);
});

test("check mode reports current materialization drift without writes", async () => {
  const before = await Promise.all(OUTPUTS.map((relative) => readFile(path.join(ROOT, relative))));
  await assert.rejects(
    rebindCurrentActivePublicRouteMapMaterialization({ repositoryRoot: ROOT, check: true }),
    /current public route-map materialization drift:/,
  );
  const after = await Promise.all(OUTPUTS.map((relative) => readFile(path.join(ROOT, relative))));
  assert.deepEqual(after, before);
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
