import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildCurrentCapitalFacilityCollectionPlan, canonicalCurrentCapitalFacilityCollectionPlanJson } from "../build-current-capital-facility-collection-plan.mjs";
import { buildCurrentCapitalFacilitySourceAdmission, canonicalCurrentCapitalFacilitySourceAdmissionJson } from "../build-current-capital-facility-source-admission.mjs";
import { collectKricAccessibilitySnapshots } from "../collect-kric-accessibility-snapshots.mjs";
import { buildCurrentKricExitCollectionPlan } from "../build-current-kric-exit-collection-plan.mjs";
import { canonicalKricExitPathCollectionPlanJson } from "../plan-kric-exit-path-collection.mjs";
import { collectKricExitPathProviderSnapshot, canonicalKricExitPathProviderSnapshotJson } from "../collect-kric-exit-path-provider-snapshot.mjs";
import { buildCurrentKricExitCollectionBundle, buildCurrentKricExitCollectionReceipt, canonicalCurrentKricExitCollectionBundleJson } from "../build-current-kric-exit-collection-receipt.mjs";
import { buildCurrentExitPathSourceAdmission } from "../build-current-exit-path-source-admission.mjs";
import { canonicalExitPathAdmissionJson } from "../build-exit-path-admission.mjs";
import { buildCurrentExitAdmissionOciReceipt, canonicalCurrentExitAdmissionOciReceiptJson } from "../build-current-exit-admission-oci-receipt.mjs";
import {
  buildCurrentCapitalAccessibilityTransition,
  buildCurrentCapitalAccessibilityTransitionSuccessor,
  canonicalCurrentCapitalAccessibilityTransitionJson,
  canonicalCurrentCapitalAccessibilityTransitionSuccessorJson,
} from "../current-capital-accessibility-transition.mjs";
import { buildReboundCurrentExitAdmissionIdentities } from "../rebind-current-exit-admission-identities.mjs";
import { buildCurrentCapitalLiveChainFanInBoundary, canonicalCurrentCapitalLiveChainFanInBoundaryJson, CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS } from "../build-current-capital-live-chain-boundary.mjs";
import { deriveRawRetentionExpiresAt } from "../source-governance-policy.mjs";
import { registerKricStandardAccessibilitySnapshot } from "../register-kric-standard-accessibility-snapshot.mjs";
import { rebindCurrentCandidateSourceSnapshots } from "../rebind-current-candidate-source-snapshots.mjs";
import { rebindCurrentActivePublicRouteMapMaterialization } from "../rebind-current-active-public-route-map-materialization.mjs";
import {
  buildAuthenticatedCurrentCapitalFacilityEvidenceRows,
  buildCurrentCapitalStationLineInput,
  canonicalCurrentCapitalStationLineInputJson,
  readCurrentCapitalInputs,
} from "../build-current-capital-station-line-input.mjs";
import { buildCurrentCapitalRouteEdgeInput, canonicalCurrentCapitalRouteEdgeInputJson } from "../build-current-capital-route-edge-input.mjs";
import { projectCandidateFixtureForAccessibilityAuthority } from "../build-datapack.mjs";
import { readCurrentCapitalLiveChainFanInBoundary } from "../build-current-capital-live-chain-boundary.mjs";
import {
  buildCurrentReleaseCandidateAccessibilityAuthority,
  canonicalCurrentReleaseCandidateAccessibilityAuthorityJson,
  canonicalCurrentReleaseCandidateFixtureJson,
} from "../build-current-release-candidate-accessibility-input.mjs";
import { syncCurrentRouteEdgePolicyFile } from "../sync-current-route-edge-policy.mjs";
import {
  activateSyntheticCurrentStaticNetworkSuccessors,
  copySyntheticCurrentPublicRouteMapRepository,
  nextSyntheticCurrentStaticNetworkNow,
} from "./current-public-route-map-successor.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const FACILITY_OPERATION = Object.freeze({
  sourceId: "kric-station-convenience-standard",
  endpoint: "https://openapi.kric.go.kr/openapi/handicapped/stationCnvFacl",
  responseFields: ["dtlLoc", "grndDvCd", "gubun", "imgPath", "mlFmlDvCd", "stinFlor", "trfcWeakDvCd"],
  tupleIdentityFields: [],
});

async function json(root, relative) {
  return JSON.parse(await readFile(path.join(root, relative), "utf8"));
}

