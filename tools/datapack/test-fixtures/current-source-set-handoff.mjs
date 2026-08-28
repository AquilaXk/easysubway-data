import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildCurrentCapitalLiveChainBundle, currentCapitalLiveChainOutputPaths } from "../build-current-capital-live-chain-bundle.mjs";
import { CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS, buildCurrentCapitalLiveChainFanInBoundary, canonicalCurrentCapitalLiveChainFanInBoundaryJson } from "../build-current-capital-live-chain-boundary.mjs";
import { buildCurrentCapitalLiveChainOciPlan, canonicalCurrentCapitalLiveChainOciPlanJson } from "../build-current-capital-live-chain-oci-plan.mjs";
import { buildCurrentCapitalLiveChainOciReceipt, canonicalCurrentCapitalLiveChainOciReceiptJson } from "../build-current-capital-live-chain-oci-receipt.mjs";
import { buildCanonicalCurrentKricExitCollectionBundle, buildCanonicalCurrentLiveChainArtifacts } from "./current-live-chain-artifacts.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const REPOSITORY = "AquilaXk/easysubway-data";

export async function canonicalCurrentSourceSetHandoffInput(root) {
  const repositorySha = "befa78d0bd1dec8ce609bd1800b099d569e96734";
  const producerSha = "e".repeat(40);
  const operationId = "current-source-set-28";
  const provider = await buildCanonicalCurrentKricExitCollectionBundle({ repositorySha, operationId });
  const candidatePath = CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS.candidateBuildSpec;
  const artifacts = await buildCanonicalCurrentLiveChainArtifacts({
    authorityBytes: new Map(await Promise.all([
      candidatePath,
      "tools/datapack/source-inventory.json",
      "tools/datapack/release/source-snapshots.json",
    ].map(async (relative) => [relative, await readFile(path.join(ROOT, relative))]))),
    providerCollectionBundleBytes: provider.bytes,
    repositorySha,
    operationId,
  });
  const candidateBytes = await readFile(path.join(ROOT, candidatePath));
  const candidateValue = JSON.parse(candidateBytes);
  const overrides = artifacts;
  const componentBytes = {};
  for (const [name, relative] of Object.entries(CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS)) {
    componentBytes[name] = overrides.get(relative) ?? await readFile(path.join(ROOT, relative));
  }
  const components = Object.fromEntries(Object.entries(componentBytes).map(([name, bytes]) => [name, { bytes, value: JSON.parse(bytes.toString("utf8")) }]));
  const boundary = buildCurrentCapitalLiveChainFanInBoundary(components);
  const boundaryBytes = Buffer.from(canonicalCurrentCapitalLiveChainFanInBoundaryJson(boundary));
  const candidate = components.candidateBuildSpec.value;
  const outputDirectory = path.join(root, "out");
  for (const relative of currentCapitalLiveChainOutputPaths({ candidate, sourceInventory: components.sourceInventory.value, sourceSnapshotLedger: components.sourceSnapshotLedger.value })) {
    const target = path.join(outputDirectory, relative);
    await mkdir(path.dirname(target), { recursive: true });
    if (overrides.has(relative)) await writeFile(target, overrides.get(relative));
    else await cp(path.join(ROOT, relative), target);
  }
  const compositeBytes = await buildCurrentCapitalLiveChainBundle({ root, outputDirectory, repository: REPOSITORY, repositorySha, operationId, boundaryBytes });
  const plan = buildCurrentCapitalLiveChainOciPlan({ mainSha: repositorySha, operationId, providerCollectionBundleBytes: provider.bytes, providerCapturedAt: provider.snapshot.capturedAt, compositeBundleBytes: compositeBytes });
  const planBytes = Buffer.from(`${canonicalCurrentCapitalLiveChainOciPlanJson(plan)}\n`);
  const receipt = buildCurrentCapitalLiveChainOciReceipt({ planBytes });
  const compositeReceiptBytes = Buffer.from(`${canonicalCurrentCapitalLiveChainOciReceiptJson(receipt, { planBytes })}\n`);
  const releaseRequestPath = path.join(ROOT, "tools/datapack/release/release-request.json");
  const productionInputPath = path.join(ROOT, "tools/datapack/inputs/capital-pilot-production-source-input.json");
  const reviewedPackPath = path.join(ROOT, "tools/datapack/release/capital-production-reviewed-pack.json");
  const itxTopologyEvidencePath = path.join(ROOT, candidate.itxTopologyEvidencePath);
  const coverageContractPath = path.join(ROOT, candidate.networkEdgeEvidence.itxCoverageContract.path);
  const ownershipPath = path.join(ROOT, "tools/datapack/test-fixtures/current-source-set-handoff-ownership.json");
  const mobileFixtureRoot = process.env.EASYSUBWAY_MOBILE_FIXTURE_ROOT ?? path.join(ROOT, ".external/mobile");
  const mobilePackPath = path.join(mobileFixtureRoot, "apps/mobile/assets/datapacks/capital.sqlite.gz");
  const [releaseRequestBytes, productionInputBytes, reviewedPackBytes, itxTopologyEvidenceBytes, coverageContractBytes, ownershipBytes, mobilePackBytes] = await Promise.all([
    readFile(releaseRequestPath), readFile(productionInputPath), readFile(reviewedPackPath), readFile(itxTopologyEvidencePath), readFile(coverageContractPath), readFile(ownershipPath), readFile(mobilePackPath),
  ]);
  return { boundary, candidate, compositeBytes, compositeReceiptBytes, coverageContractBytes, coverageContractPath, expectedApprovalId: JSON.parse(releaseRequestBytes).approvalId, itxTopologyEvidenceBytes, itxTopologyEvidencePath, mobilePackBytes, mobilePackPath, mobileProfile: "mobile-v19", operationId, ownershipBytes, ownershipPath, producerSha, productionInputBytes, productionInputPath, releaseRequestBytes, releaseRequestPath, reviewedPackBytes, reviewedPackPath, sourceRepositorySha: repositorySha };
}
