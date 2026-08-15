import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { sha256 } from "./lib/manifest-validation.mjs";
import { stageCurrentServerRouteBundleCandidate } from "./stage-current-server-route-bundle-candidate.mjs";

const CANDIDATE = { candidateId: "capital-pilot-candidate-20260814", sourceSetSha256: "a".repeat(64) };
const SIGNED_PATHS = ["compatibility.json", "manifest.json", "manifest.signing-input.json", "payload/accessibility.sqlite.zst", "payload/fare.sqlite.zst", "payload/timetable.sqlite.zst", "payload/topology.sqlite.zst", "provenance.json"];

async function fixture(root) {
  const datapackRoot = path.join(root, "datapack");
  await mkdir(path.join(datapackRoot, "catalog"), { recursive: true });
  const sqlite = Buffer.from("candidate sqlite bytes");
  const compressed = gzipSync(sqlite);
  const buildSpec = { candidateId: CANDIDATE.candidateId, sourceSnapshotSetHash: CANDIDATE.sourceSetSha256, publishedAt: "2026-08-14T15:34:07.000Z", releaseSequence: 1 };
  const buildSpecBytes = Buffer.from(JSON.stringify(buildSpec));
  await writeFile(path.join(datapackRoot, "catalog", "capital-v1.sqlite.gz"), compressed);
  await Promise.all([
    writeFile(path.join(datapackRoot, "current.json"), JSON.stringify({ activePack: { id: "capital", version: "1" }, packs: [{ id: "capital", version: "1", artifactKind: "production", sizeBytes: compressed.length, sha256: sha256(compressed), sqliteSha256: sha256(sqlite) }] })),
    writeFile(path.join(datapackRoot, "current.provenance.json"), JSON.stringify({ candidateBuild: { ...CANDIDATE, sourceSnapshotSetHash: CANDIDATE.sourceSetSha256, buildSpecSha256: sha256(buildSpecBytes) } })),
    writeFile(path.join(root, "build.json"), buildSpecBytes),
    writeFile(path.join(root, "station.json"), JSON.stringify({ candidate: CANDIDATE })),
    writeFile(path.join(root, "route.json"), JSON.stringify({ candidate: CANDIDATE })),
  ]);
  return { datapackRoot, buildSpecPath: path.join(root, "build.json"), stationLineInputPath: path.join(root, "station.json"), routeEdgeInputPath: path.join(root, "route.json") };
}

test("current production capital을 재검증한 뒤 signed route bundle 여덟 파일만 atomic stage한다", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "route-candidate-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await fixture(root);
  const calls = [];
  let sourceSqliteBytes;
  const output = path.join(root, "candidate");
  await stageCurrentServerRouteBundleCandidate({ ...input, repositoryGitSha: "b".repeat(40), keyId: "production-v1", output, stages: { prepare: async (prepareInput) => {
    calls.push(prepareInput);
    sourceSqliteBytes = await readFile(prepareInput.emitterInputs.sourceSqlite);
    const signed = path.join(prepareInput.output, "signed-server-route-bundle");
    await mkdir(path.join(signed, "payload"), { recursive: true });
    await Promise.all(SIGNED_PATHS.map(async (relative) => writeFile(path.join(signed, relative), relative)));
  } } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].emitterInputs.mapPackId, "capital-map-1");
  assert.equal(calls[0].emitterInputs.catalogPackId, "capital-catalog-1");
  assert.equal(calls[0].emitterInputs.bundleId, "capital-route-bundle-1");
  assert.equal(calls[0].emitterInputs.releaseSequence, 1);
  assert.equal(calls[0].evaluationAt, "2026-08-14T15:34:07.000Z");
  assert.equal(calls[0].emitterInputs.activeFrom, "2026-08-15T00:34:07.000+09:00");
  assert.equal(calls[0].emitterInputs.freshUntil, "2026-08-16T00:34:07.000+09:00");
  assert.deepEqual(await inventory(path.join(output, "server-route-bundle")), SIGNED_PATHS);
  assert.deepEqual(await inventory(output), SIGNED_PATHS.map((relative) => `server-route-bundle/${relative}`));
  assert.equal(sourceSqliteBytes.toString(), "candidate sqlite bytes");
});