async function bindActivatedOutputsToCandidate(repositoryRoot) {
  const candidate = await json(repositoryRoot, "tools/datapack/release/candidate-build-spec.json");
  const outputPaths = [
    "tools/datapack/release/current-capital-accessibility-full/station-line-input.json",
    "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json",
  ];
  const [station, route] = await Promise.all(outputPaths.map((relative) => json(repositoryRoot, relative)));
  station.candidate.candidateId = candidate.candidateId;
  station.candidate.sourceSetSha256 = candidate.sourceSnapshotSetHash;
  for (const row of station.evidenceRows) row.candidateId = candidate.candidateId;
  route.candidate.candidateId = candidate.candidateId;
  route.candidate.sourceSetSha256 = candidate.sourceSnapshotSetHash;
  await Promise.all(outputPaths.map((relative, index) => writeFile(
    path.join(repositoryRoot, relative),
    Buffer.from(`${JSON.stringify(index === 0 ? station : route, null, 2)}\n`),
  )));
}

async function assertSelectedPublicLayoutBinding(repositoryRoot, phase) {
  const [candidate, inventory, snapshots] = await Promise.all([
    json(repositoryRoot, "tools/datapack/release/candidate-build-spec.json"),
    json(repositoryRoot, "tools/datapack/source-inventory.json"),
    json(repositoryRoot, "tools/datapack/release/source-snapshots.json"),
  ]);
  const index = candidate.sourceSnapshots.findIndex(({ sourceId }) => sourceId === "seoul-metro-route-map-positions");
  const row = snapshots.find(({ snapshotId }) => snapshotId === candidate.sourceSnapshotIds[index]);
  const admission = inventory.sources.find(({ id }) => id === "seoul-metro-route-map-positions")?.routeMapAdmissionEvidence?.currentLayoutAdmission;
  if (index < 0 || admission?.layoutArtifactSha256 !== row?.routeMapLayoutEvidence?.layoutArtifactSha256) {
    throw new Error(`synthetic current public route-map layout binding mismatch after ${phase}`);
  }
}

