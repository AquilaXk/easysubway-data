#!/usr/bin/env node
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  canonicalJson,
  sha256,
  validateArtifactComponentManifest,
} from "./lib/manifest-validation.mjs";
import {
  buildServerRouteBundleFinal,
  canonicalServerRouteBundleFinalJson,
} from "./lib/server-route-bundle-final.mjs";
import {
  canonicalStationLineAccessibilityJson,
  materializeStationLineAccessibility,
} from "./materialize-station-line-accessibility.mjs";
import {
  canonicalRouteEdgeEvaluationJson,
  evaluateRouteAccessibilityEdges,
} from "./evaluate-route-accessibility-edges.mjs";
import { parseArgs, requiredArg } from "./lib/cli-args.mjs";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";
import { validateSourceSnapshotFreshness } from "./validate-source-snapshot-freshness.mjs";

const ARTIFACT_ROOT_FILES = ["compatibility.json", "manifest.signing-input.json", "payload", "provenance.json"];
const COMPONENTS = ["accessibility", "fare", "timetable", "topology"];
const PAYLOAD_FILES = COMPONENTS.map((component) => `${component}.sqlite.zst`);
const OUTPUT_FILES = [
  "artifact-inventory.json",
  "route-edge-evaluation.json",
  "source-freshness.json",
  "station-line-accessibility.json",
];
const CLI_KEYS = [
  "artifact-root", "evaluation-at", "output", "repository-git-sha", "route-edge-input", "station-line-input",
];
const SIGNING_INPUT_KEYS = [
  "manifestVersion", "artifactKind", "bundleId", "releaseSequence", "stationSetSha256", "payloadSha256",
  "topologySha256", "timetableSha256", "accessibilitySha256", "fareSha256", "provenanceSha256",
  "compatibilitySha256", "serviceTimezone", "activeFrom", "freshUntil", "schemaCompatibility", "keyId",
];
const FIXED_INPUTS = {
  buildContract: "contracts/datapack/server-route-bundle-build-contract.json",
  buildSpec: "tools/datapack/release/candidate-build-spec.json",
  freshnessPolicy: "release/product-gates/datapack-freshness-sla.json",
  governancePolicy: "tools/datapack/source-governance-policy.json",
  routeEdgePolicy: "release/product-gates/route-edge-evaluation-policy.json",
  sourceInventory: "tools/datapack/source-inventory.json",
  sourceSchema: "tools/datapack/schema/catalog-schema.sql",
  sourceSnapshots: "tools/datapack/release/source-snapshots.json",
  tableLayout: "contracts/datapack/artifact-component-table-layout.json",
};
const execFileAsync = promisify(execFile);

