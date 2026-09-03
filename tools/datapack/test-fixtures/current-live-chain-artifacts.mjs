import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildCurrentCapitalLiveChainBundle, currentCapitalLiveChainOutputPaths } from "../build-current-capital-live-chain-bundle.mjs";
import { buildCurrentCapitalFacilityCollectionPlan, canonicalCurrentCapitalFacilityCollectionPlanJson } from "../build-current-capital-facility-collection-plan.mjs";
import { buildCurrentCapitalFacilitySourceAdmission, canonicalCurrentCapitalFacilitySourceAdmissionJson } from "../build-current-capital-facility-source-admission.mjs";
import { buildCurrentCapitalRouteEdgeInput, canonicalCurrentCapitalRouteEdgeInputJson } from "../build-current-capital-route-edge-input.mjs";
import { buildCurrentCapitalStationLineInput, canonicalCurrentCapitalStationLineInputJson } from "../build-current-capital-station-line-input.mjs";
import { buildCurrentExitAdmissionOciReceipt, canonicalCurrentExitAdmissionOciReceiptJson } from "../build-current-exit-admission-oci-receipt.mjs";
import { canonicalExitPathAdmissionJson } from "../build-exit-path-admission.mjs";
import {
  buildCurrentCapitalLiveChainFanInBoundary,
  CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS,
  canonicalCurrentCapitalLiveChainFanInBoundaryJson,
} from "../build-current-capital-live-chain-boundary.mjs";
import { buildCurrentExitPathSourceAdmission } from "../build-current-exit-path-source-admission.mjs";
import { buildCurrentKricExitCollectionPlan } from "../build-current-kric-exit-collection-plan.mjs";
import { buildCurrentKricExitCollectionBundle, buildCurrentKricExitCollectionReceipt, canonicalCurrentKricExitCollectionReceiptJson } from "../build-current-kric-exit-collection-receipt.mjs";
import {
  buildCurrentCapitalAccessibilityTransition,
  canonicalCurrentCapitalAccessibilityTransitionJson,
} from "../current-capital-accessibility-transition.mjs";
import { canonicalRouteEdgeEvaluationJson, evaluateRouteAccessibilityEdges } from "../evaluate-route-accessibility-edges.mjs";
import { materializeStationLineAccessibility } from "../materialize-station-line-accessibility.mjs";
import { buildReboundCurrentExitAdmissionIdentities } from "../rebind-current-exit-admission-identities.mjs";
import { deriveBoundReleaseArtifacts } from "../rebind-current-candidate-source-snapshots.mjs";
import { resolveStagedIncheonTopologyPath } from "../run-current-capital-live-chain.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => JSON.stringify(sort(value));
const DATAPACK_ROOT = path.resolve(import.meta.dirname, "../../..");
const CANDIDATE_PATH = "tools/datapack/release/candidate-build-spec.json";
const INVENTORY_PATH = "tools/datapack/source-inventory.json";
const SNAPSHOTS_PATH = "tools/datapack/release/source-snapshots.json";
const RELEASE_REQUEST_PATH = "tools/datapack/release/release-request.json";
const HASH_EVIDENCE_PATH = "tools/datapack/release/hash-evidence.json";
function sort(value) { if (Array.isArray(value)) return value.map(sort); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.keys(value).sort((left, right) => left.localeCompare(right, "en")).map((key) => [key, sort(value[key])])); }

function bindCurrentLiveChainCandidateAuthority(authorityBytes) {
  const bound = new Map(authorityBytes);
  const inventoryBytes = bound.get(INVENTORY_PATH);
  const sourceInventory = JSON.parse(inventoryBytes);
  const candidate = JSON.parse(bound.get(CANDIDATE_PATH));
  candidate.sourceInventorySha256 = sha256(JSON.stringify(sourceInventory));
  candidate.networkEdgeEvidence.sourceInventory.sha256 = sha256(inventoryBytes);
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const release = deriveBoundReleaseArtifacts({
    candidate,
    candidateBytes,
    releaseRequest: JSON.parse(bound.get(RELEASE_REQUEST_PATH)),
    hashEvidence: JSON.parse(bound.get(HASH_EVIDENCE_PATH)),
    sourceSnapshots: JSON.parse(bound.get(SNAPSHOTS_PATH)),
    sourceInventory,
  });
  bound.set(CANDIDATE_PATH, candidateBytes);
  bound.set(RELEASE_REQUEST_PATH, release.requestBytes);
  bound.set(HASH_EVIDENCE_PATH, release.hashEvidenceBytes);
  return bound;
}

