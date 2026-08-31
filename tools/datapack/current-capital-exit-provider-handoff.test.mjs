import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { buildCurrentKricExitCollectionPlan } from "./build-current-kric-exit-collection-plan.mjs";
import { buildCurrentKricExitCollectionBundle, buildCurrentKricExitCollectionReceipt, canonicalCurrentKricExitCollectionBundleJson } from "./build-current-kric-exit-collection-receipt.mjs";
import { canonicalKricExitPathCollectionPlanJson } from "./plan-kric-exit-path-collection.mjs";
import { recoverCurrentKricExitCollectionBytes } from "./run-current-capital-live-chain.mjs";
import { buildCurrentKricExitProviderOciPlan, canonicalCurrentKricExitProviderOciPlanJson } from "./build-current-kric-exit-provider-oci-plan.mjs";
import { buildCurrentKricExitProviderOciReceipt, canonicalCurrentKricExitProviderOciReceiptJson } from "./build-current-kric-exit-provider-oci-receipt.mjs";
import {
  bindCurrentCapitalExitProviderRelease,
  buildCurrentCapitalExitProviderCandidateHandoff,
  buildCurrentCapitalExitProviderSourceHandoffFromProviderOci,
  canonicalCurrentCapitalExitProviderReleaseBindingJson,
  canonicalCurrentCapitalExitProviderSourceHandoffJson,
  recoverCurrentCapitalExitProviderCandidate,
} from "./current-capital-exit-provider-handoff.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => JSON.stringify(sort(value));
function sort(value) { if (Array.isArray(value)) return value.map(sort); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])])); }

function memoryStore(values) { return { puts: 0, gets: 0, async readObject(key) { this.gets += 1; const body = values.get(key); return body ? { exists: true, body: Buffer.from(body) } : { exists: false }; } }; }
async function bundleFixture() {
  const paths = { canonicalPackBytes: "tools/datapack/release/capital-production-canonical-pack.json", coverageTargetsBytes: "tools/datapack/nationwide-coverage-targets.json", providerCodeCatalogBytes: "tools/datapack/sources/kric-provider-code-catalog-20260228.json", routeRostersBytes: "tools/datapack/sources/kric-nationwide-route-rosters-20260730T203926676Z.json", sourceInventoryBytes: "tools/datapack/source-inventory.json" };
  const input = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, relative]) => [key, await readFile(path.join(ROOT, relative))]))); const inventory = JSON.parse(input.sourceInventoryBytes); const admission = inventory.sources.find(({ id }) => id === "incheon-transit-station-info").topologyAdmissionEvidence; input.incheonTopologyBytes = await readFile(path.join(ROOT, admission.snapshotPath));
  const plan = buildCurrentKricExitCollectionPlan(input, { now: new Date(admission.capturedAt), coverageSelector: "capital-seoul-metro-production" }); const rows = [{ edMovePath: null, elvtSttCd: null, elvtTpCd: null, exitMvTpOrdr: "1", imgPath: null, mvContDtl: null, mvPathMgNo: "1", stMovePath: null }]; const results = plan.queryPlan.map((query, index) => ({ queryId: query.queryId, state: index === 0 ? "ROWS_OBSERVED" : "EXPLICIT_ZERO", providerResultCode: "00", rawResponseSha256: sha(`raw-${index}`), rawResponseByteSize: 1, providerRecordHash: sha(canonical(index === 0 ? rows : [])), rows: index === 0 ? rows : [] }));
  const payload = { schemaVersion: 1, artifactKind: "kric-exit-path-provider-snapshot", sourceId: "kric-station-movement-standard", snapshotId: `kric-station-movement-standard-${admission.capturedAt.replaceAll(/[-:.]/gu, "")}`, capturedAt: admission.capturedAt, freshUntil: admission.freshUntil, credentialRedacted: true, collectionPlanDigest: plan.collectionPlanDigest, queryPlanSha256: plan.queryPlanSha256, coverage: { requestPlanComplete: true, queryIds: plan.queryPlan.map(({ queryId }) => queryId) }, queryPlan: plan.queryPlan, results }; const snapshot = sort({ ...payload, snapshotDigest: sha(canonical(payload)) }); const planBytes = Buffer.from(canonical(plan)); const snapshotBytes = Buffer.from(canonical(snapshot)); const receipt = buildCurrentKricExitCollectionReceipt({ collectionPlanBytes: planBytes, providerSnapshotBytes: snapshotBytes, repository: "AquilaXk/easysubway-data", repositorySha: "a".repeat(40), operationId: "current-capital-560" }); const bundle = buildCurrentKricExitCollectionBundle({ collectionPlanBytes: planBytes, providerSnapshotBytes: snapshotBytes, receipt }); return { candidateId: plan.candidate.candidateId, bytes: Buffer.from(canonicalCurrentKricExitCollectionBundleJson(bundle)) };
}