async function registerFreshFacilitySnapshot(repositoryRoot, now) {
  const files = await Promise.all([
    "tools/datapack/release/capital-production-canonical-pack.json",
    "tools/datapack/nationwide-coverage-targets.json",
    "tools/datapack/sources/kric-provider-code-catalog-20260228.json",
    "tools/datapack/sources/kric-nationwide-route-rosters-20260730T203926676Z.json",
    "tools/datapack/source-inventory.json",
    "tools/datapack/source-governance-policy.json",
  ].map((relative) => readFile(path.join(repositoryRoot, relative))));
  const [canonicalPackBytes, coverageTargetsBytes, providerCodeCatalogBytes, routeRostersBytes, inventoryBytes, governanceBytes] = files;
  const plan = buildCurrentCapitalFacilityCollectionPlan({
    canonicalPackBytes, coverageTargetsBytes, providerCodeCatalogBytes, routeRostersBytes, sourceInventoryBytes: inventoryBytes,
  });
  const roster = plan.stationLineProviderMappings.map((entry) => ({
    stationId: entry.stationId, lineId: entry.lineId, railOprIsttCd: entry.providerOperatorId,
    lnCd: entry.providerLineId, stinCd: entry.providerStationId,
    canonicalMappings: [{ artifactId: "bundled-capital", stationId: entry.stationId, lineId: entry.lineId }],
  }));
  const [snapshot] = await collectKricAccessibilitySnapshots({
    roster, operations: [FACILITY_OPERATION], serviceKey: "fixture-only-key", now,
    allowTerminalResult03: true,
    fetchImpl: async (url) => ({
      ok: true, status: 200,
      json: async () => new URL(url).searchParams.get("stinCd") === "234-4"
        ? { header: { resultCode: "03" } }
        : { header: { resultCode: "00" }, body: [
          {
            dtlLoc: "synthetic current A", grndDvCd: "1", gubun: "EV", imgPath: "", mlFmlDvCd: "", stinFlor: 1, trfcWeakDvCd: "01",
          },
          {
            dtlLoc: "synthetic current B", grndDvCd: "1", gubun: "EV", imgPath: "", mlFmlDvCd: "", stinFlor: 2, trfcWeakDvCd: "01",
          },
        ] },
    }),
  });
  const stagingPath = path.join(repositoryRoot, `fresh-facility-snapshot-${snapshot.snapshotId}.json`);
  const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
  await writeFile(stagingPath, snapshotBytes, { flag: "wx", mode: 0o600 });
  const retainedRawBytes = Buffer.from(JSON.stringify({
    artifactKind: "test-only-kric-facility-retained-raw", sourceId: snapshot.sourceId,
    snapshotId: snapshot.snapshotId, snapshotRawSha256: snapshot.rawSha256,
  }));
  const retainedRawSha256 = sha256(retainedRawBytes);
  await writeFile(
    path.join(repositoryRoot, `fresh-facility-retained-raw-${snapshot.snapshotId}.json`),
    retainedRawBytes,
    { flag: "wx", mode: 0o600 },
  );
  const planPath = path.join(repositoryRoot, `fresh-facility-plan-${snapshot.snapshotId}.json`);
  await writeFile(planPath, canonicalCurrentCapitalFacilityCollectionPlanJson(plan), { flag: "wx", mode: 0o600 });
  const governance = JSON.parse(governanceBytes);
  await registerKricStandardAccessibilitySnapshot({
    snapshotFilePath: stagingPath,
    snapshotFileSha256: sha256(snapshotBytes),
    snapshotTargetPath: path.join(repositoryRoot, "tools/datapack/sources", `${snapshot.snapshotId}.json`),
    rawReceipt: {
      rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/test-fixtures/kric-station-convenience-standard/${retainedRawSha256}.json`,
      sourceId: snapshot.sourceId, snapshotId: snapshot.snapshotId, snapshotRawSha256: snapshot.rawSha256,
      capturedAt: snapshot.capturedAt, snapshotFileSha256: sha256(snapshotBytes), rawObjectSha256: retainedRawSha256,
      byteSize: retainedRawBytes.length, storedAt: snapshot.capturedAt,
      rawRetentionExpiresAt: deriveRawRetentionExpiresAt({ policy: governance, sourceId: snapshot.sourceId, retrievedAt: snapshot.capturedAt }),
    },
    capitalFacilityPlanPath: planPath,
    capitalCanonicalPackPath: path.join(repositoryRoot, "tools/datapack/release/capital-production-canonical-pack.json"),
    producerNeutralFullRegistration: true,
    repositoryRoot,
    now: new Date(now.getTime() + 1_000),
  });
}

async function writeFreshFacilityAdmission(repositoryRoot, observedAt) {
  const paths = [
    "tools/datapack/release/capital-production-canonical-pack.json",
    "tools/datapack/nationwide-coverage-targets.json",
    "tools/datapack/sources/kric-provider-code-catalog-20260228.json",
    "tools/datapack/sources/kric-nationwide-route-rosters-20260730T203926676Z.json",
    "tools/datapack/source-inventory.json",
    "tools/datapack/release/candidate-build-spec.json",
    "tools/datapack/release/source-snapshots.json",
    "tools/datapack/source-governance-policy.json",
    "release/product-gates/datapack-freshness-sla.json",
  ];
  const values = Object.fromEntries(await Promise.all(paths.map(async (relative) => [relative, await readFile(path.join(repositoryRoot, relative))])));
  const plan = buildCurrentCapitalFacilityCollectionPlan({
    canonicalPackBytes: values[paths[0]], coverageTargetsBytes: values[paths[1]], providerCodeCatalogBytes: values[paths[2]],
    routeRostersBytes: values[paths[3]], sourceInventoryBytes: values[paths[4]],
  });
  const inventory = JSON.parse(values[paths[4]]);
  const active = inventory.sources.find(({ id }) => id === FACILITY_OPERATION.sourceId)?.accessibilityAdmissionEvidence;
  if (!active?.snapshotPath) throw new Error("synthetic FACILITY admission snapshot missing");
  const snapshotBytes = await readFile(path.join(repositoryRoot, active.snapshotPath));
  const candidateBuildSpec = JSON.parse(values[paths[5]]);
  const admission = buildCurrentCapitalFacilitySourceAdmission({
    observedAt: observedAt.toISOString(), planBytes: Buffer.from(canonicalCurrentCapitalFacilityCollectionPlanJson(plan)),
    candidateEvaluationAt: candidateBuildSpec.publishedAt, canonicalPackBytes: values[paths[0]], snapshotBytes, candidateBuildSpec,
    sourceInventoryBytes: values[paths[4]], sourceSnapshots: JSON.parse(values[paths[6]]),
    governancePolicy: JSON.parse(values[paths[7]]), governancePolicyBytes: values[paths[7]],
    freshnessPolicy: JSON.parse(values[paths[8]]),
  });
  await writeFile(
    path.join(repositoryRoot, "tools/datapack/release/current-capital-facility-source-admission.json"),
    canonicalCurrentCapitalFacilitySourceAdmissionJson(admission),
  );
  return admission;
}

export async function writeFreshExitAdmissionChain(repositoryRoot, observedAt) {
  const inputPaths = {
    canonicalPackBytes: "tools/datapack/release/capital-production-canonical-pack.json",
    coverageTargetsBytes: "tools/datapack/nationwide-coverage-targets.json",
    providerCodeCatalogBytes: "tools/datapack/sources/kric-provider-code-catalog-20260228.json",
    routeRostersBytes: "tools/datapack/sources/kric-nationwide-route-rosters-20260730T203926676Z.json",
    sourceInventoryBytes: "tools/datapack/source-inventory.json",
  };
  const input = Object.fromEntries(await Promise.all(Object.entries(inputPaths).map(async ([key, relative]) => [key, await readFile(path.join(repositoryRoot, relative))])));
  const inventory = JSON.parse(input.sourceInventoryBytes);
  const incheonPath = inventory.sources.find(({ id }) => id === "incheon-transit-station-info")?.topologyAdmissionEvidence?.snapshotPath;
  if (typeof incheonPath !== "string") throw new Error("synthetic EXIT Incheon topology snapshot missing");
  input.incheonTopologyBytes = await readFile(path.join(repositoryRoot, incheonPath));
  const plan = buildCurrentKricExitCollectionPlan(input, { now: observedAt, coverageSelector: "capital-seoul-metro-production" });
  const snapshot = await collectKricExitPathProviderSnapshot({
    collectionPlan: plan, sourceId: "kric-station-movement-standard", serviceKey: "fixture-only-key", now: observedAt,
    requestIntervalMs: 0,
    fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('{"header":{"resultCode":"00"},"body":[]}') }),
  });
  const planBytes = Buffer.from(canonicalKricExitPathCollectionPlanJson(plan));
  const snapshotBytes = Buffer.from(canonicalKricExitPathProviderSnapshotJson(snapshot));
  // Test-only deterministic identity satisfying the receipt's SHA-shaped contract;
  // it is not presented as a Git commit.
  const syntheticRepositorySha = sha256(Buffer.from(JSON.stringify(plan))).slice(0, 40);
  const operationId = "current-capital-560";
  const receipt = buildCurrentKricExitCollectionReceipt({
    collectionPlanBytes: planBytes, providerSnapshotBytes: snapshotBytes, repository: "AquilaXk/easysubway-data", repositorySha: syntheticRepositorySha, operationId,
  });
  const bundleBytes = Buffer.from(canonicalCurrentKricExitCollectionBundleJson(buildCurrentKricExitCollectionBundle({
    collectionPlanBytes: planBytes, providerSnapshotBytes: snapshotBytes, receipt,
  })));
  const [facility, candidate, snapshots] = await Promise.all([
    json(repositoryRoot, "tools/datapack/release/current-capital-facility-source-admission.json"),
    json(repositoryRoot, "tools/datapack/release/candidate-build-spec.json"),
    json(repositoryRoot, "tools/datapack/release/source-snapshots.json"),
  ]);
  const { normalizedSnapshot, admission } = buildCurrentExitPathSourceAdmission({
    providerSnapshotBytes: snapshotBytes, collectionPlan: plan, facilityAdmission: facility,
    candidateBuildSpec: candidate, sourceInventory: inventory, sourceSnapshots: snapshots, observedAt: observedAt.toISOString(),
  });
  const normalizedBytes = Buffer.from(JSON.stringify(normalizedSnapshot));
  const admissionBytes = Buffer.from(canonicalExitPathAdmissionJson(admission));
  const providerSha256 = sha256(bundleBytes);
  const providerObjectUri = `oci://axvym6vk8g7i/easysubway-datapacks/operations/current-capital-live-chain/v1/heads/${syntheticRepositorySha}/operations/${operationId}/provider-collections/${snapshot.capturedAt.slice(0, 10).replaceAll("-", "")}-${providerSha256}.json`;
  const ociReceipt = buildCurrentExitAdmissionOciReceipt({
    repository: "AquilaXk/easysubway-data", mainSha: syntheticRepositorySha, operationId, providerCapturedAt: snapshot.capturedAt,
    providerCollectionBundleBytes: bundleBytes, providerObjectUri, providerObjectSha256: providerSha256,
    providerObjectByteSize: bundleBytes.length, normalizedBytes, admissionBytes,
  });
  const output = "tools/datapack/release/current-exit-admission-v2";
  await Promise.all([
    writeFile(path.join(repositoryRoot, output, "exit-path-normalized-source-snapshot.json"), normalizedBytes),
    writeFile(path.join(repositoryRoot, output, "exit-path-source-admission.json"), admissionBytes),
    writeFile(path.join(repositoryRoot, output, "exit-path-admission-oci-receipt.json"), `${canonicalCurrentExitAdmissionOciReceiptJson(ociReceipt)}\n`),
  ]);
}

export async function rebindFreshExitAdmissionForCurrentTransition(repositoryRoot, previousBytes) {
  const paths = {
    candidate: "tools/datapack/release/candidate-build-spec.json",
    facility: "tools/datapack/release/current-capital-facility-source-admission.json",
    ledger: "tools/datapack/release/source-snapshots.json",
    inventory: "tools/datapack/source-inventory.json",
    normalized: "tools/datapack/release/current-exit-admission-v2/exit-path-normalized-source-snapshot.json",
    admission: "tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json",
    receipt: "tools/datapack/release/current-exit-admission-v2/exit-path-admission-oci-receipt.json",
  };
  const bytes = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, relative]) =>
    [key, await readFile(path.join(repositoryRoot, relative))])));
  const transition = buildCurrentCapitalAccessibilityTransition({
    candidate: JSON.parse(bytes.candidate), candidateBytes: bytes.candidate,
    previous: JSON.parse(previousBytes), previousBytes,
    facilityAdmission: JSON.parse(bytes.facility), facilityBytes: bytes.facility,
    ledger: JSON.parse(bytes.ledger), ledgerBytes: bytes.ledger,
    inventory: JSON.parse(bytes.inventory), inventoryBytes: bytes.inventory,
  });
  const rebound = buildReboundCurrentExitAdmissionIdentities({
    transitionBytes: Buffer.from(canonicalCurrentCapitalAccessibilityTransitionJson(transition)),
    normalizedBytes: bytes.normalized,
    admissionBytes: bytes.admission,
    receiptBytes: bytes.receipt,
  });
  await Promise.all([
    writeFile(path.join(repositoryRoot, paths.admission), rebound.admissionBytes),
    writeFile(path.join(repositoryRoot, paths.receipt), rebound.receiptBytes),
  ]);
}

