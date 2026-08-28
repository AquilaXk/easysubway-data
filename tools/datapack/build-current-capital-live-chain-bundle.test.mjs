import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCurrentCapitalLiveChainBundle, currentCapitalLiveChainOutputPaths, readCurrentCapitalLiveChainBundle } from "./build-current-capital-live-chain-bundle.mjs";
import { CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS, canonicalCurrentCapitalLiveChainFanInBoundaryJson } from "./build-current-capital-live-chain-boundary.mjs";
import { buildCurrentExitAdmissionOciReceipt, canonicalCurrentExitAdmissionOciReceiptJson } from "./build-current-exit-admission-oci-receipt.mjs";
import { canonicalRideEdgeSetSha256, canonicalRouteEdgeEvaluationJson, evaluateRouteAccessibilityEdges, routeEdgeSha256 } from "./evaluate-route-accessibility-edges.mjs";
import { materializeStationLineAccessibility } from "./materialize-station-line-accessibility.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");

test("composite bundle embeds canonical fan-in evidence without expanding the output allowlist", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "live-chain-bundle-"));
  const authorityPaths = ["tools/datapack/release/candidate-build-spec.json", "tools/datapack/source-inventory.json", "tools/datapack/release/source-snapshots.json"];
  const authorityBytes = new Map(await Promise.all(authorityPaths.map(async (relative) => [relative, await readFile(path.join(ROOT, relative))])));
  const outputPaths = currentCapitalLiveChainOutputPaths({
    candidate: JSON.parse(authorityBytes.get(authorityPaths[0])),
    sourceInventory: JSON.parse(authorityBytes.get(authorityPaths[1])),
    sourceSnapshotLedger: JSON.parse(authorityBytes.get(authorityPaths[2])),
  });
  const entryBytes = new Map();
  await populateEvaluationFixture(entryBytes);
  for (const [index, relative] of outputPaths.entries()) {
    const bytes = entryBytes.get(relative) ?? authorityBytes.get(relative) ?? Buffer.from(`{\"component\":${index}}`);
    entryBytes.set(relative, bytes);
    await mkdir(path.dirname(path.join(root, "out", relative)), { recursive: true });
    await writeFile(path.join(root, "out", relative), bytes);
  }
  const options = { root, outputDirectory: path.join(root, "out"), repository: "AquilaXk/easysubway-data", repositorySha: "b".repeat(40), operationId: "current-capital-560", boundaryBytes: boundaryFor(entryBytes) };
  const bytes = await buildCurrentCapitalLiveChainBundle(options);
  const readOptions = omit(options, "root", "outputDirectory", "boundaryBytes");
  const bundle = readCurrentCapitalLiveChainBundle(bytes, readOptions);
  assert.equal(bundle.entries.length, 17);
  assert.equal(bundle.entries.some((entry) => entry.path === "tools/datapack/release/current-capital-live-chain-fan-in.json"), false);
  assert.throws(() => readCurrentCapitalLiveChainBundle(bytes, { ...readOptions, repositorySha: "c".repeat(40) }), /identity mismatch/);

  const tamperedBoundary = JSON.parse(bytes);
  tamperedBoundary.boundaryBytesBase64 = Buffer.from("{}", "utf8").toString("base64");
  assert.throws(() => readCurrentCapitalLiveChainBundle(Buffer.from(JSON.stringify(tamperedBoundary)), readOptions), /boundary|keys mismatch/i);
  await assert.rejects(() => buildCurrentCapitalLiveChainBundle({ ...options, boundaryBytes: boundaryFor(entryBytes, { candidateBuildSpec: "0".repeat(64) }) }), /boundary.*output binding/i);
  const invalidPolicyEntries = new Map(entryBytes);
  invalidPolicyEntries.set("release/product-gates/route-edge-evaluation-policy.json", Buffer.from("{}"));
  await writeOutputEntries(path.join(root, "invalid-policy"), outputPaths, invalidPolicyEntries);
  await assert.rejects(() => buildCurrentCapitalLiveChainBundle({ ...options, outputDirectory: path.join(root, "invalid-policy") }), /identity|policy|keys/i);

  const swappedEvaluationEntries = new Map(entryBytes);
  swappedEvaluationEntries.set(
    "tools/datapack/release/current-capital-accessibility-full/route-edge-evaluation.json",
    entryBytes.get("release/product-gates/route-edge-evaluation-policy.json"),
  );
  await writeOutputEntries(path.join(root, "swapped-evaluation"), outputPaths, swappedEvaluationEntries);
  await assert.rejects(() => buildCurrentCapitalLiveChainBundle({ ...options, outputDirectory: path.join(root, "swapped-evaluation") }), /identity|observedAt|evaluation/i);

  for (const [label, mutate] of [
    ["candidate", (value) => { value.candidate.candidateId = "other-candidate"; }],
    ["source", (value) => { value.candidate.sourceSetSha256 = "f".repeat(64); }],
    ["station", (value) => { value.candidate.stationSetSha256 = "e".repeat(64); }],
  ]) {
    const driftedEntries = replaceEntryJson(entryBytes, "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json", mutate);
    const directory = path.join(root, `drifted-${label}`);
    await writeOutputEntries(directory, outputPaths, driftedEntries);
    await assert.rejects(() => buildCurrentCapitalLiveChainBundle({ ...options, outputDirectory: directory }), /route evaluation identity mismatch/);
  }

  const changedEvaluationAt = replaceEntryJson(entryBytes, "tools/datapack/release/current-capital-accessibility-full/route-edge-evaluation.json", (value) => {
    value.evaluationAt = "2026-08-10T00:00:01.000Z";
  });
  await writeOutputEntries(path.join(root, "changed-evaluation-at"), outputPaths, changedEvaluationAt);
  await assert.rejects(() => buildCurrentCapitalLiveChainBundle({ ...options, outputDirectory: path.join(root, "changed-evaluation-at") }), /route evaluation identity mismatch/);

  const tampered = JSON.parse(bytes);
  const evaluation = tampered.entries.find((entry) => entry.path === "tools/datapack/release/current-capital-accessibility-full/route-edge-evaluation.json");
  const policy = tampered.entries.find((entry) => entry.path === "release/product-gates/route-edge-evaluation-policy.json");
  evaluation.bytesBase64 = policy.bytesBase64;
  evaluation.sha256 = policy.sha256;
  const manifest = bundleManifest(tampered);
  tampered.manifestSha256 = sha256(Buffer.from(`${canonical(manifest)}\n`));
  tampered.bundleSha256 = sha256(Buffer.from(canonical({ ...manifest, manifestSha256: tampered.manifestSha256, boundaryBytesBase64: tampered.boundaryBytesBase64, entries: tampered.entries })));
  assert.throws(() => readCurrentCapitalLiveChainBundle(Buffer.from(canonical(tampered)), readOptions), /identity|observedAt|evaluation/i);
  await assert.rejects(() => buildCurrentCapitalLiveChainBundle({ ...options, outputDirectory: path.join(root, "missing") }), /ENOENT/);
});