export async function buildServerRouteBundleFinalEvidence(input) {
  const repositoryRoot = await realDirectory(input.repositoryRoot ?? process.cwd(), "repository root");
  const artifactRoot = await realDirectory(input.artifactRoot, "artifact root");
  const output = path.resolve(requiredRaw(input.output, "output"));
  await requireNewOutput(output);
  const outputParent = await realDirectory(path.dirname(output), "output parent");
  const evaluationAt = new Date(requiredUtcInstant(input.evaluationAt, "evaluationAt")).toISOString();
  const repositoryGitSha = await verifiedRepositoryGitSha(repositoryRoot, input.repositoryGitSha);

  const fixed = await readFixedInputs(repositoryRoot);
  const artifact = await inspectArtifact(artifactRoot, fixed);
  const sourceFreshness = evaluateSourceFreshness({ fixed, artifact, evaluationAt });
  const stationLineInput = validateStationLineInput(input.stationLineInput, artifact);
  const materialization = materializeStationLineAccessibility({
    ...stationLineInput,
    observedAt: evaluationAt,
  });
  const routeEdgeInput = validateRouteEdgeInput(input.routeEdgeInput, artifact);
  const evaluation = evaluateRouteAccessibilityEdges({
    ...routeEdgeInput,
    evaluationAt,
    materialization,
  }, fixed.routeEdgePolicy.value);

  const sourceFreshnessBytes = Buffer.from(canonicalJson(sourceFreshness.evidence));
  const artifactInventoryBytes = Buffer.from(canonicalJson(artifact.evidence));
  const materializationBytes = Buffer.from(canonicalStationLineAccessibilityJson(materialization));
  const evaluationBytes = Buffer.from(canonicalRouteEdgeEvaluationJson(evaluation));
  const final = buildServerRouteBundleFinal({
    candidate: {
      repository: "AquilaXk/easysubway-data",
      gitSha: repositoryGitSha,
      bundleId: artifact.manifest.bundleId,
      releaseSequence: artifact.manifest.releaseSequence,
      stationSetSha256: artifact.manifest.stationSetSha256,
      sourceSnapshotSetHash: artifact.provenance.sourceSnapshotSetHash,
      signingInputSha256: artifact.signingInputSha256,
      signedManifestRawSha256: null,
      payloadRootSha256: artifact.manifest.payloadSha256,
      componentInventorySha256: artifact.componentInventorySha256,
      componentDigests: Object.fromEntries(COMPONENTS.map((component) => [
        component,
        artifact.manifest[`${component}Sha256`],
      ])),
      activeFrom: artifact.manifest.activeFrom,
      freshUntil: artifact.manifest.freshUntil,
      keyId: artifact.manifest.keyId,
    },
    gates: {
      sourceFreshness: { state: sourceFreshness.state, evidenceSha256: sha256(sourceFreshnessBytes) },
      stationLineAccessibility: {
        state: stationLineGateState(materialization.stateSummary),
        evidenceSha256: sha256(materializationBytes),
      },
      routeEdgeEvaluation: {
        state: routeEdgeGateState(evaluation),
        evidenceSha256: sha256(evaluationBytes),
      },
      artifactInventory: { state: "PASS", evidenceSha256: sha256(artifactInventoryBytes) },
      signature: { state: "UNAVAILABLE", evidenceSha256: null },
      publication: { state: "UNAVAILABLE", evidenceSha256: null },
      rebuildParityPromotion: { state: "UNAVAILABLE", evidenceSha256: null },
    },
  });
  const finalBytes = Buffer.from(canonicalServerRouteBundleFinalJson(final));

  const temp = await mkdtemp(path.join(outputParent, ".server-route-final-"));
  try {
    for (const [name, bytes] of [
      ["artifact-inventory.json", artifactInventoryBytes],
      ["route-edge-evaluation.json", evaluationBytes],
      ["source-freshness.json", sourceFreshnessBytes],
      ["station-line-accessibility.json", materializationBytes],
    ]) {
      await writeFile(path.join(temp, name), bytes, { flag: "wx" });
    }
    await writeFile(path.join(temp, "server-route-bundle-final.json"), finalBytes, { flag: "wx" });
    await assertExactOutput(temp);
    await rename(temp, output);
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
  return final;
}

async function inspectArtifact(artifactRoot, fixed) {
  await assertDirectoryEntries(artifactRoot, ARTIFACT_ROOT_FILES, "artifact file set");
  const payloadRoot = await realDirectory(path.join(artifactRoot, "payload"), "artifact payload root");
  await assertDirectoryEntries(payloadRoot, PAYLOAD_FILES, "artifact payload file set");
  const [signingInputBytes, provenanceBytes, compatibilityBytes, ...payloadBytes] = await Promise.all([
    readNonEmptyRegular(path.join(artifactRoot, "manifest.signing-input.json"), "manifest signing input"),
    readNonEmptyRegular(path.join(artifactRoot, "provenance.json"), "provenance"),
    readNonEmptyRegular(path.join(artifactRoot, "compatibility.json"), "compatibility"),
    ...COMPONENTS.map((component) => readNonEmptyRegular(
      path.join(payloadRoot, `${component}.sqlite.zst`),
      `${component} artifact file`,
    )),
  ]);
  const manifest = parseCanonicalJson(signingInputBytes, "manifest signing input");
  assertKeys(manifest, SIGNING_INPUT_KEYS, "manifest signing input keys");
  validateArtifactComponentManifest({
    ...manifest,
    signature: { algorithm: "rsa-sha256-server-route-bundle-v1", value: "AA" },
  });
  const provenance = parseCanonicalJson(provenanceBytes, "provenance");
  const compatibility = parseCanonicalJson(compatibilityBytes, "compatibility");
  validateMetadata({ manifest, provenance, compatibility, fixed });

  const entries = COMPONENTS.map((component, index) => ({
    path: `payload/${component}.sqlite.zst`,
    sizeBytes: payloadBytes[index].length,
    sha256: sha256(payloadBytes[index]),
  })).sort((left, right) => bytewise(left.path, right.path));
  const componentInventorySha256 = sha256(Buffer.from(canonicalJson(entries)));
  if (manifest.payloadSha256 !== componentInventorySha256) throw new Error("payload inventory digest mismatch");
  for (const entry of entries) {
    const component = entry.path.slice("payload/".length, -".sqlite.zst".length);
    if (manifest[`${component}Sha256`] !== entry.sha256) {
      throw new Error(`${component} payload digest mismatch`);
    }
  }
  if (manifest.provenanceSha256 !== sha256(provenanceBytes)) throw new Error("provenance digest mismatch");
  if (manifest.compatibilitySha256 !== sha256(compatibilityBytes)) throw new Error("compatibility digest mismatch");

  const signingInputSha256 = sha256(signingInputBytes);
  return {
    manifest,
    provenance,
    compatibility,
    signingInputSha256,
    componentInventorySha256,
    evidence: canonicalObject({
      schemaVersion: 1,
      artifactKind: "server-route-bundle-artifact-inventory",
      bundleId: manifest.bundleId,
      releaseSequence: manifest.releaseSequence,
      stationSetSha256: manifest.stationSetSha256,
      signingInputSha256,
      provenanceSha256: sha256(provenanceBytes),
      compatibilitySha256: sha256(compatibilityBytes),
      componentInventorySha256,
      entries,
    }),
  };
}

function validateMetadata({ manifest, provenance, compatibility, fixed }) {
  const build = fixed.buildContract.value;
  const layout = fixed.tableLayout.value;
  assertKeys(provenance, build?.metadata?.provenance?.exactFields, "provenance keys");
  assertKeys(compatibility, build?.metadata?.compatibility?.exactFields, "compatibility keys");
  for (const value of [provenance, compatibility]) {
    if (value.bundleId !== manifest.bundleId) throw new Error("bundle identity mismatch");
    if (value.releaseSequence !== manifest.releaseSequence) throw new Error("release sequence identity mismatch");
    if (value.stationSetSha256 !== manifest.stationSetSha256) throw new Error("station set identity mismatch");
    if (value.serviceTimezone !== manifest.serviceTimezone) throw new Error("service timezone identity mismatch");
  }
  for (const field of ["activeFrom", "freshUntil"]) {
    if (provenance[field] !== manifest[field]) throw new Error(`${field} identity mismatch`);
  }
  if (provenance.schemaVersion !== 1 || provenance.artifactKind !== "server-route-bundle-provenance") {
    throw new Error("provenance contract mismatch");
  }
  if (provenance.builtAt !== new Date(requiredUtcInstant(provenance.builtAt, "provenance builtAt")).toISOString()) {
    throw new Error("provenance builtAt must be canonical UTC");
  }
  if (provenance.buildSpecSha256 !== fixed.buildSpec.sha256) throw new Error("build spec identity mismatch");
  if (provenance.sourceSnapshotSetHash !== fixed.buildSpec.value.sourceSnapshotSetHash) {
    throw new Error("source set identity mismatch");
  }
  if (provenance.sourceInventorySha256 !== fixed.buildSpec.value.sourceInventorySha256) {
    throw new Error("source inventory identity mismatch");
  }
  const expectedSnapshotIds = [...new Set(fixed.buildSpec.value.sourceSnapshotIds)].sort(bytewise);
  if (canonicalJson(provenance.sourceSnapshotIds) !== canonicalJson(expectedSnapshotIds)) {
    throw new Error("source snapshot identity mismatch");
  }
  if (compatibility.schemaVersion !== 1 || compatibility.artifactKind !== "server-route-bundle-compatibility"
    || compatibility.manifestVersion !== 1 || compatibility.tableLayoutSchemaVersion !== layout.schemaVersion) {
    throw new Error("compatibility contract mismatch");
  }
  const sourceSchema = layout?.serverRouteBundle?.sourceSchema;
  if (compatibility.sourceSchemaPath !== sourceSchema?.path
    || compatibility.sourceSqliteUserVersion !== sourceSchema?.sqliteUserVersion
    || compatibility.sourceSchemaSha256 !== sourceSchema?.sha256
    || fixed.sourceSchema.sha256 !== sourceSchema?.sha256) {
    throw new Error("source schema identity mismatch");
  }
  if (canonicalJson(compatibility.schemaCompatibility) !== canonicalJson(manifest.schemaCompatibility)
    || canonicalJson(compatibility.schemaCompatibility) !== canonicalJson(build.manifestLifecycle.schemaCompatibility)) {
    throw new Error("schema compatibility identity mismatch");
  }
  if (canonicalJson(compatibility.compressionProfile) !== canonicalJson(build.compressionProfile)) {
    throw new Error("compression profile identity mismatch");
  }
  assertKeys(compatibility.encoderRuntime, ["node", "zstd"], "encoder runtime keys");
  if (!/^24\./.test(requiredRaw(compatibility.encoderRuntime.node, "encoder runtime node"))) {
    throw new Error("encoder runtime Node 24 is required");
  }
  requiredRaw(compatibility.encoderRuntime.zstd, "encoder runtime zstd");
}

function evaluateSourceFreshness({ fixed, artifact, evaluationAt }) {
  const buildSpec = fixed.buildSpec.value;
  if (buildSpec.sourceSnapshotEvidencePath !== FIXED_INPUTS.sourceSnapshots) {
    throw new Error("source snapshot evidence path mismatch");
  }
  if (artifact.provenance.sourceSnapshotSetHash !== buildSpec.sourceSnapshotSetHash) {
    throw new Error("source set identity mismatch");
  }
  if (sha256(Buffer.from(JSON.stringify(fixed.sourceInventory.value))) !== buildSpec.sourceInventorySha256) {
    throw new Error("source inventory semantic digest mismatch");
  }
  let validation = null;
  let state = "PASS";
  let reason = "FRESH";
  try {
    validation = validateSourceSnapshotFreshness({
      buildSpec,
      snapshots: fixed.sourceSnapshots.value,
      policy: fixed.freshnessPolicy.value,
      evaluationAt,
      governancePolicy: fixed.governancePolicy.value,
      inventory: fixed.sourceInventory.value,
      governancePolicySha256: fixed.governancePolicy.sha256,
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "SOURCE_SNAPSHOT_EXPIRED") throw error;
    state = "STALE";
    reason = error.message;
  }
  if (Date.parse(artifact.manifest.freshUntil) <= Date.parse(evaluationAt)) {
    state = "STALE";
    reason = "BUNDLE_FRESH_UNTIL_EXPIRED";
  }
  return {
    state,
    evidence: canonicalObject({
      schemaVersion: 1,
      artifactKind: "server-route-bundle-source-freshness",
      bundleId: artifact.manifest.bundleId,
      sourceSnapshotSetHash: buildSpec.sourceSnapshotSetHash,
      evaluationAt,
      freshUntil: artifact.manifest.freshUntil,
      state,
      reason,
      inputs: Object.fromEntries([
        "buildSpec", "sourceSnapshots", "freshnessPolicy", "governancePolicy", "sourceInventory",
      ].map((name) => [name, fixed[name].sha256])),
      validation,
    }),
  };
}

function validateStationLineInput(value, artifact) {
  assertKeys(value, ["candidate", "stationLines", "evidenceRows"], "station-line input keys");
  assertCandidateBinding(value.candidate, artifact, false);
  if (!Array.isArray(value.stationLines) || !Array.isArray(value.evidenceRows)) {
    throw new Error("station-line arrays are required");
  }
  return value;
}

function validateRouteEdgeInput(value, artifact) {
  assertKeys(value, ["candidate", "stationLines", "routeEdges"], "route-edge input keys");
  assertCandidateBinding(value.candidate, artifact, true);
  if (!Array.isArray(value.stationLines) || !Array.isArray(value.routeEdges)) {
    throw new Error("route-edge arrays are required");
  }
  return value;
}

function assertCandidateBinding(candidate, artifact, requireTopology) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("candidate identity is required");
  }
  if (candidate.candidateId !== artifact.manifest.bundleId) throw new Error("candidate identity mismatch");
  if (candidate.stationSetSha256 !== artifact.manifest.stationSetSha256) throw new Error("station set identity mismatch");
  if (candidate.sourceSetSha256 !== artifact.provenance.sourceSnapshotSetHash) throw new Error("source set identity mismatch");
  if (requireTopology && candidate.topologySha256 !== artifact.manifest.topologySha256) {
    throw new Error("topology identity mismatch");
  }
}