function currentIncheonTopologyFixture(sourceInventory) {
  const snapshotPath = resolveStagedIncheonTopologyPath(sourceInventory);
  const prefix = "tools/datapack/";
  if (!snapshotPath.startsWith(prefix)) throw new Error("current Incheon topology fixture path mismatch");
  const source = sourceInventory.sources.find(({ id }) => id === "incheon-transit-station-info");
  const capturedAt = source?.topologyAdmissionEvidence?.capturedAt;
  if (typeof capturedAt !== "string" || Number.isNaN(Date.parse(capturedAt))) throw new Error("current Incheon topology fixture capture mismatch");
  return { path: snapshotPath.slice(prefix.length), capturedAt };
}

export function deriveCurrentIncheonTopologyFixturePath(sourceInventory) {
  return currentIncheonTopologyFixture(sourceInventory).path;
}

export async function buildCanonicalCurrentKricExitCollectionBundle({ repositorySha = "a".repeat(40), operationId = "current-capital-560", capturedAt = null } = {}) {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const paths = { canonicalPackBytes: "release/capital-production-canonical-pack.json", coverageTargetsBytes: "nationwide-coverage-targets.json", providerCodeCatalogBytes: "sources/kric-provider-code-catalog-20260228.json", routeRostersBytes: "sources/kric-nationwide-route-rosters-20260730T203926676Z.json", sourceInventoryBytes: "source-inventory.json" };
  const input = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, file]) => [key, await readFile(path.join(root, file))])));
  const incheonFixture = currentIncheonTopologyFixture(JSON.parse(input.sourceInventoryBytes));
  input.incheonTopologyBytes = await readFile(path.join(root, incheonFixture.path));
  capturedAt ??= incheonFixture.capturedAt;
  const plan = buildCurrentKricExitCollectionPlan(input, { now: new Date(capturedAt), coverageSelector: "capital-seoul-metro-production" });
  const rows = [{ edMovePath: null, elvtSttCd: null, elvtTpCd: null, exitMvTpOrdr: "1", imgPath: null, mvContDtl: null, mvPathMgNo: "1", stMovePath: null }];
  const results = plan.queryPlan.map((query, index) => ({ queryId: query.queryId, state: index === 0 ? "ROWS_OBSERVED" : "EXPLICIT_ZERO", providerResultCode: "00", rawResponseSha256: sha256(`raw-${index}`), rawResponseByteSize: 1, providerRecordHash: sha256(canonical(index === 0 ? rows : [])), rows: index === 0 ? rows : [] }));
  const freshUntil = new Date(Date.parse(capturedAt) + 24 * 60 * 60 * 1000).toISOString();
  const snapshotPayload = { schemaVersion: 1, artifactKind: "kric-exit-path-provider-snapshot", sourceId: "kric-station-movement-standard", snapshotId: `kric-station-movement-standard-${capturedAt.replaceAll(/[-:.]/g, "")}`, capturedAt, freshUntil, credentialRedacted: true, collectionPlanDigest: plan.collectionPlanDigest, queryPlanSha256: plan.queryPlanSha256, coverage: { requestPlanComplete: true, queryIds: plan.queryPlan.map(({ queryId }) => queryId) }, queryPlan: plan.queryPlan, results };
  const snapshot = sort({ ...snapshotPayload, snapshotDigest: sha256(canonical(snapshotPayload)) });
  const planBytes = Buffer.from(canonical(plan)); const snapshotBytes = Buffer.from(canonical(snapshot));
  const receipt = buildCurrentKricExitCollectionReceipt({ collectionPlanBytes: planBytes, providerSnapshotBytes: snapshotBytes, repository: "AquilaXk/easysubway-data", repositorySha, operationId });
  const bytes = Buffer.from(canonical(buildCurrentKricExitCollectionBundle({ collectionPlanBytes: planBytes, providerSnapshotBytes: snapshotBytes, receipt })));
  return { bytes, receipt, snapshot };
}