test("composite bundle reads a valid large source snapshot ledger", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "live-chain-large-ledger-"));
  const authorityPaths = ["tools/datapack/release/candidate-build-spec.json", "tools/datapack/source-inventory.json", "tools/datapack/release/source-snapshots.json"];
  const authorityBytes = new Map(await Promise.all(authorityPaths.map(async (relative) => [relative, await readFile(path.join(ROOT, relative))])));
  const outputPaths = currentCapitalLiveChainOutputPaths({
    candidate: JSON.parse(authorityBytes.get(authorityPaths[0])),
    sourceInventory: JSON.parse(authorityBytes.get(authorityPaths[1])),
    sourceSnapshotLedger: JSON.parse(authorityBytes.get(authorityPaths[2])),
  });
  const repositorySha = sha256(Buffer.from("large-source-snapshot-ledger-regression")).slice(0, 40);
  const entryBytes = new Map();
  await populateEvaluationFixture(entryBytes, { repositorySha, operationId: "current-capital-large-ledger" });
  for (const [index, relative] of outputPaths.entries()) {
    const bytes = entryBytes.get(relative) ?? authorityBytes.get(relative) ?? Buffer.from(`{\"component\":${index}}`);
    const payload = relative === "tools/datapack/release/source-snapshots.json"
      ? Buffer.concat([bytes, Buffer.alloc(2_066_759, 0x20)])
      : bytes;
    entryBytes.set(relative, payload);
    await mkdir(path.dirname(path.join(root, "out", relative)), { recursive: true });
    await writeFile(path.join(root, "out", relative), payload);
  }
  const options = { root, outputDirectory: path.join(root, "out"), repository: "AquilaXk/easysubway-data", repositorySha, operationId: "current-capital-large-ledger", boundaryBytes: boundaryFor(entryBytes) };
  const bundle = readCurrentCapitalLiveChainBundle(await buildCurrentCapitalLiveChainBundle(options), omit(options, "root", "outputDirectory", "boundaryBytes"));
  assert.ok(bundle.entries.find((entry) => entry.path === "tools/datapack/release/source-snapshots.json").bytesBase64.length > 2_700_000);
});

