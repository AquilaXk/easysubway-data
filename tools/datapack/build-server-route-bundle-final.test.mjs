import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildServerRouteBundleFinalEvidence,
} from "./build-server-route-bundle-final.mjs";
import {
  canonicalJson,
  sha256,
} from "./lib/manifest-validation.mjs";
import {
  validateServerRouteBundleFinal,
} from "./lib/server-route-bundle-final.mjs";
import {
  canonicalRideEdgeSetSha256,
  routeEdgeSha256,
} from "./evaluate-route-accessibility-edges.mjs";

const FRESH_AT = "2026-08-07T00:00:00.000Z";
const STALE_AT = "2026-08-10T00:00:00.000Z";
const BUNDLE_ID = "capital-route-bundle-1";
const STATION_SET_SHA256 = "1".repeat(64);
const SCRIPT = path.resolve("tools/datapack/build-server-route-bundle-final.mjs");

test("keyless bytes와 current #8/#9 evidence를 deterministic NO_GO FINAL로 결속한다", async (t) => {
  const fixture = await createFixture(t);
  const beforeStation = structuredClone(fixture.stationLineInput);
  const beforeRoute = structuredClone(fixture.routeEdgeInput);
  const firstOutput = path.join(fixture.temp, "evidence-one");
  const secondOutput = path.join(fixture.temp, "evidence-two");

  await build(fixture, firstOutput, FRESH_AT);
  await build(fixture, secondOutput, FRESH_AT);

  assert.deepEqual(fixture.stationLineInput, beforeStation);
  assert.deepEqual(fixture.routeEdgeInput, beforeRoute);
  assert.deepEqual((await readdir(firstOutput)).sort(bytewise), [
    "artifact-inventory.json",
    "route-edge-evaluation.json",
    "server-route-bundle-final.json",
    "source-freshness.json",
    "station-line-accessibility.json",
  ]);
  for (const name of (await readdir(firstOutput)).sort(bytewise)) {
    assert.deepEqual(await readFile(path.join(firstOutput, name)), await readFile(path.join(secondOutput, name)), name);
  }

  const final = await readJson(path.join(firstOutput, "server-route-bundle-final.json"));
  assert.deepEqual(final.gates, {
    artifactInventory: { state: "PASS", evidenceSha256: await fileSha(path.join(firstOutput, "artifact-inventory.json")) },
    publication: { state: "UNAVAILABLE", evidenceSha256: null },
    rebuildParityPromotion: { state: "UNAVAILABLE", evidenceSha256: null },
    routeEdgeEvaluation: { state: "PASS", evidenceSha256: await fileSha(path.join(firstOutput, "route-edge-evaluation.json")) },
    signature: { state: "UNAVAILABLE", evidenceSha256: null },
    sourceFreshness: { state: "PASS", evidenceSha256: await fileSha(path.join(firstOutput, "source-freshness.json")) },
    stationLineAccessibility: { state: "PASS", evidenceSha256: await fileSha(path.join(firstOutput, "station-line-accessibility.json")) },
  });
  assert.equal(final.result, "NO_GO");
  assert.deepEqual(final.blockers, [
    "publication:UNAVAILABLE",
    "rebuildParityPromotion:UNAVAILABLE",
    "signature:UNAVAILABLE",
  ]);
  assert.equal(final.candidate.repository, "AquilaXk/easysubway-data");
  assert.equal(final.candidate.gitSha, fixture.repositoryGitSha);
  assert.equal(final.candidate.bundleId, BUNDLE_ID);
  assert.equal(final.candidate.sourceSnapshotSetHash, fixture.buildSpec.sourceSnapshotSetHash);
  assert.equal(final.candidate.payloadRootSha256, final.candidate.componentInventorySha256);
  assert.equal(final.candidate.signedManifestRawSha256, null);
  assert.equal(final.candidate.componentDigests.topology, fixture.manifest.topologySha256);
  assert.doesNotThrow(() => validateServerRouteBundleFinal(final));

  const inventory = await readJson(path.join(firstOutput, "artifact-inventory.json"));
  assert.deepEqual(inventory.entries.map(({ path: entryPath }) => entryPath), [
    "payload/accessibility.sqlite.zst",
    "payload/fare.sqlite.zst",
    "payload/timetable.sqlite.zst",
    "payload/topology.sqlite.zst",
  ]);
  assert.equal(inventory.componentInventorySha256, fixture.manifest.payloadSha256);
});

