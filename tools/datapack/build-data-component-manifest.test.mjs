import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalJson, sha256, withoutSignature } from "./lib/manifest-validation.mjs";

const script = path.resolve("tools/datapack/build-data-component-manifest.mjs");
const gitSha = "a".repeat(40);
const sourceSnapshotSetHash = "b".repeat(64);
const manifestHash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("candidate stage의 불변 data component manifest와 정렬된 artifact inventory를 발행한다", () => {
  const fixture = createFixture();
  try {
    const result = run(fixture);
    assert.equal(result.status, 0, result.stderr);

    const inventoryBytes = readFileSync(fixture.inventory);
    const manifestBytes = readFileSync(fixture.output);
    const inventory = JSON.parse(inventoryBytes);
    const manifest = JSON.parse(manifestBytes);
    assert.deepEqual(inventory, {
      schemaVersion: 1,
      artifactKind: "datapack-candidate-inventory",
      entries: [
        { path: "catalog/capital-v20260730.sqlite.gz", sizeBytes: 13, sha256: "bb41876d4fd94ba70ee2b40551f435217ba9889d109ee02bbc1ce867c674bbbf" },
        { path: "catalog/current.json", sizeBytes: fixture.currentBytes.length, sha256: manifestHash(fixture.currentBytes) },
        { path: "catalog/current.provenance.json", sizeBytes: fixture.provenanceBytes.length, sha256: manifestHash(fixture.provenanceBytes) },
        { path: "nested/payload.txt", sizeBytes: 18, sha256: "52429a1993d6c6cc051d5c4319e71bf40d2c54bafeffc25fb4b86b7568fd35c7" },
      ],
    });
    assert.deepEqual(manifest, {
      schemaVersion: 1,
      component: "data",
      repository: "AquilaXk/easysubway",
      gitSha,
      workflowRunId: "123456789",
      dataVersion: "20260730",
      releaseSequence: 7,
      manifestSha256: manifestHash(fixture.currentBytes),
      provenance: { sourceSnapshotSetHash },
      artifactInventorySha256: manifestHash(inventoryBytes),
      contractVersion: "datapack-contract-v3",
      issueRef: "AquilaXk/easysubway#2699",
    });
    assert.equal(manifest.artifactInventorySha256, "f17cdab0fb8d18b329dc12e21b9c4d612ab278b3dde374f2a20627620e7e50c0");
    assert.equal(manifestHash(manifestBytes), "92c42a0cafcf0c3972900085ef48f0d7e97fbbf1358bdf1f4acdc651f23fda9f");
  } finally {
    fixture.cleanup();
  }
});

test("production manifest validation이 닫는 current manifest shape를 fail closed한다", () => {
  for (const [name, mutate] of [
    ["legacy version", (manifest) => { delete manifest.manifestVersion; delete manifest.signature; }],
    ["invalid channel", (manifest) => { manifest.channel = "invalid channel"; resign(manifest); }],
    ["invalid signature", (manifest) => { manifest.signature.value = "0".repeat(64); }],
    ["unknown active pack", (manifest) => { manifest.activePack = { id: "other", version: "1" }; resign(manifest); }],
  ]) {
    const fixture = createFixture(mutate);
    try {
      const result = run(fixture);
      assert.notEqual(result.status, 0, name);
      assert.equal(exists(fixture.inventory), false, name);
      assert.equal(exists(fixture.output), false, name);
    } finally {
      fixture.cleanup();
    }
  }
});

test("manifest에 없는 staged sqlite gzip pack을 fail closed한다", () => {
  const fixture = createFixture();
  try {
    writeFileSync(path.join(fixture.root, "catalog", "rogue-v20260730.sqlite.gz"), "rogue gzip");
    const result = run(fixture);
    assert.notEqual(result.status, 0, result.stderr);
    assert.equal(exists(fixture.inventory), false);
    assert.equal(exists(fixture.output), false);
  } finally {
    fixture.cleanup();
  }
});

test("manifest가 선언한 staged sqlite gzip pack 누락을 fail closed한다", () => {
  const fixture = createFixture();
  try {
    rmSync(path.join(fixture.root, "catalog", "capital-v20260730.sqlite.gz"));
    const result = run(fixture);
    assert.notEqual(result.status, 0, result.stderr);
    assert.equal(exists(fixture.inventory), false);
    assert.equal(exists(fixture.output), false);
  } finally {
    fixture.cleanup();
  }
});

