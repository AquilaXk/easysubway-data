import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";
import { buildServerRouteBundleFinal } from "./lib/server-route-bundle-final.mjs";
import {
  parseStageCurrentServerRouteBundleCandidateArgs,
  stageCurrentServerRouteBundleCandidate,
} from "./stage-current-server-route-bundle-candidate.mjs";

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
  freshUntil: "2026-08-15T12:47:35.000+09:00",
  keyId: "production-v1",
};
const NATIONWIDE_BUNDLE_CANDIDATE = { ...BUNDLE_CANDIDATE, bundleId: "nationwide-route-bundle-1" };
const SIGNED_PATHS = ["compatibility.json", "manifest.json", "manifest.signing-input.json", "payload/accessibility.sqlite.zst", "payload/fare.sqlite.zst", "payload/timetable.sqlite.zst", "payload/topology.sqlite.zst", "provenance.json"];
const BOUND_SUPPORT = [
  ["artifact-inventory.json", "artifactInventory"],
  ["route-edge-evaluation.json", "routeEdgeEvaluation"],
  ["source-freshness.json", "sourceFreshness"],
  ["station-line-accessibility.json", "stationLineAccessibility"],
];

async function fixture(root) {
  const datapackRoot = path.join(root, "datapack");
  await mkdir(path.join(datapackRoot, "catalog"), { recursive: true });
  const sqlite = Buffer.from("candidate sqlite bytes");
  const compressed = gzipSync(sqlite);
  const buildSpec = { candidateId: CANDIDATE.candidateId, sourceSnapshotSetHash: CANDIDATE.sourceSetSha256, publishedAt: "2026-08-14T15:34:07.000Z", releaseSequence: 1 };
  const buildSpecBytes = Buffer.from(JSON.stringify(buildSpec));
  await writeFile(path.join(datapackRoot, "catalog", "capital-v1.sqlite.gz"), compressed);
  await Promise.all([
    writeFile(path.join(datapackRoot, "current.json"), JSON.stringify({ activePack: { id: "capital", version: "1" }, expiresAt: "2026-08-15T03:47:35.000Z", packs: [{ id: "capital", version: "1", artifactKind: "production", sizeBytes: compressed.length, sha256: sha256(compressed), sqliteSha256: sha256(sqlite) }] })),
    writeFile(path.join(datapackRoot, "current.provenance.json"), JSON.stringify({ candidateBuild: { ...CANDIDATE, sourceSnapshotSetHash: CANDIDATE.sourceSetSha256, buildSpecSha256: sha256(buildSpecBytes) } })),
    writeFile(path.join(root, "build.json"), buildSpecBytes),
    writeFile(path.join(root, "station.json"), JSON.stringify({
      candidate: CANDIDATE,
      evidenceRows: [
        { capturedAt: "2026-08-14T15:34:07.000Z", freshUntil: "2026-08-15T03:47:35.000Z" },
        { capturedAt: "2026-08-14T16:34:07.000Z", freshUntil: "2026-08-15T03:47:35.000Z" },
      ],
    })),
    writeFile(path.join(root, "route.json"), JSON.stringify({ candidate: CANDIDATE })),
  ]);
  return { datapackRoot, buildSpecPath: path.join(root, "build.json"), stationLineInputPath: path.join(root, "station.json"), routeEdgeInputPath: path.join(root, "route.json") };
}