async function writeCurrentFanIn(repositoryRoot) {
  const components = Object.fromEntries(await Promise.all(Object.entries(CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS).map(async ([name, relative]) => {
    const bytes = await readFile(path.join(repositoryRoot, relative));
    return [name, { bytes, value: JSON.parse(bytes) }];
  })));
  const fanIn = buildCurrentCapitalLiveChainFanInBoundary(components);
  await writeFile(
    path.join(repositoryRoot, "tools/datapack/release/current-capital-live-chain-fan-in.json"),
    canonicalCurrentCapitalLiveChainFanInBoundaryJson(fanIn),
  );
}

async function writeFreshAccessibilityOutputs(repositoryRoot) {
  const input = await readCurrentCapitalInputs(repositoryRoot, {
    readCurrentFanInBoundaryImpl: readCurrentCapitalLiveChainFanInBoundary,
  });
  const canonicalPack = await projectCandidateFixtureForAccessibilityAuthority({
    buildSpec: input.candidateBuildSpec, sourceFixture: input.canonicalPack, repositoryRoot,
  });
  const refreshed = { ...input, canonicalPack };
  await Promise.all([
    writeFile(
      path.join(repositoryRoot, "tools/datapack/release/current-capital-accessibility-full/station-line-input.json"),
      canonicalCurrentCapitalStationLineInputJson(buildCurrentCapitalStationLineInput(refreshed)),
    ),
    writeFile(
      path.join(repositoryRoot, "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json"),
      canonicalCurrentCapitalRouteEdgeInputJson(buildCurrentCapitalRouteEdgeInput(refreshed)),
    ),
  ]);
}