test("tamper·wrong identity·prepare failure·output collision은 output 없이 종료한다", async (t) => {
  for (const mutate of [
    async ({ datapackRoot }) => writeFile(path.join(datapackRoot, "catalog", "capital-v1.sqlite.gz"), "tampered"),
    async ({ buildSpecPath }) => writeFile(buildSpecPath, JSON.stringify({ candidateId: "wrong", sourceSnapshotSetHash: CANDIDATE.sourceSetSha256, publishedAt: "2026-08-14T15:34:07.000Z", releaseSequence: 1 })),
    async () => {},
  ]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "route-candidate-stage-failure-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const input = await fixture(root);
    await mutate(input);
    const output = path.join(root, "candidate");
    await assert.rejects(() => stageCurrentServerRouteBundleCandidate({ ...input, repositoryGitSha: "b".repeat(40), keyId: "production-v1", output, stages: { prepare: async () => { throw new Error("prepare failure"); } } }));
    await assert.rejects(() => lstat(output), /ENOENT/);
  }
});

test("wrong active pack·key와 existing output은 fail-closed이며 기존 output을 건드리지 않는다", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "route-candidate-stage-closed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await fixture(root);
  const output = path.join(root, "candidate");
  const manifest = JSON.parse(await readFile(path.join(input.datapackRoot, "current.json"), "utf8"));
  manifest.activePack.id = "other";
  await writeFile(path.join(input.datapackRoot, "current.json"), JSON.stringify(manifest));
  await assert.rejects(() => stageCurrentServerRouteBundleCandidate({ ...input, repositoryGitSha: "b".repeat(40), keyId: "production-v1", output }), /capital@1/);
  await assert.rejects(() => lstat(output), /ENOENT/);
  await writeFile(path.join(input.datapackRoot, "current.json"), JSON.stringify({ ...manifest, activePack: { id: "capital", version: "1" } }));
  await assert.rejects(() => stageCurrentServerRouteBundleCandidate({ ...input, repositoryGitSha: "b".repeat(40), keyId: "wrong", output }), /key id/);
  await assert.rejects(() => lstat(output), /ENOENT/);
  await mkdir(output);
  await writeFile(path.join(output, "sentinel"), "keep");
  await assert.rejects(() => stageCurrentServerRouteBundleCandidate({ ...input, repositoryGitSha: "b".repeat(40), keyId: "production-v1", output }), /output must be absent/);
  assert.equal(await readFile(path.join(output, "sentinel"), "utf8"), "keep");
});

test("prepare 중 생성된 foreign output과 conflicting source hashes는 fail-closed로 보존한다", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "route-candidate-stage-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await fixture(root);
  const output = path.join(root, "candidate");
  await assert.rejects(() => stageCurrentServerRouteBundleCandidate({ ...input, repositoryGitSha: "b".repeat(40), keyId: "production-v1", output, stages: { prepare: async () => {
    await mkdir(output);
    await writeFile(path.join(output, "sentinel"), "foreign");
    throw new Error("prepare failure after foreign output");
  } } }), /prepare failure/);
  assert.equal(await readFile(path.join(output, "sentinel"), "utf8"), "foreign");
  await rm(output, { recursive: true, force: true });
  const buildSpec = JSON.parse(await readFile(input.buildSpecPath, "utf8"));
  buildSpec.sourceSetSha256 = "b".repeat(64);
  await writeFile(input.buildSpecPath, JSON.stringify(buildSpec));
  await assert.rejects(() => stageCurrentServerRouteBundleCandidate({ ...input, repositoryGitSha: "b".repeat(40), keyId: "production-v1", output }), /candidate identity is invalid/);
  await assert.rejects(() => lstat(output), /ENOENT/);
});

async function inventory(root) {
  const entries = [];
  async function walk(directory, prefix = "") {
    for (const entry of await (await import("node:fs/promises")).readdir(directory, { withFileTypes: true })) {
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative);
      else entries.push(relative);
    }
  }
  await walk(root);
  return entries.sort();
}