async function assertPrepareRejectedBeforeCandidateOutputs({ input, output, error }) {
  let prepared = false;
  await assert.rejects(
    () => stageCurrentServerRouteBundleCandidate({
      ...input,
      repositoryGitSha: "b".repeat(40),
      keyId: "production-v1",
      output,
      stages: { prepare: async () => { prepared = true; } },
    }),
    error,
  );
  assert.equal(prepared, false);
  for (const name of ["server-route-bundle", "server-route-bundle-evidence", "server-route-bundle-inputs"]) {
    await assert.rejects(() => lstat(path.join(output, name)), /ENOENT/);
  }
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
  assert.equal(calls[0].evaluationAt, "2026-08-14T16:34:07.000Z");
  assert.equal(calls[0].emitterInputs.activeFrom, "2026-08-15T00:34:07.000+09:00");
  assert.equal(calls[0].emitterInputs.builtAt, "2026-08-14T15:34:07.000Z");
  assert.equal(calls[0].emitterInputs.freshUntil, "2026-08-15T12:47:35.000+09:00");
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

test("full-capital observation time에 stale인 frozen evidence는 prepare 전에 fail-closed 한다", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "route-candidate-stale-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await fixture(root);
  const output = path.join(root, "candidate");
  await mkdir(output);
  const stationLine = JSON.parse(await readFile(input.stationLineInputPath, "utf8"));
  stationLine.evidenceRows[0].freshUntil = "2026-08-14T16:34:07.000Z";
  await writeFile(input.stationLineInputPath, JSON.stringify(stationLine));
  await assertPrepareRejectedBeforeCandidateOutputs({
    input,
    output,
    error: /evidence is stale at full-capital observation time/,
  });
});

test("current manifest expiry와 같은 frozen observation time은 prepare 전에 fail-closed 한다", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "route-candidate-observation-window-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await fixture(root);
  const output = path.join(root, "candidate");
  await mkdir(output);
  const stationLine = JSON.parse(await readFile(input.stationLineInputPath, "utf8"));
  for (const evidence of stationLine.evidenceRows) {
    evidence.freshUntil = "2026-08-15T04:47:35.000Z";
  }
  stationLine.evidenceRows[1].capturedAt = "2026-08-15T03:47:35.000Z";
  await writeFile(input.stationLineInputPath, JSON.stringify(stationLine));
  await assertPrepareRejectedBeforeCandidateOutputs({
    input,
    output,
    error: /current manifest expiresAt must be after evidence observation time/,
  });
});

test("current manifest expiry가 build publishedAt과 같으면 prepare 전에 fail-closed 한다", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "route-candidate-expiry-window-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await fixture(root);
  const output = path.join(root, "candidate");
  await mkdir(output);
  const manifestPath = path.join(input.datapackRoot, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.expiresAt = "2026-08-14T15:34:07.000Z";
  await writeFile(manifestPath, JSON.stringify(manifest));
  let prepared = false;
  await assert.rejects(
    () => stageCurrentServerRouteBundleCandidate({
      ...input,
      repositoryGitSha: "b".repeat(40),
      keyId: "production-v1",
      output,
      stages: { prepare: async () => { prepared = true; } },
    }),
    /current manifest expiresAt must be after build spec publishedAt/,
  );
  assert.equal(prepared, false);
  await assert.rejects(() => lstat(path.join(output, "server-route-bundle")), /ENOENT/);
});

// prepare 결과가 거부되면 stage output을 하나도 만들지 않아야 한다.
async function assertPreparedRejectedWithoutOutput(t, prefix, prepare, pattern) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await fixture(root);
  const output = path.join(root, "candidate");
  await mkdir(output);
  await assert.rejects(
    () => stageCurrentServerRouteBundleCandidate({
      ...input, repositoryGitSha: "b".repeat(40), keyId: "production-v1", output, stages: { prepare },
    }),
    pattern,
  );
  for (const name of ["server-route-bundle", "server-route-bundle-evidence", "server-route-bundle-inputs"]) {
    await assert.rejects(() => lstat(path.join(output, name)), /ENOENT/);
  }
}

test("prepared FINAL candidate freshUntil이 verified current manifest expiry와 다르면 publish하지 않는다", async (t) => {
  await assertPreparedRejectedWithoutOutput(t, "route-candidate-prepared-expiry-",
    async ({ output: prepared }) => writePreparedOutputs(prepared, { ...BUNDLE_CANDIDATE, freshUntil: "2026-08-15T12:47:36.000+09:00" }),
    /prepared route evidence freshUntil mismatch/);
});

