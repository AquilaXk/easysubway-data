import { createHash } from "node:crypto";
import { canonicalJson } from "./lib/manifest-validation.mjs";

const SOURCE_ID = "seoul-metro-transfer-distance-duration";
const METRICS_PATH = "tools/datapack/release/current-transfer-topology-metrics.json";
const APPLICABILITY_PATH = "tools/datapack/release/current-capital-transfer-topology-applicability.json";
const SHA256 = /^[0-9a-f]{64}$/u;
const canonical = (value) => Buffer.from(`${canonicalJson(value)}\n`);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const without = (value, key) => { const copy = { ...value }; delete copy[key]; return copy; };

export function registerSeoulTransferSourceSnapshot({ observation, receipt, metrics, metricsBytes, applicability, applicabilityBytes, now }) {
  const manifest = observation?.manifest;
  if (!manifest || manifest.sourceId !== SOURCE_ID || manifest.rowCount !== 145 || manifest.freshnessDate !== "2025-12-31"
    || manifest.credentialRedacted !== true || !Buffer.isBuffer(observation.manifestBytes) || !Buffer.isBuffer(observation.observationBytes)
    || !Buffer.isBuffer(observation.rawBytes) || manifest.rawSha256 !== sha(observation.rawBytes)
    || !SHA256.test(manifest.contentSha256 ?? "") || !SHA256.test(manifest.schemaSha256 ?? "") || !SHA256.test(manifest.endpointSha256 ?? "")) throw new Error("transfer observation identity mismatch");
  if (receipt?.sourceId !== SOURCE_ID || receipt.capturedAt !== manifest.capturedAt || receipt.snapshotRawSha256 !== manifest.rawSha256
    || receipt.rawObjectSha256 !== sha(observation.rawBytes) || !receipt.rawObjectUri?.startsWith("oci://")
    || !Number.isSafeInteger(receipt.byteSize) || receipt.byteSize !== observation.rawBytes.length || Date.parse(receipt.storedAt) < Date.parse(manifest.capturedAt)) throw new Error("transfer OCI receipt mismatch");
  if (!(now instanceof Date) || Number.isNaN(now.valueOf()) || now < new Date(manifest.capturedAt)) throw new Error("registration time mismatch");
  if (!Buffer.isBuffer(metricsBytes) || metrics?.artifactKind !== "current-transfer-topology-metrics"
    || metrics.artifactSha256 !== sha(canonicalJson(without(metrics, "artifactSha256"))) || metrics.sourceIdentity?.sourceId !== SOURCE_ID
    || metrics.sourceIdentity.endpointSha256 !== manifest.endpointSha256 || metrics.sourceIdentity.manifestSha256 !== sha(observation.manifestBytes)
    || metrics.sourceIdentity.observationSha256 !== sha(observation.observationBytes) || metrics.sourceIdentity.rawSnapshotSha256 !== sha(observation.rawBytes)
    || metrics.sourceIdentity.rawSha256 !== manifest.rawSha256 || metrics.sourceIdentity.contentSha256 !== manifest.contentSha256
    || metrics.sourceIdentity.schemaSha256 !== manifest.schemaSha256 || metrics.sourceIdentity.rowCount !== 145
    || metrics.canonicalIdentity?.stationLineCount !== 213 || metrics.canonicalIdentity?.stationCount !== 199 || metrics.canonicalIdentity?.physicalPairCount !== 15
    || metrics.physicalPairs?.length !== 15 || metrics.metrics?.length !== 30
    || metrics.metrics.filter(({ metricProvenance }) => metricProvenance === "OFFICIAL_SOURCE").length !== 28
    || metrics.metrics.filter(({ metricProvenance }) => metricProvenance === "DERIVED_RECIPROCAL").length !== 2) throw new Error("transfer metrics identity mismatch");
  if (!Buffer.isBuffer(applicabilityBytes)
    || applicability?.artifactKind !== "current-capital-transfer-topology-applicability-pre-candidate" || applicability.productionUseAllowed !== false || applicability.candidateBinding !== null
    || !SHA256.test(applicability.artifactSha256 ?? "") || applicability.artifactSha256 !== sha(canonical(without(applicability, "artifactSha256")))
    || applicability.transferTopologyMetricsIdentity?.artifactSha256 !== metrics.artifactSha256
    || applicability.canonicalIdentity?.canonicalPackSha256 !== metrics.canonicalIdentity.canonicalPackSha256
    || JSON.stringify(applicability.sourceIdentity) !== JSON.stringify(metrics.sourceIdentity)
    || applicability.canonicalIdentity?.stationLineCount !== 213 || applicability.canonicalIdentity?.stationCount !== 199
    || applicability.stateSummary?.APPLICABLE_TRANSFER_ENDPOINT !== 27 || applicability.stateSummary?.NOT_APPLICABLE_IN_CANONICAL_PAIR_SET !== 186) throw new Error("transfer applicability identity mismatch");
  const capturedAt = manifest.capturedAt;
  const payload = {
    schemaVersion: 1, artifactKind: "seoul-transfer-distance-duration-source-snapshot", sourceId: SOURCE_ID,
    snapshotId: `${SOURCE_ID}-${capturedAt.replaceAll(/[-:.]/gu, "")}`,
    sourceEffectiveDate: "2025-12-31", sourceUpdatedAt: null, capturedAt, observedAt: capturedAt,
    freshUntil: new Date(Date.parse(capturedAt) + 365 * 24 * 60 * 60 * 1_000).toISOString(), credentialRedacted: true,
    absenceEvidenceMode: "EXHAUSTIVE_LIST", rowCount: 145, rawSha256: manifest.rawSha256, contentSha256: manifest.contentSha256,
    schemaFingerprint: manifest.schemaSha256,
    observationIdentity: { endpointSha256: manifest.endpointSha256, manifestSha256: sha(observation.manifestBytes), observationSha256: sha(observation.observationBytes), rawSnapshotSha256: sha(observation.rawBytes), sourceCandidateSha256: metrics.sourceIdentity.sourceCandidateSha256, kricProviderCatalogSha256: metrics.sourceIdentity.kricProviderCatalogSha256 },
    transferTopology: { canonicalPackSha256: metrics.canonicalIdentity.canonicalPackSha256, metricsArtifactSha256: metrics.artifactSha256, applicabilityArtifactSha256: applicability.artifactSha256, stationLineCount: 213, stationCount: 199, physicalPairCount: 15, directedMetricCount: 30, officialMetricCount: 28, derivedReciprocalMetricCount: 2, applicableStationLineCount: 27, notApplicableStationLineCount: 186, durationRole: "REFERENCE_ONLY" },
  };
  return { ...payload, snapshotSha256: sha(canonical(payload)) };
}
export const TRANSFER_REGISTRATION_PATHS = Object.freeze({ metrics: METRICS_PATH, applicability: APPLICABILITY_PATH });