export async function writeFreshCurrentAccessibilityOutputs(repositoryRoot) {
  await writeCurrentFanIn(repositoryRoot);
  await writeFreshAccessibilityOutputs(repositoryRoot);
}

export async function prepareCurrentStaticCandidateFixture(
  sourceRoot,
  repositoryRoot,
  { now, activateStaticNetwork = false } = {},
) {
  const previousStationLineInputBytes = await readFile(path.join(
    sourceRoot,
    "tools/datapack/release/current-station-line-accessibility/station-line-input.json",
  ));
  if (activateStaticNetwork) {
    await copySyntheticCurrentPublicRouteMapRepository(sourceRoot, repositoryRoot, {
      now,
      activatePublicRouteMap: false,
    });
    await bindActivatedOutputsToCandidate(repositoryRoot);
    const staticNetwork = await activateSyntheticCurrentStaticNetworkSuccessors(repositoryRoot, { now });
    const capturedAt = await nextSyntheticCurrentStaticNetworkNow(repositoryRoot);
    return { capturedAt, previousStationLineInputBytes, staticNetwork };
  }
  await copySyntheticCurrentPublicRouteMapRepository(sourceRoot, repositoryRoot, {
    now,
    activatePublicRouteMap: true,
  });
  const candidate = await json(repositoryRoot, "tools/datapack/release/candidate-build-spec.json");
  return {
    capturedAt: new Date(candidate.publishedAt),
    previousStationLineInputBytes,
    staticNetwork: null,
  };
}

