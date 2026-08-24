import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.resolve("tools/datapack/build-datapack-candidate-tuple.mjs");
const schema = JSON.parse(readFileSync("contracts/release/datapack-candidate-tuple.schema.json", "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("production raw manifest/provenance identity에서 Hub와 같은 exact candidate tuple을 결정론적으로 만든다", () => {
  const fixture = createFixture();
  try {
    const first = run(fixture);
    assert.equal(first.status, 0, first.stderr);
    const firstBytes = readFileSync(fixture.output);
    assert.deepEqual(JSON.parse(firstBytes), {
      candidateBinding: {
        candidateId: "current-candidate-1",
        buildSpecSha256: sha256(fixture.buildSpecBytes),
        manifestSha256: sha256(fixture.manifestBytes),
      },
      freshnessExpiresAt: "2026-08-25T00:00:00.000Z",
    });
    assert.deepEqual(Object.keys(schema.properties).sort(), ["candidateBinding", "freshnessExpiresAt"]);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(Object.keys(schema.properties.candidateBinding.properties).sort(), ["buildSpecSha256", "candidateId", "manifestSha256"]);
    assert.equal(schema.properties.candidateBinding.additionalProperties, false);
    assert.equal(schema.properties.freshnessExpiresAt.format, "date-time");
    assert.equal(schema.properties.freshnessExpiresAt.pattern, "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$");
    rmSync(fixture.output);
    const second = run(fixture);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(readFileSync(fixture.output), firstBytes);
  } finally {
    fixture.cleanup();
  }
});

test("identity drift, malformed·missing input, expired candidate는 tuple 없이 fail closed한다", () => {
  for (const [name, mutate] of [
    ["provenance build-spec drift", (fixture) => { fixture.provenance.candidateBuild.buildSpecSha256 = "f".repeat(64); }],
    ["provenance manifest drift", (fixture) => { fixture.provenance.manifestSha256 = "f".repeat(64); }],
    ["candidate drift", (fixture) => { fixture.provenance.candidateBuild.candidateId = "other"; }],
    ["builder git sha drift", (fixture) => { fixture.provenance.candidateBuild.builderGitSha = "b".repeat(40); }],
    ["expired", (fixture) => { fixture.manifest.expiresAt = "2026-08-23T00:00:00.000Z"; }],
    ["malformed manifest", (fixture) => { fixture.manifestBytes = Buffer.from("not-json\n"); }],
    ["missing candidate binding", (fixture) => { delete fixture.provenance.candidateBuild.candidateId; }],
    ["build snapshot extra field", (fixture) => { fixture.buildSpec.sourceSnapshots[0].extra = true; }],
    ["source identity extra field", (fixture) => { fixture.provenance.candidateBuild.sourceSnapshots[0].extra = true; }],
    ["build snapshot id number", (fixture) => { fixture.buildSpec.sourceSnapshotIds = [1]; }],
    ["build snapshot id embedded NUL", (fixture) => { fixture.buildSpec.sourceSnapshotIds = ["source-1\u0000other"]; }],
    ["provenance snapshot id number", (fixture) => { fixture.provenance.candidateBuild.sourceSnapshotIds = [1]; }],
    ["provenance snapshot id embedded NUL", (fixture) => { fixture.provenance.candidateBuild.sourceSnapshotIds = ["source-1\u0000other"]; }],
  ]) {
    const fixture = createFixture();
    try {
      mutate(fixture);
      if (name === "expired") {
        fixture.provenance.manifestSha256 = sha256(fixture.manifestBytes = Buffer.from(`${JSON.stringify(fixture.manifest)}\n`));
      }
      writeFileSync(fixture.buildSpecPath, `${JSON.stringify(fixture.buildSpec)}\n`);
      writeFileSync(fixture.manifestPath, fixture.manifestBytes);
      writeFileSync(fixture.provenancePath, `${JSON.stringify(fixture.provenance)}\n`);
      const result = run(fixture);
      assert.notEqual(result.status, 0, name);
      assert.equal(exists(fixture.output), false, name);
    } finally {
      fixture.cleanup();
    }
  }
});

