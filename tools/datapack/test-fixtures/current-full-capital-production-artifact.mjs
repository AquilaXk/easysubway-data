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
import {
  buildCurrentCapitalAccessibilityTransition,
  buildCurrentCapitalAccessibilityTransitionSuccessor,
  canonicalCurrentCapitalAccessibilityTransitionJson,
  canonicalCurrentCapitalAccessibilityTransitionSuccessorJson,
} from "../current-capital-accessibility-transition.mjs";
import { buildFixtureCurrentExitV2Receipt, canonicalFixtureCurrentExitV2ReceiptJson, rebindFixtureCurrentExitV2Admission } from "./current-exit-v2-receipt.mjs";
import { buildCurrentCapitalLiveChainFanInBoundary, canonicalCurrentCapitalLiveChainFanInBoundaryJson, CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS } from "../build-current-capital-live-chain-boundary.mjs";
import { deriveRawRetentionExpiresAt } from "../source-governance-policy.mjs";
import { registerKricStandardAccessibilitySnapshot } from "../register-kric-standard-accessibility-snapshot.mjs";
import { rebindCurrentCandidateSourceSnapshots } from "../rebind-current-candidate-source-snapshots.mjs";
import { rebindCurrentActivePublicRouteMapMaterialization } from "../rebind-current-active-public-route-map-materialization.mjs";
import { buildCurrentActiveFacilityDerivedIdentityOutput } from "../rebind-current-active-facility-derived-identity.mjs";
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
import { readImmutableItxRideEdgeSetSha256 } from "../apply-itx-topology-to-bundled-pack.mjs";
import { canonicalJson } from "../lib/manifest-validation.mjs";
import {
  activateSyntheticCurrentPublicRouteMapSuccessor,
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

async function registerFreshFacilitySnapshot(repositoryRoot, now, repeatedSnapshot = null) {
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
    fetchImpl: async (url) => {
      const search = new URL(url).searchParams;
      const repeated = repeatedSnapshot?.queries?.find((query) =>
        query.railOprIsttCd === search.get("railOprIsttCd")
        && query.lnCd === search.get("lnCd")
        && query.stinCd === search.get("stinCd"));
      if (repeatedSnapshot != null && repeated == null) {
        throw new Error("synthetic FACILITY replay query is missing");
      }
      const resultCode = repeated?.providerResultCode
        ?? (search.get("stinCd") === "234-4" ? "03" : "00");
      return {
        ok: true,
        status: 200,
        json: async () => resultCode === "03"
          ? { header: { resultCode } }
          : { header: { resultCode }, body: repeated?.rows ?? [
            {
              dtlLoc: "synthetic current A", grndDvCd: "1", gubun: "EV", imgPath: "", mlFmlDvCd: "", stinFlor: 1, trfcWeakDvCd: "01",
            },
            {
              dtlLoc: "synthetic current B", grndDvCd: "1", gubun: "EV", imgPath: "", mlFmlDvCd: "", stinFlor: 2, trfcWeakDvCd: "01",
            },
          ] },
      };
    },
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
    "release/product-gates/production-datapack-scope.json",
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
    productionScopeBytes: values[paths[9]],
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
  const ociReceipt = buildFixtureCurrentExitV2Receipt({
    providerCollectionBundleBytes: bundleBytes, providerCapturedAt: snapshot.capturedAt,
    normalizedBytes, admissionBytes, candidateBytes: Buffer.from(canonicalJson(candidate)),
  });
  const output = "tools/datapack/release/current-exit-admission-v2";
  await Promise.all([
    writeFile(path.join(repositoryRoot, output, "exit-path-normalized-source-snapshot.json"), normalizedBytes),
    writeFile(path.join(repositoryRoot, output, "exit-path-source-admission.json"), admissionBytes),
    writeFile(path.join(repositoryRoot, output, "exit-path-admission-oci-receipt.json"), `${canonicalFixtureCurrentExitV2ReceiptJson(ociReceipt)}\n`),
  ]);
}

export async function rebindFreshExitAdmissionForCurrentTransition(repositoryRoot, previousBytes) {
  const paths = {
    candidate: "tools/datapack/release/candidate-build-spec.json",
    facility: "tools/datapack/release/current-capital-facility-source-admission.json",
    ledger: "tools/datapack/release/source-snapshots.json",
    inventory: "tools/datapack/source-inventory.json",
    productionScope: "release/product-gates/production-datapack-scope.json",
  };
  const bytes = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, relative]) =>
    [key, await readFile(path.join(repositoryRoot, relative))])));
  const transition = buildCurrentCapitalAccessibilityTransition({
    candidate: JSON.parse(bytes.candidate), candidateBytes: bytes.candidate,
    previous: JSON.parse(previousBytes), previousBytes,
    facilityAdmission: JSON.parse(bytes.facility), facilityBytes: bytes.facility,
    ledger: JSON.parse(bytes.ledger), ledgerBytes: bytes.ledger,
    inventory: JSON.parse(bytes.inventory), inventoryBytes: bytes.inventory,
    productionScopeBytes: bytes.productionScope,
  });
  await writeReboundExitAdmissionForTransition(
    repositoryRoot,
    Buffer.from(canonicalCurrentCapitalAccessibilityTransitionJson(transition)),
  );
}