export async function advanceCurrentFacilityFixture(repositoryRoot, capturedAt) {
  await currentizeFreshFacilitySource(repositoryRoot, capturedAt);
  const candidate = await json(repositoryRoot, "tools/datapack/release/candidate-build-spec.json");
  return {
    candidateId: candidate.candidateId,
    sourceSnapshotSetHash: candidate.sourceSnapshotSetHash,
  };
}

export async function completeCurrentAccessibilityFixture(
  repositoryRoot,
  { capturedAt, previousStationLineInputBytes, syncRouteEdgePolicy = false },
) {
  await writeFreshExitAdmissionChain(repositoryRoot, capturedAt);
  await rebindFreshExitAdmissionForCurrentTransition(repositoryRoot, previousStationLineInputBytes);
  await writeFreshCurrentAccessibilityOutputs(repositoryRoot);
  if (syncRouteEdgePolicy) {
    await syncCurrentRouteEdgePolicyFile({
      repositoryRoot,
      inputPath: path.join(repositoryRoot, "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json"),
      policyPath: path.join(repositoryRoot, "release/product-gates/route-edge-evaluation-policy.json"),
    });
  }
}

export async function prepareCurrentStaticNetworkProductionRepository(
  sourceRoot,
  repositoryRoot,
  { now },
) {
  const stage = await prepareCurrentStaticCandidateFixture(sourceRoot, repositoryRoot, {
    now,
    activateStaticNetwork: true,
  });
  await advanceCurrentFacilityFixture(repositoryRoot, stage.capturedAt);
  await completeCurrentAccessibilityFixture(repositoryRoot, {
    capturedAt: stage.capturedAt,
    previousStationLineInputBytes: stage.previousStationLineInputBytes,
    syncRouteEdgePolicy: true,
  });
  return stage.staticNetwork;
}

// Rebuilds the FACILITY producer chain from the current candidate rather than
// mutating fixture freshness or candidate identities.
export async function currentizeFreshFacilitySource(repositoryRoot, capturedAt) {
  await registerFreshFacilitySnapshot(repositoryRoot, capturedAt);
  await assertSelectedPublicLayoutBinding(repositoryRoot, "FACILITY registration");
  await rebindCurrentCandidateSourceSnapshots({ repositoryRoot, now: capturedAt });
  await assertSelectedPublicLayoutBinding(repositoryRoot, "candidate rebind");
  await rebindCurrentActivePublicRouteMapMaterialization({ repositoryRoot });
  await writeFreshFacilityAdmission(repositoryRoot, capturedAt);
}

// Materializes consumer inputs from the already current fan-in.  The normal
// PRE_APPROVAL wrapper intentionally validates a historical transition instead.
export async function materializeCurrentFanInCandidateArtifact({
  repositoryRoot, stationLineOutput, routeEdgeOutput, fixtureOutput, authorityOutput,
}) {
  const buildSpecPath = "tools/datapack/release/candidate-build-spec.json";
  const [buildSpecBytes, sourceFixtureBytes, stationLineInputBytes, routeBytes, transferMetricsBytes] = await Promise.all([
    readFile(path.join(repositoryRoot, buildSpecPath)),
    readFile(path.join(repositoryRoot, "tools/datapack/release/capital-production-canonical-pack.json")),
    readFile(path.join(repositoryRoot, "tools/datapack/release/current-capital-accessibility-full/station-line-input.json")),
    readFile(path.join(repositoryRoot, "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json")),
    readFile(path.join(repositoryRoot, "tools/datapack/release/current-transfer-topology-metrics.json")),
  ]);
  const buildSpec = JSON.parse(buildSpecBytes);
  const sourceFixture = JSON.parse(sourceFixtureBytes);
  const projectedFixture = await projectCandidateFixtureForAccessibilityAuthority({ buildSpec, sourceFixture, repositoryRoot });
  const rebuilt = buildCurrentReleaseCandidateAccessibilityAuthority({
    buildSpec, buildSpecBytes, projectedFixture, route: JSON.parse(routeBytes), routeBytes, sourceFixtureBytes,
    stationLineInput: JSON.parse(stationLineInputBytes), stationLineInputBytes,
    transferMetrics: JSON.parse(transferMetricsBytes), transferMetricsBytes,
  });
  await Promise.all([
    writeFile(stationLineOutput, stationLineInputBytes, { flag: "wx", mode: 0o600 }),
    writeFile(routeEdgeOutput, routeBytes, { flag: "wx", mode: 0o600 }),
    writeFile(fixtureOutput, canonicalCurrentReleaseCandidateFixtureJson(rebuilt.candidateFixture), { flag: "wx", mode: 0o600 }),
    writeFile(authorityOutput, canonicalCurrentReleaseCandidateAccessibilityAuthorityJson(rebuilt.authority), { flag: "wx", mode: 0o600 }),
  ]);
  return rebuilt;
}