export async function buildCanonicalCurrentLiveChainComposite({ root, repositorySha = "a".repeat(40), operationId = "current-capital-560", providerCollectionBundleBytes }) {
  if (!Buffer.isBuffer(providerCollectionBundleBytes) || providerCollectionBundleBytes.length === 0) throw new Error("provider collection bundle bytes are required");
  const authorityPaths = [CANDIDATE_PATH, INVENTORY_PATH, SNAPSHOTS_PATH, RELEASE_REQUEST_PATH, HASH_EVIDENCE_PATH];
  const authorityBytes = bindCurrentLiveChainCandidateAuthority(new Map(
    await Promise.all(authorityPaths.map(async (relative) => [relative, await readFile(path.join(DATAPACK_ROOT, relative))])),
  ));
  const outputPaths = currentCapitalLiveChainOutputPaths({
    candidate: JSON.parse(authorityBytes.get(authorityPaths[0])),
    sourceInventory: JSON.parse(authorityBytes.get(authorityPaths[1])),
    sourceSnapshotLedger: JSON.parse(authorityBytes.get(authorityPaths[2])),
  });
  const provider = JSON.parse(providerCollectionBundleBytes.toString("utf8"));
  const snapshot = JSON.parse(provider.providerSnapshotJson);
  const providerCapturedAt = snapshot.capturedAt;
  const providerSha = sha256(providerCollectionBundleBytes);
  const providerObjectUri = `oci://axvym6vk8g7i/easysubway-datapacks/operations/current-capital-live-chain/v1/heads/${repositorySha}/operations/${operationId}/provider-collections/${providerCapturedAt.slice(0, 10).replaceAll("-", "")}-${providerSha}.json`;
  const artifacts = await buildCanonicalCurrentLiveChainArtifacts({ authorityBytes, providerCollectionBundleBytes, repositorySha, operationId });
  const exitReceiptPath = "tools/datapack/release/current-exit-admission-v2/exit-path-admission-oci-receipt.json";
  const normalizedBytes = artifacts.get(CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS.exitNormalized);
  const admissionBytes = artifacts.get(CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS.exitAdmission);
  const entryBytes = new Map();
  for (const relative of outputPaths) {
    const bytes = artifacts.get(relative) ?? authorityBytes.get(relative) ?? await readFile(path.join(DATAPACK_ROOT, relative));
    entryBytes.set(relative, bytes);
    await mkdir(path.join(root, "out", path.dirname(relative)), { recursive: true });
    await writeFile(path.join(root, "out", relative), bytes);
  }
  entryBytes.set(exitReceiptPath, artifacts.get(exitReceiptPath));
  await writeFile(path.join(root, "out", exitReceiptPath), entryBytes.get(exitReceiptPath));
  const boundaryBytes = Buffer.from(canonicalCurrentCapitalLiveChainFanInBoundaryJson(
    buildCurrentCapitalLiveChainFanInBoundary(Object.fromEntries(
      Object.entries(CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS).map(([name, relative]) => [name, {
        bytes: entryBytes.get(relative),
        value: JSON.parse(entryBytes.get(relative).toString("utf8")),
      }]),
    )),
  ));
  const bytes = await buildCurrentCapitalLiveChainBundle({ root, outputDirectory: path.join(root, "out"), repository: "AquilaXk/easysubway-data", repositorySha, operationId, boundaryBytes });
  return { bytes, outputPaths };
}