function stationLineGateState(summary) {
  const unresolved = ["STALE", "MISSING", "UNKNOWN"].filter((state) => summary[state] > 0);
  if (unresolved.length === 0) return "PASS";
  return unresolved.length === 1 ? unresolved[0] : "PARTIAL";
}

function routeEdgeGateState(evaluation) {
  if (evaluation.eligible) return "PASS";
  const unresolved = ["STALE", "MISSING", "UNKNOWN", "NOT_EVALUATED"]
    .filter((state) => evaluation.stateSummary[state] > 0);
  return unresolved.length === 1 ? unresolved[0] : "PARTIAL";
}

async function readFixedInputs(repositoryRoot) {
  const entries = await Promise.all(Object.entries(FIXED_INPUTS).map(async ([name, relative]) => {
    const bytes = await readNonEmptyRegular(path.join(repositoryRoot, relative), `repository input ${name}`);
    const value = name === "sourceSchema" ? null : parseCanonicalOrFormattedJson(bytes, `repository input ${name}`);
    return [name, { bytes, value, sha256: sha256(bytes) }];
  }));
  return Object.fromEntries(entries);
}

function parseCanonicalOrFormattedJson(bytes, label) {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error(`${label} must be JSON`);
  }
}

function parseCanonicalJson(bytes, label) {
  const value = parseCanonicalOrFormattedJson(bytes, label);
  if (!Buffer.from(bytes).equals(Buffer.from(canonicalJson(value)))) {
    throw new Error(`${label} must be canonical JSON`);
  }
  return value;
}