// Creates a test-only synthetic production-shape current head with production
// pure collector/registrar boundaries, never edited freshness or promoted fixtures.
export async function prepareCurrentFullCapitalProductionRepository(sourceRoot) {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "easysubway-current-production-artifact-source-"));
  try {
    const stage = await prepareCurrentStaticCandidateFixture(sourceRoot, repositoryRoot, {
      now: await nextSyntheticCurrentStaticNetworkNow(sourceRoot),
    });
    await advanceCurrentFacilityFixture(repositoryRoot, stage.capturedAt);
    await completeCurrentAccessibilityFixture(repositoryRoot, {
      capturedAt: stage.capturedAt,
      previousStationLineInputBytes: stage.previousStationLineInputBytes,
    });
    return repositoryRoot;
  } catch (error) {
    await rm(repositoryRoot, { recursive: true, force: true });
    throw error;
  }
}

async function bindPendingStationRoutePrestate(repositoryRoot, baseTransitionBytes, successor) {
  if (successor.supersededTransition?.sha256 !== sha256(baseTransitionBytes)) {
    throw new Error("pending transition base binding mismatch");
  }
  const baseTransition = JSON.parse(baseTransitionBytes);
  const previousFacilityBytes = Buffer.from(successor.previousFacilityAdmissionBase64 ?? "", "base64");
  if (previousFacilityBytes.length === 0
    || previousFacilityBytes.toString("base64") !== successor.previousFacilityAdmissionBase64) {
    throw new Error("pending transition FACILITY prestate mismatch");
  }
  const previousFacility = JSON.parse(previousFacilityBytes);
  const [previousSnapshotBytes, station, route] = await Promise.all([
    readFile(path.join(repositoryRoot, previousFacility.sourceIdentity.snapshotPath)),
    json(repositoryRoot, "tools/datapack/release/current-capital-accessibility-full/station-line-input.json"),
    json(repositoryRoot, "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json"),
  ]);
  const previousCandidate = baseTransition.previousCandidate;
  const outputCandidate = {
    ...station.candidate,
    candidateId: previousCandidate.candidateId,
    sourceSetSha256: previousCandidate.sourceSnapshotSetHash,
  };
  const facilityRows = buildAuthenticatedCurrentCapitalFacilityEvidenceRows({
    facilityAdmission: previousFacility,
    facilitySnapshotBytes: previousSnapshotBytes,
    stationLines: station.stationLines,
    admissionCandidate: baseTransition.nextCandidate,
    outputCandidate,
    candidatePublishedAt: Date.parse(previousCandidate.canonicalCandidate?.publishedAt ?? ""),
  });
  if (facilityRows.length !== station.evidenceRows.filter(({ domain }) => domain === "FACILITY").length) {
    throw new Error("pending transition FACILITY row set mismatch");
  }
  station.candidate = outputCandidate;
  let facilityIndex = 0;
  station.evidenceRows = station.evidenceRows.map((row) => row.domain === "FACILITY"
    ? facilityRows[facilityIndex++]
    : {
        ...row,
        candidateId: previousCandidate.candidateId,
        sourceSetSha256: previousCandidate.sourceSnapshotSetHash,
      });
  route.candidate = {
    ...route.candidate,
    candidateId: previousCandidate.candidateId,
    sourceSetSha256: previousCandidate.sourceSnapshotSetHash,
  };
  await Promise.all([
    writeFile(
      path.join(repositoryRoot, "tools/datapack/release/current-capital-accessibility-full/station-line-input.json"),
      canonicalCurrentCapitalStationLineInputJson(station),
    ),
    writeFile(
      path.join(repositoryRoot, "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json"),
      canonicalCurrentCapitalRouteEdgeInputJson(route),
    ),
  ]);
}

