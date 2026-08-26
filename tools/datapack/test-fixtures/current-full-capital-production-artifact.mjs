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
import { buildCurrentCapitalLiveChainFanInBoundary, canonicalCurrentCapitalLiveChainFanInBoundaryJson, CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS } from "../build-current-capital-live-chain-boundary.mjs";
import { deriveRawRetentionExpiresAt } from "../source-governance-policy.mjs";
import { registerKricStandardAccessibilitySnapshot } from "../register-kric-standard-accessibility-snapshot.mjs";
import { rebindCurrentCandidateSourceSnapshots } from "../rebind-current-candidate-source-snapshots.mjs";
import { rebindCurrentActivePublicRouteMapMaterialization } from "../rebind-current-active-public-route-map-materialization.mjs";
import { materializeAccessibilitySourceInput } from "../materialize-accessibility-source-input.mjs";
import { buildFixture as buildOfficialSourceFixture } from "../import-official-sources.mjs";
import { syncCanonicalAccessibilityEvidence } from "../apply-accessibility-evidence-to-bundled-pack.mjs";
import { retainPreAuthorityRideEdges } from "../activate-current-source-set.mjs";
import { buildCurrentCapitalStationLineInput, canonicalCurrentCapitalStationLineInputJson, readCurrentCapitalInputs } from "../build-current-capital-station-line-input.mjs";
import { buildCurrentCapitalRouteEdgeInput, canonicalCurrentCapitalRouteEdgeInputJson } from "../build-current-capital-route-edge-input.mjs";
import { projectCandidateFixtureForAccessibilityAuthority } from "../build-datapack.mjs";
import { readCurrentCapitalLiveChainFanInBoundary } from "../build-current-capital-live-chain-boundary.mjs";
import {
  buildCurrentReleaseCandidateAccessibilityAuthority,
  canonicalCurrentReleaseCandidateAccessibilityAuthorityJson,
  canonicalCurrentReleaseCandidateFixtureJson,
} from "../build-current-release-candidate-accessibility-input.mjs";
import { copySyntheticCurrentPublicRouteMapRepository, nextSyntheticCurrentStaticNetworkNow } from "./current-public-route-map-successor.mjs";

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
  const stagingPath = path.join(repositoryRoot, "fresh-facility-snapshot.json");
  const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
  await writeFile(stagingPath, snapshotBytes, { flag: "wx", mode: 0o600 });
  const retainedRawBytes = Buffer.from(JSON.stringify({
    artifactKind: "test-only-kric-facility-retained-raw", sourceId: snapshot.sourceId,
    snapshotId: snapshot.snapshotId, snapshotRawSha256: snapshot.rawSha256,
  }));
  const retainedRawSha256 = sha256(retainedRawBytes);
  await writeFile(path.join(repositoryRoot, "fresh-facility-retained-raw.json"), retainedRawBytes, { flag: "wx", mode: 0o600 });
  const planPath = path.join(repositoryRoot, "fresh-facility-plan.json");
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