test("stale source와 unresolved #8/#9 denominator를 NO_GO gate로 보존한다", async (t) => {
  const stale = await createFixture(t);
  const staleOutput = path.join(stale.temp, "stale");
  await build(stale, staleOutput, STALE_AT);
  const staleFinal = await readJson(path.join(staleOutput, "server-route-bundle-final.json"));
  assert.equal(staleFinal.gates.sourceFreshness.state, "STALE");
  assert.ok(staleFinal.blockers.includes("sourceFreshness:STALE"));

  const incomplete = await createFixture(t);
  incomplete.stationLineInput.evidenceRows = incomplete.stationLineInput.evidenceRows.filter((row) => !(
    row.stationId === "station-a" && row.domain === "FACILITY"
  ));
  const incompleteOutput = path.join(incomplete.temp, "incomplete");
  await build(incomplete, incompleteOutput, FRESH_AT);
  const incompleteFinal = await readJson(path.join(incompleteOutput, "server-route-bundle-final.json"));
  assert.equal(incompleteFinal.gates.stationLineAccessibility.state, "MISSING");
  assert.equal(incompleteFinal.gates.routeEdgeEvaluation.state, "MISSING");
  assert.ok(incompleteFinal.blockers.includes("stationLineAccessibility:MISSING"));
  assert.ok(incompleteFinal.blockers.includes("routeEdgeEvaluation:MISSING"));
  const materialization = await readJson(path.join(incompleteOutput, "station-line-accessibility.json"));
  const evaluation = await readJson(path.join(incompleteOutput, "route-edge-evaluation.json"));
  assert.equal(materialization.stateSummary.MISSING, 1);
  assert.equal(evaluation.denominator.edgeCount, incomplete.routeEdgeInput.routeEdges.length);
  assert.equal(evaluation.stateSummary.MISSING, 1);
});

test("artifact와 candidate identity mismatch는 output 전에 fail closed한다", async (t) => {
  for (const [name, mutate, pattern] of [
    ["component-digest", async (fixture) => {
      const manifest = await readJson(path.join(fixture.artifactRoot, "manifest.signing-input.json"));
      manifest.topologySha256 = "f".repeat(64);
      await writeCanonical(path.join(fixture.artifactRoot, "manifest.signing-input.json"), manifest);
    }, /topology payload digest mismatch/],
    ["station-identity", async (fixture) => {
      fixture.stationLineInput.candidate.stationSetSha256 = "f".repeat(64);
    }, /station set identity mismatch/],
    ["source-identity", async (fixture) => {
      fixture.routeEdgeInput.candidate.sourceSetSha256 = "f".repeat(64);
    }, /source set identity mismatch/],
    ["topology-identity", async (fixture) => {
      fixture.routeEdgeInput.candidate.topologySha256 = "f".repeat(64);
    }, /topology identity mismatch/],
    ["git-identity", async (fixture) => {
      fixture.repositoryGitSha = "f".repeat(40);
    }, /repositoryGitSha does not match repository HEAD/],
    ["bundle-identity", async (fixture) => {
      const provenancePath = path.join(fixture.artifactRoot, "provenance.json");
      const provenance = await readJson(provenancePath);
      provenance.bundleId = "other-bundle";
      await writeCanonical(provenancePath, provenance);
    }, /bundle identity mismatch/],
    ["release-identity", async (fixture) => {
      const compatibilityPath = path.join(fixture.artifactRoot, "compatibility.json");
      const compatibility = await readJson(compatibilityPath);
      compatibility.releaseSequence = 2;
      await writeCanonical(compatibilityPath, compatibility);
    }, /release sequence identity mismatch/],
    ["time-identity", async (fixture) => {
      const provenancePath = path.join(fixture.artifactRoot, "provenance.json");
      const provenance = await readJson(provenancePath);
      provenance.freshUntil = "2026-08-08T07:00:00.000+09:00";
      await writeCanonical(provenancePath, provenance);
    }, /freshUntil identity mismatch/],
    ["missing-file", async (fixture) => {
      await rm(path.join(fixture.artifactRoot, "payload/fare.sqlite.zst"));
    }, /artifact payload file set mismatch/],
    ["extra-file", async (fixture) => {
      await writeFile(path.join(fixture.artifactRoot, "payload/extra.sqlite.zst"), "extra");
    }, /artifact payload file set mismatch/],
    ["empty-file", async (fixture) => {
      await writeFile(path.join(fixture.artifactRoot, "payload/fare.sqlite.zst"), Buffer.alloc(0));
    }, /artifact file must be non-empty/],
    ["symlink-file", async (fixture) => {
      const target = path.join(fixture.temp, "topology-target");
      const source = path.join(fixture.artifactRoot, "payload/topology.sqlite.zst");
      await rename(source, target);
      await symlink(target, source);
    }, /artifact file must be a regular non-symlink/],
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture(t);
      const output = path.join(fixture.temp, `rejected-${name}`);
      await mutate(fixture);
      await assert.rejects(() => build(fixture, output, FRESH_AT), pattern);
      await assert.rejects(() => readFile(output), /ENOENT/);
      assert.deepEqual((await readdir(fixture.temp)).filter((entry) => entry.startsWith(".server-route-final-")), []);
    });
  }
});