async function readNonEmptyRegular(target, label) {
  let stat;
  try {
    stat = await lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${label} is missing`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink`);
  if (stat.size === 0) throw new Error(`${label} must be non-empty`);
  return readFile(target);
}

async function realDirectory(target, label) {
  const resolved = path.resolve(requiredRaw(target, label));
  let stat;
  try {
    stat = await lstat(resolved);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${label} is missing`);
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  return resolved;
}

async function assertDirectoryEntries(root, expected, label) {
  const actual = (await readdir(root)).sort(bytewise);
  if (canonicalJson(actual) !== canonicalJson([...expected].sort(bytewise))) {
    throw new Error(`${label} mismatch`);
  }
}

async function requireNewOutput(output) {
  try {
    await lstat(output);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("output must not already exist");
}

async function assertExactOutput(root) {
  await assertDirectoryEntries(root, [...OUTPUT_FILES, "server-route-bundle-final.json"], "FINAL output file set");
  for (const name of [...OUTPUT_FILES, "server-route-bundle-final.json"]) {
    await readNonEmptyRegular(path.join(root, name), `FINAL output ${name}`);
  }
}

function assertKeys(value, expected, label) {
  if (!Array.isArray(expected) || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} mismatch`);
  }
  const actual = Object.keys(value).sort(bytewise);
  if (canonicalJson(actual) !== canonicalJson([...expected].sort(bytewise))) throw new Error(`${label} mismatch`);
}