export async function buildCanonicalCurrentLiveChainArtifacts({ authorityBytes, providerCollectionBundleBytes, repositorySha, operationId }) {
  const readAuthority = (relative) => authorityBytes.get(relative) ?? readFile(path.join(DATAPACK_ROOT, relative));
  const [candidateBytes, inventoryBytes, snapshotsBytes, canonicalPackBytes, coverageTargetsBytes,
    providerCodeCatalogBytes, routeRostersBytes, governancePolicyBytes, freshnessPolicyBytes,
    transferMetricsBytes, transferApplicabilityBytes, policyBytes] = await Promise.all([
    readAuthority("tools/datapack/release/candidate-build-spec.json"),
    readAuthority("tools/datapack/source-inventory.json"),
    readAuthority("tools/datapack/release/source-snapshots.json"),
    readAuthority("tools/datapack/release/capital-production-canonical-pack.json"),
    readAuthority("tools/datapack/nationwide-coverage-targets.json"),
    readAuthority("tools/datapack/sources/kric-provider-code-catalog-20260228.json"),
    readAuthority("tools/datapack/sources/kric-nationwide-route-rosters-20260730T203926676Z.json"),
    readAuthority("tools/datapack/source-governance-policy.json"),
    readAuthority("release/product-gates/datapack-freshness-sla.json"),
    readAuthority("tools/datapack/release/current-transfer-topology-metrics.json"),
    readAuthority("tools/datapack/release/current-capital-transfer-topology-applicability.json"),
    readAuthority("release/product-gates/route-edge-evaluation-policy.json"),
  ]);
  const candidate = JSON.parse(candidateBytes);
  const sourceInventory = JSON.parse(inventoryBytes);
  const sourceSnapshots = JSON.parse(snapshotsBytes);
  const facilityPlan = buildCurrentCapitalFacilityCollectionPlan({
    canonicalPackBytes, coverageTargetsBytes, providerCodeCatalogBytes, routeRostersBytes, sourceInventoryBytes: inventoryBytes,
  });
  const facilitySource = sourceInventory.sources.find(({ id }) => id === "kric-station-convenience-standard");
  const facilitySnapshotBytes = await readAuthority(facilitySource.accessibilityAdmissionEvidence.snapshotPath);
  const facility = buildCurrentCapitalFacilitySourceAdmission({
    planBytes: Buffer.from(canonicalCurrentCapitalFacilityCollectionPlanJson(facilityPlan)), canonicalPackBytes,
    snapshotBytes: facilitySnapshotBytes, candidateBuildSpec: candidate, candidateEvaluationAt: candidate.publishedAt,
    sourceInventoryBytes: inventoryBytes, sourceSnapshots, governancePolicy: JSON.parse(governancePolicyBytes),
    governancePolicyBytes, freshnessPolicy: JSON.parse(freshnessPolicyBytes), observedAt: candidate.publishedAt,
  });
  const provider = JSON.parse(providerCollectionBundleBytes.toString("utf8"));
  const exit = buildCurrentExitPathSourceAdmission({
    providerSnapshotBytes: Buffer.from(provider.providerSnapshotJson), collectionPlan: JSON.parse(provider.collectionPlanJson),
    facilityAdmission: facility, candidateBuildSpec: candidate, sourceInventory, sourceSnapshots,
    observedAt: new Date(Math.max(
      Date.parse(JSON.parse(provider.providerSnapshotJson).capturedAt),
      Date.parse(candidate.publishedAt),
    )).toISOString(),
  });
  const normalizedPath = CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS.exitNormalized;
  const admissionPath = CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS.exitAdmission;
  const facilityPath = CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS.facilityAdmission;
  const artifacts = new Map([
    [facilityPath, Buffer.from(canonicalCurrentCapitalFacilitySourceAdmissionJson(facility))],
    [normalizedPath, Buffer.from(JSON.stringify(exit.normalizedSnapshot))],
    [admissionPath, Buffer.from(canonicalExitPathAdmissionJson(exit.admission))],
  ]);
  const providerSha = sha256(providerCollectionBundleBytes);
  const providerCapturedAt = JSON.parse(provider.providerSnapshotJson).capturedAt;
  const providerObjectUri = `oci://axvym6vk8g7i/easysubway-datapacks/operations/current-capital-live-chain/v1/heads/${repositorySha}/operations/${operationId}/provider-collections/${providerCapturedAt.slice(0, 10).replaceAll("-", "")}-${providerSha}.json`;
  artifacts.set(CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS.exitAdmissionOciReceipt, Buffer.from(`${canonicalCurrentExitAdmissionOciReceiptJson(buildCurrentExitAdmissionOciReceipt({
    repository: "AquilaXk/easysubway-data", mainSha: repositorySha, operationId, providerCapturedAt,
    providerCollectionBundleBytes, providerObjectUri, providerObjectSha256: providerSha,
    providerObjectByteSize: providerCollectionBundleBytes.length,
    normalizedBytes: artifacts.get(normalizedPath), admissionBytes: artifacts.get(admissionPath),
  }))}\n`));
  const previousBytes = await readAuthority("tools/datapack/release/current-station-line-accessibility/station-line-input.json");
  const transition = buildCurrentCapitalAccessibilityTransition({
    candidate, candidateBytes,
    previous: JSON.parse(previousBytes), previousBytes,
    facilityAdmission: facility,
    facilityBytes: artifacts.get(facilityPath),
    ledger: sourceSnapshots, ledgerBytes: snapshotsBytes,
    inventory: sourceInventory, inventoryBytes,
  });
  const rebound = buildReboundCurrentExitAdmissionIdentities({
    transitionBytes: Buffer.from(canonicalCurrentCapitalAccessibilityTransitionJson(transition)),
    normalizedBytes: artifacts.get(normalizedPath),
    admissionBytes: artifacts.get(admissionPath),
    receiptBytes: artifacts.get(CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS.exitAdmissionOciReceipt),
  });
  artifacts.set(admissionPath, rebound.admissionBytes);
  artifacts.set(CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS.exitAdmissionOciReceipt, rebound.receiptBytes);
  const reboundAdmission = JSON.parse(rebound.admissionBytes.toString("utf8"));
  const components = Object.fromEntries(await Promise.all(Object.entries(CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS).map(async ([name, relative]) => {
    const bytes = artifacts.get(relative) ?? await readAuthority(relative);
    return [name, { bytes, value: JSON.parse(bytes.toString("utf8")) }];
  })));
  const boundary = buildCurrentCapitalLiveChainFanInBoundary(components);
  const station = buildCurrentCapitalStationLineInput({
    canonicalPack: JSON.parse(canonicalPackBytes), candidateBuildSpec: candidate, exitAdmission: reboundAdmission,
    exitAdmissionBytes: artifacts.get(admissionPath), exitNormalized: exit.normalizedSnapshot,
    exitNormalizedBytes: artifacts.get(normalizedPath), exitReceipt: components.exitAdmissionOciReceipt.value,
    facilityAdmission: facility, facilitySnapshotBytes, policy: JSON.parse(policyBytes), sourceInventory,
    sourceInventoryBytes: inventoryBytes, sourceSetTransition: boundary, currentFanInComponents: components,
    sourceSnapshots, transferApplicability: JSON.parse(transferApplicabilityBytes), transferMetrics: JSON.parse(transferMetricsBytes),
  });
  const route = buildCurrentCapitalRouteEdgeInput({
    canonicalPack: JSON.parse(canonicalPackBytes), candidateBuildSpec: candidate, exitAdmission: reboundAdmission,
    exitAdmissionBytes: artifacts.get(admissionPath), exitNormalized: exit.normalizedSnapshot,
    exitNormalizedBytes: artifacts.get(normalizedPath), exitReceipt: components.exitAdmissionOciReceipt.value,
    facilityAdmission: facility, facilitySnapshotBytes, policy: JSON.parse(policyBytes), sourceInventory,
    sourceInventoryBytes: inventoryBytes, sourceSetTransition: boundary, currentFanInComponents: components,
    sourceSnapshots, transferApplicability: JSON.parse(transferApplicabilityBytes), transferMetrics: JSON.parse(transferMetricsBytes),
  });
  const evaluationAt = exit.admission.sourceIdentity.approvedAt;
  const materialization = materializeStationLineAccessibility({ ...station, observedAt: evaluationAt });
  const evaluation = evaluateRouteAccessibilityEdges({ ...route, evaluationAt, materialization }, JSON.parse(policyBytes));
  artifacts.set("tools/datapack/release/current-capital-accessibility-full/station-line-input.json", Buffer.from(canonicalCurrentCapitalStationLineInputJson(station)));
  artifacts.set("tools/datapack/release/current-capital-accessibility-full/route-edge-input.json", Buffer.from(canonicalCurrentCapitalRouteEdgeInputJson(route)));
  artifacts.set("tools/datapack/release/current-capital-accessibility-full/route-edge-evaluation.json", Buffer.from(canonicalRouteEdgeEvaluationJson(evaluation)));
  return artifacts;
}

export { canonicalCurrentKricExitCollectionReceiptJson };