// #916 리뷰 F3: RC는 발행 전 FINAL이 발행 단계와 같은 조건(원천 신선도 PASS, 미가용 blocker 두 개만)일 때만 stage한다.
// 원천 신선도가 STALE이면 RC에서 실패해야 production-publish에서야 드러나는 경로 차이가 없다.
test("발행 전 FINAL의 원천 신선도가 PASS가 아니거나 발행 불가 blocker가 있으면 stage하지 않는다", async (t) => {
  await assertPreparedRejectedWithoutOutput(t, "route-candidate-stale-freshness-",
    async ({ output: prepared }) => writePreparedOutputs(prepared, BUNDLE_CANDIDATE, { sourceFreshness: "STALE" }),
    /prepared FINAL is not release eligible: sourceFreshness:STALE/);
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
        assert.equal(
          prepareInput.emitterInputs.buildSpec,
          "tools/datapack/release/candidate-build-spec.json",
        );
        assert.deepEqual(
          prepareInput.emitterInputs.buildSpecSnapshotBytes,
          originals.get("build-spec.json"),
        );
        assert.notEqual(prepareInput.stationLineInputPath, input.stationLineInputPath);
        assert.notEqual(prepareInput.routeEdgeInputPath, input.routeEdgeInputPath);
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
    { label: "bound support missing", mutate: async (prepared) => rm(path.join(prepared, "bound", "source-freshness.json")) },
    { label: "bound support drift", mutate: async (prepared) => writeFile(path.join(prepared, "bound", "route-edge-evaluation.json"), "drift") },
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

test("nationwide candidate selects nationwide pack and sets nationwide bundle/map/catalog ids", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "route-candidate-nationwide-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await nationwideFixture(root);
  const output = path.join(root, "candidate");
  await mkdir(output);

  const calls = [];
  await stageCurrentServerRouteBundleCandidate({
    ...input,
    repositoryGitSha: "b".repeat(40),
    keyId: "production-v1",
    output,
    stages: {
      prepare: async (prepareInput) => {
        calls.push(prepareInput);
        await writePreparedOutputs(prepareInput.output, NATIONWIDE_BUNDLE_CANDIDATE);
      },
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].emitterInputs.mapPackId, "nationwide-map-1");
  assert.equal(calls[0].emitterInputs.catalogPackId, "nationwide-catalog-1");
  assert.equal(calls[0].emitterInputs.bundleId, "nationwide-route-bundle-1");
});

// #866 PR-B: 예전에는 입력 옆이나 저장소의 nationwide-*-input.json으로 조용히 바꿔 썼다(catch {}).
// 이제 preparation이 sha로 결속한 입력만 받고, 받은 bytes를 그대로 stage한다.
test("nationwide 후보는 preparation이 sha로 결속한 입력 bytes만 그대로 stage하고 옆 파일로 바꾸지 않는다", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "route-candidate-nationwide-bound-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await nationwideFixture(root);
  // 예전 대체 경로가 찾던 위치에 같은 후보 id의 다른 입력을 둔다.
  const decoy = { ...JSON.parse(await readFile(input.stationLineInputPath, "utf8")), decoy: true };
  await writeFile(path.join(root, "nationwide-station-line-input.json"), JSON.stringify(decoy));
  await writeFile(path.join(root, "nationwide-route-edge-input.json"), await readFile(input.routeEdgeInputPath));
  const output = path.join(root, "candidate");
  await mkdir(output);
  const staged = [];
  await stageCurrentServerRouteBundleCandidate({
    ...input,
    repositoryGitSha: "b".repeat(40),
    keyId: "production-v1",
    output,
    stages: {
      prepare: async (prepareInput) => {
        staged.push(await readFile(prepareInput.stationLineInputPath), await readFile(prepareInput.routeEdgeInputPath));
        await writePreparedOutputs(prepareInput.output, NATIONWIDE_BUNDLE_CANDIDATE);
      },
    },
  });
  assert.ok(staged[0].equals(await readFile(input.stationLineInputPath)));
  assert.ok(staged[1].equals(await readFile(input.routeEdgeInputPath)));
  for (const [source, target] of [[input.stationLineInputPath, "station-line-input.json"], [input.routeEdgeInputPath, "route-edge-input.json"]]) {
    assert.ok((await readFile(path.join(output, "server-route-bundle-inputs", target))).equals(await readFile(source)));
  }
});

test("nationwide 후보는 preparation과 다른 입력·후보 id·preparation 부재를 prepare 전에 거부한다", async (t) => {
  const cases = [
    ["다른 station-line 입력", async (input) => {
      const stationLine = JSON.parse(await readFile(input.stationLineInputPath, "utf8"));
      stationLine.stationLines = ["capital-only"];
      await writeFile(input.stationLineInputPath, JSON.stringify(stationLine));
    }, /station-line input sha256 mismatch/],
    ["다른 route-edge 입력", async (input) => {
      await writeFile(input.routeEdgeInputPath, `${await readFile(input.routeEdgeInputPath, "utf8")}\n`);
    }, /route-edge input sha256 mismatch/],
    ["preparation 후보 id 불일치", async (input) => {
      const preparation = JSON.parse(await readFile(input.candidatePreparationPath, "utf8"));
      preparation.releaseIdentity.candidateId = "nationwide-candidate-20260910";
      await writeFile(input.candidatePreparationPath, JSON.stringify(preparation));
    }, /candidate preparation identity mismatch/],
    ["preparation 부재", async (input) => {
      await rm(input.candidatePreparationPath);
    }, /ENOENT/],
    ["preparation 경로 미지정", async (input) => {
      delete input.candidatePreparationPath;
    }, /candidate preparation is required/],
  ];
  for (const [label, mutate, error] of cases) {
    const root = await mkdtemp(path.join(os.tmpdir(), "route-candidate-nationwide-reject-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const input = await nationwideFixture(root);
    await mutate(input);
    const output = path.join(root, "candidate");
    await mkdir(output);
    await assertPrepareRejectedBeforeCandidateOutputs({ input, output, error }).catch((cause) => {
      cause.message = `${label}: ${cause.message}`;
      throw cause;
    });
  }
});

test("stage CLI는 --candidate-preparation을 필수 인자로 받는다", () => {
  const argv = [
    "--datapack-root", "out", "--build-spec", "spec.json", "--station-line-input", "station.json",
    "--route-edge-input", "route.json", "--repository-git-sha", "b".repeat(40), "--key-id", "production-v1",
    "--output", "stage",
  ];
  assert.throws(() => parseStageCurrentServerRouteBundleCandidateArgs(argv), /CLI arguments mismatch/);
  assert.equal(parseStageCurrentServerRouteBundleCandidateArgs([
    ...argv, "--candidate-preparation", "tools/datapack/release/nationwide-candidate-preparation.json",
  ]).candidatePreparationPath, "tools/datapack/release/nationwide-candidate-preparation.json");
});

async function nationwideFixture(root) {
  const input = await fixture(root);
  const buildSpec = JSON.parse(await readFile(input.buildSpecPath, "utf8"));
  buildSpec.candidateId = "nationwide-candidate-20260909";
  buildSpec.productionScopeId = "nationwide_routing_android_v1";
  buildSpec.fixturePath = "tools/datapack/release/nationwide-production-canonical-pack.json";
  const buildSpecBytes = Buffer.from(JSON.stringify(buildSpec));
  await writeFile(input.buildSpecPath, buildSpecBytes);

  const manifest = JSON.parse(await readFile(path.join(input.datapackRoot, "current.json"), "utf8"));
  manifest.activePack = { id: "nationwide", version: "1" };
  manifest.packs[0].id = "nationwide";
  await writeFile(path.join(input.datapackRoot, "current.json"), JSON.stringify(manifest));
  await copyFile(
    path.join(input.datapackRoot, "catalog", "capital-v1.sqlite.gz"),
    path.join(input.datapackRoot, "catalog", "nationwide-v1.sqlite.gz"),
  );

  const provenance = JSON.parse(await readFile(path.join(input.datapackRoot, "current.provenance.json"), "utf8"));
  provenance.candidateBuild.candidateId = buildSpec.candidateId;
  provenance.candidateBuild.buildSpecSha256 = sha256(buildSpecBytes);
  await writeFile(path.join(input.datapackRoot, "current.provenance.json"), JSON.stringify(provenance));

  const stationLine = JSON.parse(await readFile(input.stationLineInputPath, "utf8"));
  stationLine.candidate.candidateId = buildSpec.candidateId;
  const stationLineBytes = Buffer.from(JSON.stringify(stationLine));
  await writeFile(input.stationLineInputPath, stationLineBytes);
  const routeEdge = JSON.parse(await readFile(input.routeEdgeInputPath, "utf8"));
  routeEdge.candidate.candidateId = buildSpec.candidateId;
  const routeEdgeBytes = Buffer.from(JSON.stringify(routeEdge));
  await writeFile(input.routeEdgeInputPath, routeEdgeBytes);

  const candidatePreparationPath = path.join(root, "nationwide-candidate-preparation.json");
  await writeFile(candidatePreparationPath, JSON.stringify({
    schemaVersion: 1,
    artifactKind: "nationwide-candidate-preparation",
    scopeId: buildSpec.productionScopeId,
    materialization: { fixturePath: buildSpec.fixturePath },
    releaseIdentity: {
      candidateId: buildSpec.candidateId,
      publishedAt: buildSpec.publishedAt,
      releaseSequence: buildSpec.releaseSequence,
    },
    builderIdentity: { gitSha: "a".repeat(40), version: "build-datapack.mjs@26" },
    authority: { candidateId: buildSpec.candidateId, scopeId: buildSpec.productionScopeId },
    routeEdgeInput: { path: "tools/datapack/release/nationwide-route-edge-input.json", sha256: sha256(routeEdgeBytes) },
    stationLineInput: { path: "tools/datapack/release/nationwide-station-line-input.json", sha256: sha256(stationLineBytes) },
  }));
  return { ...input, candidatePreparationPath };
}

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

async function writePreparedOutputs(prepared, candidate = BUNDLE_CANDIDATE, gateStates = {}) {
  const signed = path.join(prepared, "signed-server-route-bundle");
  await mkdir(path.join(signed, "payload"), { recursive: true });
  await Promise.all(SIGNED_PATHS.map(async (relative) => writeFile(path.join(signed, relative), relative)));
  const eligibilityPayload = {
    schemaVersion: 1,
    artifactKind: "route-accessibility-eligibility",
    candidate,
    decision: "ELIGIBLE",
    stationLineAccessibility: { rowCount: 1 },
    routeEdgeEvaluation: { edgeCount: 1 },
    blockers: [],
  };
  const eligibility = canonicalJson({ ...eligibilityPayload, eligibilitySha256: sha256(Buffer.from(canonicalJson(eligibilityPayload))) });
  await writeFile(path.join(prepared, "route-accessibility-eligibility.json"), eligibility);
  await mkdir(path.join(prepared, "bound"));
  const boundSupport = Object.fromEntries(BOUND_SUPPORT.map(([file, gate]) => [gate, canonicalJson({ artifactKind: gate })]));
  await Promise.all(BOUND_SUPPORT.map(([file, gate]) => writeFile(path.join(prepared, "bound", file), boundSupport[gate])));
  const gates = Object.fromEntries([
    ...BOUND_SUPPORT.map(([, gate]) => [gate, { state: gateStates[gate] ?? "PASS", evidenceSha256: sha256(Buffer.from(boundSupport[gate])) }]),
    ["signature", { state: "PASS", evidenceSha256: "4".repeat(64) }],
  ]);
  gates.routeAccessibilityEligibility = { state: "PASS", evidenceSha256: sha256(Buffer.from(eligibility)) };
  gates.publication = { state: "UNAVAILABLE", evidenceSha256: null };
  gates.promotionAuthorization = { state: "UNAVAILABLE", evidenceSha256: null };
  await writeFile(path.join(prepared, "bound", "server-route-bundle-final.json"), canonicalJson(
    buildServerRouteBundleFinal({ candidate, gates }),
  ));
}