test("symlink input과 occupied output은 기존 파일을 보존하고 partial tuple을 남기지 않는다", () => {
  const fixture = createFixture();
  try {
    const real = `${fixture.manifestPath}.real`;
    writeFileSync(real, fixture.manifestBytes);
    rmSync(fixture.manifestPath);
    symlinkSync(real, fixture.manifestPath);
    const symlink = run(fixture);
    assert.notEqual(symlink.status, 0, symlink.stderr);
    assert.equal(exists(fixture.output), false);
    rmSync(fixture.manifestPath);
    writeFileSync(fixture.manifestPath, fixture.manifestBytes);
    writeFileSync(fixture.output, "sentinel\n");
    const occupied = run(fixture);
    assert.notEqual(occupied.status, 0, occupied.stderr);
    assert.equal(readFileSync(fixture.output, "utf8"), "sentinel\n");
  } finally {
    fixture.cleanup();
  }
});

test("build spec은 trusted repo root에서 읽고 stage manifest/provenance/output은 stage 안에 유지한다", () => {
  const fixture = createFixture();
  try {
    const stage = path.join(fixture.root, "stage"); mkdirSync(stage);
    const manifest = path.join(stage, "current.json"), provenance = path.join(stage, "current.provenance.json"), output = path.join(stage, "datapack-candidate-tuple.json");
    renameSync(fixture.manifestPath, manifest); renameSync(fixture.provenancePath, provenance);
    const result = spawnSync(process.execPath, [script, "--root", stage, "--repo-root", fixture.root, "--build-spec", fixture.buildSpecPath, "--manifest", manifest, "--provenance", provenance, "--output", output, "--now", "2026-08-24T00:00:00.000Z"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); assert.ok(readFileSync(output).length > 0);
  } finally { fixture.cleanup(); }
});

function createFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "datapack-candidate-tuple-"));
  const buildSpecPath = path.join(root, "build-spec.json");
  const manifestPath = path.join(root, "current.json");
  const provenancePath = path.join(root, "current.provenance.json");
  const output = path.join(root, "datapack-candidate-tuple.json");
  const sourceSnapshots = [{ snapshotId: "source-1", sourceId: "official-1", rawSha256: "a".repeat(64), freshnessExpiresAt: "2026-08-25T00:00:00.000Z" }];
  const buildSpec = { schemaVersion: 1, artifactKind: "datapack-candidate-build-spec", candidateId: "current-candidate-1", builderGitSha: "a".repeat(40), sourceSnapshotIds: ["source-1"], sourceSnapshots };
  const buildSpecBytes = Buffer.from(`${JSON.stringify(buildSpec)}\n`);
  const manifest = { manifestVersion: 2, expiresAt: "2026-08-25T00:00:00.000Z" };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const provenance = { schemaVersion: 1, artifactKind: "datapack-field-provenance", manifestSha256: sha256(manifestBytes), candidateBuild: { candidateId: buildSpec.candidateId, builderGitSha: buildSpec.builderGitSha, buildSpecSha256: sha256(buildSpecBytes), sourceSnapshotIds: buildSpec.sourceSnapshotIds, sourceSnapshots } };
  writeFileSync(buildSpecPath, buildSpecBytes);
  writeFileSync(manifestPath, manifestBytes);
  writeFileSync(provenancePath, `${JSON.stringify(provenance)}\n`);
  return { root, buildSpecPath, manifestPath, provenancePath, output, buildSpec, buildSpecBytes, manifestBytes, manifest, provenance, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function run(fixture) {
  return spawnSync(process.execPath, [script, "--root", fixture.root, "--repo-root", fixture.root, "--build-spec", fixture.buildSpecPath, "--manifest", fixture.manifestPath, "--provenance", fixture.provenancePath, "--output", fixture.output, "--now", "2026-08-24T00:00:00.000Z"], { encoding: "utf8" });
}

function exists(file) { try { readFileSync(file); return true; } catch { return false; } }
