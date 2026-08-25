#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
  constants, lstat, mkdir, open, realpath, rename, rm, unlink, writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { syncReleaseEvidence } from "./apply-accessibility-evidence-to-bundled-pack.mjs";
import {
  materializeSeoulRouteMapPositions,
  verifyCurrentCapitalPublicRouteMapDocument,
} from "./materialize-seoul-route-map-positions.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SOURCE_ID = "seoul-metro-route-map-positions";
const OBSERVATION_PATH = "tools/datapack/sources/seoul-metro-route-map-positions-current-20260824T114822985Z.json";
const CAPITAL_TOPOLOGY_PATH = "tools/datapack/sources/capital-route-topology-20260823.json";
const OUTPUTS = Object.freeze([
  "tools/datapack/release/capital-production-canonical-pack.json",
  "tools/datapack/release/candidate-build-spec.json",
  "tools/datapack/release/release-request.json",
  "tools/datapack/release/hash-evidence.json",
]);
const STAGE_INPUTS = Object.freeze([
  ...OUTPUTS,
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/source-inventory.json",
  "tools/datapack/source-governance-policy.json",
  "release/product-gates/datapack-freshness-sla.json",
]);
const JOURNAL_PATH = "tools/datapack/release/.current-public-route-map-materialization.journal.json";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pathFor(root, relative) {
  const permitted = OUTPUTS.includes(relative) || STAGE_INPUTS.includes(relative)
    || relative === OBSERVATION_PATH || relative === CAPITAL_TOPOLOGY_PATH || relative === JOURNAL_PATH
    || /^tools\/datapack\/itx-cheongchun-topology-evidence-\d{8,}\.json$/u.test(relative);
  if (!permitted) throw new Error(`current public route-map path is not allowlisted: ${relative}`);
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new Error(`current public route-map path escapes root: ${relative}`);
  }
  return resolved;
}

function requiredItxTopologyEvidencePath(candidate) {
  const relative = candidate?.itxTopologyEvidencePath;
  if (typeof relative !== "string" || !/^tools\/datapack\/itx-cheongchun-topology-evidence-\d{8,}\.json$/u.test(relative)) {
    throw new Error("current public route-map candidate ITX topology evidence path is invalid");
  }
  return relative;
}

function protectedParentRelatives() {
  const parents = new Set([""]);
  for (const relative of [...STAGE_INPUTS, OBSERVATION_PATH, CAPITAL_TOPOLOGY_PATH, ...OUTPUTS]) {
    let parent = path.posix.dirname(relative);
    while (parent !== ".") {
      parents.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  return [...parents].sort((left, right) => left.localeCompare(right));
}

async function captureParentIdentity(root) {
  const resolvedRoot = path.resolve(root);
  const resolvedRealRoot = await realpath(resolvedRoot);
  const identities = [];
  for (const relative of protectedParentRelatives()) {
    const directory = path.join(resolvedRoot, relative);
    const info = await lstat(directory);
    const directoryRealpath = await realpath(directory);
    if (info.isSymbolicLink() || !info.isDirectory()
      || directoryRealpath !== path.join(resolvedRealRoot, relative)) {
      throw new Error(`current public route-map parent is not a root-bound regular directory: ${relative || "."}`);
    }
    identities.push({ relative, realpath: directoryRealpath, dev: info.dev, ino: info.ino });
  }
  return identities;
}

async function assertParentIdentity(root, expected) {
  const actual = await captureParentIdentity(root);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("current public route-map parent identity changed");
  }
}

async function readStable(relative, { root = ROOT, parse = true } = {}) {
  const file = pathFor(root, relative);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`current public route-map input is not a regular file: ${relative}`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error(`current public route-map input changed while reading: ${relative}`);
    }
    return { relative, bytes, value: parse ? JSON.parse(bytes) : undefined };
  } finally {
    await handle.close();
  }
}

async function captureBytes(root, relatives) {
  return Promise.all([...new Set(relatives)].map((relative) => readStable(relative, { root, parse: false })));
}

async function assertCapturedBytes(root, capture) {
  await Promise.all(capture.map(async ({ relative, bytes }) => {
    const current = await readStable(relative, { root, parse: false });
    if (!current.bytes.equals(bytes)) throw new Error(`current public route-map captured input changed: ${relative}`);
  }));
}

async function replaceAtomicCas(root, relative, expected, next, parents) {
  await assertParentIdentity(root, parents);
  const current = await readStable(relative, { root, parse: false });
  if (!current.bytes.equals(expected)) {
    throw new Error(`current public route-map atomic CAS failed: ${relative}`);
  }
  await writeAtomic(pathFor(root, relative), next);
  await assertParentIdentity(root, parents);
}