async function writeReboundExitAdmissionForTransition(repositoryRoot, transitionBytes) {
  const paths = {
    normalized: "tools/datapack/release/current-exit-admission-v2/exit-path-normalized-source-snapshot.json",
    admission: "tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json",
    receipt: "tools/datapack/release/current-exit-admission-v2/exit-path-admission-oci-receipt.json",
  };
  const bytes = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, relative]) =>
    [key, await readFile(path.join(repositoryRoot, relative))])));
  const transition = JSON.parse(transitionBytes);
  const rebound = rebindFixtureCurrentExitV2Admission({
    normalizedBytes: bytes.normalized,
    admissionBytes: bytes.admission,
    providerCollectionBundleBytes: Buffer.from(canonicalJson({ transition, receipt: JSON.parse(bytes.receipt) })),
    providerCapturedAt: JSON.parse(bytes.admission).sourceIdentity.capturedAt,
    candidateBytes: transitionBytes,
    candidateId: transition.nextCandidate.candidateId,
    sourceSetSha256: transition.previousCandidate.sourceSnapshotSetHash,
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
      readAdmittedItxRideEdgeSetSha256Impl: readImmutableItxRideEdgeSetSha256,
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
export async function currentizeFreshFacilitySource(repositoryRoot, capturedAt, repeatedSnapshot = null) {
  await registerFreshFacilitySnapshot(repositoryRoot, capturedAt, repeatedSnapshot);
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

async function readCurrentAccessibilityTransitionInputs(repositoryRoot) {
  const [candidateBytes, previousBytes, facilityBytes, ledgerBytes, inventoryBytes, productionScopeBytes] = await Promise.all([
    "tools/datapack/release/candidate-build-spec.json",
    "tools/datapack/release/current-station-line-accessibility/station-line-input.json",
    "tools/datapack/release/current-capital-facility-source-admission.json",
    "tools/datapack/release/source-snapshots.json",
    "tools/datapack/source-inventory.json",
    "release/product-gates/production-datapack-scope.json",
  ].map((relative) => readFile(path.join(repositoryRoot, relative))));
  return {
    candidate: JSON.parse(candidateBytes), candidateBytes,
    previous: JSON.parse(previousBytes), previousBytes,
    facilityAdmission: JSON.parse(facilityBytes), facilityBytes,
    ledger: JSON.parse(ledgerBytes), ledgerBytes,
    inventory: JSON.parse(inventoryBytes), inventoryBytes,
    productionScopeBytes,
  };
}

function transferDerivedBaseTransitionInputs(current) {
  const transferSnapshotId = current.candidate.sourceSnapshotIds.at(-1);
  const transferProjection = current.candidate.sourceSnapshots.at(-1);
  if (typeof transferProjection?.sourceId !== "string" || transferProjection.sourceId === ""
    || typeof transferSnapshotId !== "string" || transferSnapshotId === "") {
    throw new Error("synthetic TRANSFER binding fixture is incomplete");
  }
  const ledger = structuredClone(current.ledger);
  const transfer = ledger.filter(({ snapshotId, sourceId }) =>
    snapshotId === transferSnapshotId && sourceId === transferProjection.sourceId);
  if (transfer.length !== 1 || !transfer[0].transferTopology
    || typeof transfer[0].transferTopology !== "object" || Array.isArray(transfer[0].transferTopology)) {
    throw new Error("synthetic TRANSFER derived binding is missing");
  }
  delete transfer[0].transferTopology;
  const candidate = structuredClone(current.candidate);
  const selected = ledger.filter(({ snapshotId }) => candidate.sourceSnapshotIds.includes(snapshotId));
  if (selected.length !== candidate.sourceSnapshotIds.length) {
    throw new Error("synthetic TRANSFER selected ledger relation is incomplete");
  }
  candidate.sourceSnapshotSetHash = sha256(Buffer.from(JSON.stringify(selected)));
  const candidateBytes = Buffer.from(canonicalJson(candidate));
  const facilityAdmission = structuredClone(current.facilityAdmission);
  facilityAdmission.candidate.sourceSnapshotSetHash = candidate.sourceSnapshotSetHash;
  const { admissionDigest: _admissionDigest, ...facilityPayload } = facilityAdmission;
  facilityAdmission.admissionDigest = sha256(Buffer.from(canonicalJson(facilityPayload)));
  const facilityBytes = Buffer.from(canonicalCurrentCapitalFacilitySourceAdmissionJson(facilityAdmission));
  return {
    ...current,
    candidate,
    candidateBytes,
    facilityAdmission,
    facilityBytes,
    ledger,
    ledgerBytes: Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`),
  };
}

export async function preparePendingCurrentAccessibilityTransitionRepository(sourceRoot, {
  transitionKind = "FACILITY_SOURCE_ADVANCE",
} = {}) {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "easysubway-pending-accessibility-transition-"));
  try {
    await copySyntheticCurrentPublicRouteMapRepository(sourceRoot, repositoryRoot, {
      activatePublicRouteMap: false,
    });
    const fixtureNow = await nextSyntheticCurrentStaticNetworkNow(repositoryRoot);
    await activateSyntheticCurrentPublicRouteMapSuccessor(repositoryRoot, { now: fixtureNow });
    if (transitionKind === "FACILITY_SOURCE_ADVANCE") {
      // 같은 governance 아래의 두 snapshot으로 갱신 관계를 만든다. 과거 hash는 덮어쓰지 않는다.
      const retained = await readCurrentAccessibilityTransitionInputs(repositoryRoot);
      const retainedSnapshot = JSON.parse(await readFile(path.join(
        repositoryRoot, retained.facilityAdmission.sourceIdentity.snapshotPath,
      )));
      await currentizeFreshFacilitySource(
        repositoryRoot,
        await nextSyntheticCurrentStaticNetworkNow(repositoryRoot),
        retainedSnapshot,
      );
    } else if (transitionKind === "TRANSFER_DERIVED_BINDING") {
      const facility = await buildCurrentActiveFacilityDerivedIdentityOutput({ repositoryRoot });
      await writeFile(path.join(repositoryRoot, facility.relative), facility.bytes);
    }
    const markerPaths = [
      "tools/datapack/release/current-capital-accessibility-transition.json",
      "tools/datapack/release/current-capital-accessibility-transition-successor.json",
    ];
    const initialInput = await readCurrentAccessibilityTransitionInputs(repositoryRoot);
    let baseInput = initialInput;
    let currentInput;
    if (transitionKind === "TRANSFER_DERIVED_BINDING") {
      currentInput = initialInput;
      baseInput = transferDerivedBaseTransitionInputs(currentInput);
    } else if (transitionKind === "FACILITY_SOURCE_ADVANCE") {
      const repeatedSnapshot = JSON.parse(await readFile(path.join(
        repositoryRoot,
        baseInput.facilityAdmission.sourceIdentity.snapshotPath,
      )));
      await currentizeFreshFacilitySource(
        repositoryRoot,
        await nextSyntheticCurrentStaticNetworkNow(repositoryRoot),
        repeatedSnapshot,
      );
      currentInput = await readCurrentAccessibilityTransitionInputs(repositoryRoot);
    } else {
      throw new Error("synthetic accessibility transition kind is invalid");
    }
    const baseTransition = buildCurrentCapitalAccessibilityTransition(baseInput);
    const baseTransitionBytes = Buffer.from(canonicalCurrentCapitalAccessibilityTransitionJson(baseTransition));
    const currentTransition = buildCurrentCapitalAccessibilityTransition(currentInput);
    if (transitionKind === "TRANSFER_DERIVED_BINDING"
      && (canonicalJson(baseTransition.previousCandidate.canonicalCandidate)
          !== canonicalJson(currentTransition.previousCandidate.canonicalCandidate)
        || baseTransition.nextCandidate.candidateId !== currentTransition.nextCandidate.candidateId
        || baseTransition.nextCandidate.sourceSnapshotSetHash === currentTransition.nextCandidate.sourceSnapshotSetHash)) {
      throw new Error("synthetic TRANSFER derived transition relation is invalid");
    }
    const successor = buildCurrentCapitalAccessibilityTransitionSuccessor({
      baseTransitionBytes,
      previousFacilityBytes: baseInput.facilityBytes,
      currentFacilityBytes: currentInput.facilityBytes,
      currentLedger: currentInput.ledger,
      currentTransition,
    });
    const successorBytes = Buffer.from(
      canonicalCurrentCapitalAccessibilityTransitionSuccessorJson(successor),
    );
    await Promise.all(markerPaths.map((relative, index) => writeFile(
        path.join(repositoryRoot, relative),
        index === 0 ? baseTransitionBytes : successorBytes,
      )));
    await writeReboundExitAdmissionForTransition(repositoryRoot, successorBytes);
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
