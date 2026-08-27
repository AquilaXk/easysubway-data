#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readCurrentSourceSetHandoff } from "./build-current-source-set-handoff.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const OPERATION = /^[a-z0-9][a-z0-9-]{7,127}$/u;
const PROTECTED_PATHS = Object.freeze([
  "tools/datapack/inputs/capital-pilot-production-source-input.json",
  "tools/datapack/release/candidate-build-spec.json",
  "tools/datapack/release/capital-production-canonical-pack.json",
  "tools/datapack/release/capital-production-reviewed-pack.json",
  "tools/datapack/release/hash-evidence.json",
  "tools/datapack/release/release-request.json",
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/source-inventory.json",
]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export class CurrentSourceSetMaterializationError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "CurrentSourceSetMaterializationError";
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new CurrentSourceSetMaterializationError(code, message, options);
}

function requireIdentity({ sourceRepositorySha, producerSha, operationId }) {
  if (!SHA1.test(sourceRepositorySha ?? "") || !SHA1.test(producerSha ?? "") || !OPERATION.test(operationId ?? "")) {
    fail("IDENTITY_INVALID", "current source-set materialization identity mismatch");
  }
}

function requireAbsolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) fail("ARGUMENT_INVALID", `${label} must be absolute`);
  return value;
}

export function parseArgs(args) {
  if (args.length !== 12 || args[0] !== "--handoff" || args[2] !== "--expected-handoff-sha256"
    || args[4] !== "--source-repository-sha" || args[6] !== "--producer-sha" || args[8] !== "--operation-id" || args[10] !== "--output-root") {
    fail("ARGUMENT_INVALID", "current source-set materialization arguments mismatch");
  }
  requireAbsolute(args[1], "handoff");
  requireAbsolute(args[11], "output root");
  if (!SHA256.test(args[3] ?? "")) fail("ARGUMENT_INVALID", "expected handoff SHA-256 mismatch");
  requireIdentity({ sourceRepositorySha: args[5], producerSha: args[7], operationId: args[9] });
  return { handoffPath: args[1], expectedHandoffSha256: args[3], sourceRepositorySha: args[5], producerSha: args[7], operationId: args[9], outputRoot: args[11] };
}

async function readStableRegularFile(filePath, label) {
  if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_NONBLOCK)) {
    fail("INPUT_INVALID", `${label} cannot enforce safe open flags`);
  }
  let handle;
  try { handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { fail("INPUT_INVALID", `${label} must be a regular non-symlink file`, { cause: error }); }
  try {
    const before = await handle.stat();
    if (!before.isFile()) fail("INPUT_INVALID", `${label} must be a regular file`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const bound = await lstat(filePath);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.dev !== bound.dev || before.ino !== bound.ino || bound.isSymbolicLink()) {
      fail("INPUT_CHANGED", `${label} changed while reading`);
    }
    return bytes;
  } finally { await handle.close(); }
}