function providerOciHandoffFixture(fixture) {
  const provider = JSON.parse(fixture.bytes); const snapshot = JSON.parse(provider.providerSnapshotJson);
  const mainSha = "a".repeat(40); const operationId = "current-capital-560";
  const plan = buildCurrentKricExitProviderOciPlan({ mainSha, operationId, providerCollectionBundleBytes: fixture.bytes, providerCapturedAt: snapshot.capturedAt });
  const planBytes = Buffer.from(`${canonicalCurrentKricExitProviderOciPlanJson(plan)}\n`);
  const receipt = buildCurrentKricExitProviderOciReceipt({ planBytes });
  const receiptBytes = Buffer.from(`${canonicalCurrentKricExitProviderOciReceiptJson(receipt, { planBytes })}\n`);
  const source = buildCurrentCapitalExitProviderSourceHandoffFromProviderOci({ providerOciPlanBytes: planBytes, providerOciReceiptBytes: receiptBytes, fetchedProviderCollectionBundleBytes: fixture.bytes, repository: "AquilaXk/easysubway-data", repositorySha: mainSha, operationId });
  return { snapshot, mainSha, operationId, providerObject: plan.providerObject, planBytes, receiptBytes, sourceReceiptBytes: Buffer.from(`${canonicalCurrentCapitalExitProviderSourceHandoffJson(source)}\n`) };
}

test("candidate binds provider-only OCI evidence with exactly one GET", async () => {
  const fixture = await bundleFixture();
  const sourceBundle = JSON.parse(fixture.bytes);
  const handoff = providerOciHandoffFixture(fixture); const operationNow = new Date(handoff.snapshot.capturedAt);
  const targetPlan = JSON.parse(sourceBundle.collectionPlanJson);
  targetPlan.candidate.candidateId = `${targetPlan.candidate.candidateId}-next`;
  delete targetPlan.collectionPlanDigest;
  targetPlan.collectionPlanDigest = sha(canonical(targetPlan));
  const targetPlanBytes = Buffer.from(canonicalKricExitPathCollectionPlanJson(targetPlan));
  const reboundPath = "tools/datapack/release/current-kric-exit-collection-bundle.json";
  const store = memoryStore(new Map([[handoff.providerObject.objectKey, fixture.bytes]]));
  const consumed = await recoverCurrentCapitalExitProviderCandidate({
    sourceReceiptBytes: handoff.sourceReceiptBytes, providerOciPlanBytes: handoff.planBytes, providerOciReceiptBytes: handoff.receiptBytes,
    targetPlanBytes, candidateOperationId: "current-capital-633", operationNow,
    preflight: { origin: "git@github.com:AquilaXk/easysubway-data.git", branch: "feat/633", clean: true, headSha: "b".repeat(40), upstream: "origin/feat/633", remoteHeadSha: "b".repeat(40) }, reboundOutputPath: reboundPath,
    client: store, isAncestor: async (from, to) => from === "a".repeat(40) && to === "b".repeat(40),
  });
  assert.equal(consumed.providerCalls, 0);
  assert.equal(JSON.parse(consumed.reboundBundleBytes).collectionPlanJson, targetPlanBytes.toString("utf8"));
  const tracked = Object.fromEntries([
    "tools/datapack/release/current-exit-admission-v2/exit-path-normalized-source-snapshot.json",
    "tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json",
    "tools/datapack/release/current-exit-admission-v2/exit-path-admission-oci-receipt.json",
  ].map((entryPath) => [entryPath, Buffer.from(entryPath)]));
  const trackedInventory = Object.entries(tracked).map(([entryPath, bytes]) => ({ path: entryPath, sha256: sha(bytes), sizeBytes: bytes.length }));
  const binding = await bindCurrentCapitalExitProviderRelease({
    candidateReceiptBytes: Buffer.from(`${canonical(JSON.parse(JSON.stringify(consumed.candidateReceipt)))}\n`), reboundBundleBytes: consumed.reboundBundleBytes, preflight: { origin: "git@github.com:AquilaXk/easysubway-data.git", branch: "main", clean: true, headSha: "c".repeat(40), originMainSha: "c".repeat(40), remoteMainSha: "c".repeat(40) }, operationNow,
    trackedOutputInventory: trackedInventory, trackedOutputs: tracked, isAncestor: async (from, to) => from === "b".repeat(40) && to === "c".repeat(40),
  });
  assert.equal(binding.releaseMainSha, "c".repeat(40)); assert.equal(store.puts, 0); assert.equal(store.gets, 1);
});