test("occupied output을 교체하지 않고 기존 bytes를 보존한다", async (t) => {
  const fixture = await createFixture(t);
  const output = path.join(fixture.temp, "occupied");
  await writeFile(output, "owner bytes");
  await assert.rejects(() => build(fixture, output, FRESH_AT), /output must not already exist/);
  assert.equal(await readFile(output, "utf8"), "owner bytes");
  const ownerTarget = path.join(fixture.temp, "owner-target");
  const symlinkOutput = path.join(fixture.temp, "occupied-symlink");
  await writeFile(ownerTarget, "owner symlink bytes");
  await symlink(ownerTarget, symlinkOutput);
  await assert.rejects(() => build(fixture, symlinkOutput, FRESH_AT), /output must not already exist/);
  assert.equal(await readFile(ownerTarget, "utf8"), "owner symlink bytes");
  assert.deepEqual((await readdir(fixture.temp)).filter((entry) => entry.startsWith(".server-route-final-")), []);
});

test("standalone CLI도 exact inputs로 같은 FINAL을 생성한다", async (t) => {
  const fixture = await createFixture(t);
  const stationLineInputPath = path.join(fixture.temp, "station-line-input.json");
  const routeEdgeInputPath = path.join(fixture.temp, "route-edge-input.json");
  const output = path.join(fixture.temp, "cli-output");
  await writeFile(stationLineInputPath, canonicalJson(fixture.stationLineInput));
  await writeFile(routeEdgeInputPath, canonicalJson(fixture.routeEdgeInput));

  const result = spawnSync(process.execPath, [
    SCRIPT,
    "--artifact-root", fixture.artifactRoot,
    "--station-line-input", stationLineInputPath,
    "--route-edge-input", routeEdgeInputPath,
    "--repository-git-sha", fixture.repositoryGitSha,
    "--evaluation-at", FRESH_AT,
    "--output", output,
  ], { cwd: fixture.repositoryRoot, encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^NO_GO [a-f0-9]{64}\n$/);
  const final = JSON.parse(await readFile(path.join(output, "server-route-bundle-final.json"), "utf8"));
  assert.doesNotThrow(() => validateServerRouteBundleFinal(final));

  await writeFile(stationLineInputPath, JSON.stringify(fixture.stationLineInput, null, 2));
  const rejectedOutput = path.join(fixture.temp, "noncanonical-cli-output");
  const rejected = spawnSync(process.execPath, [
    SCRIPT,
    "--artifact-root", fixture.artifactRoot,
    "--station-line-input", stationLineInputPath,
    "--route-edge-input", routeEdgeInputPath,
    "--repository-git-sha", fixture.repositoryGitSha,
    "--evaluation-at", FRESH_AT,
    "--output", rejectedOutput,
  ], { cwd: fixture.repositoryRoot, encoding: "utf8" });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /station-line input must be canonical JSON/);
  await assert.rejects(() => readFile(rejectedOutput), /ENOENT/);
});

async function createFixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "server-route-final-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const repositoryRoot = path.join(temp, "repository");
  await copyRepositoryInputs(repositoryRoot);
  const policyPath = path.join(repositoryRoot, "release/product-gates/route-edge-evaluation-policy.json");
  const policy = await readJson(policyPath);
  policy.rideInvariant.itxCheongchunExpress.admittedEdgeSetSha256 = canonicalRideEdgeSetSha256([]);
  await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
  const repositoryGitSha = initializeRepository(repositoryRoot);

  const buildSpec = await readJson(path.join(repositoryRoot, "tools/datapack/release/candidate-build-spec.json"));
  const artifactRoot = path.join(temp, "server-route-bundle");
  const { manifest } = await createArtifact(repositoryRoot, artifactRoot, buildSpec);
  const stationLineInput = completeStationLineInput(buildSpec.sourceSnapshotSetHash);
  const routeEdgeInput = completeRouteEdgeInput(buildSpec.sourceSnapshotSetHash, manifest.topologySha256);
  return { temp, repositoryRoot, repositoryGitSha, artifactRoot, buildSpec, manifest, stationLineInput, routeEdgeInput };
}