async function assertAbsentOutputRoot(outputRoot) {
  try {
    await lstat(outputRoot);
    fail("OUTPUT_EXISTS", "current source-set output root already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function assertOutputParent(parent, expectedIdentity) {
  let stat;
  try { stat = await lstat(parent); }
  catch (error) { fail("OUTPUT_INVALID", "current source-set output parent missing", { cause: error }); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("OUTPUT_INVALID", "current source-set output parent mismatch");
  if (expectedIdentity && (stat.dev !== expectedIdentity.dev || stat.ino !== expectedIdentity.ino)) {
    fail("OUTPUT_INVALID", "current source-set output parent changed");
  }
  return { dev: stat.dev, ino: stat.ino };
}

function validatedOutputs(handoff) {
  if (!Array.isArray(handoff.protectedOutputs) || handoff.protectedOutputs.length !== PROTECTED_PATHS.length) {
    fail("HANDOFF_INVALID", "current source-set protected output count mismatch");
  }
  const entries = new Map();
  for (const entry of handoff.protectedOutputs) {
    if (!entry || typeof entry.path !== "string" || !SHA256.test(entry.sha256 ?? "") || typeof entry.bytesBase64 !== "string"
      || !PROTECTED_PATHS.includes(entry.path) || entries.has(entry.path)) {
      fail("HANDOFF_INVALID", "current source-set protected output mismatch");
    }
    const bytes = Buffer.from(entry.bytesBase64, "base64");
    if (bytes.length === 0 || bytes.toString("base64") !== entry.bytesBase64 || sha256(bytes) !== entry.sha256) {
      fail("HANDOFF_INVALID", "current source-set protected output bytes mismatch");
    }
    entries.set(entry.path, bytes);
  }
  if (entries.size !== PROTECTED_PATHS.length || PROTECTED_PATHS.some((entry) => !entries.has(entry))) {
    fail("HANDOFF_INVALID", "current source-set protected output allowlist mismatch");
  }
  return entries;
}

function resultFor(handoff, handoffSha256) {
  return {
    artifactKind: "current-source-set-materialization",
    candidateId: handoff.candidate.candidateId,
    count: PROTECTED_PATHS.length,
    handoffSha256,
    itxCoverageContractSha256: handoff.itx.coverageContract.sha256,
    itxTopologyEvidenceSha256: handoff.itx.topologyEvidence.sha256,
    mobileGzipSha256: handoff.mobile.gzipSha256,
    mobileRepositoryRevision: handoff.mobile.repositoryRevision,
    mobileSqliteSha256: handoff.mobile.sqliteSha256,
    sourceSnapshotSetHash: handoff.candidate.sourceSnapshotSetHash,
  };
}

async function materializeAtomically({ parent, parentIdentity, outputRoot, entries }) {
  const staging = path.join(parent, `.${path.basename(outputRoot)}.current-source-set-staging-${randomUUID()}`);
  let stagingCreated = false;
  try {
    await mkdir(staging, { mode: 0o700 });
    stagingCreated = true;
    for (const relative of PROTECTED_PATHS) {
      const target = path.join(staging, relative);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, entries.get(relative), { flag: "wx", mode: 0o600 });
    }
    await assertOutputParent(parent, parentIdentity);
    await assertAbsentOutputRoot(outputRoot);
    await rename(staging, outputRoot);
  } catch (error) {
    if (stagingCreated) await rm(staging, { recursive: true, force: true });
    if (error instanceof CurrentSourceSetMaterializationError) throw error;
    fail("OUTPUT_WRITE_FAILED", "current source-set output materialization failed", { cause: error });
  }
}

export async function materializeCurrentSourceSet({ handoffPath, expectedHandoffSha256, sourceRepositorySha, producerSha, operationId, outputRoot }) {
  requireAbsolute(handoffPath, "handoff");
  requireAbsolute(outputRoot, "output root");
  requireIdentity({ sourceRepositorySha, producerSha, operationId });
  if (!SHA256.test(expectedHandoffSha256 ?? "")) fail("ARGUMENT_INVALID", "expected handoff SHA-256 mismatch");
  const parent = path.dirname(outputRoot);
  const parentIdentity = await assertOutputParent(parent);
  await assertAbsentOutputRoot(outputRoot);
  let handoffBytes;
  try { handoffBytes = await readStableRegularFile(handoffPath, "handoff"); }
  catch (error) {
    if (error instanceof CurrentSourceSetMaterializationError) throw error;
    fail("INPUT_INVALID", "current source-set handoff read failed", { cause: error });
  }
  const handoffSha256 = sha256(handoffBytes);
  if (handoffSha256 !== expectedHandoffSha256) fail("HANDOFF_SHA256_MISMATCH", "current source-set handoff SHA-256 mismatch");
  let handoff;
  try { handoff = readCurrentSourceSetHandoff(handoffBytes, { sourceRepositorySha, producerSha, operationId }); }
  catch (error) { fail("HANDOFF_INVALID", "current source-set handoff validation failed", { cause: error }); }
  const entries = validatedOutputs(handoff);
  await materializeAtomically({ parent, parentIdentity, outputRoot, entries });
  return resultFor(handoff, handoffSha256);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = parseArgs(process.argv.slice(2));
  const result = await materializeCurrentSourceSet(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
