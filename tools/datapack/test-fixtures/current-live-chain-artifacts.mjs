import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildCurrentCapitalLiveChainBundle, CURRENT_CAPITAL_LIVE_CHAIN_OUTPUT_PATHS } from "../build-current-capital-live-chain-bundle.mjs";
import { buildCurrentExitAdmissionOciReceipt, canonicalCurrentExitAdmissionOciReceiptJson } from "../build-current-exit-admission-oci-receipt.mjs";
import { CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS, canonicalCurrentCapitalLiveChainFanInBoundaryJson } from "../build-current-capital-live-chain-boundary.mjs";
import { buildCurrentKricExitCollectionPlan } from "../build-current-kric-exit-collection-plan.mjs";
import { buildCurrentKricExitCollectionBundle, buildCurrentKricExitCollectionReceipt, canonicalCurrentKricExitCollectionReceiptJson } from "../build-current-kric-exit-collection-receipt.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => JSON.stringify(sort(value));
function sort(value) { if (Array.isArray(value)) return value.map(sort); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.keys(value).sort((left, right) => left.localeCompare(right, "en")).map((key) => [key, sort(value[key])])); }

export async function buildCanonicalCurrentKricExitCollectionBundle({ repositorySha = "a".repeat(40), operationId = "current-capital-560", capturedAt = "2026-08-14T16:00:00.000Z" } = {}) {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const paths = { canonicalPackBytes: "release/capital-production-canonical-pack.json", coverageTargetsBytes: "nationwide-coverage-targets.json", providerCodeCatalogBytes: "sources/kric-provider-code-catalog-20260228.json", routeRostersBytes: "sources/kric-nationwide-route-rosters-20260730T203926676Z.json", sourceInventoryBytes: "source-inventory.json", incheonTopologyBytes: "sources/incheon-transit-station-info-20260814.json" };
  const input = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, file]) => [key, await readFile(path.join(root, file))])));
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
  const outputPaths = CURRENT_CAPITAL_LIVE_CHAIN_OUTPUT_PATHS;
  const provider = JSON.parse(providerCollectionBundleBytes.toString("utf8"));
  const snapshot = JSON.parse(provider.providerSnapshotJson);
  const providerCapturedAt = snapshot.capturedAt;
  const providerSha = sha256(providerCollectionBundleBytes);
  const providerObjectUri = `oci://axvym6vk8g7i/easysubway-datapacks/operations/current-capital-live-chain/v1/heads/${repositorySha}/operations/${operationId}/provider-collections/${providerCapturedAt.slice(0, 10).replaceAll("-", "")}-${providerSha}.json`;
  const normalizedPath = "tools/datapack/release/current-exit-admission-v2/exit-path-normalized-source-snapshot.json";
  const admissionPath = "tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json";
  const exitReceiptPath = "tools/datapack/release/current-exit-admission-v2/exit-path-admission-oci-receipt.json";
  const normalizedBytes = Buffer.from("{\"normalized\":true}\n");
  const admissionBytes = Buffer.from(`{\"admissionDigest\":\"${"a".repeat(64)}\",\"decision\":\"GO\"}\n`);
  const entryBytes = new Map();
  for (const [index, relative] of outputPaths.entries()) {
    const bytes = relative === normalizedPath ? normalizedBytes : relative === admissionPath ? admissionBytes : Buffer.from(`{\"component\":${index}}`);
    entryBytes.set(relative, bytes);
    await mkdir(path.join(root, "out", path.dirname(relative)), { recursive: true });
    await writeFile(path.join(root, "out", relative), bytes);
  }
  const exitReceipt = buildCurrentExitAdmissionOciReceipt({ repository: "AquilaXk/easysubway-data", mainSha: repositorySha, operationId, providerCapturedAt, providerCollectionBundleBytes, providerObjectUri, providerObjectSha256: providerSha, providerObjectByteSize: providerCollectionBundleBytes.length, normalizedBytes, admissionBytes });
  entryBytes.set(exitReceiptPath, Buffer.from(`${canonicalCurrentExitAdmissionOciReceiptJson(exitReceipt)}\n`));
  await writeFile(path.join(root, "out", exitReceiptPath), entryBytes.get(exitReceiptPath));
  const components = Object.fromEntries(Object.entries(CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS).map(([name, relative]) => [name, { path: relative, sha256: sha256(entryBytes.get(relative)) }]));
  const boundaryBytes = Buffer.from(canonicalCurrentCapitalLiveChainFanInBoundaryJson({ artifactKind: "current-capital-live-chain-fan-in", components, currentCandidateSourceSetSha256: "a".repeat(64), evidenceSourceSetSha256: "a".repeat(64), kind: "CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN", schemaVersion: 1 }));
  const bytes = await buildCurrentCapitalLiveChainBundle({ root, outputDirectory: path.join(root, "out"), repository: "AquilaXk/easysubway-data", repositorySha, operationId, boundaryBytes });
  return { bytes, outputPaths };
}

export { canonicalCurrentKricExitCollectionReceiptJson };