function requiredRouteMapSource(inventory) {
  const source = inventory?.sources?.find(({ id }) => id === SOURCE_ID);
  const admission = source?.routeMapAdmissionEvidence?.currentLayoutAdmission;
  if (source?.productionUseAllowed !== true || admission?.status !== "ADMITTED"
    || admission.positionSnapshotId !== "seoul-metro-route-map-positions-current-20260824T114822985Z"
    || admission.snapshotPath !== OBSERVATION_PATH
    || admission.topologySnapshotId !== "capital-route-topology-20260823") {
    throw new Error("current public route-map admission is missing");
  }
  return admission;
}

function requiredSuccessor(snapshots, admission) {
  const successor = snapshots.find(({ sourceId, snapshotId }) =>
    sourceId === SOURCE_ID && snapshotId === admission.positionSnapshotId);
  const migration = successor?.projectionMigration;
  if (successor?.previousSnapshotId !== null
    || migration?.migrationKind !== "CROSS_SOURCE_CANONICAL_REPLACEMENT"
    || migration.sourceId !== SOURCE_ID
    || migration.replacedSourceId !== "seoulmetro-cyberstation-route-map"
    || !Array.isArray(successor.providerRecordHashes)
    || successor.providerRecordHashes.length !== 276) {
    throw new Error("current public route-map successor migration is invalid");
  }
  return successor;
}

function assertObservation(observation, admission, successor, topologyBytes) {
  if (sha256(observation.bytes) !== admission.snapshotSha256
    || observation.value.snapshotId !== admission.positionSnapshotId
    || observation.value.migration?.migrationKind !== "CROSS_SOURCE_CANONICAL_REPLACEMENT"
    || observation.value.migration?.replacedSourceId !== "seoulmetro-cyberstation-route-map"
    || JSON.stringify(observation.value.layoutEvidence) !== JSON.stringify(successor.routeMapLayoutEvidence)
    || JSON.stringify(observation.value.routeMapLayoutArtifact) !== JSON.stringify(successor.routeMapLayoutArtifact)
    || sha256(topologyBytes) !== admission.topologySnapshotSha256) {
    throw new Error("current public route-map observation binding drift");
  }
}

function assertMaterialization(document, successor, previous) {
  verifyCurrentCapitalPublicRouteMapDocument(document, successor, "current public route-map materialization");
  const pack = document.packs.find(({ id }) => id === "capital");
  const previousPack = previous.packs.find(({ id }) => id === "capital");
  const rows = pack.routeMapPositions.filter(({ sourceId }) => sourceId === SOURCE_ID);
  const tracks = pack.routeMapLineTracks.filter(({ sourceId }) => sourceId === SOURCE_ID);
  if (pack.id !== previousPack.id || pack.version !== previousPack.version
    || JSON.stringify(document.manifest.activePack) !== JSON.stringify(previous.manifest.activePack)
    || rows.length !== 276 || tracks.length !== 14
    || pack.routeMapPositions.some(({ sourceId }) => sourceId === "seoulmetro-cyberstation-route-map")
    || pack.sourceInventory.some(({ id }) => id === "seoulmetro-cyberstation-route-map")) {
    throw new Error("current public route-map materialization identity is invalid");
  }
}

async function stageReleaseRoot(root, inputCapture, canonicalBytes) {
  const stage = path.join(root, `.tmp-current-public-route-map-stage-${randomUUID()}`);
  await mkdir(stage);
  const byPath = new Map(inputCapture.map((entry) => [entry.relative, entry.bytes]));
  for (const relative of inputCapture.map(({ relative }) => relative)) {
    const destination = path.join(stage, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, byPath.get(relative), { flag: "wx" });
  }
  await writeFile(path.join(stage, OUTPUTS[0]), canonicalBytes);
  return stage;
}