function boundaryFor(entryBytes, overrides = {}) {
  const components = Object.fromEntries(Object.entries(CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS).map(([name, relative]) => [name, { path: relative, sha256: overrides[name] ?? sha256(entryBytes.get(relative)) }]));
  return Buffer.from(canonicalCurrentCapitalLiveChainFanInBoundaryJson({ artifactKind: "current-capital-live-chain-fan-in", components, currentCandidateSourceSetSha256: "a".repeat(64), evidenceSourceSetSha256: "a".repeat(64), kind: "CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN", schemaVersion: 1 }));
}
async function writeOutputEntries(outputDirectory, outputPaths, entryBytes) {
  await Promise.all(outputPaths.map(async (relative, index) => {
    const destination = path.join(outputDirectory, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, entryBytes.get(relative) ?? Buffer.from(`{\"component\":${index}}`));
  }));
}
function replaceEntryJson(entryBytes, relative, mutate) {
  const copy = new Map(entryBytes);
  const value = JSON.parse(copy.get(relative));
  mutate(value);
  copy.set(relative, Buffer.from(JSON.stringify(value)));
  return copy;
}

async function populateEvaluationFixture(entryBytes, { repositorySha = "b".repeat(40), operationId = "current-capital-560" } = {}) {
  const policy = JSON.parse(await readFile(path.join(ROOT, "release/product-gates/route-edge-evaluation-policy.json"), "utf8"));
  const candidateBuildSpec = JSON.parse(await readFile(path.join(ROOT, "tools/datapack/release/candidate-build-spec.json"), "utf8"));
  const evaluationAt = "2026-08-10T00:00:00.000Z";
  const materializationCandidate = {
    candidateId: "bundle-evaluation-candidate",
    stationSetSha256: sha256(Buffer.from(JSON.stringify(["station-a"]))),
    sourceSetSha256: candidateBuildSpec.sourceSnapshotSetHash,
    mappingContractVersion: "station-line-v1",
    materializerVersion: "1",
  };
  const stationLines = [{ stationId: "station-a", lineId: "line-1", operatorId: "operator-1", lineSequence: 1 }];
  const evidence = (domain, state, evidenceKind) => ({
    ...materializationCandidate,
    stationId: "station-a", lineId: "line-1", operatorId: "operator-1", domain, state,
    sourceId: "official-accessibility", sourceSnapshotId: "official-accessibility-20260809",
    evidenceRawSha256: "a".repeat(64), providerRecordHash: "b".repeat(64),
    capturedAt: "2026-08-09T00:00:00.000Z", freshUntil: "2026-08-11T00:00:00.000Z",
    provenanceId: "official-provider", licenseId: "public-data-license", evidenceKind,
    evidenceReason: "official evidence",
  });
  const stationLineInput = {
    candidate: materializationCandidate,
    stationLines: stationLines.map(({ lineSequence: _lineSequence, ...line }) => line),
    evidenceRows: [
      evidence("FACILITY", "VERIFIED_PRESENT", "OBSERVED"),
      evidence("EXIT", "VERIFIED_PRESENT", "OBSERVED"),
      evidence("TRANSFER", "NOT_APPLICABLE", "CURRENT_APPLICABILITY_RULE"),
    ],
  };
  const rawEdge = {
    edgeId: "entry-a", edgeType: "ENTRY", fromNodeId: "station-a", toNodeId: "station-a:line-1",
    durationSeconds: 0, distanceMeters: 0, servicePattern: "", serviceClass: "SUBWAY",
  };
  const routeEdges = [{ ...rawEdge, edgeSha256: routeEdgeSha256(rawEdge) }];
  policy.rideInvariant.subwayLocal.admittedEdgeSetSha256 = canonicalRideEdgeSetSha256([]);
  policy.rideInvariant.itxCheongchunExpress.admittedEdgeSetSha256 = canonicalRideEdgeSetSha256([]);
  const routeEdgeInput = {
    candidate: {
      candidateId: materializationCandidate.candidateId, stationSetSha256: materializationCandidate.stationSetSha256,
      sourceSetSha256: materializationCandidate.sourceSetSha256, topologySha256: "3".repeat(64),
      policyVersion: policy.policyVersion, evaluatorVersion: "1",
    },
    stationLines, routeEdges,
  };
  const materialization = materializeStationLineAccessibility({ ...stationLineInput, observedAt: evaluationAt });
  const evaluation = evaluateRouteAccessibilityEdges({ ...routeEdgeInput, evaluationAt, materialization }, policy);
  candidateBuildSpec.candidateId = materializationCandidate.candidateId;
  const admission = JSON.parse(await readFile(path.join(ROOT, "tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json"), "utf8"));
  admission.candidate = materializationCandidate;
  admission.sourceIdentity.approvedAt = evaluationAt;
  delete admission.admissionDigest;
  admission.admissionDigest = sha256(Buffer.from(canonical(admission)));
  const admissionBytes = Buffer.from(canonical(admission));
  const providerCollectionBundleBytes = Buffer.from("provider-collection");
  const providerCollectionBundleSha256 = sha256(providerCollectionBundleBytes);
  const providerCapturedAt = "2026-08-09T00:00:00.000Z";
  const receipt = buildCurrentExitAdmissionOciReceipt({
    repository: "AquilaXk/easysubway-data", mainSha: repositorySha, operationId, providerCapturedAt,
    providerCollectionBundleBytes,
    providerObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/operations/current-capital-live-chain/v1/heads/${repositorySha}/operations/${operationId}/provider-collections/20260809-${providerCollectionBundleSha256}.json`,
    providerObjectSha256: providerCollectionBundleSha256,
    providerObjectByteSize: providerCollectionBundleBytes.length,
    normalizedBytes: Buffer.from("normalized-snapshot"), admissionBytes,
  });
  entryBytes.set("tools/datapack/release/candidate-build-spec.json", Buffer.from(JSON.stringify(candidateBuildSpec)));
  entryBytes.set("tools/datapack/release/current-capital-accessibility-full/route-edge-input.json", Buffer.from(JSON.stringify(routeEdgeInput)));
  entryBytes.set("tools/datapack/release/current-capital-accessibility-full/station-line-input.json", Buffer.from(JSON.stringify(stationLineInput)));
  entryBytes.set("release/product-gates/route-edge-evaluation-policy.json", Buffer.from(JSON.stringify(policy)));
  entryBytes.set("tools/datapack/release/current-capital-accessibility-full/route-edge-evaluation.json", Buffer.from(canonicalRouteEdgeEvaluationJson(evaluation)));
  entryBytes.set("tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json", admissionBytes);
  entryBytes.set("tools/datapack/release/current-exit-admission-v2/exit-path-admission-oci-receipt.json", Buffer.from(`${canonicalCurrentExitAdmissionOciReceiptJson(receipt)}\n`));
}

function bundleManifest(bundle) {
  return {
    schemaVersion: bundle.schemaVersion, artifactKind: bundle.artifactKind, repository: bundle.repository,
    repositorySha: bundle.repositorySha, operationId: bundle.operationId,
    providerReceiptRelativePath: bundle.providerReceiptRelativePath,
    providerReceiptSha256: bundle.providerReceiptSha256, boundary: bundle.boundary,
    entries: bundle.entries.map(({ path: entryPath, sha256: digest }) => ({ path: entryPath, sha256: digest })),
  };
}
function omit(value, ...keys) { return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort((left, right) => left.localeCompare(right)).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