async function copyRepositoryInputs(repositoryRoot) {
  for (const relative of [
    "contracts/datapack/artifact-component-table-layout.json",
    "contracts/datapack/server-route-bundle-build-contract.json",
    "release/product-gates/datapack-freshness-sla.json",
    "release/product-gates/route-edge-evaluation-policy.json",
    "tools/datapack/release/candidate-build-spec.json",
    "tools/datapack/release/source-snapshots.json",
    "tools/datapack/schema/catalog-schema.sql",
    "tools/datapack/source-governance-policy.json",
    "tools/datapack/source-inventory.json",
  ]) {
    await mkdir(path.dirname(path.join(repositoryRoot, relative)), { recursive: true });
    await cp(relative, path.join(repositoryRoot, relative));
  }
}

async function createArtifact(repositoryRoot, artifactRoot, buildSpec) {
  const payloads = {
    accessibility: Buffer.from("accessibility payload"),
    fare: Buffer.from("fare payload"),
    timetable: Buffer.from("timetable payload"),
    topology: Buffer.from("topology payload"),
  };
  await mkdir(path.join(artifactRoot, "payload"), { recursive: true });
  for (const [name, bytes] of Object.entries(payloads)) {
    await writeFile(path.join(artifactRoot, `payload/${name}.sqlite.zst`), bytes);
  }

  const buildSpecBytes = await readFile(path.join(repositoryRoot, "tools/datapack/release/candidate-build-spec.json"));
  const buildContract = await readJson(path.join(repositoryRoot, "contracts/datapack/server-route-bundle-build-contract.json"));
  const layout = await readJson(path.join(repositoryRoot, "contracts/datapack/artifact-component-table-layout.json"));
  const provenance = {
    schemaVersion: 1,
    artifactKind: "server-route-bundle-provenance",
    bundleId: BUNDLE_ID,
    releaseSequence: 1,
    stationSetSha256: STATION_SET_SHA256,
    serviceTimezone: "Asia/Seoul",
    activeFrom: "2026-08-07T09:00:00.000+09:00",
    freshUntil: "2026-08-08T08:00:00.000+09:00",
    builtAt: FRESH_AT,
    buildSpecSha256: sha256(buildSpecBytes),
    sourceSnapshotSetHash: buildSpec.sourceSnapshotSetHash,
    sourceInventorySha256: buildSpec.sourceInventorySha256,
    sourceSnapshotIds: [...new Set(buildSpec.sourceSnapshotIds)].sort(bytewise),
  };
  const compatibility = {
    schemaVersion: 1,
    artifactKind: "server-route-bundle-compatibility",
    bundleId: BUNDLE_ID,
    releaseSequence: 1,
    stationSetSha256: STATION_SET_SHA256,
    serviceTimezone: "Asia/Seoul",
    manifestVersion: 1,
    tableLayoutSchemaVersion: layout.schemaVersion,
    sourceSchemaPath: layout.serverRouteBundle.sourceSchema.path,
    sourceSqliteUserVersion: layout.serverRouteBundle.sourceSchema.sqliteUserVersion,
    sourceSchemaSha256: layout.serverRouteBundle.sourceSchema.sha256,
    schemaCompatibility: buildContract.manifestLifecycle.schemaCompatibility,
    compressionProfile: buildContract.compressionProfile,
    encoderRuntime: { node: process.versions.node, zstd: process.versions.zstd },
  };
  const provenanceBytes = Buffer.from(canonicalJson(provenance));
  const compatibilityBytes = Buffer.from(canonicalJson(compatibility));
  await writeFile(path.join(artifactRoot, "provenance.json"), provenanceBytes);
  await writeFile(path.join(artifactRoot, "compatibility.json"), compatibilityBytes);
  const entries = Object.entries(payloads).map(([name, bytes]) => ({
    path: `payload/${name}.sqlite.zst`, sizeBytes: bytes.length, sha256: sha256(bytes),
  })).sort((left, right) => bytewise(left.path, right.path));
  const manifest = {
    manifestVersion: 1,
    artifactKind: "server-route-bundle",
    bundleId: BUNDLE_ID,
    releaseSequence: 1,
    stationSetSha256: STATION_SET_SHA256,
    payloadSha256: sha256(Buffer.from(canonicalJson(entries))),
    topologySha256: sha256(payloads.topology),
    timetableSha256: sha256(payloads.timetable),
    accessibilitySha256: sha256(payloads.accessibility),
    fareSha256: sha256(payloads.fare),
    provenanceSha256: sha256(provenanceBytes),
    compatibilitySha256: sha256(compatibilityBytes),
    serviceTimezone: "Asia/Seoul",
    activeFrom: provenance.activeFrom,
    freshUntil: provenance.freshUntil,
    schemaCompatibility: buildContract.manifestLifecycle.schemaCompatibility,
    keyId: "production-v1",
  };
  await writeCanonical(path.join(artifactRoot, "manifest.signing-input.json"), manifest);
  return { manifest, provenance, compatibility };
}