test("candidate and release binding reject wrong remote identity, stale evidence, drift, and ancestry", async () => {
  const fixture = await bundleFixture(); const raw = JSON.parse(fixture.bytes); const handoff = providerOciHandoffFixture(fixture); const now = new Date(handoff.snapshot.capturedAt);
  const store = memoryStore(new Map([[handoff.providerObject.objectKey, fixture.bytes]]));
  const target = JSON.parse(raw.collectionPlanJson); target.candidate.candidateId = `${target.candidate.candidateId}-next`; delete target.collectionPlanDigest; target.collectionPlanDigest = sha(canonical(target));
  const targetBytes = Buffer.from(canonicalKricExitPathCollectionPlanJson(target));
  const outputPath = "tools/datapack/release/current-kric-exit-collection-bundle.json";
  const consume = (overrides = {}) => recoverCurrentCapitalExitProviderCandidate({ sourceReceiptBytes: handoff.sourceReceiptBytes, providerOciPlanBytes: handoff.planBytes, providerOciReceiptBytes: handoff.receiptBytes, targetPlanBytes: overrides.targetPlanBytes ?? targetBytes, candidateOperationId: "current-capital-633", operationNow: overrides.operationNow ?? now, preflight: overrides.preflight ?? { origin: "https://github.com/AquilaXk/easysubway-data.git", branch: "feat/633", clean: true, headSha: "b".repeat(40), upstream: "origin/feat/633", remoteHeadSha: "b".repeat(40) }, reboundOutputPath: outputPath, client: overrides.client ?? store, isAncestor: overrides.isAncestor ?? (async () => true) });
  await assert.rejects(consume({ preflight: { origin: "https://github.com/AquilaXk/easysubway-data.git", branch: "feat/633", clean: true, headSha: "b".repeat(40), upstream: "origin/feat/633", remoteHeadSha: "c".repeat(40) } }), /remote non-main/);
  const semanticDrift = structuredClone(target); semanticDrift.candidate.stationSetSha256 = "f".repeat(64); delete semanticDrift.collectionPlanDigest; semanticDrift.collectionPlanDigest = sha(canonical(semanticDrift));
  await assert.rejects(consume({ targetPlanBytes: Buffer.from(canonicalKricExitPathCollectionPlanJson(semanticDrift)) }), /provider-equivalent/);
  await assert.rejects(consume({ isAncestor: async () => false }), /not an ancestor/);
  await assert.rejects(consume({ client: { ...store, readObject: async () => ({ exists: true, body: Buffer.from("wrong") }) } }), /exact GET/);
  const consumed = await consume();
  const candidateReceiptBytes = Buffer.from(`${canonical(consumed.candidateReceipt)}\n`);
  const tracked = Object.fromEntries([
    "tools/datapack/release/current-exit-admission-v2/exit-path-normalized-source-snapshot.json",
    "tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json",
    "tools/datapack/release/current-exit-admission-v2/exit-path-admission-oci-receipt.json",
  ].map((entryPath) => [entryPath, Buffer.from(entryPath)]));
  const inventory = Object.entries(tracked).map(([entryPath, bytes]) => ({ path: entryPath, sha256: sha(bytes), sizeBytes: bytes.length }));
  const releasePreflight = { origin: "https://github.com/AquilaXk/easysubway-data.git", branch: "main", clean: true, headSha: "c".repeat(40), originMainSha: "c".repeat(40), remoteMainSha: "c".repeat(40) };
  const bind = (overrides = {}) => bindCurrentCapitalExitProviderRelease({ candidateReceiptBytes, reboundBundleBytes: overrides.reboundBundleBytes ?? consumed.reboundBundleBytes, preflight: overrides.preflight ?? releasePreflight, operationNow: overrides.operationNow ?? now, trackedOutputInventory: overrides.inventory ?? inventory, trackedOutputs: overrides.trackedOutputs ?? tracked, isAncestor: overrides.isAncestor ?? (async () => true) });
  await assert.rejects(bind({ preflight: { ...releasePreflight, remoteMainSha: "d".repeat(40) } }), /release main preflight/);
  await assert.rejects(bind({ operationNow: new Date(handoff.snapshot.freshUntil) }), /stale/);
  await assert.rejects(bind({ trackedOutputs: { ...tracked, [inventory[0].path]: Buffer.from("wrong") } }), /tracked output drift/);
  await assert.rejects(bind({ isAncestor: async () => false }), /not an ancestor/);
  await assert.rejects(bind({ inventory: inventory.slice(1) }), /inventory contract/);
  await assert.rejects(bind({ reboundBundleBytes: fixture.bytes }), /rebound bundle drift/);
  const binding = await bind();
  for (const inventory of [binding.trackedOutputInventory.slice(1), [{ ...binding.trackedOutputInventory[0], path: "tools/datapack/release/current-exit-admission-v2/substituted.json" }, ...binding.trackedOutputInventory.slice(1)]]) {
    const selfHashed = { ...binding, trackedOutputInventory: inventory };
    const { receiptSha256, ...payload } = selfHashed;
    selfHashed.receiptSha256 = sha(Buffer.from(canonical(payload)));
    assert.throws(() => canonicalCurrentCapitalExitProviderReleaseBindingJson(selfHashed), /inventory contract/);
  }
  const reboundRaw = JSON.parse(consumed.reboundBundleBytes); const reboundReceipt = JSON.parse(reboundRaw.collectionReceiptJson);
  const wrongReceipt = buildCurrentKricExitCollectionReceipt({ collectionPlanBytes: Buffer.from(reboundRaw.collectionPlanJson), providerSnapshotBytes: Buffer.from(reboundRaw.providerSnapshotJson), repository: "AquilaXk/easysubway-data", repositorySha: "d".repeat(40), operationId: "current-capital-633", recoveredFrom: reboundReceipt.recoveredFrom });
  const wrongBundle = buildCurrentKricExitCollectionBundle({ collectionPlanBytes: Buffer.from(reboundRaw.collectionPlanJson), providerSnapshotBytes: Buffer.from(reboundRaw.providerSnapshotJson), receipt: wrongReceipt });
  assert.throws(() => buildCurrentCapitalExitProviderCandidateHandoff({ source: JSON.parse(handoff.sourceReceiptBytes), producerHeadSha: "b".repeat(40), candidateOperationId: "current-capital-633", targetCandidateId: target.candidate.candidateId, reboundBundleBytes: Buffer.from(canonicalCurrentKricExitCollectionBundleJson(wrongBundle)), reboundOutputPath: outputPath }), /rebound recovery binding/);
});