export async function preparePendingCurrentAccessibilityTransitionRepository(sourceRoot) {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "easysubway-pending-accessibility-transition-"));
  try {
    const stage = await prepareCurrentStaticCandidateFixture(sourceRoot, repositoryRoot, {
      now: await nextSyntheticCurrentStaticNetworkNow(sourceRoot),
    });
    await advanceCurrentFacilityFixture(repositoryRoot, stage.capturedAt);
    const [baseCandidateBytes, baseFacilityBytes, baseLedgerBytes, baseInventoryBytes] = await Promise.all([
      readFile(path.join(repositoryRoot, "tools/datapack/release/candidate-build-spec.json")),
      readFile(path.join(repositoryRoot, "tools/datapack/release/current-capital-facility-source-admission.json")),
      readFile(path.join(repositoryRoot, "tools/datapack/release/source-snapshots.json")),
      readFile(path.join(repositoryRoot, "tools/datapack/source-inventory.json")),
    ]);
    const baseTransition = buildCurrentCapitalAccessibilityTransition({
      candidate: JSON.parse(baseCandidateBytes),
      candidateBytes: baseCandidateBytes,
      previous: JSON.parse(stage.previousStationLineInputBytes),
      previousBytes: stage.previousStationLineInputBytes,
      facilityAdmission: JSON.parse(baseFacilityBytes),
      facilityBytes: baseFacilityBytes,
      ledger: JSON.parse(baseLedgerBytes),
      ledgerBytes: baseLedgerBytes,
      inventory: JSON.parse(baseInventoryBytes),
      inventoryBytes: baseInventoryBytes,
    });
    const baseTransitionBytes = Buffer.from(canonicalCurrentCapitalAccessibilityTransitionJson(baseTransition));
    await writeFile(
      path.join(repositoryRoot, "tools/datapack/release/current-capital-accessibility-transition.json"),
      baseTransitionBytes,
    );

    const successorCapturedAt = new Date(stage.capturedAt.getTime() + 2_000);
    await advanceCurrentFacilityFixture(repositoryRoot, successorCapturedAt);
    const [candidateBytes, facilityBytes, ledgerBytes, inventoryBytes] = await Promise.all([
      readFile(path.join(repositoryRoot, "tools/datapack/release/candidate-build-spec.json")),
      readFile(path.join(repositoryRoot, "tools/datapack/release/current-capital-facility-source-admission.json")),
      readFile(path.join(repositoryRoot, "tools/datapack/release/source-snapshots.json")),
      readFile(path.join(repositoryRoot, "tools/datapack/source-inventory.json")),
    ]);
    const currentTransition = buildCurrentCapitalAccessibilityTransition({
      candidate: JSON.parse(candidateBytes),
      candidateBytes,
      previous: JSON.parse(stage.previousStationLineInputBytes),
      previousBytes: stage.previousStationLineInputBytes,
      facilityAdmission: JSON.parse(facilityBytes),
      facilityBytes,
      ledger: JSON.parse(ledgerBytes),
      ledgerBytes,
      inventory: JSON.parse(inventoryBytes),
      inventoryBytes,
    });
    const successor = buildCurrentCapitalAccessibilityTransitionSuccessor({
      baseTransitionBytes,
      previousFacilityBytes: baseFacilityBytes,
      currentFacilityBytes: facilityBytes,
      currentLedger: JSON.parse(ledgerBytes),
      currentTransition,
    });
    await writeFile(
      path.join(repositoryRoot, "tools/datapack/release/current-capital-accessibility-transition-successor.json"),
      canonicalCurrentCapitalAccessibilityTransitionSuccessorJson(successor),
    );
    await writeFreshExitAdmissionChain(repositoryRoot, successorCapturedAt);
    await rebindFreshExitAdmissionForCurrentTransition(
      repositoryRoot,
      stage.previousStationLineInputBytes,
    );
    await bindPendingStationRoutePrestate(repositoryRoot, baseTransitionBytes, successor);
    return repositoryRoot;
  } catch (error) {
    await rm(repositoryRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function withCurrentFullCapitalProductionRepository(context, sourceRoot, callback) {
  const repositoryRoot = await prepareCurrentFullCapitalProductionRepository(sourceRoot);
  context.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  return callback(repositoryRoot);
}