function completeStationLineInput(sourceSetSha256) {
  const candidate = {
    candidateId: BUNDLE_ID,
    stationSetSha256: STATION_SET_SHA256,
    sourceSetSha256,
    mappingContractVersion: "station-line-v1",
    materializerVersion: "1",
  };
  const stationLines = [
    { stationId: "station-a", lineId: "line-1", operatorId: "operator-1" },
    { stationId: "station-b", lineId: "line-1", operatorId: "operator-1" },
  ];
  const evidenceRows = stationLines.flatMap((line) => [
    evidence(candidate, line, "FACILITY", "VERIFIED_PRESENT", "OBSERVED", "official facility"),
    evidence(candidate, line, "EXIT", "VERIFIED_ABSENT", "EXPLICIT_ZERO", "official zero exit"),
    evidence(candidate, line, "TRANSFER", "NOT_APPLICABLE", "CURRENT_APPLICABILITY_RULE", "no transfer boundary"),
  ]);
  return { candidate, stationLines, evidenceRows };
}

function evidence(candidate, line, domain, state, evidenceKind, evidenceReason) {
  return {
    ...candidate,
    ...line,
    domain,
    state,
    sourceId: "official-accessibility",
    sourceSnapshotId: "official-accessibility-20260806",
    evidenceRawSha256: "b".repeat(64),
    providerRecordHash: "c".repeat(64),
    capturedAt: "2026-08-06T00:00:00.000Z",
    freshUntil: "2026-08-12T00:00:00.000Z",
    provenanceId: "official-provider",
    licenseId: "public-data-license",
    evidenceKind,
    evidenceReason,
  };
}

function completeRouteEdgeInput(sourceSetSha256, topologySha256) {
  const candidate = {
    candidateId: BUNDLE_ID,
    stationSetSha256: STATION_SET_SHA256,
    sourceSetSha256,
    topologySha256,
    policyVersion: "route-edge-evaluation-v1",
    evaluatorVersion: "1",
  };
  const stationLines = [
    { stationId: "station-a", lineId: "line-1", operatorId: "operator-1", lineSequence: 1 },
    { stationId: "station-b", lineId: "line-1", operatorId: "operator-1", lineSequence: 2 },
  ];
  return {
    candidate,
    stationLines,
    routeEdges: [
      edge({ edgeId: "entry-a", edgeType: "ENTRY", fromNodeId: "station-a", toNodeId: "station-a:line-1" }),
      edge({ edgeId: "ride-a-b", edgeType: "RIDE", fromNodeId: "station-a:line-1", toNodeId: "station-b:line-1", durationSeconds: 120, distanceMeters: 1000, servicePattern: "LOCAL" }),
    ],
  };
}

function edge(value) {
  const raw = {
    edgeId: value.edgeId,
    edgeType: value.edgeType,
    fromNodeId: value.fromNodeId,
    toNodeId: value.toNodeId,
    durationSeconds: value.durationSeconds ?? 0,
    distanceMeters: value.distanceMeters ?? 0,
    servicePattern: value.servicePattern ?? "",
    serviceClass: value.serviceClass ?? "SUBWAY",
  };
  return { ...raw, edgeSha256: routeEdgeSha256(raw) };
}

async function build(fixture, output, evaluationAt) {
  return buildServerRouteBundleFinalEvidence({
    repositoryRoot: fixture.repositoryRoot,
    repositoryGitSha: fixture.repositoryGitSha,
    artifactRoot: fixture.artifactRoot,
    stationLineInput: fixture.stationLineInput,
    routeEdgeInput: fixture.routeEdgeInput,
    evaluationAt,
    output,
  });
}

async function writeCanonical(target, value) {
  await writeFile(target, Buffer.from(canonicalJson(value)));
}

async function readJson(target) {
  return JSON.parse(await readFile(target, "utf8"));
}

async function fileSha(target) {
  return sha256(await readFile(target));
}

function bytewise(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function initializeRepository(repositoryRoot) {
  const environment = {
    ...process.env,
    GIT_AUTHOR_DATE: "2026-08-07T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-08-07T00:00:00Z",
  };
  for (const args of [
    ["init", "--quiet"],
    ["add", "."],
    ["-c", "user.name=EasySubway Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"],
  ]) {
    const result = spawnSync("git", args, { cwd: repositoryRoot, env: environment, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
