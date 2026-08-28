import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";
import { buildServerRouteBundleFinal } from "./lib/server-route-bundle-final.mjs";
import { stageCurrentServerRouteBundleCandidate } from "./stage-current-server-route-bundle-candidate.mjs";

const CANDIDATE = { candidateId: "capital-pilot-candidate-20260814", sourceSetSha256: "a".repeat(64) };
const BUNDLE_CANDIDATE = {
  repository: "AquilaXk/easysubway-data",
  gitSha: "b".repeat(40),
  bundleId: "capital-route-bundle-1",
  releaseSequence: 1,
  stationSetSha256: "c".repeat(64),
  sourceSnapshotSetHash: CANDIDATE.sourceSetSha256,
  signingInputSha256: "d".repeat(64),
  signedManifestRawSha256: "e".repeat(64),
  payloadRootSha256: "f".repeat(64),
  componentInventorySha256: "1".repeat(64),
  componentDigests: Object.fromEntries(["topology", "timetable", "accessibility", "fare"].map((name) => [name, "2".repeat(64)])),
  activeFrom: "2026-08-15T00:34:07.000+09:00",
  freshUntil: "2026-08-16T00:34:07.000+09:00",
  keyId: "production-v1",
};
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

test("current production capital을 재검증한 뒤 signed 8파일과 eligibility/FINAL을 atomic stage한다", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "route-candidate-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await fixture(root);
  const calls = [];
  let sourceSqliteBytes;
  let eligibilityBytes;
  const output = path.join(root, "candidate");
  await mkdir(output);
  await writeFile(path.join(output, "sentinel"), "keep");
  await stageCurrentServerRouteBundleCandidate({ ...input, repositoryGitSha: "b".repeat(40), keyId: "production-v1", output, stages: { prepare: async (prepareInput) => {
    calls.push(prepareInput);
    sourceSqliteBytes = await readFile(prepareInput.emitterInputs.sourceSqlite);
    const signed = path.join(prepareInput.output, "signed-server-route-bundle");
    await mkdir(path.join(signed, "payload"), { recursive: true });
    await writePreparedOutputs(prepareInput.output);
    eligibilityBytes = await readFile(path.join(prepareInput.output, "route-accessibility-eligibility.json"));
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
  assert.deepEqual(await inventory(path.join(output, "server-route-bundle-evidence")), [
    "server-route-bundle-evidence/route-accessibility-eligibility.json",
    "server-route-bundle-evidence/server-route-bundle-final.json",
  ].map((relative) => relative.replace("server-route-bundle-evidence/", "")).sort());
  assert.equal(await readFile(path.join(output, "sentinel"), "utf8"), "keep");
  for (const [source, staged] of [[input.buildSpecPath, "build-spec.json"], [input.stationLineInputPath, "station-line-input.json"], [input.routeEdgeInputPath, "route-edge-input.json"]]) {
    assert.deepEqual(await readFile(path.join(output, "server-route-bundle-inputs", staged)), await readFile(source));
  }
  assert.equal(await readFile(path.join(output, "server-route-bundle-evidence", "route-accessibility-eligibility.json"), "utf8"),
    eligibilityBytes.toString("utf8"));
  assert.equal(sourceSqliteBytes.toString(), "candidate sqlite bytes");
});

test("prepare 동안 원본 canonical input이 교체돼도 최초 검증 bytes만 stage한다", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "route-candidate-input-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await fixture(root);
  const originals = new Map(await Promise.all([
    [input.buildSpecPath, "build-spec.json"],
    [input.stationLineInputPath, "station-line-input.json"],
    [input.routeEdgeInputPath, "route-edge-input.json"],
  ].map(async ([source, staged]) => [staged, await readFile(source)])));
  const output = path.join(root, "candidate");
  await mkdir(output);
  await stageCurrentServerRouteBundleCandidate({
    ...input,
    repositoryGitSha: "b".repeat(40),
    keyId: "production-v1",
    output,
    stages: {
      prepare: async (prepareInput) => {
        assert.notEqual(prepareInput.emitterInputs.buildSpec, input.buildSpecPath);
        assert.notEqual(prepareInput.stationLineInputPath, input.stationLineInputPath);
        assert.notEqual(prepareInput.routeEdgeInputPath, input.routeEdgeInputPath);
        assert.deepEqual(await readFile(prepareInput.emitterInputs.buildSpec), originals.get("build-spec.json"));
        assert.deepEqual(await readFile(prepareInput.stationLineInputPath), originals.get("station-line-input.json"));
        assert.deepEqual(await readFile(prepareInput.routeEdgeInputPath), originals.get("route-edge-input.json"));
        await Promise.all([
          writeFile(input.buildSpecPath, JSON.stringify({ tampered: true })),
          writeFile(input.stationLineInputPath, JSON.stringify({ tampered: true })),
          writeFile(input.routeEdgeInputPath, JSON.stringify({ tampered: true })),
        ]);
        await writePreparedOutputs(prepareInput.output);
      },
    },
  });
  for (const [staged, bytes] of originals) {
    assert.deepEqual(await readFile(path.join(output, "server-route-bundle-inputs", staged)), bytes);
  }
});

test("evidence의 누락·symlink·비정준 JSON·identity drift·bound extra는 output 없이 종료한다", async (t) => {
  const mutations = [
    { label: "missing", mutate: async (prepared) => rm(path.join(prepared, "route-accessibility-eligibility.json")) },
    { label: "symlink", mutate: async (prepared) => {
      const target = path.join(prepared, "route-accessibility-eligibility.json");
      await writeFile(path.join(prepared, "eligibility-target.json"), await readFile(target));
      await rm(target);
      await symlink("eligibility-target.json", target);
    } },
    { label: "noncanonical", mutate: async (prepared) => {
      const target = path.join(prepared, "route-accessibility-eligibility.json");
      await writeFile(target, `${JSON.stringify(JSON.parse(await readFile(target, "utf8")), null, 2)}\n`);
    } },
    { label: "identity drift", mutate: async (prepared) => {
      const target = path.join(prepared, "bound", "server-route-bundle-final.json");
      const value = JSON.parse(await readFile(target, "utf8"));
      value.candidate = { ...value.candidate, sourceSnapshotSetHash: "3".repeat(64) };
      await writeFile(target, canonicalJson(value));
    } },
    { label: "bound extra", mutate: async (prepared) => writeFile(path.join(prepared, "bound", "unexpected.json"), "x") },
  ];
  for (const { label, mutate } of mutations) {
    const root = await mkdtemp(path.join(os.tmpdir(), "route-candidate-evidence-failure-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const input = await fixture(root);
    const output = path.join(root, "candidate");
    await mkdir(output);
    await assert.rejects(() => stageCurrentServerRouteBundleCandidate({ ...input, repositoryGitSha: "b".repeat(40), keyId: "production-v1", output, stages: { prepare: async (prepareInput) => {
      await writePreparedOutputs(prepareInput.output);
      await mutate(prepareInput.output);
    } } }));
    await assert.rejects(() => lstat(path.join(output, "server-route-bundle")), /ENOENT/);
    await assert.rejects(() => lstat(path.join(output, "server-route-bundle-evidence")), /ENOENT/);
  }
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
    await mkdir(output);
    await assert.rejects(() => stageCurrentServerRouteBundleCandidate({ ...input, repositoryGitSha: "b".repeat(40), keyId: "production-v1", output, stages: { prepare: async () => { throw new Error("prepare failure"); } } }));
    await assert.rejects(() => lstat(path.join(output, "server-route-bundle")), /ENOENT/);
    await assert.rejects(() => lstat(path.join(output, "server-route-bundle-evidence")), /ENOENT/);
  }
});

test("wrong active pack·key와 existing output은 fail-closed이며 기존 output을 건드리지 않는다", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "route-candidate-stage-closed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await fixture(root);
  const output = path.join(root, "candidate");
  await mkdir(output);
  const manifest = JSON.parse(await readFile(path.join(input.datapackRoot, "current.json"), "utf8"));
  manifest.activePack.id = "other";
  await writeFile(path.join(input.datapackRoot, "current.json"), JSON.stringify(manifest));
  await assert.rejects(() => stageCurrentServerRouteBundleCandidate({ ...input, repositoryGitSha: "b".repeat(40), keyId: "production-v1", output }), /capital@1/);
  await assert.rejects(() => lstat(path.join(output, "server-route-bundle")), /ENOENT/);
  await writeFile(path.join(input.datapackRoot, "current.json"), JSON.stringify({ ...manifest, activePack: { id: "capital", version: "1" } }));
  await assert.rejects(() => stageCurrentServerRouteBundleCandidate({ ...input, repositoryGitSha: "b".repeat(40), keyId: "wrong", output }), /key id/);
  await assert.rejects(() => lstat(path.join(output, "server-route-bundle")), /ENOENT/);
  await mkdir(path.join(output, "server-route-bundle"));
  await writeFile(path.join(output, "server-route-bundle", "sentinel"), "keep");
  await assert.rejects(() => stageCurrentServerRouteBundleCandidate({ ...input, repositoryGitSha: "b".repeat(40), keyId: "production-v1", output }), /output must be absent/);
  assert.equal(await readFile(path.join(output, "server-route-bundle", "sentinel"), "utf8"), "keep");
});

test("prepare 중 생성된 foreign output과 conflicting source hashes는 fail-closed로 보존한다", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "route-candidate-stage-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await fixture(root);
  const output = path.join(root, "candidate");
  await mkdir(output);
  await assert.rejects(() => stageCurrentServerRouteBundleCandidate({ ...input, repositoryGitSha: "b".repeat(40), keyId: "production-v1", output, stages: { prepare: async () => {
    await mkdir(path.join(output, "server-route-bundle"));
    await writeFile(path.join(output, "server-route-bundle", "sentinel"), "foreign");
    throw new Error("prepare failure after foreign output");
  } } }), /prepare failure/);
  assert.equal(await readFile(path.join(output, "server-route-bundle", "sentinel"), "utf8"), "foreign");
  await rm(path.join(output, "server-route-bundle"), { recursive: true, force: true });
  const buildSpec = JSON.parse(await readFile(input.buildSpecPath, "utf8"));
  buildSpec.sourceSetSha256 = "b".repeat(64);
  await writeFile(input.buildSpecPath, JSON.stringify(buildSpec));
  await assert.rejects(() => stageCurrentServerRouteBundleCandidate({ ...input, repositoryGitSha: "b".repeat(40), keyId: "production-v1", output }), /candidate identity is invalid/);
  await assert.rejects(() => lstat(path.join(output, "server-route-bundle")), /ENOENT/);
});

test("third publish rename failure rolls back the exact three candidate outputs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "route-candidate-stage-rename-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await fixture(root);
  const output = path.join(root, "candidate");
  await mkdir(output);
  let calls = 0;
  await assert.rejects(() => stageCurrentServerRouteBundleCandidate({
    ...input,
    repositoryGitSha: "b".repeat(40),
    keyId: "production-v1",
    output,
    stages: {
      prepare: async ({ output: prepared }) => writePreparedOutputs(prepared),
      rename: async (source, destination) => {
        calls += 1;
        await (await import("node:fs/promises")).rename(source, destination);
        if (calls === 3) throw new Error("injected third rename failure");
      },
    },
  }), /injected third rename failure/);
  assert.equal(calls, 3);
  for (const name of ["server-route-bundle", "server-route-bundle-evidence", "server-route-bundle-inputs"]) {
    await assert.rejects(() => lstat(path.join(output, name)), /ENOENT/);
  }
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

async function writePreparedOutputs(prepared) {
  const signed = path.join(prepared, "signed-server-route-bundle");
  await mkdir(path.join(signed, "payload"), { recursive: true });
  await Promise.all(SIGNED_PATHS.map(async (relative) => writeFile(path.join(signed, relative), relative)));
  const eligibilityPayload = {
    schemaVersion: 1,
    artifactKind: "route-accessibility-eligibility",
    candidate: BUNDLE_CANDIDATE,
    decision: "ELIGIBLE",
    stationLineAccessibility: { rowCount: 1 },
    routeEdgeEvaluation: { edgeCount: 1 },
    blockers: [],
  };
  const eligibility = canonicalJson({ ...eligibilityPayload, eligibilitySha256: sha256(Buffer.from(canonicalJson(eligibilityPayload))) });
  await writeFile(path.join(prepared, "route-accessibility-eligibility.json"), eligibility);
  await mkdir(path.join(prepared, "bound"));
  const evidenceSha256 = "4".repeat(64);
  const gates = Object.fromEntries([
    "sourceFreshness", "stationLineAccessibility", "routeEdgeEvaluation", "artifactInventory", "signature",
  ].map((name) => [name, { state: "PASS", evidenceSha256 }]));
  gates.routeAccessibilityEligibility = { state: "PASS", evidenceSha256: sha256(Buffer.from(eligibility)) };
  gates.publication = { state: "UNAVAILABLE", evidenceSha256: null };
  gates.rebuildParityPromotion = { state: "UNAVAILABLE", evidenceSha256: null };
  await writeFile(path.join(prepared, "bound", "server-route-bundle-final.json"), canonicalJson(
    buildServerRouteBundleFinal({ candidate: BUNDLE_CANDIDATE, gates }),
  ));
}