export async function buildCurrentActivePublicRouteMapMaterializationOutputs({ repositoryRoot = ROOT } = {}) {
  await recoverJournal(repositoryRoot, await captureParentIdentity(repositoryRoot));
  const parents = await captureParentIdentity(repositoryRoot);
  const inputCapture = await captureBytes(repositoryRoot, [
    ...STAGE_INPUTS, OBSERVATION_PATH, CAPITAL_TOPOLOGY_PATH,
  ]);
  const input = new Map(inputCapture.map((entry) => [entry.relative, entry]));
  const canonical = JSON.parse(input.get(OUTPUTS[0]).bytes);
  const itxTopologyEvidencePath = requiredItxTopologyEvidencePath(JSON.parse(input.get("tools/datapack/release/candidate-build-spec.json").bytes));
  inputCapture.push(await readStable(itxTopologyEvidencePath, { root: repositoryRoot, parse: false }));
  input.set(itxTopologyEvidencePath, inputCapture.at(-1));
  const inventory = JSON.parse(input.get("tools/datapack/source-inventory.json").bytes);
  const snapshots = JSON.parse(input.get("tools/datapack/release/source-snapshots.json").bytes);
  const observation = { ...input.get(OBSERVATION_PATH), value: JSON.parse(input.get(OBSERVATION_PATH).bytes) };
  const admission = requiredRouteMapSource(inventory);
  const successor = requiredSuccessor(snapshots, admission);
  assertObservation(observation, admission, successor, input.get(CAPITAL_TOPOLOGY_PATH).bytes);

  const materialized = materializeSeoulRouteMapPositions({
    baseFixture: canonical,
    snapshot: successor,
    routeMapLayoutArtifact: successor.routeMapLayoutArtifact,
    snapshotSha256: sha256(observation.bytes),
    topologySnapshotBytes: input.get(CAPITAL_TOPOLOGY_PATH).bytes,
    inventory,
    rewritePackIdentity: false,
    successorProviderRecordHashes: successor.providerRecordHashes,
    requireSuccessorProviderRecordHashes: true,
  });
  assertMaterialization(materialized, successor, canonical);

  const canonicalBytes = Buffer.from(`${JSON.stringify(materialized)}\n`);
  const stage = await stageReleaseRoot(repositoryRoot, inputCapture, canonicalBytes);
  try {
    await syncReleaseEvidence({ check: false, releaseRoot: stage });
    const outputs = await Promise.all(OUTPUTS.map(async (relative) => ({
      relative,
      bytes: await readStable(relative, { root: stage, parse: false }).then(({ bytes }) => bytes),
    })));
    const outputPrestate = inputCapture.filter(({ relative }) => OUTPUTS.includes(relative));
    return { outputs, inputCapture, outputPrestate, parents };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function writeAtomic(file, bytes) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx" });
  await rename(temporary, file);
}

function validJournal(journal) {
  if (journal?.schemaVersion !== 1 || !["PREPARED", "COMMITTED"].includes(journal.state)
    || !Array.isArray(journal.outputs) || journal.outputs.length !== OUTPUTS.length
    || journal.outputs.some(({ relative }, index) => relative !== OUTPUTS[index])
    || !Array.isArray(journal.parents)) {
    throw new Error("current public route-map journal is invalid");
  }
  return journal;
}

async function verifyOutputSet(root, outputs, field) {
  await Promise.all(outputs.map(async (output) => {
    const expected = Buffer.from(output[field], "base64");
    const current = await readStable(output.relative, { root, parse: false });
    if (!current.bytes.equals(expected)) throw new Error(`current public route-map journal ${field} verification failed: ${output.relative}`);
  }));
}

async function recoverJournal(root, parents) {
  const journalFile = pathFor(root, JOURNAL_PATH);
  let journal;
  try {
    journal = validJournal((await readStable(JOURNAL_PATH, { root })).value);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (JSON.stringify(journal.parents) !== JSON.stringify(parents)) {
    throw new Error("current public route-map journal parent identity mismatch");
  }
  const current = await Promise.all(journal.outputs.map(({ relative }) => readStable(relative, { root, parse: false })));
  const state = current.map(({ bytes }, index) => {
    const output = journal.outputs[index];
    if (bytes.equals(Buffer.from(output.before, "base64"))) return "before";
    if (bytes.equals(Buffer.from(output.after, "base64"))) return "after";
    return "unknown";
  });
  if (state.includes("unknown")) throw new Error("current public route-map journal contains unknown output bytes; recovery refused");
  if (journal.state === "PREPARED" && state.includes("after")) {
    for (const [index, output] of journal.outputs.entries()) {
      if (state[index] === "after") {
        await replaceAtomicCas(root, output.relative, Buffer.from(output.after, "base64"), Buffer.from(output.before, "base64"), parents);
      }
    }
  } else if (journal.state === "COMMITTED" && state.includes("before") && state.includes("after")) {
    throw new Error("current public route-map committed journal is partial; recovery refused");
  }
  await verifyOutputSet(root, journal.outputs,
    journal.state === "PREPARED" || state.every((entry) => entry === "before") ? "before" : "after");
  await assertParentIdentity(root, parents);
  await unlink(journalFile);
}

export async function recoverCurrentActivePublicRouteMapMaterialization({ repositoryRoot = ROOT } = {}) {
  await recoverJournal(repositoryRoot, await captureParentIdentity(repositoryRoot));
}

export async function captureCurrentActivePublicRouteMapPublishPrestate({ repositoryRoot = ROOT } = {}) {
  const parents = await captureParentIdentity(repositoryRoot);
  return {
    outputPrestate: await captureBytes(repositoryRoot, OUTPUTS),
    parents,
  };
}

export async function commitCurrentActivePublicRouteMapMaterializationOutputs({
  repositoryRoot = ROOT,
  outputs,
  inputCapture,
  outputPrestate,
  parents,
  failAfter = null,
  afterOutputWrites = null,
} = {}) {
  if (!Array.isArray(outputs) || outputs.length !== OUTPUTS.length
    || outputs.some(({ relative }, index) => relative !== OUTPUTS[index])
    || !Array.isArray(inputCapture) || !Array.isArray(outputPrestate) || !Array.isArray(parents)) {
    throw new Error("current public route-map output transaction capture is missing");
  }
  await assertParentIdentity(repositoryRoot, parents);
  await assertCapturedBytes(repositoryRoot, inputCapture);
  await assertCapturedBytes(repositoryRoot, outputPrestate);
  const journalFile = pathFor(repositoryRoot, JOURNAL_PATH);
  const journal = {
    schemaVersion: 1,
    state: "PREPARED",
    parents,
    outputs: outputs.map(({ relative, bytes }, index) => ({
      relative,
      before: outputPrestate[index].bytes.toString("base64"),
      after: bytes.toString("base64"),
    })),
  };
  await writeFile(journalFile, JSON.stringify(journal), { flag: "wx" });
  try {
    await assertParentIdentity(repositoryRoot, parents);
    await assertCapturedBytes(repositoryRoot, inputCapture);
    await assertCapturedBytes(repositoryRoot, outputPrestate);
    for (const [index, output] of outputs.entries()) {
      await replaceAtomicCas(
        repositoryRoot,
        output.relative,
        outputPrestate[index].bytes,
        output.bytes,
        parents,
      );
      if (failAfter === index + 1) throw new Error("current public route-map injected transaction failure");
    }
    await afterOutputWrites?.();
    await verifyOutputSet(repositoryRoot, journal.outputs, "after");
    await assertCapturedBytes(repositoryRoot, inputCapture.filter(({ relative }) => !OUTPUTS.includes(relative)));
    await assertParentIdentity(repositoryRoot, parents);
    journal.state = "COMMITTED";
    await writeAtomic(journalFile, Buffer.from(JSON.stringify(journal)));
    await verifyOutputSet(repositoryRoot, journal.outputs, "after");
    await assertParentIdentity(repositoryRoot, parents);
    await unlink(journalFile);
  } catch (error) {
    try {
      for (const output of [...journal.outputs].reverse()) {
        const before = Buffer.from(output.before, "base64");
        const after = Buffer.from(output.after, "base64");
        const current = await readStable(output.relative, { root: repositoryRoot, parse: false });
        if (current.bytes.equals(after)) {
          await replaceAtomicCas(repositoryRoot, output.relative, after, before, parents);
        } else if (!current.bytes.equals(before)) {
          throw new Error(`current public route-map rollback ownership is unknown: ${output.relative}`);
        }
      }
      await verifyOutputSet(repositoryRoot, journal.outputs, "before");
      await assertParentIdentity(repositoryRoot, parents);
      await unlink(journalFile);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "current public route-map rollback failed; journal retained");
    }
    throw error;
  }
}

export async function rebindCurrentActivePublicRouteMapMaterialization({
  repositoryRoot = ROOT,
  check = false,
  failAfter = null,
} = {}) {
  const plan = await buildCurrentActivePublicRouteMapMaterializationOutputs({ repositoryRoot });
  const drift = plan.outputs.filter(({ relative, bytes }) =>
    !plan.outputPrestate.find((entry) => entry.relative === relative).bytes.equals(bytes)).map(({ relative }) => relative);
  if (check) {
    if (drift.length > 0) throw new Error(`current public route-map materialization drift: ${drift.join(", ")}`);
    return { ...plan, drift };
  }
  await commitCurrentActivePublicRouteMapMaterializationOutputs({ ...plan, repositoryRoot, failAfter });
  return { ...plan, drift };
}

async function main(argv) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--check")) {
    throw new Error("usage: rebind-current-active-public-route-map-materialization.mjs [--check]");
  }
  await rebindCurrentActivePublicRouteMapMaterialization({ check: argv[0] === "--check" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "current public route-map materialization failed");
    process.exitCode = 1;
  }
}