test("candidate stage symlink와 root 밖 metadata output을 fail closed한다", () => {
  const fixture = createFixture();
  const outside = mkdtempSync(path.join(os.tmpdir(), "data-component-manifest-outside-"));
  try {
    symlinkSync(path.join(outside, "target"), path.join(fixture.root, "unsafe-link"));
    const symlinkResult = run(fixture);
    assert.notEqual(symlinkResult.status, 0, symlinkResult.stderr);
    assert.equal(exists(fixture.inventory), false);
    assert.equal(exists(fixture.output), false);
    rmSync(path.join(fixture.root, "unsafe-link"));

    const outsideResult = run(fixture, { inventory: path.join(outside, "inventory.json") });
    assert.notEqual(outsideResult.status, 0, outsideResult.stderr);
    assert.equal(exists(path.join(outside, "inventory.json")), false);
    assert.equal(exists(fixture.output), false);
  } finally {
    fixture.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("한 metadata output 충돌은 선존재 파일을 보존하고 새 partial output을 남기지 않는다", () => {
  for (const existingName of ["inventory", "output"]) {
    const fixture = createFixture();
    const existingPath = fixture[existingName];
    const otherName = existingName === "inventory" ? "output" : "inventory";
    const sentinel = `${existingName} sentinel\n`;
    try {
      writeFileSync(existingPath, sentinel);
      const result = run(fixture);
      assert.notEqual(result.status, 0, `${existingName}: ${result.stderr}`);
      assert.equal(readFileSync(existingPath, "utf8"), sentinel, `${existingName} must be preserved`);
      assert.equal(exists(fixture[otherName]), false, `${otherName} must not be left as partial metadata`);
    } finally {
      fixture.cleanup();
    }
  }
});

test("destination write failure는 metadata partial과 root temp를 남기지 않는다", () => {
  const fixture = createFixture();
  try {
    writeFileSync(path.join(fixture.root, "large-payload.bin"), Buffer.alloc(4096, "x"));
    const result = runWithFileSizeLimit(fixture);
    assert.notEqual(result.status, 0, result.stderr);
    assert.equal(exists(fixture.inventory), false);
    assert.equal(exists(fixture.output), false);
    assert.deepEqual(readdirSync(fixture.root).sort(), ["catalog", "large-payload.bin", "nested"]);
  } finally {
    fixture.cleanup();
  }
});

function createFixture(mutate = undefined) {
  const root = mkdtempSync(path.join(os.tmpdir(), "data-component-manifest-"));
  const catalog = path.join(root, "catalog");
  mkdirSync(catalog);
  mkdirSync(path.join(root, "nested"));
  const current = currentManifest();
  mutate?.(current);
  const currentBytes = Buffer.from(`${JSON.stringify(current, null, 2)}\n`);
  const provenanceBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    artifactKind: "datapack-field-provenance",
    candidateBuild: { sourceSnapshotSetHash },
  }, null, 2)}\n`);
  const manifest = path.join(catalog, "current.json");
  const provenance = path.join(catalog, "current.provenance.json");
  writeFileSync(manifest, currentBytes);
  writeFileSync(provenance, provenanceBytes);
  writeFileSync(path.join(catalog, "capital-v20260730.sqlite.gz"), "declared gzip");
  writeFileSync(path.join(root, "nested", "payload.txt"), "candidate payload\n");
  return {
    root,
    manifest,
    provenance,
    currentBytes,
    provenanceBytes,
    inventory: path.join(root, "data-artifact-inventory.json"),
    output: path.join(root, "data-component-manifest.json"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function run(fixture, overrides = {}) {
  return spawnSync(process.execPath, commandArguments(fixture, overrides), { encoding: "utf8" });
}

function runWithFileSizeLimit(fixture) {
  return spawnSync("/bin/sh", [
    "-c", "ulimit -f 0; exec \"$@\"", "sh", process.execPath, ...commandArguments(fixture),
  ], { encoding: "utf8" });
}

function commandArguments(fixture, overrides = {}) {
  return [
    script,
    "--root", fixture.root,
    "--manifest", fixture.manifest,
    "--provenance", fixture.provenance,
    "--repository", "AquilaXk/easysubway",
    "--git-sha", gitSha,
    "--workflow-run-id", "123456789",
    "--contract-version", "datapack-contract-v3",
    "--issue-ref", "AquilaXk/easysubway#2699",
    "--inventory-output", overrides.inventory ?? fixture.inventory,
    "--output", overrides.output ?? fixture.output,
  ];
}

function currentManifest() {
  const manifest = {
    manifestVersion: 2,
    channel: "staging",
    releaseSequence: 7,
    publishedAt: "2026-07-30T00:00:00.000Z",
    expiresAt: "2026-08-01T00:00:00.000Z",
    keyId: "production-v1",
    ttlSeconds: 3600,
    activePack: { id: "capital", version: "20260730" },
    packs: [{
      id: "capital",
      version: "20260730",
      artifactKind: "fixture",
      url: "catalog/capital-v20260730.sqlite.gz",
      sha256: "c".repeat(64),
      sqliteSha256: "d".repeat(64),
      sizeBytes: 1,
      signature: { algorithm: "sha256-pack-manifest-v2", value: "e".repeat(64) },
      schemaVersion: "1",
      sourceInventory: [{
        id: "fixture-source", owner: "fixture", url: "https://example.com/source", license: "fixture-only",
        licenseStatus: "fixture-only", redistributionAllowed: false, updateFrequency: "manual",
        updatedAt: "2026-07-30T00:00:00.000Z", fields: ["stations"],
      }],
      regionalQualityMetrics: {
        stationCount: 1, edgeCount: 1, facilityCoverageRatio: 1, requiredFacilityEvidenceCoverageRatio: 1,
        strictRouteEligibleFacilityRatio: 1, operationalKnownRatio: 1, freshnessValidRatio: 1,
        fieldVerifiedPathwayRatio: 1, unknownAccessibilityRatio: 0,
        unknownEdgeRatioByProfile: { wheelchair: 0, stroller: 0, lowMobility: 0 },
      },
      representativeRouteRegressions: [],
      representativeRouteRegressionSignature: { algorithm: "sha256-route-regression-v1", value: "f".repeat(64) },
      requiredTables: ["stations"],
      minimumTableRows: { stations: 1 },
    }],
  };
  resign(manifest);
  return manifest;
}

function resign(manifest) {
  manifest.signature = {
    algorithm: "sha256-manifest-v2",
    value: sha256(Buffer.from(canonicalJson(withoutSignature(manifest)))),
  };
}

function exists(target) {
  try {
    readFileSync(target);
    return true;
  } catch {
    return false;
  }
}