function requiredRaw(value, label) {
  if (typeof value !== "string" || value === "" || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty raw string`);
  }
  return value;
}

function requiredGitSha(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    throw new Error("repositoryGitSha must be a full lowercase Git SHA");
  }
  return value;
}

async function verifiedRepositoryGitSha(repositoryRoot, supplied) {
  const expected = requiredGitSha(supplied);
  let head;
  let status;
  try {
    ({ stdout: head } = await execFileAsync(
      "git",
      ["-C", repositoryRoot, "rev-parse", "--verify", "HEAD^{commit}"],
      { encoding: "utf8" },
    ));
    ({ stdout: status } = await execFileAsync(
      "git",
      ["-C", repositoryRoot, "status", "--porcelain=v1", "--untracked-files=no"],
      { encoding: "utf8" },
    ));
  } catch {
    throw new Error("repository root must be a readable Git worktree");
  }
  const actual = head.trim();
  if (actual !== expected) throw new Error("repositoryGitSha does not match repository HEAD");
  if (status !== "") throw new Error("repository tracked worktree must be clean");
  return actual;
}

function canonicalObject(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => canonicalObject(entry));
  return Object.fromEntries(Object.keys(value).sort(bytewise).map((key) => [key, canonicalObject(value[key])]));
}

function bytewise(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

async function main(argv) {
  const args = parseArgs(argv);
  assertKeys(Object.fromEntries(args), CLI_KEYS, "CLI arguments");
  const stationLinePath = path.resolve(requiredArg(args, "station-line-input"));
  const routeEdgePath = path.resolve(requiredArg(args, "route-edge-input"));
  const [stationLineBytes, routeEdgeBytes] = await Promise.all([
    readNonEmptyRegular(stationLinePath, "station-line input"),
    readNonEmptyRegular(routeEdgePath, "route-edge input"),
  ]);
  const final = await buildServerRouteBundleFinalEvidence({
    repositoryRoot: process.cwd(),
    repositoryGitSha: requiredArg(args, "repository-git-sha"),
    artifactRoot: requiredArg(args, "artifact-root"),
    stationLineInput: parseCanonicalJson(stationLineBytes, "station-line input"),
    routeEdgeInput: parseCanonicalJson(routeEdgeBytes, "route-edge input"),
    evaluationAt: requiredArg(args, "evaluation-at"),
    output: requiredArg(args, "output"),
  });
  process.stdout.write(`${final.result} ${final.finalSha256}\n`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`build-server-route-bundle-final: ${error.message}\n`);
    process.exitCode = 1;
  });
}