async function syncFreshAccessibilityEvidence(repositoryRoot) {
  const [input, inventory, canonical] = await Promise.all([
    json(repositoryRoot, "tools/datapack/inputs/capital-pilot-production-source-input.json"),
    json(repositoryRoot, "tools/datapack/source-inventory.json"),
    json(repositoryRoot, "tools/datapack/release/capital-production-canonical-pack.json"),
  ]);
  const snapshotsBySourceId = new Map(await Promise.all([
    "kric-station-convenience-standard",
    "seoul-metro-accessibility",
  ].map(async (sourceId) => {
    const source = inventory.sources.find(({ id }) => id === sourceId);
    const snapshotPath = source?.accessibilityAdmissionEvidence?.snapshotPath;
    if (typeof snapshotPath !== "string") {
      throw new Error(`synthetic ${sourceId} accessibility snapshot missing`);
    }
    return [sourceId, await json(repositoryRoot, snapshotPath)];
  })));
  const materializedInput = materializeAccessibilitySourceInput({
    input,
    kricSnapshot: snapshotsBySourceId.get("kric-station-convenience-standard"),
    seoulSnapshot: snapshotsBySourceId.get("seoul-metro-accessibility"),
  });
  const reviewedFixture = buildOfficialSourceFixture(inventory, materializedInput);
  const reviewedPack = reviewedFixture.packs?.find(({ id }) => id === "capital");
  if (!reviewedPack) throw new Error("synthetic reviewed accessibility capital pack missing");
  syncCanonicalAccessibilityEvidence(canonical, reviewedPack);
  retainPreAuthorityRideEdges(reviewedFixture, "synthetic reviewed pack");
  retainPreAuthorityRideEdges(canonical, "synthetic canonical pack");
  await writeFile(
    path.join(repositoryRoot, "tools/datapack/release/capital-production-canonical-pack.json"),
    `${JSON.stringify(canonical, null, 2)}\n`,
  );
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
  const admission = buildCurrentCapitalFacilitySourceAdmission({
    observedAt: observedAt.toISOString(), planBytes: Buffer.from(canonicalCurrentCapitalFacilityCollectionPlanJson(plan)),
    canonicalPackBytes: values[paths[0]], snapshotBytes, candidateBuildSpec: JSON.parse(values[paths[5]]),
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
  if (plan.queryPlan.length !== 420) throw new Error("synthetic EXIT query denominator mismatch");
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
    writeFile(path.join(repositoryRoot, output, "exit-path-admission-oci-receipt.json"), canonicalCurrentExitAdmissionOciReceiptJson(ociReceipt)),
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

// Rebuilds the FACILITY producer chain from the current candidate rather than
// mutating fixture freshness or candidate identities.
export async function currentizeFreshFacilitySource(repositoryRoot, capturedAt) {
  await registerFreshFacilitySnapshot(repositoryRoot, capturedAt);
  await assertSelectedPublicLayoutBinding(repositoryRoot, "FACILITY registration");
  await rebindCurrentCandidateSourceSnapshots({ repositoryRoot, now: capturedAt });
  await assertSelectedPublicLayoutBinding(repositoryRoot, "candidate rebind");
  await syncFreshAccessibilityEvidence(repositoryRoot);
  await rebindCurrentActivePublicRouteMapMaterialization({ repositoryRoot });
  await writeFreshFacilityAdmission(repositoryRoot, capturedAt);
}

// Materializes consumer inputs from the already current fan-in.  The normal
// PRE_APPROVAL wrapper intentionally validates a historical transition instead.
export async function materializeCurrentFanInCandidateArtifact({
  repositoryRoot, stationLineOutput, routeEdgeOutput, fixtureOutput, authorityOutput,
}) {
  const buildSpecPath = "tools/datapack/release/candidate-build-spec.json";
  const [buildSpecBytes, sourceFixtureBytes, stationLineInputBytes, routeBytes] = await Promise.all([
    readFile(path.join(repositoryRoot, buildSpecPath)),
    readFile(path.join(repositoryRoot, "tools/datapack/release/capital-production-canonical-pack.json")),
    readFile(path.join(repositoryRoot, "tools/datapack/release/current-capital-accessibility-full/station-line-input.json")),
    readFile(path.join(repositoryRoot, "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json")),
  ]);
  const buildSpec = JSON.parse(buildSpecBytes);
  const sourceFixture = JSON.parse(sourceFixtureBytes);
  const projectedFixture = await projectCandidateFixtureForAccessibilityAuthority({ buildSpec, sourceFixture, repositoryRoot });
  const rebuilt = buildCurrentReleaseCandidateAccessibilityAuthority({
    buildSpec, buildSpecBytes, projectedFixture, route: JSON.parse(routeBytes), routeBytes, sourceFixtureBytes,
    stationLineInput: JSON.parse(stationLineInputBytes), stationLineInputBytes,
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
    const staticNow = await nextSyntheticCurrentStaticNetworkNow(sourceRoot);
    await copySyntheticCurrentPublicRouteMapRepository(sourceRoot, repositoryRoot, {
      now: staticNow, activatePublicRouteMap: true,
    });
    const candidate = await json(repositoryRoot, "tools/datapack/release/candidate-build-spec.json");
    const capturedAt = new Date(candidate.publishedAt);
    await currentizeFreshFacilitySource(repositoryRoot, capturedAt);
    await writeFreshExitAdmissionChain(repositoryRoot, capturedAt);
    await writeFreshCurrentAccessibilityOutputs(repositoryRoot);
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
