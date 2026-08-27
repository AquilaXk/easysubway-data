import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCurrentSourceSetHandoff } from "./build-current-source-set-handoff.mjs";
import { materializeCurrentSourceSet } from "./materialize-current-source-set.mjs";
import { canonicalCurrentSourceSetHandoffInput } from "./test-fixtures/current-source-set-handoff.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
function canonicalObject(value) {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalObject(value[key])]));
}
function rehash(value) {
  const { handoffSha256: _ignored, ...payload } = value;
  return Buffer.from(`${JSON.stringify(canonicalObject({ ...payload, handoffSha256: sha256(Buffer.from(JSON.stringify(canonicalObject(payload)))) }))}\n`);
}

test("materializes only the verified protected output set", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "current-source-set-materialize-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const input = await canonicalCurrentSourceSetHandoffInput(temporary);
  const handoffBytes = buildCurrentSourceSetHandoff(input);
  const handoffPath = path.join(temporary, "handoff.json");
  const outputRoot = path.join(temporary, "materialized");
  await writeFile(handoffPath, handoffBytes);
  const result = await materializeCurrentSourceSet({
    handoffPath, expectedHandoffSha256: sha256(handoffBytes), outputRoot,
    sourceRepositorySha: input.sourceRepositorySha, producerSha: input.producerSha, operationId: input.operationId,
  });
  assert.deepEqual(Object.keys(result).sort(), ["artifactKind", "candidateId", "count", "handoffSha256", "itxCoverageContractSha256", "itxTopologyEvidenceSha256", "mobileGzipSha256", "mobileRepositoryRevision", "mobileSqliteSha256", "sourceSnapshotSetHash"]);
  assert.equal(result.artifactKind, "current-source-set-materialization");
  assert.equal(result.count, 8);
  const handoff = JSON.parse(handoffBytes);
  for (const entry of handoff.protectedOutputs) {
    const target = path.join(outputRoot, entry.path);
    assert.equal((await lstat(target)).isFile(), true);
    assert.deepEqual(await readFile(target), Buffer.from(entry.bytesBase64, "base64"));
  }
  assert.equal((await lstat(outputRoot)).isDirectory(), true);
  const cliRoot = path.join(temporary, "cli-output");
  const cli = spawnSync(process.execPath, [
    path.join(import.meta.dirname, "materialize-current-source-set.mjs"),
    "--handoff", handoffPath, "--expected-handoff-sha256", sha256(handoffBytes),
    "--source-repository-sha", input.sourceRepositorySha, "--producer-sha", input.producerSha,
    "--operation-id", input.operationId, "--output-root", cliRoot,
  ], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).count, 8);

  const reject = async (name, bytes, options = {}) => {
    const rejectedPath = path.join(temporary, `${name}.json`);
    const rejectedRoot = path.join(temporary, `${name}-output`);
    await writeFile(rejectedPath, bytes);
    await assert.rejects(materializeCurrentSourceSet({
      handoffPath: rejectedPath, expectedHandoffSha256: sha256(bytes), outputRoot: rejectedRoot,
      sourceRepositorySha: input.sourceRepositorySha, producerSha: input.producerSha, operationId: input.operationId, ...options,
    }), { name: "CurrentSourceSetMaterializationError" });
    await assert.rejects(lstat(rejectedRoot), { code: "ENOENT" });
  };
  await reject("expected-sha", handoffBytes, { expectedHandoffSha256: "0".repeat(64) });
  await reject("identity", handoffBytes, { producerSha: "a".repeat(40) });
  const protectedDrift = JSON.parse(handoffBytes);
  protectedDrift.protectedOutputs[0].path = "tools/datapack/release/unexpected.json";
  await reject("protected", rehash(protectedDrift));
  const itxDrift = JSON.parse(handoffBytes);
  itxDrift.itx.coverageContract.sha256 = "0".repeat(64);
  await reject("itx", rehash(itxDrift));
  const mobileDrift = JSON.parse(handoffBytes);
  mobileDrift.mobile.gzipSha256 = "0".repeat(64);
  await reject("mobile", rehash(mobileDrift));
  const compositeDrift = JSON.parse(handoffBytes);
  compositeDrift.composite.planSha256 = "0".repeat(64);
  await reject("composite", rehash(compositeDrift));
  const duplicate = JSON.parse(handoffBytes);
  duplicate.protectedOutputs[1].path = duplicate.protectedOutputs[0].path;
  await reject("duplicate", rehash(duplicate));
  const fifoPath = path.join(temporary, "handoff.fifo");
  const fifo = spawnSync("mkfifo", [fifoPath], { encoding: "utf8" });
  assert.equal(fifo.status, 0, fifo.stderr);
  await assert.rejects(materializeCurrentSourceSet({
    handoffPath: fifoPath, expectedHandoffSha256: sha256(handoffBytes),
    outputRoot: path.join(temporary, "fifo-output"), sourceRepositorySha: input.sourceRepositorySha,
    producerSha: input.producerSha, operationId: input.operationId,
  }), { name: "CurrentSourceSetMaterializationError", code: "INPUT_INVALID" });
  const sharedParent = path.join(temporary, "shared-parent");
  await mkdir(sharedParent);
  await chmod(sharedParent, 0o755);
  await assert.rejects(materializeCurrentSourceSet({
    handoffPath, expectedHandoffSha256: sha256(handoffBytes),
    outputRoot: path.join(sharedParent, "output"), sourceRepositorySha: input.sourceRepositorySha,
    producerSha: input.producerSha, operationId: input.operationId,
  }), { name: "CurrentSourceSetMaterializationError", code: "OUTPUT_INVALID" });
  const lockedRoot = path.join(temporary, "locked-output");
  await mkdir(path.join(temporary, ".locked-output.current-source-set-lock"), { mode: 0o700 });
  await assert.rejects(materializeCurrentSourceSet({
    handoffPath, expectedHandoffSha256: sha256(handoffBytes), outputRoot: lockedRoot,
    sourceRepositorySha: input.sourceRepositorySha, producerSha: input.producerSha,
    operationId: input.operationId,
  }), { name: "CurrentSourceSetMaterializationError", code: "OUTPUT_BUSY" });
  const existingDirectory = path.join(temporary, "existing-directory");
  await mkdir(existingDirectory);
  await assert.rejects(materializeCurrentSourceSet({
    handoffPath, expectedHandoffSha256: sha256(handoffBytes), outputRoot: existingDirectory,
    sourceRepositorySha: input.sourceRepositorySha, producerSha: input.producerSha,
    operationId: input.operationId,
  }), { name: "CurrentSourceSetMaterializationError", code: "OUTPUT_EXISTS" });
  const existingRoot = path.join(temporary, "existing-output");
  await writeFile(existingRoot, "preserve");
  await assert.rejects(materializeCurrentSourceSet({
    handoffPath, expectedHandoffSha256: sha256(handoffBytes), outputRoot: existingRoot,
    sourceRepositorySha: input.sourceRepositorySha, producerSha: input.producerSha, operationId: input.operationId,
  }), { name: "CurrentSourceSetMaterializationError", code: "OUTPUT_EXISTS" });
  assert.equal((await readFile(existingRoot, "utf8")), "preserve");
});
